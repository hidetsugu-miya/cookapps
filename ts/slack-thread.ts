// The Slack thread (S-6, S-7, S-11, S-22): the messages of a thread with their senders' icons, attached images, blocks and attachments (slack-blocks.ts), reactions, a rich field to reply in (slack-editor.ts), a card to make a Todo from the message,
// and a conversation with Claude (claude-chat.ts) to ask about the thread and the reply: proofread it, summarise the thread, write a reply. Nothing leaves the app until the reply is posted; Claude is asked only when the user sends a request,
// and then it gets the reply field's text, the conversation, the request and the messages of the thread as shown.
// The thread is read when it is opened and after a reply, not on a timer. The reply and the conversation are kept per thread in memory until the app quits.
import type { SlackThread } from "./bindings/SlackThread";
import type { ThreadFile } from "./bindings/ThreadFile";
import type { ThreadMessage } from "./bindings/ThreadMessage";
import type { TimelineMessage } from "./bindings/TimelineMessage";
import { createChat, type Turn } from "./claude-chat.js";
import { getClaude, showModelSlot } from "./claude.js";
import { createComposer } from "./composer.js";
import { $, tag } from "./dom.js";
import { formatDetailDate, hostOf } from "./format.js";
import { FILE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { closeMenu } from "./menu.js";
import { attachmentNode, blocksNode } from "./slack-blocks.js";
import { createSlackEditor } from "./slack-editor.js";
import { richNodes } from "./slack-rich.js";
import { revealSlackList, seeThread } from "./slack-list.js";
import { decorateAvatar, loadIcons, reactionsNode, slackMs } from "./slack-view.js";
import { initSplit } from "./split.js";
import { toast } from "./toast.js";
import { HandoffPane } from "./orca-handoff.js";
import { slackCard } from "./orca-handoff-cards.js";
import { projectOf } from "./todo-data.js";
import { reviewCard } from "./todo-add.js";
import { ensureTodoData } from "./todo.js";
import { copyText, show } from "./view.js";

// The thread shown now. `ts` is the thread's own timestamp (a reply opens its thread's).
interface Open {
  key: string;
  teamId: string;
  channel: string;
  channelName: string;
  ts: string;
  permalink: string;
}
let current: Open | null = null;
// Whether `open` is the thread shown now: reopening the same thread makes a new object with the same key.
const isOpen = (open: Open) => current?.key === open.key;
// The right pane is the conversation with Claude (S-7) or the handoff to Orca (A-9), by tab; Claude is the first and the one selected at first.
let assistant: "claude" | "orca" = "claude";
let handoff: HandoffPane;

// The thread as last read for `current`, and why the last read failed (null when it did not).
let thread: SlackThread | null = null;
let readError: string | null = null;
// Only the latest read may draw.
let readSeq = 0;
// The messages stay at the newest one while the user has not scrolled up from the bottom: within BOTTOM_PX of it counts as the bottom.
// `lastTop` is the scroll position last seen or set, so that an upward move (the user's) can be told from the box shrinking.
const BOTTOM_PX = 40;
let stick = true;
let lastTop = 0;
// Going to the end did not take effect because the pane was hidden (its height is 0 then): the thread opens at the end when it is shown again.
let endPending = false;

// What is being written in a thread (the Markdown of the rich field, blank kept as "") and the conversation about it, by thread.
interface Draft {
  text: string;
  turns: Turn[];
}
const drafts = new Map<string, Draft>();

// The reply is on its way.
let posting = false;
// "Todo にする" is waiting for the summary; Todoist has a token (read when a thread is opened).
let summarizing = false;
let todoConnected = false;
// The attached images of the open thread as data: URIs, by their thumbnail URL.
const thumbs = new Map<string, string>();
// The thumbnail URLs asked for and not answered yet, so that a second read of the thread does not ask again.
const inFlight = new Set<string>();
// The images of blocks and attachments (S-11): the timestamps of the messages whose "画像を表示" was pressed, and the fetched images (data: URIs) by address.
// Both are kept while the same thread is open again and read again, and forgotten when another thread is opened.
const imagesShown = new Set<string>();
const blockImages = new Map<string, string>();
// `fetch_images` takes at most 50 URLs.
const FETCH_BATCH = 50;

// The thread whose text the rich field holds now (null: none, the field is empty).
let shownKey: string | null = null;
const draft = () => (current ? drafts.get(current.key) : undefined);
const hasText = () => !!draft()?.text.trim();
// True while the field holds an edit that the draft has not taken yet: typing only marks it, and the Markdown is taken (`syncDraft`) when it is needed (a read of the text for Claude, a switch of thread, a reply).
let dirty = false;
let staleTimer = 0;
// How long after the last key the pane of Claude is told that the text changed (its old proposals can no longer be applied).
const STALE_DELAY = 150;

// Takes the field's Markdown into the draft of the thread whose text it holds.
function syncDraft() {
  if (!dirty) return;
  dirty = false;
  const d = shownKey ? drafts.get(shownKey) : undefined;
  if (d && editor.ready()) d.text = editor.blank() ? "" : editor.markdown();
}

const chat = createChat({
  prefix: "reply",
  loginNote: "設定の Claude タブで接続すると、Claude に相談できます",
  // The reply field's text, which may be blank: Claude can write a reply from the thread. There is none to ask about while no thread is open.
  text: () => {
    syncDraft();
    return draft()?.text ?? null;
  },
  apply: (text) => {
    draft()!.text = text;
    editor.set(text);
    dirty = false;
    refreshSlackThread();
  },
  // The thread goes as the screen shows it (the sender's name, the time and the text), and whether its read stopped short; while it is not read, none goes.
  ask: (text, history, instruction) =>
    invoke("claude_chat_thread", { text, thread: (thread?.messages ?? []).map(({ name, ts, text }) => ({ name, ts, text })), truncated: thread?.truncated ?? false, history, instruction }),
  changed: refreshSlackThread,
  locked: () => posting,
  copy: (text) => void copyText(text, "コピーしました"),
  keyHint: false,
});

const editor = createSlackEditor({
  prefix: "st",
  label: "スレッドに返信",
  sendLabel: "返信",
  onChange: () => {
    if (!draft()) return;
    dirty = true;
    $("st-error").hidden = true;
    editor.setSendDisabled(posting || editor.blank());
    clearTimeout(staleTimer);
    staleTimer = window.setTimeout(refreshSlackThread, STALE_DELAY);
  },
  onSubmit: () => reply(),
});

// Draws what follows from the state: the field and the arrow, whether Claude can be asked, and whether a Todo can be made.
// The field is put right only when another thread's text is in it, or after a reply emptied the draft; typing never rewrites it.
export function refreshSlackThread() {
  syncDraft();
  const text = draft()?.text ?? "";
  const key = current?.key ?? null;
  if (editor.ready() && (shownKey !== key || (!text && !editor.blank()))) {
    editor.set(text);
    shownKey = key;
  }
  editor.setBusy(posting);
  editor.setSendDisabled(posting || !hasText());
  chat.refresh();
  $("st-todo").hidden = !(getClaude()?.state === "ready" && todoConnected);
  $<HTMLButtonElement>("st-todo").disabled = summarizing;
}

// A line above the reply field: the result of an action (`fail` for a failed one). Nothing: it goes.
function note(text: string | null, fail = false) {
  const node = $("st-note");
  node.hidden = text === null;
  node.className = fail ? "pending fail" : "st-note";
  node.textContent = text;
}

function closeCard() {
  closeMenu();
  $("st-card").replaceChildren();
}

function showReplyError(e: unknown) {
  $("st-error").textContent = `返信できませんでした: ${e}`;
  $("st-error").hidden = false;
}

const secure = (url: string | null) => (url?.startsWith("https://") ? url : null);

// A file as a chip with its name; a link to the file in Slack when it has one.
function chipOf(name: string, href: string | null) {
  const chip = tag(href ? "a" : "span", "st-file");
  if (href) (chip as HTMLAnchorElement).href = href;
  chip.insertAdjacentHTML("beforeend", FILE_SVG);
  chip.append(name);
  return chip;
}

function fileNode(f: ThreadFile) {
  const href = secure(f.permalink);
  if (!f.thumbUrl) return chipOf(f.name, href);
  // A placeholder until `slack_file_images` answers; then the thumbnail, or the chip when it cannot be had.
  const box = tag(href ? "a" : "div", "st-thumb loading");
  if (href) (box as HTMLAnchorElement).href = href;
  box.dataset.thumb = f.thumbUrl;
  box.dataset.name = f.name;
  if (href) box.dataset.href = href;
  box.append(tag("span", "spin"));
  return box;
}

// "画像を表示" of a message: Rust fetches its images (no token, public https hosts only) when this is pressed, and the message is drawn again with them.
// A call that fails keeps the button; images Rust could not fetch are drawn as their descriptions.
async function showImages(m: ThreadMessage, button: HTMLButtonElement) {
  const key = current?.key;
  button.disabled = true;
  try {
    const urls = m.imageUrls.filter((u) => !blockImages.has(u));
    for (let i = 0; i < urls.length; i += FETCH_BATCH) {
      const got = await invoke("fetch_images", { urls: urls.slice(i, i + FETCH_BATCH) });
      if (current?.key !== key) return;
      for (const [url, uri] of Object.entries(got)) blockImages.set(url, uri);
    }
  } catch (e) {
    if (current?.key === key) {
      button.disabled = false;
      toast(`画像を取得できませんでした: ${e}`);
    }
    return;
  }
  imagesShown.add(m.ts);
  // Only the row of this message is made again, so the others and the scroll position stay as they are (the whole thread is drawn again when the row is not there).
  const row = [...$("st-msgs").children].find((el) => (el as HTMLElement).dataset.ts === m.ts);
  const latest = thread?.messages.find((x) => x.ts === m.ts);
  if (!row || !thread || !latest) return drawMessages("keep");
  row.replaceWith(messageNode(latest));
  loadIcons([latest.iconUrl]);
  loadThumbs(thread, current!.key);
  follow();
}

function imagesBar(m: ThreadMessage) {
  const bar = tag("div", "st-images");
  const button = tag("button", "text-btn", "画像を表示");
  button.onclick = () => showImages(m, button);
  bar.append(button);
  return bar;
}

function messageNode(m: ThreadMessage) {
  const row = tag("div", "st-msg");
  const avatar = tag("div", "avatar st-avatar");
  decorateAvatar(avatar, m.name, m.iconUrl);
  const meta = tag("div", "st-meta");
  meta.append(tag("b", "", m.name), tag("time", "", formatDetailDate(slackMs(m.ts))));
  const body = tag("div");
  body.append(meta);
  const images = { shown: imagesShown.has(m.ts), uris: blockImages };
  if (m.blocks.length) body.append(blocksNode(m.blocks, images));
  // Rust says whether the text is drawn too: with no blocks, and beside a block that could not be drawn (the text is otherwise Slack's alternative text).
  if (m.showText) body.append(...richNodes(m.rich));
  body.append(...m.attachments.map((a) => attachmentNode(a, images)));
  if (m.imageUrls.length && !images.shown) body.append(imagesBar(m));
  if (m.files.length) {
    const files = tag("div", "st-files");
    files.append(...m.files.map(fileNode));
    body.append(files);
  }
  const reactions = reactionsNode(m.reactions);
  if (reactions) body.append(reactions);
  row.dataset.ts = m.ts;
  row.append(avatar, body);
  return row;
}

// Settles the placeholders: the thumbnail where it is here; where it is not, the chip if the fetch is over (`over`).
function settleThumbs(over: boolean) {
  for (const box of $("st-msgs").querySelectorAll<HTMLElement>("[data-thumb]")) {
    const uri = thumbs.get(box.dataset.thumb!);
    if (uri) {
      const img = tag("img", "st-img");
      img.src = uri;
      img.alt = box.dataset.name!;
      box.classList.remove("loading");
      box.replaceChildren(img);
    } else if (over) {
      box.replaceWith(chipOf(box.dataset.name!, box.dataset.href ?? null));
    } else continue;
    delete box.dataset.thumb;
  }
}

// `slack_file_images` takes at most 20 URLs.
const IMAGE_BATCH = 20;

async function loadThumbs(t: SlackThread, key: string) {
  const wanted = [...new Set(t.messages.flatMap((m) => m.files.flatMap((f) => (f.thumbUrl ? [f.thumbUrl] : []))))].filter((u) => !thumbs.has(u));
  settleThumbs(wanted.length === 0);
  const urls = wanted.filter((u) => !inFlight.has(u));
  for (let i = 0; i < urls.length; i += IMAGE_BATCH) {
    const batch = urls.slice(i, i + IMAGE_BATCH);
    for (const u of batch) inFlight.add(u);
    try {
      const got = await invoke("slack_file_images", { teamId: t.teamId, urls: batch });
      if (current?.key !== key) return;
      for (const [url, uri] of Object.entries(got)) thumbs.set(url, uri);
    } catch {
      // The chips stay.
    } finally {
      for (const u of batch) inFlight.delete(u);
    }
    if (current?.key !== key) return;
    settleThumbs(i + IMAGE_BATCH >= urls.length);
    follow();
  }
}

// Goes to the end of the messages while they follow it: a placeholder or an image changes the height of what is above the end.
function follow() {
  if (!stick) return;
  const box = $("st-msgs");
  box.scrollTop = box.scrollHeight;
  lastTop = box.scrollTop;
}

// Draws the messages (and the error of the last read above them). `where`: keep the scroll position, or go to the end (another thread, and after a reply).
function drawMessages(where: "keep" | "end") {
  const box = $("st-msgs");
  const top = box.scrollTop;
  const nodes: Node[] = [];
  if (readError !== null) {
    const row = tag("div", "pending fail");
    const retry = tag("button", "text-btn", "再読み込み");
    // With nothing drawn yet this is still the opening of the thread.
    retry.onclick = () => readThread(thread ? "keep" : "end");
    row.append(tag("span", "sp", `読み込めませんでした: ${readError}`), retry);
    nodes.push(row);
  }
  if (thread) {
    thread.messages.forEach((m, i) => {
      nodes.push(messageNode(m));
      if (i === 0 && thread!.messages.length > 1) nodes.push(tag("div", "st-sep", `返信 ${thread!.messages.length - 1} 件`));
    });
    // The read stopped before the end of the thread: the last message shown is not the end.
    if (thread.truncated) nodes.push(tag("div", "st-sep", "これより新しい返信は読めていません"));
  } else if (readError === null) {
    const row = tag("div", "pending");
    row.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    nodes.push(row);
  }
  box.replaceChildren(...nodes);
  if (thread) {
    loadIcons(thread.messages.map((m) => m.iconUrl));
    // The thumbnails already here replace their placeholders at once, which changes the height before the position is set.
    loadThumbs(thread, current!.key);
  }
  if (where === "end") {
    stick = true;
    endPending = !!$("slack-thread").hidden;
  }
  box.scrollTop = where === "end" ? box.scrollHeight : top;
  lastTop = box.scrollTop;
}

async function readThread(where: "keep" | "end") {
  const open = current!;
  const seq = ++readSeq;
  const redraw = thread === null || readError !== null || endPending;
  readError = null;
  // A thread that is held and showing no error looks the same now: it is drawn once, when the read ends.
  if (redraw) drawMessages(where);
  try {
    const t = await invoke("slack_thread", { teamId: open.teamId, channel: open.channel, ts: open.ts });
    if (seq !== readSeq) return;
    thread = t;
    // A thread is seen up to the newest reply read: `slack_watch_seen` for a watched one and `slack_thread_seen` for another (Rust leaves the other kind alone).
    const newest = t.messages[t.messages.length - 1];
    if (t.messages.length > 1) {
      invoke("slack_watch_seen", { teamId: open.teamId, channel: open.channel, ts: open.ts, latestTs: newest.ts }).catch(() => {});
      seeThread(open.teamId, open.channel, open.ts, newest.ts);
    }
  } catch (e) {
    if (seq !== readSeq) return;
    readError = String(e);
  }
  // The reply that was just posted shows at the end; a read that failed keeps what was read before.
  drawMessages(readError === null ? where : "keep");
  handoff.refreshCard();
}

// Whether the thread of the message is the one on screen (a new message of it gets no popup, S-17).
export function isSlackThreadShown(m: Pick<TimelineMessage, "teamId" | "channel" | "ts" | "threadTs">) {
  return !$("slack-thread").hidden && current?.key === `${m.teamId}/${m.channel}/${m.threadTs ?? m.ts}`;
}

// Opens the thread of a message of the list.
export function openSlackThread(m: TimelineMessage) {
  const ts = m.threadTs ?? m.ts;
  const key = `${m.teamId}/${m.channel}/${ts}`;
  const same = current?.key === key;
  current = { key, teamId: m.teamId, channel: m.channel, channelName: m.channelName, ts, permalink: m.permalink };
  if (!same) {
    thread = null;
    thumbs.clear();
    inFlight.clear();
    imagesShown.clear();
    blockImages.clear();
    closeCard();
    endPending = false;
  }
  note(null);
  $("st-error").hidden = true;
  $("st-channel").textContent = `#${m.channelName}`;
  $("st-team").textContent = m.team;
  const link = $("st-open");
  const href = secure(m.permalink);
  if (href) link.setAttribute("href", href);
  else link.removeAttribute("href");
  const d = drafts.get(key) ?? { text: "", turns: [] };
  drafts.set(key, d);
  // The same thread again: the pane still shows its conversation, and an answer on its way is still wanted.
  if (!same) {
    chat.use(d.turns);
    chat.clearInput();
  }
  show("slack-thread");
  showModelSlot("reply-model");
  // Reads the rich field the first time a thread is shown, and draws the text of the thread in it when it is there.
  editor.ensure().then(refreshSlackThread, (e) => {
    $("st-error").textContent = `エディターを読み込めませんでした: ${e}`;
    $("st-error").hidden = false;
  });
  const open = current;
  invoke("todoist_connected").then(
    (connected) => {
      if (!isOpen(open)) return;
      todoConnected = connected;
      refreshSlackThread();
    },
    () => {},
  );
  refreshSlackThread();
  readThread(same && thread && !endPending ? "keep" : "end");
  handoff.sync();
}

async function reply() {
  const open = current;
  syncDraft();
  const d = draft();
  if (!open || !d || posting || !d.text.trim()) return;
  $("st-error").hidden = true;
  note(null);
  posting = true;
  refreshSlackThread();
  try {
    await invoke("slack_reply", { teamId: open.teamId, channel: open.channel, threadTs: open.ts, text: d.text, markdown: true });
  } catch (e) {
    posting = false;
    refreshSlackThread();
    // The error line is on the thread; when another thread (or the list) is shown, a toast tells instead. The text is kept.
    if (isOpen(open) && !$("slack-thread").hidden) return showReplyError(e);
    return toast(`スレッドに返信できませんでした: ${e}`);
  }
  posting = false;
  dirty = false;
  d.text = "";
  if (isOpen(open) && !$("slack-thread").hidden) {
    note("スレッドに返信しました");
    readThread("end");
  } else {
    toast("スレッドに返信しました");
    // The next time it is opened it is read again.
    if (isOpen(open)) thread = null;
  }
  refreshSlackThread();
}

// "Todo にする": the message is summarised (the same as pasting its link in the Todo add field) and shown on the card above the reply field.
async function makeTodo() {
  const open = current;
  if (!open || summarizing) return;
  note(null);
  closeCard();
  summarizing = true;
  const button = $<HTMLButtonElement>("st-todo");
  const icon = button.innerHTML;
  button.classList.add("busy");
  button.replaceChildren(tag("span", "spin"));
  refreshSlackThread();
  try {
    // The card needs the projects of Todoist, which Todo screen may not have read yet.
    const [summary, ready] = await Promise.all([invoke("todoist_summarize_slack", { url: open.permalink }), ensureTodoData()]);
    if (!isOpen(open)) return;
    if (summary === null || !ready) {
      todoConnected = false;
      return note("Todoist のトークンが無いか無効です。Todo 画面でトークンを保存してください", true);
    }
    // Claude's project starts the card, when the list has it.
    const projectId = summary.projectId !== null && projectOf(summary.projectId) ? summary.projectId : null;
    const hooks = {
      remove: closeCard,
      added: (name: string | null) => {
        closeCard();
        if (name !== null) note("Todo に追加しました");
        else {
          todoConnected = false;
          note("Todoist のトークンが無いか無効です。Todo 画面でトークンを保存してください", true);
          refreshSlackThread();
        }
      },
    };
    $("st-card").replaceChildren(reviewCard({ url: open.permalink, host: hostOf(open.permalink), projectId, recommended: projectId, today: false }, summary, hooks));
  } catch (e) {
    if (isOpen(open)) note(`要約できませんでした: ${e}`, true);
  } finally {
    summarizing = false;
    button.classList.remove("busy");
    button.innerHTML = icon;
    refreshSlackThread();
  }
}

// Shows the Claude pane or the Orca pane of the right side.
function selectAssistant(tab: "claude" | "orca") {
  assistant = tab;
  for (const [id, name] of [["reply-tab-claude", "claude"], ["reply-tab-orca", "orca"]] as const) $(id).setAttribute("aria-selected", String(name === tab));
  for (const el of [$("reply-log"), $("reply-chat").querySelector<HTMLElement>(".chat-foot")!, $("reply-clear")]) el.hidden = tab === "orca";
  $("st-orca").hidden = tab !== "orca";
  $("slack-thread").classList.toggle("assist-orca", tab === "orca");
  handoff.sync();
}

export function initSlackThread() {
  $("reply-chat-note").after(createComposer({ prefix: "reply", label: "Claude への依頼" }));
  handoff = new HandoffPane({
    root: $("st-orca"),
    forced: true,
    current: () => {
      const open = current;
      return $("slack-thread").hidden || assistant !== "orca" || !open ? null : { key: `slack:${open.key}`, card: () => (thread ? slackCard(open.channelName, thread.messages) : null) };
    },
    onOpen: () => {},
  });
  for (const [id, tab] of [["reply-tab-claude", "claude"], ["reply-tab-orca", "orca"]] as const) $(id).onclick = () => selectAssistant(tab);
  $("st-back").onclick = () => {
    closeMenu();
    revealSlackList();
  };
  $("st-todo").onclick = makeTodo;
  $("st-reply").append(editor.el);
  chat.init();
  const box = $("st-msgs");
  // The user moved up from the bottom: stop following. Moving down to within BOTTOM_PX of the bottom follows again; a position cut by a redraw is not a move down.
  box.onscroll = () => {
    const moved = box.scrollTop - lastTop;
    lastTop = box.scrollTop;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_PX;
    if (moved < 0 && !near) stick = false;
    else if (moved > 0 && near) stick = true;
  };
  // `load` does not bubble: the capture listener sees every image drawn in the box, whenever it finishes (the thumbnails, and the images of blocks and attachments). An avatar has a fixed size and changes no height.
  box.addEventListener("load", (e) => {
    if (!(e.target as Element).classList.contains("av-img")) follow();
  }, true);
  initSplit($("slack-thread"), $("reply-split"));
  refreshSlackThread();
}
