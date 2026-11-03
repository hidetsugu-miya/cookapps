//! How `claude -p` is signed in (A-4): with the Claude subscription of the machine, or with an Anthropic API key kept in the keychain.
//! The method is saved in `claude-auth.json`; the key never leaves the keychain except as an environment variable of a `claude` child process.
use std::{fmt, path::Path, time::Duration};

use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_synced, auth::delete_entry};

const AUTH_FILE: &str = "claude-auth.json";
const AUTH_TMP_FILE: &str = "claude-auth.json.tmp";
const KEY_SERVICE: &str = "jp.mysis.cookapps.claude";
const KEY_USER: &str = "api-key";
/// The host the key is checked against; `check_key` takes it as an argument so a test can use a local port.
pub const API_BASE: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2026-10-21";
/// Asking for one model lists nothing the user did not choose, and costs nothing.
const MODELS_PATH: &str = "/v1/models?limit=1";
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const WORKSPACE_HEADER: &str = "anthropic-workspace-id";
const NO_KEY: &str = "API キーが保存されていません。設定の Claude タブで登録してください";

/// How `claude` signs in. The default is the subscription.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone, Copy, Default)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum Method {
    #[default]
    Subscription,
    ApiKey,
}

#[derive(Serialize, Deserialize)]
struct AuthFile {
    method: Method,
}

/// The method a `claude-auth.json` holds; a file that cannot be read, or holds another value, gives the subscription.
fn parse_method(text: &str) -> Method {
    serde_json::from_str::<AuthFile>(text)
        .map(|f| f.method)
        .unwrap_or_default()
}

pub fn load_method(dir: &Path) -> Method {
    std::fs::read_to_string(dir.join(AUTH_FILE))
        .map(|text| parse_method(&text))
        .unwrap_or_default()
}

/// Saves `method` through a temporary file and a rename.
pub fn save_method(dir: &Path, method: Method) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(AUTH_FILE), dir.join(AUTH_TMP_FILE));
    let text = serde_json::to_string_pretty(&AuthFile { method }).map_err(|e| e.to_string())?;
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// An environment variable of the `claude` child process: set to a value, or taken out of what it inherits.
#[derive(PartialEq)]
pub enum EnvChange {
    Set(&'static str, String),
    Remove(&'static str),
}

/// A value is never printed, so a failed assertion or a log line cannot show the key.
impl fmt::Debug for EnvChange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Set(name, _) => write!(f, "Set({name}, <hidden>)"),
            Self::Remove(name) => write!(f, "Remove({name})"),
        }
    }
}

/// What a `claude` call signs in with. It holds the key, so it is never printed.
#[derive(PartialEq, Clone)]
pub enum Connection {
    Subscription,
    ApiKey(String),
}

impl fmt::Debug for Connection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Subscription => write!(f, "Subscription"),
            Self::ApiKey(_) => write!(f, "ApiKey(<hidden>)"),
        }
    }
}

impl Connection {
    /// The environment changes that make `claude` use exactly this sign-in.
    /// `claude` prefers `ANTHROPIC_AUTH_TOKEN` to `ANTHROPIC_API_KEY`, so a key is set and the token is taken out;
    /// the subscription needs none of the three variables, as any of them would take the call away from it.
    pub fn env(&self) -> Vec<EnvChange> {
        match self {
            Self::Subscription => vec![
                EnvChange::Remove("ANTHROPIC_API_KEY"),
                EnvChange::Remove("ANTHROPIC_AUTH_TOKEN"),
                EnvChange::Remove("CLAUDE_CODE_OAUTH_TOKEN"),
            ],
            Self::ApiKey(key) => vec![
                EnvChange::Remove("ANTHROPIC_AUTH_TOKEN"),
                EnvChange::Set("ANTHROPIC_API_KEY", key.clone()),
            ],
        }
    }
}

