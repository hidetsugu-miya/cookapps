//! Sends a mail with Gmail's `users.messages.send`: builds the RFC 5322 message, checks what goes into its headers
//! and, for a reply, takes the threading headers from the thread's last message.

use std::path::Path;

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE},
    Engine,
};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
#[cfg(test)]
use ts_rs::TS;

use crate::auth::{config_dir, Auth};
use crate::gmail::{log_failure, send_json_refreshing, thread_url, ApiError};
use crate::mail_address::split_address;
use crate::markdown_patch::is_empty_paragraph;

const SEND_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
/// An encoded-word holds at most 75 characters; 42 bytes become 56 characters of base64, 68 with the frame.
const WORD_BYTES: usize = 42;
/// A header line is kept to this length when it is folded (RFC 5322 recommends 78).
const FOLD_AT: usize = 76;
/// A plain subject longer than this is sent as encoded-words too, so that its line stays under the 998 of RFC 5322.
const MAX_PLAIN_SUBJECT: usize = 900;

/// A mail to send, as the screen gives it. `to`, `cc` and `bcc` hold one mailbox each: `addr` or `Name <addr>`.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMail {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    /// Plain text, or Markdown when `markdown` is true.
    pub body: String,
    /// `true`: `body` is Markdown, and the mail goes out as `multipart/alternative`, the Markdown as it is and the HTML made from it.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub markdown: Option<bool>,
    /// The thread this mail answers: it gets the thread's ID, `In-Reply-To`, `References` and a `Re:` subject.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub reply_thread_id: Option<String>,
}

/// What of a mail passed the checks, ready to go into the headers.
#[derive(Debug)]
struct Checked {
    from: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    body: String,
    markdown: bool,
}

/// The headers that put a reply in its thread.
#[derive(Debug, PartialEq)]
struct ReplyHeaders {
    in_reply_to: String,
    references: Vec<String>,
}

fn has_break_or_control(s: &str) -> bool {
    s.chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
}

/// The first 100 characters, for an error message.
fn shown(s: &str) -> String {
    s.chars().take(100).collect()
}

