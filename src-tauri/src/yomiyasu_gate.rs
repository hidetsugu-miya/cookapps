//! The yomiyasu gate of the decision pages (A-41): the Japanese a page shows must be part of the final text of a recorded yomiyasu run.
//!
//! A line of a text (split on `\n`, trimmed) that has hiragana, katakana or kanji is checked. With every whitespace character removed from both sides, it has to be a substring of the final text of at least one record, so one yomiyasu run may polish all the texts of a page. This module is the one place that knows yomiyasu's record format (`yomiyasu_check.py`, `RECORD_FORMAT_VERSION = 1`); the rules are the same as those of the gate of the agents' `decision-page-render`, and `requirements/constraints.md` (Orca) states them.
//!
//! The record is read, never written: `{state}/runs/{run id}/attempt-{n}.json` (`inputs.final.snapshot` names the final text) and `{state}/inputs/{sha256}.bin` (the final text, whole).

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::Deserialize;
use serde_json::Value;

const RECORD_FORMAT: &str = "yomiyasu-check-record";
const RECORD_VERSION: u64 = 1;
/// A run folder, and a final text that no record names, are deleted after this long.
const RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// The state folder when `YOMIYASU_STATE_DIR` says none, under the home folder.
const DEFAULT_STATE: &str = ".local/state/mysis-agents/yomiyasu";

/// The keys of a value that locate something (a root, a path), and the user's own reply pasted back: not text written for the user.
const LOCATION_KEYS: [&str; 6] = ["roots", "root", "ref", "path", "source", "previous_reply"];
/// Card identifiers: the page must not change them, and the reply matches on them, so they cannot be polished.
const IDENTIFIER_KEYS: [&str; 3] = ["number", "clarified_numbers", "cards"];
/// The facts whose value the contract fixes or copies verbatim from a finding. The label of every fact is fixed.
const FIXED_FACTS: [&str; 7] = [
    "検出元",
    "箇所",
    "分類",
    "影響範囲",
    "重要度",
    "投稿先",
    "ラベル",
];
/// The lines a diff evidence item quotes from the sources.
const QUOTE_KEYS: [&str; 4] = ["before", "after", "before_source", "after_source"];

/// Where the records are, what time it is for the retention, and whether the gate applies at all.
pub struct Gate {
    state: PathBuf,
    now: SystemTime,
    /// A Codex run (`CODEX_THREAD_ID` or `CODEX_SESSION_ID` is set): Codex works only in exchanges between AIs, so nothing is checked.
    pass: bool,
}

impl Gate {
    /// The gate of this process: the state folder of `YOMIYASU_STATE_DIR` (or the shared default) and the clock.
    pub fn here() -> Self {
        Self::from_env(
            |key| std::env::var(key).ok(),
            dirs::home_dir(),
            SystemTime::now(),
        )
    }

    fn from_env(
        get: impl Fn(&str) -> Option<String>,
        home: Option<PathBuf>,
        now: SystemTime,
    ) -> Self {
        let set = |key| get(key).is_some_and(|v| !v.is_empty());
        Self {
            state: state_dir(
                get("YOMIYASU_STATE_DIR").as_deref(),
                &home.unwrap_or_default(),
            ),
            now,
            pass: set("CODEX_THREAD_ID") || set("CODEX_SESSION_ID"),
        }
    }

    /// A gate on the records in `state`, at the time `now`.
    #[cfg(test)]
    pub fn new(state: PathBuf, now: SystemTime) -> Self {
        Self {
            state,
            now,
            pass: false,
        }
    }

    /// A gate that passes every text, as in a Codex run.
    #[cfg(test)]
    pub fn off() -> Self {
        Self {
            state: PathBuf::new(),
            now: SystemTime::now(),
            pass: true,
        }
    }

    /// The Japanese lines of `texts` that no recorded final text contains, in order and without repeats.
    pub fn unpolished(&self, texts: &[String]) -> Vec<String> {
        if self.pass {
            return Vec::new();
        }
        let mut lines: Vec<&str> = Vec::new();
        let mut seen = HashSet::new();
        for line in texts.iter().flat_map(|text| text.split('\n')) {
            let line = line.trim();
            if has_japanese(line) && seen.insert(line) {
                lines.push(line);
            }
        }
        if lines.is_empty() {
            return Vec::new();
        }
        let finals = load_finals(&self.state, self.now);
        lines
            .into_iter()
            .filter(|line| {
                let key = squash(line);
                !finals.iter().any(|f| f.contains(&key))
            })
            .map(str::to_owned)
            .collect()
    }
}

