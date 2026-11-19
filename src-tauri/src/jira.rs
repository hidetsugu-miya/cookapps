//! The connection to Jira Cloud (J-1, #868): the site's URL and the email address in `jira-settings.json` of the app config directory, the API token in the keychain, and a test of the connection.
//!
//! Only Atlassian Cloud is spoken to: the site is `https://{name}.atlassian.net` and nothing else (`site_url`), and a token goes to that site or to `api.atlassian.com` only, never to another host.
//! An email address makes the token a Basic credential (`email:token`, an API token of an account) sent to the site; with none it is a Bearer token (a scoped token) sent through the gateway `api.atlassian.com/ex/jira/{cloudId}`, which is the only place Atlassian takes it (`api_base` chooses).
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
/// The call that tells who the credential belongs to, after `api_base`.
const MYSELF_PATH: &str = "/rest/api/3/myself";
/// Where a scoped token is used (Atlassian's platform API gateway): `{GATEWAY}/ex/jira/{cloudId}/rest/api/3/...`.
const GATEWAY: &str = "https://api.atlassian.com";
/// The site's own answer to who it is; it needs no credential, and holds the Cloud ID.
const TENANT_INFO_PATH: &str = "/_edge/tenant_info";
/// The longest Cloud ID taken (they are UUIDs of 36 characters).
const CLOUD_ID_LIMIT: usize = 64;
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

/// The client of every call here. A redirect is not followed, so a credential never goes to another host.
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// The Cloud ID in the answer of `TENANT_INFO_PATH`: letters, digits and hyphens only, since it goes into a URL.
fn cloud_id_of(status: u16, body: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TenantInfo {
        cloud_id: String,
    }
    if !(200..=299).contains(&status) {
        return Err(format!("Jira のサイトを確かめられません（{status}）"));
    }
    let id = serde_json::from_str::<TenantInfo>(body)
        .map_err(|e| format!("Jira のサイトの応答を読めません: {e}"))?
        .cloud_id;
    let ok = !id.is_empty()
        && id.len() <= CLOUD_ID_LIMIT
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(id)
    } else {
        Err("Jira のサイトの Cloud ID の形が正しくありません".into())
    }
}

/// The URL that Jira's REST paths (`/rest/api/3/...`) are put after, for this credential: the one place that chooses it.
/// With an email address (an API token of an account, Basic) it is the site's own origin.
/// With none (a scoped token, Bearer) it is the gateway, `{gateway}/ex/jira/{cloudId}`, because Atlassian refuses a scoped token on the site's URL (401); the Cloud ID is asked of the site, which is sent no credential.
/// `gateway` is `GATEWAY` outside the tests.
pub(crate) async fn api_base(
    http: &reqwest::Client,
    site: &str,
    email: &str,
    gateway: &str,
) -> Result<String, String> {
    if !email.is_empty() {
        return Ok(site.to_owned());
    }
    let res = http
        .get(format!("{site}{TENANT_INFO_PATH}"))
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(format!("{gateway}/ex/jira/{}", cloud_id_of(status, &body)?))
}

