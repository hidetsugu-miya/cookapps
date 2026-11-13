//! The log of the app (A-28): what happened, kept in a file of the config directory, written from Rust and from the screen and read by the screen.
//!
//! `app-log.jsonl` holds one JSON object a line: the time, the weight (`error`, `warn`, `info`), the place and the text.
//! What goes in is only what the caller says happened, in a few words: never a token, a mail, a message, what a terminal printed or what was typed.
//! The module helps that and does not promise it: the text is cut to `MESSAGE_MAX` characters, a line break becomes a space, and a word that has the shape of a token is masked (`redact`).
//! Old lines are dropped (`MAX_AGE_DAYS`) and the file is kept under `MAX_BYTES`, the newest lines staying (`compact`).
//! The decisions are pure functions that take the time as an argument; the commands and `write` only read the clock and the file.

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_atomic, auth::config_dir};

const FILE: &str = "app-log.jsonl";
/// The most characters of the text of one line; the rest is cut.
const MESSAGE_MAX: usize = 500;
/// The most characters of the place of one line.
const SOURCE_MAX: usize = 64;
/// The file is kept at this size or under.
const MAX_BYTES: usize = 1024 * 1024;
/// A line older than this many days is dropped.
const MAX_AGE_DAYS: i64 = 30;
/// How often a write reads the file to drop old lines (a write also does it when the file passes `MAX_BYTES`).
const PRUNE_EVERY: Duration = Duration::from_secs(60 * 60);
/// What replaces a secret.
const MASK: &str = "***";
/// A write appends, and a compaction replaces the file: two at once would meet.
static WRITING: Mutex<()> = Mutex::new(());
/// When the file was last read to drop old lines in this run; `None` before the first write.
static LAST_PRUNE: Mutex<Option<Instant>> = Mutex::new(None);

/// How much a line matters.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
}

/// One line of the log.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct LogEntry {
    /// When it was written: UTC, RFC 3339 with milliseconds (`2026-11-14T03:04:05.678Z`), so the lines sort by time as text.
    pub time: String,
    pub level: LogLevel,
    /// Where it happened: a command, a module or a screen, as the caller names it.
    pub source: String,
    pub message: String,
}

/// Words that are a secret when they start a word or follow `Bearer`.
const SECRET_PREFIXES: [&str; 12] = [
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxc-",
    "xoxd-",
    "xoxe-",
    "xapp-",
    "ya29.",
    "sk-ant-",
    "ghp_",
    "github_pat_",
    "AIza",
];
/// A name before `=` or `:` whose value is a secret.
const SECRET_NAMES: [&str; 7] = [
    "token",
    "secret",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "authorization",
];

/// The most bytes the file is cut down to when it is compacted, so that the next write does not compact it again.
const COMPACT_TO: usize = MAX_BYTES / 10 * 9;

/// A character that never shows in the log: a control character, a zero-width one or a bidirectional formatting one.
fn is_hidden(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// `text` with line breaks and hidden characters made spaces, the spaces collapsed, the secret-shaped words masked and the result cut to `max` characters (`…` takes the last of them at a cut).
/// The secrets are masked before the cut, so one cut in half is not left unrecognised.
pub fn clean_text(text: &str, max: usize) -> String {
    let spaced: String = text
        .chars()
        .map(|c| if is_hidden(c) { ' ' } else { c })
        .collect();
    let text = redact(&spaced);
    if text.chars().count() <= max {
        return text;
    }
    match max {
        0 => String::new(),
        _ => text.chars().take(max - 1).chain(['…']).collect(),
    }
}

/// A character a token is made of.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._~+/=-".contains(c)
}

/// `word` with every secret of a known service (`SECRET_PREFIXES` and the characters that follow) masked.
fn mask_prefixes(word: &str) -> String {
    let mut out = word.to_owned();
    for prefix in SECRET_PREFIXES {
        let mut from = 0;
        while let Some(i) = out[from..].find(prefix) {
            let start = from + i;
            let body = start + prefix.len();
            let run = out[body..]
                .find(|c: char| !is_token_char(c))
                .unwrap_or(out.len() - body);
            if run == 0 {
                from = body;
                continue;
            }
            out.replace_range(start..body + run, MASK);
            from = start + MASK.len();
        }
    }
    out
}

