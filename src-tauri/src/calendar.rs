use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
};

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, Local, NaiveDate, NaiveDateTime, NaiveTime,
    SecondsFormat, TimeZone, Timelike, Utc,
};
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
#[cfg(test)]
use ts_rs::TS;
use url::Url;

use crate::{
    accounts::{self, write_atomic},
    auth::{config_dir, random_string, Auth},
    disk_cache,
    gmail::{log_failure, send_json_refreshing, ApiError},
    mail_send::valid_address,
    screen_bridge::Fields,
};

const CALENDAR_LIST_URL: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
/// The `fields` of an event list: what the detail of the week and `list_events` (C-6) draw.
const EVENT_DETAIL_FIELDS: &str = "nextPageToken,items(id,summary,iCalUID,start,end,description,location,hangoutLink,organizer(self),attendees(self,responseStatus,resource,email))";
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
    #[serde(default)]
    email: String,
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

/// The longest description that `list_events` gives Claude, in characters (C-6). The detail of the week (C-2) keeps `DESCRIPTION_MAX`.
const CLAUDE_DESCRIPTION_MAX: usize = 1_000;

/// The mark that `clip_for_claude` ends a cut text with is `CLIP_MARK_HEAD`, the number of characters left out, and `CLIP_MARK_TAIL`.
const CLIP_MARK_HEAD: &str = "…（長いため、残り ";
const CLIP_MARK_TAIL: &str = " 文字を省きました）";

/// `text` cut to `CLAUDE_DESCRIPTION_MAX` characters, with a mark that says how many were left out; a text that fits is as it is.
fn clip_for_claude(text: &str) -> String {
    let total = text.chars().count();
    if total <= CLAUDE_DESCRIPTION_MAX {
        return text.to_owned();
    }
    let head: String = text.chars().take(CLAUDE_DESCRIPTION_MAX).collect();
    format!(
        "{head}{CLIP_MARK_HEAD}{}{CLIP_MARK_TAIL}",
        total - CLAUDE_DESCRIPTION_MAX
    )
}

/// Refuses a description that ends with the mark of `clip_for_claude`: it is what `list_events` gave, cut, and sending it back would erase the rest of the event's description.
fn check_not_clipped(description: &str) -> Result<(), String> {
    let marked = description
        .strip_suffix(CLIP_MARK_TAIL)
        .is_some_and(|rest| {
            rest.rsplit_once(CLIP_MARK_HEAD)
                .is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        });
    if marked {
        Err("説明の終わりに、list_events が長いため切った印が付いています。切られた説明を送り返すと、元の説明の後ろが消えます。説明を変えないときは description を省いてください".into())
    } else {
        Ok(())
    }
}

/// Who organized an event; only whether that is the user is read.
#[derive(Deserialize, Default)]
struct ApiOrganizer {
    #[serde(default, rename = "self")]
    is_self: bool,
}

/// Whether the user organized the event. An event that names no organizer is not the user's.
fn organizer_is_self(organizer: &Option<ApiOrganizer>) -> bool {
    organizer.as_ref().is_some_and(|o| o.is_self)
}

/// Whether the user may change or delete an event (C-7): it is on a calendar the user owns, and the user organized it.
/// An event the user was invited to, or one on someone else's calendar, is not.
fn can_change(calendar_is_mine: bool, organizer_is_self: bool) -> bool {
    calendar_is_mine && organizer_is_self
}

#[derive(Deserialize)]
struct ApiEvent {
    /// With `singleEvents`, the ID of one occurrence of a repeating event.
    #[serde(default)]
    id: String,
    #[serde(default)]
    organizer: Option<ApiOrganizer>,
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
    /// The ID of the event (of one occurrence of a repeating event), and of the calendar it is on.
    event_id: String,
    calendar_id: String,
    /// Whether the user may change or delete it (`can_change`).
    editable: bool,
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
    /// The addresses of the invited besides the user (a room is among them), which the form of C-7 starts its guests with.
    guests: Vec<String>,
    when: When,
}

