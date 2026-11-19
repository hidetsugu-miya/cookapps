// The detail of a calendar event: a popover beside the event that was pressed, with what the week fetch already brought (no call on a press).
// One at a time. A press on another event switches, a press on the same one closes; so do ✕, Escape, a click elsewhere, a scroll of the week, a resize,
// a week change and a screen change. Focus moves into the popover and returns to the event on ✕ and Escape (as the pane in pane.ts does).
// A redraw of the week (a background refresh) does not close it: `endEvents` finds the same event again in the new week and updates the popover, or closes it.
// The same event is told by its title, time text and account, so an event whose time or title changed is a different one and the popover closes.
import type { Info } from "./bindings/Info";
import { $, composing, tag } from "./dom.js";
import { CHECK_SVG, CLOSE_SVG, COPY_SVG, EDIT_SVG, LINES_SVG, MEET_SVG, PEOPLE_SVG, PIN_SVG, TRASH_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { htmlText, linkify } from "./mail-text.js";
import { closeCreate, eventChanged, openEdit, reloginLine } from "./calendar-create.js";
import { showFailure } from "./error-card.js";

const GAP = 8;

// The user's own answer as the status label shows it: [class, text]. An unknown answer (not an attendee) shows none.
const RESPONSE_LABEL: Record<string, [string, string]> = {
  accepted: ["ok", "承諾"],
  tentative: ["warn", "未定"],
  needsAction: ["warn", "未回答"],
  declined: ["off", "辞退"],
};

interface Target {
  info: Info;
  color: string;
  node: HTMLElement;
  // The day of the week the item is on: a multi-day event has one item per day, all with the same key.
  day: number;
}

// The events drawn in the shown week, filled by `bindEvent` while the week is drawn.
let targets: Target[] = [];
// The open popover, the event it belongs to, what it was built from (to skip a rebuild when a redraw changes nothing), and the week's scroll position when it opened.
let open: { target: Target; pop: HTMLElement; built: string; scrollTop: number } | null = null;

// The same event in another draw of the week: same title, time text and account.
const keyOf = (i: Info) => `${i.summary}\n${i.whenText}\n${i.account}`;
const builtOf = (t: Target) => JSON.stringify([t.info, t.color]);

// Before the week is drawn again: forget the events of the last draw.
export function startEvents() {
  targets = [];
}

// Makes `node` (a button) open the detail of `info`; `color` is the event's dot and `day` the day of the week the item is on.
export function bindEvent(node: HTMLElement, info: Info, color: string, day: number) {
  const target = { info, color, node, day };
  targets.push(target);
  node.onclick = () => (open?.target.node === node ? closeDetail(true) : show(target));
}

// The event with the IDs of the week as it is drawn now (the first day's item, for a multi-day event), or undefined when the week has none: where the form of C-7 that Claude fills in goes.
export function eventTarget(account: string, calendarId: string, eventId: string) {
  return targets.find((t) => t.info.eventId === eventId && t.info.calendarId === calendarId && t.info.account === account);
}

// The node of the event `info` in the week as it is drawn now (the first day's, for a multi-day event), or undefined when the week has none.
export function eventNode(info: Info) {
  return targets.find((t) => t.info.eventId === info.eventId && t.info.calendarId === info.calendarId && t.info.account === info.account)?.node;
}

// After the week is drawn: keeps the popover open on the same event of the new draw, with its content brought up to date, or closes it when the event is gone.
export function endEvents() {
  if (!open) return;
  const key = keyOf(open.target.info);
  // The item on the same day first: a multi-day event has an item per day with the same key.
  const same = targets.filter((t) => keyOf(t.info) === key);
  const target = same.find((t) => t.day === open?.target.day) ?? same[0];
  if (!target) return closeDetail();
  const built = builtOf(target);
  if (built !== open.built) {
    const focused = open.pop.contains(document.activeElement);
    const pop = build(target);
    open.pop.replaceWith(pop);
    open.pop = pop;
    open.built = built;
    if (focused) pop.focus({ preventScroll: true });
  }
  open.target = target;
  open.scrollTop = $("cal-scroll").scrollTop;
  target.node.classList.add("selected");
  place(open.pop, target.node);
}

// Closes the popover. With `restoreFocus`, focus goes back to the event (✕ and Escape).
export function closeDetail(restoreFocus = false) {
  if (!open) return;
  const { target, pop } = open;
  open = null;
  target.node.classList.remove("selected");
  pop.remove();
  if (restoreFocus && target.node.isConnected) target.node.focus({ preventScroll: true });
}

function show(target: Target) {
  closeDetail();
  closeCreate();
  const pop = build(target);
  open = { target, pop, built: builtOf(target), scrollTop: $("cal-scroll").scrollTop };
  target.node.classList.add("selected");
  place(pop, target.node);
  pop.focus({ preventScroll: true });
}

// A row of the body: an icon and its content (the form of C-5 uses it too).
export function row(icon: string, content: Node) {
  const r = tag("div", "cal-pop-row");
  r.insertAdjacentHTML("beforeend", icon);
  r.append(content);
  return r;
}

function meetBlock(url: string) {
  const join = tag("a", "text-btn primary meet-join");
  join.href = url;
  join.insertAdjacentHTML("beforeend", MEET_SVG);
  join.append("Meet に参加");
  const copy = tag("button", "icon-btn");
  copy.type = "button";
  copy.innerHTML = COPY_SVG;
  copy.setAttribute("aria-label", "URL をコピー");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.innerHTML = CHECK_SVG;
      setTimeout(() => (copy.innerHTML = COPY_SVG), 2000);
    } catch (err) {
      showFailure("calendar-detail", err);
    }
  };
  const line = tag("div", "cal-pop-url");
  line.append(tag("span", "", url.replace(/^https:\/\//, "")), copy);
  const block = tag("div", "cal-pop-meet");
  block.append(join, line);
  return block;
}

// The description as text nodes and links: HTML goes through the mail summary's HTML-to-text, and nothing of it is inserted as markup.
function descriptionBlock(description: string) {
  const box = tag("div", "cal-pop-desc");
  // A plain-text "<https://example.com/a>" is a tag to the HTML parser and would vanish with its URL, so the brackets go first.
  box.append(...linkify(htmlText(description.replace(/<(https?:\/\/[^\s<>]+)>/g, "$1"), true)));
  return box;
}

// The confirmation of the delete (C-7), in the popover in place of the rows: the title, a line for the guests who are told, and "キャンセル" and "削除".
// "キャンセル" puts the rows back. A failure is written in it, and "削除" can be pressed again.
function confirmDelete(pop: HTMLElement, i: Info) {
  // The trash is still in the head while the confirmation is shown: pressing it again changes nothing.
  if (pop.querySelector(".cal-pop-confirm")) return;
  const rows = [...pop.children].slice(1);
  const box = tag("div", "cal-pop-confirm");
  box.append(tag("p", "", `「${i.summary || "(件名なし)"}」を削除します。元に戻せません。`));
  if (i.guests.length > 0) box.append(tag("p", "", "ゲストに取り消しが届きます。"));
  const error = tag("div", "cal-create-error");
  error.setAttribute("role", "alert");
  const yes = tag("button", "text-btn danger", "削除");
  const no = tag("button", "text-btn", "キャンセル");
  yes.type = no.type = "button";
  no.onclick = () => {
    box.remove();
    pop.append(...rows);
    pop.focus({ preventScroll: true });
  };
  yes.onclick = async () => {
    yes.disabled = no.disabled = true;
    error.replaceChildren();
    try {
      const gone = await invoke("calendar_delete_event", { account: i.account, calendarId: i.calendarId, eventId: i.eventId });
      if (gone === null) {
        // The account has not granted the permission to change events yet: log in again. A detail closed meanwhile has no place for it, so it goes to a card.
        const text = `${i.account} は予定を削除するため再ログインが必要です`;
        if (pop.isConnected) error.replaceChildren(reloginLine(i.account, text));
        else showFailure("calendar-delete", text);
        return;
      }
      // Another event's detail may be open by now: only this one is closed.
      if (pop.isConnected) closeDetail();
      eventChanged();
    } catch (e) {
      if (pop.isConnected) error.replaceChildren(String(e));
      else showFailure("calendar-delete", e);
    } finally {
      yes.disabled = no.disabled = false;
    }
  };
  const foot = tag("div", "cal-pop-foot");
  foot.append(error, no, yes);
  box.append(foot);
  for (const r of rows) r.remove();
  pop.append(box);
  no.focus({ preventScroll: true });
}

function build({ info: i, color, node }: Target) {
  const pop = tag("div", "pop cal-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", i.summary || "(件名なし)");
  pop.tabIndex = -1;
  pop.style.setProperty("--c", color);
  const close = tag("button", "icon-btn");
  close.type = "button";
  close.innerHTML = CLOSE_SVG;
  close.setAttribute("aria-label", "閉じる");
  close.onclick = () => closeDetail(true);
  const title = tag("div", "cal-pop-title");
  title.append(tag("h2", "", i.summary || "(件名なし)"));
  if (i.whenText) title.append(tag("div", "cal-pop-when", i.whenText));
  const head = tag("div", "cal-pop-head");
  head.append(tag("span", "cal-pop-dot"), title);
  // Only an event that the user organized, on a calendar they own, can be changed (C-7).
  if (i.editable) {
    const edit = tag("button", "icon-btn");
    edit.type = "button";
    edit.innerHTML = EDIT_SVG;
    edit.setAttribute("aria-label", "編集");
    edit.onclick = () => {
      // The week may have been drawn again since this popover was built: the event's node is the one of the draw now.
      const current = open?.target.node ?? node;
      closeDetail();
      openEdit(i, color, current);
    };
    const del = tag("button", "icon-btn");
    del.type = "button";
    del.innerHTML = TRASH_SVG;
    del.setAttribute("aria-label", "削除");
    del.onclick = () => confirmDelete(pop, i);
    head.append(edit, del);
  }
  head.append(close);
  pop.append(head);
  if (i.meetUrl) pop.append(meetBlock(i.meetUrl));
  if (i.location) pop.append(row(PIN_SVG, tag("span", "", i.location)));
  if (i.description) pop.append(row(LINES_SVG, descriptionBlock(i.description)));
  if (i.attendees > 0) pop.append(row(PEOPLE_SVG, tag("div", "", `参加者 ${i.attendees}人（承諾 ${i.accepted}）`)));
  const foot = tag("div", "cal-pop-foot");
  foot.append(tag("span", "cal-pop-cal", [i.calendar, i.account].filter(Boolean).join(" ・ ")));
  const label = RESPONSE_LABEL[i.response];
  if (label) foot.append(tag("span", `status ${label[0]}`, label[1]));
  pop.append(foot);
  return pop;
}

// Beside the event: to its right, or to its left when the right has no room; inside the window vertically (the form of C-5 uses it too, beside its draft).
export function place(pop: HTMLElement, node: HTMLElement) {
  // Not appended again when it is already there: a move would drop the focus inside it.
  if (!pop.isConnected) document.body.append(pop);
  pop.style.maxHeight = `${innerHeight - 2 * GAP}px`;
  const r = node.getBoundingClientRect();
  const right = r.right + GAP;
  const left = right + pop.offsetWidth <= innerWidth - GAP ? right : Math.max(GAP, r.left - GAP - pop.offsetWidth);
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(GAP, Math.min(r.top, innerHeight - pop.offsetHeight - GAP))}px`;
}

export function initCalendarDetail() {
  // A press on an event is the event's own (it switches or closes).
  document.addEventListener("pointerdown", (e) => {
    if (open && !(e.target as Element).closest(".cal-pop, .cal-event, .cal-chip")) closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape" && !composing(e)) closeDetail(true);
  });
  // Only a real scroll: the browser scrolls the event into view before a press, and its scroll event can arrive after the popover opened.
  $("cal-scroll").addEventListener("scroll", () => {
    if (open && $("cal-scroll").scrollTop !== open.scrollTop) closeDetail();
  });
  window.addEventListener("resize", () => closeDetail());
}
