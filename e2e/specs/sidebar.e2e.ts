import { boot, claudeLoggedOut, claudeMissing, claudeReady, inbox, mock, waitForCalls, waitForText } from "../support";

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

  it("shows the update button with the new version, and installs on a press", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady, check_update: { version: "9.9.9" } });
    const button = $("#update-btn");
    await button.waitForDisplayed();
    await expect(button).toHaveAttribute("aria-label", "v9.9.9 に更新");
    // The bottom group starts at the update button: only it takes the free space above, and the Claude avatar and settings follow it.
    const margins = await browser.execute(() => ["update-btn", "claude-btn", "nav-settings"].map((id) => getComputedStyle(document.getElementById(id)!).marginTop));
    expect(margins[0]).not.toBe("0px");
    expect(margins.slice(1)).toEqual(["0px", "0px"]);
    const install = await mock("install_update", null);
    await button.click();
    expect(await waitForCalls(install)).toEqual([null]);
  });

  it("shows no update button when this is the latest version", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCalls("check_update");
    await expect($("#update-btn")).not.toBeDisplayed();
  });
});
