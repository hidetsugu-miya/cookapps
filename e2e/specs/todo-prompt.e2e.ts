import { boot, callsOf, count, claudeLoggedOut, claudeMissing, claudeReady, claudeSettings, holds, inbox, mock, promptEdit, rejects, release, slackLoad, textsOf, todoData, todoPrompt, waitForCalls, waitForCount, waitForText } from "../support";

const edited = { ...todoPrompt, body: "My body", edited: true };
// What Claude answers when the request changes nothing.
const answer = { reply: "答えです", body: null, diff: [] };

const body = () => $("#prompt-body");
const input = () => $("#prompt-input");
const apply = () => $(".diff-foot .text-btn.primary");
const reject = () => $(".diff-foot .text-btn:not(.primary)");

// The rows of the Claude tab are drawn again for each answer: wait until the connection rows and the prompt row are in.
const settled = () =>
  browser.waitUntil(async () => {
    const statuses = [...(await textsOf("#claude-items .status")), ...(await textsOf("#claude-prompt .status"))];
    return statuses.length === 3 && !statuses.includes("確認中");
  });

// The app with the settings open and the prompt screen opened from its row; `state` is what `claude_todo_prompt` answers.
async function openPrompt(claude: unknown = claudeReady, state = todoPrompt) {
  await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claude, claude_todo_prompt: state });
  await $("#nav-settings").click();
  await $("#settings-tab-claude").click();
  await settled();
  await $("#claude-prompt .text-btn").click();
  await expect($("#prompt")).toBeDisplayed();
}

// Cmd+Enter (Ctrl+Enter off macOS) in the request field, sent as the key event the app listens for; `composing` makes it the Enter that confirms an IME conversion.
const pressSend = (composing = false) =>
  browser.execute((c) => {
    const mac = /Mac/.test(navigator.platform);
    const key = new KeyboardEvent("keydown", { key: "Enter", metaKey: mac, ctrlKey: !mac, isComposing: c, bubbles: true, cancelable: true });
    document.getElementById("prompt-input")!.dispatchEvent(key);
  }, composing);

// Puts `lines` lines in the request field as typing does (value, then input).
const fillLines = (lines: number) =>
  browser.execute((n) => {
    const area = document.getElementById("prompt-input") as HTMLTextAreaElement;
    area.value = Array.from({ length: n }, (_, i) => `行${i + 1}`).join("\n");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, lines);

const heightOf = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().height, selector);

// Asks Claude for `text` and waits until the `replies`th reply is drawn.
async function ask(text: string, reply: unknown = promptEdit, replies = 1) {
  const edit = await mock("claude_edit_todo_prompt", reply);
  await input().setValue(text);
  await $("#prompt-send").click();
  await waitForCalls(edit);
  await waitForCount("#prompt-log .chat-ai", replies);
  return edit;
}

