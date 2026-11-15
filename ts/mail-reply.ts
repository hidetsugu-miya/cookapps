// The reply field at the bottom of the open thread (M-10), shown when the reply button of the latest message is pressed: the kind of reply, who it goes to as chips, Cc and Bcc, the text (the rich editor, Markdown), and "送信" / "破棄".
import type { ReplyChoices } from "./bindings/ReplyChoices";
import { $ } from "./dom.js";
import { applySync } from "./inbox.js";
import { invoke } from "./ipc.js";
import { recipientRows } from "./mail-recipients.js";
import { createRichEditor } from "./rich-editor.js";
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
// The session the send in flight belongs to: the editor waits only in that session, so a thread opened again after leaving one whose send is still on its way can be written in.
let sendingIn = -1;
// Counts the times the field was reset, so that a send that outlives its thread can tell that the field is another one's now, even for the same thread opened again.
let session = 0;
const recipients = recipientRows("mail-reply");
// Reads the thread again after a reply went out.
let reload: (target: ReplyTarget) => Promise<void>;

// The text of the reply: the editor takes the place of #mail-reply-body (initReply), and the text is its Markdown.
const editor = createRichEditor({
  prefix: "mail-reply-body",
  label: "返信の本文",
  arrow: false,
  onChange: syncSend,
  onSubmit: () => void send(),
});

const mode = () => $<HTMLSelectElement>("mail-reply-mode");

// "送信" is off while the text is blank or a send is on its way, and the editor waits while it is.
function syncSend() {
  $<HTMLButtonElement>("mail-reply-send").disabled = sending || !editor.ready() || editor.blank();
  editor.setBusy(sending && sendingIn === session);
}

// To and Cc are the kind of reply's; Bcc is left as it is.
function fill(m: Mode) {
  recipients.fill(choices[m].to, choices[m].cc);
}

// The field as it is for a new reply: the recipients of "返信", no text, no Cc or Bcc opened.
function clear() {
  mode().value = "one";
  editor.set("");
  recipients.reset(choices.one.to, choices.one.cc);
  syncSend();
}

// Shows the field and, once Milkdown is read (the first time the field is opened), puts the cursor in the text.
export function openReply() {
  $("mail-reply").hidden = false;
  editor.ensure().then(
    () => {
      syncSend();
      if (!$("mail-reply").hidden) editor.focus();
    },
    (e) => showError(`エディターを読み込めませんでした: ${e}`),
  );
}

// Empties the field and hides it: "破棄", and a reply that went out.
function discard() {
  clear();
  $("mail-reply").hidden = true;
}

// The field is empty and hidden: no thread is open.
export function resetReply() {
  session++;
  target = null;
  choices = NOBODY;
  filled = null;
  clear();
  $("mail-reply").hidden = true;
}

// Binds the field to `thread`, with the recipients Rust worked out; it stays hidden until the reply button is pressed, and stays shown when it is. Drawn again for the same thread (Gmail answered with a change), it keeps the text and the recipients already there.
export function bindReply(thread: ReplyTarget, next: ReplyChoices) {
  target = thread;
  choices = next;
  const key = `${thread.account}/${thread.id}`;
  if (filled !== key) {
    filled = key;
    fill(mode().value as Mode);
  }
  syncSend();
}

async function send() {
  const sent = target;
  if (sending || !sent || !editor.ready() || editor.blank()) return;
  const started = session;
  recipients.commitAll();
  sending = true;
  sendingIn = started;
  syncSend();
  try {
    const done = await invoke("send_mail", {
      account: sent.account,
      mail: {
        to: recipients.mailboxes("to"),
        cc: recipients.mailboxes("cc"),
        bcc: recipients.mailboxes("bcc"),
        subject: sent.subject,
        body: editor.markdown(),
        markdown: true,
        replyThreadId: sent.id,
      },
    });
    // The thread was left while the mail went out: the field is another thread's now.
    if (session !== started || target?.id !== sent.id || target.account !== sent.account) return;
    // The text stays when the account must log in again.
    if (done === null) return applySync(sent.account, { kind: "needsLogin" });
    filled = null;
    discard();
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
  $("mail-reply-body").append(editor.el);
  $("mail-reply-send").onclick = send;
  $("mail-reply-discard").onclick = discard;
}
