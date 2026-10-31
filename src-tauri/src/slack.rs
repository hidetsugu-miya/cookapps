use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
#[cfg(test)]
use ts_rs::TS;
use url::Url;

use crate::{
    accounts::write_synced,
    auth::{config_dir, delete_entry, Auth},
    gmail::{log_failure, parse_retry_after, retry_wait, ApiError, MAX_RETRIES},
};

/// Every request goes here and nowhere else: nothing from outside is put into the URL.
const API_URL: &str = "https://slack.com/api";
const TOKEN_SERVICE: &str = "jp.mysis.cookapps.slack";
/// The keychain user name of v0.11.0's single token; a token now has its `team_id` as the user name.
const LEGACY_USER: &str = "slack";
const WORKSPACES_FILE: &str = "slack-workspaces.json";
const WORKSPACES_KEY: &str = "workspaces";
const RECENT_FILE: &str = "slack-recent.json";
const RECENT_KEY: &str = "recent";
/// v0.11.0's registered destinations, which are not carried over.
const LEGACY_FILE: &str = "slack-destinations.json";
/// How many destinations "recent" keeps.
const RECENT_MAX: usize = 8;
/// `users.conversations` answers in pages of 200 channels; the channels past this many pages are left out.
const CHANNEL_PAGES: usize = 50;
const CHANNELS_TTL: Duration = Duration::from_secs(10 * 60);
/// After a move of v0.11.0's token failed for a reason that may pass (offline, 5xx), the next try waits this long.
const MIGRATE_RETRY: Duration = Duration::from_secs(5 * 60);
/// Characters of a channel name that are remembered.
const NAME_LIMIT: usize = 80;
/// Characters of the mail's text that are posted.
const BODY_LIMIT: usize = 3000;
/// Characters of a thread's first message that reach the summary (`claude::INPUT_LIMIT` caps the whole input).
const PARENT_LIMIT: usize = 2000;
const NO_TOKEN: &str =
    "Slack のトークンが保存されていません。設定でワークスペースを追加してください";
const BAD_URL: &str = "Slack のメッセージかチャンネルのリンクを入力してください";
const BAD_TARGET: &str = "貼り付け先が不正です";
const BAD_MESSAGE_URL: &str = "Slack のメッセージのリンクを入力してください";
const NO_MESSAGE: &str = "リンク先のメッセージが見つかりません";
const NO_WORKSPACE: &str = "このリンクのワークスペースは接続されていません。設定で追加してください";

/// A connected workspace. Its token is in the keychain under `team_id`.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    team_id: String,
    team: String,
    user: String,
    /// `auth.test`'s `url` (`https://{ws}.slack.com/`), whose host a pasted link is matched with.
    url: String,
}

/// A destination that a post succeeded in: a channel, or the thread of a message in it when `thread_ts` is set.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    team_id: String,
    channel: String,
    name: String,
    #[serde(default)]
    thread_ts: Option<String>,
}

/// A channel the user is in.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Channel {
    id: String,
    name: String,
}

/// What a pasted Slack link points at.
#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Target {
    team_id: String,
    channel: String,
    name: String,
    thread_ts: Option<String>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct SlackLoad {
    workspaces: Vec<Workspace>,
    recent: Vec<Recent>,
}

#[derive(Default)]
struct Migration {
    done: bool,
    tried: Option<Instant>,
}

/// What the commands share.
#[derive(Default)]
pub struct SlackState {
    /// Whether v0.11.0's token has been dealt with in this run, and when it was last tried. The lock is held through the move.
    migrated: tokio::sync::Mutex<Migration>,
    /// Held while the keychain and `slack-workspaces.json` are updated together.
    files: tokio::sync::Mutex<()>,
    /// Each workspace's channel list, in memory only.
    channels: Mutex<HashMap<String, (Instant, Vec<Channel>)>>,
}

fn valid_channel(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// A message timestamp: `1761785520.123456`.
fn valid_ts(ts: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    ts.split_once('.')
        .is_some_and(|(sec, micro)| digits(sec) && digits(micro))
}

/// The keychain user name of a workspace's token. `team_id` comes from outside, so it must look like one (`T0123ABC`);
/// that also keeps it apart from `LEGACY_USER`, which has lower-case letters.
fn token_key(team_id: &str) -> Result<String, String> {
    if valid_channel(team_id) {
        Ok(team_id.to_owned())
    } else {
        Err(BAD_TARGET.into())
    }
}

/// The host of a workspace URL, lower-cased.
fn host_of(url: &str) -> Option<String> {
    Url::parse(url).ok()?.host_str().map(str::to_owned)
}

/// The workspace whose URL has the link's host.
fn workspace_for_host<'a>(list: &'a [Workspace], host: &str) -> Option<&'a Workspace> {
    list.iter()
        .find(|w| host_of(&w.url).is_some_and(|h| h == host))
}

/// The workspace `auth.test` describes. `None` when its `team_id` is not an ID.
fn workspace_of(reply: &Value) -> Option<Workspace> {
    let field = |k: &str| reply[k].as_str().unwrap_or_default().to_owned();
    let team_id = field("team_id");
    token_key(&team_id).ok()?;
    Some(Workspace {
        team_id,
        team: field("team"),
        user: field("user"),
        url: field("url"),
    })
}

/// Adds `workspace`, or replaces the one with the same `team_id` where it stands.
fn with_workspace(mut list: Vec<Workspace>, workspace: Workspace) -> Vec<Workspace> {
    match list.iter_mut().find(|w| w.team_id == workspace.team_id) {
        Some(slot) => *slot = workspace,
        None => list.push(workspace),
    }
    list
}

fn without_workspace(list: Vec<Workspace>, team_id: &str) -> Vec<Workspace> {
    list.into_iter().filter(|w| w.team_id != team_id).collect()
}

/// v0.11.0's token is moved unless its workspace is registered already: that token was added later, so it is the newer one.
fn moves_legacy_token(registered: &[Workspace], team_id: &str) -> bool {
    !registered.iter().any(|w| w.team_id == team_id)
}

/// `new` goes first; the same destination from before is dropped, and only the newest `RECENT_MAX` stay.
fn remember(list: Vec<Recent>, new: Recent) -> Vec<Recent> {
    let same = |r: &Recent| {
        (&r.team_id, &r.channel, &r.thread_ts) == (&new.team_id, &new.channel, &new.thread_ts)
    };
    std::iter::once(new.clone())
        .chain(list.into_iter().filter(|r| !same(r)))
        .take(RECENT_MAX)
        .collect()
}

fn without_team(list: Vec<Recent>, team_id: &str) -> Vec<Recent> {
    list.into_iter().filter(|r| r.team_id != team_id).collect()
}

/// The form of a `users.conversations` request: the channels the user is in, public and private, and the page after `cursor`.
fn channels_params(cursor: Option<&str>) -> Vec<(&'static str, String)> {
    let mut params = vec![
        ("types", "public_channel,private_channel".to_owned()),
        ("exclude_archived", "true".to_owned()),
        ("limit", "200".to_owned()),
    ];
    if let Some(c) = cursor {
        params.push(("cursor", c.to_owned()));
    }
    params
}

