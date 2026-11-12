import type { Week } from "../../ts/bindings/Week";
import { account, boot, calendarChoices, callsOf, copiedTexts, count, holds, inbox, meetUrl, mock, rejects, release, stubClipboard, textsOf, waitForCalls, waitForCount, waitForText, weekOfToday } from "../support";

// The button of the event (a timed box or an all-day chip) with `title`.
const eventButton = (title: string) => $(`//button[contains(@class, "cal-event") or contains(@class, "cal-chip")][contains(., "${title}")]`);

// The calendar open on the week of today.
async function openCalendar() {
  await boot({ inbox: inbox(), calendar_week: weekOfToday() });
  await $("#nav-calendar").click();
  await waitForText("#cal-body .cal-name", "Team sync");
}

describe("calendar", () => {
  it("shows the week's events when opened from the sidebar", async () => {
    await boot({ inbox: inbox(), calendar_week: weekOfToday() });
    // The calendar button is enabled once the inbox has an account.
    await expect($("#nav-calendar")).toBeEnabled();
    await $("#nav-calendar").click();
    await expect($("#calendar")).toBeDisplayed();
    await waitForText("#cal-body .cal-name", "Team sync");
    await expect($("#cal-body .cal-time")).toHaveText("10:00 - 11:00");
    await expect($("#cal-allday .cal-chip")).toHaveText("Holiday");
  });

  it("makes the bar above the week a place to drag the window by", async () => {
    await openCalendar();
    await expect($("#cal-bar")).toHaveAttribute("data-tauri-drag-region", "deep");
  });

  it("marks tentative and unanswered events", async () => {
    await boot({ inbox: inbox(), calendar_week: weekOfToday() });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await expect($("#cal-body .cal-event.tentative")).toHaveText(expect.stringContaining("Maybe lunch"));
    await expect($("#cal-body .cal-event.needs-action")).toHaveText(expect.stringContaining("Unanswered"));
  });

  it("asks for the week with the first day of the week, and starts the header on the day the week starts", async () => {
    await boot({ inbox: inbox(), calendar_first_day: 1, calendar_week: weekOfToday(1) });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    const calls = (await waitForCalls("calendar_week")) as { firstDay: number }[];
    expect(calls.every((c) => c.firstDay === 1)).toBe(true);
    await expect($("#cal-head .cal-day:nth-child(2)")).toHaveText(expect.stringContaining("月"));
    await expect($("#cal-head .cal-day:nth-child(8)")).toHaveText(expect.stringContaining("日"));
  });
});

// The checkbox of the calendar named `name` in the panel.
const choiceBox = (name: string) => $(`//label[contains(@class, "cal-side-item")][contains(., "${name}")]/input`);

