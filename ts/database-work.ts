// The work pane of the database screen (D-3, D-4): the tables of the database that was pressed last, with their estimated rows, size and engine (a row opens its table), or, when a table was pressed in the tree, the tabs of that table.
// Drawing only. The tabs are `TABS` and their body is drawn in the branch of `state.table`: the records tab (D-4), the structure tab (D-5) and the SQL tab (D-6) are here.
import type { DatabaseRecords } from "./bindings/DatabaseRecords";
import type { DatabaseSqlResult } from "./bindings/DatabaseSqlResult";
import type { DatabaseStructure } from "./bindings/DatabaseStructure";
import type { DatabaseTable } from "./bindings/DatabaseTable";
import { gridNode } from "./database-grid.js";
import { $, onEnter, tag } from "./dom.js";
import { CHEVRON_LEFT_SVG, CHEVRON_SVG, COPY_SVG, PAGE_FIRST_SVG, PAGE_LAST_SVG, RELOAD_SVG } from "./icons.js";
import { copyText } from "./view.js";

// The page of records that was asked for last. `data` stays while the next page is read, and is none after an error.
export interface RecordsState {
  page: number;
  loading: boolean;
  error: string | null;
  data: DatabaseRecords | null;
}

// The structure that was asked for last. `data` is none while it is read and after an error.
export interface StructureState {
  loading: boolean;
  error: string | null;
  data: DatabaseStructure | null;
}

// The SQL tab of the connection and database that the tree has selected: the text as typed, and the result of the run asked for last. `data` is none before a run and after an error.
export interface SqlState {
  text: string;
  loading: boolean;
  error: string | null;
  data: DatabaseSqlResult | null;
}

export interface WorkState {
  // The connection the database belongs to; with the database, the table and the tab it names the grid whose column widths are kept.
  connection: string;
  database: string;
  loading: boolean;
  error: string | null;
  tables: DatabaseTable[];
  // The table that was pressed in the tree, or none; with it, the selected tab and the state of its records.
  table: string | null;
  tab: string;
  records: RecordsState | null;
  structure: StructureState | null;
  sql: SqlState | null;
}

export interface WorkActions {
  // Reads the page `page` of the records of the table (the reload is the page that is shown).
  page: (page: number) => void;
  // Reads the page that the text of the page field names; Rust checks the text.
  pageInput: (text: string) => void;
  // Selects the tab `id`; the table stays.
  tab: (id: string) => void;
  // Keeps the text of the SQL tab as it is typed; nothing is drawn.
  sqlText: (text: string) => void;
  // Runs the text of the SQL tab.
  runSql: () => void;
  // Opens the table of a row of the table list, as a press on its row in the tree does.
  openTable: (table: string) => void;
}

// The tabs of a table, in order. The body of the selected one is drawn in `drawDatabaseWork`, where the body of a tab that is added goes.
const TABS = [
  { id: "records", label: "レコード" },
  { id: "structure", label: "構造" },
  { id: "sql", label: "SQL" },
];

const STRUCTURE_COLUMNS = ["名前", "型", "NULL", "キー", "既定値", "注釈"];

let drawn = "";

function tableNode(state: WorkState, actions: WorkActions) {
  const table = tag("table", "database-tables");
  const head = tag("tr");
  for (const [label, numeric] of [["名前", false], ["行数（概算）", true], ["サイズ", true], ["エンジン", false]] as const) {
    head.append(tag("th", numeric ? "num" : "", label));
  }
  const thead = tag("thead");
  thead.append(head);
  table.append(thead);
  const body = tag("tbody");
  for (const t of state.tables) {
    const tr = tag("tr");
    tr.tabIndex = 0;
    tr.dataset.key = `table-${t.name}`;
    tr.onclick = () => actions.openTable(t.name);
    tr.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      actions.openTable(t.name);
    };
    tr.append(tag("td", "", t.name), tag("td", "num", t.rows), tag("td", "num", t.size), tag("td", "", t.engine));
    body.append(tr);
  }
  table.append(body);
  return table;
}

function note(text: string, failed: boolean) {
  const line = tag("p", failed ? "database-note danger" : "database-note", text);
  line.setAttribute("role", failed ? "alert" : "status");
  return line;
}

