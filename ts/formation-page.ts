// The decision page of a child (A-41): what `formation_page_read` gives, drawn in the middle pane under the tab 「判断: {title}」 (formation-flow.ts). The page is the child's text, so everything goes in as `textContent` (formation-page-blocks.ts); nothing is read as HTML.
// A card that asks has its choices as radios and a box for free text; 「リーダーに送る」 at the end of the page hands what was chosen to `send` (the reply is made and sent in Rust, #923). Nothing here decides what the answers mean.
import type { Card } from "./bindings/Card";
import type { CardKind } from "./bindings/CardKind";
import type { DecisionPage } from "./bindings/DecisionPage";
import type { PageAnswer } from "./bindings/PageAnswer";
import type { ScopeGroup } from "./bindings/ScopeGroup";
import type { SettledDecision } from "./bindings/SettledDecision";
import { tag } from "./dom.js";
import { drawBlocks, drawEvidence, fold } from "./formation-page-blocks.js";

interface Choice {
  key: string;
  label: string;
}

// The fixed choices of a kind, in the order of the page's reply format: the lettered options of the card come first on the kinds that have them, and `その他` is always the last.
const FIXED: Record<CardKind, Choice[]> = {
  question: [
    { key: "investigate", label: "調べてから決めて" },
    { key: "other", label: "その他" },
  ],
  nr: [{ key: "other", label: "その他" }],
  "review-decision": [
    { key: "defer", label: "今回は対応しない" },
    { key: "other", label: "その他" },
  ],
  "must-fix": [
    { key: "fix", label: "指摘のとおり修正する" },
    { key: "skip", label: "今回は対応しない" },
  ],
  "structural-proposal": [
    { key: "approve", label: "承認" },
    { key: "reject", label: "却下" },
    { key: "hold", label: "保留" },
  ],
  adr: [
    { key: "keep", label: "残す" },
    { key: "decline", label: "不要" },
  ],
  "review-must-fix": [
    { key: "fix", label: "修正して再レビューする" },
    { key: "accept", label: "現状で完了する" },
  ],
  "unmet-criterion": [],
};
// The kinds whose free text sits in the row of `その他`; the others have a field of their own under the choices.
const LETTERED = new Set<CardKind>(["question", "nr", "review-decision"]);
const NOTE_LABEL: Partial<Record<CardKind, string>> = { "structural-proposal": "理由（却下・保留のとき）" };

// The number of the cards drawn, so that the radios of a card are a group of their own.
let cards = 0;

// `send` takes the answers of the page and fails with the message when the reply could not be sent.
export function drawPage(page: DecisionPage, child: string, atMs: number, send: (answers: PageAnswer[]) => Promise<void>): HTMLElement {
  const root = tag("article", "fp");
  root.dataset.child = child;
  root.dataset.at = String(atMs);
  root.dataset.kind = page.pageKind;
  const top = tag("header", "fp-top");
  top.append(tag("h2", "fp-title", page.title), tag("span", "fp-from", `${child} から`), tag("p", "fp-context", page.contextLabel));
  root.append(top);
  if (page.pageKind !== "open-questions") root.append(changes(page));
  if (page.risks !== null) root.append(risks(page.risks.items, page.risks.evidence));
  if (page.approvalScope.length > 0) root.append(scope(page.approvalScope));
  root.append(...groups(page));
  const reference = referenceOf(page);
  if (reference !== null) root.append(reference);
  root.append(sender(root, send));
  return root;
}

// The answers of the page as chosen: for each card that asks, its number, the key of the choice (null when none) and its free text. What the answers mean is Rust's.
function answersOf(root: HTMLElement): PageAnswer[] {
  return [...root.querySelectorAll<HTMLElement>(".fp-card")].flatMap((card) => {
    const box = card.querySelector<HTMLElement>(".fp-answer");
    if (box === null) return [];
    const chosen = box.querySelector<HTMLInputElement>("input:checked");
    const text = box.querySelector<HTMLTextAreaElement>("textarea");
    return [{ card: card.dataset.card ?? "", choice: chosen?.value ?? null, note: text?.value ?? "" }];
  });
}

// 「リーダーに送る」 and the reason a send failed. The button waits while the send is on its way, so that a second press sends nothing; after a send that went through the page is closed by its owner, and after one that failed the answers stay and the button can be pressed again.
function sender(root: HTMLElement, send: (answers: PageAnswer[]) => Promise<void>): HTMLElement {
  const row = tag("footer", "fp-send");
  const error = tag("p", "fp-error pending fail");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const button = tag("button", "text-btn primary fp-send-btn", "リーダーに送る");
  button.type = "button";
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    error.hidden = true;
    try {
      await send(answersOf(root));
    } catch (e) {
      error.textContent = String(e);
      error.hidden = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  };
  row.append(error, button);
  return row;
}

