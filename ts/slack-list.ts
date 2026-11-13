// The Slack screen's list (S-5, S-8, S-13, S-14, S-15) and its side menu (S-19, slack-side.ts): the side menu's "未読メッセージ" shows the unread section and "ウォッチ" the watch section, one at a time.
// Under a fixed header, the unread section groups the unread messages (past the channel's read position in Slack; the newest 10 of each channel, Rust's choice) of the joined channels of every workspace by channel, a heading with the channel, the number of its unread messages and "既読にする",
// then the messages of the channel oldest first under the day they were sent, with the threads with unread replies among them (the watched threads follow in the watch section). A message that is read leaves the list unless its thread is watched or has unread replies.
// A message draws what the thread draws of it (slack-blocks.ts, slack-rich.ts), with no image. It opens the thread (slack-thread.ts) and sets the channel's read position to it, as does its "N 件の返信"; "既読にする" reads the channel without opening anything (S-15), a thread is watched or let go with its bookmark (S-13), and the toggle folds its unread replies (S-14).
// A channel is kept off the list from the side menu (S-9), and pressed there it shows its history instead of the list (S-20, slack-channel.ts). The watch section keeps the rows it always had.
// The workspaces' own icons and statuses go to the sidebar's tray. Everything is held in memory only.
// The list is read at startup and again every `refreshSecs` while the window is visible, on whatever screen (the Slack button's badge follows it); showing the screen reads it only when no read is on its way and the one held is older than `refreshSecs`.
// Socket Mode (S-16) makes it again from Rust's cache when an event was read, and reads it in full when a connection is made.
// A read on another screen draws nothing of the list (it is drawn when the screen is shown) and never calls `show()`.
// The unread messages an answer says `arrived` get a popup each (S-17, arrivals-slack.ts), which does what the buttons of a row do.
import type { SideWorkspace } from "./bindings/SideWorkspace";
import type { Timeline } from "./bindings/Timeline";
import type { TimelineMessage } from "./bindings/TimelineMessage";
import type { TimelineReply } from "./bindings/TimelineReply";
import type { UnreadChannel } from "./bindings/UnreadChannel";
import type { Workspace } from "./bindings/Workspace";
import { renderWorkspaceTray } from "./accounts.js";
import { MAX_CARDS } from "./arrivals.js";
import { announceSlackArrival, dismissSlackArrival, pruneSlackArrivals, slackKey } from "./arrivals-slack.js";
import { $, tag } from "./dom.js";
import { formatDate, formatDay } from "./format.js";
import { BOOKMARK_SVG, CHECK_ALL_SVG, CHEVRON_SVG, DOT_SVG, HASH_SVG, LOCK_SVG, MINUS_CIRCLE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { setScreen } from "./nav.js";
import { closeSlackChannel, openSlackChannel, redrawSlackChannel, revealSlackChannel, selectedChannel } from "./slack-channel.js";
import { drawSlackSide, type SlackSection } from "./slack-side.js";
import { attachmentNode, blocksNode } from "./slack-blocks.js";
import { richNodes } from "./slack-rich.js";
import { getSlackWorkspaces, setSlackWorkspaces, slackListVersion } from "./slack-workspaces.js";
import { isSlackThreadShown, openSlackThread } from "./slack-thread.js";
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
// A connection of Socket Mode was made while a read or a save was on its way: the full read it asks for is made once they are done.
let resyncPending = false;
function runPendingResync() {
  if (!resyncPending || isLoading() || changing > 0) return;
  resyncPending = false;
  load();
}
let lastTry = 0;
// The version of `slackListVersion` the list was last made current with.
let seenVersion = 0;
// How many answers were held as the list so far; a popup carries the number of the answer it was found in (S-17).
let answers = 0;
// The unread messages among all the ones held (`unreadTotal` of the last answer, lowered at once by what the screen moves to read or hides): the Slack button's badge, which shows 20+ above this.
let unreadCount = 0;
const BADGE_CAP = 20;
// What the notice shows now; it is drawn again only when this changes.
let noticeKey = "";
// The elements the list drew, by the key of the row, the heading, the group or the separator, each with the key of what it was drawn from. Only an element whose key changed is made again.
const drawn = new Map<string, { sig: string; node: HTMLElement }>();
// The keys drawn by the pass that is on its way.
let used = new Set<string>();
// The messages whose rows that pass made new: a row kept from the last pass has had its icons asked for already, and a URL that cannot be fetched is not asked for again.
let fresh = new Set<TimelineMessage>();
// The threads whose unread replies were folded with their toggle (they start open). Kept through redraws and a return from a thread, and forgotten when the thread has no more unread replies.
const closedThreads = new Set<string>();
// Where the list was scrolled to (it is hidden while a thread or another screen is shown, which forgets the position).
let listScroll = 0;
// The section the side menu chose (S-19); it stays through redraws, a thread and other screens.
let section: SlackSection = "unread";
// The workspaces whose channels the side menu folds (`teamId`s); `slack-side.json` keeps them (read at the start, saved at each change).
const foldedTeams = new Set<string>();

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

// A row with the bookmark beside it, which watches its thread or lets it go. It is a sibling of the row: a button is not put in a button.
// A row of the watch section has `m.watch`; its bookmark is always shown. `grouped` is a row of a channel's group in the unread section (S-8), which has no date column and no channel name.
// `open` is given for a row of a channel's history (S-20): it is grouped, pressing it (or its "N 件の返信") only calls `open`, and its bookmark is on when the thread is among the watched ones.
function itemOf(m: TimelineMessage, key: string, grouped = false, open?: (m: TimelineMessage) => void) {
  const watched = open ? watchedKeys().includes(`${m.teamId}/${m.channel}/${m.threadTs ?? m.ts}`) : m.watch !== null;
  const item = tag("div", watched ? "feed-item watched" : "feed-item");
  const bookmark = tag("button", watched ? "icon-btn feed-watch on" : "icon-btn feed-watch");
  bookmark.type = "button";
  bookmark.setAttribute("aria-label", watched ? "ウォッチを外す" : "ウォッチする");
  bookmark.dataset.key = `${key}/watch`;
  bookmark.innerHTML = BOOKMARK_SVG;
  bookmark.onclick = () => (watched ? unwatchThread(m) : watchThread(m));
  item.append(rowOf(m, key, grouped, open), bookmark);
  return item;
}

// A row of a channel's history (S-20).
export const historyItem = (m: TimelineMessage, key: string, open: (m: TimelineMessage) => void) => itemOf(m, key, true, open);

// The threads that are watched, as `{teamId}/{channel}/{ts}`.
export const watchedKeys = () => (timeline?.watched ?? []).map(threadKeyOf);

function drawBadge() {
  setNavCount("nav-slack", unreadCount, "Slack", "未読", undefined, BADGE_CAP);
  drawSide();
}

// The side menu (S-19), while the Slack screen is shown (the list or a thread).
function drawSide() {
  if ($("slack-screen").hidden) return;
  drawSlackSide({ section, unread: unreadCount, channel: selectedChannel(), workspaces: timeline?.side ?? [], folded: [...foldedTeams] }, { choose: chooseSection, open: openChannel, hide: hideChannel, fold: foldWorkspace });
}

// The heading of a workspace in the side menu was pressed: fold it, or open it again.
// A press before the saved folds are read waits for them, so that the two do not mix. The saves go one after another, each with the set as it is when it is sent, so that the last press is what is kept.
function foldWorkspace(teamId: string) {
  foldsRead.then(() => {
    if (!foldedTeams.delete(teamId)) foldedTeams.add(teamId);
    drawSide();
    // A failed save leaves the fold as pressed: it only is not kept for the next start.
    foldsSaved = foldsSaved.then(() => invoke("slack_set_side_folded", { teamIds: [...foldedTeams] })).catch(showError);
  });
}
let foldsRead: Promise<void> = Promise.resolve();
let foldsSaved: Promise<unknown> = Promise.resolve();

// The folds saved by an earlier run, taken at the start. A file that cannot be read folds nothing (Rust answers an empty list).
async function loadFolded() {
  try {
    for (const teamId of await invoke("slack_side_folded")) foldedTeams.add(teamId);
  } catch {
    return;
  }
  drawSide();
}

// Takes `n` off the unread number of a channel in the side menu, for what the screen moves to read at once (the next read of the cache has the number itself).
function lowerSide(teamId: string, channel: string, n: number) {
  const held = timeline?.side.find((w) => w.teamId === teamId)?.channels.find((c) => c.id === channel);
  if (held) held.unread = Math.max(0, held.unread - n);
}

// The side menu chose a section: the list shows it, also when a thread is shown (as its back button does).
function chooseSection(next: SlackSection) {
  closeSlackChannel();
  if (next === section && !$("slack-list").hidden) return;
  if (next !== section) listScroll = 0;
  section = next;
  revealSlackList();
}

// The side menu chose a channel (S-20): its history fills the body, also when a thread is shown. The channel is read at the press, as "既読にする" of S-15 reads it, where that changes something.
function openChannel(teamId: string, team: string, c: SideWorkspace["channels"][number]) {
  openSlackChannel(teamId, team, c);
  drawSide();
  const held = timeline?.unreadChannels.find((x) => x.teamId === teamId && x.channel === c.id);
  if (held && readChanges(held)) readChannel(held);
}

// What a row's unread replies add to the badge (Rust's `share`).
const replyShare = (m: TimelineMessage) => m.unreadReplies?.share ?? 0;
const threadKeyOf = (m: TimelineMessage) => `${m.teamId}/${m.channel}/${m.ts}`;

// Takes rows that went from the list out of what is held for the badge.
function dropReplies(rows: TimelineMessage[]) {
  if (!timeline) return;
  for (const m of rows) lowerSide(m.teamId, m.channel, replyShare(m));
  unreadCount = Math.max(0, unreadCount - rows.reduce((n, m) => n + replyShare(m), 0));
}

// Takes the channel's rows out of the list held, with their share of the badge.
function dropChannel(teamId: string, channel: string) {
  if (!timeline) return;
  const gone = (m: TimelineMessage) => m.teamId === teamId && m.channel === channel;
  unreadCount = Math.max(0, unreadCount - timeline.messages.filter((m) => gone(m) && m.unread).length);
  dropReplies(timeline.messages.filter(gone));
  timeline.messages = timeline.messages.filter((m) => !gone(m));
  timeline.unreadChannels = timeline.unreadChannels.filter((c) => !(c.teamId === teamId && c.channel === channel));
  for (const w of timeline.side) if (w.teamId === teamId) w.channels = w.channels.filter((c) => c.id !== channel);
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
    runPendingResync();
  }
}

