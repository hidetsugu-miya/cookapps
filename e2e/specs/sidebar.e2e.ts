import { boot, callsOf, claudeLoggedOut, claudeMissing, claudeReady, inbox, mock, task, todoData, waitForCalls } from "../support";

// The ids of what the sidebar's bottom group shows, top to bottom.
const bottomGroup = () =>
  browser.execute(() => [...document.querySelectorAll<HTMLElement>("#sidebar-bottom > *")].filter((e) => e.offsetParent !== null).map((e) => e.id));

describe("sidebar", () => {
  it("shows the Claude avatar while logged in, and its popup on a click", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    const button = $("#claude-btn");
    await expect(button).toBeDisplayed();
    await expect(button).toHaveAttribute("aria-label", "Claude: claude@example.com");
    // The bottom group is the account avatars, then Claude, then settings last.
    expect(await bottomGroup()).toEqual(["account-list", "claude-btn", "nav-settings"]);
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
    // The update button comes first in the bottom group, above the accounts.
    expect(await bottomGroup()).toEqual(["update-btn", "account-list", "claude-btn", "nav-settings"]);
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

  it("sets the Dock badge to the unread threads plus the overdue and today tasks", async () => {
    const todo = todoData();
    todo.tasks.push(task("k5", "Late bill", "p0", "overdue"), task("k6", "Someday", "p0", "upcoming"));
    // 2 unread threads, and "Write report" (today) and "Late bill" (overdue).
    await boot({ inbox: inbox(), todoist_load: todo, claude_status: claudeReady });
    await browser.waitUntil(async () => JSON.stringify((await callsOf("set_badge")).at(-1)) === JSON.stringify({ count: 4 }), {
      timeoutMsg: "set_badge was not called with 4",
    });
  });

  it("shows no update button when this is the latest version", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCalls("check_update");
    await expect($("#update-btn")).not.toBeDisplayed();
    await expect($("#nav-settings .nav-dot")).not.toBeDisplayed();
    await expect($("#nav-settings")).toHaveAttribute("aria-label", "設定");
  });
});
