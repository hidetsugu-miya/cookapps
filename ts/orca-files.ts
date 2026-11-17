// The file pane of the Orca screen (A-18): the files of the worktree of the selected tab (with no tab, the main worktree of the selected project), as a tree on the right of the work pane. Rust reads a folder (`orca_files_list`: its entries sorted) and, after it, which of them git ignores (`orca_files_ignored`) and which differ from HEAD (`orca_files_changes`, A-39); this module draws the folder at once, marks the ignored and the changed entries when the answers come, and takes the presses.
// A folder is read the first time it is opened and drawn from what was read after that, and the root and then the open folders are read again, side by side (at most `reads()` at a time), when the window gets the focus back and, while the pane is shown, by the clock of the Orca screen (`refreshFiles`, called by orca.ts), after the app's own create, delete and move, and after a switch of the branch, the app's own or one the list of Orca shows (`syncFiles`). A read by the clock or for a branch that changed outside the app says nothing when it fails (what is shown stays). Nothing watches the disk: Orca's `files.watch` is a stream, and this machine's Orca refuses streaming methods (A-12). A press on a row selects it (with ⌘ it adds the row to the selection or takes it off, with Shift it selects the rows from the one pressed before), and the selected rows are drawn in the accent color. A file opens in the editor on a double press, and the right button on a row opens the menu that copies its path (and, on a file, downloads it; on a folder, first makes a new file or folder in it, as the right button on the empty part of the tree does in the root; last, after a line, 「移動・名前の変更」, which turns the row into a field with its path from the worktree, and the delete, which asks first and deletes for good, A-18; on several selected rows the menu is the delete alone, as the Delete key is, A-18). A row is also moved by dragging it onto a folder's row or onto the empty part of the tree (the root of the worktree). The pane is shown or hidden by the button in its top row while it is shown, and by the button at the right end of the tab strip of the corner pane while it is hidden.
// The tree belongs to one worktree of one target: another tab's worktree gives a new tree (nothing is kept of the old one, and an answer that comes late for the old one is dropped).
// The top row also has the three buttons that choose what the pane shows under the heading, the files, the history of the worktree (A-27, orca-history.ts) or the definition of a name of the editor (A-34, orca-definition.ts, with the language server under it, orca-lsp.ts); the choice is kept in memory only, and the heading serves all, and so do the reads at the return of the focus and by the clock (`refreshFiles`), which the definition has none of.
import type { OrcaDeleteEntry } from "./bindings/OrcaDeleteEntry";
import type { OrcaDeleted } from "./bindings/OrcaDeleted";
import type { OrcaDir } from "./bindings/OrcaDir";
import type { OrcaFileEntry } from "./bindings/OrcaFileEntry";
import type { OrcaGitChange } from "./bindings/OrcaGitChange";
import type { OrcaGitMark } from "./bindings/OrcaGitMark";
import { $, composing, tag } from "./dom.js";
import { confirmDelete, confirmDeleteMany } from "./hint.js";
import { BRANCH_SVG, CHEVRON_SVG, COPY_PATH_SVG, DEFINITION_SVG, DELETE_SVG, DIFF_SVG, DOWNLOAD_SVG, FILE_SVG, FOLDER_SVG, MOVE_SVG, OPEN_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { closeBranchDialog, openBranchDialog } from "./orca-branch.js";
import { askDefinition, type DefinitionQuery, initDefinition, syncDefinition } from "./orca-definition.js";
import type { DiffCommit } from "./orca-diff.js";
import { checkHistory, initHistory, refreshHistory, reloadHistory, syncHistory } from "./orca-history.js";
import { syncLsp } from "./orca-lsp.js";
import { toast } from "./toast.js";
import { copyText, showError } from "./view.js";

// The worktree shown (the selected tab's, else the selected project's main one), with the name its heading shows ("{repo} ・ {branch}"). `branch` is the git branch of the worktree, which the heading makes a button (A-25), null where it stays text (a worktree the list does not hold, or one on no branch); `project` is the key of the project of the worktree.
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
let mode: "files" | "history" | "definition" = "files";
let context: FilesContext | null = null;
// A new tree (another worktree) ends the reads of the old one.
let generation = 0;
const listings = new Map<string, Listing>();
// How git sees the entries that differ from HEAD (A-39), by path from the worktree. It outlives the listings, so a read again keeps the marks until the answer replaces them. `asked` counts the questions of each folder, so that only the last answer is taken.
const changes = new Map<string, OrcaGitMark>();
const asked = new Map<string, number>();
const expanded = new Set<string>();
// The rows that are selected (A-18), by path from the worktree, with whether each is a folder, in the order they were selected; and the row a Shift press counts from (the last one pressed without Shift). A row that is not drawn any more (its folder closed, or it is gone) leaves the selection, so what is deleted is what is drawn selected.
const selected = new Map<string, boolean>();
let anchor: string | null = null;
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
// Told that the entries `deleted` (each a file, or with `folder` the folder and everything under it) are gone, so the tabs of the editor that hold them close, and the screen is drawn once.
let gone: (here: FilesContext, deleted: OrcaDeleteEntry[]) => void = () => {};
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

// Shows the part of the pane that is chosen, and starts the read of it that is due: the history is read only while it is shown, the root of the tree only while the files are, and the definition is asked only by the editor.
function syncModes() {
  const part = shownPart();
  $("orca-files-tree").hidden = part !== "files";
  $("orca-history").hidden = part !== "history";
  $("orca-definition").hidden = part !== "definition";
  for (const [name, button] of [["files", "orca-files-mode-files"], ["history", "orca-files-mode-history"], ["definition", "orca-files-mode-definition"]] as const) $(button).setAttribute("aria-pressed", String(part === name));
  syncHistory(context === null ? null : { target: context.target, path: context.path }, shown && part === "history");
  syncDefinition(context === null ? null : { target: context.target, path: context.path });
  syncLsp(context === null ? null : { target: context.target, project: context.project, path: context.path }, shown && part === "definition");
  if (shown && part === "files" && context !== null && !listings.has("")) void readDir("");
}

// The part of the pane that is shown: the choice.
const shownPart = () => mode;
const showsHistory = () => shownPart() === "history";

function chooseMode(next: "files" | "history" | "definition") {
  if (mode === next) return;
  mode = next;
  syncModes();
}

// The editor asked for a definition (A-34): the pane shows it, and asks. The screen has shown the pane before.
export function showDefinition(q: DefinitionQuery) {
  mode = "definition";
  syncModes();
  void askDefinition(q);
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

// Takes the marks of the entries of `read`, the folder `dir` as it was listed, from `orca_files_changes` (A-39): an entry the answer does not name loses its mark. It is asked after the folder is drawn, and an answer that fails leaves the marks as they are. Only the last question of a folder is answered, and an answer that comes after the tree became another worktree's, or the folder was dropped, is dropped. Nothing is drawn when the marks are the ones shown.
async function markChanges(here: FilesContext, mine: number, dir: string, read: OrcaDir) {
  const token = (asked.get(dir) ?? 0) + 1;
  asked.set(dir, token);
  let answer: OrcaGitChange[];
  try {
    answer = await invoke("orca_files_changes", { path: here.path, paths: read.entries.map((e) => e.path), environment: here.target });
  } catch {
    return;
  }
  if (mine !== generation || asked.get(dir) !== token || !listings.has(dir)) return;
  const now = new Map(answer.map((c) => [c.path, c.mark]));
  let moved = false;
  for (const e of read.entries) {
    const mark = now.get(e.path);
    if (changes.get(e.path) === mark) continue;
    moved = true;
    if (mark === undefined) changes.delete(e.path);
    else changes.set(e.path, mark);
  }
  if (!moved) return;
  version++;
  drawSoon();
}

// The entries of the folder `dir` of the worktree.
const listDir = (here: FilesContext, dir: string, ignored: boolean): Promise<OrcaDir> => invoke("orca_files_list", { path: here.path, dir, ignored, environment: here.target });

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
  const same = held?.error === null && next.error === null && was != null && now !== null && was.total === now.total && was.entries.length === now.entries.length && was.entries.every((e, i) => e.path === now.entries[i].path && e.isDirectory === now.entries[i].isDirectory);
  if (same) {
    next = { ...next, dir: was };
    listings.set(dir, next);
  } else {
    listings.set(dir, next);
    version++;
    drawSoon();
  }
  if (inherited || next.dir === null || next.error !== null || next.dir.entries.length === 0) return;
  // The differences from HEAD can change with no change of the entries (a file is edited), so the clock asks for them too.
  void markChanges(here, mine, dir, next.dir);
  // The clock does not ask git again for the ignore marks of a folder that holds what it held: they are asked for at the next read that is not the clock's.
  if (!(same && clock)) void markIgnored(here, mine, dir, next.dir);
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
// With `clock` it is the read of the clock of the Orca screen (A-18, A-27), which says nothing: the tree is drawn again only where a folder changed, the history only when its first commits are not the ones held (`checkHistory`), and a read that fails keeps what is shown.
export function refreshFiles(clock = false) {
  if (!shown || context === null) return;
  if (shownPart() === "definition") return;
  if (showsHistory()) {
    if (clock) void checkHistory();
    else refreshHistory();
  } else if (![...listings.values()].some((l) => l.busy)) void reload(clock, clock);
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
    const relative = await invoke("orca_file_create", { path: here.path, dir: field.dir, name, folder: field.folder, environment: here.target });
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
      await invoke("orca_file_move", { path: here.path, from, to, environment: here.target });
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
  if (down.button !== 0 || here === null || moving) return;
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

// Deletes the files and folders for good (Orca's `files.delete`, which skips the Trash) once the confirmation has been answered. What is gone leaves the editor and the tree: a folder's reads are dropped, and the folders they were in are read again, side by side. Where one entry fails Rust stops there, so what was deleted before it is drawn as gone and the message is shown. A worktree that is not the tree's any more only closes the tabs.
async function remove(here: FilesContext, entries: OrcaDeleteEntry[]) {
  const mine = generation;
  let answer: OrcaDeleted;
  try {
    answer = await invoke("orca_files_delete", { path: here.path, entries, environment: here.target });
  } catch (e) {
    if (mine === generation) showError(e);
    return;
  }
  // The message comes first: closing a tab may show another worktree's tree, which is a new tree.
  if (mine === generation && answer.error !== null) showError(answer.error);
  gone(here, answer.deleted);
  if (mine !== generation) return;
  for (const { relative, folder } of answer.deleted) {
    if (!folder) continue;
    const under = (path: string) => path === relative || path.startsWith(`${relative}/`);
    for (const path of [...listings.keys()]) if (under(path)) listings.delete(path);
    for (const path of [...expanded]) if (under(path)) expanded.delete(path);
    if (creating !== null && under(creating.dir)) creating = null;
  }
  const queue = [...new Set(answer.deleted.map((d) => parentOf(d.relative)))].filter((dir) => dir === "" || listings.has(dir));
  const worker = async () => {
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      if (mine !== generation) return;
      await readDir(dir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(queue.length, reads(here)) }, worker));
}

// The rows drawn now, in the order of the tree.
const drawnRows = () => [...$("orca-files-tree").querySelectorAll<HTMLElement>(".orca-file")].map((e) => ({ path: e.dataset.path ?? "", folder: e.dataset.kind === "dir" }));

// Marks the drawn rows of the selection.
function paintSelection() {
  for (const node of $("orca-files-tree").querySelectorAll<HTMLElement>(".orca-file")) node.dataset.selected = String(selected.has(node.dataset.path ?? ""));
}

// Selects by a press on a row (A-18): ⌘ adds the row or takes it off, Shift selects the rows from the anchor to this one (when the anchor is still drawn), and a press with neither selects this row alone. A Shift press keeps the anchor.
function select(entry: OrcaFileEntry, e: MouseEvent) {
  const rows = drawnRows();
  const from = anchor === null ? -1 : rows.findIndex((r) => r.path === anchor);
  const to = rows.findIndex((r) => r.path === entry.path);
  if (e.shiftKey && from !== -1 && to !== -1) {
    selected.clear();
    for (const r of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.set(r.path, r.folder);
  } else if (e.metaKey || e.ctrlKey) {
    if (!selected.delete(entry.path)) selected.set(entry.path, entry.isDirectory);
    anchor = entry.path;
  } else {
    selected.clear();
    selected.set(entry.path, entry.isDirectory);
    anchor = entry.path;
  }
  paintSelection();
}

// Asks before the selected rows are deleted, in the popup under `anchor`: by the name of the row when it is one, by the count when there are more (A-18).
function askDelete(anchor: Element) {
  const here = context;
  const entries = [...selected].map(([relative, folder]) => ({ relative, folder }));
  if (here === null || entries.length === 0) return;
  const done = () => void remove(here, entries);
  if (entries.length === 1) confirmDelete(anchor, entries[0].relative.slice(entries[0].relative.lastIndexOf("/") + 1), done);
  else confirmDeleteMany(anchor, entries.length, done);
}

// The Delete key (and the key that is called delete on a Mac keyboard) on the tree asks to delete the selected rows, under the row that was pressed last. A field of the tree takes its own keys.
function deleteKey(e: KeyboardEvent) {
  if ((e.key !== "Delete" && e.key !== "Backspace") || e.target instanceof HTMLInputElement || composing(e) || selected.size === 0) return;
  const path = anchor !== null && selected.has(anchor) ? anchor : [...selected.keys()][0];
  const name = $("orca-files-tree").querySelector(`.orca-file[data-path="${CSS.escape(path)}"] .orca-file-name`);
  if (name === null) return;
  e.preventDefault();
  askDelete(name);
}

const menuItem = (label: string, icon: string, pick: () => unknown) => ({ label, color: "var(--accent)", icon, current: false, pick });

// The two items that make a new file or folder in the folder `dir` (the empty one is the worktree's root).
const createItems = (dir: string) => [menuItem("新規ファイル", FILE_SVG, () => startCreate(dir, false)), menuItem("新規フォルダー", FOLDER_SVG, () => startCreate(dir, true))];

// The menu of a row (the right button): on a folder the new file and folder and then, after a line, the copies; on a file the path of the entry on the machine of the worktree, its path from the worktree, the download, the difference from HEAD (A-24) and, when its name ends with `.html` (whatever the case; Rust refuses any other name), 「ブラウザで開く」 (A-31); and on both, last and after a line, 「移動・名前の変更」 and the delete in red. The menu sets and removes aria-expanded on its anchor, so the anchor is the row's name, not the row, whose own aria-expanded is the state of its folder.
function openRowMenu(anchor: Element, relative: string, isDirectory: boolean) {
  const here = context;
  if (here === null) return;
  const copy = (label: string, text: string, done: string) => menuItem(label, COPY_PATH_SVG, () => void copyText(text, done));
  const del = { ...menuItem(selected.size > 1 ? `${selected.size} 件を削除` : "削除", DELETE_SVG, () => askDelete(anchor)), danger: true };
  // Several rows are selected: the menu is the delete of them, since the other items are of one row.
  if (selected.size > 1) return openMenu(anchor, [del]);
  const rename = { ...menuItem("移動・名前の変更", MOVE_SVG, () => startRename(relative, isDirectory)), divider: true };
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
  button.dataset.selected = String(selected.has(entry.path));
  button.oncontextmenu = (e) => {
    e.preventDefault();
    // The right button on a row that is not selected selects it alone, as on one that is selected it keeps the selection.
    if (!selected.has(entry.path)) {
      selected.clear();
      selected.set(entry.path, entry.isDirectory);
      anchor = entry.path;
      paintSelection();
    }
    openRowMenu(name, entry.path, entry.isDirectory);
  };
  // A press selects the row, and a press with neither ⌘ nor Shift on a folder opens or closes it too. The row takes the keys (WKWebView does not focus a button on a press), so the Delete key reaches the tree.
  button.onclick = (e) => {
    button.focus({ preventScroll: true });
    select(entry, e);
    if (entry.isDirectory && !e.metaKey && !e.ctrlKey && !e.shiftKey) toggleDir(entry.path);
  };
  const mark = tag("span", "orca-file-mark");
  if (entry.isDirectory) {
    const open = expanded.has(entry.path);
    button.setAttribute("aria-expanded", String(open));
    mark.innerHTML = CHEVRON_SVG;
    button.append(mark, icon(FOLDER_SVG));
  } else {
    button.dataset.open = String(opened.has(entry.path));
    button.append(mark, icon(FILE_SVG));
    // A file opens on a double press (or Enter), so a single press only selects it.
    button.ondblclick = () => openFile(entry.path);
    button.onkeydown = (e) => {
      if (e.key === "Enter") openFile(entry.path);
    };
  }
  button.append(name);
  // A change from HEAD (A-39): the name and the icon take the color, and the right end has `M` or `U` on a file and a dot on a folder.
  const change = changes.get(entry.path);
  if (change !== undefined) {
    button.dataset.change = change;
    button.append(tag("span", "orca-file-git", entry.isDirectory ? "" : change === "new" ? "U" : "M"));
  }
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
  const present = new Set(drawnRows().map((r) => r.path));
  for (const path of [...selected.keys()]) if (!present.has(path)) selected.delete(path);
  if (anchor !== null && !present.has(anchor)) anchor = null;
  if (focused) tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  if (typing) focusField(false, typing);
}

// Follows the selected tab: its worktree (null: none), and the files open in it. Another worktree starts a new tree, read at once while the pane is shown.
// The same worktree on another git branch than the pane knew (the list of Orca says so: a switch made outside the app) has its tree and its history read again at once while the pane is shown, without a word, and the screen is told (`branchMoved`); the branch the app itself switched to was read already.
export function syncFiles(next: FilesContext | null, open: Set<string>) {
  opened = open;
  const same = next?.path === context?.path && next?.target === context?.target;
  const moved = same && next != null && context != null && next.branch !== null && context.branch !== null && next.branch !== context.branch;
  if (!same) {
    switchedTo = null;
    generation++;
    listings.clear();
    expanded.clear();
    changes.clear();
    asked.clear();
    creating = null;
    renaming = null;
    selected.clear();
    anchor = null;
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

export function initOrcaFiles(on: { open: (relative: string) => void; definition: { inside: (relative: string, line: number, character: number) => void; outside: (path: string, line: number, character: number) => void }; diff: (relative: string) => void; commitDiff: (relative: string, commit: DiffCommit) => void; toggle: () => void; switched: () => void; moved: () => void; deleted: (here: FilesContext, deleted: OrcaDeleteEntry[]) => void; moving: (here: FilesContext, relative: string) => Promise<(to: string | null) => void> }) {
  openFile = on.open;
  openDiff = on.diff;
  branchSwitched = on.switched;
  branchMoved = on.moved;
  gone = on.deleted;
  hold = on.moving;
  initHistory({ open: on.commitDiff });
  initDefinition(on.definition);
  $("orca-files-tree").oncontextmenu = openRootMenu;
  $("orca-files-tree").onkeydown = deleteKey;
  $("orca-files-toggle").innerHTML = FOLDER_SVG;
  $("orca-files-toggle").onclick = on.toggle;
  $("orca-files-mode-files").innerHTML = FILE_SVG;
  $("orca-files-mode-files").onclick = () => chooseMode("files");
  $("orca-files-mode-history").innerHTML = BRANCH_SVG;
  $("orca-files-mode-history").onclick = () => chooseMode("history");
  $("orca-files-mode-definition").innerHTML = DEFINITION_SVG;
  $("orca-files-mode-definition").onclick = () => chooseMode("definition");
}