/// Where the value of a secret name starts in `word` (just after its `=` or `:`) and the name, for the earliest one.
/// `name`, `name=`, `"name":` and `name:` count; `name` alone does not.
fn secret_value(word: &str) -> Option<(usize, &'static str)> {
    let lower = word.to_ascii_lowercase();
    let mut best: Option<(usize, &'static str)> = None;
    for name in SECRET_NAMES {
        let mut from = 0;
        while let Some(i) = lower[from..].find(name) {
            let mut end = from + i + name.len();
            from = end;
            if lower[end..].starts_with(['"', '\'']) {
                end += 1;
            }
            if lower[end..].starts_with(['=', ':']) && best.is_none_or(|(at, _)| end + 1 < at) {
                best = Some((end + 1, name));
            }
        }
    }
    best
}

/// `text` with the words that look like a secret masked: a token of a known service, the value of `token=`, `secret:`, `password=` and the like (the next word when the value is apart), and the word after `Bearer`.
/// The spaces are collapsed. It is a net for what slips through, not a promise: callers do not pass secrets.
fn redact(text: &str) -> String {
    let mut pending = 0;
    let mut out: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        if pending > 0 {
            pending -= 1;
            out.push(MASK.to_owned());
            continue;
        }
        let mut word = word.to_owned();
        if let Some((start, name)) = secret_value(&word) {
            if word[start..].trim_start_matches(['"', '\'']).is_empty() {
                // `Authorization: Bearer abc`: the scheme and the token are both secret.
                pending = if name == "authorization" { 2 } else { 1 };
            } else {
                word.truncate(start);
                word.push_str(MASK);
            }
        } else if word
            .trim_matches(|c: char| !c.is_ascii_alphanumeric())
            .eq_ignore_ascii_case("bearer")
        {
            pending = 1;
        }
        out.push(mask_prefixes(&word));
    }
    out.join(" ")
}

/// The entry for what the caller reported at `now`; an error in Japanese when the text is empty once cleaned.
pub fn make_entry(
    now: DateTime<Utc>,
    level: LogLevel,
    source: &str,
    message: &str,
) -> Result<LogEntry, String> {
    let message = clean_text(message, MESSAGE_MAX);
    if message.is_empty() {
        return Err("ログに残す内容がありません".to_owned());
    }
    let source = clean_text(source, SOURCE_MAX);
    Ok(LogEntry {
        time: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        level,
        source: if source.is_empty() {
            "-".to_owned()
        } else {
            source
        },
        message,
    })
}

/// The line of the file for `entry`, with its line break.
fn render_line(entry: &LogEntry) -> String {
    let mut line = serde_json::to_string(entry).unwrap_or_default();
    line.push('\n');
    line
}

/// The entries of the file's text, in the file's order; a line that is not an entry (or has a time that is not one) is left out.
fn parse_lines(text: &str) -> Vec<LogEntry> {
    text.lines()
        .filter_map(|line| serde_json::from_str::<LogEntry>(line).ok())
        .filter(|e| DateTime::parse_from_rfc3339(&e.time).is_ok())
        .collect()
}

/// What of `entries` (oldest first) is kept at `now`: nothing older than `MAX_AGE_DAYS`, and the newest that fit in `max_bytes` of lines.
fn compact(entries: Vec<LogEntry>, now: DateTime<Utc>, max_bytes: usize) -> Vec<LogEntry> {
    let oldest = now - chrono::Duration::days(MAX_AGE_DAYS);
    let mut kept: Vec<LogEntry> = entries
        .into_iter()
        .filter(|e| DateTime::parse_from_rfc3339(&e.time).is_ok_and(|t| t >= oldest))
        .collect();
    let mut bytes = 0usize;
    let mut fit = 0;
    for e in kept.iter().rev() {
        bytes = bytes.saturating_add(render_line(e).len());
        if bytes > max_bytes {
            break;
        }
        fit += 1;
    }
    kept.drain(..kept.len() - fit);
    kept
}