impl RawEvent {
    fn from_api(e: ApiEvent, account: &str, cal: &CalendarEntry) -> Option<Self> {
        let (attendees, accepted) = attendee_counts(&e.attendees);
        let guests = e
            .attendees
            .iter()
            .filter(|a| !a.is_self && !a.email.is_empty())
            .map(|a| a.email.clone())
            .collect();
        Some(Self {
            when: when(&e.start, &e.end)?,
            response: e
                .attendees
                .iter()
                .find(|a| a.is_self)
                .map(|a| a.response_status)
                .unwrap_or_default(),
            account: account.to_owned(),
            event_id: e.id,
            calendar_id: cal.id.clone(),
            editable: can_change(cal.is_mine(), organizer_is_self(&e.organizer)),
            color: cal.background_color.clone(),
            calendar: cal.summary.clone().unwrap_or_else(|| cal.id.clone()),
            summary: e.summary,
            ical_uid: e.ical_uid,
            meet_url: meet_url(e.hangout_link.as_deref()),
            location: non_empty(e.location),
            description: non_empty(e.description).map(clip_description),
            attendees,
            accepted,
            guests,
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
    /// The ID of the event (of one occurrence of a repeating event), and of the calendar it is on, for `calendar_update_event` and `calendar_delete_event` (C-7).
    /// Absent in a cache an older version wrote (empty text).
    #[serde(default)]
    event_id: String,
    #[serde(default)]
    calendar_id: String,
    /// Whether the user may change or delete the event: they organized it, on a calendar they own. Absent in a cache an older version wrote (`false`).
    #[serde(default)]
    editable: bool,
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
    /// The whole event as the form of C-5 holds it (`NewEvent`: all day, the dates or the times, the guests), which the edit of C-7 starts from.
    /// Absent in a cache an older version wrote (`false`, empty text, none); such an event is not `editable` either.
    #[serde(default)]
    all_day: bool,
    /// A date for an all-day event, else an RFC 3339 time.
    #[serde(default)]
    start: String,
    /// Same form as `start`; the last day for an all-day event.
    #[serde(default)]
    end: String,
    /// The addresses of the invited besides the user.
    #[serde(default)]
    guests: Vec<String>,
}

impl Info {
    /// `tz` is the zone the times are shown in.
    fn new<Tz: TimeZone>(e: &RawEvent, tz: &Tz) -> Self {
        let (all_day, start, end) = form_of(&e.when);
        Self {
            summary: e.summary.clone(),
            event_id: e.event_id.clone(),
            calendar_id: e.calendar_id.clone(),
            editable: e.editable,
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
            all_day,
            start,
            end,
            guests: e.guests.clone(),
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

/// An event as `list_events` returns it: what the detail of C-2 shows, and what `calendar_update_event` and `calendar_delete_event` need (C-6).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventItem {
    account: String,
    calendar: String,
    calendar_id: String,
    event_id: String,
    summary: String,
    declined: bool,
    response: ResponseStatus,
    all_day: bool,
    /// A local date for an all-day event, else an RFC 3339 time.
    start: String,
    /// Same form as `start`; the last day for an all-day event.
    end: String,
    location: Option<String>,
    /// As Google sends it: plain text or a little HTML, cut to `CLAUDE_DESCRIPTION_MAX` characters.
    description: Option<String>,
    meet_url: Option<String>,
    /// Invited people (rooms left out), and how many of them accepted.
    attendees: u32,
    accepted: u32,
    /// The addresses of the invited besides the user (a room is among them), as the week's `Info.guests`; empty unless `editable`, because only a rewrite needs them.
    guests: Vec<String>,
    /// Whether the event can be changed or deleted (C-7).
    editable: bool,
}

/// Whether the event is all day, and its start and end as the screen and `list_events` give them: a date for an all-day event (`end` the last day, included), else an RFC 3339 time.
fn form_of(when: &When) -> (bool, String, String) {
    match when {
        // The API's end date is exclusive.
        When::AllDay { start, end } => (
            true,
            start.to_string(),
            (*end - Duration::days(1)).max(*start).to_string(),
        ),
        When::Timed { start, end } => (false, start.to_rfc3339(), end.to_rfc3339()),
    }
}

impl From<&RawEvent> for EventItem {
    fn from(e: &RawEvent) -> Self {
        let (all_day, start, end) = form_of(&e.when);
        Self {
            account: e.account.clone(),
            calendar: e.calendar.clone(),
            calendar_id: e.calendar_id.clone(),
            event_id: e.event_id.clone(),
            summary: e.summary.clone(),
            declined: e.response == ResponseStatus::Declined,
            response: e.response,
            all_day,
            start,
            end,
            location: e.location.clone(),
            description: e.description.as_deref().map(clip_for_claude),
            meet_url: e.meet_url.clone(),
            attendees: e.attendees,
            accepted: e.accepted,
            guests: if e.editable {
                e.guests.clone()
            } else {
                Vec::new()
            },
            editable: e.editable,
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
    let text =
        serde_json::to_string_pretty(&SettingsFile { first_day }).map_err(|e| e.to_string())?;
    write_atomic(dir, SETTINGS_FILE, &text)
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

/// One day of the small month calendar of the calendar screen (C-4).
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct MonthDay {
    /// Local date, "YYYY-MM-DD".
    date: String,
    /// The day of the month.
    day: u32,
    /// Whether the day is in the month asked for (the others fill the first and the last week).
    in_month: bool,
}

/// The small month calendar of the calendar screen (C-4): the weeks that hold the month, from the first day of the week.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct MonthGrid {
    /// The weekday of each column, 0 = Sunday to 6 = Saturday, starting with the first day of the week.
    weekdays: Vec<u8>,
    /// Seven days for each week of the month, in order.
    days: Vec<MonthDay>,
}

/// The weeks that hold the month `month` (1 to 12) of `year`, each starting on `first_day`.
fn month_grid(year: i32, month: u32, first_day: u8) -> Result<MonthGrid, String> {
    let invalid = || format!("月が不正です: {year}-{month}");
    // Chrono's own range is wider, and its date arithmetic panics at the ends.
    if !(1..=9999).contains(&year) {
        return Err(invalid());
    }
    let first = NaiveDate::from_ymd_opt(year, month, 1).ok_or_else(invalid)?;
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .ok_or_else(invalid)?;
    let start = week_start(first, first_day)?;
    let end = week_start(next - Duration::days(1), first_day)? + Duration::days(6);
    let days = (0..=(end - start).num_days())
        .map(|i| {
            let d = start + Duration::days(i);
            MonthDay {
                date: d.to_string(),
                day: d.day(),
                in_month: d.month() == month,
            }
        })
        .collect();
    Ok(MonthGrid {
        weekdays: (0..7).map(|i| (first_day + i) % 7).collect(),
        days,
    })
}

#[tauri::command]
pub fn calendar_month(year: i32, month: u32, first_day: u8) -> Result<MonthGrid, String> {
    month_grid(year, month, first_day)
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

/// Keeps whether one calendar of one account is shown (C-4). The command of the screen and `calendar_set_shown` of `tsunagiai-mcp` (C-6) both call it.
pub fn save_shown(dir: &Path, account: &str, calendar_id: &str, shown: bool) -> Result<(), String> {
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
        EVENT_DETAIL_FIELDS,
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
    load_choices(&app, &auth, &cache, "calendar_choices").await
}

/// The body of `calendar_choices` and `calendar_owned`; `command` names the one that asks, for the log.
async fn load_choices(
    app: &AppHandle,
    auth: &Auth,
    cache: &CalendarCache,
    command: &str,
) -> Result<CalendarChoices, String> {
    let dir = config_dir(app).map_err(|e| log_failure(command, "-", e))?;
    list_choices(&dir, auth, cache, command).await
}

/// The calendars of every account with whether each is shown, from the config directory: what `calendar_choices` reads, and `list_calendars` of `tsunagiai-mcp` (C-6) with a list of its own.
pub async fn list_choices(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    command: &str,
) -> Result<CalendarChoices, String> {
    let dir = dir.to_owned();
    let selection = load_selection(&dir);
    let accounts = auth
        .accounts(&dir)
        .map_err(|e| log_failure(command, "-", e))?;
    let jobs = accounts
        .iter()
        .map(|account| {
            let (dir, auth, cache) = (dir.clone(), auth.clone(), cache.clone());
            let account = account.clone();
            async move { account_calendars(&dir, &auth, &cache, &account, false).await }
        })
        .collect();
    let results = join_all(jobs)
        .await
        .map_err(|e| log_failure(command, "-", e))?;
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
                let message = log_failure(command, &account, e);
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

/// The calendars an event can be created in: those of every account that the user owns.
/// Accounts needing login or failing to load are listed, not fatal, as in `calendar_choices`.
#[tauri::command]
pub async fn calendar_owned(
    app: AppHandle,
    auth: State<'_, Auth>,
    cache: State<'_, CalendarCache>,
) -> Result<CalendarChoices, String> {
    let mut found = load_choices(&app, &auth, &cache, "calendar_owned").await?;
    owned_only(&mut found);
    Ok(found)
}

/// Drops the calendars the user does not own, and the accounts left with none.
fn owned_only(found: &mut CalendarChoices) {
    for a in &mut found.accounts {
        a.calendars.retain(|c| c.mine);
    }
    found.accounts.retain(|a| !a.calendars.is_empty());
}

const TITLE_MAX: usize = 1024;
/// The limit of Google's own description, in characters.
const DESCRIPTION_INPUT_MAX: usize = 8192;
const GUESTS_MAX: usize = 200;
/// What `events.insert` answers with: the ID, and the Meet link if one was made.
const INSERT_FIELDS: &str = "id,hangoutLink";

/// An event to create, as the screen sends it.
/// `all_day`: `start` and `end` are dates (YYYY-MM-DD) and `end` is the last day, included;
/// otherwise they are RFC 3339 date-times with an offset or `Z`.
#[derive(Deserialize, Debug)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub account: String,
    pub calendar_id: String,
    pub title: String,
    pub all_day: bool,
    pub start: String,
    pub end: String,
    /// Email addresses; each one is invited.
    pub guests: Vec<String>,
    /// Whether to add a Google Meet conference.
    pub meet: bool,
    pub description: String,
}

/// The part of the answer of `events.insert` that is read.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ApiCreated {
    id: String,
    hangout_link: Option<String>,
}

/// The event that was created.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct CreatedEvent {
    id: String,
    /// The Meet link, when the event has one. Google may add it a moment after the answer.
    meet_url: Option<String>,
}

impl From<ApiCreated> for CreatedEvent {
    fn from(c: ApiCreated) -> Self {
        Self {
            id: c.id,
            meet_url: meet_url(c.hangout_link.as_deref()),
        }
    }
}

/// The first 100 characters, for an error message.
fn shown_text(s: &str) -> String {
    s.chars().take(100).collect()
}

/// A guest address: a plain ASCII `local@domain` as a mail's (`valid_address`, which lets no format or look-alike character through) with a dot in the domain.
fn valid_guest(addr: &str) -> bool {
    valid_address(addr) && addr.split_once('@').is_some_and(|(_, d)| d.contains('.'))
}

/// The guests as the API takes them: trimmed, each a valid address, none twice (the case of the address does not count).
fn check_guests(guests: &[String]) -> Result<Vec<String>, String> {
    if guests.len() > GUESTS_MAX {
        return Err(format!("ゲストは {GUESTS_MAX} 人までです"));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(guests.len());
    for guest in guests {
        let addr = guest.trim();
        if addr.is_empty() {
            return Err("ゲストのメールアドレスが空です".into());
        }
        if !valid_guest(addr) {
            return Err(format!(
                "ゲストのメールアドレスの形が正しくありません: {}",
                shown_text(addr)
            ));
        }
        if !seen.insert(addr.to_lowercase()) {
            return Err(format!(
                "ゲストのメールアドレスが重複しています: {}",
                shown_text(addr)
            ));
        }
        out.push(addr.to_owned());
    }
    Ok(out)
}

/// The `start` and `end` of the request body.
fn check_times(event: &NewEvent) -> Result<(Value, Value), String> {
    let after = "開始が終了より後になっています";
    if event.all_day {
        let day = |text: &str, what: &str| {
            NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .map_err(|_| format!("{what}の日付が正しくありません: {}", shown_text(text)))
        };
        let (start, last) = (day(&event.start, "開始")?, day(&event.end, "終了")?);
        if start > last {
            return Err(after.into());
        }
        // The API's end of an all-day event is exclusive.
        let end = last.succ_opt().ok_or("終了の日付が正しくありません")?;
        Ok((
            json!({"date": start.to_string()}),
            json!({"date": end.to_string()}),
        ))
    } else {
        let time = |text: &str, what: &str| {
            DateTime::parse_from_rfc3339(text)
                .map_err(|_| format!("{what}の日時が正しくありません: {}", shown_text(text)))
        };
        let (start, end) = (time(&event.start, "開始")?, time(&event.end, "終了")?);
        if start > end {
            return Err(after.into());
        }
        let text = |t: DateTime<FixedOffset>| t.to_rfc3339_opts(SecondsFormat::Secs, false);
        Ok((
            json!({"dateTime": text(start)}),
            json!({"dateTime": text(end)}),
        ))
    }
}

/// The most candidates of `calendar_show_slots` (C-6, #1063): the screen bridge writes at most 8 fields in one go.
pub const MAX_SLOTS: usize = 8;

/// One end of a candidate: exactly `YYYY-MM-DDTHH:MM` (the month, the day, the hour and the minute with two digits) and a time that exists. `n` is the number of the candidate, from 1.
fn slot_time(n: usize, what: &str, text: &str) -> Result<NaiveDateTime, String> {
    let shaped = text.len() == 16
        && text.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 => b == b':',
            _ => b.is_ascii_digit(),
        });
    shaped
        .then(|| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M").ok())
        .flatten()
        .ok_or_else(|| {
            format!(
                "候補{n}の{what}の日時が正しくありません: {}（\"YYYY-MM-DDTHH:MM\" の形で、実在する日時にしてください）",
                shown_text(text)
            )
        })
}

/// The candidates of free time that `calendar_show_slots` draws on the week (C-6, #1063), as the fields `slot1` to `slot{n}` of the screen `calendar-slots`, each `start/end` (`YYYY-MM-DDTHH:MM`, this Mac's time). `slots` are (start, end) pairs. It takes 1 to `MAX_SLOTS` candidates, each ending after it starts and on the same day; one wrong candidate refuses them all, so the screen is given nothing.
pub fn slot_fields(slots: &[(&str, &str)]) -> Result<Fields, String> {
    if slots.is_empty() || slots.len() > MAX_SLOTS {
        return Err(format!(
            "候補は 1 件から {MAX_SLOTS} 件までです（{} 件）",
            slots.len()
        ));
    }
    let mut fields = Fields::new();
    for (i, (start, end)) in slots.iter().enumerate() {
        let n = i + 1;
        let (from, to) = (slot_time(n, "開始", start)?, slot_time(n, "終了", end)?);
        if to <= from {
            return Err(format!("候補{n}は終了が開始より後になっていません"));
        }
        if to.date() != from.date() {
            return Err(format!("候補{n}は同じ日の中で終わらせてください"));
        }
        fields.insert(format!("slot{n}"), format!("{start}/{end}"));
    }
    Ok(fields)
}

/// The target of the form of C-5 and C-7 that a tool of Claude fills in (`calendar_create_event` and `calendar_update_event` with a new guest, C-6): the app's screen bridge writes it, and the owner saves.
pub const FORM_TARGET: &str = "calendar-form";

/// The fields of the target `calendar-form` for `event`: `form` is JSON with `eventId` (empty for a new event), `account`, `calendarId`, `title`, `allDay`, `start`, `end`, `guests` and `meet`, and `description` is the text.
/// The screen bridge takes 8 fields of 10,000 characters at most, so the description has a field of its own.
/// With `keep_description` there is no `description` field, and the screen starts the form of an event with the description the event has.
pub fn form_fields(event_id: Option<&str>, event: &NewEvent, keep_description: bool) -> Fields {
    let form = json!({
        "eventId": event_id.unwrap_or_default(),
        "account": event.account,
        "calendarId": event.calendar_id,
        "title": event.title,
        "allDay": event.all_day,
        "start": event.start,
        "end": event.end,
        "guests": event.guests,
        "meet": event.meet,
    });
    let mut fields = Fields::from([("form".to_owned(), form.to_string())]);
    if !keep_description {
        fields.insert("description".to_owned(), event.description.clone());
    }
    fields
}

/// The query parameters of a request.
type Query = Vec<(&'static str, &'static str)>;

/// The input of the form, checked: the title (trimmed), the `start` and `end` of the request body, and the guests.
struct Checked<'a> {
    title: &'a str,
    start: Value,
    end: Value,
    guests: Vec<String>,
}

fn check_input(event: &NewEvent) -> Result<Checked<'_>, String> {
    let title = event.title.trim();
    if title.chars().count() > TITLE_MAX {
        return Err(format!("タイトルは {TITLE_MAX} 文字までです"));
    }
    if event.description.chars().count() > DESCRIPTION_INPUT_MAX {
        return Err(format!("説明は {DESCRIPTION_INPUT_MAX} 文字までです"));
    }
    let (start, end) = check_times(event)?;
    let guests = check_guests(&event.guests)?;
    Ok(Checked {
        title,
        start,
        end,
        guests,
    })
}

/// The query and the body of `events.insert` for `event`, after checking the input.
/// `request_id` is new for each event: Google makes the Meet of a request ID once.
/// The invitation goes out only when there are guests.
fn build_insert(event: &NewEvent, request_id: &str) -> Result<(Query, Value), String> {
    let Checked {
        title,
        start,
        end,
        guests,
    } = check_input(event)?;
    let mut body = json!({"start": start, "end": end});
    if !title.is_empty() {
        body["summary"] = json!(title);
    }
    if !event.description.trim().is_empty() {
        body["description"] = json!(event.description);
    }
    if !guests.is_empty() {
        body["attendees"] = guests.iter().map(|g| json!({"email": g})).collect();
    }
    let mut query = vec![("fields", INSERT_FIELDS)];
    if event.meet {
        body["conferenceData"] = json!({"createRequest": {
            "requestId": request_id,
            "conferenceSolutionKey": {"type": "hangoutsMeet"},
        }});
        query.push(("conferenceDataVersion", "1"));
    }
    query.push((
        "sendUpdates",
        if guests.is_empty() { "none" } else { "all" },
    ));
    Ok((query, body))
}

/// What the user is told when the calendar of an event to create is not theirs.
const CREATE_REFUSAL: &str =
    "このカレンダーには予定を作れません。自分が持つカレンダーだけに作れます";

/// Whether `id` is a calendar of `calendars` that the user owns. Only those take an event.
/// `refusal` is what the user is told when it is not theirs.
fn owned_calendar(calendars: &[CalendarEntry], id: &str, refusal: &str) -> Result<(), String> {
    match calendars.iter().find(|c| c.id == id) {
        None => Err("カレンダーが見つかりません".into()),
        Some(c) if c.is_mine() => Ok(()),
        Some(_) => Err(refusal.into()),
    }
}

/// Reads the calendars of `account` (the kept list first; once again from Google when the kept one does not show it as owned,
/// so a calendar made after the list was kept is found) and checks that `id` is owned.
/// `Ok(None)` means `account` must log in again.
async fn check_owned(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    account: &str,
    id: &str,
    refusal: &str,
) -> Result<Option<()>, ApiError> {
    for refresh in [false, true] {
        let Some(calendars) = account_calendars(dir, auth, cache, account, refresh).await? else {
            return Ok(None);
        };
        match owned_calendar(&calendars, id, refusal) {
            Ok(()) => return Ok(Some(())),
            Err(e) if refresh => return Err(e.into()),
            Err(_) => {}
        }
    }
    unreachable!("the second round returns")
}

/// What a tool of Claude does with an event (C-6): sends it to Google, or, when it would invite someone who is not on the event yet,
/// sends nothing and leaves the owner to save it in the form of the calendar screen.
#[derive(Debug)]
pub enum Outcome {
    Done(CreatedEvent),
    /// Nothing was sent: the event passed every check, and a guest in it is new.
    AskOwner,
}

/// Creates an event in a calendar the user owns, with the invitations and the Google Meet that `event` asks for.
/// `None` means the account must log in again (it has not granted the permission to create events yet).
/// The screen reads the week again to draw the event.
#[tauri::command]
pub async fn calendar_create_event(
    app: AppHandle,
    auth: State<'_, Auth>,
    cache: State<'_, CalendarCache>,
    event: NewEvent,
) -> Result<Option<CreatedEvent>, String> {
    let dir = config_dir(&app).map_err(|e| log_failure("calendar_create_event", "-", e))?;
    create_event(&dir, &auth, &cache, &event).await
}

/// The request of `events.insert` or `events.patch`, checked and ready to send.
struct Prepared {
    url: String,
    query: Query,
    body: Value,
}

/// Checks an event to create (the input, the account and the calendar, which the user must own) and builds its request. `None` means `account` must log in again.
async fn prepare_create(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    event: &NewEvent,
) -> Result<Option<Prepared>, String> {
    const COMMAND: &str = "calendar_create_event";
    let account = event.account.as_str();
    let listed = auth
        .accounts(dir)
        .map_err(|e| log_failure(COMMAND, "-", e))?;
    check_choice(&listed, account, &event.calendar_id)?;
    let request_id = random_string().map_err(|e| log_failure(COMMAND, account, e))?;
    let (query, body) = build_insert(event, &request_id)?;
    let url = events_url(&event.calendar_id)?;
    // The role is read from Google, not taken from the screen.
    match check_owned(
        dir,
        auth,
        cache,
        account,
        &event.calendar_id,
        CREATE_REFUSAL,
    )
    .await
    {
        Ok(Some(())) => Ok(Some(Prepared { url, query, body })),
        Ok(None) => Ok(None),
        Err(e) => Err(log_failure(COMMAND, account, e)),
    }
}

async fn send_create(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    account: &str,
    sending: &Prepared,
) -> Result<Option<CreatedEvent>, String> {
    const COMMAND: &str = "calendar_create_event";
    match send_json_refreshing::<ApiCreated>(
        dir,
        auth,
        account,
        Method::POST,
        &sending.url,
        &sending.query,
        Some(&sending.body),
    )
    .await
    {
        Ok(Some(created)) => Ok(Some(created.into())),
        Ok(None) => {
            cache.forget(account);
            Ok(None)
        }
        Err(e) => change_failure(cache, COMMAND, account, e),
    }
}

/// `calendar_create_event` on the config directory, for `tsunagiai-mcp` as well (C-6).
pub async fn create_event(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    event: &NewEvent,
) -> Result<Option<CreatedEvent>, String> {
    let Some(sending) = prepare_create(dir, auth, cache, event).await? else {
        return Ok(None);
    };
    send_create(dir, auth, cache, &event.account, &sending).await
}

/// `create_event` for a tool of Claude (C-6): an event with guests is checked and not sent (`Outcome::AskOwner`), because a guest is invited by the save and every guest of a new event is new.
pub async fn create_event_for_claude(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    event: &NewEvent,
) -> Result<Option<Outcome>, String> {
    let Some(sending) = prepare_create(dir, auth, cache, event).await? else {
        return Ok(None);
    };
    if has_new_guest(&[], &check_guests(&event.guests)?) {
        return Ok(Some(Outcome::AskOwner));
    }
    Ok(send_create(dir, auth, cache, &event.account, &sending)
        .await?
        .map(Outcome::Done))
}

/// What the user is told when the calendar of an event to change or delete is not theirs.
const CHANGE_REFUSAL: &str =
    "このカレンダーの予定は変更できません。自分が持つカレンダーの予定だけです";

/// What `events.get` is asked for before a change: who organized the event, its Meet link, whether it repeats, and its guests as Google holds them (a guest who stays is sent back as it is).
const CURRENT_FIELDS: &str = "organizer(self),hangoutLink,recurrence,attendees";

/// An event to rewrite (C-7): `event` as the form of C-5 holds it, and the ID of the event to put it on.
/// For a repeating event the ID is that of one occurrence (`Info.event_id`), and only that occurrence is rewritten.
/// The guests are the whole list after the change, and `meet` says whether the event has a Meet after it.
#[derive(Deserialize, Debug)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct EditedEvent {
    pub event_id: String,
    #[serde(flatten)]
    pub event: NewEvent,
}

/// What `events.get` answers with before a change (`CURRENT_FIELDS`).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ApiCurrent {
    organizer: Option<ApiOrganizer>,
    hangout_link: Option<String>,
    /// The rules of a repeating event; only the series itself has them, not one occurrence.
    #[serde(default)]
    recurrence: Vec<String>,
    /// The entries of the guests as Google sent them (the user's own among them).
    #[serde(default)]
    attendees: Vec<Value>,
}

/// The address of an entry of `ApiCurrent::attendees`, empty when it has none.
fn entry_address(entry: &Value) -> &str {
    entry
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

impl ApiCurrent {
    /// The addresses of every entry, the user's own included.
    fn addresses(&self) -> Vec<String> {
        self.attendees
            .iter()
            .map(|a| entry_address(a).to_owned())
            .collect()
    }

    fn has_meet(&self) -> bool {
        meet_url(self.hangout_link.as_deref()).is_some()
    }

    fn has_guests(&self) -> bool {
        !self.attendees.is_empty()
    }
}

/// `events/{event_id}` of a calendar. The ID is one path segment, escaped as such.
fn event_url(calendar_id: &str, event_id: &str) -> Result<String, String> {
    if matches!(event_id, "" | "." | "..") || event_id.chars().count() > CALENDAR_ID_MAX {
        return Err("予定 ID が不正です".into());
    }
    let mut url = Url::parse(&events_url(calendar_id)?).map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "URL が不正です")?
        .push(event_id);
    Ok(url.into())
}

/// Refuses an event that the user did not organize (an invitation).
fn check_organizer(organizer_is_self: bool) -> Result<(), String> {
    if organizer_is_self {
        Ok(())
    } else {
        Err("この予定は変更できません。自分が主催した予定だけです".into())
    }
}

/// Refuses the series of a repeating event itself (it has `recurrence`): a change or a delete would reach every occurrence, and the tools and the screen take one occurrence.
fn check_not_series(now: &ApiCurrent) -> Result<(), String> {
    if now.recurrence.is_empty() {
        Ok(())
    } else {
        Err(
            "繰り返しの予定そのものは変更も削除もできません。その回の予定の ID を指定してください"
                .into(),
        )
    }
}

/// Whether the event `now` can be changed or deleted: the user organized it, and it is one event or one occurrence.
fn check_current(now: &ApiCurrent) -> Result<(), String> {
    check_organizer(organizer_is_self(&now.organizer))?;
    check_not_series(now)
}

/// Whether `wanted` (the guests after a change, checked) holds an address that `known` (the addresses the event has now, none for a new event) does not,
/// the case of the address not counting. Such a guest is a new person, who is sent an invitation.
fn has_new_guest(known: &[String], wanted: &[String]) -> bool {
    wanted
        .iter()
        .any(|w| !known.iter().any(|k| k.eq_ignore_ascii_case(w)))
}

/// The guests as the patch sends them: one who is in the event stays as Google sent the entry (`optional`, `displayName` and so on), a new address is `{"email"}`.
fn patch_attendees(now: &ApiCurrent, guests: &[String]) -> Vec<Value> {
    guests
        .iter()
        .map(|g| {
            now.attendees
                .iter()
                .find(|a| entry_address(a).eq_ignore_ascii_case(g))
                .cloned()
                .unwrap_or_else(|| json!({"email": g}))
        })
        .collect()
}

/// The guests are told when there are any after the change, or were any before it (those taken off are told that it is cancelled).
fn send_updates(guests: bool) -> &'static str {
    if guests {
        "all"
    } else {
        "none"
    }
}

/// The query and the body of `events.patch` for `event` on the event `now`, after checking the input.
/// A patch leaves out what the body does not name, so each field of the form is named, an empty one too (so it clears), and the form of the
/// time that is not used is `null` (so an all-day event can become a timed one and back).
/// The Meet is added when it is wanted and the event has none, taken off when it is not wanted and the event has one, and left alone otherwise.
/// With `keep_guests` the body names no `attendees`, so the guests the event has stay (`event.guests` is not read).
/// With `keep_description` it names no `description`, so the description the event has stays (`event.description` is not read).
fn build_patch(
    event: &NewEvent,
    request_id: &str,
    now: &ApiCurrent,
    keep_guests: bool,
    keep_description: bool,
) -> Result<(Query, Value), String> {
    let Checked {
        title,
        mut start,
        mut end,
        guests,
    } = check_input(event)?;
    let unused = if event.all_day { "dateTime" } else { "date" };
    start[unused] = Value::Null;
    end[unused] = Value::Null;
    let description = if event.description.trim().is_empty() {
        ""
    } else {
        &event.description
    };
    let mut body = json!({
        "summary": title,
        "start": start,
        "end": end,
    });
    if !keep_description {
        body["description"] = json!(description);
    }
    let guests = if keep_guests { Vec::new() } else { guests };
    if !keep_guests {
        body["attendees"] = json!(patch_attendees(now, &guests));
    }
    let mut query = vec![("fields", INSERT_FIELDS)];
    match (event.meet, now.has_meet()) {
        (true, false) => {
            body["conferenceData"] = json!({"createRequest": {
                "requestId": request_id,
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }});
            query.push(("conferenceDataVersion", "1"));
        }
        (false, true) => {
            body["conferenceData"] = Value::Null;
            query.push(("conferenceDataVersion", "1"));
        }
        _ => {}
    }
    query.push((
        "sendUpdates",
        send_updates(!guests.is_empty() || now.has_guests()),
    ));
    Ok((query, body))
}

/// The query of `events.delete` of the event `now`: the guests are told when it has any.
fn build_delete(now: &ApiCurrent) -> Query {
    vec![("sendUpdates", send_updates(now.has_guests()))]
}

/// The answer to a failed call of a change: a login again when the grant lacks the permission, else the message.
fn change_failure<T>(
    cache: &CalendarCache,
    command: &str,
    account: &str,
    e: ApiError,
) -> Result<Option<T>, String> {
    let status = e.status;
    let message = log_failure(command, account, e);
    match classify(status, &message) {
        Failure::NeedsLogin => {
            cache.forget(account);
            Ok(None)
        }
        Failure::Message(m) => Err(m),
    }
}

/// Checks that the event can be changed or deleted, reading it from Google, not from the screen: the calendar is the user's and the user organized the event.
/// Gives the URL of the event and its state. `Ok(None)` means `account` must log in again.
async fn changeable(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    command: &str,
    account: &str,
    calendar_id: &str,
    event_id: &str,
) -> Result<Option<(String, ApiCurrent)>, String> {
    let listed = auth
        .accounts(dir)
        .map_err(|e| log_failure(command, "-", e))?;
    check_choice(&listed, account, calendar_id)?;
    let url = event_url(calendar_id, event_id)?;
    match check_owned(dir, auth, cache, account, calendar_id, CHANGE_REFUSAL).await {
        Ok(Some(())) => {}
        Ok(None) => return Ok(None),
        Err(e) => return Err(log_failure(command, account, e)),
    }
    let query = [("fields", CURRENT_FIELDS)];
    let now = match send_json_refreshing::<ApiCurrent>(
        dir,
        auth,
        account,
        Method::GET,
        &url,
        &query,
        None,
    )
    .await
    {
        Ok(Some(now)) => now,
        Ok(None) => {
            cache.forget(account);
            return Ok(None);
        }
        Err(e) => return change_failure(cache, command, account, e),
    };
    check_current(&now)?;
    Ok(Some((url, now)))
}

/// Checks an event to rewrite (the input, and in Google the calendar, the organizer and that it is not a series) and builds its request, with the event as Google holds it now.
/// `None` means the account must log in again. With `keep_guests` the request leaves the guests as they are, and with `keep_description` the description.
async fn prepare_update(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    edit: &EditedEvent,
    keep_guests: bool,
    keep_description: bool,
) -> Result<Option<(Prepared, ApiCurrent)>, String> {
    const COMMAND: &str = "calendar_update_event";
    let event = &edit.event;
    let account = event.account.as_str();
    check_input(event)?;
    let request_id = random_string().map_err(|e| log_failure(COMMAND, account, e))?;
    let Some((url, now)) = changeable(
        dir,
        auth,
        cache,
        COMMAND,
        account,
        &event.calendar_id,
        &edit.event_id,
    )
    .await?
    else {
        return Ok(None);
    };
    let (query, body) = build_patch(event, &request_id, &now, keep_guests, keep_description)?;
    Ok(Some((Prepared { url, query, body }, now)))
}

async fn send_update(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    account: &str,
    sending: &Prepared,
) -> Result<Option<CreatedEvent>, String> {
    const COMMAND: &str = "calendar_update_event";
    match send_json_refreshing::<ApiCreated>(
        dir,
        auth,
        account,
        Method::PATCH,
        &sending.url,
        &sending.query,
        Some(&sending.body),
    )
    .await
    {
        Ok(Some(changed)) => Ok(Some(changed.into())),
        Ok(None) => {
            cache.forget(account);
            Ok(None)
        }
        Err(e) => change_failure(cache, COMMAND, account, e),
    }
}

/// Rewrites an event that the user organized, on a calendar the user owns (C-7), with the invitations and the Google Meet that `edit` asks for.
/// `None` means the account must log in again (it has not granted the permission to change events yet).
pub async fn update_event(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    edit: &EditedEvent,
) -> Result<Option<CreatedEvent>, String> {
    let Some((sending, _)) = prepare_update(dir, auth, cache, edit, false, false).await? else {
        return Ok(None);
    };
    send_update(dir, auth, cache, &edit.event.account, &sending).await
}

/// `update_event` for a tool of Claude (C-6). With `keep_description` the description stays as the event has it, and a description that `list_events` cut is refused, not sent back.
/// With `keep_guests` the guests stay as the event has them. Otherwise, when `edit` has a guest that the event does not have now,
/// nothing is sent (`Outcome::AskOwner`): the new guest is invited by the save. The guests who are on the event already are changed and told with no question.
pub async fn update_event_for_claude(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    edit: &EditedEvent,
    keep_guests: bool,
    keep_description: bool,
) -> Result<Option<Outcome>, String> {
    if !keep_description {
        check_not_clipped(&edit.event.description)?;
    }
    let Some((sending, now)) =
        prepare_update(dir, auth, cache, edit, keep_guests, keep_description).await?
    else {
        return Ok(None);
    };
    if !keep_guests && has_new_guest(&now.addresses(), &check_guests(&edit.event.guests)?) {
        return Ok(Some(Outcome::AskOwner));
    }
    Ok(send_update(dir, auth, cache, &edit.event.account, &sending)
        .await?
        .map(Outcome::Done))
}

/// Deletes an event that the user organized, on a calendar the user owns (C-7). A repeating event's `event_id` is that of one occurrence, and only it goes.
/// `None` means the account must log in again (it has not granted the permission to change events yet).
pub async fn delete_event(
    dir: &Path,
    auth: &Auth,
    cache: &CalendarCache,
    account: &str,
    calendar_id: &str,
    event_id: &str,
) -> Result<Option<bool>, String> {
    const COMMAND: &str = "calendar_delete_event";
    let Some((url, now)) =
        changeable(dir, auth, cache, COMMAND, account, calendar_id, event_id).await?
    else {
        return Ok(None);
    };
    match send_json_refreshing::<Value>(
        dir,
        auth,
        account,
        Method::DELETE,
        &url,
        &build_delete(&now),
        None,
    )
    .await
    {
        Ok(Some(_)) => Ok(Some(true)),
        Ok(None) => {
            cache.forget(account);
            Ok(None)
        }
        Err(e) => change_failure(cache, COMMAND, account, e),
    }
}

/// Rewrites an event (C-7, `update_event`). The screen reads the week again to draw it.
#[tauri::command]
pub async fn calendar_update_event(
    app: AppHandle,
    auth: State<'_, Auth>,
    cache: State<'_, CalendarCache>,
    event: EditedEvent,
) -> Result<Option<CreatedEvent>, String> {
    let dir = config_dir(&app).map_err(|e| log_failure("calendar_update_event", "-", e))?;
    update_event(&dir, &auth, &cache, &event).await
}

/// Deletes an event (C-7, `delete_event`). `Some(true)` when it is gone. The screen reads the week again.
#[tauri::command]
pub async fn calendar_delete_event(
    app: AppHandle,
    auth: State<'_, Auth>,
    cache: State<'_, CalendarCache>,
    account: String,
    calendar_id: String,
    event_id: String,
) -> Result<Option<bool>, String> {
    let dir = config_dir(&app).map_err(|e| log_failure("calendar_delete_event", "-", e))?;
    delete_event(&dir, &auth, &cache, &account, &calendar_id, &event_id).await
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
            event_id: "ev".into(),
            calendar_id: "id@example.com".into(),
            editable: false,
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
            guests: Vec::new(),
            when: When::AllDay {
                start: date("2026-01-01"),
                end: date("2026-01-02"),
            },
        }
    }

    fn info(summary: &str, color: Option<&str>, response: ResponseStatus) -> Info {
        Info {
            summary: summary.into(),
            event_id: "ev".into(),
            calendar_id: "id@example.com".into(),
            editable: false,
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
            all_day: false,
            start: String::new(),
            end: String::new(),
            guests: Vec::new(),
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
    fn month_grid_covers_the_weeks_of_the_month() {
        // November 2026 starts on Sunday and ends on Monday the 30th.
        let sunday = month_grid(2026, 11, 0).unwrap();
        assert_eq!(sunday.weekdays, [0, 1, 2, 3, 4, 5, 6]);
        assert_eq!(sunday.days.len(), 35);
        assert_eq!(sunday.days[0].date, "2026-11-01");
        assert_eq!(sunday.days[34].date, "2026-12-05");
        assert!(sunday.days[29].in_month && !sunday.days[30].in_month);
        // Starting on Monday, the first row begins in October, and the 30th is alone on the first day of a sixth row.
        let monday = month_grid(2026, 11, 1).unwrap();
        assert_eq!(monday.weekdays, [1, 2, 3, 4, 5, 6, 0]);
        assert_eq!(monday.days.len(), 42);
        assert_eq!(monday.days[0].date, "2026-10-26");
        assert!(!monday.days[0].in_month && monday.days[6].in_month);
        assert_eq!(
            (
                monday.days[35].date.as_str(),
                monday.days[35].day,
                monday.days[35].in_month
            ),
            ("2026-11-30", 30, true)
        );
        assert_eq!(monday.days[41].date, "2026-12-06");
    }

    #[test]
    fn month_grid_has_four_five_or_six_weeks() {
        // February 2026 is exactly four weeks from Sunday; a 31-day month that starts late needs six.
        assert_eq!(month_grid(2026, 2, 0).unwrap().days.len(), 28);
        assert_eq!(month_grid(2026, 8, 0).unwrap().days.len(), 42);
        assert_eq!(month_grid(2026, 8, 1).unwrap().days.len(), 42);
        for first in 0..7 {
            for month in 1..=12 {
                let grid = month_grid(2026, month, first).unwrap();
                assert_eq!(grid.days.len() % 7, 0);
                assert!(grid.days.iter().filter(|d| d.in_month).count() >= 28);
                assert!(grid.days[0].date.as_str() <= format!("2026-{month:02}-01").as_str());
            }
        }
    }

    #[test]
    fn month_grid_crosses_the_year() {
        let december = month_grid(2026, 12, 0).unwrap();
        assert_eq!(december.days[0].date, "2026-11-29");
        assert_eq!(december.days.last().unwrap().date, "2027-01-02");
        let january = month_grid(2027, 1, 0).unwrap();
        assert_eq!(january.days[0].date, "2026-12-27");
    }

    #[test]
    fn month_grid_refuses_a_bad_month_or_first_day() {
        assert!(month_grid(2026, 0, 0).is_err());
        assert!(month_grid(2026, 13, 0).is_err());
        assert!(month_grid(2026, 11, 7).is_err());
        assert!(month_grid(0, 1, 0).is_err());
        assert!(month_grid(10000, 1, 0).is_err());
        assert!(month_grid(i32::MIN, 1, 0).is_err());
        assert!(month_grid(i32::MAX, 12, 0).is_err());
        assert!(month_grid(9999, 12, 0).is_ok());
        assert!(month_grid(1, 1, 0).is_ok());
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
        let dir = std::env::temp_dir().join(format!("tsunagiai-calendar-{}", std::process::id()));
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
    fn an_event_of_list_events_carries_its_detail_and_what_it_takes_to_change_it() {
        let item = |organizer: &str, role: &str| {
            let ev: ApiEvent = serde_json::from_str(&format!(
                r#"{{"id":"e1","summary":"s","iCalUID":"u","organizer":{organizer},
                    "start":{{"dateTime":"2026-10-29T10:00:00+09:00"}},"end":{{"dateTime":"2026-10-29T11:00:00+09:00"}},
                    "location":"会議室","description":"メモ","hangoutLink":"https://meet.google.com/abc-defg-hij",
                    "attendees":[{{"self":true,"responseStatus":"tentative","email":"me@example.com"}},
                        {{"responseStatus":"accepted","email":"b@example.com"}},
                        {{"responseStatus":"accepted","email":"room@example.com","resource":true}}]}}"#
            ))
            .unwrap();
            let mut entry = cal(None);
            entry.access_role = Some(role.into());
            serde_json::to_value(EventItem::from(
                &RawEvent::from_api(ev, "a@example.com", &entry).unwrap(),
            ))
            .unwrap()
        };
        assert_eq!(
            item(r#"{"self":true}"#, "owner"),
            serde_json::json!({
                "account": "a@example.com",
                "calendar": "仕事",
                "calendarId": "id@example.com",
                "eventId": "e1",
                "summary": "s",
                "declined": false,
                "response": "tentative",
                "allDay": false,
                "start": "2026-10-29T10:00:00+09:00",
                "end": "2026-10-29T11:00:00+09:00",
                "location": "会議室",
                "description": "メモ",
                "meetUrl": "https://meet.google.com/abc-defg-hij",
                "attendees": 2,
                "accepted": 1,
                "guests": ["b@example.com", "room@example.com"],
                "editable": true,
            })
        );
        // An invitation, and an event of a calendar someone else owns, are not editable.
        assert_eq!(item(r#"{}"#, "owner")["editable"], false);
        assert_eq!(item(r#"{"self":true}"#, "reader")["editable"], false);
        // The guests are for changing the event: an event that cannot be changed has none.
        assert_eq!(item(r#"{}"#, "owner")["guests"], serde_json::json!([]));
        assert_eq!(
            item(r#"{"self":true}"#, "reader")["guests"],
            serde_json::json!([])
        );
        // A text that is blank is none, as the screen has it.
        let ev: ApiEvent = serde_json::from_str(
            r#"{"start":{"date":"2026-10-29"},"end":{"date":"2026-10-30"},"location":" ","description":""}"#,
        )
        .unwrap();
        let blank = serde_json::to_value(EventItem::from(
            &RawEvent::from_api(ev, "a@example.com", &cal(None)).unwrap(),
        ))
        .unwrap();
        assert_eq!(blank["location"], serde_json::Value::Null);
        assert_eq!(blank["description"], serde_json::Value::Null);
        assert_eq!(blank["meetUrl"], serde_json::Value::Null);
        assert_eq!(blank["response"], "unknown");
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
            "tsunagiai-calendar-selection-{name}-{}",
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

    // ---- creating an event ----

    fn new_event() -> NewEvent {
        NewEvent {
            account: "a@example.com".into(),
            calendar_id: "id@example.com".into(),
            title: "定例".into(),
            all_day: false,
            start: "2026-11-20T10:00:00+09:00".into(),
            end: "2026-11-20T11:00:00+09:00".into(),
            guests: Vec::new(),
            meet: false,
            description: String::new(),
        }
    }

    fn all_day_event(start: &str, end: &str) -> NewEvent {
        NewEvent {
            all_day: true,
            start: start.into(),
            end: end.into(),
            ..new_event()
        }
    }

    fn query_of(q: &[(&str, &str)], key: &str) -> Option<String> {
        q.iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.to_string())
    }

    #[test]
    fn a_timed_event_with_guests_and_meet_is_built_for_the_api() {
        let event = NewEvent {
            guests: vec!["b@example.com".into(), " C@Example.com ".into()],
            meet: true,
            description: "議題".into(),
            ..new_event()
        };
        let (query, body) = build_insert(&event, "req-1").unwrap();
        assert_eq!(
            query_of(&query, "conferenceDataVersion").as_deref(),
            Some("1")
        );
        assert_eq!(query_of(&query, "sendUpdates").as_deref(), Some("all"));
        assert_eq!(
            query_of(&query, "fields").as_deref(),
            Some("id,hangoutLink")
        );
        assert_eq!(
            body,
            serde_json::json!({
                "summary": "定例",
                "description": "議題",
                "start": {"dateTime": "2026-11-20T10:00:00+09:00"},
                "end": {"dateTime": "2026-11-20T11:00:00+09:00"},
                "attendees": [{"email": "b@example.com"}, {"email": "C@Example.com"}],
                "conferenceData": {"createRequest": {
                    "requestId": "req-1",
                    "conferenceSolutionKey": {"type": "hangoutsMeet"}
                }}
            })
        );
    }

    #[test]
    fn an_event_without_guests_or_meet_sends_no_invitation_and_no_conference() {
        let (query, body) = build_insert(&new_event(), "req-1").unwrap();
        assert_eq!(query_of(&query, "sendUpdates").as_deref(), Some("none"));
        assert_eq!(query_of(&query, "conferenceDataVersion"), None);
        assert!(body.get("conferenceData").is_none());
        assert!(body.get("attendees").is_none());
        assert!(body.get("description").is_none());
    }

    #[test]
    fn a_blank_title_is_left_out_and_the_title_is_trimmed() {
        let blank = NewEvent {
            title: "  ".into(),
            ..new_event()
        };
        assert!(build_insert(&blank, "r")
            .unwrap()
            .1
            .get("summary")
            .is_none());
        let padded = NewEvent {
            title: " 定例 ".into(),
            ..new_event()
        };
        assert_eq!(build_insert(&padded, "r").unwrap().1["summary"], "定例");
    }

    #[test]
    fn an_all_day_event_ends_the_day_after_its_last_day() {
        let (_, body) = build_insert(&all_day_event("2026-11-20", "2026-11-22"), "r").unwrap();
        assert_eq!(body["start"], serde_json::json!({"date": "2026-11-20"}));
        assert_eq!(body["end"], serde_json::json!({"date": "2026-11-23"}));
        let (_, one) = build_insert(&all_day_event("2026-12-31", "2026-12-31"), "r").unwrap();
        assert_eq!(one["end"], serde_json::json!({"date": "2027-01-01"}));
    }

    #[test]
    fn a_timed_event_keeps_its_offset_and_accepts_utc() {
        let event = NewEvent {
            start: "2026-11-20T01:00:00Z".into(),
            end: "2026-11-20T02:30:00.000Z".into(),
            ..new_event()
        };
        let (_, body) = build_insert(&event, "r").unwrap();
        assert_eq!(body["start"]["dateTime"], "2026-11-20T01:00:00+00:00");
        assert_eq!(body["end"]["dateTime"], "2026-11-20T02:30:00+00:00");
    }

    #[test]
    fn bad_input_is_refused_in_japanese() {
        let long = "あ".repeat(TITLE_MAX + 1);
        let guests = |g: &[&str]| NewEvent {
            guests: g.iter().map(|s| s.to_string()).collect(),
            ..new_event()
        };
        let many: Vec<String> = (0..=GUESTS_MAX)
            .map(|i| format!("g{i}@example.com"))
            .collect();
        let cases = vec![
            // start after end
            NewEvent {
                start: "2026-11-20T11:00:00+09:00".into(),
                end: "2026-11-20T10:00:00+09:00".into(),
                ..new_event()
            },
            all_day_event("2026-11-21", "2026-11-20"),
            // not a date or a date and time
            all_day_event("2026-11-20", "2026-13-01"),
            all_day_event("2026-11-20T10:00:00+09:00", "2026-11-21"),
            NewEvent {
                start: "2026-11-20".into(),
                ..new_event()
            },
            NewEvent {
                end: "あした".into(),
                ..new_event()
            },
            // guests
            guests(&[""]),
            guests(&["  "]),
            guests(&["not-an-address"]),
            guests(&["a@b"]),
            guests(&["a b@example.com"]),
            guests(&["<a@example.com>"]),
            guests(&["a@example.com,b@example.com"]),
            // a format or zero-width character, or a look-alike letter, would send the invitation to another address than the chip shows
            guests(&["a@exam\u{202E}ple.com"]),
            guests(&["a\u{200B}@example.com"]),
            guests(&["a@exаmple.com"]),
            guests(&["a@example.com", "A@EXAMPLE.com"]),
            NewEvent {
                guests: many,
                ..new_event()
            },
            // lengths
            NewEvent {
                title: long,
                ..new_event()
            },
            NewEvent {
                description: "あ".repeat(DESCRIPTION_INPUT_MAX + 1),
                ..new_event()
            },
        ];
        for event in cases {
            let e = build_insert(&event, "r").unwrap_err();
            assert!(!e.is_ascii(), "not Japanese: {e}");
        }
    }

    #[test]
    fn the_longest_title_and_description_are_accepted() {
        let event = NewEvent {
            title: "あ".repeat(TITLE_MAX),
            description: "あ".repeat(DESCRIPTION_INPUT_MAX),
            ..new_event()
        };
        assert!(build_insert(&event, "r").is_ok());
    }

    #[test]
    fn only_a_calendar_the_user_owns_takes_an_event() {
        let calendars = [
            entry("mine", true, Some("owner")),
            entry("shared", true, Some("writer")),
            entry("holiday", true, Some("reader")),
            entry("none", true, None),
        ];
        assert!(owned_calendar(&calendars, "mine", CREATE_REFUSAL).is_ok());
        for id in ["shared", "holiday", "none", "missing"] {
            let e = owned_calendar(&calendars, id, CREATE_REFUSAL).unwrap_err();
            assert!(!e.is_ascii(), "not Japanese: {e}");
        }
    }

    #[test]
    fn the_list_of_calendars_to_create_in_keeps_the_owned_ones_only() {
        let choice = |id: &str, mine: bool| CalendarChoice {
            id: id.into(),
            name: id.into(),
            color: None,
            mine,
            shown: true,
        };
        let mut choices = CalendarChoices {
            accounts: vec![
                AccountCalendars {
                    account: "a@example.com".into(),
                    calendars: vec![choice("mine", true), choice("shared", false)],
                },
                AccountCalendars {
                    account: "b@example.com".into(),
                    calendars: vec![choice("holiday", false)],
                },
            ],
            needs_login: vec!["c@example.com".into()],
            failed: HashMap::new(),
        };
        owned_only(&mut choices);
        assert_eq!(choices.accounts.len(), 1);
        assert_eq!(choices.accounts[0].account, "a@example.com");
        assert_eq!(choices.accounts[0].calendars.len(), 1);
        assert_eq!(choices.accounts[0].calendars[0].id, "mine");
        assert_eq!(choices.needs_login, ["c@example.com"]);
    }

    #[test]
    fn the_answer_gives_the_id_and_only_a_meet_link() {
        let created: ApiCreated = serde_json::from_str(
            r#"{"id":"e1","hangoutLink":"https://meet.google.com/abc-defg-hij","kind":"calendar#event"}"#,
        )
        .unwrap();
        let created = CreatedEvent::from(created);
        assert_eq!(created.id, "e1");
        assert_eq!(
            created.meet_url.as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
        let plain: ApiCreated = serde_json::from_str(r#"{"id":"e2"}"#).unwrap();
        assert_eq!(CreatedEvent::from(plain).meet_url, None);
        let other: ApiCreated =
            serde_json::from_str(r#"{"id":"e3","hangoutLink":"https://example.com/x"}"#).unwrap();
        assert_eq!(CreatedEvent::from(other).meet_url, None);
    }

    /// Serves one response and returns what it received (the request head and body) once it is done.
    fn serve_once(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/calendars/c/events",
            listener.local_addr().unwrap()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(str::to_owned)
                        })
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&got).to_string()
        });
        (url, handle)
    }

    fn post_to(
        url: &str,
        query: &[(&str, &str)],
        body: &serde_json::Value,
    ) -> Result<Option<ApiCreated>, crate::gmail::ApiError> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(crate::gmail::send_json::<ApiCreated>(
                &reqwest::Client::new(),
                Method::POST,
                "token",
                url,
                query,
                Some(body),
                0,
            ))
    }

    #[test]
    fn the_request_reaches_the_server_as_built_and_the_answer_is_read() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 70\r\nConnection: close\r\n\r\n{\"id\":\"e1\",\"hangoutLink\":\"https://meet.google.com/abc-defg-hij\",\"x\":1}";
        let (url, server) = serve_once(ok);
        let event = NewEvent {
            guests: vec!["b@example.com".into()],
            meet: true,
            ..new_event()
        };
        let (query, body) = build_insert(&event, "req-9").unwrap();
        let created = post_to(&url, &query, &body).unwrap().unwrap();
        let request = server.join().unwrap();
        let (head, sent) = request.split_once("\r\n\r\n").unwrap();
        let line = head.lines().next().unwrap();
        assert!(line.starts_with("POST /calendars/c/events?"), "{line}");
        assert!(line.contains("conferenceDataVersion=1"), "{line}");
        assert!(line.contains("sendUpdates=all"), "{line}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(sent).unwrap(),
            body
        );
        let created = CreatedEvent::from(created);
        assert_eq!(created.id, "e1");
        assert_eq!(
            created.meet_url.as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
    }

    fn pairs<'a>(slots: &'a [(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        slots.to_vec()
    }

    #[test]
    fn candidates_of_free_time_become_the_fields_slot1_to_slot8() {
        let fields = slot_fields(&pairs(&[
            ("2026-11-19T10:00", "2026-11-19T12:00"),
            ("2026-11-20T13:30", "2026-11-20T14:15"),
        ]))
        .unwrap();
        assert_eq!(
            fields.into_iter().collect::<Vec<_>>(),
            [
                (
                    "slot1".to_owned(),
                    "2026-11-19T10:00/2026-11-19T12:00".to_owned()
                ),
                (
                    "slot2".to_owned(),
                    "2026-11-20T13:30/2026-11-20T14:15".to_owned()
                ),
            ]
        );
        let eight = vec![("2026-11-19T10:00", "2026-11-19T11:00"); MAX_SLOTS];
        assert_eq!(slot_fields(&eight).unwrap().len(), 8);
        assert!(slot_fields(&pairs(&[("2026-02-28T00:00", "2026-02-28T23:59")])).is_ok());
        assert!(slot_fields(&pairs(&[("2028-02-29T09:00", "2028-02-29T10:00")])).is_ok());
    }

    #[test]
    fn one_to_eight_candidates_are_taken() {
        for count in [0, MAX_SLOTS + 1] {
            let slots = vec![("2026-11-19T10:00", "2026-11-19T11:00"); count];
            let error = slot_fields(&slots).unwrap_err();
            assert!(error.contains("1 件から 8 件"), "{error}");
            assert!(error.contains(&format!("{count} 件")), "{error}");
        }
    }

    #[test]
    fn a_time_must_be_exactly_the_shape_and_exist() {
        for bad in [
            "",
            "2026-11-19 10:00",
            "2026-11-19T10:00:00",
            "2026-11-19T10:00Z",
            "2026-11-19T1:00",
            "2026-1-19T10:00",
            "26-11-19T10:00",
            " 2026-11-19T10:00",
            "+026-11-19T10:00",
            "2026/11/19T10:00",
            "2026-11-19t10:00",
            "２０２６-11-19T10:00",
            "2026-02-30T10:00",
            "2027-02-29T10:00",
            "2026-13-01T10:00",
            "2026-11-19T24:00",
            "2026-11-19T10:60",
        ] {
            let start = slot_fields(&pairs(&[(bad, "2026-11-19T12:00")])).unwrap_err();
            assert!(
                start.contains("候補1の開始の日時が正しくありません"),
                "{bad}: {start}"
            );
            let end = slot_fields(&pairs(&[("2026-11-19T10:00", bad)])).unwrap_err();
            assert!(
                end.contains("候補1の終了の日時が正しくありません"),
                "{bad}: {end}"
            );
        }
        // The second candidate is the one named.
        let error = slot_fields(&pairs(&[
            ("2026-11-19T10:00", "2026-11-19T11:00"),
            ("2026-11-19T10:00", "tomorrow"),
        ]))
        .unwrap_err();
        assert!(error.contains("候補2の終了"), "{error}");
        // A long text is cut in the message.
        let long = "x".repeat(500);
        let error = slot_fields(&pairs(&[(&long, "2026-11-19T12:00")])).unwrap_err();
        assert!(error.len() < 400, "{error}");
    }

    #[test]
    fn a_candidate_ends_after_it_starts_and_on_the_same_day() {
        for (start, end) in [
            ("2026-11-19T10:00", "2026-11-19T10:00"),
            ("2026-11-19T12:00", "2026-11-19T10:00"),
            ("2026-11-20T10:00", "2026-11-19T12:00"),
        ] {
            let error = slot_fields(&pairs(&[(start, end)])).unwrap_err();
            assert!(error.contains("候補1は終了が開始より後"), "{error}");
        }
        for (start, end) in [
            ("2026-11-19T23:00", "2026-11-20T00:30"),
            ("2026-11-19T10:00", "2026-11-21T10:00"),
            ("2026-12-31T22:00", "2027-01-01T01:00"),
        ] {
            let error = slot_fields(&pairs(&[(start, end)])).unwrap_err();
            assert!(
                error.contains("候補1は同じ日の中で終わらせてください"),
                "{error}"
            );
        }
        // Nothing is given to the screen when one candidate is wrong.
        assert!(slot_fields(&pairs(&[
            ("2026-11-19T10:00", "2026-11-19T11:00"),
            ("2026-11-19T12:00", "2026-11-19T11:00"),
        ]))
        .is_err());
    }

    #[test]
    fn a_403_for_an_old_scope_while_creating_means_login_again() {
        let denied = "HTTP/1.1 403 Forbidden\r\nContent-Length: 130\r\nConnection: close\r\n\r\n{\"error\":{\"code\":403,\"message\":\"Request had insufficient authentication scopes.\",\"errors\":[{\"reason\":\"insufficientPermissions\"}]}}";
        let (url, server) = serve_once(denied);
        let (query, body) = build_insert(&new_event(), "r").unwrap();
        let e = post_to(&url, &query, &body).unwrap_err();
        server.join().unwrap();
        assert_eq!(e.status, Some(403));
        assert_eq!(classify(e.status, &e.message), Failure::NeedsLogin);
    }

    fn organizer(is_self: bool) -> Option<ApiOrganizer> {
        Some(ApiOrganizer { is_self })
    }

    #[test]
    fn only_an_event_the_user_organized_on_their_own_calendar_can_be_changed() {
        assert!(can_change(true, true));
        // Invited to it, or on a calendar that someone else owns.
        assert!(!can_change(true, false));
        assert!(!can_change(false, true));
        assert!(!can_change(false, false));
        assert!(organizer_is_self(&organizer(true)));
        assert!(!organizer_is_self(&organizer(false)));
        assert!(!organizer_is_self(&None));
    }

    #[test]
    fn the_week_marks_the_events_that_can_be_changed() {
        let api = |json: &str| serde_json::from_str::<ApiEvent>(json).unwrap();
        let start = r#""start":{"date":"2026-11-20"},"end":{"date":"2026-11-21"}"#;
        let mine = api(&format!(
            r#"{{"id":"e1_20261120","organizer":{{"self":true}},{start}}}"#
        ));
        let invited = api(&format!(
            r#"{{"id":"e2","organizer":{{"email":"x@example.com"}},{start}}}"#
        ));
        let unknown = api(&format!(r#"{{"id":"e3",{start}}}"#));
        let mut other = cal(None);
        other.access_role = Some("writer".into());
        let marked =
            |e: ApiEvent, c: &CalendarEntry| RawEvent::from_api(e, "a@example.com", c).unwrap();

        let e = marked(mine, &cal(None));
        assert!(e.editable);
        assert_eq!(
            (e.event_id.as_str(), e.calendar_id.as_str()),
            ("e1_20261120", "id@example.com")
        );
        assert!(!marked(invited, &cal(None)).editable);
        assert!(!marked(unknown, &cal(None)).editable);
        let on_other = api(&format!(
            r#"{{"id":"e4","organizer":{{"self":true}},{start}}}"#
        ));
        assert!(!marked(on_other, &other).editable);
        // It reaches the screen with the event.
        let info = Info::new(
            &marked(
                api(&format!(
                    r#"{{"id":"e5","organizer":{{"self":true}},{start}}}"#
                )),
                &cal(None),
            ),
            &jst(),
        );
        assert_eq!((info.event_id.as_str(), info.editable), ("e5", true));
    }

    #[test]
    fn the_week_carries_the_event_as_the_form_starts_from_it() {
        let api = |json: &str| serde_json::from_str::<ApiEvent>(json).unwrap();
        let info = |e: ApiEvent| {
            Info::new(
                &RawEvent::from_api(e, "a@example.com", &cal(None)).unwrap(),
                &jst(),
            )
        };
        // The guests are the invited besides the user, a room among them; the user's own entry and one with no address are left out.
        let timed = info(api(
            r#"{"id":"e","start":{"dateTime":"2026-11-20T13:00:00+09:00"},"end":{"dateTime":"2026-11-20T14:30:00+09:00"},
                "attendees":[{"email":"me@example.com","self":true},{"email":"b@example.com"},
                {"email":"room@resource.calendar.google.com","resource":true},{}]}"#,
        ));
        assert!(!timed.all_day);
        assert_eq!(timed.start, "2026-11-20T13:00:00+09:00");
        assert_eq!(timed.end, "2026-11-20T14:30:00+09:00");
        assert_eq!(
            timed.guests,
            ["b@example.com", "room@resource.calendar.google.com"]
        );
        // An all-day event ends on its last day, not on the day after as the API says.
        let all_day = info(api(
            r#"{"id":"e","start":{"date":"2026-11-20"},"end":{"date":"2026-11-23"}}"#,
        ));
        assert!(all_day.all_day);
        assert_eq!(
            (all_day.start.as_str(), all_day.end.as_str()),
            ("2026-11-20", "2026-11-22")
        );
        assert!(all_day.guests.is_empty());
    }

    #[test]
    fn a_kept_week_of_an_older_version_has_no_mark_and_cannot_be_changed() {
        let old = r##"{"summary":"a","color":null,"account":"a@example.com"}"##;
        let info: Info = serde_json::from_str(old).unwrap();
        assert_eq!(
            (
                info.event_id.as_str(),
                info.calendar_id.as_str(),
                info.editable
            ),
            ("", "", false)
        );
        assert_eq!(
            (
                info.all_day,
                info.start.as_str(),
                info.end.as_str(),
                info.guests.len()
            ),
            (false, "", "", 0)
        );
    }

    #[test]
    fn the_user_is_told_in_japanese_when_they_did_not_organize_the_event() {
        assert!(check_organizer(true).is_ok());
        let e = check_organizer(false).unwrap_err();
        assert!(!e.is_ascii(), "not Japanese: {e}");
        let calendars = vec![cal(None)];
        let refusal = owned_calendar(&calendars, "missing", CHANGE_REFUSAL).unwrap_err();
        assert!(!refusal.is_ascii(), "not Japanese: {refusal}");
        let mut other = cal(None);
        other.access_role = Some("reader".into());
        let e = owned_calendar(&[other], "id@example.com", CHANGE_REFUSAL).unwrap_err();
        assert_eq!(e, CHANGE_REFUSAL);
    }

    #[test]
    fn the_url_of_an_event_is_the_calendar_and_the_event_as_two_segments() {
        assert_eq!(
            event_url("a@example.com", "abc_20261120T010000Z").unwrap(),
            "https://www.googleapis.com/calendar/v3/calendars/a@example.com/events/abc_20261120T010000Z"
        );
        assert!(event_url("c", "a/b").unwrap().ends_with("/events/a%2Fb"));
        for bad in ["", ".", "..", &"x".repeat(CALENDAR_ID_MAX + 1)] {
            assert!(event_url("c", bad).is_err(), "{bad}");
        }
        assert!(event_url("", "e").is_err());
    }

    fn current(json: &str) -> ApiCurrent {
        serde_json::from_str(json).unwrap()
    }

    fn patch_body(event: &NewEvent, now: &str) -> (Query, Value) {
        build_patch(event, "req-1", &current(now), false, false).unwrap()
    }

    #[test]
    fn a_patch_names_every_field_so_that_an_empty_one_clears_it() {
        let (query, body) = patch_body(
            &NewEvent {
                title: "  ".into(),
                ..new_event()
            },
            "{}",
        );
        assert_eq!(
            body,
            json!({
                "summary": "",
                "description": "",
                "start": {"dateTime": "2026-11-20T10:00:00+09:00", "date": null},
                "end": {"dateTime": "2026-11-20T11:00:00+09:00", "date": null},
                "attendees": [],
            })
        );
        assert!(query.contains(&("fields", "id,hangoutLink")));
        assert!(query.contains(&("sendUpdates", "none")));
        assert!(!query.iter().any(|(k, _)| *k == "conferenceDataVersion"));
        let (_, body) = patch_body(
            &NewEvent {
                title: " 定例 ".into(),
                description: "議題".into(),
                ..new_event()
            },
            "{}",
        );
        assert_eq!(
            (body["summary"].as_str(), body["description"].as_str()),
            (Some("定例"), Some("議題"))
        );
    }

    #[test]
    fn a_patch_turns_an_all_day_event_into_a_timed_one_and_back() {
        let (_, body) = patch_body(&all_day_event("2026-11-20", "2026-11-22"), "{}");
        assert_eq!(
            body["start"],
            json!({"date": "2026-11-20", "dateTime": null})
        );
        // The last day is included: the API's end is the day after.
        assert_eq!(body["end"], json!({"date": "2026-11-23", "dateTime": null}));
        let (_, body) = patch_body(&new_event(), "{}");
        assert_eq!(body["start"]["date"], Value::Null);
        assert_eq!(
            body["start"]["dateTime"],
            json!("2026-11-20T10:00:00+09:00")
        );
    }

    #[test]
    fn a_patch_sets_the_guests_and_notifies_them() {
        let event = NewEvent {
            guests: vec!["b@example.com".into(), "c@example.com".into()],
            ..new_event()
        };
        let (query, body) = patch_body(&event, "{}");
        assert_eq!(
            body["attendees"],
            json!([{"email": "b@example.com"}, {"email": "c@example.com"}])
        );
        assert!(query.contains(&("sendUpdates", "all")));
        // Guests taken off are told too, so the invitation does not stay in their calendars.
        let (query, body) = patch_body(&new_event(), r#"{"attendees":[{"self":true},{}]}"#);
        assert_eq!(body["attendees"], json!([]));
        assert!(query.contains(&("sendUpdates", "all")));
    }

    #[test]
    fn a_patch_adds_keeps_or_takes_off_the_meet_by_what_the_event_has() {
        let has = r#"{"hangoutLink":"https://meet.google.com/abc-defg-hij"}"#;
        let wants = NewEvent {
            meet: true,
            ..new_event()
        };
        let (query, body) = patch_body(&wants, "{}");
        assert_eq!(
            body["conferenceData"]["createRequest"]["requestId"],
            "req-1"
        );
        assert_eq!(
            body["conferenceData"]["createRequest"]["conferenceSolutionKey"]["type"],
            "hangoutsMeet"
        );
        assert!(query.contains(&("conferenceDataVersion", "1")));
        // Already there: it is left as it is, so no second conference is made.
        let (query, body) = patch_body(&wants, has);
        assert!(body.get("conferenceData").is_none());
        assert!(!query.iter().any(|(k, _)| *k == "conferenceDataVersion"));
        // Taken off.
        let (query, body) = patch_body(&new_event(), has);
        assert_eq!(body["conferenceData"], Value::Null);
        assert!(body.as_object().unwrap().contains_key("conferenceData"));
        assert!(query.contains(&("conferenceDataVersion", "1")));
        // A link to anywhere else is not a Meet.
        let (_, body) = patch_body(&new_event(), r#"{"hangoutLink":"https://example.com/x"}"#);
        assert!(body.get("conferenceData").is_none());
    }

    #[test]
    fn a_patch_checks_the_input_as_a_create_does() {
        for bad in [
            NewEvent {
                title: "x".repeat(TITLE_MAX + 1),
                ..new_event()
            },
            NewEvent {
                description: "x".repeat(DESCRIPTION_INPUT_MAX + 1),
                ..new_event()
            },
            NewEvent {
                guests: vec!["not-an-address".into()],
                ..new_event()
            },
            NewEvent {
                start: "2026-11-20T12:00:00+09:00".into(),
                ..new_event()
            },
            NewEvent {
                start: "tomorrow".into(),
                ..new_event()
            },
        ] {
            let e = build_patch(&bad, "r", &ApiCurrent::default(), false, false).unwrap_err();
            assert!(!e.is_ascii(), "not Japanese: {e}");
        }
    }

    #[test]
    fn a_delete_notifies_the_guests_only_when_there_are_some() {
        assert_eq!(build_delete(&current("{}")), [("sendUpdates", "none")]);
        assert_eq!(
            build_delete(&current(r#"{"attendees":[{"self":true},{}]}"#)),
            [("sendUpdates", "all")]
        );
    }

    fn request_to(
        method: Method,
        url: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Option<Value>, crate::gmail::ApiError> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(crate::gmail::send_json::<Value>(
                &reqwest::Client::new(),
                method,
                "token",
                url,
                query,
                body,
                0,
            ))
    }

    #[test]
    fn the_patch_reaches_the_server_as_built_and_the_answer_is_read() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 30\r\nConnection: close\r\n\r\n{\"id\":\"e1\",\"hangoutLink\":null}";
        let (url, server) = serve_once(ok);
        let event = NewEvent {
            guests: vec!["b@example.com".into()],
            meet: true,
            ..new_event()
        };
        let (query, body) =
            build_patch(&event, "req-9", &ApiCurrent::default(), false, false).unwrap();
        let answer = request_to(
            Method::PATCH,
            &event_url_of(&url, "e1"),
            &query,
            Some(&body),
        )
        .unwrap()
        .unwrap();
        let request = server.join().unwrap();
        let (head, sent) = request.split_once("\r\n\r\n").unwrap();
        let line = head.lines().next().unwrap();
        assert!(line.starts_with("PATCH /calendars/c/events/e1?"), "{line}");
        assert!(line.contains("sendUpdates=all"), "{line}");
        assert!(line.contains("conferenceDataVersion=1"), "{line}");
        assert_eq!(serde_json::from_str::<Value>(sent).unwrap(), body);
        assert_eq!(answer["id"], "e1");
    }

    #[test]
    fn the_delete_reaches_the_server_and_an_answer_with_no_body_is_read() {
        let gone = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
        let (url, server) = serve_once(gone);
        let query = build_delete(&current(r#"{"attendees":[{}]}"#));
        let answer = request_to(
            Method::DELETE,
            &event_url_of(&url, "e1_20261120"),
            &query,
            None,
        )
        .unwrap();
        let request = server.join().unwrap();
        let line = request.lines().next().unwrap();
        assert!(
            line.starts_with("DELETE /calendars/c/events/e1_20261120?"),
            "{line}"
        );
        assert!(line.contains("sendUpdates=all"), "{line}");
        assert_eq!(answer, Some(Value::Null));
    }

    #[test]
    fn the_event_is_read_before_it_is_changed() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 120\r\nConnection: close\r\n\r\n{\"organizer\":{\"self\":true},\"hangoutLink\":\"https://meet.google.com/abc-defg-hij\",\"attendees\":[{\"email\":\"b@example.com\"}]}";
        let (url, server) = serve_once(ok);
        let got = request_to(
            Method::GET,
            &event_url_of(&url, "e1"),
            &[("fields", CURRENT_FIELDS)],
            None,
        )
        .unwrap()
        .unwrap();
        let request = server.join().unwrap();
        let line = request.lines().next().unwrap();
        assert!(
            line.starts_with("GET /calendars/c/events/e1?fields="),
            "{line}"
        );
        let now: ApiCurrent = serde_json::from_value(got).unwrap();
        assert!(organizer_is_self(&now.organizer));
        assert_eq!(now.attendees.len(), 1);
        assert!(now.hangout_link.is_some());
    }

    #[test]
    fn a_401_while_changing_means_the_token_is_refreshed_and_a_403_for_an_old_scope_means_login_again(
    ) {
        let rejected =
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        for method in [Method::PATCH, Method::DELETE] {
            let (url, server) = serve_once(rejected);
            let body = json!({});
            let sent = (method == Method::PATCH).then_some(&body);
            assert_eq!(
                request_to(method, &event_url_of(&url, "e1"), &[], sent).unwrap(),
                None
            );
            server.join().unwrap();
        }
        let denied = "HTTP/1.1 403 Forbidden\r\nContent-Length: 130\r\nConnection: close\r\n\r\n{\"error\":{\"code\":403,\"message\":\"Request had insufficient authentication scopes.\",\"errors\":[{\"reason\":\"insufficientPermissions\"}]}}";
        for method in [Method::PATCH, Method::DELETE] {
            let (url, server) = serve_once(denied);
            let e = request_to(method, &event_url_of(&url, "e1"), &[], None).unwrap_err();
            server.join().unwrap();
            assert_eq!(e.status, Some(403));
            assert_eq!(classify(e.status, &e.message), Failure::NeedsLogin);
        }
    }

    #[test]
    fn the_description_that_claude_reads_is_cut_with_a_mark_and_the_screens_is_not() {
        assert_eq!(clip_for_claude("説明"), "説明");
        let exact = "あ".repeat(CLAUDE_DESCRIPTION_MAX);
        assert_eq!(clip_for_claude(&exact), exact);
        let cut = clip_for_claude(&format!("{exact}いう"));
        assert!(cut.starts_with(&exact), "{cut}");
        assert!(cut.contains("2 文字"), "{cut}");
        let long = "い".repeat(CLAUDE_DESCRIPTION_MAX + 5);
        let ev: ApiEvent = serde_json::from_value(serde_json::json!({
            "start": {"date": "2026-10-29"}, "end": {"date": "2026-10-30"}, "description": long
        }))
        .unwrap();
        let raw = RawEvent::from_api(ev, "a@example.com", &cal(None)).unwrap();
        let item = serde_json::to_value(EventItem::from(&raw)).unwrap();
        assert!(item["description"].as_str().unwrap().contains("5 文字"));
        // The week's detail keeps what C-2 shows.
        assert_eq!(raw.description.as_deref(), Some(long.as_str()));
    }

    #[test]
    fn the_series_of_a_repeating_event_is_refused_in_japanese_and_one_occurrence_is_not() {
        let series = current(r#"{"organizer":{"self":true},"recurrence":["RRULE:FREQ=WEEKLY"]}"#);
        let e = check_current(&series).unwrap_err();
        assert!(!e.is_ascii(), "not Japanese: {e}");
        assert!(check_current(&current(r#"{"organizer":{"self":true}}"#)).is_ok());
        // Not the user's own: the organizer is named first.
        let e = check_current(&current(r#"{"recurrence":["RRULE:FREQ=DAILY"]}"#)).unwrap_err();
        assert_eq!(e, check_organizer(false).unwrap_err());
        assert!(CURRENT_FIELDS.contains("recurrence"));
    }

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn a_tool_of_claude_holds_an_event_that_invites_someone_new_and_sends_the_rest() {
        // A new event: every guest is new, and none is none.
        assert!(has_new_guest(&[], &words(&["b@example.com"])));
        assert!(!has_new_guest(&[], &[]));
        // A rewrite: the guests who are on the event are not new, whatever the case of the address.
        let known = words(&["me@example.com", "B@Example.com", "room@example.com"]);
        assert!(!has_new_guest(&known, &words(&["b@example.com"])));
        assert!(!has_new_guest(
            &known,
            &words(&["room@example.com", "b@example.com"])
        ));
        assert!(!has_new_guest(&known, &[]));
        assert!(has_new_guest(
            &known,
            &words(&["b@example.com", "c@example.com"])
        ));
        let now = current(
            r#"{"attendees":[{"self":true,"email":"me@example.com"},{"email":"B@Example.com"},{}]}"#,
        );
        assert_eq!(now.addresses(), ["me@example.com", "B@Example.com", ""]);
    }

    #[test]
    fn a_patch_sends_the_guests_who_stay_as_google_has_them_and_a_new_one_by_address() {
        let now = current(
            r#"{"attendees":[{"self":true,"email":"me@example.com"},
                {"email":"B@Example.com","optional":true,"displayName":"B さん","responseStatus":"accepted"}]}"#,
        );
        let event = NewEvent {
            guests: vec!["b@example.com".into(), "c@example.com".into()],
            ..new_event()
        };
        let (_, body) = build_patch(&event, "r", &now, false, false).unwrap();
        assert_eq!(
            body["attendees"],
            json!([
                {"email":"B@Example.com","optional":true,"displayName":"B さん","responseStatus":"accepted"},
                {"email": "c@example.com"},
            ])
        );
    }

    #[test]
    fn a_patch_with_no_guests_given_leaves_the_guests_and_still_tells_them() {
        let now = current(r#"{"attendees":[{"self":true},{"email":"b@example.com"}]}"#);
        let event = NewEvent {
            title: "新しい題".into(),
            ..new_event()
        };
        let (query, body) = build_patch(&event, "r", &now, true, false).unwrap();
        assert!(!body.as_object().unwrap().contains_key("attendees"));
        assert_eq!(body["summary"], "新しい題");
        assert!(query.contains(&("sendUpdates", "all")));
        // No guest before: no one to tell.
        let (query, body) = build_patch(&event, "r", &current("{}"), true, false).unwrap();
        assert!(!body.as_object().unwrap().contains_key("attendees"));
        assert!(query.contains(&("sendUpdates", "none")));
    }

    #[test]
    fn the_form_of_the_screen_is_given_the_event_as_two_fields() {
        let event = NewEvent {
            guests: vec!["b@example.com".into()],
            meet: true,
            description: "議題\n二行目".into(),
            ..new_event()
        };
        let fields = form_fields(Some("ev1"), &event, false);
        assert_eq!(
            fields.keys().map(String::as_str).collect::<Vec<_>>(),
            ["description", "form"]
        );
        assert_eq!(fields["description"], "議題\n二行目");
        let form: Value = serde_json::from_str(&fields["form"]).unwrap();
        assert_eq!(form["eventId"], "ev1");
        assert_eq!(form["calendarId"], event.calendar_id);
        assert_eq!(form["allDay"], false);
        assert_eq!(form["guests"], json!(["b@example.com"]));
        assert_eq!(form["meet"], true);
        assert_eq!(form["start"], "2026-11-20T10:00:00+09:00");
        // A new event has no ID.
        let form: Value = serde_json::from_str(&form_fields(None, &event, false)["form"]).unwrap();
        assert_eq!(form["eventId"], "");
        // Kept, the description is not a field: the screen then keeps the event's own.
        let kept = form_fields(Some("ev1"), &event, true);
        assert_eq!(
            kept.keys().map(String::as_str).collect::<Vec<_>>(),
            ["form"]
        );
    }

    #[test]
    fn a_patch_leaves_the_description_out_when_it_is_kept() {
        let event = NewEvent {
            description: "ignored".into(),
            ..new_event()
        };
        let (_, body) = build_patch(&event, "r", &current("{}"), false, true).unwrap();
        let named = body.as_object().unwrap();
        assert!(!named.contains_key("description"));
        assert!(named.contains_key("summary") && named.contains_key("start"));
        let (_, body) = build_patch(&event, "r", &current("{}"), false, false).unwrap();
        assert_eq!(body["description"], "ignored");
    }

    #[test]
    fn a_description_that_list_events_cut_is_refused_in_japanese_and_a_plain_one_is_not() {
        let cut = clip_for_claude(&"あ".repeat(CLAUDE_DESCRIPTION_MAX + 7));
        let e = check_not_clipped(&cut).unwrap_err();
        assert!(!e.is_ascii(), "not Japanese: {e}");
        for plain in [
            "".to_owned(),
            "説明".to_owned(),
            "あ".repeat(CLAUDE_DESCRIPTION_MAX),
            "…（長いため、残り 7 文字を省きました）の話".to_owned(),
        ] {
            assert!(check_not_clipped(&plain).is_ok(), "{plain}");
        }
    }

    /// `serve_once` answers for any path; this puts the event after its `.../events`.
    fn event_url_of(events_url: &str, id: &str) -> String {
        format!("{events_url}/{id}")
    }
}