function section(heading: string, className = ""): HTMLElement {
  const node = tag("section", `fp-section ${className}`.trim());
  node.append(tag("h3", "fp-sec", heading));
  return node;
}

// 「何が変わるか」: the lead, and the change sections (folded on an approval, open on a code review).
function changes(page: DecisionPage): HTMLElement {
  const node = section("何が変わるか");
  if (page.what !== null) node.append(tag("p", "fp-p", page.what));
  for (const change of page.changes) {
    const body = fold(change.heading, "fp-change", page.pageKind === "code-review");
    body.append(...drawBlocks(change.blocks, !body.open));
    node.append(body);
  }
  return node;
}

function risks(items: { title: string; text: string | null }[], evidence: Parameters<typeof drawEvidence>[0]): HTMLElement {
  const node = section("リスク・リリース上の注意", "fp-risks");
  const list = tag("ol", "fp-risk-list");
  for (const risk of items) {
    const li = tag("li");
    li.append(tag("b", "", risk.title));
    if (risk.text !== null) li.append(tag("p", "fp-muted", risk.text));
    list.append(li);
  }
  node.append(list);
  if (evidence.length > 0) {
    const more = fold("根拠を見る", "fp-more");
    more.append(drawEvidence(evidence));
    node.append(more);
  }
  return node;
}

function scope(groupsOf: ScopeGroup[]): HTMLElement {
  const node = section("承認の対象");
  for (const group of groupsOf) {
    node.append(tag("h4", "fp-h", group.heading));
    for (const item of group.items) {
      const row = tag("div", "fp-scope-item");
      row.append(tag("code", "fp-ev-path", item.ref ?? item.path ?? ""), tag("p", "fp-p", item.description));
      for (const extra of item.extras) row.append(tag("code", "fp-extra", extra));
      if (item.text !== null) {
        const more = fold("中身を見る", "fp-more");
        more.append(tag("pre", "fp-pre", item.text));
        row.append(more);
      }
      node.append(row);
    }
  }
  return node;
}

// 「確認する項目」: the cards, grouped by kind in the order of the page, a group with no card left out.
function groups(page: DecisionPage): HTMLElement[] {
  const list: [string, Card[]][] =
    page.pageKind === "open-questions"
      ? [["論点", page.questions]]
      : page.pageKind === "approval"
        ? [
            ["判断が必要", page.needsUserDecision],
            ["未解消の必ず直す指摘", page.residualMustFix],
            ["構造改善の提案", page.structuralProposals],
            ["ADR（設計判断の記録）", page.adr === null ? [] : [page.adr]],
          ]
        : [
            ["未解消の必ず直す指摘", page.residualMustFix],
            ["満たしていないリリース条件", page.unmetCriteria],
            ["判断が必要", page.needsUserDecision],
          ];
  return list
    .filter(([, cardsOf]) => cardsOf.length > 0)
    .map(([heading, cardsOf]) => {
      const node = section(`${heading} ${cardsOf.length} 件`, "fp-group");
      node.append(...cardsOf.map(drawCard));
      return node;
    });
}

function drawCard(card: Card): HTMLElement {
  const node = tag("article", "fp-card");
  node.dataset.card = card.number;
  node.dataset.kind = card.kind;
  const head = tag("header", "fp-card-head");
  head.append(tag("span", "fp-number", card.number), tag("h4", "fp-card-title", card.title));
  node.append(head, tag("p", "fp-p", card.summary));
  if (card.kind === "unmet-criterion" && card.cards.length > 0) node.append(tag("p", "fp-muted", card.cards.join("、")));
  // A card that asks shows its first diagram in the card; the rest of it is behind the fold.
  const asks = FIXED[card.kind].length > 0;
  const blocks = [...card.blocks];
  const first = asks ? blocks.findIndex((b) => b.type === "diagram") : -1;
  if (first >= 0) node.append(...drawBlocks(blocks.splice(first, 1)));
  if (asks) node.append(answer(card));
  const hasMore = card.background !== null || card.facts.length > 0 || blocks.length > 0 || card.evidence.length > 0;
  if (hasMore) {
    const more = fold("詳しく見る", "fp-more");
    if (card.background !== null) more.append(tag("h4", "fp-h", "背景"), tag("p", "fp-p", card.background));
    if (card.facts.length > 0) {
      const facts = tag("dl", "fp-facts");
      for (const fact of card.facts) facts.append(tag("dt", "", fact.label), tag("dd", "", fact.value));
      more.append(facts);
    }
    more.append(...drawBlocks(blocks, true));
    if (card.evidence.length > 0) more.append(drawEvidence(card.evidence));
    node.append(more);
  }
  return node;
}

