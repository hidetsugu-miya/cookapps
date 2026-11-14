// The panes of the work pane of the Orca screen (A-17), drawn in `#orca-panes` from a tree: a pane (its tab strip, its plus, a line that says why it shows no terminal, and the host elements of its terminal and of its editor), or a split of panes side by side or one above the other.
// The button of the file pane (A-18) is at the right end of the strip of the pane in the top right corner of the work pane.
// While the list of projects is closed (A-23), the button that opens it is at the left end of the strip of the pane at the left edge.
// Between two nodes of a split is a divider (`.orca-divider`), and each node is as large as its share of the split.
// This module only draws and takes the user's operations: a tab dragged by the pointer (an edge of a pane splits it, its tab strip or its middle joins its tabs), a divider dragged by the pointer (the two nodes beside it follow the pointer, and the release names the ratio), and the pane that was pressed. What an operation does to the layout is decided in Rust (`orca_panes`).
// The pane elements are kept from one drawing to the next while their pane stays, so a terminal in a pane is not made again when the tree changes elsewhere; the structure is built again only when the tree's shape changes.
import type { Direction } from "./bindings/Direction";
import type { Edge } from "./bindings/Edge";
import { tag } from "./dom.js";
import { FOLDER_SVG } from "./icons.js";
import { drawListToggle, listToggle } from "./list-toggle.js";

const PLUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
// How far from an edge of a pane's body a tab dropped there splits the pane (a share of the body's size), and how far the pointer goes before a press is a drag (px).
const EDGE_SHARE = 0.25;
const DRAG_PX = 5;
// The shares of a split are drawn as `flex-grow`, times this (so that rounding never leaves them under 1, which would leave room unused).
const GROW = 100;
// The least share of its split that a divider dragged leaves a node while it is drawn: `MIN_SHARE` of `orca_panes.rs`, which decides the ratio that is kept, so the release does not move the divider.
const MIN_SHARE = 0.1;

// A pane to draw: its strip's tabs (made only when `key` changed since the last drawing), whether it has the focus, the line under the strip (null: none), whether its terminal shows, whether its editor shows, whether its plus is off, whether the file pane is shown (the button of the pane in the corner is pressed), and whether the list of projects is open (the button of the pane at the left edge shows while it is not).
export interface PaneModel {
  id: string;
  key: string;
  tabs: () => HTMLElement[];
  focused: boolean;
  empty: string | null;
  terminal: boolean;
  editor: boolean;
  plusDisabled: boolean;
  filesShown: boolean;
  listOpen: boolean;
}
// A split has the share of its size that each child takes (`sizes`, in the order of `children`).
export type TreeModel = { kind: "pane"; pane: PaneModel } | { kind: "split"; direction: Direction; children: TreeModel[]; sizes: number[] };

// What the user does in the panes.
export interface TreeHandlers {
  // The plus of the pane was pressed (the pane takes the focus first).
  plus: (anchor: Element, pane: string) => void;
  // The button of the file pane was pressed.
  files: () => void;
  // The button that opens the list of projects was pressed.
  list: () => void;
  // The pane was pressed, or one of its tabs was.
  focus: (pane: string) => void;
  // The tab was dropped on the pane at the edge.
  move: (tab: string, pane: string, edge: Edge) => void;
  // The divider between the node that holds the pane `before` and the next one, which holds `after`, was dragged: the first takes `share` of the size the two have together.
  resize: (before: string, after: string, share: number) => void;
  // The menu of the tab (the right button).
  menu: (anchor: Element, tab: string, pane: string) => void;
}

interface PaneEl {
  el: HTMLElement;
  tabbar: HTMLElement;
  strip: HTMLElement;
  plus: HTMLButtonElement;
  files: HTMLButtonElement;
  list: HTMLButtonElement;
  empty: HTMLElement;
  host: HTMLElement;
  editor: HTMLElement;
  key: string | null;
  tabCount: number;
}

