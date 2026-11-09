//! A-18: the files of a worktree on the Orca screen: the list of its folders, and the text of a file read and saved by the editor.
//! The calls are Orca's runtime (`files.readDir`, `files.read`, `files.writeIfUnchanged`, `git.checkIgnored`), on this machine over its unix socket and on a paired server over its WebSocket (the connection of A-10).
//! They are not a public interface of Orca: this was read in the `app.asar` of Orca 1.4.253 and tried on this machine's Orca. A token is in no log line, no error text and no return value, and the text of a file is in no log line.
//!
//! A file is saved with `files.writeIfUnchanged`: Orca writes only when the disk still holds the text that was read, by a signature of it (`disk_signature`, the one of Orca's `disk-baseline-signature.js`), and answers `diskConflict` when it does not, so a file changed elsewhere is never overwritten.
//! The text goes through a textarea, which turns CRLF into LF and cannot hold a lone CR, so only a file with no CR or with a CRLF at every line end is opened (`line_ending`), and a CRLF file is written back with CRLF.
//! The time of the automatic save is saved in `editor-settings.json` in the app config directory.
//! A file is also copied to this PC (`download`): `files.stat` gives its size, then `files.readChunk` is called until `eof` (and never past the size), or `files.readPreview` once on a host that lacks either, and the bytes go to a temporary file beside the destination, which is moved onto it when all have come. It was tried on Orca 1.4.254 on this machine (a chunk may be at most 512 KiB).

