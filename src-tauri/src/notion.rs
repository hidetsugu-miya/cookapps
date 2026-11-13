//! The connection to Notion's MCP server (`mcp.notion.com`): OAuth with a dynamically registered public client
//! (PKCE S256, loopback redirect), the tokens in the keychain, and one call of an MCP tool.
//! It reads and writes no page yet; no screen uses it.

use std::{collections::HashMap, fmt, path::Path, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::{net::TcpListener, sync::Mutex as AsyncMutex};
use url::Url;

use crate::{
    accounts,
    auth::{self, config_dir, delete_entry},
};

const AUTH_URL: &str = "https://mcp.notion.com/authorize";
const TOKEN_URL: &str = "https://mcp.notion.com/token";
const REGISTER_URL: &str = "https://mcp.notion.com/register";
const MCP_URL: &str = "https://mcp.notion.com/mcp";
/// The redirect the client is registered with. Notion accepts any port on `127.0.0.1` for it (RFC 8252), and the path must match.
const REGISTERED_REDIRECT: &str = "http://127.0.0.1/";
const KEYRING_SERVICE: &str = "jp.mysis.cookapps.notion";
const FILE: &str = "notion-accounts.json";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// An access token this close to its end is refreshed before it is used.
const REFRESH_MARGIN_SECS: i64 = 300;
/// The lifetime taken when a token reply has no `expires_in` (Notion's is 8 hours).
const DEFAULT_LIFETIME_SECS: i64 = 3600;
const MCP_PROTOCOL: &str = "2025-06-18";
/// The tools the app may call. The token holds the user's full rights (77 tools, deletion included), so a name outside this list is refused here.
const ALLOWED_TOOLS: [&str; 1] = ["notion-get-self"];

/// What is saved in `notion-accounts.json`: the registered client and the connected workspaces. No token.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NotionFile {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    workspaces: Vec<Workspace>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    name: String,
    #[serde(default)]
    user_name: Option<String>,
    #[serde(default)]
    user_email: Option<String>,
}

/// A connected workspace as the screen gets it. `reconnect` is true when no token is kept (it expired for good or was never saved).
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct NotionAccount {
    workspace_id: String,
    workspace_name: String,
    user_name: Option<String>,
    user_email: Option<String>,
    reconnect: bool,
}

/// The pair kept in the keychain, in one entry, so a new pair replaces the old in one write.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Stored {
    access_token: String,
    refresh_token: String,
    /// Epoch seconds.
    expires_at: i64,
}

impl fmt::Debug for Stored {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Stored(expires_at: {})", self.expires_at)
    }
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    workspace_id: Option<String>,
    workspace_name: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// The access tokens of the workspaces in memory, and the locks that keep a refresh to one at a time.
pub struct NotionState {
    http: reqwest::Client,
    tokens: Mutex<HashMap<String, Stored>>,
    /// Per workspace, held while its token is read, refreshed or removed: a refresh token is good for one use.
    turns: Mutex<HashMap<String, std::sync::Arc<AsyncMutex<()>>>>,
    /// Held for a whole connection, so two logins do not register two clients or race for the file.
    connecting: AsyncMutex<()>,
    /// Held for a read-modify-write of `notion-accounts.json`.
    file: Mutex<()>,
}

impl Default for NotionState {
    fn default() -> Self {
        Self {
            // A stalled connection must not leave a command waiting forever.
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            tokens: Mutex::default(),
            turns: Mutex::default(),
            connecting: AsyncMutex::default(),
            file: Mutex::default(),
        }
    }
}

impl NotionState {
    /// A usable access token of the workspace, refreshed when it is near its end or is `rejected` (the one a call was refused with).
    /// A call that finds in memory a token other than `rejected` once it has the turn uses that one.
    /// `None` means a new connection is needed (not registered, no token kept, or Notion answered invalid_grant).
    pub async fn token(
        &self,
        dir: &Path,
        workspace: &str,
        rejected: &str,
    ) -> Result<Option<String>, String> {
        // The names the keychain is asked for are the registered ones only.
        if !self.is_registered(dir, workspace)? {
            return Ok(None);
        }
        let turn = self.turn(workspace);
        let _turn = turn.lock().await;
        let now = now();
        let cached = self.tokens.lock().unwrap().get(workspace).cloned();
        let stored = match cached {
            Some(s) => s,
            None => match read_stored(workspace)? {
                Some(s) => {
                    self.tokens
                        .lock()
                        .unwrap()
                        .insert(workspace.to_owned(), s.clone());
                    s
                }
                None => return Ok(None),
            },
        };
        if usable(&stored, rejected, now) {
            return Ok(Some(stored.access_token));
        }
        let client_id = load_file(dir)?
            .client_id
            .ok_or("Notion のクライアントが登録されていません")?;
        match refresh_pair(&self.http, TOKEN_URL, &client_id, &stored, now).await? {
            Some(new) => {
                // The old refresh token is dead from here on, so the new pair is kept in memory even when the keychain write fails.
                self.tokens
                    .lock()
                    .unwrap()
                    .insert(workspace.to_owned(), new.clone());
                write_stored(workspace, &new)?;
                Ok(Some(new.access_token))
            }
            None => {
                self.tokens.lock().unwrap().remove(workspace);
                delete_entry(&entry(workspace)?)?;
                Ok(None)
            }
        }
    }

