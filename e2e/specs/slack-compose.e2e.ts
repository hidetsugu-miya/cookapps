import {
  askScreen, boot, callsOf, claudeReady, count, holds, inbox, mock, onceId, rejects, release, rowOf, slackChannels, slackLoad, slackPreview, textsOf, threadDetail, threadLoaded, waitForCalls, waitForCount, workspace,
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
// The two modes of the screen (S-27): the switch in the header. Claude mode puts the terminal of Claude Code in a column at the left of the original message and the cards, and manual mode hides the column.
const manual = () => $("#slack-mode-manual").click();
const claudeMode = () => $("#slack-mode-claude").click();
// The column of the terminal (A-36) and its parts.
const pane = "#slack-compose-claude";
const term = "#slack-compose-term";
// The dialog that "投稿" opens for two things to do or more (#905): the choice `how` of the `n`th thing to do (from 2), its "投稿" and its "やめる".
const ask = () => $(".slack-ask");
const askChoice = (n: number, how: "thread" | "channel") => $(`.slack-ask input[name="slack-ask-${n - 1}"][value="${how}"]`);
const askGo = () => $(".slack-ask-buttons .primary");
const askCancel = () => $("//div[contains(@class, 'slack-ask-buttons')]//button[normalize-space()='やめる']");
// Presses "投稿", chooses `hows` for the things to do from the second on, and sends from the dialog.
async function postThrough(...hows: ("thread" | "channel")[]) {
  await post().click();
  await ask().waitForExist();
  for (const [at, how] of hows.entries()) await askChoice(at + 2, how).click();
  await askGo().click();
  await expect(ask()).not.toExist();
}
// The destination chip of the first thing to do.
const target = () => where(1);
// What `slack_post` answers: the time of the posted message.
const postedTs = "1761785520.000100";
// The destination of `slackChannels` as Rust answers it when Claude Code chose it (S-4).
const general: Target = { teamId: "T1", channel: "C0123ABCD", name: "general", threadTs: null };
// A thing to do as the screen holds it and Rust answers it: one that pastes the original message to `target` (`byClaude`: a destination that a write of Claude Code put there).
const pasteTo = (target: Target | null, byClaude = false): SlackAction => ({ target, after: null, paste: true, text: "", posted: null, byClaude });
// What `slack_compose_read` answers: the texts of the two JSON arrays.
const composeRead = (actions: unknown[], destinations: unknown[] = [{ no: 1, name: "Example Team / #general" }]) => ({ actions: JSON.stringify(actions), destinations: JSON.stringify(destinations) });
// The share of the column of the terminal in #slack-main, which the divider sets.
const share = () => browser.execute(() => document.getElementById("slack-compose-claude")!.getBoundingClientRect().width / document.getElementById("slack-main")!.getBoundingClientRect().width);

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

// Opens the screen and switches to manual mode, where the terminal is hidden and the original message and the cards take the whole width.
async function openManual(claude: unknown = claudeReady, first = "Hello from Alice") {
  const preview = await openCompose(claude, first);
  await manual();
  return preview;
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

describe("slack compose screen", () => {
  it("opens in Claude mode: the terminal of Claude Code at the left, the original message, the cards and 投稿 at the right", async () => {
    const preview = await openCompose();
    expect(await callsOf(preview)).toEqual([
      { subject: "First unread", from: "Alice <alice@example.com>", date: expect.any(String), body: "Hello from Alice" },
    ]);
    await expect($("#slack-subject")).toHaveText("First unread");
    await expect($("#slack-compose h1")).toHaveText("Slack に貼る");
    await expect($("#slack-back")).toHaveText(expect.stringContaining("メールに戻る"));
    // The switch is at the right of the header, with Claude pressed.
    await expect($("#slack-mode")).toHaveAttribute("role", "group");
    expect(await textsOf("#slack-mode button")).toEqual(["Claude", "手動"]);
    await expect($("#slack-mode-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($("#slack-mode-manual")).toHaveAttribute("aria-pressed", "false");
    await expect($("#slack-compose")).toHaveAttribute("data-mode", "claude");
    expect(await browser.execute(() => document.getElementById("slack-mode")!.getBoundingClientRect().right > document.getElementById("slack-subject")!.getBoundingClientRect().right)).toBe(true);
    // The terminal's column is at the left, then the divider, then the part that holds the original message, the cards and 投稿.
    await expect($(pane)).toBeDisplayed();
    await expect($("#slack-split")).toBeDisplayed();
    await expect($("#slack-edit")).toBeDisplayed();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    const places = await browser.execute(() => ["slack-compose-claude", "slack-split", "slack-edit"].map((id) => document.getElementById(id)!.getBoundingClientRect().left));
    expect(places[0]).toBeLessThan(places[1]);
    expect(places[1]).toBeLessThan(places[2]);
    // The old conversation and the column of the things to do are gone.
    expect(await count("#slack-chat, #slack-brief, #slack-log, #slack-input, #slack-send, #slack-model, #slack-clear, #slack-form, #slack-chat-note, .slack-confirm")).toBe(0);
    // The original message, one thing to do that pastes it to a destination that is not chosen, and 投稿.
    await expect(previewBox()).toBeDisplayed();
    await expect(previewBox()).toHaveText(slackPreview);
    await waitForCount(cards, 1);
    await expect(where(1)).toHaveText("選んでください");
    await expect(post()).toBeDisplayed();
    await expect(add()).toBeDisplayed();
    await expect($("#thread")).not.toBeDisplayed();
    await expect($("#mail-header")).not.toBeDisplayed();
    await expect($("#nav-mail")).toHaveAttribute("aria-current", "page");
  });

  it("has a heading of the mark, Claude and やり直す, level with the head of the original message", async () => {
    await openCompose();
    await expect($(`${pane} .chat-head`)).toHaveText(expect.stringContaining("Claude"));
    expect(await count(`${pane} .chat-head > svg`)).toBe(1);
    await expect($("#slack-compose-restart")).toHaveText("やり直す");
    await expect($("#slack-compose-restart")).toBeEnabled();
    const heads = await browser.execute(() => {
      const [a, b] = ["#slack-compose-claude .chat-head", "#slack-edit-head"].map((s) => document.querySelector(s)!.getBoundingClientRect());
      const button = document.getElementById("slack-compose-restart")!.getBoundingClientRect();
      return { heights: [a.height, b.height], level: Math.abs(a.top - b.top) < 1, right: a.right - button.right < 24 };
    });
    expect(heads).toEqual({ heights: [48, 48], level: true, right: true });
    // The screen shows no help text: no placeholder, and no line that explains the terminal.
    expect(await count("#slack-compose [placeholder]")).toBe(0);
  });

  it("shows the original message, the cards and 投稿 over the whole width in manual mode, and not the terminal", async () => {
    await openCompose();
    await manual();
    await expect($("#slack-mode-manual")).toHaveAttribute("aria-pressed", "true");
    await expect($("#slack-mode-claude")).toHaveAttribute("aria-pressed", "false");
    await expect($("#slack-compose")).toHaveAttribute("data-mode", "manual");
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#slack-split")).not.toBeDisplayed();
    expect(await browser.execute(() => document.getElementById("slack-edit")!.getBoundingClientRect().width === document.getElementById("slack-main")!.getBoundingClientRect().width)).toBe(true);
    await expect(body()).toHaveValue(slackPreview);
    await expect(body()).toBeEnabled();
    // The preview shows the text, and the edit field is closed until the preview is pressed.
    await expect(previewBox()).toBeDisplayed();
    await expect(previewBox()).toHaveText(slackPreview);
    await expect(body()).not.toBeDisplayed();
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
    // No field of the screen has a placeholder.
    expect(await count("#slack-edit [placeholder]")).toBe(0);
  });

  it("keeps the draft when the mode is switched, and keeps the process of Claude Code running", async () => {
    await openCompose();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    // Claude mode: the owner edits the original message and the cards at the right of the terminal.
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    await setBody("Edited by hand");
    await manual();
    await expect($(pane)).not.toBeDisplayed();
    await expect(body()).toHaveValue("Edited by hand");
    await expect(where(1)).toHaveText("Example Team ・ #general");
    await expect(written(2)).toHaveValue("補足です");
    expect(await count(cards)).toBe(2);
    await expect(post()).toHaveText("2 件を投稿");
    // Claude mode once more: the terminal is back, and the draft is as it was left.
    await claudeMode();
    await expect($(pane)).toBeDisplayed();
    await expect($("#slack-split")).toBeDisplayed();
    await expect(previewBox()).toHaveText("Edited by hand");
    await expect(written(2)).toHaveValue("補足です");
    // Hiding and showing the terminal started nothing and ended nothing.
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    expect(await callsOf(close)).toEqual([]);
  });

  it("opens in Claude mode again when the screen is left from manual mode and opened again", async () => {
    await openManual();
    await expect($("#slack-compose")).toHaveAttribute("data-mode", "manual");
    await $("#slack-back").click();
    await expect($("#thread")).toBeDisplayed();
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    await expect($("#slack-compose")).toHaveAttribute("data-mode", "claude");
    await expect($("#slack-mode-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($(pane)).toBeDisplayed();
    await expect($("#slack-split")).toBeDisplayed();
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
    await openManual();
    await expect(target()).toHaveText("選んでください");
    await expect(post()).toBeDisabled();
    await chooseGeneral();
    await expect(post()).toBeEnabled();
    // A blank text cannot be posted either.
    await setBody(" ");
    await expect(post()).toBeDisabled();
  });
  it("opens the edit field when the preview is pressed, and posts the edited text with 投稿 as `text`", async () => {
    await openManual();
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
    await manual();
    await expect(card(1).$(".slack-done")).toHaveText("投稿済み");
    expect(await callsOf(slackPost)).toHaveLength(1);
  });
  it("adds a thing to do with the plus, which goes on in the thread of the one before with an empty text of its own, and takes it out again", async () => {
    await openManual();
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
    await openManual();
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
    await openManual();
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
    await openManual();
    await chooseGeneral();
    // The first: a written word to the channel. The second: the original message, in the thread of the first.
    await what(1).click();
    await written(1).setValue("@here 共有します");
    await add().click();
    await expect(where(2)).toHaveText("1 のスレッド");
    await what(2).click();
    await expect(post()).toHaveText("2 件を投稿");
    const slackPost = await mock("slack_post", postedTs);
    await postThrough("thread");
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
  it("opens a dialog for two things to do or more, with the thread of the one before and the channel for each one after the first, and posts nothing until it is confirmed", async () => {
    await openManual();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    await add().click();
    await written(3).setValue("以上です");
    const slackPost = await mock("slack_post", postedTs);
    await post().click();
    await ask().waitForExist();
    await expect(ask()).toHaveAttribute("role", "dialog");
    expect(await textsOf(".slack-ask legend")).toEqual(["2 をどこに送りますか", "3 をどこに送りますか"]);
    expect(await textsOf(".slack-ask-choice")).toEqual(["1 のスレッドに投稿", "#general に投稿", "2 のスレッドに投稿", "#general に投稿"]);
    // The things to do added with the plus go on in the thread of the one before, so that is what is chosen at first.
    await expect(askChoice(2, "thread")).toBeSelected();
    await expect(askChoice(3, "thread")).toBeSelected();
    expect(await callsOf(slackPost)).toEqual([]);
    // The second goes to the thread of the first, the third to the channel.
    await askChoice(3, "channel").click();
    await askGo().click();
    await expect(ask()).not.toExist();
    expect(await waitForCalls(slackPost, 3)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: slackPreview, written: false },
      { teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: "補足です", written: true },
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: "以上です", written: true },
    ]);
    await waitForCount(`${cards} .slack-done`, 3);
  });
  it("sends the second thing to do to the thread of the first when the thread is chosen in the dialog", async () => {
    await openManual();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    const slackPost = await mock("slack_post", postedTs);
    await postThrough("thread");
    expect(await waitForCalls(slackPost, 2)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: slackPreview, written: false },
      { teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: "補足です", written: true },
    ]);
  });
  it("sends the second thing to do to the channel, with no thread, when the channel is chosen in the dialog, and fixes the chip of its card", async () => {
    await openManual();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    const slackPost = await mock("slack_post", postedTs);
    await postThrough("channel");
    expect(await waitForCalls(slackPost, 2)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: slackPreview, written: false },
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: "補足です", written: true },
    ]);
    await expect(where(2)).toHaveText("Example Team ・ #general");
  });
  it("offers the own destination of a second thing to do as the choice of the dialog, chosen at first, and posts it there with no thread", async () => {
    await openManual();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("別の場所です");
    // The second has a channel of its own, not the channel of the first.
    await mock("slack_channels", [...slackChannels, { id: "C0999RAND", name: "random", private: false }]);
    await where(2).click();
    const random = $("//div[contains(@class, 'slack-pop')]//button[normalize-space()='#random']");
    await random.waitForExist();
    await random.click();
    await expect(where(2)).toHaveText("Example Team ・ #random");
    const slackPost = await mock("slack_post", postedTs);
    await post().click();
    await ask().waitForExist();
    expect(await textsOf(".slack-ask-choice")).toEqual(["1 のスレッドに投稿", "Example Team ・ #random に投稿"]);
    await expect(askChoice(2, "channel")).toBeSelected();
    await askGo().click();
    await expect(ask()).not.toExist();
    expect(await waitForCalls(slackPost, 2)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: slackPreview, written: false },
      { teamId: "T1", channel: "C0999RAND", threadTs: null, name: "random", text: "別の場所です", written: true },
    ]);
    await expect(where(2)).toHaveText("Example Team ・ #random");
  });
  it("posts nothing and changes no card when the dialog is closed with やめる, Escape or a press on the dimmed screen", async () => {
    await openManual();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    const slackPost = await mock("slack_post", postedTs);
    await post().click();
    await ask().waitForExist();
    await askCancel().click();
    await expect(ask()).not.toExist();
    await post().click();
    await ask().waitForExist();
    await browser.keys("Escape");
    await expect(ask()).not.toExist();
    await post().click();
    await ask().waitForExist();
    await browser.action("pointer").move({ origin: "viewport", x: 5, y: 5 }).down().up().perform();
    await expect(ask()).not.toExist();
    expect(await callsOf(slackPost)).toEqual([]);
    expect(await count(`${cards} .slack-done`)).toBe(0);
    await expect(where(2)).toHaveText("1 のスレッド");
    await expect(post()).toBeEnabled();
  });
  it("posts one thing to do at once, with no dialog", async () => {
    await openManual();
    await chooseGeneral();
    const slackPost = await mock("slack_post", postedTs);
    await post().click();
    expect(await waitForCalls(slackPost)).toEqual([{ teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: slackPreview, written: false }]);
    expect(await count(".slack-ask")).toBe(0);
  });
  it("chooses the thread of an earlier post, or a channel of its own, in the picker of a later thing to do", async () => {
    await openManual();
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
    await openManual();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    const slackPost = await mock("slack_post", holds);
    await postThrough("thread");
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
    // Claude Code writes a card whose destination is a thread of #general (a write of the field `actions`; Rust answered the cards it made).
    await mock("slack_compose_write", [pasteTo({ ...general, threadTs: "1761700000.000001" }, true)]);
    expect((await askScreen("write", "slack-compose", { actions: JSON.stringify([{ destination: 2 }]) })).ok).toBe(true);
    await expect(where(1)).toHaveText("Example Team ・ #general（スレッド）");
    await add().click();
    await written(2).setValue("続きです");
    const slackPost = await mock("slack_post", postedTs);
    await postThrough("thread");
    expect(((await waitForCalls(slackPost, 2)) as { threadTs: string | null }[]).map((c) => c.threadTs)).toEqual(["1761700000.000001", "1761700000.000001"]);
  });

  it("shows a failed post on the screen and keeps the text and the destination", async () => {
    await openManual();
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
    await manual();
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
    await expect(where(1)).toHaveText("Example Team ・ #general");
    await manual();
    expect(await callsOf(preview)).toHaveLength(1);
    // The things to do are kept with it.
    await add().click();
    await written(2).setValue("Kept word");
    await $("#slack-back").click();
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(written(2)).toHaveValue("Kept word");
    await expect(where(2)).toHaveText("1 のスレッド");
    // Another mail: a new draft, made from its text (`pressSlack` mocks `slack_preview` again, which forgets the earlier calls, so the one call is the new draft's).
    await openOtherMail("Second unread", "Another text");
    const again = await pressSlack();
    await expect(body()).toHaveValue(slackPreview);
    await expect(where(1)).toHaveText("選んでください");
    await waitForCount(cards, 1);
    expect(await callsOf(again)).toHaveLength(1);
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
    await openManual();
    await chooseGeneral();
    await $("#slack-back").click();
    await expect($("#thread")).toBeDisplayed();
    await mock("slack_load", { workspaces: [{ ...workspace, teamId: "T2", team: "Other Team" }], recent: [] });
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(where(1)).toHaveText("選んでください");
    await expect(post()).toBeDisabled();
  });
  it("locks the edit field and 元に戻す while the post is on its way, and frees them when it fails", async () => {
    await openCompose();
    await chooseGeneral();
    await askScreen("write", "slack-compose", { text: "Written by Claude Code" });
    await expect($("#slack-undo")).toBeEnabled();
    const slackPost = await mock("slack_post", holds);
    await post().click();
    await waitForCalls(slackPost);
    await expect(body()).toBeDisabled();
    await expect($("#slack-undo")).toBeDisabled();
    // A write of Claude Code waits too: the text that is being posted does not change under it.
    const write = await askScreen("write", "slack-compose", { text: "Too late" });
    expect(write).toEqual({ ok: false, error: expect.stringContaining("投稿の最中") });
    await release(slackPost, rejects("チャンネルに投稿する権限がありません"));
    await expect($("#slack-error")).toHaveText(expect.stringContaining("チャンネルに投稿する権限がありません"));
    await expect(body()).toBeEnabled();
    await expect($("#slack-undo")).toBeEnabled();
  });

  it("stays on another mail's compose screen when an earlier post finishes", async () => {
    await openManual();
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
    await expect(where(1)).toHaveText("選んでください");
    // The other mail's card is not the posted one.
    expect(await count(`${cards} .slack-done`)).toBe(0);
  });
  it("tells a post that failed after the screen was left with a toast", async () => {
    await openManual();
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
    await openManual();
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

describe("slack compose screen: Claude Code", () => {
  it("starts Claude Code in the terminal with the tools of tsunagiai-mcp only and a first instruction that tells the work and the tools, with nothing of the mail", async () => {
    await openCompose();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "slack-compose", builtinTools: false, skill: null });
    const { prompt, viewport } = start as { prompt: string; viewport: { cols: number; rows: number } };
    // It says that this is the work of making the text for Slack and posting it, and names the tools; the mail's text and the subject are read through the tools.
    expect(prompt).toContain("Slack");
    for (const tool of ["screen_read", "screen_write", "slack_compose_post", "slack-compose", "destination", "after"]) expect(prompt).toContain(tool);
    expect(prompt).not.toContain("Hello from Alice");
    expect(prompt).not.toContain("First unread");
    expect(viewport.cols).toBeGreaterThan(20);
    expect(viewport.rows).toBeGreaterThan(5);
    for (const command of ["claude_chat_thread", "claude_proofread_slack", "orca_stream_terminal", "orca_terminal_read"]) expect(await callsOf(command)).toEqual([]);
  });

  it("starts the process once, and keeps it while the mode is switched and while the screen is left and opened again for the same mail", async () => {
    await openCompose();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await manual();
    await claudeMode();
    await $("#slack-back").click();
    await expect($(pane)).not.toBeDisplayed();
    await $("#thread-slack").click();
    await expect($(pane)).toBeDisplayed();
    await $("#nav-mail").click();
    await expect($(pane)).not.toBeDisplayed();
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    expect(await callsOf(close)).toEqual([]);
  });

  it("ends the process and starts a new one for the draft of another mail, and not before it is opened", async () => {
    await openCompose();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await openOtherMail("Second unread", "Another text");
    await browser.pause(300);
    expect(await callsOf(close)).toEqual([]);
    await pressSlack();
    expect(await waitForCalls(close)).toEqual([{ id: "slack-compose", launch: 1 }]);
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts[1]).toMatchObject({ id: "slack-compose", builtinTools: false, skill: null, prompt: (starts[0] as { prompt: string }).prompt });
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  });

  it("ends the process and starts a new one with やり直す", async () => {
    await openCompose();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await $("#slack-compose-restart").click();
    expect(await waitForCalls(close)).toEqual([{ id: "slack-compose", launch: 1 }]);
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts).toHaveLength(2);
    await expect($("#slack-compose-restart")).toBeEnabled();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  });

  it("answers a read with the original message, the cards and the numbered destinations, as Rust made them", async () => {
    await openCompose();
    await chooseGeneral();
    const read = await mock("slack_compose_read", composeRead([{ no: 1, posted: false, destination: 1, paste: true }]));
    const answer = await askScreen("read", "slack-compose");
    expect(answer).toEqual({
      ok: true,
      fields: { text: slackPreview, actions: JSON.stringify([{ no: 1, posted: false, destination: 1, paste: true }]), destinations: JSON.stringify([{ no: 1, name: "Example Team / #general" }]) },
    });
    // Rust gets the cards as the screen holds them, to number the destinations.
    expect(await callsOf(read)).toEqual([{ actions: [pasteTo(general)] }]);
    // The text is the original message as it is now.
    await setBody("Edited by hand");
    const again = await askScreen("read", "slack-compose");
    expect(again.fields?.text).toBe("Edited by hand");
  });

  it("answers an error for a screen that is not open, and for a screen that is not asked of", async () => {
    await openCompose();
    await $("#slack-back").click();
    expect(await askScreen("read", "slack-compose")).toEqual({ ok: false, error: expect.stringContaining("画面が開いていません") });
    expect((await askScreen("write", "slack-compose", { text: "x" })).ok).toBe(false);
    expect((await askScreen("post", "slack-compose")).ok).toBe(false);
    expect(await askScreen("read", "mail-reply")).toEqual({ ok: false, error: expect.stringContaining("まだ使えません") });
  });

  it("writes the original message at once, shows 元に戻す above the fields, and puts the text back", async () => {
    await openCompose();
    await expect($("#slack-undo-bar")).not.toBeDisplayed();
    expect(await askScreen("write", "slack-compose", { text: "Proofread by Claude Code" })).toEqual({ ok: true });
    await expect(previewBox()).toHaveText("Proofread by Claude Code");
    await expect(body()).toHaveValue("Proofread by Claude Code");
    // The button is above the fields and under the head, in both modes.
    await expect($("#slack-undo-bar")).toBeDisplayed();
    await expect($("#slack-undo")).toHaveText("元に戻す");
    const order = await browser.execute(() => {
      const top = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return [top("slack-edit-head").bottom <= top("slack-undo-bar").top, top("slack-undo-bar").bottom <= top("slack-edit-body").top];
    });
    expect(order).toEqual([true, true]);
    await manual();
    await expect($("#slack-undo-bar")).toBeDisplayed();
    await claudeMode();
    await $("#slack-undo").click();
    await expect(previewBox()).toHaveText(slackPreview);
    await expect(body()).toHaveValue(slackPreview);
    await expect($("#slack-undo-bar")).not.toBeDisplayed();
    // Nothing was posted or saved by the write or the way back.
    expect(await callsOf("slack_post")).toEqual([]);
  });

  it("writes the cards with the text of the field `actions`, puts in the cards Rust made, and takes them back with the original message", async () => {
    await openCompose();
    const write = await mock("slack_compose_write", [pasteTo(general, true), { target: null, after: 0, paste: false, text: "続きです", posted: null, byClaude: false }]);
    const fields = { text: "Written", actions: JSON.stringify([{ destination: 1 }, { after: 1, text: "続きです" }]) };
    expect(await askScreen("write", "slack-compose", fields)).toEqual({ ok: true });
    // Rust is given the text of the field and the cards that the screen holds, and its answer is what the screen draws.
    expect(await callsOf(write)).toEqual([{ text: fields.actions, actions: [pasteTo(null)] }]);
    await waitForCount(cards, 2);
    await expect(where(1)).toHaveText("Example Team ・ #general");
    await expect(where(2)).toHaveText("1 のスレッド");
    await expect(written(2)).toHaveValue("続きです");
    await expect(previewBox()).toHaveText("Written");
    await expect(post()).toHaveText("2 件を投稿");
    expect(await callsOf("slack_post")).toEqual([]);
    // One press takes back the text and the cards of that write together.
    await $("#slack-undo").click();
    await waitForCount(cards, 1);
    await expect(where(1)).toHaveText("選んでください");
    await expect(previewBox()).toHaveText(slackPreview);
    await expect($("#slack-undo-bar")).not.toBeDisplayed();
  });

  it("takes the writes back newest first, and none once the owner changes a field", async () => {
    await openCompose();
    await askScreen("write", "slack-compose", { text: "First write" });
    await askScreen("write", "slack-compose", { text: "Second write" });
    await $("#slack-undo").click();
    await expect(previewBox()).toHaveText("First write");
    await expect($("#slack-undo-bar")).toBeDisplayed();
    await $("#slack-undo").click();
    await expect(previewBox()).toHaveText(slackPreview);
    await expect($("#slack-undo-bar")).not.toBeDisplayed();
    // The owner types in the original message after a write: no way back is left, the older writes included.
    await askScreen("write", "slack-compose", { text: "Third write" });
    await askScreen("write", "slack-compose", { text: "Fourth write" });
    await setBody("Mine");
    await expect($("#slack-undo-bar")).not.toBeDisplayed();
    // A card changed by the owner does the same.
    await askScreen("write", "slack-compose", { text: "Fifth write" });
    await expect($("#slack-undo-bar")).toBeDisplayed();
    await add().click();
    await expect($("#slack-undo-bar")).not.toBeDisplayed();
    // Another draft starts with none.
    await askScreen("write", "slack-compose", { text: "Sixth write" });
    await expect($("#slack-undo-bar")).toBeDisplayed();
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    await expect($("#slack-undo-bar")).not.toBeDisplayed();
  });

  it("refuses a write of a field that is only read, of a name the screen has not, and of cards Rust refuses, and changes nothing", async () => {
    await openCompose();
    expect(await askScreen("write", "slack-compose", { destinations: "[]" })).toEqual({ ok: false, error: expect.stringContaining("destinations は読むだけ") });
    expect(await askScreen("write", "slack-compose", { subject: "x" })).toEqual({ ok: false, error: expect.stringContaining("subject はありません") });
    const write = await mock("slack_compose_write", rejects("行うこと 1 の destination は、送り先の候補の番号（1 から 1）で書いてください"));
    // The text of the same write is not put in either: the whole write is refused.
    expect(await askScreen("write", "slack-compose", { text: "Not put in", actions: JSON.stringify([{ destination: 9 }]) })).toEqual({ ok: false, error: expect.stringContaining("1 から 1") });
    expect(await callsOf(write)).toHaveLength(1);
    await expect(previewBox()).toHaveText(slackPreview);
    await expect(where(1)).toHaveText("選んでください");
    await expect($("#slack-undo-bar")).not.toBeDisplayed();
  });

  it("refuses a write while the dialog of the destinations is open", async () => {
    await openCompose();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    await post().click();
    await ask().waitForExist();
    expect(await askScreen("write", "slack-compose", { text: "x" })).toEqual({ ok: false, error: expect.stringContaining("ダイアログ") });
    await askCancel().click();
    expect((await askScreen("write", "slack-compose", { text: "x" })).ok).toBe(true);
  });

  it("posts one thing to do at once when the tool asks, as the button does, and answers that it did", async () => {
    await openCompose();
    await chooseGeneral();
    const slackPost = await mock("slack_post", postedTs);
    expect(await askScreen("post", "slack-compose")).toEqual({ ok: true, fields: { state: "posted", count: "1" } });
    expect(await callsOf(slackPost)).toEqual([{ teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: slackPreview, written: false }]);
    await expect(card(1).$(".slack-done")).toHaveText("投稿済み");
    await expect($(".toast")).toHaveText("Example Team の #general に貼りました");
    await expect(ask()).not.toExist();
    // Nothing is left to post.
    expect(await askScreen("post", "slack-compose")).toEqual({ ok: false, error: expect.stringContaining("投稿していない行うことがありません") });
  });

  it("opens the dialog of the destinations for two things to do or more, posts nothing until the owner chooses, and answers that it waits", async () => {
    await openCompose();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    const slackPost = await mock("slack_post", postedTs);
    expect(await askScreen("post", "slack-compose")).toEqual({ ok: true, fields: { state: "asking" } });
    await expect(ask()).toBeDisplayed();
    expect(await callsOf(slackPost)).toEqual([]);
    // Another ask meanwhile does not open a second dialog.
    expect(await askScreen("post", "slack-compose")).toEqual({ ok: false, error: expect.stringContaining("もう開いています") });
    expect(await count(".slack-ask")).toBe(1);
    await askChoice(2, "thread").click();
    await askGo().click();
    expect(await waitForCalls(slackPost, 2)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: slackPreview, written: false },
      { teamId: "T1", channel: "C0123ABCD", threadTs: postedTs, name: "general", text: "補足です", written: true },
    ]);
    await waitForCount(`${cards} .slack-done`, 2);
  });

  it("closes the dialog with やめる without posting, and the card keeps its place", async () => {
    await openCompose();
    await chooseGeneral();
    await add().click();
    await written(2).setValue("補足です");
    const slackPost = await mock("slack_post", postedTs);
    await askScreen("post", "slack-compose");
    await askCancel().click();
    await expect(ask()).not.toExist();
    await browser.pause(300);
    expect(await callsOf(slackPost)).toEqual([]);
    await expect(where(2)).toHaveText("1 のスレッド");
  });

  it("refuses a post when a thing to do has no destination or no text, and when the post is on its way", async () => {
    await openCompose();
    const slackPost = await mock("slack_post", holds);
    expect(await askScreen("post", "slack-compose")).toEqual({ ok: false, error: expect.stringContaining("送り先か文のない") });
    expect(await callsOf(slackPost)).toEqual([]);
    await chooseGeneral();
    await post().click();
    await waitForCalls(slackPost);
    expect(await askScreen("post", "slack-compose")).toEqual({ ok: false, error: expect.stringContaining("投稿の最中") });
    await release(slackPost, postedTs);
    await waitForCount(`${cards} .slack-done`, 1);
  });

  it("answers the failure of the post as the reason, with what was sent before it", async () => {
    await openCompose();
    await chooseGeneral();
    await mock("slack_post", rejects("チャンネルに投稿する権限がありません"));
    expect(await askScreen("post", "slack-compose")).toEqual({ ok: false, error: expect.stringContaining("投稿できませんでした: チャンネルに投稿する権限がありません") });
    // The screen shows it as it does for the button.
    await expect($("#slack-error")).toHaveText(expect.stringContaining("チャンネルに投稿する権限がありません"));
    await expect(post()).toBeEnabled();
  });
});

