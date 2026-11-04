import { attachment, boot, callsOf, claudeReady, count, holds, inbox, mock, onceId, ownIcon, para, plain, pngUri, quote, rejects, release, slackLoad, slackThread, slackTs, span, textsOf, threadMessage, timeline, timelineMessage, timelineReply, unreadRepliesOf, waitForCalls, waitForCount, waitForText, watchedMessage, workspace } from "../support";

const iconUrl = "https://avatars.slack-edge.com/T1-U1/a_72.png";

// Two messages, the newest first: the first has two replies.
const sample = () => [
  timelineMessage(slackTs(5, 1), "Alice Example", "dev", "Please review the deploy notes.", { replyCount: 2 }),
  timelineMessage(slackTs(30, 2), "Bob Example", "general", "Lunch at noon."),
];

// `n` messages of two lines each, newest first (the list must be taller than the window to scroll).
const many = (n: number, text = "line one of the message\nline two of the message") =>
  Array.from({ length: n }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `${text} ${i}`, { unread: true }));

// `unread` unread messages, each in a channel of its own, newest first: "unread 0" ...
const heap = (unread: number) => Array.from({ length: unread }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `unread ${i}`, { unread: true, channel: `C${i}` }));
const unreadTexts = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `unread:unread ${from + i}`);

// The app with one workspace whose messages are `messages`, and the Slack screen open.
async function openList(value = timeline(sample()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: value, claude_status: claudeReady, ...fixtures });
  await $("#nav-slack").click();
  await expect($("#slack-list")).toBeDisplayed();
}

const rowTexts = (selector: string) => textsOf(`#slack-feed .feed-row ${selector}`);
// What the list holds from the top: "unread:text" and "read:text" per row, the heading's text ("未読", "ウォッチ") and "button:..." for the button of the rest.
const layout = () =>
  browser.execute(() =>
    [...document.getElementById("slack-feed")!.children].map((c) => {
      if (c.classList.contains("feed-heading")) return c.textContent!.trim();
      if (c.classList.contains("feed-more")) return `button:${c.textContent}`;
      const row = c.querySelector(".feed-row")!;
      return `${row.classList.contains("unread") ? "unread" : "read"}:${row.querySelector(".feed-text")!.textContent}`;
    }),
  );
const weightOf = (selector: string) => browser.execute((s) => getComputedStyle(document.querySelector(s)!).fontWeight, selector);

// Newest first. Channel C0123ABCD: "first" and "second" are unread; channel C2: "other" is unread (older than "first", newer than "second").
const unreadSample = () => [
  timelineMessage(slackTs(1), "Alice Example", "dev", "first", { unread: true }),
  timelineMessage(slackTs(2), "Bob Example", "random", "other", { unread: true, channel: "C2" }),
  timelineMessage(slackTs(3), "Alice Example", "dev", "second", { unread: true }),
];
// Threads watched (S-13): "Watched read" has 2 new replies and is read, "Watched unread" is unread and has none. Their channel is C3.
const watchedSample = () => [
  watchedMessage(slackTs(10), "Carol Example", "ops", "Watched read", 2, { channel: "C3", replyCount: 3 }),
  watchedMessage(slackTs(20), "Dave Example", "ops", "Watched unread", 0, { channel: "C3", unread: true }),
];
// The Slack screen with `messages` (`fixtures` change the answers), a row of which opens a thread that `slack_thread` answers; `slack_mark_read` is mocked.
async function openUnread(messages: ReturnType<typeof unreadSample>, extra: Parameters<typeof timeline>[1] = {}) {
  await openList(timeline(messages, extra));
  await waitForCount("#slack-feed .feed-row", messages.length + (extra.watched?.length ?? 0));
  const mark = await mock("slack_mark_read", true);
  await mock("slack_thread", slackThread([threadMessage(messages[0].ts, "Alice Example", "first")]));
  return mark;
}
const openRow = async (text: string) => {
  const rows = await $$("#slack-feed .feed-row");
  for (const row of rows) if ((await row.$(".feed-text").getText()) === text) return row.$(".feed-open").click();
  throw new Error(`no row with ${text}`);
};
const scrollTop = () => browser.execute(() => document.getElementById("slack-feed")!.scrollTop);
// What a press at the middle of `selector` lands on, by the page's own hit test (WebDriver's click goes to the element it is given, whatever lies above it).
const hitAt = (selector: string) =>
  browser.execute((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)!;
    return `${e.tagName}.${e.className}`;
  }, selector);
// A press at the middle of `selector`, on what the hit test finds.
const pressAt = (selector: string) =>
  browser.execute(
    (s, id) => {
      if (!window.__e2e_once__(id)) return;
      const r = document.querySelector(s)!.getBoundingClientRect();
      (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement).click();
    },
    selector,
    onceId(),
  );

// A bot's post as Slack draws it: a bold line, fields, a button, and an attachment (S-11).
const botTs = slackTs(1);
const botPost = (extra: Parameters<typeof timelineMessage>[4] = {}) =>
  timelineMessage(botTs, "CI", "dev", "*Success!* *Project:* example/api View Job", {
    unread: true,
    showText: false,
    blocks: [
      { type: "section", text: [para(span("Success!", "b"))], fields: [[para(span("Project:", "b"), span(" example/api"))], [para(span("Job:", "b"), span(" deploy"))]], accessory: null },
      { type: "actions", buttons: [{ text: "View Job", url: "https://example.com/job" }, { text: "Rerun", url: null }] },
    ],
    attachments: [attachment({ color: "#2eb67d", text: plain("Deployed"), image: { url: "https://example.com/a.png", alt: "a chart" } })],
    ...extra,
  });

// A thread with unread replies: its row is read itself ("Parent") and has the replies "reply one" and "reply two", oldest first.
const replyOne = slackTs(4, 1);
const replyTwo = slackTs(3, 2);
const parentTs = slackTs(9);
const withReplies = (extra: Parameters<typeof timelineMessage>[4] = {}) =>
  timelineMessage(parentTs, "Alice Example", "dev", "Parent", {
    replyCount: 5,
    unreadReplies: unreadRepliesOf([timelineReply(replyOne, "Bob Example", "reply one"), timelineReply(replyTwo, "Carol Example", "reply two")]),
    ...extra,
  });

