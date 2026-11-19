import type { ThreadBlock } from "../../ts/bindings/ThreadBlock";
import { askScreen, attachment, boot, callsOf, emojiCatalog, claudeLoggedOut, claudeMissing, claudeReady, count, holds, inbox, mock, onceId, permalinkOf, pngUri, reaction, rejects, release, slackFile, slackSummary, slackThread, slackLoad, slackTs, textsOf, thumbUrlOf, linkSpan, para, plain, quote, span, threadMessage, timeline, timelineMessage, todoData, waitForCalls, waitForCount, workspace, heightOf, TOOLS } from "../support";

const iconUrl = "https://avatars.slack-edge.com/T1-U1/a_72.png";
const root = slackTs(60, 1);
const reply1 = slackTs(50, 2);
const rootText = "Please review the deploy notes.";

// A thread of the root message and one reply, as `slack_thread` answers it.
const base = () => slackThread([threadMessage(root, "Alice Example", rootText), threadMessage(reply1, "Bob Example", "Looks fine to me.")]);
// The root message as the list shows it.
const listMessage = () => timelineMessage(root, "Alice Example", "dev", rootText, { replyCount: 1 });

// The editable part of the rich reply field (Milkdown's ProseMirror), the send arrow, and a toolbar button by name (S-6).
const field = () => $("#st-input .ProseMirror");
const send = () => $("#st-send");
const tool = (name: string) => $(`#st-tools [aria-label="${name}"]`);
const editable = () => field().getAttribute("contenteditable");
// Types `text` in the field, once Milkdown has made it editable.
const write = async (text: string) => {
  await browser.waitUntil(async () => (await editable()) === "true");
  await field().click();
  await browser.keys(text.split(""));
};
const selectAll = () => browser.keys(["Meta", "a"]);
const fieldText = () => browser.execute(() => (document.querySelector("#st-input .ProseMirror") as HTMLElement).innerText.trim());
// Replaces the text with `n` lines.
const lines = async (n: number) => {
  await browser.waitUntil(async () => (await editable()) === "true");
  await field().click();
  await selectAll();
  await browser.keys(Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n").split("").map((c) => (c === "\n" ? "Enter" : c)));
};
const names = () => textsOf("#st-msgs .st-meta b");

// The app with `messages` on the list (the root message by default), the Slack screen open, and the thread of the first row opened; `slack_thread` answers `value`.
async function openDetail(fixtures: Record<string, unknown> = {}, value = base(), messages = [listMessage()]) {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady, ...fixtures });
  const read = await mock("slack_thread", value);
  await $("#nav-slack").click();
  await waitForCount("#slack-feed .feed-row", messages.length);
  await $$("#slack-feed .feed-open")[0].click();
  await expect($("#slack-thread")).toBeDisplayed();
  await waitForCount("#st-msgs .st-msg", value.messages.length);
  return read;
}

// Cmd+Enter (Ctrl+Enter off macOS) in the reply field, sent as the key event the app listens for.
const pressReply = () =>
  browser.execute((id) => {
    if (!window.__e2e_once__(id)) return;
    const isMac = /Mac/.test(navigator.platform);
    document.querySelector("#st-input .ProseMirror")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }));
  }, onceId());


describe("slack thread", () => {
  it("opens from a row of the list and reads its thread with the workspace, the channel and the message's own timestamp", async () => {
    const read = await openDetail();
    expect(await callsOf(read)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root }]);
    await expect($("#st-channel")).toHaveText("#dev");
    await expect($("#st-team")).toHaveText(workspace.team);
    await expect($("#slack-list")).not.toBeDisplayed();
  });

  it("makes the header a place to drag the window by", async () => {
    await openDetail();
    await expect($("#st-head")).toHaveAttribute("data-tauri-drag-region", "deep");
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

  it("says at the end of the messages that newer replies were not read when the thread was cut", async () => {
    await openDetail({}, { ...base(), truncated: true });
    expect(await textsOf("#st-msgs .st-sep")).toEqual(["返信 1 件", "これより新しい返信は読めていません"]);
    expect(await browser.execute(() => document.querySelector("#st-msgs")!.lastElementChild!.className)).toBe("st-sep");
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
    await $("#slack-feed .feed-open").click();
    expect((await waitForCalls(fetch)).at(-1)).toEqual({ urls: [iconUrl] });
    await browser.waitUntil(async () => (await count("#st-msgs .st-avatar img.av-img")) === 1);
    expect(await textsOf("#st-msgs .st-avatar .av-text")).toEqual(["BE"]);
  });

  it("tells Rust the newest reply it read, to move a watched thread's seen position, and only when the thread has replies", async () => {
    await openDetail();
    expect(await waitForCalls("slack_watch_seen")).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root, latestTs: reply1 }]);
    // A thread with no reply sends nothing.
    await $("#st-back").click();
    await mock("slack_watch_seen", true);
    await mock("slack_thread", slackThread([threadMessage(root, "Alice Example", rootText)]));
    await $("#slack-feed .feed-open").click();
    await waitForCount("#st-msgs .st-msg", 1);
    await browser.pause(300);
    expect(await callsOf("slack_watch_seen")).toEqual([]);
  });

  it("tells Rust the newest reply it read, to move the seen position of a thread that is not watched, and makes the list again from its cache only when that moved something", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady, slack_timeline: timeline([listMessage()]) });
    await mock("slack_thread", slackThread([threadMessage(root, "Alice Example", rootText), threadMessage(reply1, "Bob Example", "Looks fine to me.")]));
    const seen = await mock("slack_thread_seen", false);
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    const read = await mock("slack_timeline", timeline([listMessage()]));
    await $("#slack-feed .feed-open").click();
    expect(await waitForCalls(seen)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root, latestTs: reply1 }]);
    await browser.pause(300);
    expect(await callsOf(read)).toEqual([]);
    await $("#st-back").click();
    await mock("slack_thread_seen", true);
    await $("#slack-feed .feed-open").click();
    expect(await waitForCalls(read)).toEqual([{ cached: true }]);
    await expect($("#slack-thread")).toBeDisplayed();
    // A thread with no reply sends nothing.
    await $("#st-back").click();
    await mock("slack_thread_seen", true);
    await mock("slack_thread", slackThread([threadMessage(root, "Alice Example", rootText)]));
    await $("#slack-feed .feed-open").click();
    await waitForCount("#st-msgs .st-msg", 1);
    await browser.pause(300);
    expect(await callsOf("slack_thread_seen")).toEqual([]);
  });

  it("goes back to the list where it was scrolled to and reads nothing again", async () => {
    // Unread rows, each in a channel of its own: opening one takes only that row out.
    const messages = Array.from({ length: 20 }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `A message of the list, number ${i}`, { unread: true, channel: `C${i}` }));
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady });
    await mock("slack_thread", slackThread([threadMessage(messages[8].ts, "Person 8", "A message of the list, number 8")]));
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 20);
    await browser.execute(() => {
      document.getElementById("slack-feed")!.scrollTop = 300;
    });
    // A click of the page itself: the browser would scroll a clicked row into view first.
    await browser.execute((id) => window.__e2e_once__(id) && document.querySelectorAll<HTMLElement>("#slack-feed .feed-open")[8].click(), onceId());
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
    await $("#slack-feed .feed-open").click();
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
    await $("#slack-feed .feed-open").click();
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
    await $("#slack-feed .feed-open").click();
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
    // Only the pdf: the fixture's default `slack_file_images` answers nothing, so an image would fall back to a chip too.
    await openDetail({}, slackThread([threadMessage(root, "Alice Example", rootText, { files: [slackFile("F2", "notes.pdf", { mimetype: "application/pdf" })] })]));
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
    await $("#slack-feed .feed-open").click();
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
    await $("#slack-feed .feed-open").click();
    await waitForCount("#st-msgs .st-msg", 2);
    await browser.pause(200);
    expect(await callsOf(images)).toEqual([]);
  });
});

