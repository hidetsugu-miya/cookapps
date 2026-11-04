import {
  boot, callsOf, claudeLoggedOut, claudeMissing, claudeReady, count, holds, inbox, mock, onceId, permalinkOf, pngUri, rejects, release, replyEdit, slackFile, slackSummary, slackThread, slackLoad, slackTs, textsOf, thumbUrlOf,
  threadMessage, timeline, timelineMessage, todoData, waitForCalls, waitForCount, workspace, claudeSettings,
} from "../support";

const iconUrl = "https://avatars.slack-edge.com/T1-U1/a_72.png";
const root = slackTs(60, 1);
const reply1 = slackTs(50, 2);
const rootText = "Please review the deploy notes.";

// A thread of the root message and one reply, as `slack_thread` answers it.
const base = () => slackThread([threadMessage(root, "Alice Example", rootText), threadMessage(reply1, "Bob Example", "Looks fine to me.")]);
// The root message as the list shows it.
const listMessage = () => timelineMessage(root, "Alice Example", "dev", rootText, { replyCount: 1 });

const input = () => $("#st-input");
const send = () => $("#st-send");
const names = () => textsOf("#st-msgs .st-meta b");

// The app with `messages` on the list (the root message by default), the Slack screen open, and the thread of the first row opened; `slack_thread` answers `value`.
async function openDetail(fixtures: Record<string, unknown> = {}, value = base(), messages = [listMessage()]) {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady, ...fixtures });
  const read = await mock("slack_thread", value);
  await $("#nav-slack").click();
  await waitForCount("#slack-feed .feed-row", messages.length);
  await $("#slack-feed .feed-row").click();
  await expect($("#slack-thread")).toBeDisplayed();
  await waitForCount("#st-msgs .st-msg", value.messages.length);
  return read;
}

// Cmd+Enter (Ctrl+Enter off macOS) in the reply field, sent as the key event the app listens for; plain Enter when `plain`.
const pressReply = (plain = false) =>
  browser.execute(
    (id, p) => {
      if (!window.__e2e_once__(id)) return;
      const isMac = /Mac/.test(navigator.platform);
      document.getElementById("st-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: !p && isMac, ctrlKey: !p && !isMac, bubbles: true, cancelable: true }));
    },
    onceId(),
    plain,
  );

const heightOf = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().height, selector);