// Keeps the channel off the list, from a row (S-9) or from the side menu (S-19): its rows and its place in the side menu go at once, Rust saves it, and the notice offers to undo it.
// The list is made again from Rust's cache, which asks Slack nothing (rows that fill the place come from the messages held); on a failed save the rows and the channel come back the same way.
async function hideChannel(teamId: string, channel: string, channelName: string) {
  // The channel whose history is shown goes from the menu: the list is shown instead.
  if (selectedChannel() === `${teamId}/${channel}`) {
    const shown = !$("slack-channel").hidden;
    closeSlackChannel();
    if (shown) revealSlackList();
  }
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
  // Blocks that are only images (never fetched here) draw nothing: the plain text stands for them, else the files do.
  if (!box.textContent?.trim()) box.replaceChildren(m.text.trim() || "（添付ファイル）");
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
function rowOf(m: TimelineMessage, key: string, grouped: boolean, open?: (m: TimelineMessage) => void) {
  const row = tag("div", "feed-row");
  row.classList.toggle("unread", m.unread);
  const avatar = tag("span", "avatar feed-avatar");
  decorateAvatar(avatar, m.name, m.iconUrl);
  const meta = tag("span", "feed-meta");
  if (grouped) {
    // The heading of the group has the channel and the workspace: a row has the name and the time.
    meta.append(tag("b", "", m.name), tag("span", "", clockOf(m)));
  } else {
    const dot = tag("i", "feed-ws");
    dot.style.background = workspaceColor(m.team);
    dot.title = m.team;
    avatar.append(dot);
    meta.append(tag("b", "", m.name), tag("span", "", `#${m.channelName}`));
  }
  const main = tag("div", "feed-main");
  // A thread that was not read yet, or cannot be, has no message to show.
  const status = m.watch?.status ?? "ok";
  const note = status === "unreadable" ? "このスレッドは読めません（削除されたか、チャンネルを抜けた可能性があります）" : status === "pending" ? "読み込んでいます…" : null;
  main.append(meta, note === null ? bodyOf(m) : tag("div", "feed-text muted", note));
  if (status === "ok" && m.replyCount > 0) main.append(grouped ? threadButton(m, open) : tag("span", "feed-replies", `返信 ${m.replyCount} 件`));
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
  press.onclick = (e) => (open ? open(m) : openRow(m, e));
  row.append(press, avatar, main);
  if (!grouped) row.append(tag("span", "feed-date", formatDate(slackMs(m.ts))));
  return row;
}

// Opens the thread of a row and reads it (S-6, S-8). The second click of a double click on "既読にする" lands here when the row moved under the pointer: it opens nothing.
function openRow(m: TimelineMessage, e: MouseEvent) {
  if (e.detail > 1 && Date.now() - lastCheckAt < DOUBLE_CLICK_MS) return;
  listScroll = feed().scrollTop;
  readRow(m);
  openSlackThread(m);
  dismissSlackArrival(m);
}

// "N 件の返信" of a row of a group (S-8): it does what pressing the row does. It is one of the things that take the press (the CSS holds this).
function threadButton(m: TimelineMessage, open?: (m: TimelineMessage) => void) {
  const button = tag("button", "feed-thread-open", `${m.replyCount} 件の返信`);
  button.type = "button";
  button.onclick = (e) => (open ? open(m) : openRow(m, e));
  return button;
}

// The time of a message in a group, "9:05".
const clockOf = (m: TimelineMessage) => {
  const d = new Date(slackMs(m.ts));
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// The latest `slack_mark_read` on its way: a list made from the cache before Rust has the new position would bring the rows back unread.
let marking: Promise<unknown> = Promise.resolve();
// When "既読にする" (or the popup's check) was last pressed, and how long after it a second click of a double click can come.
let lastCheckAt = 0;
const DOUBLE_CLICK_MS = 500;

// What reading a row does, which opening it and the check of a popup (S-17) both do: the position, the new replies of a watched thread and the unread replies. The result holds the request of the position (none when nothing is sent) and ends when all three requests have.
function readRow(m: TimelineMessage) {
  const mark = markRead(m);
  const watch = m.watch ? seeWatched(m) : undefined;
  const replies = seeReplies(m);
  return { mark, done: Promise.allSettled([mark, watch, replies]) };
}

// Whether pressing the check of a popup (S-17) changes something: its position can be set (the token may write it) and it has an unread message, or it has unread replies, or it is a watched thread that was read and has new replies.
function readable(m: TimelineMessage, held = timeline) {
  if (m.unreadReplies) return true;
  if (!m.watch) return m.unread && canWrite(m.teamId, held);
  if (m.watch.newReplies > 0 || m.watch.uncounted) return true;
  return m.watch.status === "ok" && !!m.watch.unreadTo && canWrite(m.teamId, held);
}

// The check of a popup (S-17): it reads the row without opening the thread. The position of the channel is one, so the older rows of the channel are read too (as S-8 says for a press on the row).
// Rust's cache makes the list again once every request is done, whatever they answered, so that the badge and the counts are Rust's (nothing is asked of Slack). A request that fails is told, and the row comes back with the list.
async function readOne(m: TimelineMessage) {
  // No answer is used while the requests are on their way (as for S-9): one that began before could bring the row back.
  changing++;
  loadSeq++;
  lastCheckAt = Date.now();
  let failed = false;
  let otherFailed = false;
  try {
    const { mark, done } = readRow(m);
    draw();
    try {
      await mark;
    } catch {
      failed = true;
    }
    otherFailed = (await done).some((r) => r.status === "rejected");
  } finally {
    changing--;
    runPendingResync();
  }
  if (failed) showError("既読を Slack に送れませんでした");
  else if (otherFailed) showError("既読にできませんでした");
  load(true);
}

// "既読にする" of a channel (S-15): the channel's position goes to its newest unread message (all of them, also those past the 10 listed) and every thread of the channel with unread replies is seen up to its newest reply (S-14). Nothing is opened.
// The rows and the badge change at once, and once every request is done, whatever it answered, the list is made again from Rust's cache, so that the counts are Rust's. The requests go through the same guard as S-9 (the latest request only, none answered while the press is on its way).
async function readChannel(c: UnreadChannel) {
  if (!timeline) return;
  const { teamId, channel, to, threads } = { ...c };
  changing++;
  loadSeq++;
  lastCheckAt = Date.now();
  let failed = false;
  let otherFailed = false;
  try {
    const mark = to ? moveRead(teamId, channel, to) : undefined;
    const seen = threads.length ? seeChannelReplies(teamId, channel, threads) : [];
    draw();
    try {
      await mark;
    } catch {
      failed = true;
    }
    otherFailed = (await Promise.allSettled([mark, ...seen])).some((r) => r.status === "rejected");
  } finally {
    changing--;
    runPendingResync();
  }
  if (failed) showError("既読を Slack に送れませんでした");
  else if (otherFailed) showError("既読にできませんでした");
  load(true);
}

// Whether reading the channel changes something: the token of its workspace may write the position and a message is unread, or a thread of it has unread replies (S-14, which need no scope).
const readChanges = (c: UnreadChannel) => (c.to !== null && canWrite(c.teamId)) || c.threads.length > 0;

// The unread replies of the channel's threads count as read here: the rows go at once (one that is still unread itself, when the token cannot write the position, stays without them) and the badge drops by them.
function seeChannelReplies(teamId: string, channel: string, threads: UnreadChannel["threads"]) {
  if (!timeline) return [];
  const rows = timeline.messages.filter((x) => x.teamId === teamId && x.channel === channel && x.unreadReplies);
  dropReplies(rows);
  for (const x of rows) x.unreadReplies = null;
  timeline.messages = timeline.messages.filter((x) => !(x.teamId === teamId && x.channel === channel) || x.unread);
  const held = timeline.unreadChannels.find((x) => x.teamId === teamId && x.channel === channel);
  if (held) held.threads = [];
  drawBadge();
  return threads.map((t) => seeThread(teamId, channel, t.ts, t.latestTs));
}

// Opening a message sets its channel's read position to it: the row and the older ones of the channel become read at once (an unread row leaves the list, a watched one or one with unread replies stays and is no longer bold), and Slack is told.
// Nothing changes when the row is read already, or when the token cannot write the position (the next read would show it unread again). A failure is logged by Rust; the next read shows Slack's value.
function markRead(m: TimelineMessage): Promise<unknown> | undefined {
  // A watched row moves the position to the newest unread message Rust holds of its thread (its own message, or a reply also sent to the channel); another row to its own message.
  const to = m.watch ? m.watch.unreadTo : m.unread ? m.ts : null;
  if (!to) return undefined;
  const sent = moveRead(m.teamId, m.channel, to);
  if (sent) m.unread = false;
  return sent;
}

// Sets the read position of the channel to `to` at once on the screen and tells Slack (`slack_mark_read`). Nothing is sent when the token cannot write the position.
function moveRead(teamId: string, channel: string, to: string): Promise<unknown> | undefined {
  if (!timeline || !canWrite(teamId)) return undefined;
  const moves = (x: TimelineMessage) => x.unread && x.teamId === teamId && x.channel === channel && notAfter(x.ts, to);
  const movedWatched = timeline.watched.filter(moves).length;
  const moved = timeline.messages.filter(moves).length + movedWatched;
  for (const x of timeline.watched) {
    if (x.teamId !== teamId || x.channel !== channel) continue;
    if (x.watch?.unreadTo && notAfter(x.watch.unreadTo, to)) x.watch.unreadTo = null;
    if (moves(x)) x.unread = false;
  }
  timeline.messages = timeline.messages.filter((x) => !moves(x) || x.unreadReplies);
  for (const x of timeline.messages) if (moves(x)) x.unread = false;
  // The channel's own count follows: all of it when the position reaches its newest unread message (Rust's number, which also has the messages past the rows listed, and the watched rows that moved), else what moved.
  const held = timeline.unreadChannels.find((c) => c.teamId === teamId && c.channel === channel);
  let fall = moved;
  if (held) {
    if (held.to === null || notAfter(held.to, to)) {
      fall = held.messages + movedWatched;
      [held.to, held.messages] = [null, 0];
    } else held.messages = Math.max(0, held.messages - moved);
  }
  unreadCount = Math.max(0, unreadCount - fall);
  lowerSide(teamId, channel, fall);
  drawBadge();
  // A read that is on its way may answer with the old position (the rows would be unread again): once Rust has the new one, the list is made again from its cache, without waiting for the next period.
  const during = isLoading();
  const sent = invoke("slack_mark_read", { teamId, channel, ts: to });
  marking = sent.then(
    () => {
      if (during || isLoading()) load(true);
    },
    () => {},
  );
  return sent;
}

// Whether the token of a workspace cannot set the read position (`channels:write` or `groups:write` missing).
const lacksWrite = (x: { scopes: string[] }) => x.scopes.some((s) => s === "channels:write" || s === "groups:write");
const canWrite = (teamId: string, held = timeline) => !held?.missing.some((x) => x.teamId === teamId && lacksWrite(x));

// Whether the Slack timestamp `a` is not after `b`, compared as numbers (seconds, then microseconds), not as text.
function notAfter(a: string, b: string) {
  const [as = 0, am = 0] = a.split(".").map(Number);
  const [bs = 0, bm = 0] = b.split(".").map(Number);
  return as < bs || (as === bs && am <= bm);
}

// Opening a watched row clears its "新しい返信" at once; Rust moves the position the replies are counted from. A failure is ignored: the next read shows the count again.
function seeWatched(m: TimelineMessage) {
  // The row the button was drawn with may be an older copy of the one held (a read of the same content does not draw it again): clear both.
  const held = timeline?.watched.find((x) => threadKeyOf(x) === threadKeyOf(m));
  for (const x of [m, held]) {
    if (!x?.watch) continue;
    x.watch.newReplies = 0;
    x.watch.uncounted = false;
  }
  // A read that is on its way may answer with the old count: once Rust has the new position, the list is made again from its cache (as `markRead` does).
  const during = isLoading();
  const sent = invoke("slack_watch_seen", { teamId: m.teamId, channel: m.channel, ts: m.ts });
  sent.then(
    () => {
      if (during || isLoading()) load(true);
    },
    () => {},
  );
  return sent;
}

// Opening a row with unread replies: its replies count as read here, so the row goes at once (one that is still unread itself, when the token cannot write the position, stays without them) and the badge drops by them.
function seeReplies(m: TimelineMessage) {
  if (!m.unreadReplies || !timeline) return undefined;
  const latestTs = m.unreadReplies.latestTs;
  const same = (x: TimelineMessage) => threadKeyOf(x) === threadKeyOf(m);
  dropReplies(timeline.messages.filter((x) => same(x) && x.unreadReplies));
  for (const x of timeline.messages) if (same(x)) x.unreadReplies = null;
  timeline.messages = timeline.messages.filter((x) => !same(x) || x.unread);
  drawBadge();
  return seeThread(m.teamId, m.channel, m.ts, latestTs);
}

// A thread was read up to the reply `latestTs`: Rust keeps it, since Slack cannot be told (S-14), and asks Slack nothing. The list is made again from its cache when that changed something or when a read on its way may answer with the old position. A failure is ignored: the next read shows the replies again.
export function seeThread(teamId: string, channel: string, ts: string, latestTs: string) {
  const during = isLoading();
  const sent = invoke("slack_thread_seen", { teamId, channel, ts, latestTs });
  sent.then(
    async (moved) => {
      await marking;
      if (moved || during || isLoading()) load(true);
    },
    () => {},
  );
  return sent;
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
    runPendingResync();
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
  // A row of the history that is a reply also sent to the channel is the thread's: it lets the thread go (as `watchThread` watches it).
  const ts = m.threadTs ?? m.ts;
  timeline.watched = timeline.watched.filter((x) => !(x.teamId === m.teamId && x.channel === m.channel && x.ts === ts));
  draw();
  const done = await guarded(() => invoke("slack_unwatch", { teamId: m.teamId, channel: m.channel, ts }));
  if (done?.value) toast("ウォッチを外しました", { label: "元に戻す", run: () => rewatch(m, ts, done.value) });
  load(true);
}

async function rewatch(m: TimelineMessage, ts: string, seenTs: string | null) {
  await guarded(() => invoke("slack_watch", { teamId: m.teamId, channel: m.channel, ts, seenTs }));
  load(true);
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

// The messages of the unread section by channel, in the order the channels first come (the newest activity first); each channel's messages oldest first, so that the day separators go forward.
function groupsOf(messages: TimelineMessage[]) {
  const groups = new Map<string, TimelineMessage[]>();
  for (const m of messages) {
    const key = `${m.teamId}/${m.channel}`;
    const rows = groups.get(key);
    if (rows) rows.push(m);
    else groups.set(key, [m]);
  }
  return [...groups].map(([key, rows]) => ({ key, rows: rows.sort((a, b) => Number(a.ts) - Number(b.ts)) }));
}

// The heading of a channel's group: its mark (# or a lock), its name, the workspace (muted), the number of its unread messages and the button "既読にする".
// The button is drawn only where pressing it changes something: the token of the workspace may write the position and a message is unread, or a thread of the channel has unread replies (S-14, which need no scope).
// Pressing the button reads the channel's info held at that moment, so that a heading that is kept stays right.
function channelHead(first: TimelineMessage, info: UnreadChannel | undefined, priv: boolean) {
  const head = tag("div", "feed-chan");
  const mark = tag("span", "feed-chan-ic");
  mark.innerHTML = priv ? LOCK_SVG : HASH_SVG;
  const dot = tag("i", "feed-ws feed-chan-ws");
  dot.style.background = workspaceColor(first.team);
  head.append(mark, tag("b", "feed-chan-name", first.channelName), dot, tag("span", "feed-chan-team", first.team));
  if (info && info.messages > 0) head.append(tag("span", "feed-chan-count", `${info.messages} 件のメッセージ`));
  if (info && readChanges(info)) {
    const read = tag("button", "icon-btn feed-chan-read");
    read.type = "button";
    read.setAttribute("aria-label", "既読にする");
    read.innerHTML = CHECK_ALL_SVG;
    read.dataset.key = `${first.teamId}/${first.channel}/read`;
    // A double click is two clicks (the second has `detail` 2): the first removes the group, so the second must not press the button of the group that moved under the pointer.
    read.onclick = (e) => {
      if (e.detail > 1) return;
      const held = timeline?.unreadChannels.find((x) => x.teamId === first.teamId && x.channel === first.channel);
      if (held) readChannel(held);
    };
    head.append(read);
  }
  return head;
}

// The element for `key`, kept from the last pass when `sig` (what it is drawn from) is the same, else made by `build`.
function kept(key: string, sig: string, build: () => HTMLElement) {
  used.add(key);
  const held = drawn.get(key);
  if (held?.sig === sig) return held.node;
  const node = build();
  drawn.set(key, { sig, node });
  return node;
}

// Makes `nodes` the children of `parent`. A node that is in its place is not touched, so it keeps its focus.
function place(parent: HTMLElement, nodes: Node[]) {
  nodes.forEach((node, i) => {
    if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] ?? null);
  });
  while (parent.childNodes.length > nodes.length) parent.lastChild!.remove();
}

// A row of the list, made again only when the message, the fold of its replies or the day changed.
function keptItem(m: TimelineMessage, key: string, grouped: boolean, day: string) {
  const folded = !!m.unreadReplies && closedThreads.has(threadKeyOf(m));
  return kept(`i/${key}`, JSON.stringify([m, grouped, folded, day]), () => {
    fresh.add(m);
    return itemOf(m, key, grouped);
  });
}

// The nodes of the unread section: a group for each channel, its messages under the day they were sent.
function unreadNodes(messages: TimelineMessage[], privates: Set<string>, day0: string) {
  const today = Date.now();
  const infos = new Map((timeline?.unreadChannels ?? []).map((c) => [`${c.teamId}/${c.channel}`, c]));
  return groupsOf(messages).map(({ key, rows }) => {
    const first = rows[0];
    const info = infos.get(key);
    const priv = privates.has(key);
    const head = kept(`c/${key}`, JSON.stringify([first.team, first.channelName, priv, info?.messages, info?.to, info?.threads.length, canWrite(first.teamId)]), () => channelHead(first, info, priv));
    const nodes: HTMLElement[] = [head];
    let day = "";
    for (const m of rows) {
      const label = formatDay(slackMs(m.ts), today);
      if (label !== day) {
        day = label;
        nodes.push(
          kept(`d/${key}/${label}`, "", () => {
            const sep = tag("div", "feed-day");
            sep.append(tag("span", "", label));
            return sep;
          }),
        );
      }
      nodes.push(keptItem(m, threadKeyOf(m), true, day0));
    }
    const group = kept(`g/${key}`, "", () => tag("section", "feed-group"));
    place(group, nodes);
    return group;
  });
}

// The private channels of the side menu, as `{teamId}/{channel}`: the lock of a group's heading is all the unread section takes from the side menu.
const privateChannels = () => new Set((timeline?.side ?? []).flatMap((w) => w.channels.filter((c) => c.private).map((c) => `${w.teamId}/${c.id}`)));

// Draws the rows where they are: the scroll position and the focused row stay, and only the rows that changed are made again (the others stay in the page, in their new places).
function drawFeed() {
  // The side menu's section: the other one is not drawn.
  const messages = section === "unread" ? (timeline?.messages ?? []) : [];
  const watched = section === "watch" ? (timeline?.watched ?? []) : [];
  const privates = section === "unread" ? privateChannels() : new Set<string>();
  forgetClosedThreads();
  const day = new Date().toDateString();
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  used = new Set();
  fresh = new Set();
  // The key of a watched row has a prefix: the same message may be in both sections for a moment.
  const watch = watched.map((m) => keptItem(m, `w/${threadKeyOf(m)}`, false, day));
  const heading = (label: string, svg: string) => kept(`h/${label}`, "", () => sectionHeading(label, svg));
  const emptySig = JSON.stringify([workspaces?.length ?? null, loadError, timeline === null, timeline?.failed.map((f) => [f.team, f.error]) ?? []]);
  // A heading for each section that has rows.
  place(
    box,
    messages.length || watched.length
      ? [...(messages.length ? [heading("未読", DOT_SVG), ...unreadNodes(messages, privates, day)] : []), ...(watch.length ? [heading("ウォッチ", BOOKMARK_SVG), ...watch] : [])]
      : [kept("empty", emptySig, emptyNode)],
  );
  for (const key of drawn.keys()) if (!used.has(key)) drawn.delete(key);
  box.scrollTop = top;
  const target = focused ? box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`) : null;
  if (target) {
    // The bookmark beside a row is `visibility: hidden` until the pointer or the focus is in its row, and a hidden element takes no focus: show it until it loses the focus.
    const item = target.classList.contains("feed-watch") ? target.closest(".feed-item") : null;
    if (item) {
      item.classList.add("feed-keep");
      target.addEventListener("blur", () => item.classList.remove("feed-keep"), { once: true });
    }
    target.focus({ preventScroll: true });
  }
  if (fresh.size) loadIcons([...messages, ...watched].filter((m) => fresh.has(m)).flatMap((m) => [m.iconUrl, ...(m.unreadReplies?.replies ?? []).map((r) => r.iconUrl)]));
}

// A thread with no more unread replies starts open the next time it has some.
function forgetClosedThreads() {
  const shown = new Set((timeline?.messages ?? []).filter((m) => m.unreadReplies).map(threadKeyOf));
  for (const thread of closedThreads) if (!shown.has(thread)) closedThreads.delete(thread);
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
  // The popups of messages that are not unread rows any more go, whichever screen is shown.
  if (timeline) pruneSlackArrivals(() => new Set(timeline!.messages.filter((m) => m.unread).map(slackKey)), answers);
  drawSide();
  redrawSlackChannel();
  if ($("slack-list").hidden) return;
  drawPending();
  drawNotice();
  drawFeed();
}

// Shows a popup for each unread message the answer found new (S-17), the oldest first so that the newest is at the bottom. Rust gives a message in one answer only, so every answer is announced, also one that is passed over (`held` false): its popups wait for the answer that follows it.
// The buttons do what a row's do: the check reads the message (only when that changes something), the bookmark watches its thread, and the text button opens the thread, on the Slack screen, as pressing the row does.
// The icons of the newest cards (the stack holds MAX_CARDS) are fetched in one call after them.
function announceArrived(next: Timeline, held: boolean) {
  const announced: TimelineMessage[] = [];
  for (const m of [...next.arrived].reverse()) {
    if (isSlackThreadShown(m)) continue;
    announced.push(m);
    announceSlackArrival(m, held ? answers : answers + 1, {
      read: readable(m, next) ? () => readOne(m) : null,
      watch: () => watchThread(m),
      open: () => {
        closeSlackChannel();
        setScreen("slack");
        readRow(m);
        openSlackThread(m);
      },
    });
  }
  if (announced.length) loadIcons(announced.slice(-MAX_CARDS).map((m) => m.iconUrl));
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
  const passedOver = seq !== loadSeq || changing > 0;
  if (next && !passedOver) answers++;
  if (next) announceArrived(next, !passedOver);
  if (passedOver) {
    if (!cached && latestCached && changing === 0) load(true);
    runPendingResync();
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
  runPendingResync();
}

// Takes the workspaces as the new list. The last one removed takes its rows, its failure and its badge with it; a workspace added or removed makes the list held stale at once.
function adoptWorkspaces(list: Workspace[]) {
  const before = workspaces?.map((w) => w.teamId).join();
  workspaces = list;
  setSlackWorkspaces(list);
  if (!list.length) {
    pruneSlackArrivals(() => new Set(), Infinity);
    timeline = null;
    loadError = null;
    unreadCount = 0;
    drawBadge();
  }
  if (before !== undefined && before !== list.map((w) => w.teamId).join()) lastTry = 0;
}

// The list is shown again where it was (back from a thread), or the history of the channel the side menu chose (S-20).
export function revealSlackList() {
  if (selectedChannel()) return revealSlackChannel();
  show("slack-list");
  draw();
  feed().scrollTop = listScroll;
}

// The Slack screen is shown: the workspaces and the user's icons are read, then the messages. What was read before stays on screen meanwhile.
export async function showSlackList() {
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
  foldsRead = loadFolded();
  start();
  setInterval(refresh, 1000);
  document.addEventListener("visibilitychange", refresh);
  // Socket Mode (S-16), by what Rust tells. An event it read again is in its cache: the list is made again from there, with no call to Slack.
  // A connection that was made reads the list in full (what came while there was none is not sent again); when a read or a save is on its way, once it is done.
  // A change of a connection makes the list again too, so that `refreshSecs` follows it (it is longer only while every workspace is connected).
  const { listen } = window.__TAURI__.event;
  listen("slack-timeline-dirty", () => workspaces?.length && load(true));
  listen("slack-socket-resync", () => {
    if (!workspaces?.length) return;
    resyncPending = true;
    runPendingResync();
  });
  listen("slack-socket-status", () => workspaces?.length && load(true));
  feed().addEventListener("scroll", () => {
    if (!$("slack-list").hidden) listScroll = feed().scrollTop;
  });
  $("slack-hidden-open").innerHTML = MINUS_CIRCLE_SVG;
  $("slack-hidden-open").onclick = openSettings;
}
