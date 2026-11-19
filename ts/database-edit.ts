// What the records tab has gathered and not sent yet (D-10): the cells that were rewritten and the rows marked to be deleted. Nothing here is sent to the database; `changesOf` words it for `database_apply` when the screen's ✓ is pressed.
// The rows are the places in the page that is shown: the page does not change while something is gathered (D-10), so a place always names the same row.
import type { DatabaseChange } from "./bindings/DatabaseChange";
import type { DatabaseRecords } from "./bindings/DatabaseRecords";

export interface EditState {
  // The new text of each cell that was rewritten, by "{row}:{column}" (places counted from 0).
  cells: Record<string, string>;
  // The rows marked to be deleted, in order.
  deleted: number[];
  // The rows that were pressed, in order.
  selected: number[];
  // ✓ was pressed and the answer has not come.
  applying: boolean;
}

export const emptyEdit = (): EditState => ({ cells: {}, deleted: [], selected: [], applying: false });

export const cellKey = (row: number, column: number) => `${row}:${column}`;

// Whether the cell can be rewritten: Rust says that its row can be updated and that its value is whole (`edits`).
export const canEditCell = (data: DatabaseRecords, row: number, column: number) => data.edits[row]?.canChange === true && data.edits[row].cells[column] === true;

// The text a rewritten cell had before: a NULL starts as the empty text, because a field cannot hold NULL.
export const originalText = (data: DatabaseRecords, row: number, column: number) => (data.rows[row][column].kind === "null" ? "" : data.rows[row][column].text);

// The changes for `database_apply`: an update for each row that has a rewritten cell, in the order of the rows, then a delete for each marked row. A row that is marked is only deleted. The key is the original value of the key's columns.
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
  return changes;
}

// The rows that − marks: the pressed rows that can be deleted and are not marked yet.
export const markable = (data: DatabaseRecords, edit: EditState) => edit.selected.filter((row) => data.key.length > 0 && data.edits[row]?.canChange === true && !edit.deleted.includes(row));
