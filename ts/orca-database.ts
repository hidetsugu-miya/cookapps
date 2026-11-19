// The database part of the file pane of the Orca screen (A-43): the connections of the database screen (D-1) as the tree of D-3, in the fourth part of the pane. A press on a connection opens it (`database_connect`) and lists its databases, a press on a database lists its tables (`database_tables`), as the side menu of the database screen does; the tree is drawn by the same module (database-side.ts). A press on a table selects its row and opens it as a tab of the work pane.
// This module holds the list that `database_profiles` last answered and what each connection has opened here; the database screen holds its own (database.ts), and the two share only Rust's sessions (a connection opened in one is open in the other, and a press here reads again). The menus have no edit and no delete (the edit pane belongs to the database screen).
// The list and the open connections (`database_connections`) are read each time the part is shown, and nothing is read at an interval.
// A press on a table, and 「新規クエリ」 of a database, open a tab of the work pane (A-43, orca-database-tabs.ts), which the screen makes (`hooks`); a connection that is disconnected, deleted from the list or closed by Rust takes its tabs with it (`gone`).
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import type { DatabaseScriptOutput } from "./bindings/DatabaseScriptOutput";
import { drawDatabaseSide, showScriptOutput, type Selected, type SideActions, type SideState } from "./database-side.js";
import { $ } from "./dom.js";
import { logError, showFailure } from "./error-card.js";
import { invoke } from "./ipc.js";

interface DatabaseState {
  expanded: boolean;
  loading: boolean;
  error: string | null;
  tables: string[];
}

// What a connection has opened here. It is dropped when the connection is closed or gone from the list.
interface ConnectionState {
  expanded: boolean;
  connected: boolean;
  loading: boolean;
  // The last line of the output of the connection's script while it opens (D-3, #1027), or none.
  output: string | null;
  error: string | null;
  databases: string[];
  byName: Map<string, DatabaseState>;
}

// What the screen does for the part: opens the tab of a table or the SQL tab of a database in the work pane, and closes the tabs of a connection that is not open any more.
interface Handlers {
  table: (profile: DatabaseProfileView, database: string, table: string) => void;
  query: (profile: DatabaseProfileView, database: string) => void;
  gone: (id: string) => void;
}
let hooks: Handlers = { table: () => {}, query: () => {}, gone: () => {} };

let profiles: DatabaseProfileView[] = [];
let selected: Selected | null = null;
const connections = new Map<string, ConnectionState>();
// The connections whose disconnect is on its way: a press on them waits.
const closing = new Set<string>();
// The newest read of the list: an older one that ends later is dropped.
let loadSeq = 0;
// Whether the part is shown (the pane shown with this part chosen).
let on = false;

const emptyConnection = (): ConnectionState => ({ expanded: false, connected: false, loading: false, output: null, error: null, databases: [], byName: new Map() });
const databaseOf = (c: ConnectionState, name: string) => {
  let d = c.byName.get(name);
  if (!d) {
    d = { expanded: false, loading: false, error: null, tables: [] };
    c.byName.set(name, d);
  }
  return d;
};

function sideState(): SideState {
  return {
    selected,
    connections: profiles.map((profile) => {
      const c = connections.get(profile.id) ?? emptyConnection();
      return {
        profile,
        expanded: c.expanded,
        connected: c.connected,
        loading: c.loading,
        output: c.output,
        error: c.error,
        databases: c.databases.map((name) => {
          const d = databaseOf(c, name);
          return { name, expanded: d.expanded, loading: d.loading, error: d.error, tables: d.tables };
        }),
      };
    }),
  };
}

const draw = () => drawDatabaseSide($("orca-database"), sideState(), actions);

// Reads the connections and the ids that Rust holds open, and draws them. A connection that Rust holds open and this part has no state of is marked connected (its row stays closed); one that Rust closed loses what it opened; one gone from the list loses its state.
async function read() {
  const seq = ++loadSeq;
  try {
    const [list, open] = await Promise.all([invoke("database_profiles"), invoke("database_connections")]);
    if (seq !== loadSeq) return;
    profiles = list;
    for (const id of [...connections.keys()]) {
      if (list.some((p) => p.id === id)) continue;
      connections.delete(id);
      hooks.gone(id);
    }
    for (const [id, c] of connections) {
      if (!c.connected || c.loading || open.includes(id)) continue;
      connections.delete(id);
      hooks.gone(id);
    }
    for (const p of list) {
      if (!open.includes(p.id)) continue;
      const c = connections.get(p.id) ?? emptyConnection();
      c.connected = true;
      connections.set(p.id, c);
    }
    if (selected !== null && !list.some((p) => p.id === selected?.id)) selected = null;
    draw();
  } catch (e) {
    if (seq === loadSeq) logError("orca-database", e);
  }
}

// Closes the trees of the connections that Rust no longer holds open (a stream that broke); answers the ids dropped.
async function dropClosed(): Promise<string[]> {
  let open: string[];
  try {
    open = await invoke("database_connections");
  } catch {
    return [];
  }
  const dropped = [...connections].filter(([id, c]) => c.connected && !open.includes(id)).map(([id]) => id);
  for (const id of dropped) {
    connections.delete(id);
    hooks.gone(id);
    if (selected?.id === id) selected = { id, database: null, table: null };
  }
  if (dropped.length > 0) draw();
  return dropped;
}

