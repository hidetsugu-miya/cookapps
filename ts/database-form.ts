// The edit pane that registers or edits a connection (D-1): while it is open it takes the place of the work pane (`#database-pane`), with the side menu and the terminal pane as they were.
// Its header has the title and the buttons 接続をテスト, キャンセル and 保存; under it are the fields, and the way the connection goes: 直接 (the host and the port of the database) or スクリプト経由 (the script that opens the way).
// Saving runs `save`; a refusal (the reason Rust gives, in Japanese) shows under the fields and the pane stays with what was typed. キャンセル and Escape close it.
// "接続をテスト" runs `test` with the fields as typed (not as saved) and shows the version it answers, or the error (with the last lines of the script's standard error), under the fields.
import type { DatabaseProfile } from "./bindings/DatabaseProfile";
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import { $, composing, tag } from "./dom.js";
import { closeHint } from "./hint.js";
import { closeMenu } from "./menu.js";

let opened: { opener: HTMLElement | null } | null = null;

export function closeDatabaseForm() {
  if (!opened) return;
  const { opener } = opened;
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

const MODES = [
  { id: "direct", label: "直接" },
  { id: "script", label: "スクリプト経由" },
] as const;

// `initial` is the connection to edit, or null for a new one. `save` answers when it is saved and throws what the user is told when it is not. `test` answers the version of the server, and throws what the user is told when it cannot log in.
export function openDatabaseForm(
  initial: DatabaseProfileView | null,
  save: (profile: DatabaseProfile, password: string) => Promise<void>,
  test: (profile: DatabaseProfile, password: string) => Promise<string>,
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

  // The way the connection goes: a connection with a script goes by it, and one with none goes straight to the host and the port.
  let mode: (typeof MODES)[number]["id"] = initial && initial.script !== "" ? "script" : "direct";
  const direct = tag("div", "database-way");
  direct.append(field("DB のホスト", dbHost), field("ポート", dbPort));
  const scripted = tag("div", "database-way");
  scripted.append(field("事前スクリプト", script));
  const tabs = tag("div", "database-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "接続のしかた");
  const drawMode = () => {
    direct.hidden = mode !== "direct";
    scripted.hidden = mode !== "script";
    for (const b of tabs.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
  };
  for (const m of MODES) {
    const button = tag("button", "database-tab", m.label);
    button.type = "button";
    button.dataset.mode = m.id;
    button.setAttribute("role", "tab");
    button.onclick = () => {
      mode = m.id;
      drawMode();
    };
    tabs.append(button);
  }
  drawMode();

  // The fields as typed, in the shape that Rust takes: the fields of the way that is selected only, and no host and port with a script.
  const typed = (): DatabaseProfile => ({
    id: initial?.id ?? "",
    name: name.value,
    username: username.value,
    script: mode === "script" ? script.value : "",
    dbHost: mode === "direct" ? dbHost.value : "",
    dbPort: mode === "direct" ? portOf(dbPort.value) : 0,
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

  const head = tag("header", "database-edit-head");
  head.dataset.tauriDragRegion = "deep";
  const actions = tag("div", "database-edit-actions");
  actions.append(probe, cancel, submit);
  head.append(tag("h1", "", title), actions);
  const body = tag("div", "database-edit-body");
  body.append(field("接続名", name), field("ユーザー名", username), field("パスワード", password, saved), tabs, direct, scripted, result, err);

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

  opened = { opener: document.activeElement as HTMLElement | null };
  $("database-edit").append(form);
  $("database-edit").hidden = false;
  $("database-pane").hidden = true;
  name.focus();
}
