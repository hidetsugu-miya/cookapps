// What the Slack list and the Slack thread share: a message's time, the workspace color, the users' icons, and the reactions under a message (S-22).
// An icon is an https URL on Slack's image hosts; it is fetched by Rust's `fetch_images` (public hosts, no token) as a data: URI, so the CSP stays as it is.
// Until it is here, or when it cannot be fetched, the avatar is the initial on a color taken from the name.
// The image of a custom emoji in a reaction (S-26) is fetched the same way; until it is here, or when it cannot be fetched, the reaction shows `:name:`.
import type { Reaction } from "./bindings/Reaction";
import { tag } from "./dom.js";
import { avatarColor, initials } from "./format.js";
import { invoke } from "./ipc.js";

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

// The reactions under a message (S-22): each one the emoji and how many gave it, in the order Rust gave. Display only. null for a message that has none.
// A custom emoji (S-26) is its image once `loadIcons` has fetched it (at once when it was fetched before); the `:name:` Rust gave is drawn until then.
export function reactionsNode(reactions: Reaction[]) {
  if (!reactions.length) return null;
  const box = tag("div", "reactions");
  for (const r of reactions) {
    const chip = tag("span", "reaction");
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