/// The sign-in for `method` with the stored `key`; the API key method without a key is an error.
fn connection_of(method: Method, key: Option<String>) -> Result<Connection, String> {
    match (method, key) {
        (Method::Subscription, _) => Ok(Connection::Subscription),
        (Method::ApiKey, Some(key)) => Ok(Connection::ApiKey(key)),
        (Method::ApiKey, None) => Err(NO_KEY.to_owned()),
    }
}

/// The sign-in the saved method asks for (reads the keychain only for the API key).
pub fn load_connection(dir: &Path) -> Result<Connection, String> {
    let method = load_method(dir);
    let key = if method == Method::ApiKey {
        read_key()?
    } else {
        None
    };
    connection_of(method, key)
}

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| e.to_string())
}

/// The stored key. `None` means none is stored.
pub fn read_key() -> Result<Option<String>, String> {
    match key_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("資格情報の読み取りに失敗: {e}")),
    }
}

/// The stored key; none stored is an error.
pub fn require_key() -> Result<String, String> {
    read_key()?.ok_or_else(|| NO_KEY.to_owned())
}

pub fn write_key(key: &str) -> Result<(), String> {
    key_entry()?
        .set_password(key)
        .map_err(|e| format!("資格情報の保存に失敗: {e}"))
}

pub fn delete_key() -> Result<(), String> {
    delete_entry(&key_entry()?)
}

/// The key the user pasted, cleaned and checked before anything is sent: surrounding whitespace is dropped,
/// an Admin key (which cannot call the models) and anything that is not an API key is refused.
pub fn check_key_format(input: &str) -> Result<String, String> {
    let key = input.trim();
    if key.is_empty() {
        return Err("API キーを入力してください".to_owned());
    }
    if key.starts_with("sk-ant-admin") {
        return Err(
            "Admin キー（sk-ant-admin…）は使えません。通常の API キーを貼ってください".to_owned(),
        );
    }
    if !key.starts_with("sk-ant-") {
        return Err("API キーは sk-ant- で始まります。貼ったものを確かめてください".to_owned());
    }
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("API キーに使えない文字が含まれています".to_owned());
    }
    Ok(key.to_owned())
}

/// What asking Anthropic about a key found.
#[derive(Debug, PartialEq)]
pub enum KeyCheck {
    /// The key works; the workspace it belongs to, if Anthropic said.
    Valid { workspace_id: Option<String> },
    /// 401 or 403: the key itself is refused.
    Rejected,
    /// Anything else (no connection, a timeout, another status): the key is neither proved nor refused.
    Unverified(String),
}

fn classify(status: u16, workspace_id: Option<String>) -> KeyCheck {
    match status {
        200..=299 => KeyCheck::Valid {
            workspace_id: workspace_id.filter(|id| !id.is_empty()),
        },
        401 | 403 => KeyCheck::Rejected,
        other => KeyCheck::Unverified(format!("Anthropic が {other} を返しました")),
    }
}

/// Asks the models endpoint of `base` with `key`. The answer's text is not read, and the key is in no message.
pub async fn check_key(base: &str, key: &str) -> KeyCheck {
    let Ok(http) = reqwest::Client::builder().timeout(CHECK_TIMEOUT).build() else {
        return KeyCheck::Unverified("通信を始められません".to_owned());
    };
    let sent = http
        .get(format!("{base}{MODELS_PATH}"))
        .bearer_auth(key)
        .header("anthropic-version", API_VERSION)
        .send()
        .await;
    match sent {
        Ok(response) => {
            let workspace = response
                .headers()
                .get(WORKSPACE_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            classify(response.status().as_u16(), workspace)
        }
        Err(e) if e.is_timeout() => {
            KeyCheck::Unverified("時間内に答えがありませんでした".to_owned())
        }
        Err(_) => KeyCheck::Unverified("Anthropic に接続できません".to_owned()),
    }
}

/// The API key as the settings card shows it.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ApiKeyState {
    /// No key is stored.
    None,
    /// The key works.
    Ready {
        #[serde(rename = "workspaceId")]
        workspace_id: Option<String>,
    },
    /// A key is stored, but Anthropic could not be asked (it stays usable).
    Unverified { message: String },
    /// A key is stored and Anthropic refuses it.
    Rejected { message: String },
}

