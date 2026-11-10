import { account, boot, checked, chooseAppearance, chooseOption, fontSettings, chooseTheme, ghosttyImport, hiddenChannel, claudeKeyReady, claudeLoggedOut, claudeMissing, claudeReady, claudeSettings, connection, count, emitEvent, holds, inbox, mock, rejects, onceId, release, slackLoad, socketStatus, terminalThemes, textsOf, timeline, todoData, todoPrompt, waitForCalls, waitForCount, waitForText, weekOfToday, callsOf } from "../support";

type Tab = "google" | "calendar" | "todoist" | "slack" | "claude" | "orca" | "font" | "update";

// Presses a tab of the settings screen.
const openTab = (tab: Tab) => $(`#settings-tab-${tab}`).click();

// The app with one Slack workspace whose token `slack_check` judges as given, and the settings screen open on `tab` (it opens on Google).
async function openSettings(missingScopes: string[], claude: unknown = claudeMissing, tab: Tab = "google") {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked(missingScopes), claude_status: claude });
  await $("#nav-settings").click();
  await expect($("#settings")).toBeDisplayed();
  if (tab !== "google") await openTab(tab);
}

const TABS: [Tab, string][] = [["google", "Google"], ["calendar", "カレンダー"], ["todoist", "Todoist"], ["slack", "Slack"], ["claude", "Claude"], ["orca", "Orca"], ["font", "フォント"], ["update", "アップデート"]];

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

  it("makes the heading and the tabs a place to drag the window by, and the tabs stay pressable", async () => {
    await openSettings([]);
    await expect($("#settings-head")).toHaveAttribute("data-tauri-drag-region", "deep");
    await openTab("calendar");
    await expect($("#settings-tab-calendar")).toHaveAttribute("aria-selected", "true");
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

  it("says which optional scopes the token lacks without calling the workspace short of permission", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([], ["users:read", "files:read"]), claude_status: claudeMissing });
    await $("#nav-settings").click();
    await openTab("slack");
    const status = $("#slack-workspaces .status");
    await expect(status).toHaveText("接続済み");
    await expect(status).toHaveElementClass("ok");
    await expect($("#slack-workspaces .item-meta")).not.toHaveElementClass("warn");
    await expect($("#slack-workspaces .item-meta")).toHaveText(expect.stringContaining("users:read（送信者の名前とアイコン）、files:read（添付画像）はありません"));
    // Nothing to fix in a pane: the label is no button.
    await expect($("#slack-workspaces button.status")).not.toExist();
  });

  it("lists the optional scopes (users:read, files:read, channels:write, groups:write, usergroups:read) with the other scopes in the setup hint", async () => {
    await openSettings([], claudeMissing, "slack");
    await $("#slack-help").click();
    const scopes = await $$('[role="dialog"][aria-label="Slack の接続方法"] .scopes code').map((code) => code.getText());
    expect(scopes).toEqual(["chat:write", "channels:read", "groups:read", "channels:history", "groups:history", "im:history", "mpim:history", "users:read", "files:read", "channels:write", "groups:write", "usergroups:read"]);
    // The sentence on the optional scopes names it as well, outside the list.
    const named = await $$('[role="dialog"][aria-label="Slack の接続方法"] code').map((code) => code.getText());
    expect(named.filter((name) => name === "usergroups:read")).toHaveLength(2);
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

describe("settings: Slack リアルタイム更新", () => {
  // The workspace's row of the card, and the label of its state.
  const label = () => $("#slack-socket-items .status");
  const tokenField = () => $("#slack-socket-token");

  it("shows 未登録 for a workspace with no App-Level Token, with no button to delete one", async () => {
    await openSettings([], claudeMissing, "slack");
    await expect($("#slack-socket-items .item-name")).toHaveText("Example Team");
    await expect(label()).toHaveText("未登録");
    await expect(label()).toHaveElementClass("off");
    await expect($("#slack-socket-items .item-meta")).toHaveText("未登録の間は、2 分ごとに読み直します");
    await expect($("#slack-socket-items button")).not.toExist();
    // The field takes the token without showing it.
    await expect(tokenField()).toHaveAttribute("type", "password");
    expect(await textsOf("#slack-socket-team option")).toEqual(["Example Team"]);
  });

  it("registers a token for the workspace chosen, empties the field, and follows the states Rust sends", async () => {
    await openSettings([], claudeMissing, "slack");
    const set = await mock("slack_app_token_set", [socketStatus("connecting")]);
    await tokenField().setValue("xapp-1-A0123-4567-abcdef");
    await $("#slack-socket-form button").click();
    expect(await waitForCalls(set)).toEqual([{ teamId: "T1", token: "xapp-1-A0123-4567-abcdef" }]);
    await expect(label()).toHaveText("接続中");
    await expect(tokenField()).toHaveValue("");

    await emitEvent("slack-socket-status", socketStatus("connected"));
    await browser.waitUntil(async () => (await label().getText()) === "つながっている", { timeoutMsg: "the state did not follow the event" });
    await expect(label()).toHaveElementClass("ok");
    await expect($("#slack-socket-items .item-meta")).toHaveText("新着をすぐに一覧へ出します。読み直しは 5 分ごとです");

    await emitEvent("slack-socket-status", socketStatus("reconnecting"));
    await browser.waitUntil(async () => (await label().getText()) === "つなぎ直し中", { timeoutMsg: "the state did not follow the event" });
    await expect(label()).toHaveElementClass("warn");
  });

  it("shows the state a connection had before the page listened", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, slack_socket_status: [socketStatus("connected")] });
    await $("#nav-settings").click();
    await openTab("slack");
    await expect(label()).toHaveText("つながっている");
  });

  it("shows why a token was refused, and stays 未登録", async () => {
    await openSettings([], claudeMissing, "slack");
    await mock("slack_app_token_set", rejects("App-Level Token は xapp- で始まります"));
    await tokenField().setValue("xoxp-1-2-3");
    await $("#slack-socket-form button").click();
    await expect($("#error")).toHaveText(expect.stringContaining("App-Level Token は xapp- で始まります"));
    await expect(label()).toHaveText("未登録");
    await expect(tokenField()).toHaveValue("");
  });

  it("asks before deleting a token: キャンセル sends nothing, 解除 calls slack_app_token_remove", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, slack_socket_status: [socketStatus("connected")] });
    await $("#nav-settings").click();
    await openTab("slack");
    const gone = await mock("slack_app_token_remove", []);
    await expect(label()).toHaveText("つながっている");
    const unlink = () => $('button[aria-label="Example Team の App-Level Token を削除"]');

    await unlink().click();
    const dialog = $('[role="alertdialog"]');
    await expect(dialog).toBeDisplayed();
    await dialog.$("button=キャンセル").click();
    await expect(dialog).not.toExist();
    expect(await callsOf(gone)).toHaveLength(0);

    await unlink().click();
    await $('[role="alertdialog"]').$("button=解除").click();
    expect(await waitForCalls(gone)).toEqual([{ teamId: "T1" }]);
    await expect(label()).toHaveText("未登録");
    await expect(unlink()).not.toExist();
  });

  it("lists the events to subscribe to and the scope of the token in the setup hint", async () => {
    await openSettings([], claudeMissing, "slack");
    await $("#slack-socket-help").click();
    const hint = $('[role="dialog"][aria-label="リアルタイム更新の設定方法"]');
    await expect(hint).toBeDisplayed();
    expect(await hint.$$("code").map((code) => code.getText())).toEqual(["message.channels", "message.groups", "connections:write", "xapp-"]);
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

  it("asks only claude_status at start, and claude_connection once the Claude tab is first shown", async () => {
    await openSettings([], claudeReady);
    expect(await callsOf("claude_status")).toHaveLength(1);
    expect(await callsOf("claude_connection")).toEqual([]);
    await openTab("claude");
    await expect(row(1).$(".status")).toHaveText("ログイン中");
    expect(await callsOf("claude_connection")).toHaveLength(1);
    await openTab("slack");
    await openTab("claude");
    expect(await callsOf("claude_connection")).toHaveLength(1);
    expect(await callsOf("claude_status")).toHaveLength(1);
  });

  it("redraws the rows and the usable state with one claude_connection when the check ↻ is pressed", async () => {
    await openSettings([], claudeReady, "claude");
    const status = await mock("claude_status", claudeReady);
    const card = await mock("claude_connection", connection("subscription", claudeLoggedOut, { state: "none" }));
    await $("#claude-recheck").click();
    await waitForCalls(card);
    await expect(row(1).$(".status")).toHaveText("未ログイン");
    await expect($("#claude-btn")).not.toBeDisplayed();
    expect(await callsOf(card)).toHaveLength(1);
    expect(await callsOf(status)).toEqual([]);
  });

  it("keeps the model selects and the prompt row as they were when only the connection is redrawn", async () => {
    await openSettings([], claudeReady, "claude");
    await expect($("#claude-models select")).toExist();
    await browser.waitUntil(async () => (await textsOf("#claude-prompt .status"))[0] !== "確認中");
    const marks = () => browser.execute(() => {
      const w = window as unknown as { __marks__?: Element[] };
      const now = [document.querySelector("#claude-models select"), document.querySelector("#claude-prompt .item")] as Element[];
      w.__marks__ ??= now;
      return now.every((e, i) => e === w.__marks__![i]);
    });
    expect(await marks()).toBe(true);
    const card = await mock("claude_connection", connection("subscription", claudeLoggedOut, { state: "none" }));
    await $("#claude-recheck").click();
    await waitForCalls(card);
    await expect(row(1).$(".status")).toHaveText("未ログイン");
    expect(await marks()).toBe(true);
  });

  it("shows Claude as failed when claude_status fails at start", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: rejects("状態を読めません"), claude_connection: connection("subscription", claudeMissing, { state: "none" }) });
    await expect($("#claude-btn")).not.toBeDisplayed();
  });
});

