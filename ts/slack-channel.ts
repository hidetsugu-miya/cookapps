// The history of a channel (S-20, S-21): the body of the Slack screen while a channel of the side menu is chosen.
// A header with the channel (# or a lock, and its name) and the workspace (muted) only, then the newest messages (`slack_channel_history`) oldest first under the day they were sent, each drawn as a row of the unread list is (slack-list.ts) with "スレッドに返信済み: …" above the text of a reply also sent to the channel, its reactions (S-22), its "N 件の返信" and its bookmark.
// Pressing a message or its replies opens the thread (slack-thread.ts), whose back button returns here at the same scroll position. Nothing here reads a channel: the read position is set from the unread list only.
// The history is read when the channel is pressed, and again when it is pressed once more; a read that fails shows the error and "再読み込み". Everything is held in memory only.
// Under the history is a field to post to the channel (S-21, `slack_channel_post`): what is written is kept per channel in memory, and a post that works empties it and reads the history again.
import type { TimelineMessage } from "./bindings/TimelineMessage";
import { $, tag } from "./dom.js";
import { formatDay } from "./format.js";
import { HASH_SVG, LOCK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { createSlackEditor } from "./slack-editor.js";
import { historyItem, watchedKeys } from "./slack-list.js";
import { openSlackThread } from "./slack-thread.js";
import { loadIcons, reactionImages, reactionsNode, slackMs } from "./slack-view.js";
import { toast } from "./toast.js";
import { show } from "./view.js";

// The channel whose history is chosen; null while a section of the list is.
interface Chosen {
  teamId: string;
  team: string;
  channel: string;
  name: string;
  private: boolean;
}
let chosen: Chosen | null = null;
// The messages last read for `chosen` (null until the first read ends) and the error of the last read that failed.
let messages: TimelineMessage[] | null = null;
let error: string | null = null;
// Only the latest read may draw.
let readSeq = 0;
// What is drawn now, so that nothing is drawn again when nothing changed; where the history was scrolled to (it is hidden while a thread is shown, which forgets the position).
let drawn = "";
let scroll = 0;

// What is written for each channel (`{teamId}/{channel}`) as the Markdown of the rich field (a blank text is not kept), and the channel whose post is on its way.
const drafts = new Map<string, string>();
let posting: string | null = null;
// The channel whose text the field holds now (null: none, the field is empty).
let shownKey: string | null = null;
// True while the field holds an edit that `drafts` has not taken yet: typing only marks it, and the Markdown is taken (`syncDraft`) when it is needed.
let dirty = false;

// Takes the field's Markdown into the draft of the channel whose text it holds (a blank text is not kept).
function syncDraft() {
  if (!dirty) return;
  dirty = false;
  if (!shownKey || !editor.ready()) return;
  if (editor.blank()) drafts.delete(shownKey);
  else drafts.set(shownKey, editor.markdown());
}

const feed = () => $("sc-feed");
const editor = createSlackEditor({
  prefix: "sc",
  label: "チャンネルに投稿",
  onChange: () => {
    const key = selectedChannel();
    if (!key) return;
    dirty = true;
    $("sc-error").hidden = true;
    editor.setSendDisabled(posting !== null || editor.blank());
  },
  onSubmit: () => post(),
});

// The chosen channel as `{teamId}/{channel}`, for the side menu.
export const selectedChannel = () => (chosen ? `${chosen.teamId}/${chosen.channel}` : null);

// The channel the Claude pane (S-24) talks about, with its messages as the history draws them, oldest first; null while the list, the watch or a thread is shown.
export function slackChannelForClaude() {
  if (!chosen || $("slack-channel").hidden) return null;
  return { teamId: chosen.teamId, channel: chosen.channel, messages: (messages ?? []).map(({ name, ts, text }) => ({ name, ts, text })) };
}

// Puts the draft Claude wrote (S-24) into the field of the chosen channel, as Markdown, after what the field already holds (a blank line between); nothing is posted and nothing is replaced.
// Nothing is done while no channel's history is shown, or while that channel's post is on its way.
export function putSlackDraft(draft: string) {
  const key = selectedChannel();
  if (!key || $("slack-channel").hidden || posting === key) return;
  syncDraft();
  const have = drafts.get(key) ?? "";
  const next = `${have ? `${have.trimEnd()}\n\n` : ""}${draft.trim()}\n`;
  if (editor.ready()) {
    editor.set(next);
    shownKey = key;
    drafts.set(key, editor.markdown());
  } else {
    drafts.set(key, next);
  }
  $("sc-error").hidden = true;
  drawReply();
}

export function closeSlackChannel() {
  chosen = null;
  messages = null;
  error = null;
  readSeq++;
  drawn = "";
}

// Draws the field and the arrow for the chosen channel: its own text, off while its post is on its way, and the arrow off while any post is (a post is never sent twice) or the text is blank.
// The field is put right only when another channel's text is in it, or after a post emptied the draft; typing never rewrites it.
function drawReply() {
  syncDraft();
  const key = selectedChannel();
  const text = (key && drafts.get(key)) || "";
  if (editor.ready() && (shownKey !== key || (!text && !editor.blank()))) {
    editor.set(text);
    shownKey = key;
  }
  editor.setBusy(posting !== null && posting === key);
  editor.setSendDisabled(posting !== null || !text);
}

// Reads the rich field the first time the channel screen is shown, and draws the text of the channel in it when it is there.
function loadReply() {
  editor.ensure().then(drawReply, (e) => {
    $("sc-error").textContent = `エディターを読み込めませんでした: ${e}`;
    $("sc-error").hidden = false;
  });
}

// Posts the chosen channel's text. A failure shows the error (a toast when the channel is no longer on screen) and keeps the text; a success empties the field and reads the history again, at its newest message.
async function post() {
  if (!chosen || posting !== null) return;
  const { teamId, channel, name } = chosen;
  const key = `${teamId}/${channel}`;
  syncDraft();
  const text = drafts.get(key) ?? "";
  if (!text.trim()) return;
  $("sc-error").hidden = true;
  posting = key;
  drawReply();
  const shown = () => selectedChannel() === key && !$("slack-channel").hidden;
  try {
    await invoke("slack_channel_post", { teamId, channel, text, markdown: true });
  } catch (e) {
    posting = null;
    drawReply();
    if (shown()) {
      $("sc-error").textContent = `投稿できませんでした: ${e}`;
      $("sc-error").hidden = false;
    } else toast(`#${name} に投稿できませんでした: ${e}`);
    return;
  }
  posting = null;
  drafts.delete(key);
  if (!shown()) toast(`#${name} に投稿しました`);
  if (selectedChannel() === key) read(true);
  drawReply();
}

// Opens a message's thread, leaving the history where it is.
function openThread(m: TimelineMessage) {
  scroll = feed().scrollTop;
  openSlackThread(m);
}

function messageNodes(rows: TimelineMessage[]) {
  const today = Date.now();
  const nodes: Node[] = [];
  let day = "";
  for (const m of rows) {
    const label = formatDay(slackMs(m.ts), today);
    if (label !== day) {
      day = label;
      const sep = tag("div", "feed-day");
      sep.append(tag("span", "", label));
      nodes.push(sep);
    }
    const item = historyItem(m, `c/${m.ts}`, openThread);
    // The reactions (S-22, S-25) sit under the text, above "N 件の返信".
    const reactions = reactionsNode(m, { teamId: m.teamId, channel: m.channel });
    item.querySelector(".feed-main > .feed-text")?.after(reactions);
    // A reply also sent to the channel says which thread it answered, above its text (#467).
    if (m.threadReply) item.querySelector(".feed-main > .feed-text")?.before(tag("div", "feed-thread-reply", m.threadReply.parent === null ? "スレッドに返信済み" : `スレッドに返信済み: ${m.threadReply.parent}`));
    nodes.push(item);
  }
  return nodes;
}

function stateNodes() {
  const nodes: Node[] = [];
  if (error !== null) {
    const row = tag("div", "pending fail");
    const retry = tag("button", "text-btn", "再読み込み");
    retry.onclick = () => read();
    row.append(tag("span", "sp", `読み込めませんでした: ${error}`), retry);
    nodes.push(row);
  }
  if (messages === null && error === null) {
    const row = tag("div", "pending");
    row.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    nodes.push(row);
  }
  return nodes;
}

// Draws the header and the messages when the history is on screen and something changed (the bookmarks follow the watched threads). `end`: go to the newest message (the first time a channel's messages are drawn).
function draw(end = false) {
  if (!chosen || $("slack-channel").hidden) return;
  const key = JSON.stringify([chosen, messages, error, watchedKeys(), new Date().toDateString()]);
  if (key === drawn && !end) return;
  drawn = key;
  $("sc-ic").innerHTML = chosen.private ? LOCK_SVG : HASH_SVG;
  $("sc-name").textContent = chosen.name;
  $("sc-team").textContent = chosen.team;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  box.replaceChildren(...stateNodes(), ...messageNodes(messages ?? []));
  box.scrollTop = end ? box.scrollHeight : top;
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
  loadIcons((messages ?? []).flatMap((m) => [m.iconUrl, ...m.repliers.map((r) => r.iconUrl)]).concat(reactionImages(messages ?? [])));
}

// Reads the history of the chosen channel (`toEnd`: and goes to its newest message). Only the latest read draws; a read that fails keeps the messages held.
async function read(toEnd = false) {
  if (!chosen) return;
  const { teamId, channel } = chosen;
  const seq = ++readSeq;
  const first = messages === null;
  error = null;
  draw();
  try {
    const got = await invoke("slack_channel_history", { teamId, channel });
    if (seq !== readSeq) return;
    messages = got;
  } catch (e) {
    if (seq !== readSeq) return;
    error = String(e);
  }
  draw((first || toEnd) && messages !== null);
}

// A channel of the side menu was pressed: its history fills the body, also when a thread is shown. The same channel again reads it once more and keeps the position.
export function openSlackChannel(teamId: string, team: string, c: { id: string; name: string; private: boolean }) {
  if (selectedChannel() !== `${teamId}/${c.id}`) {
    messages = null;
    scroll = 0;
    $("sc-error").hidden = true;
  }
  chosen = { teamId, team, channel: c.id, name: c.name, private: c.private };
  show("slack-channel");
  drawn = "";
  draw();
  drawReply();
  loadReply();
  feed().scrollTop = scroll;
  read();
}

// The history is shown again where it was (back from a thread).
export function revealSlackChannel() {
  show("slack-channel");
  drawn = "";
  draw();
  drawReply();
  feed().scrollTop = scroll;
}

// Draws what the history shows again when the lists it depends on changed (the bookmarks).
export function redrawSlackChannel() {
  draw();
}

export function initSlackChannel() {
  $("sc-reply").append(editor.el);
  feed().addEventListener("scroll", () => {
    if (!$("slack-channel").hidden) scroll = feed().scrollTop;
  });
}
