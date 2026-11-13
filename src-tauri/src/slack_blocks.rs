//! A Slack message's `blocks` (Block Kit) and `attachments` as the structure the thread screen draws (S-11).
//!
//! Pure functions from Slack's JSON: nothing here calls Slack. The text is plain text (`plain_text`), never markup; a mrkdwn text is a `Rich` (S-12).
//! A button's address is http or https, an image's address is https, and anything else is left out here, so the screen does not decide.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;
#[cfg(test)]
use ts_rs::TS;
use url::Url;

use crate::slack::{emojify, mention_ids, plain_text, unescape, UNKNOWN_NAME};
use crate::slack_mrkdwn::{parse, plain, rich_plain, Rich, RichBlock, Span};

/// Looks a user or a user group up by ID, as `plain_text` does for a mention.
type NameOf<'a> = &'a dyn Fn(&str) -> Option<String>;

/// A button. Without `url` it cannot be pressed and the screen shows its name only.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadButton {
    text: String,
    url: Option<String>,
}

/// An image. `url` is an https address that may be fetched when the user asks for the images; without it only `alt` is drawn.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadImage {
    url: Option<String>,
    alt: String,
}

/// What a section has at its right.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadAccessory {
    Button(ThreadButton),
    Image(ThreadImage),
}

/// An element of a context block: a small text or a small image.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadContext {
    Text { text: Rich },
    Image(ThreadImage),
}

/// A block of a message, as drawn. A `rich_text` block is flattened to a `Section`.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadBlock {
    Header {
        text: String,
    },
    Section {
        text: Option<Rich>,
        fields: Vec<Rich>,
        accessory: Option<ThreadAccessory>,
    },
    Context {
        elements: Vec<ThreadContext>,
    },
    Divider,
    Image {
        image: ThreadImage,
        title: Option<String>,
    },
    Actions {
        buttons: Vec<ThreadButton>,
    },
}

/// A field of an attachment.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadField {
    title: String,
    value: Rich,
}

/// An attachment, as drawn. `color` is `#rrggbb` (or `#rgb`); `fallback` is set only when nothing else of the attachment can be drawn.
/// `text_short` is the first lines of a long `text` (`fold_rich`), set only when `text` is long enough to be folded; the screen draws it with a button that swaps in `text` (S-11).
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadAttachment {
    color: Option<String>,
    pretext: Option<Rich>,
    author_name: Option<String>,
    title: Option<String>,
    title_link: Option<String>,
    text: Option<Rich>,
    text_short: Option<Rich>,
    fields: Vec<ThreadField>,
    footer: Option<String>,
    actions: Vec<ThreadButton>,
    blocks: Vec<ThreadBlock>,
    /// The attachment's own `image_url` and `thumb_url`, with the `fallback` as their description.
    image: Option<ThreadImage>,
    thumb: Option<ThreadImage>,
    fallback: Option<String>,
}

/// The blocks to draw for the message, and whether its `text` is drawn too.
/// Slack's `text` is the alternative text of a message with blocks, so it is left out when a block other than `rich_text` can be drawn; but a person's ordinary post carries a `rich_text` block that repeats it,
/// so `rich_text` is flattened only when there is such a block or `draw_rich_text` (the post is a bot's, or has no text). Nothing is flattened otherwise.
/// The text is drawn too when there are no blocks to draw, and when the message has a block that could not be (the text may stand for it).
pub(crate) fn message_blocks(
    blocks: &Value,
    draw_rich_text: bool,
    name_of: NameOf,
) -> (Vec<ThreadBlock>, bool) {
    let list = items(blocks);
    // The blocks other than `rich_text` first: they are cheap, and say whether `rich_text` is flattened at all.
    let mut drawn: Vec<(bool, Option<ThreadBlock>)> = list
        .iter()
        .map(|b| {
            let rich = b["type"] == "rich_text";
            (rich, if rich { None } else { block(b, name_of) })
        })
        .collect();
    let has_other = drawn.iter().any(|(rich, b)| !rich && b.is_some());
    if !has_other && !draw_rich_text {
        return (Vec::new(), true);
    }
    for (b, (rich, slot)) in list.iter().zip(&mut drawn) {
        if *rich {
            *slot = block(b, name_of);
        }
    }
    let missing = drawn.iter().any(|(rich, b)| !rich && b.is_none());
    let out: Vec<ThreadBlock> = drawn.into_iter().filter_map(|(_, b)| b).collect();
    let show_text = out.is_empty() || (has_other && missing);
    (out, show_text)
}

/// Every block that can be drawn, `rich_text` included (an attachment has no `text` to fall back to).
fn all_blocks(blocks: &Value, name_of: NameOf) -> Vec<ThreadBlock> {
    blocks
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| block(b, name_of))
        .collect()
}

/// The elements of a JSON array; none for anything else.
fn items(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

/// `Some(text)` unless it is blank.
fn not_blank(text: String) -> Option<String> {
    (!text.trim().is_empty()).then_some(text)
}

/// The text of a Block Kit text object (`mrkdwn` or `plain_text`) or of a plain string, as plain text. A `plain_text` object is not mrkdwn: its `<` is a `<` (only `&amp; &lt; &gt;` are undone), and its emoji codes are converted only when it says `emoji`.
fn text_of(v: &Value, name_of: NameOf) -> Option<String> {
    let (raw, plain) = match v {
        Value::String(s) => (s.as_str(), false),
        Value::Object(_) => (v["text"].as_str()?, v["type"] == "plain_text"),
        _ => return None,
    };
    not_blank(match (plain, v["emoji"] == true) {
        (false, _) => plain_text(raw, name_of),
        (true, true) => emojify(&unescape(raw)),
        (true, false) => unescape(raw),
    })
}

/// A text as `Rich`: a mrkdwn object is read for its styles (S-12), a `plain_text` object is not. A plain string is read when `string_is_mrkdwn`.
fn rich_of(v: &Value, name_of: NameOf, string_is_mrkdwn: bool) -> Option<Rich> {
    let (raw, formatted) = match v {
        Value::String(s) => (s.as_str(), string_is_mrkdwn),
        _ => (v["text"].as_str()?, v["type"] != "plain_text"),
    };
    if formatted {
        // Read once; nothing to draw is no text.
        return Some(parse(raw, name_of, &[])).filter(|rich| !rich.is_empty());
    }
    text_of(v, name_of).map(plain)
}

/// `url` as it is when it is an http or https address, else `None`: a button never opens another scheme.
/// The app's own origin on Windows and Android (`tauri.localhost`) is left out too: the navigation hook lets it through to the window itself.
fn http_url(url: Option<&str>) -> Option<String> {
    let url = url?;
    let parsed = Url::parse(url).ok()?;
    (matches!(parsed.scheme(), "http" | "https") && parsed.host_str() != Some("tauri.localhost"))
        .then(|| url.to_owned())
}

/// `url` as it is when it is an https address that needs no Slack token, else `None`.
fn image_url(url: Option<&str>) -> Option<String> {
    let url = url?;
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?.trim_end_matches('.');
    (parsed.scheme() == "https" && host != "files.slack.com").then(|| url.to_owned())
}

fn button(b: &Value, name_of: NameOf) -> Option<ThreadButton> {
    (b["type"] == "button").then_some(())?;
    Some(ThreadButton {
        text: text_of(&b["text"], name_of)?,
        url: http_url(b["url"].as_str()),
    })
}

/// An image with an address it may be fetched from, a description, or both.
fn image(v: &Value) -> Option<ThreadImage> {
    let url = image_url(v["image_url"].as_str());
    let alt = v["alt_text"].as_str().unwrap_or_default().trim().to_owned();
    (url.is_some() || !alt.is_empty()).then_some(ThreadImage { url, alt })
}

fn accessory(a: &Value, name_of: NameOf) -> Option<ThreadAccessory> {
    match a["type"].as_str()? {
        "button" => button(a, name_of).map(ThreadAccessory::Button),
        "image" => image(a).map(ThreadAccessory::Image),
        _ => None,
    }
}

fn context_element(e: &Value, name_of: NameOf) -> Option<ThreadContext> {
    match e["type"].as_str()? {
        "image" => image(e).map(ThreadContext::Image),
        "mrkdwn" | "plain_text" => {
            rich_of(e, name_of, false).map(|text| ThreadContext::Text { text })
        }
        _ => None,
    }
}

/// A text as a section with nothing else in it.
fn paragraph(text: String) -> ThreadBlock {
    ThreadBlock::Section {
        text: Some(plain(text)),
        fields: Vec::new(),
        accessory: None,
    }
}

/// A block as drawn; `None` for a type that is not drawn (a menu, an input, a video, an unknown one) and for a block with nothing in it.
fn block(b: &Value, name_of: NameOf) -> Option<ThreadBlock> {
    match b["type"].as_str()? {
        "header" => Some(ThreadBlock::Header {
            text: text_of(&b["text"], name_of)?,
        }),
        "section" => {
            let text = rich_of(&b["text"], name_of, false);
            let fields: Vec<Rich> = items(&b["fields"])
                .iter()
                .filter_map(|f| rich_of(f, name_of, false))
                .collect();
            let accessory = accessory(&b["accessory"], name_of);
            (text.is_some() || !fields.is_empty() || accessory.is_some()).then_some(
                ThreadBlock::Section {
                    text,
                    fields,
                    accessory,
                },
            )
        }
        "context" => {
            let elements: Vec<ThreadContext> = items(&b["elements"])
                .iter()
                .filter_map(|e| context_element(e, name_of))
                .collect();
            (!elements.is_empty()).then_some(ThreadBlock::Context { elements })
        }
        "divider" => Some(ThreadBlock::Divider),
        "image" => Some(ThreadBlock::Image {
            image: image(b)?,
            title: text_of(&b["title"], name_of),
        }),
        "actions" => {
            let buttons: Vec<ThreadButton> = items(&b["elements"])
                .iter()
                .filter_map(|e| button(e, name_of))
                .collect();
            (!buttons.is_empty()).then_some(ThreadBlock::Actions { buttons })
        }
        "rich_text" => rich_text(b, name_of).map(paragraph),
        // Standard Markdown, which is not mrkdwn: drawn as it is.
        "markdown" => b["text"]
            .as_str()
            .map(str::to_owned)
            .and_then(not_blank)
            .map(paragraph),
        _ => None,
    }
}

/// The inline elements of a `rich_text` section as one string.
fn inline(elements: &Value, name_of: NameOf) -> String {
    let name = |id: &Value| {
        name_of(id.as_str().unwrap_or_default()).unwrap_or_else(|| UNKNOWN_NAME.to_owned())
    };
    elements
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| match e["type"].as_str().unwrap_or_default() {
            "text" => e["text"].as_str().unwrap_or_default().to_owned(),
            "link" => {
                let url = e["url"].as_str().unwrap_or_default();
                match e["text"].as_str().filter(|t| !t.is_empty() && *t != url) {
                    Some(label) => format!("{label} ({url})"),
                    None => url.to_owned(),
                }
            }
            "user" => format!("@{}", name(&e["user_id"])),
            "usergroup" => format!("@{}", name(&e["usergroup_id"])),
            "channel" => format!("#{UNKNOWN_NAME}"),
            "broadcast" => format!("@{}", e["range"].as_str().unwrap_or_default()),
            "emoji" => emojify(&format!(":{}:", e["name"].as_str().unwrap_or_default())),
            "date" => e["fallback"].as_str().unwrap_or_default().to_owned(),
            _ => String::new(),
        })
        .collect()
}

