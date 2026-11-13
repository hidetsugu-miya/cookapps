// The pane for a Slack workspace whose token lacks the scopes to read messages, and the scope list the hints share.
import type { Workspace } from "./bindings/Workspace";
import { showError } from "./view.js";
import { tag } from "./dom.js";
import { COPY_SVG } from "./icons.js";
import { code, lockFoot, stepList } from "./hint.js";
import { invoke } from "./ipc.js";
import { openPane, closePane } from "./pane.js";
import { renderWorkspaces } from "./settings.js";
import { getSlackWorkspaces } from "./slack-workspaces.js";

// The history scopes, each with the conversations it reads.
const HISTORY_KINDS: Record<string, string> = {
  "channels:history": "公開チャンネル",
  "groups:history": "非公開チャンネル",
  "im:history": "DM",
  "mpim:history": "グループ DM",
};
const HISTORY_SCOPES = Object.keys(HISTORY_KINDS);
// The scopes the token can do without: the Slack list shows names, icons, attached images and the images of custom emoji only with them, and opening a message sets the channel's read position in Slack only with the write ones.
export const OPTIONAL_KINDS: Record<string, string> = {
  "users:read": "送信者の名前とアイコン",
  "files:read": "添付画像",
  "channels:write": "公開チャンネルの既読の同期（チャンネルの管理権限も含みます）",
  "groups:write": "非公開チャンネルの既読の同期（チャンネルの管理権限も含みます）",
  "emoji:read": "カスタム絵文字のリアクションの画像",
};
// `usergroups:read` is optional as well, but it is not in `OPTIONAL_KINDS`: settings does not show it as lacking.
export const SLACK_SCOPES = ["chat:write", "channels:read", "groups:read", ...HISTORY_SCOPES, ...Object.keys(OPTIONAL_KINDS), "usergroups:read"];

// The Slack apps page (a link the default browser opens, by Rust's on_navigation) and a scope list with its copy button.
export function appsLink() {
  const link = tag("a", "", "api.slack.com/apps");
  link.href = "https://api.slack.com/apps";
  return link;
}

// `notes` (scope -> text) puts a short explanation after each scope.
export function scopesBlock(list: string[], notes?: Record<string, string>) {
  const copy = tag("button", "text-btn");
  copy.type = "button";
  const label = `${COPY_SVG}スコープをコピー`;
  copy.innerHTML = label;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(list.join(","));
      copy.textContent = "コピーしました";
      setTimeout(() => (copy.innerHTML = label), 2000);
    } catch (err) {
      showError(err);
    }
  };
  const scopes = tag("div", "scopes");
  if (notes) scopes.classList.add("noted");
  scopes.append(
    ...list.map((s) => {
      if (!notes) return code(s);
      const row = tag("div");
      row.append(code(s), tag("span", "note", notes[s]));
      return row;
    }),
  );
  return [scopes, copy];
}

// The pane for a workspace whose token lacks the scopes `missing` for reading messages: what to do in Slack, and a field for the new token.
export function openPermissionPane(w: Workspace, missing: string[]) {
  const input = tag("input");
  input.type = "password";
  input.autocomplete = "off";
  input.required = true;
  input.setAttribute("aria-label", "Slack の User OAuth Token");
  input.placeholder = "User OAuth Token（xoxp-…）";
  const submit = tag("button", "text-btn", "貼り直す");
  const form = tag("form", "card-add");
  form.append(input, submit);
  const err = tag("p", "err danger");
  err.hidden = true;
  form.onsubmit = async (e) => {
    e.preventDefault();
    // The token is never shown: the field is emptied as soon as it is read.
    const token = input.value;
    input.value = "";
    err.hidden = true;
    submit.disabled = true;
    try {
      const list = await invoke("slack_add_workspace", { token });
      // Another workspace's token is added as it is (the list grows, or this workspace is gone); the pane says so and stays.
      const other = list.length > getSlackWorkspaces()!.length || !list.some((x) => x.teamId === w.teamId);
      renderWorkspaces(list);
      if (other) {
        err.textContent = `${w.team} のトークンではありません`;
        err.hidden = false;
      } else closePane();
    } catch (x) {
      err.textContent = String(x);
      err.hidden = false;
    }
    submit.disabled = false;
  };
  openPane(
    `${w.team} の権限を足す`,
    tag("p", "", `このトークンには ${missing.join("、")} がありません。`),
    stepList([
      [appsLink(), " で、このワークスペースのアプリを選ぶ"],
      ["「OAuth & Permissions」の「User Token Scopes」に次を足す", ...scopesBlock(missing, HISTORY_KINDS)],
      ["ページ上部の「Reinstall to Workspace」を押して許可する（管理者の承認が要ることがある）"],
      ["「User OAuth Token」（", code("xoxp-"), "）をコピーして、下の欄に貼る"],
    ]),
    form,
    err,
    lockFoot("トークンは OS の資格情報の保管場所に入れ、画面には出しません"),
  );
}
