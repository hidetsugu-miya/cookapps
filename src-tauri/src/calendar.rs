use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
};

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, Local, NaiveDate, NaiveTime, SecondsFormat,
    TimeZone, Utc,
};
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, State};
use url::Url;

use crate::{
    auth::{config_dir, Auth},
    disk_cache,
    gmail::{log_failure, send_json_refreshing, ApiError},
};

const CALENDAR_LIST_URL: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDARS_URL: &str = "https://www.googleapis.com/calendar/v3/calendars";
// shortcut: past this many pages (2500 events of one calendar) the rest is dropped, upgrade if a week ever needs more.
const MAX_PAGES: usize = 10;
/// A shorter event is laid out as if it lasted this long, so it stays visible.
/// Keep in step with `MIN_EVENT_MIN` in `src/main.js`.
const MIN_MINUTES: u32 = 20;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ApiTime {
    /// All-day events carry a date only.
    date: Option<String>,
    date_time: Option<String>,
}

#[derive(Deserialize)]
struct Attendee {
    #[serde(default, rename = "self")]
    is_self: bool,
    #[serde(default, rename = "responseStatus")]
    response_status: String,
}

#[derive(Deserialize)]
struct ApiEvent {
    #[serde(default)]
    summary: String,
    #[serde(default, rename = "iCalUID")]
    ical_uid: String,
    #[serde(default)]
    start: ApiTime,
    #[serde(default)]
    end: ApiTime,
    #[serde(default)]
    attendees: Vec<Attendee>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventPage {
    #[serde(default)]
    items: Vec<ApiEvent>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CalendarEntry {
    id: String,
    #[serde(default)]
    selected: bool,
    background_color: Option<String>,
    summary: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarPage {
    #[serde(default)]
    items: Vec<CalendarEntry>,
    next_page_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum When {
    /// `end` is exclusive, as in the API.
    AllDay { start: NaiveDate, end: NaiveDate },
    Timed {
        start: DateTime<FixedOffset>,
        end: DateTime<FixedOffset>,
    },
}

/// `None` when the event has neither a date nor a parsable dateTime.
/// shortcut: such an event is dropped without notice, upgrade if Google ever sends one.
fn when(start: &ApiTime, end: &ApiTime) -> Option<When> {
    if let Some(s) = &start.date {
        let start: NaiveDate = s.parse().ok()?;
        let end = end
            .date
            .as_deref()
            .and_then(|e| e.parse().ok())
            .unwrap_or(start + Duration::days(1));
        return Some(When::AllDay { start, end });
    }
    let parse = |t: &ApiTime| DateTime::parse_from_rfc3339(t.date_time.as_deref()?).ok();
    let start = parse(start)?;
    Some(When::Timed {
        start,
        end: parse(end).unwrap_or(start),
    })
}

#[derive(Debug, Clone)]
struct RawEvent {
    account: String,
    /// Background color of the calendar the event is on.
    color: Option<String>,
    /// Name of the calendar the event is on.
    calendar: String,
    summary: String,
    declined: bool,
    ical_uid: String,
    when: When,
}

impl RawEvent {
    fn from_api(e: ApiEvent, account: &str, cal: &CalendarEntry) -> Option<Self> {
        Some(Self {
            when: when(&e.start, &e.end)?,
            declined: e
                .attendees
                .iter()
                .any(|a| a.is_self && a.response_status == "declined"),
            account: account.to_owned(),
            color: cal.background_color.clone(),
            calendar: cal.summary.clone().unwrap_or_else(|| cal.id.clone()),
            summary: e.summary,
            ical_uid: e.ical_uid,
        })
    }
}

/// What the screen needs of an event besides where it goes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    summary: String,
    /// `None` means the screen picks one from the account.
    color: Option<String>,
    account: String,
    /// The user declined the invitation.
    declined: bool,
}

impl From<&RawEvent> for Info {
    fn from(e: &RawEvent) -> Self {
        Self {
            summary: e.summary.clone(),
            color: e.color.clone(),
            account: e.account.clone(),
            declined: e.declined,
        }
    }
}

/// An all-day event on one day of the week (0 = Sunday). A multi-day event gets one item per day.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllDayItem {
    day: usize,
    #[serde(flatten)]
    info: Info,
}

/// A timed event on one day of the week, in minutes from local midnight, with its column among overlapping events.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimedItem {
    day: usize,
    start_min: u32,
    end_min: u32,
    col: usize,
    cols: usize,
    #[serde(flatten)]
    info: Info,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Week {
    /// Local date (YYYY-MM-DD) of the Sunday the week starts on.
    week_start: String,
    all_day: Vec<AllDayItem>,
    timed: Vec<TimedItem>,
    /// Accounts whose events are missing because they must log in again (including: the calendar scope is not granted yet).
    needs_login: Vec<String>,
    /// Accounts whose events are missing because loading them failed, with the error to show.
    failed: HashMap<String, String>,
    /// Calendars whose events are missing because loading them failed, each as a whole message to show.
    /// The other calendars of the same account are still in the week.
    calendar_failed: Vec<String>,
}

/// An event as `list_events` returns it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventItem {
    account: String,
    calendar: String,
    summary: String,
    declined: bool,
    all_day: bool,
    /// A local date for an all-day event, else an RFC 3339 time.
    start: String,
    /// Same form as `start`; the last day for an all-day event.
    end: String,
}

impl From<&RawEvent> for EventItem {
    fn from(e: &RawEvent) -> Self {
        let (all_day, start, end) = match &e.when {
            // The API's end date is exclusive.
            When::AllDay { start, end } => (
                true,
                start.to_string(),
                (*end - Duration::days(1)).max(*start).to_string(),
            ),
            When::Timed { start, end } => (false, start.to_rfc3339(), end.to_rfc3339()),
        };
        Self {
            account: e.account.clone(),
            calendar: e.calendar.clone(),
            summary: e.summary.clone(),
            declined: e.declined,
            all_day,
            start,
            end,
        }
    }
}

/// Earliest first, each event once.
/// shortcut: sorted by the text of `start`, so events with different UTC offsets can be off by the offset, upgrade if that shows.
fn flat_events(events: &[RawEvent]) -> Vec<EventItem> {
    let mut seen = HashSet::new();
    let mut items: Vec<_> = events
        .iter()
        .filter(|e| !is_duplicate(&mut seen, e))
        .map(EventItem::from)
        .collect();
    items.sort_by(|a, b| a.start.cmp(&b.start));
    items
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Events {
    events: Vec<EventItem>,
    /// Accounts whose events are missing because they must log in again.
    needs_login: Vec<String>,
    /// Accounts whose events are missing because loading them failed, with the error.
    failed: HashMap<String, String>,
    /// Calendars whose events are missing because loading them failed, each as a whole message.
    /// The other calendars of the same account are still in `events`.
    calendar_failed: Vec<String>,
}

fn week_start(date: NaiveDate) -> NaiveDate {
    date - Duration::days(date.weekday().num_days_from_sunday().into())
}

/// `timeMin` / `timeMax` of `[from, to)`: local midnights as UTC RFC 3339.
fn range_bounds<Tz: TimeZone>(tz: &Tz, from: NaiveDate, to: NaiveDate) -> Option<(String, String)> {
    let midnight = |d: NaiveDate| {
        let t = tz
            .from_local_datetime(&d.and_time(NaiveTime::MIN))
            .earliest()?;
        Some(
            t.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true),
        )
    };
    Some((midnight(from)?, midnight(to)?))
}

/// `timeMin` / `timeMax` of the week from `start`.
fn week_bounds<Tz: TimeZone>(tz: &Tz, start: NaiveDate) -> Option<(String, String)> {
    range_bounds(tz, start, start + Duration::days(7))
}

/// `timeMin` / `timeMax` of the local dates `from` to `to` (YYYY-MM-DD), `to` included.
fn parse_range<Tz: TimeZone>(tz: &Tz, from: &str, to: &str) -> Result<(String, String), String> {
    let date = |d: &str| {
        d.parse::<NaiveDate>()
            .map_err(|_| format!("日付が不正です: {d}"))
    };
    let (from, to) = (date(from)?, date(to)?);
    if to < from {
        return Err("to は from 以降の日付にしてください".into());
    }
    range_bounds(tz, from, to + Duration::days(1)).ok_or("日付の範囲を求められません".into())
}

/// Puts the titled copy of an event first, so dropping the later copies keeps it.
/// A calendar shared as free/busy only gives its events no title.
fn titled_first(events: &mut [RawEvent]) {
    events.sort_by_key(|e| e.summary.is_empty());
}

/// Whether `e` repeats an event already seen: the same event on several accounts has one iCalUID and time.
fn is_duplicate(seen: &mut HashSet<(String, When)>, e: &RawEvent) -> bool {
    !e.ical_uid.is_empty() && !seen.insert((e.ical_uid.clone(), e.when.clone()))
}

/// Column of each span, and the number of columns of the cluster of chained overlapping spans it belongs to.
/// `spans` are `(start, end)` minutes, `end` exclusive; the result follows the input order.
fn assign_columns(spans: &[(u32, u32)]) -> Vec<(usize, usize)> {
    let mut order: Vec<_> = (0..spans.len()).collect();
    // The longer of two events starting together goes first, so it takes the left column.
    order.sort_by_key(|&i| (spans[i].0, Reverse(spans[i].1)));
    let mut out = vec![(0, 0); spans.len()];
    let (mut cluster_start, mut cluster_end) = (0, 0);
    let mut col_ends: Vec<u32> = vec![];
    for (n, &i) in order.iter().enumerate() {
        let (start, end) = spans[i];
        if n > cluster_start && start >= cluster_end {
            for &m in &order[cluster_start..n] {
                out[m].1 = col_ends.len();
            }
            cluster_start = n;
            col_ends.clear();
        }
        let col = col_ends
            .iter()
            .position(|&e| e <= start)
            .unwrap_or(col_ends.len());
        if col == col_ends.len() {
            col_ends.push(end);
        } else {
            col_ends[col] = end;
        }
        out[i].0 = col;
        cluster_end = if n == cluster_start {
            end
        } else {
            cluster_end.max(end)
        };
    }
    for &m in &order[cluster_start..] {
        out[m].1 = col_ends.len();
    }
    out
}

/// Puts the events of the week starting `start` (a local date in `tz`) on its seven days.
/// The same event on several accounts (same iCalUID and time) is kept once.
fn build_week<Tz: TimeZone>(
    tz: &Tz,
    start: NaiveDate,
    events: Vec<RawEvent>,
) -> (Vec<AllDayItem>, Vec<TimedItem>) {
    let mut seen = HashSet::new();
    let (mut all_day, mut timed) = (vec![], vec![]);
    for e in &events {
        if is_duplicate(&mut seen, e) {
            continue;
        }
        for day in 0..7 {
            let d = start + Duration::days(day as i64);
            match &e.when {
                When::AllDay { start: s, end } => {
                    if *s <= d && d < *end {
                        all_day.push(AllDayItem {
                            day,
                            info: e.into(),
                        });
                    }
                }
                When::Timed { start: s, end } => {
                    let (s, end) = (
                        s.with_timezone(tz).naive_local(),
                        end.with_timezone(tz).naive_local(),
                    );
                    let day_start = d.and_time(NaiveTime::MIN);
                    let day_end = day_start + Duration::days(1);
                    // A zero-length event counts as on the day it starts.
                    if s < day_end && (end > day_start || s >= day_start) {
                        let minutes =
                            |t: chrono::NaiveDateTime| (t - day_start).num_minutes() as u32;
                        timed.push(TimedItem {
                            day,
                            start_min: minutes(s.max(day_start)),
                            end_min: minutes(end.min(day_end)),
                            col: 0,
                            cols: 1,
                            info: e.into(),
                        });
                    }
                }
            }
        }
    }
    for day in 0..7 {
        let on_day: Vec<_> = timed.iter_mut().filter(|t| t.day == day).collect();
        let spans: Vec<_> = on_day
            .iter()
            .map(|t| (t.start_min, t.end_min.max(t.start_min + MIN_MINUTES)))
            .collect();
        for (t, (col, cols)) in on_day.into_iter().zip(assign_columns(&spans)) {
            (t.col, t.cols) = (col, cols);
        }
    }
    (all_day, timed)
}

#[derive(Debug, PartialEq)]
enum Failure {
    NeedsLogin,
    Message(String),
}

/// A 403 for a missing scope means the stored login predates the calendar scope, so it is a re-login.
fn classify(status: Option<u16>, message: &str) -> Failure {
    if status == Some(403) {
        if message.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
            || message.contains("insufficientPermissions")
        {
            return Failure::NeedsLogin;
        }
        if message.contains("accessNotConfigured") || message.contains("SERVICE_DISABLED") {
            return Failure::Message(
                "Google Calendar API が有効になっていません。Google Cloud コンソールで、このプロジェクトの Calendar API を有効にしてください"
                    .into(),
            );
        }
    }
    Failure::Message(message.to_owned())
}

/// Whether a failure concerns the whole account (re-login, Calendar API off) rather than the one calendar that hit it.
/// `classify` rewrites exactly those.
fn is_account_wide(status: Option<u16>, message: &str) -> bool {
    classify(status, message) != Failure::Message(message.to_owned())
}

/// The message for a calendar that could not be loaded; the calendar is named by its summary, or its ID without one.
fn calendar_failure(account: &str, cal: &CalendarEntry, message: &str) -> String {
    let name = cal
        .summary
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&cal.id);
    format!("{account} のカレンダー「{name}」の予定を読み込めませんでした: {message}")
}

