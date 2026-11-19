import { boot, callsOf, fire, holds, image, inbox, mock, note, PNG, rejects, release, rowOf, textsOf, threadDetail, threadLoaded, waitForCalls, waitForCount, CARD, CARDS } from "../support";
import type { PickedAttachment } from "../../ts/bindings/PickedAttachment";

// M-12 (#491): the files of a reply and of a new mail: the clip beside "送信" (the open dialog, which Rust opens), a file dropped on the field or pasted in it, the chips under the text (name, size, ×) and the files that go with `send_mail`.
describe("mail: attaching files", () => {
  const subject = "請求書の件";
  // What `mail_attach_pick` answers for a file: the file's own bytes are `text`.
  const picked = (name: string, text: string, size = text.length): PickedAttachment => ({ name, size, data: btoa(text) });
  const pdf = picked("請求書.pdf", "pdf");
  const NOTE_DATA = note.base64;
  const PNG_SIZE = atob(PNG).length;

  const names = (strip: string) => textsOf(`${strip} .mail-attach-chip > span:first-child`);
  const sizes = (strip: string) => textsOf(`${strip} .mail-attach-size`);
  const pending = (open: string) => browser.execute((id) => (document.getElementById(id) as HTMLButtonElement).disabled, open);

  async function waitForChips(strip: string, n: number) {
    await browser.waitUntil(async () => (await names(strip)).length === n, { timeoutMsg: `${strip} never held ${n} files` });
  }

  describe("the reply field", () => {
    const strip = "#mail-reply-attach";
    const field = () => $("#mail-reply-body-input .ProseMirror");
    const write = async (text: string) => {
      await browser.waitUntil(async () => (await field().getAttribute("contenteditable")) === "true");
      await field().click();
      await browser.keys(text.split(""));
    };
    const twoMessages = () => {
      const older = threadDetail(subject, "Hello from Alice", false);
      return { ...older, messages: [...older.messages, { ...older.messages[0], id: "m2", from: "me@example.com", fromName: "", fromAddress: "me@example.com", body: "Thanks", snippet: "Thanks" }] };
    };
    // Opens the thread and the reply field.
    async function openReply() {
      await mock("thread", threadDetail(subject, "Hello from Alice", false));
      await rowOf("unread-threads", "First unread").$(".subject").click();
      await expect($("#thread-subject")).toHaveText(subject);
      await threadLoaded();
      await $("#mail-reply-open").click();
      await expect($("#mail-reply")).toBeDisplayed();
    }

    beforeEach(async () => {
      await boot({ inbox: inbox() });
      await waitForCount("#unread-threads li", 2);
    });

    it("has a clip in the foot, right of 送信, and shows no strip while no file is attached", async () => {
      await openReply();
      await expect($(strip)).not.toBeDisplayed();
      await expect($("#mail-reply-attach-open")).toHaveAttribute("aria-label", "ファイルを添付");
      expect(await browser.execute(() => [...document.querySelectorAll(".mail-reply-foot > button:not([hidden])")].map((b) => b.id))).toEqual(["mail-reply-send", "mail-reply-attach-open", "mail-reply-discard"]);
      // The chips are between the text and the foot.
      expect(
        await browser.execute(() => {
          const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
          return [box("#mail-reply-body").bottom <= box("#mail-reply-attach").top || document.getElementById("mail-reply-attach")!.hidden, document.getElementById("mail-reply-attach")!.nextElementSibling!.className];
        }),
      ).toEqual([true, "mail-reply-foot"]);
    });

    it("attaches the files that the dialog picks, counting what the mail holds already, and shows each as a chip with its name and size", async () => {
      await openReply();
      const pick = await mock("mail_attach_pick", [pdf, picked("big.zip", "z", 1572864)]);
      await $("#mail-reply-attach-open").click();
      await waitForChips(strip, 2);
      expect(await callsOf(pick)).toEqual([{ held: 0 }]);
      expect(await names(strip)).toEqual(["請求書.pdf", "big.zip"]);
      expect(await sizes(strip)).toEqual(["3 B", "1.5 MB"]);
      await expect($(strip)).toBeDisplayed();
      await mock("mail_attach_pick", [picked("small.txt", "x", 12288)]);
      await $("#mail-reply-attach-open").click();
      await waitForChips(strip, 3);
      expect(await sizes(strip)).toEqual(["3 B", "1.5 MB", "12 KB"]);
      expect(await callsOf("mail_attach_pick")).toEqual([{ held: 1572864 + 3 }]);
    });

    it("adds nothing when the dialog is cancelled", async () => {
      await openReply();
      const pick = await mock("mail_attach_pick", []);
      await $("#mail-reply-attach-open").click();
      await waitForCalls(pick);
      await expect($(strip)).not.toBeDisplayed();
      await expect($(CARDS)).not.toExist();
    });

    it("attaches a file dropped on the field, after Rust accepted its name and size", async () => {
      await openReply();
      const check = await mock("mail_attach_check", null);
      expect(await fire("dragover", "#mail-reply", [note])).toBe(true);
      expect(await fire("drop", "#mail-reply", [note])).toBe(true);
      await waitForChips(strip, 1);
      expect(await callsOf(check)).toEqual([{ name: "notes.txt", size: 5, held: 0 }]);
      expect(await names(strip)).toEqual(["notes.txt"]);
      expect(await sizes(strip)).toEqual(["5 B"]);
      await expect($("#mail-reply")).not.toHaveElementClass("dropping");
    });

    it("attaches a file pasted in the text, and leaves a paste of text alone", async () => {
      await openReply();
      const check = await mock("mail_attach_check", null);
      expect(await fire("paste", "#mail-reply-body-input .ProseMirror", [])).toBe(false);
      expect(await count0(strip)).toBe(0);
      expect(await fire("paste", "#mail-reply-body-input .ProseMirror", [image()])).toBe(true);
      await waitForChips(strip, 1);
      expect(await callsOf(check)).toEqual([{ name: "shot.png", size: PNG_SIZE, held: 0 }]);
      expect(await names(strip)).toEqual(["shot.png"]);
      // The next file is checked against the first.
      await fire("drop", "#mail-reply", [note]);
      await waitForChips(strip, 2);
      expect(await callsOf(check)).toEqual([
        { name: "shot.png", size: PNG_SIZE, held: 0 },
        { name: "notes.txt", size: 5, held: PNG_SIZE },
      ]);
    });

    it("shows what Rust refuses on a card and attaches nothing", async () => {
      await openReply();
      await mock("mail_attach_check", rejects("添付の合計は 25 MB までです"));
      await fire("drop", "#mail-reply", [note]);
      await expect($(CARD)).toHaveText(expect.stringContaining("添付の合計は 25 MB までです"));
      await expect($(strip)).not.toBeDisplayed();
      await mock("mail_attach_pick", rejects("empty.txt は空のファイルです"));
      await $("#mail-reply-attach-open").click();
      await expect($$(CARD)[0]).toHaveText(expect.stringContaining("empty.txt は空のファイルです"));
      await expect($(strip)).not.toBeDisplayed();
    });

    it("takes a file off with its ×, and the others stay", async () => {
      await openReply();
      await mock("mail_attach_pick", [pdf, picked("b.txt", "b"), picked("c.txt", "c")]);
      await $("#mail-reply-attach-open").click();
      await waitForChips(strip, 3);
      await $('[aria-label="b.txt を外す"]').click();
      expect(await names(strip)).toEqual(["請求書.pdf", "c.txt"]);
      await $('[aria-label="請求書.pdf を外す"]').click();
      await $('[aria-label="c.txt を外す"]').click();
      await expect($(strip)).not.toBeDisplayed();
    });

    it("sends the files with the mail, in the order they were attached, then lets them go", async () => {
      await openReply();
      const send = await mock("send_mail", true);
      await mock("thread", twoMessages());
      await mock("mail_attach_pick", [pdf]);
      await $("#mail-reply-attach-open").click();
      await waitForChips(strip, 1);
      await mock("mail_attach_check", null);
      await fire("drop", "#mail-reply", [note]);
      await waitForChips(strip, 2);
      await write("Thanks");
      await $("#mail-reply-send").click();
      expect(await waitForCalls(send)).toEqual([
        {
          account: "me@example.com",
          mail: {
            to: ["Alice <alice@example.com>"],
            cc: [],
            bcc: [],
            subject,
            body: "Thanks\n",
            markdown: true,
            replyThreadId: "t1",
            attachments: [
              { name: "請求書.pdf", data: pdf.data },
              { name: "notes.txt", data: NOTE_DATA },
            ],
          },
        },
      ]);
      await waitForCount("#messages article", 2);
      await expect($("#mail-reply")).not.toBeDisplayed();
      // The next reply starts with no file.
      await $("#mail-reply-open").click();
      await expect($(strip)).not.toBeDisplayed();
      expect(await names(strip)).toEqual([]);
    });

    it("keeps the files when the send fails", async () => {
      await openReply();
      await mock("mail_attach_pick", [pdf]);
      await $("#mail-reply-attach-open").click();
      await waitForChips(strip, 1);
      await write("Thanks");
      await mock("send_mail", rejects("宛先がありません"));
      await $("#mail-reply-send").click();
      await expect($(CARD)).toHaveText(expect.stringContaining("宛先がありません"));
      expect(await names(strip)).toEqual(["請求書.pdf"]);
      const send = await mock("send_mail", true);
      await mock("thread", twoMessages());
      await $("#mail-reply-send").click();
      expect(((await waitForCalls(send)) as { mail: { attachments: unknown[] } }[])[0].mail.attachments).toHaveLength(1);
    });

    it("lets the files wait while the mail goes out: no clip, no ×, no drop", async () => {
      await openReply();
      await mock("mail_attach_pick", [pdf]);
      await $("#mail-reply-attach-open").click();
      await waitForChips(strip, 1);
      await write("Thanks");
      const send = await mock("send_mail", holds);
      await mock("thread", twoMessages());
      await $("#mail-reply-send").click();
      await waitForCalls(send);
      expect(await pending("mail-reply-attach-open")).toBe(true);
      await expect($('[aria-label="請求書.pdf を外す"]')).toBeDisabled();
      const check = await mock("mail_attach_check", null);
      await fire("drop", "#mail-reply", [note]);
      await browser.pause(300);
      expect(await callsOf(check)).toEqual([]);
      expect(await names(strip)).toEqual(["請求書.pdf"]);
      await release(send, true);
      await waitForCount("#messages article", 2);
    });

    it("lets the files go with 破棄, and with leaving the thread", async () => {
      await openReply();
      await mock("mail_attach_pick", [pdf]);
      await $("#mail-reply-attach-open").click();
      await waitForChips(strip, 1);
      await $("#mail-reply-discard").click();
      await $("#mail-reply-open").click();
      await expect($(strip)).not.toBeDisplayed();
      await $("#mail-reply-attach-open").click();
      await waitForChips(strip, 1);
      await $("#back").click();
      await rowOf("unread-threads", "First unread").$(".subject").click();
      await threadLoaded();
      await $("#mail-reply-open").click();
      await expect($(strip)).not.toBeDisplayed();
    });

    it("lets the files of a pick go when the reply was discarded before the dialog answered", async () => {
      await openReply();
      const pick = await mock("mail_attach_pick", holds);
      await $("#mail-reply-attach-open").click();
      await waitForCalls(pick);
      await $("#mail-reply-discard").click();
      await release(pick, [pdf]);
      await browser.pause(300);
      await $("#mail-reply-open").click();
      await expect($(strip)).not.toBeDisplayed();
    });
  });

  describe("the new mail", () => {
    const strip = "#new-mail-attach";
    const compose = async () => {
      await $("#mail-compose").click();
      await expect($("#new-mail")).toBeDisplayed();
    };

    beforeEach(async () => {
      await boot({ inbox: inbox() });
      await waitForCount("#unread-threads li", 2);
    });

    it("has a clip in the band, right of 送信, and the strip between the text and the band", async () => {
      await compose();
      await expect($(strip)).not.toBeDisplayed();
      await expect($("#new-mail-attach-open")).toHaveAttribute("aria-label", "ファイルを添付");
      expect(await browser.execute(() => [...document.querySelectorAll("#new-mail-foot > button:not([hidden])")].map((b) => b.id))).toEqual(["new-mail-send", "new-mail-attach-open"]);
      await mock("mail_attach_pick", [pdf]);
      await $("#new-mail-attach-open").click();
      await waitForChips(strip, 1);
      expect(
        await browser.execute(() => {
          const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          return [box("new-mail-body").bottom <= box("new-mail-attach").top, box("new-mail-attach").bottom <= box("new-mail-foot").top];
        }),
      ).toEqual([true, true]);
    });

    it("attaches by the dialog, a drop and a paste, shows the chips and takes one off with its ×", async () => {
      await compose();
      const check = await mock("mail_attach_check", null);
      const pick = await mock("mail_attach_pick", [pdf]);
      await $("#new-mail-attach-open").click();
      await waitForChips(strip, 1);
      expect(await callsOf(pick)).toEqual([{ held: 0 }]);
      await fire("drop", "#new-mail", [note]);
      await waitForChips(strip, 2);
      await fire("paste", "#new-mail-body", [image()]);
      await waitForChips(strip, 3);
      expect(await callsOf(check)).toEqual([
        { name: "notes.txt", size: 5, held: 3 },
        { name: "shot.png", size: PNG_SIZE, held: 8 },
      ]);
      expect(await names(strip)).toEqual(["請求書.pdf", "notes.txt", "shot.png"]);
      expect(await sizes(strip)).toEqual(["3 B", "5 B", `${PNG_SIZE} B`]);
      await $('[aria-label="notes.txt を外す"]').click();
      expect(await names(strip)).toEqual(["請求書.pdf", "shot.png"]);
      expect(await fire("paste", "#new-mail-body", [])).toBe(false);
    });

    it("shows what Rust refuses on a card", async () => {
      await compose();
      await mock("mail_attach_check", rejects("big.bin を読めません"));
      await fire("drop", "#new-mail", [note]);
      await expect($(CARD)).toHaveText(expect.stringContaining("big.bin を読めません"));
      await expect($(strip)).not.toBeDisplayed();
    });

    it("sends the files with the mail, and shows the list with the mail gone", async () => {
      await compose();
      const send = await mock("send_mail", true);
      await mock("mail_attach_pick", [pdf]);
      await $("#new-mail-attach-open").click();
      await waitForChips(strip, 1);
      await $("#new-mail-to-input").setValue("dan@example.com");
      await browser.keys(["Enter"]);
      await $("#new-mail-subject").setValue("Hello");
      await $("#new-mail-body").setValue("Line one");
      await $("#new-mail-send").click();
      expect(await waitForCalls(send)).toEqual([
        { account: "me@example.com", mail: { to: ["dan@example.com"], cc: [], bcc: [], subject: "Hello", body: "Line one", attachments: [{ name: "請求書.pdf", data: pdf.data }] } },
      ]);
      await expect($("#threads")).toBeDisplayed();
      await compose();
      await expect($(strip)).not.toBeDisplayed();
    });

    it("waits while the mail goes out, and keeps the files when it fails", async () => {
      await compose();
      await mock("mail_attach_pick", [pdf]);
      await $("#new-mail-attach-open").click();
      await waitForChips(strip, 1);
      await $("#new-mail-to-input").setValue("dan@example.com");
      await browser.keys(["Enter"]);
      await $("#new-mail-body").setValue("Line one");
      const send = await mock("send_mail", holds);
      await $("#new-mail-send").click();
      await waitForCalls(send);
      expect(await pending("new-mail-attach-open")).toBe(true);
      await expect($('[aria-label="請求書.pdf を外す"]')).toBeDisabled();
      await release(send, rejects("宛先がありません"));
      await expect($(CARD)).toHaveText(expect.stringContaining("宛先がありません"));
      expect(await pending("new-mail-attach-open")).toBe(false);
      expect(await names(strip)).toEqual(["請求書.pdf"]);
    });

    it("lets the files go with 戻る and 破棄", async () => {
      await compose();
      await mock("mail_attach_pick", [pdf]);
      await $("#new-mail-attach-open").click();
      await waitForChips(strip, 1);
      await $("#new-mail-back").click();
      await compose();
      await expect($(strip)).not.toBeDisplayed();
      await $("#new-mail-attach-open").click();
      await waitForChips(strip, 1);
      await $("#new-mail-discard").click();
      await compose();
      await expect($(strip)).not.toBeDisplayed();
    });
  });

  // The number of chips of a strip, without waiting.
  const count0 = (strip: string) => browser.execute((s) => document.querySelectorAll(`${s} .mail-attach-chip`).length, strip);
});
