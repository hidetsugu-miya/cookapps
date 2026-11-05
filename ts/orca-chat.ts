// The history of an Orca session (A-7): the user's messages (a handed-over content folded into one line, A-9), the agent's answers, and the tool runs folded into one line each.
// Rust reads the session and sends events through a channel (`orca_chat_open`): `items` replace the timeline from an index, `status` says how the read goes. One session is open at a time, and an event of a channel that is no longer the current one is ignored.
// The read has one owner at a time (A-9): the work pane of the Orca screen, or the side pane of a mail, a Slack thread or a Todo. The history is drawn into the owner's `ChatView`, and an owner closes only its own read.
// Nothing is kept after the session is closed except what the screen draws.
import type { OrcaChatEvent } from "./bindings/OrcaChatEvent";
import type { OrcaChatItem } from "./bindings/OrcaChatItem";
import type { OrcaChatState } from "./bindings/OrcaChatState";
import { tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { markdownHtml } from "./todo-data.js";

// The scroll box stays at the bottom when it was this close to it before something changed.
const BOTTOM_PX = 40;
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

interface Channel {
  onmessage: (event: OrcaChatEvent) => void;
}

// Where an owner draws the history: the scroll box, the list in it, the button for older messages and the line of status above the box.
export interface ChatView {
  box: HTMLElement;
  list: HTMLElement;
  older: HTMLElement;
  status: HTMLElement;
}

// The channel of the session open now, null when none is, and the view it draws into.
let current: Channel | null = null;
let owner: ChatView | null = null;
// What is drawn: the items (one child of the list each), and how the read goes.
let items: OrcaChatItem[] = [];
let state: OrcaChatState = "connecting";
let message = "";
// The first `items` of a session scrolls to the bottom.
let atOpen = false;
// The tool runs the user opened, by item id: they stay open when the run grows or the timeline is drawn again.
const opened = new Set<string>();
// Whether the selected row's agent is working: a run still going shows its `runningSummary` then.
let working = false;

const KIND_LABELS = { mail: "メール", slack: "Slack", todo: "Todo" } as const;
// The characters of a title the folded line shows.
const TITLE_CHARS = 12;
const box = () => owner!.box;
const list = () => owner!.list;

// Makes a view of the given elements; the older button asks for the older page only while the view owns the read.
export function makeChatView(box: HTMLElement, list: HTMLElement, older: HTMLElement, status: HTMLElement): ChatView {
  const view = { box, list, older, status };
  older.onclick = () => {
    if (owner === view) invoke("orca_chat_older").catch(() => {});
  };
  return view;
}

export const isChatOwner = (view: ChatView) => current !== null && owner === view;

const labelOf = (item: Extract<OrcaChatItem, { kind: "tools" }>) => (working && item.runningSummary ? item.runningSummary : item.summary);

// The HTML of the agent's answer, which is Markdown. A remote image is not loaded (the CSP refuses it too): its alt text takes its place.
function markdownNode(text: string) {
  const node = tag("div", "orca-assistant md");
  const parsed = document.createElement("template");
  parsed.innerHTML = markdownHtml(text);
  for (const img of parsed.content.querySelectorAll("img")) img.replaceWith(img.alt);
  node.append(parsed.content);
  return node;
}

function toolsNode(item: Extract<OrcaChatItem, { kind: "tools" }>) {
  const node = tag("div", "orca-tools");
  const button = tag("button", "orca-tools-btn");
  button.type = "button";
  const open = opened.has(item.id);
  button.setAttribute("aria-expanded", String(open));
  const chevron = tag("span", "orca-chev");
  chevron.innerHTML = CHEVRON;
  button.append(chevron, tag("span", "orca-tools-label", labelOf(item)));
  const calls = tag("div", "orca-tool-list");
  calls.hidden = !open;
  calls.append(...item.calls.map((c) => tag("div", "orca-tool-call", c.detail ? `${c.name}  ${c.detail}` : c.name)));
  button.onclick = () => {
    const now = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(now));
    calls.hidden = !now;
    if (now) opened.add(item.id);
    else opened.delete(item.id);
  };
  node.append(button, calls);
  return node;
}

// The agent's questions are never folded: the user has to read them to answer in the session.
function questionNode(item: Extract<OrcaChatItem, { kind: "question" }>) {
  const node = tag("div", "orca-question");
  for (const q of item.questions) {
    node.append(tag("div", "orca-question-text", q.text));
    if (q.options.length) {
      const options = tag("ul", "orca-question-options");
      for (const o of q.options) {
        const row = tag("li");
        row.append(tag("span", "orca-question-label", o.label));
        if (o.description) row.append(tag("span", "orca-question-desc", o.description));
        options.append(row);
      }
      node.append(options);
    }
    if (q.answer !== null) node.append(tag("div", "orca-question-answer", `回答: ${q.answer}`));
  }
  if (item.waiting) node.append(tag("div", "orca-question-waiting", "回答待ち"));
  return node;
}

const chars = (text: string) => [...text].length;

