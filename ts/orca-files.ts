// The file pane of the Orca screen (A-18): the files of the worktree of the selected tab (with no tab, the main worktree of the selected project), as a tree on the right of the work pane. Rust reads a folder (`orca_files_list`: its entries sorted) and, after it, which of them git ignores (`orca_files_ignored`); this module draws the folder at once, marks the ignored entries when the answer comes, and takes the presses.
// A folder is read the first time it is opened and drawn from what was read after that, and the root and then the open folders are read again, side by side (at most `reads()` at a time), when the window gets the focus back and, while the pane is shown, by the clock of the Orca screen (`refreshFiles`, called by orca.ts), after the app's own create, delete and move, and after a switch of the branch, the app's own or one the list of Orca shows (`syncFiles`). A read by the clock or for a branch that changed outside the app says nothing when it fails (what is shown stays), and the scratchpad folder of an SSH host is never read by the clock. Nothing watches the disk: Orca's `files.watch` is a stream, and this machine's Orca refuses streaming methods (A-12). A file opens in the editor on a double press, and the right button on a row opens the menu that copies its path (and, on a file, downloads it; on a folder, first makes a new file or folder in it, as the right button on the empty part of the tree does in the root; last, after a line, 「移動・名前の変更」, which turns the row into a field with its path from the worktree, and the delete, which asks first and deletes for good, A-18). A row is also moved by dragging it onto a folder's row or onto the empty part of the tree (the root of the worktree). The pane is shown or hidden by the button in its top row while it is shown, and by the button at the right end of the tab strip of the corner pane while it is hidden.
// The tree belongs to one worktree of one target: another tab's worktree gives a new tree (nothing is kept of the old one, and an answer that comes late for the old one is dropped).
// On the row of an SSH host (and on the tab of one of its scratchpad files) the tree is the host's scratchpad folder (A-30): one flat list of files, read by ssh (`ssh_scratch_list`), with the new file, the new name and the delete of that folder (`ssh_scratch_create`, `ssh_scratch_rename`, `ssh_scratch_delete`). It has no folder, so nothing is dragged, and it has no path to copy, no download, no difference, no branch and no history.
// The top row also has the two buttons that choose what the pane shows under the heading, the files or the history of the worktree (A-27, orca-history.ts); the choice is kept in memory only, and the heading serves both, and so do the reads at the return of the focus and by the clock (`refreshFiles`).
import type { OrcaDir } from "./bindings/OrcaDir";
import type { OrcaFileEntry } from "./bindings/OrcaFileEntry";
import { $, composing, tag } from "./dom.js";
import { confirmDelete } from "./hint.js";
import { BRANCH_SVG, CHEVRON_SVG, COPY_PATH_SVG, DELETE_SVG, DIFF_SVG, DOWNLOAD_SVG, FILE_SVG, FOLDER_SVG, MOVE_SVG, OPEN_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { closeBranchDialog, openBranchDialog } from "./orca-branch.js";
import type { DiffCommit } from "./orca-diff.js";
import { checkHistory, initHistory, refreshHistory, reloadHistory, syncHistory } from "./orca-history.js";
import { toast } from "./toast.js";
import { copyText, showError } from "./view.js";

// The worktree shown (the selected tab's, else the selected project's main one), with the name its heading shows ("{repo} ・ {branch}"). `branch` is the git branch of the worktree, which the heading makes a button (A-25), null where it stays text (an SSH host's, a worktree the list does not hold, or one on no branch); `project` is the key of the project of the worktree.
// With `host` (the `id` of an `OrcaSshTarget`) it is the scratchpad folder of that SSH host (A-30) and no worktree: `path` is empty, and the label is the folder.
export interface FilesContext {
  target: string | null;
  path: string;
  label: string;
  project: string;
  branch: string | null;
  host: string | null;
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
// The path being typed for a move or a new name (A-18): the row of `from` is the field. `text` is what is typed (it starts as `from`), `busy` that the move is on its way.
interface Renaming {
  from: string;
  folder: boolean;
  text: string;
  busy: boolean;
}
let renaming: Renaming | null = null;
// Whether a move is on its way (one at a time).
let moving = false;
// The folder a dragged row would be dropped in ("" is the root of the worktree), which is drawn as the place of the drop; null while nothing is dragged over one.
let dropDir: string | null = null;
// A drag starts once the pointer has moved this far from its press, and a closed folder under a dragged row opens after this long.
const DRAG_PX = 5;
const DRAG_OPEN_MS = 600;
// Whether the tree is being replaced: the loss of the field that goes with it is not a blur of the owner.
let redrawing = false;
let openFile: (relative: string) => void = () => {};
let openDiff: (relative: string) => void = () => {};
let branchSwitched: () => void = () => {};
// Told that the list of Orca shows another branch for the worktree than the pane knew (a switch made outside the app): the tabs of its files are read again.
let branchMoved: () => void = () => {};
// The branch the app itself just switched the worktree to: the tree and the history were read for it then, so the list that shows it starts no second read.
let switchedTo: string | null = null;
// Told that the file `relative` (with `folder`, the folder and everything under it) is gone, so the tabs of the editor that hold it close.
let gone: (here: FilesContext, relative: string, folder: boolean) => void = () => {};
// Told that `relative` is about to be moved: the editor holds the saves of the files it takes along, and the function it answers is called when the move is over, with the new place or with null when it failed.
let hold: (here: FilesContext, relative: string) => Promise<(to: string | null) => void> = async () => () => {};
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
  const history = showsHistory();
  // The scratchpad folder of an SSH host has no history, so nothing is chosen there.
  $("orca-files-mode-files").hidden = $("orca-files-mode-history").hidden = context !== null && context.host !== null;
  $("orca-files-tree").hidden = history;
  $("orca-history").hidden = !history;
  $("orca-files-mode-files").setAttribute("aria-pressed", String(!history));
  $("orca-files-mode-history").setAttribute("aria-pressed", String(history));
  syncHistory(context === null || context.host !== null ? null : { target: context.target, path: context.path }, shown && history);
  if (shown && !history && context !== null && !listings.has("")) void readDir("");
}

// Whether the pane shows the history: the choice, except for the scratchpad folder of an SSH host, which has files only.
const showsHistory = () => mode === "history" && (context === null || context.host === null);

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

// Marks the entries of `read`, the folder `dir` as it was listed, that git ignores, and takes the mark off the ones it does not name (`read` may hold the marks of the earlier listing, `readDir`). It is asked after the folder is drawn, and an answer that fails leaves `read` as it is. The answer is dropped when the tree is another worktree's by then, or the folder was read again, and nothing is drawn when it names the entries that are marked already.
async function markIgnored(here: FilesContext, mine: number, dir: string, read: OrcaDir) {
  let paths: string[];
  try {
    paths = await invoke("orca_files_ignored", { path: here.path, paths: read.entries.map((e) => e.path), environment: here.target });
  } catch {
    return;
  }
  const listing = listings.get(dir);
  if (mine !== generation || listing?.dir !== read) return;
  const ignored = new Set(paths);
  if (read.entries.every((e) => e.ignored === ignored.has(e.path))) return;
  listings.set(dir, { ...listing, dir: { ...read, entries: read.entries.map((e) => ({ ...e, ignored: ignored.has(e.path) })) } });
  version++;
  drawSoon();
}

// The entries of the folder `dir`: of the worktree, or (an SSH host's scratchpad, which is one folder of files) the names ssh lists.
async function listDir(here: FilesContext, dir: string, ignored: boolean): Promise<OrcaDir> {
  if (here.host === null) return invoke("orca_files_list", { path: here.path, dir, ignored, environment: here.target });
  const names = await invoke("ssh_scratch_list", { host: here.host });
  return { entries: names.map((name) => ({ name, path: name, isDirectory: false, ignored: false })), total: names.length };
}

// Reads the folder `dir`. With `quiet` (the clock, and a branch that changed outside the app) a read that fails says nothing and keeps what the folder shows, when it was read before. With `clock` (the clock alone) a read that finds the entries held asks no ignore marks.
async function readDir(dir: string, quiet = false, clock = false) {
  const here = context;
  if (here === null) return;
  const mine = generation;
  const held = listings.get(dir);
  // What a folder that the list marked as ignored holds is ignored too, and Rust does not ask git for it.
  const inherited = ignoredDir(dir);
  listings.set(dir, { dir: held?.dir ?? null, error: null, busy: true });
  let next: Listing;
  try {
    const read = await listDir(here, dir, inherited);
    // The entries that the earlier listing marked as ignored keep the mark until the answer of git replaces it, so that a reload does not blink it away.
    const was = new Set(held?.dir?.entries.filter((e) => e.ignored).map((e) => e.path));
    next = { dir: inherited || was.size === 0 ? read : { ...read, entries: read.entries.map((e) => (was.has(e.path) ? { ...e, ignored: true } : e)) }, error: null, busy: false };
  } catch (e) {
    if (quiet && held !== undefined) {
      if (mine === generation && listings.get(dir)?.busy) listings.set(dir, { ...held, busy: false });
      return;
    }
    next = { dir: held?.dir ?? null, error: String(e), busy: false };
  }
  if (mine !== generation) return;
  // A read that finds what is held (the same entries in the same order, and as many in the folder) keeps it, marks and all, and draws nothing.
  const was = held?.dir;
  const now = next.dir;
  if (held?.error === null && next.error === null && was != null && now !== null && was.total === now.total && was.entries.length === now.entries.length && was.entries.every((e, i) => e.path === now.entries[i].path && e.isDirectory === now.entries[i].isDirectory)) {
    next = { ...next, dir: was };
    listings.set(dir, next);
    // The clock does not ask git again for a folder that holds what it held: its marks are asked for at the next read that is not the clock's.
    if (clock) return;
  } else {
    listings.set(dir, next);
    version++;
    drawSoon();
  }
  if (here.host === null && !inherited && next.dir !== null && next.error === null && next.dir.entries.length > 0) void markIgnored(here, mine, dir, next.dir);
}

// How many folders a read of the open folders takes at once, as Orca's own window does: 16 on this machine, 8 on a saved environment (its connection is a paired server's).
const reads = (here: FilesContext) => (here.target === null ? 16 : 8);

// Reads the root, and when it is read the folders that are open again, side by side. The root goes first alone, so that the check of the worktree that its read may start is done once, not once for each folder read at the same time. A folder that was read and is closed is dropped, so that it is read when it is opened next. Another worktree's tree ends it. `quiet` and `clock`: see `readDir`.
async function reload(quiet = false, clock = false) {
  const here = context;
  if (here === null) return;
  const mine = generation;
  const queue = [...expanded];
  for (const dir of [...listings.keys()]) if (dir !== "" && !queue.includes(dir)) listings.delete(dir);
  await readDir("", quiet, clock);
  const worker = async () => {
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      if (mine !== generation) return;
      await readDir(dir, quiet, clock);
    }
  };
  await Promise.all(Array.from({ length: Math.min(queue.length, reads(here)) }, worker));
}

