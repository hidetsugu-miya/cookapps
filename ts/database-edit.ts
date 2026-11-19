// What the records tab has gathered and not sent yet (D-10): the cells that were rewritten, the rows marked to be deleted and the rows that were added. Nothing here is sent to the database; `changesOf` words it for `database_apply` when the screen's ✓ is pressed.
// The rows are the places in the page that is shown: the page does not change while something is gathered (D-10), so a place always names the same row. The rows that were added follow the rows of the page: the place of the added row `k` is `rows.length + k`.
import type { DatabaseChange } from "./bindings/DatabaseChange";
import type { DatabaseRecords } from "./bindings/DatabaseRecords";

export interface EditState {
  // The new text of each cell that was rewritten, by "{row}:{column}" (places counted from 0).
  cells: Record<string, string>;
  // The rows marked to be deleted, in order.
  deleted: number[];
  // The rows that were added, in order: for each, the value of the columns that were filled, by the number of the column: the text, or null for NULL. A column that is not there is left to the table (自動).
  added: Record<string, string | null>[];
  // The rows that were pressed, in order.
  selected: number[];
  // ✓ was pressed and the answer has not come.
  applying: boolean;
}

export const emptyEdit = (): EditState => ({ cells: {}, deleted: [], added: [], selected: [], applying: false });

export const cellKey = (row: number, column: number) => `${row}:${column}`;

// Whether the cell can be rewritten: Rust says that its row can be updated and that its value is whole (`edits`).
export const canEditCell = (data: DatabaseRecords, row: number, column: number) => data.edits[row]?.canChange === true && data.edits[row].cells[column] === true;

// The text a rewritten cell had before: a NULL starts as the empty text, because a field cannot hold NULL.
export const originalText = (data: DatabaseRecords, row: number, column: number) => (data.rows[row][column].kind === "null" ? "" : data.rows[row][column].text);

// Whether the place names a row that was added.
export const isAdded = (data: DatabaseRecords, row: number) => row >= data.rows.length;

// The changes for `database_apply`: an update for each row that has a rewritten cell, in the order of the rows, then a delete for each marked row, then an insert for each added row, in order. A row that is marked is only deleted. The key is the original value of the key's columns. An insert has only the columns that were filled (none at all is fine), and the inserts go last, so that a row can be added with the key of a row that is deleted.
export function changesOf(data: DatabaseRecords, edit: EditState): DatabaseChange[] {
  const deleted = new Set(edit.deleted);
  const key = (row: number) => data.key.map((column) => ({ column, value: data.rows[row][data.columns.indexOf(column)].text }));
  const changes: DatabaseChange[] = [];
  data.rows.forEach((_, row) => {
    if (deleted.has(row)) return;
    const values = data.columns.flatMap((column, i) => {
      const value = edit.cells[cellKey(row, i)];
      return value === undefined ? [] : [{ column, value }];
    });
    if (values.length > 0) changes.push({ kind: "update", key: key(row), values });
  });
  for (const row of [...deleted].sort((a, b) => a - b)) changes.push({ kind: "delete", key: key(row) });
  for (const filled of edit.added) {
    const values = data.columns.flatMap((column, i) => (filled[i] === undefined ? [] : [{ column, value: filled[i] }]));
    changes.push({ kind: "insert", values });
  }
  return changes;
}

// The rows that − works on: the pressed rows of the page that can be deleted and are not marked yet, and the pressed rows that were added, which − takes back.
export const markable = (data: DatabaseRecords, edit: EditState) =>
  edit.selected.filter((row) => (isAdded(data, row) ? row - data.rows.length < edit.added.length : data.key.length > 0 && data.edits[row]?.canChange === true && !edit.deleted.includes(row)));