/// What a read shows: the entries of the file's text that `compact` keeps, the newest first.
fn visible(text: &str, now: DateTime<Utc>) -> Vec<LogEntry> {
    let mut entries = compact(parse_lines(text), now, MAX_BYTES);
    entries.reverse();
    entries
}

/// Whether a write reads the file to drop old lines: the first write of the run, then every `PRUNE_EVERY`.
fn prune_due(since_last: Option<Duration>) -> bool {
    since_last.is_none_or(|d| d >= PRUNE_EVERY)
}

fn log_path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Appends a line for what the caller reported, now. The log is in `dir`, the config directory.
pub fn write(dir: &Path, level: LogLevel, source: &str, message: &str) -> Result<(), String> {
    write_at(dir, Utc::now(), level, source, message)
}

fn write_at(
    dir: &Path,
    now: DateTime<Utc>,
    level: LogLevel,
    source: &str,
    message: &str,
) -> Result<(), String> {
    let line = render_line(&make_entry(now, level, source, message)?);
    let path = log_path(dir);
    let failed = |e: std::io::Error| format!("{} に書けません: {e}", path.display());
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir).map_err(failed)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(failed)?;
    file.write_all(line.as_bytes()).map_err(failed)?;
    let size = file.metadata().map_err(failed)?.len();
    let mut last = LAST_PRUNE.lock().unwrap_or_else(|e| e.into_inner());
    if size > MAX_BYTES as u64 || prune_due(last.map(|at| at.elapsed())) {
        *last = Some(Instant::now());
        let text = String::from_utf8_lossy(&std::fs::read(&path).map_err(failed)?).into_owned();
        let kept: String = compact(parse_lines(&text), now, COMPACT_TO)
            .iter()
            .map(render_line)
            .collect();
        if kept != text {
            write_atomic(dir, FILE, &kept)?;
        }
    }
    Ok(())
}

/// The entries now in the file, the newest first. A file that is missing is an empty list.
pub fn read(dir: &Path) -> Result<Vec<LogEntry>, String> {
    read_at(dir, Utc::now())
}

