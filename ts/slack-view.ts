// What the Slack list and the Slack thread share: a message's time, the workspace color, the users' icons, and the reactions under a message (S-22, S-25).
// An icon is an https URL on Slack's image hosts; it is fetched by Rust's `fetch_images` (public hosts, no token) as a data: URI, so the CSP stays as it is.
// Until it is here, or when it cannot be fetched, the avatar is the initial on a color taken from the name.
// The image of a custom emoji in a reaction (S-26) is fetched the same way; until it is here, or when it cannot be fetched, the reaction shows `:name:`.
import type { Reaction } from "./bindings/Reaction";
import { tag } from "./dom.js";
import { avatarColor, initials } from "./format.js";
import { SMILE_PLUS_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openEmojiPicker, type PickedEmoji, rememberEmoji } from "./slack-emoji-picker.js";
import { toast } from "./toast.js";

// A Slack timestamp ("1700000000.123456") as epoch milliseconds.
export const slackMs = (ts: string) => Number(ts.split(".")[0]) * 1000;

// The color of a workspace: the dot on a list row and its avatar in the sidebar's tray (an avatar with no icon).
export const workspaceColor = (team: string) => avatarColor(team);

// The icons fetched so far, by URL; the least recently used go when there are more than `ICONS_MAX` (the avatars and the images of the custom emoji, S-26). Memory only.
const icons = new Map<string, string>();
const ICONS_MAX = 500;

// The icon of `url`, marked as used just now.
function iconOf(url: string) {
  const uri = icons.get(url);
  if (uri !== undefined) {
    icons.delete(url);
    icons.set(url, uri);
  }
  return uri;
}

function keepIcon(url: string, uri: string) {
  icons.delete(url);
  icons.set(url, uri);
  for (const old of icons.keys()) {
    if (icons.size <= ICONS_MAX) break;
    icons.delete(old);
  }
}

// `fetch_images` takes at most 50 URLs.
const BATCH = 50;
// The fetches run one after the other, so a URL asked for twice is fetched once.
let chain: Promise<void> = Promise.resolve();

// Puts the fetched icon `uri` on the avatar `node` in place of its initial.
function putIcon(node: HTMLElement, uri: string) {
  const img = tag("img", "av-img");
  img.src = uri;
  img.alt = "";
  node.querySelector(".av-text")?.replaceWith(img);
  delete node.dataset.icon;
}

// Puts the fetched image `uri` of a custom emoji in the reaction emoji `node`, in place of its `:name:`; the name stays as the image's alternative text.
function putEmoji(node: HTMLElement, uri: string) {
  const img = tag("img", "reaction-img");
  img.src = uri;
  img.alt = node.textContent ?? "";
  node.replaceChildren(img);
  delete node.dataset.emojiImage;
}

// The reaction emoji (and picker slots) waiting for the image of a custom emoji (S-26), by its address.
const emojiWaiting = new Map<string, Set<HTMLElement>>();

// Puts the image of the custom emoji `url` in `node` when it is here, and when it comes later (`loadIcons`) otherwise.
export function awaitEmoji(node: HTMLElement, url: string) {
  const uri = iconOf(url);
  if (uri) return putEmoji(node, uri);
  const nodes = emojiWaiting.get(url) ?? new Set<HTMLElement>();
  nodes.add(node);
  emojiWaiting.set(url, nodes);
}

// Paints the nodes waiting for the image of `url`. When it is not here, the ones that left the page are forgotten and the others keep waiting.
function paintEmoji(url: string) {
  const nodes = emojiWaiting.get(url);
  if (!nodes) return;
  const uri = iconOf(url);
  for (const node of nodes) {
    if (uri) putEmoji(node, uri);
    else if (!node.isConnected) nodes.delete(node);
  }
  if (uri || nodes.size === 0) emojiWaiting.delete(url);
}

// Puts the icon on every avatar in the page waiting for it, once it is here.
export function paintIcons() {
  for (const node of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const uri = iconOf(node.dataset.icon!);
    if (uri) putIcon(node, uri);
  }
}

