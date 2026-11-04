import { account, boot, callsOf, holds, inbox, isoDate, mock, onceId, pressUndo, rejects, release, rowOf, setClock, threadDetail, waitForCalls, waitForCount } from "../support";

// Fires the event the app's sync round listens for (the window is shown again), which runs one round at once.
const syncRound = () =>
  browser.execute((id) => {
    if (!window.__e2e_once__(id)) return;
    document.dispatchEvent(new Event("visibilitychange"));
  }, onceId());

// Makes the list load again with no reload button: a sync that says the account needs a login does that. Returns once that round has run.
async function loadByNeedsLogin() {
  const sync = await mock("sync", { kind: "needsLogin" });
  await syncRound();
  await waitForCalls(sync);
  await mock("sync", { kind: "unchanged" });
}

// Sets the page's clock `ms` after the real time now.
const clockAfter = (ms: number) => {
  const d = new Date(Date.now() + ms);
  return setClock(`${isoDate(d)}T${d.toTimeString().slice(0, 8)}`);
};

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
    // There is no reload button: the sync round loads the list again and rebuilds the rows.
    await loadByNeedsLogin();
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

  it("shows no heading, no reload button and no toolbar on the list, and the toolbar only on a thread", async () => {
    await expect($("#title")).not.toExist();
    await expect($("#reload")).not.toExist();
    await expect($("#mail-header")).not.toBeDisplayed();
    await mock("thread", threadDetail("Already read", "Old news", false));
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#mail-header")).toBeDisplayed();
    await expect($("#thread-label")).toHaveText("受信トレイ");
    await $("#back").click();
    await expect($("#mail-header")).not.toBeDisplayed();
  });

  it("loads again at the next sync round when a sync needs a login while a thread is open, and keeps the thread", async () => {
    await mock("thread", threadDetail("Already read", "Old news", false));
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#thread")).toBeDisplayed();
    const sync = await mock("sync", { kind: "needsLogin" });
    await mock("inbox", { ...inbox(), needsLogin: [account] });
    await syncRound();
    await waitForCalls(sync);
    // The list is not shown: the load waits for the next round.
    await browser.pause(300);
    expect(await callsOf("inbox")).toEqual([]);
    await syncRound();
    expect(await waitForCalls("inbox")).toHaveLength(1);
    await expect($("#thread")).toBeDisplayed();
    await $("#back").click();
    await expect($("#relogin")).toHaveText(expect.stringContaining("再ログインが必要です"));
  });

  // The error line as it is on screen.
  const errorLine = () =>
    browser.execute(() => {
      const e = document.getElementById("error")!;
      return { text: e.textContent, hidden: e.hidden };
    });
  // Puts an error of some other screen in the error line.
  const otherError = () =>
    browser.execute(() => {
      const e = document.getElementById("error")!;
      e.textContent = "other error";
      e.hidden = false;
    });

  describe("a retry of a load that failed, in the background", () => {
    // Runs the due retry with `answer`, and returns once its load has ended.
    async function retry(answer: unknown, afterMs: number) {
      await mock("inbox", answer);
      await clockAfter(afterMs);
      await syncRound();
      await waitForCalls("inbox");
      await browser.pause(300);
    }

    it("keeps the thread that is open when it fails again", async () => {
      await mock("thread", threadDetail("Already read", "Old news", false));
      await rowOf("read-threads", "Already read").$(".subject").click();
      await expect($("#thread")).toBeDisplayed();
      await mock("sync", { kind: "needsLogin" });
      await mock("inbox", rejects("boom"));
      await syncRound();
      await waitForCalls("sync");
      await mock("sync", { kind: "unchanged" });
      await syncRound();
      await waitForCalls("inbox");
      await browser.pause(300);
      await expect($("#thread")).toBeDisplayed();
      expect((await errorLine()).text).toContain("boom");
      await retry(rejects("boom"), 70_000);
      await expect($("#thread")).toBeDisplayed();
      expect(await callsOf("inbox")).toHaveLength(1);
      expect((await errorLine()).text).toContain("boom");
    });

    it("keeps the focus on the same button of the same row when the rows are drawn again", async () => {
      const failing = { ...inbox(), failed: { [account]: "quota" } };
      await mock("inbox", failing);
      await loadByNeedsLogin();
      await browser.pause(300);
      await browser.execute(() => {
        for (const li of document.querySelectorAll<HTMLElement>("#unread-threads li")) li.setAttribute("data-old", "");
        const li = [...document.querySelectorAll<HTMLElement>("#unread-threads li")].find((e) => e.textContent?.includes("Second unread"))!;
        li.querySelector<HTMLElement>(".read-box")!.focus();
      });
      await expect(rowOf("unread-threads", "Second unread").$(".read-box")).toBeFocused();
      await retry(failing, 70_000);
      await waitForCount("#unread-threads li:not([data-old])", 2);
      await expect(rowOf("unread-threads", "Second unread").$(".read-box")).toBeFocused();
    });

    it("shows nothing and clears nothing of another screen's error while another screen is shown", async () => {
      const failing = { ...inbox(), failed: { [account]: "quota" } };
      await mock("inbox", failing);
      await loadByNeedsLogin();
      await browser.pause(300);
      expect((await errorLine()).hidden).toBe(true);
      await $("#nav-settings").click();
      // It fails: the inbox's error is not shown on the other screen.
      await retry(rejects("boom"), 70_000);
      expect((await errorLine()).hidden).toBe(true);
      await otherError();
      await retry(rejects("boom"), 200_000);
      expect(await errorLine()).toEqual({ text: "other error", hidden: false });
      // It works: the other error stays.
      await retry(inbox(), 500_000);
      expect(await errorLine()).toEqual({ text: "other error", hidden: false });
    });

    it("clears the error of the last load when it works", async () => {
      await mock("inbox", rejects("boom"));
      await loadByNeedsLogin();
      expect((await errorLine()).text).toContain("boom");
      await retry(inbox(), 70_000);
      expect((await errorLine()).hidden).toBe(true);
    });
  });

  describe("the notice of a failing sync", () => {
    async function failThreeRounds() {
      const sync = await mock("sync", rejects("offline"));
      for (let n = 1; n <= 3; n++) {
        await syncRound();
        await waitForCalls(sync, n);
        await browser.pause(300);
      }
      await expect($("#error")).toHaveText(expect.stringContaining("自動同期に失敗しています"));
    }

    it("goes when the sync works again", async () => {
      await failThreeRounds();
      await mock("sync", { kind: "unchanged" });
      await syncRound();
      await waitForCalls("sync");
      await expect($("#error")).not.toBeDisplayed();
    });

    it("leaves an error shown for something else when the sync works again", async () => {
      await failThreeRounds();
      await otherError();
      await mock("sync", { kind: "unchanged" });
      await syncRound();
      await waitForCalls("sync");
      await browser.pause(300);
      expect(await errorLine()).toEqual({ text: "other error", hidden: false });
    });
  });

  describe("a load that failed", () => {
    // `inbox` calls since the last `mock("inbox")`, after a pause long enough for a call to have been made.
    const loads = async () => {
      await browser.pause(300);
      return callsOf("inbox");
    };

    it("is repeated by the sync round after 60 seconds, then after 120 seconds, and no more once it worked", async () => {
      await mock("inbox", rejects("boom"));
      await loadByNeedsLogin();
      await expect($("#error")).toHaveText(expect.stringContaining("boom"));
      await mock("inbox", rejects("boom"));
      await syncRound();
      expect(await loads()).toEqual([]);
      await clockAfter(30_000);
      await syncRound();
      expect(await loads()).toEqual([]);
      await clockAfter(70_000);
      await syncRound();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await expect($("#error")).toHaveText(expect.stringContaining("boom"));
      // It failed again: the wait doubled to 120 seconds from that load, so 70 seconds later is too early.
      await clockAfter(140_000);
      await syncRound();
      expect(await loads()).toHaveLength(1);
      await mock("inbox", inbox());
      await clockAfter(200_000);
      await syncRound();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await expect($("#error")).not.toBeDisplayed();
      // It worked: nothing is repeated any more.
      await clockAfter(500_000);
      await syncRound();
      expect(await loads()).toHaveLength(1);
    });

    it("is repeated when an account of the answer failed, until none fails", async () => {
      const failing = { ...inbox(), failed: { [account]: "quota" } };
      await mock("inbox", failing);
      await loadByNeedsLogin();
      await mock("inbox", failing);
      await clockAfter(70_000);
      await syncRound();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      // Still failing, and the last load was just now: the next try waits for 120 seconds.
      await syncRound();
      expect(await loads()).toHaveLength(1);
      await mock("inbox", inbox());
      await clockAfter(200_000);
      await syncRound();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await clockAfter(500_000);
      await syncRound();
      expect(await loads()).toHaveLength(1);
    });
  });
});
