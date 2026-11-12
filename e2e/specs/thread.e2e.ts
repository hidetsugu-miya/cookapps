import {
  account, boot, callsOf, claudeKeyReady, claudeLoggedOut, claudeReady, connection, count, holds, inbox, mock, rejects, release, rowOf, textsOf, threadDetail, threadLoaded, waitForCalls, waitForCount, waitForText,
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
    await threadLoaded();
    await expect($("#messages .plain")).toHaveText("Hello from Alice");
    await waitForCalls(open);
    expect(await callsOf(open)).toContainEqual({ account, id: "t1" });
    await waitForCalls(setRead);
    expect(await callsOf(setRead)).toContainEqual({ account, id: "t1", read: true });
    await waitForCount("#unread-threads li", 1);
  });

  it("makes the header of the thread a place to drag the window by, and keeps its buttons pressable", async () => {
    await mock("thread", threadDetail("First unread", "Hello from Alice", true));
    await mock("set_read", true);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await threadLoaded();
    await expect($("#mail-header")).toBeDisplayed();
    await expect($("#mail-header")).toHaveAttribute("data-tauri-drag-region", "deep");
    await expect($("#back")).not.toHaveAttribute("data-tauri-drag-region");
    await $("#back").click();
    await expect($("#threads")).toBeDisplayed();
  });

  it("holds only the back button in the header, and puts the operations in a row just above the subject, lined up with it", async () => {
    await mock("thread", threadDetail("First unread", "Hello from Alice", true));
    await mock("set_read", true);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await threadLoaded();
    const layout = await browser.execute(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const ids = (s: string) => [...document.querySelectorAll(s)].map((b) => b.id);
      const first = document.querySelector<HTMLElement>("#thread-actions > button:not([hidden])")!;
      return {
        header: ids("#mail-header > *"),
        headerHeight: box("#mail-header").height,
        actions: ids("#thread-actions > button:not([hidden])"),
        actionsInHeader: document.querySelector("#mail-header #thread-actions") !== null,
        size: [first.getBoundingClientRect().width, first.getBoundingClientRect().height],
        icon: [first.querySelector("svg")!.getBoundingClientRect().width, first.querySelector("svg")!.getBoundingClientRect().height],
        leftOfSubject: Math.round(first.getBoundingClientRect().left - box("#thread-head").left),
        aboveSubject: box("#thread-actions").bottom <= box("#thread-head").top,
      };
    });
    expect(layout).toEqual({
      header: ["back"],
      headerHeight: 40,
      actions: ["thread-slack", "thread-todo", "thread-orca", "trash", "archive"],
      actionsInHeader: false,
      size: [34, 34],
      icon: [20, 20],
      leftOfSubject: 0,
      aboveSubject: true,
    });
  });

  it("keeps the row of operations at the top of the scrolling area, in the body's color, while a long mail scrolls", async () => {
    await mock("thread", threadDetail("First unread", Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"), true));
    await mock("set_read", true);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await threadLoaded();
    const tops = () =>
      browser.execute(() => ({
        row: Math.round(document.getElementById("thread-actions")!.getBoundingClientRect().top - document.getElementById("main")!.getBoundingClientRect().top),
        subject: Math.round(document.getElementById("thread-head")!.getBoundingClientRect().top),
      }));
    const before = await tops();
    expect(before.row).toBeGreaterThanOrEqual(0);
    await browser.execute(() => {
      document.getElementById("main")!.scrollTop = 600;
    });
    const after = await tops();
    expect(after.row).toBe(0);
    expect(after.subject).toBeLessThan(before.subject - 100);
    expect(await browser.execute(() => getComputedStyle(document.getElementById("thread-actions")!).backgroundColor)).toBe("rgb(255, 255, 255)");
    for (const id of ["#thread-slack", "#thread-todo", "#thread-orca", "#trash", "#archive"]) await expect($(id)).toBeDisplayedInViewport();
  });

  it("opens a read thread without marking it read", async () => {
    const open = await mock("thread", threadDetail("Already read", "Old news", false));
    const setRead = await mock("set_read", true);
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("Already read");
    await threadLoaded();
    await waitForCalls(open);
    expect(await callsOf(open)).toContainEqual({ account, id: "t3" });
    expect(await callsOf(setRead)).toHaveLength(0);
  });

  it("fetches the images of a remembered, authenticated sender by itself, with no bar", async () => {
    const url = "https://images.example.com/a.png";
    const shown = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const base = threadDetail("Already read", "", false);
    const [first] = base.messages;
    const html = { ...first, html: true, authenticated: true, body: `<p>Hi</p><img src="${url}">` };
    await mock("thread", { ...base, messages: [html] });
    await mock("image_sender_known", [first.from]);
    const fetch = await mock("fetch_images", { [url]: shown });
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("Already read");
    await threadLoaded();
    expect(await waitForCalls(fetch)).toEqual([{ urls: [url] }]);
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector<HTMLIFrameElement>("#messages iframe")?.contentDocument?.querySelector("img")?.getAttribute("src")?.startsWith("data:") ?? false),
      { timeoutMsg: "the image was not swapped for its data: URI" },
    );
    expect(await count(".images-bar")).toBe(0);
  });

  it("shows a spinner in place of the Todo button's icon while the task is made from the open thread", async () => {
    await mock("thread", threadDetail("Already read", "Old news", false));
    const make = await mock("todoist_task_from_mail", holds);
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("Already read");
    await threadLoaded();
    await $("#thread-todo").click();
    expect(await waitForCalls(make)).toEqual([{ account, threadId: "t3", subject: "Already read" }]);
    await expect($("#thread-todo .spin")).toExist();
    await expect($("#thread-todo svg")).not.toExist();
    await expect($("#thread-todo")).toBeDisabled();
    await release(make, true);
    await expect($("#thread-todo .spin")).not.toExist();
    await expect($("#thread-todo svg")).toExist();
    await expect($("#thread-todo")).toBeEnabled();
  });
});

