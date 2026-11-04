// The Slack screen's list (S-5, S-8): the unread messages (past the channel's read position in Slack; the first 10 of up to 20, the rest behind a button) above the newest 5 read ones, of the joined channels of every workspace, each newest first.
// A row opens the thread (slack-thread.ts) and sets the channel's read position to it; the button on a row (S-9) keeps its channel off the list.
// The workspaces' own icons and statuses go to the sidebar's tray. Everything is held in memory only.
// The list is read at startup and again every `refreshSecs` while the window is visible, on whatever screen (the Slack button's badge follows it); showing the screen reads it only when no read is on its way and the one held is older than `refreshSecs`.
// A read on another screen draws nothing of the list (it is drawn when the screen is shown) and never calls `show()`.
import type { Timeline } from "./bindings/Timeline";
import type { TimelineMessage } from "./bindings/TimelineMessage";
import type { Workspace } from "./bindings/Workspace";
import { renderWorkspaceTray } from "./accounts.js";
import { $, tag } from "./dom.js";
import { formatDate } from "./format.js";
import { EYE_OFF_SVG, EYE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { setScreen } from "./nav.js";
import { getSlackWorkspaces, setSlackWorkspaces, slackListVersion } from "./slack-workspaces.js";
import { openSlackThread } from "./slack-thread.js";
import { decorateAvatar, loadIcons, slackMs, workspaceColor } from "./slack-view.js";
import { toast } from "./toast.js";
import { setNavCount, show, showError } from "./view.js";

// The workspaces (`slack_load`), or null until read.
let workspaces: Workspace[] | null = null;
// The user's own icon per workspace (`slack_icons`).
const ownIcons = new Map<string, string | null>();
// The last list that was read, and the error of the last read when it failed.
let timeline: Timeline | null = null;
let loadError: string | null = null;
// Only the latest read may draw; a read is on its way; when the last one started or ended.
let loadSeq = 0;
// Reads of Slack (full reads) on their way, which may be more than one when the latest passed over an older one; a read from Rust's cache is not one of them.
let fullReads = 0;
const isLoading = () => fullReads > 0;
// Whether the latest request is a read from the cache.
let latestCached = false;
// Hide / put-back requests on their way: no answer is used meanwhile, so that an answer that began before the file changed cannot bring a hidden row back.
let changing = 0;
let lastTry = 0;
// The version of `slackListVersion` the list was last made current with.
let seenVersion = 0;
// The unread messages among all the ones held (`unreadTotal` of the last answer, lowered at once by what the screen moves to read or hides): the Slack button's badge, which shows 20+ above this.
let unreadCount = 0;
const BADGE_CAP = 20;
// What the list and the notice show now; they are drawn again only when this changes.
let feedKey = "";
let noticeKey = "";
// How many unread rows show before the button, and the most read rows; the answer holds at most 20 and 5 (Rust), the read side also after rows moved to it.
const UNREAD_FIRST = 10;
const READ_SHOWN = 5;
// Whether the button showed the rest of the unread rows. It stays through redraws and a return from a thread, and goes when the screen is opened again.
let unreadOpen = false;
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
  // A read that failed while rows are held: the rows stay, and the failure shows here.
  if (timeline && loadError !== null) lines.unshift(`読み込めませんでした: ${loadError}`);
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

// A row with the button that keeps its channel off the list. The two are siblings: a button is not put in a button.
function itemOf(m: TimelineMessage, key: string) {
  const item = tag("div", "feed-item");
  const hide = tag("button", "icon-btn feed-hide");
  hide.type = "button";
  hide.setAttribute("aria-label", `#${m.channelName} を一覧に出さない`);
  // The key of the row with a suffix: a redraw gives the focus back to the button too.
  hide.dataset.key = `${key}/hide`;
  hide.innerHTML = EYE_OFF_SVG;
  hide.onclick = () => hideChannel(m);
  item.append(rowOf(m, key), hide);
  return item;
}

function drawBadge() {
  setNavCount("nav-slack", unreadCount, "Slack", "未読", undefined, BADGE_CAP);
}

// Takes the channel's rows out of the list held, with their share of the badge.
function dropChannel(teamId: string, channel: string) {
  if (!timeline) return;
  const gone = (m: TimelineMessage) => m.teamId === teamId && m.channel === channel;
  unreadCount = Math.max(0, unreadCount - timeline.messages.filter((m) => gone(m) && m.unread).length);
  timeline.messages = timeline.messages.filter((m) => !gone(m));
  drawBadge();
  draw();
}

// Saves a channel kept off the list or put back. Every request before it is passed over (`loadSeq`), and none is answered until it is done (`changing`).
async function saveHidden(command: "slack_hide_channel" | "slack_unhide_channel", teamId: string, channel: string) {
  changing++;
  loadSeq++;
  try {
    await invoke(command, { teamId, channel });
    return true;
  } catch (e) {
    showError(e);
    return false;
  } finally {
    changing--;
  }
}

// Keeps the channel off the list: its rows go at once, Rust saves it, and the notice offers to undo it.
// The list is made again from Rust's cache, which asks Slack nothing (rows that fill the place come from the messages held); on a failed save the rows come back the same way.
async function hideChannel(m: TimelineMessage) {
  const { teamId, channel, channelName } = m;
  dropChannel(teamId, channel);
  if (await saveHidden("slack_hide_channel", teamId, channel)) toast(`#${channelName} を一覧に出さないようにしました`, { label: "元に戻す", run: () => unhideChannel(teamId, channel) });
  load(true);
}

async function unhideChannel(teamId: string, channel: string) {
  await saveHidden("slack_unhide_channel", teamId, channel);
  load(true);
}

function rowOf(m: TimelineMessage, key: string) {
  const row = tag("button", "feed-row");
  row.type = "button";
  row.classList.toggle("unread", m.unread);
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
    markRead(m);
    openSlackThread(m);
  };
  return row;
}