    /// Calls one MCP tool of the allowed list and answers its text. A 401 refreshes the token once and calls again.
    /// `None` means a new connection is needed.
    pub async fn call_tool(
        &self,
        dir: &Path,
        workspace: &str,
        tool: &str,
        args: Value,
    ) -> Result<Option<String>, String> {
        if !tool_allowed(tool) {
            return Err(format!("許可していない Notion のツールです: {tool}"));
        }
        let Some(token) = self.token(dir, workspace, "").await? else {
            return Ok(None);
        };
        if let Some(result) = mcp_call(&self.http, MCP_URL, &token, tool, &args).await? {
            return tool_text(&result).map(Some);
        }
        let Some(fresh) = self.token(dir, workspace, &token).await? else {
            return Ok(None);
        };
        match mcp_call(&self.http, MCP_URL, &fresh, tool, &args).await? {
            Some(result) => tool_text(&result).map(Some),
            None => Ok(None),
        }
    }

    /// The connected workspaces, each with whether it needs a new connection. Asks Notion nothing.
    fn accounts(&self, dir: &Path) -> Result<Vec<NotionAccount>, String> {
        load_file(dir)?
            .workspaces
            .into_iter()
            .map(|w| {
                let kept = self.tokens.lock().unwrap().contains_key(&w.id)
                    || read_stored(&w.id)?.is_some();
                Ok(account_of(w, !kept))
            })
            .collect()
    }

    /// Opens the browser for Notion's consent and keeps what comes back.
    async fn connect(&self, app: &AppHandle) -> Result<NotionAccount, String> {
        let _one = self.connecting.lock().await;
        let dir = config_dir(app)?;
        let client_id = self.client_id(&dir).await?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let redirect_uri = format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().map_err(|e| e.to_string())?.port()
        );
        let verifier = auth::random_string()?;
        let state = auth::random_string()?;
        let url = authorize_url(
            &client_id,
            &redirect_uri,
            &auth::pkce_challenge(&verifier),
            &state,
        )?;
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|e| format!("ブラウザを開けません: {e}"))?;
        let code = tokio::time::timeout(
            LOGIN_TIMEOUT,
            auth::receive_code(&listener, &state, "Notion"),
        )
        .await
        .map_err(|_| "ログインがタイムアウトしました".to_string())??;
        let reply = token_post(
            &self.http,
            TOKEN_URL,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &client_id),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect_uri),
            ],
        )
        .await?;
        let (workspace_id, workspace_name) =
            (reply.workspace_id.clone(), reply.workspace_name.clone());
        let stored = next_stored(reply, None, now())?;
        let Some(id) = workspace_id.filter(|id| !id.is_empty()) else {
            // The grant exists at Notion but cannot be kept under a name, so it is given back.
            if let Err(e) = revoke(&self.http, TOKEN_URL, &client_id, &stored.refresh_token).await {
                eprintln!("cookapps: notion revoke status=- error={e}");
            }
            return Err("Notion がワークスペースを知らせませんでした".into());
        };
        let name = workspace_name
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| id.clone());
        // Saved before the first use, so a failed write never leaves a token only in memory.
        write_stored(&id, &stored)?;
        self.tokens.lock().unwrap().insert(id.clone(), stored);
        let mut workspace = Workspace {
            id: id.clone(),
            name,
            user_name: None,
            user_email: None,
        };
        self.update_file(&dir, |f| {
            upsert_workspace(&mut f.workspaces, workspace.clone())
        })?;
        // The user is for showing whose workspace it is; a failure here does not undo the connection.
        match self
            .call_tool(&dir, &id, "notion-get-self", json!({}))
            .await
        {
            Ok(Some(text)) => {
                (workspace.user_name, workspace.user_email) = user_of(&text);
                self.update_file(&dir, |f| {
                    upsert_workspace(&mut f.workspaces, workspace.clone())
                })?;
            }
            Ok(None) => {}
            Err(e) => eprintln!("cookapps: notion get-self workspace={id} status=- error={e}"),
        }
        Ok(account_of(workspace, false))
    }

    /// Revokes the grant at Notion (a failure is logged, not fatal), then forgets the token and the workspace.
    async fn disconnect(&self, dir: &Path, workspace: &str) -> Result<(), String> {
        if !self.is_registered(dir, workspace)? {
            return Err("登録されていないワークスペースです".into());
        }
        let turn = self.turn(workspace);
        let _turn = turn.lock().await;
        let cached = self.tokens.lock().unwrap().get(workspace).cloned();
        let stored = match cached {
            Some(s) => Some(s),
            None => read_stored(workspace)?,
        };
        if let (Some(stored), Some(client_id)) = (stored, load_file(dir)?.client_id) {
            if let Err(e) = revoke(&self.http, TOKEN_URL, &client_id, &stored.refresh_token).await {
                eprintln!("cookapps: notion revoke workspace={workspace} status=- error={e}");
            }
        }
        delete_entry(&entry(workspace)?)?;
        self.tokens.lock().unwrap().remove(workspace);
        self.update_file(dir, |f| remove_workspace(&mut f.workspaces, workspace))?;
        Ok(())
    }

    /// The registered client's id; the client is registered the first time and its id is kept, since registering again leaves the earlier connections hanging.
    async fn client_id(&self, dir: &Path) -> Result<String, String> {
        if let Some(id) = load_file(dir)?.client_id {
            return Ok(id);
        }
        let id = register_client(&self.http, REGISTER_URL, REGISTERED_REDIRECT).await?;
        self.update_file(dir, |f| f.client_id = Some(id.clone()))?;
        Ok(id)
    }

    fn turn(&self, workspace: &str) -> std::sync::Arc<AsyncMutex<()>> {
        self.turns
            .lock()
            .unwrap()
            .entry(workspace.to_owned())
            .or_default()
            .clone()
    }

    fn is_registered(&self, dir: &Path, workspace: &str) -> Result<bool, String> {
        Ok(load_file(dir)?.workspaces.iter().any(|w| w.id == workspace))
    }

    fn update_file(&self, dir: &Path, change: impl FnOnce(&mut NotionFile)) -> Result<(), String> {
        let _held = self.file.lock().unwrap();
        let mut file = load_file(dir)?;
        change(&mut file);
        accounts::write_atomic(dir, FILE, &render_file(&file)?)
    }
}