describe("slack list", () => {
  it("reads the timeline when the screen is shown and draws a row per message in the order it came", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await callsOf("slack_timeline")).toEqual([null]);
    // No count in the header: the unread count is the Slack button's badge, which 0 hides.
    await expect($("#slack-unread")).not.toExist();
    await expect($("#nav-slack .nav-count")).not.toBeDisplayed();
    // The list starts 8px below the top, as the inbox's does.
    expect(await browser.execute(() => getComputedStyle(document.getElementById("slack-feed")!).paddingTop)).toBe("8px");
    expect(await rowTexts(".feed-meta b")).toEqual(["Alice Example", "Bob Example"]);
    expect(await rowTexts(".feed-meta span")).toEqual(["#dev", "#general"]);
    expect(await rowTexts(".feed-text")).toEqual(["Please review the deploy notes.", "Lunch at noon."]);
    for (const date of await rowTexts(".feed-date")) expect(date).toMatch(/^(\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日)$/);
  });

  it("stretches one real button over a row, with the text cut at two lines, and the button that hides its channel beside it, not in it", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    const row = await browser.execute(() => {
      const r = document.querySelector<HTMLElement>("#slack-feed .feed-row")!;
      const open = r.querySelector<HTMLElement>(".feed-open")!;
      const [a, b] = [r.getBoundingClientRect(), open.getBoundingClientRect()];
      return { tag: r.tagName, open: open.tagName, covers: [a.width === b.width, a.height === b.height], clamp: getComputedStyle(r.querySelector(".feed-text")!).getPropertyValue("-webkit-line-clamp"), buttons: r.querySelectorAll("button").length, label: open.getAttribute("aria-label") };
    });
    expect(row).toEqual({ tag: "DIV", open: "BUTTON", covers: [true, true], clamp: "2", buttons: 1, label: "Alice Example #dev Please review the deploy notes." });
    // Pressing what is drawn is pressing the button.
    expect(await hitAt("#slack-feed .feed-text")).toBe("BUTTON.feed-open");
    const beside = await browser.execute(() => {
      const item = document.querySelector<HTMLElement>("#slack-feed .feed-item")!;
      return [".feed-hide", ".feed-watch"].map((s) => {
        const b = item.querySelector<HTMLElement>(s)!;
        return { tag: b.tagName, inRow: !!b.closest(".feed-row"), item: b.parentElement!.className, label: b.getAttribute("aria-label") };
      });
    });
    expect(beside).toEqual([
      { tag: "BUTTON", inRow: false, item: "feed-item", label: "#dev を一覧に出さない" },
      { tag: "BUTTON", inRow: false, item: "feed-item", label: "ウォッチする" },
    ]);
  });

  it("shows 返信 N 件 only for a message that has replies", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await textsOf("#slack-feed .feed-replies")).toEqual(["返信 2 件"]);
    expect(await count("#slack-feed .feed-item:nth-of-type(2) .feed-replies")).toBe(0);
  });

  it("shows a message of files only as 添付ファイル, and attached images never in a row", async () => {
    await openList(timeline([timelineMessage(slackTs(1), "Alice Example", "dev", "", { hasFiles: true })]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await rowTexts(".feed-text")).toEqual(["（添付ファイル）"]);
    expect(await count("#slack-feed img:not(.av-img)")).toBe(0);
  });

  it("marks a row's avatar with the workspace's color, the same as the workspace's avatar in the sidebar", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    const [dot, tray, initial] = await browser.execute(() => [
      document.querySelector<HTMLElement>("#slack-feed .feed-ws")!.style.background,
      document.querySelector<HTMLElement>("#slack-workspace-list .avatar")!.style.background,
      document.querySelector<HTMLElement>("#slack-feed .feed-avatar .av-text")!.textContent,
    ]);
    expect(dot).not.toBe("");
    expect(dot).toBe(tray);
    expect(initial).toBe("AE");
  });

  it("fetches the sender icons through fetch_images and puts them on the avatars, and keeps the initial when they cannot be fetched", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady, slack_timeline: timeline([timelineMessage(slackTs(1), "Alice Example", "dev", "Hi", { iconUrl }), timelineMessage(slackTs(2, 1), "Bob Example", "dev", "Hello", { iconUrl: "https://avatars.slack-edge.com/T1-U2/a_72.png" })]) });
    const fetch = await mock("fetch_images", { [iconUrl]: pngUri });
    await $("#nav-slack").click();
    expect(await waitForCalls(fetch)).toEqual([{ urls: [iconUrl, "https://avatars.slack-edge.com/T1-U2/a_72.png"] }]);
    await browser.waitUntil(async () => (await count("#slack-feed .feed-avatar img.av-img")) === 1);
    expect(await browser.execute(() => document.querySelector<HTMLImageElement>("#slack-feed .feed-avatar img.av-img")!.src)).toBe(pngUri);
    expect(await textsOf("#slack-feed .feed-avatar .av-text")).toEqual(["BE"]);
  });

  it("asks for no workspace's messages when none is connected, says so, and opens the Slack settings from 設定を開く", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await $("#nav-slack").click();
    await expect($("#slack-feed .feed-empty")).toHaveText(expect.stringContaining("ワークスペースが接続されていません"));
    expect(await callsOf("slack_timeline")).toEqual([]);
    await $("#slack-feed .feed-empty .text-btn").click();
    await expect($("#settings")).toBeDisplayed();
    await expect($("#settings-tab-slack")).toHaveAttribute("aria-selected", "true");
  });

  it("says in a notice which workspace could not be read and which token lacks scopes, keeps the rows that were read, and opens the settings from it", async () => {
    await openList(
      timeline(sample(), {
        failed: [{ teamId: "T2", team: "Other Team", error: "接続できません" }],
        missing: [{ teamId: "T1", team: "Example Team", scopes: ["users:read", "files:read"] }],
      }),
    );
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await textsOf("#slack-notice > div")).toEqual([
      "Other Team を読み込めませんでした: 接続できません設定を開く",
      "Example Team: users:read、files:read の権限がありません設定を開く",
    ]);
    await $("#slack-notice > div .text-btn").click();
    await expect($("#settings-tab-slack")).toHaveAttribute("aria-selected", "true");
  });

  it("shows a spinner on the first read, and the rows when it answers", async () => {
    // The first read is the one at startup, which is held.
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: holds, claude_status: claudeReady });
    const read = "slack_timeline";
    await waitForCalls(read);
    await $("#nav-slack").click();
    await expect($("#slack-feed .spin")).toBeDisplayed();
    expect(await count("#slack-feed .feed-row")).toBe(0);
    await release(read, timeline(sample()));
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await count("#slack-feed .spin")).toBe(0);
  });

  it("says that the read failed when there is nothing to show, and reads again from 再読み込み", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: rejects("接続できません"), claude_status: claudeReady });
    await $("#nav-slack").click();
    await expect($("#slack-feed .pending.fail")).toHaveText(expect.stringContaining("読み込めませんでした: 接続できません"));
    await mock("slack_timeline", timeline(sample()));
    await $("#slack-feed .pending.fail .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 2);
  });

  it("offers 再読み込み when the read fails while a list with no message is held", async () => {
    await openList(timeline([], { refreshSecs: 1 }));
    await expect($("#slack-feed .feed-empty")).toHaveText("メッセージはありません");
    await mock("slack_timeline", rejects("接続できません"));
    await expect($("#slack-feed .pending.fail")).toHaveText(expect.stringContaining("読み込めませんでした: 接続できません"));
    await mock("slack_timeline", timeline(sample()));
    await $("#slack-feed .pending.fail .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 2);
  });

  it("drops the rows and the failure of the last workspace when it was removed", async () => {
    await openList(timeline(sample()));
    await waitForCount("#slack-feed .feed-row", 2);
    await mock("slack_load", { workspaces: [], recent: [] });
    await $("#nav-todo").click();
    await $("#nav-slack").click();
    await expect($("#slack-feed .feed-empty")).toHaveText(expect.stringContaining("ワークスペースが接続されていません"));
    expect(await count("#slack-feed .feed-row")).toBe(0);
    expect(await count("#slack-workspace-list button")).toBe(0);
  });

  it("keeps the workspaces, the rows and the refresh when slack_load fails", async () => {
    await openList(timeline(sample(), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await mock("slack_load", rejects("読めません"));
    await $("#nav-todo").click();
    await $("#nav-slack").click();
    await waitForText("#slack-notice > div", "読み込めませんでした: 読めません");
    expect(await count("#slack-workspace-list button")).toBe(1);
    expect(await count("#slack-feed .feed-row")).toBe(2);
    await waitForCalls("slack_timeline", 2);
  });

  it("says there is nothing to show when the workspaces have no message", async () => {
    await openList(timeline([]));
    await expect($("#slack-feed .feed-empty")).toHaveText("メッセージはありません");
  });

  it("reads again every refreshSecs while the screen is shown and replaces the rows in place, keeping the scroll position", async () => {
    await openList(timeline(many(20), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 10);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 20);
    await browser.execute(() => {
      document.getElementById("slack-feed")!.scrollTop = 300;
    });
    expect(await scrollTop()).toBe(300);
    await mock("slack_timeline", timeline([timelineMessage(slackTs(0), "New Person", "dev", "A new message", { unread: true }), ...many(19)], { refreshSecs: 1 }));
    await waitForText("#slack-feed .feed-meta b", "New Person");
    expect(await count("#slack-feed .feed-row")).toBe(20);
    expect(await scrollTop()).toBe(300);
    await expect($("#slack-list")).toBeDisplayed();
  });

  it("goes on reading every refreshSecs while another screen is shown, without drawing the list there or switching the screen", async () => {
    await openList(timeline(sample(), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await $("#nav-todo").click();
    await expect($("#todo")).toBeDisplayed();
    const before = (await callsOf("slack_timeline")).length;
    await waitForCalls("slack_timeline", before + 2);
    await expect($("#todo")).toBeDisplayed();
    await expect($("#slack-list")).not.toBeDisplayed();
    expect(await count("#slack-feed .feed-row")).toBe(2);
  });

  it("reads at startup, before the Slack screen is shown, and draws the list from what was read when it is shown", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(sample()), claude_status: claudeReady });
    await waitForCalls("slack_timeline");
    await expect($("#slack-list")).not.toBeDisplayed();
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 2);
    // The startup read is the only one: showing the screen reads again only after refreshSecs.
    expect(await callsOf("slack_timeline")).toEqual([null]);
  });

  it("does not read at startup without a workspace", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await browser.pause(1500);
    expect(await callsOf("slack_timeline")).toEqual([]);
    await expect($("#nav-slack .nav-count")).not.toBeDisplayed();
  });

  it("draws only the answer of the latest read", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: rejects("接続できません"), claude_status: claudeReady });
    await $("#nav-slack").click();
    await expect($("#slack-feed .pending.fail")).toBeDisplayed();
    // The first 再読み込み waits; the second one answers at once. The first answer to arrive is the older one, and it must not be drawn.
    const read = await mock("slack_timeline", holds);
    await $("#slack-feed .pending.fail .text-btn").click();
    await waitForCalls(read);
    await mock("slack_timeline", timeline([timelineMessage(slackTs(1), "Newer Person", "dev", "The newer answer")]));
    await $("#slack-feed .pending.fail .text-btn").click();
    await waitForText("#slack-feed .feed-meta b", "Newer Person");
    await release(read, timeline([timelineMessage(slackTs(2), "Older Person", "dev", "The older answer")]));
    await browser.pause(300);
    expect(await rowTexts(".feed-meta b")).toEqual(["Newer Person"]);
  });

  it("does not read again when the screen is shown again before refreshSecs have passed, and draws the list it holds", async () => {
    await openList(timeline(sample()));
    await waitForCount("#slack-feed .feed-row", 2);
    for (const leave of ["#nav-mail", "#nav-todo"]) {
      await $(leave).click();
      await $("#nav-slack").click();
      await expect($("#slack-list")).toBeDisplayed();
      await waitForCount("#slack-feed .feed-row", 2);
    }
    await browser.pause(300);
    expect(await callsOf("slack_timeline")).toEqual([null]);
  });

  it("does not start a read while one is on its way when the screen is shown again", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: holds, claude_status: claudeReady });
    const read = "slack_timeline";
    await waitForCalls(read);
    await $("#nav-slack").click();
    await $("#nav-mail").click();
    await $("#nav-slack").click();
    await expect($("#slack-list")).toBeDisplayed();
    await browser.pause(300);
    expect(await callsOf("slack_timeline")).toEqual([null]);
    await release(read, timeline(sample()));
    await waitForCount("#slack-feed .feed-row", 2);
  });

  it("says above the notice how many channels no read has reached yet, until none is left", async () => {
    await openList(timeline(sample(), { pendingChannels: 3, refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await expect($("#slack-pending")).toBeDisplayed();
    await expect($("#slack-pending")).toHaveText("残り 3 チャンネルを読み込み中");
    const place = await browser.execute(() => {
      const pending = document.getElementById("slack-pending")!;
      return {
        before: !!(pending.compareDocumentPosition(document.getElementById("slack-notice")!) & Node.DOCUMENT_POSITION_FOLLOWING),
        left: getComputedStyle(pending).paddingLeft,
      };
    });
    expect(place).toEqual({ before: true, left: "32px" });
    await mock("slack_timeline", timeline(sample(), { pendingChannels: 0, refreshSecs: 1 }));
    await browser.waitUntil(async () => !(await $("#slack-pending").isDisplayed()));
  });

  it("keeps the user's own icon on the tray's avatar and in its popup after a read that changes nothing and after leaving the screen", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady, slack_timeline: timeline(sample(), { refreshSecs: 1 }), slack_icons: ownIcon(iconUrl) });
    await mock("fetch_images", { [iconUrl]: pngUri });
    await $("#nav-slack").click();
    await browser.waitUntil(async () => (await count("#slack-workspace-list img.av-img")) === 1);
    await waitForCalls("slack_timeline", 2);
    await browser.pause(300);
    expect(await count("#slack-workspace-list img.av-img")).toBe(1);
    await $("#slack-workspace-list button").click();
    expect(await count("#account-popup .avatar img.av-img")).toBe(1);
    await $("#nav-todo").click();
    await $("#nav-slack").click();
    await expect($("#slack-list")).toBeDisplayed();
    expect(await count("#slack-workspace-list img.av-img")).toBe(1);
  });

  it("shows the failure with 再読み込み when a read answers with a failed workspace and no message, and reads again from it", async () => {
    await openList(timeline([], { failed: [{ teamId: "T1", team: "Example Team", error: "接続できません" }] }));
    await expect($("#slack-feed .pending.fail")).toHaveText(expect.stringContaining("読み込めませんでした: Example Team: 接続できません"));
    expect(await count("#slack-feed .feed-empty")).toBe(0);
    await mock("slack_timeline", timeline(sample()));
    await $("#slack-feed .pending.fail .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 2);
  });

  it("keeps the rows that were read when a later read fails, and says so in the notice", async () => {
    await openList(timeline(sample(), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await mock("slack_timeline", rejects("接続できません"));
    await waitForText("#slack-notice > div", "読み込めませんでした: 接続できません");
    expect(await rowTexts(".feed-meta b")).toEqual(["Alice Example", "Bob Example"]);
    expect(await count("#slack-feed .pending.fail")).toBe(0);
  });

  it("draws the user's own icon of each workspace in the sidebar's tray", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady, slack_timeline: timeline(sample()), slack_icons: ownIcon(iconUrl) });
    const fetch = await mock("fetch_images", { [iconUrl]: pngUri });
    await $("#nav-slack").click();
    await waitForCalls("slack_icons");
    expect(await waitForCalls(fetch)).toContainEqual({ urls: [iconUrl] });
    await browser.waitUntil(async () => (await count("#slack-workspace-list img.av-img")) === 1);
  });

  it("lists the unread rows under a 未読 heading, in the order they came, in bold, and no 既読 heading", async () => {
    await openList(timeline(unreadSample()));
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other", "unread:second"]);
    expect(await count("#slack-feed .feed-heading svg")).toBe(1);
    expect(await weightOf("#slack-feed .feed-row.unread")).toBe("700");
  });

  it("draws a heading for each section that has rows: 未読 above ウォッチ, and none for an empty one", async () => {
    const both = timeline(unreadSample(), { watched: watchedSample(), refreshSecs: 1 });
    await openList(both);
    await waitForCount("#slack-feed .feed-row", 5);
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other", "unread:second", "ウォッチ", "read:Watched read", "unread:Watched unread"]);
    expect(await count("#slack-feed .feed-heading svg")).toBe(2);
    await mock("slack_timeline", timeline([], { watched: watchedSample(), refreshSecs: 1 }));
    await browser.waitUntil(async () => (await count("#slack-feed .feed-row")) === 2);
    expect(await layout()).toEqual(["ウォッチ", "read:Watched read", "unread:Watched unread"]);
    await mock("slack_timeline", timeline(unreadSample(), { refreshSecs: 1 }));
    await browser.waitUntil(async () => (await count("#slack-feed .feed-row")) === 3);
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other", "unread:second"]);
    await mock("slack_timeline", timeline([], { refreshSecs: 1 }));
    await expect($("#slack-feed .feed-empty")).toHaveText("メッセージはありません");
    expect(await count("#slack-feed .feed-heading")).toBe(0);
  });

  it("takes a row out when a read finds it read", async () => {
    await openList(timeline(unreadSample(), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_timeline", timeline(unreadSample().filter((m) => m.channel !== "C2"), { refreshSecs: 1 }));
    await browser.waitUntil(async () => !(await layout()).includes("unread:other"));
    expect(await layout()).toEqual(["未読", "unread:first", "unread:second"]);
  });

  it("calls slack_mark_read with the opened message when a row is pressed, and takes that row and the older ones of its channel out on the return", async () => {
    const messages = unreadSample();
    const mark = await openUnread(messages);
    await openRow("second");
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[2].ts }]);
    await expect($("#slack-thread")).toBeDisplayed();
    await $("#st-back").click();
    await expect($("#slack-list")).toBeDisplayed();
    // The newer message of the channel and the other channel's stay unread.
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other"]);
  });

  it("sets the position to the newest message of the channel when that one is pressed, which takes the older ones of the channel out and no other channel's", async () => {
    const messages = unreadSample();
    const mark = await openUnread(messages);
    await openRow("first");
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[0].ts }]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["未読", "unread:other"]);
  });

  it("does not call slack_mark_read for a row that is read already, a watched one", async () => {
    const mark = await openUnread(unreadSample(), { watched: watchedSample() });
    await openRow("Watched read");
    await expect($("#slack-thread")).toBeDisplayed();
    await browser.pause(300);
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other", "unread:second", "ウォッチ", "read:Watched read", "unread:Watched unread"]);
  });

  it("neither calls slack_mark_read nor moves a row when the token lacks a write scope", async () => {
    const mark = await openUnread(unreadSample(), { missing: [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write", "groups:write"] }] });
    await openRow("second");
    await expect($("#slack-thread")).toBeDisplayed();
    await browser.pause(300);
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other", "unread:second"]);
  });

  it("shows Slack's value at the next read when slack_mark_read fails", async () => {
    const messages = unreadSample();
    const mark = await openUnread(messages, { refreshSecs: 1 });
    await mock("slack_mark_read", rejects("失敗しました"));
    await openRow("first");
    await waitForCalls(mark);
    // The next read of the list (every second here) answers Slack's value, which still has the message unread.
    await browser.waitUntil(async () => (await callsOf("slack_timeline")).length >= 2);
    await $("#st-back").click();
    await browser.waitUntil(async () => (await layout()).includes("unread:first"));
  });

  it("shows the first 10 unread rows with a button for the rest, whose count is the rest, and all of them (20 at most) once it is pressed", async () => {
    await openList(timeline(heap(20)));
    await waitForCount("#slack-feed .feed-row", 10);
    await expect($("#nav-slack .nav-count")).toHaveText("20");
    expect(await layout()).toEqual(["未読", ...unreadTexts(10), "button:未読をあと 10 件表示"]);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 20);
    expect(await layout()).toEqual(["未読", ...unreadTexts(20)]);
    expect(await count("#slack-feed .feed-more")).toBe(0);
    await expect($("#nav-slack .nav-count")).toHaveText("20");
  });

  it("says in the button how many unread rows are left when fewer than 10 are", async () => {
    await openList(timeline(heap(14)));
    await waitForCount("#slack-feed .feed-row", 10);
    expect(await textsOf("#slack-feed .feed-more .text-btn")).toEqual(["未読をあと 4 件表示"]);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 14);
    expect(await count("#slack-feed .feed-more")).toBe(0);
  });

  it("draws no button for 10 unread rows or fewer", async () => {
    await openList(timeline(heap(10)));
    await waitForCount("#slack-feed .feed-row", 10);
    expect(await count("#slack-feed .feed-more")).toBe(0);
  });

  it("keeps the rest of the unread rows shown through a background read", async () => {
    await openList(timeline(heap(20), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 10);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 20);
    await waitForCalls("slack_timeline", 3);
    await browser.pause(300);
    expect(await count("#slack-feed .feed-more")).toBe(0);
    expect(await count("#slack-feed .feed-row")).toBe(20);
  });

  it("keeps the rest of the unread rows shown on the return from a thread", async () => {
    await openList(timeline(heap(20)));
    await waitForCount("#slack-feed .feed-row", 10);
    await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(heap(1)[0].ts, "Person 0", "unread 0")]));
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 20);
    await openRow("unread 4");
    await expect($("#slack-thread")).toBeDisplayed();
    await $("#st-back").click();
    await expect($("#slack-list")).toBeDisplayed();
    expect(await count("#slack-feed .feed-more")).toBe(0);
    expect(await count("#slack-feed .feed-row.unread")).toBe(19);
  });

  it("goes back to 10 unread rows when Slack is opened again from another screen", async () => {
    await openList(timeline(heap(20)));
    await waitForCount("#slack-feed .feed-row", 10);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 20);
    await $("#nav-todo").click();
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 10);
    expect(await textsOf("#slack-feed .feed-more .text-btn")).toEqual(["未読をあと 10 件表示"]);
  });

  // The Slack button's badge (S-8): the unread messages held, on any screen.
  const badge = () => $("#nav-slack .nav-count");
  const badgeLabel = () => browser.execute(() => document.getElementById("nav-slack")!.getAttribute("aria-label"));

  it("shows the unread count on the Slack button from the read at startup, with the count in its label, on a screen other than Slack", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(3)), claude_status: claudeReady });
    await expect(badge()).toHaveText("3");
    await expect(badge()).toBeDisplayed();
    expect(await badgeLabel()).toBe("Slack（未読 3 件）");
    await expect($("#slack-list")).not.toBeDisplayed();
  });

  it("shows no badge for 0 unread messages", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(sample()), claude_status: claudeReady });
    await waitForCalls("slack_timeline");
    await browser.pause(300);
    await expect(badge()).not.toBeDisplayed();
    expect(await badgeLabel()).toBe("Slack");
  });

  it("counts the messages held, not the ones listed, and shows 20+ above 20 with the real number in the label", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(20), { unreadTotal: 20 }), claude_status: claudeReady });
    await expect(badge()).toHaveText("20");
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(20), { unreadTotal: 37 }), claude_status: claudeReady });
    await expect(badge()).toHaveText("20+");
    expect(await badgeLabel()).toBe("Slack（未読 37 件）");
  });

  it("follows the unread count on another screen without showing or switching the Slack screen, and keeps the number when a read fails", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(2), { refreshSecs: 1 }), claude_status: claudeReady });
    await expect(badge()).toHaveText("2");
    await $("#nav-todo").click();
    await expect($("#todo")).toBeDisplayed();
    await mock("slack_timeline", timeline(heap(5), { refreshSecs: 1 }));
    await waitForText("#nav-slack .nav-count", "5");
    await expect($("#todo")).toBeDisplayed();
    await expect($("#slack-list")).not.toBeDisplayed();
    await mock("slack_timeline", rejects("接続できません"));
    await waitForCalls("slack_timeline");
    await browser.pause(300);
    await expect(badge()).toHaveText("5");
    await mock("slack_timeline", timeline(sample(), { refreshSecs: 1 }));
    await browser.waitUntil(async () => !(await badge().isDisplayed()));
  });

  it("lowers the badge at once by the rows an opened message makes read", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(3)), claude_status: claudeReady });
    await expect(badge()).toHaveText("3");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(heap(1)[0].ts, "Person 0", "unread 0")]));
    await openRow("unread 1");
    await expect(badge()).toHaveText("2");
    expect(await badgeLabel()).toBe("Slack（未読 2 件）");
  });

  it("does not add the Slack count to the Dock badge", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(3)), claude_status: claudeReady });
    await expect(badge()).toHaveText("3");
    expect((await callsOf("set_badge")).every((c) => (c as { count: number }).count !== 3)).toBe(true);
  });

  // Keeping a channel off the list (S-9).
  const devRows = () => count("#slack-feed .feed-row");
  const withHidden = () => [
    timelineMessage(slackTs(1), "Alice Example", "dev", "from dev", { unread: true }),
    timelineMessage(slackTs(2), "Bob Example", "random", "from random", { unread: true, channel: "C2" }),
    timelineMessage(slackTs(3), "Bob Example", "dev", "older from dev"),
  ];

  // :hover and :focus never match in the E2E window (it is hidden and the driver does not hover), so the shown state cannot be reached:
  // the hidden state is the computed style with no hover, and the rules that lift it are read from the stylesheet to say that hover or focus inside the row does.
  it("hides the button that keeps a row's channel off the list and shows the date, unless the mouse is over the row or the focus is in it, when the date gives way to the button", async () => {
    await openList(timeline(withHidden()));
    await waitForCount("#slack-feed .feed-row", 3);
    const state = await browser.execute(() => {
      const v = (item: Element, s: string) => getComputedStyle(item.querySelector(s)!).visibility;
      return [...document.querySelectorAll("#slack-feed .feed-item")].map((item) => ({ hide: v(item, ".feed-hide"), date: v(item, ".feed-date") }));
    });
    expect(state).toEqual(Array.from({ length: 3 }, () => ({ hide: "hidden", date: "visible" })));
    const rules = await browser.execute(() => {
      const found: Record<string, string | null> = { shows: null, hidesDate: null };
      for (const sheet of document.styleSheets)
        for (const rule of sheet.cssRules) {
          if (!(rule instanceof CSSStyleRule)) continue;
          if (rule.selectorText.includes(".feed-hide") && rule.style.visibility === "visible") found.shows = rule.selectorText;
          if (rule.selectorText.includes(".feed-date") && rule.style.visibility === "hidden") found.hidesDate = rule.selectorText;
        }
      return found;
    });
    for (const selector of [rules.shows, rules.hidesDate]) {
      expect(selector).toContain(".feed-item:hover");
      expect(selector).toContain(".feed-item:focus-within");
    }
  });

  it("takes the channel's rows out at once on pressing the button, calls slack_hide_channel, opens no thread and marks nothing read", async () => {
    await openList(timeline(withHidden()));
    await waitForCount("#slack-feed .feed-row", 3);
    const hide = await mock("slack_hide_channel", holds);
    const mark = await mock("slack_mark_read", true);
    const thread = await mock("slack_thread", slackThread([threadMessage(withHidden()[0].ts, "Alice Example", "from dev")]));
    await mock("slack_timeline", timeline([withHidden()[1]]));
    await $('button[aria-label="#dev を一覧に出さない"]').click();
    expect(await waitForCalls(hide)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD" }]);
    // Before Rust has answered, both rows of #dev are gone and #random stays.
    expect(await textsOf("#slack-feed .feed-text")).toEqual(["from random"]);
    await release(hide, true);
    await expect($(".toast")).toHaveText(expect.stringContaining("#dev を一覧に出さないようにしました"));
    await expect($("#slack-thread")).not.toBeDisplayed();
    expect(await callsOf(thread)).toEqual([]);
    expect(await callsOf(mark)).toEqual([]);
  });

  it("lowers the badge at once by the unread rows of the hidden channel, and makes the list again from Rust's cache, asking Slack nothing", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(withHidden()), claude_status: claudeReady });
    await expect(badge()).toHaveText("2");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_hide_channel", true);
    await mock("slack_timeline", timeline([withHidden()[1]]));
    await $('button[aria-label="#dev を一覧に出さない"]').click();
    await expect(badge()).toHaveText("1");
    expect(await waitForCalls("slack_timeline")).toEqual([{ cached: true }]);
    await browser.pause(300);
    // One cached read, and no full read of Slack on top of it.
    expect(await callsOf("slack_timeline")).toEqual([{ cached: true }]);
    await expect($(".toast")).toHaveText(expect.stringContaining("元に戻す"));
  });

  it("puts the channel back with 元に戻す: slack_unhide_channel is called and the list is read again", async () => {
    await openList(timeline(withHidden()));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_hide_channel", true);
    await mock("slack_timeline", timeline([withHidden()[1]]));
    await $('button[aria-label="#dev を一覧に出さない"]').click();
    await waitForCalls("slack_timeline");
    await expect($(".toast button")).toHaveText("元に戻す");
    const unhide = await mock("slack_unhide_channel", true);
    await mock("slack_timeline", timeline(withHidden()));
    await $(".toast button").click();
    expect(await waitForCalls(unhide)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD" }]);
    expect(await waitForCalls("slack_timeline")).toEqual([{ cached: true }]);
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await devRows()).toBe(3);
    await browser.pause(300);
    expect(await callsOf("slack_timeline")).toEqual([{ cached: true }]);
  });

  it("does not bring a hidden row back from a read that began before the channel was hidden, and picks up what that read left in the cache with one read from the cache", async () => {
    await openList(timeline(withHidden(), { refreshSecs: 2 }));
    await waitForCount("#slack-feed .feed-row", 3);
    // The periodic read is on its way when the channel is hidden.
    const read = await mock("slack_timeline", holds);
    await waitForCalls(read);
    await mock("slack_hide_channel", true);
    await $('button[aria-label="#dev を一覧に出さない"]').click();
    await waitForCalls(read, 2);
    expect((await callsOf(read)).slice(1)).toEqual([{ cached: true }]);
    // The older answer still has the rows of #dev: it is passed over.
    await release(read, timeline(withHidden()));
    await browser.pause(300);
    expect(await textsOf("#slack-feed .feed-text")).toEqual(["from random"]);
    // The read from the cache that follows it, for what it left in the cache (the latest request is a cached one), and the answer to the request before.
    await waitForCalls(read, 3);
    expect((await callsOf(read)).slice(1)).toEqual([{ cached: true }, { cached: true }]);
    await release(read, timeline([withHidden()[1]]));
    await release(read, timeline([withHidden()[1]]));
    await browser.pause(300);
    expect(await textsOf("#slack-feed .feed-text")).toEqual(["from random"]);
    expect(await count("#slack-feed .feed-row")).toBe(1);
  });

  it("gives the focus back to a row's hide button when a background read redraws the list", async () => {
    const messages = withHidden();
    await openList(timeline(messages, { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 3);
    const active = () => browser.execute(() => ({ label: document.activeElement?.getAttribute("aria-label"), key: (document.activeElement as HTMLElement | null)?.dataset.key }));
    // The button is hidden until the pointer or the focus is in its row, and the E2E window matches neither: show it by hand to focus it.
    await browser.execute(() => {
      const hide = document.querySelector<HTMLElement>("#slack-feed .feed-hide")!;
      hide.style.visibility = "visible";
      hide.focus();
    });
    const before = await active();
    expect(before.label).toBe("#dev を一覧に出さない");
    expect(before.key).toMatch(/\/hide$/);
    // A new message at the top changes the list, so that it is drawn again.
    await mock("slack_timeline", timeline([timelineMessage(slackTs(0), "New Person", "dev", "A new message", { channel: "C3" }), ...messages], { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 4);
    expect(await active()).toEqual(before);
  });

  it("brings the rows back and says so when slack_hide_channel fails", async () => {
    await openList(timeline(withHidden()));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_hide_channel", rejects("保存できません"));
    await $('button[aria-label="#dev を一覧に出さない"]').click();
    await expect($("#error")).toHaveText(expect.stringContaining("保存できません"));
    await waitForCount("#slack-feed .feed-row", 3);
  });

  // The header (S-13).
  it("fixes a header above the list, tinted as the thread's, with the title, the button that marks all read and the icon that opens the hidden channels", async () => {
    await openList(timeline(many(20)));
    await waitForCount("#slack-feed .feed-row", 10);
    // The list is taller than the window only with all 20 rows.
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 20);
    await expect($("#slack-header h1")).toHaveText("Slack");
    await expect($("#slack-mark-all")).toHaveText("すべて既読にする");
    await expect($("#slack-hidden-open")).toHaveAttribute("aria-label", "一覧に出さないチャンネル");
    const colors = await browser.execute(() => [getComputedStyle(document.getElementById("slack-header")!).backgroundColor, getComputedStyle(document.getElementById("st-head")!).backgroundColor]);
    expect(colors[0]).toBe(colors[1]);
    const top = () => browser.execute(() => document.getElementById("slack-header")!.getBoundingClientRect().top);
    const before = await top();
    await browser.execute(() => {
      document.getElementById("slack-feed")!.scrollTop = 300;
    });
    expect(await scrollTop()).toBe(300);
    expect(await top()).toBe(before);
    // The header is not part of what scrolls.
    expect(await browser.execute(() => document.getElementById("slack-feed")!.contains(document.getElementById("slack-header")))).toBe(false);
  });

  it("opens the Slack tab of the settings from the hidden channels icon", async () => {
    await openList();
    await $("#slack-hidden-open").click();
    await expect($("#settings")).toBeDisplayed();
    await expect($("#settings-tab-slack")).toHaveAttribute("aria-selected", "true");
  });

  it("cannot press すべて既読にする with nothing to mark, and can with an unread channel", async () => {
    await openList(timeline(sample(), { markableChannels: 0, refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await expect($("#slack-mark-all")).toBeDisabled();
    await mock("slack_timeline", timeline(unreadSample(), { refreshSecs: 1 }));
    await expect($("#slack-mark-all")).toBeEnabled();
    await mock("slack_timeline", timeline(sample(), { refreshSecs: 1, markableChannels: 0 }));
    await expect($("#slack-mark-all")).toBeDisabled();
  });

  it("marks all read on the second press only: the first says 'もう一度押すとすべて既読', and leaving the button disarms it", async () => {
    await openList(timeline(unreadSample()));
    await waitForCount("#slack-feed .feed-row", 3);
    const all = await mock("slack_mark_all_read", { marked: 2, failed: 0 });
    await $("#slack-mark-all").click();
    await expect($("#slack-mark-all")).toHaveText("もう一度押すとすべて既読");
    expect(await callsOf(all)).toEqual([]);
    expect(await count("#slack-feed .feed-row")).toBe(3);
    await browser.execute(() => document.getElementById("slack-mark-all")!.blur());
    await expect($("#slack-mark-all")).toHaveText("すべて既読にする");
    await $("#slack-mark-all").click();
    await $("#slack-mark-all").click();
    expect(await waitForCalls(all)).toEqual([null]);
  });

  it("takes the unread rows out at once on the second press, keeps the watched ones (no longer bold), lowers the badge, and makes the list again from Rust's cache", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(unreadSample(), { watched: watchedSample() }), claude_status: claudeReady });
    await expect($("#nav-slack .nav-count")).toHaveText("3");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 5);
    const all = await mock("slack_mark_all_read", holds);
    const read = await mock("slack_timeline", timeline([], { watched: watchedSample().map((m) => ({ ...m, unread: false })) }));
    await $("#slack-mark-all").click();
    await $("#slack-mark-all").click();
    await waitForCalls(all);
    // Before Rust has answered the rows are gone, the watched ones stay, and nothing is left to press.
    expect(await layout()).toEqual(["ウォッチ", "read:Watched read", "read:Watched unread"]);
    await expect($("#nav-slack .nav-count")).not.toBeDisplayed();
    await expect($("#slack-mark-all")).toBeDisabled();
    await release(all, { marked: 2, failed: 0 });
    expect(await waitForCalls(read)).toEqual([{ cached: true }]);
    await expect($("#error")).not.toBeDisplayed();
  });

  it("leaves the rows of a workspace whose token cannot write the position, and says so when Rust could not move some channels", async () => {
    const lacking = [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write"] }];
    await openList(timeline(unreadSample(), { missing: lacking }));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_mark_all_read", { marked: 0, failed: 0 });
    await $("#slack-mark-all").click();
    await $("#slack-mark-all").click();
    await waitForCalls("slack_mark_all_read");
    expect(await count("#slack-feed .feed-row")).toBe(3);
    await openList(timeline(unreadSample()));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_mark_all_read", { marked: 1, failed: 2 });
    await $("#slack-mark-all").click();
    await $("#slack-mark-all").click();
    await expect($("#error")).toHaveText(expect.stringContaining("2 チャンネルの既読を Slack に送れませんでした"));
  });

  // Watching a thread (S-13).
  it("watches the thread of a row with its bookmark: slack_watch is called with the thread's ts, the row goes to the watch section at once, and no thread opens", async () => {
    const reply = timelineMessage(slackTs(1), "Alice Example", "dev", "a reply sent to the channel", { unread: true, threadTs: "1700000000.000001" });
    await openList(timeline([reply, ...unreadSample().slice(1)]));
    await waitForCount("#slack-feed .feed-row", 3);
    const watch = await mock("slack_watch", holds);
    const mark = await mock("slack_mark_read", true);
    await mock("slack_timeline", timeline(unreadSample().slice(1), { watched: [watchedMessage("1700000000.000001", "Alice Example", "dev", "the thread's message")] }));
    await $('button[aria-label="ウォッチする"]').click();
    expect(await waitForCalls(watch)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: "1700000000.000001" }]);
    expect(await layout()).toEqual(["未読", "unread:other", "unread:second", "ウォッチ", "unread:a reply sent to the channel"]);
    await expect($("#slack-thread")).not.toBeDisplayed();
    expect(await callsOf(mark)).toEqual([]);
    await release(watch, true);
    expect(await waitForCalls("slack_timeline")).toEqual([{ cached: true }]);
    await browser.waitUntil(async () => (await textsOf("#slack-feed .feed-text")).includes("the thread's message"));
  });

  it("brings the row back and says so when slack_watch fails", async () => {
    await openList(timeline(unreadSample()));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_watch", rejects("読めません"));
    await $('button[aria-label="ウォッチする"]').click();
    await expect($("#error")).toHaveText(expect.stringContaining("読めません"));
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other", "unread:second"]);
  });

  it("draws a watched row with its bookmark always shown, 新しい返信 only when there are new replies, and the unread one in bold", async () => {
    await openList(timeline([], { watched: watchedSample() }));
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await textsOf("#slack-feed .feed-new")).toEqual(["新しい返信 2 件"]);
    expect(await textsOf("#slack-feed .feed-replies")).toEqual(["返信 3 件"]);
    const marks = await browser.execute(() =>
      [...document.querySelectorAll("#slack-feed .feed-item")].map((item) => ({
        watch: getComputedStyle(item.querySelector(".feed-watch")!).visibility,
        label: item.querySelector(".feed-watch")!.getAttribute("aria-label"),
        hide: getComputedStyle(item.querySelector(".feed-hide")!).visibility,
      })),
    );
    expect(marks).toEqual(Array.from({ length: 2 }, () => ({ watch: "visible", label: "ウォッチを外す", hide: "hidden" })));
    expect(await weightOf("#slack-feed .feed-row.unread")).toBe("700");
    expect(await weightOf("#slack-feed .feed-row:not(.unread)")).toBe("400");
  });

  it("lets a thread go with its bookmark: slack_unwatch is called, the row goes, and 元に戻す puts it back with the reply it had been seen up to", async () => {
    const watched = watchedSample();
    await openList(timeline([], { watched }));
    await waitForCount("#slack-feed .feed-row", 2);
    const unwatch = await mock("slack_unwatch", "1700000100.000002");
    const watch = await mock("slack_watch", true);
    const ts = watched[0].ts;
    await mock("slack_timeline", timeline([], { watched: [watched[1]] }));
    await $('button[aria-label="ウォッチを外す"]').click();
    expect(await waitForCalls(unwatch)).toEqual([{ teamId: workspace.teamId, channel: "C3", ts }]);
    await expect($(".toast")).toHaveText(expect.stringContaining("ウォッチを外しました"));
    expect(await layout()).toEqual(["ウォッチ", "unread:Watched unread"]);
    await mock("slack_timeline", timeline([], { watched }));
    await $(".toast button").click();
    expect(await waitForCalls(watch)).toEqual([{ teamId: workspace.teamId, channel: "C3", ts, seenTs: "1700000100.000002" }]);
    await waitForCount("#slack-feed .feed-row", 2);
  });

  it("clears 新しい返信 and calls slack_watch_seen when a watched row is opened, and shows no new replies on the return", async () => {
    const watched = watchedSample();
    const mark = await openUnread(unreadSample(), { watched });
    const seen = await mock("slack_watch_seen", true);
    await mock("slack_thread", slackThread([threadMessage(watched[0].ts, "Carol Example", "Watched read")]));
    await openRow("Watched read");
    expect(await waitForCalls(seen)).toEqual([{ teamId: workspace.teamId, channel: "C3", ts: watched[0].ts }]);
    await expect($("#slack-thread")).toBeDisplayed();
    // It is read already, so the position is not set.
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await count("#slack-feed .feed-new")).toBe(0);
  });

  it("sets the position and un-bolds a watched row that was unread when it is opened, keeping it in the watch section", async () => {
    const watched = watchedSample();
    const mark = await openUnread(unreadSample(), { watched });
    await mock("slack_thread", slackThread([threadMessage(watched[1].ts, "Dave Example", "Watched unread")]));
    await openRow("Watched unread");
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C3", ts: watched[1].ts }]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other", "unread:second", "ウォッチ", "read:Watched read", "read:Watched unread"]);
  });

  it("keeps a thread that cannot be read as a row that says so, cannot be opened, and can be let go; a thread not read yet says it is being read", async () => {
    const gone = watchedMessage(slackTs(10), "不明", "ops", "", 0, { channel: "C3", user: null, watch: { newReplies: 0, uncounted: false, status: "unreadable", unreadTo: null } });
    const waiting = watchedMessage(slackTs(20), "不明", "ops", "", 0, { channel: "C3", user: null, watch: { newReplies: 0, uncounted: false, status: "pending", unreadTo: null } });
    await openList(timeline([], { watched: [gone, waiting] }));
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await textsOf("#slack-feed .feed-text")).toEqual(["このスレッドは読めません（削除されたか、チャンネルを抜けた可能性があります）", "読み込んでいます…"]);
    const rows = await browser.execute(() => [...document.querySelectorAll<HTMLButtonElement>("#slack-feed .feed-open")].map((r) => r.disabled));
    expect(rows).toEqual([true, false]);
    const unwatch = await mock("slack_unwatch", null);
    // The list made again from Rust's cache no longer has the thread.
    await mock("slack_timeline", timeline([], { watched: [waiting] }));
    await $$('button[aria-label="ウォッチを外す"]')[0].click();
    expect(await waitForCalls(unwatch)).toEqual([{ teamId: workspace.teamId, channel: "C3", ts: gone.ts }]);
    expect(await count("#slack-feed .feed-row")).toBe(1);
  });

  it("keeps the focus on a watched row's bookmark and the scroll position when a background read redraws the list", async () => {
    const watched = [watchedMessage(slackTs(10), "Carol Example", "ops", "Watched read", 1, { channel: "C3" })];
    await openList(timeline(many(20), { watched, refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 11);
    const active = () => browser.execute(() => (document.activeElement as HTMLElement | null)?.dataset.key);
    await browser.execute(() => {
      document.querySelector<HTMLElement>("#slack-feed .watched .feed-watch")!.focus();
    });
    const before = await active();
    expect(before).toMatch(/\/watch$/);
    await mock("slack_timeline", timeline(many(20), { watched: [{ ...watched[0], watch: { newReplies: 3, uncounted: false, status: "ok", unreadTo: null } }], refreshSecs: 1 }));
    await waitForText("#slack-feed .feed-new", "新しい返信 3 件");
    expect(await active()).toBe(before);
    await expect($("#slack-list")).toBeDisplayed();
  });

  it("does not let a double click arm and confirm すべて既読にする at once: the second click of a double click is ignored", async () => {
    await openList(timeline(unreadSample()));
    await waitForCount("#slack-feed .feed-row", 3);
    const all = await mock("slack_mark_all_read", { marked: 2, failed: 0 });
    // A double click is two clicks with `detail` 1 and 2.
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      const button = document.getElementById("slack-mark-all")!;
      for (const detail of [1, 2]) button.dispatchEvent(new MouseEvent("click", { detail, bubbles: true }));
    }, onceId());
    await expect($("#slack-mark-all")).toHaveText("もう一度押すとすべて既読");
    await browser.pause(300);
    expect(await callsOf(all)).toEqual([]);
    expect(await count("#slack-feed .feed-row")).toBe(3);
    // A later single click confirms.
    await $("#slack-mark-all").click();
    expect(await waitForCalls(all)).toEqual([null]);
  });

  it("says 新しい返信あり, with no number, for new replies that could not be counted", async () => {
    const long = watchedMessage(slackTs(10), "Carol Example", "ops", "A long thread", 0, { channel: "C3" });
    long.watch = { newReplies: 0, uncounted: true, status: "ok", unreadTo: null };
    await openList(timeline([], { watched: [long, ...watchedSample()] }));
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await textsOf("#slack-feed .feed-new")).toEqual(["新しい返信あり", "新しい返信 2 件"]);
  });

  it("moves the read position to the newest unread message of the thread when a watched row is opened, also when the thread's own message is read", async () => {
    const reply = slackTs(2, 7);
    const row = watchedMessage(slackTs(10), "Carol Example", "ops", "Watched read", 0, { channel: "C3" });
    row.watch = { newReplies: 0, uncounted: false, status: "ok", unreadTo: reply };
    const mark = await openUnread(unreadSample(), { watched: [row] });
    await mock("slack_thread", slackThread([threadMessage(row.ts, "Carol Example", "Watched read")]));
    await openRow("Watched read");
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C3", ts: reply }]);
    await expect($("#slack-thread")).toBeDisplayed();
  });

  // What a row draws (S-5, S-11, S-12).
  it("draws a bot's post in a row as the thread does: the styles, the fields in two columns, the buttons and the attachment, and no * of the text", async () => {
    await openList(timeline([botPost()]));
    await waitForCount("#slack-feed .feed-row", 1);
    const drawn = await browser.execute(() => {
      const r = document.querySelector<HTMLElement>("#slack-feed .feed-row")!;
      const fields = r.querySelector<HTMLElement>(".st-fields")!;
      return {
        bold: r.querySelector("p strong")!.textContent,
        columns: getComputedStyle(fields).gridTemplateColumns.split(" ").length,
        fields: r.querySelectorAll(".st-field").length,
        link: r.querySelector<HTMLAnchorElement>("a.text-btn")!.href,
        off: r.querySelector<HTMLButtonElement>(".st-acts button")!.disabled,
        attachment: r.querySelector(".st-att")!.textContent,
        text: r.querySelector(".feed-text")!.textContent,
      };
    });
    expect(drawn.bold).toBe("Success!");
    expect(drawn.columns).toBe(2);
    expect(drawn.fields).toBe(2);
    expect(drawn.link).toBe("https://example.com/job");
    expect(drawn.off).toBe(true);
    expect(drawn.attachment).toContain("Deployed");
    expect(drawn.text).not.toContain("*");
  });

  it("fetches no image in a row and offers no 画像を表示: an image with an address is left out", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([botPost()]), claude_status: claudeReady });
    const fetch = await mock("fetch_images", {});
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await browser.pause(300);
    expect(await callsOf(fetch)).toEqual([]);
    expect(await count("#slack-feed .st-images")).toBe(0);
    expect(await count("#slack-feed .st-img")).toBe(0);
  });

  it("keeps two lines for paragraphs alone, and about 12 lines for blocks, attachments, a code block or a quote, so that a long post cannot take the screen", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const long = [
      timelineMessage(slackTs(1), "Paragraphs", "dev", lines, { unread: true, channel: "C1" }),
      timelineMessage(slackTs(2), "Quote", "dev", lines, { unread: true, channel: "C2", rich: [quote(span(lines))] }),
      timelineMessage(slackTs(3), "Blocks", "dev", lines, { unread: true, channel: "C3", showText: false, blocks: [{ type: "section", text: plain(lines), fields: [], accessory: null }] }),
      timelineMessage(slackTs(4), "Attachment", "dev", lines, { unread: true, channel: "C4", attachments: [attachment({ text: plain(lines) })] }),
    ];
    await openList(timeline(long));
    await waitForCount("#slack-feed .feed-row", 4);
    const heights = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#slack-feed .feed-text")].map((t) => ({ lines: Math.round(t.clientHeight / Number.parseFloat(getComputedStyle(t).lineHeight)), clamp: getComputedStyle(t).getPropertyValue("-webkit-line-clamp"), overflow: getComputedStyle(t).overflowY })));
    expect(heights[0]).toEqual({ lines: 2, clamp: "2", overflow: "hidden" });
    for (const h of heights.slice(1)) expect(h).toEqual({ lines: 12, clamp: "none", overflow: "hidden" });
  });

  it("still says （添付ファイル） for a message of files only, and shows no thumbnail", async () => {
    await openList(timeline([timelineMessage(slackTs(1), "Alice Example", "dev", "", { hasFiles: true, rich: [] })]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await rowTexts(".feed-text")).toEqual(["（添付ファイル）"]);
    expect(await count("#slack-feed .st-files")).toBe(0);
  });

  it("opens the thread on a press anywhere but a link: a link in a row takes its press, and opens no thread and marks nothing read", async () => {
    await openList(timeline([botPost()]));
    await waitForCount("#slack-feed .feed-row", 1);
    const mark = await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(botTs, "CI", "post")]));
    expect(await hitAt("#slack-feed a.text-btn")).toBe("A.text-btn");
    // The address is not followed here: only that nothing else happens.
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      const link = document.querySelector<HTMLElement>("#slack-feed a.text-btn")!;
      link.addEventListener("click", (e) => e.preventDefault());
      link.click();
    }, onceId());
    await browser.pause(300);
    await expect($("#slack-thread")).not.toBeDisplayed();
    expect(await callsOf(mark)).toEqual([]);
    expect(await count("#slack-feed .feed-row")).toBe(1);
    // A button with no address cannot be pressed: the press goes through to the row.
    expect(await hitAt("#slack-feed .st-acts button")).toBe("BUTTON.feed-open");
    await pressAt("#slack-feed .st-acts button");
    await expect($("#slack-thread")).toBeDisplayed();
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: botTs }]);
  });

  it("shows no tooltip for the button stretched over a row", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    await browser.execute((id) => {
      if (window.__e2e_once__(id)) document.querySelector("#slack-feed .feed-open")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    }, onceId());
    await browser.pause(500);
    await expect($(".tooltip")).not.toBeDisplayed();
  });

  it("gives the focus back to the row's button when a background read redraws the list", async () => {
    const messages = sample();
    await openList(timeline(messages, { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await browser.execute(() => document.querySelector<HTMLElement>("#slack-feed .feed-open")!.focus());
    const active = () => browser.execute(() => (document.activeElement as HTMLElement | null)?.dataset.key);
    const before = await active();
    expect(before).toBe(`${workspace.teamId}/C0123ABCD/${messages[0].ts}`);
    await mock("slack_timeline", timeline([...messages, timelineMessage(slackTs(40), "New Person", "dev", "older", { channel: "C3" })], { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await active()).toBe(before);
  });

  // Unread replies (S-14).
  it("lists a thread with unread replies with its toggle open, the replies oldest first, indented, and the row not bold when its own message is read", async () => {
    await openList(timeline([withReplies()]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await layout()).toEqual(["未読", "read:Parent"]);
    expect(await textsOf("#slack-feed .feed-thread-toggle")).toEqual(["未読の返信 2 件"]);
    await expect($("#slack-feed .feed-thread-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(await textsOf("#slack-feed .feed-reply-meta b")).toEqual(["Bob Example", "Carol Example"]);
    expect(await textsOf("#slack-feed .feed-reply .feed-text")).toEqual(["reply one", "reply two"]);
    expect(await weightOf("#slack-feed .feed-row")).toBe("400");
    expect(await weightOf("#slack-feed .feed-reply .feed-text")).toBe("400");
    expect(await count("#slack-feed .feed-reply-rest")).toBe(0);
    const indent = await browser.execute(() => document.querySelector("#slack-feed .feed-reply")!.getBoundingClientRect().left - document.querySelector("#slack-feed .feed-text")!.getBoundingClientRect().left);
    expect(indent).toBeGreaterThan(0);
  });

  it("keeps the row bold while its own message is unread, and not its replies", async () => {
    await openList(timeline([withReplies({ unread: true })]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await weightOf("#slack-feed .feed-row.unread")).toBe("700");
    expect(await weightOf("#slack-feed .feed-reply .feed-text")).toBe("400");
    await expect($("#nav-slack .nav-count")).toHaveText("3");
  });

  it("says 未読の返信あり with no number for replies that could not be counted, and that the others are in the thread", async () => {
    const message = withReplies({ unreadReplies: unreadRepliesOf([], { count: 0, uncounted: true, latestTs: slackTs(1) }) });
    await openList(timeline([message]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await textsOf("#slack-feed .feed-thread-toggle")).toEqual(["未読の返信あり"]);
    expect(await textsOf("#slack-feed .feed-reply-rest")).toEqual(["ほかの返信はスレッドで見られます"]);
    await expect($("#nav-slack .nav-count")).toHaveText("1");
  });

  it("says that the others are in the thread above the 20 replies a row draws", async () => {
    const replies = Array.from({ length: 20 }, (_, i) => timelineReply(slackTs(100 - i, i), `Person ${i}`, `reply ${i}`));
    await openList(timeline([withReplies({ unreadReplies: unreadRepliesOf(replies, { count: 31 }) })]));
    await waitForCount("#slack-feed .feed-reply", 20);
    expect(await textsOf("#slack-feed .feed-thread-toggle")).toEqual(["未読の返信 31 件"]);
    expect(await textsOf("#slack-feed .feed-reply-rest")).toEqual(["ほかの返信はスレッドで見られます"]);
  });

  it("only folds the replies with the toggle: no thread, nothing read, the scroll position kept, and its own focus after a redraw", async () => {
    await openList(timeline([withReplies(), ...many(19)], { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 10);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 20);
    const seen = await mock("slack_thread_seen", true);
    const mark = await mock("slack_mark_read", true);
    const thread = await mock("slack_thread", slackThread([threadMessage(parentTs, "Alice Example", "Parent")]));
    await browser.execute(() => {
      document.getElementById("slack-feed")!.scrollTop = 40;
    });
    expect(await hitAt("#slack-feed .feed-thread-toggle")).toContain("feed-thread-toggle");
    // A click of the page itself: the driver would scroll a clicked element into view first.
    await pressAt("#slack-feed .feed-thread-toggle");
    await waitForCount("#slack-feed .feed-reply", 0);
    await expect($("#slack-feed .feed-thread-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(await scrollTop()).toBe(40);
    await expect($("#slack-thread")).not.toBeDisplayed();
    expect(await callsOf(seen)).toEqual([]);
    expect(await callsOf(mark)).toEqual([]);
    expect(await callsOf(thread)).toEqual([]);
    await browser.execute(() => document.querySelector<HTMLElement>("#slack-feed .feed-thread-toggle")!.focus());
    await mock("slack_timeline", timeline([timelineMessage(slackTs(0), "New Person", "dev", "new", { channel: "C3" }), withReplies(), ...many(19)], { refreshSecs: 1 }));
    await waitForText("#slack-feed .feed-meta b", "New Person");
    expect(await browser.execute(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toMatch(/\/toggle$/);
    await $("#slack-feed .feed-thread-toggle").click();
    await waitForCount("#slack-feed .feed-reply", 2);
  });

  it("keeps a folded thread folded through a background read and the return from a thread, and opens it again once it had no more unread replies", async () => {
    const other = timelineMessage(slackTs(1), "Dan Example", "random", "other", { unread: true, channel: "C2" });
    await openList(timeline([other, withReplies()], { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await $("#slack-feed .feed-thread-toggle").click();
    await waitForCount("#slack-feed .feed-reply", 0);
    await waitForCalls("slack_timeline", 2);
    await browser.pause(300);
    expect(await count("#slack-feed .feed-reply")).toBe(0);
    await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(other.ts, "Dan Example", "other")]));
    await openRow("other");
    await expect($("#slack-thread")).toBeDisplayed();
    await $("#st-back").click();
    await expect($("#slack-list")).toBeDisplayed();
    await expect($("#slack-feed .feed-thread-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(await count("#slack-feed .feed-reply")).toBe(0);
    await mock("slack_timeline", timeline([other], { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-thread-toggle", 0);
    await mock("slack_timeline", timeline([other, withReplies()], { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-reply", 2);
  });

  it("opens the thread from a reply, tells Rust the newest unread reply, takes the row out at once and lowers the badge by its replies", async () => {
    const message = withReplies();
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([message, ...unreadSample()]), claude_status: claudeReady });
    await expect($("#nav-slack .nav-count")).toHaveText("5");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 4);
    const seen = await mock("slack_thread_seen", holds);
    const mark = await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(message.ts, "Alice Example", "Parent")]));
    expect(await hitAt("#slack-feed .feed-reply .feed-text")).toBe("BUTTON.feed-open");
    await pressAt("#slack-feed .feed-reply .feed-text");
    await expect($("#slack-thread")).toBeDisplayed();
    expect(await waitForCalls(seen)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts, latestTs: replyTwo }]);
    await expect($("#nav-slack .nav-count")).toHaveText("3");
    // Its own message is read: the channel's position does not move.
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["未読", "unread:first", "unread:other", "unread:second"]);
    // Once Rust has moved the position, the list is made again from its cache.
    await release(seen, true);
    expect(await waitForCalls("slack_timeline", 2)).toContainEqual({ cached: true });
  });

  it("makes the list again from the cache once slack_mark_read is done, so a list made meanwhile by slack_thread_seen does not leave a row that is unread itself and has unread replies, and the badge, unread", async () => {
    await openList(timeline([withReplies({ unread: true })]));
    await waitForCount("#slack-feed .feed-row", 1);
    await expect($("#nav-slack .nav-count")).toHaveText("3");
    const mark = await mock("slack_mark_read", holds);
    await mock("slack_thread_seen", true);
    await mock("slack_thread", slackThread([threadMessage(parentTs, "Alice Example", "Parent")]));
    // Rust has not the new position yet: the list it makes from its cache is the old one.
    const stale = await mock("slack_timeline", timeline([withReplies({ unread: true })]));
    await $("#slack-feed .feed-open").click();
    await expect($("#slack-thread")).toBeDisplayed();
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: parentTs }]);
    expect(await waitForCalls(stale)).toEqual([{ cached: true }]);
    await expect($("#nav-slack .nav-count")).toHaveText("3");
    // Rust has it now: the list is made again from the cache, with the position moved.
    const fresh = await mock("slack_timeline", timeline([]));
    await release(mark, true);
    expect(await waitForCalls(fresh)).toEqual([{ cached: true }]);
    await expect($("#nav-slack .nav-count")).not.toBeDisplayed();
    await $("#st-back").click();
    await expect($("#slack-list")).toBeDisplayed();
    expect(await count("#slack-feed .feed-row")).toBe(0);
    await expect($("#slack-feed .feed-empty")).toHaveText("メッセージはありません");
  });

  it("keeps a row whose own message stays unread, without its replies, when the token cannot write the position", async () => {
    await openList(timeline([withReplies({ unread: true })], { missing: [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write"] }] }));
    await waitForCount("#slack-feed .feed-row", 1);
    const seen = await mock("slack_thread_seen", false);
    const mark = await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(parentTs, "Alice Example", "Parent")]));
    await $("#slack-feed .feed-open").click();
    await expect($("#slack-thread")).toBeDisplayed();
    await waitForCalls(seen);
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["未読", "unread:Parent"]);
    expect(await count("#slack-feed .feed-thread-toggle")).toBe(0);
    await expect($("#nav-slack .nav-count")).toHaveText("1");
  });

  it("keeps an older row of the channel with unread replies when opening a newer message moves the position over it: only its bold goes", async () => {
    const newer = timelineMessage(slackTs(1), "Bob Example", "dev", "newer", { unread: true });
    await openList(timeline([newer, withReplies({ unread: true })]));
    await waitForCount("#slack-feed .feed-row", 2);
    await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(newer.ts, "Bob Example", "newer")]));
    await openRow("newer");
    await expect($("#slack-thread")).toBeDisplayed();
    await $("#st-back").click();
    expect(await layout()).toEqual(["未読", "read:Parent"]);
    expect(await count("#slack-feed .feed-reply")).toBe(2);
    await expect($("#nav-slack .nav-count")).toHaveText("2");
  });

  it("can press すべて既読にする for unread replies alone, which clears them at once, and lowers the badge", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([withReplies()]), claude_status: claudeReady });
    await expect($("#nav-slack .nav-count")).toHaveText("2");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 1);
    await expect($("#slack-mark-all")).toBeEnabled();
    const all = await mock("slack_mark_all_read", holds);
    const read = await mock("slack_timeline", timeline([]));
    await $("#slack-mark-all").click();
    await $("#slack-mark-all").click();
    await waitForCalls(all);
    expect(await count("#slack-feed .feed-row")).toBe(0);
    await expect($("#nav-slack .nav-count")).not.toBeDisplayed();
    await expect($("#slack-mark-all")).toBeDisabled();
    await release(all, { marked: 0, failed: 0 });
    expect(await waitForCalls(read)).toEqual([{ cached: true }]);
  });

  it("clears only the replies of a workspace that cannot write the position: its unread rows stay", async () => {
    const lacking = [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write"] }];
    const list = [withReplies(), withReplies({ ts: slackTs(10), text: "Unread parent", rich: plain("Unread parent"), unread: true })];
    await openList(timeline(list, { missing: lacking }));
    await waitForCount("#slack-feed .feed-row", 2);
    await mock("slack_mark_all_read", holds);
    await $("#slack-mark-all").click();
    await $("#slack-mark-all").click();
    await waitForCalls("slack_mark_all_read");
    expect(await layout()).toEqual(["未読", "unread:Unread parent"]);
    expect(await count("#slack-feed .feed-thread-toggle")).toBe(0);
    await expect($("#nav-slack .nav-count")).toHaveText("1");
    await release("slack_mark_all_read", { marked: 0, failed: 0 });
  });

  it("takes the unread replies of a hidden channel out of the badge, and of a thread that is watched: the watched row has no toggle", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([withReplies(), withReplies({ channel: "C2", channelName: "random" })]), claude_status: claudeReady });
    await expect($("#nav-slack .nav-count")).toHaveText("4");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 2);
    await mock("slack_hide_channel", holds);
    await $('button[aria-label="#random を一覧に出さない"]').click();
    await waitForCalls("slack_hide_channel");
    await expect($("#nav-slack .nav-count")).toHaveText("2");
    await release("slack_hide_channel", true);
    await waitForCalls("slack_timeline", 2);
    await openList(timeline([withReplies()]));
    await waitForCount("#slack-feed .feed-row", 1);
    await mock("slack_watch", holds);
    await $('button[aria-label="ウォッチする"]').click();
    await waitForCalls("slack_watch");
    expect(await layout()).toEqual(["ウォッチ", "read:Parent"]);
    expect(await count("#slack-feed .feed-thread-toggle")).toBe(0);
    await expect($("#nav-slack .nav-count")).not.toBeDisplayed();
    await release("slack_watch", true);
  });

  it("lists nothing but the notice when only some workspaces failed, and offers 再読み込み only when every workspace failed", async () => {
    const other = { ...workspace, teamId: "T2", team: "Other Team" };
    const failure = { teamId: "T2", team: "Other Team", error: "接続できません" };
    await boot({ inbox: inbox(), slack_load: { workspaces: [workspace, other], recent: [] }, slack_timeline: timeline([], { failed: [failure], refreshSecs: 1 }), claude_status: claudeReady });
    await $("#nav-slack").click();
    await expect($("#slack-feed .feed-empty")).toHaveText("メッセージはありません");
    expect(await count("#slack-feed .pending.fail")).toBe(0);
    expect(await textsOf("#slack-notice > div")).toEqual(["Other Team を読み込めませんでした: 接続できません設定を開く"]);
    await mock("slack_timeline", timeline([], { failed: [failure, { ...failure, teamId: "T1", team: "Example Team" }], refreshSecs: 1 }));
    await expect($("#slack-feed .pending.fail")).toHaveText(expect.stringContaining("読み込めませんでした"));
  });
});
