use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use url::Url;

use crate::{
    accounts::write_synced,
    auth::{config_dir, delete_entry, Auth},
    gmail::{log_failure, parse_retry_after, retry_wait, MAX_RETRIES},
};

/// Every request goes here and nowhere else: nothing from outside is put into the URL.
const API_URL: &str = "https://slack.com/api";
/// The keychain user name (and the `account=` of the logs) of the User OAuth Token.
const TOKEN_USER: &str = "slack";
const TOKEN_SERVICE: &str = "jp.mysis.cookup.slack";
const FILE: &str = "slack-destinations.json";
const TMP_FILE: &str = "slack-destinations.json.tmp";
/// Characters of the mail's text that are posted.
const BODY_LIMIT: usize = 3000;
const NO_TOKEN: &str = "Slack のトークンが保存されていません。設定で貼り付けてください";
const BAD_URL: &str = "Slack のメッセージかチャンネルのリンクを入力してください";

/// Where a mail is posted: a channel, and the thread of a message in it when `thread_ts` is set.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    name: String,
    channel: String,
    #[serde(default)]
    thread_ts: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct DestinationsFile {
    destinations: Vec<Destination>,
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

/// The channel and the parent message's `thread_ts` of a Slack link: `https://{ws}.slack.com/archives/{channel}` posts to the channel,
/// `…/archives/{channel}/p{16 digits}` replies to that message (`?thread_ts=` of a reply's link names the parent instead).
fn parse_url(raw: &str) -> Result<(String, Option<String>), String> {
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
    if let Some((_, ts)) = url.query_pairs().find(|(k, _)| k == "thread_ts") {
        if !valid_ts(&ts) {
            return Err(BAD_URL.into());
        }
        thread_ts = Some(ts.into_owned());
    }
    Ok((channel.to_owned(), thread_ts))
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
fn error_message(code: &str) -> String {
    match code {
        "invalid_auth" | "not_authed" | "token_revoked" => {
            "トークンが無効です。設定で貼り直してください".into()
        }
        "not_in_channel" | "channel_not_found" => {
            "チャンネルに参加していないか、見つかりません".into()
        }
        "missing_scope" => "Slack アプリに chat:write のスコープがありません".into(),
        other => format!("Slack がエラーを返しました: {other}"),
    }
}

fn check_reply(reply: &Value) -> Result<(), String> {
    if reply["ok"] == true {
        return Ok(());
    }
    Err(error_message(reply["error"].as_str().unwrap_or("unknown")))
}

/// Calls a Web API method with the token. A rate-limited (429) request is sent again as Gmail's are.
async fn call(
    http: &reqwest::Client,
    token: &str,
    method: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let mut attempt = 0;
    loop {
        let req = http.post(format!("{API_URL}/{method}")).bearer_auth(token);
        let req = match body {
            Some(body) => req.json(body),
            None => req.header(reqwest::header::CONTENT_LENGTH, "0"),
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
            return Err(format!("Slack が {status} を返しました"));
        }
        let reply: Value = res
            .json()
            .await
            .map_err(|e| format!("Slack の返答を読めません: {e}"))?;
        check_reply(&reply)?;
        return Ok(reply);
    }
}

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(TOKEN_SERVICE, TOKEN_USER).map_err(|e| e.to_string())
}

/// The stored token, off the async threads. `None` means none is stored.
async fn read_token() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| match token_entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("キーチェーンの読み取りに失敗: {e}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Connection {
    team: String,
    user: String,
}

/// `auth.test` with `token`: who the token is.
async fn identify(http: &reqwest::Client, token: &str) -> Result<Connection, String> {
    let reply = call(http, token, "auth.test", None).await?;
    let field = |k: &str| reply[k].as_str().unwrap_or_default().to_owned();
    Ok(Connection {
        team: field("team"),
        user: field("user"),
    })
}

#[derive(Serialize)]
pub struct SlackLoad {
    connected: bool,
    destinations: Vec<Destination>,
}

fn load_destinations(dir: &Path) -> Result<Vec<Destination>, String> {
    let path = dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<DestinationsFile>(&text)
            .map(|f| f.destinations)
            .map_err(|e| format!("{} の形式が不正です: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

fn save_destinations(dir: &Path, destinations: &[Destination]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(FILE), dir.join(TMP_FILE));
    let text = serde_json::to_string_pretty(&json!({ "destinations": destinations }))
        .map_err(|e| e.to_string())?;
    // Rename over the target so a crash mid-write leaves the old file, not a truncated one.
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// Whether a token is stored, and the saved destinations. Asks Slack nothing.
#[tauri::command]
pub async fn slack_load(app: AppHandle) -> Result<SlackLoad, String> {
    let dir = config_dir(&app)?;
    let (token, destinations) = tokio::join!(
        read_token(),
        tokio::task::spawn_blocking(move || load_destinations(&dir))
    );
    Ok(SlackLoad {
        connected: token
            .map_err(|e| log_failure("slack_load", TOKEN_USER, e))?
            .is_some(),
        destinations: destinations
            .map_err(|e| e.to_string())?
            .map_err(|e| log_failure("slack_load", TOKEN_USER, e))?,
    })
}

/// Asks Slack who the stored token is; an error says why it is not usable.
#[tauri::command]
pub async fn slack_check(auth: State<'_, Auth>) -> Result<Connection, String> {
    let result = match read_token().await {
        Ok(Some(token)) => identify(auth.http(), &token).await,
        Ok(None) => Err(NO_TOKEN.to_owned()),
        Err(e) => Err(e),
    };
    result.map_err(|e| log_failure("slack_check", TOKEN_USER, e))
}

/// Stores the User OAuth Token in the keychain once Slack accepts it. It is never logged or returned.
#[tauri::command]
pub async fn slack_save_token(auth: State<'_, Auth>, token: String) -> Result<Connection, String> {
    let token = token.trim().to_owned();
    if token.is_empty() {
        return Err("トークンを入力してください".into());
    }
    let connection = identify(auth.http(), &token)
        .await
        .map_err(|e| log_failure("slack_save_token", TOKEN_USER, e))?;
    tokio::task::spawn_blocking(move || {
        token_entry().and_then(|e| {
            e.set_password(&token)
                .map_err(|e| format!("キーチェーンへの保存に失敗: {e}"))
        })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    .map_err(|e| log_failure("slack_save_token", TOKEN_USER, e))?;
    Ok(connection)
}

/// Revokes the stored token at Slack (a failure is logged, not fatal), then removes it from the keychain.
#[tauri::command]
pub async fn slack_disconnect(auth: State<'_, Auth>) -> Result<(), String> {
    match read_token().await {
        Ok(Some(token)) => {
            if let Err(e) = call(auth.http(), &token, "auth.revoke", None).await {
                log_failure("slack_revoke", TOKEN_USER, e);
            }
        }
        Ok(None) => {}
        Err(e) => {
            log_failure("slack_disconnect", TOKEN_USER, e);
        }
    }
    tokio::task::spawn_blocking(|| token_entry().and_then(|e| delete_entry(&e)))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
        .map_err(|e| log_failure("slack_disconnect", TOKEN_USER, e))
}

/// Saves a destination from a Slack link and returns the list.
#[tauri::command]
pub async fn slack_add_destination(
    app: AppHandle,
    name: String,
    url: String,
) -> Result<Vec<Destination>, String> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err("名前を入力してください".into());
    }
    let (channel, thread_ts) = parse_url(&url)?;
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let mut list = load_destinations(&dir)?;
        list.push(Destination {
            name,
            channel,
            thread_ts,
        });
        save_destinations(&dir, &list).map(|()| list)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    .map_err(|e| log_failure("slack_add_destination", TOKEN_USER, e))
}

/// Removes the `index`-th destination and returns the list.
#[tauri::command]
pub async fn slack_remove_destination(
    app: AppHandle,
    index: usize,
) -> Result<Vec<Destination>, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let mut list = load_destinations(&dir)?;
        if index < list.len() {
            list.remove(index);
        }
        save_destinations(&dir, &list).map(|()| list)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    .map_err(|e| log_failure("slack_remove_destination", TOKEN_USER, e))
}

/// What a post of the mail would say, without the note and as plain text.
#[tauri::command]
pub fn slack_preview(subject: &str, from: &str, date: &str, body: &str) -> String {
    mail_text("", subject, from, date, body, false)
}

/// Posts the mail to the channel, or as a reply in `thread_ts`'s thread. The mail's text goes to Slack only here, on the user's click.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn slack_post(
    auth: State<'_, Auth>,
    channel: String,
    thread_ts: Option<String>,
    note: String,
    subject: String,
    from: String,
    date: String,
    body: String,
) -> Result<bool, String> {
    let command = "slack_post";
    if !valid_channel(&channel) || thread_ts.as_deref().is_some_and(|t| !valid_ts(t)) {
        return Err(log_failure(command, TOKEN_USER, "貼り付け先が不正です"));
    }
    let token = read_token()
        .await
        .and_then(|t| t.ok_or_else(|| NO_TOKEN.to_owned()))
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let mut message = json!({
        "channel": channel,
        "text": mail_text(&note, &subject, &from, &date, &body, true),
        "unfurl_links": false,
        "unfurl_media": false,
    });
    if let Some(ts) = thread_ts {
        message["thread_ts"] = ts.into();
    }
    call(auth.http(), &token, "chat.postMessage", Some(&message))
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cookup-slack-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn parsed(raw: &str) -> (String, Option<String>) {
        parse_url(raw).unwrap()
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
                error_message(code),
                "トークンが無効です。設定で貼り直してください"
            );
        }
        for code in ["not_in_channel", "channel_not_found"] {
            assert_eq!(
                error_message(code),
                "チャンネルに参加していないか、見つかりません"
            );
        }
        assert_eq!(
            error_message("missing_scope"),
            "Slack アプリに chat:write のスコープがありません"
        );
        assert_eq!(
            error_message("ratelimited"),
            "Slack がエラーを返しました: ratelimited"
        );
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
    fn timestamps_need_digits_around_one_dot() {
        assert!(valid_ts("1761785520.123456"));
        for bad in ["", "1761785520", ".1", "1.", "a.b", "1.2.3"] {
            assert!(!valid_ts(bad), "{bad}");
        }
    }

    #[test]
    fn destinations_are_saved_and_loaded_and_the_save_replaces_the_file() {
        let dir = temp_dir("save");
        assert_eq!(load_destinations(&dir), Ok(vec![]));
        let a = Destination {
            name: "A".into(),
            channel: "C1".into(),
            thread_ts: Some("1.2".into()),
        };
        let b = Destination {
            name: "B".into(),
            channel: "C2".into(),
            thread_ts: None,
        };
        save_destinations(&dir, std::slice::from_ref(&a)).unwrap();
        save_destinations(&dir, &[a.clone(), b.clone()]).unwrap();
        assert_eq!(load_destinations(&dir), Ok(vec![a, b]));
        assert!(!dir.join(TMP_FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_save_leaves_the_existing_file_and_a_broken_file_is_reported() {
        let dir = temp_dir("atomic");
        let a = Destination {
            name: "A".into(),
            channel: "C1".into(),
            thread_ts: None,
        };
        save_destinations(&dir, std::slice::from_ref(&a)).unwrap();
        std::fs::create_dir(dir.join(TMP_FILE)).unwrap();
        assert!(save_destinations(&dir, &[]).is_err());
        assert_eq!(load_destinations(&dir), Ok(vec![a]));
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load_destinations(&dir).unwrap_err().contains("形式が不正"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
