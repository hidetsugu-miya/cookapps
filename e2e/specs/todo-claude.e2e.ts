import { boot, callsOf, claudeReady, count, emitEvent, inbox, mock, slackLoad, slackMessageUrl, slackSummary, task, today, todoData, waitForCalls, waitForCount, openTodo } from "../support";

// The Claude pane of the Todo screen (T-7): the terminal of Claude Code (A-36) in the right side.
const pane = "#todo-claude";
const term = "#todo-claude-term";
// A press with the pointer actions. The driver's element click calls `el.click()` and then `el.focus()` on the element itself, which would take the focus back from the field that the press gave it.
const press = (target: ChainablePromiseElement) => browser.action("pointer").move({ origin: target }).down().up().perform();
// The pane is closed at first and shows the question; 相談する opens it and starts the process.
const startByPress = () => press($("#todo-claude-open"));
// The ids of the panes that `command` (claude_code_start or claude_code_close) was called for, in order: the page of a draft has its own pane (S-18).
const ids = async (command: string) => ((await callsOf(command)) as { id: string }[]).map((c) => c.id);
// The commands of the old conversation, which the pane calls no more, and the commands that make a Todoist task: the pane starts a terminal and calls none of them.
const notCalled = ["claude_chat_todo", "todoist_add", "todoist_add_task", "todoist_add_subtask", "todoist_update", "todoist_set_done", "todoist_add_from_slack", "todoist_delete", "todoist_move", "orca_stream_terminal", "orca_terminal_read"];

// The window's width. The E2E window is 1200px wide, where the side is under the tasks (T-7, "Under the tasks"); the specs of the right side run in a wide one.
const NARROW = 1200;
const WIDE = 1600;
let height = 0;
const resize = async (width: number) => {
  await browser.setWindowSize(width, height);
  await browser.waitUntil(async () => (await browser.execute(() => innerWidth)) === width, { timeoutMsg: `the window did not get ${width}px` });
};
// Where the side is: the tasks' column and the side as the screen lays them out.
const places = () =>
  browser.execute(() => {
    const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const [todo, projects, body, split, side] = ["#todo", "#projects", "#todo-body", "#todo-split", "#todo-side"].map(rect);
    return {
      below: document.getElementById("todo")!.classList.contains("below"),
      // The side is under the tasks' column, as wide as it, and the divider is between them.
      under: Math.abs(body.bottom - split.top) <= 1 && Math.abs(split.bottom - side.top) <= 1 && Math.abs(side.left - body.left) <= 1 && Math.abs(side.width - body.width) <= 1,
      // The side is on the right of the tasks' column, with the divider between them.
      beside: Math.abs(body.right - split.left) <= 1 && Math.abs(split.right - side.left) <= 1 && Math.abs(side.top - body.top) <= 1,
      list: Math.abs(projects.right - body.left) <= 1 && Math.abs(projects.height - todo.height) <= 1,
      widthShare: side.width / todo.width,
      heightShare: side.height / todo.height,
      splitHeight: split.height,
      toolsShown: getComputedStyle(document.getElementById("todo-tools")!).display !== "none",
      starInTools: document.querySelector("#todo-tools > #todo-tool-claude") !== null,
      starInHeader: document.querySelector("#todo-body > header > #todo-tool-claude") !== null,
    };
  });
