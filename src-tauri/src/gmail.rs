use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use encoding_rs::{Encoding, UTF_8};
use reqwest::Method;
use serde::{
    de::{DeserializeOwned, IgnoredAny},
    Deserialize, Serialize,
};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tokio::task::JoinSet;

use crate::auth::Auth;

const THREADS_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
const METADATA_QUERY: [(&str, &str); 4] = [
    ("format", "metadata"),
    ("metadataHeaders", "From"),
    ("metadataHeaders", "Subject"),
    ("metadataHeaders", "Date"),
];
// Keeps the burst of threads.get calls small enough for Gmail's per-second quota.
const CONCURRENCY: usize = 10;

#[derive(Deserialize)]
struct ThreadList {
    #[serde(default)]
    threads: Vec<ThreadRef>,
}

#[derive(Deserialize)]
struct ThreadRef {
    id: String,
}

#[derive(Deserialize)]
struct Thread {
    id: String,
    #[serde(default)]
    snippet: String,
    #[serde(default)]
    messages: Vec<Message>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    #[serde(default)]
    label_ids: Vec<String>,
    #[serde(default)]
    internal_date: String,
    #[serde(default)]
    payload: Payload,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Payload {
    #[serde(default)]
    mime_type: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    headers: Vec<Header>,
    #[serde(default)]
    body: PartBody,
    #[serde(default)]
    parts: Vec<Payload>,
}

#[derive(Deserialize, Default)]
struct PartBody {
    #[serde(default)]
    data: String,
}

#[derive(Deserialize)]
struct Header {
    name: String,
    value: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItem {
    id: String,
    /// Email address of the account the thread belongs to.
    account: String,
    from: String,
    subject: String,
    snippet: String,
    date_ms: i64,
    unread: bool,
}

fn header(payload: &Payload, name: &str) -> String {
    payload
        .headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case(name))
        .map(|h| h.value.clone())
        .unwrap_or_default()
}

impl ThreadItem {
    /// Subject comes from the first message, sender and date from the latest one.
    fn new(t: Thread, account: &str) -> Self {
        let first = t.messages.first();
        let last = t.messages.last();
        Self {
            account: account.to_owned(),
            subject: first
                .map(|m| header(&m.payload, "Subject"))
                .unwrap_or_default(),
            from: last.map(|m| header(&m.payload, "From")).unwrap_or_default(),
            date_ms: last.and_then(|m| m.internal_date.parse().ok()).unwrap_or(0),
            unread: t
                .messages
                .iter()
                .any(|m| m.label_ids.iter().any(|l| l == "UNREAD")),
            id: t.id,
            snippet: t.snippet,
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    subject: String,
    messages: Vec<MessageDetail>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    from: String,
    date_ms: i64,
    /// `body` is HTML when true, plain text otherwise.
    html: bool,
    body: String,
}

/// Gmail's format=full usually re-encodes text parts to UTF-8 while keeping the original
/// Content-Type charset (e.g. ISO-2022-JP), so UTF-8 wins and the declared charset is the fallback.
fn decode_part(p: &Payload) -> String {
    // shortcut: undecodable base64 yields an empty part, upgrade if Gmail ever sends such data.
    let bytes = URL_SAFE_NO_PAD
        .decode(p.body.data.trim_end_matches('='))
        .unwrap_or_default();
    let encoding = header(p, "Content-Type")
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("charset"))
        .and_then(|(_, v)| Encoding::for_label(v.trim().trim_matches('"').as_bytes()))
        .unwrap_or(UTF_8);
    // ISO-2022-JP is 7-bit, so it also passes as UTF-8; its escape sequences give it away.
    match std::str::from_utf8(&bytes) {
        Ok(text) if !bytes.contains(&0x1b) => text.to_owned(),
        _ => encoding.decode(&bytes).0.into_owned(),
    }
}

/// Collects the text of every non-attachment text/html and text/plain part in the MIME tree.
fn collect_text(p: &Payload, html: &mut Vec<String>, plain: &mut Vec<String>) {
    if !p.filename.is_empty() {
        return;
    }
    let list = match p.mime_type.as_str() {
        "text/html" => Some(&mut *html),
        "text/plain" => Some(&mut *plain),
        _ => None,
    };
    if let Some(list) = list {
        let text = decode_part(p);
        if !text.is_empty() {
            list.push(text);
        }
    }
    for part in &p.parts {
        collect_text(part, html, plain);
    }
}

impl From<&Message> for MessageDetail {
    fn from(m: &Message) -> Self {
        let (mut html, mut plain) = (Vec::new(), Vec::new());
        collect_text(&m.payload, &mut html, &mut plain);
        let is_html = !html.is_empty();
        Self {
            from: header(&m.payload, "From"),
            date_ms: m.internal_date.parse().unwrap_or(0),
            html: is_html,
            body: if is_html {
                html.concat()
            } else {
                plain.join("\n")
            },
        }
    }
}

impl From<Thread> for ThreadDetail {
    fn from(t: Thread) -> Self {
        let mut messages: Vec<_> = t.messages.iter().map(MessageDetail::from).collect();
        messages.sort_by_key(|m| m.date_ms);
        Self {
            subject: t
                .messages
                .first()
                .map(|m| header(&m.payload, "Subject"))
                .unwrap_or_default(),
            messages,
        }
    }
}

/// `Ok(None)` means login is required for `account`. Retries once with a refreshed token on 401.
async fn send_json_refreshing<T: DeserializeOwned>(
    app: &AppHandle,
    auth: &Auth,
    account: &str,
    method: Method,
    url: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
) -> Result<Option<T>, String> {
    let Some(token) = auth.token(app, account).await? else {
        return Ok(None);
    };
    if let Some(v) = send_json(auth.http(), method.clone(), &token, url, query, body).await? {
        return Ok(Some(v));
    }
    let Some(refreshed) = auth.refresh(app, account).await? else {
        return Ok(None);
    };
    send_json(auth.http(), method, &refreshed, url, query, body)
        .await?
        .ok_or("認証に失敗しました".to_string())
        .map(Some)
}

fn build_request(
    http: &reqwest::Client,
    method: Method,
    token: &str,
    url: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
) -> reqwest::RequestBuilder {
    let req = http.request(method, url).bearer_auth(token).query(query);
    match body {
        Some(body) => req.json(body),
        // Gmail rejects a bodyless POST without Content-Length (411), and reqwest omits it.
        None => req.header(reqwest::header::CONTENT_LENGTH, "0"),
    }
}

/// `Ok(None)` means the token was rejected with 401.
async fn send_json<T: DeserializeOwned>(
    http: &reqwest::Client,
    method: Method,
    token: &str,
    url: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
) -> Result<Option<T>, String> {
    let res = build_request(http, method, token, url, query, body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(None);
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Gmail API が {status} を返しました: {body}"));
    }
    res.json().await.map(Some).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inbox {
    accounts: Vec<String>,
    threads: Vec<ThreadItem>,
    /// Accounts whose threads are missing because they must log in again.
    needs_login: Vec<String>,
}

/// Newest first across all accounts.
fn merge_inboxes(lists: Vec<Vec<ThreadItem>>) -> Vec<ThreadItem> {
    let mut items: Vec<_> = lists.into_iter().flatten().collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.date_ms));
    items
}

/// Inbox threads of one account. `Ok(None)` means that account must log in again.
async fn account_threads(
    app: &AppHandle,
    auth: &Auth,
    account: &str,
) -> Result<Option<Vec<ThreadItem>>, String> {
    let list_query = [("labelIds", "INBOX"), ("maxResults", "50")];
    let Some(list) = send_json_refreshing::<ThreadList>(
        app,
        auth,
        account,
        Method::GET,
        THREADS_URL,
        &list_query,
        None,
    )
    .await?
    else {
        return Ok(None);
    };
    // The list call may have refreshed the token; the cache holds the current one.
    let Some(token) = auth.token(app, account).await? else {
        return Ok(None);
    };

    let http = auth.http();
    let mut items = Vec::with_capacity(list.threads.len());
    for chunk in list.threads.chunks(CONCURRENCY) {
        let mut set = JoinSet::new();
        for t in chunk {
            let (http, token, url) = (
                http.clone(),
                token.clone(),
                format!("{THREADS_URL}/{}", t.id),
            );
            set.spawn(async move {
                send_json::<Thread>(&http, Method::GET, &token, &url, &METADATA_QUERY, None).await
            });
        }
        while let Some(res) = set.join_next().await {
            let thread = res
                .map_err(|e| e.to_string())??
                .ok_or("認証に失敗しました")?;
            items.push(ThreadItem::new(thread, account));
        }
    }
    Ok(Some(items))
}

/// Threads of every account merged; accounts needing login are listed, not fatal.
#[tauri::command]
pub async fn inbox(app: AppHandle, auth: State<'_, Auth>) -> Result<Inbox, String> {
    let accounts = auth.accounts(&app).await?;
    let (mut lists, mut needs_login) = (Vec::new(), Vec::new());
    for account in &accounts {
        match account_threads(&app, &auth, account).await? {
            Some(items) => lists.push(items),
            None => needs_login.push(account.clone()),
        }
    }
    Ok(Inbox {
        accounts,
        threads: merge_inboxes(lists),
        needs_login,
    })
}

/// `Ok(None)` means `account` must log in again.
#[tauri::command]
pub async fn thread(
    app: AppHandle,
    auth: State<'_, Auth>,
    account: String,
    id: String,
) -> Result<Option<ThreadDetail>, String> {
    let url = format!("{THREADS_URL}/{id}");
    let thread = send_json_refreshing::<Thread>(
        &app,
        &auth,
        &account,
        Method::GET,
        &url,
        &[("format", "full")],
        None,
    )
    .await?;
    Ok(thread.map(ThreadDetail::from))
}

/// Moves the thread to the trash (recoverable in Gmail). `Ok(None)` means `account` must log in again.
#[tauri::command]
pub async fn trash(
    app: AppHandle,
    auth: State<'_, Auth>,
    account: String,
    id: String,
) -> Result<Option<bool>, String> {
    let url = format!("{THREADS_URL}/{id}/trash");
    let done =
        send_json_refreshing::<IgnoredAny>(&app, &auth, &account, Method::POST, &url, &[], None)
            .await?;
    // `true`, not `()`: `Some(())` reaches JS as null, the same as `None` (login required).
    Ok(done.map(|_| true))
}

fn archive_body() -> Value {
    json!({"removeLabelIds": ["INBOX"]})
}

/// Removes the INBOX label from the thread. `Ok(None)` means `account` must log in again.
#[tauri::command]
pub async fn archive(
    app: AppHandle,
    auth: State<'_, Auth>,
    account: String,
    id: String,
) -> Result<Option<bool>, String> {
    let url = format!("{THREADS_URL}/{id}/modify");
    let body = archive_body();
    let done = send_json_refreshing::<IgnoredAny>(
        &app,
        &auth,
        &account,
        Method::POST,
        &url,
        &[],
        Some(&body),
    )
    .await?;
    Ok(done.map(|_| true))
}

fn read_body(read: bool) -> Value {
    if read {
        json!({"removeLabelIds": ["UNREAD"]})
    } else {
        json!({"addLabelIds": ["UNREAD"]})
    }
}

/// Marks the thread read (removes UNREAD) or unread (adds it). `Ok(None)` means `account` must log in again.
#[tauri::command]
pub async fn set_read(
    app: AppHandle,
    auth: State<'_, Auth>,
    account: String,
    id: String,
    read: bool,
) -> Result<Option<bool>, String> {
    let url = format!("{THREADS_URL}/{id}/modify");
    let body = read_body(read);
    let done = send_json_refreshing::<IgnoredAny>(
        &app,
        &auth,
        &account,
        Method::POST,
        &url,
        &[],
        Some(&body),
    )
    .await?;
    Ok(done.map(|_| true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(json: &str, account: &str) -> ThreadItem {
        ThreadItem::new(serde_json::from_str::<Thread>(json).unwrap(), account)
    }

    fn item_at(id: &str, account: &str, date_ms: i64) -> ThreadItem {
        ThreadItem {
            id: id.into(),
            account: account.into(),
            from: String::new(),
            subject: String::new(),
            snippet: String::new(),
            date_ms,
            unread: false,
        }
    }

    #[test]
    fn merges_accounts_newest_first_keeping_each_account() {
        let merged = merge_inboxes(vec![
            vec![
                item_at("a2", "a@example.com", 3000),
                item_at("a1", "a@example.com", 1000),
            ],
            vec![],
            vec![
                item_at("b2", "b@example.com", 4000),
                item_at("b1", "b@example.com", 2000),
            ],
        ]);
        let order: Vec<_> = merged
            .iter()
            .map(|i| (i.id.as_str(), i.account.as_str()))
            .collect();
        assert_eq!(
            order,
            vec![
                ("b2", "b@example.com"),
                ("a2", "a@example.com"),
                ("b1", "b@example.com"),
                ("a1", "a@example.com"),
            ]
        );
    }

    #[test]
    fn merging_nothing_gives_nothing() {
        assert!(merge_inboxes(vec![]).is_empty());
        assert!(merge_inboxes(vec![vec![], vec![]]).is_empty());
    }

    #[test]
    fn inbox_serializes_in_camel_case() {
        let inbox = Inbox {
            accounts: vec!["a@example.com".into()],
            threads: vec![item_at("t", "a@example.com", 1)],
            needs_login: vec!["b@example.com".into()],
        };
        let v = serde_json::to_value(&inbox).unwrap();
        assert_eq!(v["needsLogin"][0], "b@example.com");
        assert_eq!(v["threads"][0]["account"], "a@example.com");
        assert_eq!(v["threads"][0]["dateMs"], 1);
    }

    #[test]
    fn converts_metadata_thread_to_item() {
        let json = r#"{
            "id": "t1",
            "snippet": "latest reply",
            "messages": [
                {"id": "m1", "labelIds": ["INBOX"], "internalDate": "1000",
                 "payload": {"headers": [
                    {"name": "From", "value": "Alice <a@example.com>"},
                    {"name": "Subject", "value": "Hello"},
                    {"name": "Date", "value": "Thu, 1 Jan 1970 00:00:01 +0000"}]}},
                {"id": "m2", "labelIds": ["INBOX", "UNREAD"], "internalDate": "2000",
                 "payload": {"headers": [
                    {"name": "from", "value": "Bob <b@example.com>"},
                    {"name": "Subject", "value": "Re: Hello"}]}}
            ]
        }"#;
        let item = item(json, "me@example.com");
        assert_eq!(
            item,
            ThreadItem {
                id: "t1".into(),
                account: "me@example.com".into(),
                from: "Bob <b@example.com>".into(),
                subject: "Hello".into(),
                snippet: "latest reply".into(),
                date_ms: 2000,
                unread: true,
            }
        );
    }

    #[test]
    fn read_thread_without_headers_gets_defaults() {
        let json = r#"{"id": "t2", "messages": [{"id": "m1", "labelIds": ["INBOX"]}]}"#;
        let item = item(json, "me@example.com");
        assert_eq!(item.subject, "");
        assert_eq!(item.from, "");
        assert_eq!(item.date_ms, 0);
        assert!(!item.unread);
    }

    #[test]
    fn bodyless_request_declares_zero_content_length() {
        let http = reqwest::Client::new();
        let req = build_request(&http, Method::POST, "t", "https://example.com/x", &[], None)
            .build()
            .unwrap();
        assert_eq!(req.headers()[reqwest::header::CONTENT_LENGTH], "0");
        assert!(req.body().is_none());
    }

    #[test]
    fn read_body_removes_or_adds_unread() {
        assert_eq!(read_body(true), json!({"removeLabelIds": ["UNREAD"]}));
        assert_eq!(read_body(false), json!({"addLabelIds": ["UNREAD"]}));
    }

    #[test]
    fn json_request_leaves_content_length_to_reqwest() {
        let http = reqwest::Client::new();
        let body = archive_body();
        let req = build_request(
            &http,
            Method::POST,
            "t",
            "https://example.com/x",
            &[],
            Some(&body),
        )
        .build()
        .unwrap();
        assert!(!req.headers().contains_key(reqwest::header::CONTENT_LENGTH));
        assert_eq!(
            req.headers()[reqwest::header::CONTENT_TYPE],
            "application/json"
        );
        assert_eq!(
            req.body().unwrap().as_bytes().unwrap(),
            br#"{"removeLabelIds":["INBOX"]}"#
        );
    }

    #[test]
    fn empty_list_response_has_no_threads() {
        let list: ThreadList = serde_json::from_str(r#"{"resultSizeEstimate": 0}"#).unwrap();
        assert!(list.threads.is_empty());
    }

    fn b64(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn detail(json: serde_json::Value) -> ThreadDetail {
        ThreadDetail::from(serde_json::from_value::<Thread>(json).unwrap())
    }

    // "こんにちは" in ISO-2022-JP
    const JIS_KONNICHIWA: &[u8] = b"\x1b$B$3$s$K$A$O\x1b(B";

    #[test]
    fn utf8_body_wins_over_declared_iso_2022_jp() {
        let d = detail(serde_json::json!({"id": "t", "messages": [{
            "internalDate": "1",
            "payload": {"mimeType": "text/plain",
                "headers": [{"name": "Content-Type", "value": "text/plain; charset=\"ISO-2022-JP\""}],
                "body": {"data": b64("こんにちは".as_bytes())}}}]}));
        assert_eq!(d.messages[0].body, "こんにちは");
    }

    #[test]
    fn decodes_iso_2022_jp_plain_part() {
        let d = detail(serde_json::json!({"id": "t", "messages": [{
            "internalDate": "1",
            "payload": {"mimeType": "text/plain",
                "headers": [{"name": "Content-Type", "value": "text/plain; charset=\"ISO-2022-JP\""},
                            {"name": "From", "value": "A <a@example.com>"},
                            {"name": "Subject", "value": "件名"}],
                "body": {"size": 16, "data": b64(JIS_KONNICHIWA)}}}]}));
        assert_eq!(d.subject, "件名");
        assert_eq!(
            d.messages,
            vec![MessageDetail {
                from: "A <a@example.com>".into(),
                date_ms: 1,
                html: false,
                body: "こんにちは".into()
            }]
        );
    }

    #[test]
    fn prefers_html_in_multipart_alternative() {
        let d = detail(serde_json::json!({"id": "t", "messages": [{
            "internalDate": "1",
            "payload": {"mimeType": "multipart/alternative", "body": {"size": 0}, "parts": [
                {"mimeType": "text/plain", "body": {"data": b64(b"plain")}},
                {"mimeType": "text/html", "headers": [{"name": "content-type", "value": "text/html; charset=UTF-8"}],
                 "body": {"data": b64("<p>é</p>".as_bytes())}}]}}]}));
        assert_eq!(
            (d.messages[0].html, d.messages[0].body.as_str()),
            (true, "<p>é</p>")
        );
    }

    #[test]
    fn walks_nested_mixed_and_skips_attachments() {
        let d = detail(serde_json::json!({"id": "t", "messages": [{
            "internalDate": "1",
            "payload": {"mimeType": "multipart/mixed", "parts": [
                {"mimeType": "multipart/alternative", "parts": [
                    {"mimeType": "text/plain", "body": {"data": b64(b"first")}}]},
                {"mimeType": "text/plain", "filename": "a.txt", "body": {"attachmentId": "x", "data": b64(b"attached")}},
                {"mimeType": "text/plain", "headers": [{"name": "Content-Type", "value": "text/plain; charset=Shift_JIS"}],
                 "body": {"data": b64(&[0x82, 0xb1, 0x82, 0xf1])}}]}}]}));
        assert_eq!(
            (d.messages[0].html, d.messages[0].body.as_str()),
            (false, "first\nこん")
        );
    }

    #[test]
    fn orders_messages_oldest_first_and_tolerates_empty_payload() {
        let d = detail(serde_json::json!({"id": "t", "messages": [
            {"internalDate": "2000", "payload": {"mimeType": "text/plain", "body": {"data": b64(b"b")}}},
            {"internalDate": "1000", "payload": {}}]}));
        assert_eq!(
            d.messages.iter().map(|m| m.date_ms).collect::<Vec<_>>(),
            vec![1000, 2000]
        );
        assert_eq!(d.messages[0].body, "");
        assert_eq!(d.messages[1].body, "b");
    }

    #[test]
    fn invalid_base64_and_unknown_charset_do_not_panic() {
        let d = detail(serde_json::json!({"id": "t", "messages": [{
            "internalDate": "1",
            "payload": {"mimeType": "multipart/mixed", "parts": [
                {"mimeType": "text/plain", "body": {"data": "***"}},
                {"mimeType": "text/plain", "headers": [{"name": "Content-Type", "value": "text/plain; charset=nope"}],
                 "body": {"data": b64(b"ok")}}]}}]}));
        assert_eq!(d.messages[0].body, "ok");
    }
}
