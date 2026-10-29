//! stdio MCP server over the same Gmail / Calendar code as the app. Login is done in the app, not here.

use std::{env, path::PathBuf};

use cookup_lib::{auth::Auth, calendar, gmail};
use rmcp::{handler::server::wrapper::Parameters, tool, tool_router, transport::stdio, ServiceExt};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Tauri's `app_config_dir` for the app's identifier.
/// shortcut: macOS only, upgrade if the app ever runs elsewhere.
fn config_dir() -> Result<PathBuf, String> {
    let home = env::var_os("HOME").ok_or("HOME が設定されていません")?;
    Ok(PathBuf::from(home).join("Library/Application Support/jp.mysis.cookup"))
}

fn relogin(account: &str) -> String {
    format!("{account} は再ログインが必要です。cookup アプリで再ログインしてください")
}

fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

#[derive(Deserialize, JsonSchema)]
struct ThreadArgs {
    /// Email address of the account the thread belongs to (the `account` of `list_inbox`).
    account: String,
    /// Thread ID.
    id: String,
}

#[derive(Deserialize, JsonSchema)]
struct SetReadArgs {
    /// Email address of the account the thread belongs to (the `account` of `list_inbox`).
    account: String,
    /// Thread ID.
    id: String,
    /// true marks the thread read, false unread.
    read: bool,
}

#[derive(Deserialize, JsonSchema)]
struct EventsArgs {
    /// First local date, YYYY-MM-DD.
    from: String,
    /// Last local date, YYYY-MM-DD, included.
    to: String,
}

struct Cookup {
    auth: Auth,
    dir: PathBuf,
}

#[tool_router(server_handler)]
impl Cookup {
    #[tool(
        description = "List the inbox threads of every account, newest first. Accounts that must log in again are in needsLogin, accounts that failed to load are in failed.",
        annotations(read_only_hint = true)
    )]
    async fn list_inbox(&self) -> Result<String, String> {
        let inbox = gmail::load_inbox(&self.dir, &self.auth, "list_inbox").await?;
        let mut value = serde_json::to_value(inbox).map_err(|e| e.to_string())?;
        // The sync starting point is for the app's own list, not for this caller.
        if let Some(object) = value.as_object_mut() {
            object.remove("historyIds");
        }
        json(&value)
    }

    #[tool(
        description = "Get a thread with all its messages. A message body is its plain-text part when it has one, else its HTML.",
        annotations(read_only_hint = true)
    )]
    async fn get_thread(&self, Parameters(a): Parameters<ThreadArgs>) -> Result<String, String> {
        let thread = gmail::fetch_thread(&self.dir, &self.auth, &a.account, &a.id, true)
            .await
            .map_err(|e| gmail::log_failure("get_thread", &a.account, e))?
            .ok_or_else(|| relogin(&a.account))?;
        json(&thread)
    }

    #[tool(
        description = "Archive a thread: remove it from the inbox.",
        annotations(idempotent_hint = true, destructive_hint = false)
    )]
    async fn archive(&self, Parameters(a): Parameters<ThreadArgs>) -> Result<String, String> {
        gmail::archive_thread(&self.dir, &self.auth, &a.account, &a.id)
            .await
            .map_err(|e| gmail::log_failure("archive", &a.account, e))?
            .ok_or_else(|| relogin(&a.account))?;
        Ok("アーカイブしました".into())
    }

    #[tool(
        description = "Mark a thread read or unread.",
        annotations(idempotent_hint = true, destructive_hint = false)
    )]
    async fn set_read(&self, Parameters(a): Parameters<SetReadArgs>) -> Result<String, String> {
        gmail::set_thread_read(&self.dir, &self.auth, &a.account, &a.id, a.read)
            .await
            .map_err(|e| gmail::log_failure("set_read", &a.account, e))?
            .ok_or_else(|| relogin(&a.account))?;
        Ok(if a.read {
            "既読にしました"
        } else {
            "未読にしました"
        }
        .into())
    }

    #[tool(
        description = "Move a thread to the trash. It can be restored in Gmail.",
        annotations(destructive_hint = true)
    )]
    async fn trash(&self, Parameters(a): Parameters<ThreadArgs>) -> Result<String, String> {
        gmail::trash_thread(&self.dir, &self.auth, &a.account, &a.id)
            .await
            .map_err(|e| gmail::log_failure("trash", &a.account, e))?
            .ok_or_else(|| relogin(&a.account))?;
        Ok("ゴミ箱へ移動しました".into())
    }

    #[tool(
        description = "List the calendar events of every account from one local date to another, earliest first. All-day events carry dates, timed events carry times. Accounts that must log in again are in needsLogin, accounts that failed to load are in failed, calendars that failed to load are in calendarFailed.",
        annotations(read_only_hint = true)
    )]
    async fn list_events(&self, Parameters(a): Parameters<EventsArgs>) -> Result<String, String> {
        json(&calendar::list_events(&self.dir, &self.auth, &a.from, &a.to).await?)
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = Cookup {
        auth: Auth::new(),
        dir: config_dir()?,
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            server.serve(stdio()).await?.waiting().await?;
            Ok::<_, Box<dyn std::error::Error>>(())
        })
}
