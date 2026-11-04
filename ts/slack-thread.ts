// The Slack thread (S-6, S-7, S-11): the messages of a thread with their senders' icons, attached images, blocks and attachments (slack-blocks.ts), a field to reply in, a card to make a Todo from the message,
// and a conversation with Claude (claude-chat.ts) that proofreads the reply. Nothing leaves the app until "返信する"; Claude is asked only when the user presses "校正する" or sends a request.
// The thread is read when it is opened and after a reply, not on a timer. The reply and the conversation are kept per thread in memory until the app quits.
import type { SlackThread } from "./bindings/SlackThread";
import type { ThreadFile } from "./bindings/ThreadFile";
import type { ThreadMessage } from "./bindings/ThreadMessage";
import type { TimelineMessage } from "./bindings/TimelineMessage";
import { createChat, type Turn } from "./claude-chat.js";
import { getClaude, showModelSlot } from "./claude.js";
import { $, composing, isMac, tag } from "./dom.js";
import { formatDetailDate, hostOf } from "./format.js";
import { FILE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { linkify } from "./mail-text.js";
import { closeMenu } from "./menu.js";
import { attachmentNode, blocksNode } from "./slack-blocks.js";
import { revealSlackList } from "./slack-list.js";
import { decorateAvatar, loadIcons, slackMs } from "./slack-view.js";
import { initSplit } from "./split.js";
import { toast } from "./toast.js";
import { projectOf } from "./todo-data.js";
import { reviewCard } from "./todo-add.js";
import { ensureTodoData } from "./todo.js";
import { show } from "./view.js";

// The thread shown now. `ts` is the thread's own timestamp (a reply opens its thread's).
interface Open {
  key: string;
  teamId: string;
  channel: string;
  ts: string;
  permalink: string;
}
let current: Open | null = null;
// Whether `open` is the thread shown now: reopening the same thread makes a new object with the same key.
const isOpen = (open: Open) => current?.key === open.key;
// The thread as last read for `current`, and why the last read failed (null when it did not).
let thread: SlackThread | null = null;
let readError: string | null = null;
// Only the latest read may draw.
let readSeq = 0;

// What is being written in a thread and the conversation about it, by thread.
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

const input = () => $<HTMLTextAreaElement>("st-input");
const draft = () => (current ? drafts.get(current.key) : undefined);
const hasText = () => !!draft()?.text.trim();

const chat = createChat({
  prefix: "reply",
  loginNote: "設定の Claude タブで接続すると、校正できます",
  // Nothing to proofread while the field is blank.
  text: () => (hasText() ? draft()!.text : null),
  apply: (text) => {
    draft()!.text = text;
    input().value = text;
    grow();
    refreshSlackThread();
  },
  ask: (text, history, instruction) => invoke("claude_proofread_reply", { text, history, instruction }),
  changed: refreshSlackThread,
  locked: () => posting,
});

// The field is three lines high and grows with its text up to six (the CSS holds the limit). A hidden field measures 0, which is left alone.
function grow() {
  const field = input();
  field.style.height = "auto";
  field.style.height = field.scrollHeight > 0 ? `${field.scrollHeight}px` : "";
}

// Draws what follows from the state: the field and the buttons, whether Claude can be asked, and whether a Todo can be made.
export function refreshSlackThread() {
  input().disabled = posting;
  $<HTMLButtonElement>("st-send").disabled = posting || !hasText();
  $<HTMLButtonElement>("reply-proofread").disabled = !chat.refresh();
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
  drawMessages("keep");
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
  const text = tag("p", "st-text");
  text.append(...linkify(m.text));
  const body = tag("div");
  body.append(meta);
  const images = { shown: imagesShown.has(m.ts), uris: blockImages };
  // Rust sends blocks only when they take the place of the text (the text is then Slack's alternative text).
  if (m.blocks.length) body.append(blocksNode(m.blocks, images));
  else if (m.text.trim()) body.append(text);
  body.append(...m.attachments.map((a) => attachmentNode(a, images)));
  if (m.imageUrls.length && !images.shown) body.append(imagesBar(m));
  if (m.files.length) {
    const files = tag("div", "st-files");
    files.append(...m.files.map(fileNode));
    body.append(files);
  }
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
  }
}

