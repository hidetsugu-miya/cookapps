use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
};

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, Local, NaiveDate, NaiveTime, SecondsFormat,
    TimeZone, Timelike, Utc,
};
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, State};
#[cfg(test)]
use ts_rs::TS;
use url::Url;

use crate::{
    accounts::{self, write_synced},
    auth::{config_dir, Auth},
    disk_cache,
    gmail::{log_failure, send_json_refreshing, ApiError},
};

const CALENDAR_LIST_URL: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
/// The `fields` of an event list: what `list_events` needs, and what the detail of the week adds.
const EVENT_FIELDS: &str =
    "nextPageToken,items(summary,iCalUID,start,end,attendees(self,responseStatus))";
const EVENT_DETAIL_FIELDS: &str = "nextPageToken,items(summary,iCalUID,start,end,description,location,hangoutLink,attendees(self,responseStatus,resource))";
const CALENDARS_URL: &str = "https://www.googleapis.com/calendar/v3/calendars";
// shortcut: past this many pages (2500 events of one calendar) the rest is dropped, upgrade if a week ever needs more.
const MAX_PAGES: usize = 10;
/// A shorter event is laid out as if it lasted this long, so it stays visible.
/// Keep in step with `MIN_EVENT_MIN` in `ts/calendar.ts`.
const MIN_MINUTES: u32 = 20;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ApiTime {
    /// All-day events carry a date only.
    date: Option<String>,
    date_time: Option<String>,
}

/// The user's own answer to an invitation. `Unknown` covers a non-attendee and any value the API adds later.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum ResponseStatus {
    Accepted,
    Declined,
    Tentative,
    NeedsAction,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize)]
struct Attendee {
    #[serde(default, rename = "self")]
    is_self: bool,
    #[serde(default, rename = "responseStatus")]
    response_status: ResponseStatus,
    /// A room or other resource, not a person.
    #[serde(default)]
    resource: bool,
}

/// How many people are invited (rooms left out), and how many of them accepted.
fn attendee_counts(attendees: &[Attendee]) -> (u32, u32) {
    let people = attendees.iter().filter(|a| !a.resource);
    let accepted = people
        .clone()
        .filter(|a| a.response_status == ResponseStatus::Accepted);
    (people.count() as u32, accepted.count() as u32)
}

/// The Meet link of the event: only an address on `meet.google.com`, so the screen never offers a link to anywhere else.
fn meet_url(link: Option<&str>) -> Option<String> {
    link.filter(|l| l.starts_with("https://meet.google.com/"))
        .map(str::to_owned)
}

/// `None` for a missing or blank text.
fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|t| !t.trim().is_empty())
}

/// Longest description kept, in characters; a multi-day event carries it once per day on the screen and in the cache.
const DESCRIPTION_MAX: usize = 10_000;

/// `text` cut to `DESCRIPTION_MAX` characters, never inside a character.
fn clip_description(text: String) -> String {
    match text.char_indices().nth(DESCRIPTION_MAX) {
        Some((end, _)) => text[..end].to_owned(),
        None => text,
    }
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
    #[serde(rename = "hangoutLink")]
    hangout_link: Option<String>,
    location: Option<String>,
    description: Option<String>,
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
    /// `owner` for the user's own calendars; anything else (or none) is a calendar of someone else's, a holiday list, a room and so on.
    access_role: Option<String>,
}

impl CalendarEntry {
    fn is_mine(&self) -> bool {
        self.access_role.as_deref() == Some("owner")
    }

    fn name(&self) -> &str {
        self.summary
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.id)
    }
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
    response: ResponseStatus,
    ical_uid: String,
    meet_url: Option<String>,
    location: Option<String>,
    description: Option<String>,
    /// Invited people (rooms left out), and how many of them accepted.
    attendees: u32,
    accepted: u32,
    when: When,
}

impl RawEvent {
    fn from_api(e: ApiEvent, account: &str, cal: &CalendarEntry) -> Option<Self> {
        let (attendees, accepted) = attendee_counts(&e.attendees);
        Some(Self {
            when: when(&e.start, &e.end)?,
            response: e
                .attendees
                .iter()
                .find(|a| a.is_self)
                .map(|a| a.response_status)
                .unwrap_or_default(),
            account: account.to_owned(),
            color: cal.background_color.clone(),
            calendar: cal.summary.clone().unwrap_or_else(|| cal.id.clone()),
            summary: e.summary,
            ical_uid: e.ical_uid,
            meet_url: meet_url(e.hangout_link.as_deref()),
            location: non_empty(e.location),
            description: non_empty(e.description).map(clip_description),
            attendees,
            accepted,
        })
    }
}

const WEEKDAY_NAMES: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];

/// `11月2日（月）`.
fn day_text(d: NaiveDate) -> String {
    format!(
        "{}月{}日（{}）",
        d.month(),
        d.day(),
        WEEKDAY_NAMES[d.weekday().num_days_from_sunday() as usize]
    )
}

/// The time of an event as the detail shows it, in `tz`: `11月2日（月）13:00 - 14:30`, across midnight `11月2日（月）23:00 - 11月3日（火）1:00`,
/// all day `11月3日（火）終日`, several days `11月3日（火）- 11月5日（木）`. An event that ends where it starts shows its start only.
fn when_text<Tz: TimeZone>(tz: &Tz, when: &When) -> String {
    match when {
        When::AllDay { start, end } => {
            // The API's end date is exclusive.
            let last = (*end - Duration::days(1)).max(*start);
            if last == *start {
                format!("{}終日", day_text(*start))
            } else {
                format!("{}- {}", day_text(*start), day_text(last))
            }
        }
        When::Timed { start, end } => {
            let (s, e) = (
                start.with_timezone(tz).naive_local(),
                end.with_timezone(tz).naive_local(),
            );
            let clock = |t: NaiveTime| format!("{}:{:02}", t.hour(), t.minute());
            let from = format!("{}{}", day_text(s.date()), clock(s.time()));
            if e <= s {
                from
            } else if e.date() == s.date() {
                format!("{from} - {}", clock(e.time()))
            } else {
                format!("{from} - {}{}", day_text(e.date()), clock(e.time()))
            }
        }
    }
}

