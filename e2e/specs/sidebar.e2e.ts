import { boot, callsOf, claudeLoggedOut, claudeMissing, claudeReady, dueToday, holds, inbox, mock, moment, ownIcon, pngUri, rowOf, setClock, slackLoad, slackPreview, slackTs, task, threadDetail, timeline, timelineMessage, today, todoData, waitForCalls, waitForCount, weekOfToday, workspace } from "../support";

// The ids of what the sidebar's bottom group shows, top to bottom.
const bottomGroup = () =>
  browser.execute(() => [...document.querySelectorAll<HTMLElement>("#sidebar-bottom > *")].filter((e) => e.offsetParent !== null).map((e) => e.id));

describe("sidebar", () => {
  it("shows the Claude avatar while logged in, and its popup on a click", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    const button = $("#claude-btn");
    await expect(button).toBeDisplayed();
    await expect(button).toHaveAttribute("aria-label", "Claude: claude@example.com");
    // The bottom group is Claude, then settings last; the account avatars sit under the calendar icon.
    expect(await bottomGroup()).toEqual(["claude-btn", "nav-settings"]);
    await expect($('#account-list button[aria-label="me@example.com"]')).toBeDisplayed();
    await expect($("#add-account")).not.toExist();
    await button.click();
    const popup = $("#account-popup");
    await expect(popup).toBeDisplayed();
    await expect(popup).toHaveText(expect.stringContaining("claude@example.com"));
    await expect(popup).toHaveText(expect.stringContaining("Claude ・ Max プラン"));
    await expect(button).toHaveAttribute("aria-expanded", "true");
    // The tooltip would land on the popup, so the avatar shows none while it is open (the tooltip waits 300 ms).
    await $("#nav-mail").moveTo();
    await button.moveTo();
    await browser.pause(600);
    await expect($(".tooltip")).not.toBeDisplayed();
  });

  for (const [name, status] of [
    ["Claude Code is missing", claudeMissing],
    ["Claude is logged out", claudeLoggedOut],
  ] as const) {
    it(`hides the Claude avatar when ${name}`, async () => {
      await boot({ inbox: inbox(), claude_status: status });
      // The mock answers at once, so by the next script the sidebar has heard it.
      await waitForCalls("claude_status");
      await expect($("#claude-btn")).not.toBeDisplayed();
    });
  }

  it("manual: shows the update button with the new version, and on a press replaces the app and restarts it", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    const button = $("#update-btn");
    await button.waitForDisplayed();
    await expect(button).toHaveAttribute("aria-label", "v9.9.9 に更新");
    await expect($("#nav-settings .nav-dot")).toBeDisplayed();
    await expect($("#nav-settings")).toHaveAttribute("aria-label", "設定（v9.9.9 があります）");
    // The update button comes first in the bottom group, above Claude.
    expect(await bottomGroup()).toEqual(["update-btn", "claude-btn", "nav-settings"]);
    expect(await callsOf("install_update")).toEqual([]);
    const install = await mock("install_update", null);
    const restart = await mock("restart_app", null);
    await button.click();
    expect(await waitForCalls(restart)).toEqual([null]);
    expect(await callsOf(install)).toEqual([null]);
  });

  it("auto: replaces the app by itself, then the button restarts the app and nothing else", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "auto", check_update: { version: "9.9.9", installed: false } });
    expect(await waitForCalls("install_update")).toEqual([null]);
    const button = $("#update-btn");
    await expect(button).toHaveAttribute("aria-label", "再起動して v9.9.9 にする");
    expect(await callsOf("restart_app")).toEqual([]);
    // From now on the backend says the app is replaced.
    const check = await mock("check_update", { version: "9.9.9", installed: true });
    const install = await mock("install_update", null);
    const restart = await mock("restart_app", null);
    await button.click();
    expect(await waitForCalls(restart)).toEqual([null]);
    await waitForCalls(check);
    expect(await callsOf(install)).toEqual([]);
    await expect(button).toHaveAttribute("aria-label", "再起動して v9.9.9 にする");
  });

  it("keeps settings at the bottom edge with no account, no Claude and no update button", async () => {
    await boot({ inbox: { ...inbox(), accounts: [], threads: [], historyIds: {} }, claude_status: claudeMissing });
    await waitForCalls("claude_status");
    expect(await bottomGroup()).toEqual(["nav-settings"]);
    // The bottom group ends 16px above the window's bottom edge.
    expect(await browser.execute(() => Math.round(innerHeight - document.getElementById("nav-settings")!.getBoundingClientRect().bottom))).toBe(16);
  });

  // Waits until the last set_badge call is `args`.
  const waitForBadge = (args: { count: number; upcoming: number[] }) =>
    browser.waitUntil(async () => JSON.stringify((await callsOf("set_badge")).at(-1)) === JSON.stringify(args), {
      timeoutMsg: `set_badge was not called with ${JSON.stringify(args)}`,
    });

  it("sets the Dock badge to the unread threads plus the tasks that are due, and sends the moments of those still ahead", async () => {
    const todo = todoData();
    todo.tasks.push(task("k5", "Late bill", "p0", "overdue"), task("k6", "Someday", "p0", "upcoming"));
    // 2 unread threads, and "Write report" (today, no time) and "Late bill" (yesterday); "Someday" is due tomorrow 00:00.
    await boot({ inbox: inbox(), todoist_load: todo, claude_status: claudeReady });
    await waitForBadge({ count: 4, upcoming: [moment(1)] });
  });

  it("counts a task from its due moment: a time ahead and tomorrow are not counted, a time that has come and a day with no time are, and no due date never is", async () => {
    const todo = todoData();
    todo.tasks.push(
      dueToday(task("k5", "Morning", "p0", "today"), "08:00"),
      dueToday(task("k6", "Noon", "p0", "today"), "12:00"),
      dueToday(task("k7", "All day", "p0", "today"), null),
      task("k8", "Yesterday", "p0", "overdue"),
      task("k9", "Tomorrow", "p0", "upcoming"),
    );
    await boot({ inbox: inbox(), todoist_load: todo, claude_status: claudeReady });
    // A load that never answers: only the clock can move the count from here.
    const load = await mock("todoist_load", holds);
    await setClock(`${today}T07:59:00`);
    // 2 unread threads; "Write report", "All day" and "Yesterday" (00:00) have come; "Morning", "Noon" and "Tomorrow" are ahead.
    await waitForBadge({ count: 5, upcoming: [moment(0, "08:00"), moment(0, "12:00"), moment(1)] });
    await expect($("#nav-todo .nav-count")).toHaveText("3");
    await expect($("#nav-todo")).toHaveAttribute("aria-label", "Todo（期限到来 3 件）");
    // 08:00:30 is 08:00 to the minute, and 12:00 comes on the dot.
    await setClock(`${today}T08:00:30`);
    await waitForBadge({ count: 6, upcoming: [moment(0, "12:00"), moment(1)] });
    await expect($("#nav-todo .nav-count")).toHaveText("4");
    await setClock(`${today}T12:00:00`);
    await waitForBadge({ count: 7, upcoming: [moment(1)] });
    await expect($("#nav-todo .nav-count")).toHaveText("5");
    // A held load is not an answer: the count came from the remembered tasks.
    expect((await callsOf(load)).length).toBeLessThanOrEqual(1);
  });

  it("orders the sidebar as mail, calendar, the Google accounts, Todo, Slack, then the bottom group", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    await waitForCalls("claude_status");
    const ids = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#sidebar > *")].filter((e) => e.offsetParent !== null).map((e) => e.id));
    expect(ids).toEqual(["nav-mail", "nav-calendar", "account-list", "nav-todo", "nav-slack", "sidebar-bottom"]);
    await expect($("#nav-slack")).toHaveAttribute("aria-label", "Slack");
  });

  it("shows no update button when this is the latest version", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCalls("check_update");
    await expect($("#update-btn")).not.toBeDisplayed();
    await expect($("#nav-settings .nav-dot")).not.toBeDisplayed();
    await expect($("#nav-settings")).toHaveAttribute("aria-label", "設定");
  });
});

