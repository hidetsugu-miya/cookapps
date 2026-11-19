//! The connection to Jira Cloud (J-1, #868): the site's URL and the email address in `jira-settings.json` of the app config directory, the API token in the keychain, and a test of the connection.
//!
//! Only Atlassian Cloud is spoken to: the site is `https://{name}.atlassian.net` and nothing else (`site_url`), so a token is never sent to another host.
//! An email address makes the token a Basic credential (`email:token`, an API token of an account); with none it is sent as a Bearer token (a scoped token).
//! The token is never returned to the screen, logged or written to a file; a save with no token keeps the stored one.

use std::{path::Path, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;
use url::Url;

use crate::{accounts::write_atomic, auth::config_dir, gmail::log_failure, keychain};

const FILE: &str = "jira-settings.json";
/// The keychain service and user name of the API token.
const TOKEN_SERVICE: &str = "jp.mysis.tsunagiai.jira";
const TOKEN_USER: &str = "api-token";
/// The `account=` of the logs.
const LOG_ACCOUNT: &str = "jira";
const HOST_SUFFIX: &str = ".atlassian.net";
/// The call that tells who the credential belongs to.
const MYSELF_PATH: &str = "/rest/api/3/myself";
const TIMEOUT: Duration = Duration::from_secs(15);
/// How much of an error body goes into the message.
const BODY_LIMIT: usize = 200;
const TOKEN_MISSING: &str = "API トークンを入力してください";

/// What `jira-settings.json` holds.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
struct Saved {
    site: String,
    email: String,
}

/// The saved connection as the screen gets it: never the token, only whether one is kept.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct JiraSettings {
    pub site: String,
    pub email: String,
    pub has_token: bool,
}

/// Who the credential belongs to, as Jira answered the test.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct JiraUser {
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub email_address: Option<String>,
}

/// The origin of a site: `https://{name}.atlassian.net` only. Another scheme, host, port, user info or an empty or dotted name is refused, and a path is dropped.
fn site_url(input: &str) -> Result<String, String> {
    let bad = || "サイトの URL は https://{名前}.atlassian.net の形で入力してください".to_owned();
    let url = Url::parse(input.trim()).map_err(|_| bad())?;
    let host = url.host_str().ok_or_else(bad)?;
    let name = host.strip_suffix(HOST_SUFFIX).ok_or_else(bad)?;
    let name_ok = !name.is_empty()
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let plain = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none();
    if name_ok && plain {
        Ok(format!("https://{host}"))
    } else {
        Err(bad())
    }
}

/// The email address, trimmed; empty is allowed (a Bearer token). It becomes the left half of `email:token`, so a colon or a space is refused.
fn email_of(input: &str) -> Result<String, String> {
    let email = input.trim();
    let ok = email.is_empty()
        || (email.contains('@')
            && !email
                .chars()
                .any(|c| c == ':' || c.is_whitespace() || c.is_control()));
    if ok {
        Ok(email.to_owned())
    } else {
        Err("メールアドレスの形が正しくありません".into())
    }
}

/// The token typed, trimmed; `None` when nothing was typed. It goes into a header, so only printable ASCII is taken.
fn token_of(input: &str) -> Result<Option<String>, String> {
    let token = input.trim();
    if token.is_empty() {
        return Ok(None);
    }
    if token.chars().all(|c| c.is_ascii_graphic()) {
        Ok(Some(token.to_owned()))
    } else {
        Err("API トークンに使えない文字があります".into())
    }
}

/// The `Authorization` header: Basic with `email:token` when an email address is given, else Bearer.
fn authorization(email: &str, token: &str) -> String {
    if email.is_empty() {
        format!("Bearer {token}")
    } else {
        format!("Basic {}", STANDARD.encode(format!("{email}:{token}")))
    }
}

