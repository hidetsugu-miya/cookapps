// C-6 (#1063): the candidates of free time that Claude Code draws on the week with `calendar_show_slots` (tsunagiai-mcp, through the target "calendar-slots" of ts/screen-bridge.ts).
// A candidate is a dashed red frame at its day and time, with its number and its times at the top left, and the bar holds a chip with their number and a ✕. The candidates are kept in memory only: nothing is saved.
// The frames are drawn with the week (calendar.ts calls `drawSlots` at each draw, which drops them), and one that falls outside the shown week is drawn when the week it is in is shown.
import { $, tag } from "./dom.js";
import { addDays } from "./format.js";
import type { Fields } from "./screen-bridge.js";

// Keep in step with MAX_SLOTS in calendar.rs.
const MAX_SLOTS = 8;
export const slotNames = Array.from({ length: MAX_SLOTS }, (_, i) => `slot${i + 1}`);

// A candidate as Rust gives it: "YYYY-MM-DDTHH:MM/YYYY-MM-DDTHH:MM", ending after it starts and on the same day.
const SHAPE = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)\/(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)$/;

interface Slot {
  date: string;
  start: number;
  end: number;
  // The times for the label, "10:00–12:00", and the field's text as it was given.
  text: string;
  value: string;
}

function parse(text: string): Slot | null {
  const m = SHAPE.exec(text);
  if (!m) return null;
  const [h1, m1, h2, m2] = [m[2], m[3], m[5], m[6]].map(Number);
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59 || m[1] !== m[4] || end <= start) return null;
  return { date: m[1], start, end, text: `${m[2]}:${m[3]}–${m[5]}:${m[6]}`, value: text };
}

let slots: Slot[] = [];
// The first day of the week drawn now.
let shownWeek = "";

// The days from the first day of the shown week to `date`.
const dayOf = (date: string) => Math.round((addDays(date, 0).getTime() - addDays(shownWeek, 0).getTime()) / 86400000);

// Draws the frames in the columns of the shown week, and the chip: called with the week's draw (`weekStart`), and after the candidates change.
export function drawSlots(weekStart = shownWeek) {
  shownWeek = weekStart;
  for (const n of document.querySelectorAll(".cal-slot")) n.remove();
  $("cal-slots-chip").hidden = slots.length === 0;
  $("cal-slots-count").textContent = `候補 ${slots.length} 件`;
  if (!shownWeek) return;
  slots.forEach((s, i) => {
    const day = dayOf(s.date);
    const column = day >= 0 && day <= 6 ? $("cal-body").children[day + 1] : undefined;
    if (!column) return;
    const box = tag("div", "cal-slot");
    box.style.setProperty("--s", String(s.start));
    box.style.setProperty("--d", String(s.end - s.start));
    box.append(tag("div", "cal-slot-label", `候補${i + 1} ${s.text}`));
    column.append(box);
  });
}

// The fields of the target: slot1 to slot{n}, each "start/end".
export const readSlots = (): Fields => Object.fromEntries(slots.map((s, i) => [`slot${i + 1}`, s.value]));

// Replaces the candidates by the named fields, in the order of their numbers; one that is not a candidate refuses the write and leaves the old ones.
export function writeSlots(fields: Fields) {
  const named = Object.keys(fields).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  const next = named.map((name) => {
    const slot = parse(fields[name]);
    if (!slot) throw new Error(`欄 ${name} は「YYYY-MM-DDTHH:MM/YYYY-MM-DDTHH:MM」の形で、終了が開始より後の同じ日にしてください`);
    return slot;
  });
  slots = next;
  drawSlots();
}

export function clearSlots() {
  if (slots.length === 0) return;
  slots = [];
  drawSlots();
}
