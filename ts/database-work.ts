// The work pane of the database screen (D-3, D-4): the tables of the database that was pressed last, with their estimated rows, size and engine, or, when a table was pressed in the tree, the tabs of that table.
// Drawing only. The tabs are `TABS` and their body is drawn in the branch of `state.table`: the records tab is here (D-4), and the structure and SQL tabs are added to both (#634, #635).
import type { DatabaseRecords } from "./bindings/DatabaseRecords";
import type { DatabaseTable } from "./bindings/DatabaseTable";
import { gridNode } from "./database-grid.js";
import { $, tag } from "./dom.js";

// The page of records that was asked for last. `data` stays while the next page is read, and is none after an error.
export interface RecordsState {
  page: number;
  loading: boolean;
  error: string | null;
  data: DatabaseRecords | null;
}

export interface WorkState {
  database: string;
  loading: boolean;
  error: string | null;
  tables: DatabaseTable[];
  // The table that was pressed in the tree, or none; with it, the selected tab and the state of its records.
  table: string | null;
  tab: string;
  records: RecordsState | null;
}

export interface WorkActions {
  // Reads the page `page` of the records of the table (the reload is the page that is shown).
  page: (page: number) => void;
}

// The tabs of a table, in order. The body of the selected one is drawn in `drawDatabaseWork`, where the body of a tab that is added goes.
const TABS = [{ id: "records", label: "レコード" }];

let drawn = "";

function tableNode(state: WorkState) {
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

function tabsNode(active: string) {
  const bar = tag("div", "database-tabs");
  bar.setAttribute("role", "tablist");
  for (const t of TABS) {
    const button = tag("button", "database-tab", t.label);
    button.type = "button";
    button.dataset.tab = t.id;
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

// The records tab: the page as a grid, and under it the range with the estimated rows, the previous and next page, and the reload.
function recordsNode(records: RecordsState, actions: WorkActions) {
  const box = tag("div", "database-records");
  const scroll = tag("div", "database-records-scroll");
  if (records.error !== null) scroll.append(note(records.error, true));
  else if (records.data !== null && records.data.columns.length > 0) scroll.append(gridNode(records.data.columns, records.data.rows));
  const pager = tag("div", "database-pager");
  const range = tag("span", "database-range", records.loading ? "読み込み中…" : (records.data?.summary ?? ""));
  range.setAttribute("role", "status");
  pager.append(
    range,
    pagerButton("prev", "前へ", records.loading || records.page === 0, () => actions.page(records.page - 1)),
    pagerButton("next", "次へ", records.loading || !records.data?.hasMore, () => actions.page(records.page + 1)),
    pagerButton("reload", "再読み込み", records.loading, () => actions.page(records.page)),
  );
  box.append(scroll, pager);
  return box;
}

export function drawDatabaseWork(state: WorkState | null, actions: WorkActions) {
  const key = JSON.stringify(state);
  if (key === drawn) return;
  drawn = key;
  const box = $("database-work");
  box.classList.toggle("database-table-mode", state?.table != null);
  if (state === null) return box.replaceChildren();
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  if (state.table !== null && state.records !== null) {
    box.replaceChildren(tag("h3", "database-work-title", `${state.database}.${state.table}`), tabsNode(state.tab), recordsNode(state.records, actions));
    if (focused) box.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus({ preventScroll: true });
    return;
  }
  const nodes: Node[] = [tag("h3", "database-work-title", state.database)];
  if (state.loading) nodes.push(note("読み込み中…", false));
  else if (state.error !== null) nodes.push(note(state.error, true));
  else if (state.tables.length > 0) nodes.push(tableNode(state));
  box.replaceChildren(...nodes);
}
