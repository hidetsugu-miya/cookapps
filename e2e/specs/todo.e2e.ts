import {
  boot, callsOf, claudeKeyReady, claudeMissing, claudeReady, comment, copiedTexts, count, holds, inbox, mock, onceId, pickFile, rejects, release, slackLoad, slackMessageUrl, slackSummary, stubClipboard, task, textsOf, today, todoData, waitForCalls, waitForCount, waitForText,
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

  // Types `text` in the card's due popover and confirms it with Enter.
  async function setCardDue(text: string) {
    await $(".review .review-due").click();
    await $(".due-pop .chip-input").setValue(text);
    await browser.keys("Enter");
  }

  // The day button `n` of the month the due popover shows (not a day of the month before or after).
  const dayButton = (n: number) => $(`//div[contains(@class,"due-pop")]//button[contains(@class,"dp-day") and not(contains(@class,"other")) and text()="${n}"]`);

  // The same card with Claude's recommendation: `projectId` is an ID of the Todo fixtures (p1 is Work).
  async function openRecommendedCard(projectId: string) {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", { ...slackSummary, projectId });
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await waitForCalls(summarize);
    await $(".review").waitForExist();
    return { addFromSlack };
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
    await expect($(".review .review-due")).toHaveText("2026-11-06");
    await expect($(".review .review-project")).toHaveText("受信箱");
    await expect($(".review .review-src")).toHaveText(expect.stringContaining("Example Team"));
    // Nothing is created until the user confirms.
    expect(await callsOf(addFromSlack)).toEqual([]);
  });

  it("summarizes a Slack link while an API key is in use", async () => {
    await openTodo(claudeKeyReady);
    const summarize = await mock("todoist_summarize_slack", slackSummary);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await expect($("#todo-add-button")).toHaveText("要約する");
    await $("#todo-add-button").click();
    expect(await waitForCalls(summarize)).toEqual([{ url: slackMessageUrl }]);
    await $(".review").waitForExist();
    await expect($(".review .review-name")).toHaveValue("Reply to the vendor");
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
    await setCardDue("tomorrow");
    await $(".review .review-project").click();
    await $('.menu button[role="menuitem"]:nth-child(2)').click();
    await expect($(".review .review-project")).toHaveText("Work");
    await $(".review .review-add").click();
    expect(await waitForCalls(addFromSlack)).toEqual([
      { url: slackMessageUrl, content: "Answer the vendor by Friday", description: "- Quote needed", due: "tomorrow", projectId: "p1", today: true },
    ]);
  });

  it("opens the calendar from the due chip, and a day picked keeps the time", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", { ...slackSummary, due: "2026-11-06 15:00" });
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $(".review").waitForExist();
    await expect($(".review .review-due")).toHaveText("2026-11-06 15:00");
    await $(".review .review-due").click();
    await expect($(".due-pop .chip-input")).toHaveValue("2026-11-06 15:00");
    await expect($(".due-pop")).toHaveText(expect.stringContaining("2026年11月"));
    await expect($(".due-pop .dp-day.current")).toHaveText("6");
    await dayButton(20).click();
    await expect($(".due-pop")).not.toExist();
    await expect($(".review .review-due")).toHaveText("2026-11-20 15:00");
    // Picking a day saves nothing: the value is only sent with 追加.
    expect(await callsOf(addFromSlack)).toEqual([]);
    await $(".review .review-add").click();
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ due: "2026-11-20 15:00" });
  });

  it("keeps no time when the day is picked for a date without one", async () => {
    await openSummaryCard();
    await $(".review .review-due").click();
    await dayButton(12).click();
    await expect($(".review .review-due")).toHaveText("2026-11-12");
  });

  it("takes other text in the due popover with Enter, and an empty one means no due date (today in 今日)", async () => {
    const { addFromSlack } = await openSummaryCard();
    await setCardDue("明日 15時");
    await expect($(".review .review-due")).toHaveText("明日 15時");
    // The popover shows the text as it is, and a day from the calendar replaces it.
    await $(".review .review-due").click();
    await expect($(".due-pop .chip-input")).toHaveValue("明日 15時");
    await browser.keys("Escape");
    await setCardDue("");
    await expect($(".review .review-due")).toHaveText("空なら今日");
    await $(".review .review-add").click();
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ due: "", today: true });
  });

  it("says 期限なし on the due chip when the card is for a project and the date is empty", async () => {
    await openTodo();
    await $('#projects .proj[data-view="p1"]').click();
    await mock("todoist_summarize_slack", { ...slackSummary, due: null });
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $(".review").waitForExist();
    await expect($(".review .review-due")).toHaveText("期限なし");
  });

  it("tells on the card how many messages of the thread the summary leaves out, and does not send the count on", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", { ...slackSummary, omitted: 12 });
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $(".review").waitForExist();
    await expect($(".review .review-omitted")).toHaveText("12 件のメッセージは要約に含まれていません");
    await $(".review .review-add").click();
    const [sent] = await waitForCalls(addFromSlack);
    expect(sent).not.toHaveProperty("omitted");
  });

  it("shows no note on the card when the summary reflects the whole thread", async () => {
    await openSummaryCard();
    await expect($(".review .review-omitted")).not.toExist();
    await expect($(".review .review-target-cut")).not.toExist();
  });

  it("tells on the card that the linked message was cut, and does not send the flag on", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", { ...slackSummary, targetCut: true });
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $(".review").waitForExist();
    await expect($(".review .review-target-cut")).toHaveText("対象のメッセージは長いため、先頭だけを要約しました");
    await $(".review .review-add").click();
    const [sent] = await waitForCalls(addFromSlack);
    expect(sent).not.toHaveProperty("targetCut");
  });

  it("starts the card in the project Claude recommended, tagged 推奨 on the chip and in the menu", async () => {
    const { addFromSlack } = await openRecommendedCard("p1");
    await expect($(".review .review-project")).toHaveText(expect.stringContaining("Work"));
    await expect($(".review .review-project .tag")).toHaveText("推奨");
    await $(".review .review-project").click();
    await expect($('.menu button[role="menuitem"]:nth-child(2) .tag')).toHaveText("推奨");
    await expect($('.menu button[role="menuitem"]:nth-child(2)')).toHaveAttribute("aria-current", "true");
    expect(await count(".menu .tag")).toBe(1);
    await browser.keys("Escape");
    await $(".review .review-add").click();
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ projectId: "p1" });
  });

  it("takes the tag off the chip when another project is chosen, keeps it on the menu row, and adds to the chosen one", async () => {
    const { addFromSlack } = await openRecommendedCard("p1");
    await $(".review .review-project").click();
    await $('.menu button[role="menuitem"]:nth-child(5)').click();
    await expect($(".review .review-project")).toHaveText("Home");
    await expect($(".review .review-project .tag")).not.toExist();
    await $(".review .review-project").click();
    await expect($('.menu button[role="menuitem"]:nth-child(2) .tag')).toHaveText("推奨");
    await expect($('.menu button[role="menuitem"]:nth-child(5)')).toHaveAttribute("aria-current", "true");
    await browser.keys("Escape");
    await $(".review .review-add").click();
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ projectId: "p4" });
  });

  it("puts the tag back on the chip when the recommended project is chosen again", async () => {
    await openRecommendedCard("p1");
    await $(".review .review-project").click();
    await $('.menu button[role="menuitem"]:nth-child(5)').click();
    await $(".review .review-project").click();
    await $('.menu button[role="menuitem"]:nth-child(2)').click();
    await expect($(".review .review-project .tag")).toHaveText("推奨");
  });

  it("ignores a recommendation that is not a project in the list, and the card starts where it would", async () => {
    await openRecommendedCard("p9");
    await expect($(".review .review-project")).toHaveText("受信箱");
    await expect($(".review .review-project .tag")).not.toExist();
  });

  it("opens the prompt screen from the card, and 戻る returns to the Todo screen with the card still there", async () => {
    await openSummaryCard();
    await $(".review .link-btn").click();
    await expect($("#prompt")).toBeDisplayed();
    await expect($("#todo")).not.toBeDisplayed();
    await expect($("#nav-settings")).toHaveAttribute("aria-current", "page");
    await $("#prompt-back").click();
    await expect($("#todo")).toBeDisplayed();
    await expect($(".review")).toExist();
    await expect($(".review .review-name")).toHaveValue("Reply to the vendor");
    await expect($("#nav-todo")).toHaveAttribute("aria-current", "page");
  });

  it("adds with Enter in the name field", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $(".review .review-name").click();
    await browser.keys("Enter");
    await waitForCalls(addFromSlack);
  });

  // Focus is not checked: WebDriver's click leaves the focus on the clicked button in the hidden E2E window.
  it("adds nothing and keeps the card when the name is empty", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $(".review .review-name").setValue("");
    await $(".review .review-add").click();
    await expect($(".review .review-add")).toBeEnabled();
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
    await expect($(".review .review-add")).toHaveText("追加");
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
    await $("#todo-pending .pending").waitForExist({ reverse: true });
  });

  it("shows a spinner and 追加中 on the add button, with the field and the button disabled, until the add is answered", async () => {
    await openTodo();
    const add = await mock("todoist_add", holds);
    await $("#todo-add-input").setValue("Buy milk");
    await $("#todo-add-button").click();
    await waitForCalls(add);
    await expect($("#todo-add-button")).toHaveText("追加中");
    await expect($("#todo-add-button .spin")).toExist();
    await expect($("#todo-add-button")).toBeDisabled();
    await expect($("#todo-add-input")).toBeDisabled();
    await release(add, true);
    await expect($("#todo-add-button")).toHaveText("追加");
    await expect($("#todo-add-button .spin")).not.toExist();
    await expect($("#todo-add-button")).toBeEnabled();
    await expect($("#todo-add-input")).toBeEnabled();
    await expect($("#todo-add-input")).toHaveValue("");
  });

  it("puts the add button back to 追加 and keeps the text when the add fails", async () => {
    await openTodo();
    const add = await mock("todoist_add", rejects("Todoist に接続できません"));
    await $("#todo-add-input").setValue("Buy milk");
    await $("#todo-add-button").click();
    await waitForCalls(add);
    await expect($("#todo-add-button")).toHaveText("追加");
    await expect($("#todo-add-button .spin")).not.toExist();
    await expect($("#todo-add-button")).toBeEnabled();
    await expect($("#todo-add-input")).toHaveValue("Buy milk");
  });

  it("shows a spinner and 追加中 on the card's 追加 button while the Slack task is being added, and 破棄 stays disabled", async () => {
    const { addFromSlack } = await openSummaryCard();
    await mock("todoist_add_from_slack", holds);
    await $(".review .review-add").click();
    await waitForCalls(addFromSlack);
    await expect($(".review .review-add")).toHaveText("追加中");
    await expect($(".review .review-add .spin")).toExist();
    await expect($(".review .review-add")).toBeDisabled();
    await expect($(".review .review-drop")).toBeDisabled();
    await release(addFromSlack, "Reply to the vendor");
    await $(".review").waitForExist({ reverse: true });
  });

  it("keeps the button as 追加 and hints at the Claude login while Claude is missing", async () => {
    await openTodo(claudeMissing);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await expect($("#todo-add-hint")).toHaveText("設定の Claude タブで接続すると、要約して追加できます");
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
    // The screen has no reload button: leaving it and coming back loads again.
    await $("#nav-mail").click();
    await $("#nav-todo").click();
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
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      const t = [...document.querySelectorAll<HTMLElement>("#todo-list li.task")].find((l) => l.textContent?.includes("Plan trip"))!.querySelector<HTMLElement>(".toggle")!;
      t.click();
      t.click();
    }, onceId());
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

