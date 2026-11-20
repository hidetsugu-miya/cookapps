// A node of requirement.json or design.json as the deliverable draws it (A-41, formation-page-blocks.ts): a requirement, a design item, a shared material, an appendix, a User Decision or a decision with its headings, tables and Markdown; any other node as its fields. The node is the child's, so every text goes in as `textContent`, and a Markdown field goes through marked and DOMPurify. What the deliverable derives from the rest of its file (the names of other items, the shared materials that apply, who depends on a design item) is not in the node, so it is not drawn.
import { tag } from "./dom.js";

type Json = unknown;
type Obj = Record<string, Json>;

// Markdown that a page cites, as HTML. Raw HTML in it is not kept as markup, and a link that is not http(s) stays text only: the file is the child's, and the page draws only what Markdown itself makes (headings, lists, tables, code, emphasis, links).
const MARKDOWN_SANITIZE = {
  ALLOWED_TAGS: ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "pre", "code", "em", "strong", "del", "blockquote", "hr", "br", "table", "thead", "tbody", "tr", "th", "td", "a"],
  ALLOWED_ATTR: ["href", "start"],
  ALLOWED_URI_REGEXP: /^https?:/i,
  ALLOW_DATA_ATTR: false,
};

export function markdownBlock(text: string): HTMLElement {
  const node = tag("div", "fp-md");
  node.innerHTML = DOMPurify.sanitize(marked.parse(text), MARKDOWN_SANITIZE);
  return node;
}

const isObject = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: Json): Json[] => (Array.isArray(v) ? v : []);
const str = (v: Json): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const strs = (v: Json): string[] => list(v).filter((x): x is string => typeof x === "string");
const field = (v: Json, key: string): Json => (isObject(v) ? v[key] : undefined);

const missing = (text = "未記入") => tag("span", "fp-missing", text);

// A plain text, with its line breaks, or the mark that nothing is written.
function plain(v: Json, name: "p" | "td" | "li" = "p"): HTMLElement {
  const text = str(v);
  const node = tag(name, "fp-doc-text");
  if (text === null) node.append(missing());
  else node.textContent = text;
  return node;
}

function md(v: Json): HTMLElement {
  const text = str(v);
  if (text === null) {
    const node = tag("p", "fp-doc-text");
    node.append(missing());
    return node;
  }
  return markdownBlock(text);
}

function inline(v: Json): HTMLElement {
  const item = tag("li", "fp-doc-li");
  item.append(md(v));
  return item;
}

// A table; a cell that is already a `td` is a cell as it is, any other element goes inside one.
function table(header: string[], rows: HTMLElement[][]): HTMLElement {
  const wrap = tag("div", "fp-table-wrap");
  const node = tag("table", "fp-table");
  const head = tag("tr");
  for (const label of header) head.append(tag("th", "", label));
  const thead = tag("thead");
  thead.append(head);
  const body = tag("tbody");
  for (const cells of rows) {
    const row = tag("tr");
    for (const cell of cells) {
      if (cell.tagName === "TD") {
        row.append(cell);
      } else {
        const td = tag("td");
        td.append(cell);
        row.append(td);
      }
    }
    body.append(row);
  }
  node.append(thead, body);
  wrap.append(node);
  return wrap;
}

const code = (text: string) => tag("code", "fp-ev-path", text);
const idref = (text: string) => tag("span", "fp-idref", text);

function titled(id: string, name: Json): HTMLElement {
  const node = tag("h3", "fp-doc-title");
  node.append(idref(id), `: ${str(name) ?? ""}`);
  if (str(name) === null) node.append(missing());
  return node;
}

function topicTitled(name: Json, topic: string, level: "h3" | "h4" = "h3"): HTMLElement {
  const node = tag(level, "fp-doc-title");
  if (str(name) === null) node.append(missing());
  else node.append(str(name) as string);
  node.append(" ", code(topic));
  return node;
}

const sub = (text: string) => tag("h4", "fp-doc-sub", text);

function userDecision(ud: Json): HTMLElement {
  const node = tag("section", "fp-doc-block");
  const head = tag("h4", "fp-doc-sub");
  head.append(idref(str(field(ud, "id")) ?? ""), `: ${str(field(ud, "title")) ?? ""}`);
  if (field(ud, "provisional") === true) head.append(" ", tag("span", "fp-provisional", "仮置き（ビジネス側の確認待ち）"));
  node.append(head, md(field(ud, "body")));
  return node;
}

// The materials a node lists itself: the appendices it names, the materials of its own and the ones that do not apply.
function materials(node: Obj): HTMLElement {
  const rows: HTMLElement[][] = [];
  for (const a of list(node.related_appendices)) rows.push([plain(field(a, "topic"), "td"), plain("あり", "td"), plain(field(a, "role"), "td")]);
  for (const m of list(node.extra_materials)) rows.push([plain(field(m, "name"), "td"), plain("あり", "td"), plain(field(m, "role"), "td")]);
  for (const m of list(node.inapplicable_materials)) rows.push([plain(field(m, "name"), "td"), plain("なし", "td"), plain(field(m, "reason"), "td")]);
  return table(["資料", "適用", "位置づけ・理由"], rows);
}

