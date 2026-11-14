// The "?" of a card opens its hint, a popup framed like the account popup; the same button, a click elsewhere, or Escape closes it.
import { composing, tag } from "./dom.js";
import { LOCK_SVG } from "./icons.js";
import { closePane } from "./pane.js";

let hintOpen: { button: Element; node: HTMLElement } | null = null;

export function closeHint() {
  if (!hintOpen) return;
  hintOpen.node.remove();
  hintOpen.button.setAttribute("aria-expanded", "false");
  hintOpen = null;
}

export function toggleHint(button: Element, node: HTMLElement) {
  const same = hintOpen?.button === button;
  closeHint();
  if (same) return;
  hintOpen = { button, node };
  button.setAttribute("aria-expanded", "true");
  document.body.append(node);
  const r = button.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(r.right - node.offsetWidth, innerWidth - node.offsetWidth - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - node.offsetHeight - 8))}px`;
}

export const code = (text: string) => tag("code", "", text);

// Numbered steps (each a list of strings and nodes).
export function stepList(steps: (string | Node)[][]) {
  const list = tag("ol");
  for (const step of steps) {
    const li = tag("li");
    li.append(...step);
    list.append(li);
  }
  return list;
}

// A last line with a lock.
export function lockFoot(text: string) {
  const last = tag("div", "foot");
  last.insertAdjacentHTML("beforeend", LOCK_SVG);
  last.append(text);
  return last;
}

// A hint: a title, numbered steps, and a last line with a lock.
export function hintPopup(title: string, steps: (string | Node)[][], foot: string) {
  const pop = tag("div", "pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", title);
  pop.append(tag("h3", "", title), stepList(steps), lockFoot(foot));
  return pop;
}

// A confirmation framed like a hint, with a red button that does it and a Cancel; Cancel, the same button, a click elsewhere or Escape closes it. Cancel has the keys at first.
function confirmPop(button: Element, label: string, title: string, body: string, yesText: string, onConfirm: () => void, extra = "") {
  const pop = tag("div", `pop${extra}`);
  pop.setAttribute("role", "alertdialog");
  pop.setAttribute("aria-label", label);
  const yes = tag("button", "text-btn danger", yesText);
  const no = tag("button", "text-btn", "キャンセル");
  yes.type = no.type = "button";
  yes.onclick = () => {
    closeHint();
    onConfirm();
  };
  no.onclick = closeHint;
  const actions = tag("div", "popup-actions");
  actions.append(yes, no);
  pop.append(tag("h3", "", title), tag("p", "", body), actions);
  toggleHint(button, pop);
  no.focus();
}

// The confirmation before unlinking.
// `name` is the service or workspace, `body` says what happens to the token and to the service's own data.
export function confirmUnlink(button: Element, name: string, body: string, onConfirm: () => void) {
  confirmPop(button, `${name} の接続を解除`, `${name} の接続を解除しますか？`, body, "解除", onConfirm);
}

// The confirmation before a permanent delete (A-18): `name` is what is deleted, shown in the body in one piece.
export function confirmDelete(button: Element, name: string, onConfirm: () => void) {
  confirmPop(button, `${name} を削除`, "削除しますか？", `${name} を完全に削除します。元に戻せません。`, "削除", onConfirm, " pop-confirm");
}

export function initHint() {
  document.addEventListener("pointerdown", (e) => {
    if (hintOpen && !(e.target as Element).closest(".pop, [data-hint]")) closeHint();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || composing(e)) return;
    closeHint();
    closePane();
  });
  window.addEventListener("resize", closeHint);
}
