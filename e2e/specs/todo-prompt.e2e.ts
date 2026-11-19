import { askScreen, boot, callsOf, count, claudeReady, holds, inbox, mock, rejects, release, slackLoad, textsOf, todoPrompt, waitForCalls, waitForText } from "../support";

const edited = { ...todoPrompt, body: "My body", edited: true };

const body = () => $("#prompt-body");
const term = "#prompt-term";

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

  it("makes the header a place to drag the window by", async () => {
    await openPrompt();
    await expect($("#prompt > header")).toHaveAttribute("data-tauri-drag-region", "deep");
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

  it("keeps the field when the screen is left and opened again", async () => {
    await openPrompt();
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
    expect((await callsOf("claude_todo_prompt")).length).toBe(reads + 1);
  });
});

describe("todo prompt screen: Claude Code", () => {
  // What the owner sees of the pane: no conversation of `claude -p` is left (no log, request field, model selects or clear button), and no help text.
  it("has the terminal and やり直す in the pane and none of the conversation, with no placeholder and no note", async () => {
    await openPrompt();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($("#prompt-restart")).toHaveText("やり直す");
    await expect($("#prompt-restart")).toBeEnabled();
    expect(await browser.execute(() => document.querySelector("#prompt-chat .chat-head")!.lastElementChild!.id)).toBe("prompt-restart");
    expect(await count("#prompt-log, #prompt-input, #prompt-form, #prompt-send, #prompt-model, #prompt-clear, #prompt-chat-note, #prompt-chat select")).toBe(0);
    expect(await count("#prompt textarea[placeholder], #prompt input[placeholder]")).toBe(0);
  });

  it("starts Claude Code with the tools of tsunagiai-mcp only and a first instruction that tells the work, the tools and the target, with nothing of the field", async () => {
    await openPrompt();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "todo-prompt", builtinTools: false, permissionMode: "manual", skill: null });
    const { prompt, viewport } = start as { prompt: string; viewport: { cols: number; rows: number } };
    for (const word of ["Todo", "screen_read", "screen_write", "todo-prompt", "body", "従わない"]) expect(prompt).toContain(word);
    expect(prompt).not.toContain("Default body");
    expect(prompt).not.toContain("Today is {today}.");
    expect(viewport.cols).toBeGreaterThan(20);
    expect(viewport.rows).toBeGreaterThan(5);
    for (const command of ["claude_edit_todo_prompt", "claude_chat_thread", "orca_stream_terminal", "orca_terminal_read"]) expect(await callsOf(command)).toEqual([]);
  });

  it("starts nothing before the screen is opened, and starts the process once while the screen is left and opened again", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady, claude_todo_prompt: todoPrompt });
    await $("#nav-settings").click();
    await $("#settings-tab-claude").click();
    await settled();
    expect(await callsOf("claude_code_start")).toEqual([]);
    await $("#claude-prompt .text-btn").click();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await $("#prompt-back").click();
    await expect($(term)).not.toBeDisplayed();
    await settled();
    await $("#claude-prompt .text-btn").click();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    expect(await callsOf(close)).toEqual([]);
  });

  it("ends the process and starts a new one with やり直す", async () => {
    await openPrompt();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await $("#prompt-restart").click();
    expect(await waitForCalls(close)).toEqual([{ id: "todo-prompt", launch: 1 }]);
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts).toHaveLength(2);
    await expect($("#prompt-restart")).toBeEnabled();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  });

  it("answers a read with the text of the field as it is now, and only that field", async () => {
    await openPrompt();
    expect(await askScreen("read", "todo-prompt")).toEqual({ ok: true, fields: { body: "Default body" } });
    await body().setValue("Typed by hand");
    expect(await askScreen("read", "todo-prompt")).toEqual({ ok: true, fields: { body: "Typed by hand" } });
  });

  it("answers an error for the screen when it is not open", async () => {
    await openPrompt();
    await $("#prompt-back").click();
    expect(await askScreen("read", "todo-prompt")).toEqual({ ok: false, error: expect.stringContaining("画面が開いていません") });
    expect((await askScreen("write", "todo-prompt", { body: "x" })).ok).toBe(false);
    await expect($("#settings")).toBeDisplayed();
  });

  it("writes the field as it is, saves nothing, shows 元に戻す before デフォルトに戻す, and puts the text back", async () => {
    await openPrompt();
    const save = await mock("claude_todo_prompt_save", todoPrompt);
    await expect($("#prompt-undo")).not.toBeDisplayed();
    expect(await askScreen("write", "todo-prompt", { body: "Written by Claude Code\n  indented" })).toEqual({ ok: true });
    await expect(body()).toHaveValue("Written by Claude Code\n  indented");
    await expect($("#prompt-status")).toHaveText("未保存の変更");
    await expect($("#prompt-save")).toBeEnabled();
    await expect($("#prompt-undo")).toHaveText("元に戻す");
    expect(await browser.execute(() => document.getElementById("prompt-undo")!.nextElementSibling!.id)).toBe("prompt-reset");
    expect(await callsOf(save)).toEqual([]);
    await $("#prompt-undo").click();
    await expect(body()).toHaveValue("Default body");
    await expect($("#prompt-undo")).not.toBeDisplayed();
    await expect($("#prompt-status")).not.toBeDisplayed();
    expect(await callsOf(save)).toEqual([]);
  });

  it("takes the writes back one by one, the newest first", async () => {
    await openPrompt();
    await askScreen("write", "todo-prompt", { body: "First" });
    await askScreen("write", "todo-prompt", { body: "Second" });
    await $("#prompt-undo").click();
    await expect(body()).toHaveValue("First");
    await expect($("#prompt-undo")).toBeDisplayed();
    await $("#prompt-undo").click();
    await expect(body()).toHaveValue("Default body");
    await expect($("#prompt-undo")).not.toBeDisplayed();
  });

  it("has no way back for a write that changes nothing, and none once the field was changed by hand", async () => {
    await openPrompt();
    await askScreen("write", "todo-prompt", { body: "Default body" });
    await expect($("#prompt-undo")).not.toBeDisplayed();
    await askScreen("write", "todo-prompt", { body: "Written" });
    await expect($("#prompt-undo")).toBeDisplayed();
    await body().setValue("Written and typed");
    await expect($("#prompt-undo")).not.toBeDisplayed();
  });

  it("has no way back after the field went back to the default", async () => {
    await openPrompt(claudeReady, edited);
    await askScreen("write", "todo-prompt", { body: "Written" });
    await expect($("#prompt-undo")).toBeDisplayed();
    await mock("claude_todo_prompt_reset", todoPrompt);
    await $("#prompt-reset").click();
    await $("#prompt-reset").click();
    await expect(body()).toHaveValue("Default body");
    await expect($("#prompt-undo")).not.toBeDisplayed();
  });

  it("refuses a write of a field the screen does not have, and leaves the field alone", async () => {
    await openPrompt();
    expect(await askScreen("write", "todo-prompt", { fixed: "x" })).toEqual({ ok: false, error: expect.stringContaining("欄 fixed はありません") });
    await expect(body()).toHaveValue("Default body");
    await expect($("#prompt-undo")).not.toBeDisplayed();
  });

  it("refuses a write while a save is on its way", async () => {
    await openPrompt(claudeReady, edited);
    const save = await mock("claude_todo_prompt_save", holds);
    await body().setValue("Other body");
    await $("#prompt-save").click();
    await waitForCalls(save);
    expect(await askScreen("write", "todo-prompt", { body: "Written" })).toEqual({ ok: false, error: expect.stringContaining("保存の最中") });
    await release(save, { ...edited, body: "Other body" });
    await expect($(".toast")).toHaveText(expect.stringContaining("保存しました"));
    await expect(body()).toHaveValue("Other body");
  });

  it("saves what Claude Code wrote only when 保存 is pressed", async () => {
    await openPrompt();
    await askScreen("write", "todo-prompt", { body: "Written" });
    const save = await mock("claude_todo_prompt_save", { ...todoPrompt, body: "Written", edited: true });
    await $("#prompt-save").click();
    expect(await waitForCalls(save)).toEqual([{ body: "Written" }]);
  });

  it("shows a refused save as the error line, as for a text typed by hand", async () => {
    await openPrompt();
    await askScreen("write", "todo-prompt", { body: " " });
    await mock("claude_todo_prompt_save", rejects("指示が空です。デフォルトに戻すか、指示を書いてください"));
    await $("#prompt-save").click();
    await expect($("#prompt-error")).toHaveText(expect.stringContaining("指示が空です"));
    await expect($("#prompt-status")).toBeDisplayed();
  });
});