function extras(node: Obj, level: "h3" | "h4"): HTMLElement[] {
  return list(node.extra_materials).map((m) => {
    const section = tag("section", "fp-doc-block");
    section.append(topicTitled(field(m, "name"), str(field(m, "topic")) ?? "", level), tag("p", "fp-muted", `位置づけ: ${str(field(m, "role")) ?? ""}`), md(field(m, "body")));
    return section;
  });
}

function orderedList(items: Json[], name: "ol" | "ul" = "ol"): HTMLElement {
  if (items.length === 0) return plain(null);
  const node = tag(name, "fp-doc-list");
  for (const item of items) node.append(inline(item));
  return node;
}

function requirementItem(v: Obj): HTMLElement {
  const root = tag("article", "fp-doc");
  root.append(titled(str(v.id) ?? "", v.name), sub("概要"), plain(v.summary), sub("期待される動作"), orderedList(list(v.expected_behaviors), "ul"));
  const decisions = list(v.user_decisions);
  const refs = strs(v.user_decision_refs);
  if (decisions.length > 0 || refs.length > 0) {
    root.append(sub("関連 User Decision"), ...decisions.map(userDecision));
    if (refs.length > 0) {
      const ul = tag("ul", "fp-doc-list");
      for (const id of refs) ul.append(tag("li", "", id));
      root.append(ul);
    }
  }
  root.append(sub("関連要件資料"), materials(v), ...extras(v, "h4"));
  return root;
}

function application(v: Obj, header: string): HTMLElement {
  return table(
    [header, `本 ${header === "適用 REQ" ? "REQ" : "DESIGN"} での位置づけ`],
    list(v.applies_to).map((a) => [plain(field(a, "id"), "td"), plain(field(a, "role"), "td")]),
  );
}

function requirementShared(v: Obj): HTMLElement {
  const root = tag("article", "fp-doc");
  root.append(topicTitled(v.name, str(v.topic) ?? ""), sub("適用対象"), application(v, "適用 REQ"));
  if (str(v.body) !== null) root.append(sub("内容"), md(v.body));
  root.append(...list(v.user_decisions).map(userDecision));
  return root;
}

function designShared(v: Obj): HTMLElement {
  const root = tag("article", "fp-doc");
  root.append(topicTitled(v.name, str(v.topic) ?? ""), sub("適用対象"), application(v, "適用 DESIGN"));
  if (str(v.body) !== null) root.append(sub("内容"), md(v.body));
  root.append(...list(v.decisions).map(decision));
  return root;
}

function appendix(v: Obj): HTMLElement {
  const root = tag("section", "fp-doc-block");
  root.append(topicTitled(v.name, str(v.topic) ?? ""), tag("p", "fp-muted", `種別: ${str(v.category) ?? ""}`), md(v.body));
  return root;
}

function decision(v: Json): HTMLElement {
  const root = tag("section", "fp-doc-block");
  const options = list(field(v, "options"));
  const recommended = str(field(v, "recommended"));
  const index = recommended === null ? -1 : recommended.charCodeAt(0) - 65;
  const label = tag("p", "fp-doc-text");
  label.append("推奨案は ");
  if (recommended === null) label.append(missing("未設定"));
  else label.append(`(${recommended})${index >= 0 && index < options.length ? ` ${str(field(options[index], "label")) ?? ""}` : ""}`);
  label.append("（採択）、推奨理由は次のとおり。");
  const choices = tag("ul", "fp-doc-list");
  options.forEach((o, i) => {
    const item = tag("li", "fp-doc-li");
    const key = String.fromCharCode(65 + i);
    item.append(tag("strong", "", `(${key}) ${str(field(o, "label")) ?? ""}`));
    if (recommended === key) item.append("（採択）");
    item.append(md(field(o, "description")));
    choices.append(item);
  });
  const impact = strs(field(v, "impact"));
  const impacts = tag("p", "fp-doc-text", "影響範囲: ");
  if (impact.length === 0) impacts.append(missing());
  impact.forEach((x, i) => {
    if (i > 0) impacts.append(" / ");
    impacts.append(i === 0 ? tag("strong", "", x) : x, ...(i === 0 ? ["（主区分）"] : []));
  });
  root.append(tag("h4", "fp-doc-sub", `選択肢と推奨案: ${str(field(v, "subject")) ?? ""}`), label, md(field(v, "reason")), tag("p", "fp-doc-text", "選択肢:"), choices, impacts);
  return root;
}