// Reads again what the pane shows, when the window gets the focus back: the files (the root, then the open folders) or the history (from the start). It does nothing while the pane is hidden or has no worktree, and while a read of the same kind is on its way, so a failed read is tried again at the next return.
// With `clock` it is the read of the clock of the Orca screen (A-18, A-27), which says nothing: the tree is drawn again only where a folder changed, the history only when its first commits are not the ones held (`checkHistory`), and a read that fails keeps what is shown. The scratchpad folder of an SSH host (A-30) is never read by the clock.
export function refreshFiles(clock = false) {
  if (!shown || context === null || (clock && context.host !== null)) return;
  if (showsHistory()) {
    if (clock) void checkHistory();
    else refreshHistory();
  } else if (![...listings.values()].some((l) => l.busy)) void reload(clock, clock);
}

// A scratchpad file was made in `.orca/scratchpad` of the worktree at `path` (A-29): when the tree is that worktree's, the folders on the way to it that it has read are read again, the root first, so that a folder that was not there shows now. With `host` the file was made in the scratchpad folder of that SSH host (A-30), and its list is read again when the tree is that folder's.
export function rereadScratchpad(target: string | null, path: string, host: string | null) {
  if (context === null || context.path !== path || context.target !== target || context.host !== host) return;
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
  if (context === null || renaming?.busy) return;
  renaming = null;
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
    // On an SSH host a name that is taken is no error: the file that is there opens (A-30).
    const relative = here.host === null ? await invoke("orca_file_create", { path: here.path, dir: field.dir, name, folder: field.folder, environment: here.target }) : (await invoke("ssh_scratch_create", { host: here.host, name })).name;
    if (mine !== generation) return;
    if (creating === field) {
      creating = null;
      version++;
    }
    await readDir(field.dir);
    draw();
    if (!field.folder && mine === generation) openFile(relative);
  } catch (e) {
    if (mine !== generation) return;
    if (creating === field) creating = null;
    version++;
    draw();
    showError(e);
  }
}

