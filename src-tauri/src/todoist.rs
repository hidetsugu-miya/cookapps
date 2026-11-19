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
    accounts::write_atomic,
    auth::{config_dir, Auth, KEYRING_SERVICE},
    claude::{self, Summary},
    gmail::{log_failure, ApiError},
    keychain, slack,
};

const API_URL: &str = "https://api.todoist.com/api/v1";
const WEB_TASK_URL: &str = "https://app.todoist.com/app/task";
const GMAIL_URL: &str = "https://mail.google.com/mail/u/";
/// The keychain user name (and the `account=` of the logs) of the personal API token.
const TOKEN_USER: &str = "todoist";
/// The token has a service of its own: under the Gmail accounts' one, a name from outside could reach it as an account.
const TOKEN_SERVICE: &str = "jp.mysis.tsunagiai.todoist";
/// Todoist refuses a task name longer than this.
const CONTENT_LIMIT: usize = 500;
const PAGE_LIMIT: &str = "200";
// shortcut: past these many pages (200 items each) the rest is dropped, upgrade if the list ever grows that long.
const MAX_DONE_PAGES: usize = 5;
/// The Sync API's `resource_types`: the active tasks, the projects and the personal labels.
const SYNC_RESOURCES: &str = r#"["items","projects","labels"]"#;
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
    /// Where the task stands among its siblings (the same project, section and parent), as a fractional index that sorts as text (T-2); `None` for a task Todoist has not given one yet.
    #[serde(default)]
    order_key: Option<String>,
    /// The section of a top-level task; the task list does not show sections.
    #[serde(default)]
    section_id: Option<String>,
    /// Completed. The Sync API sends a task that was completed or deleted since the last sync.
    #[serde(default)]
    checked: bool,
    #[serde(default)]
    is_deleted: bool,
    /// The names of its labels, personal or shared.
    #[serde(default)]
    labels: Vec<String>,
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

/// A personal label. Shared labels are not in the sync answer; they appear only in a task's `labels`.
#[derive(Deserialize, Clone)]
struct ApiLabel {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    item_order: i64,
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
    #[serde(default)]
    labels: Vec<ApiLabel>,
}

impl SyncResponse {
    /// Whether the answer reports no change: applying it leaves the tasks, projects and labels as they were.
    fn is_unchanged(&self) -> bool {
        !self.full_sync
            && self.items.is_empty()
            && self.projects.is_empty()
            && self.labels.is_empty()
    }
}