describe("slack thread: where it opens", () => {
  // A thread longer than the pane; `last` is added to its last message.
  const long = (last: Parameters<typeof threadMessage>[3] = {}) =>
    Array.from({ length: 12 }, (_, i) => threadMessage(slackTs(100 - i, i), `Person ${i}`, "a line\nanother line\nand a third line", i === 11 ? last : {}));
  // An image of 300 x 240 (the placeholder of a thumbnail is 140 high), which only has its size once it is decoded.
  const tall = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='300' height='240'/>")}`;
  const imageUrl = "https://images.example.com/chart.png";
  const box = () =>
    browser.execute(() => {
      const b = document.getElementById("st-msgs")!;
      return { top: b.scrollTop, height: b.scrollHeight, view: b.clientHeight };
    });
  const atBottom = async () => {
    const { top, height, view } = await box();
    return height > view && top + view >= height - 2;
  };
  const scrollTo = (top: number) =>
    browser.execute((t) => {
      document.getElementById("st-msgs")!.scrollTop = t;
    }, top);
  // Waits until the image in the box is decoded, so that its height is in the layout.
  const imageLoaded = () =>
    browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll<HTMLImageElement>("#st-msgs img.st-img")].some((i) => i.complete && i.naturalHeight > 0)));
  const thumbThread = () => slackThread(long({ files: [slackFile("F1", "design.png", { thumbUrl: thumbUrlOf("F1") })] }));
  // The app with the thread of a thumbnail held, opened; the thumbnail's call is waiting.
  async function openHeld() {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    await mock("slack_thread", thumbThread());
    const images = await mock("slack_file_images", holds);
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-open").click();
    await waitForCalls(images);
    await waitForCount("#st-msgs .st-msg", 12);
    await browser.waitUntil(atBottom);
    return images;
  }

  it("opens a thread longer than the pane at its newest message, and another thread after it too", async () => {
    const other = slackTs(20, 3);
    await openDetail({}, slackThread(long()), [listMessage(), timelineMessage(other, "Carol Example", "general", "Another thread")]);
    await browser.waitUntil(atBottom);
    await scrollTo(0);
    await $("#st-back").click();
    await mock("slack_thread", slackThread(long()));
    await $$("#slack-feed .feed-open")[1].click();
    await waitForCount("#st-msgs .st-msg", 12);
    await browser.waitUntil(atBottom);
  });

  it("opens a thread that fits the pane at its top", async () => {
    await openDetail();
    const { top, height, view } = await box();
    expect(height).toBeLessThanOrEqual(view);
    expect(top).toBe(0);
  });

  it("stays at the newest message when a thumbnail changes the height after the thread was opened", async () => {
    const images = await openHeld();
    const before = (await box()).height;
    await release(images, { [thumbUrlOf("F1")]: tall });
    await browser.waitUntil(async () => (await count("#st-msgs .st-thumb img.st-img")) === 1);
    await imageLoaded();
    expect((await box()).height).toBeGreaterThan(before);
    await browser.waitUntil(atBottom);
  });

  it("stays at the newest message when an image of a block is drawn after 画像を表示", async () => {
    const blockThread = slackThread(long({ blocks: [{ type: "image", image: { url: imageUrl, alt: "A chart" }, title: null }], showText: false, imageUrls: [imageUrl] }));
    await openDetail({}, blockThread);
    await browser.waitUntil(atBottom);
    await mock("fetch_images", { [imageUrl]: tall });
    await $("#st-msgs .st-images .text-btn").click();
    await browser.waitUntil(async () => (await count("#st-msgs img.st-img")) === 1);
    await imageLoaded();
    await browser.waitUntil(atBottom);
  });

  it("does not take the user back to the end when an image changes the height after they scrolled up", async () => {
    const images = await openHeld();
    await scrollTo(50);
    // The scroll event of the move is dispatched before the next frame.
    await browser.pause(200);
    await release(images, { [thumbUrlOf("F1")]: tall });
    await browser.waitUntil(async () => (await count("#st-msgs .st-thumb img.st-img")) === 1);
    await imageLoaded();
    await browser.pause(200);
    expect((await box()).top).toBe(50);
  });

  it("follows the end again once the user scrolls back down to it", async () => {
    const images = await openHeld();
    await scrollTo(50);
    await browser.pause(200);
    await scrollTo(1e6);
    await browser.pause(200);
    await release(images, { [thumbUrlOf("F1")]: tall });
    await browser.waitUntil(async () => (await count("#st-msgs .st-thumb img.st-img")) === 1);
    await imageLoaded();
    await browser.waitUntil(atBottom);
  });

  // The long thread opened, scrolled up to 50 and left; `slack_thread` answers `value` on the next opening of the same row.
  async function leaveScrolled(value: unknown) {
    await openDetail({}, slackThread(long()));
    await browser.waitUntil(atBottom);
    await scrollTo(50);
    // The scroll event of the move is dispatched before the next frame.
    await browser.pause(200);
    await $("#st-back").click();
    const read = await mock("slack_thread", value);
    await $("#slack-feed .feed-open").click();
    await waitForCalls(read);
    return read;
  }

  it("keeps the scroll position when the same thread is opened again, while it is read and after", async () => {
    const read = await leaveScrolled(holds);
    expect((await box()).top).toBe(50);
    await release(read, slackThread(long()));
    await browser.pause(200);
    expect((await box()).top).toBe(50);
  });

  it("keeps the scroll position when the thread is read again from 再読み込み", async () => {
    await leaveScrolled(rejects("読めません"));
    await $("#st-msgs .pending.fail").waitForExist();
    expect((await box()).top).toBe(50);
    const read = await mock("slack_thread", slackThread(long()));
    // The error is above the messages and out of view at 50: press it without scrolling to it.
    await browser.execute(() => document.querySelector<HTMLElement>("#st-msgs .pending.fail .text-btn")!.click());
    await waitForCalls(read);
    await browser.waitUntil(async () => (await count("#st-msgs .pending.fail")) === 0);
    expect((await box()).top).toBe(50);
  });

  it("opens at the newest message when 再読み込み reads a thread whose first read failed", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    await mock("slack_thread", rejects("読めません"));
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-open").click();
    await $("#st-msgs .pending.fail").waitForExist();
    await mock("slack_thread", slackThread(long()));
    await $("#st-msgs .pending.fail .text-btn").click();
    await waitForCount("#st-msgs .st-msg", 12);
    await browser.waitUntil(atBottom);
  });

  it("opens at the newest message when the thread was left before its read ended", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    const read = await mock("slack_thread", holds);
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-open").click();
    await waitForCalls(read);
    await $("#st-back").click();
    await release(read, slackThread(long()));
    await waitForCount("#st-msgs .st-msg", 12);
    await mock("slack_thread", slackThread(long()));
    await $("#slack-feed .feed-open").click();
    await expect($("#slack-thread")).toBeDisplayed();
    await browser.waitUntil(atBottom);
  });
});