// A read of a tab of the work pane showed the stream of the connection broken: when Rust closed it, its tree closes and says why, and its tabs close.
export async function lostConnection(id: string, error: string) {
  if (!(await dropClosed()).includes(id)) return;
  connections.set(id, { ...emptyConnection(), expanded: true, error });
  draw();
}

// Opens the connection (when it is not open) and reads its databases.
async function openConnection(profile: DatabaseProfileView) {
  const c = connections.get(profile.id) ?? emptyConnection();
  connections.set(profile.id, c);
  c.expanded = true;
  c.loading = true;
  c.output = null;
  c.error = null;
  draw();
  try {
    const names = await invoke("database_connect", { id: profile.id });
    // The connection was deleted while it opened: Rust holds a session that no row shows.
    if (!profiles.some((p) => p.id === profile.id)) {
      invoke("database_disconnect", { id: profile.id }).catch((e) => logError("orca-database", e));
      return;
    }
    if (connections.get(profile.id) !== c) return;
    c.connected = true;
    c.databases = names;
    for (const name of [...c.byName.keys()]) if (!names.includes(name)) c.byName.delete(name);
  } catch (e) {
    if (connections.get(profile.id) !== c) return;
    c.connected = false;
    c.databases = [];
    c.byName.clear();
    c.error = String(e);
    hooks.gone(profile.id);
  }
  c.loading = false;
  c.output = null;
  draw();
}

async function openDatabase(profile: DatabaseProfileView, c: ConnectionState, name: string) {
  const d = databaseOf(c, name);
  d.expanded = true;
  d.loading = true;
  d.error = null;
  draw();
  try {
    const tables = await invoke("database_tables", { id: profile.id, database: name });
    if (connections.get(profile.id) !== c) return;
    d.tables = tables.map((t) => t.name);
  } catch (e) {
    if (connections.get(profile.id) !== c) return;
    d.tables = [];
    d.error = String(e);
    // A stream that broke closes the connection: its tree closes and says why.
    if ((await dropClosed()).includes(profile.id)) {
      connections.set(profile.id, { ...emptyConnection(), expanded: true, error: d.error });
      draw();
      return;
    }
  }
  d.loading = false;
  draw();
}

const actions: SideActions = {
  // A row that is closed opens (and is read again); one that is open closes and stays connected; one that failed tries again; one that is being read waits.
  pressConnection: (profile) => {
    selected = { id: profile.id, database: null, table: null };
    const c = connections.get(profile.id);
    if (closing.has(profile.id) || c?.loading) return draw();
    if (c?.expanded && c.error === null) {
      c.expanded = false;
      return draw();
    }
    void openConnection(profile);
  },
  pressDatabase: (profile, name) => {
    selected = { id: profile.id, database: name, table: null };
    const c = connections.get(profile.id);
    if (!c) return draw();
    const d = databaseOf(c, name);
    if (d.loading) return draw();
    if (d.expanded && d.error === null) {
      d.expanded = false;
      return draw();
    }
    void openDatabase(profile, c, name);
  },
  // The table opens as a tab of the work pane.
  pressTable: (profile, database, table) => {
    selected = { id: profile.id, database, table };
    draw();
    hooks.table(profile, database, table);
  },
  // The SQL of the database opens as a tab of the work pane.
  newQuery: (profile, database) => {
    selected = { id: profile.id, database, table: null };
    draw();
    hooks.query(profile, database);
  },
  // The tree of the database closes and the connection stays.
  closeDatabase: (profile, database) => {
    const d = connections.get(profile.id)?.byName.get(database);
    if (d) d.expanded = false;
    if (selected?.id === profile.id && selected.database === database) selected = { id: profile.id, database: null, table: null };
    draw();
  },
  disconnect: async (profile) => {
    connections.delete(profile.id);
    hooks.gone(profile.id);
    if (selected?.id === profile.id) selected = { id: profile.id, database: null, table: null };
    closing.add(profile.id);
    draw();
    try {
      await invoke("database_disconnect", { id: profile.id });
    } catch (e) {
      showFailure("orca-database", e);
    }
    closing.delete(profile.id);
  },
};

// Told whether the part is shown: it reads the connections when it comes to be shown.
export function syncOrcaDatabase(shown: boolean) {
  if (shown && !on) void read();
  on = shown;
}

export function initOrcaDatabase(handlers: Handlers) {
  hooks = handlers;
  // Rust tells each line that the script of a connection writes while the connection opens (D-3). A line for a connection that is not opening here is dropped.
  window.__TAURI__.event.listen<DatabaseScriptOutput>("database-script-output", ({ payload }) => {
    const c = connections.get(payload.id);
    if (c === undefined || !c.loading) return;
    c.output = payload.line;
    if (!showScriptOutput($("orca-database"), payload.id, payload.line)) draw();
  });
}
