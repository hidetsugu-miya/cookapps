// E2E only: sits under every invoke of the app. Loaded after the plugin and before the app.
// On WKWebView `core.invoke` and `__TAURI_INTERNALS__.invoke` are read-only, so the plugin cannot intercept the app's calls itself;
// but `window.__TAURI__.core` is writable, so it is replaced by a copy with a wrapped `invoke`. `ts/ipc.ts` reads `invoke` from it after this script ran.
// Order of lookup: a spec's `mock(...)` in e2e/support.ts (window.__e2e_mocks__), then the fixtures, then the base answers below, else reject.
// Every app command call is recorded in window.__e2e_calls__[command] as its argument list, for `callsOf` in e2e/support.ts (a raw body as {bytes, headers}).
// Both live in the page, so a reload clears them. (@wdio/tauri-service's own `mock` is not used: it does not put the mock back into a reloaded page.)
// Every command the app calls at startup has a harmless base answer, so no test can reach Gmail, the keychain or Slack.
// To change what the app sees at startup, put {command: value} in sessionStorage["e2e-fixtures"] and reload (`boot` in e2e/support.ts does it).
// A mock value of the form {__e2e_reject__: text} makes the command fail with that text, as a Rust `Err(String)` reaches the app.
// A mock value {__e2e_hold__: true} makes the command wait until `release` in e2e/support.ts answers it, so a spec decides when the answer arrives.
// Calls held at the same time are answered by `release` in the order they were made.
// An unmocked command is also recorded in window.__e2e_unmocked__: the app swallows some rejections, and wdio.conf.ts prints the list when a test fails.
// The window is never shown (visible: false in tauri.e2e.conf.json), and WKWebView then reports document.hidden and runs no animation frames,
// which would stop the app's sync, Todo refresh and its requestAnimationFrame work. Make the page behave as in a shown window.
Object.defineProperty(document, "hidden", { get: () => false });
Object.defineProperty(document, "visibilityState", { get: () => "visible" });
window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);

// Lets a script run once even when the driver runs it twice: see `onceId` in e2e/support.ts.
const ran = new Set();
window.__e2e_once__ = (id) => !ran.has(id) && !!ran.add(id);

const core = window.__TAURI__.core;
const real = core.invoke.bind(core);
const fixtures = JSON.parse(sessionStorage.getItem("e2e-fixtures") ?? "{}");
const answers = {
  inbox_cached: null,
  calendar_cached: [],
  calendar_first_day: 0,
  set_calendar_first_day: null,
  inbox: { accounts: [], threads: [], needsLogin: [], failed: {}, historyIds: {} },
  sync: { kind: "unchanged" },
  todoist_cached: null,
  todoist_load: null,
  todoist_connected: false,
  todoist_comments: [],
  slack_load: { workspaces: [], recent: [] },
  claude_status: { state: "missing" },
  claude_model_settings: Object.fromEntries(
    ["slackSummary", "mailSummary", "promptChat", "proofread", "slackReply"].map((purpose) => [purpose, { model: "sonnet", effort: purpose === "slackReply" ? "high" : "medium" }]),
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
  ...fixtures,
};
// The settings card's view of the connection follows the usable state (the subscription is the method in use) unless a spec gives its own.
answers.claude_connection ??= { method: "subscription", subscription: answers.claude_status, apiKey: { state: "none" }, claude: answers.claude_status };
window.__e2e_mocks__ = {};
window.__e2e_calls__ = {};

const invoke = async (cmd, args, options) => {
  // Plugin and event traffic (wdio's own, listen/emit) is not an app command.
  if (cmd.startsWith("plugin:")) return real(cmd, args, options);
  window.__e2e_calls__[cmd] ??= [];
  // A raw body (a file's bytes, with its name in the headers) is recorded as {bytes, headers}, the bytes as numbers: the record is read through the driver, which cannot carry bytes.
  const raw = args instanceof Uint8Array || args instanceof ArrayBuffer;
  window.__e2e_calls__[cmd].push(raw ? { bytes: Array.from(new Uint8Array(args)), headers: options?.headers ?? {} } : (args ?? null));
  if (cmd in window.__e2e_mocks__) {
    const value = structuredClone(window.__e2e_mocks__[cmd]);
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
  }
  if (!(cmd in answers)) {
    window.__e2e_unmocked__ ??= [];
    window.__e2e_unmocked__.push(cmd);
    throw new Error(`e2e: unmocked command "${cmd}" (args ${JSON.stringify(args)})`);
  }
  const answer = structuredClone(answers[cmd]);
  // A fixture can make a command fail from the start too (a mock does the same, once the page is loaded).
  if (answer?.__e2e_reject__ !== undefined) throw answer.__e2e_reject__;
  return answer;
};
window.__TAURI__.core = { ...core, invoke };
