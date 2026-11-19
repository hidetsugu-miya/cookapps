// C-5: creating an event. A press on an empty place of the week (an hour of a day, or the all-day band) draws a draft event there and opens a popover beside it,
// of the frame of the detail of C-2 (ts/calendar-detail.ts). The popover holds the form; "保存" calls `calendar_create_event`, closes it and has the week read again.
// It closes as the detail does: ✕, Escape, a press elsewhere, a week change and a screen change. What was written is lost then, with the draft, and nothing asks first.
// A scroll or a resize of the week moves the popover with the draft instead of closing it, so that what was written stays.
// C-7: the same form edits an event. `openEdit` starts it with the event's values, beside the event itself (no draft), with the calendar shown and not changeable, and "保存" calls `calendar_update_event`.
import type { Info } from "./bindings/Info";
import type { NewEvent } from "./bindings/NewEvent";
import { addAccount } from "./accounts.js";
import { closeDetail, eventNode, eventTarget, place, row } from "./calendar-detail.js";
import { $, composing, tag } from "./dom.js";
import { showFailure } from "./error-card.js";
import { addDays, avatarColor, hhmm, isoDate, pad2 } from "./format.js";
import { CLOCK_SVG, CLOSE_SVG, DATE_SVG, LINES_SVG, MEET_SVG, PEOPLE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import type { Fields as BridgeFields } from "./screen-bridge.js";

// Keep in step with MIN_EVENT_MIN in calendar.ts: the shortest height a draft is drawn with.
const MIN_DRAFT_MIN = 20;

interface Choice {
  account: string;
  id: string;
  name: string;
  color: string | null;
  shown: boolean;
}

// What the form holds, as the draft and the save read it.
interface Fields {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  color: string;
}

// What `calendar_owned` answers: the calendars that an event can be created in, and the accounts that have none to list because they must log in again or failed.
interface Owned {
  list: Choice[];
  needsLogin: string[];
  failed: Record<string, string>;
}

// The calendars that an event can be created in, read once the first time a form opens and kept; a failed read, or one with no calendar, is made again at the next one.
let owned: Promise<Owned> | null = null;
// A login or a removal of an account makes the kept list stale.
export function forgetOwnedCalendars() {
  owned = null;
}
function readOwned() {
  owned ??= invoke("calendar_owned")
    .then((read) => {
      const list = read.accounts.flatMap((a) => a.calendars.map((c) => ({ account: a.account, id: c.id, name: c.name, color: c.color, shown: c.shown })));
      if (list.length === 0) owned = null;
      return { list, needsLogin: read.needsLogin, failed: read.failed };
    })
    .catch((e) => {
      owned = null;
      throw e;
    });
  return owned;
}

// The fields of the target "calendar-form" of ts/screen-bridge.ts (C-6): the form that `calendar_create_event` and `calendar_update_event` of tsunagiai-mcp ask for, instead of sending an event that invites someone new.
// `form` is JSON (see `form_fields` in calendar.rs) and `description` the text; the owner reads the form and saves it.
export const formNames = ["form", "description"] as const;

interface Wanted {
  // Empty for a new event.
  eventId: string;
  account: string;
  calendarId: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  guests: string[];
  meet: boolean;
}

// The calendar a form starts with: of the calendars shown (all, when none is shown), the primary calendar of the first account (its ID is the account's address), else the first.
function defaultChoice(list: Choice[]) {
  const pool = list.some((c) => c.shown) ? list.filter((c) => c.shown) : list;
  return pool.find((c) => c.account === pool[0].account && c.id === c.account) ?? pool[0];
}

// A line of the form's error that asks `account` to log in again, with the button that does it.
export function reloginLine(account: string, text: string) {
  const login = tag("button", "text-btn", "再ログイン");
  login.type = "button";
  login.onclick = () => addAccount(account, login);
  const line = tag("div", "");
  line.append(text, login);
  return line;
}

const colorOf = (c: Choice) => c.color || avatarColor(c.account);

// The open form, and what to read from it; `edit` is set when it edits `info`, beside `node` (the event as the week draws it now), with the color of its calendar.
// The first day of the week shown is what the draft is placed by.
interface Editing {
  info: Info;
  node: HTMLElement;
  color: string;
}
let open: { pop: HTMLElement; fields: () => Fields; edit: Editing | null } | null = null;
let shownWeek = "";
let onChanged: () => void = () => {};

// What a form starts with.
interface Initial {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  guests: string[];
  meet: boolean;
  description: string;
}

// The week read again after a save, or after the delete of the detail (C-7).
export function eventChanged() {
  onChanged();
}

const parseTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
// The days from the first day of the shown week to `date` (NaN for a date that is not one).
const dayOf = (date: string) => Math.round((addDays(date, 0).getTime() - addDays(shownWeek, 0).getTime()) / 86400000);

// The draft in the week: a box in the hour columns, or a chip in each day of the all-day band that the event covers. Drawn again with the week, since the week's draw drops it.
function drawDraft() {
  for (const n of document.querySelectorAll(".cal-draft")) n.remove();
  // An edit has the event itself in the week, not a draft.
  if (!open || open.edit) return;
  const f = open.fields();
  const name = f.title || "(件名なし)";
  const first = dayOf(f.startDate);
  let anchor: HTMLElement | undefined;
  if (f.allDay) {
    const last = dayOf(f.endDate);
    for (let i = Math.max(0, first); i <= Math.min(6, last); i++) {
      const chip = tag("div", "cal-draft cal-draft-chip", name);
      chip.style.setProperty("--c", f.color);
      $("cal-allday").children[i + 1].append(chip);
      anchor ??= chip;
    }
  } else if (first >= 0 && first <= 6) {
    const start = parseTime(f.startTime);
    // Over midnight, the box ends with the day.
    const end = f.endDate === f.startDate ? parseTime(f.endTime) : 1440;
    const length = Math.max(end - start, MIN_DRAFT_MIN);
    const box = tag("div", "cal-draft");
    box.style.setProperty("--c", f.color);
    box.style.setProperty("--s", String(start));
    box.style.setProperty("--d", String(length));
    box.append(tag("div", "", name));
    if (length >= 45) box.append(tag("div", "cal-draft-time", `${hhmm(start)} - ${hhmm(start + length)}`));
    $("cal-body").children[first + 1].append(box);
    anchor = box;
  }
  if (anchor) place(open.pop, anchor);
}

// Called when the week is drawn: the draft of an open form goes into the new draw.
export function redrawDraft(weekStart: string) {
  shownWeek = weekStart;
  if (open?.edit) return followEdit(open.edit);
  drawDraft();
}

// A form that edits an event goes beside the event of the new draw, or closes when the draw has no such event.
function followEdit(edit: Editing) {
  const node = eventNode(edit.info);
  if (!node) return closeCreate();
  edit.node = node;
  node.classList.add("selected");
  if (open) place(open.pop, node);
}

export function closeCreate() {
  if (!open) return;
  open.edit?.node.classList.remove("selected");
  open.pop.remove();
  open = null;
  for (const n of document.querySelectorAll(".cal-draft")) n.remove();
}

const dateField = (label: string, value: string) => {
  const input = tag("input", "cal-create-date");
  input.type = "date";
  input.value = value;
  input.setAttribute("aria-label", label);
  return input;
};
const timeField = (label: string, value: string) => {
  const input = tag("input", "cal-create-time");
  input.type = "time";
  input.value = value;
  input.setAttribute("aria-label", label);
  return input;
};
const clock = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
// The moment of a date and a time field (local), NaN while one of them is empty.
const moment = (date: string, time: string) => new Date(`${date}T${time}`);

// A date and a time in local time as RFC 3339 with the offset of that moment, which Rust reads; empty for a missing part, which Rust answers with an error.
function rfc3339(date: string, time: string) {
  const at = moment(date, time);
  if (Number.isNaN(at.getTime())) return "";
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  return `${date}T${time}:00${sign}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
}

// Opens the form for the empty place of `day` (0 to 6) of the week that starts on `weekStart`: the hour that starts at `startMin`, or the all-day band.
export function openCreate(weekStart: string, day: number, allDay: boolean, startMin: number) {
  const date = isoDate(addDays(weekStart, day));
  const start = new Date(addDays(date, 0).getTime());
  start.setMinutes(startMin);
  const end = new Date(start.getTime() + 3600000);
  shownWeek = weekStart;
  openForm(
    {
      title: "",
      allDay,
      startDate: date,
      startTime: clock(start),
      endDate: allDay ? date : isoDate(end),
      endTime: clock(end),
      guests: [],
      meet: false,
      description: "",
    },
    null,
  );
}

// The dates and times of an event for the form: a timed event as an RFC 3339 time, shown in this Mac's zone, and an all-day event as dates.
function whenOf(allDay: boolean, start: string, end: string) {
  const from = new Date(start);
  const to = new Date(end);
  return {
    allDay,
    startDate: allDay ? start : isoDate(from),
    startTime: allDay ? "00:00" : clock(from),
    endDate: allDay ? end : isoDate(to),
    endTime: allDay ? "00:00" : clock(to),
  };
}

// Opens the form on the event `info` (C-7), beside `node`, with `color` the color of its calendar.
// `wanted` and `description` are the values that Claude hands the form (C-6); with none, the form starts with the event's own (a `wanted` with no `description` keeps the event's description).
export function openEdit(info: Info, color: string, node: HTMLElement, wanted?: Wanted, description?: string) {
  // The event is in the week as it was drawn.
  openForm(
    wanted
      ? { title: wanted.title, ...whenOf(wanted.allDay, wanted.start, wanted.end), guests: wanted.guests, meet: wanted.meet, description: description ?? info.description ?? "" }
      : { title: info.summary, ...whenOf(info.allDay, info.start, info.end), guests: info.guests, meet: info.meetUrl !== null, description: info.description ?? "" },
    { info, node, color },
  );
}

// Takes the write of Claude into the form (C-6): a new event goes beside its draft, an event of the week beside the event itself. It saves nothing; a text it cannot take is a thrown error with a Japanese message.
export function writeForm(fields: BridgeFields) {
  let wanted: Wanted;
  try {
    wanted = JSON.parse(fields.form ?? "");
  } catch {
    throw new Error("欄 form は JSON の文にしてください");
  }
  const text = (v: unknown) => typeof v === "string";
  if (!wanted || ![wanted.eventId, wanted.account, wanted.calendarId, wanted.title, wanted.start, wanted.end].every(text) || typeof wanted.allDay !== "boolean" || typeof wanted.meet !== "boolean" || !Array.isArray(wanted.guests)) {
    throw new Error("欄 form に eventId、account、calendarId、title、allDay、start、end、guests、meet がそろっていません");
  }
  const description = fields.description;
  if (wanted.eventId === "") {
    openForm({ title: wanted.title, ...whenOf(wanted.allDay, wanted.start, wanted.end), guests: wanted.guests.map(String), meet: wanted.meet, description: description ?? "" }, null, { account: wanted.account, id: wanted.calendarId });
    return;
  }
  const target = eventTarget(wanted.account, wanted.calendarId, wanted.eventId);
  if (!target) throw new Error("その予定は、今カレンダーに出ている週にありません。予定のある週を出してから、もう一度試してください");
  openEdit(target.info, target.color, target.node, { ...wanted, guests: wanted.guests.map(String) }, description);
}

// The form of C-5 and C-7: `edit` is null for a new event, else the event to rewrite.
function openForm(init: Initial, edit: Editing | null, calendar: { account: string; id: string } | null = null) {
  closeDetail();
  closeCreate();

  const pop = tag("div", "pop cal-pop cal-create");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", edit ? "予定を編集" : "新しい予定");
  pop.tabIndex = -1;

  const title = tag("input", "cal-create-title");
  title.type = "text";
  title.value = init.title;
  title.placeholder = "タイトルを追加";
  title.setAttribute("aria-label", "タイトル");
  title.autocomplete = "off";
  const close = tag("button", "icon-btn");
  close.type = "button";
  close.innerHTML = CLOSE_SVG;
  close.setAttribute("aria-label", "閉じる");
  close.onclick = () => closeCreate();
  const dot = tag("span", "cal-pop-dot");
  const titleBox = tag("div", "cal-pop-title");
  titleBox.append(title);
  const head = tag("div", "cal-pop-head");
  head.append(dot, titleBox, close);

  const startDate = dateField("開始日", init.startDate);
  const startTime = timeField("開始時刻", init.startTime);
  const endDate = dateField("終了日", init.endDate);
  const endTime = timeField("終了時刻", init.endTime);
  const allDayBox = document.createElement("input");
  allDayBox.type = "checkbox";
  allDayBox.checked = init.allDay;
  const allDayLabel = tag("label", "cal-create-allday");
  allDayLabel.append(allDayBox, "終日");
  const startLine = tag("div", "cal-create-when");
  startLine.append(startDate, startTime);
  const endLine = tag("div", "cal-create-when");
  endLine.append(endDate, endTime);
  const when = tag("div", "cal-create-col");
  when.append(startLine, endLine, allDayLabel);

  // The guests: an address typed and ended with Enter, a comma or leaving the field becomes a chip (as the recipients of a mail do), and Rust checks the addresses when the event is saved.
  const guests = [...init.guests];
  const guestInput = tag("input", "");
  guestInput.type = "text";
  guestInput.placeholder = "ゲストを追加";
  guestInput.setAttribute("aria-label", "ゲスト");
  guestInput.autocomplete = "off";
  const guestField = tag("div", "cal-create-guests");
  guestField.append(guestInput);
  const drawGuests = () => {
    for (const chip of guestField.querySelectorAll(".mail-reply-chip")) chip.remove();
    for (const [i, address] of guests.entries()) {
      const chip = tag("span", "mail-reply-chip");
      chip.title = address;
      const remove = tag("button", "mail-reply-chip-x", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `${address} を外す`);
      remove.onclick = () => {
        guests.splice(i, 1);
        drawGuests();
      };
      chip.append(tag("span", "", address), remove);
      guestField.insertBefore(chip, guestInput);
    }
  };
  const commitGuest = () => {
    const text = guestInput.value.replace(/[,;]+$/, "").trim();
    guestInput.value = "";
    if (!text || guests.some((g) => g.toLowerCase() === text.toLowerCase())) return;
    guests.push(text);
    drawGuests();
  };
  guestInput.onkeydown = (e) => {
    if (e.key === "Enter" && !composing(e)) {
      e.preventDefault();
      commitGuest();
    }
  };
  // A comma ends the address whichever way it came into the field (typed, pasted or inserted by an input method), so it is read from the text, not from the key.
  guestInput.oninput = (e) => {
    if (!(e as InputEvent).isComposing && guestInput.value.endsWith(",")) commitGuest();
  };
  guestInput.onblur = commitGuest;

  // The Meet is a button until it is pressed, then a card that takes it off again; its URL is made when the event is saved.
  let meet = init.meet;
  const meetBox = tag("div", "cal-create-meet");
  const drawMeet = (focus: boolean) => {
    if (meet) {
      const card = tag("div", "cal-create-card");
      const remove = tag("button", "icon-btn");
      remove.type = "button";
      remove.innerHTML = CLOSE_SVG;
      remove.setAttribute("aria-label", "Meet を外す");
      remove.onclick = () => {
        meet = false;
        drawMeet(true);
      };
      card.append(tag("span", "", "Google Meet"), remove);
      meetBox.replaceChildren(card);
      if (focus) remove.focus({ preventScroll: true });
    } else {
      const add = tag("button", "text-btn cal-create-meet-add", "Google Meet のビデオ会議を追加");
      add.type = "button";
      add.onclick = () => {
        meet = true;
        drawMeet(true);
      };
      meetBox.replaceChildren(add);
      if (focus) add.focus({ preventScroll: true });
    }
  };
  drawMeet(false);

  const description = tag("textarea", "cal-create-desc");
  description.placeholder = "説明を追加";
  description.setAttribute("aria-label", "説明");
  description.value = init.description;
  description.rows = 3;

  // The calendars arrive after the form is open (the first time); "保存" waits for them.
  let choices: Choice[] = [];
  const select = tag("select", "cal-create-calendar");
  select.setAttribute("aria-label", "カレンダー");
  select.disabled = true;
  const chosen = () => choices[select.selectedIndex] as Choice | undefined;
  const color = () => {
    if (edit) return edit.color;
    const c = chosen();
    return c ? colorOf(c) : "var(--accent)";
  };
  const paint = () => {
    pop.style.setProperty("--c", color());
    drawDraft();
  };

  const error = tag("div", "cal-create-error");
  error.setAttribute("role", "alert");
  const save = tag("button", "text-btn primary", "保存");
  save.type = "button";
  save.disabled = true;
  const foot = tag("div", "cal-pop-foot");
  foot.append(error, save);

  pop.append(
    head,
    row(CLOCK_SVG, when),
    row(PEOPLE_SVG, guestField),
    row(MEET_SVG, meetBox),
    row(LINES_SVG, description),
    row(DATE_SVG, select),
    foot,
  );

  const fields = (): Fields => ({
    title: title.value,
    allDay: allDayBox.checked,
    startDate: startDate.value,
    startTime: startTime.value,
    endDate: endDate.value,
    endTime: endTime.value,
    color: color(),
  });
  const here = { pop, fields, edit };
  open = here;

  // The end follows the start by the same length (as a calendar does), unless the start is not a complete date and time.
  const startAt = () => moment(startDate.value, allDayBox.checked ? "00:00" : startTime.value);
  const endAt = () => moment(endDate.value, allDayBox.checked ? "00:00" : endTime.value);
  let span = 0;
  const syncAllDay = () => {
    startTime.hidden = endTime.hidden = allDayBox.checked;
    span = Math.max(endAt().getTime() - startAt().getTime(), 0);
  };
  const startChanged = () => {
    const at = startAt();
    if (!Number.isNaN(at.getTime())) {
      const next = new Date(at.getTime() + span);
      endDate.value = isoDate(next);
      endTime.value = clock(next);
    }
    drawDraft();
  };
  const endChanged = () => {
    const length = endAt().getTime() - startAt().getTime();
    if (!Number.isNaN(length)) span = Math.max(length, 0);
    drawDraft();
  };
  startDate.oninput = startTime.oninput = startChanged;
  endDate.oninput = endTime.oninput = endChanged;
  allDayBox.onchange = () => {
    syncAllDay();
    drawDraft();
  };
  title.oninput = drawDraft;
  select.onchange = paint;
  syncAllDay();

  let saving = false;
  const source = edit ? "calendar-edit" : "calendar-create";
  const showError = (text: string) => error.replaceChildren(text);
  save.onclick = async () => {
    commitGuest();
    // The calendar of an edit is the event's own.
    const c = edit ? { account: edit.info.account, id: edit.info.calendarId } : chosen();
    if (saving || !c) return;
    const f = fields();
    const event: NewEvent = {
      account: c.account,
      calendarId: c.id,
      title: f.title,
      allDay: f.allDay,
      start: f.allDay ? f.startDate : rfc3339(f.startDate, f.startTime),
      end: f.allDay ? f.endDate : rfc3339(f.endDate, f.endTime),
      guests: [...guests],
      meet,
      description: description.value,
    };
    saving = true;
    save.disabled = true;
    error.replaceChildren();
    try {
      const saved = edit
        ? await invoke("calendar_update_event", { event: { ...event, eventId: edit.info.eventId } })
        : await invoke("calendar_create_event", { event });
      if (saved === null) {
        // The account has not granted the permission to create or change events yet: log in again, as the week asks for it.
        const text = `${c.account} は予定を${edit ? "書き換える" : "作る"}ため再ログインが必要です`;
        // A form closed meanwhile has no place for it, so it goes to a card.
        if (open === here) error.replaceChildren(reloginLine(c.account, text));
        else showFailure(source, text);
        return;
      }
      if (open === here) closeCreate();
      onChanged();
    } catch (e) {
      // What was written stays. A form closed meanwhile has no place for the error, so it goes to a card.
      if (open === here) showError(String(e));
      else showFailure(source, e);
    } finally {
      saving = false;
      save.disabled = !edit && chosen() === undefined;
    }
  };

  pop.style.setProperty("--c", color());
  drawGuests();
  if (edit) {
    // The calendar is shown and cannot be changed, so no list is read.
    select.replaceChildren(new Option([edit.info.calendar || edit.info.calendarId, edit.info.account].filter(Boolean).join(" ・ ")));
    save.disabled = false;
    edit.node.classList.add("selected");
    place(pop, edit.node);
    title.focus({ preventScroll: true });
    return;
  }
  drawDraft();
  // A date outside the week has no draft to stand beside.
  if (!pop.isConnected) document.body.append(pop);
  title.focus({ preventScroll: true });

  readOwned().then(
    ({ list, needsLogin, failed }) => {
      if (open !== here) return;
      if (list.length === 0) {
        // No calendar to save in: say why, as the week does for its accounts.
        error.replaceChildren(
          ...needsLogin.map((a) => reloginLine(a, `${a} はカレンダーを読むため再ログインが必要です`)),
          ...Object.entries(failed).map(([a, message]) => tag("div", "", `${a} のカレンダーの読み込みに失敗しました: ${message}`)),
        );
        return;
      }
      // The calendar that Claude named; one that is not in the list leaves the form with no place to save.
      const named = calendar ? list.find((c) => c.account === calendar.account && c.id === calendar.id) : undefined;
      if (calendar && !named) {
        showError("指定されたカレンダーには予定を作れません");
        return;
      }
      choices = list;
      const multiple = new Set(list.map((c) => c.account)).size > 1;
      select.replaceChildren(...list.map((c) => new Option(multiple ? `${c.name}（${c.account}）` : c.name)));
      select.selectedIndex = list.indexOf(named ?? defaultChoice(list));
      select.disabled = false;
      save.disabled = saving;
      paint();
    },
    (e) => {
      if (open === here) showError(String(e));
    },
  );
}

export function initCalendarCreate(changed: () => void) {
  onChanged = changed;
  // A press elsewhere closes it; the draft is part of it, and a press on an event or a chip is the detail's, which closes it too.
  document.addEventListener("pointerdown", (e) => {
    if (open && !(e.target as Element).closest(".cal-create, .cal-draft")) closeCreate();
  });
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape" && !composing(e)) closeCreate();
  });
  // The draft (or the event, for an edit) is already in the week, so the popover is only put beside it again; the draft is drawn again by a change of the form and by the week's draw.
  const follow = () => {
    const anchor = open?.edit ? open.edit.node : document.querySelector<HTMLElement>(".cal-draft");
    if (open && anchor) place(open.pop, anchor);
  };
  $("cal-scroll").addEventListener("scroll", follow);
  window.addEventListener("resize", follow);
}
