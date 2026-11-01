import {
  boot, callsOf, claudeMissing, claudeReady, count, inbox, mock, rejects, slackLoad, slackMessageUrl, slackSummary, textsOf, today, todoData, waitForCalls, waitForCount, waitForText,
} from "../support";

// The app with Todoist connected and the Todo screen open.
async function openTodo(claude: unknown = claudeReady) {
  await boot({ inbox: inbox(), todoist_load: todoData(), slack_load: slackLoad, claude_status: claude });
  await $("#nav-todo").click();
  await waitForCount("#todo-list li.task", 1);
}

describe("todo", () => {
  it("lists the projects and today's tasks, and a project's tasks when it is picked", async () => {
    await openTodo();
    await expect($("#todo-title")).toHaveText("今日");
    await waitForText("#projects .proj .name", "Work");
    await expect($("#projects")).toHaveText(expect.stringContaining("受信箱"));
    await expect($("#todo-list")).toHaveText(expect.stringContaining("Write report"));
    await expect($("#todo-list")).not.toHaveText(expect.stringContaining("Plan trip"));
    await $('#projects .proj[data-view="p1"]').click();
    await expect($("#todo-title")).toHaveText("Work");
    await waitForCount("#todo-list li.task", 2);
    await expect($("#todo-list")).toHaveText(expect.stringContaining("Plan trip"));
  });

  it("adds the typed text through todoist_add", async () => {
    await openTodo();
    const add = await mock("todoist_add", true);
    await $("#todo-add-input").setValue("Buy milk");
    await $("#todo-add-button").click();
    await waitForCalls(add);
    expect(await callsOf(add)).toContainEqual({ text: "Buy milk", projectId: null, today: true });
  });

  // The Todo screen with a Slack link pasted: the summary is mocked, and its card is up.
  async function openSummaryCard() {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", slackSummary);
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await waitForCalls(summarize);
    await $(".review").waitForExist();
    return { summarize, addFromSlack };
  }

  it("turns the button into 要約する for a Slack link and shows the summary on a card to confirm", async () => {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", slackSummary);
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await expect($("#todo-add-button")).toHaveText("要約する");
    await expect($("#todo-add-hint")).toHaveText(expect.stringContaining("Example Team"));
    await expect($("#todo-add-hint")).toHaveText(expect.stringContaining("内容を確かめてから「今日」に追加します"));
    await $("#todo-add-button").click();
    expect(await waitForCalls(summarize)).toEqual([{ url: slackMessageUrl }]);
    await $(".review").waitForExist();
    await expect($("#todo-add-input")).toHaveValue("");
    await expect($(".review .review-name")).toHaveValue("Reply to the vendor");
    await expect($(".review .review-desc")).toHaveValue(slackSummary.description);
    await expect($(".review .review-due")).toHaveValue("2026-11-06");
    await expect($(".review .review-project")).toHaveText("受信箱");
    await expect($(".review .review-src")).toHaveText(expect.stringContaining("Example Team"));
    // Nothing is created until the user confirms.
    expect(await callsOf(addFromSlack)).toEqual([]);
  });

  it("adds the summary as it is, to the inbox and due today unless it has a date, when 追加 is pressed", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $(".review .review-add").click();
    expect(await waitForCalls(addFromSlack)).toEqual([
      { url: slackMessageUrl, content: "Reply to the vendor", description: slackSummary.description, due: "2026-11-06", projectId: null, today: true },
    ]);
    await $(".review").waitForExist({ reverse: true });
    await expect($(".toast")).toHaveText(expect.stringContaining("Reply to the vendor"));
  });

  it("sends the name, description, due date and project the user edited", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $(".review .review-name").setValue("Answer the vendor by Friday");
    await $(".review .review-desc").setValue("- Quote needed");
    await $(".review .review-due").setValue("tomorrow");
    await $(".review .review-project").click();
    await $('.menu button[role="menuitem"]:nth-child(2)').click();
    await expect($(".review .review-project")).toHaveText("Work");
    await $(".review .review-add").click();
    expect(await waitForCalls(addFromSlack)).toEqual([
      { url: slackMessageUrl, content: "Answer the vendor by Friday", description: "- Quote needed", due: "tomorrow", projectId: "p1", today: true },
    ]);
  });

  it("adds with Enter in the name field", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $(".review .review-name").click();
    await browser.keys("Enter");
    await waitForCalls(addFromSlack);
  });

  it("adds nothing and focuses the name when it is empty", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $(".review .review-name").setValue("");
    await $(".review .review-add").click();
    await expect($(".review .review-name")).toBeFocused();
    expect(await callsOf(addFromSlack)).toEqual([]);
  });

  it("closes the card with 破棄 and creates nothing", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $(".review .review-drop").click();
    await $(".review").waitForExist({ reverse: true });
    expect(await callsOf(addFromSlack)).toEqual([]);
  });

  it("keeps what the user typed on the card, with the error, when the add fails", async () => {
    const { addFromSlack } = await openSummaryCard();
    await mock("todoist_add_from_slack", rejects("Todoist に接続できません"));
    await $(".review .review-name").setValue("My own name");
    await $(".review .review-add").click();
    await expect($(".review .review-err")).toHaveText(expect.stringContaining("Todoist に接続できません"));
    await expect($(".review .review-name")).toHaveValue("My own name");
    await expect($(".review .review-desc")).toHaveValue(slackSummary.description);
    await expect($(".review .review-add")).toBeEnabled();
    expect(await callsOf(addFromSlack)).toHaveLength(1);
  });

  it("shows a failed summary as a closable warning row", async () => {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", rejects("Claude が時間内に終わりませんでした"));
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await waitForCalls(summarize);
    await expect($(".pending.fail")).toHaveText(expect.stringContaining("Claude が時間内に終わりませんでした"));
    await $(".pending.fail .icon-btn").click();
    await $(".pending").waitForExist({ reverse: true });
  });

  it("keeps the button as 追加 and hints at the Claude login while Claude is missing", async () => {
    await openTodo(claudeMissing);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await expect($("#todo-add-hint")).toHaveText("Claude にログインすると、要約して追加できます");
    await expect($("#todo-add-button")).toHaveText("追加");
  });
});

