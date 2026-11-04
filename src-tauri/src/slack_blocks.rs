//! A Slack message's `blocks` (Block Kit) and `attachments` as the structure the thread screen draws (S-11).
//!
//! Pure functions from Slack's JSON: nothing here calls Slack. The text is plain text (`plain_text`), never markup.
//! A button's address is http or https, an image's address is https, and anything else is left out here, so the screen does not decide.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;
#[cfg(test)]
use ts_rs::TS;
use url::Url;

use crate::slack::{emojify, mention_ids, plain_text, unescape, UNKNOWN_NAME};

/// Looks a user up by ID, as `plain_text` does for a mention.
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
    Text { text: String },
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
        text: Option<String>,
        fields: Vec<String>,
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
    value: String,
}

/// An attachment, as drawn. `color` is `#rrggbb` (or `#rgb`); `fallback` is set only when nothing else of the attachment can be drawn.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadAttachment {
    color: Option<String>,
    pretext: Option<String>,
    author_name: Option<String>,
    title: Option<String>,
    title_link: Option<String>,
    text: Option<String>,
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
        "mrkdwn" | "plain_text" => text_of(e, name_of).map(|text| ThreadContext::Text { text }),
        _ => None,
    }
}

/// A text as a section with nothing else in it.
fn paragraph(text: String) -> ThreadBlock {
    ThreadBlock::Section {
        text: Some(text),
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
            let text = text_of(&b["text"], name_of);
            let fields: Vec<String> = items(&b["fields"])
                .iter()
                .filter_map(|f| text_of(f, name_of))
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
            "usergroup" => format!("@{UNKNOWN_NAME}"),
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

fn attachment(a: &Value, name_of: NameOf) -> Option<ThreadAttachment> {
    if !a.is_object() {
        return None;
    }
    let text = |key: &str| text_of(&a[key], name_of);
    let title = text("title");
    let mut out = ThreadAttachment {
        color: color(a["color"].as_str()),
        pretext: text("pretext"),
        author_name: text("author_name"),
        title_link: title
            .as_ref()
            .and_then(|_| http_url(a["title_link"].as_str())),
        title,
        text: text("text"),
        fields: a["fields"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| {
                let (title, value) = (text_of(&f["title"], name_of), text_of(&f["value"], name_of));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn blocks(v: Value) -> Vec<ThreadBlock> {
        message_blocks(&v, false, &|_| None).0
    }

    fn section(text: &str) -> ThreadBlock {
        ThreadBlock::Section {
            text: Some(text.to_owned()),
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
                text: Some("*Project* api (https://a.example/p) <1> 🔥".into()),
                fields: vec!["*When*\nnow".into(), "<b>raw</b> :fire:".into()],
                accessory: Some(ThreadAccessory::Button(ThreadButton {
                    text: "View Job".into(),
                    url: Some("https://a.example/job".into())
                })),
            }]
        );
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
                        text: "built by *bot*".into()
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
                text: Some("x".into()),
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
                pretext: Some("Before link (https://a.example)".into()),
                author_name: Some("CI 🤖".into()),
                title: Some("Job #1".into()),
                title_link: Some("https://a.example/job/1".into()),
                text: Some("Passed & done".into()),
                fields: vec![
                    ThreadField {
                        title: "Project".into(),
                        value: "api".into()
                    },
                    ThreadField {
                        title: "Only title".into(),
                        value: "".into()
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
}