fn channels_of(reply: &Value) -> Vec<Channel> {
    reply["channels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let (id, name) = (c["id"].as_str()?, c["name"].as_str()?);
            valid_channel(id).then(|| Channel {
                id: id.to_owned(),
                name: name.to_owned(),
            })
        })
        .collect()
}

/// The cursor of the next page; an empty one means this was the last.
fn next_cursor(reply: &Value) -> Option<String> {
    reply["response_metadata"]["next_cursor"]
        .as_str()
        .filter(|c| !c.is_empty())
        .map(str::to_owned)
}

fn channels_fresh(age: Duration) -> bool {
    age < CHANNELS_TTL
}

/// Whether the move of v0.11.0's token is tried now: it was never tried, or the last try is old enough.
fn migrate_due(since_last_try: Option<Duration>) -> bool {
    since_last_try.is_none_or(|age| age >= MIGRATE_RETRY)
}

/// The Slack error codes that say the token itself is no good, now and later.
fn token_is_dead(code: &str) -> bool {
    matches!(
        code,
        "invalid_auth" | "not_authed" | "token_revoked" | "account_inactive"
    )
}

/// The channel and the parent message's `thread_ts` of a Slack link, and the link's host.
/// `message_ts` is the linked message's own timestamp, which `thread_ts` replaces when the link names a parent.
#[derive(Debug, PartialEq)]
struct Link {
    host: String,
    channel: String,
    thread_ts: Option<String>,
    message_ts: Option<String>,
}

/// `https://{ws}.slack.com/archives/{channel}` posts to the channel,
/// `…/archives/{channel}/p{16 digits}` replies to that message (`?thread_ts=` of a reply's link names the parent instead).
fn parse_url(raw: &str) -> Result<Link, String> {
    let url = Url::parse(raw.trim()).map_err(|_| BAD_URL)?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https"
        || !(host == "slack.com" || host.ends_with(".slack.com"))
        || url.port().is_some()
        || !url.username().is_empty()
    {
        return Err(BAD_URL.into());
    }
    let segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();
    let (channel, message) = match segments[..] {
        ["archives", channel] => (channel, None),
        ["archives", channel, message] => (channel, Some(message)),
        _ => return Err(BAD_URL.into()),
    };
    if !valid_channel(channel) {
        return Err(BAD_URL.into());
    }
    let mut thread_ts = match message {
        None => None,
        Some(p) => {
            let digits = p
                .strip_prefix('p')
                .filter(|d| d.len() == 16 && d.chars().all(|c| c.is_ascii_digit()));
            Some(
                digits
                    .map(|d| format!("{}.{}", &d[..10], &d[10..]))
                    .ok_or(BAD_URL)?,
            )
        }
    };
    let message_ts = thread_ts.clone();
    if let Some((_, ts)) = url.query_pairs().find(|(k, _)| k == "thread_ts") {
        if !valid_ts(&ts) {
            return Err(BAD_URL.into());
        }
        thread_ts = Some(ts.into_owned());
    }
    Ok(Link {
        host: host.to_owned(),
        channel: channel.to_owned(),
        thread_ts,
        message_ts,
    })
}

/// The history scopes `conversations.replies` takes by the kind of conversation: public, private, DM, group DM.
const HISTORY_SCOPES: [&str; 4] = [
    "channels:history",
    "groups:history",
    "im:history",
    "mpim:history",
];

/// The history scopes an `x-oauth-scopes` header lacks; reading a message needs all four.
fn missing_history_scopes(scopes: &str) -> Vec<&'static str> {
    HISTORY_SCOPES
        .into_iter()
        .filter(|wanted| !scopes.split(',').any(|s| s.trim() == *wanted))
        .collect()
}

/// The message for a failed `conversations.replies`: a missing scope says which workspace's token to replace, and which scope it lacks.
fn read_error(e: SlackError, team: &str) -> String {
    match e.code.as_deref() {
        Some("missing_scope") => {
            let what = if e.needed.is_empty() {
                "メッセージを読む".to_owned()
            } else {
                format!(" {} の", e.needed)
            };
            format!("{team} のトークンに{what}権限がありません。設定でトークンを貼り直してください")
        }
        _ => e.message,
    }
}

/// The form of a `conversations.replies` request for one message of the thread `ts`: the thread's first message, or with `only`
/// (a reply's `ts`) that reply alone. `oldest` and `latest` leave the first message out of the range, so it is asked for on its own.
fn replies_params(channel: &str, ts: &str, only: Option<&str>) -> Vec<(&'static str, String)> {
    let mut params = vec![
        ("channel", channel.to_owned()),
        ("ts", ts.to_owned()),
        ("limit", "1".to_owned()),
    ];
    if let Some(only) = only {
        params.extend([
            ("oldest", only.to_owned()),
            ("latest", only.to_owned()),
            ("inclusive", "true".to_owned()),
        ]);
    }
    params
}

/// The text of a message as sent to the summary: who wrote it (an ID: names need a scope the app does not ask for) and what.
fn message_line(m: &Value) -> String {
    format!(
        "{}: {}",
        m["user"].as_str().unwrap_or("?"),
        m["text"].as_str().unwrap_or_default().trim()
    )
}

/// What the summary reads: the thread's first message (the head of `first`) when the link is to a reply, cut at `PARENT_LIMIT`
/// characters so the linked message stays within the summary's input, then the linked message itself, found in `found`.
/// `None` when the linked message is not among `found`.
fn thread_context(first: &[Value], found: &[Value], message_ts: &str) -> Option<String> {
    let target = found.iter().find(|m| m["ts"] == message_ts)?;
    let mut parts = Vec::new();
    if let Some(parent) = first.first().filter(|p| p["ts"] != message_ts) {
        parts.push(format!(
            "[スレッドの最初のメッセージ]\n{}",
            message_line(parent)
                .chars()
                .take(PARENT_LIMIT)
                .collect::<String>()
        ));
    }
    parts.push(format!("[対象のメッセージ]\n{}", message_line(target)));
    Some(parts.join("\n\n"))
}

/// Slack's mrkdwn treats these three characters as markup.
fn escape_mrkdwn(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The mail's text without trailing spaces and runs of blank lines, cut at `BODY_LIMIT` characters with "…".
/// Only the first `2 * BODY_LIMIT` characters are tidied, so a huge mail costs no more than a long one.
fn clip_body(body: &str) -> String {
    let window = body.char_indices().nth(BODY_LIMIT * 2).map(|(end, _)| end);
    let mut text = body[..window.unwrap_or(body.len())]
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    while text.contains("\n\n\n") {
        text = text.replace("\n\n\n", "\n\n");
    }
    let text = text.trim();
    match text.char_indices().nth(BODY_LIMIT) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None if window.is_some() => format!("{text}…"),
        None => text.to_owned(),
    }
}

