// The settings screen: a tab each for Google, the calendar (the day the week starts on), Todoist (whether it is connected), Slack, Claude, Orca (the card of the terminal colors is `ts/orca-theme.ts`, that of Ghostty's settings `ts/ghostty.ts`) and the updater, each with its card.
// The heading and the tabs stay at the top while a card scrolls. A token is never shown; Rust keeps it in the keychain.
import type { HiddenChannel } from "./bindings/HiddenChannel";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { Workspace } from "./bindings/Workspace";
import { calendarFirstDay, setCalendarFirstDay } from "./calendar.js";
import { loadModelSettings, showClaudeTab } from "./claude.js";
import { $, tag } from "./dom.js";
import { avatarColor, hostOf, initials, WEEKDAYS } from "./format.js";
import { LINK_SVG } from "./icons.js";
import { closeHint, code, confirmUnlink, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { appsLink, OPTIONAL_KINDS, openPermissionPane, scopesBlock, SLACK_SCOPES } from "./permission-pane.js";
import { bumpSlackList, setSlackWorkspaces } from "./slack-workspaces.js";
import { workspaceColor } from "./slack-view.js";
import { updateAddMode } from "./todo-add.js";
import { showTokenForm } from "./todo.js";
import { loadPromptState } from "./todo-prompt.js";
import { showError } from "./view.js";

let settingsSeq = 0;

export const SETTINGS_TABS = ["google", "calendar", "todoist", "slack", "claude", "orca", "update"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

// The tab shown; the settings screen opens on Google unless the way in names another.
let tab: SettingsTab = "google";
export const settingsTab = () => tab;

// Shows the card of `name` alone, closes an open hint, and scrolls the card to its top.
export function selectSettingsTab(name: SettingsTab) {
  tab = name;
  for (const t of SETTINGS_TABS) {
    const button = $(`settings-tab-${t}`);
    button.setAttribute("aria-selected", String(t === name));
    button.tabIndex = t === name ? 0 : -1;
    $(`settings-panel-${t}`).hidden = t !== name;
  }
  closeHint();
  $("error").hidden = true;
  $("settings").scrollTop = 0;
  // The connection is asked about only once the Claude tab is shown.
  if (name === "claude") showClaudeTab();
  // The tokens are asked about only once the Slack tab is shown.
  if (name === "slack" && workspaces.some((w) => !wsChecks.has(w.teamId))) drawWorkspaces(workspaces, settingsSeq);
}

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
// `optional` are the scopes the token lacks and can do without (the workspace stays usable).
type Check = { state: "ok" | "noRead"; missing: string[]; optional: string[] } | { state: "error"; message: string };

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
      return { state: c.bad ? "noRead" : "ok", missing, optional: r.missingOptional ?? [] };
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
  unlink.innerHTML = LINK_SVG;
  unlink.setAttribute("aria-label", `${w.team} の接続を解除`);
  unlink.setAttribute("data-hint", "");
  unlink.onclick = () =>
    confirmUnlink(unlink, w.team, "トークンを Slack で取り消し、cookapps から削除します。Slack のアプリは残ります。", async () => {
      $("error").hidden = true;
      try {
        const left = await invoke("slack_remove_workspace", { teamId: w.teamId });
        wsChecks.delete(w.teamId);
        renderWorkspaces(left);
        // The channels kept off the list go with their workspace.
        loadHiddenCard();
      } catch (e) {
        showError(e);
      }
    });
  const meta =
    result?.state === "noRead"
      ? `${result.missing.join("、")} の権限がありません。スコープを足して、トークンを貼り直してください`
      : result?.state === "error"
        ? result.message
        : [`${w.user} ・ ${hostOf(w.url)}`, ...(result?.optional.length ? [` ・ ${result.optional.map((s) => `${s}（${OPTIONAL_KINDS[s] ?? s}）`).join("、")}はありません。足すと Slack の画面で使えます`] : [])].join("");
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

// The workspaces as last drawn.
let workspaces: Workspace[] = [];

// Draws the workspaces, then asks Slack about each token that has not been asked: a row says why when its token is not usable.
export function renderWorkspaces(list: Workspace[]) {
  const seq = ++settingsSeq;
  workspaces = list;
  setSlackWorkspaces(list);
  updateAddMode();
  drawWorkspaces(list, seq);
}

// The rows of the Slack card. The tokens are asked about only while the Slack tab is shown (the tab asks when it is pressed).
function drawWorkspaces(list: Workspace[], seq: number) {
  $("slack-workspaces").replaceChildren(
    ...(list.length
      ? list.map((w) => {
          const row = workspaceRow(w, null);
          if (tab === "slack")
            checkWorkspace(w).done.then((r) => {
              if (seq === settingsSeq) row.replaceWith(workspaceRow(w, r));
            });
          return row;
        })
      : [tag("div", "card-empty", "ワークスペースはまだありません")]),
  );
}

// The "一覧に出さないチャンネル" card: the channels kept off the Slack list, each with a button that puts it back. Only the latest read may draw.
let hiddenSeq = 0;

function hiddenRow(h: HiddenChannel) {
  const label = h.name === h.channel ? h.channel : `#${h.name}`;
  const dot = tag("i", "hidden-dot");
  dot.style.background = workspaceColor(h.team);
  const who = tag("div", "who");
  who.append(tag("div", "item-name", label), tag("div", "item-meta", h.team));
  const back = tag("button", "text-btn", "戻す");
  back.type = "button";
  back.setAttribute("aria-label", `${label} を一覧に戻す`);
  back.onclick = async () => {
    $("error").hidden = true;
    try {
      await invoke("slack_unhide_channel", { teamId: h.teamId, channel: h.channel });
      bumpSlackList();
    } catch (e) {
      showError(e);
    }
    loadHiddenCard();
  };
  const row = tag("div", "item");
  row.append(dot, who, back);
  return row;
}

function renderHiddenCard(list: HiddenChannel[]) {
  $("slack-hidden-count").textContent = `${list.length} 件`;
  $("slack-hidden").replaceChildren(...(list.length ? list.map(hiddenRow) : [tag("div", "card-empty", "一覧に出さないチャンネルはありません")]));
}

async function loadHiddenCard() {
  const seq = ++hiddenSeq;
  let list: HiddenChannel[];
  try {
    list = await invoke("slack_hidden_list");
  } catch (e) {
    return showError(e);
  }
  if (seq === hiddenSeq) renderHiddenCard(list);
}

// The day the week starts on as the calendar card shows it; null until read.
let calendarDay: number | null = null;

function renderCalendarCard() {
  const picks = tag("div", "day-picks");
  picks.setAttribute("role", "group");
  picks.setAttribute("aria-label", "週の始まり");
  WEEKDAYS.forEach((name, day) => {
    const b = tag("button", "text-btn", name);
    b.type = "button";
    b.setAttribute("aria-pressed", String(day === calendarDay));
    b.onclick = () => pickFirstDay(day);
    picks.append(b);
  });
  const who = tag("div", "who");
  who.append(tag("div", "item-name", "週の始まり"));
  const row = tag("div", "item");
  row.append(who, picks);
  $("calendar-items").replaceChildren(row);
}

// The selection moves only once the day is saved; a failure leaves it where it was and shows the error.
// A press while a save is on its way is ignored, as saves would share one temporary file.
let savingDay = false;

async function pickFirstDay(day: number) {
  if (day === calendarDay || savingDay) return;
  savingDay = true;
  $("error").hidden = true;
  try {
    await setCalendarFirstDay(day);
  } catch (e) {
    return showError(e);
  } finally {
    savingDay = false;
  }
  calendarDay = day;
  renderCalendarCard();
}

async function loadCalendarCard() {
  try {
    calendarDay = await calendarFirstDay();
  } catch (e) {
    return showError(e);
  }
  renderCalendarCard();
}

// Whether Todoist has a token, as the Todoist card shows it; null until read. The token form stays on the Todo screen.
let todoistConnected: boolean | null = null;
// Only the latest read, and no read that began before an unlink, may draw the card.
let todoistSeq = 0;

function renderTodoistCard() {
  if (todoistConnected === null) return $("todoist-items").replaceChildren();
  let row: HTMLElement;
  if (todoistConnected) {
    const unlink = tag("button", "icon-btn");
    unlink.innerHTML = LINK_SVG;
    unlink.setAttribute("aria-label", "Todoist の接続を解除");
    unlink.setAttribute("data-hint", "");
    unlink.onclick = () =>
      confirmUnlink(unlink, "Todoist", "トークンを cookapps から削除します。Todoist のタスクは残ります。", unlinkTodoist);
    row = itemRow({ name: "Todoist", meta: "", status: ["ok", "接続済み"], actions: [unlink] });
  } else {
    row = itemRow({ name: "Todoist", meta: "Todo 画面でトークンを入力します", status: ["off", "未接続"] });
  }
  $("todoist-items").replaceChildren(row);
}

async function unlinkTodoist() {
  $("error").hidden = true;
  todoistSeq++;
  try {
    await invoke("todoist_disconnect");
  } catch (e) {
    return showError(e);
  }
  // The Todo screen forgets its content too, and the sidebar's count goes to 0.
  showTokenForm();
  todoistConnected = false;
  renderTodoistCard();
}

async function loadTodoistCard() {
  const seq = ++todoistSeq;
  let connected: boolean;
  try {
    connected = await invoke("todoist_connected");
  } catch (e) {
    return showError(e);
  }
  if (seq !== todoistSeq) return;
  todoistConnected = connected;
  renderTodoistCard();
}

export async function loadSettings() {
  const seq = ++settingsSeq;
  $("error").hidden = true;
  loadPromptState();
  loadModelSettings();
  loadCalendarCard();
  loadTodoistCard();
  loadHiddenCard();
  let loaded: SlackLoad;
  try {
    loaded = await invoke("slack_load");
  } catch (e) {
    return showError(e);
  }
  if (seq !== settingsSeq) return;
  // Opening the settings forgets the answers; the Slack tab asks about every token again.
  wsChecks.clear();
  renderWorkspaces(loaded.workspaces);
}

export function initSettings() {
  for (const t of SETTINGS_TABS) $(`settings-tab-${t}`).onclick = () => selectSettingsTab(t);
  // Left and right move to the neighbour tab (the first and the last are neighbours), and the focus goes with it.
  $("settings-tabs").onkeydown = (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = SETTINGS_TABS[(SETTINGS_TABS.indexOf(tab) + step + SETTINGS_TABS.length) % SETTINGS_TABS.length]!;
    selectSettingsTab(next);
    $(`settings-tab-${next}`).focus();
  };
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
          [code("users:read"), " と ", code("files:read"), " は、Slack の画面に送信者の名前とアイコン、添付画像を出すために使います。なくても、ほかのことはできます。", code("channels:write"), " と ", code("groups:write"), " は、Slack の画面でメッセージを開いたときや「すべて既読にする」を押したとき、Slack 側のそのチャンネルも既読にするために使います。Slack の仕様で、この 2 つにはチャンネルの管理権限も含まれますが、cookapps は既読位置を送る呼び出し（conversations.mark）にしか使いません。足さなくても、既読を Slack と同期すること以外はできます"],
          ["ワークスペースにインストールし、", code("xoxp-"), " で始まるトークンを下の欄に貼る"],
        ],
        "トークンは OS の資格情報の保管場所に入れ、画面には出しません",
      ),
    );
}
