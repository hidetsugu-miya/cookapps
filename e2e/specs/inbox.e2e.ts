import { account, boot, callsOf, holds, inbox, isoDate, mock, onceId, pressUndo, rejects, release, rowOf, setClock, textsOf, thread, threadDetail, threadLoaded, waitForCalls, waitForCount } from "../support";
import type { ThreadItem } from "../../ts/bindings/ThreadItem";

// Fires the event the app's sync round listens for (the window is shown again), which runs one round at once.
const syncRound = () =>
  browser.execute((id) => {
    if (!window.__e2e_once__(id)) return;
    document.dispatchEvent(new Event("visibilitychange"));
  }, onceId());

// Makes the list load again (the reload button shows only after a failed load): a sync that says the account needs a login does that. Returns once that round has run.
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

  it("lists the unread threads under the 未読 heading with their count, then the read ones under the 既読 heading", async () => {
    await expect($("#unread-heading span")).toHaveText("未読");
    await expect($("#unread-count")).toHaveText("2");
    await expect($("#read-heading")).toHaveText("既読");
    await expect($("#unread-threads")).toHaveText(expect.stringContaining("First unread"));
    await expect($("#unread-threads")).toHaveText(expect.stringContaining("Second unread"));
    await waitForCount("#read-threads li", 1);
    await expect($("#read-threads")).toHaveText(expect.stringContaining("Already read"));
  });

  it("reads none of the libraries that only the Orca screens use while the list is shown (#414)", async () => {
    const found = await browser.execute("return [typeof Terminal, typeof FitAddon, typeof Unicode11Addon, typeof WebLinksAddon, typeof hljs, document.querySelectorAll('script[src*=\"vendor/xterm\"], script[src*=\"vendor/addon-\"], script[src*=\"vendor/highlight\"]').length]");
    expect(found).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", 0]);
  });

  it("makes the header of the list a place to drag the window by", async () => {
    await expect($("#inbox-header")).toBeDisplayed();
    await expect($("#inbox-header")).toHaveAttribute("data-tauri-drag-region", "deep");
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
    // Nothing failed, so there is no reload button: the sync round loads the list again and rebuilds the rows.
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

  it("shows a header with the title only on the list, with the unread operation at the right end of the 未読 heading, no reload button while nothing failed, and the thread's toolbar only on a thread", async () => {
    await expect($("#title")).not.toExist();
    await expect($("#reload")).not.toExist();
    await expect($("#inbox-state button")).not.toExist();
    await expect($("#inbox-header")).toBeDisplayed();
    await expect($("#inbox-header h1")).toHaveText("受信トレイ");
    await expect($("#inbox-header #mail-mark-all")).not.toExist();
    await expect($("#unread-heading #mail-mark-all")).toHaveText("すべて既読にする");
    expect(await browser.execute(() => document.getElementById("unread-heading")!.lastElementChild!.id)).toBe("mail-mark-all");
    await expect($("#mail-header")).not.toBeDisplayed();
    await mock("thread", threadDetail("Already read", "Old news", false));
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#mail-header")).toBeDisplayed();
    await expect($("#inbox-header")).not.toBeDisplayed();
    await expect($("#thread-label")).toHaveText("受信トレイ");
    await $("#back").click();
    await expect($("#mail-header")).not.toBeDisplayed();
    await expect($("#inbox-header")).toBeDisplayed();
  });

  it("fixes the header above the list in the thread toolbar's color: it stays where it is while the list scrolls", async () => {
    const many = Array.from({ length: 30 }, (_, i) => thread(`m${i}`, `Thread ${i}`, true));
    await boot({ inbox: inbox(many) });
    await waitForCount("#unread-threads li", 30);
    const colors = await browser.execute(() => [getComputedStyle(document.getElementById("inbox-header")!).backgroundColor, getComputedStyle(document.getElementById("mail-header")!).backgroundColor]);
    expect(colors[0]).toBe(colors[1]);
    const top = () => browser.execute(() => document.getElementById("inbox-header")!.getBoundingClientRect().top);
    const before = await top();
    await browser.execute(() => {
      document.getElementById("main")!.scrollTop = 400;
    });
    expect(await browser.execute(() => document.getElementById("main")!.scrollTop)).toBeGreaterThan(0);
    expect(await top()).toBe(before);
    expect(await browser.execute(() => document.getElementById("main")!.contains(document.getElementById("inbox-header")))).toBe(false);
  });

  describe("marking all read", () => {
    const unreadThreads = (n: number) => Array.from({ length: n }, (_, i) => thread(`m${i}`, `Thread ${i}`, true));

    it("is not shown, with its 未読 heading, when no thread is unread, and can be pressed with one", async () => {
      await boot({ inbox: inbox([thread("t3", "Already read", false)]) });
      await waitForCount("#read-threads li", 1);
      await expect($("#unread-heading")).not.toBeDisplayed();
      await expect($("#mail-mark-all")).not.toBeDisplayed();
      await boot({ inbox: inbox() });
      await waitForCount("#unread-threads li", 2);
      await expect($("#unread-heading")).toBeDisplayed();
      await expect($("#mail-mark-all")).toBeEnabled();
    });

    it("makes every unread thread read with set_read, one request each, changes the rows at once, and offers 元に戻す", async () => {
      const setRead = await mock("set_read", holds);
      await $("#mail-mark-all").click();
      // Before Gmail has answered, both rows are read and in the read section, and the 未読 heading with the button has nothing left to show.
      await waitForCount("#unread-threads li", 0);
      await waitForCount("#read-threads li", 3);
      await expect($("#unread-heading")).not.toBeDisplayed();
      expect(await waitForCalls(setRead, 2)).toEqual([
        { account, id: "t1", read: true },
        { account, id: "t2", read: true },
      ]);
      await release(setRead, true);
      await release(setRead, true);
      await expect($(".toast")).toHaveText(expect.stringContaining("2 件を既読にしました"));
      await expect($(".toast button")).toHaveText("元に戻す");
      expect(await browser.execute(() => document.querySelectorAll("#read-threads li:not(.unread)").length)).toBe(3);
    });

    it("sends at most 4 requests at once", async () => {
      await boot({ inbox: inbox(unreadThreads(6)) });
      await waitForCount("#unread-threads li", 6);
      const setRead = await mock("set_read", holds);
      await $("#mail-mark-all").click();
      await waitForCalls(setRead, 4);
      await browser.pause(300);
      expect(await callsOf(setRead)).toHaveLength(4);
      await release(setRead, true);
      await waitForCalls(setRead, 5);
      await browser.pause(300);
      expect(await callsOf(setRead)).toHaveLength(5);
      await release(setRead, true);
      await waitForCalls(setRead, 6);
      for (let i = 0; i < 4; i++) await release(setRead, true);
      await expect($(".toast")).toHaveText(expect.stringContaining("6 件を既読にしました"));
    });

    it("puts a thread whose request failed back as unread, says so, and offers 元に戻す for the others", async () => {
      const setRead = await mock("set_read", holds);
      await $("#mail-mark-all").click();
      await waitForCalls(setRead, 2);
      await release(setRead, rejects("Gmail が断りました"));
      await release(setRead, true);
      // The failures are reported once, when the last request has answered; the row that failed is unread again, so the 未読 heading is back with its count.
      await expect($("#error")).toHaveText(expect.stringContaining("1 件を更新できませんでした: Gmail が断りました"));
      await waitForCount("#unread-threads li", 1);
      await expect($("#unread-count")).toHaveText("1");
      await expect(rowOf("unread-threads", "First unread")).toExist();
      await expect($(".toast")).toHaveText(expect.stringContaining("1 件を既読にしました"));
      await expect($("#mail-mark-all")).toBeEnabled();
    });

    it("makes the threads it changed unread again with 元に戻す, with set_read, and says so", async () => {
      const setRead = await mock("set_read", true);
      await $("#mail-mark-all").click();
      await waitForCalls(setRead, 2);
      await expect($(".toast button")).toHaveText("元に戻す");
      await $(".toast button").click();
      await waitForCount("#unread-threads li", 2);
      expect((await callsOf(setRead)).slice(2)).toEqual([
        { account, id: "t1", read: false },
        { account, id: "t2", read: false },
      ]);
      await expect($(".toast")).toHaveText(expect.stringContaining("元に戻しました"));
    });

    it("reads the list again for a login that is needed without clearing the error of another failure", async () => {
      const setRead = await mock("set_read", holds);
      await $("#mail-mark-all").click();
      await waitForCalls(setRead, 2);
      await release(setRead, rejects("Gmail が断りました"));
      await release(setRead, null);
      await expect($("#error")).toHaveText(expect.stringContaining("Gmail が断りました"));
      // The list was read again (the startup read and this one), and it did not hide the error.
      await waitForCalls("inbox", 2);
      await browser.pause(300);
      await expect($("#error")).toHaveText(expect.stringContaining("Gmail が断りました"));
    });

    it("keeps a row as it is when a sync arrives while its request is on its way", async () => {
      const setRead = await mock("set_read", holds);
      await $("#mail-mark-all").click();
      await waitForCalls(setRead, 2);
      // Gmail still says the thread is unread: the row keeps the state the user chose.
      await mock("sync", { kind: "changed", threads: [thread("t1", "First unread", true)], removed: [], arrived: [], historyId: "101" });
      await syncRound();
      await waitForCalls("sync");
      await browser.pause(300);
      await waitForCount("#unread-threads li", 0);
      await release(setRead, true);
      await release(setRead, true);
    });
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
  // The list's state line (M-1) as it is on screen.
  const stateLine = () =>
    browser.execute(() => {
      const e = document.getElementById("inbox-state")!;
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
      expect((await stateLine()).text).toContain("boom");
      await retry(rejects("boom"), 70_000);
      await expect($("#thread")).toBeDisplayed();
      expect(await callsOf("inbox")).toHaveLength(1);
      expect((await stateLine()).text).toContain("boom");
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

    it("keeps the failure for the list and clears nothing of another screen's error while another screen is shown", async () => {
      const failing = { ...inbox(), failed: { [account]: "quota" } };
      await mock("inbox", failing);
      await loadByNeedsLogin();
      await browser.pause(300);
      expect((await errorLine()).hidden).toBe(true);
      expect((await stateLine()).text).toContain("quota");
      await $("#nav-settings").click();
      // It fails: the failure goes to the list, not to the error line of the other screen.
      await retry(rejects("boom"), 70_000);
      expect((await errorLine()).hidden).toBe(true);
      expect((await stateLine()).text).toContain("boom");
      await otherError();
      await retry(rejects("boom"), 200_000);
      expect(await errorLine()).toEqual({ text: "other error", hidden: false });
      // It works: the other error stays, and the failure of the list goes.
      await retry(inbox(), 500_000);
      expect(await errorLine()).toEqual({ text: "other error", hidden: false });
      expect((await stateLine()).text).toBe("");
    });

    it("clears the failure of the last load when it works", async () => {
      await mock("inbox", rejects("boom"));
      await loadByNeedsLogin();
      expect((await stateLine()).text).toContain("boom");
      await retry(inbox(), 70_000);
      expect((await stateLine()).text).toBe("");
    });
  });

  describe("the popups for new mail (M-9)", () => {
    const arrivedThread = thread("t9", "Lunch plan", true);
    // One sync round that finds `arrived` among its changed threads; the next rounds find nothing.
    async function arrive(...arrived: ThreadItem[]) {
      const sync = await mock("sync", { kind: "changed", threads: arrived, removed: [], arrived: arrived.map((t) => t.id), historyId: "101" });
      await syncRound();
      await waitForCalls(sync);
      await mock("sync", { kind: "unchanged" });
    }
    const cards = () => textsOf(".arrival");

    it("shows no popup for the threads loaded at startup, or for a change that brought no new mail", async () => {
      await browser.pause(300);
      expect(await cards()).toEqual([]);
      const sync = await mock("sync", { kind: "changed", threads: [arrivedThread], removed: [], arrived: [], historyId: "101" });
      await syncRound();
      await waitForCalls(sync);
      await waitForCount("#unread-threads li", 3);
      expect(await cards()).toEqual([]);
    });

    it("shows the sender and the subject at the bottom right with the three actions, and adds the row to the list", async () => {
      await arrive(arrivedThread);
      await waitForCount(".arrival", 1);
      const card = $(".arrival");
      await expect(card).toHaveText(expect.stringContaining("Alice"));
      await expect(card).toHaveText(expect.stringContaining("Lunch plan"));
      await expect(card.$('button[aria-label="ゴミ箱へ移動"]')).toBeDisplayed();
      await expect(card.$('button[aria-label="アーカイブ"]')).toBeDisplayed();
      await expect(card.$("button=詳細を開く")).toBeDisplayed();
      await expect($("#nav-mail .nav-count")).toHaveText("3");
      const rect = await browser.execute(() => {
        const r = document.querySelector(".arrival")!.getBoundingClientRect();
        return { right: innerWidth - r.right, bottom: innerHeight - r.bottom };
      });
      expect(rect.right).toBe(24);
      expect(rect.bottom).toBeGreaterThanOrEqual(24);
      // The same thread found again does not add a second card.
      await arrive(arrivedThread);
      expect(await cards()).toHaveLength(1);
    });

    it("trashes the thread with the same command as the list, takes its row out at once and closes the popup", async () => {
      await arrive(arrivedThread);
      await waitForCount("#unread-threads li", 3);
      const trash = await mock("trash", true);
      await $('.arrival button[aria-label="ゴミ箱へ移動"]').click();
      await waitForCount(".arrival", 0);
      await waitForCount("#unread-threads li", 2);
      expect(await waitForCalls(trash)).toEqual([{ account, id: "t9" }]);
    });

    it("archives the thread with the same command as the list, takes its row out at once and closes the popup", async () => {
      await arrive(arrivedThread);
      await waitForCount("#unread-threads li", 3);
      const archive = await mock("archive", true);
      await $('.arrival button[aria-label="アーカイブ"]').click();
      await waitForCount(".arrival", 0);
      await waitForCount("#unread-threads li", 2);
      expect(await waitForCalls(archive)).toEqual([{ account, id: "t9" }]);
    });

    it("opens the thread from another screen with 詳細を開く, but a sync alone leaves that screen as it is", async () => {
      await $("#nav-slack").click();
      await expect($("#slack-list")).toBeDisplayed();
      const detail = await mock("thread", threadDetail("Lunch plan", "Shall we eat at noon?", true));
      await mock("set_read", true);
      await arrive(arrivedThread);
      await waitForCount(".arrival", 1);
      expect(await callsOf(detail)).toEqual([]);
      await expect($("#slack-list")).toBeDisplayed();
      await expect($("#thread")).not.toBeDisplayed();
      await $(".arrival").$("button=詳細を開く").click();
      await expect($("#thread")).toBeDisplayed();
      await expect($("#thread-subject")).toHaveText("Lunch plan");
      await threadLoaded();
      expect(await callsOf(detail)).toEqual([{ account, id: "t9" }]);
      await waitForCount(".arrival", 0);
      await expect($("#nav-mail")).toHaveAttribute("aria-current", "page");
    });

    it("closes with the close button, and gives no popup for the thread that is open on screen", async () => {
      await arrive(arrivedThread);
      await $('.arrival button[aria-label="閉じる"]').click();
      await waitForCount(".arrival", 0);
      expect(await callsOf("trash")).toEqual([]);
      await mock("thread", threadDetail("First unread", "Hello", true));
      await mock("set_read", true);
      await rowOf("unread-threads", "First unread").$(".subject").click();
      await expect($("#thread")).toBeDisplayed();
      await arrive(thread("t1", "First unread", true));
      await browser.pause(300);
      expect(await cards()).toEqual([]);
    });

    it("closes the popup of a thread that is opened from the list, so its buttons cannot act on the open thread", async () => {
      await arrive(arrivedThread);
      await waitForCount(".arrival", 1);
      await mock("thread", threadDetail("Lunch plan", "Shall we eat at noon?", true));
      await mock("set_read", true);
      await rowOf("unread-threads", "Lunch plan").$(".subject").click();
      await expect($("#thread-subject")).toHaveText("Lunch plan");
      await threadLoaded();
      await waitForCount(".arrival", 0);
    });

    it("closes the popup of a thread that the list marks read", async () => {
      await arrive(arrivedThread);
      await waitForCount(".arrival", 1);
      const setRead = await mock("set_read", true);
      await rowOf("unread-threads", "Lunch plan").$(".read-box").click();
      expect(await waitForCalls(setRead)).toEqual([{ account, id: "t9", read: true }]);
      await waitForCount(".arrival", 0);
    });

    it("closes the popup of a thread that a sync finds read", async () => {
      await arrive(arrivedThread);
      await waitForCount(".arrival", 1);
      const sync = await mock("sync", { kind: "changed", threads: [thread("t9", "Lunch plan", false)], removed: [], arrived: [], historyId: "102" });
      await syncRound();
      await waitForCalls(sync);
      await waitForCount(".arrival", 0);
      await mock("sync", { kind: "unchanged" });
    });

    it("does not let the timer of a closed popup close the next popup of the same thread", async () => {
      await arrive(arrivedThread);
      await $('.arrival button[aria-label="閉じる"]').click();
      await waitForCount(".arrival", 0);
      // The first card would have gone at 10 seconds; the second one arrives 6 seconds after the first.
      await browser.pause(6000);
      await arrive(arrivedThread);
      await waitForCount(".arrival", 1);
      await browser.pause(5000);
      expect(await cards()).toHaveLength(1);
      await browser.waitUntil(async () => (await cards()).length === 0, { timeout: 15_000, timeoutMsg: "the popup did not go by itself" });
    });

    it("keeps the newest 3 popups, and a popup goes by itself after 10 seconds", async () => {
      const four = ["t5", "t6", "t7", "t8"].map((id) => thread(id, `Mail ${id}`, true));
      await arrive(...four);
      await waitForCount(".arrival", 3);
      const texts = await cards();
      expect(texts.some((t) => t.includes("Mail t5"))).toBe(false);
      expect(texts.some((t) => t.includes("Mail t8"))).toBe(true);
      await browser.waitUntil(async () => (await cards()).length === 0, { timeout: 15_000, timeoutMsg: "the popups did not go by themselves" });
      await waitForCount("#unread-threads li", 6);
    });
  });

  describe("the state of the list (M-1)", () => {
    const failing = { ...inbox(), failed: { [account]: "quota" } };
    // Fails the list's load while its rows are drawn: a sync that needs a login makes the list load again.
    async function failWithRows(message: string) {
      await mock("inbox", rejects(message));
      await loadByNeedsLogin();
      await expect($("#inbox-state")).toHaveText(expect.stringContaining(message));
    }

    it("shows the loading note with a spinner, and no button, until the first load answers", async () => {
      await boot({ inbox: holds });
      await waitForCalls("inbox");
      await expect($("#threads")).toBeDisplayed();
      await expect($("#inbox-state")).toHaveText("読み込んでいます…");
      await expect($("#inbox-state .spin")).toBeDisplayed();
      await expect($("#inbox-state button")).not.toExist();
      await expect($("#threads li")).not.toExist();
      await release("inbox", inbox());
      await waitForCount("#unread-threads li", 2);
      await expect($("#inbox-state .pending")).not.toExist();
    });

    it("says there is no thread, with no spinner and no button, when the load answers with none", async () => {
      await boot({ inbox: inbox([]) });
      await expect($("#inbox-state")).toHaveText("受信トレイにスレッドはありません");
      await expect($("#inbox-state .spin")).not.toExist();
      await expect($("#inbox-state button")).not.toExist();
    });

    it("says there is no thread again when the last row is archived", async () => {
      await boot({ inbox: inbox([thread("t3", "Already read", false)]) });
      await waitForCount("#read-threads li", 1);
      await expect($("#inbox-state .feed-empty")).not.toExist();
      await mock("archive", true);
      const row = rowOf("read-threads", "Already read");
      await row.moveTo();
      await row.$(".archive-row").click();
      await expect($("#inbox-state")).toHaveText("受信トレイにスレッドはありません");
    });

    it("says the load failed, with the error, that it is read again by itself, and a button, when the call failed and no row is drawn", async () => {
      await boot({ inbox: rejects("boom") });
      await expect($("#inbox-state")).toHaveText(expect.stringContaining("読み込めませんでした: boom"));
      await expect($("#inbox-state")).toHaveText(expect.stringContaining("自動でも読み直します"));
      await expect($("#inbox-state button")).toHaveText("再読み込み");
      await expect($("#inbox-state")).not.toHaveText(expect.stringContaining("受信トレイにスレッドはありません"));
      await expect($("#threads li")).not.toExist();
      await expect($("#error")).not.toBeDisplayed();
    });

    it("loads the list at once with the button, and the failure and the button go when it works", async () => {
      await boot({ inbox: rejects("boom") });
      await expect($("#inbox-state button")).toBeDisplayed();
      await mock("inbox", inbox());
      await $("#inbox-state button").click();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await waitForCount("#unread-threads li", 2);
      await expect($("#inbox-state .pending")).not.toExist();
      await expect($("#inbox-state button")).not.toExist();
    });

    it("keeps the failure line, and the button can be pressed again, when the button's load fails again", async () => {
      await boot({ inbox: rejects("boom") });
      await expect($("#inbox-state button")).toBeDisplayed();
      await mock("inbox", rejects("again"));
      await $("#inbox-state button").click();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await expect($("#inbox-state")).toHaveText(expect.stringContaining("読み込めませんでした: again"));
      await expect($("#inbox-state button")).toBeEnabled();
    });

    it("keeps the focus on the same button while the button's load runs and fails with the same error", async () => {
      await boot({ inbox: rejects("boom") });
      await expect($("#inbox-state button")).toBeDisplayed();
      await browser.execute(() => {
        const b = document.querySelector<HTMLElement>("#inbox-state button")!;
        b.setAttribute("data-old", "");
        b.focus();
      });
      await browser.keys("Enter");
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await browser.pause(300);
      await expect($("#inbox-state button[data-old]")).toBeFocused();
      await expect($("#inbox-state button")).toBeEnabled();
    });

    it("keeps the rows and puts the failure line and the button above them when a load fails", async () => {
      await failWithRows("boom");
      await expect($("#inbox-state")).toHaveText(expect.stringContaining("自動でも読み直します"));
      await expect($("#inbox-state button")).toHaveText("再読み込み");
      await waitForCount("#unread-threads li", 2);
      await waitForCount("#read-threads li", 1);
      const above = await browser.execute(
        () => document.getElementById("inbox-state")!.getBoundingClientRect().bottom <= document.getElementById("threads")!.getBoundingClientRect().top,
      );
      expect(above).toBe(true);
    });

    it("names each account that failed in its answer, and keeps the rows of the others", async () => {
      await mock("inbox", failing);
      await loadByNeedsLogin();
      await expect($("#inbox-state")).toHaveText(expect.stringContaining(`読み込めませんでした: ${account}: quota`));
      await expect($("#inbox-state button")).toBeDisplayed();
      await waitForCount("#unread-threads li", 2);
    });

    it("loads again with the button above the rows, and clears the failure when it works", async () => {
      await failWithRows("boom");
      await mock("inbox", inbox());
      await $("#inbox-state button").click();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await expect($("#inbox-state .pending")).not.toExist();
      await waitForCount("#unread-threads li", 2);
    });

    it("stays when another screen is shown and the list comes back, and goes when a load works", async () => {
      await failWithRows("boom");
      await $("#nav-settings").click();
      await expect($("#inbox-state")).not.toBeDisplayed();
      await expect($("#error")).not.toBeDisplayed();
      await $("#nav-mail").click();
      await expect($("#inbox-state")).toHaveText(expect.stringContaining("読み込めませんでした: boom"));
      await expect($("#inbox-state button")).toBeDisplayed();
      await mock("inbox", inbox());
      await $("#inbox-state button").click();
      await waitForCalls("inbox");
      await expect($("#inbox-state .pending")).not.toExist();
      await $("#nav-settings").click();
      await $("#nav-mail").click();
      await expect($("#inbox-state .pending")).not.toExist();
    });

    it("is not shown in an open thread", async () => {
      await failWithRows("boom");
      await mock("thread", threadDetail("Already read", "Old news", false));
      await rowOf("read-threads", "Already read").$(".subject").click();
      await expect($("#thread")).toBeDisplayed();
      await expect($("#inbox-state")).not.toBeDisplayed();
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
      await expect($("#inbox-state")).toHaveText(expect.stringContaining("boom"));
      await mock("inbox", rejects("boom"));
      await syncRound();
      expect(await loads()).toEqual([]);
      await clockAfter(30_000);
      await syncRound();
      expect(await loads()).toEqual([]);
      await clockAfter(70_000);
      await syncRound();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await expect($("#inbox-state")).toHaveText(expect.stringContaining("boom"));
      // It failed again: the wait doubled to 120 seconds from that load, so 70 seconds later is too early.
      await clockAfter(140_000);
      await syncRound();
      expect(await loads()).toHaveLength(1);
      await mock("inbox", inbox());
      await clockAfter(200_000);
      await syncRound();
      expect(await waitForCalls("inbox")).toHaveLength(1);
      await expect($("#inbox-state .pending")).not.toExist();
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
