//! Slack's mrkdwn (`*bold*`, `_italic_`, `~strike~`, `` `code` ``, code blocks and `&gt;` quotes) as the structure the thread screen draws (S-12).
//!
//! Pure functions from Slack's raw text: nothing here calls Slack. The raw text is read, not `plain_text`'s output, because after that the range of a `<…>` and a `&gt;` are no longer known.
//! Every text in the result is plain text (`token_text`, `unescape`, `emojify`), never markup; the screen decides how to draw it.

use serde::Serialize;
#[cfg(test)]
use ts_rs::TS;

use crate::slack::{emojify, pieces, token_text, unescape, url_len, Piece};

/// Looks a user up by ID, as `plain_text` does for a mention.
type NameOf<'a> = &'a dyn Fn(&str) -> Option<String>;

/// A run of text with one style. `code` is an inline code: its text is drawn as it is, with no link made of an address in it.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub(crate) text: String,
    pub(crate) bold: bool,
    pub(crate) italic: bool,
    pub(crate) strike: bool,
    pub(crate) code: bool,
}

/// A block of a text. A line break inside a `Paragraph` or a `Quote` is a `\n` in the text of a span; the break between two blocks is not in any text.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RichBlock {
    Paragraph {
        spans: Vec<Span>,
    },
    Quote {
        spans: Vec<Span>,
    },
    /// A code block: nothing in it is read as a style or an emoji.
    Code {
        text: String,
    },
}

/// A text as drawn.
pub type Rich = Vec<RichBlock>;

/// `text` as a text with no style (blank is nothing).
pub(crate) fn plain(text: String) -> Rich {
    if text.trim().is_empty() {
        return Vec::new();
    }
    vec![RichBlock::Paragraph {
        spans: vec![Span {
            text,
            ..Span::default()
        }],
    }]
}

#[derive(Clone, Copy, Default, PartialEq)]
struct Style {
    bold: bool,
    italic: bool,
    strike: bool,
}

impl Style {
    fn with(self, mark: char) -> Self {
        match mark {
            '*' => Self { bold: true, ..self },
            '_' => Self {
                italic: true,
                ..self
            },
            _ => Self {
                strike: true,
                ..self
            },
        }
    }
}

/// What a line is made of. A `Code` and a `Lit` are finished text and cannot be cut by a mark.
enum Atom {
    Ch(char),
    Code(String),
    Lit(String),
}

/// A piece of the result before neighbours with the same style are joined; `raw` text still needs its entities undone and its emoji converted.
struct Part {
    text: String,
    raw: bool,
    code: bool,
    style: Style,
}

const MARKS: [char; 3] = ['*', '_', '~'];

/// The text of a code: `&lt; &gt; &amp;` undone, and a `<…>` as `plain_text` reads it. No emoji.
fn code_text(content: &str, name_of: NameOf) -> String {
    pieces(content)
        .into_iter()
        .map(|p| match p {
            Piece::Text(t) => unescape(t),
            Piece::Token(t) => token_text(t, name_of),
        })
        .collect()
}

/// A web address without the end that holds a mark (`https://a.example_.` is `https://a.example`, so that `_https://a.example_.` can be an italic), else all of it.
fn without_mark_tail(url: &str) -> &str {
    let kept = url.trim_end_matches(|c: char| MARKS.contains(&c) || ".,;:!?)".contains(c));
    if url[kept.len()..].contains(MARKS) {
        kept
    } else {
        url
    }
}

/// A line cut into characters, inline codes (closed on the line) and `<…>` tokens and web addresses (copied as they are). A mark at the end of an address is not part of it.
fn atoms(line: &str, name_of: NameOf) -> Vec<Atom> {
    let (mut out, mut rest, mut prev) = (Vec::new(), line, None::<char>);
    while let Some(c) = rest.chars().next() {
        let after = &rest[c.len_utf8()..];
        let (atom, len) = match c {
            '`' => match after.find('`') {
                Some(end) if end > 0 => (Atom::Code(code_text(&after[..end], name_of)), end + 2),
                _ => (Atom::Ch(c), 1),
            },
            '<' => match after.find('>') {
                Some(end) => (Atom::Lit(token_text(&after[..end], name_of)), end + 2),
                None => (Atom::Ch(c), 1),
            },
            _ => match url_len(rest, prev) {
                Some(len) => {
                    let url = without_mark_tail(&rest[..len]);
                    (Atom::Lit(unescape(url)), url.len())
                }
                None => (Atom::Ch(c), c.len_utf8()),
            },
        };
        prev = rest[..len].chars().last();
        rest = &rest[len..];
        out.push(atom);
    }
    out
}

