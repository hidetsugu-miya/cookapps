//! The decision pages of A-41: a child of a formation writes the input JSON of a page (a question or an approval for the owner), the leader hands its path to `formation_page`, and the page is checked here and recorded as "the child waits for the owner" in `formations/{name}/pages.json`. The screen reads the page through `formation_page_read`, which checks it again and resolves its evidence (the lines of a file, a node of a JSON file, the output of `git diff`).
//!
//! The input follows the input contract of the decision pages (`schema_version` 1, the page kinds `open-questions`, `approval` and `code-review`, the cards, blocks and evidence of `requirements/orca.md`, A-41). Every violation is a line `{path, message}` with a JSON path from `$`, and all of them are returned, never the first only.
//! Everything the page names is inside the repositories of the formation: a root and an evidence path are checked against the folders that Orca lists for this PC (`Allowed`), through the real path of each, so that `..`, an absolute path and a link cannot leave them; `.git` and the names that start with `.env` are never read, as `formation_read` does not.

use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex, PoisonError},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts,
    auth::config_dir,
    formation::{self, Child, Refusal, LOCAL},
    formation_server::Client,
    orca,
    orca_files::check_relative,
    yomiyasu_gate::{self, Gate},
};

/// `formations/{name}/pages.json`: the decision page that each child waits on.
const PAGES_FILE: &str = "pages.json";
const PAGES_LOCK: &str = "pages.json.lock";
/// The input JSON of a page, at most.
const PAGE_FILE_LIMIT: u64 = 512 * 1024;
/// A file that an excerpt or a node reads, at most.
const EVIDENCE_FILE_LIMIT: u64 = 2 * 1024 * 1024;
/// The lines of one excerpt, at most.
const EXCERPT_LINES: u32 = 400;
/// The text of one node, at most (bytes).
const NODE_TEXT_LIMIT: usize = 64 * 1024;
/// The output of one `git diff`, at most (bytes); a longer one is cut and marked.
const GIT_DIFF_LIMIT: usize = 200 * 1024;
const GIT_WAIT: Duration = Duration::from_secs(20);
/// The evidence items of one page, at most.
const EVIDENCE_COUNT: usize = 200;
/// The resolved page, at most (bytes): a frame of the server is 1 MiB.
const PAGE_LIMIT: usize = 700 * 1024;
/// How deep blocks nest (`folded`, `before-after`).
const BLOCK_DEPTH: usize = 6;
const DEFAULT_ROOT: &str = "deliverables";

// ---- the page as the screen gets it ----

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "kebab-case")]
pub enum PageKind {
    OpenQuestions,
    Approval,
    CodeReview,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum Subject {
    Requirement,
    Design,
    Code,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "kebab-case")]
pub enum CardKind {
    Question,
    Nr,
    MustFix,
    StructuralProposal,
    Adr,
    ReviewMustFix,
    ReviewDecision,
    UnmetCriterion,
}

impl CardKind {
    fn name(self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Nr => "nr",
            Self::MustFix => "must-fix",
            Self::StructuralProposal => "structural-proposal",
            Self::Adr => "adr",
            Self::ReviewMustFix => "review-must-fix",
            Self::ReviewDecision => "review-decision",
            Self::UnmetCriterion => "unmet-criterion",
        }
    }

    /// Whether the card offers lettered options (`A`, `B`, ...); the recommended one is always `A`.
    fn lettered(self) -> bool {
        matches!(self, Self::Question | Self::Nr | Self::ReviewDecision)
    }

    /// The fixed choices a card of this kind is recommended among (a lettered card: `A`); none for a card that takes no answer.
    fn choices(self) -> &'static [&'static str] {
        match self {
            Self::Question | Self::Nr | Self::ReviewDecision => &["A"],
            Self::MustFix => &["fix", "skip"],
            Self::StructuralProposal => &["approve", "reject", "hold"],
            Self::Adr => &["keep", "decline"],
            Self::ReviewMustFix => &["fix", "accept"],
            Self::UnmetCriterion => &[],
        }
    }
}

/// A page that has been checked, with its evidence resolved.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct DecisionPage {
    pub page_kind: PageKind,
    pub subject: Subject,
    pub context_label: String,
    pub title: String,
    /// The lead of 「何が変わるか」; only on `approval` and `code-review`.
    pub what: Option<String>,
    /// The roots of the page by name, as the real directories they are.
    pub roots: BTreeMap<String, String>,
    pub previous_reply: Option<String>,
    /// `open-questions`.
    pub questions: Vec<Card>,
    pub approval_scope: Vec<ScopeGroup>,
    pub changes: Vec<Change>,
    /// `nr` cards on `approval`, `review-decision` cards on `code-review`.
    pub needs_user_decision: Vec<Card>,
    /// `must-fix` cards on `approval`, `review-must-fix` cards on `code-review`.
    pub residual_must_fix: Vec<Card>,
    pub structural_proposals: Vec<Card>,
    pub adr: Option<Card>,
    pub risks: Option<Risks>,
    pub settled_decisions: Vec<SettledDecision>,
    pub quality_loop: Option<QualityLoop>,
    pub unmet_criteria: Vec<Card>,
    pub pr: Option<PagePr>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub kind: CardKind,
    pub number: String,
    pub title: String,
    pub summary: String,
    pub options: Vec<CardOption>,
    pub recommendation: Option<String>,
    pub recommendation_reason: Option<String>,
    pub background: Option<String>,
    pub facts: Vec<Fact>,
    pub blocks: Vec<Block>,
    pub evidence: Vec<Evidence>,
    /// The numbers of the cards that cause an `unmet-criterion` card.
    pub cards: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct CardOption {
    pub key: String,
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Fact {
    pub label: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Change {
    pub heading: String,
    pub blocks: Vec<Block>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct TableCell {
    pub text: String,
    pub changed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Block {
    Paragraph {
        text: String,
    },
    Heading {
        text: String,
    },
    List {
        items: Vec<String>,
    },
    Callout {
        text: String,
    },
    Table {
        header: Vec<String>,
        rows: Vec<Vec<TableCell>>,
    },
    BeforeAfter {
        before: Vec<Block>,
        after: Vec<Block>,
        #[serde(rename = "beforeCaption")]
        before_caption: Option<String>,
        #[serde(rename = "afterCaption")]
        after_caption: Option<String>,
    },
    Folded {
        summary: String,
        blocks: Vec<Block>,
    },
    Diagram {
        mermaid: String,
        caption: Option<String>,
    },
    Evidence {
        items: Vec<Evidence>,
    },
}

/// An evidence item as the screen draws it: what the file or git said when the page was read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Evidence {
    /// The lines `start` to `end` of a file (`lines`, without line ends), `highlight` the numbers of the lines to mark.
    Excerpt {
        root: String,
        path: String,
        start: u32,
        end: u32,
        highlight: Vec<u32>,
        note: Option<String>,
        lines: Vec<String>,
    },
    Diff {
        summary: String,
        name: String,
        before: Vec<String>,
        after: Vec<String>,
        note: Option<String>,
    },
    /// The output of `git diff {base} [{head}] -- {path}` in the repository of `root`; `truncated` when it was cut.
    GitDiff {
        summary: String,
        root: String,
        path: String,
        base: String,
        head: Option<String>,
        note: Option<String>,
        diff: String,
        truncated: bool,
    },
    /// A node of a JSON file, as the pretty-printed JSON of its value.
    Node {
        root: String,
        #[serde(rename = "ref")]
        reference: String,
        note: Option<String>,
        text: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct ScopeGroup {
    pub heading: String,
    pub items: Vec<ScopeItem>,
}

/// One thing the approval covers: a node of a deliverable (`reference`, with its `text`), or a file (`path`, which exists) with the files `extras` that belong to it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct ScopeItem {
    pub root: String,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub path: Option<String>,
    pub description: String,
    pub extras: Vec<String>,
    pub text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Risk {
    pub title: String,
    pub text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Risks {
    pub items: Vec<Risk>,
    pub evidence: Vec<Evidence>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct SettledDecision {
    pub id: String,
    pub decision: String,
    pub reason: String,
    pub evidence: Vec<Evidence>,
    pub provisional: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct QualityLoop {
    pub rounds: u32,
    pub must_fix_resolved: u32,
}

/// The pull request of a code review: `url` is `None` (with the reason in `note`) when none was made.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct PagePr {
    pub url: Option<String>,
    pub note: Option<String>,
}

/// The decision page that waits for the owner, as the card of a child draws it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct PendingPage {
    pub title: String,
    /// When `formation_page` recorded it (epoch milliseconds).
    #[cfg_attr(test, ts(type = "number"))]
    pub at_ms: i64,
}

// ---- the violations ----

/// One thing the input breaks: where (a JSON path from `$`) and what.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Violation {
    pub path: String,
    pub message: String,
}

/// The violations as lines of text, `{path}: {message}`.
pub fn violations_text(violations: &[Violation]) -> String {
    violations
        .iter()
        .map(|v| format!("{}: {}", v.path, v.message))
        .collect::<Vec<_>>()
        .join("\n")
}

fn alone(message: impl Into<String>) -> Vec<Violation> {
    vec![Violation {
        path: "$".into(),
        message: message.into(),
    }]
}

// ---- where a page may point ----

/// The folders a page may name: the repositories of this PC and their worktrees, as real paths. A path counts only when its real path (links followed) is inside one of them.
#[derive(Debug, Default)]
pub struct Allowed {
    dirs: Vec<PathBuf>,
}

fn check_names(relative: &Path) -> Result<(), String> {
    if relative
        .components()
        .any(|c| formation::is_secret_name(&c.as_os_str().to_string_lossy()))
    {
        return Err("`.git` の中と、`.env` で始まる名前は読めません".into());
    }
    Ok(())
}

/// `relative` is a clean path of `/`-separated names: no `..`, no `.`, no empty name, no `\`, no `.git` or `.env...`.
fn check_clean(relative: &str) -> Result<(), String> {
    check_relative(relative, false)
        .map_err(|_| "root の中の相対パスにしてください（絶対パス、`..`、空の名前は使えません）")?;
    if relative.contains('\\') {
        return Err("`\\` は使えません".into());
    }
    if relative.split('/').any(formation::is_secret_name) {
        return Err("`.git` の中と、`.env` で始まる名前は読めません".into());
    }
    Ok(())
}

impl Allowed {
    /// The folders given, as real paths; one that is not there is left out.
    pub fn new<I, S>(folders: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<Path>,
    {
        let mut dirs: Vec<PathBuf> = Vec::new();
        for folder in folders {
            if let Ok(real) = std::fs::canonicalize(folder.as_ref()) {
                if !dirs.contains(&real) {
                    dirs.push(real);
                }
            }
        }
        Self { dirs }
    }

    fn under(&self, real: &Path) -> Option<&Path> {
        self.dirs
            .iter()
            .map(PathBuf::as_path)
            .find(|dir| real.starts_with(dir))
    }

    /// A directory that a root names: an absolute path with no `..`, whose real path is a directory inside an allowed folder (and no name of `check_names` between).
    fn check_dir(&self, given: &str) -> Result<PathBuf, String> {
        let path = Path::new(given);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err("絶対パスにしてください（`..` は使えません）".into());
        }
        let real = std::fs::canonicalize(path).map_err(|_| "そのディレクトリはありません")?;
        if !real.is_dir() {
            return Err("ディレクトリではありません".into());
        }
        let Some(base) = self.under(&real) else {
            return Err("フォーメーションのリポジトリとその worktree の外です".into());
        };
        check_names(real.strip_prefix(base).unwrap_or(Path::new("")))?;
        Ok(real)
    }

    /// The page's own file: a file whose real path is inside the worktree of the child, or inside a `.feature-dev/` of a repository folder or worktree. The worktree must itself be inside an allowed folder, because the record names it and the orchestrator can write the record.
    fn check_page_file(&self, given: &str, worktree: &str) -> Result<PathBuf, String> {
        let path = Path::new(given);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err("ページのファイルは絶対パスで、`..` を含められません".into());
        }
        let file = std::fs::canonicalize(path).map_err(|_| "ページのファイルがありません")?;
        if !file.is_file() {
            return Err("ページのファイルがありません".into());
        }
        let tree = std::fs::canonicalize(worktree).map_err(|_| "子の worktree がありません")?;
        if self.under(&tree).is_none() {
            return Err("子の worktree が、フォーメーションのリポジトリの中にありません".into());
        }
        let base = if file.starts_with(&tree) {
            tree
        } else {
            match self
                .dirs
                .iter()
                .map(|dir| dir.join(".feature-dev"))
                .find(|dir| file.starts_with(dir))
            {
                Some(dir) => dir,
                None => {
                    return Err(
                        "ページのファイルは、その子の worktree か、リポジトリの `.feature-dev/` の下に置いてください"
                            .into(),
                    )
                }
            }
        };
        check_names(file.strip_prefix(&base).unwrap_or(Path::new("")))?;
        Ok(file)
    }
}

/// A file of `root` (a real path), by a clean relative path: its real path, which stays inside `root` whatever links lie on the way.
fn locate(root: &Path, relative: &str) -> Result<PathBuf, String> {
    check_clean(relative)?;
    let real = std::fs::canonicalize(root.join(relative)).map_err(|_| "ファイルがありません")?;
    let inner = real
        .strip_prefix(root)
        .map_err(|_| "root の外に出ています")?;
    check_names(inner)?;
    Ok(real)
}

/// The bytes of a regular file, at most `limit`.
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|_| "ファイルを読めません")?;
    if !meta.is_file() {
        return Err("ファイルではありません".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "ファイルを読めません")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "ファイルを読めません")?;
    if bytes.len() as u64 > limit {
        return Err(format!("大きすぎます（{} KiB まで）", limit / 1024));
    }
    Ok(bytes)
}

/// The lines of `text` as a decision page counts them: split on `\n` (a final line end makes no extra line), a trailing `\r` dropped.
fn lines_of(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
        .into_iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

/// The value at `pointer` (an RFC 6901 JSON Pointer) of `doc`. A token that meets an array and is no number picks the element of the array whose `id` is that token (`/requirements/REQ-03`, `/designs/DESIGN-02`); a number is an index, as RFC 6901 has it.
pub fn pointer_value<'a>(doc: &'a Value, pointer: &str) -> Option<&'a Value> {
    let rest = pointer.strip_prefix('/')?;
    let mut current = doc;
    for token in rest.split('/') {
        let token = token.replace("~1", "/").replace("~0", "~");
        current = match current {
            Value::Object(map) => map.get(&token)?,
            Value::Array(items) => match token.parse::<usize>() {
                Ok(index) if !token.starts_with('+') => items.get(index)?,
                _ => items
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(token.as_str()))?,
            },
            _ => return None,
        };
    }
    Some(current)
}

