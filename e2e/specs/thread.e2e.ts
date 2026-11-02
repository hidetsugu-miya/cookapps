import {
  account, boot, callsOf, claudeLoggedOut, claudeReady, count, holds, inbox, mock, rejects, release, rowOf, textsOf, threadDetail, waitForCalls, waitForCount, waitForText,
} from "../support";

describe("thread", () => {
  beforeEach(async () => {
    await boot({ inbox: inbox() });
    await waitForCount("#unread-threads li", 2);
  });

  it("opens an unread thread, shows subject and body, and marks it read", async () => {
    const open = await mock("thread", threadDetail("First unread", "Hello from Alice", true));
    const setRead = await mock("set_read", true);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("First unread");
    await expect($("#messages .plain")).toHaveText("Hello from Alice");
    await waitForCalls(open);
    expect(await callsOf(open)).toContainEqual({ account, id: "t1" });
    await waitForCalls(setRead);
    expect(await callsOf(setRead)).toContainEqual({ account, id: "t1", read: true });
    await waitForCount("#unread-threads li", 1);
  });

  it("opens a read thread without marking it read", async () => {
    const open = await mock("thread", threadDetail("Already read", "Old news", false));
    const setRead = await mock("set_read", true);
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("Already read");
    await waitForCalls(open);
    expect(await callsOf(open)).toContainEqual({ account, id: "t3" });
    expect(await callsOf(setRead)).toHaveLength(0);
  });
});

