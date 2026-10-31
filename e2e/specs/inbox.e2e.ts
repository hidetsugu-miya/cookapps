import { account, boot, callsOf, inbox, mock, pressUndo, rowOf, waitForCalls, waitForCount } from "../support";

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
});
