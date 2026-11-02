import { boot, callsOf, count, claudeLoggedOut, claudeMissing, claudeReady, holds, inbox, mock, promptEdit, rejects, release, slackLoad, textsOf, todoPrompt, waitForCalls, waitForCount, waitForText } from "../support";

const edited = { ...todoPrompt, body: "My body", edited: true };
// What Claude answers when the request changes nothing.
const answer = { reply: "答えです", body: null, diff: [] };

const body = () => $("#prompt-body");
const input = () => $("#prompt-input");
const apply = () => $(".diff-foot .text-btn.primary");
const reject = () => $(".diff-foot .text-btn:not(.primary)");

// The rows of the Claude card are drawn again for each answer: wait until both are in.
const settled = () =>
  browser.waitUntil(async () => {
    const statuses = await textsOf("#claude-items .status");
    return statuses.length === 2 && !statuses.includes("確認中");
  });

// The app with the settings open and the prompt screen opened from its row; `state` is what `claude_todo_prompt` answers.
async function openPrompt(claude: unknown = claudeReady, state = todoPrompt) {
  await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claude, claude_todo_prompt: state });
  await $("#nav-settings").click();
  await settled();
  await $("#claude-items .item:nth-child(2) .text-btn").click();
  await expect($("#prompt")).toBeDisplayed();
}

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
    await waitForText("#claude-items .status", "編集済み");
    expect(await textsOf("#claude-items .status")).toEqual(["ログイン中", "編集済み"]);
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

  it("goes back to the default with デフォルトに戻す and shows it in the field", async () => {
    await openPrompt(claudeReady, edited);
    await expect(body()).toHaveValue("My body");
    await expect($("#prompt-reset")).toBeEnabled();
    const reset = await mock("claude_todo_prompt_reset", todoPrompt);
    await $("#prompt-reset").click();
    expect(await waitForCalls(reset)).toEqual([null]);
    await expect(body()).toHaveValue("Default body");
    await expect($("#prompt-status")).not.toBeDisplayed();
    await expect($("#prompt-reset")).toBeDisabled();
    await mock("claude_todo_prompt", todoPrompt);
    await $("#prompt-back").click();
    await waitForText("#claude-items .status", "デフォルト");
    expect(await textsOf("#claude-items .status")).toEqual(["ログイン中", "デフォルト"]);
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
    await $("#claude-items .item:nth-child(2) .text-btn").click();
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