/// A plain `local@domain`: ASCII, no quoting, no comment and no internationalized part.
pub(crate) fn valid_address(addr: &str) -> bool {
    let Some((local, domain)) = addr.split_once('@') else {
        return false;
    };
    let local_ok = !local.is_empty()
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+/=?^_`{|}~.-".contains(c));
    let domain_ok = !domain.is_empty()
        && domain.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    local_ok && domain_ok
}

/// `text` as RFC 2047 encoded-words (UTF-8, base64), folded between the words.
fn encode_words(text: &str) -> String {
    let mut words = Vec::new();
    let mut chunk = String::new();
    for c in text.chars() {
        if chunk.len() + c.len_utf8() > WORD_BYTES {
            words.push(std::mem::take(&mut chunk));
        }
        chunk.push(c);
    }
    if !chunk.is_empty() {
        words.push(chunk);
    }
    words
        .iter()
        .map(|w| format!("=?UTF-8?B?{}?=", STANDARD.encode(w)))
        .collect::<Vec<_>>()
        .join("\r\n ")
}

/// One recipient as a header-ready mailbox. A name that is not ASCII is encoded, any other is quoted.
fn format_mailbox(entry: &str) -> Result<String, String> {
    if has_break_or_control(entry) {
        return Err("宛先に改行や制御文字は使えません".into());
    }
    let parts = split_address(entry);
    let address = parts.address.trim();
    if !valid_address(address) {
        return Err(format!("宛先の形式が正しくありません: {}", shown(entry)));
    }
    let name = parts.name.trim();
    Ok(if name.is_empty() {
        address.to_owned()
    } else if name.is_ascii() {
        let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\" <{address}>")
    } else {
        format!("{} <{address}>", encode_words(name))
    })
}

fn format_mailboxes(entries: &[String]) -> Result<Vec<String>, String> {
    entries.iter().map(|e| format_mailbox(e)).collect()
}

/// The subject as a header value, encoded when it is not plain ASCII.
fn format_subject(subject: &str) -> Result<String, String> {
    if has_break_or_control(subject) {
        return Err("件名に改行や制御文字は使えません".into());
    }
    Ok(
        if subject.is_ascii() && subject.len() <= MAX_PLAIN_SUBJECT {
            subject.to_owned()
        } else {
            encode_words(subject)
        },
    )
}

/// `Re: ` in front of the subject, unless it has one already.
fn reply_subject(subject: &str) -> String {
    let trimmed = subject.trim_start();
    if trimmed
        .get(..3)
        .is_some_and(|p| p.eq_ignore_ascii_case("re:"))
    {
        trimmed.to_owned()
    } else {
        format!("Re: {trimmed}")
    }
}

/// Checks everything the screen gave, before anything is asked of Gmail.
fn check(account: &str, mail: &OutgoingMail) -> Result<Checked, String> {
    let from =
        format_mailbox(account).map_err(|_| "差出人のアドレスが正しくありません".to_owned())?;
    if mail.to.len() + mail.cc.len() + mail.bcc.len() == 0 {
        return Err("宛先がありません".into());
    }
    if let Some(id) = &mail.reply_thread_id {
        thread_url(id, None)?;
    }
    let subject = if mail.reply_thread_id.is_some() {
        reply_subject(&mail.subject)
    } else {
        mail.subject.clone()
    };
    Ok(Checked {
        from,
        to: format_mailboxes(&mail.to)?,
        cc: format_mailboxes(&mail.cc)?,
        bcc: format_mailboxes(&mail.bcc)?,
        subject: format_subject(&subject)?,
        body: mail.body.clone(),
        markdown: mail.markdown.unwrap_or(false),
    })
}

/// `<id>` of a Message-ID: ASCII with no space, control character or inner angle bracket.
fn valid_message_id(id: &str) -> bool {
    id.len() > 2
        && id.starts_with('<')
        && id.ends_with('>')
        && id[1..id.len() - 1]
            .chars()
            .all(|c| c.is_ascii_graphic() && c != '<' && c != '>')
}

/// The IDs of a References header that are well formed; the rest are left out.
fn valid_ids(references: &str) -> impl Iterator<Item = &str> {
    references
        .split_whitespace()
        .filter(|t| valid_message_id(t))
}

#[derive(Deserialize)]
struct ReplyThread {
    #[serde(default)]
    messages: Vec<ReplyMessage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplyMessage {
    #[serde(default)]
    label_ids: Vec<String>,
    #[serde(default)]
    payload: ReplyPayload,
}

#[derive(Deserialize, Default)]
struct ReplyPayload {
    #[serde(default)]
    headers: Vec<ReplyHeader>,
}

#[derive(Deserialize)]
struct ReplyHeader {
    name: String,
    value: String,
}

impl ReplyMessage {
    fn header(&self, name: &str) -> Option<&str> {
        self.payload
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str())
    }
}

/// The headers of a reply to the last message of the thread that is not a draft: its Message-ID,
/// and its References followed by that Message-ID. The values come from a received mail, so each is checked.
fn reply_headers(messages: &[ReplyMessage]) -> Result<ReplyHeaders, String> {
    let last = messages
        .iter()
        .rev()
        .find(|m| !m.label_ids.iter().any(|l| l == "DRAFT"))
        .ok_or("返信先のメッセージがありません")?;
    let id = last
        .header("Message-ID")
        .map(str::trim)
        .filter(|id| valid_message_id(id))
        .ok_or("返信先のメッセージ ID を読めません")?;
    let mut references: Vec<String> = last
        .header("References")
        .map(|r| valid_ids(r).map(str::to_owned).collect())
        .unwrap_or_default();
    if references.last().map(String::as_str) != Some(id) {
        references.push(id.to_owned());
    }
    Ok(ReplyHeaders {
        in_reply_to: id.to_owned(),
        references,
    })
}

/// The IDs after `References: `, folded between IDs so that no line is longer than `FOLD_AT`.
fn fold_ids(ids: &[String]) -> String {
    let mut out = String::new();
    let mut line = "References:".len();
    for id in ids {
        if line + 1 + id.len() > FOLD_AT && line > 1 {
            out.push_str("\r\n ");
            line = 1;
        } else if !out.is_empty() {
            out.push(' ');
            line += 1;
        }
        out.push_str(id);
        line += id.len();
    }
    out
}

/// A recipient header: one mailbox on each line.
fn recipients(name: &str, list: &[String]) -> Option<String> {
    (!list.is_empty()).then(|| format!("{name}: {}\r\n", list.join(",\r\n ")))
}

/// The body with CRLF line ends, as base64 in lines of 76 characters.
fn encode_body(body: &str) -> String {
    let mut text = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                chars.next_if_eq(&'\n');
                text.push_str("\r\n");
            }
            '\n' => text.push_str("\r\n"),
            c => text.push(c),
        }
    }
    let encoded = STANDARD.encode(text);
    encoded
        .as_bytes()
        .chunks(76)
        .map(|l| String::from_utf8_lossy(l).into_owned() + "\r\n")
        .collect()
}

/// The boundary of `multipart/alternative`. The parts are base64, whose lines never hold a `-`, so no body can contain it.
const BOUNDARY: &str = "tsunagiai-alternative";

fn escape_html(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
}

/// Only these links keep their anchor; `javascript:`, `data:` and the like are left as the text of the link.
fn link_allowed(url: &str) -> bool {
    let url = url.trim_start().to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| url.starts_with(scheme))
}

/// The HTML part: Markdown with strikethrough, and a raw HTML tag in it written out as text, not passed on as a tag.
/// An image is left as its alt text.
fn markdown_to_html(markdown: &str) -> String {
    let mut out = String::from("<html><body>");
    let mut link_open = false;
    for event in Parser::new_ext(markdown, Options::ENABLE_STRIKETHROUGH) {
        match event {
            Event::Html(text) if is_empty_paragraph(&text) => out.push_str("<p><br></p>\n"),
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => {
                escape_html(&text, &mut out)
            }
            Event::Code(text) => {
                out.push_str("<code>");
                escape_html(&text, &mut out);
                out.push_str("</code>");
            }
            Event::SoftBreak => out.push('\n'),
            Event::HardBreak => out.push_str("<br>\n"),
            Event::Rule => out.push_str("<hr>\n"),
            Event::Start(tag) => match tag {
                Tag::Paragraph => out.push_str("<p>"),
                Tag::Heading { level, .. } => out.push_str(&format!("<h{}>", level as usize)),
                Tag::BlockQuote(_) => out.push_str("<blockquote>\n"),
                Tag::CodeBlock(_) => out.push_str("<pre><code>"),
                Tag::List(Some(1)) => out.push_str("<ol>\n"),
                Tag::List(Some(start)) => out.push_str(&format!("<ol start=\"{start}\">\n")),
                Tag::List(None) => out.push_str("<ul>\n"),
                Tag::Item => out.push_str("<li>"),
                Tag::Emphasis => out.push_str("<em>"),
                Tag::Strong => out.push_str("<strong>"),
                Tag::Strikethrough => out.push_str("<del>"),
                Tag::Link { dest_url, .. } if link_allowed(&dest_url) => {
                    link_open = true;
                    out.push_str("<a href=\"");
                    escape_html(&dest_url, &mut out);
                    out.push_str("\">");
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => out.push_str("</p>\n"),
                TagEnd::Heading(level) => out.push_str(&format!("</h{}>\n", level as usize)),
                TagEnd::BlockQuote(_) => out.push_str("</blockquote>\n"),
                TagEnd::CodeBlock => out.push_str("</code></pre>\n"),
                TagEnd::List(true) => out.push_str("</ol>\n"),
                TagEnd::List(false) => out.push_str("</ul>\n"),
                TagEnd::Item => out.push_str("</li>\n"),
                TagEnd::Emphasis => out.push_str("</em>"),
                TagEnd::Strong => out.push_str("</strong>"),
                TagEnd::Strikethrough => out.push_str("</del>"),
                TagEnd::Link if link_open => {
                    link_open = false;
                    out.push_str("</a>");
                }
                _ => {}
            },
            _ => {}
        }
    }
    out.push_str("</body></html>");
    out
}

/// The text part: the Markdown as it is, except that an empty paragraph of the editor (`<br />` alone in its block) is left out, so that it is one more blank line and not the text of a tag.
fn plain_text(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut at = 0;
    for (event, range) in
        Parser::new_ext(markdown, Options::ENABLE_STRIKETHROUGH).into_offset_iter()
    {
        if matches!(&event, Event::Html(text) if is_empty_paragraph(text)) {
            out.push_str(&markdown[at..range.start]);
            at = range.end;
        }
    }
    out.push_str(&markdown[at..]);
    out
}

/// One MIME part: its headers, a blank line and the text as base64.
fn text_part(subtype: &str, text: &str) -> String {
    format!(
        "Content-Type: text/{subtype}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}",
        encode_body(text)
    )
}

/// The RFC 5322 message.
fn render(c: &Checked, reply: Option<&ReplyHeaders>) -> String {
    let mut m = format!("From: {}\r\n", c.from);
    m += &recipients("To", &c.to).unwrap_or_default();
    m += &recipients("Cc", &c.cc).unwrap_or_default();
    m += &recipients("Bcc", &c.bcc).unwrap_or_default();
    m += &format!("Subject: {}\r\n", c.subject);
    if let Some(r) = reply {
        m += &format!("In-Reply-To: {}\r\n", r.in_reply_to);
        m += &format!("References: {}\r\n", fold_ids(&r.references));
    }
    m += "MIME-Version: 1.0\r\n";
    if c.markdown {
        m += &format!("Content-Type: multipart/alternative; boundary=\"{BOUNDARY}\"\r\n\r\n");
        m += &format!(
            "--{BOUNDARY}\r\n{}",
            text_part("plain", &plain_text(&c.body))
        );
        m += &format!(
            "--{BOUNDARY}\r\n{}",
            text_part("html", &markdown_to_html(&c.body))
        );
        m += &format!("--{BOUNDARY}--\r\n");
    } else {
        m += &text_part("plain", &c.body);
    }
    m
}

/// The body of the `messages.send` request.
fn send_body(message: &str, thread_id: Option<&str>) -> Value {
    let mut body = json!({"raw": URL_SAFE.encode(message)});
    if let Some(id) = thread_id {
        body["threadId"] = json!(id);
    }
    body
}

/// `Ok(None)` means `account` must log in again.
async fn fetch_reply_headers(
    dir: &Path,
    auth: &Auth,
    account: &str,
    thread_id: &str,
) -> Result<Option<ReplyHeaders>, ApiError> {
    let url = thread_url(thread_id, None)?;
    let query = [
        ("format", "metadata"),
        ("metadataHeaders", "Message-ID"),
        ("metadataHeaders", "References"),
    ];
    let Some(thread) =
        send_json_refreshing::<ReplyThread>(dir, auth, account, Method::GET, &url, &query, None)
            .await?
    else {
        return Ok(None);
    };
    Ok(Some(reply_headers(&thread.messages)?))
}

/// Sends the mail from `account`. `Ok(None)` means `account` must log in again.
pub async fn send(
    dir: &Path,
    auth: &Auth,
    account: &str,
    mail: &OutgoingMail,
) -> Result<Option<bool>, ApiError> {
    let checked = check(account, mail)?;
    let reply = match &mail.reply_thread_id {
        Some(id) => match fetch_reply_headers(dir, auth, account, id).await? {
            Some(headers) => Some(headers),
            None => return Ok(None),
        },
        None => None,
    };
    let body = send_body(
        &render(&checked, reply.as_ref()),
        mail.reply_thread_id.as_deref(),
    );
    let sent = send_json_refreshing::<serde::de::IgnoredAny>(
        dir,
        auth,
        account,
        Method::POST,
        SEND_URL,
        &[],
        Some(&body),
    )
    .await?;
    // `true`, not `()`: `Some(())` reaches JS as null, the same as `None` (login required).
    Ok(sent.map(|_| true))
}

#[tauri::command]
pub async fn send_mail(
    app: AppHandle,
    auth: State<'_, Auth>,
    account: String,
    mail: OutgoingMail,
) -> Result<Option<bool>, String> {
    let dir = config_dir(&app).map_err(|e| log_failure("send_mail", &account, e))?;
    send(&dir, &auth, &account, &mail)
        .await
        .map_err(|e| log_failure("send_mail", &account, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(to: &[&str], subject: &str, body: &str) -> OutgoingMail {
        OutgoingMail {
            to: to.iter().map(|s| s.to_string()).collect(),
            cc: vec![],
            bcc: vec![],
            subject: subject.into(),
            body: body.into(),
            markdown: None,
            reply_thread_id: None,
        }
    }

    /// The mail parts of a multipart message: each one's unfolded header lines and its decoded body.
    fn parts(message: &str, boundary: &str) -> Vec<(Vec<String>, String)> {
        let body = message.split_once("\r\n\r\n").unwrap().1;
        let delimiter = format!("--{boundary}");
        let mut pieces = body.split(delimiter.as_str());
        assert_eq!(pieces.next(), Some(""));
        let mut out = Vec::new();
        for piece in pieces {
            if piece == "--\r\n" {
                return out;
            }
            let (head, b64) = piece
                .strip_prefix("\r\n")
                .unwrap()
                .split_once("\r\n\r\n")
                .unwrap();
            let b64: String = b64.split("\r\n").collect();
            out.push((
                head.split("\r\n").map(str::to_owned).collect(),
                String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap(),
            ));
        }
        panic!("no closing delimiter");
    }

    fn build(
        account: &str,
        m: &OutgoingMail,
        reply: Option<&ReplyHeaders>,
    ) -> Result<String, String> {
        Ok(render(&check(account, m)?, reply))
    }

    /// The lines of the header part, unfolded.
    fn headers(message: &str) -> Vec<String> {
        let head = message.split("\r\n\r\n").next().unwrap();
        let mut out: Vec<String> = Vec::new();
        for line in head.split("\r\n") {
            if line.starts_with(' ') {
                out.last_mut().unwrap().push_str(line);
            } else {
                out.push(line.to_owned());
            }
        }
        out
    }

    fn body_of(message: &str) -> String {
        let b64: String = message
            .split("\r\n\r\n")
            .nth(1)
            .unwrap()
            .split("\r\n")
            .collect();
        String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap()
    }

    /// Reads encoded-words back (UTF-8, base64), as a mail reader does.
    fn decode_words(value: &str) -> String {
        value
            .split_whitespace()
            .map(|w| {
                let b64 = w
                    .strip_prefix("=?UTF-8?B?")
                    .and_then(|w| w.strip_suffix("?="))
                    .expect("an encoded-word");
                String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap()
            })
            .collect()
    }

    fn reply_message(json: Value) -> ReplyMessage {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn builds_a_plain_message() {
        let mut m = mail(
            &["a@example.com", "Bob <b@example.com>"],
            "Hello",
            "line1\nline2",
        );
        m.cc = vec!["c@example.com".into()];
        m.bcc = vec!["d@example.com".into()];
        let message = build("me@example.com", &m, None).unwrap();
        assert_eq!(
            headers(&message),
            [
                "From: me@example.com",
                "To: a@example.com, \"Bob\" <b@example.com>",
                "Cc: c@example.com",
                "Bcc: d@example.com",
                "Subject: Hello",
                "MIME-Version: 1.0",
                "Content-Type: text/plain; charset=UTF-8",
                "Content-Transfer-Encoding: base64",
            ]
        );
        assert_eq!(body_of(&message), "line1\r\nline2");
        assert!(message.ends_with("\r\n"));
    }

    #[test]
    fn leaves_out_cc_and_bcc_that_are_empty() {
        let message = build("me@example.com", &mail(&["a@example.com"], "s", ""), None).unwrap();
        assert!(!message.contains("Cc:") && !message.contains("Bcc:"));
        assert_eq!(body_of(&message), "");
    }

    #[test]
    fn a_mail_with_only_bcc_has_a_recipient() {
        let mut m = mail(&[], "s", "b");
        m.bcc = vec!["d@example.com".into()];
        assert!(build("me@example.com", &m, None).is_ok());
    }

    #[test]
    fn body_line_ends_become_crlf_and_the_base64_is_wrapped() {
        let long = "あ".repeat(200);
        let m = mail(&["a@example.com"], "s", &format!("x\r\ny\rz\n{long}"));
        let message = build("me@example.com", &m, None).unwrap();
        assert_eq!(body_of(&message), format!("x\r\ny\r\nz\r\n{long}"));
        let encoded = message.split("\r\n\r\n").nth(1).unwrap();
        assert!(encoded.split("\r\n").all(|l| l.len() <= 76));
    }

    #[test]
    fn a_subject_that_is_not_ascii_is_encoded_in_short_words() {
        let subject = "【お知らせ】".repeat(20);
        let m = mail(&["a@example.com"], &subject, "b");
        let message = build("me@example.com", &m, None).unwrap();
        let line = headers(&message)
            .into_iter()
            .find(|l| l.starts_with("Subject: "))
            .unwrap();
        assert!(message.contains("Subject: =?UTF-8?B?"));
        assert_eq!(
            decode_words(line.strip_prefix("Subject: ").unwrap()),
            subject
        );
        let raw_lines: Vec<&str> = message.split("\r\n").collect();
        assert!(raw_lines.iter().all(|l| l.len() <= 78), "{raw_lines:?}");
        assert!(raw_lines
            .iter()
            .flat_map(|l| l.split_whitespace())
            .filter(|w| w.starts_with("=?"))
            .all(|w| w.len() <= 75));
    }

    #[test]
    fn a_name_is_quoted_or_encoded() {
        assert_eq!(
            format_mailbox("a\"b\\c <a@example.com>").unwrap(),
            "\"a\\\"b\\\\c\" <a@example.com>"
        );
        assert_eq!(
            format_mailbox("Tom, Jr. <a@example.com>").unwrap(),
            "\"Tom, Jr.\" <a@example.com>"
        );
        let encoded = format_mailbox("山田 太郎 <a@example.com>").unwrap();
        let (name, address) = encoded.rsplit_once(" <").unwrap();
        assert_eq!(address, "a@example.com>");
        assert_eq!(decode_words(name), "山田 太郎");
        assert_eq!(format_mailbox(" a@example.com ").unwrap(), "a@example.com");
        assert_eq!(format_mailbox("<a@example.com>").unwrap(), "a@example.com");
    }

    #[test]
    fn refuses_addresses_that_are_not_one_plain_mailbox() {
        for bad in [
            "",
            "   ",
            "plain",
            "a@",
            "@example.com",
            "a b@example.com",
            "a@exam ple.com",
            "a@example.com, b@example.com",
            "a@example.com;b@example.com",
            "Name <a@example.com> x",
            "<a@example.com",
            "a@@example.com",
            "a..b@example.com",
            ".a@example.com",
            "a@-example.com",
            "a@example..com",
            "\"a b\"@example.com",
            "日本語@example.com",
            "a@例え.jp",
        ] {
            assert!(format_mailbox(bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn refuses_line_breaks_in_every_header_field() {
        let acct = "me@example.com";
        for bad in [
            "a@example.com\r\nBcc: x@example.com",
            "a@example.com\nBcc: x@example.com",
            "a@example.com\rX: y",
            "Name\r\nBcc: x@example.com <a@example.com>",
            "Name\u{2028}x <a@example.com>",
            "a@example.com\0",
        ] {
            let m = mail(&[bad], "s", "b");
            assert!(build(acct, &m, None).is_err(), "{bad:?} was accepted");
        }
        for bad in [
            "a\r\nBcc: x@example.com",
            "a\nb",
            "a\rb",
            "a\u{85}b",
            "a\0b",
            "a\u{2029}b",
        ] {
            let m = mail(&["a@example.com"], bad, "b");
            assert!(build(acct, &m, None).is_err(), "{bad:?} was accepted");
            let mut m = mail(&["a@example.com"], "s", "b");
            m.cc = vec![bad.into()];
            assert!(build(acct, &m, None).is_err());
            m.cc = vec![];
            m.bcc = vec![bad.into()];
            assert!(build(acct, &m, None).is_err());
        }
        assert!(build(
            "me@example.com\r\nBcc: x@example.com",
            &mail(&["a@example.com"], "s", "b"),
            None
        )
        .is_err());
    }

    #[test]
    fn a_line_break_in_the_body_is_data() {
        let m = mail(
            &["a@example.com"],
            "s",
            "x\r\nBcc: evil@example.com\r\n\r\ny",
        );
        let message = build("me@example.com", &m, None).unwrap();
        assert!(!message.contains("evil"));
        assert_eq!(body_of(&message), "x\r\nBcc: evil@example.com\r\n\r\ny");
    }

    #[test]
    fn refuses_a_mail_with_no_recipient() {
        let e = build("me@example.com", &mail(&[], "s", "b"), None).unwrap_err();
        assert_eq!(e, "宛先がありません");
    }

    #[test]
    fn refuses_a_reply_thread_id_that_is_not_one() {
        let mut m = mail(&["a@example.com"], "s", "b");
        for bad in ["", "abc/def", "abc?x=1", "../x"] {
            m.reply_thread_id = Some(bad.into());
            assert_eq!(
                check("me@example.com", &m).unwrap_err(),
                "スレッド ID が不正です"
            );
        }
    }

    #[test]
    fn a_reply_subject_gets_re_once() {
        assert_eq!(reply_subject("Hello"), "Re: Hello");
        assert_eq!(reply_subject("Re: Hello"), "Re: Hello");
        assert_eq!(reply_subject("RE: Hello"), "RE: Hello");
        assert_eq!(reply_subject("re:Hello"), "re:Hello");
        assert_eq!(reply_subject("Research"), "Re: Research");
        assert_eq!(reply_subject("あ"), "Re: あ");
        assert_eq!(reply_subject(""), "Re: ");
    }

    #[test]
    fn a_reply_carries_the_subject_and_the_threading_headers() {
        let mut m = mail(&["a@example.com"], "Hello", "b");
        m.reply_thread_id = Some("18c0ffee".into());
        let reply = ReplyHeaders {
            in_reply_to: "<2@x>".into(),
            references: vec!["<1@x>".into(), "<2@x>".into()],
        };
        let message = build("me@example.com", &m, Some(&reply)).unwrap();
        let h = headers(&message);
        assert!(h.contains(&"Subject: Re: Hello".to_owned()));
        assert!(h.contains(&"In-Reply-To: <2@x>".to_owned()));
        assert!(h.contains(&"References: <1@x> <2@x>".to_owned()));
    }

    #[test]
    fn the_references_of_a_long_thread_are_folded() {
        let ids: Vec<String> = (0..40)
            .map(|i| format!("<{i:030}@mail.example.com>"))
            .collect();
        let folded = fold_ids(&ids);
        let lines: Vec<&str> = folded.split("\r\n").collect();
        assert!(lines.len() > 1);
        assert!(lines[0].len() + "References: ".len() <= 78);
        assert!(lines[1..]
            .iter()
            .all(|l| l.starts_with(' ') && l.len() <= 78));
        let joined: Vec<&str> = folded.split_whitespace().collect();
        assert_eq!(joined, ids.iter().map(String::as_str).collect::<Vec<_>>());
    }

    #[test]
    fn replies_to_the_last_message_that_is_not_a_draft() {
        let messages = vec![
            reply_message(json!({"payload": {"headers": [
                {"name": "Message-ID", "value": "<1@x>"}]}})),
            reply_message(json!({"payload": {"headers": [
                {"name": "Message-Id", "value": " <2@x> "},
                {"name": "references", "value": "<1@x>\r\n <0@x>"}]}})),
            reply_message(json!({"labelIds": ["DRAFT"], "payload": {"headers": [
                {"name": "Message-ID", "value": "<3@x>"}]}})),
        ];
        assert_eq!(
            reply_headers(&messages).unwrap(),
            ReplyHeaders {
                in_reply_to: "<2@x>".into(),
                references: vec!["<1@x>".into(), "<0@x>".into(), "<2@x>".into()],
            }
        );
    }

    #[test]
    fn a_reply_to_a_message_without_references_starts_them() {
        let messages = vec![reply_message(json!({"payload": {"headers": [
            {"name": "Message-ID", "value": "<1@x>"}]}}))];
        let h = reply_headers(&messages).unwrap();
        assert_eq!(h.references, vec!["<1@x>".to_owned()]);
    }

    #[test]
    fn the_message_id_is_not_added_to_references_twice() {
        let messages = vec![reply_message(json!({"payload": {"headers": [
            {"name": "Message-ID", "value": "<1@x>"},
            {"name": "References", "value": "<0@x> <1@x>"}]}}))];
        assert_eq!(
            reply_headers(&messages).unwrap().references,
            vec!["<0@x>".to_owned(), "<1@x>".to_owned()]
        );
    }

    #[test]
    fn ids_from_a_received_mail_cannot_inject_a_header() {
        // A References token that is not one well-formed ID is dropped.
        let messages = vec![reply_message(json!({"payload": {"headers": [
            {"name": "Message-ID", "value": "<1@x>"},
            {"name": "References", "value": "<ok@x> <a>b@x> <x@y>\r\nBcc: evil@example.com <z@x>"}]}}))];
        let h = reply_headers(&messages).unwrap();
        assert_eq!(h.references, ["<ok@x>", "<x@y>", "<z@x>", "<1@x>"]);
        // A Message-ID that is not one is an error.
        for bad in [
            "<1@x>\r\nBcc: evil@example.com",
            "<1@x> <2@x>",
            "1@x",
            "<>",
            "<a b@x>",
            "<<a@x>",
            "<é@x>",
            "",
        ] {
            let messages = vec![reply_message(json!({"payload": {"headers": [
                {"name": "Message-ID", "value": bad}]}}))];
            assert_eq!(
                reply_headers(&messages).unwrap_err(),
                "返信先のメッセージ ID を読めません",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_thread_with_no_message_to_answer_is_an_error() {
        assert_eq!(
            reply_headers(&[]).unwrap_err(),
            "返信先のメッセージがありません"
        );
        let draft = vec![reply_message(
            json!({"labelIds": ["DRAFT"], "payload": {"headers": [
            {"name": "Message-ID", "value": "<1@x>"}]}}),
        )];
        assert_eq!(
            reply_headers(&draft).unwrap_err(),
            "返信先のメッセージがありません"
        );
        let no_id = vec![reply_message(json!({}))];
        assert_eq!(
            reply_headers(&no_id).unwrap_err(),
            "返信先のメッセージ ID を読めません"
        );
    }

    #[test]
    fn the_request_holds_the_message_and_the_thread() {
        let body = send_body("From: a\r\n\r\nx", Some("18c0ffee"));
        assert_eq!(body["threadId"], "18c0ffee");
        let raw = URL_SAFE.decode(body["raw"].as_str().unwrap()).unwrap();
        assert_eq!(raw, b"From: a\r\n\r\nx");
        assert!(send_body("x", None).get("threadId").is_none());
    }

    /// Accepts one connection, answers `response`, and returns the request it read.
    fn serve_once(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/gmail/v1/users/me/messages/send",
            listener.local_addr().unwrap()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).into_owned();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (url, handle)
    }

    fn post(url: &str, body: &Value) -> Result<Option<serde::de::IgnoredAny>, ApiError> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(crate::gmail::send_json(
                &reqwest::Client::new(),
                Method::POST,
                "token",
                url,
                &[],
                Some(body),
                0,
            ))
    }

    #[test]
    fn posts_the_message_to_the_send_endpoint() {
        let mut m = mail(&["a@example.com"], "件名", "本文");
        m.reply_thread_id = Some("18c0ffee".into());
        let reply = ReplyHeaders {
            in_reply_to: "<1@x>".into(),
            references: vec!["<1@x>".into()],
        };
        let message = build("me@example.com", &m, Some(&reply)).unwrap();
        let (url, server) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 41\r\nConnection: close\r\n\r\n{\"id\":\"1\",\"threadId\":\"18c0ffee\",\"x\":[]}  ",
        );
        let done = post(&url, &send_body(&message, Some("18c0ffee"))).unwrap();
        assert!(done.is_some());
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /gmail/v1/users/me/messages/send HTTP/1.1\r\n"));
        assert!(
            request.contains("authorization: Bearer token")
                || request.contains("Authorization: Bearer token")
        );
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["threadId"], "18c0ffee");
        let raw =
            String::from_utf8(URL_SAFE.decode(body["raw"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(raw, message);
    }

    #[test]
    fn a_refused_send_is_an_error() {
        let (url, server) = serve_once(
            "HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        let e = post(&url, &send_body("x", None)).unwrap_err();
        assert_eq!(e.status, Some(400));
        server.join().unwrap();
    }

    fn html_of(markdown: &str) -> String {
        let html = markdown_to_html(markdown);
        html.strip_prefix("<html><body>")
            .and_then(|h| h.strip_suffix("</body></html>"))
            .expect("wrapped in html and body")
            .to_owned()
    }

    #[test]
    fn a_markdown_mail_is_multipart_alternative_with_text_then_html() {
        let mut m = mail(&["a@example.com"], "s", "**太字** と\nline");
        m.markdown = Some(true);
        let message = build("me@example.com", &m, None).unwrap();
        let h = headers(&message);
        assert!(h.contains(&"MIME-Version: 1.0".to_owned()));
        let content_type = h.iter().find(|l| l.starts_with("Content-Type:")).unwrap();
        let boundary = content_type
            .strip_prefix("Content-Type: multipart/alternative; boundary=\"")
            .and_then(|b| b.strip_suffix('"'))
            .expect("multipart/alternative with a boundary");
        assert!(message.ends_with(&format!("--{boundary}--\r\n")));
        let parts = parts(&message, boundary);
        assert_eq!(parts.len(), 2);
        let part_headers = |ct: &str| {
            vec![
                format!("Content-Type: {ct}; charset=UTF-8"),
                "Content-Transfer-Encoding: base64".to_owned(),
            ]
        };
        assert_eq!(parts[0].0, part_headers("text/plain"));
        assert_eq!(parts[0].1, "**太字** と\r\nline");
        assert_eq!(parts[1].0, part_headers("text/html"));
        assert_eq!(
            parts[1].1,
            "<html><body><p><strong>太字</strong> と\r\nline</p>\r\n</body></html>"
        );
    }

    #[test]
    fn the_boundary_cannot_appear_in_the_encoded_parts() {
        let mut m = mail(&["a@example.com"], "s", "--tsunagiai-alternative\n--");
        m.markdown = Some(true);
        let message = build("me@example.com", &m, None).unwrap();
        let boundary = "tsunagiai-alternative";
        assert_eq!(parts(&message, boundary).len(), 2);
        assert_eq!(message.matches(&format!("--{boundary}")).count(), 3);
    }

    #[test]
    fn a_markdown_mail_with_an_empty_body_still_has_two_parts() {
        let mut m = mail(&["a@example.com"], "s", "");
        m.markdown = Some(true);
        let message = build("me@example.com", &m, None).unwrap();
        let parts = parts(&message, "tsunagiai-alternative");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].1, "");
    }

    #[test]
    fn markdown_is_off_by_default_in_the_json_of_the_screen() {
        let m: OutgoingMail = serde_json::from_value(
            json!({"to": ["a@example.com"], "subject": "s", "body": "**b**"}),
        )
        .unwrap();
        assert_eq!(m.markdown, None);
        let message = build("me@example.com", &m, None).unwrap();
        assert!(message.contains("Content-Type: text/plain; charset=UTF-8"));
        assert!(!message.contains("multipart"));
        assert_eq!(body_of(&message), "**b**");
    }

    #[test]
    fn markdown_becomes_html() {
        assert_eq!(
            html_of("**bold** and *it*"),
            "<p><strong>bold</strong> and <em>it</em></p>\n"
        );
        assert_eq!(
            html_of("[site](https://example.com/a?b=1&c=\"2\")"),
            "<p><a href=\"https://example.com/a?b=1&amp;c=&quot;2&quot;\">site</a></p>\n"
        );
        assert_eq!(
            html_of("- one\n- two\n"),
            "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n"
        );
        assert_eq!(
            html_of("3. a\n4. b\n"),
            "<ol start=\"3\">\n<li>a</li>\n<li>b</li>\n</ol>\n"
        );
        assert_eq!(html_of("1. a\n"), "<ol>\n<li>a</li>\n</ol>\n");
        assert_eq!(html_of("~~gone~~"), "<p><del>gone</del></p>\n");
        assert_eq!(
            html_of("# T\n\n> q"),
            "<h1>T</h1>\n<blockquote>\n<p>q</p>\n</blockquote>\n"
        );
        assert_eq!(html_of("`a<b`"), "<p><code>a&lt;b</code></p>\n");
        assert_eq!(
            html_of("```\nx < y\n```"),
            "<pre><code>x &lt; y\n</code></pre>\n"
        );
        assert_eq!(html_of("a  \nb\n\n---"), "<p>a<br>\nb</p>\n<hr>\n");
    }

    #[test]
    fn raw_html_in_the_markdown_is_text() {
        assert_eq!(
            html_of("x <script>alert(1)</script> y"),
            "<p>x &lt;script&gt;alert(1)&lt;/script&gt; y</p>\n"
        );
        assert_eq!(
            html_of("<div onclick=\"x\">a</div>\n\nb"),
            "&lt;div onclick=&quot;x&quot;&gt;a&lt;/div&gt;\n<p>b</p>\n"
        );
    }

    #[test]
    fn an_empty_paragraph_of_the_editor_is_a_blank_line_not_the_text_of_a_tag() {
        assert_eq!(
            html_of("A\n\n<br />\n\nB\n"),
            "<p>A</p>\n<p><br></p>\n<p>B</p>\n"
        );
        assert_eq!(html_of("<br>\n\n<BR/>\n"), "<p><br></p>\n<p><br></p>\n");
        assert_eq!(html_of("<br />x"), "<p>&lt;br /&gt;x</p>\n");
        assert_eq!(
            html_of("```\n<br />\n```"),
            "<pre><code>&lt;br /&gt;\n</code></pre>\n"
        );
        assert_eq!(plain_text("A\n\n<br />\n\nB\n"), "A\n\n\nB\n");
        assert_eq!(plain_text("<br>\n\nA"), "\nA");
        assert_eq!(plain_text("```\n<br />\n```"), "```\n<br />\n```");
        assert_eq!(plain_text("x <br /> y"), "x <br /> y");
    }

    #[test]
    fn both_parts_of_a_markdown_mail_leave_the_empty_paragraph_out_of_the_text() {
        let mut m = mail(&["a@example.com"], "s", "A\n\n<br />\n\nB\n");
        m.markdown = Some(true);
        let message = build("me@example.com", &m, None).unwrap();
        let boundary = "tsunagiai-alternative";
        let parts = parts(&message, boundary);
        assert_eq!(parts[0].1, "A\r\n\r\n\r\nB\r\n");
        assert_eq!(
            parts[1].1,
            "<html><body><p>A</p>\r\n<p><br></p>\r\n<p>B</p>\r\n</body></html>"
        );
    }

    #[test]
    fn a_link_that_is_not_http_https_or_mailto_loses_its_anchor() {
        assert_eq!(html_of("[x](javascript:alert(1))"), "<p>x</p>\n");
        assert_eq!(html_of("[x](JaVaScRiPt:alert(1))"), "<p>x</p>\n");
        assert_eq!(html_of("[x](data:text/html,a)"), "<p>x</p>\n");
        assert_eq!(
            html_of("[x](mailto:a@example.com)"),
            "<p><a href=\"mailto:a@example.com\">x</a></p>\n"
        );
        assert_eq!(html_of("![alt](https://example.com/a.png)"), "<p>alt</p>\n");
    }

    #[test]
    fn the_send_url_is_the_messages_send_method() {
        assert_eq!(
            SEND_URL,
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
        );
    }
}