// A row with a field in place of the name: Enter and the loss of the keys inside the window (while the field is still `current`) run `submit`, Escape runs `cancel`. The loss of the keys that comes with the window going to the back runs nothing, and the field stays.
function fieldRow(depth: number, field: { text: string; folder: boolean }, label: string, current: () => boolean, submit: () => unknown, cancel: () => void) {
  const line = tag("div", "orca-file-new");
  line.style.setProperty("--depth", String(depth));
  const input = tag("input", "orca-file-input");
  input.type = "text";
  input.value = field.text;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  input.oninput = () => {
    field.text = input.value;
  };
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  input.onblur = () => {
    if (!redrawing && document.hasFocus() && current()) void submit();
  };
  line.append(tag("span", "orca-file-mark"), icon(field.folder ? FOLDER_SVG : FILE_SVG), input);
  return line;
}

// The row with the field of the name being typed. Leaving the field with a name typed makes it, and with none cancels it.
const createRow = (depth: number, field: Creating) => fieldRow(depth, field, field.folder ? "新しいフォルダーの名前" : "新しいファイルの名前", () => creating === field, submitCreate, cancelCreate);

// The row of the entry that is being moved or named anew: the field holds its path from the worktree. Leaving the field with another path typed moves it, and with the same or none cancels it.
const renameRow = (depth: number, field: Renaming) => fieldRow(depth, field, "移動先のパス", () => renaming === field, submitRename, cancelRename);

