// The screen that writes a new mail (M-11): the sender, the recipients as chips, the subject and the text, the files (M-12), "送信" in the band fixed at the bottom, and "戻る" and "破棄" that go back to the inbox.
import { accountButtons } from "./accounts.js";
import { $, tag } from "./dom.js";
import { applySync } from "./inbox.js";
import { invoke } from "./ipc.js";
import { addMailKey } from "./mail-claude.js";
import { addDraftSide, clearUndo, type DraftSide, refreshUndo } from "./mail-draft.js";
import { mailAttachments } from "./mail-attach.js";
import { recipientRows } from "./mail-recipients.js";
import { currentScreen, setScreen, showNewMailScreen } from "./nav.js";
import { toast } from "./toast.js";
import { showFailure } from "./error-card.js";

const recipients = recipientRows("new-mail");
// The files of the new mail (M-12), made by initMailCompose.
let attachments: ReturnType<typeof mailAttachments>;
// The sender of the mail being written.
let account = "";
let sending = false;
// Bumped by every open and every leave: a send that ends after that sees the number has moved on and leaves the screen alone.
let openCount = 0;

const fromSelect = () => $<HTMLSelectElement>("new-mail-from-select");
const subject = () => $<HTMLInputElement>("new-mail-subject");
const body = () => $<HTMLTextAreaElement>("new-mail-body");

function syncSend() {
  $<HTMLButtonElement>("new-mail-send").disabled = sending || body().value.trim() === "";
  attachments.setBusy(sending);
  // A change of the text by hand makes the way back of Claude Code's writes unusable (M-11).
  refreshUndo();
}

// With one account the sender is only shown; with several it is chosen.
function drawFrom(accounts: string[]) {
  const choose = accounts.length > 1;
  fromSelect().hidden = !choose;
  $("new-mail-from-text").hidden = choose;
  $("new-mail-from-text").textContent = account;
  fromSelect().replaceChildren(...accounts.map((a) => tag("option", "", a)));
  fromSelect().value = account;
}

// Opens the screen with nothing written, from the first account.
function openCompose() {
  const accounts = accountButtons().map((b) => b.dataset.account!);
  if (accounts.length === 0) return;
  openCount++;
  clearUndo(side);
  account = accounts[0];
  drawFrom(accounts);
  subject().value = "";
  body().value = "";
  attachments.clear();
  recipients.reset([], []);
  syncSend();
  showNewMailScreen();
  $("new-mail-to-input").focus();
}

// "戻る" and "破棄": back to the inbox, what was written is dropped.
function leave() {
  openCount++;
  attachments.clear();
  clearUndo(side);
  setScreen("mail");
}

async function send() {
  if (sending) return;
  recipients.commitAll();
  const seq = openCount;
  const sender = account;
  const files = attachments.files();
  sending = true;
  syncSend();
  try {
    const done = await invoke("send_mail", {
      account: sender,
      mail: {
        to: recipients.mailboxes("to"),
        cc: recipients.mailboxes("cc"),
        bcc: recipients.mailboxes("bcc"),
        subject: subject().value,
        body: body().value,
        ...(files.length > 0 ? { attachments: files } : {}),
      },
    });
    // The text stays when the account must log in again.
    if (done === null) return applySync(sender, { kind: "needsLogin" });
    toast("送信しました");
    if (seq === openCount && currentScreen() === "new-mail") leave();
  } catch (e) {
    showFailure("mail-compose", e);
  } finally {
    sending = false;
    syncSend();
  }
}

// The fields as Claude Code reads and writes them (A-36, ts/mail-draft.ts). There is no thread, and the sender is the account that the screen chose.
const side: DraftSide = {
  undoId: "new-mail-undo",
  rootId: "new-mail",
  isOpen: () => currentScreen() === "new-mail",
  thread: async () => "新規作成です。読むスレッドはありません",
  read: () => ({
    to: recipients.mailboxes("to").join(", "),
    cc: recipients.mailboxes("cc").join(", "),
    bcc: recipients.mailboxes("bcc").join(", "),
    subject: subject().value,
    body: body().value,
  }),
  settle: () => recipients.commitAll(),
  busy: () => sending,
  async write(texts) {
    for (const kind of ["to", "cc", "bcc"] as const) if (texts[kind] !== undefined) recipients.set(kind, texts[kind]);
    if (texts.subject !== undefined) subject().value = texts.subject;
    if (texts.body !== undefined) body().value = texts.body;
    syncSend();
  },
};

export function initMailCompose() {
  addDraftSide(side);
  // The right side holds one talk with Claude Code for each new mail.
  addMailKey(() => (currentScreen() === "new-mail" ? `new:${openCount}` : null));
  recipients.init();
  attachments = mailAttachments($("new-mail"), $("new-mail-attach"), $<HTMLButtonElement>("new-mail-attach-open"), "mail-compose");
  $("mail-compose").onclick = openCompose;
  $("new-mail-back").onclick = leave;
  $("new-mail-discard").onclick = leave;
  fromSelect().onchange = () => {
    account = fromSelect().value;
  };
  body().oninput = syncSend;
  $("new-mail-send").onclick = send;
}
