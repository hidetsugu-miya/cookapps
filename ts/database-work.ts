// The work pane of the database screen (D-3): the tables of the database that was pressed last, with their estimated rows, size and engine.
// Drawing only. A table that was pressed in the tree is marked here and nothing else changes: the tabs of records, structure and SQL come in the branch of `state.table` (#633 to #635).
import type { DatabaseTable } from "./bindings/DatabaseTable";
import { $, tag } from "./dom.js";

export interface WorkState {
  database: string;
  loading: boolean;
  error: string | null;
  tables: DatabaseTable[];
  // The table that was pressed in the tree, or none.
  table: string | null;
}

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
    tr.dataset.table = t.name;
    tr.setAttribute("aria-selected", String(state.table === t.name));
    tr.append(tag("td", "", t.name), tag("td", "num", t.rows), tag("td", "num", t.size), tag("td", "", t.engine));
    body.append(tr);
  }
  table.append(body);
  return table;
}

export function drawDatabaseWork(state: WorkState | null) {
  const key = JSON.stringify(state);
  if (key === drawn) return;
  drawn = key;
  const box = $("database-work");
  if (state === null) return box.replaceChildren();
  const title = tag("h3", "database-work-title", state.database);
  const nodes: Node[] = [title];
  if (state.loading) {
    const note = tag("p", "database-note", "読み込み中…");
    note.setAttribute("role", "status");
    nodes.push(note);
  } else if (state.error !== null) {
    const note = tag("p", "database-note danger", state.error);
    note.setAttribute("role", "alert");
    nodes.push(note);
  } else if (state.tables.length > 0) {
    nodes.push(tableNode(state));
  }
  box.replaceChildren(...nodes);
}
