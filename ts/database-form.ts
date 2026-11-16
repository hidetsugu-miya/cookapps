// The edit pane that registers or edits a connection (D-1): while it is open it takes the place of the work pane (`#database-pane`), with the side menu and the terminal pane as they were.
// Its header has the title and the buttons 接続をテスト, キャンセル and 保存; under it are the fields: the host and the port of the database, and the script that opens the way to them (it may be empty).
// Saving runs `save`; a refusal (the reason Rust gives, in Japanese) shows under the fields and the pane stays with what was typed. キャンセル and Escape close it.
// "接続をテスト" runs `test` with the fields as typed (not as saved) and shows the version it answers, or the error (with the last lines of the script's standard error), under the fields.
// The icon at the right end of the header opens and closes the terminal pane (D-7), where Claude Code may save this connection through cookapps-mcp (D-8): while the pane of a saved connection is open, the list is read at an interval, and a field that was not changed by hand takes the value that was saved elsewhere, while a field that was changed by hand stays. The interval stops when the pane is closed or the connection is gone from the list.
import type { DatabaseProfile } from "./bindings/DatabaseProfile";
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import { $, composing, tag } from "./dom.js";
import { isDatabaseTerminalOpen, toggleDatabaseTerminal } from "./database-terminal.js";
import { periodMs } from "./e2e-timers.js";
import { closeHint } from "./hint.js";
import { TERMINAL_SVG } from "./icons.js";
import { closeMenu } from "./menu.js";

// How often the list is read while the pane of a saved connection is open.
const WATCH_MS = 2000;

let opened: { opener: HTMLElement | null; timer: number | null } | null = null;

export function closeDatabaseForm() {
  if (!opened) return;
  const { opener, timer } = opened;
  if (timer !== null) clearInterval(timer);
  opened = null;
  $("database-edit").replaceChildren();
  $("database-edit").hidden = true;
  $("database-pane").hidden = false;
  if (opener?.isConnected) opener.focus();
}

function input(name: string, value: string, type = "text") {
  const node = tag("input");
  node.type = type;
  node.name = name;
  node.value = value;
  node.autocomplete = "off";
  node.spellcheck = false;
  return node;
}

// The script that opens the way to the database (D-1): several lines of code, so a text area.
function area(name: string, value: string) {
  const node = tag("textarea", "database-script-text");
  node.name = name;
  node.value = value;
  node.rows = 12;
  node.spellcheck = false;
  return node;
}

// A field: its name above, and `status` (a label with a dot) at the right of the name.
function field(label: string, control: HTMLInputElement | HTMLTextAreaElement, status?: Node) {
  const row = tag("label", "database-field");
  const head = tag("span", "database-label", label);
  if (status) head.append(status);
  row.append(head, control);
  return row;
}

// The port as a whole number; anything else is 0, which Rust refuses with its own words.
const portOf = (text: string) => {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? 0 : n;
};