/// The workspaces connected, with whether each needs a new connection.
#[tauri::command]
pub async fn notion_accounts(
    app: AppHandle,
    state: State<'_, NotionState>,
) -> Result<Vec<NotionAccount>, String> {
    state.accounts(&config_dir(&app)?).map_err(|e| {
        eprintln!("cookapps: notion_accounts workspace=- status=- error={e}");
        e
    })
}

/// Connects one workspace: the browser opens for Notion's consent. Connecting a workspace again replaces its token.
#[tauri::command]
pub async fn notion_connect(
    app: AppHandle,
    state: State<'_, NotionState>,
) -> Result<NotionAccount, String> {
    state.connect(&app).await.map_err(|e| {
        eprintln!("cookapps: notion_connect workspace=- status=- error={e}");
        e
    })
}

/// Revokes the workspace's grant and drops its token and its entry.
#[tauri::command]
pub async fn notion_disconnect(
    app: AppHandle,
    state: State<'_, NotionState>,
    workspace_id: String,
) -> Result<(), String> {
    let removed = match config_dir(&app) {
        Ok(dir) => state.disconnect(&dir, &workspace_id).await,
        Err(e) => Err(e),
    };
    removed.map_err(|e| {
        eprintln!("cookapps: notion_disconnect workspace={workspace_id} status=- error={e}");
        e
    })
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn account_of(w: Workspace, reconnect: bool) -> NotionAccount {
    NotionAccount {
        workspace_id: w.id,
        workspace_name: w.name,
        user_name: w.user_name,
        user_email: w.user_email,
        reconnect,
    }
}

fn authorize_url(
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url = Url::parse(AUTH_URL).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(url.into())
}

fn registration_body(redirect_uri: &str) -> Value {
    json!({
        "client_name": "cookapps",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    })
}

fn expires_at(now: i64, expires_in: Option<i64>) -> i64 {
    now.saturating_add(
        expires_in
            .filter(|s| *s > 0)
            .unwrap_or(DEFAULT_LIFETIME_SECS),
    )
}

fn needs_refresh(expires_at: i64, now: i64) -> bool {
    expires_at.saturating_sub(REFRESH_MARGIN_SECS) <= now
}

/// Whether the pair's access token can be used for a call: it is not the one that was refused and it is not near its end.
fn usable(stored: &Stored, rejected: &str, now: i64) -> bool {
    stored.access_token != rejected && !needs_refresh(stored.expires_at, now)
}

/// The pair a token reply makes. A refresh token is replaced at every refresh; a reply without one keeps the previous.
fn next_stored(reply: TokenReply, previous: Option<&Stored>, now: i64) -> Result<Stored, String> {
    let Some(access_token) = reply.access_token else {
        return Err(format!(
            "トークンを取得できませんでした: {} {}",
            reply.error.unwrap_or_default(),
            reply.error_description.unwrap_or_default()
        ));
    };
    let refresh_token = reply
        .refresh_token
        .or_else(|| previous.map(|p| p.refresh_token.clone()))
        .ok_or("リフレッシュトークンが返されませんでした")?;
    Ok(Stored {
        access_token,
        refresh_token,
        expires_at: expires_at(now, reply.expires_in),
    })
}

fn tool_allowed(tool: &str) -> bool {
    ALLOWED_TOOLS.contains(&tool)
}

/// The JSON-RPC message with `id` in a reply that is plain JSON or a server-sent event stream.
/// Its `result` is answered; an `error` is the message.
fn rpc_result(body: &str, id: i64) -> Result<Value, String> {
    let messages: Vec<Value> = match serde_json::from_str::<Value>(body) {
        Ok(Value::Array(a)) => a,
        Ok(v) => vec![v],
        Err(_) => body
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .filter_map(|d| serde_json::from_str(d.trim()).ok())
            .collect(),
    };
    let message = messages
        .into_iter()
        .find(|m| m["id"] == id)
        .ok_or("Notion MCP の応答に結果がありません")?;
    if let Some(error) = message.get("error") {
        let text = error["message"].as_str().unwrap_or("不明なエラー");
        return Err(format!(
            "Notion MCP がエラーを返しました: {}",
            text.chars().take(200).collect::<String>()
        ));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| "Notion MCP の応答に結果がありません".into())
}

/// The text of a tool's result (its text parts joined). A result marked as an error is an error.
fn tool_text(result: &Value) -> Result<String, String> {
    let text = result["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if result["isError"].as_bool() == Some(true) {
        return Err(format!(
            "Notion MCP のツールが失敗しました: {}",
            text.chars().take(200).collect::<String>()
        ));
    }
    Ok(text)
}

/// The user's name and email address in the text `notion-get-self` returns (JSON, the user at the top or under `user`).
/// What it lacks is `None`: the text is Notion's, and its shape can change.
fn user_of(text: &str) -> (Option<String>, Option<String>) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return (None, None);
    };
    let user = v.get("user").filter(|u| u.is_object()).unwrap_or(&v);
    let field = |value: &Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let email = field(&user["email"]).or_else(|| field(&user["person"]["email"]));
    (field(&user["name"]), email)
}

