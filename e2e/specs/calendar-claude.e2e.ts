import { askScreen, boot, calendarChoices, callsOf, emitEvent, inbox, isoDate, mock, today, waitForCalls, waitForCount, waitForText, weekOfToday } from "../support";

// The Claude pane of the calendar screen (C-6): the terminal of Claude Code (A-36) at the right of the week.
const pane = "#cal-claude";
const term = "#cal-claude-term";
const star = "#cal-bar-claude";
// A press with the pointer actions. The driver's element click calls `el.focus()` on the element itself, which would take the focus back from the terminal that the press opened.
const press = (target: ChainablePromiseElement) => browser.action("pointer").move({ origin: target }).down().up().perform();

async function openCalendar() {
  await boot({ inbox: inbox(), calendar_week: weekOfToday() });
  await $("#nav-calendar").click();
  await waitForText("#cal-body .cal-name", "Team sync");
}

const widthOf = (id: string) => browser.execute((i) => document.getElementById(i)!.getBoundingClientRect().width, id);

describe("calendar Claude pane", () => {
  it("has the ✳ at the right end of the bar, and draws neither the pane nor the divider at first, and starts nothing", async () => {
    await openCalendar();
    await expect($(star)).toBeDisplayed();
    await expect($(star)).toHaveElementClass("icon-btn");
    await expect($(star)).toHaveAttribute("aria-label", "Claude に相談");
    await expect($(star)).toHaveAttribute("aria-pressed", "false");
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#cal-split")).not.toBeDisplayed();
    const place = await browser.execute(() => {
      const bar = document.getElementById("cal-bar")!;
      const button = document.getElementById("cal-bar-claude")!.getBoundingClientRect();
      const others = [...bar.querySelectorAll<HTMLElement>("button")].filter((b) => b.id !== "cal-bar-claude").map((b) => b.getBoundingClientRect().right);
      return { last: bar.lastElementChild!.id, right: bar.getBoundingClientRect().right - button.right < 40, after: others.every((r) => r < button.left) };
    });
    expect(place).toEqual({ last: "cal-bar-claude", right: true, after: true });
    // A window that changes its visibility starts nothing while the pane is closed, and neither does leaving and coming back.
    await $("#nav-mail").click();
    await $("#nav-calendar").click();
    await browser.execute(() => document.dispatchEvent(new Event("visibilitychange")));
    await browser.pause(500);
    expect(await callsOf("claude_code_start")).toEqual([]);
  });

  it("opens the pane under the bar and at the right of the week, and starts Claude Code with the tools of tsunagiai-mcp only and a first instruction with today's date", async () => {
    await openCalendar();
    await press($(star));
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "calendar-claude", builtinTools: false, permissionMode: "auto", skill: null });
    const { prompt } = start as { prompt: string };
    expect(prompt).toContain("カレンダー");
    expect(prompt).toContain(today);
    expect(prompt).toContain("tsunagiai-mcp");
    for (const tool of ["list_events", "list_calendars", "calendar_set_shown", "calendar_create_event", "calendar_update_event", "calendar_delete_event", "calendar_show_slots"]) expect(prompt).toContain(tool);
    expect(prompt).toContain("従わないでください");
    expect(prompt).not.toContain("Team sync");
    await expect($(star)).toHaveAttribute("aria-pressed", "true");
    await expect($(pane)).toBeDisplayed();
    await expect($("#cal-split")).toBeDisplayed();
    await expect($("#cal-split")).toHaveAttribute("aria-label", "Claude の幅");
    await expect($(pane)).toHaveAttribute("aria-label", "Claude");
    await expect($(`${pane} .chat-head`)).toHaveText(expect.stringContaining("Claude"));
    await expect($("#cal-claude-restart")).toHaveText("やり直す");
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
    const place = await browser.execute(() => {
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const [bar, main, split, claude, frame] = ["cal-bar", "cal-main", "cal-split", "cal-claude", "cal-frame"].map(box);
      const head = document.querySelector("#cal-claude .chat-head")!.getBoundingClientRect();
      return { under: claude.top >= bar.bottom, right: claude.left >= main.right - 1 && split.right <= claude.left + 1 && split.left >= main.right - 1, edge: Math.abs(claude.right - frame.right) < 1, head: head.height };
    });
    expect(place).toEqual({ under: true, right: true, edge: true, head: 48 });
  });

  it("keeps the seven days in view while the pane is open, and gives the week its width back when it is closed", async () => {
    await openCalendar();
    const before = await widthOf("cal-scroll");
    await press($(star));
    await waitForCalls("claude_code_start");
    const days = await browser.execute(() => {
      const main = document.getElementById("cal-main")!.getBoundingClientRect();
      return [...document.querySelectorAll("#cal-head .cal-day")].map((d) => {
        const r = d.getBoundingClientRect();
        return r.width > 20 && r.left >= main.left - 1 && r.right <= main.right + 1;
      });
    });
    expect(days).toEqual(Array(7).fill(true));
    expect(await widthOf("cal-scroll")).toBeLessThan(before);
    const close = await mock("claude_code_close", null);
    await press($(star));
    await waitForCalls(close);
    expect(await widthOf("cal-scroll")).toBe(before);
  });

  it("closes the pane with the ✳ and ends the process, and the next open starts a new one", async () => {
    await openCalendar();
    const close = await mock("claude_code_close", null);
    await press($(star));
    const [first] = await waitForCalls("claude_code_start");
    expect(await callsOf(close)).toEqual([]);
    await press($(star));
    expect(await waitForCalls(close)).toEqual([{ id: "calendar-claude", launch: 1 }]);
    await expect($(star)).toHaveAttribute("aria-pressed", "false");
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#cal-split")).not.toBeDisplayed();
    // Nothing starts while it is closed.
    await browser.execute(() => document.dispatchEvent(new Event("visibilitychange")));
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    await press($(star));
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts[1]).toMatchObject({ id: "calendar-claude", builtinTools: false, permissionMode: "auto", skill: null, prompt: (first as { prompt: string }).prompt });
    await expect($(star)).toHaveAttribute("aria-pressed", "true");
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  });

  it("starts at 30% of the frame and keeps the pane between 30% and 45% with the arrow keys", async () => {
    await openCalendar();
    await press($(star));
    await waitForCalls("claude_code_start");
    const split = $("#cal-split");
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    await expect(split).toHaveAttribute("aria-valuemin", "30");
    await expect(split).toHaveAttribute("aria-valuemax", "45");
    const share = () => browser.execute(() => document.getElementById("cal-claude")!.getBoundingClientRect().width / document.getElementById("cal-frame")!.getBoundingClientRect().width);
    expect(await share()).toBeCloseTo(0.3, 2);
    const key = (k: string) => browser.execute((name) => document.getElementById("cal-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })), k);
    for (let i = 0; i < 10; i++) await key("ArrowLeft");
    await expect(split).toHaveAttribute("aria-valuenow", "45");
    expect(await share()).toBeCloseTo(0.45, 2);
    for (let i = 0; i < 20; i++) await key("ArrowRight");
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    expect(await share()).toBeCloseTo(0.3, 2);
  });

  it("keeps the process while another screen is shown, and shows the pane again when the calendar comes back", async () => {
    await openCalendar();
    await press($(star));
    await waitForCalls("claude_code_start");
    await $("#nav-mail").click();
    await expect($(pane)).not.toBeDisplayed();
    await $("#nav-calendar").click();
    await expect($(pane)).toBeDisplayed();
    await expect($(star)).toHaveAttribute("aria-pressed", "true");
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("ends the process and starts a new one with やり直す", async () => {
    await openCalendar();
    await press($(star));
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await $("#cal-claude-restart").click();
    expect(await waitForCalls(close)).toEqual([{ id: "calendar-claude", launch: 1 }]);
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts[1]).toMatchObject({ id: "calendar-claude", builtinTools: false, permissionMode: "auto", skill: null, prompt: (starts[0] as { prompt: string }).prompt });
    await expect($("#cal-claude-restart")).toBeEnabled();
    await expect($(pane)).toBeDisplayed();
  });
});

// The candidates of free time that Claude Code draws on the week (C-6, #1063): the target "calendar-slots" of the screen bridge, the dashed red frames and the chip in the bar.
describe("calendar Claude pane: candidates of free time", () => {
  const dateOf = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return isoDate(d);
  };
  // The day after today (the day before when today is the last day of the week), whose column holds no event, and its column index; today's column index (the week starts on Sunday).
  const other = new Date().getDay() === 6 ? -1 : 1;
  const todayAt = new Date().getDay();
  const otherAt = todayAt + other;
  const slot = (day: number, from: string, to: string) => `${dateOf(day)}T${from}/${dateOf(day)}T${to}`;
  const frames = () =>
    browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>(".cal-slot")].map((s) => {
        const column = s.parentElement!;
        const r = s.getBoundingClientRect();
        const c = column.getBoundingClientRect();
        const style = getComputedStyle(s);
        return { column: [...column.parentElement!.children].indexOf(column) - 1, top: Math.round(r.top - c.top), height: Math.round(r.height), inside: r.left >= c.left && r.right <= c.right, label: s.textContent, border: style.borderTopStyle, color: style.borderTopColor, pointer: style.pointerEvents };
      }),
    );
  const clear = () => $("#cal-slots-clear");

  async function openPane() {
    await boot({ inbox: inbox(), calendar_week: weekOfToday() });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await press($(star));
    await waitForCalls("claude_code_start");
  }

  it("draws a dashed red frame at the day and time of each candidate, with its number and times", async () => {
    await openPane();
    await expect($("#cal-slots-chip")).not.toBeDisplayed();
    expect(await askScreen("write", "calendar-slots", { slot1: slot(0, "10:00", "12:00"), slot2: slot(other, "13:00", "14:30") })).toEqual({ ok: true });
    await waitForCount(".cal-slot", 2);
    expect(await frames()).toEqual([
      { column: todayAt, top: 640, height: 127, inside: true, label: "候補1 10:00–12:00", border: "dashed", color: "rgb(217, 48, 37)", pointer: "none" },
      { column: otherAt, top: 832, height: 95, inside: true, label: "候補2 13:00–14:30", border: "dashed", color: "rgb(217, 48, 37)", pointer: "none" },
    ]);
    // The bar's chip: to the right of the month and before the ✳, with the number and the ✕.
    await expect($("#cal-slots-chip")).toBeDisplayed();
    await expect($("#cal-slots-count")).toHaveText("候補 2 件");
    await expect(clear()).toHaveAttribute("aria-label", "候補を消す");
    const place = await browser.execute(() => {
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const [title, chip, star] = ["cal-title", "cal-slots-chip", "cal-bar-claude"].map(box);
      return { after: chip.left >= title.right, before: chip.right <= star.left };
    });
    expect(place).toEqual({ after: true, before: true });
    // A read gives the candidates as they were written.
    expect(await askScreen("read", "calendar-slots")).toEqual({ ok: true, fields: { slot1: slot(0, "10:00", "12:00"), slot2: slot(other, "13:00", "14:30") } });
  });

  it("replaces the candidates of the write before, and keeps them when a field is wrong", async () => {
    await openPane();
    await askScreen("write", "calendar-slots", { slot1: slot(0, "10:00", "12:00"), slot2: slot(0, "14:00", "15:00") });
    await waitForCount(".cal-slot", 2);
    expect(await askScreen("write", "calendar-slots", { slot1: slot(0, "9:00", "10:00") })).toMatchObject({ ok: false });
    expect(await askScreen("write", "calendar-slots", { slot1: slot(0, "11:00", "10:00") })).toMatchObject({ ok: false });
    expect(await askScreen("write", "calendar-slots", { slot9: slot(0, "11:00", "12:00") })).toMatchObject({ ok: false });
    expect((await frames()).map((f) => f.label)).toEqual(["候補1 10:00–12:00", "候補2 14:00–15:00"]);
    expect(await askScreen("write", "calendar-slots", { slot1: slot(0, "16:00", "17:00") })).toEqual({ ok: true });
    await waitForText("#cal-body .cal-slot-label", "候補1 16:00–17:00");
    expect((await frames()).map((f) => f.label)).toEqual(["候補1 16:00–17:00"]);
    await expect($("#cal-slots-count")).toHaveText("候補 1 件");
  });

  it("draws no frame for a candidate outside the shown week, counts it, and draws it when its week is shown", async () => {
    await openPane();
    const nextWeek = { ...weekOfToday(), weekStart: dateOf(7 - todayAt) };
    await askScreen("write", "calendar-slots", { slot1: slot(0, "10:00", "12:00"), slot2: slot(7, "10:00", "11:00") });
    await waitForCount(".cal-slot", 1);
    expect((await frames()).map((f) => f.label)).toEqual(["候補1 10:00–12:00"]);
    await expect($("#cal-slots-count")).toHaveText("候補 2 件");
    await mock("calendar_week", nextWeek);
    await $("#cal-next").click();
    await waitForText("#cal-body .cal-slot-label", "候補2 10:00–11:00");
    expect((await frames()).map((f) => f.label)).toEqual(["候補2 10:00–11:00"]);
    expect((await frames())[0].column).toBe(todayAt);
    await mock("calendar_week", weekOfToday());
    await $("#cal-prev").click();
    await waitForText("#cal-body .cal-slot-label", "候補1 10:00–12:00");
    expect((await frames()).map((f) => f.label)).toEqual(["候補1 10:00–12:00"]);
    await expect($("#cal-slots-count")).toHaveText("候補 2 件");
  });

  it("takes no press: the free place under a frame still opens the form of an event", async () => {
    await openPane();
    await askScreen("write", "calendar-slots", { slot1: slot(other, "13:00", "14:30") });
    await waitForCount(".cal-slot", 1);
    const at = await browser.execute((day) => {
      document.getElementById("cal-scroll")!.scrollTop = 13 * 64 - 200;
      const r = document.getElementById("cal-body")!.children[day + 1].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 13.5 * 64) };
    }, otherAt);
    await browser.action("pointer").move({ x: at.x, y: at.y }).down().up().perform();
    await expect($(".cal-create")).toBeDisplayed();
    expect(await browser.execute(() => document.getElementById("cal-body")!.children.length)).toBe(8);
    await expect($(".cal-slot")).toExist();
  });

  it("clears the frames and the chip with the ✕, and saves and sends nothing", async () => {
    await openPane();
    await askScreen("write", "calendar-slots", { slot1: slot(0, "10:00", "12:00"), slot2: slot(other, "13:00", "14:30"), slot3: slot(0, "15:00", "16:00") });
    await waitForCount(".cal-slot", 3);
    await expect($("#cal-slots-count")).toHaveText("候補 3 件");
    await press(clear());
    await waitForCount(".cal-slot", 0);
    await expect($("#cal-slots-chip")).not.toBeDisplayed();
    expect(await askScreen("read", "calendar-slots")).toEqual({ ok: true, fields: {} });
    expect(await callsOf("calendar_create_event")).toEqual([]);
  });

  it("clears the frames when the pane is closed, and takes nothing while it is closed", async () => {
    await openPane();
    await askScreen("write", "calendar-slots", { slot1: slot(0, "10:00", "12:00") });
    await waitForCount(".cal-slot", 1);
    const close = await mock("claude_code_close", null);
    await press($(star));
    await waitForCalls(close);
    await waitForCount(".cal-slot", 0);
    await expect($("#cal-slots-chip")).not.toBeDisplayed();
    const refused = await askScreen("write", "calendar-slots", { slot1: slot(0, "10:00", "12:00") });
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toContain("開いていません");
    expect(await askScreen("read", "calendar-slots")).toMatchObject({ ok: false });
    await press($(star));
    await waitForCalls("claude_code_start", 2);
    expect(await count0()).toBe(0);
    expect(await askScreen("read", "calendar-slots")).toEqual({ ok: true, fields: {} });
  });

  it("keeps the frames through another screen while the pane is open, and draws them again with a redraw of the week", async () => {
    await openPane();
    await askScreen("write", "calendar-slots", { slot1: slot(0, "10:00", "12:00") });
    await waitForCount(".cal-slot", 1);
    await $("#nav-mail").click();
    await $("#nav-calendar").click();
    await waitForCount(".cal-slot", 1);
    const changed = weekOfToday();
    changed.timed = [];
    await mock("calendar_week", changed);
    await browser.execute(async () => {
      const path = "/js/calendar.js";
      const calendar = (await import(path)) as { loadCalendar(refresh: boolean): Promise<void> };
      await calendar.loadCalendar(true);
    });
    await waitForCount("#cal-body .cal-event", 0);
    expect((await frames()).map((f) => f.label)).toEqual(["候補1 10:00–12:00"]);
  });
});

