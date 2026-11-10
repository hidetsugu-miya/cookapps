// The file pane of the Orca screen (A-18): the files of the worktree of the selected tab (with no tab, the main worktree of the selected project), as a tree on the right of the work pane. Rust reads a folder (`orca_files_list`: its entries sorted, with what git ignores marked); this module draws it and takes the presses.
// A folder is read when it is opened (each time), and the reload button reads the root and the open folders again, one after the other. A file opens in the editor on a double press, and the right button on a row opens the menu that copies its path (and, on a file, downloads it). The pane is shown or hidden by the button in its top row while it is shown, and by the button at the right end of the tab strip of the corner pane while it is hidden.
// The tree belongs to one worktree of one target: another tab's worktree gives a new tree (nothing is kept of the old one).
import type { OrcaDir } from "./bindings/OrcaDir";
import type { OrcaFileEntry } from "./bindings/OrcaFileEntry";
import { $, tag } from "./dom.js";
import { CHEVRON_SVG, COPY_PATH_SVG, DOWNLOAD_SVG, FILE_SVG, FOLDER_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { toast } from "./toast.js";
import { copyText, showError } from "./view.js";

// The worktree shown (the selected tab's, else the selected project's main one), with the name its heading shows ("{repo} ・ {branch}").
export interface FilesContext {
  target: string | null;
  path: string;
  label: string;
}

// What was read of a folder: its entries (kept while it is read again), the message of a read that failed, and whether one is on its way.
interface Listing {
  dir: OrcaDir | null;
  error: string | null;
  busy: boolean;
}

let shown = false;
let context: FilesContext | null = null;
// A new tree (another worktree) ends the reads of the old one.
let generation = 0;
const listings = new Map<string, Listing>();
const expanded = new Set<string>();
// What the pane draws now; it is drawn again only when this changes.
let drawn = "";
let version = 0;
// Whether a drawing is waiting for the next frame (the reads that end in it are drawn once).
let waiting = false;
let openFile: (relative: string) => void = () => {};
// The files open in the worktree, which the last drawing colored.
let opened = new Set<string>();

export const filesShown = () => shown;

export function toggleFiles() {
  shown = !shown;
  $("orca-files").hidden = !shown;
  $("orca-files-split").hidden = !shown;
}

// Whether the list marked the folder `dir` as ignored (what it holds is ignored then, and Rust does not ask git).
function ignoredDir(dir: string) {
  const parent = dir.slice(0, Math.max(0, dir.lastIndexOf("/")));
  return listings.get(parent)?.dir?.entries.find((e) => e.path === dir)?.ignored ?? false;
}

// Draws at the next frame, once for the reads that end before it.
function drawSoon() {
  if (waiting) return;
  waiting = true;
  requestAnimationFrame(() => {
    waiting = false;
    draw();
  });
}

async function readDir(dir: string) {
  const here = context;
  if (here === null) return;
  const mine = generation;
  const held = listings.get(dir);
  listings.set(dir, { dir: held?.dir ?? null, error: null, busy: true });
  let next: Listing;
  try {
    next = { dir: await invoke("orca_files_list", { path: here.path, dir, ignored: ignoredDir(dir), environment: here.target }), error: null, busy: false };
  } catch (e) {
    next = { dir: held?.dir ?? null, error: String(e), busy: false };
  }
  if (mine !== generation) return;
  listings.set(dir, next);
  version++;
  drawSoon();
}

// Reads the root and the folders that are open again, one at a time (each read is a connection of its own); another worktree's tree ends it.
async function reload() {
  const mine = generation;
  for (const dir of ["", ...expanded]) {
    if (mine !== generation) return;
    await readDir(dir);
  }
}

function toggleDir(path: string) {
  if (expanded.has(path)) {
    expanded.delete(path);
    version++;
    draw();
  } else {
    expanded.add(path);
    void readDir(path);
  }
}

// Saves the file to this PC (A-22): Rust opens the save dialog and writes where it says, so the page names no place. Nothing is shown when the dialog is cancelled.
async function download(here: FilesContext, relative: string) {
  try {
    const name = await invoke("orca_file_download", { path: here.path, relative, environment: here.target });
    if (name !== null) toast(`${name} をダウンロードしました`);
  } catch (e) {
    showError(e);
  }
}

// The menu of a row (the right button): the path of the entry on the machine of the worktree, its path from the worktree, and, on a file, the download. The menu sets and removes aria-expanded on its anchor, so the anchor is the row's name, not the row, whose own aria-expanded is the state of its folder.
function openRowMenu(anchor: Element, relative: string, isDirectory: boolean) {
  const here = context;
  if (here === null) return;
  const item = (label: string, icon: string, pick: () => unknown) => ({ label, color: "var(--accent)", icon, current: false, pick });
  const copy = (label: string, text: string, done: string) => item(label, COPY_PATH_SVG, () => void copyText(text, done));
  const items = [copy("パスのコピー", `${here.path.replace(/\/+$/, "")}/${relative}`, "パスをコピーしました"), copy("相対パスをコピー", relative, "相対パスをコピーしました")];
  if (!isDirectory) items.push(item("ダウンロード", DOWNLOAD_SVG, () => void download(here, relative)));
  openMenu(anchor, items);
}

function row(entry: OrcaFileEntry, depth: number) {
  const button = tag("button", "orca-file");
  button.type = "button";
  button.dataset.path = entry.path;
  button.dataset.kind = entry.isDirectory ? "dir" : "file";
  button.dataset.ignored = String(entry.ignored);
  button.style.setProperty("--depth", String(depth));
  const name = tag("span", "orca-file-name", entry.name);
  button.oncontextmenu = (e) => {
    e.preventDefault();
    openRowMenu(name, entry.path, entry.isDirectory);
  };
  const mark = tag("span", "orca-file-mark");
  if (entry.isDirectory) {
    const open = expanded.has(entry.path);
    button.setAttribute("aria-expanded", String(open));
    mark.innerHTML = CHEVRON_SVG;
    button.append(mark, icon(FOLDER_SVG));
    button.onclick = () => toggleDir(entry.path);
  } else {
    button.dataset.open = String(opened.has(entry.path));
    button.append(mark, icon(FILE_SVG));
    // A file opens on a double press (or Enter), so a single press can only select it.
    button.ondblclick = () => openFile(entry.path);
    button.onkeydown = (e) => {
      if (e.key === "Enter") openFile(entry.path);
    };
  }
  button.append(name);
  return button;
}

function icon(svg: string) {
  const node = tag("span", "orca-file-ic");
  node.innerHTML = svg;
  return node;
}

function note(text: string, depth: number, fail = false) {
  const line = tag("p", `orca-file-note${fail ? " fail" : ""}`, text);
  line.style.setProperty("--depth", String(depth));
  return line;
}

// The rows of the folder `dir` and, under each open folder, its own.
function rows(dir: string, depth: number): HTMLElement[] {
  const listing = listings.get(dir);
  if (!listing) return [];
  const nodes: HTMLElement[] = [];
  if (listing.error !== null) nodes.push(note(listing.error, depth, true));
  if (listing.dir === null) {
    if (listing.busy) {
      const loading = tag("div", "pending");
      loading.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
      nodes.push(loading);
    }
    return nodes;
  }
  for (const entry of listing.dir.entries) {
    nodes.push(row(entry, depth));
    if (entry.isDirectory && expanded.has(entry.path)) nodes.push(...rows(entry.path, depth + 1));
  }
  const more = listing.dir.total - listing.dir.entries.length;
  if (more > 0) nodes.push(note(`ほか ${more} 件`, depth));
  return nodes;
}

// Draws the pane, unless it is what is drawn already.
function draw() {
  const key = JSON.stringify([shown, context, version, [...opened]]);
  if (key === drawn) return;
  drawn = key;
  $("orca-files-title").textContent = context?.label ?? "";
  $<HTMLButtonElement>("orca-files-reload").disabled = context === null;
  const tree = $("orca-files-tree");
  const top = tree.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.path;
  tree.replaceChildren(...(context === null ? [] : rows("", 0)));
  tree.scrollTop = top;
  if (focused) tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

// Follows the selected tab: its worktree (null: none), and the files open in it. Another worktree starts a new tree, read at once while the pane is shown.
export function syncFiles(next: FilesContext | null, open: Set<string>) {
  opened = open;
  const same = next?.path === context?.path && next?.target === context?.target;
  if (!same) {
    generation++;
    listings.clear();
    expanded.clear();
    version++;
  }
  context = next;
  if (shown && context !== null && !listings.has("")) void readDir("");
  draw();
}

export function initOrcaFiles(on: { open: (relative: string) => void; toggle: () => void }) {
  openFile = on.open;
  $("orca-files-toggle").innerHTML = FOLDER_SVG;
  $("orca-files-toggle").onclick = on.toggle;
  $("orca-files-reload").onclick = () => void reload();
}
