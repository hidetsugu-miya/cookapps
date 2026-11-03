import { account, boot, checked, claudeKeyReady, claudeLoggedOut, claudeMissing, claudeReady, claudeSettings, connection, count, holds, inbox, mock, rejects, release, slackLoad, textsOf, todoData, todoPrompt, waitForCalls, waitForText, weekOfToday, callsOf } from "../support";

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
  it("asks Slack about the tokens only when the Slack tab is shown", async () => {
    await openSettings([]);
    await browser.waitUntil(async () => (await textsOf("#slack-workspaces .status")).join() === "確認中", { timeoutMsg: "the workspace row was not drawn" });
    expect(await callsOf("slack_check")).toHaveLength(0);
    await openTab("slack");
    expect(await waitForCalls("slack_check")).toEqual([{ teamId: "T1" }]);
    await expect($("#slack-workspaces .status")).toHaveText("接続済み");
  });

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
  const row = (n: number) => $(`#claude-items .item:nth-child(${n})`);

  for (const [state, status, meta, label] of [
    ["ready", claudeReady, "claude@example.com ・ Max プラン ・ Claude Code 2.0.0", "ログイン中"],
    ["loggedOut", claudeLoggedOut, "ログインしていません。ターミナルで claude auth login を実行してください", "未ログイン"],
    ["missing", claudeMissing, "Claude Code が見つかりません", "未導入"],
  ] as const) {
    it(`shows the subscription row first, with its ${state} state`, async () => {
      await openSettings([], status, "claude");
      await expect(row(1).$(".item-name")).toHaveText("サブスクリプション");
      await expect(row(1).$(".item-meta")).toHaveText(expect.stringContaining(meta));
      await expect(row(1).$(".status")).toHaveText(label);
    });
  }

  it("keeps the 3 cards of the tab in one tab panel: connection, model and effort, prompt", async () => {
    await openSettings([], claudeReady, "claude");
    await expect($("#settings-panel-claude")).toHaveAttribute("role", "tabpanel");
    expect(await textsOf("#settings-panel-claude > .card .card-head h2")).toEqual(["Claude", "モデルと effort", "プロンプト"]);
    await expect($("#settings-panel-claude > .card:nth-child(1) #claude-items")).toExist();
    await expect($("#settings-panel-claude > .card:nth-child(2) #claude-models")).toExist();
    await expect($("#settings-panel-claude > .card:nth-child(3) #claude-prompt")).toExist();
    await expect($("#claude-recheck")).toBeDisplayed();
    await expect($("#claude-help")).toBeDisplayed();
  });

  it("lists the subscription and the API key as 2 radio rows, the method in use checked, and no key form while no row asks for it", async () => {
    await openSettings([], claudeReady, "claude");
    await expect($("#claude-items")).toHaveAttribute("role", "radiogroup");
    expect(await count("#claude-items .item")).toBe(2);
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    await expect(row(2).$('input[type="radio"]')).not.toBeSelected();
    await expect(row(2).$(".item-name")).toHaveText("API キー");
    await expect(row(2).$(".item-meta")).toHaveText("呼び出しごとに課金されます");
    await expect(row(2).$(".status")).toHaveText("未登録");
    await expect($("#claude-key")).not.toBeDisplayed();
  });

  it("redraws the rows when the check ↻ is pressed", async () => {
    await openSettings([], claudeReady, "claude");
    const status = await mock("claude_status", claudeLoggedOut);
    const card = await mock("claude_connection", connection("subscription", claudeLoggedOut, { state: "none" }));
    await $("#claude-recheck").click();
    await waitForCalls(status);
    await waitForCalls(card);
    await expect(row(1).$(".status")).toHaveText("未ログイン");
  });
});

