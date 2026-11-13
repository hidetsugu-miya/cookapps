import { attachment, boot, callsOf, claudeReady, composerLayout, count, emitEvent, holds, inbox, mock, onceId, ownIcon, para, plain, pngUri, quote, reaction, rejects, release, sideChannel, sideWorkspace, slackLoad, slackThread, slackTs, socketStatus, span, textsOf, thread as mailThread, threadMessage, timeline, timelineMessage, timelineReply, unreadChannelsOf, unreadRepliesOf, waitForCalls, waitForCount, waitForText, watchedMessage, workspace, TOOLS } from "../support";

import type { TimelineMessage } from "../../ts/bindings/TimelineMessage";

const iconUrl = "https://avatars.slack-edge.com/T1-U1/a_72.png";

// Two messages, the newest first: the first has two replies.
const sample = () => [
  timelineMessage(slackTs(5, 1), "Alice Example", "dev", "Please review the deploy notes.", { replyCount: 2 }),
  timelineMessage(slackTs(30, 2), "Bob Example", "general", "Lunch at noon.", { channel: "C2" }),
];

// `n` messages of two lines each, newest first (the list must be taller than the window to scroll).
const many = (n: number, text = "line one of the message\nline two of the message") =>
  Array.from({ length: n }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `${text} ${i}`, { unread: true }));

// `unread` unread messages, each in a channel of its own, newest first: "unread 0" ...
const heap = (unread: number) => Array.from({ length: unread }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `unread ${i}`, { unread: true, channel: `C${i}` }));

// The app with one workspace whose messages are `messages`, and the Slack screen open.
async function openList(value = timeline(sample()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: value, claude_status: claudeReady, ...fixtures });
  await $("#nav-slack").click();
  await expect($("#slack-list")).toBeDisplayed();
}

const rowTexts = (selector: string) => textsOf(`#slack-feed .feed-row ${selector}`);
// The side menu's buttons (S-19) choose the section the list shows: the unread rows (the first) or the watched threads (the second).
const showWatch = () => $('#slack-side .slack-side-mode[data-key="watch"]').click();
const showUnread = () => $('#slack-side .slack-side-mode[data-key="unread"]').click();
// What the list holds from the top, the section chosen in the side menu: "unread:text" and "read:text" per row (the rows of the groups of the unread section in the order they are drawn, the headings and the separators left out) and the heading's text ("未読", "ウォッチ").
const layout = () =>
  browser.execute(() => {
    const row = (c: Element) => {
      const r = c.querySelector(".feed-row")!;
      return `${r.classList.contains("unread") ? "unread" : "read"}:${r.querySelector(".feed-text")!.textContent}`;
    };
    return [...document.getElementById("slack-feed")!.children].flatMap((c) => {
      if (c.classList.contains("feed-heading")) return [c.textContent!.trim()];
      if (c.classList.contains("feed-group")) return [...c.querySelectorAll(".feed-item")].map(row);
      return [row(c)];
    });
  });
// The groups of the unread section: the texts of the heading (the name of an icon button is its aria-label; the mark, the dot and the empty ones left out), whether it has a lock, and the text of each row.
const groups = () =>
  browser.execute(() =>
    [...document.querySelectorAll("#slack-feed .feed-group")].map((g) => ({
      head: [...g.querySelector(".feed-chan")!.children].map((c) => c.textContent!.trim() || c.getAttribute("aria-label") || "").filter(Boolean),
      lock: !!g.querySelector(".feed-chan-ic rect"),
      rows: [...g.querySelectorAll(".feed-main > .feed-text")].map((t) => t.textContent!.trim()),
    })),
  );
// The "既読にする" button of the group of the channel named `name`.
const readButton = async (name: string) => {
  for (const group of await $$("#slack-feed .feed-group")) if ((await group.$(".feed-chan-name").getText()) === name) return group.$(".feed-chan-read");
  throw new Error(`no group of ${name}`);
};
// Keeps #dev off the list with the button of the side menu (S-19), which is shown on hover only: `keep` shows it.
const hideDev = async () => {
  await browser.execute(() => document.querySelector("#slack-side .slack-side-item")!.classList.add("keep"));
  await $('#slack-side button[aria-label="#dev を一覧に出さない"]').click();
};
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
  await waitForCount("#slack-feed .feed-row", messages.length);
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
// Marks the elements of the rows drawn now; a row that is made again has no mark.
const markRows = () =>
  browser.execute(() => {
    for (const e of document.querySelectorAll("#slack-feed .feed-item")) (e as HTMLElement & { __kept?: boolean }).__kept = true;
  });
