// The decision page of a child (A-41): what `formation_page_read` gives, drawn in the middle pane under the tab 「判断: {title}」 (formation-flow.ts). The page is the child's text, so everything goes in as `textContent` (formation-page-blocks.ts); nothing is read as HTML.
// A card that asks has its choices as radios and a box for free text; an approval and a code review end with 「あなたの判定」, the owner's choice between approving and asking for a revision, and 「リーダーに送る」 hands what was chosen to `send` (the reply is made and sent in Rust, #923). The screen keeps the verdict and a `fix` from contradicting each other and shows what an unanswered card will be sent as; what the answers mean is Rust's.
import type { Card } from "./bindings/Card";
import type { CardKind } from "./bindings/CardKind";
import type { CardOption } from "./bindings/CardOption";
import type { Condition } from "./bindings/Condition";
import type { DecisionPage } from "./bindings/DecisionPage";
import type { Occurrence } from "./bindings/Occurrence";
import type { PageAnswer } from "./bindings/PageAnswer";
import type { PageVerdict } from "./bindings/PageVerdict";
import type { Sample } from "./bindings/Sample";
import type { ScopeGroup } from "./bindings/ScopeGroup";
import type { SettledDecision } from "./bindings/SettledDecision";
import { tag } from "./dom.js";
import { drawBlocks, drawEvidence, drawFactContent, drawImage, drawTable, fold, useImages } from "./formation-page-blocks.js";
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

// The verdict of a page and the writing of a revision, as chosen; `send` fails with the message when the reply could not be sent.
type Send = (answers: PageAnswer[], verdict: PageVerdict | null, revision: string) => Promise<void>;

