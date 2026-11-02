import { account, boot, callsOf, holds, inbox, mock, pressUndo, release, rowOf, waitForCalls, waitForCount } from "../support";

describe("inbox", () => {
  beforeEach(async () => {
    await boot({ inbox: inbox() });
    await waitForCount("#unread-threads li", 2);
  });

  it("lists the unread threads, then the read ones under the 既読 heading", async () => {
    await expect($("#read-heading")).toHaveText("既読");
    await expect($("#unread-threads")).toHaveText(expect.stringContaining("First unread"));
    await expect($("#unread-threads")).toHaveText(expect.stringContaining("Second unread"));
    await waitForCount("#read-threads li", 1);
    await expect($("#read-threads")).toHaveText(expect.stringContaining("Already read"));
  });

  it("archives a row through the archive command", async () => {
    const archive = await mock("archive", true);
    const row = rowOf("unread-threads", "First unread");
    await row.moveTo();
    await row.$(".archive-row").click();
    await waitForCount("#unread-threads li", 1);
    await waitForCalls(archive);
    expect(await callsOf(archive)).toEqual([{ account, id: "t1" }]);
    await expect($(".toast")).toHaveText(expect.stringContaining("アーカイブしました"));
  });

  it("brings the archived row back with Cmd+Z through unarchive", async () => {
    await mock("archive", true);
    const unarchive = await mock("unarchive", true);
    const row = rowOf("unread-threads", "First unread");
    await row.moveTo();
    await row.$(".archive-row").click();
    await waitForCount("#unread-threads li", 1);
    // The undo is armed once archive has answered, which is when the notice shows.
    await expect($(".toast")).toHaveText(expect.stringContaining("元に戻す"));
    await pressUndo();
    await waitForCalls(unarchive);
    expect(await callsOf(unarchive)).toContainEqual({ account, id: "t1" });
    await waitForCount("#unread-threads li", 2);
  });

  it("trashes a row through the trash command", async () => {
    const trash = await mock("trash", true);
    const row = rowOf("unread-threads", "Second unread");
    await row.moveTo();
    await row.$(".trash-row").click();
    await waitForCount("#unread-threads li", 1);
    await waitForCalls(trash);
    expect(await callsOf(trash)).toContainEqual({ account, id: "t2" });
    await expect($(".toast")).toHaveText(expect.stringContaining("ゴミ箱へ移動しました"));
  });

  it("shows a spinner in place of the Todo button's icon while the task is made, even after the mouse leaves the row", async () => {
    const make = await mock("todoist_task_from_mail", holds);
    const row = rowOf("unread-threads", "First unread");
    await row.moveTo();
    await row.$(".todo-row").click();
    expect(await waitForCalls(make)).toEqual([{ account, threadId: "t1", subject: "First unread" }]);
    await expect(row.$(".todo-row .spin")).toExist();
    await expect(row.$(".todo-row svg")).not.toExist();
    await expect(row.$(".todo-row")).toBeDisabled();
    // The click leaves the focus on the button, which would keep the row's buttons shown by itself.
    await browser.execute(() => (document.activeElement as HTMLElement).blur());
    await $("#read-heading").moveTo();
    await expect(row.$(".todo-row .spin")).toBeDisplayed();
    await release(make, true);
    await expect(row.$(".todo-row .spin")).not.toExist();
    await expect(row.$(".todo-row svg")).toExist();
    await expect(row.$(".todo-row")).toBeEnabled();
    await expect($(".toast")).toHaveText(expect.stringContaining("First unread"));
  });

  it("keeps the spinner and the disabled Todo button on a row rebuilt by a reload while the task is made, and puts them back after", async () => {
    const make = await mock("todoist_task_from_mail", holds);
    const row = rowOf("unread-threads", "First unread");
    await row.moveTo();
    await row.$(".todo-row").click();
    await waitForCalls(make);
    // Marks the rows on screen, so the rebuilt ones can be told apart.
    await browser.execute(() => {
      for (const li of document.querySelectorAll("#unread-threads li")) li.setAttribute("data-old", "");
    });
    await $("#reload").click();
    await waitForCount("#unread-threads li:not([data-old])", 2);
    await expect(rowOf("unread-threads", "First unread").$(".todo-row .spin")).toExist();
    await expect(rowOf("unread-threads", "First unread").$(".todo-row")).toBeDisabled();
    // Only that thread: the other row's button is a normal one.
    await expect(rowOf("unread-threads", "Second unread").$(".todo-row .spin")).not.toExist();
    await release(make, true);
    await expect(rowOf("unread-threads", "First unread").$(".todo-row .spin")).not.toExist();
    await expect(rowOf("unread-threads", "First unread").$(".todo-row svg")).toExist();
    await expect(rowOf("unread-threads", "First unread").$(".todo-row")).toBeEnabled();
    expect(await callsOf(make)).toHaveLength(1);
  });
});