/// The post: the note (if any), `*subject*`, `from ・ date`, and the clipped body. `escape` is for Slack; the preview shows the plain text.
fn mail_text(
    note: &str,
    subject: &str,
    from: &str,
    date: &str,
    body: &str,
    escape: bool,
) -> String {
    let e = |s: &str| {
        if escape {
            escape_mrkdwn(s)
        } else {
            s.to_owned()
        }
    };
    let subject = match subject.trim() {
        "" => "(件名なし)",
        s => s,
    };
    let mut parts = Vec::new();
    if !note.trim().is_empty() {
        parts.push(e(note.trim()));
    }
    parts.push(format!("*{}*\n{} ・ {}", e(subject), e(from), e(date)));
    let body = clip_body(body);
    if !body.is_empty() {
        parts.push(e(&body));
    }
    parts.join("\n\n")
}

/// The message for the UI of a Slack error code. Slack answers 200 with `ok: false`.
/// `needed` is what a `missing_scope` reply says the token lacks.
fn error_message(code: &str, needed: &str) -> String {
    match code {
        "invalid_auth" | "not_authed" | "token_revoked" => {
            "トークンが無効です。設定で貼り直してください".into()
        }
        "not_in_channel" | "channel_not_found" => {
            "チャンネルに参加していないか、見つかりません".into()
        }
        "missing_scope" if needed.is_empty() => {
            "Slack アプリのスコープが足りません。追加して、トークンを貼り直してください".into()
        }
        "missing_scope" => format!(
            "Slack アプリに {needed} のスコープがありません。追加して、トークンを貼り直してください"
        ),
        other => format!("Slack がエラーを返しました: {other}"),
    }
}

fn check_reply(reply: &Value) -> Result<(), String> {
    if reply["ok"] == true {
        return Ok(());
    }
    Err(error_message(
        reply["error"].as_str().unwrap_or("unknown"),
        reply["needed"].as_str().unwrap_or_default(),
    ))
}

/// A failed Web API call. `token_dead` says Slack refused the token itself, which retrying cannot fix.
struct SlackError {
    message: String,
    token_dead: bool,
    /// Slack's `error` code, when Slack answered with one.
    code: Option<String>,
    /// For `missing_scope`, the scope Slack says the token lacks; empty otherwise.
    needed: String,
}

impl From<String> for SlackError {
    fn from(message: String) -> Self {
        Self {
            message,
            token_dead: false,
            code: None,
            needed: String::new(),
        }
    }
}

impl From<SlackError> for String {
    fn from(e: SlackError) -> Self {
        e.message
    }
}

impl From<SlackError> for ApiError {
    fn from(e: SlackError) -> Self {
        e.message.into()
    }
}

/// What a Web API call sends. The methods that read (`users.conversations`, `conversations.info`) take a form, not JSON.
enum Payload<'a> {
    Empty,
    Json(&'a Value),
    Form(&'a [(&'static str, String)]),
}

/// Calls a Web API method with the token. A rate-limited (429) request is sent again as Gmail's are.
async fn call(
    http: &reqwest::Client,
    token: &str,
    method: &str,
    payload: Payload<'_>,
) -> Result<Value, SlackError> {
    call_scoped(http, token, method, payload)
        .await
        .map(|(reply, _)| reply)
}

/// `call`, and the `x-oauth-scopes` header of the answer (every Web API response has it: the scopes the token has).
async fn call_scoped(
    http: &reqwest::Client,
    token: &str,
    method: &str,
    payload: Payload<'_>,
) -> Result<(Value, Option<String>), SlackError> {
    let mut attempt = 0;
    loop {
        let req = http.post(format!("{API_URL}/{method}")).bearer_auth(token);
        let req = match &payload {
            Payload::Json(body) => req.json(body),
            Payload::Form(params) => req.form(params),
            Payload::Empty => req.header(reqwest::header::CONTENT_LENGTH, "0"),
        };
        let res = req
            .send()
            .await
            .map_err(|e| format!("Slack に接続できません: {e}"))?;
        let status = res.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < MAX_RETRIES {
            let retry_after = res
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_retry_after);
            tokio::time::sleep(retry_wait(attempt, retry_after)).await;
            attempt += 1;
            continue;
        }
        if !status.is_success() {
            return Err(format!("Slack が {status} を返しました").into());
        }
        let scopes = res
            .headers()
            .get("x-oauth-scopes")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let reply: Value = res
            .json()
            .await
            .map_err(|e| format!("Slack の返答を読めません: {e}"))?;
        check_reply(&reply).map_err(|message| SlackError {
            message,
            token_dead: token_is_dead(reply["error"].as_str().unwrap_or_default()),
            code: reply["error"].as_str().map(str::to_owned),
            needed: reply["needed"].as_str().unwrap_or_default().to_owned(),
        })?;
        return Ok((reply, scopes));
    }
}

/// Runs file or keychain work off the async threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
}

fn entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(TOKEN_SERVICE, user).map_err(|e| e.to_string())
}

/// The token stored under `user`. `None` means none is stored.
async fn read_secret(user: String) -> Result<Option<String>, String> {
    blocking(move || match entry(&user)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("資格情報の読み取りに失敗: {e}")),
    })
    .await
}

async fn write_secret(user: String, token: String) -> Result<(), String> {
    blocking(move || {
        entry(&user)?
            .set_password(&token)
            .map_err(|e| format!("資格情報の保存に失敗: {e}"))
    })
    .await
}

async fn delete_secret(user: String) -> Result<(), String> {
    blocking(move || delete_entry(&entry(&user)?)).await
}

/// The token of a workspace.
async fn token_of(team_id: &str) -> Result<String, String> {
    read_secret(token_key(team_id)?)
        .await?
        .ok_or_else(|| NO_TOKEN.to_owned())
}

/// `auth.test` with `token`: which workspace and user the token is, and the history scopes it lacks (`None` when Slack did not say).
async fn identify_scoped(
    http: &reqwest::Client,
    token: &str,
) -> Result<(Workspace, Option<Vec<&'static str>>), SlackError> {
    let (reply, scopes) = call_scoped(http, token, "auth.test", Payload::Empty).await?;
    let workspace = workspace_of(&reply).ok_or_else(|| {
        SlackError::from("Slack の返答にワークスペースの ID がありません".to_owned())
    })?;
    Ok((workspace, scopes.as_deref().map(missing_history_scopes)))
}

/// `auth.test` with `token`: which workspace and user the token is.
async fn identify(http: &reqwest::Client, token: &str) -> Result<Workspace, SlackError> {
    identify_scoped(http, token).await.map(|(w, _)| w)
}

