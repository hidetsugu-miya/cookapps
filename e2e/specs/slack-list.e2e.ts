import { boot, callsOf, claudeReady, count, holds, inbox, mock, ownIcon, pngUri, rejects, release, slackLoad, slackThread, slackTs, textsOf, threadMessage, timeline, timelineMessage, waitForCalls, waitForCount, waitForText, workspace } from "../support";

const iconUrl = "https://avatars.slack-edge.com/T1-U1/a_72.png";

// Two messages, the newest first: the first has two replies.
const sample = () => [
  timelineMessage(slackTs(5, 1), "Alice Example", "dev", "Please review the deploy notes.", { replyCount: 2 }),
  timelineMessage(slackTs(30, 2), "Bob Example", "general", "Lunch at noon."),
];

// `n` messages of two lines each, newest first (the list must be taller than the window to scroll).
const many = (n: number, text = "line one of the message\nline two of the message") =>
  Array.from({ length: n }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `${text} ${i}`, { unread: true }));

// `unread` unread messages, each in a channel of its own, then `read` read ones (newest first overall): "unread 0" ... and "read 0" ...
const heap = (unread: number, read: number) => [
  ...Array.from({ length: unread }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `unread ${i}`, { unread: true, channel: `C${i}` })),
  ...Array.from({ length: read }, (_, i) => timelineMessage(slackTs(100 + i, i), `Reader ${i}`, "dev", `read ${i}`, { channel: `R${i}` })),
];
const unreadTexts = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `unread:unread ${from + i}`);

// The app with one workspace whose messages are `messages`, and the Slack screen open.
async function openList(value = timeline(sample()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: value, claude_status: claudeReady, ...fixtures });
  await $("#nav-slack").click();
  await expect($("#slack-list")).toBeDisplayed();
}

const rowTexts = (selector: string) => textsOf(`#slack-feed .feed-row ${selector}`);
// What the list holds from the top: "unread:text" and "read:text" per row, and "既読" for the heading.
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

// Newest first. Channel C0123ABCD: "first" and "second" are unread, "third" is read; channel C2: "other" is unread (older than "first", newer than "second").
const unreadSample = () => [
  timelineMessage(slackTs(1), "Alice Example", "dev", "first", { unread: true }),
  timelineMessage(slackTs(2), "Bob Example", "random", "other", { unread: true, channel: "C2" }),
  timelineMessage(slackTs(3), "Alice Example", "dev", "second", { unread: true }),
  timelineMessage(slackTs(4), "Bob Example", "dev", "third"),
];
// The Slack screen with `messages` (`fixtures` change the answers), a row of which opens a thread that `slack_thread` answers; `slack_mark_read` is mocked.
async function openUnread(messages: ReturnType<typeof unreadSample>, extra: Parameters<typeof timeline>[1] = {}) {
  await openList(timeline(messages, extra));
  await waitForCount("#slack-feed .feed-row", messages.length);
  const mark = await mock("slack_mark_read", true);
  await mock("slack_thread", slackThread([threadMessage(messages[0].ts, "Alice Example", "first")]));
  return mark;
}
const openRow = async (text: string) => {
  const rows = await $$("#slack-feed .feed-row");
  for (const row of rows) if ((await row.$(".feed-text").getText()) === text) return row.click();
  throw new Error(`no row with ${text}`);
};
const scrollTop = () => browser.execute(() => document.getElementById("slack-feed")!.scrollTop);