/// The active tasks, the projects and the personal labels as the last sync left them.
#[derive(Default)]
struct SyncData {
    /// The token the data was fetched with: another one means another account, whose data this is not.
    owner: Option<String>,
    /// `None` asks for a full sync.
    sync_token: Option<String>,
    tasks: Vec<ApiTask>,
    projects: Vec<ApiProject>,
    labels: Vec<ApiLabel>,
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

/// Brings `data` up to date with a sync answer. Completed and deleted tasks, archived and deleted projects and deleted labels drop out.
/// `done` (the completed subtasks) follows the tasks that were completed, reopened or deleted since.
fn apply_sync(data: &mut SyncData, done: &mut Vec<ApiTask>, res: SyncResponse) {
    let task_gone = |t: &ApiTask| t.checked || t.is_deleted;
    let project_gone = |p: &ApiProject| p.is_archived || p.is_deleted;
    let label_gone = |l: &ApiLabel| l.is_deleted;
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
        data.labels = res.labels.into_iter().filter(|l| !label_gone(l)).collect();
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
        upsert(&mut data.labels, res.labels, |l| &l.id, label_gone);
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
    /// Todoist's human-readable form ("every day", "明日"); the due chip shows it only for a repeating task.
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
    /// When the due falls, in epoch milliseconds: its local date and time, 00:00 of the date when it has no time. `None` with no due date.
    /// Set again when a cache is read, so a cache written before this field existed gets it.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number | null"))]
    due_at: Option<i64>,
    /// Active subtasks first, then the completed ones.
    subtasks: Vec<Subtask>,
    sub_done: usize,
    sub_total: usize,
    mail: Option<MailRef>,
    /// Set on the row of a subtask; `None` on a top-level task.
    parent: Option<ParentRef>,
    /// The task in Todoist's web app, for "copy link". Empty in a cache written before this field existed, and for an ID `task_web_url` refuses.
    #[serde(default)]
    url: String,
    /// The names of its labels. Empty in a cache written before this field existed.
    #[serde(default)]
    labels: Vec<String>,
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

/// A label to pick for a task.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct LabelItem {
    name: String,
    /// `#RRGGBB`.
    color: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Todo {
    projects: Vec<ProjectItem>,
    /// The labels to pick from: the personal ones by their order, then the names only active tasks carry (shared labels), by name. Empty in a cache written before this field existed.
    #[serde(default)]
    labels: Vec<LabelItem>,
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

fn save_cache(dir: &Path, todo: &Todo, fetched_at: &str) -> Result<(), String> {
    let text = serde_json::to_string(&json!({"fetched_at": fetched_at, "todo": todo}))
        .map_err(|e| e.to_string())?;
    write_atomic(dir, CACHE_FILE, &text)
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

/// Sets each task's bucket again against `today`, and its due moment in `tz`: the cached ones were set on the day they were fetched, and a cache of an older version has no moment.
/// shortcut: the order and which subtasks are rows stay as fetched, so a task that became due today since then is not added; the next successful fetch fixes it.
fn rebucket<Tz: TimeZone>(todo: &mut Todo, today: NaiveDate, tz: &Tz) {
    for t in &mut todo.tasks {
        t.bucket = bucket_of(t.due.as_ref().and_then(|d| d.date.parse().ok()), today);
        t.due_at = t.due.as_ref().and_then(|d| due_at(tz, d));
    }
}

/// The answer to a failed fetch: the cached `Todo` marked with `reason`, or the failure itself when nothing is cached.
fn offline_todo<Tz: TimeZone>(
    cached: Option<CacheFile>,
    reason: String,
    today: NaiveDate,
    tz: &Tz,
) -> Result<Todo, String> {
    match cached {
        Some(CacheFile {
            fetched_at,
            mut todo,
        }) => {
            rebucket(&mut todo, today, tz);
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

/// When `due` falls, in epoch milliseconds: its date and time in `tz`, 00:00 of the date when it has no time. `None` when it cannot be read.
/// A time the clock skips (the hour a daylight saving change jumps over) is read as an hour later, and one it passes twice as the first.
fn due_at<Tz: TimeZone>(tz: &Tz, due: &Due) -> Option<i64> {
    let time = match &due.time {
        Some(t) => NaiveTime::parse_from_str(t, "%H:%M").ok()?,
        None => NaiveTime::MIN,
    };
    let local = due.date.parse::<NaiveDate>().ok()?.and_time(time);
    let at = tz.from_local_datetime(&local).earliest().or_else(|| {
        tz.from_local_datetime(&(local + Duration::hours(1)))
            .earliest()
    })?;
    Some(at.timestamp_millis())
}

/// What the screen shows for a due text before Todoist answers.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct PickedDue {
    due: Option<Due>,
    bucket: Bucket,
    #[cfg_attr(test, ts(type = "number | null"))]
    due_at: Option<i64>,
}

/// The due a text from the calendar (`YYYY-MM-DD`, with ` HH:MM` for a time) makes, or no due date for an empty one, judged against `today` in `tz`.
/// `None` for other text: Todoist reads it, and the task stays as it is until the reload.
fn picked_due<Tz: TimeZone>(text: &str, today: NaiveDate, tz: &Tz) -> Option<PickedDue> {
    let text = text.trim();
    if text.is_empty() {
        return Some(PickedDue {
            due: None,
            bucket: Bucket::NoDue,
            due_at: None,
        });
    }
    if !is_plain_due(text) {
        return None;
    }
    let (date, time) = text
        .split_once(' ')
        .map_or((text, None), |(d, t)| (d, Some(t)));
    let due = Due {
        date: date.to_owned(),
        time: time.map(str::to_owned),
        string: text.to_owned(),
        recurring: false,
    };
    Some(PickedDue {
        bucket: bucket_of(Some(date.parse().ok()?), today),
        due_at: due_at(tz, &due),
        due: Some(due),
    })
}

fn bucket_of(due: Option<NaiveDate>, today: NaiveDate) -> Bucket {
    match due {
        None => Bucket::NoDue,
        Some(d) if d < today => Bucket::Overdue,
        Some(d) if d == today => Bucket::Today,
        Some(_) => Bucket::Upcoming,
    }
}

/// The URL tsunagiai writes into a task's description to point at a thread. The account must be one of `accounts`, the registered ones.
fn gmail_url(accounts: &[String], account: &str, thread_id: &str) -> Result<String, String> {
    if !accounts.iter().any(|a| a == account) {
        return Err("登録されていないアカウントです".into());
    }
    valid_id(thread_id, "スレッド ID")?;
    Ok(format!("{GMAIL_URL}{account}/#all/{thread_id}"))
}

/// The thread a description links to with a URL `gmail_url` made; links of any other form are not tsunagiai's.
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

/// `…/projects/{id}` (plus `/{action}`). The ID comes from the frontend; Todoist's are alphanumeric, so anything else is refused.
fn project_api_url(id: &str, action: Option<&str>) -> Result<String, String> {
    valid_id(id, "プロジェクト ID")?;
    Ok(match action {
        Some(action) => format!("/projects/{id}/{action}"),
        None => format!("/projects/{id}"),
    })
}

/// The URL and body that move task `id` under `parent_id`, as its last subtask. Both IDs come from the frontend, and a task cannot be its own parent.
fn move_under_request(id: &str, parent_id: &str) -> Result<(String, Value), String> {
    let url = task_api_url(id, Some("move"))?;
    task_api_url(parent_id, None)?;
    if id == parent_id {
        return Err("タスクを自分自身のサブタスクにはできません".into());
    }
    Ok((url, json!({ "parent_id": parent_id })))
}

/// The digits of Todoist's `order_key`, a fractional index (the scheme of the `fractional-indexing` library) in base 62: in order, so that keys sort as text.
const KEY_DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/// The smallest key there is; nothing sorts before it.
const SMALLEST_KEY: &str = "A00000000000000000000000000";
const KEY_UNREADABLE: &str = "並び順を読めません。読み込み直してください";

fn key_digit(c: u8) -> usize {
    KEY_DIGITS.iter().position(|d| *d == c).unwrap_or(0)
}

/// How many characters the integer part of a key takes, by its first character: `a` to `z` give 2 to 27, `A` to `Z` give 27 to 2.
fn key_integer_length(head: u8) -> Option<usize> {
    match head {
        b'a'..=b'z' => Some(usize::from(head - b'a') + 2),
        b'A'..=b'Z' => Some(usize::from(b'Z' - head) + 2),
        _ => None,
    }
}

/// Splits a key into its integer part and its fraction (which does not end in `0`), and refuses text that is no key.
fn split_key(key: &str) -> Result<(&str, &str), String> {
    let integer = key
        .bytes()
        .next()
        .and_then(key_integer_length)
        .filter(|n| *n <= key.len());
    match integer {
        Some(n)
            if key != SMALLEST_KEY
                && key.bytes().all(|c| KEY_DIGITS.contains(&c))
                && !key[n..].ends_with('0') =>
        {
            Ok(key.split_at(n))
        }
        _ => Err(KEY_UNREADABLE.to_owned()),
    }
}

/// The integer that sorts right after the integer `x`, or `None` after the last one.
fn key_increment(x: &str) -> Option<String> {
    let (head, digits) = x.split_at(1);
    let mut head = head.as_bytes()[0];
    let mut digits = digits.as_bytes().to_vec();
    let mut carry = true;
    for d in digits.iter_mut().rev() {
        let next = key_digit(*d) + 1;
        if next == KEY_DIGITS.len() {
            *d = KEY_DIGITS[0];
        } else {
            *d = KEY_DIGITS[next];
            carry = false;
            break;
        }
    }
    if carry {
        match head {
            b'Z' => return Some("a0".to_owned()),
            b'z' => return None,
            _ => {}
        }
        head += 1;
        if head > b'a' {
            digits.push(KEY_DIGITS[0]);
        } else {
            digits.pop();
        }
    }
    Some(format!(
        "{}{}",
        char::from(head),
        String::from_utf8_lossy(&digits)
    ))
}

/// The integer that sorts right before the integer `x`, or `None` before the first one.
fn key_decrement(x: &str) -> Option<String> {
    let (head, digits) = x.split_at(1);
    let mut head = head.as_bytes()[0];
    let mut digits = digits.as_bytes().to_vec();
    let last = KEY_DIGITS[KEY_DIGITS.len() - 1];
    let mut carry = true;
    for d in digits.iter_mut().rev() {
        match key_digit(*d) {
            0 => *d = last,
            n => {
                *d = KEY_DIGITS[n - 1];
                carry = false;
                break;
            }
        }
    }
    if carry {
        match head {
            b'a' => return Some(format!("Z{}", char::from(last))),
            b'A' => return None,
            _ => {}
        }
        head -= 1;
        if head < b'Z' {
            digits.push(last);
        } else {
            digits.pop();
        }
    }
    Some(format!(
        "{}{}",
        char::from(head),
        String::from_utf8_lossy(&digits)
    ))
}

/// A fraction between the fractions `a` and `b` (`None`: no upper bound), where `a` sorts before `b` and neither ends in `0`.
fn key_midpoint(a: &str, b: Option<&str>) -> String {
    if let Some(b) = b {
        // The digits they share stay; a missing digit of `a` counts as 0.
        let shared = b
            .bytes()
            .enumerate()
            .take_while(|(i, c)| a.as_bytes().get(*i).copied().unwrap_or(KEY_DIGITS[0]) == *c)
            .count();
        if shared > 0 {
            let rest = key_midpoint(a.get(shared..).unwrap_or(""), Some(&b[shared..]));
            return format!("{}{rest}", &b[..shared]);
        }
    }
    let digit_a = a.bytes().next().map_or(0, key_digit);
    let digit_b = b
        .and_then(|b| b.bytes().next())
        .map_or(KEY_DIGITS.len(), key_digit);
    if digit_b > digit_a + 1 {
        return char::from(KEY_DIGITS[(digit_a + digit_b).div_ceil(2)]).to_string();
    }
    // The first digits are next to each other.
    match b {
        Some(b) if b.len() > 1 => b[..1].to_owned(),
        _ => format!(
            "{}{}",
            char::from(KEY_DIGITS[digit_a]),
            key_midpoint(a.get(1..).unwrap_or(""), None)
        ),
    }
}

/// A key that sorts between `a` and `b` (`None`: the start or the end of the list), by the rules of the `fractional-indexing` library, which Todoist's `order_key` follows.
fn generate_key_between(a: Option<&str>, b: Option<&str>) -> Result<String, String> {
    let parts_a = a.map(split_key).transpose()?;
    let parts_b = b.map(split_key).transpose()?;
    if a.zip(b).is_some_and(|(a, b)| a >= b) {
        return Err(KEY_UNREADABLE.to_owned());
    }
    match (parts_a, parts_b) {
        (None, None) => Ok("a0".to_owned()),
        (None, Some((ib, fb))) => {
            if ib == SMALLEST_KEY {
                return Ok(format!("{ib}{}", key_midpoint("", Some(fb))));
            }
            if !fb.is_empty() {
                return Ok(ib.to_owned());
            }
            key_decrement(ib).ok_or_else(|| KEY_UNREADABLE.to_owned())
        }
        (Some((ia, fa)), None) => {
            Ok(key_increment(ia).unwrap_or_else(|| format!("{ia}{}", key_midpoint(fa, None))))
        }
        (Some((ia, fa)), Some((ib, fb))) => {
            if ia == ib {
                return Ok(format!("{ia}{}", key_midpoint(fa, Some(fb))));
            }
            let next = key_increment(ia).ok_or_else(|| KEY_UNREADABLE.to_owned())?;
            if b.is_some_and(|b| next.as_str() < b) {
                return Ok(next);
            }
            Ok(format!("{ia}{}", key_midpoint(fa, None)))
        }
    }
}

/// What `todoist_place` sends for a task (T-2).
#[derive(Debug, PartialEq)]
struct Placement {
    /// The body of `POST /tasks/{id}/move`: the new parent, or the project when the task goes to the top; `None` when the task is there already.
    move_body: Option<Value>,
    /// The key that puts the task before its sibling `before_id` (last when there is none), between the keys of its new neighbours.
    order_key: String,
}

/// Works out the move and the key that put task `id` under `parent_id`, or at the top of `project_id` when there is no parent, before the sibling `before_id` (the last one when `None`).
/// The values come from the frontend and `tasks` is the last sync's: a task cannot go under itself or under one of its own subtasks, and the neighbours must have keys.
fn place_task(
    tasks: &[ApiTask],
    id: &str,
    parent_id: Option<&str>,
    project_id: Option<&str>,
    before_id: Option<&str>,
) -> Result<Placement, String> {
    valid_id(id, "タスク ID")?;
    if let Some(parent_id) = parent_id {
        valid_id(parent_id, "タスク ID")?;
    }
    if let Some(project_id) = project_id {
        valid_id(project_id, "プロジェクト ID")?;
    }
    if let Some(before_id) = before_id {
        valid_id(before_id, "タスク ID")?;
    }
    let not_found = || "タスクが見つかりません。読み込み直してください".to_owned();
    let find = |id: &str| tasks.iter().find(|t| t.id == id);
    let task = find(id).ok_or_else(not_found)?;
    if let Some(parent_id) = parent_id {
        find(parent_id).ok_or_else(not_found)?;
        if parent_id == id {
            return Err("タスクを自分自身のサブタスクにはできません".into());
        }
        // Up the parents of the new parent; the bound keeps a loop in the data from hanging the walk.
        let mut above = Some(parent_id);
        for _ in 0..=tasks.len() {
            let Some(at) = above else { break };
            if at == id {
                return Err("タスクを自分のサブタスクの下には入れられません".into());
            }
            above = find(at).and_then(|t| t.parent_id.as_deref());
        }
    }
    let project = match parent_id {
        Some(_) => None,
        None => Some(project_id.ok_or("プロジェクトを指定してください")?),
    };
    if before_id == Some(id) {
        return Err("タスクを自分自身の前には置けません".into());
    }
    let mut siblings: Vec<&ApiTask> = tasks
        .iter()
        .filter(|t| t.id != id)
        .filter(|t| match project {
            None => t.parent_id.as_deref() == parent_id,
            // The top level of a project: its tasks outside sections.
            Some(project) => {
                t.parent_id.is_none() && t.section_id.is_none() && t.project_id == project
            }
        })
        .collect();
    siblings.sort_by_key(|t| t.child_order);
    let at = match before_id {
        Some(before_id) => siblings
            .iter()
            .position(|t| t.id == before_id)
            .ok_or("並べる位置のタスクが、移動先にありません")?,
        None => siblings.len(),
    };
    fn key_of<'a>(t: &&'a ApiTask) -> Result<&'a str, String> {
        t.order_key
            .as_deref()
            .ok_or_else(|| KEY_UNREADABLE.to_owned())
    }
    let before = at.checked_sub(1).and_then(|i| siblings.get(i));
    let after = siblings.get(at);
    let order_key = generate_key_between(
        before.map(key_of).transpose()?,
        after.map(key_of).transpose()?,
    )?;
    let moved = match project {
        None => task.parent_id.as_deref() != parent_id,
        Some(project) => {
            task.parent_id.is_some() || task.section_id.is_some() || task.project_id != project
        }
    };
    let move_body = moved.then(|| match (parent_id, project) {
        (Some(parent_id), _) => json!({ "parent_id": parent_id }),
        (None, project) => json!({ "project_id": project }),
    });
    Ok(Placement {
        move_body,
        order_key,
    })
}

/// The `commands` of the Sync API that give task `id` the order key `order_key` (`item_update`; the documentation names it the way to reorder a task, and its reorder by `child_order` is deprecated).
fn task_order_commands(id: &str, order_key: &str, uuid: &str) -> Result<String, String> {
    valid_id(id, "タスク ID")?;
    Ok(json!([{
        "type": "item_update",
        "uuid": uuid,
        "args": { "id": id, "order_key": order_key },
    }])
    .to_string())
}

/// The `commands` of the Sync API that move project `id` under `parent_id`, as its last sub-project, or to the top when `None` (T-8; `project_move`). Both IDs come from the frontend, and a project cannot be its own parent.
fn project_move_commands(id: &str, parent_id: Option<&str>, uuid: &str) -> Result<String, String> {
    valid_id(id, "プロジェクト ID")?;
    if let Some(parent_id) = parent_id {
        valid_id(parent_id, "プロジェクト ID")?;
        if id == parent_id {
            return Err("プロジェクトを自分自身のサブプロジェクトにはできません".into());
        }
    }
    Ok(json!([{
        "type": "project_move",
        "uuid": uuid,
        "args": { "id": id, "parent_id": parent_id },
    }])
    .to_string())
}

/// A version 4 UUID in text from 16 random bytes: the Sync API names a command by it and answers under it.
fn uuid_v4(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// Reads the result of the command `uuid` in a Sync API answer: `"ok"` is a success, and an error object is Todoist's refusal, worded with its message and its explanation.
fn check_sync_status(text: &str, uuid: &str) -> Result<(), String> {
    let answer: Value =
        serde_json::from_str(text).map_err(|e| format!("Todoist の応答を読めません: {e}"))?;
    match &answer["sync_status"][uuid] {
        Value::String(status) if status == "ok" => Ok(()),
        Value::Object(error) => {
            let message = error
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("理由が不明です");
            let explanation = error
                .get("error_extra")
                .and_then(|extra| extra.get("explanation"))
                .and_then(Value::as_str);
            Err(match explanation {
                Some(explanation) => format!("Todoist が拒否しました: {message} ({explanation})"),
                None => format!("Todoist が拒否しました: {message}"),
            })
        }
        _ => Err("Todoist の応答にコマンドの結果がありません".into()),
    }
}

fn task_web_url(id: &str) -> Result<String, String> {
    valid_id(id, "タスク ID")?;
    Ok(format!("{WEB_TASK_URL}/{id}"))
}

/// The body of a task update holding only the fields given; an empty `due_string` clears the due date, and an empty `labels` removes every label.
fn update_body(
    content: Option<&str>,
    description: Option<&str>,
    due_string: Option<&str>,
    labels: Option<&[String]>,
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
    if let Some(l) = labels {
        body.insert("labels".into(), l.into());
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
pub(crate) fn is_plain_due(due: &str) -> bool {
    match due.len() {
        10 => NaiveDate::parse_from_str(due, "%Y-%m-%d").is_ok(),
        16 => NaiveDateTime::parse_from_str(due, "%Y-%m-%d %H:%M").is_ok(),
        _ => false,
    }
}

/// The summary with its `due` kept only when it is a plain date or date and time: the model's words must not reach Todoist's date parser.
fn with_plain_due(mut summary: Summary) -> Summary {
    summary.due = summary.due.filter(|d| is_plain_due(d));
    summary
}

/// The body of `POST /tasks` for a task made from a Slack message, from what the user confirmed. The name is cut at Todoist's limit and must not be empty.
/// `due` is the user's own text for Todoist to read; when it is empty the task is due today if `today`.
fn slack_task_body(
    content: &str,
    description: &str,
    slack_url: &str,
    due: &str,
    project_id: Option<&str>,
    today: bool,
) -> Result<Value, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("タスクの名前が空です".into());
    }
    let description = [description.trim(), slack_url]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut body = json!({
        "content": content.chars().take(CONTENT_LIMIT).collect::<String>(),
        "description": description,
    });
    let due = due.trim();
    if let Some(due) = Some(due)
        .filter(|d| !d.is_empty())
        .or(today.then_some("today"))
    {
        body["due_string"] = due.into();
    }
    if let Some(id) = project_id {
        body["project_id"] = id.into();
    }
    Ok(body)
}

/// The body of `POST /tasks` for a task the user confirmed from a proposal of Claude (the Todo pane): its name, its date and its project, exactly as given.
/// The name goes to `content`, which Todoist does not read for dates (Quick Add would), and the date to `due_string` only in the plain forms of `is_plain_due`.
/// A blank date or project means none. A name past `CONTENT_LIMIT` characters, a date of another form and a project not in `projects` are refused, not cut or dropped.
fn proposal_task_body(
    content: &str,
    due: Option<&str>,
    project_id: Option<&str>,
    projects: &[(String, String)],
) -> Result<Value, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("タスクの名前を入力してください".into());
    }
    if content.chars().count() > CONTENT_LIMIT {
        return Err(format!(
            "タスクの名前が長すぎます（{CONTENT_LIMIT} 文字まで）"
        ));
    }
    let mut body = json!({ "content": content });
    if let Some(due) = due.map(str::trim).filter(|d| !d.is_empty()) {
        if !is_plain_due(due) {
            return Err("日付は YYYY-MM-DD か YYYY-MM-DD HH:MM の形で指定してください".into());
        }
        body["due_string"] = due.into();
    }
    if let Some(project) = project_id.map(str::trim).filter(|p| !p.is_empty()) {
        let id = claude::known_project(Some(project.to_owned()), projects)
            .ok_or("プロジェクトが見つかりません")?;
        body["project_id"] = id.into();
    }
    Ok(body)
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

/// The labels to pick from: the personal ones by `item_order`, then the names found on active tasks that are not among them, by name.
/// Todoist's sync answer leaves out shared labels, which show only in a task's `labels`; they are drawn in `charcoal`, as is a personal label with an unknown color.
fn label_items(mut personal: Vec<ApiLabel>, tasks: &[ApiTask]) -> Vec<LabelItem> {
    personal.sort_by_key(|l| l.item_order);
    let known: HashSet<String> = personal.iter().map(|l| l.name.clone()).collect();
    let mut out: Vec<LabelItem> = personal
        .into_iter()
        .map(|l| LabelItem {
            color: color_hex(&l.color).to_owned(),
            name: l.name,
        })
        .collect();
    let mut shared: Vec<&str> = tasks
        .iter()
        .flat_map(|t| t.labels.iter().map(String::as_str))
        .filter(|n| !known.contains(*n))
        .collect();
    shared.sort_unstable();
    shared.dedup();
    out.extend(shared.into_iter().map(|name| LabelItem {
        name: name.to_owned(),
        color: color_hex("charcoal").to_owned(),
    }));
    out
}

/// Top-level active tasks, then every active subtask whose parent is active, with their subtasks and counts. A subtask is a row of its
/// own (with `parent` set), so a list can nest it and its detail can open. `completed` are the recently completed tasks: those under an
/// active task count as its done subtasks. Dates are judged in `tz`.
fn build_todo<Tz: TimeZone>(
    projects: Vec<ApiProject>,
    labels: Vec<ApiLabel>,
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
            due_at: due.as_ref().and_then(|d| due_at(tz, d)),
            sub_done: subtasks.iter().filter(|s| s.done).count(),
            sub_total: subtasks.len(),
            subtasks,
            mail: mail_of(&t.description),
            due,
            parent,
            url: task_web_url(&t.id).unwrap_or_default(),
            labels: t.labels.clone(),
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
        labels: label_items(labels, &tasks),
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
    /// The projects (ID and name, in tree order) of the last load, so a summary reads them without waiting for `sync`. Empty until a load.
    projects: Mutex<Arc<Vec<(String, String)>>>,
    /// What the Sync API has told so far. A load holds the lock from its request to its end, so two loads never share a `sync_token`.
    /// Taken before `token`, and never while `token` is held.
    sync: tokio::sync::Mutex<SyncData>,
    /// The last saved or read cache, so an offline spell reads the file once. Touched only while `token` is locked, in order with a save and a disconnect.
    cache: Mutex<Option<CacheFile>>,
}

impl TodoistState {
    /// The projects (ID and name, in tree order) of the last load; empty until one.
    pub(crate) fn projects(&self) -> Arc<Vec<(String, String)>> {
        Arc::clone(&self.projects.lock().unwrap())
    }

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
    let m = migration(
        keychain::read(TOKEN_SERVICE, TOKEN_USER)?,
        keychain::read(KEYRING_SERVICE, TOKEN_USER)?,
    );
    if let (true, Some(token)) = (m.copy, &m.token) {
        keychain::write(TOKEN_SERVICE, TOKEN_USER, token)?;
    }
    if m.delete_old {
        keychain::delete(KEYRING_SERVICE, TOKEN_USER)?;
    }
    Ok(m.token)
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
    path: &str,
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

/// Sends one request with `token` and reads the answer as JSON, logging a failure. `Ok(None)` means Todoist rejected the token.
async fn send_json(
    http: &reqwest::Client,
    token: &str,
    command: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>, String> {
    let sent = send(http, method, token, path, &[], body.as_ref())
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let Some(text) = sent else {
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
    let sent = send_json(auth.http(), &token, command, method, path, body).await?;
    if sent.is_none() {
        state.forget_token().await;
    }
    Ok(sent)
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
            return offline_todo(cached, reason, Local::now().date_naive(), &Local).map(Some);
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
    *state.projects.lock().unwrap() = Arc::new(
        order_projects(sync.projects.clone())
            .into_iter()
            .map(|(p, _)| (p.id, p.name))
            .collect(),
    );
    let todo = build_todo(
        sync.projects.clone(),
        sync.labels.clone(),
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
        rebucket(&mut todo, Local::now().date_naive(), &Local);
        todo
    }))
}

/// Whether a token is stored. Asks Todoist nothing, so a settings screen can show it at once.
#[tauri::command]
pub async fn todoist_connected(state: State<'_, TodoistState>) -> Result<bool, String> {
    let token = state
        .token()
        .await
        .map_err(|e| log_failure("todoist_connected", TOKEN_USER, e))?;
    Ok(token.is_some())
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
    tokio::task::spawn_blocking(move || keychain::write(TOKEN_SERVICE, TOKEN_USER, &stored))
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
            keychain::delete(TOKEN_SERVICE, TOKEN_USER),
            keychain::delete(KEYRING_SERVICE, TOKEN_USER),
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
    *state.projects.lock().unwrap() = Arc::default();
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
    let body = update_body(None, None, Some("today"), None)
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
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

/// Reads the Slack message `url` points at with its whole thread and has Claude summarise it into a task's name, description, due date and the project that fits it; nothing is created.
/// `None` means a token is needed and nothing was read. The thread's messages (a long one in several calls) and the names of the projects are sent to Anthropic through Claude Code.
#[tauri::command]
pub async fn todoist_summarize_slack(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    slack_state: State<'_, slack::SlackState>,
    url: String,
) -> Result<Option<Summary>, String> {
    let command = "todoist_summarize_slack";
    // Without a Todoist token, nothing is read from Slack and nothing is sent to Claude.
    if state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
        .is_none()
    {
        return Ok(None);
    }
    let dir = config_dir(&app).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let thread = slack::message_context(&dir, auth.http(), &slack_state, url.trim())
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    // The projects of the last load, in tree order (empty before one; the `sync` lock is not waited for): Claude names the one that fits, and only a project of this list is kept.
    let projects = Arc::clone(&state.projects.lock().unwrap());
    let summary = claude::summarize(&dir, &thread, &projects)
        .await
        .map_err(|e| {
            log_failure(command, TOKEN_USER, e.log);
            e.screen
        })?;
    Ok(Some(with_plain_due(summary)))
}

/// Adds the task the user confirmed after `todoist_summarize_slack`: `content` is its name, `description` its text, and the message's URL is put at the end of that text.
/// It goes to `project_id` (the inbox for `None`); `due` is Todoist's date text, and when it is empty a task is due today if `today`.
/// Returns the task's name; `None` means a token is needed and nothing was created.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn todoist_add_from_slack(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    url: String,
    content: String,
    description: String,
    due: String,
    project_id: Option<String>,
    today: bool,
) -> Result<Option<String>, String> {
    let command = "todoist_add_from_slack";
    if let Some(id) = &project_id {
        valid_id(id, "プロジェクト ID").map_err(|e| log_failure(command, TOKEN_USER, e))?;
    }
    let url = url.trim();
    slack::check_message_url(url).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body = slack_task_body(
        &content,
        &description,
        url,
        &due,
        project_id.as_deref(),
        today,
    )
    .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let created = request(&auth, &state, command, Method::POST, "/tasks", Some(body)).await?;
    Ok(created.map(|_| content.trim().to_owned()))
}

/// Creates one task from values that were confirmed, with `token`: `content` is its name, `due` its date (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, none for no date)
/// and `project_id` the ID of one of `projects` (none for the inbox). Unlike `todoist_add`, nothing in the name is read as a date. The values are checked first (`proposal_task_body`), and a refusal is logged and returned.
/// `Ok(None)` means Todoist rejected the token and nothing was created. The command `todoist_add_task` and the tool of `tsunagiai-mcp` (`add_now`) both create a task here.
async fn add_task(
    http: &reqwest::Client,
    token: &str,
    command: &str,
    content: &str,
    due: Option<&str>,
    project_id: Option<&str>,
    projects: &[(String, String)],
) -> Result<Option<bool>, String> {
    let body = proposal_task_body(content, due, project_id, projects)
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let created = send_json(http, token, command, Method::POST, "/tasks", Some(body)).await?;
    Ok(created.map(|_| true))
}

/// Adds one task from values that were confirmed: `content` is its name, `due` its date (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, none for no date)
/// and `project_id` the ID of a project of the last load (none for the inbox). Unlike `todoist_add`, nothing in the name is read as a date.
/// `None` means a token is needed and nothing was created; the screen reloads the list afterwards, as for any change.
#[tauri::command]
pub async fn todoist_add_task(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    content: String,
    due: Option<String>,
    project_id: Option<String>,
) -> Result<Option<bool>, String> {
    let command = "todoist_add_task";
    let Some(token) = state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
    else {
        return Ok(None);
    };
    let created = add_task(
        auth.http(),
        &token,
        command,
        &content,
        due.as_deref(),
        project_id.as_deref(),
        &state.projects(),
    )
    .await?;
    if created.is_none() {
        state.forget_token().await;
    }
    Ok(created)
}

/// The token in the keychain, read off the async threads, for a caller that holds no `TodoistState` (`tsunagiai-mcp`): the entry the app writes. `None` means not connected.
async fn stored_token(command: &str) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(read_token)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| log_failure(command, TOKEN_USER, e))
}

/// The projects and the tasks as Todoist has them now: one full sync with `token`, kept nowhere. `None` means Todoist rejected the token.
async fn read_with(
    http: &reqwest::Client,
    token: &str,
    command: &str,
) -> Result<Option<Todo>, String> {
    let res = match fetch_sync(http, token, None).await {
        Ok(res) => res,
        Err(e) if rejected(&e) => return Ok(None),
        Err(e) => return Err(log_failure(command, TOKEN_USER, e)),
    };
    let mut sync = SyncData::default();
    apply_sync(&mut sync, &mut Vec::new(), res);
    Ok(Some(build_todo(
        sync.projects,
        sync.labels,
        sync.tasks,
        &[],
        Local::now().date_naive(),
        &Local,
    )))
}

/// Reads the projects and the tasks for a caller that holds no `TodoistState` (`tsunagiai-mcp`), with the token of the keychain. `None` means a token is needed: none is stored, or Todoist rejected it.
pub async fn read_now(http: &reqwest::Client) -> Result<Option<Todo>, String> {
    let command = "todoist_read";
    let Some(token) = stored_token(command).await? else {
        return Ok(None);
    };
    read_with(http, &token, command).await
}

/// The projects (ID and name, in tree order) of `todo`: what the app's command checks a task's project against (the last load).
fn listed_projects(todo: &Todo) -> Vec<(String, String)> {
    todo.projects
        .iter()
        .map(|p| (p.id.clone(), p.name.clone()))
        .collect()
}

/// Adds one task for a caller that holds no `TodoistState` (`tsunagiai-mcp`), with the token of the keychain, checking the values as `todoist_add_task` does.
/// The projects are those Todoist has now, read only when a project is named. `None` means a token is needed and nothing was created.
pub async fn add_now(
    http: &reqwest::Client,
    content: &str,
    due: Option<&str>,
    project_id: Option<&str>,
) -> Result<Option<bool>, String> {
    let command = "todoist_add_task";
    let Some(token) = stored_token(command).await? else {
        return Ok(None);
    };
    let named = project_id.is_some_and(|p| !p.trim().is_empty());
    let projects = if named {
        match read_with(http, &token, command).await? {
            Some(todo) => listed_projects(&todo),
            None => return Ok(None),
        }
    } else {
        Vec::new()
    };
    add_task(http, &token, command, content, due, project_id, &projects).await
}

/// The projects of `todo` as `todoist_projects` of `tsunagiai-mcp` answers them, in tree order: `id`, `name`, `color`, `inbox`, `parentId` and `depth`.
pub fn projects_answer(todo: &Todo) -> Value {
    json!(todo.projects)
}

/// The active tasks of `todo` as `todoist_tasks` of `tsunagiai-mcp` answers them, by due date with no date last: `id`, `content`, `description`, `projectId`, `parentId` (a subtask is a row of its own; `null` for a task),
/// `priority` (as the Todoist apps number it: 1 is the most urgent, 4 the natural one), `due` (`date`, `time`, `string`, `recurring`, or `null`) and `labels`.
pub fn tasks_answer(todo: &Todo) -> Value {
    Value::Array(
        todo.tasks
            .iter()
            .map(|t| {
                json!({
                    "id": t.id,
                    "content": t.content,
                    "description": t.description,
                    "projectId": t.project_id,
                    "parentId": t.parent.as_ref().map(|p| &p.id),
                    "priority": t.priority,
                    "due": t.due,
                    "labels": t.labels,
                })
            })
            .collect(),
    )
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

/// Changes the fields given; an empty `due_string` clears the due date, and `labels` is the task's whole list of label names (empty removes them all).
#[tauri::command]
pub async fn todoist_update(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
    content: Option<String>,
    description: Option<String>,
    due_string: Option<String>,
    labels: Option<Vec<String>>,
) -> Result<Option<bool>, String> {
    let command = "todoist_update";
    let url = task_api_url(&id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body = update_body(
        content.as_deref(),
        description.as_deref(),
        due_string.as_deref(),
        labels.as_deref(),
    )
    .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(&auth, &state, command, Method::POST, &url, Some(body)).await?;
    Ok(done.map(|_| true))
}

/// The due a text makes on the task, which the screen puts on it at once while `todoist_update` is on its way: the text a day picked in the calendar writes (`YYYY-MM-DD`, with ` HH:MM`), or an empty one. `None` for other text, which Todoist reads.
/// Asks Todoist nothing.
#[tauri::command]
pub async fn todoist_picked_due(text: String) -> Option<PickedDue> {
    picked_due(&text, Local::now().date_naive(), &Local)
}

/// Todoist refuses a label name longer than this many characters (`POST /api/v1/labels`).
const LABEL_LIMIT: usize = 128;

/// The name of a new label, trimmed; refused when empty or longer than Todoist takes.
fn label_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("ラベルの名前を入力してください".into());
    }
    if name.chars().count() > LABEL_LIMIT {
        return Err(format!("ラベルの名前は {LABEL_LIMIT} 文字までです"));
    }
    Ok(name)
}

/// Creates the personal label `name`, then sets the task's labels to `labels` (its whole list, the new name in it).
/// The label stays created when the update fails; the screen's reload shows what Todoist has.
#[tauri::command]
pub async fn todoist_create_label(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
    name: String,
    labels: Vec<String>,
) -> Result<Option<bool>, String> {
    let command = "todoist_create_label";
    let url = task_api_url(&id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let name = label_name(&name).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body = update_body(None, None, None, Some(&labels))
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let created = request(
        &auth,
        &state,
        command,
        Method::POST,
        "/labels",
        Some(json!({ "name": name })),
    )
    .await?;
    if created.is_none() {
        return Ok(None);
    }
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

/// Moves a task under another task, as that task's last subtask. Todoist refuses a parent that is below the task, or a tree that would be too deep.
#[tauri::command]
pub async fn todoist_move_under(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
    parent_id: String,
) -> Result<Option<bool>, String> {
    let command = "todoist_move_under";
    let (url, body) =
        move_under_request(&id, &parent_id).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(&auth, &state, command, Method::POST, &url, Some(body)).await?;
    Ok(done.map(|_| true))
}

/// Puts a task in its place among its siblings (T-2): under `parent_id`, or at the top of `project_id` when there is no parent, before the sibling `before_id` (the last one when there is none).
/// It sends `POST /tasks/{id}/move` unless the task is under that parent (or at that top) already, and then the key that puts it there (`item_update` of the Sync API).
/// The siblings are those of the last load; the screen draws the place from the same load. A failure after the move leaves the task last: the reload shows it.
#[tauri::command]
pub async fn todoist_place(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
    parent_id: Option<String>,
    project_id: Option<String>,
    before_id: Option<String>,
) -> Result<Option<bool>, String> {
    let command = "todoist_place";
    let Some(token) = state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
    else {
        return Ok(None);
    };
    let placement = {
        let sync = state.sync.lock().await;
        // The tasks of another account are no tasks of this one.
        let tasks: &[ApiTask] = if sync.owner.as_deref() == Some(token.as_str()) {
            &sync.tasks
        } else {
            &[]
        };
        place_task(
            tasks,
            &id,
            parent_id.as_deref(),
            project_id.as_deref(),
            before_id.as_deref(),
        )
    }
    .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    if let Some(body) = placement.move_body {
        let url =
            task_api_url(&id, Some("move")).map_err(|e| log_failure(command, TOKEN_USER, e))?;
        if request(&auth, &state, command, Method::POST, &url, Some(body))
            .await?
            .is_none()
        {
            return Ok(None);
        }
    }
    sync_command(&auth, &state, command, |uuid| {
        task_order_commands(&id, &placement.order_key, uuid)
    })
    .await
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

/// Archives a project (T-8; `POST /projects/{id}/archive`). Todoist keeps its tasks, and its sub-projects go with it; the next sync drops them from the list.
#[tauri::command]
pub async fn todoist_archive_project(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
) -> Result<Option<bool>, String> {
    let command = "todoist_archive_project";
    let url =
        project_api_url(&id, Some("archive")).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(&auth, &state, command, Method::POST, &url, None).await?;
    Ok(done.map(|_| true))
}

/// Deletes a project for good with its sections and tasks (T-8; `DELETE /projects/{id}`); Todoist cannot undo it, so the screen asks first.
#[tauri::command]
pub async fn todoist_delete_project(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
) -> Result<Option<bool>, String> {
    let command = "todoist_delete_project";
    let url = project_api_url(&id, None).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let done = request(&auth, &state, command, Method::DELETE, &url, None).await?;
    Ok(done.map(|_| true))
}

/// Moves a project under another project, as its last sub-project, or to the top when `parent_id` is `None` (T-8). Todoist refuses a parent that is below the project, or a tree that would be too deep; its refusal is the error.
#[tauri::command]
pub async fn todoist_move_project(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    id: String,
    parent_id: Option<String>,
) -> Result<Option<bool>, String> {
    let command = "todoist_move_project";
    sync_command(&auth, &state, command, |uuid| {
        project_move_commands(&id, parent_id.as_deref(), uuid)
    })
    .await
}

/// Sends one command of the Sync API, written by `build` from the UUID that names it, and reads its status. `Ok(None)` means a token is needed.
async fn sync_command(
    auth: &Auth,
    state: &TodoistState,
    command: &str,
    build: impl FnOnce(&str) -> Result<String, String>,
) -> Result<Option<bool>, String> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|e| log_failure(command, TOKEN_USER, e.to_string()))?;
    let uuid = uuid_v4(random);
    let commands = build(&uuid).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let Some(token) = state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
    else {
        return Ok(None);
    };
    // The Sync API reads a form, and `commands` is JSON text inside it.
    let res = auth
        .http()
        .post(format!("{API_URL}/sync"))
        .bearer_auth(&token)
        .form(&[("commands", commands)])
        .send()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e.to_string()))?;
    let sent = answer(res)
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let Some(text) = sent else {
        state.forget_token().await;
        return Ok(None);
    };
    check_sync_status(&text, &uuid).map_err(|e| log_failure(command, TOKEN_USER, e))?;
    Ok(Some(true))
}

/// A task's comments are read up to this many pages (200 each), and so are a project's collaborators.
// shortcut: past these the rest is dropped, upgrade if a task ever collects that many comments.
const MAX_COMMENT_PAGES: usize = 5;
/// Todoist refuses a comment longer than this many characters.
const COMMENT_LIMIT: usize = 15000;
/// What the author is called when Todoist's lists do not name them.
const UNKNOWN_AUTHOR: &str = "不明";
/// What a file is called when Todoist names neither the file nor its address.
const UNNAMED_FILE: &str = "添付ファイル";
/// The header of `todoist_upload` that carries the file's name, percent-encoded: the body is the file's bytes alone.
const FILE_NAME_HEADER: &str = "x-file-name";
/// The upload may carry a big file over a slow line; the shared client's 30 seconds would cut it.
const UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Deserialize)]
struct ApiComment {
    id: String,
    posted_uid: Option<String>,
    #[serde(default)]
    content: String,
    /// An object with `file_name`, `file_url` and more, or null.
    file_attachment: Option<Value>,
    #[serde(default)]
    is_deleted: bool,
    /// RFC 3339.
    posted_at: Option<String>,
}