describe("slack thread: blocks and attachments", () => {
  const imageUrl = "https://images.example.com/chart.png";
  const missingUrl = "https://images.example.com/gone.png";
  const alt = (text: string) => ({ url: null, alt: text });
  const blocks: ThreadBlock[] = [
    { type: "header", text: "Job succeeded" },
    { type: "section", text: plain("Project: api"), fields: [plain("When\nnow"), plain("Branch\nmain")], accessory: { type: "button", text: "View Job", url: "https://app.example.com/jobs/1" } },
    { type: "context", elements: [{ type: "text", text: plain("built by the bot") }] },
    { type: "divider" },
    { type: "actions", buttons: [{ text: "Rerun", url: null }, { text: "Docs", url: "https://docs.example.com/" }] },
  ];
  // A thread of one message from a bot: `text` is only the alternative text.
  // (Rust sends showText false for a message whose blocks are drawn in place of the text.)
  const bot = (extra: Parameters<typeof threadMessage>[3] = {}) => slackThread([threadMessage(root, "CircleCI", "CircleCI job succeeded!", { showText: !extra.blocks?.length, ...extra })]);
  const imageMessage = () =>
    bot({
      blocks: [
        { type: "image", image: { url: imageUrl, alt: "A chart" }, title: null },
        { type: "image", image: { url: missingUrl, alt: "Gone image" }, title: null },
      ],
      imageUrls: [imageUrl, missingUrl],
    });
  // The messages of the list for two threads, to leave one and open the other.
  const other = slackTs(20, 3);
  const twoThreads = () => [listMessage(), timelineMessage(other, "Carol Example", "general", "Another thread")];
  const shown = () => count("#st-msgs img.st-img");

  it("draws the blocks in place of the text: the header, the section with its fields and button, the context and the divider", async () => {
    await openDetail({}, bot({ blocks }));
    await expect($("#st-msgs .st-bh")).toHaveText("Job succeeded");
    expect(await textsOf("#st-msgs .st-sec-main > .st-text")).toEqual(["Project: api"]);
    expect(await textsOf("#st-msgs .st-fields .st-text")).toEqual(["When\nnow", "Branch\nmain"]);
    // Each field is one box, whatever blocks it holds.
    expect(await count("#st-msgs .st-fields > .st-field")).toBe(2);
    expect(await textsOf("#st-msgs .st-ctx")).toEqual(["built by the bot"]);
    expect(await count("#st-msgs hr.st-hr")).toBe(1);
    // Slack's alternative text is not drawn beside them.
    expect((await textsOf("#st-msgs .st-msg"))[0]).not.toContain("CircleCI job succeeded!");
    expect(await count("#st-msgs .st-msg > div > .st-text")).toBe(0);
  });

  it("draws the text of a message that has no blocks to draw, with its attachments under it", async () => {
    await openDetail({}, bot({ attachments: [attachment({ title: "Build log", text: plain("All green") })] }));
    expect(await textsOf("#st-msgs .st-msg > div > .st-text")).toEqual(["CircleCI job succeeded!"]);
    expect(await textsOf("#st-msgs .st-att .st-att-title")).toEqual(["Build log"]);
    // The text comes before the attachment.
    expect(await browser.execute(() => document.querySelector("#st-msgs .st-msg > div > .st-text")!.compareDocumentPosition(document.querySelector("#st-msgs .st-att")!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  });

  it("draws the folded text of a long attachment with a button, and the whole text after a press (S-11)", async () => {
    const whole = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
    const first = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n");
    await openDetail({}, bot({ attachments: [attachment({ title: "Shared", text: plain(whole), textShort: plain(first) }), attachment({ title: "Short", text: plain("One line") })] }));
    expect(await textsOf("#st-msgs .st-att > .st-text")).toEqual([first, "One line"]);
    expect(await textsOf("#st-msgs .st-att .st-more")).toEqual(["もっと表示する"]);
    await $("#st-msgs .st-att .st-more").click();
    expect(await textsOf("#st-msgs .st-att > .st-text")).toEqual([whole, "One line"]);
    expect(await count("#st-msgs .st-more")).toBe(0);
  });

  it("draws an attachment: the color bar, pretext, author, linked title, text, fields, buttons and footer", async () => {
    const full = attachment({
      color: "#36a64f",
      pretext: plain("Before the card"),
      authorName: "CI bot",
      title: "Job #1",
      titleLink: "https://app.example.com/jobs/1",
      text: plain("Passed"),
      fields: [{ title: "Project", value: plain("api") }, { title: "Branch", value: plain("main") }],
      actions: [{ text: "Open", url: "https://app.example.com/open" }],
      footer: "via CI",
    });
    await openDetail({}, bot({ attachments: [full] }));
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#st-msgs .st-att")!).borderLeftColor)).toBe("rgb(54, 166, 79)");
    expect(await textsOf("#st-msgs .st-att > .st-text")).toEqual(["Before the card", "Passed"]);
    await expect($("#st-msgs .st-att .st-att-author")).toHaveText("CI bot");
    await expect($("#st-msgs a.st-att-title")).toHaveText("Job #1");
    await expect($("#st-msgs a.st-att-title")).toHaveAttribute("href", "https://app.example.com/jobs/1");
    expect(await textsOf("#st-msgs .st-att .st-field")).toEqual(["Projectapi", "Branchmain"]);
    await expect($("#st-msgs .st-att a.text-btn")).toHaveAttribute("href", "https://app.example.com/open");
    await expect($("#st-msgs .st-att .st-att-foot")).toHaveText("via CI");
  });

  it("draws an attachment's title as plain text when it has no link, and its fallback when nothing else is there", async () => {
    await openDetail({}, bot({ attachments: [attachment({ title: "No link" }), attachment({ fallback: "Only a fallback" })] }));
    expect(await count("#st-msgs a.st-att-title")).toBe(0);
    expect(await textsOf("#st-msgs .st-att")).toEqual(["No link", "Only a fallback"]);
  });

  it("gives a button with an address as a link, and one without as its name that cannot be pressed", async () => {
    await openDetail({}, bot({ blocks }));
    const links = await browser.execute(() => [...document.querySelectorAll<HTMLAnchorElement>("#st-msgs a.text-btn")].map((a) => [a.textContent, a.getAttribute("href")]));
    expect(links).toEqual([["View Job", "https://app.example.com/jobs/1"], ["Docs", "https://docs.example.com/"]]);
    await expect($("#st-msgs button.text-btn")).toHaveText("Rerun");
    await expect($("#st-msgs button.text-btn")).toBeDisabled();
  });

  it("draws every text as text: no markup, and only URLs are links", async () => {
    const markup = "<b>bold</b><img src=x onerror=alert(1)> see https://example.com/plan";
    await openDetail({}, bot({ blocks: [{ type: "section", text: plain(markup), fields: [plain(markup)], accessory: null }], attachments: [attachment({ title: markup, text: plain(markup) })] }));
    expect(await count("#st-msgs .st-blocks b, #st-msgs .st-blocks img, #st-msgs .st-att b, #st-msgs .st-att img")).toBe(0);
    expect((await textsOf("#st-msgs .st-sec-main > .st-text"))[0]).toBe(markup);
    expect((await textsOf("#st-msgs .st-att > .st-text"))[0]).toBe(markup);
    // The section's text, its field, the attachment's title and its text.
    expect(await count("#st-msgs .st-blocks a, #st-msgs .st-att a")).toBe(4);
    await expect($("#st-msgs .st-sec-main > .st-text a")).toHaveAttribute("href", "https://example.com/plan");
  });

  it("fetches no image by default and offers 画像を表示 only on a message that has images", async () => {
    const messages = [threadMessage(root, "CircleCI", "with images", { blocks: imageMessage().messages[0].blocks, showText: false, imageUrls: [imageUrl, missingUrl] }), threadMessage(reply1, "Bob Example", "no images")];
    await openDetail({}, slackThread(messages));
    await browser.pause(200);
    expect(await callsOf("fetch_images")).toEqual([]);
    expect(await shown()).toBe(0);
    expect(await textsOf("#st-msgs .st-images .text-btn")).toEqual(["画像を表示"]);
    expect(await count("#st-msgs .st-images")).toBe(1);
  });

  it("fetches the images with fetch_images when 画像を表示 is pressed, draws them, and uses the description of one that cannot be fetched", async () => {
    await openDetail({}, imageMessage());
    const fetch = await mock("fetch_images", { [imageUrl]: pngUri });
    await $("#st-msgs .st-images .text-btn").click();
    expect(await waitForCalls(fetch)).toEqual([{ urls: [imageUrl, missingUrl] }]);
    await browser.waitUntil(async () => (await shown()) === 1);
    expect(await browser.execute(() => document.querySelector<HTMLImageElement>("#st-msgs img.st-img")!.src)).toBe(pngUri);
    expect(await textsOf("#st-msgs .st-alt")).toEqual(["Gone image"]);
    expect(await count("#st-msgs .st-images")).toBe(0);
  });

  it("draws the description of an image with no address even before 画像を表示, and offers no button for it", async () => {
    await openDetail({}, bot({ blocks: [{ type: "image", image: alt("Needs the Slack token"), title: null }] }));
    expect(await textsOf("#st-msgs .st-alt")).toEqual(["Needs the Slack token"]);
    expect(await count("#st-msgs .st-images")).toBe(0);
  });

  it("draws the text under the blocks when Rust says to, for a block that could not be drawn", async () => {
    await openDetail({}, bot({ blocks: [{ type: "header", text: "Job succeeded" }], showText: true }));
    await expect($("#st-msgs .st-bh")).toHaveText("Job succeeded");
    expect(await textsOf("#st-msgs .st-msg > div > .st-text")).toEqual(["CircleCI job succeeded!"]);
    // The text comes after the blocks.
    expect(await browser.execute(() => document.querySelector("#st-msgs .st-blocks")!.compareDocumentPosition(document.querySelector("#st-msgs .st-msg > div > .st-text")!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  });

  it("turns the URLs of the header, the title, the author, the footer and a field's title into links, and a titled link holds no link inside", async () => {
    const url = "https://example.com/a";
    await openDetail(
      {},
      bot({
        blocks: [{ type: "header", text: `Header ${url}` }],
        attachments: [
          attachment({ authorName: `Author ${url}`, title: `Title ${url}`, fields: [{ title: `Field ${url}`, value: plain("v") }], footer: `Footer ${url}` }),
          attachment({ title: `Linked ${url}`, titleLink: "https://example.com/t" }),
        ],
      }),
    );
    for (const selector of [".st-bh", ".st-att-author", ".st-att-title", ".st-field b", ".st-att-foot"]) {
      await expect($(`#st-msgs ${selector} a`)).toHaveAttribute("href", url);
    }
    expect(await count("#st-msgs a.st-att-title a")).toBe(0);
  });

  it("gives a link button and a title link a tooltip with their address", async () => {
    await openDetail({}, bot({ blocks, attachments: [attachment({ title: "Job", titleLink: "https://example.com/job" })] }));
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLAnchorElement>("#st-msgs a.text-btn, #st-msgs a.st-att-title")].map((a) => a.title === a.href))).toEqual([true, true, true]);
  });

  it("makes again only the row of the message whose images were asked for", async () => {
    const messages = [threadMessage(root, "CircleCI", "with images", { blocks: imageMessage().messages[0].blocks, showText: false, imageUrls: [imageUrl, missingUrl] }), threadMessage(reply1, "Bob Example", "no images")];
    await openDetail({}, slackThread(messages));
    await browser.execute(() => {
      document.querySelectorAll<HTMLElement>("#st-msgs .st-msg")[1].dataset.mark = "kept";
    });
    await mock("fetch_images", { [imageUrl]: pngUri });
    await $("#st-msgs .st-images .text-btn").click();
    await browser.waitUntil(async () => (await shown()) === 1);
    expect(await browser.execute(() => document.querySelectorAll<HTMLElement>("#st-msgs .st-msg")[1].dataset.mark)).toBe("kept");
  });

  it("keeps the images shown when the thread is read again after a reply", async () => {
    const read = await openDetail({}, imageMessage());
    await mock("fetch_images", { [imageUrl]: pngUri });
    await $("#st-msgs .st-images .text-btn").click();
    await browser.waitUntil(async () => (await shown()) === 1);
    await mock("slack_reply", true);
    await write("Thanks");
    await pressReply();
    await waitForCalls(read, 2);
    await expect($("#st-note")).toHaveText("スレッドに返信しました");
    expect(await shown()).toBe(1);
    expect(await count("#st-msgs .st-images")).toBe(0);
  });

  it("keeps the images shown when the same thread is opened again, and forgets them when another thread was opened", async () => {
    await openDetail({}, imageMessage(), twoThreads());
    await mock("fetch_images", { [imageUrl]: pngUri });
    await $("#st-msgs .st-images .text-btn").click();
    await browser.waitUntil(async () => (await shown()) === 1);
    await $("#st-back").click();
    await $$("#slack-feed .feed-open")[0].click();
    await waitForCount("#st-msgs .st-msg", 1);
    expect(await shown()).toBe(1);
    await $("#st-back").click();
    await mock("slack_thread", slackThread([threadMessage(other, "Carol Example", "Another thread")]));
    await $$("#slack-feed .feed-open")[1].click();
    await waitForCount("#st-msgs .st-msg", 1);
    await $("#st-back").click();
    await mock("slack_thread", imageMessage());
    await $$("#slack-feed .feed-open")[0].click();
    await waitForCount("#st-msgs .st-msg", 1);
    expect(await shown()).toBe(0);
    expect(await textsOf("#st-msgs .st-images .text-btn")).toEqual(["画像を表示"]);
  });

  it("keeps the button and says so when the fetch fails", async () => {
    await openDetail({}, imageMessage());
    const fetch = await mock("fetch_images", rejects("取得できません"));
    await $("#st-msgs .st-images .text-btn").click();
    await waitForCalls(fetch);
    await expect($(".toast")).toHaveText(expect.stringContaining("画像を取得できませんでした: 取得できません"));
    await expect($("#st-msgs .st-images .text-btn")).toBeEnabled();
    expect(await shown()).toBe(0);
  });

  it("draws an attachment's own image and thumbnail after 画像を表示, and an image-only attachment is not dropped", async () => {
    const thumbUrl = "https://images.example.com/thumb.png";
    const card = attachment({ image: { url: imageUrl, alt: "A chart" }, thumb: { url: thumbUrl, alt: "A chart" } });
    await openDetail({}, bot({ attachments: [card], imageUrls: [imageUrl, thumbUrl] }));
    // Nothing is drawn or fetched before the press, but the attachment and the button are there.
    expect(await count("#st-msgs .st-att")).toBe(1);
    expect(await shown()).toBe(0);
    expect(await callsOf("fetch_images")).toEqual([]);
    const fetch = await mock("fetch_images", { [imageUrl]: pngUri, [thumbUrl]: pngUri });
    await $("#st-msgs .st-images .text-btn").click();
    expect(await waitForCalls(fetch)).toEqual([{ urls: [imageUrl, thumbUrl] }]);
    await browser.waitUntil(async () => (await count("#st-msgs .st-att img")) === 2);
    expect(await count("#st-msgs .st-att .st-img")).toBe(1);
    expect(await count("#st-msgs .st-att .st-acc-img")).toBe(1);
  });

  it("draws the description of an attachment's image that cannot be fetched", async () => {
    await openDetail({}, bot({ attachments: [attachment({ image: { url: missingUrl, alt: "Gone image" } })], imageUrls: [missingUrl] }));
    await mock("fetch_images", {});
    await $("#st-msgs .st-images .text-btn").click();
    await browser.waitUntil(async () => (await count("#st-msgs .st-att .st-alt")) === 1);
    expect(await textsOf("#st-msgs .st-att .st-alt")).toEqual(["Gone image"]);
    expect(await count("#st-msgs .st-images")).toBe(0);
  });

  it("draws the images of the blocks inside an attachment and of a section's accessory and a context too", async () => {
    const inner: ThreadBlock[] = [
      { type: "section", text: plain("Report"), fields: [], accessory: { type: "image", url: imageUrl, alt: "Thumb" } },
      { type: "context", elements: [{ type: "image", url: imageUrl, alt: "Logo" }] },
    ];
    await openDetail({}, bot({ attachments: [attachment({ blocks: inner })], imageUrls: [imageUrl] }));
    const fetch = await mock("fetch_images", { [imageUrl]: pngUri });
    await $("#st-msgs .st-images .text-btn").click();
    expect(await waitForCalls(fetch)).toEqual([{ urls: [imageUrl] }]);
    await browser.waitUntil(async () => (await count("#st-msgs .st-att img")) === 2);
  });
});

describe("slack thread: styles of a text (S-12)", () => {
  const url = "https://example.com/plan";
  // A thread of one message whose text Rust has read into `rich`.
  const withRich = (extra: Parameters<typeof threadMessage>[3] = {}) => slackThread([threadMessage(root, "Alice Example", "raw text", extra)]);

  it("draws bold, italic, strike and inline code as strong, em, s and code, and keeps the line breaks", async () => {
    await openDetail({}, withRich({ rich: [para(span("a "), span("b", "b"), span(" "), span("i", "i"), span(" "), span("s", "s"), span(" "), span("c", "c"), span("\nnext "), span("all", "bis"))] }));
    expect(await textsOf("#st-msgs .st-text strong")).toEqual(["b", "all"]);
    expect(await textsOf("#st-msgs .st-text em")).toEqual(["i", "all"]);
    expect(await textsOf("#st-msgs .st-text s")).toEqual(["s", "all"]);
    expect(await textsOf("#st-msgs .st-text code")).toEqual(["c"]);
    // A nested style is one element inside another.
    expect(await count("#st-msgs .st-text strong > em > s")).toBe(1);
    expect(await textsOf("#st-msgs .st-text")).toEqual(["a b i s c\nnext all"]);
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#st-msgs .st-text")!).whiteSpace)).toBe("pre-wrap");
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#st-msgs .st-text strong")!).fontWeight)).toMatch(/^(bold|[6-9]00)$/);
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#st-msgs .st-text s")!).textDecorationLine)).toContain("line-through");
  });

  it("draws a quote as a blockquote and a code block as a pre that scrolls sideways", async () => {
    const long = `const line = "${"x".repeat(400)}"; // ${url}`;
    await openDetail({}, withRich({ rich: [para(span("before")), quote(span("quoted "), span("bold", "b")), { type: "code", text: `${long}\nsecond` }, para(span("after"))] }));
    expect(await textsOf("#st-msgs blockquote")).toEqual(["quoted bold"]);
    expect(await count("#st-msgs blockquote strong")).toBe(1);
    expect(await textsOf("#st-msgs pre > code")).toEqual([`${long}\nsecond`]);
    expect(await textsOf("#st-msgs .st-text")).toEqual(["before", "after"]);
    expect(
      await browser.execute(() => {
        const pre = document.querySelector<HTMLElement>("#st-msgs pre")!;
        return [getComputedStyle(pre).overflowX, pre.scrollWidth > pre.clientWidth];
      }),
    ).toEqual(["auto", true]);
    // An address in a code is not a link.
    expect(await count("#st-msgs pre a")).toBe(0);
  });

  it("makes a link of a URL inside a style, and none of a URL inside an inline code", async () => {
    await openDetail({}, withRich({ rich: [para(span(`see ${url}`, "b"), span(" "), span(url, "c"), span(" "), span(url, "i"))] }));
    await expect($("#st-msgs .st-text strong a")).toHaveAttribute("href", url);
    await expect($("#st-msgs .st-text em a")).toHaveAttribute("href", url);
    expect(await count("#st-msgs .st-text code a")).toBe(0);
    expect(await count("#st-msgs .st-text a")).toBe(2);
  });

  it("draws a span with a link as a link labeled with its text, and not the address (S-11)", async () => {
    const shared = "https://example.slack.com/archives/C1/p123";
    await openDetail({}, withRich({ rich: [para(span("see "), linkSpan("メッセージ", shared), span(` ${url}`))] }));
    expect(await textsOf("#st-msgs .st-text a")).toEqual(["メッセージ", url]);
    await expect($("#st-msgs .st-text").$("a=メッセージ")).toHaveAttribute("href", shared);
    // The address is the title, so the label hides nowhere.
    await expect($("#st-msgs .st-text").$("a=メッセージ")).toHaveAttribute("title", shared);
    expect(await textsOf("#st-msgs .st-text")).toEqual([`see メッセージ ${url}`]);
  });

  it("draws a mention of a user as a link to the profile, in a style too, and a user group as text (S-12)", async () => {
    const profile = "https://example-team.slack.com/team/U2";
    await openDetail({}, withRich({ rich: [para(span("hi "), linkSpan("@Bob", profile), span(" "), { ...linkSpan("@Bob", profile), bold: true }, span(" @design"))] }));
    expect(await textsOf("#st-msgs .st-text a")).toEqual(["@Bob", "@Bob"]);
    await expect($("#st-msgs .st-text > a")).toHaveAttribute("href", profile);
    await expect($("#st-msgs .st-text > a")).toHaveAttribute("title", profile);
    await expect($("#st-msgs .st-text strong a")).toHaveAttribute("href", profile);
    expect(await textsOf("#st-msgs .st-text")).toEqual(["hi @Bob @Bob @design"]);
  });

  it("draws an HTML tag in a styled text as text", async () => {
    const markup = "<b>x</b><img src=x onerror=alert(1)>";
    await openDetail({}, withRich({ rich: [para(span(markup, "b"), span(markup, "c")), quote(span(markup)), { type: "code", text: markup }] }));
    // The sender's name is a <b> of its own, so only the text's elements are looked at.
    expect(await count("#st-msgs .st-text b, #st-msgs .st-text img, #st-msgs blockquote b, #st-msgs blockquote img, #st-msgs pre b, #st-msgs pre img")).toBe(0);
    expect(await textsOf("#st-msgs strong, #st-msgs .st-text code, #st-msgs blockquote, #st-msgs pre")).toEqual([markup, markup, markup, markup]);
  });

  it("draws the styles of the mrkdwn texts of the blocks and the attachments", async () => {
    const blocks: ThreadBlock[] = [
      { type: "header", text: "*Header*" },
      { type: "section", text: [para(span("Status: "), span("ok", "b"))], fields: [[para(span("Field ")), quote(span("quoted"))]], accessory: null },
      { type: "context", elements: [{ type: "text", text: [para(span("by "), span("bot", "c"))] }] },
    ];
    const card = attachment({ text: [para(span("Card "), span("text", "i"))], fields: [{ title: "T", value: [{ type: "code", text: "x = 1" }] }] });
    await openDetail({}, slackThread([threadMessage(root, "CircleCI", "alt", { blocks, showText: false, attachments: [card] })]));
    expect(await textsOf("#st-msgs .st-sec-main > .st-text strong")).toEqual(["ok"]);
    expect(await textsOf("#st-msgs .st-fields blockquote")).toEqual(["quoted"]);
    // A field of a paragraph and a quote is still one box (the attachment's fields are its own).
    expect(await count("#st-msgs .st-fields:not(.st-att .st-fields) > .st-field")).toBe(1);
    expect(await textsOf("#st-msgs .st-ctx code")).toEqual(["bot"]);
    expect(await textsOf("#st-msgs .st-att > .st-text em")).toEqual(["text"]);
    expect(await textsOf("#st-msgs .st-att .st-field pre > code")).toEqual(["x = 1"]);
    // A header is a plain text: its marks stay.
    await expect($("#st-msgs .st-bh")).toHaveText("*Header*");
    expect(await count("#st-msgs .st-bh strong")).toBe(0);
  });
});

describe("slack thread: reactions (S-22)", () => {
  const reactionTexts = (n: number) => browser.execute((i) => [...document.querySelectorAll("#st-msgs .st-msg")[i].querySelectorAll(".reaction")].map((r) => [r.querySelector(".reaction-emoji")?.textContent, r.querySelector(".reaction-count")?.textContent]), n);

  it("draws the emoji and the count of each reaction under the message in the order given, a custom emoji as :name:, and under a message without any only the button of the picker (S-25)", async () => {
    await openDetail(
      {},
      slackThread([
        threadMessage(root, "Alice Example", rootText, { reactions: [reaction("tada", "🎉", 3), reaction("+1::skin-tone-2", "👍🏻", 1), reaction("partyparrot", ":partyparrot:", 12)] }),
        threadMessage(reply1, "Bob Example", "Looks fine to me."),
      ]),
    );
    expect(await reactionTexts(0)).toEqual([["🎉", "3"], ["👍🏻", "1"], [":partyparrot:", "12"]]);
    expect(await reactionTexts(1)).toEqual([]);
    expect(await count("#st-msgs .reactions:not(.empty)")).toBe(1);
    expect(await count("#st-msgs .reactions.empty")).toBe(1);
    expect(await browser.execute(() => [...document.querySelectorAll("#st-msgs .reactions.empty")].map((b) => b.children.length))).toEqual([1]);
    // Each one is a button (S-25).
    expect(await browser.execute(() => [...document.querySelectorAll("#st-msgs .reaction")].map((r) => `${r.tagName}:${r.getAttribute("type")}`))).toEqual(["BUTTON:button", "BUTTON:button", "BUTTON:button"]);
  });

  it("puts the reactions last in the message, under its text and its files", async () => {
    await openDetail({}, slackThread([threadMessage(root, "Alice Example", rootText, { files: [slackFile("F2", "notes.pdf", { mimetype: "application/pdf" })], reactions: [reaction("tada", "🎉", 2)] })]));
    expect(await browser.execute(() => [...document.querySelector("#st-msgs .st-msg > :last-child")!.children].map((e) => e.className.split(" ")[0]))).toEqual(["st-meta", "st-text", "st-files", "reactions"]);
  });

  describe("custom emoji (S-26)", () => {
    const emojiUrl = "https://emoji.slack-edge.com/T1/partyparrot/abc.gif";
    const withImage = () => slackThread([threadMessage(root, "Alice Example", rootText, { reactions: [reaction("partyparrot", ":partyparrot:", 12, emojiUrl), reaction("tada", "🎉", 3)] })]);
    const emojiNodes = () => browser.execute(() => [...document.querySelectorAll("#st-msgs .reaction-emoji")].map((e) => [e.textContent, e.querySelector("img")?.getAttribute("alt") ?? null]));

    it("draws a custom emoji as the image fetch_images gave, with :name: as its alternative text, and fetches only its address", async () => {
      await openDetail({ fetch_images: { [emojiUrl]: pngUri } }, withImage());
      await browser.waitUntil(async () => (await count("#st-msgs .reaction-emoji img.reaction-img")) === 1);
      expect(await emojiNodes()).toEqual([["", ":partyparrot:"], ["🎉", null]]);
      await expect($("#st-msgs .reaction-emoji img")).toHaveAttribute("src", pngUri);
      expect(await textsOf("#st-msgs .reaction-count")).toEqual(["12", "3"]);
      expect((await callsOf("fetch_images")).flatMap((c) => (c as { urls: string[] }).urls)).toEqual([emojiUrl]);
    });

    it("keeps :name: when the image cannot be fetched", async () => {
      await openDetail({}, withImage());
      await waitForCalls("fetch_images");
      await browser.pause(300);
      expect(await emojiNodes()).toEqual([[":partyparrot:", null], ["🎉", null]]);
    });

    it("keeps :name: when fetch_images fails", async () => {
      await openDetail({ fetch_images: rejects("取得できません") }, withImage());
      await waitForCalls("fetch_images");
      await browser.pause(300);
      expect(await emojiNodes()).toEqual([[":partyparrot:", null], ["🎉", null]]);
    });

    it("asks for no image when no reaction has one", async () => {
      await openDetail({}, slackThread([threadMessage(root, "Alice Example", rootText, { reactions: [reaction("tada", "🎉", 3)] })]));
      await browser.pause(300);
      expect(await callsOf("fetch_images")).toEqual([]);
    });
  });
});

describe("slack thread: add and take off a reaction (S-25)", () => {
  const emojiUrl = "https://emoji.slack-edge.com/T1/sutekina/abc.gif";
  // [name, count, mine, aria-pressed, disabled] of the reactions of each message.
  const chips = () =>
    browser.execute(() =>
      [...document.querySelectorAll("#st-msgs .st-msg")].map((m) =>
        [...m.querySelectorAll<HTMLButtonElement>(".reaction")].map((r) => [r.dataset.name, r.querySelector(".reaction-count")!.textContent, r.classList.contains("mine"), r.getAttribute("aria-pressed"), r.disabled]),
      ),
    );
  const chip = (message: number, name: string) =>
    browser.execute((i, n) => document.querySelectorAll("#st-msgs .st-msg")[i].querySelector<HTMLElement>(`.reaction[data-name="${CSS.escape(n)}"]`)!.click(), message, name);
  const thread = () =>
    slackThread([
      threadMessage(root, "Alice Example", rootText, { reactions: [reaction("tada", "🎉", 3), reaction("eyes", "👀", 1, null, true), reaction("ステキ", ":ステキ:", 2, emojiUrl)] }),
      threadMessage(reply1, "Bob Example", "Looks fine to me.", { reactions: [reaction("+1::skin-tone-2", "👍🏻", 1)] }),
    ]);

  it("marks the reactions the user gave with the accent frame and aria-pressed, and the others not", async () => {
    await openDetail({}, thread());
    expect(await chips()).toEqual([
      [["tada", "3", false, "false", false], ["eyes", "1", true, "true", false], ["ステキ", "2", false, "false", false]],
      [["+1::skin-tone-2", "1", false, "false", false]],
    ]);
    const borders = await browser.execute(() => [...document.querySelectorAll("#st-msgs .st-msg:first-child .reaction")].map((r) => getComputedStyle(r).borderTopColor));
    expect(borders[1]).not.toBe(borders[0]);
    expect(borders[0]).toBe(borders[2]);
  });

  it("adds a reaction the user did not give: slack_react gets the workspace, the conversation, the message's ts, the name and add true, and the count and the frame change in place with no new read", async () => {
    const read = await openDetail({}, thread());
    const react = await mock("slack_react", true);
    await $$("#st-msgs .st-msg")[0].$('.reaction[data-name="tada"]').click();
    expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root, name: "tada", add: true }]);
    await browser.waitUntil(async () => (await chips())[0][0][1] === "4");
    expect((await chips())[0][0]).toEqual(["tada", "4", true, "true", false]);
    expect((await chips())[0].slice(1)).toEqual([["eyes", "1", true, "true", false], ["ステキ", "2", false, "false", false]]);
    expect(await callsOf(read)).toHaveLength(1);
  });

  it("takes off the reaction the user gave: add false, the count goes down and the frame goes, and a reaction nobody else gave disappears", async () => {
    await openDetail({}, thread());
    const react = await mock("slack_react", true);
    await chip(0, "eyes");
    expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root, name: "eyes", add: false }]);
    await browser.waitUntil(async () => (await chips())[0].length === 2);
    expect((await chips())[0]).toEqual([["tada", "3", false, "false", false], ["ステキ", "2", false, "false", false]]);
    // Add one and take it off again: back to what it was.
    await chip(0, "tada");
    await browser.waitUntil(async () => (await chips())[0][0][1] === "4");
    await chip(0, "tada");
    await waitForCalls(react, 3);
    await browser.waitUntil(async () => (await chips())[0][0][1] === "3");
    expect((await chips())[0][0]).toEqual(["tada", "3", false, "false", false]);
    expect((await callsOf(react)).map((c) => (c as { add: boolean }).add)).toEqual([false, true, false]);
  });

  it("sends the name of the reaction as Rust gave it (a skin tone, a custom emoji's own name) and the ts of the message it is under", async () => {
    await openDetail({}, thread());
    const react = await mock("slack_react", true);
    await chip(1, "+1::skin-tone-2");
    await waitForCalls(react);
    await chip(0, "ステキ");
    expect(await waitForCalls(react, 2)).toEqual([
      { teamId: workspace.teamId, channel: "C0123ABCD", ts: reply1, name: "+1::skin-tone-2", add: true },
      { teamId: workspace.teamId, channel: "C0123ABCD", ts: root, name: "ステキ", add: true },
    ]);
  });

  it("reacts in a DM or a group DM, whose conversation is not in the channel list", async () => {
    await openDetail({}, { ...thread(), channel: "D0123ABCD" });
    const react = await mock("slack_react", true);
    await chip(0, "tada");
    expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "D0123ABCD", ts: root, name: "tada", add: true }]);
  });

  it("takes an answer of false (it was so already) as done: the frame changes and the count stays", async () => {
    await openDetail({}, thread());
    const react = await mock("slack_react", false);
    await chip(0, "tada");
    await waitForCalls(react);
    await browser.waitUntil(async () => (await chips())[0][0][2] === true);
    expect((await chips())[0][0]).toEqual(["tada", "3", true, "true", false]);
    await chip(0, "eyes");
    await waitForCalls(react, 2);
    await browser.waitUntil(async () => (await chips())[0].some((c) => c[0] === "eyes" && c[2] === false));
    expect((await chips())[0][1]).toEqual(["eyes", "1", false, "false", false]);
  });

  it("shows the error and changes nothing when slack_react fails, and the reaction can be pressed again", async () => {
    await openDetail({}, thread());
    const before = await chips();
    const react = await mock("slack_react", rejects("Slack アプリに reactions:write のスコープがありません。追加して、トークンを貼り直してください"));
    await chip(0, "tada");
    await waitForCalls(react);
    await expect($(".toast")).toHaveText(expect.stringContaining("リアクションを変えられませんでした: Slack アプリに reactions:write のスコープがありません"));
    expect(await chips()).toEqual(before);
    await mock("slack_react", true);
    await chip(0, "tada");
    await browser.waitUntil(async () => (await chips())[0][0][1] === "4");
  });

  it("sends a press once while it is on its way: the button is off until Rust answers", async () => {
    await openDetail({}, thread());
    const react = await mock("slack_react", holds);
    await chip(0, "tada");
    await waitForCalls(react);
    await browser.waitUntil(async () => (await chips())[0][0][4] === true);
    await chip(0, "tada");
    await browser.pause(200);
    expect(await callsOf(react)).toHaveLength(1);
    // Nothing changes until the answer; the other reactions can be pressed.
    expect((await chips())[0][0]).toEqual(["tada", "3", false, "false", true]);
    expect((await chips())[0][1][4]).toBe(false);
    await release(react, true);
    await browser.waitUntil(async () => (await chips())[0][0][1] === "4");
    expect((await chips())[0][0]).toEqual(["tada", "4", true, "true", false]);
    expect(await callsOf(react)).toHaveLength(1);
  });

  it("keeps the press when the thread is read again while it is on its way: a later redraw of the box still has it", async () => {
    await openDetail({}, thread());
    const react = await mock("slack_react", holds);
    await chip(0, "tada");
    await waitForCalls(react);
    // A reply posted meanwhile reads the thread again; Slack has not seen the press, so the read shows 3.
    await mock("slack_reply", true);
    await mock("slack_thread", slackThread([...thread().messages, threadMessage(slackTs(0), "Alice Example", "Thanks, will do")]));
    await write("Thanks, will do");
    await pressReply();
    await waitForCount("#st-msgs .st-msg", 3);
    await release(react, true);
    await browser.waitUntil(async () => (await chips())[0][0][1] === "4");
    // Another press draws the box from the message that read made: it has the first press too.
    await mock("slack_react", true);
    await chip(0, "eyes");
    await browser.waitUntil(async () => (await chips())[0].length === 2);
    expect((await chips())[0][0]).toEqual(["tada", "4", true, "true", false]);
  });

  // The thread read again while the press is on its way already holds the press (Slack took it first): the answer does not count it a second time.
  const rereadMeanwhile = async (before: ReturnType<typeof threadMessage>, after: ReturnType<typeof threadMessage>, name: string) => {
    await openDetail({}, slackThread([before]));
    const react = await mock("slack_react", holds);
    await chip(0, name);
    await waitForCalls(react);
    await mock("slack_reply", true);
    await mock("slack_thread", slackThread([after, threadMessage(reply1, "Bob Example", "Thanks, will do")]));
    await write("Thanks, will do");
    await pressReply();
    await waitForCount("#st-msgs .st-msg", 2);
    await release(react, true);
    await browser.pause(300);
    return (await chips())[0];
  };

  it("counts an add once when the thread read again while it was on its way already has it", async () => {
    const first = await rereadMeanwhile(
      threadMessage(root, "Alice Example", rootText, { reactions: [reaction("tada", "🎉", 3)] }),
      threadMessage(root, "Alice Example", rootText, { reactions: [reaction("tada", "🎉", 4, null, true)] }),
      "tada",
    );
    expect(first).toEqual([["tada", "4", true, "true", false]]);
  });

  it("counts a take-off once when the thread read again while it was on its way already lacks it, and keeps a reaction others still give", async () => {
    const first = await rereadMeanwhile(
      threadMessage(root, "Alice Example", rootText, { reactions: [reaction("tada", "🎉", 3, null, true)] }),
      threadMessage(root, "Alice Example", rootText, { reactions: [reaction("tada", "🎉", 2)] }),
      "tada",
    );
    expect(first).toEqual([["tada", "2", false, "false", false]]);
  });

  it("is a button the keyboard reaches, and keeps the focus on the reaction when the press is done", async () => {
    await openDetail({}, thread());
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#st-msgs .reaction")].map((r) => r.tabIndex))).toEqual([0, 0, 0, 0]);
    const react = await mock("slack_react", true);
    // The press a key makes on a focused button is its click.
    await browser.execute(() => {
      const r = document.querySelector<HTMLElement>('#st-msgs .reaction[data-name="tada"]')!;
      r.focus();
      r.click();
    });
    expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root, name: "tada", add: true }]);
    await browser.waitUntil(async () => (await chips())[0][0][1] === "4");
    expect(await browser.execute(() => (document.activeElement as HTMLElement).dataset.name)).toBe("tada");
  });

  it("does not take the focus from the reply field when the answer comes", async () => {
    await openDetail({}, thread());
    const react = await mock("slack_react", holds);
    await chip(0, "tada");
    await waitForCalls(react);
    await browser.waitUntil(async () => (await editable()) === "true");
    await field().click();
    await release(react, true);
    await browser.waitUntil(async () => (await chips())[0][0][1] === "4");
    expect(await browser.execute(() => !!document.activeElement?.closest("#st-input"))).toBe(true);
  });
});