describe("settings: Claude API key", () => {
  const row = (n: number) => $(`#claude-items .item:nth-child(${n})`);
  const radio = (n: number) => row(n).$('input[type="radio"]');
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

  it("only opens the key field when the radio of the API key row is pressed with no key stored: no method change, no logout", async () => {
    await openSettings([], claudeReady, "claude");
    await mock("claude_method_set", null);
    await mock("claude_key_save", { logoutError: null });
    await radio(2).click();
    await expect($("#claude-key")).toBeDisplayed();
    await expect($("#claude-key-input")).toHaveAttribute("type", "password");
    await expect($("#claude-key-input")).toBeFocused();
    expect(await callsOf("claude_method_set")).toEqual([]);
    expect(await callsOf("claude_key_save")).toEqual([]);
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    // The press checked the radio of the row; the redraw sets it back to the method really in use.
    await expect(radio(2)).not.toBeSelected();
  });

  it("only opens the key field when the radio of a refused key is pressed: no method change, no logout", async () => {
    await withKey("subscription", { state: "rejected", message: "キーが使えません。Console で確かめて、貼り直してください" });
    await mock("claude_method_set", null);
    await radio(2).click();
    await expect($("#claude-key")).toBeDisplayed();
    await expect($("#claude-key-input")).toBeFocused();
    expect(await callsOf("claude_method_set")).toEqual([]);
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    await expect(radio(2)).not.toBeSelected();
  });

  it("does not switch when the text of a row is clicked or double-clicked, nor when an arrow key is pressed on a radio", async () => {
    await withKey("subscription");
    await mock("claude_method_set", null);
    await mock("claude_key_delete", null);
    await row(2).$(".item-name").click();
    await row(2).$(".item-name").doubleClick();
    await row(2).$(".item-meta").doubleClick();
    await radio(1).click();
    await browser.keys("ArrowDown");
    await browser.pause(300);
    expect(await callsOf("claude_method_set")).toEqual([]);
    expect(await callsOf("claude_key_delete")).toEqual([]);
    await expect(radio(1)).toBeSelected();
    await expect(radio(2)).not.toBeSelected();
  });

  it("disables the radios, the row buttons and ↻ while a change of the method is on its way", async () => {
    await withKey("subscription");
    const set = await mock("claude_method_set", holds);
    await mock("claude_connection", connection("apiKey", claudeLoggedOut, keyReady));
    await radio(2).click();
    await waitForCalls(set);
    await expect(radio(1)).toBeDisabled();
    await expect(radio(2)).toBeDisabled();
    await expect(row(2).$(".text-btn")).toBeDisabled();
    await expect(row(2).$('button[aria-label="API キーの接続を解除"]')).toBeDisabled();
    await expect($("#claude-recheck")).toBeDisabled();
    await release(set, null);
    await expect(radio(1)).not.toBeDisabled();
    await expect(radio(2)).not.toBeDisabled();
    await expect(row(2).$(".text-btn")).not.toBeDisabled();
    await expect($("#claude-recheck")).not.toBeDisabled();
  });

  it("disables ↻ and the key field's button while the states are being read", async () => {
    await openSettings([], claudeReady, "claude");
    await radio(2).click();
    await expect($("#claude-key")).toBeDisplayed();
    await expect($("#claude-key button")).not.toBeDisabled();
    const card = await mock("claude_connection", holds);
    await $("#claude-recheck").click();
    await waitForCalls(card);
    await expect($("#claude-recheck")).toBeDisabled();
    await expect($("#claude-key button")).toBeDisabled();
    await release(card, connection("subscription", claudeReady, { state: "none" }));
    await expect($("#claude-recheck")).not.toBeDisabled();
    await expect($("#claude-key button")).not.toBeDisabled();
  });

  it("shows one failed row with the error and no radio when claude_connection itself fails, and nothing can be pressed", async () => {
    await withKey("subscription");
    await mock("claude_method_set", null);
    const card = await mock("claude_connection", rejects("接続の確認に失敗しました"));
    await $("#claude-recheck").click();
    await waitForCalls(card);
    await expect($("#error")).toHaveText(expect.stringContaining("接続の確認に失敗しました"));
    expect(await count("#claude-items .item")).toBe(1);
    expect(await count('#claude-items input[type="radio"]')).toBe(0);
    await expect(row(1).$(".status")).toHaveText("確認できません");
    await expect(row(1).$(".item-meta")).toHaveText(expect.stringContaining("接続の確認に失敗しました"));
    // The usable state could not be read either: Claude counts as failed.
    await expect($("#claude-btn")).not.toBeDisplayed();
    await row(1).click();
    expect(await callsOf("claude_method_set")).toEqual([]);
  });

  it("registers the key with claude_key_save, empties the field as soon as it is read, and shows the key in use after the states are asked again", async () => {
    await openSettings([], claudeReady, "claude");
    await radio(2).click();
    const save = await mock("claude_key_save", { logoutError: null });
    const card = await mock("claude_connection", connection("apiKey", claudeLoggedOut, keyReady));
    await types(`  ${key}  `);
    await $("#claude-key button").click();
    expect(await waitForCalls(save)).toEqual([{ key: `  ${key}  `, switch: true }]);
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
    await radio(2).click();
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

  it("closes the key field when the key was kept but Claude Code could not be logged out, and shows that text as the error", async () => {
    await openSettings([], claudeReady, "claude");
    await radio(2).click();
    await mock("claude_key_save", { logoutError: "Claude Code のログアウトを確認できませんでした。ターミナルで claude auth logout を実行してください" });
    await mock("claude_connection", connection("apiKey", claudeReady, keyReady));
    await types(key);
    await $("#claude-key button").click();
    await expect($("#error")).toHaveText(expect.stringContaining("claude auth logout"));
    await expect($("#claude-key")).not.toBeDisplayed();
    await expect(row(2).$('input[type="radio"]')).toBeSelected();
  });

  it("ignores a second send while the first is on its way, and keeps the typed key", async () => {
    await openSettings([], claudeReady, "claude");
    await radio(2).click();
    const save = await mock("claude_key_save", holds);
    await mock("claude_connection", connection("apiKey", claudeLoggedOut, keyReady));
    await types(key);
    await $("#claude-key button").click();
    await waitForCalls(save);
    await expect($("#claude-key button")).toBeDisabled();
    await types("sk-ant-api03-second");
    await browser.execute(
      (id) => {
        if (!window.__e2e_once__(id)) return;
        (document.getElementById("claude-key") as HTMLFormElement).requestSubmit();
      },
      onceId(),
    );
    await expect($("#claude-key-input")).toHaveValue("sk-ant-api03-second");
    expect(await callsOf(save)).toHaveLength(1);
    await release(save, { logoutError: null });
    await expect($("#claude-key")).not.toBeDisplayed();
  });

  it("pastes the key again with 貼り直す: only the key is sent to be replaced (switch false), the method stays and the field closes", async () => {
    await withKey("subscription");
    await row(2).$(".text-btn").click();
    const save = await mock("claude_key_save", { logoutError: null });
    const method = await mock("claude_method_set", null);
    await mock("claude_connection", connection("subscription", claudeReady, { state: "ready", workspaceId: "wrkspc_02" }));
    await types(key);
    await $("#claude-key button").click();
    expect(await waitForCalls(save)).toEqual([{ key, switch: false }]);
    await expect($("#claude-key")).not.toBeDisplayed();
    await expect($("#claude-key-input")).toHaveValue("");
    await expect(row(2).$(".item-meta")).toHaveText(expect.stringContaining("wrkspc_02"));
    await expect(radio(1)).toBeSelected();
    expect(await callsOf(method)).toEqual([]);
  });

  it("closes the field of 貼り直す and shows the logout that could not be confirmed, while the key is in use", async () => {
    await withKey("apiKey");
    await row(2).$(".text-btn").click();
    await mock("claude_key_save", { logoutError: "Claude Code のログアウトを確認できませんでした。ターミナルで claude auth logout を実行してください" });
    await mock("claude_connection", connection("apiKey", claudeReady, keyReady));
    await types(key);
    await $("#claude-key button").click();
    await expect($("#error")).toHaveText(expect.stringContaining("claude auth logout"));
    await expect($("#claude-key")).not.toBeDisplayed();
    await expect(radio(2)).toBeSelected();
  });

  it("sends switch true when the field was opened by the radio of a refused key, and false when it was opened by 貼り直す", async () => {
    await withKey("subscription", { state: "rejected", message: "キーが使えません。Console で確かめて、貼り直してください" });
    const save = await mock("claude_key_save", rejects("このキーは使えません。Console で確かめて、貼り直してください"));
    await radio(2).click();
    await types(key);
    await $("#claude-key button").click();
    expect(await waitForCalls(save)).toEqual([{ key, switch: true }]);
    // The field stays open after a refusal; closing it and opening it again with 貼り直す changes what a save does.
    await row(2).$(".text-btn").click();
    await row(2).$(".text-btn").click();
    await expect($("#claude-key")).toBeDisplayed();
    await types(key);
    await $("#claude-key button").click();
    expect(await waitForCalls(save, 2)).toEqual([{ key, switch: true }, { key, switch: false }]);
  });

  it("switches to the stored key with claude_method_set when its radio is pressed", async () => {
    await withKey("subscription");
    const set = await mock("claude_method_set", null);
    await mock("claude_connection", connection("apiKey", claudeLoggedOut, keyReady));
    await radio(2).click();
    expect(await waitForCalls(set)).toEqual([{ method: "apiKey" }]);
    await expect(row(2).$('input[type="radio"]')).toBeSelected();
    await expect(row(1).$(".status")).toHaveText("未ログイン");
    await expect($("#claude-key")).not.toBeDisplayed();
  });

  it("shows the error and leaves the method as it was when the switch fails", async () => {
    await withKey("subscription");
    await mock("claude_method_set", rejects("資格情報の読み取りに失敗: x"));
    await radio(2).click();
    await expect($("#error")).toHaveText(expect.stringContaining("資格情報の読み取りに失敗"));
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
  });

  it("goes back to the subscription with claude_method_set, and keeps the key", async () => {
    await withKey("apiKey");
    const set = await mock("claude_method_set", null);
    await mock("claude_key_delete", null);
    await mock("claude_connection", connection("subscription", claudeReady, keyReady));
    await radio(1).click();
    expect(await waitForCalls(set)).toEqual([{ method: "subscription" }]);
    await expect(row(1).$('input[type="radio"]')).toBeSelected();
    await expect(row(2).$(".status")).toHaveText("確認済み");
    expect(await callsOf("claude_key_delete")).toEqual([]);
  });

  it("calls nothing when the radio of the method in use is pressed", async () => {
    await withKey("subscription");
    await mock("claude_method_set", null);
    await radio(1).click();
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
    ["slackReply", "Slack のスレッドの相談", "スレッド詳細の Claude 欄"],
    ["orcaHandoff", "Orca に渡す要約", "Orca に渡すペインで、実装することを要約するとき"],
    ["todoChat", "Todo の相談", "Todo の Claude ペインで、タスクを頼むとき"],
  ];
  // The default effort of a purpose: medium, and high for the Slack thread conversation.
  const defaultEffort = (purpose: Purpose) => (purpose === "slackReply" ? "high" : "medium");
  const selectOf = (purpose: Purpose, kind: "model" | "effort") => $(`#claude-models select[data-purpose="${purpose}"][data-kind="${kind}"]`);
  // Sets a select as the user does (value, then change); the real WebView's select popup is not driven.
  const choose = (purpose: Purpose, kind: "model" | "effort", value: string) =>
    browser.execute(
      (id, p, k, v) => {
        if (!window.__e2e_once__(id)) return;
        const select = document.querySelector<HTMLSelectElement>(`#claude-models select[data-purpose="${p}"][data-kind="${k}"]`)!;
        select.value = v;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      },
      onceId(),
      purpose,
      kind,
      value,
    );
  const optionTexts = (select: ChainablePromiseElement) => select.$$("option").map((o) => o.getText());
  const drawnSelects = () => browser.execute(() => document.querySelectorAll("#claude-models select").length);

  for (const [state, status] of [["ready", claudeReady], ["loggedOut", claudeLoggedOut], ["missing", claudeMissing]] as const) {
    it(`has its own card with the defaults selected for the seven purposes, while Claude is ${state}`, async () => {
      await openSettings([], status, "claude");
      await expect($("#claude-models")).toBeDisplayed();
      await expect($("#claude-prompt .item-name")).toHaveText("Todo の要約プロンプト");
      expect(await drawnSelects()).toBe(14);
      for (const [purpose] of PURPOSES) {
        await expect(selectOf(purpose, "model")).toHaveValue("sonnet");
        await expect(selectOf(purpose, "effort")).toHaveValue(defaultEffort(purpose));
      }
    });
  }

  it("names the seven purposes in order, each with where it is used, and labels its selects", async () => {
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

  it("heads the columns 用途, モデル and effort, and says once that the default is Sonnet and medium, and Sonnet and high for the Slack reply", async () => {
    await openSettings([], claudeReady, "claude");
    expect(await textsOf("#claude-models .model-grid .th")).toEqual(["用途", "モデル", "effort"]);
    await expect($("#claude-models .model-note")).toHaveText("次の呼び出しから使います。デフォルトは Sonnet と medium（Slack のスレッドの相談は Sonnet と high）");
  });

  it("does not wrap the description of a purpose onto a second line", async () => {
    await openSettings([], claudeReady, "claude");
    const wrapped = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>("#claude-models .model-grid .who .item-meta")].map((e) => e.getBoundingClientRect().height > 20),
    );
    expect(wrapped).toEqual([false, false, false, false, false, false, false]);
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
        slackReply: { model: "haiku", effort: "xhigh" },
        orcaHandoff: { model: "opus", effort: "low" },
        todoChat: { model: "haiku", effort: "high" },
      },
    });
    await $("#nav-settings").click();
    await openTab("claude");
    await expect(selectOf("slackReply", "model")).toHaveValue("haiku");
    await expect(selectOf("slackReply", "effort")).toHaveValue("xhigh");
    await expect(selectOf("slackSummary", "model")).toHaveValue("opus");
    await expect(selectOf("slackSummary", "effort")).toHaveValue("xhigh");
    await expect(selectOf("mailSummary", "model")).toHaveValue("haiku");
    await expect(selectOf("mailSummary", "effort")).toHaveValue("low");
    await expect(selectOf("promptChat", "model")).toHaveValue("opus");
    await expect(selectOf("promptChat", "effort")).toHaveValue("high");
    await expect(selectOf("proofread", "model")).toHaveValue("sonnet");
    await expect(selectOf("proofread", "effort")).toHaveValue("max");
    await expect(selectOf("orcaHandoff", "model")).toHaveValue("opus");
    await expect(selectOf("orcaHandoff", "effort")).toHaveValue("low");
    await expect(selectOf("todoChat", "model")).toHaveValue("haiku");
    await expect(selectOf("todoChat", "effort")).toHaveValue("high");
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
        await expect(selectOf(other, "effort")).toHaveValue(defaultEffort(other));
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
          slackReply: { model: "sonnet", effort: "high" },
          orcaHandoff: { model: "sonnet", effort: "medium" },
          todoChat: { model: "sonnet", effort: "medium" },
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
          slackReply: { model: "sonnet", effort: "high" },
          orcaHandoff: { model: "sonnet", effort: "medium" },
          todoChat: { model: "sonnet", effort: "medium" },
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
      // xhigh differs from the four above (the Slack reply's high is promptChat's high).
      const save = await mock("claude_model_settings_save", { ...claudeSettings, proofread: { model: "sonnet", effort: "xhigh" } });
      await choose("proofread", "effort", "xhigh");
      await waitForCalls(save);
      seen.add(`${(await background("proofread")).value}/${(await colorOf("proofread")).value}`);
      expect(seen.size).toBe(5);
    });
  });

  it("says in the ? hint that each of the seven Claude calls has its own setting", async () => {
    await openSettings([], claudeReady, "claude");
    await $("#claude-help").click();
    await expect($('[role="dialog"][aria-label="Claude の使い方"] .foot')).toHaveText(
      expect.stringContaining("Slack の要約、メールの要約、プロンプトの会話、Slack に貼る文章の校正、Slack のスレッドの相談、Orca に渡す要約、Todo の相談のそれぞれに選べます"),
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

  it("checks again on 今すぐ確認, and redraws the card and the popup", async () => {
    await openUpdate();
    await expect(status()).toHaveText("最新");
    await expect($("#update-pop")).not.toBeDisplayed();
    await expect($("#update-items").$("button=更新して再起動")).not.toExist();
    const check = await mock("check_update", { version: "9.9.9", installed: false });
    await $("#update-recheck").click();
    expect(await waitForCalls(check)).toEqual([null]);
    await expect(status()).toHaveText("v9.9.9 があります");
    await expect($("#update-pop-title")).toHaveText("v9.9.9 があります");
  });

  it("has the same button as the popup in the card, which waits while it works, and still shows after あとで", async () => {
    await openUpdate({ update_mode: "manual", check_update: { version: "9.9.9", installed: false } });
    await expect(status()).toHaveText("v9.9.9 があります");
    await $("#update-later").click();
    await expect($("#update-pop")).not.toBeDisplayed();
    const button = $("#update-items").$("button=更新して再起動");
    await expect(button).toHaveClass(expect.stringContaining("primary"));
    const install = await mock("install_update", holds);
    const restart = await mock("restart_app", null);
    await button.click();
    await waitForCalls(install);
    await expect($("#update-items").$("button=更新して再起動")).toBeDisabled();
    await release(install, null);
    expect(await waitForCalls(restart)).toEqual([null]);
    expect(await callsOf(install)).toEqual([null]);
  });

  it("names the button 再起動 in the card once the app is replaced", async () => {
    await openUpdate({ update_mode: "auto", check_update: { version: "9.9.9", installed: false } });
    await expect(status()).toHaveText("再起動で v9.9.9 になります");
    const restart = await mock("restart_app", null);
    await $("#update-items").$("button=再起動").click();
    expect(await waitForCalls(restart)).toEqual([null]);
  });
});

describe("settings: Ghostty (the Orca tab)", () => {
  // The app with `fixtures` added, and the settings screen open on the Orca tab.
  async function openOrcaTab(fixtures: Record<string, unknown> = {}) {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, ...fixtures });
    await $("#nav-settings").click();
    await openTab("orca");
    await expect($("#settings-panel-orca")).toBeDisplayed();
  }

  const status = () => $("#ghostty-items .status");

  it("says nothing has been imported yet, and asks nothing of Ghostty by itself", async () => {
    await openOrcaTab();
    await expect(status()).toHaveText("未取り込み");
    await expect($("#ghostty-items .item-meta")).toHaveText("まだ取り込んでいません");
    await expect($("#ghostty-import")).toBeEnabled();
    expect(await callsOf("ghostty_import")).toEqual([]);
  });

  it("imports with the button, and lists the files read, the entries taken and the entries left with the reason", async () => {
    await openOrcaTab();
    const imported = await mock(
      "ghostty_import",
      ghosttyImport({
        imported: ["font-size = 14", "theme = light:Paper,dark:Dracula", "keybind = delete=text:\\x08"],
        skipped: [
          { entry: "window-width = 100", reason: "対応していません" },
          { entry: "theme = Nope", reason: "テーマ Nope が見つかりません" },
        ],
        files: ["~/.config/ghostty/config", "~/Library/Application Support/com.mitchellh.ghostty/config.ghostty"],
      }),
    );
    await $("#ghostty-import").click();
    expect(await waitForCalls(imported)).toEqual([null]);
    await expect(status()).toHaveText("取り込み済み");
    await expect($("#ghostty-items .item-meta")).toHaveText("読んだファイル: ~/.config/ghostty/config、~/Library/Application Support/com.mitchellh.ghostty/config.ghostty");
    await expect($("#ghostty-imported h3")).toHaveText("取り込んだ項目（3）");
    expect(await textsOf("#ghostty-imported li code")).toEqual(["font-size = 14", "theme = light:Paper,dark:Dracula", "keybind = delete=text:\\x08"]);
    await expect($("#ghostty-skipped h3")).toHaveText("取り込めなかった項目（2）");
    expect(await textsOf("#ghostty-skipped li code")).toEqual(["window-width = 100", "theme = Nope"]);
    expect(await textsOf("#ghostty-skipped .ghostty-reason")).toEqual(["対応していません", "テーマ Nope が見つかりません"]);
    await expect($("#ghostty-import")).toBeEnabled();
  });

  it("shows the import saved before, without reading the config again", async () => {
    await openOrcaTab({ ghostty_saved: ghosttyImport({ imported: ["font-size = 14"], skipped: [] }) });
    await expect(status()).toHaveText("取り込み済み");
    await expect($("#ghostty-imported h3")).toHaveText("取り込んだ項目（1）");
    await expect($("#ghostty-skipped h3")).toHaveText("取り込めなかった項目（0）");
    expect(await count("#ghostty-skipped li")).toBe(0);
    expect(await callsOf("ghostty_import")).toEqual([]);
  });

  it("shows the message when the config cannot be read, and keeps the import it had", async () => {
    await openOrcaTab({ ghostty_saved: ghosttyImport({ imported: ["font-size = 14"] }) });
    await mock("ghostty_import", rejects("Ghostty の設定ファイルが見つかりません。探した場所: ~/.config/ghostty/config.ghostty"));
    await $("#ghostty-import").click();
    await expect($("#error")).toHaveText("Ghostty の設定ファイルが見つかりません。探した場所: ~/.config/ghostty/config.ghostty");
    await expect(status()).toHaveText("取り込み済み");
    await expect($("#ghostty-imported h3")).toHaveText("取り込んだ項目（1）");
    await expect($("#ghostty-import")).toBeEnabled();
  });
});

