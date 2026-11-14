//! A-18: the files of a worktree on the Orca screen: the list of its folders, and the text of a file read and saved by the editor.
//! The calls are Orca's runtime (`files.readDir`, `files.read`, `files.writeIfUnchanged`, `files.createFile`, `files.createDir`, `files.delete`, `files.rename`, `git.checkIgnored`), on this machine over its unix socket and on a paired server over its WebSocket (the connection of A-10).
//! The folder is answered from `files.readDir` alone, and what git ignores is asked after it (`orca_files_ignored`, `git.checkIgnored`), as Orca's own window does.
//! They are not a public interface of Orca: this was read in the `app.asar` of Orca 1.4.253 and tried on this machine's Orca. A token is in no log line, no error text and no return value, and the text of a file is in no log line.
//!
//! A file is saved with `files.writeIfUnchanged`: Orca writes only when the disk still holds the text that was read, by a signature of it (`disk_signature`, the one of Orca's `disk-baseline-signature.js`), and answers `diskConflict` when it does not, so a file changed elsewhere is never overwritten.
//! The text goes through a textarea, which turns CRLF into LF and cannot hold a lone CR, so only a file with no CR or with a CRLF at every line end is opened (`line_ending`), and a CRLF file is written back with CRLF.
//! The time of the automatic save is saved in `editor-settings.json` in the app config directory.
//! The difference of a file from HEAD (A-24, `orca_file_diff`) is Orca's `git.diff` (`staged` false, `compareAgainstHead` true): the text at HEAD and the text in the working tree, which `orca_diff.rs` turns into rows.
//! The branches of a worktree (`orca_local_branches`, `git.localBranches`) and the remote branches found by a text (`orca_remote_branches`, `repo.searchRefs` with `namespace` `remote`) are read here too, for the branch button of the file pane.
//! The branch of a worktree is switched here too (`orca_switch_branch`, `git.switchBranch`): a local or a remote branch, never a new one, and Orca's refusal is shown in its own words.
//! The commits of a worktree (`orca_git_history`, `git.history`: HEAD first, the newest first, read `limit` at a time with `skip`, on the history that the token of the first answer pins) and the files a commit changed (`orca_commit_files`, `git.commitCompare`) are read here too, for the history of the file pane. Both only read; a subject, an author and a path are held in memory only and are in no log line. They were tried on this machine's Orca 1.4.258 over its unix socket (a saved environment was not tried).
//! The difference of one file of a commit (`orca_commit_file_diff`, `git.commitDiff`: the text at the first parent and at the commit, in the shape of `git.diff`) is drawn as A-24's diff is (`parse_diff`). The text is held in memory only and is in no log line.
//! A new file or folder is made in a folder of the tree (`orca_file_create`, `files.createFile` and `files.createDir`): Rust checks that the name is one name, and a name that is taken is refused (`files.createFile` never overwrites). They were read in the `app.asar` of Orca 1.4.258 and never run on a real Orca.
//! A file, or a folder with what is in it, is deleted for good (`orca_file_delete`, `files.delete`, which skips the Trash and makes a path that is not there no error): Rust refuses the root of the worktree and a path that is not inside it. It was read in the `app.asar` of Orca 1.4.258 and never run on a real Orca.
//! A file or a folder is moved or renamed inside the worktree (`orca_file_move`, `files.rename`, which does not overwrite: a target that is there is refused): Rust refuses the root, a path that is not inside the worktree, a target that is the source and a target inside the source. `files.rename` makes no folder, so when it answers `ENOENT` and the source is there (`files.stat`) the missing folders of the target are made one by one (`files.createDir`, which makes one level) and the rename is tried once more. A change of the case of the name alone goes through a temporary name in the same folder (two `files.rename`), because a disk that ignores case would have Orca refuse the target as taken. It was read in the `app.asar` of Orca 1.4.258 and never run on a real Orca.
//! The scratchpad of A-29 is a file in `.orca/scratchpad` of a worktree (`orca_scratchpad_create`): the same `files.createFile`, and a name that is taken is answered as the existing file, not as a failure.
//! A file is also copied to this PC (`download`): `files.stat` gives its size, then `files.readChunk` is called until `eof` (and never past the size), or `files.readPreview` once on a host that lacks either, and the bytes go to a temporary file beside the destination, which is moved onto it when all have come. It was tried on Orca 1.4.254 on this machine (a chunk may be at most 512 KiB). The same read (`fetch_into`) gives the bytes to the preview server of A-31 (`orca_preview.rs`), through a `Sink`.

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
    accounts::write_atomic,
    auth::config_dir,
    orca::{forget_worktree_host, worktree_host, worktree_host_cached},
    orca_attach::{worktree_params, Rpc},
    orca_diff::{diff_rows, lines_of, OrcaDiffChange, OrcaDiffRow},
    orca_language::{detect_language, highlight_name},
    orca_link::{CallError, Connection},
};

const SETTINGS_FILE: &str = "editor-settings.json";
/// The time of the automatic save: the range, the step and the first value, in milliseconds.
const AUTOSAVE_MIN: u32 = 100;
const AUTOSAVE_MAX: u32 = 3000;
const AUTOSAVE_STEP: u32 = 100;
const AUTOSAVE_DEFAULT: u32 = 1000;
/// The most entries one `files.readDir` answers (Orca's page limit).
pub(crate) const LIST_LIMIT: usize = 5000;
/// The most paths one `git.checkIgnored` takes. `orca_files_ignored` takes as many as one list holds (`LIST_LIMIT`) and sends them in chunks of this size.
const IGNORE_CHUNK: usize = 2000;
/// The most bytes of a file the editor opens or saves. Orca reads 512 KiB at most, and a larger frame closes the WebSocket of a paired server (it takes 1 MiB), so a text is kept well under both.
pub(crate) const MAX_TEXT: usize = 384 * 1024;
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
const DIFF_TOO_LARGE: &str = "差分が大きすぎて表示できません";
/// The folder of the scratchpad files (A-29), from the worktree.
const SCRATCHPAD_DIR: &str = ".orca/scratchpad";
pub(crate) const BAD_NAME: &str = "名前が正しくありません";
pub(crate) const NAME_TAKEN: &str = "同じ名前があります";
pub(crate) const NOT_CREATED: &str = "作成できませんでした";
pub(crate) const NOT_DELETED: &str = "削除できませんでした";
pub(crate) const NOT_MOVED: &str = "移動できませんでした";
pub(crate) const SAME_PLACE: &str = "移動先が元の場所と同じです";
const INTO_ITSELF: &str = "フォルダーを自分の中には移動できません";
pub(crate) const NOT_FOUND: &str = "ファイルが見つかりません";
pub(crate) const NOT_UTF8: &str = "UTF-8 ではないファイルは開けません";
const NOT_LISTED: &str = "ファイルの一覧を読めません";
const NOT_BRANCHES: &str = "ブランチの一覧を読めません";
const NOT_SWITCHED: &str = "ブランチを切り替えた結果を読めません";
const UPDATE_ORCA: &str =
    "この Orca は、ブランチの切り替えに対応していません。Orca を更新してください";
const NOT_HISTORY: &str = "コミットの一覧を読めません";
const NOT_COMMIT_FILES: &str = "コミットの変更ファイルを読めません";
/// The most commits one `git.history` answers (Orca refuses a `limit` above it).
const HISTORY_MAX: u32 = 200;
/// The most files of one commit that are returned (a page of `files.readDir` holds as many); `OrcaCommitFiles::total` says how many the commit changed.
const COMMIT_FILES_MAX: usize = LIST_LIMIT;
/// The most remote branches one search asks for (the number of Orca's own branch picker).
const BRANCH_LIMIT: u32 = 50;
/// The longest text of a search, in bytes (Orca's limit for a search text).
const MAX_QUERY: usize = 2048;
/// The longest repository id, in bytes.
const MAX_REPO: usize = 256;

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

/// The difference of a file from HEAD for the diff tab (A-24): the lines of HEAD and of the working tree (LF, no line end; the rows hold the numbers of the lines), the rows of the side by side view and of the inline view, the blocks of changes, and the language of the file as `OrcaFileText` has it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaFileDiff {
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub side: Vec<OrcaDiffRow>,
    pub inline: Vec<OrcaDiffRow>,
    pub changes: Vec<OrcaDiffChange>,
    pub language: String,
    pub highlight: Option<String>,
}

/// A local branch of a worktree: `current` is the one checked out in it, and `in_use` is whether another worktree has it checked out (git cannot switch to it).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaLocalBranch {
    pub name: String,
    pub current: bool,
    pub in_use: bool,
}

/// A remote branch found by a search: `name` is as Orca names it (`origin/feature/a`, the name a switch asks for), and `local_name` the local branch it would be (`feature/a`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaRemoteBranch {
    pub name: String,
    pub local_name: String,
}

/// A switch that landed: the branch the worktree is on now, and Orca's `warning` when the switch worked but a step after it did not (a hook that failed, a file another program holds open).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaBranchSwitched {
    pub branch: String,
    pub warning: Option<String>,
}

/// A commit of the history: the full id and the short one, the first line of the message, the author's name, the time of the commit in milliseconds since the epoch, and the ids of its parents (the first one is the side a merge is read against).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaCommit {
    pub id: String,
    pub short_id: String,
    pub subject: String,
    pub author: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub time_ms: i64,
    pub parents: Vec<String>,
}

/// A page of the history, and whether more commits follow it (`skip` by the number read so far reads them). `history_token` is Orca's handle of the history the first page began: given back with the next read, it keeps the read on that history whatever HEAD does after it. `history_changed` is true when Orca no longer holds that history, and the page then has no commit.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaCommitList {
    pub commits: Vec<OrcaCommit>,
    pub has_more: bool,
    pub history_token: Option<String>,
    pub history_changed: bool,
}

/// How a commit changed a file (Orca's names; a type change is `modified`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "kebab-case")]
pub enum OrcaCommitFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
}

/// A file a commit changed: `old_path` is where a renamed or copied file came from, and the numbers of lines added and removed are none for a binary file.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaCommitFile {
    pub status: OrcaCommitFileStatus,
    pub path: String,
    pub old_path: Option<String>,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// The files a commit changed against its first parent (`parent_id`, none for the first commit of the history), at most `COMMIT_FILES_MAX` of them; `total` is how many it changed.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaCommitFiles {
    pub files: Vec<OrcaCommitFile>,
    pub total: u32,
    pub parent_id: Option<String>,
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

/// The answer to the making of a scratchpad file (A-29): its path from the worktree, and whether the file was there already (nothing was written then).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaScratchpad {
    pub relative: String,
    pub existed: bool,
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
    /// The least time `autosave_ms` can be, in milliseconds.
    pub autosave_min: u32,
    /// The greatest time `autosave_ms` can be, in milliseconds.
    pub autosave_max: u32,
    /// The step of `autosave_ms`, in milliseconds.
    pub autosave_step: u32,
}

/// What `editor-settings.json` holds.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    autosave_ms: u32,
}

// ---- paths ----

/// A path relative to the worktree that Orca may be asked for: no blank (`allow_empty` lets the worktree's own folder through), no control character, nothing absolute, no `.` or `..` element and no empty one.
pub(crate) fn check_relative(relative: &str, allow_empty: bool) -> Result<(), String> {
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

/// A path that names what is deleted, moved or made in: `check_relative`, and no `\` either. A worktree on Windows has Orca turn `\` into `/`, so a path of `\` alone would be the root of the worktree; a read keeps `\`, which a name on other disks may hold.
fn check_written(relative: &str, allow_empty: bool) -> Result<(), String> {
    check_relative(relative, allow_empty)?;
    if relative.contains('\\') {
        return Err("ファイルの場所が正しくありません".into());
    }
    Ok(())
}

/// The path of the entry `name` in the folder `dir` (both relative to the worktree; the worktree's own folder is the empty one).
fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// The name of a new file or folder: one name, trimmed, that is not empty, `.` or `..`, holds no `/`, `\` or control character, and is at most 255 bytes.
pub(crate) fn check_new_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > MAX_NAME
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control);
    if bad {
        Err(BAD_NAME.into())
    } else {
        Ok(name)
    }
}

/// The path from the worktree of the new entry `name` in the folder `dir` (the worktree's own folder is the empty one), when both are fit to ask Orca for.
fn new_relative(dir: &str, name: &str) -> Result<String, String> {
    check_written(dir, true)?;
    let relative = join(dir, check_new_name(name)?);
    check_relative(&relative, false)?;
    Ok(relative)
}

/// The source and the target of a move (both relative to the worktree): each is a path inside the worktree and not its root, the source holds no `\` (`check_written`), no part of the target holds a `\` or is over 255 bytes, the target is not the source, and it is not inside the source (a folder cannot go into itself).
fn check_move(from: &str, to: &str) -> Result<(), String> {
    check_written(from, false)?;
    check_relative(to, false)?;
    if to
        .split('/')
        .any(|part| part.len() > MAX_NAME || part.contains('\\'))
    {
        return Err(BAD_NAME.into());
    }
    if to == from {
        return Err(SAME_PLACE.into());
    }
    if to
        .strip_prefix(from)
        .is_some_and(|rest| rest.starts_with('/'))
    {
        return Err(INTO_ITSELF.into());
    }
    Ok(())
}

// ---- the list ----