fn upsert_workspace(list: &mut Vec<Workspace>, workspace: Workspace) {
    match list.iter_mut().find(|w| w.id == workspace.id) {
        Some(w) => *w = workspace,
        None => list.push(workspace),
    }
}

fn remove_workspace(list: &mut Vec<Workspace>, id: &str) {
    list.retain(|w| w.id != id);
}

fn parse_file(text: &str) -> Result<NotionFile, serde_json::Error> {
    serde_json::from_str(text)
}

fn render_file(file: &NotionFile) -> Result<String, String> {
    serde_json::to_string_pretty(file).map_err(|e| e.to_string())
}

/// A missing file is an empty one.
fn load_file(dir: &Path) -> Result<NotionFile, String> {
    let path = dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            parse_file(&text).map_err(|e| format!("{} の形式が不正です: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(NotionFile::default()),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

fn entry(workspace: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, workspace).map_err(|e| e.to_string())
}

/// `None` for no entry, and for one that is not a pair (a new connection replaces it).
fn read_stored(workspace: &str) -> Result<Option<Stored>, String> {
    match entry(workspace)?.get_password() {
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("資格情報の読み取りに失敗: {e}")),
    }
}

fn write_stored(workspace: &str, stored: &Stored) -> Result<(), String> {
    let text = serde_json::to_string(stored).map_err(|e| e.to_string())?;
    entry(workspace)?
        .set_password(&text)
        .map_err(|e| format!("資格情報の保存に失敗: {e}"))
}

/// Posts a form to the token endpoint. An error answer is in the reply (`error`), not an `Err`; an answer that is no JSON is an `Err`.
async fn token_post(
    http: &reqwest::Client,
    url: &str,
    form: &[(&str, &str)],
) -> Result<TokenReply, String> {
    let res = http
        .post(url)
        .form(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|_| format!("Notion が {status} を返しました"))
}

/// A new pair for `stored`, or `None` when Notion answers invalid_grant (the connection ended: 180 days, 30 unused, or an old token used again).
async fn refresh_pair(
    http: &reqwest::Client,
    url: &str,
    client_id: &str,
    stored: &Stored,
    now: i64,
) -> Result<Option<Stored>, String> {
    let reply = token_post(
        http,
        url,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", &stored.refresh_token),
        ],
    )
    .await?;
    if reply.error.as_deref() == Some("invalid_grant") {
        return Ok(None);
    }
    next_stored(reply, Some(stored), now).map(Some)
}

async fn register_client(
    http: &reqwest::Client,
    url: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let res = http
        .post(url)
        .json(&registration_body(redirect_uri))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!(
            "Notion がクライアントの登録を拒みました ({status})"
        ));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    body["client_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Notion がクライアントの ID を返しませんでした".into())
}