fn load_list<T: DeserializeOwned>(dir: &Path, file: &str, key: &str) -> Result<Vec<T>, String> {
    let path = dir.join(file);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .and_then(|mut v| serde_json::from_value(v[key].take()))
            .map_err(|e| format!("{} の形式が不正です: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

fn save_list<T: Serialize>(dir: &Path, file: &str, key: &str, items: &[T]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(file), dir.join(format!("{file}.tmp")));
    let text = serde_json::to_string_pretty(&json!({ key: items })).map_err(|e| e.to_string())?;
    // Rename over the target so a crash mid-write leaves the old file, not a truncated one.
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

async fn load_workspaces(dir: &Path) -> Result<Vec<Workspace>, String> {
    let dir = dir.to_owned();
    blocking(move || load_list(&dir, WORKSPACES_FILE, WORKSPACES_KEY)).await
}

/// Keeps the token in the keychain and the workspace in the list (replacing the one with the same `team_id`).
async fn register(
    dir: &Path,
    token: String,
    workspace: Workspace,
) -> Result<Vec<Workspace>, String> {
    write_secret(token_key(&workspace.team_id)?, token).await?;
    let dir = dir.to_owned();
    blocking(move || {
        let list = with_workspace(load_list(&dir, WORKSPACES_FILE, WORKSPACES_KEY)?, workspace);
        save_list(&dir, WORKSPACES_FILE, WORKSPACES_KEY, &list).map(|()| list)
    })
    .await
}

fn remove_legacy_file(dir: PathBuf) -> Result<(), String> {
    match std::fs::remove_file(dir.join(LEGACY_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("{LEGACY_FILE} を消せません: {e}"))
        }
        _ => Ok(()),
    }
}

/// The first load of a run moves v0.11.0's token to its workspace's key and drops that version's destinations.
/// A token Slack refuses is dropped. One that cannot be moved for another reason (offline, 5xx) stays,
/// and a later load tries again once `MIGRATE_RETRY` has passed.
async fn migrate(dir: &Path, http: &reqwest::Client, state: &SlackState) {
    let mut migration = state.migrated.lock().await;
    if migration.done || !migrate_due(migration.tried.map(|at| at.elapsed())) {
        return;
    }
    migration.tried = Some(Instant::now());
    if let Err(e) = remove_legacy_file(dir.to_owned()) {
        log_failure("slack_migrate", LEGACY_USER, e);
    }
    match move_legacy_token(dir, http, &state.files).await {
        Ok(()) => migration.done = true,
        Err(e) => {
            log_failure("slack_migrate", LEGACY_USER, e);
        }
    }
}

async fn move_legacy_token(
    dir: &Path,
    http: &reqwest::Client,
    files: &tokio::sync::Mutex<()>,
) -> Result<(), String> {
    let Some(token) = read_secret(LEGACY_USER.into()).await? else {
        return Ok(());
    };
    let workspace = match identify(http, &token).await {
        Ok(workspace) => workspace,
        // Slack will not take this token later either: drop it instead of asking again.
        Err(e) if e.token_dead => {
            log_failure("slack_migrate", LEGACY_USER, e);
            return delete_secret(LEGACY_USER.into()).await;
        }
        Err(e) => return Err(e.into()),
    };
    let _files = files.lock().await;
    if moves_legacy_token(&load_workspaces(dir).await?, &workspace.team_id) {
        register(dir, token, workspace).await?;
    }
    delete_secret(LEGACY_USER.into()).await
}

/// The connected workspaces and the recent destinations. Asks Slack nothing, except the one-time move of v0.11.0's token.
#[tauri::command]
pub async fn slack_load(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, SlackState>,
) -> Result<SlackLoad, String> {
    let dir = config_dir(&app)?;
    migrate(&dir, auth.http(), &state).await;
    let workspaces = load_workspaces(&dir)
        .await
        .map_err(|e| log_failure("slack_load", "-", e))?;
    // The list only saves a search, so a broken file is logged and left out.
    let recent = blocking(move || load_list::<Recent>(&dir, RECENT_FILE, RECENT_KEY))
        .await
        .unwrap_or_else(|e| {
            log_failure("slack_load", "-", e);
            vec![]
        })
        .into_iter()
        .filter(|r| workspaces.iter().any(|w| w.team_id == r.team_id))
        .collect();
    Ok(SlackLoad { workspaces, recent })
}

/// A workspace as `auth.test` describes it now. `missing_scopes` is `None` when Slack sent no scopes to judge by.
#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    #[serde(flatten)]
    workspace: Workspace,
    missing_scopes: Option<Vec<&'static str>>,
}

/// Asks Slack who the stored token of the workspace is; an error says why it is not usable.
#[tauri::command]
pub async fn slack_check(auth: State<'_, Auth>, team_id: String) -> Result<Checked, String> {
    let result = match token_of(&team_id).await {
        Ok(token) => identify_scoped(auth.http(), &token)
            .await
            .map(|(workspace, missing_scopes)| Checked {
                workspace,
                missing_scopes,
            })
            .map_err(String::from),
        Err(e) => Err(e),
    };
    result.map_err(|e| log_failure("slack_check", &team_id, e))
}

/// Stores the User OAuth Token in the keychain once Slack accepts it, and returns the workspaces.
/// A token of a workspace that is connected already replaces the old one. It is never logged or returned.
#[tauri::command]
pub async fn slack_add_workspace(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, SlackState>,
    token: String,
) -> Result<Vec<Workspace>, String> {
    let token = token.trim().to_owned();
    if token.is_empty() {
        return Err("トークンを入力してください".into());
    }
    let workspace = identify(auth.http(), &token)
        .await
        .map_err(|e| log_failure("slack_add_workspace", "-", e))?;
    let team_id = workspace.team_id.clone();
    // The new token may reach channels the old one did not.
    state.channels.lock().unwrap().remove(&team_id);
    let _files = state.files.lock().await;
    register(&config_dir(&app)?, token, workspace)
        .await
        .map_err(|e| log_failure("slack_add_workspace", &team_id, e))
}

/// Forgets the workspace and its recent destinations, then revokes its token at Slack (a failure is logged, not fatal) and removes it from the keychain.
/// The lists are saved first: if that fails, the token is left alone and the workspace stays usable.
#[tauri::command]
pub async fn slack_remove_workspace(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, SlackState>,
    team_id: String,
) -> Result<Vec<Workspace>, String> {
    let command = "slack_remove_workspace";
    let user = token_key(&team_id).map_err(|e| log_failure(command, &team_id, e))?;
    let _files = state.files.lock().await;
    let token = read_secret(user.clone()).await.unwrap_or_else(|e| {
        log_failure(command, &team_id, e);
        None
    });
    let dir = config_dir(&app)?;
    let gone = team_id.clone();
    let list = blocking(move || {
        let list = without_workspace(load_list(&dir, WORKSPACES_FILE, WORKSPACES_KEY)?, &gone);
        save_list(&dir, WORKSPACES_FILE, WORKSPACES_KEY, &list)?;
        // The recent list is a convenience: a broken file is not worth failing the removal for.
        if let Ok(recent) = load_list::<Recent>(&dir, RECENT_FILE, RECENT_KEY) {
            save_list(&dir, RECENT_FILE, RECENT_KEY, &without_team(recent, &gone))?;
        }
        Ok(list)
    })
    .await
    .map_err(|e| log_failure(command, &team_id, e))?;
    state.channels.lock().unwrap().remove(&team_id);
    if let Some(token) = token {
        if let Err(e) = call(auth.http(), &token, "auth.revoke", Payload::Empty).await {
            log_failure("slack_revoke", &team_id, e);
        }
    }
    // The workspace is gone from the list already: a token left in the keychain is only logged.
    if let Err(e) = delete_secret(user).await {
        log_failure(command, &team_id, e);
    }
    Ok(list)
}

/// All the channels the token's user is in, page by page.
async fn fetch_channels(http: &reqwest::Client, token: &str) -> Result<Vec<Channel>, String> {
    let mut all = vec![];
    let mut cursor = None;
    // shortcut: channels past the last page are left out; raise CHANNEL_PAGES if a workspace has more.
    for _ in 0..CHANNEL_PAGES {
        let params = channels_params(cursor.as_deref());
        let reply = call(http, token, "users.conversations", Payload::Form(&params)).await?;
        all.extend(channels_of(&reply));
        cursor = next_cursor(&reply);
        if cursor.is_none() {
            break;
        }
    }
    all.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(all)
}

/// The channels the workspace's user is in. The list is kept for `CHANNELS_TTL`; `refresh` asks Slack again.
#[tauri::command]
pub async fn slack_channels(
    auth: State<'_, Auth>,
    state: State<'_, SlackState>,
    team_id: String,
    refresh: bool,
) -> Result<Vec<Channel>, String> {
    let command = "slack_channels";
    if !refresh {
        let cache = state.channels.lock().unwrap();
        if let Some((_, list)) = cache
            .get(&team_id)
            .filter(|(at, _)| channels_fresh(at.elapsed()))
        {
            return Ok(list.clone());
        }
    }
    let token = token_of(&team_id)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    let list = fetch_channels(auth.http(), &token)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    state
        .channels
        .lock()
        .unwrap()
        .insert(team_id, (Instant::now(), list.clone()));
    Ok(list)
}

/// Where a pasted Slack link leads: the connected workspace of its host, the channel, and the thread of the message.
#[tauri::command]
pub async fn slack_link(
    app: AppHandle,
    auth: State<'_, Auth>,
    url: String,
) -> Result<Target, String> {
    let command = "slack_link";
    let link = parse_url(&url)?;
    let workspaces = load_workspaces(&config_dir(&app)?)
        .await
        .map_err(|e| log_failure(command, "-", e))?;
    let team_id = workspace_for_host(&workspaces, &link.host)
        .ok_or(NO_WORKSPACE)?
        .team_id
        .clone();
    let token = token_of(&team_id)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    // The name is for the recent list only: the channel ID stands in when Slack cannot say.
    let form = [("channel", link.channel.clone())];
    let name = match call(
        auth.http(),
        &token,
        "conversations.info",
        Payload::Form(&form),
    )
    .await
    {
        Ok(reply) => reply["channel"]["name"].as_str().map(str::to_owned),
        Err(e) => {
            log_failure(command, &team_id, e);
            None
        }
    };
    Ok(Target {
        team_id,
        name: name.unwrap_or_else(|| link.channel.clone()),
        channel: link.channel,
        thread_ts: link.thread_ts,
    })
}

/// The text of the Slack message `url` points at, with its thread's first message when it is a reply, read with the token of the link's workspace.
/// A reply is read on its own, so one deep in a long thread is found; two requests of one message each, not the whole thread.
pub async fn message_context(
    dir: &Path,
    http: &reqwest::Client,
    url: &str,
) -> Result<String, String> {
    let link = parse_url(url)?;
    let message_ts = link.message_ts.ok_or(BAD_MESSAGE_URL)?;
    let thread_ts = link.thread_ts.unwrap_or_else(|| message_ts.clone());
    let workspaces = load_workspaces(dir).await?;
    let workspace = workspace_for_host(&workspaces, &link.host).ok_or(NO_WORKSPACE)?;
    let token = token_of(&workspace.team_id).await?;
    let read = |only: Option<&str>| {
        let params = replies_params(&link.channel, &thread_ts, only);
        let token = &token;
        async move {
            let reply = call(http, token, "conversations.replies", Payload::Form(&params))
                .await
                .map_err(|e| read_error(e, &workspace.team))?;
            Ok::<_, String>(reply["messages"].as_array().cloned().unwrap_or_default())
        }
    };
    let first = read(None).await?;
    let found = if message_ts == thread_ts {
        first.clone()
    } else {
        read(Some(&message_ts)).await?
    };
    thread_context(&first, &found, &message_ts).ok_or_else(|| NO_MESSAGE.to_owned())
}

/// What a post of the mail would say, without the note and as plain text.
#[tauri::command]
pub fn slack_preview(subject: &str, from: &str, date: &str, body: &str) -> String {
    mail_text("", subject, from, date, body, false)
}

/// Posts the mail to the channel, or as a reply in `thread_ts`'s thread, and remembers the destination.
/// The mail's text goes to Slack only here, on the user's click.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn slack_post(
    app: AppHandle,
    auth: State<'_, Auth>,
    team_id: String,
    channel: String,
    thread_ts: Option<String>,
    name: String,
    note: String,
    subject: String,
    from: String,
    date: String,
    body: String,
) -> Result<bool, String> {
    let command = "slack_post";
    let user = token_key(&team_id);
    if user.is_err()
        || !valid_channel(&channel)
        || thread_ts.as_deref().is_some_and(|t| !valid_ts(t))
    {
        return Err(log_failure(command, &team_id, BAD_TARGET));
    }
    let token = token_of(&team_id)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    let mut message = json!({
        "channel": channel,
        "text": mail_text(&note, &subject, &from, &date, &body, true),
        "unfurl_links": false,
        "unfurl_media": false,
    });
    if let Some(ts) = &thread_ts {
        message["thread_ts"] = ts.clone().into();
    }
    call(
        auth.http(),
        &token,
        "chat.postMessage",
        Payload::Json(&message),
    )
    .await
    .map_err(|e| log_failure(command, &team_id, e))?;
    // The post is done: failing to remember where is only logged.
    let new = Recent {
        team_id: team_id.clone(),
        channel,
        name: name.trim().chars().take(NAME_LIMIT).collect(),
        thread_ts,
    };
    let remembered = match config_dir(&app) {
        Ok(dir) => {
            blocking(move || {
                let list = remember(
                    load_list(&dir, RECENT_FILE, RECENT_KEY).unwrap_or_default(),
                    new,
                );
                save_list(&dir, RECENT_FILE, RECENT_KEY, &list)
            })
            .await
        }
        Err(e) => Err(e),
    };
    if let Err(e) = remembered {
        log_failure(command, &team_id, e);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-slack-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn parsed(raw: &str) -> (String, Option<String>) {
        let link = parse_url(raw).unwrap();
        (link.channel, link.thread_ts)
    }

    fn workspace(team_id: &str, url: &str) -> Workspace {
        Workspace {
            team_id: team_id.into(),
            team: format!("team {team_id}"),
            user: "u".into(),
            url: url.into(),
        }
    }

    fn recent(team_id: &str, channel: &str, thread_ts: Option<&str>) -> Recent {
        Recent {
            team_id: team_id.into(),
            channel: channel.into(),
            name: format!("name {channel}"),
            thread_ts: thread_ts.map(str::to_owned),
        }
    }

    #[test]
    fn a_message_link_replies_to_that_message() {
        assert_eq!(
            parsed("https://example.slack.com/archives/C0123ABC/p1761785520123456"),
            ("C0123ABC".into(), Some("1761785520.123456".into()))
        );
    }

    #[test]
    fn a_reply_link_uses_its_thread_ts_as_the_parent() {
        assert_eq!(
            parsed("https://example.slack.com/archives/C0123ABC/p1761785999000001?thread_ts=1761785520.123456&cid=C0123ABC"),
            ("C0123ABC".into(), Some("1761785520.123456".into()))
        );
    }

    #[test]
    fn a_channel_link_posts_a_new_message() {
        assert_eq!(
            parsed(" https://example.slack.com/archives/C0123ABC/ "),
            ("C0123ABC".into(), None)
        );
        assert_eq!(
            parsed("https://slack.com/archives/C0123ABC"),
            ("C0123ABC".into(), None)
        );
    }

    #[test]
    fn a_link_carries_its_lower_cased_host() {
        assert_eq!(
            parse_url("https://Example.Slack.com/archives/C0123ABC")
                .unwrap()
                .host,
            "example.slack.com"
        );
    }

    #[test]
    fn links_that_are_not_slack_message_or_channel_links_are_refused() {
        for bad in [
            "",
            "example.slack.com/archives/C0123ABC",
            "http://example.slack.com/archives/C0123ABC",
            "https://evilslack.com/archives/C0123ABC",
            "https://slack.com.evil.com/archives/C0123ABC",
            "https://user@example.slack.com/archives/C0123ABC",
            "https://example.slack.com:8443/archives/C0123ABC",
            "https://example.slack.com/archives/c0123abc",
            "https://example.slack.com/archives/C01/23",
            "https://example.slack.com/archives/C0123ABC/p123",
            "https://example.slack.com/archives/C0123ABC/p17617855201234xx",
            "https://example.slack.com/archives/C0123ABC/q1761785520123456",
            "https://example.slack.com/archives/C0123ABC/p1761785520123456/x",
            "https://example.slack.com/archives/C0123ABC?thread_ts=abc",
            "https://example.slack.com/messages/C0123ABC",
            "https://example.slack.com/",
        ] {
            assert!(parse_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_token_is_kept_under_its_team_id_and_never_under_the_legacy_name() {
        assert_eq!(token_key("T0123ABC"), Ok("T0123ABC".into()));
        for bad in ["", LEGACY_USER, "t0123", "T01/23", "T01 23", "T0123\n"] {
            assert!(token_key(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_link_finds_the_workspace_of_its_host() {
        let list = vec![
            workspace("T1", "https://alpha.slack.com/"),
            workspace("T2", "https://beta.slack.com/"),
            workspace("T3", ""),
        ];
        let found = |host: &str| workspace_for_host(&list, host).map(|w| w.team_id.as_str());
        assert_eq!(found("beta.slack.com"), Some("T2"));
        assert_eq!(found("alpha.slack.com"), Some("T1"));
        assert_eq!(found("gamma.slack.com"), None);
        assert_eq!(found("slack.com"), None);
        assert_eq!(found(""), None);
    }

    #[test]
    fn auth_test_makes_a_workspace_only_with_a_team_id() {
        let reply = json!({"ok": true, "team_id": "T1", "team": "A", "user": "u", "url": "https://a.slack.com/"});
        assert_eq!(
            workspace_of(&reply),
            Some(Workspace {
                team_id: "T1".into(),
                team: "A".into(),
                user: "u".into(),
                url: "https://a.slack.com/".into()
            })
        );
        assert_eq!(workspace_of(&json!({"ok": true})), None);
        assert_eq!(workspace_of(&json!({"team_id": "t/1"})), None);
    }

    #[test]
    fn a_workspace_is_replaced_in_place_by_its_team_id_and_removed_by_it() {
        let a = workspace("T1", "https://a.slack.com/");
        let b = workspace("T2", "https://b.slack.com/");
        let mut b2 = b.clone();
        b2.user = "new".into();
        let list = with_workspace(vec![a.clone(), b], b2.clone());
        assert_eq!(list, vec![a.clone(), b2]);
        let list = with_workspace(list, workspace("T3", "https://c.slack.com/"));
        assert_eq!(list.len(), 3);
        assert_eq!(without_workspace(list.clone(), "T9"), list);
        assert_eq!(without_workspace(list, "T2").len(), 2);
    }

    #[test]
    fn the_legacy_token_moves_unless_its_workspace_is_registered() {
        let registered = vec![workspace("T1", "https://a.slack.com/")];
        assert!(moves_legacy_token(&registered, "T2"));
        assert!(moves_legacy_token(&[], "T1"));
        assert!(!moves_legacy_token(&registered, "T1"));
    }

    #[test]
    fn the_newest_destination_goes_first_and_a_repeat_is_not_listed_twice() {
        let a = recent("T1", "C1", None);
        let b = recent("T1", "C2", None);
        let list = remember(remember(vec![], a.clone()), b.clone());
        assert_eq!(list, vec![b.clone(), a.clone()]);
        let mut a2 = a.clone();
        a2.name = "renamed".into();
        assert_eq!(remember(list, a2.clone()), vec![a2, b]);
    }

    #[test]
    fn a_thread_and_its_channel_and_two_workspaces_are_different_destinations() {
        let list = remember(vec![], recent("T1", "C1", None));
        let list = remember(list, recent("T1", "C1", Some("1.2")));
        let list = remember(list, recent("T2", "C1", None));
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn only_the_newest_eight_destinations_stay() {
        let mut list = vec![];
        for i in 0..12 {
            list = remember(list, recent("T1", &format!("C{i}"), None));
        }
        assert_eq!(list.len(), RECENT_MAX);
        assert_eq!(list[0].channel, "C11");
        assert_eq!(list[RECENT_MAX - 1].channel, "C4");
    }

    #[test]
    fn a_removed_workspace_takes_its_destinations_with_it() {
        let list = vec![recent("T1", "C1", None), recent("T2", "C2", None)];
        assert_eq!(without_team(list, "T1"), vec![recent("T2", "C2", None)]);
    }

    #[test]
    fn the_channel_request_asks_for_joined_channels_and_continues_from_the_cursor() {
        let first = channels_params(None);
        assert!(first.contains(&("types", "public_channel,private_channel".to_owned())));
        assert!(first.contains(&("exclude_archived", "true".to_owned())));
        assert!(first.iter().all(|(k, _)| *k != "cursor"));
        assert!(channels_params(Some("dXNlcjpV")).contains(&("cursor", "dXNlcjpV".to_owned())));
    }

    #[test]
    fn channels_are_read_from_a_page_and_the_last_page_has_no_cursor() {
        let page = json!({
            "ok": true,
            "channels": [
                {"id": "C1", "name": "general"},
                {"id": "c2", "name": "bad id"},
                {"id": "G3"},
                {"id": "G4", "name": "secret", "is_private": true}
            ],
            "response_metadata": {"next_cursor": "abc"}
        });
        assert_eq!(
            channels_of(&page),
            vec![
                Channel {
                    id: "C1".into(),
                    name: "general".into()
                },
                Channel {
                    id: "G4".into(),
                    name: "secret".into()
                }
            ]
        );
        assert_eq!(next_cursor(&page), Some("abc".into()));
        assert_eq!(
            next_cursor(&json!({"response_metadata": {"next_cursor": ""}})),
            None
        );
        assert_eq!(next_cursor(&json!({"ok": true})), None);
        assert_eq!(channels_of(&json!({"ok": true})), vec![]);
    }

    #[test]
    fn a_channel_list_is_kept_for_ten_minutes() {
        assert!(channels_fresh(Duration::from_secs(599)));
        assert!(!channels_fresh(CHANNELS_TTL));
    }

    #[test]
    fn mrkdwn_escapes_ampersand_first_then_angle_brackets() {
        assert_eq!(
            escape_mrkdwn("A & B <b@x.jp> &lt;"),
            "A &amp; B &lt;b@x.jp&gt; &amp;lt;"
        );
    }

    #[test]
    fn body_is_tidied_and_cut_at_the_limit_with_an_ellipsis() {
        assert_eq!(clip_body("  a  \r\n\n\n\n b \n"), "a\n\n b");
        assert_eq!(clip_body(&"あ".repeat(BODY_LIMIT)), "あ".repeat(BODY_LIMIT));
        let cut = clip_body(&"あ".repeat(BODY_LIMIT + 1));
        assert_eq!(cut, format!("{}…", "あ".repeat(BODY_LIMIT)));
        // Past the tidy window: cut all the same, and blank runs beyond it are never read.
        let huge = clip_body(&"あ".repeat(BODY_LIMIT * 3));
        assert_eq!(huge, format!("{}…", "あ".repeat(BODY_LIMIT)));
        let sparse = format!("a{}b", "\n".repeat(BODY_LIMIT * 2));
        assert_eq!(clip_body(&sparse), "a…");
    }

    #[test]
    fn the_post_is_note_subject_sender_and_body() {
        assert_eq!(
            mail_text("確認お願いします", "見積 <1>", "A <a@x.jp>", "2026/10/30 9:05", "本文 & 続き", true),
            "確認お願いします\n\n*見積 &lt;1&gt;*\nA &lt;a@x.jp&gt; ・ 2026/10/30 9:05\n\n本文 &amp; 続き"
        );
        // No note, no subject, no body: only the header lines remain; the preview is not escaped.
        assert_eq!(
            mail_text(" ", "", "A <a@x.jp>", "d", "", false),
            "*(件名なし)*\nA <a@x.jp> ・ d"
        );
    }

    #[test]
    fn error_codes_map_to_messages() {
        for code in ["invalid_auth", "not_authed", "token_revoked"] {
            assert_eq!(
                error_message(code, ""),
                "トークンが無効です。設定で貼り直してください"
            );
        }
        for code in ["not_in_channel", "channel_not_found"] {
            assert_eq!(
                error_message(code, ""),
                "チャンネルに参加していないか、見つかりません"
            );
        }
        assert_eq!(
            error_message("ratelimited", ""),
            "Slack がエラーを返しました: ratelimited"
        );
    }

    #[test]
    fn a_missing_scope_names_the_scopes_slack_says_are_needed() {
        assert_eq!(
            error_message("missing_scope", "channels:read,groups:read"),
            "Slack アプリに channels:read,groups:read のスコープがありません。追加して、トークンを貼り直してください"
        );
        assert_eq!(
            check_reply(&json!({"ok": false, "error": "missing_scope", "needed": "chat:write", "provided": "identify"})),
            Err("Slack アプリに chat:write のスコープがありません。追加して、トークンを貼り直してください".into())
        );
        assert!(error_message("missing_scope", "").contains("スコープが足りません"));
    }

    #[test]
    fn ok_false_is_an_error_even_with_status_200() {
        assert_eq!(check_reply(&json!({"ok": true, "team": "t"})), Ok(()));
        assert_eq!(
            check_reply(&json!({"ok": false, "error": "token_revoked"})),
            Err("トークンが無効です。設定で貼り直してください".into())
        );
        assert!(check_reply(&json!({})).unwrap_err().contains("unknown"));
    }

    #[test]
    fn only_codes_that_refuse_the_token_are_permanent() {
        for code in [
            "invalid_auth",
            "not_authed",
            "token_revoked",
            "account_inactive",
        ] {
            assert!(token_is_dead(code), "{code}");
        }
        for code in [
            "ratelimited",
            "missing_scope",
            "internal_error",
            "unknown",
            "",
        ] {
            assert!(!token_is_dead(code), "{code}");
        }
    }

    #[test]
    fn the_legacy_token_is_tried_again_only_after_the_wait() {
        assert!(migrate_due(None));
        assert!(!migrate_due(Some(Duration::ZERO)));
        assert!(!migrate_due(Some(MIGRATE_RETRY - Duration::from_secs(1))));
        assert!(migrate_due(Some(MIGRATE_RETRY)));
    }

    #[test]
    fn timestamps_need_digits_around_one_dot() {
        assert!(valid_ts("1761785520.123456"));
        for bad in ["", "1761785520", ".1", "1.", "a.b", "1.2.3"] {
            assert!(!valid_ts(bad), "{bad}");
        }
    }

    #[test]
    fn lists_are_saved_and_loaded_and_the_save_replaces_the_file() {
        let dir = temp_dir("save");
        assert_eq!(
            load_list::<Recent>(&dir, RECENT_FILE, RECENT_KEY),
            Ok(vec![])
        );
        let a = recent("T1", "C1", Some("1.2"));
        let b = recent("T1", "C2", None);
        save_list(&dir, RECENT_FILE, RECENT_KEY, std::slice::from_ref(&a)).unwrap();
        save_list(&dir, RECENT_FILE, RECENT_KEY, &[a.clone(), b.clone()]).unwrap();
        assert_eq!(load_list(&dir, RECENT_FILE, RECENT_KEY), Ok(vec![a, b]));
        assert!(!dir.join(format!("{RECENT_FILE}.tmp")).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_save_leaves_the_existing_file_and_a_broken_file_is_reported() {
        let dir = temp_dir("atomic");
        let w = workspace("T1", "https://a.slack.com/");
        save_list(
            &dir,
            WORKSPACES_FILE,
            WORKSPACES_KEY,
            std::slice::from_ref(&w),
        )
        .unwrap();
        std::fs::create_dir(dir.join(format!("{WORKSPACES_FILE}.tmp"))).unwrap();
        assert!(save_list::<Workspace>(&dir, WORKSPACES_FILE, WORKSPACES_KEY, &[]).is_err());
        assert_eq!(
            load_list(&dir, WORKSPACES_FILE, WORKSPACES_KEY),
            Ok(vec![w])
        );
        for broken in ["not json", "{}", r#"{"workspaces": 1}"#] {
            std::fs::write(dir.join(WORKSPACES_FILE), broken).unwrap();
            assert!(
                load_list::<Workspace>(&dir, WORKSPACES_FILE, WORKSPACES_KEY)
                    .unwrap_err()
                    .contains("形式が不正"),
                "{broken}"
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_legacy_destinations_file_is_removed_and_its_absence_is_fine() {
        let dir = temp_dir("legacy");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(remove_legacy_file(dir.clone()), Ok(()));
        std::fs::write(dir.join(LEGACY_FILE), "{}").unwrap();
        assert_eq!(remove_legacy_file(dir.clone()), Ok(()));
        assert!(!dir.join(LEGACY_FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_link_keeps_the_messages_own_ts_besides_the_parent() {
        let reply = parse_url(
            "https://example.slack.com/archives/C0123ABC/p1761785520123456?thread_ts=1761780000.000100&cid=C0123ABC",
        )
        .unwrap();
        assert_eq!(reply.thread_ts.as_deref(), Some("1761780000.000100"));
        assert_eq!(reply.message_ts.as_deref(), Some("1761785520.123456"));
        let plain =
            parse_url("https://example.slack.com/archives/C0123ABC/p1761785520123456").unwrap();
        assert_eq!(plain.message_ts, plain.thread_ts);
        let channel = parse_url("https://example.slack.com/archives/C0123ABC").unwrap();
        assert_eq!(channel.message_ts, None);
    }

    #[test]
    fn reading_needs_the_history_scopes_of_channels_and_direct_messages() {
        let all = "chat:write,channels:history,groups:history,im:history,mpim:history";
        assert!(missing_history_scopes(all).is_empty());
        assert!(missing_history_scopes(
            "mpim:history, im:history,groups:history, channels:history"
        )
        .is_empty());
        assert_eq!(
            missing_history_scopes("chat:write,channels:read,groups:read"),
            HISTORY_SCOPES
        );
        assert_eq!(
            missing_history_scopes("channels:history,groups:history"),
            ["im:history", "mpim:history"]
        );
        assert_eq!(
            missing_history_scopes("channels:history,groups:history,im:history"),
            ["mpim:history"]
        );
        assert_eq!(
            missing_history_scopes("channels:history,groups:history,mpim:history"),
            ["im:history"]
        );
        assert_eq!(
            missing_history_scopes("im:history,mpim:history"),
            ["channels:history", "groups:history"]
        );
        assert_eq!(missing_history_scopes(""), HISTORY_SCOPES);
        assert_eq!(
            missing_history_scopes("channels:history:x,groups:history,im:history,mpim:history"),
            ["channels:history"]
        );
    }

    fn failure(code: Option<&str>) -> SlackError {
        SlackError {
            message: "元の文".into(),
            token_dead: false,
            code: code.map(str::to_owned),
            needed: String::new(),
        }
    }

    #[test]
    fn a_missing_scope_names_the_workspace_and_the_scope() {
        assert_eq!(
            read_error(failure(Some("missing_scope")), "Example"),
            "Example のトークンにメッセージを読む権限がありません。設定でトークンを貼り直してください"
        );
        let mut lacking = failure(Some("missing_scope"));
        lacking.needed = "im:history".into();
        assert_eq!(
            read_error(lacking, "Example"),
            "Example のトークンに im:history の権限がありません。設定でトークンを貼り直してください"
        );
        assert_eq!(read_error(failure(Some("not_in_channel")), "x"), "元の文");
        assert_eq!(read_error(failure(None), "x"), "元の文");
    }

    #[test]
    fn the_threads_first_message_is_asked_for_alone() {
        assert_eq!(
            replies_params("C0123ABC", "1761780000.000100", None),
            [
                ("channel", "C0123ABC".to_owned()),
                ("ts", "1761780000.000100".to_owned()),
                ("limit", "1".to_owned())
            ]
        );
    }

    #[test]
    fn a_reply_is_asked_for_by_its_own_time() {
        assert_eq!(
            replies_params("C0123ABC", "1761780000.000100", Some("1761780009.000200")),
            [
                ("channel", "C0123ABC".to_owned()),
                ("ts", "1761780000.000100".to_owned()),
                ("limit", "1".to_owned()),
                ("oldest", "1761780009.000200".to_owned()),
                ("latest", "1761780009.000200".to_owned()),
                ("inclusive", "true".to_owned())
            ]
        );
    }

    #[test]
    fn a_reply_comes_with_the_threads_first_message() {
        let first = [json!({"ts": "1.1", "user": "U1", "text": "PR を見てほしい"})];
        let reply = [json!({"ts": "1.2", "user": "U2", "text": " 明日までに "})];
        assert_eq!(
            thread_context(&first, &reply, "1.2").unwrap(),
            "[スレッドの最初のメッセージ]\nU1: PR を見てほしい\n\n[対象のメッセージ]\nU2: 明日までに"
        );
    }

    #[test]
    fn the_first_message_stands_alone() {
        let first = [json!({"ts": "1.1", "user": "U1", "text": "a"})];
        assert_eq!(
            thread_context(&first, &first, "1.1").unwrap(),
            "[対象のメッセージ]\nU1: a"
        );
    }

    #[test]
    fn a_long_first_message_is_cut_so_the_linked_one_stays() {
        let first = [json!({"ts": "1.1", "user": "U1", "text": "あ".repeat(PARENT_LIMIT * 3)})];
        let reply = [json!({"ts": "1.2", "user": "U2", "text": "明日までに"})];
        let context = thread_context(&first, &reply, "1.2").unwrap();
        assert!(
            context.chars().count() < PARENT_LIMIT + 100,
            "{}",
            context.chars().count()
        );
        assert!(context.ends_with("[対象のメッセージ]\nU2: 明日までに"));
    }

    #[test]
    fn a_message_that_is_not_there_gives_nothing() {
        assert_eq!(thread_context(&[], &[], "1.1"), None);
        let other = [json!({"ts": "1.2", "text": "b"})];
        assert_eq!(thread_context(&other, &other, "1.1"), None);
    }

    #[test]
    fn a_message_without_a_user_or_text_is_still_a_line() {
        assert_eq!(message_line(&json!({"ts": "1.1"})), "?: ");
    }
}