// Puts the keys in the field of the name. `scroll` brings it into view (it was just asked for), and `select` is the part of its text that is selected (none: the caret is at the end).
function focusField(scroll: boolean, select?: [number, number]) {
  const input = $("orca-files-tree").querySelector<HTMLInputElement>(".orca-file-input");
  if (input === null) return;
  input.focus({ preventScroll: !scroll });
  input.setSelectionRange(select?.[0] ?? input.value.length, select?.[1] ?? input.value.length);
  if (scroll) input.scrollIntoView({ block: "nearest" });
}

const parentOf = (relative: string) => relative.slice(0, Math.max(0, relative.lastIndexOf("/")));

// Moves the file or folder `from` to `to` (both from the worktree; Orca's `files.rename`, which overwrites nothing, so a taken place is Rust's error). The editor holds the saves of the open files it takes along until the answer comes, and they follow to the new place. After it what was read of a moved folder is dropped (its open folders stay open at the new place and are read there), and the folder it left and the one it went to are read again: of the target, the nearest folder that was read, so that a folder made on the way shows. The folder it left is read first, alone, and the others side by side, as `reload` does. A worktree that is not the tree's any more only moves the tabs.
async function move(here: FilesContext, from: string, to: string, folder: boolean) {
  if (moving) return;
  moving = true;
  const mine = generation;
  try {
    const release = await hold(here, from);
    try {
      if (here.host === null) await invoke("orca_file_move", { path: here.path, from, to, environment: here.target });
      else await invoke("ssh_scratch_rename", { host: here.host, from, to });
    } catch (e) {
      release(null);
      if (mine === generation) showError(e);
      return;
    }
    release(to);
  } finally {
    moving = false;
  }
  if (mine !== generation) return;
  const under = (path: string) => path === from || path.startsWith(`${from}/`);
  const reopened: string[] = [];
  if (folder) {
    for (const path of [...listings.keys()]) if (under(path)) listings.delete(path);
    for (const path of [...expanded].filter(under)) {
      expanded.delete(path);
      expanded.add(to + path.slice(from.length));
      reopened.push(to + path.slice(from.length));
    }
    if (creating !== null && under(creating.dir)) creating = null;
  }
  let target = parentOf(to);
  while (target !== "" && !listings.has(target)) target = parentOf(target);
  const [first, ...queue] = new Set([parentOf(from), target, ...reopened]);
  await readDir(first);
  const worker = async () => {
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      if (mine !== generation) return;
      await readDir(dir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(queue.length, reads(here)) }, worker));
}