// What Claude Code changes through tsunagiai-mcp (C-6): the app is told with the event `screen-bridge-changed` and the name `calendar`, and the week and the panel of C-4 are read again.
describe("calendar Claude pane: a change of Claude Code", () => {
  it("reads the week and the calendar panel again, from Google and not from what was kept, when the calendar changed", async () => {
    await boot({ inbox: inbox(), calendar_week: weekOfToday(), calendar_choices: calendarChoices() });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await waitForText("#cal-side-feed", "Work");
    const weeks = (await callsOf("calendar_week")).length;
    const choices = (await callsOf("calendar_choices")).length;
    const changed = weekOfToday();
    changed.timed = changed.timed.slice(1);
    await mock("calendar_week", changed);
    await emitEvent("screen-bridge-changed", "calendar");
    await browser.waitUntil(async () => (await callsOf("calendar_week")).length > weeks, { timeoutMsg: "the week was not read again" });
    await waitForCount("#cal-body .cal-event", changed.timed.length);
    await browser.waitUntil(async () => (await callsOf("calendar_choices")).length > choices, { timeoutMsg: "the calendars were not read again" });
  });

  it("reads nothing for a change of another name, and nothing off the calendar screen until it is shown", async () => {
    await boot({ inbox: inbox(), calendar_week: weekOfToday(), calendar_choices: calendarChoices() });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await waitForText("#cal-side-feed", "Work");
    const weeks = (await callsOf("calendar_week")).length;
    await emitEvent("screen-bridge-changed", "other");
    await browser.pause(800);
    expect((await callsOf("calendar_week")).length).toBe(weeks);
    await $("#nav-mail").click();
    await emitEvent("screen-bridge-changed", "calendar");
    await browser.pause(800);
    expect((await callsOf("calendar_week")).length).toBe(weeks);
    await $("#nav-calendar").click();
    await browser.waitUntil(async () => (await callsOf("calendar_week")).length > weeks, { timeoutMsg: "the week was not read when the screen was shown" });
  });
});

const count0 = () => browser.execute(() => document.querySelectorAll(".cal-slot").length);