/// `GET /user`: the user the token belongs to.
#[derive(Deserialize)]
struct ApiUser {
    id: String,
    #[serde(default)]
    full_name: String,
}

#[derive(Deserialize)]
struct ApiCollaborator {
    id: String,
    #[serde(default)]
    name: String,
}

/// When a comment was posted, in local time.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Posted {
    /// `YYYY-MM-DD`.
    date: String,
    /// `HH:MM`.
    time: Option<String>,
}

/// The file of a comment.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct CommentFile {
    file_name: String,
    /// Only an `https://` address: anything else is dropped, and the name is shown without a link.
    file_url: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Comment {
    id: String,
    /// The author's name, or "不明".
    author: String,
    posted: Option<Posted>,
    content: String,
    attachment: Option<CommentFile>,
}

/// The file a comment carries; `None` when Todoist names neither its file nor its address.
fn file_of(attachment: &Value) -> Option<CommentFile> {
    let text = |key: &str| {
        attachment
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
    };
    let (name, url) = (text("file_name"), text("file_url"));
    if name.is_none() && url.is_none() {
        return None;
    }
    Some(CommentFile {
        file_name: name.unwrap_or(UNNAMED_FILE).to_owned(),
        file_url: url.filter(|u| u.starts_with("https://")).map(str::to_owned),
    })
}

