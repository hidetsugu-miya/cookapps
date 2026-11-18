// E2E only: sits under every invoke of the app. Loaded after the plugin and before the app.
// On WKWebView `core.invoke` and `__TAURI_INTERNALS__.invoke` are read-only, so the plugin cannot intercept the app's calls itself;
// but `window.__TAURI__.core` is writable, so it is replaced by a copy with a wrapped `invoke`. `ts/ipc.ts` reads `invoke` from it after this script ran.
// Order of lookup: a spec's `mock(...)` in e2e/support.ts (window.__e2e_mocks__), then the fixtures, then the base answers below, else reject.
// Every app command call is recorded in window.__e2e_calls__[command] as its argument list, for `callsOf` in e2e/support.ts (a raw body as {bytes, headers}).
// Both live in the page, so a reload clears them. (@wdio/tauri-service's own `mock` is not used: it does not put the mock back into a reloaded page.)
// Every command the app calls at startup has a harmless base answer, so no test can reach Gmail, the keychain or Slack.
// To change what the app sees at startup, put {command: value} in sessionStorage["e2e-fixtures"] and reload (`boot` in e2e/support.ts does it).
// A mock value of the form {__e2e_reject__: text} makes the command fail with that text, as a Rust `Err(String)` reaches the app.
// {e2e_timers: {...}} is no command: it sets the periods of the app's timers for the spec (`timers` in e2e/support.ts).
// A mock or fixture value {__e2e_hold__: true} makes the command wait until `release` in e2e/support.ts answers it, so a spec decides when the answer arrives.
// Calls held at the same time are answered by `release` in the order they were made.
// An unmocked command is also recorded in window.__e2e_unmocked__: the app swallows some rejections, and wdio.conf.ts prints the list when a test fails.
// The window is never shown (visible: false in tauri.e2e.conf.json), and WKWebView then reports document.hidden and runs no animation frames,
// which would stop the app's sync, Todo refresh and its requestAnimationFrame work. Make the page behave as in a shown window.
Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
Object.defineProperty(document, "visibilityState", { get: () => "visible" });
window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);

// The system's appearance, which a spec cannot change: the app's `matchMedia("(prefers-color-scheme: dark)")` answers the real one until `setDark` in e2e/support.ts sets it, and then tells the listeners.
const darkQuery = new EventTarget();
darkQuery.media = "(prefers-color-scheme: dark)";
const realMatchMedia = window.matchMedia.bind(window);
let forcedDark = null;
Object.defineProperty(darkQuery, "matches", { get: () => forcedDark ?? realMatchMedia(darkQuery.media).matches });
window.__e2e_set_dark__ = (dark) => {
  forcedDark = dark;
  darkQuery.dispatchEvent(new Event("change"));
};
window.matchMedia = (query) => (query === darkQuery.media ? darkQuery : realMatchMedia(query));

// Lets a script run once even when the driver runs it twice: see `onceId` in e2e/support.ts.
const ran = new Set();
window.__e2e_once__ = (id) => !ran.has(id) && !!ran.add(id);