describe("slack thread: the emoji picker (S-25)", () => {
  const partyUrl = "https://emoji.slack-edge.com/T1/partyparrot/abc.gif";
  const sutekiUrl = "https://emoji.slack-edge.com/T1/sutekina/abc.gif";
  const catalog = () =>
    emojiCatalog(
      [["grinning", "😀"], ["tada", "🎉"], ["+1", "👍"], ["eyes", "👀"], ["thinking_face", "🤔"]],
      [["partyparrot", partyUrl], ["ステキ", sutekiUrl]],
    );
  const thread = () =>
    slackThread([
      threadMessage(root, "Alice Example", rootText, { reactions: [reaction("tada", "🎉", 3), reaction("eyes", "👀", 1, null, true)] }),
      threadMessage(reply1, "Bob Example", "Looks fine to me."),
    ]);
  // The "add a reaction" button of a message (the box of a message with no reaction takes no room, so the press is a script's).
  const addButton = (message: number) => browser.execute((i) => document.querySelectorAll("#st-msgs .st-msg")[i].querySelector<HTMLElement>(".reaction-add")!.click(), message);
  // A press as a mouse makes it. WebDriver's element click sends no pointerdown, which is what closes a menu (as in todo.e2e.ts).
  const press = (target: ChainablePromiseElement) => browser.action("pointer").move({ origin: target }).down().up().perform();
  const picker = async (fixtures: Record<string, unknown> = {}) => {
    await openDetail({ fetch_images: { [partyUrl]: pngUri, [sutekiUrl]: pngUri }, ...fixtures }, thread());
    const read = await mock("slack_emoji_catalog", catalog());
    await addButton(0);
    await expect($(".emoji-pop")).toBeDisplayed();
    await waitForCount(".emoji-pop .emoji-cell", 7);
    return read;
  };
  const cells = (selector = ".emoji-pop .emoji-cell") => browser.execute((s) => [...document.querySelectorAll<HTMLElement>(s)].filter((c) => !c.hidden && !c.closest("[hidden]")).map((c) => c.dataset.name), selector);
  const sectionTitles = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>(".emoji-pop .emoji-sec")].filter((s) => !s.hidden).map((s) => s.querySelector("h3")!.textContent));

  it("has the button last in the box of a message with reactions and of one without, with a label and no text, and opens nothing by itself", async () => {
    await openDetail({}, thread());
    expect(await browser.execute(() => [...document.querySelectorAll("#st-msgs .st-msg")].map((m) => [...m.querySelectorAll(".reactions > *")].map((e) => e.className.split(" ")[0])))).toEqual([["reaction", "reaction", "reaction-add"], ["reaction-add"]]);
    const buttons = await browser.execute(() => [...document.querySelectorAll<HTMLButtonElement>("#st-msgs .reaction-add")].map((b) => [b.tagName, b.type, b.getAttribute("aria-label"), b.textContent, b.querySelectorAll("svg").length]));
    expect(buttons).toEqual([["BUTTON", "button", "リアクションを追加", "", 1], ["BUTTON", "button", "リアクションを追加", "", 1]]);
    expect(await count(".emoji-pop")).toBe(0);
    expect(await callsOf("slack_emoji_catalog")).toEqual([]);
  });

  it("takes no room under a message without reactions while the pointer and the focus are elsewhere, and a message with reactions always shows the button", async () => {
    await openDetail({}, thread());
    const height = (message: number) => browser.execute((i) => document.querySelectorAll<HTMLElement>("#st-msgs .st-msg")[i].querySelector<HTMLElement>(".reactions")!.getBoundingClientRect().height, message);
    expect(await height(1)).toBe(0);
    expect(await height(0)).toBeGreaterThan(0);
    expect(await browser.execute(() => document.querySelector<HTMLElement>("#st-msgs .st-msg .reactions .reaction-add")!.getBoundingClientRect().height)).toBeGreaterThan(0);
  });

  it("opens under the button with the search field first, then 最近 (none yet), the workspace's custom emoji and the standard emoji, and asks Rust for the workspace's list once", async () => {
    const list = await picker();
    expect(await callsOf(list)).toEqual([{ teamId: workspace.teamId }]);
    await expect($(".emoji-pop")).toHaveAttribute("role", "dialog");
    await expect($(".emoji-pop input")).toHaveAttribute("aria-label", "絵文字を検索");
    expect(await $(".emoji-pop input").getAttribute("placeholder")).toBeNull();
    expect(await browser.execute(() => document.activeElement === document.querySelector(".emoji-pop input"))).toBe(true);
    await expect($$("#st-msgs .reaction-add")[0]).toHaveAttribute("aria-expanded", "true");
    expect(await sectionTitles()).toEqual(["カスタム", "標準"]);
    expect(await cells(".emoji-pop .emoji-sec:nth-child(2) .emoji-cell")).toEqual(["partyparrot", "ステキ"]);
    expect(await cells(".emoji-pop .emoji-sec:nth-child(3) .emoji-cell")).toEqual(["grinning", "tada", "+1", "eyes", "thinking_face"]);
    expect(await textsOf(".emoji-pop .emoji-sec:nth-child(3) .emoji-cell")).toEqual(["😀", "🎉", "👍", "👀", "🤔"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".emoji-pop .emoji-cell")].map((c) => c.getAttribute("aria-label")).slice(0, 3))).toEqual([":partyparrot:", ":ステキ:", ":grinning:"]);
    // It opens under the button, inside the window.
    const where = await browser.execute(() => {
      const pop = document.querySelector(".emoji-pop")!.getBoundingClientRect();
      const add = document.querySelector("#st-msgs .reaction-add")!.getBoundingClientRect();
      return { near: Math.abs(pop.left - add.left) < 400, inside: pop.left >= 0 && pop.right <= innerWidth && pop.top >= 0 && pop.bottom <= innerHeight };
    });
    expect(where).toEqual({ near: true, inside: true });
    // Closed and opened again: the list is not asked for again.
    await browser.keys("Escape");
    await expect($(".emoji-pop")).not.toExist();
    await addButton(1);
    await expect($(".emoji-pop")).toBeDisplayed();
    await waitForCount(".emoji-pop .emoji-cell", 7);
    expect(await callsOf(list)).toHaveLength(1);
  });

  it("narrows the cells by a part of the name, case ignored, hides a section with none, and says so when nothing matches", async () => {
    await picker();
    const input = $(".emoji-pop input");
    await input.setValue("TH");
    expect(await cells()).toEqual(["thinking_face"]);
    expect(await sectionTitles()).toEqual(["標準"]);
    await input.setValue("パーティ");
    expect(await cells()).toEqual([]);
    await expect($(".emoji-pop .menu-empty")).toBeDisplayed();
    await input.setValue("ステ");
    expect(await cells()).toEqual(["ステキ"]);
    expect(await sectionTitles()).toEqual(["カスタム"]);
    await expect($(".emoji-pop .menu-empty")).not.toBeDisplayed();
    await input.setValue("");
    expect(await cells()).toHaveLength(7);
    await input.setValue("a");
    expect(await cells()).toEqual(["partyparrot", "tada", "thinking_face"]);
  });

  it("fetches the images of the custom emoji in view and draws them in the cells", async () => {
    await picker();
    await browser.waitUntil(async () => (await count(".emoji-pop .emoji-cell img.reaction-img")) === 2);
    expect(await browser.execute(() => [...document.querySelectorAll(".emoji-pop .emoji-cell img")].map((i) => i.getAttribute("src")))).toEqual([pngUri, pngUri]);
    const asked = (await callsOf("fetch_images")).flatMap((c) => (c as { urls: string[] }).urls).sort();
    expect(asked).toEqual([partyUrl, sutekiUrl].sort());
  });

  it("adds the emoji picked with slack_react and closes: the arguments, a reaction at the end of the message's reactions and the picker's button kept last", async () => {
    await picker();
    const react = await mock("slack_react", true);
    await $('.emoji-pop .emoji-cell[data-name="thinking_face"]').click();
    expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root, name: "thinking_face", add: true }]);
    await expect($(".emoji-pop")).not.toExist();
    await browser.waitUntil(async () => (await count("#st-msgs .st-msg:first-child .reaction")) === 3);
    expect(await browser.execute(() => [...document.querySelectorAll("#st-msgs .st-msg:first-child .reactions > *")].map((e) => e.className.split(" ")[0] + ":" + (e as HTMLElement).dataset.name))).toEqual(["reaction:tada", "reaction:eyes", "reaction:thinking_face", "reaction-add:undefined"]);
    const added = await browser.execute(() => {
      const r = document.querySelector<HTMLElement>('#st-msgs .reaction[data-name="thinking_face"]')!;
      return [r.querySelector(".reaction-emoji")!.textContent, r.querySelector(".reaction-count")!.textContent, r.classList.contains("mine"), r.getAttribute("aria-pressed")];
    });
    expect(added).toEqual(["🤔", "1", true, "true"]);
  });

  it("adds to a message with no reaction: the box shows the new reaction, and the message was not read again", async () => {
    await picker();
    await browser.keys("Escape");
    await addButton(1);
    await waitForCount(".emoji-pop .emoji-cell", 7);
    const react = await mock("slack_react", true);
    await $('.emoji-pop .emoji-cell[data-name="tada"]').click();
    expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: reply1, name: "tada", add: true }]);
    await browser.waitUntil(async () => (await count("#st-msgs .st-msg:last-child .reaction")) === 1);
    await expect($("#st-msgs .st-msg:last-child .reactions")).not.toHaveElementClass("empty");
    expect(await textsOf("#st-msgs .st-msg:last-child .reaction-count")).toEqual(["1"]);
    expect(await callsOf("slack_thread")).toHaveLength(1);
  });

  it("raises the count of a reaction the message has and gives it the user's frame; an answer of false changes only the frame", async () => {
    await picker();
    const react = await mock("slack_react", true);
    await $('.emoji-pop .emoji-cell[data-name="tada"]').click();
    await waitForCalls(react);
    await browser.waitUntil(async () => (await textsOf('#st-msgs .st-msg:first-child .reaction[data-name="tada"] .reaction-count'))[0] === "4");
    await expect($('#st-msgs .st-msg:first-child .reaction[data-name="tada"]')).toHaveElementClass("mine");
    expect(await count("#st-msgs .st-msg:first-child .reaction")).toBe(2);
    // The user's own, picked again: Slack says it was so already (false), and the count stays.
    await addButton(0);
    // The tada just added is in 最近 now.
    await waitForCount(".emoji-pop .emoji-cell", 8);
    await mock("slack_react", false);
    await $('.emoji-pop .emoji-cell[data-name="eyes"]').click();
    await waitForCalls("slack_react");
    await browser.pause(200);
    expect(await textsOf('#st-msgs .st-msg:first-child .reaction[data-name="eyes"] .reaction-count')).toEqual(["1"]);
  });

  it("adds a custom emoji with its name, shows its image in the reaction, and keeps it for 最近", async () => {
    await picker();
    const react = await mock("slack_react", true);
    await $('.emoji-pop .emoji-cell[data-name="ステキ"]').click();
    expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root, name: "ステキ", add: true }]);
    await browser.waitUntil(async () => (await count('#st-msgs .reaction[data-name="ステキ"]')) === 1);
    await browser.waitUntil(async () => (await count('#st-msgs .reaction[data-name="ステキ"] img.reaction-img')) === 1);
    // The picker of another message lists it first, under 最近, before the custom and standard emoji.
    await addButton(1);
    await waitForCount(".emoji-pop .emoji-cell", 8);
    expect(await sectionTitles()).toEqual(["最近", "カスタム", "標準"]);
    expect(await cells(".emoji-pop .emoji-sec:nth-child(1) .emoji-cell")).toEqual(["ステキ"]);
  });

  it("puts the emoji added last first in 最近, once each", async () => {
    await picker();
    const react = await mock("slack_react", true);
    await $('.emoji-pop .emoji-cell[data-name="grinning"]').click();
    await waitForCalls(react);
    await browser.waitUntil(async () => (await count("#st-msgs .st-msg:first-child .reaction")) === 3);
    await addButton(1);
    await waitForCount(".emoji-pop .emoji-cell", 8);
    await $('.emoji-pop .emoji-cell[data-name="+1"]').click();
    await waitForCalls(react, 2);
    await browser.waitUntil(async () => (await count("#st-msgs .st-msg:last-child .reaction")) === 1);
    await addButton(1);
    await waitForCount(".emoji-pop .emoji-cell", 9);
    await $('.emoji-pop .emoji-sec:nth-child(1) .emoji-cell[data-name="grinning"]').click();
    await waitForCalls(react, 3);
    await browser.waitUntil(async () => (await count("#st-msgs .st-msg:last-child .reaction")) === 2);
    await addButton(0);
    await waitForCount(".emoji-pop .emoji-cell", 9);
    expect(await cells(".emoji-pop .emoji-sec:nth-child(1) .emoji-cell")).toEqual(["grinning", "+1"]);
  });

  it("picks the first cell the search leaves with Enter", async () => {
    await picker();
    const react = await mock("slack_react", true);
    await $(".emoji-pop input").setValue("ey");
    await browser.keys("Enter");
    expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: root, name: "eyes", add: true }]);
    await expect($(".emoji-pop")).not.toExist();
  });

  it("closes with Escape and with a press elsewhere, and sends nothing", async () => {
    await picker();
    const react = await mock("slack_react", true);
    await browser.keys("Escape");
    await expect($(".emoji-pop")).not.toExist();
    await addButton(0);
    await waitForCount(".emoji-pop .emoji-cell", 7);
    await press($$("#st-msgs .st-msg")[0].$(".st-text"));
    await expect($(".emoji-pop")).not.toExist();
    await browser.pause(200);
    expect(await callsOf(react)).toEqual([]);
    await expect($$("#st-msgs .reaction-add")[0]).not.toHaveAttribute("aria-expanded");
  });

  it("changes nothing and shows the error when slack_react fails, and the next pick can be tried", async () => {
    await picker();
    const before = await count("#st-msgs .st-msg:first-child .reaction");
    const react = await mock("slack_react", rejects("このメッセージにはこれ以上違う絵文字のリアクションを付けられません"));
    await $('.emoji-pop .emoji-cell[data-name="grinning"]').click();
    await waitForCalls(react);
    await expect($(".toast")).toHaveText(expect.stringContaining("リアクションを変えられませんでした: このメッセージにはこれ以上違う絵文字のリアクションを付けられません"));
    expect(await count("#st-msgs .st-msg:first-child .reaction")).toBe(before);
    // A failed pick is not remembered.
    await addButton(0);
    await waitForCount(".emoji-pop .emoji-cell", 7);
    expect(await sectionTitles()).toEqual(["カスタム", "標準"]);
  });

  it("asks again the next time when the workspace has no custom emoji in its list", async () => {
    await openDetail({}, thread());
    const list = await mock("slack_emoji_catalog", emojiCatalog([["grinning", "😀"]], []));
    await addButton(0);
    await waitForCount(".emoji-pop .emoji-cell", 1);
    await browser.keys("Escape");
    await expect($(".emoji-pop")).not.toExist();
    await addButton(0);
    await waitForCount(".emoji-pop .emoji-cell", 1);
    expect(await callsOf(list)).toHaveLength(2);
  });

  it("shows the error in the picker when the list cannot be read, and asks again the next time", async () => {
    await openDetail({}, thread());
    await mock("slack_emoji_catalog", rejects("Slack に接続できません"));
    await addButton(0);
    await expect($(".emoji-pop .emoji-status")).toHaveText(expect.stringContaining("読み込めませんでした: Slack に接続できません"));
    await browser.keys("Escape");
    const list = await mock("slack_emoji_catalog", catalog());
    await addButton(0);
    await waitForCount(".emoji-pop .emoji-cell", 7);
    expect(await callsOf(list)).toHaveLength(1);
  });

  it("shows no text that explains the picker: the field has no placeholder and the sections are named", async () => {
    await picker();
    expect(await $(".emoji-pop input").getAttribute("placeholder")).toBeNull();
    expect(await textsOf(".emoji-pop h3")).toEqual(["最近", "カスタム", "標準"]);
  });
});