// "kept:text" for a row that still is the element marked by `markRows`, "new:text" for one made again, in the order they are drawn.
const keptRows = () =>
  browser.execute(() =>
    [...document.querySelectorAll<HTMLElement & { __kept?: boolean }>("#slack-feed .feed-item")].map((e) => `${e.__kept ? "kept" : "new"}:${e.querySelector(".feed-text")!.textContent!.trim()}`),
  );
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
  it("draws no reactions in the list, although its messages carry them (S-22)", async () => {
    await openList(timeline([timelineMessage(slackTs(5, 1), "Alice Example", "dev", "Please review the deploy notes.", { reactions: [reaction("tada", "🎉", 3)] })]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await count("#slack-feed .reactions, #slack-feed .reaction")).toBe(0);
  });

  it("reads the timeline when the screen is shown and draws a group per channel with a row per message, the channels in the order they came", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await callsOf("slack_timeline")).toEqual([null]);
    // No count in the header: the unread count is the Slack button's badge, which 0 hides.
    await expect($("#slack-unread")).not.toExist();
    await expect($("#nav-slack .nav-count")).not.toBeDisplayed();
    // The list starts 8px below the top, as the inbox's does.
    expect(await browser.execute(() => getComputedStyle(document.getElementById("slack-feed")!).paddingTop)).toBe("8px");
    expect(await textsOf("#slack-feed .feed-chan-name")).toEqual(["dev", "general"]);
    expect(await textsOf("#slack-feed .feed-chan-team")).toEqual(["Example Team", "Example Team"]);
    expect(await rowTexts(".feed-meta b")).toEqual(["Alice Example", "Bob Example"]);
    expect(await rowTexts(".feed-text")).toEqual(["Please review the deploy notes.", "Lunch at noon."]);
    // A row has its time after the name and no date column.
    for (const time of await rowTexts(".feed-meta span")) expect(time).toMatch(/^\d{1,2}:\d{2}$/);
    expect(await count("#slack-feed .feed-date")).toBe(0);
  });

  it("makes the header a place to drag the window by", async () => {
    await openList();
    await expect($("#slack-header")).toHaveAttribute("data-tauri-drag-region", "deep");
  });

  it("stretches one real button over a row, and only the bookmark beside it, not in it", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    const row = await browser.execute(() => {
      const r = document.querySelector<HTMLElement>("#slack-feed .feed-row")!;
      const open = r.querySelector<HTMLElement>(".feed-open")!;
      const [a, b] = [r.getBoundingClientRect(), open.getBoundingClientRect()];
      return { tag: r.tagName, open: open.tagName, covers: [a.width === b.width, a.height === b.height], buttons: r.querySelectorAll("button").length, label: open.getAttribute("aria-label") };
    });
    // The first row has replies: its "N 件の返信" is the second button, and it takes the press itself.
    expect(row).toEqual({ tag: "DIV", open: "BUTTON", covers: [true, true], buttons: 2, label: "Alice Example #dev Please review the deploy notes." });
    // Pressing what is drawn is pressing the button.
    expect(await hitAt("#slack-feed .feed-text")).toBe("BUTTON.feed-open");
    expect(await hitAt("#slack-feed .feed-thread-open")).toBe("BUTTON.feed-thread-open");
    const beside = await browser.execute(() => {
      const item = document.querySelector<HTMLElement>("#slack-feed .feed-item")!;
      return [".feed-watch"].map((s) => {
        const b = item.querySelector<HTMLElement>(s)!;
        return { tag: b.tagName, inRow: !!b.closest(".feed-row"), item: b.parentElement!.className, label: b.getAttribute("aria-label") };
      });
    });
    expect(beside).toEqual([{ tag: "BUTTON", inRow: false, item: "feed-item", label: "ウォッチする" }]);
    // A row has no button that reads it or keeps its channel off the list.
    expect(await count("#slack-feed .feed-read, #slack-feed .feed-hide")).toBe(0);
  });

  it("shows N 件の返信 only for a message that has replies, and the press of it opens the thread and sets the read position as the row does", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await textsOf("#slack-feed .feed-thread-open")).toEqual(["2 件の返信"]);
    expect(await count("#slack-feed .feed-group:nth-of-type(2) .feed-thread-open")).toBe(0);
    const messages = [timelineMessage(slackTs(5, 1), "Alice Example", "dev", "Please review the deploy notes.", { unread: true, replyCount: 3 })];
    const mark = await openUnread(messages);
    const thread = await mock("slack_thread", slackThread([threadMessage(messages[0].ts, "Alice Example", "Please review the deploy notes.")]));
    await mock("slack_timeline", timeline(messages));
    await $("#slack-feed .feed-thread-open").click();
    await expect($("#slack-thread")).toBeDisplayed();
    expect(await callsOf(thread)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[0].ts }]);
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[0].ts }]);
  });

  it("draws the icons of the people who replied before N 件の返信 and 最終返信 after it, and the press on them is still the row's", async () => {
    const bobIcon = "https://avatars.slack-edge.com/T1-U2/a_72.png";
    const repliers = [
      { name: "Bob Example", iconUrl: bobIcon },
      { name: "Carol Example", iconUrl: null },
      { name: "Dave Example", iconUrl: null },
    ];
    const old = `${Math.floor(Date.now() / 1000) - 40 * 86400}.000100`;
    const messages = [
      timelineMessage(slackTs(7, 1), "Alice Example", "dev", "Please review the deploy notes.", { unread: true, replyCount: 3, repliers, latestReply: slackTs(2, 5) }),
      timelineMessage(slackTs(6, 2), "Erin Example", "dev", "Older thread.", { unread: true, replyCount: 1, repliers: [repliers[1]], latestReply: old }),
      timelineMessage(slackTs(5, 3), "Frank Example", "dev", "No repliers named.", { unread: true, replyCount: 2 }),
    ];
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady, slack_timeline: timeline(messages) });
    const fetch = await mock("fetch_images", { [bobIcon]: pngUri });
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 3);
    // Only the rows with repliers have the line; the icons carry the name as their title and their reading.
    expect(await count("#slack-feed .feed-thread-line")).toBe(2);
    expect(await browser.execute(() => document.querySelector("#slack-feed .feed-thread-line")!.querySelectorAll(".feed-replier").length)).toBe(3);
    const first = await browser.execute(() => {
      const line = document.querySelector("#slack-feed .feed-thread-line")!;
      return {
        children: [...line.children].map((e) => e.className.split(" ")[0]),
        titles: [...line.querySelectorAll<HTMLElement>(".feed-replier")].map((e) => e.title),
        labels: [...line.querySelectorAll(".feed-replier")].map((e) => e.getAttribute("aria-label")),
        initials: [...line.querySelectorAll(".feed-replier .av-text")].map((e) => e.textContent),
        size: (() => {
          const r = line.querySelector(".feed-replier")!.getBoundingClientRect();
          return [r.width, r.height];
        })(),
        last: line.querySelector(".feed-last-reply")!.textContent,
      };
    });
    expect(first.children).toEqual(["feed-repliers", "feed-thread-open", "feed-last-reply"]);
    expect(first.titles).toEqual(["Bob Example", "Carol Example", "Dave Example"]);
    expect(first.labels).toEqual(first.titles);
    // The fetched icon replaces the initial of the first; the others keep theirs.
    expect(await waitForCalls(fetch)).toEqual([{ urls: [bobIcon] }]);
    await browser.waitUntil(async () => (await count("#slack-feed .feed-replier img.av-img")) === 1);
    expect(await browser.execute(() => [...document.querySelector("#slack-feed .feed-thread-line")!.querySelectorAll(".feed-replier .av-text")].map((e) => e.textContent))).toEqual(expect.arrayContaining(["CE", "DE"]));
    expect(first.size).toEqual([20, 20]);
    // A reply of today shows the time, an old one the date as the list does.
    expect(first.last).toMatch(/^最終返信 \d{1,2}:\d{2}$/);
    expect(await textsOf("#slack-feed .feed-last-reply")).toHaveLength(2);
    expect((await textsOf("#slack-feed .feed-last-reply"))[1]).toMatch(/^最終返信 (\d{1,2}月\d{1,2}日|\d{4}\/\d{1,2}\/\d{1,2})$/);
    // The press on an icon or on the time goes to the row's button, and "N 件の返信" keeps its own.
    expect(await hitAt("#slack-feed .feed-replier")).toBe("BUTTON.feed-open");
    expect(await hitAt("#slack-feed .feed-last-reply")).toBe("BUTTON.feed-open");
    expect(await hitAt("#slack-feed .feed-thread-open")).toBe("BUTTON.feed-thread-open");
    // A thread with no repliers named is drawn as it was: the button alone.
    expect(await textsOf("#slack-feed .feed-thread-open")).toEqual(["3 件の返信", "1 件の返信", "2 件の返信"]);
    expect(await browser.execute(() => document.querySelectorAll("#slack-feed .feed-item")[2].querySelector(".feed-main")!.lastElementChild!.className)).toBe("feed-thread-open");
  });

  it("draws the repliers and the newest reply before 返信 N 件 of a watched row too", async () => {
    const watched = [watchedMessage(slackTs(10), "Carol Example", "ops", "Watched read", 2, { channel: "C3", replyCount: 3, repliers: [{ name: "Bob Example", iconUrl: null }], latestReply: slackTs(1, 4) })];
    await openList(timeline([], { watched }));
    await showWatch();
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await browser.execute(() => [...document.querySelector("#slack-feed .feed-thread-line")!.children].map((e) => `${e.className.split(" ")[0]}:${e.textContent}`))).toEqual([
      expect.stringMatching(/^feed-repliers:BE$/),
      "feed-replies:返信 3 件",
      expect.stringMatching(/^feed-last-reply:最終返信 \d{1,2}:\d{2}$/),
    ]);
  });

  it("shows a message of files only as 添付ファイル, and attached images never in a row", async () => {
    await openList(timeline([timelineMessage(slackTs(1), "Alice Example", "dev", "", { hasFiles: true })]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await rowTexts(".feed-text")).toEqual(["（添付ファイル）"]);
    expect(await count("#slack-feed img:not(.av-img)")).toBe(0);
  });

  it("shows the plain text, else 添付ファイル, for a post whose blocks and attachments draw nothing here (images only)", async () => {
    const image = { url: "https://example.com/a.png", alt: "" };
    await openList(
      timeline([
        timelineMessage(slackTs(3), "Bot One", "dev", "Chart ready", { unread: true, channel: "C1", showText: false, blocks: [{ type: "image", image, title: null }] }),
        timelineMessage(slackTs(2), "Bot Two", "dev", "", { unread: true, channel: "C2", showText: false, rich: [], attachments: [attachment({ image })] }),
      ]),
    );
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await rowTexts(".feed-text")).toEqual(["Chart ready", "（添付ファイル）"]);
  });

  it("lets the workspace dot of a row of the watch section take the pointer, so that its tooltip shows", async () => {
    await openList(timeline([], { watched: watchedSample() }));
    await showWatch();
    await waitForCount("#slack-feed .feed-row", 2);
    const [title, hit] = await browser.execute(() => {
      const dot = document.querySelector<HTMLElement>("#slack-feed .feed-row .feed-ws")!;
      const r = dot.getBoundingClientRect();
      return [dot.title, document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === dot];
    });
    expect(title).toBe("Example Team");
    expect(hit).toBe(true);
  });

  it("marks the heading of a group with the workspace's color, the same as the workspace's avatar in the sidebar", async () => {
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

  // Four unread messages of #dev, "message 0" the newest.
  const fourMessages = () => Array.from({ length: 4 }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `message ${i}`, { unread: true }));

  it("makes again only the row that changed on a read, and keeps the elements of the others", async () => {
    // Built once: `slackTs` reads the clock, and a new `ts` after a change of the second would make every row another one.
    const messages = fourMessages();
    await openList(timeline(messages, { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 4);
    await markRows();
    const changed = [...messages];
    changed[2] = timelineMessage(messages[2].ts, "Person 2", "dev", "edited", { unread: true });
    await mock("slack_timeline", timeline(changed, { refreshSecs: 1 }));
    await waitForText("#slack-feed .feed-text", "edited");
    expect(await keptRows()).toEqual(["kept:message 3", "new:edited", "kept:message 1", "kept:message 0"]);
  });

  it("keeps the rows and their focus in place when a read brings a group before them", async () => {
    // Built once, as above.
    const messages = fourMessages();
    await openList(timeline(messages, { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 4);
    const active = () => browser.execute(() => (document.activeElement as HTMLElement & { __kept?: boolean }).__kept === true && (document.activeElement as HTMLElement).dataset.key);
    const second = messages[1];
    await browser.execute((key) => document.querySelector<HTMLElement>(`#slack-feed .feed-open[data-key="${key}"]`)!.focus(), `${workspace.teamId}/C0123ABCD/${second.ts}`);
    await markRows();
    const before = await browser.execute(() => (document.activeElement as HTMLElement).dataset.key);
    expect(before).toBe(`${workspace.teamId}/C0123ABCD/${second.ts}`);
    await browser.execute(() => {
      (document.activeElement as HTMLElement & { __kept?: boolean }).__kept = true;
    });
    const fresh = timelineMessage(slackTs(0, 9), "Fresh Person", "random", "fresh", { unread: true, channel: "C9" });
    await mock("slack_timeline", timeline([fresh, ...messages], { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 5);
    expect(await keptRows()).toEqual(["new:fresh", "kept:message 3", "kept:message 2", "kept:message 1", "kept:message 0"]);
    expect(await active()).toBe(before);
  });

  it("keeps the elements of the rows that did not change on the return from a thread", async () => {
    const messages = unreadSample();
    const mark = await openUnread(messages);
    await markRows();
    await openRow("second");
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[2].ts }]);
    await $("#st-back").click();
    await expect($("#slack-list")).toBeDisplayed();
    expect(await keptRows()).toEqual(["kept:first", "kept:other"]);
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

  it("lists the unread rows under a 未読 heading, in groups by channel, in bold, and no 既読 heading", async () => {
    await openList(timeline(unreadSample()));
    await waitForCount("#slack-feed .feed-row", 3);
    // The channel of the newest row first; the rows of a channel oldest first.
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first", "unread:other"]);
    expect(await count("#slack-feed .feed-heading svg")).toBe(1);
    expect(await weightOf("#slack-feed .feed-row.unread")).toBe("700");
  });

  it("groups the unread rows by channel under a heading with the mark, the name, the workspace and the number of unread messages, and 既読にする at its right end", async () => {
    const side = [sideWorkspace([sideChannel("C0123ABCD", "dev"), sideChannel("G2", "ops", { private: true })])];
    const messages = [
      timelineMessage(slackTs(1), "Alice Example", "dev", "first", { unread: true }),
      timelineMessage(slackTs(2), "Bob Example", "ops", "other", { unread: true, channel: "G2" }),
      timelineMessage(slackTs(3), "Alice Example", "dev", "second", { unread: true }),
    ];
    await openList(timeline(messages, { side }));
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await groups()).toEqual([
      { head: ["dev", "Example Team", "2 件のメッセージ", "既読にする"], lock: false, rows: ["second", "first"] },
      { head: ["ops", "Example Team", "1 件のメッセージ", "既読にする"], lock: true, rows: ["other"] },
    ]);
    const head = await browser.execute(() => {
      const h = document.querySelector<HTMLElement>("#slack-feed .feed-chan")!;
      const [button, count] = [h.querySelector<HTMLElement>(".feed-chan-read")!.getBoundingClientRect(), h.querySelector<HTMLElement>(".feed-chan-count")!.getBoundingClientRect()];
      const read = h.querySelector<HTMLElement>(".feed-chan-read")!;
      return { buttonAtEnd: Math.abs(h.getBoundingClientRect().right - button.right) < 24, countLeftOfButton: count.right <= button.left, tag: read.className, name: read.getAttribute("aria-label"), text: read.textContent, icon: !!read.querySelector("svg path") };
    });
    expect(head).toEqual({ buttonAtEnd: true, countLeftOfButton: true, tag: "icon-btn feed-chan-read", name: "既読にする", text: "", icon: true });
    // The heading says what Rust counted for the channel, also when the rows are fewer.
    await mock("slack_timeline", timeline(messages, { side, unreadChannels: [{ teamId: workspace.teamId, channel: "C0123ABCD", messages: 25, to: messages[0].ts, threads: [] }] }));
    await emitEvent("slack-timeline-dirty");
    await waitForText("#slack-feed .feed-chan-count", "25 件のメッセージ");
    expect(await count("#slack-feed .feed-row")).toBe(3);
  });

  it("puts a separator before the first row of each day: an older date, 昨日 and 今日, oldest first", async () => {
    const day = 24 * 60;
    const messages = [
      timelineMessage(slackTs(0, 1), "Alice Example", "dev", "today", { unread: true }),
      timelineMessage(slackTs(day, 2), "Bob Example", "dev", "yesterday", { unread: true }),
      timelineMessage(slackTs(10 * day - 1, 3), "Carol Example", "dev", "older too", { unread: true }),
      timelineMessage(slackTs(10 * day, 4), "Dave Example", "dev", "older", { unread: true }),
    ];
    await openList(timeline(messages));
    await waitForCount("#slack-feed .feed-row", 4);
    expect(await layout()).toEqual(["未読", "unread:older", "unread:older too", "unread:yesterday", "unread:today"]);
    const days = await textsOf("#slack-feed .feed-day");
    expect(days).toHaveLength(3);
    expect(days[0]).toMatch(/^(\d{4}年)?\d{1,2}月\d{1,2}日（[日月火水木金土]）$/);
    expect(days.slice(1)).toEqual(["昨日", "今日"]);
    // A separator comes before its rows, not after them.
    const order = await browser.execute(() => [...document.querySelectorAll("#slack-feed .feed-group > *")].map((c) => c.className.split(" ")[0]));
    expect(order).toEqual(["feed-chan", "feed-day", "feed-item", "feed-item", "feed-day", "feed-item", "feed-day", "feed-item"]);
  });

  it("draws a heading for the section the side menu chose, 未読 or ウォッチ, and none for a section with no row", async () => {
    const both = timeline(unreadSample(), { watched: watchedSample(), refreshSecs: 1 });
    await openList(both);
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first", "unread:other"]);
    expect(await count("#slack-feed .feed-heading svg")).toBe(1);
    await showWatch();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await layout()).toEqual(["ウォッチ", "read:Watched read", "unread:Watched unread"]);
    expect(await count("#slack-feed .feed-heading svg")).toBe(1);
    await mock("slack_timeline", timeline(unreadSample(), { refreshSecs: 1 }));
    await expect($("#slack-feed .feed-empty")).toHaveText("メッセージはありません");
    expect(await count("#slack-feed .feed-heading")).toBe(0);
    await showUnread();
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_timeline", timeline([], { watched: watchedSample(), refreshSecs: 1 }));
    await expect($("#slack-feed .feed-empty")).toHaveText("メッセージはありません");
    expect(await count("#slack-feed .feed-heading")).toBe(0);
  });

  it("takes a row out when a read finds it read", async () => {
    await openList(timeline(unreadSample(), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_timeline", timeline(unreadSample().filter((m) => m.channel !== "C2"), { refreshSecs: 1 }));
    await browser.waitUntil(async () => !(await layout()).includes("unread:other"));
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first"]);
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
    await showWatch();
    await openRow("Watched read");
    await expect($("#slack-thread")).toBeDisplayed();
    await browser.pause(300);
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["ウォッチ", "read:Watched read", "unread:Watched unread"]);
  });

  it("neither calls slack_mark_read nor moves a row when the token lacks a write scope", async () => {
    const mark = await openUnread(unreadSample(), { missing: [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write", "groups:write"] }] });
    await openRow("second");
    await expect($("#slack-thread")).toBeDisplayed();
    await browser.pause(300);
    expect(await callsOf(mark)).toEqual([]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first", "unread:other"]);
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

  // Keeping a channel off the list (S-9), with the button of the side menu (S-19): a row has none.
  it("has no button on a row that keeps its channel off the list or reads it", async () => {
    await openList(timeline(withHidden()));
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await count("#slack-feed button[aria-label$='を一覧に出さない']")).toBe(0);
    expect(await count("#slack-feed .feed-item .icon-btn:not(.feed-watch)")).toBe(0);
  });

  const devRows = () => count("#slack-feed .feed-row");
  const withHidden = () => [
    timelineMessage(slackTs(1), "Alice Example", "dev", "from dev", { unread: true }),
    timelineMessage(slackTs(2), "Bob Example", "random", "from random", { unread: true, channel: "C2" }),
    timelineMessage(slackTs(3), "Bob Example", "dev", "older from dev"),
  ];

  it("lowers the badge at once by the unread rows of the hidden channel, and makes the list again from Rust's cache, asking Slack nothing", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(withHidden(), { side: sideSample() }), claude_status: claudeReady });
    await expect(badge()).toHaveText("2");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_hide_channel", true);
    await mock("slack_timeline", timeline([withHidden()[1]]));
    await hideDev();
    await expect(badge()).toHaveText("1");
    expect(await waitForCalls("slack_timeline")).toEqual([{ cached: true }]);
    await browser.pause(300);
    // One cached read, and no full read of Slack on top of it.
    expect(await callsOf("slack_timeline")).toEqual([{ cached: true }]);
    await expect($(".toast")).toHaveText(expect.stringContaining("元に戻す"));
  });

  it("puts the channel back with 元に戻す: slack_unhide_channel is called and the list is read again", async () => {
    await openList(timeline(withHidden(), { side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_hide_channel", true);
    await mock("slack_timeline", timeline([withHidden()[1]]));
    await hideDev();
    await waitForCalls("slack_timeline");
    await expect($(".toast button")).toHaveText("元に戻す");
    const unhide = await mock("slack_unhide_channel", true);
    await mock("slack_timeline", timeline(withHidden(), { side: sideSample() }));
    await $(".toast button").click();
    expect(await waitForCalls(unhide)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD" }]);
    expect(await waitForCalls("slack_timeline")).toEqual([{ cached: true }]);
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await devRows()).toBe(3);
    await browser.pause(300);
    expect(await callsOf("slack_timeline")).toEqual([{ cached: true }]);
  });

  it("does not bring a hidden row back from a read that began before the channel was hidden, and picks up what that read left in the cache with one read from the cache", async () => {
    await openList(timeline(withHidden(), { refreshSecs: 2, side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    // The periodic read is on its way when the channel is hidden.
    const read = await mock("slack_timeline", holds);
    await waitForCalls(read);
    await mock("slack_hide_channel", true);
    await hideDev();
    await waitForCalls(read, 2);
    expect((await callsOf(read)).slice(1)).toEqual([{ cached: true }]);
    // The older answer still has the rows of #dev: it is passed over.
    await release(read, timeline(withHidden(), { side: sideSample() }));
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

  // The header (S-13).
  it("fixes a header above the list, tinted as the thread's, with the title and the icon that opens the hidden channels", async () => {
    await openList(timeline(many(20)));
    await waitForCount("#slack-feed .feed-row", 20);
    await expect($("#slack-header h1")).toHaveText("Slack");
    // The header has no button that reads everything.
    await expect($("#slack-mark-all")).not.toExist();
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

  // Watching a thread (S-13).
  it("watches the thread of a row with its bookmark: slack_watch is called with the thread's ts, the row goes to the watch section at once, and no thread opens", async () => {
    const reply = timelineMessage(slackTs(1), "Alice Example", "dev", "a reply sent to the channel", { unread: true, threadTs: "1700000000.000001" });
    await openList(timeline([reply, ...unreadSample().slice(1)]));
    await waitForCount("#slack-feed .feed-row", 3);
    const watch = await mock("slack_watch", holds);
    const mark = await mock("slack_mark_read", true);
    await mock("slack_timeline", timeline(unreadSample().slice(1), { watched: [watchedMessage("1700000000.000001", "Alice Example", "dev", "the thread's message")] }));
    // The group of #dev has "second" before the reply, which is newer.
    await $$('button[aria-label="ウォッチする"]')[1].click();
    expect(await waitForCalls(watch)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: "1700000000.000001" }]);
    expect(await layout()).toEqual(["未読", "unread:other", "unread:second"]);
    await showWatch();
    expect(await layout()).toEqual(["ウォッチ", "unread:a reply sent to the channel"]);
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
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first", "unread:other"]);
  });

  it("draws a watched row with its bookmark always shown, 新しい返信 only when there are new replies, and the unread one in bold", async () => {
    await openList(timeline([], { watched: watchedSample() }));
    await showWatch();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await textsOf("#slack-feed .feed-new")).toEqual(["新しい返信 2 件"]);
    expect(await textsOf("#slack-feed .feed-replies")).toEqual(["返信 3 件"]);
    const marks = await browser.execute(() =>
      [...document.querySelectorAll("#slack-feed .feed-item")].map((item) => ({
        watch: getComputedStyle(item.querySelector(".feed-watch")!).visibility,
        label: item.querySelector(".feed-watch")!.getAttribute("aria-label"),
      })),
    );
    expect(marks).toEqual(Array.from({ length: 2 }, () => ({ watch: "visible", label: "ウォッチを外す" })));
    expect(await weightOf("#slack-feed .feed-row.unread")).toBe("700");
    expect(await weightOf("#slack-feed .feed-row:not(.unread)")).toBe("400");
  });

  it("lets a thread go with its bookmark: slack_unwatch is called, the row goes, and 元に戻す puts it back with the reply it had been seen up to", async () => {
    const watched = watchedSample();
    await openList(timeline([], { watched }));
    await showWatch();
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
    await showWatch();
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
    await showWatch();
    await openRow("Watched unread");
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C3", ts: watched[1].ts }]);
    await $("#st-back").click();
    expect(await layout()).toEqual(["ウォッチ", "read:Watched read", "read:Watched unread"]);
  });

  it("keeps a thread that cannot be read as a row that says so, cannot be opened, and can be let go; a thread not read yet says it is being read", async () => {
    const gone = watchedMessage(slackTs(10), "不明", "ops", "", 0, { channel: "C3", user: null, watch: { newReplies: 0, uncounted: false, status: "unreadable", unreadTo: null } });
    const waiting = watchedMessage(slackTs(20), "不明", "ops", "", 0, { channel: "C3", user: null, watch: { newReplies: 0, uncounted: false, status: "pending", unreadTo: null } });
    await openList(timeline([], { watched: [gone, waiting] }));
    await showWatch();
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
    await waitForCount("#slack-feed .feed-row", 20);
    await showWatch();
    await waitForCount("#slack-feed .feed-row", 1);
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

  it("says 新しい返信あり, with no number, for new replies that could not be counted", async () => {
    const long = watchedMessage(slackTs(10), "Carol Example", "ops", "A long thread", 0, { channel: "C3" });
    long.watch = { newReplies: 0, uncounted: true, status: "ok", unreadTo: null };
    await openList(timeline([], { watched: [long, ...watchedSample()] }));
    await showWatch();
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await textsOf("#slack-feed .feed-new")).toEqual(["新しい返信あり", "新しい返信 2 件"]);
  });

  it("moves the read position to the newest unread message of the thread when a watched row is opened, also when the thread's own message is read", async () => {
    const reply = slackTs(2, 7);
    const row = watchedMessage(slackTs(10), "Carol Example", "ops", "Watched read", 0, { channel: "C3" });
    row.watch = { newReplies: 0, uncounted: false, status: "ok", unreadTo: reply };
    const mark = await openUnread(unreadSample(), { watched: [row] });
    await mock("slack_thread", slackThread([threadMessage(row.ts, "Carol Example", "Watched read")]));
    await showWatch();
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

  it("draws a long body in full, whether it is paragraphs alone, a quote, blocks or an attachment", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const long = [
      timelineMessage(slackTs(1), "Paragraphs", "dev", lines, { unread: true, channel: "C1" }),
      timelineMessage(slackTs(2), "Quote", "dev", lines, { unread: true, channel: "C2", rich: [quote(span(lines))] }),
      timelineMessage(slackTs(3), "Blocks", "dev", lines, { unread: true, channel: "C3", showText: false, blocks: [{ type: "section", text: plain(lines), fields: [], accessory: null }] }),
      timelineMessage(slackTs(4), "Attachment", "dev", lines, { unread: true, channel: "C4", attachments: [attachment({ text: plain(lines) })] }),
    ];
    await openList(timeline(long));
    await waitForCount("#slack-feed .feed-row", 4);
    const heights = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#slack-feed .feed-text")].map((t) => ({ cut: t.scrollHeight > t.clientHeight, over12: t.clientHeight > Number.parseFloat(getComputedStyle(t).lineHeight) * 12, clamp: getComputedStyle(t).getPropertyValue("-webkit-line-clamp"), overflow: getComputedStyle(t).overflowY })));
    for (const h of heights) expect(h).toEqual({ cut: false, over12: true, clamp: "none", overflow: "visible" });
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
    const message = withReplies({ unreadReplies: unreadRepliesOf([], { count: 0, uncounted: true, share: 1, latestTs: slackTs(1) }) });
    await openList(timeline([message]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await textsOf("#slack-feed .feed-thread-toggle")).toEqual(["未読の返信あり"]);
    expect(await textsOf("#slack-feed .feed-reply-rest")).toEqual(["ほかの返信はスレッドで見られます"]);
    await expect($("#nav-slack .nav-count")).toHaveText("1");
  });

  it("says that the others are in the thread above the 20 replies a row draws", async () => {
    const replies = Array.from({ length: 20 }, (_, i) => timelineReply(slackTs(100 - i, i), `Person ${i}`, `reply ${i}`));
    await openList(timeline([withReplies({ unreadReplies: unreadRepliesOf(replies, { count: 31, share: 31 }) })]));
    await waitForCount("#slack-feed .feed-reply", 20);
    expect(await textsOf("#slack-feed .feed-thread-toggle")).toEqual(["未読の返信 31 件"]);
    expect(await textsOf("#slack-feed .feed-reply-rest")).toEqual(["ほかの返信はスレッドで見られます"]);
  });

  it("only folds the replies with the toggle: no thread, nothing read, the scroll position kept, and its own focus after a redraw", async () => {
    // The thread is the oldest row of the channel, so that it is the first of the group and in view.
    // Built once: `slackTs` reads the clock, and a new `ts` would give the toggle another key in the second answer.
    const parent = withReplies({ ts: slackTs(300, 9) });
    const first = () => parent;
    await openList(timeline([first(), ...many(19)], { refreshSecs: 1 }));
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
    await mock("slack_timeline", timeline([timelineMessage(slackTs(0), "New Person", "dev", "new", { channel: "C3" }), first(), ...many(19)], { refreshSecs: 1 }));
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
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first", "unread:other"]);
    // Once Rust has moved the position, the list is made again from its cache.
    await release(seen, true);
    expect(await waitForCalls("slack_timeline", 2)).toContainEqual({ cached: true });
  });

  it("waits for slack_mark_read before making the list again after slack_thread_seen, so a row that is unread itself and has unread replies does not come back", async () => {
    await openList(timeline([withReplies({ unread: true })]));
    await waitForCount("#slack-feed .feed-row", 1);
    await expect($("#nav-slack .nav-count")).toHaveText("3");
    const mark = await mock("slack_mark_read", holds);
    const seen = await mock("slack_thread_seen", true);
    await mock("slack_thread", slackThread([threadMessage(parentTs, "Alice Example", "Parent")]));
    const fresh = await mock("slack_timeline", timeline([]));
    await $("#slack-feed .feed-open").click();
    await expect($("#slack-thread")).toBeDisplayed();
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: parentTs }]);
    await waitForCalls(seen);
    // Rust has not the new position yet: nothing is made from its cache.
    expect(await callsOf(fresh)).toEqual([]);
    await expect($("#nav-slack .nav-count")).not.toBeDisplayed();
    await release(mark, true);
    expect((await waitForCalls(fresh))[0]).toEqual({ cached: true });
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

  it("takes the unread replies of a hidden channel out of the badge, and of a thread that is watched: the watched row has no toggle", async () => {
    const side = [sideWorkspace([sideChannel("C0123ABCD", "dev"), sideChannel("C2", "random")])];
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([withReplies(), withReplies({ channel: "C2", channelName: "random" })], { side }), claude_status: claudeReady });
    await expect($("#nav-slack .nav-count")).toHaveText("4");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 2);
    await mock("slack_hide_channel", holds);
    await browser.execute(() => document.querySelectorAll("#slack-side .slack-side-item")[1].classList.add("keep"));
    await $('#slack-side button[aria-label="#random を一覧に出さない"]').click();
    await waitForCalls("slack_hide_channel");
    await expect($("#nav-slack .nav-count")).toHaveText("2");
    await release("slack_hide_channel", true);
    await waitForCalls("slack_timeline", 2);
    await openList(timeline([withReplies()]));
    await waitForCount("#slack-feed .feed-row", 1);
    await mock("slack_watch", holds);
    await $('button[aria-label="ウォッチする"]').click();
    await waitForCalls("slack_watch");
    await showWatch();
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

  // Reading a channel without opening a thread (S-15).
  const lackingWrite = [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write"] }];

  it("reads a channel with 既読にする at once without opening a thread: slack_mark_read goes to its newest unread message, its rows go, the other channel's stay, the badge falls, and the list is made again from Rust's cache", async () => {
    const messages = unreadSample();
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady });
    await expect(badge()).toHaveText("3");
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 3);
    const mark = await mock("slack_mark_read", holds);
    const thread = await mock("slack_thread", slackThread([threadMessage(messages[0].ts, "Alice Example", "first")]));
    const fresh = await mock("slack_timeline", timeline([messages[1]]));
    await (await readButton("dev")).click();
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[0].ts }]);
    // Before Slack has answered: the channel's two rows have gone, the other channel's stays, and nothing is asked of the cache yet.
    expect(await layout()).toEqual(["未読", "unread:other"]);
    await expect(badge()).toHaveText("1");
    expect(await callsOf(fresh)).toEqual([]);
    await release(mark, true);
    expect(await waitForCalls(fresh)).toEqual([{ cached: true }]);
    await browser.pause(300);
    expect(await callsOf(fresh)).toEqual([{ cached: true }]);
    await expect($("#slack-list")).toBeDisplayed();
    await expect($("#slack-thread")).not.toBeDisplayed();
    expect(await callsOf(thread)).toEqual([]);
    expect(await layout()).toEqual(["未読", "unread:other"]);
  });

  it("sets the position to the newest unread message Rust names, past the rows listed", async () => {
    const messages = many(3);
    const to = slackTs(0, 99);
    const mark = await openUnread(messages, { unreadChannels: [{ teamId: workspace.teamId, channel: "C0123ABCD", messages: 25, to, threads: [] }] });
    await expect($("#slack-feed .feed-chan-count")).toHaveText("25 件のメッセージ");
    await mock("slack_timeline", timeline([]));
    await $("#slack-feed .feed-chan-read").click();
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: to }]);
    expect(await count("#slack-feed .feed-row")).toBe(0);
  });

  it("takes the channel's whole unread number off the badge and off its number in the side menu, not only the rows listed", async () => {
    const [shown, other] = [many(3), unreadSample()[1]];
    const to = slackTs(0, 99);
    const unreadChannels = [{ teamId: workspace.teamId, channel: "C0123ABCD", messages: 15, to, threads: [] }, ...unreadChannelsOf([other])];
    const side = [sideWorkspace([sideChannel("C0123ABCD", "dev", { unread: 15 }), sideChannel("C2", "random", { unread: 1 })])];
    await openUnread([...shown, other], { unreadChannels, side, unreadTotal: 16 });
    await expect(badge()).toHaveText("16");
    const mark = await mock("slack_mark_read", holds);
    await (await readButton("dev")).click();
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: to }]);
    // Before Slack has answered and the list is made again: the number is lowered by what Rust counted, not by the 3 rows drawn.
    await expect(badge()).toHaveText("1");
    expect(await count('#slack-side .slack-side-btn[data-key="T1/C0123ABCD"] .slack-side-n')).toBe(0);
    expect(await $('#slack-side .slack-side-btn[data-key="T1/C2"] .slack-side-n').getText()).toBe("1");
    await release(mark, true);
  });

  it("calls slack_thread_seen for each thread of the channel with unread replies, and not slack_mark_read when no message is unread, takes the row out at once, and opens no thread", async () => {
    const message = withReplies();
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline([message, unreadSample()[1]]), claude_status: claudeReady });
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 2);
    const seen = await mock("slack_thread_seen", holds);
    const mark = await mock("slack_mark_read", true);
    const thread = await mock("slack_thread", slackThread([threadMessage(message.ts, "Alice Example", "Parent")]));
    const fresh = await mock("slack_timeline", timeline([unreadSample()[1]]));
    await expect(badge()).toHaveText("3");
    await (await readButton("dev")).click();
    expect(await waitForCalls(seen)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts, latestTs: replyTwo }]);
    expect(await layout()).toEqual(["未読", "unread:other"]);
    await expect(badge()).toHaveText("1");
    await release(seen, true);
    expect(await waitForCalls(fresh)).toContainEqual({ cached: true });
    await expect($("#slack-thread")).not.toBeDisplayed();
    expect(await callsOf(mark)).toEqual([]);
    expect(await callsOf(thread)).toEqual([]);
  });

  it("reads the unread replies and the position together, and the threads past the rows listed with them", async () => {
    const message = withReplies({ unread: true });
    const [past, pastLatest] = [slackTs(500), slackTs(400)];
    const mark = await openUnread([message], { unreadChannels: [{ teamId: workspace.teamId, channel: "C0123ABCD", messages: 1, to: message.ts, threads: [{ ts: message.ts, latestTs: replyTwo }, { ts: past, latestTs: pastLatest }] }] });
    const seen = await mock("slack_thread_seen", true);
    await mock("slack_timeline", timeline([]));
    await (await readButton("dev")).click();
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts }]);
    expect(await waitForCalls(seen, 2)).toEqual([
      { teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts, latestTs: replyTwo },
      { teamId: workspace.teamId, channel: "C0123ABCD", ts: past, latestTs: pastLatest },
    ]);
  });

  it("draws 既読にする only where pressing it changes something: not for an unread message when the token cannot write the position, but for unread replies", async () => {
    const messages = [unreadSample()[0], withReplies({ channel: "C2", channelName: "random" })];
    await openList(timeline(messages, { missing: lackingWrite }));
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await groups()).toEqual([
      { head: ["dev", "Example Team", "1 件のメッセージ"], lock: false, rows: ["first"] },
      { head: ["random", "Example Team", "既読にする"], lock: false, rows: ["Parent"] },
    ]);
  });

  it("calls only slack_thread_seen for a channel when the token cannot write the position, and leaves its own unread message unread", async () => {
    const message = withReplies({ unread: true });
    await openList(timeline([message], { missing: lackingWrite }));
    await waitForCount("#slack-feed .feed-row", 1);
    const seen = await mock("slack_thread_seen", true);
    const mark = await mock("slack_mark_read", true);
    await mock("slack_timeline", timeline([{ ...message, unreadReplies: null }], { missing: lackingWrite }));
    await (await readButton("dev")).click();
    await waitForCalls(seen);
    await waitForCalls("slack_timeline");
    expect(await callsOf(mark)).toEqual([]);
    expect(await layout()).toEqual(["未読", "unread:Parent"]);
    // Nothing is left to press.
    expect(await count("#slack-feed .feed-chan-read")).toBe(0);
  });

  it("says that the position could not be sent when slack_mark_read fails, and brings the rows back with the list made again from Rust's cache", async () => {
    const messages = unreadSample();
    const mark = await openUnread(messages);
    await mock("slack_mark_read", rejects("失敗しました"));
    const fresh = await mock("slack_timeline", timeline(messages));
    await (await readButton("dev")).click();
    await waitForCalls(mark);
    await expect($("#error")).toHaveText(expect.stringContaining("既読を Slack に送れませんでした"));
    expect(await waitForCalls(fresh)).toEqual([{ cached: true }]);
    await browser.waitUntil(async () => (await layout()).join() === ["未読", "unread:second", "unread:first", "unread:other"].join());
    await expect($("#slack-thread")).not.toBeDisplayed();
  });

  it("says that the channel could not be read when slack_thread_seen fails for a thread alone, and brings the row back with the list made again from Rust's cache", async () => {
    const message = withReplies();
    await openList(timeline([message]));
    await waitForCount("#slack-feed .feed-row", 1);
    const seen = await mock("slack_thread_seen", rejects("失敗しました"));
    const mark = await mock("slack_mark_read", true);
    const fresh = await mock("slack_timeline", timeline([message]));
    await (await readButton("dev")).click();
    await waitForCalls(seen);
    await expect($("#error")).toHaveText(expect.stringContaining("既読にできませんでした"));
    expect(await waitForCalls(fresh)).toEqual([{ cached: true }]);
    expect(await callsOf(mark)).toEqual([]);
    await waitForCount("#slack-feed .feed-row", 1);
    await expect($("#slack-thread")).not.toBeDisplayed();
  });

  it("ignores the second click of a double click on 既読にする and on the row that moved under the pointer, and opens a thread with a double click on a row", async () => {
    const messages = unreadSample();
    const mark = await openUnread(messages);
    const thread = await mock("slack_thread", slackThread([threadMessage(messages[1].ts, "Bob Example", "other")]));
    await mock("slack_timeline", timeline([messages[1]]));
    // The first click reads #dev and redraws at once, so that the group of "other" is under the pointer for the second click, which lands on its button or on its row.
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      const click = (element: Element, detail: number) => element.dispatchEvent(new MouseEvent("click", { detail, bubbles: true }));
      click(document.querySelector("#slack-feed .feed-chan-read")!, 1);
      click(document.querySelector("#slack-feed .feed-chan-read")!, 2);
      click(document.querySelector("#slack-feed .feed-open")!, 2);
    }, onceId());
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[0].ts }]);
    expect(await layout()).toEqual(["未読", "unread:other"]);
    await browser.pause(300);
    expect(await callsOf(mark)).toHaveLength(1);
    expect(await callsOf(thread)).toEqual([]);
    await expect($("#slack-thread")).not.toBeDisplayed();
    // Past the double-click time, a double click on a row opens its thread as before.
    await browser.pause(400);
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      document.querySelector("#slack-feed .feed-open")!.dispatchEvent(new MouseEvent("click", { detail: 2, bubbles: true }));
    }, onceId());
    await expect($("#slack-thread")).toBeDisplayed();
    expect(await callsOf(thread)).toHaveLength(1);
  });

  it("uses no answer of a read that began before 既読にする, and makes the list again from the cache once the requests are done", async () => {
    const messages = unreadSample();
    await openList(timeline(messages, { refreshSecs: 2 }));
    await waitForCount("#slack-feed .feed-row", 3);
    // The periodic read is on its way when the button is pressed.
    const read = await mock("slack_timeline", holds);
    await waitForCalls(read);
    const mark = await mock("slack_mark_read", holds);
    await (await readButton("dev")).click();
    await waitForCalls(mark);
    expect(await layout()).toEqual(["未読", "unread:other"]);
    // The older answer still has the rows: it comes before slack_mark_read ends and is passed over.
    await release(read, timeline(messages));
    await browser.pause(300);
    expect(await layout()).toEqual(["未読", "unread:other"]);
    await release(mark, true);
    await waitForCalls(read, 2);
    await browser.pause(300);
    const cached = (await callsOf(read)).slice(1);
    expect(cached.every((call) => JSON.stringify(call) === JSON.stringify({ cached: true }))).toBe(true);
    for (let i = 0; i < cached.length; i++) await release(read, timeline([messages[1]]));
    await browser.waitUntil(async () => (await layout()).join() === ["未読", "unread:other"].join());
  });
});