// Fetches the icons and the custom emoji images of `urls` that are not here yet (https only), then paints. A URL that cannot be fetched stays an initial.
export function loadIcons(urls: (string | null)[]) {
  const wanted = [...new Set(urls.filter((u): u is string => !!u && u.startsWith("https://")))];
  chain = chain.then(async () => {
    const missing = wanted.filter((u) => !icons.has(u));
    for (let i = 0; i < missing.length; i += BATCH) {
      try {
        const got = await invoke("fetch_images", { urls: missing.slice(i, i + BATCH) });
        for (const [url, uri] of Object.entries(got)) keepIcon(url, uri);
      } catch {
        // The initial stays.
      }
    }
    paintIcons();
    for (const url of wanted) paintEmoji(url);
  });
  return chain;
}

// Makes `node` (a div or a button) the avatar of `name`: the initial on the name's color, and the icon `iconUrl` when it is here (or when it comes later, by `loadIcons`).
export function decorateAvatar(node: HTMLElement, name: string, iconUrl: string | null) {
  node.style.background = avatarColor(name);
  node.replaceChildren(tag("span", "av-text", initials(name)));
  if (!iconUrl) return node;
  // An icon already fetched goes on the node itself, which may not be in the page yet (`paintIcons` looks only in the page); the others wait for `loadIcons`.
  const uri = iconOf(iconUrl);
  if (uri) putIcon(node, uri);
  else node.dataset.icon = iconUrl;
  return node;
}

// The image addresses of the custom emoji in the reactions of `messages`, for `loadIcons` (S-26).
export const reactionImages = (messages: { reactions: Reaction[] }[]) => messages.flatMap((m) => m.reactions.map((r) => r.image));

// Where a message's reactions are pressed (S-25): its workspace and conversation (a channel, a DM or a group DM).
export type ReactionTarget = { teamId: string; channel: string };

// The reactions whose press is on its way, by workspace, conversation, message and name: a second press waits for the first, even on a node drawn again meanwhile.
const reacting = new Set<string>();

const reactKey = (target: ReactionTarget, ts: string, name: string) => `${target.teamId}/${target.channel}/${ts}/${name}`;

// What a press changed in the reactions of a message, once Slack took it (S-25).
type ReactionChange = { name: string; add: boolean; changed: boolean; picked?: PickedEmoji };

type Reacted = { ts: string; reactions: Reaction[] };

// Puts a change into the reactions of `m`. Rust says whether Slack changed anything (`changed`): `false` is "it was so already", which moves the color and not the count.
// A picked emoji the message does not have yet is put at the end of its reactions.
function applyChange(m: Reacted, c: ReactionChange) {
  const r = m.reactions.find((x) => x.name === c.name);
  if (r) {
    r.mine = c.add;
    if (c.changed) r.count += c.add ? 1 : -1;
    if (r.count <= 0) m.reactions = m.reactions.filter((x) => x !== r);
  } else if (c.picked) m.reactions.push({ emoji: c.picked.emoji, count: 1, name: c.name, image: c.picked.image, mine: true });
}

// The screens that hold their own copy of a message (a thread read again, the history behind a thread) take a change made on another copy (`onReactionChange`).
const changeListeners: ((target: ReactionTarget, ts: string, change: ReactionChange, done: Reacted) => void)[] = [];

export const onReactionChange = (listener: (typeof changeListeners)[number]) => void changeListeners.push(listener);

// For a listener: puts the change into the message of `ts` among `messages`, unless that is the copy the change was made on (`done`).
export function applyReactionChange(messages: Reacted[], ts: string, change: ReactionChange, done: Reacted) {
  const m = messages.find((x) => x.ts === ts);
  if (m && m !== done) applyChange(m, change);
}

// The message each drawn box shows, so that a box drawn again for a message read again (a new object) shows that one.
const boxMessages = new WeakMap<HTMLElement, Reacted>();

