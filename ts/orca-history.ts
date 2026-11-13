// The history of the file pane of the Orca screen (A-27): the commits of the worktree the pane shows, from HEAD, the newest first, with the files of the chosen commit under them. Rust reads the commits (`orca_git_history`) and the files of one (`orca_commit_files`); this module draws them, reads the next commits when the list is scrolled to its end, and gives the screen a file to open as a diff tab (A-24) on a double press.
// The list belongs to one worktree of one target: another worktree gives a new list (nothing is kept of the old one, and an answer that comes late for the old one is dropped). It is read only while the history is the part of the pane that is shown, and the reload button (and a switch of the branch) reads it again from the start. Nothing is kept outside memory.
import type { OrcaCommit } from "./bindings/OrcaCommit";
import type { OrcaCommitFile } from "./bindings/OrcaCommitFile";
import type { OrcaCommitFiles } from "./bindings/OrcaCommitFiles";
import { $, tag } from "./dom.js";
import { formatDate } from "./format.js";
import { invoke } from "./ipc.js";
import type { DiffCommit } from "./orca-diff.js";

export interface HistoryContext {
  target: string | null;
  path: string;
}

// How many commits one read takes.
const PAGE = 50;
// How near the end of the list (px) the next read starts.
const NEAR_END = 80;
const STATUS_MARKS = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C" };

// What was read of the files of the chosen commit.
interface Changed {
  id: string;
  read: "loading" | "ready" | "failed";
  data: OrcaCommitFiles | null;
  error: string | null;
}

let context: HistoryContext | null = null;
let active = false;
// A new list (another worktree, or a read from the start) ends the reads of the old one.
let generation = 0;
let commits: OrcaCommit[] = [];
let hasMore = false;
let error: string | null = null;
let busy = false;
// Whether the first commits were asked for (the reload button asks again).
let started = false;
let selected: string | null = null;
let changed: Changed | null = null;
// The path of the file row pressed once.
let picked: string | null = null;
let openFile: (relative: string, commit: DiffCommit) => void = () => {};

function reset() {
  generation++;
  commits = [];
  hasMore = false;
  error = null;
  busy = false;
  started = false;
  selected = null;
  changed = null;
  picked = null;
}

function note(text: string, fail = false) {
  return tag("p", `orca-file-note${fail ? " fail" : ""}`, text);
}

function loading() {
  const line = tag("div", "pending");
  line.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
  return line;
}

function commitRow(commit: OrcaCommit) {
  const button = tag("button", "orca-commit");
  button.type = "button";
  button.dataset.id = commit.id;
  button.title = commit.author;
  button.setAttribute("aria-pressed", String(commit.id === selected));
  const meta = tag("span", "orca-commit-meta");
  meta.append(tag("span", "orca-commit-id", commit.shortId), tag("span", "orca-commit-time", formatDate(commit.timeMs)));
  button.append(tag("span", "orca-commit-subject", commit.subject), meta);
  button.onclick = () => select(commit.id);
  return button;
}