const paneEls = new Map<string, PaneEl>();
let handlers: TreeHandlers;
let root: HTMLElement;
// The shape last built, so that a drawing of the same shape only updates the panes.
let shape = "";
// The hint of where the tab dragged would go.
let hint: HTMLElement | null = null;
// Ends the drag of a divider that is going on, leaving the sizes as they are (null: none is dragged).
let stopResize: (() => void) | null = null;

const shapeOf = (tree: TreeModel): unknown => (tree.kind === "pane" ? tree.pane.id : [tree.direction, tree.children.map(shapeOf)]);

function newPane(id: string): PaneEl {
  const el = tag("div", "orca-pane");
  el.dataset.pane = id;
  const tabbar = tag("div", "orca-tabbar");
  tabbar.setAttribute("data-tauri-drag-region", "");
  const strip = tag("div", "orca-tabs");
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", "セッション");
  const plus = tag("button", "icon-btn orca-plus");
  plus.type = "button";
  plus.setAttribute("aria-label", "セッションを始める");
  plus.setAttribute("aria-haspopup", "menu");
  plus.innerHTML = PLUS_SVG;
  plus.onclick = () => handlers.plus(plus, id);
  const files = tag("button", "icon-btn orca-files-toggle");
  files.type = "button";
  files.setAttribute("aria-label", "ファイル欄");
  files.innerHTML = FOLDER_SVG;
  files.onclick = () => handlers.files();
  const list = listToggle("プロジェクト一覧", () => handlers.list());
  tabbar.append(list, strip, plus, files);
  const empty = tag("p", "orca-empty feed-empty");
  empty.hidden = true;
  const host = tag("div", "orca-term");
  host.hidden = true;
  const editor = tag("div", "orca-edit-host");
  editor.hidden = true;
  el.append(tabbar, empty, host, editor);
  // Pressing anywhere in a pane gives it the focus (capturing: the terminal and the tabs take the press themselves).
  el.addEventListener("pointerdown", () => handlers.focus(id), true);
  // Focus that moves into a pane by the keyboard gives it the focus too (the terminal that is shown takes the keyboard after a press, which is the same pane).
  el.addEventListener("focusin", () => handlers.focus(id));
  strip.addEventListener("pointerdown", (e) => startDrag(e, id));
  strip.addEventListener("contextmenu", (e) => {
    const tab = (e.target as Element).closest<HTMLElement>("[data-tab]");
    if (!tab) return;
    e.preventDefault();
    handlers.menu(tab, tab.dataset.tab!, id);
  });
  return { el, tabbar, strip, plus, files, list, empty, host, editor, key: null, tabCount: 0 };
}

// Updates a pane's own parts from its model.
function drawPane(p: PaneEl, m: PaneModel, corner: boolean, edge: boolean) {
  p.el.dataset.focused = String(m.focused);
  if (p.key !== m.key) {
    p.key = m.key;
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-tab]")?.dataset.tab;
    const tabs = m.tabs();
    p.tabCount = tabs.length;
    p.strip.replaceChildren(...tabs);
    if (focused) p.strip.querySelector<HTMLElement>(`[data-tab="${CSS.escape(focused)}"] .orca-tab-btn`)?.focus({ preventScroll: true });
  }
  p.empty.hidden = m.empty === null;
  p.empty.textContent = m.empty ?? "";
  p.host.hidden = !m.terminal;
  p.editor.hidden = !m.editor;
  p.plus.disabled = m.plusDisabled;
  // While the file pane is shown, its own top row has the button (A-18), so the corner pane has none.
  p.files.hidden = !corner || m.filesShown;
  p.files.setAttribute("aria-pressed", String(m.filesShown));
  p.list.hidden = !edge || m.listOpen;
  drawListToggle(p.list, m.listOpen);
}

function build(tree: TreeModel): HTMLElement {
  if (tree.kind === "pane") return paneEls.get(tree.pane.id)!.el;
  const node = tag("div", "orca-split-node");
  node.dataset.direction = tree.direction;
  tree.children.forEach((child, i) => {
    if (i > 0) node.append(divider(tree.direction, leftEdge(tree.children[i - 1]).id, leftEdge(child).id));
    node.append(build(child));
  });
  return node;
}

