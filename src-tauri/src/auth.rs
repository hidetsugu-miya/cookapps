use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use url::Url;

use crate::accounts;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify";
const KEYRING_SERVICE: &str = "jp.mysis.cookup";
const LEGACY_KEYRING_USER: &str = "google-refresh-token";
const PROFILE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Deserialize)]
struct ClientFile {
    installed: Client,
}

#[derive(Deserialize)]
struct Client {
    client_id: String,
    client_secret: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    email_address: String,
}

/// Holds the access tokens (per account) in memory only; refresh tokens live in the keychain.
pub struct Auth {
    http: reqwest::Client,
    access: Mutex<HashMap<String, String>>,
}

impl Auth {
    pub fn new() -> Self {
        Self {
            // A stalled connection must not leave a command waiting forever.
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            access: Mutex::new(HashMap::new()),
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Cached access token, else a refreshed one. `None` means login is required.
    pub async fn token(&self, app: &AppHandle, account: &str) -> Result<Option<String>, String> {
        let cached = self.access.lock().unwrap().get(account).cloned();
        match cached {
            Some(t) => Ok(Some(t)),
            None => self.refresh(app, account).await,
        }
    }

    /// `None` means login is required (no stored token, or Google rejected it with invalid_grant).
    pub async fn refresh(&self, app: &AppHandle, account: &str) -> Result<Option<String>, String> {
        let entry = keyring_entry(account)?;
        let refresh_token = match entry.get_password() {
            Ok(p) => p,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(e) => return Err(format!("キーチェーンの読み取りに失敗: {e}")),
        };
        let client = load_client(app)?;
        match self.refresh_access(&client, &refresh_token).await? {
            Some(access) => {
                self.access
                    .lock()
                    .unwrap()
                    .insert(account.to_owned(), access.clone());
                Ok(Some(access))
            }
            None => {
                self.access.lock().unwrap().remove(account);
                delete_entry(&entry)?;
                Ok(None)
            }
        }
    }

    /// Registered accounts. First moves the single-account keychain entry of an older version, once.
    pub async fn accounts(&self, app: &AppHandle) -> Result<Vec<String>, String> {
        let dir = config_dir(app)?;
        let stored = accounts::load(&dir)?;
        let legacy = legacy_keyring_entry()?;
        let legacy_token = match legacy.get_password() {
            Ok(p) => Some(p),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => return Err(format!("キーチェーンの読み取りに失敗: {e}")),
        };
        if !accounts::needs_migration(stored.is_some(), legacy_token.is_some()) {
            return Ok(stored.unwrap_or_default());
        }
        let legacy_token = legacy_token.unwrap_or_default();
        let client = load_client(app)?;
        let Some(access) = self.refresh_access(&client, &legacy_token).await? else {
            delete_entry(&legacy)?;
            return Ok(vec![]);
        };
        let email = self.fetch_email(&access).await?;
        keyring_entry(&email)?
            .set_password(&legacy_token)
            .map_err(|e| format!("キーチェーンへの保存に失敗: {e}"))?;
        accounts::save(&dir, std::slice::from_ref(&email))?;
        delete_entry(&legacy)?;
        self.access.lock().unwrap().insert(email.clone(), access);
        Ok(vec![email])
    }

    /// Returns the logged-in account's email address.
    async fn login(&self, app: &AppHandle, login_hint: Option<&str>) -> Result<String, String> {
        // Runs the legacy migration first so adding an account never strands the old token.
        let existing = self.accounts(app).await?;
        let client = load_client(app)?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let redirect_uri = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().map_err(|e| e.to_string())?.port()
        );
        let verifier = random_string()?;
        let state = random_string()?;
        let mut url = Url::parse(AUTH_URL).map_err(|e| e.to_string())?;
        url.query_pairs_mut()
            .append_pair("client_id", &client.client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", SCOPE)
            .append_pair("code_challenge", &pkce_challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "select_account consent");
        if let Some(hint) = login_hint {
            url.query_pairs_mut().append_pair("login_hint", hint);
        }
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|e| format!("ブラウザを開けません: {e}"))?;

        let code = tokio::time::timeout(LOGIN_TIMEOUT, receive_code(&listener, &state))
            .await
            .map_err(|_| "ログインがタイムアウトしました".to_string())??;
        let res = self
            .token_request(&[
                ("client_id", &client.client_id),
                ("client_secret", &client.client_secret),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .await?;
        let refresh_token = res
            .refresh_token
            .clone()
            .ok_or("リフレッシュトークンが返されませんでした")?;
        let access = access_token_of(res)?;
        let email = self.fetch_email(&access).await?;
        keyring_entry(&email)?
            .set_password(&refresh_token)
            .map_err(|e| format!("キーチェーンへの保存に失敗: {e}"))?;
        accounts::save(&config_dir(app)?, &accounts::with_account(existing, &email))?;
        self.access.lock().unwrap().insert(email.clone(), access);
        Ok(email)
    }

    /// `None` means Google rejected the refresh token with invalid_grant.
    async fn refresh_access(
        &self,
        client: &Client,
        refresh_token: &str,
    ) -> Result<Option<String>, String> {
        let res = self
            .token_request(&[
                ("client_id", &client.client_id),
                ("client_secret", &client.client_secret),
                ("refresh_token", refresh_token),
                ("grant_type", "refresh_token"),
            ])
            .await?;
        if res.error.as_deref() == Some("invalid_grant") {
            return Ok(None);
        }
        access_token_of(res).map(Some)
    }

    async fn fetch_email(&self, access: &str) -> Result<String, String> {
        let res = self
            .http
            .get(PROFILE_URL)
            .bearer_auth(access)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Gmail API が {status} を返しました: {body}"));
        }
        res.json::<Profile>()
            .await
            .map(|p| p.email_address)
            .map_err(|e| e.to_string())
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenResponse, String> {
        self.http
            .post(TOKEN_URL)
            .form(form)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }
}

/// Returns the email address of the account that logged in.
#[tauri::command]
pub async fn login(
    app: AppHandle,
    auth: State<'_, Auth>,
    login_hint: Option<String>,
) -> Result<String, String> {
    auth.login(&app, login_hint.as_deref()).await.map_err(|e| {
        eprintln!(
            "cookup: login account={} status=- error={e}",
            login_hint.as_deref().unwrap_or("-")
        );
        e
    })
}

fn access_token_of(res: TokenResponse) -> Result<String, String> {
    res.access_token.ok_or_else(|| {
        format!(
            "トークンを取得できませんでした: {} {}",
            res.error.unwrap_or_default(),
            res.error_description.unwrap_or_default()
        )
    })
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())
}

/// A missing entry counts as deleted, so a repeated or concurrent run ends in the same state.
fn delete_entry(entry: &keyring::Entry) -> Result<(), String> {
    ignore_missing(entry.delete_credential())
}

fn ignore_missing(result: Result<(), keyring::Error>) -> Result<(), String> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("キーチェーンの削除に失敗: {e}")),
    }
}

