import {
  boot, callsOf, claudeKeyReady, claudeMissing, claudeReady, claudeSettings, comment, composerLayout, connection, copiedTexts, count, dueToday, holds, inbox, mock, onceId, pickFile, rejects, release, setClock, slackLoad, slackMessageUrl, slackSummary, stubClipboard, task, textsOf, today, todoData, todoDraftEdit, waitForCalls, waitForCount, waitForText, openTodo,
} from "../support";

// A press as a mouse makes it. WebDriver's element click sends no pointerdown, which is what closes a popover (as in calendar.e2e.ts).
const press = (target: ChainablePromiseElement) => browser.action("pointer").move({ origin: target }).down().up().perform();

describe("todo", () => {
  it("lists the projects and today's tasks, and a project's tasks when it is picked", async () => {
    await openTodo();
    await expect($("#todo-title")).toHaveText("今日");
    await waitForText("#projects .proj .name", "Work");
    await expect($("#projects")).toHaveText(expect.stringContaining("インボックス"));
    await expect($("#todo-list")).toHaveText(expect.stringContaining("Write report"));
    await expect($("#todo-list")).not.toHaveText(expect.stringContaining("Plan trip"));
    await $('#projects .proj[data-view="p1"]').click();
    await expect($("#todo-title")).toHaveText("Work");
    await waitForCount("#todo-list li.task", 2);
    await expect($("#todo-list")).toHaveText(expect.stringContaining("Plan trip"));
  });

  it("makes the header of the list a place to drag the window by", async () => {
    await openTodo();
    await expect($("#todo-body > header")).toHaveAttribute("data-tauri-drag-region", "deep");
  });

  it("has no placeholder in the add field", async () => {
    await openTodo();
    await expect($("#todo-add-input")).not.toHaveAttribute("placeholder");
    await expect($("#todo-add-input")).toHaveAttribute("aria-label", "タスクを追加");
  });

  it("adds the typed text through todoist_add", async () => {
    await openTodo();
    const add = await mock("todoist_add", true);
    await $("#todo-add-input").setValue("Buy milk");
    await $("#todo-add-button").click();
    await waitForCalls(add);
    expect(await callsOf(add)).toContainEqual({ text: "Buy milk", projectId: null, today: true });
  });

  // The Todo screen with a Slack link pasted: the summary is mocked, and its draft page is up.
  async function openSummaryCard() {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", slackSummary);
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await waitForCalls(summarize);
    await $("#todo-draft").waitForExist();
    return { summarize, addFromSlack };
  }

  // Types `text` in the page's due popover and confirms it with Enter.
  async function setCardDue(text: string) {
    await $("#todo-draft .draft-due").click();
    await $(".due-pop .chip-input").setValue(text);
    await browser.keys("Enter");
  }

  // The day button `n` of the month the due popover shows (not a day of the month before or after).
  const dayButton = (n: number) => $(`//div[contains(@class,"due-pop")]//button[contains(@class,"dp-day") and not(contains(@class,"other")) and text()="${n}"]`);

  // The same page with Claude's recommendation: `projectId` is an ID of the Todo fixtures (p1 is Work).
  async function openRecommendedCard(projectId: string) {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", { ...slackSummary, projectId });
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await waitForCalls(summarize);
    await $("#todo-draft").waitForExist();
    return { addFromSlack };
  }

  it("turns the button into 要約する for a Slack link and opens the summary as a page of the Todo screen to confirm", async () => {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", slackSummary);
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await expect($("#todo-add-button")).toHaveText("要約する");
    await expect($("#todo-add-hint")).toHaveText(expect.stringContaining("Example Team"));
    await expect($("#todo-add-hint")).toHaveText(expect.stringContaining("内容を確かめてから「今日」に追加します"));
    await $("#todo-add-button").click();
    expect(await waitForCalls(summarize)).toEqual([{ url: slackMessageUrl }]);
    await $("#todo-draft").waitForExist();
    await expect($("#todo-add-input")).toHaveValue("");
    // The page replaces the card and the busy row.
    expect(await count(".review, #todo-pending .pending")).toBe(0);
    await expect($("#todo-draft .draft-name")).toHaveValue("Reply to the vendor");
    await expect($("#todo-draft .draft-desc")).toHaveValue(slackSummary.description);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-06");
    await expect($("#todo-draft .draft-project")).toHaveText("インボックス");
    await expect($("#todo-draft .draft-src")).toHaveText(expect.stringContaining("Example Team"));
    // Nothing is created until the user confirms.
    expect(await callsOf(addFromSlack)).toEqual([]);
  });

  it("opens the draft in the place of the list inside the Todo screen, with no dimmed layer and the side menu left, and the back button at the left of the header", async () => {
    await openSummaryCard();
    await expect($("#todo-main > #todo-draft")).toBeDisplayed();
    await expect($("#todo-draft")).not.toHaveAttribute("role");
    await expect($("#todo-draft")).not.toHaveAttribute("aria-modal");
    expect(await count(".scrim")).toBe(0);
    await expect($("#todo-list")).not.toBeDisplayed();
    await expect($("#todo-add")).not.toBeDisplayed();
    await expect($("#todo")).toBeDisplayed();
    await expect($("#sidebar")).toBeDisplayed();
    await expect($("#todo-back")).toBeDisplayed();
    await expect($("#todo-title")).toHaveText("Todo の案");
    const place = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().toJSON(), selector);
    const [back, title, draft, chat] = [await place("#todo-back"), await place("#todo-title"), await place("#todo-draft"), await place("#todo-draft .draft-chat")];
    expect(back.right).toBeLessThanOrEqual(title.left);
    // The Claude pane is the right column of the page.
    expect(chat.left).toBeGreaterThan(draft.left);
    expect(chat.right).toBeLessThanOrEqual(draft.right);
    // The side menu and the projects list are not made inert as a modal would; only the projects list is, so no other list is chosen under the page.
    expect(await browser.execute(() => document.getElementById("sidebar")!.inert || document.getElementById("content")!.inert)).toBe(false);
    expect(await browser.execute(() => document.getElementById("projects")!.inert)).toBe(true);
  });

  it("names the Claude pane Claude, and puts 280px of details beside the name and the description", async () => {
    await openSummaryCard();
    await expect($("#draft-chat .chat-head")).toHaveText(expect.stringContaining("Claude"));
    await expect($("#draft-chat .chat-head")).not.toHaveText(expect.stringContaining("直す"));
    expect(await browser.execute(() => document.querySelector("#todo-draft .detail-side")!.getBoundingClientRect().width)).toBe(280);
  });

  it("shows the workspace and the first line of the linked message in the header row, and opens the message from 'Slack で開く'", async () => {
    await openSummaryCard();
    await expect($("#todo-draft .draft-team")).toHaveText("Example Team");
    await expect($("#todo-draft .draft-quote")).toHaveText(slackSummary.targetText);
    await expect($("#todo-draft .draft-src")).toHaveAttribute("title", slackMessageUrl);
    const open = $("#todo-draft .draft-head a.draft-open");
    await expect(open).toHaveText("Slack で開く");
    await expect(open).toHaveAttribute("href", slackMessageUrl);
    // The link is at the right end of the row, after the message.
    const place = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().toJSON(), selector);
    const [src, link, head] = [await place("#todo-draft .draft-src"), await place("#todo-draft .draft-open"), await place("#todo-draft .draft-head")];
    expect(src.right).toBeLessThanOrEqual(link.left);
    expect(link.right).toBeLessThanOrEqual(head.right);
  });

  it("draws the message as text and cuts what does not fit the row with an ellipsis, keeping the link in the row", async () => {
    await openTodo();
    const long = `<b>bold</b> ${"very long ".repeat(60)}`.trim();
    await mock("todoist_summarize_slack", { ...slackSummary, targetText: long });
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($("#todo-draft .draft-quote")).toHaveText(long);
    expect(await count("#todo-draft .draft-quote b")).toBe(0);
    const row = await browser.execute(() => {
      const q = document.querySelector<HTMLElement>("#todo-draft .draft-quote")!;
      const head = document.querySelector<HTMLElement>("#todo-draft .draft-head")!;
      const open = document.querySelector<HTMLElement>("#todo-draft .draft-open")!;
      return { cut: q.scrollWidth > q.clientWidth, ellipsis: getComputedStyle(q).textOverflow, one: getComputedStyle(q).whiteSpace, inside: open.getBoundingClientRect().right <= head.getBoundingClientRect().right, wide: head.scrollWidth <= head.clientWidth };
    });
    expect(row).toEqual({ cut: true, ellipsis: "ellipsis", one: "nowrap", inside: true, wide: true });
  });

  it("shows only the workspace when the linked message has no text", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", { ...slackSummary, targetText: "" });
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($("#todo-draft .draft-team")).toHaveText("Example Team");
    expect(await count("#todo-draft .draft-quote")).toBe(0);
  });

  describe("the divider of the Claude pane", () => {
    const share = () =>
      browser.execute(() => document.getElementById("draft-chat")!.getBoundingClientRect().width / document.getElementById("todo-draft")!.clientWidth);
    const press = (key: string) =>
      browser.execute(
        (id, k) => window.__e2e_once__(id) && document.getElementById("draft-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })),
        onceId(),
        key,
      );
    const dragTo = (x: number) =>
      browser.execute((at) => {
        const box = document.getElementById("todo-draft")!.getBoundingClientRect();
        const init = (): PointerEventInit => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: box.left + box.width * at, clientY: box.top + 80 });
        document.getElementById("draft-split")!.dispatchEvent(new PointerEvent("pointerdown", init()));
        document.dispatchEvent(new PointerEvent("pointermove", init()));
        document.dispatchEvent(new PointerEvent("pointerup", init()));
      }, x);

    it("is a vertical separator between the draft and the pane, which starts at 40%", async () => {
      await openSummaryCard();
      const split = $("#draft-split");
      await expect(split).toHaveAttribute("role", "separator");
      await expect(split).toHaveAttribute("aria-orientation", "vertical");
      await expect(split).toHaveAttribute("aria-label", "Claude の幅");
      await expect(split).toHaveAttribute("aria-valuemin", "30");
      await expect(split).toHaveAttribute("aria-valuemax", "60");
      await expect(split).toHaveAttribute("aria-valuenow", "40");
      await expect(split).toHaveAttribute("tabindex", "0");
      expect(await share()).toBeCloseTo(0.4, 2);
      const place = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().toJSON(), selector);
      const [todo, bar, chat] = [await place("#todo-draft .draft-todo"), await place("#draft-split"), await place("#draft-chat")];
      expect(todo.right).toBeLessThanOrEqual(bar.left + 1);
      expect(bar.right).toBeLessThanOrEqual(chat.left + 1);
    });

    it("is moved by the arrow keys between 30% and 60%", async () => {
      await openSummaryCard();
      await press("ArrowLeft");
      await press("ArrowLeft");
      expect(await share()).toBeCloseTo(0.44, 2);
      for (let i = 0; i < 20; i++) await press("ArrowLeft");
      expect(await share()).toBeCloseTo(0.6, 2);
      await expect($("#draft-split")).toHaveAttribute("aria-valuenow", "60");
      for (let i = 0; i < 30; i++) await press("ArrowRight");
      expect(await share()).toBeCloseTo(0.3, 2);
      await expect($("#draft-split")).toHaveAttribute("aria-valuenow", "30");
    });

    it("sets the width by dragging, held to 30% and 60%, and starts at 40% again for the next draft", async () => {
      await openSummaryCard();
      await dragTo(0.5);
      expect(await share()).toBeCloseTo(0.5, 2);
      await expect($("#draft-split")).toHaveAttribute("aria-valuenow", "50");
      await dragTo(0.95);
      expect(await share()).toBeCloseTo(0.3, 2);
      await dragTo(0.1);
      expect(await share()).toBeCloseTo(0.6, 2);
      await expect($("#draft-split")).toHaveAttribute("aria-valuenow", "60");
      await $("#todo-draft .draft-drop").click();
      await $("#todo-draft").waitForExist({ reverse: true });
      await mock("todoist_summarize_slack", slackSummary);
      await $("#todo-add-input").setValue(slackMessageUrl);
      await $("#todo-add-button").click();
      await $("#todo-draft").waitForExist();
      await expect($("#draft-split")).toHaveAttribute("aria-valuenow", "40");
      expect(await share()).toBeCloseTo(0.4, 2);
    });
  });

  it("keeps the page over a background refresh of the Todo data", async () => {
    await openSummaryCard();
    await $("#todo-draft .draft-name").setValue("My own name");
    const data = todoData();
    data.tasks[0].content = "Write report v2";
    const load = await mock("todoist_load", data);
    await browser.execute((id) => window.__e2e_once__(id) && document.dispatchEvent(new Event("visibilitychange")), onceId());
    await waitForCalls(load);
    await expect($("#todo-draft")).toBeDisplayed();
    await expect($("#todo-draft .draft-name")).toHaveValue("My own name");
    await expect($("#todo-back")).toBeDisplayed();
    await expect($("#todo-list")).not.toBeDisplayed();
    // The list under the page took the new data: it shows when the page is left.
    await $("#todo-back").click();
    await waitForText("#todo-list", "Write report v2");
  });

  it("puts the name and description on the left and the project, date and labels beside them, with 破棄 at the left and the + at the right of the foot", async () => {
    await openSummaryCard();
    const place = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().toJSON(), selector);
    const [name, side, drop, add] = [await place("#todo-draft .draft-name"), await place("#todo-draft .detail-side"), await place("#todo-draft .draft-drop"), await place("#todo-draft .draft-add")];
    expect(name.right).toBeLessThanOrEqual(side.left);
    expect(drop.right).toBeLessThan(add.left);
    expect(drop.top).toBeGreaterThan(name.bottom);
    await expect($("#todo-draft .detail-side")).toHaveText(expect.stringContaining("プロジェクト"));
    await expect($("#todo-draft .detail-side")).toHaveText(expect.stringContaining("日付"));
    await expect($("#todo-draft .detail-side")).toHaveText(expect.stringContaining("ラベル"));
    await expect($("#todo-draft .draft-drop")).toHaveText("破棄");
    await expect($("#todo-draft .draft-add")).toHaveAttribute("aria-label", "インボックスに追加");
    await expect($("#todo-draft .draft-add svg")).toExist();
  });

  it("keeps the page open on Escape, has no ✕, and goes back to the list with the back button without calling the add command", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $("#todo-draft .draft-name").click();
    await browser.keys("Escape");
    await expect($("#todo-draft")).toExist();
    expect(await count("#todo-draft .draft-close, #todo-draft .icon-btn[aria-label=閉じる]")).toBe(0);
    await $("#todo-back").click();
    await $("#todo-draft").waitForExist({ reverse: true });
    expect(await callsOf(addFromSlack)).toEqual([]);
    await expect($("#todo-list")).toBeDisplayed();
    await expect($("#todo-add")).toBeDisplayed();
    await expect($("#todo-back")).not.toBeDisplayed();
    await expect($("#todo-title")).toHaveText("今日");
    expect(await browser.execute(() => document.getElementById("projects")!.inert)).toBe(false);
    await expect($("#todo-add-input")).toBeEnabled();
  });

  it("waits as a row while a task is open, and opens the page when the list is shown again", async () => {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", holds);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await waitForCalls(summarize);
    await $("#todo-list li.task").click();
    await expect($("#todo-detail")).toBeDisplayed();
    await release(summarize, slackSummary);
    // The task stays open: the draft does not take the screen from it.
    await expect($("#todo-detail")).toBeDisplayed();
    expect(await count("#todo-draft")).toBe(0);
    await $("#todo-back").click();
    await $("#todo-draft").waitForExist();
    await expect($("#todo-draft .draft-name")).toHaveValue("Reply to the vendor");
    expect(await count("#todo-pending .pending")).toBe(0);
  });

  it("opens the next summary when the first page is closed, and shows it as a row until then", async () => {
    await openTodo();
    const summarize = await mock("todoist_summarize_slack", holds);
    await mock("todoist_add_from_slack", "Reply to the vendor");
    for (const url of [slackMessageUrl, `${slackMessageUrl.slice(0, -1)}7`]) {
      await $("#todo-add-input").setValue(url);
      await $("#todo-add-button").click();
    }
    await waitForCalls(summarize, 2);
    await release(summarize, { ...slackSummary, content: "First draft" });
    await expect($("#todo-draft .draft-name")).toHaveValue("First draft");
    await release(summarize, { ...slackSummary, content: "Second draft" });
    await expect($("#todo-pending .pending")).toHaveText(expect.stringContaining("Todo の案ができました"));
    await $("#todo-draft .draft-drop").click();
    await expect($("#todo-draft .draft-name")).toHaveValue("Second draft");
    expect(await count("#todo-pending .pending")).toBe(0);
  });

  it("summarizes a Slack link while an API key is in use", async () => {
    await openTodo(claudeKeyReady);
    const summarize = await mock("todoist_summarize_slack", slackSummary);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await expect($("#todo-add-button")).toHaveText("要約する");
    await $("#todo-add-button").click();
    expect(await waitForCalls(summarize)).toEqual([{ url: slackMessageUrl }]);
    await $("#todo-draft").waitForExist();
    await expect($("#todo-draft .draft-name")).toHaveValue("Reply to the vendor");
  });

  it("adds the summary as it is, to the inbox and due today unless it has a date, when 追加 is pressed", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $("#todo-draft .draft-add").click();
    expect(await waitForCalls(addFromSlack)).toEqual([
      { url: slackMessageUrl, content: "Reply to the vendor", description: slackSummary.description, due: "2026-11-06", projectId: null, today: true },
    ]);
    await $("#todo-draft").waitForExist({ reverse: true });
    await expect($(".toast")).toHaveText(expect.stringContaining("Reply to the vendor"));
  });

  it("sends the name, description, due date and project the user edited", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $("#todo-draft .draft-name").setValue("Answer the vendor by Friday");
    await $("#todo-draft .draft-desc").setValue("- Quote needed");
    await setCardDue("tomorrow");
    await $("#todo-draft .draft-project").click();
    await $('.menu button[role="menuitem"]:nth-child(2)').click();
    await expect($("#todo-draft .draft-project")).toHaveText("Work");
    await $("#todo-draft .draft-add").click();
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
    await $("#todo-draft").waitForExist();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-06 15:00");
    await $("#todo-draft .draft-due").click();
    await expect($(".due-pop .chip-input")).toHaveValue("2026-11-06 15:00");
    await expect($(".due-pop")).toHaveText(expect.stringContaining("2026年11月"));
    await expect($(".due-pop .dp-day.current")).toHaveText("6");
    await dayButton(20).click();
    await expect($(".due-pop")).not.toExist();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-20 15:00");
    // Picking a day saves nothing: the value is only sent with 追加.
    expect(await callsOf(addFromSlack)).toEqual([]);
    await $("#todo-draft .draft-add").click();
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ due: "2026-11-20 15:00" });
  });

  it("keeps no time when the day is picked for a date without one", async () => {
    await openSummaryCard();
    await $("#todo-draft .draft-due").click();
    await dayButton(12).click();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-12");
  });

  it("takes other text in the due popover with Enter, and an empty one means no due date (today in 今日)", async () => {
    const { addFromSlack } = await openSummaryCard();
    await setCardDue("明日 15時");
    await expect($("#todo-draft .draft-due")).toHaveText("明日 15時");
    // The popover shows the text as it is, and a day from the calendar replaces it.
    await $("#todo-draft .draft-due").click();
    await expect($(".due-pop .chip-input")).toHaveValue("明日 15時");
    await browser.keys("Escape");
    await setCardDue("");
    await expect($("#todo-draft .draft-due")).toHaveText("空なら今日");
    await $("#todo-draft .draft-add").click();
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ due: "", today: true });
  });

  it("sends the date and time typed in the due popover when 追加 is pressed without Enter", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $("#todo-draft .draft-due").click();
    await $(".due-pop .chip-input").setValue("2026-11-06 15:00");
    await press($("#todo-draft .draft-add"));
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ due: "2026-11-06 15:00" });
  });

  it("confirms the text typed in the due popover when a click elsewhere closes it", async () => {
    await openSummaryCard();
    await $("#todo-draft .draft-due").click();
    await $(".due-pop .chip-input").setValue("2026-11-06 15:00");
    await press($("#todo-draft .draft-name"));
    await expect($(".due-pop")).not.toExist();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-06 15:00");
  });

  it("cancels the text typed in the due popover with Escape", async () => {
    await openSummaryCard();
    await $("#todo-draft .draft-due").click();
    await $(".due-pop .chip-input").setValue("2026-11-06 15:00");
    await browser.keys("Escape");
    await expect($(".due-pop")).not.toExist();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-06");
    await $("#todo-draft .draft-name").click();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-06");
  });

  it("keeps the time typed in the due popover when another day is picked, and when the same day is picked", async () => {
    await openSummaryCard();
    await $("#todo-draft .draft-due").click();
    await $(".due-pop .chip-input").setValue("2026-11-06 15:00");
    await dayButton(20).click();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-20 15:00");
    await $("#todo-draft .draft-due").click();
    await $(".due-pop .chip-input").setValue("9:30");
    await dayButton(12).click();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-12 09:30");
    await $("#todo-draft .draft-due").click();
    await $(".due-pop .chip-input").setValue("2026-11-12 18:45");
    await dayButton(12).click();
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-12 18:45");
  });

  it("keeps the time typed in Japanese forms in the due popover when a day is picked", async () => {
    await openSummaryCard();
    const pickWith = async (text: string, day: number) => {
      await $("#todo-draft .draft-due").click();
      await $(".due-pop .chip-input").setValue(text);
      await dayButton(day).click();
    };
    await pickWith("15時", 12);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-12 15:00");
    await pickWith("明日 15時30分", 13);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-13 15:30");
    await pickWith("午後3時", 14);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-14 15:00");
    await pickWith("明日午前12時5分", 15);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-15 00:05");
    await pickWith("明日 午後 3時", 16);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-16 15:00");
  });

  it("does not read a time from other forms typed in the due popover", async () => {
    await openSummaryCard();
    const pickWith = async (text: string, day: number) => {
      await $("#todo-draft .draft-due").click();
      await $(".due-pop .chip-input").setValue(text);
      await dayButton(day).click();
    };
    await pickWith("25時", 12);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-12");
    await pickWith("夜8時", 13);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-13");
    await pickWith("15:00:00", 14);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-14");
    await pickWith("PM3:00", 15);
    await expect($("#todo-draft .draft-due")).toHaveText("2026-11-15");
  });

  describe("the Claude pane of the page", () => {
    // Types `text` in the pane's request field and presses the send button.
    const askClaude = async (text: string) => {
      await $("#draft-input").setValue(text);
      await $("#draft-send").click();
    };

    it("sends the left part as it is now with the request, and draws Claude's change as a diff in the pane", async () => {
      await openSummaryCard();
      const edit = await mock("claude_edit_todo_draft", todoDraftEdit);
      await $("#todo-draft .draft-name").setValue("Reply to the vendor today");
      await askClaude("名前を短く");
      const [sent] = await waitForCalls(edit);
      expect(sent).toEqual({ content: "Reply to the vendor today", description: slackSummary.description, history: [], instruction: "名前を短く" });
      await waitForCount("#draft-log .chat-ai", 1);
      await expect($("#draft-log .chat-user")).toHaveText("名前を短く");
      await expect($("#draft-log .chat-ai")).toHaveText(expect.stringContaining("名前を短くします"));
      expect(await textsOf("#draft-log .diff-del")).toEqual(["- Reply to the vendor"]);
      expect(await textsOf("#draft-log .diff-ins")).toEqual(["+ Reply to vendor"]);
      // Nothing is changed on the left, and nothing is added, until 適用.
      await expect($("#todo-draft .draft-name")).toHaveValue("Reply to the vendor today");
    });

    it("puts the change into the left part with 適用, and keeps the other part", async () => {
      await openSummaryCard();
      await mock("claude_edit_todo_draft", todoDraftEdit);
      await askClaude("名前を短く");
      await waitForCount("#draft-log .chat-diff", 1);
      await $("#draft-log .diff-foot .text-btn.primary").click();
      await expect($("#todo-draft .draft-name")).toHaveValue("Reply to vendor");
      await expect($("#todo-draft .draft-desc")).toHaveValue(slackSummary.description);
      await expect($("#draft-log .diff-state")).toHaveText("適用しました");
    });

    it("changes the description alone when Claude proposes only that, and adds what is then on the left", async () => {
      await openSummaryCard();
      await mock("claude_edit_todo_draft", {
        reply: "説明を足します",
        content: null,
        description: "- Asked for a quote",
        contentDiff: [],
        descriptionDiff: [
          { kind: "del", text: "- Wants an answer by Friday" },
        ],
      });
      const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
      await askClaude("期限の行を消して");
      await waitForCount("#draft-log .chat-diff", 1);
      await $("#draft-log .diff-foot .text-btn.primary").click();
      await expect($("#todo-draft .draft-name")).toHaveValue("Reply to the vendor");
      await expect($("#todo-draft .draft-desc")).toHaveValue("- Asked for a quote");
      await $("#todo-draft .draft-add").click();
      const [sent] = await waitForCalls(addFromSlack);
      expect(sent).toMatchObject({ content: "Reply to the vendor", description: "- Asked for a quote" });
    });

    it("leaves the left part as it is with 却下", async () => {
      await openSummaryCard();
      await mock("claude_edit_todo_draft", todoDraftEdit);
      await askClaude("名前を短く");
      await waitForCount("#draft-log .chat-diff", 1);
      await $("#draft-log .diff-foot .text-btn:not(.primary)").click();
      await expect($("#draft-log .diff-state")).toHaveText("却下しました");
      await expect($("#todo-draft .draft-name")).toHaveValue("Reply to the vendor");
      await expect($("#todo-draft .draft-desc")).toHaveValue(slackSummary.description);
    });

    it("cannot apply a change once the left part was edited by hand, as in the thread pane", async () => {
      await openSummaryCard();
      await mock("claude_edit_todo_draft", todoDraftEdit);
      await askClaude("名前を短く");
      await waitForCount("#draft-log .chat-diff", 1);
      await $("#todo-draft .draft-desc").setValue("- Edited by hand");
      await expect($("#draft-log .diff-foot .text-btn.primary")).toBeDisabled();
      await expect($("#draft-log .diff-stale")).toBeDisplayed();
      await expect($("#todo-draft .draft-name")).toHaveValue("Reply to the vendor");
    });

    it("cannot apply a change while the Todo is being added, and can again when the add failed", async () => {
      await openSummaryCard();
      await mock("claude_edit_todo_draft", todoDraftEdit);
      const addFromSlack = await mock("todoist_add_from_slack", holds);
      await askClaude("名前を短く");
      await waitForCount("#draft-log .chat-diff", 1);
      await expect($("#draft-log .diff-foot .text-btn.primary")).toBeEnabled();
      await $("#todo-draft .draft-add").click();
      await waitForCalls(addFromSlack);
      await expect($("#draft-log .diff-foot .text-btn.primary")).toBeDisabled();
      await release(addFromSlack, rejects("todoist failed"));
      await expect($("#todo-draft .draft-err")).toBeDisplayed();
      await expect($("#draft-log .diff-foot .text-btn.primary")).toBeEnabled();
    });

    it("sends the conversation so far with the next request, and forgets it when the page is closed", async () => {
      await openSummaryCard();
      const edit = await mock("claude_edit_todo_draft", todoDraftEdit);
      await askClaude("名前を短く");
      await waitForCount("#draft-log .chat-ai", 1);
      await askClaude("もう一度");
      await browser.waitUntil(async () => (await callsOf(edit)).length === 2);
      expect((await callsOf(edit))[1]).toMatchObject({ history: [{ role: "user", text: "名前を短く" }, { role: "assistant", text: "名前を短くします" }], instruction: "もう一度" });
      await $("#todo-draft .draft-drop").click();
      await $("#todo-draft").waitForExist({ reverse: true });
      await mock("todoist_summarize_slack", slackSummary);
      await $("#todo-add-input").setValue(slackMessageUrl);
      await $("#todo-add-button").click();
      await $("#todo-draft").waitForExist();
      expect(await count("#draft-log > *")).toBe(0);
    });

    it("shows a failure in the pane and keeps the draft as it is", async () => {
      await openSummaryCard();
      await mock("claude_edit_todo_draft", rejects("claude failed"));
      await askClaude("名前を短く");
      await waitForCount("#draft-log .pending.fail", 1);
      await expect($("#draft-log .pending.fail")).toHaveText(expect.stringContaining("claude failed"));
      await expect($("#todo-draft .draft-name")).toHaveValue("Reply to the vendor");
      await expect($("#draft-send")).toBeEnabled();
    });

    it("sends with Cmd+Enter in the request field and does not add the Todo", async () => {
      await openSummaryCard();
      const edit = await mock("claude_edit_todo_draft", todoDraftEdit);
      const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
      await $("#draft-input").setValue("名前を短く");
      await browser.execute((id) => {
        if (!window.__e2e_once__(id)) return;
        const mac = /Mac/.test(navigator.platform);
        document.getElementById("draft-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
      }, onceId());
      await waitForCalls(edit);
      await waitForCount("#draft-log .chat-ai", 1);
      expect(await callsOf(addFromSlack)).toEqual([]);
      await expect($("#todo-draft")).toExist();
    });

    it("has the Slack summary's model and effort and the send button in the frame of the request field, and shows a note while Claude cannot be used", async () => {
      await openSummaryCard();
      expect(await composerLayout("draft")).toEqual({ framed: [true, true, true], modelBelowInput: true, sendRightOfModel: true, sendInsideFrame: true, sendRadius: "50%", placeholder: null });
      await expect($("#draft-input")).not.toHaveAttribute("placeholder");
      await expect($("#draft-model select[data-kind=model]")).toHaveValue("sonnet");
      await expect($("#draft-model select[data-kind=effort]")).toHaveValue("medium");
      const save = await mock("claude_model_settings_save", { ...claudeSettings, slackSummary: { model: "opus", effort: "medium" } });
      // Sets the select as the user does (value, then change); the real WebView's select popup is not driven (todo-prompt.e2e.ts does the same).
      await browser.execute(
        (id) => {
          if (!window.__e2e_once__(id)) return;
          const select = document.querySelector<HTMLSelectElement>("#draft-model select[data-kind=model]")!;
          select.value = "opus";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        },
        onceId(),
      );
      const [saved] = await waitForCalls(save);
      expect(saved).toEqual({ purpose: "slackSummary", model: "opus" });
      await expect($("#draft-chat-note")).not.toBeDisplayed();
    });

    // Claude must be usable for the summary to open the page, so the state changes after it: on the settings screen, while the page waits in the document.
    it("turns the request field off and says so when Claude is disconnected while another screen is shown, and back on when it is connected again", async () => {
      await openSummaryCard();
      await expect($("#draft-chat-note")).not.toBeDisplayed();
      await $("#nav-settings").click();
      await $("#settings-tab-claude").click();
      await mock("claude_connection", connection("subscription", claudeMissing, { state: "none" }));
      await $("#claude-recheck").click();
      // The pane follows at once, also while another screen is shown.
      await browser.waitUntil(async () => !(await $("#draft-chat-note").getProperty("hidden")));
      await $("#nav-todo").click();
      await $("#todo-draft").waitForDisplayed();
      await expect($("#draft-chat-note")).toBeDisplayed();
      await expect($("#draft-input")).toBeDisabled();
      await expect($("#draft-send")).toBeDisabled();
      await $("#nav-settings").click();
      await mock("claude_connection", connection("subscription", claudeReady, { state: "none" }));
      await $("#claude-recheck").click();
      await $("#nav-todo").click();
      await $("#todo-draft").waitForDisplayed();
      await expect($("#draft-chat-note")).not.toBeDisplayed();
      await expect($("#draft-input")).toBeEnabled();
    });
  });

  it("says 期限なし on the date field when the draft is for a project and the date is empty", async () => {
    await openTodo();
    await $('#projects .proj[data-view="p1"]').click();
    await mock("todoist_summarize_slack", { ...slackSummary, due: null });
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($("#todo-draft .draft-due")).toHaveText("期限なし");
  });

  it("tells on the page how many messages of the thread the summary leaves out, and does not send the count on", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", { ...slackSummary, omitted: 12 });
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($("#todo-draft .draft-omitted")).toHaveText("12 件のメッセージは要約に含まれていません");
    await $("#todo-draft .draft-add").click();
    const [sent] = await waitForCalls(addFromSlack);
    expect(sent).not.toHaveProperty("omitted");
  });

  it("shows no note on the page when the summary reflects the whole thread", async () => {
    await openSummaryCard();
    await expect($("#todo-draft .draft-omitted")).not.toExist();
    await expect($("#todo-draft .draft-target-cut")).not.toExist();
  });

  it("tells on the page that the linked message was cut, and does not send the flag on", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", { ...slackSummary, targetCut: true });
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($("#todo-draft .draft-target-cut")).toHaveText("対象のメッセージは長いため、先頭だけを要約しました");
    await $("#todo-draft .draft-add").click();
    const [sent] = await waitForCalls(addFromSlack);
    expect(sent).not.toHaveProperty("targetCut");
  });

  it("starts the page in the project Claude recommended, tagged 推奨 on the field and in the menu", async () => {
    const { addFromSlack } = await openRecommendedCard("p1");
    await expect($("#todo-draft .draft-project")).toHaveText(expect.stringContaining("Work"));
    await expect($("#todo-draft .draft-project .tag")).toHaveText("推奨");
    await $("#todo-draft .draft-project").click();
    await expect($('.menu button[role="menuitem"]:nth-child(2) .tag')).toHaveText("推奨");
    await expect($('.menu button[role="menuitem"]:nth-child(2)')).toHaveAttribute("aria-current", "true");
    expect(await count(".menu .tag")).toBe(1);
    await browser.keys("Escape");
    await $("#todo-draft .draft-add").click();
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ projectId: "p1" });
  });

  it("takes the tag off the chip when another project is chosen, keeps it on the menu row, and adds to the chosen one", async () => {
    const { addFromSlack } = await openRecommendedCard("p1");
    await $("#todo-draft .draft-project").click();
    await $('.menu button[role="menuitem"]:nth-child(5)').click();
    await expect($("#todo-draft .draft-project")).toHaveText("Home");
    await expect($("#todo-draft .draft-project .tag")).not.toExist();
    await $("#todo-draft .draft-project").click();
    await expect($('.menu button[role="menuitem"]:nth-child(2) .tag')).toHaveText("推奨");
    await expect($('.menu button[role="menuitem"]:nth-child(5)')).toHaveAttribute("aria-current", "true");
    await browser.keys("Escape");
    await $("#todo-draft .draft-add").click();
    expect((await waitForCalls(addFromSlack))[0]).toMatchObject({ projectId: "p4" });
  });

  it("puts the tag back on the chip when the recommended project is chosen again", async () => {
    await openRecommendedCard("p1");
    await $("#todo-draft .draft-project").click();
    await $('.menu button[role="menuitem"]:nth-child(5)').click();
    await $("#todo-draft .draft-project").click();
    await $('.menu button[role="menuitem"]:nth-child(2)').click();
    await expect($("#todo-draft .draft-project .tag")).toHaveText("推奨");
  });

  it("ignores a recommendation that is not a project in the list, and the page starts where it would", async () => {
    await openRecommendedCard("p9");
    await expect($("#todo-draft .draft-project")).toHaveText("インボックス");
    await expect($("#todo-draft .draft-project .tag")).not.toExist();
  });

  it("adds with Enter in the name field", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $("#todo-draft .draft-name").click();
    await browser.keys("Enter");
    await waitForCalls(addFromSlack);
  });

  // Focus is not checked: WebDriver's click leaves the focus on the clicked button in the hidden E2E window.
  it("adds nothing and keeps the page when the name is empty", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $("#todo-draft .draft-name").setValue("");
    await $("#todo-draft .draft-add").click();
    await expect($("#todo-draft .draft-add")).toBeEnabled();
    expect(await callsOf(addFromSlack)).toEqual([]);
  });

  it("closes the page with 破棄 and creates nothing", async () => {
    const { addFromSlack } = await openSummaryCard();
    await $("#todo-draft .draft-drop").click();
    await $("#todo-draft").waitForExist({ reverse: true });
    expect(await callsOf(addFromSlack)).toEqual([]);
  });

  it("keeps what the user typed on the page, with the error, when the add fails", async () => {
    const { addFromSlack } = await openSummaryCard();
    await mock("todoist_add_from_slack", rejects("Todoist に接続できません"));
    await $("#todo-draft .draft-name").setValue("My own name");
    await $("#todo-draft .draft-add").click();
    await expect($("#todo-draft .draft-err")).toHaveText(expect.stringContaining("Todoist に接続できません"));
    await expect($("#todo-draft .draft-name")).toHaveValue("My own name");
    await expect($("#todo-draft .draft-desc")).toHaveValue(slackSummary.description);
    await expect($("#todo-draft .draft-add")).toBeEnabled();
    await expect($("#todo-draft .draft-add")).toHaveAttribute("aria-label", "インボックスに追加");
    await expect($("#todo-draft .draft-add .spin")).not.toExist();
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

  it("shows a spinner on the page's add button while the Slack task is being added, and 破棄 and the back button stay disabled", async () => {
    const { addFromSlack } = await openSummaryCard();
    await mock("todoist_add_from_slack", holds);
    await $("#todo-draft .draft-add").click();
    await waitForCalls(addFromSlack);
    await expect($("#todo-draft .draft-add")).toHaveAttribute("aria-label", "追加中");
    await expect($("#todo-draft .draft-add .spin")).toExist();
    await expect($("#todo-draft .draft-add")).toBeDisabled();
    await expect($("#todo-draft .draft-drop")).toBeDisabled();
    await expect($("#todo-back")).toBeDisabled();
    await release(addFromSlack, "Reply to the vendor");
    await $("#todo-draft").waitForExist({ reverse: true });
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
    expect(await textsOf("#projects .proj .name")).toEqual(["インボックス", "今日", "Work", "Design", "Sketch", "Home"]);
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
    fresh.tasks.push({ ...fresh.tasks[0], id: "k5", content: "Fresh", due: null, bucket: "none", dueAt: null });
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
    for (const g of document.querySelectorAll<HTMLElement>("#todo-list .grip, #todo-detail .grip")) g.style.visibility = "visible";
  });

// Drags the grip of the row that `source` finds with the pointer (press, move over each of `over`, release).
async function dragFrom(source: () => ChainablePromiseElement, ...over: ChainablePromiseElement[]) {
  const drag = async () => {
    await showGrips();
    let action = browser.action("pointer").move({ origin: source().$(".grip") }).down();
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

// Drags the grip of the row `name` in the task list.
const dragRow = (name: string, ...over: ChainablePromiseElement[]) => dragFrom(() => rowOf(name), ...over);

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

// A-23: the list of projects is closed and opened by a button. Where the button is, and the width the tasks take.
describe("todo: closing the list of projects (A-23)", () => {
  const rect = (selector: string) => browser.execute((q) => {
    const r = document.querySelector(q)!.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  }, selector);

  it("has the button first in the list when it is open, and none in the header", async () => {
    await openTodo();
    const button = $("#projects-toggle");
    await expect(button).toBeDisplayed();
    await expect(button).toHaveAttribute("aria-label", "プロジェクト一覧");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await browser.execute(() => document.getElementById("projects-toggle")!.className)).toContain("icon-btn list-toggle");
    expect(await browser.execute(() => document.getElementById("projects")!.firstElementChild!.id)).toBe("projects-toggle");
    await expect($("#todo-list-toggle")).not.toBeDisplayed();
    // At the top left of the list.
    const [toggle, list] = await Promise.all(["#projects-toggle", "#projects"].map(rect));
    expect(toggle.left - list.left).toBeLessThan(20);
    expect(toggle.top - list.top).toBeLessThan(40);
    // A press on it is not a drag of the window (the band is the header, and the button is not in it).
    await expect(button).not.toHaveAttribute("data-tauri-drag-region");
  });

  it("closes the list, widens the tasks to its width, and puts the button at the left of the heading", async () => {
    await openTodo();
    const [listBefore, bodyBefore] = await Promise.all(["#projects", "#todo-body"].map(rect));
    await $("#projects-toggle").click();
    await expect($("#projects")).not.toBeDisplayed();
    const [screen, body] = await Promise.all(["#todo", "#todo-body"].map(rect));
    expect(body.left).toBeCloseTo(screen.left, 0);
    expect(body.width).toBeCloseTo(bodyBefore.width + listBefore.width, 0);
    // The button is first in the header, beside the heading and at its left.
    const closed = $("#todo-list-toggle");
    await expect(closed).toBeDisplayed();
    await expect(closed).toHaveAttribute("aria-expanded", "false");
    await expect(closed).toHaveAttribute("aria-label", "プロジェクト一覧");
    expect(await browser.execute(() => document.querySelector("#todo-body > header")!.firstElementChild!.id)).toBe("todo-list-toggle");
    const [button, title, header] = await Promise.all(["#todo-list-toggle", "#todo-title", "#todo-body > header"].map(rect));
    expect(button.right).toBeLessThanOrEqual(title.left);
    expect(button.left).toBeGreaterThanOrEqual(header.left);
    // Level with the heading.
    expect(Math.abs((button.top + button.bottom) / 2 - (title.top + title.bottom) / 2)).toBeLessThan(6);
    // Still a button of the band: a press on it does not move the window.
    await expect(closed).not.toHaveAttribute("data-tauri-drag-region");
    // The green column stays.
    await expect($("#sidebar")).toBeDisplayed();
    await closed.click();
    await expect($("#projects")).toBeDisplayed();
    await expect($("#todo-list-toggle")).not.toBeDisplayed();
    await expect($("#projects-toggle")).toHaveAttribute("aria-expanded", "true");
    expect((await rect("#projects")).width).toBeCloseTo(listBefore.width, 0);
  });

  it("keeps the projects and their counts when the list is drawn again, and the button with them", async () => {
    await openTodo();
    await waitForText("#projects .proj .name", "Work");
    await $("#projects-toggle").click();
    await $("#todo-list-toggle").click();
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount("#todo-list li.task", 2);
    expect(await count("#projects #projects-toggle")).toBe(1);
    expect(await browser.execute(() => document.getElementById("projects")!.firstElementChild!.id)).toBe("projects-toggle");
  });

  it("keeps the list closed while the screen is left and shown again, and shows it open when the app starts", async () => {
    await openTodo();
    await $("#projects-toggle").click();
    await expect($("#projects")).not.toBeDisplayed();
    await $("#nav-mail").click();
    await $("#nav-todo").click();
    await expect($("#todo")).toBeDisplayed();
    await expect($("#projects")).not.toBeDisplayed();
    await expect($("#todo-list-toggle")).toBeDisplayed();
    // Nothing is saved: a start gives the open list.
    await openTodo();
    await expect($("#projects")).toBeDisplayed();
    await expect($("#todo-list-toggle")).not.toBeDisplayed();
    await expect($("#projects-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("gives the focus to the button that is shown after a press", async () => {
    await openTodo();
    await $("#projects-toggle").click();
    await browser.execute(() => document.getElementById("todo-list-toggle")!.focus());
    // The harness's synthesized Enter does not run the default action of a button (the keydown and keyup come, the keypress does not), so the focused button is clicked, as the keyboard would.
    await browser.execute(() => (document.activeElement as HTMLElement).click());
    await expect($("#projects")).toBeDisplayed();
    expect(await browser.execute(() => document.activeElement?.id)).toBe("projects-toggle");
    await browser.execute(() => (document.activeElement as HTMLElement).click());
    await expect($("#projects")).not.toBeDisplayed();
    expect(await browser.execute(() => document.activeElement?.id)).toBe("todo-list-toggle");
  });

  it("still takes a task dropped on a project (T-2) after the list was closed and opened again", async () => {
    await openTodo();
    await $("#projects-toggle").click();
    await $("#todo-list-toggle").click();
    const move = await mock("todoist_move", true);
    await dragRow("Write report", projectOf("p2"));
    expect(await waitForCalls(move)).toEqual([{ id: "k1", projectId: "p2" }]);
  });
});

describe("todo: the rows of the list in three lines", () => {
  // Today's list with three tasks: one with a description, a label, subtasks and a time, one overdue with a plain description, and a bare one.
  const rowsData = () => {
    const full = { ...task("k1", "Write report", "p1", "today"), description: "\n  \nhttps://example.com/pr/17 \nsecond line", labels: ["Errand"], subDone: 1, subTotal: 2 };
    const late = { ...task("k5", "Pay rent", "p4", "overdue"), description: "plain first line\nnext" };
    const bare = task("k6", "Water plants", "p4", "today");
    return { ...todoData(), tasks: [dueToday(full, "13:45"), late, bare] };
  };
  async function openRows(data = rowsData()) {
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await waitForCount(ROWS, data.tasks.length);
  }
  // What a row holds, by line: the second line's text and whether it is underlined, the chips of the third line and the project at its right end.
  const linesOf = (name: string) =>
    browser.execute((n) => {
      const li = [...document.querySelectorAll<HTMLElement>("#todo-list li.task")].find((l) => l.querySelector(".tname")!.textContent === n)!;
      const desc = li.querySelector<HTMLElement>(".desc");
      const meta = li.querySelector<HTMLElement>(".meta");
      const top = (el: Element | null) => el?.getBoundingClientRect().top ?? null;
      return {
        desc: desc?.textContent ?? null,
        underlined: desc ? getComputedStyle(desc).textDecorationLine : null,
        chips: [...li.querySelectorAll(".meta .chips > *")].map((c) => `${c.className}:${c.textContent}`),
        project: li.querySelector(".meta .ptag")?.textContent ?? null,
        hasMeta: !!meta,
        order: [top(li.querySelector(".tname")), top(desc), top(meta)],
        due: li.querySelector(".due") ? getComputedStyle(li.querySelector(".due")!).color : null,
      };
    }, name);

  it("draws the name, the first line of the description that is not empty, and the due moment, labels, subtask count and project", async () => {
    await openRows();
    const full = await linesOf("Write report");
    expect(full.desc).toBe("https://example.com/pr/17");
    expect(full.chips).toEqual(["due:13:45", "label:Errand", "subcount:1/2"]);
    expect(full.project).toBe("Work");
    const [name, desc, meta] = full.order as number[];
    expect(name).toBeLessThan(desc);
    expect(desc).toBeLessThan(meta);
  });

  it("underlines a description line that begins with http:// or https://, and only that", async () => {
    await openRows();
    expect((await linesOf("Write report")).underlined).toBe("underline");
    const plain = await linesOf("Pay rent");
    expect(plain.desc).toBe("plain first line");
    expect(plain.underlined).toBe("none");
    await expect(rowOf("Write report").$(".desc a")).not.toExist();
  });

  it("opens the task when the description line is pressed, as the rest of the row does", async () => {
    await openRows();
    await rowOf("Write report").$(".desc").click();
    await expect($("#todo-detail")).toBeDisplayed();
    await expect($("#todo-detail .name")).toHaveValue("Write report");
  });

  it("has no second line without a description, and no third line without anything for it in a project's list", async () => {
    await openRows();
    const bare = await linesOf("Water plants");
    expect(bare.desc).toBeNull();
    expect(bare.chips).toEqual(["due:今日"]);
    expect(bare.project).toBe("Home");
    const data = todoData();
    data.tasks = [task("k7", "Quiet note", "p1", "none"), dueToday(task("k1", "Write report", "p1", "today"), "13:45")];
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount(ROWS, 2);
    const quiet = await linesOf("Quiet note");
    expect(quiet.desc).toBeNull();
    expect(quiet.hasMeta).toBe(false);
    expect((await linesOf("Write report")).project).toBeNull();
  });

  it("draws the due moment of an overdue task in red and the others in another color", async () => {
    await openRows();
    const late = (await linesOf("Pay rent")).due;
    expect(late).toBe("rgb(176, 0, 32)");
    expect((await linesOf("Write report")).due).not.toBe(late);
    expect((await linesOf("Water plants")).due).not.toBe(late);
  });

  it("keeps the project at the right end of the third line and cuts a long name with an ellipsis", async () => {
    const data = rowsData();
    data.tasks[0].content = "A very long name ".repeat(30);
    await openRows(data);
    const cut = await browser.execute(() => {
      const li = [...document.querySelectorAll<HTMLElement>("#todo-list li.task")].find((l) => l.querySelector(".tname")!.textContent!.startsWith("A very long"))!;
      const name = li.querySelector<HTMLElement>(".tname")!;
      const row = li.getBoundingClientRect();
      const project = li.querySelector(".ptag")!.getBoundingClientRect();
      return { clipped: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, inside: name.getBoundingClientRect().right <= row.right, atEnd: row.right - project.right < 24 };
    });
    expect(cut).toEqual({ clipped: true, ellipsis: "ellipsis", inside: true, atEnd: true });
  });

  it("shows the row buttons over the top right of the row, away from the third line", async () => {
    await openRows();
    const placed = await browser.execute(() => {
      const li = [...document.querySelectorAll<HTMLElement>("#todo-list li.task")].find((l) => l.querySelector(".tname")!.textContent === "Write report")!;
      const actions = li.querySelector<HTMLElement>(".row-actions")!;
      // The driver never hovers: show them as the hover does.
      actions.style.visibility = "visible";
      const [a, r, m] = [actions.getBoundingClientRect(), li.getBoundingClientRect(), li.querySelector(".meta")!.getBoundingClientRect()];
      return { atTop: a.top >= r.top, atRight: r.right - a.right < 24, clear: a.bottom <= m.top, position: getComputedStyle(actions).position };
    });
    expect(placed).toEqual({ atTop: true, atRight: true, clear: true, position: "absolute" });
  });

  it("parts the rows of a group with a thin line, the last one of each group without", async () => {
    await openRows();
    // The overdue group holds one row, today's two.
    const lines = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#todo-list li.task")].map((li) => getComputedStyle(li).borderBottomWidth));
    expect(lines).toEqual(["0px", "1px", "0px"]);
  });
});

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
    data.tasks[1].dueAt = data.tasks[0].dueAt;
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
    expect(await textsOf("#todo-detail .detail-side .field-label")).toEqual(["プロジェクト", "日付", "ラベル"]);
    expect(await textsOf("#todo-detail .detail-side .field-value")).toEqual(["Work", "今日"]);
    await expect($("#todo-detail .chip")).not.toExist();
    await expect($("#todo-detail")).not.toHaveText(expect.stringContaining("優先度"));
  });

  it("puts the side pane under the body when the body column would be narrower than 320px", async () => {
    await openTodo();
    await $(ROWS).click();
    const place = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().toJSON(), selector);
    // The 1200px window with the project list and the right pane (30%) open leaves the detail less than 556px (320 + 16 + 220).
    const [detail, main, side] = [await place("#todo-detail"), await place("#todo-detail .detail-main"), await place("#todo-detail .detail-side")];
    expect(detail.width).toBeLessThan(556);
    expect(main.width).toBeGreaterThanOrEqual(320);
    expect(side.top).toBeGreaterThanOrEqual(main.bottom);
    expect(side.width).toBe(220);
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
    expect(await textsOf(".menu button")).toEqual(["インボックス", "Work", "Design", "Sketch", "Home"]);
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

  it("puts the due Rust answers for the typed text on the task at once, and leaves the task alone for text Todoist reads", async () => {
    const data = todoData();
    data.tasks[0] = dueToday(data.tasks[0], "09:00");
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    // A load that never answers: only the answer of todoist_picked_due can change the row.
    await mock("todoist_load", holds);
    const update = await mock("todoist_update", true);
    const picked = await mock("todoist_picked_due", { due: { date: today, time: "18:00", string: `${today} 18:00`, recurring: false }, bucket: "today", dueAt: 1 });
    await $(ROWS).click();
    await expect($("#todo-detail .field:nth-child(2) .field-value")).toHaveText("09:00");
    await $("#todo-detail .field:nth-child(2) .field-value").click();
    await $(".due-pop .chip-input").setValue(`${today} 18:00`);
    await browser.keys("Enter");
    expect(await waitForCalls(update)).toEqual([{ id: "k1", dueString: `${today} 18:00` }]);
    expect(await callsOf(picked)).toEqual([{ text: `${today} 18:00` }]);
    await expect($("#todo-detail .field:nth-child(2) .field-value")).toHaveText("18:00");
    // Rust answers null for other text: the due stays as it is until the reload.
    await mock("todoist_picked_due", null);
    await $("#todo-detail .field:nth-child(2) .field-value").click();
    await $(".due-pop .chip-input").setValue("明日");
    await browser.keys("Enter");
    await waitForCalls(update, 2);
    await expect($("#todo-detail .field:nth-child(2) .field-value")).toHaveText("18:00");
  });

  it("saves the due text typed in the side pane when a click elsewhere closes the popover", async () => {
    await openTodo();
    const update = await mock("todoist_update", true);
    await $(ROWS).click();
    await $("#todo-detail .field:nth-child(2) .field-value").click();
    await $(".due-pop .chip-input").setValue("2026-11-06 15:00");
    await press($("#todo-detail .detail-side .field-label"));
    expect(await waitForCalls(update)).toEqual([{ id: "k1", dueString: "2026-11-06 15:00" }]);
  });

  it("saves the due text and still does what the click elsewhere pressed", async () => {
    await openTask("Book flights");
    const update = await mock("todoist_update", true);
    await $("#todo-detail .field:nth-child(2) .field-value").click();
    await $(".due-pop .chip-input").setValue("2026-11-06 15:00");
    await press($("#todo-detail .parent-link"));
    await expect($("#todo-detail .name")).toHaveValue("Plan trip");
    expect((await waitForCalls(update))[0]).toMatchObject({ dueString: "2026-11-06 15:00" });
  });

  it("keeps a repeat when its field is emptied and a click elsewhere closes the popover", async () => {
    const data = todoData();
    data.tasks[0].due = { date: today, time: null, string: "every day", recurring: true };
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    const update = await mock("todoist_update", true);
    await $("#todo-detail .field:nth-child(2) .field-value").click();
    await $(".due-pop .chip-input").clearValue();
    await press($("#todo-detail .detail-side .field-label"));
    await expect($(".due-pop")).not.toExist();
    expect(await callsOf(update)).toEqual([]);
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
  it("has no Claude icon for the summary prompt in the heading: the prompt is opened from the Claude tab of the settings only", async () => {
    await openTodo();
    expect(await count("#todo-prompt")).toBe(0);
    await $(ROWS).click();
    await expect($("#todo-back")).toBeDisplayed();
    expect(await count("#todo-prompt")).toBe(0);
  });

  it("has no way to the prompt screen on the page of a draft", async () => {
    await openTodo();
    await mock("todoist_summarize_slack", slackSummary);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    expect(await count("#todo-draft .draft-prompt")).toBe(0);
    await expect($("#todo-draft")).not.toHaveText(expect.stringContaining("プロンプトを編集"));
    await expect($("#prompt")).not.toBeDisplayed();
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

  it("shows the 編集 button (a pencil and the word) only in a task's detail, and the screen has no reload, disconnect or trash button", async () => {
    await openTodo();
    await expect($(more)).not.toBeDisplayed();
    await expect($(more)).toHaveAttribute("aria-label", "編集");
    await expect($(more)).toHaveAttribute("aria-haspopup", "menu");
    expect(await count("#todo-reload, #todo-disconnect, #todo-delete")).toBe(0);
    await $(ROWS).click();
    await expect($(more)).toBeDisplayed();
    await expect($(more)).toHaveText("編集");
    expect(await count(`${more} svg`)).toBe(1);
    expect(await count(`${more} svg path`)).toBe(2);
    // As high as the other buttons of the header, which keep their size: the band does not grow.
    const sizes = await browser.execute(() => {
      const h = (q: string) => document.querySelector(q)!.getBoundingClientRect().height;
      return [h("#todo-more"), h("#todo-back"), h("#todo-body > header")];
    });
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[2]).toBeLessThanOrEqual(42);
    await $(more).click();
    await expect($(items)).toBeDisplayed();
    await expect($(more)).toHaveAttribute("aria-expanded", "true");
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

  it("rules the cells of a table in the description", async () => {
    const data = todoData();
    data.tasks[0].description = "| a | b |\n|---|---|\n| 1 | 2 |";
    await openReport(data);
    for (const cell of ["th", "td"]) {
      const border = await browser.execute((s) => getComputedStyle(document.querySelector(s)!).borderTopWidth, `#todo-detail .desc ${cell}`);
      expect(border).toBe("1px");
    }
  });

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

describe("todo detail description fold", () => {
  const desc = "#todo-detail .desc";
  const fold = "#todo-detail .desc-fold";
  // A list of `n` items, one drawn line each.
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `- line ${i + 1}`).join("\n");

  // `n` lines in paragraphs of `size` lines each, separated by blank lines: the margins between paragraphs are not lines.
  const paragraphs = (n: number, size: number) =>
    Array.from({ length: Math.ceil(n / size) }, (_, p) =>
      Array.from({ length: Math.min(size, n - p * size) }, (_, i) => `line ${p * size + i + 1}`).join("\n"),
    ).join("\n\n");

  async function openReport(n: number, text = lines(n)) {
    const data = todoData();
    data.tasks[0].description = text;
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await expect($(desc)).toBeDisplayed();
  }

  // The height of the description as drawn, and the height of its whole text.
  const heights = () => browser.execute(() => {
    const view = document.querySelector<HTMLElement>("#todo-detail .desc")!;
    return { shown: view.clientHeight, whole: view.scrollHeight };
  });

  it("folds a description longer than 10 lines, with the button and the lines left", async () => {
    await openReport(15);
    await expect($(fold)).toBeDisplayed();
    await expect($(fold)).toHaveText("… 続きを表示（残り 5 行）");
    await expect($(desc)).toHaveElementClass("folded");
    const { shown, whole } = await heights();
    expect(shown).toBeLessThan(whole);
    const fade = await browser.execute(() => getComputedStyle(document.querySelector("#todo-detail .desc")!).webkitMaskImage);
    expect(fade).toContain("linear-gradient");
  });

  it("shows the whole text with the button, which then reads 折りたたむ, and folds it back", async () => {
    await openReport(15);
    // The fold is drawn once the line count is made, after the first draw.
    await expect($(fold)).toBeDisplayed();
    const folded = (await heights()).shown;
    await $(fold).click();
    await expect($(fold)).toHaveText("折りたたむ");
    await expect($(desc)).not.toHaveElementClass("folded");
    const open = await heights();
    expect(open.shown).toBe(open.whole);
    expect(open.shown).toBeGreaterThan(folded);
    await $(fold).click();
    await expect($(fold)).toHaveText("… 続きを表示（残り 5 行）");
    expect((await heights()).shown).toBe(folded);
  });

  it("shows a description of 10 lines in full, with no button", async () => {
    await openReport(10);
    expect(await count(fold)).toBe(1);
    await expect($(fold)).not.toBeDisplayed();
    await expect($(desc)).not.toHaveElementClass("folded");
    const { shown, whole } = await heights();
    expect(shown).toBe(whole);
  });

  it("shows 10 drawn lines in paragraphs in full, with no button", async () => {
    await openReport(10, "line 1\nline 2\nline 3\n\nline 4\nline 5\nline 6\n\nline 7\nline 8\n\nline 9\nline 10");
    // Past the first draw, in which the lines are counted.
    await browser.pause(300);
    await expect($(fold)).not.toBeDisplayed();
    await expect($(desc)).not.toHaveElementClass("folded");
    const { shown, whole } = await heights();
    expect(shown).toBe(whole);
  });

  it("folds 15 drawn lines in paragraphs below the 10th line, which shows whole, and not the 11th", async () => {
    await openReport(15, paragraphs(15, 3));
    await expect($(fold)).toBeDisplayed();
    await expect($(fold)).toHaveText("… 続きを表示（残り 5 行）");
    const edges = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>("#todo-detail .desc")!;
      const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const at = (text: string) => {
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent!.trim() !== text) continue;
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          walker.currentNode = view;
          return { top: r.top, bottom: r.bottom };
        }
        return null;
      };
      return { view: view.getBoundingClientRect().bottom, tenth: at("line 10"), eleventh: at("line 11") };
    });
    expect(edges.tenth!.bottom).toBeLessThanOrEqual(edges.view + 0.5);
    expect(edges.eleventh!.top).toBeGreaterThanOrEqual(edges.view - 0.5);
    await $(fold).click();
    await expect($(fold)).toHaveText("折りたたむ");
    const open = await heights();
    expect(open.shown).toBe(open.whole);
  });

  it("still opens the editor on a press of the text of a folded description", async () => {
    await openReport(15);
    await expect($(desc)).toHaveElementClass("folded");
    await $(desc).click();
    await expect($("#todo-detail .desc-edit")).toBeDisplayed();
    await expect($("#todo-detail .desc-edit")).toHaveValue(lines(15));
  });

  it("does not open the editor when the fold button is pressed", async () => {
    await openReport(15);
    await $(fold).click();
    await browser.pause(500);
    expect(await count("#todo-detail .desc-edit")).toBe(0);
    await expect($(desc)).toBeDisplayed();
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
    await expect($("#todo-detail .parent-name")).toHaveText("Plan trip");
    // A real button holding the return arrow, in a chip above the name row.
    expect(await $("#todo-detail .parent-link").getTagName()).toBe("button");
    expect(await count("#todo-detail .parent-link svg")).toBe(1);
    expect(await browser.execute(() => document.querySelector("#todo-detail .parent-link")!.parentElement!.className)).toBe("parent-chip");
    expect(await browser.execute(() => document.querySelector("#todo-detail .parent-chip")!.nextElementSibling!.className)).toBe("head");
    await $("#todo-detail .parent-link").click();
    await expect($("#todo-detail .name")).toHaveValue("Plan trip");
  });

  it("puts a round checkbox at the left of the parent chip, beside the button and not inside it", async () => {
    await openTask("Book flights");
    const box = $('#todo-detail .parent-chip input[type="checkbox"]');
    await expect(box).toBeDisplayed();
    await expect(box).toHaveAttribute("aria-label", "親タスクを完了にする");
    expect(
      await browser.execute(() => {
        const chip = document.querySelector("#todo-detail .parent-chip")!;
        const radius = getComputedStyle(chip.querySelector(".check")!).borderRadius;
        return [chip.firstElementChild!.matches("input.check"), chip.children.length, document.querySelector("#todo-detail .parent-link input") === null, radius];
      }),
    ).toEqual([true, 3, true, "50%"]);
    // The subtask count and the chevron of the reference are not drawn.
    await expect($("#todo-detail .parent-chip")).not.toHaveText(expect.stringContaining("/"));
  });

  it("completes the parent with its checkbox, which takes the open subtask out too: the detail falls back to the list and the parent is not opened", async () => {
    await openTask("Book flights");
    const done = await mock("todoist_set_done", true);
    // What Todoist has after the parent is completed: it and its subtasks are gone.
    const after = todoData();
    after.tasks = after.tasks.filter((t) => t.id === "k1");
    await mock("todoist_load", after);
    await $('#todo-detail .parent-chip input[type="checkbox"]').click();
    expect(await waitForCalls(done)).toEqual([{ id: "k2", done: true }]);
    await expect($("#todo-detail")).not.toBeDisplayed();
    await expect($("#todo-list")).toBeDisplayed();
    await waitForCount(ROWS, 1);
    await expect($("#todo-list")).toHaveText(expect.stringContaining("Write report"));
    await expect($("#todo-list")).not.toHaveText(expect.stringContaining("Plan trip"));
    expect(await callsOf(done)).toHaveLength(1);
  });

  it("shows only the direct parent of a subtask whose parent is a subtask too", async () => {
    await openTask("Book flights", "Pick seat");
    await expect($("#todo-detail .name")).toHaveValue("Pick seat");
    expect(await count("#todo-detail .parent-link")).toBe(1);
    await expect($("#todo-detail .parent-name")).toHaveText("Book flights");
    await expect($("#todo-detail .parent-chip")).not.toHaveText(expect.stringContaining("Plan trip"));
    await $("#todo-detail .parent-link").click();
    await expect($("#todo-detail .name")).toHaveValue("Book flights");
  });

  it("shows no parent task on a task that has none", async () => {
    await openTask();
    await expect($("#todo-detail .name")).toHaveValue("Plan trip");
    expect(await count("#todo-detail .parent-link")).toBe(0);
  });
});

// "Plan trip" (k2) with `description`, and "Book flights" (k3), its subtask, open.
async function openFlightsUnder(description: string) {
  const data = todoData();
  data.tasks[1].description = description;
  await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
  await $("#nav-todo").click();
  await waitForCount(ROWS, 1);
  await $('#projects .proj[data-view="p1"]').click();
  await waitForCount(ROWS, 2);
  await rowOf("Plan trip").click();
  await subRowOf("Book flights").click();
  await expect($("#todo-detail .name")).toHaveValue("Book flights");
}

describe("todo detail of a subtask: the parent's description", () => {
  const name = "#todo-detail .parent-name";
  const panel = "#todo-detail .parent-desc";
  const text = "#todo-detail .parent-desc-text";
  const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

  it("opens the description under the chip when the name is pressed, and folds it when pressed again", async () => {
    await openFlightsUnder("Book by **Friday**");
    expect(await $(name).getTagName()).toBe("button");
    await expect($(name)).toHaveAttribute("aria-expanded", "false");
    expect(await count(panel)).toBe(0);
    await $(name).click();
    await expect($(name)).toHaveAttribute("aria-expanded", "true");
    await expect($(panel)).toBeDisplayed();
    // Drawn as the description is: Markdown.
    await expect($(`${text} strong`)).toHaveText("Friday");
    // Right under the chip, above the name row.
    expect(await browser.execute(() => document.querySelector("#todo-detail .parent-chip")!.nextElementSibling!.className)).toBe("parent-desc");
    expect(await browser.execute(() => document.querySelector("#todo-detail .parent-desc")!.nextElementSibling!.className)).toBe("head");
    await $(name).click();
    await expect($(name)).toHaveAttribute("aria-expanded", "false");
    expect(await count(panel)).toBe(0);
  });

  it("keeps the arrow button going to the parent, whether the description is open or not", async () => {
    await openFlightsUnder("Book by Friday");
    await $(name).click();
    await expect($(panel)).toBeDisplayed();
    await $("#todo-detail .parent-link").click();
    await expect($("#todo-detail .name")).toHaveValue("Plan trip");
    expect(await count("#todo-detail .parent-chip")).toBe(0);
  });

  it("has the name as plain text, which opens nothing, when the parent has no description", async () => {
    await openFlightsUnder("");
    await expect($(name)).toHaveText("Plan trip");
    expect(await $(name).getTagName()).toBe("span");
    await $(name).click();
    expect(await count(panel)).toBe(0);
  });

  it("cuts a long description at 3 lines on the screen, and copies all of it with コピー", async () => {
    await openFlightsUnder(long);
    await $(name).click();
    const shape = await browser.execute((q) => {
      const el = document.querySelector<HTMLElement>(q)!;
      const line = parseFloat(getComputedStyle(el).lineHeight);
      return { clamp: getComputedStyle(el).webkitLineClamp, cut: el.scrollHeight > el.clientHeight, lines: el.clientHeight / line };
    }, text);
    expect(shape.clamp).toBe("3");
    expect(shape.cut).toBe(true);
    expect(shape.lines).toBeLessThanOrEqual(3.05);
    await stubClipboard();
    await expect($(`${panel} button`)).toHaveText("コピー");
    await $(`${panel} button`).click();
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "nothing was copied" });
    expect(await copiedTexts()).toEqual([long]);
    await expect($(".toast")).toHaveText("説明をコピーしました");
  });

  it("shows a short description in full, and lets its text be selected", async () => {
    await openFlightsUnder("short");
    await $(name).click();
    const shape = await browser.execute((q) => {
      const el = document.querySelector<HTMLElement>(q)!;
      return { cut: el.scrollHeight > el.clientHeight, select: getComputedStyle(el).webkitUserSelect };
    }, text);
    expect(shape).toEqual({ cut: false, select: "text" });
  });

  it("shows the error and keeps the description open when the clipboard refuses", async () => {
    await openFlightsUnder("Book by Friday");
    await browser.execute(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("denied")) } });
    });
    await $(name).click();
    await $(`${panel} button`).click();
    await expect($("#error")).toHaveText(expect.stringContaining("denied"));
    await expect($(panel)).toBeDisplayed();
    await expect($(".toast")).not.toBeDisplayed();
  });

  it("starts folded when another task is opened", async () => {
    await openFlightsUnder("Book by Friday");
    await $(name).click();
    await expect($(panel)).toBeDisplayed();
    await $("#todo-detail .parent-link").click();
    await subRowOf("Book flights").click();
    await expect($(name)).toHaveAttribute("aria-expanded", "false");
    expect(await count(panel)).toBe(0);
  });
});