describe("thread AI summary", () => {
  const summary = { points: ["見積書の確認を求めています。", "期限は 11 月 5 日です。"] };
  // Two messages, oldest first as Gmail gives them: a plain-text one and an HTML one with a style and a script.
  const quote = (subject: string) => {
    const base = threadDetail(subject, "Please confirm the quote", false);
    const [older] = base.messages;
    const newer = {
      ...older,
      id: "m2",
      from: "Bob <bob@example.com>",
      dateMs: older.dateMs + 600_000,
      html: true,
      body: "<style>p { color: red }</style><p>Newest</p><script>x()</script><p>reply&nbsp;here</p>text<div>next</div><table><tr><td>100</td><td>200</td></tr></table>",
    };
    return { ...base, messages: [older, newer] };
  };
  const summaryButton = () => $("#thread-summary");
  const card = () => $("#mail-summary");

  // Opens the thread of the row with `row` as its subject, showing `detail`.
  async function open(row: "First unread" | "Second unread", detail: ReturnType<typeof quote>) {
    await mock("thread", detail);
    await rowOf("unread-threads", row).$(".subject").click();
    await expect($("#thread")).toBeDisplayed();
    await expect($("#thread-subject")).toHaveText(detail.subject);
  }

  beforeEach(async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCount("#unread-threads li", 2);
  });

  it("hides the icon while Claude is not logged in", async () => {
    await boot({ inbox: inbox() });
    await waitForCount("#unread-threads li", 2);
    await open("First unread", quote("Quote"));
    await expect($("#thread-slack")).toBeDisplayed();
    await expect(summaryButton()).not.toBeDisplayed();
  });

  it("shows the icon first in the toolbar while Claude is logged in", async () => {
    await open("First unread", quote("Quote"));
    await expect(summaryButton()).toBeDisplayed();
    await expect(summaryButton()).toHaveAttribute("aria-label", "AI 要約");
    const order = await browser.execute(() => [...document.querySelectorAll("#mail-header > button:not([hidden])")].map((b) => b.id));
    expect(order).toEqual(["back", "thread-summary", "thread-slack", "thread-todo", "trash", "archive"]);
  });

  it("follows the Claude state while a thread is open", async () => {
    await open("First unread", quote("Quote"));
    await expect(summaryButton()).toBeDisplayed();
    // The recheck button is on the settings screen; click it in the page as the settings screen would.
    const recheck = () => browser.execute(() => document.getElementById("claude-recheck")!.click());
    await mock("claude_status", claudeLoggedOut);
    await recheck();
    await expect(summaryButton()).not.toBeDisplayed();
    await mock("claude_status", claudeReady);
    await recheck();
    await expect(summaryButton()).toBeDisplayed();
  });

  it("sends the thread only when the icon is pressed, as text, and shows the points", async () => {
    const detail = quote("Quote");
    await open("First unread", detail);
    const call = await mock("claude_summarize_mail", summary);
    await expect(card()).not.toBeDisplayed();
    expect(await callsOf(call)).toHaveLength(0);
    await summaryButton().click();
    const [older, newer] = detail.messages;
    expect(await waitForCalls(call)).toEqual([
      {
        subject: "Quote",
        messages: [
          { from: older.from, dateMs: older.dateMs, text: "Please confirm the quote" },
          { from: newer.from, dateMs: newer.dateMs, text: "Newest\n\nreply here\ntext\nnext\n\n100 200" },
        ],
      },
    ]);
    await waitForCount("#mail-summary li", 2);
    expect(await textsOf("#mail-summary li")).toEqual(summary.points);
    expect(await textsOf("#mail-summary .summary-head")).toEqual(["AI 要約"]);
  });

  it("draws the points as plain text, never as HTML or links", async () => {
    await open("First unread", quote("Quote"));
    await mock("claude_summarize_mail", { points: ["<b>bold</b> https://example.com/x"] });
    await summaryButton().click();
    await waitForCount("#mail-summary li", 1);
    expect(await textsOf("#mail-summary li")).toEqual(["<b>bold</b> https://example.com/x"]);
    expect(await count("#mail-summary b, #mail-summary a")).toBe(0);
  });

  it("shows a failure with a retry button, and sends again on retry", async () => {
    await open("First unread", quote("Quote"));
    await mock("claude_summarize_mail", rejects("Claude が時間内に終わりませんでした"));
    await summaryButton().click();
    await waitForText("#mail-summary", "Claude が時間内に終わりませんでした");
    expect(await textsOf("#mail-summary .summary-head")).toEqual(["要約できませんでした"]);
    const retry = await mock("claude_summarize_mail", summary);
    await $("#mail-summary .text-btn").click();
    expect(await waitForCalls(retry)).toHaveLength(1);
    await waitForCount("#mail-summary li", 2);
    expect(await textsOf("#mail-summary li")).toEqual(summary.points);
  });

  it("forgets a failure with the close button", async () => {
    await open("First unread", quote("Quote"));
    const call = await mock("claude_summarize_mail", rejects("Claude が時間内に終わりませんでした"));
    await summaryButton().click();
    await waitForText("#mail-summary", "Claude が時間内に終わりませんでした");
    await $("#mail-summary .icon-btn").click();
    await expect(card()).not.toBeDisplayed();
    expect(await callsOf(call)).toHaveLength(1);
  });

  it("shows a kept summary again with the icon, or when the thread is reopened, without sending it again", async () => {
    const detail = quote("Quote");
    await open("First unread", detail);
    const call = await mock("claude_summarize_mail", summary);
    await summaryButton().click();
    await waitForCount("#mail-summary li", 2);
    await $("#mail-summary .icon-btn").click();
    await expect(card()).not.toBeDisplayed();
    await summaryButton().click();
    await waitForCount("#mail-summary li", 2);
    await $("#back").click();
    await open("First unread", detail);
    await waitForCount("#mail-summary li", 2);
    expect(await callsOf(call)).toHaveLength(1);
  });

  it("starts again with no card when the thread got a new message, and sends the new thread when the icon is pressed", async () => {
    const detail = quote("Quote");
    await open("First unread", detail);
    const call = await mock("claude_summarize_mail", summary);
    await summaryButton().click();
    await waitForCount("#mail-summary li", 2);
    await $("#back").click();
    const [older, newer] = detail.messages;
    const reply = { ...newer, id: "m3", dateMs: newer.dateMs + 600_000, html: false, body: "Thanks, got it" };
    await open("First unread", { ...detail, messages: [older, newer, reply] });
    await expect(card()).not.toBeDisplayed();
    await summaryButton().click();
    const calls = (await waitForCalls(call, 2)) as { messages: { text: string }[] }[];
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.map((m) => m.text)).toContain("Thanks, got it");
    await waitForCount("#mail-summary li", 2);
  });

  it("does not start a second summary while one is being made", async () => {
    await open("First unread", quote("Quote"));
    const call = await mock("claude_summarize_mail", holds);
    await summaryButton().click();
    await waitForCalls(call);
    await summaryButton().click();
    expect(await callsOf(call)).toHaveLength(1);
    expect(await textsOf("#mail-summary")).toEqual(["Claude が要約しています…"]);
    expect(await count("#mail-summary .icon-btn")).toBe(0);
    await release(call, summary);
    await waitForCount("#mail-summary li", 2);
  });

  it("does not draw a result that arrives after another thread was opened, and shows it when its thread is opened again", async () => {
    const detail = quote("Quote");
    await open("First unread", detail);
    const call = await mock("claude_summarize_mail", holds);
    await summaryButton().click();
    await waitForCalls(call);
    await $("#back").click();
    await open("Second unread", quote("Other"));
    await release(call, summary);
    await expect(card()).not.toBeDisplayed();
    await $("#back").click();
    await open("First unread", detail);
    await waitForCount("#mail-summary li", 2);
    expect(await callsOf(call)).toHaveLength(1);
  });
});