// The side menu (S-19): a workspace "Example Team" with #dev (unread, 3), the private "ops" and #announce, and a second workspace "Lakeside" with #random; Rust gives each workspace's channels by name.
const sideSample = () => [
  sideWorkspace([sideChannel("C0123ABCD", "dev", { unread: 3 }), sideChannel("G2", "ops", { private: true }), sideChannel("C3", "announce")]),
  sideWorkspace([sideChannel("C9", "random")], { teamId: "T2", team: "Lakeside" }),
];
// What the menu holds from the top: "button:..." for the two sections ("*" when chosen, the number after a space), "group:team" for a heading, "line" for the line, and "unread|read:hash|lock:name[ number]" for a channel.
const sideLayout = () =>
  browser.execute(() =>
    [...document.getElementById("slack-side-feed")!.children].map((c) => {
      if (c.classList.contains("slack-side-mode")) return `button:${c.getAttribute("aria-pressed") === "true" ? "*" : ""}${c.querySelector(".slack-side-name")!.textContent}${c.querySelector(".slack-side-n") ? ` ${c.querySelector(".slack-side-n")!.textContent}` : ""}`;
      if (c.classList.contains("slack-side-group")) return `group:${c.textContent}`;
      if (c.classList.contains("slack-side-sep")) return "line";
      const button = c.querySelector(".slack-side-btn")!;
      const n = button.querySelector(".slack-side-n");
      return `${button.classList.contains("unread") ? "unread" : "read"}:${button.querySelector("rect") ? "lock" : "hash"}:${button.querySelector(".slack-side-name")!.textContent}${n ? ` ${n.textContent}` : ""}`;
    }),
  );