// The task rows of the list, and the row of the task named `name`.
const ROWS = "#todo-list li.task";
const rowOf = (name: string) => $(`//div[@id="todo-list"]//li[contains(., "${name}")]`);
// The toggle of project `id` in the side list.
const toggleOf = (id: string) => $(`#projects .proj-line:has(.proj[data-view="${id}"]) .toggle`);
describe("todo projects and subtasks", () => {
  it("nests the projects by their parents and closes the children of one", async () => {
    await openTodo();
    await waitForText("#projects .proj .name", "Sketch");
    expect(await textsOf("#projects .proj .name")).toEqual(["今日", "受信箱", "Work", "Design", "Sketch", "Home"]);
    // A child is indented further right than its parent.
    const [work, design, sketch, home] = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#projects .proj-line")].map((l) => parseInt(l.style.paddingLeft || "0", 10)));
    expect(design).toBeGreaterThan(work);
    expect(sketch).toBeGreaterThan(design);
    expect(home).toBe(work);
    // Only the projects with children have a toggle.
    expect(await count("#projects .toggle")).toBe(2);
    await toggleOf("p1").click();
    await waitForCount('#projects .proj[data-view="p2"]', 0);
    await expect($('#projects .proj[data-view="p3"]')).not.toExist();
    await expect(toggleOf("p1")).toHaveAttribute("aria-expanded", "false");
    await toggleOf("p1").click();
    await waitForCount("#projects .proj-line", 4);
    // Closing Design hides Sketch only.
    await toggleOf("p2").click();
    await waitForCount('#projects .proj[data-view="p3"]', 0);
    await expect($('#projects .proj[data-view="p2"]')).toExist();
  });

  it("shows the subtasks of a task, closed at first, under it and keeps them open over a reload", async () => {
    await openTodo();
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount(ROWS, 2);
    // Only the tasks that have subtasks have a toggle, and it starts closed.
    expect(await count(`${ROWS} > .toggle`)).toBe(1);
    await expect(rowOf("Plan trip").$(".toggle")).toHaveAttribute("aria-expanded", "false");
    await rowOf("Plan trip").$(".toggle").click();
    await waitForCount(ROWS, 3);
    expect(await textsOf(ROWS)).toEqual([expect.stringContaining("Write report"), expect.stringContaining("Plan trip"), expect.stringContaining("Book flights")]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#todo-list li.task")].map((l) => l.style.marginLeft))).toEqual(["0px", "0px", "28px"]);
    // The grandchild comes with the child's toggle.
    await rowOf("Book flights").$(".toggle").click();
    await waitForCount(ROWS, 4);
    await expect(rowOf("Pick seat")).toExist();
    expect(await browser.execute(() => (document.querySelectorAll<HTMLElement>("#todo-list li.task")[3] as HTMLElement).style.marginLeft)).toBe("56px");
    // A load that brings a new task redraws the list, and the open rows stay open.
    const fresh = todoData();
    fresh.tasks.push({ ...fresh.tasks[0], id: "k5", content: "Fresh", due: null, bucket: "none" });
    await mock("todoist_load", fresh);
    await $("#todo-reload").click();
    await waitForCount(ROWS, 5);
    await expect(rowOf("Pick seat")).toExist();
    await rowOf("Plan trip").$(".toggle").click();
    await waitForCount(ROWS, 3);
  });

  it("keeps the subtasks closed when the toggle is pressed again while they are closing", async () => {
    await openTodo();
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount(ROWS, 2);
    await rowOf("Plan trip").$(".toggle").click();
    await waitForCount(ROWS, 3);
    // Two presses in one turn: the second lands while the rows are still sliding shut.
    await browser.execute(() => {
      const t = [...document.querySelectorAll<HTMLElement>("#todo-list li.task")].find((l) => l.textContent?.includes("Plan trip"))!.querySelector<HTMLElement>(".toggle")!;
      t.click();
      t.click();
    });
    await waitForCount(ROWS, 2);
    await expect(rowOf("Plan trip").$(".toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(rowOf("Book flights")).not.toExist();
  });

  it("opens a subtask row as its own task and completes it from its checkbox", async () => {
    await openTodo();
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount(ROWS, 2);
    await rowOf("Plan trip").$(".toggle").click();
    await waitForCount(ROWS, 3);
    const done = await mock("todoist_set_done", true);
    // What Todoist answers after it: the subtask is done, and its subtask went with it.
    const after = todoData();
    after.tasks = after.tasks.slice(0, 2);
    Object.assign(after.tasks[1], { subDone: 1 });
    after.tasks[1].subtasks[0].done = true;
    await mock("todoist_load", after);
    await rowOf("Book flights").$(".check").click();
    expect(await waitForCalls(done)).toEqual([{ id: "k3", done: true }]);
    // The subtask leaves the list with the rows below it, and the count follows.
    await waitForCount(ROWS, 2);
    await expect(rowOf("Plan trip")).toHaveText(expect.stringContaining("1/1"));
    await expect(rowOf("Plan trip").$(".toggle")).not.toExist();
  });

  it("opens the detail of a subtask row, not of the task that holds it", async () => {
    await openTodo();
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount(ROWS, 2);
    await rowOf("Plan trip").$(".toggle").click();
    await rowOf("Book flights").click();
    await expect($("#todo-detail .name")).toHaveValue("Book flights");
  });
});

describe("todo detail", () => {
  it("has the project and the date in a side pane, and no priority", async () => {
    await openTodo();
    await $(ROWS).click();
    await expect($("#todo-detail .detail-side")).toBeDisplayed();
    expect(await textsOf("#todo-detail .detail-side .field-label")).toEqual(["プロジェクト", "日付"]);
    expect(await textsOf("#todo-detail .detail-side .field-value")).toEqual(["Work", "今日"]);
    await expect($("#todo-detail .chip")).not.toExist();
    await expect($("#todo-detail")).not.toHaveText(expect.stringContaining("優先度"));
  });

  it("moves the open task to another project from the side pane, the menu showing the nesting", async () => {
    await openTodo();
    const move = await mock("todoist_move", true);
    // What Todoist answers after the move, so the reload that follows keeps it.
    const moved = todoData();
    moved.tasks[0].projectId = "p2";
    await mock("todoist_load", moved);
    await $(ROWS).click();
    await $("#todo-detail .field-value").click();
    expect(await textsOf(".menu button")).toEqual(["受信箱", "Work", "Design", "Sketch", "Home"]);
    const [, work, design, sketch, home] = await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".menu button")].map((b) => parseInt(b.style.paddingLeft || "0", 10)));
    expect(design).toBeGreaterThan(work);
    expect(sketch).toBeGreaterThan(design);
    expect(home).toBeLessThan(design);
    await $('.menu button[role="menuitem"]:nth-child(3)').click();
    expect(await waitForCalls(move)).toEqual([{ id: "k1", projectId: "p2" }]);
    await expect($("#todo-detail .field-value")).toHaveText("Design");
    await expect($("#todo-title")).toHaveText("Design");
  });

  it("changes the due date from the side pane", async () => {
    await openTodo();
    const update = await mock("todoist_update", true);
    await $(ROWS).click();
    await $("#todo-detail .field:nth-child(2) .field-value").click();
    await $(".due-pop .chip-input").setValue("明日");
    await browser.keys("Enter");
    expect(await waitForCalls(update)).toEqual([{ id: "k1", dueString: "明日" }]);
  });

  it("shows a one-off due date in the due field as a date and time, and a repeat as Todoist's text", async () => {
    const data = todoData();
    data.tasks[0].due = { date: today, time: "12:00", string: "today 12:00", recurring: false };
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await $("#todo-detail .field:nth-child(2) .field-value").click();
    await expect($(".due-pop .chip-input")).toHaveValue(`${today} 12:00`);
    data.tasks[0].due = { date: today, time: null, string: "every day", recurring: true };
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await $("#todo-detail .field:nth-child(2) .field-value").click();
    await expect($(".due-pop .chip-input")).toHaveValue("every day");
  });
});