/// `{file}#{pointer}`: the file (a clean relative path ending `.json`) and the pointer (it starts with `/`).
fn split_ref(reference: &str) -> Result<(&str, &str), String> {
    let Some((file, pointer)) = reference.split_once('#') else {
        return Err("`{file}#{pointer}` の形にしてください".into());
    };
    if !pointer.starts_with('/') {
        return Err("`#` のあとは `/` で始まる JSON Pointer にしてください".into());
    }
    if !file.ends_with(".json") {
        return Err("ファイルは `.json` にしてください".into());
    }
    check_clean(file)?;
    Ok((file, pointer))
}

/// The text of the node `reference` of a JSON file under `root`.
fn node_text(root: &Path, reference: &str) -> Result<String, String> {
    let (file, pointer) = split_ref(reference)?;
    let real = locate(root, file)?;
    let bytes = read_bounded(&real, EVIDENCE_FILE_LIMIT)?;
    let doc: Value =
        serde_json::from_slice(&bytes).map_err(|_| "ファイルは JSON として読めません")?;
    let node = pointer_value(&doc, pointer).ok_or("その node はありません")?;
    let text = serde_json::to_string_pretty(node).map_err(|e| e.to_string())?;
    if text.len() > NODE_TEXT_LIMIT {
        return Err(format!(
            "node が大きすぎます（{} KiB まで）",
            NODE_TEXT_LIMIT / 1024
        ));
    }
    Ok(text)
}

/// A revision for `git diff`: a name, never an option, with no space or control character.
fn check_revision(revision: &str) -> Result<(), String> {
    if revision.is_empty()
        || revision.len() > 200
        || revision.starts_with('-')
        || revision
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("リビジョンが正しくありません".into());
    }
    Ok(())
}

/// The arguments of `git diff` as the decision pages run it (A-41): no pager, no external diff, no text conversion, and the pathspec read literally.
fn git_diff_args(path: &str, base: &str, head: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--literal-pathspecs",
        "-c",
        "core.quotepath=false",
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ]
    .map(str::to_owned)
    .to_vec();
    args.push(base.to_owned());
    if let Some(head) = head {
        args.push(head.to_owned());
    }
    args.push("--".into());
    args.push(path.to_owned());
    args
}

/// `git diff {base} [{head}] -- {path}` in `root`, at most `GIT_DIFF_LIMIT` bytes of it (the second value says it was cut) and `GIT_WAIT` of time. A diff with no change is an error.
fn git_diff(
    root: &Path,
    path: &str,
    base: &str,
    head: Option<&str>,
) -> Result<(String, bool), String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(git_diff_args(path, base, head))
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git を起動できません: {e}"))?;
    let (Some(out), Some(err)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("git の出力を読めません".into());
    };
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = out.take(GIT_DIFF_LIMIT as u64 + 1).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = err.take(4096).read_to_end(&mut bytes);
        bytes
    });
    let Ok(bytes) = receiver.recv_timeout(GIT_WAIT) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("git が時間内に終わりませんでした".into());
    };
    let truncated = bytes.len() > GIT_DIFF_LIMIT;
    if truncated {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&errors.join().unwrap_or_default()).into_owned();
    if !truncated && !status.success() {
        let line = stderr.lines().next().unwrap_or("git が失敗しました");
        return Err(format!("git diff が失敗しました: {line}"));
    }
    let used = &bytes[..bytes.len().min(GIT_DIFF_LIMIT)];
    if used.is_empty() {
        return Err("この二つの版のあいだで、そのパスに変更がありません".into());
    }
    Ok((String::from_utf8_lossy(used).into_owned(), truncated))
}

// ---- the walk: the checks and the resolution ----

struct Walk<'a> {
    allowed: &'a Allowed,
    /// The roots of the page: the real directory, or `None` for a root that failed its own check (its references add no error).
    roots: BTreeMap<String, Option<PathBuf>>,
    errors: Vec<Violation>,
    evidence: usize,
}

type Object = Map<String, Value>;

impl<'a> Walk<'a> {
    fn new(allowed: &'a Allowed) -> Self {
        Self {
            allowed,
            roots: BTreeMap::new(),
            errors: Vec::new(),
            evidence: 0,
        }
    }

    fn bad(&mut self, path: &str, message: impl Into<String>) {
        self.errors.push(Violation {
            path: path.to_owned(),
            message: message.into(),
        });
    }

