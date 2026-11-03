import { account, boot, checked, claudeLoggedOut, claudeMissing, claudeReady, claudeSettings, holds, inbox, mock, rejects, release, slackLoad, textsOf, todoData, todoPrompt, waitForCalls, waitForText, weekOfToday, callsOf } from "../support";

type Tab = "google" | "calendar" | "todoist" | "slack" | "claude" | "update";

// Presses a tab of the settings screen.
const openTab = (tab: Tab) => $(`#settings-tab-${tab}`).click();

// The app with one Slack workspace whose token `slack_check` judges as given, and the settings screen open on `tab` (it opens on Google).
async function openSettings(missingScopes: string[], claude: unknown = claudeMissing, tab: Tab = "google") {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked(missingScopes), claude_status: claude });
  await $("#nav-settings").click();
  await expect($("#settings")).toBeDisplayed();
  if (tab !== "google") await openTab(tab);
}

const TABS: [Tab, string][] = [["google", "Google"], ["calendar", "カレンダー"], ["todoist", "Todoist"], ["slack", "Slack"], ["claude", "Claude"], ["update", "アップデート"]];

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
    await openTab("calendar");
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
    await openTab("todoist");
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
    await openSettings(["im:history", "mpim:history"], claudeMissing, "slack");
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
    await openSettings([], claudeMissing, "slack");
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
      await openSettings([], status, "claude");
      await expect($("#claude-items .item-name")).toHaveText(name);
      await expect($("#claude-items .status")).toHaveText(label);
    });
  }
});