/// The comments that were not deleted, oldest first (one with no readable time comes first).
fn live_comments(comments: Vec<ApiComment>) -> Vec<ApiComment> {
    let mut live: Vec<ApiComment> = comments.into_iter().filter(|c| !c.is_deleted).collect();
    live.sort_by_key(|c| {
        c.posted_at
            .as_deref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
    });
    live
}

/// Whether the collaborators are needed to name the authors of `comments`: someone wrote one who is not the user (`me`, unknown when `None`).
fn needs_collaborators(comments: &[ApiComment], me: Option<&str>) -> bool {
    comments
        .iter()
        .any(|c| c.posted_uid.as_deref().is_some_and(|uid| Some(uid) != me))
}

/// Author names by user ID: the collaborators', then the user's own.
fn author_names(
    me: Option<ApiUser>,
    collaborators: Vec<ApiCollaborator>,
) -> HashMap<String, String> {
    let named = collaborators
        .into_iter()
        .map(|c| (c.id, c.name))
        .chain(me.map(|u| (u.id, u.full_name)));
    named.filter(|(_, name)| !name.trim().is_empty()).collect()
}

fn comment_of<Tz: TimeZone>(tz: &Tz, c: &ApiComment, names: &HashMap<String, String>) -> Comment {
    let posted = c
        .posted_at
        .as_deref()
        .and_then(|t| parse_due(tz, t))
        .map(|(date, time)| Posted {
            date: date.to_string(),
            time: time.map(|t| t.format("%H:%M").to_string()),
        });
    Comment {
        id: c.id.clone(),
        author: c
            .posted_uid
            .as_ref()
            .and_then(|uid| names.get(uid))
            .map_or(UNKNOWN_AUTHOR, String::as_str)
            .to_owned(),
        posted,
        content: c.content.clone(),
        attachment: c.file_attachment.as_ref().and_then(file_of),
    }
}

/// The body of `POST /comments`. Blank text with a file sends the file's name as the text, since Todoist wants at least one character.
fn comment_body(task_id: &str, content: &str, attachment: Option<&Value>) -> Result<Value, String> {
    if attachment.is_some_and(|a| !a.is_object()) {
        return Err("添付ファイルが不正です".into());
    }
    let content = match (content.trim(), attachment) {
        ("", None) => return Err("コメントを入力してください".into()),
        ("", Some(file)) => file
            .get("file_name")
            .and_then(Value::as_str)
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(UNNAMED_FILE),
        (text, _) => text,
    };
    if content.chars().count() > COMMENT_LIMIT {
        return Err(format!(
            "コメントは {COMMENT_LIMIT} 文字以内で入力してください"
        ));
    }
    let mut body = json!({ "task_id": task_id, "content": content });
    if let Some(file) = attachment {
        body["attachment"] = file.clone();
    }
    Ok(body)
}

/// The name and the bytes of an upload: the body must be the file's raw bytes, and the header its name, percent-encoded.
fn upload_parts<'a>(
    name: Option<&str>,
    body: &'a tauri::ipc::InvokeBody,
) -> Result<(String, &'a [u8]), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err("ファイルを読めません".into());
    };
    let name = name.map(crate::images::percent_decode).unwrap_or_default();
    let name = name.trim();
    if name.is_empty() {
        return Err("ファイル名がありません".into());
    }
    Ok((name.to_owned(), bytes))
}

/// A GET that answers one JSON object.
async fn get_json<T: DeserializeOwned>(
    http: &reqwest::Client,
    token: &str,
    path: &str,
) -> Result<T, ApiError> {
    let text = send(http, Method::GET, token, path, &[], None)
        .await?
        .ok_or_else(token_rejected)?;
    parse(&text)
}

/// The names of the people who wrote `comments`: the user's own (`GET /user`) and, only when someone else wrote one and the project is known,
/// the project's collaborators. A failure is logged and leaves those names out; the comments still show, their authors as "不明".
async fn comment_names(
    http: &reqwest::Client,
    token: &str,
    command: &str,
    comments: &[ApiComment],
    project_id: Option<&str>,
) -> HashMap<String, String> {
    let me = get_json::<ApiUser>(http, token, "/user")
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))
        .ok();
    let wanted = needs_collaborators(comments, me.as_ref().map(|u| u.id.as_str()));
    let collaborators = match project_id.filter(|_| wanted) {
        Some(id) => fetch_all::<ApiCollaborator>(
            http,
            token,
            &format!("/projects/{id}/collaborators"),
            Vec::new(),
            MAX_COMMENT_PAGES,
        )
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))
        .unwrap_or_default(),
        None => Vec::new(),
    };
    author_names(me, collaborators)
}

/// The comments of a task, oldest first, deleted ones left out. `project_id` is the task's project, whose collaborators name the authors.
/// `None` means a token is needed.
#[tauri::command]
pub async fn todoist_comments(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    task_id: String,
    project_id: String,
) -> Result<Option<Vec<Comment>>, String> {
    let command = "todoist_comments";
    valid_id(&task_id, "タスク ID").map_err(|e| log_failure(command, TOKEN_USER, e))?;
    valid_id(&project_id, "プロジェクト ID").map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let Some(token) = state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
    else {
        return Ok(None);
    };
    let fetched = fetch_all::<ApiComment>(
        auth.http(),
        &token,
        "/comments",
        vec![("task_id", task_id)],
        MAX_COMMENT_PAGES,
    )
    .await;
    let comments = match fetched {
        Ok(all) => live_comments(all),
        Err(e) if rejected(&e) => {
            state.forget_token().await;
            return Ok(None);
        }
        Err(e) => return Err(log_failure(command, TOKEN_USER, e)),
    };
    // Nothing to name: Todoist is not asked about the user or the project.
    if comments.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let names = comment_names(auth.http(), &token, command, &comments, Some(&project_id)).await;
    Ok(Some(
        comments
            .iter()
            .map(|c| comment_of(&Local, c, &names))
            .collect(),
    ))
}