describe("slack compose screen: the divider", () => {
  // A drag of the divider (pointer events, as the divider listens for them) that ends with the pointer at `fraction` of #slack-main's width from its left edge.
  const drag = (fraction: number) =>
    browser.execute((f) => {
      const box = document.getElementById("slack-main")!.getBoundingClientRect();
      const at = (x: number): PointerEventInit => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: box.left + box.width * x, clientY: box.top + 80 });
      document.getElementById("slack-split")!.dispatchEvent(new PointerEvent("pointerdown", at(0.45)));
      document.dispatchEvent(new PointerEvent("pointermove", at(f)));
      document.dispatchEvent(new PointerEvent("pointerup", at(f)));
    }, fraction);
  const press = (key: string) =>
    browser.execute(
      (id, k) => window.__e2e_once__(id) && document.getElementById("slack-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })),
      onceId(),
      key,
    );

  it("is a vertical separator that starts at 45% for the column of the terminal", async () => {
    await openCompose();
    const split = $("#slack-split");
    await expect(split).toHaveAttribute("role", "separator");
    await expect(split).toHaveAttribute("aria-orientation", "vertical");
    await expect(split).toHaveAttribute("tabindex", "0");
    await expect(split).toHaveAttribute("aria-label", "Claude の幅");
    await expect(split).toHaveAttribute("aria-valuemin", "35");
    await expect(split).toHaveAttribute("aria-valuemax", "60");
    await expect(split).toHaveAttribute("aria-valuenow", "45");
    expect(await share()).toBeCloseTo(0.45, 2);
  });

  it("sets the width of the column by dragging, and keeps it between 35% and 60% however far it is dragged", async () => {
    await openCompose();
    await drag(0.5);
    expect(await share()).toBeCloseTo(0.5, 2);
    await expect($("#slack-split")).toHaveAttribute("aria-valuenow", "50");
    await drag(0.99);
    expect(await share()).toBeCloseTo(0.6, 2);
    await expect($("#slack-split")).toHaveAttribute("aria-valuenow", "60");
    await drag(0.05);
    expect(await share()).toBeCloseTo(0.35, 2);
    await expect($("#slack-split")).toHaveAttribute("aria-valuenow", "35");
  });

  it("is moved with the left and right arrow keys inside the same range, and keeps its width when the screen is left and opened again", async () => {
    await openCompose();
    await press("ArrowRight");
    await press("ArrowRight");
    expect(await share()).toBeCloseTo(0.49, 2);
    for (let i = 0; i < 20; i++) await press("ArrowRight");
    expect(await share()).toBeCloseTo(0.6, 2);
    for (let i = 0; i < 20; i++) await press("ArrowLeft");
    expect(await share()).toBeCloseTo(0.35, 2);
    await press("ArrowRight");
    const widened = await share();
    await $("#slack-back").click();
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    expect(await share()).toBeCloseTo(widened, 2);
  });
});