// The E2E driver never hovers, so a row's grip stays hidden (visibility) and takes no pointer event: show the grips for the drag.
// The window is not painted either, so a row that a toggle opened stays shrunk to no height by its slide: end the slides, or its grip cannot be pressed.
const showGrips = () =>
  browser.execute(() => {
    for (const a of document.getAnimations()) a.finish();
    for (const g of document.querySelectorAll<HTMLElement>("#todo-list .grip")) g.style.visibility = "visible";
  });

// Drags the grip of the row `name` with the pointer (press, move over each of `over`, release).
async function dragRow(name: string, ...over: ChainablePromiseElement[]) {
  const drag = async () => {
    await showGrips();
    let action = browser.action("pointer").move({ origin: rowOf(name).$(".grip") }).down();
    for (const target of over) action = action.move({ origin: target });
    await action.up().perform();
  };
  try {
    await drag();
  } catch (error) {
    // The timed refresh can redraw the list after the row was found, and a loaded machine widens that gap: start again on the new row.
    if (!String(error).includes("no longer attached")) throw error;
    // The failed press may still have the app's listeners on the document, and the driver's release sends no pointerup after a failure (its pointer is always 1).
    await browser.execute(() => document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })));
    await drag();
  }
}

// Records every row and project that gets the drop mark from now on (a task's ID or a project's view), since the mark is gone when the drag ends.
const watchDrops = () =>
  browser.execute((id) => {
    if (!window.__e2e_once__(id)) return;
    const w = window as unknown as { __drops__: string[] };
    w.__drops__ = [];
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (el.classList.contains("drop")) w.__drops__.push(el.dataset.id ?? el.dataset.view ?? "");
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
  }, onceId());
const dropsSeen = () => browser.execute(() => (window as unknown as { __drops__: string[] }).__drops__);
const marginsOf = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#todo-list li.task")].map((l) => l.style.marginLeft));
const projectOf = (id: string) => $(`#projects .proj[data-view="${id}"]`);

// What Todoist answers once "Write report" (k1) is the last subtask of "Plan trip" (k2).
function reportUnderTrip(data = todoData()) {
  const [report, trip] = data.tasks;
  report.parent = { id: trip.id, content: trip.content };
  trip.subtasks.push({ id: report.id, content: report.content, done: false, due: report.due });
  trip.subTotal++;
  return data;
}

// What Todoist answers once "Book flights" (k3) has left "Plan trip" (k2) and is a top-level task.
function flightsAlone() {
  const data = todoData();
  const [, trip, flights] = data.tasks;
  flights.parent = null;
  trip.subtasks = [];
  trip.subTotal = 0;
  return data;
}

