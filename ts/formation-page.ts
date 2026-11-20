// The decision page of a child (A-41): what `formation_page_read` gives, drawn in the middle pane under the tab 「判断: {title}」 (formation-flow.ts). The page is the child's text, so everything goes in as `textContent` (formation-page-blocks.ts); nothing is read as HTML.
// The page has a top bar with its sections and a bottom bar with the count of answers and the button that sends (formation-page-bars.ts), and a drawer on the right (formation-page-drawer.ts) that shows what a card, a change section or an entry folds and the file that a code name points at. What was entered is kept in the browser as it is entered and put back (formation-page-store.ts).
// A card that asks has its choices as radios and a box for free text; an approval ends with 「あなたの判定」, the owner's choice between approving and asking for a revision, and 「リーダーに送る」 hands what was chosen to `send` (the reply is made and sent in Rust, #923). The answers of the earlier reply (`previous_reply`) are read in Rust (`restored`), and the page starts from them. The screen keeps the verdict and a `fix` from contradicting each other and shows what an unanswered card will be sent as; what the answers mean is Rust's.
import type { Card } from "./bindings/Card";
import type { CardKind } from "./bindings/CardKind";
import type { CardOption } from "./bindings/CardOption";
import type { Condition } from "./bindings/Condition";
import type { DecisionPage } from "./bindings/DecisionPage";
import type { DesignItem } from "./bindings/DesignItem";
import type { FactContent } from "./bindings/FactContent";
import type { Occurrence } from "./bindings/Occurrence";
import type { PageAnswer } from "./bindings/PageAnswer";
import type { PageVerdict } from "./bindings/PageVerdict";
import type { Sample } from "./bindings/Sample";
import type { SettledDecision } from "./bindings/SettledDecision";
import { tag } from "./dom.js";
import { drawBars } from "./formation-page-bars.js";
import { drawBlocks, drawEvidence, drawFactContent, drawImage, drawTable, evidenceButton, fold, termed, useImages, useTerms } from "./formation-page-blocks.js";
import { createDrawer, foldButton, foldOpener, linkRefs, ownedBy, registerFold, useDrawer } from "./formation-page-drawer.js";
import { entered, openStore, type Saved } from "./formation-page-store.js";
import { invoke } from "./ipc.js";

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
};
// The kinds whose free text sits in the row of `その他`; the others have a field of their own under the choices.
const LETTERED = new Set<CardKind>(["question", "nr"]);
// The kinds that cannot be sent without an answer (Rust refuses a page that has one of them unanswered).
const REQUIRED = new Set<CardKind>(["question", "must-fix"]);
const NOTE_LABEL: Partial<Record<CardKind, string>> = { "structural-proposal": "理由（却下・保留のとき）" };

// The row that a page with `hold` adds to its `question` cards.
const HOLD: Choice = { key: "hold", label: "ビジネス側に確認する" };

// The number of the cards drawn, so that the radios of a card are a group of their own.
let cards = 0;

// The verdict of a page and the writing of a revision, as chosen; `send` fails with the message when the reply could not be sent.
type Send = (answers: PageAnswer[], verdict: PageVerdict | null, revision: string) => Promise<void>;

// The key that the ids of the sections of the page being drawn start with, so that the pages held in the pane never share an id.
let pageKey = "";

export function drawPage(page: DecisionPage, formation: string, child: string, atMs: number, send: Send): HTMLElement {
  useImages((root, path) => invoke("formation_page_image", { name: formation, child, root, path }));
  useTerms(page.terms);
  const drawer = createDrawer();
  useDrawer(drawer);
  pageKey = `fp-${child.replace(/[^\w-]/g, "_")}`;
  const shell = tag("div", "fp-shell");
  shell.dataset.child = child;
  shell.dataset.at = String(atMs);
  shell.dataset.kind = page.pageKind;
  const root = tag("article", "fp");
  const top = tag("header", "fp-top");
  top.append(tag("h2", "fp-title", page.title), tag("span", "fp-from", `${child} から`));
  root.append(top);
  if (page.pageKind !== "open-questions") root.append(changes(page));
  if (page.risks !== null) root.append(risks(page.risks.items, page.risks.evidence));
  if (page.designItems.length > 0) root.append(designItems(page.designItems));
  if (page.implementationOrder.length > 0) root.append(implementationOrder(page.implementationOrder));
  if (page.approvalScope.length > 0) root.append(scope(page));
  root.append(...groups(page));
  const reference = referenceOf(page);
  if (reference !== null) root.append(reference);
  const verdict = page.pageKind === "open-questions" ? null : verdictBox(root, page);
  if (verdict !== null) root.append(verdict.node);
  const snapshot = (): Saved => ({ answers: answersOf(root), ...(verdict?.read() ?? { verdict: null, revision: "" }) });
  const store = openStore(formation, child, page, shell, () => entered(snapshot()));
  // What the owner entered before wins over the answers of the earlier reply.
  const saved = store.read();
  let notice: HTMLElement | null = null;
  if (saved !== null) {
    put(root, saved.answers);
    verdict?.write(saved.verdict, saved.revision);
    notice = noticeLine(root, "前回この画面で入力した回答を復元しました。");
  } else if (page.restored.length > 0) {
    put(root, page.restored);
    notice = noticeLine(root, "前の返信文から回答を復元しました。");
  }
  if (notice !== null) top.after(notice);
  const keep = () => store.keep(snapshot);
  root.addEventListener("change", keep);
  root.addEventListener("input", keep);
  const scroll = tag("div", "fp-scroll");
  scroll.append(root);
  const toReply = () => {
    const open = verdict !== null && verdict.read().verdict === null;
    if (open) verdict.node.scrollIntoView({ block: "start" });
    else shell.querySelector<HTMLElement>(".fp-send-btn")?.focus();
  };
  const bars = drawBars(scroll, root, page.contextLabel, sender(root, send, verdict, () => store.forget()), toReply);
  shell.append(bars.top, scroll, bars.bottom, drawer.el);
  linkRefs(shell, drawer);
  return shell;
}

