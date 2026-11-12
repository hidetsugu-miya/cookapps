// C-4: the panel at the left of the calendar's week, where the calendars to show are chosen, grouped by account.
import type { CalendarChoice } from "./bindings/CalendarChoice";
import type { CalendarChoices } from "./bindings/CalendarChoices";
import { $, el, tag } from "./dom.js";
import { avatarColor } from "./format.js";
import { invoke } from "./ipc.js";
import { showError } from "./view.js";

// The calendars as last read, and whether that read is still good: a login or a removal of an account makes it stale.
let choices: CalendarChoices | null = null;
let loaded = false;
// A read that began before a change of the choice must not draw over it.
let seq = 0;
// Called after a choice is saved, to draw the week again.
let onChanged: () => void = () => {};

export function initCalendarSide(changed: () => void) {
  onChanged = changed;
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
    try {
      await invoke("set_calendar_shown", { account, calendarId: c.id, shown });
      c.shown = shown;
      onChanged();
    } catch (e) {
      box.checked = !shown;
      showError(e);
    }
  };
  label.append(box, tag("span", "cal-side-name", c.name));
  return label;
}

function draw() {
  const nodes: HTMLElement[] = [];
  for (const { account, calendars } of choices?.accounts ?? []) {
    nodes.push(el("cal-side-account", account));
    for (const [mine, title] of [[true, "マイカレンダー"], [false, "他のカレンダー"]] as const) {
      const group = calendars.filter((c) => c.mine === mine);
      if (group.length === 0) continue;
      nodes.push(el("cal-side-group", title), ...group.map((c) => item(account, c)));
    }
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
    choices = read;
    loaded = true;
    draw();
  } catch {
    // The panel keeps what it showed; the week reports a failure of the accounts.
  }
}
