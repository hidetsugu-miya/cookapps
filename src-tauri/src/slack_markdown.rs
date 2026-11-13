//! The Markdown of the rich post field (S-6, S-21) as the mrkdwn Slack takes in `chat.postMessage`'s `text`.
//!
//! The reverse of `slack_mrkdwn`, which reads Slack's mrkdwn. A pure function: nothing here calls Slack.
//! Slack's rules (https://docs.slack.dev/messaging/formatting-message-text): `*bold*`, `_italic_`, `~strike~`, `` `code` ``, three backticks for a block,
//! `> ` for a quote, `<url|text>` for a link, `- ` and `1. ` typed as they are for a list, and `&`, `<`, `>` as `&amp;`, `&lt;`, `&gt;` (nothing else is escaped).

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};

use crate::slack::escape_mrkdwn;

/// A block level that collects its blocks: the text itself, a quote, a list or one item of it.
#[derive(Default)]
struct Frame {
    /// Finished blocks, joined by the caller (a blank line between two blocks, a line break between two items).
    blocks: Vec<String>,
    /// The inline text of the block being read.
    inline: String,
    /// A list: the number the next item gets, `None` for a bulleted one.
    next: Option<u64>,
    /// An item: its `- ` or `1. `.
    marker: String,
}

impl Frame {
    /// Moves the inline text read so far to the finished blocks.
    fn flush(&mut self) {
        let text = std::mem::take(&mut self.inline);
        if !text.trim().is_empty() {
            self.blocks.push(text);
        }
    }
}

/// `url` as it goes between `<` and `|`: the characters that end it are percent-encoded, `&` is escaped.
fn link_target(url: &str) -> String {
    let encoded = url
        .replace(' ', "%20")
        .replace('<', "%3C")
        .replace('>', "%3E")
        .replace('|', "%7C");
    escape_mrkdwn(&encoded)
}

