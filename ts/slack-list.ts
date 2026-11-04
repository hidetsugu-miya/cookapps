// The Slack screen's list (S-5): the newest 20 messages of the joined channels of every workspace, newest first. A row opens the thread (slack-thread.ts).
// The workspaces' own icons and statuses go to the sidebar's tray. Everything is held in memory only; the list is read when the screen is shown and again every `refreshSecs` while it stays.
import type { Timeline } from "./bindings/Timeline";
import type { TimelineMessage } from "./bindings/TimelineMessage";
import type { Workspace } from "./bindings/Workspace";
import { renderWorkspaceTray } from "./accounts.js";
import { $, tag } from "./dom.js";
import { formatDate } from "./format.js";
import { invoke } from "./ipc.js";
import { currentScreen, setScreen } from "./nav.js";
import { setSlackWorkspaces } from "./slack-workspaces.js";
import { openSlackThread } from "./slack-thread.js";
import { decorateAvatar, loadIcons, slackMs, workspaceColor } from "./slack-view.js";
import { show } from "./view.js";

// The workspaces (`slack_load`), or null until read.
let workspaces: Workspace[] | null = null;
// The user's own icon per workspace (`slack_icons`).
const ownIcons = new Map<string, string | null>();
// The last list that was read, and the error of the last read when it failed.
let timeline: Timeline | null = null;
let loadError: string | null = null;
// Only the latest read may draw; a read is on its way; when the last one started or ended.
let loadSeq = 0;
let loading = false;
let lastTry = 0;
// What the list and the notice show now; they are drawn again only when this changes.
let feedKey = "";
let noticeKey = "";
// Where the list was scrolled to (it is hidden while a thread or another screen is shown, which forgets the position).
let listScroll = 0;

const feed = () => $("slack-feed");

const openSettings = () => setScreen("settings", "slack");

// What the last read found about a workspace, for its popup in the tray.
function statusOf(w: Workspace): { status: [string, string]; lines: string[] } {
  if (timeline === null) return { status: ["off", "確認中"], lines: loadError ? [loadError] : [] };
  const failed = timeline.failed.find((f) => f.teamId === w.teamId);
  if (failed) return { status: ["warn", "読み込み失敗"], lines: [failed.error] };
  const missing = timeline.missing.find((m) => m.teamId === w.teamId);
  if (missing) return { status: ["warn", "権限が不足"], lines: [`${missing.scopes.join("、")} の権限がありません`] };
  return { status: ["ok", "接続済み"], lines: [] };
}

function drawTray() {
  renderWorkspaceTray(
    (workspaces ?? []).map((w) => ({ teamId: w.teamId, team: w.team, user: w.user, iconUrl: ownIcons.get(w.teamId) ?? null, ...statusOf(w) })),
  );
}

// The notice above the list: a workspace that could not be read, and a token that lacks scopes. Rows that could be read still show.
function drawNotice() {
  const lines: string[] = [];
  for (const f of timeline?.failed ?? []) lines.push(`${f.team} を読み込めませんでした: ${f.error}`);
  for (const m of timeline?.missing ?? []) lines.push(`${m.team}: ${m.scopes.join("、")} の権限がありません`);
  const key = JSON.stringify(lines);
  if (key === noticeKey) return;
  noticeKey = key;
  $("slack-notice").replaceChildren(
    ...lines.map((text) => {
      const row = tag("div", "", text);
      const open = tag("button", "text-btn", "設定を開く");
      open.onclick = openSettings;
      row.append(open);
      return row;
    }),
  );
}

