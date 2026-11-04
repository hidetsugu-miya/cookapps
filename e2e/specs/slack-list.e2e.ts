import { boot, callsOf, claudeReady, count, holds, inbox, mock, ownIcon, pngUri, rejects, release, slackLoad, slackTs, textsOf, timeline, timelineMessage, waitForCalls, waitForCount, waitForText } from "../support";

const iconUrl = "https://avatars.slack-edge.com/T1-U1/a_72.png";

// Two messages, the newest first: the first has two replies.
const sample = () => [
  timelineMessage(slackTs(5, 1), "Alice Example", "dev", "Please review the deploy notes.", { replyCount: 2 }),
  timelineMessage(slackTs(30, 2), "Bob Example", "general", "Lunch at noon."),
];

// `n` messages of two lines each, newest first (the list must be taller than the window to scroll).
const many = (n: number, text = "line one of the message\nline two of the message") =>
  Array.from({ length: n }, (_, i) => timelineMessage(slackTs(i + 1, i), `Person ${i}`, "dev", `${text} ${i}`));

// The app with one workspace whose messages are `messages`, and the Slack screen open.
async function openList(value = timeline(sample()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), slack_load: slackLoad, slack_timeline: value, claude_status: claudeReady, ...fixtures });
  await $("#nav-slack").click();
  await expect($("#slack-list")).toBeDisplayed();
}

const rowTexts = (selector: string) => textsOf(`#slack-feed .feed-row ${selector}`);
const scrollTop = () => browser.execute(() => document.getElementById("slack-feed")!.scrollTop);

describe("slack list", () => {
  it("reads the timeline when the screen is shown and draws a row per message in the order it came", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await callsOf("slack_timeline")).toEqual([null]);
    await expect($("#slack-list h1")).toHaveText("Slack");
    await expect($("#slack-list .header-sub")).toHaveText("新しい順に 20 件");
    expect(await rowTexts(".feed-meta b")).toEqual(["Alice Example", "Bob Example"]);
    expect(await rowTexts(".feed-meta span")).toEqual(["#dev", "#general"]);
    expect(await rowTexts(".feed-text")).toEqual(["Please review the deploy notes.", "Lunch at noon."]);
    for (const date of await rowTexts(".feed-date")) expect(date).toMatch(/^(\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日)$/);
  });

  it("draws a row as a real button, with the text cut at two lines and no hover actions", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    const row = await browser.execute(() => {
      const r = document.querySelector<HTMLElement>("#slack-feed .feed-row")!;
      return { tag: r.tagName, clamp: getComputedStyle(r.querySelector(".feed-text")!).getPropertyValue("-webkit-line-clamp"), buttons: r.querySelectorAll("button").length };
    });
    expect(row).toEqual({ tag: "BUTTON", clamp: "2", buttons: 0 });
  });

  it("shows 返信 N 件 only for a message that has replies", async () => {
    await openList();
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await textsOf("#slack-feed .feed-replies")).toEqual(["返信 2 件"]);
    expect(await count("#slack-feed .feed-row:nth-child(2) .feed-replies")).toBe(0);
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
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    const read = await mock("slack_timeline", holds);
    await $("#nav-slack").click();
    await waitForCalls(read);
    await expect($("#slack-feed .spin")).toBeDisplayed();
    expect(await count("#slack-feed .feed-row")).toBe(0);
    await release(read, timeline(sample()));
    await waitForCount("#slack-feed .feed-row", 2);
    expect(await count("#slack-feed .spin")).toBe(0);
  });

  it("says that the read failed when there is nothing to show, and reads again from 再読み込み", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    await mock("slack_timeline", rejects("接続できません"));
    await $("#nav-slack").click();
    await expect($("#slack-feed .pending.fail")).toHaveText(expect.stringContaining("読み込めませんでした: 接続できません"));
    await mock("slack_timeline", timeline(sample()));
    await $("#slack-feed .pending.fail .text-btn").click();
    await waitForCount("#slack-feed .feed-row", 2);
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
    await mock("slack_timeline", timeline([timelineMessage(slackTs(0), "New Person", "dev", "A new message"), ...many(19)], { refreshSecs: 1 }));
    await waitForText("#slack-feed .feed-meta b", "New Person");
    expect(await count("#slack-feed .feed-row")).toBe(20);
    expect(await scrollTop()).toBe(300);
    await expect($("#slack-list")).toBeDisplayed();
  });

  it("stops reading when another screen is shown, and reads at once when the screen is shown again", async () => {
    await openList(timeline(sample(), { refreshSecs: 1 }));
    await waitForCount("#slack-feed .feed-row", 2);
    await $("#nav-todo").click();
    await expect($("#todo")).toBeDisplayed();
    const before = (await callsOf("slack_timeline")).length;
    await browser.pause(2500);
    expect((await callsOf("slack_timeline")).length).toBe(before);
    await $("#nav-slack").click();
    await waitForCalls("slack_timeline", before + 1);
  });

  it("draws only the answer of the latest read", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    await mock("slack_timeline", rejects("接続できません"));
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
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    const read = await mock("slack_timeline", holds);
    await $("#nav-slack").click();
    await waitForCalls(read);
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
});
