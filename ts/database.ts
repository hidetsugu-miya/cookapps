// The database screen (D-1, D-3 to D-6, D-9): the connections at the left (the side menu), which open into their databases and tables, and at the right the work pane with the strip of the open tabs: オブジェクト (the tables of the database that was pressed last), a tab for each table that was opened, which has the tabs (records, structure) of the table, and a tab for each query, which has its own text and result and the connection and database it runs on.
// This module holds the list that `database_profiles` last answered, what each connection has opened and what is selected; the side menu and the work pane only draw it (database-side.ts, database-work.ts), and the edit pane (database-form.ts) only asks for the fields.
// Rust holds the open connections (the session and its script); an opening of a row reads again, so the tree is never kept apart from the server. The records and the structure of a table are held in memory in the tab of the table, and the text and result of a query in the tab of the query.
import type { DatabaseProfile } from "./bindings/DatabaseProfile";
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import type { DatabaseScriptOutput } from "./bindings/DatabaseScriptOutput";
import type { DatabaseSqlResult } from "./bindings/DatabaseSqlResult";
import type { DatabaseTable } from "./bindings/DatabaseTable";
import { changesOf, cellKey, emptyEdit, type EditState, markable, originalText } from "./database-edit.js";
import { drawDatabaseSide, showScriptOutput, type Selected, type SideActions, type SideState } from "./database-side.js";
import { openDatabaseForm, syncDatabaseForm } from "./database-form.js";
import { initDatabaseTerminal } from "./database-terminal.js";
import { drawDatabaseWork, type EditActions, focusSqlField, type RecordsState, type StructureState, type WorkActions, type WorkBody, type WorkState } from "./database-work.js";
import { $ } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { confirmDelete, confirmDiscardChanges } from "./hint.js";
import { PLUS_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { initSplit } from "./split.js";
import { logError, showFailure } from "./error-card.js";
import { show } from "./view.js";

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
  // The last line of the output of the connection's script while it opens (D-3, #1027); none until it writes one. Dropped when the opening ends.
  output: string | null;
  error: string | null;
  databases: string[];
  byName: Map<string, DatabaseState>;
}

// A table that was opened (D-9): its tab of the strip, the selected tab of the table, and what its tabs hold. The records are read again at a press on its row, and kept at a press on its tab; the structure is read at every press of 構造 and dropped at a press on its row. A read that ends after the tab was closed or another read replaced it is dropped.
interface TableTab {
  kind: "table";
  key: string;
  id: string;
  database: string;
  table: string;
  tab: string;
  records: RecordsState | null;
  // What the records have gathered to write and not sent (D-10). It is empty when a read starts, and only the tab that is selected holds any: leaving it asks first.
  edit: EditState;
  structure: StructureState | null;
}

// A query that was opened (D-9, D-6): its tab of the strip, the connection and database it runs on (changed by the selects over it), what was typed and the result of the last run, and the height of the field after it was dragged. Nothing of it is shared with another tab.
interface QueryTab {
  kind: "query";
  key: string;
  id: string;
  database: string;
  text: string;
  loading: boolean;
  error: string | null;
  data: DatabaseSqlResult | null;
  height: number | null;
}

type OpenTab = TableTab | QueryTab;

let profiles: DatabaseProfileView[] = [];
// The tables and queries that were opened, in the order they were opened, and the selected one (none: オブジェクト is selected).
let openTabs: OpenTab[] = [];
let active: OpenTab | null = null;
// The number of the last query opened: it names the key of its tab.
let queries = 0;
let selected: Selected | null = null;
const connections = new Map<string, ConnectionState>();
// The connections whose disconnect is on its way: a press on them waits, so that an opening cannot meet the closing.
const closing = new Set<string>();
// The newest read: an older one that ends later is dropped.
let loadSeq = 0;
// How often the list is read while the screen is shown (#866): `tsunagiai-mcp` saves a connection in its own process and tells the app nothing (D-8).
const WATCH_MS = 2000;
let watcher: number | null = null;
// The quiet read that is on its way: a quiet read asked meanwhile is this one.
let quietRead: Promise<DatabaseProfileView[] | null> | null = null;

