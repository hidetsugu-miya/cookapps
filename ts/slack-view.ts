// What the Slack list and the Slack thread share: a message's time, the workspace color, the users' icons, and the reactions under a message (S-22, S-25).
// An icon is an https URL on Slack's image hosts; it is fetched by Rust's `fetch_images` (public hosts, no token) as a data: URI, so the CSP stays as it is.
// Until it is here, or when it cannot be fetched, the avatar is the initial on a color taken from the name.
// The image of a custom emoji in a reaction (S-26) is fetched the same way; until it is here, or when it cannot be fetched, the reaction shows `:name:`.
import type { Reaction } from "./bindings/Reaction";
import { tag } from "./dom.js";
import { avatarColor, initials } from "./format.js";
import { invoke } from "./ipc.js";
import { toast } from "./toast.js";

// A Slack timestamp ("1700000000.123456") as epoch milliseconds.
export const slackMs = (ts: string) => Number(ts.split(".")[0]) * 1000;

// The color of a workspace: the dot on a list row and its avatar in the sidebar's tray (an avatar with no icon).
export const workspaceColor = (team: string) => avatarColor(team);

// The icons fetched so far, by URL. Memory only.
const icons = new Map<string, string>();
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

// Puts the icon of `url` on every avatar in the page waiting for it, and the image of a custom emoji in every reaction waiting for it, once it is here.
export function paintIcons() {
  for (const node of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const uri = icons.get(node.dataset.icon!);
    if (uri) putIcon(node, uri);
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-emoji-image]")) {
    const uri = icons.get(node.dataset.emojiImage!);
    if (uri) putEmoji(node, uri);
  }
}

// Fetches the icons of `urls` that are not here yet (https only), then paints. A URL that cannot be fetched stays an initial.
export function loadIcons(urls: (string | null)[]) {
  const wanted = [...new Set(urls.filter((u): u is string => !!u && u.startsWith("https://")))];
  chain = chain.then(async () => {
    const missing = wanted.filter((u) => !icons.has(u));
    for (let i = 0; i < missing.length; i += BATCH) {
      try {
        const got = await invoke("fetch_images", { urls: missing.slice(i, i + BATCH) });
        for (const [url, uri] of Object.entries(got)) icons.set(url, uri);
      } catch {
        // The initial stays.
      }
    }
    paintIcons();
  });
  return chain;
}

// Makes `node` (a div or a button) the avatar of `name`: the initial on the name's color, and the icon `iconUrl` when it is here (or when it comes later, by `loadIcons`).
export function decorateAvatar(node: HTMLElement, name: string, iconUrl: string | null) {
  node.style.background = avatarColor(name);
  node.replaceChildren(tag("span", "av-text", initials(name)));
  if (!iconUrl) return node;
  // An icon already fetched goes on the node itself, which may not be in the page yet (`paintIcons` looks only in the page); the others wait for `loadIcons`.
  const uri = icons.get(iconUrl);
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

// Adds the user's reaction `name` to the message `m`, or takes it off when it is theirs (S-25), then draws `m`'s reactions again in place of `box`, so that the scroll position stays.
// Only a success changes `m.reactions` (Rust says whether Slack changed anything: `false` is "it was so already", which moves the color and not the count); a failure shows the error and leaves them.
async function pressReaction(m: { ts: string; reactions: Reaction[] }, target: ReactionTarget, name: string, box: HTMLElement) {
  const key = reactKey(target, m.ts, name);
  const r = m.reactions.find((x) => x.name === name);
  if (!r || reacting.has(key)) return;
  const add = !r.mine;
  // A disabled button gives up the focus, so ask now whether the keyboard is in this box.
  const focused = box.contains(document.activeElement);
  reacting.add(key);
  box.querySelector<HTMLButtonElement>(`[data-name="${CSS.escape(name)}"]`)?.setAttribute("disabled", "");
  try {
    const changed = await invoke("slack_react", { ...target, ts: m.ts, name, add });
    r.mine = add;
    if (changed) r.count += add ? 1 : -1;
    if (r.count <= 0) m.reactions = m.reactions.filter((x) => x !== r);
  } catch (e) {
    toast(`リアクションを変えられませんでした: ${e}`);
  } finally {
    reacting.delete(key);
  }
  // The box may have been drawn again while the press was on its way: find it by the message.
  const live = box.isConnected ? box : document.querySelector<HTMLElement>(`.reactions[data-key="${CSS.escape(reactKey(target, m.ts, ""))}"]`);
  if (!live) return;
  const next = reactionsNode(m, target);
  if (next) live.replaceWith(next);
  else live.remove();
  if (focused) next?.querySelector<HTMLElement>(`[data-name="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
}

// The reactions under a message (S-22): each one a button with the emoji and how many gave it, in the order Rust gave; the ones the user gave themselves (S-25) have another frame color.
// Pressing one takes the user's off when it is theirs and adds it otherwise (`pressReaction`). null for a message that has none.
// A custom emoji (S-26) is its image once `loadIcons` has fetched it (at once when it was fetched before); the `:name:` Rust gave is drawn until then.
export function reactionsNode(m: { ts: string; reactions: Reaction[] }, target: ReactionTarget) {
  if (!m.reactions.length) return null;
  const box = tag("div", "reactions");
  box.dataset.key = reactKey(target, m.ts, "");
  for (const r of m.reactions) {
    const chip = tag("button", r.mine ? "reaction mine" : "reaction");
    chip.type = "button";
    chip.dataset.name = r.name;
    chip.setAttribute("aria-pressed", String(r.mine));
    chip.disabled = reacting.has(reactKey(target, m.ts, r.name));
    chip.onclick = () => void pressReaction(m, target, r.name, box);
    const emoji = tag("span", "reaction-emoji", r.emoji);
    if (r.image) {
      const uri = icons.get(r.image);
      if (uri) putEmoji(emoji, uri);
      else emoji.dataset.emojiImage = r.image;
    }
    chip.append(emoji, tag("span", "reaction-count", String(r.count)));
    box.append(chip);
  }
  return box;
}
