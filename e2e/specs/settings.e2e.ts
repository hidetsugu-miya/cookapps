import { account, boot, checked, claudeLoggedOut, claudeMissing, claudeReady, inbox, mock, slackLoad, waitForCalls, waitForText, callsOf } from "../support";

// The app with one Slack workspace whose token `slack_check` judges as given, and the settings screen open.
async function openSettings(missingScopes: string[], claude: unknown = claudeMissing) {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked(missingScopes), claude_status: claude });
  await $("#nav-settings").click();
  await expect($("#settings")).toBeDisplayed();
}

const unlinkButton = () => $('button[aria-label="Example Team の接続を解除"]');

describe("settings: Google", () => {
  const meta = () => $("#google-accounts .item-meta");

  it("lists each account like the sidebar avatar, with its state and unread count", async () => {
    await openSettings([]);
    await expect($("#google-accounts .item-name")).toHaveText(account);
    await waitForText("#google-accounts .item-meta", "ログイン中 · 未読 2");
    await expect(meta()).not.toHaveElementClass("warn");
    const [side, card] = await browser.execute(() =>
      ["#account-list .avatar", "#google-accounts .avatar"].map((s) => {
        const e = document.querySelector<HTMLElement>(s)!;
        return [e.textContent, e.style.background];
      }),
    );
    expect(card).toEqual(side);
    await expect($("#google-accounts button")).not.toExist();
  });

  it("warns on an account that needs a login", async () => {
    await boot({ inbox: { ...inbox(), needsLogin: [account] }, slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing });
    await $("#nav-settings").click();
    await waitForText("#google-accounts .item-meta", "再ログインが必要です");
    await expect(meta()).toHaveElementClass("warn");
  });

  it("shows an empty note with no account", async () => {
    await boot({ inbox: { ...inbox(), accounts: [], threads: [], historyIds: {} }, slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing });
    await $("#nav-settings").click();
    await expect($("#google-accounts .card-empty")).toHaveText("アカウントはまだありません");
  });

  it("calls login with no hint from アカウントを追加", async () => {
    await openSettings([]);
    const login = await mock("login", account);
    await $("#google-add").click();
    expect(await waitForCalls(login)).toEqual([{ loginHint: null }]);
  });
});

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

describe("settings: update", () => {
  const openUpdate = async (fixtures: Record<string, unknown> = {}) => {
    await boot({ inbox: inbox(), ...fixtures });
    await $("#nav-settings").click();
    await expect($("#settings")).toBeDisplayed();
  };
  const status = () => $("#update-items .status");
  const modeButton = (label: string) => $("#update-items").$(`button=${label}`);

  it("shows the running version from app_info and that this is the latest", async () => {
    await openUpdate({ app_info: { version: "0.15.0", updatable: true } });
    await expect($("#update-items .item-name")).toHaveText("v0.15.0");
    await expect(status()).toHaveText("最新");
  });

  it("says a newer version is out while the mode is manual, and replaced once the mode is auto", async () => {
    await openUpdate({ update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    await expect(status()).toHaveText("v9.9.9 があります");
    expect(await callsOf("install_update")).toEqual([]);
    await openUpdate({ update_mode: "auto", check_update: { version: "9.9.9", installed: false } });
    await expect(status()).toHaveText("再起動で v9.9.9 になります");
  });

  it("shows the version and 対応していません without checking where the app cannot update itself", async () => {
    await openUpdate({ app_info: { version: "0.15.0", updatable: false } });
    await expect($("#update-items .item-name")).toHaveText("v0.15.0");
    await expect(status()).toHaveText("対応していません");
    await expect($("#update-recheck")).toBeDisabled();
    expect(await callsOf("check_update")).toEqual([]);
  });

  it("saves the mode with set_update_mode, and marks the chosen one", async () => {
    await openUpdate({ update_mode: "manual" });
    await expect(modeButton("手動")).toHaveAttribute("aria-pressed", "true");
    await expect(modeButton("自動")).toHaveAttribute("aria-pressed", "false");
    const save = await mock("set_update_mode", null);
    await modeButton("自動").click();
    expect(await waitForCalls(save)).toEqual([{ mode: "auto" }]);
    await expect(modeButton("自動")).toHaveAttribute("aria-pressed", "true");
    await modeButton("手動").click();
    expect(await waitForCalls(save, 2)).toEqual([{ mode: "auto" }, { mode: "manual" }]);
    await expect(modeButton("手動")).toHaveAttribute("aria-pressed", "true");
  });

  it("replaces a newer version found earlier as soon as the mode becomes auto", async () => {
    await openUpdate({ update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    await expect(status()).toHaveText("v9.9.9 があります");
    const install = await mock("install_update", null);
    await modeButton("自動").click();
    expect(await waitForCalls(install)).toEqual([null]);
    await expect(status()).toHaveText("再起動で v9.9.9 になります");
  });

  it("checks again on 今すぐ確認, and redraws the card and the sidebar button", async () => {
    await openUpdate();
    await expect(status()).toHaveText("最新");
    await expect($("#update-btn")).not.toBeDisplayed();
    const check = await mock("check_update", { version: "9.9.9", installed: false });
    await $("#update-recheck").click();
    expect(await waitForCalls(check)).toEqual([null]);
    await expect(status()).toHaveText("v9.9.9 があります");
    await expect($("#update-btn")).toHaveAttribute("aria-label", "v9.9.9 に更新");
  });
});