/// The single-account entry of versions before multi-account support.
fn legacy_keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, LEGACY_KEYRING_USER).map_err(|e| e.to_string())
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn load_client(app: &AppHandle) -> Result<Client, String> {
    let path = config_dir(app)?.join("client_secret.json");
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "OAuth クライアント JSON を読めません。{} に配置してください: {e}",
            path.display()
        )
    })?;
    serde_json::from_str::<ClientFile>(&text)
        .map(|f| f.installed)
        .map_err(|e| format!("{} の形式が不正です: {e}", path.display()))
}

fn random_string() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Serves the loopback listener until the redirect arrives; other requests (favicon etc.) get a 404.
async fn receive_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let line = request.lines().next().unwrap_or("");
        let (status, body) = if line.starts_with("GET /?") {
            (
                "200 OK",
                "ログイン処理が完了しました。このタブは閉じて構いません。",
            )
        } else {
            ("404 Not Found", "")
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        // The browser may already have gone; the code is what matters.
        let _ = stream.write_all(response.as_bytes()).await;
        if status == "200 OK" {
            return code_from_request(line, state);
        }
    }
}

/// Extracts the authorization code from a request line such as `GET /?code=..&state=.. HTTP/1.1`.
fn code_from_request(line: &str, expected_state: &str) -> Result<String, String> {
    let path = line
        .split_whitespace()
        .nth(1)
        .ok_or("不正なリダイレクトです")?;
    let url = Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;
    let (mut code, mut state, mut error) = (None, None, None);
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(e) = error {
        return Err(format!("Google がエラーを返しました: {e}"));
    }
    if state.as_deref() != Some(expected_state) {
        return Err("state が一致しません".into());
    }
    code.ok_or_else(|| "認可コードがありません".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_appendix_b() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn extracts_code_when_state_matches() {
        let line = "GET /?code=4%2Fabc&state=xyz&scope=s HTTP/1.1";
        assert_eq!(code_from_request(line, "xyz"), Ok("4/abc".into()));
    }

    #[test]
    fn rejects_state_mismatch() {
        let line = "GET /?code=abc&state=other HTTP/1.1";
        assert_eq!(
            code_from_request(line, "xyz"),
            Err("state が一致しません".into())
        );
    }

    #[test]
    fn rejects_error_parameter() {
        let line = "GET /?error=access_denied&state=xyz HTTP/1.1";
        let err = code_from_request(line, "xyz").unwrap_err();
        assert!(err.contains("access_denied"));
    }

    #[test]
    fn rejects_missing_code() {
        let line = "GET /?state=xyz HTTP/1.1";
        assert_eq!(
            code_from_request(line, "xyz"),
            Err("認可コードがありません".into())
        );
    }

    #[test]
    fn deleting_a_missing_entry_succeeds() {
        assert_eq!(ignore_missing(Ok(())), Ok(()));
        assert_eq!(ignore_missing(Err(keyring::Error::NoEntry)), Ok(()));
        let err = ignore_missing(Err(keyring::Error::Invalid("k".into(), "v".into())));
        assert!(err.unwrap_err().contains("キーチェーンの削除に失敗"));
    }

    #[test]
    fn parses_profile_email_address() {
        let p: Profile = serde_json::from_str(
            r#"{"emailAddress": "a@example.com", "messagesTotal": 3, "historyId": "9"}"#,
        )
        .unwrap();
        assert_eq!(p.email_address, "a@example.com");
    }

    #[test]
    fn rejects_malformed_request_line() {
        assert!(code_from_request("GET", "xyz").is_err());
    }
}