/// What the screen needs of an event besides where it goes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Info {
    summary: String,
    /// `None` means the screen picks one from the account.
    color: Option<String>,
    account: String,
    /// Absent in a cache an older version wrote.
    #[serde(default)]
    response: ResponseStatus,
    /// Name of the calendar the event is on. This and the fields below are absent in a cache an older version wrote (empty text, `None`, 0).
    #[serde(default)]
    calendar: String,
    /// The time as the detail shows it, e.g. `11月2日（月）13:00 - 14:30`.
    #[serde(default)]
    when_text: String,
    /// A `https://meet.google.com/` link, else `None`.
    #[serde(default)]
    meet_url: Option<String>,
    #[serde(default)]
    location: Option<String>,
    /// As Google sends it: plain text or a little HTML.
    #[serde(default)]
    description: Option<String>,
    /// Invited people (rooms left out), and how many of them accepted.
    #[serde(default)]
    attendees: u32,
    #[serde(default)]
    accepted: u32,
}

impl Info {
    /// `tz` is the zone the times are shown in.
    fn new<Tz: TimeZone>(e: &RawEvent, tz: &Tz) -> Self {
        Self {
            summary: e.summary.clone(),
            color: e.color.clone(),
            account: e.account.clone(),
            response: e.response,
            calendar: e.calendar.clone(),
            when_text: when_text(tz, &e.when),
            meet_url: e.meet_url.clone(),
            location: e.location.clone(),
            description: e.description.clone(),
            attendees: e.attendees,
            accepted: e.accepted,
        }
    }
}

/// An all-day event on one day of the week (0 = the first day). A multi-day event gets one item per day.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct AllDayItem {
    day: usize,
    #[serde(flatten)]
    info: Info,
}

/// A timed event on one day of the week, in minutes from local midnight, with its column among overlapping events.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
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
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Week {
    /// Local date (YYYY-MM-DD) of the day the week starts on (the first day of the week the setting names).
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
            declined: e.response == ResponseStatus::Declined,
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

/// The first day of the week as the setting holds it: 0 = Sunday to 6 = Saturday.
fn check_first_day(first_day: u8) -> Result<u8, String> {
    if first_day <= 6 {
        Ok(first_day)
    } else {
        Err(format!("週の始まりが不正です: {first_day}"))
    }
}

/// The first day of the week (`first_day`, 0 = Sunday) on or before `date`.
fn week_start(date: NaiveDate, first_day: u8) -> Result<NaiveDate, String> {
    let first_day = u32::from(check_first_day(first_day)?);
    let back = (date.weekday().num_days_from_sunday() + 7 - first_day) % 7;
    Ok(date - Duration::days(back.into()))
}

const SETTINGS_FILE: &str = "calendar-settings.json";
const SETTINGS_TMP_FILE: &str = "calendar-settings.json.tmp";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    first_day: u8,
}

/// The first day a settings file holds. A file that does not say a valid one gives Sunday.
fn parse_first_day(text: &str) -> u8 {
    serde_json::from_str::<SettingsFile>(text)
        .ok()
        .and_then(|f| check_first_day(f.first_day).ok())
        .unwrap_or(0)
}

fn load_first_day(dir: &Path) -> u8 {
    std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .map(|text| parse_first_day(&text))
        .unwrap_or(0)
}

fn save_first_day(dir: &Path, first_day: u8) -> Result<(), String> {
    let first_day = check_first_day(first_day)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(SETTINGS_FILE), dir.join(SETTINGS_TMP_FILE));
    let text =
        serde_json::to_string_pretty(&SettingsFile { first_day }).map_err(|e| e.to_string())?;
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// The first day of the week: 0 = Sunday (the default) to 6 = Saturday.
#[tauri::command]
pub async fn calendar_first_day(app: AppHandle) -> Result<u8, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || load_first_day(&dir))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_calendar_first_day(app: AppHandle, first_day: u8) -> Result<(), String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || save_first_day(&dir, first_day))
        .await
        .map_err(|e| e.to_string())?
}

const SELECTION_FILE: &str = "calendar-selection.json";
/// The longest calendar ID a choice may name, in bytes.
const CALENDAR_ID_MAX: usize = 1024;

/// Which calendars the owner chose to show, as `calendar-selection.json` holds them: for each account, the calendar ID and whether it is shown.
/// A calendar that was never chosen is not in it, and follows `selected` at Google. Google's own `selected` is never written.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Clone)]
struct Selection {
    #[serde(default)]
    accounts: HashMap<String, HashMap<String, bool>>,
}

impl Selection {
    fn chosen(&self, account: &str, id: &str) -> Option<bool> {
        self.accounts.get(account)?.get(id).copied()
    }

    fn shown(&self, account: &str, cal: &CalendarEntry) -> bool {
        self.chosen(account, &cal.id).unwrap_or(cal.selected)
    }

    /// This selection with the calendar's choice set. `None` when that choice is already saved.
    fn with_shown(&self, account: &str, id: &str, shown: bool) -> Option<Self> {
        if self.chosen(account, id) == Some(shown) {
            return None;
        }
        let mut next = self.clone();
        next.accounts
            .entry(account.to_owned())
            .or_default()
            .insert(id.to_owned(), shown);
        Some(next)
    }

    /// This selection without the account's choices. `None` when it holds none.
    fn without_account(&self, account: &str) -> Option<Self> {
        if !self.accounts.contains_key(account) {
            return None;
        }
        let mut next = self.clone();
        next.accounts.remove(account);
        Some(next)
    }
}

/// The calendars of one account to read events from: those shown by `selection`, in the order given.
fn visible(
    calendars: &[CalendarEntry],
    account: &str,
    selection: &Selection,
) -> Vec<CalendarEntry> {
    calendars
        .iter()
        .filter(|c| selection.shown(account, c))
        .cloned()
        .collect()
}

