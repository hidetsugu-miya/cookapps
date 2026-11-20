//! The decision pages of A-41: a child of a formation writes the input JSON of a page (a question or an approval for the owner), the leader hands its path to `formation_page`, and the page is checked here and recorded as "the child waits for the owner" in `formations/{name}/pages.json`. The screen reads the page through `formation_page_read`, which checks it again and resolves its evidence (the lines of a file, a node of a JSON file, the output of `git diff`).
//!
//! The input follows the input contract of the decision pages (`schema_version` 1, the page kinds `open-questions` and `approval`, the cards, blocks and evidence of `requirements/orca.md`, A-41). Every violation is a line `{path, message}` with a JSON path from `$`, and all of them are returned, never the first only.
//! Everything the page names is inside the repositories of the formation: a root and an evidence path are checked against the folders that Orca lists for this PC (`Allowed`), through the real path of each, so that `..`, an absolute path and a link cannot leave them; `.git` and the names that start with `.env` are never read, as `formation_read` does not.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex, PoisonError},
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
    formation_image,
    formation_reply::{self, PageAnswer},
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
/// A file that a fact of a card cites, at most (bytes).
const FACT_FILE_LIMIT: u64 = 128 * 1024;

// ---- the page as the screen gets it ----

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "kebab-case")]
pub enum PageKind {
    OpenQuestions,
    Approval,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum Subject {
    Requirement,
    Design,
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
}

impl CardKind {
    fn name(self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Nr => "nr",
            Self::MustFix => "must-fix",
            Self::StructuralProposal => "structural-proposal",
            Self::Adr => "adr",
        }
    }

    /// Whether the card offers lettered options (`A`, `B`, ...); the recommended one is always `A`.
    pub(crate) fn lettered(self) -> bool {
        matches!(self, Self::Question | Self::Nr)
    }

    /// The keys of the fixed choices the page adds under the options (`choice_details` is by these keys).
    fn fixed_keys(self) -> &'static [&'static str] {
        match self {
            Self::Question => &["investigate", "other"],
            Self::Nr => &["other"],
            Self::MustFix => &["fix", "skip"],
            Self::StructuralProposal => &["approve", "reject", "hold"],
            Self::Adr => &["keep", "decline"],
        }
    }

    /// The fixed choices a card of this kind is recommended among (a lettered card: `A`); none for a card that takes no answer.
    fn choices(self) -> &'static [&'static str] {
        match self {
            Self::Question | Self::Nr => &["A"],
            Self::MustFix => &["fix", "skip"],
            Self::StructuralProposal => &["approve", "reject", "hold"],
            Self::Adr => &["keep", "decline"],
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
    /// The lead of 「何が変わるか」; only on `approval`.
    pub what: Option<String>,
    /// The roots of the page by name, as the real directories they are.
    pub roots: BTreeMap<String, String>,
    pub previous_reply: Option<String>,
    /// The answers that `previous_reply` carries for the cards of this page, as the screen starts from them (`formation_reply::restore`).
    pub restored: Vec<PageAnswer>,
    /// The words of the page that a reader outside the project cannot tell, with what they mean.
    pub terms: Vec<Term>,
    /// `open-questions` of a requirement: every `question` card has the fixed choice `ビジネス側に確認する`.
    pub hold: bool,
    /// The numbers of the cards whose items the owner asked to have explained more clearly: nothing is restored into them from `previous_reply`.
    pub clarified_numbers: Vec<String>,
    /// `open-questions`.
    pub questions: Vec<Card>,
    pub approval_scope: Vec<ScopeGroup>,
    /// The design items of an `approval` of a design, one row each (the groups of `approval_scope` that hold them are marked `design`).
    pub design_items: Vec<DesignItem>,
    /// The repositories of the deliverables' `design.json` in the order they are implemented; only on an `approval` of a design, and only when the page is resolved.
    pub implementation_order: Vec<String>,
    pub changes: Vec<Change>,
    /// `nr` cards on `approval`.
    pub needs_user_decision: Vec<Card>,
    /// `must-fix` cards on `approval`.
    pub residual_must_fix: Vec<Card>,
    pub structural_proposals: Vec<Card>,
    pub adr: Option<Card>,
    pub risks: Option<Risks>,
    pub settled_decisions: Vec<SettledDecision>,
    /// `approval`: the questions that the review withdrew because the final deliverable settles them.
    pub withdrawn_needs_user_decision: Vec<Withdrawn>,
    /// `approval`: what the child noticed outside the request and did not reflect.
    pub noticed: Vec<Noticed>,
    pub quality_loop: Option<QualityLoop>,
}

/// A word of the page and what it means: the screen shows `description` as a tooltip on `word` in the body text.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Term {
    pub word: String,
    pub description: String,
}

/// A decision item that the review withdrew, with why.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Withdrawn {
    pub number: String,
    pub title: String,
    pub withdrawal_reason: String,
}

/// A matter noticed outside the request and not reflected; it takes no answer.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Noticed {
    pub title: String,
    pub text: String,
    pub evidence: Vec<Evidence>,
}

/// A design item of the deliverables' `design.json`, as a row of 設計項目: the node `reference` of `root` with its `text`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct DesignItem {
    pub id: String,
    pub title: String,
    pub root: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub text: Option<String>,
    /// The `release` the DESIGN writes, when it writes one.
    pub release: Option<u32>,
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
    /// 「具体的な場面」: the situation the decision plays out in, and why the question arises.
    pub scene: Option<String>,
    /// The screenshot of the screen the scene is about; only on a card that asks.
    pub scene_image: Option<ImageRef>,
    /// When the matter arises and how much it matters; on `nr` of a design page.
    pub occurrence: Option<Occurrence>,
    /// Every condition the decision requires the options to meet; the `unmet` of an option names them.
    pub conditions: Vec<Condition>,
    /// The trade-offs of a fixed choice, by its key.
    pub choice_details: BTreeMap<String, String>,
}

/// When a matter arises and how much it matters.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Occurrence {
    /// The conditions that must all hold for the matter to arise.
    pub conditions: Vec<String>,
    pub likelihood: Likelihood,
    /// The ground of `likelihood`; it opens with `実測: ` or `推測: `.
    pub basis: String,
    pub impact: String,
    pub detectability: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum Likelihood {
    Frequent,
    Occasional,
    Rare,
}

/// A condition the decision requires the options to meet (`KO-03`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Condition {
    pub id: String,
    pub text: String,
}

/// A condition of the card that an option fails, with what the option does against it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Unmet {
    pub id: String,
    pub reason: String,
}

/// A text the screen draws in an option's style.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub text: String,
    /// In px, 1 to 200.
    pub font_size: u32,
    /// 100 to 900 in steps of 100.
    pub font_weight: u32,
    /// `#rgb` or `#rrggbb`.
    pub color: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct CardOption {
    pub key: String,
    pub label: String,
    pub detail: Option<String>,
    /// The conditions of the card that the option fails.
    pub unmet: Vec<Unmet>,
    /// How the option looks.
    pub image: Option<ImageRef>,
    /// The option's text style.
    pub sample: Option<Sample>,
    /// How things go after the option is chosen, as Mermaid.
    pub diagram: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct Fact {
    pub label: String,
    pub value: String,
    /// What the fact's `ref` or `path` holds, for 「中身を見る」; none when it names nothing (and on a page read for its cards alone).
    pub content: Option<FactContent>,
}

/// What a fact cites: a node of a deliverable, a file as text or as Markdown, or an image (the file is read when the screen draws it).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum FactContent {
    Node {
        root: String,
        #[serde(rename = "ref")]
        reference: String,
        text: String,
    },
    Markdown {
        root: String,
        path: String,
        text: String,
    },
    Text {
        root: String,
        path: String,
        text: String,
    },
    Image(ImageRef),
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

/// An image of the page: a file of a root, with the words that describe it. The file is not in the page; the screen reads it when it draws it (`formation_page_image`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct ImageRef {
    pub root: String,
    pub path: String,
    pub caption: String,
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
    Image(ImageRef),
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
    /// The lines `before` and `after` of the child, drawn as a change of `name` (`rows`: one hunk with full context), with where each side comes from.
    Diff {
        summary: String,
        name: String,
        before_source: String,
        after_source: String,
        note: Option<String>,
        rows: Vec<DiffRow>,
    },
    /// What the after-state is not yet decided to be: the present lines (`excerpts`, all of them `Excerpt`) and the note that says which stage decides it.
    Current {
        note: String,
        excerpts: Vec<Evidence>,
    },
    /// The output of `git diff {base} [{head}] -- {path}` in the repository of `root`, as `rows`; `truncated` when it was cut.
    GitDiff {
        summary: String,
        root: String,
        path: String,
        base: String,
        head: Option<String>,
        note: Option<String>,
        rows: Vec<DiffRow>,
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

/// One row of a diff drawn side by side: a hunk header, a line both sides share, or a change (a line of the left side, one of the right side, or both).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct DiffRow {
    pub kind: DiffRowKind,
    pub left_no: Option<u32>,
    /// The text of the left line, or of the hunk header.
    pub left: Option<String>,
    /// The characters (a start and an end, counted in characters) of the left line that the right one lacks, in a change that has both.
    pub left_mark: Option<(u32, u32)>,
    pub right_no: Option<u32>,
    pub right: Option<String>,
    pub right_mark: Option<(u32, u32)>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "kebab-case")]
pub enum DiffRowKind {
    Hunk,
    Context,
    Change,
}

