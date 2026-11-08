//! A-18: the files of a worktree on the Orca screen: the list of its folders, and the text of a file read and saved by the editor.
//! The calls are Orca's runtime (`files.readDir`, `files.read`, `files.writeIfUnchanged`, `git.checkIgnored`), on this machine over its unix socket and on a paired server over its WebSocket (the connection of A-10).
//! They are not a public interface of Orca: this was read in the `app.asar` of Orca 1.4.253 and tried on this machine's Orca. A token is in no log line, no error text and no return value, and the text of a file is in no log line.
//!
//! A file is saved with `files.writeIfUnchanged`: Orca writes only when the disk still holds the text that was read, by a signature of it (`disk_signature`, the one of Orca's `disk-baseline-signature.js`), and answers `diskConflict` when it does not, so a file changed elsewhere is never overwritten.
//! The text goes through a textarea, which turns CRLF into LF and cannot hold a lone CR, so only a file with no CR or with a CRLF at every line end is opened (`line_ending`), and a CRLF file is written back with CRLF.
//! The time of the automatic save is saved in `editor-settings.json` in the app config directory.

use std::{cmp::Ordering, collections::HashSet, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts::write_synced,
    auth::config_dir,
    orca::worktree_host,
    orca_attach::{worktree_params, Rpc},
    orca_chat::{CallError, Connection},
};

const SETTINGS_FILE: &str = "editor-settings.json";
const SETTINGS_TMP_FILE: &str = "editor-settings.json.tmp";
/// The time of the automatic save: the range, the step and the first value, in milliseconds.
const AUTOSAVE_MIN: i64 = 100;
const AUTOSAVE_MAX: i64 = 3000;
const AUTOSAVE_STEP: i64 = 100;
const AUTOSAVE_DEFAULT: u32 = 1000;
/// The most entries one `files.readDir` answers (Orca's page limit).
const LIST_LIMIT: usize = 5000;
/// The most paths one `git.checkIgnored` takes.
const IGNORE_CHUNK: usize = 2000;
/// The most bytes of a file the editor opens or saves. Orca reads 512 KiB at most, and a larger frame closes the WebSocket of a paired server (it takes 1 MiB), so a text is kept well under both.
const MAX_TEXT: usize = 384 * 1024;
/// The longest relative path, in bytes (the limit of a path on the file systems Orca runs on).
const MAX_PATH: usize = 4096;
const NOT_LISTED: &str = "ファイルの一覧を読めません";

// ---- what the screen gets ----

/// An entry of a folder. `path` is relative to the worktree, and `ignored` is whether git ignores it (Orca draws such an entry faint and in italics).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaFileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub ignored: bool,
}

/// A folder: its entries, the folders first and each group in natural order of the names, and how many it holds (more than the entries when Orca's page was full).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaDir {
    pub entries: Vec<OrcaFileEntry>,
    pub total: u32,
}

/// The text of a file for the editor, with LF line ends (`crlf` says the file has CRLF, which the write brings back), and the signature of the text as the disk holds it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaFileText {
    pub content: String,
    pub crlf: bool,
    pub signature: String,
}

/// What Orca did with a save: wrote it, or refused because the disk no longer holds the text that was read (`changed`: another text, `missing`: no file, `not-utf8`: bytes that are not text).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "kebab-case")]
pub enum OrcaSaveState {
    Saved,
    Changed,
    Missing,
    NotUtf8,
}

/// The answer to a save, with the signature of the text the disk holds now when it was written (else the one that was sent).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaSaved {
    pub state: OrcaSaveState,
    pub signature: String,
}

/// The settings of the editor (the card of the settings screen).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    /// How long after the typing stops the file is saved, in milliseconds.
    pub autosave_ms: u32,
}

// ---- paths ----

/// A path relative to the worktree that Orca may be asked for: no blank (`allow_empty` lets the worktree's own folder through), no control character, nothing absolute, no `.` or `..` element and no empty one.
fn check_relative(relative: &str, allow_empty: bool) -> Result<(), String> {
    if relative.is_empty() {
        return if allow_empty {
            Ok(())
        } else {
            Err("ファイルの場所が正しくありません".into())
        };
    }
    let bad = relative.len() > MAX_PATH
        || relative.chars().any(char::is_control)
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..");
    if bad {
        Err("ファイルの場所が正しくありません".into())
    } else {
        Ok(())
    }
}

/// The path of the entry `name` in the folder `dir` (both relative to the worktree; the worktree's own folder is the empty one).
fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

// ---- the list ----

