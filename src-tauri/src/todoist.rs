use std::collections::{HashMap, HashSet};

use chrono::{
    DateTime, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, TimeZone, Utc,
};
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::{
    auth::{delete_entry, keyring_entry, Auth},
    gmail::{log_failure, ApiError},
};

const API_URL: &str = "https://api.todoist.com/api/v1";
const WEB_TASK_URL: &str = "https://app.todoist.com/app/task";
const GMAIL_URL: &str = "https://mail.google.com/mail/u/";
/// The keychain user name (and the `account=` of the logs) of the personal API token.
const TOKEN_USER: &str = "todoist";
const PAGE_LIMIT: &str = "200";
// shortcut: past these many pages (200 items each) the rest is dropped, upgrade if the lists ever grow that long.
const MAX_TASK_PAGES: usize = 20;
const MAX_PROJECT_PAGES: usize = 5;
const MAX_DONE_PAGES: usize = 5;
/// The completed-tasks endpoint takes a range of up to 3 months; completed subtasks older than that are not counted.
const DONE_DAYS: i64 = 90;
/// Todoist's `charcoal`, which a client shows for a color name it does not know.
const DEFAULT_COLOR: &str = "#808080";

// Todoist's project color names and hexadecimal values (the "Colors" table of the API v1 reference).
const COLORS: [(&str, &str); 20] = [
    ("berry_red", "#B8255F"),
    ("red", "#DC4C3E"),
    ("orange", "#C77100"),
    ("yellow", "#B29104"),
    ("olive_green", "#949C31"),
    ("lime_green", "#65A33A"),
    ("green", "#369307"),
    ("mint_green", "#42A393"),
    ("teal", "#148FAD"),
    ("sky_blue", "#319DC0"),
    ("light_blue", "#6988A4"),
    ("blue", "#4180FF"),
    ("grape", "#692EC2"),
    ("violet", "#CA3FEE"),
    ("lavender", "#A4698C"),
    ("magenta", "#E05095"),
    ("salmon", "#C9766F"),
    ("charcoal", "#808080"),
    ("grey", "#999999"),
    ("taupe", "#8F7A69"),
];

#[derive(Deserialize)]
struct ApiDue {
    date: String,
    #[serde(default)]
    string: String,
}

/// An active or completed task; the completed-tasks endpoint returns the same shape.
#[derive(Deserialize)]
struct ApiTask {
    id: String,
    #[serde(default)]
    project_id: String,
    parent_id: Option<String>,
    #[serde(default)]
    content: String,
    #[serde(default)]
    description: String,
    #[serde(default = "natural_priority")]
    priority: u8,
    due: Option<ApiDue>,
    #[serde(default)]
    child_order: i64,
}

fn natural_priority() -> u8 {
    1
}

#[derive(Deserialize)]
struct ApiProject {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    inbox_project: bool,
    #[serde(default)]
    child_order: i64,
}

/// One page of a cursor-paginated list; the completed-tasks endpoint calls its list `items`.
#[derive(Deserialize)]
struct Page<T> {
    #[serde(alias = "items")]
    results: Vec<T>,
    next_cursor: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Due {
    /// Local date, `YYYY-MM-DD`.
    date: String,
    /// Local time, `HH:MM`; `None` for a due date without a time.
    time: Option<String>,
    /// Todoist's human-readable form ("every day", "明日"); what the due chip edits.
    string: String,
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Bucket {
    Overdue,
    Today,
    Upcoming,
    /// No due date.
    #[serde(rename = "none")]
    NoDue,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    id: String,
    content: String,
    done: bool,
    due: Option<Due>,
}

/// The Gmail thread a task's description links to.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailRef {
    account: String,
    thread_id: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    id: String,
    content: String,
    description: String,
    project_id: String,
    /// As the Todoist apps number it: 1 is the most urgent, 4 the natural one.
    priority: u8,
    due: Option<Due>,
    bucket: Bucket,
    /// Active subtasks first, then the completed ones.
    subtasks: Vec<Subtask>,
    sub_done: usize,
    sub_total: usize,
    mail: Option<MailRef>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItem {
    id: String,
    name: String,
    /// `#RRGGBB`.
    color: String,
    inbox: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Todo {
    projects: Vec<ProjectItem>,
    /// Top-level active tasks, by due date.
    tasks: Vec<TaskItem>,
}

/// Todoist's IDs are alphanumeric; anything else (it comes from the frontend or a description) is refused.
fn valid_id(id: &str, what: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("{what}が不正です"));
    }
    Ok(())
}

/// `#RRGGBB` of a Todoist color name.
fn color_hex(name: &str) -> &'static str {
    COLORS
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(DEFAULT_COLOR, |(_, hex)| hex)
}