const emptyConnection = (): ConnectionState => ({ expanded: false, connected: false, loading: false, output: null, error: null, databases: [], byName: new Map() });
// The key of a tab is the key of the table row of the tree.
const tabKey = (id: string, database: string, table: string) => `${id}/d/${database}/t/${table}`;
const activeTable = () => (active?.kind === "table" ? active : null);
const activeQuery = () => (active?.kind === "query" ? active : null);
const databaseOf = (c: ConnectionState, name: string) => {
  let d = c.byName.get(name);
  if (!d) {
    d = { expanded: false, loading: false, error: null, tables: [] };
    c.byName.set(name, d);
  }
  return d;
};

// Closes the tabs that `drop` names, for a connection or a database that is gone, or one that was closed. When the selected one is among them, オブジェクト is selected, and the row that was pressed stays the database of the table.
function dropTabs(drop: (t: OpenTab) => boolean) {
  openTabs = openTabs.filter((t) => !drop(t));
  const was = active;
  if (was === null || openTabs.includes(was)) return;
  active = null;
  if (was.kind === "table" && selected?.id === was.id && selected.database === was.database && selected.table === was.table) selected = { id: was.id, database: was.database, table: null };
}

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
          return { name, expanded: d.expanded, loading: d.loading, error: d.error, tables: d.tables.map((t) => t.name) };
        }),
      };
    }),
  };
}

// The connection and database that a new query starts with (D-9): the row of the tree that is selected, else the connection and database of the selected query, else the first open connection. A connection that is not open, or has no database, is passed over; none when no connection is open.
function queryTarget(): { id: string; database: string } | null {
  const tries = [
    ...(selected ? [{ id: selected.id, database: selected.database }] : []),
    ...(active?.kind === "query" ? [{ id: active.id, database: active.database }] : []),
    ...profiles.map((p) => ({ id: p.id, database: null })),
  ];
  for (const { id, database } of tries) {
    const c = connections.get(id);
    const name = database ?? c?.databases[0];
    if (c?.connected && name !== undefined) return { id, database: name };
  }
  return null;
}

// What the pane under the strip draws: the tabs of the selected table, the selected query, or, with オブジェクト selected, the tables of the database that was pressed last.
function workBody(): WorkBody {
  if (active?.kind === "query") {
    const c = connections.get(active.id);
    return {
      kind: "query",
      query: {
        key: active.key,
        connections: profiles.filter((p) => connections.get(p.id)?.connected).map((p) => ({ id: p.id, name: p.name })),
        connection: active.id,
        databases: c?.databases ?? [active.database],
        database: active.database,
        height: active.height,
        sql: { text: active.text, loading: active.loading, error: active.error, data: active.data },
      },
    };
  }
  if (active?.kind === "table") {
    const { records, structure } = active;
    if (records === null) return { kind: "none" };
    return {
      kind: "table",
      connection: active.id,
      database: active.database,
      table: active.table,
      tab: active.tab,
      records: { page: records.page, loading: records.loading, error: records.error, data: records.data, edit: active.edit },
      structure: structure ? { loading: structure.loading, error: structure.error, data: structure.data } : null,
    };
  }
  const d = selected?.database == null ? undefined : connections.get(selected.id)?.byName.get(selected.database);
  return selected?.database != null && d ? { kind: "objects", database: selected.database, loading: d.loading, error: d.error, tables: d.tables } : { kind: "none" };
}

// The strip of the open tabs and the pane under it; none while no tab is open and no database is pressed.
function workState(): WorkState | null {
  const body = workBody();
  if (body.kind === "none" && openTabs.length === 0) return null;
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? "";
  return {
    tabs: openTabs.map((t) =>
      t.kind === "table" ? { key: t.key, label: t.table, title: `${t.database}.${t.table}` } : { key: t.key, label: `無題 @${t.database}`, title: `${nameOf(t.id)} · ${t.database}` },
    ),
    active: active?.key ?? null,
    body,
  };
}

const draw = () => {
  drawDatabaseSide($("database-side-feed"), sideState(), actions);
  drawDatabaseWork(workState(), workActions);
};

// Reads the connections from Rust (the file and the keychain are the only copy) and draws them. Answers the list, or none when the read failed or a newer one replaced it. A `quiet` read (the clock's, at an interval) shows no error, draws nothing when the list is the one drawn, and is one read at a time.
function load(quiet = false): Promise<DatabaseProfileView[] | null> {
  if (!quiet) return read(false);
  quietRead ??= read(true).finally(() => {
    quietRead = null;
  });
  return quietRead;
}

