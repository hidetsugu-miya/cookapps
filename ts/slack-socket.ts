// The "リアルタイム更新" card in the Slack tab of the settings screen (S-16): a row per workspace with the state of its Socket Mode connection,
// a button that deletes its App-Level Token, and the field that registers one. Rust keeps the token in the keychain and the connection going; this module only holds the states it was told.
import type { SocketState } from "./bindings/SocketState";
import type { SocketStatus } from "./bindings/SocketStatus";
import type { Workspace } from "./bindings/Workspace";
import { $, tag } from "./dom.js";
import { avatarColor, initials } from "./format.js";
import { code, confirmUnlink, hintPopup, toggleHint } from "./hint.js";
import { LINK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { appsLink } from "./permission-pane.js";
import { itemRow } from "./settings.js";
import { getSlackWorkspaces, onSlackWorkspaces } from "./slack-workspaces.js";
import { showError } from "./view.js";

// teamId -> the state Rust last told; a workspace not in it has no App-Level Token.
const states = new Map<string, SocketState>();

const LABEL: Record<SocketState, [string, string]> = {
  off: ["off", "未登録"],
  connecting: ["off", "接続中"],
  connected: ["ok", "つながっている"],
  reconnecting: ["warn", "つなぎ直し中"],
};

const META: Record<SocketState, string> = {
  off: "未登録の間は、2 分ごとに読み直します",
  connecting: "つながるまでは、2 分ごとに読み直します",
  connected: "新着をすぐに一覧へ出します。読み直しは 5 分ごとです",
  reconnecting: "つながるまでは、2 分ごとに読み直します",
};

function workspaceRow(w: Workspace) {
  const state = states.get(w.teamId) ?? "off";
  const avatar = tag("span", "avatar", initials(w.team));
  avatar.style.background = avatarColor(w.team);
  const actions: HTMLElement[] = [];
  if (state !== "off") {
    const unlink = tag("button", "icon-btn");
    unlink.innerHTML = LINK_SVG;
    unlink.setAttribute("aria-label", `${w.team} の App-Level Token を削除`);
    unlink.setAttribute("data-hint", "");
    unlink.onclick = () =>
      confirmUnlink(unlink, `${w.team} のリアルタイム更新`, "App-Level Token を cookapps から削除します。Slack のアプリは残ります。", async () => {
        $("error").hidden = true;
        try {
          adopt(await invoke("slack_app_token_remove", { teamId: w.teamId }));
        } catch (e) {
          showError(e);
        }
      });
    actions.push(unlink);
  }
  return itemRow({ avatar, name: w.team, meta: META[state], status: LABEL[state], actions });
}

function render() {
  const list = getSlackWorkspaces() ?? [];
  $("slack-socket-items").replaceChildren(...(list.length ? list.map(workspaceRow) : [tag("div", "card-empty", "ワークスペースはまだありません")]));
  const select = $<HTMLSelectElement>("slack-socket-team");
  const chosen = select.value;
  select.replaceChildren(
    ...list.map((w) => {
      const option = tag("option", "", w.team);
      option.value = w.teamId;
      return option;
    }),
  );
  if (list.some((w) => w.teamId === chosen)) select.value = chosen;
  for (const control of [select, $("slack-socket-token"), $("slack-socket-form").querySelector("button")!] as (HTMLElement & { disabled: boolean })[]) control.disabled = list.length === 0;
}

// The connections as Rust answers them: every workspace not in the list is off.
function adopt(list: SocketStatus[]) {
  states.clear();
  for (const s of list) states.set(s.teamId, s.state);
  render();
}

export function initSlackSocket() {
  onSlackWorkspaces(render);
  render();
  $("slack-socket-form").onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("slack-socket-token");
    const token = input.value;
    // The token is never shown: the field is emptied as soon as it is read.
    input.value = "";
    $("error").hidden = true;
    try {
      adopt(await invoke("slack_app_token_set", { teamId: $<HTMLSelectElement>("slack-socket-team").value, token }));
    } catch (err) {
      showError(err);
    }
  };
  $("slack-socket-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "リアルタイム更新の設定方法",
        [
          [appsLink(), " で、User OAuth Token を取ったアプリを開く"],
          ["「Socket Mode」を有効にする"],
          ["「Event Subscriptions」を有効にし、「Subscribe to events on behalf of users」に ", code("message.channels"), " と ", code("message.groups"), " を足して、保存する（アプリの再インストールを求められたら、する）"],
          ["「Basic Information」の「App-Level Tokens」で、", code("connections:write"), " のトークンを作り、", code("xapp-"), " で始まる値を下の欄に貼る"],
          ["つながると、投稿や返信をすぐに Slack の一覧へ出します。つながっている間、一覧の読み直しは 5 分ごとになります（そのほかは 2 分ごと）。切れたときは自動でつなぎ直します"],
        ],
        "トークンは OS の資格情報の保管場所に入れ、画面には出しません",
      ),
    );
  // Rust tells each change of a connection; the first answer fills in what was before this listener.
  window.__TAURI__.event.listen<SocketStatus>("slack-socket-status", ({ payload }) => {
    states.set(payload.teamId, payload.state);
    render();
  });
  invoke("slack_socket_status").then(
    (list) => {
      for (const s of list) if (!states.has(s.teamId)) states.set(s.teamId, s.state);
      render();
    },
    (e) => showError(e),
  );
}