function tabsNode(active: string, actions: WorkActions) {
  const bar = tag("div", "database-tabs");
  bar.setAttribute("role", "tablist");
  for (const t of TABS) {
    const button = tag("button", "database-tab", t.label);
    button.type = "button";
    button.dataset.tab = t.id;
    button.dataset.key = `tab-${t.id}`;
    button.onclick = () => actions.tab(t.id);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(t.id === active));
    bar.append(button);
  }
  return bar;
}

function pagerButton(key: string, label: string, disabled: boolean, onclick: () => void) {
  const button = tag("button", "text-btn", label);
  button.type = "button";
  button.dataset.key = key;
  button.disabled = disabled;
  button.onclick = onclick;
  return button;
}

function iconButton(key: string, label: string, svg: string, disabled: boolean, onclick: () => void) {
  const button = tag("button", "icon-btn", "");
  button.type = "button";
  button.dataset.key = key;
  button.setAttribute("aria-label", label);
  button.innerHTML = svg;
  button.disabled = disabled;
  button.onclick = onclick;
  return button;
}

// The button at the left of the footer that copies the list that is shown, as Rust made its text (`tsv`, #668): off while it is read and when there is no column. The write is made straight from the press, as `copyText` needs.
function copyButton(data: { columns: unknown[]; tsv: string } | null, loading: boolean) {
  return iconButton("copy", "一覧をコピー", COPY_SVG, loading || data === null || data.columns.length === 0, () => {
    if (data) void copyText(data.tsv, "一覧をコピーしました");
  });
}

// The records tab: the page as a grid, and under it the reload, the copy and the range with the estimated rows at the left, and at the right the first, previous, number, next and last page.
function recordsNode(records: RecordsState, actions: WorkActions, sizes: string) {
  const box = tag("div", "database-records");
  const scroll = tag("div", "database-records-scroll");
  if (records.error !== null) scroll.append(note(records.error, true));
  else if (records.data !== null && records.data.columns.length > 0) {
    const { data } = records;
    scroll.append(gridOf(data, () => gridNode(data.columns, data.rows, sizes)));
  }
  const pager = tag("div", "database-pager");
  const range = tag("span", "database-range", records.loading ? "読み込み中…" : (records.data?.summary ?? ""));
  range.setAttribute("role", "status");
  const { loading, page } = records;
  const lastPage = records.data?.lastPage ?? null;
  const input = tag("input", "database-page-input");
  input.type = "text";
  input.inputMode = "numeric";
  input.value = String(page + 1);
  input.readOnly = loading;
  input.spellcheck = false;
  input.dataset.key = "page";
  input.setAttribute("aria-label", "ページ番号");
  onEnter(input, () => {
    if (!loading) actions.pageInput(input.value);
  });
  const nav = tag("div", "database-pager-nav");
  nav.append(
    iconButton("first", "最初のページ", PAGE_FIRST_SVG, loading || page === 0, () => actions.page(0)),
    iconButton("prev", "前のページ", CHEVRON_LEFT_SVG, loading || page === 0, () => actions.page(page - 1)),
    input,
    tag("span", "database-pages", records.data?.pages ?? ""),
    iconButton("next", "次のページ", CHEVRON_SVG, loading || !records.data?.hasMore, () => actions.page(page + 1)),
    iconButton("last", "最後のページ", PAGE_LAST_SVG, loading || lastPage === null || page >= lastPage, () => actions.page(lastPage ?? page)),
  );
  pager.append(iconButton("reload", "再読み込み", RELOAD_SVG, loading, () => actions.page(page)), copyButton(records.data, loading), range, nav);
  box.append(scroll, pager);
  return box;
}

// The structure tab: the columns as a grid, and under it the copy and the number of columns, the engine and the character set as Rust worded them.
function structureNode(structure: StructureState, sizes: string) {
  const box = tag("div", "database-records");
  const scroll = tag("div", "database-records-scroll");
  if (structure.error !== null) scroll.append(note(structure.error, true));
  else if (structure.data !== null && structure.data.columns.length > 0) {
    const { data } = structure;
    scroll.append(
      gridOf(data, () => {
        const rows = data.columns.map((c) => [c.name, c.columnType, c.nullable ? "YES" : "NO", c.key, c.default, c.comment].map((text) => ({ kind: "text" as const, text })));
        const grid = gridNode(STRUCTURE_COLUMNS, rows, sizes);
        grid.classList.add("database-structure");
        return grid;
      }),
    );
  }
  const footer = tag("div", "database-pager");
  const summary = tag("span", "database-range", structure.loading ? "読み込み中…" : (structure.data?.summary ?? ""));
  summary.setAttribute("role", "status");
  footer.append(copyButton(structure.data, structure.loading), summary);
  box.append(scroll, footer);
  return box;
}