/// One calendar of an account as the screen lists it.
#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct CalendarChoice {
    id: String,
    /// The calendar's name, or its ID without one.
    name: String,
    /// `None` means the screen picks one from the account.
    color: Option<String>,
    /// `true` for a calendar the user owns ("マイカレンダー"), `false` for the others ("他のカレンダー").
    mine: bool,
    shown: bool,
}

/// The calendars of one account to list, in the order Google gives them.
fn choices(
    calendars: &[CalendarEntry],
    account: &str,
    selection: &Selection,
) -> Vec<CalendarChoice> {
    calendars
        .iter()
        .map(|c| CalendarChoice {
            id: c.id.clone(),
            name: c.name().to_owned(),
            color: c.background_color.clone(),
            mine: c.is_mine(),
            shown: selection.shown(account, c),
        })
        .collect()
}

#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct AccountCalendars {
    account: String,
    calendars: Vec<CalendarChoice>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct CalendarChoices {
    accounts: Vec<AccountCalendars>,
    /// Accounts whose calendars are missing because they must log in again.
    needs_login: Vec<String>,
    /// Accounts whose calendars are missing because loading them failed, with the error to show.
    failed: HashMap<String, String>,
}

/// The saved selection. A missing or broken file means nothing was chosen.
fn load_selection(dir: &Path) -> Selection {
    disk_cache::load(dir, SELECTION_FILE).unwrap_or_default()
}

/// A choice names a logged-in account and a calendar ID that fits in one path segment of the events URL.
fn check_choice(accounts: &[String], account: &str, calendar_id: &str) -> Result<(), String> {
    if !accounts.iter().any(|a| a == account) {
        return Err("登録されていないアカウントです".into());
    }
    if calendar_id.is_empty()
        || calendar_id.len() > CALENDAR_ID_MAX
        || calendar_id.chars().any(char::is_control)
    {
        return Err("カレンダー ID が不正です".into());
    }
    Ok(())
}

fn save_shown(dir: &Path, account: &str, calendar_id: &str, shown: bool) -> Result<(), String> {
    let listed = accounts::load(dir)?.unwrap_or_default();
    check_choice(&listed, account, calendar_id)?;
    // The kept weeks hold the events of the calendar just hidden, so a changed choice drops them under the same lock.
    disk_cache::update_and_remove(
        dir,
        SELECTION_FILE,
        [account],
        |s: Selection| s.with_shown(account, calendar_id, shown),
        &[CACHE_FILE],
    )
}

/// Forgets the account's choices. Call it inside `disk_cache::exclusive`, as `remove_account` does.
pub(crate) fn forget_selection(dir: &Path, account: &str) -> Result<(), String> {
    disk_cache::rewrite(
        dir,
        SELECTION_FILE,
        |s: Selection| s.without_account(account),
        &[],
    )
}