/// The state of the stored key from the check of it (`None`: no key is stored).
pub fn key_state(check: Option<KeyCheck>) -> ApiKeyState {
    match check {
        None => ApiKeyState::None,
        Some(KeyCheck::Valid { workspace_id }) => ApiKeyState::Ready { workspace_id },
        Some(KeyCheck::Rejected) => ApiKeyState::Rejected {
            message: "キーが使えません。Console で確かめて、貼り直してください".to_owned(),
        },
        Some(KeyCheck::Unverified(message)) => ApiKeyState::Unverified {
            message: format!("キーを確認できません: {message}"),
        },
    }
}

/// Why a key is not saved when it was checked at registration: a refused key and an unchecked one are told apart, and neither is saved.
pub fn refusal(check: &KeyCheck) -> Option<String> {
    match check {
        KeyCheck::Valid { .. } => None,
        KeyCheck::Rejected => {
            Some("このキーは使えません。Console で確かめて、貼り直してください".to_owned())
        }
        KeyCheck::Unverified(message) => Some(format!(
            "キーを確認できないので保存しませんでした: {message}"
        )),
    }
}

/// Why the switch to the stored key is refused: only a key Anthropic rejects stops it (one that could not be asked about stays usable).
pub fn switch_refusal(check: &KeyCheck) -> Option<String> {
    match check {
        KeyCheck::Rejected => refusal(check),
        _ => None,
    }
}

