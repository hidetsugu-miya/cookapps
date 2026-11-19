// The "?" of a card opens its hint, a popup framed like the account popup; the same button, a click elsewhere, or Escape closes it.
import type { FormationCloseAnswer } from "./bindings/FormationCloseAnswer";
import type { FormationKeptChild } from "./bindings/FormationKeptChild";
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
function confirmPop(button: Element, label: string, title: string, body: string | HTMLElement[], yesText: string, onConfirm: () => void, extra = "") {
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
  pop.append(tag("h3", "", title), ...(typeof body === "string" ? [tag("p", "", body)] : body), actions);
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

// The confirmation before the changes of a file or folder are put back as HEAD has them (A-44). `fresh` is whether the row's mark is `new`: a file that is new (untracked or added) is deleted for good, and so is every file of a folder that is new. A folder that is `changed` may hold new files too, so the words say that they go.
export function confirmRevert(button: Element, name: string, folder: boolean, fresh: boolean, onConfirm: () => void) {
  const body = folder
    ? fresh
      ? `${name} の中の変更は、すべて新しいファイルです。元に戻すと完全に削除します。元に戻せません。`
      : `${name} の中の変更をすべて捨てて、HEAD の状態に戻します。新しいファイルは完全に削除します。元に戻せません。`
    : fresh
      ? `${name} は新しいファイルです。元に戻すと完全に削除します。元に戻せません。`
      : `${name} の変更を捨てて、HEAD の状態に戻します。元に戻せません。`;
  confirmPop(button, `${name} の変更を元に戻す`, "変更を元に戻しますか？", body, "元に戻す", onConfirm, " pop-confirm");
}

// The confirmation before the changes of a table that were not confirmed with ✓ are dropped, when the screen leaves the table (D-10): `count` is how many changes there are.
export function confirmDiscardChanges(button: Element, count: number, onConfirm: () => void) {
  confirmPop(button, "変更を捨てる", "変更を捨てますか？", `確定していない ${count} 件の変更は、データベースに送られていません。移ると、すべて消えます。`, "捨てる", onConfirm, " pop-confirm");
}

// The confirmation before several files and folders are deleted for good at once (A-18): `count` is how many rows are selected.
export function confirmDeleteMany(button: Element, count: number, onConfirm: () => void) {
  confirmPop(button, `${count} 件を削除`, "削除しますか？", `${count} 件を完全に削除します。元に戻せません。`, "削除", onConfirm, " pop-confirm");
}

// The confirmation before a formation is deleted (A-37): its children are closed first, and one that cannot be closed stops it.
export function confirmFormationDelete(button: Element, name: string, onConfirm: () => void) {
  confirmPop(button, `${name} を削除`, `${name} を削除しますか？`, "子をすべて閉じてから削除します。閉じられない子があるときは、削除しません。", "削除", onConfirm, " pop-confirm");
}

// The confirmation before a child of a formation is closed from its card (A-37): its worktree and its branch go, and a child that has something to lose is not closed. A child in a folder that tsunagiai did not make (`created` false) loses only its terminal and its card, and the words say that nothing is removed.
export function confirmChildDelete(button: Element, name: string, created: boolean, onConfirm: () => void) {
  const body = created ? "worktree とブランチを消します。変更や追跡していないファイル、どのリモートにもないコミットがあるときは、消しません。" : "ターミナルを閉じて、一覧から外します。フォルダ、worktree、ブランチは消しません。";
  confirmPop(button, `${name} を削除`, `${name} を削除しますか？`, body, "削除", onConfirm, " pop-confirm");
}

// What a refused close of a child (A-37) would lose if it were forced: git's lines under a head each (data from git, drawn as text), and the head of a group that has none is not drawn.
function lostGroups(groups: [string, string[]][]): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const [head, lines] of groups) {
    if (lines.length === 0) continue;
    const list = tag("ul", "pop-lost");
    for (const line of lines) list.append(tag("li", "", line));
    nodes.push(tag("p", "pop-lost-head", head), list);
  }
  return nodes;
}

// The reason a worktree was kept, where it is (the path a forced close sends back, and its environment) and what a forced close loses (git's lines under a head each).
function keptBody(answer: FormationCloseAnswer): HTMLElement[] {
  return [
    tag("p", "", answer.reason ?? ""),
    tag("p", "pop-lost-place", `${answer.environment === "local" ? "この Mac" : answer.environment}: ${answer.path}`),
    ...lostGroups([
      ["変更のあるファイル", answer.changed],
      ["追跡していないファイル", answer.untracked],
      ["どのリモートにもないコミット", answer.unpushed],
    ]),
  ];
}

// The confirmation after the close of a child was refused for what git says of its worktree (A-37): the reason and what a forced close loses, with 「強制削除」 in the danger color.
export function confirmChildForce(button: Element, name: string, answer: FormationCloseAnswer, onConfirm: () => void) {
  const body = [...keptBody(answer), tag("p", "", "強制すると、worktree を消します。変更と追跡していないファイルは失われます。どのリモートにもないコミットは、ローカルのブランチに残ります。")];
  confirmPop(button, `${name} を強制削除`, `${name} を削除できませんでした`, body, "強制削除", onConfirm, " pop-confirm");
}

// The confirmation after the deletion of a formation was refused for what git says of the worktrees of its children (A-37): each child that was kept with its reason and what a forced deletion loses, with 「強制削除」 in the danger color. Nothing was closed when this is drawn.
export function confirmFormationForce(button: Element, name: string, kept: FormationKeptChild[], onConfirm: () => void) {
  const body = kept.flatMap((child) => [tag("p", "pop-lost-child", `子「${child.name}」`), ...keptBody(child.answer)]);
  body.push(tag("p", "", "強制すると、これらの子の worktree を消してから、フォーメーションを削除します。上の変更と追跡していないファイルは失われます。どのリモートにもないコミットは、ローカルのブランチに残ります。"));
  confirmPop(button, `${name} を強制削除`, `${name} を削除できませんでした`, body, "強制削除", onConfirm, " pop-confirm pop-kept");
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
