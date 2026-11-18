// The screen that writes a new mail (M-11): the sender, the recipients as chips, the subject and the text, "送信" in the band fixed at the bottom, and "戻る" and "破棄" that go back to the inbox.
import { accountButtons } from "./accounts.js";
import { $, tag } from "./dom.js";
import { applySync } from "./inbox.js";
import { invoke } from "./ipc.js";
import { recipientRows } from "./mail-recipients.js";
import { currentScreen, setScreen, showNewMailScreen } from "./nav.js";
import { toast } from "./toast.js";
import { showFailure } from "./error-card.js";

const recipients = recipientRows("new-mail");
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
  account = accounts[0];
  drawFrom(accounts);
  subject().value = "";
  body().value = "";
  recipients.reset([], []);
  syncSend();
  showNewMailScreen();
  $("new-mail-to-input").focus();
}

// "戻る" and "破棄": back to the inbox, what was written is dropped.
function leave() {
  openCount++;
  setScreen("mail");
}

async function send() {
  if (sending) return;
  recipients.commitAll();
  const seq = openCount;
  const sender = account;
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

export function initMailCompose() {
  recipients.init();
  $("mail-compose").onclick = openCompose;
  $("new-mail-back").onclick = leave;
  $("new-mail-discard").onclick = leave;
  fromSelect().onchange = () => {
    account = fromSelect().value;
  };
  body().oninput = syncSend;
  $("new-mail-send").onclick = send;
}