describe("settings: Claude API key", () => {
  const row = (n: number) => $(`#claude-items .item:nth-child(${n})`);
  const key = "sk-ant-api03-example";
  const keyReady = { state: "ready", workspaceId: "wrkspc_01" } as const;
  // The app with the key stored (and the subscription in use unless `method` says otherwise), settings open on the Claude tab.
  async function withKey(method: "subscription" | "apiKey", apiKey: Parameters<typeof connection>[2] = keyReady) {
    const usable = method === "apiKey" ? claudeKeyReady : claudeReady;
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: usable, claude_connection: connection(method, claudeReady, apiKey) });
    await $("#nav-settings").click();
    await openTab("claude");
  }
  const types = (text: string) => browser.execute((t) => {
    const input = document.getElementById("claude-key-input") as HTMLInputElement;
    input.value = t;
  }, text);

  it("shows the stored key with its workspace and the billing note, and the buttons that paste it again and delete it", async () => {
    await withKey("subscription");
    await expect(row(2).$(".item-meta")).toHaveText("ワークスペース wrkspc_01 ・ 呼び出しごとに課金されます");
    await expect(row(2).$(".status")).toHaveText("確認済み");
    await expect(row(2).$(".text-btn")).toHaveText("貼り直す");
    await expect(row(2).$('button[aria-label="API キーの接続を解除"]')).toBeDisplayed();
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
  });

  it("shows the API key row as in use with no email in the usable state", async () => {
    await withKey("apiKey");
    await expect(row(2).$('input[type="radio"]')).toBeSelected();
    await expect(row(1).$('input[type="radio"]')).not.toBeSelected();
    await expect(row(1).$(".status")).toHaveText("ログイン中");
    await expect($("#claude-btn")).toHaveAttribute("aria-label", "Claude: API キー");
  });

  it("tells a key Anthropic refuses from one it could not ask about, and keeps the buttons", async () => {
    await withKey("apiKey", { state: "rejected", message: "キーが使えません。Console で確かめて、貼り直してください" });
    await expect(row(2).$(".status")).toHaveText("使えません");
    await expect(row(2).$(".item-meta")).toHaveElementClass("warn");
    await expect(row(2).$(".text-btn")).toBeDisplayed();
    await withKey("apiKey", { state: "unverified", message: "キーを確認できません: Anthropic に接続できません" });
    await expect(row(2).$(".status")).toHaveText("確認できません");
    await expect(row(2).$(".item-meta")).toHaveText(expect.stringContaining("Anthropic に接続できません"));
  });

  it("only opens the key field when the API key row is pressed with no key stored: no method change, no logout", async () => {
    await openSettings([], claudeReady, "claude");
    await mock("claude_method_set", null);
    await mock("claude_key_save", null);
    await row(2).click();
    await expect($("#claude-key")).toBeDisplayed();
    await expect($("#claude-key-input")).toHaveAttribute("type", "password");
    await expect($("#claude-key-input")).toBeFocused();
    expect(await callsOf("claude_method_set")).toEqual([]);
    expect(await callsOf("claude_key_save")).toEqual([]);
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
  });

  it("registers the key with claude_key_save, empties the field as soon as it is read, and shows the key in use after the states are asked again", async () => {
    await openSettings([], claudeReady, "claude");
    await row(2).click();
    const save = await mock("claude_key_save", null);
    await mock("claude_status", claudeKeyReady);
    const card = await mock("claude_connection", connection("apiKey", claudeLoggedOut, keyReady));
    await types(`  ${key}  `);
    await $("#claude-key button").click();
    expect(await waitForCalls(save)).toEqual([{ key: `  ${key}  ` }]);
    await waitForCalls(card);
    await expect($("#claude-key-input")).toHaveValue("");
    await expect($("#claude-key")).not.toBeDisplayed();
    await expect(row(2).$('input[type="radio"]')).toBeSelected();
    await expect(row(2).$(".status")).toHaveText("確認済み");
    await expect(row(1).$(".status")).toHaveText("未ログイン");
    await expect($("#claude-btn")).toHaveAttribute("aria-label", "Claude: API キー");
  });

  it("refuses a key that is not usable: the error is shown, the field is emptied and stays open, and the states stay as they were", async () => {
    await openSettings([], claudeReady, "claude");
    await row(2).click();
    await mock("claude_key_save", rejects("Admin キー（sk-ant-admin…）は使えません。通常の API キーを貼ってください"));
    await types("sk-ant-admin01-example");
    await $("#claude-key button").click();
    await expect($("#error")).toHaveText(expect.stringContaining("Admin キー"));
    await expect($("#claude-key-input")).toHaveValue("");
    await expect($("#claude-key")).toBeDisplayed();
    await expect(row(2).$(".status")).toHaveText("未登録");
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    await expect($("#claude-btn")).toBeDisplayed();
  });

  it("closes the key field when the key was kept but Claude Code could not be logged out, and shows that error", async () => {
    await openSettings([], claudeReady, "claude");
    await row(2).click();
    await mock("claude_key_save", rejects("Claude Code のログアウトを確認できませんでした。ターミナルで claude auth logout を実行してください"));
    await mock("claude_status", claudeKeyReady);
    await mock("claude_connection", connection("apiKey", claudeReady, keyReady));
    await types(key);
    await $("#claude-key button").click();
    await expect($("#error")).toHaveText(expect.stringContaining("claude auth logout"));
    await expect($("#claude-key")).not.toBeDisplayed();
    await expect(row(2).$('input[type="radio"]')).toBeSelected();
  });

  it("switches to the stored key with claude_method_set when its row is pressed", async () => {
    await withKey("subscription");
    const set = await mock("claude_method_set", null);
    await mock("claude_status", claudeKeyReady);
    await mock("claude_connection", connection("apiKey", claudeLoggedOut, keyReady));
    await row(2).click();
    expect(await waitForCalls(set)).toEqual([{ method: "apiKey" }]);
    await expect(row(2).$('input[type="radio"]')).toBeSelected();
    await expect(row(1).$(".status")).toHaveText("未ログイン");
    await expect($("#claude-key")).not.toBeDisplayed();
  });

  it("shows the error and leaves the method as it was when the switch fails", async () => {
    await withKey("subscription");
    await mock("claude_method_set", rejects("資格情報の読み取りに失敗: x"));
    await row(2).click();
    await expect($("#error")).toHaveText(expect.stringContaining("資格情報の読み取りに失敗"));
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
  });

  it("goes back to the subscription with claude_method_set, and keeps the key", async () => {
    await withKey("apiKey");
    const set = await mock("claude_method_set", null);
    await mock("claude_key_delete", null);
    await mock("claude_status", claudeReady);
    await mock("claude_connection", connection("subscription", claudeReady, keyReady));
    await row(1).click();
    expect(await waitForCalls(set)).toEqual([{ method: "subscription" }]);
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    await expect(row(2).$(".status")).toHaveText("確認済み");
    expect(await callsOf("claude_key_delete")).toEqual([]);
  });

  it("calls nothing when the row of the method in use is pressed", async () => {
    await withKey("subscription");
    await mock("claude_method_set", null);
    await row(1).click();
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    expect(await callsOf("claude_method_set")).toEqual([]);
  });

  it("opens the key field with 貼り直す without calling anything, and closes it with the same button", async () => {
    await withKey("subscription");
    await mock("claude_method_set", null);
    await row(2).$(".text-btn").click();
    await expect($("#claude-key")).toBeDisplayed();
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    expect(await callsOf("claude_method_set")).toEqual([]);
    await row(2).$(".text-btn").click();
    await expect($("#claude-key")).not.toBeDisplayed();
  });

  it("deletes the key with claude_key_delete only after the confirmation, and shows it as not registered", async () => {
    await withKey("apiKey");
    const del = await mock("claude_key_delete", null);
    await mock("claude_status", claudeLoggedOut);
    await mock("claude_connection", connection("subscription", claudeLoggedOut, { state: "none" }));
    await row(2).$('button[aria-label="API キーの接続を解除"]').click();
    await expect($('[role="alertdialog"]')).toHaveText(expect.stringContaining("Claude Code はログアウトされたまま"));
    expect(await callsOf("claude_key_delete")).toEqual([]);
    await $('[role="alertdialog"]').$("button=解除").click();
    expect(await waitForCalls(del)).toEqual([null]);
    await expect(row(2).$(".status")).toHaveText("未登録");
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    await expect(row(1).$(".status")).toHaveText("未ログイン");
    await expect($("#claude-btn")).not.toBeDisplayed();
  });

  it("deletes nothing when the confirmation is cancelled", async () => {
    await withKey("subscription");
    await mock("claude_key_delete", null);
    await row(2).$('button[aria-label="API キーの接続を解除"]').click();
    await $('[role="alertdialog"]').$("button=キャンセル").click();
    expect(await callsOf("claude_key_delete")).toEqual([]);
    await expect(row(2).$(".status")).toHaveText("確認済み");
  });

  it("says in the ? hint how to get a key and that switching logs Claude Code out", async () => {
    await openSettings([], claudeReady, "claude");
    await $("#claude-help").click();
    const hint = $('[role="dialog"][aria-label="Claude の使い方"]');
    await expect(hint).toHaveText(expect.stringContaining("Console"));
    await expect(hint).toHaveText(expect.stringContaining("ワークスペースに限定したキー"));
    await expect(hint).toHaveText(expect.stringContaining("資格情報の保管場所"));
    await expect(hint).toHaveText(expect.stringContaining("Claude Code はログアウトされる"));
  });

  it("shows API キー instead of the email in the Claude popup of the side menu while the key is in use", async () => {
    await withKey("apiKey");
    await $("#claude-btn").click();
    const popup = $("#account-popup");
    await expect(popup).toHaveText(expect.stringContaining("API キー"));
    await expect(popup).not.toHaveText(expect.stringContaining("claude@example.com"));
    await expect(popup.$(".status")).toHaveText("使用中");
  });

  it("hides the Claude avatar while the key is refused", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: { state: "failed", message: "キーが使えません" }, claude_connection: connection("apiKey", claudeReady, { state: "rejected", message: "キーが使えません" }) });
    await expect($("#claude-btn")).not.toBeDisplayed();
  });
});