describe("todo prompt screen", () => {
  it("shows the fixed part and the saved instructions, with nothing to save, and 戻る returns to the settings", async () => {
    await openPrompt();
    await expect($("#nav-settings")).toHaveAttribute("aria-current", "page");
    await expect($("#prompt-fixed")).toHaveText(expect.stringContaining("Today is {today}."));
    await expect($("#prompt-fixed-after")).toHaveText("Fixed tail");
    await expect(body()).toHaveValue("Default body");
    await expect(body()).toBeEnabled();
    await expect($("#prompt-status")).not.toBeDisplayed();
    await expect($("#prompt-save")).toBeDisabled();
    await expect($("#prompt-reset")).toBeDisabled();
    await $("#prompt-back").click();
    await expect($("#settings")).toBeDisplayed();
    await expect($("#prompt")).not.toBeDisplayed();
    await expect($("#nav-settings")).toHaveAttribute("aria-current", "page");
  });

  it("returns to the Claude tab it was opened from, not to Google", async () => {
    await openPrompt();
    await $("#prompt-back").click();
    await expect($("#settings-tab-claude")).toHaveAttribute("aria-selected", "true");
    await expect($("#settings-panel-claude")).toBeDisplayed();
    await expect($("#settings-panel-google")).not.toBeDisplayed();
  });

  it("marks an edited field 未保存の変更 and saves it with 保存", async () => {
    await openPrompt();
    const save = await mock("claude_todo_prompt_save", edited);
    await body().setValue("My body");
    await expect($("#prompt-status")).toHaveText("未保存の変更");
    await expect($("#prompt-save")).toBeEnabled();
    expect(await callsOf(save)).toEqual([]);
    await $("#prompt-save").click();
    expect(await waitForCalls(save)).toEqual([{ body: "My body" }]);
    // What the file now holds: the settings read it again.
    await mock("claude_todo_prompt", edited);
    await expect($("#prompt-status")).not.toBeDisplayed();
    await expect($("#prompt-save")).toBeDisabled();
    await expect($(".toast")).toHaveText(expect.stringContaining("保存しました"));
    await $("#prompt-back").click();
    await waitForText("#claude-prompt .status", "編集済み");
    expect(await textsOf("#claude-items .status")).toEqual(["ログイン中", "未登録"]);
  });

  it("shows the error and keeps the field unsaved when the save is refused", async () => {
    await openPrompt();
    await mock("claude_todo_prompt_save", rejects("指示が空です。デフォルトに戻すか、指示を書いてください"));
    await body().setValue(" ");
    await $("#prompt-save").click();
    await expect($("#prompt-error")).toHaveText(expect.stringContaining("指示が空です"));
    await expect($("#prompt-status")).toBeDisplayed();
    await expect($("#prompt-save")).toBeEnabled();
  });

  it("goes back to the default with two presses of デフォルトに戻す and shows it in the field", async () => {
    await openPrompt(claudeReady, edited);
    await expect(body()).toHaveValue("My body");
    await expect($("#prompt-reset")).toBeEnabled();
    const reset = await mock("claude_todo_prompt_reset", todoPrompt);
    await $("#prompt-reset").click();
    await expect($("#prompt-reset")).toHaveText("もう一度押すと戻す");
    expect(await callsOf(reset)).toEqual([]);
    await $("#prompt-reset").click();
    expect(await waitForCalls(reset)).toEqual([null]);
    await expect(body()).toHaveValue("Default body");
    await expect($("#prompt-status")).not.toBeDisplayed();
    await expect($("#prompt-reset")).toBeDisabled();
    await mock("claude_todo_prompt", todoPrompt);
    await $("#prompt-back").click();
    await waitForText("#claude-prompt .status", "デフォルト");
    expect(await textsOf("#claude-items .status")).toEqual(["ログイン中", "未登録"]);
  });

  it("disarms デフォルトに戻す when the button is left, and sends nothing", async () => {
    await openPrompt(claudeReady, edited);
    const reset = await mock("claude_todo_prompt_reset", todoPrompt);
    await $("#prompt-reset").click();
    await expect($("#prompt-reset")).toHaveText("もう一度押すと戻す");
    await body().click();
    await expect($("#prompt-reset")).toHaveText("デフォルトに戻す");
    expect(await callsOf(reset)).toEqual([]);
  });

  it("disables 保存 and デフォルトに戻す while one of them is on its way", async () => {
    await openPrompt(claudeReady, edited);
    const save = await mock("claude_todo_prompt_save", holds);
    await body().setValue("Other body");
    await $("#prompt-save").click();
    await waitForCalls(save);
    await expect($("#prompt-save")).toBeDisabled();
    await expect($("#prompt-reset")).toBeDisabled();
    await release(save, { ...edited, body: "Other body" });
    await expect($(".toast")).toHaveText(expect.stringContaining("保存しました"));
    await expect($("#prompt-reset")).toBeEnabled();
  });

  it("keeps the field and the conversation when the screen is left and opened again", async () => {
    await openPrompt();
    await ask("短くして");
    await body().setValue("Typed by hand");
    const reads = (await callsOf("claude_todo_prompt")).length;
    await $("#prompt-back").click();
    await expect($("#settings")).toBeDisplayed();
    // The settings read the instructions again; opening the screen does not.
    await waitForCalls("claude_todo_prompt", reads + 1);
    await settled();
    await $("#claude-prompt .text-btn").click();
    await expect(body()).toHaveValue("Typed by hand");
    await expect($("#prompt-status")).toBeDisplayed();
    await expect($("#prompt-log .chat-user")).toHaveText("短くして");
    await expect($("#prompt-log .chat-ai")).toHaveText(expect.stringContaining(promptEdit.reply));
    expect((await callsOf("claude_todo_prompt")).length).toBe(reads + 1);
  });
});