/// Whether a neighbour of a mark lets it work: nothing, white space or anything but an ASCII letter or digit. A Japanese letter does not stop it.
fn open_side(atom: Option<&Atom>) -> bool {
    match atom {
        None => true,
        Some(Atom::Ch(c)) => !c.is_ascii_alphanumeric(),
        Some(_) => true,
    }
}

fn is_space(atom: Option<&Atom>) -> bool {
    matches!(atom, Some(Atom::Ch(c)) if c.is_whitespace())
}

fn can_open(atoms: &[Atom], i: usize) -> bool {
    let prev = i.checked_sub(1).map(|p| &atoms[p]);
    let next = atoms.get(i + 1);
    open_side(prev) && next.is_some() && !is_space(next)
}

fn can_close(atoms: &[Atom], i: usize) -> bool {
    let prev = i.checked_sub(1).map(|p| &atoms[p]);
    let next = atoms.get(i + 1);
    prev.is_some() && !is_space(prev) && open_side(next)
}

/// The atoms `lo..hi` as parts: a mark opens when it is at a word's start and the nearest mark of its kind that ends a word follows it on the line; a mark with no partner is text.
fn styled(atoms: &[Atom], lo: usize, hi: usize, style: Style, out: &mut Vec<Part>) {
    // A kind whose search found no end up to `hi` finds none from a later start either, so it is not searched again (the cost stays linear in the line).
    let mut no_end = [false; MARKS.len()];
    let mut i = lo;
    while i < hi {
        if let Atom::Ch(mark) = atoms[i] {
            let kind = MARKS.iter().position(|&m| m == mark);
            if let Some(kind) = kind.filter(|&k| !no_end[k] && can_open(atoms, i)) {
                let close = (i + 2..hi)
                    .find(|&j| matches!(atoms[j], Atom::Ch(c) if c == mark) && can_close(atoms, j));
                if let Some(j) = close {
                    styled(atoms, i + 1, j, style.with(mark), out);
                    i = j + 1;
                    continue;
                }
                no_end[kind] = true;
            }
        }
        if let (Atom::Ch(c), Some(last)) = (&atoms[i], out.last_mut()) {
            // Raw text next to raw text of the same style grows one string.
            if last.raw && last.style == style {
                last.text.push(*c);
                i += 1;
                continue;
            }
        }
        out.push(match &atoms[i] {
            Atom::Ch(c) => Part {
                text: c.to_string(),
                raw: true,
                code: false,
                style,
            },
            Atom::Code(t) => Part {
                text: t.clone(),
                raw: false,
                code: true,
                style,
            },
            Atom::Lit(t) => Part {
                text: t.clone(),
                raw: false,
                code: false,
                style,
            },
        });
        i += 1;
    }
}

/// The parts as spans: raw text next to raw text of the same style is converted as one (so an emoji code is not cut), and plain neighbours of the same style are joined.
fn spans(parts: Vec<Part>) -> Vec<Span> {
    let mut joined: Vec<Part> = Vec::new();
    for p in parts {
        match joined.last_mut() {
            Some(last) if last.raw && p.raw && last.style == p.style => last.text.push_str(&p.text),
            _ => joined.push(p),
        }
    }
    let mut out: Vec<Span> = Vec::new();
    for p in joined {
        let text = if p.raw {
            emojify(&unescape(&p.text))
        } else {
            p.text
        };
        let span = Span {
            text,
            bold: p.style.bold,
            italic: p.style.italic,
            strike: p.style.strike,
            code: p.code,
        };
        match out.last_mut() {
            Some(last)
                if !last.code
                    && !span.code
                    && (last.bold, last.italic, last.strike)
                        == (span.bold, span.italic, span.strike) =>
            {
                last.text.push_str(&span.text);
            }
            _ => out.push(span),
        }
    }
    out.retain(|s| !s.text.is_empty());
    out
}

/// Lines (their `&gt;` already taken off, for a quote) as spans, one `\n` between two.
fn lines_spans(lines: &[&str], name_of: NameOf) -> Vec<Span> {
    let mut parts = Vec::new();
    for (n, line) in lines.iter().enumerate() {
        if n > 0 {
            parts.push(Part {
                text: "\n".to_owned(),
                raw: true,
                code: false,
                style: Style::default(),
            });
        }
        let atoms = atoms(line, name_of);
        styled(&atoms, 0, atoms.len(), Style::default(), &mut parts);
    }
    spans(parts)
}

