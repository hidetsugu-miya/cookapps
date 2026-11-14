// The file pane of the Orca screen (A-18): the files of the worktree of the selected tab (with no tab, the main worktree of the selected project), as a tree on the right of the work pane. Rust reads a folder (`orca_files_list`: its entries sorted) and, after it, which of them git ignores (`orca_files_ignored`); this module draws the folder at once, marks the ignored entries when the answer comes, and takes the presses.
// A folder is read the first time it is opened and drawn from what was read after that, and the root and then the open folders are read again, side by side (at most `reads()` at a time), when the window gets the focus back (`refreshFiles`, called by orca.ts), after the app's own create and delete, and after a switch of the branch. Nothing watches the disk: Orca's `files.watch` is a stream, and this machine's Orca refuses streaming methods (A-12). A file opens in the editor on a double press, and the right button on a row opens the menu that copies its path (and, on a file, downloads it; on a folder, first makes a new file or folder in it, as the right button on the empty part of the tree does in the root; last, after a line, the delete, which asks first and deletes for good, A-18). The pane is shown or hidden by the button in its top row while it is shown, and by the button at the right end of the tab strip of the corner pane while it is hidden.
// The tree belongs to one worktree of one target: another tab's worktree gives a new tree (nothing is kept of the old one, and an answer that comes late for the old one is dropped).
// The top row also has the two buttons that choose what the pane shows under the heading, the files or the history of the worktree (A-27, orca-history.ts); the choice is kept in memory only, and the heading serves both, and so does the read at the return of the focus (`refreshFiles`).
import type { OrcaDir } from "./bindings/OrcaDir";
import type { OrcaFileEntry } from "./bindings/OrcaFileEntry";
import { $, composing, tag } from "./dom.js";
import { confirmDelete } from "./hint.js";
import { BRANCH_SVG, CHEVRON_SVG, COPY_PATH_SVG, DELETE_SVG, DIFF_SVG, DOWNLOAD_SVG, FILE_SVG, FOLDER_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { closeBranchDialog, openBranchDialog } from "./orca-branch.js";
import type { DiffCommit } from "./orca-diff.js";
import { initHistory, refreshHistory, reloadHistory, syncHistory } from "./orca-history.js";
import { toast } from "./toast.js";
import { copyText, showError } from "./view.js";

// The worktree shown (the selected tab's, else the selected project's main one), with the name its heading shows ("{repo} ・ {branch}"). `branch` is the git branch of the worktree, which the heading makes a button (A-25), null where it stays text (an SSH host's, a worktree the list does not hold, or one on no branch); `project` is the key of the project of the worktree.
export interface FilesContext {
  target: string | null;
  path: string;
  label: string;
  project: string;
  branch: string | null;
}

// What was read of a folder: its entries (kept while it is read again), the message of a read that failed, and whether one is on its way.
interface Listing {
  dir: OrcaDir | null;
  error: string | null;
  busy: boolean;
}

let shown = false;
// What the pane shows under the heading.
let mode: "files" | "history" = "files";
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
// The name being typed for a new file or folder (A-18): the first row of the folder `dir`. `text` is what is typed (kept while the tree is drawn again), `busy` that the create is on its way.
interface Creating {
  dir: string;
  folder: boolean;
  text: string;
  busy: boolean;
}
let creating: Creating | null = null;
// Whether the tree is being replaced: the loss of the field that goes with it is not a blur of the owner.
let redrawing = false;
let openFile: (relative: string) => void = () => {};
let openDiff: (relative: string) => void = () => {};
let branchSwitched: () => void = () => {};
// Told that the file `relative` (with `folder`, the folder and everything under it) is gone, so the tabs of the editor that hold it close.
let gone: (here: FilesContext, relative: string, folder: boolean) => void = () => {};
// The heading as it is drawn (the label and the branch), so that the branch button stays while the list under it is open.
let drawnTitle = "";
// The files open in the worktree, which the last drawing colored.
let opened = new Set<string>();

export const filesShown = () => shown;

export function toggleFiles() {
  shown = !shown;
  $("orca-files").hidden = !shown;
  $("orca-files-split").hidden = !shown;
  syncModes();
}

// Shows the part of the pane that is chosen, and starts the read of it that is due: the history is read only while it is shown, the root of the tree only while the files are.
function syncModes() {
  const history = mode === "history";
  $("orca-files-tree").hidden = history;
  $("orca-history").hidden = !history;
  $("orca-files-mode-files").setAttribute("aria-pressed", String(!history));
  $("orca-files-mode-history").setAttribute("aria-pressed", String(history));
  syncHistory(context === null ? null : { target: context.target, path: context.path }, shown && history);
  if (shown && !history && context !== null && !listings.has("")) void readDir("");
}

function chooseMode(next: "files" | "history") {
  if (mode === next) return;
  mode = next;
  syncModes();
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

// Marks the entries of `read`, the folder `dir` as it was listed, that git ignores, and takes the mark off the ones it does not name (`read` may hold the marks of the earlier listing, `readDir`). It is asked after the folder is drawn, and an answer that fails leaves `read` as it is. The answer is dropped when the tree is another worktree's by then, or the folder was read again.
async function markIgnored(here: FilesContext, mine: number, dir: string, read: OrcaDir) {
  let paths: string[];
  try {
    paths = await invoke("orca_files_ignored", { path: here.path, paths: read.entries.map((e) => e.path), environment: here.target });
  } catch {
    return;
  }
  const listing = listings.get(dir);
  if (mine !== generation || listing?.dir !== read || (paths.length === 0 && !read.entries.some((e) => e.ignored))) return;
  const ignored = new Set(paths);
  listings.set(dir, { ...listing, dir: { ...read, entries: read.entries.map((e) => ({ ...e, ignored: ignored.has(e.path) })) } });
  version++;
  drawSoon();
}

async function readDir(dir: string) {
  const here = context;
  if (here === null) return;
  const mine = generation;
  const held = listings.get(dir);
  // What a folder that the list marked as ignored holds is ignored too, and Rust does not ask git for it.
  const inherited = ignoredDir(dir);
  listings.set(dir, { dir: held?.dir ?? null, error: null, busy: true });
  let next: Listing;
  try {
    const read = await invoke("orca_files_list", { path: here.path, dir, ignored: inherited, environment: here.target });
    // The entries that the earlier listing marked as ignored keep the mark until the answer of git replaces it, so that a reload does not blink it away.
    const was = new Set(held?.dir?.entries.filter((e) => e.ignored).map((e) => e.path));
    next = { dir: inherited || was.size === 0 ? read : { ...read, entries: read.entries.map((e) => (was.has(e.path) ? { ...e, ignored: true } : e)) }, error: null, busy: false };
  } catch (e) {
    next = { dir: held?.dir ?? null, error: String(e), busy: false };
  }
  if (mine !== generation) return;
  listings.set(dir, next);
  version++;
  drawSoon();
  if (!inherited && next.dir !== null && next.error === null && next.dir.entries.length > 0) void markIgnored(here, mine, dir, next.dir);
}

// How many folders a read of the open folders takes at once, as Orca's own window does: 16 on this machine, 8 on a saved environment (its connection is a paired server's).
const reads = (here: FilesContext) => (here.target === null ? 16 : 8);

// Reads the root, and when it is read the folders that are open again, side by side. The root goes first alone, so that the check of the worktree that its read may start is done once, not once for each folder read at the same time. A folder that was read and is closed is dropped, so that it is read when it is opened next. Another worktree's tree ends it.
async function reload() {
  const here = context;
  if (here === null) return;
  const mine = generation;
  const queue = [...expanded];
  for (const dir of [...listings.keys()]) if (dir !== "" && !queue.includes(dir)) listings.delete(dir);
  await readDir("");
  const worker = async () => {
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      if (mine !== generation) return;
      await readDir(dir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(queue.length, reads(here)) }, worker));
}

// Reads again what the pane shows, when the window gets the focus back: the files (the root, then the open folders) or the history (from the start). It does nothing while the pane is hidden or has no worktree, and while a read of the same kind is on its way, so a failed read is tried again at the next return.
export function refreshFiles() {
  if (!shown || context === null) return;
  if (mode === "history") refreshHistory();
  else if (![...listings.values()].some((l) => l.busy)) void reload();
}

// A scratchpad file was made in `.orca/scratchpad` of the worktree at `path` (A-29): when the tree is that worktree's, the folders on the way to it that it has read are read again, the root first, so that a folder that was not there shows now.
export function rereadScratchpad(target: string | null, path: string) {
  if (context === null || context.path !== path || context.target !== target) return;
  void (async () => {
    for (const dir of ["", ".orca", ".orca/scratchpad"]) if (listings.has(dir)) await readDir(dir);
  })();
}

// Opens the folder: it is drawn from what was read (the next return of the focus reads it again; a folder whose read failed is read again when it is opened), waited for while it is being read, and read when it was not.
function expandDir(path: string) {
  expanded.add(path);
  const held = listings.get(path);
  if (held !== undefined && (held.busy || (held.dir !== null && held.error === null))) {
    version++;
    draw();
  } else {
    void readDir(path);
  }
}

function toggleDir(path: string) {
  if (expanded.has(path)) {
    expanded.delete(path);
    version++;
    draw();
  } else {
    expandDir(path);
  }
}

// Asks for the name of a new file or folder in `dir`: the folder is opened (and read when it was not), and the first row in it is the field.
function startCreate(dir: string, folder: boolean) {
  if (context === null) return;
  creating = { dir, folder, text: "", busy: false };
  if (dir !== "") expandDir(dir);
  else if (!listings.has("")) void readDir("");
  version++;
  draw();
  focusField(true);
}

function cancelCreate() {
  if (creating === null || creating.busy) return;
  creating = null;
  version++;
  draw();
}

// Makes the file or folder named by the field. A blank name is a cancel. Rust checks the name, and a name that is taken is its error: the field goes and the message is shown. After it is made the folder is read again, and a new file opens in the editor.
async function submitCreate() {
  const here = context;
  const field = creating;
  if (here === null || field === null || field.busy) return;
  const name = field.text.trim();
  if (name === "") return cancelCreate();
  field.busy = true;
  const mine = generation;
  try {
    const relative = await invoke("orca_file_create", { path: here.path, dir: field.dir, name, folder: field.folder, environment: here.target });
    if (mine !== generation) return;
    if (creating === field) creating = null;
    await readDir(field.dir);
    if (!field.folder && mine === generation) openFile(relative);
  } catch (e) {
    if (mine !== generation) return;
    if (creating === field) creating = null;
    version++;
    draw();
    showError(e);
  }
}

// The row with the field of the name being typed.
function createRow(depth: number, field: Creating) {
  const line = tag("div", "orca-file-new");
  line.style.setProperty("--depth", String(depth));
  const input = tag("input", "orca-file-input");
  input.type = "text";
  input.value = field.text;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", field.folder ? "新しいフォルダーの名前" : "新しいファイルの名前");
  input.oninput = () => {
    field.text = input.value;
  };
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submitCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelCreate();
    }
  };
  // Leaving the field with a name typed makes it, and with none cancels it.
  input.onblur = () => {
    if (!redrawing && creating === field) void submitCreate();
  };
  line.append(tag("span", "orca-file-mark"), icon(field.folder ? FOLDER_SVG : FILE_SVG), input);
  return line;
}