/// `markdown` as mrkdwn, without the blank lines at its ends.
/// Bold, italic, strike, code, a code block, a link, a list (bulleted or numbered, nested) and a quote become Slack's. A heading becomes a bold line.
/// Inside a link's text no style is kept, and the language of a code block is dropped. Anything else (a table, a task mark, HTML) stays as the text it is, escaped.
pub(crate) fn to_mrkdwn(markdown: &str) -> String {
    let mut stack = vec![Frame::default()];
    // The link being read: where its text starts in the inline text, and its address.
    let mut link: Option<(usize, String)> = None;
    let mut in_code_block = false;
    let mut in_heading = false;
    for event in Parser::new_ext(markdown, Options::ENABLE_STRIKETHROUGH) {
        // Bold, italic, strike and code marks are dropped inside a link's text, and a bold one inside a heading, which is bold already.
        let styled = link.is_none();
        let top = stack.last_mut().expect("the root frame stays");
        match event {
            Event::Text(text) if in_code_block => top.inline.push_str(&text),
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => {
                top.inline.push_str(&escape_mrkdwn(&text));
            }
            Event::Code(text) if styled => {
                top.inline.push_str(&format!("`{}`", escape_mrkdwn(&text)));
            }
            Event::Code(text) => top.inline.push_str(&escape_mrkdwn(&text)),
            Event::SoftBreak | Event::HardBreak => top.inline.push('\n'),
            Event::Rule => {
                top.flush();
                top.blocks.push("---".into());
            }
            Event::Start(Tag::Paragraph) => top.flush(),
            Event::End(TagEnd::Paragraph) => top.flush(),
            Event::Start(Tag::Heading { .. }) => {
                top.flush();
                in_heading = true;
            }
            Event::End(TagEnd::Heading(_)) => {
                in_heading = false;
                let text = std::mem::take(&mut top.inline);
                if !text.trim().is_empty() {
                    top.blocks.push(format!("*{}*", text.trim()));
                }
            }
            Event::Start(Tag::Strong) if styled && !in_heading => top.inline.push('*'),
            Event::End(TagEnd::Strong) if styled && !in_heading => top.inline.push('*'),
            Event::Start(Tag::Emphasis) if styled => top.inline.push('_'),
            Event::End(TagEnd::Emphasis) if styled => top.inline.push('_'),
            Event::Start(Tag::Strikethrough) if styled => top.inline.push('~'),
            Event::End(TagEnd::Strikethrough) if styled => top.inline.push('~'),
            // An address in angle brackets (`<a@x.jp>`) stays its text: Slack links an address by itself, and `<a@x.jp>` would not be one of its links.
            Event::Start(Tag::Link {
                link_type: LinkType::Email,
                ..
            }) => link = Some((top.inline.len(), String::new())),
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => {
                link = Some((top.inline.len(), link_target(&dest_url)));
            }
            Event::End(TagEnd::Link | TagEnd::Image) => {
                if let Some((start, url)) = link.take() {
                    let label = top.inline.split_off(start);
                    let label = label.trim();
                    if url.is_empty() {
                        top.inline.push_str(label);
                    } else if label.is_empty() || label == url {
                        top.inline.push_str(&format!("<{url}>"));
                    } else {
                        top.inline.push_str(&format!("<{url}|{label}>"));
                    }
                }
            }
            Event::Start(Tag::CodeBlock(_)) => {
                top.flush();
                in_code_block = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                let code = std::mem::take(&mut top.inline);
                top.blocks.push(format!(
                    "```\n{}\n```",
                    escape_mrkdwn(code.trim_end_matches('\n'))
                ));
            }
            Event::Start(Tag::BlockQuote(_)) => {
                top.flush();
                stack.push(Frame::default());
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                top.flush();
                let frame = stack.pop().expect("a quote frame");
                let quoted = frame
                    .blocks
                    .join("\n\n")
                    .lines()
                    .map(|line| {
                        if line.is_empty() {
                            ">".to_owned()
                        } else {
                            format!("> {line}")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !quoted.is_empty() {
                    stack
                        .last_mut()
                        .expect("the root frame stays")
                        .blocks
                        .push(quoted);
                }
            }
            Event::Start(Tag::List(first)) => {
                top.flush();
                stack.push(Frame {
                    next: first,
                    ..Frame::default()
                });
            }
            Event::End(TagEnd::List(_)) => {
                let frame = stack.pop().expect("a list frame");
                let parent = stack.last_mut().expect("the root frame stays");
                parent.flush();
                parent.blocks.push(frame.blocks.join("\n"));
            }
            Event::Start(Tag::Item) => {
                let marker = match top.next {
                    Some(n) => {
                        top.next = Some(n + 1);
                        format!("{n}. ")
                    }
                    None => "- ".to_owned(),
                };
                stack.push(Frame {
                    marker,
                    ..Frame::default()
                });
            }
            Event::End(TagEnd::Item) => {
                top.flush();
                let frame = stack.pop().expect("an item frame");
                let indent = " ".repeat(frame.marker.chars().count());
                let body = frame
                    .blocks
                    .join("\n")
                    .lines()
                    .enumerate()
                    .map(|(i, line)| match (i, line.is_empty()) {
                        (0, _) => format!("{}{line}", frame.marker),
                        (_, true) => String::new(),
                        _ => format!("{indent}{line}"),
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let body = if body.is_empty() {
                    frame.marker.trim_end().to_owned()
                } else {
                    body
                };
                stack.last_mut().expect("a list frame").blocks.push(body);
            }
            _ => {}
        }
    }
    let mut root = stack.pop().expect("the root frame stays");
    root.flush();
    root.blocks.join("\n\n").trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::to_mrkdwn;

    #[test]
    fn the_inline_styles_become_slacks() {
        assert_eq!(
            to_mrkdwn("**太字** と *斜体* と ~~取り消し~~ と `code`"),
            "*太字* と _斜体_ と ~取り消し~ と `code`"
        );
        assert_eq!(to_mrkdwn("***both***"), "_*both*_");
        assert_eq!(to_mrkdwn("__a__ _b_"), "*a* _b_");
    }

    #[test]
    fn a_link_becomes_an_angle_link() {
        assert_eq!(
            to_mrkdwn("[docs](https://docs.slack.dev/a?x=1&y=2)"),
            "<https://docs.slack.dev/a?x=1&amp;y=2|docs>"
        );
        // A link whose text is its address, an autolink and an empty text carry no label.
        assert_eq!(
            to_mrkdwn("[https://a.jp/](https://a.jp/) <https://b.jp/> [](https://c.jp/)"),
            "<https://a.jp/> <https://b.jp/> <https://c.jp/>"
        );
        // The characters that end the address are encoded; a link with no address is its text.
        assert_eq!(
            to_mrkdwn("[x](<https://a.jp/a b|c>) [y]()"),
            "<https://a.jp/a%20b%7Cc|x> y"
        );
        // A style in the text of a link is dropped, and a style around a link stays.
        assert_eq!(
            to_mrkdwn("[**t** `c`](https://a.jp/) **[u](https://b.jp/)**"),
            "<https://a.jp/|t c> *<https://b.jp/|u>*"
        );
    }

    #[test]
    fn the_three_characters_are_escaped_and_nothing_else() {
        assert_eq!(
            to_mrkdwn("A <a@x.jp> & B > C \"q\" #ch @me"),
            "A a@x.jp &amp; B &gt; C \"q\" #ch @me"
        );
        assert_eq!(to_mrkdwn("1 < 2 > 0"), "1 &lt; 2 &gt; 0");
        // An entity typed by the user is the character it stands for, so it is escaped once.
        assert_eq!(to_mrkdwn("&lt; &amp;"), "&lt; &amp;");
        assert_eq!(to_mrkdwn("`<b>&`"), "`&lt;b&gt;&amp;`");
        assert_eq!(to_mrkdwn("<span>x</span>"), "&lt;span&gt;x&lt;/span&gt;");
    }

    #[test]
    fn lists_are_typed_out_and_nested_by_the_width_of_the_marker() {
        assert_eq!(to_mrkdwn("- a\n- **b**\n- c"), "- a\n- *b*\n- c");
        assert_eq!(to_mrkdwn("1. a\n2. b\n3. c"), "1. a\n2. b\n3. c");
        assert_eq!(to_mrkdwn("3. a\n4. b"), "3. a\n4. b");
        assert_eq!(
            to_mrkdwn("1. a\n   - x\n   - y\n2. b"),
            "1. a\n   - x\n   - y\n2. b"
        );
        assert_eq!(to_mrkdwn("- a\n\n  b\n- c"), "- a\n  b\n- c");
        assert_eq!(to_mrkdwn("-"), "-");
    }

    #[test]
    fn a_quote_keeps_its_marker_on_every_line() {
        assert_eq!(to_mrkdwn("> a\n> b"), "> a\n> b");
        assert_eq!(to_mrkdwn("> a\n>\n> b\n\nc"), "> a\n>\n> b\n\nc");
        assert_eq!(to_mrkdwn("> **a**\n> - x"), "> *a*\n>\n> - x");
        assert_eq!(to_mrkdwn("> a & b"), "> a &amp; b");
    }

    #[test]
    fn a_code_block_is_fenced_and_nothing_in_it_is_read() {
        assert_eq!(
            to_mrkdwn("```rust\nlet a = 1 < 2;\n**x**\n```"),
            "```\nlet a = 1 &lt; 2;\n**x**\n```"
        );
        assert_eq!(
            to_mrkdwn("    indented\n    code"),
            "```\nindented\ncode\n```"
        );
        assert_eq!(to_mrkdwn("a\n\n```\nb\n```\n\nc"), "a\n\n```\nb\n```\n\nc");
    }

    #[test]
    fn blocks_and_breaks_stay_apart() {
        assert_eq!(to_mrkdwn("a\n\nb"), "a\n\nb");
        assert_eq!(to_mrkdwn("a\nb"), "a\nb");
        assert_eq!(to_mrkdwn("a  \nb\\\nc"), "a\nb\nc");
        assert_eq!(to_mrkdwn("\n\n  a  \n\n"), "a");
        assert_eq!(to_mrkdwn("  \n"), "");
    }

    #[test]
    fn a_heading_is_a_bold_line_and_a_rule_is_dashes() {
        assert_eq!(
            to_mrkdwn("# T\n\n## **U**\n\n---\n\nx"),
            "*T*\n\n*U*\n\n---\n\nx"
        );
    }

    #[test]
    fn a_text_without_markup_is_kept() {
        assert_eq!(to_mrkdwn("見積の件、よろしく。"), "見積の件、よろしく。");
    }
}