// Adds the user's reaction `name` to the message `m`, or takes it off when it is theirs (S-25), then draws the message's reactions again in place of `box`, so that the scroll position stays.
// `picked` is an emoji chosen in the picker: it is always an add.
// Only a success changes the reactions (the other copies of the message too); a failure shows the error and leaves them.
async function pressReaction(m: Reacted, target: ReactionTarget, name: string, box: HTMLElement, picked?: PickedEmoji) {
  const key = reactKey(target, m.ts, name);
  if ((!picked && !m.reactions.some((x) => x.name === name)) || reacting.has(key)) return;
  const add = picked ? true : !m.reactions.find((x) => x.name === name)!.mine;
  // A disabled button gives up the focus, so ask now whether the keyboard is in this box.
  const focused = box.contains(document.activeElement);
  reacting.add(key);
  box.querySelector<HTMLButtonElement>(`[data-name="${CSS.escape(name)}"]`)?.setAttribute("disabled", "");
  try {
    const changed = await invoke("slack_react", { ...target, ts: m.ts, name, add });
    const change = { name, add, changed, picked };
    applyChange(m, change);
    for (const listener of changeListeners) listener(target, m.ts, change, m);
    if (picked) rememberEmoji(target.teamId, picked);
  } catch (e) {
    toast(`リアクションを変えられませんでした: ${e}`);
  } finally {
    reacting.delete(key);
  }
  // The box may have been drawn again while the press was on its way (the thread read again): find it by the message, and draw the message that box shows.
  const live = box.isConnected ? box : document.querySelector<HTMLElement>(`.reactions[data-key="${CSS.escape(reactKey(target, m.ts, ""))}"]`);
  if (!live) return;
  const next = reactionsNode(boxMessages.get(live) ?? m, target);
  live.replaceWith(next);
  // The image of a picked custom emoji is here already when the picker showed it (it fetched the cells in view); this asks for it otherwise.
  if (picked?.image) void loadIcons([picked.image]);
  if (focused) next.querySelector<HTMLElement>(`[data-name="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
}

// The "add a reaction" button, made once: the icon's markup is parsed once, and each box gets a copy.
let addButtonNode: HTMLButtonElement | null = null;
function addButton() {
  if (!addButtonNode) {
    addButtonNode = tag("button", "reaction-add");
    addButtonNode.type = "button";
    addButtonNode.setAttribute("aria-label", "リアクションを追加");
    addButtonNode.setAttribute("aria-haspopup", "dialog");
    addButtonNode.innerHTML = SMILE_PLUS_SVG;
  }
  return addButtonNode;
}

// The reactions under a message (S-22): each one a button with the emoji and how many gave it, in the order Rust gave; the ones the user gave themselves (S-25) have another frame color.
// Pressing one takes the user's off when it is theirs and adds it otherwise (`pressReaction`). The box ends with the button that opens the emoji picker (S-25); a message with no reaction has the box with that button alone (`.empty`, shown by CSS while the pointer or the focus is on the message).
// A custom emoji (S-26) is its image once `loadIcons` has fetched it (at once when it was fetched before); the `:name:` Rust gave is drawn until then.
export function reactionsNode(m: Reacted, target: ReactionTarget) {
  const box = tag("div", m.reactions.length ? "reactions" : "reactions empty");
  box.dataset.key = reactKey(target, m.ts, "");
  boxMessages.set(box, m);
  for (const r of m.reactions) {
    const chip = tag("button", r.mine ? "reaction mine" : "reaction");
    chip.type = "button";
    chip.dataset.name = r.name;
    chip.setAttribute("aria-pressed", String(r.mine));
    chip.disabled = reacting.has(reactKey(target, m.ts, r.name));
    chip.onclick = () => void pressReaction(m, target, r.name, box);
    const emoji = tag("span", "reaction-emoji", r.emoji);
    if (r.image) {
      // The image is here already, or it comes with the next `loadIcons`; the CSS draws the waiting slot grey.
      emoji.dataset.emojiImage = r.image;
      awaitEmoji(emoji, r.image);
    }
    chip.append(emoji, tag("span", "reaction-count", String(r.count)));
    box.append(chip);
  }
  const add = addButton().cloneNode(true) as HTMLButtonElement;
  add.onclick = () =>
    openEmojiPicker(add, target.teamId, {
      loadImages: (images) => {
        for (const { node, url } of images) awaitEmoji(node, url);
        return loadIcons(images.map((i) => i.url));
      },
      onPick: (picked) => void pressReaction(m, target, picked.name, box, picked),
    });
  box.append(add);
  return box;
}
