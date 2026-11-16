// The database screen (D-1, D-3 to D-6): the connections at the left (the side menu), which open into their databases and tables, and at the right the work pane with the tables of the database that was pressed last, or the tabs (records, structure, SQL) of the table that was pressed.
// This module holds the list that `database_profiles` last answered, what each connection has opened and what is selected; the side menu and the work pane only draw it (database-side.ts, database-work.ts), and the edit pane (database-form.ts) only asks for the fields.
// Rust holds the open connections (the session and its script); an opening of a row reads again, so the tree is never kept apart from the server. The records and the structure of a table are held in memory for the table that was pressed last only, and the SQL text and result for the connection and database that were selected last.
import type { DatabaseProfile } from "./bindings/DatabaseProfile";
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import type { DatabaseTable } from "./bindings/DatabaseTable";
import { drawDatabaseSide, type Selected, type SideActions, type SideState } from "./database-side.js";
import { initDatabaseForm, openDatabaseForm } from "./database-form.js";
import { initDatabaseTerminal } from "./database-terminal.js";
import { drawDatabaseWork, focusSqlField, type RecordsState, type SqlState, type StructureState, type WorkActions, type WorkState } from "./database-work.js";
import { $ } from "./dom.js";
import { confirmDelete } from "./hint.js";
import { PLUS_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { initSplit } from "./split.js";
import { show, showError } from "./view.js";

interface DatabaseState {
  expanded: boolean;
  loading: boolean;
  error: string | null;
  tables: DatabaseTable[];
}

// What a connection has opened. It is dropped when the connection is closed, so a state that is held always belongs to a connection of the list.
interface ConnectionState {
  expanded: boolean;
  connected: boolean;
  loading: boolean;
  error: string | null;
  databases: string[];
  byName: Map<string, DatabaseState>;
}

// The structure of the table whose tab 構造 was pressed last, with the table it belongs to; dropped when another table is pressed.
interface StructureView extends StructureState {
  id: string;
  database: string;
  table: string;
}

// The records of the table that was pressed last, with the table they belong to. A read that ends after another press has replaced this is dropped.
interface RecordsView extends RecordsState {
  id: string;
  database: string;
  table: string;
}

// The SQL tab of a connection and database: what was typed and the result of the last run. It stays when another table of the same database is pressed, and is dropped when the tree selects another connection or database and the field is used.
interface SqlView extends SqlState {
  id: string;
  database: string;
}

let profiles: DatabaseProfileView[] = [];
let records: RecordsView | null = null;
let structure: StructureView | null = null;
let sql: SqlView | null = null;
// The selected tab of the table that is pressed. The table press selects the records.
let tab = "records";
// The selected tab of the database while no table is open. A press on another database, or on a table's database from its tabs, selects the tables.
let databaseTab = "tables";
let selected: Selected | null = null;
const connections = new Map<string, ConnectionState>();
// The connections whose disconnect is on its way: a press on them waits, so that an opening cannot meet the closing.
const closing = new Set<string>();
// The newest read: an older one that ends later is dropped.
let loadSeq = 0;

const emptyConnection = (): ConnectionState => ({ expanded: false, connected: false, loading: false, error: null, databases: [], byName: new Map() });
const emptySql: SqlState = { view: 0, text: "", loading: false, error: null, data: null };
// The number of the last SQL view made: a new query makes a new view, which is drawn again whatever was typed in the one before.
let sqlViews = 0;
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
        error: c.error,
        databases: c.databases.map((name) => {
          const d = databaseOf(c, name);
          return { name, expanded: d.expanded, loading: d.loading, error: d.error, tables: d.tables.map((t) => t.name) };
        }),
      };
    }),
  };
}

// The SQL tab of the selected connection and database: the view that belongs to them, or an empty one.
function sqlState(): SqlState {
  if (sql === null || sql.id !== selected?.id || sql.database !== selected.database) return emptySql;
  return { view: sql.view, text: sql.text, loading: sql.loading, error: sql.error, data: sql.data };
}

// The view of the SQL tab of the selected connection and database, made when none belongs to them; none when no database is selected.
function sqlView(): SqlView | null {
  if (selected?.database == null) return null;
  if (sql?.id !== selected.id || sql.database !== selected.database) sql = { id: selected.id, database: selected.database, ...emptySql, view: ++sqlViews };
  return sql;
}