describe("calendar: calendar panel", () => {
  async function openPanel() {
    await boot({ inbox: inbox(), calendar_week: weekOfToday(), calendar_choices: calendarChoices() });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await waitForText("#cal-side-feed", "Work");
  }

  it("lists the calendars under the account, as mine and others, left of the week", async () => {
    await openPanel();
    await expect($("#cal-side-head")).toHaveText("カレンダー");
    expect(await textsOf("#cal-side-feed > .cal-side-account .cal-side-email")).toEqual([account]);
    expect(await textsOf("#cal-side-feed .cal-side-body > *")).toEqual(["マイカレンダー", "Work", "他のカレンダー", "Holidays"]);
    await expect(choiceBox("Work")).toBeSelected();
    await expect(choiceBox("Holidays")).toBeSelected();
    const { side, scroll, width } = await browser.execute(() => {
      const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return { side: rect("cal-side").right, scroll: rect("cal-scroll").left, width: rect("cal-side").width };
    });
    expect(width).toBe(248);
    expect(side).toBeLessThanOrEqual(scroll);
    // The box takes the calendar's color.
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".cal-side-item input")!).accentColor)).toBe("rgb(30, 123, 82)");
  });

  it("draws the account as its avatar and address, and its calendars indented and held by a line", async () => {
    await openPanel();
    const row = $("#cal-side-feed > .cal-side-account");
    await expect(row.$(".cal-side-avatar")).toHaveText("M");
    const look = await browser.execute(() => {
      const avatar = document.querySelector(".cal-side-avatar") as HTMLElement;
      const body = document.querySelector(".cal-side-body") as HTMLElement;
      const accountRow = document.querySelector(".cal-side-account") as HTMLElement;
      return {
        // The sidebar's avatar of the same account has the same color.
        avatar: avatar.style.background,
        sidebar: (document.querySelector(`#account-list .avatar[data-account="me@example.com"]`) as HTMLElement).style.background,
        line: getComputedStyle(body).borderLeftWidth,
        indented: body.getBoundingClientRect().left > accountRow.getBoundingClientRect().left,
      };
    });
    expect(look.avatar).toBe(look.sidebar);
    expect(look).toMatchObject({ line: "1px", indented: true });
  });

  it("folds the calendars of an account away and shows them again, by the account's row", async () => {
    await openPanel();
    const row = $("#cal-side-feed > .cal-side-account");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect($(".cal-side-body")).toBeDisplayed();
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect($(".cal-side-body")).not.toBeDisplayed();
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(choiceBox("Work")).toBeDisplayed();
  });

  it("closes the panel with the button beside the heading, the week takes its width, and opens it again", async () => {
    await openPanel();
    const scrollWidth = () => browser.execute(() => document.getElementById("cal-scroll")!.getBoundingClientRect().width);
    const open = await scrollWidth();
    await expect($("#cal-side-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect($("#cal-bar-toggle")).not.toBeDisplayed();
    await $("#cal-side-toggle").click();
    await expect($("#cal-side")).not.toBeDisplayed();
    await expect($("#cal-bar-toggle")).toBeDisplayed();
    await expect($("#cal-bar-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(await scrollWidth()).toBe(open + 248);
    await $("#cal-bar-toggle").click();
    await expect($("#cal-side")).toBeDisplayed();
    await expect($("#cal-bar-toggle")).not.toBeDisplayed();
    expect(await scrollWidth()).toBe(open);
    await expect(choiceBox("Work")).toBeSelected();
  });

  it("saves the choice when a calendar is unchecked, and the week loses its events", async () => {
    await openPanel();
    await expect($("#cal-allday .cal-chip")).toHaveText("Holiday");
    const setShown = await mock("set_calendar_shown", null);
    const week = weekOfToday();
    week.allDay = [];
    await mock("calendar_week", week);
    await choiceBox("Holidays").click();
    expect(await waitForCalls(setShown)).toEqual([{ account, calendarId: "holidays", shown: false }]);
    await waitForCount("#cal-allday .cal-chip", 0);
    await expect(choiceBox("Holidays")).not.toBeSelected();
    await expect($("#cal-body .cal-name")).toHaveText("Team sync");
  });

  it("keeps the box disabled while its choice is being saved", async () => {
    await openPanel();
    const setShown = await mock("set_calendar_shown", holds);
    await choiceBox("Holidays").click();
    await waitForCalls(setShown);
    await expect(choiceBox("Holidays")).toBeDisabled();
    await release(setShown, null);
    await expect(choiceBox("Holidays")).toBeEnabled();
  });

  it("saves the choice when it is checked again", async () => {
    const choices = calendarChoices();
    choices.accounts[0].calendars[1].shown = false;
    await boot({ inbox: inbox(), calendar_week: weekOfToday(), calendar_choices: choices });
    await $("#nav-calendar").click();
    await waitForText("#cal-side-feed", "Holidays");
    await expect(choiceBox("Holidays")).not.toBeSelected();
    const setShown = await mock("set_calendar_shown", null);
    await choiceBox("Holidays").click();
    expect(await waitForCalls(setShown)).toEqual([{ account, calendarId: "holidays", shown: true }]);
  });

  it("puts the box back and shows the error when the choice cannot be saved", async () => {
    await openPanel();
    const setShown = await mock("set_calendar_shown", rejects("保存できません"));
    await choiceBox("Work").click();
    await waitForCalls(setShown);
    await waitForText("#error", "保存できません");
    await expect(choiceBox("Work")).toBeSelected();
    await expect($("#cal-allday .cal-chip")).toHaveText("Holiday");
  });
});

// The week is fetched again and answers `week`, which draws it anew if it differs from the shown one.
async function redrawWith(week: Week) {
  await mock("calendar_week", week);
  await browser.execute(async () => {
    const path = "/js/calendar.js";
    const calendar = (await import(path)) as { loadCalendar(refresh: boolean): Promise<void> };
    await calendar.loadCalendar(true);
  });
}

// A press as a mouse makes it: pointerdown, mouseup and click. WebDriver's element click only calls el.click() and then el.focus(), so it sends no pointerdown and takes the focus back.
const press = (target: ChainablePromiseElement) => browser.action("pointer").move({ origin: target }).down().up().perform();

// The title the bar shows for the week of `weekOfToday`: the year and the month of its middle day, "2026年11月".
function weekTitle(firstDay = 0) {
  const [y, m, d] = weekOfToday(firstDay).weekStart.split("-").map(Number);
  const middle = new Date(y, m - 1, d + 3);
  return `${middle.getFullYear()}年${middle.getMonth() + 1}月`;
}

// Waits until the week holding `date` ("YYYY-MM-DD") was asked for since the week was mocked again (which forgets the calls).
const weekAsked = (date: string) =>
  browser.waitUntil(async () => ((await callsOf("calendar_week")) as { date: string }[]).some((c) => c.date === date), { timeoutMsg: `the week of ${date} was not asked for` });

describe("calendar: header", () => {
  it("has today, the arrows and the month in the band of the Todo header, and the panel's heading in the same band", async () => {
    await boot({ inbox: inbox(), calendar_week: weekOfToday(), calendar_choices: calendarChoices() });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await expect($("#cal-title")).toHaveText(weekTitle());
    const bar = await browser.execute(() => {
      const left = (id: string) => document.getElementById(id)!.getBoundingClientRect().left;
      const style = (id: string) => getComputedStyle(document.getElementById(id)!);
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return {
        order: ["cal-today", "cal-prev", "cal-next", "cal-title"].sort((a, b) => left(a) - left(b)),
        background: [style("cal-bar").backgroundColor, style("cal-side-bar").backgroundColor],
        underline: [style("cal-bar").borderBottomWidth, style("cal-side-bar").borderBottomWidth],
        bottom: [box("cal-bar").bottom, box("cal-side-bar").bottom],
        soft: getComputedStyle(document.documentElement).getPropertyValue("--soft").trim(),
      };
    });
    expect(bar.order).toEqual(["cal-today", "cal-prev", "cal-next", "cal-title"]);
    expect(bar.background[0]).toBe(bar.background[1]);
    expect(bar.background[0]).not.toBe("rgba(0, 0, 0, 0)");
    expect(bar.underline).toEqual(["2px", "2px"]);
    expect(bar.bottom[0]).toBe(bar.bottom[1]);
  });

  it("still goes to the week before and after, and to today", async () => {
    await boot({ inbox: inbox(), calendar_week: weekOfToday(), calendar_choices: calendarChoices() });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await mock("calendar_week", weekOfToday());
    const day = (days: number) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    await $("#cal-next").click();
    await weekAsked(day(7));
    await $("#cal-prev").click();
    await $("#cal-prev").click();
    await weekAsked(day(-7));
    await $("#cal-today").click();
    await weekAsked(day(0));
  });
});

describe("calendar: month calendar", () => {
  async function openMonth(firstDay = 0) {
    await boot({ inbox: inbox(), calendar_first_day: firstDay, calendar_week: weekOfToday(firstDay), calendar_choices: calendarChoices() });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await waitForText("#cal-month .cal-mini-title", "年");
    await waitForCount("#cal-month .cal-mini-day.today", 1);
  }
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  // The second day of a week of the grid other than the one shown, as "YYYY-MM-DD" (the first is what the weeks around the shown one are fetched ahead by).
  const otherWeek = (host: string) =>
    browser.execute((h) => {
      const current = document.querySelector(`${h} .cal-mini-row.current`)!;
      const row = (current.nextElementSibling ?? current.previousElementSibling) as HTMLElement;
      return (row.querySelectorAll(".cal-mini-day")[1] as HTMLElement).dataset.date!;
    }, host);

  it("is above the calendars with the month of the week, the weekdays from the first day, today in a circle and the shown week tinted", async () => {
    await openMonth(1);
    await expect($("#cal-month .cal-mini-title")).toHaveText(weekTitle(1));
    expect(await textsOf("#cal-month .cal-mini-row:first-child .cal-mini-wd")).toEqual(["月", "火", "水", "木", "金", "土", "日"]);
    await expect($("#cal-month .cal-mini-day.today")).toHaveAttribute("data-date", today());
    // The row of the week shown starts on the week's first day, and holds today.
    expect(await textsOf("#cal-month .cal-mini-row.current .cal-mini-day.today")).toHaveLength(1);
    expect(await browser.execute(() => (document.querySelector("#cal-month .cal-mini-row.current .cal-mini-day") as HTMLElement).dataset.date)).toBe(weekOfToday(1).weekStart);
    expect(await count("#cal-month .cal-mini-row.current")).toBe(1);
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#cal-month .cal-mini-day.today")!).backgroundColor)).toBe("rgb(30, 123, 82)");
    // Days of the months before and after are lighter.
    expect(await browser.execute(() => Number(getComputedStyle(document.querySelector("#cal-month .cal-mini-day.other") ?? document.body).opacity))).toBeLessThan(1);
    // It is left of the calendars' list.
    expect(await browser.execute(() => document.getElementById("cal-month")!.getBoundingClientRect().bottom <= document.getElementById("cal-side-feed")!.getBoundingClientRect().top)).toBe(true);
  });

  it("moves the month with the arrows, and shows the week of a pressed day", async () => {
    await openMonth();
    await mock("calendar_week", weekOfToday());
    const title = await $("#cal-month .cal-mini-title").getText();
    await $('#cal-month button[aria-label="次の月"]').click();
    await browser.waitUntil(async () => (await $("#cal-month .cal-mini-title").getText()) !== title);
    // The week drawn is of the old month, and the title of the bar stays.
    await expect($("#cal-title")).toHaveText(weekTitle());
    await $('#cal-month button[aria-label="前の月"]').click();
    await expect($("#cal-month .cal-mini-title")).toHaveText(title);
    const date = await otherWeek("#cal-month");
    await $(`#cal-month .cal-mini-day[data-date="${date}"]`).click();
    await weekAsked(date);
    expect(await callsOf("calendar_week")).toContainEqual({ date, firstDay: 0, refresh: false });
  });

  it("goes back to the month of the week shown when today or a day of the same week is pressed", async () => {
    await openMonth();
    const title = await $("#cal-month .cal-mini-title").getText();
    await $('#cal-month button[aria-label="次の月"]').click();
    await browser.waitUntil(async () => (await $("#cal-month .cal-mini-title").getText()) !== title);
    await $("#cal-today").click();
    await expect($("#cal-month .cal-mini-title")).toHaveText(title);
    await expect($("#cal-month-pop .cal-mini-title")).toHaveText(title);
    await $('#cal-month button[aria-label="前の月"]').click();
    await browser.waitUntil(async () => (await $("#cal-month .cal-mini-title").getText()) !== title);
    await $("#cal-month .cal-mini-row.current .cal-mini-day").click();
    await expect($("#cal-month .cal-mini-title")).toHaveText(title);
  });

  it("opens from the month of the bar, over the week, also while the panel is closed, and shows the week of a pressed day and closes", async () => {
    await openMonth();
    await mock("calendar_week", weekOfToday());
    await $("#cal-side-toggle").click();
    await expect($("#cal-month")).not.toBeDisplayed();
    await expect($("#cal-month-pop")).not.toBeDisplayed();
    await expect($("#cal-title")).toHaveAttribute("aria-expanded", "false");
    await $("#cal-title").click();
    await expect($("#cal-month-pop")).toBeDisplayed();
    await expect($("#cal-title")).toHaveAttribute("aria-expanded", "true");
    await expect($("#cal-month-pop .cal-mini-title")).toHaveText(weekTitle());
    // Under the bar, over the week.
    expect(await browser.execute(() => document.getElementById("cal-month-pop")!.getBoundingClientRect().top >= document.getElementById("cal-bar")!.getBoundingClientRect().bottom)).toBe(true);
    const date = await otherWeek("#cal-month-pop");
    await $(`#cal-month-pop .cal-mini-day[data-date="${date}"]`).click();
    await weekAsked(date);
    await expect($("#cal-month-pop")).not.toBeDisplayed();
    await expect($("#cal-title")).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape, on a click elsewhere and on the month of the bar", async () => {
    await openMonth();
    await $("#cal-title").click();
    await expect($("#cal-month-pop")).toBeDisplayed();
    await browser.keys("Escape");
    await expect($("#cal-month-pop")).not.toBeDisplayed();
    await $("#cal-title").click();
    await expect($("#cal-month-pop")).toBeDisplayed();
    await press($("#cal-body"));
    await expect($("#cal-month-pop")).not.toBeDisplayed();
    await $("#cal-title").click();
    await expect($("#cal-month-pop")).toBeDisplayed();
    await $("#cal-title").click();
    await expect($("#cal-month-pop")).not.toBeDisplayed();
  });
});

describe("calendar: event detail", () => {
  it("opens beside a timed event, inside the window, with each item and the Meet link", async () => {
    await openCalendar();
    const event = eventButton("Team sync");
    await event.click();
    const pop = $(".cal-pop");
    await expect(pop).toBeDisplayed();
    await expect(event).toHaveElementClass("selected");
    await expect(pop.$("h2")).toHaveText("Team sync");
    await expect(pop.$(".cal-pop-when")).toHaveText("11月2日（月）10:00 - 11:00");
    await expect(pop.$(".meet-join")).toHaveAttribute("href", meetUrl);
    await expect(pop.$(".meet-join")).toHaveText("Meet に参加");
    // The .text-btn.primary look is not squeezed by the small buttons of popups.
    expect(
      await browser.execute(() => {
        const s = getComputedStyle(document.querySelector(".meet-join")!);
        return [s.height, s.fontSize, s.color, s.borderRadius];
      }),
    ).toEqual(["36px", "13px", "rgb(255, 255, 255)", "18px"]);
    await expect(pop.$(".cal-pop-url span")).toHaveText("meet.google.com/abc-defg-hij");
    await expect(pop.$('button[aria-label="URL をコピー"]')).toBeDisplayed();
    await expect(pop).toHaveText(expect.stringContaining("Room B"));
    await expect(pop.$(".cal-pop-desc")).toHaveText(expect.stringContaining("Review the plan."));
    await expect(pop.$(".cal-pop-desc a")).toHaveAttribute("href", "https://example.com/plan");
    await expect(pop).toHaveText(expect.stringContaining("参加者 6人（承諾 4）"));
    await expect(pop.$(".cal-pop-cal")).toHaveText("Work ・ me@example.com");
    await expect(pop.$(".status.ok")).toHaveText("承諾");
    // Beside the event, not over it, and wholly in the window.
    const { box, frame, win } = await browser.execute(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const [b, f] = [rect(".cal-event.selected"), rect(".cal-pop")];
      return {
        box: { left: b.left, right: b.right },
        frame: { left: f.left, right: f.right, top: f.top, bottom: f.bottom },
        win: { width: innerWidth, height: innerHeight },
      };
    });
    expect(frame.left >= box.right || frame.right <= box.left).toBe(true);
    expect(frame.left).toBeGreaterThanOrEqual(0);
    expect(frame.top).toBeGreaterThanOrEqual(0);
    expect(frame.right).toBeLessThanOrEqual(win.width);
    expect(frame.bottom).toBeLessThanOrEqual(win.height);
  });

  it("keeps the destination of a link in the description whose text is not the URL", async () => {
    const week = weekOfToday();
    week.timed[0].description = 'See <a href="https://example.com/x">資料</a> first.';
    await boot({ inbox: inbox(), calendar_week: week });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await eventButton("Team sync").click();
    const desc = $(".cal-pop .cal-pop-desc");
    await expect(desc).toHaveText("See 資料 (https://example.com/x) first.");
    await expect(desc.$("a")).toHaveAttribute("href", "https://example.com/x");
  });

  it("keeps a multi-day event open on the same day's item when the week is drawn again", async () => {
    const week = weekOfToday();
    const offsite = { ...week.allDay[0], summary: "Offsite", whenText: "11月3日（火）- 11月4日（水）終日" };
    week.allDay = [{ ...offsite, day: 1 }, { ...offsite, day: 2 }];
    await boot({ inbox: inbox(), calendar_week: week });
    await $("#nav-calendar").click();
    await waitForText("#cal-allday .cal-chip", "Offsite");
    // The index of the day cell (after the label) holding the selected chip.
    const selectedDay = () =>
      browser.execute(() => [...document.querySelectorAll("#cal-allday > *")].findIndex((cell) => cell.querySelector(".cal-chip.selected")));
    await $$("#cal-allday .cal-chip")[1].click();
    expect(await selectedDay()).toBe(3);
    // A fetch that brings a change draws the week again.
    await redrawWith({ ...week, allDay: [...week.allDay, { ...week.allDay[0], day: 4, summary: "Extra" }] });
    await waitForText("#cal-allday", "Extra");
    await expect($(".cal-pop h2")).toHaveText("Offsite");
    expect(await selectedDay()).toBe(3);
  });

  it("keeps a bracketed URL of a plain-text description", async () => {
    const week = weekOfToday();
    week.timed[0].description = "Plan <https://example.com/a> first.";
    await boot({ inbox: inbox(), calendar_week: week });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await eventButton("Team sync").click();
    const desc = $(".cal-pop .cal-pop-desc");
    await expect(desc).toHaveText("Plan https://example.com/a first.");
    await expect(desc.$("a")).toHaveAttribute("href", "https://example.com/a");
  });

  it("leaves the URL of the app's own origin as text", async () => {
    const week = weekOfToday();
    week.timed[0].description = "Open http://tauri.localhost/x or https://example.com/y";
    await boot({ inbox: inbox(), calendar_week: week });
    await $("#nav-calendar").click();
    await waitForText("#cal-body .cal-name", "Team sync");
    await eventButton("Team sync").click();
    const desc = $(".cal-pop .cal-pop-desc");
    await expect(desc).toHaveText("Open http://tauri.localhost/x or https://example.com/y");
    expect(await count(".cal-pop .cal-pop-desc a")).toBe(1);
    await expect(desc.$("a")).toHaveAttribute("href", "https://example.com/y");
  });

  it("updates the popover when the week is drawn again with a change", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop")).toHaveText(expect.stringContaining("Room B"));
    const week = weekOfToday();
    week.timed[0].location = "Room C";
    await redrawWith(week);
    await waitForText(".cal-pop", "Room C");
    expect(await count(".cal-pop")).toBe(1);
    await expect(eventButton("Team sync")).toHaveElementClass("selected");
  });

  it("closes when the week is drawn again without the event", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop")).toBeDisplayed();
    const week = weekOfToday();
    week.timed = week.timed.filter((e) => e.summary !== "Team sync");
    await redrawWith(week);
    await waitForCount(".cal-pop", 0);
    expect(await count(".cal-event.selected")).toBe(0);
  });

  it("keeps the focus inside the popover when the week is drawn again with a change", async () => {
    await openCalendar();
    await press(eventButton("Team sync"));
    await browser.execute(() => (document.querySelector('.cal-pop button[aria-label="URL をコピー"]') as HTMLElement).focus());
    const week = weekOfToday();
    week.timed[0].location = "Room C";
    await redrawWith(week);
    await waitForText(".cal-pop", "Room C");
    expect(await browser.execute(() => document.activeElement?.classList.contains("cal-pop") && document.activeElement.textContent?.includes("Room C"))).toBe(true);
  });

  it("closes when the window is resized", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop")).toBeDisplayed();
    await browser.execute(() => window.dispatchEvent(new Event("resize")));
    await waitForCount(".cal-pop", 0);
  });

  it("copies the Meet URL", async () => {
    await openCalendar();
    await stubClipboard();
    await eventButton("Team sync").click();
    await $('.cal-pop button[aria-label="URL をコピー"]').click();
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "nothing was copied" });
    expect(await copiedTexts()).toEqual([meetUrl]);
  });

  it("leaves out the rows an event has no value for", async () => {
    await openCalendar();
    await eventButton("Maybe lunch").click();
    const pop = $(".cal-pop");
    await expect(pop.$("h2")).toHaveText("Maybe lunch");
    await expect(pop.$(".status.warn")).toHaveText("未定");
    expect(await count(".cal-pop .cal-pop-meet")).toBe(0);
    expect(await count(".cal-pop .cal-pop-row")).toBe(0);
    await eventButton("Unanswered").click();
    await expect($(".cal-pop .status.warn")).toHaveText("未回答");
  });

  it("opens an all-day event too", async () => {
    await openCalendar();
    const chip = eventButton("Holiday");
    await chip.click();
    const pop = $(".cal-pop");
    await expect(chip).toHaveElementClass("selected");
    await expect(pop.$("h2")).toHaveText("Holiday");
    await expect(pop.$(".cal-pop-when")).toHaveText("11月3日（火）終日");
    await expect(pop.$(".cal-pop-cal")).toHaveText("Holidays ・ me@example.com");
    // No answer of the user's own: no status label.
    expect(await count(".cal-pop .status")).toBe(0);
  });

  it("switches to another event and closes on the same one", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop h2")).toHaveText("Team sync");
    await eventButton("Maybe lunch").click();
    await waitForCount(".cal-pop", 1);
    await expect($(".cal-pop h2")).toHaveText("Maybe lunch");
    expect(await count(".cal-event.selected")).toBe(1);
    await eventButton("Maybe lunch").click();
    await waitForCount(".cal-pop", 0);
    expect(await count(".cal-event.selected")).toBe(0);
  });

  it("closes on Escape and gives the focus back to the event", async () => {
    await openCalendar();
    await press(eventButton("Team sync"));
    await expect($(".cal-pop")).toBeDisplayed();
    // The focus moved into the popover.
    expect(await browser.execute(() => document.activeElement?.classList.contains("cal-pop"))).toBe(true);
    await browser.keys("Escape");
    await waitForCount(".cal-pop", 0);
    expect(await browser.execute(() => document.activeElement?.classList.contains("cal-event") && document.activeElement.textContent?.includes("Team sync"))).toBe(true);
  });

  it("closes on ✕ and gives the focus back to the event", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await $('.cal-pop button[aria-label="閉じる"]').click();
    await waitForCount(".cal-pop", 0);
    expect(await browser.execute(() => document.activeElement?.classList.contains("cal-event"))).toBe(true);
  });

  it("closes on a click elsewhere", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop")).toBeDisplayed();
    await press($("#cal-title"));
    await waitForCount(".cal-pop", 0);
  });

  it("closes when the week moves", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop")).toBeDisplayed();
    await $("#cal-next").click();
    await waitForCount(".cal-pop", 0);
  });

  it("closes when the week is scrolled", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop")).toBeDisplayed();
    await browser.execute(() => {
      const scroll = document.getElementById("cal-scroll")!;
      // Either way, so the scroll moves even at the bottom.
      scroll.scrollTop += scroll.scrollTop > 40 ? -40 : 40;
    });
    await waitForCount(".cal-pop", 0);
  });

  it("closes when the screen changes", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop")).toBeDisplayed();
    await $("#nav-settings").click();
    await waitForCount(".cal-pop", 0);
  });
});
