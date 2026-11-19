// The grid of values of the database screen (D-4): a table of cells that Rust already turned into text (`DatabaseCell`).
// The records tab draws a page with it, the structure tab (D-5) draws its columns with it, and the SQL tab draws its result with it (#635); nothing here turns a value into text.
// A column is lined off from the next by a vertical line, and the grip at the right edge of its header changes its width (#669).
import type { DatabaseCell } from "./bindings/DatabaseCell";
import { composing, tag } from "./dom.js";

const MIN_WIDTH = 48;

// The widths the owner dragged, by grid (the key that the caller gives: the connection, the database, the table and the tab) and then by column (its place and name). They live in memory until the app closes and are written nowhere, so a page, a tab or a table that is left and opened again draws the columns as they were left.
const widths = new Map<string, Map<string, number>>();

// A column that has a width is cut at that width, with no upper limit; the width is the one of the whole cell, padding included.
function setWidth(cells: HTMLElement[], px: number) {
  for (const cell of cells) {
    cell.style.boxSizing = "border-box";
    cell.style.width = cell.style.minWidth = cell.style.maxWidth = `${px}px`;
  }
}

// The grip at the right edge of a header: dragged with pointer events on the document, so the drag goes on when the pointer leaves it. The writes of a drag are gathered into one per animation frame.
function gripOf(table: HTMLElement, th: HTMLElement, cells: HTMLElement[], remember: (px: number) => void) {
  const grip = tag("span", "database-grip");
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.onpointerdown = (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    down.stopPropagation();
    const pointer = down.pointerId;
    const start = th.getBoundingClientRect().width;
    let width = start;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (width !== start) setWidth(cells, width);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      width = Math.max(MIN_WIDTH, Math.round(start + e.clientX - down.clientX));
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      cancelAnimationFrame(frame);
      flush();
      if (width !== start) remember(width);
      table.classList.remove("resizing");
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
    };
    table.classList.add("resizing");
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
  };
  return grip;
}

// What the records tab adds to its grid (D-10): which cells can be rewritten, what was rewritten, the rows that are marked and pressed, and what a press and a rewrite do. The grid is made again for each draw, so these are read when it is made.
export interface GridEdit {
  editable: (row: number, column: number) => boolean;
  // The text a cell was rewritten to, or none.
  rewritten: (row: number, column: number) => string | undefined;
  // The text a field starts with: the one that is shown, and empty for a NULL.
  startText: (row: number, column: number) => string;
  deleted: (row: number) => boolean;
  selected: (row: number) => boolean;
  select: (row: number, add: boolean) => void;
  commit: (row: number, column: number, text: string) => void;
}

// The cell becomes a field: Enter (not the Enter of an IME conversion) and leaving the field keep the text, Escape gives the cell back as it was. A field that the draw takes away is not kept.
function editCell(td: HTMLElement, start: string, commit: (text: string) => void) {
  const shown = td.textContent ?? "";
  const input = tag("input", "database-cell-input");
  input.type = "text";
  input.value = start;
  input.spellcheck = false;
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    td.textContent = shown;
    if (keep) commit(input.value);
  };
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") {
      e.stopPropagation();
      finish(false);
    }
  };
  input.onblur = () => {
    if (input.isConnected) finish(true);
  };
  input.onclick = (e) => e.stopPropagation();
  td.replaceChildren(input);
  input.focus();
  input.select();
}

export function gridNode(columns: string[], rows: DatabaseCell[][], widthKey: string, edit?: GridEdit) {
  const table = tag("table", "database-grid");
  const columnCells: HTMLElement[][] = columns.map(() => []);
  const head = tag("tr");
  const kept = widths.get(widthKey);
  columns.forEach((name, i) => {
    const th = tag("th", "", name);
    columnCells[i].push(th);
    const id = `${i}:${name}`;
    th.append(
      gripOf(table, th, columnCells[i], (px) => {
        const sized = widths.get(widthKey) ?? new Map<string, number>();
        widths.set(widthKey, sized.set(id, px));
      }),
    );
    head.append(th);
  });
  const thead = tag("thead");
  thead.append(head);
  const body = tag("tbody");
  rows.forEach((row, r) => {
    const tr = tag("tr");
    if (edit) {
      tr.dataset.row = String(r);
      tr.classList.toggle("deleted", edit.deleted(r));
      tr.classList.toggle("selected", edit.selected(r));
      tr.onclick = (e) => edit.select(r, e.metaKey || e.ctrlKey);
    }
    row.forEach((cell, i) => {
      const rewritten = edit?.rewritten(r, i);
      const td = tag("td", "database-cell", rewritten ?? cell.text);
      // A NULL that was rewritten is a text now.
      td.dataset.kind = rewritten !== undefined && cell.kind === "null" ? "text" : cell.kind;
      if (rewritten !== undefined) td.classList.add("changed");
      if (edit?.editable(r, i) && !edit.deleted(r)) td.ondblclick = () => editCell(td, edit.startText(r, i), (text) => edit.commit(r, i, text));
      // A text is cut in the cell by the width of the column; the title shows the text Rust kept.
      if (rewritten !== undefined || cell.kind === "text") td.title = rewritten ?? cell.text;
      columnCells[i]?.push(td);
      tr.append(td);
    });
    body.append(tr);
  });
  columns.forEach((name, i) => {
    const px = kept?.get(`${i}:${name}`);
    if (px !== undefined) setWidth(columnCells[i], px);
  });
  table.append(thead, body);
  return table;
}