    /// `value` as an object that has only the keys `keys` (every other key is a violation, in key order).
    fn keys<'v>(&mut self, value: &'v Value, path: &str, keys: &[&str]) -> Option<&'v Object> {
        let Some(map) = value.as_object() else {
            self.bad(path, "オブジェクトにしてください");
            return None;
        };
        for key in map.keys().filter(|key| !keys.contains(&key.as_str())) {
            self.bad(&format!("{path}.{key}"), "約束にないキーです");
        }
        Some(map)
    }

    /// A text of `map[key]`: not empty. A missing or null one is a violation only when `required`.
    fn text(&mut self, map: &Object, key: &str, path: &str, required: bool) -> Option<String> {
        let at = format!("{path}.{key}");
        match map.get(key) {
            None | Some(Value::Null) => {
                if required {
                    self.bad(&at, "必須です");
                }
                None
            }
            Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
            Some(Value::String(_)) => {
                self.bad(&at, "空にできません");
                None
            }
            Some(_) => {
                self.bad(&at, "文字列にしてください");
                None
            }
        }
    }

    /// An array of `map[key]`; a missing or null one is none, and a violation only when `required`.
    fn array<'v>(
        &mut self,
        map: &'v Object,
        key: &str,
        path: &str,
        required: bool,
    ) -> Option<&'v Vec<Value>> {
        let at = format!("{path}.{key}");
        match map.get(key) {
            None | Some(Value::Null) => {
                if required {
                    self.bad(&at, "必須です");
                }
                None
            }
            Some(Value::Array(items)) => Some(items),
            Some(_) => {
                self.bad(&at, "配列にしてください");
                None
            }
        }
    }

    /// An array that has at least one element.
    fn some<'v>(&mut self, map: &'v Object, key: &str, path: &str) -> Option<&'v Vec<Value>> {
        let items = self.array(map, key, path, true)?;
        if items.is_empty() {
            self.bad(&format!("{path}.{key}"), "1 件以上にしてください");
            return None;
        }
        Some(items)
    }

    fn uint(&mut self, map: &Object, key: &str, path: &str, required: bool) -> Option<u32> {
        let at = format!("{path}.{key}");
        match map.get(key) {
            None | Some(Value::Null) => {
                if required {
                    self.bad(&at, "必須です");
                }
                None
            }
            Some(value) => {
                let number = value.as_u64().and_then(|n| u32::try_from(n).ok());
                if number.is_none() {
                    self.bad(&at, "0 以上の整数にしてください");
                }
                number
            }
        }
    }

    fn flag(&mut self, map: &Object, key: &str, path: &str) -> bool {
        match map.get(key) {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => {
                self.bad(&format!("{path}.{key}"), "true か false にしてください");
                false
            }
        }
    }

    fn strings(&mut self, map: &Object, key: &str, path: &str, required: bool) -> Vec<String> {
        let Some(items) = self.array(map, key, path, required) else {
            return Vec::new();
        };
        let mut texts = Vec::new();
        for (at, item) in items.iter().enumerate() {
            match item.as_str() {
                Some(text) => texts.push(text.to_owned()),
                None => self.bad(&format!("{path}.{key}[{at}]"), "文字列にしてください"),
            }
        }
        texts
    }

    // -- roots --

    fn roots(&mut self, top: &Object) -> BTreeMap<String, String> {
        let mut shown = BTreeMap::new();
        let Some(Value::Object(map)) = top.get("roots") else {
            let message = if top.contains_key("roots") {
                "オブジェクトにしてください"
            } else {
                "必須です"
            };
            self.bad("$.roots", message);
            return shown;
        };
        for (name, value) in map {
            let at = format!("$.roots.{name}");
            let Some(given) = value.as_str() else {
                self.bad(&at, "絶対パスの文字列にしてください");
                self.roots.insert(name.clone(), None);
                continue;
            };
            match self.allowed.check_dir(given) {
                Ok(real) => {
                    shown.insert(name.clone(), real.to_string_lossy().into_owned());
                    self.roots.insert(name.clone(), Some(real));
                }
                Err(message) => {
                    self.bad(&at, message);
                    self.roots.insert(name.clone(), None);
                }
            }
        }
        shown
    }

    /// The root that `map["root"]` names (`deliverables` when it names none): its name and real directory. A root that is not in the page's `roots` is a violation; one that failed its own check is none, with no further error.
    fn root_of(&mut self, map: &Object, path: &str) -> Option<(String, PathBuf)> {
        let name = match map.get("root") {
            None | Some(Value::Null) => DEFAULT_ROOT.to_owned(),
            Some(_) => self.text(map, "root", path, true)?,
        };
        match self.roots.get(&name) {
            None => {
                self.bad(
                    &format!("{path}.root"),
                    format!("roots にない名前です: {name}"),
                );
                None
            }
            Some(None) => None,
            Some(Some(real)) => Some((name, real.clone())),
        }
    }

    // -- evidence --

    fn evidence_list(&mut self, value: &Value, path: &str) -> Vec<Evidence> {
        let Some(items) = value.as_array() else {
            self.bad(path, "配列にしてください");
            return Vec::new();
        };
        items
            .iter()
            .enumerate()
            .filter_map(|(at, item)| self.evidence_item(item, &format!("{path}[{at}]")))
            .collect()
    }

    fn evidence_of(&mut self, map: &Object, key: &str, path: &str) -> Vec<Evidence> {
        match map.get(key) {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => self.evidence_list(value, &format!("{path}.{key}")),
        }
    }

    fn evidence_item(&mut self, value: &Value, path: &str) -> Option<Evidence> {
        let kind = value.get("type").and_then(Value::as_str);
        let known = matches!(kind, Some("excerpt" | "diff" | "git-diff" | "node"));
        if !known {
            self.bad(
                &format!("{path}.type"),
                "excerpt、diff、git-diff、node のどれかにしてください",
            );
            return None;
        }
        self.evidence += 1;
        if self.evidence > EVIDENCE_COUNT {
            if self.evidence == EVIDENCE_COUNT + 1 {
                self.bad(path, format!("根拠は {EVIDENCE_COUNT} 件までです"));
            }
            return None;
        }
        match kind {
            Some("excerpt") => self.excerpt(value, path),
            Some("diff") => self.diff(value, path),
            Some("git-diff") => self.git_diff(value, path),
            _ => self.node(value, path),
        }
    }

    fn excerpt(&mut self, value: &Value, path: &str) -> Option<Evidence> {
        let map = self.keys(
            value,
            path,
            &["type", "root", "path", "start", "end", "highlight", "note"],
        )?;
        let root = self.root_of(map, path);
        let file = self.text(map, "path", path, true);
        let start = self.uint(map, "start", path, true);
        let end = self.uint(map, "end", path, false);
        let note = self.text(map, "note", path, false);
        let mut highlight = Vec::new();
        if let Some(items) = self.array(map, "highlight", path, false) {
            for (at, item) in items.iter().enumerate() {
                match item.as_u64().and_then(|n| u32::try_from(n).ok()) {
                    Some(line) => highlight.push(line),
                    None => self.bad(
                        &format!("{path}.highlight[{at}]"),
                        "行の番号（整数）にしてください",
                    ),
                }
            }
        }
        let start = start?;
        let end = end.unwrap_or(start);
        let mut valid = true;
        if start == 0 {
            self.bad(&format!("{path}.start"), "1 以上にしてください");
            valid = false;
        }
        if end < start {
            self.bad(&format!("{path}.end"), "start 以上にしてください");
            valid = false;
        } else if end - start + 1 > EXCERPT_LINES {
            self.bad(
                &format!("{path}.end"),
                format!("一つの抜粋は {EXCERPT_LINES} 行までです"),
            );
            valid = false;
        }
        if valid {
            if let Some(line) = highlight.iter().find(|line| **line < start || **line > end) {
                self.bad(
                    &format!("{path}.highlight"),
                    format!("{line} 行目は、{start} 行目から {end} 行目の外です"),
                );
                valid = false;
            }
        }
        let ((name, root), file) = (root?, file?);
        if !valid {
            return None;
        }
        let lines = self.read_lines(&root, &file, start, end, path)?;
        Some(Evidence::Excerpt {
            root: name,
            path: file,
            start,
            end,
            highlight,
            note,
            lines,
        })
    }

    fn read_lines(
        &mut self,
        root: &Path,
        file: &str,
        start: u32,
        end: u32,
        path: &str,
    ) -> Option<Vec<String>> {
        let at = format!("{path}.path");
        let read = locate(root, file).and_then(|real| read_bounded(&real, EVIDENCE_FILE_LIMIT));
        let bytes = match read {
            Ok(bytes) => bytes,
            Err(message) => {
                self.bad(&at, message);
                return None;
            }
        };
        let Ok(text) = String::from_utf8(bytes) else {
            self.bad(&at, "UTF-8 の文字ではありません");
            return None;
        };
        let lines = lines_of(&text);
        if end as usize > lines.len() {
            self.bad(
                &format!("{path}.end"),
                format!("ファイルは {} 行です", lines.len()),
            );
            return None;
        }
        Some(
            lines[start as usize - 1..end as usize]
                .iter()
                .map(|line| (*line).to_owned())
                .collect(),
        )
    }

    fn diff(&mut self, value: &Value, path: &str) -> Option<Evidence> {
        let map = self.keys(
            value,
            path,
            &["type", "summary", "name", "before", "after", "note"],
        )?;
        let summary = self.text(map, "summary", path, true);
        let name = self.text(map, "name", path, true);
        let note = self.text(map, "note", path, false);
        let before = self.diff_lines(map, "before", path);
        let after = self.diff_lines(map, "after", path);
        Some(Evidence::Diff {
            summary: summary?,
            name: name?,
            before: before?,
            after: after?,
            note,
        })
    }

    fn diff_lines(&mut self, map: &Object, key: &str, path: &str) -> Option<Vec<String>> {
        self.array(map, key, path, true)?;
        let lines = self.strings(map, key, path, true);
        for (at, line) in lines.iter().enumerate() {
            if line.contains('\n') {
                self.bad(&format!("{path}.{key}[{at}]"), "改行を含められません");
            }
        }
        Some(lines)
    }

    fn git_diff(&mut self, value: &Value, path: &str) -> Option<Evidence> {
        let map = self.keys(
            value,
            path,
            &["type", "summary", "root", "path", "base", "head", "note"],
        )?;
        let summary = self.text(map, "summary", path, true);
        let root = self.root_of(map, path);
        let file = self.text(map, "path", path, true);
        let base = self.text(map, "base", path, true);
        let note = self.text(map, "note", path, false);
        let head = match map.get("head") {
            None => {
                self.bad(&format!("{path}.head"), "必須です（作業ツリーは null）");
                None
            }
            Some(Value::Null) => Some(None),
            Some(_) => self.text(map, "head", path, true).map(Some),
        };
        let (summary, (name, root), file, base, head) = (summary?, root?, file?, base?, head?);
        let mut valid = true;
        if let Err(message) = check_clean(&file) {
            self.bad(&format!("{path}.path"), message);
            valid = false;
        }
        for (key, revision) in [("base", Some(&base)), ("head", head.as_ref())] {
            if let Some(Err(message)) = revision.map(|r| check_revision(r)) {
                self.bad(&format!("{path}.{key}"), message);
                valid = false;
            }
        }
        if !valid {
            return None;
        }
        match git_diff(&root, &file, &base, head.as_deref()) {
            Ok((diff, truncated)) => Some(Evidence::GitDiff {
                summary,
                root: name,
                path: file,
                base,
                head,
                note,
                diff,
                truncated,
            }),
            Err(message) => {
                self.bad(path, message);
                None
            }
        }
    }

    fn node(&mut self, value: &Value, path: &str) -> Option<Evidence> {
        let map = self.keys(value, path, &["type", "root", "ref", "note"])?;
        let root = self.root_of(map, path);
        let reference = self.text(map, "ref", path, true);
        let note = self.text(map, "note", path, false);
        let ((name, root), reference) = (root?, reference?);
        match node_text(&root, &reference) {
            Ok(text) => Some(Evidence::Node {
                root: name,
                reference,
                note,
                text,
            }),
            Err(message) => {
                self.bad(&format!("{path}.ref"), message);
                None
            }
        }
    }

    // -- blocks --

    fn blocks_of(&mut self, map: &Object, key: &str, path: &str, depth: usize) -> Vec<Block> {
        match map.get(key) {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => self.blocks(value, &format!("{path}.{key}"), depth),
        }
    }

    fn blocks(&mut self, value: &Value, path: &str, depth: usize) -> Vec<Block> {
        let Some(items) = value.as_array() else {
            self.bad(path, "配列にしてください");
            return Vec::new();
        };
        items
            .iter()
            .enumerate()
            .filter_map(|(at, item)| self.block(item, &format!("{path}[{at}]"), depth))
            .collect()
    }

    fn block(&mut self, value: &Value, path: &str, depth: usize) -> Option<Block> {
        if depth > BLOCK_DEPTH {
            self.bad(path, format!("ブロックの入れ子は {BLOCK_DEPTH} 段までです"));
            return None;
        }
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "paragraph" | "heading" | "callout" => {
                let map = self.keys(value, path, &["type", "text"])?;
                let text = self.text(map, "text", path, true)?;
                Some(match kind {
                    "paragraph" => Block::Paragraph { text },
                    "heading" => Block::Heading { text },
                    _ => Block::Callout { text },
                })
            }
            "list" => {
                let map = self.keys(value, path, &["type", "items"])?;
                self.some(map, "items", path)?;
                let items = self.strings(map, "items", path, true);
                Some(Block::List { items })
            }
            "table" => {
                let map = self.keys(value, path, &["type", "header", "rows"])?;
                let header = self.strings(map, "header", path, false);
                let rows = self.table_rows(map, path)?;
                Some(Block::Table { header, rows })
            }
            "before-after" => {
                let map = self.keys(
                    value,
                    path,
                    &["type", "before", "after", "before_caption", "after_caption"],
                )?;
                let before_caption = self.text(map, "before_caption", path, false);
                let after_caption = self.text(map, "after_caption", path, false);
                self.array(map, "before", path, true)?;
                self.array(map, "after", path, true)?;
                let before = self.blocks_of(map, "before", path, depth + 1);
                let after = self.blocks_of(map, "after", path, depth + 1);
                Some(Block::BeforeAfter {
                    before,
                    after,
                    before_caption,
                    after_caption,
                })
            }
            "folded" => {
                let map = self.keys(value, path, &["type", "summary", "blocks"])?;
                let summary = self.text(map, "summary", path, true);
                self.array(map, "blocks", path, true)?;
                let blocks = self.blocks_of(map, "blocks", path, depth + 1);
                Some(Block::Folded {
                    summary: summary?,
                    blocks,
                })
            }
            "diagram" => {
                let map = self.keys(value, path, &["type", "mermaid", "caption"])?;
                let mermaid = self.text(map, "mermaid", path, true);
                let caption = self.text(map, "caption", path, false);
                let mermaid = mermaid?;
                let first = mermaid
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .and_then(|line| line.split_whitespace().next())
                    .unwrap_or_default();
                if !matches!(
                    first,
                    "flowchart" | "graph" | "sequenceDiagram" | "stateDiagram" | "stateDiagram-v2"
                ) {
                    self.bad(
                        &format!("{path}.mermaid"),
                        "最初の語は flowchart、graph、sequenceDiagram、stateDiagram、stateDiagram-v2 のどれかにしてください",
                    );
                    return None;
                }
                Some(Block::Diagram { mermaid, caption })
            }
            "evidence" => {
                let map = self.keys(value, path, &["type", "items"])?;
                self.some(map, "items", path)?;
                let items = self.evidence_of(map, "items", path);
                Some(Block::Evidence { items })
            }
            _ => {
                self.bad(
                    &format!("{path}.type"),
                    "paragraph、heading、list、callout、table、before-after、folded、diagram、evidence のどれかにしてください",
                );
                None
            }
        }
    }

    fn table_rows(&mut self, map: &Object, path: &str) -> Option<Vec<Vec<TableCell>>> {
        let rows = self.some(map, "rows", path)?;
        let mut table = Vec::new();
        for (r, row) in rows.iter().enumerate() {
            let at = format!("{path}.rows[{r}]");
            let Some(cells) = row.as_array() else {
                self.bad(&at, "配列にしてください");
                continue;
            };
            let mut line = Vec::new();
            for (c, cell) in cells.iter().enumerate() {
                let at = format!("{at}[{c}]");
                match cell {
                    Value::String(text) => line.push(TableCell {
                        text: text.clone(),
                        changed: false,
                    }),
                    Value::Object(_) => {
                        if let Some(object) = self.keys(cell, &at, &["text", "changed"]) {
                            let text = object
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                            let changed = self.flag(object, "changed", &at);
                            match text {
                                Some(text) => line.push(TableCell { text, changed }),
                                None => self.bad(&format!("{at}.text"), "必須です"),
                            }
                        }
                    }
                    _ => self.bad(&at, "文字列か {text, changed} にしてください"),
                }
            }
            table.push(line);
        }
        Some(table)
    }

    // -- cards --

    fn cards(&mut self, top: &Object, key: &str, kind: CardKind, required: bool) -> Vec<Card> {
        let path = "$";
        let items = if required {
            self.some(top, key, path)
        } else {
            self.array(top, key, path, false)
        };
        let Some(items) = items else {
            return Vec::new();
        };
        items
            .iter()
            .enumerate()
            .filter_map(|(at, item)| self.card(item, &format!("$.{key}[{at}]"), kind))
            .collect()
    }

    fn card(&mut self, value: &Value, path: &str, expected: CardKind) -> Option<Card> {
        let mut keys = vec![
            "kind",
            "number",
            "title",
            "summary",
            "options",
            "recommendation",
            "recommendation_reason",
            "background",
            "facts",
            "blocks",
            "evidence",
        ];
        if expected == CardKind::UnmetCriterion {
            keys.push("cards");
        }
        let map = self.keys(value, path, &keys)?;
        match map.get("kind").and_then(Value::as_str) {
            Some(kind) if kind == expected.name() => {}
            _ => self.bad(
                &format!("{path}.kind"),
                format!("この欄に置けるカードの kind は {} です", expected.name()),
            ),
        }
        let number = self.text(map, "number", path, true);
        let title = self.text(map, "title", path, true);
        let summary = self.text(map, "summary", path, true);
        let options = self.options(map, path, expected);
        let (recommendation, recommendation_reason) = self.recommendation(map, path, expected);
        let background = self.text(map, "background", path, false);
        let facts = self.facts(map, path);
        let blocks = self.blocks_of(map, "blocks", path, 0);
        let evidence = self.evidence_of(map, "evidence", path);
        let cards = if expected == CardKind::UnmetCriterion {
            self.strings(map, "cards", path, false)
        } else {
            Vec::new()
        };
        Some(Card {
            kind: expected,
            number: number?,
            title: title?,
            summary: summary?,
            options,
            recommendation,
            recommendation_reason,
            background,
            facts,
            blocks,
            evidence,
            cards,
        })
    }

    fn options(&mut self, map: &Object, path: &str, kind: CardKind) -> Vec<CardOption> {
        if !kind.lettered() {
            if map.get("options").is_some_and(|v| !v.is_null()) {
                self.bad(
                    &format!("{path}.options"),
                    "この種類のカードに options は付けられません",
                );
            }
            return Vec::new();
        }
        let Some(items) = self.some(map, "options", path) else {
            return Vec::new();
        };
        let mut options = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("{path}.options[{at}]");
            let Some(option) = self.keys(item, &here, &["key", "label", "detail"]) else {
                continue;
            };
            let key = self.text(option, "key", &here, true);
            let label = self.text(option, "label", &here, true);
            let detail = self.text(option, "detail", &here, false);
            let letter = u8::try_from(at)
                .ok()
                .filter(|n| *n < 26)
                .map(|n| char::from(b'A' + n).to_string());
            if let (Some(key), Some(letter)) = (&key, &letter) {
                if key != letter {
                    self.bad(
                        &format!("{here}.key"),
                        format!("{letter} にしてください（A、B、C の順）"),
                    );
                }
            }
            if let (Some(key), Some(label)) = (key, label) {
                options.push(CardOption { key, label, detail });
            }
        }
        options
    }

    fn recommendation(
        &mut self,
        map: &Object,
        path: &str,
        kind: CardKind,
    ) -> (Option<String>, Option<String>) {
        if kind == CardKind::UnmetCriterion {
            for key in ["recommendation", "recommendation_reason"] {
                if map.get(key).is_some_and(|v| !v.is_null()) {
                    self.bad(
                        &format!("{path}.{key}"),
                        "この種類のカードは答えを求めないので付けられません",
                    );
                }
            }
            return (None, None);
        }
        let recommendation = self.text(map, "recommendation", path, true);
        let reason = self.text(map, "recommendation_reason", path, true);
        if let Some(choice) = &recommendation {
            if !kind.choices().contains(&choice.as_str()) {
                self.bad(
                    &format!("{path}.recommendation"),
                    format!("{} のどれかにしてください", kind.choices().join("、")),
                );
            }
        }
        (recommendation, reason)
    }

    fn facts(&mut self, map: &Object, path: &str) -> Vec<Fact> {
        let Some(items) = self.array(map, "facts", path, false) else {
            return Vec::new();
        };
        let mut facts = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("{path}.facts[{at}]");
            let Some(fact) = self.keys(item, &here, &["label", "value"]) else {
                continue;
            };
            let label = self.text(fact, "label", &here, true);
            let value = self.text(fact, "value", &here, true);
            if let (Some(label), Some(value)) = (label, value) {
                facts.push(Fact { label, value });
            }
        }
        facts
    }

    // -- the sections --

    fn changes(&mut self, top: &Object) -> Vec<Change> {
        let Some(items) = self.array(top, "changes", "$", false) else {
            return Vec::new();
        };
        let mut changes = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("$.changes[{at}]");
            let Some(change) = self.keys(item, &here, &["heading", "blocks"]) else {
                continue;
            };
            let heading = self.text(change, "heading", &here, true);
            self.array(change, "blocks", &here, true);
            let blocks = self.blocks_of(change, "blocks", &here, 0);
            if let Some(heading) = heading {
                changes.push(Change { heading, blocks });
            }
        }
        changes
    }

    fn scope(&mut self, top: &Object) -> Vec<ScopeGroup> {
        let Some(groups) = self.some(top, "approval_scope", "$") else {
            return Vec::new();
        };
        let mut scope = Vec::new();
        for (g, group) in groups.iter().enumerate() {
            let here = format!("$.approval_scope[{g}]");
            let Some(group) = self.keys(group, &here, &["heading", "items"]) else {
                continue;
            };
            let heading = self.text(group, "heading", &here, true);
            let mut items = Vec::new();
            if let Some(list) = self.some(group, "items", &here) {
                for (i, item) in list.iter().enumerate() {
                    if let Some(item) = self.scope_item(item, &format!("{here}.items[{i}]")) {
                        items.push(item);
                    }
                }
            }
            if let Some(heading) = heading {
                scope.push(ScopeGroup { heading, items });
            }
        }
        scope
    }

    fn scope_item(&mut self, value: &Value, path: &str) -> Option<ScopeItem> {
        let map = self.keys(
            value,
            path,
            &["root", "ref", "path", "description", "extras"],
        )?;
        let root = self.root_of(map, path);
        let reference = self.text(map, "ref", path, false);
        let file = self.text(map, "path", path, false);
        let description = self.text(map, "description", path, true);
        let extras = self.strings(map, "extras", path, false);
        match (&reference, &file) {
            (None, None) => self.bad(path, "ref か path のどちらかが要ります"),
            (Some(_), Some(_)) => self.bad(path, "ref と path は両方は付けられません"),
            _ => {}
        }
        if reference.is_some() && !extras.is_empty() {
            self.bad(&format!("{path}.extras"), "extras は path と一緒に使います");
        }
        let (name, root) = root?;
        let mut text = None;
        if let Some(reference) = &reference {
            match node_text(&root, reference) {
                Ok(node) => text = Some(node),
                Err(message) => self.bad(&format!("{path}.ref"), message),
            }
        }
        if let Some(file) = &file {
            if let Err(message) = locate(&root, file) {
                self.bad(&format!("{path}.path"), message);
            }
        }
        for (at, extra) in extras.iter().enumerate() {
            if let Err(message) = locate(&root, extra) {
                self.bad(&format!("{path}.extras[{at}]"), message);
            }
        }
        Some(ScopeItem {
            root: name,
            reference,
            path: file,
            description: description?,
            extras,
            text,
        })
    }

    fn risks(&mut self, top: &Object) -> Option<Risks> {
        let value = top.get("risks").filter(|v| !v.is_null())?;
        let map = self.keys(value, "$.risks", &["items", "evidence"])?;
        let mut items = Vec::new();
        if let Some(list) = self.some(map, "items", "$.risks") {
            for (at, item) in list.iter().enumerate() {
                let here = format!("$.risks.items[{at}]");
                let Some(risk) = self.keys(item, &here, &["title", "text"]) else {
                    continue;
                };
                let title = self.text(risk, "title", &here, true);
                let text = self.text(risk, "text", &here, false);
                if let Some(title) = title {
                    items.push(Risk { title, text });
                }
            }
        }
        let evidence = self.evidence_of(map, "evidence", "$.risks");
        Some(Risks { items, evidence })
    }

    fn settled(&mut self, top: &Object) -> Vec<SettledDecision> {
        let Some(items) = self.array(top, "settled_decisions", "$", false) else {
            return Vec::new();
        };
        let mut decisions = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("$.settled_decisions[{at}]");
            let Some(map) = self.keys(
                item,
                &here,
                &["id", "decision", "reason", "evidence", "provisional"],
            ) else {
                continue;
            };
            let id = self.text(map, "id", &here, true);
            let decision = self.text(map, "decision", &here, true);
            let reason = self.text(map, "reason", &here, true);
            let evidence = self.evidence_of(map, "evidence", &here);
            let provisional = self.flag(map, "provisional", &here);
            if let (Some(id), Some(decision), Some(reason)) = (id, decision, reason) {
                decisions.push(SettledDecision {
                    id,
                    decision,
                    reason,
                    evidence,
                    provisional,
                });
            }
        }
        decisions
    }

    fn quality_loop(&mut self, top: &Object) -> Option<QualityLoop> {
        let Some(value) = top.get("quality_loop").filter(|v| !v.is_null()) else {
            self.bad("$.quality_loop", "必須です");
            return None;
        };
        let map = self.keys(value, "$.quality_loop", &["rounds", "must_fix_resolved"])?;
        let rounds = self.uint(map, "rounds", "$.quality_loop", true);
        let resolved = self.uint(map, "must_fix_resolved", "$.quality_loop", true);
        Some(QualityLoop {
            rounds: rounds?,
            must_fix_resolved: resolved?,
        })
    }

    fn pr(&mut self, top: &Object) -> Option<PagePr> {
        let value = top.get("pr").filter(|v| !v.is_null())?;
        let map = self.keys(value, "$.pr", &["url", "note"])?;
        let url = self.text(map, "url", "$.pr", false);
        let note = self.text(map, "note", "$.pr", false);
        if url.is_none() && note.is_none() && !map.contains_key("url") {
            self.bad("$.pr.url", "必須です（PR がないときは null と note）");
        } else if url.is_none() && note.is_none() {
            self.bad(
                "$.pr.note",
                "url が null のときは理由を note に書いてください",
            );
        }
        Some(PagePr { url, note })
    }

    // -- the page --

    fn page(&mut self, value: &Value) -> Option<DecisionPage> {
        let top = value.as_object().or_else(|| {
            self.bad("$", "オブジェクトにしてください");
            None
        })?;
        let kind = match top.get("page_kind").and_then(Value::as_str) {
            Some("open-questions") => Some(PageKind::OpenQuestions),
            Some("approval") => Some(PageKind::Approval),
            Some("code-review") => Some(PageKind::CodeReview),
            _ => {
                self.bad(
                    "$.page_kind",
                    "open-questions、approval、code-review のどれかにしてください",
                );
                None
            }
        };
        let subject = match (kind, top.get("subject").and_then(Value::as_str)) {
            (Some(PageKind::CodeReview), Some("code")) => Some(Subject::Code),
            (Some(PageKind::OpenQuestions | PageKind::Approval), Some("requirement")) => {
                Some(Subject::Requirement)
            }
            (Some(PageKind::OpenQuestions | PageKind::Approval), Some("design")) => {
                Some(Subject::Design)
            }
            (Some(PageKind::CodeReview), _) => {
                self.bad("$.subject", "code にしてください");
                None
            }
            (Some(_), _) => {
                self.bad("$.subject", "requirement か design にしてください");
                None
            }
            (None, _) => None,
        };
        let (kind, subject) = (kind?, subject?);
        let mut keys = vec![
            "schema_version",
            "page_kind",
            "subject",
            "context_label",
            "title",
            "roots",
            "what",
            "previous_reply",
        ];
        keys.extend(match kind {
            PageKind::OpenQuestions => vec!["questions"],
            PageKind::Approval => vec![
                "approval_scope",
                "quality_loop",
                "changes",
                "needs_user_decision",
                "residual_must_fix",
                "structural_proposals",
                "adr",
                "risks",
                "settled_decisions",
            ],
            PageKind::CodeReview => vec![
                "changes",
                "residual_must_fix",
                "unmet_criteria",
                "needs_user_decision",
                "pr",
            ],
        });
        let top = self.keys(value, "$", &keys)?;
        if top.get("schema_version").and_then(Value::as_u64) != Some(1) {
            self.bad("$.schema_version", "1 にしてください");
        }
        let context_label = self.text(top, "context_label", "$", true);
        let title = self.text(top, "title", "$", true);
        let what = self.text(top, "what", "$", kind != PageKind::OpenQuestions);
        if kind == PageKind::OpenQuestions && top.get("what").is_some_and(|v| !v.is_null()) {
            self.bad("$.what", "open-questions のページには付けられません");
        }
        let previous_reply = match top.get("previous_reply") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(_) => {
                self.bad("$.previous_reply", "文字列にしてください");
                None
            }
        };
        let roots = self.roots(top);
        if subject != Subject::Design {
            for key in ["structural_proposals", "adr"] {
                if top.get(key).is_some_and(|v| !v.is_null()) {
                    self.bad(&format!("$.{key}"), "design のページだけに付けられます");
                }
            }
        }
        let mut page = DecisionPage {
            page_kind: kind,
            subject,
            context_label: context_label.unwrap_or_default(),
            title: title.unwrap_or_default(),
            what,
            roots,
            previous_reply,
            questions: Vec::new(),
            approval_scope: Vec::new(),
            changes: Vec::new(),
            needs_user_decision: Vec::new(),
            residual_must_fix: Vec::new(),
            structural_proposals: Vec::new(),
            adr: None,
            risks: None,
            settled_decisions: Vec::new(),
            quality_loop: None,
            unmet_criteria: Vec::new(),
            pr: None,
        };
        match kind {
            PageKind::OpenQuestions => {
                page.questions = self.cards(top, "questions", CardKind::Question, true);
            }
            PageKind::Approval => {
                page.approval_scope = self.scope(top);
                page.quality_loop = self.quality_loop(top);
                page.changes = self.changes(top);
                page.needs_user_decision =
                    self.cards(top, "needs_user_decision", CardKind::Nr, false);
                page.residual_must_fix =
                    self.cards(top, "residual_must_fix", CardKind::MustFix, false);
                if subject == Subject::Design {
                    page.structural_proposals = self.cards(
                        top,
                        "structural_proposals",
                        CardKind::StructuralProposal,
                        false,
                    );
                    page.adr = self.adr(top);
                }
                page.risks = self.risks(top);
                page.settled_decisions = self.settled(top);
            }
            PageKind::CodeReview => {
                page.changes = self.changes(top);
                page.residual_must_fix =
                    self.cards(top, "residual_must_fix", CardKind::ReviewMustFix, false);
                page.unmet_criteria =
                    self.cards(top, "unmet_criteria", CardKind::UnmetCriterion, false);
                page.needs_user_decision =
                    self.cards(top, "needs_user_decision", CardKind::ReviewDecision, false);
                page.pr = self.pr(top);
            }
        }
        if page.context_label.is_empty() || page.title.is_empty() {
            return None;
        }
        Some(page)
    }

    fn adr(&mut self, top: &Object) -> Option<Card> {
        let value = top.get("adr").filter(|v| !v.is_null())?;
        self.card(value, "$.adr", CardKind::Adr)
    }
}

