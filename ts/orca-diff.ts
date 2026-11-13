// The diff tab of the Orca screen (A-24): the difference of a file of a worktree from HEAD, as a tab of the work pane, side by side (HEAD on the left, the working tree on the right, the numbers of the lines between them) or in one column. A file of a commit in the history (A-27) opens the same tab: the parent on the left, the commit on the right, and the short id of the commit in the heading.
// Rust reads the two texts and compares them (`orca_file_diff`, and `orca_commit_file_diff` for a commit): the rows of both views, the blocks of changes and the language to color by; this module draws them, colors the text with the highlighter of the editor (A-21), and takes the presses of the buttons of the tab.
// The tabs are kept in memory only, by target and project, as the tabs of the work pane (their ids are `diff:{n}`), as the files of the editor are (`file:{n}`). The view chosen (side by side or in one column) is one choice for all the tabs.
import type { OrcaDiffRow } from "./bindings/OrcaDiffRow";
import type { OrcaFileDiff } from "./bindings/OrcaFileDiff";
import { tag } from "./dom.js";
import { COLUMNS_SVG, DOWN_SVG, LINES_SVG, RELOAD_SVG, UP_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { highlightReady, loadHighlight } from "./vendor-load.js";

// The commit a tab shows a file of (A-27): its full id and short one, its first parent (null for the first commit), and the path the file had at the parent when it was renamed.
export interface DiffCommit {
  id: string;
  shortId: string;
  parentId: string | null;
  oldRelative: string | null;
}

interface DiffTab {
  id: string;
  target: string | null;
  project: string;
  // The worktree, and the file in it (relative).
  path: string;
  relative: string;
  commit: DiffCommit | null;
  read: "loading" | "ready" | "failed";
  // The answer of Rust, and the lines of both sides as HTML (colored, else escaped), found when the answer comes.
  diff: OrcaFileDiff | null;
  oldHtml: string[];
  newHtml: string[];
  // The block of changes the buttons moved to last (-1: none yet), and the scroll of the rows, which a tab taken out of the page and put back keeps.
  current: number;
  scroll: number;
  // Set while the tab is out of the page: the rows are drawn in the other view (stale), or the first answer came and has not scrolled to the first block yet (pending); showDiffs does it when the tab is put back.
  stale: boolean;
  pending: boolean;
  // Counts the reads, so that an answer of an earlier read than the last is dropped; the wait before the colors of a long text are drawn.
  seq: number;
  cancelColor: (() => void) | null;
  el: HTMLElement;
  note: HTMLElement;
  count: HTMLElement;
  rows: HTMLElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  view: HTMLButtonElement;
  reload: HTMLButtonElement;
}

// Up to this many characters both sides are colored before the rows are drawn; for more, the rows are drawn plain at once and colored after COLOR_WAIT_MS (as the editor draws a long text, `paint` in orca-editor.ts).
const COLOR_NOW_MAX = 30000;
const COLOR_WAIT_MS = 150;

const MARKS = { removed: "−", added: "+", same: "", changed: "" };

const diffs = new Map<string, DiffTab>();
let lastId = 0;
// Whether the tabs show one column (the choice of the button in their heads); the first view is side by side.
let inline = false;

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The HTML of each line of `lines`: colored by the grammar `language` (null: none, the text is escaped). The text is colored as a whole, so a token of several lines (a comment, a string) is colored on each of its lines: the elements open at the end of a line are closed there and opened again at the start of the next.
function htmlLines(lines: string[], language: string | null): string[] {
  if (lines.length === 0) return [];
  if (!language) return lines.map(escapeText);
  const html = hljs.highlight(lines.join("\n"), { language, ignoreIllegals: true }).value;
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  let from = 0;
  for (const m of html.matchAll(/<span[^>]*>|<\/span>|\n/g)) {
    line += html.slice(from, m.index);
    from = m.index + m[0].length;
    if (m[0] === "\n") {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (m[0] === "</span>") open.pop();
      else open.push(m[0]);
      line += m[0];
    }
  }
  out.push(line + html.slice(from));
  return out;
}

const lineOf = (html: string[], n: number | null) => (n === null ? "" : (html[n - 1] ?? ""));

// The HTML of one row. Side by side: the line of HEAD, the two numbers, the line of the working tree (a side with no line is a blank). In one column: the two numbers, the mark and the line (a removed line is HEAD's, any other the working tree's).
function rowHtml(d: DiffTab, row: OrcaDiffRow): string {
  const number = (n: number | null) => `<span class="odf-num">${n ?? ""}</span>`;
  if (inline) {
    const html = row.kind === "removed" ? lineOf(d.oldHtml, row.old) : lineOf(d.newHtml, row.new);
    return `<div class="odf-row odf-inline" data-kind="${row.kind}">${number(row.old)}${number(row.new)}<span class="odf-mark">${MARKS[row.kind]}</span><span class="odf-code">${html}</span></div>`;
  }
  const code = (side: "old" | "new", html: string, blank: boolean) => `<span class="odf-code ${side}${blank ? " blank" : ""}">${html}</span>`;
  return `<div class="odf-row" data-kind="${row.kind}">${code("old", lineOf(d.oldHtml, row.old), row.old === null)}${number(row.old)}${number(row.new)}${code("new", lineOf(d.newHtml, row.new), row.new === null)}</div>`;
}

const viewRows = (d: DiffTab) => (d.diff === null ? [] : inline ? d.diff.inline : d.diff.side);

// Scrolls the rows to the block of changes `index`, and brings the buttons up to date.
function goTo(d: DiffTab, index: number) {
  const changes = d.diff?.changes ?? [];
  if (index < 0 || index >= changes.length) return;
  d.current = index;
  const row = d.rows.children[inline ? changes[index].inline : changes[index].side];
  row?.scrollIntoView({ block: "center" });
  d.scroll = d.rows.scrollTop;
  syncHead(d);
}

function syncHead(d: DiffTab) {
  const n = d.diff?.changes.length ?? 0;
  d.count.textContent = d.read !== "ready" ? "" : n === 0 ? "変更はありません" : `変更 ${n} 件`;
  d.previous.disabled = n === 0 || d.current <= 0;
  d.next.disabled = n === 0 || d.current >= n - 1;
  d.view.disabled = d.read !== "ready";
  d.view.innerHTML = inline ? COLUMNS_SVG : LINES_SVG;
  d.view.setAttribute("aria-label", inline ? "左右に並べて表示" : "1 列で表示");
  d.view.setAttribute("aria-pressed", String(inline));
  d.reload.disabled = d.read === "loading";
}

// Draws the rows of the view chosen.
function render(d: DiffTab) {
  d.rows.innerHTML = viewRows(d)
    .map((row) => rowHtml(d, row))
    .join("");
  d.rows.dataset.view = inline ? "inline" : "side";
  d.stale = false;
}

// Draws the view chosen again, and goes to the block last moved to.
function redraw(d: DiffTab) {
  render(d);
  syncHead(d);
  if (d.current >= 0) goTo(d, d.current);
}

function cancelColor(d: DiffTab) {
  d.cancelColor?.();
  d.cancelColor = null;
}

// Finds the HTML of both sides: colored at once for a short text; a long one is plain at once and colored, and the rows drawn again, after COLOR_WAIT_MS.
function paint(d: DiffTab, diff: OrcaFileDiff) {
  cancelColor(d);
  const size = diff.oldLines.reduce((n, l) => n + l.length, 0) + diff.newLines.reduce((n, l) => n + l.length, 0);
  if (diff.highlight && (size > COLOR_NOW_MAX || !highlightReady())) {
    d.oldHtml = htmlLines(diff.oldLines, null);
    d.newHtml = htmlLines(diff.newLines, null);
    const color = () => {
      d.cancelColor = null;
      d.oldHtml = htmlLines(diff.oldLines, diff.highlight);
      d.newHtml = htmlLines(diff.newLines, diff.highlight);
      const top = d.rows.scrollTop;
      render(d);
      d.rows.scrollTop = top;
    };
    if (highlightReady()) {
      const id = window.setTimeout(color, COLOR_WAIT_MS);
      d.cancelColor = () => clearTimeout(id);
    } else {
      // highlight.js is read the first time a file is colored; a text that fails to load stays plain.
      let live = true;
      loadHighlight().then(() => live && color(), () => {});
      d.cancelColor = () => {
        live = false;
      };
    }
  } else {
    d.oldHtml = htmlLines(diff.oldLines, diff.highlight);
    d.newHtml = htmlLines(diff.newLines, diff.highlight);
  }
}

// Reads the difference again, and draws it. The first read goes to the first change; a read after that keeps the place in the rows.
async function load(d: DiffTab) {
  const mine = ++d.seq;
  const first = d.diff === null;
  d.read = "loading";
  d.reload.disabled = true;
  try {
    const c = d.commit;
    const diff = c === null ? await invoke("orca_file_diff", { path: d.path, relative: d.relative, environment: d.target }) : await invoke("orca_commit_file_diff", { path: d.path, commitId: c.id, parentId: c.parentId, relative: d.relative, oldRelative: c.oldRelative, environment: d.target });
    if (mine !== d.seq) return;
    d.diff = diff;
    paint(d, diff);
    d.read = "ready";
    d.note.hidden = true;
    d.rows.hidden = false;
    const top = d.rows.scrollTop;
    render(d);
    d.current = Math.min(d.current, diff.changes.length - 1);
    syncHead(d);
    if (first && diff.changes.length > 0) {
      if (d.el.isConnected) goTo(d, 0);
      else d.pending = true;
    } else d.rows.scrollTop = top;
  } catch (e) {
    if (mine !== d.seq) return;
    cancelColor(d);
    d.diff = null;
    d.read = "failed";
    d.current = -1;
    d.note.textContent = String(e);
    d.note.hidden = false;
    d.rows.hidden = true;
    d.rows.replaceChildren();
    syncHead(d);
  }
}

function create(id: string, target: string | null, project: string, path: string, relative: string, commit: DiffCommit | null): DiffTab {
  const el = tag("div", "orca-diff");
  el.dataset.diff = id;
  const head = tag("div", "orca-edit-head orca-diff-head");
  const count = tag("span", "orca-diff-count");
  count.setAttribute("role", "status");
  const button = (label: string, svg: string) => {
    const b = tag("button", "icon-btn orca-diff-btn");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.innerHTML = svg;
    return b;
  };
  const previous = button("前の変更", UP_SVG);
  const next = button("次の変更", DOWN_SVG);
  const view = button("1 列で表示", LINES_SVG);
  const reload = button("読み直す", RELOAD_SVG);
  head.append(tag("span", "orca-edit-path", relative));
  if (commit !== null) head.append(tag("span", "orca-diff-commit", commit.shortId));
  head.append(count, previous, next, view, reload);
  const note = tag("p", "orca-empty feed-empty");
  note.hidden = true;
  const rows = tag("div", "orca-diff-rows");
  rows.hidden = true;
  el.append(head, note, rows);
  const d: DiffTab = { id, target, project, path, relative, commit, read: "loading", diff: null, oldHtml: [], newHtml: [], current: -1, scroll: 0, stale: false, pending: false, seq: 0, cancelColor: null, el, note, count, rows, previous, next, view, reload };
  previous.onclick = () => goTo(d, d.current - 1);
  next.onclick = () => goTo(d, d.current + 1);
  reload.onclick = () => void load(d);
  view.onclick = () => {
    inline = !inline;
    // Every tab shows the view chosen, at its block of changes: a tab on the page is drawn now, one out of the page when it is put back.
    for (const other of diffs.values()) {
      if (other.diff === null) continue;
      if (other.el.isConnected) redraw(other);
      else other.stale = true;
    }
  };
  rows.onscroll = () => {
    d.scroll = rows.scrollTop;
  };
  syncHead(d);
  return d;
}

// Opens the difference of the file as a tab of the project and gives its id (with `commit`, the file as that commit changed it); a file whose difference is open already (in the same commit) is read again, not opened twice.
export function openDiff(target: string | null, project: string, path: string, relative: string, commit: DiffCommit | null = null) {
  const open = [...diffs.values()].find((d) => d.target === target && d.project === project && d.path === path && d.relative === relative && (d.commit?.id ?? null) === (commit?.id ?? null));
  if (open) {
    void load(open);
    return open.id;
  }
  const d = create(`diff:${++lastId}`, target, project, path, relative, commit);
  diffs.set(d.id, d);
  void load(d);
  return d.id;
}

// The open diffs of the project, in the order they were opened.
export const diffsOf = (target: string | null, project: string) => [...diffs.values()].filter((d) => d.target === target && d.project === project);

export function closeDiff(id: string) {
  const d = diffs.get(id);
  if (!d) return;
  cancelColor(d);
  d.seq++;
  d.el.remove();
  diffs.delete(id);
}

// Shows each diff of `placements` in its host element and takes every other diff out of the page (it keeps its rows).
export function showDiffs(placements: { id: string; host: HTMLElement }[]) {
  const shown = new Set(placements.map((p) => p.id));
  for (const [id, d] of diffs) if (!shown.has(id)) d.el.remove();
  for (const { id, host } of placements) {
    const d = diffs.get(id);
    if (!d) continue;
    if (d.el.parentElement !== host) {
      host.replaceChildren(d.el);
      // Rows that were out of the page start at the top again.
      const drawnAgain = d.stale;
      if (drawnAgain) {
        render(d);
        syncHead(d);
      }
      if (d.pending) {
        d.pending = false;
        goTo(d, 0);
      } else if (!drawnAgain) d.rows.scrollTop = d.scroll;
      else if (d.current >= 0) goTo(d, d.current);
      else d.rows.scrollTop = 0;
    }
  }
}