describe("slack list: the side menu (S-19)", () => {
  // Newest first: two unread rows of #dev (channel C0123ABCD) and one of #random (C2), and an older row of #dev that is read.
  const withHidden = () => [
    timelineMessage(slackTs(1), "Alice Example", "dev", "from dev", { unread: true }),
    timelineMessage(slackTs(2), "Bob Example", "random", "from random", { unread: true, channel: "C2" }),
    timelineMessage(slackTs(3), "Bob Example", "dev", "older from dev"),
  ];

  it("draws the two sections with the unread number, then each workspace's channels as given, with the lock of a private one and the unread ones in bold, and no search field", async () => {
    await openList(timeline(unreadSample(), { side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await sideLayout()).toEqual(["button:*未読メッセージ 3", "button:ウォッチ", "line", "group:Example Team", "unread:hash:dev 3", "read:lock:ops", "read:hash:announce", "group:Lakeside", "read:hash:random"]);
    expect(await weightOf("#slack-side .slack-side-btn.unread")).toBe("700");
    expect(await weightOf("#slack-side .slack-side-btn:not(.unread)")).toBe("400");
    await expect($("#slack-side input")).not.toExist();
    await expect($("#slack-side [placeholder]")).not.toExist();
    // It is a column of the Orca list's make: the bar's background, left of the body, with its divider between.
    const place = await browser.execute(() => {
      const [side, split, body] = ["slack-side", "slack-side-split", "slack-pane"].map((id) => document.getElementById(id)!.getBoundingClientRect());
      return { side: side.right <= split.left + 1, body: split.right <= body.left + 1, bg: getComputedStyle(document.getElementById("slack-side")!).backgroundColor, bar: getComputedStyle(document.documentElement).getPropertyValue("--bar").trim() };
    });
    expect(place).toMatchObject({ side: true, body: true });
    expect(place.bar).not.toBe("");
  });

  it("shows no number for no unread message, no line and no heading when no channel is held, and a workspace with no channel has no heading", async () => {
    await openList(timeline([], { side: [] }));
    await waitForCount("#slack-side .slack-side-mode", 2);
    expect(await sideLayout()).toEqual(["button:*未読メッセージ", "button:ウォッチ"]);
    await mock("slack_timeline", timeline([], { side: [sideWorkspace([]), sideWorkspace([sideChannel("C9", "random")], { teamId: "T2", team: "Lakeside" })] }));
    await emitEvent("slack-timeline-dirty");
    await browser.waitUntil(async () => (await sideLayout()).length === 5);
    expect(await sideLayout()).toEqual(["button:*未読メッセージ", "button:ウォッチ", "line", "group:Lakeside", "read:hash:random"]);
  });

  it("shows the unread section with the first button and the watch section with the second, one at a time, and keeps the choice through a read", async () => {
    await openList(timeline(unreadSample(), { watched: watchedSample(), side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first", "unread:other"]);
    await $('#slack-side .slack-side-mode[data-key="watch"]').click();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await layout()).toEqual(["ウォッチ", "read:Watched read", "unread:Watched unread"]);
    expect((await sideLayout()).slice(0, 2)).toEqual(["button:未読メッセージ 3", "button:*ウォッチ"]);
    // A read from the cache redraws the list in the section chosen.
    await mock("slack_timeline", timeline(unreadSample(), { watched: watchedSample(), side: sideSample() }));
    await emitEvent("slack-timeline-dirty");
    await waitForCalls("slack_timeline");
    await browser.pause(200);
    expect(await layout()).toEqual(["ウォッチ", "read:Watched read", "unread:Watched unread"]);
    await $('#slack-side .slack-side-mode[data-key="unread"]').click();
    await waitForCount("#slack-feed .feed-row", 3);
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first", "unread:other"]);
  });

  it("starts the chosen section at the top of the list", async () => {
    await openList(timeline(many(30), { watched: watchedSample(), side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 30);
    await browser.execute(() => (document.getElementById("slack-feed")!.scrollTop = 300));
    await $('#slack-side .slack-side-mode[data-key="watch"]').click();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await scrollTop()).toBe(0);
  });

  it("stays beside a thread, and a section pressed there shows the list in that section in place of the thread", async () => {
    const messages = unreadSample();
    await openUnread(messages, { watched: watchedSample(), side: sideSample() });
    await openRow("first");
    await expect($("#slack-thread")).toBeDisplayed();
    await expect($("#slack-side")).toBeDisplayed();
    // The row opened set the position of #dev past two of its three unread messages: the numbers fall at once.
    expect(await sideLayout()).toEqual(expect.arrayContaining(["button:*未読メッセージ 1", "unread:hash:dev 1"]));
    await $('#slack-side .slack-side-mode[data-key="watch"]').click();
    await expect($("#slack-list")).toBeDisplayed();
    await expect($("#slack-thread")).not.toBeDisplayed();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await layout()).toEqual(["ウォッチ", "read:Watched read", "unread:Watched unread"]);
  });

  it("is not drawn on other screens", async () => {
    await openList(timeline(unreadSample(), { side: sideSample() }));
    await $("#nav-mail").click();
    await expect($("#slack-side")).not.toBeDisplayed();
    await expect($("#slack-screen")).not.toBeDisplayed();
  });

  describe("the heading of a workspace", () => {
    const headings = () => browser.execute(() => [...document.querySelectorAll("#slack-side .slack-side-group")].map((g) => `${g.tagName}:${g.getAttribute("type")}:${g.getAttribute("aria-expanded")}`));
    const pressHeading = (team: string) => $(`#slack-side .slack-side-group[data-key="${team}/fold"]`).click();
    const openSide = async () => {
      await openList(timeline(unreadSample(), { side: sideSample() }));
      await waitForCount("#slack-feed .feed-row", 3);
    };
    const all = ["button:*未読メッセージ 3", "button:ウォッチ", "line", "group:Example Team", "unread:hash:dev 3", "read:lock:ops", "read:hash:announce", "group:Lakeside", "read:hash:random"];

    it("is a button with aria-expanded and a mark that turns; pressing it folds the workspace to its unread channels, and pressing it again brings the others back", async () => {
      await openSide();
      expect(await headings()).toEqual(["BUTTON:button:true", "BUTTON:button:true"]);
      expect(await count("#slack-side .slack-side-group svg")).toBe(2);
      const turn = () => browser.execute(() => getComputedStyle(document.querySelector("#slack-side .slack-side-group svg")!).transform);
      const open = await turn();
      await pressHeading("T1");
      expect(await sideLayout()).toEqual(["button:*未読メッセージ 3", "button:ウォッチ", "line", "group:Example Team", "unread:hash:dev 3", "group:Lakeside", "read:hash:random"]);
      expect(await headings()).toEqual(["BUTTON:button:false", "BUTTON:button:true"]);
      expect(await turn()).not.toBe(open);
      await pressHeading("T1");
      expect(await sideLayout()).toEqual(all);
      expect(await headings()).toEqual(["BUTTON:button:true", "BUTTON:button:true"]);
    });

    it("folds only the workspace pressed, keeps the heading of a workspace with no unread channel, and keeps the fold through a redraw", async () => {
      await openSide();
      await pressHeading("T2");
      expect(await sideLayout()).toEqual(["button:*未読メッセージ 3", "button:ウォッチ", "line", "group:Example Team", "unread:hash:dev 3", "read:lock:ops", "read:hash:announce", "group:Lakeside"]);
      expect(await headings()).toEqual(["BUTTON:button:true", "BUTTON:button:false"]);
      await mock("slack_timeline", timeline(unreadSample(), { side: sideSample() }));
      await emitEvent("slack-timeline-dirty");
      await waitForCalls("slack_timeline");
      await browser.pause(200);
      expect(await headings()).toEqual(["BUTTON:button:true", "BUTTON:button:false"]);
      expect(await count("#slack-side .slack-side-btn")).toBe(3);
    });

    it("saves the folded workspaces as a whole set at each press, and shows an error when the save fails", async () => {
      await openSide();
      await mock("slack_set_side_folded", true);
      await pressHeading("T1");
      expect(await waitForCalls("slack_set_side_folded")).toEqual([{ teamIds: ["T1"] }]);
      await pressHeading("T2");
      expect(await waitForCalls("slack_set_side_folded", 2)).toEqual([{ teamIds: ["T1"] }, { teamIds: ["T1", "T2"] }]);
      await pressHeading("T1");
      expect(await waitForCalls("slack_set_side_folded", 3)).toEqual([{ teamIds: ["T1"] }, { teamIds: ["T1", "T2"] }, { teamIds: ["T2"] }]);
      await mock("slack_set_side_folded", rejects("保存できません"));
      await pressHeading("T2");
      await waitForCalls("slack_set_side_folded");
      await expect($("#error")).toHaveText(expect.stringContaining("保存できません"));
      expect(await headings()).toEqual(["BUTTON:button:true", "BUTTON:button:true"]);
    });

    it("draws the folds read at the start", async () => {
      await openList(timeline(unreadSample(), { side: sideSample() }), { slack_side_folded: ["T2"] });
      await waitForCount("#slack-feed .feed-row", 3);
      expect(await headings()).toEqual(["BUTTON:button:true", "BUTTON:button:false"]);
      expect(await sideLayout()).toEqual(["button:*未読メッセージ 3", "button:ウォッチ", "line", "group:Example Team", "unread:hash:dev 3", "read:lock:ops", "read:hash:announce", "group:Lakeside"]);
    });

    it("keeps the channel whose history is shown when the workspace is folded, and keeps the focus on the heading", async () => {
      await openSide();
      await mock("slack_channel_history", [timelineMessage(slackTs(1), "Alice Example", "ops", "secret", { channel: "G2" })]);
      await $('#slack-side .slack-side-btn[data-key="T1/G2"]').click();
      await waitForCount("#sc-feed .feed-row", 1);
      await browser.execute(() => document.querySelector<HTMLElement>('#slack-side .slack-side-group[data-key="T1/fold"]')!.focus());
      await pressHeading("T1");
      expect(await sideLayout()).toEqual(["button:未読メッセージ 3", "button:ウォッチ", "line", "group:Example Team", "unread:hash:dev 3", "read:lock:ops", "group:Lakeside", "read:hash:random"]);
      expect(await browser.execute(() => document.activeElement?.getAttribute("data-key"))).toBe("T1/fold");
      expect(await browser.execute(() => document.querySelector('#slack-side .slack-side-btn[data-key="T1/G2"]')!.getAttribute("aria-pressed"))).toBe("true");
    });
  });

  it("shows the button that keeps a channel off the list beside it, hidden unless the mouse is over the channel or the focus is in it, as a circle with a minus", async () => {
    await openList(timeline(unreadSample(), { side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    const state = await browser.execute(() => {
      const item = document.querySelector<HTMLElement>("#slack-side .slack-side-item")!;
      const hide = item.querySelector<HTMLElement>(".slack-side-hide")!;
      const number = item.querySelector<HTMLElement>(".slack-side-n")!;
      return { tag: hide.tagName, inButton: !!hide.closest(".slack-side-btn"), parent: hide.parentElement!.className, label: hide.getAttribute("aria-label"), icon: hide.classList.contains("icon-btn"), circle: !!hide.querySelector("svg circle"), eye: !!hide.querySelector("svg ellipse, svg path[d^='M2 12']"), visibility: getComputedStyle(hide).visibility, number: getComputedStyle(number).visibility };
    });
    expect(state).toEqual({ tag: "BUTTON", inButton: false, parent: "slack-side-item", label: "#dev を一覧に出さない", icon: true, circle: true, eye: false, visibility: "hidden", number: "visible" });
    const rules = await browser.execute(() => {
      const found: string[] = [];
      for (const sheet of document.styleSheets)
        for (const rule of sheet.cssRules) if (rule instanceof CSSStyleRule && rule.selectorText.includes(".slack-side-hide") && rule.style.visibility === "visible") found.push(rule.selectorText);
      return found.join(" | ");
    });
    expect(rules).toContain(".slack-side-item:hover");
    expect(rules).toContain(".slack-side-item:focus-within");
    // The same selectors give way to the number.
    const gives = await browser.execute(() => {
      const found: string[] = [];
      for (const sheet of document.styleSheets)
        for (const rule of sheet.cssRules) if (rule instanceof CSSStyleRule && rule.selectorText.includes(".slack-side-n") && rule.style.visibility === "hidden") found.push(rule.selectorText);
      return found.join(" | ");
    });
    expect(gives).toContain(".slack-side-item:hover");
    expect(gives).toContain(".slack-side-item:focus-within");
  });

  it("keeps the channel off the list on pressing the button: slack_hide_channel is called, the channel and its rows go at once, the notice offers to undo it, and the list is made again from Rust's cache", async () => {
    await openList(timeline(withHidden(), { side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    const hide = await mock("slack_hide_channel", holds);
    const mark = await mock("slack_mark_read", true);
    await mock("slack_timeline", timeline([withHidden()[1]], { side: [sideWorkspace([sideChannel("G2", "ops", { private: true }), sideChannel("C3", "announce")]), sideWorkspace([sideChannel("C9", "random")], { teamId: "T2", team: "Lakeside" })] }));
    await browser.execute(() => document.querySelector("#slack-side .slack-side-item")!.classList.add("keep"));
    await $('#slack-side button[aria-label="#dev を一覧に出さない"]').click();
    expect(await waitForCalls(hide)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD" }]);
    // Before Rust has answered, the channel is out of the menu and its rows out of the list.
    expect((await sideLayout()).filter((c) => c.includes(":dev"))).toEqual([]);
    expect(await textsOf("#slack-feed .feed-text")).toEqual(["from random"]);
    await release(hide, true);
    await expect($(".toast")).toHaveText(expect.stringContaining("#dev を一覧に出さないようにしました"));
    await expect($(".toast")).toHaveText(expect.stringContaining("元に戻す"));
    expect(await waitForCalls("slack_timeline")).toEqual([{ cached: true }]);
    expect(await callsOf(mark)).toEqual([]);
    await expect($("#slack-thread")).not.toBeDisplayed();
    expect((await sideLayout()).slice(3)).toEqual(["group:Example Team", "read:lock:ops", "read:hash:announce", "group:Lakeside", "read:hash:random"]);
  });

  it("puts the channel back with 元に戻す, as for a row", async () => {
    await openList(timeline(withHidden(), { side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_hide_channel", true);
    await mock("slack_timeline", timeline([withHidden()[1]], { side: [sideWorkspace([sideChannel("G2", "ops", { private: true })])] }));
    await browser.execute(() => document.querySelector("#slack-side .slack-side-item")!.classList.add("keep"));
    await $('#slack-side button[aria-label="#dev を一覧に出さない"]').click();
    await expect($(".toast")).toHaveText(expect.stringContaining("元に戻す"));
    const unhide = await mock("slack_unhide_channel", true);
    await $(".toast button").click();
    expect(await waitForCalls(unhide)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD" }]);
  });

  it("brings the channel back and says so when slack_hide_channel fails", async () => {
    await openList(timeline(withHidden(), { side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_hide_channel", rejects("保存できません"));
    await browser.execute(() => document.querySelector("#slack-side .slack-side-item")!.classList.add("keep"));
    await $('#slack-side button[aria-label="#dev を一覧に出さない"]').click();
    await expect($("#error")).toHaveText(expect.stringContaining("保存できません"));
    await browser.waitUntil(async () => (await sideLayout()).includes("unread:hash:dev 3"));
    await waitForCount("#slack-feed .feed-row", 3);
  });
});

// The history of a channel (S-20). Oldest first, as `slack_channel_history` answers: "old" is three days old, "first" has two replies, "second" is a reply also sent to the channel.
const [oldTs, firstTs, secondTs] = [slackTs(3 * 24 * 60), slackTs(20), slackTs(10)];
const historySample = () => [
  timelineMessage(oldTs, "Bob Example", "dev", "old"),
  timelineMessage(firstTs, "Alice Example", "dev", "first", { replyCount: 2 }),
  timelineMessage(secondTs, "Carol Example", "dev", "second", { threadTs: firstTs }),
];
const pressChannel = (id = "C0123ABCD") => $(`#slack-side .slack-side-btn[data-key="T1/${id}"]`).click();
const historyTexts = () => textsOf("#sc-feed .feed-main > .feed-text");
const historyScroll = () => browser.execute(() => document.getElementById("sc-feed")!.scrollTop);
const pressedChannels = () => browser.execute(() => [...document.querySelectorAll("#slack-side .slack-side-btn")].map((b) => b.getAttribute("aria-pressed")));

describe("slack list: the history of a channel (S-20)", () => {
  async function openHistory(messages = historySample(), extra: Parameters<typeof timeline>[1] = {}, unread = unreadSample()) {
    await openList(timeline(unread, { side: sideSample(), ...extra }));
    await waitForCount("#slack-feed .feed-row", 3);
    const history = await mock("slack_channel_history", messages);
    await mock("slack_thread", slackThread([threadMessage(slackTs(20), "Alice Example", "first")]));
    return history;
  }

  it("shows the history of the channel pressed: slack_channel_history is called with the workspace and the channel, the header is the channel and the workspace only, and the channel is the one pressed", async () => {
    const rows = unreadSample();
    const history = await openHistory(historySample(), {}, rows);
    const mark = await mock("slack_mark_read", true);
    // What Rust holds once the position is set: dev has nothing unread any more.
    await mock("slack_timeline", timeline([unreadSample()[1]], { side: [sideWorkspace([sideChannel("C0123ABCD", "dev"), sideChannel("G2", "ops", { private: true }), sideChannel("C3", "announce")]), sideWorkspace([sideChannel("C9", "random")], { teamId: "T2", team: "Lakeside" })] }));
    await pressChannel();
    expect(await waitForCalls(history)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD" }]);
    await expect($("#slack-channel")).toBeDisplayed();
    await expect($("#slack-list")).not.toBeDisplayed();
    await waitForCount("#sc-feed .feed-row", 3);
    expect(await historyTexts()).toEqual(["old", "first", "second"]);
    expect(await textsOf("#sc-head h1 > *")).toEqual(["", "dev", "Example Team"]);
    expect(await count("#sc-head button, #sc-head [role=tab]")).toBe(0);
    expect(await count("#sc-ic svg")).toBe(1);
    const days = await textsOf("#sc-feed .feed-day");
    expect(days).toHaveLength(2);
    expect(days[1]).toBe("今日");
    expect(await textsOf("#sc-feed .feed-thread-open")).toEqual(["2 件の返信"]);
    expect(await pressedChannels()).toEqual(["true", "false", "false", "false"]);
    // The press reads the channel (S-15): the position goes to its newest unread message ("first") and the unread numbers fall.
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: rows[0].ts }]);
    await browser.waitUntil(async () => (await sideLayout())[4] === "read:hash:dev");
    expect((await sideLayout()).slice(0, 2)).toEqual(["button:未読メッセージ 1", "button:ウォッチ"]);
  });

  describe("reading the channel at the press (S-19)", () => {
    const lackingWrite = [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write"] }];

    it("calls slack_mark_read with the newest unread message of the channel and slack_thread_seen for each thread with unread replies, and opens the history", async () => {
      const message = withReplies();
      const rows = unreadSample();
      await openList(timeline([...rows, message], { side: sideSample() }));
      await waitForCount("#slack-feed .feed-row", 4);
      const history = await mock("slack_channel_history", historySample());
      const mark = await mock("slack_mark_read", true);
      const seen = await mock("slack_thread_seen", true);
      await pressChannel();
      // The newest unread message of dev is "first".
      expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: rows[0].ts }]);
      expect(await waitForCalls(seen)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts, latestTs: replyTwo }]);
      expect(await waitForCalls(history)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD" }]);
      await expect($("#slack-channel")).toBeDisplayed();
      await waitForCount("#sc-feed .feed-row", 3);
    });

    it("does not call slack_mark_read when the token cannot write the position, and still calls slack_thread_seen for the unread replies", async () => {
      const message = withReplies();
      await openList(timeline([...unreadSample(), message], { side: sideSample(), missing: lackingWrite }));
      await waitForCount("#slack-feed .feed-row", 4);
      const history = await mock("slack_channel_history", historySample());
      const mark = await mock("slack_mark_read", true);
      const seen = await mock("slack_thread_seen", true);
      await pressChannel();
      expect(await waitForCalls(seen)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts, latestTs: replyTwo }]);
      await waitForCalls(history);
      expect(await callsOf(mark)).toEqual([]);
      await expect($("#slack-channel")).toBeDisplayed();
    });

    it("calls nothing to read when the token cannot write the position and no thread has unread replies, and opens the history", async () => {
      await openList(timeline(unreadSample(), { side: sideSample(), missing: lackingWrite }));
      await waitForCount("#slack-feed .feed-row", 3);
      const history = await mock("slack_channel_history", historySample());
      const mark = await mock("slack_mark_read", true);
      const seen = await mock("slack_thread_seen", true);
      await pressChannel();
      await waitForCalls(history);
      expect(await callsOf(mark)).toEqual([]);
      expect(await callsOf(seen)).toEqual([]);
      await expect($("#slack-channel")).toBeDisplayed();
    });

    it("calls nothing to read for a channel with nothing unread, and opens the history", async () => {
      await openList(timeline(unreadSample(), { side: sideSample() }));
      await waitForCount("#slack-feed .feed-row", 3);
      const history = await mock("slack_channel_history", historySample());
      const mark = await mock("slack_mark_read", true);
      const seen = await mock("slack_thread_seen", true);
      await pressChannel("C3");
      expect(await waitForCalls(history)).toEqual([{ teamId: workspace.teamId, channel: "C3" }]);
      expect(await callsOf(mark)).toEqual([]);
      expect(await callsOf(seen)).toEqual([]);
      await expect($("#slack-channel")).toBeDisplayed();
    });

    it("shows the error of the read when slack_mark_read fails, and opens the history all the same", async () => {
      await openList(timeline(unreadSample(), { side: sideSample() }));
      await waitForCount("#slack-feed .feed-row", 3);
      const history = await mock("slack_channel_history", historySample());
      await mock("slack_mark_read", rejects("失敗しました"));
      await pressChannel();
      await waitForCalls(history);
      await expect($("#error")).toHaveText(expect.stringContaining("既読を Slack に送れませんでした"));
      await expect($("#slack-channel")).toBeDisplayed();
    });
  });

  it("draws a private channel's header with a lock", async () => {
    const history = await openHistory([timelineMessage(slackTs(1), "Alice Example", "ops", "secret", { channel: "G2" })]);
    await pressChannel("G2");
    expect(await waitForCalls(history)).toEqual([{ teamId: workspace.teamId, channel: "G2" }]);
    await waitForCount("#sc-feed .feed-row", 1);
    expect(await count("#sc-ic rect")).toBe(1);
    expect(await textsOf("#sc-name")).toEqual(["ops"]);
  });

  it("opens at the newest message, the end of the list", async () => {
    await openHistory(many(40).reverse());
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 40);
    const gap = await browser.execute(() => {
      const box = document.getElementById("sc-feed")!;
      return { room: box.scrollHeight - box.clientHeight, left: box.scrollHeight - box.scrollTop - box.clientHeight };
    });
    expect(gap.room).toBeGreaterThan(0);
    expect(gap.left).toBeLessThan(2);
  });

  it("opens the thread of a message with the press, and the back button returns to the history where it was, reading nothing more", async () => {
    await openHistory([...many(40).reverse(), ...historySample()]);
    const mark = await mock("slack_mark_read", true);
    const thread = await mock("slack_thread", slackThread([threadMessage(slackTs(20), "Alice Example", "first")]));
    await pressChannel();
    // Only the press on the channel read it.
    await waitForCalls(mark);
    await waitForCount("#sc-feed .feed-row", 43);
    await browser.execute(() => (document.getElementById("sc-feed")!.scrollTop = 200));
    await browser.waitUntil(async () => (await historyScroll()) === 200);
    // The reply sent to the channel opens its thread, the thread's own `ts`.
    // A click through WebDriver scrolls its target into view first: the press is made in the page, where the list stands.
    await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#sc-feed .feed-row")].find((r) => r.querySelector(".feed-text")!.textContent === "second")!.querySelector<HTMLElement>(".feed-open")!.click());
    expect(await waitForCalls(thread)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: firstTs }]);
    await expect($("#slack-thread")).toBeDisplayed();
    await expect($("#slack-channel")).not.toBeDisplayed();
    expect((await pressedChannels())[0]).toBe("true");
    await $("#st-back").click();
    await expect($("#slack-channel")).toBeDisplayed();
    await expect($("#slack-list")).not.toBeDisplayed();
    expect(await historyScroll()).toBe(200);
    expect(await callsOf(mark)).toHaveLength(1);
  });

  it('opens the thread with "N 件の返信", too', async () => {
    const history = await openHistory();
    const thread = await mock("slack_thread", slackThread([threadMessage(slackTs(20), "Alice Example", "first")]));
    await pressChannel();
    await waitForCalls(history);
    await waitForCount("#sc-feed .feed-row", 3);
    await $("#sc-feed .feed-thread-open").click();
    expect(await waitForCalls(thread)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: firstTs }]);
    await expect($("#slack-thread")).toBeDisplayed();
  });

  it("draws the bookmark of a thread that is watched as on, and watches a thread with it without opening anything", async () => {
    await openHistory(historySample(), { watched: [watchedMessage(firstTs, "Alice Example", "dev", "first", 0)] });
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    expect(await browser.execute(() => [...document.querySelectorAll("#sc-feed .feed-watch")].map((b) => b.classList.contains("on")))).toEqual([false, true, true]);
    const watch = await mock("slack_watch", true);
    // What Rust answers once the thread is saved as watched.
    await mock("slack_timeline", timeline(unreadSample(), { side: sideSample(), watched: [watchedMessage(firstTs, "Alice Example", "dev", "first", 0), watchedMessage(oldTs, "Bob Example", "dev", "old", 0)] }));
    await browser.execute(() => document.querySelector("#sc-feed .feed-item")!.classList.add("feed-keep"));
    await $("#sc-feed .feed-item .feed-watch").click();
    expect(await waitForCalls(watch)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: oldTs }]);
    await browser.waitUntil(async () => await browser.execute(() => document.querySelector("#sc-feed .feed-watch")!.classList.contains("on")));
    await expect($("#slack-thread")).not.toBeDisplayed();
    await expect($("#slack-channel")).toBeDisplayed();
  });

  it("lets a thread go with the bookmark of a reply also sent to the channel: slack_unwatch is called with the thread's ts, not the reply's", async () => {
    await openHistory(historySample(), { watched: [watchedMessage(firstTs, "Alice Example", "dev", "first", 0)] });
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    const unwatch = await mock("slack_unwatch", null);
    await mock("slack_timeline", timeline(unreadSample(), { side: sideSample() }));
    await browser.execute(() => document.querySelectorAll("#sc-feed .feed-item")[2].classList.add("feed-keep"));
    await $$("#sc-feed .feed-item .feed-watch")[2].click();
    expect(await waitForCalls(unwatch)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: firstTs }]);
  });

  it("draws the reactions of a message under its text and above its replies (S-22), and nothing under a message without any", async () => {
    const history = await openHistory([
      timelineMessage(oldTs, "Bob Example", "dev", "old"),
      timelineMessage(firstTs, "Alice Example", "dev", "first", { replyCount: 2, reactions: [reaction("tada", "🎉", 3), reaction("partyparrot", ":partyparrot:", 12)] }),
    ]);
    await pressChannel();
    await waitForCalls(history);
    await waitForCount("#sc-feed .feed-row", 2);
    expect(await count("#sc-feed .reactions")).toBe(1);
    expect(await textsOf("#sc-feed .reaction-emoji")).toEqual(["🎉", ":partyparrot:"]);
    expect(await textsOf("#sc-feed .reaction-count")).toEqual(["3", "12"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#sc-feed .feed-item")[1].querySelector(".feed-main")!.children].map((e) => e.className.split(" ")[0]))).toEqual(["feed-meta", "feed-text", "reactions", "feed-thread-open"]);
    // The row's press goes through the box of the reactions to the row (it still opens its thread); only each reaction, a button (S-25), takes its own press.
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#sc-feed .reactions")!).pointerEvents)).toBe("none");
    expect(await browser.execute(() => [...document.querySelectorAll("#sc-feed .reaction")].map((r) => `${r.tagName}:${getComputedStyle(r).pointerEvents}`))).toEqual(["BUTTON:auto", "BUTTON:auto"]);
  });

  describe("add and take off a reaction (S-25)", () => {
    const chips = () =>
      browser.execute(() =>
        [...document.querySelectorAll<HTMLButtonElement>("#sc-feed .reaction")].map((r) => [r.dataset.name, r.querySelector(".reaction-count")!.textContent, r.classList.contains("mine"), r.getAttribute("aria-pressed"), r.disabled]),
      );
    const reacted = () => [timelineMessage(firstTs, "Alice Example", "dev", "first", { replyCount: 2, reactions: [reaction("tada", "🎉", 3), reaction("eyes", "👀", 1, null, true)] })];
    const open = async () => {
      const history = await openHistory(reacted());
      await pressChannel();
      await waitForCalls(history);
      await waitForCount("#sc-feed .reaction", 2);
      return history;
    };

    it("adds a reaction with a press: slack_react gets the workspace, the channel, the row's ts, the name and add true, the count and the frame change in place, and the row's thread does not open", async () => {
      const history = await open();
      const thread = await mock("slack_thread", slackThread([threadMessage(slackTs(20), "Alice Example", "first")]));
      const react = await mock("slack_react", true);
      await $$("#sc-feed .reaction")[0].click();
      expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: firstTs, name: "tada", add: true }]);
      await browser.waitUntil(async () => (await chips())[0][1] === "4");
      expect(await chips()).toEqual([["tada", "4", true, "true", false], ["eyes", "1", true, "true", false]]);
      expect(await callsOf(thread)).toEqual([]);
      await expect($("#slack-thread")).not.toBeDisplayed();
      expect(await callsOf(history)).toHaveLength(1);
    });

    it("takes off the reaction the user gave, and the reaction nobody else gave is gone", async () => {
      await open();
      const react = await mock("slack_react", true);
      await $$("#sc-feed .reaction")[1].click();
      expect(await waitForCalls(react)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: firstTs, name: "eyes", add: false }]);
      await waitForCount("#sc-feed .reaction", 1);
      expect(await chips()).toEqual([["tada", "3", false, "false", false]]);
    });

    it("shows the error and changes nothing when slack_react fails", async () => {
      await open();
      const before = await chips();
      const react = await mock("slack_react", rejects("このメッセージにはこれ以上リアクションを付けられません"));
      await $$("#sc-feed .reaction")[0].click();
      await waitForCalls(react);
      await expect($(".toast")).toHaveText(expect.stringContaining("リアクションを変えられませんでした: このメッセージにはこれ以上リアクションを付けられません"));
      expect(await chips()).toEqual(before);
    });

    it("sends a press once while it is on its way: the button is off until Rust answers", async () => {
      await open();
      const react = await mock("slack_react", holds);
      await $$("#sc-feed .reaction")[0].click();
      await waitForCalls(react);
      await browser.waitUntil(async () => (await chips())[0][4] === true);
      await browser.execute(() => document.querySelector<HTMLElement>("#sc-feed .reaction")!.click());
      await browser.pause(200);
      expect(await callsOf(react)).toHaveLength(1);
      await release(react, true);
      await browser.waitUntil(async () => (await chips())[0][1] === "4");
      expect(await chips()).toEqual([["tada", "4", true, "true", false], ["eyes", "1", true, "true", false]]);
    });

    it("is a button the keyboard reaches", async () => {
      await open();
      expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#sc-feed .reaction")].map((r) => `${r.tagName}:${r.tabIndex}`))).toEqual(["BUTTON:0", "BUTTON:0"]);
    });
  });

  it('draws "スレッドに返信済み" above the text of a reply also sent to the channel, with the start of its parent when Rust gave it, and opens the thread with the press (#467)', async () => {
    const history = await openHistory([
      timelineMessage(oldTs, "Bob Example", "dev", "old"),
      timelineMessage(firstTs, "Alice Example", "dev", "first", { replyCount: 2 }),
      timelineMessage(secondTs, "Carol Example", "dev", "second", { threadTs: firstTs, threadReply: { parent: "@here release notes" } }),
      timelineMessage(slackTs(21), "Dave Example", "dev", "third", { threadTs: firstTs, threadReply: { parent: null } }),
    ]);
    const thread = await mock("slack_thread", slackThread([threadMessage(slackTs(20), "Alice Example", "first")]));
    await pressChannel();
    await waitForCalls(history);
    await waitForCount("#sc-feed .feed-row", 4);
    // Only the two replies carry it; the others draw nothing.
    expect(await textsOf("#sc-feed .feed-thread-reply")).toEqual(["スレッドに返信済み: @here release notes", "スレッドに返信済み"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#sc-feed .feed-item")].map((i) => i.querySelectorAll(".feed-thread-reply").length))).toEqual([0, 0, 1, 1]);
    // It is above the text, and muted (the same color as the time).
    expect(await browser.execute(() => [...document.querySelectorAll("#sc-feed .feed-item")[2].querySelector(".feed-main")!.children].map((e) => e.className.split(" ")[0]))).toEqual(["feed-meta", "feed-thread-reply", "feed-text"]);
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#sc-feed .feed-thread-reply")!).color === getComputedStyle(document.querySelector("#sc-feed .feed-meta span")!).color)).toBe(true);
    // The press goes through it to the row: the thread opens, the thread's own `ts`.
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#sc-feed .feed-thread-reply")!).pointerEvents)).toBe("none");
    await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#sc-feed .feed-row")].find((r) => r.querySelector(".feed-text")!.textContent === "second")!.querySelector<HTMLElement>(".feed-open")!.click());
    expect(await waitForCalls(thread)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: firstTs }]);
    await expect($("#slack-thread")).toBeDisplayed();
  });

  it("does not draw it in the unread list, whose rows carry none", async () => {
    await openList(timeline([timelineMessage(slackTs(5, 1), "Alice Example", "dev", "Please review the deploy notes.", { threadTs: firstTs })]));
    await waitForCount("#slack-feed .feed-row", 1);
    expect(await count("#slack-feed .feed-thread-reply")).toBe(0);
  });

  it("draws the reactions again when the history is read again and they changed", async () => {
    await openHistory([timelineMessage(firstTs, "Alice Example", "dev", "first", { reactions: [reaction("tada", "🎉", 3)] })]);
    await pressChannel();
    await waitForCount("#sc-feed .reaction", 1);
    await mock("slack_channel_history", [timelineMessage(firstTs, "Alice Example", "dev", "first", { reactions: [reaction("tada", "🎉", 4), reaction("eyes", "👀", 1)] })]);
    await pressChannel();
    await waitForCount("#sc-feed .reaction", 2);
    expect(await textsOf("#sc-feed .reaction-count")).toEqual(["4", "1"]);
  });

  it("draws the custom emoji of a reaction as the image fetch_images gave, and keeps :name: until it is here and when it cannot be fetched (S-26)", async () => {
    const emojiUrl = "https://emoji.slack-edge.com/T1/partyparrot/abc.gif";
    const parrot = reaction("partyparrot", ":partyparrot:", 12, emojiUrl);
    const emojiNodes = () => browser.execute(() => [...document.querySelectorAll("#sc-feed .reaction-emoji")].map((e) => [e.textContent, e.querySelector("img")?.getAttribute("alt") ?? null]));
    const history = await openHistory([timelineMessage(firstTs, "Alice Example", "dev", "first", { reactions: [parrot, reaction("tada", "🎉", 3)] })]);
    // The image cannot be fetched: the name stays.
    const fetch = await mock("fetch_images", {});
    await pressChannel();
    await waitForCalls(history);
    expect((await waitForCalls(fetch)).flatMap((c) => (c as { urls: string[] }).urls)).toEqual([emojiUrl]);
    await waitForCount("#sc-feed .reaction", 2);
    expect(await emojiNodes()).toEqual([[":partyparrot:", null], ["🎉", null]]);
    // It can be fetched when the history is read again: the image replaces the name.
    await mock("fetch_images", { [emojiUrl]: pngUri });
    await mock("slack_channel_history", [timelineMessage(firstTs, "Alice Example", "dev", "first", { reactions: [parrot, reaction("tada", "🎉", 4)] })]);
    await pressChannel();
    await browser.waitUntil(async () => (await count("#sc-feed .reaction-emoji img.reaction-img")) === 1);
    expect(await emojiNodes()).toEqual([["", ":partyparrot:"], ["🎉", null]]);
    expect(await textsOf("#sc-feed .reaction-count")).toEqual(["12", "4"]);
  });

  it("shows the error with 再読み込み when the history cannot be read, and reads it again with the button", async () => {
    await openHistory();
    const failing = await mock("slack_channel_history", rejects("権限がありません"));
    await pressChannel();
    await waitForCalls(failing);
    await expect($("#sc-feed .pending.fail")).toHaveText(expect.stringContaining("読み込めませんでした: 権限がありません"));
    expect(await count("#sc-feed .feed-row")).toBe(0);
    const history = await mock("slack_channel_history", historySample());
    await $("#sc-feed .pending.fail .text-btn").click();
    expect(await waitForCalls(history)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD" }]);
    await waitForCount("#sc-feed .feed-row", 3);
    expect(await count("#sc-feed .pending")).toBe(0);
  });

  it("leaves the history for the list when a section is pressed, and the channel is no longer the pressed one", async () => {
    await openHistory();
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    await showWatch();
    await expect($("#slack-list")).toBeDisplayed();
    await expect($("#slack-channel")).not.toBeDisplayed();
    // The press read the channel; the list made again from Rust's cache (which this spec does not change) has the unread number back.
    await browser.waitUntil(async () => (await sideLayout()).slice(0, 2).join() === ["button:未読メッセージ 3", "button:*ウォッチ"].join());
    expect(await pressedChannels()).toEqual(["false", "false", "false", "false"]);
  });

  it("goes back to the list when the channel shown is kept off the list", async () => {
    await openHistory();
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    await mock("slack_hide_channel", true);
    await mock("slack_timeline", timeline([], { side: [sideWorkspace([sideChannel("G2", "ops", { private: true })])] }));
    await browser.execute(() => document.querySelector("#slack-side .slack-side-item")!.classList.add("keep"));
    await $('#slack-side button[aria-label="#dev を一覧に出さない"]').click();
    await expect($("#slack-list")).toBeDisplayed();
    await expect($("#slack-channel")).not.toBeDisplayed();
  });
});

