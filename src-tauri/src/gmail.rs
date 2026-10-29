use std::{
    collections::HashMap,
    fmt,
    sync::Mutex,
    time::{Duration, Instant},
};

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
const PROFILE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const HISTORY_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/history";
const METADATA_QUERY: [(&str, &str); 4] = [
    ("format", "metadata"),
    ("metadataHeaders", "From"),
    ("metadataHeaders", "Subject"),
    ("metadataHeaders", "Date"),
];
// Keeps the burst of threads.get calls small enough for Gmail's per-second quota.
const CONCURRENCY: usize = 10;
// Past these a differential sync costs about as much as a full reload (50 threads), so reload instead.
const MAX_SYNC_THREADS: usize = 50;
const MAX_HISTORY_PAGES: usize = 10;

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

/// A failed Google API call. `status` is `None` when no HTTP response was received.
#[derive(Debug)]
pub struct ApiError {
    pub(crate) status: Option<u16>,
    rate_limited: bool,
    pub(crate) message: String,
}

impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self {
            status: None,
            rate_limited: false,
            message,
        }
    }
}

impl From<&str> for ApiError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl From<ApiError> for String {
    fn from(e: ApiError) -> Self {
        e.message
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Logs a failed command on stderr and returns the message for the UI. Tokens and mail bodies never reach it.
pub(crate) fn log_failure(command: &str, account: &str, e: impl Into<ApiError>) -> String {
    let e = e.into();
    let status = e.status.map_or("-".to_owned(), |s| s.to_string());
    eprintln!(
        "cookup: {command} account={account} status={status} error={}",
        e.message
    );
    e.message
}

/// Gmail signals its quota with 429, or 403 with a `rateLimitExceeded` / `userRateLimitExceeded` reason.
fn is_rate_limited(status: u16, body: &str) -> bool {
    status == 429 || (status == 403 && body.to_lowercase().contains("ratelimitexceeded"))
}

/// `Ok(None)` means login is required for `account`. Retries once with a refreshed token on 401.
pub(crate) async fn send_json_refreshing<T: DeserializeOwned>(
    app: &AppHandle,
    auth: &Auth,
    account: &str,
    method: Method,
    url: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
) -> Result<Option<T>, ApiError> {
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
        .ok_or("認証に失敗しました".into())
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
) -> Result<Option<T>, ApiError> {
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
        eprintln!(
            "cookup: gmail api status={} url={url} error={body}",
            status.as_u16()
        );
        return Err(ApiError {
            status: Some(status.as_u16()),
            rate_limited: is_rate_limited(status.as_u16(), &body),
            message: format!("Google API が {status} を返しました: {body}"),
        });
    }
    Ok(res.json().await.map(Some).map_err(|e| e.to_string())?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inbox {
    accounts: Vec<String>,
    threads: Vec<ThreadItem>,
    /// Accounts whose threads are missing because they must log in again.
    needs_login: Vec<String>,
    /// Accounts whose threads are missing because loading them failed, with the error to show.
    failed: HashMap<String, String>,
    /// Per account, the mailbox history ID as of the full load; the starting point of `sync`.
    history_ids: HashMap<String, String>,
}

/// Newest first across all accounts.
fn merge_inboxes(lists: Vec<Vec<ThreadItem>>) -> Vec<ThreadItem> {
    let mut items: Vec<_> = lists.into_iter().flatten().collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.date_ms));
    items
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    history_id: String,
}

struct AccountInbox {
    threads: Vec<ThreadItem>,
    history_id: String,
}

/// threads.get(metadata) for each ID, in chunks. `None` means 404: the thread no longer exists.
async fn get_threads(
    http: &reqwest::Client,
    token: &str,
    ids: &[String],
) -> Result<Vec<(String, Option<Thread>)>, ApiError> {
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(CONCURRENCY) {
        let mut set = JoinSet::new();
        for id in chunk {
            let (http, token, id) = (http.clone(), token.to_owned(), id.clone());
            set.spawn(async move {
                let url = format!("{THREADS_URL}/{id}");
                let res =
                    send_json::<Thread>(&http, Method::GET, &token, &url, &METADATA_QUERY, None)
                        .await;
                (id, res)
            });
        }
        while let Some(joined) = set.join_next().await {
            let (id, res) = joined.map_err(|e| e.to_string())?;
            match res {
                Ok(Some(thread)) => out.push((id, Some(thread))),
                Ok(None) => return Err("認証に失敗しました".into()),
                Err(e) if e.status == Some(404) => out.push((id, None)),
                Err(e) => return Err(e),
            }
        }
    }
    Ok(out)
}

/// Inbox threads of one account. `Ok(None)` means that account must log in again.
async fn account_threads(
    app: &AppHandle,
    auth: &Auth,
    account: &str,
) -> Result<Option<AccountInbox>, ApiError> {
    // Read before the list: changes landing in between are replayed by the next sync, which is harmless.
    let Some(profile) =
        send_json_refreshing::<Profile>(app, auth, account, Method::GET, PROFILE_URL, &[], None)
            .await?
    else {
        return Ok(None);
    };
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

    let ids: Vec<_> = list.threads.into_iter().map(|t| t.id).collect();
    let threads = get_threads(auth.http(), &token, &ids)
        .await?
        .into_iter()
        .filter_map(|(_, t)| t)
        .map(|t| ThreadItem::new(t, account))
        .collect();
    Ok(Some(AccountInbox {
        threads,
        history_id: profile.history_id,
    }))
}

/// Threads of every account merged; accounts needing login or failing to load are listed, not fatal.
#[tauri::command]
pub async fn inbox(app: AppHandle, auth: State<'_, Auth>) -> Result<Inbox, String> {
    let accounts = auth
        .accounts(&app)
        .map_err(|e| log_failure("inbox", "-", e))?;
    let (mut lists, mut needs_login, mut failed, mut history_ids) =
        (Vec::new(), Vec::new(), HashMap::new(), HashMap::new());
    for account in &accounts {
        match account_threads(&app, &auth, account).await {
            Ok(Some(loaded)) => {
                lists.push(loaded.threads);
                history_ids.insert(account.clone(), loaded.history_id);
            }
            Ok(None) => needs_login.push(account.clone()),
            Err(e) => {
                failed.insert(account.clone(), log_failure("inbox", account, e));
            }
        }
    }
    Ok(Inbox {
        accounts,
        threads: merge_inboxes(lists),
        needs_login,
        failed,
        history_ids,
    })
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HistoryList {
    #[serde(default)]
    history: Vec<HistoryRecord>,
    next_page_token: Option<String>,
    #[serde(default)]
    history_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRecord {
    #[serde(default)]
    messages_added: Vec<HistoryMessage>,
    #[serde(default)]
    messages_deleted: Vec<HistoryMessage>,
    #[serde(default)]
    labels_added: Vec<HistoryMessage>,
    #[serde(default)]
    labels_removed: Vec<HistoryMessage>,
}

#[derive(Deserialize)]
struct HistoryMessage {
    message: HistoryMessageRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryMessageRef {
    thread_id: String,
}

/// Threads touched by any added / deleted message or added / removed label, each once, in record order.
/// Which of them still belong in the inbox is settled by refetching, not by reading the labels here.
fn changed_thread_ids(records: &[HistoryRecord]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for r in records {
        let touched = [
            &r.messages_added,
            &r.messages_deleted,
            &r.labels_added,
            &r.labels_removed,
        ];
        for m in touched.into_iter().flatten() {
            if !ids.contains(&m.message.thread_id) {
                ids.push(m.message.thread_id.clone());
            }
        }
    }
    ids
}

/// A thread is listed while one of its messages is in the inbox and not in the trash.
fn in_inbox(t: &Thread) -> bool {
    t.messages.iter().any(|m| {
        m.label_ids.iter().any(|l| l == "INBOX") && !m.label_ids.iter().any(|l| l == "TRASH")
    })
}

/// Refetched threads → (rows to put in the list, IDs to take out of it). A 404 thread is taken out.
fn split_fetched(
    fetched: Vec<(String, Option<Thread>)>,
    account: &str,
) -> (Vec<ThreadItem>, Vec<String>) {
    let (mut threads, mut removed) = (Vec::new(), Vec::new());
    for (id, thread) in fetched {
        match thread {
            Some(t) if in_inbox(&t) => threads.push(ThreadItem::new(t, account)),
            _ => removed.push(id),
        }
    }
    (threads, removed)
}

/// History records since `start`, all pages merged. A leftover `next_page_token` means the page cap was hit.
/// `Ok(None)` means `account` must log in again.
async fn list_history(
    app: &AppHandle,
    auth: &Auth,
    account: &str,
    start: &str,
) -> Result<Option<HistoryList>, ApiError> {
    let mut all = HistoryList::default();
    for _ in 0..MAX_HISTORY_PAGES {
        let mut query = vec![("startHistoryId", start), ("maxResults", "500")];
        if let Some(token) = all.next_page_token.as_deref() {
            query.push(("pageToken", token));
        }
        let Some(page) = send_json_refreshing::<HistoryList>(
            app,
            auth,
            account,
            Method::GET,
            HISTORY_URL,
            &query,
            None,
        )
        .await?
        else {
            return Ok(None);
        };
        all.history.extend(page.history);
        all.history_id = page.history_id;
        all.next_page_token = page.next_page_token;
        if all.next_page_token.is_none() {
            break;
        }
    }
    Ok(Some(all))
}

/// What one `sync` found, to apply to the list of that account.
#[derive(Serialize, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Sync {
    /// Nothing changed, or the account is backing off after a rate limit.
    Unchanged,
    /// Put `threads` in the list (add or replace) and take `removed` out.
    Changed {
        threads: Vec<ThreadItem>,
        removed: Vec<String>,
        history_id: String,
    },
    /// The history was too old or too large: `threads` is the whole inbox of the account.
    Reloaded {
        threads: Vec<ThreadItem>,
        history_id: String,
    },
    NeedsLogin,
}

async fn reload(app: &AppHandle, auth: &Auth, account: &str) -> Result<Sync, ApiError> {
    Ok(match account_threads(app, auth, account).await? {
        Some(l) => Sync::Reloaded {
            threads: l.threads,
            history_id: l.history_id,
        },
        None => Sync::NeedsLogin,
    })
}

async fn sync_account(
    app: &AppHandle,
    auth: &Auth,
    account: &str,
    start: &str,
) -> Result<Sync, ApiError> {
    // One cheap call tells whether anything changed at all.
    let Some(profile) =
        send_json_refreshing::<Profile>(app, auth, account, Method::GET, PROFILE_URL, &[], None)
            .await?
    else {
        return Ok(Sync::NeedsLogin);
    };
    if profile.history_id == start {
        return Ok(Sync::Unchanged);
    }
    // No `labelId=INBOX` filter: the docs do not say whether a removal of that very label (archive) still
    // matches it, and missing an archive is worse than refetching a few extra threads.
    let list = match list_history(app, auth, account, start).await {
        Ok(Some(list)) => list,
        Ok(None) => return Ok(Sync::NeedsLogin),
        // startHistoryId too old: Gmail asks for a full sync.
        Err(e) if e.status == Some(404) => return reload(app, auth, account).await,
        Err(e) => return Err(e),
    };
    let ids = changed_thread_ids(&list.history);
    if list.next_page_token.is_some() || ids.len() > MAX_SYNC_THREADS {
        return reload(app, auth, account).await;
    }
    let Some(token) = auth.token(app, account).await? else {
        return Ok(Sync::NeedsLogin);
    };
    let (threads, removed) = split_fetched(get_threads(auth.http(), &token, &ids).await?, account);
    let history_id = if list.history_id.is_empty() {
        profile.history_id
    } else {
        list.history_id
    };
    Ok(Sync::Changed {
        threads,
        removed,
        history_id,
    })
}

/// Seconds to leave an account alone after its `fails`-th rate limit in a row: 20, 40, 80, ... up to 5 minutes.
fn backoff(fails: u32) -> Duration {
    Duration::from_secs((20u64 << fails.saturating_sub(1).min(4)).min(300))
}

#[derive(Default)]
struct Throttle {
    fails: u32,
    until: Option<Instant>,
}

impl Throttle {
    fn blocked(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now < until)
    }

    fn hit(&mut self, now: Instant) {
        self.fails += 1;
        self.until = Some(now + backoff(self.fails));
    }
}

/// Per-account backoff after rate limits, kept here so every caller of `sync` is thinned the same way.
#[derive(Default)]
pub struct SyncState(Mutex<HashMap<String, Throttle>>);

/// Differential sync of one account from `start_history_id` (see `Inbox::history_ids` and `Sync`).
#[tauri::command]
pub async fn sync(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, SyncState>,
    account: String,
    start_history_id: String,
) -> Result<Sync, String> {
    let blocked = state
        .0
        .lock()
        .unwrap()
        .get(&account)
        .is_some_and(|t| t.blocked(Instant::now()));
    if blocked {
        return Ok(Sync::Unchanged);
    }
    match sync_account(&app, &auth, &account, &start_history_id).await {
        Ok(result) => {
            state.0.lock().unwrap().remove(&account);
            Ok(result)
        }
        // Expected under quota pressure, so it is thinned out silently rather than reported as an error.
        Err(e) if e.rate_limited => {
            state
                .0
                .lock()
                .unwrap()
                .entry(account)
                .or_default()
                .hit(Instant::now());
            Ok(Sync::Unchanged)
        }
        Err(e) => Err(log_failure("sync", &account, e)),
    }
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
    .await
    .map_err(|e| log_failure("thread", &account, e))?;
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
            .await
            .map_err(|e| log_failure("trash", &account, e))?;
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
    .await
    .map_err(|e| log_failure("archive", &account, e))?;
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
    .await
    .map_err(|e| log_failure("set_read", &account, e))?;
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
            failed: HashMap::from([("c@example.com".to_string(), "boom".to_string())]),
            history_ids: HashMap::from([("a@example.com".to_string(), "42".to_string())]),
        };
        let v = serde_json::to_value(&inbox).unwrap();
        assert_eq!(v["needsLogin"][0], "b@example.com");
        assert_eq!(v["failed"]["c@example.com"], "boom");
        assert_eq!(v["historyIds"]["a@example.com"], "42");
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

    fn thread_with_labels(id: &str, labels: &[&[&str]]) -> Thread {
        let messages: Vec<_> = labels
            .iter()
            .map(|l| json!({"labelIds": l, "internalDate": "1"}))
            .collect();
        serde_json::from_value(json!({"id": id, "messages": messages})).unwrap()
    }

    #[test]
    fn backoff_doubles_from_20_seconds_up_to_5_minutes() {
        let secs: Vec<_> = [1, 2, 3, 4, 5, 6, 40].map(|n| backoff(n).as_secs()).into();
        assert_eq!(secs, vec![20, 40, 80, 160, 300, 300, 300]);
    }

    #[test]
    fn throttle_blocks_until_the_backoff_passes_and_grows_on_repeat() {
        let t0 = Instant::now();
        let mut t = Throttle::default();
        assert!(!t.blocked(t0));
        t.hit(t0);
        assert!(t.blocked(t0 + Duration::from_secs(19)));
        assert!(!t.blocked(t0 + Duration::from_secs(20)));
        t.hit(t0);
        assert!(t.blocked(t0 + Duration::from_secs(39)));
        assert!(!t.blocked(t0 + Duration::from_secs(40)));
    }

    #[test]
    fn detects_rate_limit_responses() {
        assert!(is_rate_limited(429, ""));
        assert!(is_rate_limited(
            403,
            r#"{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}"#
        ));
        assert!(is_rate_limited(
            403,
            r#"{"reason":"userRateLimitExceeded"}"#
        ));
        assert!(!is_rate_limited(
            403,
            r#"{"reason":"insufficientPermissions"}"#
        ));
        assert!(!is_rate_limited(500, "rateLimitExceeded"));
    }

    #[test]
    fn collects_changed_thread_ids_once_in_order_from_every_record_kind() {
        let list: HistoryList = serde_json::from_value(json!({
            "history": [
                {"id": "1", "messages": [{"id": "m0", "threadId": "t0"}],
                 "messagesAdded": [{"message": {"id": "m1", "threadId": "t1"}}]},
                {"id": "2", "labelsRemoved": [{"message": {"id": "m2", "threadId": "t2"}, "labelIds": ["INBOX"]}]},
                {"id": "3", "labelsAdded": [{"message": {"id": "m1", "threadId": "t1"}, "labelIds": ["UNREAD"]}],
                 "messagesDeleted": [{"message": {"id": "m3", "threadId": "t3"}}]},
                {"id": "4"}
            ],
            "historyId": "9"
        }))
        .unwrap();
        assert_eq!(changed_thread_ids(&list.history), vec!["t1", "t2", "t3"]);
        assert_eq!(list.history_id, "9");
        assert!(list.next_page_token.is_none());
    }

    #[test]
    fn history_without_changes_is_empty() {
        let list: HistoryList = serde_json::from_str(r#"{"historyId": "5"}"#).unwrap();
        assert!(changed_thread_ids(&list.history).is_empty());
    }

    #[test]
    fn split_keeps_inbox_threads_and_removes_the_rest() {
        let fetched = vec![
            (
                "kept".to_string(),
                Some(thread_with_labels("kept", &[&["INBOX", "UNREAD"]])),
            ),
            (
                "mixed".to_string(),
                Some(thread_with_labels("mixed", &[&["SENT"], &["INBOX"]])),
            ),
            (
                "archived".to_string(),
                Some(thread_with_labels("archived", &[&["UNREAD"]])),
            ),
            (
                "trashed".to_string(),
                Some(thread_with_labels("trashed", &[&["TRASH"]])),
            ),
            ("gone".to_string(), None),
        ];
        let (threads, removed) = split_fetched(fetched, "a@example.com");
        let kept: Vec<_> = threads
            .iter()
            .map(|t| (t.id.as_str(), t.account.as_str()))
            .collect();
        assert_eq!(
            kept,
            vec![("kept", "a@example.com"), ("mixed", "a@example.com")]
        );
        assert_eq!(removed, vec!["archived", "trashed", "gone"]);
    }

    #[test]
    fn sync_serializes_with_kind_tag_in_camel_case() {
        let v = serde_json::to_value(Sync::Changed {
            threads: vec![item_at("t", "a@example.com", 1)],
            removed: vec!["r".into()],
            history_id: "7".into(),
        })
        .unwrap();
        assert_eq!(v["kind"], "changed");
        assert_eq!(v["historyId"], "7");
        assert_eq!(v["removed"][0], "r");
        assert_eq!(v["threads"][0]["dateMs"], 1);
        let v = serde_json::to_value(Sync::NeedsLogin).unwrap();
        assert_eq!(v["kind"], "needsLogin");
        let v = serde_json::to_value(Sync::Unchanged).unwrap();
        assert_eq!(v["kind"], "unchanged");
        let v = serde_json::to_value(Sync::Reloaded {
            threads: vec![],
            history_id: "8".into(),
        })
        .unwrap();
        assert_eq!(
            (v["kind"].as_str(), v["historyId"].as_str()),
            (Some("reloaded"), Some("8"))
        );
    }
}
