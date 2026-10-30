use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex as AsyncMutex,
};
use url::Url;

use crate::{
    accounts,
    calendar::{self, CalendarCache},
    disk_cache,
    gmail::{self, InlineCache, SyncState},
};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly";
// Existing refresh tokens live under this name, so it must stay equal to `identifier` in tauri.conf.json.
const KEYRING_SERVICE: &str = "jp.mysis.cookup";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
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
/// Clones share the tokens, so a spawned task can own one.
#[derive(Clone)]
pub struct Auth {
    http: reqwest::Client,
    access: Arc<Mutex<HashMap<String, String>>>,
    /// Per account, held while its token is refreshed, so calls that were rejected together refresh once.
    refreshing: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
}

impl Auth {
    pub fn new() -> Self {
        Self {
            // A stalled connection must not leave a command waiting forever.
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            access: Arc::default(),
            refreshing: Arc::default(),
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Cached access token, else a refreshed one. `None` means login is required.
    pub async fn token(&self, dir: &Path, account: &str) -> Result<Option<String>, String> {
        let cached = self.access.lock().unwrap().get(account).cloned();
        match cached {
            Some(t) => Ok(Some(t)),
            None => self.refresh(dir, account, "").await,
        }
    }

    /// A new access token after `rejected` was refused. Calls rejected at the same time take turns: one that finds
    /// a token other than `rejected` in the cache once it has the turn uses that one instead of refreshing again.
    /// `None` means login is required (no stored token, or Google rejected it with invalid_grant).
    pub async fn refresh(
        &self,
        dir: &Path,
        account: &str,
        rejected: &str,
    ) -> Result<Option<String>, String> {
        let turn = self
            .refreshing
            .lock()
            .unwrap()
            .entry(account.to_owned())
            .or_default()
            .clone();
        let _turn = turn.lock().await;
        let cached = self.access.lock().unwrap().get(account).cloned();
        if let Some(token) = cached.filter(|t| t != rejected) {
            return Ok(Some(token));
        }
        // The keychain service holds names that are not accounts, so a name from outside is checked before it reaches it.
        if !is_registered(&self.accounts(dir)?, account) {
            return Ok(None);
        }
        let entry = keyring_entry(account)?;
        let refresh_token = match entry.get_password() {
            Ok(p) => p,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(e) => return Err(format!("資格情報の読み取りに失敗: {e}")),
        };
        let client = load_client(dir)?;
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

    /// Registered accounts.
    pub fn accounts(&self, dir: &Path) -> Result<Vec<String>, String> {
        Ok(accounts::load(dir)?.unwrap_or_default())
    }

    /// Revokes the account's grant at Google (a failure is logged, not fatal), then forgets its token, its listing and the data kept of it.
    async fn remove(&self, dir: &Path, account: &str) -> Result<(), String> {
        let list = self.accounts(dir)?;
        if !is_registered(&list, account) {
            return Err("登録されていないアカウントです".into());
        }
        let entry = keyring_entry(account)?;
        match entry.get_password() {
            Ok(token) => {
                if let Err(e) = revoke(&self.http, REVOKE_URL, &token).await {
                    eprintln!("cookup: revoke account={account} status=- error={e}");
                }
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("資格情報の読み取りに失敗: {e}")),
        }
        delete_entry(&entry)?;
        self.access.lock().unwrap().remove(account);
        // Under the cache lock, so a save that began before cannot write this account's data back after the delete.
        disk_cache::exclusive(|| {
            accounts::save(dir, &accounts::without_account(list, account))?;
            // The kept mail list and calendar hold this account's subjects and events.
            [gmail::CACHE_FILE, calendar::CACHE_FILE]
                .into_iter()
                .try_for_each(|file| disk_cache::remove(dir, file))
        })
    }

    /// Returns the logged-in account's email address.
    async fn login(&self, app: &AppHandle, login_hint: Option<&str>) -> Result<String, String> {
        let dir = config_dir(app)?;
        let existing = self.accounts(&dir)?;
        let client = load_client(&dir)?;
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
            // Keeps the scopes granted earlier, so a re-login for the calendar does not drop Gmail's.
            .append_pair("include_granted_scopes", "true")
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
            .map_err(|e| format!("資格情報の保存に失敗: {e}"))?;
        accounts::save(&dir, &accounts::with_account(existing, &email))?;
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

impl Default for Auth {
    fn default() -> Self {
        Self::new()
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

/// Removes an account from cookup: revokes its grant at Google and drops every trace of it kept here.
#[tauri::command]
pub async fn remove_account(
    app: AppHandle,
    auth: State<'_, Auth>,
    sync: State<'_, SyncState>,
    calendar: State<'_, CalendarCache>,
    images: State<'_, InlineCache>,
    account: String,
) -> Result<(), String> {
    sync.forget(&account);
    calendar.forget(&account);
    images.forget(&account);
    let removed = match config_dir(&app) {
        Ok(dir) => auth.remove(&dir, &account).await,
        Err(e) => Err(e),
    };
    removed.map_err(|e| {
        eprintln!("cookup: remove_account account={account} status=- error={e}");
        e
    })
}

/// Asks Google to revoke the token (a refresh token also ends its access tokens).
async fn revoke(http: &reqwest::Client, url: &str, token: &str) -> Result<(), String> {
    let res = http
        .post(url)
        .form(&[("token", token)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if status.is_success() {
        return Ok(());
    }
    let body = res.text().await.unwrap_or_default();
    Err(format!("Google が {status} を返しました: {body}"))
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

fn is_registered(list: &[String], account: &str) -> bool {
    list.iter().any(|a| a == account)
}

pub(crate) fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())
}

/// A missing entry counts as deleted, so a repeated or concurrent run ends in the same state.
pub(crate) fn delete_entry(entry: &keyring::Entry) -> Result<(), String> {
    ignore_missing(entry.delete_credential())
}

fn ignore_missing(result: Result<(), keyring::Error>) -> Result<(), String> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("資格情報の削除に失敗: {e}")),
    }
}

pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn load_client(dir: &Path) -> Result<Client, String> {
    let path = dir.join("client_secret.json");
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
    fn keyring_service_is_the_app_identifier() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], KEYRING_SERVICE);
    }

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
        assert!(err.unwrap_err().contains("資格情報の削除に失敗"));
    }

    /// Writes, reads and deletes a real Windows Credential Manager entry under a service name only this test uses.
    #[cfg(windows)]
    #[test]
    fn credential_manager_round_trip() {
        let user = format!("round-trip-{}", std::process::id());
        let entry = keyring::Entry::new("jp.mysis.cookup.test", &user).unwrap();
        let written = entry.set_password("secret-value");
        let read = entry.get_password();
        // Deleted before any assertion, so a failed assertion leaves nothing behind.
        let deleted = entry.delete_credential();
        written.unwrap();
        assert_eq!(read.unwrap(), "secret-value");
        deleted.unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }

    /// Answers one request with `response`, then hands back the request it received.
    fn serve_once(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/revoke", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (url, handle)
    }

    fn revoke_at(url: &str) -> Result<(), String> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(revoke(&reqwest::Client::new(), url, "4/a b"))
    }

