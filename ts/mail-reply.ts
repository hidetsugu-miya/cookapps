// The reply field at the bottom of the open thread (M-10): the kind of reply, who it goes to as chips, Cc and Bcc, the text, and "送信" / "破棄".
import type { Recipient } from "./bindings/Recipient";
import type { ReplyChoices } from "./bindings/ReplyChoices";
import { $, composing, tag } from "./dom.js";
import { applySync } from "./inbox.js";
import { invoke } from "./ipc.js";
import { showError } from "./view.js";

type Kind = "to" | "cc" | "bcc";
type Mode = keyof ReplyChoices;
const KINDS: Kind[] = ["to", "cc", "bcc"];

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
const people: Record<Kind, Recipient[]> = { to: [], cc: [], bcc: [] };
// Cc and Bcc show once they were opened or hold someone.
const opened = { cc: false, bcc: false };
// Reads the thread again after a reply went out.
let reload: (target: ReplyTarget) => Promise<void>;

const mode = () => $<HTMLSelectElement>("reply-mode");
const body = () => $<HTMLTextAreaElement>("reply-body");
const input = (kind: Kind) => $<HTMLInputElement>(`reply-${kind}-input`);

function drawChips(kind: Kind) {
  const field = $(`reply-${kind}-field`);
  for (const chip of field.querySelectorAll(".reply-chip")) chip.remove();
  for (const [i, p] of people[kind].entries()) {
    const chip = tag("span", "reply-chip");
    chip.title = p.mailbox;
    const remove = tag("button", "reply-chip-x", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `${p.label} を外す`);
    remove.onclick = () => {
      people[kind].splice(i, 1);
      drawChips(kind);
    };
    chip.append(tag("span", "", p.label), remove);
    field.insertBefore(chip, input(kind));
  }
}

function syncRows() {
  for (const kind of ["cc", "bcc"] as const) {
    if (people[kind].length) opened[kind] = true;
    $(`reply-${kind}-row`).hidden = !opened[kind];
    $(`reply-${kind}-open`).hidden = opened[kind];
  }
}

function syncSend() {
  $<HTMLButtonElement>("reply-send").disabled = sending || body().value.trim() === "";
}

// To and Cc are the kind of reply's; Bcc is left as it is.
function fill(m: Mode) {
  people.to = [...choices[m].to];
  people.cc = [...choices[m].cc];
  for (const kind of KINDS) drawChips(kind);
  syncRows();
}

// The address typed in the field becomes a chip; it is checked when the mail is sent.
function commit(kind: Kind) {
  const field = input(kind);
  const text = field.value.replace(/[,;]+$/, "").trim();
  field.value = "";
  if (!text) return;
  people[kind].push({ label: text, mailbox: text });
  drawChips(kind);
}

// The field as it is for a new reply: the recipients of "返信", no text, no Cc or Bcc opened.
function clear() {
  mode().value = "one";
  body().value = "";
  people.bcc = [];
  opened.cc = opened.bcc = false;
  for (const kind of KINDS) input(kind).value = "";
  fill("one");
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
  for (const kind of KINDS) commit(kind);
  const mailbox = (kind: Kind) => people[kind].map((p) => p.mailbox);
  sending = true;
  syncSend();
  try {
    const done = await invoke("send_mail", {
      account: sent.account,
      mail: { to: mailbox("to"), cc: mailbox("cc"), bcc: mailbox("bcc"), subject: sent.subject, body: body().value, replyThreadId: sent.id },
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
  for (const kind of KINDS) {
    const field = input(kind);
    field.onkeydown = (e) => {
      if ((e.key === "Enter" && !composing(e)) || e.key === ",") {
        e.preventDefault();
        commit(kind);
      }
    };
    field.onblur = () => commit(kind);
  }
  for (const kind of ["cc", "bcc"] as const) {
    $(`reply-${kind}-open`).onclick = () => {
      opened[kind] = true;
      syncRows();
      input(kind).focus();
    };
  }
  body().oninput = syncSend;
  $("reply-send").onclick = send;
  $("reply-discard").onclick = clear;
}
