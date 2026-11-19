import type { Week } from "../../ts/bindings/Week";
import { account, askScreen, boot, callsOf, CARD, count, holds, inbox, isoDate, mock, ownedCalendars, rejects, release, rfc, textsOf, waitForCalls, waitForCount, waitForText, weekOfToday } from "../support";

// Edit and delete an event from its detail (C-7).
const today = isoDate(new Date());
const eventButton = (title: string) => $(`//button[contains(@class, "cal-event") or contains(@class, "cal-chip")][contains(., "${title}")]`);

// The week of today where "Team sync" (10:00 - 11:00, two guests, a Meet and a description) and "Holiday" (all day, no guests) can be changed, and "Maybe lunch" cannot.
function editableWeek(): Week {
  const week = weekOfToday();
  const sync = week.timed[0];
  Object.assign(sync, {
    eventId: "ev1",
    calendarId: "work",
    editable: true,
    start: rfc(today, "10:00"),
    end: rfc(today, "11:00"),
    guests: ["ann@example.com", "bob@example.com"],
  });
  Object.assign(week.allDay[0], { eventId: "ev2", calendarId: "holidays", editable: true, allDay: true, start: today, end: today });
  return week;
}

async function openCalendar() {
  await boot({ inbox: inbox(), calendar_week: editableWeek(), calendar_owned: ownedCalendars() });
  await $("#nav-calendar").click();
  await waitForText("#cal-body .cal-name", "Team sync");
}

// The labels of the buttons in the head of the open detail.
const headButtons = () => browser.execute(() => [...document.querySelectorAll(".cal-pop-head button")].map((b) => b.getAttribute("aria-label")));

async function openEdit(title = "Team sync") {
  await eventButton(title).click();
  await $('.cal-pop [aria-label="編集"]').click();
  await expect($(".cal-create")).toBeDisplayed();
}

async function openDelete(title = "Team sync") {
  await eventButton(title).click();
  await $('.cal-pop [aria-label="削除"]').click();
  await expect($(".cal-pop-confirm")).toBeDisplayed();
}

const saveButton = () => $(".cal-create .text-btn.primary");