/// Shows or hides one calendar of one account in the week, and keeps the choice.
#[tauri::command]
pub async fn set_calendar_shown(
    app: AppHandle,
    account: String,
    calendar_id: String,
    shown: bool,
) -> Result<(), String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || save_shown(&dir, &account, &calendar_id, shown))
        .await
        .map_err(|e| e.to_string())?
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
        let info = Info::new(e, tz);
        for day in 0..7 {
            let d = start + Duration::days(day as i64);
            match &e.when {
                When::AllDay { start: s, end } => {
                    if *s <= d && d < *end {
                        all_day.push(AllDayItem {
                            day,
                            info: info.clone(),
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
                            info: info.clone(),
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
    let name = cal.name();
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

/// All the calendars of each account (shown or not), kept in memory for the run so a week does not list them again.
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

/// Every calendar of one account, not only the ones Google selected. `Ok(None)` means that account must log in again.
async fn listed_calendars(
    dir: &Path,
    auth: &Auth,
    account: &str,
) -> Result<Option<Vec<CalendarEntry>>, ApiError> {
    let list_query = [
        ("maxResults", "250"),
        (
            "fields",
            "nextPageToken,items(id,selected,backgroundColor,summary,accessRole)",
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
    Ok(Some(pages.into_iter().flat_map(|p| p.items).collect()))
}

/// Every calendar of one account, from the kept list unless `refresh`. `Ok(None)` means that account must log in again.
async fn account_calendars(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    account: &str,
    refresh: bool,
) -> Result<Option<Vec<CalendarEntry>>, ApiError> {
    let kept = if refresh {
        None
    } else {
        cache.0.lock().unwrap().get(account).cloned()
    };
    if let Some(c) = kept {
        return Ok(Some(c));
    }
    let Some(c) = listed_calendars(dir, auth, account).await? else {
        return Ok(None);
    };
    cache
        .0
        .lock()
        .unwrap()
        .insert(account.to_owned(), c.clone());
    Ok(Some(c))
}

/// Events in `[min, max)` of one calendar. `Ok(None)` means `account` must log in again.
async fn calendar_events(
    dir: &Path,
    auth: &Auth,
    account: &str,
    cal: &CalendarEntry,
    min: &str,
    max: &str,
    fields: &str,
) -> Result<Option<Vec<RawEvent>>, ApiError> {
    let event_query = [
        ("singleEvents", "true"),
        ("orderBy", "startTime"),
        ("timeMin", min),
        ("timeMax", max),
        ("maxResults", "250"),
        ("fields", fields),
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

/// Events in `[min, max)` of every calendar of one account that `selection` shows, the calendars fetched at once.
/// `refresh` lists the calendars again instead of using the kept list. `Ok(None)` means that account must log in again.
/// A failure of the whole account is an `Err`; a failure of one calendar leaves that calendar out and is listed in `failed`.
#[allow(clippy::too_many_arguments)]
async fn account_events(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    selection: &Selection,
    account: &str,
    min: &str,
    max: &str,
    fields: &str,
    refresh: bool,
) -> Result<Option<AccountEvents>, ApiError> {
    let Some(listed) = account_calendars(dir, auth, cache, account, refresh).await? else {
        return Ok(None);
    };
    let calendars = visible(&listed, account, selection);
    let jobs = calendars
        .iter()
        .cloned()
        .map(|cal| {
            let (dir, auth, account) = (dir.to_owned(), auth.clone(), account.to_owned());
            let (min, max, fields) = (min.to_owned(), max.to_owned(), fields.to_owned());
            async move { calendar_events(&dir, &auth, &account, &cal, &min, &max, &fields).await }
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
/// and calendars failing to load, are listed, not fatal. `command` names the caller in the failure log. `fields` is the `fields` query of the event lists.
#[allow(clippy::too_many_arguments)]
async fn collect_events(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    command: &str,
    min: &str,
    max: &str,
    fields: &str,
    refresh: bool,
) -> Result<Collected, String> {
    let (mut events, mut needs_login, mut failed) = (Vec::new(), Vec::new(), HashMap::new());
    let mut calendar_failed = Vec::new();
    let selection = load_selection(dir);
    let accounts = auth
        .accounts(dir)
        .map_err(|e| log_failure(command, "-", e))?;
    let jobs = accounts
        .iter()
        .map(|account| {
            let (dir, auth, cache) = (dir.to_owned(), auth.clone(), cache.clone());
            let (account, min, max) = (account.clone(), min.to_owned(), max.to_owned());
            let (fields, selection) = (fields.to_owned(), selection.clone());
            async move {
                account_events(
                    &dir, &auth, &cache, &selection, &account, &min, &max, &fields, refresh,
                )
                .await
            }
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
        EVENT_FIELDS,
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

/// The calendars of every account, each with whether it is shown. Accounts needing login or failing to load are listed, not fatal.
#[tauri::command]
pub async fn calendar_choices(
    app: AppHandle,
    auth: State<'_, Auth>,
    cache: State<'_, CalendarCache>,
) -> Result<CalendarChoices, String> {
    let dir = config_dir(&app).map_err(|e| log_failure("calendar_choices", "-", e))?;
    let selection = load_selection(&dir);
    let accounts = auth
        .accounts(&dir)
        .map_err(|e| log_failure("calendar_choices", "-", e))?;
    let jobs = accounts
        .iter()
        .map(|account| {
            let (dir, auth, cache) = (dir.clone(), auth.inner().clone(), cache.inner().clone());
            let account = account.clone();
            async move { account_calendars(&dir, &auth, &cache, &account, false).await }
        })
        .collect();
    let results = join_all(jobs)
        .await
        .map_err(|e| log_failure("calendar_choices", "-", e))?;
    let mut out = CalendarChoices {
        accounts: Vec::new(),
        needs_login: Vec::new(),
        failed: HashMap::new(),
    };
    for (account, result) in accounts.into_iter().zip(results) {
        match result {
            Ok(Some(calendars)) => out.accounts.push(AccountCalendars {
                calendars: choices(&calendars, &account, &selection),
                account,
            }),
            Ok(None) => {
                cache.forget(&account);
                out.needs_login.push(account);
            }
            Err(e) => {
                cache.forget(&account);
                let status = e.status;
                let message = log_failure("calendar_choices", &account, e);
                match classify(status, &message) {
                    Failure::NeedsLogin => out.needs_login.push(account),
                    Failure::Message(m) => {
                        out.failed.insert(account, m);
                    }
                }
            }
        }
    }
    Ok(out)
}

/// The week containing `date` (YYYY-MM-DD, local), starting on `first_day` (0 = Sunday to 6 = Saturday), with the events of every account, the accounts fetched at once.
/// `refresh` lists each account's calendars again instead of using the kept lists.
/// Accounts needing login or failing to load, and calendars failing to load, are listed, not fatal.
#[tauri::command]
pub async fn calendar_week(
    app: AppHandle,
    auth: State<'_, Auth>,
    cache: State<'_, CalendarCache>,
    date: String,
    first_day: u8,
    refresh: bool,
) -> Result<Week, String> {
    let date: NaiveDate = date
        .parse()
        .map_err(|_| format!("日付が不正です: {date}"))?;
    let start = week_start(date, first_day)?;
    let (min, max) = week_bounds(&Local, start).ok_or("週の範囲を求められません")?;
    let dir = config_dir(&app).map_err(|e| log_failure("calendar_week", "-", e))?;
    let found = collect_events(
        &dir,
        &auth,
        &cache,
        "calendar_week",
        &min,
        &max,
        EVENT_DETAIL_FIELDS,
        refresh,
    )
    .await?;
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
            let used: Vec<String> = kept.accounts().map(str::to_owned).collect();
            let saved = disk_cache::update(
                &dir,
                CACHE_FILE,
                used.iter().map(String::as_str),
                |c: Cached| {
                    with_week(c.weeks, kept, MAX_CACHED_WEEKS).map(|weeks| Cached { weeks })
                },
            );
            if let Err(e) = saved {
                log_failure("calendar_cache", "-", e);
            }
        });
    }
    Ok(week)
}

/// The file the last complete weeks are kept in.
pub(crate) const CACHE_FILE: &str = "calendar-cache.json";
/// Keep in step with `CAL_CACHE_MAX` in `ts/calendar.ts`.
const MAX_CACHED_WEEKS: usize = 10;

/// What `calendar-cache.json` holds: the weeks fetched last, oldest first.
#[derive(Serialize, Deserialize, Default)]
struct Cached {
    weeks: Vec<Week>,
}

impl Week {
    /// The accounts whose events are in the week.
    fn accounts(&self) -> impl Iterator<Item = &str> {
        let all_day = self.all_day.iter().map(|i| i.info.account.as_str());
        all_day.chain(self.timed.iter().map(|i| i.info.account.as_str()))
    }
}

/// Only a week that got every account and calendar is kept: a partial one would draw the missing events as gone.
fn worth_caching(week: &Week) -> bool {
    week.needs_login.is_empty() && week.failed.is_empty() && week.calendar_failed.is_empty()
}

/// `week` as the newest of `weeks`, in place of the kept week with the same start; the oldest beyond `max` are dropped.
/// `None` when that kept week is already the same, so nothing needs writing.
fn with_week(mut weeks: Vec<Week>, week: Week, max: usize) -> Option<Vec<Week>> {
    if weeks.contains(&week) {
        return None;
    }
    weeks.retain(|w| w.week_start != week.week_start);
    weeks.push(week);
    let extra = weeks.len().saturating_sub(max);
    weeks.drain(..extra);
    Some(weeks)
}

/// The kept weeks, to draw before `calendar_week` answers. Empty when none is kept.
#[tauri::command]
pub async fn calendar_cached(app: AppHandle) -> Result<Vec<Week>, String> {
    let dir = config_dir(&app)?;
    let cached = tokio::task::spawn_blocking(move || disk_cache::load::<Cached>(&dir, CACHE_FILE))
        .await
        .map_err(|e| e.to_string())?;
    Ok(cached.map(|c| c.weeks).unwrap_or_default())
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
            response: ResponseStatus::Unknown,
            ical_uid: String::new(),
            meet_url: None,
            location: None,
            description: None,
            attendees: 0,
            accepted: 0,
            when: When::AllDay {
                start: date("2026-01-01"),
                end: date("2026-01-02"),
            },
        }
    }

    fn info(summary: &str, color: Option<&str>, response: ResponseStatus) -> Info {
        Info {
            summary: summary.into(),
            color: color.map(Into::into),
            account: "a@example.com".into(),
            response,
            calendar: "c".into(),
            when_text: String::new(),
            meet_url: None,
            location: None,
            description: None,
            attendees: 0,
            accepted: 0,
        }
    }

    fn cal(color: Option<&str>) -> CalendarEntry {
        CalendarEntry {
            id: "id@example.com".into(),
            selected: true,
            background_color: color.map(Into::into),
            summary: Some("仕事".into()),
            access_role: Some("owner".into()),
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
        assert_eq!(week_start(date("2026-10-29"), 0), Ok(date("2026-10-25"))); // Thursday
        assert_eq!(week_start(date("2026-10-25"), 0), Ok(date("2026-10-25"))); // Sunday
        assert_eq!(week_start(date("2026-10-31"), 0), Ok(date("2026-10-25"))); // Saturday
    }

    #[test]
    fn week_starts_on_the_chosen_day() {
        // Monday 26th to Sunday Nov 1st.
        for d in ["2026-10-26", "2026-10-29", "2026-11-01"] {
            assert_eq!(week_start(date(d), 1), Ok(date("2026-10-26")), "{d}");
        }
        // The day before the first day belongs to the week before.
        assert_eq!(week_start(date("2026-10-25"), 1), Ok(date("2026-10-19")));
        // Saturday first: Sat 24th to Fri 30th.
        assert_eq!(week_start(date("2026-10-24"), 6), Ok(date("2026-10-24")));
        assert_eq!(week_start(date("2026-10-30"), 6), Ok(date("2026-10-24")));
        assert_eq!(week_start(date("2026-10-31"), 6), Ok(date("2026-10-31")));
        // Whatever the first day, the week starts on that weekday and holds the date.
        for first in 0..=6u8 {
            let start = week_start(date("2026-10-29"), first).unwrap();
            assert_eq!(start.weekday().num_days_from_sunday(), u32::from(first));
            assert!((0..7).contains(&(date("2026-10-29") - start).num_days()));
        }
    }

    #[test]
    fn first_day_outside_sunday_to_saturday_is_an_error() {
        assert_eq!(check_first_day(6), Ok(6));
        assert!(check_first_day(7).unwrap_err().contains('7'));
        assert!(week_start(date("2026-10-29"), 7).is_err());
        assert!(week_start(date("2026-10-29"), 255).is_err());
    }

    #[test]
    fn first_day_setting_reads_a_valid_day_and_falls_back_to_sunday() {
        assert_eq!(parse_first_day(r#"{"firstDay":1}"#), 1);
        assert_eq!(parse_first_day(r#"{"firstDay":6}"#), 6);
        for text in [
            "",
            "{",
            "{}",
            r#"{"firstDay":7}"#,
            r#"{"firstDay":-1}"#,
            r#"{"firstDay":"1"}"#,
        ] {
            assert_eq!(parse_first_day(text), 0, "{text}");
        }
    }

    #[test]
    fn first_day_load_gives_what_save_wrote_and_sunday_for_no_file() {
        let dir = std::env::temp_dir().join(format!("cookapps-calendar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_first_day(&dir), 0);
        save_first_day(&dir, 1).unwrap();
        assert_eq!(load_first_day(&dir), 1);
        assert!(save_first_day(&dir, 7).is_err());
        assert_eq!(load_first_day(&dir), 1);
        save_first_day(&dir, 0).unwrap();
        assert_eq!(load_first_day(&dir), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn meet_url_is_kept_only_for_google_meet() {
        assert_eq!(
            meet_url(Some("https://meet.google.com/abc-defg-hij")).as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
        for other in [
            None,
            Some(""),
            Some("http://meet.google.com/abc"),
            Some("https://meet.google.com.example.com/abc"),
            Some("https://example.com/https://meet.google.com/"),
            Some("https://zoom.us/j/1"),
            Some("javascript:alert(1)"),
            Some(" https://meet.google.com/abc"),
        ] {
            assert_eq!(meet_url(other), None, "{other:?}");
        }
    }

    #[test]
    fn empty_text_is_none() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some(String::new())), None);
        assert_eq!(non_empty(Some(" \n".into())), None);
        assert_eq!(non_empty(Some("a".into())).as_deref(), Some("a"));
    }

    #[test]
    fn attendees_are_counted_without_rooms() {
        let attendees: Vec<Attendee> = serde_json::from_str(
            r#"[{"responseStatus":"accepted"},{"self":true,"responseStatus":"accepted"},
                {"responseStatus":"declined"},{"responseStatus":"needsAction"},
                {"responseStatus":"accepted","resource":true},{"resource":true}]"#,
        )
        .unwrap();
        assert_eq!(attendee_counts(&attendees), (4, 2));
        assert_eq!(attendee_counts(&[]), (0, 0));
    }

    #[test]
    fn timed_event_text_has_the_day_and_the_times() {
        let t = |s: &str, e: &str| when_text(&jst(), &timed(s, e).when);
        assert_eq!(
            t("2026-11-02T13:00:00+09:00", "2026-11-02T14:30:00+09:00"),
            "11月2日（月）13:00 - 14:30"
        );
        // In the viewer's zone, not the event's.
        assert_eq!(
            t("2026-11-02T04:05:00Z", "2026-11-02T05:00:00Z"),
            "11月2日（月）13:05 - 14:00"
        );
        // Across midnight both days are named; the hour has no leading zero.
        assert_eq!(
            t("2026-11-02T23:00:00+09:00", "2026-11-03T01:00:00+09:00"),
            "11月2日（月）23:00 - 11月3日（火）1:00"
        );
        // An event that ends where it starts shows its start only.
        assert_eq!(
            t("2026-11-01T09:00:00+09:00", "2026-11-01T09:00:00+09:00"),
            "11月1日（日）9:00"
        );
    }

    #[test]
    fn all_day_event_text_ends_on_the_last_day_not_the_exclusive_end() {
        let t = |s: &str, e: &str| when_text(&jst(), &all_day(s, e).when);
        assert_eq!(t("2026-11-03", "2026-11-04"), "11月3日（火）終日");
        assert_eq!(
            t("2026-11-03", "2026-11-06"),
            "11月3日（火）- 11月5日（木）"
        );
        // An end before the start is a one-day event.
        assert_eq!(t("2026-11-03", "2026-11-03"), "11月3日（火）終日");
    }

    #[test]
    fn info_carries_the_detail_of_the_event() {
        let mut e = timed("2026-11-02T13:00:00+09:00", "2026-11-02T14:30:00+09:00");
        e.meet_url = Some("https://meet.google.com/abc-defg-hij".into());
        e.location = Some("会議室".into());
        e.description = Some("説明".into());
        e.attendees = 6;
        e.accepted = 4;
        let i = Info::new(&e, &jst());
        assert_eq!(i.calendar, "c");
        assert_eq!(i.when_text, "11月2日（月）13:00 - 14:30");
        assert_eq!(
            i.meet_url.as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
        assert_eq!(i.location.as_deref(), Some("会議室"));
        assert_eq!(i.description.as_deref(), Some("説明"));
        assert_eq!((i.attendees, i.accepted), (6, 4));
        // The detail reaches the screen in camelCase.
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["whenText"], "11月2日（月）13:00 - 14:30");
        assert_eq!(v["meetUrl"], "https://meet.google.com/abc-defg-hij");
    }

    #[test]
    fn api_event_detail_is_read_and_empty_values_are_none() {
        let read = |json: &str| {
            let ev: ApiEvent = serde_json::from_str(json).unwrap();
            RawEvent::from_api(ev, "a@example.com", &cal(None)).unwrap()
        };
        let full = read(
            r#"{"start":{"date":"2026-10-29"},"end":{"date":"2026-10-30"},
                "hangoutLink":"https://meet.google.com/abc-defg-hij","location":"会議室",
                "description":"<b>説明</b>",
                "attendees":[{"responseStatus":"accepted"},{"self":true,"responseStatus":"needsAction"},
                             {"responseStatus":"accepted","resource":true}]}"#,
        );
        assert_eq!(
            full.meet_url.as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
        assert_eq!(full.location.as_deref(), Some("会議室"));
        assert_eq!(full.description.as_deref(), Some("<b>説明</b>"));
        assert_eq!((full.attendees, full.accepted), (2, 1));
        let bare = read(
            r#"{"start":{"date":"2026-10-29"},"end":{"date":"2026-10-30"},
                "hangoutLink":"https://zoom.us/j/1","location":"","description":" "}"#,
        );
        assert_eq!(bare.meet_url, None);
        assert_eq!(bare.location, None);
        assert_eq!(bare.description, None);
        assert_eq!((bare.attendees, bare.accepted), (0, 0));
    }

    #[test]
    fn a_long_description_is_cut_by_characters() {
        assert_eq!(clip_description("説明".into()), "説明");
        let exact = "あ".repeat(DESCRIPTION_MAX);
        assert_eq!(clip_description(exact.clone()), exact);
        let cut = clip_description(format!("{exact}い"));
        assert_eq!(cut, exact);
        assert_eq!(cut.len(), DESCRIPTION_MAX * 3);
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
        assert_eq!(r.response, ResponseStatus::Declined);
        assert_eq!(r.calendar, "仕事");
        assert_eq!(r.ical_uid, "u");
        assert_eq!(r.color.as_deref(), Some("#fff"));
        // Someone else's declined does not count.
        let ev: ApiEvent = serde_json::from_str(
            r#"{"start":{"date":"2026-10-29"},"end":{"date":"2026-10-30"},
                "attendees":[{"responseStatus":"declined"},{"self":true,"responseStatus":"accepted"}]}"#,
        )
        .unwrap();
        let r = RawEvent::from_api(ev, "a@example.com", &cal(None)).unwrap();
        assert_eq!(r.response, ResponseStatus::Accepted);
        assert!(!EventItem::from(&r).declined);
    }

    #[test]
    fn response_is_the_self_attendees_status_or_unknown() {
        let response = |attendees: &str| {
            let ev: ApiEvent = serde_json::from_str(&format!(
                r#"{{"start":{{"date":"2026-10-29"}},"end":{{"date":"2026-10-30"}},"attendees":{attendees}}}"#
            ))
            .unwrap();
            RawEvent::from_api(ev, "a@example.com", &cal(None))
                .unwrap()
                .response
        };
        assert_eq!(
            response(r#"[{"self":true,"responseStatus":"tentative"}]"#),
            ResponseStatus::Tentative
        );
        assert_eq!(
            response(r#"[{"self":true,"responseStatus":"needsAction"}]"#),
            ResponseStatus::NeedsAction
        );
        assert_eq!(
            response(r#"[{"responseStatus":"declined"}]"#),
            ResponseStatus::Unknown
        );
        assert_eq!(response("[]"), ResponseStatus::Unknown);
        // A value the API adds later does not fail the whole event.
        assert_eq!(
            response(r#"[{"self":true,"responseStatus":"later"}]"#),
            ResponseStatus::Unknown
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
            access_role: None,
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
    fn week_from_an_older_cache_without_response_deserializes() {
        let w: Week = serde_json::from_str(
            r#"{"weekStart":"2026-10-25","allDay":[{"day":1,"summary":"s","color":null,"account":"a@example.com","declined":true}],
                "timed":[],"needsLogin":[],"failed":{},"calendarFailed":[]}"#,
        )
        .unwrap();
        assert_eq!(w.all_day[0].info.response, ResponseStatus::Unknown);
    }

    #[test]
    fn week_from_an_older_cache_without_the_detail_deserializes() {
        let w: Week = serde_json::from_str(
            r#"{"weekStart":"2026-10-25","allDay":[],
                "timed":[{"day":1,"startMin":60,"endMin":120,"col":0,"cols":1,"summary":"s","color":null,
                          "account":"a@example.com","response":"accepted"}],
                "needsLogin":[],"failed":{},"calendarFailed":[]}"#,
        )
        .unwrap();
        let i = &w.timed[0].info;
        assert_eq!((i.calendar.as_str(), i.when_text.as_str()), ("", ""));
        assert_eq!(
            (
                i.meet_url.as_deref(),
                i.location.as_deref(),
                i.description.as_deref()
            ),
            (None, None, None)
        );
        assert_eq!((i.attendees, i.accepted), (0, 0));
    }

    #[test]
    fn week_serializes_in_camel_case() {
        let w = Week {
            week_start: "2026-10-25".into(),
            all_day: vec![AllDayItem {
                day: 1,
                info: info("s", None, ResponseStatus::Declined),
            }],
            timed: vec![],
            needs_login: vec!["b@example.com".into()],
            failed: Default::default(),
            calendar_failed: vec!["x".into()],
        };
        let v = serde_json::to_value(&w).unwrap();
        assert_eq!(v["weekStart"], "2026-10-25");
        assert_eq!(v["allDay"][0]["day"], 1);
        assert_eq!(v["allDay"][0]["response"], "declined");
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
                info: info(start, Some("#fff"), ResponseStatus::Unknown),
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
            starts(&with_week(weeks.clone(), week_of("w4"), 3).unwrap()),
            ["w2", "w3", "w4"]
        );
        assert_eq!(
            starts(&with_week(weeks.clone(), week_of("w4"), 4).unwrap()),
            ["w1", "w2", "w3", "w4"]
        );
        assert_eq!(
            starts(&with_week(vec![], week_of("w1"), 3).unwrap()),
            ["w1"]
        );
    }

    #[test]
    fn a_fetched_week_replaces_the_kept_one_and_becomes_the_newest() {
        let weeks = vec![week_of("w1"), week_of("w2"), week_of("w3")];
        let mut fresh = week_of("w1");
        fresh.calendar_failed = vec![];
        fresh.timed.clear();
        let out = with_week(weeks, fresh, 3).unwrap();
        assert_eq!(starts(&out), ["w2", "w3", "w1"]);
        assert!(out[2].timed.is_empty());
    }

    #[test]
    fn a_week_equal_to_the_kept_one_is_not_written_again() {
        let weeks = vec![week_of("w1"), week_of("w2")];
        assert_eq!(with_week(weeks.clone(), week_of("w1"), 3), None);
        let mut changed = week_of("w1");
        changed.timed.clear();
        assert!(with_week(weeks, changed, 3).is_some());
    }

    #[test]
    fn a_week_names_the_accounts_of_its_events() {
        let mut week = week_of("w1");
        let mut other = week.timed[0].clone();
        other.info.account = "b@example.com".into();
        week.timed.push(other);
        week.all_day.push(AllDayItem {
            day: 0,
            info: week.timed[0].info.clone(),
        });
        let mut accounts: Vec<_> = week.accounts().collect();
        accounts.sort_unstable();
        accounts.dedup();
        assert_eq!(accounts, ["a@example.com", "b@example.com"]);
    }

    fn entry(id: &str, selected: bool, role: Option<&str>) -> CalendarEntry {
        CalendarEntry {
            id: id.into(),
            selected,
            background_color: Some("#112233".into()),
            summary: Some(format!("name of {id}")),
            access_role: role.map(Into::into),
        }
    }

    fn ids(calendars: &[CalendarEntry]) -> Vec<&str> {
        calendars.iter().map(|c| c.id.as_str()).collect()
    }

    fn selection_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cookapps-calendar-selection-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn calendar_entry_reads_the_access_role_and_tolerates_its_absence() {
        let with: CalendarEntry =
            serde_json::from_str(r#"{"id":"a","accessRole":"reader","selected":true}"#).unwrap();
        assert_eq!(with.access_role.as_deref(), Some("reader"));
        let without: CalendarEntry = serde_json::from_str(r#"{"id":"a"}"#).unwrap();
        assert_eq!(without.access_role, None);
        assert!(!without.selected);
    }

    #[test]
    fn only_an_owned_calendar_is_mine() {
        assert!(entry("a", true, Some("owner")).is_mine());
        for role in [Some("writer"), Some("reader"), Some("freeBusyReader"), None] {
            assert!(!entry("a", true, role).is_mine(), "{role:?}");
        }
    }

    #[test]
    fn with_nothing_chosen_the_shown_calendars_are_the_ones_google_selected() {
        let calendars = [
            entry("mine", true, Some("owner")),
            entry("hidden", false, Some("owner")),
            entry("holiday", true, Some("reader")),
            entry("room", false, Some("reader")),
        ];
        let shown = visible(&calendars, "a@example.com", &Selection::default());
        assert_eq!(ids(&shown), ["mine", "holiday"]);
    }

    #[test]
    fn a_saved_choice_wins_over_google_in_both_directions_and_only_for_its_account() {
        let calendars = [
            entry("mine", true, Some("owner")),
            entry("room", false, Some("reader")),
            entry("other", true, Some("reader")),
        ];
        let selection = Selection::default()
            .with_shown("a@example.com", "mine", false)
            .unwrap()
            .with_shown("a@example.com", "room", true)
            .unwrap()
            .with_shown("b@example.com", "other", false)
            .unwrap();
        let shown = visible(&calendars, "a@example.com", &selection);
        assert_eq!(ids(&shown), ["room", "other"]);
        let shown = visible(&calendars, "b@example.com", &selection);
        assert_eq!(ids(&shown), ["mine"]);
    }

    #[test]
    fn choices_keep_the_order_and_carry_name_color_group_and_whether_shown() {
        let mut nameless = entry("nameless", false, Some("writer"));
        nameless.summary = None;
        nameless.background_color = None;
        let calendars = [
            entry("mine", true, Some("owner")),
            entry("shared", false, Some("reader")),
            nameless,
        ];
        let selection = Selection::default()
            .with_shown("a@example.com", "shared", true)
            .unwrap();
        let choices = choices(&calendars, "a@example.com", &selection);
        let got: Vec<_> = choices
            .iter()
            .map(|c| (c.id.as_str(), c.name.as_str(), c.mine, c.shown))
            .collect();
        assert_eq!(
            got,
            [
                ("mine", "name of mine", true, true),
                ("shared", "name of shared", false, true),
                ("nameless", "nameless", false, false),
            ]
        );
        assert_eq!(choices[0].color.as_deref(), Some("#112233"));
        assert_eq!(choices[2].color, None);
    }

    #[test]
    fn with_shown_changes_the_saved_choice_and_says_none_when_it_is_already_so() {
        let first = Selection::default()
            .with_shown("a@example.com", "x", false)
            .unwrap();
        assert_eq!(first.with_shown("a@example.com", "x", false), None);
        let flipped = first.with_shown("a@example.com", "x", true).unwrap();
        assert!(flipped.accounts["a@example.com"]["x"]);
    }

    #[test]
    fn the_selection_file_is_account_then_calendar_id_then_choice() {
        let selection = Selection::default()
            .with_shown("a@example.com", "x@group", false)
            .unwrap();
        let value = serde_json::to_value(&selection).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"accounts": {"a@example.com": {"x@group": false}}})
        );
        let back: Selection = serde_json::from_value(value).unwrap();
        assert_eq!(back, selection);
        let empty: Selection = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Selection::default());
    }

    #[test]
    fn a_choice_is_checked_against_the_accounts_and_the_calendar_id() {
        let accounts = vec!["a@example.com".to_string()];
        assert!(check_choice(
            &accounts,
            "a@example.com",
            "x#holiday@group.v.calendar.google.com"
        )
        .is_ok());
        assert!(check_choice(&accounts, "b@example.com", "x").is_err());
        assert!(check_choice(&accounts, "a@example.com", "").is_err());
        assert!(check_choice(&accounts, "a@example.com", "a\nb").is_err());
        assert!(check_choice(&accounts, "a@example.com", &"x".repeat(CALENDAR_ID_MAX)).is_ok());
        assert!(
            check_choice(&accounts, "a@example.com", &"x".repeat(CALENDAR_ID_MAX + 1)).is_err()
        );
    }

    #[test]
    fn a_saved_choice_is_read_back_and_a_second_one_keeps_the_first() {
        let dir = selection_dir("save");
        accounts::save(&dir, &["a@example.com".to_string()]).unwrap();
        assert_eq!(load_selection(&dir), Selection::default());
        save_shown(&dir, "a@example.com", "x", false).unwrap();
        save_shown(&dir, "a@example.com", "y", true).unwrap();
        let loaded = load_selection(&dir);
        assert!(!loaded.accounts["a@example.com"]["x"]);
        assert!(loaded.accounts["a@example.com"]["y"]);
        save_shown(&dir, "a@example.com", "x", true).unwrap();
        assert!(load_selection(&dir).accounts["a@example.com"]["x"]);
        assert!(!dir.join(format!("{SELECTION_FILE}.tmp")).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_changed_choice_drops_the_kept_weeks_and_an_unchanged_one_keeps_them() {
        let dir = selection_dir("drops-weeks");
        accounts::save(&dir, &["a@example.com".to_string()]).unwrap();
        let keep = || std::fs::write(dir.join(CACHE_FILE), "{}").unwrap();
        keep();
        save_shown(&dir, "a@example.com", "x", false).unwrap();
        assert!(!dir.join(CACHE_FILE).exists());
        keep();
        save_shown(&dir, "a@example.com", "x", false).unwrap();
        assert!(dir.join(CACHE_FILE).exists());
        save_shown(&dir, "a@example.com", "x", true).unwrap();
        assert!(!dir.join(CACHE_FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn forgetting_an_account_drops_only_its_choices() {
        let dir = selection_dir("forget");
        let both = ["a@example.com".to_string(), "b@example.com".to_string()];
        accounts::save(&dir, &both).unwrap();
        save_shown(&dir, "a@example.com", "x", false).unwrap();
        save_shown(&dir, "b@example.com", "y", false).unwrap();
        forget_selection(&dir, "a@example.com").unwrap();
        let loaded = load_selection(&dir);
        assert!(!loaded.accounts.contains_key("a@example.com"));
        assert!(!loaded.accounts["b@example.com"]["y"]);
        // An account with no choice leaves the file as it is.
        forget_selection(&dir, "c@example.com").unwrap();
        assert_eq!(load_selection(&dir), loaded);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_choice_for_an_unknown_account_or_a_bad_id_writes_nothing() {
        let dir = selection_dir("refuse");
        accounts::save(&dir, &["a@example.com".to_string()]).unwrap();
        assert!(save_shown(&dir, "b@example.com", "x", false).is_err());
        assert!(save_shown(&dir, "a@example.com", "", false).is_err());
        assert!(!dir.join(SELECTION_FILE).exists());
        let bare = selection_dir("refuse-bare");
        assert!(save_shown(&bare, "a@example.com", "x", false).is_err());
        assert!(!bare.join(SELECTION_FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_broken_selection_file_means_nothing_chosen() {
        let dir = selection_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SELECTION_FILE), "{").unwrap();
        assert_eq!(load_selection(&dir), Selection::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