// A line under the title that says where the answers were put back from; it stays until the owner changes something.
function noticeLine(root: HTMLElement, text: string): HTMLElement {
  const line = tag("p", "fp-muted fp-restored", text);
  root.addEventListener("change", () => line.remove(), { once: true });
  return line;
}

// Puts each answer in its card: the choice, the free text and the mark of 仮置き. Each card tells the page (the verdict, the counts) with a `change`.
function put(root: HTMLElement, answers: PageAnswer[]) {
  for (const card of root.querySelectorAll<HTMLElement>(".fp-card")) {
    const answer = answers.find((a) => a.card === card.dataset.card);
    const box = card.querySelector<HTMLElement>(".fp-answer");
    if (answer === undefined || box === null) continue;
    for (const radio of box.querySelectorAll<HTMLInputElement>("input[type=radio]")) radio.checked = radio.value === answer.choice;
    const text = box.querySelector<HTMLTextAreaElement>(`textarea[data-for="${answer.choice ?? "note"}"]`) ?? box.querySelector<HTMLTextAreaElement>('textarea[data-for="note"]');
    if (text !== null) text.value = answer.note;
    const mark = box.querySelector<HTMLInputElement>(".fp-provisional input");
    if (mark !== null) mark.checked = answer.provisional;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

// The answers of the page as chosen: for each card that asks, its number, the key of the choice (null when none), its free text and whether the owner put the answer in for now. What the answers mean is Rust's.
function answersOf(root: HTMLElement): PageAnswer[] {
  return [...root.querySelectorAll<HTMLElement>(".fp-card")].flatMap((card) => {
    const box = card.querySelector<HTMLElement>(".fp-answer");
    if (box === null) return [];
    const chosen = box.querySelector<HTMLInputElement>("input[type=radio]:checked");
    // The free text of a lettered card is in the row of `その他` or of `ビジネス側に確認する`; any other card has one field under its choices.
    const text = box.querySelector<HTMLTextAreaElement>(`textarea[data-for="${chosen?.value}"]`) ?? box.querySelector<HTMLTextAreaElement>('textarea[data-for="note"]');
    const mark = box.querySelector<HTMLInputElement>(".fp-provisional input");
    return [{ card: card.dataset.card ?? "", choice: chosen?.value ?? null, note: text?.value ?? "", provisional: mark?.checked ?? false }];
  });
}

// 「あなたの判定」: the choice between approving the page's subject and asking for a revision of it, and the box for the revision that opens with the second. `read` gives the choice (null while none) and the writing, which is empty unless a revision is asked for.
interface Verdict {
  node: HTMLElement;
  read: () => { verdict: PageVerdict | null; revision: string };
  // Puts a choice and its writing back (what was kept in the browser).
  write: (verdict: PageVerdict | null, revision: string) => void;
}

const VERDICT_LABELS: Record<DecisionPage["subject"], [string, string]> = {
  requirement: ["要件定義を承認する", "要件定義の修正を依頼する"],
  design: ["基本設計を承認する", "基本設計の修正を依頼する"],
};
// The kinds whose `fix` is a request for a revision, and the kinds that are sent as a choice of their own when they have no answer: what the child reads for a card with no block (decision-page.md, "Reading the reply").
const FIXING = new Set<CardKind>(["must-fix"]);
const UNANSWERED_AS: Partial<Record<CardKind, (card: Card) => string | null>> = {
  nr: (card) => {
    const option = card.options.find((o) => o.key === card.recommendation);
    return option ? `${option.key}. ${option.label}` : null;
  },
  "structural-proposal": (card) => FIXED["structural-proposal"].find((c) => c.key === card.recommendation)?.label ?? null,
};

function verdictBox(root: HTMLElement, page: DecisionPage): Verdict {
  const group = `fp-verdict-${++cards}`;
  const cardOf = new Map<string, Card>(
    [...page.needsUserDecision, ...page.residualMustFix, ...page.structuralProposals, ...(page.adr === null ? [] : [page.adr])].map((c) => [c.number, c]),
  );
  const node = section("あなたの判定", "fp-verdict", "verdict");
  const unit = approvalUnit(page);
  if (unit !== null) node.append(tag("p", "fp-p fp-unit", unit));
  const box = tag("fieldset", "fp-answer");
  box.append(tag("legend", "fp-sr", "あなたの判定"));
  const radios = new Map<PageVerdict, HTMLInputElement>();
  const [approveLabel, reviseLabel] = VERDICT_LABELS[page.subject];
  for (const [key, text] of [["approve", approveLabel], ["revise", reviseLabel]] as const) {
    const row = tag("div", "fp-choice");
    const label = tag("label", "fp-choice-label");
    const radio = tag("input");
    radio.type = "radio";
    radio.name = group;
    radio.value = key;
    radios.set(key, radio);
    label.append(radio, tag("span", "", text));
    row.append(label);
    box.append(row);
  }
  const reason = tag("p", "fp-muted fp-verdict-reason");
  const revision = freeText("修正してほしいこと");
  revision.classList.add("fp-revision");
  const unanswered = tag("p", "fp-muted fp-unanswered");
  box.append(reason, revision, unanswered);
  node.append(box);
  const approve = radios.get("approve") as HTMLInputElement;
  const revise = radios.get("revise") as HTMLInputElement;
  const sync = () => {
    const cardsOf = [...root.querySelectorAll<HTMLElement>(".fp-card")];
    const fixing = cardsOf.filter((c) => FIXING.has(c.dataset.kind as CardKind) && c.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value === "fix").map((c) => c.dataset.card ?? "");
    // A revision choice and an approval do not go together: the approval cannot be chosen, and one chosen before turns into the request.
    approve.disabled = fixing.length > 0;
    if (fixing.length > 0 && approve.checked) revise.checked = true;
    reason.hidden = fixing.length === 0;
    reason.textContent = fixing.length === 0 ? "" : `修正を選んだカード（${fixing.join("、")}）があるので、承認は選べません`;
    revision.hidden = !revise.checked;
    const left = cardsOf.flatMap((c) => {
      const card = cardOf.get(c.dataset.card ?? "");
      const as = card ? UNANSWERED_AS[card.kind]?.(card) : undefined;
      return card && as && c.querySelector("input[type=radio]:checked") === null ? [`${card.number} ${as}`] : [];
    });
    unanswered.hidden = left.length === 0;
    unanswered.textContent = left.length === 0 ? "" : `答えていないカードは、この案で送ります: ${left.join("、")}`;
  };
  root.addEventListener("change", sync);
  sync();
  return {
    node,
    read: () => {
      const verdict = approve.checked ? "approve" : revise.checked ? "revise" : null;
      return { verdict, revision: verdict === "revise" ? revision.value : "" };
    },
    write: (verdict, text) => {
      approve.checked = verdict === "approve";
      revise.checked = verdict === "revise";
      revision.value = text;
      root.dispatchEvent(new Event("change"));
    },
  };
}

// 「リーダーに送る」 and the reason a send failed, in the bottom bar. The button waits while the send is on its way, so that a second press sends nothing, and while a page that asks for a verdict has none chosen; after a send that went through the page is closed by its owner (and what was kept in the browser is forgotten, `sent`), and after one that failed the answers stay and the button can be pressed again.
function sender(root: HTMLElement, send: Send, verdict: Verdict | null, sent: () => void): HTMLElement {
  const row = tag("div", "fp-send");
  const error = tag("p", "fp-error pending fail");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const button = tag("button", "text-btn primary fp-send-btn", "リーダーに送る");
  button.type = "button";
  let busy = false;
  const sync = () => {
    button.disabled = busy || (verdict !== null && verdict.read().verdict === null);
  };
  root.addEventListener("change", sync);
  sync();
  button.onclick = async () => {
    if (button.disabled) return;
    busy = true;
    sync();
    button.setAttribute("aria-busy", "true");
    error.hidden = true;
    try {
      const chosen = verdict?.read() ?? { verdict: null, revision: "" };
      await send(answersOf(root), chosen.verdict, chosen.revision);
      sent();
    } catch (e) {
      error.textContent = String(e);
      error.hidden = false;
      busy = false;
      sync();
      button.removeAttribute("aria-busy");
    }
  };
  row.append(error, button);
  return row;
}

// A section of the page, with an id that its link in the top bar and `#{id}` take (`key` is stable, so the address of a section can be kept).
function section(heading: string, className = "", key = ""): HTMLElement {
  const node = tag("section", `fp-section ${className}`.trim());
  if (key !== "") node.id = `${pageKey}-${key}`;
  node.append(tag("h3", "fp-sec", heading));
  return node;
}

// 「何が変わるか」: the lead, and the change sections (folded).
function changes(page: DecisionPage): HTMLElement {
  const node = section("何が変わるか", "", "changes");
  if (page.what !== null) node.append(termed("p", "fp-p", page.what));
  for (const change of page.changes) {
    const body = fold(change.heading, "fp-change");
    // What a block of the section folds is a tab of the section's own in the drawer.
    ownedBy(change.heading, () => body.append(...drawBlocks(change.blocks, !body.open)));
    node.append(body);
  }
  return node;
}

function risks(items: { title: string; text: string | null }[], evidence: Parameters<typeof drawEvidence>[0]): HTMLElement {
  const node = section("リスク・リリース上の注意", "fp-risks", "risks");
  const list = tag("ol", "fp-risk-list");
  for (const risk of items) {
    const li = tag("li");
    li.append(tag("b", "", risk.title));
    if (risk.text !== null) li.append(termed("p", "fp-muted", risk.text));
    list.append(li);
  }
  node.append(list);
  if (evidence.length > 0) node.append(ownedBy("リスク・リリース上の注意", () => evidenceButton(evidence)));
  return node;
}

// What the approval of a deliverable covers, as a fixed sentence by subject (the owner reads it where the approval is chosen and under 承認の対象).
const APPROVAL_UNIT: Partial<Record<DecisionPage["subject"], string>> = {
  requirement: "承認単位は requirement.json の全体です（technical-notes.md は内部調査資料のため承認対象外）。",
  design:
    "承認された時点で design.json の概要・設計項目（完了条件・テスト方針・ユーザー確認を含む）・実装順序・共有設計資料は「契約」として凍結されます（補足資料は承認済み証跡として同じ提示単位に含まれます）。実装は本承認の後にこの計画書から導出するため、別途の承認依頼は行いません（本承認が最後の承認です）。",
};

function approvalUnit(page: DecisionPage): string | null {
  return page.pageKind === "approval" ? (APPROVAL_UNIT[page.subject] ?? null) : null;
}

// 「承認の対象」: the groups of what the approval covers. A group that holds the design items keeps its heading and says where its items are (設計項目, above).
function scope(page: DecisionPage): HTMLElement {
  const node = section("承認の対象", "", "scope");
  for (const group of page.approvalScope) {
    node.append(tag("h4", "fp-h", group.heading));
    if (group.design) node.append(tag("p", "fp-muted", "上の「設計項目」に並べています。"));
    for (const item of group.items) {
      const row = tag("div", "fp-scope-item");
      row.append(tag("code", "fp-ev-path", item.ref ?? item.path ?? ""), termed("p", "fp-p", item.description));
      for (const extra of item.extras) row.append(tag("code", "fp-extra", extra));
      if (item.text !== null) {
        const text = item.text;
        // A node of a deliverable is drawn as the deliverable draws it, a Markdown file formatted, any other file as text.
        const content: FactContent = item.ref !== null ? { type: "node", root: item.root, ref: item.ref, text } : { type: item.path?.toLowerCase().endsWith(".md") ? "markdown" : "text", root: item.root, path: item.path ?? "", text };
        row.append(ownedBy(item.ref ?? item.path ?? "", () => foldOpener("中身", "中身を見る", (panel) => panel.append(drawFactContent(content, true)))));
      }
      node.append(row);
    }
  }
  const unit = approvalUnit(page);
  if (unit !== null) node.append(tag("p", "fp-p fp-unit", unit));
  return node;
}

// 「設計項目 {n} 件」: one row for each design item, with its id, its title (and the release it writes) and 「中身を見る」.
function designItems(items: DesignItem[]): HTMLElement {
  const node = section(`設計項目 ${items.length} 件`, "fp-design-items", "design-items");
  for (const item of items) {
    const row = tag("div", "fp-scope-item fp-design-item");
    row.dataset.design = item.id;
    row.append(tag("code", "fp-ev-path", item.id), tag("p", "fp-p", item.release === null ? item.title : `${item.title}（リリース ${item.release}）`));
    if (item.text !== null) {
      const text = item.text;
      row.append(ownedBy(`${item.id} ${item.title}`, () => foldOpener("中身", "中身を見る", (panel) => panel.append(drawFactContent({ type: "node", root: item.root, ref: item.ref, text }, true)))));
    }
    node.append(row);
  }
  return node;
}

// 「実装順序 {n} 件」: the repositories of the design in the order they are implemented, numbered from 1.
function implementationOrder(order: string[]): HTMLElement {
  const node = section(`実装順序 ${order.length} 件`, "fp-order", "order");
  const list = tag("ol", "fp-list");
  for (const repo of order) list.append(tag("li", "", repo));
  node.append(list);
  return node;
}

// 「確認する項目」: the cards, grouped by kind in the order of the page, a group with no card left out.
function groups(page: DecisionPage): HTMLElement[] {
  const list: [string, Card[]][] =
    page.pageKind === "open-questions"
      ? [["論点", page.questions]]
      : [
          ["判断が必要", page.needsUserDecision],
          ["未解消の必ず直す指摘", page.residualMustFix],
          ["構造改善の提案", page.structuralProposals],
          ["ADR（設計判断の記録）", page.adr === null ? [] : [page.adr]],
        ];
  return list
    .filter(([, cardsOf]) => cardsOf.length > 0)
    .map(([heading, cardsOf], i) => {
      const node = section(`${heading} ${cardsOf.length} 件`, "fp-group", `group-${i + 1}`);
      node.append(...cardsOf.map((card) => drawCard(card, page)));
      return node;
    });
}

// A card. One that asks (`question`, `nr`) opens its title with the tag 「聞きたいこと」 and shows no summary: 「具体的な場面」, the image of the screen, the first diagram as wide as the card and 「あなたの回答」, then 「詳しく見る」. Any other card shows its summary and its background, then its answer and 「詳しく見る」.
function drawCard(card: Card, page: DecisionPage): HTMLElement {
  const node = tag("article", "fp-card");
  node.dataset.card = card.number;
  node.dataset.kind = card.kind;
  const asks = LETTERED.has(card.kind);
  // Every card has an answer form and counts in the bottom bar; a `question` and a `must-fix` card must be answered, the others may be.
  node.dataset.form = "true";
  node.dataset.required = String(REQUIRED.has(card.kind));
  node.dataset.lettered = String(asks);
  // 「次の未回答へ」 gives the card the focus; the next key press reaches its first choice.
  node.tabIndex = -1;
  const head = tag("header", "fp-card-head");
  head.append(tag("span", "fp-number", card.number));
  if (asks) head.append(tag("span", "fp-asks", "聞きたいこと"));
  head.append(tag("h4", "fp-card-title", card.title));
  node.append(head);
  if (!asks) node.append(tag("p", "fp-p", card.summary));
  const blocks = [...card.blocks];
  if (asks) {
    if (card.scene !== null) node.append(tag("h4", "fp-h", "具体的な場面"), termed("p", "fp-p fp-scene", card.scene));
    if (card.sceneImage !== null) node.append(drawImage(card.sceneImage, false));
    // The first diagram of a card that asks is the flow of its scene, as wide as the card; the rest of the blocks are behind the fold.
    const first = blocks.findIndex((b) => b.type === "diagram");
    if (first >= 0) {
      const [diagram] = drawBlocks(blocks.splice(first, 1));
      diagram.dataset.wide = "true";
      node.append(diagram);
    }
  } else if (card.background !== null) node.append(tag("h4", "fp-h", "背景"), termed("p", "fp-p", card.background));
  if (asks) node.append(tag("h4", "fp-h", "あなたの回答"));
  node.append(answer(card, page));
  const more = ownedBy(`${card.number} ${card.title}`, () => detail(card, blocks, asks));
  if (more !== null) node.append(more);
  return node;
}

// 「詳しく見る」: a button that shows the card's folds in the drawer, as its tabs. 「詳細」: for a card with an occurrence, that block; then the scene of a card that does not ask, or the background of one that asks; the facts with 「中身を見る」; the rest of the blocks. 「根拠」: the table of the conditions against the options, and the evidence. A card that has nothing for 「詳細」 opens 「根拠」 alone.
function detail(card: Card, blocks: Card["blocks"], asks: boolean): HTMLElement | null {
  const hasDetail = card.occurrence !== null || (asks ? card.background !== null : card.scene !== null) || card.facts.length > 0 || blocks.length > 0;
  const hasEvidence = card.conditions.length > 0 || card.evidence.length > 0;
  if (!hasDetail && !hasEvidence) return null;
  const first = hasDetail ? registerFold("詳細", (panel) => panel.append(...detailParts(card, blocks, asks))) : null;
  const second = hasEvidence
    ? registerFold("根拠", (panel) => {
        if (card.conditions.length > 0) panel.append(conditionTable(card.conditions, card.options));
        if (card.evidence.length > 0) panel.append(drawEvidence(card.evidence));
      })
    : null;
  return foldButton((first ?? second) as NonNullable<typeof first>, "詳しく見る");
}

function detailParts(card: Card, blocks: Card["blocks"], asks: boolean): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (card.occurrence !== null) parts.push(...drawOccurrence(card.occurrence));
  if (!asks && card.scene !== null) parts.push(tag("h4", "fp-h", "具体的な場面"), termed("p", "fp-p fp-scene", card.scene));
  if (asks && card.background !== null) parts.push(tag("h4", "fp-h", "背景"), termed("p", "fp-p", card.background));
  if (card.facts.length > 0) {
    const facts = tag("dl", "fp-facts");
    for (const fact of card.facts) {
      const value = termed("dd", "", fact.value);
      if (fact.content !== null) {
        const content = fact.content;
        value.append(foldOpener(`中身を見る: ${fact.value}`, "中身を見る", (panel) => panel.append(drawFactContent(content, true))));
      }
      facts.append(tag("dt", "", fact.label), value);
    }
    parts.push(facts);
  }
  parts.push(...drawBlocks(blocks, true));
  return parts;
}

// 「発生条件」, 「発生頻度」 as a meter of three cells, 「影響」 and 「検知」.
const LIKELIHOOD: Record<Occurrence["likelihood"], [string, string]> = {
  rare: ["まれ", "■□□"],
  occasional: ["ときどき", "■■□"],
  frequent: ["頻繁", "■■■"],
};

function drawOccurrence(o: Occurrence): HTMLElement[] {
  const [word, cells] = LIKELIHOOD[o.likelihood];
  const meter = tag("div", "fp-meter");
  meter.dataset.level = o.likelihood;
  meter.append(tag("span", "fp-meter-cells", cells), tag("span", "fp-meter-word", word));
  const conditions = o.conditions.length === 1 ? termed("p", "fp-p", o.conditions[0]) : tag("ol", "fp-list");
  if (o.conditions.length > 1) for (const text of o.conditions) conditions.append(termed("li", "", text));
  return [
    tag("h4", "fp-h", o.conditions.length === 1 ? "発生条件" : "発生条件（すべて重なったときだけ起きる）"),
    conditions,
    tag("h4", "fp-h", "発生頻度"),
    meter,
    termed("p", "fp-muted", o.basis),
    tag("h4", "fp-h", "影響"),
    termed("p", "fp-p", o.impact),
    tag("h4", "fp-h", "検知"),
    termed("p", "fp-p", o.detectability),
  ];
}

// One row for each condition and one column for each option, each cell 「満たす」 or 「満たさない」.
function conditionTable(conditions: Condition[], options: CardOption[]): HTMLElement {
  const rows = conditions.map((c) => [{ text: `${c.id} ${c.text}`, changed: false }, ...options.map((o) => ({ text: o.unmet.some((u) => u.id === c.id) ? "満たさない" : "満たす", changed: false }))]);
  return drawTable(["必須条件", ...options.map((o) => o.key)], rows);
}

// A text in the style of an option: framed, in its size, weight and colour, with the numbers under it.
function drawSample(sample: Sample): HTMLElement {
  const node = tag("div", "fp-sample");
  const frame = tag("div", "fp-sample-frame", sample.text);
  frame.style.fontSize = `${sample.fontSize}px`;
  frame.style.fontWeight = String(sample.fontWeight);
  if (sample.color !== null) frame.style.color = sample.color;
  node.append(frame, tag("p", "fp-muted fp-sample-note", `文字の大きさ ${sample.fontSize}px・太さ ${sample.fontWeight}${sample.color === null ? "" : `・色 ${sample.color}`}`));
  return node;
}

// 「この選択肢の詳細」 of a lettered option: its detail, the sample, the image, the diagram and 「満たさない必須条件」, in that order; of a fixed choice, its entry of `choiceDetails`. None when it has nothing. Everything in it waits for the fold to be opened.
function optionDetail(option: CardOption | undefined, fixed: string | undefined, conditions: Condition[]): HTMLElement | null {
  const parts: HTMLElement[] = [];
  const text = option?.detail ?? fixed;
  if (text) parts.push(termed("p", "fp-p", text));
  if (option?.sample) parts.push(drawSample(option.sample));
  if (option?.image) parts.push(drawImage(option.image, true));
  if (option?.diagram) parts.push(...drawBlocks([{ type: "diagram", mermaid: option.diagram, caption: null }], true));
  if (option && option.unmet.length > 0) {
    parts.push(tag("h4", "fp-h", "満たさない必須条件"));
    for (const unmet of option.unmet) {
      const entry = tag("div", "fp-unmet");
      entry.append(tag("p", "fp-p", `${unmet.id} ${conditions.find((c) => c.id === unmet.id)?.text ?? ""}`.trim()), tag("p", "fp-muted", unmet.reason));
      parts.push(entry);
    }
  }
  if (parts.length === 0) return null;
  const more = fold("この選択肢の詳細", "fp-detail");
  more.append(...parts);
  return more;
}

// The choices of a card that asks, and its free text. On a `question` of a page with `hold` the row 「ビジネス側に確認する」 stands between 「調べてから決めて」 and 「その他」, with a box of its own; on a `question` of a requirement the check 「仮置き（ビジネス側の確認待ち）」 stands under the choices.
function answer(card: Card, page: DecisionPage): HTMLElement {
  const group = `fp-answer-${++cards}`;
  const lettered = LETTERED.has(card.kind);
  const fixed = card.kind === "question" && page.hold ? [FIXED.question[0], HOLD, FIXED.question[1]] : FIXED[card.kind];
  const choices: Choice[] = [...(lettered ? card.options.map((o) => ({ key: o.key, label: o.label })) : []), ...fixed];
  const options = new Map(card.options.map((o) => [o.key, o]));
  const box = tag("fieldset", "fp-answer");
  box.append(tag("legend", "fp-sr", "あなたの回答"));
  // The boxes of the rows that hold free text, by the key of the row (`other`, `hold`), shown while their row is chosen.
  const texts = new Map<string, HTMLTextAreaElement>();
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
    if (lettered && choice.key !== "other" && options.has(choice.key)) label.append(tag("b", "fp-key", choice.key));
    label.append(tag("span", "", choice.label));
    if (recommended) label.append(tag("span", "fp-rec", "推奨"));
    row.append(label);
    if (recommended && card.recommendationReason !== null) row.append(termed("p", "fp-reason", `理由: ${card.recommendationReason}`));
    const more = optionDetail(options.get(choice.key), card.choiceDetails[choice.key], card.conditions);
    if (more !== null) row.append(more);
    if (lettered && (choice.key === "other" || choice.key === HOLD.key)) {
      const text = freeText(choice.label);
      text.dataset.for = choice.key;
      text.hidden = true;
      texts.set(choice.key, text);
      row.append(text);
    }
    box.append(row);
  }
  if (!lettered) {
    const note = tag("label", "fp-note");
    note.append(tag("span", "", NOTE_LABEL[card.kind] ?? "補足（任意）"));
    const text = freeText(NOTE_LABEL[card.kind] ?? "補足（任意）");
    text.dataset.for = "note";
    note.append(text);
    box.append(note);
  }
  let provisional: HTMLInputElement | null = null;
  if (card.kind === "question" && page.pageKind === "open-questions" && page.subject === "requirement") {
    const row = tag("label", "fp-provisional");
    provisional = tag("input");
    provisional.type = "checkbox";
    row.append(provisional, tag("span", "", "仮置き（ビジネス側の確認待ち）"));
    box.append(row);
  }
  const cancel = tag("button", "text-btn fp-cancel", "選択を取り消す");
  cancel.type = "button";
  cancel.disabled = true;
  box.append(cancel);
  const sync = () => {
    const chosen = box.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value;
    cancel.disabled = chosen === undefined && !provisional?.checked;
    // The free text of a lettered card is for `その他` and `ビジネス側に確認する` alone, each in its own row.
    for (const [key, text] of texts) text.hidden = chosen !== key;
    // An answer that is to be looked up (調べてから決めて) or taken to the business side cannot be put in for now.
    if (provisional !== null) {
      const off = chosen === "investigate" || chosen === HOLD.key;
      if (off) provisional.checked = false;
      provisional.disabled = off;
      provisional.closest("label")?.toggleAttribute("data-on", provisional.checked);
    }
  };
  box.addEventListener("change", sync);
  cancel.onclick = () => {
    for (const radio of box.querySelectorAll<HTMLInputElement>("input[type=radio]:checked")) radio.checked = false;
    if (provisional !== null) provisional.checked = false;
    // The change reaches the page, whose verdict follows the choices of the cards.
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return box;
}

function freeText(name: string): HTMLTextAreaElement {
  const text = tag("textarea", "fp-text");
  text.rows = 2;
  text.setAttribute("aria-label", name);
  return text;
}

// 「参考」: what the owner may want to look at after the cards, under one heading, each matter a row that opens in place (closed at first) with its heading as an `h3` in the row. On an approval: the decisions that wait for the business side, what settled, the questions that were withdrawn, the matters noticed outside the request and how the quality loop went; a row with nothing is left out, and the page with no row has no 「参考」.
function referenceOf(page: DecisionPage): HTMLElement | null {
  const parts: (HTMLElement | null)[] = [];
  if (page.pageKind === "approval") {
    parts.push(awaiting(page), settled(page), withdrawn(page.withdrawnNeedsUserDecision), noticed(page.noticed), qualityLoop(page));
  }
  const drawn = parts.filter((part): part is HTMLElement => part !== null);
  if (drawn.length === 0) return null;
  const node = section("参考", "fp-reference", "reference");
  node.append(...drawn);
  return node;
}

// A row of 「参考」: a fold that opens in place, whose summary holds the heading. `key` is the part of its id after the page's (`#{id}` opens it).
function reference(heading: string, className: string, key: string): HTMLDetailsElement {
  const node = fold("", `fp-ref ${className}`);
  node.id = `${pageKey}-ref-${key}`;
  node.querySelector("summary")?.append(tag("h3", "fp-h", heading));
  return node;
}

// 「ビジネス側の確認待ち」: the decisions that were put in for now on the approval of a requirement, one on each row.
function awaiting(page: DecisionPage): HTMLElement | null {
  const items = page.subject === "requirement" ? page.settledDecisions.filter((item) => item.provisional) : [];
  if (items.length === 0) return null;
  const node = reference("ビジネス側の確認待ち", "fp-awaiting", "awaiting");
  for (const item of items) node.append(settledRow(item, false));
  return node;
}

function settledRow(item: SettledDecision, mark: boolean): HTMLElement {
  const row = tag("div", "fp-settled");
  if (mark) row.dataset.provisional = "true";
  row.append(tag("code", "fp-ev-path", item.id), termed("p", "fp-p", item.decision), termed("p", "fp-muted", `理由: ${item.reason}`));
  if (mark) row.append(tag("p", "fp-muted", "仮置き（ビジネス側の確認待ち）"));
  if (item.evidence.length > 0) {
    const evidence = item.evidence;
    row.append(ownedBy(item.id, () => evidenceButton(evidence)));
  }
  return row;
}

// 「決まったこと」: a decision that waits for the business side carries the line that says so (on a requirement only).
function settled(page: DecisionPage): HTMLElement | null {
  if (page.settledDecisions.length === 0) return null;
  const node = reference("決まったこと", "fp-settled-list", "settled");
  for (const item of page.settledDecisions) node.append(settledRow(item, item.provisional && page.subject === "requirement"));
  return node;
}

// 「取り下げた質問」: the questions that the final deliverable already settles. They ask no answer.
function withdrawn(items: DecisionPage["withdrawnNeedsUserDecision"]): HTMLElement | null {
  if (items.length === 0) return null;
  const node = reference("取り下げた質問", "fp-withdrawn", "withdrawn");
  for (const item of items) {
    const row = tag("div", "fp-settled");
    row.append(tag("code", "fp-ev-path", item.number), tag("p", "fp-p", item.title), termed("p", "fp-muted", `取り下げた理由: ${item.withdrawalReason}`));
    node.append(row);
  }
  return node;
}

// 「目標外の事柄」: what was noticed outside the request and not reflected. It has no answer form, and only what the owner names is fixed.
function noticed(items: DecisionPage["noticed"]): HTMLElement | null {
  if (items.length === 0) return null;
  const node = reference("目標外の事柄", "fp-noticed", "noticed");
  node.append(tag("p", "fp-muted", "名指しで依頼したものだけ直します。"));
  for (const item of items) {
    const row = tag("div", "fp-settled");
    row.append(tag("h4", "fp-h", item.title), termed("p", "fp-p", item.text));
    if (item.evidence.length > 0) {
      const evidence = item.evidence;
      row.append(ownedBy(item.title, () => evidenceButton(evidence)));
    }
    node.append(row);
  }
  return node;
}

function qualityLoop(page: DecisionPage): HTMLElement | null {
  const loop = page.qualityLoop;
  if (loop === null) return null;
  const node = reference("品質チェックの結果", "fp-quality", "quality");
  node.append(tag("p", "fp-p", `実施回数: ${loop.rounds} 回`));
  if (loop.fixCycles !== null) node.append(tag("p", "fp-p", `MustFix 修正: ${loop.fixCycles} 回`));
  node.append(tag("p", "fp-p", `解消した必ず直す指摘: ${loop.mustFixResolved} 件`));
  return node;
}
