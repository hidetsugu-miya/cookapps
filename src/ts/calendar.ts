// The calendar screen: a week of the selected calendars' events, kept in memory and fetched in the background.
import type { AllDayItem } from "./bindings/AllDayItem";
import type { TimedItem } from "./bindings/TimedItem";
import type { Week } from "./bindings/Week";
import { addAccount, refreshPopup } from "./accounts.js";
import { $, el } from "./dom.js";
import { addDays, avatarColor, hhmm, isoDate, pad2, WEEKDAYS } from "./format.js";
import { invoke } from "./ipc.js";
import { currentScreen } from "./nav.js";
import { show, showError } from "./view.js";

const HOUR_PX = 64;
// Keep in step with MIN_MINUTES in calendar.rs.
const MIN_EVENT_MIN = 20;
const CAL_REFRESH_MS = 5 * 60 * 1000;

// A day of the week on screen, as "YYYY-MM-DD", and the week drawn now once loaded.
let calDate = isoDate(new Date());
let calShown: Week | null = null;
let calSeq = 0;
// Weeks fetched so far by their Sunday ("YYYY-MM-DD"), oldest first; memory only.
const calCache = new Map<string, Week>();
const CAL_CACHE_MAX = 10;
// The weeks the last run kept, read once and then drawn from here; not fetched weeks, so a draw from it is always followed by a fetch.
let keptWeeks: Promise<Week[]> | null = null;
// Bumped when the cache is dropped, so a fetch that began before cannot put its week back.
let calEpoch = 0;
// The next fetch makes the backend list the calendars again.
let calRefresh = false;
// Weeks being fetched ahead.
const calAhead = new Set<string>();
// The first render after opening the calendar scrolls to the morning; later ones keep the position.
let calScrolled = false;

// The accounts changed (a login, a removal): the weeks kept so far and the calendar lists behind them are stale.
// The popup must not keep the old state until the calendar is opened; `dropKept` also forgets the weeks of the last run.
export function resetCalendar(dropKept: boolean) {
  if (dropKept) keptWeeks = Promise.resolve([]);
  calCache.clear();
  calEpoch++;
  calRefresh = true;
  calShown = null;
}

// Whether the shown week says that `account` must log in again for the calendar.
export const calendarNeedsLogin = (account: string) => calShown?.needsLogin.includes(account);

// The event's own color (its calendar's); events with none take the account's, as the mail list does.
const eventColor = (e: { color: string | null; account: string }) => e.color || avatarColor(e.account);
// Longer titles are cut with "…"; the full one stays in the tooltip.
const CAL_NAME_MAX = 20;

function eventBox(e: TimedItem) {
  const box = el("cal-event" + (e.declined ? " declined" : ""));
  box.style.top = `${(e.startMin / 60) * HOUR_PX}px`;
  box.style.height = `${(Math.max(e.endMin - e.startMin, MIN_EVENT_MIN) / 60) * HOUR_PX - 1}px`;
  box.style.left = `${(e.col / e.cols) * 100}%`;
  box.style.width = `${100 / e.cols}%`;
  box.style.setProperty("--c", eventColor(e));
  box.title = `${e.summary}\n${e.account}`;
  const name = e.summary || "(件名なし)";
  // Counted by code point, so an emoji is never split in half.
  const chars = [...name];
  box.append(el("cal-name", chars.length > CAL_NAME_MAX ? chars.slice(0, CAL_NAME_MAX).join("") + "…" : name));
  // Under 45 minutes has no room for a second line, so the title takes the only one.
  if (e.endMin - e.startMin < 45) box.classList.add("short");
  // Side-by-side boxes are too narrow for the time; a long title would push it out of sight anyway.
  else if (e.cols === 1) box.append(el("cal-time", `${hhmm(e.startMin)} - ${hhmm(e.endMin)}`));
  return box;
}

function allDayChip(e: AllDayItem) {
  const c = el("cal-chip" + (e.declined ? " declined" : ""), e.summary || "(件名なし)");
  c.style.setProperty("--c", eventColor(e));
  c.title = `${e.summary}\n${e.account}`;
  return c;
}