/// Hiragana, katakana, kanji, and the prolonged sound mark (which Unicode files under no script).
fn is_japanese(c: char) -> bool {
    matches!(c,
        'ー'
        | '\u{3041}'..='\u{3096}' | '\u{309D}'..='\u{309F}'
        | '\u{30A1}'..='\u{30FA}' | '\u{30FD}'..='\u{30FF}' | '\u{31F0}'..='\u{31FF}'
        | '\u{32D0}'..='\u{32FE}' | '\u{3300}'..='\u{3357}' | '\u{FF66}'..='\u{FF6F}' | '\u{FF71}'..='\u{FF9D}'
        | '\u{2E80}'..='\u{2FD5}' | '\u{3005}' | '\u{3007}' | '\u{3021}'..='\u{3029}' | '\u{3038}'..='\u{303B}'
        | '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}' | '\u{F900}'..='\u{FAD9}'
        | '\u{20000}'..='\u{323AF}')
}

fn has_japanese(s: &str) -> bool {
    s.chars().any(is_japanese)
}

/// `s` without any whitespace, so a wrapped line still matches.
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The state folder: `env` (`YOMIYASU_STATE_DIR`) when it is not blank and holds no unexpanded `${` (a leading `~` or `~/` is the home folder), else the shared default under `home`. A relative value stays relative to the working directory, as `yomiyasu_check.py` has it.
fn state_dir(env: Option<&str>, home: &Path) -> PathBuf {
    let Some(env) = env.filter(|e| !e.trim().is_empty() && !e.contains("${")) else {
        return home.join(DEFAULT_STATE);
    };
    if env == "~" {
        return home.to_path_buf();
    }
    match env.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(env),
    }
}

fn older_than_retention(now: SystemTime, time: SystemTime) -> bool {
    now.duration_since(time).is_ok_and(|d| d > RETENTION)
}