/// What Jira's answer to the call of `MYSELF_PATH` means.
fn user_of(status: u16, body: &str) -> Result<JiraUser, String> {
    match status {
        200..=299 => {
            serde_json::from_str(body).map_err(|e| format!("Jira の応答を読めません: {e}"))
        }
        401 | 403 => Err(format!("Jira が認証を拒否しました（{status}）")),
        _ => {
            let shown: String = body.chars().take(BODY_LIMIT).collect();
            Err(format!("Jira が {status} を返しました: {shown}"))
        }
    }
}

/// Asks the site who the credential belongs to. `base` is the origin from `site_url`. A redirect is not followed, so the credential never goes to another host.
async fn fetch_user(base: &str, authorization: &str) -> Result<JiraUser, String> {
    let mut header = HeaderValue::from_str(authorization).map_err(|e| e.to_string())?;
    header.set_sensitive(true);
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let res = http
        .get(format!("{base}{MYSELF_PATH}"))
        .header(AUTHORIZATION, header)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    user_of(status, &body)
}

fn load_file(dir: &Path) -> Result<Saved, String> {
    let path = dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} の形式が不正です: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Saved::default()),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

fn save_file(dir: &Path, saved: &Saved) -> Result<(), String> {
    let text = serde_json::to_string_pretty(saved).map_err(|e| e.to_string())?;
    write_atomic(dir, FILE, &text)
}

/// What a form gives, checked: the site's origin, the email address, and the token typed (`None` when the field was empty).
fn checked_form(
    site: &str,
    email: &str,
    token: &str,
) -> Result<(String, String, Option<String>), String> {
    Ok((site_url(site)?, email_of(email)?, token_of(token)?))
}

async fn stored_token() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| keychain::read(TOKEN_SERVICE, TOKEN_USER))
        .await
        .map_err(|e| e.to_string())?
}

/// The saved site and email address, and whether a token is kept. Asks Jira nothing.
#[tauri::command]
pub async fn jira_settings(app: AppHandle) -> Result<JiraSettings, String> {
    let command = "jira_settings";
    let dir = config_dir(&app).map_err(|e| log_failure(command, LOG_ACCOUNT, e))?;
    let saved = tokio::task::spawn_blocking(move || load_file(&dir))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
        .map_err(|e| log_failure(command, LOG_ACCOUNT, e))?;
    let has_token = stored_token()
        .await
        .map_err(|e| log_failure(command, LOG_ACCOUNT, e))?
        .is_some();
    Ok(JiraSettings {
        site: saved.site,
        email: saved.email,
        has_token,
    })
}

/// Saves the site and the email address to the file and the token to the keychain. An empty `token` keeps the stored one, and is refused when none is stored.
#[tauri::command]
pub async fn jira_save(
    app: AppHandle,
    site: String,
    email: String,
    token: String,
) -> Result<JiraSettings, String> {
    let command = "jira_save";
    let (site, email, token) = checked_form(&site, &email, &token)?;
    let dir = config_dir(&app).map_err(|e| log_failure(command, LOG_ACCOUNT, e))?;
    let saved = Saved {
        site: site.clone(),
        email: email.clone(),
    };
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        match token {
            Some(token) => keychain::write(TOKEN_SERVICE, TOKEN_USER, &token)?,
            None if keychain::read(TOKEN_SERVICE, TOKEN_USER)?.is_none() => {
                return Err(TOKEN_MISSING.into())
            }
            None => {}
        }
        save_file(&dir, &saved)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    .map_err(|e| log_failure(command, LOG_ACCOUNT, e))?;
    Ok(JiraSettings {
        site,
        email,
        has_token: true,
    })
}

