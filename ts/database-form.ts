// The popup that registers or edits a connection (D-1): a dimmed screen with a form in the middle. The screen behind is inert while it is open, so Tab stays inside.
// Saving runs `save`; a refusal (the reason Rust gives, in Japanese) shows under the fields and the popup stays with what was typed. Cancel and Escape close it.
// "接続をテスト" runs `test` with the fields as typed (not as saved) and shows the version it answers, or the error, under the fields.
import type { DatabaseProfile } from "./bindings/DatabaseProfile";
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import { composing, tag } from "./dom.js";
import { closeHint } from "./hint.js";
import { closeMenu } from "./menu.js";

let opened: { scrim: HTMLElement; behind: HTMLElement[]; opener: HTMLElement | null } | null = null;

export function closeDatabaseForm() {
  if (!opened) return;
  opened.scrim.remove();
  for (const el of opened.behind) el.inert = false;
  if (opened.opener?.isConnected) opened.opener.focus();
  opened = null;
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

// A field: its name above, and `status` (a label with a dot) at the right of the name.
function field(label: string, control: HTMLInputElement, status?: Node) {
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
  const useSsm = input("useSsm", "", "checkbox");
  useSsm.checked = initial?.useSsm ?? false;
  const awsProfile = input("awsProfile", initial?.awsProfile ?? "");
  const region = input("region", initial?.region ?? "");
  const bastionName = input("bastionName", initial?.bastionName ?? "");
  const dbHost = input("dbHost", initial?.dbHost ?? "");
  const dbPort = input("dbPort", String(initial?.dbPort ?? 3306), "number");

  const saved = initial?.passwordSaved ? tag("span", "status ok", "保存済み") : undefined;
  const check = tag("label", "database-check");
  check.append(useSsm, "SSM 経由で接続する");
  // Without SSM only the host and the port are used.
  const ssm = tag("div", "database-ssm");
  ssm.hidden = !useSsm.checked;
  ssm.append(field("AWS のプロファイル名", awsProfile), field("リージョン", region), field("踏み台の名前", bastionName));
  useSsm.onchange = () => {
    ssm.hidden = !useSsm.checked;
  };

  // The fields as typed, in the shape that Rust takes.
  const typed = (): DatabaseProfile => ({
    id: initial?.id ?? "",
    name: name.value,
    username: username.value,
    useSsm: useSsm.checked,
    awsProfile: awsProfile.value,
    region: region.value,
    bastionName: bastionName.value,
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
    // The popup may have been closed while the test was on its way.
    if (!form.isConnected) return;
    result.hidden = false;
    probe.disabled = false;
  };
  const cancel = tag("button", "text-btn", "キャンセル");
  cancel.type = "button";
  cancel.onclick = closeDatabaseForm;
  const actions = tag("div", "popup-actions");
  actions.append(submit, probe, cancel);

  const form = tag("form", "database-form");
  form.id = "database-form";
  form.noValidate = true;
  form.setAttribute("role", "dialog");
  form.setAttribute("aria-modal", "true");
  form.setAttribute("aria-label", title);
  form.append(tag("h2", "", title), field("接続名", name), field("ユーザー名", username), field("パスワード", password, saved), check, ssm, field("DB のホスト", dbHost), field("ポート", dbPort), result, err, actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      await save(typed(), password.value);
      closeDatabaseForm();
    } catch (x) {
      err.textContent = String(x);
      err.hidden = false;
      submit.disabled = false;
    }
  };

  const scrim = tag("div", "scrim scrim-center");
  scrim.onkeydown = (e) => {
    if (e.key === "Escape" && !composing(e)) closeDatabaseForm();
  };
  scrim.append(form);
  const behind = [...document.querySelectorAll<HTMLElement>("#sidebar, #content")];
  opened = { scrim, behind, opener: document.activeElement as HTMLElement | null };
  for (const el of behind) el.inert = true;
  document.body.append(scrim);
  name.focus();
}