async function read(quiet: boolean): Promise<DatabaseProfileView[] | null> {
  const seq = ++loadSeq;
  try {
    const list = await invoke("database_profiles");
    if (seq !== loadSeq) return null;
    const same = JSON.stringify(list) === JSON.stringify(profiles);
    profiles = list;
    // A connection that is gone from the list has nothing open any more (Rust closed it with the delete).
    for (const id of [...connections.keys()]) if (!profiles.some((p) => p.id === id)) connections.delete(id);
    dropTabs((t) => !profiles.some((p) => p.id === t.id));
    if (selected !== null && !profiles.some((p) => p.id === selected?.id)) selected = null;
    if (!quiet || !same) draw();
    if (!same) syncDatabaseForm(list);
    return list;
  } catch (e) {
    if (seq === loadSeq && !quiet) logError("database", e);
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
  dropTabs((t) => dropped.includes(t.id));
  for (const id of dropped) {
    connections.delete(id);
    if (selected?.id === id) selected = { id, database: null, table: null };
  }
  if (dropped.length > 0) draw();
  return dropped;
}

// The save of the edit pane. Rust closes an edited connection, and the tabs of its tables go with it, so a save of a connection whose selected table has gathered changes asks first (D-10), under 保存, and answers false: nothing is saved and the edit pane stays with 保存 on again. When the owner agrees, the changes are dropped and the form is submitted again, and that save finds nothing to ask about.
function saveAsking(profile: DatabaseProfile, password: string): Promise<boolean> {
  if (profile.id === "") return save(profile, password);
  const submit = document.querySelector<HTMLButtonElement>('#database-form [type="submit"]');
  let asking = true;
  let direct = false;
  leaving(
    () => {
      if (asking) direct = true;
      else if (submit?.isConnected) submit.form?.requestSubmit();
    },
    (t) => t.id === profile.id,
    submit,
  );
  asking = false;
  return direct ? save(profile, password) : Promise.resolve(false);
}

async function save(profile: DatabaseProfile, password: string): Promise<boolean> {
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
  if (failure === null) return true;
  // Rust writes the file before the keychain, so a refusal of the keychain leaves the new connection saved: the edit pane would save it again as a new one. It closes, and a failure card shows the error.
  if (profile.id === "" && profiles.some((p) => !known.has(p.id))) {
    showFailure("database", failure);
    return true;
  }
  throw failure;
}

// The version that the server of the connection as typed answers; Rust starts the script of the connection, logs in, reads it and ends the script.
const test = (profile: DatabaseProfile, password: string) => invoke("database_test", { profile, password });

async function remove(profile: DatabaseProfileView, anchor: Element) {
  confirmDelete(anchor, profile.name, async () => {
    try {
      await invoke("database_profile_delete", { id: profile.id });
    } catch (e) {
      showFailure("database", e);
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
  c.output = null;
  c.error = null;
  draw();
  try {
    const names = await invoke("database_connect", { id: profile.id });
    // The connection was deleted while it opened: Rust holds a session that no row shows.
    if (!profiles.some((p) => p.id === profile.id)) {
      invoke("database_disconnect", { id: profile.id }).catch((e) => logError("database", e));
      return;
    }
    if (connections.get(profile.id) !== c) return;
    c.connected = true;
    c.databases = names;
    for (const name of [...c.byName.keys()]) if (!names.includes(name)) c.byName.delete(name);
    dropTabs((t) => t.id === profile.id && !names.includes(t.database));
  } catch (e) {
    if (connections.get(profile.id) !== c) return;
    c.connected = false;
    c.databases = [];
    c.byName.clear();
    dropTabs((t) => t.id === profile.id);
    c.error = String(e);
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

// Reads the page `page` of the records of the table of a tab (D-4), or, when `typed` is given, the page that this text of the page field names (`page` is then the page that is shown). The page that was shown stays until the new one comes; an error drops it.
async function readRecords(t: TableTab, page: number, typed?: string) {
  const { id, database, table } = t;
  const mine: RecordsState = { page, loading: true, error: null, data: t.records?.data ?? null };
  t.records = mine;
  t.edit = emptyEdit();
  draw();
  try {
    mine.data = await invoke("database_records", { id, database, table, page, estimate: mine.data?.estimate ?? null, ...(typed === undefined ? {} : { typed }) });
    mine.page = mine.data.page;
  } catch (e) {
    mine.data = null;
    mine.error = String(e);
    // A stream that broke closes the connection: its tree closes and says why.
    if (t.records === mine && (await dropClosed()).includes(id)) {
      connections.set(id, { ...emptyConnection(), expanded: true, error: mine.error });
      draw();
      return;
    }
  }
  mine.loading = false;
  draw();
}

// Reads the structure of the table of a tab (D-5), at every press of the tab 構造.
async function readStructure(t: TableTab) {
  const { id, database, table } = t;
  const mine: StructureState = { loading: true, error: null, data: null };
  t.structure = mine;
  draw();
  try {
    mine.data = await invoke("database_structure", { id, database, table });
  } catch (e) {
    mine.error = String(e);
    // A stream that broke closes the connection: its tree closes and says why.
    if (t.structure === mine && (await dropClosed()).includes(id)) {
      connections.set(id, { ...emptyConnection(), expanded: true, error: mine.error });
      draw();
      return;
    }
  }
  mine.loading = false;
  draw();
}

// Runs the text of a query tab on the connection and database it holds (D-6). The result of an older run is dropped by a newer one: a run waits for the one before it.
async function runQuery(q: QueryTab) {
  if (q.loading) return;
  q.loading = true;
  q.error = null;
  draw();
  try {
    q.data = await invoke("database_sql", { id: q.id, database: q.database, sql: q.text });
  } catch (e) {
    q.data = null;
    q.error = String(e);
    // A stream that broke closes the connection: its tree closes and says why, and its tabs close.
    if (openTabs.includes(q) && (await dropClosed()).includes(q.id)) {
      connections.set(q.id, { ...emptyConnection(), expanded: true, error: q.error });
      draw();
      return;
    }
  }
  q.loading = false;
  draw();
}

// Opens a query tab on the connection and database, selects it and puts the caret in its field.
function openQuery(id: string, database: string) {
  queries += 1;
  const q: QueryTab = { kind: "query", key: `query-${queries}`, id, database, text: "", loading: false, error: null, data: null, height: null };
  openTabs.push(q);
  active = q;
  draw();
  focusSqlField();
}

// The number of changes that the selected table has gathered and not sent (D-10).
function gathered(t: TableTab | null): number {
  const data = t?.records?.data;
  return t && data ? changesOf(data, t.edit).length : 0;
}

// Runs `go` at once, or, when it leaves a table that has gathered changes (`affects`), after the owner agrees to drop them (D-10). The confirmation opens under the tab of that table.
function leaving(go: () => void, affects: (t: TableTab) => boolean = () => true, under?: Element | null) {
  const t = activeTable();
  const n = gathered(t);
  if (t === null || n === 0 || !affects(t)) return go();
  const anchor = under ?? document.querySelector(`#database-work-tabs [data-key="open-${CSS.escape(t.key)}"]`) ?? $("database-work");
  confirmDiscardChanges(anchor, n, () => {
    t.edit = emptyEdit();
    go();
  });
}

// The number of changes gathered, for the sidebar's buttons: leaving the screen asks too (D-10).
export const databaseChanges = () => gathered(activeTable());

export function discardDatabaseChanges() {
  const t = activeTable();
  if (t) t.edit = emptyEdit();
  draw();
}

// ✓: writes what was gathered with one call, then reads the page again. A refusal shows its words on a card and keeps everything gathered.
async function applyChanges() {
  const t = activeTable();
  const data = t?.records?.data;
  if (!t || !data || t.edit.applying) return;
  const changes = changesOf(data, t.edit);
  if (changes.length === 0) return;
  const { id, database, table } = t;
  const mine = t.edit;
  mine.applying = true;
  draw();
  try {
    await invoke("database_apply", { id, database, table, changes });
  } catch (e) {
    mine.applying = false;
    showFailure("database", e);
    // A stream that broke closes the connection: its tree closes and says why.
    if ((await dropClosed()).includes(id)) connections.set(id, { ...emptyConnection(), expanded: true, error: String(e) });
    draw();
    return;
  }
  // The tab was closed while the write was on its way: there is nothing to read again.
  if (openTabs.includes(t)) await readRecords(t, t.records?.page ?? 0);
}

const editActions: EditActions = {
  add: () => {
    const t = activeTable();
    if (!t) return;
    t.edit.added = [...t.edit.added, {}];
    draw();
    // The new row is at the end of the page: bring it into view.
    document.querySelector("#database-work .database-grid tbody tr.added:last-child")?.scrollIntoView({ block: "nearest" });
  },
  addedCell: (index, column, value) => {
    const t = activeTable();
    if (!t || t.edit.added[index] === undefined) return;
    const { [String(column)]: _, ...rest } = t.edit.added[index];
    t.edit.added[index] = value === undefined ? rest : { ...rest, [String(column)]: value };
    draw();
  },
  cell: (row, column, text) => {
    const t = activeTable();
    const data = t?.records?.data;
    if (!t || !data) return;
    const key = cellKey(row, column);
    if (text === originalText(data, row, column)) delete t.edit.cells[key];
    else t.edit.cells[key] = text;
    draw();
  },
  select: (row, add) => {
    const t = activeTable();
    if (!t) return;
    const { selected } = t.edit;
    if (!add) t.edit.selected = [row];
    else t.edit.selected = selected.includes(row) ? selected.filter((r) => r !== row) : [...selected, row];
    draw();
  },
  markDelete: () => {
    const t = activeTable();
    const data = t?.records?.data;
    if (!t || !data) return;
    const rows = markable(data, t.edit);
    const n = data.rows.length;
    // The rows of the page are marked; the rows that were added are taken back, and go as if they were never added.
    t.edit.deleted = [...t.edit.deleted, ...rows.filter((row) => row < n)].sort((a, b) => a - b);
    t.edit.added = t.edit.added.filter((_, k) => !rows.includes(n + k));
    t.edit.selected = [];
    draw();
  },
  apply: () => void applyChanges(),
  revert: () => {
    const t = activeTable();
    if (!t) return;
    t.edit = emptyEdit();
    draw();
  },
};

const workActions: WorkActions = {
  edit: editActions,
  // What is gathered keeps the page where it is (D-10).
  page: (page) => {
    const t = activeTable();
    if (t?.records && gathered(t) === 0) readRecords(t, page);
  },
  pageInput: (text) => {
    const t = activeTable();
    if (t?.records && gathered(t) === 0) readRecords(t, t.records.page, text);
  },
  // The table stays: only the tab changes. The records are kept as they are, and the structure is read at every press of its tab.
  tab: (id) => {
    const t = activeTable();
    if (t === null || id === t.tab) return;
    t.tab = id;
    if (id === "structure") void readStructure(t);
    else draw();
  },
  // A press on a tab of the strip calls nothing: the records and the structure of a table tab, and the text and result of a query, are kept in it.
  openTab: (key) => {
    const t = key === null ? null : openTabs.find((o) => o.key === key);
    if (t === undefined || t === active) return;
    leaving(() => {
      if (t === null) {
        if (active?.kind === "table") selected = { id: active.id, database: active.database, table: null };
      } else if (t.kind === "table") {
        selected = { id: t.id, database: t.database, table: t.table };
      }
      active = t;
      draw();
    });
  },
  // The tab closes with what it held; when it was the selected one, オブジェクト is selected, with the database of the table.
  closeOpenTab: (key) => {
    const t = openTabs.find((o) => o.key === key);
    leaving(
      () => {
        if (t) dropTabs((o) => o === t);
        draw();
      },
      (a) => a.key === key,
    );
  },
  // ＋: a new query on what the tree has selected (D-9); asks first when it leaves a table with gathered changes.
  addQuery: () =>
    leaving(() => {
      const target = queryTarget();
      if (target) openQuery(target.id, target.database);
    }),
  // The query keeps its text and result when its connection or database is changed.
  queryConnection: (id) => {
    const q = activeQuery();
    const database = connections.get(id)?.databases[0];
    if (!q || database === undefined || id === q.id) return;
    q.id = id;
    q.database = database;
    draw();
  },
  queryDatabase: (name) => {
    const q = activeQuery();
    if (!q || name === q.database) return;
    q.database = name;
    draw();
  },
  queryHeight: (px) => {
    const q = activeQuery();
    if (q) q.height = px;
  },
  // The field draws nothing while it is typed in: the text is only kept.
  sqlText: (text) => {
    const q = activeQuery();
    if (q) q.text = text;
  },
  runSql: () => {
    const q = activeQuery();
    if (q) void runQuery(q);
  },
  // The table list shows the tables of the selected database: a press on a row is the press on that table's row in the tree.
  openTable: (table) => {
    const profile = profiles.find((p) => p.id === selected?.id);
    if (profile && selected?.database != null) actions.pressTable(profile, selected.database, table);
  },
};

// The presses of the tree, as they are; `actions` below asks first when one leaves a table that has gathered changes (D-10).
const treeActions: SideActions = {
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
    selected = { id: profile.id, database: name, table: null };
    active = null;
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
  // The table opens in a tab of the strip (a table that is open has its tab selected), with the first page of its records, read again at every press.
  pressTable: (profile, database, table) => {
    selected = { id: profile.id, database, table };
    const key = tabKey(profile.id, database, table);
    let t = openTabs.find((o): o is TableTab => o.kind === "table" && o.key === key);
    if (!t) {
      t = { kind: "table", key, id: profile.id, database, table, tab: "records", records: null, edit: emptyEdit(), structure: null };
      openTabs.push(t);
    }
    t.tab = "records";
    t.structure = null;
    active = t;
    void readRecords(t, 0);
  },
  // A new query tab on the database, with an empty field and no result, and the caret in the field. The database row is selected, its tree is not opened and nothing is called.
  newQuery: (profile, database) => {
    selected = { id: profile.id, database, table: null };
    openQuery(profile.id, database);
  },
  // The tree of the database closes and the connection stays; the tabs of its tables close, and the pane that showed one of them empties. A query on the database stays: it holds the connection, not the tree.
  closeDatabase: (profile, database) => {
    const d = connections.get(profile.id)?.byName.get(database);
    if (d) d.expanded = false;
    dropTabs((t) => t.kind === "table" && t.id === profile.id && t.database === database);
    if (selected?.id === profile.id && selected.database === database) selected = { id: profile.id, database: null, table: null };
    draw();
  },
  edit: (profile) => openDatabaseForm(profile, saveAsking, test),
  disconnect: async (profile) => {
    connections.delete(profile.id);
    dropTabs((t) => t.id === profile.id);
    if (selected?.id === profile.id) selected = { id: profile.id, database: null, table: null };
    closing.add(profile.id);
    draw();
    try {
      await invoke("database_disconnect", { id: profile.id });
    } catch (e) {
      showFailure("database", e);
    }
    closing.delete(profile.id);
  },
  remove,
};

const actions: SideActions = {
  ...treeActions,
  pressConnection: (profile) => leaving(() => treeActions.pressConnection(profile)),
  pressDatabase: (profile, name) => leaving(() => treeActions.pressDatabase(profile, name)),
  pressTable: (profile, database, table) => leaving(() => treeActions.pressTable(profile, database, table)),
  newQuery: (profile, database) => leaving(() => treeActions.newQuery?.(profile, database)),
  closeDatabase: (profile, database) =>
    leaving(
      () => treeActions.closeDatabase(profile, database),
      (t) => t.id === profile.id && t.database === database,
    ),
  disconnect: (profile) =>
    leaving(
      () => void treeActions.disconnect(profile),
      (t) => t.id === profile.id,
    ),
};

// Reads the list at an interval while the screen is shown, with or without an edit pane (#866). It stops at the first tick after the screen is left, and `showDatabase` starts it again; nothing is read while the window is hidden.
function startWatch() {
  if (watcher !== null) return;
  watcher = window.setInterval(() => {
    if ($("database").hidden) {
      if (watcher !== null) clearInterval(watcher);
      watcher = null;
    } else if (!document.hidden) {
      void load(true);
    }
  }, periodMs("databaseProfiles", WATCH_MS));
}

export function showDatabase() {
  show("database");
  draw();
  load();
  startWatch();
}

export function initDatabase() {
  const add = $("database-add");
  add.innerHTML = PLUS_SVG;
  add.onclick = () => openDatabaseForm(null, save, test);
  initSplit($("database"), $("database-side-split"), { side: "left", min: 0.15, max: 0.4, initial: 0.2, property: "--side-w" });
  initDatabaseTerminal();
  // Rust tells each line that the script of a connection writes while the connection opens. A line that comes after the opening ended, or for a connection that is not opening, is dropped.
  window.__TAURI__.event.listen<DatabaseScriptOutput>("database-script-output", ({ payload }) => {
    const c = connections.get(payload.id);
    if (c === undefined || !c.loading) return;
    c.output = payload.line;
    if (!showScriptOutput($("database-side-feed"), payload.id, payload.line)) draw();
  });
}
