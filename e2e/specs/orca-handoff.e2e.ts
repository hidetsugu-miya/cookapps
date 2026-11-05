import type { OrcaStarted } from "../../ts/bindings/OrcaStarted";
import {
  boot,
  callsOf,
  chatAssistant,
  chatItems,
  chatOpens,
  chatUser,
  claudeReady,
  count,
  inbox,
  mock,
  orcaOverview,
  orcaRow,
  orcaWorktree,
  rejects,
  rowOf,
  sendChat,
  slackLoad,
  slackThread,
  slackTs,
  textsOf,
  threadDetail,
  threadMessage,
  timeline,
  timelineMessage,
  todoData,
  waitForCalls,
  waitForCount,
  waitForOpens,
} from "../support";

// A waiting, a working and a done agent (all have a terminal), and a working one with no terminal (it cannot take a send, so the pane does not list it).
const sample = () => [
  orcaRow("example-api", "main", "Fix the parser", { group: "waiting", minutes: 5 }),
  orcaRow("example-app", "feat/a", "Write the docs", { minutes: 2 }),
  orcaRow("example-lib", "feature/x", "Opened the pull request.", { group: "done", minutes: 18 }),
  orcaRow("example-web", "dev", "Update the page", { minutes: 11, handle: null, paneKey: null }),
];
const worktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];
// What a launch answers, and the row the list then holds for that session.
const started: OrcaStarted = { paneKey: "tab_new:leaf_9", handle: "term_new" };
const newRow = () => orcaRow("example-app", "feat/a", "Fix the invoice", { minutes: 1, handle: "term_new", paneKey: "tab_new:leaf_9", path: "/work/example-app" });

const bootOrca = (fixtures: Record<string, unknown> = {}) =>
  boot({ inbox: inbox(), orca_overview: orcaOverview(sample(), worktrees()), orca_skills: [], ...fixtures });

// ---- the three screens ----

const MAIL = { pane: "#mail-handoff", button: "#thread-orca" };
const TODO = { pane: "#todo-handoff", button: "#todo-orca" };
const SLACK = { pane: "#st-orca", button: "#reply-tab-orca" };
type Screen = typeof MAIL;

const mailBody = "10 月分の請求書の金額が、画面と 1,200 円違っています。";
const subject = "請求書の金額が画面と合わない件";

// The app with the thread "Already read" open.
async function openMail(fixtures: Record<string, unknown> = {}) {
  await bootOrca(fixtures);
  await waitForCount("#unread-threads li", 2);
  await mock("thread", threadDetail(subject, mailBody, false));
  await rowOf("read-threads", "Already read").$(".subject").click();
  await expect($("#thread-subject")).toHaveText(subject);
}

const rootTs = slackTs(60, 1);
const replyTs = slackTs(50, 2);
async function openSlack(fixtures: Record<string, unknown> = {}) {
  const messages = [timelineMessage(rootTs, "Alice Example", "dev-billing", "Please review the deploy notes.", { replyCount: 1 })];
  await bootOrca({ slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady, ...fixtures });
  await mock("slack_thread", slackThread([threadMessage(rootTs, "Alice Example", "Please review the deploy notes."), threadMessage(replyTs, "Bob Example", "Looks fine to me.")]));
  await $("#nav-slack").click();
  await waitForCount("#slack-feed .feed-row", 1);
  await $("#slack-feed .feed-open").click();
  await waitForCount("#st-msgs .st-msg", 2);
}

async function openTodo(fixtures: Record<string, unknown> = {}) {
  await bootOrca({ todoist_load: todoData(), slack_load: slackLoad, claude_status: claudeReady, ...fixtures });
  await $("#nav-todo").click();
  await waitForCount("#todo-list li.task", 1);
  await $("#todo-list li.task").click();
  await expect($("#todo-back")).toBeDisplayed();
}

