// The tree of the connections (D-1, D-3), which the side menu of the database screen (database.ts) and the database part of the file pane of the Orca screen (A-43, orca-database.ts) draw into a box each: the connections by name, each with a menu that a right press opens (edit, disconnect, delete), and under an open connection its databases, each with a menu of its own (new query, close the database), and under an open database its tables. An item of a menu whose action the screen does not give is not in the menu, and a menu with no item does not open.
// Drawing only: what is held and what each press does belong to the screen. A box is drawn again only when what it shows changes, and the focus stays.
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import { tag } from "./dom.js";
import { CHEVRON_SVG, CLOSE_SVG, CODE_SVG, DATABASE_SVG, DELETE_SVG, EDIT_SVG } from "./icons.js";
import { openMenu } from "./menu.js";

export interface DatabaseNode {
  name: string;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  // The names of its tables.
  tables: string[];
}

export interface ConnectionNode {
  profile: DatabaseProfileView;
  expanded: boolean;
  // The connection is open (Rust holds its session): the dot is on.
  connected: boolean;
  loading: boolean;
  // The last line of the script's output while the connection opens, or none.
  output: string | null;
  error: string | null;
  databases: DatabaseNode[];
}

export interface Selected {
  id: string;
  database: string | null;
  table: string | null;
}

export interface SideState {
  connections: ConnectionNode[];
  // The row that was pressed last, or none.
  selected: Selected | null;
}

export interface SideActions {
  pressConnection: (profile: DatabaseProfileView) => void;
  pressDatabase: (profile: DatabaseProfileView, database: string) => void;
  pressTable: (profile: DatabaseProfileView, database: string, table: string) => void;
  // Selects the database and opens its SQL tab with an empty field.
  newQuery?: (profile: DatabaseProfileView, database: string) => void;
  // Closes the tree of the database; the connection stays open.
  closeDatabase: (profile: DatabaseProfileView, database: string) => void;
  edit?: (profile: DatabaseProfileView) => void;
  disconnect: (profile: DatabaseProfileView) => void;
  // `anchor` is the name of the row, which the confirmation opens under.
  remove?: (profile: DatabaseProfileView, anchor: Element) => void;
}

// What each box shows now.
const drawn = new WeakMap<HTMLElement, string>();

function row(key: string, depth: number, pressed: boolean, expanded: boolean | null, icon: string | null, name: string, onclick: () => void) {
  const button = tag("button", "database-btn");
  button.type = "button";
  button.dataset.key = key;
  button.style.setProperty("--depth", String(depth));
  button.setAttribute("aria-pressed", String(pressed));
  if (expanded !== null) button.setAttribute("aria-expanded", String(expanded));
  button.onclick = onclick;
  const mark = tag("span", "database-mark");
  if (expanded !== null) mark.innerHTML = CHEVRON_SVG;
  const ic = tag("span", "database-ic");
  if (icon) ic.innerHTML = icon;
  button.append(mark, ic, tag("span", "database-name", name));
  return button;
}

// The dot of a connection: green while it is open, orange while it opens, gray otherwise. Its label says which.
function dotNode(node: ConnectionNode) {
  const state = node.connected ? "connected" : node.loading ? "connecting" : "closed";
  const dot = tag("span", "database-dot");
  dot.dataset.state = state;
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", { connected: "接続済み", connecting: "接続しています", closed: "未接続" }[state]);
  return dot;
}

function note(text: string, depth: number, failed: boolean) {
  const line = tag("p", `database-note${failed ? " danger" : ""}`, text);
  line.style.setProperty("--depth", String(depth));
  line.setAttribute("role", failed ? "alert" : "status");
  return line;
}

function databaseNodes(node: ConnectionNode, selected: Selected | null, actions: SideActions) {
  const id = node.profile.id;
  return node.databases.flatMap((db) => {
    const here = selected?.id === id && selected.database === db.name;
    const button = row(`${id}/d/${db.name}`, 1, here && selected?.table === null, db.expanded, null, db.name, () => actions.pressDatabase(node.profile, db.name));
    // The menu is anchored on the name, as the connection's is.
    const name = button.querySelector(".database-name")!;
    const { newQuery } = actions;
    button.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu(
        name,
        [
          ...(newQuery ? [{ label: "新規クエリ", color: "", icon: CODE_SVG, current: false, pick: () => newQuery(node.profile, db.name) }] : []),
          { label: "データベースを閉じる", color: "", icon: CLOSE_SVG, current: false, pick: () => actions.closeDatabase(node.profile, db.name) },
        ],
        { at: { x: e.clientX, y: e.clientY } },
      );
    };
    const out: Node[] = [button];
    if (db.expanded) {
      if (db.loading) out.push(note("読み込み中…", 2, false));
      if (db.error !== null) out.push(note(db.error, 2, true));
      for (const table of db.tables) out.push(row(`${id}/d/${db.name}/t/${table}`, 2, here && selected?.table === table, null, null, table, () => actions.pressTable(node.profile, db.name, table)));
    }
    return out;
  });
}

function itemNode(node: ConnectionNode, selected: Selected | null, actions: SideActions) {
  const profile = node.profile;
  const item = tag("div", "database-item");
  const button = row(profile.id, 0, selected?.id === profile.id && selected.database === null, node.expanded, DATABASE_SVG, profile.name, () => actions.pressConnection(profile));
  button.append(dotNode(node));
  // The menu is anchored on the name, not on the button, which carries the aria-expanded of its tree.
  const name = button.querySelector(".database-name")!;
  const { edit, remove } = actions;
  button.oncontextmenu = (e) => {
    e.preventDefault();
    const items = [
      ...(edit ? [{ label: "編集", color: "", icon: EDIT_SVG, current: false, pick: () => edit(profile) }] : []),
      ...(node.connected ? [{ label: "切断", color: "", icon: CLOSE_SVG, current: false, pick: () => actions.disconnect(profile) }] : []),
      ...(remove ? [{ label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, pick: () => remove(profile, name) }] : []),
    ];
    if (items.length > 0) openMenu(name, items, { at: { x: e.clientX, y: e.clientY } });
  };
  item.append(button);
  if (node.expanded) {
    const children = tag("div", "database-children");
    if (node.loading) children.append(note(node.connected ? "読み込み中…" : (node.output ?? "接続中…"), 1, false));
    if (node.error !== null) children.append(note(node.error, 1, true));
    children.append(...databaseNodes(node, selected, actions));
    item.append(children);
  }
  return item;
}

export function drawDatabaseSide(box: HTMLElement, state: SideState, actions: SideActions) {
  const key = JSON.stringify(state);
  if (key === drawn.get(box)) return;
  drawn.set(box, key);
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  box.replaceChildren(...state.connections.map((c) => itemNode(c, state.selected, actions)));
  box.scrollTop = top;
  if (focused) box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
