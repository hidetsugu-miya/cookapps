import type { TodoChatReply } from "../../ts/bindings/TodoChatReply";
import { boot, callsOf, claudeLoggedOut, claudeReady, count, holds, inbox, mock, onceId, rejects, release, slackLoad, slackMessageUrl, slackSummary, task, textsOf, today, todoData, waitForCalls, waitForCount, waitForText } from "../support";

// The Claude pane of the Todo screen (T-7).
const pane = "#todo-claude";
const log = "#todo-claude-log";
const input = () => $("#todo-claude-input");
const send = () => $("#todo-claude-send");

// The app with Todoist connected and the Todo screen open.
async function openTodo(claude: unknown = claudeReady) {
  await boot({ inbox: inbox(), todoist_load: todoData(), slack_load: slackLoad, claude_status: claude });
  await $("#nav-todo").click();
  await waitForCount("#todo-list li.task", 1);
}

const openPane = async () => {
  await $("#todo-claude-btn").click();
  await expect($(pane)).toBeDisplayed();
};

// What `claude_chat_todo` answers: a reply, and tasks that are on the cards. p1 is Work and p0 the inbox of the Todo fixtures.
const answer = (reply: string, tasks: TodoChatReply["tasks"] = []): TodoChatReply => ({ reply, tasks });
const proposals: TodoChatReply["tasks"] = [
  { content: "請求書を送る", due: today, projectId: "p1" },
  { content: "牛乳を買う", due: `${today} 15:00`, projectId: null },
  { content: "メモを整理する", due: null, projectId: "p0" },
  { content: "机を片づける", due: null, projectId: null },
];

// The Todoist commands that write, mocked so that their calls are recorded: the pane must call none of them.
const writes = ["todoist_add", "todoist_add_task", "todoist_add_subtask", "todoist_update", "todoist_set_done", "todoist_add_from_slack", "todoist_delete", "todoist_move"];

// The nth card under the answers (1-based), and a part of it.
const card = (n: number) => `${log} .chat-tasks .chat-task:nth-child(${n})`;
const names = () => browser.execute(() => [...document.querySelectorAll<HTMLInputElement>("#todo-claude-log .chat-task-name")].map((i) => i.value));
// The commands that create a task: every one of them but todoist_add_task must stay uncalled by the cards.
const otherWrites = writes.filter((c) => c !== "todoist_add_task");

// Types `text`, presses the send button and waits until the `replies`th reply is drawn.
async function ask(text: string, reply: unknown, replies = 1) {
  const chat = await mock("claude_chat_todo", reply);
  await input().setValue(text);
  await send().click();
  await waitForCalls(chat);
  await waitForCount(`${log} .chat-ai`, replies);
  return chat;
}

