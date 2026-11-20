// The blocks and the evidence of a decision page (A-41, formation-page.ts): what a child wrote in its page and what Rust read for it. The text is the child's, so every text goes in as `textContent`; nothing is read as HTML. The one exception is the SVG that Mermaid draws (`securityLevel: "strict"`), which goes through DOMPurify's SVG profile.
import type { Block } from "./bindings/Block";
import type { DiffRow } from "./bindings/DiffRow";
import type { Evidence } from "./bindings/Evidence";
import type { FactContent } from "./bindings/FactContent";
import type { ImageRef } from "./bindings/ImageRef";
import type { Term } from "./bindings/Term";
import { tag } from "./dom.js";
import { drawNode, markdownBlock } from "./formation-page-node.js";
import { loadMermaid } from "./vendor-load.js";

// The fold of the page: `summary` is its label.
export function fold(summary: string, className: string, open = false): HTMLDetailsElement {
  const node = tag("details", className);
  node.open = open;
  node.append(tag("summary", "", summary));
  node.addEventListener("toggle", () => {
    if (node.open) paintPending(node);
  });
  return node;
}

// The words of the page being drawn, longest first: `drawPage` sets them before it draws, and the body texts take them when they are drawn.
let termList: Term[] = [];

export function useTerms(terms: Term[]) {
  termList = [...terms].sort((a, b) => b.word.length - a.word.length);
}

// A body text of the page as an element: each listed word in it is an `abbr` that carries what the word means as its tooltip. The text goes in as `textContent` like every text of the page.
export function termed<K extends "p" | "li" | "div" | "dd">(name: K, className: string, text: string): HTMLElementTagNameMap[K] {
  const node = tag(name, className);
  let plain = 0;
  let at = 0;
  while (at < text.length) {
    const term = termList.find((t) => text.startsWith(t.word, at));
    if (term === undefined) {
      at += 1;
      continue;
    }
    if (at > plain) node.append(text.slice(plain, at));
    const word = tag("abbr", "fp-term", term.word);
    word.title = term.description;
    node.append(word);
    at += term.word.length;
    plain = at;
  }
  if (plain < text.length) node.append(text.slice(plain));
  return node;
}

// `lazy` is for blocks inside a fold that is closed: a diagram there is drawn when the fold is first opened, not when the page is drawn.
export function drawBlocks(blocks: Block[], lazy = false): HTMLElement[] {
  return blocks.map((block) => drawBlock(block, lazy));
}

function drawBlock(block: Block, lazy: boolean): HTMLElement {
  switch (block.type) {
    case "paragraph":
      return termed("p", "fp-p", block.text);
    case "heading":
      return tag("h4", "fp-h", block.text);
    case "list": {
      const list = tag("ul", "fp-list");
      for (const item of block.items) list.append(termed("li", "", item));
      return list;
    }
    case "callout":
      return termed("div", "fp-callout", block.text);
    case "table":
      return drawTable(block.header, block.rows);
    case "before-after": {
      const wrap = tag("div", "fp-before-after");
      for (const [blocks, caption, fallback, side] of [
        [block.before, block.beforeCaption, "今", "before"],
        [block.after, block.afterCaption, "変更後", "after"],
      ] as const) {
        const half = tag("div", "fp-side");
        half.dataset.side = side;
        half.append(tag("div", "fp-side-caption", caption ?? fallback), ...drawBlocks(blocks, lazy));
        wrap.append(half);
      }
      return wrap;
    }
    case "folded": {
      const node = fold(block.summary, "fp-folded");
      node.append(...drawBlocks(block.blocks, true));
      return node;
    }
    case "diagram":
      return drawDiagram(block.mermaid, block.caption, lazy);
    case "image":
      return drawImage(block, lazy);
    case "evidence":
      return drawEvidence(block.items);
  }
}

