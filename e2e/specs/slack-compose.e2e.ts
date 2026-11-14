import {
  boot, callsOf, claudeKeyReady, claudeLoggedOut, claudeReady, claudeSettings, composerLayout, count, holds, inbox, mock, onceId, proofreadEdit, rejects, release, rowOf, slackChannels, slackLoad, slackPreview, textsOf, threadDetail, threadLoaded, waitForCalls, waitForCount, workspace,
} from "../support";
import type { SlackAction } from "../../ts/bindings/SlackAction";
import type { Target } from "../../ts/bindings/Target";

const body = () => $("#slack-body");
const previewBox = () => $("#slack-preview");
const post = () => $("#slack-post");
// The cards of "行うこと", and the parts of the `n`th one (from 1): the chip of where it goes, the chip that says it pastes the original message, and the field of a written text.
const cards = "#slack-actions > li";
const card = (n: number) => $(`${cards}:nth-child(${n})`);
const where = (n: number) => card(n).$(".slack-where");
const what = (n: number) => card(n).$(".slack-what");
const written = (n: number) => card(n).$("textarea");
const add = () => $("#slack-add");
// The destination chip of the first thing to do.
const target = () => where(1);
// What `slack_post` answers: the time of the posted message.
const postedTs = "1761785520.000100";
// The destination of `slackChannels` as Rust answers it when Claude chose it (S-4).
const general: Target = { teamId: "T1", channel: "C0123ABCD", name: "general", threadTs: null };
// A thing to do as the screen sends it and Rust answers it: one that pastes the original message to `target` (`byClaude`: a destination that Claude's answer put there),
// one that writes `text` in the thread of the one at `after` (from 0), and `action` once it was posted with `thread` as the thread a later one continues.
const pasteTo = (target: Target | null, byClaude = false): SlackAction => ({ target, after: null, paste: true, text: "", posted: null, byClaude });
const writeAfter = (after: number, text: string): SlackAction => ({ target: null, after, paste: false, text, posted: null, byClaude: false });
const postedAt = (action: SlackAction, thread: string): SlackAction => ({ ...action, posted: { teamId: "T1", channel: "C0123ABCD", name: "general", thread } });

// The app with a mail opened and "Slack に貼る" pressed; `claude` is what `claude_status` answers. `first` is the mail's text.
async function openCompose(claude: unknown = claudeReady, first = "Hello from Alice") {
  await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claude });
  await waitForCount("#unread-threads li", 2);
  await openMail("First unread", first);
  return pressSlack();
}

// Opens the thread of the unread row `subject` (its detail says it is read already, so nothing is marked).
async function openMail(subject: string, text: string) {
  await mock("thread", threadDetail(subject, text, false));
  await rowOf("unread-threads", subject).$(".subject").click();
  await expect($("#thread-subject")).toHaveText(subject);
  await threadLoaded();
}