// Opens the pane of the screen shown: the header button of the mail and the Todo, the Orca tab of the Slack thread. The list of Orca is read when it opens.
async function openPane(screen: Screen) {
  await $(screen.button).click();
  await expect($(screen.pane)).toBeDisplayed();
  await waitForCount(`${screen.pane} .ho-row`, 3);
}

const field = (screen: Screen) => $(`${screen.pane} textarea`);
const sendButton = (screen: Screen) => $(`${screen.pane} .ho-form .text-btn.primary`);
const rowByHandle = (screen: Screen, handle: string) => $(`${screen.pane} .ho-row[data-handle="${handle}"]`);

// Picks the worktree at `path` in the dialog of the chip.
async function chooseWorktree(screen: Screen, path: string) {
  await $(`${screen.pane} .ho-chip`).click();
  await $(`.orca-dest-pop button[data-path="${path}"]`).click();
}

describe("orca handoff", () => {
  it("opens from the header icon of the mail, with its destinations, the card and the empty instruction", async () => {
    await openMail();
    await expect($(MAIL.button)).toHaveAttribute("aria-label", "Orca に渡す");
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "false");
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await $(MAIL.button).click();
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "true");
    await expect($(MAIL.pane)).toBeDisplayed();
    expect(await textsOf(`${MAIL.pane} .ho-title`)).toEqual(["Orca に渡す"]);
    // The divider reuses split.ts: a separator for the width of the pane.
    await expect($("#mail-split")).toHaveAttribute("role", "separator");
    await expect($("#mail-split")).toHaveAttribute("aria-label", "Orca の幅");
    await waitForCount(`${MAIL.pane} .ho-row`, 3);
    // The new session first, with the chip (no worktree chosen yet); then the running sessions that have a terminal, in the groups of the Orca screen.
    expect(await textsOf(`${MAIL.pane} .ho-new-btn`)).toEqual(["新しいセッション"]);
    await expect($(`${MAIL.pane} .ho-new-btn`)).toHaveAttribute("aria-pressed", "true");
    expect(await textsOf(`${MAIL.pane} .ho-chip`)).toEqual(["worktree を選ぶ"]);
    expect(await textsOf(`${MAIL.pane} .ho-group`)).toEqual(["入力待ち1", "作業中1", "完了1"]);
    expect(await textsOf(`${MAIL.pane} .ho-row-title`)).toEqual(["Fix the parser", "Write the docs", "Opened the pull request."]);
    expect(await textsOf(`${MAIL.pane} .ho-row-sub`)).toEqual(["example-api ・ main", "example-app ・ feat/a", "example-lib ・ feature/x"]);
    // The card names the content: the subject, the sender and the size of the text.
    expect(await textsOf(`${MAIL.pane} .ho-card-title`)).toEqual([subject]);
    expect((await textsOf(`${MAIL.pane} .ho-card-meta`))[0]).toMatch(/^Alice ・ 本文 \d+ 字$/);
    await expect($(`${MAIL.pane} [aria-label="渡す内容を外す"]`)).toBeDisplayed();
    await expect(field(MAIL)).toHaveAttribute("aria-label", "Orca への指示");
    await expect(sendButton(MAIL)).toHaveText("起動する");
    await expect(sendButton(MAIL)).toBeDisabled();
    // The icon closes the pane again.
    await $(`${MAIL.pane} [aria-label="閉じる"]`).click();
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "false");
  });

  it("starts a new session in the chosen worktree with the instruction and the content as arguments of one command", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await field(MAIL).setValue("原因を調べて");
    // The button waits for a worktree.
    await expect(sendButton(MAIL)).toBeDisabled();
    await chooseWorktree(MAIL, "/work/example-app");
    expect(await textsOf(`${MAIL.pane} .ho-chip`)).toEqual(["example-app ・ feat/a"]);
    await expect(sendButton(MAIL)).toBeEnabled();
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as { destination: unknown; instruction: string; context: { kind: string; title: string; body: string }; environment: string | null }[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-app" });
    expect(call.instruction).toBe("原因を調べて");
    expect(call.environment).toBeNull();
    expect(call.context.kind).toBe("mail");
    expect(call.context.title).toBe(subject);
    // The text of each message has its sender and its date.
    expect(call.context.body).toContain("差出人: Alice <alice@example.com>");
    expect(call.context.body).toContain("日時: ");
    expect(call.context.body).toContain(mailBody);
    // Nothing else was sent, and the Orca screen's own launch was not used.
    expect(await callsOf("orca_launch")).toHaveLength(0);
    expect(await callsOf(handoff)).toHaveLength(1);
  });

  it("sends to a running session with its terminal handle, and the chosen worktree stays for the next handoff", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", { paneKey: null, handle: "term_example-api" } satisfies OrcaStarted);
    await openPane(MAIL);
    await chooseWorktree(MAIL, "/work/example-api");
    await rowByHandle(MAIL, "term_example-api").click();
    await expect(rowByHandle(MAIL, "term_example-api")).toHaveAttribute("aria-pressed", "true");
    await expect($(`${MAIL.pane} .ho-new-btn`)).toHaveAttribute("aria-pressed", "false");
    await expect(sendButton(MAIL)).toHaveText("送る");
    await field(MAIL).setValue("この方針でお願い");
    await expect(sendButton(MAIL)).toBeEnabled();
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as { destination: unknown; instruction: string; context: { kind: string } }[];
    expect(call.destination).toEqual({ kind: "existing", handle: "term_example-api" });
    expect(call.instruction).toBe("この方針でお願い");
    expect(call.context.kind).toBe("mail");
    // The worktree is kept in memory: the form of the next item shows it again.
    await $(`${MAIL.pane} [aria-label="閉じる"]`).click();
    await $("#back").click();
    await mock("thread", threadDetail("Second", "Other mail", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await $(MAIL.button).click();
    await waitForCount(`${MAIL.pane} .ho-row`, 3);
    expect(await textsOf(`${MAIL.pane} .ho-chip`)).toEqual(["example-api ・ main"]);
  });

  it("posts with no block when the card is taken off", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseWorktree(MAIL, "/work/example-app");
    await $(`${MAIL.pane} [aria-label="渡す内容を外す"]`).click();
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(0);
    await field(MAIL).setValue("ただの指示");
    await sendButton(MAIL).click();
    expect(await waitForCalls(handoff)).toEqual([{ destination: { kind: "new", path: "/work/example-app" }, instruction: "ただの指示", context: null, environment: null }]);
  });

  it("keeps the text and shows the message when the command fails, and the button waits for a blank text", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", rejects("Orca が指示を受け付けませんでした"));
    await openPane(MAIL);
    await chooseWorktree(MAIL, "/work/example-app");
    await field(MAIL).setValue("   ");
    await expect(sendButton(MAIL)).toBeDisabled();
    await field(MAIL).setValue("やって");
    await sendButton(MAIL).click();
    await waitForCalls(handoff);
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("Orca が指示を受け付けませんでした");
    await expect(field(MAIL)).toHaveValue("やって");
    // Still the form: no session, and the card is there to try again.
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(1);
    await expect(sendButton(MAIL)).toBeEnabled();
    expect(await callsOf(handoff)).toHaveLength(1);
  });

  it("shows the notice of the Orca screen in the pane when the command is missing or the read failed", async () => {
    await openMail({ orca_overview: orcaOverview([], [], { state: "missing" }) });
    await $(MAIL.button).click();
    await expect($(`${MAIL.pane} .ho-notice`)).toHaveText(expect.stringContaining("orca コマンドが見つかりません"));
    await field(MAIL).setValue("やって");
    await expect(sendButton(MAIL)).toBeDisabled();
    await mock("orca_overview", orcaOverview([], [], { state: "failed", message: "接続できません" }));
    await $(`${MAIL.pane} [aria-label="閉じる"]`).click();
    await $(MAIL.button).click();
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-notice`))[0]?.includes("読み込めませんでした: 接続できません"), { timeoutMsg: "the failed read was not told" });
  });

  it("shows the session after the send: its header, its history with the content folded, and the composer", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseWorktree(MAIL, "/work/example-app");
    await field(MAIL).setValue("原因を調べて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForCalls(handoff);
    // The history of the pane the launch named is read for the pane.
    const opens = await waitForOpens(1);
    expect(opens[0]).toEqual({ environment: null, path: "/work/example-app", paneKey: "tab_new:leaf_9", channel: true });
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-session-state`))[0] === "作業中 ・ 1 分", { timeoutMsg: "the state of the session was not shown" });
    await expect($(`${MAIL.pane} [aria-label="Orca の画面で開く"]`)).toBeDisplayed();
    await expect($(`${MAIL.pane} [aria-label="閉じる"]`)).toBeDisplayed();
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(0);
    // The user's message holds only the instruction; the content is one line that opens to its text, drawn as text.
    const shortTitle = `${[...subject].slice(0, 12).join("")}…`;
    await sendChat(chatItems([chatUser("u1", "原因を調べて", { kind: "mail", title: subject, text: `${mailBody}\n<b>not html</b>` }), chatAssistant("a1", "調べます")]));
    await waitForCount(`${MAIL.pane} .orca-user`, 1);
    expect(await textsOf(`${MAIL.pane} .orca-user-text`)).toEqual(["原因を調べて"]);
    const label = `メール「${shortTitle}」${[...`${mailBody}\n<b>not html</b>`].length} 字`;
    expect(await textsOf(`${MAIL.pane} .orca-ctx-label`)).toEqual([label]);
    const fold = $(`${MAIL.pane} .orca-ctx-btn`);
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect($(`${MAIL.pane} .orca-ctx-text`)).not.toBeDisplayed();
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect($(`${MAIL.pane} .orca-ctx-text`)).toBeDisplayed();
    expect(await textsOf(`${MAIL.pane} .orca-ctx-text`)).toEqual([`${mailBody}\n<b>not html</b>`]);
    expect(await count(`${MAIL.pane} .orca-ctx-text b`)).toBe(0);
    // More instructions go to the session's terminal with the command of the Orca screen.
    const post = await mock("orca_send", null);
    await field(MAIL).setValue("続けて");
    await expect(sendButton(MAIL)).toHaveText("送る");
    await sendButton(MAIL).click();
    expect(await waitForCalls(post)).toEqual([{ handle: "term_new", text: "続けて", environment: null }]);
    await expect(field(MAIL)).toHaveValue("");
  });

  it("keeps the text of a follow-up when it fails, and says that a session with no pane has no history", async () => {
    await openMail();
    await mock("orca_handoff", { paneKey: null, handle: "term_new" } satisfies OrcaStarted);
    await openPane(MAIL);
    await chooseWorktree(MAIL, "/work/example-app");
    await field(MAIL).setValue("始めて");
    await sendButton(MAIL).click();
    await expect($(`${MAIL.pane} .ho-note`)).toBeDisplayed();
    // No pane key came back: the session started, and the history is not read.
    expect(await chatOpens()).toHaveLength(0);
    await expect($(`${MAIL.pane} [aria-label="Orca の画面で開く"]`)).toBeDisplayed();
    await mock("orca_send", rejects("失敗しました"));
    await field(MAIL).setValue("続けて");
    await sendButton(MAIL).click();
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("失敗しました");
    await expect(field(MAIL)).toHaveValue("続けて");
  });

  it("shows the session again when the item is left and opened again, and the close icon forgets it", async () => {
    await openMail();
    await mock("orca_handoff", started);
    await mock("orca_chat_close", null);
    await openPane(MAIL);
    await chooseWorktree(MAIL, "/work/example-app");
    await field(MAIL).setValue("原因を調べて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForOpens(1);
    // Back to the list: the pane is gone and the read is let go.
    await $("#back").click();
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await browser.waitUntil(async () => (await callsOf("orca_chat_close")).length === 1, { timeoutMsg: "the read was not released" });
    // The same thread again: the pane is open on its session, and its history is read again.
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($(MAIL.pane)).toBeDisplayed();
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "true");
    await waitForOpens(2);
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    // Another thread has no session: its pane stays closed.
    await $("#back").click();
    await mock("thread", threadDetail("Second", "Other", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "false");
    await expect($(MAIL.pane)).not.toBeDisplayed();
    // The close icon of the session forgets it: the next open shows the form.
    await $("#back").click();
    await mock("thread", threadDetail(subject, mailBody, false));
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($(MAIL.pane)).toBeDisplayed();
    await $(`${MAIL.pane} [aria-label="閉じる"]`).click();
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await $(MAIL.button).click();
    // The destinations are back: the three agents of the sample and the session this test started (the list holds it now).
    await waitForCount(`${MAIL.pane} .ho-row`, 4);
    expect(await textsOf(`${MAIL.pane} .ho-new-btn`)).toEqual(["新しいセッション"]);
    expect(await count(`${MAIL.pane} .ho-session-name`)).toBe(0);
  });

  it("opens the session on the Orca screen, which reads its history, and the pane reads it again when the thread is opened again", async () => {
    await openMail();
    await mock("orca_handoff", started);
    await mock("orca_chat_close", null);
    await openPane(MAIL);
    await chooseWorktree(MAIL, "/work/example-app");
    await field(MAIL).setValue("原因を調べて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForOpens(1);
    await $(`${MAIL.pane} [aria-label="Orca の画面で開く"]`).click();
    await expect($("#orca")).toBeDisplayed();
    // The screen's own read takes it over from the pane: one session is read at a time.
    const opens = await waitForOpens(2);
    expect(opens[1]).toEqual({ environment: null, path: "/work/example-app", paneKey: "tab_new:leaf_9", channel: true });
    await expect($('#orca-tabs [role="tab"][aria-selected="true"]')).toBeDisplayed();
    // The history shows in the screen's box (the pane's one was wiped), with the folded content.
    await sendChat(chatItems([chatUser("u1", "原因を調べて", { kind: "mail", title: "題", text: "本文" }), chatAssistant("a1", "調べます")]));
    await waitForCount("#orca-items > *", 2);
    expect(await textsOf("#orca-items .orca-ctx-label")).toEqual(["メール「題」2 字"]);
    // Leaving the screen closes its own read.
    await $("#nav-mail").click();
    await browser.waitUntil(async () => (await callsOf("orca_chat_close")).length >= 1, { timeoutMsg: "the screen did not let its read go" });
    // The thread is open again: the pane has the read back, and the screen's box is empty.
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    await waitForOpens(3);
    await sendChat(chatItems([chatAssistant("a9", "戻りました")]));
    await waitForCount(`${MAIL.pane} .orca-assistant`, 1);
    expect(await count("#orca-items > *")).toBe(0);
    // Going to the Orca screen again hands the read to it again; the pane's tick must not take it back or close it.
    await $(`${MAIL.pane} [aria-label="Orca の画面で開く"]`).click();
    await waitForOpens(4);
    await browser.pause(1500);
    expect(await chatOpens()).toHaveLength(4);
    expect(await count(`${MAIL.pane} .orca-assistant`)).toBe(0);
  });

  it("opens from the header icon of a Todo, with its content as the card", async () => {
    await openTodo();
    await expect($(TODO.button)).toHaveAttribute("aria-label", "Orca に渡す");
    await expect($(TODO.button)).toHaveAttribute("aria-pressed", "false");
    const handoff = await mock("orca_handoff", started);
    await openPane(TODO);
    await expect($(TODO.button)).toHaveAttribute("aria-pressed", "true");
    await expect($("#todo-split")).toHaveAttribute("role", "separator");
    expect(await textsOf(`${TODO.pane} .ho-card-title`)).toEqual(["Write report"]);
    expect(await textsOf(`${TODO.pane} .ho-card-meta`)).toEqual(["説明なし ・ 今日"]);
    await chooseWorktree(TODO, "/work/example-app");
    await field(TODO).setValue("実装して");
    await sendButton(TODO).click();
    const [call] = (await waitForCalls(handoff)) as { destination: unknown; instruction: string; context: { kind: string; title: string; body: string } }[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-app" });
    expect(call.context.kind).toBe("todo");
    expect(call.context.title).toBe("Write report");
    expect(call.context.body).toContain("タスク: Write report");
    expect(call.context.body).toContain("プロジェクト: Work");
    // Back to the list: the pane is gone, and the icon is only for the detail.
    await $("#todo-back").click();
    await expect($(TODO.pane)).not.toBeDisplayed();
    await expect($(TODO.button)).not.toBeDisplayed();
    // The same task again shows its session.
    await $("#todo-list li.task").click();
    await expect($(`${TODO.pane} .ho-session-name`)).toBeDisplayed();
  });

  it("makes the right pane of the Slack thread tabs, Claude first and selected, and Orca hands the thread over", async () => {
    await openSlack();
    const tabs = $("#reply-tabs");
    await expect(tabs).toHaveAttribute("role", "tablist");
    await expect(tabs).toHaveAttribute("aria-label", "Claude と Orca");
    expect(await textsOf("#reply-tabs [role=tab]")).toEqual(["Claude", "Orca"]);
    await expect($("#reply-tab-claude")).toHaveAttribute("aria-selected", "true");
    await expect($("#reply-tab-orca")).toHaveAttribute("aria-selected", "false");
    await expect($("#reply-log")).toBeDisplayed();
    await expect($("#st-orca")).not.toBeDisplayed();
    const handoff = await mock("orca_handoff", started);
    await $("#reply-tab-orca").click();
    await expect($("#reply-tab-orca")).toHaveAttribute("aria-selected", "true");
    await expect($("#reply-tab-claude")).toHaveAttribute("aria-selected", "false");
    await expect($("#reply-log")).not.toBeDisplayed();
    await expect($("#reply-clear")).not.toBeDisplayed();
    await waitForCount(`${SLACK.pane} .ho-row`, 3);
    expect(await textsOf(`${SLACK.pane} .ho-card-title`)).toEqual(["#dev-billing のスレッド"]);
    expect(await textsOf(`${SLACK.pane} .ho-card-meta`)).toEqual(["Alice Example ほか ・ 2 件"]);
    await chooseWorktree(SLACK, "/work/example-api");
    await field(SLACK).setValue("返信案を作って");
    await sendButton(SLACK).click();
    const [call] = (await waitForCalls(handoff)) as { destination: unknown; context: { kind: string; title: string; body: string } }[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-api" });
    expect(call.context.kind).toBe("slack");
    expect(call.context.title).toBe("#dev-billing のスレッド");
    // Each message has its sender and its time.
    expect(call.context.body).toContain("Alice Example  ");
    expect(call.context.body).toContain("Please review the deploy notes.");
    expect(call.context.body).toContain("Bob Example  ");
    expect(call.context.body).toContain("Looks fine to me.");
    await waitForOpens(1);
    // Back to Claude: its pane is as it was, and the read is let go.
    await mock("orca_chat_close", null);
    await $("#reply-tab-claude").click();
    await expect($("#reply-log")).toBeDisplayed();
    await expect($("#st-orca")).not.toBeDisplayed();
    await browser.waitUntil(async () => (await callsOf("orca_chat_close")).length === 1, { timeoutMsg: "the read was not released" });
    // The Orca tab again: the session is shown, and its history is read again.
    await $("#reply-tab-orca").click();
    await waitForOpens(2);
    await expect($(`${SLACK.pane} [aria-label="Orca の画面で開く"]`)).toBeDisplayed();
  });
});
