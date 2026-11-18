import { account, boot, CARD, CARDS, checked, claudeMissing, count, inbox, logged, mock, onceId, rejects, rowOf, slackLoad, textsOf, waitForCalls, waitForCount, waitForLog } from "../support";

// A-28: a failure of something the user did is written to the log and shown on a card at the bottom right. The reads and syncs that fail are in the specs of their screens (the log only).

// Presses the archive button of the row with `subject`.
async function archive(subject: string) {
  const row = rowOf("unread-threads", subject);
  await row.moveTo();
  await row.$(".archive-row").click();
}

describe("the failure cards", () => {
  beforeEach(async () => {
    await boot({ inbox: inbox() });
    await waitForCount("#unread-threads li", 2);
  });

  it("writes the failure of an operation to the log, and shows it on a card with the way to the log and a close button", async () => {
    await mock("archive", rejects("Gmail が断りました"));
    await archive("First unread");
    await waitForLog("Gmail が断りました");
    expect(await logged()).toEqual([{ level: "error", source: "inbox", message: "Gmail が断りました" }]);
    await expect($(CARD)).toHaveText("Gmail が断りました");
    expect(await count(CARDS)).toBe(1);
    await expect($(`${CARDS} .error-card-log`)).toHaveText("ログを見る");
    await expect($(`${CARDS} .error-card-close`)).toHaveAttribute("aria-label", "閉じる");
    // The card is at the bottom right of the window, above the footer.
    const place = await browser.execute(() => {
      const card = document.querySelector("#error-cards .error-card")!.getBoundingClientRect();
      const footer = document.getElementById("footer")!.getBoundingClientRect();
      return { right: window.innerWidth - card.right, aboveFooter: card.bottom <= footer.top, belowMiddle: card.top > window.innerHeight / 2 };
    });
    expect(place).toEqual({ right: 16, aboveFooter: true, belowMiddle: true });
  });

  it("puts the newest card on top, and keeps each until its close button is pressed", async () => {
    await mock("archive", rejects("one"));
    await archive("First unread");
    await expect($(CARD)).toHaveText("one");
    await waitForCount("#unread-threads li", 2);
    await mock("archive", rejects("two"));
    await archive("Second unread");
    await browser.waitUntil(async () => (await textsOf(CARD)).length === 2);
    expect(await textsOf(CARD)).toEqual(["two", "one"]);
    await $(`${CARDS}:first-child .error-card-close`).click();
    expect(await textsOf(CARD)).toEqual(["one"]);
    await $(`${CARDS} .error-card-close`).click();
    await expect($(CARDS)).not.toExist();
  });

  it("draws a text that a card shows already once, and writes every failure to the log", async () => {
    await mock("archive", rejects("same"));
    await archive("First unread");
    await waitForCalls("archive");
    await waitForCount("#unread-threads li", 2);
    await archive("First unread");
    await waitForCalls("archive", 2);
    await browser.waitUntil(async () => (await logged()).length === 2);
    expect(await count(CARDS)).toBe(1);
  });

  it("opens the Log tab of the settings with ログを見る, and leaves the card", async () => {
    await boot({ inbox: inbox(), slack_load: slackLoad, slack_check: checked([]), claude_status: claudeMissing, log_read: [] });
    await waitForCount("#unread-threads li", 2);
    await mock("archive", rejects("Gmail が断りました"));
    await archive("First unread");
    await $(`${CARDS} .error-card-log`).click();
    await expect($("#settings")).toBeDisplayed();
    await expect($("#settings-panel-log")).toBeDisplayed();
    expect((await waitForCalls("log_read")).length).toBe(1);
    await expect($(CARD)).toHaveText("Gmail が断りました");
  });
});

describe("the cards of a login that must be done again", () => {
  const needing = () => ({ ...inbox(), needsLogin: [account] });

  it("shows a card for an account that must log in again, with a button that logs it in", async () => {
    await boot({ inbox: needing() });
    await expect($(CARD)).toHaveText(`${account} は再ログインが必要です`);
    await expect($(`${CARDS} .error-card-login`)).toHaveText("再ログイン");
    await expect($(`${CARDS} .error-card-log`)).not.toExist();
    expect(await logged()).toEqual([]);
    const login = await mock("login", null);
    await mock("inbox", inbox());
    await $(`${CARDS} .error-card-login`).click();
    expect(await waitForCalls(login)).toEqual([{ loginHint: account }]);
    // The account has logged in: its card goes.
    await expect($(CARDS)).not.toExist();
  });

  it("makes the card once, and not again after it was closed while the account still needs it", async () => {
    await boot({ inbox: needing() });
    await expect($(CARDS)).toBeDisplayed();
    await $(`${CARDS} .error-card-close`).click();
    await expect($(CARDS)).not.toExist();
    // A load that finds the account in the same need draws no card.
    const sync = await mock("sync", { kind: "needsLogin" });
    await mock("inbox", needing());
    await browser.execute((id) => {
      if (!window.__e2e_once__(id)) return;
      document.dispatchEvent(new Event("visibilitychange"));
    }, onceId());
    await waitForCalls(sync);
    await waitForCalls("inbox");
    await browser.pause(300);
    await expect($(CARDS)).not.toExist();
  });
});