use std::{
    cmp::Ordering,
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts::write_synced,
    auth::config_dir,
    orca::worktree_host,
    orca_attach::{worktree_params, Rpc},
    orca_chat::{CallError, Connection},
    orca_language::{detect_language, highlight_name},
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
/// The bytes one `files.readChunk` asks for (the size Orca's own client reads at a time; Orca refuses more than 512 KiB).
const CHUNK: usize = 384 * 1024;
/// The longest name of a file on the file systems of this PC, in bytes.
const MAX_NAME: usize = 255;
/// What the name of the temporary file adds to the name of the destination: the `.` before, the `.{n}` of a retry (n below `TEMP_TRIES`) and the `.part` after.
const TEMP_AFFIX: usize = 1 + 4 + 5;
/// How many names of a temporary file are tried before the download gives up.
const TEMP_TRIES: u32 = 1000;
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
/// `language` is the name Orca's editor gives the file (A-21), and `highlight` the name the page's highlighter knows it by (null: no grammar, the text is drawn plain).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaFileText {
    pub content: String,
    pub crlf: bool,
    pub signature: String,
    pub language: String,
    pub highlight: Option<String>,
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
fn parse_text(result: &Value, relative: &str) -> Result<OrcaFileText, String> {
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
    let language = detect_language(relative, content);
    Ok(OrcaFileText {
        content: if crlf {
            content.replace("\r\n", "\n")
        } else {
            content.to_owned()
        },
        crlf,
        signature: disk_signature(content),
        language: language.to_owned(),
        highlight: highlight_name(language).map(str::to_owned),
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
    parse_text(&answer, relative)
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

// ---- the download ----

/// The bytes and the end of an answer of `files.readChunk`: `{contentBase64, bytesRead, eof}`, where the decoded bytes must be as many as `bytesRead` and no more than were asked for. The text of a bad answer holds none of its bytes.
fn parse_chunk(result: &Value, length: usize) -> Result<(Vec<u8>, bool), String> {
    let unreadable = || "ファイルを読めません".to_owned();
    let content = result["contentBase64"].as_str().ok_or_else(unreadable)?;
    let bytes_read = result["bytesRead"].as_u64().ok_or_else(unreadable)?;
    let eof = result["eof"].as_bool().ok_or_else(unreadable)?;
    let bytes = STANDARD.decode(content).map_err(|_| unreadable())?;
    if bytes.len() as u64 != bytes_read || bytes.len() > length {
        return Err(unreadable());
    }
    Ok((bytes, eof))
}

/// The whole file from an answer of `files.readPreview` (`{content, isBinary}`; a binary file's `content` is base64): a preview Orca cut short is refused, and so is one longer than `size` allows (a text that is not UTF-8 comes back with U+FFFD for each bad byte, which is 3 bytes for 1).
fn parse_preview(result: &Value, size: Option<u64>) -> Result<Vec<u8>, String> {
    if result["truncated"].as_bool() == Some(true) {
        return Err("ファイルが大きすぎて読めません".into());
    }
    let content = result["content"].as_str().ok_or("ファイルを読めません")?;
    let binary = result["isBinary"].as_bool() == Some(true);
    let bytes = if binary {
        STANDARD
            .decode(content)
            .map_err(|_| "ファイルを読めません".to_owned())?
    } else {
        content.as_bytes().to_vec()
    };
    let ceiling = size.map(|s| if binary { s } else { s.saturating_mul(3) });
    if ceiling.is_some_and(|c| bytes.len() as u64 > c) {
        return Err("ファイルを読めません".into());
    }
    Ok(bytes)
}

fn write_error(error: &std::io::Error) -> String {
    format!("この PC にファイルを書けません: {error}")
}

/// Runs `work`, which uses the disk, on a thread made for blocking, so that a large file does not hold a worker of the async runtime.
async fn on_disk<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| "この PC にファイルを書けません".to_owned())?
}

/// The temporary file being written, shared with the threads that write it.
type Out = Arc<Mutex<std::fs::File>>;

async fn put(out: &Out, bytes: Vec<u8>) -> Result<(), String> {
    let out = Arc::clone(out);
    on_disk(move || {
        out.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .write_all(&bytes)
            .map_err(|e| write_error(&e))
    })
    .await
}

/// The whole file by one `files.readPreview`, written to `out`. Answers the size.
async fn fetch_preview(
    rpc: &mut impl Rpc,
    path: &str,
    relative: &str,
    size: Option<u64>,
    out: &Out,
) -> Result<u64, String> {
    let answer = rpc
        .call(
            "files.readPreview",
            worktree_params(path, None, json!({"relativePath": relative})),
        )
        .await
        .map_err(reason)?;
    let bytes = parse_preview(&answer, size)?;
    let length = bytes.len() as u64;
    put(out, bytes).await?;
    Ok(length)
}

/// Reads the file `relative` of the worktree at `path` and writes it to `out`. `files.stat` gives the size first, and the reading stops with an error when Orca sends more than that, so an Orca that never says `eof` cannot fill the disk. Then `files.readChunk` is called, `CHUNK` bytes at a time until `eof`. A host that lacks `files.stat`, or answers `method_not_found` to the first `files.readChunk`, has the file read whole with `files.readPreview` (a host that lacks `files.stat` has no size to hold the preview to). Answers the size.
async fn fetch_into(
    rpc: &mut impl Rpc,
    path: &str,
    relative: &str,
    out: &Out,
) -> Result<u64, String> {
    let size = match rpc
        .call(
            "files.stat",
            worktree_params(path, None, json!({"relativePath": relative})),
        )
        .await
    {
        Ok(answer) => answer["size"].as_u64().ok_or("ファイルを読めません")?,
        Err(e) if e.shown.contains("method_not_found") => {
            return fetch_preview(rpc, path, relative, None, out).await;
        }
        Err(e) => return Err(reason(e)),
    };
    let mut offset = 0_u64;
    loop {
        let answer = rpc
            .call(
                "files.readChunk",
                worktree_params(
                    path,
                    None,
                    json!({"relativePath": relative, "offset": offset, "length": CHUNK}),
                ),
            )
            .await;
        let answer = match answer {
            Ok(answer) => answer,
            Err(e) if offset == 0 && e.shown.contains("method_not_found") => {
                return fetch_preview(rpc, path, relative, Some(size), out).await;
            }
            Err(e) => return Err(reason(e)),
        };
        let (bytes, eof) = parse_chunk(&answer, CHUNK)?;
        // More than the size said: the file grew, or Orca does not stop.
        if offset + bytes.len() as u64 > size {
            return Err("ファイルを読めません".into());
        }
        offset += bytes.len() as u64;
        let empty = bytes.is_empty();
        put(out, bytes).await?;
        if eof {
            return Ok(offset);
        }
        // An answer with no bytes and no end would be asked for again for ever.
        if empty {
            return Err("ファイルを読めません".into());
        }
    }
}

/// `text` cut to at most `max` bytes, at the boundary of a character.
fn cut(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The `attempt`th name of the temporary file beside `dest`, in the same folder so that the move onto `dest` is a rename: `.{name}.part`, then `.{name}.{attempt}.part`, with `name` cut so that the whole name fits `MAX_NAME`.
fn temp_path(dest: &Path, attempt: u32) -> Result<PathBuf, String> {
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("保存先の場所が正しくありません")?;
    let name = cut(name, MAX_NAME - TEMP_AFFIX);
    let retry = if attempt == 0 {
        String::new()
    } else {
        format!(".{attempt}")
    };
    Ok(dest.with_file_name(format!(".{name}{retry}.part")))
}

/// Makes the temporary file beside `dest` under a name nobody has: `create_new`, so a file or a link of that name (a `.part` of the owner's) is never opened, and the next name is tried.
fn create_temp(dest: &Path) -> Result<(std::fs::File, PathBuf), String> {
    for attempt in 0..TEMP_TRIES {
        let temp = temp_path(dest, attempt)?;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
        {
            Ok(file) => return Ok((file, temp)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(write_error(&e)),
        }
    }
    Err("保存先に一時ファイルを作れません".into())
}

/// Copies the file `relative` of the worktree at `path` to `dest` on this PC, and answers its size in bytes. `dest` is written whole or not at all: the bytes go to a temporary file in its folder (a new file, never one that was there), which is moved onto `dest` when every chunk has come, and is deleted when anything fails (an old `dest` stays as it was). `dest` is not checked here: the caller gives it, never the page.
pub(crate) async fn download(
    rpc: &mut impl Rpc,
    path: &str,
    relative: &str,
    dest: &Path,
) -> Result<u64, String> {
    check_relative(relative, false)?;
    let wanted = dest.to_path_buf();
    let (file, temp) = on_disk(move || create_temp(&wanted)).await?;
    let out: Out = Arc::new(Mutex::new(file));
    let done = match fetch_into(rpc, path, relative, &out).await {
        Ok(size) => {
            let (out, temp, dest) = (Arc::clone(&out), temp.clone(), dest.to_path_buf());
            on_disk(move || {
                out.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .sync_all()
                    .and_then(|()| std::fs::rename(&temp, &dest))
                    .map(|()| size)
                    .map_err(|e| write_error(&e))
            })
            .await
        }
        Err(message) => Err(message),
    };
    if done.is_err() {
        let _ = on_disk(move || {
            let _ = std::fs::remove_file(&temp);
            Ok(())
        })
        .await;
    }
    done
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

/// The name the save dialog starts with: the last part of the file's path from the worktree.
fn suggested_name(relative: &str) -> &str {
    relative.rsplit('/').next().unwrap_or(relative)
}

/// Copies the file `relative` of the worktree at `path` to this PC, to the place the owner picks in the save dialog (A-22), and answers the name of the file saved, or `None` when the dialog was cancelled. The place is the dialog's alone: the page gives none.
#[tauri::command]
pub async fn orca_file_download(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    relative: String,
    environment: Option<String>,
) -> Result<Option<String>, String> {
    check_relative(&relative, false)?;
    host_of(&path, environment.as_deref()).await?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_file_name(suggested_name(&relative))
        .save_file(move |picked| {
            let _ = sender.send(picked);
        });
    let Some(picked) = receiver
        .await
        .map_err(|_| "保存先を選べません".to_owned())?
    else {
        return Ok(None);
    };
    let dest = picked
        .into_path()
        .map_err(|_| "保存先の場所が正しくありません".to_owned())?;
    let mut connection = Connection::open(environment).await?;
    download(&mut connection, &path, &relative, &dest).await?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("保存先の場所が正しくありません")?;
    Ok(Some(name))
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
    fn the_save_dialog_starts_with_the_last_part_of_the_path() {
        assert_eq!(suggested_name("a.rs"), "a.rs");
        assert_eq!(suggested_name("src/lib/main.rs"), "main.rs");
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
        let text = parse_text(
            &json!({"content": "a\nb\n", "truncated": false, "byteLength": 4}),
            "a.txt",
        )
        .unwrap();
        assert_eq!(
            text,
            OrcaFileText {
                content: "a\nb\n".into(),
                crlf: false,
                signature: disk_signature("a\nb\n"),
                language: "plaintext".into(),
                highlight: None,
            }
        );
        // A CRLF file reaches the editor with LF, and its signature is of the bytes on the disk.
        let text = parse_text(&json!({"content": "a\r\nb\r\n"}), "a.txt").unwrap();
        assert_eq!((text.content.as_str(), text.crlf), ("a\nb\n", true));
        assert_eq!(text.signature, disk_signature("a\r\nb\r\n"));
    }

    #[test]
    fn a_read_names_the_language_of_the_file() {
        let text = parse_text(&json!({"content": "fn main() {}\n"}), "src/main.rs").unwrap();
        assert_eq!(text.language, "rust");
        assert_eq!(text.highlight.as_deref(), Some("rust"));
        // A name decides, and so does a `#!` line of a name with no extension; a language without a grammar has no highlight name.
        let text = parse_text(&json!({"content": "FROM x\n"}), "docker/Dockerfile").unwrap();
        assert_eq!(text.highlight.as_deref(), Some("dockerfile"));
        let text = parse_text(&json!({"content": "#!/bin/sh\n"}), "bin/run").unwrap();
        assert_eq!(text.highlight.as_deref(), Some("bash"));
        let text = parse_text(&json!({"content": "x"}), "main.zig").unwrap();
        assert_eq!((text.language.as_str(), text.highlight), ("zig", None));
    }

    #[test]
    fn a_file_the_editor_cannot_keep_whole_is_refused() {
        let large = format!("{} KiB を超えるファイルは開けません", MAX_TEXT / 1024);
        assert_eq!(
            parse_text(&json!({"content": "a", "truncated": true}), "a.txt").unwrap_err(),
            large
        );
        assert_eq!(
            parse_text(
                &json!({"content": "a", "byteLength": MAX_TEXT + 1}),
                "a.txt"
            )
            .unwrap_err(),
            large
        );
        assert_eq!(
            parse_text(&json!({"content": "a".repeat(MAX_TEXT + 1)}), "a.txt").unwrap_err(),
            large
        );
        assert!(parse_text(
            &json!({"content": "a".repeat(MAX_TEXT), "byteLength": MAX_TEXT}),
            "a.txt"
        )
        .is_ok());
        assert_eq!(
            parse_text(&json!({"content": "a\u{FFFD}b"}), "a.txt").unwrap_err(),
            "UTF-8 ではないファイルは開けません"
        );
        assert!(parse_text(&json!({"content": "a\rb"}), "a.txt").is_err());
        assert!(parse_text(&json!({"truncated": false}), "a.txt").is_err());
        assert!(parse_text(&json!({"content": 3}), "a.txt").is_err());
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

    /// A file on Orca's side that answers `files.stat` with its size (or with `stat`), and `files.readChunk` as Orca does (`eof` when the read reaches the end; `exact_eof` only on a read that finds nothing left; `never_eof` is an Orca that sends full chunks for ever), can fail on one call, can lack the method, and answers `files.readPreview` with `preview`.
    struct Remote {
        file: Vec<u8>,
        stat: Option<Answer>,
        has_chunks: bool,
        exact_eof: bool,
        never_eof: bool,
        fail_on_chunk: Option<usize>,
        preview: Option<Value>,
        calls: Vec<(String, Value)>,
    }

    impl Remote {
        fn new(file: Vec<u8>) -> Self {
            Remote {
                file,
                stat: None,
                has_chunks: true,
                exact_eof: false,
                never_eof: false,
                fail_on_chunk: None,
                preview: None,
                calls: Vec::new(),
            }
        }

        fn chunk_calls(&self) -> Vec<(u64, u64)> {
            self.calls
                .iter()
                .filter(|(m, _)| m == "files.readChunk")
                .map(|(_, p)| (p["offset"].as_u64().unwrap(), p["length"].as_u64().unwrap()))
                .collect()
        }
    }

    impl Rpc for Remote {
        async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
            self.calls.push((method.to_owned(), params.clone()));
            let failed = |shown: &str, detail: &str| CallError {
                shown: shown.into(),
                detail: detail.into(),
            };
            match method {
                "files.stat" => match self.stat.clone() {
                    Some(Ok(value)) => Ok(value),
                    Some(Err((shown, detail))) => Err(failed(shown, detail)),
                    None => Ok(json!({"size": self.file.len()})),
                },
                "files.readChunk" if !self.has_chunks => Err(failed(
                    "Orca がエラーを返しました（method_not_found）",
                    "Unknown method: files.readChunk",
                )),
                "files.readChunk" => {
                    if self.fail_on_chunk == Some(self.chunk_calls().len() - 1) {
                        return Err(failed("Orca に接続できません", ""));
                    }
                    let offset = usize::try_from(params["offset"].as_u64().unwrap()).unwrap();
                    let length = usize::try_from(params["length"].as_u64().unwrap()).unwrap();
                    if self.never_eof {
                        return Ok(json!({
                            "contentBase64": STANDARD.encode(vec![7_u8; length]),
                            "bytesRead": length,
                            "eof": false,
                        }));
                    }
                    let start = offset.min(self.file.len());
                    let end = (offset + length).min(self.file.len());
                    let bytes = &self.file[start..end];
                    let eof = if self.exact_eof {
                        bytes.is_empty()
                    } else {
                        end >= self.file.len()
                    };
                    Ok(json!({
                        "contentBase64": STANDARD.encode(bytes),
                        "bytesRead": bytes.len(),
                        "eof": eof,
                    }))
                }
                "files.readPreview" => self
                    .preview
                    .clone()
                    .ok_or_else(|| failed("Orca がエラーを返しました（runtime_error）", "ENOENT")),
                _ => Err(failed("no answer", "")),
            }
        }
    }

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| u8::try_from(i % 251).unwrap()).collect()
    }

    fn left_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_chunk_is_its_bytes_and_whether_it_is_the_end() {
        let bytes = [1_u8, 2, 3];
        let answer = json!({"contentBase64": STANDARD.encode(bytes), "bytesRead": 3, "eof": false});
        assert_eq!(parse_chunk(&answer, 3).unwrap(), (bytes.to_vec(), false));
        let end = json!({"contentBase64": "", "bytesRead": 0, "eof": true});
        assert_eq!(parse_chunk(&end, 3).unwrap(), (Vec::new(), true));
        // a count that differs from the bytes, more than was asked for, bad base64 and a missing key are all refused
        let secret = STANDARD.encode("secret text");
        for bad in [
            json!({"contentBase64": secret, "bytesRead": 3, "eof": true}),
            json!({"contentBase64": STANDARD.encode([0_u8; 4]), "bytesRead": 4, "eof": true}),
            json!({"contentBase64": "***", "bytesRead": 0, "eof": true}),
            json!({"contentBase64": "", "bytesRead": 0}),
            json!({"contentBase64": "", "eof": true}),
            json!({"bytesRead": 0, "eof": true}),
            json!({"contentBase64": 3, "bytesRead": 0, "eof": true}),
        ] {
            let message = parse_chunk(&bad, 3).unwrap_err();
            assert_eq!(message, "ファイルを読めません");
        }
    }

    #[test]
    fn a_preview_is_the_whole_file() {
        assert_eq!(
            parse_preview(&json!({"content": "héllo\n", "isBinary": false}), None).unwrap(),
            "héllo\n".as_bytes()
        );
        assert_eq!(
            parse_preview(
                &json!({"content": STANDARD.encode([0_u8, 255, 7]), "isBinary": true}),
                Some(3)
            )
            .unwrap(),
            vec![0_u8, 255, 7]
        );
        // a text may be up to 3 times the size (U+FFFD for each bad byte), a binary file is the size
        assert!(parse_preview(&json!({"content": "\u{fffd}", "isBinary": false}), Some(1)).is_ok());
        assert!(
            parse_preview(&json!({"content": "\u{fffd}a", "isBinary": false}), Some(1)).is_err()
        );
        assert!(parse_preview(
            &json!({"content": STANDARD.encode([0_u8; 4]), "isBinary": true}),
            Some(3)
        )
        .is_err());
        for bad in [
            json!({"content": "x", "isBinary": false, "truncated": true}),
            json!({"content": "***", "isBinary": true}),
            json!({"isBinary": false}),
        ] {
            assert!(parse_preview(&bad, None).is_err());
        }
    }

    #[tokio::test]
    async fn a_file_is_read_in_chunks_until_the_end() {
        let dir = temp_dir("download-chunks");
        let dest = dir.join("out.bin");
        let file = pattern(CHUNK * 2 + 10);
        let mut orca = Remote::new(file.clone());
        let size = download(&mut orca, "/work/a", "src/a.bin", &dest)
            .await
            .unwrap();
        assert_eq!(size, file.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), file);
        let chunk = CHUNK as u64;
        assert_eq!(
            orca.chunk_calls(),
            vec![(0, chunk), (chunk, chunk), (2 * chunk, chunk)]
        );
        assert_eq!(
            orca.calls[0],
            (
                "files.stat".to_owned(),
                json!({"worktree": "path:/work/a", "relativePath": "src/a.bin"})
            )
        );
        assert_eq!(
            orca.calls[1],
            (
                "files.readChunk".to_owned(),
                json!({"worktree": "path:/work/a", "relativePath": "src/a.bin", "offset": 0, "length": CHUNK})
            )
        );
        assert_eq!(left_in(&dir), ["out.bin"]);
    }

    #[tokio::test]
    async fn a_file_that_fits_one_chunk_or_is_empty_is_read() {
        let dir = temp_dir("download-small");
        for (name, file, calls) in [("one", pattern(5), 1), ("none", Vec::new(), 1)] {
            let dest = dir.join(name);
            let mut orca = Remote::new(file.clone());
            let size = download(&mut orca, "/work/a", "a", &dest).await.unwrap();
            assert_eq!(size, file.len() as u64);
            assert_eq!(std::fs::read(&dest).unwrap(), file);
            assert_eq!(orca.chunk_calls().len(), calls);
        }
        // a size that is a whole number of chunks, with `eof` only on the empty read after it
        let dest = dir.join("exact");
        let mut orca = Remote::new(pattern(CHUNK * 2));
        orca.exact_eof = true;
        download(&mut orca, "/work/a", "a", &dest).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), pattern(CHUNK * 2));
        assert_eq!(orca.chunk_calls().len(), 3);
    }

    #[tokio::test]
    async fn a_failure_in_the_middle_leaves_no_file() {
        let dir = temp_dir("download-fail");
        let dest = dir.join("out.bin");
        std::fs::write(&dest, b"old").unwrap();
        let mut orca = Remote::new(pattern(CHUNK * 3));
        orca.fail_on_chunk = Some(2);
        assert_eq!(
            download(&mut orca, "/work/a", "a", &dest)
                .await
                .unwrap_err(),
            "Orca に接続できません"
        );
        assert_eq!(orca.chunk_calls().len(), 3);
        // the old file stays as it was, and the temporary file is gone
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        assert_eq!(left_in(&dir), ["out.bin"]);
        // nothing is made when the first call fails
        let dest = dir.join("new.bin");
        let mut orca = Remote::new(pattern(5));
        orca.fail_on_chunk = Some(0);
        assert!(download(&mut orca, "/work/a", "a", &dest).await.is_err());
        assert_eq!(left_in(&dir), ["out.bin"]);
    }

    #[tokio::test]
    async fn an_answer_that_cannot_be_used_leaves_no_file() {
        let dir = temp_dir("download-bad");
        let dest = dir.join("out.bin");
        let secret = STANDARD.encode("secret text");
        for answer in [
            // bytes that differ from the count
            json!({"contentBase64": secret, "bytesRead": 1, "eof": true}),
            // no bytes and no end, which would be asked for again for ever
            json!({"contentBase64": "", "bytesRead": 0, "eof": false}),
            json!({"contentBase64": "***", "bytesRead": 0, "eof": true}),
        ] {
            let mut orca = fake(vec![
                ("files.stat", Ok(json!({"size": 100}))),
                ("files.readChunk", Ok(answer)),
            ]);
            let message = download(&mut orca, "/work/a", "a", &dest)
                .await
                .unwrap_err();
            assert_eq!(message, "ファイルを読めません");
            assert!(!message.contains("secret"));
            assert_eq!(orca.calls.len(), 2);
            assert!(left_in(&dir).is_empty());
        }
    }

    #[tokio::test]
    async fn a_host_without_read_chunk_is_read_with_the_preview() {
        let dir = temp_dir("download-preview");
        let dest = dir.join("out.txt");
        let mut orca = Remote::new(vec![0; 6]);
        orca.has_chunks = false;
        orca.preview = Some(json!({"content": "hello\n", "isBinary": false}));
        let size = download(&mut orca, "/work/a", "a.txt", &dest)
            .await
            .unwrap();
        assert_eq!(size, 6);
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello\n");
        assert_eq!(
            orca.calls
                .iter()
                .map(|(m, _)| m.as_str())
                .collect::<Vec<_>>(),
            ["files.stat", "files.readChunk", "files.readPreview"]
        );
        assert_eq!(
            orca.calls[2].1,
            json!({"worktree": "path:/work/a", "relativePath": "a.txt"})
        );
        // a binary file comes in base64
        let dest = dir.join("out.bin");
        orca.preview = Some(
            json!({"content": STANDARD.encode([0_u8, 255]), "isBinary": true, "isImage": true, "mimeType": "image/png"}),
        );
        download(&mut orca, "/work/a", "a.png", &dest)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), vec![0_u8, 255]);
        // a preview that is cut short, or a failed one, leaves nothing
        let dest = dir.join("cut.txt");
        orca.preview = Some(json!({"content": "he", "isBinary": false, "truncated": true}));
        assert!(download(&mut orca, "/work/a", "a", &dest).await.is_err());
        orca.preview = None;
        assert!(download(&mut orca, "/work/a", "a", &dest).await.is_err());
        assert_eq!(left_in(&dir), ["out.bin", "out.txt"]);
    }

    #[tokio::test]
    async fn the_preview_is_used_only_for_a_first_call_without_the_method() {
        let dir = temp_dir("download-late-mnf");
        let dest = dir.join("out.bin");
        let mut orca = fake(vec![
            ("files.stat", Ok(json!({"size": 5}))),
            (
                "files.readChunk",
                Err(("Orca がエラーを返しました（method_not_found）", "")),
            ),
        ]);
        // the first call lacks the method and the preview is not there either: its failure is the answer
        assert!(download(&mut orca, "/work/a", "a", &dest).await.is_err());
        assert_eq!(orca.calls.len(), 3);
        assert!(left_in(&dir).is_empty());
        // a missing file is not a missing method
        let mut orca = fake(vec![
            ("files.stat", Ok(json!({"size": 5}))),
            (
                "files.readChunk",
                Err((
                    "Orca がエラーを返しました（runtime_error）",
                    "ENOENT: no such file",
                )),
            ),
        ]);
        assert_eq!(
            download(&mut orca, "/work/a", "a", &dest)
                .await
                .unwrap_err(),
            "ファイルが見つかりません"
        );
        assert_eq!(orca.calls.len(), 2);
    }

    #[tokio::test]
    async fn an_orca_that_never_says_eof_is_stopped_at_the_size() {
        let dir = temp_dir("download-never-eof");
        let dest = dir.join("out.bin");
        let mut orca = Remote::new(pattern(CHUNK + 5));
        orca.never_eof = true;
        assert_eq!(
            download(&mut orca, "/work/a", "a", &dest)
                .await
                .unwrap_err(),
            "ファイルを読めません"
        );
        // the chunk that goes past the size is not written, and nothing is left
        assert_eq!(orca.chunk_calls().len(), 2);
        assert!(left_in(&dir).is_empty());
        // a file that is exactly its size is read
        let mut orca = Remote::new(pattern(CHUNK));
        assert_eq!(
            download(&mut orca, "/work/a", "a", &dest).await.unwrap(),
            CHUNK as u64
        );
    }

    #[tokio::test]
    async fn the_size_comes_from_stat_and_a_stat_that_fails_is_reported() {
        let dir = temp_dir("download-stat");
        let dest = dir.join("out.bin");
        // a size smaller than the bytes the file gives
        let mut orca = Remote::new(pattern(10));
        orca.stat = Some(Ok(json!({"size": 4})));
        assert!(download(&mut orca, "/work/a", "a", &dest).await.is_err());
        // no usable size
        for answer in [json!({}), json!({"size": "5"}), json!({"size": -1})] {
            let mut orca = Remote::new(pattern(5));
            orca.stat = Some(Ok(answer));
            assert_eq!(
                download(&mut orca, "/work/a", "a", &dest)
                    .await
                    .unwrap_err(),
                "ファイルを読めません"
            );
            assert!(orca.chunk_calls().is_empty());
        }
        // a missing file, and any other failure, are the stat's
        let mut orca = Remote::new(pattern(5));
        orca.stat = Some(Err((
            "Orca がエラーを返しました（runtime_error）",
            "ENOENT: no such file",
        )));
        assert_eq!(
            download(&mut orca, "/work/a", "a", &dest)
                .await
                .unwrap_err(),
            "ファイルが見つかりません"
        );
        orca.stat = Some(Err(("Orca に接続できません", "")));
        assert_eq!(
            download(&mut orca, "/work/a", "a", &dest)
                .await
                .unwrap_err(),
            "Orca に接続できません"
        );
        assert!(orca.chunk_calls().is_empty());
        assert!(left_in(&dir).is_empty());
    }

    #[tokio::test]
    async fn a_host_without_stat_is_read_with_the_preview() {
        let dir = temp_dir("download-no-stat");
        let dest = dir.join("out.txt");
        let mut orca = Remote::new(Vec::new());
        orca.stat = Some(Err((
            "Orca がエラーを返しました（method_not_found）",
            "Unknown method: files.stat",
        )));
        orca.preview = Some(json!({"content": "hello\n", "isBinary": false}));
        assert_eq!(
            download(&mut orca, "/work/a", "a.txt", &dest)
                .await
                .unwrap(),
            6
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello\n");
        assert_eq!(
            orca.calls
                .iter()
                .map(|(m, _)| m.as_str())
                .collect::<Vec<_>>(),
            ["files.stat", "files.readPreview"]
        );
    }

    #[tokio::test]
    async fn a_preview_longer_than_the_size_is_refused() {
        let dir = temp_dir("download-preview-size");
        let dest = dir.join("out.txt");
        let mut orca = Remote::new(vec![0; 1]);
        orca.has_chunks = false;
        orca.preview = Some(json!({"content": "hello\n", "isBinary": false}));
        assert_eq!(
            download(&mut orca, "/work/a", "a", &dest)
                .await
                .unwrap_err(),
            "ファイルを読めません"
        );
        assert!(left_in(&dir).is_empty());
    }

    #[tokio::test]
    async fn a_temporary_name_that_is_taken_is_not_used() {
        let dir = temp_dir("download-taken");
        let dest = dir.join("out.bin");
        let file = pattern(100);
        // a `.part` the owner already has stays as it is, on success and on failure
        std::fs::write(dir.join(".out.bin.part"), b"mine").unwrap();
        std::fs::write(dir.join(".out.bin.1.part"), b"mine too").unwrap();
        let mut orca = Remote::new(file.clone());
        download(&mut orca, "/work/a", "a", &dest).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), file);
        assert_eq!(std::fs::read(dir.join(".out.bin.part")).unwrap(), b"mine");
        assert_eq!(
            std::fs::read(dir.join(".out.bin.1.part")).unwrap(),
            b"mine too"
        );
        let mut orca = Remote::new(file);
        orca.fail_on_chunk = Some(0);
        assert!(download(&mut orca, "/work/a", "a", &dest).await.is_err());
        assert_eq!(std::fs::read(dir.join(".out.bin.part")).unwrap(), b"mine");
        assert_eq!(
            left_in(&dir),
            [".out.bin.1.part", ".out.bin.part", "out.bin"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_link_in_the_place_of_the_temporary_file_is_not_followed() {
        let dir = temp_dir("download-link");
        let victim = dir.join("victim");
        std::fs::write(&victim, b"keep").unwrap();
        std::os::unix::fs::symlink(&victim, dir.join(".out.bin.part")).unwrap();
        let dest = dir.join("out.bin");
        let mut orca = Remote::new(pattern(20));
        download(&mut orca, "/work/a", "a", &dest).await.unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert_eq!(std::fs::read(&dest).unwrap(), pattern(20));
        let mut orca = Remote::new(pattern(20));
        orca.fail_on_chunk = Some(0);
        assert!(download(&mut orca, "/work/a", "a", &dest).await.is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert!(dir.join(".out.bin.part").symlink_metadata().is_ok());
    }

    #[tokio::test]
    async fn a_long_name_gets_a_temporary_name_that_fits() {
        let dir = temp_dir("download-long");
        for name in ["a".repeat(MAX_NAME), "あ".repeat(MAX_NAME / 3)] {
            let dest = dir.join(&name);
            assert_eq!(name.len(), MAX_NAME);
            for attempt in [0, 1, 999] {
                let temp = temp_path(&dest, attempt).unwrap();
                let temp_name = temp.file_name().unwrap().to_str().unwrap();
                assert!(temp_name.len() <= MAX_NAME, "{}", temp_name.len());
                assert!(temp_name.starts_with('.') && temp_name.ends_with(".part"));
                assert_eq!(temp.parent(), dest.parent());
            }
            let mut orca = Remote::new(pattern(30));
            download(&mut orca, "/work/a", "a", &dest).await.unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), pattern(30));
            assert_eq!(left_in(&dir), std::slice::from_ref(&name));
            std::fs::remove_file(&dest).unwrap();
        }
    }

    #[tokio::test]
    async fn a_bad_relative_path_or_destination_asks_nothing() {
        let dir = temp_dir("download-paths");
        let mut orca = Remote::new(pattern(5));
        for relative in ["", "../a", "/a", "a/../b"] {
            assert_eq!(
                download(&mut orca, "/work/a", relative, &dir.join("x"))
                    .await
                    .unwrap_err(),
                "ファイルの場所が正しくありません"
            );
        }
        assert!(download(&mut orca, "/work/a", "a", Path::new("/"))
            .await
            .is_err());
        // a folder that is not there cannot hold the file
        assert!(
            download(&mut orca, "/work/a", "a", &dir.join("none").join("x"))
                .await
                .is_err()
        );
        assert!(orca.calls.is_empty());
        assert!(left_in(&dir).is_empty());
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