// The choices of a card that asks, and its free text.
function answer(card: Card): HTMLElement {
  const group = `fp-answer-${++cards}`;
  const lettered = LETTERED.has(card.kind);
  const choices: Choice[] = [...(lettered ? card.options.map((o) => ({ key: o.key, label: o.label })) : []), ...FIXED[card.kind]];
  const details = new Map(card.options.map((o) => [o.key, o.detail]));
  const box = tag("fieldset", "fp-answer");
  box.append(tag("legend", "fp-sr", "あなたの回答"));
  let text: HTMLTextAreaElement | null = null;
  for (const choice of choices) {
    const row = tag("div", "fp-choice");
    const recommended = choice.key === card.recommendation;
    if (recommended) row.dataset.recommended = "true";
    const label = tag("label", "fp-choice-label");
    const radio = tag("input");
    radio.type = "radio";
    radio.name = group;
    radio.value = choice.key;
    label.append(radio);
    if (lettered && choice.key !== "other" && details.has(choice.key)) label.append(tag("b", "fp-key", choice.key));
    label.append(tag("span", "", choice.label));
    if (recommended) label.append(tag("span", "fp-rec", "推奨"));
    row.append(label);
    if (recommended && card.recommendationReason !== null) row.append(tag("p", "fp-reason", `理由: ${card.recommendationReason}`));
    const detail = details.get(choice.key);
    if (detail) {
      const more = fold("この選択肢の詳細", "fp-detail");
      more.append(tag("p", "fp-p", detail));
      row.append(more);
    }
    if (lettered && choice.key === "other") {
      text = freeText("その他");
      text.hidden = true;
      row.append(text);
    }
    box.append(row);
  }
  if (!lettered) {
    const note = tag("label", "fp-note");
    note.append(tag("span", "", NOTE_LABEL[card.kind] ?? "補足（任意）"));
    text = freeText(NOTE_LABEL[card.kind] ?? "補足（任意）");
    note.append(text);
    box.append(note);
  }
  const cancel = tag("button", "text-btn fp-cancel", "選択を取り消す");
  cancel.type = "button";
  cancel.disabled = true;
  box.append(cancel);
  const sync = () => {
    const chosen = box.querySelector<HTMLInputElement>("input:checked");
    cancel.disabled = chosen === null;
    // The free text of a lettered card is for `その他` alone.
    if (lettered && text) text.hidden = chosen?.value !== "other";
  };
  box.addEventListener("change", sync);
  cancel.onclick = () => {
    for (const radio of box.querySelectorAll<HTMLInputElement>("input:checked")) radio.checked = false;
    sync();
  };
  return box;
}

function freeText(name: string): HTMLTextAreaElement {
  const text = tag("textarea", "fp-text");
  text.rows = 2;
  text.setAttribute("aria-label", name);
  return text;
}

// 「参考」: what settled, how the quality loop went, the pull request and the earlier reply. A section with nothing is left out.
function referenceOf(page: DecisionPage): HTMLElement | null {
  const parts: HTMLElement[] = [];
  if (page.settledDecisions.length > 0) parts.push(settled(page.settledDecisions));
  if (page.qualityLoop !== null) {
    const node = tag("div", "fp-ref");
    node.append(tag("h4", "fp-h", "品質チェックの結果"), tag("p", "fp-p", `実施回数: ${page.qualityLoop.rounds} 回`), tag("p", "fp-p", `解消した必ず直す指摘: ${page.qualityLoop.mustFixResolved} 件`));
    parts.push(node);
  }
  if (page.pr !== null) {
    const node = tag("div", "fp-ref");
    node.append(tag("h4", "fp-h", "PR"));
    if (page.pr.url !== null) node.append(tag("code", "fp-ev-path", page.pr.url));
    if (page.pr.note !== null) node.append(tag("p", "fp-p", page.pr.note));
    parts.push(node);
  }
  if (page.previousReply !== null) {
    const node = tag("div", "fp-ref");
    node.append(tag("h4", "fp-h", "前回の返信"), tag("pre", "fp-pre", page.previousReply));
    parts.push(node);
  }
  if (parts.length === 0) return null;
  const node = fold("参考", "fp-reference");
  node.append(...parts);
  return node;
}

function settled(items: SettledDecision[]): HTMLElement {
  const node = tag("div", "fp-ref");
  node.append(tag("h4", "fp-h", "決まったこと"));
  for (const item of items) {
    const row = tag("div", "fp-settled");
    if (item.provisional) row.dataset.provisional = "true";
    row.append(tag("code", "fp-ev-path", item.id), tag("p", "fp-p", item.decision), tag("p", "fp-muted", `理由: ${item.reason}`));
    if (item.provisional) row.append(tag("p", "fp-muted", "仮置き（ビジネス側の確認待ち）"));
    if (item.evidence.length > 0) row.append(drawEvidence(item.evidence));
    node.append(row);
  }
  return node;
}