describe("slack thread", () => {
  it("opens from a row of the list and reads its thread with the workspace, the channel and the message's own timestamp", async () => {
    const read = await openDetail();
    expect(await callsOf(read)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root }]);
    await expect($("#st-channel")).toHaveText("#dev");
    await expect($("#st-team")).toHaveText(workspace.team);
    await expect($("#slack-list")).not.toBeDisplayed();
  });

  it("opens the thread of a reply sent to the channel by the timestamp of its thread", async () => {
    const reply = timelineMessage(reply1, "Bob Example", "dev", "Looks fine to me.", { threadTs: root });
    const read = await openDetail({}, base(), [reply]);
    expect(await callsOf(read)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root }]);
  });

  it("draws the messages oldest first with the sender, the time and the text, and 返信 N 件 after the first", async () => {
    await openDetail();
    expect(await names()).toEqual(["Alice Example", "Bob Example"]);
    expect(await textsOf("#st-msgs .st-text")).toEqual([rootText, "Looks fine to me."]);
    expect(await textsOf("#st-msgs .st-sep")).toEqual(["返信 1 件"]);
    // The separator sits between the first message and the first reply.
    expect(await browser.execute(() => [...document.querySelector("#st-msgs")!.children].map((e) => e.className))).toEqual(["st-msg", "st-sep", "st-msg"]);
    for (const time of await textsOf("#st-msgs .st-meta time")) expect(time).toMatch(/\d{1,2}:\d{2}/);
  });

  it("has no separator for a thread of one message", async () => {
    await openDetail({}, slackThread([threadMessage(root, "Alice Example", rootText)]));
    expect(await count("#st-msgs .st-sep")).toBe(0);
  });

  it("shows the text as text, and turns only its URLs into links", async () => {
    await openDetail({}, slackThread([threadMessage(root, "Alice Example", "<b>not bold</b> see https://example.com/plan today")]));
    await expect($("#st-msgs .st-text")).toHaveText("<b>not bold</b> see https://example.com/plan today");
    expect(await count("#st-msgs .st-text b")).toBe(0);
    await expect($("#st-msgs .st-text a")).toHaveAttribute("href", "https://example.com/plan");
  });

  it("links 'Slack で開く' to the message's permalink", async () => {
    await openDetail();
    await expect($("#st-open")).toHaveAttribute("href", permalinkOf(root));
    await expect($("#st-open")).toHaveAttribute("aria-label", "Slack で開く");
  });

  it("puts the sender icons on the avatars through fetch_images", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady, slack_timeline: timeline([listMessage()]) });
    await mock("slack_thread", slackThread([threadMessage(root, "Alice Example", rootText, { iconUrl }), threadMessage(reply1, "Bob Example", "Looks fine to me.")]));
    const fetch = await mock("fetch_images", { [iconUrl]: pngUri });
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-row").click();
    expect((await waitForCalls(fetch)).at(-1)).toEqual({ urls: [iconUrl] });
    await browser.waitUntil(async () => (await count("#st-msgs .st-avatar img.av-img")) === 1);
    expect(await textsOf("#st-msgs .st-avatar .av-text")).toEqual(["BE"]);
  });

  it("goes back to the list where it was scrolled to and reads nothing again", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `A message of the list, number ${i}`));
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady });
    await mock("slack_thread", slackThread([threadMessage(messages[8].ts, "Person 8", "A message of the list, number 8")]));
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 20);
    await browser.execute(() => {
      document.getElementById("slack-feed")!.scrollTop = 300;
    });
    // A click of the page itself: the browser would scroll a clicked row into view first.
    await browser.execute((id) => window.__e2e_once__(id) && document.querySelectorAll<HTMLElement>("#slack-feed .feed-row")[8].click(), onceId());
    await expect($("#slack-thread")).toBeDisplayed();
    const reads = (await callsOf("slack_timeline")).length;
    await $("#st-back").click();
    await expect($("#slack-list")).toBeDisplayed();
    await expect($("#slack-thread")).not.toBeDisplayed();
    expect(await browser.execute(() => document.getElementById("slack-feed")!.scrollTop)).toBe(300);
    expect((await callsOf("slack_timeline")).length).toBe(reads);
  });

  it("stays on the thread while the list is read again in the background", async () => {
    await openDetail({ slack_timeline: timeline([listMessage()], { refreshSecs: 1 }) });
    await waitForCalls("slack_timeline", 2);
    await expect($("#slack-thread")).toBeDisplayed();
  });

  it("shows the error in the pane when the thread cannot be read, and reads again from 再読み込み", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    await mock("slack_thread", rejects("読めません"));
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-row").click();
    await expect($("#st-msgs .pending.fail")).toHaveText(expect.stringContaining("読み込めませんでした: 読めません"));
    await mock("slack_thread", base());
    await $("#st-msgs .pending.fail .text-btn").click();
    await waitForCount("#st-msgs .st-msg", 2);
  });

  it("shows a spinner while the thread is read", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    const read = await mock("slack_thread", holds);
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-row").click();
    await waitForCalls(read);
    await expect($("#st-msgs .spin")).toBeDisplayed();
    await release(read, base());
    await waitForCount("#st-msgs .st-msg", 2);
  });
});