/// Checks the input `value` of a decision page and resolves its evidence. Every violation is returned, in the order the input is walked; a page with any is not returned.
pub fn build(value: &Value, allowed: &Allowed) -> Result<DecisionPage, Vec<Violation>> {
    let mut walk = Walk::new(allowed);
    let page = walk.page(value);
    if !walk.errors.is_empty() {
        return Err(walk.errors);
    }
    let Some(page) = page else {
        return Err(alone("ページを読めませんでした"));
    };
    let size = serde_json::to_vec(&page).map_or(0, |bytes| bytes.len());
    if size > PAGE_LIMIT {
        return Err(alone(format!(
            "根拠を入れたページが大きすぎます（{} KiB まで）",
            PAGE_LIMIT / 1024
        )));
    }
    Ok(page)
}

/// Reads the page file `given` of a child that works in `worktree` as JSON (`Allowed::check_page_file`).
fn read_value(given: &str, worktree: &str, allowed: &Allowed) -> Result<Value, Vec<Violation>> {
    let file = allowed.check_page_file(given, worktree).map_err(alone)?;
    let bytes = read_bounded(&file, PAGE_FILE_LIMIT).map_err(alone)?;
    serde_json::from_slice(&bytes).map_err(|e| {
        alone(format!(
            "JSON として読めません（{} 行 {} 列）",
            e.line(),
            e.column()
        ))
    })
}