export function drawTable(header: string[], rows: { text: string; changed: boolean }[][]): HTMLElement {
  const wrap = tag("div", "fp-table-wrap");
  const table = tag("table", "fp-table");
  const head = tag("tr");
  for (const cell of header) head.append(tag("th", "", cell));
  const thead = tag("thead");
  thead.append(head);
  table.append(thead);
  const body = tag("tbody");
  for (const row of rows) {
    const line = tag("tr");
    for (const cell of row) {
      const td = tag("td", "", cell.text);
      if (cell.changed) td.dataset.changed = "true";
      line.append(td);
    }
    body.append(line);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

// How the images of the page being drawn are read: `drawPage` sets it before it draws, and every image takes it when it is drawn.
type ImageLoader = (root: string, path: string) => Promise<string>;
let imageLoader: ImageLoader | null = null;

export function useImages(load: ImageLoader) {
  imageLoader = load;
}

// An image of the page (an `image` block, and later the images of the cards and their options): the file is read when the image is drawn, or, inside a fold that is closed, when the fold is first opened. It is shown 400px wide at most, with its caption and a button that widens it to the width of the body and back. A file that cannot be read or shown leaves the reason in its place.
export function drawImage(image: ImageRef, lazy: boolean): HTMLElement {
  const load = imageLoader;
  const figure = tag("figure", "fp-image");
  const box = tag("div", "fp-image-box");
  const zoom = tag("button", "fp-image-zoom", "拡大する");
  zoom.type = "button";
  zoom.hidden = true;
  zoom.onclick = () => {
    const wide = figure.dataset.wide !== "true";
    figure.dataset.wide = String(wide);
    zoom.textContent = wide ? "縮小する" : "拡大する";
  };
  figure.append(box, tag("figcaption", "", image.caption), zoom);
  const fail = (reason: string) => {
    zoom.hidden = true;
    box.replaceChildren(tag("p", "fp-image-error", `画像を読めません（${image.root}/${image.path}）: ${reason}`));
  };
  const paint = async () => {
    try {
      if (load === null) throw new Error("画像の読み込み元が決まっていません");
      const picture = tag("img");
      picture.alt = image.caption;
      picture.onerror = () => fail("画像として表示できません");
      picture.onload = () => {
        zoom.hidden = false;
      };
      picture.src = await load(image.root, image.path);
      box.replaceChildren(picture);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };
  if (lazy) {
    box.dataset.pending = "true";
    pending.set(box, () => void paint());
  } else void paint();
  return figure;
}

// The number of the diagrams drawn, so that each SVG has an id of its own.
let diagrams = 0;
const darkScheme = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

// A diagram: the SVG once Mermaid has drawn it; the Mermaid source as text while it has not, and for good when it cannot draw it.
function drawDiagram(source: string, caption: string | null, lazy: boolean): HTMLElement {
  const figure = tag("figure", "fp-diagram");
  const box = tag("div", "fp-diagram-box");
  figure.append(box);
  if (caption !== null) figure.append(tag("figcaption", "", caption));
  box.append(tag("pre", "fp-diagram-source", source));
  const paint = () => void paintDiagram(source, box, caption ?? "図");
  if (lazy) {
    box.dataset.pending = "true";
    pending.set(box, paint);
  } else paint();
  return figure;
}

// The diagrams that wait for their fold to be opened.
const pending = new WeakMap<HTMLElement, () => void>();

// Draws the waiting diagrams of `root` that no closed fold hides.
function paintPending(root: HTMLElement) {
  for (const box of root.querySelectorAll<HTMLElement>(".fp-diagram-box[data-pending], .fp-image-box[data-pending]")) {
    if (box.closest("details:not([open])") !== null) continue;
    delete box.dataset.pending;
    pending.get(box)?.();
    pending.delete(box);
  }
}

async function paintDiagram(source: string, box: HTMLElement, label: string) {
  const id = `fp-mermaid-${++diagrams}`;
  try {
    await loadMermaid();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: darkScheme() ? "dark" : "default", htmlLabels: false, flowchart: { htmlLabels: false } });
    const { svg } = await mermaid.render(id, source);
    const holder = tag("div");
    holder.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    const drawn = holder.querySelector("svg");
    if (!drawn) throw new Error("no svg");
    drawn.setAttribute("role", "img");
    drawn.setAttribute("aria-label", label);
    box.replaceChildren(drawn);
    box.dataset.drawn = "true";
  } catch {
    // Mermaid leaves its measuring elements in the body when it fails.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    box.dataset.failed = "true";
  }
}

export function drawEvidence(items: Evidence[]): HTMLElement {
  const wrap = tag("div", "fp-evidence");
  for (const item of items) wrap.append(drawEvidenceItem(item));
  return wrap;
}

function head(path: string, range: string, note: string | null): HTMLElement {
  const node = tag("div", "fp-ev-head");
  node.append(tag("code", "fp-ev-path", path));
  if (range !== "") node.append(tag("span", "fp-ev-range", range));
  if (note !== null) node.append(tag("p", "fp-ev-note", note));
  return node;
}

function drawEvidenceItem(item: Evidence): HTMLElement {
  const node = tag("div", "fp-ev");
  node.dataset.evidence = item.type;
  switch (item.type) {
    case "excerpt": {
      node.append(head(`${item.root}/${item.path}`, `${item.start}-${item.end} 行`, item.note));
      const code = tag("div", "fp-code");
      const marked = new Set(item.highlight);
      item.lines.forEach((text, i) => {
        const no = item.start + i;
        const row = tag("div", "fp-line");
        if (marked.has(no)) row.dataset.highlight = "true";
        row.append(tag("span", "fp-ln", String(no)), tag("span", "fp-lc", text));
        code.append(row);
      });
      node.append(code);
      break;
    }
    case "diff": {
      node.append(tag("p", "fp-ev-summary", item.summary), head(item.name, "", item.note), drawDiffRows(item.rows));
      node.append(source("変更前の出典", item.before_source), source("変更後の出典", item.after_source));
      break;
    }
    case "current": {
      const note = tag("p", "fp-ev-summary");
      note.append(tag("span", "fp-badge", "今のコード"), item.note);
      node.append(note);
      for (const excerpt of item.excerpts) node.append(drawEvidenceItem(excerpt));
      break;
    }
    case "git-diff": {
      node.append(tag("p", "fp-ev-summary", item.summary), head(`${item.root}/${item.path}`, `${item.base} → ${item.head ?? "作業ツリー"}`, item.note), drawDiffRows(item.rows));
      const shown = item.root === "deliverables" ? item.path : `${item.root}/${item.path}`;
      node.append(source("変更前の出典", `${shown}（${item.base}）`), source("変更後の出典", `${shown}（${item.head ?? "作業ツリー"}）`));
      if (item.truncated) node.append(tag("p", "fp-ev-note", "途中で切れています"));
      break;
    }
    case "node": {
      node.append(head(`${item.root}/${item.ref}`, "", item.note));
      node.append(drawNode(item.ref, item.text));
      break;
    }
  }
  return node;
}

function source(label: string, text: string): HTMLElement {
  const node = tag("p", "fp-ev-note");
  node.append(tag("strong", "", `${label}: `), text);
  return node;
}

// One line of a diff: its number and its text, with the characters between `mark` marked. A side that has no line there is an empty cell.
function diffCell(no: number | null, text: string | null, mark: [number, number] | null, kind: "ins" | "del" | "ctx"): HTMLElement {
  const cell = tag("div", "fp-line");
  cell.dataset.kind = text === null ? "empty" : kind;
  const body = tag("span", "fp-lc");
  if (text !== null) {
    if (mark === null) {
      body.textContent = text;
    } else {
      const chars = Array.from(text);
      body.append(chars.slice(0, mark[0]).join(""), tag("mark", "fp-diff-mark", chars.slice(mark[0], mark[1]).join("")), chars.slice(mark[1]).join(""));
    }
  }
  cell.append(tag("span", "fp-ln", no === null ? "" : String(no)), body);
  return cell;
}

function diffHunk(text: string): HTMLElement {
  const cell = tag("div", "fp-line");
  cell.dataset.kind = "hunk";
  cell.append(tag("span", "fp-lc", text));
  return cell;
}

// A diff as the two sides of the change, side by side, and as one column when the page is narrow (the deletions of a run of changes, then its insertions).
function drawDiffRows(rows: DiffRow[]): HTMLElement {
  const wrap = tag("div", "fp-diff");
  const sides = tag("div", "fp-code fp-diff-sides");
  const column = tag("div", "fp-code fp-diff-column");
  let run: DiffRow[] = [];
  const flush = () => {
    for (const row of run) if (row.left !== null) column.append(diffCell(row.left_no, row.left, row.left_mark, "del"));
    for (const row of run) if (row.right !== null) column.append(diffCell(row.right_no, row.right, row.right_mark, "ins"));
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "hunk") {
      flush();
      sides.append(diffHunk(row.left ?? ""));
      column.append(diffHunk(row.left ?? ""));
      continue;
    }
    const pair = tag("div", "fp-diff-row");
    if (row.kind === "context") {
      flush();
      pair.append(diffCell(row.left_no, row.left, null, "ctx"), diffCell(row.right_no, row.right, null, "ctx"));
      column.append(diffCell(row.right_no, row.right, null, "ctx"));
    } else {
      run.push(row);
      pair.append(diffCell(row.left_no, row.left, row.left_mark, "del"), diffCell(row.right_no, row.right, row.right_mark, "ins"));
    }
    sides.append(pair);
  }
  flush();
  wrap.append(sides, column);
  return wrap;
}

// What a fact cites, as 「中身を見る」 shows it: a node of a deliverable as the deliverable draws it, a Markdown file formatted, any other file as text, an image as an image. `lazy` is for a fold that is closed.
export function drawFactContent(content: FactContent, lazy: boolean): HTMLElement {
  switch (content.type) {
    case "node":
      return drawNode(content.ref, content.text);
    case "markdown":
      return markdownBlock(content.text);
    case "text":
      return tag("pre", "fp-pre", content.text);
    case "image":
      return drawImage(content, lazy);
  }
}
