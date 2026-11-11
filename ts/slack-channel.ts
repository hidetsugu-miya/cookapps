// The history of a channel (S-20): the body of the Slack screen while a channel of the side menu is chosen.
// A header with the channel (# or a lock, and its name) and the workspace (muted) only, then the newest messages (`slack_channel_history`) oldest first under the day they were sent, each drawn as a row of the unread list is (slack-list.ts) with its "N 件の返信" and its bookmark.
// Pressing a message or its replies opens the thread (slack-thread.ts), whose back button returns here at the same scroll position. Nothing here reads a channel: the read position is set from the unread list only.
// The history is read when the channel is pressed, and again when it is pressed once more; a read that fails shows the error and "再読み込み". Everything is held in memory only.
import type { TimelineMessage } from "./bindings/TimelineMessage";
import { $, tag } from "./dom.js";
import { formatDay } from "./format.js";
import { HASH_SVG, LOCK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { historyItem, watchedKeys } from "./slack-list.js";
import { openSlackThread } from "./slack-thread.js";
import { loadIcons, slackMs } from "./slack-view.js";
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

const feed = () => $("sc-feed");

// The chosen channel as `{teamId}/{channel}`, for the side menu.
export const selectedChannel = () => (chosen ? `${chosen.teamId}/${chosen.channel}` : null);

export function closeSlackChannel() {
  chosen = null;
  messages = null;
  error = null;
  readSeq++;
  drawn = "";
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
    nodes.push(historyItem(m, `c/${m.ts}`, openThread));
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
  loadIcons((messages ?? []).map((m) => m.iconUrl));
}

// Reads the history of the chosen channel. Only the latest read draws; a read that fails keeps the messages held.
async function read() {
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
  draw(first && messages !== null);
}

// A channel of the side menu was pressed: its history fills the body, also when a thread is shown. The same channel again reads it once more and keeps the position.
export function openSlackChannel(teamId: string, team: string, c: { id: string; name: string; private: boolean }) {
  if (selectedChannel() !== `${teamId}/${c.id}`) {
    messages = null;
    scroll = 0;
  }
  chosen = { teamId, team, channel: c.id, name: c.name, private: c.private };
  show("slack-channel");
  drawn = "";
  draw();
  feed().scrollTop = scroll;
  read();
}

// The history is shown again where it was (back from a thread).
export function revealSlackChannel() {
  show("slack-channel");
  drawn = "";
  draw();
  feed().scrollTop = scroll;
}

// Draws what the history shows again when the lists it depends on changed (the bookmarks).
export function redrawSlackChannel() {
  draw();
}

export function initSlackChannel() {
  feed().addEventListener("scroll", () => {
    if (!$("slack-channel").hidden) scroll = feed().scrollTop;
  });
}