describe("todo: moving a task by its grip", () => {
  // The Work project: "Write report" and "Plan trip" (closed).
  async function openWork() {
    await openTodo();
    await projectOf("p1").click();
    await waitForCount(ROWS, 2);
  }

  it("makes the task a subtask of the row it is dropped on, marking that row on the way, and shows it under that task", async () => {
    await openWork();
    const moveUnder = await mock("todoist_move_under", true);
    await mock("todoist_load", reportUnderTrip());
    await watchDrops();
    await dragRow("Write report", rowOf("Plan trip"));
    expect(await waitForCalls(moveUnder)).toEqual([{ id: "k1", parentId: "k2" }]);
    expect(await dropsSeen()).toEqual(["k2"]);
    // "Plan trip" opens to show it, last among its subtasks, and the count follows.
    await waitForCount(ROWS, 3);
    expect(await textsOf(ROWS)).toEqual([expect.stringContaining("Plan trip"), expect.stringContaining("Book flights"), expect.stringContaining("Write report")]);
    expect(await marginsOf()).toEqual(["0px", "28px", "28px"]);
    await expect(rowOf("Plan trip")).toHaveText(expect.stringContaining("0/2"));
    await expect(rowOf("Plan trip").$(".toggle")).toHaveAttribute("aria-expanded", "true");
    await expect($(".dragging, .drop")).not.toExist();
  });

  it("does the same in the 今日 list, where the subtask names its parent", async () => {
    const data = todoData();
    data.tasks[1].due = data.tasks[0].due;
    data.tasks[1].bucket = "today";
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await waitForCount(ROWS, 2);
    const moveUnder = await mock("todoist_move_under", true);
    await mock("todoist_load", reportUnderTrip(data));
    await dragRow("Write report", rowOf("Plan trip"));
    expect(await waitForCalls(moveUnder)).toEqual([{ id: "k1", parentId: "k2" }]);
    await expect(rowOf("Write report").$(".parent")).toHaveText("Plan trip");
  });

  it("does not mark or accept the task itself, a task below it or its parent", async () => {
    await openWork();
    await rowOf("Plan trip").$(".toggle").click();
    await waitForCount(ROWS, 3);
    await rowOf("Book flights").$(".toggle").click();
    await waitForCount(ROWS, 4);
    const moveUnder = await mock("todoist_move_under", true);
    await watchDrops();
    // "Plan trip" over its subtask, that one's subtask and itself.
    await dragRow("Plan trip", rowOf("Book flights"), rowOf("Pick seat"), rowOf("Plan trip"));
    // "Book flights" over its parent and its own subtask.
    await dragRow("Book flights", rowOf("Plan trip"), rowOf("Pick seat"));
    expect(await dropsSeen()).toEqual([]);
    expect(await callsOf(moveUnder)).toEqual([]);
    await expect($(".dragging, .drop")).not.toExist();
  });

  it("takes a subtask out of its parent with 親タスクから外す, which moves it to its own project, and shows it at the top level", async () => {
    await openWork();
    await rowOf("Plan trip").$(".toggle").click();
    await waitForCount(ROWS, 3);
    // Only a subtask's row has the button.
    expect(await count(`${ROWS} .unparent-row`)).toBe(1);
    await expect(rowOf("Book flights").$(".unparent-row")).toHaveAttribute("aria-label", "親タスクから外す");
    const move = await mock("todoist_move", true);
    await mock("todoist_load", flightsAlone());
    // The row buttons show on hover, which the driver never does: press it in the page.
    await browser.execute((id) => window.__e2e_once__(id) && document.querySelector<HTMLElement>("#todo-list .unparent-row")!.click(), onceId());
    expect(await waitForCalls(move)).toEqual([{ id: "k3", projectId: "p1" }]);
    expect(await textsOf(ROWS)).toEqual([expect.stringContaining("Write report"), expect.stringContaining("Plan trip"), expect.stringContaining("Book flights")]);
    expect(await marginsOf()).toEqual(["0px", "0px", "0px"]);
    expect(await count(`${ROWS} .unparent-row`)).toBe(0);
    await expect(rowOf("Plan trip").$(".toggle")).not.toExist();
  });

  it("makes a subtask stand alone when it is dropped on the project it is in, but marks that project for no other task", async () => {
    await openWork();
    await rowOf("Plan trip").$(".toggle").click();
    await waitForCount(ROWS, 3);
    const move = await mock("todoist_move", true);
    await mock("todoist_load", flightsAlone());
    await watchDrops();
    await dragRow("Write report", projectOf("p1"));
    expect(await dropsSeen()).toEqual([]);
    expect(await callsOf(move)).toEqual([]);
    await dragRow("Book flights", projectOf("p1"));
    expect(await waitForCalls(move)).toEqual([{ id: "k3", projectId: "p1" }]);
    expect(await dropsSeen()).toEqual(["p1"]);
    expect(await marginsOf()).toEqual(["0px", "0px", "0px"]);
    expect(await count(`${ROWS} .unparent-row`)).toBe(0);
  });

  it("moves a subtask to another project when it is dropped on it, and shows it there as a task of its own", async () => {
    await openWork();
    await rowOf("Plan trip").$(".toggle").click();
    await waitForCount(ROWS, 3);
    const move = await mock("todoist_move", true);
    // What Todoist answers once "Book flights" (k3) and its subtask are in Design (p2), out of "Plan trip".
    const moved = todoData();
    const [, trip, flights, seat] = moved.tasks;
    flights.parent = null;
    flights.projectId = "p2";
    seat.projectId = "p2";
    trip.subtasks = [];
    trip.subTotal = 0;
    await mock("todoist_load", moved);
    await dragRow("Book flights", projectOf("p2"));
    expect(await waitForCalls(move)).toEqual([{ id: "k3", projectId: "p2" }]);
    await waitForCount(ROWS, 2);
    await expect(rowOf("Plan trip").$(".toggle")).not.toExist();
    await projectOf("p2").click();
    await waitForCount(ROWS, 1);
    expect(await textsOf(ROWS)).toEqual([expect.stringContaining("Book flights")]);
    expect(await marginsOf()).toEqual(["0px"]);
    expect(await count(`${ROWS} .unparent-row`)).toBe(0);
  });

  it("puts the row back, closed again, and shows the error when making it a subtask fails", async () => {
    await openWork();
    const moveUnder = await mock("todoist_move_under", rejects("Todoist に接続できません"));
    await dragRow("Write report", rowOf("Plan trip"));
    await waitForCalls(moveUnder);
    // The reload brings back what Todoist has: "Write report" at the top level and "Plan trip" closed.
    await waitForCount(ROWS, 2);
    await expect($("#error")).toHaveText(expect.stringContaining("Todoist に接続できません"));
    expect(await textsOf(ROWS)).toEqual([expect.stringContaining("Write report"), expect.stringContaining("Plan trip")]);
    expect(await marginsOf()).toEqual(["0px", "0px"]);
    await expect(rowOf("Plan trip").$(".toggle")).toHaveAttribute("aria-expanded", "false");
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

  it("shows a due date as a zero-padded month and day, with the year when it is not this year", async () => {
    const year = Number(today.slice(0, 4));
    const monthDay = today.endsWith("-03-05") ? "03月06日" : "03月05日";
    const thisYear = `${year}-${monthDay.slice(0, 2)}-${monthDay.slice(3, 5)}`;
    const data = todoData();
    data.tasks[0].due = { date: thisYear, time: null, string: thisYear, recurring: false };
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await expect($(`${ROWS} .due`)).toHaveText(monthDay);
    data.tasks[0].due = { date: `${year + 1}-04-01`, time: "15:00", string: "next year", recurring: false };
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await expect($(`${ROWS} .due`)).toHaveText(`${year + 1}年04月01日 15:00`);
    await $(ROWS).click();
    await expect($("#todo-detail .field:nth-child(2) .field-value")).toHaveText(expect.stringContaining(`${year + 1}年04月01日 15:00`));
    data.tasks[0].due = { date: today, time: "12:00", string: "today 12:00", recurring: false };
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await expect($(`${ROWS} .due`)).toHaveText("12:00");
  });
});

// The Markdown source of the description the next specs copy.
const description = "**Bold** line\n- item one\n- item two";
// Todo data whose first task, "Write report" (k1), has that description.
function withDescription() {
  const data = todoData();
  data.tasks[0].description = description;
  return data;
}

describe("todo prompt icon", () => {
  const icon = "#todo-prompt";

  it("shows the Claude icon in the heading of a list only, with the tooltip text as its label", async () => {
    await openTodo();
    await expect($(icon)).toBeDisplayed();
    await expect($(icon)).toHaveAttribute("aria-label", "Todo の要約プロンプトを確認・編集");
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount("#todo-list li.task", 2);
    await expect($(icon)).toBeDisplayed();
    await $(ROWS).click();
    await expect($("#todo-back")).toBeDisplayed();
    await expect($(icon)).not.toBeDisplayed();
    await $("#todo-back").click();
    await expect($(icon)).toBeDisplayed();
  });

  it("draws the Claude mark that the Claude card uses", async () => {
    await openTodo();
    expect(await browser.execute(() => document.querySelector("#todo-prompt")!.innerHTML.includes("M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"))).toBe(true);
  });

  it("is not shown while the token form is up", async () => {
    await boot({ inbox: inbox(), todoist_load: null, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await expect($("#todo-token")).toBeDisplayed();
    await expect($(icon)).not.toBeDisplayed();
  });

  it("opens the prompt screen when pressed, and 戻る returns to the Todo list", async () => {
    await openTodo();
    await $(icon).click();
    await expect($("#prompt")).toBeDisplayed();
    await expect($("#todo")).not.toBeDisplayed();
    await expect($("#nav-settings")).toHaveAttribute("aria-current", "page");
    await $("#prompt-back").click();
    await expect($("#todo")).toBeDisplayed();
    await expect($("#prompt")).not.toBeDisplayed();
    await expect($("#nav-todo")).toHaveAttribute("aria-current", "page");
    await expect($(icon)).toBeDisplayed();
  });
});

describe("todo summary failure: the way to the Slack settings", () => {
  it("opens the settings on the Slack tab from 設定を開く when the token cannot read the message", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", rejects("このメッセージを読む権限がありません"));
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $(".pending.fail").waitForExist();
    await $(".pending.fail").$("button=設定を開く").click();
    await expect($("#settings")).toBeDisplayed();
    await expect($("#settings-tab-slack")).toHaveAttribute("aria-selected", "true");
    await expect($("#settings-panel-slack")).toBeDisplayed();
    await expect($("#settings-panel-google")).not.toBeDisplayed();
  });
});

describe("todo detail menu", () => {
  const more = "#todo-more";
  const items = '.menu[role="menu"] button[role="menuitem"]';
  const deleteItem = '.menu[role="menu"] button.danger';

  // The Todo screen with the detail of "Write report" (k1) open.
  async function openReport(data = todoData()) {
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await expect($(more)).toBeDisplayed();
  }

  // Runs the timed refresh now: the page's visibilitychange makes it load again.
  const refreshNow = () => browser.execute((id) => window.__e2e_once__(id) && document.dispatchEvent(new Event("visibilitychange")), onceId());

  it("shows the three-dot button only in a task's detail, and the screen has no reload, disconnect or trash button", async () => {
    await openTodo();
    await expect($(more)).not.toBeDisplayed();
    await expect($(more)).toHaveAttribute("aria-label", "その他");
    expect(await count("#todo-reload, #todo-disconnect, #todo-delete")).toBe(0);
    await $(ROWS).click();
    await expect($(more)).toBeDisplayed();
    await $("#todo-back").click();
    await expect($(more)).not.toBeDisplayed();
  });

  it("shows neither the button nor the old header buttons while the token form is up", async () => {
    await boot({ inbox: inbox(), todoist_load: null, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await expect($("#todo-token")).toBeDisplayed();
    await expect($(more)).not.toBeDisplayed();
  });

  it("lists タスクのリンクをコピー and then 削除, which is the dangerous one", async () => {
    await openReport();
    await $(more).click();
    await expect($(items)).toBeDisplayed();
    expect(await textsOf(items)).toEqual(["タスクのリンクをコピー", "削除"]);
    await expect($(deleteItem)).toHaveText("削除");
    expect(await count(`${items} svg`)).toBe(2);
  });

  it("copies the task's url, closes the menu and says so", async () => {
    await openReport();
    await stubClipboard();
    await $(more).click();
    await $(`${items}:first-child`).click();
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "nothing was copied" });
    expect(await copiedTexts()).toEqual(["https://app.todoist.com/app/task/k1"]);
    await expect($(".menu")).not.toExist();
    await expect($(".toast")).toHaveText("リンクをコピーしました");
  });

  it("leaves the copy item out when the task has no url", async () => {
    const data = todoData();
    data.tasks[0].url = "";
    await openReport(data);
    await $(more).click();
    expect(await textsOf(items)).toEqual(["削除"]);
  });

  it("lists 説明をコピー between the link and 削除 when the task has a description, and copies its Markdown source", async () => {
    await openReport(withDescription());
    await stubClipboard();
    await $(more).click();
    expect(await textsOf(items)).toEqual(["タスクのリンクをコピー", "説明をコピー", "削除"]);
    expect(await count(`${items} svg`)).toBe(3);
    await $(`${items}:nth-child(2)`).click();
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "nothing was copied" });
    expect(await copiedTexts()).toEqual([description]);
    await expect($(".menu")).not.toExist();
    await expect($(".toast")).toHaveText("説明をコピーしました");
  });

  it("shows the error and keeps the menu when the clipboard refuses the description", async () => {
    await openReport(withDescription());
    await browser.execute(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("denied")) } });
    });
    await $(more).click();
    await $(`${items}:nth-child(2)`).click();
    await expect($("#error")).toHaveText(expect.stringContaining("denied"));
    await expect($(".menu")).toExist();
    await expect($(".toast")).not.toBeDisplayed();
  });

  it("shows the error and keeps the menu when the clipboard refuses", async () => {
    await openReport();
    await browser.execute(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("denied")) } });
    });
    await $(more).click();
    await $(`${items}:first-child`).click();
    await expect($("#error")).toHaveText(expect.stringContaining("denied"));
    await expect($(".menu")).toExist();
    await expect($(".toast")).not.toBeDisplayed();
  });

  it("deletes with two presses of 削除: the first only asks, the second calls todoist_delete with the id", async () => {
    await openReport();
    const del = await mock("todoist_delete", true);
    await $(more).click();
    await $(deleteItem).click();
    await expect($(deleteItem)).toHaveText("もう一度押すと削除");
    await expect($(".menu")).toExist();
    expect(await callsOf(del)).toEqual([]);
    await $(deleteItem).click();
    expect(await waitForCalls(del)).toEqual([{ id: "k1" }]);
    await expect($(".menu")).not.toExist();
    await expect($("#todo-detail")).not.toBeDisplayed();
  });

  it("calls nothing after one press, and closing the menu starts the question again", async () => {
    await openReport();
    const del = await mock("todoist_delete", true);
    await $(more).click();
    await $(deleteItem).click();
    await expect($(deleteItem)).toHaveText("もう一度押すと削除");
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
    await $(more).click();
    await expect($(deleteItem)).toHaveText("削除");
    await $(deleteItem).click();
    await expect($(deleteItem)).toHaveText("もう一度押すと削除");
    expect(await callsOf(del)).toEqual([]);
  });

  it("closes the menu when the button is pressed again", async () => {
    await openReport();
    await $(more).click();
    await expect($(".menu")).toExist();
    await $(more).click();
    await expect($(".menu")).not.toExist();
    await expect($(more)).not.toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the open menu and the pending delete over a background redraw of the same task", async () => {
    await openReport();
    await $(more).click();
    await $(deleteItem).click();
    const data = todoData();
    data.tasks[0].content = "Write report v2";
    await mock("todoist_load", data);
    await refreshNow();
    await expect($("#todo-detail .name")).toHaveValue("Write report v2");
    await expect($(".menu")).toExist();
    await expect($(deleteItem)).toHaveText("もう一度押すと削除");
  });

  it("closes the menu when a redraw finds the open task gone", async () => {
    await openReport();
    await $(more).click();
    const data = todoData();
    data.tasks.shift();
    await mock("todoist_load", data);
    await refreshNow();
    await expect($("#todo-detail")).not.toBeDisplayed();
    await expect($(".menu")).not.toExist();
  });
});