describe("todo prompt screen: the conversation with Claude", () => {
  it("sends the field, the conversation so far and the request, and shows the reply with the changed lines", async () => {
    await openPrompt();
    const edit = await ask("短くして");
    expect(await callsOf(edit)).toEqual([{ body: "Default body", history: [], instruction: "短くして" }]);
    await expect(input()).toHaveValue("");
    await expect($("#prompt-log .chat-user")).toHaveText("短くして");
    await expect($("#prompt-log .chat-ai")).toHaveText(expect.stringContaining("1行目を変えます"));
    await expect($("#prompt-log .diff-del")).toHaveText("- Default body");
    await expect($("#prompt-log .diff-ins")).toHaveText("+ Better body");
    await expect(apply()).toBeEnabled();
    await expect(reject()).toBeEnabled();
    // Showing a proposal changes neither the field nor the saved instructions.
    await expect(body()).toHaveValue("Default body");
    await expect($("#prompt-status")).not.toBeDisplayed();
    await expect($(".chat-diff .diff-state")).not.toExist();

    await mock("claude_edit_todo_prompt", answer);
    await input().setValue("ありがとう");
    await $("#prompt-send").click();
    const second = await waitForCalls("claude_edit_todo_prompt");
    expect(second).toEqual([
      {
        body: "Default body",
        history: [
          { role: "user", text: "短くして" },
          { role: "assistant", text: "1行目を変えます" },
        ],
        instruction: "ありがとう",
      },
    ]);
    await waitForCount("#prompt-log .chat-ai", 2);
    // A reply that changes nothing has no lines to apply.
    expect(await count("#prompt-log .chat-diff")).toBe(1);
  });

  it("sends nothing for an empty request", async () => {
    await openPrompt();
    const edit = await mock("claude_edit_todo_prompt", promptEdit);
    await input().setValue("   ");
    await $("#prompt-send").click();
    expect(await callsOf(edit)).toEqual([]);
    await expect($("#prompt-log .chat-user")).not.toExist();
  });

  it("applies a proposal to the field, and saves nothing", async () => {
    await openPrompt();
    await ask("短くして");
    const save = await mock("claude_todo_prompt_save", todoPrompt);
    await apply().click();
    await expect(body()).toHaveValue("Better body");
    await expect($(".chat-diff .diff-state")).toHaveText("適用しました");
    await expect(apply()).not.toExist();
    await expect($("#prompt-status")).toBeDisplayed();
    await expect($("#prompt-save")).toBeEnabled();
    expect(await callsOf(save)).toEqual([]);
  });

  it("rejects a proposal and leaves the field as it was", async () => {
    await openPrompt();
    await ask("短くして");
    await reject().click();
    await expect($(".chat-diff .diff-state")).toHaveText("却下しました");
    await expect(apply()).not.toExist();
    await expect(body()).toHaveValue("Default body");
    await expect($("#prompt-status")).not.toBeDisplayed();
  });

  it("cannot apply an old proposal after the field was changed by hand, and can again when it is back as it was", async () => {
    await openPrompt();
    await ask("短くして");
    await body().setValue("Typed by hand");
    await expect(apply()).toBeDisabled();
    await expect($(".diff-stale")).toBeDisplayed();
    await expect(reject()).toBeEnabled();
    await body().setValue("Default body");
    await expect(apply()).toBeEnabled();
    await expect($(".diff-stale")).not.toBeDisplayed();
  });

  it("cannot apply an older proposal once a newer one was applied", async () => {
    await openPrompt();
    await ask("短くして");
    await ask("別の案も", { reply: "別の案です", body: "Third body", diff: [{ kind: "del", text: "Default body" }, { kind: "ins", text: "Third body" }] }, 2);
    expect(await count(".diff-foot .text-btn.primary")).toBe(2);
    await apply().click();
    await expect(body()).toHaveValue("Better body");
    // The other proposal was made from the text before this one.
    await expect(apply()).toBeDisabled();
    await expect($(".diff-stale")).toBeDisplayed();
  });

  it("shows a spinner and disables the request while Claude is answering", async () => {
    await openPrompt();
    const edit = await mock("claude_edit_todo_prompt", holds);
    await input().setValue("短くして");
    await $("#prompt-send").click();
    await waitForCalls(edit);
    await expect($("#prompt-log .spin")).toExist();
    await expect(input()).toBeDisabled();
    await expect($("#prompt-send")).toBeDisabled();
    await release(edit, promptEdit);
    await expect($("#prompt-log .spin")).not.toExist();
    await expect(input()).toBeEnabled();
    await expect($("#prompt-log .diff-ins")).toExist();
  });

  it("shows a failed request as a warning, and does not send it as part of the conversation next time", async () => {
    await openPrompt();
    await mock("claude_edit_todo_prompt", rejects("Claude が時間内に終わりませんでした"));
    await input().setValue("短くして");
    await $("#prompt-send").click();
    await expect($("#prompt-log .pending.fail")).toHaveText(expect.stringContaining("送れませんでした: Claude が時間内に終わりませんでした"));
    await expect(input()).toBeEnabled();
    const edit = await ask("もう一度", answer);
    expect(await callsOf(edit)).toEqual([{ body: "Default body", history: [{ role: "user", text: "短くして" }], instruction: "もう一度" }]);
  });

  for (const [name, claude] of [["not logged in", claudeLoggedOut], ["missing", claudeMissing]] as const) {
    it(`disables the request with the reason while Claude is ${name}, and the field stays editable`, async () => {
      await openPrompt(claude);
      await expect(input()).toBeDisabled();
      await expect($("#prompt-send")).toBeDisabled();
      await expect($("#prompt-chat-note")).toHaveText("Claude にログインすると、会話で編集できます");
      await expect(body()).toBeEnabled();
    });
  }
});