/// The text of a line that starts with a quote mark (`&gt;`, and one space after it), else `None`. `&gt;&gt;&gt;` (Slack's quote to the end of the message) is not read: it stays text.
fn quoted(line: &str) -> Option<&str> {
    if line.starts_with("&gt;&gt;&gt;") {
        return None;
    }
    let rest = line.strip_prefix("&gt;")?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

/// Text with no code block: runs of quoted lines are quotes, the other lines paragraphs.
fn text_blocks(text: &str, name_of: NameOf, out: &mut Rich) {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut at = 0;
    while at < lines.len() {
        let quote = quoted(lines[at]).is_some();
        let len = lines[at..]
            .iter()
            .take_while(|l| quoted(l).is_some() == quote)
            .count();
        let run = &lines[at..at + len];
        at += len;
        if quote {
            let inner: Vec<&str> = run.iter().filter_map(|l| quoted(l)).collect();
            out.push(RichBlock::Quote {
                spans: lines_spans(&inner, name_of),
            });
        } else {
            // A paragraph with nothing to see (blank lines, or a token that is no text) is not drawn.
            let spans = lines_spans(run, name_of);
            if spans.iter().any(|s| !s.text.trim().is_empty()) {
                out.push(RichBlock::Paragraph { spans });
            }
        }
    }
}

/// Slack's mrkdwn `raw` as the blocks to draw. The code blocks (```` ```…``` ````) are cut out first; the rest goes by lines.
pub(crate) fn parse(raw: &str, name_of: NameOf) -> Rich {
    // Text and code alternate, and a mark with no partner is text.
    let (mut segments, mut rest) = (Vec::new(), raw);
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let Some(end) = after.find("```") else { break };
        segments.push((&rest[..start], Some(&after[..end])));
        rest = &after[end + 3..];
    }
    segments.push((rest, None));

    let mut out = Rich::new();
    let mut skip_newline = false;
    for (text, code) in segments {
        // The line break that sets a code block off from the text beside it belongs to neither.
        let text = if skip_newline {
            text.strip_prefix('\n').unwrap_or(text)
        } else {
            text
        };
        let text = if code.is_some() {
            text.strip_suffix('\n').unwrap_or(text)
        } else {
            text
        };
        text_blocks(text, name_of, &mut out);
        skip_newline = code.is_some();
        if let Some(code) = code {
            let code = code.strip_prefix('\n').unwrap_or(code);
            let code = code.strip_suffix('\n').unwrap_or(code);
            if !code.trim().is_empty() {
                out.push(RichBlock::Code {
                    text: code_text(code, name_of),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(raw: &str) -> Rich {
        parse(raw, &|id| (id == "U1").then(|| "Alice".to_owned()))
    }

    /// A span; `style` holds `b`, `i`, `s` and `c` for bold, italic, strike and code.
    fn sp(text: &str, style: &str) -> Span {
        Span {
            text: text.to_owned(),
            bold: style.contains('b'),
            italic: style.contains('i'),
            strike: style.contains('s'),
            code: style.contains('c'),
        }
    }

    fn para(spans: Vec<Span>) -> RichBlock {
        RichBlock::Paragraph { spans }
    }

    fn quote(spans: Vec<Span>) -> RichBlock {
        RichBlock::Quote { spans }
    }

    fn code(text: &str) -> RichBlock {
        RichBlock::Code {
            text: text.to_owned(),
        }
    }

    #[test]
    fn text_without_a_mark_is_one_plain_span_and_keeps_its_white_space() {
        assert_eq!(read("hello"), vec![para(vec![sp("hello", "")])]);
        assert_eq!(read("a  b\n\n  c"), vec![para(vec![sp("a  b\n\n  c", "")])]);
        assert_eq!(read(""), vec![]);
        assert_eq!(read(" \n "), vec![]);
        assert_eq!(plain("x".into()), vec![para(vec![sp("x", "")])]);
        assert_eq!(plain(" ".into()), vec![]);
    }

    #[test]
    fn each_mark_makes_its_style() {
        assert_eq!(
            read("a *b* _c_ ~d~ `e` f"),
            vec![para(vec![
                sp("a ", ""),
                sp("b", "b"),
                sp(" ", ""),
                sp("c", "i"),
                sp(" ", ""),
                sp("d", "s"),
                sp(" ", ""),
                sp("e", "c"),
                sp(" f", ""),
            ])]
        );
    }

    #[test]
    fn a_mark_works_at_the_edge_of_a_word_only() {
        for text in [
            "snake_case_name",
            "2*3*4",
            "a*b*c",
            "a_b_",
            "_a_b",
            "*a*b",
            "a*b*",
        ] {
            assert_eq!(read(text), vec![para(vec![sp(text, "")])], "{text}");
        }
        // Beside white space or a punctuation mark it works.
        assert_eq!(
            read("(*a*), _b_."),
            vec![para(vec![
                sp("(", ""),
                sp("a", "b"),
                sp("), ", ""),
                sp("b", "i"),
                sp(".", ""),
            ])]
        );
    }

    #[test]
    fn a_mark_works_beside_japanese_text() {
        assert_eq!(
            read("これは*太字*です"),
            vec![para(vec![
                sp("これは", ""),
                sp("太字", "b"),
                sp("です", "")
            ])]
        );
    }

    #[test]
    fn a_mark_with_white_space_inside_its_edge_or_no_partner_is_text() {
        for text in ["*abc", "abc*", "a * b * c", "* a*", "*a *", "**", "~", "__"] {
            assert_eq!(read(text), vec![para(vec![sp(text, "")])], "{text}");
        }
    }

    #[test]
    fn a_style_stays_on_its_line() {
        assert_eq!(read("*a\nb*"), vec![para(vec![sp("*a\nb*", "")])]);
        assert_eq!(
            read("*a*\n*b*"),
            vec![para(vec![sp("a", "b"), sp("\n", ""), sp("b", "b")])]
        );
    }

    #[test]
    fn styles_nest() {
        assert_eq!(read("*_x_*"), vec![para(vec![sp("x", "bi")])]);
        assert_eq!(
            read("*bold _both_ bold* ~gone~"),
            vec![para(vec![
                sp("bold ", "b"),
                sp("both", "bi"),
                sp(" bold", "b"),
                sp(" ", ""),
                sp("gone", "s"),
            ])]
        );
        assert_eq!(read("~*_x_*~"), vec![para(vec![sp("x", "bis")])]);
    }

    #[test]
    fn an_inline_code_is_not_read() {
        assert_eq!(
            read("`*a* _b_ :fire:` *c*"),
            vec![para(vec![
                sp("*a* _b_ :fire:", "c"),
                sp(" ", ""),
                sp("c", "b")
            ])]
        );
        // A style around a code goes on to it, and a mark inside a code does not pair with one outside.
        assert_eq!(
            read("*a `b` c*"),
            vec![para(vec![sp("a ", "b"), sp("b", "bc"), sp(" c", "b")])]
        );
        assert_eq!(
            read("*a `b*` c"),
            vec![para(vec![sp("*a ", ""), sp("b*", "c"), sp(" c", "")])]
        );
        // An empty pair, or one that is not closed, is text.
        for text in ["``", "`a"] {
            assert_eq!(read(text), vec![para(vec![sp(text, "")])], "{text}");
        }
        // The line is the limit of a code.
        assert_eq!(read("`a\nb`"), vec![para(vec![sp("`a\nb`", "")])]);
    }

    #[test]
    fn a_code_gets_its_escapes_and_links_as_plain_text_does_and_no_emoji() {
        assert_eq!(
            read("`a &lt;b&gt; &amp;lt; :fire: <@U1> <https://a.example|x>`"),
            vec![para(vec![sp(
                "a <b> &lt; :fire: @Alice x (https://a.example)",
                "c"
            )])]
        );
    }

    #[test]
    fn html_in_a_text_stays_text() {
        assert_eq!(
            read("&lt;b&gt;x&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt; *&lt;i&gt;*"),
            vec![para(vec![
                sp("<b>x</b> <img src=x onerror=alert(1)> ", ""),
                sp("<i>", "b"),
            ])]
        );
    }

    #[test]
    fn a_token_is_not_cut_by_a_mark() {
        assert_eq!(
            read("*<@U1>* <https://a.example/x_y_z|l_a_b> _<#C1|dev>_"),
            vec![para(vec![
                sp("@Alice", "b"),
                sp(" l_a_b (https://a.example/x_y_z) ", ""),
                sp("#dev", "i"),
            ])]
        );
        // A `<` with no `>` is text.
        assert_eq!(read("*a <b*"), vec![para(vec![sp("a <b", "b")])]);
    }

    #[test]
    fn a_web_address_is_not_cut_by_a_mark() {
        assert_eq!(
            read("see https://a.example/_x_/*y*"),
            vec![para(vec![sp("see https://a.example/_x_/*y*", "")])]
        );
        assert_eq!(
            read("*https://a.example/p?a=1&amp;b=2* and _https://b.example_."),
            vec![para(vec![
                sp("https://a.example/p?a=1&b=2", "b"),
                sp(" and ", ""),
                sp("https://b.example", "i"),
                sp(".", ""),
            ])]
        );
    }

    #[test]
    fn emoji_are_converted_outside_a_code_and_not_across_a_style() {
        assert_eq!(
            read(":tada: *:fire:* `:tada:` 10:30:45"),
            vec![para(vec![
                sp("🎉 ", ""),
                sp("🔥", "b"),
                sp(" ", ""),
                sp(":tada:", "c"),
                sp(" 10:30:45", ""),
            ])]
        );
        // A custom emoji stays as it is.
        assert_eq!(read(":my_custom:"), vec![para(vec![sp(":my_custom:", "")])]);
    }

    #[test]
    fn lines_that_start_with_a_quote_mark_are_a_quote() {
        assert_eq!(
            read("a\n&gt; q1\n&gt;q2 *b*\nb"),
            vec![
                para(vec![sp("a", "")]),
                quote(vec![sp("q1\nq2 ", ""), sp("b", "b")]),
                para(vec![sp("b", "")]),
            ]
        );
        assert_eq!(read("&gt; only"), vec![quote(vec![sp("only", "")])]);
        // The mark must be at the start of the line.
        assert_eq!(read("a &gt; b"), vec![para(vec![sp("a > b", "")])]);
        // A blank line ends a quote.
        assert_eq!(
            read("&gt; a\n\n&gt; b"),
            vec![quote(vec![sp("a", "")]), quote(vec![sp("b", "")])]
        );
    }

    #[test]
    fn a_code_block_is_not_read() {
        assert_eq!(
            read("before\n```\nlet a = *1*; // &lt;x&gt; :fire:\n  b\n```\nafter"),
            vec![
                para(vec![sp("before", "")]),
                code("let a = *1*; // <x> :fire:\n  b"),
                para(vec![sp("after", "")]),
            ]
        );
        assert_eq!(read("```a```"), vec![code("a")]);
        assert_eq!(
            read("x ```a``` *y*"),
            vec![
                para(vec![sp("x ", "")]),
                code("a"),
                para(vec![sp(" ", ""), sp("y", "b")]),
            ]
        );
        assert_eq!(
            read("```a<https://a.example|l>```"),
            vec![code("al (https://a.example)")]
        );
    }

    #[test]
    fn a_code_block_that_is_not_closed_is_text() {
        assert_eq!(
            read("```\n*a*"),
            vec![para(vec![sp("```\n", ""), sp("a", "b")])]
        );
        assert_eq!(read("``````"), vec![]);
    }

    #[test]
    fn three_quote_marks_at_the_start_of_a_line_stay_text() {
        assert_eq!(
            read("&gt;&gt;&gt; a\nb"),
            vec![para(vec![sp(">>> a\nb", "")])]
        );
        assert_eq!(
            read("x\n&gt;&gt;&gt;\n&gt; q"),
            vec![para(vec![sp("x\n>>>", "")]), quote(vec![sp("q", "")])]
        );
        // Two marks are a quote of a quote mark.
        assert_eq!(read("&gt;&gt; a"), vec![quote(vec![sp("> a", "")])]);
    }

    #[test]
    fn a_long_line_of_marks_with_no_partner_is_read_at_once() {
        // Each kind of mark searches for an end once, not once per mark (a line of this size took seconds when it was quadratic).
        let line = "*a ".repeat(20_000) + &"_b ".repeat(20_000) + &"~c ".repeat(20_000);
        let started = std::time::Instant::now();
        let got = read(&line);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(got, vec![para(vec![sp(&line, "")])]);
    }

    #[test]
    fn a_token_that_is_no_text_leaves_no_paragraph() {
        assert_eq!(read("<!date^1^{date}>"), vec![]);
    }

    #[test]
    fn a_quote_mark_inside_a_code_block_is_not_a_quote() {
        assert_eq!(
            read("```\n&gt; a\n```\n&gt; b"),
            vec![code("> a"), quote(vec![sp("b", "")])]
        );
    }
}
