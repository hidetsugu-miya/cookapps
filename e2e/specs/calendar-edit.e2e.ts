import type { Week } from "../../ts/bindings/Week";
import { account, boot, callsOf, count, holds, inbox, isoDate, mock, ownedCalendars, rejects, release, rfc, textsOf, waitForCalls, waitForCount, waitForText, weekOfToday } from "../support";

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