/// Todoist's API numbers priorities the other way round from its apps (API 4 is the apps' "priority 1"), so one function serves both directions.
fn flip_priority(p: u8) -> u8 {
    5 - p.clamp(1, 4)
}

/// The local date, and the local time if the due date has one, of a due `date`: `YYYY-MM-DD`, a floating `YYYY-MM-DDTHH:MM:SS`, or an RFC 3339 instant.
fn parse_due<Tz: TimeZone>(tz: &Tz, date: &str) -> Option<(NaiveDate, Option<NaiveTime>)> {
    if let Ok(d) = date.parse::<NaiveDate>() {
        return Some((d, None));
    }
    if let Ok(t) = NaiveDateTime::parse_from_str(date, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some((t.date(), Some(t.time())));
    }
    let t = DateTime::parse_from_rfc3339(date)
        .ok()?
        .with_timezone(tz)
        .naive_local();
    Some((t.date(), Some(t.time())))
}

fn bucket_of(due: Option<NaiveDate>, today: NaiveDate) -> Bucket {
    match due {
        None => Bucket::NoDue,
        Some(d) if d < today => Bucket::Overdue,
        Some(d) if d == today => Bucket::Today,
        Some(_) => Bucket::Upcoming,
    }
}

/// The URL cookup writes into a task's description to point at a thread.
fn gmail_url(account: &str, thread_id: &str) -> Result<String, String> {
    valid_id(thread_id, "スレッド ID")?;
    Ok(format!("{GMAIL_URL}{account}/#all/{thread_id}"))
}

/// The thread a description links to with a URL `gmail_url` made; links of any other form are not cookup's.
fn mail_of(description: &str) -> Option<MailRef> {
    let start = description.find(GMAIL_URL)?;
    let link = description[start..].split_whitespace().next()?;
    let url = Url::parse(link).ok()?;
    // `/mail/u/{account}/`
    let account = url.path_segments()?.nth(2)?;
    let (_, thread_id) = url.fragment()?.split_once('/')?;
    if !account.contains('@') || valid_id(thread_id, "").is_err() {
        return None;
    }
    Some(MailRef {
        account: account.to_owned(),
        thread_id: thread_id.to_owned(),
    })
}

/// `…/tasks/{id}` (plus `/{action}`). The ID comes from the frontend; Todoist's are alphanumeric, so anything else is refused.
fn task_api_url(id: &str, action: Option<&str>) -> Result<String, String> {
    valid_id(id, "タスク ID")?;
    Ok(match action {
        Some(action) => format!("/tasks/{id}/{action}"),
        None => format!("/tasks/{id}"),
    })
}

fn task_web_url(id: &str) -> Result<String, String> {
    valid_id(id, "タスク ID")?;
    Ok(format!("{WEB_TASK_URL}/{id}"))
}

/// The body of a task update holding only the fields given. `priority` is the apps' number; an empty `due_string` clears the due date.
fn update_body(
    content: Option<&str>,
    description: Option<&str>,
    due_string: Option<&str>,
    priority: Option<u8>,
) -> Result<Value, String> {
    let mut body = serde_json::Map::new();
    if let Some(c) = content {
        if c.trim().is_empty() {
            return Err("タスクの名前を入力してください".into());
        }
        body.insert("content".into(), c.trim().into());
    }
    if let Some(d) = description {
        body.insert("description".into(), d.into());
    }
    if let Some(d) = due_string {
        // shortcut: "no date" is Todoist's wording for no due date (not in the v1 reference), upgrade if the API rejects it.
        let d = if d.trim().is_empty() {
            "no date"
        } else {
            d.trim()
        };
        body.insert("due_string".into(), d.into());
    }
    if let Some(p) = priority {
        if !(1..=4).contains(&p) {
            return Err("優先度は 1 から 4 で指定してください".into());
        }
        body.insert("priority".into(), flip_priority(p).into());
    }
    if body.is_empty() {
        return Err("変更する項目がありません".into());
    }
    Ok(Value::Object(body))
}