function fileRow(file: OrcaCommitFile, commit: OrcaCommit, parentId: string | null) {
  const button = tag("button", "orca-hfile");
  button.type = "button";
  button.dataset.path = file.path;
  button.dataset.status = file.status;
  button.title = file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`;
  button.setAttribute("aria-pressed", String(file.path === picked));
  const slash = file.path.lastIndexOf("/");
  const mark = tag("span", "orca-hfile-st", STATUS_MARKS[file.status]);
  const count = tag("span", "orca-hfile-n");
  // A binary file has no count of lines.
  if (file.added !== null) count.append(tag("span", "orca-hfile-add", `+${file.added}`));
  if (file.removed !== null) count.append(tag("span", "orca-hfile-del", `−${file.removed}`));
  button.append(mark, tag("span", "orca-hfile-name", file.path.slice(slash + 1)), tag("span", "orca-hfile-dir", slash < 0 ? "" : file.path.slice(0, slash)), count);
  const open = () => openFile(file.path, { id: commit.id, shortId: commit.shortId, parentId, oldRelative: file.oldPath });
  button.onclick = () => {
    picked = file.path;
    draw();
  };
  // A file opens on a double press (or Enter), as in the tree of the files (A-18).
  button.ondblclick = open;
  button.onkeydown = (e) => {
    if (e.key === "Enter") open();
  };
  return button;
}

// Draws the list and the files under it, keeping the scroll of both and the focus.
function draw() {
  const list = $("orca-history-list");
  const under = $("orca-history-files");
  const tops = [list.scrollTop, under.scrollTop];
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#orca-history [data-id], #orca-history [data-path]");
  const nodes: HTMLElement[] = commits.map(commitRow);
  if (error !== null) nodes.push(note(error, true));
  if (busy) nodes.push(loading());
  else if (error === null && started && commits.length === 0) nodes.push(note("コミットがありません"));
  list.replaceChildren(...(context === null ? [] : nodes));
  const commit = commits.find((c) => c.id === selected);
  const parts: HTMLElement[] = [];
  if (commit !== undefined && changed !== null && changed.id === commit.id) {
    if (changed.read === "loading") parts.push(loading());
    else if (changed.error !== null) parts.push(note(changed.error, true));
    else if (changed.data !== null) {
      const data = changed.data;
      parts.push(...data.files.map((f) => fileRow(f, commit, data.parentId)));
      if (data.files.length === 0) parts.push(note("変更されたファイルはありません"));
      const more = data.total - data.files.length;
      if (more > 0) parts.push(note(`ほか ${more} 件`));
    }
  }
  under.replaceChildren(...parts);
  [list.scrollTop, under.scrollTop] = tops;
  if (focused) {
    const key = focused.dataset.id !== undefined ? `[data-id="${focused.dataset.id}"]` : `[data-path="${CSS.escape(focused.dataset.path ?? "")}"]`;
    document.querySelector<HTMLElement>(`#orca-history ${key}`)?.focus({ preventScroll: true });
  }
  requestAnimationFrame(readMore);
}

// Reads the next commits when the list is scrolled near its end, or is too short to scroll. A read that failed is not started again by scrolling (the reload button does).
function readMore() {
  const list = $("orca-history-list");
  if (!active || context === null || busy || !hasMore || error !== null || list.clientHeight === 0) return;
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - NEAR_END) void readPage();
}

async function readPage() {
  const here = context;
  if (here === null || busy) return;
  const mine = generation;
  busy = true;
  started = true;
  error = null;
  draw();
  try {
    const page = await invoke("orca_git_history", { path: here.path, limit: PAGE, skip: commits.length, environment: here.target });
    if (mine !== generation) return;
    commits = [...commits, ...page.commits];
    // A page with no commit ends the list, whatever it says, so that the list is not read for ever.
    hasMore = page.hasMore && page.commits.length > 0;
  } catch (e) {
    if (mine !== generation) return;
    error = String(e);
  }
  busy = false;
  draw();
}

async function select(id: string) {
  const here = context;
  if (here === null) return;
  const mine = generation;
  selected = id;
  picked = null;
  changed = { id, read: "loading", data: null, error: null };
  draw();
  let next: Changed;
  try {
    next = { id, read: "ready", data: await invoke("orca_commit_files", { path: here.path, commitId: id, environment: here.target }), error: null };
  } catch (e) {
    next = { id, read: "failed", data: null, error: String(e) };
  }
  // An answer for a list that is gone, or for a commit that is not the chosen one any more, is dropped.
  if (mine !== generation || selected !== id) return;
  changed = next;
  draw();
}

// Follows the pane: the worktree it shows (null: none), and whether the history is the part that is shown. Another worktree starts a new list, and the first commits are read at once while the history is shown.
export function syncHistory(next: HistoryContext | null, show: boolean) {
  const same = next?.path === context?.path && next?.target === context?.target;
  context = next;
  active = show;
  if (!same) {
    reset();
    draw();
  }
  if (active && context !== null && !started) void readPage();
}

// Reads the list again from the start (the reload button, and a switch of the branch).
export function reloadHistory() {
  reset();
  draw();
  if (active && context !== null) void readPage();
}

export function initHistory(on: { open: (relative: string, commit: DiffCommit) => void }) {
  openFile = on.open;
  $("orca-history-list").onscroll = readMore;
}