describe("settings: Claude model and effort", () => {
  type Purpose = keyof typeof claudeSettings;
  const PURPOSES: [Purpose, string, string][] = [
    ["slackSummary", "Slack の要約", "Slack のメッセージから Todo を作るとき"],
    ["mailSummary", "メールの要約", "メール詳細の AI 要約"],
    ["promptChat", "プロンプトの会話", "Todo の要約プロンプトを Claude と編集するとき"],
    ["proofread", "Slack に貼る文章の校正", "Slack に貼る画面の「Claude と校正」"],
  ];
  const selectOf = (purpose: Purpose, kind: "model" | "effort") => $(`#claude-items select[data-purpose="${purpose}"][data-kind="${kind}"]`);
  // Sets a select as the user does (value, then change); the real WebView's select popup is not driven.
  const choose = (purpose: Purpose, kind: "model" | "effort", value: string) =>
    browser.execute(
      (p, k, v) => {
        const select = document.querySelector<HTMLSelectElement>(`#claude-items select[data-purpose="${p}"][data-kind="${k}"]`)!;
        select.value = v;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      },
      purpose,
      kind,
      value,
    );
  const optionTexts = (select: ChainablePromiseElement) => select.$$("option").map((o) => o.getText());
  const drawnSelects = () => browser.execute(() => document.querySelectorAll("#claude-items select").length);

  for (const [state, status] of [["ready", claudeReady], ["loggedOut", claudeLoggedOut], ["missing", claudeMissing]] as const) {
    it(`has its block between the Claude state and the Todo prompt, with the defaults selected for the four purposes, while Claude is ${state}`, async () => {
      await openSettings([], status, "claude");
      await expect($("#claude-items > :nth-child(2) .item-name")).toHaveText("モデルと effort");
      await expect($("#claude-items > :nth-child(3) .item-name")).toHaveText("Todo の要約プロンプト");
      expect(await drawnSelects()).toBe(8);
      for (const [purpose] of PURPOSES) {
        await expect(selectOf(purpose, "model")).toHaveValue("sonnet");
        await expect(selectOf(purpose, "effort")).toHaveValue("medium");
      }
    });
  }

  it("names the four purposes in order, each with where it is used, and labels its selects", async () => {
    await openSettings([], claudeReady, "claude");
    const whos = await textsOf("#claude-items .model-grid .who");
    expect(whos).toEqual(PURPOSES.map(([, name, meta]) => `${name}${meta}`));
    for (const [purpose, name] of PURPOSES) {
      await expect(selectOf(purpose, "model")).toHaveAttribute("aria-label", `${name}のモデル`);
      await expect(selectOf(purpose, "effort")).toHaveAttribute("aria-label", `${name}の effort`);
    }
  });

  it("offers the four models and the five efforts for each purpose, marking the defaults", async () => {
    await openSettings([], claudeReady, "claude");
    for (const [purpose] of PURPOSES) {
      expect(await optionTexts(selectOf(purpose, "model"))).toEqual(["Haiku", "Sonnet（デフォルト）", "Opus", "Fable"]);
      expect(await optionTexts(selectOf(purpose, "effort"))).toEqual(["low", "medium（デフォルト）", "high", "xhigh", "max"]);
    }
  });

  it("shows the saved model and effort of each purpose", async () => {
    await boot({
      inbox: inbox(),
      slack_load: slackLoad,
      slack_check: checked([]),
      claude_model_settings: {
        slackSummary: { model: "fable", effort: "xhigh" },
        mailSummary: { model: "haiku", effort: "low" },
        promptChat: { model: "opus", effort: "high" },
        proofread: { model: "sonnet", effort: "max" },
      },
    });
    await $("#nav-settings").click();
    await openTab("claude");
    await expect(selectOf("slackSummary", "model")).toHaveValue("fable");
    await expect(selectOf("slackSummary", "effort")).toHaveValue("xhigh");
    await expect(selectOf("mailSummary", "model")).toHaveValue("haiku");
    await expect(selectOf("mailSummary", "effort")).toHaveValue("low");
    await expect(selectOf("promptChat", "model")).toHaveValue("opus");
    await expect(selectOf("promptChat", "effort")).toHaveValue("high");
    await expect(selectOf("proofread", "model")).toHaveValue("sonnet");
    await expect(selectOf("proofread", "effort")).toHaveValue("max");
  });

  for (const [purpose, name] of PURPOSES) {
    it(`saves ${name} with claude_model_settings_save, sending the purpose and both values, and leaves the other purposes alone`, async () => {
      await openSettings([], claudeReady, "claude");
      const save = await mock("claude_model_settings_save", { ...claudeSettings, [purpose]: { model: "opus", effort: "medium" } });
      await choose(purpose, "model", "opus");
      expect(await waitForCalls(save)).toEqual([{ purpose, model: "opus", effort: "medium" }]);
      await expect(selectOf(purpose, "model")).toHaveValue("opus");
      const saveEffort = await mock("claude_model_settings_save", { ...claudeSettings, [purpose]: { model: "opus", effort: "max" } });
      await choose(purpose, "effort", "max");
      expect(await waitForCalls(saveEffort)).toEqual([{ purpose, model: "opus", effort: "max" }]);
      await expect(selectOf(purpose, "effort")).toHaveValue("max");
      for (const [other] of PURPOSES.filter(([p]) => p !== purpose)) {
        await expect(selectOf(other, "model")).toHaveValue("sonnet");
        await expect(selectOf(other, "effort")).toHaveValue("medium");
      }
    });
  }

  it("puts the selection back and shows the error when it cannot be saved", async () => {
    await openSettings([], claudeReady, "claude");
    await mock("claude_model_settings_save", rejects("モデルが不正です: x"));
    await choose("mailSummary", "model", "haiku");
    await expect($("#error")).toHaveText(expect.stringContaining("モデルが不正です"));
    await expect(selectOf("mailSummary", "model")).toHaveValue("sonnet");
  });

  it("shows the error and no selects when the settings cannot be read", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]) });
    await mock("claude_model_settings", rejects("設定を読めません"));
    await $("#nav-settings").click();
    await openTab("claude");
    await expect($("#error")).toHaveText(expect.stringContaining("設定を読めません"));
    await expect($("#claude-items > :nth-child(2) .item-name")).toHaveText("Todo の要約プロンプト");
    expect(await drawnSelects()).toBe(0);
  });

  it("disables every select while a save is on its way", async () => {
    await openSettings([], claudeReady, "claude");
    const save = await mock("claude_model_settings_save", holds);
    await choose("proofread", "model", "opus");
    await waitForCalls(save);
    for (const [purpose] of PURPOSES) {
      await expect(selectOf(purpose, "model")).toBeDisabled();
      await expect(selectOf(purpose, "effort")).toBeDisabled();
    }
    await release(save, { ...claudeSettings, proofread: { model: "opus", effort: "medium" } });
    await expect(selectOf("proofread", "model")).toBeEnabled();
    await expect(selectOf("proofread", "model")).toHaveValue("opus");
    await expect(selectOf("slackSummary", "effort")).toBeEnabled();
  });

  it("says in the ? hint that each of the four Claude calls has its own setting", async () => {
    await openSettings([], claudeReady, "claude");
    await $("#claude-help").click();
    await expect($('[role="dialog"][aria-label="Claude の使い方"] .foot')).toHaveText(
      expect.stringContaining("Slack の要約、メールの要約、プロンプトの会話、Slack に貼る文章の校正のそれぞれに選べます"),
    );
  });
});

