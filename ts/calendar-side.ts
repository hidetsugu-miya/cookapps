// C-4: the panel at the left of the calendar's week, where the calendars to show are chosen, grouped by account.
import type { CalendarChoice } from "./bindings/CalendarChoice";
import type { CalendarChoices } from "./bindings/CalendarChoices";
import { closeDetail } from "./calendar-detail.js";
import { $, el, tag } from "./dom.js";
import { avatarColor, initials } from "./format.js";
import { CHEVRON_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { drawListToggle, listToggle } from "./list-toggle.js";
import { showFailure } from "./error-card.js";

// The calendars as last read, and whether that read is still good: a login or a removal of an account makes it stale.
let choices: CalendarChoices | null = null;
let loaded = false;
// A read that began before a change of the choice must not draw over it.
let seq = 0;
// Called after a choice is saved, to draw the week again.
let onChanged: () => void = () => {};

// The accounts whose calendars are folded away, held in memory only.
const folded = new Set<string>();

// Whether the panel is open: what the owner chose, held in memory only, so it is open again when the app starts.
let panelOpen = true;

// Shows or hides the panel. The button that does it is in the bar over the panel and the week, so it stays where it is.
function layoutPanel() {
  $("cal-side").hidden = !panelOpen;
  drawListToggle($("cal-bar-toggle"), panelOpen);
}

// Closes the panel or opens it again; the week takes the width of a closed panel.
function togglePanel() {
  closeDetail();
  panelOpen = !panelOpen;
  layoutPanel();
}

export function initCalendarSide(changed: () => void) {
  onChanged = changed;
  const toggle = listToggle("カレンダー一覧", togglePanel);
  toggle.id = "cal-bar-toggle";
  $("cal-bar").prepend(toggle);
  layoutPanel();
}

export function forgetCalendarChoices() {
  loaded = false;
}

function item(account: string, c: CalendarChoice) {
  const label = tag("label", "cal-side-item");
  // The event's own color (its calendar's); a calendar with none takes the account's, as the events do.
  label.style.setProperty("--c", c.color || avatarColor(account));
  label.title = c.name;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = c.shown;
  box.onchange = async () => {
    const shown = box.checked;
    seq++;
    // One save at a time for this box: a second press while it runs would race the first.
    // A disabled box drops the focus, so it is given back.
    const focused = document.activeElement === box;
    box.disabled = true;
    try {
      await invoke("set_calendar_shown", { account, calendarId: c.id, shown });
      c.shown = shown;
      onChanged();
    } catch (e) {
      box.checked = !shown;
      showFailure("calendar-side", e);
    } finally {
      box.disabled = false;
      if (focused) box.focus({ preventScroll: true });
    }
  };
  label.append(box, tag("span", "cal-side-name", c.name));
  return label;
}

// The account's row, which folds its calendars away or shows them again: its avatar as the sidebar draws it (the initials and the color), the address and a chevron.
function accountRow(account: string, body: HTMLElement) {
  const row = tag("button", "cal-side-account");
  row.type = "button";
  row.setAttribute("aria-expanded", String(!folded.has(account)));
  const avatar = tag("span", "cal-side-avatar", initials(account));
  avatar.style.background = avatarColor(account);
  const chevron = tag("span", "cal-side-chevron");
  chevron.innerHTML = CHEVRON_SVG;
  row.append(avatar, tag("span", "cal-side-email", account), chevron);
  row.title = account;
  row.onclick = () => {
    const open = folded.delete(account);
    if (!open) folded.add(account);
    row.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
  };
  return row;
}

function draw() {
  const nodes: HTMLElement[] = [];
  for (const { account, calendars } of choices?.accounts ?? []) {
    const body = tag("div", "cal-side-body");
    body.hidden = folded.has(account);
    for (const [mine, title] of [[true, "マイカレンダー"], [false, "他のカレンダー"]] as const) {
      const group = calendars.filter((c) => c.mine === mine);
      if (group.length === 0) continue;
      body.append(el("cal-side-group", title), ...group.map((c) => item(account, c)));
    }
    nodes.push(accountRow(account, body), body);
  }
  $("cal-side-feed").replaceChildren(...nodes);
}

// Reads the calendars and draws them, unless they were read and nothing made them stale (`refresh` reads them anyway).
export async function loadCalendarChoices(refresh: boolean) {
  if (loaded && !refresh) return;
  const mine = ++seq;
  try {
    const read = await invoke("calendar_choices");
    if (mine !== seq) return;
    loaded = true;
    // The same calendars as drawn: leave the panel alone, so a refresh does not take the focus from a box.
    if (JSON.stringify(read) === JSON.stringify(choices)) return;
    choices = read;
    draw();
  } catch {
    // The panel keeps what it showed; the week reports a failure of the accounts.
  }
}