describe("settings: Claude model and effort", () => {
  type Purpose = keyof typeof claudeSettings;
  const PURPOSES: [Purpose, string, string][] = [
    ["slackSummary", "Slack の要約", "Slack のメッセージから Todo を作るとき"],
    ["mailSummary", "メールの要約", "メール詳細の AI 要約"],
    ["promptChat", "プロンプトの会話", "Todo の要約プロンプトを Claude と編集するとき"],
    ["proofread", "Slack に貼る文章の校正", "Slack に貼る画面の「Claude と校正」"],
  ];
  const selectOf = (purpose: Purpose, kind: "model" | "effort") => $(`#claude-models select[data-purpose="${purpose}"][data-kind="${kind}"]`);
  // Sets a select as the user does (value, then change); the real WebView's select popup is not driven.
  const choose = (purpose: Purpose, kind: "model" | "effort", value: string) =>
    browser.execute(
      (p, k, v) => {
        const select = document.querySelector<HTMLSelectElement>(`#claude-models select[data-purpose="${p}"][data-kind="${k}"]`)!;
        select.value = v;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      },
      purpose,
      kind,
      value,
    );
  const optionTexts = (select: ChainablePromiseElement) => select.$$("option").map((o) => o.getText());
  const drawnSelects = () => browser.execute(() => document.querySelectorAll("#claude-models select").length);

  for (const [state, status] of [["ready", claudeReady], ["loggedOut", claudeLoggedOut], ["missing", claudeMissing]] as const) {
    it(`has its own card with the defaults selected for the four purposes, while Claude is ${state}`, async () => {
      await openSettings([], status, "claude");
      await expect($("#claude-models")).toBeDisplayed();
      await expect($("#claude-prompt .item-name")).toHaveText("Todo の要約プロンプト");
      expect(await drawnSelects()).toBe(8);
      for (const [purpose] of PURPOSES) {
        await expect(selectOf(purpose, "model")).toHaveValue("sonnet");
        await expect(selectOf(purpose, "effort")).toHaveValue("medium");
      }
    });
  }

  it("names the four purposes in order, each with where it is used, and labels its selects", async () => {
    await openSettings([], claudeReady, "claude");
    const whos = await textsOf("#claude-models .model-grid .who");
    expect(whos).toEqual(PURPOSES.map(([, name, meta]) => `${name}${meta}`));
    for (const [purpose, name] of PURPOSES) {
      await expect(selectOf(purpose, "model")).toHaveAttribute("aria-label", `${name}のモデル`);
      await expect(selectOf(purpose, "effort")).toHaveAttribute("aria-label", `${name}の effort`);
    }
  });

  it("offers the three models and the five efforts for each purpose, with no Fable and no default marks", async () => {
    await openSettings([], claudeReady, "claude");
    for (const [purpose] of PURPOSES) {
      expect(await optionTexts(selectOf(purpose, "model"))).toEqual(["Haiku", "Sonnet", "Opus"]);
      expect(await optionTexts(selectOf(purpose, "effort"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("heads the columns 用途, モデル and effort, and says once that the default is Sonnet and medium", async () => {
    await openSettings([], claudeReady, "claude");
    expect(await textsOf("#claude-models .model-grid .th")).toEqual(["用途", "モデル", "effort"]);
    await expect($("#claude-models .model-note")).toHaveText("次の呼び出しから使います。デフォルトは Sonnet と medium");
  });

  it("does not wrap the description of a purpose onto a second line", async () => {
    await openSettings([], claudeReady, "claude");
    const wrapped = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>("#claude-models .model-grid .who .item-meta")].map((e) => e.getBoundingClientRect().height > 20),
    );
    expect(wrapped).toEqual([false, false, false, false]);
  });

  it("shows the saved model and effort of each purpose", async () => {
    await boot({
      inbox: inbox(),
      slack_load: slackLoad,
      slack_check: checked([]),
      claude_model_settings: {
        slackSummary: { model: "opus", effort: "xhigh" },
        mailSummary: { model: "haiku", effort: "low" },
        promptChat: { model: "opus", effort: "high" },
        proofread: { model: "sonnet", effort: "max" },
      },
    });
    await $("#nav-settings").click();
    await openTab("claude");
    await expect(selectOf("slackSummary", "model")).toHaveValue("opus");
    await expect(selectOf("slackSummary", "effort")).toHaveValue("xhigh");
    await expect(selectOf("mailSummary", "model")).toHaveValue("haiku");
    await expect(selectOf("mailSummary", "effort")).toHaveValue("low");
    await expect(selectOf("promptChat", "model")).toHaveValue("opus");
    await expect(selectOf("promptChat", "effort")).toHaveValue("high");
    await expect(selectOf("proofread", "model")).toHaveValue("sonnet");
    await expect(selectOf("proofread", "effort")).toHaveValue("max");
  });

  for (const [purpose, name] of PURPOSES) {
    it(`saves ${name} with claude_model_settings_save: a model alone without an effort, and an effort with its model, and leaves the other purposes alone`, async () => {
      await openSettings([], claudeReady, "claude");
      const save = await mock("claude_model_settings_save", { ...claudeSettings, [purpose]: { model: "opus", effort: "medium" } });
      await choose(purpose, "model", "opus");
      expect(await waitForCalls(save)).toEqual([{ purpose, model: "opus" }]);
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

  it("draws the effort Rust saved for the model after a change of the model", async () => {
    await openSettings([], claudeReady, "claude");
    for (const [model, effort] of [["sonnet", "high"], ["opus", "medium"], ["haiku", "medium"]] as const) {
      const save = await mock("claude_model_settings_save", { ...claudeSettings, mailSummary: { model, effort } });
      await choose("mailSummary", "model", model);
      expect(await waitForCalls(save)).toEqual([{ purpose: "mailSummary", model }]);
      await expect(selectOf("mailSummary", "model")).toHaveValue(model);
      await expect(selectOf("mailSummary", "effort")).toHaveValue(effort);
      await expect(selectOf("mailSummary", "effort")).toHaveAttribute("data-effort", effort);
    }
    // The other purposes keep their own effort.
    await expect(selectOf("proofread", "effort")).toHaveValue("medium");
  });

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
    await expect($("#claude-prompt .item-name")).toHaveText("Todo の要約プロンプト");
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

  describe("effort colors", () => {
    const background = (purpose: Purpose) => selectOf(purpose, "effort").getCSSProperty("background-color");
    const colorOf = (purpose: Purpose) => selectOf(purpose, "effort").getCSSProperty("color");

    it("marks each effort select with its value in data-effort, and follows a change, a save and a failed save", async () => {
      await boot({
        inbox: inbox(),
        slack_load: slackLoad,
        slack_check: checked([]),
        claude_model_settings: {
          slackSummary: { model: "sonnet", effort: "low" },
          mailSummary: { model: "sonnet", effort: "medium" },
          promptChat: { model: "sonnet", effort: "high" },
          proofread: { model: "sonnet", effort: "xhigh" },
        },
      });
      await $("#nav-settings").click();
      await openTab("claude");
      await expect(selectOf("slackSummary", "effort")).toHaveAttribute("data-effort", "low");
      await expect(selectOf("mailSummary", "effort")).toHaveAttribute("data-effort", "medium");
      await expect(selectOf("promptChat", "effort")).toHaveAttribute("data-effort", "high");
      await expect(selectOf("proofread", "effort")).toHaveAttribute("data-effort", "xhigh");
      // The model selects carry none.
      await expect(selectOf("slackSummary", "model")).not.toHaveAttribute("data-effort");
      // A change is followed at once, while the save is still on its way.
      const save = await mock("claude_model_settings_save", holds);
      await choose("slackSummary", "effort", "max");
      await waitForCalls(save);
      await expect(selectOf("slackSummary", "effort")).toHaveAttribute("data-effort", "max");
      await release(save, { ...claudeSettings, slackSummary: { model: "sonnet", effort: "max" } });
      await expect(selectOf("slackSummary", "effort")).toHaveAttribute("data-effort", "max");
      // A failed save puts the value, and its mark, back.
      await mock("claude_model_settings_save", rejects("effort が不正です"));
      await choose("slackSummary", "effort", "low");
      await expect($("#error")).toHaveText(expect.stringContaining("effort が不正です"));
      await expect(selectOf("slackSummary", "effort")).toHaveValue("max");
      await expect(selectOf("slackSummary", "effort")).toHaveAttribute("data-effort", "max");
    });

    it("gives each effort its own colors: the same background and text for equal values, and different ones for different values", async () => {
      await boot({
        inbox: inbox(),
        slack_load: slackLoad,
        slack_check: checked([]),
        claude_model_settings: {
          slackSummary: { model: "sonnet", effort: "low" },
          mailSummary: { model: "sonnet", effort: "medium" },
          promptChat: { model: "sonnet", effort: "high" },
          proofread: { model: "sonnet", effort: "max" },
        },
      });
      await $("#nav-settings").click();
      await openTab("claude");
      const seen = new Set<string>();
      for (const [purpose] of PURPOSES) {
        const bg = (await background(purpose)).value;
        const fg = (await colorOf(purpose)).value;
        expect(bg).not.toBe(fg);
        seen.add(`${bg}/${fg}`);
      }
      expect(seen.size).toBe(4);
      // xhigh differs from the four above.
      const save = await mock("claude_model_settings_save", { ...claudeSettings, proofread: { model: "sonnet", effort: "xhigh" } });
      await choose("proofread", "effort", "xhigh");
      await waitForCalls(save);
      seen.add(`${(await background("proofread")).value}/${(await colorOf("proofread")).value}`);
      expect(seen.size).toBe(5);
    });
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
  const row = () => $("#claude-prompt .item");

  for (const [state, status] of [["ready", claudeReady], ["loggedOut", claudeLoggedOut], ["missing", claudeMissing]] as const) {
    it(`has its row in the prompt card while Claude is ${state}`, async () => {
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
    await expect($("#claude-items .item-meta")).toHaveText(expect.stringContaining("claude@example.com"));
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

  it("moves the focus to the neighbour tab along with the arrow key", async () => {
    await openSettings([]);
    const focused = () => browser.execute(() => document.activeElement?.id);
    await pressArrow("ArrowRight");
    expect(await focused()).toBe("settings-tab-calendar");
    await pressArrow("ArrowLeft");
    await pressArrow("ArrowLeft");
    expect(await focused()).toBe("settings-tab-update");
  });

  it("opens the Claude tab from 設定を開く in the Claude popup", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeReady });
    await $("#claude-btn").click();
    await $("#account-popup").$("button=設定を開く").click();
    await expect($("#settings")).toBeDisplayed();
    expect(await selected()).toEqual(["settings-tab-claude"]);
    await expect(panel("claude")).toBeDisplayed();
  });

  it("clears a shown error when another tab is pressed", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, todoist_connected: true });
    await $("#nav-settings").click();
    await openTab("todoist");
    await mock("todoist_disconnect", rejects("資格情報を消せません"));
    await $('button[aria-label="Todoist の接続を解除"]').click();
    await $('[role="alertdialog"]').$("button=解除").click();
    await expect($("#error")).toBeDisplayed();
    await openTab("slack");
    await expect($("#error")).not.toBeDisplayed();
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