function designItem(v: Obj): HTMLElement {
  const root = tag("article", "fp-doc");
  const scope = isObject(v.scope) ? v.scope : {};
  const requirements = strs(v.requirements);
  const depends = list(v.depends_on).map((d) => str(field(d, "id")) ?? "");
  const meta = [`種別: ${str(v.kind) ?? ""}`, `対象リポジトリ: ${str(v.repository) ?? ""}`];
  if (typeof v.release === "number" && v.release > 0) meta.push(`リリース: ${v.release}`);
  meta.push(`要件: ${requirements.length > 0 ? requirements.join(", ") : "-"}`);
  if (depends.length > 0) meta.push(`依存先: ${depends.join(", ")}`);
  root.append(titled(str(v.id) ?? "", v.name), tag("p", "fp-muted", meta.join(" / ")), sub("目的"), md(v.purpose), sub("アプローチ"), md(v.approach));
  if (str(v.ui_spec) !== null) root.append(sub("UI 仕様"), md(v.ui_spec));
  root.append(sub("対象スコープ"), tag("h5", "fp-doc-sub", "含む"), md(scope.includes), tag("h5", "fp-doc-sub", "含まない"), md(scope.excludes));
  root.append(sub("完了条件"), orderedList(list(v.acceptance)), sub("テスト方針"), plain(v.test_policy));
  const confirmations = list(v.user_confirmations);
  if (confirmations.length > 0) {
    root.append(
      sub("ユーザー確認"),
      table(
        ["画面の状態", "スクリーンショット", "状態の作り方"],
        confirmations.map((c) => [plain(field(c, "screen_state"), "td"), code(str(field(c, "screenshot")) ?? ""), plain(str(field(c, "state_setup")) ?? "開いた時点の状態", "td")]),
      ),
    );
  }
  const checks = list(v.operation_checks);
  if (checks.length > 0) {
    root.append(
      sub("操作の検証"),
      table(
        ["完了条件", "状態の作り方", "手順", "期待する結果"],
        checks.map((c) => {
          const steps = tag("ol", "fp-doc-list");
          for (const step of strs(field(c, "steps"))) steps.append(tag("li", "", step));
          return [md(field(c, "acceptance")), plain(str(field(c, "state_setup")) ?? "開いた時点の状態", "td"), steps, plain(field(c, "expected"), "td")];
        }),
      ),
    );
  }
  const formal = list(v.formal_verification);
  if (formal.length > 0) {
    root.append(
      sub("形式検証"),
      table(
        ["性質", "破れたときの害", "対象コード", "上限"],
        formal.map((f) => ["property", "harm", "target", "bound"].map((k) => plain(field(f, k), "td"))),
      ),
    );
  }
  root.append(sub("主要な設計判断"), md(v.key_decisions), ...list(v.decisions).map(decision), sub("関連設計資料"), materials(v), ...extras(v, "h4"));
  return root;
}

// Any other node, by its shape: an object as its fields, an array as a list, a text as it is.
function generic(v: Json): HTMLElement {
  if (isObject(v)) {
    const dl = tag("dl", "fp-doc-fields");
    for (const [key, value] of Object.entries(v)) {
      const dd = tag("dd");
      dd.append(generic(value));
      dl.append(tag("dt", "", key), dd);
    }
    return dl;
  }
  if (Array.isArray(v)) {
    const ol = tag("ol", "fp-doc-list");
    for (const item of v) {
      const li = tag("li");
      li.append(generic(item));
      ol.append(li);
    }
    return ol;
  }
  if (v === null || v === undefined) {
    const p = tag("p", "fp-doc-text");
    p.append(missing("未設定"));
    return p;
  }
  return tag("p", "fp-doc-text", String(v));
}

// The node `ref` (`{file}#{pointer}`) whose value is the JSON `text`, drawn as the deliverable draws it. A text that is not JSON is shown as it is.
export function drawNode(ref: string, text: string): HTMLElement {
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch {
    return tag("pre", "fp-pre", text);
  }
  const [file = "", pointer = ""] = ref.split("#");
  const segs = pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const [head, , third] = segs;
  const root = tag("div", "fp-doc-root");
  if (isObject(value) && segs.length === 2) {
    const design = file.endsWith("design.json");
    if (design && head === "designs") return root.appendChild(designItem(value));
    if (design && head === "shared") return root.appendChild(designShared(value));
    if (!design && head === "requirements") return root.appendChild(requirementItem(value));
    if (!design && head === "shared") return root.appendChild(requirementShared(value));
    if (head === "appendices") return root.appendChild(appendix(value));
  }
  if (segs.length === 4 && isObject(value)) {
    if (file.endsWith("design.json") && third === "decisions" && (head === "designs" || head === "shared")) return root.appendChild(decision(value));
    if (!file.endsWith("design.json") && third === "user_decisions" && (head === "requirements" || head === "shared")) return root.appendChild(userDecision(value));
  }
  root.append(generic(value));
  return root;
}
