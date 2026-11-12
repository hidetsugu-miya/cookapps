// The http(s) URLs in a text, for the places that make them links: a plain-text body (`linkify`) and the text of an HTML body (`linkTextUrls`).
// A URL ends at whitespace, a non-ASCII character or " < > (never in a URL as is);
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

function isAppOrigin(url: string) {
  try {
    return new URL(url).hostname === "tauri.localhost";
  } catch {
    return false;
  }
}

// Where each URL of `text` starts. A link to the app's own origin on Windows would navigate the window itself (Rust's on_navigation lets it through), so it stays text.
export function urlsIn(text: string) {
  const found: { index: number; url: string }[] = [];
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = trimUrl(match[0]);
    if (!isAppOrigin(url)) found.push({ index: match.index, url });
  }
  return found;
}