/// Reads the page file `given` of a child that works in `worktree` and checks it (`read_value`, then `build`).
pub fn load(
    given: &str,
    worktree: &str,
    allowed: &Allowed,
) -> Result<DecisionPage, Vec<Violation>> {
    build(&read_value(given, worktree, allowed)?, allowed)
}

// ---- the record: pages.json ----

/// What `formation_page` records for a child: the page it waits on (A-41).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PageRecord {
    pub child: String,
    /// The page's input file, as the child wrote it.
    pub path: String,
    pub title: String,
    pub page_kind: PageKind,
    pub subject: Subject,
    /// When it was recorded (epoch milliseconds).
    pub at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Pages {
    #[serde(default)]
    pages: Vec<PageRecord>,
}

fn read_pages_strict(config: &Path, formation: &str) -> Result<Vec<PageRecord>, String> {
    let path = formation::dir(config, formation).join(PAGES_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{} を読めません: {e}", path.display())),
    };
    serde_json::from_str::<Pages>(&text)
        .map(|pages| pages.pages)
        .map_err(|_| {
            format!(
                "{} の形式が正しくありません。記録を上書きしないよう、何も書いていません",
                path.display()
            )
        })
}

/// The pages recorded for `formation`; a missing or broken file reads as none.
pub fn read_pages(config: &Path, formation: &str) -> Vec<PageRecord> {
    read_pages_strict(config, formation).unwrap_or_default()
}

static PAGES: Mutex<()> = Mutex::new(());

/// Records `page` as the page of its child, in place of the one it had. The record is read, changed and written while the lock of this process and the `flock` on `pages.json.lock` are held (the tool of the orchestrator and the app are other processes), and the folder of a formation that was deleted is not made again.
fn put_page(config: &Path, formation: &str, page: PageRecord) -> Result<(), String> {
    let _held = PAGES.lock().unwrap_or_else(PoisonError::into_inner);
    if !formation::dir(config, formation).is_dir() {
        return Err(format!(
            "フォーメーション「{formation}」はありません（削除されました）"
        ));
    }
    let _other_processes = formation::lock_file(config, formation, PAGES_LOCK)?;
    let mut pages = read_pages_strict(config, formation)?;
    pages.retain(|p| p.child != page.child);
    pages.push(page);
    let text = serde_json::to_string_pretty(&Pages { pages }).map_err(|e| e.to_string())?;
    accounts::write_atomic(&formation::dir(config, formation), PAGES_FILE, &text)
}

/// The page of `child` that waits for the owner: the record of the child's page, unless it is older than the child's launch (a child of the same name that was closed and launched again does not wait on the page of the one before).
fn pending_record<'a>(child: &Child, pages: &'a [PageRecord]) -> Option<&'a PageRecord> {
    let launch = child.launch.as_ref()?;
    pages
        .iter()
        .find(|p| p.child == child.name && p.at >= launch.launched_at)
}

/// The mark of the page that waits on each child of `children`, in order.
pub fn pending_pages(children: &[Child], pages: &[PageRecord]) -> Vec<Option<PendingPage>> {
    children
        .iter()
        .map(|child| {
            pending_record(child, pages).map(|page| PendingPage {
                title: page.title.clone(),
                at_ms: i64::try_from(page.at).unwrap_or(i64::MAX),
            })
        })
        .collect()
}

/// Puts the marks of `pages` on `rows`, which `children_view_with` made one for each of `children`, in the same order.
pub fn mark_pending(
    rows: &mut [formation::FormationChild],
    children: &[Child],
    pages: &[PageRecord],
) {
    for (row, pending) in rows.iter_mut().zip(pending_pages(children, pages)) {
        row.pending_page = pending;
    }
}

/// The pages recorded for `formation`, wherever it is: its own `pages.json` for a formation of this Mac, and for a formation of a saved environment the one that PC's server answers (`pages.read`). A PC that cannot be asked, and a formation whose orchestrator never started on its PC, have none: the screen draws no mark then, and the read of the children goes on.
pub fn pages_of(
    config: &Path,
    formation: &str,
    open: &impl AsyncFn(&str) -> Result<Client, String>,
) -> Vec<PageRecord> {
    let (environment, started) = formation::formation_home(config, formation);
    if environment == LOCAL {
        return read_pages(config, formation);
    }
    if !started {
        return Vec::new();
    }
    formation::on_pc(
        &environment,
        open,
        formation::SAVED_PS_TIMEOUT,
        async |client| client.pages_read(formation).await,
    )
    .unwrap_or_default()
}

// ---- the tool of the orchestrator ----

/// The refusal of a page with violations: nothing is recorded, and the list is the answer, so that the orchestrator can send it back to the child.
fn violations_refusal(violations: &[Violation]) -> Refusal {
    Refusal::from(format!(
        "判断ページに {} 件の違反があります。何も記録していません。子に直させて、もう一度 formation_page を呼んでください",
        violations.len()
    ))
    .with("violations", serde_json::to_value(violations).unwrap_or_default())
}

/// The refusal of a page whose Japanese is not in a yomiyasu final text (the gate, `yomiyasu_gate.rs`): nothing is recorded, and the lines are the answer, so that the orchestrator can have them polished together with the rest of the page.
fn unpolished_refusal(lines: &[String]) -> Refusal {
    Refusal::from(format!(
        "判断ページの日本語 {} 行が、yomiyasu の最終稿の記録にありません。何も記録していません。ページの日本語を、この行も含めて 1 回の yomiyasu で推敲させ、もう一度 formation_page を呼んでください",
        lines.len()
    ))
    .with("unpolished", lines)
}

/// `formation_page`: the page file `path` of the launched child `child`, checked against `allowed` and the yomiyasu `gate`, and recorded as the page the child waits on. A page with a violation is refused, with all of them, and so is a page with a line that no final text of yomiyasu holds; nothing is recorded.
fn record_with(
    config: &Path,
    formation: &str,
    child: &str,
    path: &str,
    allowed: &Allowed,
    at: u64,
    gate: &Gate,
) -> Result<Value, Refusal> {
    formation::check_name(child)?;
    let record = formation::read_record(config, formation)?;
    let Some(entry) = record.iter().find(|c| c.name == child) else {
        return Err(Refusal::from(format!(
            "「{child}」という子は記録にありません。formation_launch で起動した子の名前にしてください"
        )));
    };
    let Some(launch) = &entry.launch else {
        return Err(Refusal::from(format!(
            "「{child}」はまだ起動していません。起動した子のページだけ受けます"
        )));
    };
    let value = read_value(path, &launch.path, allowed).map_err(|v| violations_refusal(&v))?;
    let page = build(&value, allowed).map_err(|v| violations_refusal(&v))?;
    let unpolished = gate.unpolished(&yomiyasu_gate::page_texts(&value));
    if !unpolished.is_empty() {
        return Err(unpolished_refusal(&unpolished));
    }
    put_page(
        config,
        formation,
        PageRecord {
            child: child.to_owned(),
            path: path.to_owned(),
            title: page.title.clone(),
            page_kind: page.page_kind,
            subject: page.subject,
            at,
        },
    )?;
    Ok(json!({
        "child": child,
        "title": page.title,
        "pageKind": page.page_kind,
        "subject": page.subject,
    }))
}

/// This PC's repository folders and their worktrees (Orca's lists), as what a page may point into.
fn allowed_here() -> Result<Allowed, Refusal> {
    formation::repo_folders().map(Allowed::new)
}

/// The tool `formation_page` of `tsunagiai-mcp --formation` (A-41).
pub fn record(config: &Path, formation: &str, child: &str, path: &str) -> Result<Value, Refusal> {
    let allowed = allowed_here()?;
    record_with(
        config,
        formation,
        child,
        path,
        &allowed,
        formation::now_ms(),
        &Gate::here(),
    )
}

// ---- the read of the screen ----

/// The record of the page that waits on `child` and the worktree the child works in: the checks that need no Orca.
fn waiting_page(
    config: &Path,
    formation: &str,
    child: &str,
) -> Result<(PageRecord, String), String> {
    formation::check_name(formation)?;
    formation::check_name(child)?;
    let record = formation::read_record(config, formation)?;
    let entry = record
        .iter()
        .find(|c| c.name == child)
        .ok_or_else(|| format!("「{child}」という子は記録にありません"))?;
    let pages = read_pages(config, formation);
    let page = pending_record(entry, &pages)
        .ok_or_else(|| format!("「{child}」に判断待ちのページはありません"))?;
    let worktree = entry
        .launch
        .as_ref()
        .map(|launch| launch.path.clone())
        .unwrap_or_default();
    Ok((page.clone(), worktree))
}

#[cfg(test)]
fn read_with(
    config: &Path,
    formation: &str,
    child: &str,
    allowed: &Allowed,
) -> Result<DecisionPage, String> {
    let (page, worktree) = waiting_page(config, formation, child)?;
    load(&page.path, &worktree, allowed).map_err(|v| violations_text(&v))
}

/// The page that waits on `child` of a formation whose record is on this machine, checked again and with its evidence resolved now (`page.read` of the server, and the read of a formation of this Mac).
pub fn read_here(config: &Path, formation: &str, child: &str) -> Result<DecisionPage, String> {
    let (page, worktree) = waiting_page(config, formation, child)?;
    let allowed = allowed_here().map_err(|r| formation::refusal_text(&r))?;
    load(&page.path, &worktree, &allowed).map_err(|v| violations_text(&v))
}

/// The page of `child` for the screen: read here for a formation of this Mac, and by the server of its PC for a formation of a saved environment, which checks it and resolves it there (the files are on that PC).
fn page_for_screen(
    config: &Path,
    formation: &str,
    child: &str,
    open: &impl AsyncFn(&str) -> Result<Client, String>,
) -> Result<DecisionPage, String> {
    formation::check_name(formation)?;
    let (environment, started) = formation::formation_home(config, formation);
    if environment == LOCAL {
        return read_here(config, formation, child);
    }
    if !started {
        return Err(format!("「{child}」に判断待ちのページはありません"));
    }
    formation::on_pc(
        &environment,
        open,
        formation::PC_RECORD_WAIT,
        async |client| client.page_read(formation, child).await,
    )
}