// The accounts of a function sit under its icon, and only while that function is shown.
describe("sidebar: the account trays", () => {
  const shown = (selector: string) => browser.execute((q) => document.querySelector<HTMLElement>(q)!.offsetParent !== null, selector);
  // [the Google accounts, the Slack workspaces]
  const trays = async () => [await shown("#account-list"), await shown("#slack-workspace-list")];
  const messages = () => [timelineMessage(slackTs(5, 1), "Alice Example", "dev", "Please review the deploy notes.")];

  async function start(fixtures: Record<string, unknown> = {}) {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(messages()), claude_status: claudeReady, calendar_week: weekOfToday(), ...fixtures });
    await waitForCount("#unread-threads li", 2);
  }

  it("shows the Google accounts alone on the inbox and on an open mail", async () => {
    await start();
    expect(await trays()).toEqual([true, false]);
    await mock("thread", threadDetail("First unread", "Hello", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("First unread");
    expect(await trays()).toEqual([true, false]);
  });

  it("keeps the Google accounts on the Slack compose screen of a mail", async () => {
    await start();
    await mock("thread", threadDetail("First unread", "Hello", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await mock("slack_preview", slackPreview);
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    expect(await trays()).toEqual([true, false]);
  });

  it("shows the Google accounts alone on the calendar", async () => {
    await start();
    await $("#nav-calendar").click();
    await expect($("#calendar")).toBeDisplayed();
    expect(await trays()).toEqual([true, false]);
  });

  it("shows no tray on Todo", async () => {
    await start();
    await $("#nav-todo").click();
    await expect($("#todo")).toBeDisplayed();
    expect(await trays()).toEqual([false, false]);
  });

  it("shows the Slack workspaces alone on the Slack list and on a thread", async () => {
    await start();
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await trays()).toEqual([false, true]);
    expect(await browser.execute(() => document.querySelectorAll("#slack-workspace-list button").length)).toBe(1);
    await mock("slack_thread", { teamId: workspace.teamId, channel: "C0123ABCD", ts: messages()[0].ts, messages: [], truncated: false });
    await $("#slack-feed .feed-row").click();
    await expect($("#slack-thread")).toBeDisplayed();
    expect(await trays()).toEqual([false, true]);
  });

  it("shows no tray on the settings, nor on the prompt screen reached from them", async () => {
    await start();
    await $("#nav-settings").click();
    await expect($("#settings")).toBeDisplayed();
    expect(await trays()).toEqual([false, false]);
    await $("#settings-tab-claude").click();
    await $("#claude-prompt .text-btn").click();
    await expect($("#prompt")).toBeDisplayed();
    expect(await trays()).toEqual([false, false]);
  });

  it("draws the avatars of a tray 28px round on the tray's own background, with no tray at all when it is empty", async () => {
    await start();
    const box = await browser.execute(() => {
      const tray = document.getElementById("account-list")!;
      const avatar = tray.querySelector<HTMLElement>(".avatar")!.getBoundingClientRect();
      const style = getComputedStyle(tray);
      return { w: avatar.width, h: avatar.height, radius: style.borderRadius, bg: style.backgroundColor, side: getComputedStyle(document.getElementById("nav-mail")!.parentElement!).backgroundColor };
    });
    expect([box.w, box.h, box.radius]).toEqual([28, 28, "12px"]);
    expect(box.bg).not.toBe(box.side);
    await boot({ inbox: { ...inbox(), accounts: [], threads: [], historyIds: {} }, claude_status: claudeMissing });
    await waitForCalls("claude_status");
    expect(await shown("#account-list")).toBe(false);
  });

  it("opens the account popup beside its avatar, and closes it when the screen changes", async () => {
    await start();
    await $('#account-list button[aria-label="me@example.com"]').click();
    const popup = $("#account-popup");
    await expect(popup).toBeDisplayed();
    const [avatarTop, popupTop, sideRight, popupLeft] = await browser.execute(() => [
      document.querySelector("#account-list .avatar")!.getBoundingClientRect().top,
      document.getElementById("account-popup")!.getBoundingClientRect().top,
      document.getElementById("sidebar")!.getBoundingClientRect().right,
      document.getElementById("account-popup")!.getBoundingClientRect().left,
    ]);
    expect(Math.abs(popupTop - avatarTop)).toBeLessThan(2);
    expect(Math.round(popupLeft - sideRight)).toBe(8);
    await $("#nav-todo").click();
    await expect(popup).not.toBeDisplayed();
  });

  it("opens a workspace's popup from its avatar with the name, the user, the state and 設定を開く, and the avatar's tooltip is the name", async () => {
    await start();
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    const avatar = $("#slack-workspace-list button");
    await expect(avatar).toHaveAttribute("aria-label", workspace.team);
    await avatar.click();
    const popup = $("#account-popup");
    await expect(popup).toBeDisplayed();
    await expect(popup).toHaveText(expect.stringContaining(workspace.team));
    await expect(popup).toHaveText(expect.stringContaining(workspace.user));
    await expect(popup.$(".status")).toHaveText("接続済み");
    await expect(popup.$(".status")).toHaveElementClass("ok");
    await popup.$("button=設定を開く").click();
    await expect($("#settings")).toBeDisplayed();
    await expect($("#settings-tab-slack")).toHaveAttribute("aria-selected", "true");
    await expect(popup).not.toBeDisplayed();
  });

  it("says in the workspace's popup that its messages could not be read", async () => {
    await start({ slack_timeline: timeline(messages(), { failed: [{ teamId: workspace.teamId, team: workspace.team, error: "接続できません" }] }) });
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-workspace-list button").click();
    await expect($("#account-popup .status")).toHaveText("読み込み失敗");
    await expect($("#account-popup .status")).toHaveElementClass("warn");
    await expect($("#account-popup")).toHaveText(expect.stringContaining("接続できません"));
  });

  it("shows the user's own icon on the workspace's avatar, and the initial on the workspace's color until then", async () => {
    const iconUrl = "https://avatars.slack-edge.com/T1-U1/a_72.png";
    await start({ slack_icons: ownIcon(iconUrl) });
    await mock("fetch_images", { [iconUrl]: pngUri });
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll("#slack-workspace-list img.av-img").length)) === 1);
    expect(await browser.execute(() => document.querySelector<HTMLImageElement>("#slack-workspace-list img.av-img")!.src)).toBe(pngUri);
  });
});