const core = window.__TAURI__.core;
const real = core.invoke.bind(core);
const fixtures = JSON.parse(sessionStorage.getItem("e2e-fixtures") ?? "{}");
// The periods of the timers that a spec shortens (`timers` in e2e/support.ts): the app reads them with `periodMs` (ts/e2e-timers.ts), and only this build has them.
window.__e2e_timers__ = fixtures.e2e_timers;
const answers = {
  inbox_cached: null,
  thread_held: null,
  calendar_cached: [],
  calendar_first_day: 0,
  set_calendar_first_day: null,
  calendar_choices: { accounts: [], needsLogin: [], failed: {} },
  set_calendar_shown: null,
  inbox: { accounts: [], threads: [], needsLogin: [], failed: {}, historyIds: {} },
  sync: { kind: "unchanged" },
  todoist_cached: null,
  todoist_load: null,
  todoist_connected: false,
  todoist_comments: [],
  todoist_picked_due: null,
  slack_load: { workspaces: [], recent: [] },
  slack_timeline: { messages: [], watched: [], failed: [], missing: [], refreshSecs: 120, pendingChannels: 0, unreadTotal: 0, unreadChannels: [], side: [] },
  slack_mark_read: true,
  slack_channel_history: [],
  slack_watch: true,
  slack_unwatch: null,
  slack_watch_seen: true,
  slack_thread_seen: false,
  slack_hidden_list: [],
  slack_hide_channel: true,
  slack_side_folded: [],
  slack_set_side_folded: true,
  slack_unhide_channel: true,
  slack_icons: [],
  slack_socket_status: [],
  slack_file_images: {},
  // D-1: no connection saved; a spec that saves or deletes one mocks `database_profiles` with the list it should read next, and `database_profile_save` or `database_profile_delete`; `database_test` (D-2) is mocked by the spec that tests a connection.
  database_profiles: [],
  // D-3: a connection opens with no database and a database with no table, nothing is open to ask about, and a disconnect succeeds; a spec that opens a tree mocks `database_connect` and `database_tables`.
  database_connect: [],
  database_tables: [],
  // D-4: a table with no row; a spec that opens a table mocks `database_records`.
  database_records: { columns: [], rows: [], page: 0, hasMore: false, summary: "0 行", lastPage: null, pages: "", tsv: "" },
  // D-5: a table of no column; a spec that opens the tab 構造 mocks `database_structure`.
  database_structure: { columns: [], summary: "0 列", tsv: "" },
  // D-6: a statement with no row; a spec that runs one mocks `database_sql`.
  database_sql: { columns: [], rows: [], summary: "0 行 / 1 ms", tsv: "" },
  database_connections: [],
  database_disconnect: null,
  // No orca command: the Orca screen reads once and stops.
  orca_overview: { state: "missing", message: "", target: null, environments: [], rows: [], worktrees: [], projects: [], terminals: [], known: true },
  orca_destination: { state: "missing", message: "", target: null, environments: [], rows: [], worktrees: [], projects: [], terminals: [], known: false },
  // The terminals of the Orca screen (A-8, A-12): this machine's mirror reads an empty screen, and a saved environment's stream sends nothing until a spec gives it events.
  orca_terminal_read: [],
  orca_terminal_input: null,
  orca_open_url: null,
  orca_attach_file: { text: "/work/example/.orca/drops/image.png ", bracketed: true },
  orca_files_ignored: [],
  // A-39: no entry differs from HEAD; a spec that checks the marks mocks `orca_files_changes`.
  orca_files_changes: [],
  // A-25: the pick of a remote branch is remembered by Rust; a spec that checks it, or its failure, mocks `orca_branch_used`.
  orca_branch_used: null,
  // A-25: the git worktrees of the list of branches; none by default, so the list draws no worktree section.
  orca_git_worktrees: [],
  // A-20: the fonts of the screens are read at the start (the first values), and this Mac has three families; a spec that presses a select mocks `font_settings_set`.
  font_settings: {
    app: { family: null, size: 14, ghostty: false },
    mail: { family: null, size: 14, ghostty: false },
    calendar: { family: null, size: 14, ghostty: false },
    todoList: { family: null, size: 14, ghostty: false },
    todoWork: { family: null, size: 14, ghostty: false },
    slack: { family: null, size: 14, ghostty: false },
    orcaList: { family: null, size: 14, ghostty: false },
    orcaPane: { family: null, size: 14, ghostty: false },
    orcaWork: { family: null, size: 13, ghostty: true },
    editor: { family: null, size: 12.5, ghostty: false },
    mono: { family: null, size: 14, ghostty: false },
  },
  font_families: ["Hiragino Sans", "Menlo", "Times New Roman"],
  // #676: the sidebar's first order, all six screens shown; a spec that saves a change mocks `side_menu_settings_set`.
  side_menu_settings: {
    items: [
      { screen: "mail", enabled: true },
      { screen: "calendar", enabled: true },
      { screen: "todo", enabled: true },
      { screen: "slack", enabled: true },
      { screen: "orca", enabled: true },
      { screen: "database", enabled: true },
    ],
  },
  // A-18: the files and the editor are answered by the spec that opens them; the settings are read at the start.
  editor_settings: { autosaveMs: 1000, autosaveMin: 100, autosaveMax: 3000, autosaveStep: 100 },
  orca_stream_open: null,
  orca_stream_close: null,
  orca_stream_terminal: null,
  orca_stream_terminal_close: null,
  orca_stream_viewport: null,
  orca_stream_input: null,
  // A-36: a Claude Code pane's process; a spec that checks the calls reads them with `callsOf`.
  claude_code_start: 1,
  claude_code_input: null,
  claude_code_resize: null,
  claude_code_close: null,
  // A-37: no children yet.
  formation_children: [],
  formation_delete: { deleted: true, kept: [], preserved: [] },
  formation_close_child: { closed: true, reason: null, changed: [], untracked: [], unpushed: [], path: "", environment: "", preservedBranch: null },
  // A-37: one formation, `formation`, with no project and no child (no row is selected until one is pressed).
  formation_list: { formations: [{ name: "formation", projects: [], environment: "local", createdAt: null, counts: { planned: 0, waiting: 0, working: 0, done: 0 }, children: [], waiting: false }], readError: null },
  // A-41: the page that waits on a child (a spec that opens one gives its own with `decisionPage` of e2e/support.ts): an `open-questions` page with nothing on it.
  formation_page_read: {
    pageKind: "open-questions",
    subject: "requirement",
    contextLabel: "",
    title: "",
    what: null,
    roots: {},
    previousReply: null,
    questions: [],
    approvalScope: [],
    changes: [],
    needsUserDecision: [],
    residualMustFix: [],
    structuralProposals: [],
    adr: null,
    risks: null,
    settledDecisions: [],
    qualityLoop: null,
    unmetCriteria: [],
    pr: null,
  },
  // A-41 (#923): the reply that the answers of a page make was put into the leader's terminal.
  formation_page_answer: null,
  // A-37 (#893): no PC has the owner's consent yet; a spec that needs one gives `formationConsent` of e2e/support.ts, and one that presses 「同意する」 or 「取り消す」 mocks `formation_consent` or `formation_consent_revoke`.
  formation_consents: [],
  // A-13: no Ghostty settings imported yet; a spec that presses the import button mocks `ghostty_import`.
  ghostty_saved: null,
  // A-34: the language server of a worktree that was never started, with no way to start it (a spec that checks the pane or the start gives its own).
  lsp_status: { state: "stopped", reason: "notStarted" },
  lsp_start: { state: "indexing" },
  lsp_stop: null,
  lsp_restart: { state: "indexing" },
  lsp_container_start: null,
  // The key of the server that takes Ruby (its language), of a repository with nothing saved.
  lsp_server_for: "ruby",
  // A-34: the languages found in a worktree: none (a spec that checks the finding gives its own).
  lsp_detect: [],
  // A-34, A-36: the first instruction of the Claude Code pane that sets up the language servers.
  lsp_claude_request: "> 環境: local\nこのプロジェクトの言語サーバーを設定してください。\n",
  // How the card of a language server draws a language (A-34), as `lsp_language_looks` answers it: the six of the table with their titles and icons, and one that has neither.
  lsp_language_looks: [
    { language: "go", title: "Go", icon: "go" },
    { language: "javascript", title: "JavaScript", icon: "javaScript" },
    { language: "plaintext", title: "plaintext", icon: null },
    { language: "python", title: "Python", icon: "python" },
    { language: "ruby", title: "Ruby", icon: "ruby" },
    { language: "rust", title: "Rust", icon: "rust" },
    { language: "typescript", title: "TypeScript", icon: "typeScript" },
  ],
  lsp_launches: ({ servers }) => servers.map(() => ({ method: "none", candidates: [], service: null, command: null, mount: null })),
  // A-14: the two default themes, with example colors (a spec that chooses among themes gives `terminalThemes` of e2e/support.ts); a spec that presses a select mocks `terminal_theme_set`.
  terminal_themes: {
    themes: [
      { name: "Ghostty Default Style Dark", colors: { background: "#10203a", foreground: "#e0e0e0", cursor: "#e0e0e0", cursorAccent: "#10203a", selectionBackground: "#445566", selectionForeground: "#e0e0e0", palette: [] } },
      { name: "Builtin Tango Light", colors: { background: "#fafafa", foreground: "#202020", cursor: "#202020", cursorAccent: "#fafafa", selectionBackground: "#445566", selectionForeground: "#202020", palette: [] } },
    ],
    selection: { light: "Builtin Tango Light", dark: "Ghostty Default Style Dark", appearance: "system" },
  },
  fetch_images: {},
  claude_status: { state: "missing" },
  claude_model_settings: Object.fromEntries(
    ["slackSummary", "mailSummary", "promptChat", "proofread", "slackReply", "orcaHandoff", "todoChat", "slackChat"].map((purpose) => [purpose, { model: "sonnet", effort: purpose === "slackReply" ? "high" : "medium" }]),
  ),
  claude_todo_prompt: { body: "Default body", defaultBody: "Default body", fixed: "Fixed part\nToday is {today}.\n{projects}", fixedAfter: "Fixed tail", edited: false },
  app_info: { version: "1.2.3", updatable: true },
  // Manual, so that no spec replaces the app by accident; the real default (Rust) is auto.
  update_mode: "manual",
  set_update_mode: null,
  check_update: null,
  install_update: null,
  restart_app: null,
  set_badge: null,
  // The app's log (A-28): every failure is written with `log_write`, and the log tab (or the card's button) reads it.
  log_write: null,
  log_read: [],
  ...fixtures,
};
// The settings card's view of the connection follows the usable state (the subscription is the method in use) unless a spec gives its own.
answers.claude_connection ??= { method: "subscription", subscription: answers.claude_status, apiKey: { state: "none" }, claude: answers.claude_status };
window.__e2e_mocks__ = {};
window.__e2e_calls__ = {};