/// The order of Orca's file list: a number inside a name counts by its value (`2` before `10`), other characters by their lower case, and a tie by the plain order of the names.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let number = |chars: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(c) = chars.next_if(char::is_ascii_digit) {
                        digits.push(c);
                    }
                    digits
                };
                let (n, m) = (number(&mut x), number(&mut y));
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let order = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(c), Some(d)) => {
                let order = c.to_lowercase().cmp(d.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// The folders first, then the files, each group in natural order.
fn sort_entries(entries: &mut [OrcaFileEntry]) {
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
}

/// The entries of an answer of `files.readDir` (the bare array of an old Orca, or a page `{entries, total, hasMore}`) in `dir`, and how many the folder holds. An entry with no usable name is left out.
fn parse_dir(result: &Value, dir: &str) -> Result<(Vec<OrcaFileEntry>, u32), String> {
    let list = result
        .as_array()
        .or_else(|| result["entries"].as_array())
        .ok_or(NOT_LISTED)?;
    let entries: Vec<OrcaFileEntry> = list
        .iter()
        .filter_map(|e| {
            let name = e["name"]
                .as_str()
                .filter(|n| !n.is_empty() && !n.contains(['/', '\0']) && *n != "." && *n != "..")?;
            Some(OrcaFileEntry {
                name: name.to_owned(),
                path: join(dir, name),
                is_directory: e["isDirectory"].as_bool().unwrap_or(false),
                ignored: false,
            })
        })
        .collect();
    let total = result["total"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or_else(|| u32::try_from(list.len()).unwrap_or(u32::MAX));
    let total = total.max(u32::try_from(entries.len()).unwrap_or(u32::MAX));
    Ok((entries, total))
}

/// Marks the entries whose path `git.checkIgnored` answered (an array of the paths it ignores).
fn mark_ignored(entries: &mut [OrcaFileEntry], ignored: &HashSet<String>) {
    for entry in entries {
        entry.ignored = ignored.contains(&entry.path);
    }
}

/// The paths of `entries` that git ignores. A failed check (a folder that is no repository) marks nothing: the list is still the list.
async fn ignored_of(rpc: &mut impl Rpc, path: &str, entries: &[OrcaFileEntry]) -> HashSet<String> {
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    let mut ignored = HashSet::new();
    for chunk in paths.chunks(IGNORE_CHUNK) {
        let Ok(answer) = rpc
            .call(
                "git.checkIgnored",
                worktree_params(path, None, json!({"paths": chunk})),
            )
            .await
        else {
            continue;
        };
        ignored.extend(
            answer
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|p| p.trim_end_matches('/').to_owned()),
        );
    }
    ignored
}

/// The message of a failed read of the files.
fn reason(error: CallError) -> String {
    if error.detail.starts_with("ENOENT") {
        "ファイルが見つかりません".into()
    } else if error.detail == "binary_file" {
        "バイナリのファイルは開けません".into()
    } else if error.detail == "invalid_relative_path" {
        "ファイルの場所が正しくありません".into()
    } else {
        error.shown
    }
}

/// `ignored` is whether git ignores the folder `dir` itself: what it holds is then ignored too, and `git.checkIgnored` is not asked.
async fn list(rpc: &mut impl Rpc, path: &str, dir: &str, ignored: bool) -> Result<OrcaDir, String> {
    let answer = rpc
        .call(
            "files.readDir",
            worktree_params(
                path,
                None,
                json!({"relativePath": dir, "limit": LIST_LIMIT}),
            ),
        )
        .await
        .map_err(reason)?;
    let (mut entries, total) = parse_dir(&answer, dir)?;
    sort_entries(&mut entries);
    if ignored {
        entries.iter_mut().for_each(|e| e.ignored = true);
    } else {
        let ignored = ignored_of(rpc, path, &entries).await;
        mark_ignored(&mut entries, &ignored);
    }
    Ok(OrcaDir { entries, total })
}

// ---- the text ----

/// Orca's signature of a text (`getDiskBaselineSignature`): two FNV lanes over the UTF-16 code units, and their count, each in lower case hex. Orca compares it with the text on the disk before it writes.
fn disk_signature(text: &str) -> String {
    let (mut a, mut b, mut length) = (2_166_136_261_u32, 84_696_351_u32, 0_usize);
    for unit in text.encode_utf16() {
        a = (a ^ u32::from(unit)).wrapping_mul(16_777_619);
        b = (b ^ u32::from(unit)).wrapping_mul(1_099_511_627);
        length += 1;
    }
    format!("{a:x}-{b:x}-{length:x}")
}

/// Whether a text has CRLF at every line end (`true`) or no CR at all (`false`); a CR anywhere else (a lone one, or in a file whose line ends differ) is refused, because the editor would change it.
fn line_ending(text: &str) -> Result<bool, String> {
    let (cr, lf, crlf) = (
        text.matches('\r').count(),
        text.matches('\n').count(),
        text.matches("\r\n").count(),
    );
    if cr == 0 {
        Ok(false)
    } else if cr == crlf && lf == crlf {
        Ok(true)
    } else {
        Err("改行コードが混ざっているファイルは開けません".into())
    }
}

/// The text the editor gets from an answer of `files.read`: Orca's reply must be the whole file, as text, in the size the editor takes.
fn parse_text(result: &Value) -> Result<OrcaFileText, String> {
    let too_large = || format!("{} KiB を超えるファイルは開けません", MAX_TEXT / 1024);
    let too_big = result["byteLength"]
        .as_u64()
        .is_some_and(|n| n > MAX_TEXT as u64);
    if result["truncated"].as_bool() == Some(true) || too_big {
        return Err(too_large());
    }
    let content = result["content"].as_str().ok_or("ファイルを読めません")?;
    if content.len() > MAX_TEXT {
        return Err(too_large());
    }
    // Orca decodes bytes that are not UTF-8 into U+FFFD, and a save would write that over them.
    if content.contains('\u{FFFD}') {
        return Err("UTF-8 ではないファイルは開けません".into());
    }
    let crlf = line_ending(content)?;
    Ok(OrcaFileText {
        content: if crlf {
            content.replace("\r\n", "\n")
        } else {
            content.to_owned()
        },
        crlf,
        signature: disk_signature(content),
    })
}

async fn read(rpc: &mut impl Rpc, path: &str, relative: &str) -> Result<OrcaFileText, String> {
    let answer = rpc
        .call(
            "files.read",
            worktree_params(path, None, json!({"relativePath": relative})),
        )
        .await
        .map_err(reason)?;
    parse_text(&answer)
}

/// What Orca answered to `files.writeIfUnchanged`: `{ok: false, diskConflict}` is a refusal, anything else (`{ok: true}`, `{ok: true, unchanged: true}` for the same text, or an old host's empty answer) a write.
fn save_state(result: &Value) -> OrcaSaveState {
    if result["ok"] != false {
        return OrcaSaveState::Saved;
    }
    match result["diskConflict"].as_str() {
        Some("missing") => OrcaSaveState::Missing,
        Some("not-utf8") => OrcaSaveState::NotUtf8,
        _ => OrcaSaveState::Changed,
    }
}

/// The text as it goes to the disk: with the file's own line ends.
fn disk_text(content: &str, crlf: bool) -> String {
    if crlf {
        content.replace('\n', "\r\n")
    } else {
        content.to_owned()
    }
}

/// Saves `content` over the text whose signature is `signature`. A host that lacks `files.writeIfUnchanged` answers `method_not_found`, and nothing is written then.
async fn write(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    relative: &str,
    content: &str,
    crlf: bool,
    signature: &str,
) -> Result<OrcaSaved, String> {
    let text = disk_text(content, crlf);
    if text.len() > MAX_TEXT {
        return Err(format!(
            "{} KiB を超えるファイルは保存できません",
            MAX_TEXT / 1024
        ));
    }
    let answer = rpc
        .call(
            "files.writeIfUnchanged",
            worktree_params(
                path,
                Some(host_id),
                json!({
                    "relativePath": relative,
                    "content": text,
                    "diskPrecondition": {"expectedSignature": signature, "requireLosslessUtf8": true},
                }),
            ),
        )
        .await
        .map_err(|e| {
            if e.shown.contains("method_not_found") {
                "この Orca は、変更を確かめてからの保存に対応していません".to_owned()
            } else {
                reason(e)
            }
        })?;
    let state = save_state(&answer);
    Ok(OrcaSaved {
        state,
        signature: if state == OrcaSaveState::Saved {
            disk_signature(&text)
        } else {
            signature.to_owned()
        },
    })
}

// ---- the commands ----

/// An SSH host has no file calls (its `hostId` is `ssh:{id}`), as A-10 found.
fn check_host(host_id: &str) -> Result<(), String> {
    if host_id.starts_with("ssh:") {
        Err("SSH の接続先の worktree のファイルは開けません".into())
    } else {
        Ok(())
    }
}

/// The `hostId` of the worktree at `path` (one of the target's list read just now), which a file call is made on.
async fn host_of(path: &str, environment: Option<&str>) -> Result<String, String> {
    let (path, environment) = (path.to_owned(), environment.map(str::to_owned));
    let host_id = tokio::task::spawn_blocking(move || worktree_host(&path, environment.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    check_host(&host_id)?;
    Ok(host_id)
}

/// The entries of the folder `dir` of the worktree at `path` (A-18). The worktree's own folder is the empty `dir`. `ignored` is whether the list marked `dir` as ignored.
#[tauri::command]
pub async fn orca_files_list(
    path: String,
    dir: String,
    ignored: bool,
    environment: Option<String>,
) -> Result<OrcaDir, String> {
    check_relative(&dir, true)?;
    host_of(&path, environment.as_deref()).await?;
    let mut connection = Connection::open(environment).await?;
    list(&mut connection, &path, &dir, ignored).await
}

/// The text of the file `relative` of the worktree at `path`, for the editor (A-18).
#[tauri::command]
pub async fn orca_file_read(
    path: String,
    relative: String,
    environment: Option<String>,
) -> Result<OrcaFileText, String> {
    check_relative(&relative, false)?;
    host_of(&path, environment.as_deref()).await?;
    let mut connection = Connection::open(environment).await?;
    read(&mut connection, &path, &relative).await
}

/// Saves the text of the editor over the file it was read from, if the disk still holds what was read (`signature`), and answers what happened (A-18). It is not tried again: a failure carries its message.
#[tauri::command]
pub async fn orca_file_write(
    path: String,
    relative: String,
    content: String,
    crlf: bool,
    signature: String,
    environment: Option<String>,
) -> Result<OrcaSaved, String> {
    check_relative(&relative, false)?;
    let host_id = host_of(&path, environment.as_deref()).await?;
    let mut connection = Connection::open(environment).await?;
    write(
        &mut connection,
        &path,
        &host_id,
        &relative,
        &content,
        crlf,
        &signature,
    )
    .await
}

// ---- the settings ----

/// The time of the automatic save a value gives: into the range, to the nearest step.
fn clamp_autosave(ms: i64) -> u32 {
    let ms = ms.clamp(AUTOSAVE_MIN, AUTOSAVE_MAX);
    let stepped = (ms + AUTOSAVE_STEP / 2) / AUTOSAVE_STEP * AUTOSAVE_STEP;
    u32::try_from(stepped).unwrap_or(AUTOSAVE_DEFAULT)
}

/// The saved settings; a missing or unreadable file gives the first value, and a value out of the range is brought into it.
fn load_settings(dir: &Path) -> EditorSettings {
    let saved = std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<EditorSettings>(&text).ok());
    EditorSettings {
        autosave_ms: saved.map_or(AUTOSAVE_DEFAULT, |s| {
            clamp_autosave(i64::from(s.autosave_ms))
        }),
    }
}

fn save_settings(dir: &Path, autosave_ms: i64) -> Result<EditorSettings, String> {
    let settings = EditorSettings {
        autosave_ms: clamp_autosave(autosave_ms),
    };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(SETTINGS_FILE), dir.join(SETTINGS_TMP_FILE));
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))?;
    Ok(settings)
}