describe("calendar: edit an event", () => {
  it("puts a pencil and a trash left of ✕ for an event that can be changed, and none for another", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    expect(await headButtons()).toEqual(["編集", "削除", "閉じる"]);
    await eventButton("Holiday").click();
    expect(await headButtons()).toEqual(["編集", "削除", "閉じる"]);
    await eventButton("Maybe lunch").click();
    expect(await headButtons()).toEqual(["閉じる"]);
  });

  it("switches the detail to the form with the values of the event, beside the event and with no draft", async () => {
    await openCalendar();
    const owned = await mock("calendar_owned", ownedCalendars());
    await openEdit();
    await expect($(".cal-pop:not(.cal-create)")).not.toExist();
    await expect($(".cal-create")).toHaveAttribute("aria-label", "予定を編集");
    await expect(eventButton("Team sync")).toHaveElementClass("selected");
    await expect($('.cal-create [aria-label="タイトル"]')).toHaveValue("Team sync");
    await expect($('.cal-create [aria-label="開始日"]')).toHaveValue(today);
    await expect($('.cal-create [aria-label="開始時刻"]')).toHaveValue("10:00");
    await expect($('.cal-create [aria-label="終了日"]')).toHaveValue(today);
    await expect($('.cal-create [aria-label="終了時刻"]')).toHaveValue("11:00");
    expect(await browser.execute(() => (document.querySelector(".cal-create-allday input") as HTMLInputElement).checked)).toBe(false);
    expect(await textsOf(".cal-create .mail-reply-chip > span")).toEqual(["ann@example.com", "bob@example.com"]);
    await expect($(".cal-create-card")).toBeDisplayed();
    await expect($('.cal-create [aria-label="説明"]')).toHaveValue("Review the plan.\nDocs: https://example.com/plan");
    // The calendar is shown, cannot be changed, and no list of calendars is read for it.
    await expect($('.cal-create [aria-label="カレンダー"]')).toBeDisabled();
    expect(await textsOf(".cal-create [aria-label='カレンダー'] option")).toEqual(["Work ・ me@example.com"]);
    expect(await callsOf(owned)).toEqual([]);
    await expect($(".cal-draft")).not.toExist();
    await expect(saveButton()).toBeEnabled();
    const look = await browser.execute(() => {
      const frame = document.querySelector(".cal-create")!.getBoundingClientRect();
      const box = document.querySelector(".cal-event.selected")!.getBoundingClientRect();
      return { beside: frame.left >= box.right || frame.right <= box.left, inside: frame.right <= innerWidth && frame.bottom <= innerHeight };
    });
    expect(look).toEqual({ beside: true, inside: true });
  });

  it("starts an all-day event with its dates and no times", async () => {
    await openCalendar();
    await openEdit("Holiday");
    expect(await browser.execute(() => (document.querySelector(".cal-create-allday input") as HTMLInputElement).checked)).toBe(true);
    await expect($('.cal-create [aria-label="開始日"]')).toHaveValue(today);
    await expect($('.cal-create [aria-label="終了日"]')).toHaveValue(today);
    await expect($('.cal-create [aria-label="開始時刻"]')).not.toBeDisplayed();
    await expect($('.cal-create [aria-label="終了時刻"]')).not.toBeDisplayed();
    expect(await count(".cal-create .mail-reply-chip")).toBe(0);
    await expect($(".cal-create-meet-add")).toBeDisplayed();
    await expect($('.cal-create [aria-label="説明"]')).toHaveValue("");
    expect(await textsOf(".cal-create [aria-label='カレンダー'] option")).toEqual(["Holidays ・ me@example.com"]);
  });

  it("saves what the form holds with the ID of the event, closes it and reads the week again", async () => {
    await openCalendar();
    await openEdit();
    await $('.cal-create [aria-label="タイトル"]').setValue("Team sync 2");
    await $('.cal-create [aria-label="ann@example.com を外す"]').click();
    await $('.cal-create [aria-label="ゲスト"]').setValue("cy@example.com");
    await browser.keys("Enter");
    await browser.execute(() => {
      const field = document.querySelector('.cal-create [aria-label="終了時刻"]') as HTMLInputElement;
      field.value = "11:30";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const update = await mock("calendar_update_event", { id: "ev1", meetUrl: null });
    const week = await mock("calendar_week", editableWeek());
    await saveButton().click();
    expect(await waitForCalls(update)).toEqual([
      {
        event: {
          eventId: "ev1",
          account,
          calendarId: "work",
          title: "Team sync 2",
          allDay: false,
          start: rfc(today, "10:00"),
          end: rfc(today, "11:30"),
          guests: ["bob@example.com", "cy@example.com"],
          meet: true,
          description: "Review the plan.\nDocs: https://example.com/plan",
        },
      },
    ]);
    await waitForCount(".cal-create", 0);
    expect(await waitForCalls(week)).toContainEqual({ date: expect.any(String), firstDay: 0, refresh: false });
  });

  it("saves an all-day event with dates, and takes the Meet off when its card is closed", async () => {
    await openCalendar();
    await openEdit("Team sync");
    await $('.cal-create [aria-label="Meet を外す"]').click();
    await $(".cal-create-allday input").click();
    const update = await mock("calendar_update_event", { id: "ev1", meetUrl: null });
    await saveButton().click();
    expect(await waitForCalls(update)).toEqual([
      {
        event: {
          eventId: "ev1",
          account,
          calendarId: "work",
          title: "Team sync",
          allDay: true,
          start: today,
          end: today,
          guests: ["ann@example.com", "bob@example.com"],
          meet: false,
          description: "Review the plan.\nDocs: https://example.com/plan",
        },
      },
    ]);
  });

  it("keeps the save button disabled while it saves", async () => {
    await openCalendar();
    await openEdit();
    const update = await mock("calendar_update_event", holds);
    await saveButton().click();
    await waitForCalls(update);
    await expect(saveButton()).toBeDisabled();
    await release(update, { id: "ev1", meetUrl: null });
    await waitForCount(".cal-create", 0);
    expect(await callsOf(update)).toHaveLength(1);
  });

  it("shows the error in the form when the save fails, and keeps what was written", async () => {
    await openCalendar();
    await openEdit();
    await $('.cal-create [aria-label="タイトル"]').setValue("Changed");
    const update = await mock("calendar_update_event", rejects("この予定は変更できません。自分が主催した予定だけです"));
    const week = await mock("calendar_week", editableWeek());
    await saveButton().click();
    await waitForCalls(update);
    await expect($(".cal-create-error")).toHaveText("この予定は変更できません。自分が主催した予定だけです");
    await expect($('.cal-create [aria-label="タイトル"]')).toHaveValue("Changed");
    expect(await textsOf(".cal-create .mail-reply-chip > span")).toEqual(["ann@example.com", "bob@example.com"]);
    await expect(saveButton()).toBeEnabled();
    expect(await callsOf(week)).toEqual([]);
  });

  it("asks to log in again in the form when the account has not granted the permission", async () => {
    await openCalendar();
    await openEdit();
    const update = await mock("calendar_update_event", null);
    await saveButton().click();
    await waitForCalls(update);
    await expect($(".cal-create-error")).toHaveText(expect.stringContaining(`${account} は予定を書き換えるため再ログインが必要です`));
    const login = await mock("login", account);
    await $(".cal-create-error .text-btn").click();
    expect(await waitForCalls(login)).toEqual([{ loginHint: account }]);
  });

  it("opens the form beside the event of the week drawn now when the week was drawn again behind the detail", async () => {
    await openCalendar();
    await eventButton("Team sync").click();
    await expect($(".cal-pop h2")).toHaveText("Team sync");
    // Another event changed, so the week is drawn again with new nodes while the detail of Team sync stays.
    const changed = editableWeek();
    changed.timed[1].summary = "Maybe lunch 2";
    await mock("calendar_week", changed);
    await browser.execute(async () => {
      const path = "/js/calendar.js";
      const calendar = (await import(path)) as { loadCalendar(refresh: boolean): Promise<void> };
      await calendar.loadCalendar(true);
    });
    await waitForText("#cal-body .cal-name", "Maybe lunch 2");
    await $('.cal-pop [aria-label="編集"]').click();
    await expect($(".cal-create")).toBeDisplayed();
    await expect(eventButton("Team sync")).toHaveElementClass("selected");
    const look = await browser.execute(() => {
      const frame = document.querySelector(".cal-create")!.getBoundingClientRect();
      const box = document.querySelector(".cal-event.selected")!.getBoundingClientRect();
      return { beside: frame.left >= box.right || frame.right <= box.left, there: box.height > 0 };
    });
    expect(look).toEqual({ beside: true, there: true });
  });

  it("closes on ✕ and on Escape without calling anything, and takes the mark off the event", async () => {
    await openCalendar();
    const update = await mock("calendar_update_event", { id: "ev1", meetUrl: null });
    await openEdit();
    await $('.cal-create [aria-label="タイトル"]').setValue("Changed");
    await $('.cal-create [aria-label="閉じる"]').click();
    await waitForCount(".cal-create", 0);
    await expect(eventButton("Team sync")).not.toHaveElementClass("selected");
    await openEdit();
    await expect($('.cal-create [aria-label="タイトル"]')).toHaveValue("Team sync");
    await browser.keys("Escape");
    await waitForCount(".cal-create", 0);
    expect(await callsOf(update)).toEqual([]);
  });
});

describe("calendar: delete an event", () => {
  it("asks in the popover, and names the guests who are told", async () => {
    await openCalendar();
    await openDelete();
    expect(await textsOf(".cal-pop-confirm > p")).toEqual(["「Team sync」を削除します。元に戻せません。", "ゲストに取り消しが届きます。"]);
    expect(await textsOf(".cal-pop-confirm .text-btn")).toEqual(["キャンセル", "削除"]);
    await expect($(".cal-pop-confirm .text-btn.danger")).toHaveText("削除");
    await expect($(".cal-pop .meet-join")).not.toExist();
  });

  it("names no guests for an event that has none", async () => {
    await openCalendar();
    await openDelete("Holiday");
    expect(await textsOf(".cal-pop-confirm > p")).toEqual(["「Holiday」を削除します。元に戻せません。"]);
  });

  it("goes back to the detail on キャンセル and calls nothing", async () => {
    await openCalendar();
    const del = await mock("calendar_delete_event", true);
    await openDelete();
    await $(".cal-pop-confirm .text-btn:not(.danger)").click();
    await waitForCount(".cal-pop-confirm", 0);
    await expect($(".cal-pop h2")).toHaveText("Team sync");
    await expect($(".cal-pop .meet-join")).toBeDisplayed();
    expect(await headButtons()).toEqual(["編集", "削除", "閉じる"]);
    expect(await callsOf(del)).toEqual([]);
  });

  it("deletes the event with its IDs, closes the popover and reads the week again", async () => {
    await openCalendar();
    const del = await mock("calendar_delete_event", true);
    const week = await mock("calendar_week", editableWeek());
    await openDelete();
    await $(".cal-pop-confirm .text-btn.danger").click();
    expect(await waitForCalls(del)).toEqual([{ account, calendarId: "work", eventId: "ev1" }]);
    await waitForCount(".cal-pop", 0);
    expect(await waitForCalls(week)).toContainEqual({ date: expect.any(String), firstDay: 0, refresh: false });
  });

  it("keeps both buttons disabled while it deletes", async () => {
    await openCalendar();
    await openDelete("Holiday");
    const del = await mock("calendar_delete_event", holds);
    await $(".cal-pop-confirm .text-btn.danger").click();
    await waitForCalls(del);
    await expect($(".cal-pop-confirm .text-btn.danger")).toBeDisabled();
    await expect($(".cal-pop-confirm .text-btn:not(.danger)")).toBeDisabled();
    await release(del, true);
    await waitForCount(".cal-pop", 0);
    expect(await callsOf(del)).toEqual([{ account, calendarId: "holidays", eventId: "ev2" }]);
  });

  it("writes the error in the popover when the delete fails, and lets it be pressed again", async () => {
    await openCalendar();
    const del = await mock("calendar_delete_event", rejects("予定を削除できませんでした"));
    const week = await mock("calendar_week", editableWeek());
    await openDelete();
    await $(".cal-pop-confirm .text-btn.danger").click();
    await waitForCalls(del);
    await expect($(".cal-pop-confirm .cal-create-error")).toHaveText("予定を削除できませんでした");
    await expect($(".cal-pop-confirm .text-btn.danger")).toBeEnabled();
    expect(await callsOf(week)).toEqual([]);
  });

  it("does nothing when the trash is pressed again while it asks", async () => {
    await openCalendar();
    await openDelete();
    await $('.cal-pop-head [aria-label="削除"]').click();
    expect(await count(".cal-pop-confirm")).toBe(1);
    await $(".cal-pop-confirm .text-btn:not(.danger)").click();
    await waitForCount(".cal-pop-confirm", 0);
    await expect($(".cal-pop h2")).toHaveText("Team sync");
    await expect($(".cal-pop .meet-join")).toBeDisplayed();
  });

  it("shows the failure in a card when the popover was closed before the delete answered", async () => {
    await openCalendar();
    const del = await mock("calendar_delete_event", holds);
    await openDelete();
    await $(".cal-pop-confirm .text-btn.danger").click();
    await waitForCalls(del);
    await $('.cal-pop-head [aria-label="閉じる"]').click();
    await waitForCount(".cal-pop", 0);
    await release(del, rejects("予定を削除できませんでした"));
    await expect($(CARD)).toHaveText("予定を削除できませんでした");
  });

  it("asks to log in again in the popover when the account has not granted the permission", async () => {
    await openCalendar();
    const del = await mock("calendar_delete_event", null);
    await openDelete();
    await $(".cal-pop-confirm .text-btn.danger").click();
    await waitForCalls(del);
    await expect($(".cal-pop-confirm .cal-create-error")).toHaveText(expect.stringContaining(`${account} は予定を削除するため再ログインが必要です`));
    const login = await mock("login", account);
    await $(".cal-pop-confirm .cal-create-error .text-btn").click();
    expect(await waitForCalls(login)).toEqual([{ loginHint: account }]);
  });
});

// The form that Claude Code fills in instead of sending an event that invites someone new (C-6, C-7): the target "calendar-form" of the screen bridge. Nothing is saved until the owner presses 保存.
const star = "#cal-bar-claude";
const press = (target: ChainablePromiseElement) => browser.action("pointer").move({ origin: target }).down().up().perform();

async function openPane() {
  await press($(star));
  await waitForCalls("claude_code_start");
}

const wanted = (over: Record<string, unknown> = {}) => ({
  eventId: "",
  account,
  calendarId: "work",
  title: "Planning",
  allDay: false,
  start: rfc(today, "14:00"),
  end: rfc(today, "15:00"),
  guests: ["new@example.com"],
  meet: true,
  ...over,
});
const fillForm = (form: Record<string, unknown>, description = "議題\n二行目") => askScreen("write", "calendar-form", { form: JSON.stringify(form), description });

describe("calendar: the form that Claude Code fills in", () => {
  it("opens the form of a new event with the values, beside its draft, with the named calendar, and saves nothing", async () => {
    await openCalendar();
    await openPane();
    const create = await mock("calendar_create_event", { id: "new1", meetUrl: null });
    expect(await fillForm(wanted())).toEqual({ ok: true });
    await expect($(".cal-create")).toHaveAttribute("aria-label", "新しい予定");
    await expect($('.cal-create [aria-label="タイトル"]')).toHaveValue("Planning");
    await expect($('.cal-create [aria-label="開始日"]')).toHaveValue(today);
    await expect($('.cal-create [aria-label="開始時刻"]')).toHaveValue("14:00");
    await expect($('.cal-create [aria-label="終了時刻"]')).toHaveValue("15:00");
    expect(await textsOf(".cal-create .mail-reply-chip > span")).toEqual(["new@example.com"]);
    await expect($(".cal-create-card")).toBeDisplayed();
    await expect($('.cal-create [aria-label="説明"]')).toHaveValue("議題\n二行目");
    await expect(saveButton()).toBeEnabled();
    expect(await browser.execute(() => (document.querySelector(".cal-create-calendar") as HTMLSelectElement).selectedOptions[0].text)).toBe("Work");
    await expect($(".cal-draft")).toBeDisplayed();
    const beside = await browser.execute(() => {
      const frame = document.querySelector(".cal-create")!.getBoundingClientRect();
      const box = document.querySelector(".cal-draft")!.getBoundingClientRect();
      return frame.left >= box.right || frame.right <= box.left;
    });
    expect(beside).toBe(true);
    expect(await callsOf(create)).toEqual([]);
    // The owner's 保存 is what sends it, as the form of the screen does.
    await saveButton().click();
    expect(await waitForCalls(create)).toEqual([
      {
        event: {
          account,
          calendarId: "work",
          title: "Planning",
          allDay: false,
          start: rfc(today, "14:00"),
          end: rfc(today, "15:00"),
          guests: ["new@example.com"],
          meet: true,
          description: "議題\n二行目",
        },
      },
    ]);
    await waitForCount(".cal-create", 0);
  });

  it("opens the form of an event of the week with the values beside the event, and 保存 calls calendar_update_event", async () => {
    await openCalendar();
    await openPane();
    const update = await mock("calendar_update_event", { id: "ev1", meetUrl: null });
    expect(await fillForm(wanted({ eventId: "ev1", title: "Team sync 2", start: rfc(today, "10:00"), end: rfc(today, "11:30"), guests: ["ann@example.com", "cy@example.com"], meet: false }), "新しい説明")).toEqual({ ok: true });
    await expect($(".cal-create")).toHaveAttribute("aria-label", "予定を編集");
    await expect(eventButton("Team sync")).toHaveElementClass("selected");
    await expect($('.cal-create [aria-label="タイトル"]')).toHaveValue("Team sync 2");
    await expect($('.cal-create [aria-label="終了時刻"]')).toHaveValue("11:30");
    expect(await textsOf(".cal-create .mail-reply-chip > span")).toEqual(["ann@example.com", "cy@example.com"]);
    await expect($(".cal-create-meet-add")).toBeDisplayed();
    await expect($('.cal-create [aria-label="説明"]')).toHaveValue("新しい説明");
    await expect($('.cal-create [aria-label="カレンダー"]')).toBeDisabled();
    await expect($(".cal-draft")).not.toExist();
    expect(await callsOf(update)).toEqual([]);
    await saveButton().click();
    expect(await waitForCalls(update)).toEqual([
      {
        event: {
          eventId: "ev1",
          account,
          calendarId: "work",
          title: "Team sync 2",
          allDay: false,
          start: rfc(today, "10:00"),
          end: rfc(today, "11:30"),
          guests: ["ann@example.com", "cy@example.com"],
          meet: false,
          description: "新しい説明",
        },
      },
    ]);
  });

  it("refuses an event that is not in the week shown, and a form that is not made of its fields, and opens none", async () => {
    await openCalendar();
    await openPane();
    const gone = await fillForm(wanted({ eventId: "nowhere" }));
    expect(gone).toMatchObject({ ok: false, error: expect.stringContaining("今カレンダーに出ている週にありません") });
    expect(await askScreen("write", "calendar-form", { form: "not json" })).toMatchObject({ ok: false });
    expect(await askScreen("write", "calendar-form", { form: JSON.stringify({ title: "x" }) })).toMatchObject({ ok: false });
    expect(await askScreen("write", "calendar-form", { description: "d" })).toMatchObject({ ok: false });
    await expect($(".cal-create")).not.toExist();
  });

  it("opens no form that has no place to save: the named calendar is not one that an event can be created in", async () => {
    await openCalendar();
    await openPane();
    expect(await fillForm(wanted({ calendarId: "other" }))).toEqual({ ok: true });
    await expect($(".cal-create-error")).toHaveText("指定されたカレンダーには予定を作れません");
    await expect(saveButton()).toBeDisabled();
  });

  it("answers that the screen is not open while the Claude pane is closed or another screen is shown, and opens no form", async () => {
    await openCalendar();
    const closed = await fillForm(wanted());
    expect(closed).toMatchObject({ ok: false, error: expect.stringContaining("calendar-form") });
    await openPane();
    await $("#nav-mail").click();
    expect(await fillForm(wanted())).toMatchObject({ ok: false, error: expect.stringContaining("calendar-form") });
    await $("#nav-calendar").click();
    await expect($(".cal-create")).not.toExist();
    expect(await callsOf("calendar_create_event")).toEqual([]);
  });
});
