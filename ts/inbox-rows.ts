// The rows of the inbox list: building one, its read state, and the unread count on the sidebar.
import type { ThreadItem } from "./bindings/ThreadItem";
import { $, span } from "./dom.js";
import { avatarColor, formatDate, initials, senderName, unescapeHtml } from "./format.js";
import { CHECK_SVG, TODO_SVG } from "./icons.js";
import { load, removeRow } from "./inbox.js";
import { invoke } from "./ipc.js";
import { openThread } from "./thread.js";
import { makeTodo } from "./todo-add.js";
import { setNavCount, showError } from "./view.js";

// Threads being archived / trashed ("account/id"); a list reload or sync must not bring them back meanwhile.
export const pending = new Set<string>();

// The rows on screen by "account/id": the thread data and its <li>.
export const rows = new Map<string, { t: ThreadItem; li: HTMLLIElement }>();
export const rowKey = (t: { account: string; id: string }) => `${t.account}/${t.id}`;

// Unread threads among `rows`, minus those being archived / trashed.
const countUnread = (rows: Map<string, { t: ThreadItem }>, pending: Set<string>) =>
  [...rows].filter(([key, r]) => r.t.unread && !pending.has(key)).length;

// The inbox button shows the unread count of the list (view.ts sums it into the Dock badge); the update is skipped when the count is unchanged.
let badge = 0;
export function updateBadge() {
  const count = countUnread(rows, pending);
  if (count === badge) return;
  badge = count;
  setNavCount("nav-mail", count, "受信トレイ", "未読");
}

// Puts the row in its section, unread above read, in date order.
export function place(li: HTMLLIElement, unread: boolean) {
  const list = $(unread ? "unread-threads" : "read-threads");
  const next = [...list.children].find((c) => Number((c as HTMLElement).dataset.dateMs) < Number(li.dataset.dateMs));
  list.insertBefore(li, next || null);
}

// Reflects the read state in the row: bold, dot, checkbox, and its section.
export function setReadState(t: ThreadItem, li: HTMLLIElement, read: boolean) {
  const moves = li.isConnected && li.classList.contains("unread") === read;
  t.unread = !read;
  li.classList.toggle("unread", !read);
  if (moves) place(li, !read);
  const box = li.querySelector<HTMLInputElement>(".read-box")!;
  box.checked = read;
  box.setAttribute("aria-label", read ? "未読にする" : "既読にする");
}

// Updates UNREAD in Gmail; `control` is disabled while sending. On failure the row returns to its last known state.
async function sendRead(t: ThreadItem, li: HTMLLIElement, read: boolean, control: HTMLInputElement) {
  $("error").hidden = true;
  // The row moves to the other section, which drops the focus; keyboard users keep it on the control.
  const focused = document.activeElement === control;
  control.disabled = true;
  try {
    const done = await invoke("set_read", { account: t.account, id: t.id, read });
    if (done === null) return load();
    setReadState(t, li, read);
  } catch (e) {
    setReadState(t, li, !t.unread);
    showError(e);
  } finally {
    control.disabled = false;
    if (focused && control.isConnected) control.focus();
    updateBadge();
  }
}

// Round checkbox mirroring the read state: checked = read. Toggling it updates UNREAD in Gmail.
function readBox(t: ThreadItem, li: HTMLLIElement) {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "read-box";
  // The row opens the thread on click; the checkbox must not.
  box.onclick = (e) => e.stopPropagation();
  box.onchange = () => sendRead(t, li, box.checked, box);
  return box;
}

// Icon button shown in place of the date on hover; it must not open the thread.
// Also the row buttons of the Todo list.
export function rowButton(className: string, label: string, svg: string, action: (button: HTMLButtonElement) => void) {
  const button = document.createElement("button");
  button.className = `row-btn ${className}`;
  button.setAttribute("aria-label", label);
  button.innerHTML = svg;
  button.onclick = (e) => {
    e.stopPropagation();
    action(button);
  };
  return button;
}

export function row(t: ThreadItem) {
  const li = document.createElement("li");
  li.dataset.dateMs = String(t.dateMs);
  const subject = span("subject", t.subject || "(件名なし)");
  subject.append(span("snippet", ` — ${unescapeHtml(t.snippet)}`));
  li.onclick = () => openThread(t, li);
  const name = senderName(t.from);
  const avatar = span("avatar", initials(name));
  avatar.style.background = avatarColor(name);
  // Marks which account the thread belongs to.
  const dot = span("account-dot", "");
  dot.style.background = avatarColor(t.account);
  dot.title = t.account;
  avatar.append(dot);
  // The date and the hover buttons share one grid cell.
  const trail = span("trail", "");
  const actions = span("row-actions", "");
  actions.append(
    rowButton("archive-row", "アーカイブ", CHECK_SVG, () => removeRow("archive", t.account, t.id, li)),
    rowButton("trash-row", "ゴミ箱へ移動", $("trash").innerHTML, () => removeRow("trash", t.account, t.id, li)),
    rowButton("todo-row", "Todo にする", TODO_SVG, (button) => makeTodo(t.account, t.id, t.subject, button)),
  );
  trail.append(span("date", formatDate(t.dateMs)), actions);
  li.append(readBox(t, li), span("unread-dot", ""), avatar, span("from", name), subject, trail);
  setReadState(t, li, !t.unread);
  return li;
}
