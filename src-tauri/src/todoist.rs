use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use chrono::{
    DateTime, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, TimeZone, Utc,
};
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
#[cfg(test)]
use ts_rs::TS;
use url::Url;

use crate::{
    accounts::write_synced,
    auth::{config_dir, delete_entry, keyring_entry, Auth},
    claude::{self, Summary},
    gmail::{log_failure, ApiError},
    slack,
};

const API_URL: &str = "https://api.todoist.com/api/v1";
const WEB_TASK_URL: &str = "https://app.todoist.com/app/task";
const GMAIL_URL: &str = "https://mail.google.com/mail/u/";
/// The keychain user name (and the `account=` of the logs) of the personal API token.
const TOKEN_USER: &str = "todoist";
/// The token has a service of its own: under the Gmail accounts' one, a name from outside could reach it as an account.
const TOKEN_SERVICE: &str = "jp.mysis.cookapps.todoist";
/// Todoist refuses a task name longer than this.
const CONTENT_LIMIT: usize = 500;
const PAGE_LIMIT: &str = "200";
// shortcut: past these many pages (200 items each) the rest is dropped, upgrade if the list ever grows that long.
const MAX_DONE_PAGES: usize = 5;
/// The Sync API's `resource_types`: the active tasks and the projects.
const SYNC_RESOURCES: &str = r#"["items","projects"]"#;
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

#[derive(Deserialize, Clone)]
struct ApiDue {
    date: String,
    #[serde(default)]
    string: String,
    #[serde(default)]
    is_recurring: bool,
}

/// An active or completed task; the completed-tasks endpoint returns the same shape.
#[derive(Deserialize, Clone)]
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
    /// Completed. The Sync API sends a task that was completed or deleted since the last sync.
    #[serde(default)]
    checked: bool,
    #[serde(default)]
    is_deleted: bool,
}

fn natural_priority() -> u8 {
    1
}

#[derive(Deserialize, Clone)]
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
    parent_id: Option<String>,
    #[serde(default)]
    is_archived: bool,
    #[serde(default)]
    is_deleted: bool,
}

/// The Sync API's answer: with `full_sync` everything active, otherwise only what changed since the `sync_token` that was sent.
#[derive(Deserialize)]
struct SyncResponse {
    sync_token: String,
    #[serde(default)]
    full_sync: bool,
    #[serde(default)]
    items: Vec<ApiTask>,
    #[serde(default)]
    projects: Vec<ApiProject>,
}

impl SyncResponse {
    /// Whether the answer reports no change: applying it leaves the tasks and projects as they were.
    fn is_unchanged(&self) -> bool {
        !self.full_sync && self.items.is_empty() && self.projects.is_empty()
    }
}

/// The active tasks and the projects as the last sync left them.
#[derive(Default)]
struct SyncData {
    /// The token the data was fetched with: another one means another account, whose data this is not.
    owner: Option<String>,
    /// `None` asks for a full sync.
    sync_token: Option<String>,
    tasks: Vec<ApiTask>,
    projects: Vec<ApiProject>,
}

/// Puts `changed` into `list` by id: a known one is replaced in place (so the order stays), an unknown one is added, and one that is `gone` is removed.
fn upsert<T>(
    list: &mut Vec<T>,
    changed: Vec<T>,
    id: impl Fn(&T) -> &str,
    gone: impl Fn(&T) -> bool,
) {
    for c in changed {
        let at = list.iter().position(|t| id(t) == id(&c));
        match (at, gone(&c)) {
            (Some(i), true) => {
                list.remove(i);
            }
            (Some(i), false) => list[i] = c,
            (None, false) => list.push(c),
            (None, true) => {}
        }
    }
}

/// Brings `data` up to date with a sync answer. Completed and deleted tasks and archived and deleted projects drop out.
/// `done` (the completed subtasks) follows the tasks that were completed, reopened or deleted since.
fn apply_sync(data: &mut SyncData, done: &mut Vec<ApiTask>, res: SyncResponse) {
    let task_gone = |t: &ApiTask| t.checked || t.is_deleted;
    let project_gone = |p: &ApiProject| p.is_archived || p.is_deleted;
    let changed: HashSet<&str> = res.items.iter().map(|t| t.id.as_str()).collect();
    done.retain(|d| !changed.contains(d.id.as_str()));
    // build_todo reads only the subtasks.
    done.extend(
        res.items
            .iter()
            .filter(|t| t.checked && !t.is_deleted && t.parent_id.is_some())
            .cloned(),
    );
    if res.full_sync {
        data.tasks = res.items.into_iter().filter(|t| !task_gone(t)).collect();
        data.projects = res
            .projects
            .into_iter()
            .filter(|p| !project_gone(p))
            .collect();
    } else {
        upsert(&mut data.tasks, res.items, |t| &t.id, task_gone);
        // The tasks of a project that is gone are not reported again.
        let gone: HashSet<&str> = res
            .projects
            .iter()
            .filter(|p| project_gone(p))
            .map(|p| p.id.as_str())
            .collect();
        data.tasks.retain(|t| !gone.contains(t.project_id.as_str()));
        upsert(&mut data.projects, res.projects, |p| &p.id, project_gone);
    }
    data.sync_token = Some(res.sync_token);
}

/// One page of a cursor-paginated list; the completed-tasks endpoint calls its list `items`.
#[derive(Deserialize)]
struct Page<T> {
    #[serde(alias = "items")]
    results: Vec<T>,
    next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Due {
    /// Local date, `YYYY-MM-DD`.
    date: String,
    /// Local time, `HH:MM`; `None` for a due date without a time.
    time: Option<String>,
    /// Todoist's human-readable form ("every day", "明日"); what the due chip edits.
    string: String,
    /// Repeats ("every week"); a day picked from a calendar would replace the repeat, so the due chip only edits its text.
    #[serde(default)]
    recurring: bool,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone, Copy)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum Bucket {
    Overdue,
    Today,
    Upcoming,
    /// No due date.
    #[serde(rename = "none")]
    NoDue,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    id: String,
    content: String,
    done: bool,
    due: Option<Due>,
}

/// The Gmail thread a task's description links to.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct MailRef {
    account: String,
    thread_id: String,
}

/// The task whose detail lists a subtask row: the subtask's own parent.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct ParentRef {
    id: String,
    content: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
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
    /// Set on the row of a subtask; `None` on a top-level task.
    parent: Option<ParentRef>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ProjectItem {
    id: String,
    name: String,
    /// `#RRGGBB`.
    color: String,
    inbox: bool,
    /// The project this one is nested in; `None` at the top.
    parent_id: Option<String>,
    /// How deep it is nested; 0 at the top.
    depth: u32,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Todo {
    projects: Vec<ProjectItem>,
    /// Every active task whose parent is active too (a subtask has `parent` set), by due date.
    tasks: Vec<TaskItem>,
    /// Set only when Todoist could not be reached and this is the last fetched content; never stored in the cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    offline: Option<Offline>,
}

/// Why and since when a `Todo` is the cached one.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Offline {
    /// RFC 3339, UTC: when the content was fetched.
    fetched_at: String,
    /// The failure shown to the user.
    reason: String,
}

/// What `todoist-cache.json` holds: the last successfully fetched `Todo` and when.
#[derive(Serialize, Deserialize, Clone)]
struct CacheFile {
    fetched_at: String,
    todo: Todo,
}

