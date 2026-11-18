// The definition tab of the Orca screen (A-34): the places of the definition of the name that was pressed in the editor with the Command key and the right button, as a tab of the work pane (A-17) under the pane of the editor. Rust asks the language server (`lsp_definition`) and decides how each place is drawn (`lsp_places`); this module draws the heading (the name and the count), a row for each place with the lines around its definition, and gives the screen a place to open as a tab of the editor.
// A project has one such tab, whatever is pressed: the next press puts its answer in the tab that is open, and an answer that comes late for an older question (or for a tab that was closed) is dropped. The tab is kept in memory only, by target and project, as the tabs of the diffs are (its id is `definition:{n}`). Every place is read for its lines at once, a few at a time: a file inside the worktree by `orca_file_read` and one outside it by `lsp_read_outside`, only for the lines shown.
import type { LspLocation } from "./bindings/LspLocation";
import type { LspPlace } from "./bindings/LspPlace";
import { tag } from "./dom.js";
import { invoke } from "./ipc.js";

// The question: the worktree and its file as the editor holds it now (`text`), the place in it (`line` from 0 and `character` in UTF-16 units, as the server counts), and the name that is there.
export interface DefinitionQuery {
  target: string | null;
  project: string;
  path: string;
  // The server that answers: the one that takes the language of the file.
  server: string;
  relative: string;
  text: string;
  line: number;
  character: number;
  word: string;
  // The tab of the editor the question came from: a place opens in the pane that holds it.
  tab: string;
}

// The place of a definition that the screen opens as a tab of the editor, and what it needs of the question.
export interface DefinitionOpen {
  // The definition tab that holds the place.
  definition: string;
  query: DefinitionQuery;
  // The path from the worktree, or the server's absolute path for a place outside it.
  path: string;
  outside: boolean;
  line: number;
  character: number;
}

// The lines drawn before and after the line of the definition, and how many places are read at once.
const AROUND = 3;
const READS = 4;

// What was read of the lines around the definition of a row: `first` is the number (from 1) of the first line drawn, and `hit` the number of the line of the definition.
interface Preview {
  read: "loading" | "ready" | "failed";
  first: number;
  hit: number;
  lines: string[];
  error: string | null;
}

interface Row {
  location: LspLocation;
  place: LspPlace;
  preview: Preview;
  body: HTMLElement;
}

export interface DefinitionTab {
  id: string;
  target: string | null;
  project: string;
  query: DefinitionQuery;
  phase: "loading" | "ready" | "failed";
  error: string | null;
  rows: Row[];
  // Counts the questions, so that an answer of an earlier one than the last is dropped.
  seq: number;
  // The scroll of the list, which a tab taken out of the page and put back keeps.
  scroll: number;
  el: HTMLElement;
  head: HTMLElement;
  list: HTMLElement;
}

const tabs = new Map<string, DefinitionTab>();
let lastId = 0;
let open: (place: DefinitionOpen) => void = () => {};

function note(text: string, fail = false) {
  return tag("p", `orca-file-note${fail ? " fail" : ""}`, text);
}

function loading() {
  const line = tag("div", "pending");
  line.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
  return line;
}

function drawHead(d: DefinitionTab) {
  const parts = [tag("span", "orca-def-word", d.query.word)];
  if (d.phase === "ready") parts.push(tag("span", "orca-def-count", `${d.rows.length} 件`));
  d.head.replaceChildren(...parts);
}

function drawPreview(row: Row) {
  const preview = row.preview;
  if (preview.read === "loading") return row.body.replaceChildren(loading());
  if (preview.error !== null) return row.body.replaceChildren(note(preview.error, true));
  const code = tag("div", "orca-def-code");
  preview.lines.forEach((text, i) => {
    const line = tag("div", "orca-def-line");
    const n = preview.first + i;
    line.dataset.line = String(n);
    if (n === preview.hit) line.dataset.hit = "true";
    line.append(tag("span", "orca-def-n", String(n)), tag("span", "orca-def-text", text));
    code.append(line);
  });
  row.body.replaceChildren(code);
}

function rowNode(d: DefinitionTab, row: Row, index: number) {
  const box = tag("div", "orca-def");
  box.dataset.index = String(index);
  const bar = tag("div", "orca-def-row");
  const names = tag("span", "orca-def-names");
  names.title = row.location.path;
  const { place } = row;
  names.append(tag("span", "orca-def-file", `${row.location.outside ? place.file : row.location.path}:${place.line}`));
  if (row.location.outside) names.append(tag("span", "orca-def-place", place.place));
  bar.append(names);
  if (row.location.outside && place.language === "ruby") bar.append(tag("span", "orca-def-gem", "gem"));
  const button = tag("button", "text-btn orca-def-open", "開く");
  button.type = "button";
  button.onclick = () => open({ definition: d.id, query: d.query, path: row.location.path, outside: row.location.outside, line: row.location.line, character: row.location.character });
  bar.append(button);
  box.append(bar, row.body);
  return box;
}

// Draws the heading and the list of the tab.
function draw(d: DefinitionTab) {
  drawHead(d);
  const parts: HTMLElement[] = [];
  if (d.phase === "loading") parts.push(loading());
  else if (d.phase === "failed" && d.error !== null) parts.push(note(d.error, true));
  else if (d.phase === "ready" && d.rows.length === 0) parts.push(note("定義はありません"));
  parts.push(...d.rows.map((row, i) => rowNode(d, row, i)));
  d.list.replaceChildren(...parts);
}