describe("settings: terminal colors (the Orca tab, A-14, A-15)", () => {
  // The app with `fixtures` added, and the settings screen open on the Orca tab.
  async function openOrcaTab(fixtures: Record<string, unknown> = {}) {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, ...fixtures });
    await $("#nav-settings").click();
    await openTab("orca");
    await expect($("#settings-panel-orca")).toBeDisplayed();
  }

  const names = (id: string) => textsOf(`#${id} option`);
  // The background, the text color and the number of colors of the swatch in the row of `slot`.
  const swatch = (slot: "light" | "dark") =>
    browser.execute(
      (s) => {
        const box = document.getElementById(`terminal-theme-${s}`)!.parentElement!.querySelector<HTMLElement>(".theme-swatch")!;
        return { theme: box.dataset.theme, background: getComputedStyle(box).backgroundColor, color: getComputedStyle(box).color, dots: box.querySelectorAll(".theme-dots i").length, red: getComputedStyle(box.querySelectorAll<HTMLElement>(".theme-dots i")[1]!).backgroundColor };
      },
      slot,
    );

  it("puts the card of the colors above the card of Ghostty, with a row for the light and one for the dark appearance", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes() });
    expect(await textsOf("#settings-panel-orca > .card h2")).toEqual(["ターミナルの配色", "エディタ", "Ghostty の設定"]);
    expect(await textsOf("#terminal-theme-items .item-name")).toEqual(["外観", "ライト", "ダーク"]);
    expect(await textsOf("#terminal-theme-items .item-meta")).toEqual(["ターミナルが使うテーマ", "ライトの外観で使うテーマ", "ダークの外観で使うテーマ"]);
  });

  it("offers every theme in each row and shows the chosen one with its swatch", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes({ light: "One Light", dark: "Dracula" }) });
    const all = ["Ghostty Default Style Dark", "Builtin Tango Light", "Dracula", "One Light"];
    expect(await names("terminal-theme-light")).toEqual(all);
    expect(await names("terminal-theme-dark")).toEqual(all);
    await expect($("#terminal-theme-light")).toHaveValue("One Light");
    await expect($("#terminal-theme-dark")).toHaveValue("Dracula");
    expect(await swatch("light")).toEqual({ theme: "One Light", background: "rgb(253, 246, 227)", color: "rgb(101, 123, 131)", dots: 16, red: "rgb(220, 50, 47)" });
    expect(await swatch("dark")).toEqual({ theme: "Dracula", background: "rgb(40, 42, 54)", color: "rgb(248, 248, 242)", dots: 16, red: "rgb(255, 85, 85)" });
  });

  it("saves the theme chosen for one appearance with the other as it is, and draws its swatch", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes({ light: "One Light", dark: "Dracula" }) });
    const set = await mock("terminal_theme_set", { light: "One Light", dark: "Ghostty Default Style Dark", appearance: "system" });
    await chooseTheme("dark", "Ghostty Default Style Dark");
    expect(await waitForCalls(set)).toEqual([{ selection: { light: "One Light", dark: "Ghostty Default Style Dark", appearance: "system" } }]);
    await browser.waitUntil(async () => (await swatch("dark")).theme === "Ghostty Default Style Dark", { timeoutMsg: "the swatch never changed" });
    expect((await swatch("dark")).background).toBe("rgb(16, 32, 58)");
    expect((await swatch("light")).theme).toBe("One Light");
    await expect($("#terminal-theme-dark")).toHaveValue("Ghostty Default Style Dark");
    await expect($("#terminal-theme-dark")).toBeEnabled();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("offers system, light and dark for the appearance, with the system's as the default", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes() });
    expect(await names("terminal-theme-appearance")).toEqual(["システムに合わせる", "ライト", "ダーク"]);
    await expect($("#terminal-theme-appearance")).toHaveValue("system");
    await expect($("#terminal-theme-appearance")).toHaveAttribute("aria-label", "ターミナルの外観");
  });

  it("shows the saved appearance", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes({ appearance: "dark" }) });
    await expect($("#terminal-theme-appearance")).toHaveValue("dark");
  });

  it("saves the appearance chosen with both themes as they are", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes({ light: "One Light", dark: "Dracula" }) });
    const set = await mock("terminal_theme_set", { light: "One Light", dark: "Dracula", appearance: "light" });
    await chooseAppearance("light");
    expect(await waitForCalls(set)).toEqual([{ selection: { light: "One Light", dark: "Dracula", appearance: "light" } }]);
    await expect($("#terminal-theme-appearance")).toHaveValue("light");
    await expect($("#terminal-theme-appearance")).toBeEnabled();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("keeps the appearance when a theme is chosen", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes({ appearance: "dark" }) });
    const set = await mock("terminal_theme_set", { light: "Dracula", dark: "Ghostty Default Style Dark", appearance: "dark" });
    await chooseTheme("light", "Dracula");
    expect(await waitForCalls(set)).toEqual([{ selection: { light: "Dracula", dark: "Ghostty Default Style Dark", appearance: "dark" } }]);
  });

  it("shows the message of a failed save of the appearance and puts the saved one back", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes() });
    await mock("terminal_theme_set", rejects("保存できません"));
    await chooseAppearance("dark");
    await expect($("#error")).toHaveText("保存できません");
    await expect($("#terminal-theme-appearance")).toHaveValue("system");
    await expect($("#terminal-theme-appearance")).toBeEnabled();
  });

  it("shows the message of a failed save and puts the chosen theme back", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes({ light: "One Light", dark: "Dracula" }) });
    await mock("terminal_theme_set", rejects("テーマ Nope は選べません"));
    await chooseTheme("light", "Dracula");
    await expect($("#error")).toHaveText("テーマ Nope は選べません");
    await expect($("#terminal-theme-light")).toHaveValue("One Light");
    await expect($("#terminal-theme-light")).toBeEnabled();
    expect((await swatch("light")).theme).toBe("One Light");
  });

  it("asks for the themes at startup and by itself saves nothing", async () => {
    await openOrcaTab({ terminal_themes: terminalThemes() });
    expect(await callsOf("terminal_themes")).toEqual([null]);
    expect(await callsOf("terminal_theme_set")).toEqual([]);
  });

  it("shows the message of a failed read and no rows", async () => {
    await openOrcaTab({ terminal_themes: rejects("テーマを読めません") });
    await expect($("#error")).toHaveText("テーマを読めません");
    expect(await count("#terminal-theme-items .item")).toBe(0);
  });
});