/// All pages of one list call. `Ok(None)` means `account` must log in again.
async fn fetch_pages<T: DeserializeOwned>(
    dir: &Path,
    auth: &Auth,
    account: &str,
    url: &str,
    query: &[(&str, &str)],
    next_token: impl Fn(&T) -> Option<String>,
) -> Result<Option<Vec<T>>, ApiError> {
    let mut pages = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut q = query.to_vec();
        if let Some(t) = &token {
            q.push(("pageToken", t));
        }
        let Some(page) =
            send_json_refreshing::<T>(dir, auth, account, Method::GET, url, &q, None).await?
        else {
            return Ok(None);
        };
        token = next_token(&page);
        pages.push(page);
        if token.is_none() {
            break;
        }
    }
    Ok(Some(pages))
}

/// The ID (an email address, or `…#holiday@group.v.calendar.google.com`) is one path segment, escaped as such.
fn events_url(calendar_id: &str) -> Result<String, String> {
    if matches!(calendar_id, "" | "." | "..") {
        return Err("カレンダー ID が不正です".into());
    }
    let mut url = Url::parse(CALENDARS_URL).map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "URL が不正です")?
        .push(calendar_id)
        .push("events");
    Ok(url.into())
}

/// The selected calendars of each account, kept in memory for the run so a week does not list them again.
/// Clones share the same map, so the clones a spawned task owns see the same cache.
#[derive(Default, Clone)]
pub struct CalendarCache(Arc<Mutex<HashMap<String, Vec<CalendarEntry>>>>);

