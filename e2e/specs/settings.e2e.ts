import { boot, checked, claudeLoggedOut, claudeMissing, claudeReady, inbox, mock, slackLoad, waitForCalls, callsOf } from "../support";

// The app with one Slack workspace whose token `slack_check` judges as given, and the settings screen open.
async function openSettings(missingScopes: string[], claude: unknown = claudeMissing) {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked(missingScopes), claude_status: claude });
  await $("#nav-settings").click();
  await expect($("#settings")).toBeDisplayed();
}

const unlinkButton = () => $('button[aria-label="Example Team の接続を解除"]');

describe("settings: Slack", () => {
  it("flags a token without read scopes and lists only the missing ones in the pane", async () => {
    await openSettings(["im:history", "mpim:history"]);
    const status = $("#slack-workspaces .status");
    await expect(status).toHaveText("権限が不足");
    await status.click();
    const pane = $('.pane[aria-modal="true"]');
    await expect(pane).toBeDisplayed();
    await expect(pane).toHaveText(expect.stringContaining("im:history、mpim:history がありません"));
    const scopes = await $$(".pane .scopes code").map((code) => code.getText());
    expect(scopes).toEqual(["im:history", "mpim:history"]);
  });

  it("asks before disconnecting: キャンセル sends nothing, 解除 calls slack_remove_workspace", async () => {
    await openSettings([]);
    const remove = await mock("slack_remove_workspace", []);
    await expect($("#slack-workspaces .status")).toHaveText("接続済み");

    await unlinkButton().click();
    const dialog = $('[role="alertdialog"]');
    await expect(dialog).toBeDisplayed();
    await dialog.$("button=キャンセル").click();
    await expect(dialog).not.toExist();
    expect(await callsOf(remove)).toHaveLength(0);

    await unlinkButton().click();
    await $('[role="alertdialog"]').$("button=解除").click();
    await waitForCalls(remove);
    expect(await callsOf(remove)).toEqual([{ teamId: "T1" }]);
    await expect($("#slack-workspaces")).toHaveText(expect.stringContaining("ワークスペースはまだありません"));
  });
});

describe("settings: Claude", () => {
  for (const [state, status, name, label] of [
    ["ready", claudeReady, "claude@example.com", "ログイン中"],
    ["loggedOut", claudeLoggedOut, "ログインしていません", "未ログイン"],
    ["missing", claudeMissing, "Claude Code が見つかりません", "未導入"],
  ] as const) {
    it(`shows the ${state} state`, async () => {
      await openSettings([], status);
      await expect($("#claude-items .item-name")).toHaveText(name);
      await expect($("#claude-items .status")).toHaveText(label);
    });
  }
});
