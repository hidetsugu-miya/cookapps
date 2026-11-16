import { boot, claudeReady, inbox, mock, slackLoad, slackTs, textsOf, thread, timeline, timelineMessage, waitForCalls, waitForCount, waitForText, weekOfToday } from "../support";

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
});