/// The decision page that waits on the child `child` of the formation `name`, checked and with its evidence resolved (A-41). A failure carries the message: the violations, one on each line, or why the page could not be read.
#[tauri::command]
pub async fn formation_page_read(
    app: tauri::AppHandle,
    name: String,
    child: String,
) -> Result<DecisionPage, String> {
    let dir = config_dir(&app)?;
    let version = app.package_info().version.to_string();
    orca::blocking(move || {
        page_for_screen(
            &dir,
            &name,
            &child,
            &formation::pc_connect(&dir, &version, true),
        )
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-page-{name}-{}-{}",
            std::process::id(),
            formation::now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // The real path, so that a link on the way (/var on a Mac) does not make two names of one folder.
        fs::canonicalize(dir).unwrap()
    }

    fn write(dir: &Path, relative: &str, text: &str) {
        let path = dir.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// A repository with a case root, a source file and a commit that changed the source.
    struct Repo {
        dir: PathBuf,
    }

    fn repo(name: &str) -> Repo {
        let dir = temp_dir(name);
        git(&dir, &["init", "-q", "-b", "main"]);
        write(
            &dir,
            "src/main.rs",
            "fn one() {}\nfn two() {}\nfn three() {}\n",
        );
        write(
            &dir,
            ".feature-dev/current/design.json",
            r#"{"designs": [{"id": "DESIGN-01", "title": "first"}, {"id": "DESIGN-02", "title": "second"}], "requirements": [{"id": "REQ-03", "name": "third"}], "meta": {"a/b": 1, "c~d": 2}}"#,
        );
        write(&dir, ".feature-dev/current/notes.md", "notes\n");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "first"]);
        write(
            &dir,
            "src/main.rs",
            "fn one() {}\nfn two2() {}\nfn three() {}\n",
        );
        git(&dir, &["commit", "-q", "-am", "second"]);
        Repo { dir }
    }

    impl Repo {
        fn allowed(&self) -> Allowed {
            Allowed::new([&self.dir])
        }

        fn root(&self) -> String {
            self.dir.to_string_lossy().into_owned()
        }

        fn case_root(&self) -> String {
            self.dir
                .join(".feature-dev/current")
                .to_string_lossy()
                .into_owned()
        }
    }

    fn question(number: &str) -> Value {
        json!({
            "kind": "question",
            "number": number,
            "title": "どちらにしますか",
            "summary": "要約",
            "options": [
                {"key": "A", "label": "案 A"},
                {"key": "B", "label": "案 B", "detail": "詳しく"}
            ],
            "recommendation": "A",
            "recommendation_reason": "理由"
        })
    }

    fn open_questions(repo: &Repo) -> Value {
        json!({
            "schema_version": 1,
            "page_kind": "open-questions",
            "subject": "requirement",
            "context_label": "要件定義の確認",
            "title": "確認したいこと",
            "roots": {"deliverables": repo.case_root(), "repo": repo.root()},
            "questions": [question("論点1")]
        })
    }

    fn approval(repo: &Repo) -> Value {
        json!({
            "schema_version": 1,
            "page_kind": "approval",
            "subject": "design",
            "context_label": "基本設計の承認依頼",
            "title": "承認してください",
            "what": "設計を決めました",
            "roots": {"deliverables": repo.case_root(), "repo": repo.root()},
            "approval_scope": [{
                "heading": "設計項目",
                "items": [
                    {"ref": "design.json#/designs/DESIGN-01", "description": "DESIGN-01 first"},
                    {"path": "notes.md", "description": "notes"}
                ]
            }],
            "quality_loop": {"rounds": 2, "must_fix_resolved": 3}
        })
    }

    fn paths(violations: &[Violation]) -> Vec<&str> {
        violations.iter().map(|v| v.path.as_str()).collect()
    }

    fn violations(value: &Value, repo: &Repo) -> Vec<Violation> {
        build(value, &repo.allowed()).unwrap_err()
    }

    // -- accepted --

    #[test]
    fn an_open_questions_page_is_accepted() {
        let repo = repo("accept-questions");
        let page = build(&open_questions(&repo), &repo.allowed()).unwrap();
        assert_eq!(page.page_kind, PageKind::OpenQuestions);
        assert_eq!(page.questions.len(), 1);
        assert_eq!(page.questions[0].options[1].key, "B");
        assert_eq!(page.roots["repo"], repo.root());
        assert_eq!(page.what, None);
    }

    #[test]
    fn an_approval_page_resolves_the_nodes_it_covers() {
        let repo = repo("accept-approval");
        let page = build(&approval(&repo), &repo.allowed()).unwrap();
        let items = &page.approval_scope[0].items;
        assert!(items[0].text.as_deref().unwrap().contains("\"first\""));
        assert_eq!(items[0].root, "deliverables");
        assert_eq!(items[1].path.as_deref(), Some("notes.md"));
        assert_eq!(page.quality_loop.unwrap().must_fix_resolved, 3);
    }

    #[test]
    fn a_code_review_page_with_every_card_kind_and_block_is_accepted() {
        let repo = repo("accept-code");
        let value = json!({
            "schema_version": 1,
            "page_kind": "code-review",
            "subject": "code",
            "context_label": "コードレビュー",
            "title": "変更の確認",
            "what": "変えました",
            "roots": {"deliverables": repo.case_root(), "repo": repo.root()},
            "changes": [{"heading": "変更", "blocks": [
                {"type": "paragraph", "text": "本文"},
                {"type": "heading", "text": "見出し"},
                {"type": "list", "items": ["a", "b"]},
                {"type": "callout", "text": "注意"},
                {"type": "table", "header": ["x", "y"], "rows": [["1", {"text": "2", "changed": true}]]},
                {"type": "before-after", "before": [{"type": "paragraph", "text": "前"}], "after": [{"type": "paragraph", "text": "後"}], "before_caption": "今"},
                {"type": "folded", "summary": "開く", "blocks": [{"type": "paragraph", "text": "中"}]},
                {"type": "diagram", "mermaid": "\nflowchart TD\n  A --> B", "caption": "図"},
                {"type": "evidence", "items": [
                    {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 1, "end": 2, "highlight": [2], "note": "ここ"},
                    {"type": "diff", "summary": "差", "name": "x", "before": ["a"], "after": ["b"]},
                    {"type": "git-diff", "summary": "差", "root": "repo", "path": "src/main.rs", "base": "HEAD~1", "head": "HEAD"},
                    {"type": "node", "root": "deliverables", "ref": "design.json#/designs/1"}
                ]}
            ]}],
            "residual_must_fix": [{
                "kind": "review-must-fix", "number": "CR-1", "title": "t", "summary": "s",
                "recommendation": "fix", "recommendation_reason": "r",
                "facts": [{"label": "検出元", "value": "v"}], "background": "b"
            }],
            "unmet_criteria": [{
                "kind": "unmet-criterion", "number": "UC-1", "title": "t", "summary": "s",
                "cards": ["ND-1"]
            }],
            "needs_user_decision": [{
                "kind": "review-decision", "number": "ND-1", "title": "t", "summary": "s",
                "options": [{"key": "A", "label": "a"}],
                "recommendation": "A", "recommendation_reason": "r"
            }],
            "pr": {"url": null, "note": "まだありません"}
        });
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(page.changes[0].blocks.len(), 9);
        assert_eq!(page.unmet_criteria[0].cards, ["ND-1"]);
        assert_eq!(page.pr.unwrap().url, None);
        let Block::Evidence { items } = &page.changes[0].blocks[8] else {
            panic!("an evidence block");
        };
        let Evidence::Excerpt {
            lines, highlight, ..
        } = &items[0]
        else {
            panic!("an excerpt");
        };
        assert_eq!(lines, &["fn one() {}", "fn two2() {}"]);
        assert_eq!(highlight, &[2]);
        let Evidence::Node { text, .. } = &items[3] else {
            panic!("a node");
        };
        assert!(text.contains("second"));
    }

    // -- the contract --

    #[test]
    fn every_violation_is_returned_with_its_json_path() {
        let repo = repo("violations");
        let mut value = open_questions(&repo);
        value["extra"] = json!(1);
        value["title"] = json!("");
        value["what"] = json!("x");
        value["questions"][0]["options"][1]["key"] = json!("C");
        value["questions"][0]["recommendation"] = json!("B");
        value["questions"][0]["scene"] = json!("not in the contract");
        value["questions"][0]["evidence"] =
            json!([{"type": "excerpt", "root": "nowhere", "path": "a", "start": 1}]);
        let found = violations(&value, &repo);
        let mut at = paths(&found);
        at.sort_unstable();
        assert_eq!(
            at,
            [
                "$.extra",
                "$.questions[0].evidence[0].root",
                "$.questions[0].options[1].key",
                "$.questions[0].recommendation",
                "$.questions[0].scene",
                "$.title",
                "$.what",
            ]
        );
    }

    #[test]
    fn the_page_kind_and_the_subject_go_together() {
        let repo = repo("kinds");
        let mut value = open_questions(&repo);
        value["page_kind"] = json!("pr-code-review");
        assert_eq!(paths(&violations(&value, &repo)), ["$.page_kind"]);
        let mut value = open_questions(&repo);
        value["subject"] = json!("code");
        assert_eq!(paths(&violations(&value, &repo)), ["$.subject"]);
        let mut value = approval(&repo);
        value["subject"] = json!("requirement");
        value["adr"] = json!({"kind": "adr", "number": "AD-1", "title": "t", "summary": "s", "recommendation": "keep", "recommendation_reason": "r"});
        assert_eq!(paths(&violations(&value, &repo)), ["$.adr"]);
    }

    #[test]
    fn a_card_of_another_kind_and_a_missing_recommendation_are_violations() {
        let repo = repo("cards");
        let mut value = open_questions(&repo);
        value["questions"][0]["kind"] = json!("nr");
        value["questions"][0]
            .as_object_mut()
            .unwrap()
            .remove("recommendation_reason");
        let found = violations(&value, &repo);
        assert_eq!(
            paths(&found),
            [
                "$.questions[0].kind",
                "$.questions[0].recommendation_reason"
            ]
        );
        let mut value = open_questions(&repo);
        value["questions"] = json!([]);
        assert_eq!(paths(&violations(&value, &repo)), ["$.questions"]);
    }

    #[test]
    fn a_must_fix_card_is_recommended_among_its_fixed_choices_and_takes_no_options() {
        let repo = repo("must-fix");
        let mut value = approval(&repo);
        value["residual_must_fix"] = json!([{
            "kind": "must-fix", "number": "MF-1", "title": "t", "summary": "s",
            "recommendation": "A", "recommendation_reason": "r",
            "options": [{"key": "A", "label": "a"}]
        }]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.residual_must_fix[0].options",
                "$.residual_must_fix[0].recommendation"
            ]
        );
    }

    #[test]
    fn blocks_and_evidence_of_an_unknown_type_are_violations() {
        let repo = repo("blocks");
        let mut value = approval(&repo);
        value["changes"] = json!([{"heading": "h", "blocks": [
            {"type": "image", "root": "repo", "path": "a.png", "caption": "c"},
            {"type": "diagram", "mermaid": "pie\n \"a\": 1"},
            {"type": "list", "items": []},
            {"type": "evidence", "items": [{"type": "current", "note": "n", "excerpts": []}]}
        ]}]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.changes[0].blocks[0].type",
                "$.changes[0].blocks[1].mermaid",
                "$.changes[0].blocks[2].items",
                "$.changes[0].blocks[3].items[0].type",
            ]
        );
    }

    #[test]
    fn blocks_nest_only_so_deep() {
        let repo = repo("depth");
        let mut block = json!({"type": "paragraph", "text": "t"});
        for _ in 0..8 {
            block = json!({"type": "folded", "summary": "s", "blocks": [block]});
        }
        let mut value = approval(&repo);
        value["changes"] = json!([{"heading": "h", "blocks": [block]}]);
        assert!(!violations(&value, &repo).is_empty());
    }

    // -- the boundary --

    #[test]
    fn a_root_outside_the_repositories_is_refused() {
        let repo = repo("root-outside");
        let outside = temp_dir("root-outside-other");
        let mut value = open_questions(&repo);
        value["roots"]["elsewhere"] = json!(outside.to_string_lossy());
        value["roots"]["relative"] = json!("src");
        value["roots"]["parent"] = json!(format!("{}/src/..", repo.root()));
        value["roots"]["gone"] = json!(format!("{}/nothing", repo.root()));
        value["roots"]["git"] = json!(format!("{}/.git", repo.root()));
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.roots.elsewhere",
                "$.roots.git",
                "$.roots.gone",
                "$.roots.parent",
                "$.roots.relative",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_that_leaves_the_repository_is_refused_for_a_root_and_for_a_file() {
        let repo = repo("link");
        let outside = temp_dir("link-outside");
        write(&outside, "secret.txt", "secret\n");
        std::os::unix::fs::symlink(&outside, repo.dir.join("out")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), repo.dir.join("src/secret.txt"))
            .unwrap();
        let mut value = open_questions(&repo);
        value["roots"]["viaLink"] = json!(format!("{}/out", repo.root()));
        value["questions"][0]["evidence"] = json!([
            {"type": "excerpt", "root": "repo", "path": "src/secret.txt", "start": 1}
        ]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            ["$.roots.viaLink", "$.questions[0].evidence[0].path"]
        );
    }

    #[test]
    fn a_path_that_leaves_its_root_or_names_a_secret_is_refused() {
        let repo = repo("paths");
        write(&repo.dir, ".env", "TOKEN=1\n");
        write(&repo.dir, ".env.local", "TOKEN=2\n");
        let mut value = open_questions(&repo);
        let bad = [
            "../x",
            "/etc/passwd",
            "src//main.rs",
            "./src/main.rs",
            ".git/config",
            ".env",
            ".env.local",
            "src/../src/main.rs",
            "src\\main.rs",
            "",
        ];
        value["questions"][0]["evidence"] = Value::Array(
            bad.iter()
                .map(|p| json!({"type": "excerpt", "root": "repo", "path": p, "start": 1}))
                .collect(),
        );
        let found = violations(&value, &repo);
        assert_eq!(found.len(), bad.len(), "{found:?}");
        assert!(found.iter().all(|v| v.path.ends_with(".path")), "{found:?}");
    }

    #[test]
    fn the_secret_names_are_refused_in_a_ref_and_in_a_git_diff_too() {
        let repo = repo("secret-refs");
        write(&repo.dir, ".env.json", "{\"a\": 1}");
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([
            {"type": "node", "root": "repo", "ref": ".env.json#/a"},
            {"type": "git-diff", "summary": "s", "root": "repo", "path": ".git/config", "base": "HEAD~1", "head": "HEAD"}
        ]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.questions[0].evidence[0].ref",
                "$.questions[0].evidence[1].path"
            ]
        );
    }

    #[test]
    fn the_page_file_is_taken_from_the_child_worktree_or_a_feature_dev_folder_only() {
        let repo = repo("page-file");
        let other = temp_dir("page-file-other");
        write(&other, "page.json", "{}");
        write(&repo.dir, "work/page.json", "{}");
        write(&repo.dir, "src/page.json", "{}");
        let allowed = repo.allowed();
        let work = repo.dir.join("work");
        let ok = |file: &Path, tree: &Path| {
            allowed.check_page_file(&file.to_string_lossy(), &tree.to_string_lossy())
        };
        assert!(ok(&work.join("page.json"), &work).is_ok());
        assert!(ok(&repo.dir.join(".feature-dev/current/notes.md"), &work).is_ok());
        assert!(ok(&repo.dir.join("src/page.json"), &work).is_err());
        assert!(ok(&other.join("page.json"), &work).is_err());
        // The worktree of the record is itself checked.
        assert!(ok(&other.join("page.json"), &other).is_err());
        assert!(ok(&work.join("../src/page.json"), &work).is_err());
        assert!(ok(&work.join("missing.json"), &work).is_err());
    }

    // -- the evidence --

    #[test]
    fn an_excerpt_is_cut_at_the_lines_and_refuses_what_is_past_the_end() {
        let repo = repo("excerpt");
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([
            {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 3},
            {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 2, "end": 4},
            {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 2, "end": 1},
            {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 1, "end": 2, "highlight": [3]},
            {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 1, "end": 500},
            {"type": "excerpt", "root": "repo", "path": "src/none.rs", "start": 1}
        ]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.questions[0].evidence[1].end",
                "$.questions[0].evidence[2].end",
                "$.questions[0].evidence[3].highlight",
                "$.questions[0].evidence[4].end",
                "$.questions[0].evidence[5].path",
            ]
        );
        value["questions"][0]["evidence"] = json!([
            {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 3}
        ]);
        let page = build(&value, &repo.allowed()).unwrap();
        let Evidence::Excerpt { lines, end, .. } = &page.questions[0].evidence[0] else {
            panic!("an excerpt");
        };
        assert_eq!(
            (lines.as_slice(), *end),
            (&["fn three() {}".to_owned()][..], 3)
        );
    }

    #[test]
    fn a_file_over_the_limit_or_not_utf8_is_refused() {
        let repo = repo("excerpt-limits");
        fs::write(
            repo.dir.join("big.txt"),
            vec![b'a'; EVIDENCE_FILE_LIMIT as usize + 1],
        )
        .unwrap();
        fs::write(repo.dir.join("bin.txt"), [0xff, 0xfe, 0x00]).unwrap();
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([
            {"type": "excerpt", "root": "repo", "path": "big.txt", "start": 1},
            {"type": "excerpt", "root": "repo", "path": "bin.txt", "start": 1}
        ]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.questions[0].evidence[0].path",
                "$.questions[0].evidence[1].path"
            ]
        );
    }

    #[test]
    fn a_node_is_found_by_json_pointer_and_by_id() {
        let doc: Value = serde_json::from_str(
            r#"{"designs": [{"id": "DESIGN-01", "title": "first"}, {"id": "DESIGN-02", "title": "second"}], "meta": {"a/b": 1, "c~d": 2}, "list": [10, 20]}"#,
        )
        .unwrap();
        // RFC 6901: names, indexes, and the escapes ~1 and ~0.
        assert_eq!(
            pointer_value(&doc, "/designs/1/title"),
            Some(&json!("second"))
        );
        assert_eq!(pointer_value(&doc, "/meta/a~1b"), Some(&json!(1)));
        assert_eq!(pointer_value(&doc, "/meta/c~0d"), Some(&json!(2)));
        assert_eq!(pointer_value(&doc, "/list/1"), Some(&json!(20)));
        assert_eq!(pointer_value(&doc, ""), None);
        // A token that is no number picks the element whose `id` it is.
        assert_eq!(
            pointer_value(&doc, "/designs/DESIGN-02/title"),
            Some(&json!("second"))
        );
        assert_eq!(pointer_value(&doc, "/designs/DESIGN-09"), None);
        assert_eq!(pointer_value(&doc, "/designs/2"), None);
        assert_eq!(pointer_value(&doc, "/list/x"), None);
        assert_eq!(pointer_value(&doc, "/meta/a/b"), None);
    }

    #[test]
    fn a_node_that_cannot_be_resolved_is_a_violation() {
        let repo = repo("node");
        write(&repo.dir, "broken.json", "{");
        let mut value = open_questions(&repo);
        let refs = [
            "design.json#/designs/DESIGN-02",
            "design.json#/requirements/REQ-03",
            "design.json#/designs/DESIGN-09",
            "design.json",
            "design.json#designs",
            "notes.md#/a",
            "broken.json#/a",
            "missing.json#/a",
        ];
        value["questions"][0]["evidence"] = Value::Array(
            refs.iter()
                .map(|r| json!({"type": "node", "root": "deliverables", "ref": r}))
                .collect(),
        );
        let found = violations(&value, &repo);
        assert_eq!(
            paths(&found),
            (2..8)
                .map(|n| format!("$.questions[0].evidence[{n}].ref"))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_git_diff_is_resolved_and_a_bad_one_is_a_violation() {
        let repo = repo("git-diff");
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "src/main.rs", "base": "HEAD~1", "head": "HEAD"},
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "src/main.rs", "base": "HEAD~1", "head": null},
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "src/main.rs", "base": "HEAD", "head": "HEAD"},
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "src/main.rs", "base": "--output=x", "head": "HEAD"},
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "src/main.rs", "base": "nonexistent-rev", "head": "HEAD"},
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "src/main.rs", "base": "HEAD"},
            {"type": "git-diff", "summary": "s", "root": "deliverables", "path": "design.json", "base": "HEAD", "head": "HEAD"}
        ]);
        let found = violations(&value, &repo);
        assert_eq!(
            paths(&found),
            [
                "$.questions[0].evidence[2]",
                "$.questions[0].evidence[3].base",
                "$.questions[0].evidence[4]",
                "$.questions[0].evidence[5].head",
                "$.questions[0].evidence[6]",
            ]
        );
        value["questions"][0]["evidence"] = json!([
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "src/main.rs", "base": "HEAD~1", "head": "HEAD", "note": "n"}
        ]);
        let page = build(&value, &repo.allowed()).unwrap();
        let Evidence::GitDiff {
            diff,
            truncated,
            head,
            ..
        } = &page.questions[0].evidence[0]
        else {
            panic!("a git diff");
        };
        assert!(diff.contains("-fn two() {}") && diff.contains("+fn two2() {}"));
        assert!(!truncated);
        assert_eq!(head.as_deref(), Some("HEAD"));
    }

    #[test]
    fn a_git_diff_against_the_working_tree_reads_the_uncommitted_change() {
        let repo = repo("git-diff-tree");
        write(&repo.dir, "src/main.rs", "changed\n");
        let (diff, _) = git_diff(&repo.dir, "src/main.rs", "HEAD", None).unwrap();
        assert!(diff.contains("+changed"));
        assert!(git_diff(&repo.dir, "src/main.rs", "HEAD", Some("HEAD")).is_err());
    }

    #[test]
    fn a_long_git_diff_is_cut_and_marked() {
        let repo = repo("git-diff-long");
        let long: String = (0..30_000).map(|n| format!("line number {n}\n")).collect();
        write(&repo.dir, "long.txt", &long);
        git(&repo.dir, &["add", "long.txt"]);
        let (diff, truncated) = git_diff(&repo.dir, "long.txt", "HEAD", None).unwrap();
        assert!(truncated);
        assert!(diff.len() <= GIT_DIFF_LIMIT);
        assert!(diff.starts_with("diff --git"));
    }

    #[test]
    fn a_page_with_too_much_evidence_is_refused() {
        let repo = repo("many");
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = Value::Array(
            (0..=EVIDENCE_COUNT)
                .map(|_| json!({"type": "diff", "summary": "s", "name": "n", "before": [], "after": []}))
                .collect(),
        );
        let found = violations(&value, &repo);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].message.contains("200"));
    }

    #[test]
    fn a_page_that_grows_past_the_limit_with_its_evidence_is_refused() {
        let repo = repo("big");
        let line = "x".repeat(10_000);
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = Value::Array(
            (0..90)
                .map(|_| json!({"type": "diff", "summary": "s", "name": "n", "before": [line], "after": []}))
                .collect(),
        );
        assert_eq!(paths(&violations(&value, &repo)), ["$"]);
    }

    // -- load --

    #[test]
    fn a_page_file_is_read_checked_and_refused_when_it_is_not_json_or_too_big() {
        let repo = repo("load");
        let page = repo.dir.join(".feature-dev/current/records/page-01.json");
        write(
            &repo.dir,
            ".feature-dev/current/records/page-01.json",
            &open_questions(&repo).to_string(),
        );
        let given = page.to_string_lossy().into_owned();
        let work = repo.root();
        assert!(load(&given, &work, &repo.allowed()).is_ok());
        write(&repo.dir, ".feature-dev/current/records/page-01.json", "{");
        let found = load(&given, &work, &repo.allowed()).unwrap_err();
        assert!(found[0].message.starts_with("JSON として読めません"));
        fs::write(&page, vec![b' '; PAGE_FILE_LIMIT as usize + 1]).unwrap();
        assert!(load(&given, &work, &repo.allowed()).is_err());
        let found = load("relative.json", &work, &repo.allowed()).unwrap_err();
        assert_eq!(paths(&found), ["$"]);
    }

    // -- the record --

    fn child(name: &str, path: &str, launched_at: u64) -> Child {
        Child {
            name: name.to_owned(),
            repo: "repo".into(),
            environment: LOCAL.into(),
            agent: formation::FormationAgent::Claude,
            launch: Some(formation::Launch {
                path: path.to_owned(),
                branch: "b".into(),
                handle: "h".into(),
                pane_key: "p".into(),
                launched_at,
                created: true,
                branch_made: true,
            }),
        }
    }

    fn formation_folder(config: &Path, name: &str, children: &[Child]) {
        let dir = formation::dir(config, name);
        fs::create_dir_all(&dir).unwrap();
        let text = serde_json::to_string(&json!({ "children": children })).unwrap();
        fs::write(dir.join(formation::CHILDREN_FILE), text).unwrap();
    }

    fn page_file(repo: &Repo, name: &str, title: &str) -> String {
        let mut value = open_questions(repo);
        value["title"] = json!(title);
        let relative = format!(".feature-dev/current/records/{name}.json");
        write(&repo.dir, &relative, &value.to_string());
        repo.dir.join(relative).to_string_lossy().into_owned()
    }

    #[test]
    fn a_page_is_recorded_for_a_launched_child_and_replaces_its_earlier_one() {
        let repo = repo("record");
        let config = temp_dir("record-config");
        formation_folder(
            &config,
            "api-work",
            &[
                child("one", &repo.root(), 100),
                child("two", &repo.root(), 100),
            ],
        );
        let first = page_file(&repo, "page-01", "最初のページ");
        let answer = record_with(
            &config,
            "api-work",
            "one",
            &first,
            &repo.allowed(),
            500,
            &Gate::off(),
        )
        .unwrap();
        assert_eq!(answer["title"], "最初のページ");
        assert_eq!(answer["pageKind"], "open-questions");
        let second = page_file(&repo, "page-02", "次のページ");
        record_with(
            &config,
            "api-work",
            "one",
            &second,
            &repo.allowed(),
            600,
            &Gate::off(),
        )
        .unwrap();
        record_with(
            &config,
            "api-work",
            "two",
            &first,
            &repo.allowed(),
            700,
            &Gate::off(),
        )
        .unwrap();
        let pages = read_pages(&config, "api-work");
        assert_eq!(pages.len(), 2);
        let one = pages.iter().find(|p| p.child == "one").unwrap();
        assert_eq!(
            (one.title.as_str(), one.path.as_str(), one.at),
            ("次のページ", second.as_str(), 600)
        );
        // The pages are kept beside the record of the children, in the shape the task fixes.
        let text =
            fs::read_to_string(formation::dir(&config, "api-work").join(PAGES_FILE)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value["pages"][0],
            json!({"child": "one", "path": second, "title": "次のページ", "page_kind": "open-questions", "subject": "requirement", "at": 600})
        );
    }

    #[test]
    fn a_page_with_violations_records_nothing_and_lists_them_all() {
        let repo = repo("record-bad");
        let config = temp_dir("record-bad-config");
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 100)]);
        let mut value = open_questions(&repo);
        value["extra"] = json!(1);
        value["title"] = json!(7);
        write(
            &repo.dir,
            ".feature-dev/current/records/bad.json",
            &value.to_string(),
        );
        let path = repo.dir.join(".feature-dev/current/records/bad.json");
        let refusal = record_with(
            &config,
            "api-work",
            "one",
            &path.to_string_lossy(),
            &repo.allowed(),
            1,
            &Gate::off(),
        )
        .unwrap_err();
        let answer: Value = serde_json::from_str(&formation::answer(Err(refusal))).unwrap();
        assert_eq!(answer["ok"], false);
        let listed: Vec<&str> = answer["data"]["violations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["path"].as_str().unwrap())
            .collect();
        assert_eq!(listed, ["$.extra", "$.title"]);
        assert!(answer["note"].as_str().unwrap().contains("data"));
        assert!(read_pages(&config, "api-work").is_empty());
        assert!(!formation::dir(&config, "api-work")
            .join(PAGES_FILE)
            .exists());
    }

    /// A yomiyasu record under `state` whose final text is `body`.
    fn yomiyasu_record(state: &Path, body: &str) {
        let hex = format!("{:064x}", 7);
        let run = state.join("runs/r1");
        fs::create_dir_all(&run).unwrap();
        fs::create_dir_all(state.join("inputs")).unwrap();
        fs::write(
            run.join("attempt-1.json"),
            json!({
                "format": "yomiyasu-check-record", "format_version": 1,
                "inputs": {"final": {"snapshot": format!("inputs/{hex}.bin")}},
                "result": {"status": "executed"}
            })
            .to_string(),
        )
        .unwrap();
        fs::write(state.join("inputs").join(format!("{hex}.bin")), body).unwrap();
    }

    #[test]
    fn a_page_with_a_line_that_yomiyasu_did_not_polish_is_refused_and_not_recorded() {
        let repo = repo("record-gate");
        let config = temp_dir("record-gate-config");
        let state = temp_dir("record-gate-state");
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 100)]);
        let path = page_file(&repo, "page-01", "磨いていない題");
        // The record holds every line of the page but its title.
        let mut value = open_questions(&repo);
        value["title"] = json!("磨いていない題");
        let mut texts = yomiyasu_gate::page_texts(&value);
        texts.retain(|t| t != "磨いていない題");
        yomiyasu_record(&state, &texts.join("\n"));
        let gate = Gate::new(state.clone(), std::time::SystemTime::now());
        let refusal =
            record_with(&config, "api-work", "one", &path, &repo.allowed(), 1, &gate).unwrap_err();
        let answer: Value = serde_json::from_str(&formation::answer(Err(refusal))).unwrap();
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["data"]["unpolished"], json!(["磨いていない題"]));
        assert!(read_pages(&config, "api-work").is_empty());
        // The title is polished in the next run of yomiyasu: the page is recorded.
        yomiyasu_record(&state, &format!("{}\n磨いていない題", texts.join("\n")));
        let done = record_with(&config, "api-work", "one", &path, &repo.allowed(), 2, &gate);
        assert_eq!(done.unwrap()["title"], "磨いていない題");
        assert_eq!(read_pages(&config, "api-work").len(), 1);
    }

    #[test]
    fn the_gate_runs_after_the_input_check_so_a_violation_is_answered_first() {
        let repo = repo("record-gate-order");
        let config = temp_dir("record-gate-order-config");
        let state = temp_dir("record-gate-order-state");
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 100)]);
        let mut value = open_questions(&repo);
        value["extra"] = json!("余分");
        write(
            &repo.dir,
            ".feature-dev/current/records/bad.json",
            &value.to_string(),
        );
        let path = repo.dir.join(".feature-dev/current/records/bad.json");
        let gate = Gate::new(state, std::time::SystemTime::now());
        let refusal = record_with(
            &config,
            "api-work",
            "one",
            &path.to_string_lossy(),
            &repo.allowed(),
            1,
            &gate,
        )
        .unwrap_err();
        let answer: Value = serde_json::from_str(&formation::answer(Err(refusal))).unwrap();
        assert!(answer["data"]["violations"].is_array());
        assert!(answer["data"]["unpolished"].is_null());
    }

    #[test]
    fn a_child_that_is_not_launched_or_not_in_the_record_gets_no_page() {
        let repo = repo("record-child");
        let config = temp_dir("record-child-config");
        let mut planned = child("planned", &repo.root(), 0);
        planned.launch = None;
        formation_folder(&config, "api-work", &[planned]);
        let path = page_file(&repo, "page-01", "t");
        for name in ["planned", "stranger", "../x"] {
            let refusal = record_with(
                &config,
                "api-work",
                name,
                &path,
                &repo.allowed(),
                1,
                &Gate::off(),
            )
            .unwrap_err();
            assert!(!formation::refusal_text(&refusal).is_empty(), "{name}");
        }
        assert!(read_pages(&config, "api-work").is_empty());
    }

    #[test]
    fn a_page_in_the_worktree_of_another_child_is_refused() {
        let repo = repo("record-other");
        let config = temp_dir("record-other-config");
        let work = repo.dir.join("work");
        fs::create_dir_all(&work).unwrap();
        formation_folder(
            &config,
            "api-work",
            &[child("one", &work.to_string_lossy(), 100)],
        );
        // The page is in the repository and not in the child's worktree or a `.feature-dev/` folder.
        write(
            &repo.dir,
            "src/page.json",
            &open_questions(&repo).to_string(),
        );
        let path = repo.dir.join("src/page.json");
        let refusal = record_with(
            &config,
            "api-work",
            "one",
            &path.to_string_lossy(),
            &repo.allowed(),
            1,
            &Gate::off(),
        )
        .unwrap_err();
        assert!(formation::refusal_text(&refusal).contains("違反"));
    }

    #[test]
    fn a_broken_record_of_pages_is_not_written_over() {
        let repo = repo("record-broken");
        let config = temp_dir("record-broken-config");
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 100)]);
        fs::write(formation::dir(&config, "api-work").join(PAGES_FILE), "{").unwrap();
        let path = page_file(&repo, "page-01", "t");
        assert!(record_with(
            &config,
            "api-work",
            "one",
            &path,
            &repo.allowed(),
            1,
            &Gate::off()
        )
        .is_err());
        let text =
            fs::read_to_string(formation::dir(&config, "api-work").join(PAGES_FILE)).unwrap();
        assert_eq!(text, "{");
    }

    #[test]
    fn a_deleted_formation_does_not_get_its_folder_back() {
        let config = temp_dir("record-deleted");
        let page = PageRecord {
            child: "one".into(),
            path: "/x".into(),
            title: "t".into(),
            page_kind: PageKind::Approval,
            subject: Subject::Design,
            at: 1,
        };
        assert!(put_page(&config, "gone", page).is_err());
        assert!(!formation::dir(&config, "gone").exists());
    }

    // -- the mark on a child --

    fn record_of(child: &str, at: u64) -> PageRecord {
        PageRecord {
            child: child.to_owned(),
            path: "/p.json".into(),
            title: format!("{child} のページ"),
            page_kind: PageKind::Approval,
            subject: Subject::Design,
            at,
        }
    }

    #[test]
    fn the_mark_is_the_title_and_the_time_of_the_childs_page() {
        let children = [child("one", "/w", 100), child("two", "/w", 100)];
        let marks = pending_pages(&children, &[record_of("two", 250)]);
        assert_eq!(marks[0], None);
        assert_eq!(
            marks[1],
            Some(PendingPage {
                title: "two のページ".into(),
                at_ms: 250
            })
        );
    }

    #[test]
    fn a_page_older_than_the_launch_of_the_child_is_not_its_mark() {
        let mut planned = child("planned", "/w", 0);
        planned.launch = None;
        let children = [child("again", "/w", 1000), planned];
        let marks = pending_pages(
            &children,
            &[record_of("again", 999), record_of("planned", 5)],
        );
        assert_eq!(marks, [None, None]);
        let marks = pending_pages(&children[..1], &[record_of("again", 1000)]);
        assert!(marks[0].is_some());
    }

    #[test]
    fn the_marks_go_on_the_rows_of_the_children_in_order() {
        let children = [child("one", "/w", 100), child("two", "/w", 100)];
        let row = |name: &str| formation::FormationChild {
            name: name.into(),
            repo: "repo".into(),
            branch: "b".into(),
            state: formation::FormationState::Working,
            at_ms: 0,
            reply: None,
            tool_name: None,
            handle: Some("h".into()),
            environment: LOCAL.into(),
            agent: formation::FormationAgent::Claude,
            created: true,
            pending_page: None,
        };
        let mut rows = [row("one"), row("two")];
        mark_pending(&mut rows, &children, &[record_of("one", 300)]);
        assert_eq!(rows[0].pending_page.as_ref().unwrap().at_ms, 300);
        assert_eq!(rows[1].pending_page, None);
    }

    // -- the read of the screen --

    #[test]
    fn the_page_of_a_child_is_read_again_with_its_evidence_and_only_while_it_waits() {
        let repo = repo("read");
        let config = temp_dir("read-config");
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 100)]);
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([
            {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 1}
        ]);
        write(
            &repo.dir,
            ".feature-dev/current/records/page-01.json",
            &value.to_string(),
        );
        let path = repo.dir.join(".feature-dev/current/records/page-01.json");
        let given = path.to_string_lossy().into_owned();
        assert!(read_with(&config, "api-work", "one", &repo.allowed()).is_err());
        record_with(
            &config,
            "api-work",
            "one",
            &given,
            &repo.allowed(),
            500,
            &Gate::off(),
        )
        .unwrap();
        let page = read_with(&config, "api-work", "one", &repo.allowed()).unwrap();
        let Evidence::Excerpt { lines, .. } = &page.questions[0].evidence[0] else {
            panic!("an excerpt");
        };
        assert_eq!(lines, &["fn one() {}"]);
        // The file changed after it was recorded and now breaks the contract: the read says so, line by line.
        value["bogus"] = json!(true);
        write(
            &repo.dir,
            ".feature-dev/current/records/page-01.json",
            &value.to_string(),
        );
        let error = read_with(&config, "api-work", "one", &repo.allowed()).unwrap_err();
        assert_eq!(error, "$.bogus: 約束にないキーです");
        // A child of another name has no page, and neither has one that was launched again after it.
        assert!(read_with(&config, "api-work", "stranger", &repo.allowed()).is_err());
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 900)]);
        assert!(read_with(&config, "api-work", "one", &repo.allowed()).is_err());
    }

    #[test]
    fn the_page_travels_as_json_between_the_server_and_the_app() {
        let repo = repo("travel");
        let page = build(&approval(&repo), &repo.allowed()).unwrap();
        let back: DecisionPage =
            serde_json::from_value(serde_json::to_value(&page).unwrap()).unwrap();
        assert_eq!(back, page);
        let mut value = open_questions(&repo);
        value["questions"][0]["blocks"] =
            json!([{"type": "before-after", "before": [], "after": [], "before_caption": "今"}]);
        let page = build(&value, &repo.allowed()).unwrap();
        let back: DecisionPage =
            serde_json::from_value(serde_json::to_value(&page).unwrap()).unwrap();
        assert_eq!(back, page);
    }

    #[test]
    fn the_violations_read_one_on_each_line() {
        let text = violations_text(&[
            Violation {
                path: "$.a".into(),
                message: "x".into(),
            },
            Violation {
                path: "$.b".into(),
                message: "y".into(),
            },
        ]);
        assert_eq!(text, "$.a: x\n$.b: y");
    }

    #[test]
    fn the_revisions_that_git_would_take_for_an_option_are_refused() {
        for bad in ["", "-x", "--output=a", "a b", "a\nb"] {
            assert!(check_revision(bad).is_err(), "{bad:?}");
        }
        for good in ["HEAD", "HEAD~1", "origin/main", "abc1234", "v1.0^"] {
            assert!(check_revision(good).is_ok(), "{good:?}");
        }
        let args = git_diff_args("a.rs", "base", Some("head"));
        let at = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(
            &args[at - 2..],
            ["base", "head", "--", "a.rs"].map(str::to_owned)
        );
        assert!(
            args.contains(&"--no-ext-diff".to_owned())
                && args.contains(&"--literal-pathspecs".to_owned())
        );
    }

    #[test]
    fn every_embedded_kind_has_a_name_that_the_contract_uses() {
        let set: std::collections::BTreeSet<&str> = [
            CardKind::Question,
            CardKind::Nr,
            CardKind::MustFix,
            CardKind::StructuralProposal,
            CardKind::Adr,
            CardKind::ReviewMustFix,
            CardKind::ReviewDecision,
            CardKind::UnmetCriterion,
        ]
        .into_iter()
        .map(|kind| {
            let serialized = serde_json::to_value(kind).unwrap();
            assert_eq!(serialized, kind.name());
            kind.name()
        })
        .collect();
        assert_eq!(set.len(), 8);
    }
}