// The SQL tab: the text field and the run button above, the result as a grid under them, and under the grid the copy, and the rows and the time as Rust worded them.
function sqlNode(sql: SqlState, actions: WorkActions, sizes: string) {
  const box = tag("div", "database-records database-sql");
  const input = tag("textarea", "database-sql-text");
  input.value = sql.text;
  input.rows = 8;
  input.spellcheck = false;
  input.dataset.key = "sql-input";
  input.setAttribute("aria-label", "SQL");
  input.oninput = () => actions.sqlText(input.value);
  const bar = tag("div", "database-sql-bar");
  bar.append(pagerButton("run", "実行", sql.loading, actions.runSql));
  const scroll = tag("div", "database-records-scroll");
  if (sql.error !== null) scroll.append(note(sql.error, true));
  else if (sql.data !== null && sql.data.columns.length > 0) {
    const { data } = sql;
    scroll.append(gridOf(data, () => gridNode(data.columns, data.rows, sizes)));
  }
  const footer = tag("div", "database-pager");
  const summary = tag("span", "database-range", sql.loading ? "実行中…" : (sql.data?.summary ?? ""));
  summary.setAttribute("role", "status");
  footer.append(copyButton(sql.data, sql.loading), summary);
  box.append(input, bar, scroll, footer);
  return box;
}

// The grid of a result, made once for the object Rust answered: a draw that only changes the footer or a button (loading on, loading off) puts the same grid back, and does not build up to 1,000 rows again.
const grids = new WeakMap<object, HTMLElement>();
function gridOf(data: object, build: () => HTMLElement) {
  let node = grids.get(data);
  if (!node) {
    node = build();
    grids.set(data, node);
  }
  return node;
}

// The number of each answer of Rust that was drawn: the key of a draw holds the number and not the rows, so a draw does not turn a result of 1,000 rows into text to compare it.
const versions = new WeakMap<object, number>();
let versionCount = 0;
const versionOf = (data: object) => {
  const known = versions.get(data);
  if (known !== undefined) return known;
  versionCount += 1;
  versions.set(data, versionCount);
  return versionCount;
};

export function drawDatabaseWork(state: WorkState | null, actions: WorkActions) {
  const key = JSON.stringify(state, (name, value) => (name === "data" && value !== null && typeof value === "object" ? versionOf(value) : value));
  if (key === drawn) return;
  drawn = key;
  const box = $("database-work");
  box.classList.toggle("database-table-mode", state?.table != null);
  if (state === null) return box.replaceChildren();
  const active = document.activeElement as HTMLElement | null;
  const focused = active?.dataset?.key;
  // The text field is made again with the pane: the caret stays where it was.
  const caret = active instanceof HTMLTextAreaElement ? ([active.selectionStart, active.selectionEnd] as const) : null;
  if (state.table !== null && state.records !== null) {
    const sizes = (tab: string) => [state.connection, state.database, state.table, tab].join("\0");
    const body =
      state.tab === "structure" && state.structure !== null
        ? structureNode(state.structure, sizes("structure"))
        : state.tab === "sql" && state.sql !== null
          ? sqlNode(state.sql, actions, sizes("sql"))
          : recordsNode(state.records, actions, sizes("records"));
    box.replaceChildren(tag("h3", "database-work-title", `${state.database}.${state.table}`), tabsNode(state.tab, actions), body);
    if (focused) {
      const again = box.querySelector<HTMLElement>(`[data-key="${focused}"]`);
      again?.focus({ preventScroll: true });
      if (caret !== null && again instanceof HTMLTextAreaElement) again.setSelectionRange(caret[0], caret[1]);
    }
    return;
  }
  const nodes: Node[] = [tag("h3", "database-work-title", state.database)];
  if (state.loading) nodes.push(note("読み込み中…", false));
  else if (state.error !== null) nodes.push(note(state.error, true));
  else if (state.tables.length > 0) nodes.push(tableNode(state, actions));
  box.replaceChildren(...nodes);
}