/// The card's key row when the keychain could not be read: the row alone says so, and the rest of the card is still drawn.
pub fn key_state_or_unverified(read: Result<ApiKeyState, String>) -> ApiKeyState {
    read.unwrap_or_else(|message| ApiKeyState::Unverified { message })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn the_key_service_is_the_apps_with_a_suffix() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            KEY_SERVICE,
            format!("{}.claude", conf["identifier"].as_str().unwrap())
        );
    }

    #[test]
    fn the_method_is_read_from_the_file_and_anything_unreadable_is_the_subscription() {
        assert_eq!(parse_method(r#"{"method":"apiKey"}"#), Method::ApiKey);
        assert_eq!(
            parse_method(r#"{"method":"subscription"}"#),
            Method::Subscription
        );
        for text in [
            "",
            "{",
            "{}",
            "[]",
            "null",
            r#"{"method":"ApiKey"}"#,
            r#"{"method":"api_key"}"#,
            r#"{"method":1}"#,
            r#"{"method":null}"#,
            r#"{"method":"other"}"#,
        ] {
            assert_eq!(parse_method(text), Method::Subscription, "{text}");
        }
    }

    #[test]
    fn the_method_goes_to_the_screen_as_a_camel_case_name() {
        assert_eq!(
            serde_json::to_value(Method::ApiKey).unwrap(),
            serde_json::json!("apiKey")
        );
        assert_eq!(
            serde_json::to_value(Method::Subscription).unwrap(),
            serde_json::json!("subscription")
        );
        assert_eq!(
            serde_json::from_str::<Method>("\"apiKey\"").unwrap(),
            Method::ApiKey
        );
        assert!(serde_json::from_str::<Method>("\"other\"").is_err());
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "cookapps-claude-auth-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn the_saved_method_is_read_back_and_no_file_means_the_subscription() {
        let dir = temp_dir("method");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_method(&dir), Method::Subscription);
        save_method(&dir, Method::ApiKey).unwrap();
        assert_eq!(load_method(&dir), Method::ApiKey);
        assert!(!dir.join(AUTH_TMP_FILE).exists());
        save_method(&dir, Method::Subscription).unwrap();
        assert_eq!(load_method(&dir), Method::Subscription);
        std::fs::write(dir.join(AUTH_FILE), "broken").unwrap();
        assert_eq!(load_method(&dir), Method::Subscription);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_subscription_takes_all_three_credentials_out_of_the_environment() {
        assert_eq!(
            Connection::Subscription.env(),
            [
                EnvChange::Remove("ANTHROPIC_API_KEY"),
                EnvChange::Remove("ANTHROPIC_AUTH_TOKEN"),
                EnvChange::Remove("CLAUDE_CODE_OAUTH_TOKEN"),
            ]
        );
    }

    #[test]
    fn a_key_is_set_and_the_auth_token_that_beats_it_is_taken_out() {
        assert_eq!(
            Connection::ApiKey("sk-ant-x".into()).env(),
            [
                EnvChange::Remove("ANTHROPIC_AUTH_TOKEN"),
                EnvChange::Set("ANTHROPIC_API_KEY", "sk-ant-x".into()),
            ]
        );
    }

    #[test]
    fn the_key_is_in_no_debug_output() {
        let connection = Connection::ApiKey("sk-ant-secret".into());
        let shown = format!("{connection:?} {:?}", connection.env());
        assert!(!shown.contains("secret"), "{shown}");
        assert!(shown.contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn the_api_key_method_needs_a_stored_key() {
        assert_eq!(
            connection_of(Method::ApiKey, Some("sk-ant-x".into())),
            Ok(Connection::ApiKey("sk-ant-x".into()))
        );
        assert_eq!(connection_of(Method::ApiKey, None), Err(NO_KEY.to_owned()));
        // The subscription uses no key, stored or not.
        assert_eq!(
            connection_of(Method::Subscription, Some("sk-ant-x".into())),
            Ok(Connection::Subscription)
        );
        assert_eq!(
            connection_of(Method::Subscription, None),
            Ok(Connection::Subscription)
        );
    }

    #[test]
    fn a_pasted_key_is_trimmed() {
        assert_eq!(
            check_key_format("  sk-ant-api03-abc\n"),
            Ok("sk-ant-api03-abc".to_owned())
        );
    }

    #[test]
    fn what_is_not_an_api_key_is_refused_in_japanese_and_never_echoed() {
        for (input, message) in [
            ("", "入力"),
            ("   \n", "入力"),
            ("sk-ant-admin01-abc", "Admin"),
            (" sk-ant-admin01-abc ", "Admin"),
            ("sk-proj-abc", "sk-ant-"),
            ("abc", "sk-ant-"),
            ("Bearer sk-ant-abc", "sk-ant-"),
            ("sk-ant", "sk-ant-"),
            ("sk-ant-abc def", "文字"),
            ("sk-ant-abc\ndef", "文字"),
            ("sk-ant-あ", "文字"),
        ] {
            let e = check_key_format(input).unwrap_err();
            assert!(e.contains(message), "{input:?}: {e}");
            for secret in ["abc", "def", "あ", "01"] {
                assert!(!e.contains(secret), "{e}");
            }
        }
    }

    #[test]
    fn statuses_are_told_apart() {
        let work = |id: Option<&str>| KeyCheck::Valid {
            workspace_id: id.map(str::to_owned),
        };
        assert_eq!(classify(200, None), work(None));
        assert_eq!(
            classify(204, Some("wrkspc_1".into())),
            work(Some("wrkspc_1"))
        );
        // An empty header says nothing.
        assert_eq!(classify(200, Some(String::new())), work(None));
        assert_eq!(classify(401, None), KeyCheck::Rejected);
        assert_eq!(classify(403, Some("wrkspc_1".into())), KeyCheck::Rejected);
        for status in [400, 404, 429, 500, 529] {
            assert!(
                matches!(classify(status, None), KeyCheck::Unverified(m) if m.contains(&status.to_string())),
                "{status}"
            );
        }
    }

    #[test]
    fn the_card_state_follows_the_check() {
        assert_eq!(key_state(None), ApiKeyState::None);
        assert_eq!(
            key_state(Some(KeyCheck::Valid {
                workspace_id: Some("wrkspc_1".into())
            })),
            ApiKeyState::Ready {
                workspace_id: Some("wrkspc_1".into())
            }
        );
        assert!(matches!(
            key_state(Some(KeyCheck::Rejected)),
            ApiKeyState::Rejected { message } if message.contains("使えません")
        ));
        assert!(matches!(
            key_state(Some(KeyCheck::Unverified("x".into()))),
            ApiKeyState::Unverified { message } if message.contains("確認できません") && message.contains('x')
        ));
    }

    #[test]
    fn the_card_state_is_sent_with_its_names() {
        assert_eq!(
            serde_json::to_value(ApiKeyState::Ready {
                workspace_id: Some("w".into())
            })
            .unwrap(),
            serde_json::json!({"state": "ready", "workspaceId": "w"})
        );
        assert_eq!(
            serde_json::to_value(ApiKeyState::None).unwrap(),
            serde_json::json!({"state": "none"})
        );
    }

    #[test]
    fn only_a_rejected_key_stops_the_switch() {
        assert_eq!(
            switch_refusal(&KeyCheck::Valid { workspace_id: None }),
            None
        );
        assert_eq!(switch_refusal(&KeyCheck::Unverified("x".into())), None);
        let refused = switch_refusal(&KeyCheck::Rejected).unwrap();
        assert!(refused.contains("使えません"), "{refused}");
    }

    #[test]
    fn a_keychain_failure_is_the_key_rows_unverified_state() {
        assert_eq!(
            key_state_or_unverified(Ok(ApiKeyState::None)),
            ApiKeyState::None
        );
        assert_eq!(
            key_state_or_unverified(Err("資格情報の読み取りに失敗: x".into())),
            ApiKeyState::Unverified {
                message: "資格情報の読み取りに失敗: x".into()
            }
        );
    }

    #[test]
    fn only_a_valid_key_is_saved_at_registration() {
        assert_eq!(refusal(&KeyCheck::Valid { workspace_id: None }), None);
        let refused = refusal(&KeyCheck::Rejected).unwrap();
        assert!(refused.contains("使えません"), "{refused}");
        let unchecked = refusal(&KeyCheck::Unverified("接続できません".into())).unwrap();
        assert!(unchecked.contains("保存しませんでした") && unchecked.contains("接続できません"));
        assert_ne!(refused, unchecked);
    }

    /// Answers one request with `response`, then hands back the request it received.
    fn serve_once(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (base, handle)
    }

    fn check_at(base: &str, key: &str) -> KeyCheck {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(check_key(base, key))
    }

    #[test]
    fn the_key_is_sent_as_a_bearer_token_to_the_models_endpoint_and_the_workspace_is_read() {
        let (base, server) = serve_once(
            "HTTP/1.1 200 OK\r\nanthropic-workspace-id: wrkspc_01\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        assert_eq!(
            check_at(&base, "sk-ant-api03-abc"),
            KeyCheck::Valid {
                workspace_id: Some("wrkspc_01".into())
            }
        );
        let request = server.join().unwrap().to_lowercase();
        assert!(request.starts_with("get /v1/models?limit=1 "), "{request}");
        assert!(request.contains("authorization: bearer sk-ant-api03-abc"));
        assert!(request.contains("anthropic-version: 2026-10-21"));
    }

    #[test]
    fn a_refused_key_and_an_unanswered_check_are_different_results() {
        for status in ["401 Unauthorized", "403 Forbidden"] {
            let response: &'static str = Box::leak(
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .into_boxed_str(),
            );
            let (base, server) = serve_once(response);
            assert_eq!(check_at(&base, "sk-ant-x"), KeyCheck::Rejected, "{status}");
            server.join().unwrap();
        }
        let (base, server) = serve_once(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        assert!(
            matches!(check_at(&base, "sk-ant-x"), KeyCheck::Unverified(m) if m.contains("500"))
        );
        server.join().unwrap();
        // Nothing is listening: the check is unanswered, and the key is in no message.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let KeyCheck::Unverified(message) =
            check_at(&format!("http://127.0.0.1:{port}"), "sk-ant-secret")
        else {
            panic!("expected Unverified");
        };
        assert!(!message.contains("secret"), "{message}");
    }
}
