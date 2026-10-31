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
