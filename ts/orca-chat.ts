// The history of the selected Orca session (A-7), in the work pane of the Orca screen: the user's messages, the agent's answers, and the tool runs folded into one line each.
// Rust reads the session and sends events through a channel (`orca_chat_open`): `items` replace the timeline from an index, `status` says how the read goes. One session is open at a time, and an event of a channel that is no longer the current one is ignored.
// Nothing is kept after the session is closed except what the screen draws.
import type { OrcaChatEvent } from "./bindings/OrcaChatEvent";
import type { OrcaChatItem } from "./bindings/OrcaChatItem";
import type { OrcaChatState } from "./bindings/OrcaChatState";
import { $, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { markdownHtml } from "./todo-data.js";

// The scroll box stays at the bottom when it was this close to it before something changed.
const BOTTOM_PX = 40;
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

interface Channel {
  onmessage: (event: OrcaChatEvent) => void;
}

// The channel of the session open now, null when none is.
let current: Channel | null = null;
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

const box = () => $("orca-chat");
const list = () => $("orca-items");

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

function itemNode(item: OrcaChatItem) {
  const node = item.kind === "user" ? tag("div", "orca-user", item.text) : item.kind === "assistant" ? markdownNode(item.text) : toolsNode(item);
  node.dataset.id = item.id;
  return node;
}

function drawStatus() {
  const note = $("orca-chat-status");
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
  $("orca-older").hidden = !more;
  if (bottom) {
    scroll.scrollTop = scroll.scrollHeight;
  } else if (anchor?.id) {
    const kept = [...list().children].find((c) => (c as HTMLElement).dataset.id === anchor.id);
    if (kept) scroll.scrollTop += kept.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
  }
  atOpen = false;
}

// Starts reading the session of the pane `paneKey` in the worktree `path`; what was drawn goes.
export function openChat(environment: string | null, path: string, paneKey: string) {
  const channel: Channel = new window.__TAURI__.core.Channel<OrcaChatEvent>();
  current = channel;
  items = [];
  state = "connecting";
  message = "";
  atOpen = true;
  opened.clear();
  list().replaceChildren();
  $("orca-older").hidden = true;
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
  invoke("orca_chat_open", { environment, path, paneKey, channel }).catch((e) => {
    if (current !== channel) return;
    state = "unavailable";
    message = String(e);
    drawStatus();
  });
}

export function closeChat() {
  if (current === null) return;
  current = null;
  items = [];
  list().replaceChildren();
  $("orca-older").hidden = true;
  $("orca-chat-status").replaceChildren();
  invoke("orca_chat_close").catch(() => {});
}

// Whether the selected row's agent is working. A run that is still going names what it runs only then.
export function setChatWorking(now: boolean) {
  if (now === working) return;
  working = now;
  items.forEach((item, i) => {
    if (item.kind === "tools") list().children[i]?.querySelector(".orca-tools-label")?.replaceChildren(labelOf(item));
  });
}

export function initOrcaChat() {
  $("orca-older").onclick = () => {
    invoke("orca_chat_older").catch(() => {});
  };
}
