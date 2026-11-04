// The Slack screen's list (S-5, S-8, S-13, S-14): under a fixed header, the unread messages (past the channel's read position in Slack; the first 10 of up to 20, the rest behind a button) of the joined channels of every workspace, with the threads with unread replies, newest first,
// above the watched threads. A message that is read leaves the list unless its thread is watched or has unread replies. A row draws what the thread draws of the message (slack-blocks.ts, slack-rich.ts), with no image.
// A row opens the thread (slack-thread.ts) and sets the channel's read position to it; the buttons on a row keep its channel off the list (S-9) and watch or let go of its thread (S-13), and its toggle folds its unread replies (S-14).
// The workspaces' own icons and statuses go to the sidebar's tray. Everything is held in memory only.
// The list is read at startup and again every `refreshSecs` while the window is visible, on whatever screen (the Slack button's badge follows it); showing the screen reads it only when no read is on its way and the one held is older than `refreshSecs`.
// A read on another screen draws nothing of the list (it is drawn when the screen is shown) and never calls `show()`.
import type { Timeline } from "./bindings/Timeline";
import type { TimelineMessage } from "./bindings/TimelineMessage";
import type { TimelineReply } from "./bindings/TimelineReply";
import type { Workspace } from "./bindings/Workspace";
import { renderWorkspaceTray } from "./accounts.js";
import { $, tag } from "./dom.js";
import { formatDate } from "./format.js";
import { BOOKMARK_SVG, CHEVRON_SVG, DOT_SVG, EYE_OFF_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { setScreen } from "./nav.js";
import { attachmentNode, blocksNode } from "./slack-blocks.js";
import { richNodes } from "./slack-rich.js";
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
// How many unread rows show before the button; the answer holds at most 20 (Rust).
const UNREAD_FIRST = 10;
// Whether the button showed the rest of the unread rows. It stays through redraws and a return from a thread, and goes when the screen is opened again.
let unreadOpen = false;
// The threads whose unread replies were folded with their toggle (they start open). Kept through redraws and a return from a thread, and forgotten when the thread has no more unread replies.
const closedThreads = new Set<string>();
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

// A row with the buttons beside it: the one that keeps its channel off the list, and the bookmark that watches its thread or lets it go. They are siblings of the row: a button is not put in a button.
// A row of the watch section has `m.watch`; its bookmark is always shown.
function itemOf(m: TimelineMessage, key: string) {
  const watched = m.watch !== null;
  const item = tag("div", watched ? "feed-item watched" : "feed-item");
  const hide = tag("button", "icon-btn feed-hide");
  hide.type = "button";
  hide.setAttribute("aria-label", `#${m.channelName} を一覧に出さない`);
  // The key of the row with a suffix: a redraw gives the focus back to the button too.
  hide.dataset.key = `${key}/hide`;
  hide.innerHTML = EYE_OFF_SVG;
  hide.onclick = () => hideChannel(m);
  const bookmark = tag("button", watched ? "icon-btn feed-watch on" : "icon-btn feed-watch");
  bookmark.type = "button";
  bookmark.setAttribute("aria-label", watched ? "ウォッチを外す" : "ウォッチする");
  bookmark.dataset.key = `${key}/watch`;
  bookmark.innerHTML = BOOKMARK_SVG;
  bookmark.onclick = () => (watched ? unwatchThread(m) : watchThread(m));
  item.append(rowOf(m, key), hide, bookmark);
  return item;
}

function drawBadge() {
  setNavCount("nav-slack", unreadCount, "Slack", "未読", undefined, BADGE_CAP);
}

// What a row's unread replies add to the badge: a thread that could not be counted counts 1.
const replyShare = (m: TimelineMessage) => (m.unreadReplies ? (m.unreadReplies.uncounted ? 1 : m.unreadReplies.count) : 0);
const threadKeyOf = (m: TimelineMessage) => `${m.teamId}/${m.channel}/${m.ts}`;

// Takes rows that went from the list out of what is held for the badge and for "すべて既読にする".
function dropReplies(rows: TimelineMessage[]) {
  if (!timeline) return;
  unreadCount = Math.max(0, unreadCount - rows.reduce((n, m) => n + replyShare(m), 0));
  timeline.unreadThreads = Math.max(0, timeline.unreadThreads - rows.filter((m) => m.unreadReplies).length);
}

// Takes the channel's rows out of the list held, with their share of the badge.
function dropChannel(teamId: string, channel: string) {
  if (!timeline) return;
  const gone = (m: TimelineMessage) => m.teamId === teamId && m.channel === channel;
  unreadCount = Math.max(0, unreadCount - timeline.messages.filter((m) => gone(m) && m.unread).length);
  dropReplies(timeline.messages.filter(gone));
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

// What a row and a reply under it draw. The images of blocks and attachments are never fetched in the list, and a row has no thumbnail of a file.
const NO_IMAGES = { shown: false, uris: new Map<string, string>() };
type Drawn = Pick<TimelineMessage, "text" | "rich" | "blocks" | "showText" | "attachments" | "hasFiles">;

// The body of a message as the thread draws it. Paragraphs alone are cut at two lines; blocks, attachments, a code block or a quote at about 12 lines (the CSS holds both).
function bodyOf(m: Drawn) {
  const short = !m.blocks.length && !m.attachments.length && m.rich.every((b) => b.type === "paragraph");
  const box = tag("div", short ? "feed-text" : "feed-text feed-full");
  if (short && !m.text.trim()) {
    box.textContent = m.hasFiles ? "（添付ファイル）" : "";
    return box;
  }
  if (m.blocks.length) box.append(blocksNode(m.blocks, NO_IMAGES));
  if (m.showText) box.append(...richNodes(m.rich));
  box.append(...m.attachments.map((a) => attachmentNode(a, NO_IMAGES)));
  return box;
}

function replyOf(r: TimelineReply) {
  const row = tag("div", "feed-reply");
  const avatar = tag("div", "avatar feed-reply-avatar");
  decorateAvatar(avatar, r.name, r.iconUrl);
  const meta = tag("div", "feed-reply-meta");
  meta.append(tag("b", "", r.name), tag("span", "", formatDate(slackMs(r.ts))));
  const main = tag("div", "feed-reply-main");
  main.append(meta, bodyOf(r));
  row.append(avatar, main);
  return row;
}

// The toggle of a row's unread replies, and the replies under it while it is open (they start open). Pressing it only folds them. The replies are part of the row: pressing one opens the thread.
function repliesNodes(m: TimelineMessage, key: string) {
  const unread = m.unreadReplies;
  if (!unread) return [];
  const thread = threadKeyOf(m);
  const open = !closedThreads.has(thread);
  const toggle = tag("button", "feed-thread-toggle");
  toggle.type = "button";
  toggle.dataset.key = `${key}/toggle`;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.innerHTML = CHEVRON_SVG;
  toggle.append(unread.uncounted ? "未読の返信あり" : `未読の返信 ${unread.count} 件`);
  toggle.onclick = () => {
    if (open) closedThreads.add(thread);
    else closedThreads.delete(thread);
    drawFeed();
  };
  if (!open) return [toggle];
  const box = tag("div", "feed-thread-replies");
  box.append(...unread.replies.map(replyOf));
  if (unread.uncounted || unread.replies.length < unread.count) box.append(tag("div", "feed-reply-rest", "ほかの返信はスレッドで見られます"));
  return [toggle, box];
}

// A row holds links and a toggle, so it is no button itself: one real button is stretched over it, and what is drawn above lets the press through to it (the CSS holds this), except links and the toggle.
function rowOf(m: TimelineMessage, key: string) {
  const row = tag("div", "feed-row");
  row.classList.toggle("unread", m.unread);
  const avatar = tag("span", "avatar feed-avatar");
  decorateAvatar(avatar, m.name, m.iconUrl);
  const dot = tag("i", "feed-ws");
  dot.style.background = workspaceColor(m.team);
  dot.title = m.team;
  avatar.append(dot);
  const meta = tag("span", "feed-meta");
  meta.append(tag("b", "", m.name), tag("span", "", `#${m.channelName}`));
  const main = tag("div", "feed-main");
  // A thread that was not read yet, or cannot be, has no message to show.
  const status = m.watch?.status ?? "ok";
  const note = status === "unreadable" ? "このスレッドは読めません（削除されたか、チャンネルを抜けた可能性があります）" : status === "pending" ? "読み込んでいます…" : null;
  main.append(meta, note === null ? bodyOf(m) : tag("div", "feed-text muted", note));
  if (status === "ok" && m.replyCount > 0) main.append(tag("span", "feed-replies", `返信 ${m.replyCount} 件`));
  if (m.watch && m.watch.newReplies > 0) main.append(tag("span", "feed-new", `新しい返信 ${m.watch.newReplies} 件`));
  // New replies that could not be counted (a thread longer than the page Rust reads): no number.
  else if (m.watch?.uncounted) main.append(tag("span", "feed-new", "新しい返信あり"));
  main.append(...repliesNodes(m, key));
  const press = tag("button", "feed-open");
  press.type = "button";
  press.dataset.key = key;
  press.setAttribute("aria-label", `${m.name} #${m.channelName} ${note ?? m.text.trim().slice(0, 80)}`);
  // A thread that cannot be read has nothing to open; its bookmark lets it go.
  press.disabled = status === "unreadable";
  press.onclick = () => {
    listScroll = feed().scrollTop;
    markRead(m);
    if (m.watch) seeWatched(m);
    seeReplies(m);
    openSlackThread(m);
  };
  row.append(press, avatar, main, tag("span", "feed-date", formatDate(slackMs(m.ts))));
  return row;
}

// Opening a message sets its channel's read position to it: the row and the older ones of the channel become read at once (an unread row leaves the list, a watched one or one with unread replies stays and is no longer bold), and Slack is told.
// Nothing changes when the row is read already, or when the token cannot write the position (the next read would show it unread again). A failure is logged by Rust; the next read shows Slack's value.
function markRead(m: TimelineMessage) {
  // A watched row moves the position to the newest unread message Rust holds of its thread (its own message, or a reply also sent to the channel); another row to its own message.
  const to = m.watch ? m.watch.unreadTo : m.unread ? m.ts : null;
  if (!to || !timeline) return;
  const cannotWrite = timeline.missing.some((x) => x.teamId === m.teamId && lacksWrite(x));
  if (cannotWrite) return;
  const moves = (x: TimelineMessage) => x.unread && x.teamId === m.teamId && x.channel === m.channel && notAfter(x.ts, to);
  const moved = [...timeline.messages, ...timeline.watched].filter(moves).length;
  for (const x of timeline.watched) {
    if (x.teamId !== m.teamId || x.channel !== m.channel) continue;
    if (x.watch?.unreadTo && notAfter(x.watch.unreadTo, to)) x.watch.unreadTo = null;
    if (moves(x)) x.unread = false;
  }
  timeline.messages = timeline.messages.filter((x) => !moves(x) || x.unreadReplies);
  for (const x of timeline.messages) if (moves(x)) x.unread = false;
  m.unread = false;
  unreadCount = Math.max(0, unreadCount - moved);
  drawBadge();
  // A list made from the cache before Rust has the new position (a read on its way, or the one `slack_thread_seen` starts, which ends first) would bring the rows back unread: once Rust has it, the list is made again from its cache whenever `conversations.mark` was sent, without waiting for the next period.
  invoke("slack_mark_read", { teamId: m.teamId, channel: m.channel, ts: to }).then(
    (sent) => {
      if (sent) load(true);
    },
    () => {},
  );
}

// Whether the token of a workspace cannot set the read position (`channels:write` or `groups:write` missing).
const lacksWrite = (x: { scopes: string[] }) => x.scopes.some((s) => s === "channels:write" || s === "groups:write");

// Whether the Slack timestamp `a` is not after `b`, compared as numbers (seconds, then microseconds), not as text.
function notAfter(a: string, b: string) {
  const [as = 0, am = 0] = a.split(".").map(Number);
  const [bs = 0, bm = 0] = b.split(".").map(Number);
  return as < bs || (as === bs && am <= bm);
}

// Opening a watched row clears its "新しい返信" at once; Rust moves the position the replies are counted from. A failure is ignored: the next read shows the count again.
function seeWatched(m: TimelineMessage) {
  if (m.watch) {
    m.watch.newReplies = 0;
    m.watch.uncounted = false;
  }
  // A read that is on its way may answer with the old count: once Rust has the new position, the list is made again from its cache (as `markRead` does).
  const during = isLoading();
  invoke("slack_watch_seen", { teamId: m.teamId, channel: m.channel, ts: m.ts }).then(
    () => {
      if (during || isLoading()) load(true);
    },
    () => {},
  );
}

// Opening a row with unread replies: its replies count as read here, so the row goes at once (one that is still unread itself, when the token cannot write the position, stays without them) and the badge drops by them.
function seeReplies(m: TimelineMessage) {
  if (!m.unreadReplies || !timeline) return;
  const latestTs = m.unreadReplies.latestTs;
  const same = (x: TimelineMessage) => threadKeyOf(x) === threadKeyOf(m);
  dropReplies(timeline.messages.filter((x) => same(x) && x.unreadReplies));
  for (const x of timeline.messages) if (same(x)) x.unreadReplies = null;
  timeline.messages = timeline.messages.filter((x) => !same(x) || x.unread);
  drawBadge();
  seeThread(m.teamId, m.channel, m.ts, latestTs);
}

// A thread was read up to the reply `latestTs`: Rust keeps it, since Slack cannot be told (S-14), and asks Slack nothing. The list is made again from its cache when that changed something or when a read on its way may answer with the old position. A failure is ignored: the next read shows the replies again.
export function seeThread(teamId: string, channel: string, ts: string, latestTs: string) {
  const during = isLoading();
  invoke("slack_thread_seen", { teamId, channel, ts, latestTs }).then(
    (moved) => {
      if (moved || during || isLoading()) load(true);
    },
    () => {},
  );
}

// Runs a change of the watch list. Every request before it is passed over and none is answered until it is done (as for the channels kept off the list), so that an answer that began before cannot bring a row back.
async function guarded<T>(run: () => Promise<T>): Promise<{ value: T } | null> {
  changing++;
  loadSeq++;
  try {
    return { value: await run() };
  } catch (e) {
    showError(e);
    return null;
  } finally {
    changing--;
  }
}

// Watches the thread of the row: the row (and the others of its thread) goes from the unread list to the top of the watch section at once, and Rust saves it (it reads the thread to start the count of new replies).
// The list is made again from Rust's cache; a failure shows the error and brings the rows back the same way.
async function watchThread(m: TimelineMessage) {
  if (!timeline) return;
  const ts = m.threadTs ?? m.ts;
  const same = (x: TimelineMessage) => x.teamId === m.teamId && x.channel === m.channel && (x.threadTs ?? x.ts) === ts;
  // A watched thread has no unread replies (S-14): "新しい返信" counts for it from here on.
  dropReplies(timeline.messages.filter(same));
  timeline.messages = timeline.messages.filter((x) => !same(x));
  timeline.watched = [{ ...m, ts, threadTs: null, watch: { newReplies: 0, uncounted: false, status: "ok", unreadTo: m.unread ? m.ts : null }, unreadReplies: null }, ...timeline.watched];
  drawBadge();
  draw();
  await guarded(() => invoke("slack_watch", { teamId: m.teamId, channel: m.channel, ts }));
  load(true);
}

// Lets the thread go: the row leaves the watch section at once, and the notice offers to put it back as it was (with the replies it had been seen up to).
async function unwatchThread(m: TimelineMessage) {
  if (!timeline) return;
  timeline.watched = timeline.watched.filter((x) => !(x.teamId === m.teamId && x.channel === m.channel && x.ts === m.ts));
  draw();
  const done = await guarded(() => invoke("slack_unwatch", { teamId: m.teamId, channel: m.channel, ts: m.ts }));
  if (done?.value) toast("ウォッチを外しました", { label: "元に戻す", run: () => rewatch(m, done.value) });
  load(true);
}

async function rewatch(m: TimelineMessage, seenTs: string | null) {
  await guarded(() => invoke("slack_watch", { teamId: m.teamId, channel: m.channel, ts: m.ts, seenTs }));
  load(true);
}

// Two presses move every channel's read position (Slack's cannot be moved back): the first arms the button, and leaving it or 4 seconds disarms.
let markAllTimer = 0;
function disarmMarkAll() {
  clearTimeout(markAllTimer);
  const button = $("slack-mark-all");
  button.classList.remove("confirm", "danger");
  button.textContent = "すべて既読にする";
}

// Moves the read position of every channel with an unread message to its newest unread message, and every thread with unread replies to its newest reply. The unread rows of the workspaces that can write the position go at once (the watched ones stay, no longer bold), and every row's unread replies, which need no scope;
// Rust sends it, and the list is made again from its cache, where the channels that could not be moved are unread still.
async function markAllRead() {
  const button = $("slack-mark-all");
  if (!timeline || timeline.markableChannels + timeline.unreadThreads === 0) return;
  if (!button.classList.contains("confirm")) {
    button.classList.add("confirm", "danger");
    button.textContent = "もう一度押すとすべて既読";
    markAllTimer = setTimeout(disarmMarkAll, 4000);
    return;
  }
  disarmMarkAll();
  const writes = (teamId: string) => !timeline!.missing.some((x) => x.teamId === teamId && lacksWrite(x));
  const rows = timeline.messages.filter((m) => writes(m.teamId));
  for (const m of timeline.watched) if (writes(m.teamId)) m.unread = false;
  const everyWorkspaceWrites = timeline.missing.every((x) => !lacksWrite(x));
  unreadCount = everyWorkspaceWrites ? 0 : Math.max(0, unreadCount - rows.filter((m) => m.unread).length);
  dropReplies(timeline.messages);
  for (const m of timeline.messages) m.unreadReplies = null;
  // What stays is unread still, in a workspace that cannot write the position; a row that was there only for its replies goes.
  timeline.messages = timeline.messages.filter((m) => m.unread && !writes(m.teamId));
  timeline.markableChannels = 0;
  timeline.unreadThreads = 0;
  drawBadge();
  draw();
  const done = await guarded(() => invoke("slack_mark_all_read"));
  if (done && done.value.failed > 0) showError(`${done.value.failed} チャンネルの既読を Slack に送れませんでした。次の読み込みで未読のまま表示されます`);
  load(true);
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

// The heading of a section ("未読", "ウォッチ"), as the inbox's "既読" heading looks.
function sectionHeading(label: string, svg: string) {
  const heading = tag("h2", "feed-heading");
  heading.innerHTML = svg;
  heading.append(label);
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
  // Only when every connected workspace failed; a failure of some is in the notice above the list, and the rest has no message.
  const everyFailed = timeline !== null && timeline.failed.length > 0 && timeline.failed.length >= workspaces.length;
  const failure = loadError ?? (timeline && everyFailed ? timeline.failed.map((f) => `${f.team}: ${f.error}`).join("、") : null);
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
  const watched = timeline?.watched ?? [];
  forgetClosedThreads();
  const key = JSON.stringify([messages, watched, [...closedThreads], unreadOpen, loadError, workspaces?.length ?? null, timeline === null, timeline?.failed.map((f) => [f.team, f.error]) ?? [], new Date().toDateString()]);
  if (key === feedKey) return;
  feedKey = key;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const rows = (list: TimelineMessage[], prefix = "") => list.map((m) => itemOf(m, `${prefix}${threadKeyOf(m)}`));
  const shownUnread = unreadOpen ? messages : messages.slice(0, UNREAD_FIRST);
  const more = messages.length - shownUnread.length;
  // The key of a watched row has a prefix: the same message may be in both sections for a moment.
  const unread = rows(shownUnread);
  const watch = rows(watched, "w/");
  // A heading for each section that has rows.
  box.replaceChildren(
    ...(messages.length || watched.length
      ? [...(unread.length ? [sectionHeading("未読", DOT_SVG), ...unread] : []), ...(more > 0 ? [moreButton(more)] : []), ...(watch.length ? [sectionHeading("ウォッチ", BOOKMARK_SVG), ...watch] : [])]
      : [emptyNode()]),
  );
  box.scrollTop = top;
  const target = focused ? box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`) : null;
  if (target) {
    // The buttons beside a row are `visibility: hidden` until the pointer or the focus is in its row, and a hidden element takes no focus: show them until the button loses the focus.
    const item = target.classList.contains("feed-hide") || target.classList.contains("feed-watch") ? target.closest(".feed-item") : null;
    if (item) {
      item.classList.add("feed-keep");
      target.addEventListener("blur", () => item.classList.remove("feed-keep"), { once: true });
    }
    target.focus({ preventScroll: true });
  }
  loadIcons([...shownUnread, ...watched].flatMap((m) => [m.iconUrl, ...(m.unreadReplies?.replies ?? []).map((r) => r.iconUrl)]));
}

// A thread with no more unread replies starts open the next time it has some.
function forgetClosedThreads() {
  const shown = new Set((timeline?.messages ?? []).filter((m) => m.unreadReplies).map(threadKeyOf));
  for (const thread of closedThreads) if (!shown.has(thread)) closedThreads.delete(thread);
}

// The header's "すべて既読にする" can be pressed while a channel has an unread message it may move, or a thread has unread replies.
function drawHeader() {
  const button = $<HTMLButtonElement>("slack-mark-all");
  button.disabled = !timeline || timeline.markableChannels + timeline.unreadThreads === 0;
  if (button.disabled) disarmMarkAll();
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
  drawHeader();
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
    forgetClosedThreads();
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
  // A double click is two clicks (the second has `detail` 2): it must not arm the button and confirm it at once.
  $("slack-mark-all").onclick = (e) => {
    if ((e as MouseEvent).detail > 1) return;
    markAllRead();
  };
  $("slack-mark-all").onblur = disarmMarkAll;
  $("slack-hidden-open").onclick = openSettings;
}