impl Evidence {
    /// The bytes of the text that the evidence carries, which `Walk` adds up against `PAGE_LIMIT`.
    fn size(&self) -> usize {
        let lines = |lines: &[String]| lines.iter().map(|line| line.len() + 1).sum::<usize>();
        let rows = |rows: &[DiffRow]| {
            rows.iter()
                .map(|row| {
                    row.left.as_ref().map_or(0, String::len)
                        + row.right.as_ref().map_or(0, String::len)
                })
                .sum::<usize>()
        };
        match self {
            Self::Excerpt { lines: l, .. } => lines(l),
            Self::Diff { rows: r, .. } | Self::GitDiff { rows: r, .. } => rows(r),
            // The excerpts of a `current` item are added to the page as each is read.
            Self::Current { .. } => 0,
            Self::Node { text, .. } => text.len(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct ScopeGroup {
    pub heading: String,
    /// Empty on a `design` group: its items are the rows of `design_items`.
    pub items: Vec<ScopeItem>,
    /// A group whose every item names a design item (`design.json#/designs/{id}`), on a design approval.
    pub design: bool,
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
    /// The fix runs among the rounds; only on a design.
    pub fix_cycles: Option<u32>,
    pub must_fix_resolved: u32,
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
pub(crate) fn locate(root: &Path, relative: &str) -> Result<PathBuf, String> {
    check_clean(relative)?;
    let real = std::fs::canonicalize(root.join(relative)).map_err(|_| "ファイルがありません")?;
    let inner = real
        .strip_prefix(root)
        .map_err(|_| "root の外に出ています")?;
    check_names(inner)?;
    Ok(real)
}

/// The bytes of a regular file, at most `limit`.
pub(crate) fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
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

/// `before` to `after` as one unified-diff hunk with full context (`--- a/{name}`, `+++ b/{name}`), by an LCS line diff in which the deletions of a changed run come before its insertions.
fn unified_diff(name: &str, before: &[String], after: &[String]) -> String {
    let range = |n: usize| {
        if n == 0 {
            "0,0".to_owned()
        } else {
            format!("1,{n}")
        }
    };
    let name = name.replace('\n', " ");
    let mut out = format!(
        "--- a/{name}\n+++ b/{name}\n@@ -{} +{} @@\n",
        range(before.len()),
        range(after.len())
    );
    // lcs[i][j]: the length of the longest common run of before[i..] and after[j..].
    let mut lcs = vec![vec![0usize; after.len() + 1]; before.len() + 1];
    for i in (0..before.len()).rev() {
        for j in (0..after.len()).rev() {
            lcs[i][j] = if before[i] == after[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < before.len() || j < after.len() {
        if i < before.len() && j < after.len() && before[i] == after[j] {
            out.push_str(&format!(" {}\n", before[i]));
            (i, j) = (i + 1, j + 1);
        } else if j == after.len() || (i < before.len() && lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push_str(&format!("-{}\n", before[i]));
            i += 1;
        } else {
            out.push_str(&format!("+{}\n", after[j]));
            j += 1;
        }
    }
    out
}

/// The numbers where a hunk header `@@ -{a},{b} +{c},{d} @@` starts on each side.
fn hunk_starts(header: &str) -> (u32, u32) {
    let number = |sign: char| {
        header
            .split_whitespace()
            .find_map(|word| word.strip_prefix(sign))
            .and_then(|range| range.split(',').next())
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(1)
    };
    (number('-'), number('+'))
}

/// A range of characters of a line, a start and an end.
type Mark = Option<(u32, u32)>;

/// The numbered lines of one side of a run of changes.
type Numbered<'a> = Vec<(u32, &'a str)>;

/// The characters of `left` and `right` between their common start and common end, as the two marks of a changed pair (none when nothing is shared or one side is the other).
fn char_marks(left: &str, right: &str) -> (Mark, Mark) {
    let (l, r): (Vec<char>, Vec<char>) = (left.chars().collect(), right.chars().collect());
    let start = l.iter().zip(&r).take_while(|(a, b)| a == b).count();
    let end = l[start..]
        .iter()
        .rev()
        .zip(r[start..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    if start + end == 0 {
        return (None, None);
    }
    let mark = |chars: &[char]| {
        let to = chars.len() - end;
        (to > start).then_some((start as u32, to as u32))
    };
    (mark(&l), mark(&r))
}

/// The rows of the side-by-side view of a unified diff: the header lines of a file are left out, each hunk header is a row, a line both sides share is a row, and a run of deletions followed by insertions is paired line by line (a line with no partner stands alone). A line past the end of a hunk that git marks (`\ No newline`) is left out.
fn diff_rows(diff: &str) -> Vec<DiffRow> {
    fn flush(rows: &mut Vec<DiffRow>, deleted: &mut Numbered, added: &mut Numbered) {
        for at in 0..deleted.len().max(added.len()) {
            let (left, right) = (deleted.get(at), added.get(at));
            let marks = match (left, right) {
                (Some((_, l)), Some((_, r))) => char_marks(l, r),
                _ => (None, None),
            };
            rows.push(DiffRow {
                kind: DiffRowKind::Change,
                left_no: left.map(|(n, _)| *n),
                left: left.map(|(_, t)| (*t).to_owned()),
                left_mark: marks.0,
                right_no: right.map(|(n, _)| *n),
                right: right.map(|(_, t)| (*t).to_owned()),
                right_mark: marks.1,
            });
        }
        deleted.clear();
        added.clear();
    }
    let mut rows = Vec::new();
    let (mut deleted, mut added): (Numbered, Numbered) = (Vec::new(), Vec::new());
    let (mut left_no, mut right_no) = (0, 0);
    let mut in_hunk = false;
    for line in diff.split('\n') {
        if line.starts_with("@@") {
            flush(&mut rows, &mut deleted, &mut added);
            (left_no, right_no) = hunk_starts(line);
            in_hunk = true;
            rows.push(DiffRow {
                kind: DiffRowKind::Hunk,
                left_no: None,
                left: Some(line.to_owned()),
                left_mark: None,
                right_no: None,
                right: None,
                right_mark: None,
            });
        } else if line.starts_with("diff ") {
            flush(&mut rows, &mut deleted, &mut added);
            in_hunk = false;
        } else if !in_hunk {
            continue;
        } else if let Some(text) = line.strip_prefix('-') {
            deleted.push((left_no, text));
            left_no += 1;
        } else if let Some(text) = line.strip_prefix('+') {
            added.push((right_no, text));
            right_no += 1;
        } else if let Some(text) = line.strip_prefix(' ') {
            flush(&mut rows, &mut deleted, &mut added);
            rows.push(DiffRow {
                kind: DiffRowKind::Context,
                left_no: Some(left_no),
                left: Some(text.to_owned()),
                left_mark: None,
                right_no: Some(right_no),
                right: Some(text.to_owned()),
                right_mark: None,
            });
            (left_no, right_no) = (left_no + 1, right_no + 1);
        }
    }
    flush(&mut rows, &mut deleted, &mut added);
    rows
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

/// The JSON file at `real` (a real path), read and parsed.
fn read_json(real: &Path) -> Result<Value, String> {
    let bytes = read_bounded(real, EVIDENCE_FILE_LIMIT)?;
    serde_json::from_slice(&bytes).map_err(|_| "ファイルは JSON として読めません".to_owned())
}

/// The text of the node `reference` of a JSON file under `root`. `docs` keeps the files read, by real path, so that the many nodes of one deliverable read and parse it once.
fn node_text(
    root: &Path,
    reference: &str,
    docs: &mut BTreeMap<PathBuf, Result<Value, String>>,
) -> Result<String, String> {
    let (file, pointer) = split_ref(reference)?;
    let real = locate(root, file)?;
    let doc = docs
        .entry(real)
        .or_insert_with_key(|real| read_json(real))
        .as_ref()
        .map_err(Clone::clone)?;
    let node = pointer_value(doc, pointer).ok_or("その node はありません")?;
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

/// The arguments of `git diff` as the decision pages run it (A-41): no pager, no external diff, no text conversion, no rename (a renamed file is a deletion and an addition, so that every name is listed), and the pathspec read literally. `names` lists the names of the changed files alone (`--name-only -z`), with the same range and path as the diff itself.
fn git_diff_args(path: &str, base: &str, head: Option<&str>, names: bool) -> Vec<String> {
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
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ]
    .map(str::to_owned)
    .to_vec();
    if names {
        args.extend(["--name-only", "-z"].map(str::to_owned));
    }
    args.push(base.to_owned());
    if let Some(head) = head {
        args.push(head.to_owned());
    }
    args.push("--".into());
    args.push(path.to_owned());
    args
}

/// What `git` printed in `root` for `args`: at most `limit` bytes of its output (the second value says it was cut) and `GIT_WAIT` of time.
fn run_git(root: &Path, args: &[String], limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
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
        let _ = out.take(limit as u64 + 1).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = err.take(4096).read_to_end(&mut bytes);
        bytes
    });
    let Ok(mut bytes) = receiver.recv_timeout(GIT_WAIT) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("git が時間内に終わりませんでした".into());
    };
    let truncated = bytes.len() > limit;
    if truncated {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&errors.join().unwrap_or_default()).into_owned();
    if !truncated && !status.success() {
        let line = stderr.lines().next().unwrap_or("git が失敗しました");
        return Err(format!("git diff が失敗しました: {line}"));
    }
    bytes.truncate(limit);
    Ok((bytes, truncated))
}

/// Whether a name that `git diff --name-only -z` printed has a name of `formation::is_secret_name` in it.
fn names_a_secret(names: &[u8]) -> bool {
    names.split(|byte| *byte == 0).any(|name| {
        String::from_utf8_lossy(name)
            .split('/')
            .any(formation::is_secret_name)
    })
}

/// `git diff {base} [{head}] -- {path}` in `root`, at most `GIT_DIFF_LIMIT` bytes of it (the second value says it was cut) and `GIT_WAIT` of time. A diff with no change is an error.
/// `path` may be a folder, and a tracked file of it may be a `.env...` or lie in a `.git...` folder, which `check_clean` cannot see: the names of the changed files are read first with the same arguments, and a diff that has a secret name among them is refused without being read.
fn git_diff(
    root: &Path,
    path: &str,
    base: &str,
    head: Option<&str>,
) -> Result<(String, bool), String> {
    let (names, names_cut) = run_git(root, &git_diff_args(path, base, head, true), GIT_DIFF_LIMIT)?;
    if names_a_secret(&names) {
        return Err(
            "変更に、`.git` の中か、`.env` で始まる名前のファイルがあるので、差分を読めません。ファイルの名前を指してください"
                .into(),
        );
    }
    if names_cut {
        return Err("変更のあるファイルが多すぎて、名前を確かめきれません".into());
    }
    if names.is_empty() {
        return Err("この二つの版のあいだで、そのパスに変更がありません".into());
    }
    let (bytes, truncated) = run_git(
        root,
        &git_diff_args(path, base, head, false),
        GIT_DIFF_LIMIT,
    )?;
    if bytes.is_empty() {
        return Err("この二つの版のあいだで、そのパスに変更がありません".into());
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

// ---- the walk: the checks and the resolution ----

struct Walk<'a> {
    allowed: &'a Allowed,
    /// The roots of the page: the real directory, or `None` for a root that failed its own check (its references add no error).
    roots: BTreeMap<String, Option<PathBuf>>,
    errors: Vec<Violation>,
    evidence: usize,
    /// The bytes of the evidence and nodes resolved so far: a page over `PAGE_LIMIT` is refused as soon as it is known, and the rest is not read.
    resolved: usize,
    over: bool,
    /// The numbers of the cards seen: the reply names a card by its number, so a page keeps each once.
    numbers: BTreeSet<String>,
    /// The JSON files that nodes were read from, by real path (`node_text`).
    docs: BTreeMap<PathBuf, Result<Value, String>>,
    /// Whether the evidence is read (the lines of a file, a node, `git diff`). A page read for its cards alone (`build_input`) checks the evidence's shape and reads none of it.
    resolve: bool,
    /// The page's subject, once the page has been read far enough to know it (`nr` asks for an occurrence on a design page).
    subject: Option<Subject>,
}

type Object = Map<String, Value>;

impl<'a> Walk<'a> {
    fn new(allowed: &'a Allowed, resolve: bool) -> Self {
        Self {
            allowed,
            resolve,
            roots: BTreeMap::new(),
            errors: Vec::new(),
            evidence: 0,
            resolved: 0,
            over: false,
            numbers: BTreeSet::new(),
            docs: BTreeMap::new(),
            subject: None,
        }
    }

    /// Whether the evidence resolved so far has used up `PAGE_LIMIT`: the violation is told once, at the first evidence that is not read.
    fn over_budget(&mut self, path: &str) -> bool {
        if self.resolved <= PAGE_LIMIT {
            return false;
        }
        if !self.over {
            self.over = true;
            self.bad(
                path,
                format!(
                    "根拠を入れたページが大きすぎます（{} KiB まで）。ここから先の根拠は読んでいません",
                    PAGE_LIMIT / 1024
                ),
            );
        }
        true
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

    /// An image `{root, path, caption}` of `map` (its keys are checked by the caller): the root is one of the page's, the path is clean and names an image by its extension, and, when the page is resolved, the file is there and fits (`formation_image::check`). The caption is the words that describe it.
    fn image_ref(&mut self, map: &Object, path: &str) -> Option<ImageRef> {
        let root = self.root_of(map, path);
        let file = self.text(map, "path", path, true);
        let caption = self.text(map, "caption", path, true);
        let ((name, root), file, caption) = (root?, file?, caption?);
        let at = format!("{path}.path");
        if let Err(message) = check_clean(&file).and_then(|()| formation_image::require_mime(&file))
        {
            self.bad(&at, message);
            return None;
        }
        if self.resolve {
            if let Err(message) = formation_image::check(&root, &file) {
                self.bad(&at, message);
                return None;
            }
        }
        Some(ImageRef {
            root: name,
            path: file,
            caption,
        })
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
        let known = matches!(
            kind,
            Some("excerpt" | "diff" | "current" | "git-diff" | "node")
        );
        if !known {
            self.bad(
                &format!("{path}.type"),
                "excerpt、diff、current、git-diff、node のどれかにしてください",
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
        if kind != Some("diff") && self.over_budget(path) {
            return None;
        }
        let evidence = match kind {
            Some("excerpt") => self.excerpt(value, path),
            Some("diff") => self.diff(value, path),
            Some("current") => self.current(value, path),
            Some("git-diff") => self.git_diff(value, path),
            _ => self.node(value, path),
        };
        self.resolved += evidence.as_ref().map_or(0, Evidence::size);
        evidence
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
        let lines = if self.resolve {
            self.read_lines(&root, &file, start, end, path)?
        } else {
            Vec::new()
        };
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
            &[
                "type",
                "summary",
                "name",
                "before",
                "after",
                "before_source",
                "after_source",
                "note",
            ],
        )?;
        let summary = self.text(map, "summary", path, true);
        let name = self.text(map, "name", path, true);
        let before_source = self.text(map, "before_source", path, true);
        let after_source = self.text(map, "after_source", path, true);
        let note = self.text(map, "note", path, false);
        let before = self.diff_lines(map, "before", path);
        let after = self.diff_lines(map, "after", path);
        let (before, after) = (before?, after?);
        let name = name?;
        Some(Evidence::Diff {
            summary: summary?,
            before_source: before_source?,
            after_source: after_source?,
            note,
            rows: diff_rows(&unified_diff(&name, &before, &after)),
            name,
        })
    }

    fn diff_lines(&mut self, map: &Object, key: &str, path: &str) -> Option<Vec<String>> {
        self.array(map, key, path, true)?;
        let lines = self.strings(map, key, path, true);
        let mut valid = true;
        for (at, line) in lines.iter().enumerate() {
            if line.contains('\n') {
                self.bad(&format!("{path}.{key}[{at}]"), "改行を含められません");
                valid = false;
            }
        }
        if lines.len() > EXCERPT_LINES as usize {
            self.bad(
                &format!("{path}.{key}"),
                format!("一つの差分は {EXCERPT_LINES} 行までです"),
            );
            valid = false;
        }
        valid.then_some(lines)
    }

    fn current(&mut self, value: &Value, path: &str) -> Option<Evidence> {
        let map = self.keys(value, path, &["type", "note", "excerpts"])?;
        let note = self.text(map, "note", path, true);
        let items = self.some(map, "excerpts", path);
        let mut excerpts = Vec::new();
        for (at, item) in items.into_iter().flatten().enumerate() {
            let here = format!("{path}.excerpts[{at}]");
            if item.get("type").is_some_and(|kind| kind != "excerpt") {
                self.bad(&format!("{here}.type"), "excerpt にしてください");
            } else if !self.over_budget(&here) {
                if let Some(excerpt) = self.excerpt(item, &here) {
                    self.resolved += excerpt.size();
                    excerpts.push(excerpt);
                }
            }
        }
        Some(Evidence::Current {
            note: note?,
            excerpts,
        })
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
        if !self.resolve {
            return Some(Evidence::GitDiff {
                summary,
                root: name,
                path: file,
                base,
                head,
                note,
                rows: Vec::new(),
                truncated: false,
            });
        }
        match git_diff(&root, &file, &base, head.as_deref()) {
            Ok((diff, truncated)) => Some(Evidence::GitDiff {
                summary,
                root: name,
                path: file,
                base,
                head,
                note,
                rows: diff_rows(&diff),
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
        if !self.resolve {
            return Some(Evidence::Node {
                root: name,
                reference,
                note,
                text: String::new(),
            });
        }
        match node_text(&root, &reference, &mut self.docs) {
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
                let mermaid = self.mermaid(map, path);
                let caption = self.text(map, "caption", path, false);
                Some(Block::Diagram {
                    mermaid: mermaid?,
                    caption,
                })
            }
            "image" => {
                let map = self.keys(value, path, &["type", "root", "path", "caption"])?;
                self.image_ref(map, path).map(Block::Image)
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
                    "paragraph、heading、list、callout、table、before-after、folded、diagram、image、evidence のどれかにしてください",
                );
                None
            }
        }
    }

    /// The Mermaid text of `map["mermaid"]`: not empty, and its first word names one of the diagram types the screen draws.
    fn mermaid(&mut self, map: &Object, path: &str) -> Option<String> {
        let mermaid = self.text(map, "mermaid", path, true)?;
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
        Some(mermaid)
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
        let keys = [
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
            "scene",
            "scene_image",
            "occurrence",
            "conditions",
            "choice_details",
        ];
        let map = self.keys(value, path, &keys)?;
        match map.get("kind").and_then(Value::as_str) {
            Some(kind) if kind == expected.name() => {}
            _ => self.bad(
                &format!("{path}.kind"),
                format!("この欄に置けるカードの kind は {} です", expected.name()),
            ),
        }
        let number = self.text(map, "number", path, true);
        if let Some(number) = &number {
            if !self.numbers.insert(number.clone()) {
                self.bad(
                    &format!("{path}.number"),
                    format!("同じ番号のカードがもう一枚あります: {number}"),
                );
            }
        }
        let title = self.text(map, "title", path, true);
        let summary = self.text(map, "summary", path, true);
        let scene = self.text(map, "scene", path, expected.lettered());
        let scene_image = self.scene_image(map, path, expected);
        let occurrence = self.occurrence(map, path, expected);
        let conditions = self.conditions(map, path, expected);
        let options = self.options(map, path, expected, &conditions);
        let choice_details = self.choice_details(map, path, expected);
        let (recommendation, recommendation_reason) = self.recommendation(map, path, expected);
        let background = self.text(map, "background", path, false);
        let facts = self.facts(map, path);
        let blocks = self.blocks_of(map, "blocks", path, 0);
        let evidence = self.evidence_of(map, "evidence", path);
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
            scene,
            scene_image,
            occurrence,
            conditions,
            choice_details,
        })
    }

    /// Whether `map[key]` is given; on a kind that does not ask it is a violation, and it is not taken.
    fn only_asking(&mut self, map: &Object, key: &str, path: &str, kind: CardKind) -> bool {
        let given = map.get(key).is_some_and(|v| !v.is_null());
        if given && !kind.lettered() {
            self.bad(
                &format!("{path}.{key}"),
                "この種類のカードには付けられません",
            );
            return false;
        }
        given
    }

    fn scene_image(&mut self, map: &Object, path: &str, kind: CardKind) -> Option<ImageRef> {
        if !self.only_asking(map, "scene_image", path, kind) {
            return None;
        }
        let at = format!("{path}.scene_image");
        let image = self.keys(&map["scene_image"], &at, &["root", "path", "caption"])?;
        self.image_ref(image, &at)
    }

    fn occurrence(&mut self, map: &Object, path: &str, kind: CardKind) -> Option<Occurrence> {
        let at = format!("{path}.occurrence");
        let asked = match kind {
            CardKind::Nr => self.subject == Some(Subject::Design),
            _ => false,
        };
        let given = map.get("occurrence").is_some_and(|v| !v.is_null());
        if !asked {
            if given {
                self.bad(&at, "この種類のカードには付けられません");
            }
            return None;
        }
        if !given {
            self.bad(&at, "必須です");
            return None;
        }
        let occurrence = self.keys(
            &map["occurrence"],
            &at,
            &[
                "conditions",
                "likelihood",
                "basis",
                "impact",
                "detectability",
            ],
        )?;
        let conditions = match self.some(occurrence, "conditions", &at) {
            Some(_) => self.strings(occurrence, "conditions", &at, true),
            None => Vec::new(),
        };
        let likelihood = match occurrence.get("likelihood").and_then(Value::as_str) {
            Some("frequent") => Some(Likelihood::Frequent),
            Some("occasional") => Some(Likelihood::Occasional),
            Some("rare") => Some(Likelihood::Rare),
            _ => {
                self.bad(
                    &format!("{at}.likelihood"),
                    "frequent、occasional、rare のどれかにしてください",
                );
                None
            }
        };
        let basis = self.text(occurrence, "basis", &at, true);
        if let Some(basis) = &basis {
            if !basis.starts_with("実測: ") && !basis.starts_with("推測: ") {
                self.bad(
                    &format!("{at}.basis"),
                    "`実測: ` か `推測: ` で始めてください",
                );
            }
        }
        let impact = self.text(occurrence, "impact", &at, true);
        let detectability = self.text(occurrence, "detectability", &at, true);
        if conditions.is_empty() {
            return None;
        }
        Some(Occurrence {
            conditions,
            likelihood: likelihood?,
            basis: basis?,
            impact: impact?,
            detectability: detectability?,
        })
    }

    fn conditions(&mut self, map: &Object, path: &str, kind: CardKind) -> Vec<Condition> {
        if !self.only_asking(map, "conditions", path, kind) {
            return Vec::new();
        }
        let Some(items) = self.array(map, "conditions", path, false) else {
            return Vec::new();
        };
        let mut conditions: Vec<Condition> = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("{path}.conditions[{at}]");
            let Some(condition) = self.keys(item, &here, &["id", "text"]) else {
                continue;
            };
            let id = self.text(condition, "id", &here, true);
            let text = self.text(condition, "text", &here, true);
            let (Some(id), Some(text)) = (id, text) else {
                continue;
            };
            if conditions.iter().any(|c| c.id == id) {
                self.bad(&format!("{here}.id"), format!("同じ id があります: {id}"));
                continue;
            }
            conditions.push(Condition { id, text });
        }
        conditions
    }

    fn choice_details(
        &mut self,
        map: &Object,
        path: &str,
        kind: CardKind,
    ) -> BTreeMap<String, String> {
        let mut details = BTreeMap::new();
        let at = format!("{path}.choice_details");
        let Some(value) = map.get("choice_details").filter(|v| !v.is_null()) else {
            return details;
        };
        let Some(object) = value.as_object() else {
            self.bad(&at, "オブジェクトにしてください");
            return details;
        };
        for key in object.keys() {
            if !kind.fixed_keys().contains(&key.as_str()) {
                let message = if kind.fixed_keys().is_empty() {
                    "この種類のカードには固定の選択肢がありません".to_owned()
                } else {
                    format!("{} のどれかにしてください", kind.fixed_keys().join("、"))
                };
                self.bad(&format!("{at}.{key}"), message);
                continue;
            }
            if let Some(text) = self.text(object, key, &at, true) {
                details.insert(key.clone(), text);
            }
        }
        details
    }

    fn options(
        &mut self,
        map: &Object,
        path: &str,
        kind: CardKind,
        conditions: &[Condition],
    ) -> Vec<CardOption> {
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
        let mut unmet_without_conditions = false;
        for (at, item) in items.iter().enumerate() {
            let here = format!("{path}.options[{at}]");
            let Some(option) = self.keys(
                item,
                &here,
                &[
                    "key", "label", "detail", "unmet", "image", "sample", "diagram",
                ],
            ) else {
                continue;
            };
            let key = self.text(option, "key", &here, true);
            let label = self.text(option, "label", &here, true);
            let detail = self.text(option, "detail", &here, false);
            let unmet = self.unmet(option, &here, conditions);
            unmet_without_conditions |= !unmet.is_empty() && conditions.is_empty();
            let image = match option.get("image").filter(|v| !v.is_null()) {
                Some(image) => {
                    let at = format!("{here}.image");
                    self.keys(image, &at, &["root", "path", "caption"])
                        .and_then(|image| self.image_ref(image, &at))
                }
                None => None,
            };
            let sample = self.sample(option, &here);
            let diagram = match option.get("diagram").filter(|v| !v.is_null()) {
                Some(diagram) => {
                    let at = format!("{here}.diagram");
                    self.keys(diagram, &at, &["mermaid"])
                        .and_then(|diagram| self.mermaid(diagram, &at))
                }
                None => None,
            };
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
                options.push(CardOption {
                    key,
                    label,
                    detail,
                    unmet,
                    image,
                    sample,
                    diagram,
                });
            }
        }
        if unmet_without_conditions {
            self.bad(
                &format!("{path}.conditions"),
                "選択肢に unmet があるカードには必須です",
            );
        }
        options
    }

    /// The `unmet` of an option: `{id, reason}` for conditions of the card, each at most once.
    fn unmet(&mut self, option: &Object, path: &str, conditions: &[Condition]) -> Vec<Unmet> {
        let Some(items) = self.array(option, "unmet", path, false) else {
            return Vec::new();
        };
        let mut unmet: Vec<Unmet> = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("{path}.unmet[{at}]");
            let Some(entry) = self.keys(item, &here, &["id", "reason"]) else {
                continue;
            };
            let id = self.text(entry, "id", &here, true);
            let reason = self.text(entry, "reason", &here, true);
            let (Some(id), Some(reason)) = (id, reason) else {
                continue;
            };
            if !conditions.is_empty() && !conditions.iter().any(|c| c.id == id) {
                self.bad(
                    &format!("{here}.id"),
                    format!("カードの conditions にない id です: {id}"),
                );
            } else if unmet.iter().any(|u| u.id == id) {
                self.bad(&format!("{here}.id"), format!("同じ id があります: {id}"));
            } else {
                unmet.push(Unmet { id, reason });
            }
        }
        unmet
    }

    /// The `sample` of an option: a text in a size (1 to 200 px), a weight (100 to 900 in steps of 100) and, optionally, a colour (`#rgb` or `#rrggbb`).
    fn sample(&mut self, option: &Object, path: &str) -> Option<Sample> {
        let value = option.get("sample").filter(|v| !v.is_null())?;
        let at = format!("{path}.sample");
        let map = self.keys(value, &at, &["text", "font_size", "font_weight", "color"])?;
        let text = self.text(map, "text", &at, true);
        let size = self.uint(map, "font_size", &at, true);
        let weight = self.uint(map, "font_weight", &at, true);
        let color = self.text(map, "color", &at, false);
        let size = size.filter(|n| (1..=200).contains(n));
        if size.is_none() && map.get("font_size").is_some_and(Value::is_number) {
            self.bad(
                &format!("{at}.font_size"),
                "1 から 200 の整数にしてください",
            );
        }
        let weight = weight.filter(|n| (100..=900).contains(n) && n % 100 == 0);
        if weight.is_none() && map.get("font_weight").is_some_and(Value::is_number) {
            self.bad(
                &format!("{at}.font_weight"),
                "100 から 900 の 100 きざみの整数にしてください",
            );
        }
        if let Some(color) = &color {
            let hex = color.strip_prefix('#').unwrap_or("");
            if !matches!(hex.len(), 3 | 6) || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
                self.bad(&format!("{at}.color"), "`#rgb` か `#rrggbb` にしてください");
            }
        }
        Some(Sample {
            text: text?,
            font_size: size?,
            font_weight: weight?,
            color,
        })
    }

    fn recommendation(
        &mut self,
        map: &Object,
        path: &str,
        kind: CardKind,
    ) -> (Option<String>, Option<String>) {
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
            let Some(fact) = self.keys(item, &here, &["label", "value", "ref", "path", "root"])
            else {
                continue;
            };
            let label = self.text(fact, "label", &here, true);
            let value = self.text(fact, "value", &here, true);
            let content = self.fact_content(fact, &here, value.as_deref());
            if let (Some(label), Some(value)) = (label, value) {
                facts.push(Fact {
                    label,
                    value,
                    content,
                });
            }
        }
        facts
    }

    /// What the `ref` or the `path` of a fact holds (`root`, which defaults to `deliverables`, goes with either): a node, a Markdown file, a text file or an image. A page read for its cards alone checks the shape and reads none of it.
    fn fact_content(
        &mut self,
        fact: &Object,
        path: &str,
        value: Option<&str>,
    ) -> Option<FactContent> {
        let reference = self.text(fact, "ref", path, false);
        let file = self.text(fact, "path", path, false);
        if reference.is_some() && file.is_some() {
            self.bad(path, "ref と path は両方は付けられません");
            return None;
        }
        if reference.is_none() && file.is_none() {
            if fact.get("root").is_some_and(|v| !v.is_null()) {
                self.bad(&format!("{path}.root"), "ref か path と一緒に使います");
            }
            return None;
        }
        let (name, root) = self.root_of(fact, path)?;
        if let Some(reference) = reference {
            let at = format!("{path}.ref");
            if let Err(message) = split_ref(&reference) {
                self.bad(&at, message);
                return None;
            }
            if !self.resolve || self.over_budget(path) {
                return None;
            }
            return match node_text(&root, &reference, &mut self.docs) {
                Ok(text) => {
                    self.resolved += text.len();
                    Some(FactContent::Node {
                        root: name,
                        reference,
                        text,
                    })
                }
                Err(message) => {
                    self.bad(&at, message);
                    None
                }
            };
        }
        let file = file?;
        let at = format!("{path}.path");
        if let Err(message) = check_clean(&file) {
            self.bad(&at, message);
            return None;
        }
        if !self.resolve || self.over_budget(path) {
            return None;
        }
        if formation_image::mime_of(&file).is_some() {
            if let Err(message) = formation_image::check(&root, &file) {
                self.bad(&at, message);
                return None;
            }
            return Some(FactContent::Image(ImageRef {
                root: name,
                path: file,
                caption: value.unwrap_or_default().to_owned(),
            }));
        }
        let read = locate(&root, &file).and_then(|real| read_bounded(&real, FACT_FILE_LIMIT));
        let text = match read.and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| "UTF-8 の文字ではありません".to_owned())
        }) {
            Ok(text) => text,
            Err(message) => {
                self.bad(&at, message);
                return None;
            }
        };
        self.resolved += text.len();
        let lower = file.to_ascii_lowercase();
        Some(if lower.ends_with(".md") || lower.ends_with(".markdown") {
            FactContent::Markdown {
                root: name,
                path: file,
                text,
            }
        } else {
            FactContent::Text {
                root: name,
                path: file,
                text,
            }
        })
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
                scope.push(ScopeGroup {
                    heading,
                    items,
                    design: false,
                });
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
        if !self.resolve {
            return Some(ScopeItem {
                root: name,
                reference,
                path: file,
                description: description?,
                extras,
                text,
            });
        }
        if let Some(reference) = &reference {
            if !self.over_budget(path) {
                match node_text(&root, reference, &mut self.docs) {
                    Ok(node) => {
                        self.resolved += node.len();
                        text = Some(node);
                    }
                    Err(message) => self.bad(&format!("{path}.ref"), message),
                }
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
        let map = self.keys(
            value,
            "$.quality_loop",
            &["rounds", "fix_cycles", "must_fix_resolved"],
        )?;
        let design = self.subject == Some(Subject::Design);
        let rounds = self.uint(map, "rounds", "$.quality_loop", true);
        let fix_cycles = if design {
            self.uint(map, "fix_cycles", "$.quality_loop", true)
        } else {
            if map.get("fix_cycles").is_some_and(|v| !v.is_null()) {
                self.bad(
                    "$.quality_loop.fix_cycles",
                    "design のページだけに付けられます",
                );
            }
            None
        };
        let resolved = self.uint(map, "must_fix_resolved", "$.quality_loop", true);
        Some(QualityLoop {
            rounds: rounds?,
            fix_cycles,
            must_fix_resolved: resolved?,
        })
    }

    /// `terms`: `{word, description}`, both texts.
    fn terms(&mut self, top: &Object) -> Vec<Term> {
        let Some(items) = self.array(top, "terms", "$", false) else {
            return Vec::new();
        };
        let mut terms = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("$.terms[{at}]");
            let Some(map) = self.keys(item, &here, &["word", "description"]) else {
                continue;
            };
            let word = self.text(map, "word", &here, true);
            let description = self.text(map, "description", &here, true);
            if let (Some(word), Some(description)) = (word, description) {
                terms.push(Term { word, description });
            }
        }
        terms
    }

    /// `hold`: `true` only on an `open-questions` page of a requirement; `false` is the same as none.
    fn hold(&mut self, top: &Object, kind: PageKind, subject: Subject) -> bool {
        let hold = self.flag(top, "hold", "$");
        if hold && !(kind == PageKind::OpenQuestions && subject == Subject::Requirement) {
            self.bad(
                "$.hold",
                "true にできるのは、requirement の open-questions のページだけです",
            );
            return false;
        }
        hold
    }

    fn withdrawn(&mut self, top: &Object) -> Vec<Withdrawn> {
        let Some(items) = self.array(top, "withdrawn_needs_user_decision", "$", false) else {
            return Vec::new();
        };
        let mut withdrawn = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("$.withdrawn_needs_user_decision[{at}]");
            let Some(map) = self.keys(item, &here, &["number", "title", "withdrawal_reason"])
            else {
                continue;
            };
            let number = self.text(map, "number", &here, true);
            let title = self.text(map, "title", &here, true);
            let reason = self.text(map, "withdrawal_reason", &here, true);
            if let (Some(number), Some(title), Some(withdrawal_reason)) = (number, title, reason) {
                withdrawn.push(Withdrawn {
                    number,
                    title,
                    withdrawal_reason,
                });
            }
        }
        withdrawn
    }

    fn noticed(&mut self, top: &Object) -> Vec<Noticed> {
        let Some(items) = self.array(top, "noticed", "$", false) else {
            return Vec::new();
        };
        let mut noticed = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let here = format!("$.noticed[{at}]");
            let Some(map) = self.keys(item, &here, &["title", "text", "evidence"]) else {
                continue;
            };
            let title = self.text(map, "title", &here, true);
            let text = self.text(map, "text", &here, true);
            let evidence = self.evidence_of(map, "evidence", &here);
            if let (Some(title), Some(text)) = (title, text) {
                noticed.push(Noticed {
                    title,
                    text,
                    evidence,
                });
            }
        }
        noticed
    }

