import { boot, callsOf, claudeReady, count, emitEvent, inbox, mock, slackLoad, slackMessageUrl, slackSummary, task, today, todoData, waitForCalls, waitForCount, openTodo } from "../support";

// The Claude pane of the Todo screen (T-7): the terminal of Claude Code (A-36) in the right side.
const pane = "#todo-claude";
const term = "#todo-claude-term";
// A press with the pointer actions. The driver's element click calls `el.click()` and then `el.focus()` on the element itself, which would take the focus back from the field that the press gave it.
const press = (target: ChainablePromiseElement) => browser.action("pointer").move({ origin: target }).down().up().perform();
// The terminal's area is empty until the process is asked for; pressing it asks.
const startByPress = () => press($(term));
// The commands of the old conversation, which the pane calls no more, and the commands that make a Todoist task: the pane starts a terminal and calls none of them.
const notCalled = ["claude_chat_todo", "todoist_add", "todoist_add_task", "todoist_add_subtask", "todoist_update", "todoist_set_done", "todoist_add_from_slack", "todoist_delete", "todoist_move", "orca_stream_terminal", "orca_terminal_read"];

describe("todo Claude pane", () => {
  it("is open from the start in a right side with the ✳ alone in its first row, and its head has the mark, Claude and やり直す only", async () => {
    await openTodo();
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-split")).toBeDisplayed();
    await expect($("#todo-split")).toHaveAttribute("aria-label", "Claude の幅");
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-label", "Claude に相談");
    // Nothing is chosen on the right side, so the ✳ has no pressed state, and the Orca icon is not in the row.
    await expect($("#todo-tool-claude")).not.toHaveAttribute("aria-pressed");
    expect(await count("#todo-tool-orca, #todo-tools #todo-orca-open")).toBe(0);
    await expect($(`${pane} .chat-head`)).toHaveText(expect.stringContaining("Claude"));
    expect(await count(`${pane} .chat-head > svg`)).toBe(1);
    await expect($("#todo-claude-restart")).toHaveText("やり直す");
    await expect($("#todo-claude-restart")).toBeEnabled();
    // The conversation of the old pane is gone: no log, no request field, no model select, no clear button, no note.
    expect(await count("#todo-claude-log, #todo-claude-input, #todo-claude-send, #todo-claude-model, #todo-claude-clear, #todo-claude-chat-note, #todo-claude-form")).toBe(0);
    // The buttons that were in the header of the tasks, and the close icon of the pane, are gone.
    expect(await count("#todo-prompt, #todo-claude-btn, #todo-orca, #todo-claude-close")).toBe(0);
    // The first row: the ✳ alone, at the right of the right side; the header of the tasks and this row are tinted the same and meet at the same line.
    const rows = await browser.execute(() => {
      const head = document.querySelector("#todo-body > header")!.getBoundingClientRect();
      const tools = document.querySelector("#todo-tools")!.getBoundingClientRect();
      const claude = document.querySelector("#todo-tool-claude")!.getBoundingClientRect();
      const color = (s: string) => getComputedStyle(document.querySelector(s)!);
      return {
        level: Math.abs(head.bottom - tools.bottom) < 1,
        right: tools.right - claude.right < 40,
        same: color("#todo-body > header").backgroundColor === color("#todo-tools").backgroundColor && color("#todo-body > header").borderBottomColor === color("#todo-tools").borderBottomColor,
        line: color("#todo-tools").borderBottomWidth,
        heights: [head.height, tools.height, claude.height],
      };
    });
    expect(rows).toEqual({ level: true, right: true, same: true, line: "2px", heights: [44, 44, 28] });
    // The second row is the heading of the pane, 48px high, with やり直す at its right end.
    const heading = await browser.execute(() => {
      const head = document.querySelector("#todo-claude .chat-head")!.getBoundingClientRect();
      const button = document.querySelector("#todo-claude-restart")!.getBoundingClientRect();
      return { height: head.height, right: head.right - button.right < 24 };
    });
    expect(heading).toEqual({ height: 48, right: true });
  });

  it("starts no process when the screen is shown, hidden and shown again, or the window changes its visibility, and its empty area has a size and no text", async () => {
    await openTodo();
    await expect($(pane)).toBeDisplayed();
    const area = await browser.execute(() => {
      const host = document.querySelector("#todo-claude-term")!;
      return { height: host.getBoundingClientRect().height, text: host.textContent, children: host.children.length };
    });
    expect(area.height).toBeGreaterThan(100);
    expect(area.text).toBe("");
    expect(area.children).toBe(0);
    await $("#nav-mail").click();
    await expect($(pane)).not.toBeDisplayed();
    await $("#nav-todo").click();
    await expect($(pane)).toBeDisplayed();
    await browser.execute(() => document.dispatchEvent(new Event("visibilitychange")));
    await browser.pause(500);
    expect(await callsOf("claude_code_start")).toEqual([]);
  });

  it("starts the process once when its empty area is pressed, and puts the focus in the terminal", async () => {
    await openTodo();
    await startByPress();
    await waitForCalls("claude_code_start");
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
    // A press in the terminal afterwards starts nothing more.
    await press($(term));
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
  });

  it("starts Claude Code in the pane's terminal with the tools of tsunagiai-mcp only and a first instruction that holds today's date, and calls no Orca command", async () => {
    await openTodo();
    await startByPress();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "todo-claude", builtinTools: false, skill: null });
    const { prompt, viewport } = start as { prompt: string; viewport: { cols: number; rows: number } };
    // The instruction says that this is a talk about the Todo, gives the date and the tools, and holds nothing of the tasks.
    expect(prompt).toContain("Todoist");
    expect(prompt).toContain(today);
    for (const tool of ["todoist_projects", "todoist_tasks", "todoist_add_task"]) expect(prompt).toContain(tool);
    for (const t of todoData().tasks) expect(prompt).not.toContain(t.content);
    expect(viewport.cols).toBeGreaterThan(20);
    expect(viewport.rows).toBeGreaterThan(5);
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    for (const command of notCalled) expect(await callsOf(command)).toEqual([]);
  });

  it("starts the process once while the list and a task are shown, and keeps it through the page of a draft and another screen", async () => {
    await openTodo();
    await startByPress();
    await waitForCalls("claude_code_start");
    await $("#todo-list li.task").click();
    await expect($("#todo-back")).toBeDisplayed();
    await $("#todo-back").click();
    // The page of a draft has a Claude pane of its own (S-18): this one and its icons go, and the process stays.
    await mock("todoist_summarize_slack", slackSummary);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($(pane)).not.toBeDisplayed();
    await $("#todo-back").click();
    await expect($(pane)).toBeDisplayed();
    await $("#nav-mail").click();
    await expect($(pane)).not.toBeDisplayed();
    await $("#nav-todo").click();
    await expect($(pane)).toBeDisplayed();
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("starts no process while the token form is shown", async () => {
    await boot({ inbox: inbox(), todoist_load: null, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await expect($("#todo-token")).toBeDisplayed();
    await expect($("#todo-tools")).not.toBeDisplayed();
    await expect($("#todo-split")).not.toBeDisplayed();
    await expect($(pane)).not.toBeDisplayed();
    await browser.pause(500);
    expect(await callsOf("claude_code_start")).toEqual([]);
  });

  it("starts the first process with やり直す when none has been started, and closes nothing", async () => {
    await openTodo();
    expect(await callsOf("claude_code_start")).toEqual([]);
    const close = await mock("claude_code_close", null);
    await $("#todo-claude-restart").click();
    await waitForCalls("claude_code_start");
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($("#todo-claude-restart")).toBeEnabled();
    expect(await callsOf(close)).toEqual([]);
  });

  it("ends the process and starts a new one with やり直す", async () => {
    await openTodo();
    await startByPress();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await $("#todo-claude-restart").click();
    expect(await waitForCalls(close)).toEqual([{ id: "todo-claude", launch: 1 }]);
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ id: "todo-claude", builtinTools: false, skill: null, prompt: (starts[0] as { prompt: string }).prompt });
    await expect($("#todo-claude-restart")).toBeEnabled();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  });

  it("starts the process with the ✳ of the right side when it has not been started, and puts the focus in the terminal then and after", async () => {
    await openTodo();
    expect(await callsOf("claude_code_start")).toEqual([]);
    await press($("#todo-tool-claude"));
    await waitForCalls("claude_code_start");
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
    await $("#todo-add-input").click();
    await expect($("#todo-add-input")).toBeFocused();
    await press($("#todo-tool-claude"));
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
    await expect($(pane)).toBeDisplayed();
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
  });

  it("reads the list again when the app tells that the Todo changed, and for no other change", async () => {
    await openTodo();
    await startByPress();
    await waitForCalls("claude_code_start");
    const next = todoData();
    next.tasks.push(task("k9", "Call the bank", "p1", "today"));
    const load = await mock("todoist_load", next);
    await emitEvent("screen-bridge-changed", "slack");
    await browser.pause(700);
    expect(await callsOf(load)).toEqual([]);
    await emitEvent("screen-bridge-changed", "todo");
    await waitForCalls(load);
    await waitForCount("#todo-list li.task", 2);
    // The pane is as it was: the process was not started again, and the list was read, not written.
    await expect($(pane)).toBeDisplayed();
    expect((await callsOf("claude_code_start")).length).toBe(1);
    for (const command of notCalled) expect(await callsOf(command)).toEqual([]);
  });

  it("starts the right side at 30% of the screen, its least", async () => {
    await openTodo();
    await expect($("#todo-split")).toHaveAttribute("aria-valuenow", "30");
    const ratio = await browser.execute(() => document.querySelector("#todo-side")!.getBoundingClientRect().width / document.querySelector("#todo")!.getBoundingClientRect().width);
    expect(ratio).toBeGreaterThan(0.29);
    expect(ratio).toBeLessThan(0.31);
  });

  it("keeps the right side between 30% and 45% of the screen with the arrow keys", async () => {
    await openTodo();
    const split = $("#todo-split");
    await expect(split).toHaveAttribute("aria-valuemin", "30");
    await expect(split).toHaveAttribute("aria-valuemax", "45");
    const share = () => browser.execute(() => document.querySelector("#todo-side")!.getBoundingClientRect().width / document.querySelector("#todo")!.getBoundingClientRect().width);
    const key = (k: string) => browser.execute((name) => document.getElementById("todo-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })), k);
    for (let i = 0; i < 10; i++) await key("ArrowLeft");
    await expect(split).toHaveAttribute("aria-valuenow", "45");
    expect(await share()).toBeCloseTo(0.45, 2);
    for (let i = 0; i < 20; i++) await key("ArrowRight");
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    expect(await share()).toBeCloseTo(0.3, 2);
  });

  it("is the only pane of the right side: the pane of Orca is under the detail, and opening it changes nothing on the right", async () => {
    await openTodo();
    await startByPress();
    await waitForCalls("claude_code_start");
    // The button of Orca is for a task's detail, in the header of the tasks.
    await expect($("#todo-orca-open")).not.toBeDisplayed();
    await $("#todo-list li.task").click();
    await expect($("#todo-orca-open")).toBeDisplayed();
    await expect($(pane)).toBeDisplayed();
    await $("#todo-orca-open").click();
    await expect($("#todo-handoff")).toBeDisplayed();
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-split")).toBeDisplayed();
    await expect($("#todo-split")).toHaveAttribute("aria-label", "Claude の幅");
    // The ✳ only puts the focus in the terminal: the Orca pane stays open.
    await press($("#todo-tool-claude"));
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
    await expect($("#todo-handoff")).toBeDisplayed();
    // Leaving the task takes the pane under it away, and Claude's stays.
    await $("#todo-back").click();
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-handoff")).not.toBeDisplayed();
    await expect($("#todo-orca-open")).not.toBeDisplayed();
    expect((await callsOf("claude_code_start")).length).toBe(1);
  });

  it("is hidden under the page of a draft and comes back with the right side", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", slackSummary);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#todo-split")).not.toBeDisplayed();
    await expect($("#todo-tools")).not.toBeDisplayed();
    await $("#todo-back").click();
    await expect($("#todo-tools")).toBeDisplayed();
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-split")).toBeDisplayed();
  });
});
