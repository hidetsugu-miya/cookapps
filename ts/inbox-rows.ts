// The rows of the inbox list: building one, its read state, and the unread count on the sidebar.
import type { ThreadItem } from "./bindings/ThreadItem";
import { $, span } from "./dom.js";
import { avatarColor, formatDate, initials, senderName, unescapeHtml } from "./format.js";
import { CHECK_SVG, TODO_SVG } from "./icons.js";
import { load, removeRow } from "./inbox.js";
import { invoke } from "./ipc.js";
import { openThread } from "./thread.js";
import { makeTodo } from "./todo-add.js";
import { toast } from "./toast.js";
import { setNavCount, showError } from "./view.js";

// Threads being archived / trashed ("account/id"); a list reload or sync must not bring them back meanwhile.
export const pending = new Set<string>();

// Threads whose Todo is being made ("account/id"); a row built meanwhile shows the spinner too, so a second press cannot make a duplicate task.
const makingTodo = new Set<string>();

// The Todo button of a row: the icon, or the spinner and disabled while its task is made.
function showTodoButton(button: HTMLButtonElement, busy: boolean) {
  button.disabled = busy;
  button.classList.toggle("busy", busy);
  if (busy) button.replaceChildren(span("spin", ""));
  else button.innerHTML = TODO_SVG;
}

// Makes the task of a thread; when it ends, the button of the row that holds the thread then, which a sync or load may have rebuilt, is put back.
async function makeTodoOf(t: ThreadItem, button: HTMLButtonElement) {
  const key = rowKey(t);
  makingTodo.add(key);
  await makeTodo(t.account, t.id, t.subject, button);
  makingTodo.delete(key);
  const now = rows.get(key)?.li.querySelector<HTMLButtonElement>(".todo-row");
  if (now) showTodoButton(now, false);
}

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
  syncMarkAll();
}

// "すべて既読にする" is pressable while a thread is unread and no run of it is on its way.
let markAllBusy = false;
function syncMarkAll() {
  $<HTMLButtonElement>("mail-mark-all").disabled = markAllBusy || badge === 0;
}

// The keys of the threads the last "すべて既読にする" made read, for its "元に戻す". A newer run replaces them.
let lastMarked: string[] = [];
// Requests at once.
const MARK_PARALLEL = 4;

// Runs `run` on every item, `limit` at a time.
async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Makes the threads of `list` read (or unread) in Gmail with `set_read`, one request each. The rows change first; a row whose request fails goes back and the failures are reported once.
// The read box of a row stays disabled while its request is on its way, so that a sync leaves the row as it is (as for a single toggle). Returns the keys of the threads that were changed.
async function markRows(list: { t: ThreadItem; li: HTMLLIElement }[], read: boolean) {
  $("error").hidden = true;
  const boxes = list.map(({ t, li }) => {
    const box = li.querySelector<HTMLInputElement>(".read-box")!;
    box.disabled = true;
    setReadState(t, li, read);
    return box;
  });
  updateBadge();
  const done: string[] = [];
  const failed: unknown[] = [];
  let relogin = false;
  await pool(
    list.map((r, i) => ({ ...r, box: boxes[i] })),
    MARK_PARALLEL,
    async ({ t, li, box }) => {
      try {
        const ok = await invoke("set_read", { account: t.account, id: t.id, read });
        if (ok === null) {
          relogin = true;
          setReadState(t, li, !read);
        } else {
          done.push(rowKey(t));
        }
      } catch (e) {
        setReadState(t, li, !read);
        failed.push(e);
      } finally {
        box.disabled = false;
      }
    },
  );
  updateBadge();
  if (failed.length) showError(`${failed.length} 件を更新できませんでした: ${failed[0]}`);
  if (relogin) load();
  return done;
}

// Makes every unread thread of the list read. The notice offers to make the ones that were changed unread again.
export async function markAllRead() {
  if (markAllBusy) return;
  const targets = [...rows]
    .filter(([key, r]) => r.t.unread && !pending.has(key) && !r.li.querySelector<HTMLInputElement>(".read-box")!.disabled)
    .map(([, r]) => r);
  if (!targets.length) return;
  markAllBusy = true;
  syncMarkAll();
  const done = await markRows(targets, true);
  markAllBusy = false;
  syncMarkAll();
  lastMarked = done;
  if (done.length) toast(`${done.length} 件を既読にしました`, { label: "元に戻す", run: undoMarkAll });
}

// Makes the threads the last run changed unread again, those still in the list.
async function undoMarkAll() {
  const list = lastMarked.flatMap((key) => rows.get(key) ?? []);
  lastMarked = [];
  if (markAllBusy || !list.length) return;
  markAllBusy = true;
  syncMarkAll();
  const done = await markRows(list, false);
  markAllBusy = false;
  syncMarkAll();
  if (done.length) toast("元に戻しました");
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
  const todoButton = rowButton("todo-row", "Todo にする", TODO_SVG, (button) => makeTodoOf(t, button));
  if (makingTodo.has(rowKey(t))) showTodoButton(todoButton, true);
  actions.append(
    rowButton("archive-row", "アーカイブ", CHECK_SVG, () => removeRow("archive", t.account, t.id, li)),
    rowButton("trash-row", "ゴミ箱へ移動", $("trash").innerHTML, () => removeRow("trash", t.account, t.id, li)),
    todoButton,
  );
  trail.append(span("date", formatDate(t.dateMs)), actions);
  li.append(readBox(t, li), span("unread-dot", ""), avatar, span("from", name), subject, trail);
  setReadState(t, li, !t.unread);
  return li;
}