const CACHE_FILE: &str = "todoist-cache.json";
const CACHE_TMP_FILE: &str = "todoist-cache.json.tmp";

fn save_cache(dir: &Path, todo: &Todo, fetched_at: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(CACHE_FILE), dir.join(CACHE_TMP_FILE));
    let text = serde_json::to_string(&json!({"fetched_at": fetched_at, "todo": todo}))
        .map_err(|e| e.to_string())?;
    // Rename over the target so a crash mid-write leaves the old file, not a truncated one.
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// `None` when the file is missing or unreadable: the cache is only a fallback, so a broken one is as good as none.
fn load_cache(dir: &Path) -> Option<CacheFile> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(CACHE_FILE)).ok()?).ok()
}

fn remove_cache(dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(dir.join(CACHE_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("キャッシュを消せません: {e}"))
        }
        _ => Ok(()),
    }
}

/// Sets each task's bucket again against `today`: the cached ones were set on the day they were fetched.
/// shortcut: the order and which subtasks are rows stay as fetched, so a task that became due today since then is not added; the next successful fetch fixes it.
fn rebucket(todo: &mut Todo, today: NaiveDate) {
    for t in &mut todo.tasks {
        t.bucket = bucket_of(t.due.as_ref().and_then(|d| d.date.parse().ok()), today);
    }
}