// Opening a message sets its channel's read position to it: the row and the older ones of the channel (the list is newest first) become read at once, and Slack is told.
// Nothing changes when the row is read already, or when the token cannot write the position (the next read would show it unread again). A failure is logged by Rust; the next read shows Slack's value.
function markRead(m: TimelineMessage) {
  if (!m.unread || !timeline) return;
  const cannotWrite = timeline.missing.some((x) => x.teamId === m.teamId && x.scopes.some((s) => s === "channels:write" || s === "groups:write"));
  if (cannotWrite) return;
  let reached = false;
  let moved = 0;
  for (const x of timeline.messages) {
    if (x.teamId !== m.teamId || x.channel !== m.channel) continue;
    reached ||= x.ts === m.ts;
    if (reached && x.unread) moved++;
    if (reached) x.unread = false;
  }
  m.unread = false;
  unreadCount = Math.max(0, unreadCount - moved);
  drawBadge();
  // A read that is on its way may answer with the old position (the rows would be unread again): once Rust has the new one, the list is made again from its cache, without waiting for the next period.
  const during = isLoading();
  invoke("slack_mark_read", { teamId: m.teamId, channel: m.channel, ts: m.ts }).then(
    () => {
      if (during || isLoading()) load(true);
    },
    () => {},
  );
}

// The button after the first unread rows, which shows all the others.
function moreButton(n: number) {
  const box = tag("div", "feed-more");
  const button = tag("button", "text-btn", `未読をあと ${n} 件表示`);
  button.type = "button";
  button.onclick = () => {
    unreadOpen = true;
    drawFeed();
  };
  box.append(button);
  return box;
}

// The "既読" heading between the two sections, as the inbox has it.
function readHeading() {
  const heading = tag("h2", "feed-heading");
  heading.innerHTML = EYE_SVG;
  heading.append("既読");
  return heading;
}

// The state of the list when there are no rows: loading, no workspace, a failed read, or nothing to show.
function emptyNode() {
  const loadingRow = () => {
    const row = tag("div", "pending");
    row.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    return row;
  };
  if (workspaces === null) return loadingRow();
  // With no workspace no timeline is ever read, so this must come before the wait for the timeline.
  if (workspaces.length === 0 && loadError === null) {
    const box = tag("div", "feed-empty", "Slack のワークスペースが接続されていません");
    const open = tag("button", "text-btn", "設定を開く");
    open.onclick = openSettings;
    box.append(open);
    return box;
  }
  if (timeline === null && loadError === null) return loadingRow();
  // A read that failed with nothing to show: the error of the call, or of every workspace that could not be read.
  const failure = loadError ?? (timeline?.failed.length ? timeline.failed.map((f) => `${f.team}: ${f.error}`).join("、") : null);
  if (failure !== null) {
    const row = tag("div", "pending fail");
    const retry = tag("button", "text-btn", "再読み込み");
    retry.onclick = () => load();
    row.append(tag("span", "sp", `読み込めませんでした: ${failure}`), retry);
    return row;
  }
  return tag("div", "feed-empty", "メッセージはありません");
}