/// The ID of a task Quick Add created outside `wanted`, the project the user was in; it is moved there.
fn task_to_move(created: &Value, wanted: Option<&str>) -> Option<String> {
    let id = created.get("id")?.as_str()?;
    let wanted = wanted?;
    (created.get("project_id")?.as_str()? != wanted).then(|| id.to_owned())
}

fn due_of<Tz: TimeZone>(tz: &Tz, due: &Option<ApiDue>) -> Option<Due> {
    let due = due.as_ref()?;
    let (date, time) = parse_due(tz, &due.date)?;
    Some(Due {
        date: date.to_string(),
        time: time.map(|t| t.format("%H:%M").to_string()),
        string: due.string.clone(),
    })
}

/// Top-level active tasks with their subtasks and counts. `completed` are the recently completed tasks: those under an active
/// top-level task count as its done subtasks. Dates are judged in `tz`.
fn build_todo<Tz: TimeZone>(
    projects: Vec<ApiProject>,
    tasks: Vec<ApiTask>,
    completed: Vec<ApiTask>,
    today: NaiveDate,
    tz: &Tz,
) -> Todo {
    let mut projects = projects;
    projects.sort_by_key(|p| p.child_order);
    let active: HashSet<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    // Subtasks by parent: the active ones, then the completed ones (a recurring one is in both; the active one stands).
    let mut subs: HashMap<&str, Vec<(&ApiTask, bool)>> = HashMap::new();
    for (list, done) in [(&tasks, false), (&completed, true)] {
        let mut list: Vec<_> = list.iter().collect();
        list.sort_by_key(|t| t.child_order);
        for t in list {
            if let Some(parent) = t.parent_id.as_deref() {
                if !(done && active.contains(t.id.as_str())) {
                    subs.entry(parent).or_default().push((t, done));
                }
            }
        }
    }
    let mut items: Vec<_> = tasks
        .iter()
        .filter(|t| t.parent_id.is_none())
        .map(|t| {
            let due = due_of(tz, &t.due);
            let day = due.as_ref().and_then(|d| d.date.parse().ok());
            let subtasks: Vec<_> = subs
                .remove(t.id.as_str())
                .unwrap_or_default()
                .into_iter()
                .map(|(s, done)| Subtask {
                    id: s.id.clone(),
                    content: s.content.clone(),
                    done,
                    due: due_of(tz, &s.due),
                })
                .collect();
            TaskItem {
                id: t.id.clone(),
                content: t.content.clone(),
                description: t.description.clone(),
                project_id: t.project_id.clone(),
                priority: flip_priority(t.priority),
                bucket: bucket_of(day, today),
                sub_done: subtasks.iter().filter(|s| s.done).count(),
                sub_total: subtasks.len(),
                subtasks,
                mail: mail_of(&t.description),
                due,
            }
        })
        .collect();
    // Stable, so tasks of the same moment keep Todoist's order; no due date goes last.
    items.sort_by(|a, b| {
        let key = |t: &TaskItem| t.due.as_ref().map(|d| (d.date.clone(), d.time.clone()));
        match (key(a), key(b)) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
    });
    Todo {
        projects: projects
            .into_iter()
            .map(|p| ProjectItem {
                color: color_hex(&p.color).to_owned(),
                id: p.id,
                name: p.name,
                inbox: p.inbox_project,
            })
            .collect(),
        tasks: items,
    }
}

fn read_token() -> Result<Option<String>, String> {
    match keyring_entry(TOKEN_USER)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("キーチェーンの読み取りに失敗: {e}")),
    }
}

/// `Ok(None)` means the token was rejected with 401.
async fn send(
    http: &reqwest::Client,
    method: Method,
    token: &str,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> Result<Option<Value>, ApiError> {
    let req = http
        .request(method, format!("{API_URL}{path}"))
        .bearer_auth(token)
        .query(query);
    let req = match body {
        Some(body) => req.json(body),
        None => req.header(reqwest::header::CONTENT_LENGTH, "0"),
    };
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(None);
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(ApiError::with_status(
            status.as_u16(),
            format!("Todoist が {status} を返しました: {text}"),
        ));
    }
    // close / reopen / delete answer with null or nothing.
    if text.trim().is_empty() {
        return Ok(Some(Value::Null));
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("Todoist の応答を読めません: {e}").into())
}