describe("settings: Todo prompt", () => {
  const row = () => $("#claude-items > :nth-child(3)");

  for (const [state, status] of [["ready", claudeReady], ["loggedOut", claudeLoggedOut], ["missing", claudeMissing]] as const) {
    it(`has its row under the Claude state while Claude is ${state}`, async () => {
      await openSettings([], status, "claude");
      await expect(row().$(".item-name")).toHaveText("Todo の要約プロンプト");
      await expect(row().$(".status")).toHaveText("デフォルト");
      await expect(row().$(".status")).toHaveElementClass("off");
      await expect(row().$(".text-btn")).toHaveText("確認・編集");
    });
  }

  it("says 編集済み when the instructions were edited", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeReady, claude_todo_prompt: { ...todoPrompt, body: "My body", edited: true } });
    await $("#nav-settings").click();
    await openTab("claude");
    await expect(row().$(".status")).toHaveText("編集済み");
    await expect(row().$(".status")).toHaveElementClass("ok");
  });

  it("opens the prompt screen with 確認・編集 and shows the saved instructions there", async () => {
    await openSettings([], claudeReady, "claude");
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
    await openTab("update");
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

describe("settings: tabs", () => {
  const tab = (name: Tab) => $(`#settings-tab-${name}`);
  const panel = (name: Tab) => $(`#settings-panel-${name}`);
  const selected = () => browser.execute(() => [...document.querySelectorAll('#settings-tabs [role="tab"]')].filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.id));
  // Left or right pressed on the selected tab, as the key event the app listens for.
  const pressArrow = (key: "ArrowLeft" | "ArrowRight") =>
    browser.execute((k) => {
      const current = document.querySelector('#settings-tabs [role="tab"][aria-selected="true"]')!;
      current.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    }, key);

  it("has the six tabs in order, in a tablist, each controlling the card it names", async () => {
    await openSettings([]);
    await expect($("#settings-tabs")).toHaveAttribute("role", "tablist");
    expect(await textsOf('#settings-tabs [role="tab"]')).toEqual(TABS.map(([, label]) => label));
    for (const [name] of TABS) {
      await expect(tab(name)).toHaveAttribute("aria-controls", `settings-panel-${name}`);
      await expect(panel(name)).toHaveAttribute("role", "tabpanel");
      await expect(panel(name)).toHaveAttribute("aria-labelledby", `settings-tab-${name}`);
    }
  });

  it("opens on Google from the side menu and hides the other cards", async () => {
    await openSettings([]);
    expect(await selected()).toEqual(["settings-tab-google"]);
    await expect(panel("google")).toBeDisplayed();
    for (const [name] of TABS.filter(([n]) => n !== "google")) await expect(panel(name)).not.toBeDisplayed();
  });

  it("shows only the card of the pressed tab", async () => {
    await openSettings([]);
    for (const [name] of TABS) {
      await openTab(name);
      expect(await selected()).toEqual([`settings-tab-${name}`]);
      for (const [other] of TABS) {
        if (other === name) await expect(panel(other)).toBeDisplayed();
        else await expect(panel(other)).not.toBeDisplayed();
      }
    }
  });

  it("moves to the next tab with the right arrow and the previous one with the left, from the last to the first and back", async () => {
    await openSettings([]);
    await pressArrow("ArrowRight");
    expect(await selected()).toEqual(["settings-tab-calendar"]);
    await expect(panel("calendar")).toBeDisplayed();
    await expect(panel("google")).not.toBeDisplayed();
    await pressArrow("ArrowLeft");
    await pressArrow("ArrowLeft");
    expect(await selected()).toEqual(["settings-tab-update"]);
    await expect(panel("update")).toBeDisplayed();
    await pressArrow("ArrowRight");
    expect(await selected()).toEqual(["settings-tab-google"]);
  });

  it("opens on Google again when the settings are left and entered from the side menu", async () => {
    await openSettings([], claudeReady, "claude");
    await $("#nav-mail").click();
    await $("#nav-settings").click();
    expect(await selected()).toEqual(["settings-tab-google"]);
  });

  it("closes an open ? hint when a tab is pressed", async () => {
    await openSettings([], claudeReady, "claude");
    await $("#claude-help").click();
    await expect($('[role="dialog"][aria-label="Claude の使い方"]')).toBeDisplayed();
    await openTab("slack");
    await expect($('[role="dialog"][aria-label="Claude の使い方"]')).not.toExist();
  });

  it("keeps the heading and the tabs in view while a long card scrolls under them, and shows a card from its top when its tab is pressed again", async () => {
    const workspaces = Array.from({ length: 24 }, (_, i) => ({ teamId: `T${i}`, team: `Team ${i}`, user: "alice", url: `https://team-${i}.slack.com/` }));
    await boot({ inbox: inbox(), slack_load: { workspaces, recent: [] }, slack_check: checked([]), claude_status: claudeMissing });
    await $("#nav-settings").click();
    await openTab("slack");
    await expect($("#slack-workspaces .item")).toExist();
    const scrolled = await browser.execute(() => {
      const settings = document.getElementById("settings")!;
      settings.scrollTop = 400;
      return settings.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    const edges = () =>
      browser.execute(() => {
        const settings = document.getElementById("settings")!.getBoundingClientRect();
        const head = document.getElementById("settings-head")!.getBoundingClientRect();
        const tabs = document.getElementById("settings-tabs")!.getBoundingClientRect();
        return { headTop: Math.round(head.top - settings.top), tabsInside: tabs.top >= settings.top && tabs.bottom <= settings.top + head.height };
      });
    expect(await edges()).toEqual({ headTop: 0, tabsInside: true });
    await expect($("#settings h1")).toBeDisplayed();
    await expect(tab("slack")).toBeDisplayed();
    await openTab("slack");
    expect(await browser.execute(() => document.getElementById("settings")!.scrollTop)).toBe(0);
  });

  it("puts the dot on the update tab only while a newer version is out", async () => {
    await boot({ inbox: inbox(), update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    await $("#nav-settings").click();
    await waitForText("#update-items .status", "v9.9.9 があります");
    await expect($("#settings-tab-update .tab-dot")).toBeDisplayed();
    expect(await browser.execute(() => document.querySelectorAll("#settings-tabs .tab-dot:not([hidden])").length)).toBe(1);
    await boot({ inbox: inbox() });
    await $("#nav-settings").click();
    await waitForCalls("check_update");
    await waitForText("#update-items .status", "最新");
    await expect($("#settings-tab-update .tab-dot")).not.toBeDisplayed();
  });
});
