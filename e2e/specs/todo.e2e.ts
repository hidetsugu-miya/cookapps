import {
  boot, callsOf, claudeMissing, claudeReady, inbox, mock, slackLoad, slackMessageUrl, todoData, waitForCalls, waitForCount, waitForText,
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

  it("turns the button into 要約して追加 for a Slack link and sends it to todoist_add_from_slack", async () => {
    await openTodo();
    const addFromSlack = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#todo-add-input").setValue(slackMessageUrl);
    await expect($("#todo-add-button")).toHaveText("要約して追加");
    await expect($("#todo-add-hint")).toHaveText(expect.stringContaining("Example Team"));
    await $("#todo-add-button").click();
    await waitForCalls(addFromSlack);
    expect(await callsOf(addFromSlack)).toContainEqual({ url: slackMessageUrl, projectId: null, today: true });
    await expect($(".toast")).toHaveText(expect.stringContaining("Reply to the vendor"));
  });

  it("keeps the button as 追加 and hints at the Claude login while Claude is missing", async () => {
    await openTodo(claudeMissing);
    await $("#todo-add-input").setValue(slackMessageUrl);
    await expect($("#todo-add-hint")).toHaveText("Claude にログインすると、要約して追加できます");
    await expect($("#todo-add-button")).toHaveText("追加");
  });
});