// Reads the file of the rows once (they are places of one file), and draws the lines around the definition of each row in it. An answer for an older question, or for a tab that was closed, is dropped.
async function readPreview(d: DefinitionTab, rows: Row[], seq: number) {
  const q = d.query;
  const { location } = rows[0];
  let all: string[] | null = null;
  let error = "";
  try {
    const text = location.outside
      ? (await invoke("lsp_read_outside", { environment: q.target, project: q.project, worktree: q.path, server: q.server, path: location.path })).text
      : (await invoke("orca_file_read", { path: q.path, relative: location.path, environment: q.target })).content;
    all = text.split("\n").map((l) => l.replace(/\r$/, ""));
  } catch (e) {
    error = String(e);
  }
  if (seq !== d.seq) return;
  for (const row of rows) {
    const hit = row.location.line + 1;
    const from = Math.max(0, hit - 1 - AROUND);
    row.preview = all === null ? { read: "failed", first: hit, hit, lines: [], error } : { read: "ready", first: from + 1, hit, lines: all.slice(from, Math.min(all.length, hit + AROUND)), error: null };
    drawPreview(row);
  }
}

// Reads the places of the tab, `READS` files at a time: the places of one file are read with one read.
async function readPreviews(d: DefinitionTab, seq: number) {
  const files = new Map<string, Row[]>();
  for (const row of d.rows) {
    const key = JSON.stringify([row.location.outside, row.location.path]);
    files.set(key, [...(files.get(key) ?? []), row]);
  }
  const queue = [...files.values()];
  const worker = async () => {
    for (let rows = queue.shift(); rows !== undefined && seq === d.seq; rows = queue.shift()) await readPreview(d, rows, seq);
  };
  await Promise.all(Array.from({ length: Math.min(READS, queue.length) }, worker));
}

// Asks the server for the definition of the name of the question and draws the places it gives. A refusal or a failure of the server is drawn as Rust words it.
async function ask(d: DefinitionTab) {
  const seq = ++d.seq;
  const q = d.query;
  d.phase = "loading";
  d.error = null;
  d.rows = [];
  draw(d);
  try {
    const locations = await invoke("lsp_definition", { environment: q.target, worktree: q.path, server: q.server, relative: q.relative, text: q.text, line: q.line, character: q.character });
    if (seq !== d.seq) return;
    const places = locations.length === 0 ? [] : await invoke("lsp_places", { locations });
    if (seq !== d.seq) return;
    d.rows = locations.map((location, i) => {
      const row: Row = { location, place: places[i], preview: { read: "loading", first: 1, hit: 1, lines: [], error: null }, body: tag("div", "orca-def-body") };
      drawPreview(row);
      return row;
    });
    d.phase = "ready";
    draw(d);
    void readPreviews(d, seq);
  } catch (e) {
    if (seq !== d.seq) return;
    d.phase = "failed";
    d.error = String(e);
    draw(d);
  }
}

function create(id: string, q: DefinitionQuery): DefinitionTab {
  const el = tag("div", "orca-definition");
  el.dataset.definition = id;
  const head = tag("div", "orca-edit-head orca-definition-head");
  const list = tag("div", "orca-definition-list");
  el.append(head, list);
  const d: DefinitionTab = { id, target: q.target, project: q.project, query: q, phase: "loading", error: null, rows: [], seq: 0, scroll: 0, el, head, list };
  list.onscroll = () => {
    d.scroll = list.scrollTop;
  };
  return d;
}

// Asks for the definition of the question in the tab of its project (made when there is none), and gives the tab and whether it was made now.
export function openDefinition(q: DefinitionQuery) {
  const held = [...tabs.values()].find((d) => d.target === q.target && d.project === q.project);
  const d = held ?? create(`definition:${++lastId}`, q);
  d.query = q;
  d.scroll = 0;
  d.list.scrollTop = 0;
  tabs.set(d.id, d);
  void ask(d);
  return { tab: d, created: held === undefined };
}

// The definition tab of the project (at most one).
export const definitionsOf = (target: string | null, project: string) => [...tabs.values()].filter((d) => d.target === target && d.project === project);

// Whether a definition tab asked about the worktree at `path` is open in any project (A-34: a tab of the worktree).
export const hasDefinitionIn = (target: string | null, path: string) => [...tabs.values()].some((d) => d.target === target && d.query.path === path);

export function closeDefinition(id: string) {
  const d = tabs.get(id);
  if (!d) return;
  d.seq++;
  d.el.remove();
  tabs.delete(id);
}

// Shows each tab of `placements` in its host element and takes every other tab out of the page (it keeps its rows and its scroll).
export function showDefinitions(placements: { id: string; host: HTMLElement }[]) {
  const shown = new Set(placements.map((p) => p.id));
  for (const [id, d] of tabs) if (!shown.has(id)) d.el.remove();
  for (const { id, host } of placements) {
    const d = tabs.get(id);
    if (!d || d.el.parentElement === host) continue;
    host.replaceChildren(d.el);
    d.list.scrollTop = d.scroll;
  }
}

export function initDefinition(on: { open: (place: DefinitionOpen) => void }) {
  open = on.open;
}