// M-2: an HTML body is drawn in its frame, whose document this page reads. WebKit calls no listener inside it, so the checks read the document the way `routeLinks` does.
describe("thread HTML body", () => {
  beforeEach(async () => {
    await boot({ inbox: inbox() });
    await waitForCount("#unread-threads li", 2);
  });

  // Opens a thread of one HTML message and waits until the frame has been written and the links routed.
  async function openHtml(body: string) {
    const base = threadDetail("First unread", "", true);
    await mock("thread", { ...base, messages: [{ ...base.messages[0], html: true, body }] });
    await mock("set_read", true);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await threadLoaded();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          // The mail's body carries `data-ready` and the frame's load (the links are routed in it) is over; the frame starts as an empty, loaded document.
          const doc = document.querySelector<HTMLIFrameElement>("#messages iframe")?.contentDocument;
          return !!doc?.body?.hasAttribute("data-ready") && doc.readyState === "complete";
        }),
      { timeoutMsg: "the frame never loaded the body" },
    );
  }
  // The links of the frame's document, in order.
  const links = () =>
    browser.execute(() =>
      [...document.querySelector<HTMLIFrameElement>("#messages iframe")!.contentDocument!.querySelectorAll("a")].map((a) => ({
        href: a.getAttribute("href"),
        target: a.getAttribute("target"),
        title: a.getAttribute("title"),
        text: a.textContent,
      })),
    );
  // The computed font of the first element `selector` finds in the frame's document.
  const fontIn = (selector: string) =>
    browser.execute((s) => {
      const style = getComputedStyle(document.querySelector<HTMLIFrameElement>("#messages iframe")!.contentDocument!.querySelector(s)!);
      return { family: style.fontFamily.replace(/"/g, ""), size: style.fontSize };
    }, selector);

  it("makes the http(s) URL that stands as text a link that goes the way of every link", async () => {
    await openHtml(
      '<body data-ready><p id="a">See https://example.com/a?x=1&amp;y=2, and (https://example.com/b).</p><p>HTTP://EXAMPLE.COM/Up</p>',
    );
    expect(await links()).toEqual([
      { href: "https://example.com/a?x=1&y=2", target: "_top", title: "https://example.com/a?x=1&y=2", text: "https://example.com/a?x=1&y=2" },
      { href: "https://example.com/b", target: "_top", title: "https://example.com/b", text: "https://example.com/b" },
      { href: "HTTP://EXAMPLE.COM/Up", target: "_top", title: "http://example.com/Up", text: "HTTP://EXAMPLE.COM/Up" },
    ]);
    // The text around the URLs stays as it was.
    const text = await browser.execute(() => document.querySelector<HTMLIFrameElement>("#messages iframe")!.contentDocument!.getElementById("a")!.textContent);
    expect(text).toBe("See https://example.com/a?x=1&y=2, and (https://example.com/b).");
  });

  it("does not wrap a URL that is in a link, and keeps the link as it is", async () => {
    await openHtml(
      '<body data-ready><p><a href="https://example.com/c?r=1">https://example.com/c</a> and <a href="https://example.com/d">go to <b>https://example.com/d</b></a></p>',
    );
    const found = await links();
    expect(found.map((a) => a.href)).toEqual(["https://example.com/c?r=1", "https://example.com/d"]);
    expect(found.every((a) => a.target === "_top")).toBe(true);
    const nested = await browser.execute(() => document.querySelector<HTMLIFrameElement>("#messages iframe")!.contentDocument!.querySelectorAll("a a").length);
    expect(nested).toBe(0);
  });

  it("does not wrap what is not an http(s) URL, or a URL where a link has no place", async () => {
    await openHtml(
      "<body data-ready><p>ftp://example.com/e mailto:bob@example.com www.example.com javascript:alert(1) example.com/f</p>" +
        "<textarea>https://example.com/g</textarea><title>https://example.com/h</title><style>/* https://example.com/i */ p { margin: 0 }</style>" +
        '<svg><text id="s">https://example.com/j</text></svg><button>https://example.com/k</button><p>and the tag &lt;img src=x&gt; https://example.com/l</p>',
    );
    // Only the last URL, in an ordinary paragraph, is a link; the escaped tag is text, not an element.
    expect((await links()).map((a) => a.href)).toEqual(["https://example.com/l"]);
    const inFrame = await browser.execute(() => {
      const doc = document.querySelector<HTMLIFrameElement>("#messages iframe")!.contentDocument!;
      return { img: doc.querySelectorAll("img").length, style: [...doc.querySelectorAll("style")].pop()!.textContent, area: doc.querySelector("textarea")!.value };
    });
    expect(inFrame).toEqual({ img: 0, style: "/* https://example.com/i */ p { margin: 0 }", area: "https://example.com/g" });
  });

  it("draws a mail that names no font in Gmail's, and lets a font the mail names win", async () => {
    await openHtml(
      '<body data-ready><p id="plain">Plain</p><p id="own" style="font-family: Georgia, serif; font-size: 20px">Own</p>' +
        '<font id="face" face="Courier">Face</font><table><tr><td id="cell">Cell</td></tr></table>',
    );
    // The mail has no DOCTYPE, so the table is also checked: quirks mode would give it the browser's size.
    expect(await fontIn("#plain")).toEqual({ family: "Arial, Helvetica, sans-serif", size: "13px" });
    expect(await fontIn("#cell")).toEqual({ family: "Arial, Helvetica, sans-serif", size: "13px" });
    expect(await fontIn("#own")).toEqual({ family: "Georgia, serif", size: "20px" });
    expect((await fontIn("#face")).family).toContain("Courier");
  });

  it("lets the style of the mail itself win over the default font, also for a mail with a DOCTYPE", async () => {
    await openHtml(
      '<!DOCTYPE html><html><head><style>body { font-family: Verdana; font-size: 20px }</style></head><body data-ready><p id="p">Text</p></body></html>',
    );
    expect(await fontIn("#p")).toEqual({ family: "Verdana", size: "20px" });
  });
});