// Presses "Slack に貼る"; `slack_preview` answers `preview`. Returns the handle of `slack_preview`.
async function pressSlack(preview = slackPreview) {
  const call = await mock("slack_preview", preview);
  // A click at the button's place on the screen, not `click()`: WebDriver scrolls the element it is given to the place a sticky row has when it is not stuck (the scroll of 400 became 47), and a user's click does not move the page.
  const at = await browser.execute(() => {
    const r = document.getElementById("thread-slack")!.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await browser.action("pointer").move({ origin: "viewport", ...at }).down().up().perform();
  await expect($("#slack-compose")).toBeDisplayed();
  return call;
}

// Picks "#general" of the only workspace in the destination picker of the `n`th thing to do.
async function chooseGeneral(n = 1) {
  await mock("slack_channels", slackChannels);
  await where(n).click();
  const channel = $("//div[contains(@class, 'slack-pop')]//button[normalize-space()='#general']");
  await channel.waitForExist();
  await channel.click();
  await expect(where(n)).toHaveText("Example Team ・ #general");
}

// Back to the list from the sidebar and into the thread of another unread row.
async function openOtherMail(subject: string, text: string) {
  await $("#nav-mail").click();
  await expect($("#threads")).toBeDisplayed();
  await openMail(subject, text);
}

// Types `text` into the edit field, which the preview opens when it is pressed.
async function setBody(text: string) {
  if (await previewBox().isDisplayed()) await previewBox().click();
  await expect(body()).toBeDisplayed();
  await body().setValue(text);
}

// Sends "校正してください" the way the owner types it (there is no button for it).
async function askProofread() {
  await $("#slack-input").setValue("校正してください");
  await $("#slack-send").click();
}

// The "元に戻す" of an answer that was put into the preview at once.
const undoButton = () => $("#slack-log .diff-foot .text-btn");

describe("slack compose screen", () => {
  it("opens from the thread with the mail's text in the edit field and no field for a note", async () => {
    const preview = await openCompose();
    expect(await callsOf(preview)).toEqual([
      { subject: "First unread", from: "Alice <alice@example.com>", date: expect.any(String), body: "Hello from Alice" },
    ]);
    await expect(body()).toHaveValue(slackPreview);
    await expect(body()).toBeEnabled();
    // The preview shows the text, and the edit field is closed until the preview is pressed.
    await expect(previewBox()).toBeDisplayed();
    await expect(previewBox()).toHaveText(slackPreview);
    await expect(body()).not.toBeDisplayed();
    await expect($("#slack-subject")).toHaveText("First unread");
    await expect($("#slack-compose h1")).toHaveText("Slack に貼る");
    await expect($("#slack-back")).toHaveText(expect.stringContaining("メールに戻る"));
    expect(await count('[aria-label="ひとこと"], [placeholder*="ひとこと"]')).toBe(0);
    expect(await count("#slack-edit textarea")).toBe(1);
    // The original message is at the top, and under it one thing to do: paste it, to a destination that is not chosen.
    await expect($("#slack-edit-head .prompt-label")).toHaveText("元のメッセージ");
    await expect(previewBox()).toHaveAttribute("aria-label", "元のメッセージ");
    await waitForCount(cards, 1);
    await expect(card(1).$(".slack-no")).toHaveText("1");
    await expect(where(1)).toHaveText("選んでください");
    await expect(what(1)).toHaveAttribute("aria-pressed", "true");
    expect(await count(`${cards} .slack-remove`)).toBe(0);
    await expect(post()).toHaveText("投稿");
    expect(await browser.execute(() => document.getElementById("slack-edit-body")!.getBoundingClientRect().bottom <= document.getElementById("slack-actions-pane")!.getBoundingClientRect().top)).toBe(true);
    // No field of the left pane has a placeholder.
    expect(await count("#slack-edit [placeholder]")).toBe(0);
    await expect($("#thread")).not.toBeDisplayed();
    await expect($("#mail-header")).not.toBeDisplayed();
    await expect($("#nav-mail")).toHaveAttribute("aria-current", "page");
  });

  it("makes the header a place to drag the window by", async () => {
    await openCompose();
    await expect($("#slack-compose > header")).toHaveAttribute("data-tauri-drag-region", "deep");
  });

  it("asks for the workspace in settings and stays on the mail when there is none", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCount("#unread-threads li", 2);
    await openMail("First unread", "Hello from Alice");
    const preview = await mock("slack_preview", slackPreview);
    await $("#thread-slack").click();
    await expect($(".toast")).toHaveText(expect.stringContaining("Slack のワークスペースを設定で追加してください"));
    await expect($("#thread")).toBeDisplayed();
    await expect($("#slack-compose")).not.toBeDisplayed();
    expect(await callsOf(preview)).toEqual([]);
  });

  it("opens the settings on the Slack tab from 設定を開く in that notice", async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCount("#unread-threads li", 2);
    await openMail("First unread", "Hello from Alice");
    await mock("slack_preview", slackPreview);
    await $("#thread-slack").click();
    await $(".toast").$("button=設定を開く").click();
    await expect($("#settings")).toBeDisplayed();
    await expect($("#settings-tab-slack")).toHaveAttribute("aria-selected", "true");
    await expect($("#settings-panel-slack")).toBeDisplayed();
    await expect($("#settings-panel-google")).not.toBeDisplayed();
  });

  it("does not pick a destination by itself, so 投稿 stays disabled until one is chosen", async () => {
    await openCompose();
    await expect(target()).toHaveText("選んでください");
    await expect(post()).toBeDisabled();
    await chooseGeneral();
    await expect(post()).toBeEnabled();
    // A blank text cannot be posted either.
    await setBody(" ");
    await expect(post()).toBeDisabled();
  });

  it("opens the edit field when the preview is pressed, and posts the edited text with 投稿 as `text`", async () => {
    await openCompose();
    await chooseGeneral();
    await previewBox().click();
    await expect(body()).toBeDisplayed();
    await expect(previewBox()).not.toBeDisplayed();
    await body().setValue("Edited *text* of the post");
    const slackPost = await mock("slack_post", postedTs);
    await post().click();
    expect(await waitForCalls(slackPost)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: "Edited *text* of the post", written: false },
    ]);
    await expect($(".toast")).toHaveText("Example Team の #general に貼りました");
    // The screen stays: the card says it is posted and cannot be changed or sent again, and the text is kept.
    await expect(card(1).$(".slack-done")).toHaveText("投稿済み");
    await expect($("#slack-compose")).toBeDisplayed();
    await expect($("#thread")).not.toBeDisplayed();
    await expect(where(1)).toBeDisabled();
    await expect(what(1)).toBeDisabled();
    await expect(post()).toBeDisabled();
    await expect(body()).toHaveValue("Edited *text* of the post");
    // Only "メールに戻る" goes back, and the same mail finds the posted card again.
    await $("#slack-back").click();
    await expect($("#thread")).toBeDisplayed();
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(card(1).$(".slack-done")).toHaveText("投稿済み");
    expect(await callsOf(slackPost)).toHaveLength(1);
  });

  it("adds a thing to do with the plus, which goes on in the thread of the one before with an empty text of its own, and takes it out again", async () => {
    await openCompose();
    await add().click();
    await waitForCount(cards, 2);
    await expect(card(2).$(".slack-no")).toHaveText("2");
    await expect(where(2)).toHaveText("1 のスレッド");
    await expect(what(2)).toHaveAttribute("aria-pressed", "false");
    await expect(written(2)).toHaveValue("");
    await expect(written(2)).toHaveAttribute("aria-label", "文面");
    await expect(written(2)).not.toHaveAttribute("placeholder");
    await expect(post()).toHaveText("2 件を投稿");
    // The first one cannot be taken out; the second can.
    expect(await count(`${cards}:nth-child(1) .slack-remove`)).toBe(0);
    await expect(card(2).$(".slack-remove")).toHaveAttribute("aria-label", "消す");
    await card(2).$(".slack-remove").click();
    await waitForCount(cards, 1);
    await expect(post()).toHaveText("投稿");
  });

  it("turns the plus off at 10 things to do that are not posted, and on again when one is taken out", async () => {
    await openCompose();
    for (let n = 2; n <= 10; n++) {
      await expect(add()).toBeEnabled();
      await add().click();
      await waitForCount(cards, n);
    }
    await expect(add()).toBeDisabled();
    await card(10).$(".slack-remove").click();
    await waitForCount(cards, 9);
    await expect(add()).toBeEnabled();
  });

  it("keeps 投稿 off until every thing to do has somewhere to go and a text", async () => {
    await openCompose();
    await chooseGeneral();
    await expect(post()).toBeEnabled();
    await add().click();
    // The new one has no text yet.
    await expect(post()).toBeDisabled();
    await written(2).setValue("ご確認ください");
    await expect(post()).toBeEnabled();
    // The original message can be pasted there instead, which needs no text of the card.
    await written(2).setValue("");
    await expect(post()).toBeDisabled();
    await what(2).click();
    await expect(what(2)).toHaveAttribute("aria-pressed", "true");
    expect(await count(`${cards}:nth-child(2) textarea`)).toBe(0);
    await expect(post()).toBeEnabled();
  });

  it("posts a word to the channel and then the original message in its thread, in one press, the second as a reply to the time the first answered", async () => {
    await openCompose();
    await chooseGeneral();
    // The first: a written word to the channel. The second: the original message, in the thread of the first.
    await what(1).click();
    await written(1).setValue("@here 共有します");
    await add().click();
    await expect(where(2)).toHaveText("1 のスレッド");
    await what(2).click();
    await expect(post()).toHaveText("2 件を投稿");
    const slackPost = await mock("slack_post", postedTs);
    await post().click();
    expect(await waitForCalls(slackPost, 2)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: "@here 共有します", written: true },
      { teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: slackPreview, written: false },
    ]);
    await expect($(".toast")).toHaveText("2 件を投稿しました");
    await waitForCount(`${cards} .slack-done`, 2);
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(post()).toBeDisabled();
    await expect(post()).toHaveText("投稿");
    // One more can be added after that: it goes on in the same thread, and only it is sent.
    await add().click();
    await expect(where(3)).toHaveText("2 のスレッド");
    await written(3).setValue("以上です");
    await expect(post()).toHaveText("投稿");
    await mock("slack_post", "1761785999.000200");
    await post().click();
    expect(await waitForCalls("slack_post")).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: "以上です", written: true },
    ]);
    await waitForCount(`${cards} .slack-done`, 3);
  });

  it("chooses the thread of an earlier post, or a channel of its own, in the picker of a later thing to do", async () => {
    await openCompose();
    await chooseGeneral();
    await add().click();
    await add().click();
    await expect(where(3)).toHaveText("2 のスレッド");
    await mock("slack_channels", slackChannels);
    await where(3).click();
    const first = $("//div[contains(@class, 'slack-pop')]//button[normalize-space()='1 のスレッド']");
    await first.waitForExist();
    expect(await textsOf(".slack-pop .pick-list:first-of-type button")).toEqual(["1 のスレッド", "2 のスレッド"]);
    await first.click();
    await expect(where(3)).toHaveText("1 のスレッド");
    // The first thing to do has no post before it.
    await where(1).click();
    await $(".slack-pop").waitForExist();
    expect((await textsOf(".slack-pop button")).filter((t) => t.includes("のスレッド"))).toEqual([]);
    await $("//div[contains(@class, 'slack-pop')]//button[normalize-space()='#general']").click();
    await expect($(".slack-pop")).not.toExist();
    // A channel of its own instead of a thread.
    await chooseGeneral(2);
    // The second is taken out: the third moves up and still follows the first.
    await card(2).$(".slack-remove").click();
    await waitForCount(cards, 2);
    await expect(where(2)).toHaveText("1 のスレッド");
  });

  it("stops at the post that fails, marks what was sent as posted, and sends only the rest at the next press", async () => {
    await openCompose();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    const slackPost = await mock("slack_post", holds);
    await post().click();
    await waitForCalls(slackPost);
    // While the posts are on their way nothing of the cards can be changed.
    await expect(where(1)).toBeDisabled();
    await expect(written(2)).toBeDisabled();
    await expect(add()).toBeDisabled();
    await release(slackPost, postedTs);
    await waitForCalls(slackPost, 2);
    await release(slackPost, rejects("チャンネルに投稿する権限がありません"));
    await expect($("#slack-error")).toHaveText(expect.stringContaining("チャンネルに投稿する権限がありません"));
    await expect(card(1).$(".slack-done")).toHaveText("投稿済み");
    expect(await count(`${cards}:nth-child(2) .slack-done`)).toBe(0);
    await expect(written(2)).toHaveValue("補足です");
    await expect(written(2)).toBeEnabled();
    await expect(post()).toBeEnabled();
    await expect(post()).toHaveText("投稿");
    // The next press sends the second one only, to the thread of the first.
    const again = await mock("slack_post", "1761785999.000200");
    await post().click();
    expect(await waitForCalls(again)).toEqual([{ teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: "補足です", written: true }]);
    await waitForCount(`${cards} .slack-done`, 2);
    await expect($("#slack-error")).not.toBeDisplayed();
  });

  it("replies in the chosen thread itself when a later thing to do follows a post that went into a thread", async () => {
    await openCompose();
    await mock("claude_proofread_slack", { reply: "スレッドにしました", body: null, diff: [], actions: [pasteTo({ ...general, threadTs: "1761700000.000001" }, true)] });
    await askProofread();
    await expect(where(1)).toHaveText("Example Team ・ #general（スレッド）");
    await add().click();
    await written(2).setValue("続きです");
    const slackPost = await mock("slack_post", postedTs);
    await post().click();
    expect(((await waitForCalls(slackPost, 2)) as { threadTs: string | null }[]).map((c) => c.threadTs)).toEqual(["1761700000.000001", "1761700000.000001"]);
  });

  it("shows a failed post on the screen and keeps the text and the destination", async () => {
    await openCompose();
    await chooseGeneral();
    await setBody("Keep me");
    await mock("slack_post", rejects("チャンネルに投稿する権限がありません"));
    await post().click();
    await expect($("#slack-error")).toHaveText(expect.stringContaining("チャンネルに投稿する権限がありません"));
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(body()).toHaveValue("Keep me");
    await expect(target()).toHaveText("Example Team ・ #general");
    await expect(post()).toBeEnabled();
  });

  it("goes back to the mail without fetching it again, keeps the draft for the same mail, and starts anew for another", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    await waitForCount("#unread-threads li", 2);
    const long = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    await openMail("First unread", long);
    const thread = "thread";
    const scroll = () => browser.execute(() => document.getElementById("main")!.scrollTop);
    await browser.execute(() => {
      document.getElementById("main")!.scrollTop = 400;
    });
    const scrolled = await scroll();
    expect(scrolled).toBeGreaterThan(0);
    const preview = await pressSlack();
    await chooseGeneral();
    await setBody("Draft of the first mail");
    await $("#slack-back").click();
    await expect($("#thread")).toBeDisplayed();
    await expect($("#thread-subject")).toHaveText("First unread");
    await threadLoaded();
    // The thread was not fetched again, and it is where it was scrolled to.
    expect(await callsOf(thread)).toHaveLength(1);
    await browser.waitUntil(async () => (await scroll()) === scrolled, { timeoutMsg: "the scroll position was not restored" });
    // The same mail again: the draft is there, and the mail's text is not asked for again.
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(body()).toHaveValue("Draft of the first mail");
    await expect(target()).toHaveText("Example Team ・ #general");
    expect(await callsOf(preview)).toHaveLength(1);
    // The things to do are kept with it.
    await add().click();
    await written(2).setValue("Kept word");
    await $("#slack-back").click();
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(written(2)).toHaveValue("Kept word");
    // Another mail: a new draft, made from its text (`pressSlack` mocks `slack_preview` again, which forgets the earlier calls, so the one call is the new draft's).
    await openOtherMail("Second unread", "Another text");
    const again = await pressSlack();
    await expect(body()).toHaveValue(slackPreview);
    await expect(target()).toHaveText("選んでください");
    await waitForCount(cards, 1);
    expect(await callsOf(again)).toHaveLength(1);
    await expect($("#slack-log .chat-user")).not.toExist();
  });

  it("restores the scroll position of an HTML mail, whose frame must keep its height while the thread is hidden", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    await waitForCount("#unread-threads li", 2);
    const base = threadDetail("First unread", "", false);
    const [first] = base.messages;
    const lines = Array.from({ length: 300 }, (_, i) => `<p>line ${i + 1}</p>`).join("");
    await mock("thread", { ...base, messages: [{ ...first, html: true, authenticated: true, body: lines }] });
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("First unread");
    await threadLoaded();
    const frameHeight = () => browser.execute(() => document.querySelector<HTMLIFrameElement>("#messages iframe")?.getBoundingClientRect().height ?? 0);
    const scroll = () => browser.execute(() => document.getElementById("main")!.scrollTop);
    await browser.waitUntil(async () => (await frameHeight()) > 2000, { timeoutMsg: "the frame was not sized to the mail" });
    const tall = await frameHeight();
    await browser.execute(() => {
      document.getElementById("main")!.scrollTop = 400;
    });
    const scrolled = await scroll();
    expect(scrolled).toBeGreaterThan(0);
    await pressSlack();
    await $("#slack-back").click();
    await expect($("#thread")).toBeDisplayed();
    await browser.waitUntil(async () => (await scroll()) === scrolled, { timeoutMsg: "the scroll position of the HTML mail was not restored" });
    expect(await frameHeight()).toBe(tall);
  });

  it("empties the destination when its workspace is gone by the time the draft is opened again", async () => {
    await openCompose();
    await chooseGeneral();
    await $("#slack-back").click();
    await expect($("#thread")).toBeDisplayed();
    await mock("slack_load", { workspaces: [{ ...workspace, teamId: "T2", team: "Other Team" }], recent: [] });
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(target()).toHaveText("選んでください");
    await expect(post()).toBeDisabled();
  });

  it("locks the edit field and 元に戻す while the post is on its way, and frees them when it fails", async () => {
    await openCompose();
    await chooseGeneral();
    await mock("claude_proofread_slack", proofreadEdit);
    await askProofread();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(undoButton()).toBeEnabled();
    const slackPost = await mock("slack_post", holds);
    await post().click();
    await waitForCalls(slackPost);
    await expect(body()).toBeDisabled();
    await expect(undoButton()).toBeDisabled();
    // A request to Claude could post the same text again, so the field waits too.
    await expect($("#slack-input")).toBeDisabled();
    await expect($("#slack-send")).toBeDisabled();
    expect(await count("#slack-log .diff-stale")).toBe(0);
    await release(slackPost, rejects("チャンネルに投稿する権限がありません"));
    await expect($("#slack-error")).toHaveText(expect.stringContaining("チャンネルに投稿する権限がありません"));
    await expect(body()).toBeEnabled();
    await expect(undoButton()).toBeEnabled();
    await expect($("#slack-input")).toBeEnabled();
  });

  it("stays on another mail's compose screen when an earlier post finishes", async () => {
    await openCompose();
    await chooseGeneral();
    const slackPost = await mock("slack_post", holds);
    await post().click();
    await waitForCalls(slackPost);
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    await expect($("#slack-subject")).toHaveText("Second unread");
    await release(slackPost, postedTs);
    await expect($(".toast")).toHaveText("Example Team の #general に貼りました");
    await expect($("#slack-compose")).toBeDisplayed();
    await expect($("#thread")).not.toBeDisplayed();
    await expect($("#slack-subject")).toHaveText("Second unread");
    await expect(target()).toHaveText("選んでください");
    // The other mail's card is not the posted one.
    expect(await count(`${cards} .slack-done`)).toBe(0);
  });

  it("tells a post that failed after the screen was left with a toast", async () => {
    await openCompose();
    await chooseGeneral();
    const slackPost = await mock("slack_post", holds);
    await post().click();
    await waitForCalls(slackPost);
    await $("#nav-mail").click();
    await expect($("#threads")).toBeDisplayed();
    await release(slackPost, rejects("チャンネルに投稿する権限がありません"));
    await expect($(".toast")).toHaveText("Example Team の #general に貼れませんでした: チャンネルに投稿する権限がありません");
    await expect($("#threads")).toBeDisplayed();
  });

  it("does not switch to the compose screen when another mail was opened while Slack was loading", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, claude_status: claudeReady });
    await waitForCount("#unread-threads li", 2);
    await openMail("First unread", "Hello from Alice");
    const load = await mock("slack_load", holds);
    const preview = await mock("slack_preview", slackPreview);
    await $("#thread-slack").click();
    await waitForCalls(load);
    await openOtherMail("Second unread", "Another text");
    await release(load, slackLoad);
    // Give a wrongly kept answer the time to switch the screen.
    await browser.pause(300);
    await expect($("#thread")).toBeDisplayed();
    await expect($("#thread-subject")).toHaveText("Second unread");
    await threadLoaded();
    await expect($("#slack-compose")).not.toBeDisplayed();
    expect(await callsOf(preview)).toEqual([]);
    // The second mail then opens its own compose screen.
    await mock("slack_load", slackLoad);
    await pressSlack();
    await expect($("#slack-subject")).toHaveText("Second unread");
    await expect(body()).toHaveValue(slackPreview);
  });

  it("returns to the list when the sidebar's inbox button is pressed", async () => {
    await openCompose();
    await $("#nav-mail").click();
    await expect($("#threads")).toBeDisplayed();
    await expect($("#slack-compose")).not.toBeDisplayed();
    await expect($("#nav-mail")).toHaveAttribute("aria-current", "page");
  });

  it("puts the original text back with two presses of 元の内容に戻す, and has nothing to put back while unedited", async () => {
    await openCompose();
    await expect($("#slack-reset")).toBeDisabled();
    await setBody("My own text");
    await expect($("#slack-reset")).toBeEnabled();
    await $("#slack-reset").click();
    await expect($("#slack-reset")).toHaveText("もう一度押すと戻す");
    await expect(body()).toHaveValue("My own text");
    await $("#slack-reset").click();
    await expect(body()).toHaveValue(slackPreview);
    await expect($("#slack-reset")).toHaveText("元の内容に戻す");
    await expect($("#slack-reset")).toBeDisabled();
  });
});