describe("slack thread: attached files", () => {
  const withFiles = () =>
    slackThread([
      threadMessage(root, "Alice Example", rootText, {
        files: [slackFile("F1", "design.png", { thumbUrl: thumbUrlOf("F1") }), slackFile("F2", "notes.pdf", { mimetype: "application/pdf" })],
      }),
    ]);

  it("shows a placeholder for an image until slack_file_images answers, then the thumbnail linked to the file in Slack", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    await mock("slack_thread", withFiles());
    const images = await mock("slack_file_images", holds);
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-row").click();
    expect(await waitForCalls(images)).toEqual([{ teamId: workspace.teamId, urls: [thumbUrlOf("F1")] }]);
    await expect($("#st-msgs .st-thumb.loading")).toBeDisplayed();
    expect(await count("#st-msgs .st-img")).toBe(0);
    await release(images, { [thumbUrlOf("F1")]: pngUri });
    await browser.waitUntil(async () => (await count("#st-msgs .st-img")) === 1);
    expect(await count("#st-msgs .st-thumb.loading")).toBe(0);
    await expect($("#st-msgs .st-thumb")).toHaveAttribute("href", slackFile("F1", "design.png").permalink as string);
    expect(await browser.execute(() => document.querySelector<HTMLImageElement>("#st-msgs .st-img")!.src)).toBe(pngUri);
  });

  it("shows a file that is not an image as a chip with its name that opens the file in Slack", async () => {
    await openDetail({}, withFiles());
    const chip = $("#st-msgs a.st-file");
    await expect(chip).toHaveText("notes.pdf");
    await expect(chip).toHaveAttribute("href", slackFile("F2", "notes.pdf").permalink as string);
  });

  it("falls back to the file's name as a chip when the image cannot be fetched", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    await mock("slack_thread", withFiles());
    await mock("slack_file_images", {});
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-row").click();
    await waitForCount("#st-msgs a.st-file", 2);
    expect(await textsOf("#st-msgs a.st-file")).toEqual(["design.png", "notes.pdf"]);
    expect(await count("#st-msgs .st-thumb")).toBe(0);
  });

  it("asks for no image when the thread has none", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    await mock("slack_thread", base());
    const images = await mock("slack_file_images", {});
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-row").click();
    await waitForCount("#st-msgs .st-msg", 2);
    await browser.pause(200);
    expect(await callsOf(images)).toEqual([]);
  });
});

describe("slack thread: reply", () => {
  it("has a three-line field with the placeholder スレッドに返信, and 返信する is off while it is blank", async () => {
    await openDetail();
    await expect(input()).toHaveAttribute("placeholder", "スレッドに返信");
    await expect(input()).toHaveAttribute("rows", "3");
    await expect(send()).toBeDisabled();
    expect(await heightOf("#st-input")).toBeGreaterThanOrEqual(60);
    await input().setValue("   ");
    await expect(send()).toBeDisabled();
    await input().setValue("Thanks");
    await expect(send()).toBeEnabled();
  });

  it("grows with its text up to six lines, then scrolls", async () => {
    await openDetail();
    const lines = (n: number) =>
      browser.execute((count) => {
        const area = document.getElementById("st-input") as HTMLTextAreaElement;
        area.value = Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
        area.dispatchEvent(new Event("input", { bubbles: true }));
      }, n);
    await lines(3);
    const three = await heightOf("#st-input");
    await lines(5);
    expect(await heightOf("#st-input")).toBeGreaterThan(three);
    await lines(12);
    expect(await heightOf("#st-input")).toBe(120);
  });

  it("posts with slack_reply on Cmd+Enter (Ctrl+Enter off macOS), empties the field, reads the thread again and says so", async () => {
    const read = await openDetail();
    const post = await mock("slack_reply", true);
    await input().setValue("Thanks, will do");
    await pressReply();
    expect(await waitForCalls(post)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", threadTs: root, text: "Thanks, will do" }]);
    await expect($("#st-note")).toHaveText("スレッドに返信しました");
    await expect(input()).toHaveValue("");
    await waitForCalls(read, 2);
  });

  it("posts with the button 返信する too, and takes plain Enter as a line break", async () => {
    await openDetail();
    const post = await mock("slack_reply", true);
    await input().setValue("First line");
    await pressReply(true);
    expect(await callsOf(post)).toEqual([]);
    await send().click();
    expect((await waitForCalls(post))[0]).toEqual({ teamId: workspace.teamId, channel: "C0123ABCD", threadTs: root, text: "First line" });
  });

  it("shows the thread's new end after a reply, scrolled to it", async () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => threadMessage(slackTs(100 - i, i), `Person ${i}`, "a line\nanother line\nand a third line"));
    await openDetail({}, slackThread(long(12)));
    const after = slackThread([...long(12), threadMessage(slackTs(0), "Alice Example", "Thanks, will do")]);
    await mock("slack_reply", true);
    await mock("slack_thread", after);
    await input().setValue("Thanks, will do");
    await pressReply();
    await waitForCount("#st-msgs .st-msg", 13);
    await browser.waitUntil(async () => browser.execute(() => {
      const box = document.getElementById("st-msgs")!;
      return box.scrollHeight > box.clientHeight && box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    }));
  });

  it("shows a failed reply on the thread and keeps the text", async () => {
    await openDetail();
    await mock("slack_reply", rejects("投稿できません"));
    await input().setValue("Keep me");
    await send().click();
    await expect($("#st-error")).toHaveText(expect.stringContaining("返信できませんでした: 投稿できません"));
    await expect(input()).toHaveValue("Keep me");
    await expect(send()).toBeEnabled();
    expect(await callsOf("slack_thread")).toHaveLength(1);
  });

  it("locks the field and the button while the reply is on its way", async () => {
    await openDetail();
    const post = await mock("slack_reply", holds);
    await input().setValue("Wait for it");
    await send().click();
    await waitForCalls(post);
    await expect(input()).toBeDisabled();
    await expect(send()).toBeDisabled();
    await release(post, true);
    await expect(input()).toBeEnabled();
  });

  it("keeps the reply per thread in memory, and starts another thread with an empty field", async () => {
    const other = slackTs(20, 3);
    const messages = [listMessage(), timelineMessage(other, "Carol Example", "general", "Another thread")];
    await openDetail({}, base(), messages);
    await input().setValue("Draft of the first thread");
    await $("#st-back").click();
    await mock("slack_thread", slackThread([threadMessage(other, "Carol Example", "Another thread")]));
    await $("#slack-feed .feed-row:nth-child(2)").click();
    await waitForCount("#st-msgs .st-msg", 1);
    await expect(input()).toHaveValue("");
    await input().setValue("Draft of the second");
    await $("#st-back").click();
    await mock("slack_thread", base());
    await $("#slack-feed .feed-row:nth-child(1)").click();
    await waitForCount("#st-msgs .st-msg", 2);
    await expect(input()).toHaveValue("Draft of the first thread");
  });
});

