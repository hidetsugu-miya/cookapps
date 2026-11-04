// A Slack text read for its styles (S-12), drawn from what Rust made of it (src-tauri/src/slack_mrkdwn.rs).
// Every text is put in as text and the elements are built here, never from markup; a URL in it becomes a link (`linkify`), except inside a code.
import type { RichBlock } from "./bindings/RichBlock";
import type { Span } from "./bindings/Span";
import { tag } from "./dom.js";
import { linkify } from "./mail-text.js";

// Wraps `nodes` in a new element.
function wrap(name: "strong" | "em" | "s" | "code", nodes: (Node | string)[]) {
  const el = tag(name);
  el.append(...nodes);
  return [el];
}

// A span with no style is its text (and links) alone.
function spanNodes(s: Span) {
  let nodes: (Node | string)[] = s.code ? [s.text] : linkify(s.text);
  if (s.code) nodes = wrap("code", nodes);
  if (s.strike) nodes = wrap("s", nodes);
  if (s.italic) nodes = wrap("em", nodes);
  if (s.bold) nodes = wrap("strong", nodes);
  return nodes;
}

function withSpans(el: HTMLElement, spans: Span[]) {
  for (const s of spans) el.append(...spanNodes(s));
  return el;
}

function blockNode(b: RichBlock, className: string) {
  switch (b.type) {
    case "paragraph":
      return withSpans(tag("p", className), b.spans);
    case "quote":
      return withSpans(tag("blockquote", "st-quote"), b.spans);
    case "code": {
      const pre = tag("pre", "st-pre");
      pre.append(tag("code", "", b.text));
      return pre;
    }
  }
}

// The blocks of a text: a paragraph is `<p class=className>`, a quote a `<blockquote>`, a code block a `<pre><code>`.
export const richNodes = (blocks: RichBlock[], className = "st-text") => blocks.map((b) => blockNode(b, className));