// The current-time line in today's column and its label in the time gutter, if the shown week holds today.
function drawNow() {
  document.querySelectorAll(".cal-now").forEach((n) => n.remove());
  const shown = calShown;
  if (!shown) return;
  const now = new Date();
  const day = [0, 1, 2, 3, 4, 5, 6].find((i) => isoDate(addDays(shown.weekStart, i)) === isoDate(now));
  if (day === undefined) return;
  const top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px`;
  const line = el("cal-now cal-now-line");
  const label = el("cal-now cal-now-label", `${now.getHours()}:${pad2(now.getMinutes())}`);
  line.style.top = label.style.top = top;
  // Children of #cal-body: the time gutter, then the seven day columns.
  $("cal-body").children[day + 1].append(line);
  $("cal-body").firstElementChild!.append(label);
}

function renderWeek(w: Week) {
  calShown = w;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(w.weekStart, i));
  const todayIndex = days.findIndex((d) => isoDate(d) === isoDate(new Date()));
  const mark = <N extends HTMLElement>(node: N, i: number) => {
    if (i === todayIndex) node.classList.add("today");
    return node;
  };
  // The title names the month of the middle of the week.
  const year = document.createElement("span");
  year.className = "year";
  year.textContent = ` ${days[3].getFullYear()}`;
  $("cal-title").replaceChildren(`${days[3].getMonth() + 1}月`, year);
  $("cal-head").replaceChildren(
    el("cal-gutter"),
    ...days.map((d, i) => {
      const cell = mark(el("cal-day", `${WEEKDAYS[d.getDay()]} `), i);
      cell.append(el("cal-date", String(d.getDate())));
      return cell;
    }),
  );
  $("cal-allday").replaceChildren(
    el("cal-allday-label", "終日"),
    ...days.map((_, i) => {
      const cell = el("cal-cell");
      cell.append(...w.allDay.filter((e) => e.day === i).map(allDayChip));
      return cell;
    }),
  );
  const gutter = el("cal-gutter");
  for (let h = 1; h < 24; h++) {
    const label = el("cal-hour", `${h}:00`);
    label.style.top = `${h * HOUR_PX}px`;
    gutter.append(label);
  }
  $("cal-body").replaceChildren(
    gutter,
    ...days.map((_, i) => {
      const col = el("cal-col");
      col.append(...w.timed.filter((e) => e.day === i).map(eventBox));
      return col;
    }),
  );
  drawNow();
  $("cal-notice").replaceChildren(
    ...w.needsLogin.map((a) => {
      const div = document.createElement("div");
      const button = document.createElement("button");
      button.textContent = "再ログイン";
      button.onclick = () => addAccount(a, button);
      div.append(`${a} はカレンダーを読むため再ログインが必要です`, button);
      return div;
    }),
    ...Object.entries(w.failed).map(([a, message]) => {
      const div = document.createElement("div");
      div.textContent = `${a} の予定の読み込みに失敗しました: ${message}`;
      return div;
    }),
    ...w.calendarFailed.map((message) => {
      const div = document.createElement("div");
      div.textContent = message;
      return div;
    }),
  );
  refreshPopup();
  if (!calScrolled) {
    // Two hours before now at the top (11:00 shows from 9:00); a little less keeps the hour label whole.
    $("cal-scroll").scrollTop = Math.max(0, (new Date().getHours() - 2) * HOUR_PX - 12);
    calScrolled = true;
  }
}

// The Sunday of the week holding the "YYYY-MM-DD" date.
const weekKey = (iso: string) => isoDate(addDays(iso, -addDays(iso, 0).getDay()));

// Fetches the week holding `date` and keeps it, dropping the oldest beyond CAL_CACHE_MAX.
async function fetchWeek(date: string, refresh: boolean) {
  const epoch = calEpoch;
  refresh ||= calRefresh;
  calRefresh = false;
  const week = await invoke("calendar_week", { date, refresh });
  if (epoch === calEpoch) {
    calCache.delete(week.weekStart);
    calCache.set(week.weekStart, week);
    while (calCache.size > CAL_CACHE_MAX) calCache.delete(calCache.keys().next().value!);
  }
  return week;
}

// Fetches in the background the weeks before and after `key` that are not kept yet; a failure is left to when the week is opened.
function prefetchAround(key: string) {
  for (const k of [isoDate(addDays(key, -7)), isoDate(addDays(key, 7))]) {
    if (calCache.has(k) || calAhead.has(k)) continue;
    calAhead.add(k);
    fetchWeek(k, false)
      .catch(() => {})
      .finally(() => calAhead.delete(k));
  }
}

// Draws the week the last run kept for `key` while the fetch is on its way, unless the fetch got there first or another week was asked for; a missing or failed read leaves the screen to the fetch.
async function showKeptWeek(key: string, seq: number) {
  keptWeeks ??= invoke("calendar_cached").catch(() => []);
  const kept = (await keptWeeks).find((w) => w.weekStart === key);
  if (!kept || seq !== calSeq || calShown?.weekStart === key) return;
  renderWeek(kept);
  $("calendar").classList.remove("loading");
}

// Shows the week of `calDate`: the kept one at once, then the fetched one if it differs, so the scroll position stays.
// With none kept, the old week stays (dimmed) until the new one arrives.
export async function loadCalendar(refresh = false) {
  const seq = ++calSeq;
  const key = weekKey(calDate);
  const kept = calCache.get(key);
  $("error").hidden = true;
  if (kept) {
    if (calShown?.weekStart !== key) renderWeek(kept);
  } else {
    $("calendar").classList.add("loading");
    showKeptWeek(key, seq);
  }
  try {
    const week = await fetchWeek(calDate, refresh);
    if (seq === calSeq) {
      if (JSON.stringify(week) !== JSON.stringify(calShown)) renderWeek(week);
      prefetchAround(key);
    }
  } catch (e) {
    if (seq === calSeq) showError(e);
  } finally {
    if (seq === calSeq) $("calendar").classList.remove("loading");
  }
}

// Opens the calendar screen: the first draw scrolls to the morning again.
export function showCalendar() {
  calScrolled = false;
  show("calendar");
  loadCalendar();
}

const moveWeek = (date: string) => {
  calDate = date;
  loadCalendar();
};

export function initCalendar() {
  $("cal-prev").onclick = () => moveWeek(isoDate(addDays(calDate, -7)));
  $("cal-next").onclick = () => moveWeek(isoDate(addDays(calDate, 7)));
  $("cal-today").onclick = () => moveWeek(isoDate(new Date()));
  $("calendar").style.setProperty("--hour", `${HOUR_PX}px`);
  setInterval(() => currentScreen() === "calendar" && !document.hidden && loadCalendar(true), CAL_REFRESH_MS);
  setInterval(() => currentScreen() === "calendar" && drawNow(), 60000);
}