// "Plan trip" with a second subtask, "Pack bag" (k5), beside "Book flights" (k3, which holds "Pick seat").
function tripWithBag() {
  const data = todoData();
  const trip = data.tasks[1];
  const bag = { ...task("k5", "Pack bag", "p1", "none"), parent: { id: trip.id, content: trip.content } };
  trip.subtasks.push({ id: bag.id, content: bag.content, done: false, due: bag.due });
  trip.subTotal++;
  data.tasks.push(bag);
  return data;
}

// What Todoist answers once "Pack bag" (k5) has left "Plan trip" for `projectId`, as a top-level task there.
function bagOut(projectId: string) {
  const data = tripWithBag();
  const trip = data.tasks[1];
  const bag = data.tasks[4];
  bag.parent = null;
  bag.projectId = projectId;
  trip.subtasks = trip.subtasks.filter((x) => x.id !== bag.id);
  trip.subTotal--;
  return data;
}

describe("todo detail: moving a subtask", () => {
  const SUBS = "#todo-detail .subs li.task";
  const dragSub = (name: string, ...over: ChainablePromiseElement[]) => dragFrom(() => subRowOf(name), ...over);
  // The row buttons show on hover, which the driver never does: press one in the page.
  const pressSub = (name: string, button: string) =>
    browser.execute(
      (id, n, b) => window.__e2e_once__(id) && [...document.querySelectorAll<HTMLElement>("#todo-detail .subs li.task")].find((l) => l.textContent!.includes(n))!.querySelector<HTMLElement>(`.${b}`)!.click(),
      onceId(),
      name,
      button,
    );
  // The detail of "Plan trip", which has the subtasks "Book flights" and "Pack bag".
  async function openTrip() {
    await boot({ inbox: inbox(), todoist_load: tripWithBag(), slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await waitForCount(ROWS, 1);
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount(ROWS, 2);
    await rowOf("Plan trip").click();
    await waitForCount(SUBS, 2);
  }

  it("has the grip and the two buttons on each open subtask", async () => {
    await openTrip();
    expect(await count(`${SUBS} .grip`)).toBe(2);
    expect(await count(`${SUBS} .project-row`)).toBe(2);
    expect(await count(`${SUBS} .unparent-row`)).toBe(2);
    await expect(subRowOf("Pack bag").$(".project-row")).toHaveAttribute("aria-label", "プロジェクトを移動");
    await expect(subRowOf("Pack bag").$(".unparent-row")).toHaveAttribute("aria-label", "親タスクから外す");
  });

  it("has no grip, buttons or row to open on a done subtask", async () => {
    // "Plan trip" with a done subtask, "Book hotel" (k6), which has no row among the tasks.
    const data = todoData();
    data.tasks[1].subtasks.push({ id: "k6", content: "Book hotel", done: true, due: null });
    data.tasks[1].subTotal++;
    await boot({ inbox: inbox(), todoist_load: data, slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await waitForCount(ROWS, 1);
    await $('#projects .proj[data-view="p1"]').click();
    await waitForCount(ROWS, 2);
    await rowOf("Plan trip").click();
    await waitForCount(SUBS, 2);
    const done = `${SUBS}.done`;
    expect(await count(done)).toBe(1);
    expect(await count(`${done} .grip`)).toBe(0);
    expect(await count(`${done} .project-row`)).toBe(0);
    expect(await count(`${done} .unparent-row`)).toBe(0);
    expect(await count(`${done}[data-id]`)).toBe(0);
  });

  it("moves a subtask to the project picked in the menu, and drops it from the list of subtasks", async () => {
    await openTrip();
    const move = await mock("todoist_move", true);
    await mock("todoist_load", bagOut("p2"));
    await pressSub("Pack bag", "project-row");
    await $('.menu button[role="menuitem"]:nth-child(3)').click();
    expect(await waitForCalls(move)).toEqual([{ id: "k5", projectId: "p2" }]);
    await waitForCount(SUBS, 1);
    await expect($("#todo-detail .subs")).not.toHaveText(expect.stringContaining("Pack bag"));
    await expect($("#todo-detail .section-title")).toHaveText(expect.stringContaining("サブタスク 0/1"));
  });

  it("calls nothing when the menu's current project is picked", async () => {
    await openTrip();
    const move = await mock("todoist_move", true);
    await pressSub("Pack bag", "project-row");
    await $('.menu button[role="menuitem"]:nth-child(2)').click();
    expect(await callsOf(move)).toEqual([]);
    expect(await count(SUBS)).toBe(2);
  });

  it("takes a subtask out of its parent with 親タスクから外す, in its own project", async () => {
    await openTrip();
    const move = await mock("todoist_move", true);
    await mock("todoist_load", bagOut("p1"));
    await pressSub("Pack bag", "unparent-row");
    expect(await waitForCalls(move)).toEqual([{ id: "k5", projectId: "p1" }]);
    await waitForCount(SUBS, 1);
    await expect($("#todo-detail .subs")).not.toHaveText(expect.stringContaining("Pack bag"));
  });

  it("moves a subtask to the project it is dropped on in the side list, marking that project", async () => {
    await openTrip();
    const move = await mock("todoist_move", true);
    await mock("todoist_load", bagOut("p2"));
    await watchDrops();
    await dragSub("Pack bag", projectOf("p2"));
    expect(await waitForCalls(move)).toEqual([{ id: "k5", projectId: "p2" }]);
    expect(await dropsSeen()).toEqual(["p2"]);
    await waitForCount(SUBS, 1);
    await expect($(".dragging, .drop")).not.toExist();
  });

  it("makes a subtask stand alone when it is dropped on the project it is in", async () => {
    await openTrip();
    const move = await mock("todoist_move", true);
    await mock("todoist_load", bagOut("p1"));
    await dragSub("Pack bag", projectOf("p1"));
    expect(await waitForCalls(move)).toEqual([{ id: "k5", projectId: "p1" }]);
    await waitForCount(SUBS, 1);
  });

  it("makes a subtask the subtask of another subtask it is dropped on, marking that row on the way", async () => {
    await openTrip();
    const moveUnder = await mock("todoist_move_under", true);
    // What Todoist answers once "Pack bag" (k5) is the last subtask of "Book flights" (k3).
    const after = tripWithBag();
    const [, trip, flights, , bag] = after.tasks;
    bag.parent = { id: flights.id, content: flights.content };
    flights.subtasks.push({ id: bag.id, content: bag.content, done: false, due: bag.due });
    flights.subTotal++;
    trip.subtasks = trip.subtasks.filter((x) => x.id !== bag.id);
    trip.subTotal--;
    await mock("todoist_load", after);
    await watchDrops();
    await dragSub("Pack bag", subRowOf("Book flights"));
    expect(await waitForCalls(moveUnder)).toEqual([{ id: "k5", parentId: "k3" }]);
    expect(await dropsSeen()).toEqual(["k3"]);
    await waitForCount(SUBS, 1);
    await expect($("#todo-detail .subs")).not.toHaveText(expect.stringContaining("Pack bag"));
    await expect($(".dragging, .drop")).not.toExist();
  });

  it("does not mark or accept the subtask's own row", async () => {
    await openTrip();
    const moveUnder = await mock("todoist_move_under", true);
    await watchDrops();
    await dragSub("Book flights", subRowOf("Book flights"));
    expect(await dropsSeen()).toEqual([]);
    expect(await callsOf(moveUnder)).toEqual([]);
    await expect($(".dragging, .drop")).not.toExist();
    expect(await count(SUBS)).toBe(2);
  });

  it("puts the row back and shows the error when the move fails", async () => {
    await openTrip();
    const moveUnder = await mock("todoist_move_under", rejects("Todoist に接続できません"));
    await dragSub("Pack bag", subRowOf("Book flights"));
    await waitForCalls(moveUnder);
    // The reload brings back what Todoist has: both subtasks under "Plan trip".
    await waitForCount(SUBS, 2);
    await expect($("#error")).toHaveText(expect.stringContaining("Todoist に接続できません"));
    await expect($("#todo-detail .subs")).toHaveText(expect.stringContaining("Pack bag"));
    await expect($("#todo-detail .subs")).toHaveText(expect.stringContaining("Book flights"));
  });

  it("puts the row back and shows the error when moving it to a project fails", async () => {
    await openTrip();
    const move = await mock("todoist_move", rejects("Todoist に接続できません"));
    await pressSub("Pack bag", "unparent-row");
    await waitForCalls(move);
    await waitForCount(SUBS, 2);
    await expect($("#error")).toHaveText(expect.stringContaining("Todoist に接続できません"));
    await expect($("#todo-detail .subs")).toHaveText(expect.stringContaining("Pack bag"));
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
    await mock("todoist_picked_due", { due: null, bucket: "none", dueAt: null });
    // What Todoist answers after it, so the reload that follows keeps the task without a date.
    const cleared = todoData();
    Object.assign(cleared.tasks[0], { due: null, bucket: "none", dueAt: null });
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
    await boot({ inbox: inbox(), todoist_load: todoData(), slack_load: slackLoad, claude_status: claudeReady });
    await mock("todoist_comments", holds);
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

describe("todo detail labels", () => {
  const add = '#todo-detail button[aria-label="ラベルを追加"]';
  const chips = "#todo-detail .label-chip";
  const names = "#todo-detail .label-chip .label-name";
  const input = ".label-pop input";
  const rows = ".label-pop .label-list button";
  const removeButton = (name: string) => $(`#todo-detail button[aria-label="ラベル「${name}」を外す"]`);
  // Runs the timed refresh now: the page's visibilitychange makes it load again.
  const refreshNow = () => browser.execute((id) => window.__e2e_once__(id) && document.dispatchEvent(new Event("visibilitychange")), onceId());

  // What Todoist answers once "Write report" (k1) has `labels`; `more` are labels to pick from besides Errand and Urgent.
  const dataWith = (labels: string[], more: string[] = []) => {
    const data = todoData();
    data.tasks[0].labels = labels;
    for (const name of more) data.labels.push({ name, color: "#808080" });
    return data;
  };

  // The Todo screen with the detail of "Write report" open, carrying `labels` (and `more` to pick from).
  // The answer of the reload that follows a change is `after`, with `afterMore` to pick from.
  async function openReport(labels: string[], after: string[] = labels, more: string[] = [], afterMore: string[] = more) {
    await boot({ inbox: inbox(), todoist_load: dataWith(labels, more), slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await $(ROWS).click();
    await expect($("#todo-detail .name")).toHaveValue("Write report");
    await mock("todoist_load", dataWith(after, afterMore));
  }

  it("has a ラベル field after the date with a + button, and nothing under it while the task has no labels", async () => {
    await openReport([]);
    await expect($("#todo-detail .field:nth-child(3) .field-label")).toHaveText("ラベル");
    await expect($(add)).toBeDisplayed();
    expect(await count(chips)).toBe(0);
    expect(await browser.execute(() => document.querySelector("#todo-detail .field:nth-child(3)")!.children.length)).toBe(1);
  });

  it("shows each label as a chip with its color dot and its name as text, never as markup", async () => {
    await openReport(["Urgent", "<b>Bold</b>"]);
    await waitForCount(chips, 2);
    expect(await textsOf(names)).toEqual(["Urgent", "<b>Bold</b>"]);
    expect(await count("#todo-detail .label-chip b")).toBe(0);
    // Urgent is #B8255F in the labels to pick from.
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#todo-detail .label-chip .pdot")!).backgroundColor)).toBe("rgb(184, 37, 95)");
  });

  it("takes a label off with its × button: todoist_update gets the labels that remain, and the chip goes at once", async () => {
    await openReport(["Urgent", "Errand"], ["Errand"]);
    const update = await mock("todoist_update", true);
    await removeButton("Urgent").click();
    expect(await waitForCalls(update)).toEqual([{ id: "k1", labels: ["Errand"] }]);
    expect(await textsOf(names)).toEqual(["Errand"]);
  });

  it("sends an empty list when the last label is taken off, and the chips go", async () => {
    await openReport(["Errand"], []);
    const update = await mock("todoist_update", true);
    await removeButton("Errand").click();
    expect(await waitForCalls(update)).toEqual([{ id: "k1", labels: [] }]);
    await waitForCount(chips, 0);
    expect(await browser.execute(() => document.querySelector("#todo-detail .field:nth-child(3)")!.children.length)).toBe(1);
  });

  it("opens a popover with a search field and every label, marks those on the task, and a pressed row puts its label on the task and closes it", async () => {
    await openReport(["Urgent"], ["Urgent", "Errand"]);
    const update = await mock("todoist_update", true);
    await $(add).click();
    await expect($(".label-pop")).toBeDisplayed();
    expect(await browser.execute(() => document.querySelector(".label-pop")!.classList.contains("menu") && document.querySelector(".label-pop")!.parentElement === document.body)).toBe(true);
    await expect($(input)).toHaveAttribute("placeholder", "ラベルを検索または作成");
    expect(await textsOf(rows)).toEqual(["Errand", "Urgent"]);
    expect(await browser.execute((s) => [...document.querySelectorAll(s)].map((b) => b.getAttribute("aria-current")), rows)).toEqual(["false", "true"]);
    await (await $$(rows))[0].click();
    await expect($(".label-pop")).not.toExist();
    expect(await waitForCalls(update)).toEqual([{ id: "k1", labels: ["Urgent", "Errand"] }]);
    expect(await textsOf(names)).toEqual(["Urgent", "Errand"]);
  });

  it("takes a label off from its row in the popover", async () => {
    await openReport(["Urgent"], []);
    const update = await mock("todoist_update", true);
    await $(add).click();
    await (await $$(rows))[1].click();
    expect(await waitForCalls(update)).toEqual([{ id: "k1", labels: [] }]);
  });

  it("narrows the labels by the typed text ignoring case, and offers to create text that is no label's exact name", async () => {
    await openReport([]);
    await $(add).click();
    await $(input).setValue("ERR");
    expect(await textsOf(rows)).toEqual(["Errand", "「ERR」を作成"]);
    await expect($(".label-pop .label-create")).toBeDisplayed();
    await $(input).setValue("zzz");
    expect(await textsOf(rows)).toEqual(["「zzz」を作成"]);
    await $(input).setValue("errand");
    expect(await textsOf(rows)).toEqual(["Errand"]);
    await expect($(".label-pop .label-create")).not.toExist();
  });

  it("acts on Enter as an exact match's row, which toggles that label with its own spelling", async () => {
    await openReport([], ["Errand"]);
    const update = await mock("todoist_update", true);
    const create = await mock("todoist_create_label", true);
    await $(add).click();
    await $(input).setValue("  eRRand ");
    await browser.keys("Enter");
    expect(await waitForCalls(update)).toEqual([{ id: "k1", labels: ["Errand"] }]);
    expect(await callsOf(create)).toEqual([]);
    await expect($(".label-pop")).not.toExist();
  });

  it("makes a new label with Enter on text that matches none: todoist_create_label gets the task's whole list with the new name, and the chip is drawn at once", async () => {
    await openReport(["Urgent"], ["Urgent", "Fresh"], [], ["Fresh"]);
    const create = await mock("todoist_create_label", true);
    const update = await mock("todoist_update", true);
    await $(add).click();
    await $(input).setValue(" Fresh ");
    await browser.keys("Enter");
    expect(await waitForCalls(create)).toEqual([{ id: "k1", name: "Fresh", labels: ["Urgent", "Fresh"] }]);
    expect(await callsOf(update)).toEqual([]);
    await expect($(".label-pop")).not.toExist();
    expect(await textsOf(names)).toEqual(["Urgent", "Fresh"]);
    // It is among the labels to pick from now.
    await $(add).click();
    expect(await textsOf(rows)).toEqual(["Errand", "Urgent", "Fresh"]);
  });

  it("makes a new label with its create row too", async () => {
    await openReport([], ["Fresh"], [], ["Fresh"]);
    const create = await mock("todoist_create_label", true);
    await $(add).click();
    await $(input).setValue("Fresh");
    await $(".label-pop .label-create").click();
    expect(await waitForCalls(create)).toEqual([{ id: "k1", name: "Fresh", labels: ["Fresh"] }]);
    await expect($(".label-pop")).not.toExist();
  });

  it("shows a refusal of the new label's name, and the reload takes the chip back", async () => {
    await openReport([]);
    await mock("todoist_create_label", rejects("ラベルの名前は 128 文字までです"));
    await $(add).click();
    await $(input).setValue("x");
    await browser.keys("Enter");
    await expect($("#error")).toHaveText(expect.stringContaining("ラベルの名前は 128 文字までです"));
    await waitForCount(chips, 0);
  });

  it("scrolls the list of a long label list inside the popover, which stays in the window", async () => {
    await openReport([], [], Array.from({ length: 40 }, (_, i) => `Label ${i + 1}`));
    await $(add).click();
    expect(
      await browser.execute(() => {
        const list = document.querySelector<HTMLElement>(".label-list")!;
        const pop = document.querySelector(".label-pop")!.getBoundingClientRect();
        return [getComputedStyle(list).overflowY, list.scrollHeight > list.clientHeight, pop.top >= 0 && pop.bottom <= innerHeight];
      }),
    ).toEqual(["auto", true, true]);
  });

  it("keeps the popover and what was typed in it over a background redraw of the detail", async () => {
    await openReport([]);
    await $(add).click();
    await $(input).setValue("er");
    const data = dataWith([]);
    data.tasks[0].content = "Write report v2";
    await mock("todoist_load", data);
    await refreshNow();
    await expect($("#todo-detail .name")).toHaveValue("Write report v2");
    await expect($(".label-pop")).toExist();
    await expect($(input)).toHaveValue("er");
    await expect($(input)).toBeFocused();
  });
});

describe("todo count by due moment", () => {
  const button = "#nav-todo";
  const badge = "#nav-todo .nav-count";
  // Runs the timed refresh now: the page's visibilitychange makes it load again.
  const refreshNow = () => browser.execute((id) => window.__e2e_once__(id) && document.dispatchEvent(new Event("visibilitychange")), onceId());
  const noon = () => {
    const data = todoData();
    data.tasks[0] = dueToday(data.tasks[0], "12:00");
    return data;
  };

  it("keeps today's meaning in the 今日 list and its count in the project pane, and counts on the button only the tasks whose due moment has come, with no fetch", async () => {
    await boot({ inbox: inbox(), todoist_load: noon(), slack_load: slackLoad, claude_status: claudeReady });
    await setClock(`${today}T07:00:00`);
    await $("#nav-todo").click();
    await waitForCount(ROWS, 1);
    await expect($("#todo-list")).toHaveText(expect.stringContaining("Write report"));
    await expect($('#projects .proj[data-view="today"] .count')).toHaveText("1");
    await expect($(badge)).not.toBeDisplayed();
    await expect($(button)).toHaveAttribute("aria-label", "Todo");
    // From now on a load never answers, so only the clock can change the button.
    await mock("todoist_load", holds);
    await setClock(`${today}T12:00:00`);
    await browser.waitUntil(async () => (await $(button).getAttribute("aria-label")) === "Todo（期限到来 1 件）", { timeoutMsg: "the count never saw 12:00" });
    await expect($(badge)).toHaveText("1");
    await expect($('#projects .proj[data-view="today"] .count')).toHaveText("1");
    await expect($("#todo-list")).toHaveText(expect.stringContaining("Write report"));
  });

  it("counts with the clock at each fetch: not at 11:59, from 12:00", async () => {
    await boot({ inbox: inbox(), todoist_load: noon(), slack_load: slackLoad, claude_status: claudeReady });
    await $("#nav-todo").click();
    await waitForCount(ROWS, 1);
    await setClock(`${today}T11:59:00`);
    await refreshNow();
    await browser.waitUntil(async () => !(await $(badge).isDisplayed()), { timeoutMsg: "the count was shown before 12:00" });
    await setClock(`${today}T12:00:00`);
    await refreshNow();
    await expect($(badge)).toHaveText("1");
  });
});