describe("slack list: Socket Mode", () => {
  const badge = () => $("#nav-slack .nav-count");

  it("makes the list again from Rust's cache when an event was read, with no full read, and updates the badge", async () => {
    await openList(timeline(unreadSample()));
    await waitForCount("#slack-feed .feed-row", 3);
    await expect(badge()).toHaveText("3");
    const read = await mock("slack_timeline", timeline([timelineMessage(slackTs(0), "Carol Example", "dev", "just posted", { unread: true }), ...unreadSample()]));
    await emitEvent("slack-timeline-dirty");
    expect(await waitForCalls(read)).toEqual([{ cached: true }]);
    await waitForCount("#slack-feed .feed-row", 4);
    expect(await layout()).toEqual(["未読", "unread:second", "unread:first", "unread:just posted", "unread:other"]);
    await expect(badge()).toHaveText("4");
    // Slack is not asked: no call follows.
    await browser.pause(300);
    expect(await callsOf(read)).toEqual([{ cached: true }]);
  });

  it("reads the list in full when a connection is made", async () => {
    await openList(timeline(sample()));
    await waitForCount("#slack-feed .feed-row", 2);
    const read = await mock("slack_timeline", timeline(unreadSample()));
    await emitEvent("slack-socket-resync");
    expect(await waitForCalls(read)).toEqual([null]);
    await waitForCount("#slack-feed .feed-row", 3);
  });

  it("does not start a full read at a connection made while one is on its way", async () => {
    await openList(timeline(sample(), { refreshSecs: 2 }));
    await waitForCount("#slack-feed .feed-row", 2);
    // The periodic read is on its way: held.
    const read = await mock("slack_timeline", holds);
    await waitForCalls(read);
    await emitEvent("slack-socket-resync");
    await emitEvent("slack-socket-resync");
    await browser.pause(300);
    expect(await callsOf(read)).toEqual([null]);
    await release(read, timeline(sample(), { refreshSecs: 300 }));
  });

  it("reads the list in full once the read that was on its way is done, for a connection made meanwhile", async () => {
    await openList(timeline(sample(), { refreshSecs: 2 }));
    await waitForCount("#slack-feed .feed-row", 2);
    const read = await mock("slack_timeline", holds);
    await waitForCalls(read);
    await emitEvent("slack-socket-resync");
    await browser.pause(300);
    expect(await callsOf(read)).toEqual([null]);
    await release(read, timeline(sample(), { refreshSecs: 300 }));
    expect(await waitForCalls(read, 2)).toEqual([null, null]);
  });

  it("makes the list again when a connection changes state, so that the wait follows it", async () => {
    await openList(timeline(sample(), { refreshSecs: 300 }));
    await waitForCount("#slack-feed .feed-row", 2);
    const read = await mock("slack_timeline", timeline(sample(), { refreshSecs: 120 }));
    await emitEvent("slack-socket-status", socketStatus("reconnecting"));
    expect(await waitForCalls(read)).toEqual([{ cached: true }]);
  });

  it("does nothing at an event while there is no workspace", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    const read = await mock("slack_timeline", timeline(sample()));
    await emitEvent("slack-timeline-dirty");
    await emitEvent("slack-socket-resync");
    await emitEvent("slack-socket-status", socketStatus("connected"));
    await browser.pause(500);
    expect(await callsOf(read)).toEqual([]);
  });
});

