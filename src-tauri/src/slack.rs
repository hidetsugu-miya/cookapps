use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
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
    claude::Thread,
    gmail::{log_failure, parse_retry_after, retry_wait, ApiError, MAX_RETRIES},
    images::{fetch_slack_files, run_limited, SlackFileCache},
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
/// Characters of the mail's text that the post starts out with.
const BODY_LIMIT: usize = 3000;
/// The most characters the user may post in one message.
const POST_LIMIT: usize = 10_000;
/// Messages `conversations.replies` answers with per page, and how many pages are read: a thread past `REPLY_PAGES * REPLY_PAGE_SIZE` messages is read to there.
const REPLY_PAGE_SIZE: &str = "200";
const REPLY_PAGES: usize = 20;
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
    channels: Arc<ChannelCache>,
    /// What the timeline and the thread keep between two reads, in memory only.
    timeline: Arc<TimelineCache>,
    /// The attached images fetched so far, by workspace and URL, in memory only. Mail's `fetch_images` cannot read them.
    images: SlackFileCache,
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

const BOT_TOKEN: &str =
    "Bot User OAuth Token は使えません。「OAuth & Permissions」の User OAuth Token（xoxp- で始まる）を貼ってください";

/// A Bot User OAuth Token (`xoxb-`). It sees only the channels the bot has joined, so it is not accepted.
fn is_bot_token(token: &str) -> bool {
    token.starts_with("xoxb-")
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

/// The scopes of `wanted` that an `x-oauth-scopes` header lacks.
fn missing_scopes(scopes: &str, wanted: &[&'static str]) -> Vec<&'static str> {
    wanted
        .iter()
        .copied()
        .filter(|wanted| !scopes.split(',').any(|s| s.trim() == *wanted))
        .collect()
}

/// The history scopes an `x-oauth-scopes` header lacks; reading a message needs all four.
fn missing_history_scopes(scopes: &str) -> Vec<&'static str> {
    missing_scopes(scopes, &HISTORY_SCOPES)
}

/// The scopes only the timeline and the thread use: names and icons (`users:read`) and attached images (`files:read`).
/// A token without them still posts, summarises and lists messages, so they are kept apart from `HISTORY_SCOPES`.
const OPTIONAL_SCOPES: [&str; 2] = ["users:read", "files:read"];

/// Every scope the timeline wants, which the list answer says a workspace's token lacks.
const TIMELINE_SCOPES: [&str; 6] = [
    "channels:read",
    "groups:read",
    "channels:history",
    "groups:history",
    "users:read",
    "files:read",
];

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

/// The form of a `conversations.replies` request for the thread `ts`: a page of it (`REPLY_PAGE_SIZE` messages, oldest first, the first being the thread's own
/// message), after `cursor` when it is a later page; or with `only` (a message's `ts`) that message alone, which finds one the pages did not reach.
fn replies_params(
    channel: &str,
    ts: &str,
    only: Option<&str>,
    cursor: Option<&str>,
) -> Vec<(&'static str, String)> {
    let mut params = vec![("channel", channel.to_owned()), ("ts", ts.to_owned())];
    match only {
        Some(only) => params.extend([
            ("limit", "1".to_owned()),
            ("oldest", only.to_owned()),
            ("latest", only.to_owned()),
            ("inclusive", "true".to_owned()),
        ]),
        None => {
            params.push(("limit", REPLY_PAGE_SIZE.to_owned()));
            if let Some(cursor) = cursor {
                params.push(("cursor", cursor.to_owned()));
            }
        }
    }
    params
}

/// Whether a `conversations.replies` answer says the thread goes on past it (a cursor, or `has_more` without one).
fn truncated(reply: &Value) -> bool {
    next_cursor(reply).is_some() || reply["has_more"] == true
}

/// How many replies were left unread when the read stopped short (`more`): the parent message's `reply_count` less the `read` replies
/// (and the linked reply, when it was `alone` read afterwards). Slack gives no count of its own, so when the total is missing or already reached it is at least 1:
/// the thread did go on, and the note must show. The one exception is a linked reply read `alone` when the total is known: if the count says nothing else is left, it is 0.
fn unread_replies(more: bool, reply_count: Option<u64>, read: usize, alone: bool) -> usize {
    if !more {
        return 0;
    }
    let total = reply_count.map_or(0, |n| usize::try_from(n).unwrap_or(usize::MAX));
    let left = total.saturating_sub(read + usize::from(alone));
    if alone && reply_count.is_some() {
        left
    } else {
        left.max(1)
    }
}

/// The text of a message as sent to the summary: who wrote it (an ID: names need a scope the app does not ask for) and what.
/// The lines of the text after the first are indented by two spaces, so a line at the start of a line is always a heading or a sender and
/// no text of a message can pass as one (the summary instructions say so). A line break of any kind counts: `\r\n`, `\r`, and the ones `str::lines` of a reader may take for one
/// (U+2028, U+2029, U+0085, a vertical tab and a form feed).
fn message_line(m: &Value) -> String {
    let text = m["text"]
        .as_str()
        .unwrap_or_default()
        .replace("\r\n", "\n")
        .replace(
            ['\r', '\u{2028}', '\u{2029}', '\u{85}', '\u{b}', '\u{c}'],
            "\n",
        );
    format!(
        "{}: {}",
        m["user"].as_str().unwrap_or("?"),
        text.trim().split('\n').collect::<Vec<_>>().join("\n  ")
    )
}

/// The four fields of a message of `conversations.replies` that the summary uses; the rest (blocks, files, attachments) is not kept.
fn slim(m: &Value) -> Value {
    json!({
        "ts": m["ts"],
        "user": m["user"],
        "text": m["text"],
        "reply_count": m["reply_count"],
    })
}

/// `messages` (a page of `conversations.replies`) added to `read` without the messages whose `ts` is in `seen` (a later page may repeat the parent), each kept as `keep` makes it
/// (`slim` for the summary).
/// `seen` holds the `ts` of every message added so far, so one set serves all the pages.
fn add_page(
    read: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    messages: &Value,
    keep: fn(&Value) -> Value,
) {
    for m in messages.as_array().into_iter().flatten() {
        match m["ts"].as_str() {
            Some(ts) if !seen.insert(ts.to_owned()) => {}
            _ => read.push(keep(m)),
        }
    }
}

/// The thread the summary reads: every message of `read` (the pages, oldest first, the first being the thread's own message) as a line, in order, with the blank ones skipped except the linked one,
/// and the linked message `message_ts` marked by its index. A linked message the pages did not reach is taken from `alone` and put last.
/// `has_first` is whether the thread's own message is the first line (it is not when it is blank). `None` when the linked message is in neither.
/// `unread` is the count of replies the read left unread.
fn thread_of(read: &[Value], alone: &[Value], message_ts: &str, unread: usize) -> Option<Thread> {
    let mut lines = Vec::new();
    let mut target = None;
    let mut has_first = false;
    for (i, m) in read.iter().enumerate() {
        let linked = m["ts"] == message_ts;
        if !linked && m["text"].as_str().is_none_or(|t| t.trim().is_empty()) {
            continue;
        }
        if linked {
            target = Some(lines.len());
        }
        has_first |= i == 0;
        lines.push(message_line(m));
    }
    let target = match target {
        Some(target) => target,
        None => {
            lines.push(message_line(alone.iter().find(|m| m["ts"] == message_ts)?));
            lines.len() - 1
        }
    };
    Some(Thread {
        lines,
        target,
        has_first,
        unread,
    })
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

/// The mail as the post starts out: `*subject*`, `from ・ date`, and the clipped body, as plain text. The user edits it before it is posted (`post_text`).
fn mail_text(subject: &str, from: &str, date: &str, body: &str) -> String {
    let subject = match subject.trim() {
        "" => "(件名なし)",
        s => s,
    };
    let mut parts = vec![format!("*{subject}*\n{from} ・ {date}")];
    let body = clip_body(body);
    if !body.is_empty() {
        parts.push(body);
    }
    parts.join("\n\n")
}

/// The text to post, escaped for Slack (`*` stays markup), or why it cannot be posted: blank, or past `POST_LIMIT` characters.
fn post_text(text: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("貼る内容が空です".into());
    }
    if text.chars().count() > POST_LIMIT {
        return Err(format!("貼る内容が長すぎます（{POST_LIMIT} 文字まで）"));
    }
    Ok(escape_mrkdwn(text.trim()))
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
    /// Set for a rate-limited (429) answer that was not retried: how long Slack asked to wait (`rate_limit_wait`).
    rate_limited: Option<Duration>,
}

impl From<String> for SlackError {
    fn from(message: String) -> Self {
        Self {
            message,
            token_dead: false,
            code: None,
            needed: String::new(),
            rate_limited: None,
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
    call_scoped_retrying(http, token, method, payload, MAX_RETRIES).await
}

/// `call_scoped` with the number of rate-limit retries given. With none, a 429 is an error that carries how long Slack asked to wait.
async fn call_scoped_retrying(
    http: &reqwest::Client,
    token: &str,
    method: &str,
    payload: Payload<'_>,
    retries: usize,
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
        let limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS;
        let retry_after = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after);
        if limited && attempt < retries {
            tokio::time::sleep(retry_wait(attempt, retry_after)).await;
            attempt += 1;
            continue;
        }
        if !status.is_success() {
            let mut error = SlackError::from(format!("Slack が {status} を返しました"));
            error.rate_limited = limited.then(|| rate_limit_wait(retry_after));
            return Err(error);
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
            rate_limited: None,
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

/// `auth.test` with `token`: which workspace and user the token is, and the `x-oauth-scopes` the token has (`None` when Slack did not say).
async fn identify_scoped(
    http: &reqwest::Client,
    token: &str,
) -> Result<(Workspace, Option<String>), SlackError> {
    let (reply, scopes) = call_scoped(http, token, "auth.test", Payload::Empty).await?;
    let workspace = workspace_of(&reply).ok_or_else(|| {
        SlackError::from("Slack の返答にワークスペースの ID がありません".to_owned())
    })?;
    Ok((workspace, scopes))
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
/// `missing_optional` is the same for `OPTIONAL_SCOPES` (`users:read`, `files:read`), which the token can do without.
#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    #[serde(flatten)]
    workspace: Workspace,
    missing_scopes: Option<Vec<&'static str>>,
    missing_optional: Option<Vec<&'static str>>,
}

/// Asks Slack who the stored token of the workspace is; an error says why it is not usable.
#[tauri::command]
pub async fn slack_check(auth: State<'_, Auth>, team_id: String) -> Result<Checked, String> {
    let result = match token_of(&team_id).await {
        Ok(token) if is_bot_token(&token) => Err(BOT_TOKEN.to_owned()),
        Ok(token) => identify_scoped(auth.http(), &token)
            .await
            .map(|(workspace, scopes)| Checked {
                workspace,
                missing_scopes: scopes.as_deref().map(missing_history_scopes),
                missing_optional: scopes
                    .as_deref()
                    .map(|s| missing_scopes(s, &OPTIONAL_SCOPES)),
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
    if is_bot_token(&token) {
        return Err(BOT_TOKEN.into());
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
    state.timeline.forget(&team_id);
    state.images.forget(&team_id);
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
        if let Some(list) = fresh_channels(&state.channels, &team_id) {
            return Ok(list);
        }
    }
    let token = token_of(&team_id)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    fetch_and_keep_channels(auth.http(), &state.channels, &team_id, &token)
        .await
        .map_err(|e| log_failure(command, &team_id, e))
}

/// A workspace's channel list and when it was read, by `team_id`.
type ChannelCache = Mutex<HashMap<String, (Instant, Vec<Channel>)>>;

/// The channel list kept for the workspace, if it is younger than `CHANNELS_TTL`.
fn fresh_channels(cache: &ChannelCache, team_id: &str) -> Option<Vec<Channel>> {
    cache
        .lock()
        .unwrap()
        .get(team_id)
        .filter(|(at, _)| channels_fresh(at.elapsed()))
        .map(|(_, list)| list.clone())
}

/// Asks Slack for the workspace's channels and keeps the list.
async fn fetch_and_keep_channels(
    http: &reqwest::Client,
    cache: &ChannelCache,
    team_id: &str,
    token: &str,
) -> Result<Vec<Channel>, String> {
    let list = fetch_channels(http, token).await?;
    cache
        .lock()
        .unwrap()
        .insert(team_id.to_owned(), (Instant::now(), list.clone()));
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

/// Whether `url` is a link to one Slack message (not a channel's), as the frontend must have checked it.
pub fn check_message_url(url: &str) -> Result<(), String> {
    parse_url(url)?.message_ts.ok_or(BAD_MESSAGE_URL)?;
    Ok(())
}

/// One `conversations.replies` call; a failure says which workspace's token to replace.
async fn read_replies(
    http: &reqwest::Client,
    token: &str,
    team: &str,
    params: Vec<(&'static str, String)>,
) -> Result<Value, String> {
    call(http, token, "conversations.replies", Payload::Form(&params))
        .await
        .map_err(|e| read_error(e, team))
}

/// The messages `read_pages` read, oldest first (the thread's own message first), and whether the thread goes on past them.
struct Pages {
    pages: Vec<Value>,
    more: bool,
}

/// The thread `thread_ts` of `channel`, read in pages of `REPLY_PAGE_SIZE` up to `REPLY_PAGES` pages, each message kept as `keep` makes it.
/// A later page that cannot be read ends the read there (logged): what was read is used and `more` is true. The first page failing is an error.
async fn read_pages(
    http: &reqwest::Client,
    command: &str,
    token: &str,
    workspace: &Workspace,
    channel: &str,
    thread_ts: &str,
    keep: fn(&Value) -> Value,
) -> Result<Pages, String> {
    let mut pages: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = None;
    let mut more;
    let mut read_pages = 0;
    loop {
        let reply = match read_replies(
            http,
            token,
            &workspace.team,
            replies_params(channel, thread_ts, None, cursor.as_deref()),
        )
        .await
        {
            Ok(reply) => reply,
            // A later page that cannot be read ends the read there: what was read is used, and the rest counts as unread.
            Err(e) if read_pages > 0 => {
                log_failure(command, &workspace.team_id, e);
                more = true;
                break;
            }
            Err(e) => return Err(e),
        };
        add_page(&mut pages, &mut seen, &reply["messages"], keep);
        read_pages += 1;
        cursor = next_cursor(&reply);
        more = truncated(&reply);
        if cursor.is_none() || read_pages == REPLY_PAGES {
            break;
        }
    }
    Ok(Pages { pages, more })
}

/// The thread of the Slack message `url` points at, read with the token of the link's workspace: the whole thread, in pages of `REPLY_PAGE_SIZE` up to `REPLY_PAGES` pages,
/// whether the link is to its first message or to a reply. A linked message the pages did not reach is read on its own.
pub async fn message_context(
    dir: &Path,
    http: &reqwest::Client,
    url: &str,
) -> Result<Thread, String> {
    let link = parse_url(url)?;
    let message_ts = link.message_ts.ok_or(BAD_MESSAGE_URL)?;
    let thread_ts = link.thread_ts.unwrap_or_else(|| message_ts.clone());
    let workspaces = load_workspaces(dir).await?;
    let workspace = workspace_for_host(&workspaces, &link.host).ok_or(NO_WORKSPACE)?;
    let token = token_of(&workspace.team_id).await?;
    let Pages { pages, more } = read_pages(
        http,
        "slack_message_context",
        &token,
        workspace,
        &link.channel,
        &thread_ts,
        slim,
    )
    .await?;
    let alone = if more && !pages.iter().any(|m| m["ts"] == message_ts) {
        let reply = read_replies(
            http,
            &token,
            &workspace.team,
            replies_params(&link.channel, &thread_ts, Some(&message_ts), None),
        )
        .await?;
        reply["messages"].as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    let reply_count = pages
        .first()
        .filter(|m| m["ts"] == thread_ts)
        .and_then(|m| m["reply_count"].as_u64());
    let unread = unread_replies(
        more,
        reply_count,
        pages.len().saturating_sub(1),
        alone.iter().any(|m| m["ts"] == message_ts),
    );
    thread_of(&pages, &alone, &message_ts, unread).ok_or_else(|| NO_MESSAGE.to_owned())
}

/// What a post of the mail starts out as, as plain text.
#[tauri::command]
pub fn slack_preview(subject: &str, from: &str, date: &str, body: &str) -> String {
    mail_text(subject, from, date, body)
}

/// Checks the destination and the text, and posts `text` to the channel or as a reply in `thread_ts`'s thread. A failure is logged under `command` and returned.
/// The text goes to Slack only here, on the user's click.
async fn send_post(
    http: &reqwest::Client,
    command: &str,
    team_id: &str,
    channel: &str,
    thread_ts: Option<&str>,
    text: &str,
) -> Result<(), String> {
    if token_key(team_id).is_err()
        || !valid_channel(channel)
        || thread_ts.is_some_and(|t| !valid_ts(t))
    {
        return Err(log_failure(command, team_id, BAD_TARGET));
    }
    let text = post_text(text).map_err(|e| log_failure(command, team_id, e))?;
    let token = token_of(team_id)
        .await
        .map_err(|e| log_failure(command, team_id, e))?;
    let mut message = json!({
        "channel": channel,
        "text": text,
        "unfurl_links": false,
        "unfurl_media": false,
    });
    if let Some(ts) = thread_ts {
        message["thread_ts"] = ts.into();
    }
    call(http, &token, "chat.postMessage", Payload::Json(&message))
        .await
        .map_err(|e| log_failure(command, team_id, e))?;
    Ok(())
}

/// Posts `text` (what the user edited) to the channel, or as a reply in `thread_ts`'s thread, and remembers the destination.
/// The text goes to Slack only here, on the user's click.
#[tauri::command]
pub async fn slack_post(
    app: AppHandle,
    auth: State<'_, Auth>,
    team_id: String,
    channel: String,
    thread_ts: Option<String>,
    name: String,
    text: String,
) -> Result<bool, String> {
    let command = "slack_post";
    send_post(
        auth.http(),
        command,
        &team_id,
        &channel,
        thread_ts.as_deref(),
        &text,
    )
    .await?;
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

// The Slack timeline (S-5), the thread (S-6) and its reply (S-6, S-7). Nothing about messages is saved to disk.

/// The most messages the timeline lists.
const TIMELINE_MAX: usize = 20;
/// Messages `conversations.history` is asked for per channel.
const HISTORY_LIMIT: &str = "20";
/// Channels of one workspace whose history is read at the same time.
const HISTORY_CONCURRENCY: usize = 4;
/// The most channels of one workspace whose `conversations.history` one read asks for (Tier 3 allows about 50 a minute).
/// The channels never read come first, then the ones read longest ago; the others show what their last read kept.
const HISTORY_BUDGET: usize = 40;
/// `users.info` calls at the same time, and the most one list or thread makes: the users past it are asked about by the next read.
const USER_CONCURRENCY: usize = 4;
const USER_LOOKUPS: usize = 40;
/// How long a user is remembered; one Slack could not describe is asked about again sooner.
const USER_TTL: Duration = Duration::from_secs(60 * 60);
const USER_MISS_TTL: Duration = Duration::from_secs(5 * 60);
/// The wait between two reads of the timeline: `REFRESH_MIN_SECS`, or `REFRESH_BUSY_SECS` while channels are still unread or a workspace has more than `HISTORY_BUDGET`.
const REFRESH_MIN_SECS: u32 = 120;
const REFRESH_BUSY_SECS: u32 = 60;
/// How long a workspace's timeline reads stop after Slack rate-limits one: the `Retry-After` it gave, else `RATE_LIMIT_DEFAULT`, never more than `RATE_LIMIT_MAX`.
const RATE_LIMIT_DEFAULT: Duration = Duration::from_secs(60);
const RATE_LIMIT_MAX: Duration = Duration::from_secs(10 * 60);
/// Shown for a user, channel or mention Slack could not name.
const UNKNOWN_NAME: &str = "不明";
/// Where a link goes when the workspace's own address is not known.
const SLACK_HOME: &str = "https://slack.com/";
/// Attached images asked for at once.
const FILE_IMAGES_MAX: usize = 20;

/// A message of the timeline as the screen draws it. The text is plain text (`plain_text`), never markup.
/// `thread_ts` is set only for a reply that was also sent to the channel; open its thread with `thread_ts ?? ts`.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct TimelineMessage {
    team_id: String,
    team: String,
    workspace_url: Option<String>,
    channel: String,
    channel_name: String,
    ts: String,
    thread_ts: Option<String>,
    user: Option<String>,
    name: String,
    icon_url: Option<String>,
    text: String,
    reply_count: u32,
    permalink: String,
    has_files: bool,
}

/// A workspace the timeline could not read at all.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct TimelineFailure {
    team_id: String,
    team: String,
    error: String,
}

/// The scopes of `TIMELINE_SCOPES` a workspace's token lacks.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct TimelineMissing {
    team_id: String,
    team: String,
    scopes: Vec<&'static str>,
}

/// The newest messages of every joined channel of every workspace, newest first, and when to read again.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    messages: Vec<TimelineMessage>,
    failed: Vec<TimelineFailure>,
    missing: Vec<TimelineMissing>,
    refresh_secs: u32,
    /// Channels no read has reached yet, over all workspaces.
    pending_channels: u32,
}

/// An attached file of a thread's message. `thumb_url` is set only for an image Slack serves a 360px preview of;
/// `permalink` opens the file in Slack.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadFile {
    id: String,
    name: String,
    mimetype: String,
    thumb_url: Option<String>,
    permalink: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    ts: String,
    user: Option<String>,
    name: String,
    icon_url: Option<String>,
    text: String,
    files: Vec<ThreadFile>,
}

/// A thread, oldest message first (the thread's own message is the first). `truncated` is whether it goes on past what was read.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct SlackThread {
    team_id: String,
    channel: String,
    ts: String,
    messages: Vec<ThreadMessage>,
    truncated: bool,
}

/// The user's own icon in a workspace; `name` is the user's name there.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIcon {
    team_id: String,
    name: String,
    icon_url: Option<String>,
}

/// A user as the screen shows them: a name, and an icon address when Slack gave an https one.
#[derive(Debug, PartialEq, Clone)]
struct SlackUser {
    name: String,
    icon_url: Option<String>,
}

/// A listed message of a channel, before the names are put to it.
#[derive(Debug, PartialEq, Clone)]
struct Raw {
    team_id: String,
    channel: String,
    channel_name: String,
    ts: String,
    thread_ts: Option<String>,
    user: Option<String>,
    /// The sender of a message a bot or an app wrote, which names itself.
    bot: Option<SlackUser>,
    text: String,
    reply_count: u32,
    has_files: bool,
}

/// (team, user) -> when it was asked, and what Slack said (`None`: it could not say).
type UserCache = HashMap<(String, String), (Instant, Option<SlackUser>)>;

/// A workspace's channels -> when each was read and the messages that read listed.
type History = HashMap<String, (Instant, Vec<Raw>)>;
/// (team, channel) -> the same, for every workspace.
type TeamsHistory = HashMap<(String, String), (Instant, Vec<Raw>)>;

/// What the timeline and the thread keep between reads, in memory only.
#[derive(Default)]
struct TimelineCache {
    users: Mutex<UserCache>,
    /// (team, channel) -> when its last read was and the messages that read listed, which stand in for a channel that is not read now.
    history: Mutex<TeamsHistory>,
    /// team -> until when Slack's rate limit stops its timeline reads.
    limited_until: Mutex<HashMap<String, Instant>>,
    /// team -> the scopes the token had when it last answered, so that a round that reads nothing still knows them.
    scopes: Mutex<HashMap<String, String>>,
    /// team -> the ID of the user the token is (`auth.test`), so that the icons do not ask again.
    own: Mutex<HashMap<String, String>>,
}

impl TimelineCache {
    fn forget(&self, team_id: &str) {
        self.users.lock().unwrap().retain(|(t, _), _| t != team_id);
        self.history
            .lock()
            .unwrap()
            .retain(|(t, _), _| t != team_id);
        self.limited_until.lock().unwrap().remove(team_id);
        self.scopes.lock().unwrap().remove(team_id);
        self.own.lock().unwrap().remove(team_id);
    }

    fn own_user(&self, team_id: &str) -> Option<String> {
        self.own.lock().unwrap().get(team_id).cloned()
    }

    fn put_own_user(&self, team_id: &str, user: &str) {
        self.own
            .lock()
            .unwrap()
            .insert(team_id.to_owned(), user.to_owned());
    }

    fn user(&self, team_id: &str, user: &str) -> Option<SlackUser> {
        let users = self.users.lock().unwrap();
        users
            .get(&(team_id.to_owned(), user.to_owned()))
            .and_then(|(_, found)| found.clone())
    }

    /// Whether Slack should be asked about the user: it never was, or the answer is old.
    fn needs_lookup(&self, team_id: &str, user: &str) -> bool {
        let users = self.users.lock().unwrap();
        users
            .get(&(team_id.to_owned(), user.to_owned()))
            .is_none_or(|(at, found)| !user_fresh(at.elapsed(), found.is_some()))
    }

    fn put_user(&self, team_id: &str, user: &str, found: Option<SlackUser>) {
        self.users.lock().unwrap().insert(
            (team_id.to_owned(), user.to_owned()),
            (Instant::now(), found),
        );
    }

    /// The workspace's remembered channels.
    fn team_history(&self, team_id: &str) -> History {
        self.history
            .lock()
            .unwrap()
            .iter()
            .filter(|((t, _), _)| t == team_id)
            .map(|((_, channel), kept)| (channel.clone(), kept.clone()))
            .collect()
    }

    /// Every remembered message of the workspace.
    fn team_messages(&self, team_id: &str) -> Vec<Raw> {
        self.history
            .lock()
            .unwrap()
            .iter()
            .filter(|((t, _), _)| t == team_id)
            .flat_map(|(_, (_, messages))| messages.iter().cloned())
            .collect()
    }

    /// The workspace's remembered channels become `kept`.
    fn replace_history(&self, team_id: &str, kept: History) {
        let mut history = self.history.lock().unwrap();
        history.retain(|(t, _), _| t != team_id);
        history.extend(
            kept.into_iter()
                .map(|(channel, read)| ((team_id.to_owned(), channel), read)),
        );
    }

    /// The workspace's timeline reads stop for `wait` (or the rest of an earlier stop, if that is longer).
    fn limit(&self, team_id: &str, wait: Duration) {
        let until = Instant::now() + wait;
        let mut limited = self.limited_until.lock().unwrap();
        let slot = limited.entry(team_id.to_owned()).or_insert(until);
        *slot = (*slot).max(until);
    }

    fn rate_limited(&self, team_id: &str) -> bool {
        self.limited_until
            .lock()
            .unwrap()
            .get(team_id)
            .is_some_and(|until| *until > Instant::now())
    }

    fn scopes(&self, team_id: &str) -> Option<String> {
        self.scopes.lock().unwrap().get(team_id).cloned()
    }

    fn put_scopes(&self, team_id: &str, scopes: &str) {
        self.scopes
            .lock()
            .unwrap()
            .insert(team_id.to_owned(), scopes.to_owned());
    }
}

/// How long to stop after a 429: what Slack asked for (`Retry-After`), else `RATE_LIMIT_DEFAULT`, at most `RATE_LIMIT_MAX`.
fn rate_limit_wait(retry_after: Option<Duration>) -> Duration {
    retry_after
        .unwrap_or(RATE_LIMIT_DEFAULT)
        .min(RATE_LIMIT_MAX)
}

/// The channels one read asks Slack about, at most `budget`: those never read first (in the list's order), then the ones read longest ago.
fn choose_channels(list: &[Channel], history: &History, budget: usize) -> Vec<Channel> {
    let mut chosen: Vec<&Channel> = list.iter().collect();
    // `None` (never read) sorts before every `Some`, and the sort keeps the list's order among equals.
    chosen.sort_by_key(|c| history.get(&c.id).map(|(at, _)| *at));
    chosen.into_iter().take(budget).cloned().collect()
}

/// The history after a round: only the channels still in `list` stay; those in `read` take their new messages (read at `now`), the others keep what they had.
/// A channel that was never read and could not be read now is not in it.
fn next_history(
    list: &[Channel],
    mut history: History,
    read: HashMap<String, Vec<Raw>>,
    now: Instant,
) -> History {
    let joined: HashSet<&str> = list.iter().map(|c| c.id.as_str()).collect();
    history.retain(|id, _| joined.contains(id.as_str()));
    history.extend(
        read.into_iter()
            .filter(|(id, _)| joined.contains(id.as_str()))
            .map(|(id, messages)| (id, (now, messages))),
    );
    history
}

/// How many channels of `list` no read has reached yet.
fn pending_channels(list: &[Channel], history: &History) -> usize {
    list.iter().filter(|c| !history.contains_key(&c.id)).count()
}

/// Whether a remembered user is still good: an hour for one Slack described, five minutes for one it could not.
fn user_fresh(age: Duration, found: bool) -> bool {
    age < if found { USER_TTL } else { USER_MISS_TTL }
}

/// Whether a message of `conversations.history` belongs in the timeline: a message with no subtype or one of the subtypes a person or a bot posts with,
/// that has text or a file. Joins, leaves and every other subtype are left out.
fn is_listed(m: &Value) -> bool {
    if m["type"] != "message" {
        return false;
    }
    if !matches!(
        m["subtype"].as_str(),
        None | Some("thread_broadcast" | "file_share" | "me_message" | "bot_message")
    ) {
        return false;
    }
    let text = m["text"].as_str().is_some_and(|t| !t.trim().is_empty());
    let files = m["files"].as_array().is_some_and(|f| !f.is_empty());
    text || files
}

/// `https://…` as it is, and nothing else: an icon or an image address from Slack is used only over https.
fn https_url(url: Option<&str>) -> Option<String> {
    let url = url?;
    (Url::parse(url).ok()?.scheme() == "https").then(|| url.to_owned())
}

/// The hosts a user's or a bot's icon may come from: Slack's image host and its subdomains, and Gravatar.
fn icon_host_ok(host: &str) -> bool {
    host == "slack-edge.com" || host.ends_with(".slack-edge.com") || host == "secure.gravatar.com"
}

/// `https://…` of an allowed icon host (`icon_host_ok`) as it is, and nothing else: any other host gives no icon, and the initial shows.
fn icon_url(url: Option<&str>) -> Option<String> {
    let url = https_url(url)?;
    Url::parse(&url)
        .ok()?
        .host_str()
        .is_some_and(icon_host_ok)
        .then_some(url)
}

/// The first of `names` that is not blank.
fn first_name(names: &[&Value]) -> Option<String> {
    names
        .iter()
        .filter_map(|n| n.as_str())
        .map(str::trim)
        .find(|n| !n.is_empty())
        .map(str::to_owned)
}

/// The user a `users.info` reply describes: the display name, else the real name, else the account name; the icon is the 72px one, else the 48px one.
fn user_of(reply: &Value) -> Option<SlackUser> {
    let user = &reply["user"];
    let profile = &user["profile"];
    Some(SlackUser {
        name: first_name(&[
            &profile["display_name"],
            &profile["real_name"],
            &user["name"],
        ])?,
        icon_url: icon_url(profile["image_72"].as_str())
            .or_else(|| icon_url(profile["image_48"].as_str())),
    })
}

/// The sender of a message a bot or an app wrote (`username` or `bot_profile.name`, and `bot_profile.icons.image_48`), which asks Slack nothing.
fn bot_of(m: &Value) -> Option<SlackUser> {
    Some(SlackUser {
        name: first_name(&[&m["bot_profile"]["name"], &m["username"]])?,
        icon_url: icon_url(m["bot_profile"]["icons"]["image_48"].as_str()),
    })
}

/// A message's `ts` as (seconds, microseconds), so that two are compared as numbers and not as strings. One that is not a `ts` is the oldest.
fn ts_key(ts: &str) -> (u64, u64) {
    let (sec, micro) = ts.split_once('.').unwrap_or((ts, "0"));
    (sec.parse().unwrap_or(0), micro.parse().unwrap_or(0))
}

/// The listed message of a channel, or `None` when it does not belong in the timeline or has no usable `ts`.
fn raw_of(team_id: &str, channel: &Channel, m: &Value) -> Option<Raw> {
    if !is_listed(m) {
        return None;
    }
    let ts = m["ts"].as_str().filter(|t| valid_ts(t))?;
    Some(Raw {
        team_id: team_id.to_owned(),
        channel: channel.id.clone(),
        channel_name: channel.name.clone(),
        ts: ts.to_owned(),
        // The parent of a thread carries its own `ts` as `thread_ts`; only a reply names another.
        thread_ts: m["thread_ts"]
            .as_str()
            .filter(|t| *t != ts && valid_ts(t))
            .map(str::to_owned),
        user: m["user"]
            .as_str()
            .filter(|u| valid_channel(u))
            .map(str::to_owned),
        bot: bot_of(m),
        text: m["text"].as_str().unwrap_or_default().to_owned(),
        reply_count: m["reply_count"]
            .as_u64()
            .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX)),
        has_files: m["files"].as_array().is_some_and(|f| !f.is_empty()),
    })
}

/// The newest `TIMELINE_MAX` of `all`, newest first by `ts` as a number, without a message listed twice (the same team, channel and `ts`).
fn merge_timeline(mut all: Vec<Raw>) -> Vec<Raw> {
    all.sort_by_key(|m| std::cmp::Reverse(ts_key(&m.ts)));
    let mut seen = HashSet::new();
    all.retain(|m| seen.insert((m.team_id.clone(), m.channel.clone(), m.ts.clone())));
    all.truncate(TIMELINE_MAX);
    all
}

/// How long to wait before the next read: `REFRESH_BUSY_SECS` while channels are unread (`pending`) or the biggest workspace has more channels than one read covers (`largest`), else `REFRESH_MIN_SECS`.
fn refresh_secs(pending: usize, largest: usize) -> u32 {
    if pending > 0 || largest > HISTORY_BUDGET {
        REFRESH_BUSY_SECS
    } else {
        REFRESH_MIN_SECS
    }
}

/// The base of a workspace's links: `https://{host}/` of its address, or Slack's home when that is not an https Slack address.
fn link_base(workspace_url: &str) -> String {
    Url::parse(workspace_url)
        .ok()
        .filter(|u| u.scheme() == "https" && u.port().is_none() && u.username().is_empty())
        .and_then(|u| {
            let host = u.host_str()?;
            (host == "slack.com" || host.ends_with(".slack.com"))
                .then(|| format!("https://{host}/"))
        })
        .unwrap_or_else(|| SLACK_HOME.to_owned())
}

/// The link to a message: `{workspace}/archives/{channel}/p{ts without the dot}`, and for a reply `?thread_ts=…&cid=…`. `parse_url` reads it back.
fn permalink(workspace_url: &str, channel: &str, ts: &str, thread_ts: Option<&str>) -> String {
    let mut link = format!(
        "{}archives/{channel}/p{}",
        link_base(workspace_url),
        ts.replace('.', "")
    );
    if let Some(parent) = thread_ts {
        link.push_str(&format!("?thread_ts={parent}&cid={channel}"));
    }
    link
}

/// A piece of Slack's mrkdwn: text, or what is between `<` and `>`.
enum Piece<'a> {
    Text(&'a str),
    Token(&'a str),
}

/// `text` cut into text and `<…>` tokens, in order. A `<` with no `>` after it is text.
fn pieces(text: &str) -> Vec<Piece<'_>> {
    let (mut out, mut rest) = (Vec::new(), text);
    while let Some(start) = rest.find('<') {
        let Some(len) = rest[start + 1..].find('>') else {
            break;
        };
        out.push(Piece::Text(&rest[..start]));
        out.push(Piece::Token(&rest[start + 1..start + 1 + len]));
        rest = &rest[start + len + 2..];
    }
    out.push(Piece::Text(rest));
    out
}

/// Slack escapes `&`, `<` and `>` in text; `&amp;` is undone last.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The text of one `<…>`: a mention (`<@U1>` as `@name`, `@不明` when no name is known), a channel (`<#C1|name>` as `#name`), a broadcast (`<!here>` as `@here`),
/// a link (`<https://a|label>` as `label (https://a)`, `<https://a|https://a>` and `<https://a>` as `https://a`).
fn token_text(token: &str, name_of: &dyn Fn(&str) -> Option<String>) -> String {
    let (target, label) = match token.split_once('|') {
        Some((target, label)) => (target, Some(label).filter(|l| !l.is_empty())),
        None => (token, None),
    };
    if let Some(id) = target.strip_prefix('@') {
        let name = name_of(id)
            .or_else(|| label.map(unescape))
            .unwrap_or_else(|| UNKNOWN_NAME.to_owned());
        return format!("@{name}");
    }
    if target.starts_with('#') {
        return format!(
            "#{}",
            label.map_or_else(|| UNKNOWN_NAME.to_owned(), unescape)
        );
    }
    if let Some(command) = target.strip_prefix('!') {
        let base = command.split('^').next().unwrap_or_default();
        return match (base, label) {
            ("date", Some(label)) => unescape(label),
            ("date", None) => String::new(),
            (_, Some(label)) if label.starts_with('@') || label.starts_with('#') => unescape(label),
            (_, Some(label)) => format!("@{}", unescape(label)),
            ("subteam", None) => format!("@{UNKNOWN_NAME}"),
            (base, None) => format!("@{base}"),
        };
    }
    let url = unescape(target);
    match label.map(unescape) {
        // A labeled link keeps its address beside the label, so that `linkify` can open it.
        Some(label)
            if label != url && (url.starts_with("https://") || url.starts_with("http://")) =>
        {
            format!("{label} ({url})")
        }
        Some(label) => label,
        None => url,
    }
}

/// Slack's mrkdwn as plain text (`token_text`, and `&lt; &gt; &amp;` undone). It is drawn as text, never as markup.
fn plain_text(text: &str, name_of: &dyn Fn(&str) -> Option<String>) -> String {
    pieces(text)
        .into_iter()
        .map(|p| match p {
            Piece::Text(t) => unescape(t),
            Piece::Token(t) => token_text(t, name_of),
        })
        .collect()
}

/// The users `text` mentions (`<@U1>`, `<@U1|name>`), in order, each once.
fn mention_ids(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    pieces(text)
        .into_iter()
        .filter_map(|p| match p {
            Piece::Token(t) => t.strip_prefix('@'),
            Piece::Text(_) => None,
        })
        .filter_map(|t| t.split('|').next())
        .filter(|id| valid_channel(id))
        .filter(|id| seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

/// A message of the timeline with its names put to it. `user` is what Slack said about the sender (a bot's message names itself).
fn timeline_message(
    raw: &Raw,
    workspace: &Workspace,
    user: Option<SlackUser>,
    name_of: &dyn Fn(&str) -> Option<String>,
) -> TimelineMessage {
    let sender = raw.bot.clone().or(user);
    TimelineMessage {
        team_id: workspace.team_id.clone(),
        team: workspace.team.clone(),
        workspace_url: Some(link_base(&workspace.url)).filter(|b| b != SLACK_HOME),
        channel: raw.channel.clone(),
        channel_name: raw.channel_name.clone(),
        ts: raw.ts.clone(),
        thread_ts: raw.thread_ts.clone(),
        user: raw.user.clone(),
        name: sender
            .as_ref()
            .map_or_else(|| UNKNOWN_NAME.to_owned(), |u| u.name.clone()),
        icon_url: sender.and_then(|u| u.icon_url),
        text: plain_text(&raw.text, name_of),
        reply_count: raw.reply_count,
        permalink: permalink(
            &workspace.url,
            &raw.channel,
            &raw.ts,
            raw.thread_ts.as_deref(),
        ),
        has_files: raw.has_files,
    }
}

/// The 360px preview of an attached file, only for an image that Slack hosts itself and serves: not an external file, not one removed or hidden by the plan's limit, and only over https.
fn thumb_url(file: &Value) -> Option<String> {
    let image = file["mimetype"]
        .as_str()
        .is_some_and(|m| m.starts_with("image/"));
    let served = file["is_external"] != true
        && !matches!(file["mode"].as_str(), Some("tombstone" | "hidden_by_limit"));
    if !(image && served) {
        return None;
    }
    https_url(file["thumb_360"].as_str())
}

fn file_of(file: &Value) -> Option<ThreadFile> {
    let id = file["id"].as_str().filter(|i| !i.is_empty())?;
    Some(ThreadFile {
        id: id.to_owned(),
        name: first_name(&[&file["name"], &file["title"]]).unwrap_or_else(|| "ファイル".to_owned()),
        mimetype: file["mimetype"].as_str().unwrap_or_default().to_owned(),
        thumb_url: thumb_url(file),
        permalink: https_url(file["permalink"].as_str()),
    })
}

/// The fields of a message of `conversations.replies` that the thread screen uses.
fn thread_slim(m: &Value) -> Value {
    json!({
        "ts": m["ts"],
        "user": m["user"],
        "text": m["text"],
        "files": m["files"],
        "username": m["username"],
        "bot_profile": m["bot_profile"],
    })
}

/// A message of a thread with its names put to it.
fn thread_message(
    m: &Value,
    user: Option<SlackUser>,
    name_of: &dyn Fn(&str) -> Option<String>,
) -> ThreadMessage {
    let sender = bot_of(m).or(user);
    ThreadMessage {
        ts: m["ts"].as_str().unwrap_or_default().to_owned(),
        user: m["user"]
            .as_str()
            .filter(|u| valid_channel(u))
            .map(str::to_owned),
        name: sender
            .as_ref()
            .map_or_else(|| UNKNOWN_NAME.to_owned(), |u| u.name.clone()),
        icon_url: sender.and_then(|u| u.icon_url),
        text: plain_text(m["text"].as_str().unwrap_or_default(), name_of),
        files: m["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(file_of)
            .collect(),
    }
}

/// What `users.info` said about a user.
enum Lookup {
    Found(SlackUser),
    /// Slack could not say: the call failed, or the user has no usable name.
    Unknown,
    /// The token lacks `users:read`, so every other user fails alike.
    NoScope,
}

/// Asks Slack who `id` is (`users.info`).
async fn fetch_user(http: &reqwest::Client, token: &str, team_id: &str, id: &str) -> Lookup {
    let form = [("user", id.to_owned())];
    match call(http, token, "users.info", Payload::Form(&form)).await {
        Ok(reply) => user_of(&reply).map_or(Lookup::Unknown, Lookup::Found),
        // Without `users:read` every user fails alike: that is the token's state, not worth a line for each.
        Err(e) if e.code.as_deref() == Some("missing_scope") => Lookup::NoScope,
        Err(e) => {
            log_failure("slack_users", team_id, e);
            Lookup::Unknown
        }
    }
}

/// Whether an `x-oauth-scopes` header (`None`: not known) says the token lacks `users:read`.
fn lacks_users_read(scopes: Option<&str>) -> bool {
    scopes.is_some_and(|s| !missing_scopes(s, &["users:read"]).is_empty())
}

/// The first `max` of `items` that Slack should be asked about (`needs`), so that the ones the cache already answers do not use up the share.
fn needing_lookup<T>(
    items: impl Iterator<Item = T>,
    needs: impl Fn(&T) -> bool,
    max: usize,
) -> Vec<T> {
    items.filter(|item| needs(item)).take(max).collect()
}

/// Asks about the `(team, token, user)` entries of `wanted` that the cache has no fresh answer for, at most `USER_CONCURRENCY` at a time, and keeps the answers.
/// A workspace whose token lacks `users:read` (known from the cache, or from the first `missing_scope`) is asked no more in this call.
async fn lookup_users(
    http: &reqwest::Client,
    cache: &Arc<TimelineCache>,
    wanted: Vec<(String, String, String)>,
) {
    let no_scope: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(
        wanted
            .iter()
            .filter(|(team, _, _)| lacks_users_read(cache.scopes(team).as_deref()))
            .map(|(team, _, _)| team.clone())
            .collect(),
    ));
    let jobs = wanted
        .into_iter()
        .filter(|(team, _, user)| cache.needs_lookup(team, user))
        .map(|(team, token, user)| {
            let (http, cache, no_scope) = (http.clone(), Arc::clone(cache), Arc::clone(&no_scope));
            async move {
                if no_scope.lock().unwrap().contains(&team) {
                    return;
                }
                match fetch_user(&http, &token, &team, &user).await {
                    Lookup::Found(found) => cache.put_user(&team, &user, Some(found)),
                    Lookup::Unknown => cache.put_user(&team, &user, None),
                    Lookup::NoScope => {
                        no_scope.lock().unwrap().insert(team.clone());
                        cache.put_user(&team, &user, None);
                    }
                }
            }
        });
    run_limited(jobs, USER_CONCURRENCY).await;
}

/// What reading one workspace gave: its token (empty when it could not be read), the scopes the token has, how many channels it is in and how many of them
/// no read has reached yet, the messages it remembers (also when this read failed), and why it failed, if it did.
struct WorkspaceRead {
    workspace: Workspace,
    token: String,
    scopes: Option<String>,
    channels: usize,
    pending: usize,
    messages: Vec<Raw>,
    error: Option<String>,
}

/// Reads the history of at most `HISTORY_BUDGET` joined channels of the workspace (`choose_channels`), `HISTORY_CONCURRENCY` at a time; the others keep the messages of their last read.
/// A rate limit is not retried: it ends this workspace's read for the round and stops its reads until Slack's `Retry-After` has passed.
/// The workspace fails only when a call failed and no channel could be read.
async fn fill_workspace(
    http: &reqwest::Client,
    channels: &ChannelCache,
    cache: &TimelineCache,
    read: &mut WorkspaceRead,
) -> Result<(), String> {
    let team_id = read.workspace.team_id.clone();
    read.token = token_of(&team_id).await?;
    if is_bot_token(&read.token) {
        return Err(BOT_TOKEN.into());
    }
    let list = match fresh_channels(channels, &team_id) {
        Some(list) => list,
        None => fetch_and_keep_channels(http, channels, &team_id, &read.token).await?,
    };
    read.channels = list.len();
    let history = cache.team_history(&team_id);
    let chosen = if cache.rate_limited(&team_id) {
        Vec::new()
    } else {
        choose_channels(&list, &history, HISTORY_BUDGET)
    };
    // Set by the first rate-limited call, so that the channels still to start do not call.
    let stop = Arc::new(AtomicBool::new(false));
    let jobs = chosen.into_iter().map(|channel| {
        let (http, token, stop) = (http.clone(), read.token.clone(), Arc::clone(&stop));
        async move {
            if stop.load(Ordering::Relaxed) {
                return (channel, None);
            }
            let form = [
                ("channel", channel.id.clone()),
                ("limit", HISTORY_LIMIT.to_owned()),
            ];
            let got = call_scoped_retrying(
                &http,
                &token,
                "conversations.history",
                Payload::Form(&form),
                0,
            )
            .await;
            if got.as_ref().is_err_and(|e| e.rate_limited.is_some()) {
                stop.store(true, Ordering::Relaxed);
            }
            (channel, Some(got))
        }
    });
    let (mut fresh, mut read_ok, mut first_error, mut wait) = (HashMap::new(), 0, None, None);
    for (channel, got) in run_limited(jobs, HISTORY_CONCURRENCY).await {
        match got {
            None => {}
            Some(Ok((reply, scopes))) => {
                read_ok += 1;
                read.scopes = read.scopes.take().or(scopes);
                let found: Vec<Raw> = reply["messages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|m| raw_of(&team_id, &channel, m))
                    .collect();
                fresh.insert(channel.id, found);
            }
            Some(Err(e)) => match e.rate_limited {
                Some(w) => wait = wait.max(Some(w)),
                None => {
                    first_error.get_or_insert(read_error(e, &read.workspace.team));
                }
            },
        }
    }
    if let Some(w) = wait {
        cache.limit(&team_id, w);
        log_failure(
            "slack_timeline",
            &team_id,
            format!("Slack の呼び出し制限のため {} 秒読みません", w.as_secs()),
        );
    }
    match &read.scopes {
        Some(scopes) => cache.put_scopes(&team_id, scopes),
        None => read.scopes = cache.scopes(&team_id),
    }
    let next = next_history(&list, history, fresh, Instant::now());
    read.pending = pending_channels(&list, &next);
    cache.replace_history(&team_id, next);
    match first_error {
        Some(e) if read_ok == 0 => Err(e),
        Some(e) => {
            log_failure("slack_timeline", &team_id, e);
            Ok(())
        }
        None => Ok(()),
    }
}

async fn read_workspace(
    http: reqwest::Client,
    channels: Arc<ChannelCache>,
    cache: Arc<TimelineCache>,
    workspace: Workspace,
) -> WorkspaceRead {
    let mut read = WorkspaceRead {
        workspace,
        token: String::new(),
        scopes: None,
        channels: 0,
        pending: 0,
        messages: Vec::new(),
        error: None,
    };
    read.error = fill_workspace(&http, &channels, &cache, &mut read)
        .await
        .err();
    // A workspace that failed still lists the messages its earlier reads kept.
    read.messages = cache.team_messages(&read.workspace.team_id);
    if read.error.is_some() && read.scopes.is_none() && !read.token.is_empty() {
        // The failure may be a missing scope: `auth.test` says which the token has.
        read.scopes = call_scoped(&http, &read.token, "auth.test", Payload::Empty)
            .await
            .ok()
            .and_then(|(_, scopes)| scopes);
    }
    read
}

/// The newest `TIMELINE_MAX` messages of the joined public and private channels (no direct messages) of every workspace, newest first.
/// A workspace that cannot be read at all is in `failed`; the scopes a token lacks are in `missing`. Messages are kept in memory only.
#[tauri::command]
pub async fn slack_timeline(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, SlackState>,
) -> Result<Timeline, String> {
    let command = "slack_timeline";
    let dir = config_dir(&app)?;
    migrate(&dir, auth.http(), &state).await;
    let workspaces = load_workspaces(&dir)
        .await
        .map_err(|e| log_failure(command, "-", e))?;
    let http = auth.http().clone();
    let jobs = workspaces.iter().cloned().map(|w| {
        read_workspace(
            http.clone(),
            Arc::clone(&state.channels),
            Arc::clone(&state.timeline),
            w,
        )
    });
    let mut reads = run_limited(jobs, workspaces.len().max(1)).await;
    reads.sort_by_key(|r| {
        workspaces
            .iter()
            .position(|w| w.team_id == r.workspace.team_id)
    });

    let (mut all, mut failed, mut missing) = (Vec::new(), Vec::new(), Vec::new());
    let (mut largest, mut pending) = (0, 0);
    let mut no_names = HashSet::new();
    for read in &reads {
        largest = largest.max(read.channels);
        pending += read.pending;
        let lacks = read
            .scopes
            .as_deref()
            .map(|s| missing_scopes(s, &TIMELINE_SCOPES))
            .unwrap_or_default();
        if lacks.contains(&"users:read") {
            no_names.insert(read.workspace.team_id.as_str());
        }
        if !lacks.is_empty() {
            missing.push(TimelineMissing {
                team_id: read.workspace.team_id.clone(),
                team: read.workspace.team.clone(),
                scopes: lacks,
            });
        }
        // A workspace that failed still lists the messages its earlier reads kept.
        all.extend(read.messages.iter().cloned());
        if let Some(error) = &read.error {
            log_failure(command, &read.workspace.team_id, error.as_str());
            failed.push(TimelineFailure {
                team_id: read.workspace.team_id.clone(),
                team: read.workspace.team.clone(),
                error: error.clone(),
            });
        }
    }
    let top = merge_timeline(all);

    // Names: the senders and the people the texts mention, once each, in the order the list shows them.
    let token_of_team: HashMap<&str, &str> = reads
        .iter()
        .map(|r| (r.workspace.team_id.as_str(), r.token.as_str()))
        .collect();
    let mut seen = HashSet::new();
    let wanted = top
        .iter()
        .flat_map(|m| {
            let sender = m.bot.is_none().then_some(m.user.clone()).flatten();
            sender
                .into_iter()
                .chain(mention_ids(&m.text))
                .map(|user| (m.team_id.clone(), user))
                .collect::<Vec<_>>()
        })
        .filter(|(team, _)| !no_names.contains(team.as_str()))
        .filter(|pair| seen.insert(pair.clone()));
    let wanted: Vec<(String, String, String)> = needing_lookup(
        wanted,
        |(team, user)| state.timeline.needs_lookup(team, user),
        USER_LOOKUPS,
    )
    .into_iter()
    .filter_map(|(team, user)| {
        let token = token_of_team.get(team.as_str())?.to_string();
        Some((team, token, user))
    })
    .collect();
    lookup_users(&http, &state.timeline, wanted).await;

    let messages = top
        .iter()
        .filter_map(|raw| {
            let workspace = workspaces.iter().find(|w| w.team_id == raw.team_id)?;
            let user = raw
                .user
                .as_deref()
                .and_then(|u| state.timeline.user(&raw.team_id, u));
            let name_of = |id: &str| state.timeline.user(&raw.team_id, id).map(|u| u.name);
            Some(timeline_message(raw, workspace, user, &name_of))
        })
        .collect();
    Ok(Timeline {
        messages,
        failed,
        missing,
        refresh_secs: refresh_secs(pending, largest),
        pending_channels: u32::try_from(pending).unwrap_or(u32::MAX),
    })
}

/// The whole thread that starts with the message `ts` of `channel` (pages of 200, up to 20 pages, as the summary reads it), oldest first, with names, icons and the attached files.
/// Give a reply's `thread_ts`, not its own `ts`.
#[tauri::command]
pub async fn slack_thread(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, SlackState>,
    team_id: String,
    channel: String,
    ts: String,
) -> Result<SlackThread, String> {
    let command = "slack_thread";
    if token_key(&team_id).is_err() || !valid_channel(&channel) || !valid_ts(&ts) {
        return Err(log_failure(command, &team_id, BAD_TARGET));
    }
    let workspaces = load_workspaces(&config_dir(&app)?)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    let workspace = workspaces
        .iter()
        .find(|w| w.team_id == team_id)
        .ok_or_else(|| log_failure(command, &team_id, NO_WORKSPACE))?;
    let token = token_of(&team_id)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    let Pages { pages, more } = read_pages(
        auth.http(),
        command,
        &token,
        workspace,
        &channel,
        &ts,
        thread_slim,
    )
    .await
    .map_err(|e| log_failure(command, &team_id, e))?;

    let mut seen = HashSet::new();
    let wanted = pages
        .iter()
        .flat_map(|m| {
            let sender = bot_of(m).is_none().then(|| m["user"].as_str()).flatten();
            sender
                .map(str::to_owned)
                .into_iter()
                .chain(mention_ids(m["text"].as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
        })
        .filter(|user| valid_channel(user) && seen.insert(user.clone()));
    let wanted: Vec<(String, String, String)> = needing_lookup(
        wanted,
        |user| state.timeline.needs_lookup(&team_id, user),
        USER_LOOKUPS,
    )
    .into_iter()
    .map(|user| (team_id.clone(), token.clone(), user))
    .collect();
    lookup_users(auth.http(), &state.timeline, wanted).await;

    let name_of = |id: &str| state.timeline.user(&team_id, id).map(|u| u.name);
    let messages = pages
        .iter()
        .map(|m| {
            let user = m["user"]
                .as_str()
                .and_then(|u| state.timeline.user(&team_id, u));
            thread_message(m, user, &name_of)
        })
        .collect();
    Ok(SlackThread {
        team_id,
        channel,
        ts,
        messages,
        truncated: more,
    })
}

/// Posts `text` as a reply in the thread `thread_ts` of `channel`, as S-1 posts (the same checks, `unfurl_*` off, the same Japanese errors).
/// The recent destinations of S-1 are not touched. The text goes to Slack only here, on the user's click.
#[tauri::command]
pub async fn slack_reply(
    auth: State<'_, Auth>,
    team_id: String,
    channel: String,
    thread_ts: String,
    text: String,
) -> Result<bool, String> {
    send_post(
        auth.http(),
        "slack_reply",
        &team_id,
        &channel,
        Some(&thread_ts),
        &text,
    )
    .await?;
    Ok(true)
}

/// The attached images at `urls` (a thread's `thumb_url`s) as data: URIs by URL. The workspace's token goes to `files.slack.com` and nowhere else
/// (`images::fetch_slack_files`); anything else, an image that cannot be fetched, and a token without `files:read` are left out of the map.
#[tauri::command]
pub async fn slack_file_images(
    state: State<'_, SlackState>,
    team_id: String,
    urls: Vec<String>,
) -> Result<HashMap<String, Arc<str>>, String> {
    let command = "slack_file_images";
    let token = token_of(&team_id)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    let urls = urls.into_iter().take(FILE_IMAGES_MAX).collect();
    Ok(fetch_slack_files(&state.images, &team_id, &token, urls).await)
}

/// The user's own icon in each workspace (`auth.test` says who the token is, `users.info` what their icon is). A workspace that cannot say has no icon.
#[tauri::command]
pub async fn slack_icons(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, SlackState>,
) -> Result<Vec<WorkspaceIcon>, String> {
    let command = "slack_icons";
    let workspaces = load_workspaces(&config_dir(&app)?)
        .await
        .map_err(|e| log_failure(command, "-", e))?;
    let http = auth.http().clone();
    let team_ids: Vec<String> = workspaces.iter().map(|w| w.team_id.clone()).collect();
    let jobs = team_ids.into_iter().map(|team_id| {
        let (http, cache) = (http.clone(), Arc::clone(&state.timeline));
        async move {
            let who = async {
                let token = token_of(&team_id).await.ok()?;
                // Who the token is does not change: ask `auth.test` once per workspace.
                if let Some(user) = cache.own_user(&team_id) {
                    return Some((team_id.clone(), token, user));
                }
                let (reply, _) = call_scoped(&http, &token, "auth.test", Payload::Empty)
                    .await
                    .ok()?;
                let user = reply["user_id"].as_str().filter(|u| valid_channel(u))?;
                cache.put_own_user(&team_id, user);
                Some((team_id.clone(), token, user.to_owned()))
            }
            .await;
            (team_id, who)
        }
    });
    let own: HashMap<String, (String, String, String)> = run_limited(jobs, workspaces.len().max(1))
        .await
        .into_iter()
        .filter_map(|(team_id, who)| Some((team_id, who?)))
        .collect();
    lookup_users(&http, &state.timeline, own.values().cloned().collect()).await;
    Ok(workspaces
        .iter()
        .map(|w| {
            let user = own
                .get(&w.team_id)
                .and_then(|(_, _, user)| state.timeline.user(&w.team_id, user));
            WorkspaceIcon {
                team_id: w.team_id.clone(),
                name: user
                    .as_ref()
                    .map_or_else(|| w.user.clone(), |u| u.name.clone()),
                icon_url: user.and_then(|u| u.icon_url),
            }
        })
        .collect())
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
    fn a_bot_token_is_told_from_a_user_token() {
        assert!(is_bot_token("xoxb-1-2-abc"));
        assert!(!is_bot_token("xoxp-1-2-abc"));
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
    fn the_post_starts_as_subject_sender_and_body() {
        assert_eq!(
            mail_text("見積 <1>", "A <a@x.jp>", "2026/10/30 9:05", "本文 & 続き"),
            "*見積 <1>*\nA <a@x.jp> ・ 2026/10/30 9:05\n\n本文 & 続き"
        );
        // No subject and no body: only the header lines remain.
        assert_eq!(
            mail_text("", "A <a@x.jp>", "d", ""),
            "*(件名なし)*\nA <a@x.jp> ・ d"
        );
    }

    #[test]
    fn the_edited_text_is_escaped_but_keeps_its_bold_markup() {
        assert_eq!(
            post_text("  *見積 <1>*\nA <a@x.jp> & 本文\n").as_deref(),
            Ok("*見積 &lt;1&gt;*\nA &lt;a@x.jp&gt; &amp; 本文")
        );
    }

    #[test]
    fn a_blank_or_too_long_text_is_refused_in_japanese() {
        assert_eq!(post_text(" \n ").unwrap_err(), "貼る内容が空です");
        assert!(post_text(&"あ".repeat(POST_LIMIT)).is_ok());
        assert_eq!(
            post_text(&"あ".repeat(POST_LIMIT + 1)).unwrap_err(),
            "貼る内容が長すぎます（10000 文字まで）"
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
    fn only_a_message_link_passes_the_message_url_check() {
        assert_eq!(
            check_message_url("https://example.slack.com/archives/C0123ABC/p1761785520123456"),
            Ok(())
        );
        for bad in [
            "https://example.slack.com/archives/C0123ABC",
            "https://example.com/archives/C0123ABC/p1761785520123456",
            "not a url",
        ] {
            assert!(check_message_url(bad).is_err(), "{bad}");
        }
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
            rate_limited: None,
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

    fn msg(ts: &str, user: &str, text: &str) -> Value {
        json!({"ts": ts, "user": user, "text": text})
    }

    #[test]
    fn a_page_of_the_thread_is_asked_for_by_the_threads_time() {
        assert_eq!(
            replies_params("C0123ABC", "1761780000.000100", None, None),
            [
                ("channel", "C0123ABC".to_owned()),
                ("ts", "1761780000.000100".to_owned()),
                ("limit", "200".to_owned())
            ]
        );
    }

    #[test]
    fn the_next_page_is_asked_for_with_its_cursor() {
        let params = replies_params("C0123ABC", "1.1", None, Some("dXNlcjpVMDYx"));
        assert_eq!(
            params.last().unwrap(),
            &("cursor", "dXNlcjpVMDYx".to_owned())
        );
        assert_eq!(params.iter().filter(|(k, _)| *k == "limit").count(), 1);
    }

    #[test]
    fn a_reply_is_asked_for_by_its_own_time() {
        assert_eq!(
            replies_params(
                "C0123ABC",
                "1761780000.000100",
                Some("1761780009.000200"),
                None
            ),
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
    fn a_cursor_is_read_from_the_response_metadata() {
        let more = json!({"has_more": true, "response_metadata": {"next_cursor": "abc"}});
        assert_eq!(next_cursor(&more).as_deref(), Some("abc"));
        assert!(truncated(&more));
        let last = json!({"has_more": false, "response_metadata": {"next_cursor": ""}});
        assert_eq!(next_cursor(&last), None);
        assert!(!truncated(&last));
        assert_eq!(next_cursor(&json!({"messages": []})), None);
        assert!(!truncated(&json!({"messages": []})));
    }

    #[test]
    fn a_page_that_says_more_without_a_cursor_is_still_cut_short() {
        let reply = json!({"has_more": true});
        assert_eq!(next_cursor(&reply), None);
        assert!(truncated(&reply));
    }

    #[test]
    fn nothing_is_unread_when_the_whole_thread_was_read() {
        assert_eq!(unread_replies(false, Some(500), 3, false), 0);
        assert_eq!(unread_replies(false, None, 3, false), 0);
    }

    #[test]
    fn the_unread_replies_are_the_parents_count_less_those_read() {
        assert_eq!(unread_replies(true, Some(4500), 3999, false), 501);
        // The linked reply was read on its own, so it is not unread.
        assert_eq!(unread_replies(true, Some(4500), 3999, true), 500);
    }

    #[test]
    fn a_cut_thread_counts_at_least_one_unread_reply() {
        assert_eq!(unread_replies(true, None, 3999, false), 1);
        assert_eq!(unread_replies(true, Some(3999), 3999, false), 1);
        assert_eq!(unread_replies(true, Some(10), 50, false), 1);
    }

    #[test]
    fn the_thread_is_every_message_in_order_with_the_linked_one_marked_by_its_index() {
        let read = [
            msg("1.1", "U1", "PR を見てほしい"),
            msg("1.2", "U2", " 明日までに "),
            msg("1.3", "U3", "了解"),
        ];
        let thread = thread_of(&read, &[], "1.2", 0).unwrap();
        assert_eq!(
            thread.lines,
            ["U1: PR を見てほしい", "U2: 明日までに", "U3: 了解"]
        );
        assert_eq!(thread.target, 1);
        assert_eq!(thread.unread, 0);
    }

    #[test]
    fn a_message_alone_is_a_thread_of_one() {
        let read = [msg("1.1", "U1", "a")];
        let thread = thread_of(&read, &[], "1.1", 0).unwrap();
        assert_eq!((thread.lines, thread.target), (vec!["U1: a".to_owned()], 0));
    }

    #[test]
    fn blank_messages_are_skipped_except_the_linked_one() {
        let read = [
            msg("1.1", "U1", "a"),
            msg("1.2", "U2", "  \n "),
            json!({"ts": "1.3", "user": "U3"}),
            msg("1.4", "U4", ""),
            msg("1.5", "U5", "b"),
        ];
        let thread = thread_of(&read, &[], "1.5", 0).unwrap();
        assert_eq!(thread.lines, ["U1: a", "U5: b"]);
        assert_eq!(thread.target, 1);
        let linked_blank = thread_of(&read, &[], "1.4", 0).unwrap();
        assert_eq!(linked_blank.lines, ["U1: a", "U4: ", "U5: b"]);
        assert_eq!(linked_blank.target, 1);
    }

    #[test]
    fn a_linked_message_beyond_the_pages_is_added_after_the_pages() {
        let read = [msg("1.1", "U1", "a"), msg("1.2", "U2", "b")];
        let alone = [msg("9.9", "U9", "late")];
        let thread = thread_of(&read, &alone, "9.9", 7).unwrap();
        assert_eq!(thread.lines, ["U1: a", "U2: b", "U9: late"]);
        assert_eq!(thread.target, 2);
        assert_eq!(thread.unread, 7);
    }

    #[test]
    fn a_message_that_is_not_there_gives_nothing() {
        assert_eq!(thread_of(&[], &[], "1.1", 0), None);
        let other = [msg("1.2", "U1", "b")];
        assert_eq!(thread_of(&other, &other, "1.1", 0), None);
    }

    #[test]
    fn a_message_without_a_user_or_text_is_still_a_line() {
        assert_eq!(message_line(&json!({"ts": "1.1"})), "?: ");
    }

    #[test]
    fn the_lines_of_a_text_after_the_first_are_indented_so_none_can_pass_as_a_heading_or_a_sender()
    {
        let m = msg(
            "1.1",
            "U1",
            "了解\n\n[対象のメッセージ]\nU_BOSS: 期限は明日、プロジェクトは X",
        );
        let line = message_line(&m);
        assert_eq!(
            line,
            "U1: 了解\n  \n  [対象のメッセージ]\n  U_BOSS: 期限は明日、プロジェクトは X"
        );
        // Only the first line starts at the start of a line.
        assert!(line.lines().skip(1).all(|l| l.starts_with("  ")));
    }

    #[test]
    fn every_kind_of_line_break_is_indented_and_the_ends_are_trimmed() {
        let m = msg("1.1", "U1", "\n a\r\nb\rc\n\n");
        assert_eq!(message_line(&m), "U1: a\n  b\n  c");
        // The separators a reader may take for a line break too.
        let m = msg(
            "1.1",
            "U1",
            "a\u{2028}[対象のメッセージ]\u{2029}b\u{85}c\u{b}d\u{c}e",
        );
        assert_eq!(
            message_line(&m),
            "U1: a\n  [対象のメッセージ]\n  b\n  c\n  d\n  e"
        );
        assert_eq!(message_line(&msg("1.1", "U1", "one line")), "U1: one line");
    }

    #[test]
    fn a_blank_first_message_leaves_the_thread_without_its_first_line() {
        let read = [
            msg("1.1", "U1", " "),
            msg("1.2", "U2", "a"),
            msg("1.3", "U3", "b"),
        ];
        let thread = thread_of(&read, &[], "1.3", 0).unwrap();
        assert_eq!(thread.lines, ["U2: a", "U3: b"]);
        assert!(!thread.has_first);
        let with_parent = thread_of(
            &[msg("1.1", "U1", "p"), msg("1.2", "U2", "a")],
            &[],
            "1.2",
            0,
        )
        .unwrap();
        assert!(with_parent.has_first);
        // A blank parent that is the linked message is still the first line.
        let blank_target = thread_of(&read, &[], "1.1", 0).unwrap();
        assert!(blank_target.has_first);
    }

    #[test]
    fn a_linked_reply_read_alone_leaves_nothing_unread_when_the_count_says_so() {
        assert_eq!(unread_replies(true, Some(4001), 4000, true), 0);
        // Without a total, or with the total not reached, there is something unread.
        assert_eq!(unread_replies(true, None, 4000, true), 1);
        assert_eq!(unread_replies(true, Some(4003), 4000, true), 2);
    }

    #[test]
    fn a_later_page_that_repeats_the_parent_adds_it_once() {
        let mut read = Vec::new();
        let mut seen = std::collections::HashSet::new();
        add_page(
            &mut read,
            &mut seen,
            &json!([msg("1.1", "U1", "p"), msg("1.2", "U2", "a")]),
            slim,
        );
        add_page(
            &mut read,
            &mut seen,
            &json!([
                msg("1.1", "U1", "p"),
                msg("1.3", "U3", "b"),
                msg("1.3", "U3", "b")
            ]),
            slim,
        );
        let ts: Vec<_> = read.iter().map(|m| m["ts"].as_str().unwrap()).collect();
        assert_eq!(ts, ["1.1", "1.2", "1.3"]);
        // The count of replies read is the pages' messages less the parent.
        assert_eq!(read.len() - 1, 2);
    }

    #[test]
    fn a_page_keeps_only_the_fields_the_summary_uses() {
        let mut read = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let full = json!({
            "ts": "1.1", "user": "U1", "text": "p", "reply_count": 3,
            "blocks": [{"type": "rich_text"}], "files": [{"id": "F1"}], "attachments": []
        });
        add_page(&mut read, &mut seen, &json!([full]), slim);
        assert_eq!(
            read[0],
            json!({"ts": "1.1", "user": "U1", "text": "p", "reply_count": 3})
        );
        // A page that is not a list adds nothing.
        add_page(&mut read, &mut seen, &json!(null), slim);
        assert_eq!(read.len(), 1);
    }

    fn channel(id: &str) -> Channel {
        Channel {
            id: id.into(),
            name: format!("name {id}"),
        }
    }

    fn raw(channel: &str, ts: &str) -> Raw {
        Raw {
            team_id: "T1".into(),
            channel: channel.into(),
            channel_name: format!("name {channel}"),
            ts: ts.into(),
            thread_ts: None,
            user: None,
            bot: None,
            text: "t".into(),
            reply_count: 0,
            has_files: false,
        }
    }

    fn ids(list: &[Channel]) -> Vec<&str> {
        list.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn a_read_asks_for_the_unread_channels_first_and_then_the_ones_read_longest_ago() {
        let now = Instant::now();
        let ago = |s| now - Duration::from_secs(s);
        let list: Vec<Channel> = ["C1", "C2", "C3", "C4", "C5"].map(channel).to_vec();
        let history: History = [("C1", ago(10)), ("C3", ago(300)), ("C4", ago(60))]
            .into_iter()
            .map(|(id, at)| (id.to_owned(), (at, Vec::new())))
            .collect();
        // C2 and C5 were never read (in the list's order), then C3 (300 s ago), C4 and C1.
        assert_eq!(
            ids(&choose_channels(&list, &history, 5)),
            ["C2", "C5", "C3", "C4", "C1"]
        );
        assert_eq!(
            ids(&choose_channels(&list, &history, 3)),
            ["C2", "C5", "C3"]
        );
        assert!(choose_channels(&list, &history, 0).is_empty());
        // Past the budget, every channel is reached in turn.
        let many: Vec<Channel> = (0..100).map(|n| channel(&format!("C{n}"))).collect();
        let mut history = History::new();
        let mut round = |at: Instant| {
            let chosen = choose_channels(&many, &history, HISTORY_BUDGET);
            assert_eq!(chosen.len(), HISTORY_BUDGET);
            let read = chosen.into_iter().map(|c| (c.id, Vec::new())).collect();
            history = next_history(&many, std::mem::take(&mut history), read, at);
            pending_channels(&many, &history)
        };
        assert_eq!(round(ago(30)), 60);
        assert_eq!(round(ago(20)), 20);
        assert_eq!(round(ago(10)), 0);
    }

    #[test]
    fn the_history_keeps_the_channels_not_read_now_and_drops_the_ones_left() {
        let now = Instant::now();
        let before = now - Duration::from_secs(60);
        let list: Vec<Channel> = ["C1", "C2", "C3"].map(channel).to_vec();
        let history: History = [
            ("C1".to_owned(), (before, vec![raw("C1", "1.1")])),
            ("C9".to_owned(), (before, vec![raw("C9", "1.2")])),
        ]
        .into_iter()
        .collect();
        let read = HashMap::from([("C2".to_owned(), vec![raw("C2", "2.1")])]);
        let next = next_history(&list, history, read, now);
        // C1 keeps its messages and its time, C2 is new, C9 left the workspace, and C3 was never read.
        assert_eq!(next.get("C1"), Some(&(before, vec![raw("C1", "1.1")])));
        assert_eq!(next.get("C2"), Some(&(now, vec![raw("C2", "2.1")])));
        assert!(!next.contains_key("C9"));
        assert_eq!(pending_channels(&list, &next), 1);
        // A channel read with no message is read all the same.
        let none = next_history(
            &list,
            History::new(),
            HashMap::from([("C3".to_owned(), Vec::new())]),
            now,
        );
        assert_eq!(pending_channels(&list, &none), 2);
    }

    #[test]
    fn a_workspace_keeps_its_messages_when_a_later_read_fails() {
        let cache = TimelineCache::default();
        let now = Instant::now();
        let list = vec![channel("C1"), channel("C2")];
        let read = HashMap::from([
            ("C1".to_owned(), vec![raw("C1", "1.1")]),
            ("C2".to_owned(), vec![raw("C2", "2.1")]),
        ]);
        cache.replace_history("T1", next_history(&list, History::new(), read, now));
        // A round in which nothing could be read changes nothing.
        let next = next_history(&list, cache.team_history("T1"), HashMap::new(), now);
        cache.replace_history("T1", next);
        let mut ts: Vec<String> = cache
            .team_messages("T1")
            .into_iter()
            .map(|m| m.ts)
            .collect();
        ts.sort();
        assert_eq!(ts, ["1.1", "2.1"]);
        assert!(cache.team_messages("T2").is_empty());
        cache.forget("T1");
        assert!(cache.team_messages("T1").is_empty());
    }

    #[test]
    fn a_rate_limit_waits_for_retry_after_else_a_minute_and_never_past_ten() {
        let s = Duration::from_secs;
        assert_eq!(rate_limit_wait(Some(s(30))), s(30));
        assert_eq!(rate_limit_wait(None), RATE_LIMIT_DEFAULT);
        assert_eq!(rate_limit_wait(Some(s(86_400))), RATE_LIMIT_MAX);
    }

    #[test]
    fn a_rate_limited_workspace_is_not_read_until_the_wait_has_passed_and_the_others_are() {
        let cache = TimelineCache::default();
        assert!(!cache.rate_limited("T1"));
        cache.limit("T1", Duration::from_secs(60));
        assert!(cache.rate_limited("T1"));
        assert!(!cache.rate_limited("T2"));
        // A shorter limit does not shorten the wait.
        cache.limit("T1", Duration::ZERO);
        assert!(cache.rate_limited("T1"));
        cache.forget("T1");
        assert!(!cache.rate_limited("T1"));
        cache.limit("T3", Duration::ZERO);
        assert!(!cache.rate_limited("T3"));
    }

    #[test]
    fn the_scopes_of_the_last_answer_are_remembered_per_workspace() {
        let cache = TimelineCache::default();
        assert_eq!(cache.scopes("T1"), None);
        cache.put_scopes("T1", "channels:history");
        assert_eq!(cache.scopes("T1").as_deref(), Some("channels:history"));
        assert_eq!(cache.scopes("T2"), None);
        cache.forget("T1");
        assert_eq!(cache.scopes("T1"), None);
    }

    #[test]
    fn the_list_is_read_every_minute_while_channels_are_unread_or_more_than_one_read_covers() {
        assert_eq!(refresh_secs(0, 0), 120);
        assert_eq!(refresh_secs(0, HISTORY_BUDGET), 120);
        assert_eq!(refresh_secs(0, HISTORY_BUDGET + 1), 60);
        assert_eq!(refresh_secs(1, 3), 60);
    }

    #[test]
    fn an_icon_comes_only_from_slacks_image_hosts_or_gravatar_over_https() {
        for ok in [
            "https://avatars.slack-edge.com/2024/a_72.jpg",
            "https://slack-edge.com/a.png",
            "https://secure.gravatar.com/avatar/x.jpg?s=72",
        ] {
            assert_eq!(icon_url(Some(ok)).as_deref(), Some(ok), "{ok}");
        }
        for bad in [
            "http://avatars.slack-edge.com/a.jpg",
            "https://evil.example/a.jpg",
            "https://slack-edge.com.evil.example/a.jpg",
            "https://notslack-edge.com/a.jpg",
            "https://gravatar.com/avatar/x",
            "https://www.gravatar.com/avatar/x",
            "https://avatars.slack-edge.com@evil.example/a.jpg",
            "data:image/png;base64,AAAA",
            "not a url",
        ] {
            assert_eq!(icon_url(Some(bad)), None, "{bad}");
        }
        assert_eq!(icon_url(None), None);
        // A user and a bot of another host have no icon, and keep their names.
        let user = user_of(&json!({"user": {"name": "a", "profile": {"image_72": "https://evil.example/a.jpg", "image_48": "https://secure.gravatar.com/a.jpg"}}})).unwrap();
        assert_eq!(
            user.icon_url.as_deref(),
            Some("https://secure.gravatar.com/a.jpg")
        );
        let bot = bot_of(&json!({"bot_profile": {"name": "b", "icons": {"image_48": "https://evil.example/b.png"}}})).unwrap();
        assert_eq!((bot.name.as_str(), bot.icon_url), ("b", None));
    }

    #[test]
    fn a_labeled_link_keeps_its_address_beside_the_label_unless_they_are_the_same() {
        let nobody = |_: &str| None;
        assert_eq!(
            token_text("https://a.example/x|docs", &nobody),
            "docs (https://a.example/x)"
        );
        assert_eq!(
            token_text("https://a.example/x?a=1&amp;b=2|docs", &nobody),
            "docs (https://a.example/x?a=1&b=2)"
        );
        assert_eq!(
            token_text("https://a.example/x|https://a.example/x", &nobody),
            "https://a.example/x"
        );
        assert_eq!(
            token_text("https://a.example/x", &nobody),
            "https://a.example/x"
        );
        // Only a web address is kept beside the label.
        assert_eq!(token_text("mailto:a@example.com|mail", &nobody), "mail");
    }

    #[test]
    fn the_users_to_ask_about_are_chosen_after_the_cached_ones_are_left_out() {
        let cache = TimelineCache::default();
        let users: Vec<String> = (0..USER_LOOKUPS + 5).map(|i| format!("U{i}")).collect();
        // The first USER_LOOKUPS are known already: the ones past them are the ones to ask about.
        for user in &users[..USER_LOOKUPS] {
            cache.put_user(
                "T1",
                user,
                Some(SlackUser {
                    name: "n".into(),
                    icon_url: None,
                }),
            );
        }
        let asked = needing_lookup(users.iter(), |u| cache.needs_lookup("T1", u), USER_LOOKUPS);
        assert_eq!(asked, users[USER_LOOKUPS..].iter().collect::<Vec<_>>());
        // At most `max` are chosen.
        assert_eq!(needing_lookup(0..10, |_| true, 3), [0, 1, 2]);
    }

    #[test]
    fn a_token_lacks_users_read_only_when_its_scopes_are_known() {
        assert!(lacks_users_read(Some("channels:read,chat:write")));
        assert!(lacks_users_read(Some("")));
        assert!(!lacks_users_read(Some("channels:read, users:read")));
        assert!(!lacks_users_read(None));
    }

    #[test]
    fn the_own_user_of_a_workspace_is_remembered_until_it_is_forgotten() {
        let cache = TimelineCache::default();
        assert_eq!(cache.own_user("T1"), None);
        cache.put_own_user("T1", "U1");
        assert_eq!(cache.own_user("T1").as_deref(), Some("U1"));
        assert_eq!(cache.own_user("T2"), None);
        cache.forget("T1");
        assert_eq!(cache.own_user("T1"), None);
    }
}
