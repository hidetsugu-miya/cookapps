// C-4: the small calendar of a month. It is in the panel at the left of the week and, opened by the title of the bar, over the week; `monthCalendar` makes both.
// The days come from Rust (`calendar_month`: the weeks that hold the month, from the first day of the week). A press on a day shows the week that holds it.
// The month shown is one for both; it follows the week drawn (the month of its middle day, as the title says), and ‹ › in either moves it.
import type { MonthGrid } from "./bindings/MonthGrid";
import type { MonthDay } from "./bindings/MonthDay";
import { $, composing, tag } from "./dom.js";
import { addDays, isoDate, WEEKDAYS } from "./format.js";
import { CHEVRON_LEFT_SVG, CHEVRON_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { showError } from "./view.js";

const today = new Date();
let view = { year: today.getFullYear(), month: today.getMonth() + 1 };
// The first day of the week shown (the day the week starts on, C-3), and the date it falls on.
let weekStart = "";
let first = 0;
let pick: (date: string) => void = () => {};
// The calendars made, with what is redrawn in each. A read that began before a newer one must not draw over it.
const calendars: { title: HTMLElement; grid: HTMLElement }[] = [];
let seq = 0;

function dayButton(d: MonthDay, todayDate: string) {
  const b = tag("button", `cal-mini-day${d.inMonth ? "" : " other"}${d.date === todayDate ? " today" : ""}`, String(d.day));
  b.type = "button";
  b.dataset.date = d.date;
  const [, m, day] = d.date.split("-").map(Number);
  b.setAttribute("aria-label", `${m}月${day}日`);
  if (d.date === todayDate) b.setAttribute("aria-current", "date");
  b.onclick = () => pick(d.date);
  return b;
}

// The weekday names, then a row for each week; the row of the week shown has the `current` mark.
function rowsOf(grid: MonthGrid) {
  const todayDate = isoDate(new Date());
  const rows = [tag("div", "cal-mini-row")];
  rows[0].append(...grid.weekdays.map((w) => tag("span", "cal-mini-wd", WEEKDAYS[w])));
  for (let i = 0; i < grid.days.length; i += 7) {
    const week = grid.days.slice(i, i + 7);
    const row = tag("div", `cal-mini-row${week[0].date === weekStart ? " current" : ""}`);
    row.append(...week.map((d) => dayButton(d, todayDate)));
    rows.push(row);
  }
  return rows;
}

async function redraw() {
  const mine = ++seq;
  const text = `${view.year}年${view.month}月`;
  for (const c of calendars) c.title.textContent = text;
  try {
    const grid = await invoke("calendar_month", { year: view.year, month: view.month, firstDay: first });
    if (mine !== seq) return;
    for (const c of calendars) c.grid.replaceChildren(...rowsOf(grid));
  } catch (e) {
    if (mine === seq) showError(e);
  }
}

function moveMonth(delta: number) {
  const at = new Date(view.year, view.month - 1 + delta, 1);
  view = { year: at.getFullYear(), month: at.getMonth() + 1 };
  redraw();
}

function navButton(label: string, svg: string, delta: number) {
  const b = tag("button", "icon-btn");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.innerHTML = svg;
  b.onclick = () => moveMonth(delta);
  return b;
}

function monthCalendar() {
  const root = tag("div", "cal-mini");
  const title = tag("span", "cal-mini-title");
  const head = tag("div", "cal-mini-head");
  head.append(title, navButton("前の月", CHEVRON_LEFT_SVG, -1), navButton("次の月", CHEVRON_SVG, 1));
  const grid = tag("div", "cal-mini-grid");
  root.append(head, grid);
  calendars.push({ title, grid });
  return root;
}

const popOpen = () => !$("cal-month-pop").hidden;

// Hides the month calendar over the week. With `restoreFocus`, the focus goes back to the title (Escape and a day).
export function closeMonthPop(restoreFocus = false) {
  if (!popOpen()) return;
  $("cal-month-pop").hidden = true;
  $("cal-title").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("cal-title").focus({ preventScroll: true });
}

function openMonthPop() {
  const pop = $("cal-month-pop");
  const [bar, main, title] = [$("cal-bar"), $("cal-main"), $("cal-title")];
  pop.style.top = `${bar.offsetHeight}px`;
  pop.style.left = `${title.getBoundingClientRect().left - main.getBoundingClientRect().left}px`;
  pop.hidden = false;
  title.setAttribute("aria-expanded", "true");
}

// The week of `start` ("YYYY-MM-DD") is drawn, and `middle` is the day in the middle of it: the calendars show its month, unless they show this week already.
export function showCalendarMonth(start: string, middle: Date) {
  if (start !== weekStart) {
    weekStart = start;
    first = addDays(start, 0).getDay();
    view = { year: middle.getFullYear(), month: middle.getMonth() + 1 };
  }
  redraw();
}

// `pickDate` shows the week that holds the date pressed.
export function initCalendarMonth(pickDate: (date: string) => void) {
  pick = (date) => {
    closeMonthPop(popOpen());
    pickDate(date);
  };
  $("cal-month").append(monthCalendar());
  $("cal-month-pop").append(monthCalendar());
  $("cal-title").onclick = () => (popOpen() ? closeMonthPop() : openMonthPop());
  document.addEventListener("pointerdown", (e) => {
    if (popOpen() && !(e.target as Element).closest("#cal-month-pop, #cal-title")) closeMonthPop();
  });
  document.addEventListener("keydown", (e) => {
    if (popOpen() && e.key === "Escape" && !composing(e)) closeMonthPop(true);
  });
}