/// One top-level element of a `rich_text` block as text.
fn rich_element(e: &Value, name_of: NameOf) -> String {
    let lines = |marker: &dyn Fn(usize) -> String, indent: usize| {
        e["elements"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, item)| {
                format!(
                    "{}{}{}",
                    "  ".repeat(indent),
                    marker(i),
                    inline(&item["elements"], name_of)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    match e["type"].as_str().unwrap_or_default() {
        "rich_text_section" | "rich_text_preformatted" => inline(&e["elements"], name_of),
        "rich_text_quote" => inline(&e["elements"], name_of)
            .lines()
            .map(|l| format!("> {l}"))
            .collect::<Vec<_>>()
            .join("\n"),
        "rich_text_list" => {
            let indent = e["indent"].as_u64().unwrap_or(0).min(8) as usize;
            if e["style"] == "ordered" {
                lines(&|i| format!("{}. ", i + 1), indent)
            } else {
                lines(&|_| "• ".to_owned(), indent)
            }
        }
        _ => String::new(),
    }
}

/// A `rich_text` block as text: its elements one under another, a list item to a line.
fn rich_text(b: &Value, name_of: NameOf) -> Option<String> {
    let mut out = String::new();
    for e in b["elements"].as_array()? {
        let part = rich_element(e, name_of);
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&part);
    }
    not_blank(out.trim_end().to_owned())
}

/// `#rrggbb` or `#rgb` for a hex colour (the `#` is optional) and for Slack's three words; anything else is no colour.
fn color(c: Option<&str>) -> Option<String> {
    match c? {
        "good" => Some("#2eb67d".to_owned()),
        "warning" => Some("#ecb22e".to_owned()),
        "danger" => Some("#e01e5a".to_owned()),
        c => {
            let hex = c.strip_prefix('#').unwrap_or(c);
            (matches!(hex.len(), 3 | 6) && hex.chars().all(|ch| ch.is_ascii_hexdigit()))
                .then(|| format!("#{}", hex.to_ascii_lowercase()))
        }
    }
}

/// Slack folds an attachment's text of 5 line breaks or more, or of 700 characters or more, and shows "Show more" for the rest.
const FOLD_LINES: usize = 5;
const FOLD_CHARS: usize = 700;

/// How much of a text is still shown: the line breaks and the characters seen so far, and the most characters that are shown.
struct Fold {
    breaks: usize,
    chars: usize,
    max_chars: usize,
}

impl Fold {
    /// A text of `total` characters: at most 700 are shown, and when it has 700 or more, at least one is left for the button.
    fn new(total: usize) -> Self {
        let max_chars = if total >= FOLD_CHARS {
            FOLD_CHARS.min(total - 1)
        } else {
            FOLD_CHARS
        };
        Fold {
            breaks: 0,
            chars: 0,
            max_chars,
        }
    }

    /// Counts `c` and says whether it is still shown. A line break that would be the 5th, and any character past the most shown, is not.
    fn admit(&mut self, c: char) -> bool {
        if self.chars >= self.max_chars || (c == '\n' && self.breaks + 1 >= FOLD_LINES) {
            return false;
        }
        self.chars += 1;
        self.breaks += usize::from(c == '\n');
        true
    }

    /// The part of `text` that is shown, and whether all of it is.
    fn take(&mut self, text: &str) -> (String, bool) {
        let mut kept = String::new();
        for c in text.chars() {
            if !self.admit(c) {
                return (kept, false);
            }
            kept.push(c);
        }
        (kept, true)
    }
}

/// The characters of a text, the break between two blocks counted as one.
fn rich_chars(rich: &Rich) -> usize {
    let chars = |spans: &[Span]| spans.iter().map(|s| s.text.chars().count()).sum::<usize>();
    let blocks: usize = rich
        .iter()
        .map(|block| match block {
            RichBlock::Code { text } => text.chars().count(),
            RichBlock::Paragraph { spans } | RichBlock::Quote { spans } => chars(spans),
        })
        .sum();
    blocks + rich.len().saturating_sub(1)
}

/// The first 5 lines, and at most 700 characters, of a text of 5 line breaks or 700 characters or more, with its styles and blocks; `None` when nothing is cut.
/// The break between two blocks is a line break too. Pure, so the screen decides nothing (S-11).
pub(crate) fn fold_rich(rich: &Rich) -> Option<Rich> {
    let mut fold = Fold::new(rich_chars(rich));
    let mut out = Rich::new();
    let mut whole = true;
    for (i, block) in rich.iter().enumerate() {
        if i > 0 && !fold.admit('\n') {
            whole = false;
            break;
        }
        let shown = match block {
            RichBlock::Code { text } => {
                let (text, all) = fold.take(text);
                whole = all;
                (!text.is_empty()).then_some(RichBlock::Code { text })
            }
            RichBlock::Paragraph { spans } | RichBlock::Quote { spans } => {
                let mut kept = Vec::new();
                for s in spans {
                    let (text, all) = fold.take(&s.text);
                    if !text.is_empty() {
                        kept.push(Span { text, ..s.clone() });
                    }
                    if !all {
                        whole = false;
                        break;
                    }
                }
                (!kept.is_empty()).then_some(match block {
                    RichBlock::Quote { .. } => RichBlock::Quote { spans: kept },
                    _ => RichBlock::Paragraph { spans: kept },
                })
            }
        };
        out.extend(shown);
        if !whole {
            break;
        }
    }
    (!whole).then_some(out)
}

fn attachment(a: &Value, name_of: NameOf) -> Option<ThreadAttachment> {
    if !a.is_object() {
        return None;
    }
    let text = |key: &str| text_of(&a[key], name_of);
    // Only the texts `mrkdwn_in` names are read for styles (`text`, `pretext` and `fields`, for the values of the fields); the others are plain text.
    let styled = |key: &str| items(&a["mrkdwn_in"]).iter().any(|k| k == key);
    let rich = |key: &str| rich_of(&a[key], name_of, styled(key));
    let title = text("title");
    let body = rich("text");
    let mut out = ThreadAttachment {
        color: color(a["color"].as_str()),
        pretext: rich("pretext"),
        author_name: text("author_name"),
        title_link: title
            .as_ref()
            .and_then(|_| http_url(a["title_link"].as_str())),
        title,
        text_short: body.as_ref().and_then(fold_rich),
        text: body,
        fields: a["fields"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| {
                let (title, value) = (
                    text_of(&f["title"], name_of),
                    rich_of(&f["value"], name_of, styled("fields")),
                );
                (title.is_some() || value.is_some()).then(|| ThreadField {
                    title: title.unwrap_or_default(),
                    value: value.unwrap_or_default(),
                })
            })
            .collect(),
        footer: text("footer"),
        actions: a["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| button(b, name_of))
            .collect(),
        blocks: all_blocks(&a["blocks"], name_of),
        image: None,
        thumb: None,
        fallback: None,
    };
    // The images use the fallback as their description; a thumbnail with no address of its own adds nothing to an image that is there.
    let alt = text("fallback").unwrap_or_default();
    let picture = |key: &str| {
        a[key].as_str().and_then(|raw| {
            let url = image_url(Some(raw));
            (url.is_some() || !alt.is_empty()).then(|| ThreadImage {
                url,
                alt: alt.clone(),
            })
        })
    };
    out.image = picture("image_url");
    out.thumb = picture("thumb_url").filter(|t| t.url.is_some() || out.image.is_none());
    let drawn = out.pretext.is_some()
        || out.image.is_some()
        || out.thumb.is_some()
        || out.author_name.is_some()
        || out.title.is_some()
        || out.text.is_some()
        || !out.fields.is_empty()
        || out.footer.is_some()
        || !out.actions.is_empty()
        || !out.blocks.is_empty();
    if !drawn {
        out.fallback = Some(text("fallback")?);
    }
    Some(out)
}

/// `url` as it is when it is an https address of Slack (`slack.com` or a host under it, with no port and no user name), else `None`: the link of a message's text is labeled and opened, so it must be somewhere Slack is.
fn slack_url(url: &str) -> Option<String> {
    let url = http_url(Some(url))?;
    let parsed = Url::parse(&url).ok()?;
    let host = parsed.host_str()?;
    (parsed.scheme() == "https"
        && (host == "slack.com" || host.ends_with(".slack.com"))
        && parsed.port().is_none()
        && parsed.username().is_empty()
        && parsed.password().is_none())
    .then_some(url)
}

/// The addresses of the messages that the attachments of a message unfurl (`is_msg_unfurl`, with `from_url` and `original_url`, S-11), once each, only those that are https addresses of Slack (`slack_url`). The text of the same message draws a link to one of them as a link labeled "メッセージ"; any other stays the address.
pub(crate) fn unfurled_urls(attachments: &Value) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for a in attachments.as_array().into_iter().flatten() {
        if a["is_msg_unfurl"] != true {
            continue;
        }
        for key in ["from_url", "original_url"] {
            if let Some(url) = a[key].as_str().and_then(slack_url) {
                if !urls.contains(&url) {
                    urls.push(url);
                }
            }
        }
    }
    urls
}

/// The attachments that can be drawn.
pub(crate) fn message_attachments(attachments: &Value, name_of: NameOf) -> Vec<ThreadAttachment> {
    attachments
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| attachment(a, name_of))
        .collect()
}

/// The https addresses of the images of `blocks` and `attachments`, once each, in order.
pub(crate) fn image_urls(blocks: &[ThreadBlock], attachments: &[ThreadAttachment]) -> Vec<String> {
    let mut seen = HashSet::new();
    blocks
        .iter()
        .flat_map(block_images)
        .chain(attachments.iter().flat_map(attachment_images))
        .filter(|url| seen.insert(*url))
        .map(str::to_owned)
        .collect()
}

/// The addresses of an attachment's own images, then those of its blocks.
fn attachment_images(a: &ThreadAttachment) -> Vec<&str> {
    [&a.image, &a.thumb]
        .into_iter()
        .flatten()
        .filter_map(|i| i.url.as_deref())
        .chain(a.blocks.iter().flat_map(block_images))
        .collect()
}

fn block_images(b: &ThreadBlock) -> Vec<&str> {
    fn url(i: &ThreadImage) -> Option<&str> {
        i.url.as_deref()
    }
    match b {
        ThreadBlock::Image { image, .. } => url(image).into_iter().collect(),
        ThreadBlock::Section {
            accessory: Some(ThreadAccessory::Image(image)),
            ..
        } => url(image).into_iter().collect(),
        ThreadBlock::Context { elements } => elements
            .iter()
            .filter_map(|e| match e {
                ThreadContext::Image(image) => url(image),
                ThreadContext::Text { .. } => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The keys whose content is drawn, so the only places a mention is looked for (a URL or an ID elsewhere is not read).
const DRAWN_KEYS: [&str; 9] = [
    "text",
    "fields",
    "elements",
    "blocks",
    "pretext",
    "title",
    "footer",
    "author_name",
    "value",
];

/// Every mention in the drawn parts of `v`: `<@U1>` in a text, and the `user` elements of `rich_text`.
fn collect_mentions(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.extend(mention_ids(s)),
        Value::Array(a) => a.iter().for_each(|x| collect_mentions(x, out)),
        Value::Object(_) => {
            if v["type"] == "user" {
                out.extend(v["user_id"].as_str().map(str::to_owned));
            }
            DRAWN_KEYS
                .iter()
                .for_each(|k| collect_mentions(&v[*k], out));
        }
        _ => {}
    }
}

/// The users that the blocks and the attachments of `message` mention, each once.
/// An attachment's `fallback` is drawn only when nothing else of it is, so it is read only then.
pub(crate) fn mentioned_users(message: &Value) -> Vec<String> {
    let mut found = Vec::new();
    collect_mentions(&message["blocks"], &mut found);
    for a in items(&message["attachments"]) {
        collect_mentions(a, &mut found);
        let other = [
            "pretext",
            "author_name",
            "title",
            "text",
            "fields",
            "footer",
            "actions",
            "blocks",
            "image_url",
            "thumb_url",
        ]
        .iter()
        .any(|k| !a[*k].is_null());
        if !other {
            collect_mentions(&a["fallback"], &mut found);
        }
    }
    let mut seen = HashSet::new();
    found.retain(|id| seen.insert(id.clone()));
    found
}

/// A button as text: its name, and its address when it has one.
fn button_line(b: &ThreadButton) -> String {
    match &b.url {
        Some(url) => format!("{} ({url})", b.text),
        None => b.text.clone(),
    }
}

/// The description of an image, when it has one.
fn alt_line(i: &ThreadImage) -> Option<String> {
    (!i.alt.is_empty()).then(|| i.alt.clone())
}

/// The text of a block, a line to an item, for Claude (S-7). A divider has none.
fn block_lines(b: &ThreadBlock, out: &mut Vec<String>) {
    match b {
        ThreadBlock::Header { text } => out.push(text.clone()),
        ThreadBlock::Section {
            text,
            fields,
            accessory,
        } => {
            out.extend(text.iter().map(rich_plain));
            out.extend(fields.iter().map(rich_plain));
            match accessory {
                Some(ThreadAccessory::Button(button)) => out.push(button_line(button)),
                Some(ThreadAccessory::Image(image)) => out.extend(alt_line(image)),
                None => {}
            }
        }
        ThreadBlock::Context { elements } => {
            for e in elements {
                match e {
                    ThreadContext::Text { text } => out.push(rich_plain(text)),
                    ThreadContext::Image(image) => out.extend(alt_line(image)),
                }
            }
        }
        ThreadBlock::Divider => {}
        ThreadBlock::Image { image, title } => {
            out.extend(alt_line(image));
            out.extend(title.clone());
        }
        ThreadBlock::Actions { buttons } => out.extend(buttons.iter().map(button_line)),
    }
}

/// The text of an attachment, a line to an item, for Claude (S-7).
fn attachment_lines(a: &ThreadAttachment, out: &mut Vec<String>) {
    out.extend(a.pretext.iter().map(rich_plain));
    out.extend(a.author_name.clone());
    out.extend(a.title.as_ref().map(|t| match &a.title_link {
        Some(link) => format!("{t} ({link})"),
        None => t.clone(),
    }));
    out.extend(a.text.iter().map(rich_plain));
    for f in &a.fields {
        let value = rich_plain(&f.value);
        out.push(match (f.title.is_empty(), value.is_empty()) {
            (false, false) => format!("{}: {value}", f.title),
            (true, _) => value,
            (_, true) => f.title.clone(),
        });
    }
    out.extend(a.footer.clone());
    out.extend(a.actions.iter().map(button_line));
    a.blocks.iter().for_each(|b| block_lines(b, out));
    let before = out.len();
    out.extend(a.image.iter().filter_map(alt_line));
    // The thumbnail repeats the image's description.
    if let Some(thumb) = a.thumb.iter().find_map(alt_line) {
        if !out[before..].contains(&thumb) {
            out.push(thumb);
        }
    }
    out.extend(a.fallback.clone());
}

/// What the screen shows of a message, as plain text for Claude (S-7): the message's text (only while the screen draws it, `show_text`), then its blocks and its attachments, a line to an item.
/// A block or an attachment that is not drawn has no text here either; an image is its description.
pub(crate) fn message_plain(
    text: &str,
    show_text: bool,
    blocks: &[ThreadBlock],
    attachments: &[ThreadAttachment],
) -> String {
    let mut lines = Vec::new();
    if show_text {
        lines.push(text.to_owned());
    }
    blocks.iter().for_each(|b| block_lines(b, &mut lines));
    attachments
        .iter()
        .for_each(|a| attachment_lines(a, &mut lines));
    lines.retain(|l| !l.trim().is_empty());
    lines.join("\n").trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn blocks(v: Value) -> Vec<ThreadBlock> {
        message_blocks(&v, false, &|_| None).0
    }

    /// A text with no style.
    fn p(text: &str) -> Rich {
        plain(text.to_owned())
    }

    /// A paragraph of spans: `(text, bold)`.
    fn styled(spans: &[(&str, bool)]) -> Rich {
        vec![RichBlock::Paragraph {
            spans: spans
                .iter()
                .map(|(text, bold)| Span {
                    text: (*text).to_owned(),
                    bold: *bold,
                    ..Span::default()
                })
                .collect(),
        }]
    }

    fn section(text: &str) -> ThreadBlock {
        ThreadBlock::Section {
            text: Some(p(text)),
            fields: vec![],
            accessory: None,
        }
    }

    fn rich(elements: Value) -> Value {
        json!({"type": "rich_text", "elements": elements})
    }

    fn rich_section(text: &str) -> Value {
        rich(json!([{"type": "rich_text_section", "elements": [{"type": "text", "text": text}]}]))
    }

    #[test]
    fn a_message_of_rich_text_only_draws_its_text() {
        assert_eq!(blocks(json!([rich_section("hi")])), vec![]);
        assert_eq!(blocks(json!([])), vec![]);
        assert_eq!(blocks(Value::Null), vec![]);
        assert_eq!(blocks(json!("x")), vec![]);
    }

    fn drawn(v: Value, draw_rich_text: bool) -> (Vec<ThreadBlock>, bool) {
        message_blocks(&v, draw_rich_text, &|_| None)
    }

    #[test]
    fn a_bots_or_a_textless_rich_text_only_message_draws_its_blocks() {
        assert_eq!(
            drawn(json!([rich_section("hi")]), true),
            (vec![section("hi")], false)
        );
        // A rich text with nothing in it leaves the text.
        assert_eq!(drawn(json!([rich_section(" ")]), true), (vec![], true));
        // A person's ordinary post stays text, and its rich text is not even flattened.
        assert_eq!(drawn(json!([rich_section("hi")]), false), (vec![], true));
    }

    #[test]
    fn the_text_is_drawn_too_only_when_there_is_nothing_to_draw_or_a_block_could_not_be() {
        let header = json!({"type": "header", "text": {"type": "plain_text", "text": "H"}});
        let head = ThreadBlock::Header { text: "H".into() };
        assert_eq!(drawn(json!([]), false), (vec![], true));
        assert_eq!(
            drawn(json!([header.clone()]), false),
            (vec![head.clone()], false)
        );
        assert_eq!(
            drawn(json!([header.clone(), {"type": "divider"}]), false),
            (vec![head.clone(), ThreadBlock::Divider], false)
        );
        // A block that could not be drawn (an unknown type, an empty section) sits among drawn ones: both are shown.
        assert_eq!(
            drawn(json!([header.clone(), {"type": "input"}]), false),
            (vec![head.clone()], true)
        );
        assert_eq!(
            drawn(json!([header, {"type": "section"}]), false),
            (vec![head], true)
        );
        // Nothing drawable at all: the text.
        assert_eq!(drawn(json!([{"type": "input"}]), false), (vec![], true));
    }

    #[test]
    fn a_markdown_block_is_a_section_of_its_text() {
        assert_eq!(
            blocks(json!([{"type": "markdown", "text": "**bold** & <b>raw</b>"}])),
            vec![section("**bold** & <b>raw</b>")]
        );
        assert_eq!(
            blocks(json!([{"type": "markdown", "text": "  "}, {"type": "divider"}])),
            vec![ThreadBlock::Divider]
        );
    }

    #[test]
    fn a_plain_text_object_gets_its_escapes_back_but_stays_plain() {
        let list = blocks(json!([
            {"type": "header", "text": {"type": "plain_text", "text": "a &amp; b &lt;c&gt; &amp;lt;"}},
            {"type": "header", "text": {"type": "plain_text", "text": "&lt;:fire:&gt;", "emoji": true}},
        ]));
        assert_eq!(
            list,
            vec![
                ThreadBlock::Header {
                    text: "a & b <c> &lt;".into()
                },
                ThreadBlock::Header {
                    text: "<🔥>".into()
                },
            ]
        );
    }

    #[test]
    fn a_link_to_the_apps_own_origin_is_not_a_link() {
        let one = |url: &str| {
            attachments(json!([{"title": "t", "title_link": url, "actions": [{"type": "button", "text": "B", "url": url}]}]))
                .remove(0)
        };
        for own in [
            "https://tauri.localhost/index.html",
            "http://tauri.localhost/",
            "https://TAURI.localhost/x",
        ] {
            let a = one(own);
            assert_eq!(a.title_link, None, "{own}");
            assert_eq!(a.actions[0].url, None, "{own}");
        }
        // Another host that only looks like it is a link.
        let other = one("https://tauri.localhost.example.com/");
        assert!(other.title_link.is_some());
        assert!(other.actions[0].url.is_some());
    }

    #[test]
    fn unknown_or_empty_blocks_do_not_replace_the_text() {
        assert_eq!(
            blocks(json!([{"type": "input"}, {"type": "video"}])),
            vec![]
        );
        // A section with nothing in it is nothing to draw.
        assert_eq!(blocks(json!([{"type": "section"}])), vec![]);
        assert_eq!(blocks(json!([{"type": "context", "elements": []}])), vec![]);
        // Only a select menu: nothing to draw, so the text stays.
        assert_eq!(
            blocks(json!([{"type": "actions", "elements": [{"type": "static_select"}]}])),
            vec![]
        );
    }

    #[test]
    fn a_block_other_than_rich_text_replaces_the_text_and_keeps_the_rich_text_as_a_paragraph() {
        let list = blocks(json!([
            {"type": "header", "text": {"type": "plain_text", "text": "Build :tada:", "emoji": true}},
            rich(json!([{"type": "rich_text_section", "elements": [{"type": "text", "text": "see "}, {"type": "link", "url": "https://a.example/x", "text": "the run"}]}])),
            {"type": "divider"}
        ]));
        assert_eq!(
            list,
            vec![
                ThreadBlock::Header {
                    text: "Build 🎉".into()
                },
                section("see the run (https://a.example/x)"),
                ThreadBlock::Divider,
            ]
        );
    }

    #[test]
    fn a_section_has_a_text_fields_and_an_accessory() {
        let list = blocks(json!([{
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*Project* <https://a.example/p|api> &lt;1&gt; :fire:"},
            "fields": [
                {"type": "mrkdwn", "text": "*When*\nnow"},
                {"type": "plain_text", "text": "<b>raw</b> :fire:"},
                {"type": "plain_text", "text": "   "}
            ],
            "accessory": {"type": "button", "text": {"type": "plain_text", "text": "View Job"}, "url": "https://a.example/job"}
        }]));
        assert_eq!(
            list,
            vec![ThreadBlock::Section {
                text: Some(styled(&[
                    ("Project", true),
                    (" api (https://a.example/p) <1> 🔥", false)
                ])),
                // A `plain_text` field is not read for styles.
                fields: vec![
                    styled(&[("When", true), ("\nnow", false)]),
                    p("<b>raw</b> :fire:")
                ],
                accessory: Some(ThreadAccessory::Button(ThreadButton {
                    text: "View Job".into(),
                    url: Some("https://a.example/job".into())
                })),
            }]
        );
    }

    #[test]
    fn a_mrkdwn_text_is_read_for_its_styles_and_a_plain_text_is_not() {
        let list = blocks(json!([
            {"type": "section", "text": {"type": "mrkdwn", "text": "a\n&gt; *q*\n```\n*c*\n```"}},
            {"type": "section", "text": {"type": "plain_text", "text": "*not bold*"}},
            {"type": "header", "text": {"type": "plain_text", "text": "*not bold*"}},
        ]));
        let ThreadBlock::Section { text, .. } = &list[0] else {
            panic!("a section")
        };
        let kinds: Vec<&str> = text
            .iter()
            .flatten()
            .map(|b| match b {
                RichBlock::Paragraph { .. } => "paragraph",
                RichBlock::Quote { .. } => "quote",
                RichBlock::Code { .. } => "code",
            })
            .collect();
        assert_eq!(kinds, ["paragraph", "quote", "code"]);
        assert_eq!(list[1], section("*not bold*"));
        assert_eq!(
            list[2],
            ThreadBlock::Header {
                text: "*not bold*".into()
            }
        );
        // A `rich_text` block and a `markdown` block are not mrkdwn: their marks stay.
        assert_eq!(
            blocks(json!([{"type": "markdown", "text": "*x*"}])),
            vec![section("*x*")]
        );
    }

    #[test]
    fn an_attachment_is_read_for_styles_only_where_mrkdwn_in_says() {
        let list = attachments(json!([{
            "pretext": "*pre*",
            "text": "*text*",
            "title": "*title*",
            "footer": "*footer*",
            "fields": [{"title": "*t*", "value": "*v*"}],
            "mrkdwn_in": ["text", "fields"]
        }]));
        let a = &list[0];
        assert_eq!(a.pretext, Some(p("*pre*")));
        assert_eq!(a.text, Some(styled(&[("text", true)])));
        assert_eq!(a.title.as_deref(), Some("*title*"));
        assert_eq!(a.footer.as_deref(), Some("*footer*"));
        assert_eq!(a.fields[0].title, "*t*");
        assert_eq!(a.fields[0].value, styled(&[("v", true)]));
        // Without `mrkdwn_in` nothing is read.
        let off =
            attachments(json!([{"text": "*text*", "fields": [{"title": "t", "value": "*v*"}]}]));
        assert_eq!(off[0].text, Some(p("*text*")));
        assert_eq!(off[0].fields[0].value, p("*v*"));
    }

    #[test]
    fn plain_text_converts_its_emoji_only_when_asked_to() {
        let list = blocks(json!([
            {"type": "header", "text": {"type": "plain_text", "text": ":fire:", "emoji": false}},
            {"type": "header", "text": {"type": "plain_text", "text": ":fire:"}},
            {"type": "header", "text": {"type": "plain_text", "text": ":fire:", "emoji": true}},
        ]));
        assert_eq!(
            list,
            vec![
                ThreadBlock::Header {
                    text: ":fire:".into()
                },
                ThreadBlock::Header {
                    text: ":fire:".into()
                },
                ThreadBlock::Header {
                    text: "🔥".into()
                },
            ]
        );
    }

    #[test]
    fn a_mention_in_a_text_gets_its_name() {
        let names = |id: &str| (id == "U1").then(|| "Alice".to_owned());
        let list = message_blocks(
            &json!([{"type": "section", "text": {"type": "mrkdwn", "text": "hi <@U1> and <@U2>"}}]),
            false,
            &names,
        )
        .0;
        assert_eq!(list, vec![section("hi @Alice and @不明")]);
    }

    #[test]
    fn a_user_group_mention_gets_its_handle_or_unknown() {
        let names = |id: &str| (id == "S1").then(|| "design".to_owned());
        let text = |t: &str| {
            message_blocks(
                &json!([{"type": "section", "text": {"type": "mrkdwn", "text": t}}]),
                false,
                &names,
            )
            .0
        };
        assert_eq!(
            text("hi <!subteam^S1> and <!subteam^S2>"),
            vec![section("hi @design and @不明")]
        );
        let rich = json!([{"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [
            {"type": "usergroup", "usergroup_id": "S1"},
            {"type": "text", "text": " "},
            {"type": "usergroup", "usergroup_id": "S2"}
        ]}]}]);
        assert_eq!(
            message_blocks(&rich, true, &names).0,
            vec![section("@design @不明")]
        );
        assert_eq!(
            message_blocks(&rich, true, &|_| None).0,
            vec![section("@不明 @不明")]
        );
    }

    #[test]
    fn a_button_opens_only_an_http_or_https_address() {
        let one = |url: Value| match &blocks(json!([
            {"type": "actions", "elements": [{"type": "button", "text": {"type": "plain_text", "text": "Go"}, "url": url}]}
        ]))[..]
        {
            [ThreadBlock::Actions { buttons }] => buttons.clone(),
            other => panic!("{other:?}"),
        };
        let go = |url: Option<&str>| {
            vec![ThreadButton {
                text: "Go".into(),
                url: url.map(str::to_owned),
            }]
        };
        assert_eq!(
            one(json!("https://a.example/x?y=1")),
            go(Some("https://a.example/x?y=1"))
        );
        assert_eq!(
            one(json!("http://a.example/x")),
            go(Some("http://a.example/x"))
        );
        for bad in [
            "javascript:alert(1)",
            "slack://channel?id=C1",
            "mailto:a@a.example",
            "file:///etc/passwd",
            "ftp://a.example",
            "//a.example",
            "not a url",
            "",
        ] {
            assert_eq!(one(json!(bad)), go(None), "{bad}");
        }
        assert_eq!(one(Value::Null), go(None));
        // A button with no name is dropped.
        let nameless = json!([{"type": "actions", "elements": [{"type": "button", "url": "https://a.example"}, {"type": "button", "text": {"type": "plain_text", "text": "Go"}}]}]);
        assert_eq!(
            blocks(nameless),
            vec![ThreadBlock::Actions { buttons: go(None) }]
        );
    }

    #[test]
    fn a_context_has_texts_and_images() {
        let list = blocks(json!([{
            "type": "context",
            "elements": [
                {"type": "image", "image_url": "https://a.example/i.png", "alt_text": "logo"},
                {"type": "mrkdwn", "text": "built by *bot*"},
                {"type": "image", "slack_file": {"id": "F1"}, "alt_text": "private"},
                {"type": "image"}
            ]
        }]));
        assert_eq!(
            list,
            vec![ThreadBlock::Context {
                elements: vec![
                    ThreadContext::Image(ThreadImage {
                        url: Some("https://a.example/i.png".into()),
                        alt: "logo".into()
                    }),
                    ThreadContext::Text {
                        text: styled(&[("built by ", false), ("bot", true)])
                    },
                    ThreadContext::Image(ThreadImage {
                        url: None,
                        alt: "private".into()
                    }),
                ]
            }]
        );
    }

    #[test]
    fn an_image_is_https_only_and_never_one_that_needs_the_token() {
        let image = |v: Value| match &blocks(json!([v]))[..] {
            [ThreadBlock::Image { image, title }] => (image.clone(), title.clone()),
            other => panic!("{other:?}"),
        };
        let (got, title) = image(
            json!({"type": "image", "image_url": "https://a.example/i.png", "alt_text": "chart", "title": {"type": "plain_text", "text": "Chart"}}),
        );
        assert_eq!(
            got,
            ThreadImage {
                url: Some("https://a.example/i.png".into()),
                alt: "chart".into()
            }
        );
        assert_eq!(title.as_deref(), Some("Chart"));
        for bad in [
            "http://a.example/i.png",
            "data:image/png;base64,AAAA",
            "https://files.slack.com/files-pri/T1-F1/x.png",
            "https://FILES.slack.com/x.png",
            "javascript:1",
            "x",
        ] {
            let (got, _) = image(json!({"type": "image", "image_url": bad, "alt_text": "chart"}));
            assert_eq!(
                got,
                ThreadImage {
                    url: None,
                    alt: "chart".into()
                },
                "{bad}"
            );
        }
        let (got, _) = image(
            json!({"type": "image", "slack_file": {"url": "https://files.slack.com/x.png"}, "alt_text": "chart"}),
        );
        assert_eq!(got.url, None);
        // Neither an address nor a description: nothing to draw.
        assert_eq!(
            blocks(
                json!([{"type": "image", "image_url": "http://a.example/i.png"}, {"type": "divider"}])
            ),
            vec![ThreadBlock::Divider]
        );
    }

    #[test]
    fn a_section_accessory_may_be_an_image() {
        let list = blocks(
            json!([{"type": "section", "text": {"type": "mrkdwn", "text": "x"}, "accessory": {"type": "image", "image_url": "https://a.example/t.png", "alt_text": "thumb"}}]),
        );
        assert_eq!(
            list,
            vec![ThreadBlock::Section {
                text: Some(p("x")),
                fields: vec![],
                accessory: Some(ThreadAccessory::Image(ThreadImage {
                    url: Some("https://a.example/t.png".into()),
                    alt: "thumb".into()
                })),
            }]
        );
        // A menu as accessory is left out; the text stays.
        let menu = blocks(
            json!([{"type": "section", "text": {"type": "mrkdwn", "text": "x"}, "accessory": {"type": "static_select"}}]),
        );
        assert_eq!(menu, vec![section("x")]);
    }

    #[test]
    fn rich_text_is_flattened_to_text() {
        let names = |id: &str| (id == "U1").then(|| "Alice".to_owned());
        let r = rich(json!([
            {"type": "rich_text_section", "elements": [
                {"type": "text", "text": "hello "},
                {"type": "user", "user_id": "U1"},
                {"type": "text", "text": " and "},
                {"type": "user", "user_id": "U9"},
                {"type": "text", "text": " "},
                {"type": "channel", "channel_id": "C1"},
                {"type": "broadcast", "range": "here"},
                {"type": "emoji", "name": "tada"},
                {"type": "emoji", "name": "my_custom"},
                {"type": "link", "url": "https://a.example"},
                {"type": "text", "text": " "},
                {"type": "date", "fallback": "Nov 4"}
            ]},
            {"type": "rich_text_list", "style": "bullet", "indent": 0, "elements": [
                {"type": "rich_text_section", "elements": [{"type": "text", "text": "one"}]},
                {"type": "rich_text_section", "elements": [{"type": "text", "text": "two"}]}
            ]},
            {"type": "rich_text_list", "style": "ordered", "indent": 1, "elements": [
                {"type": "rich_text_section", "elements": [{"type": "text", "text": "first"}]},
                {"type": "rich_text_section", "elements": [{"type": "text", "text": "second"}]}
            ]},
            {"type": "rich_text_quote", "elements": [{"type": "text", "text": "quoted <b>"}]},
            {"type": "rich_text_preformatted", "elements": [{"type": "text", "text": "let x = 1;\n"}]}
        ]));
        let list = message_blocks(&json!([r, {"type": "divider"}]), false, &names).0;
        assert_eq!(
            list[0],
            section("hello @Alice and @不明 #不明@here🎉:my_custom:https://a.example Nov 4\n• one\n• two\n  1. first\n  2. second\n> quoted <b>\nlet x = 1;")
        );
    }

    #[test]
    fn an_empty_rich_text_is_nothing() {
        assert_eq!(
            blocks(json!([rich_section("  \n"), {"type": "divider"}])),
            vec![ThreadBlock::Divider]
        );
    }

    fn attachments(v: Value) -> Vec<ThreadAttachment> {
        message_attachments(&v, &|_| None)
    }

    fn bare() -> ThreadAttachment {
        ThreadAttachment {
            color: None,
            pretext: None,
            author_name: None,
            title: None,
            title_link: None,
            text: None,
            text_short: None,
            fields: vec![],
            footer: None,
            actions: vec![],
            blocks: vec![],
            image: None,
            thumb: None,
            fallback: None,
        }
    }

    #[test]
    fn an_attachment_draws_its_parts() {
        let list = attachments(json!([{
            "color": "36a64f",
            "pretext": "Before <https://a.example|link>",
            "author_name": "CI :robot_face:",
            "title": "Job #1",
            "title_link": "https://a.example/job/1",
            "text": "Passed &amp; done",
            "fields": [{"title": "Project", "value": "api", "short": true}, {"title": "", "value": ""}, {"title": "Only title", "value": ""}],
            "footer": "via CI",
            "fallback": "ignored because there is more",
            "actions": [
                {"type": "button", "text": "Open", "url": "https://a.example/open"},
                {"type": "button", "text": "Rerun"}
            ]
        }]));
        assert_eq!(
            list,
            vec![ThreadAttachment {
                color: Some("#36a64f".into()),
                pretext: Some(p("Before link (https://a.example)")),
                author_name: Some("CI 🤖".into()),
                title: Some("Job #1".into()),
                title_link: Some("https://a.example/job/1".into()),
                text: Some(p("Passed & done")),
                text_short: None,
                fields: vec![
                    ThreadField {
                        title: "Project".into(),
                        value: p("api")
                    },
                    ThreadField {
                        title: "Only title".into(),
                        value: vec![]
                    },
                ],
                footer: Some("via CI".into()),
                actions: vec![
                    ThreadButton {
                        text: "Open".into(),
                        url: Some("https://a.example/open".into())
                    },
                    ThreadButton {
                        text: "Rerun".into(),
                        url: None
                    },
                ],
                blocks: vec![],
                image: None,
                thumb: None,
                fallback: None,
            }]
        );
    }

    #[test]
    fn an_attachments_color_is_a_hex_or_one_of_three_words() {
        let color = |c: Value| {
            attachments(json!([{"title": "t", "color": c}]))[0]
                .color
                .clone()
        };
        assert_eq!(color(json!("#36A64F")).as_deref(), Some("#36a64f"));
        assert_eq!(color(json!("abc")).as_deref(), Some("#abc"));
        assert_eq!(color(json!("good")).as_deref(), Some("#2eb67d"));
        assert_eq!(color(json!("warning")).as_deref(), Some("#ecb22e"));
        assert_eq!(color(json!("danger")).as_deref(), Some("#e01e5a"));
        for bad in [
            "red",
            "#12",
            "#12345",
            "#1234567",
            "#ggg",
            "red; background: url(x)",
            "#36a64f; x",
            "",
            "url(https://a.example)",
        ] {
            assert_eq!(color(json!(bad)), None, "{bad}");
        }
        assert_eq!(color(Value::Null), None);
        assert_eq!(color(json!(123)), None);
    }

    #[test]
    fn a_title_is_a_link_only_for_http_or_https() {
        let link = |l: &str| {
            attachments(json!([{"title": "t", "title_link": l}]))[0]
                .title_link
                .clone()
        };
        assert_eq!(
            link("http://a.example/x").as_deref(),
            Some("http://a.example/x")
        );
        assert_eq!(link("javascript:alert(1)"), None);
        assert_eq!(link("slack://x"), None);
        // A link with no title is not drawn.
        assert_eq!(
            attachments(json!([{"title_link": "https://a.example"}])),
            vec![]
        );
    }

    #[test]
    fn the_fallback_is_drawn_only_when_nothing_else_is() {
        let only = attachments(
            json!([{"fallback": "Plain &lt;b&gt;summary&lt;/b&gt; :fire:", "color": "good"}]),
        );
        assert_eq!(
            only,
            vec![ThreadAttachment {
                color: Some("#2eb67d".into()),
                fallback: Some("Plain <b>summary</b> 🔥".into()),
                ..bare()
            }]
        );
        for other in [
            json!({"text": "t"}),
            json!({"title": "t"}),
            json!({"pretext": "t"}),
            json!({"author_name": "t"}),
            json!({"footer": "t"}),
            json!({"fields": [{"title": "a", "value": "b"}]}),
            json!({"blocks": [{"type": "divider"}]}),
            json!({"actions": [{"type": "button", "text": "B"}]}),
            json!({"image_url": "https://a.example/i.png"}),
            json!({"thumb_url": "https://a.example/t.png"}),
        ] {
            let mut a = other.clone();
            a["fallback"] = json!("fb");
            assert_eq!(attachments(json!([a]))[0].fallback, None, "{other}");
        }
    }

    #[test]
    fn an_attachments_own_images_are_drawn_with_the_fallback_as_their_description() {
        let image = |url: &str, alt: &str| ThreadImage {
            url: Some(url.to_owned()),
            alt: alt.to_owned(),
        };
        // An attachment of nothing but an image is not dropped, and its fallback is the description, not a text.
        let only =
            attachments(json!([{"image_url": "https://a.example/i.png", "fallback": "A chart"}]));
        assert_eq!(
            only,
            vec![ThreadAttachment {
                image: Some(image("https://a.example/i.png", "A chart")),
                ..bare()
            }]
        );
        // Both are kept when both are given, and with no fallback the description is empty.
        let both = attachments(
            json!([{"image_url": "https://a.example/i.png", "thumb_url": "https://a.example/t.png"}]),
        );
        assert_eq!(both[0].image, Some(image("https://a.example/i.png", "")));
        assert_eq!(both[0].thumb, Some(image("https://a.example/t.png", "")));
        // The same address rules as a block's image: https, and not the host that needs the token.
        let bad = attachments(
            json!([{"title": "t", "image_url": "http://a.example/i.png", "thumb_url": "https://files.slack.com/x.png"}]),
        );
        assert_eq!(bad[0].image, None);
        assert_eq!(bad[0].thumb, None);
        // An address that cannot be used still leaves the description, once.
        let alt_only = attachments(
            json!([{"image_url": "http://a.example/i.png", "thumb_url": "http://a.example/t.png", "fallback": "A chart"}]),
        );
        assert_eq!(
            alt_only[0].image,
            Some(ThreadImage {
                url: None,
                alt: "A chart".into()
            })
        );
        assert_eq!(alt_only[0].thumb, None);
        assert_eq!(alt_only[0].fallback, None);
    }

    fn lines(n: usize) -> String {
        (1..=n)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_text_of_five_line_breaks_or_700_characters_or_more_is_folded() {
        // 4 breaks and 699 characters stay whole; 5 breaks fold to the first 5 lines, and 700 characters or more fold to at most 700, with something always left for the button.
        assert_eq!(fold_rich(&p(&lines(5))), None);
        assert_eq!(fold_rich(&p(&lines(6))), Some(p(&lines(5))));
        assert_eq!(fold_rich(&p(&"a".repeat(699))), None);
        assert_eq!(fold_rich(&p(&"a".repeat(700))), Some(p(&"a".repeat(699))));
        assert_eq!(fold_rich(&p(&"a".repeat(701))), Some(p(&"a".repeat(700))));
        // Characters, not bytes.
        assert_eq!(fold_rich(&p(&"日".repeat(700))), Some(p(&"日".repeat(699))));
        assert_eq!(fold_rich(&p(&"日".repeat(701))), Some(p(&"日".repeat(700))));
        // Both limits at once: the cut is where the first of them is reached.
        let text = format!(
            "{}\n{}\n{}",
            "a".repeat(300),
            "b".repeat(300),
            "c".repeat(300)
        );
        let cut = format!(
            "{}\n{}\n{}",
            "a".repeat(300),
            "b".repeat(300),
            "c".repeat(98)
        );
        assert_eq!(fold_rich(&p(&text)), Some(p(&cut)));
    }

    #[test]
    fn a_folded_text_keeps_its_styles_and_blocks() {
        let span = |text: &str, bold: bool| Span {
            text: text.to_owned(),
            bold,
            ..Span::default()
        };
        let rich = vec![
            RichBlock::Paragraph {
                spans: vec![span("head ", true), span("x\ny", false)],
            },
            RichBlock::Code {
                text: "c1\nc2\nc3\nc4".to_owned(),
            },
            RichBlock::Quote {
                spans: vec![span("never reached", false)],
            },
        ];
        // The break between blocks is a line too: 1 in the paragraph, 1 between, and the code is cut before its 3rd break.
        assert_eq!(
            fold_rich(&rich),
            Some(vec![
                rich[0].clone(),
                RichBlock::Code {
                    text: "c1\nc2\nc3".to_owned()
                },
            ])
        );
        // A cut inside a span leaves the style of its first part, and a block the cut reaches first is dropped.
        let long = vec![RichBlock::Paragraph {
            spans: vec![span(&"a".repeat(699), true), span("bc", false)],
        }];
        assert_eq!(
            fold_rich(&long),
            Some(vec![RichBlock::Paragraph {
                spans: vec![span(&"a".repeat(699), true), span("b", false)],
            }])
        );
    }

    #[test]
    fn an_attachment_keeps_its_full_text_and_folds_a_long_one() {
        let long = attachments(json!([{"text": lines(8)}]));
        assert_eq!(long[0].text, Some(p(&lines(8))));
        assert_eq!(long[0].text_short, Some(p(&lines(5))));
        let short = attachments(json!([{"text": lines(5)}]));
        assert_eq!(short[0].text_short, None);
        let none = attachments(json!([{"title": "t"}]));
        assert_eq!(none[0].text_short, None);
    }

    #[test]
    fn an_empty_attachment_is_nothing() {
        assert_eq!(
            attachments(json!([{}, {"color": "good"}, {"text": "  "}, "x", null])),
            vec![]
        );
        assert_eq!(attachments(Value::Null), vec![]);
        assert_eq!(attachments(json!({})), vec![]);
    }

    #[test]
    fn the_blocks_inside_an_attachment_are_all_drawn_even_rich_text() {
        let list = attachments(json!([{"blocks": [rich_section("inside"), {"type": "divider"}]}]));
        assert_eq!(
            list[0].blocks,
            vec![section("inside"), ThreadBlock::Divider]
        );
    }

    #[test]
    fn the_image_addresses_come_once_each_in_order() {
        let b = blocks(json!([
            {"type": "image", "image_url": "https://a.example/1.png", "alt_text": "a"},
            {"type": "section", "text": {"type": "mrkdwn", "text": "x"}, "accessory": {"type": "image", "image_url": "https://a.example/2.png", "alt_text": "b"}},
            {"type": "context", "elements": [{"type": "image", "image_url": "https://a.example/1.png", "alt_text": "c"}]},
            {"type": "image", "image_url": "http://a.example/3.png", "alt_text": "no"},
        ]));
        let a = attachments(json!([
            {"image_url": "https://a.example/5.png", "thumb_url": "https://a.example/6.png", "blocks": [{"type": "image", "image_url": "https://a.example/4.png", "alt_text": "d"}]},
            {"thumb_url": "https://a.example/5.png"}
        ]));
        assert_eq!(
            image_urls(&b, &a),
            vec![
                "https://a.example/1.png",
                "https://a.example/2.png",
                "https://a.example/5.png",
                "https://a.example/6.png",
                "https://a.example/4.png"
            ]
        );
        assert_eq!(image_urls(&[], &[]), Vec::<String>::new());
    }

    #[test]
    fn the_mentioned_users_come_from_every_text_and_element_once() {
        // (The order is that of the JSON object's keys, so it is sorted here.)
        let m = json!({
            "text": "<@U0> not looked at",
            "blocks": [
                {"type": "section", "text": {"type": "mrkdwn", "text": "hi <@U1> <@U2|bob>"}},
                rich(json!([{"type": "rich_text_section", "elements": [{"type": "user", "user_id": "U3"}, {"type": "user", "user_id": "U1"}]}]))
            ],
            "attachments": [{"text": "cc <@U4>", "fields": [{"title": "t", "value": "<@U5>"}]}]
        });
        let mut found = mentioned_users(&m);
        found.sort();
        assert_eq!(found, vec!["U1", "U2", "U3", "U4", "U5"]);
        // Only the drawn parts are read: not an ID or a URL, and a fallback only when it is what is drawn.
        let m = json!({
            "blocks": [{"type": "actions", "block_id": "<@U6>", "elements": [{"type": "button", "text": {"type": "plain_text", "text": "Go"}, "url": "https://a.example/<@U7>"}]}],
            "attachments": [
                {"text": "x", "fallback": "<@U8>", "callback_id": "<@U9>"},
                {"fallback": "<@U10>"}
            ]
        });
        let mut found = mentioned_users(&m);
        found.sort();
        assert_eq!(found, vec!["U10"]);
        assert_eq!(mentioned_users(&json!({"text": "x"})), Vec::<String>::new());
    }

    /// What `message_plain` reads from a whole message of Slack's JSON, with the text the screen would show.
    fn plain_of(m: Value, text: &str) -> String {
        let draw_rich_text = m["bot"] == true;
        let (b, show_text) = message_blocks(&m["blocks"], draw_rich_text, &|_| None);
        let a = message_attachments(&m["attachments"], &|_| None);
        message_plain(text, show_text, &b, &a)
    }

    #[test]
    fn the_unfurled_addresses_are_those_of_the_attachments_that_unfurl_a_message() {
        let (one, two, three) = (
            "https://example.slack.com/archives/C1/p1",
            "https://example.slack.com/archives/C1/p2",
            "https://slack.com/archives/C1/p3",
        );
        let a = json!([
            {"is_msg_unfurl": true, "from_url": one, "original_url": one},
            {"is_msg_unfurl": true, "from_url": two},
            {"is_msg_unfurl": true, "original_url": three, "from_url": ""},
            {"from_url": "https://example.slack.com/archives/C1/p4", "original_url": "https://example.slack.com/archives/C1/p4"},
            {"is_msg_unfurl": false, "from_url": "https://example.slack.com/archives/C1/p5"},
            {"is_msg_unfurl": true},
        ]);
        assert_eq!(unfurled_urls(&a), [one, two, three]);
        assert!(unfurled_urls(&json!(null)).is_empty());
        assert!(unfurled_urls(&json!([])).is_empty());
    }

    #[test]
    fn only_an_https_address_of_slack_is_an_unfurled_address() {
        let ok = "https://example.slack.com/archives/C1/p1";
        let a = |url: &str| json!([{"is_msg_unfurl": true, "from_url": url, "original_url": url}]);
        assert_eq!(unfurled_urls(&a(ok)), [ok]);
        for bad in [
            "javascript:alert(1)",
            "/archives/C1/p1",
            "archives/C1/p1",
            "//example.slack.com/archives/C1/p1",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "http://example.slack.com/archives/C1/p1",
            "https://evilslack.com/archives/C1/p1",
            "https://slack.com.evil.com/archives/C1/p1",
            "https://example.com/archives/C1/p1",
            "https://user@example.slack.com/archives/C1/p1",
            "https://example.slack.com:8443/archives/C1/p1",
            "ftp://example.slack.com/archives/C1/p1",
        ] {
            assert!(unfurled_urls(&a(bad)).is_empty(), "{bad}");
        }
        // A good address next to a bad one stays.
        let both = json!([
            {"is_msg_unfurl": true, "from_url": "javascript:alert(1)", "original_url": ok},
        ]);
        assert_eq!(unfurled_urls(&both), [ok]);
    }

    #[test]
    fn the_plain_text_of_a_message_is_its_text_only_while_the_screen_draws_it() {
        assert_eq!(plain_of(json!({}), "hi"), "hi");
        // The blocks stand for the text (Slack's alternative text), so the text is not repeated.
        let header =
            json!({"type": "header", "text": {"type": "plain_text", "text": "Deploy done"}});
        assert_eq!(
            plain_of(json!({"blocks": [header.clone()]}), "alt text"),
            "Deploy done"
        );
        // A block that could not be drawn sits beside a drawn one: the text is shown too.
        assert_eq!(
            plain_of(json!({"blocks": [header, {"type": "input"}]}), "alt text"),
            "alt text\nDeploy done"
        );
        assert_eq!(plain_of(json!({}), "  "), "");
    }

    #[test]
    fn the_plain_text_holds_the_text_of_every_drawn_block() {
        let m = json!({"blocks": [
            {"type": "header", "text": {"type": "plain_text", "text": "H"}},
            {"type": "section", "text": {"type": "mrkdwn", "text": "*bold* body"}, "fields": [{"type": "mrkdwn", "text": "f1"}, {"type": "mrkdwn", "text": "f2"}],
             "accessory": {"type": "button", "text": {"type": "plain_text", "text": "Open"}, "url": "https://a.example/x"}},
            {"type": "divider"},
            {"type": "context", "elements": [{"type": "mrkdwn", "text": "ctx"}, {"type": "image", "image_url": "https://a.example/i.png", "alt_text": "icon"}]},
            {"type": "image", "image_url": "https://a.example/p.png", "alt_text": "chart", "title": {"type": "plain_text", "text": "Sales"}},
            {"type": "actions", "elements": [{"type": "button", "text": {"type": "plain_text", "text": "Ok"}}]},
        ]});
        assert_eq!(
            plain_of(m, "alt"),
            "H\nbold body\nf1\nf2\nOpen (https://a.example/x)\nctx\nicon\nchart\nSales\nOk"
        );
    }

    #[test]
    fn the_plain_text_holds_a_quote_with_its_marker_and_a_code_as_it_is() {
        let m = json!({"blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "&gt; q1\n&gt; q2\n```\nlet a = 1;\n```"}}]});
        assert_eq!(plain_of(m, "alt"), "> q1\n> q2\nlet a = 1;");
    }

    #[test]
    fn the_plain_text_holds_the_text_of_an_attachment() {
        let m = json!({"attachments": [{
            "pretext": "pre", "author_name": "Bot", "title": "Issue 1", "title_link": "https://a.example/1", "text": "body",
            "fields": [{"title": "Status", "value": "open"}, {"title": "", "value": "lone"}, {"title": "OnlyTitle", "value": ""}],
            "footer": "foot", "actions": [{"type": "button", "text": "Go", "url": "https://a.example/go"}],
            "image_url": "https://a.example/i.png", "thumb_url": "https://a.example/t.png", "fallback": "card"
        }]});
        assert_eq!(
            plain_of(m, "alt"),
            "alt\npre\nBot\nIssue 1 (https://a.example/1)\nbody\nStatus: open\nlone\nOnlyTitle\nfoot\nGo (https://a.example/go)\ncard"
        );
    }

    #[test]
    fn the_plain_text_of_an_attachment_with_only_a_fallback_is_the_fallback() {
        assert_eq!(
            plain_of(json!({"attachments": [{"fallback": "only this"}]}), "t"),
            "t\nonly this"
        );
        // An attachment with nothing to draw adds nothing.
        assert_eq!(
            plain_of(json!({"attachments": [{"color": "good"}]}), "t"),
            "t"
        );
    }
}