describe("todo detail description copy", () => {
  const desc = "#todo-detail .desc";
  const copyButton = "#todo-detail .desc-copy";

  async function openReport(data = withDescription()) {
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await expect($(desc)).toBeDisplayed();
  }

  it("copies the Markdown source with the icon beside the description, and does not open the editor", async () => {
    await openReport();
    await stubClipboard();
    await expect($(copyButton)).toHaveAttribute("aria-label", "説明をコピー");
    // :hover and :focus never match in the E2E window: the hidden state is the computed style, and the rule that hides it says that hover or focus inside lifts it.
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#todo-detail .desc-copy")!).visibility)).toBe("hidden");
    const hiding = await browser.execute(() => {
      for (const sheet of document.styleSheets)
        for (const rule of sheet.cssRules)
          if (rule instanceof CSSStyleRule && rule.selectorText.includes(".desc-copy") && rule.style.visibility === "hidden") return rule.selectorText;
      return null;
    });
    expect(hiding).toContain(":not(:hover)");
    expect(hiding).toContain(":not(:focus-within)");
    // Not inside the description's role="button".
    expect(await browser.execute(() => document.querySelector("#todo-detail .desc-copy")!.closest(".desc"))).toBeNull();
    // A hidden button takes no WebDriver click, so the press is made in the page.
    await browser.execute((id) => window.__e2e_once__(id) && document.querySelector<HTMLElement>("#todo-detail .desc-copy")!.click(), onceId());
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "nothing was copied" });
    expect(await copiedTexts()).toEqual([description]);
    await expect($(".toast")).toHaveText("説明をコピーしました");
    expect(await count("#todo-detail .desc-edit")).toBe(0);
    await expect($(desc)).toBeDisplayed();
  });

  it("does not open the editor when the click ends a text selection inside the description", async () => {
    await openReport();
    await browser.execute(() => {
      const view = document.querySelector<HTMLElement>("#todo-detail .desc")!;
      const range = document.createRange();
      range.selectNodeContents(view);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      // The click a drag selection ends in; element.click() does not press the mouse, so the selection stays.
      view.click();
    });
    // Past the delay before a press starts the editor.
    await browser.pause(500);
    expect(await count("#todo-detail .desc-edit")).toBe(0);
    await expect($(desc)).toBeDisplayed();
  });

  it("does not open the editor on the clicks of a double click, which select a word", async () => {
    await openReport();
    await browser.execute(() => {
      const view = document.querySelector<HTMLElement>("#todo-detail .desc")!;
      // The clicks a double click makes: the first has `detail` 1 and no selection yet, the second has `detail` 2.
      view.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      view.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    });
    // Past the delay before a press starts the editor.
    await browser.pause(500);
    expect(await count("#todo-detail .desc-edit")).toBe(0);
    await expect($(desc)).toBeDisplayed();
  });

  it("does not start the editor when 戻る is pressed within the delay after the press", async () => {
    await openReport();
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      document.querySelector<HTMLElement>("#todo-detail .desc")!.click();
      document.getElementById("todo-back")!.click();
    }, onceId());
    // Past the delay before a press starts the editor: it would find the hidden detail and no textarea.
    await browser.pause(500);
    await expect($("#todo-list")).toBeDisplayed();
    await expect($("#todo-detail")).not.toBeDisplayed();
    await $(ROWS).click();
    await expect($(desc)).toBeDisplayed();
    expect(await count("#todo-detail .desc-edit")).toBe(0);
  });

  it("still opens the editor on a plain press of the description", async () => {
    await openReport();
    await $(desc).click();
    await expect($("#todo-detail .desc-edit")).toBeDisplayed();
    await expect($("#todo-detail .desc-edit")).toHaveValue(description);
  });

  it("shows neither the icon nor the menu item for an empty description", async () => {
    await openReport(todoData());
    await expect($(".desc.empty")).toHaveText("説明を追加");
    expect(await count(copyButton)).toBe(0);
    await $("#todo-more").click();
    expect(await textsOf('.menu[role="menu"] button[role="menuitem"]')).toEqual(["タスクのリンクをコピー", "削除"]);
  });
});

