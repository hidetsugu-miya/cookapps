// The work pane of the database screen (D-3, D-4, D-9): the strip of the open tabs (オブジェクト, which cannot be closed, and one tab for each table that was opened) and under it the body of the selected one: for オブジェクト the database that was pressed last, with the tabs テーブル (its tables with their estimated rows, size and engine, a row opens its table) and SQL, and for a table the tabs of that table.
// Drawing only. The tabs of a table are `TABS` and their body is drawn in the branch of `state.table`: the records tab (D-4), the structure tab (D-5) and the SQL tab (D-6) are here; the tabs of a database are `DATABASE_TABS`, and its SQL tab is the one of D-6.
// The body of a table (its tabs) and the SQL of a database are drawn into any box, with no screen state behind them: the database screen draws them in `#database-work` (`drawDatabaseWork`), and the work pane of the Orca screen draws one tab each into its own box (`drawTableTab`, A-43).
import type { DatabaseRecords } from "./bindings/DatabaseRecords";
import type { DatabaseSqlResult } from "./bindings/DatabaseSqlResult";
import type { DatabaseStructure } from "./bindings/DatabaseStructure";
import type { DatabaseTable } from "./bindings/DatabaseTable";
import { canEditCell, cellKey, changesOf, type EditState, markable, originalText } from "./database-edit.js";
import { type GridEdit, gridNode, syncEdit } from "./database-grid.js";
import { $, onEnter, tag } from "./dom.js";
import { CHECK_SVG, CHEVRON_LEFT_SVG, CHEVRON_SVG, CLOSE_SVG, COPY_SVG, MINUS_SVG, PAGE_FIRST_SVG, PAGE_LAST_SVG, RELOAD_SVG } from "./icons.js";
import { copyText } from "./view.js";

// The page of records that was asked for last. `data` stays while the next page is read, and is none after an error. `edit` is what the page has gathered to write (D-10); a screen that cannot write gives none, and its records tab has no control to write.
export interface RecordsState {
  page: number;
  loading: boolean;
  error: string | null;
  data: DatabaseRecords | null;
  edit?: EditState;
}

// The structure that was asked for last. `data` is none while it is read and after an error.
export interface StructureState {
  loading: boolean;
  error: string | null;
  data: DatabaseStructure | null;
}

// The SQL tab of the connection and database that the tree has selected: the text as typed, and the result of the run asked for last. `data` is none before a run and after an error. `view` numbers the SQL view (a new query makes a new one): it is in the key of a draw, so a new query is drawn again even when the text typed and not run was the only difference.
export interface SqlState {
  view: number;
  text: string;
  loading: boolean;
  error: string | null;
  data: DatabaseSqlResult | null;
}

// A tab of the strip that is a table: `key` names it to the actions, `title` is its database and table.
export interface OpenTab {
  key: string;
  table: string;
  title: string;
}

export interface WorkState {
  // The tables that were opened, in the order they were opened, and the key of the selected one (none: オブジェクト is selected).
  tabs: OpenTab[];
  active: string | null;
  // The connection the database belongs to; with the database, the table and the tab it names the grid whose column widths are kept.
  connection: string;
  database: string;
  loading: boolean;
  error: string | null;
  tables: DatabaseTable[];
  // The selected tab of the database, while no table is open: "tables" or "sql".
  databaseTab: string;
  // The table of the selected tab of the strip, or none for オブジェクト; with it, the selected tab and the state of its records.
  table: string | null;
  tab: string;
  records: RecordsState | null;
  structure: StructureState | null;
  // The SQL tab of the connection and database: the one the tab of a table shows too.
  sql: SqlState;
}

// A tab of the work pane of the Orca screen (A-43): a table with its tabs (records, structure and SQL), or, with no table, the SQL tab of a database. The connection and the database name the grids whose column widths are kept.
export interface TabState {
  connection: string;
  database: string;
  table: string | null;
  tab: string;
  records: RecordsState | null;
  structure: StructureState | null;
  sql: SqlState;
}

export interface WorkActions {
  // Selects the tab of the strip with the key (none: オブジェクト).
  openTab: (key: string | null) => void;
  // Closes the tab of the strip with the key.
  closeOpenTab: (key: string) => void;
  // Reads the page `page` of the records of the table (the reload is the page that is shown).
  page: (page: number) => void;
  // Reads the page that the text of the page field names; Rust checks the text.
  pageInput: (text: string) => void;
  // Selects the tab `id`; the table stays.
  tab: (id: string) => void;
  // Selects the tab `id` of the database, while no table is open.
  databaseTab: (id: string) => void;
  // Keeps the text of the SQL tab as it is typed; nothing is drawn.
  sqlText: (text: string) => void;
  // Runs the text of the SQL tab.
  runSql: () => void;
  // Opens the table of a row of the table list, as a press on its row in the tree does.
  openTable: (table: string) => void;
  edit: EditActions;
}