export function drawPage(page: DecisionPage, formation: string, child: string, atMs: number, send: Send): HTMLElement {
  useImages((root, path) => invoke("formation_page_image", { name: formation, child, root, path }));
  const root = tag("article", "fp");
  root.dataset.child = child;
  root.dataset.at = String(atMs);
  root.dataset.kind = page.pageKind;
  const top = tag("header", "fp-top");
  top.append(tag("h2", "fp-title", page.title), tag("span", "fp-from", `${child} から`), tag("p", "fp-context", page.contextLabel));
  root.append(top);
  if (page.pageKind === "code-review") {
    const pr = pullRequest(page);
    if (pr !== null) root.append(pr);
  }
  if (page.pageKind !== "open-questions") root.append(changes(page));
  if (page.risks !== null) root.append(risks(page.risks.items, page.risks.evidence));
  if (page.approvalScope.length > 0) root.append(scope(page.approvalScope));
  root.append(...groups(page));
  const reference = referenceOf(page);
  if (reference !== null) root.append(reference);
  const verdict = page.pageKind === "open-questions" ? null : verdictBox(root, page);
  if (verdict !== null) root.append(verdict.node);
  root.append(sender(root, send, verdict));
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

// 「あなたの判定」: the choice between approving the page's subject and asking for a revision of it, and the box for the revision that opens with the second. `read` gives the choice (null while none) and the writing, which is empty unless a revision is asked for.
interface Verdict {
  node: HTMLElement;
  read: () => { verdict: PageVerdict | null; revision: string };
}

const VERDICT_LABELS: Record<DecisionPage["subject"], [string, string]> = {
  requirement: ["要件定義を承認する", "要件定義の修正を依頼する"],
  design: ["基本設計を承認する", "基本設計の修正を依頼する"],
  code: ["この変更を承認する", "修正を依頼する"],
};
// The kinds whose `fix` is a request for a revision, and the kinds that are sent as a choice of their own when they have no answer: what the child reads for a card with no block (decision-page.md, "Reading the reply").
const FIXING = new Set<CardKind>(["must-fix", "review-must-fix"]);
const UNANSWERED_AS: Partial<Record<CardKind, (card: Card) => string | null>> = {
  nr: (card) => {
    const option = card.options.find((o) => o.key === card.recommendation);
    return option ? `${option.key}. ${option.label}` : null;
  },
  "structural-proposal": (card) => FIXED["structural-proposal"].find((c) => c.key === card.recommendation)?.label ?? null,
  "review-must-fix": () => "現状で完了する",
};

function verdictBox(root: HTMLElement, page: DecisionPage): Verdict {
  const group = `fp-verdict-${++cards}`;
  const cardOf = new Map<string, Card>(
    [...page.needsUserDecision, ...page.residualMustFix, ...page.structuralProposals, ...(page.adr === null ? [] : [page.adr]), ...page.unmetCriteria].map((c) => [c.number, c]),
  );
  const node = section("あなたの判定", "fp-verdict");
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
    const fixing = cardsOf.filter((c) => FIXING.has(c.dataset.kind as CardKind) && c.querySelector<HTMLInputElement>("input:checked")?.value === "fix").map((c) => c.dataset.card ?? "");
    // A revision choice and an approval do not go together: the approval cannot be chosen, and one chosen before turns into the request.
    approve.disabled = fixing.length > 0;
    if (fixing.length > 0 && approve.checked) revise.checked = true;
    reason.hidden = fixing.length === 0;
    reason.textContent = fixing.length === 0 ? "" : `修正を選んだカード（${fixing.join("、")}）があるので、承認は選べません`;
    revision.hidden = !revise.checked;
    const left = cardsOf.flatMap((c) => {
      const card = cardOf.get(c.dataset.card ?? "");
      const as = card ? UNANSWERED_AS[card.kind]?.(card) : undefined;
      return card && as && c.querySelector("input:checked") === null ? [`${card.number} ${as}`] : [];
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
  };
}

// 「リーダーに送る」 and the reason a send failed. The button waits while the send is on its way, so that a second press sends nothing, and while a page that asks for a verdict has none chosen; after a send that went through the page is closed by its owner, and after one that failed the answers stay and the button can be pressed again.
function sender(root: HTMLElement, send: Send, verdict: Verdict | null): HTMLElement {
  const row = tag("footer", "fp-send");
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

// The pull request of a code review, right under the title: its URL and 「開く」, which opens it in the default browser; with no pull request, the reason (`note`) in its place. The URL is the child's text, so only an `https` one gets the button (Rust opens http and https alone).
function pullRequest(page: DecisionPage): HTMLElement | null {
  const pr = page.pr;
  if (pr === null) return null;
  const node = tag("div", "fp-pr");
  const url = pr.url;
  if (url !== null) {
    node.append(tag("code", "fp-ev-path fp-pr-url", url));
    if (isHttps(url)) {
      const error = tag("p", "fp-error pending fail");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const open = tag("button", "text-btn fp-pr-open", "開く");
      open.type = "button";
      open.onclick = () => {
        error.hidden = true;
        invoke("orca_open_url", { url }).catch((e) => {
          error.textContent = String(e);
          error.hidden = false;
        });
      };
      node.append(open, error);
    }
  } else if (pr.note !== null) {
    node.append(tag("p", "fp-p", pr.note));
  }
  return node.childElementCount === 0 ? null : node;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
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

// 「確認する項目」: the cards, grouped by kind in the order of the page, a group with no card left out. An unmet criterion that a card of the page causes is shown on that card (「反するリリース条件」), and in its own group only when it names a card that the page does not have, or none.
function groups(page: DecisionPage): HTMLElement[] {
  const cardNumbers = new Set([...page.residualMustFix, ...page.needsUserDecision].map((c) => c.number));
  const unmet = page.unmetCriteria.filter((c) => c.cards.length === 0 || c.cards.some((n) => !cardNumbers.has(n)));
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
            ["満たしていないリリース条件", unmet],
            ["判断が必要", page.needsUserDecision],
          ];
  return list
    .filter(([, cardsOf]) => cardsOf.length > 0)
    .map(([heading, cardsOf]) => {
      const node = section(`${heading} ${cardsOf.length} 件`, "fp-group");
      node.append(...cardsOf.map((card) => drawCard(card, page.unmetCriteria.filter((u) => u.cards.includes(card.number)))));
      return node;
    });
}

// A card. One that asks (`question`, `nr`, `review-decision`) opens its title with the tag 「聞きたいこと」 and shows no summary: 「具体的な場面」, the image of the screen, the first diagram as wide as the card, the unmet release conditions it causes and 「あなたの回答」, then 「詳しく見る」. Any other card shows its summary, its background and the unmet conditions, then its answer and 「詳しく見る」.
function drawCard(card: Card, causes: Card[]): HTMLElement {
  const node = tag("article", "fp-card");
  node.dataset.card = card.number;
  node.dataset.kind = card.kind;
  const asks = LETTERED.has(card.kind);
  const head = tag("header", "fp-card-head");
  head.append(tag("span", "fp-number", card.number));
  if (asks) head.append(tag("span", "fp-asks", "聞きたいこと"));
  head.append(tag("h4", "fp-card-title", card.title));
  node.append(head);
  if (!asks) node.append(tag("p", "fp-p", card.summary));
  if (card.kind === "unmet-criterion" && card.cards.length > 0) node.append(tag("p", "fp-muted", card.cards.join("、")));
  const blocks = [...card.blocks];
  if (asks) {
    if (card.scene !== null) node.append(tag("h4", "fp-h", "具体的な場面"), tag("p", "fp-p fp-scene", card.scene));
    if (card.sceneImage !== null) node.append(drawImage(card.sceneImage, false));
    // The first diagram of a card that asks is the flow of its scene, as wide as the card; the rest of the blocks are behind the fold.
    const first = blocks.findIndex((b) => b.type === "diagram");
    if (first >= 0) {
      const [diagram] = drawBlocks(blocks.splice(first, 1));
      diagram.dataset.wide = "true";
      node.append(diagram);
    }
  } else if (card.background !== null) node.append(tag("h4", "fp-h", "背景"), tag("p", "fp-p", card.background));
  if (causes.length > 0) {
    node.append(tag("h4", "fp-h", "反するリリース条件"));
    for (const cause of causes) node.append(tag("p", "fp-p fp-cause", cause.title), tag("p", "fp-muted", cause.summary));
  }
  if (asks) node.append(tag("h4", "fp-h", "あなたの回答"));
  if (FIXED[card.kind].length > 0) node.append(answer(card));
  const more = detail(card, blocks, asks);
  if (more !== null) node.append(more);
  return node;
}

// 「詳しく見る」: for a card with an occurrence, that block; then the scene of a card that does not ask, or the background of one that asks; the facts with 「中身を見る」; the rest of the blocks; the table of the conditions against the options, and the evidence.
function detail(card: Card, blocks: Card["blocks"], asks: boolean): HTMLElement | null {
  const parts: HTMLElement[] = [];
  if (card.occurrence !== null) parts.push(...drawOccurrence(card.occurrence));
  if (!asks && card.scene !== null) parts.push(tag("h4", "fp-h", "具体的な場面"), tag("p", "fp-p fp-scene", card.scene));
  if (asks && card.background !== null) parts.push(tag("h4", "fp-h", "背景"), tag("p", "fp-p", card.background));
  if (card.facts.length > 0) {
    const facts = tag("dl", "fp-facts");
    for (const fact of card.facts) {
      const value = tag("dd", "", fact.value);
      if (fact.content !== null) {
        const content = fold("中身を見る", "fp-more fp-fact");
        content.append(drawFactContent(fact.content, true));
        value.append(content);
      }
      facts.append(tag("dt", "", fact.label), value);
    }
    parts.push(facts);
  }
  parts.push(...drawBlocks(blocks, true));
  if (card.conditions.length > 0) parts.push(conditionTable(card.conditions, card.options));
  if (card.evidence.length > 0) parts.push(drawEvidence(card.evidence));
  if (parts.length === 0) return null;
  const more = fold("詳しく見る", "fp-more");
  more.append(...parts);
  return more;
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
  const conditions = o.conditions.length === 1 ? tag("p", "fp-p", o.conditions[0]) : tag("ol", "fp-list");
  if (o.conditions.length > 1) for (const text of o.conditions) conditions.append(tag("li", "", text));
  return [
    tag("h4", "fp-h", o.conditions.length === 1 ? "発生条件" : "発生条件（すべて重なったときだけ起きる）"),
    conditions,
    tag("h4", "fp-h", "発生頻度"),
    meter,
    tag("p", "fp-muted", o.basis),
    tag("h4", "fp-h", "影響"),
    tag("p", "fp-p", o.impact),
    tag("h4", "fp-h", "検知"),
    tag("p", "fp-p", o.detectability),
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

// 「この選択肢の詳細」 of a lettered option: its detail, 「直し方」, the sample, the image, the diagram and 「満たさない必須条件」, in that order; of a fixed choice, its entry of `choiceDetails`. None when it has nothing. Everything in it waits for the fold to be opened.
function optionDetail(option: CardOption | undefined, fixed: string | undefined, conditions: Condition[]): HTMLElement | null {
  const parts: HTMLElement[] = [];
  const text = option?.detail ?? fixed;
  if (text) parts.push(tag("p", "fp-p", text));
  if (option?.fix) parts.push(tag("h4", "fp-h", "直し方"), tag("p", "fp-p", option.fix));
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

// The choices of a card that asks, and its free text.
function answer(card: Card): HTMLElement {
  const group = `fp-answer-${++cards}`;
  const lettered = LETTERED.has(card.kind);
  const choices: Choice[] = [...(lettered ? card.options.map((o) => ({ key: o.key, label: o.label })) : []), ...FIXED[card.kind]];
  const options = new Map(card.options.map((o) => [o.key, o]));
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
    if (lettered && choice.key !== "other" && options.has(choice.key)) label.append(tag("b", "fp-key", choice.key));
    label.append(tag("span", "", choice.label));
    if (recommended) label.append(tag("span", "fp-rec", "推奨"));
    row.append(label);
    if (recommended && card.recommendationReason !== null) row.append(tag("p", "fp-reason", `理由: ${card.recommendationReason}`));
    const more = optionDetail(options.get(choice.key), card.choiceDetails[choice.key], card.conditions);
    if (more !== null) row.append(more);
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

// 「参考」: what settled, how the quality loop went and the earlier reply. A section with nothing is left out.
function referenceOf(page: DecisionPage): HTMLElement | null {
  const parts: HTMLElement[] = [];
  if (page.settledDecisions.length > 0) parts.push(settled(page.settledDecisions));
  if (page.qualityLoop !== null) {
    const node = tag("div", "fp-ref");
    node.append(tag("h4", "fp-h", "品質チェックの結果"), tag("p", "fp-p", `実施回数: ${page.qualityLoop.rounds} 回`), tag("p", "fp-p", `解消した必ず直す指摘: ${page.qualityLoop.mustFixResolved} 件`));
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
