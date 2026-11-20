import { askScreen, boot, callsOf, claudeReady, count, holds, inbox, mock, release, rowOf, textsOf, threadDetail, threadLoaded, waitForCalls, waitForCount } from "../support";

// M-10, M-11 (#490, #1106): the right side of an open thread and of a new mail, which holds the Claude Code pane of A-36 (closed until the owner opens it) and the pane to Orca (A-9) by two icons, and the fields of the reply and of the new mail that Claude Code reads and writes through the target "mail-draft".
describe("mail: the right side and Claude Code", () => {
  const alice = "Alice <alice@example.com>";
  const body = "10 月分の請求書の金額が、画面と 1,200 円違っています。";
  const subject = "請求書の金額が画面と合わない件";
  const term = "#mail-claude-term";
  // What `claude_thread_data` answers: Rust's text, which the screen gives to Claude Code as it is.
  const threadData = "スレッドのメッセージ（古い順）:\nBEGIN abc\nAlice: 10 月分の請求書\nEND abc";
  const read = () => askScreen("read", "mail-draft");
  const starts = async () => ((await callsOf("claude_code_start")) as { id: string }[]).filter((c) => c.id === "mail-claude") as unknown[];
  const waitForStarts = async (n = 1) => {
    await browser.waitUntil(async () => (await starts()).length >= n, { timeoutMsg: `claude_code_start of mail-claude was not called ${n} times` });
    return starts();
  };
  const fieldText = () => browser.execute(() => (document.querySelector("#mail-reply-body-input .ProseMirror") as HTMLElement).innerText.trim());
  const fieldIs = (text: string) => browser.waitUntil(async () => (await fieldText()) === text, { timeoutMsg: `the field never held "${text}"` });
  const chips = (id: string, kind: "to" | "cc" | "bcc") => textsOf(`#${id}-${kind}-field .mail-reply-chip > span`);

  // Opens the thread "First unread" with the one message `body`.
  async function openThread() {
    const detail = threadDetail(subject, body, false);
    await mock("thread", detail);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#thread-subject")).toHaveText(subject);
    await threadLoaded();
    return detail;
  }
  // Presses the ✳ and waits until the pane shows the terminal.
  const openClaude = async () => {
    await $("#mail-tool-claude").click();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  };
  const compose = async () => {
    await $("#mail-compose").click();
    await expect($("#new-mail")).toBeDisplayed();
  };

  beforeEach(async () => {
    await boot({ inbox: inbox(), claude_status: claudeReady });
    await waitForCount("#unread-threads li", 2);
  });

  it("shows the right side with a thread and with a new mail, and not on the list, with the two icons in its first row and the pane of Claude under it", async () => {
    await expect($("#mail-side")).not.toBeDisplayed();
    await expect($("#mail-split")).not.toBeDisplayed();
    await openThread();
    await expect($("#mail-side")).toBeDisplayed();
    await expect($("#mail-split")).toBeDisplayed();
    expect(await browser.execute(() => [...document.querySelectorAll("#mail-tools > *")].map((e) => [e.id, e.getAttribute("aria-label"), e.getAttribute("aria-pressed")]))).toEqual([
      ["mail-tool-claude", "Claude に相談", "false"],
      ["mail-tool-orca", "Orca に渡す", "false"],
    ]);
    // The first row is a place to drag the window by, as high as the header at the left, and meets its line; the pane's heading has Claude and やり直す.
    await expect($("#mail-tools")).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(
      await browser.execute(() => {
        const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
        return { top: box("mail-side").top, bands: [box("mail-tools").height, box("mail-header").height], lines: [box("mail-tools").bottom, box("mail-header").bottom], head: box("mail-claude").top - box("mail-tools").bottom };
      }),
    ).toEqual({ top: 0, bands: [44, 44], lines: [44, 44], head: 0 });
    await expect($("#mail-claude")).toHaveAttribute("aria-label", "Claude");
    // Closed at first: the question and the button, no heading and no terminal.
    expect(await textsOf("#mail-claude-ask p")).toEqual(["Claude に相談しますか？"]);
    expect(await textsOf("#mail-claude-ask button")).toEqual(["相談する"]);
    await expect($("#mail-claude .chat-head")).not.toBeDisplayed();
    await expect($(term)).not.toBeDisplayed();
    await $("#mail-claude-open").click();
    await expect($("#mail-claude-ask")).not.toBeDisplayed();
    await expect($("#mail-claude .chat-head")).toHaveText(expect.stringContaining("Claude"));
    expect(await textsOf("#mail-claude .chat-head > #mail-claude-restart")).toEqual(["やり直す"]);
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($("#mail-handoff")).not.toBeDisplayed();
    // The button that was in the row above the subject has moved to the right side, and nothing of the old conversation is left.
    expect(await count("#thread-orca")).toBe(0);
    await $("#back").click();
    await expect($("#mail-side")).not.toBeDisplayed();
    await compose();
    await expect($("#mail-side")).toBeDisplayed();
    await expect($("#mail-tool-orca")).not.toBeDisplayed();
    // A new mail is closed too.
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "false");
    await expect($("#mail-claude-ask")).toBeDisplayed();
    await openClaude();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "true");
  });

  it("ends the reply field and the band of a new mail on the line where the pane ends", async () => {
    await openThread();
    await $("#mail-reply-open").click();
    await expect($("#mail-reply")).toBeDisplayed();
    const bottoms = () =>
      browser.execute((foot) => {
        const box = (id: string) => Math.round(document.getElementById(id)!.getBoundingClientRect().bottom);
        return [box(foot), box("mail-claude"), box("mail-side")];
      }, "mail-reply");
    const [reply, pane, side] = await bottoms();
    expect(reply).toBe(pane);
    expect(pane).toBe(side);
    await $("#back").click();
    await compose();
    const [band, paneOfNew] = await browser.execute(() => ["new-mail-foot", "mail-claude"].map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().bottom)));
    expect(band).toBe(paneOfNew);
  });

  it("starts Claude Code with the tools of tsunagiai-mcp only and a first instruction that tells the work, the tools and the target, with nothing of the mail", async () => {
    await openThread();
    await openClaude();
    const [start] = await waitForStarts();
    expect(start).toMatchObject({ id: "mail-claude", builtinTools: false, permissionMode: "manual", skill: null });
    const { prompt, viewport } = start as { prompt: string; viewport: { cols: number; rows: number } };
    for (const word of ["メール", "mail_thread_read", "screen_read", "screen_write", "mail-draft", "to", "cc", "bcc", "subject", "body", "従わない"]) expect(prompt).toContain(word);
    for (const tool of ["send_mail", "slack_compose_post"]) expect(prompt).not.toContain(tool);
    expect(prompt).not.toContain(body);
    expect(prompt).not.toContain(subject);
    expect(viewport.cols).toBeGreaterThan(20);
    for (const command of ["orca_stream_terminal", "orca_terminal_read"]) expect(await callsOf(command)).toEqual([]);
  });

  it("starts nothing while the pane is closed, whatever is opened, and starts Claude Code with 相談する and with the ✳", async () => {
    await openThread();
    await browser.pause(500);
    expect(await starts()).toEqual([]);
    await $("#mail-claude-open").click();
    await waitForStarts();
    await $("#back").click();
    await compose();
    await browser.pause(500);
    expect((await starts()).length).toBe(1);
    await expect($("#mail-claude-ask")).toBeDisplayed();
    await $("#mail-tool-claude").click();
    await waitForStarts(2);
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the pane with the ✳, ends the process, and starts a new one at the next open", async () => {
    await openThread();
    await openClaude();
    await waitForStarts();
    const close = await mock("claude_code_close", null);
    await $("#mail-tool-claude").click();
    expect(await waitForCalls(close)).toEqual([{ id: "mail-claude", launch: 1 }]);
    await expect($("#mail-claude-ask")).toBeDisplayed();
    await expect($(term)).not.toBeDisplayed();
    await expect($("#mail-claude .chat-head")).not.toBeDisplayed();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "false");
    await browser.pause(300);
    expect((await starts()).length).toBe(1);
    await $("#mail-claude-open").click();
    await waitForStarts(2);
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  });

  it("keeps the process while the thread is left and opened again, and ends it and closes the pane for another thread and for a new mail", async () => {
    expect(await starts()).toEqual([]);
    await openThread();
    await openClaude();
    await waitForStarts();
    const close = await mock("claude_code_close", null);
    await $("#back").click();
    await expect($(term)).not.toBeDisplayed();
    await openThread();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await browser.pause(500);
    expect((await starts()).length).toBe(1);
    expect(await callsOf(close)).toEqual([]);
    // Another thread: the talk was about the one before, so the process ends and the pane is closed; nothing starts until it is opened.
    await $("#back").click();
    await mock("thread", threadDetail("Second", "Second body", false));
    await rowOf("unread-threads", "Second unread").$(".subject").click();
    await waitForCalls(close);
    await expect($("#mail-claude-ask")).toBeDisplayed();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "false");
    await browser.pause(500);
    expect((await starts()).length).toBe(1);
    await openClaude();
    await waitForStarts(2);
    // A new mail is another draft again, and so is the next new mail.
    await $("#back").click();
    await compose();
    await waitForCalls(close, 2);
    await expect($("#mail-claude-ask")).toBeDisplayed();
    await openClaude();
    await waitForStarts(3);
    await $("#new-mail-back").click();
    await compose();
    await waitForCalls(close, 3);
    await expect($("#mail-claude-ask")).toBeDisplayed();
    expect((await starts()).length).toBe(3);
  });

  it("ends the process and starts a new one with やり直す", async () => {
    await openThread();
    await openClaude();
    await waitForStarts();
    const close = await mock("claude_code_close", null);
    await $("#mail-claude-restart").click();
    expect(await waitForCalls(close)).toEqual([{ id: "mail-claude", launch: 1 }]);
    expect(await waitForStarts(2)).toHaveLength(2);
    await expect($("#mail-claude-restart")).toBeEnabled();
  });

  it("switches between Claude and Orca by the two icons, keeps the process of Claude open, and shows the ✳ pressed only while Claude is open and shown", async () => {
    await openThread();
    await openClaude();
    await waitForStarts();
    const close = await mock("claude_code_close", null);
    await $("#mail-tool-orca").click();
    await expect($("#mail-handoff")).toBeDisplayed();
    await expect($("#mail-claude")).not.toBeDisplayed();
    await expect($("#mail-tool-orca")).toHaveAttribute("aria-pressed", "true");
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "false");
    // Pressing the icon of the pane that is shown changes nothing.
    await $("#mail-tool-orca").click();
    await expect($("#mail-handoff")).toBeDisplayed();
    // The ✳ shows Claude open: the process is the one that was running.
    await $("#mail-tool-claude").click();
    await expect($("#mail-handoff")).not.toBeDisplayed();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await expect($("#mail-tool-orca")).toHaveAttribute("aria-pressed", "false");
    await browser.pause(300);
    expect((await starts()).length).toBe(1);
    expect(await callsOf(close)).toEqual([]);
  });

  it("shows Claude open from the pane to Orca by the ✳ when it was closed, and shows it as it was by the close icon of the pane to Orca", async () => {
    await openThread();
    await $("#mail-tool-orca").click();
    await expect($("#mail-handoff")).toBeDisplayed();
    // Closed before: the close icon shows the question again, and nothing starts.
    await $("#mail-handoff [aria-label=\"閉じる\"]").click();
    await expect($("#mail-handoff")).not.toBeDisplayed();
    await expect($("#mail-claude-ask")).toBeDisplayed();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "false");
    await browser.pause(300);
    expect(await starts()).toEqual([]);
    // The ✳ from the pane to Orca opens it.
    await $("#mail-tool-orca").click();
    await $("#mail-tool-claude").click();
    await expect($("#mail-handoff")).not.toBeDisplayed();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await waitForStarts();
    // Open before: the close icon shows the terminal as it was, with the same process.
    await $("#mail-tool-orca").click();
    await $("#mail-handoff [aria-label=\"閉じる\"]").click();
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($("#mail-tool-claude")).toHaveAttribute("aria-pressed", "true");
    await browser.pause(300);
    expect((await starts()).length).toBe(1);
  });

  it("answers a read with the thread as Rust encloses it, the recipients of the reply, the subject and the text of the field", async () => {
    const detail = await openThread();
    const data = await mock("claude_thread_data", threadData);
    expect(await read()).toEqual({ ok: true, fields: { thread: threadData, to: alice, cc: "", bcc: "", subject, body: "" } });
    // The messages go to Rust as the screen shows them: the sender, the date in seconds, and the text.
    expect(await callsOf(data)).toEqual([{ thread: [{ name: alice, ts: `${Math.floor(detail.messages[0].dateMs / 1000)}.000000`, text: body }], truncated: false }]);
    // The reply field is hidden until the reply button, and a read does not show it.
    await expect($("#mail-reply")).not.toBeDisplayed();
  });

  it("answers an error for the fields when no reply or new mail is open", async () => {
    expect(await read()).toEqual({ ok: false, error: expect.stringContaining("画面が開いていません") });
    expect((await askScreen("write", "mail-draft", { body: "x" })).ok).toBe(false);
    await openThread();
    await $("#back").click();
    expect((await read()).ok).toBe(false);
    await expect($("#threads")).toBeDisplayed();
  });

  it("writes the text as it is into the reply, shows the field, sends nothing, and takes it back with 元に戻す", async () => {
    await openThread();
    await mock("claude_thread_data", threadData);
    const send = await mock("send_mail", true);
    await expect($("#mail-reply-undo")).not.toBeDisplayed();
    expect(await askScreen("write", "mail-draft", { body: "ご連絡ありがとうございます。\n\n- 1\n- 2" })).toEqual({ ok: true });
    await expect($("#mail-reply")).toBeDisplayed();
    await browser.waitUntil(async () => (await fieldText()).startsWith("ご連絡ありがとうございます。"));
    await expect($("#mail-reply-send")).toBeEnabled();
    await expect($("#mail-reply-undo")).toHaveText("元に戻す");
    expect(await callsOf(send)).toEqual([]);
    expect(await read()).toMatchObject({ ok: true, fields: { body: "ご連絡ありがとうございます。\n\n* 1\n* 2\n" } });
    await $("#mail-reply-undo").click();
    await fieldIs("");
    await expect($("#mail-reply-undo")).not.toBeDisplayed();
    await expect($("#mail-reply-send")).toBeDisabled();
    expect(await callsOf(send)).toEqual([]);
  });

  it("writes the recipients of the reply, opens Cc and Bcc for them, and takes them back", async () => {
    await openThread();
    await mock("claude_thread_data", threadData);
    // A comma inside quotes or angle brackets does not end an address.
    expect(await askScreen("write", "mail-draft", { to: '"Doe, John" <dan@example.com>; eve@example.com', cc: "frank@example.com", bcc: "gina@example.com, hal@example.com" })).toEqual({ ok: true });
    expect(await chips("mail-reply", "to")).toEqual(['"Doe, John" <dan@example.com>', "eve@example.com"]);
    expect(await chips("mail-reply", "cc")).toEqual(["frank@example.com"]);
    expect(await chips("mail-reply", "bcc")).toEqual(["gina@example.com", "hal@example.com"]);
    await expect($("#mail-reply-cc-row")).toBeDisplayed();
    await expect($("#mail-reply-bcc-row")).toBeDisplayed();
    expect(await read()).toMatchObject({ ok: true, fields: { to: '"Doe, John" <dan@example.com>, eve@example.com', cc: "frank@example.com", bcc: "gina@example.com, hal@example.com" } });
    await $("#mail-reply-undo").click();
    expect(await chips("mail-reply", "to")).toEqual(["Alice"]);
    expect(await chips("mail-reply", "cc")).toEqual([]);
    expect(await chips("mail-reply", "bcc")).toEqual([]);
    await expect($("#mail-reply-undo")).not.toBeDisplayed();
  });

  it("sends what Claude Code wrote only when the owner presses 送信, with the recipients and the text as they are in the fields", async () => {
    await openThread();
    await mock("claude_thread_data", threadData);
    const send = await mock("send_mail", true);
    await mock("thread", threadDetail(subject, body, false));
    await askScreen("write", "mail-draft", { to: "dan@example.com", body: "確認しました。" });
    await fieldIs("確認しました。");
    expect(await callsOf(send)).toEqual([]);
    await $("#mail-reply-send").click();
    const [call] = (await waitForCalls(send)) as { mail: { to: string[]; subject: string; body: string; markdown: boolean } }[];
    expect(call.mail).toMatchObject({ to: ["dan@example.com"], subject, body: "確認しました。\n", markdown: true });
    // The way back is gone with the draft.
    await expect($("#mail-reply-undo")).not.toBeDisplayed();
  });

  it("refuses the field thread, the subject of a reply and a field that does not exist, and changes nothing", async () => {
    await openThread();
    expect(await askScreen("write", "mail-draft", { thread: "x" })).toEqual({ ok: false, error: expect.stringContaining("読むだけ") });
    expect(await askScreen("write", "mail-draft", { subject: "別の件名", body: "x" })).toEqual({ ok: false, error: expect.stringContaining("件名のまま") });
    expect(await askScreen("write", "mail-draft", { to: "a@example.com", other: "y" })).toEqual({ ok: false, error: expect.stringContaining("欄 other はありません") });
    await expect($("#mail-reply")).not.toBeDisplayed();
    expect(await chips("mail-reply", "to")).toEqual(["Alice"]);
    await expect($("#mail-reply-undo")).not.toBeDisplayed();
  });

  it("takes the writes back one by one, the newest first, and has no way back for a write that changes nothing", async () => {
    await openThread();
    await mock("claude_thread_data", threadData);
    await askScreen("write", "mail-draft", { body: "First" });
    await fieldIs("First");
    await askScreen("write", "mail-draft", { body: "Second" });
    await fieldIs("Second");
    await $("#mail-reply-undo").click();
    await fieldIs("First");
    await expect($("#mail-reply-undo")).toBeDisplayed();
    await $("#mail-reply-undo").click();
    await fieldIs("");
    await expect($("#mail-reply-undo")).not.toBeDisplayed();
    await askScreen("write", "mail-draft", { body: "" });
    await expect($("#mail-reply-undo")).not.toBeDisplayed();
  });

  it("has no way back left once the owner changed the field by hand", async () => {
    await openThread();
    await askScreen("write", "mail-draft", { body: "Written" });
    await fieldIs("Written");
    await expect($("#mail-reply-undo")).toBeDisplayed();
    await $("#mail-reply-body-input .ProseMirror").click();
    await browser.keys("!".split(""));
    await expect($("#mail-reply-undo")).not.toBeDisplayed();
  });

  it("refuses a write while the reply is on its way", async () => {
    await openThread();
    const send = await mock("send_mail", holds);
    await askScreen("write", "mail-draft", { body: "Mine" });
    await fieldIs("Mine");
    await $("#mail-reply-send").click();
    await waitForCalls(send);
    expect(await askScreen("write", "mail-draft", { body: "Late" })).toEqual({ ok: false, error: expect.stringContaining("送信の最中") });
    await mock("thread", threadDetail(subject, body, false));
    await release(send, true);
    await fieldIs("");
  });

  describe("a new mail", () => {
    it("answers a read with the fields of the screen and a fixed line for the thread, and asks Rust for nothing", async () => {
      const data = await mock("claude_thread_data", threadData);
      await compose();
      expect(await read()).toEqual({ ok: true, fields: { thread: "新規作成です。読むスレッドはありません", to: "", cc: "", bcc: "", subject: "", body: "" } });
      expect(await callsOf(data)).toEqual([]);
    });

    it("writes the five fields as they are, sends nothing, and takes them back with 元に戻す", async () => {
      await compose();
      const send = await mock("send_mail", true);
      await expect($("#new-mail-undo")).not.toBeDisplayed();
      expect(await askScreen("write", "mail-draft", { to: "dan@example.com", cc: "eve@example.com", bcc: "frank@example.com", subject: "ご確認のお願い", body: "お世話になっております。\n確認をお願いします。" })).toEqual({ ok: true });
      expect(await chips("new-mail", "to")).toEqual(["dan@example.com"]);
      expect(await chips("new-mail", "cc")).toEqual(["eve@example.com"]);
      expect(await chips("new-mail", "bcc")).toEqual(["frank@example.com"]);
      await expect($("#new-mail-subject")).toHaveValue("ご確認のお願い");
      await expect($("#new-mail-body")).toHaveValue("お世話になっております。\n確認をお願いします。");
      await expect($("#new-mail-send")).toBeEnabled();
      await expect($("#new-mail-undo")).toHaveText("元に戻す");
      expect(await callsOf(send)).toEqual([]);
      expect(await read()).toMatchObject({ ok: true, fields: { to: "dan@example.com", subject: "ご確認のお願い", body: "お世話になっております。\n確認をお願いします。" } });
      await $("#new-mail-undo").click();
      expect(await chips("new-mail", "to")).toEqual([]);
      await expect($("#new-mail-subject")).toHaveValue("");
      await expect($("#new-mail-body")).toHaveValue("");
      await expect($("#new-mail-undo")).not.toBeDisplayed();
      expect(await callsOf(send)).toEqual([]);
    });

    it("sends the fields as Claude Code wrote them when the owner presses 送信, and the way back is gone with the draft", async () => {
      await compose();
      const send = await mock("send_mail", true);
      await askScreen("write", "mail-draft", { to: "dan@example.com", subject: "S", body: "B" });
      await $("#new-mail-send").click();
      const [call] = (await waitForCalls(send)) as { mail: { to: string[]; subject: string; body: string } }[];
      expect(call.mail).toMatchObject({ to: ["dan@example.com"], subject: "S", body: "B" });
      await expect($("#threads")).toBeDisplayed();
      await compose();
      await expect($("#new-mail-undo")).not.toBeDisplayed();
    });

    it("has no way back left once the owner typed in the subject, and refuses a write while the mail goes out", async () => {
      await compose();
      await askScreen("write", "mail-draft", { subject: "Written", body: "B" });
      await expect($("#new-mail-undo")).toBeDisplayed();
      await $("#new-mail-subject").click();
      await browser.keys("!".split(""));
      await expect($("#new-mail-undo")).not.toBeDisplayed();
      const send = await mock("send_mail", holds);
      await $("#new-mail-send").click();
      await waitForCalls(send);
      expect(await askScreen("write", "mail-draft", { body: "Late" })).toEqual({ ok: false, error: expect.stringContaining("送信の最中") });
      await release(send, true);
    });
  });
});