// Turns the row of `relative` into the field of its path from the worktree, with the name selected (a file's without its extension).
function startRename(relative: string, folder: boolean) {
  if (context === null || creating?.busy || renaming?.busy) return;
  creating = null;
  renaming = { from: relative, folder, text: relative, busy: false };
  version++;
  draw();
  const start = relative.lastIndexOf("/") + 1;
  const dot = relative.lastIndexOf(".");
  focusField(true, [start, folder || dot <= start ? relative.length : dot]);
}

function cancelRename() {
  if (renaming === null || renaming.busy) return;
  renaming = null;
  version++;
  draw();
}

// Moves the entry to the path of the field. A blank path and the path it has are a cancel. Rust checks the path; the field goes when the answer comes, and a failure is shown. While another move (a drag's) is on its way nothing is asked and the field stays.
async function submitRename() {
  const here = context;
  const field = renaming;
  if (here === null || field === null || field.busy) return;
  const to = field.text.trim();
  if (to === "" || to === field.from) return cancelRename();
  if (moving) return;
  field.busy = true;
  await move(here, field.from, to, field.folder);
  if (renaming !== field) return;
  renaming = null;
  version++;
  draw();
}

// The folder a row dragged from `from` would go to at `at`, the element under the pointer: the folder of the row under it, or the root of the worktree on the part of the tree with no row. Null where nothing is dropped: outside the tree, on a file's row, on the folder the entry is in already, on itself and inside itself.
function dropAt(at: Element | null, from: string) {
  if (at === null || !$("orca-files-tree").contains(at)) return null;
  const over = at.closest<HTMLElement>(".orca-file");
  if (over !== null && over.dataset.kind !== "dir") return null;
  const dir = over?.dataset.path ?? "";
  return dir === parentOf(from) || dir === from || dir.startsWith(`${from}/`) ? null : dir;
}

// Marks the folder of the drop: its row, or the tree for the root of the worktree.
function showDrop(dir: string | null) {
  if (dir === dropDir) return;
  dropDir = dir;
  const tree = $("orca-files-tree");
  for (const marked of tree.querySelectorAll("[data-drop]")) marked.removeAttribute("data-drop");
  if (dir === "") tree.dataset.drop = "true";
  else delete tree.dataset.drop;
  if (dir) tree.querySelector<HTMLElement>(`.orca-file[data-path="${CSS.escape(dir)}"]`)?.setAttribute("data-drop", "true");
}