/// Asks Notion to revoke a refresh token (the endpoint is the token endpoint, RFC 7009).
async fn revoke(
    http: &reqwest::Client,
    url: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<(), String> {
    let res = http
        .post(url)
        .form(&[
            ("token", refresh_token),
            ("token_type_hint", "refresh_token"),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("Notion が {status} を返しました"))
    }
}

/// One tool call over MCP's streamable HTTP: initialize, the initialized notice, then the call.
/// The tool's `result`; `None` means the token was refused with 401.
async fn mcp_call(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    tool: &str,
    args: &Value,
) -> Result<Option<Value>, String> {
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "cookapps", "version": env!("CARGO_PKG_VERSION")},
        },
    });
    let Some(opened) = mcp_post(http, url, token, None, None, &init).await? else {
        return Ok(None);
    };
    let version = rpc_result(&opened.body, 1)?["protocolVersion"]
        .as_str()
        .unwrap_or(MCP_PROTOCOL)
        .to_owned();
    let session = opened.session;
    let ready = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    if mcp_post(http, url, token, session.as_deref(), Some(&version), &ready)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    let call = json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": tool, "arguments": args},
    });
    let Some(called) =
        mcp_post(http, url, token, session.as_deref(), Some(&version), &call).await?
    else {
        return Ok(None);
    };
    rpc_result(&called.body, 2).map(Some)
}

/// What the server answered to one JSON-RPC message: the session id it gave (if any) and the body.
struct McpReply {
    session: Option<String>,
    body: String,
}