/// Uploads the file the body holds (raw bytes; `x-file-name` is its name, percent-encoded) and answers Todoist's description of it, which `todoist_add_comment` takes as the attachment.
/// The name goes to Todoist as a field too, so that a Japanese name survives. `None` means a token is needed.
#[tauri::command]
pub async fn todoist_upload(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<Value>, String> {
    let command = "todoist_upload";
    let header = request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|v| v.to_str().ok());
    let (name, bytes) = upload_parts(header, request.body())
        .map(|(name, bytes)| (name, bytes.to_vec()))
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let Some(token) = state
        .token()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
    else {
        return Ok(None);
    };
    let form = reqwest::multipart::Form::new()
        .text("file_name", name.clone())
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes).file_name(name),
        );
    let res = auth
        .http()
        .post(format!("{API_URL}/uploads"))
        .bearer_auth(&token)
        .multipart(form)
        .timeout(UPLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e.to_string()))?;
    let Some(text) = answer(res)
        .await
        .map_err(|e| log_failure(command, TOKEN_USER, e))?
    else {
        state.forget_token().await;
        return Ok(None);
    };
    parse(&text)
        .map(Some)
        .map_err(|e| log_failure(command, TOKEN_USER, e))
}

/// Adds a comment to a task and answers it as the list shows it. `attachment` is what `todoist_upload` answered. `None` means a token is needed and nothing was added.
#[tauri::command]
pub async fn todoist_add_comment(
    auth: State<'_, Auth>,
    state: State<'_, TodoistState>,
    task_id: String,
    content: String,
    attachment: Option<Value>,
) -> Result<Option<Comment>, String> {
    let command = "todoist_add_comment";
    valid_id(&task_id, "タスク ID").map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let body = comment_body(&task_id, &content, attachment.as_ref())
        .map_err(|e| log_failure(command, TOKEN_USER, e))?;
    let Some(created) = request(
        &auth,
        &state,
        command,
        Method::POST,
        "/comments",
        Some(body),
    )
    .await?
    else {
        return Ok(None);
    };
    let created: ApiComment = serde_json::from_value(created).map_err(|e| {
        log_failure(
            command,
            TOKEN_USER,
            format!("Todoist の応答を読めません: {e}"),
        )
    })?;
    // The comment is the user's own, so only the user is looked up.
    let names = match state.token().await {
        Ok(Some(token)) => {
            comment_names(
                auth.http(),
                &token,
                command,
                std::slice::from_ref(&created),
                None,
            )
            .await
        }
        _ => HashMap::new(),
    };
    Ok(Some(comment_of(&Local, &created, &names)))
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

    #[test]
    fn the_token_service_has_an_old_one_to_move_from() {
        assert_eq!(
            keychain::old_service(TOKEN_SERVICE).as_deref(),
            Some("jp.mysis.cookapps.todoist")
        );
    }

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
        build_todo(
            vec![],
            vec![],
            tasks,
            &completed,
            date("2026-10-29"),
            &jst(),
        )
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

    /// A zone with a gap: on 2026-03-29 the local clock jumps from 02:00 to 03:00, as a daylight saving change does.
    #[derive(Clone, Copy, Debug)]
    struct Spring;

    #[derive(Clone, Copy, Debug)]
    struct SpringOffset(i32);

    impl std::fmt::Display for SpringOffset {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{}", self.0)
        }
    }

    impl chrono::Offset for SpringOffset {
        fn fix(&self) -> FixedOffset {
            FixedOffset::east_opt(self.0).unwrap()
        }
    }

    impl TimeZone for Spring {
        type Offset = SpringOffset;

        fn from_offset(_: &SpringOffset) -> Spring {
            Spring
        }

        fn offset_from_local_date(&self, d: &NaiveDate) -> chrono::LocalResult<SpringOffset> {
            self.offset_from_local_datetime(&d.and_time(NaiveTime::MIN))
        }

        fn offset_from_local_datetime(
            &self,
            t: &NaiveDateTime,
        ) -> chrono::LocalResult<SpringOffset> {
            let (from, to) = (
                date("2026-03-29").and_hms_opt(2, 0, 0),
                date("2026-03-29").and_hms_opt(3, 0, 0),
            );
            if Some(*t) >= from && Some(*t) < to {
                chrono::LocalResult::None
            } else if Some(*t) < from {
                chrono::LocalResult::Single(SpringOffset(0))
            } else {
                chrono::LocalResult::Single(SpringOffset(3600))
            }
        }

        fn offset_from_utc_date(&self, d: &NaiveDate) -> SpringOffset {
            self.offset_from_utc_datetime(&d.and_time(NaiveTime::MIN))
        }

        fn offset_from_utc_datetime(&self, t: &NaiveDateTime) -> SpringOffset {
            SpringOffset(if Some(*t) < date("2026-03-29").and_hms_opt(2, 0, 0) {
                0
            } else {
                3600
            })
        }
    }

    fn due(date: &str, time: Option<&str>) -> Due {
        Due {
            date: date.into(),
            time: time.map(Into::into),
            string: date.into(),
            recurring: false,
        }
    }

    #[test]
    fn a_due_moment_is_the_local_date_and_time() {
        // 2026-10-29 15:00 JST is 06:00 UTC.
        assert_eq!(
            due_at(&jst(), &due("2026-10-29", Some("15:00"))),
            Some(1_793_253_600_000)
        );
        assert_eq!(
            due_at(&jst(), &due("2026-10-29", Some("15:00"))),
            Some(
                Utc.with_ymd_and_hms(2026, 10, 29, 6, 0, 0)
                    .unwrap()
                    .timestamp_millis()
            )
        );
    }

    #[test]
    fn a_due_date_without_a_time_falls_at_local_midnight() {
        // 00:00 on the 29th in JST is 15:00 UTC on the 28th.
        assert_eq!(
            due_at(&jst(), &due("2026-10-29", None)),
            Some(
                Utc.with_ymd_and_hms(2026, 10, 28, 15, 0, 0)
                    .unwrap()
                    .timestamp_millis()
            )
        );
    }

    #[test]
    fn a_due_moment_in_the_hour_the_clock_skips_is_an_hour_later() {
        // 02:30 does not exist on 2026-03-29, so it is read as 03:30, which is 02:30 UTC.
        assert_eq!(
            due_at(&Spring, &due("2026-03-29", Some("02:30"))),
            Some(
                Utc.with_ymd_and_hms(2026, 3, 29, 2, 30, 0)
                    .unwrap()
                    .timestamp_millis()
            )
        );
        assert_eq!(
            due_at(&Spring, &due("2026-03-29", Some("01:30"))),
            Some(
                Utc.with_ymd_and_hms(2026, 3, 29, 1, 30, 0)
                    .unwrap()
                    .timestamp_millis()
            )
        );
    }

    #[test]
    fn an_unreadable_due_has_no_moment() {
        assert_eq!(due_at(&jst(), &due("tomorrow", None)), None);
        assert_eq!(due_at(&jst(), &due("2026-10-29", Some("noon"))), None);
    }

    #[test]
    fn every_task_carries_its_due_moment() {
        let t = todo(
            vec![
                task(
                    json!({"id": "A", "due": {"date": "2026-10-29T15:00:00", "string": "today 15:00"}}),
                ),
                task(json!({"id": "B", "due": {"date": "2026-10-30", "string": "tomorrow"}})),
                task(json!({"id": "C"})),
            ],
            vec![],
        );
        let got: Vec<_> = t.tasks.iter().map(|t| (t.id.as_str(), t.due_at)).collect();
        let at = |h, d| {
            Some(
                Utc.with_ymd_and_hms(2026, 10, d, h, 0, 0)
                    .unwrap()
                    .timestamp_millis(),
            )
        };
        assert_eq!(got, [("A", at(6, 29)), ("B", at(15, 29)), ("C", None)]);
        assert_eq!(
            serde_json::to_value(&t.tasks[0]).unwrap()["dueAt"],
            1_793_253_600_000_i64
        );
        assert!(serde_json::to_value(&t.tasks[2]).unwrap()["dueAt"].is_null());
    }

    #[test]
    fn a_picked_day_and_time_are_the_due_with_their_bucket_and_moment() {
        let today = date("2026-10-29");
        let got = picked_due(" 2026-10-30 15:00 ", today, &jst()).unwrap();
        assert_eq!(
            got.due,
            Some(due_with("2026-10-30", Some("15:00"), "2026-10-30 15:00"))
        );
        assert_eq!(got.bucket, Bucket::Upcoming);
        assert_eq!(got.due_at, due_at(&jst(), got.due.as_ref().unwrap()));
        let got = picked_due("2026-10-29", today, &jst()).unwrap();
        assert_eq!(got.due, Some(due_with("2026-10-29", None, "2026-10-29")));
        assert_eq!(got.bucket, Bucket::Today);
        assert!(got.due_at.is_some());
        assert_eq!(
            picked_due("2026-10-28", today, &jst()).unwrap().bucket,
            Bucket::Overdue
        );
    }

    fn due_with(date: &str, time: Option<&str>, string: &str) -> Due {
        Due {
            string: string.into(),
            ..due(date, time)
        }
    }

    #[test]
    fn an_empty_picked_text_clears_the_due() {
        let got = picked_due("  ", date("2026-10-29"), &jst()).unwrap();
        assert_eq!(
            got,
            PickedDue {
                due: None,
                bucket: Bucket::NoDue,
                due_at: None
            }
        );
    }

    #[test]
    fn other_text_is_left_to_todoist() {
        for text in [
            "明日",
            "every day",
            "2026-13-01",
            "2026-10-29 25:00",
            "2026-10-29 9:00",
            "2026-10-29T10:00",
        ] {
            assert_eq!(picked_due(text, date("2026-10-29"), &jst()), None, "{text}");
        }
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
    fn links_that_tsunagiai_did_not_make_are_not_mail() {
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
    fn project_urls_refuse_ids_that_are_not_alphanumeric() {
        assert_eq!(
            project_api_url("6XGgmFVcrG5RRjVr", Some("archive")).unwrap(),
            "/projects/6XGgmFVcrG5RRjVr/archive"
        );
        assert_eq!(project_api_url("6XGg", None).unwrap(), "/projects/6XGg");
        for id in ["", "a/b", "a?b", "../x", "6XGg/archive"] {
            assert!(project_api_url(id, None).is_err(), "{id}");
            assert!(project_api_url(id, Some("archive")).is_err(), "{id}");
        }
    }

    #[test]
    fn project_move_command_names_the_project_and_the_parent() {
        let uuid = "1ca42128-d12f-4a66-8413-4d6ff2838fde";
        let text =
            project_move_commands("6Jf8VQXxpwv56VQ7", Some("6X7fphhgwcXVGccJ"), uuid).unwrap();
        let commands: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            commands,
            json!([{
                "type": "project_move",
                "uuid": uuid,
                "args": { "id": "6Jf8VQXxpwv56VQ7", "parent_id": "6X7fphhgwcXVGccJ" }
            }])
        );
    }

    #[test]
    fn project_move_command_sends_a_null_parent_for_the_top() {
        let text = project_move_commands("6Jf8VQXxpwv56VQ7", None, "u").unwrap();
        let commands: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(commands[0]["args"]["parent_id"], Value::Null);
        assert_eq!(commands[0]["args"]["id"], "6Jf8VQXxpwv56VQ7");
    }

    #[test]
    fn project_move_command_refuses_bad_ids_and_a_project_under_itself() {
        for bad in ["", "a/b", "a\"b", "x y"] {
            assert!(project_move_commands(bad, None, "u").is_err(), "{bad}");
            assert!(
                project_move_commands("p1", Some(bad), "u").is_err(),
                "{bad}"
            );
        }
        assert!(project_move_commands("p1", Some("p1"), "u").is_err());
    }

    #[test]
    fn command_uuids_have_the_form_of_a_version_4_uuid() {
        assert_eq!(uuid_v4([0xff; 16]), "ffffffff-ffff-4fff-bfff-ffffffffffff");
        assert_eq!(uuid_v4([0; 16]), "00000000-0000-4000-8000-000000000000");
        let bytes = [
            0x1c, 0xa4, 0x21, 0x28, 0xd1, 0x2f, 0x4a, 0x66, 0x84, 0x13, 0x4d, 0x6f, 0xf2, 0x83,
            0x8f, 0xde,
        ];
        assert_eq!(uuid_v4(bytes), "1ca42128-d12f-4a66-8413-4d6ff2838fde");
    }

    #[test]
    fn sync_status_ok_is_a_success_and_anything_else_is_a_failure() {
        let ok = r#"{"sync_token":"t","sync_status":{"u1":"ok"}}"#;
        assert!(check_sync_status(ok, "u1").is_ok());

        let refused = r#"{"sync_status":{"u1":{"error_tag":"INVALID_ARGUMENT_VALUE","error_code":20,"error":"Invalid argument value","http_code":400,"error_extra":{"argument":"parent_id","explanation":"too deep"}}}}"#;
        let message = check_sync_status(refused, "u1").unwrap_err();
        assert!(message.contains("Invalid argument value"), "{message}");
        assert!(message.contains("too deep"), "{message}");

        let plain = r#"{"sync_status":{"u1":{"error_code":15,"error":"Invalid temporary id"}}}"#;
        assert!(check_sync_status(plain, "u1")
            .unwrap_err()
            .contains("Invalid temporary id"));

        // The status of another command, no status, and text that is not JSON are all failures.
        assert!(check_sync_status(r#"{"sync_status":{"u2":"ok"}}"#, "u1").is_err());
        assert!(check_sync_status(r#"{"sync_token":"t"}"#, "u1").is_err());
        assert!(check_sync_status("not json", "u1").is_err());
        assert!(check_sync_status(r#"{"sync_status":{"u1":"nope"}}"#, "u1").is_err());
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
    fn move_under_request_sends_only_the_parent() {
        assert_eq!(
            move_under_request("6XGg", "7YHh").unwrap(),
            ("/tasks/6XGg/move".to_owned(), json!({"parent_id": "7YHh"}))
        );
    }

    #[test]
    fn move_under_request_refuses_bad_ids_and_a_task_under_itself() {
        for (id, parent_id) in [
            ("", "7YHh"),
            ("6XGg", ""),
            ("a/b", "7YHh"),
            ("6XGg", "../x"),
        ] {
            assert!(
                move_under_request(id, parent_id).is_err(),
                "{id} {parent_id}"
            );
        }
        assert_eq!(
            move_under_request("6XGg", "6XGg").unwrap_err(),
            "タスクを自分自身のサブタスクにはできません"
        );
    }

    fn keyed(id: &str, parent: Option<&str>, order: i64, key: &str) -> ApiTask {
        task(json!({
            "id": id, "parent_id": parent, "project_id": "P1",
            "child_order": order, "order_key": key,
        }))
    }

    /// A project with `A`, `B` and `C` at the top, and `A1` and `A2` under `A`.
    fn placed() -> Vec<ApiTask> {
        vec![
            keyed("A", None, 1, "a0"),
            keyed("B", None, 2, "a1"),
            keyed("C", None, 3, "a2"),
            keyed("A1", Some("A"), 1, "a0"),
            keyed("A2", Some("A"), 2, "a1"),
            task(json!({"id": "X", "project_id": "P2", "child_order": 1, "order_key": "a0"})),
        ]
    }

    #[test]
    fn order_keys_are_made_between_two_keys() {
        for (a, b, want) in [
            (None, None, "a0"),
            (Some("a0"), None, "a1"),
            (Some("a1"), None, "a2"),
            (Some("a0"), Some("a1"), "a0V"),
            (Some("a1"), Some("a2"), "a1V"),
            (Some("a0V"), Some("a1"), "a0l"),
            (Some("Zz"), Some("a0"), "ZzV"),
            (Some("Zz"), Some("a1"), "a0"),
            (None, Some("Y00"), "Xzzz"),
            (Some("bzz"), None, "c000"),
            (Some("a0"), Some("a0V"), "a0G"),
            (Some("a0"), Some("a0G"), "a08"),
            (Some("b125"), Some("b129"), "b127"),
            (Some("a0"), Some("a1V"), "a1"),
            (Some("Zz"), Some("a01"), "a0"),
            (None, Some("a0V"), "a0"),
            (None, Some("b999"), "b99"),
            (None, Some("a0"), "Zz"),
            (None, Some("a1"), "a0"),
        ] {
            let key = generate_key_between(a, b).unwrap();
            assert_eq!(key, want, "{a:?} {b:?}");
            if let Some(a) = a {
                assert!(a < key.as_str(), "{a:?} {key}");
            }
            if let Some(b) = b {
                assert!(key.as_str() < b, "{key} {b:?}");
            }
        }
    }

    #[test]
    fn order_keys_refuse_keys_that_are_not_in_order_or_not_keys() {
        for (a, b) in [
            (Some("a1"), Some("a0")),
            (Some("a0"), Some("a0")),
            (Some(""), None),
            (Some("a"), None),
            (Some("a00"), None),
            (Some("a0$"), None),
            (None, Some("A00000000000000000000000000")),
            (Some("あ"), None),
        ] {
            assert!(generate_key_between(a, b).is_err(), "{a:?} {b:?}");
        }
    }

    #[test]
    fn a_task_placed_before_a_sibling_gets_a_key_between_its_neighbours() {
        let tasks = placed();
        // C before B, between A and B.
        let p = place_task(&tasks, "C", None, Some("P1"), Some("B")).unwrap();
        assert_eq!(p.order_key, "a0V");
        assert_eq!(p.move_body, None);
        // First: before A, nothing before it.
        let p = place_task(&tasks, "C", None, Some("P1"), Some("A")).unwrap();
        assert_eq!(p.order_key, "Zz");
        // Last: no sibling to go before; the moved task itself does not count as a sibling.
        let p = place_task(&tasks, "A", None, Some("P1"), None).unwrap();
        assert_eq!(p.order_key, "a3");
        assert_eq!(p.move_body, None);
    }

    #[test]
    fn a_task_placed_under_another_task_moves_there_and_takes_its_place_among_the_subtasks() {
        let tasks = placed();
        let p = place_task(&tasks, "C", Some("A"), None, Some("A2")).unwrap();
        assert_eq!(p.move_body, Some(json!({"parent_id": "A"})));
        assert_eq!(p.order_key, "a0V");
        // Under a task with no subtask yet, the first key.
        let p = place_task(&tasks, "A1", Some("B"), None, None).unwrap();
        assert_eq!(p.move_body, Some(json!({"parent_id": "B"})));
        assert_eq!(p.order_key, "a0");
        // Already under that parent: no move, only the order.
        let p = place_task(&tasks, "A2", Some("A"), None, Some("A1")).unwrap();
        assert_eq!(p.move_body, None);
        assert_eq!(p.order_key, "Zz");
    }

    #[test]
    fn a_subtask_placed_at_the_top_moves_to_the_project_and_one_in_a_section_too() {
        let tasks = placed();
        let p = place_task(&tasks, "A1", None, Some("P1"), Some("B")).unwrap();
        assert_eq!(p.move_body, Some(json!({"project_id": "P1"})));
        assert_eq!(p.order_key, "a0V");
        // Another project's list: the task moves there too.
        let p = place_task(&tasks, "X", None, Some("P1"), None).unwrap();
        assert_eq!(p.move_body, Some(json!({"project_id": "P1"})));
        assert_eq!(p.order_key, "a3");
        let mut in_section = placed();
        in_section[2] = task(json!({
            "id": "C", "project_id": "P1", "section_id": "S1", "child_order": 3, "order_key": "a2",
        }));
        in_section.push(task(json!({
            "id": "D", "project_id": "P1", "section_id": "S1", "child_order": 4, "order_key": "a9",
        })));
        let p = place_task(&in_section, "C", None, Some("P1"), None).unwrap();
        assert_eq!(p.move_body, Some(json!({"project_id": "P1"})));
        // The tasks of a section are not siblings of the top of the project: D is not the neighbour.
        assert_eq!(p.order_key, "a2");
    }

    #[test]
    fn a_task_is_not_placed_under_itself_or_below_itself() {
        let tasks = placed();
        assert_eq!(
            place_task(&tasks, "A", Some("A"), None, None).unwrap_err(),
            "タスクを自分自身のサブタスクにはできません"
        );
        assert_eq!(
            place_task(&tasks, "A", Some("A1"), None, None).unwrap_err(),
            "タスクを自分のサブタスクの下には入れられません"
        );
        let mut deep = placed();
        deep.push(keyed("A11", Some("A1"), 1, "a0"));
        assert_eq!(
            place_task(&deep, "A", Some("A11"), None, Some("A11")).unwrap_err(),
            "タスクを自分のサブタスクの下には入れられません"
        );
        // A loop in the data does not hang the walk.
        let looped = vec![
            keyed("A", None, 1, "a0"),
            keyed("P", Some("Q"), 1, "a0"),
            keyed("Q", Some("P"), 1, "a0"),
        ];
        assert!(place_task(&looped, "A", Some("P"), None, None).is_ok());
    }

    #[test]
    fn a_task_is_not_placed_with_bad_values() {
        let tasks = placed();
        for (id, parent, project, before) in [
            ("", None, Some("P1"), None),
            ("a/b", None, Some("P1"), None),
            ("A", Some("../x"), None, None),
            ("A", None, Some("a b"), None),
            ("A", Some("B"), None, Some("")),
            ("A", Some("B"), None, Some("x/y")),
        ] {
            assert!(
                place_task(&tasks, id, parent, project, before).is_err(),
                "{id} {parent:?} {project:?} {before:?}"
            );
        }
        let say = |r: Result<Placement, String>| r.unwrap_err();
        assert_eq!(
            say(place_task(&tasks, "A", None, None, None)),
            "プロジェクトを指定してください"
        );
        assert_eq!(
            say(place_task(&tasks, "Z", None, Some("P1"), None)),
            "タスクが見つかりません。読み込み直してください"
        );
        assert_eq!(
            say(place_task(&tasks, "A", Some("Z"), None, None)),
            "タスクが見つかりません。読み込み直してください"
        );
        assert_eq!(
            say(place_task(&tasks, "A", None, Some("P1"), Some("A"))),
            "タスクを自分自身の前には置けません"
        );
        // A task of another parent is no place to go before.
        assert_eq!(
            say(place_task(&tasks, "C", Some("A"), None, Some("B"))),
            "並べる位置のタスクが、移動先にありません"
        );
    }

    #[test]
    fn a_task_is_not_placed_next_to_one_with_no_key() {
        let mut tasks = placed();
        tasks[1] = task(json!({"id": "B", "project_id": "P1", "child_order": 2}));
        // Before B, A is the neighbour that gives the key, and B is the one that lacks it.
        assert_eq!(
            place_task(&tasks, "C", None, Some("P1"), Some("B")).unwrap_err(),
            "並び順を読めません。読み込み直してください"
        );
        // Last: C is the neighbour, B is not read.
        assert!(place_task(&tasks, "A", None, Some("P1"), None).is_ok());
    }

    #[test]
    fn the_order_command_sets_only_the_key() {
        let text = task_order_commands("6XGg", "a0V", "u1").unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!([{
                "type": "item_update", "uuid": "u1",
                "args": {"id": "6XGg", "order_key": "a0V"},
            }])
        );
        assert!(task_order_commands("a/b", "a0", "u1").is_err());
    }

    #[test]
    fn update_body_holds_only_the_given_fields() {
        assert_eq!(
            update_body(Some("a"), None, None, None).unwrap(),
            json!({"content": "a"})
        );
        assert_eq!(
            update_body(None, Some("memo"), Some("明日"), None).unwrap(),
            json!({"description": "memo", "due_string": "明日"})
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
    fn update_body_refuses_an_empty_name_and_no_fields() {
        assert!(update_body(Some(" "), None, None, None).is_err());
        assert!(update_body(None, None, None, None).is_err());
    }

    #[test]
    fn update_body_sends_the_labels_and_an_empty_list_removes_them_all() {
        let two = ["a".to_owned(), "b c".to_owned()];
        assert_eq!(
            update_body(None, None, None, Some(&two)).unwrap(),
            json!({"labels": ["a", "b c"]})
        );
        assert_eq!(
            update_body(None, None, None, Some(&[])).unwrap(),
            json!({"labels": []})
        );
        assert_eq!(
            update_body(Some("x"), None, None, Some(&two[..1])).unwrap(),
            json!({"content": "x", "labels": ["a"]})
        );
    }

    #[test]
    fn a_label_name_is_trimmed_and_limited() {
        assert_eq!(label_name("  仕事 ").unwrap(), "仕事");
        assert!(label_name("").is_err());
        assert!(label_name(" \u{3000} ").is_err());
        assert!(label_name(&"あ".repeat(LABEL_LIMIT)).is_ok());
        assert_eq!(
            label_name(&"あ".repeat(LABEL_LIMIT + 1)).unwrap_err(),
            "ラベルの名前は 128 文字までです"
        );
    }

    fn api_label(id: &str, name: &str, color: &str, order: i64) -> ApiLabel {
        ApiLabel {
            id: id.into(),
            name: name.into(),
            color: color.into(),
            item_order: order,
            is_deleted: false,
        }
    }

    #[test]
    fn a_task_and_the_answer_carry_label_names() {
        let t = task(json!({"id": "A", "labels": ["x", "y"]}));
        assert_eq!(t.labels, ["x", "y"]);
        assert!(task(json!({"id": "A"})).labels.is_empty());
        let r = sync_res(json!({
            "sync_token": "t",
            "labels": [{"id": "L1", "name": "仕事", "color": "red", "item_order": 2, "is_deleted": false}],
        }));
        assert_eq!(r.labels[0].name, "仕事");
        assert_eq!(r.labels[0].item_order, 2);
        assert!(!r.is_unchanged());
    }

    #[test]
    fn labels_are_replaced_by_a_full_sync_and_upserted_otherwise() {
        let (mut data, mut done) = synced(json!({
            "sync_token": "t1", "full_sync": true,
            "labels": [{"id": "L1", "name": "a"}, {"id": "L2", "name": "b"}],
        }));
        let names = |d: &SyncData| d.labels.iter().map(|l| l.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&data), ["a", "b"]);
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t2",
                "labels": [{"id": "L1", "name": "a2"}, {"id": "L3", "name": "c"}],
            })),
        );
        assert_eq!(names(&data), ["a2", "b", "c"]);
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t3",
                "labels": [{"id": "L2", "is_deleted": true}, {"id": "L9", "name": "z", "is_deleted": true}],
            })),
        );
        assert_eq!(names(&data), ["a2", "c"]);
        apply_sync(
            &mut data,
            &mut done,
            sync_res(json!({
                "sync_token": "t4", "full_sync": true,
                "labels": [{"id": "L5", "name": "e"}, {"id": "L6", "name": "f", "is_deleted": true}],
            })),
        );
        assert_eq!(names(&data), ["e"]);
    }

    #[test]
    fn the_labels_to_pick_are_the_personal_ones_then_the_shared_names_on_tasks() {
        let tasks = vec![
            task(json!({"id": "A", "labels": ["共有b", "仕事", "共有a"]})),
            task(json!({"id": "B", "labels": ["共有a", "メモ"]})),
        ];
        let personal = vec![
            api_label("L2", "メモ", "blue", 2),
            api_label("L1", "仕事", "berry_red", 1),
            api_label("L3", "未使用", "nope", 3),
        ];
        let t = build_todo(vec![], personal, tasks, &[], date("2026-10-29"), &jst());
        let got: Vec<_> = t
            .labels
            .iter()
            .map(|l| (l.name.as_str(), l.color.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("仕事", "#B8255F"),
                ("メモ", "#4180FF"),
                ("未使用", "#808080"),
                ("共有a", "#808080"),
                ("共有b", "#808080"),
            ]
        );
        assert_eq!(t.tasks[0].labels, ["共有b", "仕事", "共有a"]);
    }

    #[test]
    fn a_cache_without_labels_still_reads() {
        let mut v = serde_json::to_value(cached_todo()).unwrap();
        v.as_object_mut().unwrap().remove("labels");
        for t in v["tasks"].as_array_mut().unwrap() {
            t.as_object_mut().unwrap().remove("labels");
        }
        let todo: Todo = serde_json::from_value(v).unwrap();
        assert!(todo.labels.is_empty());
        assert!(todo.tasks[0].labels.is_empty());
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
        let t = build_todo(
            vec![],
            vec![],
            data.tasks,
            &done,
            date("2026-10-29"),
            &jst(),
        );
        assert_eq!(t.tasks.len(), 1);
        assert_eq!((t.tasks[0].sub_done, t.tasks[0].sub_total), (1, 1));
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tsunagiai-todoist-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn cached_todo() -> Todo {
        let projects = vec![project("p1", "Inbox", "red", true, 1)];
        let tasks = vec![task(
            json!({"id": "t1", "content": "a", "project_id": "p1", "priority": 4, "due": {"date": "2026-10-29", "string": "today"}}),
        )];
        build_todo(projects, vec![], tasks, &[], date("2026-10-29"), &jst())
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
        assert!(!dir.join("todoist-cache.json.tmp").exists());
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
        std::fs::create_dir(dir.join("todoist-cache.json.tmp")).unwrap();
        assert!(save_cache(&dir, &todo, "new").is_err());
        assert_eq!(load_cache(&dir).unwrap().fetched_at, "old");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_built_task_carries_its_web_url() {
        let t = todo(
            vec![
                task(json!({"id": "6XGg", "content": "a", "project_id": "p1", "priority": 4})),
                task(json!({"id": "a/b", "content": "b", "project_id": "p1", "priority": 4})),
            ],
            vec![],
        );
        assert_eq!(t.tasks[0].url, "https://app.todoist.com/app/task/6XGg");
        // An ID the web URL refuses leaves the url empty, which hides "copy link".
        assert_eq!(t.tasks[1].url, "");
    }

    #[test]
    fn a_cache_written_without_task_urls_still_loads() {
        let dir = temp_dir("old-cache");
        std::fs::create_dir_all(&dir).unwrap();
        let mut file = json!({"fetched_at": "2026-10-29T01:02:03Z", "todo": cached_todo()});
        for t in file["todo"]["tasks"].as_array_mut().unwrap() {
            assert!(t.as_object_mut().unwrap().remove("url").is_some());
        }
        std::fs::write(dir.join(CACHE_FILE), file.to_string()).unwrap();
        let loaded = load_cache(&dir).unwrap();
        assert_eq!(loaded.todo.tasks[0].id, "t1");
        assert_eq!(loaded.todo.tasks[0].url, "");
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
        let todo = offline_todo(Some(cached), "503".into(), date("2026-10-29"), &jst()).unwrap();
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
        let next_day = offline_todo(
            Some(cached.clone()),
            "503".into(),
            date("2026-10-30"),
            &jst(),
        )
        .unwrap();
        assert_eq!(next_day.tasks[0].bucket, Bucket::Overdue);
        let day_before =
            offline_todo(Some(cached), "503".into(), date("2026-10-28"), &jst()).unwrap();
        assert_eq!(day_before.tasks[0].bucket, Bucket::Upcoming);
    }

    #[test]
    fn a_cache_written_without_due_moments_gets_them_when_it_is_read() {
        let mut sent = serde_json::to_value(cached_todo()).unwrap();
        sent["tasks"][0].as_object_mut().unwrap().remove("dueAt");
        let old: Todo = serde_json::from_value(sent).unwrap();
        assert_eq!(old.tasks[0].due_at, None);
        let cached = CacheFile {
            fetched_at: "2026-10-29T01:02:03Z".into(),
            todo: old,
        };
        let todo = offline_todo(Some(cached), "503".into(), date("2026-10-29"), &jst()).unwrap();
        assert_eq!(todo.tasks[0].due_at, cached_todo().tasks[0].due_at);
        assert!(todo.tasks[0].due_at.is_some());
    }

    #[test]
    fn a_failed_fetch_without_a_cache_is_the_failure() {
        assert_eq!(
            offline_todo(None, "503".into(), date("2026-10-29"), &jst()).unwrap_err(),
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
            description: "- 認証まわりの変更".into(),
            due: due.map(str::to_owned),
            project_id: None,
            omitted: 0,
            target_cut: false,
            target_text: String::new(),
        }
    }

    const SLACK_URL: &str = "https://example.slack.com/archives/C0123ABC/p1761785520123456";

    /// `slack_task_body` with the confirmed values of the common case; each test changes the one it is about.
    fn body(
        content: &str,
        description: &str,
        due: &str,
        project: Option<&str>,
        today: bool,
    ) -> Result<Value, String> {
        slack_task_body(content, description, SLACK_URL, due, project, today)
    }

    #[test]
    fn a_slack_task_ends_its_description_with_the_message_url() {
        assert_eq!(
            body("PR #482 のレビュー", "- 認証まわりの変更", "", None, false),
            Ok(json!({
                "content": "PR #482 のレビュー",
                "description": format!("- 認証まわりの変更\n\n{SLACK_URL}"),
            }))
        );
    }

    #[test]
    fn a_slack_task_with_no_key_points_has_only_the_url() {
        assert_eq!(
            body("a", "  ", "", None, false).unwrap()["description"],
            SLACK_URL
        );
    }

    #[test]
    fn a_slack_task_takes_the_users_due_text_as_it_is() {
        for due in [
            "2026-11-01 15:00",
            "tomorrow",
            "every day",
            "来週の月曜 10時",
        ] {
            assert_eq!(body("a", "", due, None, false).unwrap()["due_string"], due);
            assert_eq!(body("a", "", due, None, true).unwrap()["due_string"], due);
        }
        assert_eq!(
            body("a", "", "  2026-11-01  ", None, false).unwrap()["due_string"],
            "2026-11-01"
        );
    }

    #[test]
    fn a_slack_task_with_no_due_is_due_today_only_in_today() {
        for empty in ["", "   "] {
            assert_eq!(
                body("a", "", empty, None, true).unwrap()["due_string"],
                "today"
            );
            assert!(body("a", "", empty, Some("P1"), false)
                .unwrap()
                .get("due_string")
                .is_none());
        }
    }

    #[test]
    fn a_slack_task_goes_to_the_given_project() {
        assert_eq!(
            body("a", "", "", Some("P1"), false).unwrap()["project_id"],
            "P1"
        );
        assert!(body("a", "", "", None, false)
            .unwrap()
            .get("project_id")
            .is_none());
    }

    #[test]
    fn a_slack_task_without_a_name_is_refused() {
        for empty in ["", "  ", "\n"] {
            assert!(body(empty, "x", "", None, false).is_err(), "{empty:?}");
        }
    }

    #[test]
    fn a_slack_task_name_is_trimmed_and_cut_at_the_limit() {
        let long = "あ".repeat(CONTENT_LIMIT + 10);
        let cut = body(&format!(" {long} "), "", "", None, false).unwrap();
        assert_eq!(
            cut["content"].as_str().unwrap().chars().count(),
            CONTENT_LIMIT
        );
        assert_eq!(body(" a ", "", "", None, false).unwrap()["content"], "a");
    }

    fn listed() -> Vec<(String, String)> {
        vec![("P1".into(), "仕事".into()), ("P2".into(), "家".into())]
    }

    fn task_body(content: &str, due: Option<&str>, project: Option<&str>) -> Result<Value, String> {
        proposal_task_body(content, due, project, &listed())
    }

    #[test]
    fn a_proposed_task_is_made_as_given() {
        assert_eq!(
            task_body(" 見積もりを送る ", Some("2026-11-15 09:30"), Some("P2")),
            Ok(json!({
                "content": "見積もりを送る",
                "due_string": "2026-11-15 09:30",
                "project_id": "P2",
            }))
        );
        assert_eq!(
            task_body("a", Some(" 2026-11-15 "), None),
            Ok(json!({ "content": "a", "due_string": "2026-11-15" }))
        );
    }

    #[test]
    fn a_proposed_task_without_a_date_or_project_sends_only_its_name() {
        let only = Ok(json!({ "content": "a" }));
        assert_eq!(task_body("a", None, None), only);
        assert_eq!(task_body("a", Some("  "), Some("")), only);
    }

    #[test]
    fn a_date_word_in_the_name_is_left_in_the_name() {
        // Todoist reads `due_string` only; Quick Add would take "明日" out of the name and make it the date.
        let body = task_body("明日 15時 に会議 every day", None, None).unwrap();
        assert_eq!(body["content"], "明日 15時 に会議 every day");
        assert!(body.get("due_string").is_none());
    }

    #[test]
    fn a_proposed_task_without_a_name_is_refused() {
        for empty in ["", "  ", "\n"] {
            assert_eq!(
                task_body(empty, None, None),
                Err("タスクの名前を入力してください".into()),
                "{empty:?}"
            );
        }
    }

    #[test]
    fn a_proposed_task_name_past_the_limit_is_refused_and_the_limit_is_kept() {
        let long = "あ".repeat(CONTENT_LIMIT + 1);
        assert_eq!(
            task_body(&format!(" {long} "), None, None),
            Err(format!(
                "タスクの名前が長すぎます（{CONTENT_LIMIT} 文字まで）"
            ))
        );
        let edge = "あ".repeat(CONTENT_LIMIT);
        assert_eq!(task_body(&edge, None, None).unwrap()["content"], edge);
    }

    #[test]
    fn a_proposed_task_date_must_be_a_plain_date_or_date_and_time() {
        for due in [
            "tomorrow",
            "every day",
            "2026-11-01T15:00",
            "2026-13-01",
            "2026-11-01 25:00",
            "2026-1-5",
        ] {
            assert_eq!(
                task_body("a", Some(due), None),
                Err("日付は YYYY-MM-DD か YYYY-MM-DD HH:MM の形で指定してください".into()),
                "{due}"
            );
        }
    }

    #[test]
    fn a_proposed_task_project_must_be_one_of_the_list() {
        for project in ["P9", "仕事", "p1"] {
            assert_eq!(
                task_body("a", None, Some(project)),
                Err("プロジェクトが見つかりません".into()),
                "{project}"
            );
        }
        assert_eq!(
            task_body("a", None, Some(" P1 ")).unwrap()["project_id"],
            "P1"
        );
        assert_eq!(
            proposal_task_body("a", None, Some("P1"), &[]),
            Err("プロジェクトが見つかりません".into())
        );
    }

    #[test]
    fn a_summary_keeps_only_a_date_or_a_date_and_time_as_due() {
        for due in ["2026-11-01", "2026-11-01 15:00"] {
            assert_eq!(with_plain_due(summary(Some(due))).due.as_deref(), Some(due));
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
            assert_eq!(with_plain_due(summary(Some(due))).due, None, "{due}");
        }
        assert_eq!(with_plain_due(summary(None)).due, None);
    }

    fn api_comment(id: &str, uid: Option<&str>, at: Option<&str>) -> ApiComment {
        ApiComment {
            id: id.into(),
            posted_uid: uid.map(str::to_owned),
            content: format!("body {id}"),
            file_attachment: None,
            is_deleted: false,
            posted_at: at.map(str::to_owned),
        }
    }

    fn comment_ids(comments: &[ApiComment]) -> Vec<&str> {
        comments.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn comments_drop_the_deleted_ones_and_come_oldest_first() {
        let mut gone = api_comment("c0", Some("1"), Some("2026-11-01T00:00:00Z"));
        gone.is_deleted = true;
        let live = live_comments(vec![
            api_comment("c3", Some("1"), Some("2026-11-03T10:00:00.123456Z")),
            gone,
            api_comment("c1", Some("1"), Some("2026-11-01T09:00:00Z")),
            api_comment("c2", Some("1"), Some("2026-11-02T23:30:00+09:00")),
            api_comment("c9", Some("1"), None),
        ]);
        assert_eq!(comment_ids(&live), ["c9", "c1", "c2", "c3"]);
    }

    #[test]
    fn comments_keep_their_order_when_posted_at_the_same_time() {
        let at = Some("2026-11-01T09:00:00Z");
        let live = live_comments(vec![
            api_comment("b", Some("1"), at),
            api_comment("a", Some("1"), at),
        ]);
        assert_eq!(comment_ids(&live), ["b", "a"]);
    }

    #[test]
    fn a_file_keeps_only_an_https_address_and_falls_back_on_a_name() {
        let file = |v: Value| file_of(&v);
        assert_eq!(
            file(json!({"file_name": "a.pdf", "file_url": "https://files.todoist.com/a.pdf"})),
            Some(CommentFile {
                file_name: "a.pdf".into(),
                file_url: Some("https://files.todoist.com/a.pdf".into()),
            })
        );
        for url in [
            "http://files.todoist.com/a.pdf",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "HTTPS://example.com/",
        ] {
            let kept = file(json!({"file_name": "a.pdf", "file_url": url})).unwrap();
            assert_eq!(kept.file_url, None, "{url}");
            assert_eq!(kept.file_name, "a.pdf");
        }
        let unnamed = file(json!({"file_url": "https://files.todoist.com/a.pdf"})).unwrap();
        assert_eq!(unnamed.file_name, UNNAMED_FILE);
        assert!(unnamed.file_url.is_some());
        let blank = file(json!({"file_name": "  ", "file_url": "https://example.com/x"})).unwrap();
        assert_eq!(blank.file_name, UNNAMED_FILE);
        assert_eq!(file(json!({})), None);
        assert_eq!(file(json!(null)), None);
        assert_eq!(file(json!("a.pdf")), None);
    }

    #[test]
    fn collaborators_are_needed_only_when_someone_else_wrote_a_comment() {
        let mine = [
            api_comment("a", Some("7"), None),
            api_comment("b", Some("7"), None),
        ];
        assert!(!needs_collaborators(&mine, Some("7")));
        assert!(!needs_collaborators(&[], Some("7")));
        let others = [
            api_comment("a", Some("7"), None),
            api_comment("b", Some("8"), None),
        ];
        assert!(needs_collaborators(&others, Some("7")));
        // The user could not be read: nobody is known to be the user.
        assert!(needs_collaborators(&mine, None));
        // No author at all names nobody.
        assert!(!needs_collaborators(&[api_comment("a", None, None)], None));
    }

    #[test]
    fn authors_are_named_by_the_user_then_the_collaborators_and_the_rest_are_unknown() {
        let names = author_names(
            Some(ApiUser {
                id: "7".into(),
                full_name: "Me Example".into(),
            }),
            vec![
                ApiCollaborator {
                    id: "7".into(),
                    name: "Me Old".into(),
                },
                ApiCollaborator {
                    id: "8".into(),
                    name: "Bob Example".into(),
                },
                ApiCollaborator {
                    id: "9".into(),
                    name: " ".into(),
                },
            ],
        );
        let author =
            |uid: Option<&str>| comment_of(&jst(), &api_comment("c", uid, None), &names).author;
        assert_eq!(author(Some("7")), "Me Example");
        assert_eq!(author(Some("8")), "Bob Example");
        assert_eq!(author(Some("9")), UNKNOWN_AUTHOR);
        assert_eq!(author(Some("10")), UNKNOWN_AUTHOR);
        assert_eq!(author(None), UNKNOWN_AUTHOR);
        assert!(author_names(None, vec![]).is_empty());
    }

    #[test]
    fn a_comment_carries_its_local_time_text_and_file() {
        let mut c = api_comment("c1", Some("7"), Some("2026-11-02T20:30:00.5Z"));
        c.file_attachment =
            Some(json!({"file_name": "a.pdf", "file_url": "https://example.com/a.pdf"}));
        let got = comment_of(&jst(), &c, &HashMap::new());
        assert_eq!(
            got.posted,
            Some(Posted {
                date: "2026-11-03".into(),
                time: Some("05:30".into()),
            })
        );
        assert_eq!(got.content, "body c1");
        assert_eq!(got.attachment.unwrap().file_name, "a.pdf");
        let none = comment_of(&jst(), &api_comment("c2", None, None), &HashMap::new());
        assert_eq!((none.posted, none.attachment), (None, None));
        let bad = comment_of(
            &jst(),
            &api_comment("c3", None, Some("soon")),
            &HashMap::new(),
        );
        assert_eq!(bad.posted, None);
    }

    #[test]
    fn a_comment_answer_is_read_with_its_unknown_fields_and_a_null_file() {
        let c: ApiComment = serde_json::from_value(json!({
            "id": "c1", "posted_uid": "7", "content": "hi", "file_attachment": null,
            "uids_to_notify": [], "is_deleted": false, "posted_at": "2026-11-02T10:00:00Z", "reactions": null,
        }))
        .unwrap();
        assert_eq!(c.file_attachment, None);
        let sparse: ApiComment = serde_json::from_value(json!({"id": "c2"})).unwrap();
        assert_eq!((sparse.content.as_str(), sparse.is_deleted), ("", false));
    }

    #[test]
    fn a_comment_body_trims_the_text_and_sends_the_task() {
        let file = json!({"file_name": "a.pdf", "file_url": "https://example.com/a.pdf"});
        assert_eq!(
            comment_body("k1", "  hello \n", None).unwrap(),
            json!({"task_id": "k1", "content": "hello"})
        );
        assert_eq!(
            comment_body("k1", "see", Some(&file)).unwrap(),
            json!({"task_id": "k1", "content": "see", "attachment": file})
        );
    }

    #[test]
    fn a_comment_of_only_a_file_sends_the_files_name_as_its_text() {
        let file = json!({"file_name": "報告.pdf"});
        assert_eq!(
            comment_body("k1", " \n", Some(&file)).unwrap()["content"],
            "報告.pdf"
        );
        assert_eq!(
            comment_body("k1", "", Some(&json!({"file_name": " "}))).unwrap()["content"],
            UNNAMED_FILE
        );
        assert_eq!(
            comment_body("k1", "", Some(&json!({}))).unwrap()["content"],
            UNNAMED_FILE
        );
    }

    #[test]
    fn a_comment_body_refuses_blank_text_without_a_file_and_a_file_that_is_not_an_object() {
        assert!(comment_body("k1", "  \n", None).is_err());
        for bad in [json!("a.pdf"), json!(["a"]), json!(null), json!(3)] {
            assert_eq!(
                comment_body("k1", "text", Some(&bad)),
                Err("添付ファイルが不正です".to_owned())
            );
        }
    }

    #[test]
    fn a_comment_body_refuses_text_over_the_limit_counted_in_characters() {
        let at_limit = "あ".repeat(COMMENT_LIMIT);
        assert!(comment_body("k1", &at_limit, None).is_ok());
        // Spaces around the text do not count.
        assert!(comment_body("k1", &format!(" {at_limit} "), None).is_ok());
        let over = comment_body("k1", &format!("{at_limit}あ"), None);
        assert!(over.unwrap_err().contains("15000"));
    }

    #[test]
    fn an_upload_needs_raw_bytes_and_a_name_that_is_decoded() {
        let raw = tauri::ipc::InvokeBody::Raw(vec![1, 2, 3]);
        assert_eq!(
            upload_parts(Some("%E5%A0%B1%E5%91%8A%20a.pdf"), &raw).unwrap(),
            ("報告 a.pdf".to_owned(), &[1u8, 2, 3][..])
        );
        assert_eq!(upload_parts(Some("a%2Bb.txt"), &raw).unwrap().0, "a+b.txt");
        for name in [None, Some(""), Some("%20%20")] {
            assert_eq!(
                upload_parts(name, &raw),
                Err("ファイル名がありません".to_owned())
            );
        }
        let json = tauri::ipc::InvokeBody::Json(json!([1, 2, 3]));
        assert_eq!(
            upload_parts(Some("a.txt"), &json),
            Err("ファイルを読めません".to_owned())
        );
        // An empty file is Todoist's to refuse.
        let empty = tauri::ipc::InvokeBody::Raw(vec![]);
        assert!(upload_parts(Some("a.txt"), &empty).unwrap().1.is_empty());
    }

    // The checks of `add_task` come before any request, so a client that reaches nothing shows that a refusal is made by the same check as the command's.
    #[tokio::test]
    async fn adding_a_task_refuses_the_values_before_any_request() {
        let http = reqwest::Client::new();
        let add = |content: &str, due: Option<&str>, project: Option<&str>| {
            let http = http.clone();
            let (content, due, project) = (
                content.to_owned(),
                due.map(str::to_owned),
                project.map(str::to_owned),
            );
            async move {
                add_task(
                    &http,
                    "t",
                    "todoist_add_task",
                    &content,
                    due.as_deref(),
                    project.as_deref(),
                    &listed(),
                )
                .await
            }
        };
        assert_eq!(
            add("  ", None, None).await,
            Err("タスクの名前を入力してください".into())
        );
        assert_eq!(
            add(&"あ".repeat(CONTENT_LIMIT + 1), None, None).await,
            Err(format!(
                "タスクの名前が長すぎます（{CONTENT_LIMIT} 文字まで）"
            ))
        );
        assert_eq!(
            add("a", Some("tomorrow"), None).await,
            Err("日付は YYYY-MM-DD か YYYY-MM-DD HH:MM の形で指定してください".into())
        );
        assert_eq!(
            add("a", None, Some("P9")).await,
            Err("プロジェクトが見つかりません".into())
        );
    }

    fn two_projects_todo() -> Todo {
        build_todo(
            vec![
                project("P1", "仕事", "berry_red", false, 2),
                child("P1", "P3", 1),
                project("P0", "Inbox", "charcoal", true, 0),
            ],
            vec![],
            vec![
                task(
                    json!({"id": "k1", "project_id": "P1", "content": "請求書を送る", "description": "メモ", "priority": 4, "labels": ["a"], "due": {"date": "2026-10-30", "string": "明日"}}),
                ),
                task(
                    json!({"id": "k2", "project_id": "P1", "parent_id": "k1", "content": "下書き"}),
                ),
            ],
            &[],
            date("2026-10-29"),
            &jst(),
        )
    }

    #[test]
    fn the_projects_to_check_against_are_the_ids_and_names_in_tree_order() {
        assert_eq!(
            listed_projects(&two_projects_todo()),
            [
                ("P0".to_owned(), "Inbox".to_owned()),
                ("P1".to_owned(), "仕事".to_owned()),
                ("P3".to_owned(), "P3".to_owned()),
            ]
        );
    }

    #[test]
    fn the_projects_answer_has_the_tree_and_the_inbox() {
        let answer = projects_answer(&two_projects_todo());
        let names: Vec<_> = answer
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["id"].as_str().unwrap(),
                    p["inbox"].as_bool().unwrap(),
                    p["depth"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(names, [("P0", true, 0), ("P1", false, 0), ("P3", false, 1)]);
        assert_eq!(answer[1]["name"], "仕事");
        assert_eq!(answer[2]["parentId"], "P1");
    }

    #[test]
    fn the_tasks_answer_has_the_fields_claude_needs_and_a_subtask_names_its_parent() {
        let answer = tasks_answer(&two_projects_todo());
        let tasks = answer.as_array().unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(
            tasks[0],
            json!({
                "id": "k1",
                "content": "請求書を送る",
                "description": "メモ",
                "projectId": "P1",
                "parentId": null,
                "priority": 1,
                "due": {"date": "2026-10-30", "time": null, "string": "明日", "recurring": false},
                "labels": ["a"],
            })
        );
        assert_eq!(tasks[1]["id"], "k2");
        assert_eq!(tasks[1]["parentId"], "k1");
        assert_eq!(tasks[1]["due"], Value::Null);
    }
}