// A-18: the editor card, between the card of the colors and the card of Ghostty. Rust brings the value into 100 to 3000 ms in steps of 100 (unit tests); here the field shows what Rust answers, and sends what was typed.
describe("settings: editor (the Orca tab, A-18)", () => {
  async function openOrcaTab(fixtures: Record<string, unknown> = {}) {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, ...fixtures });
    await $("#nav-settings").click();
    await openTab("orca");
    await expect($("#settings-panel-orca")).toBeDisplayed();
  }

  // Types `text` into the field and commits it, as the user does (value, then change).
  const typeMs = (text: string) =>
    browser.execute(
      (id, t) => {
        if (!window.__e2e_once__(id)) return;
        const input = document.getElementById("editor-autosave") as HTMLInputElement;
        input.value = t;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      onceId(),
      text,
    );

  it("has a card above Ghostty's with the time before the automatic save, 1000 ms to start with", async () => {
    await openOrcaTab();
    expect(await textsOf("#editor-items .item-name")).toEqual(["自動保存までの時間"]);
    await expect($("#editor-autosave")).toHaveValue("1000");
    await expect($("#editor-autosave")).toHaveAttribute("min", "100");
    await expect($("#editor-autosave")).toHaveAttribute("max", "3000");
    await expect($("#editor-autosave")).toHaveAttribute("step", "100");
    expect(await textsOf("#editor-items .item-meta")).toEqual(["ms"]);
    expect(await callsOf("editor_settings")).toEqual([null]);
    expect(await callsOf("editor_settings_set")).toEqual([]);
  });

  it("shows the time that was saved", async () => {
    await openOrcaTab({ editor_settings: { autosaveMs: 2500 } });
    await expect($("#editor-autosave")).toHaveValue("2500");
  });

  it("sends the number typed and shows the value Rust answers", async () => {
    await openOrcaTab();
    const set = await mock("editor_settings_set", { autosaveMs: 100 });
    await typeMs("50");
    expect(await waitForCalls(set)).toEqual([{ autosaveMs: 50 }]);
    await expect($("#editor-autosave")).toHaveValue("100");
    await expect($("#editor-autosave")).toBeEnabled();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("sends nothing for what is not a number, and shows the time held", async () => {
    await openOrcaTab();
    const set = await mock("editor_settings_set", { autosaveMs: 100 });
    await typeMs("");
    await expect($("#editor-autosave")).toHaveValue("1000");
    expect(await callsOf(set)).toEqual([]);
  });

  it("shows the message of a failed save and puts the time held back", async () => {
    await openOrcaTab();
    await mock("editor_settings_set", rejects("editor-settings.json を書けません"));
    await typeMs("300");
    await expect($("#error")).toHaveText("editor-settings.json を書けません");
    await expect($("#editor-autosave")).toHaveValue("1000");
    await expect($("#editor-autosave")).toBeEnabled();
  });

  it("opens a hint with the range from the ? of the card", async () => {
    await openOrcaTab();
    await $("#editor-help").click();
    await expect($('.pop[aria-label="エディタ"]')).toBeDisplayed();
    await expect($("#editor-help")).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the message of a failed read and leaves the field empty", async () => {
    await openOrcaTab({ editor_settings: rejects("editor-settings.json を読めません") });
    await expect($("#error")).toHaveText("editor-settings.json を読めません");
    await expect($("#editor-autosave")).toHaveValue("");
    await expect($("#editor-autosave")).toBeDisabled();
  });
});

// A-20: the Font tab. Rust brings every value into its range and checks the family against the Mac's (unit tests); here the selects show what Rust answers, send what was chosen, and the screens take the choice at once.
describe("settings: fonts (the Font tab, A-20)", () => {
  async function openFontTab(fixtures: Record<string, unknown> = {}) {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, ...fixtures });
    await $("#nav-settings").click();
    await openTab("font");
    await expect($("#settings-panel-font")).toBeDisplayed();
  }

  // The computed font of the root of a screen: the size and the first family.
  const fontOf = (selector: string) =>
    browser.execute((s) => {
      const style = getComputedStyle(document.querySelector(s)!);
      return { size: style.fontSize, family: style.fontFamily };
    }, selector);
  const rootVar = (name: string) => browser.execute((n) => document.documentElement.style.getPropertyValue(n), name);
  // The family (quotes left out) of the element `selector` finds in `html`, made for the check: a screen that draws it is not open.
  const familyOfNew = (html: string, selector: string) =>
    browser.execute(
      (h, sel) => {
        const holder = document.createElement("div");
        holder.innerHTML = h;
        document.body.append(holder);
        const family = getComputedStyle(holder.querySelector(sel)!).fontFamily;
        holder.remove();
        return family.replace(/"/g, "");
      },
      html,
      selector,
    );
  // The body of a text mail (`.plain`), and the code in a popup.
  const plainFamily = () => familyOfNew('<div class="plain">text</div>', ".plain");
  const codeFamily = () => familyOfNew('<div class="pop"><code>x</code></div>', "code");
  const options = (id: string) => browser.execute((i) => [...(document.getElementById(i) as HTMLSelectElement).options].map((o) => o.textContent), id);
  const selectedText = (id: string) => browser.execute((i) => (document.getElementById(i) as HTMLSelectElement).selectedOptions[0]!.textContent, id);

  it("has a card with a row for each place, in the order of the screens", async () => {
    await openFontTab();
    expect(await textsOf("#font-items .item-name")).toEqual(["アプリ全体", "メール", "カレンダー", "Todo", "Todo", "Slack", "Orca", "Orca", "Orca", "Orca", "等幅の文字"]);
    expect(await textsOf("#font-items .item-meta")).toEqual([
      "設定、メニュー、ポップアップ",
      "画面全体",
      "画面全体",
      "プロジェクト一覧",
      "作業スペース",
      "画面全体",
      "プロジェクト一覧",
      "作業スペース（チャットとファイル）",
      "作業スペース（ターミナル）",
      "エディタ",
      "書体のみ",
    ]);
    // A family and a size for every row, but the monospace text: it has a family only.
    expect(await count("#font-items select")).toBe(21);
    expect(await count("#font-mono-size")).toBe(0);
    expect(await count("#font-mono-family")).toBe(1);
    expect(await callsOf("font_settings")).toEqual([null]);
    expect(await callsOf("font_families")).toEqual([null]);
    expect(await callsOf("font_settings_set")).toEqual([]);
  });

  it("offers the families of this Mac after the system's, and Ghostty's only for the work space of Orca", async () => {
    await openFontTab();
    expect(await options("font-mail-family")).toEqual(["システム標準", "Hiragino Sans", "Menlo", "Times New Roman"]);
    expect(await options("font-orca-work-family")).toEqual(["システム標準", "Ghostty の設定に従う", "Hiragino Sans", "Menlo", "Times New Roman"]);
    expect(await options("font-editor-family")).toEqual(["システム標準", "Hiragino Sans", "Menlo", "Times New Roman"]);
    for (const id of ["font-app-family", "font-orca-pane-family", "font-mono-family"]) expect(await options(id)).toEqual(["システム標準", "Hiragino Sans", "Menlo", "Times New Roman"]);
  });

  it("offers the sizes 8 to 32 px, and the half size the editor has", async () => {
    await openFontTab();
    const sizes = await options("font-mail-size");
    expect(sizes.length).toBe(25);
    expect([sizes[0], sizes[6], sizes[24]]).toEqual(["8 px", "14 px", "32 px"]);
    expect(await options("font-editor-size")).toContain("12.5 px");
    expect(await selectedText("font-editor-size")).toBe("12.5 px");
    expect(await selectedText("font-mail-size")).toBe("14 px");
  });

  it("shows the saved choice: the families, the sizes, and the terminals following Ghostty with no size to choose", async () => {
    await openFontTab({ font_settings: fontSettings({ mail: { family: "Menlo", size: 16, ghostty: false } }) });
    expect(await selectedText("font-mail-family")).toBe("Menlo");
    expect(await selectedText("font-mail-size")).toBe("16 px");
    expect(await selectedText("font-orca-work-family")).toBe("Ghostty の設定に従う");
    await expect($("#font-orca-work-size")).toBeDisabled();
    await expect($("#font-mail-size")).toBeEnabled();
  });

  it("keeps a saved family this Mac lacks in the select, and says so", async () => {
    await openFontTab({ font_settings: fontSettings({ slack: { family: "Gone Sans", size: 14, ghostty: false } }) });
    expect(await selectedText("font-slack-family")).toBe("Gone Sans（この Mac にありません）");
  });

  it("applies the saved choice at the start, before the settings are opened", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, font_settings: fontSettings({ calendar: { family: "Menlo", size: 21, ghostty: false } }) });
    await browser.waitUntil(async () => (await fontOf("#calendar")).size === "21px", { timeoutMsg: "the calendar never took the size" });
    expect((await fontOf("#calendar")).family).toContain("Menlo");
    expect(await rootVar("--ff-calendar")).toBe('"Menlo", var(--ff-base)');
    expect(await rootVar("--fs-calendar")).toBe("1.5");
  });

  it("draws a plain button of the screen with the family and size chosen too", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, font_settings: fontSettings({ calendar: { family: "Menlo", size: 21, ghostty: false } }) });
    // 11px of its own, times 21 / 14.
    await browser.waitUntil(async () => (await fontOf("#cal-today")).size === "16.5px", { timeoutMsg: "the button never took the size" });
    expect((await fontOf("#cal-today")).family).toContain("Menlo");
  });

  it("saves the size of a place whose family this Mac has lost, with the family it holds", async () => {
    await openFontTab({ font_settings: fontSettings({ slack: { family: "Gone Sans", size: 14, ghostty: false } }) });
    const set = await mock("font_settings_set", fontSettings({ slack: { family: "Gone Sans", size: 18, ghostty: false } }));
    await chooseOption("font-slack-size", "18");
    expect(await waitForCalls(set)).toEqual([{ area: "slack", family: "Gone Sans", size: 18, ghostty: false }]);
    expect(await selectedText("font-slack-family")).toBe("Gone Sans（この Mac にありません）");
  });

  it("sends the family chosen and draws the screen with it at once", async () => {
    await openFontTab();
    const set = await mock("font_settings_set", fontSettings({ mail: { family: "Hiragino Sans", size: 14, ghostty: false } }));
    await chooseOption("font-mail-family", "family:Hiragino Sans");
    expect(await waitForCalls(set)).toEqual([{ area: "mail", family: "Hiragino Sans", size: 14, ghostty: false }]);
    await browser.waitUntil(async () => (await fontOf("#mail-area")).family.includes("Hiragino Sans"), { timeoutMsg: "the mail never took the family" });
    expect((await fontOf("#inbox-header")).family).toContain("Hiragino Sans");
    // The other screens keep the system's.
    expect((await fontOf("#calendar")).family).not.toContain("Hiragino Sans");
    expect(await selectedText("font-mail-family")).toBe("Hiragino Sans");
    await expect($("#error")).not.toBeDisplayed();
    await expect($("#font-mail-family")).toBeEnabled();
  });

  it("sends the size chosen and draws the screen with it at once, text that sets its own size in the same ratio", async () => {
    await openFontTab();
    const set = await mock("font_settings_set", fontSettings({ calendar: { family: null, size: 21, ghostty: false } }));
    const before = await browser.execute(() => parseFloat(getComputedStyle(document.getElementById("cal-title")!).fontSize));
    await chooseOption("font-calendar-size", "21");
    expect(await waitForCalls(set)).toEqual([{ area: "calendar", family: null, size: 21, ghostty: false }]);
    await browser.waitUntil(async () => (await fontOf("#calendar")).size === "21px", { timeoutMsg: "the calendar never took the size" });
    // #cal-title is 20px of its own: 20 * 21 / 14.
    expect(before).toBe(20);
    expect(await browser.execute(() => getComputedStyle(document.getElementById("cal-title")!).fontSize)).toBe("30px");
    expect((await fontOf("#mail-area")).size).toBe("14px");
  });

  it("chooses the list and the work space of Todo apart", async () => {
    await openFontTab();
    const set = await mock("font_settings_set", fontSettings({ todoList: { family: "Menlo", size: 18, ghostty: false } }));
    await chooseOption("font-todo-list-size", "18");
    expect(await waitForCalls(set)).toEqual([{ area: "todoList", family: null, size: 18, ghostty: false }]);
    await browser.waitUntil(async () => (await fontOf("#projects")).size === "18px", { timeoutMsg: "the list never took the size" });
    expect((await fontOf("#todo-body")).size).toBe("14px");
    expect(await rootVar("--fs-todo-work")).toBe("");
  });

  it("gives the screens of Todo, Slack and Orca their own variables", async () => {
    await openFontTab();
    const answers = [
      ["todoWork", { family: "Menlo", size: 16, ghostty: false }, "#todo-body", "font-todo-work-size", "16"],
      ["slack", { family: "Menlo", size: 15, ghostty: false }, "#slack-list", "font-slack-size", "15"],
      ["orcaList", { family: "Menlo", size: 17, ghostty: false }, "#orca-list", "font-orca-list-size", "17"],
    ] as const;
    for (const [area, pick, selector, id, size] of answers) {
      const set = await mock("font_settings_set", fontSettings({ [area]: pick }));
      await chooseOption(id, size);
      await waitForCalls(set);
      await browser.waitUntil(async () => (await fontOf(selector)).size === `${size}px`, { timeoutMsg: `${selector} never took the size` });
    }
  });

  it("goes back to the system's font and size", async () => {
    await openFontTab({ font_settings: fontSettings({ mail: { family: "Menlo", size: 20, ghostty: false } }) });
    await browser.waitUntil(async () => (await fontOf("#mail-area")).size === "20px");
    const set = await mock("font_settings_set", fontSettings());
    await chooseOption("font-mail-family", "own");
    expect(await waitForCalls(set)).toEqual([{ area: "mail", family: null, size: 20, ghostty: false }]);
    await browser.waitUntil(async () => (await fontOf("#mail-area")).family.includes("Menlo") === false);
    expect(await rootVar("--ff-mail")).toBe("");
    expect(await rootVar("--fs-mail")).toBe("");
    expect((await fontOf("#mail-area")).size).toBe("14px");
  });

  it("stops following Ghostty when a family is chosen for the terminals, and follows again when Ghostty is chosen", async () => {
    await openFontTab();
    const set = await mock("font_settings_set", fontSettings({ orcaWork: { family: "Menlo", size: 13, ghostty: false } }));
    await chooseOption("font-orca-work-family", "family:Menlo");
    expect(await waitForCalls(set)).toEqual([{ area: "orcaWork", family: "Menlo", size: 13, ghostty: false }]);
    await expect($("#font-orca-work-size")).toBeEnabled();
    const again = await mock("font_settings_set", fontSettings({ orcaWork: { family: "Menlo", size: 13, ghostty: true } }));
    await chooseOption("font-orca-work-family", "ghostty");
    expect(await waitForCalls(again)).toEqual([{ area: "orcaWork", family: "Menlo", size: 13, ghostty: true }]);
    await expect($("#font-orca-work-size")).toBeDisabled();
    expect(await selectedText("font-orca-work-family")).toBe("Ghostty の設定に従う");
  });

  it("gives the editor its variables, apart from the terminals", async () => {
    await openFontTab();
    const set = await mock("font_settings_set", fontSettings({ editor: { family: "Menlo", size: 16, ghostty: false } }));
    await chooseOption("font-editor-size", "16");
    expect(await waitForCalls(set)).toEqual([{ area: "editor", family: null, size: 16, ghostty: false }]);
    await browser.waitUntil(async () => (await rootVar("--editor-size")) === "16px");
    expect(await rootVar("--editor-family")).toBe('"Menlo", ui-monospace, Menlo, monospace');
  });

  it("puts no variable on the root while the app, the pane of Orca and the monospace text have their first values", async () => {
    await openFontTab();
    for (const name of ["--ff-app", "--fs-app", "--ff-orca-pane", "--fs-orca-pane", "--ff-mono"]) expect(await rootVar(name)).toBe("");
    expect((await fontOf("body")).size).toBe("14px");
    expect((await fontOf("#orca-work")).size).toBe("14px");
    expect((await fontOf("#orca-files")).size).toBe("14px");
    // The first family of the app, and the monospace stack as it was.
    expect((await fontOf("body")).family.replace(/"/g, "")).toBe("-apple-system, sans-serif");
    expect(await plainFamily()).toBe("HackGen Console NF no U+3000, ui-monospace, Menlo, monospace");
    expect(await selectedText("font-app-family")).toBe("システム標準");
    expect(await selectedText("font-app-size")).toBe("14 px");
    expect(await selectedText("font-orca-pane-size")).toBe("14 px");
  });

  it("sends the family chosen for the whole app, and draws the places at the system's family with it too", async () => {
    await openFontTab({ font_settings: fontSettings({ mail: { family: "Hiragino Sans", size: 16, ghostty: false } }) });
    const set = await mock("font_settings_set", fontSettings({ app: { family: "Menlo", size: 14, ghostty: false }, mail: { family: "Hiragino Sans", size: 16, ghostty: false } }));
    await chooseOption("font-app-family", "family:Menlo");
    expect(await waitForCalls(set)).toEqual([{ area: "app", family: "Menlo", size: 14, ghostty: false }]);
    await browser.waitUntil(async () => (await fontOf("body")).family.includes("Menlo"), { timeoutMsg: "the app never took the family" });
    expect(await rootVar("--ff-app")).toBe('"Menlo", -apple-system, sans-serif');
    // A place at the system's family follows it; a place with a family of its own keeps it.
    expect((await fontOf("#calendar")).family).toContain("Menlo");
    expect((await fontOf("#orca-list")).family).toContain("Menlo");
    expect((await fontOf("#orca-work")).family).toContain("Menlo");
    expect((await fontOf("#mail-area")).family).toContain("Hiragino Sans");
    expect(await selectedText("font-app-family")).toBe("Menlo");
  });

  it("sends the size chosen for the whole app, and draws only the parts outside the places with it", async () => {
    await openFontTab({ font_settings: fontSettings({ slack: { family: null, size: 16, ghostty: false } }) });
    const set = await mock("font_settings_set", fontSettings({ app: { family: null, size: 21, ghostty: false }, slack: { family: null, size: 16, ghostty: false } }));
    await chooseOption("font-app-size", "21");
    expect(await waitForCalls(set)).toEqual([{ area: "app", family: null, size: 21, ghostty: false }]);
    await browser.waitUntil(async () => (await fontOf("body")).size === "21px", { timeoutMsg: "the app never took the size" });
    expect(await rootVar("--fs-app")).toBe("1.5");
    // The hint of a row (12px of its own) is outside the places: 12 * 21 / 14.
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#font-items .item-meta")!).fontSize)).toBe("18px");
    // The places keep their own sizes: the first 14 px, and the one chosen.
    for (const selector of ["#mail-area", "#calendar", "#projects", "#todo-body", "#orca-list", "#orca-work", "#orca-files"]) expect((await fontOf(selector)).size).toBe("14px");
    expect((await fontOf("#slack-list")).size).toBe("16px");
  });

  it("keeps the settings inside the window at the largest size of the whole app", async () => {
    await openFontTab({ font_settings: fontSettings({ app: { family: null, size: 32, ghostty: false } }) });
    await browser.waitUntil(async () => (await fontOf("body")).size === "32px", { timeoutMsg: "the app never took the size" });
    const overflow = await browser.execute(() => {
      const settings = document.getElementById("settings")!;
      return settings.scrollWidth - settings.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await expect($("#font-app-size")).toBeDisplayed();
    await expect($("#font-mono-family")).toBeDisplayed();
  });

  it("sends the family and size chosen for the chat and the files of the work pane of Orca, and draws them at once", async () => {
    await openFontTab();
    const set = await mock("font_settings_set", fontSettings({ orcaPane: { family: "Menlo", size: 21, ghostty: false } }));
    await chooseOption("font-orca-pane-family", "family:Menlo");
    expect(await waitForCalls(set)).toEqual([{ area: "orcaPane", family: "Menlo", size: 14, ghostty: false }]);
    await browser.waitUntil(async () => (await fontOf("#orca-work")).size === "21px", { timeoutMsg: "the pane never took the size" });
    expect(await rootVar("--ff-orca-pane")).toBe('"Menlo", var(--ff-base)');
    expect(await rootVar("--fs-orca-pane")).toBe("1.5");
    for (const selector of ["#orca-work", "#orca-files"]) {
      expect((await fontOf(selector)).family).toContain("Menlo");
      expect((await fontOf(selector)).size).toBe("21px");
    }
    // The list of projects keeps its own.
    expect((await fontOf("#orca-list")).size).toBe("14px");
    expect((await fontOf("#orca-list")).family).not.toContain("Menlo");
    // The file pane's heading is 12px of its own: 12 * 21 / 14.
    expect(await browser.execute(() => getComputedStyle(document.getElementById("orca-files-title")!).fontSize)).toBe("18px");
  });

  it("sends the family of the monospace text with no size that counts, and puts it in front of the stacks", async () => {
    await openFontTab();
    const set = await mock("font_settings_set", fontSettings({ mono: { family: "Menlo", size: 14, ghostty: false } }));
    await chooseOption("font-mono-family", "family:Menlo");
    expect(await waitForCalls(set)).toEqual([{ area: "mono", family: "Menlo", size: 14, ghostty: false }]);
    await browser.waitUntil(async () => (await rootVar("--ff-mono")) !== "", { timeoutMsg: "the monospace never took the family" });
    expect(await rootVar("--ff-mono")).toBe('"Menlo",');
    // The text of a mail keeps the face that leaves out U+3000 after the family chosen.
    expect(await plainFamily()).toBe("Menlo, HackGen Console NF no U+3000, ui-monospace, Menlo, monospace");
    expect(await codeFamily()).toBe("Menlo, ui-monospace, monospace");
    // Nothing else takes it, and no size is set for it.
    expect(await rootVar("--fs-mono")).toBe("");
    expect((await fontOf("body")).family).not.toContain("Menlo");
    expect(await count("#font-mono-size")).toBe(0);
    await expect($("#font-mono-family")).toBeEnabled();
    expect(await selectedText("font-mono-family")).toBe("Menlo");
  });

  it("goes back to the monospace stacks as they were when the system's is chosen", async () => {
    await openFontTab({ font_settings: fontSettings({ mono: { family: "Menlo", size: 14, ghostty: false } }) });
    await browser.waitUntil(async () => (await rootVar("--ff-mono")) === '"Menlo",');
    const set = await mock("font_settings_set", fontSettings());
    await chooseOption("font-mono-family", "own");
    expect(await waitForCalls(set)).toEqual([{ area: "mono", family: null, size: 14, ghostty: false }]);
    await browser.waitUntil(async () => (await rootVar("--ff-mono")) === "", { timeoutMsg: "the monospace never went back" });
    expect(await plainFamily()).toBe("HackGen Console NF no U+3000, ui-monospace, Menlo, monospace");
    expect(await codeFamily()).toBe("ui-monospace, monospace");
  });

  it("applies the saved choice of the new places at the start", async () => {
    await boot({
      inbox: inbox(),
      slack_load: slackLoad,
      slack_check: checked([]),
      claude_status: claudeMissing,
      font_settings: fontSettings({ app: { family: "Menlo", size: 18, ghostty: false }, orcaPane: { family: null, size: 16, ghostty: false }, mono: { family: "Hiragino Sans", size: 14, ghostty: false } }),
    });
    await browser.waitUntil(async () => (await fontOf("body")).size === "18px", { timeoutMsg: "the app never took the size" });
    expect((await fontOf("body")).family).toContain("Menlo");
    expect((await fontOf("#orca-work")).size).toBe("16px");
    expect(await rootVar("--ff-mono")).toBe('"Hiragino Sans",');
    expect(await rootVar("--ff-orca-pane")).toBe("");
  });

  it("shows the message of a failed save and puts the choice held back", async () => {
    await openFontTab();
    await mock("font_settings_set", rejects("font-settings.json を書けません"));
    await chooseOption("font-slack-size", "20");
    await expect($("#error")).toHaveText("font-settings.json を書けません");
    expect(await selectedText("font-slack-size")).toBe("14 px");
    await expect($("#font-slack-size")).toBeEnabled();
    expect((await fontOf("#slack-list")).size).toBe("14px");
  });

  it("shows the message of a failed read and draws no row", async () => {
    await openFontTab({ font_settings: rejects("font-settings.json を読めません") });
    await expect($("#error")).toHaveText("font-settings.json を読めません");
    expect(await count("#font-items .item")).toBe(0);
  });

  it("shows the message of a failed list of families, with the system's alone to choose", async () => {
    await openFontTab({ font_families: rejects("書体の一覧を読めません") });
    await expect($("#error")).toHaveText("書体の一覧を読めません");
    expect(await options("font-mail-family")).toEqual(["システム標準"]);
  });

  it("opens a hint from the ? of the card", async () => {
    await openFontTab();
    await $("#font-help").click();
    await expect($('.pop[aria-label="フォント"]')).toBeDisplayed();
    await expect($("#font-help")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("settings: tabs", () => {
  const tab = (name: Tab) => $(`#settings-tab-${name}`);
  const panel = (name: Tab) => $(`#settings-panel-${name}`);
  const selected = () => browser.execute(() => [...document.querySelectorAll('#settings-tabs [role="tab"]')].filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.id));
  // Left or right pressed on the selected tab, as the key event the app listens for.
  const pressArrow = (key: "ArrowLeft" | "ArrowRight") =>
    browser.execute(
      (id, k) => {
        if (!window.__e2e_once__(id)) return;
        const current = document.querySelector('#settings-tabs [role="tab"][aria-selected="true"]')!;
        current.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      },
      onceId(),
      key,
    );

  it("has the eight tabs in order, in a tablist, each controlling the card it names", async () => {
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

describe("settings: Slack channels kept off the list", () => {
  const rows = () => textsOf("#slack-hidden .item");

  it("lists them after the connection card with a dot in the workspace's color, #channel, the workspace name and a count, and the channel's ID when its name is not known", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), slack_hidden_list: [hiddenChannel("C0123ABCD", "general"), hiddenChannel("C9ZZ", "C9ZZ")], claude_status: claudeMissing });
    await $("#nav-settings").click();
    await openTab("slack");
    await waitForCount("#slack-hidden .item", 2);
    await expect($("#settings-panel-slack .card:nth-of-type(2) h2")).toHaveText("一覧に出さないチャンネル");
    await expect($("#slack-hidden-count")).toHaveText("2 件");
    expect(await rows()).toEqual(["#generalExample Team戻す", "C9ZZExample Team戻す"]);
    const dots = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#slack-hidden .hidden-dot")].map((d) => d.style.background));
    expect(dots.every((d) => d !== "")).toBe(true);
    await expect($('button[aria-label="#general を一覧に戻す"]')).toExist();
    await expect($('button[aria-label="C9ZZ を一覧に戻す"]')).toExist();
  });

  it("puts a channel back with 戻す: slack_unhide_channel is called with its IDs and the card is read again", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), slack_hidden_list: [hiddenChannel("C0123ABCD", "general"), hiddenChannel("C2", "random")], claude_status: claudeMissing });
    await $("#nav-settings").click();
    await openTab("slack");
    await waitForCount("#slack-hidden .item", 2);
    const unhide = await mock("slack_unhide_channel", true);
    await mock("slack_hidden_list", [hiddenChannel("C2", "random")]);
    await mock("slack_timeline", timeline([]));
    await $('button[aria-label="#general を一覧に戻す"]').click();
    expect(await waitForCalls(unhide)).toEqual([{ teamId: "T1", channel: "C0123ABCD" }]);
    // The Slack list is made again from Rust's cache, with no read of Slack.
    expect(await waitForCalls("slack_timeline")).toEqual([{ cached: true }]);
    await browser.pause(300);
    expect(await callsOf("slack_timeline")).toEqual([{ cached: true }]);
    await waitForCount("#slack-hidden .item", 1);
    await expect($("#slack-hidden-count")).toHaveText("1 件");
  });

  it("says there are none, with a count of 0", async () => {
    await openSettings([], claudeMissing, "slack");
    await expect($("#slack-hidden .card-empty")).toHaveText("一覧に出さないチャンネルはありません");
    await expect($("#slack-hidden-count")).toHaveText("0 件");
  });
});