describe("todo prompt screen: the request field", () => {
  it("is one line high, with the key hint under it and the send button beside the hint", async () => {
    await openPrompt();
    expect(await $("#prompt-input").getTagName()).toBe("textarea");
    expect(await heightOf("#prompt-input")).toBe(20);
    const mac = await browser.execute(() => /Mac/.test(navigator.platform));
    await expect($("#prompt-keys")).toHaveText(mac ? "↩ で改行、⌘↩ で送信" : "Enter で改行、Ctrl+Enter で送信");
    await expect($("#prompt-send")).toHaveElementClass("primary");
    expect(await heightOf("#prompt-send")).toBe(26);
  });

  it("takes plain Enter as a line break and sends nothing", async () => {
    await openPrompt();
    const edit = await mock("claude_edit_todo_prompt", promptEdit);
    await input().setValue("一行目");
    await browser.keys("Enter");
    await browser.keys("二行目");
    await expect(input()).toHaveValue("一行目\n二行目");
    expect(await callsOf(edit)).toEqual([]);
    await expect($("#prompt-log .chat-user")).not.toExist();
  });

  it("sends the whole text with its line breaks on Cmd+Enter, shows the breaks, and goes back to one line", async () => {
    await openPrompt();
    const edit = await mock("claude_edit_todo_prompt", promptEdit);
    await input().setValue("一行目");
    await browser.keys("Enter");
    await browser.keys("二行目");
    await browser.keys("Enter");
    await browser.keys("三行目");
    expect(await heightOf("#prompt-input")).toBe(60);
    await pressSend();
    expect(await waitForCalls(edit)).toEqual([{ body: "Default body", history: [], instruction: "一行目\n二行目\n三行目" }]);
    await waitForCount("#prompt-log .chat-ai", 1);
    await expect(input()).toHaveValue("");
    expect(await heightOf("#prompt-input")).toBe(20);
    await expect($("#prompt-log .chat-user")).toHaveText("一行目\n二行目\n三行目");
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".chat-user")!).whiteSpace)).toBe("pre-wrap");
  });

  it("does not send on Cmd+Enter that only confirms an IME conversion", async () => {
    await openPrompt();
    const edit = await mock("claude_edit_todo_prompt", promptEdit);
    await input().setValue("変換中");
    await pressSend(true);
    expect(await callsOf(edit)).toEqual([]);
    await expect(input()).toHaveValue("変換中");
  });

  it("sends nothing on Cmd+Enter with an empty request", async () => {
    await openPrompt();
    const edit = await mock("claude_edit_todo_prompt", promptEdit);
    await pressSend();
    expect(await callsOf(edit)).toEqual([]);
  });

  it("grows with its lines up to 6, then scrolls inside; the bottom stays put, the log shrinks and stays at its end", async () => {
    await openPrompt();
    await ask("短くして", { ...answer, reply: "あ".repeat(3000) });
    const log = () => browser.execute(() => {
      const e = document.getElementById("prompt-log")!;
      return { height: e.clientHeight, fromEnd: e.scrollHeight - e.scrollTop - e.clientHeight, overflows: e.scrollHeight > e.clientHeight };
    });
    const before = await log();
    expect(before.overflows).toBe(true);
    const bottom = () => browser.execute(() => document.getElementById("prompt-form")!.getBoundingClientRect().bottom);
    const bottomBefore = await bottom();
    const heights: number[] = [];
    for (const lines of [1, 2, 6, 7, 12]) {
      await fillLines(lines);
      heights.push(await heightOf("#prompt-input"));
    }
    expect(heights).toEqual([20, 40, 120, 120, 120]);
    // Past 6 lines the field scrolls inside.
    expect(await browser.execute(() => {
      const a = document.getElementById("prompt-input")!;
      return a.scrollHeight > a.clientHeight;
    })).toBe(true);
    expect(await bottom()).toBe(bottomBefore);
    const after = await log();
    expect(after.height).toBeLessThan(before.height);
    expect(after.fromEnd).toBeLessThan(4);
    await fillLines(1);
    expect(await heightOf("#prompt-input")).toBe(20);
  });
});