// Draws the messages (and the error of the last read above them). `where`: keep the scroll position, go to the end (after a reply), or go to the top (another thread).
function drawMessages(where: "keep" | "end" | "top") {
  const box = $("st-msgs");
  const top = box.scrollTop;
  const nodes: Node[] = [];
  if (readError !== null) {
    const row = tag("div", "pending fail");
    const retry = tag("button", "text-btn", "再読み込み");
    retry.onclick = () => readThread("keep");
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
  box.scrollTop = where === "end" ? box.scrollHeight : where === "top" ? 0 : top;
  if (thread) {
    loadIcons(thread.messages.map((m) => m.iconUrl));
    loadThumbs(thread, current!.key);
  }
}

async function readThread(where: "keep" | "end" | "top") {
  const open = current!;
  const seq = ++readSeq;
  const redraw = thread === null || readError !== null;
  readError = null;
  // A thread that is held and showing no error looks the same now: it is drawn once, when the read ends.
  if (redraw) drawMessages(where);
  try {
    const t = await invoke("slack_thread", { teamId: open.teamId, channel: open.channel, ts: open.ts });
    if (seq !== readSeq) return;
    thread = t;
  } catch (e) {
    if (seq !== readSeq) return;
    readError = String(e);
  }
  // The reply that was just posted shows at the end; a read that failed keeps what was read before.
  drawMessages(readError === null ? where : "keep");
}

// Opens the thread of a message of the list.
export function openSlackThread(m: TimelineMessage) {
  const ts = m.threadTs ?? m.ts;
  const key = `${m.teamId}/${m.channel}/${ts}`;
  const same = current?.key === key;
  current = { key, teamId: m.teamId, channel: m.channel, ts, permalink: m.permalink };
  if (!same) {
    thread = null;
    thumbs.clear();
    inFlight.clear();
    imagesShown.clear();
    blockImages.clear();
    closeCard();
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
  input().value = d.text;
  // The same thread again: the pane still shows its conversation, and an answer on its way is still wanted.
  if (!same) {
    chat.use(d.turns);
    chat.clearInput();
  }
  show("slack-thread");
  showModelSlot("reply-model");
  grow();
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
  readThread(same ? "keep" : "top");
}

async function reply() {
  const open = current;
  const d = draft();
  if (!open || !d || posting || !d.text.trim()) return;
  $("st-error").hidden = true;
  note(null);
  posting = true;
  refreshSlackThread();
  try {
    await invoke("slack_reply", { teamId: open.teamId, channel: open.channel, threadTs: open.ts, text: d.text });
  } catch (e) {
    posting = false;
    refreshSlackThread();
    // The error line is on the thread; when another thread (or the list) is shown, a toast tells instead. The text is kept.
    if (isOpen(open) && !$("slack-thread").hidden) return showReplyError(e);
    return toast(`スレッドに返信できませんでした: ${e}`);
  }
  posting = false;
  d.text = "";
  if (isOpen(open) && !$("slack-thread").hidden) {
    input().value = "";
    grow();
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

export function initSlackThread() {
  $("st-back").onclick = () => {
    closeMenu();
    revealSlackList();
  };
  $("st-todo").onclick = makeTodo;
  $("st-send").onclick = reply;
  $("st-keys").textContent = isMac ? "↩ で改行、⌘↩ で返信" : "Enter で改行、Ctrl+Enter で返信";
  input().oninput = () => {
    const d = draft();
    if (!d) return;
    d.text = input().value;
    $("st-error").hidden = true;
    grow();
    refreshSlackThread();
  };
  // Enter is a line break; Cmd+Enter (Ctrl+Enter off macOS) posts, unless it only confirms an IME conversion.
  input().onkeydown = (e) => {
    if (e.key !== "Enter" || composing(e) || !(isMac ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    reply();
  };
  $("reply-proofread").onclick = () => chat.send("校正してください");
  chat.init();
  initSplit($("slack-thread"), $("reply-split"));
  refreshSlackThread();
}