// A-38: the folders of a saved environment's server (`orca_browse_dir`), as Rust answers them (the names of the folders, in the order of their names; the home folder for an empty path). A path that is none of these fails as an unreadable one does.
const browseTree = {
  "/": ["home", "srv"],
  "/home": ["dev"],
  "/home/dev": [".config", "Documents", "workspace"],
  "/home/dev/workspace": ["api", "app", "web"],
  "/srv": [],
};

// Commands whose base answer follows their arguments. `orca_panes` (A-17) answers as Rust does for a project that was never split: one pane with every tab, the tab last selected shown (kept between calls, as the saved layout is, else the first), and nothing else changed;
// a spec that splits mocks it with the layout it wants.
const selectedIn = {};
const computed = {
  // The weeks that hold the month, from the first day of the week (what Rust's `calendar_month` answers).
  calendar_month: ({ year, month, firstDay }) => {
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const back = (d) => (d.getDay() + 7 - firstDay) % 7;
    const first = new Date(year, month - 1, 1);
    const last = new Date(year, month, 0);
    const start = new Date(year, month - 1, 1 - back(first));
    const end = new Date(year, month - 1, last.getDate() + 6 - back(last));
    const days = [];
    for (let d = start; d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      days.push({ date: iso(d), day: d.getDate(), inMonth: d.getMonth() === month - 1 });
    }
    return { weekdays: [0, 1, 2, 3, 4, 5, 6].map((i) => (firstDay + i) % 7), days };
  },
  // A-34: the settings of a repository that has none saved (the one server, ruby-lsp, of the language ruby), and the save, which answers what it was given (the texts trimmed by Rust are given trimmed here).
  lsp_settings: ({ environment, project }) => ({ environment, project, sshHost: null, servers: [{ language: "ruby", name: "ruby-lsp", autoStart: true, command: null, mount: null, service: null }] }),
  lsp_settings_set: ({ settings }) => settings,
  ssh_hosts: () => [],
  orca_browse_dir: ({ path }) => {
    const resolvedPath = path.trim() === "" || path.trim() === "~" ? "/home/dev" : path;
    if (!(resolvedPath in browseTree)) throw "Orca のフォルダの一覧を読めません";
    return { resolvedPath, folders: browseTree[resolvedPath] };
  },
  orca_panes: ({ environment, project, tabs, op }) => {
    const key = JSON.stringify([environment, project]);
    if (op?.kind === "select" && tabs.includes(op.tab)) selectedIn[key] = op.tab;
    const first = tabs[0] ?? null;
    const selected = tabs.includes(selectedIn[key]) ? selectedIn[key] : first;
    return { root: first === null ? null : { kind: "pane", id: "p1", tabs, selected }, focus: first === null ? null : "p1" };
  },
};
const answerOf = (cmd, args) => computed[cmd](args);