// The tables of the database that was pressed last, or the tabs of the table that was pressed; none while a connection or a connection's databases are all that was pressed.
function workState(): WorkState | null {
  if (selected?.database == null) return null;
  const d = connections.get(selected.id)?.byName.get(selected.database);
  if (!d) return null;
  const mine = selected.table !== null && records?.id === selected.id && records.database === selected.database && records.table === selected.table;
  return {
    connection: selected.id,
    database: selected.database,
    loading: d.loading,
    error: d.error,
    tables: d.tables,
    databaseTab,
    table: mine ? selected.table : null,
    tab,
    records: mine && records ? { page: records.page, loading: records.loading, error: records.error, data: records.data } : null,
    sql: sqlState(),
    structure: mine && structure?.id === selected.id && structure.database === selected.database && structure.table === selected.table ? { loading: structure.loading, error: structure.error, data: structure.data } : null,
  };
}

const draw = () => {
  drawDatabaseSide(sideState(), actions);
  drawDatabaseWork(workState(), workActions);
};

// Reads the connections from Rust (the file and the keychain are the only copy) and draws them. Answers the list, or none when the read failed or a newer one replaced it. A `quiet` read (the edit pane's, at an interval) shows no error.
async function load(quiet = false): Promise<DatabaseProfileView[] | null> {
  const seq = ++loadSeq;
  try {
    const list = await invoke("database_profiles");
    if (seq !== loadSeq) return null;
    profiles = list;
    // A connection that is gone from the list has nothing open any more (Rust closed it with the delete).
    for (const id of [...connections.keys()]) if (!profiles.some((p) => p.id === id)) connections.delete(id);
    if (selected !== null && !profiles.some((p) => p.id === selected?.id)) selected = null;
    draw();
    return list;
  } catch (e) {
    if (seq === loadSeq && !quiet) showError(e);
    return null;
  }
}

// Drops what a connection shows when Rust no longer holds its session (a disconnect that was asked, an edit that closed it, a stream that broke); answers the ids dropped.
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
    if (selected?.id === id) selected = { id, database: null, table: null };
  }
  if (dropped.length > 0) draw();
  return dropped;
}

async function save(profile: DatabaseProfile, password: string) {
  const known = new Set(profiles.map((p) => p.id));
  let failure: unknown = null;
  try {
    await invoke("database_profile_save", { profile, password });
  } catch (e) {
    failure = e;
  }
  // Rust closes an edited connection that was open.
  if (profile.id !== "") await dropClosed();
  await load();
  if (failure === null) return;
  // Rust writes the file before the keychain, so a refusal of the keychain leaves the new connection saved: the edit pane would save it again as a new one. It closes, and the error is shown on the screen.
  if (profile.id === "" && profiles.some((p) => !known.has(p.id))) return showError(failure);
  throw failure;
}

// The version that the server of the connection as typed answers; Rust starts the script of the connection, logs in, reads it and ends the script.
const test = (profile: DatabaseProfile, password: string) => invoke("database_test", { profile, password });

async function remove(profile: DatabaseProfileView, anchor: Element) {
  confirmDelete(anchor, profile.name, async () => {
    try {
      await invoke("database_profile_delete", { id: profile.id });
    } catch (e) {
      showError(e);
    }
    await dropClosed();
    await load();
  });
}

