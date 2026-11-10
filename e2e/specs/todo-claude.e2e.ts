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
    expect(await textsOf(`${log} .chat-task-name`)).toEqual(["請求書を送る", "牛乳を買う", "メモを整理する", "机を片づける"]);
    // The chips of each card: the date, then the project; a chip is not drawn for what the task lacks, and a card with neither has no line.
    const chips = await browser.execute(() => [...document.querySelectorAll("#todo-claude-log .chat-task")].map((card) => [...card.querySelectorAll(".review-chip")].map((c) => c.textContent)));
    expect(chips).toEqual([["今日", "Work"], ["15:00"], ["インボックス"], []]);
    expect(await count(`${log} .chat-task .review-chips`)).toBe(3);
    // The cards only show: nothing to press, and no write to Todoist.
    expect(await count(`${log} .chat-task button`)).toBe(0);
    for (const c of writeMocks) expect(await callsOf(c)).toEqual([]);
    expect(await callsOf(chat)).toHaveLength(1);
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
          { role: "assistant", text: "案です" },
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
