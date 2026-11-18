// The definition of the file pane of the Orca screen (A-34): the places of the definition of the name that was pressed in the editor with the Command key and the right button. Rust asks the language server (`lsp_definition`) and decides how each place is drawn (`lsp_places`); this module draws the heading (the name and the count), the rows, and the lines around the definition of an open row, and gives the screen a place to open as a tab.
// The list belongs to one worktree of one target: another worktree clears it, and an answer that comes late for an older question (or for a row that is gone) is dropped. Nothing is kept outside memory, and nothing is read until the owner asks or opens a row. A file inside the worktree is read by `orca_file_read` and one outside it by `lsp_read_outside`, both only for the lines shown.
import type { LspLocation } from "./bindings/LspLocation";
import type { LspPlace } from "./bindings/LspPlace";
import { $, tag } from "./dom.js";
import { CHEVRON_SVG, OPEN_SVG } from "./icons.js";
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
}

// The lines drawn before and after the line of the definition.
const AROUND = 3;

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
  open: boolean;
  preview: Preview | null;
}

let query: DefinitionQuery | null = null;
let phase: "idle" | "loading" | "ready" | "failed" = "idle";
let error: string | null = null;
let rows: Row[] = [];
// A new question (or another worktree) ends the reads of the old one.
let generation = 0;
let openInside: (relative: string, line: number, character: number) => void = () => {};
let openOutside: (path: string, line: number, character: number) => void = () => {};

function note(text: string, fail = false) {
  return tag("p", `orca-file-note${fail ? " fail" : ""}`, text);
}

function loading() {
  const line = tag("div", "pending");
  line.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
  return line;
}

function head() {
  const box = $("orca-definition-head");
  if (query === null) return box.replaceChildren();
  const parts = [tag("span", "orca-def-word", query.word)];
  if (phase === "ready") parts.push(tag("span", "orca-def-count", `${rows.length} 件`));
  box.replaceChildren(...parts);
}

function previewNode(preview: Preview) {
  if (preview.read === "loading") return loading();
  if (preview.error !== null) return note(preview.error, true);
  const code = tag("div", "orca-def-code");
  preview.lines.forEach((text, i) => {
    const line = tag("div", "orca-def-line");
    const n = preview.first + i;
    line.dataset.line = String(n);
    if (n === preview.hit) line.dataset.hit = "true";
    line.append(tag("span", "orca-def-n", String(n)), tag("span", "orca-def-text", text));
    code.append(line);
  });
  return code;
}

function rowNode(row: Row, index: number) {
  const box = tag("div", "orca-def");
  box.dataset.index = String(index);
  const bar = tag("div", "orca-def-row");
  const toggle = tag("button", "orca-def-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(row.open));
  const chevron = tag("span", "orca-def-chevron");
  chevron.innerHTML = CHEVRON_SVG;
  const names = tag("span", "orca-def-names");
  names.append(tag("span", "orca-def-file", `${row.place.file}:${row.place.line}`), tag("span", "orca-def-place", row.place.place));
  toggle.append(chevron, names);
  toggle.title = row.location.path;
  toggle.onclick = () => toggleRow(row);
  bar.append(toggle);
  if (row.place.outside) bar.append(tag("span", "orca-def-gem", "gem"));
  const open = tag("button", "icon-btn orca-def-open");
  open.type = "button";
  open.setAttribute("aria-label", "タブで開く");
  open.innerHTML = OPEN_SVG;
  open.onclick = () => (row.location.outside ? openOutside : openInside)(row.location.path, row.location.line, row.location.character);
  bar.append(open);
  box.append(bar);
  if (row.open && row.preview !== null) box.append(previewNode(row.preview));
  return box;
}

// Draws the heading and the list, keeping the scroll of the list and the focus of its buttons.
function draw() {
  head();
  const list = $("orca-definition-list");
  const top = list.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#orca-definition-list .orca-def");
  const kind = document.activeElement?.classList.contains("orca-def-open") ? ".orca-def-open" : ".orca-def-toggle";
  const parts: HTMLElement[] = [];
  if (phase === "loading") parts.push(loading());
  else if (phase === "failed" && error !== null) parts.push(note(error, true));
  else if (phase === "ready" && rows.length === 0) parts.push(note("定義はありません"));
  parts.push(...rows.map(rowNode));
  list.replaceChildren(...parts);
  list.scrollTop = top;
  if (focused) list.querySelector<HTMLElement>(`.orca-def[data-index="${focused.dataset.index}"] ${kind}`)?.focus({ preventScroll: true });
}

// Reads the lines around the definition of the row.
async function readPreview(row: Row) {
  const here = query;
  if (here === null) return;
  const mine = generation;
  const hit = row.location.line + 1;
  row.preview = { read: "loading", first: hit, hit, lines: [], error: null };
  draw();
  let next: Preview;
  try {
    const text = row.location.outside
      ? (await invoke("lsp_read_outside", { environment: here.target, project: here.project, worktree: here.path, server: here.server, path: row.location.path })).text
      : (await invoke("orca_file_read", { path: here.path, relative: row.location.path, environment: here.target })).content;
    const all = text.split("\n").map((l) => l.replace(/\r$/, ""));
    const from = Math.max(0, hit - 1 - AROUND);
    next = { read: "ready", first: from + 1, hit, lines: all.slice(from, Math.min(all.length, hit + AROUND)), error: null };
  } catch (e) {
    next = { read: "failed", first: hit, hit, lines: [], error: String(e) };
  }
  if (mine !== generation) return;
  row.preview = next;
  draw();
}

function toggleRow(row: Row) {
  row.open = !row.open;
  if (row.open && row.preview === null) void readPreview(row);
  else draw();
}

// Asks the server for the definition of the name of `q` and draws the places it gives; one place is opened at once. A refusal or a failure of the server is drawn as Rust words it.
export async function askDefinition(q: DefinitionQuery) {
  const mine = ++generation;
  query = q;
  phase = "loading";
  error = null;
  rows = [];
  draw();
  try {
    const locations = await invoke("lsp_definition", { environment: q.target, worktree: q.path, server: q.server, relative: q.relative, text: q.text, line: q.line, character: q.character });
    if (mine !== generation) return;
    const places = locations.length === 0 ? [] : await invoke("lsp_places", { locations });
    if (mine !== generation) return;
    rows = locations.map((location, i) => ({ location, place: places[i], open: locations.length === 1, preview: null }));
    phase = "ready";
    draw();
    if (rows.length === 1) void readPreview(rows[0]);
  } catch (e) {
    if (mine !== generation) return;
    phase = "failed";
    error = String(e);
    draw();
  }
}

// Follows the pane: the worktree it shows (null: none). Another worktree clears the list.
export function syncDefinition(next: { target: string | null; path: string } | null) {
  if (query === null || (next !== null && next.path === query.path && next.target === query.target)) return;
  generation++;
  query = null;
  phase = "idle";
  error = null;
  rows = [];
  draw();
}

export function initDefinition(on: { inside: (relative: string, line: number, character: number) => void; outside: (path: string, line: number, character: number) => void }) {
  openInside = on.inside;
  openOutside = on.outside;
}