    /// The repositories of `design.json` `/implementation_order` of the deliverables, in order; none when the page is not resolved or the file does not say (the nodes the page cites report that).
    fn implementation_order(&mut self) -> Vec<String> {
        if !self.resolve {
            return Vec::new();
        }
        let Some(Some(root)) = self.roots.get(DEFAULT_ROOT).cloned() else {
            return Vec::new();
        };
        node_text(&root, "design.json#/implementation_order", &mut self.docs)
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .unwrap_or_default()
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
            _ => {
                self.bad("$.page_kind", "open-questions か approval にしてください");
                None
            }
        };
        let subject = match (kind, top.get("subject").and_then(Value::as_str)) {
            (Some(_), Some("requirement")) => Some(Subject::Requirement),
            (Some(_), Some("design")) => Some(Subject::Design),
            (Some(_), _) => {
                self.bad("$.subject", "requirement か design にしてください");
                None
            }
            (None, _) => None,
        };
        let (kind, subject) = (kind?, subject?);
        self.subject = Some(subject);
        let mut keys = vec![
            "schema_version",
            "page_kind",
            "subject",
            "context_label",
            "title",
            "roots",
            "what",
            "previous_reply",
            "terms",
            "clarified_numbers",
            "hold",
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
                "withdrawn_needs_user_decision",
                "noticed",
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
        let terms = self.terms(top);
        let hold = self.hold(top, kind, subject);
        let clarified_numbers = self.strings(top, "clarified_numbers", "$", false);
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
            restored: Vec::new(),
            terms,
            hold,
            clarified_numbers,
            questions: Vec::new(),
            approval_scope: Vec::new(),
            design_items: Vec::new(),
            implementation_order: Vec::new(),
            changes: Vec::new(),
            needs_user_decision: Vec::new(),
            residual_must_fix: Vec::new(),
            structural_proposals: Vec::new(),
            adr: None,
            risks: None,
            settled_decisions: Vec::new(),
            withdrawn_needs_user_decision: Vec::new(),
            noticed: Vec::new(),
            quality_loop: None,
        };
        match kind {
            PageKind::OpenQuestions => {
                page.questions = self.cards(top, "questions", CardKind::Question, true);
            }
            PageKind::Approval => {
                let scope = self.scope(top);
                if subject == Subject::Design {
                    (page.approval_scope, page.design_items) = split_design(scope);
                    page.implementation_order = self.implementation_order();
                } else {
                    page.approval_scope = scope;
                }
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
                page.withdrawn_needs_user_decision = self.withdrawn(top);
                page.noticed = self.noticed(top);
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

/// The ref of a design item of `design.json`; the segment after it is the item's id.
const DESIGN_REF: &str = "design.json#/designs/";

/// The row of 設計項目 that a scope item makes: its `ref` is `design.json#/designs/{id}`, its title the description without its leading `{id} `.
fn design_row(item: &ScopeItem) -> Option<DesignItem> {
    let reference = item.reference.as_deref()?;
    let id = reference.strip_prefix(DESIGN_REF)?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    let title = item
        .description
        .strip_prefix(&format!("{id} "))
        .unwrap_or(&item.description);
    let release = item
        .text
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|node| node.get("release").and_then(Value::as_u64))
        .and_then(|n| u32::try_from(n).ok());
    Some(DesignItem {
        id: id.to_owned(),
        title: title.to_owned(),
        root: item.root.clone(),
        reference: reference.to_owned(),
        text: item.text.clone(),
        release,
    })
}

/// A group whose every item names a design item moves its items to the rows of 設計項目 and keeps its heading; every other group stays as it is.
fn split_design(groups: Vec<ScopeGroup>) -> (Vec<ScopeGroup>, Vec<DesignItem>) {
    let mut kept = Vec::new();
    let mut rows = Vec::new();
    for group in groups {
        let items: Option<Vec<DesignItem>> = group.items.iter().map(design_row).collect();
        match items {
            Some(items) if !items.is_empty() => {
                rows.extend(items);
                kept.push(ScopeGroup {
                    heading: group.heading,
                    items: Vec::new(),
                    design: true,
                });
            }
            _ => kept.push(group),
        }
    }
    (kept, rows)
}

/// Checks the input `value` of a decision page and resolves its evidence. Every violation is returned, in the order the input is walked; a page with any is not returned.
pub fn build(value: &Value, allowed: &Allowed) -> Result<DecisionPage, Vec<Violation>> {
    build_with(value, allowed, true)
}

/// `build` for a reader that needs the cards alone (the reply of the owner's answers): every check of the input is made, and no evidence is read, so no file, no JSON node and no `git` is touched and the page's size is not looked at. The evidence of the page is there with its shape and empty content.
pub fn build_input(value: &Value, allowed: &Allowed) -> Result<DecisionPage, Vec<Violation>> {
    build_with(value, allowed, false)
}

fn build_with(
    value: &Value,
    allowed: &Allowed,
    resolve: bool,
) -> Result<DecisionPage, Vec<Violation>> {
    let mut walk = Walk::new(allowed, resolve);
    let page = walk.page(value);
    if !walk.errors.is_empty() {
        return Err(walk.errors);
    }
    let Some(mut page) = page else {
        return Err(alone("ページを読めませんでした"));
    };
    page.restored = formation_reply::restore(&page);
    if !resolve {
        return Ok(page);
    }
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

/// `load` for a reader that needs the cards alone (`read_value`, then `build_input`).
fn load_input(
    given: &str,
    worktree: &str,
    allowed: &Allowed,
) -> Result<DecisionPage, Vec<Violation>> {
    build_input(&read_value(given, worktree, allowed)?, allowed)
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
    /// When the owner's reply to it was sent to the leader (epoch milliseconds): an answered page no longer waits (#923). A record from before the field has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct Pages {
    #[serde(default)]
    pages: Vec<PageRecord>,
}

/// `Pages` as it is read: each record on its own, so that one that does not convert is skipped.
#[derive(Deserialize)]
struct RawPages {
    #[serde(default)]
    pages: Vec<serde_json::Value>,
}

fn read_pages_strict(config: &Path, formation: &str) -> Result<Vec<PageRecord>, String> {
    let path = formation::dir(config, formation).join(PAGES_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{} を読めません: {e}", path.display())),
    };
    // A record that no longer reads (a kind of page that was removed, say) is skipped, so that it does not make every other page of the formation unreadable; the next write drops it.
    serde_json::from_str::<RawPages>(&text)
        .map(|raw| {
            raw.pages
                .into_iter()
                .filter_map(|page| serde_json::from_value(page).ok())
                .collect()
        })
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

/// The page of `child` that waits for the owner: the record of the child's page, unless it is older than the child's launch (a child of the same name that was closed and launched again does not wait on the page of the one before) or the owner has answered it.
fn pending_record<'a>(child: &Child, pages: &'a [PageRecord]) -> Option<&'a PageRecord> {
    let launch = child.launch.as_ref()?;
    pages
        .iter()
        .find(|p| p.child == child.name && p.at >= launch.launched_at && p.answered_at.is_none())
}

/// Marks the page of `child` recorded at `at` as answered at `answered_at`, so that it no longer waits. The record is read, changed and written under the same locks as `put_page`. A page that is not there, one that a newer page replaced (another `at`) and one that is answered already are refused, and nothing is written.
pub fn mark_answered(
    config: &Path,
    formation: &str,
    child: &str,
    at: u64,
    answered_at: u64,
) -> Result<(), String> {
    formation::check_name(formation)?;
    formation::check_name(child)?;
    let _held = PAGES.lock().unwrap_or_else(PoisonError::into_inner);
    if !formation::dir(config, formation).is_dir() {
        return Err(format!(
            "フォーメーション「{formation}」はありません（削除されました）"
        ));
    }
    let _other_processes = formation::lock_file(config, formation, PAGES_LOCK)?;
    let mut pages = read_pages_strict(config, formation)?;
    let Some(page) = pages.iter_mut().find(|p| p.child == child && p.at == at) else {
        return Err(format!(
            "「{child}」の判断ページは差し替わったか、もうありません"
        ));
    };
    if page.answered_at.is_some() {
        return Err(format!("「{child}」の判断ページには、もう答えています"));
    }
    page.answered_at = Some(answered_at);
    let text = serde_json::to_string_pretty(&Pages { pages }).map_err(|e| e.to_string())?;
    accounts::write_atomic(&formation::dir(config, formation), PAGES_FILE, &text)
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
            answered_at: None,
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
    read_here_at(config, formation, child, true).map(|(page, _)| page)
}

/// `read_here`, and the time the page was recorded at (the mark's `atMs`): what the answer to the page names, so that a page that was replaced meanwhile is told from the one that was shown. `resolve` false reads the cards alone (`load_input`: no file, node or `git` of the evidence is read).
pub fn read_here_at(
    config: &Path,
    formation: &str,
    child: &str,
    resolve: bool,
) -> Result<(DecisionPage, u64), String> {
    let (page, worktree) = waiting_page(config, formation, child)?;
    let allowed = allowed_here().map_err(|r| formation::refusal_text(&r))?;
    let loaded = if resolve {
        load(&page.path, &worktree, &allowed)
    } else {
        load_input(&page.path, &worktree, &allowed)
    }
    .map_err(|v| violations_text(&v))?;
    Ok((loaded, page.at))
}

/// The page of `child` for the reply to it, and the time it was recorded at, read where the formation's record is: here for a formation of this Mac, on the server of its PC for a formation of a saved environment (#923). The cards alone are read (`read_here_at` with `resolve` false, and `light` for the server): the reply holds none of the evidence, so none of it is read or sent over.
pub fn page_input_with_time(
    config: &Path,
    formation: &str,
    child: &str,
    open: &impl AsyncFn(&str) -> Result<Client, String>,
) -> Result<(DecisionPage, u64), String> {
    formation::check_name(formation)?;
    let (environment, started) = formation::formation_home(config, formation);
    if environment == LOCAL {
        return read_here_at(config, formation, child, false);
    }
    if !started {
        return Err(format!("「{child}」に判断待ちのページはありません"));
    }
    formation::on_pc(
        &environment,
        open,
        formation::PC_RECORD_WAIT,
        async |client| client.page_read_at(formation, child, true).await,
    )
}

/// Marks the page of `child` recorded at `at` as answered, where the formation's record is (`mark_answered` here, or `page.answer` of the server of its PC).
pub fn mark_page_answered(
    config: &Path,
    formation: &str,
    child: &str,
    at: u64,
    open: &impl AsyncFn(&str) -> Result<Client, String>,
) -> Result<(), String> {
    formation::check_name(formation)?;
    let (environment, started) = formation::formation_home(config, formation);
    if environment == LOCAL {
        return mark_answered(config, formation, child, at, formation::now_ms());
    }
    if !started {
        return Err(format!("「{child}」に判断待ちのページはありません"));
    }
    formation::on_pc(
        &environment,
        open,
        formation::PC_RECORD_WAIT,
        async |client| client.page_answered(formation, child, at).await,
    )
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

// ---- the images of a page ----

/// The image `path` of the root `root` of the page that waits on `child`, prepared for the screen. The page is checked again (its cards alone, no evidence is read), so a root is one of its roots, which `Allowed` has held to the repositories of this PC; the path is then held inside the root as every path of a page is.
pub fn image_with(
    config: &Path,
    formation: &str,
    child: &str,
    root: &str,
    path: &str,
    allowed: &Allowed,
) -> Result<Arc<formation_image::Prepared>, String> {
    let (page, worktree) = waiting_page(config, formation, child)?;
    let loaded = load_input(&page.path, &worktree, allowed).map_err(|v| violations_text(&v))?;
    let dir = loaded
        .roots
        .get(root)
        .ok_or_else(|| format!("roots にない名前です: {root}"))?;
    formation_image::file(Path::new(dir), path)
}

/// `image_with` for the repositories of this PC (`image.read` of the server, and the read of a formation of this Mac).
pub fn image_here(
    config: &Path,
    formation: &str,
    child: &str,
    root: &str,
    path: &str,
) -> Result<Arc<formation_image::Prepared>, String> {
    let allowed = allowed_here().map_err(|r| formation::refusal_text(&r))?;
    image_with(config, formation, child, root, path, &allowed)
}

/// An image of the page of `child` as a `data:` URI: read here for a formation of this Mac, and through the server of its PC for a formation of a saved environment (the file is on that PC).
fn image_for_screen(
    config: &Path,
    formation: &str,
    child: &str,
    root: &str,
    path: &str,
    open: &impl AsyncFn(&str) -> Result<Client, String>,
) -> Result<String, String> {
    formation::check_name(formation)?;
    let (environment, started) = formation::formation_home(config, formation);
    if environment == LOCAL {
        let image = image_here(config, formation, child, root, path)?;
        return Ok(formation_image::data_uri(image.mime, &image.bytes));
    }
    if !started {
        return Err(format!("「{child}」に判断待ちのページはありません"));
    }
    formation::on_pc(
        &environment,
        open,
        formation::PC_RECORD_WAIT,
        async |client| client.image_read(formation, child, root, path).await,
    )
}

/// An image of the decision page that waits on the child `child` of the formation `name`, as a `data:` URI (A-41, #1153): the file `path` of the page's root `root`, made smaller when it is over 3 MiB. The page holds only the name of the file, and the screen asks for each image when it draws it. A failure carries the reason, which the screen shows in the image's place.
#[tauri::command]
pub async fn formation_page_image(
    app: tauri::AppHandle,
    name: String,
    child: String,
    root: String,
    path: String,
) -> Result<String, String> {
    let dir = config_dir(&app)?;
    let version = app.package_info().version.to_string();
    orca::blocking(move || {
        image_for_screen(
            &dir,
            &name,
            &child,
            &root,
            &path,
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

    fn occurrence() -> Value {
        json!({
            "conditions": ["条件"],
            "likelihood": "rare",
            "basis": "実測: 試した",
            "impact": "影響",
            "detectability": "気づかない"
        })
    }

    fn question(number: &str) -> Value {
        json!({
            "kind": "question",
            "number": number,
            "title": "どちらにしますか",
            "summary": "要約",
            "scene": "場面",
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
            "quality_loop": {"rounds": 2, "fix_cycles": 1, "must_fix_resolved": 3}
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
    fn an_approval_page_with_every_card_kind_and_block_is_accepted() {
        let repo = repo("accept-blocks");
        let mut value = approval(&repo);
        value["changes"] = json!([{"heading": "変更", "blocks": [
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
                {"type": "diff", "summary": "差", "name": "x", "before": ["a"], "after": ["b"], "before_source": "元", "after_source": "先"},
                {"type": "current", "note": "後で決める", "excerpts": [{"root": "repo", "path": "src/main.rs", "start": 1}]},
                {"type": "git-diff", "summary": "差", "root": "repo", "path": "src/main.rs", "base": "HEAD~1", "head": "HEAD"},
                {"type": "node", "root": "deliverables", "ref": "design.json#/designs/1"}
            ]}
        ]}]);
        value["residual_must_fix"] = json!([{
            "kind": "must-fix", "number": "MF-1", "title": "t", "summary": "s",
            "recommendation": "fix", "recommendation_reason": "r",
            "facts": [{"label": "検出元", "value": "v"}], "background": "b"
        }]);
        value["needs_user_decision"] = json!([{
            "kind": "nr", "number": "NR-1", "title": "t", "summary": "s",
            "scene": "場面", "occurrence": occurrence(),
            "options": [{"key": "A", "label": "a"}],
            "recommendation": "A", "recommendation_reason": "r"
        }]);
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(page.changes[0].blocks.len(), 9);
        assert_eq!(page.residual_must_fix[0].facts.len(), 1);
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
        let Evidence::Node { text, .. } = &items[4] else {
            panic!("a node");
        };
        assert!(text.contains("second"));
        let Evidence::Current { note, excerpts } = &items[2] else {
            panic!("a current");
        };
        assert_eq!(note, "後で決める");
        assert!(
            matches!(&excerpts[..], [Evidence::Excerpt { lines, .. }] if lines == &["fn one() {}"])
        );
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
        value["questions"][0]["unlisted"] = json!("not in the contract");
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
                "$.questions[0].unlisted",
                "$.title",
                "$.what",
            ]
        );
    }

    #[test]
    fn the_page_kind_and_the_subject_go_together() {
        let repo = repo("kinds");
        let mut value = open_questions(&repo);
        value["page_kind"] = json!("unknown-kind");
        assert_eq!(paths(&violations(&value, &repo)), ["$.page_kind"]);
        let mut value = open_questions(&repo);
        value["subject"] = json!("code");
        assert_eq!(paths(&violations(&value, &repo)), ["$.subject"]);
        let mut value = approval(&repo);
        value["subject"] = json!("requirement");
        value["quality_loop"]["fix_cycles"] = Value::Null;
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
            {"type": "video", "root": "repo", "path": "a.mp4", "caption": "c"},
            {"type": "diagram", "mermaid": "pie\n \"a\": 1"},
            {"type": "list", "items": []},
            {"type": "evidence", "items": [{"type": "table", "note": "n", "excerpts": []}]}
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
    fn a_page_read_for_its_cards_alone_checks_the_shape_of_evidence_and_reads_none_of_it() {
        let repo = repo("input-only");
        let mut value = approval(&repo);
        let cited = json!([
            {"type": "excerpt", "root": "repo", "path": "missing.txt", "start": 1},
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "src/main.rs", "base": "nonexistent-rev", "head": "HEAD"},
            {"type": "node", "root": "deliverables", "ref": "design.json#/designs/NONE"}
        ]);
        value["needs_user_decision"] = json!([
            {"kind": "nr", "number": "NR-1", "title": "t", "summary": "s", "scene": "場面", "occurrence": occurrence(), "options": [{"key": "A", "label": "a"}], "recommendation": "A", "recommendation_reason": "r", "evidence": cited}
        ]);
        value["approval_scope"][0]["items"] = json!([
            {"ref": "design.json#/designs/NONE", "description": "d"},
            {"path": "missing.md", "description": "d", "extras": ["also-missing.md"]}
        ]);
        // With its evidence read, every file that is not there is a violation.
        assert!(build(&value, &repo.allowed()).is_err());
        // For its cards alone, none of it is read: the cards are there, the evidence has its shape and no content.
        let page = build_input(&value, &repo.allowed()).unwrap();
        assert_eq!(page.needs_user_decision[0].number, "NR-1");
        assert_eq!(page.needs_user_decision[0].evidence.len(), 3);
        let Evidence::Excerpt { lines, .. } = &page.needs_user_decision[0].evidence[0] else {
            panic!("an excerpt");
        };
        assert!(lines.is_empty());
        let Evidence::GitDiff { rows, .. } = &page.needs_user_decision[0].evidence[1] else {
            panic!("a git diff");
        };
        assert!(rows.is_empty());
        assert!(page.approval_scope[0]
            .items
            .iter()
            .all(|i| i.text.is_none()));
        // Every check of the input is still made.
        let mut bad = value.clone();
        bad["needs_user_decision"][0]["evidence"][0]["start"] = json!(0);
        bad["needs_user_decision"][0]["evidence"][1]["base"] = json!("--output=x");
        assert_eq!(
            paths(&build_input(&bad, &repo.allowed()).unwrap_err()),
            [
                "$.needs_user_decision[0].evidence[0].start",
                "$.needs_user_decision[0].evidence[1].base"
            ]
        );
    }

    #[test]
    fn two_cards_with_the_same_number_are_a_violation() {
        let repo = repo("same-number");
        let mut value = open_questions(&repo);
        value["questions"] = json!([question("論点1"), question("論点2"), question("論点1")]);
        assert_eq!(paths(&violations(&value, &repo)), ["$.questions[2].number"]);
        // Another list of the page shares the numbers of the first.
        let mut value = approval(&repo);
        value["needs_user_decision"] = json!([
            {"kind": "nr", "number": "NR-1", "title": "t", "summary": "s", "scene": "場面", "occurrence": occurrence(), "options": [{"key": "A", "label": "a"}], "recommendation": "A", "recommendation_reason": "r"}
        ]);
        value["residual_must_fix"] = json!([
            {"kind": "must-fix", "number": "NR-1", "title": "t", "summary": "s", "recommendation": "fix", "recommendation_reason": "r"}
        ]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            ["$.residual_must_fix[0].number"]
        );
    }

    #[test]
    fn the_evidence_after_the_page_has_used_up_its_size_is_not_read() {
        let repo = repo("budget");
        let long = "x".repeat(2000);
        let text: String = (0..400).map(|_| format!("{long}\n")).collect();
        write(&repo.dir, "big.txt", &text);
        let big =
            json!({"type": "excerpt", "root": "repo", "path": "big.txt", "start": 1, "end": 400});
        let missing = json!({"type": "excerpt", "root": "repo", "path": "missing.txt", "start": 1});
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([big, big, missing, big]);
        // The first fills the page; the second is told as the cut, and the rest are not read (the missing file is no violation).
        let found = violations(&value, &repo);
        assert_eq!(paths(&found), ["$.questions[0].evidence[1]"]);
        assert!(found[0].message.contains("読んでいません"));
    }

    #[test]
    fn the_nodes_of_one_file_read_and_parse_it_once() {
        let dir = temp_dir("node-cache");
        write(&dir, "design.json", r#"{"a": 1, "b": 2}"#);
        let mut docs = BTreeMap::new();
        assert_eq!(node_text(&dir, "design.json#/a", &mut docs).unwrap(), "1");
        // The file changes on the disk: the walk still reads the one it read first.
        write(&dir, "design.json", r#"{"a": 10, "b": 20}"#);
        assert_eq!(node_text(&dir, "design.json#/b", &mut docs).unwrap(), "2");
        assert_eq!(docs.len(), 1);
        // A file that cannot be read is kept as the failure it was.
        assert!(node_text(&dir, "none.json#/a", &mut docs).is_err());
        write(&dir, "bad.json", "{");
        assert!(node_text(&dir, "bad.json#/a", &mut docs).is_err());
        assert!(node_text(&dir, "design.json#/zzz", &mut docs).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
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
            rows,
            truncated,
            head,
            ..
        } = &page.questions[0].evidence[0]
        else {
            panic!("a git diff");
        };
        let change = rows
            .iter()
            .find(|row| row.kind == DiffRowKind::Change)
            .unwrap();
        assert_eq!(change.left.as_deref(), Some("fn two() {}"));
        assert_eq!(change.right.as_deref(), Some("fn two2() {}"));
        assert!(!truncated);
        assert_eq!(head.as_deref(), Some("HEAD"));
    }

    #[test]
    fn a_git_diff_of_a_folder_that_tracks_an_env_file_is_refused_unread() {
        let repo = repo("git-diff-secret");
        write(&repo.dir, "config/app.txt", "one\n");
        write(&repo.dir, "config/.env.production", "TOKEN=old\n");
        write(&repo.dir, "vendor/.git-hooks/pre", "old\n");
        git(&repo.dir, &["add", "-f", "."]);
        git(&repo.dir, &["commit", "-q", "-m", "config"]);
        write(&repo.dir, "config/app.txt", "two\n");
        write(&repo.dir, "config/.env.production", "TOKEN=new\n");
        write(&repo.dir, "vendor/.git-hooks/pre", "new\n");
        // The folder lists a changed `.env...`: no diff is read, and the message does not carry the value.
        let err = git_diff(&repo.dir, "config", "HEAD", None).unwrap_err();
        assert!(err.contains(".env"), "{err}");
        assert!(!err.contains("TOKEN"), "{err}");
        // The whole tree too.
        assert!(git_diff(&repo.dir, ".", "HEAD", None).is_err());
        // A file of the same folder is read as before; a folder with no secret name in its changes too.
        let (diff, _) = git_diff(&repo.dir, "config/app.txt", "HEAD", None).unwrap();
        assert!(diff.contains("+two"));
        assert!(!diff.contains("TOKEN"));
        let (diff, _) = git_diff(&repo.dir, "vendor", "HEAD", None).unwrap();
        assert!(diff.contains("+new"));
        // The same through a page: the evidence is a violation at its place.
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "config", "base": "HEAD", "head": null},
            {"type": "git-diff", "summary": "s", "root": "repo", "path": "config/app.txt", "base": "HEAD", "head": null}
        ]);
        let found = violations(&value, &repo);
        assert_eq!(paths(&found), ["$.questions[0].evidence[0]"]);
        // A change in a commit range is looked at the same way.
        git(&repo.dir, &["add", "-f", "."]);
        git(&repo.dir, &["commit", "-q", "-m", "change"]);
        assert!(git_diff(&repo.dir, "config", "HEAD~1", Some("HEAD")).is_err());
        assert!(git_diff(&repo.dir, "config/app.txt", "HEAD~1", Some("HEAD")).is_ok());
    }

    #[test]
    fn a_secret_name_among_the_names_of_a_diff_is_found_in_any_component() {
        assert!(names_a_secret(b"a/b.rs\0config/.env.production\0"));
        assert!(names_a_secret(b".ENV\0"));
        assert!(names_a_secret(b"x/.git/config\0"));
        assert!(!names_a_secret(
            b"a/b.rs\0.github/workflows/ci.yml\0.claude/x\0"
        ));
        assert!(!names_a_secret(b""));
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

    fn strs(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|line| (*line).to_owned()).collect()
    }

    #[test]
    fn a_diff_of_lines_is_one_hunk_of_paired_changes() {
        let diff = unified_diff(
            "a.txt",
            &strs(&["one", "two", "three"]),
            &strs(&["one", "2", "three", "four"]),
        );
        assert_eq!(
            diff,
            "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n"
        );
        let rows = diff_rows(&diff);
        let kinds: Vec<_> = rows.iter().map(|row| row.kind).collect();
        assert_eq!(
            kinds,
            [
                DiffRowKind::Hunk,
                DiffRowKind::Context,
                DiffRowKind::Change,
                DiffRowKind::Context,
                DiffRowKind::Change
            ]
        );
        assert_eq!(rows[0].left.as_deref(), Some("@@ -1,3 +1,4 @@"));
        let pair = &rows[2];
        assert_eq!((pair.left_no, pair.right_no), (Some(2), Some(2)));
        assert_eq!(
            (pair.left.as_deref(), pair.right.as_deref()),
            (Some("two"), Some("2"))
        );
        // Nothing is shared by the two lines, so nothing is marked inside them.
        assert_eq!((pair.left_mark, pair.right_mark), (None, None));
        let added = &rows[4];
        assert_eq!((added.left_no, added.left.as_deref()), (None, None));
        assert_eq!(
            (added.right_no, added.right.as_deref()),
            (Some(4), Some("four"))
        );
        // Both sides empty: a hunk of no line at all.
        assert_eq!(
            unified_diff("n", &[], &[]),
            "--- a/n\n+++ b/n\n@@ -0,0 +0,0 @@\n"
        );
    }

    #[test]
    fn a_changed_pair_marks_the_characters_between_what_it_shares() {
        assert_eq!(
            char_marks("LIMIT = 5;", "LIMIT = 10;"),
            (Some((8, 9)), Some((8, 10)))
        );
        assert_eq!(char_marks("あいう", "あえう"), (Some((1, 2)), Some((1, 2))));
        // A line that only grows has a mark on the longer side alone.
        assert_eq!(char_marks("ab", "abc"), (None, Some((2, 3))));
        assert_eq!(char_marks("x", "y"), (None, None));
    }

    #[test]
    fn the_rows_of_a_git_diff_pair_a_run_of_deletions_with_its_insertions() {
        let diff = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -3,4 +3,3 @@ fn x()\n a\n-b\n-c\n-d\n+B\n+C\n z\n\\ No newline at end of file\ndiff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-old\n+new\n";
        let rows = diff_rows(diff);
        let shape: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.kind,
                    r.left_no,
                    r.left.as_deref(),
                    r.right_no,
                    r.right.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            [
                (
                    DiffRowKind::Hunk,
                    None,
                    Some("@@ -3,4 +3,3 @@ fn x()"),
                    None,
                    None
                ),
                (DiffRowKind::Context, Some(3), Some("a"), Some(3), Some("a")),
                (DiffRowKind::Change, Some(4), Some("b"), Some(4), Some("B")),
                (DiffRowKind::Change, Some(5), Some("c"), Some(5), Some("C")),
                (DiffRowKind::Change, Some(6), Some("d"), None, None),
                (DiffRowKind::Context, Some(7), Some("z"), Some(6), Some("z")),
                (DiffRowKind::Hunk, None, Some("@@ -1 +1 @@"), None, None),
                (
                    DiffRowKind::Change,
                    Some(1),
                    Some("old"),
                    Some(1),
                    Some("new")
                ),
            ]
        );
    }

    #[test]
    fn a_diff_names_its_sources_and_is_read_into_rows() {
        let repo = repo("diff-evidence");
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([
            {"type": "diff", "summary": "s", "name": "n", "before": ["a"], "after": ["b"]},
            {"type": "diff", "summary": "s", "name": "n", "before": ["a"], "after": ["b"], "before_source": "x", "after_source": "y", "extra": 1},
            {"type": "diff", "summary": "s", "name": "n", "before": ["a\nb"], "after": [], "before_source": "x", "after_source": "y"}
        ]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.questions[0].evidence[0].before_source",
                "$.questions[0].evidence[0].after_source",
                "$.questions[0].evidence[1].extra",
                "$.questions[0].evidence[2].before[0]",
            ]
        );
        value["questions"][0]["evidence"] = json!([
            {"type": "diff", "summary": "s", "name": "n", "before": (0..401).map(|n| n.to_string()).collect::<Vec<_>>(), "after": [], "before_source": "x", "after_source": "y"},
            {"type": "diff", "summary": "s", "name": "n", "before": ["a"], "after": ["b"], "before_source": "x（先頭）", "after_source": "y", "note": "n"}
        ]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            ["$.questions[0].evidence[0].before"]
        );
        value["questions"][0]["evidence"] = json!([
            {"type": "diff", "summary": "s", "name": "n", "before": ["a"], "after": ["b"], "before_source": "x（先頭）", "after_source": "y"}
        ]);
        let page = build(&value, &repo.allowed()).unwrap();
        let Evidence::Diff {
            before_source,
            after_source,
            rows,
            ..
        } = &page.questions[0].evidence[0]
        else {
            panic!("a diff");
        };
        assert_eq!(
            (before_source.as_str(), after_source.as_str()),
            ("x（先頭）", "y")
        );
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn a_current_item_holds_excerpts_with_a_note_that_says_where_the_after_state_is_decided() {
        let repo = repo("current");
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = json!([
            {"type": "current", "excerpts": [{"root": "repo", "path": "src/main.rs", "start": 1}]},
            {"type": "current", "note": "n", "excerpts": []},
            {"type": "current", "note": "n", "excerpts": [{"type": "diff", "root": "repo", "path": "src/main.rs", "start": 1}]},
            {"type": "current", "note": "n", "excerpts": [{"root": "repo", "path": "src/none.rs", "start": 1}], "extra": 1}
        ]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.questions[0].evidence[0].note",
                "$.questions[0].evidence[1].excerpts",
                "$.questions[0].evidence[2].excerpts[0].type",
                "$.questions[0].evidence[3].extra",
                "$.questions[0].evidence[3].excerpts[0].path",
            ]
        );
        value["questions"][0]["evidence"] = json!([
            {"type": "current", "note": "変更後は基本設計で決めます", "excerpts": [
                {"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 1, "highlight": [1]},
                {"root": "repo", "path": "src/main.rs", "start": 2, "end": 3}
            ]}
        ]);
        let page = build(&value, &repo.allowed()).unwrap();
        let Evidence::Current { note, excerpts } = &page.questions[0].evidence[0] else {
            panic!("a current");
        };
        assert_eq!(note, "変更後は基本設計で決めます");
        assert_eq!(excerpts.len(), 2);
        assert!(
            matches!(&excerpts[1], Evidence::Excerpt { start: 2, end: 3, lines, .. } if lines.len() == 2)
        );
        // For its cards alone the excerpts are there with no content.
        let page = build_input(&value, &repo.allowed()).unwrap();
        let Evidence::Current { excerpts, .. } = &page.questions[0].evidence[0] else {
            panic!("a current");
        };
        assert!(matches!(&excerpts[0], Evidence::Excerpt { lines, .. } if lines.is_empty()));
    }

    #[test]
    fn a_page_with_too_much_evidence_is_refused() {
        let repo = repo("many");
        let mut value = open_questions(&repo);
        value["questions"][0]["evidence"] = Value::Array(
            (0..=EVIDENCE_COUNT)
                .map(|_| json!({"type": "diff", "summary": "s", "name": "n", "before": [], "after": [], "before_source": "b", "after_source": "a"}))
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
                .map(|_| json!({"type": "diff", "summary": "s", "name": "n", "before": [line], "after": [], "before_source": "b", "after_source": "a"}))
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
            answered_at: None,
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
            answered_at: None,
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
    fn an_answered_page_is_no_mark_and_a_newer_page_of_the_child_waits_again() {
        let children = [child("one", "/w", 100)];
        let mut answered = record_of("one", 250);
        answered.answered_at = Some(300);
        assert_eq!(pending_pages(&children, &[answered]), [None]);
        let marks = pending_pages(&children, &[record_of("one", 400)]);
        assert_eq!(marks[0].as_ref().unwrap().at_ms, 400);
    }

    #[test]
    fn answering_marks_the_page_of_that_time_once_and_a_replaced_or_missing_page_is_refused() {
        let repo = repo("answer");
        let config = temp_dir("answer-config");
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 100)]);
        put_page(&config, "api-work", record_of("one", 250)).unwrap();
        put_page(&config, "api-work", record_of("two", 260)).unwrap();
        // A page that a newer one replaced, and a child with no page, are refused and nothing is written.
        assert!(mark_answered(&config, "api-work", "one", 249, 500).is_err());
        assert!(mark_answered(&config, "api-work", "three", 250, 500).is_err());
        assert!(read_pages(&config, "api-work")
            .iter()
            .all(|p| p.answered_at.is_none()));
        mark_answered(&config, "api-work", "one", 250, 500).unwrap();
        let pages = read_pages(&config, "api-work");
        let answered = |name: &str| pages.iter().find(|p| p.child == name).unwrap().answered_at;
        assert_eq!(answered("one"), Some(500));
        assert_eq!(answered("two"), None);
        // The second answer of one page is refused, and the first time stays.
        assert!(mark_answered(&config, "api-work", "one", 250, 900).is_err());
        let pages = read_pages(&config, "api-work");
        let first = pages.iter().find(|p| p.child == "one").unwrap();
        assert_eq!(first.answered_at, Some(500));
        // The page that the child writes next waits again.
        put_page(&config, "api-work", record_of("one", 700)).unwrap();
        let pages = read_pages(&config, "api-work");
        assert!(pages
            .iter()
            .find(|p| p.child == "one")
            .unwrap()
            .answered_at
            .is_none());
        // An answered page cannot be read as the page that waits.
        mark_answered(&config, "api-work", "one", 700, 800).unwrap();
        assert!(waiting_page(&config, "api-work", "one").is_err());
    }

    #[test]
    fn a_record_of_a_removed_kind_is_skipped_and_the_other_pages_still_read_and_write() {
        let repo = repo("removed-kind");
        let config = temp_dir("removed-kind-config");
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 100)]);
        let old = json!({
            "child": "old", "path": "/p", "title": "古い", "page_kind": "code-review",
            "subject": "code", "at": 200
        });
        let valid = serde_json::to_value(record_of("one", 250)).unwrap();
        write(
            &formation::dir(&config, "api-work"),
            PAGES_FILE,
            &json!({"pages": [old, valid]}).to_string(),
        );
        let pages = read_pages(&config, "api-work");
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].child, "one");
        mark_answered(&config, "api-work", "one", 250, 500).unwrap();
        put_page(&config, "api-work", record_of("two", 260)).unwrap();
        let pages = read_pages(&config, "api-work");
        assert_eq!(pages.len(), 2);
        assert!(pages.iter().all(|p| p.child != "old"));
        // A file that is not a record list is still not written over.
        write(&formation::dir(&config, "api-work"), PAGES_FILE, "[1]");
        assert!(put_page(&config, "api-work", record_of("three", 300)).is_err());
    }

    #[test]
    fn an_answer_does_not_bring_back_the_folder_of_a_deleted_formation() {
        let config = temp_dir("answer-deleted");
        assert!(mark_answered(&config, "gone", "one", 1, 2).is_err());
        assert!(!formation::dir(&config, "gone").exists());
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

    // -- images --

    /// A page of one change with the blocks `blocks`.
    fn page_with_blocks(repo: &Repo, blocks: Value) -> Value {
        let mut value = approval(repo);
        value["changes"] = json!([{"heading": "h", "blocks": blocks}]);
        value
    }

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xff, 0xff, 0x3f, 0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn write_bytes(dir: &Path, relative: &str, bytes: &[u8]) {
        let path = dir.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn an_image_block_is_accepted_with_its_file_left_out_of_the_page() {
        let repo = repo("image-accept");
        write_bytes(&repo.dir, ".feature-dev/current/ui/a.PNG", PNG_1X1);
        write_bytes(
            &repo.dir,
            "shots/b.svg",
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        );
        let value = page_with_blocks(
            &repo,
            json!([
                {"type": "image", "path": "ui/a.PNG", "caption": "いまの画面"},
                {"type": "image", "root": "repo", "path": "shots/b.svg", "caption": "図"},
                {"type": "folded", "summary": "s", "blocks": [
                    {"type": "image", "root": "repo", "path": "shots/b.svg", "caption": "中の図"}
                ]}
            ]),
        );
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(
            page.changes[0].blocks[0],
            Block::Image(ImageRef {
                root: "deliverables".into(),
                path: "ui/a.PNG".into(),
                caption: "いまの画面".into(),
            })
        );
        let json = serde_json::to_value(&page.changes[0].blocks[1]).unwrap();
        assert_eq!(
            json,
            json!({"type": "image", "root": "repo", "path": "shots/b.svg", "caption": "図"})
        );
        let Block::Folded { blocks, .. } = &page.changes[0].blocks[2] else {
            panic!("a folded block");
        };
        assert!(matches!(blocks[0], Block::Image(_)));
        // The page that is read for its cards alone checks the shape and touches no file.
        let mut gone = value.clone();
        gone["changes"][0]["blocks"][0]["path"] = json!("ui/none.png");
        assert!(build_input(&gone, &repo.allowed()).is_ok());
        assert_eq!(
            paths(&violations(&gone, &repo)),
            ["$.changes[0].blocks[0].path"]
        );
    }

    #[test]
    fn an_image_that_is_no_image_or_outside_the_boundary_or_too_large_is_refused() {
        let repo = repo("image-refuse");
        let outside = temp_dir("image-outside");
        write_bytes(&outside, "secret.png", PNG_1X1);
        write_bytes(&repo.dir, ".feature-dev/current/ui/a.png", PNG_1X1);
        write_bytes(&repo.dir, ".feature-dev/current/ui/notes.txt", b"text");
        write_bytes(&repo.dir, ".git/hooks/x.png", PNG_1X1);
        write_bytes(&repo.dir, ".env.png", PNG_1X1);
        write_bytes(
            &repo.dir,
            "big.png",
            &vec![7; formation_image::IMAGE_LIMIT + 1],
        );
        write_bytes(
            &repo.dir,
            "big.svg",
            &vec![b' '; formation_image::IMAGE_LIMIT + 1],
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.png"), repo.dir.join("link.png")).unwrap();
        let blocks = json!([
            {"type": "image", "path": "ui/a.png", "caption": "ok"},
            {"type": "image", "path": "ui/notes.txt", "caption": "c"},
            {"type": "image", "path": "../a.png", "caption": "c"},
            {"type": "image", "root": "repo", "path": ".git/hooks/x.png", "caption": "c"},
            {"type": "image", "root": "repo", "path": ".env.png", "caption": "c"},
            {"type": "image", "root": "repo", "path": "link.png", "caption": "c"},
            {"type": "image", "root": "repo", "path": "big.png", "caption": "c"},
            {"type": "image", "root": "repo", "path": "big.svg", "caption": "c"},
            {"type": "image", "root": "nowhere", "path": "a.png", "caption": "c"},
            {"type": "image", "path": "ui/a.png"},
            {"type": "image", "path": "ui/a.png", "caption": " "},
            {"type": "image", "path": "ui", "caption": "c"},
            {"type": "image", "path": "ui/a.png", "caption": "c", "alt": "x"}
        ]);
        let found = violations(&page_with_blocks(&repo, blocks), &repo);
        let expected = [
            "$.changes[0].blocks[1].path",
            "$.changes[0].blocks[2].path",
            "$.changes[0].blocks[3].path",
            "$.changes[0].blocks[4].path",
            "$.changes[0].blocks[5].path",
            "$.changes[0].blocks[6].path",
            "$.changes[0].blocks[7].path",
            "$.changes[0].blocks[8].root",
            "$.changes[0].blocks[9].caption",
            "$.changes[0].blocks[10].caption",
            "$.changes[0].blocks[11].path",
            "$.changes[0].blocks[12].alt",
        ];
        #[cfg(unix)]
        assert_eq!(paths(&found), expected);
        #[cfg(not(unix))]
        assert!(!found.is_empty());
        assert!(found
            .iter()
            .any(|v| v.path.ends_with("blocks[6].path") && v.message.contains("大きすぎます")));
    }

    #[test]
    fn the_image_of_a_waiting_page_is_read_inside_its_roots_only() {
        let repo = repo("image-read");
        let config = temp_dir("image-read-config");
        formation_folder(&config, "api-work", &[child("one", &repo.root(), 100)]);
        write_bytes(&repo.dir, ".feature-dev/current/ui/a.png", PNG_1X1);
        write_bytes(&repo.dir, ".feature-dev/current/ui/notes.txt", b"text");
        let value = page_with_blocks(
            &repo,
            json!([{"type": "image", "path": "ui/a.png", "caption": "c"}]),
        );
        write(
            &repo.dir,
            ".feature-dev/current/records/page-01.json",
            &value.to_string(),
        );
        let given = repo
            .dir
            .join(".feature-dev/current/records/page-01.json")
            .to_string_lossy()
            .into_owned();
        let read = |root: &str, path: &str| {
            image_with(&config, "api-work", "one", root, path, &repo.allowed())
        };
        assert!(
            read("deliverables", "ui/a.png").is_err(),
            "nothing waits yet"
        );
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
        let image = read("deliverables", "ui/a.png").unwrap();
        assert_eq!((image.mime, image.bytes.as_slice()), ("image/png", PNG_1X1));
        assert!(read("repo", "src/main.rs").is_err(), "not an image");
        assert!(read("deliverables", "ui/notes.txt").is_err());
        assert!(read("deliverables", "../../src/main.rs").is_err());
        assert!(read("deliverables", "ui/none.png").is_err());
        assert!(read("elsewhere", "ui/a.png")
            .unwrap_err()
            .contains("roots にない"));
        assert!(image_with(
            &config,
            "api-work",
            "stranger",
            "deliverables",
            "ui/a.png",
            &repo.allowed()
        )
        .is_err());
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
        let args = git_diff_args("a.rs", "base", Some("head"), false);
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

    // -- the cards of the earlier feature-dev: scene, occurrence, conditions, the details of an option and the content of a fact --

    /// `open_questions` with the first question changed by `change`.
    fn with_question(repo: &Repo, change: impl FnOnce(&mut Value)) -> Value {
        let mut value = open_questions(repo);
        change(&mut value["questions"][0]);
        value
    }

    #[test]
    fn a_card_that_asks_needs_a_scene_and_any_other_card_may_have_one() {
        let repo = repo("scene");
        let value = with_question(&repo, |q| {
            q.as_object_mut().unwrap().remove("scene");
        });
        assert_eq!(paths(&violations(&value, &repo)), ["$.questions[0].scene"]);
        let mut value = approval(&repo);
        value["residual_must_fix"] = json!([
            {"kind": "must-fix", "number": "MF-1", "title": "t", "summary": "s", "scene": "場面", "recommendation": "fix", "recommendation_reason": "r"}
        ]);
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(page.residual_must_fix[0].scene.as_deref(), Some("場面"));
    }

    #[test]
    fn a_scene_image_is_read_like_an_image_block_and_only_on_a_card_that_asks() {
        let repo = repo("scene-image");
        write_bytes(&repo.dir, ".feature-dev/current/ui/a.png", PNG_1X1);
        let image = json!({"path": "ui/a.png", "caption": "いまの画面"});
        let value = with_question(&repo, |q| q["scene_image"] = image.clone());
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(
            page.questions[0].scene_image,
            Some(ImageRef {
                root: "deliverables".into(),
                path: "ui/a.png".into(),
                caption: "いまの画面".into()
            })
        );
        let missing = with_question(&repo, |q| {
            q["scene_image"] = json!({"path": "ui/none.png", "caption": "c"})
        });
        assert_eq!(
            paths(&violations(&missing, &repo)),
            ["$.questions[0].scene_image.path"]
        );
        assert!(build_input(&missing, &repo.allowed()).is_ok());
        let mut other = approval(&repo);
        other["residual_must_fix"] = json!([
            {"kind": "must-fix", "number": "MF-1", "title": "t", "summary": "s", "scene_image": image, "recommendation": "fix", "recommendation_reason": "r"}
        ]);
        assert_eq!(
            paths(&violations(&other, &repo)),
            ["$.residual_must_fix[0].scene_image"]
        );
    }

    #[test]
    fn an_occurrence_is_required_on_an_nr_of_a_design_and_nowhere_else() {
        let repo = repo("occurrence");
        let mut value = approval(&repo);
        let nr = |extra: Value| {
            let mut card = json!({"kind": "nr", "number": "NR-1", "title": "t", "summary": "s", "scene": "場面", "options": [{"key": "A", "label": "a"}], "recommendation": "A", "recommendation_reason": "r"});
            card.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            card
        };
        value["needs_user_decision"] = json!([nr(json!({}))]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            ["$.needs_user_decision[0].occurrence"]
        );
        value["needs_user_decision"] = json!([nr(json!({"occurrence": occurrence()}))]);
        let page = build(&value, &repo.allowed()).unwrap();
        let got = page.needs_user_decision[0].occurrence.as_ref().unwrap();
        assert_eq!(got.likelihood, Likelihood::Rare);
        assert_eq!(got.conditions, ["条件"]);
        // On a requirement page an nr takes none.
        value["subject"] = json!("requirement");
        value["quality_loop"]["fix_cycles"] = Value::Null;
        assert_eq!(
            paths(&violations(&value, &repo)),
            ["$.needs_user_decision[0].occurrence"]
        );
        // A question takes none either.
        let bad = with_question(&repo, |q| q["occurrence"] = occurrence());
        assert_eq!(
            paths(&violations(&bad, &repo)),
            ["$.questions[0].occurrence"]
        );
    }

    #[test]
    fn every_part_of_an_occurrence_is_checked() {
        let repo = repo("occurrence-parts");
        let mut value = approval(&repo);
        value["needs_user_decision"] = json!([
            {"kind": "nr", "number": "NR-1", "title": "t", "summary": "s", "scene": "場面", "options": [{"key": "A", "label": "a"}], "recommendation": "A", "recommendation_reason": "r",
             "occurrence": {"conditions": [], "likelihood": "often", "basis": "たぶん", "impact": "i"}}
        ]);
        let found = violations(&value, &repo);
        let mut at = paths(&found);
        at.sort_unstable();
        assert_eq!(
            at,
            [
                "$.needs_user_decision[0].occurrence.basis",
                "$.needs_user_decision[0].occurrence.conditions",
                "$.needs_user_decision[0].occurrence.detectability",
                "$.needs_user_decision[0].occurrence.likelihood",
            ]
        );
    }

    #[test]
    fn the_conditions_of_a_card_and_the_unmet_ones_of_its_options_go_together() {
        let repo = repo("conditions");
        let value = with_question(&repo, |q| {
            q["conditions"] =
                json!([{"id": "KO-01", "text": "止められる"}, {"id": "KO-02", "text": "戻せる"}]);
            q["options"][1]["unmet"] = json!([{"id": "KO-02", "reason": "戻せない"}]);
        });
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(page.questions[0].conditions.len(), 2);
        assert_eq!(page.questions[0].options[1].unmet[0].id, "KO-02");
        // A condition the card does not list, and an unmet with no conditions at all.
        let unknown = with_question(&repo, |q| {
            q["conditions"] = json!([{"id": "KO-01", "text": "止められる"}]);
            q["options"][1]["unmet"] = json!([{"id": "KO-09", "reason": "r"}]);
        });
        assert_eq!(
            paths(&violations(&unknown, &repo)),
            ["$.questions[0].options[1].unmet[0].id"]
        );
        let none = with_question(&repo, |q| {
            q["options"][1]["unmet"] = json!([{"id": "KO-01", "reason": "r"}]);
        });
        assert_eq!(
            paths(&violations(&none, &repo)),
            ["$.questions[0].conditions"]
        );
        let twice = with_question(&repo, |q| {
            q["conditions"] = json!([{"id": "KO-01", "text": "a"}, {"id": "KO-01", "text": "b"}]);
        });
        assert_eq!(
            paths(&violations(&twice, &repo)),
            ["$.questions[0].conditions[1].id"]
        );
    }

    #[test]
    fn an_option_takes_an_image_a_sample_and_a_diagram() {
        let repo = repo("option-parts");
        write_bytes(&repo.dir, ".feature-dev/current/ui/a.png", PNG_1X1);
        let mut value = approval(&repo);
        value["needs_user_decision"] = json!([{
            "kind": "nr", "number": "NR-1", "title": "t", "summary": "s",
            "scene": "場面", "occurrence": occurrence(),
            "options": [{
                "key": "A", "label": "直す",
                "image": {"path": "ui/a.png", "caption": "直したあと"},
                "sample": {"text": "見本", "font_size": 14, "font_weight": 700, "color": "#2f5bd3"},
                "diagram": {"mermaid": "flowchart LR\n  a --> b"}
            }],
            "recommendation": "A", "recommendation_reason": "r",
            "choice_details": {"other": "別の案"}
        }]);
        let page = build(&value, &repo.allowed()).unwrap();
        let option = &page.needs_user_decision[0].options[0];
        assert_eq!(option.image.as_ref().unwrap().path, "ui/a.png");
        assert_eq!(option.sample.as_ref().unwrap().font_weight, 700);
        assert_eq!(option.diagram.as_deref(), Some("flowchart LR\n  a --> b"));
        assert_eq!(
            page.needs_user_decision[0].choice_details["other"],
            "別の案"
        );
        // A diagram of another type, a sample out of its ranges, and a key that is no fixed choice.
        let bad = with_question(&repo, |q| {
            q["options"][0]["diagram"] = json!({"mermaid": "pie\n  a: 1"});
            q["options"][0]["sample"] =
                json!({"text": "t", "font_size": 0, "font_weight": 650, "color": "red"});
            q["choice_details"] = json!({"defer": "x", "other": "y"});
        });
        let found = violations(&bad, &repo);
        let mut at = paths(&found);
        at.sort_unstable();
        assert_eq!(
            at,
            [
                "$.questions[0].choice_details.defer",
                "$.questions[0].options[0].diagram.mermaid",
                "$.questions[0].options[0].sample.color",
                "$.questions[0].options[0].sample.font_size",
                "$.questions[0].options[0].sample.font_weight",
            ]
        );
    }

    #[test]
    fn a_fact_with_a_ref_or_a_path_carries_what_it_cites() {
        let repo = repo("fact-content");
        write(&repo.dir, ".feature-dev/current/notes.txt", "plain\n");
        write(
            &repo.dir,
            ".feature-dev/current/doc.md",
            "# 見出し\n\n本文\n",
        );
        write_bytes(&repo.dir, ".feature-dev/current/shot.png", PNG_1X1);
        let value = with_question(&repo, |q| {
            q["facts"] = json!([
                {"label": "ノード", "value": "第二の設計", "ref": "design.json#/designs/DESIGN-02"},
                {"label": "文書", "value": "メモ", "path": "doc.md"},
                {"label": "文字", "value": "テキスト", "path": "notes.txt"},
                {"label": "画像", "value": "いまの画面", "path": "shot.png"},
                {"label": "ソース", "value": "main", "root": "repo", "path": "src/main.rs"},
                {"label": "なし", "value": "何も引かない"}
            ]);
        });
        let page = build(&value, &repo.allowed()).unwrap();
        let facts = &page.questions[0].facts;
        let Some(FactContent::Node { text, .. }) = &facts[0].content else {
            panic!("a node");
        };
        assert!(text.contains("second"));
        assert!(
            matches!(&facts[1].content, Some(FactContent::Markdown { text, .. }) if text.contains("# 見出し"))
        );
        assert!(
            matches!(&facts[2].content, Some(FactContent::Text { text, .. }) if text == "plain\n")
        );
        assert_eq!(
            facts[3].content,
            Some(FactContent::Image(ImageRef {
                root: "deliverables".into(),
                path: "shot.png".into(),
                caption: "いまの画面".into()
            }))
        );
        assert!(
            matches!(&facts[4].content, Some(FactContent::Text { root, .. }) if root == "repo")
        );
        assert_eq!(facts[5].content, None);
        // A page read for its cards alone reads none of it.
        let input = build_input(&value, &repo.allowed()).unwrap();
        assert!(input.questions[0].facts.iter().all(|f| f.content.is_none()));
    }

    #[test]
    fn a_fact_that_cites_wrongly_is_a_violation() {
        let repo = repo("fact-bad");
        let value = with_question(&repo, |q| {
            q["facts"] = json!([
                {"label": "a", "value": "v", "ref": "design.json#/designs/DESIGN-01", "path": "doc.md"},
                {"label": "b", "value": "v", "root": "repo"},
                {"label": "c", "value": "v", "path": "missing.md"},
                {"label": "d", "value": "v", "ref": "design.json#/designs/NONE"},
                {"label": "e", "value": "v", "path": "../x.md"},
                {"label": "f", "value": "v", "ref": "no-pointer"}
            ]);
        });
        let found = violations(&value, &repo);
        assert_eq!(
            paths(&found),
            [
                "$.questions[0].facts[0]",
                "$.questions[0].facts[1].root",
                "$.questions[0].facts[2].path",
                "$.questions[0].facts[3].ref",
                "$.questions[0].facts[4].path",
                "$.questions[0].facts[5].ref",
            ]
        );
        // Without its evidence read, only the shapes are checked.
        assert_eq!(
            paths(&build_input(&value, &repo.allowed()).unwrap_err()),
            [
                "$.questions[0].facts[0]",
                "$.questions[0].facts[1].root",
                "$.questions[0].facts[4].path",
                "$.questions[0].facts[5].ref",
            ]
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
        ]
        .into_iter()
        .map(|kind| {
            let serialized = serde_json::to_value(kind).unwrap();
            assert_eq!(serialized, kind.name());
            kind.name()
        })
        .collect();
        assert_eq!(set.len(), 5);
    }

    // -- the items of the page that the earlier decision pages had (#1156) --

    #[test]
    fn terms_hold_and_clarified_numbers_are_checked_and_carried() {
        let repo = repo("page-terms");
        let mut value = open_questions(&repo);
        value["terms"] = json!([{"word": "与信", "description": "支払いを先に押さえること"}]);
        value["hold"] = json!(true);
        value["clarified_numbers"] = json!(["論点1", "論点9"]);
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(
            page.terms,
            [Term {
                word: "与信".into(),
                description: "支払いを先に押さえること".into()
            }]
        );
        assert!(page.hold);
        assert_eq!(page.clarified_numbers, ["論点1", "論点9"]);
        // `false` is the same as none, on any page.
        let mut approved = approval(&repo);
        approved["hold"] = json!(false);
        assert!(!build(&approved, &repo.allowed()).unwrap().hold);
        // A term needs both texts, and no other key.
        value["terms"] = json!([{"word": "与信"}, {"word": "a", "description": "b", "x": 1}, "c"]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            ["$.terms[0].description", "$.terms[1].x", "$.terms[2]"]
        );
        value["terms"] = json!([]);
        value["clarified_numbers"] = json!("論点1");
        assert_eq!(paths(&violations(&value, &repo)), ["$.clarified_numbers"]);
    }

    #[test]
    fn hold_is_for_the_open_questions_of_a_requirement_only() {
        let repo = repo("page-hold");
        for (kind, subject) in [("open-questions", "design"), ("approval", "requirement")] {
            let mut value = if kind == "approval" {
                approval(&repo)
            } else {
                open_questions(&repo)
            };
            value["subject"] = json!(subject);
            if kind == "approval" {
                value["quality_loop"]["fix_cycles"] = Value::Null;
            }
            value["hold"] = json!(true);
            assert_eq!(
                paths(&violations(&value, &repo)),
                ["$.hold"],
                "{kind} {subject}"
            );
        }
        let mut value = open_questions(&repo);
        value["hold"] = json!("yes");
        assert_eq!(paths(&violations(&value, &repo)), ["$.hold"]);
    }

    #[test]
    fn the_previous_reply_is_read_back_into_the_answers_the_page_starts_from() {
        let repo = repo("page-restore");
        let mut value = open_questions(&repo);
        value["previous_reply"] =
            json!("論点1 どちらにしますか\nB. 案 B（仮置き: ビジネス側に確認してから確定）");
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(
            page.restored,
            [PageAnswer {
                card: "論点1".into(),
                choice: Some("B".into()),
                note: String::new(),
                provisional: true
            }]
        );
        // The cards alone are read for the reply, and it holds the answers too.
        let page = build_input(&value, &repo.allowed()).unwrap();
        assert_eq!(page.restored.len(), 1);
        value["clarified_numbers"] = json!(["論点1"]);
        assert!(build(&value, &repo.allowed()).unwrap().restored.is_empty());
    }

    #[test]
    fn the_numbers_of_the_cards_that_the_children_give_are_accepted() {
        let repo = repo("page-numbers");
        let mut value = approval(&repo);
        let card = |number: &str| json!({"kind": "must-fix", "number": number, "title": "t", "summary": "s", "recommendation": "fix", "recommendation_reason": "r"});
        value["residual_must_fix"] = json!([card("MF-1"), card("MF-1-r2"), card("FV-1")]);
        value["noticed"] = json!([
            {"title": "RC-1", "text": "直さなかった"},
            {"title": "OG-1", "text": "範囲外"},
            {"title": "SV-2-o1", "text": "気づいた"},
            {"title": "FV-bound-1", "text": "上限を下げた"},
            {"title": "FV-scope-1", "text": "範囲外に触った"},
            {"title": "FV-unrun-1", "text": "検査しなかった"}
        ]);
        let page = build(&value, &repo.allowed()).unwrap();
        let numbers: Vec<_> = page
            .residual_must_fix
            .iter()
            .map(|c| c.number.as_str())
            .collect();
        assert_eq!(numbers, ["MF-1", "MF-1-r2", "FV-1"]);
        assert_eq!(page.noticed.len(), 6);
        assert_eq!(page.noticed[3].title, "FV-bound-1");
    }

    #[test]
    fn the_noticed_matters_and_the_withdrawn_questions_are_checked() {
        let repo = repo("page-sections");
        let mut value = approval(&repo);
        value["noticed"] = json!([{
            "title": "気づいたこと",
            "text": "本文",
            "evidence": [{"type": "excerpt", "root": "repo", "path": "src/main.rs", "start": 1}]
        }]);
        value["withdrawn_needs_user_decision"] =
            json!([{"number": "NR-3", "title": "目標値", "withdrawal_reason": "回答で決まった"}]);
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(page.noticed[0].title, "気づいたこと");
        assert_eq!(page.noticed[0].evidence.len(), 1);
        assert_eq!(
            page.withdrawn_needs_user_decision[0].withdrawal_reason,
            "回答で決まった"
        );
        value["noticed"] = json!([{"title": "t"}, {"title": "u", "text": "v", "extra": 1}, 3]);
        value["withdrawn_needs_user_decision"] = json!([{"number": "NR-3", "title": "目標値"}]);
        assert_eq!(
            paths(&violations(&value, &repo)),
            [
                "$.withdrawn_needs_user_decision[0].withdrawal_reason",
                "$.noticed[0].text",
                "$.noticed[1].extra",
                "$.noticed[2]"
            ]
        );
        // `noticed` is for an approval page: an open-questions page has none.
        let mut questions = open_questions(&repo);
        questions["noticed"] = json!([]);
        assert_eq!(paths(&violations(&questions, &repo)), ["$.noticed"]);
    }

    #[test]
    fn the_fix_cycles_are_for_a_design_only_and_a_design_needs_them() {
        let repo = repo("page-fix-cycles");
        let page = build(&approval(&repo), &repo.allowed()).unwrap();
        assert_eq!(
            page.quality_loop,
            Some(QualityLoop {
                rounds: 2,
                fix_cycles: Some(1),
                must_fix_resolved: 3
            })
        );
        let mut value = approval(&repo);
        value["quality_loop"]["fix_cycles"] = Value::Null;
        assert_eq!(
            paths(&violations(&value, &repo)),
            ["$.quality_loop.fix_cycles"]
        );
        value["subject"] = json!("requirement");
        let page = build(&value, &repo.allowed()).unwrap();
        assert_eq!(page.quality_loop.unwrap().fix_cycles, None);
        value["quality_loop"]["fix_cycles"] = json!(1);
        assert_eq!(
            paths(&violations(&value, &repo)),
            ["$.quality_loop.fix_cycles"]
        );
    }

    fn design_page(repo: &Repo) -> Value {
        write(
            &repo.dir,
            ".feature-dev/current/design.json",
            r#"{"designs": [{"id": "DESIGN-01", "title": "first", "release": 2}, {"id": "DESIGN-02", "title": "second"}], "shared": [{"id": "data-model"}], "implementation_order": ["example-api", "example-web"]}"#,
        );
        let mut value = approval(repo);
        value["approval_scope"] = json!([
            {"heading": "設計項目", "items": [
                {"ref": "design.json#/designs/DESIGN-01", "description": "DESIGN-01 最初。概要です"},
                {"ref": "design.json#/designs/DESIGN-02", "description": "DESIGN-02 二つめ"}
            ]},
            {"heading": "共有の設計資料", "items": [
                {"ref": "design.json#/shared/data-model", "description": "データモデル"}
            ]}
        ]);
        value
    }

    #[test]
    fn the_design_items_of_a_design_approval_are_rows_and_their_group_keeps_its_heading() {
        let repo = repo("page-design-items");
        let page = build(&design_page(&repo), &repo.allowed()).unwrap();
        assert_eq!(page.design_items.len(), 2);
        let first = &page.design_items[0];
        assert_eq!(
            (
                first.id.as_str(),
                first.title.as_str(),
                first.reference.as_str(),
                first.release
            ),
            (
                "DESIGN-01",
                "最初。概要です",
                "design.json#/designs/DESIGN-01",
                Some(2)
            )
        );
        assert!(first.text.as_deref().unwrap().contains("\"first\""));
        assert_eq!(page.design_items[1].release, None);
        assert_eq!(page.approval_scope.len(), 2);
        assert!(page.approval_scope[0].design);
        assert!(page.approval_scope[0].items.is_empty());
        assert_eq!(page.approval_scope[0].heading, "設計項目");
        assert!(!page.approval_scope[1].design);
        assert_eq!(page.approval_scope[1].items.len(), 1);
        assert_eq!(page.implementation_order, ["example-api", "example-web"]);
    }

    #[test]
    fn a_group_with_any_other_item_and_every_group_of_a_requirement_stay_in_the_scope() {
        let repo = repo("page-design-mixed");
        let mut value = design_page(&repo);
        value["approval_scope"][0]["items"][1] =
            json!({"path": "notes.md", "description": "notes"});
        let page = build(&value, &repo.allowed()).unwrap();
        assert!(page.design_items.is_empty());
        assert_eq!(page.approval_scope[0].items.len(), 2);
        assert!(!page.approval_scope[0].design);
        // On a requirement the order is not read either.
        let mut requirement = design_page(&repo);
        requirement["subject"] = json!("requirement");
        requirement["quality_loop"]["fix_cycles"] = Value::Null;
        let page = build(&requirement, &repo.allowed()).unwrap();
        assert!(page.design_items.is_empty());
        assert!(page.implementation_order.is_empty());
        assert_eq!(page.approval_scope[0].items.len(), 2);
    }

    #[test]
    fn the_implementation_order_is_empty_when_the_file_says_none_and_is_not_read_for_the_cards_alone(
    ) {
        let repo = repo("page-design-order");
        let page = build(&approval(&repo), &repo.allowed()).unwrap();
        assert!(page.implementation_order.is_empty());
        let page = build_input(&design_page(&repo), &repo.allowed()).unwrap();
        assert!(page.implementation_order.is_empty());
        assert_eq!(page.design_items.len(), 2);
        assert!(page.design_items[0].text.is_none());
    }
}