const invoke = async (cmd, args, options) => {
  // Plugin and event traffic (wdio's own, listen/emit) is not an app command.
  if (cmd.startsWith("plugin:")) return real(cmd, args, options);
  window.__e2e_calls__[cmd] ??= [];
  // A raw body (a file's bytes, with its name in the headers) is recorded as {bytes, headers}, the bytes as numbers: the record is read through the driver, which cannot carry bytes.
  const raw = args instanceof Uint8Array || args instanceof ArrayBuffer;
  window.__e2e_calls__[cmd].push(raw ? { bytes: Array.from(new Uint8Array(args)), headers: options?.headers ?? {} } : (args ?? null));
  if (!(cmd in window.__e2e_mocks__) && !(cmd in answers) && !(cmd in computed)) {
    window.__e2e_unmocked__ ??= [];
    window.__e2e_unmocked__.push(cmd);
    throw new Error(`e2e: unmocked command "${cmd}" (args ${JSON.stringify(args)})`);
  }
  const value = structuredClone(cmd in window.__e2e_mocks__ ? window.__e2e_mocks__[cmd] : cmd in answers ? answers[cmd] : answerOf(cmd, args));
  // A fixture can make a command fail or wait from the start too (a mock does the same, once the page is loaded).
  if (value?.__e2e_reject__ !== undefined) throw value.__e2e_reject__;
  if (value?.__e2e_hold__) {
    window.__e2e_release__ ??= {};
    window.__e2e_release__[cmd] ??= [];
    return new Promise((resolve, reject) => {
      // `release` with a {__e2e_reject__: text} value makes the held call fail.
      window.__e2e_release__[cmd].push((answer) => (answer?.__e2e_reject__ !== undefined ? reject(answer.__e2e_reject__) : resolve(answer)));
    });
  }
  return value;
};
window.__TAURI__.core = { ...core, invoke };