// Puts the keys in the field of the name. `scroll` brings it into view (it was just asked for).
function focusField(scroll: boolean) {
  const input = $("orca-files-tree").querySelector<HTMLInputElement>(".orca-file-input");
  if (input === null) return;
  input.focus({ preventScroll: !scroll });
  input.setSelectionRange(input.value.length, input.value.length);
  if (scroll) input.scrollIntoView({ block: "nearest" });
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

// Deletes the file or folder for good (Orca's `files.delete`, which skips the Trash) once the confirmation has been answered. It is gone from the editor and the tree after: a folder's reads are dropped, and the folder it was in is read again. A worktree that is not the tree's any more only closes the tabs.
async function remove(here: FilesContext, relative: string, folder: boolean) {
  const mine = generation;
  try {
    await invoke("orca_file_delete", { path: here.path, relative, folder, environment: here.target });
  } catch (e) {
    if (mine === generation) showError(e);
    return;
  }
  gone(here, relative, folder);
  if (mine !== generation) return;
  const under = (path: string) => path === relative || path.startsWith(`${relative}/`);
  if (folder) {
    for (const path of [...listings.keys()]) if (under(path)) listings.delete(path);
    for (const path of [...expanded]) if (under(path)) expanded.delete(path);
    if (creating !== null && under(creating.dir)) creating = null;
  }
  await readDir(relative.slice(0, Math.max(0, relative.lastIndexOf("/"))));
}

const menuItem = (label: string, icon: string, pick: () => unknown) => ({ label, color: "var(--accent)", icon, current: false, pick });

// The two items that make a new file or folder in the folder `dir` (the empty one is the worktree's root).
const createItems = (dir: string) => [menuItem("新規ファイル", FILE_SVG, () => startCreate(dir, false)), menuItem("新規フォルダー", FOLDER_SVG, () => startCreate(dir, true))];

// The menu of a row (the right button): on a folder the new file and folder and then, after a line, the copies; on a file the path of the entry on the machine of the worktree, its path from the worktree, the download and the difference from HEAD (A-24); and on both, last and after a line, the delete in red. The menu sets and removes aria-expanded on its anchor, so the anchor is the row's name, not the row, whose own aria-expanded is the state of its folder.
function openRowMenu(anchor: Element, relative: string, isDirectory: boolean) {
  const here = context;
  if (here === null) return;
  const copy = (label: string, text: string, done: string) => menuItem(label, COPY_PATH_SVG, () => void copyText(text, done));
  const del = { ...menuItem("削除", DELETE_SVG, () => confirmDelete(anchor, relative.slice(relative.lastIndexOf("/") + 1), () => void remove(here, relative, isDirectory))), danger: true, divider: true };
  const [path, from] = [copy("パスのコピー", `${here.path.replace(/\/+$/, "")}/${relative}`, "パスをコピーしました"), copy("相対パスをコピー", relative, "相対パスをコピーしました")];
  if (isDirectory) openMenu(anchor, [...createItems(relative), { ...path, divider: true }, from, del]);
  else openMenu(anchor, [path, from, menuItem("ダウンロード", DOWNLOAD_SVG, () => void download(here, relative)), menuItem("差分を表示", DIFF_SVG, () => openDiff(relative)), del]);
}

// The menu of the empty part of the tree (the right button): the new file and folder in the root of the worktree, where the pointer is.
function openRootMenu(e: MouseEvent) {
  if (context === null || (e.target as Element).closest(".orca-file, .orca-file-new") !== null) return;
  e.preventDefault();
  openMenu($("orca-files-tree"), createItems(""), { at: { x: e.clientX, y: e.clientY } });
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
  if (creating?.dir === dir) nodes.push(createRow(depth, creating));
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

// The branch button of the heading: the list of branches opens under it (A-25), and a switch reads the tree again as well as the list of Orca.
function openBranches(anchor: Element) {
  const here = context;
  if (here === null || here.branch === null) return;
  openBranchDialog(anchor, { target: here.target, path: here.path, repo: here.project, branch: here.branch }, () => {
    void reload();
    reloadHistory();
    branchSwitched();
  });
}

// Draws the heading: the name, and the git branch as a button when it has one. The branch is the end of the name when Orca's name of the worktree is the branch, else it follows the name.
function drawTitle() {
  const key = JSON.stringify([context?.label, context?.branch]);
  if (key === drawnTitle) return;
  drawnTitle = key;
  const title = $("orca-files-title");
  if (context === null || context.branch === null) {
    title.textContent = context?.label ?? "";
    return;
  }
  const button = tag("button", "orca-branch-btn", context.branch);
  button.type = "button";
  button.onclick = () => openBranches(button);
  const separator = " ・ ";
  const named = context.label.endsWith(separator + context.branch);
  title.replaceChildren(named ? context.label.slice(0, context.label.length - context.branch.length) : `${context.label}${separator}`, button);
}

// Draws the pane, unless it is what is drawn already.
function draw() {
  const key = JSON.stringify([shown, context, version, [...opened]]);
  if (key === drawn) return;
  drawn = key;
  drawTitle();
  const tree = $("orca-files-tree");
  const top = tree.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.path;
  const typing = document.activeElement?.classList.contains("orca-file-input") === true;
  redrawing = true;
  tree.replaceChildren(...(context === null ? [] : rows("", 0)));
  redrawing = false;
  tree.scrollTop = top;
  if (focused) tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  if (typing) focusField(false);
}

// Follows the selected tab: its worktree (null: none), and the files open in it. Another worktree starts a new tree, read at once while the pane is shown.
export function syncFiles(next: FilesContext | null, open: Set<string>) {
  opened = open;
  const same = next?.path === context?.path && next?.target === context?.target;
  if (!same) {
    generation++;
    listings.clear();
    expanded.clear();
    creating = null;
    version++;
    // A list of branches is of the worktree that was shown.
    closeBranchDialog();
  }
  context = next;
  syncModes();
  draw();
}

export function initOrcaFiles(on: { open: (relative: string) => void; diff: (relative: string) => void; commitDiff: (relative: string, commit: DiffCommit) => void; toggle: () => void; switched: () => void; deleted: (here: FilesContext, relative: string, folder: boolean) => void }) {
  openFile = on.open;
  openDiff = on.diff;
  branchSwitched = on.switched;
  gone = on.deleted;
  initHistory({ open: on.commitDiff });
  $("orca-files-tree").oncontextmenu = openRootMenu;
  $("orca-files-toggle").innerHTML = FOLDER_SVG;
  $("orca-files-toggle").onclick = on.toggle;
  $("orca-files-mode-files").innerHTML = FILE_SVG;
  $("orca-files-mode-files").onclick = () => chooseMode("files");
  $("orca-files-mode-history").innerHTML = BRANCH_SVG;
  $("orca-files-mode-history").onclick = () => chooseMode("history");
}