// A press on a row that moves past a few pixels drags the entry (A-18): its name follows the pointer, the folder it would go to is marked, and a closed folder the pointer rests on opens. The release moves it into the marked folder, and does nothing elsewhere; Escape or a cancel ends the drag.
function startDrag(down: PointerEvent, entry: OrcaFileEntry) {
  const here = context;
  // The scratchpad of an SSH host has no folder to drop a row in.
  if (down.button !== 0 || here === null || here.host !== null || moving) return;
  const mine = generation;
  let ghost: HTMLElement | null = null;
  let rest: { dir: string; timer: number } | null = null;
  const unrest = () => {
    if (rest !== null) clearTimeout(rest.timer);
    rest = null;
  };
  const end = () => {
    document.removeEventListener("pointermove", moved);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", end);
    document.removeEventListener("keydown", key);
    document.body.classList.remove("orca-dragging");
    unrest();
    ghost?.remove();
    showDrop(null);
  };
  const moved = (e: PointerEvent) => {
    if (mine !== generation) return end();
    if (ghost === null) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_PX) return;
      ghost = tag("div", "orca-file-drag", entry.name);
      document.body.append(ghost);
      document.body.classList.add("orca-dragging");
    }
    Object.assign(ghost.style, { left: `${e.clientX + 10}px`, top: `${e.clientY + 8}px` });
    const at = document.elementFromPoint(e.clientX, e.clientY);
    showDrop(dropAt(at, entry.path));
    // A closed folder under the pointer (not the dragged one or one inside it) opens when the pointer stays on it.
    const over = at?.closest<HTMLElement>('#orca-files-tree .orca-file[data-kind="dir"][aria-expanded="false"]');
    const dir = over?.dataset.path;
    if (dir === undefined || dir === entry.path || dir.startsWith(`${entry.path}/`)) return unrest();
    if (rest?.dir === dir) return;
    unrest();
    rest = {
      dir,
      timer: window.setTimeout(() => {
        rest = null;
        if (mine === generation && !expanded.has(dir)) expandDir(dir);
      }, DRAG_OPEN_MS),
    };
  };
  const up = (e: PointerEvent) => {
    const dragged = ghost !== null;
    end();
    if (!dragged) return;
    // The click that follows the release would open or close the folder under it.
    const swallow = (c: Event) => c.stopPropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    const dir = mine === generation ? dropAt(document.elementFromPoint(e.clientX, e.clientY), entry.path) : null;
    if (dir !== null) void move(here, entry.path, dir === "" ? entry.name : `${dir}/${entry.name}`, entry.isDirectory);
  };
  const key = (e: KeyboardEvent) => e.key === "Escape" && end();
  document.addEventListener("pointermove", moved);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", end);
  document.addEventListener("keydown", key);
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

// Opens the HTML file in the default browser of this PC (A-31): Rust serves the worktree and hands the address to the system, so nothing is said when it works (the browser comes to the front).
const openInBrowser = (here: FilesContext, relative: string) => invoke("orca_file_open_in_browser", { path: here.path, relative, environment: here.target }).catch(showError);