/// The answer to a failed fetch: the cached `Todo` marked with `reason`, or the failure itself when nothing is cached.
fn offline_todo(
    cached: Option<CacheFile>,
    reason: String,
    today: NaiveDate,
) -> Result<Todo, String> {
    match cached {
        Some(CacheFile {
            fetched_at,
            mut todo,
        }) => {
            rebucket(&mut todo, today);
            Ok(Todo {
                offline: Some(Offline { fetched_at, reason }),
                ..todo
            })
        }
        None => Err(reason),
    }
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

/// The URL cookapps writes into a task's description to point at a thread. The account must be one of `accounts`, the registered ones.
fn gmail_url(accounts: &[String], account: &str, thread_id: &str) -> Result<String, String> {
    if !accounts.iter().any(|a| a == account) {
        return Err("登録されていないアカウントです".into());
    }
    valid_id(thread_id, "スレッド ID")?;
    Ok(format!("{GMAIL_URL}{account}/#all/{thread_id}"))
}

/// The thread a description links to with a URL `gmail_url` made; links of any other form are not cookapps's.
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

/// The body of a task update holding only the fields given; an empty `due_string` clears the due date.
fn update_body(
    content: Option<&str>,
    description: Option<&str>,
    due_string: Option<&str>,
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

/// The ID of a task Quick Add created with no due date (`due` missing or null).
fn task_without_due(created: &Value) -> Option<String> {
    let id = created.get("id")?.as_str()?;
    created
        .get("due")
        .is_none_or(Value::is_null)
        .then(|| id.to_owned())
}

/// Whether the model's `due` is `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`. Anything else (`every day`) would be read by Todoist as words, and could make the task recur.
fn is_plain_due(due: &str) -> bool {
    match due.len() {
        10 => NaiveDate::parse_from_str(due, "%Y-%m-%d").is_ok(),
        16 => NaiveDateTime::parse_from_str(due, "%Y-%m-%d %H:%M").is_ok(),
        _ => false,
    }
}

/// The body of `POST /tasks` for a task made from a Slack message. The name is cut at Todoist's limit, and the due date is the summary's when it is a plain date or date and time, else today when `today`.
fn slack_task_body(
    summary: &Summary,
    slack_url: &str,
    project_id: Option<&str>,
    today: bool,
) -> Value {
    let description = [summary.description.as_str(), slack_url]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut body = json!({
        "content": summary.content.chars().take(CONTENT_LIMIT).collect::<String>(),
        "description": description,
    });
    let due = summary.due.as_deref().filter(|d| is_plain_due(d));
    if let Some(due) = due.or(today.then_some("today")) {
        body["due_string"] = due.into();
    }
    if let Some(id) = project_id {
        body["project_id"] = id.into();
    }
    body
}

fn due_of<Tz: TimeZone>(tz: &Tz, due: &Option<ApiDue>) -> Option<Due> {
    let due = due.as_ref()?;
    let (date, time) = parse_due(tz, &due.date)?;
    Some(Due {
        date: date.to_string(),
        time: time.map(|t| t.format("%H:%M").to_string()),
        string: due.string.clone(),
        recurring: due.is_recurring,
    })
}

/// Projects in tree order with their depth: each one is followed by its descendants, siblings by `child_order`. A project whose parent
/// is not among `projects` (archived or deleted) is at the top, with its `parent_id` cleared.
fn order_projects(mut projects: Vec<ApiProject>) -> Vec<(ApiProject, u32)> {
    projects.sort_by_key(|p| p.child_order);
    let ids: HashSet<String> = projects.iter().map(|p| p.id.clone()).collect();
    let mut kids: HashMap<Option<String>, Vec<ApiProject>> = HashMap::new();
    for mut p in projects {
        p.parent_id = p.parent_id.filter(|id| ids.contains(id));
        kids.entry(p.parent_id.clone()).or_default().push(p);
    }
    let mut out = Vec::with_capacity(ids.len());
    let mut stack: Vec<(ApiProject, u32)> = kids
        .remove(&None)
        .unwrap_or_default()
        .into_iter()
        .rev()
        .map(|p| (p, 0))
        .collect();
    while let Some((p, depth)) = stack.pop() {
        let below = kids.remove(&Some(p.id.clone())).unwrap_or_default();
        stack.extend(below.into_iter().rev().map(|c| (c, depth + 1)));
        out.push((p, depth));
    }
    out
}

/// Top-level active tasks, then every active subtask whose parent is active, with their subtasks and counts. A subtask is a row of its
/// own (with `parent` set), so a list can nest it and its detail can open. `completed` are the recently completed tasks: those under an
/// active task count as its done subtasks. Dates are judged in `tz`.
fn build_todo<Tz: TimeZone>(
    projects: Vec<ApiProject>,
    tasks: Vec<ApiTask>,
    completed: &[ApiTask],
    today: NaiveDate,
    tz: &Tz,
) -> Todo {
    let projects = order_projects(projects);
    let by_id: HashMap<&str, &ApiTask> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    // Subtasks by parent: the active ones, then the completed ones (a recurring one is in both; the active one stands).
    let mut subs: HashMap<&str, Vec<(&ApiTask, bool)>> = HashMap::new();
    for (list, done) in [(&tasks[..], false), (completed, true)] {
        let mut list: Vec<_> = list.iter().collect();
        list.sort_by_key(|t| t.child_order);
        for t in list {
            if let Some(parent) = t.parent_id.as_deref() {
                if !(done && by_id.contains_key(t.id.as_str())) {
                    subs.entry(parent).or_default().push((t, done));
                }
            }
        }
    }
    // The due of each active subtask, read once for its parent's list and for its own row.
    let dues: HashMap<&str, Option<Due>> = tasks
        .iter()
        .filter(|t| t.parent_id.is_some())
        .map(|t| (t.id.as_str(), due_of(tz, &t.due)))
        .collect();
    let item = |t: &ApiTask, due: Option<Due>, parent: Option<ParentRef>| {
        let subtasks: Vec<_> = subs
            .get(t.id.as_str())
            .into_iter()
            .flatten()
            .map(|&(s, done)| Subtask {
                id: s.id.clone(),
                content: s.content.clone(),
                done,
                due: dues
                    .get(s.id.as_str())
                    .map_or_else(|| due_of(tz, &s.due), Clone::clone),
            })
            .collect();
        TaskItem {
            id: t.id.clone(),
            content: t.content.clone(),
            description: t.description.clone(),
            project_id: t.project_id.clone(),
            priority: flip_priority(t.priority),
            bucket: bucket_of(due.as_ref().and_then(|d| d.date.parse().ok()), today),
            sub_done: subtasks.iter().filter(|s| s.done).count(),
            sub_total: subtasks.len(),
            subtasks,
            mail: mail_of(&t.description),
            due,
            parent,
        }
    };
    let mut items: Vec<_> = tasks
        .iter()
        .filter(|t| t.parent_id.is_none())
        .map(|t| item(t, due_of(tz, &t.due), None))
        .collect();
    items.extend(tasks.iter().filter_map(|t| {
        // A subtask whose parent is not among the active tasks is not a row: nothing opens it.
        let parent = by_id.get(t.parent_id.as_deref()?)?;
        let due = dues.get(t.id.as_str())?;
        let parent = ParentRef {
            id: parent.id.clone(),
            content: parent.content.clone(),
        };
        Some(item(t, due.clone(), Some(parent)))
    }));
    // Stable, so tasks of the same moment keep Todoist's order; no due date goes last.
    fn key(t: &TaskItem) -> Option<(&String, &Option<String>)> {
        t.due.as_ref().map(|d| (&d.date, &d.time))
    }
    items.sort_by(|a, b| match (key(a), key(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    Todo {
        projects: projects
            .into_iter()
            .map(|(p, depth)| ProjectItem {
                color: color_hex(&p.color).to_owned(),
                id: p.id,
                name: p.name,
                inbox: p.inbox_project,
                parent_id: p.parent_id,
                depth,
            })
            .collect(),
        tasks: items,
        offline: None,
    }
}

/// What the commands keep in memory: the token, so the keychain is read once, and the last completed tasks, which a load after an operation reuses.
#[derive(Default)]
pub struct TodoistState {
    /// `None` means not loaded: the keychain is read. The lock is held across a read, a save and a disconnect, so they never interleave.
    token: tokio::sync::Mutex<Option<String>>,
    done: Mutex<Arc<Vec<ApiTask>>>,
    /// What the Sync API has told so far. A load holds the lock from its request to its end, so two loads never share a `sync_token`.
    /// Taken before `token`, and never while `token` is held.
    sync: tokio::sync::Mutex<SyncData>,
    /// The last saved or read cache, so an offline spell reads the file once. Touched only while `token` is locked, in order with a save and a disconnect.
    cache: Mutex<Option<CacheFile>>,
}

impl TodoistState {
    /// The token: the copy in memory, else the keychain's (read off the async threads). `None` means none is stored.
    async fn token(&self) -> Result<Option<String>, String> {
        let mut cached = self.token.lock().await;
        if cached.is_none() {
            *cached = tokio::task::spawn_blocking(read_token)
                .await
                .map_err(|e| e.to_string())??;
        }
        Ok(cached.clone())
    }

    /// The cache: the copy in memory, else the file's (read off the async threads). The caller holds the `token` lock.
    async fn cache(&self, dir: Result<PathBuf, String>) -> Result<Option<CacheFile>, String> {
        if let Some(cached) = self.cache.lock().unwrap().clone() {
            return Ok(Some(cached));
        }
        let Ok(dir) = dir else { return Ok(None) };
        let loaded = tokio::task::spawn_blocking(move || load_cache(&dir))
            .await
            .map_err(|e| e.to_string())?;
        self.cache.lock().unwrap().clone_from(&loaded);
        Ok(loaded)
    }

    /// Forgets the copy in memory (a rejected token); the keychain keeps the stored one.
    async fn forget_token(&self) {
        *self.token.lock().await = None;
    }
}

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(TOKEN_SERVICE, TOKEN_USER).map_err(|e| e.to_string())
}

/// What reading the token does with the entry the first versions kept under the Gmail accounts' service.
struct Migration {
    token: Option<String>,
    /// Copy `token` to the new entry.
    copy: bool,
    delete_old: bool,
}

fn migration(new: Option<String>, old: Option<String>) -> Migration {
    Migration {
        copy: new.is_none() && old.is_some(),
        delete_old: old.is_some(),
        token: new.or(old),
    }
}

/// The stored token. An old entry is moved to the new one and deleted.
fn read_token() -> Result<Option<String>, String> {
    let (new, old) = (token_entry()?, keyring_entry(TOKEN_USER)?);
    let m = migration(read_entry(&new)?, read_entry(&old)?);
    if let (true, Some(token)) = (m.copy, &m.token) {
        new.set_password(token)
            .map_err(|e| format!("資格情報の保存に失敗: {e}"))?;
    }
    if m.delete_old {
        delete_entry(&old)?;
    }
    Ok(m.token)
}

fn read_entry(entry: &keyring::Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("資格情報の読み取りに失敗: {e}")),
    }
}

/// The response body. `Ok(None)` means the token was rejected with 401.
async fn send(
    http: &reqwest::Client,
    method: Method,
    token: &str,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> Result<Option<String>, ApiError> {
    let req = http
        .request(method, format!("{API_URL}{path}"))
        .bearer_auth(token)
        .query(query);
    let req = match body {
        Some(body) => req.json(body),
        None => req.header(reqwest::header::CONTENT_LENGTH, "0"),
    };
    answer(req.send().await.map_err(|e| e.to_string())?).await
}

/// The response body. `Ok(None)` means the token was rejected with 401.
async fn answer(res: reqwest::Response) -> Result<Option<String>, ApiError> {
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
    Ok(Some(text))
}

fn token_rejected() -> ApiError {
    ApiError::with_status(
        reqwest::StatusCode::UNAUTHORIZED.as_u16(),
        "Todoist がトークンを拒否しました".into(),
    )
}

/// The Sync API's active tasks and projects: all of them for a `None` `sync_token`, else what changed since it.
async fn fetch_sync(
    http: &reqwest::Client,
    token: &str,
    sync_token: Option<&str>,
) -> Result<SyncResponse, ApiError> {
    // The Sync API reads a form, and `resource_types` is JSON text inside it.
    let form = [
        ("sync_token", sync_token.unwrap_or("*")),
        ("resource_types", SYNC_RESOURCES),
    ];
    let res = http
        .post(format!("{API_URL}/sync"))
        .bearer_auth(token)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    parse(&answer(res).await?.ok_or_else(token_rejected)?)
}

fn parse<T: DeserializeOwned>(text: &str) -> Result<T, ApiError> {
    serde_json::from_str(text).map_err(|e| format!("Todoist の応答を読めません: {e}").into())
}

/// Whether Todoist rejected the token.
fn rejected(e: &ApiError) -> bool {
    e.status == Some(reqwest::StatusCode::UNAUTHORIZED.as_u16())
}

/// Every item of a paginated list, following `next_cursor` for up to `max_pages` pages. A rejected token is an `Err` ([`rejected`]), so a join of fetches stops at once.
async fn fetch_all<T: DeserializeOwned>(
    http: &reqwest::Client,
    token: &str,
    path: &'static str,
    query: Vec<(&'static str, String)>,
    max_pages: usize,
) -> Result<Vec<T>, ApiError> {
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..max_pages {
        let mut q = query.clone();
        q.push(("limit", PAGE_LIMIT.to_owned()));
        q.extend(cursor.map(|c| ("cursor", c)));
        let Some(text) = send(http, Method::GET, token, path, &q, None).await? else {
            return Err(token_rejected());
        };
        let page: Page<T> = parse(&text)?;
        items.extend(page.results);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(items)
}

/// Sends one request with the stored token, logging a failure. `Ok(None)` means a token is needed: none is stored, or Todoist rejected it.
async fn request(
    auth: &Auth,
    state: &TodoistState,
    command: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>, String> {
    let Some(token) = state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
    else {
        return Ok(None);
    };
    let sent = send(auth.http(), method, &token, path, &[], body.as_ref())
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let Some(text) = sent else {
        state.forget_token().await;
        return Ok(None);
    };
    // close / reopen / delete answer with null or nothing.
    if text.trim().is_empty() {
        return Ok(Some(Value::Null));
    }
    parse(&text)
        .map(Some)
        .map_err(|e| log_failure(command, TOKEN_USER, e))
}

/// The active tasks and the projects (through the Sync API: all of them the first time, then only what changed), and the recently completed tasks. `None` means a token is needed.
/// Without `with_done` the completed tasks of the last load are reused, brought up to date by the changes the sync reports.
/// A fetch that succeeds is kept in `todoist-cache.json`; when one fails, the kept content comes back marked `offline`, if there is any.
#[tauri::command]
pub async fn todoist_load(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    with_done: bool,
) -> Result<Option<Todo>, String> {
    let command = "todoist_load";
    let Some(token) = state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
    else {
        return Ok(None);
    };
    let http = auth.http();
    let mut sync = state.sync.lock().await;
    if sync.owner.as_deref() != Some(token.as_str()) {
        *sync = SyncData {
            owner: Some(token.clone()),
            ..SyncData::default()
        };
    }
    let fetch_done = async {
        if !with_done {
            return Ok::<_, ApiError>(None);
        }
        let since =
            (Utc::now() - Duration::days(DONE_DAYS)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let until = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let query = vec![("since", since), ("until", until)];
        let fetched = fetch_all::<ApiTask>(
            http,
            &token,
            "/tasks/completed/by_completion_date",
            query,
            MAX_DONE_PAGES,
        )
        .await;
        match fetched {
            // A rejected token stops the whole load; any other failure is left to the caller.
            Err(e) if rejected(&e) => Err(e),
            fetched => Ok(Some(fetched)),
        }
    };
    // Awaited here, not spawned: a failure or a rejected token returns at once and drops the fetch still running.
    let joined = tokio::try_join!(
        fetch_sync(http, &token, sync.sync_token.as_deref()),
        fetch_done,
    );
    let (res, done) = match joined {
        Ok(fetched) => fetched,
        Err(e) if rejected(&e) => {
            *sync = SyncData::default();
            state.forget_token().await;
            return Ok(None);
        }
        Err(e) => {
            let reason = log_failure(command, TOKEN_USER, e);
            // A token saved since the fetch began belongs to another connection, whose cache this is not.
            let current = state.token.lock().await;
            let cached = if current.as_deref() == Some(token.as_str()) {
                state.cache(config_dir(&app)).await?
            } else {
                None
            };
            return offline_todo(cached, reason, Local::now().date_naive()).map(Some);
        }
    };
    match done {
        Some(Ok(mut fetched)) => {
            // build_todo reads only the subtasks.
            fetched.retain(|t| t.parent_id.is_some());
            *state.done.lock().unwrap() = Arc::new(fetched);
        }
        // The done subtasks only complete the counts, so their failure (e.g. a plan without history) must not hide the tasks; the last ones stay.
        Some(Err(e)) => {
            log_failure(command, TOKEN_USER, e);
        }
        None => {}
    }
    // Taken before apply_sync consumes the answer.
    let unchanged = res.is_unchanged();
    // After the fetched ones are in, so a change the sync reports since wins over them.
    let done = {
        let mut kept = state.done.lock().unwrap();
        apply_sync(&mut sync, Arc::make_mut(&mut kept), res);
        Arc::clone(&kept)
    };
    let todo = build_todo(
        sync.projects.clone(),
        sync.tasks.clone(),
        &done,
        Local::now().date_naive(),
        &Local,
    );
    // The token lock is held through the write: a disconnect in between would otherwise leave the cache behind.
    let current = state.token.lock().await;
    // Another token than the fetch used (disconnected, or connected again meanwhile): this content is not that connection's.
    if current.as_deref() != Some(token.as_str()) {
        return Ok(Some(todo));
    }
    // Nothing changed and no completed tasks came in: the kept file and cache are still right, so the timed refresh writes nothing.
    if unchanged && !with_done {
        // Only the time in memory moves, so the offline notice names the latest successful fetch.
        if let Some(cache) = state.cache.lock().unwrap().as_mut() {
            cache.fetched_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        }
        return Ok(Some(todo));
    }
    let dir = config_dir(&app);
    let fetched_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    // The write and its fsync run off the async threads; the todo goes along and comes back.
    let (todo, fetched_at, saved) = tokio::task::spawn_blocking(move || {
        let saved = dir.and_then(|dir| save_cache(&dir, &todo, &fetched_at));
        (todo, fetched_at, saved)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(e) = saved {
        log_failure("todoist_cache", TOKEN_USER, e);
    }
    *state.cache.lock().unwrap() = Some(CacheFile {
        fetched_at,
        todo: todo.clone(),
    });
    Ok(Some(todo))
}

/// The content `todoist_load` kept last, to draw before it answers: fetches nothing, and is not marked `offline`. `None` when none is kept.
#[tauri::command]
pub async fn todoist_cached(app: AppHandle) -> Result<Option<Todo>, String> {
    let Ok(dir) = config_dir(&app) else {
        return Ok(None);
    };
    let cached = tokio::task::spawn_blocking(move || load_cache(&dir))
        .await
        .map_err(|e| e.to_string())?;
    Ok(cached.map(|CacheFile { mut todo, .. }| {
        rebucket(&mut todo, Local::now().date_naive());
        todo
    }))
}

/// Stores the personal API token in the keychain. It is never logged or returned.
#[tauri::command]
pub async fn todoist_save_token(
    state: State<'_, TodoistState>,
    token: String,
) -> Result<(), String> {
    let token = token.trim().to_owned();
    if token.is_empty() {
        return Err("トークンを入力してください".into());
    }
    let mut cached = state.token.lock().await;
    let stored = token.clone();
    tokio::task::spawn_blocking(move || {
        token_entry().and_then(|e| {
            e.set_password(&stored)
                .map_err(|e| format!("資格情報の保存に失敗: {e}"))
        })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    .map_err(|e| log_failure("todoist_save_token", TOKEN_USER, e))?;
    *cached = Some(token);
    Ok(())
}

/// Removes the stored token (the old entry too, or the next read would move it back), and the sync data, the completed tasks and the cache file kept with it.
#[tauri::command]
pub async fn todoist_disconnect(
    app: AppHandle,
    state: State<'_, TodoistState>,
) -> Result<(), String> {
    let dir = config_dir(&app);
    let mut cached = state.token.lock().await;
    let cleared = tokio::task::spawn_blocking(move || {
        // All three run even when one fails, so a failed keychain delete does not leave the cache behind.
        [
            token_entry().and_then(|e| delete_entry(&e)),
            keyring_entry(TOKEN_USER).and_then(|e| delete_entry(&e)),
            dir.and_then(|dir| remove_cache(&dir)),
        ]
        .into_iter()
        .find_map(Result::err)
        .map_or(Ok(()), Err)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    // Forgotten even when a delete failed: the next read then shows what the keychain really holds.
    *cached = None;
    *state.done.lock().unwrap() = Arc::default();
    *state.cache.lock().unwrap() = None;
    // `sync` is never waited for while `token` is held: a load holds the one and wants the other.
    drop(cached);
    *state.sync.lock().await = SyncData::default();
    cleared.map_err(|e| log_failure("todoist_disconnect", TOKEN_USER, e))
}

/// Adds a task from natural language (Quick Add). Inside a project (`project_id`) the task is moved there.
/// With `today`, a task the text gave no date gets today as its due date; a date in the text is kept.
/// `Some(false)` means the task was created but the move or the due date failed (logged, a rejected token included), so it stays as Quick Add left it;
/// the caller must not retry. `None` means a token is needed and nothing was created.
#[tauri::command]
pub async fn todoist_add(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    text: String,
    project_id: Option<String>,
    today: bool,
) -> Result<Option<bool>, String> {
    let command = "todoist_add";
    let text = text.trim();
    if text.is_empty() {
        return Err("タスクの内容を入力してください".into());
    }
    let body = json!({ "text": text });
    let Some(created) = request(
        &auth,
        &state,
        command,
        Method::POST,
        "/tasks/quick",
        Some(body),
    )
    .await?
    else {
        return Ok(None);
    };
    if let Some(id) = task_to_move(&created, project_id.as_deref()) {
        let result = move_task(&auth, &state, command, &id, project_id.as_deref()).await;
        return Ok(Some(moved(result)));
    }
    if let Some(id) = task_without_due(&created).filter(|_| today) {
        let result = set_due_today(&auth, &state, command, &id).await;
        return Ok(Some(moved(result)));
    }
    Ok(Some(true))
}

async fn set_due_today(
    auth: &Auth,
    state: &TodoistState,
    command: &str,
    id: &str,
) -> Result<Option<bool>, String> {
    let url = task_api_url(id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body =
        update_body(None, None, Some("today")).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(auth, state, command, Method::POST, &url, Some(body)).await?;
    Ok(done.map(|_| true))
}

/// Whether the move into the project (or the due date) worked. The task exists either way, so a failure or a rejected token is not an answer for the caller
/// to retry; the load that follows shows that a token is needed.
fn moved(result: Result<Option<bool>, String>) -> bool {
    matches!(result, Ok(Some(true)))
}

async fn move_task(
    auth: &Auth,
    state: &TodoistState,
    command: &str,
    id: &str,
    project_id: Option<&str>,
) -> Result<Option<bool>, String> {
    let url = task_api_url(id, Some("move")).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body = json!({ "project_id": project_id });
    let done = request(auth, state, command, Method::POST, &url, Some(body)).await?;
    // `true`, not `()`: `Some(())` reaches JS as null, the same as `None` (a token is needed).
    Ok(done.map(|_| true))
}

/// Adds a task under `parent_id`.
#[tauri::command]
pub async fn todoist_add_subtask(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
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
    let done = request(&auth, &state, command, Method::POST, "/tasks", Some(body)).await?;
    Ok(done.map(|_| true))
}

/// Adds a task to the inbox that points at a Gmail thread: the subject is its name, the thread's URL its description.
#[tauri::command]
pub async fn todoist_task_from_mail(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    account: String,
    thread_id: String,
    subject: String,
) -> Result<Option<bool>, String> {
    let command = "todoist_task_from_mail";
    let accounts = config_dir(&app)
        .and_then(|dir| auth.accounts(&dir))
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let url = gmail_url(&accounts, &account, &thread_id)
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let subject = subject.trim();
    let content = if subject.is_empty() {
        "(件名なし)"
    } else {
        subject
    };
    let body = json!({ "content": content, "description": url });
    let done = request(&auth, &state, command, Method::POST, "/tasks", Some(body)).await?;
    Ok(done.map(|_| true))
}

/// Reads the Slack message `url` points at, has Claude summarise it, and adds the summary as a task: its name is the summary's, its description
/// the key points and then the message's URL. It goes to `project_id` (the inbox for `None`); with `today`, a task the summary gave no date is due today.
/// Returns the task's name; `None` means a token is needed and nothing was created. The message's text is sent to Anthropic through Claude Code.
#[tauri::command]
pub async fn todoist_add_from_slack(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    url: String,
    project_id: Option<String>,
    today: bool,
) -> Result<Option<String>, String> {
    let command = "todoist_add_from_slack";
    if let Some(id) = &project_id {
        valid_id(id, "プロジェクト ID").map_err(|e| log_failure(command, TOKEN_USER, e))?;
    }
    // Without a Todoist token, nothing is read from Slack and nothing is sent to Claude.
    if state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
        .is_none()
    {
        return Ok(None);
    }
    let url = url.trim();
    let dir = config_dir(&app).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let message = slack::message_context(&dir, auth.http(), url)
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let summary = claude::summarize(&message).await.map_err(|e| {
        log_failure(command, TOKEN_USER, e.log);
        e.screen
    })?;
    let body = slack_task_body(&summary, url, project_id.as_deref(), today);
    let created = request(&auth, &state, command, Method::POST, "/tasks", Some(body)).await?;
    Ok(created.map(|_| summary.content))
}

/// Completes (`close`) or reopens a task.
#[tauri::command]
pub async fn todoist_set_done(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
    done: bool,
) -> Result<Option<bool>, String> {
    let command = "todoist_set_done";
    let action = if done { "close" } else { "reopen" };
    let url = task_api_url(&id, Some(action)).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let sent = request(&auth, &state, command, Method::POST, &url, None).await?;
    Ok(sent.map(|_| true))
}

/// Changes the fields given; an empty `due_string` clears the due date.
#[tauri::command]
pub async fn todoist_update(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
    content: Option<String>,
    description: Option<String>,
    due_string: Option<String>,
) -> Result<Option<bool>, String> {
    let command = "todoist_update";
    let url = task_api_url(&id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body = update_body(
        content.as_deref(),
        description.as_deref(),
        due_string.as_deref(),
    )
    .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(&auth, &state, command, Method::POST, &url, Some(body)).await?;
    Ok(done.map(|_| true))
}

#[tauri::command]
pub async fn todoist_move(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
    project_id: String,
) -> Result<Option<bool>, String> {
    move_task(&auth, &state, "todoist_move", &id, Some(&project_id)).await
}

/// Deletes a task for good; Todoist cannot undo it, so the screen asks twice.
#[tauri::command]
pub async fn todoist_delete(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
) -> Result<Option<bool>, String> {
    let command = "todoist_delete";
    let url = task_api_url(&id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(&auth, &state, command, Method::DELETE, &url, None).await?;
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

    #[test]
    fn migration_moves_the_old_entry_only_when_the_new_one_is_empty() {
        let (old, new) = (Some("o".to_owned()), Some("n".to_owned()));
        let m = migration(None, old.clone());
        assert_eq!(
            (m.token.as_deref(), m.copy, m.delete_old),
            (Some("o"), true, true)
        );
        let m = migration(new.clone(), old);
        assert_eq!(
            (m.token.as_deref(), m.copy, m.delete_old),
            (Some("n"), false, true)
        );
        let m = migration(new, None);
        assert_eq!(
            (m.token.as_deref(), m.copy, m.delete_old),
            (Some("n"), false, false)
        );
        let m = migration(None, None);
        assert_eq!((m.token, m.copy, m.delete_old), (None, false, false));
    }

    fn accounts() -> Vec<String> {
        vec!["a@example.com".into()]
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
            parent_id: None,
            is_archived: false,
            is_deleted: false,
        }
    }

    fn child(parent: &str, id: &str, order: i64) -> ApiProject {
        ApiProject {
            parent_id: Some(parent.into()),
            ..project(id, id, "charcoal", false, order)
        }
    }

    fn todo(tasks: Vec<ApiTask>, completed: Vec<ApiTask>) -> Todo {
        build_todo(vec![], tasks, &completed, date("2026-10-29"), &jst())
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
            gmail_url(&accounts(), "a@example.com", "18c3f0a1b2").unwrap(),
            "https://mail.google.com/mail/u/a@example.com/#all/18c3f0a1b2"
        );
    }

    #[test]
    fn gmail_url_refuses_a_bad_thread_id() {
        assert!(gmail_url(&accounts(), "a@example.com", "").is_err());
        assert!(gmail_url(&accounts(), "a@example.com", "x/y").is_err());
    }

    #[test]
    fn gmail_url_refuses_an_unregistered_account() {
        assert!(gmail_url(&accounts(), "b@example.com", "18c3f0a1b2").is_err());
        assert!(gmail_url(&[], "a@example.com", "18c3f0a1b2").is_err());
    }

    #[test]
    fn mail_is_read_back_from_the_description() {
        let url = gmail_url(&accounts(), "a@example.com", "18c3f0a1b2").unwrap();
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
    fn links_that_cookapps_did_not_make_are_not_mail() {
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
            update_body(Some("a"), None, None).unwrap(),
            json!({"content": "a"})
        );
        assert_eq!(
            update_body(None, Some("memo"), Some("明日")).unwrap(),
            json!({"description": "memo", "due_string": "明日"})
        );
    }

    #[test]
    fn update_body_clears_the_due_date_with_an_empty_string() {
        assert_eq!(
            update_body(None, None, Some("  ")).unwrap(),
            json!({"due_string": "no date"})
        );
    }

    #[test]
    fn update_body_keeps_an_empty_description() {
        assert_eq!(
            update_body(None, Some(""), None).unwrap(),
            json!({"description": ""})
        );
    }

    #[test]
    fn update_body_refuses_an_empty_name_and_no_fields() {
        assert!(update_body(Some(" "), None, None).is_err());
        assert!(update_body(None, None, None).is_err());
    }

    #[test]
    fn quick_add_task_in_another_project_is_moved() {
        let created = json!({"id": "T1", "project_id": "inbox"});
        assert_eq!(task_to_move(&created, Some("p1")), Some("T1".into()));
        assert_eq!(task_to_move(&created, Some("inbox")), None);
        assert_eq!(task_to_move(&created, None), None);
    }

    #[test]
    fn quick_add_task_without_a_due_date_is_found() {
        let due = json!({"date": "2026-10-31", "string": "tomorrow"});
        assert_eq!(task_without_due(&json!({"id": "T1"})), Some("T1".into()));
        assert_eq!(
            task_without_due(&json!({"id": "T1", "due": null})),
            Some("T1".into())
        );
        assert_eq!(task_without_due(&json!({"id": "T1", "due": due})), None);
        assert_eq!(task_without_due(&json!({"due": null})), None);
    }

    #[test]
    fn a_created_task_is_never_reported_as_needing_a_token() {
        assert!(moved(Ok(Some(true))));
        // The move was rejected with 401 or failed: the task exists all the same.
        assert!(!moved(Ok(None)));
        assert!(!moved(Err("x".into())));
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
        let tops: Vec<_> = t.tasks.iter().filter(|t| t.parent.is_none()).collect();
        assert_eq!(tops.len(), 1);
        let a = tops[0];
        assert_eq!((a.sub_done, a.sub_total), (0, 1));
        assert_eq!(a.subtasks.len(), 1);
        assert_eq!(a.subtasks[0].id, "B");
        assert!(!a.subtasks[0].done);
    }

    #[test]
    fn every_subtask_is_a_row_so_its_detail_can_open() {
        let t = todo(
            vec![
                task(json!({"id": "A", "content": "親"})),
                task(json!({"id": "B", "parent_id": "A", "content": "子"})),
                task(json!({"id": "C", "parent_id": "B", "content": "孫"})),
            ],
            vec![task(json!({"id": "D", "parent_id": "B", "content": "済"}))],
        );
        let ids: Vec<_> = t.tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["A", "B", "C"]);
        let b = &t.tasks[1];
        assert_eq!(b.bucket, Bucket::NoDue);
        assert_eq!((b.sub_done, b.sub_total), (1, 2));
        assert_eq!(
            b.parent,
            Some(ParentRef {
                id: "A".into(),
                content: "親".into()
            })
        );
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
    fn a_subtask_is_a_row_of_its_own_whatever_its_due() {
        let t = todo(
            vec![
                task(json!({"id": "A", "content": "親", "project_id": "p"})),
                task(
                    json!({"id": "B", "parent_id": "A", "content": "今日", "project_id": "p", "priority": 4,
                            "due": {"date": "2026-10-29T09:00:00"}}),
                ),
                task(json!({"id": "C", "parent_id": "A", "due": {"date": "2026-10-27"}})),
                task(json!({"id": "D", "parent_id": "A", "due": {"date": "2026-10-30"}})),
                task(json!({"id": "E", "parent_id": "A"})),
            ],
            vec![],
        );
        let got: Vec<_> = t.tasks.iter().map(|t| (t.id.as_str(), t.bucket)).collect();
        assert_eq!(
            got,
            [
                ("C", Bucket::Overdue),
                ("B", Bucket::Today),
                ("D", Bucket::Upcoming),
                ("A", Bucket::NoDue),
                ("E", Bucket::NoDue)
            ]
        );
        let b = &t.tasks[1];
        assert_eq!(b.project_id, "p");
        assert_eq!(b.priority, 1);
        assert_eq!(
            b.parent,
            Some(ParentRef {
                id: "A".into(),
                content: "親".into()
            })
        );
        assert!(b.subtasks.is_empty());
        // The parent still lists all its subtasks and is not itself a subtask row.
        assert_eq!(t.tasks[3].parent, None);
        assert_eq!(t.tasks[3].sub_total, 4);
    }

    #[test]
    fn a_due_grandchild_points_at_its_own_parent() {
        let t = todo(
            vec![
                task(json!({"id": "A", "content": "親"})),
                task(json!({"id": "B", "parent_id": "A", "content": "子"})),
                task(json!({"id": "C", "parent_id": "B", "due": {"date": "2026-10-29"}})),
                // Its parent is not among the active tasks: nothing opens it, so it is not a row.
                task(json!({"id": "D", "parent_id": "Z", "due": {"date": "2026-10-29"}})),
            ],
            vec![],
        );
        let c = t.tasks.iter().find(|t| t.id == "C").unwrap();
        assert_eq!(
            c.parent,
            Some(ParentRef {
                id: "B".into(),
                content: "子".into()
            })
        );
        assert!(t.tasks.iter().all(|t| t.id != "D"));
    }

    #[test]
    fn completed_subtasks_are_not_rows() {
        let t = todo(
            vec![task(json!({"id": "A"}))],
            vec![task(
                json!({"id": "B", "parent_id": "A", "due": {"date": "2026-10-29"}}),
            )],
        );
        assert_eq!(t.tasks.len(), 1);
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
                string: "every day".into(),
                recurring: false
            })
        );
        // Judged against the local date: 05:30 on the 30th is not today (the 29th).
        assert_eq!(t.tasks[0].bucket, Bucket::Upcoming);
    }

    #[test]
    fn due_reports_whether_it_recurs() {
        let t = todo(
            vec![task(
                json!({"id": "A", "due": {"date": "2026-10-30", "string": "every day", "is_recurring": true}}),
            )],
            vec![],
        );
        assert!(t.tasks[0].due.as_ref().unwrap().recurring);
    }

    #[test]
    fn task_fields_carry_priority_and_mail() {
        let url = gmail_url(&accounts(), "a@example.com", "abc123").unwrap();
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
            &[],
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
    fn projects_come_in_tree_order_with_siblings_by_child_order() {
        let got: Vec<_> = order_projects(vec![
            child("a", "a2", 2),
            project("b", "B", "", false, 2),
            child("a1", "a1x", 1),
            child("a", "a1", 1),
            project("a", "A", "", false, 1),
            // Its parent is not among the projects (archived): it goes to the top.
            child("gone", "orphan", 3),
        ])
        .into_iter()
        .map(|(p, depth)| (p.id, p.parent_id, depth))
        .collect();
        let got: Vec<_> = got
            .iter()
            .map(|(i, p, d)| (i.as_str(), p.as_deref(), *d))
            .collect();
        assert_eq!(
            got,
            [
                ("a", None, 0),
                ("a1", Some("a"), 1),
                ("a1x", Some("a1"), 2),
                ("a2", Some("a"), 1),
                ("b", None, 0),
                ("orphan", None, 0)
            ]
        );
    }

    #[test]
    fn a_project_item_carries_its_parent() {
        let t = build_todo(
            vec![project("a", "A", "", false, 1), child("a", "c", 1)],
            vec![],
            &[],
            date("2026-10-29"),
            &jst(),
        );
        let got: Vec<_> = t
            .projects
            .iter()
            .map(|p| (p.id.as_str(), p.parent_id.as_deref()))
            .collect();
        assert_eq!(got, [("a", None), ("c", Some("a"))]);
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

    fn sync_res(v: Value) -> SyncResponse {
        serde_json::from_value(v).unwrap()
    }

    fn ids(data: &SyncData) -> Vec<&str> {
        data.tasks.iter().map(|t| t.id.as_str()).collect()
    }

    fn synced(v: Value) -> (SyncData, Vec<ApiTask>) {
        let (mut data, mut done) = (SyncData::default(), vec![]);
        apply_sync(&mut data, &mut done, sync_res(v));
        (data, done)
    }

    #[test]
    fn a_full_sync_replaces_what_was_kept() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1", "full_sync": true,
            "items": [{"id": "A"}, {"id": "B"}],
            "projects": [{"id": "p1", "name": "古い"}],
        }));
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2", "full_sync": true,
                "items": [{"id": "C"}],
                "projects": [{"id": "p2", "name": "新しい"}],
            })),
        );
        assert_eq!(ids(&data), ["C"]);
        assert_eq!(data.projects.len(), 1);
        assert_eq!(data.projects[0].id, "p2");
        assert_eq!(data.sync_token.as_deref(), Some("t2"));
    }

    #[test]
    fn an_incremental_sync_overwrites_by_id_in_place_and_adds() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1", "full_sync": true,
            "items": [{"id": "A", "content": "a"}, {"id": "B", "content": "b"}],
            "projects": [{"id": "p1", "name": "古い"}, {"id": "p2", "name": "別"}],
        }));
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2",
                "items": [{"id": "A", "content": "直した"}, {"id": "C", "content": "c"}],
                "projects": [{"id": "p1", "name": "新しい"}],
            })),
        );
        assert_eq!(ids(&data), ["A", "B", "C"]);
        assert_eq!(data.tasks[0].content, "直した");
        assert_eq!(data.projects.len(), 2);
        assert_eq!(data.projects[0].name, "新しい");
    }

    #[test]
    fn an_answer_without_a_full_sync_flag_is_incremental() {
        let r = sync_res(json!({"sync_token": "t"}));
        assert!(!r.full_sync && r.items.is_empty() && r.projects.is_empty());
    }

    #[test]
    fn only_an_empty_incremental_answer_is_unchanged() {
        assert!(sync_res(json!({"sync_token": "t"})).is_unchanged());
        assert!(!sync_res(json!({"sync_token": "t", "full_sync": true})).is_unchanged());
        assert!(!sync_res(json!({"sync_token": "t", "items": [{"id": "A"}]})).is_unchanged());
        assert!(!sync_res(json!({"sync_token": "t", "projects": [{"id": "P"}]})).is_unchanged());
    }

    #[test]
    fn deleted_and_completed_tasks_drop_out() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1", "full_sync": true,
            "items": [{"id": "A"}, {"id": "B"}, {"id": "C"}],
        }));
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2",
                "items": [
                    {"id": "A", "is_deleted": true},
                    {"id": "B", "checked": true},
                    {"id": "Z", "checked": true},
                ],
            })),
        );
        assert_eq!(ids(&data), ["C"]);
    }

    #[test]
    fn archived_and_deleted_projects_drop_out() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1", "full_sync": true,
            "projects": [{"id": "p1"}, {"id": "p2"}, {"id": "p3"}],
        }));
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2",
                "projects": [{"id": "p1", "is_archived": true}, {"id": "p2", "is_deleted": true}],
            })),
        );
        assert_eq!(data.projects.len(), 1);
        assert_eq!(data.projects[0].id, "p3");
    }

    #[test]
    fn the_tasks_of_an_archived_or_deleted_project_drop_out() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1", "full_sync": true,
            "items": [
                {"id": "A", "project_id": "p1"},
                {"id": "B", "project_id": "p2"},
                {"id": "C", "project_id": "p3"},
            ],
            "projects": [{"id": "p1"}, {"id": "p2"}, {"id": "p3"}],
        }));
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2",
                "projects": [{"id": "p1", "is_archived": true}, {"id": "p2", "is_deleted": true}],
            })),
        );
        assert_eq!(ids(&data), ["C"]);
    }

    #[test]
    fn a_completed_subtask_is_done_until_it_is_reopened() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1",
            "items": [
                {"id": "S", "parent_id": "A", "checked": true},
                {"id": "T", "checked": true},
            ],
        }));
        assert_eq!(done.iter().map(|t| &t.id[..]).collect::<Vec<_>>(), ["S"]);
        assert!(data.tasks.is_empty());
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2",
                "items": [{"id": "S", "parent_id": "A", "checked": false}],
            })),
        );
        assert!(done.is_empty());
        assert_eq!(ids(&data), ["S"]);
    }

    #[test]
    fn a_deleted_completed_subtask_is_no_longer_done() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1",
            "items": [{"id": "S", "parent_id": "A", "checked": true}],
        }));
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2",
                "items": [{"id": "S", "parent_id": "A", "checked": true, "is_deleted": true}],
            })),
        );
        assert!(done.is_empty());
    }

    #[test]
    fn a_completed_subtask_reported_again_is_kept_once() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1",
            "items": [{"id": "S", "parent_id": "A", "checked": true, "content": "前"}],
        }));
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2",
                "items": [{"id": "S", "parent_id": "A", "checked": true, "content": "後"}],
            })),
        );
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].content, "後");
    }

    #[test]
    fn the_subtasks_a_sync_completes_count_in_the_todo() {
        let (data, done) = synced(json!({
            "sync_token": "t",
            "full_sync": true,
            "items": [{"id": "A", "content": "親"}, {"id": "S", "parent_id": "A", "checked": true}],
        }));
        let t = build_todo(vec![], data.tasks, &done, date("2026-10-29"), &jst());
        assert_eq!(t.tasks.len(), 1);
        assert_eq!((t.tasks[0].sub_done, t.tasks[0].sub_total), (1, 1));
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-todoist-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn cached_todo() -> Todo {
        let projects = vec![project("p1", "Inbox", "red", true, 1)];
        let tasks = vec![task(
            json!({"id": "t1", "content": "a", "project_id": "p1", "priority": 4, "due": {"date": "2026-10-29", "string": "today"}}),
        )];
        build_todo(projects, tasks, &[], date("2026-10-29"), &jst())
    }

    #[test]
    fn cache_round_trips_and_leaves_no_temporary_file() {
        let dir = temp_dir("cache");
        assert!(load_cache(&dir).is_none());
        let todo = cached_todo();
        save_cache(&dir, &todo, "2026-10-29T01:02:03Z").unwrap();
        let loaded = load_cache(&dir).unwrap();
        assert_eq!(loaded.fetched_at, "2026-10-29T01:02:03Z");
        assert_eq!(loaded.todo, todo);
        assert!(!dir.join(CACHE_TMP_FILE).exists());
        remove_cache(&dir).unwrap();
        assert!(load_cache(&dir).is_none());
        // Removing what is not there is not a failure.
        remove_cache(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failed_cache_save_leaves_the_existing_file_untouched() {
        let dir = temp_dir("atomic");
        let todo = cached_todo();
        save_cache(&dir, &todo, "old").unwrap();
        // A directory in the temporary file's place makes the write fail before the rename.
        std::fs::create_dir(dir.join(CACHE_TMP_FILE)).unwrap();
        assert!(save_cache(&dir, &todo, "new").is_err());
        assert_eq!(load_cache(&dir).unwrap().fetched_at, "old");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn broken_cache_is_none() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        for text in ["", "not json", r#"{"fetched_at": "x"}"#] {
            std::fs::write(dir.join(CACHE_FILE), text).unwrap();
            assert!(load_cache(&dir).is_none(), "{text}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_fetch_returns_the_cache_with_when_and_why() {
        let cached = CacheFile {
            fetched_at: "2026-10-29T01:02:03Z".into(),
            todo: cached_todo(),
        };
        let todo = offline_todo(Some(cached), "503".into(), date("2026-10-29")).unwrap();
        assert_eq!(
            todo.offline,
            Some(Offline {
                fetched_at: "2026-10-29T01:02:03Z".into(),
                reason: "503".into()
            })
        );
        assert_eq!(todo.tasks, cached_todo().tasks);
        let sent = serde_json::to_value(&todo).unwrap();
        assert_eq!(sent["offline"]["fetchedAt"], "2026-10-29T01:02:03Z");
        assert_eq!(sent["offline"]["reason"], "503");
    }

    #[test]
    fn a_cached_today_task_is_overdue_the_next_day() {
        let cached = CacheFile {
            fetched_at: "2026-10-29T01:02:03Z".into(),
            todo: cached_todo(),
        };
        assert_eq!(cached.todo.tasks[0].bucket, Bucket::Today);
        let next_day =
            offline_todo(Some(cached.clone()), "503".into(), date("2026-10-30")).unwrap();
        assert_eq!(next_day.tasks[0].bucket, Bucket::Overdue);
        let day_before = offline_todo(Some(cached), "503".into(), date("2026-10-28")).unwrap();
        assert_eq!(day_before.tasks[0].bucket, Bucket::Upcoming);
    }

    #[test]
    fn a_failed_fetch_without_a_cache_is_the_failure() {
        assert_eq!(
            offline_todo(None, "503".into(), date("2026-10-29")).unwrap_err(),
            "503"
        );
    }

    #[test]
    fn a_fetched_todo_does_not_mention_offline() {
        let sent = serde_json::to_value(cached_todo()).unwrap();
        assert!(sent.get("offline").is_none());
    }

    fn summary(due: Option<&str>) -> Summary {
        Summary {
            content: "PR #482 のレビュー".into(),
            description: "認証まわりの変更".into(),
            due: due.map(str::to_owned),
        }
    }

    const SLACK_URL: &str = "https://example.slack.com/archives/C0123ABC/p1761785520123456";

    #[test]
    fn a_slack_task_ends_its_description_with_the_message_url() {
        assert_eq!(
            slack_task_body(&summary(None), SLACK_URL, None, false),
            json!({
                "content": "PR #482 のレビュー",
                "description": format!("認証まわりの変更\n\n{SLACK_URL}"),
            })
        );
    }

    #[test]
    fn a_slack_task_with_no_key_points_has_only_the_url() {
        let mut s = summary(None);
        s.description = String::new();
        assert_eq!(
            slack_task_body(&s, SLACK_URL, None, false)["description"],
            SLACK_URL
        );
    }

    #[test]
    fn a_slack_task_takes_the_summarys_due_and_the_project() {
        assert_eq!(
            slack_task_body(
                &summary(Some("2026-11-01 15:00")),
                SLACK_URL,
                Some("P1"),
                true
            ),
            json!({
                "content": "PR #482 のレビュー",
                "description": format!("認証まわりの変更\n\n{SLACK_URL}"),
                "due_string": "2026-11-01 15:00",
                "project_id": "P1",
            })
        );
    }

    #[test]
    fn a_slack_task_with_no_due_is_due_today_only_in_today() {
        assert_eq!(
            slack_task_body(&summary(None), SLACK_URL, None, true)["due_string"],
            "today"
        );
        assert!(
            slack_task_body(&summary(None), SLACK_URL, Some("P1"), false)
                .get("due_string")
                .is_none()
        );
    }

    #[test]
    fn a_slack_task_takes_only_a_date_or_a_date_and_time_as_due() {
        for due in ["2026-11-01", "2026-11-01 15:00"] {
            assert_eq!(
                slack_task_body(&summary(Some(due)), SLACK_URL, None, false)["due_string"],
                due
            );
        }
        for due in [
            "every day",
            "tomorrow",
            "2026-11-01T15:00",
            "2026-13-01",
            "2026-11-01 25:00",
            "2026-1-5",
            "",
        ] {
            let body = slack_task_body(&summary(Some(due)), SLACK_URL, None, false);
            assert!(body.get("due_string").is_none(), "{due}");
            let today = slack_task_body(&summary(Some(due)), SLACK_URL, None, true);
            assert_eq!(today["due_string"], "today", "{due}");
        }
    }

    #[test]
    fn a_slack_task_name_is_cut_at_the_limit() {
        let mut s = summary(None);
        s.content = "あ".repeat(CONTENT_LIMIT + 10);
        let body = slack_task_body(&s, SLACK_URL, None, false);
        assert_eq!(
            body["content"].as_str().unwrap().chars().count(),
            CONTENT_LIMIT
        );
    }
}