describe("slack list", () => {
  it("reads the timeline when the screen is shown and draws a row per message in the order it came", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await callsOf("slack_timeline")).toEqual([null]);
    await expect($("#slack-list h1")).toHaveText("Slack");
    await expect($("#slack-unread")).toHaveText("未読 0 件");
    expect(await rowTexts(".feed-meta b")).toEqual(["Alice Example", "Bob Example"]);
    expect(await rowTexts(".feed-meta span")).toEqual(["#dev", "#general"]);
    expect(await rowTexts(".feed-text")).toEqual(["Please review the deploy notes.", "Lunch at noon."]);
    for (const date of await rowTexts(".feed-date")) expect(date).toMatch(/^(\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日)$/);
  });

  it("draws a row as a real button, with the text cut at two lines, and the button that hides its channel beside it, not in it", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    const row = await browser.execute(() => {
      const r = document.querySelector<HTMLElement>("#slack-feed .feed-row")!;
      return { tag: r.tagName, clamp: getComputedStyle(r.querySelector(".feed-text")!).getPropertyValue("-webkit-line-clamp"), buttons: r.querySelectorAll("button").length };
    });
    expect(row).toEqual({ tag: "BUTTON", clamp: "2", buttons: 0 });
    const hide = await browser.execute(() => {
      const h = document.querySelector<HTMLElement>("#slack-feed .feed-hide")!;
      return { tag: h.tagName, inRow: !!h.closest(".feed-row"), item: h.parentElement!.className, label: h.getAttribute("aria-label") };
    });
    expect(hide).toEqual({ tag: "BUTTON", inRow: false, item: "feed-item", label: "#dev を一覧に出さない" });
  });

  it("shows 返信 N 件 only for a message that has replies", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await textsOf("#slack-feed .feed-replies")).toEqual(["返信 2 件"]);
    expect(await count("#slack-feed .feed-item:nth-child(2) .feed-replies")).toBe(0);
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

  it("says in the heading how many channels no read has reached yet, until none is left", async () => {
    await openList(timeline(sample(), { pendingChannels: 3, refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await expect($("#slack-pending")).toBeDisplayed();
    await expect($("#slack-pending")).toHaveText("残り 3 チャンネルを読み込み中");
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

  it("splits the rows into unread above and read below a 既読 heading, each in the order it came, and draws the unread in bold", async () => {
    await openList(timeline(unreadSample()));
    await waitForCount("#slack-feed .feed-row", 4);
    expect(await layout()).toEqual(["unread:first", "unread:other", "unread:second", "既読", "read:third"]);
    expect(await count("#slack-feed .feed-heading svg")).toBe(1);
    expect(await weightOf("#slack-feed .feed-row.unread")).toBe("700");
    expect(await weightOf("#slack-feed .feed-row:not(.unread)")).toBe("400");
  });

  it("draws no 既読 heading when nothing is unread, or when nothing is read", async () => {
    await openList(timeline(unreadSample().map((m) => ({ ...m, unread: false })), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 4);
    expect(await layout()).toEqual(["read:first", "read:other", "read:second", "read:third"]);
    await mock("slack_timeline", timeline(unreadSample().map((m) => ({ ...m, unread: true })), { refreshSecs: 1 }));
    await browser.waitUntil(async () => (await count("#slack-feed .feed-row.unread")) === 4);
    expect(await layout()).toEqual(["unread:first", "unread:other", "unread:second", "unread:third"]);
    expect(await count("#slack-feed .feed-heading")).toBe(0);
  });

  it("moves a row to the read side when it changes between reads, keeping the order and the heading", async () => {
    await openList(timeline(unreadSample(), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 4);
    await mock("slack_timeline", timeline(unreadSample().map((m) => (m.channel === "C2" ? { ...m, unread: false } : m)), { refreshSecs: 1 }));
    await browser.waitUntil(async () => (await layout()).includes("read:other"));
    expect(await layout()).toEqual(["unread:first", "unread:second", "既読", "read:other", "read:third"]);
  });

  it("calls slack_mark_read with the opened message when a row is pressed, and shows that row and the older ones of its channel as read on the return", async () => {
    const messages = unreadSample();
    const mark = await openUnread(messages);
    await openRow("second");
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[2].ts }]);
    await expect($("#slack-thread")).toBeDisplayed();
    await $("#st-back").click();
    await expect($("#slack-list")).toBeDisplayed();
    // The newer message of the channel and the other channel's stay unread.
    expect(await layout()).toEqual(["unread:first", "unread:other", "既読", "read:second", "read:third"]);
  });

  it("sets the position to the newest message of the channel when that one is pressed, which makes the older ones of the channel read and no other channel's", async () => {
    const messages = unreadSample();
    const mark = await openUnread(messages);
    await openRow("first");
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[0].ts }]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["unread:other", "既読", "read:first", "read:second", "read:third"]);
  });

  it("does not call slack_mark_read for a row that is read already", async () => {
    const mark = await openUnread(unreadSample());
    await openRow("third");
    await expect($("#slack-thread")).toBeDisplayed();
    await browser.pause(300);
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["unread:first", "unread:other", "unread:second", "既読", "read:third"]);
  });

  it("neither calls slack_mark_read nor moves a row when the token lacks a write scope", async () => {
    const mark = await openUnread(unreadSample(), { missing: [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write", "groups:write"] }] });
    await openRow("second");
    await expect($("#slack-thread")).toBeDisplayed();
    await browser.pause(300);
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["unread:first", "unread:other", "unread:second", "既読", "read:third"]);
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
    await openList(timeline(heap(20, 7)));
    await waitForCount("#slack-feed .feed-row", 15);
    await expect($("#slack-unread")).toHaveText("未読 20 件");
    // 10 unread, the button, the heading, and at most 5 read rows.
    expect(await layout()).toEqual([...unreadTexts(10), "button:未読をあと 10 件表示", "既読", "read:read 0", "read:read 1", "read:read 2", "read:read 3", "read:read 4"]);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 25);
    expect(await layout()).toEqual([...unreadTexts(20), "既読", "read:read 0", "read:read 1", "read:read 2", "read:read 3", "read:read 4"]);
    expect(await count("#slack-feed .feed-more")).toBe(0);
    await expect($("#slack-unread")).toHaveText("未読 20 件");
  });

  it("says in the button how many unread rows are left when fewer than 10 are", async () => {
    await openList(timeline(heap(14, 2)));
    await waitForCount("#slack-feed .feed-row", 12);
    expect(await textsOf("#slack-feed .feed-more .text-btn")).toEqual(["未読をあと 4 件表示"]);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 16);
    expect(await count("#slack-feed .feed-more")).toBe(0);
  });

  it("draws no button for 10 unread rows or fewer", async () => {
    await openList(timeline(heap(10, 1)));
    await waitForCount("#slack-feed .feed-row", 11);
    expect(await count("#slack-feed .feed-more")).toBe(0);
  });

  it("keeps the rest of the unread rows shown through a background read", async () => {
    await openList(timeline(heap(20, 3), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 13);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 23);
    await waitForCalls("slack_timeline", 3);
    await browser.pause(300);
    expect(await count("#slack-feed .feed-more")).toBe(0);
    expect(await count("#slack-feed .feed-row")).toBe(23);
  });

  it("keeps the rest of the unread rows shown on the return from a thread", async () => {
    await openList(timeline(heap(20, 3)));
    await waitForCount("#slack-feed .feed-row", 13);
    await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(heap(1, 0)[0].ts, "Person 0", "unread 0")]));
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 23);
    await openRow("unread 4");
    await expect($("#slack-thread")).toBeDisplayed();
    await $("#st-back").click();
    await expect($("#slack-list")).toBeDisplayed();
    expect(await count("#slack-feed .feed-more")).toBe(0);
    expect(await count("#slack-feed .feed-row.unread")).toBe(19);
  });

  it("goes back to 10 unread rows when Slack is opened again from another screen", async () => {
    await openList(timeline(heap(20, 1)));
    await waitForCount("#slack-feed .feed-row", 11);
    await $("#slack-feed .feed-more .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 21);
    await $("#nav-todo").click();
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 11);
    expect(await textsOf("#slack-feed .feed-more .text-btn")).toEqual(["未読をあと 10 件表示"]);
  });

  it("keeps the read side at 5 rows after a row moved to it, newest first", async () => {
    const mark = await openUnread(heap(2, 5));
    await openRow("unread 1");
    await waitForCalls(mark);
    await $("#st-back").click();
    expect(await layout()).toEqual(["unread:unread 0", "既読", "read:unread 1", "read:read 0", "read:read 1", "read:read 2", "read:read 3"]);
    expect(await count("#slack-feed .feed-row:not(.unread)")).toBe(5);
  });

  // The Slack button's badge (S-8): the unread messages held, on any screen.
  const badge = () => $("#nav-slack .nav-count");
  const badgeLabel = () => browser.execute(() => document.getElementById("nav-slack")!.getAttribute("aria-label"));

  it("shows the unread count on the Slack button from the read at startup, with the count in its label, on a screen other than Slack", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(3, 1)), claude_status: claudeReady });
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
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(20, 0), { unreadTotal: 20 }), claude_status: claudeReady });
    await expect(badge()).toHaveText("20");
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(20, 0), { unreadTotal: 37 }), claude_status: claudeReady });
    await expect(badge()).toHaveText("20+");
    expect(await badgeLabel()).toBe("Slack（未読 37 件）");
  });

  it("follows the unread count on another screen without showing or switching the Slack screen, and keeps the number when a read fails", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(2, 0), { refreshSecs: 1 }), claude_status: claudeReady });
    await expect(badge()).toHaveText("2");
    await $("#nav-todo").click();
    await expect($("#todo")).toBeDisplayed();
    await mock("slack_timeline", timeline(heap(5, 0), { refreshSecs: 1 }));
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
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(3, 0)), claude_status: claudeReady });
    await expect(badge()).toHaveText("3");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(heap(1, 0)[0].ts, "Person 0", "unread 0")]));
    await openRow("unread 1");
    await expect(badge()).toHaveText("2");
    expect(await badgeLabel()).toBe("Slack（未読 2 件）");
  });

  it("does not add the Slack count to the Dock badge", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(heap(3, 0)), claude_status: claudeReady });
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

  it("brings the rows back and says so when slack_hide_channel fails", async () => {
    await openList(timeline(withHidden()));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_hide_channel", rejects("保存できません"));
    await $('button[aria-label="#dev を一覧に出さない"]').click();
    await expect($("#error")).toHaveText(expect.stringContaining("保存できません"));
    await waitForCount("#slack-feed .feed-row", 3);
  });
});