describe("slack list: the popups for a new Slack message (S-17)", () => {
  const base = () => [timelineMessage(slackTs(30, 2), "Bob Example", "general", "Lunch at noon.", { unread: true })];
  const fresh = (n: number, text: string, extra: Partial<TimelineMessage> = {}) => timelineMessage(slackTs(0, n), "Grace Example", "dev", text, { unread: true, ...extra });
  const cards = () => textsOf(".arrival");
  const syncRound = () =>
    browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      document.dispatchEvent(new Event("visibilitychange"));
    }, onceId());

  beforeEach(async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(base(), { refreshSecs: 300 }), claude_status: claudeReady });
    await expect($("#nav-slack .nav-count")).toHaveText("1");
  });

  // One read that finds `arrived` (the rows hold them, newest first, then `unread`, the messages of earlier reads that are still unread); the reads after it find nothing new, as Rust gives a message in one answer only.
  async function arrive(arrived: TimelineMessage[], extra: Parameters<typeof timeline>[1] = {}, unread: TimelineMessage[] = []) {
    const rows = [...arrived, ...unread, ...base()];
    const read = await mock("slack_timeline", timeline(rows, { arrived, refreshSecs: 300, ...extra }));
    await emitEvent("slack-timeline-dirty");
    await waitForCalls(read);
    await mock("slack_timeline", timeline(rows, { refreshSecs: 300, ...extra }));
  }
  // The same answer as after the message was read: it is not among the rows.
  const readElsewhere = () => mock("slack_timeline", timeline(base(), { refreshSecs: 300 }));

  it("shows a card for a new message with the sender, the channel, the text on one line and the buttons, and none for a read that found nothing new", async () => {
    await arrive([]);
    await browser.pause(300);
    expect(await cards()).toEqual([]);
    const message = fresh(1, "Deploy finished\nplease check the logs");
    await arrive([message]);
    await waitForCount(".arrival", 1);
    const card = $(".arrival");
    await expect(card).toHaveText(expect.stringContaining("Grace Example"));
    await expect(card).toHaveText(expect.stringContaining("#dev"));
    await expect(card).toHaveText(expect.stringContaining("Deploy finished"));
    await expect(card.$(".feed-ws")).toBeDisplayed();
    const look = await browser.execute(() => {
      const card = document.querySelector(".arrival")!;
      const line = getComputedStyle(card.querySelector(".arrival-subject")!);
      const r = card.getBoundingClientRect();
      return {
        wrap: line.whiteSpace,
        cut: line.textOverflow,
        buttons: [...card.querySelectorAll(".arrival-actions > *")].map((b) => b.getAttribute("aria-label") ?? b.textContent),
        right: innerWidth - r.right,
        bottom: innerHeight - r.bottom,
      };
    });
    expect(look.wrap).toBe("nowrap");
    expect(look.cut).toBe("ellipsis");
    expect(look.buttons).toEqual(["既読にする", "ウォッチ", "スレッドを開く"]);
    await expect(card.$('button[aria-label="閉じる"]')).toBeDisplayed();
    expect(look.right).toBe(24);
    expect(look.bottom).toBeGreaterThanOrEqual(24);
    // The same message found again does not add a second card.
    await arrive([message]);
    expect(await cards()).toHaveLength(1);
  });

  it("reads the message with the commands of the check of a row, and closes the card", async () => {
    const message = fresh(1, "Deploy finished");
    await arrive([message]);
    await waitForCount(".arrival", 1);
    const mark = await mock("slack_mark_read", true);
    const open = await mock("slack_thread", slackThread([threadMessage(message.ts, "Grace Example", "Deploy finished")]));
    await readElsewhere();
    await $('.arrival button[aria-label="既読にする"]').click();
    await waitForCount(".arrival", 0);
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts }]);
    expect(await callsOf(open)).toEqual([]);
    await expect($("#slack-thread")).not.toBeDisplayed();
    await expect($("#slack-list")).not.toBeDisplayed();
  });

  it("watches the thread of the message with the command of the bookmark of a row, and closes the card", async () => {
    const message = fresh(1, "Deploy finished");
    await arrive([message]);
    await waitForCount(".arrival", 1);
    const watch = await mock("slack_watch", true);
    await readElsewhere();
    await $('.arrival button[aria-label="ウォッチ"]').click();
    await waitForCount(".arrival", 0);
    expect(await waitForCalls(watch)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts }]);
  });

  it("watches the thread of a reply sent to the channel by its thread's own timestamp", async () => {
    const reply = fresh(1, "Also to the channel", { threadTs: "1700000000.000001" });
    await arrive([reply]);
    await waitForCount(".arrival", 1);
    const watch = await mock("slack_watch", true);
    await readElsewhere();
    await $('.arrival button[aria-label="ウォッチ"]').click();
    expect(await waitForCalls(watch)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: "1700000000.000001" }]);
  });

  it("opens the thread from another screen, sets the read position as the row does, and leaves the Slack button current", async () => {
    const message = fresh(1, "Deploy finished");
    await arrive([message]);
    await waitForCount(".arrival", 1);
    await expect($("#slack-list")).not.toBeDisplayed();
    const mark = await mock("slack_mark_read", true);
    const open = await mock("slack_thread", slackThread([threadMessage(message.ts, "Grace Example", "Deploy finished")]));
    await readElsewhere();
    await $(".arrival").$("button=スレッドを開く").click();
    await expect($("#slack-thread")).toBeDisplayed();
    await expect($("#nav-slack")).toHaveAttribute("aria-current", "page");
    expect(await waitForCalls(open)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts }]);
    expect(await waitForCalls(mark)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", ts: message.ts }]);
    await waitForCount(".arrival", 0);
  });

  it("closes with the close button and calls nothing", async () => {
    await arrive([fresh(1, "Deploy finished")]);
    const mark = await mock("slack_mark_read", true);
    const watch = await mock("slack_watch", true);
    await $('.arrival button[aria-label="閉じる"]').click();
    await waitForCount(".arrival", 0);
    expect(await callsOf(mark)).toEqual([]);
    expect(await callsOf(watch)).toEqual([]);
  });

  it("has no check when pressing it would change nothing, as a row has none", async () => {
    await arrive([fresh(1, "Deploy finished")], { missing: [{ teamId: workspace.teamId, team: workspace.team, scopes: ["channels:write"] }] });
    await waitForCount(".arrival", 1);
    expect(await count('.arrival button[aria-label="既読にする"]')).toBe(0);
    await expect($('.arrival button[aria-label="ウォッチ"]')).toBeDisplayed();
    await expect($(".arrival").$("button=スレッドを開く")).toBeDisplayed();
  });

  it("closes the card of a message that a later read finds read or gone", async () => {
    await arrive([fresh(1, "Deploy finished")]);
    await waitForCount(".arrival", 1);
    const read = await readElsewhere();
    await emitEvent("slack-timeline-dirty");
    await waitForCalls(read);
    await waitForCount(".arrival", 0);
  });

  it("closes the card of a message that the list marks read, with 既読にする of its channel", async () => {
    const message = fresh(1, "Deploy finished");
    await arrive([message]);
    await waitForCount(".arrival", 1);
    await mock("slack_mark_read", true);
    await readElsewhere();
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 2);
    // The message of the card and the one before it are in the group of their channel.
    await $("#slack-feed .feed-chan-read").click();
    await waitForCount(".arrival", 0);
  });

  it("gives no card for a new message of the thread that is open on screen", async () => {
    const first = fresh(1, "Deploy finished");
    await arrive([first]);
    await mock("slack_mark_read", true);
    await mock("slack_thread", slackThread([threadMessage(first.ts, "Grace Example", "Deploy finished")]));
    await $(".arrival").$("button=スレッドを開く").click();
    await expect($("#slack-thread")).toBeDisplayed();
    await arrive([fresh(2, "Also to the channel", { threadTs: first.ts }), fresh(3, "Another topic")]);
    await waitForCount(".arrival", 1);
    await browser.pause(300);
    expect(await cards()).toEqual([expect.stringContaining("Another topic")]);
  });

  it("stacks with the popups for new mail, 3 at most and the newest at the bottom, whichever kind", async () => {
    const mail = mailThread("t9", "Lunch plan", true);
    await waitForCount("#unread-threads li", 2);
    const sync = await mock("sync", { kind: "changed", threads: [mail], removed: [], arrived: [mail.id], historyId: "101" });
    await syncRound();
    await waitForCalls(sync);
    await mock("sync", { kind: "unchanged" });
    await waitForCount(".arrival", 1);
    // The newest first, as `arrived` is: "second" is the newer.
    await arrive([fresh(2, "second"), fresh(1, "first")]);
    await waitForCount(".arrival", 3);
    const stack = await cards();
    expect(stack[0]).toContain("Lunch plan");
    expect(stack[1]).toContain("first");
    expect(stack[2]).toContain("second");
    // A fourth card makes the oldest go, the mail card here.
    await arrive([fresh(3, "third")], {}, [fresh(2, "second"), fresh(1, "first")]);
    await browser.waitUntil(async () => (await cards()).every((t) => !t.includes("Lunch plan")));
    const after = await cards();
    expect(after).toHaveLength(3);
    expect([after[0], after[1], after[2]].map((t) => ["first", "second", "third"].find((w) => t.includes(w)))).toEqual(["first", "second", "third"]);
  });
});