impl CalendarCache {
    pub fn forget(&self, account: &str) {
        self.0.lock().unwrap().remove(account);
    }
}

/// Runs the futures at once and returns their outputs in input order. A panicked task is an error.
async fn join_all<T: Send + 'static>(
    futures: Vec<impl Future<Output = T> + Send + 'static>,
) -> Result<Vec<T>, ApiError> {
    let handles: Vec<_> = futures.into_iter().map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(h.await.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// The selected calendars of one account. `Ok(None)` means that account must log in again.
async fn selected_calendars(
    dir: &Path,
    auth: &Auth,
    account: &str,
) -> Result<Option<Vec<CalendarEntry>>, ApiError> {
    let list_query = [
        ("maxResults", "250"),
        (
            "fields",
            "nextPageToken,items(id,selected,backgroundColor,summary)",
        ),
    ];
    let Some(pages) =
        fetch_pages::<CalendarPage>(dir, auth, account, CALENDAR_LIST_URL, &list_query, |p| {
            p.next_page_token.clone()
        })
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(
        pages
            .into_iter()
            .flat_map(|p| p.items)
            .filter(|c| c.selected)
            .collect(),
    ))
}

/// Events in `[min, max)` of one calendar. `Ok(None)` means `account` must log in again.
async fn calendar_events(
    dir: &Path,
    auth: &Auth,
    account: &str,
    cal: &CalendarEntry,
    min: &str,
    max: &str,
) -> Result<Option<Vec<RawEvent>>, ApiError> {
    let event_query = [
        ("singleEvents", "true"),
        ("orderBy", "startTime"),
        ("timeMin", min),
        ("timeMax", max),
        ("maxResults", "250"),
        (
            "fields",
            "nextPageToken,items(summary,iCalUID,start,end,attendees(self,responseStatus))",
        ),
    ];
    let url = events_url(&cal.id)?;
    let Some(pages) = fetch_pages::<EventPage>(dir, auth, account, &url, &event_query, |p| {
        p.next_page_token.clone()
    })
    .await?
    else {
        return Ok(None);
    };
    Ok(Some(
        pages
            .into_iter()
            .flat_map(|p| p.items)
            .filter_map(|e| RawEvent::from_api(e, account, cal))
            .collect(),
    ))
}

/// The events of one account, and a message for each calendar that failed to load.
struct AccountEvents {
    events: Vec<RawEvent>,
    failed: Vec<String>,
}

/// Events in `[min, max)` of every selected calendar of one account, the calendars fetched at once.
/// `refresh` lists the calendars again instead of using the kept list. `Ok(None)` means that account must log in again.
/// A failure of the whole account is an `Err`; a failure of one calendar leaves that calendar out and is listed in `failed`.
async fn account_events(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    account: &str,
    min: &str,
    max: &str,
    refresh: bool,
) -> Result<Option<AccountEvents>, ApiError> {
    let kept = if refresh {
        None
    } else {
        cache.0.lock().unwrap().get(account).cloned()
    };
    let calendars = match kept {
        Some(c) => c,
        None => {
            let Some(c) = selected_calendars(dir, auth, account).await? else {
                return Ok(None);
            };
            cache
                .0
                .lock()
                .unwrap()
                .insert(account.to_owned(), c.clone());
            c
        }
    };
    let jobs = calendars
        .iter()
        .cloned()
        .map(|cal| {
            let (dir, auth, account) = (dir.to_owned(), auth.clone(), account.to_owned());
            let (min, max) = (min.to_owned(), max.to_owned());
            async move { calendar_events(&dir, &auth, &account, &cal, &min, &max).await }
        })
        .collect();
    let mut out = AccountEvents {
        events: Vec::new(),
        failed: Vec::new(),
    };
    for (cal, found) in calendars.iter().zip(join_all(jobs).await?) {
        match found {
            Ok(Some(events)) => out.events.extend(events),
            Ok(None) => return Ok(None),
            Err(e) if is_account_wide(e.status, &e.message) => return Err(e),
            Err(e) => {
                // The kept calendars may be what failed (e.g. one was deleted), so list them again next time.
                cache.0.lock().unwrap().remove(account);
                let message = log_failure("calendar_week", account, e);
                out.failed.push(calendar_failure(account, cal, &message));
            }
        }
    }
    Ok(Some(out))
}

/// What `collect_events` found: the events, and what is missing from them.
struct Collected {
    events: Vec<RawEvent>,
    needs_login: Vec<String>,
    failed: HashMap<String, String>,
    calendar_failed: Vec<String>,
}

/// Events in `[min, max)` of every account, the accounts fetched at once. Accounts needing login or failing to load,
/// and calendars failing to load, are listed, not fatal. `command` names the caller in the failure log.
async fn collect_events(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    command: &str,
    min: &str,
    max: &str,
    refresh: bool,
) -> Result<Collected, String> {
    let (mut events, mut needs_login, mut failed) = (Vec::new(), Vec::new(), HashMap::new());
    let mut calendar_failed = Vec::new();
    let accounts = auth
        .accounts(dir)
        .map_err(|e| log_failure(command, "-", e))?;
    let jobs = accounts
        .iter()
        .map(|account| {
            let (dir, auth, cache) = (dir.to_owned(), auth.clone(), cache.clone());
            let (account, min, max) = (account.clone(), min.to_owned(), max.to_owned());
            async move { account_events(&dir, &auth, &cache, &account, &min, &max, refresh).await }
        })
        .collect();
    let results = join_all(jobs)
        .await
        .map_err(|e| log_failure(command, "-", e))?;
    for (account, result) in accounts.into_iter().zip(results) {
        match result {
            Ok(Some(found)) => {
                events.extend(found.events);
                calendar_failed.extend(found.failed);
            }
            Ok(None) => {
                cache.0.lock().unwrap().remove(&account);
                needs_login.push(account);
            }
            Err(e) => {
                // The kept calendars may be what failed (e.g. one was deleted), so list them again next time.
                cache.0.lock().unwrap().remove(&account);
                let status = e.status;
                let message = log_failure(command, &account, e);
                match classify(status, &message) {
                    Failure::NeedsLogin => needs_login.push(account),
                    Failure::Message(m) => {
                        failed.insert(account, m);
                    }
                }
            }
        }
    }
    titled_first(&mut events);
    Ok(Collected {
        events,
        needs_login,
        failed,
        calendar_failed,
    })
}

/// The events of the local dates `from` to `to` (YYYY-MM-DD), `to` included, flat and without a layout.
/// The calendars are listed on every call (no kept list), as the caller is a long-lived process.
pub async fn list_events(dir: &Path, auth: &Auth, from: &str, to: &str) -> Result<Events, String> {
    let (min, max) = parse_range(&Local, from, to)?;
    let found = collect_events(
        dir,
        auth,
        &CalendarCache::default(),
        "list_events",
        &min,
        &max,
        true,
    )
    .await?;
    Ok(Events {
        events: flat_events(&found.events),
        needs_login: found.needs_login,
        failed: found.failed,
        calendar_failed: found.calendar_failed,
    })
}

/// The week containing `date` (YYYY-MM-DD, local), Sunday first, with the events of every account, the accounts fetched at once.
/// `refresh` lists each account's calendars again instead of using the kept lists.
/// Accounts needing login or failing to load, and calendars failing to load, are listed, not fatal.
#[tauri::command]
pub async fn calendar_week(
    app: AppHandle,
    auth: State<'_, Auth>,
    cache: State<'_, CalendarCache>,
    date: String,
    refresh: bool,
) -> Result<Week, String> {
    let date: NaiveDate = date
        .parse()
        .map_err(|_| format!("日付が不正です: {date}"))?;
    let start = week_start(date);
    let (min, max) = week_bounds(&Local, start).ok_or("週の範囲を求められません")?;
    let dir = config_dir(&app).map_err(|e| log_failure("calendar_week", "-", e))?;
    let found = collect_events(&dir, &auth, &cache, "calendar_week", &min, &max, refresh).await?;
    let (all_day, timed) = build_week(&Local, start, found.events);
    let week = Week {
        week_start: start.to_string(),
        all_day,
        timed,
        needs_login: found.needs_login,
        failed: found.failed,
        calendar_failed: found.calendar_failed,
    };
    if worth_caching(&week) {
        // Off the reply: the screen does not wait for the write and its fsync.
        let kept = week.clone();
        tokio::task::spawn_blocking(move || {
            let saved = disk_cache::update(&dir, CACHE_FILE, |c: Cached| Cached {
                weeks: with_week(c.weeks, kept, MAX_CACHED_WEEKS),
            });
            if let Err(e) = saved {
                log_failure("calendar_cache", "-", e);
            }
        });
    }
    Ok(week)
}

/// The file the last complete weeks are kept in.
pub(crate) const CACHE_FILE: &str = "calendar-cache.json";
/// Keep in step with `CAL_CACHE_MAX` in `src/main.js`.
const MAX_CACHED_WEEKS: usize = 10;

/// What `calendar-cache.json` holds: the weeks fetched last, oldest first.
#[derive(Serialize, Deserialize, Default)]
struct Cached {
    weeks: Vec<Week>,
}

/// Only a week that got every account and calendar is kept: a partial one would draw the missing events as gone.
fn worth_caching(week: &Week) -> bool {
    week.needs_login.is_empty() && week.failed.is_empty() && week.calendar_failed.is_empty()
}

/// `week` as the newest of `weeks`, in place of the kept week with the same start; the oldest beyond `max` are dropped.
fn with_week(mut weeks: Vec<Week>, week: Week, max: usize) -> Vec<Week> {
    weeks.retain(|w| w.week_start != week.week_start);
    weeks.push(week);
    let extra = weeks.len().saturating_sub(max);
    weeks.drain(..extra);
    weeks
}

/// The kept week of the week containing `date`, to draw before `calendar_week` answers. `None` when it is not kept.
#[tauri::command]
pub async fn calendar_cached(app: AppHandle, date: String) -> Result<Option<Week>, String> {
    let date: NaiveDate = date
        .parse()
        .map_err(|_| format!("日付が不正です: {date}"))?;
    let start = week_start(date).to_string();
    let dir = config_dir(&app)?;
    let cached = tokio::task::spawn_blocking(move || disk_cache::load::<Cached>(&dir, CACHE_FILE))
        .await
        .map_err(|e| e.to_string())?;
    Ok(cached.and_then(|c| c.weeks.into_iter().find(|w| w.week_start == start)))
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

    fn raw(summary: &str) -> RawEvent {
        RawEvent {
            account: "a@example.com".into(),
            color: None,
            calendar: "c".into(),
            summary: summary.into(),
            declined: false,
            ical_uid: String::new(),
            when: When::AllDay {
                start: date("2026-01-01"),
                end: date("2026-01-02"),
            },
        }
    }

    fn cal(color: Option<&str>) -> CalendarEntry {
        CalendarEntry {
            id: "id@example.com".into(),
            selected: true,
            background_color: color.map(Into::into),
            summary: Some("仕事".into()),
        }
    }

    fn api_time(date: &str, date_time: &str) -> ApiTime {
        ApiTime {
            date: (!date.is_empty()).then(|| date.to_string()),
            date_time: (!date_time.is_empty()).then(|| date_time.to_string()),
        }
    }

    fn timed(start: &str, end: &str) -> RawEvent {
        RawEvent {
            when: when(&api_time("", start), &api_time("", end)).unwrap(),
            ..raw("t")
        }
    }

    fn all_day(start: &str, end: &str) -> RawEvent {
        RawEvent {
            when: When::AllDay {
                start: date(start),
                end: date(end),
            },
            ..raw("d")
        }
    }

    #[test]
    fn join_all_runs_at_once_and_keeps_input_order() {
        // A paused clock jumps to the next timer, so the elapsed time is exact and load cannot sway it.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .unwrap();
        let sleeps = (0..3u64).map(|i| async move {
            tokio::time::sleep(std::time::Duration::from_millis(150 - i * 50)).await;
            i
        });
        // The paused clock exists only inside the runtime, so the start is read there too.
        let (got, elapsed) = rt.block_on(async {
            let started = tokio::time::Instant::now();
            let got = join_all(sleeps.collect()).await.unwrap();
            (got, started.elapsed())
        });
        assert_eq!(got, vec![0, 1, 2]);
        // At once: the longest sleep, 150 ms. One after another would take 300 ms.
        assert_eq!(elapsed, std::time::Duration::from_millis(150));
        let panicked = rt.block_on(join_all(vec![async { panic!("boom") }]));
        assert!(panicked.is_err());
    }

    #[test]
    fn week_starts_on_sunday() {
        assert_eq!(week_start(date("2026-10-29")), date("2026-10-25")); // Thursday
        assert_eq!(week_start(date("2026-10-25")), date("2026-10-25")); // Sunday
        assert_eq!(week_start(date("2026-10-31")), date("2026-10-25")); // Saturday
    }

    #[test]
    fn week_bounds_are_local_midnights_in_utc() {
        let (min, max) = week_bounds(&jst(), date("2026-10-25")).unwrap();
        assert_eq!(min, "2026-10-24T15:00:00Z");
        assert_eq!(max, "2026-10-31T15:00:00Z");
    }

    #[test]
    fn range_includes_the_last_day() {
        let (min, max) = parse_range(&jst(), "2026-10-29", "2026-10-30").unwrap();
        assert_eq!(min, "2026-10-28T15:00:00Z");
        assert_eq!(max, "2026-10-30T15:00:00Z");
        // One day: from == to.
        let (min, max) = parse_range(&jst(), "2026-10-29", "2026-10-29").unwrap();
        assert_eq!(
            (min.as_str(), max.as_str()),
            ("2026-10-28T15:00:00Z", "2026-10-29T15:00:00Z")
        );
    }

    #[test]
    fn range_rejects_bad_dates_and_reversed_order() {
        let bad = parse_range(&jst(), "2026-13-01", "2026-10-29").unwrap_err();
        assert!(bad.contains("2026-13-01"));
        assert!(parse_range(&jst(), "2026-10-29", "x").is_err());
        let reversed = parse_range(&jst(), "2026-10-30", "2026-10-29").unwrap_err();
        assert!(reversed.contains("以降"));
    }

    #[test]
    fn flat_events_are_sorted_deduplicated_and_all_day_ends_on_the_last_day() {
        let late = timed("2026-10-29T10:00:00+09:00", "2026-10-29T11:00:00+09:00");
        let mut dup = timed("2026-10-29T09:00:00+09:00", "2026-10-29T09:30:00+09:00");
        dup.ical_uid = "uid".into();
        let mut dup_other_account = dup.clone();
        dup_other_account.account = "b@example.com".into();
        let days = all_day("2026-10-29", "2026-10-31");
        let items = flat_events(&[late, dup, dup_other_account, days]);
        let shape: Vec<_> = items
            .iter()
            .map(|i| (i.all_day, i.start.as_str(), i.end.as_str()))
            .collect();
        assert_eq!(
            shape,
            [
                (true, "2026-10-29", "2026-10-30"),
                (
                    false,
                    "2026-10-29T09:00:00+09:00",
                    "2026-10-29T09:30:00+09:00"
                ),
                (
                    false,
                    "2026-10-29T10:00:00+09:00",
                    "2026-10-29T11:00:00+09:00"
                ),
            ]
        );
    }

    #[test]
    fn parses_all_day_and_timed_times() {
        assert_eq!(
            when(&api_time("2026-10-29", ""), &api_time("2026-10-30", "")),
            Some(When::AllDay {
                start: date("2026-10-29"),
                end: date("2026-10-30")
            })
        );
        // The offset of the event, not the viewer's, is what counts.
        let w = when(
            &api_time("", "2026-10-29T10:00:00-07:00"),
            &api_time("", "2026-10-29T11:00:00-07:00"),
        );
        let Some(When::Timed { start, end }) = w else {
            panic!("expected a timed event");
        };
        assert_eq!(
            start.with_timezone(&jst()).naive_local().to_string(),
            "2026-10-30 02:00:00"
        );
        assert_eq!((end - start).num_minutes(), 60);
        assert_eq!(when(&api_time("", ""), &api_time("", "")), None);
        assert_eq!(
            when(&api_time("", "garbage"), &api_time("", "garbage")),
            None
        );
    }

    #[test]
    fn all_day_event_without_end_lasts_one_day() {
        assert_eq!(
            when(&api_time("2026-10-29", ""), &ApiTime::default()),
            Some(When::AllDay {
                start: date("2026-10-29"),
                end: date("2026-10-30")
            })
        );
    }

    #[test]
    fn places_timed_event_in_local_day_and_minutes() {
        // 10:00-11:30 JST on Thursday 29th, written with a UTC offset.
        let e = timed("2026-10-29T01:00:00Z", "2026-10-29T02:30:00Z");
        let (all, segs) = build_week(&jst(), date("2026-10-25"), vec![e]);
        assert!(all.is_empty());
        assert_eq!(segs.len(), 1);
        assert_eq!(
            (segs[0].day, segs[0].start_min, segs[0].end_min),
            (4, 600, 690)
        );
        assert_eq!((segs[0].col, segs[0].cols), (0, 1));
    }

    #[test]
    fn splits_an_event_across_midnight_into_each_day() {
        let e = timed("2026-10-29T22:00:00+09:00", "2026-10-30T01:00:00+09:00");
        let (_, segs) = build_week(&jst(), date("2026-10-25"), vec![e]);
        let got: Vec<_> = segs
            .iter()
            .map(|s| (s.day, s.start_min, s.end_min))
            .collect();
        assert_eq!(got, vec![(4, 1320, 1440), (5, 0, 60)]);
    }

    #[test]
    fn drops_events_outside_the_week() {
        let before = timed("2026-10-24T22:00:00+09:00", "2026-10-24T23:00:00+09:00");
        let after = timed("2026-11-01T00:00:00+09:00", "2026-11-01T01:00:00+09:00");
        let ends_at_midnight = timed("2026-10-24T23:00:00+09:00", "2026-10-25T00:00:00+09:00");
        let (all, segs) = build_week(
            &jst(),
            date("2026-10-25"),
            vec![
                before,
                after,
                ends_at_midnight,
                all_day("2026-10-24", "2026-10-25"),
            ],
        );
        assert!(all.is_empty() && segs.is_empty());
    }

    #[test]
    fn multi_day_all_day_event_appears_in_each_day_inside_the_week() {
        // Starts before the week and ends (exclusive) on the 27th.
        let (all, _) = build_week(
            &jst(),
            date("2026-10-25"),
            vec![all_day("2026-10-23", "2026-10-27")],
        );
        assert_eq!(all.iter().map(|a| a.day).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn overlapping_timed_events_share_the_column_width() {
        let a = timed("2026-10-29T15:00:00+09:00", "2026-10-29T18:00:00+09:00");
        let b = timed("2026-10-29T15:00:00+09:00", "2026-10-29T16:00:00+09:00");
        let c = timed("2026-10-29T17:00:00+09:00", "2026-10-29T17:30:00+09:00");
        let (_, segs) = build_week(&jst(), date("2026-10-25"), vec![a, b, c]);
        let got: Vec<_> = segs.iter().map(|s| (s.col, s.cols)).collect();
        // a takes column 0, b column 1, c reuses column 1 once b has ended.
        assert_eq!(got, vec![(0, 2), (1, 2), (1, 2)]);
    }

    #[test]
    fn assign_columns_separates_clusters() {
        // [0,60) and [30,90) overlap; [90,120) starts as the cluster ends.
        let got = assign_columns(&[(0, 60), (30, 90), (90, 120)]);
        assert_eq!(got, vec![(0, 2), (1, 2), (0, 1)]);
        assert_eq!(assign_columns(&[]), vec![]);
    }

    #[test]
    fn assign_columns_keeps_input_order_and_chains_overlaps() {
        // [0,40) overlaps [30,70) overlaps [60,100), but the first and the last do not overlap.
        let got = assign_columns(&[(60, 100), (0, 40), (30, 70)]);
        assert_eq!(got, vec![(0, 2), (0, 2), (1, 2)]);
    }

    #[test]
    fn short_events_are_laid_out_with_a_minimum_length() {
        // A zero-length event still occupies MIN_MINUTES, so one starting inside it must not share its column.
        let a = timed("2026-10-29T10:00:00+09:00", "2026-10-29T10:00:00+09:00");
        let b = timed("2026-10-29T10:10:00+09:00", "2026-10-29T11:00:00+09:00");
        let (_, segs) = build_week(&jst(), date("2026-10-25"), vec![a, b]);
        assert_eq!(segs[0].end_min, 600);
        assert_eq!((segs[0].col, segs[0].cols), (0, 2));
        assert_eq!((segs[1].col, segs[1].cols), (1, 2));
    }

    #[test]
    fn same_event_on_two_accounts_is_shown_once() {
        let mut a = timed("2026-10-29T10:00:00+09:00", "2026-10-29T11:00:00+09:00");
        a.ical_uid = "uid-1".into();
        let mut b = a.clone();
        b.account = "b@example.com".into();
        let mut other = a.clone();
        other.ical_uid = "uid-2".into();
        let (_, segs) = build_week(&jst(), date("2026-10-25"), vec![a, b, other]);
        assert_eq!(segs.len(), 2);
        // An event with no iCalUID is never merged with another.
        let (all, _) = build_week(&jst(), date("2026-01-01"), vec![raw("x"), raw("y")]);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn the_titled_copy_of_an_event_is_kept() {
        let mut untitled = timed("2026-10-30T16:00:00+09:00", "2026-10-30T18:00:00+09:00");
        untitled.summary = String::new();
        untitled.ical_uid = "uid".into();
        let titled = RawEvent {
            summary: "ブロック".into(),
            account: "b@example.com".into(),
            ..untitled.clone()
        };
        let mut events = vec![untitled, titled];
        titled_first(&mut events);
        let items = flat_events(&events);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].summary, "ブロック");
        let (_, segs) = build_week(&jst(), date("2026-10-25"), events);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].info.summary, "ブロック");
    }

    #[test]
    fn declined_when_self_attendee_declined() {
        let ev: ApiEvent = serde_json::from_str(
            r#"{"summary":"s","iCalUID":"u","start":{"date":"2026-10-29"},"end":{"date":"2026-10-30"},
                "attendees":[{"responseStatus":"accepted"},{"self":true,"responseStatus":"declined"}]}"#,
        )
        .unwrap();
        let r = RawEvent::from_api(ev, "a@example.com", &cal(Some("#fff"))).unwrap();
        assert!(r.declined);
        assert_eq!(r.calendar, "仕事");
        assert_eq!(r.ical_uid, "u");
        assert_eq!(r.color.as_deref(), Some("#fff"));
        // Someone else's declined does not count.
        let ev: ApiEvent = serde_json::from_str(
            r#"{"start":{"date":"2026-10-29"},"end":{"date":"2026-10-30"},
                "attendees":[{"responseStatus":"declined"},{"self":true,"responseStatus":"accepted"}]}"#,
        )
        .unwrap();
        assert!(
            !RawEvent::from_api(ev, "a@example.com", &cal(None))
                .unwrap()
                .declined
        );
    }

    #[test]
    fn event_without_a_usable_time_is_skipped() {
        let ev: ApiEvent = serde_json::from_str(r#"{"summary":"s"}"#).unwrap();
        assert!(RawEvent::from_api(ev, "a@example.com", &cal(None)).is_none());
    }

    #[test]
    fn insufficient_scope_means_login_again() {
        let body = r#"{"error":{"code":403,"message":"Request had insufficient authentication scopes.","errors":[{"reason":"insufficientPermissions"}],"details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}"#;
        assert_eq!(classify(Some(403), body), Failure::NeedsLogin);
        assert_eq!(
            classify(Some(403), "ACCESS_TOKEN_SCOPE_INSUFFICIENT"),
            Failure::NeedsLogin
        );
    }

    #[test]
    fn disabled_api_is_reported_in_japanese() {
        for body in ["accessNotConfigured", "SERVICE_DISABLED"] {
            let Failure::Message(m) = classify(Some(403), body) else {
                panic!("expected a message");
            };
            assert!(m.contains("Calendar API") && m.contains("有効"));
        }
    }

    #[test]
    fn other_failures_keep_their_message() {
        assert_eq!(classify(Some(500), "boom"), Failure::Message("boom".into()));
        assert_eq!(
            classify(None, "network"),
            Failure::Message("network".into())
        );
        // A 403 for another reason is not a re-login.
        assert_eq!(
            classify(Some(403), "forbidden"),
            Failure::Message("forbidden".into())
        );
    }

    #[test]
    fn only_account_wide_failures_stop_the_whole_account() {
        assert!(is_account_wide(
            Some(403),
            "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
        ));
        assert!(is_account_wide(Some(403), "accessNotConfigured"));
        assert!(is_account_wide(Some(403), "SERVICE_DISABLED"));
        // A deleted calendar, a forbidden one, a server error and a network error concern one calendar.
        assert!(!is_account_wide(Some(404), "notFound"));
        assert!(!is_account_wide(Some(410), "deleted"));
        assert!(!is_account_wide(Some(403), "forbidden"));
        assert!(!is_account_wide(Some(500), "boom"));
        assert!(!is_account_wide(None, "network"));
    }

    #[test]
    fn calendar_failure_names_the_calendar_or_falls_back_to_its_id() {
        let cal = |id: &str, summary: Option<&str>| CalendarEntry {
            id: id.into(),
            selected: true,
            background_color: None,
            summary: summary.map(Into::into),
        };
        assert_eq!(
            calendar_failure("a@example.com", &cal("id1", Some("仕事")), "boom"),
            "a@example.com のカレンダー「仕事」の予定を読み込めませんでした: boom"
        );
        for summary in [None, Some("")] {
            assert_eq!(
                calendar_failure("a@example.com", &cal("id1", summary), "boom"),
                "a@example.com のカレンダー「id1」の予定を読み込めませんでした: boom"
            );
        }
    }

    #[test]
    fn events_url_keeps_a_calendar_id_in_one_path_segment() {
        assert_eq!(
            events_url("a@example.com").unwrap(),
            format!("{CALENDARS_URL}/a@example.com/events")
        );
        assert_eq!(
            events_url("en.japanese#holiday@group.v.calendar.google.com").unwrap(),
            format!("{CALENDARS_URL}/en.japanese%23holiday@group.v.calendar.google.com/events")
        );
        assert_eq!(
            events_url("x/../y?z").unwrap(),
            format!("{CALENDARS_URL}/x%2F..%2Fy%3Fz/events")
        );
        // `push` would treat these as dot segments and drop the ID from the path.
        for id in ["", ".", ".."] {
            assert_eq!(events_url(id), Err("カレンダー ID が不正です".into()));
        }
    }

    #[test]
    fn week_serializes_in_camel_case() {
        let w = Week {
            week_start: "2026-10-25".into(),
            all_day: vec![AllDayItem {
                day: 1,
                info: Info {
                    summary: "s".into(),
                    color: None,
                    account: "a@example.com".into(),
                    declined: true,
                },
            }],
            timed: vec![],
            needs_login: vec!["b@example.com".into()],
            failed: Default::default(),
            calendar_failed: vec!["x".into()],
        };
        let v = serde_json::to_value(&w).unwrap();
        assert_eq!(v["weekStart"], "2026-10-25");
        assert_eq!(v["allDay"][0]["day"], 1);
        assert_eq!(v["allDay"][0]["declined"], true);
        assert_eq!(v["needsLogin"][0], "b@example.com");
        assert_eq!(v["calendarFailed"][0], "x");
    }

    fn week_of(start: &str) -> Week {
        Week {
            week_start: start.into(),
            all_day: vec![],
            timed: vec![TimedItem {
                day: 2,
                start_min: 60,
                end_min: 120,
                col: 0,
                cols: 1,
                info: Info {
                    summary: start.into(),
                    color: Some("#fff".into()),
                    account: "a@example.com".into(),
                    declined: false,
                },
            }],
            needs_login: vec![],
            failed: Default::default(),
            calendar_failed: vec![],
        }
    }

    fn starts(weeks: &[Week]) -> Vec<&str> {
        weeks.iter().map(|w| w.week_start.as_str()).collect()
    }

    #[test]
    fn week_round_trips_through_json() {
        let w = week_of("2026-10-25");
        let back: Week = serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
        assert_eq!(back, w);
    }

    #[test]
    fn only_a_complete_week_is_kept() {
        assert!(worth_caching(&week_of("2026-10-25")));
        let needs_login = Week {
            needs_login: vec!["a@example.com".into()],
            ..week_of("2026-10-25")
        };
        assert!(!worth_caching(&needs_login));
        let failed = Week {
            failed: [("a@example.com".to_string(), "boom".to_string())].into(),
            ..week_of("2026-10-25")
        };
        assert!(!worth_caching(&failed));
        let calendar_failed = Week {
            calendar_failed: vec!["x".into()],
            ..week_of("2026-10-25")
        };
        assert!(!worth_caching(&calendar_failed));
    }

    #[test]
    fn a_new_week_is_the_newest_and_the_oldest_beyond_the_limit_go() {
        let weeks = vec![week_of("w1"), week_of("w2"), week_of("w3")];
        assert_eq!(
            starts(&with_week(weeks.clone(), week_of("w4"), 3)),
            ["w2", "w3", "w4"]
        );
        assert_eq!(
            starts(&with_week(weeks.clone(), week_of("w4"), 4)),
            ["w1", "w2", "w3", "w4"]
        );
        assert_eq!(starts(&with_week(vec![], week_of("w1"), 3)), ["w1"]);
    }

    #[test]
    fn a_fetched_week_replaces_the_kept_one_and_becomes_the_newest() {
        let weeks = vec![week_of("w1"), week_of("w2"), week_of("w3")];
        let mut fresh = week_of("w1");
        fresh.calendar_failed = vec![];
        fresh.timed.clear();
        let out = with_week(weeks, fresh, 3);
        assert_eq!(starts(&out), ["w2", "w3", "w1"]);
        assert!(out[2].timed.is_empty());
    }
}