/// Every item of a paginated list, following `next_cursor` for up to `max_pages` pages. `Ok(None)` means the token was rejected.
async fn fetch_all<T: DeserializeOwned>(
    http: reqwest::Client,
    token: String,
    path: &'static str,
    query: Vec<(&'static str, String)>,
    max_pages: usize,
) -> Result<Option<Vec<T>>, ApiError> {
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..max_pages {
        let mut q = query.clone();
        q.push(("limit", PAGE_LIMIT.to_owned()));
        q.extend(cursor.map(|c| ("cursor", c)));
        let Some(page) = send(&http, Method::GET, &token, path, &q, None).await? else {
            return Ok(None);
        };
        let page: Page<T> =
            serde_json::from_value(page).map_err(|e| format!("Todoist の応答を読めません: {e}"))?;
        items.extend(page.results);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(Some(items))
}

/// Sends one request with the stored token, logging a failure. `Ok(None)` means a token is needed: none is stored, or Todoist rejected it.
async fn request(
    auth: &Auth,
    command: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>, String> {
    let Some(token) = read_token().map_err(|e| log_failure(command, TOKEN_USER, e))? else {
        return Ok(None);
    };
    send(auth.http(), method, &token, path, &[], body.as_ref())
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))
}

/// The active tasks, the projects, and the recently completed tasks, fetched at once. `None` means a token is needed.
#[tauri::command]
pub async fn todoist_load(auth: State<'_, Auth>) -> Result<Option<Todo>, String> {
    let command = "todoist_load";
    let Some(token) = read_token().map_err(|e| log_failure(command, TOKEN_USER, e))? else {
        return Ok(None);
    };
    let http = auth.http();
    let since = (Utc::now() - Duration::days(DONE_DAYS)).to_rfc3339_opts(SecondsFormat::Secs, true);
    let until = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let tasks = tokio::spawn(fetch_all::<ApiTask>(
        http.clone(),
        token.clone(),
        "/tasks",
        vec![],
        MAX_TASK_PAGES,
    ));
    let projects = tokio::spawn(fetch_all::<ApiProject>(
        http.clone(),
        token.clone(),
        "/projects",
        vec![],
        MAX_PROJECT_PAGES,
    ));
    let done = tokio::spawn(fetch_all::<ApiTask>(
        http.clone(),
        token,
        "/tasks/completed/by_completion_date",
        vec![("since", since), ("until", until)],
        MAX_DONE_PAGES,
    ));
    let joined = |e: tokio::task::JoinError| log_failure(command, TOKEN_USER, e.to_string());
    let tasks = tasks.await.map_err(joined)?;
    let projects = projects.await.map_err(joined)?;
    let done = done.await.map_err(joined)?;
    let (Some(tasks), Some(projects)) = (
        tasks.map_err(|e| log_failure(command, TOKEN_USER, e))?,
        projects.map_err(|e| log_failure(command, TOKEN_USER, e))?,
    ) else {
        return Ok(None);
    };
    // The done subtasks only complete the counts, so their failure (e.g. a plan without history) must not hide the tasks.
    let done = match done {
        Ok(d) => d.unwrap_or_default(),
        Err(e) => {
            log_failure(command, TOKEN_USER, e);
            Vec::new()
        }
    };
    Ok(Some(build_todo(
        projects,
        tasks,
        done,
        Local::now().date_naive(),
        &Local,
    )))
}

/// Stores the personal API token in the keychain. It is never logged or returned.
#[tauri::command]
pub fn todoist_save_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("トークンを入力してください".into());
    }
    keyring_entry(TOKEN_USER)
        .and_then(|e| {
            e.set_password(token)
                .map_err(|e| format!("キーチェーンへの保存に失敗: {e}"))
        })
        .map_err(|e| log_failure("todoist_save_token", TOKEN_USER, e))
}

/// Removes the stored token.
#[tauri::command]
pub fn todoist_disconnect() -> Result<(), String> {
    keyring_entry(TOKEN_USER)
        .and_then(|e| delete_entry(&e))
        .map_err(|e| log_failure("todoist_disconnect", TOKEN_USER, e))
}