// `initial` is the connection to edit, or null for a new one. `save` answers when it is saved and throws what the user is told when it is not. `test` answers the version of the server, and throws what the user is told when it cannot log in. `list` reads the saved connections, and answers none when it cannot.
export function openDatabaseForm(
  initial: DatabaseProfileView | null,
  save: (profile: DatabaseProfile, password: string) => Promise<void>,
  test: (profile: DatabaseProfile, password: string) => Promise<string>,
  list: () => Promise<DatabaseProfileView[] | null>,
) {
  closeDatabaseForm();
  closeHint();
  closeMenu();
  const title = initial ? "接続を編集" : "接続を追加";
  const name = input("name", initial?.name ?? "");
  const username = input("username", initial?.username ?? "");
  const password = input("password", "", "password");
  const script = area("script", initial?.script ?? "");
  const dbHost = input("dbHost", initial?.dbHost ?? "");
  const dbPort = input("dbPort", String(initial?.dbPort || 3306), "number");

  const saved = initial?.passwordSaved ? tag("span", "status ok", "保存済み") : undefined;

  // The fields that the user changed by hand, which a reload of the saved connection leaves as they are.
  const byHand = new Set<string>();
  const handled: [string, HTMLInputElement | HTMLTextAreaElement][] = [["name", name], ["username", username], ["dbHost", dbHost], ["dbPort", dbPort], ["script", script]];
  for (const [key, control] of handled) control.addEventListener("input", () => byHand.add(key));

  // The fields as typed, in the shape that Rust takes; the checks are Rust's.
  const typed = (): DatabaseProfile => ({
    id: initial?.id ?? "",
    name: name.value,
    username: username.value,
    script: script.value,
    dbHost: dbHost.value,
    dbPort: portOf(dbPort.value),
  });

  // The answer of "接続をテスト": the version as a status, or the error.
  const result = tag("p", "database-test");
  result.id = "database-test-result";
  result.setAttribute("role", "status");
  result.hidden = true;
  const err = tag("p", "err danger");
  err.id = "database-form-error";
  err.setAttribute("role", "alert");
  err.hidden = true;
  const submit = tag("button", "text-btn primary", "保存");
  submit.type = "submit";
  const probe = tag("button", "text-btn", "接続をテスト");
  probe.type = "button";
  probe.onclick = async () => {
    result.hidden = true;
    probe.disabled = true;
    try {
      const version = await test(typed(), password.value);
      result.className = "database-test status ok";
      result.textContent = `MySQL ${version}`;
    } catch (x) {
      result.className = "database-test err danger";
      result.textContent = String(x);
    }
    // The pane may have been closed while the test was on its way.
    if (!form.isConnected) return;
    result.hidden = false;
    probe.disabled = false;
  };
  const cancel = tag("button", "text-btn", "キャンセル");
  cancel.type = "button";
  cancel.onclick = closeDatabaseForm;

  const terminal = tag("button", "icon-btn");
  terminal.type = "button";
  terminal.id = "database-edit-terminal";
  terminal.setAttribute("aria-label", "ターミナル");
  terminal.setAttribute("aria-pressed", String(isDatabaseTerminalOpen()));
  terminal.innerHTML = TERMINAL_SVG;
  terminal.onclick = () => {
    toggleDatabaseTerminal();
    terminal.setAttribute("aria-pressed", String(isDatabaseTerminalOpen()));
  };

  const head = tag("header", "database-edit-head");
  head.dataset.tauriDragRegion = "deep";
  const actions = tag("div", "database-edit-actions");
  actions.append(probe, cancel, submit);
  head.append(tag("h1", "", title), actions, terminal);
  const body = tag("div", "database-edit-body");
  body.append(field("接続名", name), field("ユーザー名", username), field("パスワード", password, saved), field("DB のホスト", dbHost), field("ポート", dbPort), field("事前スクリプト", script), result, err);

  const form = tag("form", "database-form");
  form.id = "database-form";
  form.noValidate = true;
  form.setAttribute("aria-label", title);
  form.append(head, body);
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      await save(typed(), password.value);
      // Another edit may have taken the pane while the save was on its way.
      if (form.isConnected) closeDatabaseForm();
    } catch (x) {
      err.textContent = String(x);
      err.hidden = false;
      submit.disabled = false;
    }
  };
  form.onkeydown = (e) => {
    if (e.key === "Escape" && !composing(e)) closeDatabaseForm();
  };

  const mine = { opener: document.activeElement as HTMLElement | null, timer: null as number | null };
  opened = mine;
  $("database-edit").append(form);
  $("database-edit").hidden = false;
  $("database-pane").hidden = true;
  name.focus();

  if (initial === null) return;
  const { id } = initial;
  let reading = false;
  const reload = async () => {
    if (reading || document.hidden) return;
    reading = true;
    const profiles = await list().finally(() => {
      reading = false;
    });
    if (opened !== mine || profiles === null) return;
    const next = profiles.find((p) => p.id === id);
    // The connection is gone from the list: nothing is read again, and the pane stays with what it holds.
    if (!next) {
      if (mine.timer !== null) clearInterval(mine.timer);
      mine.timer = null;
      return;
    }
    const take = (key: string, control: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      if (!byHand.has(key) && control.value !== value) control.value = value;
    };
    take("name", name, next.name);
    take("username", username, next.username);
    take("dbHost", dbHost, next.dbHost);
    take("dbPort", dbPort, String(next.dbPort || 3306));
    take("script", script, next.script);
  };
  mine.timer = window.setInterval(() => void reload(), periodMs("databaseProfiles", WATCH_MS));
}