    #[test]
    fn revoke_posts_the_token_as_a_form_body() {
        let (url, server) =
            serve_once("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(revoke_at(&url), Ok(()));
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /revoke "));
        assert!(request.contains("application/x-www-form-urlencoded"));
        assert!(request.ends_with("token=4%2Fa+b"));
    }

    #[test]
    fn revoke_reports_a_rejection_with_its_status() {
        let (url, server) = serve_once(
            "HTTP/1.1 400 Bad Request\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{\"error\":\"invalid_token\"}\n",
        );
        let err = revoke_at(&url).unwrap_err();
        server.join().unwrap();
        assert!(
            err.contains("400") && err.contains("invalid_token"),
            "{err}"
        );
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
    fn only_listed_accounts_are_registered() {
        let list = vec!["a@example.com".to_string()];
        assert!(is_registered(&list, "a@example.com"));
        assert!(!is_registered(&list, "todoist"));
        assert!(!is_registered(&[], "a@example.com"));
    }

    /// A directory without accounts.json: no account is registered, so neither call reaches the keychain.
    #[test]
    fn refresh_and_remove_refuse_an_unregistered_account() {
        let dir = std::env::temp_dir().join("cookup-test-no-accounts");
        let auth = Auth::new();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(rt.block_on(auth.refresh(&dir, "todoist", "")), Ok(None));
        let err = rt.block_on(auth.remove(&dir, "todoist")).unwrap_err();
        assert!(err.contains("登録されていない"), "{err}");
    }

    /// The token another call already refreshed is used without touching the keychain: the directory has no accounts.json.
    #[test]
    fn refresh_uses_the_token_a_concurrent_call_already_refreshed() {
        let dir = std::env::temp_dir().join("cookup-test-no-accounts");
        let auth = Auth::new();
        auth.access
            .lock()
            .unwrap()
            .insert("a@example.com".into(), "new".into());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            rt.block_on(auth.refresh(&dir, "a@example.com", "old")),
            Ok(Some("new".into()))
        );
        // `new` itself was rejected: nothing newer is cached, and the account is not registered.
        assert_eq!(
            rt.block_on(auth.refresh(&dir, "a@example.com", "new")),
            Ok(None)
        );
    }

    #[test]
    fn rejects_malformed_request_line() {
        assert!(code_from_request("GET", "xyz").is_err());
    }
}