function rowOf(m: TimelineMessage, key: string) {
  const row = tag("button", "feed-row");
  row.type = "button";
  row.dataset.key = key;
  const avatar = tag("span", "avatar feed-avatar");
  decorateAvatar(avatar, m.name, m.iconUrl);
  const dot = tag("i", "feed-ws");
  dot.style.background = workspaceColor(m.team);
  dot.title = m.team;
  avatar.append(dot);
  const meta = tag("span", "feed-meta");
  meta.append(tag("b", "", m.name), tag("span", "", `#${m.channelName}`));
  const main = tag("span", "feed-main");
  main.append(meta, tag("span", "feed-text", m.text.trim() || (m.hasFiles ? "（添付ファイル）" : "")));
  if (m.replyCount > 0) main.append(tag("span", "feed-replies", `返信 ${m.replyCount} 件`));
  row.append(avatar, main, tag("span", "feed-date", formatDate(slackMs(m.ts))));
  row.onclick = () => {
    listScroll = feed().scrollTop;
    openSlackThread(m);
  };
  return row;
}

// The state of the list when there are no rows: loading, no workspace, a failed read, or nothing to show.
function emptyNode() {
  if (workspaces === null || (timeline === null && loadError === null)) {
    const row = tag("div", "pending");
    row.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    return row;
  }
  if (workspaces.length === 0 && loadError === null) {
    const box = tag("div", "feed-empty", "Slack のワークスペースが接続されていません");
    const open = tag("button", "text-btn", "設定を開く");
    open.onclick = openSettings;
    box.append(open);
    return box;
  }
  if (timeline === null) {
    const row = tag("div", "pending fail");
    const retry = tag("button", "text-btn", "再読み込み");
    retry.onclick = () => load();
    row.append(tag("span", "sp", `読み込めませんでした: ${loadError}`), retry);
    return row;
  }
  return tag("div", "feed-empty", "メッセージはありません");
}

// Draws the rows where they are: the scroll position and the focused row stay, and nothing is drawn when nothing changed.
function drawFeed() {
  const messages = timeline?.messages ?? [];
  const key = JSON.stringify([messages, loadError, workspaces?.length ?? null, timeline === null, new Date().toDateString()]);
  if (key === feedKey) return;
  feedKey = key;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  box.replaceChildren(...(messages.length ? messages.map((m) => rowOf(m, `${m.teamId}/${m.channel}/${m.ts}`)) : [emptyNode()]));
  box.scrollTop = top;
  if (focused) box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  loadIcons(messages.map((m) => m.iconUrl));
}

function draw() {
  drawNotice();
  drawFeed();
}

async function load() {
  const seq = ++loadSeq;
  loading = true;
  lastTry = Date.now();
  let next: Timeline | null = null;
  let error = "";
  try {
    next = await invoke("slack_timeline");
  } catch (e) {
    error = String(e);
  }
  if (seq !== loadSeq) return;
  loading = false;
  lastTry = Date.now();
  // A failed read keeps the list that was read before.
  if (next) {
    timeline = next;
    loadError = null;
  } else {
    loadError = error;
  }
  drawTray();
  draw();
}

// The list is shown again where it was (back from a thread).
export function revealSlackList() {
  show("slack-list");
  feedKey = "";
  draw();
  feed().scrollTop = listScroll;
}

// The Slack screen is shown: the workspaces and the user's icons are read, then the messages. What was read before stays on screen meanwhile.
export async function showSlackList() {
  revealSlackList();
  try {
    workspaces = (await invoke("slack_load")).workspaces;
    setSlackWorkspaces(workspaces);
  } catch (e) {
    workspaces = [];
    loadError = String(e);
  }
  drawTray();
  draw();
  if (!workspaces.length) return;
  invoke("slack_icons").then(
    (list) => {
      ownIcons.clear();
      for (const i of list) ownIcons.set(i.teamId, i.iconUrl);
      drawTray();
      loadIcons(list.map((i) => i.iconUrl));
    },
    () => {},
  );
  await load();
}

// Reads again when the list has been shown for as long as the server asked for, while the Slack screen is up and the window is visible.
function refresh() {
  if (currentScreen() !== "slack" || document.hidden || loading || !workspaces?.length) return;
  if (Date.now() - lastTry >= (timeline?.refreshSecs ?? 120) * 1000) load();
}

export function initSlackList() {
  setInterval(refresh, 1000);
  document.addEventListener("visibilitychange", refresh);
  feed().addEventListener("scroll", () => {
    if (!$("slack-list").hidden) listScroll = feed().scrollTop;
  });
}