// Posting to a channel (S-21).
// The editable part of the rich field (Milkdown's ProseMirror), the send arrow, and a toolbar button by name.
const field = () => $("#sc-input .ProseMirror");
const sendButton = () => $("#sc-send");
const tool = (name: string) => $(`#sc-tools [aria-label="${name}"]`);
// Types `text` in the field.
const write = async (text: string) => {
  await field().click();
  await browser.keys(text.split(""));
};
const selectAll = () => browser.keys(["Meta", "a"]);
const fieldText = () => browser.execute(() => (document.querySelector("#sc-input .ProseMirror") as HTMLElement).innerText.trim());
const editable = () => field().getAttribute("contenteditable");
// Cmd+Enter (Ctrl+Enter off macOS) in the field, sent as the key event the app listens for.
const pressPost = () =>
  browser.execute((id) => {
    if (!window.__e2e_once__(id)) return;
    const isMac = /Mac/.test(navigator.platform);
    document.querySelector("#sc-input .ProseMirror")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }));
  }, onceId());
const channelEnd = () =>
  browser.execute(() => {
    const box = document.getElementById("sc-feed")!;
    return { room: box.scrollHeight - box.clientHeight, left: box.scrollHeight - box.scrollTop - box.clientHeight };
  });

describe("slack list: posting to a channel (S-21)", () => {
  async function openPost(messages = historySample()) {
    await openList(timeline(unreadSample(), { side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    const history = await mock("slack_channel_history", messages);
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", messages.length);
    await browser.waitUntil(async () => (await editable()) === "true");
    return history;
  }

  it("shows the toolbar, the field and a send arrow in one frame, with no placeholder and no text button, and the arrow off while the text is blank", async () => {
    await openPost();
    await expect(field()).toBeDisplayed();
    await expect($("#sc-tools")).toHaveAttribute("role", "toolbar");
    expect(await $$("#sc-tools button").map((b) => b.getAttribute("aria-label"))).toEqual(TOOLS);
    await expect(field()).toHaveAttribute("aria-label", "チャンネルに投稿");
    expect(await field().getAttribute("placeholder")).toBeNull();
    await expect(sendButton()).toHaveAttribute("aria-label", "投稿");
    expect(await sendButton().getText()).toBe("");
    await expect($("#sc-reply .composer #sc-send")).toExist();
    await expect($("button=投稿する")).not.toExist();
    await expect(sendButton()).toBeDisabled();
    await write("  ");
    await expect(sendButton()).toBeDisabled();
    await write("Hello");
    await expect(sendButton()).toBeEnabled();
  });

  it("posts with slack_channel_post on Cmd+Enter (Ctrl+Enter off macOS), as Markdown with markdown true, empties the field and reads the history again", async () => {
    const history = await openPost();
    const post = await mock("slack_channel_post", true);
    await write("Hello team");
    await pressPost();
    expect(await waitForCalls(post)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", text: "Hello team\n", markdown: true }]);
    await browser.waitUntil(async () => (await fieldText()) === "");
    await expect(sendButton()).toBeDisabled();
    await waitForCalls(history, 2);
    await expect($("#sc-error")).not.toBeDisplayed();
  });

  it("posts a text made bold with the toolbar as Markdown", async () => {
    await openPost();
    const post = await mock("slack_channel_post", true);
    await write("Hello");
    await selectAll();
    await tool("太字").click();
    await expect($("#sc-input strong")).toHaveText("Hello");
    await sendButton().click();
    expect(await waitForCalls(post)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", text: "**Hello**\n", markdown: true }]);
  });

  it("makes a link and a bulleted list with the toolbar", async () => {
    await openPost();
    const post = await mock("slack_channel_post", true);
    await write("docs");
    await selectAll();
    await tool("リンク").click();
    await $('#sc-tools [aria-label="リンクの URL"]').setValue("https://example.com/docs");
    await browser.keys("Enter");
    await expect($('#sc-input a[href="https://example.com/docs"]')).toHaveText("docs");
    await tool("箇条書き").click();
    await sendButton().click();
    const [call] = await waitForCalls(post);
    const text = (call as { text: string }).text;
    expect(call).toMatchObject({ markdown: true });
    expect(text).toContain("[docs](https://example.com/docs)");
    expect(text).toMatch(/^[*-] /m);
  });

  it("posts with the arrow too, and takes plain Enter as a line break", async () => {
    await openPost();
    const post = await mock("slack_channel_post", true);
    await write("First line");
    await browser.keys("Enter");
    await browser.keys("Second line".split(""));
    expect(await callsOf(post)).toEqual([]);
    await sendButton().click();
    const [call] = await waitForCalls(post);
    expect((call as { text: string }).text).toMatch(/^First line\s+Second line\n$/);
  });

  it("shows the message just posted at the newest end of the history", async () => {
    await openPost(many(40).reverse());
    expect((await channelEnd()).room).toBeGreaterThan(0);
    await browser.execute(() => (document.getElementById("sc-feed")!.scrollTop = 0));
    await mock("slack_channel_post", true);
    await mock("slack_channel_history", [...many(40).reverse(), timelineMessage(slackTs(0), "Alice Example", "dev", "Hello team")]);
    await write("Hello team");
    await sendButton().click();
    await waitForCount("#sc-feed .feed-row", 41);
    await browser.waitUntil(async () => (await channelEnd()).left < 2);
  });

  it("shows a failed post above the field and keeps the text", async () => {
    const history = await openPost();
    await mock("slack_channel_post", rejects("投稿できません"));
    await write("Keep me");
    await sendButton().click();
    await expect($("#sc-error")).toHaveText(expect.stringContaining("投稿できませんでした: 投稿できません"));
    expect(await fieldText()).toBe("Keep me");
    await expect(sendButton()).toBeEnabled();
    expect(await editable()).toBe("true");
    expect(await callsOf(history)).toHaveLength(1);
    await write("!");
    await expect($("#sc-error")).not.toBeDisplayed();
  });

  it("locks the field, the toolbar and the arrow while the post is on its way, and posts nothing twice", async () => {
    await openPost();
    const post = await mock("slack_channel_post", holds);
    await write("Wait for it");
    await sendButton().click();
    await waitForCalls(post);
    expect(await editable()).toBe("false");
    await expect(tool("太字")).toBeDisabled();
    await expect(sendButton()).toBeDisabled();
    await browser.execute(() => document.getElementById("sc-send")!.click());
    await pressPost();
    expect(await callsOf(post)).toHaveLength(1);
    await release(post, true);
    await browser.waitUntil(async () => (await editable()) === "true");
    expect(await fieldText()).toBe("");
    expect(await callsOf(post)).toHaveLength(1);
  });

  it("keeps what is written for each channel in memory, also through a section", async () => {
    await openPost();
    await write("For dev");
    await pressChannel("G2");
    await browser.waitUntil(async () => (await fieldText()) === "");
    await write("For ops");
    await pressChannel();
    await browser.waitUntil(async () => (await fieldText()) === "For dev");
    await showWatch();
    await pressChannel("G2");
    await browser.waitUntil(async () => (await fieldText()) === "For ops");
  });

  it("posts to the channel shown and not to the one left while a post is on its way", async () => {
    await openPost();
    const post = await mock("slack_channel_post", holds);
    await write("Slow one");
    await sendButton().click();
    await waitForCalls(post);
    await pressChannel("G2");
    await browser.waitUntil(async () => (await editable()) === "true");
    await write("Other");
    await expect(sendButton()).toBeDisabled();
    await release(post, true);
    await expect($(".toast")).toHaveText("#dev に投稿しました");
    await expect(sendButton()).toBeEnabled();
    await pressChannel();
    await browser.waitUntil(async () => (await fieldText()) === "");
  });
});

// The Claude pane of the Slack screen (S-24): on the right of the unread list, the watch and a channel's history, not in a thread.
describe("slack list: the Claude pane (S-24)", () => {
  const pane = "#slack-claude";
  const log = "#slack-claude-log";
  const input = () => $("#slack-claude-input");
  const send = () => $("#slack-claude-send");

  async function openPane() {
    await openList(timeline(unreadSample(), { side: sideSample() }));
    await waitForCount("#slack-feed .feed-row", 3);
    await mock("slack_thread", slackThread([threadMessage(slackTs(20), "Alice Example", "first")]));
  }

  // Types `text`, presses the send button and waits until the `replies`th reply is drawn.
  async function ask(text: string, reply: string, replies = 1, draft: string | null = null) {
    const chat = await mock("claude_chat_slack", { reply, draft });
    await input().setValue(text);
    await send().click();
    await waitForCalls(chat);
    await waitForCount(`${log} .chat-ai`, replies);
    return chat;
  }

  it("is open from the start in the unread list and the watch, with a divider that has its range, a band for a head, and a request field framed with the model and the send button", async () => {
    await openPane();
    await expect($(pane)).toBeDisplayed();
    await expect($("#slack-claude-split")).toBeDisplayed();
    await expect($("#slack-claude-split")).toHaveAttribute("aria-label", "Claude の幅");
    await expect($("#slack-claude-split")).toHaveAttribute("aria-valuenow", "30");
    await expect($("#slack-claude-split")).toHaveAttribute("aria-valuemin", "25");
    await expect($("#slack-claude-split")).toHaveAttribute("aria-valuemax", "40");
    await expect($(`${pane} .chat-head`)).toHaveText(expect.stringContaining("Claude"));
    await expect($("#slack-claude-clear")).toHaveText("クリア");
    expect(await count(`${pane} .chat-head > svg`)).toBe(1);
    const head = await browser.execute(() => {
      const style = getComputedStyle(document.querySelector("#slack-claude .chat-head")!);
      return { line: style.borderBottomWidth, filled: style.backgroundColor !== "rgba(0, 0, 0, 0)" };
    });
    expect(head).toEqual({ line: "2px", filled: true });
    await expect(input()).toHaveAttribute("aria-label", "Claude への依頼");
    await browser.waitUntil(async () => (await count("#slack-claude-model select")) === 2);
    const layout = await composerLayout("slack-claude");
    expect(layout.framed).toEqual([true, true, true]);
    expect(layout.modelBelowInput).toBe(true);
    expect(layout.sendRightOfModel).toBe(true);
    expect(layout.sendInsideFrame).toBe(true);
    expect(layout.placeholder).toBeNull();
    await expect(send()).toHaveAttribute("aria-label", "送信");
    // The pane sits at the right of the body.
    const right = await browser.execute(() => document.getElementById("slack-claude")!.getBoundingClientRect().left >= document.getElementById("slack-pane")!.getBoundingClientRect().right);
    expect(right).toBe(true);
    await showWatch();
    await expect($("#slack-claude")).toBeDisplayed();
    await expect($("#slack-claude-split")).toBeDisplayed();
  });

  it("is open in the history of a channel, and gives way to the pane of the thread while a thread is shown", async () => {
    await openPane();
    await mock("slack_channel_history", historySample());
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    await expect($(pane)).toBeDisplayed();
    await $("#sc-feed .feed-thread-open").click();
    await expect($("#slack-thread")).toBeDisplayed();
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#slack-claude-split")).not.toBeDisplayed();
    await expect($("#reply-chat")).toBeDisplayed();
    await $("#st-back").click();
    await expect($("#slack-channel")).toBeDisplayed();
    await expect($(pane)).toBeDisplayed();
    await expect($("#slack-claude-split")).toBeDisplayed();
  });

  it("calls claude_chat_slack with no channel in the unread list and in the watch, and draws the reply with its line breaks", async () => {
    await openPane();
    const chat = await ask("要点を教えて", "1 行目\n2 行目");
    expect(await callsOf(chat)).toEqual([{ channel: null, history: [], instruction: "要点を教えて" }]);
    expect(await textsOf(`${log} .chat-user`)).toEqual(["要点を教えて"]);
    expect(await textsOf(`${log} .chat-ai`)).toEqual(["1 行目\n2 行目"]);
    expect(await count(`${log} .chat-diff, ${log} .chat-task`)).toBe(0);
    await showWatch();
    const again = await ask("もう一度", "二つ目", 2);
    expect(await callsOf(again)).toEqual([
      { channel: null, history: [{ role: "user", text: "要点を教えて" }, { role: "assistant", text: "1 行目\n2 行目" }], instruction: "もう一度" },
    ]);
  });

  it("calls claude_chat_slack with the channel shown and its messages, oldest first, and the channel pressed last", async () => {
    await openPane();
    await mock("slack_channel_history", historySample());
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    const chat = await ask("このチャンネルは?", "dev です");
    expect(await callsOf(chat)).toEqual([
      {
        channel: {
          teamId: workspace.teamId,
          channel: "C0123ABCD",
          messages: [
            { name: "Bob Example", ts: oldTs, text: "old" },
            { name: "Alice Example", ts: firstTs, text: "first" },
            { name: "Carol Example", ts: secondTs, text: "second" },
          ],
        },
        history: [],
        instruction: "このチャンネルは?",
      },
    ]);
    await mock("slack_channel_history", [timelineMessage(slackTs(1), "Alice Example", "ops", "secret", { channel: "G2" })]);
    await pressChannel("G2");
    await waitForText("#sc-feed .feed-text", "secret");
    const other = await ask("こちらは?", "ops です", 2);
    const sent = (await callsOf(other))[0] as { channel: { channel: string; messages: unknown[] } };
    expect(sent.channel.channel).toBe("G2");
    expect(sent.channel.messages).toEqual([{ name: "Alice Example", ts: slackTs(1), text: "secret" }]);
  });

  it("draws no card for an answer without a draft, and shows the draft as text, not as HTML", async () => {
    await openPane();
    await ask("要点を教えて", "答えだけ");
    expect(await count(`${log} .chat-draft`)).toBe(0);
    await ask("書いて", "下書きです", 2, "<b>太字</b>\n二行目");
    expect(await count(`${log} .chat-draft`)).toBe(1);
    expect(await count(`${log} .chat-draft b`)).toBe(0);
    expect(await textsOf(`${log} .chat-draft-text`)).toEqual(["<b>太字</b>\n二行目"]);
    // The list has no post field to put it in: the text only, and no button, in the list and in the watch.
    await expect($(`${log} .chat-draft-put`)).not.toBeDisplayed();
    await showWatch();
    await expect($(`${log} .chat-draft-put`)).not.toBeDisplayed();
  });

  it("puts the draft into the post field of the channel shown when 投稿欄に入れる is pressed, and posts nothing", async () => {
    await openPane();
    await mock("slack_channel_history", historySample());
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    await browser.waitUntil(async () => (await editable()) === "true");
    const post = await mock("slack_channel_post", true);
    await ask("お知らせを書いて", "書きました", 1, "**明日**の予定です");
    await expect($(`${log} .chat-draft-put`)).toBeDisplayed();
    await expect($(`${log} .chat-draft-put`)).toHaveText("投稿欄に入れる");
    await $(`${log} .chat-draft-put`).click();
    await expect($("#sc-input strong")).toHaveText("明日");
    expect(await fieldText()).toBe("明日の予定です");
    await expect(sendButton()).toBeEnabled();
    expect(await callsOf(post)).toEqual([]);
    // The field keeps it for the channel: a section in between does not lose it.
    await showWatch();
    await expect($(`${log} .chat-draft-put`)).not.toBeDisplayed();
    expect(await callsOf(post)).toEqual([]);
    // Only the arrow posts it, as Markdown.
    await mock("slack_channel_history", historySample());
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    expect(await fieldText()).toBe("明日の予定です");
    await sendButton().click();
    expect(await waitForCalls(post)).toEqual([{ teamId: workspace.teamId, channel: "C0123ABCD", text: "**明日**の予定です\n", markdown: true }]);
  });

  it("adds the draft after what the field already holds, with a blank line between, and does not replace it", async () => {
    await openPane();
    await mock("slack_channel_history", historySample());
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    await browser.waitUntil(async () => (await editable()) === "true");
    await write("最初の文");
    await ask("続きを書いて", "書きました", 1, "追加の文");
    await $(`${log} .chat-draft-put`).click();
    await browser.waitUntil(async () => (await count("#sc-input .ProseMirror p")) === 2);
    expect(await textsOf("#sc-input .ProseMirror p")).toEqual(["最初の文", "追加の文"]);
  });

  it("keeps the conversation through the list, a channel and a thread, and forgets it at クリア", async () => {
    await openPane();
    await ask("最初", "答え");
    await mock("slack_channel_history", historySample());
    await pressChannel();
    await waitForCount("#sc-feed .feed-row", 3);
    await $("#sc-feed .feed-thread-open").click();
    await expect($("#slack-thread")).toBeDisplayed();
    await $("#st-back").click();
    expect(await textsOf(`${log} .chat-user`)).toEqual(["最初"]);
    expect(await textsOf(`${log} .chat-ai`)).toEqual(["答え"]);
    await $("#slack-claude-clear").click();
    await $("#slack-claude-clear").click();
    await waitForCount(`${log} > *`, 0);
  });

  it("shows a failure as a line in the log and does not send it with the next request", async () => {
    await openPane();
    await mock("claude_chat_slack", rejects("失敗しました"));
    await input().setValue("一つ目");
    await send().click();
    await waitForText(`${log} .fail`, "送れませんでした");
    const chat = await ask("二つ目", "答え");
    expect(await callsOf(chat)).toEqual([{ channel: null, history: [{ role: "user", text: "一つ目" }], instruction: "二つ目" }]);
  });

  it("turns the field and the send button off while Claude cannot be used, with the note", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: timeline(unreadSample(), { side: sideSample() }), claude_status: { state: "missing" } });
    await $("#nav-slack").click();
    await expect($(pane)).toBeDisplayed();
    await expect($("#slack-claude-chat-note")).toBeDisplayed();
    await expect(input()).toBeDisabled();
    await expect(send()).toBeDisabled();
  });
});