// A message that handed a content over (A-9): the instruction, then the content folded into one line that opens to its text. Everything is drawn as text.
function userNode(item: Extract<OrcaChatItem, { kind: "user" }>) {
  const ctx = item.context;
  if (!ctx) return tag("div", "orca-user", item.text);
  const node = tag("div", "orca-user");
  if (item.text) node.append(tag("div", "orca-user-text", item.text));
  const key = `ctx:${item.id}`;
  const fold = tag("div", "orca-ctx");
  const button = tag("button", "orca-ctx-btn");
  button.type = "button";
  const open = opened.has(key);
  button.setAttribute("aria-expanded", String(open));
  const chevron = tag("span", "orca-chev");
  chevron.innerHTML = CHEVRON;
  const title = [...ctx.title];
  const shortTitle = title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS).join("")}…` : ctx.title;
  button.append(chevron, tag("span", "orca-ctx-label", `${KIND_LABELS[ctx.kind]}「${shortTitle}」${chars(ctx.text)} 字`));
  const text = tag("div", "orca-ctx-text", ctx.text);
  text.hidden = !open;
  button.onclick = () => {
    const now = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(now));
    text.hidden = !now;
    if (now) opened.add(key);
    else opened.delete(key);
  };
  fold.append(button, text);
  node.append(fold);
  return node;
}

function nodeOf(item: OrcaChatItem) {
  if (item.kind === "user") return userNode(item);
  if (item.kind === "assistant") return markdownNode(item.text);
  return item.kind === "question" ? questionNode(item) : toolsNode(item);
}

function itemNode(item: OrcaChatItem) {
  const node = nodeOf(item);
  node.dataset.id = item.id;
  return node;
}

function drawStatus() {
  const note = owner!.status;
  const text = state === "connecting" ? (items.length ? "" : "読み込んでいます…") : state === "live" ? "" : message;
  if (!text) return note.replaceChildren();
  const row = tag("div", state === "unavailable" ? "pending fail" : "pending");
  if (state !== "unavailable") row.append(tag("span", "spin"));
  row.append(tag("span", "sp", text));
  note.replaceChildren(row);
}

// The child of the list that is first in view, and how far below the top of the box it is.
function anchorOf() {
  const top = box().getBoundingClientRect().top;
  for (const child of list().children) {
    const rect = child.getBoundingClientRect();
    if (rect.bottom > top) return { id: (child as HTMLElement).dataset.id, offset: rect.top - top };
  }
  return null;
}

// Replaces the timeline from `start`. At the bottom it stays at the bottom; elsewhere the message in view stays where it is (older messages arrive above it).
function applyItems(start: number, next: OrcaChatItem[], more: boolean) {
  const scroll = box();
  const bottom = atOpen || items.length === 0 || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= BOTTOM_PX;
  const anchor = bottom ? null : anchorOf();
  const at = Math.min(start, items.length);
  const children = [...list().children];
  for (const child of children.slice(at)) child.remove();
  items = [...items.slice(0, at), ...next];
  list().append(...next.map(itemNode));
  owner!.older.hidden = !more;
  if (bottom) {
    scroll.scrollTop = scroll.scrollHeight;
  } else if (anchor?.id) {
    const kept = [...list().children].find((c) => (c as HTMLElement).dataset.id === anchor.id);
    if (kept) scroll.scrollTop += kept.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
  }
  atOpen = false;
}

// Clears what a view drew.
function wipe(view: ChatView) {
  view.list.replaceChildren();
  view.older.hidden = true;
  view.status.replaceChildren();
}

// Starts reading the session of the pane `paneKey` in the worktree `path` for `view`, which becomes the owner; what the owner before drew goes. `isWorking`: whether the session's agent is working.
export function openChat(view: ChatView, environment: string | null, path: string, paneKey: string, isWorking: boolean) {
  const channel: Channel = new window.__TAURI__.core.Channel<OrcaChatEvent>();
  if (owner && owner !== view) wipe(owner);
  current = channel;
  owner = view;
  items = [];
  state = "connecting";
  message = "";
  atOpen = true;
  opened.clear();
  working = isWorking;
  wipe(view);
  drawStatus();
  channel.onmessage = (event) => {
    if (current !== channel) return;
    if (event.kind === "items") {
      applyItems(event.start, event.items, event.hasMore);
      drawStatus();
    } else {
      state = event.state;
      message = event.message;
      drawStatus();
    }
  };
  invoke("orca_chat_open", { environment, path, paneKey, channel })
    // Rust starts a session that is not paused: a session opened in a hidden window is paused once it exists.
    .then(() => {
      if (current === channel && document.hidden) sendPause();
    })
    .catch((e) => {
      if (current !== channel) return;
      state = "unavailable";
      message = String(e);
      drawStatus();
    });
}

// While the window is hidden Rust stops the periodic reads of the open session (the connection, the older pages, the open runs and the scroll stay), and reads once at once when it is shown again.
function sendPause() {
  if (current === null) return;
  invoke("orca_chat_pause", { paused: document.hidden }).catch(() => {});
}

// Ends the read, when `view` owns it: a view that lost it to another owner has nothing to close.
export function closeChat(view: ChatView) {
  if (current === null || owner !== view) return;
  current = null;
  items = [];
  wipe(view);
  owner = null;
  invoke("orca_chat_close").catch(() => {});
}

// Whether the session `view` shows is working. A run that is still going shows its running summary only then. Only the owner of the read is told.
export function setChatWorking(view: ChatView, now: boolean) {
  if (owner !== view || now === working) return;
  working = now;
  items.forEach((item, i) => {
    if (item.kind === "tools") list().children[i]?.querySelector(".orca-tools-label")?.replaceChildren(labelOf(item));
  });
}

export function initOrcaChat() {
  document.addEventListener("visibilitychange", sendPause);
}