/// The settings of the editor (A-18).
#[tauri::command]
pub async fn editor_settings(app: AppHandle) -> Result<EditorSettings, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || load_settings(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// Saves the time of the automatic save, brought into 100 to 3000 ms in steps of 100, and answers the settings saved (A-18).
#[tauri::command]
pub async fn editor_settings_set(
    app: AppHandle,
    autosave_ms: i64,
) -> Result<EditorSettings, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || save_settings(&dir, autosave_ms))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, path::PathBuf};

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-files-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(name: &str, is_directory: bool) -> OrcaFileEntry {
        OrcaFileEntry {
            name: name.into(),
            path: name.into(),
            is_directory,
            ignored: false,
        }
    }

    fn names(entries: &[OrcaFileEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    /// Orca's side of the calls: the answer of each method (an error for a method it lacks), and the calls it was given.
    type Answer = Result<Value, (&'static str, &'static str)>;

    #[derive(Default)]
    struct Fake {
        answers: HashMap<&'static str, Answer>,
        calls: Vec<(String, Value)>,
    }

    impl Rpc for Fake {
        async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
            self.calls.push((method.to_owned(), params));
            match self.answers.get(method) {
                Some(Ok(value)) => Ok(value.clone()),
                Some(Err((shown, detail))) => Err(CallError {
                    shown: (*shown).into(),
                    detail: (*detail).into(),
                }),
                None => Err(CallError {
                    shown: "no answer".into(),
                    detail: String::new(),
                }),
            }
        }
    }

    fn fake(answers: Vec<(&'static str, Answer)>) -> Fake {
        Fake {
            answers: answers.into_iter().collect(),
            ..Fake::default()
        }
    }

    #[test]
    fn a_relative_path_stays_inside_the_worktree() {
        for ok in [
            "",
            "a",
            "src/main.rs",
            "日本語/ファイル.txt",
            ".claude/rules/a.md",
        ] {
            assert!(check_relative(ok, true).is_ok(), "{ok}");
        }
        assert!(check_relative("", false).is_err());
        for bad in [
            "/etc/passwd",
            "../x",
            "a/../b",
            "a/./b",
            "a//b",
            "a/",
            "a\nb",
            "a\0b",
            "..",
            ".",
        ] {
            assert!(check_relative(bad, true).is_err(), "{bad:?}");
        }
        assert!(check_relative(&"a".repeat(MAX_PATH), false).is_ok());
        assert!(check_relative(&"a".repeat(MAX_PATH + 1), false).is_err());
    }

    #[test]
    fn a_path_is_the_folder_and_the_name() {
        assert_eq!(join("", "a.rs"), "a.rs");
        assert_eq!(join("src", "a.rs"), "src/a.rs");
        assert_eq!(join("src/bin", "a.rs"), "src/bin/a.rs");
    }

    #[test]
    fn names_are_in_natural_order() {
        let mut entries: Vec<OrcaFileEntry> =
            ["b10", "B2", "a", "b2", "a01", "a1", "_x", ".git", "A"]
                .iter()
                .map(|n| entry(n, false))
                .collect();
        sort_entries(&mut entries);
        // `.` and `_` come before letters, case does not decide, a number counts by its value, and a tie falls to the plain order (`A` before `a`, `a01` before `a1`).
        assert_eq!(
            names(&entries),
            [".git", "_x", "A", "a", "a01", "a1", "B2", "b2", "b10"]
        );
    }

    #[test]
    fn folders_come_before_files() {
        let mut entries = vec![
            entry("a.txt", false),
            entry("zeta", true),
            entry("Alpha", true),
            entry("b.txt", false),
        ];
        sort_entries(&mut entries);
        assert_eq!(names(&entries), ["Alpha", "zeta", "a.txt", "b.txt"]);
    }

    #[test]
    fn a_page_and_a_bare_array_are_both_a_list() {
        let page = json!({"entries": [
            {"name": "src", "isDirectory": true, "isSymlink": false},
            {"name": "a.rs", "isDirectory": false},
            {"name": "", "isDirectory": false},
            {"name": "x/y", "isDirectory": false},
            {"name": "..", "isDirectory": true},
            {"isDirectory": false},
        ], "total": 9, "hasMore": true});
        let (entries, total) = parse_dir(&page, "lib").unwrap();
        assert_eq!(names(&entries), ["src", "a.rs"]);
        assert_eq!(entries[0].path, "lib/src");
        assert!(entries[0].is_directory && !entries[1].is_directory);
        assert_eq!(total, 9);
        let bare = json!([{"name": "a", "isDirectory": false}]);
        assert_eq!(parse_dir(&bare, "").unwrap(), (vec![entry("a", false)], 1));
        // A total below what was listed is not believed.
        let short = json!({"entries": [{"name": "a"}, {"name": "b"}], "total": 1});
        assert_eq!(parse_dir(&short, "").unwrap().1, 2);
        assert!(parse_dir(&json!({"error": 1}), "").is_err());
        assert!(parse_dir(&json!("x"), "").is_err());
    }

    #[test]
    fn what_git_ignores_is_marked() {
        let mut entries = vec![
            entry("node_modules", true),
            entry("src", true),
            entry("a.log", false),
        ];
        let ignored: HashSet<String> = ["node_modules", "a.log"].map(String::from).into();
        mark_ignored(&mut entries, &ignored);
        assert_eq!(
            entries.iter().map(|e| e.ignored).collect::<Vec<_>>(),
            [true, false, true]
        );
    }

    #[tokio::test]
    async fn a_folder_is_listed_sorted_and_marked() {
        let mut orca = fake(vec![
            (
                "files.readDir",
                Ok(json!({"entries": [
                    {"name": "b.log", "isDirectory": false},
                    {"name": "target", "isDirectory": true},
                    {"name": "src", "isDirectory": true},
                ], "total": 3, "hasMore": false})),
            ),
            // Git echoes a folder with or without its slash.
            ("git.checkIgnored", Ok(json!(["lib/target/", "lib/b.log"]))),
        ]);
        let dir = list(&mut orca, "/work/a", "lib", false).await.unwrap();
        assert_eq!(names(&dir.entries), ["src", "target", "b.log"]);
        assert_eq!(
            dir.entries.iter().map(|e| e.ignored).collect::<Vec<_>>(),
            [false, true, true]
        );
        assert_eq!(dir.total, 3);
        assert_eq!(
            orca.calls[0],
            (
                "files.readDir".to_owned(),
                json!({"worktree": "path:/work/a", "relativePath": "lib", "limit": 5000})
            )
        );
        assert_eq!(
            orca.calls[1].1,
            json!({"worktree": "path:/work/a", "paths": ["lib/src", "lib/target", "lib/b.log"]})
        );
    }

    #[tokio::test]
    async fn what_an_ignored_folder_holds_is_ignored_without_a_check() {
        let mut orca = fake(vec![(
            "files.readDir",
            Ok(json!({"entries": [
                {"name": "a.o", "isDirectory": false},
                {"name": "deps", "isDirectory": true},
            ], "total": 2})),
        )]);
        let dir = list(&mut orca, "/work/a", "target", true).await.unwrap();
        assert_eq!(names(&dir.entries), ["deps", "a.o"]);
        assert!(dir.entries.iter().all(|e| e.ignored));
        assert_eq!(orca.calls.len(), 1);
        assert_eq!(orca.calls[0].0, "files.readDir");
    }

    #[tokio::test]
    async fn a_failed_ignore_check_still_gives_the_list() {
        let mut orca = fake(vec![
            (
                "files.readDir",
                Ok(json!([{"name": "a", "isDirectory": false}])),
            ),
            (
                "git.checkIgnored",
                Err(("Orca がエラーを返しました", "not a git repository")),
            ),
        ]);
        let dir = list(&mut orca, "/work/a", "", false).await.unwrap();
        assert_eq!(dir.entries, vec![entry("a", false)]);
    }

    #[tokio::test]
    async fn the_paths_to_check_go_in_chunks() {
        let entries: Vec<Value> = (0..IGNORE_CHUNK + 1)
            .map(|i| json!({"name": format!("f{i}"), "isDirectory": false}))
            .collect();
        let mut orca = fake(vec![
            (
                "files.readDir",
                Ok(json!({"entries": entries, "total": IGNORE_CHUNK + 1})),
            ),
            ("git.checkIgnored", Ok(json!(["f0"]))),
        ]);
        let dir = list(&mut orca, "/work/a", "", false).await.unwrap();
        let checks: Vec<&Value> = orca
            .calls
            .iter()
            .filter(|(m, _)| m == "git.checkIgnored")
            .map(|(_, p)| &p["paths"])
            .collect();
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].as_array().unwrap().len(), IGNORE_CHUNK);
        assert_eq!(checks[1].as_array().unwrap().len(), 1);
        assert_eq!(dir.entries.iter().filter(|e| e.ignored).count(), 1);
    }

    #[tokio::test]
    async fn a_failed_list_says_why() {
        let mut orca = fake(vec![(
            "files.readDir",
            Err((
                "Orca がエラーを返しました（runtime_error）",
                "ENOENT: no such file or directory",
            )),
        )]);
        assert_eq!(
            list(&mut orca, "/work/a", "gone", false).await.unwrap_err(),
            "ファイルが見つかりません"
        );
        let mut orca = fake(vec![("files.readDir", Ok(json!({"entries": 1})))]);
        assert_eq!(
            list(&mut orca, "/work/a", "", false).await.unwrap_err(),
            NOT_LISTED
        );
    }

    // The values below are Orca's own `getDiskBaselineSignature` of each text, computed with node.
    #[test]
    fn the_signature_is_orcas() {
        assert_eq!(disk_signature(""), "811c9dc5-50c5d1f-0");
        assert_eq!(disk_signature("second\n"), "8fb70e75-69fe284f-7");
        assert_eq!(disk_signature("a\u{e9}b\n"), "88abf7b7-8d7ca159-4");
        // The length counts UTF-16 code units: the emoji is two.
        assert_eq!(disk_signature("hello\nあいう😀\n"), "b76caf8a-f6f0d250-c");
    }

    #[test]
    fn only_a_text_the_editor_keeps_whole_is_opened() {
        assert!(!line_ending("a\nb\n").unwrap());
        assert!(!line_ending("").unwrap());
        assert!(line_ending("a\r\nb\r\n").unwrap());
        assert!(line_ending("a\r\nb").unwrap());
        for mixed in ["a\r\nb\n", "a\nb\r\n", "a\rb", "a\r\n\rb", "a\r"] {
            assert!(line_ending(mixed).is_err(), "{mixed:?}");
        }
    }

    #[test]
    fn a_read_is_the_whole_text_with_lf() {
        let text =
            parse_text(&json!({"content": "a\nb\n", "truncated": false, "byteLength": 4})).unwrap();
        assert_eq!(
            text,
            OrcaFileText {
                content: "a\nb\n".into(),
                crlf: false,
                signature: disk_signature("a\nb\n"),
            }
        );
        // A CRLF file reaches the editor with LF, and its signature is of the bytes on the disk.
        let text = parse_text(&json!({"content": "a\r\nb\r\n"})).unwrap();
        assert_eq!((text.content.as_str(), text.crlf), ("a\nb\n", true));
        assert_eq!(text.signature, disk_signature("a\r\nb\r\n"));
    }

    #[test]
    fn a_file_the_editor_cannot_keep_whole_is_refused() {
        let large = format!("{} KiB を超えるファイルは開けません", MAX_TEXT / 1024);
        assert_eq!(
            parse_text(&json!({"content": "a", "truncated": true})).unwrap_err(),
            large
        );
        assert_eq!(
            parse_text(&json!({"content": "a", "byteLength": MAX_TEXT + 1})).unwrap_err(),
            large
        );
        assert_eq!(
            parse_text(&json!({"content": "a".repeat(MAX_TEXT + 1)})).unwrap_err(),
            large
        );
        assert!(
            parse_text(&json!({"content": "a".repeat(MAX_TEXT), "byteLength": MAX_TEXT})).is_ok()
        );
        assert_eq!(
            parse_text(&json!({"content": "a\u{FFFD}b"})).unwrap_err(),
            "UTF-8 ではないファイルは開けません"
        );
        assert!(parse_text(&json!({"content": "a\rb"})).is_err());
        assert!(parse_text(&json!({"truncated": false})).is_err());
        assert!(parse_text(&json!({"content": 3})).is_err());
    }

    #[tokio::test]
    async fn a_file_is_read_with_its_path() {
        let mut orca = fake(vec![("files.read", Ok(json!({"content": "x\n"})))]);
        assert_eq!(
            read(&mut orca, "/work/a", "src/a.rs")
                .await
                .unwrap()
                .content,
            "x\n"
        );
        assert_eq!(
            orca.calls[0],
            (
                "files.read".to_owned(),
                json!({"worktree": "path:/work/a", "relativePath": "src/a.rs"})
            )
        );
        let mut orca = fake(vec![(
            "files.read",
            Err(("Orca がエラーを返しました（runtime_error）", "binary_file")),
        )]);
        assert_eq!(
            read(&mut orca, "/work/a", "a.png").await.unwrap_err(),
            "バイナリのファイルは開けません"
        );
        let mut orca = fake(vec![(
            "files.read",
            Err((
                "Orca がエラーを返しました（runtime_error）",
                "invalid_relative_path",
            )),
        )]);
        assert_eq!(
            read(&mut orca, "/work/a", "a").await.unwrap_err(),
            "ファイルの場所が正しくありません"
        );
        let mut orca = fake(vec![("files.read", Err(("Orca に接続できません", "")))]);
        assert_eq!(
            read(&mut orca, "/work/a", "a").await.unwrap_err(),
            "Orca に接続できません"
        );
    }

    #[test]
    fn a_refusal_names_what_changed() {
        assert_eq!(save_state(&json!({"ok": true})), OrcaSaveState::Saved);
        assert_eq!(
            save_state(&json!({"ok": true, "unchanged": true})),
            OrcaSaveState::Saved
        );
        // An old host answers with nothing, or with a bare value, and the write was made.
        assert_eq!(save_state(&Value::Null), OrcaSaveState::Saved);
        assert_eq!(save_state(&json!({})), OrcaSaveState::Saved);
        let refused = |why: Value| save_state(&json!({"ok": false, "diskConflict": why}));
        assert_eq!(refused(json!("changed")), OrcaSaveState::Changed);
        assert_eq!(refused(json!("missing")), OrcaSaveState::Missing);
        assert_eq!(refused(json!("not-utf8")), OrcaSaveState::NotUtf8);
        assert_eq!(refused(json!("something else")), OrcaSaveState::Changed);
        assert_eq!(save_state(&json!({"ok": false})), OrcaSaveState::Changed);
    }

    #[test]
    fn a_crlf_file_is_written_with_crlf() {
        assert_eq!(disk_text("a\nb\n", true), "a\r\nb\r\n");
        assert_eq!(disk_text("a\nb\n", false), "a\nb\n");
    }

    #[tokio::test]
    async fn a_save_sends_the_signature_and_the_host() {
        let mut orca = fake(vec![("files.writeIfUnchanged", Ok(json!({"ok": true})))]);
        let saved = write(
            &mut orca, "/work/a", "local", "src/a.rs", "x\ny\n", true, "old-sig",
        )
        .await
        .unwrap();
        assert_eq!(
            saved,
            OrcaSaved {
                state: OrcaSaveState::Saved,
                signature: disk_signature("x\r\ny\r\n"),
            }
        );
        assert_eq!(
            orca.calls[0],
            (
                "files.writeIfUnchanged".to_owned(),
                json!({
                    "worktree": "path:/work/a",
                    "expectedExecutionHostId": "local",
                    "relativePath": "src/a.rs",
                    "content": "x\r\ny\r\n",
                    "diskPrecondition": {"expectedSignature": "old-sig", "requireLosslessUtf8": true},
                })
            )
        );
    }

    #[tokio::test]
    async fn a_refused_save_keeps_the_old_signature() {
        let mut orca = fake(vec![(
            "files.writeIfUnchanged",
            Ok(json!({"ok": false, "diskConflict": "changed"})),
        )]);
        let saved = write(&mut orca, "/work/a", "local", "a", "x", false, "old-sig")
            .await
            .unwrap();
        assert_eq!(
            saved,
            OrcaSaved {
                state: OrcaSaveState::Changed,
                signature: "old-sig".into(),
            }
        );
    }

    #[tokio::test]
    async fn a_failed_save_says_why_and_a_large_text_is_not_sent() {
        let mut orca = fake(vec![(
            "files.writeIfUnchanged",
            Err(("Orca がエラーを返しました（method_not_found）", "")),
        )]);
        assert_eq!(
            write(&mut orca, "/work/a", "local", "a", "x", false, "s")
                .await
                .unwrap_err(),
            "この Orca は、変更を確かめてからの保存に対応していません"
        );
        let mut orca = fake(vec![(
            "files.writeIfUnchanged",
            Err(("Orca がエラーを返しました（forbidden）", "")),
        )]);
        assert_eq!(
            write(&mut orca, "/work/a", "local", "a", "x", false, "s")
                .await
                .unwrap_err(),
            "Orca がエラーを返しました（forbidden）"
        );
        let mut orca = fake(vec![("files.writeIfUnchanged", Ok(json!({"ok": true})))]);
        let big = "a".repeat(MAX_TEXT + 1);
        assert!(write(&mut orca, "/work/a", "local", "a", &big, false, "s")
            .await
            .is_err());
        // The CRLF it adds counts: the text on the wire is what is limited.
        let lines = "\n".repeat(MAX_TEXT / 2 + 1);
        assert!(write(&mut orca, "/work/a", "local", "a", &lines, true, "s")
            .await
            .is_err());
        assert!(orca.calls.is_empty());
    }

    #[test]
    fn an_ssh_worktree_has_no_files() {
        assert!(check_host("local").is_ok());
        assert!(check_host("runtime:abc").is_ok());
        assert!(check_host("ssh:build").is_err());
    }

    #[test]
    fn the_time_of_the_save_is_brought_into_range_and_step() {
        assert_eq!(clamp_autosave(1000), 1000);
        assert_eq!(clamp_autosave(100), 100);
        assert_eq!(clamp_autosave(3000), 3000);
        assert_eq!(clamp_autosave(0), 100);
        assert_eq!(clamp_autosave(-5), 100);
        assert_eq!(clamp_autosave(99), 100);
        assert_eq!(clamp_autosave(3001), 3000);
        assert_eq!(clamp_autosave(i64::MAX), 3000);
        assert_eq!(clamp_autosave(i64::MIN), 100);
        // Between two steps, the nearer one, and the upper one from the middle.
        assert_eq!(clamp_autosave(149), 100);
        assert_eq!(clamp_autosave(150), 200);
        assert_eq!(clamp_autosave(2949), 2900);
        assert_eq!(clamp_autosave(2950), 3000);
    }

    #[test]
    fn the_settings_are_saved_and_read_back() {
        let dir = temp_dir("settings");
        assert_eq!(load_settings(&dir).autosave_ms, 1000);
        assert_eq!(save_settings(&dir, 450).unwrap().autosave_ms, 500);
        assert_eq!(load_settings(&dir).autosave_ms, 500);
        assert_eq!(save_settings(&dir, 99_999).unwrap().autosave_ms, 3000);
        assert_eq!(load_settings(&dir).autosave_ms, 3000);
        assert!(!dir.join(SETTINGS_TMP_FILE).exists());
        let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({"autosaveMs": 3000})
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_settings_file_that_cannot_be_used_gives_the_first_value() {
        let dir = temp_dir("broken");
        for text in [
            "",
            "not json",
            "{}",
            "{\"autosaveMs\": -1}",
            "{\"autosaveMs\": \"x\"}",
        ] {
            std::fs::write(dir.join(SETTINGS_FILE), text).unwrap();
            assert_eq!(load_settings(&dir).autosave_ms, 1000, "{text}");
        }
        // A value out of the range is brought into it.
        std::fs::write(dir.join(SETTINGS_FILE), "{\"autosaveMs\": 50}").unwrap();
        assert_eq!(load_settings(&dir).autosave_ms, 100);
        std::fs::write(dir.join(SETTINGS_FILE), "{\"autosaveMs\": 9000}").unwrap();
        assert_eq!(load_settings(&dir).autosave_ms, 3000);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