describe("slack thread: Todo", () => {
  const todo = { todoist_connected: true, todoist_load: todoData() };
  const cardOf = () => $("#st-card .review");

  it("is offered only while Claude is usable and Todoist is connected", async () => {
    await openDetail(todo);
    await expect($("#st-todo")).toBeDisplayed();
    await openDetail({ ...todo, claude_status: claudeLoggedOut });
    await waitForCalls("todoist_connected");
    await expect($("#st-todo")).not.toBeDisplayed();
    await openDetail({ ...todo, claude_status: claudeMissing });
    await waitForCalls("todoist_connected");
    await expect($("#st-todo")).not.toBeDisplayed();
    await openDetail({ todoist_connected: false });
    await waitForCalls("todoist_connected");
    await expect($("#st-todo")).not.toBeDisplayed();
  });

  it("summarises the message by its permalink and shows the card above the reply field", async () => {
    await openDetail(todo);
    const summary = await mock("todoist_summarize_slack", slackSummary);
    await $("#st-todo").click();
    expect(await waitForCalls(summary)).toEqual([{ url: permalinkOf(root) }]);
    await expect(cardOf()).toBeDisplayed();
    await expect($("#st-card .review-name")).toHaveValue(slackSummary.content);
    // The card sits above the reply field and has no link to the prompt screen.
    expect(await browser.execute(() => document.getElementById("st-card")!.compareDocumentPosition(document.getElementById("st-reply")!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    expect(await count("#st-card .link-btn")).toBe(0);
  });

  it("shows the button busy while the summary is on its way", async () => {
    await openDetail(todo);
    const summary = await mock("todoist_summarize_slack", holds);
    await $("#st-todo").click();
    await waitForCalls(summary);
    await expect($("#st-todo")).toBeDisabled();
    await expect($("#st-todo .spin")).toBeDisplayed();
    await release(summary, slackSummary);
    await expect(cardOf()).toBeDisplayed();
    await expect($("#st-todo")).toBeEnabled();
  });

  it("adds the task with todoist_add_from_slack, closes the card and says so", async () => {
    await openDetail(todo);
    await mock("todoist_summarize_slack", slackSummary);
    const add = await mock("todoist_add_from_slack", "Reply to the vendor");
    await $("#st-todo").click();
    await expect(cardOf()).toBeDisplayed();
    await $("#st-card .review-add").click();
    expect(await waitForCalls(add)).toEqual([
      { url: permalinkOf(root), content: slackSummary.content, description: slackSummary.description, due: "2026-11-06", projectId: null, today: false },
    ]);
    await expect($("#st-note")).toHaveText("Todo に追加しました");
    expect(await count("#st-card .review")).toBe(0);
  });

  it("closes the card with 破棄 and creates nothing", async () => {
    await openDetail(todo);
    await mock("todoist_summarize_slack", slackSummary);
    const add = await mock("todoist_add_from_slack", "x");
    await $("#st-todo").click();
    await expect(cardOf()).toBeDisplayed();
    await $("#st-card .review-drop").click();
    expect(await count("#st-card .review")).toBe(0);
    expect(await callsOf(add)).toEqual([]);
  });

  it("shows why the summary failed", async () => {
    await openDetail(todo);
    await mock("todoist_summarize_slack", rejects("Claude が応答しません"));
    await $("#st-todo").click();
    await expect($("#st-note")).toHaveText("要約できませんでした: Claude が応答しません");
    expect(await count("#st-card .review")).toBe(0);
  });
});

describe("slack thread: proofreading with Claude", () => {
  const log = "#reply-log";
  const apply = () => $("#reply-log .diff-foot .text-btn.primary");

  it("sends 校正してください with the reply text, and applying the proposal fills the field without posting", async () => {
    await openDetail();
    const post = await mock("slack_reply", true);
    const edit = await mock("claude_proofread_reply", replyEdit("確認おねがいします", "ご確認をお願いします"));
    await input().setValue("確認おねがいします");
    await $("#reply-proofread").click();
    expect(await waitForCalls(edit)).toEqual([{ text: "確認おねがいします", history: [], instruction: "校正してください" }]);
    await waitForCount(`${log} .chat-ai`, 1);
    await expect($(`${log} .chat-user`)).toHaveText("校正してください");
    await expect($(`${log} .diff-ins`)).toHaveText("+ ご確認をお願いします");
    await apply().click();
    await expect(input()).toHaveValue("ご確認をお願いします");
    await expect($(`${log} .diff-state`)).toHaveText("適用しました");
    expect(await callsOf(post)).toEqual([]);
    await expect($("#slack-thread")).toBeDisplayed();
  });

  it("sends only the reply text, the conversation and the request, never the thread's messages", async () => {
    await openDetail();
    const edit = await mock("claude_proofread_reply", replyEdit("a", "b"));
    await input().setValue("My reply");
    await $("#reply-input").setValue("敬語にして");
    await $("#reply-send").click();
    const [call] = await waitForCalls(edit);
    expect(Object.keys(call as object).sort()).toEqual(["history", "instruction", "text"]);
    expect(JSON.stringify(call)).not.toContain(rootText);
  });

  it("cannot apply an old proposal once the field was changed", async () => {
    await openDetail();
    await mock("claude_proofread_reply", replyEdit("My reply", "My better reply"));
    await input().setValue("My reply");
    await $("#reply-proofread").click();
    await waitForCount(`${log} .chat-ai`, 1);
    await expect(apply()).toBeEnabled();
    await input().setValue("My reply, edited");
    await expect(apply()).toBeDisabled();
    await expect($(`${log} .diff-stale`)).toBeDisplayed();
  });

  it("cannot be asked while the reply is blank, and is off with a note while Claude is not logged in", async () => {
    await openDetail();
    await expect($("#reply-proofread")).toBeDisabled();
    await expect($("#reply-send")).toBeDisabled();
    await openDetail({ claude_status: claudeLoggedOut });
    await input().setValue("My reply");
    await expect($("#reply-proofread")).toBeDisabled();
    await expect($("#reply-chat-note")).toBeDisplayed();
    // The reply itself can still be posted.
    await expect(send()).toBeEnabled();
  });

  it("forgets the conversation with two presses of クリア", async () => {
    await openDetail();
    await mock("claude_proofread_reply", replyEdit("My reply", "My better reply"));
    await input().setValue("My reply");
    await $("#reply-proofread").click();
    await waitForCount(`${log} .chat-ai`, 1);
    await $("#reply-clear").click();
    await expect($("#reply-clear")).toHaveText("もう一度押すとクリア");
    await $("#reply-clear").click();
    expect(await count(`${log} .chat-user`)).toBe(0);
  });

  it("drops an answer that arrives after another thread was opened", async () => {
    const other = slackTs(20, 3);
    const messages = [listMessage(), timelineMessage(other, "Carol Example", "general", "Another thread")];
    await openDetail({}, base(), messages);
    const edit = await mock("claude_proofread_reply", holds);
    await input().setValue("My reply");
    await $("#reply-proofread").click();
    await waitForCalls(edit);
    await $("#st-back").click();
    await mock("slack_thread", slackThread([threadMessage(other, "Carol Example", "Another thread")]));
    await $("#slack-feed .feed-row:nth-child(2)").click();
    await waitForCount("#st-msgs .st-msg", 1);
    await release(edit, replyEdit("My reply", "My better reply"));
    await browser.pause(300);
    expect(await count(`${log} .chat-ai`)).toBe(0);
    expect(await count(`${log} .chat-diff`)).toBe(0);
  });

  it("shows the model and effort of the Slack reply under the request field, Sonnet and high by default, and saves a change as slackReply", async () => {
    await openDetail();
    const model = $('#reply-model select[data-kind="model"]');
    const effort = $('#reply-model select[data-kind="effort"]');
    await expect(model).toHaveValue("sonnet");
    await expect(effort).toHaveValue("high");
    await expect(effort).toHaveAttribute("data-effort", "high");
    const save = await mock("claude_model_settings_save", { ...claudeSettings, slackReply: { model: "opus", effort: "medium" } });
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      const select = document.querySelector<HTMLSelectElement>('#reply-model select[data-kind="model"]')!;
      select.value = "opus";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, onceId());
    expect(await waitForCalls(save)).toEqual([{ purpose: "slackReply", model: "opus" }]);
    await expect(model).toHaveValue("opus");
    await expect(effort).toHaveValue("medium");
  });
});

describe("slack thread: the divider", () => {
  const share = () =>
    browser.execute(() => document.getElementById("reply-chat")!.getBoundingClientRect().width / document.getElementById("slack-thread")!.getBoundingClientRect().width);
  const press = (key: string) =>
    browser.execute(
      (id, k) => window.__e2e_once__(id) && document.getElementById("reply-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })),
      onceId(),
      key,
    );

  it("is a vertical separator that starts at a third, and is moved by the arrow keys between a third and a half", async () => {
    await openDetail();
    const split = $("#reply-split");
    await expect(split).toHaveAttribute("role", "separator");
    await expect(split).toHaveAttribute("aria-orientation", "vertical");
    await expect(split).toHaveAttribute("aria-valuenow", "33");
    expect(await share()).toBeCloseTo(1 / 3, 2);
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(await share()).toBeCloseTo(1 / 3 + 0.04, 2);
    for (let i = 0; i < 20; i++) await press("ArrowLeft");
    expect(await share()).toBeCloseTo(0.5, 2);
    await expect(split).toHaveAttribute("aria-valuenow", "50");
    for (let i = 0; i < 30; i++) await press("ArrowRight");
    expect(await share()).toBeCloseTo(1 / 3, 2);
  });

  it("sets the Claude width by dragging, and keeps its own width apart from the compose screen's", async () => {
    await openDetail();
    await browser.execute(() => {
      const box = document.getElementById("slack-thread")!.getBoundingClientRect();
      const at = (x: number): PointerEventInit => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: box.left + box.width * x, clientY: box.top + 80 });
      document.getElementById("reply-split")!.dispatchEvent(new PointerEvent("pointerdown", at(0.6)));
      document.dispatchEvent(new PointerEvent("pointermove", at(0.6)));
      document.dispatchEvent(new PointerEvent("pointerup", at(0.6)));
    });
    expect(await share()).toBeCloseTo(0.4, 2);
    await expect($("#reply-split")).toHaveAttribute("aria-valuenow", "40");
    // The compose screen's divider is another one, still at its own start.
    expect(await browser.execute(() => document.getElementById("slack-split")!.getAttribute("aria-valuenow"))).toBe("33");
  });
});
