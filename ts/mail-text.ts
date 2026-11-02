import type { MessageDetail } from "./bindings/MessageDetail";
import { queryAll } from "./mail-frame.js";

// A plain-text body as text nodes and links to its http(s) URLs. A click navigates this page, which Rust's on_navigation
// cancels and opens in the default browser. A URL ends at whitespace, a non-ASCII character or " < > (never in a URL as is);
// trailing punctuation is left out, and a trailing ")" only when unpaired, as in "(https://example.com/a)" but not ".../Foo_(bar)".
const URL_IN_TEXT = /https?:\/\/[!#-;=?-~]+/gi;

function trimUrl(url: string) {
  const opens = url.split("(").length - 1;
  let closes = url.split(")").length - 1;
  let end = url.length;
  for (; end; end--) {
    const c = url[end - 1];
    if (c === ")" ? closes-- <= opens : !".,;:!?']".includes(c)) break;
  }
  return url.slice(0, end);
}

// A message as plain text, for the summary. An HTML body is parsed by DOMParser (no script runs and nothing is fetched: the document has no
// browsing context), its style and script are dropped, and a line break is put before and after a block (after a <br>) and a space after a cell,
// so text next to a block or a cell is not joined. The frame the body is shown in is not touched.
const BLOCKS = "p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, table, pre, hr, section, article";

export function mailText(m: MessageDetail) {
  if (!m.html) return m.body;
  const doc = new DOMParser().parseFromString(m.body, "text/html");
  for (const e of queryAll(doc, "script, style")) Element.prototype.remove.call(e);
  for (const e of queryAll(doc, BLOCKS)) {
    Element.prototype.before.call(e, "\n");
    Element.prototype.after.call(e, "\n");
  }
  for (const e of queryAll(doc, "br")) Element.prototype.after.call(e, "\n");
  for (const e of queryAll(doc, "td, th")) Element.prototype.after.call(e, " ");
  return (queryAll<HTMLElement>(doc, "body")[0].textContent ?? "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function linkify(text: string) {
  const nodes: (string | HTMLAnchorElement)[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = trimUrl(match[0]);
    nodes.push(text.slice(last, match.index));
    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    nodes.push(a);
    last = match.index + url.length;
  }
  nodes.push(text.slice(last));
  return nodes;
}
