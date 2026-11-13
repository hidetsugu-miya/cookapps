// The emoji picker under the "add a reaction" button of a message (S-25): a search field, then the emoji used in this run (最近), the workspace's custom emoji (S-26) and the standard emoji.
// Rust lists the emoji (`slack_emoji_catalog`); the list is kept here per workspace for an hour, in memory only, so it is not asked for again each time the picker opens.
// The images of the custom emoji are fetched for the cells that are in view only, as they scroll in.
// The cells of a workspace are made once with its list and kept with it, so that opening the picker again makes none.
import type { EmojiCatalog } from "./bindings/EmojiCatalog";
import { composing, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";

// An emoji chosen in the picker: Slack's name of it, what a reaction draws (the Unicode emoji, or `:name:` for a custom one) and, for a custom emoji, its image address (as `Reaction` has them).
export type PickedEmoji = { name: string; emoji: string; image: string | null };

export type PickerOptions = {
  onPick: (picked: PickedEmoji) => void;
  // Fetches the images of these slots (the address and the node waiting for it) and paints them (`loadIcons` of slack-view).
  loadImages: (images: { url: string; node: HTMLElement }[]) => unknown;
};

// How long a workspace's list is kept (Rust keeps the custom emoji for as long).
const CATALOG_TTL = 60 * 60 * 1000;
// How many recent emoji a workspace remembers.
const RECENT_MAX = 24;

// The cells of one section: the grid, which is moved from one picker to the next, and the cells with their names in lower case.
type Cell = { name: string; node: HTMLElement };
type Part = { grid: HTMLElement; cells: Cell[] };
type Built = { custom: Part; standard: Part };

const catalogs = new Map<string, { at: number; got: Promise<Built> }>();
// The emoji added in this run, newest first, by workspace. Memory only.
const recents = new Map<string, PickedEmoji[]>();

function partOf(list: PickedEmoji[]): Part {
  const grid = tag("div", "emoji-grid");
  const cells = list.map((e) => ({ name: e.name.toLowerCase(), node: cellOf(e) }));
  grid.append(...cells.map((c) => c.node));
  return { grid, cells };
}

// The workspace's cells are made once, with the list: opening the picker again moves the grids and makes no cell.
function catalogOf(teamId: string) {
  const kept = catalogs.get(teamId);
  if (kept && Date.now() - kept.at < CATALOG_TTL) return kept.got;
  const entry = {
    at: Date.now(),
    got: invoke("slack_emoji_catalog", { teamId }).then(
      (catalog: EmojiCatalog): Built => ({
        custom: partOf(catalog.custom.map((c) => ({ name: c.name, emoji: `:${c.name}:`, image: c.image }))),
        standard: partOf(catalog.standard.map((e) => ({ name: e.name, emoji: e.emoji, image: null }))),
      }),
    ),
  };
  catalogs.set(teamId, entry);
  // A failed read is not kept: the next opening asks again. Nor is a list with no custom emoji, which may be a failure of Rust's read or a token that was pasted again since.
  entry.got.then(
    (built) => {
      if (built.custom.cells.length === 0 && catalogs.get(teamId) === entry) catalogs.delete(teamId);
    },
    () => {
      if (catalogs.get(teamId) === entry) catalogs.delete(teamId);
    },
  );
  return entry.got;
}

// Forgets the lists of every workspace: a token was pasted again or a workspace was removed, so what Rust lists may differ now.
export function forgetEmojiCatalogs() {
  catalogs.clear();
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
  // The image is put here once it is fetched (`awaitEmoji` of slack-view, asked when the cell comes into view).
  const slot = tag("span", "reaction-emoji");
  slot.dataset.emojiImage = picked.image;
  cell.append(slot);
  return cell;
}

function sectionOf(title: string) {
  const section = tag("section", "emoji-sec");
  const heading = tag("h3", "", title);
  section.hidden = true;
  return { section, heading, cells: [] as Cell[] };
}

// The observer of the picker that is open: the next opening ends it (cells of the grids are moved to the next picker).
let watching: IntersectionObserver | null = null;

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
  let wanted: { url: string; node: HTMLElement }[] = [];
  let timer: number | undefined;
  watching?.disconnect();
  const observer = new IntersectionObserver(
    (entries) => {
      if (!pop.isConnected) return observer.disconnect();
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const cell = entry.target as HTMLElement;
        const slot = cell.firstElementChild as HTMLElement | null;
        if (slot?.dataset.emojiImage) wanted.push({ url: slot.dataset.emojiImage, node: slot });
        observer.unobserve(cell);
      }
      if (wanted.length && timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          if (!pop.isConnected) return;
          const images = wanted;
          wanted = [];
          options.loadImages(images);
        }, 30);
      }
    },
    { root: scroll, rootMargin: "80px" },
  );
  watching = observer;

  const fill = (s: ReturnType<typeof sectionOf>, part: Part) => {
    s.cells = part.cells;
    s.section.replaceChildren(s.heading, part.grid);
    s.section.hidden = part.cells.length === 0;
    // The cells whose image is not here yet: a grid kept from an earlier opening has the painted ones already.
    for (const { node } of part.cells) if (node.dataset.image && (node.firstElementChild as HTMLElement | null)?.dataset.emojiImage) observer.observe(node);
  };

  // The cells the text leaves: a part of the name, case ignored. A section with none is hidden. Only a cell whose state changes is written.
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    for (const s of sections) {
      let any = false;
      for (const c of s.cells) {
        const hit = q === "" || c.name.includes(q);
        if (c.node.hidden === hit) c.node.hidden = !hit;
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
  fill(recent, partOf(recents.get(teamId) ?? []));
  status.textContent = "読み込んでいます…";
  catalogOf(teamId).then(
    (built) => {
      if (!pop.isConnected) return;
      status.hidden = true;
      fill(custom, built.custom);
      fill(standard, built.standard);
      filter();
    },
    (error) => {
      if (!pop.isConnected) return;
      status.textContent = `読み込めませんでした: ${error}`;
      status.classList.add("err");
    },
  );
}
