import {
  boot, callsOf, claudeKeyReady, claudeLoggedOut, claudeReady, count, holds, inbox, mock, onceId, proofreadEdit, rejects, release, rowOf, slackChannels, slackLoad, slackPreview, textsOf, threadDetail, waitForCalls, waitForCount, workspace,
} from "../support";

const body = () => $("#slack-body");
const post = () => $("#slack-post");
const target = () => $("#slack-target");

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
}

// Presses "Slack に貼る"; `slack_preview` answers `preview`. Returns the handle of `slack_preview`.
async function pressSlack(preview = slackPreview) {
  const call = await mock("slack_preview", preview);
  await $("#thread-slack").click();
  await expect($("#slack-compose")).toBeDisplayed();
  return call;
}

// Picks "#general" of the only workspace in the destination picker.
async function chooseGeneral() {
  await mock("slack_channels", slackChannels);
  await target().click();
  const channel = $("//div[contains(@class, 'slack-pop')]//button[normalize-space()='#general']");
  await channel.waitForExist();
  await channel.click();
  await expect(target()).toHaveText("Example Team ・ #general");
}

// Back to the list from the sidebar and into the thread of another unread row.
async function openOtherMail(subject: string, text: string) {
  await $("#nav-mail").click();
  await expect($("#threads")).toBeDisplayed();
  await openMail(subject, text);
}

const applyButton = () => $("#slack-log .diff-foot .text-btn.primary");

