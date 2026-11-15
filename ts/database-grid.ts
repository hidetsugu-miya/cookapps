// The grid of values of the database screen (D-4): a table of cells that Rust already turned into text (`DatabaseCell`).
// The records tab draws a page with it, and the SQL tab draws its result with it (#635); nothing here turns a value into text.
import type { DatabaseCell } from "./bindings/DatabaseCell";
import { tag } from "./dom.js";

export function gridNode(columns: string[], rows: DatabaseCell[][]) {
  const table = tag("table", "database-grid");
  const head = tag("tr");
  for (const name of columns) head.append(tag("th", "", name));
  const thead = tag("thead");
  thead.append(head);
  const body = tag("tbody");
  for (const row of rows) {
    const tr = tag("tr");
    for (const cell of row) {
      const td = tag("td", "database-cell", cell.text);
      td.dataset.kind = cell.kind;
      // A text is cut in the cell by the width of the column; the title shows the text Rust kept.
      if (cell.kind === "text") td.title = cell.text;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(thead, body);
  return table;
}