fn read_at(dir: &Path, now: DateTime<Utc>) -> Result<Vec<LogEntry>, String> {
    let path = log_path(dir);
    match std::fs::read(&path) {
        Ok(bytes) => Ok(visible(&String::from_utf8_lossy(&bytes), now)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

/// Writes a line of the log for the screen (A-28). An empty text is an error; nothing else is refused.
#[tauri::command]
pub async fn log_write(
    app: AppHandle,
    level: LogLevel,
    source: String,
    message: String,
) -> Result<(), String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || write(&dir, level, &source, &message))
        .await
        .map_err(|e| e.to_string())?
}

/// The log, the newest line first.
#[tauri::command]
pub async fn log_read(app: AppHandle) -> Result<Vec<LogEntry>, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || read(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, day, hour, 0, 0).unwrap()
    }

    fn entry(now: DateTime<Utc>, message: &str) -> LogEntry {
        make_entry(now, LogLevel::Info, "test", message).unwrap()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-app-log-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn text_is_one_line_of_single_spaces() {
        assert_eq!(clean_text("  a\r\nb\t\tc\u{0}d  ", 100), "a b c d");
    }

    #[test]
    fn text_is_cut_by_characters_with_a_mark() {
        assert_eq!(clean_text("あいうえお", 5), "あいうえお");
        assert_eq!(clean_text("あいうえおか", 5), "あいうえ…");
        assert_eq!(clean_text("あいうえおか", 0), "");
    }

    #[test]
    fn text_is_cut_after_the_secret_is_masked() {
        // A secret cut in half would not be recognised, so the mask goes first.
        let text = format!("{} xoxb-1234-abcd", "a".repeat(5));
        assert_eq!(clean_text(&text, 100), "aaaaa ***");
        assert_eq!(clean_text(&text, 8), "aaaaa *…");
    }

    #[test]
    fn tokens_of_known_services_are_masked() {
        for secret in [
            "xoxb-123-456-abc",
            "xapp-1-A0B-123-def",
            "ya29.a0AfB_byC-D",
            "sk-ant-api03-AbC_d",
            "ghp_abcDEF123",
            "AIzaSyA-bcd_123",
        ] {
            assert_eq!(
                redact(&format!("failed with {secret} today")),
                "failed with *** today"
            );
        }
    }

    #[test]
    fn a_secret_in_the_middle_of_a_word_is_masked_up_to_its_end() {
        assert_eq!(redact("(xoxb-1-2-abc)"), "(***)");
        assert_eq!(
            redact("url=https://x.test/?t=xoxb-1-2"),
            "url=https://x.test/?t=***"
        );
    }

    #[test]
    fn the_value_of_a_secret_name_is_masked() {
        assert_eq!(
            redact("access_token=abc123 refresh failed"),
            "access_token=*** refresh failed"
        );
        assert_eq!(redact("client_secret:abc"), "client_secret:***");
        assert_eq!(redact("PASSWORD=hunter2"), "PASSWORD=***");
        assert_eq!(
            redact(r#"{"access_token":"abc","expires_in":3600}"#),
            r#"{"access_token":***"#
        );
    }

    #[test]
    fn the_word_after_a_secret_name_is_masked_when_the_value_is_apart() {
        assert_eq!(redact("token: abc123 expired"), "token: *** expired");
        assert_eq!(redact("api_key= abc123"), "api_key= ***");
    }

    #[test]
    fn an_authorization_header_is_masked_with_its_scheme() {
        assert_eq!(
            redact("Authorization: Bearer abc.def end"),
            "Authorization: *** *** end"
        );
        assert_eq!(redact("sent Bearer abc.def end"), "sent Bearer *** end");
    }

    #[test]
    fn words_that_only_mention_a_secret_stay() {
        let text = "token refresh failed for a@example.com (401)";
        assert_eq!(redact(text), text);
        let ja = "トークンを更新できません";
        assert_eq!(redact(ja), ja);
    }

    #[test]
    fn an_entry_has_the_time_the_weight_and_cleaned_text() {
        let e = make_entry(
            at(14, 3) + chrono::Duration::milliseconds(678),
            LogLevel::Warn,
            "  gmail\n archive ",
            "failed\nwith token=abc",
        )
        .unwrap();
        assert_eq!(e.time, "2026-11-14T03:00:00.678Z");
        assert_eq!(e.level, LogLevel::Warn);
        assert_eq!(e.source, "gmail archive");
        assert_eq!(e.message, "failed with token=***");
    }

    #[test]
    fn an_entry_without_text_is_refused_and_a_blank_place_is_a_dash() {
        assert!(make_entry(at(14, 3), LogLevel::Info, "a", " \n ").is_err());
        assert_eq!(
            make_entry(at(14, 3), LogLevel::Info, " ", "x")
                .unwrap()
                .source,
            "-"
        );
    }

    #[test]
    fn the_place_and_the_text_are_cut() {
        let e = make_entry(
            at(14, 3),
            LogLevel::Error,
            &"s".repeat(SOURCE_MAX + 10),
            &"m".repeat(MESSAGE_MAX + 10),
        )
        .unwrap();
        assert_eq!(e.source.chars().count(), SOURCE_MAX);
        assert_eq!(e.message.chars().count(), MESSAGE_MAX);
    }

    #[test]
    fn a_line_is_json_with_one_break_and_reads_back() {
        let e = entry(at(14, 3), "say \"hi\" \\ あ");
        let line = render_line(&e);
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains(r#""level":"info""#));
        assert_eq!(parse_lines(&line), vec![e]);
    }

    #[test]
    fn bad_lines_are_left_out_of_a_read() {
        let good = entry(at(14, 3), "ok");
        let text = format!(
            "not json\n{}\n{}{}\n\n{}",
            r#"{"time":"yesterday","level":"info","source":"a","message":"b"}"#,
            render_line(&good),
            r#"{"time":"2026-11-14T03:00:00.000Z","level":"loud","source":"a","message":"b"}"#,
            // The last line has no break (a write cut short).
            render_line(&good).trim_end()
        );
        assert_eq!(parse_lines(&text), vec![good.clone(), good]);
    }

    #[test]
    fn old_lines_are_dropped_and_the_edge_stays() {
        let now = at(14, 0);
        let old = entry(
            now - chrono::Duration::days(MAX_AGE_DAYS) - chrono::Duration::seconds(1),
            "old",
        );
        let edge = entry(now - chrono::Duration::days(MAX_AGE_DAYS), "edge");
        let new = entry(now, "new");
        assert_eq!(
            compact(vec![old, edge.clone(), new.clone()], now, usize::MAX),
            vec![edge, new]
        );
    }

    #[test]
    fn the_newest_lines_that_fit_stay() {
        let now = at(14, 0);
        let lines: Vec<LogEntry> = (0..5).map(|i| entry(now, &format!("line {i}"))).collect();
        let one = render_line(&lines[0]).len();
        let kept = compact(lines.clone(), now, one * 3 + one / 2);
        assert_eq!(kept, lines[2..].to_vec());
        assert!(compact(lines.clone(), now, one - 1).is_empty());
        assert_eq!(compact(lines.clone(), now, one * 5), lines);
    }

    #[test]
    fn a_read_gives_the_newest_first_without_the_old() {
        let now = at(14, 0);
        let text = [
            entry(now - chrono::Duration::days(40), "old"),
            entry(at(10, 0), "a"),
            entry(at(12, 0), "b"),
        ]
        .iter()
        .map(render_line)
        .collect::<String>();
        let messages: Vec<String> = visible(&text, now).into_iter().map(|e| e.message).collect();
        assert_eq!(messages, ["b", "a"]);
    }

    #[test]
    fn writes_are_read_back_newest_first() {
        let dir = temp_dir("roundtrip");
        write_at(&dir, at(14, 1), LogLevel::Info, "a", "first").unwrap();
        write_at(&dir, at(14, 2), LogLevel::Error, "b", "second token=abc").unwrap();
        let entries = read_at(&dir, at(14, 3)).unwrap();
        let shown: Vec<(&str, &str)> = entries
            .iter()
            .map(|e| (e.source.as_str(), e.message.as_str()))
            .collect();
        assert_eq!(shown, [("b", "second token=***"), ("a", "first")]);
        assert_eq!(entries[0].level, LogLevel::Error);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_is_read_for_old_lines_on_the_first_write_and_then_every_hour() {
        assert!(prune_due(None));
        assert!(!prune_due(Some(PRUNE_EVERY - Duration::from_secs(1))));
        assert!(prune_due(Some(PRUNE_EVERY)));
    }

    #[test]
    fn a_missing_file_is_an_empty_log() {
        let dir = temp_dir("missing");
        assert!(read_at(&dir, at(14, 3)).unwrap().is_empty());
    }

    #[test]
    fn a_refused_entry_writes_nothing() {
        let dir = temp_dir("refused");
        assert!(write_at(&dir, at(14, 1), LogLevel::Info, "a", " ").is_err());
        assert!(!log_path(&dir).exists());
    }

    #[test]
    fn the_file_is_cut_when_it_passes_the_cap() {
        let dir = temp_dir("cap");
        let now = at(14, 1);
        let line = render_line(&entry(now, &"x".repeat(MESSAGE_MAX))).len();
        let count = MAX_BYTES / line + 20;
        for i in 0..count {
            let text = format!("{i:0>4} {}", "x".repeat(MESSAGE_MAX - 5));
            write_at(&dir, now, LogLevel::Info, "t", &text).unwrap();
        }
        let size = std::fs::metadata(log_path(&dir)).unwrap().len() as usize;
        assert!(size <= MAX_BYTES, "{size}");
        let entries = read_at(&dir, now).unwrap();
        assert!(entries.len() < count);
        assert!(entries[0]
            .message
            .starts_with(&format!("{:0>4}", count - 1)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