/// Asks Jira who the credential belongs to. `base` is what `api_base` answered.
async fn fetch_user(
    http: &reqwest::Client,
    base: &str,
    authorization: &str,
) -> Result<JiraUser, String> {
    let mut header = HeaderValue::from_str(authorization).map_err(|e| e.to_string())?;
    header.set_sensitive(true);
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

/// The test of a connection: `api_base`, then the call of `fetch_user` with the credential.
async fn check(site: &str, email: &str, token: &str, gateway: &str) -> Result<JiraUser, String> {
    let http = client()?;
    let base = api_base(&http, site, email, gateway).await?;
    fetch_user(&http, &base, &authorization(email, token)).await
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
    check(&site, &email, &token, GATEWAY)
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

    const TENANT_ANSWER_ID: &str = "11111111-2222-3333-4444-555555555555";

    fn json_answer(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn tenant_answer() -> String {
        json_answer(&format!(r#"{{"cloudId":"{TENANT_ANSWER_ID}"}}"#))
    }

    const NOT_FOUND: &str =
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    /// The first line and the headers of a request, lowercased.
    fn lower(request: &str) -> String {
        request.to_lowercase()
    }

    #[test]
    fn cloud_id_of_takes_a_cloud_id_and_refuses_what_cannot_go_into_a_url() {
        assert_eq!(
            cloud_id_of(200, r#"{"cloudId":"a436116f-02ce-4520-8fbb-7301462a1674"}"#),
            Ok("a436116f-02ce-4520-8fbb-7301462a1674".into())
        );
        for body in [
            r#"{"cloudId":""}"#,
            r#"{"cloudId":"a/../b"}"#,
            r#"{"cloudId":"a b"}"#,
            r#"{"cloudId":"a?x=1"}"#,
            r#"{"cloudId":"é"}"#,
            r#"{}"#,
            "<html></html>",
        ] {
            assert!(cloud_id_of(200, body).is_err(), "{body}");
        }
        let long = format!(r#"{{"cloudId":"{}"}}"#, "a".repeat(CLOUD_ID_LIMIT + 1));
        assert!(cloud_id_of(200, &long).is_err());
        assert_eq!(
            cloud_id_of(404, "<html></html>"),
            Err("Jira のサイトを確かめられません（404）".into())
        );
    }

    #[tokio::test]
    async fn api_base_is_the_site_itself_for_a_basic_credential_and_asks_nothing() {
        // The gateway is a host that does not exist, so a call to it would fail.
        let http = client().unwrap();
        let base = api_base(
            &http,
            "https://example.atlassian.net",
            "me@example.com",
            "http://gateway.invalid",
        )
        .await;
        assert_eq!(base, Ok("https://example.atlassian.net".into()));
    }

    #[tokio::test]
    async fn api_base_for_a_bearer_credential_is_the_gateway_with_the_cloud_id_of_the_site() {
        let (site, seen) = serve_once(tenant_answer()).await;
        let http = client().unwrap();
        let base = api_base(&http, &site, "", "https://api.example.invalid")
            .await
            .unwrap();
        assert_eq!(
            base,
            format!("https://api.example.invalid/ex/jira/{TENANT_ANSWER_ID}")
        );
        let request = lower(&seen.await.unwrap());
        assert!(
            request.starts_with("get /_edge/tenant_info http/1.1"),
            "{request}"
        );
        // The site is asked who it is with no credential at all.
        assert!(!request.contains("authorization"), "{request}");
    }

    #[tokio::test]
    async fn api_base_stops_when_the_site_does_not_answer_with_a_cloud_id() {
        let http = client().unwrap();
        let (site, _seen) = serve_once(NOT_FOUND.into()).await;
        assert_eq!(
            api_base(&http, &site, "", "http://gateway.invalid").await,
            Err("Jira のサイトを確かめられません（404）".into())
        );
        let (site, _seen) = serve_once(json_answer(r#"{"cloudId":"a/b"}"#)).await;
        assert!(api_base(&http, &site, "", "http://gateway.invalid")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn check_sends_a_basic_credential_to_the_site_and_reads_the_user() {
        let (site, seen) = serve_once(ok_answer()).await;
        let user = check(&site, "me@example.com", "tok", "http://gateway.invalid")
            .await
            .unwrap();
        assert_eq!(user.display_name, "Example User");
        let request = lower(&seen.await.unwrap());
        assert!(
            request.starts_with("get /rest/api/3/myself http/1.1"),
            "{request}"
        );
        assert!(
            request.contains("authorization: basic bwvazxhhbxbszs5jb206dg9r"),
            "{request}"
        );
    }

    #[tokio::test]
    async fn check_sends_a_bearer_credential_to_the_gateway_and_none_to_the_site() {
        let (site, tenant_seen) = serve_once(tenant_answer()).await;
        let (gateway, gateway_seen) = serve_once(ok_answer()).await;
        let user = check(&site, "", "tok", &gateway).await.unwrap();
        assert_eq!(user.display_name, "Example User");
        let request = lower(&gateway_seen.await.unwrap());
        assert!(
            request.starts_with(&format!(
                "get /ex/jira/{TENANT_ANSWER_ID}/rest/api/3/myself http/1.1"
            )),
            "{request}"
        );
        assert!(
            request.contains("authorization: bearer tok\r\n"),
            "{request}"
        );
        let tenant = lower(&tenant_seen.await.unwrap());
        assert!(
            !tenant.contains("authorization") && !tenant.contains("tok"),
            "{tenant}"
        );
    }

    #[tokio::test]
    async fn check_reports_a_rejected_credential() {
        let (site, _seen) = serve_once(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        )
        .await;
        let err = check(&site, "me@example.com", "bad", "http://gateway.invalid")
            .await
            .unwrap_err();
        assert_eq!(err, "Jira が認証を拒否しました（401）");
    }

    #[tokio::test]
    async fn check_does_not_follow_a_redirect_of_either_call() {
        let redirect = "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let (site, seen) = serve_once(redirect.into()).await;
        let err = check(&site, "me@example.com", "tok", "http://gateway.invalid")
            .await
            .unwrap_err();
        assert_eq!(err, "Jira が 302 を返しました: ");
        assert!(seen.await.unwrap().starts_with("GET /rest/api/3/myself"));
        let (site, seen) = serve_once(redirect.into()).await;
        let err = check(&site, "", "tok", "http://gateway.invalid")
            .await
            .unwrap_err();
        assert_eq!(err, "Jira のサイトを確かめられません（302）");
        assert!(seen.await.unwrap().starts_with("GET /_edge/tenant_info"));
    }

    #[tokio::test]
    async fn check_reports_a_host_that_cannot_be_reached() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let site = format!("http://127.0.0.1:{port}");
        assert!(
            !check(&site, "me@example.com", "tok", "http://gateway.invalid")
                .await
                .unwrap_err()
                .is_empty()
        );
        assert!(!check(&site, "", "tok", "http://gateway.invalid")
            .await
            .unwrap_err()
            .is_empty());
    }
}