// What the records tab does with what it gathers (D-10).
export interface EditActions {
  // Keeps the text a cell was rewritten to (the text it had before takes the rewrite back).
  cell: (row: number, column: number, text: string) => void;
  // Presses a row: it alone is selected, or, with `add`, it is added to or taken from the selected ones.
  select: (row: number, add: boolean) => void;
  // − marks the selected rows to be deleted.
  markDelete: () => void;
  // ✓ writes what was gathered, in one call.
  apply: () => void;
  // ✗ takes all of it back.
  revert: () => void;
}

// What the body of a table or of a SQL tab asks of its screen; `edit` is the screen's that can write.
export type TabActions = Pick<WorkActions, "page" | "pageInput" | "tab" | "sqlText" | "runSql"> & { edit?: EditActions };

// The tabs of a table, in order. The body of the selected one is drawn in `drawDatabaseWork`, where the body of a tab that is added goes.
const TABS = [
  { id: "records", label: "レコード" },
  { id: "structure", label: "構造" },
  { id: "sql", label: "SQL" },
];

// The tabs of a database, in order.
const DATABASE_TABS = [
  { id: "tables", label: "テーブル" },
  { id: "sql", label: "SQL" },
];

const STRUCTURE_COLUMNS = ["名前", "型", "NULL", "キー", "既定値", "注釈"];

let drawn = "";
// Which grid the pane drew last: the same one drawn again (a rewrite or a press of a row, D-10) keeps its scroll position, as the box that scrolls is made again.
let drawnGrid = "";

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

function tabsNode(tabs: { id: string; label: string }[], active: string, pick: (id: string) => void) {
  const bar = tag("div", "database-tabs");
  bar.setAttribute("role", "tablist");
  for (const t of tabs) {
    const button = tag("button", "database-tab", t.label);
    button.type = "button";
    button.dataset.tab = t.id;
    button.dataset.key = `tab-${t.id}`;
    button.onclick = () => pick(t.id);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(t.id === active));
    bar.append(button);
  }
  return bar;
}

// The strip over the pane (D-9): オブジェクト first, which has no close button, then a tab for each open table. The close button is beside the tab, not in it, so that pressing it never selects the tab.
function openTabsNode(state: WorkState, actions: WorkActions) {
  const item = (key: string, label: string, title: string, selected: boolean, pick: () => void, close: (() => void) | null) => {
    const wrap = tag("div", "database-open-item");
    wrap.setAttribute("role", "presentation");
    wrap.dataset.selected = String(selected);
    const button = tag("button", "database-open-tab");
    button.type = "button";
    button.dataset.key = `open-${key}`;
    button.title = title;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(selected));
    button.append(tag("span", "database-open-title", label));
    button.onclick = pick;
    wrap.append(button);
    if (close !== null) {
      const x = tag("button", "icon-btn database-open-close");
      x.type = "button";
      x.dataset.key = `close-${key}`;
      x.setAttribute("aria-label", `${label} を閉じる`);
      x.innerHTML = CLOSE_SVG;
      x.onclick = close;
      wrap.append(x);
    }
    return wrap;
  };
  return [
    item("objects", "オブジェクト", "オブジェクト", state.active === null, () => actions.openTab(null), null),
    ...state.tabs.map((t) => item(t.key, t.table, t.title, t.key === state.active, () => actions.openTab(t.key), () => actions.closeOpenTab(t.key))),
  ];
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

// The grid of the records tab with what it gathers (D-10): its cells, the marked rows and the pressed ones are drawn from `edit`. The grid is made once for an answer of Rust, as every grid is (`gridOf`), and each draw brings it up to date in place (`syncEdit`).
function editGridNode(data: DatabaseRecords, edit: EditState, actions: EditActions, sizes: string) {
  const current: GridEdit = {
    editable: (row, i) => !edit.applying && canEditCell(data, row, i),
    rewritten: (row, i) => edit.cells[cellKey(row, i)],
    startText: (row, i) => edit.cells[cellKey(row, i)] ?? originalText(data, row, i),
    deleted: (row) => edit.deleted.includes(row),
    selected: (row) => edit.selected.includes(row),
    select: actions.select,
    commit: actions.cell,
  };
  const grid = gridOf(data, () => gridNode(data.columns, data.rows, sizes, current));
  syncEdit(grid, current);
  return grid;
}

