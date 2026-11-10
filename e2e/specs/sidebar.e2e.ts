import { boot, callsOf, claudeLoggedOut, claudeMissing, claudeReady, dueToday, holds, inbox, mock, ownIcon, pngUri, rejects, release, rowOf, setClock, slackLoad, slackPreview, slackTs, task, threadDetail, threadLoaded, timeline, timelineMessage, today, todoData, waitForCalls, waitForCount, weekOfToday, workspace } from "../support";

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

  it("starts the icons below the traffic lights, and is a place to drag the window by", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await expect($("#sidebar")).toHaveAttribute("data-tauri-drag-region");
    // The traffic lights sit at the top of the column (trafficLightPosition y 20, 14px high); the first icon starts under them.
    const top = await browser.execute(() => document.getElementById("nav-mail")!.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(40);
    // A press on an icon is not a drag.
    await expect($("#nav-mail")).not.toHaveAttribute("data-tauri-drag-region");
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

  const popup = () => $("#update-pop");
  const rectOf = (selector: string) =>
    browser.execute((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width };
    }, selector);
  // Runs the settings card's "今すぐ確認" as the settings screen would, so the popup can be checked without leaving the screen.
  const recheck = () => browser.execute(() => document.getElementById("update-recheck")!.click());

  it("manual: shows the popup at the bottom right with the new version, and on a press replaces the app and restarts it", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    await popup().waitForDisplayed();
    await expect($("#update-pop-title")).toHaveText("v9.9.9 があります");
    await expect($("#update-pop-text")).toHaveText("入れ替えて再起動します");
    await expect($("#update-later")).toHaveText("あとで");
    await expect($("#update-go")).toHaveText("更新して再起動");
    // 320px wide, 24px from the right and bottom edges, and it takes no focus.
    const rect = await rectOf("#update-pop");
    expect({ width: rect.width, right: await browser.execute(() => innerWidth), bottom: await browser.execute(() => innerHeight) }).toEqual({ width: 320, right: rect.right + 24, bottom: rect.bottom + 24 });
    expect(await browser.execute(() => document.getElementById("update-pop")!.contains(document.activeElement))).toBe(false);
    await expect($("#nav-settings .nav-dot")).toBeDisplayed();
    await expect($("#nav-settings")).toHaveAttribute("aria-label", "設定（v9.9.9 があります）");
    // The sidebar has no update button any more: the bottom group is Claude, then settings.
    expect(await bottomGroup()).toEqual(["claude-btn", "nav-settings"]);
    expect(await callsOf("install_update")).toEqual([]);
    const install = await mock("install_update", null);
    const restart = await mock("restart_app", null);
    await $("#update-go").click();
    expect(await waitForCalls(restart)).toEqual([null]);
    expect(await callsOf(install)).toEqual([null]);
  });

  it("auto: replaces the app by itself, then the popup asks for a restart and the button restarts the app and nothing else", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "auto", check_update: { version: "9.9.9", installed: false } });
    expect(await waitForCalls("install_update")).toEqual([null]);
    await popup().waitForDisplayed();
    await expect($("#update-pop-title")).toHaveText("新しい版の準備ができました");
    await expect($("#update-pop-text")).toHaveText("再起動すると v9.9.9 になります");
    await expect($("#update-go")).toHaveText("再起動");
    expect(await callsOf("restart_app")).toEqual([]);
    // From now on the backend says the app is replaced.
    const check = await mock("check_update", { version: "9.9.9", installed: true });
    const install = await mock("install_update", null);
    const restart = await mock("restart_app", null);
    await $("#update-go").click();
    expect(await waitForCalls(restart)).toEqual([null]);
    await waitForCalls(check);
    expect(await callsOf(install)).toEqual([]);
    await expect(popup()).toBeDisplayed();
    await expect($("#update-go")).toHaveText("再起動");
  });

  it("auto: while the restart waits, a version newer than the replaced one is replaced too, and the same version is not", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "auto", check_update: { version: "9.9.9", installed: false } });
    expect(await waitForCalls("install_update")).toEqual([null]);
    await expect($("#update-pop-text")).toHaveText("再起動すると v9.9.9 になります");
    const same = await mock("check_update", { version: "9.9.9", installed: true });
    const install = await mock("install_update", null);
    await recheck();
    await waitForCalls(same);
    await browser.pause(300);
    expect(await callsOf(install)).toEqual([]);
    const newer = await mock("check_update", { version: "9.9.10", installed: false });
    await recheck();
    await waitForCalls(newer);
    expect(await waitForCalls(install)).toEqual([null]);
    await expect($("#update-pop-title")).toHaveText("新しい版の準備ができました");
    await expect($("#update-pop-text")).toHaveText("再起動すると v9.9.10 になります");
    await expect($("#update-go")).toHaveText("再起動");
  });

  it("waits while the update is on its way, and on a failure shows the error and keeps the popup", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    await popup().waitForDisplayed();
    const install = await mock("install_update", holds);
    const restart = await mock("restart_app", null);
    await $("#update-go").click();
    await waitForCalls(install);
    await expect($("#update-go")).toBeDisabled();
    await release(install, rejects("disk full"));
    await expect($("#error")).toHaveText(expect.stringContaining("disk full"));
    await expect(popup()).toBeDisplayed();
    await expect($("#update-go")).toBeEnabled();
    expect(await callsOf(restart)).toEqual([]);
  });

  it("closes with あとで for that version only: the same version stays away, a newer one shows it, and the dot stays", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    await popup().waitForDisplayed();
    await $("#update-later").click();
    await expect(popup()).not.toBeDisplayed();
    await expect($("#nav-settings .nav-dot")).toBeDisplayed();
    await expect($("#settings-tab-update .tab-dot")).toExist();
    const same = await mock("check_update", { version: "9.9.9", installed: false });
    await recheck();
    await waitForCalls(same);
    await browser.pause(300);
    await expect(popup()).not.toBeDisplayed();
    const newer = await mock("check_update", { version: "9.9.10", installed: false });
    await recheck();
    await waitForCalls(newer);
    await popup().waitForDisplayed();
    await expect($("#update-pop-title")).toHaveText("v9.9.10 があります");
  });

  it("stacks a toast above the popup while it shows, and puts it back at the corner when the popup closes", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    await waitForCount("#unread-threads li", 2);
    await popup().waitForDisplayed();
    await mock("archive", true);
    const row = rowOf("unread-threads", "First unread");
    await row.moveTo();
    await row.$(".archive-row").click();
    await expect($(".toast")).toBeDisplayed();
    const toast = await rectOf(".toast");
    const pop = await rectOf("#update-pop");
    expect(toast.bottom).toBeLessThanOrEqual(pop.top);
    expect(toast.right).toBe(pop.right);
    await $("#update-later").click();
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".toast")!).bottom)).toBe("24px");
  });

  it("keeps settings at the bottom edge with no account, no Claude and no update", async () => {
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
    const someday = task("k6", "Someday", "p0", "upcoming");
    todo.tasks.push(task("k5", "Late bill", "p0", "overdue"), someday);
    // 2 unread threads, and "Write report" (today, no time) and "Late bill" (yesterday); "Someday" is due tomorrow 00:00.
    await boot({ inbox: inbox(), todoist_load: todo, claude_status: claudeReady });
    await waitForBadge({ count: 4, upcoming: [someday.dueAt!] });
  });

  it("counts a task from its due moment: a time ahead and tomorrow are not counted, a time that has come and a day with no time are, and no due date never is", async () => {
    const todo = todoData();
    const [morning, noon, tomorrow] = [dueToday(task("k5", "Morning", "p0", "today"), "08:00"), dueToday(task("k6", "Noon", "p0", "today"), "12:00"), task("k9", "Tomorrow", "p0", "upcoming")];
    todo.tasks.push(morning, noon, dueToday(task("k7", "All day", "p0", "today"), null), task("k8", "Yesterday", "p0", "overdue"), tomorrow);
    await boot({ inbox: inbox(), todoist_load: todo, claude_status: claudeReady });
    // A load that never answers: only the clock can move the count from here.
    const load = await mock("todoist_load", holds);
    await setClock(`${today}T07:59:00`);
    // 2 unread threads; "Write report", "All day" and "Yesterday" (00:00) have come; "Morning", "Noon" and "Tomorrow" are ahead.
    await waitForBadge({ count: 5, upcoming: [morning.dueAt!, noon.dueAt!, tomorrow.dueAt!] });
    await expect($("#nav-todo .nav-count")).toHaveText("3");
    await expect($("#nav-todo")).toHaveAttribute("aria-label", "Todo（期限到来 3 件）");
    // 08:00:30 is 08:00 to the minute, and 12:00 comes on the dot.
    await setClock(`${today}T08:00:30`);
    await waitForBadge({ count: 6, upcoming: [noon.dueAt!, tomorrow.dueAt!] });
    await expect($("#nav-todo .nav-count")).toHaveText("4");
    await setClock(`${today}T12:00:00`);
    await waitForBadge({ count: 7, upcoming: [tomorrow.dueAt!] });
    await expect($("#nav-todo .nav-count")).toHaveText("5");
    // A held load is not an answer: the count came from the remembered tasks.
    expect((await callsOf(load)).length).toBeLessThanOrEqual(1);
  });

  it("orders the sidebar as mail, calendar, the Google accounts, Todo, Slack, Orca, then the bottom group", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    await waitForCalls("claude_status");
    const ids = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#sidebar > *")].filter((e) => e.offsetParent !== null).map((e) => e.id));
    expect(ids).toEqual(["nav-mail", "nav-calendar", "account-list", "nav-todo", "nav-slack", "nav-orca", "sidebar-bottom"]);
    await expect($("#nav-slack")).toHaveAttribute("aria-label", "Slack");
  });

  it("shows no update popup when this is the latest version", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCalls("check_update");
    await expect(popup()).not.toBeDisplayed();
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
    await threadLoaded();
    expect(await trays()).toEqual([true, false]);
  });

  it("keeps the Google accounts on the Slack compose screen of a mail", async () => {
    await start();
    await mock("thread", threadDetail("First unread", "Hello", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await threadLoaded();
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
    await $("#slack-feed .feed-open").click();
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