// A key sent to the divider, as the other specs of the dividers do.
const key = (k: string, times = 1) =>
  browser.execute(
    (name, n) => {
      for (let i = 0; i < n; i++) document.getElementById("todo-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    },
    k,
    times,
  );

describe("todo Claude pane", () => {
  before(async () => {
    height = (await browser.getWindowSize()).height;
  });
  // Each spec starts in the wide window, where the side is on the right; the specs of the narrow one narrow it themselves.
  beforeEach(() => resize(WIDE));
  after(() => resize(NARROW));

  it("is closed at first with the question and 相談する, in a right side with the ✳ alone in its first row, and its head, once open, has the mark, Claude and やり直す only", async () => {
    await openTodo();
    await expect($(pane)).toBeDisplayed();
    // Closed: the question and the button, and nothing of the open pane.
    await expect($("#todo-claude-ask p")).toHaveText("Claude に相談しますか？");
    await expect($("#todo-claude-open")).toHaveText("相談する");
    await expect($("#todo-claude-open")).toHaveElementClass("text-btn");
    await expect($(`${pane} .chat-head`)).not.toBeDisplayed();
    await expect($("#todo-claude-restart")).not.toBeDisplayed();
    await expect($(term)).not.toBeDisplayed();
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "false");
    await expect($("#todo-split")).toBeDisplayed();
    await expect($("#todo-split")).toHaveAttribute("aria-label", "Claude の幅");
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-label", "Claude に相談");
    expect(await count("#todo-tool-orca, #todo-tools #todo-orca-open")).toBe(0);
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
    // Open: the heading and the terminal, and the ✳ pressed.
    await press($("#todo-tool-claude"));
    await waitForCalls("claude_code_start");
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($("#todo-claude-ask")).not.toBeDisplayed();
    await expect($(`${pane} .chat-head`)).toHaveText(expect.stringContaining("Claude"));
    expect(await count(`${pane} .chat-head > svg`)).toBe(1);
    await expect($("#todo-claude-restart")).toHaveText("やり直す");
    await expect($("#todo-claude-restart")).toBeEnabled();
    // The second row is the heading of the pane, 48px high, with やり直す at its right end.
    const heading = await browser.execute(() => {
      const head = document.querySelector("#todo-claude .chat-head")!.getBoundingClientRect();
      const button = document.querySelector("#todo-claude-restart")!.getBoundingClientRect();
      return { height: head.height, right: head.right - button.right < 24 };
    });
    expect(heading).toEqual({ height: 48, right: true });
  });

  it("starts no process when the screen is shown, hidden and shown again, or the window changes its visibility, and the question is in the middle of the pane", async () => {
    await openTodo();
    await expect($(pane)).toBeDisplayed();
    const middle = await browser.execute(() => {
      const box = document.querySelector("#todo-claude")!.getBoundingClientRect();
      const ask = document.querySelector("#todo-claude-ask")!.getBoundingClientRect();
      const button = document.querySelector("#todo-claude-open")!.getBoundingClientRect();
      return { height: ask.height > 100, centered: Math.abs(button.left + button.width / 2 - (box.left + box.width / 2)) < 2 };
    });
    expect(middle).toEqual({ height: true, centered: true });
    expect(await count(`${term} *`)).toBe(0);
    await $("#nav-mail").click();
    await expect($(pane)).not.toBeDisplayed();
    await $("#nav-todo").click();
    await expect($(pane)).toBeDisplayed();
    await browser.execute(() => document.dispatchEvent(new Event("visibilitychange")));
    await browser.pause(500);
    expect(await callsOf("claude_code_start")).toEqual([]);
  });

  it("starts the process once when 相談する is pressed, opens the pane and puts the focus in the terminal", async () => {
    await openTodo();
    await startByPress();
    await waitForCalls("claude_code_start");
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($("#todo-claude-ask")).not.toBeDisplayed();
    // A press in the terminal afterwards starts nothing more.
    await press($(term));
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
  });

  it("starts Claude Code in the pane's terminal with the tools of tsunagiai-mcp only and a first instruction that holds today's date, and calls no Orca command", async () => {
    await openTodo();
    await startByPress();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "todo-claude", builtinTools: false, permissionMode: "manual", skill: null });
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
    // The page of a draft has a Claude pane of its own (S-18, its own process `todo-draft`, which starts only when 相談する of that pane is pressed): this one and its icons go, and this process stays.
    await mock("todoist_summarize_slack", slackSummary);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($(pane)).not.toBeDisplayed();
    await $("#draft-consult").waitForDisplayed();
    await $("#draft-consult").click();
    await browser.waitUntil(async () => (await ids("claude_code_start")).includes("todo-draft"));
    await $("#todo-back").click();
    await expect($(pane)).toBeDisplayed();
    await $("#nav-mail").click();
    await expect($(pane)).not.toBeDisplayed();
    await $("#nav-todo").click();
    await expect($(pane)).toBeDisplayed();
    await browser.pause(500);
    // Only the draft's process was ended, with its page; this one was started once and never ended.
    expect(await ids("claude_code_start")).toEqual(["todo-claude", "todo-draft"]);
    expect(await ids("claude_code_close")).toEqual(["todo-draft"]);
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

  it("opens the pane with the ✳ and starts the process, and closes it with the ✳ and ends the process, and the next open starts a new one", async () => {
    await openTodo();
    expect(await callsOf("claude_code_start")).toEqual([]);
    const close = await mock("claude_code_close", null);
    await press($("#todo-tool-claude"));
    await waitForCalls("claude_code_start");
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
    await expect($("#todo-claude-restart")).toBeEnabled();
    expect(await callsOf(close)).toEqual([]);
    // Pressed again, the pane goes back to the question and the process ends.
    await press($("#todo-tool-claude"));
    expect(await waitForCalls(close)).toEqual([{ id: "todo-claude", launch: 1 }]);
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "false");
    await expect($("#todo-claude-ask p")).toHaveText("Claude に相談しますか？");
    await expect($(term)).not.toBeDisplayed();
    await expect($(`${pane} .chat-head`)).not.toBeDisplayed();
    await expect($(pane)).toBeDisplayed();
    // A window that changes its visibility starts nothing while the pane is closed.
    await browser.execute(() => document.dispatchEvent(new Event("visibilitychange")));
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    // Opened again with 相談する: a new process, with the same first instruction.
    await startByPress();
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts[1]).toMatchObject({ id: "todo-claude", builtinTools: false, skill: null, prompt: (starts[0] as { prompt: string }).prompt });
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
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
    // The ✳ closes Claude's pane and changes nothing of the Orca pane.
    const close = await mock("claude_code_close", null);
    await press($("#todo-tool-claude"));
    await waitForCalls(close);
    await expect($("#todo-claude-ask")).toBeDisplayed();
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

  it("puts the side under the tasks in a narrow window: the divider lying down at 30% of the height, no row of its own, and the ✳ in the header of the tasks after 編集", async () => {
    await resize(NARROW);
    await openTodo();
    const at = await places();
    expect(at).toMatchObject({ below: true, under: true, list: true, toolsShown: false, starInTools: false, starInHeader: true });
    // The divider is 7px high and lies down; the side has 30% of the height, the least (the divider is not in it).
    expect(at.splitHeight).toBe(7);
    expect(at.heightShare).toBeGreaterThan(0.27);
    expect(at.heightShare).toBeLessThan(0.31);
    const split = $("#todo-split");
    await expect(split).toBeDisplayed();
    await expect(split).toHaveAttribute("aria-orientation", "horizontal");
    await expect(split).toHaveAttribute("aria-label", "Claude の高さ");
    await expect(split).toHaveAttribute("aria-valuemin", "30");
    await expect(split).toHaveAttribute("aria-valuemax", "45");
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    // The pane is shown whole, with its question: always shown, with no way to close it added.
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-claude-ask p")).toHaveText("Claude に相談しますか？");
    await expect($("#todo-tools")).not.toBeDisplayed();
    await expect($("#todo-tool-claude")).toBeDisplayed();
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "false");
    expect(await count("#todo-claude-close")).toBe(0);
    // The ✳ is at the right end of the header of the tasks, as high as the other buttons of it, and after 編集 once a task is open.
    await $("#todo-list li.task").click();
    await expect($("#todo-more")).toBeDisplayed();
    const header = await browser.execute(() => {
      const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const star = rect("#todo-tool-claude");
      return { afterEdit: star.left >= rect("#todo-more").right, right: rect("#todo-body > header").right - star.right < 40, size: [star.width, star.height] };
    });
    expect(header).toEqual({ afterEdit: true, right: true, size: [28, 28] });
    expect(await callsOf("claude_code_start")).toEqual([]);
  });

  it("opens and closes the pane under the tasks with the ✳ of the header, and keeps the process when the window is widened and narrowed", async () => {
    await resize(NARROW);
    await openTodo();
    const close = await mock("claude_code_close", null);
    await press($("#todo-tool-claude"));
    await waitForCalls("claude_code_start");
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($(`${pane} .chat-head`)).toBeDisplayed();
    await expect($(term)).toBeDisplayed();
    // Widened: the side is on the right, the ✳ is in its row again, still pressed, and nothing started or ended.
    await resize(WIDE);
    await expect($("#todo-tools")).toBeDisplayed();
    expect(await places()).toMatchObject({ below: false, beside: true, toolsShown: true, starInTools: true, starInHeader: false });
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($(term)).toBeDisplayed();
    await resize(NARROW);
    await expect($("#todo-tools")).not.toBeDisplayed();
    expect(await places()).toMatchObject({ below: true, under: true, starInHeader: true });
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    expect(await callsOf(close)).toEqual([]);
    // Pressed in the header, the pane closes and the process ends.
    await press($("#todo-tool-claude"));
    expect(await waitForCalls(close)).toEqual([{ id: "todo-claude", launch: 1 }]);
    await expect($("#todo-claude-ask p")).toBeDisplayed();
    await expect($("#todo-tool-claude")).toHaveAttribute("aria-pressed", "false");
  });

  it("changes the height of the side under the tasks between 30% and 45% with the divider, and keeps it apart from the width of the right side", async () => {
    await resize(NARROW);
    await openTodo();
    const split = $("#todo-split");
    const share = async () => (await places()).heightShare;
    // The arrow keys: Up widens, Down narrows, and Left and Right do nothing while it lies down.
    await key("ArrowLeft", 5);
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    await key("ArrowUp", 10);
    await expect(split).toHaveAttribute("aria-valuenow", "45");
    expect(await share()).toBeGreaterThan(0.42);
    expect(await share()).toBeLessThan(0.46);
    await key("ArrowRight", 5);
    await expect(split).toHaveAttribute("aria-valuenow", "45");
    await key("ArrowDown", 20);
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    expect(await share()).toBeLessThan(0.31);
    // A drag up: the pointer 80px higher than the divider widens the side by about that.
    const before = await browser.execute(() => document.getElementById("todo-side")!.getBoundingClientRect().height);
    await browser.action("pointer").move({ origin: split }).down().move({ origin: split, x: 0, y: -80 }).up().perform();
    await browser.waitUntil(async () => Number(await split.getAttribute("aria-valuenow")) > 30, { timeoutMsg: "the drag did not widen the side" });
    const after = await browser.execute(() => document.getElementById("todo-side")!.getBoundingClientRect().height);
    expect(after - before).toBeGreaterThan(50);
    expect(Number(await split.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(45);
    // The height is kept while the width is not touched: on the right the width is 30% and the divider stands again, and narrowing brings the height back.
    await key("ArrowDown", 20);
    await key("ArrowUp", 5);
    await expect(split).toHaveAttribute("aria-valuenow", "40");
    await resize(WIDE);
    await expect(split).toHaveAttribute("aria-orientation", "vertical");
    await expect(split).toHaveAttribute("aria-label", "Claude の幅");
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    expect((await places()).widthShare).toBeCloseTo(0.3, 2);
    await key("ArrowLeft", 3);
    await expect(split).toHaveAttribute("aria-valuenow", "36");
    await resize(NARROW);
    await expect(split).toHaveAttribute("aria-orientation", "horizontal");
    await expect(split).toHaveAttribute("aria-valuenow", "40");
    expect(await share()).toBeGreaterThan(0.37);
    expect(await share()).toBeLessThan(0.41);
    await resize(WIDE);
    await expect(split).toHaveAttribute("aria-valuenow", "36");
  });

  it("follows the width of the window and the project list: the side goes under the tasks when their column would be under 612px, and back to the right when the list is closed or the window is widened", async () => {
    await resize(NARROW);
    await openTodo();
    expect((await places()).below).toBe(true);
    // The column of the tasks with the side on the right is the width of #todo, less 30% of it, the list (220px) and the divider (7px): 612px is at 1198.6px of #todo.
    const edge = async (todoWidth: number) => {
      const chrome = await browser.execute(() => innerWidth - document.getElementById("todo")!.getBoundingClientRect().width);
      await resize(todoWidth + chrome);
      await browser.waitUntil(async () => Math.abs((await browser.execute(() => document.getElementById("todo")!.getBoundingClientRect().width)) - todoWidth) <= 1, { timeoutMsg: `#todo did not get ${todoWidth}px` });
    };
    await edge(1180);
    await browser.waitUntil(async () => (await places()).below, { timeoutMsg: "the side did not go under the tasks at 1180px" });
    await edge(1220);
    await browser.waitUntil(async () => !(await places()).below, { timeoutMsg: "the side did not go to the right at 1220px" });
    expect(await places()).toMatchObject({ beside: true, list: true, starInTools: true });
    expect((await places()).widthShare).toBeCloseTo(0.3, 2);
    // The list closed in the narrow window gives its 220px to the tasks: the side is on the right; opened again, it goes under.
    await resize(NARROW);
    await expect($("#todo")).toHaveElementClass("below");
    await press($("#projects-toggle"));
    await expect($("#projects")).not.toBeDisplayed();
    await browser.waitUntil(async () => !(await places()).below, { timeoutMsg: "the side did not go to the right with the list closed" });
    expect(await places()).toMatchObject({ beside: true, starInTools: true });
    await press($("#todo-list-toggle"));
    await browser.waitUntil(async () => (await places()).below, { timeoutMsg: "the side did not go under the tasks with the list open" });
    expect(await places()).toMatchObject({ under: true, list: true, starInHeader: true });
  });

  it("hides the ✳ and the side under the page of a draft, in the narrow window too, and the tasks' column has the whole height then", async () => {
    await resize(NARROW);
    await openTodo();
    await expect($("#todo-tool-claude")).toBeDisplayed();
    await mock("todoist_summarize_slack", slackSummary);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#todo-split")).not.toBeDisplayed();
    await expect($("#todo-tool-claude")).not.toBeDisplayed();
    // The tasks' column has the whole height of the screen while the side is hidden.
    const filled = () => browser.execute(() => Math.abs(document.getElementById("todo-body")!.getBoundingClientRect().bottom - document.getElementById("todo")!.getBoundingClientRect().bottom) <= 1);
    expect(await filled()).toBe(true);
    await $("#todo-back").click();
    await expect($("#todo-tool-claude")).toBeDisplayed();
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-split")).toBeDisplayed();
    expect((await places()).under).toBe(true);
    expect(await filled()).toBe(false);
  });
});