/// `inputs/{64 hex}.bin`, the only place a record may name a snapshot in.
fn is_snapshot_ref(s: &str) -> bool {
    s.strip_prefix("inputs/")
        .and_then(|rest| rest.strip_suffix(".bin"))
        .is_some_and(|hex| {
            hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
}

/// `attempt-{n}.json`.
fn is_attempt_file(name: &str) -> bool {
    name.strip_prefix("attempt-")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Deserialize, Default)]
struct Snap {
    #[serde(default)]
    snapshot: String,
}

#[derive(Deserialize, Default)]
struct Inputs {
    source: Option<Snap>,
    #[serde(default)]
    materials: Vec<Snap>,
    #[serde(default)]
    r#final: Snap,
}

#[derive(Deserialize, Default)]
struct RecordResult {
    #[serde(default)]
    status: String,
}

#[derive(Deserialize)]
struct Record {
    #[serde(default)]
    format: String,
    format_version: Option<u64>,
    #[serde(default)]
    inputs: Inputs,
    #[serde(default)]
    result: RecordResult,
}

/// What one `attempt-{n}.json` gives: `final_ref` is the final text of an executed record this module accepts (a `partial` run did not finish its checks), `named` every snapshot the record names whatever its status. `None` when the file cannot be read or parsed (an empty file may be one being written, so its snapshots are not judged unreferenced).
fn read_record(path: &Path) -> Option<(Option<String>, Vec<String>)> {
    let record: Record = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let named: Vec<String> = std::iter::once(&record.inputs.r#final)
        .chain(&record.inputs.materials)
        .chain(record.inputs.source.as_ref())
        .map(|snap| snap.snapshot.clone())
        .filter(|s| is_snapshot_ref(s))
        .collect();
    let accepted = record.format == RECORD_FORMAT
        && record.format_version == Some(RECORD_VERSION)
        && record.result.status == "executed"
        && is_snapshot_ref(&record.inputs.r#final.snapshot);
    let final_ref = accepted.then_some(record.inputs.r#final.snapshot);
    Some((final_ref, named))
}

/// Prunes the stale run folders and returns the whitespace-squashed final text of every executed record. It then prunes the snapshots that no remaining record names.
fn load_finals(state: &Path, now: SystemTime) -> Vec<String> {
    let runs = state.join("runs");
    let entries = fs::read_dir(&runs);
    // An unreadable runs folder hides records, so nothing is then judged unreferenced.
    let mut complete = match &entries {
        Ok(_) => true,
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    };
    let mut finals = Vec::new();
    let mut loaded = HashSet::new();
    let mut referenced = HashSet::new();
    for entry in entries.into_iter().flatten() {
        let Ok(entry) = entry else {
            complete = false;
            continue;
        };
        let dir = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        if meta.modified().is_ok_and(|m| older_than_retention(now, m)) {
            // A failed prune is retried by the next read; the folder that stays may still name snapshots, so none is pruned now.
            complete = complete && fs::remove_dir_all(&dir).is_ok();
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else {
            complete = false;
            continue;
        };
        for file in files.flatten() {
            if !file.file_name().to_str().is_some_and(is_attempt_file) {
                continue;
            }
            let Some((final_ref, named)) = read_record(&file.path()) else {
                complete = false;
                continue;
            };
            referenced.extend(named);
            let Some(final_ref) = final_ref else { continue };
            if !loaded.insert(final_ref.clone()) {
                continue;
            }
            if let Ok(body) = fs::read(state.join(&final_ref)) {
                finals.push(squash(&String::from_utf8_lossy(&body)));
            }
        }
    }
    if complete {
        prune_inputs(state, now, &referenced);
    }
    finals
}

/// Deletes the snapshots under `{state}/inputs` that no remaining record names and that are older than the retention, so the whole source and final text of every run do not grow without limit. The age spares a snapshot a running yomiyasu has just placed and not yet recorded. `{state}/index` is left alone: its entries are empty files, and `yomiyasu_check.py` skips one whose run is gone.
fn prune_inputs(state: &Path, now: SystemTime, referenced: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(state.join("inputs")) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if meta.is_file()
            && !referenced.contains(&format!("inputs/{name}"))
            && meta.modified().is_ok_and(|m| older_than_retention(now, m))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The Japanese labels of a Mermaid source, one per line: the source is cut at every run of ASCII punctuation (brackets, quotes, arrows, `|`, `:`), and each piece is trimmed to its first and last Japanese character. Cutting too much only loosens the match, because every piece of a label is part of the label.
fn mermaid_labels(src: &str) -> String {
    src.split(|c: char| c.is_ascii_punctuation())
        .filter_map(|piece| {
            let first = piece.find(is_japanese)?;
            let (last, c) = piece.char_indices().rfind(|&(_, c)| is_japanese(c))?;
            Some(&piece[first..last + c.len_utf8()])
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The strings of the input JSON of a page that are text written for the user, in key order. What quotes or locates something is left out: the locations, the card identifiers, a `literal` block, the quoted lines of a `diff`, the `sample` of an option, a fixed fact, and an option copied from the findings tool of a `review-decision` card.
pub fn page_texts(value: &Value) -> Vec<String> {
    let mut texts = Vec::new();
    collect(value, false, &mut texts);
    texts
}

fn collect(value: &Value, review_decision: bool, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|v| collect(v, review_decision, out)),
        Value::Object(map) => {
            let text_of = |key: &str| map.get(key).and_then(Value::as_str).unwrap_or("");
            let has = |key: &str| map.get(key).is_some_and(|v| !v.is_null());
            let (kind, label) = (text_of("type"), text_of("label"));
            let review_decision = review_decision || text_of("kind") == "review-decision";
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for key in keys {
                let k = key.as_str();
                let quoted = LOCATION_KEYS.contains(&k)
                    || IDENTIFIER_KEYS.contains(&k)
                    || (kind == "literal" && k == "text")
                    || (kind == "diff" && QUOTE_KEYS.contains(&k))
                    // The text of an option's sample is what the screen shows, copied as it is.
                    || k == "sample"
                    // A fact's label.
                    || (k == "label" && has("value"))
                    || (k == "value" && FIXED_FACTS.contains(&label))
                    // An option copied from the findings tool.
                    || (review_decision && (k == "label" || k == "fix") && has("key"));
                if quoted {
                    continue;
                }
                if k == "mermaid" {
                    if let Some(source) = map[k].as_str() {
                        out.push(mermaid_labels(source));
                    }
                    continue;
                }
                collect(&map[k], review_decision, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-gate-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hex(n: u32) -> String {
        format!("{n:064x}")
    }

    /// A record `runs/{run}/attempt-1.json` with the given format, version and status, whose final text is `body` (`None`: the snapshot is not written).
    fn record(
        state: &Path,
        run: &str,
        n: u32,
        format: &str,
        version: u64,
        status: &str,
        body: Option<&str>,
    ) {
        let name = hex(n);
        let dir = state.join("runs").join(run);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("attempt-1.json"),
            json!({
                "format": format,
                "format_version": version,
                "inputs": {
                    "source": {"snapshot": format!("inputs/{}.bin", hex(n + 1000))},
                    "materials": [],
                    "final": {"snapshot": format!("inputs/{name}.bin")}
                },
                "result": {"status": status}
            })
            .to_string(),
        )
        .unwrap();
        if let Some(body) = body {
            fs::create_dir_all(state.join("inputs")).unwrap();
            fs::write(state.join("inputs").join(format!("{name}.bin")), body).unwrap();
        }
    }

    fn executed(state: &Path, run: &str, n: u32, body: &str) {
        record(state, run, n, RECORD_FORMAT, 1, "executed", Some(body));
    }

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    fn gate(state: &Path) -> Gate {
        Gate::new(state.to_path_buf(), SystemTime::now())
    }

    #[test]
    fn a_polished_line_passes_and_one_not_in_the_record_is_refused() {
        let state = temp_dir("polished");
        executed(&state, "r1", 1, "どちらにしますか\n案 A を選びます。\n");
        let texts = lines(&["どちらにしますか", "案 A を選びます。\n案 C を選びます。"]);
        assert_eq!(
            gate(&state).unpolished(&texts),
            lines(&["案 C を選びます。"])
        );
    }

    #[test]
    fn one_run_may_polish_every_text_and_a_wrapped_line_still_matches() {
        let state = temp_dir("wrapped");
        executed(&state, "r1", 1, "最初の文で、\n折り返した行です。\n");
        executed(&state, "r2", 2, "別の実行の文です。");
        let texts = lines(&["最初の文で、折り返した行です。", "別の実行の 文です。"]);
        assert!(gate(&state).unpolished(&texts).is_empty());
    }

    #[test]
    fn lines_without_japanese_are_not_checked_and_repeats_come_back_once() {
        let state = temp_dir("ascii");
        let texts = lines(&["plain ascii", "未推敲", "  未推敲  ", "未推敲\nother"]);
        assert_eq!(gate(&state).unpolished(&texts), lines(&["未推敲"]));
    }

    #[test]
    fn without_a_record_every_japanese_line_is_unpolished() {
        let state = temp_dir("none").join("missing");
        let texts = lines(&["一行目\n二行目\nline"]);
        assert_eq!(
            gate(&state).unpolished(&texts),
            lines(&["一行目", "二行目"])
        );
    }

    #[test]
    fn a_record_that_is_not_an_executed_one_of_this_format_is_not_counted() {
        let state = temp_dir("kinds");
        record(
            &state,
            "partial",
            1,
            RECORD_FORMAT,
            1,
            "partial",
            Some("部分の実行"),
        );
        record(
            &state,
            "version",
            2,
            RECORD_FORMAT,
            2,
            "executed",
            Some("別の版"),
        );
        record(
            &state,
            "format",
            3,
            "other",
            1,
            "executed",
            Some("別の形式"),
        );
        let bad = state.join("runs/bad");
        fs::create_dir_all(&bad).unwrap();
        fs::write(
            bad.join("attempt-1.json"),
            json!({
                "format": RECORD_FORMAT, "format_version": 1, "result": {"status": "executed"},
                "inputs": {"final": {"snapshot": "../outside.bin"}}
            })
            .to_string(),
        )
        .unwrap();
        fs::write(state.join("outside.bin"), "外の写し").unwrap();
        fs::write(bad.join("notes.json"), "外の記録").unwrap();
        let texts = lines(&["部分の実行", "別の版", "別の形式", "外の写し", "外の記録"]);
        assert_eq!(gate(&state).unpolished(&texts), texts);
    }

    #[test]
    fn an_old_record_is_not_counted_and_its_folder_and_unnamed_texts_are_pruned() {
        let state = temp_dir("old");
        executed(&state, "old", 1, "古い実行の文です。");
        executed(&state, "new", 2, "新しい実行の文です。");
        fs::create_dir_all(state.join("inputs")).unwrap();
        let orphan = state.join("inputs").join(format!("{}.bin", hex(9)));
        fs::write(&orphan, "名前のない写し").unwrap();
        // Every folder is 15 days old by this clock; the one record that stays is read at the same time, so it is old too.
        let later = SystemTime::now() + Duration::from_secs(15 * 24 * 60 * 60);
        let texts = lines(&["古い実行の文です。", "新しい実行の文です。"]);
        assert_eq!(Gate::new(state.clone(), later).unpolished(&texts), texts);
        assert!(!state.join("runs/old").exists());
        assert!(!orphan.exists(), "an old text that no record names goes");
        // Now the clock is today: a record made now counts, and a snapshot a record names stays.
        executed(&state, "fresh", 3, "今日の実行の文です。");
        fs::write(&orphan, "名前のない写し").unwrap();
        assert!(gate(&state)
            .unpolished(&lines(&["今日の実行の文です。"]))
            .is_empty());
        assert!(
            orphan.exists(),
            "a new text is spared, a running yomiyasu may not have recorded it yet"
        );
        assert!(state
            .join("inputs")
            .join(format!("{}.bin", hex(3)))
            .exists());
    }

    #[test]
    fn nothing_is_pruned_when_a_record_cannot_be_read() {
        let state = temp_dir("unread");
        let run = state.join("runs/writing");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("attempt-1.json"), "").unwrap();
        fs::create_dir_all(state.join("inputs")).unwrap();
        let text = state.join("inputs").join(format!("{}.bin", hex(5)));
        fs::write(&text, "書きかけ").unwrap();
        let old = SystemTime::now() - Duration::from_secs(15 * 24 * 60 * 60);
        fs::File::options()
            .write(true)
            .open(&text)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let _ = gate(&state).unpolished(&lines(&["日本語"]));
        assert!(text.exists(), "an empty record may be one being written");
        fs::remove_file(run.join("attempt-1.json")).unwrap();
        let _ = gate(&state).unpolished(&lines(&["日本語"]));
        assert!(
            !text.exists(),
            "with every record read, the old unnamed text goes"
        );
    }

    #[test]
    fn a_codex_run_passes_every_text() {
        let state = temp_dir("codex");
        let env = |name: &'static str| move |key: &str| (key == name).then(|| "id".to_owned());
        for name in ["CODEX_THREAD_ID", "CODEX_SESSION_ID"] {
            let g = Gate::from_env(env(name), Some(state.clone()), SystemTime::now());
            assert!(g.unpolished(&lines(&["未推敲"])).is_empty(), "{name}");
        }
        let g = Gate::from_env(|_| None, Some(state), SystemTime::now());
        assert_eq!(g.unpolished(&lines(&["未推敲"])), lines(&["未推敲"]));
        let blank = Gate::from_env(
            |key| (key == "CODEX_THREAD_ID").then(String::new),
            None,
            SystemTime::now(),
        );
        assert!(!blank.pass);
    }

    #[test]
    fn the_state_folder_follows_the_environment_variable_or_the_shared_default() {
        let home = Path::new("/home/me");
        let default = home.join(".local/state/mysis-agents/yomiyasu");
        assert_eq!(state_dir(None, home), default);
        assert_eq!(state_dir(Some("  "), home), default);
        assert_eq!(state_dir(Some("${CLAUDE_PROJECT_DIR}/s"), home), default);
        assert_eq!(
            state_dir(Some("/var/state"), home),
            PathBuf::from("/var/state")
        );
        assert_eq!(
            state_dir(Some("rel/state"), home),
            PathBuf::from("rel/state")
        );
        assert_eq!(state_dir(Some("~"), home), home);
        assert_eq!(state_dir(Some("~/s/y"), home), home.join("s/y"));
        assert_eq!(state_dir(Some("~other"), home), PathBuf::from("~other"));
    }

    #[test]
    fn what_counts_as_japanese() {
        for text in ["あ", "ア", "漢", "ー", "ｱ"] {
            assert!(has_japanese(text), "{text}");
        }
        for text in ["abc 123 -", "・", "。", "、", "Ａ"] {
            assert!(!has_japanese(text), "{text}");
        }
    }

    #[test]
    fn a_mermaid_source_gives_its_japanese_labels() {
        let src =
            "flowchart TD\n A[開始 する] --> B{判断?}\n B -->|はい| C(\"終わり\")\n C --- D[ok]";
        assert_eq!(mermaid_labels(src), "開始 する\n判断\nはい\n終わり");
        assert_eq!(mermaid_labels("graph LR; a-->b"), "");
    }

    #[test]
    fn page_texts_leave_out_what_is_not_written_for_the_user() {
        let page = json!({
            "title": "題名", "roots": {"d": "/ルート"}, "previous_reply": "貼った返信",
            "q": [{
                "kind": "review-decision", "title": "論点",
                "facts": [
                    {"label": "検出元", "value": "出所"},
                    {"label": "指摘内容", "value": "指摘"},
                    {"label": "重要度", "value": "高"}
                ],
                "options": [{"key": "A", "label": "選択肢", "fix": "修正", "detail": "詳細"}],
                "blocks": [
                    {"type": "literal", "text": "原文"},
                    {"type": "paragraph", "text": "段落"},
                    {"type": "diagram", "mermaid": "flowchart TD\n A[図の語] --> B"}
                ],
                "evidence": [
                    {"type": "diff", "summary": "要約", "name": "名前", "before": ["前"], "after": ["後"],
                     "before_source": "元", "after_source": "先"},
                    {"type": "excerpt", "root": "d", "path": "パス", "note": "注"}
                ]
            }],
            "other": {"kind": "question", "options": [{"key": "B", "label": "通常の選択肢"}]}
        });
        let got: Vec<String> = page_texts(&page)
            .into_iter()
            .filter(|t| has_japanese(t))
            .collect();
        let mut want = lines(&[
            "論点",
            "指摘",
            "詳細",
            "要約",
            "名前",
            "注",
            "段落",
            "図の語",
            "通常の選択肢",
            "題名",
        ]);
        let mut sorted = got.clone();
        sorted.sort();
        want.sort();
        assert_eq!(sorted, want);
    }

    #[test]
    fn a_sample_text_is_what_the_screen_shows_and_is_not_checked() {
        let page = json!({
            "q": [{
                "kind": "question", "title": "論点",
                "options": [{
                    "key": "A", "label": "選択肢",
                    "sample": {"text": "画面に出る文字", "font_size": 14, "font_weight": 700, "color": "#2f5bd3"}
                }]
            }]
        });
        let got = page_texts(&page).join(" ");
        assert!(!got.contains("画面に出る文字"), "a sample is quoted: {got}");
        assert!(got.contains("選択肢"), "the label stays checked: {got}");
    }

    #[test]
    fn page_texts_leave_out_the_card_identifiers_and_keep_the_titles() {
        let page = json!({
            "context_label": "文脈", "clarified_numbers": ["論点1"], "cards": ["CR-3"],
            "q": [{"kind": "question", "number": "論点4", "title": "題"}],
            "u": {"kind": "unmet-criterion", "number": "未達2", "cards": ["CR-4", "カード5"], "title": "条件"}
        });
        let got = page_texts(&page).join(" ");
        for id in ["論点1", "CR-3", "論点4", "未達2", "CR-4", "カード5"] {
            assert!(!got.contains(id), "{id} is an identifier: {got}");
        }
        for text in ["文脈", "題", "条件"] {
            assert!(got.contains(text), "{text} stays checked: {got}");
        }
        assert!(page_texts(&json!({"mermaid": 3, "n": 1})).is_empty());
    }
}