// Opens the connection (when it is not open) and reads its databases.
async function openConnection(profile: DatabaseProfileView) {
  const c = connections.get(profile.id) ?? emptyConnection();
  connections.set(profile.id, c);
  c.expanded = true;
  c.loading = true;
  c.error = null;
  draw();
  try {
    const names = await invoke("database_connect", { id: profile.id });
    // The connection was deleted while it opened: Rust holds a session that no row shows.
    if (!profiles.some((p) => p.id === profile.id)) {
      invoke("database_disconnect", { id: profile.id }).catch(showError);
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
  }
  c.loading = false;
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
    d.tables = tables;
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

// Reads the page `page` of the records of a table (D-4), or, when `typed` is given, the page that this text of the page field names (`page` is then the page that is shown). The page that was shown stays until the new one comes; an error drops it.
async function readRecords(id: string, database: string, table: string, page: number, typed?: string) {
  const same = records?.id === id && records.database === database && records.table === table;
  const mine: RecordsView = { id, database, table, page, loading: true, error: null, data: same ? (records?.data ?? null) : null };
  records = mine;
  draw();
  try {
    mine.data = await invoke("database_records", { id, database, table, page, estimate: mine.data?.estimate ?? null, ...(typed === undefined ? {} : { typed }) });
    mine.page = mine.data.page;
  } catch (e) {
    mine.data = null;
    mine.error = String(e);
    // A stream that broke closes the connection: its tree closes and says why.
    if (records === mine && (await dropClosed()).includes(id)) {
      connections.set(id, { ...emptyConnection(), expanded: true, error: mine.error });
      records = null;
      draw();
      return;
    }
  }
  mine.loading = false;
  draw();
}

// Reads the structure of a table (D-5), at every press of the tab 構造.
async function readStructure(id: string, database: string, table: string) {
  const mine: StructureView = { id, database, table, loading: true, error: null, data: null };
  structure = mine;
  draw();
  try {
    mine.data = await invoke("database_structure", { id, database, table });
  } catch (e) {
    mine.error = String(e);
    // A stream that broke closes the connection: its tree closes and says why.
    if (structure === mine && (await dropClosed()).includes(id)) {
      connections.set(id, { ...emptyConnection(), expanded: true, error: mine.error });
      records = null;
      structure = null;
      draw();
      return;
    }
  }
  mine.loading = false;
  draw();
}

// Runs the text of the SQL tab on the connection and database that the tree has selected (D-6). The result of an older run is dropped by a newer one: a run waits for the one before it.
async function runSql() {
  const mine = sqlView();
  if (mine === null || mine.loading) return;
  mine.loading = true;
  mine.error = null;
  draw();
  try {
    mine.data = await invoke("database_sql", { id: mine.id, database: mine.database, sql: mine.text });
  } catch (e) {
    mine.data = null;
    mine.error = String(e);
    // A stream that broke closes the connection: its tree closes and says why.
    if (sql === mine && (await dropClosed()).includes(mine.id)) {
      connections.set(mine.id, { ...emptyConnection(), expanded: true, error: mine.error });
      records = null;
      structure = null;
      sql = null;
      draw();
      return;
    }
  }
  mine.loading = false;
  draw();
}

const workActions: WorkActions = {
  page: (page) => {
    if (records) readRecords(records.id, records.database, records.table, page);
  },
  pageInput: (text) => {
    if (records) readRecords(records.id, records.database, records.table, records.page, text);
  },
  // The table stays: only the tab changes. The records are kept as they are, and the structure is read at every press of its tab.
  tab: (id) => {
    if (id === tab || selected?.table == null) return;
    tab = id;
    if (id === "structure") readStructure(selected.id, selected.database ?? "", selected.table);
    else draw();
  },
  databaseTab: (id) => {
    if (id === databaseTab) return;
    databaseTab = id;
    draw();
  },
  // The field draws nothing while it is typed in: the text is only kept.
  sqlText: (text) => {
    const view = sqlView();
    if (view) view.text = text;
  },
  runSql,
  // The table list shows the tables of the selected database: a press on a row is the press on that table's row in the tree.
  openTable: (table) => {
    const profile = profiles.find((p) => p.id === selected?.id);
    if (profile && selected?.database != null) actions.pressTable(profile, selected.database, table);
  },
};

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
    openConnection(profile);
  },
  pressDatabase: (profile, name) => {
    // A press on the database that its pane already shows keeps the tab; from anywhere else the pane shows its tables.
    if (selected?.id !== profile.id || selected.database !== name || selected.table !== null) databaseTab = "tables";
    selected = { id: profile.id, database: name, table: null };
    const c = connections.get(profile.id);
    if (!c) return draw();
    const d = databaseOf(c, name);
    if (d.loading) return draw();
    if (d.expanded && d.error === null) {
      d.expanded = false;
      return draw();
    }
    openDatabase(profile, c, name);
  },
  // The tabs of the table open in the work pane, with the first page of its records, read again at every press.
  pressTable: (profile, database, table) => {
    selected = { id: profile.id, database, table };
    tab = "records";
    structure = null;
    readRecords(profile.id, database, table, 0);
  },
  // The SQL tab of the database with an empty field and no result, and the caret in the field.
  newQuery: (profile, database) => {
    selected = { id: profile.id, database, table: null };
    databaseTab = "sql";
    sql = { id: profile.id, database, ...emptySql, view: ++sqlViews };
    draw();
    focusSqlField();
  },
  // The tree of the database closes and the connection stays; the pane that showed the database empties.
  closeDatabase: (profile, database) => {
    const d = connections.get(profile.id)?.byName.get(database);
    if (d) d.expanded = false;
    if (selected?.id === profile.id && selected.database === database) selected = { id: profile.id, database: null, table: null };
    draw();
  },
  edit: (profile) => openDatabaseForm(profile, save, test, () => load(true)),
  disconnect: async (profile) => {
    connections.delete(profile.id);
    if (selected?.id === profile.id) selected = { id: profile.id, database: null, table: null };
    closing.add(profile.id);
    draw();
    try {
      await invoke("database_disconnect", { id: profile.id });
    } catch (e) {
      showError(e);
    }
    closing.delete(profile.id);
  },
  remove,
};

export function showDatabase() {
  show("database");
  draw();
  load();
}

export function initDatabase() {
  const add = $("database-add");
  add.innerHTML = PLUS_SVG;
  add.onclick = () => openDatabaseForm(null, save, test, () => load(true));
  initSplit($("database"), $("database-side-split"), { side: "left", min: 0.15, max: 0.4, initial: 0.2, property: "--side-w" });
  initDatabaseTerminal();
  initDatabaseForm();
}
