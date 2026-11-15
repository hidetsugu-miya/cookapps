// The reply field at the bottom of the open thread (M-10): the kind of reply, who it goes to as chips, Cc and Bcc, the text, and "送信" / "破棄".
import type { ReplyChoices } from "./bindings/ReplyChoices";
import { $ } from "./dom.js";
import { applySync } from "./inbox.js";
import { invoke } from "./ipc.js";
import { recipientRows } from "./mail-recipients.js";
import { showError } from "./view.js";

type Mode = keyof ReplyChoices;

// The thread the field answers: its IDs and the subject the reply carries.
export interface ReplyTarget {
  id: string;
  account: string;
  subject: string;
}

const NOBODY: ReplyChoices = { one: { to: [], cc: [] }, all: { to: [], cc: [] } };

let target: ReplyTarget | null = null;
let choices = NOBODY;
// The thread whose recipients the chips hold (null: the next bind fills them), so that Gmail's answer for the same thread leaves what was typed and edited.
let filled: string | null = null;
let sending = false;
const recipients = recipientRows("reply");
// Reads the thread again after a reply went out.
let reload: (target: ReplyTarget) => Promise<void>;

const mode = () => $<HTMLSelectElement>("reply-mode");
const body = () => $<HTMLTextAreaElement>("reply-body");

function syncSend() {
  $<HTMLButtonElement>("reply-send").disabled = sending || body().value.trim() === "";
}

// To and Cc are the kind of reply's; Bcc is left as it is.
function fill(m: Mode) {
  recipients.fill(choices[m].to, choices[m].cc);
}

// The field as it is for a new reply: the recipients of "返信", no text, no Cc or Bcc opened.
function clear() {
  mode().value = "one";
  body().value = "";
  recipients.reset(choices.one.to, choices.one.cc);
  syncSend();
}

// The field is empty and hidden: no thread is open.
export function resetReply() {
  target = null;
  choices = NOBODY;
  filled = null;
  clear();
  $("reply").hidden = true;
}

// Shows the field for `thread`, with the recipients Rust worked out. Drawn again for the same thread (Gmail answered with a change, or a reply went out), it keeps the text and the recipients already there.
export function bindReply(thread: ReplyTarget, next: ReplyChoices) {
  target = thread;
  choices = next;
  const key = `${thread.account}/${thread.id}`;
  if (filled !== key) {
    filled = key;
    fill(mode().value as Mode);
  }
  $("reply").hidden = false;
  syncSend();
}

async function send() {
  const sent = target;
  if (sending || !sent) return;
  recipients.commitAll();
  sending = true;
  syncSend();
  try {
    const done = await invoke("send_mail", {
      account: sent.account,
      mail: {
        to: recipients.mailboxes("to"),
        cc: recipients.mailboxes("cc"),
        bcc: recipients.mailboxes("bcc"),
        subject: sent.subject,
        body: body().value,
        replyThreadId: sent.id,
      },
    });
    // The thread was left while the mail went out: the field is another thread's now.
    if (target?.id !== sent.id || target.account !== sent.account) return;
    // The text stays when the account must log in again.
    if (done === null) return applySync(sent.account, { kind: "needsLogin" });
    filled = null;
    clear();
    await reload(sent);
  } catch (e) {
    showError(e);
  } finally {
    sending = false;
    syncSend();
  }
}

export function initReply(reloadThread: (target: ReplyTarget) => Promise<void>) {
  reload = reloadThread;
  mode().onchange = () => fill(mode().value as Mode);
  recipients.init();
  body().oninput = syncSend;
  $("reply-send").onclick = send;
  $("reply-discard").onclick = clear;
}
