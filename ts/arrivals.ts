// The popups for new mail (M-9): at the bottom right of the window, one card per new thread that auto sync found, with the actions trash, archive and open.
// The stack is shared with the popups for new Slack messages (S-17, arrivals-slack.ts), which put their cards in it with `stackCard`.
import type { ThreadItem } from "./bindings/ThreadItem";
import { $, el, span, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { avatarColor, initials } from "./format.js";
import { CHECK_SVG, CLOSE_SVG } from "./icons.js";
import { removeRow } from "./inbox.js";
import { rowKey, rows } from "./inbox-rows.js";
import { setScreen } from "./nav.js";
import { loading, openThread, opened } from "./thread.js";

// A card goes by itself after this long; the pointer or the focus on it holds it, and it counts again when they leave.
const SHOW_MS = 10000;
// The newest cards; an older one makes room (its thread stays in the list, unread).
export const MAX_CARDS = 3;

let stack: HTMLElement;
// The cards on screen by "account/id".
const cards = new Map<string, HTMLElement>();

export function initArrivals() {
  stack = el("arrivals");
  stack.id = "arrivals";
  document.body.append(stack);
}

// Closes the card of a thread; openThread calls it too, so no button of a card acts on a thread the detail view holds.
export function dismiss(key: string) {
  cards.get(key)?.remove();
  cards.delete(key);
}

// Closes every card whose key and element `test` accepts (the Slack cards go when their message is read, S-17).
export function dismissWhere(test: (key: string, card: HTMLElement) => boolean) {
  for (const [key, card] of cards) if (test(key, card)) dismiss(key);
}

// Whether the card of `key` is on screen.
export const isShown = (key: string) => cards.has(key);

// A button of a card that runs `run` for the thread's row and closes the card.
export function action(button: HTMLButtonElement, label: string, key: string, run: () => void) {
  button.type = "button";
  if (label) button.setAttribute("aria-label", label);
  button.onclick = () => {
    dismiss(key);
    run();
  };
  return button;
}

// Shows the card of a new thread. A thread already announced, or the one open on screen, gets none.
export function announceArrival(t: ThreadItem) {
  const key = rowKey(t);
  const current = opened.current ?? loading.current;
  if (cards.has(key) || (current && !$("thread").hidden && rowKey(current) === key)) return;
  const name = t.fromName || t.fromAddress;
  const card = el("arrival pop");
  card.setAttribute("role", "status");
  const avatar = span("avatar", initials(name));
  avatar.style.background = avatarColor(name);
  const text = el("arrival-text");
  text.append(tag("b", "", name), span("arrival-subject", t.subject || "(件名なし)"));
  const close = action(tag("button", "icon-btn"), "閉じる", key, () => {});
  close.innerHTML = CLOSE_SVG;
  const head = el("arrival-head");
  head.append(avatar, text, close);

  const row = () => rows.get(key);
  const trash = action(tag("button", "icon-btn"), "ゴミ箱へ移動", key, () => {
    const r = row();
    if (r) removeRow("trash", r.t.account, r.t.id, r.li);
  });
  trash.innerHTML = $("trash").innerHTML;
  const archive = action(tag("button", "icon-btn"), "アーカイブ", key, () => {
    const r = row();
    if (r) removeRow("archive", r.t.account, r.t.id, r.li);
  });
  archive.innerHTML = CHECK_SVG;
  const open = action(tag("button", "text-btn", "詳細を開く"), "", key, () => {
    setScreen("mail");
    openThread(row()?.t ?? t, row()?.li ?? null);
  });
  const actions = el("arrival-actions");
  actions.append(trash, archive, open);
  card.append(head, actions);
  stackCard(key, card);
}

// Puts a finished card of `key` at the bottom of the stack (mail and Slack share it, M-9, S-17): it goes by itself after SHOW_MS, held while the pointer or the focus is on it, and the oldest card makes room for the newest MAX_CARDS.
export function stackCard(key: string, card: HTMLElement) {
  let timer = 0;
  const arm = () => {
    clearTimeout(timer);
    // A card closed before its time must not close a newer card of the same thread.
    timer = window.setTimeout(() => cards.get(key) === card && dismiss(key), periodMs("arrival", SHOW_MS));
  };
  const hold = () => clearTimeout(timer);
  for (const type of ["mouseenter", "focusin"]) card.addEventListener(type, hold);
  for (const type of ["mouseleave", "focusout"]) card.addEventListener(type, arm);
  arm();

  cards.set(key, card);
  stack.append(card);
  for (const [oldest] of cards) {
    if (cards.size <= MAX_CARDS) break;
    dismiss(oldest);
  }
}