/// Tries the credential of the form against the site: an empty `token` takes the stored one. Saves nothing.
#[tauri::command]
pub async fn jira_test(site: String, email: String, token: String) -> Result<JiraUser, String> {
    let command = "jira_test";
    let (site, email, token) = checked_form(&site, &email, &token)?;
    let token = match token {
        Some(token) => token,
        None => stored_token()
            .await
            .map_err(|e| log_failure(command, LOG_ACCOUNT, e))?
            .ok_or(TOKEN_MISSING)?,
    };
    fetch_user(&site, &authorization(&email, &token))
        .await
        .map_err(|e| log_failure(command, LOG_ACCOUNT, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn site_url_takes_an_atlassian_cloud_site_and_keeps_its_origin_only() {
        for (input, want) in [
            (
                "https://example.atlassian.net",
                "https://example.atlassian.net",
            ),
            (
                "  https://example.atlassian.net/  ",
                "https://example.atlassian.net",
            ),
            (
                "https://Example.Atlassian.net/jira/software?x=1#y",
                "https://example.atlassian.net",
            ),
            (
                "https://my-team2.atlassian.net:443",
                "https://my-team2.atlassian.net",
            ),
        ] {
            assert_eq!(site_url(input).as_deref(), Ok(want), "{input}");
        }
    }

    #[test]
    fn site_url_refuses_every_other_destination() {
        for input in [
            "",
            "example.atlassian.net",
            "http://example.atlassian.net",
            "https://atlassian.net",
            "https://.atlassian.net",
            "https://example.com",
            "https://example.atlassian.net.evil.example",
            "https://evil.example/.atlassian.net",
            "https://example.atlassian.net@evil.example",
            "https://evil.example@example.atlassian.net",
            "https://a.b.atlassian.net",
            "https://example.atlassian.net:8443",
            "https://example.atlassian.net.",
            "https://-example.atlassian.net",
            "https://exa_mple.atlassian.net",
            "ftp://example.atlassian.net",
            "https://127.0.0.1",
        ] {
            assert!(site_url(input).is_err(), "{input}");
        }
    }

    #[test]
    fn email_of_allows_none_and_refuses_what_would_break_a_credential() {
        assert_eq!(email_of(""), Ok(String::new()));
        assert_eq!(email_of("  "), Ok(String::new()));
        assert_eq!(email_of(" me@example.com "), Ok("me@example.com".into()));
        for input in ["me", "me@exa mple.com", "a:b@example.com"] {
            assert!(email_of(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn token_of_trims_and_takes_printable_ascii_only() {
        assert_eq!(token_of(""), Ok(None));
        assert_eq!(token_of("  \n"), Ok(None));
        assert_eq!(token_of(" ATATT3x-abc=\n"), Ok(Some("ATATT3x-abc=".into())));
        assert!(token_of("ab cd").is_err());
        assert!(token_of("ab\ncd").is_err());
        assert!(token_of("トークン").is_err());
    }

    #[test]
    fn authorization_is_bearer_without_an_email_and_basic_with_one() {
        assert_eq!(authorization("", "tok"), "Bearer tok");
        // base64("me@example.com:tok")
        assert_eq!(
            authorization("me@example.com", "tok"),
            "Basic bWVAZXhhbXBsZS5jb206dG9r"
        );
    }

    #[test]
    fn user_of_reads_a_success_and_says_why_for_a_failure() {
        let ok = user_of(
            200,
            r#"{"accountId":"1","displayName":"Example User","emailAddress":"me@example.com"}"#,
        );
        assert_eq!(
            ok,
            Ok(JiraUser {
                display_name: "Example User".into(),
                email_address: Some("me@example.com".into())
            })
        );
        // A scoped token may be given no email address.
        assert_eq!(
            user_of(200, r#"{"displayName":"Example User"}"#),
            Ok(JiraUser {
                display_name: "Example User".into(),
                email_address: None
            })
        );
        assert!(user_of(200, "<html>login</html>")
            .unwrap_err()
            .starts_with("Jira の応答を読めません"));
        assert_eq!(
            user_of(401, "{}"),
            Err("Jira が認証を拒否しました（401）".into())
        );
        assert_eq!(
            user_of(403, "{}"),
            Err("Jira が認証を拒否しました（403）".into())
        );
        assert_eq!(
            user_of(500, "down"),
            Err("Jira が 500 を返しました: down".into())
        );
        let long = "x".repeat(BODY_LIMIT + 50);
        assert_eq!(
            user_of(502, &long).unwrap_err(),
            format!("Jira が 502 を返しました: {}", "x".repeat(BODY_LIMIT))
        );
    }

    #[test]
    fn checked_form_checks_each_field_and_keeps_an_empty_token_as_none() {
        assert_eq!(
            checked_form("https://example.atlassian.net/x", "", ""),
            Ok(("https://example.atlassian.net".into(), String::new(), None))
        );
        assert_eq!(
            checked_form("https://example.atlassian.net", "me@example.com", " tok "),
            Ok((
                "https://example.atlassian.net".into(),
                "me@example.com".into(),
                Some("tok".into())
            ))
        );
        assert!(checked_form("https://example.com", "", "tok").is_err());
        assert!(checked_form("https://example.atlassian.net", "me", "tok").is_err());
        assert!(checked_form("https://example.atlassian.net", "", "a b").is_err());
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tsunagiai-test-{}-jira-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_file_round_trips_holds_no_token_and_is_empty_before_the_first_save() {
        let dir = temp_dir("file");
        assert_eq!(load_file(&dir), Ok(Saved::default()));
        let saved = Saved {
            site: "https://example.atlassian.net".into(),
            email: "me@example.com".into(),
        };
        save_file(&dir, &saved).unwrap();
        assert_eq!(load_file(&dir), Ok(saved));
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(!text.to_lowercase().contains("token"));
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load_file(&dir).unwrap_err().contains("形式が不正"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Serves one answer on a local port, and returns the base URL and what the request said.
    async fn serve_once(answer: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
            }
            socket.write_all(answer.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (base, seen)
    }

    const OK_BODY: &str = r#"{"displayName":"Example User","emailAddress":"a@b.cc"}"#;

    fn ok_answer() -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{OK_BODY}",
            OK_BODY.len()
        )
    }

    #[tokio::test]
    async fn fetch_user_sends_a_basic_credential_to_myself_and_reads_the_user() {
        let (base, seen) = serve_once(ok_answer()).await;
        let user = fetch_user(&base, &authorization("me@example.com", "tok"))
            .await
            .unwrap();
        assert_eq!(user.display_name, "Example User");
        let request = seen.await.unwrap();
        assert!(
            request.starts_with("GET /rest/api/3/myself HTTP/1.1"),
            "{request}"
        );
        assert!(
            request
                .to_lowercase()
                .contains("authorization: basic bwvazxhhbxbszs5jb206dg9r"),
            "{request}"
        );
    }

    #[tokio::test]
    async fn fetch_user_sends_a_bearer_credential_when_there_is_no_email() {
        let (base, seen) = serve_once(ok_answer()).await;
        fetch_user(&base, &authorization("", "tok")).await.unwrap();
        assert!(seen
            .await
            .unwrap()
            .to_lowercase()
            .contains("authorization: bearer tok\r\n"));
    }

    #[tokio::test]
    async fn fetch_user_reports_a_rejected_credential() {
        let (base, _seen) = serve_once(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        )
        .await;
        let err = fetch_user(&base, &authorization("", "bad"))
            .await
            .unwrap_err();
        assert_eq!(err, "Jira が認証を拒否しました（401）");
    }

    #[tokio::test]
    async fn fetch_user_does_not_follow_a_redirect() {
        let (base, seen) = serve_once(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into(),
        )
        .await;
        let err = fetch_user(&base, &authorization("", "tok"))
            .await
            .unwrap_err();
        assert_eq!(err, "Jira が 302 を返しました: ");
        assert!(seen.await.unwrap().starts_with("GET /rest/api/3/myself"));
    }

    #[tokio::test]
    async fn fetch_user_reports_a_host_that_cannot_be_reached() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = fetch_user(&format!("http://127.0.0.1:{port}"), "Bearer tok")
            .await
            .unwrap_err();
        assert!(!err.is_empty());
    }
}
