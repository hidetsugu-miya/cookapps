// What the Slack list and the Slack thread share: a message's time, the workspace color, and the users' icons.
// An icon is an https URL on Slack's image hosts; it is fetched by Rust's `fetch_images` (public hosts, no token) as a data: URI, so the CSP stays as it is.
// Until it is here, or when it cannot be fetched, the avatar is the initial on a color taken from the name.
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

// Puts the icon of `url` on every avatar waiting for it, once it is here.
export function paintIcons() {
  for (const node of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const uri = icons.get(node.dataset.icon!);
    if (!uri) continue;
    const img = tag("img", "av-img");
    img.src = uri;
    img.alt = "";
    node.querySelector(".av-text")?.replaceWith(img);
    delete node.dataset.icon;
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
  node.dataset.icon = iconUrl;
  paintIcons();
  return node;
}