/// The order of Orca's file list: a number inside a name counts by its value (`2` before `10`), other characters by their lower case, and a tie by the plain order of the names.
pub(crate) fn natural_cmp(a: &str, b: &str) -> Ordering {
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
pub(crate) fn parse_dir(result: &Value, dir: &str) -> Result<(Vec<OrcaFileEntry>, u32), String> {
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

/// The paths of `paths` that git ignores, in the order they were asked in. A failed check (a folder that is no repository) marks nothing: the list is still the list. Only a path that was asked for can be answered.
async fn ignored_in(rpc: &mut impl Rpc, path: &str, paths: &[String]) -> Vec<String> {
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
    paths
        .iter()
        .filter(|p| ignored.contains(p.as_str()))
        .cloned()
        .collect()
}

/// The paths `orca_files_ignored` is asked about: as many as a list holds at most, each a path inside the worktree (the checks of a file's path).
fn check_ignore_paths(paths: &[String]) -> Result<(), String> {
    if paths.len() > LIST_LIMIT {
        return Err(format!("一度に調べられるのは {LIST_LIMIT} 件までです"));
    }
    paths.iter().try_for_each(|p| check_relative(p, false))
}

/// The message of a failed read of the files.
fn reason(error: CallError) -> String {
    if error.detail.starts_with("ENOENT") {
        NOT_FOUND.into()
    } else if error.detail == "binary_file" {
        "バイナリのファイルは開けません".into()
    } else if error.detail == "diff_too_large" {
        DIFF_TOO_LARGE.into()
    } else if error.detail == "invalid_relative_path" {
        "ファイルの場所が正しくありません".into()
    } else {
        error.shown
    }
}

/// The entries of `dir`, from `files.readDir` alone. `ignored` is whether git ignores the folder `dir` itself: what it holds is then ignored too, and every entry is marked so. Otherwise no entry is marked, and `orca_files_ignored` is asked after it.
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

/// The refusal of a file that is larger than the editor takes.
pub(crate) fn too_large() -> String {
    format!("{} KiB を超えるファイルは開けません", MAX_TEXT / 1024)
}

/// The text the editor gets from an answer of `files.read`: Orca's reply must be the whole file, as text, in the size the editor takes.
fn parse_text(result: &Value, relative: &str) -> Result<OrcaFileText, String> {
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
        return Err(NOT_UTF8.into());
    }
    editor_text(content, relative, disk_signature(content))
}

/// The text of the file `relative` for the editor, from the text the disk holds (`content`, with one kind of line end) and the signature of it.
pub(crate) fn editor_text(
    content: &str,
    relative: &str,
    signature: String,
) -> Result<OrcaFileText, String> {
    let crlf = line_ending(content)?;
    let language = detect_language(relative, content);
    Ok(OrcaFileText {
        content: if crlf {
            content.replace("\r\n", "\n")
        } else {
            content.to_owned()
        },
        crlf,
        signature,
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

// ---- the diff ----

/// The diff tab's data from an answer of `git.diff`: the text at HEAD against the text in the working tree. An answer for a binary file, one Orca marks as too large to draw, a side the editor would not take (over `MAX_TEXT`) or a side that is not UTF-8 is refused with the reason, and no text is returned. A file that is not in the working tree any more (`modifiedDeleted`) is its HEAD text against nothing, and one that git does not know has no text at HEAD.
fn parse_diff(result: &Value, relative: &str) -> Result<OrcaFileDiff, String> {
    let marked = |key: &str| !matches!(result[key], Value::Null | Value::Bool(false));
    if result["kind"] == "binary"
        || marked("originalIsBinary")
        || marked("modifiedIsBinary")
        || marked("isImage")
    {
        return Err("バイナリのファイルの差分は表示できません".into());
    }
    if marked("tooLarge") || marked("largeDiffRenderLimit") {
        return Err(DIFF_TOO_LARGE.into());
    }
    let deleted = result["modifiedDeleted"] == true;
    let old = result["originalContent"]
        .as_str()
        .ok_or("差分を読めません")?;
    let new = match result["modifiedContent"].as_str() {
        Some(new) => new,
        None if deleted => "",
        None => return Err("差分を読めません".into()),
    };
    if old.len() > MAX_TEXT || new.len() > MAX_TEXT {
        return Err(format!(
            "{} KiB を超えるファイルの差分は表示できません",
            MAX_TEXT / 1024
        ));
    }
    // Orca decodes bytes that are not UTF-8 into U+FFFD.
    if old.contains('\u{FFFD}') || new.contains('\u{FFFD}') {
        return Err("UTF-8 ではないファイルの差分は表示できません".into());
    }
    let (old_lines, new_lines) = (lines_of(old), lines_of(new));
    let rows = diff_rows(&old_lines, &new_lines);
    let language = detect_language(relative, if new.is_empty() { old } else { new });
    let texts = |lines: Vec<(String, bool)>| lines.into_iter().map(|(text, _)| text).collect();
    Ok(OrcaFileDiff {
        old_lines: texts(old_lines),
        new_lines: texts(new_lines),
        side: rows.side,
        inline: rows.inline,
        changes: rows.changes,
        language: language.to_owned(),
        highlight: highlight_name(language).map(str::to_owned),
    })
}

/// Asks Orca for the file's text at HEAD and in the working tree.
async fn git_diff(rpc: &mut impl Rpc, path: &str, relative: &str) -> Result<Value, String> {
    rpc.call(
        "git.diff",
        worktree_params(
            path,
            None,
            json!({"filePath": relative, "staged": false, "compareAgainstHead": true}),
        ),
    )
    .await
    .map_err(reason)
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
pub(crate) fn disk_text(content: &str, crlf: bool) -> String {
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

// ---- the new file or folder ----

/// The message of a failed create: a name that is taken (`EEXIST` of a file, "already exists" of a folder) is said so, anything else as a failed read is.
fn create_reason(error: CallError) -> String {
    if taken(&error) {
        NAME_TAKEN.into()
    } else {
        reason(error)
    }
}

/// Makes the file or folder `relative` (checked by `new_relative`) with `files.createFile` or `files.createDir`, and answers its path. Orca makes the missing folders of a file, never overwrites one, and answers `{ok: true}`.
async fn create(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    relative: &str,
    folder: bool,
) -> Result<String, String> {
    let method = if folder {
        "files.createDir"
    } else {
        "files.createFile"
    };
    let answer = rpc
        .call(
            method,
            worktree_params(path, Some(host_id), json!({"relativePath": relative})),
        )
        .await
        .map_err(create_reason)?;
    if answer["ok"] == false {
        return Err(NOT_CREATED.into());
    }
    Ok(relative.to_owned())
}

/// Deletes the file or, with `folder`, the folder and everything in it, `relative` (checked by `check_written`, never empty) with `files.delete`: `recursive` is the folder's alone. Orca deletes for good, and a path that is not there is no error.
async fn delete(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    relative: &str,
    folder: bool,
) -> Result<(), String> {
    let answer = rpc
        .call(
            "files.delete",
            worktree_params(
                path,
                Some(host_id),
                json!({"relativePath": relative, "recursive": folder}),
            ),
        )
        .await
        .map_err(reason)?;
    if answer["ok"] == false {
        return Err(NOT_DELETED.into());
    }
    Ok(())
}

// ---- the move ----

/// Whether a failed call says that a name is taken (`EEXIST`, or Orca's own "already exists").
fn taken(error: &CallError) -> bool {
    let detail = error.detail.to_lowercase();
    detail.contains("eexist") || detail.contains("already exists")
}

/// One `files.rename` of `from` to `to`.
async fn rename(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    from: &str,
    to: &str,
) -> Result<(), CallError> {
    let answer = rpc
        .call(
            "files.rename",
            worktree_params(
                path,
                Some(host_id),
                json!({"oldRelativePath": from, "newRelativePath": to}),
            ),
        )
        .await?;
    if answer["ok"] == false {
        return Err(CallError {
            shown: NOT_MOVED.into(),
            detail: String::new(),
        });
    }
    Ok(())
}

/// Makes the folders on the way to `to` that are missing, from the worktree down, one `files.createDir` for each (it makes one level and refuses a name that is there, which is no failure here). Answers whether one was made.
async fn make_parents(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    to: &str,
) -> Result<bool, String> {
    let mut made = false;
    for (at, _) in to.match_indices('/') {
        let made_now = rpc
            .call(
                "files.createDir",
                worktree_params(path, Some(host_id), json!({"relativePath": &to[..at]})),
            )
            .await;
        match made_now {
            Ok(_) => made = true,
            Err(error) if taken(&error) => {}
            Err(error) => return Err(reason(error)),
        }
    }
    Ok(made)
}

/// The message of a failed rename: `ENOENT` is the source that is gone, anything else as a failed create is.
fn rename_reason(error: CallError) -> String {
    if error.detail.contains("ENOENT") {
        NOT_FOUND.into()
    } else {
        create_reason(error)
    }
}

/// Whether `to` is `from` with only the case of its name changed, in the same folder (`a.md` to `A.md`).
fn case_only(from: &str, to: &str) -> bool {
    let (from_dir, from_name) = from.rsplit_once('/').unwrap_or(("", from));
    let (to_dir, to_name) = to.rsplit_once('/').unwrap_or(("", to));
    from_dir == to_dir && from_name != to_name && from_name.to_lowercase() == to_name.to_lowercase()
}

/// A rename that changes only the case of the name. On a disk that ignores case Orca finds the target there (it is the source) and refuses it as taken, so the entry goes through a name of its own in the same folder: two `files.rename`. When the second fails, the entry is given its name back (a failure of that is not said: the reason of the second is).
async fn rename_case(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random).map_err(|_| "乱数を作れません".to_owned())?;
    let unique: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let dir = from.rsplit_once('/').map_or("", |(dir, _)| dir);
    let temp = join(dir, &format!(".cookapps-rename-{unique}"));
    rename(rpc, path, host_id, from, &temp)
        .await
        .map_err(rename_reason)?;
    if let Err(error) = rename(rpc, path, host_id, &temp, to).await {
        let _ = rename(rpc, path, host_id, &temp, from).await;
        return Err(rename_reason(error));
    }
    Ok(())
}

/// Moves `from` to `to` (both checked by `check_move`) with `files.rename`, which never overwrites: a target that is there is said so. A change of the case of the name alone is `rename_case`. Orca's rename makes no folder, so on `ENOENT` the source is looked for (`files.stat`): when it is gone that is said and nothing is made; else the missing folders of the target are made and the rename is tried once more; when none was missing nothing is tried again. A `files.stat` that fails any other way does not stop the move.
async fn move_entry(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    if case_only(from, to) {
        return rename_case(rpc, path, host_id, from, to).await;
    }
    let error = match rename(rpc, path, host_id, from, to).await {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    if !error.detail.contains("ENOENT") {
        return Err(create_reason(error));
    }
    let source = rpc
        .call(
            "files.stat",
            worktree_params(path, None, json!({"relativePath": from})),
        )
        .await;
    if source.is_err_and(|error| error.detail.contains("ENOENT")) {
        return Err(NOT_FOUND.into());
    }
    if !make_parents(rpc, path, host_id, to).await? {
        return Err(NOT_FOUND.into());
    }
    rename(rpc, path, host_id, from, to)
        .await
        .map_err(rename_reason)
}

/// Makes the scratchpad file `name` in `.orca/scratchpad` (Orca makes the folder when it is missing). A name that is taken is no failure: the file is the existing one, and `existed` says so.
async fn create_scratchpad(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    name: &str,
) -> Result<OrcaScratchpad, String> {
    let relative = new_relative(SCRATCHPAD_DIR, name)?;
    match create(rpc, path, host_id, &relative, false).await {
        Ok(relative) => Ok(OrcaScratchpad {
            relative,
            existed: false,
        }),
        Err(reason) if reason == NAME_TAKEN => Ok(OrcaScratchpad {
            relative,
            existed: true,
        }),
        Err(reason) => Err(reason),
    }
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

/// Where the bytes of a file that is read go, in the order they are read: the temporary file of a download, or the answer of the preview server (A-31). `total` is how many bytes the whole file has, as far as the read knows (the size `files.stat` gave, or the length of a preview).
pub(crate) trait Sink {
    async fn put(&mut self, bytes: Vec<u8>, total: u64) -> Result<(), String>;
}

impl Sink for Out {
    async fn put(&mut self, bytes: Vec<u8>, _total: u64) -> Result<(), String> {
        let out = Arc::clone(self);
        on_disk(move || {
            out.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .write_all(&bytes)
                .map_err(|e| write_error(&e))
        })
        .await
    }
}

/// The whole file by one `files.readPreview`, written to `out`. Answers the size.
async fn fetch_preview(
    rpc: &mut impl Rpc,
    path: &str,
    relative: &str,
    size: Option<u64>,
    out: &mut impl Sink,
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
    out.put(bytes, length).await?;
    Ok(length)
}

/// The size of the file `relative` of the worktree at `path`, by `files.stat`; `None` on a host that lacks `files.stat`.
pub(crate) async fn stat_size(
    rpc: &mut impl Rpc,
    path: &str,
    relative: &str,
) -> Result<Option<u64>, String> {
    match rpc
        .call(
            "files.stat",
            worktree_params(path, None, json!({"relativePath": relative})),
        )
        .await
    {
        Ok(answer) => Ok(Some(answer["size"].as_u64().ok_or("ファイルを読めません")?)),
        Err(e) if e.shown.contains("method_not_found") => Ok(None),
        Err(e) => Err(reason(e)),
    }
}

/// Reads the file `relative` of the worktree at `path` and writes it to `out`. `files.stat` gives the size first, and the reading stops with an error when Orca sends more than that, so an Orca that never says `eof` cannot fill the disk. Then `files.readChunk` is called, `CHUNK` bytes at a time until `eof`. A host that lacks `files.stat`, or answers `method_not_found` to the first `files.readChunk`, has the file read whole with `files.readPreview` (a host that lacks `files.stat` has no size to hold the preview to). Answers the size.
pub(crate) async fn fetch_into(
    rpc: &mut impl Rpc,
    path: &str,
    relative: &str,
    out: &mut impl Sink,
) -> Result<u64, String> {
    let Some(size) = stat_size(rpc, path, relative).await? else {
        return fetch_preview(rpc, path, relative, None, out).await;
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
        out.put(bytes, size).await?;
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
    let done = match fetch_into(rpc, path, relative, &mut Arc::clone(&out)).await {
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

// ---- the branches ----

/// The local branches of an answer of `git.localBranches` (`{current, branches, committedAt, worktreePaths}`) for the worktree at `path`: the current one first, then the newest commit first. `worktreePaths` names the worktree that has a branch checked out; one other than `path` makes the branch `in_use`.
fn parse_local_branches(result: &Value, path: &str) -> Result<Vec<OrcaLocalBranch>, String> {
    let list = result["branches"].as_array().ok_or(NOT_BRANCHES)?;
    let here = path.trim_end_matches('/');
    let mut branches: Vec<(OrcaLocalBranch, i64)> = list
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(|name| {
            let in_use = result["worktreePaths"][name]
                .as_str()
                .is_some_and(|other| other.trim_end_matches('/') != here);
            let branch = OrcaLocalBranch {
                name: name.to_owned(),
                current: result["current"] == name,
                in_use,
            };
            (branch, result["committedAt"][name].as_i64().unwrap_or(0))
        })
        .collect();
    branches.sort_by_key(|(branch, committed)| (!branch.current, std::cmp::Reverse(*committed)));
    Ok(branches.into_iter().map(|(branch, _)| branch).collect())
}

async fn local_branches(rpc: &mut impl Rpc, path: &str) -> Result<Vec<OrcaLocalBranch>, String> {
    let answer = rpc
        .call("git.localBranches", worktree_params(path, None, json!({})))
        .await
        .map_err(branch_reason)?;
    parse_local_branches(&answer, path)
}

/// The local branch a remote one would be when Orca does not say (an old Orca): without the remote's name, as Orca's own client guesses for `origin/` and `upstream/`.
fn legacy_local_name(name: &str) -> &str {
    ["origin/", "upstream/"]
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix).filter(|rest| !rest.is_empty()))
        .unwrap_or(name)
}

/// The remote branches of an answer of `repo.searchRefs` (`{refDetails: [{refName, localBranchName}], refs}`; an old Orca has `refs` alone). A name is `refName` without a leading `refs/remotes/`, and a local branch (`refs/heads/`) or a nameless entry is left out.
fn parse_remote_branches(result: &Value) -> Result<Vec<OrcaRemoteBranch>, String> {
    let branch = |ref_name: &str, local: Option<&str>| {
        if ref_name.is_empty() || ref_name.starts_with("refs/heads/") {
            return None;
        }
        let name = ref_name.strip_prefix("refs/remotes/").unwrap_or(ref_name);
        let local_name = local
            .filter(|local| !local.is_empty())
            .unwrap_or_else(|| legacy_local_name(name));
        Some(OrcaRemoteBranch {
            name: name.to_owned(),
            local_name: local_name.to_owned(),
        })
    };
    if let Some(details) = result["refDetails"].as_array() {
        Ok(details
            .iter()
            .filter_map(|d| branch(d["refName"].as_str()?, d["localBranchName"].as_str()))
            .collect())
    } else if let Some(refs) = result["refs"].as_array() {
        Ok(refs
            .iter()
            .filter_map(|r| branch(r.as_str()?, None))
            .collect())
    } else {
        Err(NOT_BRANCHES.into())
    }
}

/// The arguments of `repo.searchRefs`: the repository by its id (`id:`, so that a name or a path never matches), the text, and the remote branches only.
fn remote_params(repo: &str, query: &str) -> Value {
    json!({"repo": format!("id:{repo}"), "query": query, "limit": BRANCH_LIMIT, "namespace": "remote"})
}

async fn remote_branches(
    rpc: &mut impl Rpc,
    repo: &str,
    query: &str,
) -> Result<Vec<OrcaRemoteBranch>, String> {
    let answer = rpc
        .call("repo.searchRefs", remote_params(repo, query))
        .await
        .map_err(branch_reason)?;
    parse_remote_branches(&answer)
}

/// The id of a repository (`OrcaProject::key`) that Orca may be asked for: not blank, not an SSH host's (`ssh:`), no control character, and not longer than `MAX_REPO`.
fn check_repo(repo: &str) -> Result<(), String> {
    if repo.is_empty()
        || repo.len() > MAX_REPO
        || repo.starts_with("ssh:")
        || repo.chars().any(char::is_control)
    {
        Err("プロジェクトが正しくありません".into())
    } else {
        Ok(())
    }
}

/// The text of a search: at most `MAX_QUERY` bytes and no control character (blank is allowed and finds the first branches).
fn check_query(query: &str) -> Result<(), String> {
    if query.len() > MAX_QUERY || query.chars().any(char::is_control) {
        Err("検索する文字が正しくありません".into())
    } else {
        Ok(())
    }
}

/// The message of a failed read of the branches: a worktree or a repository Orca does not know says so, any other failure is `reason`'s.
fn branch_reason(error: CallError) -> String {
    match error.detail.as_str() {
        "selector_not_found" => "worktree が見つかりません".into(),
        "repo_not_found" => "プロジェクトが見つかりません".into(),
        _ => reason(error),
    }
}

/// What a switch asks for: `kind` is `local` or `remote` (never `new`, which makes a branch), and the name, trimmed, is not empty, does not start with `-` (git would read it as an option) and has no control character.
fn check_switch(kind: &str, name: &str) -> Result<(&'static str, String), String> {
    let kind = match kind {
        "local" => "local",
        "remote" => "remote",
        _ => return Err("ブランチの種類が正しくありません".into()),
    };
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || name.chars().any(char::is_control) {
        return Err("ブランチの名前が正しくありません".into());
    }
    Ok((kind, name.to_owned()))
}

/// An answer of `git.switchBranch` (`{ok, branch, head}`, with `warning` when the switch worked but a later step failed).
fn parse_switched(result: &Value) -> Result<OrcaBranchSwitched, String> {
    let branch = result["branch"]
        .as_str()
        .filter(|branch| !branch.is_empty())
        .ok_or(NOT_SWITCHED)?;
    Ok(OrcaBranchSwitched {
        branch: branch.to_owned(),
        warning: result["warning"]
            .as_str()
            .filter(|warning| !warning.is_empty())
            .map(str::to_owned),
    })
}

/// The message of a refused switch: Orca's own words (it refuses with the reason: changes not committed, a merge in progress, an agent at work), or, for an Orca that lacks the method, the request to update it. A failure with no message of Orca's (the connection) keeps its own text.
fn switch_reason(error: CallError) -> String {
    if error.shown.contains("method_not_found") {
        UPDATE_ORCA.into()
    } else if error.detail.trim().is_empty() {
        error.shown
    } else {
        error.detail
    }
}

/// Switches the worktree at `path` (on `host_id`) to the branch `name` of `kind` (`local`, or `remote` for a name like `origin/a`). `git.switchBranch` refuses when the checkout is not clean, so nothing is lost by a switch.
async fn switch_branch(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    kind: &str,
    name: &str,
) -> Result<OrcaBranchSwitched, String> {
    let answer = rpc
        .call(
            "git.switchBranch",
            worktree_params(
                path,
                Some(host_id),
                json!({"target": {"kind": kind, "name": name}}),
            ),
        )
        .await
        .map_err(switch_reason)?;
    parse_switched(&answer)
}

// ---- the history ----

/// A full git object id (40 hex digits, or 64 for SHA-256), the form Orca takes and no other.
fn is_object_id(id: &str) -> bool {
    matches!(id.len(), 40 | 64) && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The range of one read of the history: `limit` from 1 to `HISTORY_MAX`.
fn check_history_limit(limit: u32) -> Result<(), String> {
    if (1..=HISTORY_MAX).contains(&limit) {
        Ok(())
    } else {
        Err("コミットの数が正しくありません".into())
    }
}

/// The token of a history as Orca takes it (a string of at most 100 characters). Orca makes it a UUID; a plain word is all the app lets through.
fn check_history_token(token: &str) -> Result<(), String> {
    if !token.is_empty()
        && token.len() <= 100
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(())
    } else {
        Err("履歴の印が正しくありません".into())
    }
}

/// The arguments of `git.history`: the commits reachable from HEAD, `limit` of them after the first `skip`; with `history_token`, the commits of the history that token stands for (the one HEAD was at when the first page was read).
fn history_params(limit: u32, skip: u32, history_token: Option<&str>) -> Value {
    let mut params = json!({"refs": "head", "limit": limit, "skip": skip});
    if let Some(token) = history_token {
        params["historyToken"] = json!(token);
    }
    params
}

/// The commits of an answer of `git.history` (`{items: [{id, displayId, subject, message, author, timestamp, parentIds}], hasMore, historyToken, historyChanged, ...}`). An item with no full id cannot be told from another, and a page with one is refused as a whole, so that `skip` by the number read never lands in the wrong place.
fn parse_history(result: &Value) -> Result<OrcaCommitList, String> {
    let items = result["items"].as_array().ok_or(NOT_HISTORY)?;
    let commits = items
        .iter()
        .map(|item| {
            let id = item["id"]
                .as_str()
                .filter(|id| is_object_id(id))
                .ok_or(NOT_HISTORY)?;
            let subject = item["subject"]
                .as_str()
                .or_else(|| item["message"].as_str().and_then(|m| m.lines().next()))
                .unwrap_or_default();
            let short_id = item["displayId"]
                .as_str()
                .filter(|short| !short.is_empty())
                .unwrap_or(&id[..7]);
            Ok(OrcaCommit {
                id: id.to_owned(),
                short_id: short_id.to_owned(),
                subject: subject.to_owned(),
                author: item["author"].as_str().unwrap_or_default().to_owned(),
                time_ms: item["timestamp"].as_i64().unwrap_or(0),
                parents: item["parentIds"]
                    .as_array()
                    .map(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .filter(|id| is_object_id(id))
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(OrcaCommitList {
        has_more: result["hasMore"] == true && !commits.is_empty(),
        commits,
        history_token: result["historyToken"]
            .as_str()
            .filter(|token| check_history_token(token).is_ok())
            .map(str::to_owned),
        history_changed: result["historyChanged"] == true,
    })
}

async fn git_history(
    rpc: &mut impl Rpc,
    path: &str,
    limit: u32,
    skip: u32,
    history_token: Option<&str>,
) -> Result<OrcaCommitList, String> {
    let answer = rpc
        .call(
            "git.history",
            worktree_params(path, None, history_params(limit, skip, history_token)),
        )
        .await
        .map_err(branch_reason)?;
    parse_history(&answer)
}

fn commit_file_status(status: &str) -> OrcaCommitFileStatus {
    match status {
        "added" => OrcaCommitFileStatus::Added,
        "deleted" => OrcaCommitFileStatus::Deleted,
        "renamed" => OrcaCommitFileStatus::Renamed,
        "copied" => OrcaCommitFileStatus::Copied,
        _ => OrcaCommitFileStatus::Modified,
    }
}

/// The files of an answer of `git.commitCompare` (`{summary: {status, parentOid, changedFiles, errorMessage}, entries: [{path, status, oldPath, added, removed}]}`). A summary that is not `ready` is a commit Orca could not read; an entry with no path is refused.
fn parse_commit_files(result: &Value) -> Result<OrcaCommitFiles, String> {
    match result["summary"]["status"].as_str() {
        Some("ready") => {}
        Some("invalid-commit") => return Err("コミットが見つかりません".into()),
        _ => return Err(NOT_COMMIT_FILES.into()),
    }
    let entries = result["entries"].as_array().ok_or(NOT_COMMIT_FILES)?;
    let count = |entry: &Value, key: &str| entry[key].as_u64().and_then(|n| u32::try_from(n).ok());
    let files = entries
        .iter()
        .take(COMMIT_FILES_MAX)
        .map(|entry| {
            let path = entry["path"]
                .as_str()
                .filter(|path| !path.is_empty())
                .ok_or(NOT_COMMIT_FILES)?;
            Ok(OrcaCommitFile {
                status: commit_file_status(entry["status"].as_str().unwrap_or_default()),
                path: path.to_owned(),
                old_path: entry["oldPath"]
                    .as_str()
                    .filter(|old| !old.is_empty())
                    .map(str::to_owned),
                added: count(entry, "added"),
                removed: count(entry, "removed"),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let total = u32::try_from(entries.len()).unwrap_or(u32::MAX);
    Ok(OrcaCommitFiles {
        total: result["summary"]["changedFiles"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .map_or(total, |n| n.max(total)),
        parent_id: result["summary"]["parentOid"]
            .as_str()
            .filter(|id| is_object_id(id))
            .map(str::to_owned),
        files,
    })
}

async fn commit_files(
    rpc: &mut impl Rpc,
    path: &str,
    commit_id: &str,
) -> Result<OrcaCommitFiles, String> {
    let answer = rpc
        .call(
            "git.commitCompare",
            worktree_params(path, None, json!({"commitId": commit_id})),
        )
        .await
        .map_err(branch_reason)?;
    parse_commit_files(&answer)
}

/// Asks Orca for one file of a commit: its text at the first parent (`parent_id`; none for the first commit, which is compared with nothing) and at the commit. `old_relative` is the path the file had at the parent, for a file that was renamed.
async fn commit_diff(
    rpc: &mut impl Rpc,
    path: &str,
    commit_id: &str,
    parent_id: Option<&str>,
    relative: &str,
    old_relative: Option<&str>,
) -> Result<Value, String> {
    let mut params = json!({"commitOid": commit_id, "filePath": relative});
    if let Some(parent_id) = parent_id {
        params["parentOid"] = json!(parent_id);
    }
    if let Some(old_relative) = old_relative {
        params["oldPath"] = json!(old_relative);
    }
    rpc.call("git.commitDiff", worktree_params(path, None, params))
        .await
        .map_err(branch_reason)
}

/// What `orca_commit_file_diff` is asked for: full ids (the parent only when there is one) and paths inside the worktree.
fn check_commit_diff(
    commit_id: &str,
    parent_id: Option<&str>,
    relative: &str,
    old_relative: Option<&str>,
) -> Result<(), String> {
    if !is_object_id(commit_id) || parent_id.is_some_and(|id| !is_object_id(id)) {
        return Err("コミットの ID が正しくありません".into());
    }
    check_relative(relative, false)?;
    old_relative.map_or(Ok(()), |old| check_relative(old, false))
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

/// The `hostId` of the worktree at `path` (one of the target's list read just now), which a file call is made on. A save and a download ask the target's list each time.
pub(crate) async fn host_of(path: &str, environment: Option<&str>) -> Result<String, String> {
    let (path, environment) = (path.to_owned(), environment.map(str::to_owned));
    let host_id = tokio::task::spawn_blocking(move || worktree_host(&path, environment.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    check_host(&host_id)?;
    Ok(host_id)
}

/// `host_of` for the reads (the list, the ignore marks and the text of a file): the worktree is confirmed against the target's list once, and believed for a while after (`worktree_host_cached`). The path is held to the same checks, and an SSH host is refused the same.
pub(crate) async fn cached_host_of(
    path: &str,
    environment: Option<&str>,
) -> Result<String, String> {
    cached_host_and_project_of(path, environment)
        .await
        .map(|(host_id, _)| host_id)
}

/// `cached_host_of` with the project key (`OrcaProject::key`) of the worktree, as the same confirmation holds it.
async fn cached_host_and_project_of(
    path: &str,
    environment: Option<&str>,
) -> Result<(String, String), String> {
    let (path, environment) = (path.to_owned(), environment.map(str::to_owned));
    let (host_id, project) =
        tokio::task::spawn_blocking(move || worktree_host_cached(&path, environment.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
    check_host(&host_id)?;
    Ok((host_id, project))
}

/// The repository asked for must be the project of the worktree: the remote branches are read from the repository, and a worktree of another project must not stand for it.
fn check_same_repo(project: &str, repo: &str) -> Result<(), String> {
    if project == repo {
        Ok(())
    } else {
        Err("worktree とプロジェクトが合いません。一覧を読み直してください".into())
    }
}

/// A failed call made with a worktree that was believed makes the next call confirm it again.
fn forgetting<T>(
    result: Result<T, String>,
    path: &str,
    environment: Option<&str>,
) -> Result<T, String> {
    if result.is_err() {
        forget_worktree_host(path, environment);
    }
    result
}

/// The entries of the folder `dir` of the worktree at `path` (A-18). The worktree's own folder is the empty `dir`. `ignored` is whether the list marked `dir` as ignored. No entry is marked otherwise: `orca_files_ignored` answers that.
#[tauri::command]
pub async fn orca_files_list(
    path: String,
    dir: String,
    ignored: bool,
    environment: Option<String>,
) -> Result<OrcaDir, String> {
    check_relative(&dir, true)?;
    cached_host_of(&path, environment.as_deref()).await?;
    let read = async {
        let mut connection = Connection::open(environment.clone()).await?;
        list(&mut connection, &path, &dir, ignored).await
    };
    forgetting(read.await, &path, environment.as_deref())
}

/// Which of `paths` (entries of one list, relative to the worktree at `path`) git ignores (A-18). It is asked after the list is drawn. A check that fails answers none; a worktree that is not one of the target's list, and a path that is not inside the worktree, are refused as for the list.
#[tauri::command]
pub async fn orca_files_ignored(
    path: String,
    paths: Vec<String>,
    environment: Option<String>,
) -> Result<Vec<String>, String> {
    check_ignore_paths(&paths)?;
    cached_host_of(&path, environment.as_deref()).await?;
    let opened = Connection::open(environment.clone()).await;
    let mut connection = forgetting(opened, &path, environment.as_deref())?;
    Ok(ignored_in(&mut connection, &path, &paths).await)
}

/// The text of the file `relative` of the worktree at `path`, for the editor (A-18).
#[tauri::command]
pub async fn orca_file_read(
    path: String,
    relative: String,
    environment: Option<String>,
) -> Result<OrcaFileText, String> {
    check_relative(&relative, false)?;
    cached_host_of(&path, environment.as_deref()).await?;
    let opened = async {
        let mut connection = Connection::open(environment.clone()).await?;
        read(&mut connection, &path, &relative).await
    };
    forgetting(opened.await, &path, environment.as_deref())
}

/// The difference of the file `relative` of the worktree at `path` from HEAD, for the diff tab (A-24). The comparison runs off the async threads, because it is work for the processor.
#[tauri::command]
pub async fn orca_file_diff(
    path: String,
    relative: String,
    environment: Option<String>,
) -> Result<OrcaFileDiff, String> {
    check_relative(&relative, false)?;
    cached_host_of(&path, environment.as_deref()).await?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        git_diff(&mut connection, &path, &relative).await
    };
    let answer = forgetting(asked.await, &path, environment.as_deref())?;
    tokio::task::spawn_blocking(move || parse_diff(&answer, &relative))
        .await
        .map_err(|e| e.to_string())?
}

/// The local branches of the worktree at `path`, the current one first (the branch button of the file pane). A worktree that is not one of the target's list is refused as for the list.
#[tauri::command]
pub async fn orca_local_branches(
    path: String,
    environment: Option<String>,
) -> Result<Vec<OrcaLocalBranch>, String> {
    cached_host_of(&path, environment.as_deref()).await?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        local_branches(&mut connection, &path).await
    };
    forgetting(asked.await, &path, environment.as_deref())
}

/// The remote branches whose names hold `query`, at most 50, of the repository `repo` (`OrcaProject::key`) of the worktree at `path`. The worktree must be one of the target's list, as for the list, and `repo` its project.
#[tauri::command]
pub async fn orca_remote_branches(
    path: String,
    repo: String,
    query: String,
    environment: Option<String>,
) -> Result<Vec<OrcaRemoteBranch>, String> {
    check_repo(&repo)?;
    check_query(&query)?;
    let (_, project) = cached_host_and_project_of(&path, environment.as_deref()).await?;
    check_same_repo(&project, &repo)?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        remote_branches(&mut connection, &repo, &query).await
    };
    forgetting(asked.await, &path, environment.as_deref())
}

/// Switches the worktree at `path` to a local branch, or to a remote one (`kind` `remote`, `name` like `origin/feature/a`; Orca makes the local branch). `kind` `new` is refused. This writes to the worktree, so the target's list is read each time, as a save does, and what was believed of the worktree is thrown away after the call, whatever it answered. Orca's refusal comes back in its own words.
/// On a saved environment the stream of the list (A-12) is told to read the worktrees again, whatever the call answered, because the list it sends says the branch.
#[tauri::command]
pub async fn orca_switch_branch(
    stream: tauri::State<'_, crate::orca_stream::OrcaStream>,
    path: String,
    kind: String,
    name: String,
    environment: Option<String>,
) -> Result<OrcaBranchSwitched, String> {
    let (kind, name) = check_switch(&kind, &name)?;
    let host_id = host_of(&path, environment.as_deref()).await?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        switch_branch(&mut connection, &path, &host_id, kind, &name).await
    };
    let switched = asked.await;
    forget_worktree_host(&path, environment.as_deref());
    if environment.is_some() {
        stream.reread_worktrees();
    }
    switched
}

/// The commits of the worktree at `path` from HEAD, the newest first: `limit` (1 to 200) of them after the first `skip`, on the history `history_token` stands for when it is given (the history of the file pane). A worktree that is not one of the target's list is refused as for the list.
#[tauri::command]
pub async fn orca_git_history(
    path: String,
    limit: u32,
    skip: u32,
    history_token: Option<String>,
    environment: Option<String>,
) -> Result<OrcaCommitList, String> {
    check_history_limit(limit)?;
    if let Some(token) = &history_token {
        check_history_token(token)?;
    }
    cached_host_of(&path, environment.as_deref()).await?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        git_history(
            &mut connection,
            &path,
            limit,
            skip,
            history_token.as_deref(),
        )
        .await
    };
    forgetting(asked.await, &path, environment.as_deref())
}

/// The files the commit `commit_id` (a full id) of the worktree at `path` changed against its first parent. A worktree that is not one of the target's list is refused as for the list.
#[tauri::command]
pub async fn orca_commit_files(
    path: String,
    commit_id: String,
    environment: Option<String>,
) -> Result<OrcaCommitFiles, String> {
    if !is_object_id(&commit_id) {
        return Err("コミットの ID が正しくありません".into());
    }
    cached_host_of(&path, environment.as_deref()).await?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        commit_files(&mut connection, &path, &commit_id).await
    };
    forgetting(asked.await, &path, environment.as_deref())
}

/// The difference of the file `relative` in the commit `commit_id` (a full id) from the commit `parent_id` (its first parent, a full id; none for the first commit, which is compared with nothing), of the worktree at `path`, as the diff tab draws it (A-24, the answer of `orca_file_diff`). `old_relative` is the path the file had at the parent, for a file that was renamed. A file that is not in the parent is compared with nothing, and so is one that the commit deleted. A worktree that is not one of the target's list is refused as for the list. The comparison runs off the async threads, as in `orca_file_diff`.
#[tauri::command]
pub async fn orca_commit_file_diff(
    path: String,
    commit_id: String,
    parent_id: Option<String>,
    relative: String,
    old_relative: Option<String>,
    environment: Option<String>,
) -> Result<OrcaFileDiff, String> {
    check_commit_diff(
        &commit_id,
        parent_id.as_deref(),
        &relative,
        old_relative.as_deref(),
    )?;
    cached_host_of(&path, environment.as_deref()).await?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        commit_diff(
            &mut connection,
            &path,
            &commit_id,
            parent_id.as_deref(),
            &relative,
            old_relative.as_deref(),
        )
        .await
    };
    let answer = forgetting(asked.await, &path, environment.as_deref())?;
    tokio::task::spawn_blocking(move || parse_diff(&answer, &relative))
        .await
        .map_err(|e| e.to_string())?
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

/// Makes a file or, with `folder`, a folder named `name` in the folder `dir` of the worktree at `path` (A-18), and answers its path from the worktree. The name is checked first, and a name that is taken is refused: nothing is overwritten. This writes to the worktree, so the target's list is read each time, as a save does.
#[tauri::command]
pub async fn orca_file_create(
    path: String,
    dir: String,
    name: String,
    folder: bool,
    environment: Option<String>,
) -> Result<String, String> {
    let relative = new_relative(&dir, &name)?;
    let host_id = host_of(&path, environment.as_deref()).await?;
    let mut connection = Connection::open(environment).await?;
    create(&mut connection, &path, &host_id, &relative, folder).await
}

/// Makes the scratchpad file `name` in `.orca/scratchpad` of the worktree at `path` (A-29), and answers its path from the worktree; a file of that name that is there already is answered as it is, with `existed` true, and left as it is. The name is checked first. This writes to the worktree, so the target's list is read each time, as a save does.
#[tauri::command]
pub async fn orca_scratchpad_create(
    path: String,
    name: String,
    environment: Option<String>,
) -> Result<OrcaScratchpad, String> {
    new_relative(SCRATCHPAD_DIR, &name)?;
    let host_id = host_of(&path, environment.as_deref()).await?;
    let mut connection = Connection::open(environment).await?;
    create_scratchpad(&mut connection, &path, &host_id, &name).await
}

/// Deletes the file or, with `folder`, the folder with its contents, `relative` in the worktree at `path` (A-18), for good: Orca's `files.delete` skips the Trash. The root of the worktree (an empty `relative`) and a path that is not inside it are refused. This writes to the worktree, so the target's list is read each time, as a save does, and what was believed of the worktree is thrown away after the call.
#[tauri::command]
pub async fn orca_file_delete(
    path: String,
    relative: String,
    folder: bool,
    environment: Option<String>,
) -> Result<(), String> {
    check_written(&relative, false)?;
    let host_id = host_of(&path, environment.as_deref()).await?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        delete(&mut connection, &path, &host_id, &relative, folder).await
    };
    let deleted = asked.await;
    forget_worktree_host(&path, environment.as_deref());
    deleted
}

/// Moves or renames the file or folder `from` of the worktree at `path` to `to` (A-18; both are paths from the worktree). The root of the worktree, a path that is not inside it, a target that is the source and a target inside the source are refused before anything is asked, and a target that is there is refused by Orca: nothing is overwritten. The folders of the target that are missing are made. This writes to the worktree, so the target's list is read each time, as a save does, and what was believed of the worktree is thrown away after the call.
#[tauri::command]
pub async fn orca_file_move(
    path: String,
    from: String,
    to: String,
    environment: Option<String>,
) -> Result<(), String> {
    check_move(&from, &to)?;
    let host_id = host_of(&path, environment.as_deref()).await?;
    let asked = async {
        let mut connection = Connection::open(environment.clone()).await?;
        move_entry(&mut connection, &path, &host_id, &from, &to).await
    };
    let moved = asked.await;
    forget_worktree_host(&path, environment.as_deref());
    moved
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
    let step = i64::from(AUTOSAVE_STEP);
    let ms = ms.clamp(i64::from(AUTOSAVE_MIN), i64::from(AUTOSAVE_MAX));
    let stepped = (ms + step / 2) / step * step;
    u32::try_from(stepped).unwrap_or(AUTOSAVE_DEFAULT)
}

/// The settings Rust answers: the time and the range it is kept in.
fn settings_of(autosave_ms: u32) -> EditorSettings {
    EditorSettings {
        autosave_ms,
        autosave_min: AUTOSAVE_MIN,
        autosave_max: AUTOSAVE_MAX,
        autosave_step: AUTOSAVE_STEP,
    }
}

/// The saved settings; a missing or unreadable file gives the first value, and a value out of the range is brought into it.
fn load_settings(dir: &Path) -> EditorSettings {
    let saved = std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<StoredSettings>(&text).ok());
    settings_of(saved.map_or(AUTOSAVE_DEFAULT, |s| {
        clamp_autosave(i64::from(s.autosave_ms))
    }))
}

fn save_settings(dir: &Path, autosave_ms: i64) -> Result<EditorSettings, String> {
    let autosave_ms = clamp_autosave(autosave_ms);
    let text =
        serde_json::to_string_pretty(&StoredSettings { autosave_ms }).map_err(|e| e.to_string())?;
    write_atomic(dir, SETTINGS_FILE, &text)?;
    Ok(settings_of(autosave_ms))
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

    const ID_A: &str = "19ea5e77168cddfe8b9d5c4f1b0b09761fdca3f7";
    const ID_B: &str = "cfabd25c06c3a9c52c2ef09c528c018a5dd195ee";

    #[test]
    fn only_a_full_object_id_is_one() {
        assert!(is_object_id(ID_A));
        assert!(is_object_id(&"A".repeat(40)));
        assert!(is_object_id(&"0".repeat(64)));
        for bad in [
            "",
            "19ea5e7",
            &"a".repeat(39),
            &"a".repeat(41),
            &"a".repeat(63),
            &format!("{}g", "a".repeat(39)),
            &format!("{} ", "a".repeat(39)),
            "HEAD",
            "--all",
        ] {
            assert!(!is_object_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_read_of_the_history_takes_one_to_two_hundred() {
        assert!(check_history_limit(1).is_ok());
        assert!(check_history_limit(200).is_ok());
        assert!(check_history_limit(0).is_err());
        assert!(check_history_limit(201).is_err());
    }

    #[test]
    fn the_history_is_asked_from_head_with_limit_and_skip() {
        assert_eq!(
            history_params(50, 100, None),
            json!({"refs": "head", "limit": 50, "skip": 100})
        );
    }

    #[test]
    fn the_history_is_asked_on_the_pinned_history_when_a_token_is_given() {
        assert_eq!(
            history_params(50, 100, Some("0b6f-41")),
            json!({"refs": "head", "limit": 50, "skip": 100, "historyToken": "0b6f-41"})
        );
    }

    #[test]
    fn a_history_token_is_a_short_plain_word() {
        assert!(check_history_token("0f8fad5b-d9cb-469f-a165-70867728950e").is_ok());
        assert!(check_history_token(&"a".repeat(100)).is_ok());
        for bad in ["", "a b", "a\n", "a/b", "ａ"] {
            assert!(check_history_token(bad).is_err(), "{bad:?}");
        }
        assert!(check_history_token(&"a".repeat(101)).is_err());
    }

    #[test]
    fn the_token_and_the_change_of_the_history_come_with_the_answer() {
        let first = parse_history(
            &json!({"items": [{"id": ID_A}], "hasMore": true, "historyToken": "t-1"}),
        )
        .unwrap();
        assert_eq!(first.history_token.as_deref(), Some("t-1"));
        assert!(!first.history_changed);
        let bad = parse_history(&json!({"items": [{"id": ID_A}], "historyToken": "a b"})).unwrap();
        assert_eq!(bad.history_token, None);
        let gone = parse_history(
            &json!({"items": [], "hasMore": false, "historyToken": "t-1", "historyChanged": true}),
        )
        .unwrap();
        assert!(gone.history_changed && gone.commits.is_empty() && !gone.has_more);
    }

    #[test]
    fn the_commits_of_an_answer_keep_their_order_and_parents() {
        let answer = json!({
            "currentRef": {"id": "refs/heads/main"},
            "hasMore": true,
            "historyToken": "t",
            "items": [
                {
                    "author": "A", "authorEmail": "a@example.com", "displayId": "19ea5e7",
                    "id": ID_A, "message": "Merge x\n\nbody", "subject": "Merge x",
                    "parentIds": [ID_B, "bad"], "references": [], "timestamp": 1_794_542_268_000_i64
                },
                {"id": ID_B, "message": "first line\nsecond", "parentIds": []},
            ],
        });
        let list = parse_history(&answer).unwrap();
        assert!(list.has_more);
        assert_eq!(
            list.commits,
            [
                OrcaCommit {
                    id: ID_A.into(),
                    short_id: "19ea5e7".into(),
                    subject: "Merge x".into(),
                    author: "A".into(),
                    time_ms: 1_794_542_268_000,
                    parents: vec![ID_B.into()],
                },
                OrcaCommit {
                    id: ID_B.into(),
                    short_id: "cfabd25".into(),
                    subject: "first line".into(),
                    author: String::new(),
                    time_ms: 0,
                    parents: vec![],
                },
            ]
        );
    }

    #[test]
    fn the_end_of_the_history_has_no_more() {
        let end = parse_history(&json!({"items": [], "hasMore": true})).unwrap();
        assert!(end.commits.is_empty() && !end.has_more);
        let last = parse_history(&json!({"items": [{"id": ID_A}], "hasMore": false})).unwrap();
        assert_eq!(last.commits.len(), 1);
        assert!(!last.has_more);
        let none = parse_history(&json!({"items": [{"id": ID_A}]})).unwrap();
        assert!(!none.has_more);
    }

    #[test]
    fn a_history_that_cannot_be_read_is_refused_whole() {
        for bad in [
            json!({}),
            json!("x"),
            json!({"items": "x"}),
            json!({"items": [{"id": ID_A}, {"subject": "no id"}]}),
            json!({"items": [{"id": "19ea5e7"}]}),
        ] {
            assert_eq!(parse_history(&bad).unwrap_err(), NOT_HISTORY, "{bad}");
        }
    }

    #[tokio::test]
    async fn the_history_is_asked_of_the_worktree_by_its_path() {
        let mut orca = fake(vec![(
            "git.history",
            Ok(json!({"items": [{"id": ID_A}], "hasMore": false})),
        )]);
        let list = git_history(&mut orca, "/work/a", 50, 0, None)
            .await
            .unwrap();
        assert_eq!(list.commits[0].id, ID_A);
        assert_eq!(
            orca.calls,
            [(
                "git.history".to_owned(),
                json!({"worktree": "path:/work/a", "refs": "head", "limit": 50, "skip": 0})
            )]
        );
    }

    #[tokio::test]
    async fn a_history_orca_refuses_says_why() {
        let mut orca = fake(vec![(
            "git.history",
            Err((
                "Orca がエラーを返しました（selector_not_found）",
                "selector_not_found",
            )),
        )]);
        assert_eq!(
            git_history(&mut orca, "/work/a", 50, 0, None)
                .await
                .unwrap_err(),
            "worktree が見つかりません"
        );
        let mut orca = fake(vec![]);
        assert_eq!(
            git_history(&mut orca, "/work/a", 50, 0, None)
                .await
                .unwrap_err(),
            "no answer"
        );
    }

    fn compare(entries: Value) -> Value {
        json!({
            "entries": entries,
            "summary": {
                "baseRef": "cfabd25", "changedFiles": 1, "commitOid": ID_A,
                "compareRef": "19ea5e7", "parentOid": ID_B, "status": "ready"
            }
        })
    }

    #[test]
    fn the_files_of_a_commit_keep_status_paths_and_counts() {
        let answer = compare(json!([
            {"path": "a.rs", "status": "modified", "added": 10, "removed": 6},
            {"path": "b.rs", "status": "added", "added": 3, "removed": 0},
            {"path": "c.rs", "status": "deleted", "added": 0, "removed": 4},
            {"path": "d/new.rs", "oldPath": "d/old.rs", "status": "renamed", "added": 1, "removed": 1},
            {"path": "e.rs", "oldPath": "a.rs", "status": "copied"},
            {"path": "img.png", "status": "modified"},
            {"path": "t.rs", "status": "something else", "oldPath": ""},
        ]));
        let files = parse_commit_files(&answer).unwrap();
        assert_eq!(files.parent_id.as_deref(), Some(ID_B));
        assert_eq!(files.total, 7);
        let file = |status, path: &str, old: Option<&str>, added, removed| OrcaCommitFile {
            status,
            path: path.into(),
            old_path: old.map(str::to_owned),
            added,
            removed,
        };
        use OrcaCommitFileStatus::{Added, Copied, Deleted, Modified, Renamed};
        assert_eq!(
            files.files,
            [
                file(Modified, "a.rs", None, Some(10), Some(6)),
                file(Added, "b.rs", None, Some(3), Some(0)),
                file(Deleted, "c.rs", None, Some(0), Some(4)),
                file(Renamed, "d/new.rs", Some("d/old.rs"), Some(1), Some(1)),
                file(Copied, "e.rs", Some("a.rs"), None, None),
                file(Modified, "img.png", None, None, None),
                file(Modified, "t.rs", None, None, None),
            ]
        );
    }

    #[test]
    fn the_first_commit_has_no_parent_and_a_big_commit_is_cut() {
        let mut answer = compare(json!([]));
        answer["summary"]["parentOid"] = Value::Null;
        answer["summary"]["changedFiles"] = json!(0);
        let files = parse_commit_files(&answer).unwrap();
        assert!(files.files.is_empty() && files.parent_id.is_none() && files.total == 0);
        let many: Vec<Value> = (0..COMMIT_FILES_MAX + 3)
            .map(|n| json!({"path": format!("f{n}"), "status": "added"}))
            .collect();
        let mut big = compare(Value::Array(many));
        big["summary"]["changedFiles"] = json!(COMMIT_FILES_MAX + 3);
        let files = parse_commit_files(&big).unwrap();
        assert_eq!(files.files.len(), COMMIT_FILES_MAX);
        assert_eq!(files.total as usize, COMMIT_FILES_MAX + 3);
        // A parent that is not a full id is not believed.
        let mut odd = compare(json!([]));
        odd["summary"]["parentOid"] = json!("cfabd25");
        assert!(parse_commit_files(&odd).unwrap().parent_id.is_none());
    }

    #[test]
    fn a_commit_orca_cannot_read_is_refused() {
        let mut missing = compare(json!([]));
        missing["summary"]["status"] = json!("invalid-commit");
        assert_eq!(
            parse_commit_files(&missing).unwrap_err(),
            "コミットが見つかりません"
        );
        for status in [json!("error"), json!("loading"), Value::Null] {
            let mut failed = compare(json!([]));
            failed["summary"]["status"] = status;
            assert_eq!(parse_commit_files(&failed).unwrap_err(), NOT_COMMIT_FILES);
        }
        for bad in [
            json!({}),
            json!({"summary": {"status": "ready"}}),
            compare(json!([{"status": "added"}])),
            compare(json!([{"path": "", "status": "added"}])),
        ] {
            assert_eq!(
                parse_commit_files(&bad).unwrap_err(),
                NOT_COMMIT_FILES,
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn the_files_of_a_commit_are_asked_with_the_full_id() {
        let mut orca = fake(vec![(
            "git.commitCompare",
            Ok(compare(json!([{"path": "a.rs", "status": "modified"}]))),
        )]);
        let files = commit_files(&mut orca, "/work/a", ID_A).await.unwrap();
        assert_eq!(files.files.len(), 1);
        assert_eq!(
            orca.calls,
            [(
                "git.commitCompare".to_owned(),
                json!({"worktree": "path:/work/a", "commitId": ID_A})
            )]
        );
        let mut orca = fake(vec![(
            "git.commitCompare",
            Err((
                "Orca がエラーを返しました（invalid_argument）",
                "Expected a full git object id",
            )),
        )]);
        assert_eq!(
            commit_files(&mut orca, "/work/a", ID_A).await.unwrap_err(),
            "Orca がエラーを返しました（invalid_argument）"
        );
    }

    #[tokio::test]
    async fn the_diff_of_a_commit_file_is_asked_with_the_parent_and_the_old_path() {
        let answer = json!({"kind": "text", "originalContent": "a\n", "modifiedContent": "b\n"});
        let mut orca = fake(vec![("git.commitDiff", Ok(answer.clone()))]);
        let got = commit_diff(&mut orca, "/work/a", ID_A, Some(ID_B), "n.rs", Some("o.rs"))
            .await
            .unwrap();
        assert_eq!(got, answer);
        assert_eq!(
            orca.calls,
            [(
                "git.commitDiff".to_owned(),
                json!({"worktree": "path:/work/a", "commitOid": ID_A, "parentOid": ID_B, "filePath": "n.rs", "oldPath": "o.rs"})
            )]
        );
        // The first commit has no parent, and a file that was not renamed has no old path: neither is sent.
        let mut orca = fake(vec![("git.commitDiff", Ok(answer))]);
        commit_diff(&mut orca, "/work/a", ID_A, None, "n.rs", None)
            .await
            .unwrap();
        assert_eq!(
            orca.calls[0].1,
            json!({"worktree": "path:/work/a", "commitOid": ID_A, "filePath": "n.rs"})
        );
        let mut orca = fake(vec![(
            "git.commitDiff",
            Err((
                "Orca がエラーを返しました（selector_not_found）",
                "selector_not_found",
            )),
        )]);
        assert_eq!(
            commit_diff(&mut orca, "/work/a", ID_A, None, "n.rs", None)
                .await
                .unwrap_err(),
            "worktree が見つかりません"
        );
    }

    #[test]
    fn the_diff_of_a_commit_file_is_drawn_as_a_file_diff_is() {
        let changed = parse_diff(
            &json!({"kind": "text", "originalContent": "a\nb\n", "modifiedContent": "a\nc\n", "originalIsBinary": false, "modifiedIsBinary": false}),
            "src/a.rs",
        )
        .unwrap();
        assert_eq!(changed.old_lines, vec!["a", "b"]);
        assert_eq!(changed.new_lines, vec!["a", "c"]);
        assert_eq!(changed.changes.len(), 1);
        assert_eq!(changed.language, "rust");
        // A file the commit added is compared with nothing (no parent, or not in it), and one it deleted has no text at the commit.
        let added = parse_diff(
            &json!({"kind": "text", "originalContent": "", "modifiedContent": "x\n"}),
            "a.rs",
        )
        .unwrap();
        assert!(added.old_lines.is_empty() && added.new_lines == ["x"]);
        let deleted = parse_diff(
            &json!({"kind": "text", "originalContent": "x\n", "modifiedContent": ""}),
            "a.rs",
        )
        .unwrap();
        assert!(deleted.new_lines.is_empty() && deleted.old_lines == ["x"]);
        // What Orca marks for a binary file, one it cannot draw, and a side over 384 KiB is refused as in A-24.
        let binary = json!({"kind": "binary", "originalContent": "", "modifiedContent": "", "originalIsBinary": false, "modifiedIsBinary": true});
        assert_eq!(
            parse_diff(&binary, "a.bin").unwrap_err(),
            "バイナリのファイルの差分は表示できません"
        );
        let limited = json!({"kind": "text", "originalContent": "", "modifiedContent": "", "originalIsBinary": false, "modifiedIsBinary": false, "largeDiffRenderLimit": {"limited": true}});
        assert_eq!(parse_diff(&limited, "a").unwrap_err(), DIFF_TOO_LARGE);
        let big = json!({"originalContent": "a".repeat(MAX_TEXT + 1), "modifiedContent": ""});
        assert_eq!(
            parse_diff(&big, "a").unwrap_err(),
            "384 KiB を超えるファイルの差分は表示できません"
        );
        let not_utf8 = json!({"originalContent": "a\u{FFFD}", "modifiedContent": ""});
        assert_eq!(
            parse_diff(&not_utf8, "a").unwrap_err(),
            "UTF-8 ではないファイルの差分は表示できません"
        );
    }

    #[test]
    fn a_commit_file_diff_is_asked_only_for_full_ids_and_paths_in_the_worktree() {
        assert!(check_commit_diff(ID_A, Some(ID_B), "a/b.rs", Some("c.rs")).is_ok());
        assert!(check_commit_diff(ID_A, None, "a.rs", None).is_ok());
        let id = "コミットの ID が正しくありません";
        for (commit, parent) in [
            ("19ea5e7", None),
            ("", None),
            ("HEAD", None),
            (ID_A, Some("cfabd25")),
            (ID_A, Some("")),
            (ID_A, Some("-x")),
        ] {
            assert_eq!(
                check_commit_diff(commit, parent, "a.rs", None).unwrap_err(),
                id,
                "{commit} {parent:?}"
            );
        }
        for (relative, old) in [
            ("", None),
            ("../a", None),
            ("/a", None),
            ("a\nb", None),
            ("a.rs", Some("")),
            ("a.rs", Some("../a")),
            ("a.rs", Some("/etc/passwd")),
        ] {
            assert!(
                check_commit_diff(ID_A, None, relative, old).is_err(),
                "{relative:?} {old:?}"
            );
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

    #[tokio::test]
    async fn a_folder_is_listed_sorted_with_one_call_and_no_mark() {
        let mut orca = fake(vec![
            (
                "files.readDir",
                Ok(json!({"entries": [
                    {"name": "b.log", "isDirectory": false},
                    {"name": "target", "isDirectory": true},
                    {"name": "src", "isDirectory": true},
                ], "total": 3, "hasMore": false})),
            ),
            ("git.checkIgnored", Ok(json!(["lib/target/", "lib/b.log"]))),
        ]);
        let dir = list(&mut orca, "/work/a", "lib", false).await.unwrap();
        assert_eq!(names(&dir.entries), ["src", "target", "b.log"]);
        assert!(dir.entries.iter().all(|e| !e.ignored));
        assert_eq!(dir.total, 3);
        // The list does not wait for git: it is the only call.
        assert_eq!(
            orca.calls,
            [(
                "files.readDir".to_owned(),
                json!({"worktree": "path:/work/a", "relativePath": "lib", "limit": 5000})
            )]
        );
    }

    #[tokio::test]
    async fn what_git_ignores_is_asked_after_the_list_and_answered_in_the_order_asked() {
        let mut orca = fake(vec![(
            "git.checkIgnored",
            // Git echoes a folder with or without its slash, and may answer a path that was not asked.
            Ok(json!(["lib/target/", "lib/b.log", "other"])),
        )]);
        let asked: Vec<String> = ["lib/src", "lib/target", "lib/b.log"]
            .map(String::from)
            .into();
        let found = ignored_in(&mut orca, "/work/a", &asked).await;
        assert_eq!(found, ["lib/target", "lib/b.log"]);
        assert_eq!(
            orca.calls,
            [(
                "git.checkIgnored".to_owned(),
                json!({"worktree": "path:/work/a", "paths": ["lib/src", "lib/target", "lib/b.log"]})
            )]
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
    async fn a_failed_ignore_check_marks_nothing() {
        let mut orca = fake(vec![(
            "git.checkIgnored",
            Err(("Orca がエラーを返しました", "not a git repository")),
        )]);
        let asked = vec!["a".to_owned()];
        assert!(ignored_in(&mut orca, "/work/a", &asked).await.is_empty());
    }

    #[tokio::test]
    async fn the_paths_to_check_go_in_chunks() {
        let asked: Vec<String> = (0..IGNORE_CHUNK + 1).map(|i| format!("f{i}")).collect();
        let mut orca = fake(vec![("git.checkIgnored", Ok(json!(["f0"])))]);
        let found = ignored_in(&mut orca, "/work/a", &asked).await;
        let checks: Vec<&Value> = orca.calls.iter().map(|(_, p)| &p["paths"]).collect();
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].as_array().unwrap().len(), IGNORE_CHUNK);
        assert_eq!(checks[1].as_array().unwrap().len(), 1);
        assert_eq!(found, ["f0"]);
    }

    #[test]
    fn the_paths_to_check_are_inside_the_worktree_and_not_more_than_a_list() {
        let ok: Vec<String> = ["a", "src/main.rs"].map(String::from).into();
        assert!(check_ignore_paths(&ok).is_ok());
        assert!(check_ignore_paths(&[]).is_ok());
        for bad in ["", "/etc", "../x", "a/../b", "a//b", "a/", "a\nb"] {
            assert!(check_ignore_paths(&[bad.to_owned()]).is_err(), "{bad:?}");
        }
        // One bad path among good ones refuses all.
        assert!(check_ignore_paths(&["a".to_owned(), "..".to_owned()]).is_err());
        let most: Vec<String> = (0..LIST_LIMIT).map(|i| format!("f{i}")).collect();
        assert!(check_ignore_paths(&most).is_ok());
        let more: Vec<String> = (0..=LIST_LIMIT).map(|i| format!("f{i}")).collect();
        assert!(check_ignore_paths(&more).is_err());
    }

    #[test]
    fn an_ssh_host_is_refused_whether_or_not_it_was_believed() {
        assert!(check_host("local").is_ok());
        assert!(check_host("ssh:lab").is_err());
    }

    // What Orca 1.4.256 answered on this machine's unix socket (the shapes of the two answers).
    fn local_answer() -> Value {
        json!({
            "current": "feature/b",
            "branches": ["feature/b", "main", "old", "taken", "same"],
            "committedAt": {"feature/b": 1_700_000_000_000_i64, "main": 1_700_000_900_000_i64, "old": 1_600_000_000_000_i64, "taken": 1_700_000_500_000_i64},
            "worktreePaths": {"feature/b": "/work/a", "taken": "/work/other", "same": "/work/a/"}
        })
    }

    fn remote_answer() -> Value {
        json!({
            "refDetails": [
                {"refName": "origin/feature/a", "localBranchName": "feature/a"},
                {"refName": "gh/main", "localBranchName": "main"},
            ],
            "truncated": false,
            "refs": ["origin/feature/a", "gh/main"],
            "namespace": "remote"
        })
    }

    fn remote(name: &str, local_name: &str) -> OrcaRemoteBranch {
        OrcaRemoteBranch {
            name: name.into(),
            local_name: local_name.into(),
        }
    }

    #[test]
    fn local_branches_have_the_current_first_then_the_newest() {
        let branches = parse_local_branches(&local_answer(), "/work/a").unwrap();
        let named: Vec<(&str, bool, bool)> = branches
            .iter()
            .map(|b| (b.name.as_str(), b.current, b.in_use))
            .collect();
        // `taken` is checked out in another worktree; `same` (the path with a slash) and the current one are this worktree's own; a branch with no commit time goes last.
        assert_eq!(
            named,
            [
                ("feature/b", true, false),
                ("main", false, false),
                ("taken", false, true),
                ("old", false, false),
                ("same", false, false),
            ]
        );
    }

    #[test]
    fn local_branches_read_an_answer_with_the_bare_branches() {
        let branches = parse_local_branches(
            &json!({"current": null, "branches": ["b", "", 3, "a"]}),
            "/work/a",
        )
        .unwrap();
        let named: Vec<(&str, bool, bool)> = branches
            .iter()
            .map(|b| (b.name.as_str(), b.current, b.in_use))
            .collect();
        assert_eq!(named, [("b", false, false), ("a", false, false)]);
        assert!(parse_local_branches(&json!({"branches": []}), "/w")
            .unwrap()
            .is_empty());
        assert_eq!(
            parse_local_branches(&json!({"current": "a"}), "/w").unwrap_err(),
            NOT_BRANCHES
        );
        assert!(parse_local_branches(&json!("x"), "/w").is_err());
    }

    #[tokio::test]
    async fn the_local_branches_are_asked_of_the_worktree_by_its_path() {
        let mut orca = fake(vec![("git.localBranches", Ok(local_answer()))]);
        let branches = local_branches(&mut orca, "/work/a").await.unwrap();
        assert_eq!(branches.len(), 5);
        assert_eq!(
            orca.calls,
            [(
                "git.localBranches".to_owned(),
                json!({"worktree": "path:/work/a"})
            )]
        );
    }

    #[tokio::test]
    async fn the_remote_branches_are_searched_in_the_remote_namespace_by_the_repository_id() {
        let mut orca = fake(vec![("repo.searchRefs", Ok(remote_answer()))]);
        let found = remote_branches(&mut orca, "cfb7", "ma").await.unwrap();
        assert_eq!(
            found,
            [
                remote("origin/feature/a", "feature/a"),
                remote("gh/main", "main")
            ]
        );
        assert_eq!(
            orca.calls,
            [(
                "repo.searchRefs".to_owned(),
                json!({"repo": "id:cfb7", "query": "ma", "limit": 50, "namespace": "remote"})
            )]
        );
    }

    #[test]
    fn remote_branches_drop_local_refs_and_take_the_name_without_its_prefix() {
        let found = parse_remote_branches(&json!({"refDetails": [
            {"refName": "refs/remotes/origin/a", "localBranchName": "a"},
            {"refName": "refs/heads/b", "localBranchName": "b"},
            {"refName": "", "localBranchName": "c"},
            {"localBranchName": "d"},
            {"refName": "upstream/x/y"},
            {"refName": "origin/z", "localBranchName": ""},
        ]}))
        .unwrap();
        // A missing local name is the guess of Orca's old client, without `origin/` or `upstream/`.
        assert_eq!(
            found,
            [
                remote("origin/a", "a"),
                remote("upstream/x/y", "x/y"),
                remote("origin/z", "z")
            ]
        );
    }

    #[test]
    fn an_old_orca_answers_the_names_alone() {
        let found =
            parse_remote_branches(&json!({"refs": ["origin/a", "mine/b", "origin/"]})).unwrap();
        assert_eq!(
            found,
            [
                remote("origin/a", "a"),
                remote("mine/b", "mine/b"),
                remote("origin/", "origin/")
            ]
        );
        assert!(parse_remote_branches(&json!({"refDetails": []}))
            .unwrap()
            .is_empty());
        assert_eq!(
            parse_remote_branches(&json!({"truncated": false})).unwrap_err(),
            NOT_BRANCHES
        );
    }

    #[test]
    fn a_repository_and_a_search_text_are_checked_before_orca_is_asked() {
        assert!(check_repo("cfb7b1c2-0000-4000-8000-000000000000").is_ok());
        for bad in ["", "ssh:lab", "a\nb", &"a".repeat(MAX_REPO + 1)] {
            assert!(check_repo(bad).is_err(), "{bad:?}");
        }
        assert!(check_repo(&"a".repeat(MAX_REPO)).is_ok());
        for ok in ["", "feature/日本語", &"a".repeat(MAX_QUERY)] {
            assert!(check_query(ok).is_ok(), "{ok:?}");
        }
        for bad in ["a\nb", "a\0b", &"a".repeat(MAX_QUERY + 1)] {
            assert!(check_query(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_repository_asked_for_must_be_the_project_of_the_worktree() {
        assert!(check_same_repo("repo-1", "repo-1").is_ok());
        for (project, repo) in [("repo-1", "repo-2"), ("", "repo-1"), ("repo-1", "Repo-1")] {
            assert!(
                check_same_repo(project, repo).is_err(),
                "{project:?} {repo:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_worktree_or_repository_orca_does_not_know_says_so() {
        let mut orca = fake(vec![(
            "git.localBranches",
            Err((
                "Orca がエラーを返しました（selector_not_found）",
                "selector_not_found",
            )),
        )]);
        assert_eq!(
            local_branches(&mut orca, "/gone").await.unwrap_err(),
            "worktree が見つかりません"
        );
        let mut orca = fake(vec![(
            "repo.searchRefs",
            Err((
                "Orca がエラーを返しました（repo_not_found）",
                "repo_not_found",
            )),
        )]);
        assert_eq!(
            remote_branches(&mut orca, "gone", "").await.unwrap_err(),
            "プロジェクトが見つかりません"
        );
        // Any other failure keeps the message of the files.
        let mut orca = fake(vec![(
            "repo.searchRefs",
            Err(("Orca がエラーを返しました（runtime_error）", "boom")),
        )]);
        assert_eq!(
            remote_branches(&mut orca, "r", "").await.unwrap_err(),
            "Orca がエラーを返しました（runtime_error）"
        );
    }

    #[test]
    fn a_switch_takes_a_local_or_a_remote_branch_and_never_a_new_one() {
        assert_eq!(
            check_switch("local", "feature/日本語").unwrap(),
            ("local", "feature/日本語".to_owned())
        );
        assert_eq!(
            check_switch("remote", "  origin/feature/a \t").unwrap(),
            ("remote", "origin/feature/a".to_owned())
        );
        for kind in ["new", "", "Local", "remote ", "detached"] {
            assert!(check_switch(kind, "main").is_err(), "{kind:?}");
        }
        for name in [
            "",
            "  ",
            "-x",
            " --detach",
            "a\nb",
            "a\0b",
            "a\u{7f}b",
            "\u{1b}[0m",
        ] {
            assert!(check_switch("local", name).is_err(), "{name:?}");
        }
    }

    #[tokio::test]
    async fn a_switch_asks_the_worktree_on_its_host_for_the_branch() {
        let mut orca = fake(vec![(
            "git.switchBranch",
            Ok(json!({"ok": true, "branch": "feature/a", "head": "0123abc"})),
        )]);
        let switched = switch_branch(&mut orca, "/work/a", "local", "local", "feature/a")
            .await
            .unwrap();
        assert_eq!(
            switched,
            OrcaBranchSwitched {
                branch: "feature/a".into(),
                warning: None
            }
        );
        assert_eq!(
            orca.calls,
            [(
                "git.switchBranch".to_owned(),
                json!({
                    "worktree": "path:/work/a",
                    "expectedExecutionHostId": "local",
                    "target": {"kind": "local", "name": "feature/a"},
                })
            )]
        );
        let mut orca = fake(vec![("git.switchBranch", Ok(json!({"branch": "a"})))]);
        switch_branch(&mut orca, "/w", "env-1", "remote", "origin/a")
            .await
            .unwrap();
        assert_eq!(
            orca.calls[0].1["target"],
            json!({"kind": "remote", "name": "origin/a"})
        );
        assert_eq!(orca.calls[0].1["expectedExecutionHostId"], "env-1");
    }

    #[tokio::test]
    async fn a_switch_that_landed_with_a_warning_is_a_success_with_the_warning() {
        let warning = "Switched to a, but 1 file kept the old branch's content because another program has it open (x.txt).";
        let mut orca = fake(vec![(
            "git.switchBranch",
            Ok(json!({"ok": true, "branch": "a", "head": "0123abc", "warning": warning})),
        )]);
        assert_eq!(
            switch_branch(&mut orca, "/w", "local", "local", "a")
                .await
                .unwrap(),
            OrcaBranchSwitched {
                branch: "a".into(),
                warning: Some(warning.into())
            }
        );
        // An empty warning is none, and an answer with no branch is not a switch that can be told.
        assert_eq!(
            parse_switched(&json!({"branch": "a", "warning": ""})).unwrap(),
            OrcaBranchSwitched {
                branch: "a".into(),
                warning: None
            }
        );
        for bad in [json!({"ok": true}), json!({"branch": ""}), json!("x")] {
            assert_eq!(parse_switched(&bad).unwrap_err(), NOT_SWITCHED, "{bad}");
        }
    }

    #[tokio::test]
    async fn a_switch_orca_refuses_gives_orcas_own_words() {
        let message = "Commit or discard 2 changed files before switching branches.";
        let mut orca = fake(vec![(
            "git.switchBranch",
            Err(("Orca がエラーを返しました（runtime_error）", message)),
        )]);
        assert_eq!(
            switch_branch(&mut orca, "/w", "local", "local", "a")
                .await
                .unwrap_err(),
            message
        );
        // A failed connection has no message of Orca's, so its own text is shown.
        let mut orca = fake(vec![(
            "git.switchBranch",
            Err(("Orca が起動していません", "")),
        )]);
        assert_eq!(
            switch_branch(&mut orca, "/w", "local", "local", "a")
                .await
                .unwrap_err(),
            "Orca が起動していません"
        );
    }

    #[tokio::test]
    async fn an_orca_without_the_switch_is_asked_to_be_updated() {
        let mut orca = fake(vec![(
            "git.switchBranch",
            Err((
                "Orca がエラーを返しました（method_not_found）",
                "Unknown method: git.switchBranch",
            )),
        )]);
        let error = switch_branch(&mut orca, "/w", "local", "local", "a")
            .await
            .unwrap_err();
        assert_eq!(error, UPDATE_ORCA);
        assert!(error.contains("Orca を更新"));
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
    fn a_diff_is_head_against_the_working_tree() {
        let got = parse_diff(
            &json!({"kind": "text", "originalContent": "a\nb\n", "modifiedContent": "a\nc\n",
                "originalIsBinary": false, "modifiedIsBinary": false}),
            "src/main.rs",
        )
        .unwrap();
        assert_eq!(got.old_lines, vec!["a", "b"]);
        assert_eq!(got.new_lines, vec!["a", "c"]);
        assert_eq!(got.side.len(), 2);
        assert_eq!(got.changes.len(), 1);
        assert_eq!(got.language, "rust");
        assert_eq!(got.highlight.as_deref(), Some("rust"));
    }

    #[test]
    fn a_diff_of_a_new_file_or_a_deleted_one_has_a_side_with_no_line() {
        let added = parse_diff(
            &json!({"kind": "text", "originalContent": "", "modifiedContent": "x\n"}),
            "a.rs",
        )
        .unwrap();
        assert!(added.old_lines.is_empty());
        assert_eq!(added.side.len(), 1);
        let gone = parse_diff(
            &json!({"kind": "text", "originalContent": "x\ny\n", "modifiedContent": "", "modifiedDeleted": true}),
            "a.rs",
        )
        .unwrap();
        assert!(gone.new_lines.is_empty());
        assert_eq!(gone.side.len(), 2);
        assert_eq!(gone.language, "rust");
        let no_text = parse_diff(
            &json!({"kind": "text", "originalContent": "x\n", "modifiedDeleted": true}),
            "a.rs",
        )
        .unwrap();
        assert!(no_text.new_lines.is_empty());
    }

    #[test]
    fn a_diff_that_cannot_be_drawn_is_refused_with_the_reason() {
        let text = json!({"originalContent": "a\n", "modifiedContent": "b\n"});
        let with = |key: &str, value: Value| {
            let mut answer = text.clone();
            answer[key] = value;
            parse_diff(&answer, "a.rs").unwrap_err()
        };
        let binary = "バイナリのファイルの差分は表示できません";
        assert_eq!(with("kind", json!("binary")), binary);
        assert_eq!(with("originalIsBinary", json!(true)), binary);
        assert_eq!(with("modifiedIsBinary", json!(true)), binary);
        assert_eq!(with("isImage", json!(true)), binary);
        assert_eq!(with("tooLarge", json!(true)), DIFF_TOO_LARGE);
        assert_eq!(with("largeDiffRenderLimit", json!(100_000)), DIFF_TOO_LARGE);
        assert!(parse_diff(&json!({"tooLarge": false, "largeDiffRenderLimit": null, "originalContent": "", "modifiedContent": ""}), "a").is_ok());
        let large = "384 KiB を超えるファイルの差分は表示できません";
        assert_eq!(
            with("originalContent", json!("a".repeat(MAX_TEXT + 1))),
            large
        );
        assert_eq!(
            with("modifiedContent", json!("a".repeat(MAX_TEXT + 1))),
            large
        );
        let big = json!({"originalContent": "a".repeat(MAX_TEXT), "modifiedContent": "a".repeat(MAX_TEXT)});
        assert!(parse_diff(&big, "a.txt").is_ok());
        let not_utf8 = "UTF-8 ではないファイルの差分は表示できません";
        assert_eq!(with("originalContent", json!("a\u{FFFD}")), not_utf8);
        assert_eq!(with("modifiedContent", json!("a\u{FFFD}")), not_utf8);
        assert_eq!(
            parse_diff(&json!({"modifiedContent": ""}), "a").unwrap_err(),
            "差分を読めません"
        );
        assert_eq!(
            parse_diff(&json!({"originalContent": ""}), "a").unwrap_err(),
            "差分を読めません"
        );
    }

    #[tokio::test]
    async fn a_diff_asks_for_head_against_the_working_tree() {
        let mut orca = fake(vec![("git.diff", Ok(json!({"kind": "text"})))]);
        git_diff(&mut orca, "/work/a", "src/a.rs").await.unwrap();
        assert_eq!(
            orca.calls[0],
            (
                "git.diff".to_owned(),
                json!({"worktree": "path:/work/a", "filePath": "src/a.rs", "staged": false, "compareAgainstHead": true})
            )
        );
        let mut orca = fake(vec![(
            "git.diff",
            Err((
                "Orca がエラーを返しました（runtime_error）",
                "diff_too_large",
            )),
        )]);
        assert_eq!(
            git_diff(&mut orca, "/work/a", "a").await.unwrap_err(),
            DIFF_TOO_LARGE
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
    fn a_new_name_is_one_trimmed_name() {
        assert_eq!(check_new_name("  a.rs "), Ok("a.rs"));
        assert_eq!(check_new_name("日本語.md"), Ok("日本語.md"));
        assert_eq!(check_new_name(".gitignore"), Ok(".gitignore"));
        let long = "a".repeat(255);
        assert_eq!(check_new_name(&long), Ok(long.as_str()));
        for bad in [
            "", "   ", ".", " .. ", "a/b", "/a", "a\\b", "a\nb", "a\tb", "a\u{7f}b",
        ] {
            assert_eq!(check_new_name(bad), Err(BAD_NAME.to_owned()), "{bad:?}");
        }
        // The limit counts bytes: 85 three-byte characters are 255.
        assert!(check_new_name(&"あ".repeat(85)).is_ok());
        assert!(check_new_name(&"あ".repeat(86)).is_err());
        assert!(check_new_name(&"a".repeat(256)).is_err());
    }

    #[test]
    fn the_path_of_a_new_entry_is_the_folder_and_the_name() {
        assert_eq!(new_relative("", " a.rs "), Ok("a.rs".into()));
        assert_eq!(new_relative("src/lib", "x"), Ok("src/lib/x".into()));
        assert!(new_relative("../x", "a").is_err());
        assert!(new_relative("/x", "a").is_err());
        assert!(new_relative("src", "a/b").is_err());
        assert!(new_relative("src", "..").is_err());
        let deep = vec!["d".repeat(200); 21].join("/");
        assert!(new_relative(&deep, "a").is_err());
    }

    #[tokio::test]
    async fn a_file_or_a_folder_is_made_with_its_own_call_on_the_host() {
        let mut orca = fake(vec![
            ("files.createFile", Ok(json!({"ok": true}))),
            ("files.createDir", Ok(json!({"ok": true}))),
        ]);
        assert_eq!(
            create(&mut orca, "/work/a", "local", "src/a.rs", false)
                .await
                .unwrap(),
            "src/a.rs"
        );
        assert_eq!(
            create(&mut orca, "/work/a", "local", "src/lib", true)
                .await
                .unwrap(),
            "src/lib"
        );
        assert_eq!(
            orca.calls,
            vec![
                (
                    "files.createFile".to_owned(),
                    json!({"worktree": "path:/work/a", "expectedExecutionHostId": "local", "relativePath": "src/a.rs"})
                ),
                (
                    "files.createDir".to_owned(),
                    json!({"worktree": "path:/work/a", "expectedExecutionHostId": "local", "relativePath": "src/lib"})
                ),
            ]
        );
    }

    #[tokio::test]
    async fn a_name_that_is_taken_is_said_so_and_other_failures_say_why() {
        for detail in [
            "EEXIST: file already exists, open '/work/a/a.rs'",
            "Directory already exists",
        ] {
            let mut orca = fake(vec![(
                "files.createFile",
                Err(("Orca がエラーを返しました（runtime_error）", detail)),
            )]);
            assert_eq!(
                create(&mut orca, "/work/a", "local", "a.rs", false)
                    .await
                    .unwrap_err(),
                "同じ名前があります"
            );
        }
        let mut orca = fake(vec![(
            "files.createDir",
            Err((
                "Orca がエラーを返しました（forbidden）",
                "EACCES: permission denied",
            )),
        )]);
        assert_eq!(
            create(&mut orca, "/work/a", "local", "x", true)
                .await
                .unwrap_err(),
            "Orca がエラーを返しました（forbidden）"
        );
        let mut orca = fake(vec![(
            "files.createFile",
            Err((
                "Orca がエラーを返しました（runtime_error）",
                "ENOENT: no such file",
            )),
        )]);
        assert_eq!(
            create(&mut orca, "/work/a", "local", "x", false)
                .await
                .unwrap_err(),
            "ファイルが見つかりません"
        );
        let mut orca = fake(vec![("files.createFile", Ok(json!({"ok": false})))]);
        assert_eq!(
            create(&mut orca, "/work/a", "local", "x", false)
                .await
                .unwrap_err(),
            "作成できませんでした"
        );
    }

    #[test]
    fn a_move_stays_in_the_worktree_and_out_of_its_own_source() {
        assert_eq!(check_move("a.md", "docs/a.md"), Ok(()));
        assert_eq!(check_move("src/lib", "lib"), Ok(()));
        assert_eq!(check_move("src", "src2/x"), Ok(()));
        assert_eq!(check_move("src/a.rs", "src/b.rs"), Ok(()));
        for (from, to) in [
            ("", "a"),
            ("a", ""),
            ("../a", "a"),
            ("a", "../a"),
            ("a", "/a"),
            ("a", "b/"),
            ("a", "b//c"),
            ("a", "./b"),
            ("a", "b\nc"),
            ("\\", "a"),
            ("a\\", "b"),
        ] {
            assert_eq!(
                check_move(from, to),
                Err("ファイルの場所が正しくありません".to_owned()),
                "{from:?} {to:?}"
            );
        }
        assert_eq!(check_move("a", "b\\c"), Err(BAD_NAME.to_owned()));
        assert_eq!(
            check_move("a", &format!("b/{}", "c".repeat(256))),
            Err(BAD_NAME.to_owned())
        );
        assert_eq!(
            check_move("src/a.rs", "src/a.rs"),
            Err(SAME_PLACE.to_owned())
        );
        assert_eq!(check_move("src", "src/lib"), Err(INTO_ITSELF.to_owned()));
        assert_eq!(
            check_move("src", "src/a/b/src"),
            Err(INTO_ITSELF.to_owned())
        );
    }

    /// An Orca that answers each call with the next of `answers`, in order, and keeps the calls.
    struct Script {
        answers: std::collections::VecDeque<Answer>,
        calls: Vec<(String, Value)>,
    }

    impl Rpc for Script {
        async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
            self.calls.push((method.to_owned(), params));
            match self.answers.pop_front().expect("an answer for the call") {
                Ok(value) => Ok(value),
                Err((shown, detail)) => Err(CallError {
                    shown: shown.into(),
                    detail: detail.into(),
                }),
            }
        }
    }

    fn script(answers: Vec<Answer>) -> Script {
        Script {
            answers: answers.into(),
            calls: Vec::new(),
        }
    }

    fn enoent() -> Answer {
        Err((
            "Orca がエラーを返しました（runtime_error）",
            "ENOENT: no such file or directory, rename '/work/a/a.md' -> '/work/a/x/y/a.md'",
        ))
    }

    fn exists() -> Answer {
        Err((
            "Orca がエラーを返しました（runtime_error）",
            "A file or folder named 'x' already exists in this location",
        ))
    }

    fn denied() -> Answer {
        Err((
            "Orca がエラーを返しました（forbidden）",
            "EACCES: permission denied",
        ))
    }

    fn methods(calls: &[(String, Value)]) -> Vec<&str> {
        calls.iter().map(|(method, _)| method.as_str()).collect()
    }

    #[tokio::test]
    async fn a_move_is_one_rename_with_both_paths_on_the_host() {
        let mut orca = script(vec![Ok(json!({"ok": true}))]);
        move_entry(&mut orca, "/work/a", "local", "src/a.rs", "docs/b.rs")
            .await
            .unwrap();
        assert_eq!(
            orca.calls,
            vec![(
                "files.rename".to_owned(),
                json!({"worktree": "path:/work/a", "expectedExecutionHostId": "local", "oldRelativePath": "src/a.rs", "newRelativePath": "docs/b.rs"})
            )]
        );
    }

    #[tokio::test]
    async fn the_missing_folders_of_the_target_are_made_and_the_rename_is_tried_once_more() {
        let mut orca = script(vec![
            enoent(),
            Ok(json!({"size": 1})),
            exists(),
            Ok(json!({"ok": true})),
            Ok(json!({"ok": true})),
        ]);
        move_entry(&mut orca, "/work/a", "local", "a.md", "x/y/a.md")
            .await
            .unwrap();
        assert_eq!(
            methods(&orca.calls),
            [
                "files.rename",
                "files.stat",
                "files.createDir",
                "files.createDir",
                "files.rename"
            ]
        );
        assert_eq!(
            orca.calls[1].1,
            json!({"worktree": "path:/work/a", "relativePath": "a.md"})
        );
        assert_eq!(orca.calls[2].1["relativePath"], "x");
        assert_eq!(orca.calls[3].1["relativePath"], "x/y");
        assert_eq!(orca.calls[4].1, orca.calls[0].1);
        // A `files.stat` that fails another way does not stop the move.
        let mut orca = script(vec![
            enoent(),
            denied(),
            Ok(json!({"ok": true})),
            Ok(json!({"ok": true})),
        ]);
        move_entry(&mut orca, "/work/a", "local", "a.md", "x/a.md")
            .await
            .unwrap();
        assert_eq!(orca.calls.len(), 4);
    }

    #[tokio::test]
    async fn a_source_that_is_gone_makes_no_folder_of_the_target() {
        let mut orca = script(vec![enoent(), enoent()]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "x/y/a.md")
                .await
                .unwrap_err(),
            "ファイルが見つかりません"
        );
        assert_eq!(methods(&orca.calls), ["files.rename", "files.stat"]);
    }

    #[test]
    fn a_change_of_case_alone_is_told_from_any_other_move() {
        assert!(case_only("a.md", "A.md"));
        assert!(case_only("src/Readme.MD", "src/README.md"));
        for (from, to) in [
            ("a.md", "b.md"),
            ("a.md", "x/A.md"),
            ("src/a.md", "Src/a.md"),
            ("src/a.md", "A.md"),
        ] {
            assert!(!case_only(from, to), "{from} {to}");
        }
    }

    #[tokio::test]
    async fn a_change_of_case_alone_goes_through_a_name_of_its_own_in_the_same_folder() {
        let mut orca = script(vec![Ok(json!({"ok": true})), Ok(json!({"ok": true}))]);
        move_entry(&mut orca, "/work/a", "local", "src/a.md", "src/A.md")
            .await
            .unwrap();
        assert_eq!(methods(&orca.calls), ["files.rename", "files.rename"]);
        let temp = orca.calls[0].1["newRelativePath"]
            .as_str()
            .unwrap()
            .to_owned();
        let name = temp.strip_prefix("src/.cookapps-rename-").unwrap();
        assert!(name.len() == 16 && name.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(orca.calls[0].1["oldRelativePath"], "src/a.md");
        assert_eq!(
            orca.calls[1].1,
            json!({"worktree": "path:/work/a", "expectedExecutionHostId": "local", "oldRelativePath": temp, "newRelativePath": "src/A.md"})
        );
        // The first rename fails: nothing else is called.
        let mut orca = script(vec![enoent()]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "A.md")
                .await
                .unwrap_err(),
            "ファイルが見つかりません"
        );
        assert_eq!(orca.calls.len(), 1);
        // The second fails (a disk that tells the cases apart holds `A.md`): the entry gets its name back, and the reason is the second's.
        let mut orca = script(vec![Ok(json!({"ok": true})), exists(), denied()]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "A.md")
                .await
                .unwrap_err(),
            "同じ名前があります"
        );
        assert_eq!(orca.calls.len(), 3);
        assert_eq!(
            orca.calls[2].1["oldRelativePath"],
            orca.calls[0].1["newRelativePath"]
        );
        assert!(!orca.calls[2].1["oldRelativePath"]
            .as_str()
            .unwrap()
            .contains('/'));
        assert_eq!(orca.calls[2].1["newRelativePath"], "a.md");
    }

    #[tokio::test]
    async fn a_source_that_is_gone_is_said_so_and_the_rename_is_not_tried_a_third_time() {
        // Every folder of the target is there: it is the source that is missing.
        let mut orca = script(vec![enoent(), Ok(json!({"size": 1})), exists()]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "x/a.md")
                .await
                .unwrap_err(),
            "ファイルが見つかりません"
        );
        assert_eq!(
            methods(&orca.calls),
            ["files.rename", "files.stat", "files.createDir"]
        );
        // A target at the root has no folder to make.
        let mut orca = script(vec![enoent(), enoent()]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "x/a.md", "a.md")
                .await
                .unwrap_err(),
            "ファイルが見つかりません"
        );
        assert_eq!(methods(&orca.calls), ["files.rename", "files.stat"]);
        // The second rename fails the same way.
        let mut orca = script(vec![
            enoent(),
            Ok(json!({"size": 1})),
            Ok(json!({"ok": true})),
            enoent(),
        ]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "x/a.md")
                .await
                .unwrap_err(),
            "ファイルが見つかりません"
        );
        assert_eq!(orca.calls.len(), 4);
    }

    #[tokio::test]
    async fn a_target_that_is_taken_is_said_so_and_other_failures_say_why() {
        let mut orca = script(vec![exists()]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "x")
                .await
                .unwrap_err(),
            "同じ名前があります"
        );
        assert_eq!(orca.calls.len(), 1);
        let mut orca = script(vec![denied()]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "b.md")
                .await
                .unwrap_err(),
            "Orca がエラーを返しました（forbidden）"
        );
        // A folder that cannot be made ends the move with its reason.
        let mut orca = script(vec![enoent(), Ok(json!({"size": 1})), denied()]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "x/a.md")
                .await
                .unwrap_err(),
            "Orca がエラーを返しました（forbidden）"
        );
        assert_eq!(orca.calls.len(), 3);
        let mut orca = script(vec![Ok(json!({"ok": false}))]);
        assert_eq!(
            move_entry(&mut orca, "/work/a", "local", "a.md", "b.md")
                .await
                .unwrap_err(),
            "移動できませんでした"
        );
    }

    #[test]
    fn the_root_of_the_worktree_is_never_deleted() {
        for bad in [
            "", "/", "..", "../a", "/a", "a/..", "a//b", "./a", "a/", "a\nb", "\\", "a\\", "\\\\",
        ] {
            assert!(check_written(bad, false).is_err(), "{bad:?}");
        }
        assert!(check_written("src/lib", false).is_ok());
        assert!(check_written(".git", false).is_ok());
        // A read may name a file whose name holds a `\`.
        assert!(check_relative("a\\b", false).is_ok());
    }

    #[tokio::test]
    async fn a_folder_is_deleted_recursively_and_a_file_is_not() {
        let mut orca = fake(vec![("files.delete", Ok(json!({"ok": true})))]);
        delete(&mut orca, "/work/a", "local", "src/lib", true)
            .await
            .unwrap();
        delete(&mut orca, "/work/a", "local", "src/a.rs", false)
            .await
            .unwrap();
        assert_eq!(
            orca.calls,
            vec![
                (
                    "files.delete".to_owned(),
                    json!({"worktree": "path:/work/a", "expectedExecutionHostId": "local", "relativePath": "src/lib", "recursive": true})
                ),
                (
                    "files.delete".to_owned(),
                    json!({"worktree": "path:/work/a", "expectedExecutionHostId": "local", "relativePath": "src/a.rs", "recursive": false})
                ),
            ]
        );
    }

    #[tokio::test]
    async fn a_failed_delete_says_why() {
        let mut orca = fake(vec![(
            "files.delete",
            Err((
                "Orca がエラーを返しました（forbidden）",
                "EACCES: permission denied",
            )),
        )]);
        assert_eq!(
            delete(&mut orca, "/work/a", "local", "x", false)
                .await
                .unwrap_err(),
            "Orca がエラーを返しました（forbidden）"
        );
        let mut orca = fake(vec![("files.delete", Ok(json!({"ok": false})))]);
        assert_eq!(
            delete(&mut orca, "/work/a", "local", "x", true)
                .await
                .unwrap_err(),
            "削除できませんでした"
        );
    }

    #[tokio::test]
    async fn a_scratchpad_file_is_made_in_its_folder_and_a_taken_name_is_the_existing_file() {
        let mut orca = fake(vec![("files.createFile", Ok(json!({"ok": true})))]);
        assert_eq!(
            create_scratchpad(&mut orca, "/work/a", "local", " memo.md ")
                .await
                .unwrap(),
            OrcaScratchpad {
                relative: ".orca/scratchpad/memo.md".into(),
                existed: false
            }
        );
        assert_eq!(
            orca.calls,
            vec![(
                "files.createFile".to_owned(),
                json!({"worktree": "path:/work/a", "expectedExecutionHostId": "local", "relativePath": ".orca/scratchpad/memo.md"})
            )]
        );
        let mut orca = fake(vec![(
            "files.createFile",
            Err((
                "Orca がエラーを返しました（runtime_error）",
                "EEXIST: file already exists, open '/work/a/.orca/scratchpad/memo.md'",
            )),
        )]);
        assert_eq!(
            create_scratchpad(&mut orca, "/work/a", "local", "memo.md")
                .await
                .unwrap(),
            OrcaScratchpad {
                relative: ".orca/scratchpad/memo.md".into(),
                existed: true
            }
        );
        // Another failure is a failure, and a bad name asks Orca nothing.
        let mut orca = fake(vec![(
            "files.createFile",
            Err((
                "Orca がエラーを返しました（forbidden）",
                "EACCES: permission denied",
            )),
        )]);
        assert_eq!(
            create_scratchpad(&mut orca, "/work/a", "local", "memo.md")
                .await
                .unwrap_err(),
            "Orca がエラーを返しました（forbidden）"
        );
        for bad in ["", "  ", "..", "a/b", "../x", "a\\b", "a\nb"] {
            let mut orca = fake(vec![]);
            assert_eq!(
                create_scratchpad(&mut orca, "/work/a", "local", bad)
                    .await
                    .unwrap_err(),
                "名前が正しくありません",
                "{bad:?}"
            );
            assert!(orca.calls.is_empty());
        }
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
        let saved = save_settings(&dir, 450).unwrap();
        assert_eq!(
            (
                saved.autosave_ms,
                saved.autosave_min,
                saved.autosave_max,
                saved.autosave_step
            ),
            (500, 100, 3000, 100)
        );
        assert_eq!(load_settings(&dir).autosave_ms, 500);
        assert_eq!(save_settings(&dir, 99_999).unwrap().autosave_ms, 3000);
        assert_eq!(load_settings(&dir).autosave_ms, 3000);
        assert!(!dir.join("editor-settings.json.tmp").exists());
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