describe("todo prompt screen: clearing the conversation", () => {
  const clear = () => $("#prompt-clear");

  it("is a small button at the right end of the header, disabled while there is no conversation", async () => {
    await openPrompt();
    await expect(clear()).toHaveText("クリア");
    await expect(clear()).toBeDisabled();
    expect(await heightOf("#prompt-clear")).toBe(26);
    expect(await browser.execute(() => document.querySelector("#prompt-chat .chat-head")!.lastElementChild!.id)).toBe("prompt-clear");
    await ask("短くして");
    await expect(clear()).toBeEnabled();
  });

  it("clears with two presses, and the next request is sent with an empty history", async () => {
    await openPrompt();
    await ask("短くして");
    await clear().click();
    await expect(clear()).toHaveText("もう一度押すとクリア");
    await expect(clear()).toHaveElementClass("confirm");
    await expect(clear()).toHaveElementClass("danger");
    await expect($("#prompt-log .chat-user")).toExist();
    await clear().click();
    await expect($("#prompt-log .chat-user")).not.toExist();
    await expect($("#prompt-log .chat-ai")).not.toExist();
    await expect(clear()).toHaveText("クリア");
    await expect(clear()).toBeDisabled();
    const edit = await ask("次の頼み", answer);
    expect(await callsOf(edit)).toEqual([{ body: "Default body", history: [], instruction: "次の頼み" }]);
  });

  it("leaves the field, the saved instructions and the text being typed alone", async () => {
    await openPrompt();
    await ask("短くして");
    await body().setValue("Typed by hand");
    await input().setValue("書きかけ");
    const save = await mock("claude_todo_prompt_save", todoPrompt);
    await clear().click();
    await clear().click();
    await expect($("#prompt-log .chat-user")).not.toExist();
    await expect(body()).toHaveValue("Typed by hand");
    await expect(input()).toHaveValue("書きかけ");
    await expect($("#prompt-status")).toBeDisplayed();
    expect(await callsOf(save)).toEqual([]);
  });

  it("disarms when the button is left, and keeps the conversation", async () => {
    await openPrompt();
    await ask("短くして");
    await clear().click();
    await expect(clear()).toHaveText("もう一度押すとクリア");
    await body().click();
    await expect(clear()).toHaveText("クリア");
    await expect(clear()).not.toHaveElementClass("danger");
    await expect($("#prompt-log .chat-user")).toExist();
  });

  it("is disabled while Claude is answering", async () => {
    await openPrompt();
    await ask("短くして");
    const edit = await mock("claude_edit_todo_prompt", holds);
    await input().setValue("もう一度");
    await $("#prompt-send").click();
    await waitForCalls(edit);
    await expect(clear()).toBeDisabled();
    await release(edit, promptEdit);
    await expect(clear()).toBeEnabled();
  });
});