// Deletes the file or folder for good (Orca's `files.delete`, which skips the Trash) once the confirmation has been answered. It is gone from the editor and the tree after: a folder's reads are dropped, and the folder it was in is read again. A worktree that is not the tree's any more only closes the tabs.
async function remove(here: FilesContext, relative: string, folder: boolean) {
  const mine = generation;
  try {
    if (here.host === null) await invoke("orca_file_delete", { path: here.path, relative, folder, environment: here.target });
    else await invoke("ssh_scratch_delete", { host: here.host, name: relative });
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
  await readDir(parentOf(relative));
}

const menuItem = (label: string, icon: string, pick: () => unknown) => ({ label, color: "var(--accent)", icon, current: false, pick });

// The two items that make a new file or folder in the folder `dir` (the empty one is the worktree's root). The scratchpad of an SSH host holds files only, so it has the first alone.
const createItems = (dir: string) => [menuItem("新規ファイル", FILE_SVG, () => startCreate(dir, false)), ...(context?.host == null ? [menuItem("新規フォルダー", FOLDER_SVG, () => startCreate(dir, true))] : [])];

// A file of the scratchpad of an SSH host (A-30) has the new file and, after a line, 「移動・名前の変更」 and the delete: there is no path to copy, no download and no difference there.
// The menu of a row (the right button): on a folder the new file and folder and then, after a line, the copies; on a file the path of the entry on the machine of the worktree, its path from the worktree, the download, the difference from HEAD (A-24) and, when its name ends with `.html` (whatever the case; Rust refuses any other name), 「ブラウザで開く」 (A-31); and on both, last and after a line, 「移動・名前の変更」 and the delete in red. The menu sets and removes aria-expanded on its anchor, so the anchor is the row's name, not the row, whose own aria-expanded is the state of its folder.
function openRowMenu(anchor: Element, relative: string, isDirectory: boolean) {
  const here = context;
  if (here === null) return;
  const copy = (label: string, text: string, done: string) => menuItem(label, COPY_PATH_SVG, () => void copyText(text, done));
  const del = { ...menuItem("削除", DELETE_SVG, () => confirmDelete(anchor, relative.slice(relative.lastIndexOf("/") + 1), () => void remove(here, relative, isDirectory))), danger: true };
  const rename = { ...menuItem("移動・名前の変更", MOVE_SVG, () => startRename(relative, isDirectory)), divider: true };
  if (here.host !== null) return openMenu(anchor, [...createItems(""), rename, del]);
  const [path, from] = [copy("パスのコピー", `${here.path.replace(/\/+$/, "")}/${relative}`, "パスをコピーしました"), copy("相対パスをコピー", relative, "相対パスをコピーしました")];
  if (isDirectory) openMenu(anchor, [...createItems(relative), { ...path, divider: true }, from, rename, del]);
  else openMenu(anchor, [path, from, menuItem("ダウンロード", DOWNLOAD_SVG, () => void download(here, relative)), menuItem("差分を表示", DIFF_SVG, () => openDiff(relative)), ...(/\.html$/i.test(relative) ? [menuItem("ブラウザで開く", OPEN_SVG, () => void openInBrowser(here, relative))] : []), rename, del]);
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
  if (entry.isDirectory && dropDir === entry.path) button.dataset.drop = "true";
  button.onpointerdown = (e) => startDrag(e, entry);
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
    nodes.push(renaming?.from === entry.path ? renameRow(depth, renaming) : row(entry, depth));
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
  openBranchDialog(anchor, { target: here.target, path: here.path, repo: here.project, branch: here.branch }, (branch) => {
    switchedTo = branch;
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
  // The field that has the keys gets them back in the new tree, with what was selected in it.
  const field = document.activeElement;
  const typing: [number, number] | null = field instanceof HTMLInputElement && field.classList.contains("orca-file-input") ? [field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length] : null;
  redrawing = true;
  tree.replaceChildren(...(context === null ? [] : rows("", 0)));
  redrawing = false;
  tree.scrollTop = top;
  if (focused) tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  if (typing) focusField(false, typing);
}

// Follows the selected tab: its worktree (null: none), and the files open in it. Another worktree starts a new tree, read at once while the pane is shown.
// The same worktree on another git branch than the pane knew (the list of Orca says so: a switch made outside the app) has its tree and its history read again at once while the pane is shown, without a word, and the screen is told (`branchMoved`); the branch the app itself switched to was read already.
export function syncFiles(next: FilesContext | null, open: Set<string>) {
  opened = open;
  const same = next?.path === context?.path && next?.target === context?.target && next?.host === context?.host;
  const moved = same && next != null && context != null && next.host === null && next.branch !== null && context.branch !== null && next.branch !== context.branch;
  if (!same) {
    switchedTo = null;
    generation++;
    listings.clear();
    expanded.clear();
    creating = null;
    renaming = null;
    version++;
    // A list of branches is of the worktree that was shown.
    closeBranchDialog();
  }
  context = next;
  syncModes();
  draw();
  if (!moved) return;
  const own = next?.branch === switchedTo;
  switchedTo = null;
  if (own || !shown) return;
  if (![...listings.values()].some((l) => l.busy)) void reload(true);
  refreshHistory();
  branchMoved();
}

export function initOrcaFiles(on: { open: (relative: string) => void; diff: (relative: string) => void; commitDiff: (relative: string, commit: DiffCommit) => void; toggle: () => void; switched: () => void; moved: () => void; deleted: (here: FilesContext, relative: string, folder: boolean) => void; moving: (here: FilesContext, relative: string) => Promise<(to: string | null) => void> }) {
  openFile = on.open;
  openDiff = on.diff;
  branchSwitched = on.switched;
  branchMoved = on.moved;
  gone = on.deleted;
  hold = on.moving;
  initHistory({ open: on.commitDiff });
  $("orca-files-tree").oncontextmenu = openRootMenu;
  $("orca-files-toggle").innerHTML = FOLDER_SVG;
  $("orca-files-toggle").onclick = on.toggle;
  $("orca-files-mode-files").innerHTML = FILE_SVG;
  $("orca-files-mode-files").onclick = () => chooseMode("files");
  $("orca-files-mode-history").innerHTML = BRANCH_SVG;
  $("orca-files-mode-history").onclick = () => chooseMode("history");
}