describe("todo completed tasks after an offline answer", () => {
  // Todo data that is the cached one, as the backend answers while Todoist cannot be reached.
  const offlineData = () => ({ ...todoData(), offline: { fetchedAt: new Date().toISOString(), reason: "network" } });
  const withDone = async (loads: string) => (await waitForCalls(loads)).map((a) => (a as { withDone: boolean }).withDone);

  async function openOffline() {
    await boot({ inbox: inbox(), todoist_load: offlineData(), slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await waitForCount(ROWS, 1);
    await waitForCount("#todo-notice div", 1);
  }

  it("asks for the completed tasks again on each timed refresh until an answer is not from the cache, and an offline answer later does not ask again", async () => {
    await openOffline();
    // The timed refresh: the page's visibilitychange makes it load again.
    const refreshNow = () => browser.execute((id) => window.__e2e_once__(id) && document.dispatchEvent(new Event("visibilitychange")), onceId());
    let loads = await mock("todoist_load", offlineData());
    await refreshNow();
    expect(await withDone(loads)).toEqual([true]);
    loads = await mock("todoist_load", todoData());
    await refreshNow();
    expect(await withDone(loads)).toEqual([true]);
    await waitForCount("#todo-notice div", 0);
    loads = await mock("todoist_load", todoData());
    await refreshNow();
    expect(await withDone(loads)).toEqual([false]);
    // An answer from the cache does not make the held completed tasks stale again.
    loads = await mock("todoist_load", offlineData());
    await refreshNow();
    expect(await withDone(loads)).toEqual([false]);
  });

  it("asks for the completed tasks again when the Todo screen is opened until an answer is not from the cache, and an offline answer later does not ask again", async () => {
    await openOffline();
    const reopen = async () => {
      await $("#nav-mail").click();
      await $("#nav-todo").click();
    };
    let loads = await mock("todoist_load", todoData());
    await reopen();
    expect(await withDone(loads)).toEqual([true]);
    await waitForCount("#todo-notice div", 0);
    loads = await mock("todoist_load", todoData());
    await reopen();
    expect(await withDone(loads)).toEqual([false]);
    loads = await mock("todoist_load", offlineData());
    await reopen();
    expect(await withDone(loads)).toEqual([false]);
  });
});

// The subtask `name` in the open task's list.
const subRowOf = (name: string) => $(`//section[@id="todo-detail"]//ul[contains(@class,"subs")]/li[contains(., "${name}")]`);
// Opens the detail of "Plan trip", then, one by one, of each subtask named after it.
async function openTask(...path: string[]) {
  await openTodo();
  await $('#projects .proj[data-view="p1"]').click();
  await waitForCount(ROWS, 2);
  await rowOf("Plan trip").click();
  for (const name of path) await subRowOf(name).click();
}

describe("todo detail of a subtask", () => {
  it("shows the parent task above the name of a subtask, and opens the parent when it is pressed", async () => {
    await openTask("Book flights");
    await expect($("#todo-detail .name")).toHaveValue("Book flights");
    await expect($("#todo-detail .parent-link")).toHaveText(expect.stringContaining("親タスク"));
    await expect($("#todo-detail .parent-link")).toHaveText(expect.stringContaining("Plan trip"));
    // A real button, above the name row.
    expect(await $("#todo-detail .parent-link").getTagName()).toBe("button");
    expect(await browser.execute(() => document.querySelector("#todo-detail .parent-link")!.nextElementSibling!.className)).toBe("head");
    await $("#todo-detail .parent-link").click();
    await expect($("#todo-detail .name")).toHaveValue("Plan trip");
  });

  it("shows only the direct parent of a subtask whose parent is a subtask too", async () => {
    await openTask("Book flights", "Pick seat");
    await expect($("#todo-detail .name")).toHaveValue("Pick seat");
    expect(await count("#todo-detail .parent-link")).toBe(1);
    await expect($("#todo-detail .parent-link")).toHaveText(expect.stringContaining("Book flights"));
    await expect($("#todo-detail .parent-link")).not.toHaveText(expect.stringContaining("Plan trip"));
    await $("#todo-detail .parent-link").click();
    await expect($("#todo-detail .name")).toHaveValue("Book flights");
  });

  it("shows no parent task on a task that has none", async () => {
    await openTask();
    await expect($("#todo-detail .name")).toHaveValue("Plan trip");
    expect(await count("#todo-detail .parent-link")).toBe(0);
  });
});

describe("todo subtask being created", () => {
  const sub = '#todo-detail [data-field="sub"]';
  const creating = "#todo-detail .subs li.creating";
  // Types a subtask name and presses Enter.
  async function typeSub(name: string) {
    await $(sub).setValue(name);
    await browser.keys("Enter");
  }
  // What Todoist holds once the subtasks `names` were added to "Plan trip".
  function withNew(...names: string[]) {
    const data = todoData();
    names.forEach((name, i) => {
      const id = `n${i}`;
      data.tasks[1].subtasks.push({ id, content: name, done: false, due: null });
      data.tasks[1].subTotal++;
      data.tasks.push({ ...task(id, name, "p1", "none"), parent: { id: "k2", content: "Plan trip" } });
    });
    return data;
  }

  it("shows a row with a spinner, the typed name and 作成中 at the end of the list, and keeps the field free, while the subtask is being created", async () => {
    await openTask();
    const add = await mock("todoist_add_subtask", holds);
    await typeSub("Buy luggage");
    expect(await waitForCalls(add)).toEqual([{ parentId: "k2", content: "Buy luggage" }]);
    await waitForCount(creating, 1);
    await expect($(creating)).toHaveText(expect.stringContaining("Buy luggage"));
    await expect($(creating)).toHaveText(expect.stringContaining("作成中"));
    await expect($(`${creating} .spin`)).toExist();
    // At the end: after the subtasks it already had.
    expect(await browser.execute(() => document.querySelector("#todo-detail .subs")!.lastElementChild!.classList.contains("creating"))).toBe(true);
    await expect($(sub)).toBeEnabled();
    await expect($(sub)).toHaveValue("");
  });

  it("shows a row for each of several subtasks added one after another, and the field takes the next while they wait", async () => {
    await openTask();
    const add = await mock("todoist_add_subtask", holds);
    await typeSub("Buy luggage");
    await waitForCalls(add);
    await typeSub("Pack bag");
    await waitForCalls(add, 2);
    await waitForCount(creating, 2);
    expect(await textsOf(creating)).toEqual([expect.stringContaining("Buy luggage"), expect.stringContaining("Pack bag")]);
    await mock("todoist_load", withNew("Buy luggage", "Pack bag"));
    await release(add, true);
    await release(add, true);
    await waitForCount(creating, 0);
    await expect(subRowOf("Buy luggage")).toExist();
    await expect(subRowOf("Pack bag")).toExist();
  });

  it("keeps the row over a redraw of the detail", async () => {
    await openTask();
    const add = await mock("todoist_add_subtask", holds);
    await typeSub("Buy luggage");
    await waitForCount(creating, 1);
    await $("#todo-back").click();
    await rowOf("Plan trip").click();
    await waitForCount(creating, 1);
    await expect($(creating)).toHaveText(expect.stringContaining("Buy luggage"));
    await release(add, true);
  });

  it("keeps the row until the real one is drawn, with no moment in between when neither is there", async () => {
    await openTask();
    const add = await mock("todoist_add_subtask", holds);
    await typeSub("Buy luggage");
    await waitForCount(creating, 1);
    await mock("todoist_load", withNew("Buy luggage"));
    // Watches every redraw of the detail: the name is in the subtask list after each.
    await browser.execute(() => {
      const w = window as unknown as { __gap__: boolean };
      w.__gap__ = false;
      new MutationObserver(() => {
        if (!document.querySelector("#todo-detail .subs")?.textContent?.includes("Buy luggage")) w.__gap__ = true;
      }).observe(document.getElementById("todo-detail")!, { childList: true, subtree: true });
    });
    await release(add, true);
    await waitForCount(creating, 0);
    await expect(subRowOf("Buy luggage")).toExist();
    expect(await browser.execute(() => (window as unknown as { __gap__: boolean }).__gap__)).toBe(false);
  });

  it("removes the row and shows the error when the creation fails", async () => {
    await openTask();
    const add = await mock("todoist_add_subtask", rejects("Todoist に接続できません"));
    await typeSub("Buy luggage");
    await waitForCalls(add);
    await waitForCount(creating, 0);
    await expect($("#error")).toHaveText(expect.stringContaining("Todoist に接続できません"));
    await expect(subRowOf("Buy luggage")).not.toExist();
  });
});

describe("todo detail due date clear button", () => {
  const clear = "#todo-detail .field-clear";

  // The E2E driver dispatches pointer events from JS and the window is hidden, so :hover and :focus never match here: the shown state cannot be reached.
  // The hidden state is the computed style with no hover, and the rule that hides it is read from the stylesheet to say that hover or focus inside the row lifts it.
  it("hides the button unless the mouse is over the date or the focus is in it, and clears the date at once when it is pressed", async () => {
    await openTodo();
    const update = await mock("todoist_update", true);
    // What Todoist answers after it, so the reload that follows keeps the task without a date.
    const cleared = todoData();
    Object.assign(cleared.tasks[0], { due: null, bucket: "none" });
    await mock("todoist_load", cleared);
    await $(ROWS).click();
    await expect($(clear)).toExist();
    await expect($(clear)).toHaveAttribute("aria-label", "日付をクリア");
    expect(await $(clear).getTagName()).toBe("button");
    await expect($(clear)).not.toBeDisplayed();
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#todo-detail .field-clear")!).visibility)).toBe("hidden");
    const hiding = await browser.execute(() => {
      for (const sheet of document.styleSheets)
        for (const rule of sheet.cssRules)
          if (rule instanceof CSSStyleRule && rule.selectorText.includes(".field-clear") && rule.style.visibility === "hidden") return rule.selectorText;
      return null;
    });
    expect(hiding).toContain(":not(:hover)");
    expect(hiding).toContain(":not(:focus-within)");
    // A sibling of the date button, not inside it.
    expect(await browser.execute(() => document.querySelector("#todo-detail .field-clear")!.closest(".field-value"))).toBe(null);
    // A hidden button takes no WebDriver click, so the press is made in the page.
    await browser.execute((id) => window.__e2e_once__(id) && document.querySelector<HTMLElement>("#todo-detail .field-clear")!.click(), onceId());
    expect(await waitForCalls(update)).toEqual([{ id: "k1", dueString: "" }]);
    await expect($("#todo-detail .field:nth-child(2) .field-value")).toHaveText("期限なし");
    await expect($(".due-pop")).not.toExist();
    await expect($(clear)).not.toExist();
  });

  it("shows the button on a repeating task too", async () => {
    const data = todoData();
    data.tasks[0].due = { date: today, time: null, string: "every day", recurring: true };
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await expect($(clear)).toExist();
  });

  it("takes two presses to clear a repeating task's date: the first only asks, the second clears", async () => {
    const data = todoData();
    data.tasks[0].due = { date: today, time: null, string: "every day", recurring: true };
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    const update = await mock("todoist_update", true);
    const press = () => browser.execute((id) => window.__e2e_once__(id) && document.querySelector<HTMLElement>("#todo-detail .field-clear")!.click(), onceId());
    await press();
    await expect($(clear)).toHaveAttribute("aria-label", "もう一度押すと繰り返しごと日付をクリア");
    expect(await callsOf(update)).toEqual([]);
    await press();
    expect(await waitForCalls(update)).toEqual([{ id: "k1", dueString: "" }]);
  });

  it("has no button on a task without a date", async () => {
    await openTask();
    await expect($("#todo-detail .name")).toHaveValue("Plan trip");
    await expect($("#todo-detail .field:nth-child(2) .field-value")).toHaveText("期限なし");
    await expect($(clear)).not.toExist();
  });
});

describe("todo detail comments", () => {
  const field = '#todo-detail [data-field="comment"]';
  const sendButton = "#todo-detail .c-send";
  const rows = "#todo-detail .c-row";
  const chip = "#todo-detail .c-chip";

  // Alice's comment with a Markdown body (posted today), Bob's with a file that has an address, and a third of only a file with none (its text is the file's name).
  const thread = [
    comment("c1", "Alice Example", "- point one\n- point **two**", { date: today, time: "09:30" }),
    comment("c2", "Bob Example", "See attached", undefined, { fileName: "plan.md", fileUrl: "https://files.example.com/plan.md" }),
    comment("c3", "Alice Example", "memo.txt", undefined, { fileName: "memo.txt", fileUrl: null }),
  ];
  const uploaded = { file_url: "https://files.example.com/a.txt", file_name: "報告.txt", file_size: 5, file_type: "text/plain", resource_type: "file", upload_state: "completed" };

  // The Todo screen with the detail of "Write report" (k1) open; `answer` is what the comments command answers from the start.
  async function openReport(answer: unknown = thread) {
    await boot({ inbox: inbox(), todoist_load: todoData(), slack_load: slackLoad, claude_status: claudeReady, todoist_comments: answer });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await expect($("#todo-detail .comments")).toBeDisplayed();
  }

  // Runs the timed refresh now: the page's visibilitychange makes it load again.
  const refreshNow = () => browser.execute((id) => window.__e2e_once__(id) && document.dispatchEvent(new Event("visibilitychange")), onceId());
  // Cmd+Enter (Ctrl+Enter off macOS) in the comment field, sent as the key event the app listens for.
  const pressSend = () =>
    browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      const mac = /Mac/.test(navigator.platform);
      const key = new KeyboardEvent("keydown", { key: "Enter", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
      document.querySelector('#todo-detail [data-field="comment"]')!.dispatchEvent(key);
    }, onceId());
  const heightOf = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().height, selector);
  const blur = () => browser.execute(() => (document.activeElement as HTMLElement).blur());

  it("draws each comment with its author's initials, name, date, Markdown text and file card, under a heading with the count", async () => {
    await openReport();
    await waitForCount(rows, 3);
    await expect($("#todo-detail .c-head")).toHaveText(expect.stringContaining("コメント"));
    await expect($("#todo-detail .c-count")).toHaveText("3");
    expect(await textsOf("#todo-detail .c-author")).toEqual(["Alice Example", "Bob Example", "Alice Example"]);
    expect(await textsOf("#todo-detail .c-row .avatar")).toEqual(["AE", "BE", "AE"]);
    // Today shows the time alone; another year shows the year too.
    expect(await textsOf("#todo-detail .c-date")).toEqual(["09:30", "2000年01月02日 08:20", "2000年01月02日 08:20"]);
    expect(await count("#todo-detail .c-text li")).toBe(2);
    expect(await count("#todo-detail .c-text strong")).toBe(1);
    // The text of a comment of only a file is the file's name, which the card says: it is not drawn twice.
    expect(await textsOf("#todo-detail .c-text")).toHaveLength(2);
    await expect($("#todo-detail .comments")).toHaveText(expect.stringContaining("See attached"));
  });

  it("draws a file with an address as a link to it, and one without as a card that is no link", async () => {
    await openReport();
    await waitForCount(rows, 3);
    const cards = await browser.execute(() => [...document.querySelectorAll("#todo-detail .c-file")].map((e) => ({ tag: e.tagName, href: e.getAttribute("href"), title: e.getAttribute("title"), text: e.textContent })));
    // The title is the host the card goes to, which the file's name may not say.
    expect(cards).toEqual([
      { tag: "A", href: "https://files.example.com/plan.md", title: "files.example.com", text: "plan.md" },
      { tag: "DIV", href: null, title: null, text: "memo.txt" },
    ]);
  });

  it("keeps only http(s) links in a comment and drops scripts", async () => {
    await openReport([comment("c1", "Alice Example", "[bad](javascript:alert(1)) [ok](https://example.com/x) <script>window.__pwned = 1</script>")]);
    await waitForCount(rows, 1);
    const links = await browser.execute(() => [...document.querySelectorAll("#todo-detail .c-text a[href]")].map((a) => a.getAttribute("href")));
    expect(links).toEqual(["https://example.com/x"]);
    expect(await count("#todo-detail .c-text script")).toBe(0);
  });

  it("drops label, for, class and data-* from a comment, so that it cannot cover the screen or press its buttons", async () => {
    await openReport([comment("c1", "Alice Example", '<label for="trash" class="scrim" data-field="x">cover</label> <a class="scrim" data-field="y" href="https://example.com/">go</a>')]);
    await waitForCount(rows, 1);
    expect(await count("#todo-detail .c-text label")).toBe(0);
    expect(await count("#todo-detail .c-text a[href]")).toBe(1);
    const attrs = await browser.execute(() => [...document.querySelectorAll("#todo-detail .c-text *")].flatMap((e) => e.getAttributeNames().filter((n) => n === "for" || n === "class" || n.startsWith("data-"))));
    expect(attrs).toEqual([]);
  });

  it("drops svg and math from a comment", async () => {
    await openReport([comment("c1", "Alice Example", 'before <svg width="9999" height="9999"><a href="https://example.com/s"><rect width="9999" height="9999"></rect></a></svg> <math><mi>x</mi></math> after')]);
    await waitForCount(rows, 1);
    expect(await count("#todo-detail .c-text svg")).toBe(0);
    expect(await count("#todo-detail .c-text math")).toBe(0);
    const foreign = await browser.execute(() => [...document.querySelectorAll("#todo-detail .c-text *")].filter((e) => e.namespaceURI !== "http://www.w3.org/1999/xhtml").length);
    expect(foreign).toBe(0);
  });

  it("fetches the comments once when the task is opened, and not again on a redraw of the same task", async () => {
    await openReport();
    expect(await waitForCalls("todoist_comments")).toEqual([{ taskId: "k1", projectId: "p1" }]);
    await waitForCount(rows, 3);
    const data = todoData();
    data.tasks[0].content = "Write report v2";
    await mock("todoist_load", data);
    await refreshNow();
    await expect($("#todo-detail .name")).toHaveValue("Write report v2");
    await waitForCount(rows, 3);
    expect(await callsOf("todoist_comments")).toHaveLength(1);
    // Opened again after the list: a new opening fetches again.
    await $("#todo-back").click();
    await $(ROWS).click();
    expect(await waitForCalls("todoist_comments", 2)).toHaveLength(2);
  });

  it("fetches the comments of the open task again when the Todo screen is shown again", async () => {
    await openReport();
    await waitForCalls("todoist_comments");
    await $("#nav-mail").click();
    await $("#nav-todo").click();
    expect(await waitForCalls("todoist_comments", 2)).toEqual([
      { taskId: "k1", projectId: "p1" },
      { taskId: "k1", projectId: "p1" },
    ]);
    await waitForCount(rows, 3);
  });

  it("fetches for the other task when a subtask is opened", async () => {
    await openTask();
    await waitForCalls("todoist_comments");
    await subRowOf("Book flights").click();
    await expect($("#todo-detail .name")).toHaveValue("Book flights");
    expect(await waitForCalls("todoist_comments", 2)).toEqual([
      { taskId: "k2", projectId: "p1" },
      { taskId: "k3", projectId: "p1" },
    ]);
  });

  it("says so when the task has no comments, and shows no count", async () => {
    await openReport([]);
    await expect($("#todo-detail .c-note")).toHaveText("コメントはまだありません");
    expect(await textsOf("#todo-detail .c-count")).toEqual([""]);
    await expect($(field)).toBeDisplayed();
  });

  it("shows a failed fetch in the section, not as the screen's error", async () => {
    await openReport(rejects("boom"));
    await expect($("#todo-detail .c-note.fail")).toHaveText(expect.stringContaining("boom"));
    await expect($("#error")).not.toBeDisplayed();
    await expect($(field)).toBeDisplayed();
  });

  it("shows what it holds while it fetches, and keeps what an answer for a task no longer open brings", async () => {
    await openTodo();
    const first = await mock("todoist_comments", holds);
    await $(ROWS).click();
    await waitForCalls(first);
    await expect($("#todo-detail .c-note")).toHaveText(expect.stringContaining("読み込み中"));
    await $("#todo-back").click();
    await release(first, [comment("c1", "Alice Example", "late")]);
    await browser.pause(200);
    expect(await count(rows)).toBe(0);
    const second = await mock("todoist_comments", holds);
    await $(ROWS).click();
    await waitForCalls(second);
    // The earlier answer was kept, and shows while the new fetch is on its way.
    await waitForCount(rows, 1);
    await release(second, []);
    await waitForCount(rows, 0);
    await expect($("#todo-detail .c-note")).toHaveText("コメントはまだありません");
  });

  it("shows the token form when the fetch finds that a token is needed", async () => {
    await openReport([]);
    await $("#todo-back").click();
    const comments = await mock("todoist_comments", holds);
    await $(ROWS).click();
    await waitForCalls(comments);
    const load = await mock("todoist_load", null);
    await release(comments, null);
    await expect($("#todo-token")).toBeDisplayed();
    expect((await callsOf(load)).length).toBeGreaterThan(0);
  });

  it("folds the comments under the heading and shows them again, with the field staying", async () => {
    await openReport();
    await waitForCount(rows, 3);
    await $("#todo-detail .c-head").click();
    await expect($("#todo-detail .c-head")).toHaveAttribute("aria-expanded", "false");
    await expect($("#todo-detail .c-list")).not.toBeDisplayed();
    await expect($(field)).toBeDisplayed();
    await $("#todo-detail .c-head").click();
    await expect($("#todo-detail .c-head")).toHaveAttribute("aria-expanded", "true");
    await expect($(rows)).toBeDisplayed();
  });

  it("sends the typed text with todoist_add_comment, adds the answer to the list and empties the field", async () => {
    await openReport();
    await waitForCount(rows, 3);
    const add = await mock("todoist_add_comment", comment("c4", "Alice Example", "Looks good", { date: today, time: "10:00" }));
    await $(field).setValue("Looks good");
    await $(sendButton).click();
    expect(await waitForCalls(add)).toEqual([{ taskId: "k1", content: "Looks good", attachment: null }]);
    await waitForCount(rows, 4);
    expect((await textsOf("#todo-detail .c-text")).at(-1)).toBe("Looks good");
    await expect($("#todo-detail .c-count")).toHaveText("4");
    await expect($(field)).toHaveValue("");
    await expect($(sendButton)).toBeDisabled();
  });

  it("enables the send button for non-blank text only", async () => {
    await openReport([]);
    await expect($(sendButton)).toBeDisabled();
    await $(field).setValue("  ");
    await expect($(sendButton)).toBeDisabled();
    await $(field).setValue("x");
    await expect($(sendButton)).toBeEnabled();
  });

  it("takes Enter as a line break and sends on Cmd+Enter, with the line breaks kept", async () => {
    await openReport([]);
    const add = await mock("todoist_add_comment", comment("c4", "Alice Example", "a\nb"));
    await $(field).setValue("a");
    await browser.keys("Enter");
    await browser.keys("b");
    await expect($(field)).toHaveValue("a\nb");
    expect(await callsOf(add)).toEqual([]);
    await pressSend();
    expect(await waitForCalls(add)).toEqual([{ taskId: "k1", content: "a\nb", attachment: null }]);
    await waitForCount(rows, 1);
    await expect($(field)).toHaveValue("");
  });

  it("grows the field with its text up to 6 lines, then scrolls", async () => {
    await openReport([]);
    const fill = (n: number) =>
      browser.execute((lines) => {
        const area = document.querySelector('#todo-detail [data-field="comment"]') as HTMLTextAreaElement;
        area.value = Array.from({ length: lines }, (_, i) => `行${i + 1}`).join("\n");
        area.dispatchEvent(new Event("input", { bubbles: true }));
      }, n);
    const one = await heightOf(field);
    await fill(3);
    const three = await heightOf(field);
    await fill(9);
    expect(three).toBeGreaterThan(one);
    expect(await heightOf(field)).toBe(one + 5 * 20);
  });

  it("shows a spinner and waits on the send button while the comment is on its way, and the field keeps its text", async () => {
    await openReport([]);
    const add = await mock("todoist_add_comment", holds);
    await $(field).setValue("slow one");
    await $(sendButton).click();
    await waitForCalls(add);
    await expect($(`${sendButton} .spin`)).toExist();
    await expect($(sendButton)).toBeDisabled();
    await expect($(field)).toHaveValue("slow one");
    await release(add, comment("c4", "Alice Example", "slow one"));
    await waitForCount(rows, 1);
    await expect($(`${sendButton} .spin`)).not.toExist();
    await expect($(field)).toHaveValue("");
  });

  it("keeps the text and shows the error when adding the comment fails", async () => {
    await openReport([]);
    const add = await mock("todoist_add_comment", rejects("add failed"));
    await $(field).setValue("keep me");
    await $(sendButton).click();
    await waitForCalls(add);
    await expect($("#error")).toHaveText(expect.stringContaining("add failed"));
    await expect($(field)).toHaveValue("keep me");
    await expect($(sendButton)).toBeEnabled();
    expect(await count(rows)).toBe(0);
  });

  it("shows a comment once when the fetch answers before the add does", async () => {
    await boot({ inbox: inbox(), todoist_load: todoData(), slack_load: slackLoad, claude_status: claudeReady, todoist_comments: holds });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await expect($("#todo-detail .comments")).toBeDisplayed();
    const added = comment("c4", "Alice Example", "Looks good", { date: today, time: "10:00" });
    const add = await mock("todoist_add_comment", holds);
    await $(field).setValue("Looks good");
    await $(sendButton).click();
    await waitForCalls(add);
    await release("todoist_comments", [added]);
    await waitForCount(rows, 1);
    await release(add, added);
    await expect($(sendButton)).toBeDisabled();
    await browser.pause(300);
    expect(await count(rows)).toBe(1);
  });

  it("takes the load that shows the token form when adding finds that a token is needed", async () => {
    await openReport([]);
    await mock("todoist_add_comment", null);
    const load = await mock("todoist_load", null);
    await $(field).setValue("hello");
    await $(sendButton).click();
    await expect($("#todo-token")).toBeDisplayed();
    expect((await callsOf(load)).length).toBeGreaterThan(0);
  });

  it("opens the file picker from the clip, and the picker is not in the detail", async () => {
    await openReport([]);
    await expect($("#comment-file")).not.toBeDisplayed();
    expect(await browser.execute(() => document.getElementById("comment-file")!.closest("#todo-detail"))).toBeNull();
    await browser.execute(() => {
      const w = window as unknown as { __picks__: number };
      w.__picks__ = 0;
      // The real click would open the native panel.
      document.getElementById("comment-file")!.click = () => void w.__picks__++;
    });
    await $("#todo-detail .c-clip").click();
    expect(await browser.execute(() => (window as unknown as { __picks__: number }).__picks__)).toBe(1);
  });

  it("shows the picked file as a chip that takes it off again, and a second pick replaces the first", async () => {
    await openReport([]);
    await pickFile("first.txt", "1");
    await expect($(chip)).toHaveText(expect.stringContaining("first.txt"));
    await expect($(sendButton)).toBeEnabled();
    await pickFile("second.txt", "2");
    await expect($(chip)).toHaveText(expect.stringContaining("second.txt"));
    await expect($(chip)).not.toHaveText(expect.stringContaining("first.txt"));
    await $(`${chip} .icon-btn`).click();
    await expect($(chip)).not.toBeDisplayed();
    await expect($(sendButton)).toBeDisabled();
  });

  it("uploads the picked file with its name in the header, then adds the comment with the attachment and the text", async () => {
    await openReport([]);
    const upload = await mock("todoist_upload", uploaded);
    const add = await mock("todoist_add_comment", comment("c4", "Alice Example", "Here it is", { date: today, time: "10:00" }, { fileName: "報告.txt", fileUrl: uploaded.file_url }));
    await $(field).setValue("Here it is");
    await pickFile("報告.txt", "hello");
    await $(sendButton).click();
    const calls = await waitForCalls(add);
    // The upload came first: its answer is the attachment.
    expect(await callsOf(upload)).toEqual([{ bytes: [104, 101, 108, 108, 111], headers: { "x-file-name": "%E5%A0%B1%E5%91%8A.txt" } }]);
    expect(calls).toEqual([{ taskId: "k1", content: "Here it is", attachment: uploaded }]);
    await waitForCount(rows, 1);
    await expect($(`${rows} .c-file`)).toHaveText("報告.txt");
    await expect($(chip)).not.toBeDisplayed();
    await expect($(field)).toHaveValue("");
  });

  it("uploads the file once when the add fails and is sent again, and again after the file is replaced", async () => {
    await openReport([]);
    const upload = await mock("todoist_upload", uploaded);
    await mock("todoist_add_comment", rejects("add failed"));
    await pickFile("報告.txt", "hello");
    await $(sendButton).click();
    await waitForCalls("todoist_add_comment");
    await expect($("#error")).toHaveText(expect.stringContaining("add failed"));
    const add = await mock("todoist_add_comment", comment("c4", "Alice Example", "報告.txt", { date: today, time: "10:00" }, { fileName: "報告.txt", fileUrl: uploaded.file_url }));
    await $(sendButton).click();
    expect(await waitForCalls(add)).toEqual([{ taskId: "k1", content: "", attachment: uploaded }]);
    expect(await callsOf(upload)).toHaveLength(1);
    // A file picked after a failed add is uploaded on its own.
    await mock("todoist_add_comment", rejects("add failed"));
    await pickFile("other.txt", "x");
    await $(sendButton).click();
    await waitForCalls("todoist_add_comment");
    await pickFile("third.txt", "y");
    await mock("todoist_add_comment", comment("c5", "Alice Example", "third.txt"));
    await $(sendButton).click();
    await waitForCalls("todoist_add_comment");
    expect(await callsOf(upload)).toHaveLength(3);
  });

  it("sends a file alone with an empty text, and the card is drawn without the text", async () => {
    await openReport([]);
    await mock("todoist_upload", uploaded);
    const add = await mock("todoist_add_comment", comment("c4", "Alice Example", "報告.txt", { date: today, time: "10:00" }, { fileName: "報告.txt", fileUrl: uploaded.file_url }));
    await pickFile("報告.txt", "hello");
    await $(sendButton).click();
    expect(await waitForCalls(add)).toEqual([{ taskId: "k1", content: "", attachment: uploaded }]);
    await waitForCount(rows, 1);
    expect(await count(`${rows} .c-text`)).toBe(0);
  });

  it("keeps the text and the file, adds nothing and shows the error when the upload fails", async () => {
    await openReport([]);
    const upload = await mock("todoist_upload", rejects("upload failed"));
    const add = await mock("todoist_add_comment", comment("c4", "Alice Example", "x"));
    await $(field).setValue("keep me");
    await pickFile("a.txt", "x");
    await $(sendButton).click();
    await waitForCalls(upload);
    await expect($("#error")).toHaveText(expect.stringContaining("upload failed"));
    expect(await callsOf(add)).toEqual([]);
    await expect($(field)).toHaveValue("keep me");
    await expect($(chip)).toHaveText(expect.stringContaining("a.txt"));
    await expect($(sendButton)).toBeEnabled();
  });

  it("refuses a file over 100 MB on the screen before it is read, and takes one of exactly 100 MB", async () => {
    await openReport([]);
    const upload = await mock("todoist_upload", uploaded);
    await pickFile("big.bin", "x", 100 * 1024 * 1024 + 1);
    await expect($("#error")).toHaveText(expect.stringContaining("100 MB"));
    await expect($(chip)).not.toBeDisplayed();
    expect(await callsOf(upload)).toEqual([]);
    await pickFile("edge.bin", "x", 100 * 1024 * 1024);
    await expect($(chip)).toHaveText(expect.stringContaining("edge.bin"));
  });

  it("keeps the draft over a redraw of the detail", async () => {
    await openReport([]);
    await $(field).setValue("draft text");
    await pickFile("keep.txt", "x");
    await blur();
    const data = todoData();
    data.tasks[0].content = "Write report v2";
    await mock("todoist_load", data);
    await refreshNow();
    await expect($("#todo-detail .name")).toHaveValue("Write report v2");
    await expect($(field)).toHaveValue("draft text");
    await expect($(chip)).toHaveText(expect.stringContaining("keep.txt"));
  });

  it("waits with the redraw while the comment field has text, and does not while it is empty", async () => {
    await openReport([]);
    const data = todoData();
    data.tasks[0].content = "Write report v2";
    await $(field).setValue("typing");
    await mock("todoist_load", data);
    await refreshNow();
    await browser.pause(500);
    await expect($("#todo-detail .name")).toHaveValue("Write report");
    await expect($(field)).toBeFocused();
    // Emptied in the page: clearing through the driver would blur the field.
    await browser.execute(() => {
      const area = document.querySelector('#todo-detail [data-field="comment"]') as HTMLTextAreaElement;
      area.value = "";
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await refreshNow();
    await expect($("#todo-detail .name")).toHaveValue("Write report v2");
    await expect($(field)).toBeFocused();
  });

  it("keeps each task's draft when another task is opened and the first again", async () => {
    await openTask();
    await $(field).setValue("trip note");
    await pickFile("trip.txt", "x");
    await subRowOf("Book flights").click();
    await expect($("#todo-detail .name")).toHaveValue("Book flights");
    await expect($(field)).toHaveValue("");
    await expect($(chip)).not.toBeDisplayed();
    await $("#todo-detail .parent-link").click();
    await expect($("#todo-detail .name")).toHaveValue("Plan trip");
    await expect($(field)).toHaveValue("trip note");
    await expect($(chip)).toHaveText(expect.stringContaining("trip.txt"));
  });

  it("edits the description in its own textarea, not the comment field", async () => {
    await boot({ inbox: inbox(), todoist_load: withDescription(), slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await $("#todo-detail .desc").click();
    await expect($("#todo-detail .desc-edit")).toBeFocused();
    await expect($("#todo-detail .desc-edit")).toHaveValue(description);
    await expect($(field)).toHaveValue("");
  });
});