describe("slack compose screen: proofreading with Claude", () => {
  it("has a head of the mark and クリア only, the diff card without コピー, no 校正する button, and the round send button with the selects in the frame", async () => {
    await openCompose();
    await chooseGeneral();
    await expect($("#slack-chat")).toHaveAttribute("aria-label", "Claude");
    // The head holds no words of its own: the mark and "クリア".
    await expect($("#slack-chat .chat-head")).toHaveText("クリア");
    expect(await count("#slack-chat .chat-head > svg")).toBe(1);
    expect(await browser.execute(() => document.getElementById("slack-compose")!.textContent!.includes("Claude と校正"))).toBe(false);
    // There is no 校正する button: the form holds only the frame of the field.
    expect(await count("#slack-proofread, .proofread-row")).toBe(0);
    expect(await textsOf("#slack-compose button")).not.toContain("校正する");
    expect(await count("#slack-form > *")).toBe(1);
    await expect($("#slack-input")).toHaveAttribute("aria-label", "Claude への依頼");
    await expect($("#slack-input")).not.toHaveAttribute("placeholder");
    // The keys are not told (and still work: see the spec of Cmd+Enter below).
    expect(await count("#slack-keys, #slack-form .composer-hint")).toBe(0);
    await expect($("#slack-send")).toHaveAttribute("aria-label", "送信");
    await expect($("#slack-send")).toHaveText("");
    expect(await count("#slack-send svg")).toBe(1);
    expect(await composerLayout("slack")).toEqual({ framed: [true, true, true], modelBelowInput: true, sendRightOfModel: true, sendInsideFrame: true, sendRadius: "50%", placeholder: null });
    await mock("claude_proofread_slack", proofreadEdit);
    await askProofread();
    await waitForCount("#slack-log .chat-ai", 1);
    expect(await textsOf("#slack-log .diff-foot .text-btn")).toEqual(["元に戻す"]);
    // The answer text keeps its look: the line breaks of an answer are not kept here.
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#slack-log .chat-ai")!).whiteSpace)).toBe("normal");
  });

  it("shows the model and effort of the proofreading in the frame of the request field, Sonnet and medium by default, and saves a change as proofread", async () => {
    await openCompose();
    const model = $('#slack-model select[data-kind="model"]');
    const effort = $('#slack-model select[data-kind="effort"]');
    await expect(model).toHaveValue("sonnet");
    await expect(effort).toHaveValue("medium");
    await expect(effort).toHaveAttribute("data-effort", "medium");
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#slack-model select")!).borderTopWidth)).toBe("0px");
    const save = await mock("claude_model_settings_save", { ...claudeSettings, proofread: { model: "opus", effort: "medium" } });
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      const select = document.querySelector<HTMLSelectElement>('#slack-model select[data-kind="model"]')!;
      select.value = "opus";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, onceId());
    expect(await waitForCalls(save)).toEqual([{ purpose: "proofread", model: "opus" }]);
    await expect(model).toHaveValue("opus");
  });

  it("sends 校正してください with the text, and the answer changes the preview and the edit field at once without posting", async () => {
    await openCompose();
    await chooseGeneral();
    const slackPost = await mock("slack_post", postedTs);
    const edit = await mock("claude_proofread_slack", proofreadEdit);
    await askProofread();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "校正してください", actions: [pasteTo(general)] }]);
    await waitForCount("#slack-log .chat-ai", 1);
    await expect($("#slack-log .chat-user")).toHaveText("校正してください");
    await expect(body()).toHaveValue(proofreadEdit.body as string);
    await expect(previewBox()).toHaveText(proofreadEdit.body as string);
    // The log keeps the number of changed lines and 元に戻す, not the diff and 適用.
    await expect($("#slack-log .diff-count")).toHaveText("1 行を変えました");
    expect(await textsOf("#slack-log .diff-foot .text-btn")).toEqual(["元に戻す"]);
    expect(await count("#slack-log .diff-ins, #slack-log .diff-del")).toBe(0);
    expect(await callsOf(slackPost)).toEqual([]);
    await expect($("#slack-compose")).toBeDisplayed();
  });

  it("puts the text from before the answer back with 元に戻す", async () => {
    await openCompose();
    await mock("claude_proofread_slack", proofreadEdit);
    await askProofread();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(body()).toHaveValue(proofreadEdit.body as string);
    await undoButton().click();
    await expect(body()).toHaveValue(slackPreview);
    await expect(previewBox()).toHaveText(slackPreview);
    await expect($("#slack-log .diff-state")).toHaveText("元に戻しました");
    expect(await count("#slack-log .diff-foot .text-btn")).toBe(0);
  });

  it("puts the destination Claude chose into the chip, with the text it changed, and posts nothing", async () => {
    await openCompose();
    await expect(target()).toHaveText("選んでください");
    const slackPost = await mock("slack_post", postedTs);
    const edit = await mock("claude_proofread_slack", { ...proofreadEdit, actions: [pasteTo(general, true)] });
    await askProofread();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "校正してください", actions: [pasteTo(null)] }]);
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(target()).toHaveText("Example Team ・ #general");
    await expect(post()).toBeEnabled();
    await expect(body()).toHaveValue(proofreadEdit.body as string);
    expect(await callsOf(slackPost)).toEqual([]);
  });

  it("tells Rust that the destination in the chip is Claude's until the owner chooses one", async () => {
    await openCompose();
    await mock("claude_proofread_slack", { ...proofreadEdit, actions: [pasteTo(general, true)] });
    await $("#slack-input").setValue("貼り先を決めて");
    await $("#slack-send").click();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(target()).toHaveText("Example Team ・ #general");
    const sent = async () => ((await waitForCalls("claude_proofread_slack")) as { actions: SlackAction[] }[]).map((c) => c.actions);
    await mock("claude_proofread_slack", { ...proofreadEdit, body: null, diff: [], actions: null });
    await $("#slack-input").setValue("もう一度");
    await $("#slack-send").click();
    expect(await sent()).toEqual([[pasteTo(general, true)]]);
    await waitForCount("#slack-log .chat-ai", 2);
    // The owner chooses the same destination: it is theirs.
    await chooseGeneral();
    await mock("claude_proofread_slack", { ...proofreadEdit, body: null, diff: [], actions: null });
    await $("#slack-input").setValue("さらにもう一度");
    await $("#slack-send").click();
    expect(await sent()).toEqual([[pasteTo(general)]]);
  });

  it("marks the one thing to do as posted when the answer says Rust posted, without posting from the screen, and stays open", async () => {
    await openCompose();
    const slackPost = await mock("slack_post", postedTs);
    const edit = await mock("claude_proofread_slack", {
      reply: "投稿しました",
      body: proofreadEdit.body,
      diff: proofreadEdit.diff,
      actions: [postedAt(pasteTo(general, true), postedTs)],
      postError: null,
    });
    await $("#slack-input").setValue("#general に要点だけ投稿して");
    await $("#slack-send").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "#general に要点だけ投稿して", actions: [pasteTo(null)] }]);
    await expect($(".toast")).toHaveText("Example Team の #general に貼りました");
    // The screen stays, the card is the posted one with the destination Rust posted to, and the answer is in the conversation.
    await waitForCount("#slack-log .chat-ai", 1);
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(card(1).$(".slack-done")).toHaveText("投稿済み");
    await expect(where(1)).toHaveText("Example Team ・ #general");
    await expect(body()).toHaveValue(proofreadEdit.body as string);
    await expect(post()).toBeDisabled();
    // Rust posted: the screen calls no post of its own.
    expect(await callsOf(slackPost)).toEqual([]);
    // A thing to do added after it goes on in the thread of that post, by the time the answer carried.
    await add().click();
    await written(2).setValue("補足です");
    await post().click();
    expect(await waitForCalls(slackPost)).toEqual([{ teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: "補足です", written: true }]);
    // A later request tells Rust which things to do are posted, and where.
    await waitForCount(`${cards} .slack-done`, 2);
    await mock("claude_proofread_slack", { ...proofreadEdit, body: null, diff: [], actions: null });
    await $("#slack-input").setValue("もう一度投稿して");
    await $("#slack-send").click();
    expect(((await waitForCalls("claude_proofread_slack")) as { actions: SlackAction[] }[]).map((c) => c.actions)).toEqual([
      [postedAt(pasteTo(general, true), postedTs), postedAt(writeAfter(0, "補足です"), postedTs)],
    ]);
    await waitForCount("#slack-log .chat-ai", 2);
    await expect(where(1)).toHaveText("Example Team ・ #general");
  });

  it("sends the things to do with a request, a written text with its words", async () => {
    await openCompose();
    await chooseGeneral();
    const edit = await mock("claude_proofread_slack", { ...proofreadEdit, body: null, diff: [], actions: null });
    await add().click();
    await written(2).setValue("補足です");
    await $("#slack-input").setValue("この内容で投稿して");
    await $("#slack-send").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "この内容で投稿して", actions: [pasteTo(general), writeAfter(0, "補足です")] }]);
    await waitForCount("#slack-log .chat-ai", 1);
    // An answer that leaves the things to do alone changes no card.
    expect(await count(cards)).toBe(2);
    await expect(written(2)).toHaveValue("補足です");
  });

  it("puts the things to do that Claude wrote into the cards, posts nothing, and 投稿 sends them in order", async () => {
    await openCompose();
    await chooseGeneral();
    const greeting = "@here お疲れ様です。こちらお願いできますでしょうか？";
    const request = `${greeting} とメッセージを打ったあと、メールの内容をそのスレッド内に貼り付けたいです`;
    const slackPost = await mock("slack_post", postedTs);
    const edit = await mock("claude_proofread_slack", {
      reply: "行うことを 2 件にしました",
      body: null,
      diff: [],
      actions: [{ ...pasteTo(general), paste: false, text: greeting }, { ...pasteTo(null), after: 0 }],
      postRefused: false,
      postError: null,
    });
    await $("#slack-input").setValue(request);
    await $("#slack-send").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: request, actions: [pasteTo(general)] }]);
    await waitForCount(cards, 2);
    await expect(where(1)).toHaveText("Example Team ・ #general");
    await expect(what(1)).toHaveAttribute("aria-pressed", "false");
    await expect(written(1)).toHaveValue(greeting);
    await expect(where(2)).toHaveText("1 のスレッド");
    await expect(what(2)).toHaveAttribute("aria-pressed", "true");
    expect(await count(`${cards}:nth-child(2) textarea`)).toBe(0);
    expect(await count(`${cards} .slack-done`)).toBe(0);
    expect(await callsOf(slackPost)).toEqual([]);
    // The owner reads them and presses 投稿: the written text first, then the original message in its thread.
    await expect(post()).toHaveText("2 件を投稿");
    await post().click();
    expect(await waitForCalls(slackPost, 2)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: greeting, written: true },
      { teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: slackPreview, written: false },
    ]);
  });

  it("marks every thing to do that Rust posted for a request, without posting from the screen", async () => {
    await openCompose();
    await chooseGeneral();
    const slackPost = await mock("slack_post", postedTs);
    await mock("claude_proofread_slack", {
      reply: "投稿しました",
      body: null,
      diff: [],
      actions: [postedAt({ ...pasteTo(general), paste: false, text: "@here お疲れ様です" }, postedTs), postedAt({ ...pasteTo(null), after: 0 }, postedTs)],
      postRefused: false,
      postError: null,
    });
    await $("#slack-input").setValue("@here お疲れ様です と投稿して、そのスレッドにメールを貼って");
    await $("#slack-send").click();
    await expect($(".toast")).toHaveText("2 件を投稿しました");
    await waitForCount(`${cards} .slack-done`, 2);
    await expect(written(1)).toHaveValue("@here お疲れ様です");
    await expect(written(1)).toBeDisabled();
    await expect(where(2)).toHaveText("1 のスレッド");
    await expect(post()).toBeDisabled();
    expect(await callsOf(slackPost)).toEqual([]);
    await expect($("#slack-compose")).toBeDisplayed();
  });

  it("shows the failure of a later post of a request, and leaves only what was not sent to 投稿", async () => {
    await openCompose();
    await chooseGeneral();
    await mock("claude_proofread_slack", {
      reply: "投稿します",
      body: null,
      diff: [],
      actions: [postedAt({ ...pasteTo(general), paste: false, text: "お疲れ様です" }, postedTs), { ...pasteTo(null), after: 0 }],
      postRefused: false,
      postError: "チャンネルに投稿する権限がありません",
    });
    await $("#slack-input").setValue("お疲れ様です と投稿して、そのスレッドにメールを貼って");
    await $("#slack-send").click();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect($("#slack-error")).toHaveText("チャンネルに投稿する権限がありません");
    await expect(card(1).$(".slack-done")).toHaveText("投稿済み");
    expect(await count(`${cards} .slack-done`)).toBe(1);
    // The next press sends the second one only, to the thread of the first.
    await expect(post()).toHaveText("投稿");
    const slackPost = await mock("slack_post", "1761785999.000200");
    await post().click();
    expect(await waitForCalls(slackPost)).toEqual([{ teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: slackPreview, written: false }]);
  });

  it("marks the post to the thread of a Slack link in the request, with the request sent as it was typed", async () => {
    await openCompose();
    const thread = { ...general, threadTs: "1761785520.123456" };
    const request = "https://example.slack.com/archives/C0123ABCD/p1761785520123456 こちらに投稿して";
    const slackPost = await mock("slack_post", postedTs);
    const edit = await mock("claude_proofread_slack", { reply: "投稿しました", body: null, diff: [], actions: [postedAt(pasteTo(thread, true), thread.threadTs)], postRefused: false, postError: null });
    await $("#slack-input").setValue(request);
    await $("#slack-send").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: request, actions: [pasteTo(null)] }]);
    await expect($(".toast")).toHaveText("Example Team の #general（スレッド） に貼りました");
    await expect(card(1).$(".slack-done")).toHaveText("投稿済み");
    await expect(where(1)).toHaveText("Example Team ・ #general（スレッド）");
    expect(await callsOf(slackPost)).toEqual([]);
  });

  it("does not put in the things to do of an answer that arrives after a card was added", async () => {
    await openCompose();
    await chooseGeneral();
    const edit = await mock("claude_proofread_slack", holds);
    await askProofread();
    await waitForCalls(edit);
    await add().click();
    await written(2).setValue("補足です");
    await release(edit, { ...proofreadEdit, actions: [{ ...pasteTo(general), paste: false, text: "別の文面" }] });
    await waitForCount("#slack-log .chat-ai", 1);
    expect(await count(cards)).toBe(2);
    await expect(what(1)).toHaveAttribute("aria-pressed", "true");
    await expect(written(2)).toHaveValue("補足です");
  });

  it("says that nothing was posted when Claude asked for a post and Rust refused it, and keeps the compose screen", async () => {
    await openCompose();
    await chooseGeneral();
    const slackPost = await mock("slack_post", postedTs);
    const edit = await mock("claude_proofread_slack", { reply: "投稿します", body: null, diff: [], actions: null, postRefused: true });
    await $("#slack-input").setValue("この内容で投稿して");
    await $("#slack-send").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "この内容で投稿して", actions: [pasteTo(general)] }]);
    await waitForCount("#slack-log .chat-ai", 1);
    await expect($("#slack-error")).toHaveText("投稿されませんでした");
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(target()).toHaveText("Example Team ・ #general");
    expect(await callsOf(slackPost)).toEqual([]);
  });

  it("keeps 投稿 off while a request to Claude is on its way, and frees it when the answer comes", async () => {
    await openCompose();
    await chooseGeneral();
    await expect(post()).toBeEnabled();
    const edit = await mock("claude_proofread_slack", holds);
    await $("#slack-input").setValue("この内容で投稿して");
    await $("#slack-send").click();
    await waitForCalls(edit);
    await expect(post()).toBeDisabled();
    await release(edit, proofreadEdit);
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(post()).toBeEnabled();
  });

  it("frees 投稿 when the request to Claude fails", async () => {
    await openCompose();
    await chooseGeneral();
    const edit = await mock("claude_proofread_slack", holds);
    await askProofread();
    await waitForCalls(edit);
    await expect(post()).toBeDisabled();
    await release(edit, rejects("Claude に接続できません"));
    await waitForCount("#slack-log .pending.fail", 1);
    await expect(post()).toBeEnabled();
  });

  it("keeps the compose screen when the answer did not post", async () => {
    await openCompose();
    await mock("claude_proofread_slack", { ...proofreadEdit, actions: [pasteTo(general, true)] });
    await $("#slack-input").setValue("#general に貼り先を変えて");
    await $("#slack-send").click();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(target()).toHaveText("Example Team ・ #general");
    await expect(body()).toHaveValue(proofreadEdit.body as string);
  });

  it("shows a thread as the destination Claude chose, and changes a destination that was chosen before", async () => {
    await openCompose();
    await chooseGeneral();
    await mock("claude_proofread_slack", { reply: "スレッドにしました", body: null, diff: [], actions: [pasteTo({ ...general, name: "random", threadTs: "1761785520.123456" }, true)] });
    await askProofread();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(target()).toHaveText("Example Team ・ #random（スレッド）");
  });

  it("keeps the destination when the answer names none", async () => {
    await openCompose();
    await chooseGeneral();
    await mock("claude_proofread_slack", { ...proofreadEdit, actions: null });
    await askProofread();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(target()).toHaveText("Example Team ・ #general");
    // An answer with no such key at all.
    await mock("claude_proofread_slack", { ...proofreadEdit, body: null, diff: [] });
    await askProofread();
    await waitForCount("#slack-log .chat-ai", 2);
    await expect(target()).toHaveText("Example Team ・ #general");
  });

  it("keeps the destination the user chose while the answer was on its way", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", holds);
    await askProofread();
    await waitForCalls(edit);
    await chooseGeneral();
    await release(edit, { ...proofreadEdit, actions: [pasteTo({ ...general, name: "random" }, true)] });
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(target()).toHaveText("Example Team ・ #general");
    // The text of the answer still goes in.
    await expect(body()).toHaveValue(proofreadEdit.body as string);
  });

  it("does not put in the destination of an answer that arrives after the conversation was forgotten", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", holds);
    await askProofread();
    await waitForCalls(edit);
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    await release(edit, { ...proofreadEdit, actions: [pasteTo(general, true)] });
    // Give a wrongly kept answer the time to be drawn.
    await browser.pause(300);
    await expect(target()).toHaveText("選んでください");
    expect(await count("#slack-log .chat-ai")).toBe(0);
  });

  it("sends the typed request on Cmd+Enter (Ctrl+Enter off macOS) with the same command and arguments as the send button", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", proofreadEdit);
    await $("#slack-input").setValue("敬語にして");
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      const mac = /Mac/.test(navigator.platform);
      document.getElementById("slack-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
    }, onceId());
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "敬語にして", actions: [pasteTo(null)] }]);
  });

  it("sends a typed request with the text and the conversation so far", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", proofreadEdit);
    await $("#slack-input").setValue("敬語にして");
    await $("#slack-send").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "敬語にして", actions: [pasteTo(null)] }]);
    await waitForCount("#slack-log .chat-ai", 1);
    await askProofread();
    const calls = await waitForCalls(edit, 2);
    // The first answer was put into the preview at once, so the second request is about that text.
    expect(calls[1]).toEqual({
      text: proofreadEdit.body,
      history: [
        { role: "user", text: "敬語にして" },
        { role: "assistant", text: proofreadEdit.reply },
      ],
      instruction: "校正してください",
      actions: [pasteTo(null)],
    });
  });

  it("cannot undo an answer once the edit field was changed", async () => {
    await openCompose();
    await mock("claude_proofread_slack", proofreadEdit);
    await askProofread();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(undoButton()).toBeEnabled();
    await setBody(`${proofreadEdit.body} (edited)`);
    await expect(undoButton()).toBeDisabled();
    // Putting the text back makes it undoable again.
    await setBody(proofreadEdit.body as string);
    await expect(undoButton()).toBeEnabled();
  });

  it("does not put in an answer that arrives after the edit field was changed, and keeps it as a proposal that cannot be applied", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", holds);
    await askProofread();
    await waitForCalls(edit);
    await setBody(`${slackPreview} (edited)`);
    await release(edit, proofreadEdit);
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(body()).toHaveValue(`${slackPreview} (edited)`);
    expect(await textsOf("#slack-log .diff-foot .text-btn")).toEqual(["却下", "適用"]);
    await expect($("#slack-log .diff-foot .text-btn.primary")).toBeDisabled();
    await expect($("#slack-log .diff-stale")).toBeDisplayed();
  });

  it("does not call a kept proposal stale while the post is on its way and the text has not changed", async () => {
    await openCompose();
    await chooseGeneral();
    const edit = await mock("claude_proofread_slack", holds);
    await askProofread();
    await waitForCalls(edit);
    await setBody(`${slackPreview} (edited)`);
    await release(edit, proofreadEdit);
    await waitForCount("#slack-log .chat-ai", 1);
    await expect($("#slack-log .diff-stale")).toBeDisplayed();
    // The text is back to the one the proposal was made from: it can be applied, and says nothing.
    await setBody(slackPreview);
    await expect($("#slack-log .diff-stale")).not.toBeDisplayed();
    const slackPost = await mock("slack_post", holds);
    await post().click();
    await waitForCalls(slackPost);
    await expect($("#slack-log .diff-foot .text-btn.primary")).toBeDisabled();
    await expect($("#slack-log .diff-stale")).not.toBeDisplayed();
    await release(slackPost, rejects("チャンネルに投稿する権限がありません"));
    await expect($("#slack-log .diff-foot .text-btn.primary")).toBeEnabled();
  });

  it("proofreads while an API key is in use", async () => {
    await openCompose(claudeKeyReady);
    await expect($("#slack-send")).toBeEnabled();
    const edit = await mock("claude_proofread_slack", proofreadEdit);
    await askProofread();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "校正してください", actions: [pasteTo(null)] }]);
    await waitForCount("#slack-log .chat-ai", 1);
  });

  it("is off with a note while Claude is not logged in", async () => {
    await openCompose(claudeLoggedOut);
    await expect($("#slack-input")).toBeDisabled();
    await expect($("#slack-send")).toBeDisabled();
    await expect($("#slack-chat-note")).toBeDisplayed();
    // Everything else works: the text can be edited and posted.
    await chooseGeneral();
    await expect(post()).toBeEnabled();
  });

  it("drops an answer that arrives after another mail was opened", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", holds);
    await askProofread();
    await waitForCalls(edit);
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    await expect(body()).toHaveValue(slackPreview);
    await release(edit, proofreadEdit);
    // Give a wrongly kept answer the time to be drawn.
    await browser.pause(300);
    expect(await count("#slack-log .chat-ai")).toBe(0);
    expect(await count("#slack-log .pending")).toBe(0);
    await expect($("#slack-send")).toBeEnabled();
  });

  it("keeps the request off, with no thinking line, until the answer dropped by a new draft arrives", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", holds);
    await askProofread();
    await waitForCalls(edit);
    await expect($("#slack-log .pending")).toExist();
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    // The old request is still on its way: it is not shown as the new draft's, and no second request can start.
    expect(await count("#slack-log .pending")).toBe(0);
    await expect($("#slack-input")).toBeDisabled();
    await expect($("#slack-send")).toBeDisabled();
    await release(edit, proofreadEdit);
    await expect($("#slack-send")).toBeEnabled();
    await expect($("#slack-input")).toBeEnabled();
    expect(await count("#slack-log .chat-ai")).toBe(0);
  });

  it("keeps the request field three lines high, scrolling inside it, and shows no placeholder or hint", async () => {
    await openCompose();
    const height = () => browser.execute(() => document.getElementById("slack-input")!.getBoundingClientRect().height);
    const lineHeight = await browser.execute(() => parseFloat(getComputedStyle(document.getElementById("slack-input")!).lineHeight));
    expect(await height()).toBe(lineHeight * 3);
    await browser.execute(() => {
      const input = document.getElementById("slack-input") as HTMLTextAreaElement;
      input.value = Array.from({ length: 12 }, (_, i) => `${i + 1}行目`).join("\n");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await height()).toBe(lineHeight * 3);
    expect(await browser.execute(() => { const i = document.getElementById("slack-input")!; return i.scrollHeight > i.clientHeight; })).toBe(true);
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    await expect($("#slack-input")).toHaveValue("");
    expect(await height()).toBe(lineHeight * 3);
  });

  it("puts 投稿 and the request field in feet of the same height, fixed to the bottom of both panes, and scrolls only the parts above", async () => {
    await openCompose();
    const boxes = () =>
      browser.execute(() => {
        const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
        const [foot, form, edit, chat, log, body] = [r("slack-edit-foot"), r("slack-form"), r("slack-edit"), r("slack-chat"), r("slack-log"), r("slack-edit-body")];
        return { footH: foot.height, formH: form.height, footBottom: foot.bottom - edit.bottom, formBottom: form.bottom - chat.bottom, logH: log.height, bodyH: body.height };
      });
    const before = await boxes();
    expect(before.footH).toBe(before.formH);
    expect(before.footBottom).toBe(0);
    expect(before.formBottom).toBe(0);
    // A long text and a long conversation change neither foot.
    await browser.execute(() => {
      document.getElementById("slack-preview")!.textContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
      const input = document.getElementById("slack-input") as HTMLTextAreaElement;
      input.value = Array.from({ length: 12 }, (_, i) => `${i + 1}行目`).join("\n");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const after = await boxes();
    expect(after).toEqual(before);
    expect(await browser.execute(() => { const b = document.getElementById("slack-edit-body")!; return b.scrollHeight > b.clientHeight; })).toBe(true);
  });

  it("keeps the feet the same height while Claude is not logged in and the note shows", async () => {
    await openCompose(claudeLoggedOut);
    await expect($("#slack-chat-note")).toBeDisplayed();
    const heights = await browser.execute(() => [document.getElementById("slack-edit-foot")!.getBoundingClientRect().height, document.getElementById("slack-form")!.getBoundingClientRect().height]);
    expect(heights[0]).toBe(heights[1]);
  });

  it("forgets the conversation with two presses of クリア", async () => {
    await openCompose();
    await mock("claude_proofread_slack", proofreadEdit);
    await expect($("#slack-clear")).toBeDisabled();
    await askProofread();
    await waitForCount("#slack-log .chat-ai", 1);
    await $("#slack-clear").click();
    await expect($("#slack-clear")).toHaveText("もう一度押すとクリア");
    await $("#slack-clear").click();
    await waitForCount("#slack-log .chat-ai", 0);
    await expect($("#slack-clear")).toBeDisabled();
    // Only the conversation is forgotten: the text Claude's answer put in stays.
    await expect(body()).toHaveValue(proofreadEdit.body as string);
  });
});

describe("slack compose screen: the divider", () => {
  // The Claude pane's share of #slack-main.
  const share = () =>
    browser.execute(
      () => document.getElementById("slack-chat")!.getBoundingClientRect().width / document.getElementById("slack-main")!.getBoundingClientRect().width,
    );
  // A drag of the divider (pointer events, as the divider listens for them) that ends with the pointer at `fraction` of #slack-main's width from its left edge.
  const drag = (fraction: number) =>
    browser.execute((f) => {
      const box = document.getElementById("slack-main")!.getBoundingClientRect();
      const at = (x: number): PointerEventInit => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: box.left + box.width * x, clientY: box.top + 80 });
      document.getElementById("slack-split")!.dispatchEvent(new PointerEvent("pointerdown", at(0.6)));
      document.dispatchEvent(new PointerEvent("pointermove", at(f)));
      document.dispatchEvent(new PointerEvent("pointerup", at(f)));
    }, fraction);
  const press = (key: string) =>
    browser.execute(
      (id, k) => window.__e2e_once__(id) && document.getElementById("slack-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })),
      onceId(),
      key,
    );

  it("is a vertical separator that starts at a third", async () => {
    await openCompose();
    const split = $("#slack-split");
    await expect(split).toHaveAttribute("role", "separator");
    await expect(split).toHaveAttribute("aria-orientation", "vertical");
    await expect(split).toHaveAttribute("tabindex", "0");
    await expect(split).toHaveAttribute("aria-valuemin", "33");
    await expect(split).toHaveAttribute("aria-valuemax", "50");
    await expect(split).toHaveAttribute("aria-valuenow", "33");
    expect(await share()).toBeCloseTo(1 / 3, 2);
  });

  it("sets the Claude width by dragging, and keeps it between a third and a half however far it is dragged", async () => {
    await openCompose();
    await drag(0.6);
    expect(await share()).toBeCloseTo(0.4, 2);
    await expect($("#slack-split")).toHaveAttribute("aria-valuenow", "40");
    await drag(0.05);
    expect(await share()).toBeCloseTo(0.5, 2);
    await expect($("#slack-split")).toHaveAttribute("aria-valuenow", "50");
    await drag(0.99);
    expect(await share()).toBeCloseTo(1 / 3, 2);
    await expect($("#slack-split")).toHaveAttribute("aria-valuenow", "33");
  });

  it("is moved with the left and right arrow keys inside the same range, and keeps its width when the screen is left and opened again", async () => {
    await openCompose();
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(await share()).toBeCloseTo(1 / 3 + 0.04, 2);
    for (let i = 0; i < 20; i++) await press("ArrowLeft");
    expect(await share()).toBeCloseTo(0.5, 2);
    for (let i = 0; i < 20; i++) await press("ArrowRight");
    expect(await share()).toBeCloseTo(1 / 3, 2);
    await press("ArrowLeft");
    const widened = await share();
    await $("#slack-back").click();
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    expect(await share()).toBeCloseTo(widened, 2);
  });
});
