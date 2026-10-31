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

// The confirmation before unlinking, framed like a hint; Cancel, the same button, a click elsewhere or Escape closes it.
export function confirmUnlink(button: Element, w: { team: string }, onConfirm: () => void) {
  const pop = tag("div", "pop");
  pop.setAttribute("role", "alertdialog");
  pop.setAttribute("aria-label", `${w.team} の接続を解除`);
  const yes = tag("button", "text-btn danger", "解除");
  const no = tag("button", "text-btn", "キャンセル");
  yes.type = no.type = "button";
  yes.onclick = () => {
    closeHint();
    onConfirm();
  };
  no.onclick = closeHint;
  const actions = tag("div", "popup-actions");
  actions.append(yes, no);
  pop.append(
    tag("h3", "", `${w.team} の接続を解除しますか？`),
    tag("p", "", "トークンを Slack で取り消し、cookup から削除します。Slack のアプリは残ります。"),
    actions,
  );
  toggleHint(button, pop);
  no.focus();
}

export function initHint() {
  document.addEventListener("pointerdown", (e) => {
    if (hintOpen && !(e.target as Element).closest(".pop, [data-hint]")) closeHint();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && !composing(e) && (closeHint(), closePane()));
  window.addEventListener("resize", closeHint);
}