// The records tab: the page as a grid, and under it the reload, the copy and the range with the estimated rows at the left, and at the right the first, previous, number, next and last page. A screen that writes (D-10) has − ✓ ✗ after the copy and the number of changes after the range; while something is gathered the page cannot be changed or read again.
function recordsNode(records: RecordsState, actions: TabActions, sizes: string) {
  const box = tag("div", "database-records");
  const scroll = tag("div", "database-records-scroll");
  const edit = records.edit !== undefined && actions.edit !== undefined ? { state: records.edit, actions: actions.edit } : null;
  if (records.error !== null) scroll.append(note(records.error, true));
  else if (records.data !== null && records.data.columns.length > 0) {
    const { data } = records;
    scroll.append(edit ? editGridNode(data, edit.state, edit.actions, sizes) : gridOf(data, () => gridNode(data.columns, data.rows, sizes)));
  }
  const pager = tag("div", "database-pager");
  const range = tag("span", "database-range", records.loading ? "読み込み中…" : (records.data?.summary ?? ""));
  range.setAttribute("role", "status");
  const changes = edit && records.data ? changesOf(records.data, edit.state).length : 0;
  // What is gathered, or on its way to be written, keeps the page where it is.
  const held = records.loading || changes > 0 || edit?.state.applying === true;
  const { page } = records;
  const lastPage = records.data?.lastPage ?? null;
  const input = tag("input", "database-page-input");
  input.type = "text";
  input.inputMode = "numeric";
  input.value = String(page + 1);
  input.readOnly = held;
  input.spellcheck = false;
  input.dataset.key = "page";
  input.setAttribute("aria-label", "ページ番号");
  onEnter(input, () => {
    if (!held) actions.pageInput(input.value);
  });
  const nav = tag("div", "database-pager-nav");
  nav.append(
    iconButton("first", "最初のページ", PAGE_FIRST_SVG, held || page === 0, () => actions.page(0)),
    iconButton("prev", "前のページ", CHEVRON_LEFT_SVG, held || page === 0, () => actions.page(page - 1)),
    input,
    tag("span", "database-pages", records.data?.pages ?? ""),
    iconButton("next", "次のページ", CHEVRON_SVG, held || !records.data?.hasMore, () => actions.page(page + 1)),
    iconButton("last", "最後のページ", PAGE_LAST_SVG, held || lastPage === null || page >= lastPage, () => actions.page(lastPage ?? page)),
  );
  pager.append(iconButton("reload", "再読み込み", RELOAD_SVG, held, () => actions.page(page)), copyButton(records.data, records.loading));
  if (edit) {
    const { data } = records;
    const busy = records.loading || edit.state.applying;
    pager.append(
      iconButton("remove", "選んだ行を削除", MINUS_SVG, busy || data === null || markable(data, edit.state).length === 0, edit.actions.markDelete),
      iconButton("apply", "変更を確定", CHECK_SVG, busy || changes === 0, edit.actions.apply),
      iconButton("revert", "変更を取り消す", CLOSE_SVG, busy || changes === 0, edit.actions.revert),
    );
  }
  pager.append(range);
  if (changes > 0) {
    const count = tag("span", "database-changes", `変更 ${changes} 件`);
    count.setAttribute("role", "status");
    pager.append(count);
  }
  pager.append(nav);
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
function sqlNode(sql: SqlState, actions: TabActions, sizes: string) {
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

// What a draw is compared by: every answer of Rust is its number.
const keyOf = (state: unknown) => JSON.stringify(state, (name, value) => (name === "data" && value !== null && typeof value === "object" ? versionOf(value) : value));

// The title, the tabs and the body of a table: the records tab (D-4), the structure tab (D-5) and the SQL tab (D-6).
function tableNodes(state: { connection: string; database: string; table: string; tab: string; records: RecordsState; structure: StructureState | null; sql: SqlState }, actions: TabActions): Node[] {
  const sizes = (tab: string) => [state.connection, state.database, state.table, tab].join("\0");
  return [
    tag("h3", "database-work-title", `${state.database}.${state.table}`),
    tabsNode(TABS, state.tab, actions.tab),
    state.tab === "structure" && state.structure !== null
      ? structureNode(state.structure, sizes("structure"))
      : state.tab === "sql"
        ? sqlNode(state.sql, actions, [state.connection, state.database, "sql"].join("\0"))
        : recordsNode(state.records, actions, sizes("records")),
  ];
}

export function drawDatabaseWork(state: WorkState | null, actions: WorkActions) {
  const key = keyOf(state);
  if (key === drawn) return;
  drawn = key;
  const box = $("database-work");
  const strip = $("database-work-tabs");
  const active = document.activeElement as HTMLElement | null;
  const focused = active?.dataset?.key;
  const inStrip = active !== null && strip.contains(active);
  // The field of a cell that is open (D-10): the grid is put back into the new box with it, and it takes the focus back.
  const openField = active instanceof HTMLInputElement && active.classList.contains("database-cell-input") ? active : null;
  strip.hidden = state === null;
  strip.replaceChildren(...(state === null ? [] : openTabsNode(state, actions)));
  // A body that fills the pane (the tabs of a table, or the SQL tab of a database) scrolls inside it, with its footer kept.
  box.classList.toggle("database-fill", state !== null && (state.table !== null || state.databaseTab === "sql"));
  if (state === null) return box.replaceChildren();
  // The text field is made again with the pane: the caret stays where it was.
  const caret = active instanceof HTMLTextAreaElement ? ([active.selectionStart, active.selectionEnd] as const) : null;
  const scroller = box.querySelector<HTMLElement>(".database-records-scroll");
  const grid = state.table === null ? "" : [state.connection, state.database, state.table, state.tab, state.records?.page].join("\0");
  const scrolled = scroller !== null && grid === drawnGrid ? ([scroller.scrollTop, scroller.scrollLeft] as const) : null;
  drawnGrid = grid;
  const nodes: Node[] = [];
  // The one SQL result of a connection and a database is shared by the tab of the database and the tab SQL of each of its tables, so its column widths are named by the three alone (D-4).
  const sqlSizes = [state.connection, state.database, "sql"].join("\0");
  if (state.table !== null && state.records !== null) {
    nodes.push(...tableNodes({ ...state, table: state.table, records: state.records }, actions));
  } else {
    nodes.push(tag("h3", "database-work-title", state.database), tabsNode(DATABASE_TABS, state.databaseTab, actions.databaseTab));
    if (state.databaseTab === "sql") nodes.push(sqlNode(state.sql, actions, sqlSizes));
    else if (state.loading) nodes.push(note("読み込み中…", false));
    else if (state.error !== null) nodes.push(note(state.error, true));
    else if (state.tables.length > 0) nodes.push(tableNode(state, actions));
  }
  box.replaceChildren(...nodes);
  const kept = box.querySelector<HTMLElement>(".database-records-scroll");
  if (scrolled !== null && kept !== null) [kept.scrollTop, kept.scrollLeft] = scrolled;
  if (openField?.isConnected) openField.focus({ preventScroll: true });
  if (focused) {
    const again = (inStrip ? strip : box).querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`);
    again?.focus({ preventScroll: true });
    if (caret !== null && again instanceof HTMLTextAreaElement) again.setSelectionRange(caret[0], caret[1]);
  }
}

// What each box of a tab of the Orca screen shows now.
const tabDrawn = new WeakMap<HTMLElement, string>();

// Draws a tab of the work pane of the Orca screen into its box (A-43): a table with its tabs, or the SQL of a database. The box is drawn again only when what it shows changes, and the focus and the caret stay.
export function drawTableTab(box: HTMLElement, state: TabState, actions: TabActions) {
  const key = keyOf(state);
  if (key === tabDrawn.get(box)) return;
  tabDrawn.set(box, key);
  const active = document.activeElement as HTMLElement | null;
  const focused = active !== null && box.contains(active) ? active.dataset?.key : undefined;
  const caret = active instanceof HTMLTextAreaElement ? ([active.selectionStart, active.selectionEnd] as const) : null;
  box.classList.add("database-fill");
  const nodes: Node[] = state.table !== null ? [] : [tag("h3", "database-work-title", state.database), sqlNode(state.sql, actions, [state.connection, state.database, "sql"].join("\0"))];
  if (state.table !== null) nodes.push(...(state.records === null ? [tag("h3", "database-work-title", `${state.database}.${state.table}`)] : tableNodes({ ...state, table: state.table, records: state.records }, actions)));
  box.replaceChildren(...nodes);
  if (focused) {
    const again = box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`);
    again?.focus({ preventScroll: true });
    if (caret !== null && again instanceof HTMLTextAreaElement) again.setSelectionRange(caret[0], caret[1]);
  }
}

// Puts the focus and the caret in the field of the SQL tab (a new query), in `box` (the work pane of the database screen when none is given).
export function focusSqlField(box: HTMLElement = $("database-work")) {
  const field = box.querySelector<HTMLTextAreaElement>('[data-key="sql-input"]');
  field?.focus({ preventScroll: true });
  field?.setSelectionRange(0, 0);
}