// Gives each node of the splits its share of the size, on the elements `build` made (a split's children and its dividers in turn).
function drawSizes(tree: TreeModel, el: HTMLElement) {
  if (tree.kind === "pane") return;
  tree.children.forEach((child, i) => {
    const part = el.children[i * 2] as HTMLElement;
    part.style.flexGrow = String((tree.sizes[i] ?? 1 / tree.children.length) * GROW);
    drawSizes(child, part);
  });
}

function paneModels(tree: TreeModel): PaneModel[] {
  return tree.kind === "pane" ? [tree.pane] : tree.children.flatMap(paneModels);
}

// The pane in the top right corner: the last one of a row of panes, the first of a column, down to a pane.
function corner(tree: TreeModel): PaneModel {
  if (tree.kind === "pane") return tree.pane;
  return corner(tree.direction === "row" ? tree.children[tree.children.length - 1] : tree.children[0]);
}

// The pane at the left edge: the first of a row of panes and the first of a column, down to a pane.
function leftEdge(tree: TreeModel): PaneModel {
  return tree.kind === "pane" ? tree.pane : leftEdge(tree.children[0]);
}

// Draws the tree, and gives the host elements of the panes by pane id (the terminals are placed in them).
export function drawTree(tree: TreeModel): Map<string, HTMLElement> {
  const models = paneModels(tree);
  const ids = new Set(models.map((m) => m.id));
  for (const id of [...paneEls.keys()]) if (!ids.has(id)) paneEls.delete(id);
  for (const m of models) if (!paneEls.has(m.id)) paneEls.set(m.id, newPane(m.id));
  const next = JSON.stringify(shapeOf(tree));
  if (next !== shape) {
    shape = next;
    stopResize?.();
    root.replaceChildren(build(tree));
    root.dataset.multi = String(models.length > 1);
  }
  // A drawing in the middle of a drag leaves the sizes to the drag.
  if (stopResize === null) {
    const top = root.firstElementChild as HTMLElement;
    top.style.flexGrow = "";
    drawSizes(tree, top);
  }
  const top = corner(tree);
  const left = leftEdge(tree);
  for (const m of models) drawPane(paneEls.get(m.id)!, m, m === top, m === left);
  return new Map(models.map((m) => [m.id, paneEls.get(m.id)!.host]));
}

// The host element of the editor of a pane drawn (null: no such pane).
export const editorHostOf = (id: string) => paneEls.get(id)?.editor ?? null;

// ---- dragging a tab ----

// Where the pointer would drop the tab `tab` of the pane `from`: the pane under it, and the edge (a pane's strip and the middle of its body are the center). null: not on a pane, or the drop would change nothing.
function dropAt(x: number, y: number, from: string): { pane: string; edge: Edge; rect: DOMRect } | null {
  for (const [id, p] of paneEls) {
    const box = p.el.getBoundingClientRect();
    if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) continue;
    const bar = p.tabbar.getBoundingClientRect();
    const body = new DOMRect(box.left, bar.bottom, box.width, Math.max(1, box.bottom - bar.bottom));
    let edge: Edge = "center";
    if (y >= bar.bottom) {
      const fx = (x - body.left) / body.width;
      const fy = (y - body.top) / body.height;
      const near: [Edge, number][] = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]];
      const [nearest, share] = near.reduce((a, b) => (b[1] < a[1] ? b : a));
      if (share < EDGE_SHARE) edge = nearest;
    }
    // Its own pane: only an edge of a pane with other tabs changes anything.
    if (id === from && (edge === "center" || p.tabCount < 2)) return null;
    const half = (r: DOMRect): DOMRect =>
      edge === "left" ? new DOMRect(r.left, r.top, r.width / 2, r.height) : edge === "right" ? new DOMRect(r.left + r.width / 2, r.top, r.width / 2, r.height) : edge === "top" ? new DOMRect(r.left, r.top, r.width, r.height / 2) : new DOMRect(r.left, r.top + r.height / 2, r.width, r.height / 2);
    return { pane: id, edge, rect: edge === "center" ? box : half(body) };
  }
  return null;
}