/// Posts one JSON-RPC message. `None` is a 401.
async fn mcp_post(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    session: Option<&str>,
    version: Option<&str>,
    message: &Value,
) -> Result<Option<McpReply>, String> {
    let mut req = http
        .post(url)
        .bearer_auth(token)
        .header("Accept", "application/json, text/event-stream")
        .json(message);
    if let Some(s) = session {
        req = req.header("Mcp-Session-Id", s);
    }
    if let Some(v) = version {
        req = req.header("MCP-Protocol-Version", v);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("Notion MCP が {status} を返しました"));
    }
    let session = res
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(Some(McpReply { session, body }))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::{TcpListener as StdListener, TcpStream},
    };

    use super::*;

    fn stored(access: &str, refresh: &str, expires_at: i64) -> Stored {
        Stored {
            access_token: access.into(),
            refresh_token: refresh.into(),
            expires_at,
        }
    }

    fn reply(json: Value) -> TokenReply {
        serde_json::from_value(json).unwrap()
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cookapps-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn run<T>(fut: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fut)
    }

    #[test]
    fn the_authorize_url_asks_for_a_code_with_pkce_s256_and_no_secret() {
        let url =
            Url::parse(&authorize_url("cid", "http://127.0.0.1:5000/", "chal", "st").unwrap())
                .unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://mcp.notion.com");
        assert_eq!(url.path(), "/authorize");
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000/");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st");
        assert!(!q.contains_key("client_secret"));
    }

    #[test]
    fn the_registration_is_a_public_client_with_the_loopback_redirect() {
        let body = registration_body(REGISTERED_REDIRECT);
        assert_eq!(body["redirect_uris"], json!(["http://127.0.0.1/"]));
        assert_eq!(body["token_endpoint_auth_method"], "none");
        assert_eq!(
            body["grant_types"],
            json!(["authorization_code", "refresh_token"])
        );
    }

    #[test]
    fn the_expiry_is_now_plus_expires_in_and_a_missing_one_is_an_hour() {
        assert_eq!(expires_at(1000, Some(28800)), 29800);
        assert_eq!(expires_at(1000, None), 1000 + DEFAULT_LIFETIME_SECS);
        assert_eq!(expires_at(1000, Some(0)), 1000 + DEFAULT_LIFETIME_SECS);
        assert_eq!(expires_at(i64::MAX, Some(5)), i64::MAX);
    }

    #[test]
    fn a_token_is_refreshed_before_it_ends_by_the_margin() {
        let end = 10_000;
        assert!(!needs_refresh(end, end - REFRESH_MARGIN_SECS - 1));
        assert!(needs_refresh(end, end - REFRESH_MARGIN_SECS));
        assert!(needs_refresh(end, end + 1));
    }

    #[test]
    fn a_token_is_usable_unless_it_was_refused_or_is_near_its_end() {
        let s = stored("a", "r", 10_000);
        assert!(usable(&s, "", 0));
        assert!(usable(&s, "other", 0));
        assert!(!usable(&s, "a", 0));
        assert!(!usable(&s, "", 10_000 - REFRESH_MARGIN_SECS));
    }

    #[test]
    fn a_refresh_replaces_the_refresh_token_and_a_reply_without_one_keeps_the_old() {
        let old = stored("a0", "r0", 0);
        let rotated = next_stored(
            reply(json!({"access_token": "a1", "refresh_token": "r1", "expires_in": 100})),
            Some(&old),
            50,
        )
        .unwrap();
        assert_eq!(rotated, stored("a1", "r1", 150));
        let kept = next_stored(reply(json!({"access_token": "a2"})), Some(&old), 50).unwrap();
        assert_eq!(kept.refresh_token, "r0");
    }

    #[test]
    fn a_first_reply_needs_both_tokens_and_an_error_reply_says_why() {
        let err = next_stored(reply(json!({"access_token": "a"})), None, 0).unwrap_err();
        assert!(err.contains("リフレッシュトークン"), "{err}");
        let err = next_stored(
            reply(json!({"error": "invalid_request", "error_description": "bad code"})),
            None,
            0,
        )
        .unwrap_err();
        assert!(
            err.contains("invalid_request") && err.contains("bad code"),
            "{err}"
        );
    }

    #[test]
    fn the_debug_text_of_a_pair_holds_no_token() {
        let text = format!("{:?}", stored("secret-access", "secret-refresh", 7));
        assert!(!text.contains("secret"), "{text}");
    }

    #[test]
    fn only_the_listed_tools_are_allowed() {
        assert!(tool_allowed("notion-get-self"));
        assert!(!tool_allowed("notion-delete-pages"));
        assert!(!tool_allowed(""));
    }

    #[test]
    fn a_result_is_found_by_id_in_json_and_in_an_event_stream() {
        let plain = r#"{"jsonrpc":"2.0","id":2,"result":{"content":[]}}"#;
        assert_eq!(rpc_result(plain, 2).unwrap(), json!({"content": []}));
        let stream = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/x\"}\n\n\
                      event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"a\":1}}\n\n";
        assert_eq!(rpc_result(stream, 2).unwrap(), json!({"a": 1}));
        assert!(rpc_result(stream, 3).is_err());
        assert!(rpc_result("", 1).is_err());
    }

    #[test]
    fn an_error_message_is_an_error_cut_at_200_characters() {
        let long = "x".repeat(500);
        let body = json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -1, "message": long}});
        let err = rpc_result(&body.to_string(), 1).unwrap_err();
        assert!(err.contains("Notion MCP がエラーを返しました"));
        assert!(err.chars().count() < 260, "{}", err.chars().count());
    }

    #[test]
    fn the_text_of_a_result_joins_its_parts_and_an_error_result_fails() {
        let ok = json!({"content": [{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}]});
        assert_eq!(tool_text(&ok).unwrap(), "a\nb");
        assert_eq!(tool_text(&json!({})).unwrap(), "");
        let bad = json!({"isError": true, "content": [{"type": "text", "text": "no way"}]});
        assert!(tool_text(&bad).unwrap_err().contains("no way"));
    }

    #[test]
    fn the_user_is_read_from_the_top_or_from_under_user_and_what_is_missing_is_none() {
        let top = r#"{"name":" Ann ","person":{"email":"ann@example.com"}}"#;
        assert_eq!(
            user_of(top),
            (Some("Ann".into()), Some("ann@example.com".into()))
        );
        let nested = r#"{"user":{"name":"Bob","email":"bob@example.com"}}"#;
        assert_eq!(
            user_of(nested),
            (Some("Bob".into()), Some("bob@example.com".into()))
        );
        assert_eq!(user_of(r#"{"name":""}"#), (None, None));
        assert_eq!(user_of("not json"), (None, None));
    }

    #[test]
    fn the_file_round_trips_and_a_workspace_is_replaced_by_its_id() {
        let mut file = NotionFile {
            client_id: Some("cid".into()),
            workspaces: vec![],
        };
        let w = |name: &str, user: Option<&str>| Workspace {
            id: "w1".into(),
            name: name.into(),
            user_name: user.map(Into::into),
            user_email: None,
        };
        upsert_workspace(&mut file.workspaces, w("A", None));
        upsert_workspace(&mut file.workspaces, w("A", Some("Ann")));
        assert_eq!(file.workspaces, vec![w("A", Some("Ann"))]);
        assert_eq!(parse_file(&render_file(&file).unwrap()).unwrap(), file);
        remove_workspace(&mut file.workspaces, "other");
        assert_eq!(file.workspaces.len(), 1);
        remove_workspace(&mut file.workspaces, "w1");
        assert!(file.workspaces.is_empty());
    }

    #[test]
    fn the_file_holds_no_token_and_a_file_without_a_client_or_workspaces_parses() {
        let text = render_file(&NotionFile {
            client_id: Some("cid".into()),
            workspaces: vec![],
        })
        .unwrap();
        assert!(!text.contains("token"), "{text}");
        assert_eq!(parse_file("{}").unwrap(), NotionFile::default());
        assert!(parse_file("\"x\"").is_err());
    }

    #[test]
    fn a_missing_file_is_empty_and_a_broken_one_is_named() {
        let dir = temp_dir("notion-load");
        assert_eq!(load_file(&dir), Ok(NotionFile::default()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load_file(&dir).unwrap_err().contains("形式が不正"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Serves one canned response to each connection in turn, then hands back the requests it received.
    fn serve(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = StdListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = vec![];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_request(&mut stream));
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (url, handle)
    }

    /// The request with its head and its body, read as far as `Content-Length` says. Lowercased, for the header names.
    fn read_request(stream: &mut TcpStream) -> String {
        let mut data = vec![];
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap();
            data.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&data).to_lowercase();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    return text;
                }
            }
            if n == 0 {
                return text;
            }
        }
    }

    fn http(status: &str, content_type: &str, extra: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn json_http(status: &str, body: &str) -> String {
        http(status, "application/json", "", body)
    }

    #[test]
    fn a_refresh_posts_the_old_token_with_no_secret_and_keeps_the_rotated_pair() {
        let (url, server) = serve(vec![json_http(
            "200 OK",
            r#"{"access_token":"a1","refresh_token":"r1","expires_in":28800}"#,
        )]);
        let old = stored("a0", "r0", 0);
        let new = run(refresh_pair(
            &reqwest::Client::new(),
            &url,
            "cid",
            &old,
            100,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(new, stored("a1", "r1", 28900));
        let request = &server.join().unwrap()[0];
        assert!(request.starts_with("post /x "));
        assert!(request.contains("application/x-www-form-urlencoded"));
        assert!(request.ends_with("grant_type=refresh_token&client_id=cid&refresh_token=r0"));
        assert!(!request.contains("client_secret"));
    }

    #[test]
    fn invalid_grant_means_a_new_connection_is_needed() {
        let (url, server) = serve(vec![json_http(
            "400 Bad Request",
            r#"{"error":"invalid_grant","error_description":"expired"}"#,
        )]);
        let old = stored("a0", "r0", 0);
        assert_eq!(
            run(refresh_pair(&reqwest::Client::new(), &url, "cid", &old, 0)),
            Ok(None)
        );
        server.join().unwrap();
    }

    #[test]
    fn another_refusal_and_an_answer_that_is_no_json_are_errors_that_keep_the_connection() {
        let (url, server) = serve(vec![
            json_http("400 Bad Request", r#"{"error":"invalid_client"}"#),
            http(
                "502 Bad Gateway",
                "text/html",
                "",
                "<html>secret-looking body</html>",
            ),
        ]);
        let old = stored("a0", "r0", 0);
        let http_client = reqwest::Client::new();
        let err = run(refresh_pair(&http_client, &url, "cid", &old, 0)).unwrap_err();
        assert!(err.contains("invalid_client"), "{err}");
        let err = run(refresh_pair(&http_client, &url, "cid", &old, 0)).unwrap_err();
        assert!(
            err.contains("502") && !err.contains("secret-looking"),
            "{err}"
        );
        server.join().unwrap();
    }

    #[test]
    fn the_authorization_code_is_exchanged_with_the_verifier_and_the_workspace_comes_back() {
        let (url, server) = serve(vec![json_http(
            "200 OK",
            r#"{"access_token":"a","refresh_token":"r","expires_in":28800,"workspace_id":"w1","workspace_name":"Team"}"#,
        )]);
        let got = run(token_post(
            &reqwest::Client::new(),
            &url,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", "cid"),
                ("code", "4/a b"),
                ("code_verifier", "ver"),
                ("redirect_uri", "http://127.0.0.1:5000/"),
            ],
        ))
        .unwrap();
        assert_eq!(got.workspace_id.as_deref(), Some("w1"));
        assert_eq!(got.workspace_name.as_deref(), Some("Team"));
        let request = &server.join().unwrap()[0];
        assert!(request.contains("code=4%2fa+b") && request.contains("code_verifier=ver"));
        assert!(request.contains("redirect_uri=http%3a%2f%2f127.0.0.1%3a5000%2f"));
    }

    #[test]
    fn registering_posts_the_public_client_and_answers_its_id() {
        let (url, server) = serve(vec![
            json_http(
                "201 Created",
                r#"{"client_id":"new-id","redirect_uris":["http://127.0.0.1/"]}"#,
            ),
            json_http("400 Bad Request", r#"{"error":"invalid_redirect_uri"}"#),
            json_http("201 Created", r#"{"client_name":"cookapps"}"#),
        ]);
        let http_client = reqwest::Client::new();
        assert_eq!(
            run(register_client(&http_client, &url, REGISTERED_REDIRECT)),
            Ok("new-id".to_string())
        );
        let err = run(register_client(&http_client, &url, REGISTERED_REDIRECT)).unwrap_err();
        assert!(err.contains("400"), "{err}");
        assert!(run(register_client(&http_client, &url, REGISTERED_REDIRECT)).is_err());
        let requests = server.join().unwrap();
        assert!(requests[0].contains("\"token_endpoint_auth_method\":\"none\""));
        assert!(requests[0].contains("\"redirect_uris\":[\"http://127.0.0.1/\"]"));
    }

    #[test]
    fn a_revoke_posts_the_refresh_token_and_reports_a_refusal_by_status() {
        let (url, server) = serve(vec![
            json_http("200 OK", ""),
            json_http("500 Internal Server Error", ""),
        ]);
        let http_client = reqwest::Client::new();
        assert_eq!(run(revoke(&http_client, &url, "cid", "r 0")), Ok(()));
        let err = run(revoke(&http_client, &url, "cid", "r0")).unwrap_err();
        assert!(err.contains("500"), "{err}");
        let requests = server.join().unwrap();
        assert!(requests[0].ends_with("token=r+0&token_type_hint=refresh_token&client_id=cid"));
    }

    #[test]
    fn a_tool_call_initializes_the_session_and_sends_its_id_and_version_on() {
        let result = json!({"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"name\":\"Ann\"}"}]}});
        let (url, server) = serve(vec![
            http(
                "200 OK",
                "text/event-stream",
                "Mcp-Session-Id: sess-1\r\n",
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-03-26\"}}\n\n",
            ),
            http("202 Accepted", "text/plain", "", ""),
            http(
                "200 OK",
                "text/event-stream",
                "",
                &format!("event: message\ndata: {result}\n\n"),
            ),
        ]);
        let got = run(mcp_call(
            &reqwest::Client::new(),
            &url,
            "tok",
            "notion-get-self",
            &json!({}),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(tool_text(&got).unwrap(), "{\"name\":\"Ann\"}");
        let requests = server.join().unwrap();
        assert!(requests[0].contains("authorization: bearer tok"));
        assert!(requests[0].contains("accept: application/json, text/event-stream"));
        assert!(requests[0].contains("\"method\":\"initialize\""));
        assert!(!requests[0].contains("mcp-session-id"));
        for later in &requests[1..] {
            assert!(later.contains("mcp-session-id: sess-1"), "{later}");
            assert!(
                later.contains("mcp-protocol-version: 2025-03-26"),
                "{later}"
            );
        }
        assert!(requests[1].contains("notifications/initialized"));
        assert!(requests[2].contains("\"name\":\"notion-get-self\""));
    }

    #[test]
    fn a_401_at_any_step_of_a_tool_call_is_none_and_another_failure_is_an_error() {
        let call = |url: &str| {
            run(mcp_call(
                &reqwest::Client::new(),
                url,
                "t",
                "notion-get-self",
                &json!({}),
            ))
        };
        let (url, server) = serve(vec![http("401 Unauthorized", "text/plain", "", "")]);
        assert_eq!(call(&url), Ok(None));
        server.join().unwrap();
        let (url, server) = serve(vec![
            json_http("200 OK", r#"{"jsonrpc":"2.0","id":1,"result":{}}"#),
            http("202 Accepted", "text/plain", "", ""),
            http("401 Unauthorized", "text/plain", "", ""),
        ]);
        assert_eq!(call(&url), Ok(None));
        server.join().unwrap();
        let (url, server) = serve(vec![http("503 Service Unavailable", "text/plain", "", "")]);
        let err = call(&url).unwrap_err();
        assert!(err.contains("503"), "{err}");
        server.join().unwrap();
    }

    /// The directory has a registered workspace and no keychain is touched: a name that is not registered never reaches it,
    /// and a token that is in memory and fresh is used as it is.
    #[test]
    fn a_token_is_none_for_an_unregistered_workspace_and_the_fresh_one_in_memory_is_used() {
        let dir = temp_dir("notion-token");
        let state = NotionState::default();
        assert_eq!(run(state.token(&dir, "w1", "")), Ok(None));
        state
            .update_file(&dir, |f| {
                f.client_id = Some("cid".into());
                f.workspaces.push(Workspace {
                    id: "w1".into(),
                    name: "Team".into(),
                    user_name: None,
                    user_email: None,
                });
            })
            .unwrap();
        state
            .tokens
            .lock()
            .unwrap()
            .insert("w1".into(), stored("fresh", "r", now() + 3600));
        assert_eq!(run(state.token(&dir, "w1", "")), Ok(Some("fresh".into())));
        // The token another call refreshed is used for a call that was refused with the old one.
        assert_eq!(
            run(state.token(&dir, "w1", "old")),
            Ok(Some("fresh".into()))
        );
        assert_eq!(run(state.token(&dir, "other", "")), Ok(None));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_tool_outside_the_list_is_refused_before_anything_is_read() {
        let dir = temp_dir("notion-tool");
        let state = NotionState::default();
        let err = run(state.call_tool(&dir, "w1", "notion-delete-pages", json!({}))).unwrap_err();
        assert!(err.contains("許可していない"), "{err}");
        assert!(!dir.exists());
    }

    #[test]
    fn disconnecting_a_workspace_that_is_not_registered_is_refused() {
        let dir = temp_dir("notion-disconnect");
        let err = run(NotionState::default().disconnect(&dir, "w1")).unwrap_err();
        assert!(err.contains("登録されていない"), "{err}");
    }

    #[test]
    fn the_keychain_service_is_the_app_identifier_and_notion() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            KEYRING_SERVICE,
            format!("{}.notion", conf["identifier"].as_str().unwrap())
        );
    }
}
