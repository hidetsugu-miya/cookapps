// The emoji picker under the "add a reaction" button of a message (S-25): a search field, then the emoji used in this run (最近), the workspace's custom emoji (S-26) and the standard emoji.
// Rust lists the emoji (`slack_emoji_catalog`); the list is kept here per workspace for an hour, in memory only, so it is not asked for again each time the picker opens.
// The images of the custom emoji are fetched for the cells that are in view only, as they scroll in.
import type { EmojiCatalog } from "./bindings/EmojiCatalog";
import { composing, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";

// An emoji chosen in the picker: Slack's name of it, what a reaction draws (the Unicode emoji, or `:name:` for a custom one) and, for a custom emoji, its image address (as `Reaction` has them).
export type PickedEmoji = { name: string; emoji: string; image: string | null };

export type PickerOptions = {
  onPick: (picked: PickedEmoji) => void;
  // Fetches the images at these addresses and paints the cells waiting for them (`loadIcons` of slack-view).
  loadImages: (urls: string[]) => unknown;
};

// How long a workspace's list is kept (Rust keeps the custom emoji for as long).
const CATALOG_TTL = 60 * 60 * 1000;
// How many recent emoji a workspace remembers.
const RECENT_MAX = 24;

const catalogs = new Map<string, { at: number; got: Promise<EmojiCatalog> }>();
// The emoji added in this run, newest first, by workspace. Memory only.
const recents = new Map<string, PickedEmoji[]>();

function catalogOf(teamId: string) {
  const kept = catalogs.get(teamId);
  if (kept && Date.now() - kept.at < CATALOG_TTL) return kept.got;
  const entry = { at: Date.now(), got: invoke("slack_emoji_catalog", { teamId }) };
  catalogs.set(teamId, entry);
  // A failed read is not kept: the next opening asks again.
  entry.got.catch(() => {
    if (catalogs.get(teamId) === entry) catalogs.delete(teamId);
  });
  return entry.got;
}

// Remembers `picked` as the newest recent emoji of the workspace, once the reaction was added.
export function rememberEmoji(teamId: string, picked: PickedEmoji) {
  const list = (recents.get(teamId) ?? []).filter((e) => e.name !== picked.name);
  recents.set(teamId, [picked, ...list].slice(0, RECENT_MAX));
}

function cellOf(picked: PickedEmoji) {
  const cell = tag("button", "emoji-cell");
  cell.type = "button";
  cell.dataset.name = picked.name;
  cell.dataset.emoji = picked.emoji;
  cell.setAttribute("aria-label", `:${picked.name}:`);
  cell.title = `:${picked.name}:`;
  if (picked.image === null) {
    cell.textContent = picked.emoji;
    return cell;
  }
  cell.dataset.image = picked.image;
  // `paintIcons` puts the image here once it is fetched.
  const slot = tag("span", "reaction-emoji");
  slot.dataset.emojiImage = picked.image;
  cell.append(slot);
  return cell;
}

function sectionOf(title: string) {
  const section = tag("section", "emoji-sec");
  const grid = tag("div", "emoji-grid");
  section.append(tag("h3", "", title), grid);
  section.hidden = true;
  return { section, grid };
}

// Opens the picker under `anchor`. A pick closes it and calls `onPick`; Escape and a press elsewhere close it (`menu.ts`).
export function openEmojiPicker(anchor: Element, teamId: string, options: PickerOptions) {
  const pop = tag("div", "menu menu-searchable emoji-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "絵文字を選ぶ");
  const input = tag("input", "menu-search");
  input.type = "text";
  input.setAttribute("aria-label", "絵文字を検索");
  input.autocomplete = "off";
  input.spellcheck = false;
  const scroll = tag("div", "emoji-scroll");
  const recent = sectionOf("最近");
  const custom = sectionOf("カスタム");
  const standard = sectionOf("標準");
  const sections = [recent, custom, standard];
  const status = tag("p", "emoji-status");
  const none = tag("div", "menu-empty", "該当する絵文字がありません");
  none.hidden = true;
  scroll.append(...sections.map((s) => s.section), status, none);
  pop.append(input, scroll);

  // The custom cells whose images are asked for, a little after they come into view (one request for the cells of a scroll).
  const wanted = new Set<string>();
  let timer: number | undefined;
  const observer = new IntersectionObserver(
    (entries) => {
      if (!pop.isConnected) return observer.disconnect();
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const url = (entry.target as HTMLElement).dataset.image;
        if (url) wanted.add(url);
        observer.unobserve(entry.target);
      }
      if (wanted.size && timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          if (!pop.isConnected) return;
          const urls = [...wanted];
          wanted.clear();
          options.loadImages(urls);
        }, 30);
      }
    },
    { root: scroll, rootMargin: "80px" },
  );

  const fill = (s: { section: HTMLElement; grid: HTMLElement }, list: PickedEmoji[]) => {
    s.grid.replaceChildren(...list.map(cellOf));
    s.section.hidden = list.length === 0;
    for (const cell of s.grid.querySelectorAll<HTMLElement>(".emoji-cell[data-image]")) observer.observe(cell);
  };

  // The cells the text leaves: a part of the name, case ignored. A section with none is hidden.
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    for (const s of sections) {
      let any = false;
      for (const cell of s.grid.querySelectorAll<HTMLElement>(".emoji-cell")) {
        const hit = q === "" || cell.dataset.name!.toLowerCase().includes(q);
        cell.hidden = !hit;
        any ||= hit;
      }
      s.section.hidden = !any;
    }
    none.hidden = !status.hidden || sections.some((s) => !s.section.hidden);
  };
  const firstCell = () => scroll.querySelector<HTMLElement>(".emoji-sec:not([hidden]) .emoji-cell:not([hidden])");

  input.oninput = filter;
  input.onkeydown = (e) => {
    if (composing(e) || e.key !== "Enter") return;
    e.preventDefault();
    firstCell()?.click();
  };
  scroll.onclick = (e) => {
    const cell = (e.target as Element).closest<HTMLElement>(".emoji-cell");
    if (!cell) return;
    closeMenu();
    options.onPick({ name: cell.dataset.name!, emoji: cell.dataset.emoji!, image: cell.dataset.image ?? null });
  };

  showMenu(anchor, pop);
  input.focus();
  fill(recent, recents.get(teamId) ?? []);
  status.textContent = "読み込んでいます…";
  catalogOf(teamId).then(
    (catalog) => {
      if (!pop.isConnected) return;
      status.hidden = true;
      fill(
        custom,
        catalog.custom.map((c) => ({ name: c.name, emoji: `:${c.name}:`, image: c.image })),
      );
      fill(
        standard,
        catalog.standard.map((e) => ({ name: e.name, emoji: e.emoji, image: null })),
      );
      filter();
    },
    (error) => {
      if (!pop.isConnected) return;
      status.textContent = `読み込めませんでした: ${error}`;
      status.classList.add("err");
    },
  );
}