describe("thread loading", () => {
  const headerButtons = ["#thread-slack", "#thread-todo", "#thread-orca", "#trash", "#archive"];

  beforeEach(async () => {
    await boot({ inbox: inbox() });
    await waitForCount("#unread-threads li", 2);
  });

  it("goes to the detail view at once with the subject, the sender and a note, and puts the messages in their place when the thread arrives", async () => {
    const open = await mock("thread", holds);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await waitForCalls(open);
    await expect($("#thread")).toBeDisplayed();
    await expect($("#threads")).not.toBeDisplayed();
    await expect($("#thread-subject")).toHaveText("First unread");
    await expect($("#messages .msg-head .name")).toHaveText("Alice");
    await expect($("#messages .msg-loading")).toHaveText("読み込んでいます…");
    expect(await count("#messages .msg-bars span")).toBe(3);
    for (const id of headerButtons) await expect($(id)).toBeDisabled();
    await expect($("#back")).toBeEnabled();
    await release(open, threadDetail("First unread", "Hello from Alice", false));
    await expect($("#messages .plain")).toHaveText("Hello from Alice");
    await threadLoaded();
    expect(await count("#messages .msg-loading")).toBe(0);
    expect(await count("#messages .msg-bars")).toBe(0);
    for (const id of headerButtons) await expect($(id)).toBeEnabled();
  });

  it("shows the error text in the body's place when the thread cannot be read, and keeps the buttons but the back one disabled", async () => {
    await mock("thread", rejects("Gmail に届きません"));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#messages .msg-fail")).toHaveText("Gmail に届きません");
    await expect($("#thread-subject")).toHaveText("First unread");
    await threadLoaded();
    expect(await count("#messages .msg-loading")).toBe(0);
    for (const id of headerButtons) await expect($(id)).toBeDisabled();
    await expect($("#back")).toBeEnabled();
    await $("#back").click();
    await expect($("#threads")).toBeDisplayed();
  });

  it("goes back to the list while the thread loads, and does not draw the answer that arrives later", async () => {
    const open = await mock("thread", holds);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await waitForCalls(open);
    await $("#back").click();
    await expect($("#threads")).toBeDisplayed();
    await release(open, threadDetail("First unread", "Hello from Alice", false));
    await browser.pause(300);
    await expect($("#threads")).toBeDisplayed();
    await expect($("#thread")).not.toBeDisplayed();
    expect(await count("#messages .plain")).toBe(0);
  });

  it("does not draw the answer of an earlier thread over the one opened after it, nor its failure", async () => {
    const open = await mock("thread", holds);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await waitForCalls(open);
    await $("#back").click();
    await rowOf("unread-threads", "Second unread").$(".subject").click();
    await waitForCalls(open, 2);
    await release(open, rejects("読めません"));
    await browser.pause(300);
    await expect($("#thread-subject")).toHaveText("Second unread");
    await expect($("#messages .msg-loading")).toBeDisplayed();
    expect(await count("#messages .msg-fail")).toBe(0);
    await release(open, threadDetail("Second unread", "Second body", false));
    await expect($("#messages .plain")).toHaveText("Second body");
  });

  it("keeps the Todo button disabled when the next thread arrives while the task of the earlier one is still being made", async () => {
    await mock("thread", threadDetail("First unread", "First body", false));
    const make = await mock("todoist_task_from_mail", holds);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await threadLoaded();
    await $("#thread-todo").click();
    await waitForCalls(make);
    await $("#back").click();
    const open = await mock("thread", holds);
    await rowOf("unread-threads", "Second unread").$(".subject").click();
    await waitForCalls(open);
    await release(open, threadDetail("Second unread", "Second body", false));
    await expect($("#messages .plain")).toHaveText("Second body");
    await expect($("#thread-todo .spin")).toExist();
    await expect($("#thread-todo")).toBeDisabled();
        await release(make, true);
    await expect($("#thread-todo .spin")).not.toExist();
    await expect($("#thread-todo")).toBeEnabled();
  });

  it("stays on the screen the user moved to when the answer says the account must log in again", async () => {
    const open = await mock("thread", holds);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await waitForCalls(open);
    await $("#nav-todo").click();
    await expect($("#todo")).toBeDisplayed();
    await release(open, null);
    await browser.pause(300);
    await expect($("#todo")).toBeDisplayed();
    await expect($("#threads")).not.toBeDisplayed();
  });

  it("goes back to the list when the account is removed while its thread loads, and does not draw the answer that arrives later", async () => {
    const open = await mock("thread", holds);
    await mock("remove_account", null);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await waitForCalls(open);
    await $(`#account-list button[aria-label="${account}"]`).click();
    await $("button=このアカウントを削除").click();
    await $("button=削除").click();
    await expect($("#threads")).toBeDisplayed();
    await expect($("#thread")).not.toBeDisplayed();
    await release(open, threadDetail("First unread", "Hello from Alice", false));
    await browser.pause(300);
    await expect($("#threads")).toBeDisplayed();
    expect(await count("#messages .plain")).toBe(0);
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
      fromName: "Bob",
      fromAddress: "bob@example.com",
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
    await threadLoaded();
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

  it("shows the icon first in the row of operations while Claude is logged in", async () => {
    await open("First unread", quote("Quote"));
    await expect(summaryButton()).toBeDisplayed();
    await expect(summaryButton()).toHaveAttribute("aria-label", "AI 要約");
    const order = await browser.execute(() => [...document.querySelectorAll("#mail-header > button:not([hidden]), #thread-actions > button:not([hidden])")].map((b) => b.id));
    expect(order).toEqual(["back", "thread-summary", "thread-slack", "thread-todo", "thread-orca", "trash", "archive"]);
  });

  it("disables the icon until the thread arrives", async () => {
    const open = await mock("thread", holds);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await waitForCalls(open);
    await expect(summaryButton()).toBeDisplayed();
    await expect(summaryButton()).toBeDisabled();
    await release(open, quote("Quote"));
    await expect($("#thread-subject")).toHaveText("Quote");
    await expect(summaryButton()).toBeEnabled();
  });

  it("follows the Claude state while a thread is open", async () => {
    await open("First unread", quote("Quote"));
    await expect(summaryButton()).toBeDisplayed();
    // The recheck button is on the settings screen; click it in the page as the settings screen would.
    const recheck = () => browser.execute(() => document.getElementById("claude-recheck")!.click());
    await mock("claude_connection", connection("subscription", claudeLoggedOut, { state: "none" }));
    await recheck();
    await expect(summaryButton()).not.toBeDisplayed();
    await mock("claude_connection", connection("subscription", claudeReady, { state: "none" }));
    await recheck();
    await expect(summaryButton()).toBeDisplayed();
  });

  it("shows the icon and sends the thread while an API key is in use", async () => {
    await boot({ inbox: inbox(), claude_status: claudeKeyReady });
    await waitForCount("#unread-threads li", 2);
    const detail = quote("Quote");
    await open("First unread", detail);
    await expect(summaryButton()).toBeDisplayed();
    const call = await mock("claude_summarize_mail", summary);
    await summaryButton().click();
    expect(await waitForCalls(call)).toHaveLength(1);
    await waitForCount("#mail-summary li", 2);
    expect(await textsOf("#mail-summary li")).toEqual(summary.points);
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