// Draws the rows where they are: the scroll position and the focused row stay, and nothing is drawn when nothing changed.
function drawFeed() {
  const messages = timeline?.messages ?? [];
  const key = JSON.stringify([messages, unreadOpen, loadError, workspaces?.length ?? null, timeline === null, timeline?.failed.map((f) => [f.team, f.error]) ?? [], new Date().toDateString()]);
  if (key === feedKey) return;
  feedKey = key;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const rows = (list: TimelineMessage[]) => list.map((m) => itemOf(m, `${m.teamId}/${m.channel}/${m.ts}`));
  const unreadAll = messages.filter((m) => m.unread);
  const shownUnread = unreadOpen ? unreadAll : unreadAll.slice(0, UNREAD_FIRST);
  const shownRead = messages.filter((m) => !m.unread).slice(0, READ_SHOWN);
  const more = unreadAll.length - shownUnread.length;
  const unread = rows(shownUnread);
  const read = rows(shownRead);
  // The heading only when both sections have rows.
  box.replaceChildren(...(messages.length ? [...unread, ...(more > 0 ? [moreButton(more)] : []), ...(unread.length && read.length ? [readHeading()] : []), ...read] : [emptyNode()]));
  box.scrollTop = top;
  const target = focused ? box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`) : null;
  if (target) {
    // The hide button is `visibility: hidden` until the pointer or the focus is in its row, and a hidden element takes no focus: show it until it loses the focus.
    const item = target.classList.contains("feed-hide") ? target.closest(".feed-item") : null;
    if (item) {
      item.classList.add("feed-keep");
      target.addEventListener("blur", () => item.classList.remove("feed-keep"), { once: true });
    }
    target.focus({ preventScroll: true });
  }
  loadIcons([...shownUnread, ...shownRead].map((m) => m.iconUrl));
}

// The muted "残り N チャンネルを読み込み中" above the notice while some channels were not reached by any read yet.
function drawPending() {
  const left = timeline?.pendingChannels ?? 0;
  const label = $("slack-pending");
  label.hidden = left === 0;
  label.textContent = left > 0 ? `残り ${left} チャンネルを読み込み中` : "";
}

// Draws the list's parts when the list is on screen; it is drawn from what is held when it is shown (`revealSlackList`).
function draw() {
  if ($("slack-list").hidden) return;
  drawPending();
  drawNotice();
  drawFeed();
}

// Reads the list. `cached` asks Rust to make it again from what it holds, with no call to Slack (after a channel was hidden or put back): it is not a read of Slack, so it does not move `lastTry`.
// Only the latest request is used. A read of Slack that is passed over by a cached one still left what it read in Rust's cache, so one cached read follows it.
async function load(cached = false) {
  const seq = ++loadSeq;
  latestCached = cached;
  if (!cached) {
    fullReads++;
    lastTry = Date.now();
  }
  let next: Timeline | null = null;
  let error = "";
  try {
    next = await invoke("slack_timeline", cached ? { cached: true } : undefined);
  } catch (e) {
    error = String(e);
  }
  if (!cached) {
    fullReads--;
    lastTry = Date.now();
  }
  if (seq !== loadSeq || changing > 0) {
    if (!cached && latestCached && changing === 0) load(true);
    return;
  }
  // A failed read keeps the list that was read before.
  if (next) {
    timeline = next;
    loadError = null;
    unreadCount = next.unreadTotal;
    drawBadge();
  } else {
    loadError = error;
  }
  drawTray();
  draw();
}

// Takes the workspaces as the new list. The last one removed takes its rows, its failure and its badge with it; a workspace added or removed makes the list held stale at once.
function adoptWorkspaces(list: Workspace[]) {
  const before = workspaces?.map((w) => w.teamId).join();
  workspaces = list;
  setSlackWorkspaces(list);
  if (!list.length) {
    timeline = null;
    loadError = null;
    unreadCount = 0;
    drawBadge();
  }
  if (before !== undefined && before !== list.map((w) => w.teamId).join()) lastTry = 0;
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
  unreadOpen = false;
  revealSlackList();
  try {
    adoptWorkspaces((await invoke("slack_load")).workspaces);
  } catch (e) {
    // The workspaces known stay: the tray and the refresh go on with them.
    workspaces ??= [];
    loadError = String(e);
  }
  drawTray();
  draw();
  if (!workspaces?.length) return;
  invoke("slack_icons").then(
    (list) => {
      ownIcons.clear();
      for (const i of list) ownIcons.set(i.teamId, i.iconUrl);
      drawTray();
      loadIcons(list.map((i) => i.iconUrl));
    },
    () => {},
  );
  // Showing the screen again does not read again while a read is on its way, or while the list held is younger than the answer asked for.
  staleIfChanged();
  if (isLoading() || changing > 0 || (timeline !== null && Date.now() - lastTry < timeline.refreshSecs * 1000)) return;
  await load();
}

// Reads again when the list held is as old as the server asked for, on any screen, while the window is visible. Workspaces that settings added or removed are taken first.
function refresh() {
  if (document.hidden || isLoading() || changing > 0) return;
  staleIfChanged();
  const shared = getSlackWorkspaces();
  if (shared && (workspaces === null || shared.map((w) => w.teamId).join() !== workspaces.map((w) => w.teamId).join())) {
    adoptWorkspaces(shared);
    drawTray();
    draw();
  }
  if (!workspaces?.length) return;
  if (Date.now() - lastTry >= (timeline?.refreshSecs ?? 120) * 1000) load();
}

// Settings put a channel back: the list is made again from Rust's cache once (no call to Slack), and the next full read brings what is not held.
function staleIfChanged() {
  if (slackListVersion() === seenVersion) return;
  seenVersion = slackListVersion();
  if (workspaces?.length) load(true);
}

// The first read, for the badge: the workspaces, then the messages when there is a workspace.
async function start() {
  try {
    adoptWorkspaces((await invoke("slack_load")).workspaces);
  } catch {
    return;
  }
  if (workspaces?.length && !isLoading()) await load();
}

export function initSlackList() {
  start();
  setInterval(refresh, 1000);
  document.addEventListener("visibilitychange", refresh);
  feed().addEventListener("scroll", () => {
    if (!$("slack-list").hidden) listScroll = feed().scrollTop;
  });
}