function showHint(rect: DOMRect | null) {
  if (!rect) {
    hint?.remove();
    hint = null;
    return;
  }
  if (!hint) {
    hint = tag("div", "orca-drop");
    document.body.append(hint);
  }
  Object.assign(hint.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

// A press on a tab of the strip of the pane `from` that moves past a few pixels drags the tab; the release drops it (the pointer's pane and edge), and Escape or a cancel leaves it where it was.
function startDrag(down: PointerEvent, from: string) {
  const wrap = (down.target as Element).closest<HTMLElement>("[data-tab]");
  if (down.button !== 0 || !wrap || (down.target as Element).closest(".orca-tab-close")) return;
  const tab = wrap.dataset.tab!;
  let dragging = false;
  const end = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", key);
    document.body.classList.remove("orca-dragging");
    showHint(null);
  };
  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_PX) return;
      dragging = true;
      document.body.classList.add("orca-dragging");
    }
    showHint(dropAt(e.clientX, e.clientY, from)?.rect ?? null);
  };
  const up = (e: PointerEvent) => {
    end();
    if (!dragging) return;
    // The click that follows the release would select the tab.
    const swallow = (c: Event) => c.stopPropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    const target = dropAt(e.clientX, e.clientY, from);
    if (target) handlers.move(tab, target.pane, target.edge);
  };
  const cancel = () => end();
  const key = (e: KeyboardEvent) => e.key === "Escape" && end();
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", key);
}

// ---- dragging a divider ----

// The divider between two nodes of a split, drawn as the divider of the screen's parts is (`ts/split.ts`). `before` and `after` are a pane of the node on each side, which name it to Rust.
function divider(direction: Direction, before: string, after: string): HTMLElement {
  const bar = tag("div", "orca-divider");
  bar.setAttribute("role", "separator");
  bar.setAttribute("aria-orientation", direction === "row" ? "vertical" : "horizontal");
  bar.append(tag("span"));
  bar.onpointerdown = (down) => startResize(down, bar, direction, before, after);
  return bar;
}

// A press on a divider drags it: the two nodes beside it follow the pointer (the others keep their size), each keeping the least share, and the release gives the ratio to Rust. A cancel puts the sizes back.
// The drag goes on with pointer events on the document, so it does not end when the pointer leaves the divider; the boxes are read once, and the writes are gathered into one per animation frame.
function startResize(down: PointerEvent, bar: HTMLElement, direction: Direction, before: string, after: string) {
  const first = bar.previousElementSibling as HTMLElement | null;
  const second = bar.nextElementSibling as HTMLElement | null;
  if (down.button !== 0 || !first || !second) return;
  down.preventDefault();
  stopResize?.();
  const pointer = down.pointerId;
  const row = direction === "row";
  const at = (e: PointerEvent) => (row ? e.clientX : e.clientY);
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  const start = row ? a.left : a.top;
  const size = row ? a.width : a.height;
  const room = size + (row ? b.width : b.height);
  // Where in the divider it was pressed, so that the press alone moves nothing.
  const grab = at(down) - (start + size);
  const was = [first.style.flexGrow, second.style.flexGrow];
  const both = Number(was[0]) + Number(was[1]);
  const least = Math.min(MIN_SHARE * GROW, both / 2);
  let moved = false;
  let pending: number | null = null;
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (pending === null) return;
    const grow = Math.min(both - least, Math.max(least, pending * both));
    first.style.flexGrow = String(grow);
    second.style.flexGrow = String(both - grow);
    pending = null;
    moved = true;
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointer || room <= 0) return;
    pending = (at(e) - grab - start) / room;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    stopResize = null;
    delete root.dataset.resizing;
    delete bar.dataset.dragging;
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    flush();
    stop();
    if (moved) handlers.resize(before, after, Number(first.style.flexGrow) / both);
  };
  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    stop();
    [first.style.flexGrow, second.style.flexGrow] = was;
  };
  stopResize = stop;
  root.dataset.resizing = direction;
  bar.dataset.dragging = "true";
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancel, true);
}

export function initPaneTree(host: HTMLElement, on: TreeHandlers) {
  root = host;
  handlers = on;
}