describe("todo Claude pane", () => {
  it("opens and closes from its own button, apart from the ✳ of the summary prompt, and the divider says Claude", async () => {
    await openTodo();
    await expect($("#todo-claude-btn")).toHaveAttribute("aria-label", "Claude に相談");
    await expect($("#todo-claude-btn")).toHaveAttribute("aria-pressed", "false");
    await expect($("#todo-prompt")).toHaveAttribute("aria-label", "Todo の要約プロンプトを確認・編集");
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#todo-split")).not.toBeDisplayed();
    await openPane();
    await expect($("#todo-claude-btn")).toHaveAttribute("aria-pressed", "true");
    await expect($("#todo-split")).toBeDisplayed();
    await expect($("#todo-split")).toHaveAttribute("aria-label", "Claude の幅");
    await expect($(`${pane} .chat-head`)).toHaveText(expect.stringContaining("Claude"));
    await $("#todo-claude-btn").click();
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#todo-split")).not.toBeDisplayed();
    await expect($("#todo-claude-btn")).toHaveAttribute("aria-pressed", "false");
    await openPane();
    await $("#todo-claude-close").click();
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#todo-split")).not.toBeDisplayed();
  });

  it("has the request field with the model and effort of todoChat under it, and no help text", async () => {
    await openTodo();
    await openPane();
    await expect(input()).toHaveAttribute("aria-label", "Claude への依頼");
    await expect(input()).not.toHaveAttribute("placeholder");
    await expect(input()).toBeEnabled();
    await expect(send()).toBeEnabled();
    await expect($('#todo-claude-model select[data-purpose="todoChat"][data-kind="model"]')).toHaveValue("sonnet");
    await expect($('#todo-claude-model select[data-purpose="todoChat"][data-kind="effort"]')).toHaveValue("medium");
    expect(await count("#todo-claude-model select")).toBe(2);
    // The row of the selects is under the field, with the send button at its right end.
    expect(await browser.execute(() => document.querySelector("#todo-claude-model")!.getBoundingClientRect().top >= document.querySelector("#todo-claude-input")!.getBoundingClientRect().bottom)).toBe(true);
    expect(await browser.execute(() => document.querySelector("#todo-claude-send")!.getBoundingClientRect().left >= document.querySelector("#todo-claude-model")!.getBoundingClientRect().right)).toBe(true);
  });

  it("is never open with the Orca pane: opening one closes the other", async () => {
    await openTodo();
    await openPane();
    // The Orca button is for a task's detail.
    await expect($("#todo-orca")).not.toBeDisplayed();
    await $("#todo-list li.task").click();
    await expect($("#todo-orca")).toBeDisplayed();
    await expect($(pane)).toBeDisplayed();
    await $("#todo-orca").click();
    await expect($("#todo-handoff")).toBeDisplayed();
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#todo-claude-btn")).toHaveAttribute("aria-pressed", "false");
    await expect($("#todo-orca")).toHaveAttribute("aria-pressed", "true");
    await expect($("#todo-split")).toHaveAttribute("aria-label", "Orca の幅");
    await $("#todo-claude-btn").click();
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-handoff")).not.toBeDisplayed();
    await expect($("#todo-orca")).toHaveAttribute("aria-pressed", "false");
    await expect($("#todo-split")).toBeDisplayed();
    await expect($("#todo-split")).toHaveAttribute("aria-label", "Claude の幅");
  });

  it("stays open between the list and a task, hides under the page of a draft and the token form, and comes back", async () => {
    await openTodo();
    await openPane();
    await $("#todo-list li.task").click();
    await expect($("#todo-back")).toBeDisplayed();
    await expect($(pane)).toBeDisplayed();
    await $("#todo-back").click();
    await expect($(pane)).toBeDisplayed();
    // The page of a draft has a Claude pane of its own (S-18): this one and its button go.
    await mock("todoist_summarize_slack", slackSummary);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await $("#todo-add-button").click();
    await $("#todo-draft").waitForExist();
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#todo-split")).not.toBeDisplayed();
    await expect($("#todo-claude-btn")).not.toBeDisplayed();
    await $("#todo-back").click();
    await expect($("#todo-claude-btn")).toBeDisplayed();
    await expect($("#todo-claude-btn")).toHaveAttribute("aria-pressed", "true");
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-split")).toBeDisplayed();
  });

  it("calls claude_chat_todo with the request, and draws the reply and a card for each proposed task", async () => {
    await openTodo();
    await openPane();
    const writeMocks = await Promise.all(writes.map((c) => mock(c, true)));
    const chat = await ask("今週のやることを出して", answer("次の 4 件はどうですか", proposals));
    expect(await callsOf(chat)).toEqual([{ history: [], instruction: "今週のやることを出して" }]);
    await expect($(`${log} .chat-user`)).toHaveText("今週のやることを出して");
    await expect($(`${log} .chat-ai`)).toHaveText(expect.stringContaining("次の 4 件はどうですか"));
    expect(await names()).toEqual(["請求書を送る", "牛乳を買う", "メモを整理する", "机を片づける"]);
    // The chips of each card: the date, then the project; a task with no date says so, and one with no project is in the inbox.
    const chips = await browser.execute(() => [...document.querySelectorAll("#todo-claude-log .chat-task")].map((card) => [...card.querySelectorAll(".review-chip")].map((c) => c.textContent)));
    expect(chips).toEqual([["今日", "Work"], ["15:00", "インボックス"], ["期限なし", "インボックス"], ["期限なし", "インボックス"]]);
    // Each card has 却下 and 追加, and nothing is written until 追加 is pressed.
    expect(await textsOf(`${card(1)} .text-btn`)).toEqual(["却下", "追加"]);
    expect(await count(`${log} .chat-task .text-btn.primary`)).toBe(4);
    for (const c of writeMocks) expect(await callsOf(c)).toEqual([]);
    expect(await callsOf(chat)).toHaveLength(1);
  });

  it("creates the task with the name, date and project changed on the card, and the card says it was added and the list is read again", async () => {
    await openTodo();
    await openPane();
    await ask("牛乳", answer("案です", proposals.slice(1, 2)));
    const add = await mock("todoist_add_task", true);
    const load = await mock("todoist_load", todoData());
    await $(`${card(1)} .chat-task-name`).setValue("牛乳を 2 本買う");
    await $(`${card(1)} .chat-task-due`).click();
    await $(".due-pop .chip-input").setValue(`${today} 09:30`);
    await browser.keys("Enter");
    await expect($(`${card(1)} .chat-task-due`)).toHaveText("09:30");
    await $(`${card(1)} .chat-task-project`).click();
    await $('.menu button[role="menuitem"]:nth-child(2)').click();
    await expect($(`${card(1)} .chat-task-project`)).toHaveText("Work");
    // The edits are on the card only.
    expect(await callsOf(add)).toEqual([]);
    await $(`${card(1)} .chat-task-add`).click();
    await waitForCalls(add);
    await waitForText(`${log} .chat-task-done`, "✓ 牛乳を 2 本買う を追加しました");
    expect(await callsOf(add)).toEqual([{ content: "牛乳を 2 本買う", due: `${today} 09:30`, projectId: "p1" }]);
    expect(await count(`${log} .chat-task button`)).toBe(0);
    expect(await count(`${log} .chat-task input`)).toBe(0);
    await waitForCalls(load);
    for (const c of otherWrites) expect(await callsOf(c)).toEqual([]);
  });

  it("sends a card's own values when nothing was changed, and adds one card at a time", async () => {
    await openTodo();
    await openPane();
    await ask("出して", answer("案です", proposals));
    const add = await mock("todoist_add_task", true);
    await $(`${card(4)} .chat-task-add`).click();
    await waitForText(`${log} .chat-task-done`, "✓ 机を片づける を追加しました");
    expect(await callsOf(add)).toEqual([{ content: "机を片づける", due: null, projectId: null }]);
    // The others are still open.
    expect(await count(`${log} .chat-task .chat-task-add`)).toBe(3);
    await $(`${card(1)} .chat-task-add`).click();
    await waitForText(`${log} .chat-task-done`, "✓ 請求書を送る を追加しました");
    expect(await callsOf(add)).toEqual([
      { content: "机を片づける", due: null, projectId: null },
      { content: "請求書を送る", due: today, projectId: "p1" },
    ]);
  });

  it("closes a card with 却下 and creates nothing", async () => {
    await openTodo();
    await openPane();
    const writeMocks = await Promise.all(writes.map((c) => mock(c, true)));
    await ask("出して", answer("案です", proposals.slice(0, 2)));
    await $(`${card(1)} .text-btn:not(.primary)`).click();
    await waitForCount(`${log} .chat-task`, 1);
    expect(await names()).toEqual(["牛乳を買う"]);
    await $(`${card(1)} .text-btn:not(.primary)`).click();
    await waitForCount(`${log} .chat-task`, 0);
    // The reply stays, and the box of the cards takes no room.
    await expect($(`${log} .chat-ai`)).toHaveText(expect.stringContaining("案です"));
    await expect($(`${log} .chat-tasks`)).not.toBeDisplayed();
    for (const c of writeMocks) expect(await callsOf(c)).toEqual([]);
  });

  it("shows a refusal on the card and keeps the card as it was, then adds it when the next try works", async () => {
    await openTodo();
    await openPane();
    await ask("出して", answer("案です", proposals.slice(0, 1)));
    const add = await mock("todoist_add_task", rejects("日付は YYYY-MM-DD か YYYY-MM-DD HH:MM の形で指定してください"));
    await $(`${card(1)} .chat-task-name`).setValue("請求書を直す");
    await $(`${card(1)} .chat-task-add`).click();
    await waitForCalls(add);
    await waitForText(`${log} .chat-task .review-err`, "追加できませんでした: 日付は YYYY-MM-DD か YYYY-MM-DD HH:MM の形で指定してください");
    expect(await names()).toEqual(["請求書を直す"]);
    await expect($(`${card(1)} .chat-task-add`)).toBeEnabled();
    expect(await count(`${log} .chat-task-done`)).toBe(0);
    // The error line of the screen is not used.
    await expect($("#error")).not.toBeDisplayed();
    await mock("todoist_add_task", true);
    await $(`${card(1)} .chat-task-add`).click();
    await waitForText(`${log} .chat-task-done`, "✓ 請求書を直す を追加しました");
    expect(await count(`${log} .review-err`)).toBe(0);
  });

  it("stops the card while it is added, so the task is made once", async () => {
    await openTodo();
    await openPane();
    await ask("出して", answer("案です", proposals.slice(0, 2)));
    const add = await mock("todoist_add_task", holds);
    await $(`${card(1)} .chat-task-add`).click();
    await waitForCalls(add);
    await expect($(`${card(1)} .chat-task-add`)).toBeDisabled();
    await expect($(`${card(1)} .chat-task-add`)).toHaveText("追加中");
    await expect($(`${card(1)} .chat-task-name`)).toBeDisabled();
    await expect($(`${card(1)} .chat-task-due`)).toBeDisabled();
    await expect($(`${card(1)} .chat-task-project`)).toBeDisabled();
    await expect($(`${card(1)} .text-btn:not(.primary)`)).toBeDisabled();
    await $(`${card(1)} .chat-task-add`).click();
    // The other card is free.
    await expect($(`${card(2)} .chat-task-add`)).toBeEnabled();
    expect(await callsOf(add)).toHaveLength(1);
    await release(add, true);
    await waitForText(`${log} .chat-task-done`, "✓ 請求書を送る を追加しました");
    expect(await callsOf(add)).toHaveLength(1);
  });

  it("keeps the card open and says nothing when Todoist needs a token", async () => {
    await openTodo();
    await openPane();
    await ask("出して", answer("案です", proposals.slice(0, 1)));
    const add = await mock("todoist_add_task", null);
    await $(`${card(1)} .chat-task-add`).click();
    await waitForCalls(add);
    await expect($(`${card(1)} .chat-task-add`)).toBeEnabled();
    await expect($(`${card(1)} .chat-task-add`)).toHaveText("追加");
    expect(await count(`${log} .review-err`)).toBe(0);
    expect(await count(`${log} .chat-task-done`)).toBe(0);
  });

  it("keeps what was done on the cards through a background read and a visit to a task, and drops it with クリア", async () => {
    await openTodo();
    await openPane();
    await ask("出して", answer("案です", proposals.slice(0, 3)));
    await mock("todoist_add_task", true);
    await $(`${card(1)} .chat-task-name`).setValue("請求書を直す");
    await $(`${card(2)} .chat-task-add`).click();
    await waitForCount(`${log} .chat-task-done`, 1);
    await $(`${card(3)} .text-btn:not(.primary)`).click();
    await waitForCount(`${log} .chat-task`, 2);
    // A newer read brings a task: the list is drawn again, and the cards stay as they were.
    const next = todoData();
    next.tasks.push(task("k9", "Call the bank", "p1", "today"));
    await mock("todoist_load", next);
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      document.dispatchEvent(new Event("visibilitychange"));
    }, onceId());
    await waitForCount("#todo-list li.task", 2);
    const kept = async () => {
      expect(await names()).toEqual(["請求書を直す"]);
      expect(await textsOf(`${log} .chat-task-done`)).toEqual(["✓ 牛乳を買う を追加しました"]);
      expect(await count(`${log} .chat-task`)).toBe(2);
    };
    await kept();
    await $("#todo-list li.task").click();
    await expect($("#todo-back")).toBeDisplayed();
    await $("#todo-back").click();
    await kept();
    // クリア forgets the cards with the conversation, and a new answer brings new cards.
    await $("#todo-claude-clear").click();
    await $("#todo-claude-clear").click();
    expect(await count(`${log} .chat-task`)).toBe(0);
    await ask("もう一度", answer("案です", proposals.slice(0, 1)));
    expect(await names()).toEqual(["請求書を送る"]);
  });

  it("tells Claude the tasks of the earlier answers as the cards show them now, without the rejected ones", async () => {
    await openTodo();
    await openPane();
    await ask("出して", answer("案です", proposals));
    await $(`${card(1)} .chat-task-name`).setValue("請求書を今日送る");
    await $(`${card(4)} .text-btn:not(.primary)`).click();
    await waitForCount(`${log} .chat-task`, 3);
    const chat = await ask("もっと短く", answer("短くしました"), 2);
    expect(await callsOf(chat)).toEqual([
      {
        history: [
          { role: "user", text: "出して" },
          {
            role: "assistant",
            text: `案です\n- 請求書を今日送る（日付: ${today}、プロジェクト: Work）\n- 牛乳を買う（日付: ${today} 15:00、プロジェクト: インボックス）\n- メモを整理する（日付: なし、プロジェクト: インボックス）`,
          },
        ],
        instruction: "もっと短く",
      },
    ]);
  });

  it("sends the conversation so far with the next request, and draws a reply with no task as text only", async () => {
    await openTodo();
    await openPane();
    await ask("今週のやることを出して", answer("案です", proposals.slice(0, 1)));
    const chat = await ask("ありがとう", answer("どういたしまして"), 2);
    expect(await callsOf(chat)).toEqual([
      {
        history: [
          { role: "user", text: "今週のやることを出して" },
          { role: "assistant", text: `案です\n- 請求書を送る（日付: ${today}、プロジェクト: Work）` },
        ],
        instruction: "ありがとう",
      },
    ]);
    expect(await count(`${log} .chat-task`)).toBe(1);
    const replies = await textsOf(`${log} .chat-ai`);
    expect(replies[0]).toContain("案です");
    expect(replies[1]).toBe("どういたしまして");
  });

  it("waits for the answer with the field and the button stopped, and frees them when it comes", async () => {
    await openTodo();
    await openPane();
    const chat = await mock("claude_chat_todo", holds);
    await input().setValue("考えて");
    await send().click();
    await waitForCalls(chat);
    await waitForText(`${log} .pending`, "Claude が考えています…");
    await expect(input()).toBeDisabled();
    await expect(send()).toBeDisabled();
    await release(chat, answer("できました", proposals.slice(0, 1)));
    await waitForCount(`${log} .chat-task`, 1);
    await expect(input()).toBeEnabled();
    await expect(send()).toBeEnabled();
    expect(await count(`${log} .pending`)).toBe(0);
  });

  it("shows a failure in the conversation, and does not send it with the next request", async () => {
    await openTodo();
    await openPane();
    const chat = await mock("claude_chat_todo", rejects("Claude が答えませんでした"));
    await input().setValue("考えて");
    await send().click();
    await waitForCalls(chat);
    await waitForText(`${log} .pending.fail`, "送れませんでした: Claude が答えませんでした");
    await expect(input()).toBeEnabled();
    await ask("もう一度", answer("できました"));
    expect(await callsOf("claude_chat_todo")).toEqual([{ history: [{ role: "user", text: "考えて" }], instruction: "もう一度" }]);
  });

  it("forgets the conversation with two presses of クリア", async () => {
    await openTodo();
    await openPane();
    await expect($("#todo-claude-clear")).toBeDisabled();
    await ask("出して", answer("案です", proposals.slice(0, 1)));
    await expect($("#todo-claude-clear")).toBeEnabled();
    await $("#todo-claude-clear").click();
    await expect($("#todo-claude-clear")).toHaveText("もう一度押すとクリア");
    expect(await count(`${log} .chat-task`)).toBe(1);
    await $("#todo-claude-clear").click();
    expect(await count(`${log} .chat-task`)).toBe(0);
    expect(await count(`${log} .chat-user`)).toBe(0);
  });

  it("stops the field and the send button, and says why, while Claude cannot be used", async () => {
    await openTodo(claudeLoggedOut);
    await openPane();
    await expect(input()).toBeDisabled();
    await expect(send()).toBeDisabled();
    await expect($("#todo-claude-chat-note")).toBeDisplayed();
    await expect($("#todo-claude-chat-note")).toHaveText("設定の Claude タブで接続すると、Claude に相談できます");
  });

  it("keeps the pane and the conversation when Todoist is read again in the background", async () => {
    await openTodo();
    await openPane();
    await ask("出して", answer("案です", proposals.slice(0, 2)));
    // A newer read brings a task: the list is drawn again, and the pane stays as it was.
    const next = todoData();
    next.tasks.push(task("k9", "Call the bank", "p1", "today"));
    await mock("todoist_load", next);
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      document.dispatchEvent(new Event("visibilitychange"));
    }, onceId());
    await waitForCount("#todo-list li.task", 2);
    await expect($(pane)).toBeDisplayed();
    await expect($("#todo-claude-btn")).toHaveAttribute("aria-pressed", "true");
    expect(await count(`${log} .chat-task`)).toBe(2);
    await expect($(`${log} .chat-user`)).toHaveText("出して");
  });
});
