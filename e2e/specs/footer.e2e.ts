import { account, boot, callsOf, claudeReady, inbox, mock, slackLoad, slackThread, slackTs, textsOf, thread, threadDetail, threadLoaded, threadMessage, timeline, timelineMessage, waitForCalls, waitForCount, waitForText, weekOfToday, workspace } from "../support";

// `unread` unread messages of the Slack list, each in a channel of its own.
const heap = (unread: number) => Array.from({ length: unread }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `unread ${i}`, { unread: true, channel: `C${i}` }));
const label = () => browser.execute(() => document.getElementById("footer-bell")!.getAttribute("aria-label"));
// Where the footer and the bell are: against the window's bottom, the icon column's right edge, and the footer's right edge.
const places = () =>
  browser.execute(() => {
    const f = document.getElementById("footer")!.getBoundingClientRect();
    const b = document.getElementById("footer-bell")!.getBoundingClientRect();
    return { bottom: Math.round(innerHeight - f.bottom), left: Math.round(f.left - document.getElementById("sidebar")!.getBoundingClientRect().right), height: Math.round(f.height), bell: Math.round(f.right - b.right) };
  });

describe("footer", () => {
  // Two unread mails (the default inbox) and three unread Slack messages.
  const start = (slack = timeline(heap(3), { refreshSecs: 1 })) => boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: slack, claude_status: claudeReady, calendar_week: weekOfToday() });

  it("shows the sum of the unread mail and the unread Slack messages on the bell, with the sum in its label", async () => {
    await start();
    await waitForText("#footer-bell .footer-count", "5");
    await expect($("#footer-bell .footer-count")).toBeDisplayed();
    expect(await label()).toBe("通知（未読 5 件）");
    // The sidebar's own counts are the two that it sums.
    await expect($("#nav-mail .nav-count")).toHaveText("2");
    await expect($("#nav-slack .nav-count")).toHaveText("3");
  });

  it("is a low band at the bottom of the window, to the right of the icon column, with the bell at its right end, on every screen", async () => {
    await start();
    await waitForCount("#unread-threads li", 2);
    for (const nav of ["#nav-mail", "#nav-calendar", "#nav-todo", "#nav-settings", "#nav-slack"]) {
      await $(nav).click();
      await expect($("#footer")).toBeDisplayed();
      await expect($("#footer-bell")).toBeDisplayed();
      const p = await places();
      expect(p.bottom).toBe(0);
      expect(p.left).toBe(0);
      expect(p.height).toBeLessThan(40);
      expect(p.bell).toBeLessThan(24);
    }
  });

  it("keeps the footer and the bell with no number for 0 unread", async () => {
    await boot({ inbox: inbox([thread("t3", "Already read", false)]), slack_load: slackLoad, slack_timeline: timeline([timelineMessage(slackTs(1), "Person", "dev", "read")]), claude_status: claudeReady });
    await waitForCalls("slack_timeline");
    await waitForCount("#read-threads li", 1);
    await browser.pause(300);
    await expect($("#footer")).toBeDisplayed();
    await expect($("#footer-bell")).toBeDisplayed();
    await expect($("#footer-bell .footer-count")).not.toBeDisplayed();
    expect(await label()).toBe("通知");
  });

  it("draws the sum again when the Slack count changes", async () => {
    await start();
    await waitForText("#footer-bell .footer-count", "5");
    await mock("slack_timeline", timeline(heap(1), { refreshSecs: 1 }));
    await waitForText("#footer-bell .footer-count", "3");
    expect(await label()).toBe("通知（未読 3 件）");
    await mock("slack_timeline", timeline([], { refreshSecs: 1 }));
    await waitForText("#footer-bell .footer-count", "2");
    expect(await textsOf("#footer-bell .footer-count")).toEqual(["2"]);
  });

  it("shows 99+ from 100, with the real sum in the label, and the Slack count above 20 at its real number", async () => {
    await start(timeline(heap(3), { unreadTotal: 120 }));
    await waitForText("#footer-bell .footer-count", "99+");
    expect(await label()).toBe("通知（未読 122 件）");
    await expect($("#nav-slack .nav-count")).toHaveText("20+");
  });

  describe("the pane of the unread", () => {
    // Two unread mails and two unread Slack messages, 2, 4, 6 and 8 minutes old, mixed.
    const mail = (id: string, subject: string, minutes: number) => ({ ...thread(id, subject, true), dateMs: Date.now() - minutes * 60_000 });
    const slackAt = (minutes: number, name: string, text: string) => timelineMessage(slackTs(minutes), name, "dev", text, { unread: true });
    const lines = () => textsOf("#unread-pane-list li .unread-line");
    const panes = (slack = timeline([slackAt(4, "Slack Second", "second text"), slackAt(8, "Slack Oldest", "oldest text")], { refreshSecs: 1 })) =>
      boot({ inbox: inbox([mail("t1", "Mail newest", 2), mail("t2", "Mail third", 6)]), slack_load: slackLoad, slack_timeline: slack, claude_status: claudeReady, calendar_week: weekOfToday() });
    const open = async () => {
      await waitForText("#footer-bell .footer-count", "4");
      await $("#footer-bell").click();
      await expect($("#unread-pane")).toBeDisplayed();
    };

    it("opens from the bell over the screen, above the footer and at the right, with the heading 未読 and the count", async () => {
      await panes();
      await expect($("#unread-pane")).not.toBeDisplayed();
      await open();
      await expect($("#unread-pane-title")).toHaveText("未読 4");
      await expect($("#footer-bell")).toHaveAttribute("aria-expanded", "true");
      const place = await browser.execute(() => {
        const p = document.getElementById("unread-pane")!.getBoundingClientRect();
        const f = document.getElementById("footer")!.getBoundingClientRect();
        return { width: Math.round(p.width), right: Math.round(innerWidth - p.right), above: Math.round(f.top - p.bottom) };
      });
      expect(place).toEqual({ width: 380, right: 0, above: 0 });
    });

    it("mixes the unread mail and the unread Slack messages, the newest first, each row with its icon, avatar, name, channel, time and one line", async () => {
      await panes();
      await open();
      await waitForCount("#unread-pane-list li", 4);
      expect(await lines()).toEqual(["Mail newest", "second text", "Mail third", "oldest text"]);
      expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#unread-pane-list li")].map((li) => li.dataset.kind))).toEqual(["mail", "slack", "mail", "slack"]);
      const slack = $$("#unread-pane-list li")[1];
      await expect(slack.$(".unread-kind svg")).toBeDisplayed();
      await expect(slack.$(".avatar")).toBeDisplayed();
      await expect(slack.$("b")).toHaveText("Slack Second");
      await expect(slack.$(".unread-channel")).toHaveText("#dev");
      expect((await slack.$(".unread-time").getText()).length).toBeGreaterThan(0);
      const first = $$("#unread-pane-list li")[0];
      await expect(first.$("b")).toHaveText("Alice");
      await expect(first.$(".unread-channel")).not.toExist();
      expect(await textsOf("#unread-pane-list li .text-btn")).toEqual(["詳細を開く", "スレッドを開く", "詳細を開く", "スレッドを開く"]);
    });

    it("closes with the bell again, with the close button, and with a press outside the pane", async () => {
      await panes();
      await open();
      await $("#footer-bell").click();
      await expect($("#unread-pane")).not.toBeDisplayed();
      await expect($("#footer-bell")).toHaveAttribute("aria-expanded", "false");
      await $("#footer-bell").click();
      await expect($("#unread-pane")).toBeDisplayed();
      await $('#unread-pane button[aria-label="閉じる"]').click();
      await expect($("#unread-pane")).not.toBeDisplayed();
      await $("#footer-bell").click();
      await expect($("#unread-pane")).toBeDisplayed();
      await $("#footer").click({ x: -200 });
      await expect($("#unread-pane")).not.toBeDisplayed();
    });

    it("opens the thread of a mail with 詳細を開く as pressing its row does, and closes", async () => {
      await panes();
      await open();
      const detail = await mock("thread", threadDetail("Mail third", "Hello", true));
      await mock("set_read", true);
      await $$("#unread-pane-list li")[2].$("button=詳細を開く").click();
      await expect($("#thread")).toBeDisplayed();
      await expect($("#thread-subject")).toHaveText("Mail third");
      await threadLoaded();
      expect(await callsOf(detail)).toEqual([{ account, id: "t2" }]);
      await expect($("#unread-pane")).not.toBeDisplayed();
    });

    it("opens the thread of a Slack message with スレッドを開く as pressing its row does: it is read and the Slack button is current", async () => {
      await panes();
      await open();
      const second = slackTs(4);
      const read = await mock("slack_mark_read", true);
      const opened = await mock("slack_thread", slackThread([threadMessage(second, "Slack Second", "second text")]));
      await $$("#unread-pane-list li")[1].$("button=スレッドを開く").click();
      await expect($("#slack-thread")).toBeDisplayed();
      await expect($("#nav-slack")).toHaveAttribute("aria-current", "page");
      expect(await waitForCalls(opened)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: second }]);
      expect(await waitForCalls(read)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: second }]);
      await expect($("#unread-pane")).not.toBeDisplayed();
    });

    it("draws the open pane again where the Slack list or the inbox changes", async () => {
      await panes();
      await open();
      await waitForCount("#unread-pane-list li", 4);
      // A new unread Slack message arrives.
      await mock("slack_timeline", timeline([slackAt(1, "Slack Fresh", "fresh text"), slackAt(4, "Slack Second", "second text"), slackAt(8, "Slack Oldest", "oldest text")], { refreshSecs: 1 }));
      await waitForCount("#unread-pane-list li", 5);
      expect((await lines())[0]).toBe("fresh text");
      await expect($("#unread-pane-title")).toHaveText("未読 5");
      // The Slack list is read in Slack: the messages go.
      await mock("slack_timeline", timeline([], { refreshSecs: 1 }));
      await waitForCount("#unread-pane-list li", 2);
      expect(await lines()).toEqual(["Mail newest", "Mail third"]);
      await expect($("#unread-pane-title")).toHaveText("未読 2");
      // A mail is made read in the inbox.
      await mock("set_read", true);
      await browser.execute(() => document.querySelector<HTMLInputElement>("#unread-threads .read-box")!.click());
      await waitForCount("#unread-pane-list li", 1);
      expect(await lines()).toEqual(["Mail third"]);
      await expect($("#unread-pane-title")).toHaveText("未読 1");
      expect(await textsOf("#unread-pane-list li b")).toEqual(["Alice"]);
    });
  });
});
