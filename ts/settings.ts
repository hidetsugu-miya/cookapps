// The settings screen: one card each for Slack and Claude. A Slack token is never shown; Rust keeps it in the keychain.
import type { SlackLoad } from "./bindings/SlackLoad";
import type { Workspace } from "./bindings/Workspace";
import { $, tag } from "./dom.js";
import { avatarColor, hostOf, initials } from "./format.js";
import { UNLINK_SVG } from "./icons.js";
import { code, confirmUnlink, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { appsLink, openPermissionPane, scopesBlock, SLACK_SCOPES } from "./permission-pane.js";
import { setSlackWorkspaces } from "./slack-workspaces.js";
import { updateAddMode } from "./todo-add.js";
import { loadPromptState } from "./todo-prompt.js";
import { showError } from "./view.js";

let settingsSeq = 0;

// A connected service's row: avatar, name, a line under it, a state label (`status` is [class, text]) and buttons. `meta` is a string or a list of strings and nodes.
// With `onHelp`, the state label and the line under the name are buttons that call it.
export function itemRow({ avatar, name, meta, warn = false, status, actions = [], onHelp }: {
  avatar?: HTMLElement;
  name: string;
  meta: string | (string | Node)[];
  warn?: boolean;
  status: [string, string];
  actions?: HTMLElement[];
  onHelp?: () => void;
}) {
  const line = tag(onHelp ? "button" : "div", `item-meta${warn ? " warn" : ""}`);
  const label = tag(onHelp ? "button" : "span", `status ${status[0]}`, status[1]);
  if (onHelp) {
    (line as HTMLButtonElement).type = (label as HTMLButtonElement).type = "button";
    line.onclick = label.onclick = onHelp;
  }
  line.append(...[meta].flat());
  const who = tag("div", "who");
  who.append(tag("div", "item-name", name), line);
  const row = tag("div", "item");
  row.append(...(avatar ? [avatar] : []), who, label, ...actions);
  return row;
}

// What `slack_check` found about a workspace's token: usable, lacking scopes for reading messages, or not answered.
type Check = { state: "ok" | "noRead"; missing: string[] } | { state: "error"; message: string };

// teamId -> the last `slack_check` of that workspace's token. A redraw after an add or a removal reuses it,
// except for a workspace that is new, has a different user (its token was replaced), or was not usable.
const wsChecks = new Map<string, { user: string; bad: boolean; done: Promise<Check> }>();
function checkWorkspace(w: Workspace) {
  const prev = wsChecks.get(w.teamId);
  if (prev && !prev.bad && prev.user === w.user) return prev;
  const c = { user: w.user, bad: false } as { user: string; bad: boolean; done: Promise<Check> };
  // missingScopes is null when Slack sent no scopes to judge by: the token counts as usable until a read fails with missing_scope.
  c.done = invoke("slack_check", { teamId: w.teamId }).then(
    (r): Check => {
      const missing = r.missingScopes ?? [];
      c.bad = missing.length > 0;
      return { state: c.bad ? "noRead" : "ok", missing };
    },
    (e): Check => {
      c.bad = true;
      return { state: "error", message: String(e) };
    },
  );
  wsChecks.set(w.teamId, c);
  return c;
}

const WORKSPACE_STATUS: Record<Check["state"], [string, string]> = { ok: ["ok", "接続済み"], noRead: ["warn", "権限が不足"], error: ["warn", "確認できません"] };

// `result` is the check's answer, or null while it is being asked.
function workspaceRow(w: Workspace, result: Check | null) {
  const avatar = tag("span", "avatar", initials(w.team));
  avatar.style.background = avatarColor(w.team);
  const unlink = tag("button", "icon-btn");
  unlink.innerHTML = UNLINK_SVG;
  unlink.setAttribute("aria-label", `${w.team} の接続を解除`);
  unlink.setAttribute("data-hint", "");
  unlink.onclick = () =>
    confirmUnlink(unlink, w, async () => {
      $("error").hidden = true;
      try {
        const left = await invoke("slack_remove_workspace", { teamId: w.teamId });
        wsChecks.delete(w.teamId);
        renderWorkspaces(left);
      } catch (e) {
        showError(e);
      }
    });
  const meta =
    result?.state === "noRead"
      ? `${result.missing.join("、")} の権限がありません。スコープを足して、トークンを貼り直してください`
      : result?.state === "error"
        ? result.message
        : `${w.user} ・ ${hostOf(w.url)}`;
  return itemRow({
    avatar,
    name: w.team,
    meta,
    warn: result?.state === "noRead" || result?.state === "error",
    status: result ? WORKSPACE_STATUS[result.state] : ["off", "確認中"],
    actions: [unlink],
    onHelp: result?.state === "noRead" ? () => openPermissionPane(w, result.missing) : undefined,
  });
}

// Draws the workspaces, then asks Slack about each token that has not been asked: a row says why when its token is not usable.
export function renderWorkspaces(list: Workspace[]) {
  const seq = ++settingsSeq;
  setSlackWorkspaces(list);
  updateAddMode();
  $("slack-workspaces").replaceChildren(
    ...(list.length
      ? list.map((w) => {
          const row = workspaceRow(w, null);
          checkWorkspace(w).done.then((r) => {
            if (seq === settingsSeq) row.replaceWith(workspaceRow(w, r));
          });
          return row;
        })
      : [tag("div", "card-empty", "ワークスペースはまだありません")]),
  );
}

export async function loadSettings() {
  const seq = ++settingsSeq;
  $("error").hidden = true;
  loadPromptState();
  let loaded: SlackLoad;
  try {
    loaded = await invoke("slack_load");
  } catch (e) {
    return showError(e);
  }
  if (seq !== settingsSeq) return;
  // Opening the settings asks about every token again.
  wsChecks.clear();
  renderWorkspaces(loaded.workspaces);
}

export function initSettings() {
  $("slack-token").onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("slack-token-input");
    const token = input.value;
    // The token is never shown: the field is emptied as soon as it is read.
    input.value = "";
    $("error").hidden = true;
    try {
      renderWorkspaces(await invoke("slack_add_workspace", { token }));
    } catch (err) {
      showError(err);
    }
  };
  $("slack-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "Slack の接続方法",
        [
          [appsLink(), " で、ワークスペースごとにアプリを作る"],
          ["「User Token Scopes」に次を足す", ...scopesBlock(SLACK_SCOPES)],
          ["ワークスペースにインストールし、", code("xoxp-"), " で始まるトークンを下の欄に貼る"],
        ],
        "トークンは OS の資格情報の保管場所に入れ、画面には出しません",
      ),
    );
}