/// Adds a task from natural language (Quick Add). Inside a project (`project_id`) the task is moved there.
#[tauri::command]
pub async fn todoist_add(
    auth: State<'_, Auth>,
    text: String,
    project_id: Option<String>,
) -> Result<Option<bool>, String> {
    let command = "todoist_add";
    let text = text.trim();
    if text.is_empty() {
        return Err("タスクの内容を入力してください".into());
    }
    let body = json!({ "text": text });
    let Some(created) = request(&auth, command, Method::POST, "/tasks/quick", Some(body)).await?
    else {
        return Ok(None);
    };
    if let Some(id) = task_to_move(&created, project_id.as_deref()) {
        return move_task(&auth, command, &id, project_id.as_deref()).await;
    }
    Ok(Some(true))
}

async fn move_task(
    auth: &Auth,
    command: &str,
    id: &str,
    project_id: Option<&str>,
) -> Result<Option<bool>, String> {
    let url = task_api_url(id, Some("move")).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body = json!({ "project_id": project_id });
    let done = request(auth, command, Method::POST, &url, Some(body)).await?;
    // `true`, not `()`: `Some(())` reaches JS as null, the same as `None` (a token is needed).
    Ok(done.map(|_| true))
}

/// Adds a task under `parent_id`.
#[tauri::command]
pub async fn todoist_add_subtask(
    auth: State<'_, Auth>,
    parent_id: String,
    content: String,
) -> Result<Option<bool>, String> {
    let command = "todoist_add_subtask";
    task_api_url(&parent_id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let content = content.trim();
    if content.is_empty() {
        return Err("サブタスクの名前を入力してください".into());
    }
    let body = json!({ "content": content, "parent_id": parent_id });
    let done = request(&auth, command, Method::POST, "/tasks", Some(body)).await?;
    Ok(done.map(|_| true))
}

/// Adds a task to the inbox that points at a Gmail thread: the subject is its name, the thread's URL its description.
#[tauri::command]
pub async fn todoist_task_from_mail(
    auth: State<'_, Auth>,
    account: String,
    thread_id: String,
    subject: String,
) -> Result<Option<bool>, String> {
    let command = "todoist_task_from_mail";
    let url = gmail_url(&account, &thread_id).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let subject = subject.trim();
    let content = if subject.is_empty() {
        "(件名なし)"
    } else {
        subject
    };
    let body = json!({ "content": content, "description": url });
    let done = request(&auth, command, Method::POST, "/tasks", Some(body)).await?;
    Ok(done.map(|_| true))
}

/// Completes (`close`) or reopens a task.
#[tauri::command]
pub async fn todoist_set_done(
    auth: State<'_, Auth>,
    id: String,
    done: bool,
) -> Result<Option<bool>, String> {
    let command = "todoist_set_done";
    let action = if done { "close" } else { "reopen" };
    let url = task_api_url(&id, Some(action)).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let sent = request(&auth, command, Method::POST, &url, None).await?;
    Ok(sent.map(|_| true))
}

/// Changes the fields given. `priority` is the apps' number (1 most urgent); an empty `due_string` clears the due date.
#[tauri::command]
pub async fn todoist_update(
    auth: State<'_, Auth>,
    id: String,
    content: Option<String>,
    description: Option<String>,
    due_string: Option<String>,
    priority: Option<u8>,
) -> Result<Option<bool>, String> {
    let command = "todoist_update";
    let url = task_api_url(&id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body = update_body(
        content.as_deref(),
        description.as_deref(),
        due_string.as_deref(),
        priority,
    )
    .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(&auth, command, Method::POST, &url, Some(body)).await?;
    Ok(done.map(|_| true))
}

#[tauri::command]
pub async fn todoist_move(
    auth: State<'_, Auth>,
    id: String,
    project_id: String,
) -> Result<Option<bool>, String> {
    move_task(&auth, "todoist_move", &id, Some(&project_id)).await
}

/// Deletes a task for good; Todoist cannot undo it, so the screen asks twice.
#[tauri::command]
pub async fn todoist_delete(auth: State<'_, Auth>, id: String) -> Result<Option<bool>, String> {
    let command = "todoist_delete";
    let url = task_api_url(&id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(&auth, command, Method::DELETE, &url, None).await?;
    Ok(done.map(|_| true))
}

/// Opens the task in the browser (Todoist's web app).
#[tauri::command]
pub fn todoist_open(app: AppHandle, id: String) -> Result<(), String> {
    let url = task_web_url(&id).map_err(|e| log_failure("todoist_open", TOKEN_USER, e))?;
    app.opener().open_url(url, None::<&str>).map_err(|e| {
        log_failure(
            "todoist_open",
            TOKEN_USER,
            format!("ブラウザを開けません: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn jst() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    fn date(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn task(v: Value) -> ApiTask {
        serde_json::from_value(v).unwrap()
    }

    fn project(id: &str, name: &str, color: &str, inbox: bool, order: i64) -> ApiProject {
        ApiProject {
            id: id.into(),
            name: name.into(),
            color: color.into(),
            inbox_project: inbox,
            child_order: order,
        }
    }

    fn todo(tasks: Vec<ApiTask>, completed: Vec<ApiTask>) -> Todo {
        build_todo(vec![], tasks, completed, date("2026-10-29"), &jst())
    }

    #[test]
    fn color_names_map_to_hex() {
        assert_eq!(color_hex("berry_red"), "#B8255F");
        assert_eq!(color_hex("taupe"), "#8F7A69");
        assert_eq!(color_hex("charcoal"), "#808080");
    }

    #[test]
    fn unknown_color_is_charcoal() {
        assert_eq!(color_hex("teal2"), DEFAULT_COLOR);
        assert_eq!(color_hex(""), DEFAULT_COLOR);
        // Names are exact, as the API's are.
        assert_eq!(color_hex("Berry_Red"), DEFAULT_COLOR);
    }

    #[test]
    fn priority_flips_between_api_and_apps() {
        assert_eq!(flip_priority(4), 1);
        assert_eq!(flip_priority(1), 4);
        assert_eq!(flip_priority(2), 3);
        assert_eq!(flip_priority(flip_priority(3)), 3);
    }

    #[test]
    fn priority_out_of_range_is_clamped() {
        assert_eq!(flip_priority(0), 4);
        assert_eq!(flip_priority(9), 1);
    }

    #[test]
    fn parses_a_full_day_due_date() {
        assert_eq!(
            parse_due(&jst(), "2026-10-29"),
            Some((date("2026-10-29"), None))
        );
    }

    #[test]
    fn floating_due_time_is_kept_as_written() {
        let (d, t) = parse_due(&jst(), "2026-10-29T15:00:00").unwrap();
        assert_eq!(
            (d, t),
            (date("2026-10-29"), NaiveTime::from_hms_opt(15, 0, 0))
        );
    }

    #[test]
    fn due_instant_is_shifted_to_local_time() {
        // 20:00 UTC is already the next day in JST.
        let (d, t) = parse_due(&jst(), "2026-10-29T20:30:00Z").unwrap();
        assert_eq!(
            (d, t),
            (date("2026-10-30"), NaiveTime::from_hms_opt(5, 30, 0))
        );
    }

    #[test]
    fn unreadable_due_date_is_none() {
        assert_eq!(parse_due(&jst(), ""), None);
        assert_eq!(parse_due(&jst(), "tomorrow"), None);
    }

    #[test]
    fn buckets_split_at_local_today() {
        let today = date("2026-10-29");
        assert_eq!(bucket_of(Some(date("2026-10-28")), today), Bucket::Overdue);
        assert_eq!(bucket_of(Some(today), today), Bucket::Today);
        assert_eq!(bucket_of(Some(date("2026-10-30")), today), Bucket::Upcoming);
        assert_eq!(bucket_of(None, today), Bucket::NoDue);
    }

    #[test]
    fn gmail_url_names_the_account_and_thread() {
        assert_eq!(
            gmail_url("a@example.com", "18c3f0a1b2").unwrap(),
            "https://mail.google.com/mail/u/a@example.com/#all/18c3f0a1b2"
        );
    }

    #[test]
    fn gmail_url_refuses_a_bad_thread_id() {
        assert!(gmail_url("a@example.com", "").is_err());
        assert!(gmail_url("a@example.com", "x/y").is_err());
    }

    #[test]
    fn mail_is_read_back_from_the_description() {
        let url = gmail_url("a@example.com", "18c3f0a1b2").unwrap();
        for description in [
            url.clone(),
            format!("メモ\n{url}\n続き"),
            format!("see {url} ok"),
        ] {
            assert_eq!(
                mail_of(&description),
                Some(MailRef {
                    account: "a@example.com".into(),
                    thread_id: "18c3f0a1b2".into()
                })
            );
        }
    }

    #[test]
    fn links_that_cookup_did_not_make_are_not_mail() {
        for description in [
            "",
            "https://example.com/",
            // Gmail's own links name the account by index, not by address.
            "https://mail.google.com/mail/u/0/#inbox/18c3f0a1b2",
            "https://mail.google.com/mail/u/a@example.com/#all/",
            "https://mail.google.com/mail/u/a@example.com/",
        ] {
            assert_eq!(mail_of(description), None, "{description}");
        }
    }

    #[test]
    fn task_urls_refuse_ids_that_are_not_alphanumeric() {
        assert_eq!(
            task_api_url("6XGgmFVcrG5RRjVr", Some("close")).unwrap(),
            "/tasks/6XGgmFVcrG5RRjVr/close"
        );
        assert_eq!(task_api_url("6XGg", None).unwrap(), "/tasks/6XGg");
        for id in ["", "a/b", "a?b", "../x"] {
            assert!(task_api_url(id, None).is_err(), "{id}");
            assert!(task_web_url(id).is_err(), "{id}");
        }
        assert_eq!(
            task_web_url("6XGg").unwrap(),
            "https://app.todoist.com/app/task/6XGg"
        );
    }

    #[test]
    fn update_body_holds_only_the_given_fields() {
        assert_eq!(
            update_body(Some("a"), None, None, None).unwrap(),
            json!({"content": "a"})
        );
        assert_eq!(
            update_body(None, Some("memo"), Some("明日"), Some(1)).unwrap(),
            json!({"description": "memo", "due_string": "明日", "priority": 4})
        );
    }

    #[test]
    fn update_body_clears_the_due_date_with_an_empty_string() {
        assert_eq!(
            update_body(None, None, Some("  "), None).unwrap(),
            json!({"due_string": "no date"})
        );
    }

    #[test]
    fn update_body_keeps_an_empty_description() {
        assert_eq!(
            update_body(None, Some(""), None, None).unwrap(),
            json!({"description": ""})
        );
    }

    #[test]
    fn update_body_refuses_an_empty_name_and_a_bad_priority() {
        assert!(update_body(Some(" "), None, None, None).is_err());
        assert!(update_body(None, None, None, Some(0)).is_err());
        assert!(update_body(None, None, None, Some(5)).is_err());
        assert!(update_body(None, None, None, None).is_err());
    }

    #[test]
    fn quick_add_task_in_another_project_is_moved() {
        let created = json!({"id": "T1", "project_id": "inbox"});
        assert_eq!(task_to_move(&created, Some("p1")), Some("T1".into()));
        assert_eq!(task_to_move(&created, Some("inbox")), None);
        assert_eq!(task_to_move(&created, None), None);
    }

    #[test]
    fn quick_add_answer_without_an_id_moves_nothing() {
        assert_eq!(task_to_move(&json!({}), Some("p1")), None);
    }

    #[test]
    fn only_top_level_tasks_are_listed_with_their_subtasks() {
        let t = todo(
            vec![
                task(json!({"id": "A", "content": "親", "project_id": "p"})),
                task(json!({"id": "B", "parent_id": "A", "content": "子", "child_order": 2})),
                task(json!({"id": "C", "parent_id": "B", "content": "孫"})),
            ],
            vec![],
        );
        assert_eq!(t.tasks.len(), 1);
        let a = &t.tasks[0];
        assert_eq!((a.sub_done, a.sub_total), (0, 1));
        assert_eq!(a.subtasks.len(), 1);
        assert_eq!(a.subtasks[0].id, "B");
        assert!(!a.subtasks[0].done);
    }

    #[test]
    fn completed_subtasks_count_as_done_and_come_last() {
        let t = todo(
            vec![
                task(json!({"id": "A"})),
                task(json!({"id": "B", "parent_id": "A", "child_order": 5})),
            ],
            vec![
                task(json!({"id": "D", "parent_id": "A", "content": "済", "child_order": 1})),
                // A grandchild's or a stranger's completion is not A's.
                task(json!({"id": "E", "parent_id": "B"})),
                task(json!({"id": "F", "parent_id": "Z"})),
                task(json!({"id": "G"})),
            ],
        );
        let a = &t.tasks[0];
        assert_eq!((a.sub_done, a.sub_total), (1, 2));
        let ids: Vec<_> = a.subtasks.iter().map(|s| (s.id.as_str(), s.done)).collect();
        assert_eq!(ids, [("B", false), ("D", true)]);
    }

    #[test]
    fn a_recurring_subtask_is_not_counted_twice() {
        let t = todo(
            vec![
                task(json!({"id": "A"})),
                task(json!({"id": "B", "parent_id": "A"})),
            ],
            vec![task(json!({"id": "B", "parent_id": "A"}))],
        );
        assert_eq!((t.tasks[0].sub_done, t.tasks[0].sub_total), (0, 1));
    }

    #[test]
    fn a_task_without_subtasks_counts_zero() {
        let t = todo(vec![task(json!({"id": "A"}))], vec![]);
        assert_eq!((t.tasks[0].sub_done, t.tasks[0].sub_total), (0, 0));
        assert!(t.tasks[0].subtasks.is_empty());
    }

    #[test]
    fn tasks_are_bucketed_and_ordered_by_due_date() {
        let t = todo(
            vec![
                task(json!({"id": "none", "child_order": 1})),
                task(json!({"id": "later", "due": {"date": "2026-11-02", "string": "11/2"}})),
                task(json!({"id": "late", "due": {"date": "2026-10-27"}})),
                task(json!({"id": "pm", "due": {"date": "2026-10-29T15:00:00"}})),
                task(json!({"id": "am", "due": {"date": "2026-10-29T09:00:00"}})),
                task(json!({"id": "day", "due": {"date": "2026-10-29"}})),
            ],
            vec![],
        );
        let got: Vec<_> = t.tasks.iter().map(|t| (t.id.as_str(), t.bucket)).collect();
        assert_eq!(
            got,
            [
                ("late", Bucket::Overdue),
                ("day", Bucket::Today),
                ("am", Bucket::Today),
                ("pm", Bucket::Today),
                ("later", Bucket::Upcoming),
                ("none", Bucket::NoDue),
            ]
        );
    }

    #[test]
    fn due_is_reported_in_local_time() {
        let t = todo(
            vec![task(
                json!({"id": "A", "due": {"date": "2026-10-29T20:30:00Z", "string": "every day"}}),
            )],
            vec![],
        );
        assert_eq!(
            t.tasks[0].due,
            Some(Due {
                date: "2026-10-30".into(),
                time: Some("05:30".into()),
                string: "every day".into()
            })
        );
        // Judged against the local date: 05:30 on the 30th is not today (the 29th).
        assert_eq!(t.tasks[0].bucket, Bucket::Upcoming);
    }

    #[test]
    fn task_fields_carry_priority_and_mail() {
        let url = gmail_url("a@example.com", "abc123").unwrap();
        let t = todo(
            vec![task(
                json!({"id": "A", "content": "件名", "priority": 4, "description": url, "project_id": "p"}),
            )],
            vec![],
        );
        let a = &t.tasks[0];
        assert_eq!(a.priority, 1);
        assert_eq!(a.project_id, "p");
        assert_eq!(a.mail.as_ref().unwrap().thread_id, "abc123");
    }

    #[test]
    fn a_task_without_a_priority_is_natural() {
        let t = todo(vec![task(json!({"id": "A"}))], vec![]);
        assert_eq!(t.tasks[0].priority, 4);
    }

    #[test]
    fn projects_are_ordered_and_colored() {
        let t = build_todo(
            vec![
                project("b", "B", "unheard", false, 2),
                project("i", "受信箱", "charcoal", true, 0),
                project("a", "A", "berry_red", false, 1),
            ],
            vec![],
            vec![],
            date("2026-10-29"),
            &jst(),
        );
        let got: Vec<_> = t
            .projects
            .iter()
            .map(|p| (p.id.as_str(), p.color.as_str(), p.inbox))
            .collect();
        assert_eq!(
            got,
            [
                ("i", "#808080", true),
                ("a", "#B8255F", false),
                ("b", "#808080", false)
            ]
        );
    }

    #[test]
    fn pages_read_both_results_and_items() {
        let a: Page<ApiTask> =
            serde_json::from_value(json!({"results": [{"id": "A"}], "next_cursor": "c"})).unwrap();
        assert_eq!((a.results.len(), a.next_cursor.as_deref()), (1, Some("c")));
        let b: Page<ApiTask> = serde_json::from_value(
            json!({"items": [{"id": "A"}, {"id": "B"}], "next_cursor": null}),
        )
        .unwrap();
        assert_eq!((b.results.len(), b.next_cursor), (2, None));
    }
}