describe("todo prompt screen: the model and effort of the conversation", () => {
  const selectOf = (kind: "model" | "effort") => $(`#prompt-model select[data-purpose="promptChat"][data-kind="${kind}"]`);
  const settingsSelect = (kind: "model" | "effort") => $(`#claude-models select[data-purpose="promptChat"][data-kind="${kind}"]`);
  // Sets a select as the user does (value, then change); the real WebView's select popup is not driven.
  const choose = (scope: string, kind: "model" | "effort", value: string) =>
    browser.execute(
      (sc, k, v) => {
        const select = document.querySelector<HTMLSelectElement>(`${sc} select[data-purpose="promptChat"][data-kind="${k}"]`)!;
        select.value = v;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      },
      scope,
      kind,
      value,
    );
  const saved = { ...claudeSettings, promptChat: { model: "opus", effort: "high" } } as const;

  // The Todo screen with the prompt opened by the icon of its heading: the settings screen was never visited.
  async function openFromTodo(settings: unknown = claudeSettings) {
    await boot({ inbox: inbox(), todoist_load: todoData(), slack_load: slackLoad, claude_status: claudeReady, claude_model_settings: settings });
    await $("#nav-todo").click();
    await waitForCount("#todo-list li.task", 1);
    await $("#todo-prompt").click();
    await expect($("#prompt")).toBeDisplayed();
  }

  it("puts a model select and an effort select, borderless and short, under the request field", async () => {
    await openPrompt();
    await expect(selectOf("model")).toBeDisplayed();
    await expect(selectOf("effort")).toBeDisplayed();
    expect(await count("#prompt-model select")).toBe(2);
    expect(await selectOf("model").$$("option").map((o) => o.getText())).toEqual(["Haiku", "Sonnet", "Opus"]);
    expect(await selectOf("effort").$$("option").map((o) => o.getText())).toEqual(["low", "medium", "high", "xhigh", "max"]);
    await expect(selectOf("model")).toHaveAttribute("aria-label", "モデル");
    await expect(selectOf("effort")).toHaveAttribute("aria-label", "effort");
    await expect(selectOf("model")).toHaveValue("sonnet");
    await expect(selectOf("effort")).toHaveValue("medium");
    // After the composer, inside the form, and without a border.
    expect(await browser.execute(() => document.querySelector("#prompt-form > .composer")?.nextElementSibling?.id)).toBe("prompt-model");
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#prompt-model select")!).borderTopWidth)).toBe("0px");
  });

  it("is on the prompt screen only, not on the Slack compose screen", async () => {
    await openPrompt();
    expect(await count("#slack-compose select")).toBe(0);
    expect(await count("#prompt-model select")).toBe(2);
  });

  it("shows the saved values of the prompt conversation when opened from Todo, without visiting the settings", async () => {
    await openFromTodo(saved);
    await expect(selectOf("model")).toHaveValue("opus");
    await expect(selectOf("effort")).toHaveValue("high");
    expect((await callsOf("claude_model_settings")).length).toBeGreaterThan(0);
  });

  it("saves a model with the purpose promptChat and no effort, an effort with both, and the settings show it", async () => {
    await openPrompt();
    const save = await mock("claude_model_settings_save", { ...claudeSettings, promptChat: { model: "opus", effort: "medium" } });
    await choose("#prompt-model", "model", "opus");
    expect(await waitForCalls(save)).toEqual([{ purpose: "promptChat", model: "opus" }]);
    await expect(selectOf("model")).toHaveValue("opus");
    const saveEffort = await mock("claude_model_settings_save", { ...claudeSettings, promptChat: { model: "opus", effort: "max" } });
    await choose("#prompt-model", "effort", "max");
    expect(await waitForCalls(saveEffort)).toEqual([{ purpose: "promptChat", model: "opus", effort: "max" }]);
    await expect(selectOf("effort")).toHaveValue("max");
    // What the file now holds: the settings read it again.
    await mock("claude_model_settings", { ...claudeSettings, promptChat: { model: "opus", effort: "max" } });
    await $("#prompt-back").click();
    await expect(settingsSelect("model")).toHaveValue("opus");
    await expect(settingsSelect("effort")).toHaveValue("max");
    // The other purposes are as they were.
    await expect($('#claude-models select[data-purpose="proofread"][data-kind="model"]')).toHaveValue("sonnet");
  });

  it("shows a change made in the settings", async () => {
    await openPrompt();
    await $("#prompt-back").click();
    const save = await mock("claude_model_settings_save", { ...claudeSettings, promptChat: { model: "sonnet", effort: "high" } });
    await choose("#claude-models", "effort", "high");
    expect(await waitForCalls(save)).toEqual([{ purpose: "promptChat", model: "sonnet", effort: "high" }]);
    await expect(settingsSelect("effort")).toHaveValue("high");
    // What the file now holds: opening the prompt screen reads it again.
    await mock("claude_model_settings", { ...claudeSettings, promptChat: { model: "sonnet", effort: "high" } });
    await $("#claude-prompt .text-btn").click();
    await expect(selectOf("effort")).toHaveValue("high");
  });

  it("draws the effort Rust saved for the model, and colors the effort text by its value without a background", async () => {
    await openPrompt();
    await expect(selectOf("effort")).toHaveAttribute("data-effort", "medium");
    const medium = await selectOf("effort").getCSSProperty("color");
    const save = await mock("claude_model_settings_save", { ...claudeSettings, promptChat: { model: "sonnet", effort: "high" } });
    await choose("#prompt-model", "model", "sonnet");
    expect(await waitForCalls(save)).toEqual([{ purpose: "promptChat", model: "sonnet" }]);
    await expect(selectOf("effort")).toHaveValue("high");
    await expect(selectOf("effort")).toHaveAttribute("data-effort", "high");
    expect((await selectOf("effort").getCSSProperty("color")).value).not.toBe(medium.value);
    expect((await selectOf("effort").getCSSProperty("background-color")).value).toBe("rgba(0,0,0,0)");
  });

  it("puts the selection back and shows the error when it cannot be saved", async () => {
    await openPrompt();
    await mock("claude_model_settings_save", rejects("モデルが不正です: x"));
    await choose("#prompt-model", "model", "haiku");
    await expect($("#error")).toHaveText(expect.stringContaining("モデルが不正です"));
    await expect(selectOf("model")).toHaveValue("sonnet");
  });

  it("disables both selects while the save is on its way", async () => {
    await openPrompt();
    const save = await mock("claude_model_settings_save", holds);
    await choose("#prompt-model", "effort", "low");
    await waitForCalls(save);
    await expect(selectOf("model")).toBeDisabled();
    await expect(selectOf("effort")).toBeDisabled();
    await release(save, { ...claudeSettings, promptChat: { model: "sonnet", effort: "low" } });
    await expect(selectOf("effort")).toBeEnabled();
    await expect(selectOf("effort")).toHaveValue("low");
  });
});
