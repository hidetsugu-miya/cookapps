// The detail of a calendar event: a popover beside the event that was pressed, with what the week fetch already brought (no call on a press).
// One at a time. A press on another event switches, a press on the same one closes; so do ✕, Escape, a click elsewhere, a scroll of the week, a resize,
// a week change and a screen change. Focus moves into the popover and returns to the event on ✕ and Escape (as the pane in pane.ts does).
// A redraw of the week (a background refresh) does not close it: `endEvents` finds the same event again in the new week and updates the popover, or closes it.
import type { Info } from "./bindings/Info";
import { $, composing, tag } from "./dom.js";
import { CHECK_SVG, CLOSE_SVG, COPY_SVG, LINES_SVG, MEET_SVG, PEOPLE_SVG, PIN_SVG } from "./icons.js";
import { htmlText, linkify } from "./mail-text.js";
import { showError } from "./view.js";

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

// Makes `node` (a button) open the detail of `info`; `color` is the event's dot.
export function bindEvent(node: HTMLElement, info: Info, color: string) {
  const target = { info, color, node };
  targets.push(target);
  node.onclick = () => (open?.target.node === node ? closeDetail(true) : show(target));
}

// After the week is drawn: keeps the popover open on the same event of the new draw, with its content brought up to date, or closes it when the event is gone.
export function endEvents() {
  if (!open) return;
  const key = keyOf(open.target.info);
  const target = targets.find((t) => keyOf(t.info) === key);
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
  const pop = build(target);
  open = { target, pop, built: builtOf(target), scrollTop: $("cal-scroll").scrollTop };
  target.node.classList.add("selected");
  place(pop, target.node);
  pop.focus({ preventScroll: true });
}

// A row of the body: an icon and its content.
function row(icon: string, content: Node) {
  const r = tag("div", "cal-pop-row");
  r.insertAdjacentHTML("beforeend", icon);
  r.append(content);
  return r;
}

function meetBlock(url: string) {
  const join = tag("a", "meet-join");
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
      showError(err);
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
  box.append(...linkify(htmlText(description)));
  return box;
}

function build({ info: i, color }: Target) {
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
  head.append(tag("span", "cal-pop-dot"), title, close);
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

// Beside the event: to its right, or to its left when the right has no room; inside the window vertically.
function place(pop: HTMLElement, node: HTMLElement) {
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
