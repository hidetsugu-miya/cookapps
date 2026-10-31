import { boot, callsOf, claudeLoggedOut, claudeMissing, claudeReady, inbox, mock, waitForCalls, waitForText } from "../support";

describe("sidebar", () => {
  it("shows the Claude avatar while logged in, and its popup on a click", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    const button = $("#claude-btn");
    await expect(button).toBeDisplayed();
    await expect(button).toHaveAttribute("aria-label", "Claude: claude@example.com");
    // Integrations sit just above settings, apart from the accounts at the bottom.
    expect(await browser.execute(() => document.getElementById("claude-btn")?.nextElementSibling?.id)).toBe("nav-settings");
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

  for (const [name, status, label] of [
    ["Claude Code is missing", claudeMissing, "未導入"],
    ["Claude is logged out", claudeLoggedOut, "未ログイン"],
  ] as const) {
    it(`hides the Claude avatar when ${name}`, async () => {
      await boot({ inbox: inbox(), claude_status: status });
      // The settings card is hidden but drawn from the same answer: once it shows the state, the sidebar has heard it too.
      await waitForText("#claude-items .status", label);
      await expect($("#claude-btn")).not.toBeDisplayed();
    });
  }

  it("manual: shows the update button with the new version, and on a press replaces the app and restarts it", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    const button = $("#update-btn");
    await button.waitForDisplayed();
    await expect(button).toHaveAttribute("aria-label", "v9.9.9 に更新");
    // The bottom group starts at the update button: only it takes the free space above, and the Claude avatar and settings follow it.
    const margins = await browser.execute(() => ["update-btn", "claude-btn", "nav-settings"].map((id) => getComputedStyle(document.getElementById(id)!).marginTop));
    expect(margins[0]).not.toBe("0px");
    expect(margins.slice(1)).toEqual(["0px", "0px"]);
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

  it("shows no update button when this is the latest version", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCalls("check_update");
    await expect($("#update-btn")).not.toBeDisplayed();
  });
});