describe("slack thread: reply", () => {
  it("shows the toolbar, the field and a send arrow in one frame, with no placeholder and no text button, and the arrow off while the text is blank", async () => {
    await openDetail();
    await browser.waitUntil(async () => (await editable()) === "true");
    await expect(field()).toBeDisplayed();
    await expect($("#st-tools")).toHaveAttribute("role", "toolbar");
    expect(await $$("#st-tools button").map((b) => b.getAttribute("aria-label"))).toEqual(TOOLS);
    await expect(field()).toHaveAttribute("aria-label", "スレッドに返信");
    expect(await field().getAttribute("placeholder")).toBeNull();
    await expect(send()).toHaveAttribute("aria-label", "返信");
    expect(await send().getText()).toBe("");
    await expect($("#st-reply .composer #st-send")).toExist();
    await expect($("button=返信する")).not.toExist();
    expect(await heightOf("#st-input")).toBeGreaterThanOrEqual(60);
    await expect(send()).toBeDisabled();
    await write("  ");
    await expect(send()).toBeDisabled();
    await write("Thanks");
    await expect(send()).toBeEnabled();
  });

  it("grows with its text up to six lines, then scrolls", async () => {
    await openDetail();
    await lines(3);
    const three = await heightOf("#st-input");
    await lines(5);
    expect(await heightOf("#st-input")).toBeGreaterThan(three);
    await lines(12);
    const six = await heightOf("#st-input");
    expect(six).toBe(await browser.execute(() => parseFloat(getComputedStyle(document.getElementById("st-input")!).maxHeight)));
    expect(await browser.execute(() => document.getElementById("st-input")!.scrollHeight)).toBeGreaterThan(six);
  });

  it("posts with slack_reply on Cmd+Enter (Ctrl+Enter off macOS), empties the field, reads the thread again and says so", async () => {
    const read = await openDetail();
    const post = await mock("slack_reply", true);
    await write("Thanks, will do");
    await pressReply();
    expect(await waitForCalls(post)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", threadTs: root, text: "Thanks, will do\n", markdown: true }]);
    await expect($("#st-note")).toHaveText("スレッドに返信しました");
    await browser.waitUntil(async () => (await fieldText()) === "");
    await waitForCalls(read, 2);
  });

  it("posts with the arrow too, and takes plain Enter as a line break", async () => {
    await openDetail();
    const post = await mock("slack_reply", true);
    await write("First line");
    await browser.keys("Enter");
    await browser.keys("Second line".split(""));
    expect(await callsOf(post)).toEqual([]);
    await send().click();
    const [call] = await waitForCalls(post);
    expect(call).toMatchObject({ teamId: workspace.teamId, channel: "C0123ABCD", threadTs: root, markdown: true });
    expect((call as { text: string }).text).toMatch(/^First line\s+Second line\n$/);
  });

  it("posts a text made bold with the toolbar as Markdown", async () => {
    await openDetail();
    const post = await mock("slack_reply", true);
    await write("Hello");
    await selectAll();
    await tool("太字").click();
    await expect($("#st-input strong")).toHaveText("Hello");
    await send().click();
    expect(await waitForCalls(post)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", threadTs: root, text: "**Hello**\n", markdown: true }]);
  });

  it("makes a link and a bulleted list with the toolbar", async () => {
    await openDetail();
    const post = await mock("slack_reply", true);
    await write("docs");
    await selectAll();
    await tool("リンク").click();
    await $('#st-tools [aria-label="リンクの URL"]').setValue("https://example.com/docs");
    await browser.keys("Enter");
    await expect($('#st-input a[href="https://example.com/docs"]')).toHaveText("docs");
    await tool("箇条書き").click();
    await send().click();
    const [call] = await waitForCalls(post);
    expect(call).toMatchObject({ markdown: true });
    expect((call as { text: string }).text).toContain("[docs](https://example.com/docs)");
    expect((call as { text: string }).text).toMatch(/^[*-] /m);
  });

  it("shows the thread's new end after a reply, scrolled to it", async () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => threadMessage(slackTs(100 - i, i), `Person ${i}`, "a line\nanother line\nand a third line"));
    await openDetail({}, slackThread(long(12)));
    const after = slackThread([...long(12), threadMessage(slackTs(0), "Alice Example", "Thanks, will do")]);
    await mock("slack_reply", true);
    await mock("slack_thread", after);
    await write("Thanks, will do");
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
    await write("Keep me");
    await send().click();
    await expect($("#st-error")).toHaveText(expect.stringContaining("返信できませんでした: 投稿できません"));
    expect(await fieldText()).toBe("Keep me");
    await expect(send()).toBeEnabled();
    expect(await editable()).toBe("true");
    expect(await callsOf("slack_thread")).toHaveLength(1);
  });

  it("locks the field and the button while the reply is on its way", async () => {
    await openDetail();
    const post = await mock("slack_reply", holds);
    await write("Wait for it");
    await send().click();
    await waitForCalls(post);
    expect(await editable()).toBe("false");
    await expect(tool("太字")).toBeDisabled();
    await expect(send()).toBeDisabled();
    await browser.execute(() => document.getElementById("st-send")!.click());
    await pressReply();
    expect(await callsOf(post)).toHaveLength(1);
    await release(post, true);
    await browser.waitUntil(async () => (await editable()) === "true");
    expect(await callsOf(post)).toHaveLength(1);
  });

  it("empties the field and says so when the reply ends after the thread was left and opened again", async () => {
    await openDetail();
    const post = await mock("slack_reply", holds);
    await write("Posted while away");
    await send().click();
    await waitForCalls(post);
    await $("#st-back").click();
    await $("#slack-feed .feed-open").click();
    await waitForCount("#st-msgs .st-msg", 2);
    await release(post, true);
    await browser.waitUntil(async () => (await fieldText()) === "");
    await expect($("#st-note")).toHaveText("スレッドに返信しました");
  });

  it("keeps the reply per thread in memory, and starts another thread with an empty field", async () => {
    const other = slackTs(20, 3);
    const messages = [listMessage(), timelineMessage(other, "Carol Example", "general", "Another thread")];
    await openDetail({}, base(), messages);
    await write("Draft of the first thread");
    await $("#st-back").click();
    await mock("slack_thread", slackThread([threadMessage(other, "Carol Example", "Another thread")]));
    await $$("#slack-feed .feed-open")[1].click();
    await waitForCount("#st-msgs .st-msg", 1);
    expect(await fieldText()).toBe("");
    await write("Draft of the second");
    await $("#st-back").click();
    await mock("slack_thread", base());
    await $$("#slack-feed .feed-open")[0].click();
    await waitForCount("#st-msgs .st-msg", 2);
    expect(await fieldText()).toBe("Draft of the first thread");
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

  it("shows the card of a summary that ends after the thread was left and opened again", async () => {
    await openDetail(todo);
    const summary = await mock("todoist_summarize_slack", holds);
    await $("#st-todo").click();
    await waitForCalls(summary);
    await $("#st-back").click();
    await $("#slack-feed .feed-open").click();
    await waitForCount("#st-msgs .st-msg", 2);
    await release(summary, slackSummary);
    await expect(cardOf()).toBeDisplayed();
  });

  it("keeps an edited card when the same thread is opened again", async () => {
    await openDetail(todo);
    await mock("todoist_summarize_slack", slackSummary);
    await $("#st-todo").click();
    await expect(cardOf()).toBeDisplayed();
    await $("#st-card .review-name").setValue("Edited name");
    await $("#st-back").click();
    await $("#slack-feed .feed-open").click();
    await waitForCount("#st-msgs .st-msg", 2);
    await expect($("#st-card .review-name")).toHaveValue("Edited name");
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

describe("slack thread: Claude Code", () => {
  const term = "#reply-term";
  const thread = [
    { name: "Alice Example", ts: root, text: rootText },
    { name: "Bob Example", ts: reply1, text: "Looks fine to me." },
  ];
  // What `claude_thread_data` answers: Rust's text, which the screen gives to Claude Code as it is.
  const threadData = "スレッドのメッセージ（古い順）:\nBEGIN abc\nAlice Example: Please review the deploy notes.\nEND abc";
  const read = () => askScreen("read", "slack-thread");
  // The starts of this pane's process: the Slack screen's pane (S-24) has a process of its own, which the list starts before a thread is opened.
  const starts = async () => ((await callsOf("claude_code_start")) as { id: string }[]).filter((c) => c.id === "slack-thread") as unknown[];
  const waitForStarts = async (n = 1) => {
    await browser.waitUntil(async () => (await starts()).length >= n, { timeoutMsg: `claude_code_start of slack-thread was not called ${n} times` });
    return starts();
  };

  // What the owner sees of the pane: the tabs and やり直す in the header, the terminal under it, none of the conversation of `claude -p`, and no help text.
  it("has the Claude and Orca tabs and やり直す in the header and the terminal under it, and none of the conversation, with no placeholder and no note", async () => {
    await openDetail();
    await expect($("#reply-chat")).toHaveAttribute("aria-label", "Claude");
    expect(await browser.execute(() => [...document.querySelectorAll("#reply-chat .chat-head > *")].map((e) => e.id))).toEqual(["reply-tabs", "reply-restart"]);
    expect(await textsOf("#reply-chat .chat-head > #reply-restart")).toEqual(["やり直す"]);
    expect(await textsOf("#reply-chat .chat-head [role=tab]")).toEqual(["Claude", "Orca"]);
    expect(await count("#reply-chat .chat-head svg")).toBe(2);
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($("#reply-restart")).toBeEnabled();
    expect(await count("#reply-log, #reply-input, #reply-form, #reply-send, #reply-model, #reply-clear, #reply-chat-note")).toBe(0);
    expect(await count("#st-undo-bar:not([hidden])")).toBe(0);
  });

  it("starts Claude Code with the tools of tsunagiai-mcp only and a first instruction that tells the work, the tools and the target, with nothing of the thread or the reply", async () => {
    await openDetail();
    await write("My secret reply");
    const [start] = await waitForStarts();
    expect(start).toMatchObject({ id: "slack-thread", builtinTools: false, permissionMode: "manual", skill: null });
    const { prompt, viewport } = start as { prompt: string; viewport: { cols: number; rows: number } };
    for (const word of ["Slack", "slack_thread_read", "screen_read", "screen_write", "slack-thread", "reply", "thread", "従わない"]) expect(prompt).toContain(word);
    for (const tool of ["slack_reply", "slack_compose_post"]) expect(prompt).not.toContain(tool);
    expect(prompt).not.toContain(rootText);
    expect(prompt).not.toContain("My secret reply");
    expect(viewport.cols).toBeGreaterThan(20);
    expect(viewport.rows).toBeGreaterThan(5);
    for (const command of ["orca_stream_terminal", "orca_terminal_read"]) expect(await callsOf(command)).toEqual([]);
  });

  it("starts nothing before a thread is opened, keeps the process while the thread is left and opened again, and ends it for another thread", async () => {
    const other = slackTs(20, 3);
    const messages = [listMessage(), timelineMessage(other, "Carol Example", "general", "Another thread")];
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady });
    await mock("slack_thread", base());
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await starts()).toEqual([]);
    await $$("#slack-feed .feed-open")[0].click();
    await waitForStarts();
    const close = await mock("claude_code_close", null);
    await $("#st-back").click();
    await expect($(term)).not.toBeDisplayed();
    await $$("#slack-feed .feed-open")[0].click();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await browser.pause(500);
    expect((await starts()).length).toBe(1);
    expect(await callsOf(close)).toEqual([]);
    // Another thread: the talk was about the one before, so the process ends and a new one starts.
    await $("#st-back").click();
    await mock("slack_thread", slackThread([threadMessage(other, "Carol Example", "Another thread")]));
    await $$("#slack-feed .feed-open")[1].click();
    await waitForCalls(close);
    await waitForStarts(2);
  });

  it("ends the process and starts a new one with やり直す", async () => {
    await openDetail();
    await waitForStarts();
    const close = await mock("claude_code_close", null);
    await $("#reply-restart").click();
    expect(await waitForCalls(close)).toEqual([{ id: "slack-thread", launch: 1 }]);
    expect(await waitForStarts(2)).toHaveLength(2);
    await expect($("#reply-restart")).toBeEnabled();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  });

  it("answers a read with the thread as Rust encloses it and the reply field's text as it is now", async () => {
    await openDetail();
    const data = await mock("claude_thread_data", threadData);
    expect(await read()).toEqual({ ok: true, fields: { thread: threadData, reply: "" } });
    expect(await callsOf(data)).toEqual([{ thread, truncated: false }]);
    await write("Typed by hand");
    // The field's Markdown ends with a line break, as the field gives it.
    expect(await read()).toEqual({ ok: true, fields: { thread: threadData, reply: "Typed by hand\n" } });
  });

  it("gives Rust the messages as the screen shows them, with truncated when the read of the thread stopped before its end", async () => {
    const blocks = slackThread([threadMessage(root, "Deploy Bot", "alt", { text: "Deploy done\nOpen (https://a.example/x)" })]);
    await openDetail({}, { ...blocks, truncated: true });
    const data = await mock("claude_thread_data", threadData);
    await read();
    expect(await callsOf(data)).toEqual([{ thread: [{ name: "Deploy Bot", ts: root, text: "Deploy done\nOpen (https://a.example/x)" }], truncated: true }]);
  });

  it("answers a fixed line for the thread and the reply field while the thread is not read, and asks Rust for nothing", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([listMessage()]), claude_status: claudeReady });
    await mock("slack_thread", rejects("読めません"));
    const data = await mock("claude_thread_data", threadData);
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await $("#slack-feed .feed-open").click();
    await expect($("#st-msgs .pending.fail")).toBeDisplayed();
    expect(await read()).toEqual({ ok: true, fields: { thread: "スレッドはまだ読めていません", reply: "" } });
    expect(await callsOf(data)).toEqual([]);
  });

  it("answers an error for the screen when no thread is open", async () => {
    await openDetail();
    await $("#st-back").click();
    expect(await read()).toEqual({ ok: false, error: expect.stringContaining("画面が開いていません") });
    expect((await askScreen("write", "slack-thread", { reply: "x" })).ok).toBe(false);
    await expect($("#slack-list")).toBeDisplayed();
  });

  it("writes the reply field as it is, posts nothing, shows 元に戻す, and puts the text back", async () => {
    await openDetail();
    const post = await mock("slack_reply", true);
    await mock("claude_thread_data", threadData);
    await expect($("#st-undo")).not.toBeDisplayed();
    await write("確認おねがいします");
    expect(await askScreen("write", "slack-thread", { reply: "ご確認をお願いします\n\n- 1\n- 2" })).toEqual({ ok: true });
    await browser.waitUntil(async () => (await fieldText()).startsWith("ご確認をお願いします"));
    await expect(send()).toBeEnabled();
    await expect($("#st-undo")).toHaveText("元に戻す");
    expect(await callsOf(post)).toEqual([]);
    expect(await read()).toMatchObject({ ok: true, fields: { reply: "ご確認をお願いします\n\n- 1\n- 2" } });
    await $("#st-undo").click();
    await browser.waitUntil(async () => (await fieldText()) === "確認おねがいします");
    await expect($("#st-undo")).not.toBeDisplayed();
    expect(await callsOf(post)).toEqual([]);
    await expect($("#slack-thread")).toBeDisplayed();
  });

  it("fills a blank reply field, which makes the send button usable without posting", async () => {
    await openDetail();
    const post = await mock("slack_reply", true);
    await expect(send()).toBeDisabled();
    await askScreen("write", "slack-thread", { reply: "確認しました。" });
    await browser.waitUntil(async () => (await fieldText()) === "確認しました。");
    await expect(send()).toBeEnabled();
    expect(await callsOf(post)).toEqual([]);
  });

  it("refuses to write the field thread and a field that does not exist, and changes nothing", async () => {
    await openDetail();
    await write("Mine");
    expect(await askScreen("write", "slack-thread", { thread: "x" })).toEqual({ ok: false, error: expect.stringContaining("読むだけ") });
    expect(await askScreen("write", "slack-thread", { reply: "x", other: "y" })).toEqual({ ok: false, error: expect.stringContaining("欄 other はありません") });
    expect(await fieldText()).toBe("Mine");
    await expect($("#st-undo")).not.toBeDisplayed();
  });

  it("takes the writes back one by one, the newest first", async () => {
    await openDetail();
    await askScreen("write", "slack-thread", { reply: "First" });
    await askScreen("write", "slack-thread", { reply: "Second" });
    await browser.waitUntil(async () => (await fieldText()) === "Second");
    await $("#st-undo").click();
    await browser.waitUntil(async () => (await fieldText()) === "First");
    await expect($("#st-undo")).toBeDisplayed();
    await $("#st-undo").click();
    await browser.waitUntil(async () => (await fieldText()) === "");
    await expect($("#st-undo")).not.toBeDisplayed();
  });

  it("has no way back for a write that changes nothing, and none once the field was changed by hand", async () => {
    await openDetail();
    await mock("claude_thread_data", threadData);
    await write("Same");
    const now = (await read()).fields!.reply;
    await askScreen("write", "slack-thread", { reply: now });
    await expect($("#st-undo")).not.toBeDisplayed();
    await askScreen("write", "slack-thread", { reply: "Written" });
    await expect($("#st-undo")).toBeDisplayed();
    await write(" and typed");
    await expect($("#st-undo")).not.toBeDisplayed();
  });

  it("has no way back left after the reply is posted", async () => {
    await openDetail();
    await mock("slack_reply", true);
    await write("Mine");
    await askScreen("write", "slack-thread", { reply: "Written" });
    await expect($("#st-undo")).toBeDisplayed();
    await send().click();
    await expect($("#st-note")).toHaveText("スレッドに返信しました");
    await expect($("#st-undo")).not.toBeDisplayed();
  });

  it("refuses a write while the reply is on its way", async () => {
    await openDetail();
    const post = await mock("slack_reply", holds);
    await write("Mine");
    await send().click();
    await waitForCalls(post);
    expect(await askScreen("write", "slack-thread", { reply: "Late" })).toEqual({ ok: false, error: expect.stringContaining("返信の最中") });
    await release(post, true);
  });
});

describe("slack thread: the lines of the two sides", () => {
  const edge = (selector: string, side: "top" | "bottom") => browser.execute((s, k) => document.querySelector(s)!.getBoundingClientRect()[k], selector, side);
  // The line under the headers is one, and the terminal starts under it and goes down to the bottom with the reply field.
  const aligned = async () => {
    expect(await edge("#reply-chat .chat-head", "bottom")).toBe(await edge("#st-head", "bottom"));
    expect(await edge("#reply-term", "top")).toBe(await edge("#st-head", "bottom"));
    expect(await edge("#reply-term", "bottom")).toBe(await edge("#st-reply", "bottom"));
  };

  it("puts the line under the headers at the same height, and the terminal from it to the bottom", async () => {
    await openDetail();
    await aligned();
  });

  it("keeps them there when the reply field grows", async () => {
    await openDetail();
    const before = await edge("#st-reply", "top");
    await lines(12);
    expect(await edge("#st-reply", "top")).toBeLessThan(before);
    await aligned();
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
    expect(await browser.execute(() => document.getElementById("slack-split")!.getAttribute("aria-valuenow"))).toBe("45");
  });
});
