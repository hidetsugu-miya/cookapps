import { account, boot, checked, claudeLoggedOut, claudeMissing, claudeReady, holds, inbox, mock, rejects, release, slackLoad, textsOf, todoData, todoPrompt, waitForCalls, waitForText, weekOfToday, callsOf } from "../support";

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
    await waitForText("#google-accounts .item-meta", "未読 2");
    await expect($("#google-accounts .status.ok")).toHaveText("ログイン中");
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
    await waitForText("#google-accounts .item-meta", "再ログインが必要です · 未読");
    await expect($("#google-accounts .status.warn")).toHaveText("要再ログイン");
    await expect(meta()).toHaveElementClass("warn");
    const login = await mock("login", account);
    await $("#google-accounts .item .text-btn").click();
    expect(await waitForCalls(login)).toEqual([{ loginHint: account }]);
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

describe("settings: calendar", () => {
  const dayButton = (label: string) => $("#calendar-items").$(`button=${label}`);
  const openCalendarSettings = async (fixtures: Record<string, unknown> = {}) => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), calendar_week: weekOfToday(), ...fixtures });
    await $("#nav-settings").click();
    await expect($("#calendar-items .item-name")).toHaveText("週の始まり");
  };

  it("lists Sunday to Saturday and marks the saved first day", async () => {
    await openCalendarSettings({ calendar_first_day: 3 });
    expect(await textsOf("#calendar-items .text-btn")).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
    await expect(dayButton("水")).toHaveAttribute("aria-pressed", "true");
    await expect(dayButton("日")).toHaveAttribute("aria-pressed", "false");
    // The card follows the Google card.
    expect(await browser.execute(() => document.querySelector("#google-accounts")?.closest(".card")?.nextElementSibling?.contains(document.getElementById("calendar-items")))).toBe(true);
  });

  it("saves the chosen day with set_calendar_first_day, and the next calendar view asks for weeks with it", async () => {
    await openCalendarSettings();
    await expect(dayButton("日")).toHaveAttribute("aria-pressed", "true");
    const save = await mock("set_calendar_first_day", null);
    await dayButton("月").click();
    expect(await waitForCalls(save)).toEqual([{ firstDay: 1 }]);
    await expect(dayButton("月")).toHaveAttribute("aria-pressed", "true");
    await expect(dayButton("日")).toHaveAttribute("aria-pressed", "false");
    const week = await mock("calendar_week", weekOfToday(1));
    await $("#nav-calendar").click();
    const calls = (await waitForCalls(week)) as { firstDay: number; refresh: boolean }[];
    expect(calls.every((c) => c.firstDay === 1)).toBe(true);
    // Only the weeks are dropped: the calendar lists are not asked for again.
    expect(calls.every((c) => !c.refresh)).toBe(true);
  });

  it("ignores another day pressed while a day is being saved", async () => {
    await openCalendarSettings();
    const save = await mock("set_calendar_first_day", holds);
    await dayButton("月").click();
    await waitForCalls(save);
    await dayButton("火").click();
    await release(save, null);
    await expect(dayButton("月")).toHaveAttribute("aria-pressed", "true");
    expect(await callsOf(save)).toEqual([{ firstDay: 1 }]);
  });

  it("keeps the selection and shows the error when the day cannot be saved", async () => {
    await openCalendarSettings();
    await mock("set_calendar_first_day", rejects("保存できません"));
    await dayButton("火").click();
    await expect($("#error")).toHaveText(expect.stringContaining("保存できません"));
    await expect(dayButton("日")).toHaveAttribute("aria-pressed", "true");
    await expect(dayButton("火")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("settings: Todoist", () => {
  const unlink = () => $('button[aria-label="Todoist の接続を解除"]');
  const openTodoistSettings = async (fixtures: Record<string, unknown> = {}) => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, ...fixtures });
    await $("#nav-settings").click();
    await expect($("#settings")).toBeDisplayed();
  };

  it("shows the card between カレンダー and Slack, connected with a button to unlink", async () => {
    await openTodoistSettings({ todoist_connected: true });
    await expect($("#todoist-items .item-name")).toHaveText("Todoist");
    await expect($("#todoist-items .status")).toHaveText("接続済み");
    await expect($("#todoist-items .status")).toHaveElementClass("ok");
    await expect(unlink()).toExist();
    expect(
      await browser.execute(() => {
        const card = document.getElementById("todoist-items")!.closest(".card")!;
        return [card.previousElementSibling!.contains(document.getElementById("calendar-items")), card.nextElementSibling!.contains(document.getElementById("slack-workspaces"))];
      }),
    ).toEqual([true, true]);
  });

  it("says 未接続 and where to enter the token, with no button, when there is no token", async () => {
    await openTodoistSettings({ todoist_connected: false });
    await expect($("#todoist-items .status")).toHaveText("未接続");
    await expect($("#todoist-items .status")).toHaveElementClass("off");
    await expect($("#todoist-items .item-meta")).toHaveText("Todo 画面でトークンを入力します");
    await expect($("#todoist-items button")).not.toExist();
  });

  it("asks before disconnecting: キャンセル sends nothing, 解除 calls todoist_disconnect, the row becomes 未接続 and the Todo count goes", async () => {
    await openTodoistSettings({ todoist_connected: true, todoist_load: todoData() });
    await waitForText("#nav-todo .nav-count", "1");
    const disconnect = await mock("todoist_disconnect", null);
    // With no token, Todoist has nothing to load.
    await mock("todoist_load", null);

    await unlink().click();
    const dialog = $('[role="alertdialog"]');
    await expect(dialog).toBeDisplayed();
    await expect(dialog).toHaveText(expect.stringContaining("Todoist のタスクは残ります"));
    await dialog.$("button=キャンセル").click();
    await expect(dialog).not.toExist();
    expect(await callsOf(disconnect)).toHaveLength(0);

    await unlink().click();
    await $('[role="alertdialog"]').$("button=解除").click();
    expect(await waitForCalls(disconnect)).toEqual([null]);
    await expect($("#todoist-items .status")).toHaveText("未接続");
    await expect($("#todoist-items button")).not.toExist();
    await expect($("#nav-todo .nav-count")).not.toBeDisplayed();
  });

  it("shows the error and keeps the row when the token cannot be removed", async () => {
    await openTodoistSettings({ todoist_connected: true });
    await mock("todoist_disconnect", rejects("資格情報を消せません"));
    await unlink().click();
    await $('[role="alertdialog"]').$("button=解除").click();
    await expect($("#error")).toHaveText(expect.stringContaining("資格情報を消せません"));
    await expect($("#todoist-items .status")).toHaveText("接続済み");
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

describe("settings: Claude model and effort", () => {
  const modelSelect = () => $('#claude-items select[aria-label="モデル"]');
  const effortSelect = () => $('#claude-items select[aria-label="effort"]');
  // Sets a select as the user does (value, then change); the real WebView's select popup is not driven.
  const choose = (label: string, value: string) =>
    browser.execute(
      (l, v) => {
        const select = document.querySelector<HTMLSelectElement>(`#claude-items select[aria-label="${l}"]`)!;
        select.value = v;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      },
      label,
      value,
    );
  const optionTexts = (select: ChainablePromiseElement) => select.$$("option").map((o) => o.getText());

  for (const [state, status] of [["ready", claudeReady], ["loggedOut", claudeLoggedOut], ["missing", claudeMissing]] as const) {
    it(`has its row between the Claude state and the Todo prompt, with the defaults selected, while Claude is ${state}`, async () => {
      await openSettings([], status);
      await expect($("#claude-items .item:nth-child(2) .item-name")).toHaveText("モデルと effort");
      await expect($("#claude-items .item:nth-child(3) .item-name")).toHaveText("Todo の要約プロンプト");
      await expect(modelSelect()).toHaveValue("sonnet");
      await expect(effortSelect()).toHaveValue("medium");
    });
  }

  it("offers the four models and the five efforts, marking the defaults", async () => {
    await openSettings([]);
    expect(await optionTexts(modelSelect())).toEqual(["Haiku", "Sonnet（デフォルト）", "Opus", "Fable"]);
    expect(await optionTexts(effortSelect())).toEqual(["low", "medium（デフォルト）", "high", "xhigh", "max"]);
  });

  it("shows the saved model and effort", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_model_settings: { model: "fable", effort: "xhigh" } });
    await $("#nav-settings").click();
    await expect(modelSelect()).toHaveValue("fable");
    await expect(effortSelect()).toHaveValue("xhigh");
  });

  it("saves on change with claude_model_settings_save, sending both values", async () => {
    await openSettings([]);
    const save = await mock("claude_model_settings_save", { model: "opus", effort: "medium" });
    await choose("モデル", "opus");
    expect(await waitForCalls(save)).toEqual([{ model: "opus", effort: "medium" }]);
    await expect(modelSelect()).toHaveValue("opus");
    const saveEffort = await mock("claude_model_settings_save", { model: "opus", effort: "max" });
    await choose("effort", "max");
    expect(await waitForCalls(saveEffort)).toEqual([{ model: "opus", effort: "max" }]);
    await expect(effortSelect()).toHaveValue("max");
  });

  it("puts the selection back and shows the error when it cannot be saved", async () => {
    await openSettings([]);
    await mock("claude_model_settings_save", rejects("モデルが不正です: x"));
    await choose("モデル", "haiku");
    await expect($("#error")).toHaveText(expect.stringContaining("モデルが不正です"));
    await expect(modelSelect()).toHaveValue("sonnet");
  });

  it("disables the selects while a save is on its way", async () => {
    await openSettings([]);
    const save = await mock("claude_model_settings_save", holds);
    await choose("モデル", "opus");
    await waitForCalls(save);
    await expect(modelSelect()).toBeDisabled();
    await expect(effortSelect()).toBeDisabled();
    await release(save, { model: "opus", effort: "medium" });
    await expect(modelSelect()).toBeEnabled();
    await expect(modelSelect()).toHaveValue("opus");
  });

  it("says in the ? hint that the setting applies to the three Claude calls", async () => {
    await openSettings([]);
    await $("#claude-help").click();
    await expect($('[role="dialog"][aria-label="Claude の使い方"] .foot')).toHaveText(expect.stringContaining("Slack の要約、メールの要約、プロンプトの会話"));
  });
});

describe("settings: Todo prompt", () => {
  const row = () => $("#claude-items .item:nth-child(3)");

  for (const [state, status] of [["ready", claudeReady], ["loggedOut", claudeLoggedOut], ["missing", claudeMissing]] as const) {
    it(`has its row under the Claude state while Claude is ${state}`, async () => {
      await openSettings([], status);
      await expect(row().$(".item-name")).toHaveText("Todo の要約プロンプト");
      await expect(row().$(".status")).toHaveText("デフォルト");
      await expect(row().$(".status")).toHaveElementClass("off");
      await expect(row().$(".text-btn")).toHaveText("確認・編集");
    });
  }

  it("says 編集済み when the instructions were edited", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeReady, claude_todo_prompt: { ...todoPrompt, body: "My body", edited: true } });
    await $("#nav-settings").click();
    await expect(row().$(".status")).toHaveText("編集済み");
    await expect(row().$(".status")).toHaveElementClass("ok");
  });

  it("opens the prompt screen with 確認・編集 and shows the saved instructions there", async () => {
    await openSettings([], claudeReady);
    await expect($("#claude-items .item-name")).toHaveText("claude@example.com");
    await expect(row().$(".status")).toHaveText("デフォルト");
    await row().$(".text-btn").click();
    await expect($("#prompt")).toBeDisplayed();
    await expect($("#settings")).not.toBeDisplayed();
    await expect($("#prompt-body")).toHaveValue(todoPrompt.body);
  });
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