describe("slack compose screen", () => {
  it("opens from the thread with the mail's text in the edit field and no field for a note", async () => {
    const preview = await openCompose();
    expect(await callsOf(preview)).toEqual([
      { subject: "First unread", from: "Alice <alice@example.com>", date: expect.any(String), body: "Hello from Alice" },
    ]);
    await expect(body()).toHaveValue(slackPreview);
    await expect(body()).toBeEnabled();
    await expect($("#slack-subject")).toHaveText("First unread");
    await expect($("#slack-compose h1")).toHaveText("Slack に貼る");
    await expect($("#slack-back")).toHaveText(expect.stringContaining("メールに戻る"));
    expect(await count('[aria-label="ひとこと"], [placeholder*="ひとこと"]')).toBe(0);
    expect(await count("#slack-edit textarea")).toBe(1);
    await expect($("#thread")).not.toBeDisplayed();
    await expect($("#mail-header")).not.toBeDisplayed();
    await expect($("#nav-mail")).toHaveAttribute("aria-current", "page");
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

  it("does not pick a destination by itself, so 貼る stays disabled until one is chosen", async () => {
    await openCompose();
    await expect(target()).toHaveText("選んでください");
    await expect(post()).toBeDisabled();
    await chooseGeneral();
    await expect(post()).toBeEnabled();
    // A blank text cannot be posted either.
    await body().setValue(" ");
    await expect(post()).toBeDisabled();
  });

  it("posts the edited text as `text`, tells so, and returns to the mail", async () => {
    await openCompose();
    await chooseGeneral();
    await body().setValue("Edited *text* of the post");
    const slackPost = await mock("slack_post", true);
    await post().click();
    expect(await waitForCalls(slackPost)).toEqual([
      { teamId: "T1", channel: "C0123ABCD", threadTs: null, name: "general", text: "Edited *text* of the post" },
    ]);
    await expect($(".toast")).toHaveText("Example Team の #general に貼りました");
    await expect($("#thread")).toBeDisplayed();
    await expect($("#thread-subject")).toHaveText("First unread");
    await expect($("#slack-compose")).not.toBeDisplayed();
    // The draft is gone: opening it again starts from the mail's text, with no destination.
    await pressSlack();
    await expect(body()).toHaveValue(slackPreview);
    await expect(target()).toHaveText("選んでください");
  });

  it("shows a failed post on the screen and keeps the text and the destination", async () => {
    await openCompose();
    await chooseGeneral();
    await body().setValue("Keep me");
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
    await body().setValue("Draft of the first mail");
    await $("#slack-back").click();
    await expect($("#thread")).toBeDisplayed();
    await expect($("#thread-subject")).toHaveText("First unread");
    // The thread was not fetched again, and it is where it was scrolled to.
    expect(await callsOf(thread)).toHaveLength(1);
    await browser.waitUntil(async () => (await scroll()) === scrolled, { timeoutMsg: "the scroll position was not restored" });
    // The same mail again: the draft is there, and the mail's text is not asked for again.
    await $("#thread-slack").click();
    await expect($("#slack-compose")).toBeDisplayed();
    await expect(body()).toHaveValue("Draft of the first mail");
    await expect(target()).toHaveText("Example Team ・ #general");
    expect(await callsOf(preview)).toHaveLength(1);
    // Another mail: a new draft, made from its text (`pressSlack` mocks `slack_preview` again, which forgets the earlier calls, so the one call is the new draft's).
    await openOtherMail("Second unread", "Another text");
    const again = await pressSlack();
    await expect(body()).toHaveValue(slackPreview);
    await expect(target()).toHaveText("選んでください");
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

  it("locks the edit field and the apply button while the post is on its way, and frees them when it fails", async () => {
    await openCompose();
    await chooseGeneral();
    await mock("claude_proofread_slack", proofreadEdit);
    await $("#slack-proofread").click();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(applyButton()).toBeEnabled();
    const slackPost = await mock("slack_post", holds);
    await post().click();
    await waitForCalls(slackPost);
    await expect(body()).toBeDisabled();
    await expect(applyButton()).toBeDisabled();
    await expect($("#slack-log .diff-stale")).not.toBeDisplayed();
    await release(slackPost, rejects("チャンネルに投稿する権限がありません"));
    await expect($("#slack-error")).toHaveText(expect.stringContaining("チャンネルに投稿する権限がありません"));
    await expect(body()).toBeEnabled();
    await expect(applyButton()).toBeEnabled();
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
    await release(slackPost, true);
    await expect($(".toast")).toHaveText("Example Team の #general に貼りました");
    await expect($("#slack-compose")).toBeDisplayed();
    await expect($("#thread")).not.toBeDisplayed();
    await expect($("#slack-subject")).toHaveText("Second unread");
    await expect(target()).toHaveText("選んでください");
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
    await body().setValue("My own text");
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
  it("keeps its header text, the 校正する button, the text send button, the key hint and the diff card without コピー", async () => {
    await openCompose();
    await chooseGeneral();
    await expect($("#slack-chat")).toHaveAttribute("aria-label", "Claude と校正");
    await expect($("#slack-chat .chat-head")).toHaveText(expect.stringContaining("Claude と校正"));
    await expect($("#slack-proofread")).toHaveText("校正する");
    await expect($("#slack-send")).toHaveText("送信");
    await expect($("#slack-input")).toHaveAttribute("placeholder", "どう直したいかを書く");
    await expect($("#slack-keys")).not.toHaveText("");
    await mock("claude_proofread_slack", proofreadEdit);
    await $("#slack-proofread").click();
    await waitForCount("#slack-log .chat-ai", 1);
    expect(await textsOf("#slack-log .diff-foot .text-btn")).toEqual(["却下", "適用"]);
  });

  it("sends 校正してください with the text, and applying the proposal changes the edit field without posting", async () => {
    await openCompose();
    await chooseGeneral();
    const slackPost = await mock("slack_post", true);
    const edit = await mock("claude_proofread_slack", proofreadEdit);
    await $("#slack-proofread").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "校正してください" }]);
    await waitForCount("#slack-log .chat-ai", 1);
    await expect($("#slack-log .chat-user")).toHaveText("校正してください");
    await expect($("#slack-log .diff-ins")).toHaveText("+ Hello from Alice。");
    await expect(applyButton()).toBeEnabled();
    await applyButton().click();
    await expect(body()).toHaveValue(proofreadEdit.body as string);
    await expect($("#slack-log .diff-state")).toHaveText("適用しました");
    expect(await callsOf(slackPost)).toEqual([]);
    await expect($("#slack-compose")).toBeDisplayed();
  });

  it("sends a typed request with the text and the conversation so far", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", proofreadEdit);
    await $("#slack-input").setValue("敬語にして");
    await $("#slack-send").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "敬語にして" }]);
    await waitForCount("#slack-log .chat-ai", 1);
    await $("#slack-proofread").click();
    const calls = await waitForCalls(edit, 2);
    expect(calls[1]).toEqual({
      text: slackPreview,
      history: [
        { role: "user", text: "敬語にして" },
        { role: "assistant", text: proofreadEdit.reply },
      ],
      instruction: "校正してください",
    });
  });

  it("cannot apply an old proposal once the edit field was changed", async () => {
    await openCompose();
    await mock("claude_proofread_slack", proofreadEdit);
    await $("#slack-proofread").click();
    await waitForCount("#slack-log .chat-ai", 1);
    await expect(applyButton()).toBeEnabled();
    await body().setValue(`${slackPreview} (edited)`);
    await expect(applyButton()).toBeDisabled();
    await expect($("#slack-log .diff-stale")).toBeDisplayed();
    // Putting the text back makes it applicable again.
    await body().setValue(slackPreview);
    await expect(applyButton()).toBeEnabled();
  });

  it("proofreads while an API key is in use", async () => {
    await openCompose(claudeKeyReady);
    await expect($("#slack-proofread")).toBeEnabled();
    const edit = await mock("claude_proofread_slack", proofreadEdit);
    await $("#slack-proofread").click();
    expect(await waitForCalls(edit)).toEqual([{ text: slackPreview, history: [], instruction: "校正してください" }]);
    await waitForCount("#slack-log .chat-ai", 1);
  });

  it("is off with a note while Claude is not logged in", async () => {
    await openCompose(claudeLoggedOut);
    await expect($("#slack-proofread")).toBeDisabled();
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
    await $("#slack-proofread").click();
    await waitForCalls(edit);
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    await expect(body()).toHaveValue(slackPreview);
    await release(edit, proofreadEdit);
    // Give a wrongly kept answer the time to be drawn.
    await browser.pause(300);
    expect(await count("#slack-log .chat-ai")).toBe(0);
    expect(await count("#slack-log .pending")).toBe(0);
    await expect($("#slack-proofread")).toBeEnabled();
  });

  it("keeps the request off, with no thinking line, until the answer dropped by a new draft arrives", async () => {
    await openCompose();
    const edit = await mock("claude_proofread_slack", holds);
    await $("#slack-proofread").click();
    await waitForCalls(edit);
    await expect($("#slack-log .pending")).toExist();
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    // The old request is still on its way: it is not shown as the new draft's, and no second request can start.
    expect(await count("#slack-log .pending")).toBe(0);
    await expect($("#slack-proofread")).toBeDisabled();
    await expect($("#slack-input")).toBeDisabled();
    await expect($("#slack-send")).toBeDisabled();
    await release(edit, proofreadEdit);
    await expect($("#slack-proofread")).toBeEnabled();
    await expect($("#slack-input")).toBeEnabled();
    expect(await count("#slack-log .chat-ai")).toBe(0);
  });

  it("starts the request field one line high again when another mail's compose screen opens", async () => {
    await openCompose();
    const height = () => browser.execute(() => document.getElementById("slack-input")!.getBoundingClientRect().height);
    await browser.execute(() => {
      const input = document.getElementById("slack-input") as HTMLTextAreaElement;
      input.value = "一行目\n二行目\n三行目\n四行目";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => (await height()) > 20, { timeoutMsg: "the request field did not grow" });
    await openOtherMail("Second unread", "Another text");
    await pressSlack();
    await expect($("#slack-input")).toHaveValue("");
    expect(await height()).toBe(20);
  });

  it("forgets the conversation with two presses of クリア", async () => {
    await openCompose();
    await mock("claude_proofread_slack", proofreadEdit);
    await expect($("#slack-clear")).toBeDisabled();
    await $("#slack-proofread").click();
    await waitForCount("#slack-log .chat-ai", 1);
    await $("#slack-clear").click();
    await expect($("#slack-clear")).toHaveText("もう一度押すとクリア");
    await $("#slack-clear").click();
    await waitForCount("#slack-log .chat-ai", 0);
    await expect($("#slack-clear")).toBeDisabled();
    await expect(body()).toHaveValue(slackPreview);
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
