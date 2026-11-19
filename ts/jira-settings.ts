// The card 「Jira 接続」 of the 開発 tab (the tab `orca`) of the settings screen (J-1): the site's URL, the email address and the API token of Jira Cloud, a save, and a test of the connection.
// The token is never shown: the field is emptied as soon as it is read, and Rust keeps it in the keychain and answers only whether one is kept.
import type { JiraSettings } from "./bindings/JiraSettings";
import type { JiraUser } from "./bindings/JiraUser";
import { $ } from "./dom.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { itemRow } from "./settings.js";
import { logError, showFailure } from "./error-card.js";

// The saved connection as last read, or null until the first read.
let saved: JiraSettings | null = null;
// What the last test found: the user it answered, "failed" for an error, null when none was made since the last read or save.
let tested: JiraUser | "failed" | null = null;
// Only the latest read may draw, and none that began before a save.
let readSeq = 0;

const input = (id: string) => $<HTMLInputElement>(id);

// The values of the form; the token is taken out of its field.
function form() {
  const token = input("jira-token");
  const values = { site: input("jira-site").value, email: input("jira-email").value, token: token.value };
  token.value = "";
  return values;
}

function status(): [string, string] {
  if (tested === "failed") return ["warn", "接続できません"];
  if (tested) return ["ok", "接続できました"];
  return saved?.site && saved.hasToken ? ["ok", "保存済み"] : ["off", "未設定"];
}

function draw() {
  const meta = tested && tested !== "failed" ? [tested.displayName, tested.emailAddress].filter((s) => s).join(" ・ ") : (saved?.site ?? "");
  $("jira-items").replaceChildren(itemRow({ name: "Jira", meta, status: status() }));
}

// Reads the saved connection into the form and draws the row: each time the 開発 tab is shown. Jira is asked nothing.
export function showJiraCard() {
  const seq = ++readSeq;
  invoke("jira_settings").then(
    (s) => {
      if (seq !== readSeq) return;
      saved = s;
      tested = null;
      input("jira-site").value = s.site;
      input("jira-email").value = s.email;
      input("jira-token").value = "";
      draw();
    },
    (e) => logError("jira-settings", e),
  );
}

async function save() {
  readSeq++;
  const { site, email, token } = form();
  try {
    saved = await invoke("jira_save", { site, email, token });
  } catch (e) {
    return showFailure("jira-settings", e);
  }
  tested = null;
  input("jira-site").value = saved.site;
  input("jira-email").value = saved.email;
  draw();
}

async function test(button: HTMLButtonElement) {
  button.disabled = true;
  const { site, email, token } = form();
  try {
    tested = await invoke("jira_test", { site, email, token });
  } catch (e) {
    tested = "failed";
    showFailure("jira-settings", e);
  } finally {
    button.disabled = false;
  }
  draw();
}

export function initJiraCard() {
  draw();
  $("jira-form").onsubmit = (e) => {
    e.preventDefault();
    save();
  };
  $("jira-test").onclick = (e) => test(e.currentTarget as HTMLButtonElement);
  $("jira-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "Jira 接続",
        [
          ["Atlassian Cloud のサイトだけにつなげます。サイトの URL は ", code("https://{名前}.atlassian.net"), " の形です"],
          ["メールアドレスを入れると、アカウントの API トークンとして Basic 認証で送ります"],
          ["メールアドレスを空にすると、スコープ付きトークンとして、api.atlassian.com を通して Bearer 認証で送ります"],
          ["「保存」は、トークンを空にすると保存済みのトークンをそのまま使います"],
          ["「接続を試す」は、フォームの値で Jira に自分が誰かを尋ねます。何も保存しません"],
        ],
        "トークンは OS の資格情報の保管場所に入れ、画面には出しません",
      ),
    );
}
