//! A-6, A-8: the Orca screen. Orca's CLI (`orca`) lists the agents that run in Orca, starts them and posts to them; nothing about a session is stored here.
//! The CLI is spawned with an argument list, never through a shell, and the prompt text is in no log line.
//! A-8 adds the project list and the terminals of Orca (closed through the CLI, and mirrored for this machine). A saved environment streams them instead (A-12, `orca_stream.rs`).

use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex, OnceLock, PoisonError},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts::write_atomic,
    auth::config_dir,
    orca_handoff::{compose, handoff_instruction, HandoffContext},
    orca_stream::{clamp_viewport, OrcaViewport},
};

/// Reading the agents is a few local calls (or one to a paired server).
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// A launch starts an agent CLI, and a send waits for the terminal to take the text.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// `orca worktree ps` is asked for this many worktrees.
const WORKTREE_LIMIT: &str = "200";
/// How long a worktree confirmed against the target's list is believed without asking the CLI again (A-18).
const HOST_TTL: Duration = Duration::from_secs(60);
/// How long the launch that follows `create_worktree` may rely on its checks (A-9).
const MADE_TTL: Duration = Duration::from_secs(60);
/// Characters of a post (a send or the first prompt of a launch).
pub(crate) const TEXT_LIMIT: usize = 100_000;
/// Characters of the line a row shows; the screen cuts it with an ellipsis, this only keeps a long message from crossing the IPC.
const LINE_LIMIT: usize = 200;
const SETTINGS_FILE: &str = "orca-settings.json";

/// Where `orca` is looked for. A GUI app does not inherit the shell's PATH, so the places Orca installs it come first and last.
fn locations() -> Vec<PathBuf> {
    [
        "/usr/local/bin/orca",
        "/Applications/Orca.app/Contents/Resources/bin/orca",
    ]
    .map(PathBuf::from)
    .into()
}

/// Which group of the screen an agent is in: waiting for the user (`waiting`, `blocked`, `permission`), `done`, or running (every other state).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum OrcaGroup {
    Waiting,
    Working,
    Done,
}

/// What a status icon shows (A-8), in Orca's own words: `question` is an agent that waits for the user (`waiting`, `blocked`, `permission`).
/// The order of the variants is Orca's rank, the highest first: an unconfirmed state is drawn as `interrupted` and ranks with it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum OrcaStatus {
    Question,
    Failed,
    Working,
    Monitoring,
    Interrupted,
    Done,
    Idle,
}

/// One top-level agent of a live terminal.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaRow {
    pub group: OrcaGroup,
    pub repo: String,
    pub branch: String,
    /// The one line of the row: the first line of the prompt, else the task, the conversation, or the last answer.
    pub line: String,
    /// When the state began for a running or waiting agent, when it last changed for a done one (epoch milliseconds, 0 when unknown).
    #[cfg_attr(test, ts(type = "number"))]
    pub at_ms: i64,
    /// The terminal that takes a send; `None` when it was not found (the row can be read but takes no post).
    pub handle: Option<String>,
    /// The agent's pane (`{tabId}:{leafId}`), which names its tab (A-12); `None` when the agent has none.
    pub pane_key: Option<String>,
    /// The worktree's path.
    pub path: String,
    /// The icon of the row (A-8).
    pub status: OrcaStatus,
    /// The project the row belongs to (`OrcaProject::key`); empty when its worktree has none.
    pub project_key: String,
    /// Where it is: `None` for this machine, else the name of the saved environment.
    #[cfg_attr(test, ts(optional = nullable))]
    pub environment: Option<String>,
}

/// The session a launch or a handoff reached (A-9), as far as Orca's reply says: a field the reply lacks (or holds in a shape that is not one) is `None`.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaStarted {
    /// The agent's pane (`{tabId}:{leafId}`), which names its tab (A-12).
    pub pane_key: Option<String>,
    /// The terminal that takes the next send.
    pub handle: Option<String>,
}

/// Where a handoff goes (A-9): a new session in a worktree.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OrcaDestination {
    New { path: String },
}

/// A terminal of Orca that runs no Claude (a shell, or another agent), in a worktree that is listed (A-8). The screen shows it as a tab and mirrors it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaTerminal {
    pub handle: String,
    pub title: String,
    pub branch: String,
    pub project_key: String,
    /// The worktree's path, where an image dropped on the terminal is put (A-10).
    pub path: String,
    /// Where it is: `None` for this machine, else the name of the saved environment.
    #[cfg_attr(test, ts(optional = nullable))]
    pub environment: Option<String>,
}

/// A row of the project list (A-8): a repository of this machine (`key` is its id), or an SSH host (`key` is `ssh:{id}`, and only what its worktrees show: its name comes from `OrcaSshTarget`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaProject {
    pub key: String,
    pub name: String,
    /// The highest rank among its agents, its worktrees' status and its plain terminals.
    pub status: OrcaStatus,
    /// Claude rows plus plain terminals.
    pub sessions: u32,
    /// The last activity (epoch milliseconds, 0 when unknown); the list is newest first.
    #[cfg_attr(test, ts(type = "number"))]
    pub at_ms: i64,
    /// Where it is: `None` for this machine, else the name of the saved environment.
    #[cfg_attr(test, ts(optional = nullable))]
    pub environment: Option<String>,
}

/// A host of `~/.ssh/config` that Orca knows (`ssh.listEditableTargets` of this machine), for its row in the project list.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaSshTarget {
    pub id: String,
    pub label: String,
}

/// A worktree a launch can start an agent or a terminal in.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaWorktree {
    pub path: String,
    pub repo: String,
    /// Orca's name of the worktree (`displayName`): it is fixed when the worktree is made with a name, so it can differ from the git branch.
    pub branch: String,
    /// The git branch the worktree is on (`branch` of `orca worktree ps` without `refs/heads/`; empty when it is detached or not given), which the heading of the file pane makes a button (A-25).
    pub git_branch: String,
    /// The project the worktree belongs to (`OrcaProject::key`; empty when it has none), which the plus of the work pane narrows the worktrees by (A-16).
    pub project_key: String,
    /// Whether it is the repository's own folder (`isMainWorktree` of Orca), which the file pane shows for a project with no tab (A-18).
    pub is_main: bool,
    /// Where it is: `None` for this machine, else the name of the saved environment.
    #[cfg_attr(test, ts(optional = nullable))]
    pub environment: Option<String>,
}

/// Where an item of a list is (A-6): `None` for this machine, else the name of a saved environment. A list read from a target says it of every item.
pub(crate) trait Placed {
    fn place(&mut self) -> &mut Option<String>;
}

macro_rules! placed {
    ($($item:ty),*) => {$(
        impl Placed for $item {
            fn place(&mut self) -> &mut Option<String> {
                &mut self.environment
            }
        }
    )*};
}

placed!(OrcaRow, OrcaTerminal, OrcaProject, OrcaWorktree);

/// Puts every item of `items` in `environment` (`None`: this machine).
pub(crate) fn place_in<T: Placed>(items: &mut [T], environment: Option<&str>) {
    for item in items {
        *item.place() = environment.map(str::to_owned);
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum OrcaState {
    /// No `orca` was found.
    Missing,
    Ready,
    /// The CLI ran, but a read failed (`message` says why).
    Failed,
}

/// What the screen draws. `target` is the saved environment's name, `None` for this machine; `environments` are the saved ones, listed even when a read failed so the target can still be changed.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaOverview {
    pub state: OrcaState,
    pub message: String,
    pub target: Option<String>,
    pub environments: Vec<String>,
    /// Newest first.
    pub rows: Vec<OrcaRow>,
    pub worktrees: Vec<OrcaWorktree>,
    /// The repositories of this machine (A-8), newest activity first.
    pub projects: Vec<OrcaProject>,
    /// What the worktrees of each SSH host show (A-8), by `ssh:{id}`.
    pub hosts: Vec<OrcaProject>,
    /// The plain terminals (A-8).
    pub terminals: Vec<OrcaTerminal>,
    /// The SSH hosts of this machine, whatever the target is (A-8). Read only with the environments: a read that does not say what the target is leaves the ones the screen held (`known`).
    pub ssh: Vec<OrcaSshTarget>,
    /// Whether this read says what the target and the environments are. A poll of the screen or of the badge does not read them, and a failed `environment list` cannot: the screen then keeps the ones it had.
    pub known: bool,
    /// This machine's lists, read at the same time when `target` is a saved environment (`None` when `target` is this machine, whose lists are the ones above). Its state is its own: a failed read of one side does not stop the other. Every item of it has no `environment`, and every item above has the target's name.
    #[cfg_attr(test, ts(optional = nullable))]
    pub local: Option<OrcaLocal>,
}

/// This machine's lists beside a saved environment's, with the state of their own read.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaLocal {
    pub state: OrcaState,
    pub message: String,
    pub rows: Vec<OrcaRow>,
    pub worktrees: Vec<OrcaWorktree>,
    pub projects: Vec<OrcaProject>,
    pub hosts: Vec<OrcaProject>,
    pub terminals: Vec<OrcaTerminal>,
}

impl From<OrcaOverview> for OrcaLocal {
    fn from(view: OrcaOverview) -> Self {
        Self {
            state: view.state,
            message: view.message,
            rows: view.rows,
            worktrees: view.worktrees,
            projects: view.projects,
            hosts: view.hosts,
            terminals: view.terminals,
        }
    }
}

impl OrcaOverview {
    fn empty(state: OrcaState) -> Self {
        Self {
            state,
            message: String::new(),
            target: None,
            environments: Vec::new(),
            rows: Vec::new(),
            worktrees: Vec::new(),
            projects: Vec::new(),
            hosts: Vec::new(),
            terminals: Vec::new(),
            ssh: Vec::new(),
            known: true,
            local: None,
        }
    }

    /// Adds this machine's read beside the target's, which stays as it is.
    fn with_local(self, local: Self) -> Self {
        Self {
            local: Some(local.into()),
            ..self
        }
    }
}

/// How much `orca_overview` reads. `Full` asks for the environments, resolves the target and reads the agents and their terminals (the screen shown, the update button, a change of the target, and after a failure);
/// `Screen` reads the agents and terminals of the target the screen holds; `Badge` reads the worktrees' agents only, for the count, with no terminal.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OrcaScope {
    Full,
    Screen,
    Badge,
}

// ---- the CLI's JSON ----

pub(crate) fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str().filter(|s| !s.trim().is_empty())
}

/// The first line of `text` that is not blank, cut to `LINE_LIMIT` characters.
pub(crate) fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(LINE_LIMIT).collect())
}

fn ms_of(value: &Value, key: &str) -> i64 {
    // Truncation is intended: an epoch in milliseconds has no meaningful fraction.
    #[allow(clippy::cast_possible_truncation)]
    value[key].as_f64().map_or(0, |ms| ms as i64)
}

/// The group an agent state belongs to: `waiting`, `blocked` and `permission` need the user, `done` is finished, anything else (also a state not known yet) runs.
fn group_of(state: &str) -> OrcaGroup {
    match state {
        "waiting" | "blocked" | "permission" => OrcaGroup::Waiting,
        "done" => OrcaGroup::Done,
        _ => OrcaGroup::Working,
    }
}

/// A terminal title without the status mark Claude Code puts in front of it: a first character that is no letter or digit, followed by a space, is taken off with the spaces after it, once.
fn without_status_mark(title: &str) -> &str {
    let mut chars = title.chars();
    match (chars.next(), chars.next()) {
        (Some(mark), Some(space)) if !mark.is_alphanumeric() && space.is_whitespace() => {
            chars.as_str().trim_start()
        }
        _ => title,
    }
}

/// The text of a row's line: the first line of the prompt, else the task's title, the conversation's name, the first line of the last answer, or the title of the pane's terminal without its status mark.
fn line_of(agent: &Value, terminal_title: Option<&str>) -> String {
    text_of(agent, "prompt")
        .and_then(first_line)
        .or_else(|| text_of(agent, "taskTitle").and_then(first_line))
        .or_else(|| text_of(agent, "conversationName").and_then(first_line))
        .or_else(|| text_of(agent, "lastAssistantMessage").and_then(first_line))
        .or_else(|| terminal_title.and_then(|t| first_line(without_status_mark(t))))
        .unwrap_or_default()
}

/// The status an Orca state word stands for; a word not known yet is `unknown`. `done` and `active` are both the green dot.
fn status_of(state: &str, unknown: OrcaStatus) -> OrcaStatus {
    match state {
        "permission" | "waiting" | "blocked" => OrcaStatus::Question,
        "failed" => OrcaStatus::Failed,
        "working" => OrcaStatus::Working,
        "monitoring" => OrcaStatus::Monitoring,
        "interrupted" | "unconfirmed" => OrcaStatus::Interrupted,
        "done" | "active" => OrcaStatus::Done,
        "inactive" => OrcaStatus::Idle,
        _ => unknown,
    }
}

/// The icon of an agent: its state (a state not known yet is running, as in A-6), and an agent flagged `interrupted` unless it waits or failed.
fn agent_status(agent: &Value) -> OrcaStatus {
    let base = status_of(
        agent["state"].as_str().unwrap_or_default(),
        OrcaStatus::Working,
    );
    if agent["interrupted"] == true && base > OrcaStatus::Failed {
        OrcaStatus::Interrupted
    } else {
        base
    }
}

/// The icon of a worktree: `sidebarStatus`, else `status`; one not known is idle.
fn worktree_status(worktree: &Value) -> OrcaStatus {
    let word = text_of(worktree, "sidebarStatus")
        .or_else(|| text_of(worktree, "status"))
        .unwrap_or_default();
    status_of(word, OrcaStatus::Idle)
}

const LOCAL_HOST: &str = "local";

/// The id of the host a worktree is on; one with none is this machine's.
fn host_of(worktree: &Value) -> &str {
    text_of(worktree, "hostId").unwrap_or(LOCAL_HOST)
}

/// The project a worktree belongs to: its repository on this machine, `ssh:{id}` on an SSH host; `None` when a repository has no id.
fn project_key_of(worktree: &Value) -> Option<String> {
    match host_of(worktree) {
        LOCAL_HOST => text_of(worktree, "repoId").map(str::to_owned),
        host => Some(format!("ssh:{host}")),
    }
}

/// The rows of `orca worktree ps` (`ps`, its `result`) with the terminals of `orca terminal list` (`terminals`, its `result`): the top-level Claude agents of a live terminal, newest first.
/// A field that is absent or of another type is left out, not an error.
pub fn rows_of(ps: &Value, terminals: &Value) -> Vec<OrcaRow> {
    // The pane of an agent is "{tabId}:{leafId}" of its terminal. A terminal that lost its tab is orphaned and still runs:
    // its ids are made up from the pty, and the pane it had is `recordedPaneKey`. Only one Orca says is Claude's is used, and not when two recorded the same pane,
    // for a post must not reach a shell or the wrong session. A live terminal of the pane comes first.
    let (orphaned, live): (Vec<&Value>, Vec<&Value>) = terminals["terminals"]
        .as_array()
        .into_iter()
        .flatten()
        .partition(|t| t["orphaned"] == true);
    let orphaned: Vec<&Value> = orphaned
        .into_iter()
        .filter(|t| t["agentIdentity"] == "claude")
        .collect();
    let recorded = |t: &Value| text_of(t, "recordedPaneKey").map(str::to_owned);
    let handles: Vec<(String, &str, Option<&str>)> = live
        .into_iter()
        .filter_map(|t| {
            Some((
                format!("{}:{}", text_of(t, "tabId")?, text_of(t, "leafId")?),
                text_of(t, "handle")?,
                text_of(t, "title"),
            ))
        })
        .chain(orphaned.iter().filter_map(|t| {
            let pane = recorded(t)?;
            let alone = orphaned
                .iter()
                .filter(|o| recorded(o).as_ref() == Some(&pane))
                .count()
                == 1;
            alone.then_some((pane, text_of(t, "handle")?, text_of(t, "title")))
        }))
        .collect();
    let mut rows: Vec<(i64, OrcaRow)> = Vec::new();
    for worktree in ps["worktrees"].as_array().into_iter().flatten() {
        for agent in worktree["agents"].as_array().into_iter().flatten() {
            if !agent["parentPaneKey"].is_null()
                || agent["hasLivePty"] != true
                || agent["agentType"] != "claude"
            {
                continue;
            }
            let group = group_of(agent["state"].as_str().unwrap_or_default());
            let updated = ms_of(agent, "updatedAt");
            let pane_key = text_of(agent, "paneKey");
            let terminal = pane_key.and_then(|pane| handles.iter().find(|(key, ..)| key == pane));
            let handle = terminal.map(|(_, handle, _)| (*handle).to_owned());
            rows.push((
                updated,
                OrcaRow {
                    group,
                    repo: text_of(worktree, "repo").unwrap_or_default().to_owned(),
                    branch: text_of(worktree, "displayName")
                        .unwrap_or_default()
                        .to_owned(),
                    line: line_of(agent, terminal.and_then(|(_, _, title)| *title)),
                    at_ms: if group == OrcaGroup::Done {
                        updated
                    } else {
                        ms_of(agent, "stateStartedAt")
                    },
                    handle,
                    pane_key: pane_key.map(str::to_owned),
                    path: text_of(worktree, "path").unwrap_or_default().to_owned(),
                    status: agent_status(agent),
                    project_key: project_key_of(worktree).unwrap_or_default(),
                    environment: None,
                },
            ));
        }
    }
    rows.sort_by_key(|(updated, _)| std::cmp::Reverse(*updated));
    rows.into_iter().map(|(_, row)| row).collect()
}

/// The git branch of a worktree of `orca worktree ps`: its `branch` (`refs/heads/{name}`) without the prefix; empty for a detached HEAD, a missing `branch` or a ref that is not a local branch.
fn git_branch_of(worktree: &Value) -> String {
    text_of(worktree, "branch")
        .and_then(|b| b.strip_prefix("refs/heads/"))
        .unwrap_or_default()
        .to_owned()
}

/// Every worktree of `orca worktree ps` (its `result`) that has a path, in the CLI's order.
pub fn worktrees_of(ps: &Value) -> Vec<OrcaWorktree> {
    ps["worktrees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|w| {
            Some(OrcaWorktree {
                path: text_of(w, "path")?.to_owned(),
                repo: text_of(w, "repo").unwrap_or_default().to_owned(),
                branch: text_of(w, "displayName").unwrap_or_default().to_owned(),
                git_branch: git_branch_of(w),
                project_key: project_key_of(w).unwrap_or_default(),
                is_main: w["isMainWorktree"] == true,
                environment: None,
            })
        })
        .collect()
}

/// The `hostId` Orca names for the worktree at `path` in `orca worktree ps` (its `result`), and its project key (`project_key_of`, empty when a repository has no id); `None` when the worktree or its `hostId` is absent (A-10 sends a file there, and Orca wants this id with it).
fn confirmed_of(ps: &Value, path: &str) -> Option<(String, String)> {
    let worktree = ps["worktrees"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|w| text_of(w, "path") == Some(path))?;
    let host_id = text_of(worktree, "hostId")?.to_owned();
    Some((host_id, project_key_of(worktree).unwrap_or_default()))
}

/// The names of the saved environments of `orca environment list` (its `result`): an entry is a name, or an object with a `name` (else an `id`).
pub fn environments_of(result: &Value) -> Vec<String> {
    result["environments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| match e {
            Value::String(name) if !name.trim().is_empty() => Some(name.clone()),
            Value::Object(_) => text_of(e, "name")
                .or_else(|| text_of(e, "id"))
                .map(str::to_owned),
            _ => None,
        })
        .collect()
}

/// The worktrees that count in the project list: not archived, with a path and a project.
fn live_worktrees(ps: &Value) -> impl Iterator<Item = (&Value, String)> {
    ps["worktrees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|w| w["isArchived"] != true && text_of(w, "path").is_some())
        .filter_map(|w| Some((w, project_key_of(w)?)))
}

/// The plain terminals of `orca terminal list` (`terminals`, its `result`): every terminal that no Claude row of the same read holds (`rows`, from `rows_of` of the same two documents; a shell, or another agent), still attached to its tab,
/// in a worktree of `ps` that is listed. The floating terminal has no worktree path and is left out.
/// The kind is the one `rows_of` gives, never `agentIdentity`: Orca takes that from the process or the title before `worktree ps` has the agent, so a terminal would be in neither list for a moment.
pub fn plain_terminals_of(ps: &Value, terminals: &Value, rows: &[OrcaRow]) -> Vec<OrcaTerminal> {
    let worktrees: Vec<(&Value, String)> = live_worktrees(ps).collect();
    terminals["terminals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["orphaned"] != true)
        .filter(|t| {
            !text_of(t, "handle")
                .is_some_and(|h| rows.iter().any(|r| r.handle.as_deref() == Some(h)))
        })
        .filter_map(|t| {
            let path = text_of(t, "worktreePath")?;
            let (worktree, key) = worktrees
                .iter()
                .find(|(w, _)| text_of(w, "path") == Some(path))?;
            Some(OrcaTerminal {
                handle: text_of(t, "handle")?.to_owned(),
                title: text_of(t, "title").and_then(first_line).unwrap_or_default(),
                branch: text_of(worktree, "displayName")
                    .unwrap_or_default()
                    .to_owned(),
                project_key: key.clone(),
                path: path.to_owned(),
                environment: None,
            })
        })
        .collect()
}

/// The project list from `ps` (its `result`), the rows and the plain terminals: the repositories of this machine (the working ones first, then the rest, each newest activity first), and apart from them what the worktrees of each SSH host show (newest activity first).
/// A project has the highest rank among its agents (top-level, with a live pty), its worktrees' status and its plain terminals (a green dot), and as sessions its Claude rows and plain terminals.
pub fn projects_of(
    ps: &Value,
    rows: &[OrcaRow],
    plain: &[OrcaTerminal],
) -> (Vec<OrcaProject>, Vec<OrcaProject>) {
    let mut projects: Vec<OrcaProject> = Vec::new();
    for (worktree, key) in live_worktrees(ps) {
        let mut status = worktree_status(worktree);
        for agent in worktree["agents"].as_array().into_iter().flatten() {
            if agent["parentPaneKey"].is_null() && agent["hasLivePty"] == true {
                status = status.min(agent_status(agent));
            }
        }
        let at_ms = ms_of(worktree, "lastActivityAt");
        if let Some(project) = projects.iter_mut().find(|p| p.key == key) {
            project.status = project.status.min(status);
            project.at_ms = project.at_ms.max(at_ms);
            continue;
        }
        let name = if key.starts_with("ssh:") {
            host_of(worktree)
        } else {
            text_of(worktree, "repo").unwrap_or_default()
        };
        projects.push(OrcaProject {
            key,
            name: name.to_owned(),
            status,
            sessions: 0,
            at_ms,
            environment: None,
        });
    }
    for project in &mut projects {
        let rows = rows.iter().filter(|r| r.project_key == project.key).count();
        let terminals = plain
            .iter()
            .filter(|t| t.project_key == project.key)
            .count();
        project.sessions = u32::try_from(rows + terminals).unwrap_or(u32::MAX);
        if terminals > 0 {
            project.status = project.status.min(OrcaStatus::Done);
        }
    }
    // Newest first; a stable sort keeps the CLI's order between equal times.
    projects.sort_by_key(|p| std::cmp::Reverse(p.at_ms));
    let (mut repos, hosts): (Vec<_>, Vec<_>) = projects
        .into_iter()
        .partition(|p| !p.key.starts_with("ssh:"));
    // The working projects first; the stable sort keeps the newest-first order inside each part. The SSH hosts keep theirs.
    repos.sort_by_key(|p| p.status != OrcaStatus::Working);
    (repos, hosts)
}

/// The SSH hosts of `ssh.listEditableTargets` (its `result`), in its order: the first line of the label, else the `configHost`. A target with no id or no name is dropped.
pub fn ssh_targets_of(result: &Value) -> Vec<OrcaSshTarget> {
    result["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let label = text_of(t, "label")
                .and_then(first_line)
                .or_else(|| text_of(t, "configHost").and_then(first_line))?;
            Some(OrcaSshTarget {
                id: text_of(t, "id")?.to_owned(),
                label,
            })
        })
        .collect()
}

/// The lines of a screen read (`orca terminal read --screen` or `terminal.read` with `screen: true`; its `result`): `terminal.tail`, an array of lines with no colors.
pub fn screen_lines_of(result: &Value) -> Vec<String> {
    result["terminal"]["tail"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect()
}

/// The params of `terminal.read` for the screen: what `orca terminal read --screen` sends (`screen: true`), so the lines are the rendered screen and not the accumulated output.
fn screen_params(handle: &str) -> Value {
    serde_json::json!({"terminal": handle, "screen": true})
}

/// The lines of a `terminal.read` answered over the socket. An Orca that ignores `screen` answers the accumulated output with no `source`, which the CLI refuses to present as a screen (`incompatible_runtime`), and so does this.
fn screen_of(result: &Value) -> Result<Vec<String>, String> {
    if result["terminal"]["source"].is_null() {
        return Err("この Orca は画面の読みに対応していません。Orca を更新してください".into());
    }
    Ok(screen_lines_of(result))
}

/// Whether the CLI's output is the `terminal_handle_stale` error. Orca answers it for a terminal that runs as well as for one that is gone, so it is no proof of a closed terminal.
fn is_stale(out: &str) -> bool {
    serde_json::from_str::<Value>(out.trim())
        .is_ok_and(|doc| doc["ok"] == false && doc["error"]["code"] == "terminal_handle_stale")
}

/// The session a launch started: `result.outcome` (`{kind: "terminal", handle, paneKey}`).
fn started_of(result: &Value) -> OrcaStarted {
    let outcome = &result["outcome"];
    OrcaStarted {
        pane_key: text_of(outcome, "paneKey")
            .filter(|k| check_pane_key(k).is_ok())
            .map(str::to_owned),
        handle: text_of(outcome, "handle")
            .filter(|h| check_handle(h).is_ok())
            .map(str::to_owned),
    }
}

/// The terminal `orca terminal create` made (A-16): `result.terminal.handle`. Orca names no pane for a plain terminal, so `pane_key` is `None`.
fn created_of(result: &Value) -> OrcaStarted {
    OrcaStarted {
        pane_key: None,
        handle: text_of(&result["terminal"], "handle")
            .filter(|h| check_handle(h).is_ok())
            .map(str::to_owned),
    }
}

/// The path of the worktree `orca worktree create` made: `result.worktree.path`, which must be an absolute path.
fn created_worktree_path_of(result: &Value) -> Result<String, String> {
    text_of(&result["worktree"], "path")
        .filter(|path| check_path(path).is_ok())
        .map(str::to_owned)
        .ok_or_else(|| "Orca が新しい worktree の場所を答えませんでした".into())
}

/// The `result` of the CLI's JSON (`{ok, result, error: {code, message}}`), or the error's message. The exit code is not looked at: a failure prints JSON too.
fn parse_output(out: &str) -> Result<Value, String> {
    let out = out.trim();
    if out.is_empty() {
        return Err("Orca から応答がありません。Orca が起動しているか確認してください".into());
    }
    let mut doc: Value =
        serde_json::from_str(out).map_err(|_| "Orca の出力を読めません".to_owned())?;
    if doc["ok"] == true {
        return Ok(doc["result"].take());
    }
    Err(text_of(&doc["error"], "message")
        .or_else(|| text_of(&doc["error"], "code"))
        .unwrap_or("Orca の操作に失敗しました")
        .to_owned())
}

// ---- the target ----

/// The Orca the screen talks to: this machine's, or a saved environment (a paired server).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Target {
    Local,
    Environment { name: String },
}

/// What the settings file holds: no file yet, a file that cannot be used, or a target.
#[derive(Clone, Debug, PartialEq)]
enum Saved {
    Nothing,
    Unusable,
    Target(Target),
}

/// The target a settings file holds; a file that does not say one is `Unusable`.
fn parse_target(text: &str) -> Saved {
    serde_json::from_str(text).map_or(Saved::Unusable, Saved::Target)
}

fn load_target(dir: &Path) -> Saved {
    match std::fs::read_to_string(dir.join(SETTINGS_FILE)) {
        Ok(text) => parse_target(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::Nothing,
        Err(_) => Saved::Unusable,
    }
}

fn save_target(dir: &Path, environment: Option<&str>) -> Result<(), String> {
    let target = environment.map_or(Target::Local, |name| Target::Environment {
        name: name.to_owned(),
    });
    let text = serde_json::to_string_pretty(&target).map_err(|e| e.to_string())?;
    write_atomic(dir, SETTINGS_FILE, &text)
}

/// The environment to talk to (`None`: this machine). Only when no file was saved yet the first saved environment is used, else this machine.
/// A saved environment that is no longer listed, or a file that cannot be used while an environment is saved, is an error: the target never changes by itself, and the owner chooses again.
fn resolve_target(saved: &Saved, environments: &[String]) -> Result<Option<String>, String> {
    let lost = || Err("保存した接続先が見つかりません".to_owned());
    match saved {
        Saved::Nothing => Ok(environments.first().cloned()),
        // With no environment saved there is nothing else to choose.
        Saved::Unusable if environments.is_empty() => Ok(None),
        Saved::Unusable => lost(),
        Saved::Target(Target::Local) => Ok(None),
        Saved::Target(Target::Environment { name }) if environments.contains(name) => {
            Ok(Some(name.clone()))
        }
        Saved::Target(Target::Environment { .. }) => lost(),
    }
}

/// The name of the environment a settings file holds, for the label of a failed read.
fn saved_name(saved: &Saved) -> Option<String> {
    match saved {
        Saved::Target(Target::Environment { name }) => Some(name.clone()),
        _ => None,
    }
}

// ---- validation ----

fn check_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("指示を書いてください".into());
    }
    if text.chars().count() > TEXT_LIMIT {
        return Err(format!("指示は {TEXT_LIMIT} 文字までです"));
    }
    Ok(())
}

/// A terminal handle is `term_` and an ID, so nothing in it can be read as an option.
pub(crate) fn check_handle(handle: &str) -> Result<(), String> {
    let id = handle.strip_prefix("term_").unwrap_or_default();
    if !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        Ok(())
    } else {
        Err("宛先のターミナルが正しくありません".into())
    }
}

/// A pane is `{tabId}:{leafId}`; nothing else is accepted, and a key is never put in a command line.
fn check_pane_key(pane_key: &str) -> Result<(), String> {
    if !pane_key.is_empty()
        && pane_key.chars().count() <= 256
        && pane_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        Ok(())
    } else {
        Err("エージェントの場所が正しくありません".into())
    }
}

pub(crate) fn check_path(path: &str) -> Result<(), String> {
    if Path::new(path).is_absolute() {
        Ok(())
    } else {
        Err("worktree の場所が正しくありません".into())
    }
}

/// The handle must belong to a row of the list read just now (a top-level agent of a live terminal), or the terminal is gone.
fn check_session(rows: &[OrcaRow], handle: &str) -> Result<(), String> {
    if rows.iter().any(|r| r.handle.as_deref() == Some(handle)) {
        Ok(())
    } else {
        Err("宛先のセッションは終了したか、見つかりません。一覧を読み直してください".into())
    }
}

/// Keys typed into a terminal: control bytes and blanks are the point, but not a NUL (an argument cannot hold one) or more than `TEXT_LIMIT` characters.
pub(crate) fn check_keys(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("入力がありません".into());
    }
    if text.contains('\0') {
        return Err("送れない文字が含まれています".into());
    }
    if text.chars().count() > TEXT_LIMIT {
        return Err(format!("一度に送れるのは {TEXT_LIMIT} 文字までです"));
    }
    Ok(())
}

/// The handle must belong to a terminal of the list read just now: a Claude session's or a plain one.
fn check_terminal(
    rows: &[OrcaRow],
    terminals: &[OrcaTerminal],
    handle: &str,
) -> Result<(), String> {
    if rows.iter().any(|r| r.handle.as_deref() == Some(handle))
        || terminals.iter().any(|t| t.handle == handle)
    {
        Ok(())
    } else {
        Err("宛先のターミナルは終了したか、見つかりません。一覧を読み直してください".into())
    }
}

/// The path must be a worktree of the list read just now.
fn check_worktree(worktrees: &[OrcaWorktree], path: &str) -> Result<(), String> {
    if worktrees.iter().any(|w| w.path == path) {
        Ok(())
    } else {
        Err("起動先の worktree が見つかりません。一覧を読み直してください".into())
    }
}

/// The project of a new worktree must be a repository of this machine or the saved environment in the list read just now (`ssh:` hosts are not repositories).
fn check_project(ps: &Value, project: &str) -> Result<(), String> {
    if !project.starts_with("ssh:") && live_worktrees(ps).any(|(_, key)| key == project) {
        Ok(())
    } else {
        Err("worktree を作るプロジェクトが見つかりません。一覧を読み直してください".into())
    }
}

/// The name of a new worktree, trimmed: one line with no control character, no path separator, not `.` or `..`, and not starting with `-` (an option).
pub(crate) fn check_worktree_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("worktree の名前を入力してください".into());
    }
    if name.starts_with('-')
        || matches!(name, "." | "..")
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err("worktree の名前に使えない文字が含まれています".into());
    }
    Ok(name)
}

/// The branch of a new worktree (`--branch`) or the ref it starts from (`--base-branch`), trimmed; `None` when not given or blank. `label` opens the error.
/// The rules are `git check-ref-format`'s: no space, control character or `~ ^ : ? * [ \\`, no zero-width, bidirectional or tag character (the ones `orca_handoff` takes out of a card), no `..` or `@{`, not `@` alone, no `//`, no component starting with `.` or ending with `.lock`, and no `/` or `.` at the end, and a value starting with `-` is refused as an option.
pub(crate) fn check_ref<'a>(
    label: &str,
    value: Option<&'a str>,
) -> Result<Option<&'a str>, String> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let bad_char = |c: char| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c);
    let bad_component =
        |part: &str| part.is_empty() || part.starts_with('.') || part.ends_with(".lock");
    if value.starts_with('-')
        || value == "@"
        || value.contains("..")
        || value.contains("@{")
        || value.ends_with(['/', '.'])
        || value.chars().any(bad_char)
        || crate::orca_handoff::without_hidden(value) != value
        || value.split('/').any(bad_component)
    {
        return Err(format!("{label}に使えない文字が含まれています"));
    }
    Ok(Some(value))
}

/// A send the terminal did not take (`result.send.accepted` false) is a failure although the CLI answered `ok`.
pub(crate) fn check_accepted(result: &Value) -> Result<(), String> {
    if result["send"]["accepted"] == false {
        Err("Orca が指示を受け付けませんでした".into())
    } else {
        Ok(())
    }
}

fn check_environment(name: &str, environments: &[String]) -> Result<(), String> {
    if environments.iter().any(|e| e == name) {
        Ok(())
    } else {
        Err(format!("保存されていない接続先です: {name}"))
    }
}

// ---- the arguments ----

fn args_of(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

/// `--environment=NAME` after the command's own arguments, in the `=` form so a name is never read as another option.
fn with_environment(mut args: Vec<String>, environment: Option<&str>) -> Vec<String> {
    if let Some(name) = environment {
        args.push(format!("--environment={name}"));
    }
    args
}

fn ps_args(environment: Option<&str>) -> Vec<String> {
    with_environment(
        args_of(&["worktree", "ps", "--limit", WORKTREE_LIMIT, "--json"]),
        environment,
    )
}

fn terminals_args(environment: Option<&str>) -> Vec<String> {
    with_environment(args_of(&["terminal", "list", "--json"]), environment)
}

/// The user's text is joined to its flag (`--text=...`): `--text --json` is refused as "requires a value", so a text that looks like an option needs the `=` form.
fn send_args(handle: &str, text: &str, environment: Option<&str>) -> Vec<String> {
    let mut args = args_of(&["terminal", "send", "--terminal", handle]);
    args.extend([format!("--text={text}"), "--enter".into(), "--json".into()]);
    with_environment(args, environment)
}

/// Closes the terminal's tab; Orca stops what runs in it.
fn close_args(handle: &str, environment: Option<&str>) -> Vec<String> {
    with_environment(
        args_of(&["terminal", "close", "--terminal", handle, "--tab", "--json"]),
        environment,
    )
}

/// Closes the terminal itself, with no `--tab`: what stopped a terminal that the close of its tab answered `terminal_handle_stale` for.
fn close_plain_args(handle: &str, environment: Option<&str>) -> Vec<String> {
    with_environment(
        args_of(&["terminal", "close", "--terminal", handle, "--json"]),
        environment,
    )
}

/// What the answer of the close of a tab decides: it is done, or the terminal is closed again with no `--tab`.
#[derive(Debug, PartialEq)]
enum AfterTabClose {
    Done,
    CloseAgain,
}

/// Reads the answer of `orca terminal close --tab`: `terminal_handle_stale` is closed again with no `--tab`, any other failure is its message.
fn after_tab_close(out: &str) -> Result<AfterTabClose, String> {
    if is_stale(out) {
        return Ok(AfterTabClose::CloseAgain);
    }
    parse_output(out).map(|_| AfterTabClose::Done)
}

/// The screen of the terminal as lines with no colors.
fn screen_args(handle: &str, environment: Option<&str>) -> Vec<String> {
    with_environment(
        args_of(&[
            "terminal",
            "read",
            "--terminal",
            handle,
            "--screen",
            "--json",
        ]),
        environment,
    )
}

/// Always Claude. A session started from the Orca screen (A-12) has no first prompt: the user types it in the terminal.
fn launch_args(path: &str, prompt: Option<&str>, environment: Option<&str>) -> Vec<String> {
    let mut args = args_of(&["agent", "launch", "--agent", "claude"]);
    args.extend([
        "--worktree".into(),
        format!("path:{path}"),
        "--surface".into(),
        "terminal".into(),
    ]);
    args.extend(prompt.map(|text| format!("--prompt={text}")));
    args.push("--json".into());
    with_environment(args, environment)
}

/// A plain terminal in the worktree (A-16): `terminal create` makes the tab and runs nothing in it. No `--focus`: the screen selects the tab once the list holds it.
fn create_args(path: &str, environment: Option<&str>) -> Vec<String> {
    let mut args = args_of(&["terminal", "create", "--worktree"]);
    args.extend([format!("path:{path}"), "--json".into()]);
    with_environment(args, environment)
}

/// A new worktree in the repository `project` (A-9): independent of any worktree (`--no-parent`), because the CLI would otherwise record the caller's context as its parent. `--repo=id:` takes the repository id the list holds; `--project` takes a project id or a display name, which the list does not hold.
/// `--branch` and `--base-branch` are passed only when given (already checked by `check_ref`).
fn create_worktree_args(
    project: &str,
    name: &str,
    branch: Option<&str>,
    base: Option<&str>,
    environment: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "worktree".into(),
        "create".into(),
        format!("--repo=id:{project}"),
        format!("--name={name}"),
    ];
    if let Some(branch) = branch {
        args.push(format!("--branch={branch}"));
    }
    if let Some(base) = base {
        args.push(format!("--base-branch={base}"));
    }
    args.extend(["--no-parent".into(), "--json".into()]);
    with_environment(args, environment)
}

// ---- running the CLI ----

enum RunError {
    Missing,
    Failed(String),
}

/// Runs `orca` with `args` and returns its stdout. A run past `timeout` is killed. The exit code is not looked at (`parse_output`); stderr is dropped.
fn run(args: &[String], timeout: Duration) -> Result<String, RunError> {
    for path in locations() {
        let mut command = Command::new(&path);
        // Not the app's own folder: the CLI infers a worktree from the current directory.
        command
            .args(args)
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(RunError::Failed(format!("orca を起動できません: {e}"))),
        };
        let mut stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut out = String::new();
            let _ = tx.send(stdout.read_to_string(&mut out).map(|_| out));
        });
        let out = rx.recv_timeout(timeout);
        if out.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
        return match out {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => Err(RunError::Failed(format!("orca の出力を読めません: {e}"))),
            Err(_) => Err(RunError::Failed("Orca が時間内に応答しませんでした".into())),
        };
    }
    Err(RunError::Missing)
}

/// Runs the CLI and gives the `result` of its JSON.
fn call(args: &[String], timeout: Duration) -> Result<Value, RunError> {
    parse_output(&run(args, timeout)?).map_err(RunError::Failed)
}

fn read_environments() -> Result<Vec<String>, RunError> {
    call(&args_of(&["environment", "list", "--json"]), READ_TIMEOUT)
        .map(|result| environments_of(&result))
}

/// The answers of `orca worktree ps` and `orca terminal list`.
type Lists = (Result<Value, RunError>, Result<Value, RunError>);

/// `orca worktree ps` and, when `terminals` is true, `orca terminal list` of the target, run side by side: the answer waits for the slower one, not for both.
/// Without terminals the second answer is an empty document.
fn read_lists(environment: Option<&str>, terminals: bool) -> Lists {
    std::thread::scope(|scope| {
        let list = scope.spawn(|| {
            if terminals {
                call(&terminals_args(environment), READ_TIMEOUT)
            } else {
                Ok(Value::Null)
            }
        });
        let ps = call(&ps_args(environment), READ_TIMEOUT);
        (ps, list.join().unwrap())
    })
}

fn message_of(e: RunError) -> String {
    match e {
        RunError::Missing => not_installed(),
        RunError::Failed(message) => message,
    }
}

fn failed_overview(
    message: String,
    target: Option<String>,
    environments: Vec<String>,
) -> OrcaOverview {
    OrcaOverview {
        message,
        target,
        environments,
        ..OrcaOverview::empty(OrcaState::Failed)
    }
}

fn overview(dir: &Path, scope: OrcaScope, held: Option<String>) -> OrcaOverview {
    // Only a full read asks for the environments and resolves the target; the others use the one the screen holds.
    let (target, environments, known, early) = if scope == OrcaScope::Full {
        let saved = load_target(dir);
        // This machine's lists are read at the same time as the environments, whichever target is resolved: they are the target's own, or the lists beside it.
        let (listed, early) = std::thread::scope(|threads| {
            let lists = threads.spawn(|| read_lists(None, true));
            (read_environments(), lists.join().unwrap())
        });
        let environments = match listed {
            Ok(environments) => environments,
            Err(RunError::Missing) => return OrcaOverview::empty(OrcaState::Missing),
            // The target and the environments are not learned: the screen keeps the ones it had.
            Err(RunError::Failed(message)) => {
                return OrcaOverview {
                    known: false,
                    ..failed_overview(message, None, Vec::new())
                }
            }
        };
        worktree_hosts().retain_environments(&environments);
        match resolve_target(&saved, &environments) {
            Ok(target) => (target, environments, true, Some(early)),
            Err(message) => return failed_overview(message, saved_name(&saved), environments),
        }
    } else {
        (held, Vec::new(), false, None)
    };
    read_both(target, environments, known, scope, early)
}

/// The lists of `target`, and, when it is a saved environment, this machine's beside them, read side by side (`local`). `early` is the pair `read_lists(None, ...)` gave for this machine and `scope`, when it was read already.
fn read_both(
    target: Option<String>,
    environments: Vec<String>,
    known: bool,
    scope: OrcaScope,
    early: Option<Lists>,
) -> OrcaOverview {
    if target.is_none() {
        return read_overview(target, environments, known, scope, early);
    }
    let (view, local) = std::thread::scope(|threads| {
        let local = threads.spawn(|| read_overview(None, Vec::new(), false, scope, early));
        (
            read_overview(target, environments, known, scope, None),
            local.join().unwrap(),
        )
    });
    view.with_local(local)
}

/// The lists of `target` (the agents with their terminals, the worktrees, the projects), drawn as `scope` asks. `early` is the pair `read_lists` gave for the same target and scope, when it was read already.
fn read_overview(
    target: Option<String>,
    environments: Vec<String>,
    known: bool,
    scope: OrcaScope,
    early: Option<Lists>,
) -> OrcaOverview {
    let lists = early.unwrap_or_else(|| read_lists(target.as_deref(), scope != OrcaScope::Badge));
    if let (Ok(ps), Ok(_)) = &lists {
        worktree_hosts().sync(target.as_deref(), ps);
    }
    assemble(target, environments, known, scope, lists)
}

/// The overview of `target` from the two lists read for it: every item is placed in the target's environment.
fn assemble(
    target: Option<String>,
    environments: Vec<String>,
    known: bool,
    scope: OrcaScope,
    (ps, terminals): Lists,
) -> OrcaOverview {
    match (ps, terminals) {
        (Ok(ps), Ok(terminals)) => {
            let mut rows = rows_of(&ps, &terminals);
            let mut worktrees = worktrees_of(&ps);
            // The count alone is wanted by a `Badge` read: its terminals and projects would not be drawn.
            let (mut plain, mut projects, mut hosts) = if scope == OrcaScope::Badge {
                (Vec::new(), Vec::new(), Vec::new())
            } else {
                let plain = plain_terminals_of(&ps, &terminals, &rows);
                let (projects, hosts) = projects_of(&ps, &rows, &plain);
                (plain, projects, hosts)
            };
            let place = target.as_deref();
            place_in(&mut rows, place);
            place_in(&mut worktrees, place);
            place_in(&mut plain, place);
            place_in(&mut projects, place);
            place_in(&mut hosts, place);
            OrcaOverview {
                target,
                environments,
                rows,
                worktrees,
                projects,
                hosts,
                terminals: plain,
                known,
                ..OrcaOverview::empty(OrcaState::Ready)
            }
        }
        (Err(RunError::Missing), _) | (_, Err(RunError::Missing)) => {
            OrcaOverview::empty(OrcaState::Missing)
        }
        (Err(RunError::Failed(message)), _) | (_, Err(RunError::Failed(message))) => OrcaOverview {
            known,
            ..failed_overview(message, target, environments)
        },
    }
}

/// A-9: the saved environments when `environment` (`None`: this machine) may be read, else the overview that says why not. A name that is not among the saved ones is refused before it reaches the CLI.
fn destination_check(
    environment: Option<&str>,
    listed: Result<Vec<String>, RunError>,
) -> Result<Vec<String>, Box<OrcaOverview>> {
    let environments = match listed {
        Ok(environments) => environments,
        Err(RunError::Missing) => return Err(Box::new(OrcaOverview::empty(OrcaState::Missing))),
        Err(RunError::Failed(message)) => {
            return Err(Box::new(failed_overview(
                message,
                environment.map(str::to_owned),
                Vec::new(),
            )))
        }
    };
    match environment.map(|name| check_environment(name, &environments)) {
        Some(Err(message)) => Err(Box::new(failed_overview(
            message,
            environment.map(str::to_owned),
            environments,
        ))),
        _ => Ok(environments),
    }
}

/// A-9: the destination (`None` outer: none yet; `None` inner: this machine) whose name `destination_overview` last checked against the saved environments, in memory only.
static CHECKED_DESTINATION: Mutex<Option<Option<String>>> = Mutex::new(None);

/// True when the saved environments need not be asked for again: the poll of a shown session (`force` false) of the destination checked just before. The first read of a destination and a read after a choice or a send (`force`) always check.
fn already_checked(last: &Option<Option<String>>, environment: Option<&str>, force: bool) -> bool {
    !force && last.as_ref().is_some_and(|l| l.as_deref() == environment)
}

/// A-9: the lists of the destination the pane chose, whatever the Orca screen holds. The target saved for the screen is not read or changed.
/// The saved environments are asked for (and the name checked against them) unless `already_checked`; then the answer holds none.
fn destination_overview(environment: Option<&str>, force: bool) -> OrcaOverview {
    let mut last = CHECKED_DESTINATION
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let environments = if already_checked(&last, environment, force) {
        Vec::new()
    } else {
        match destination_check(environment, read_environments()) {
            Ok(environments) => {
                *last = Some(environment.map(str::to_owned));
                environments
            }
            Err(view) => {
                *last = None;
                return *view;
            }
        }
    };
    drop(last);
    read_overview(
        environment.map(str::to_owned),
        environments,
        false,
        OrcaScope::Screen,
        None,
    )
}

/// A-9: the worktree `create_worktree` made last, with the target it was made in. The launch that follows it takes the record once instead of asking for the saved environments and the list again: the environment was checked and the path was named by Orca just before, and both must be the same. A record is believed for `MADE_TTL` only, is used up by the launch that takes it, and a launch that does not match it checks as any other.
#[derive(Default)]
struct MadeWorktree(Option<(Option<String>, String, Instant)>);

impl MadeWorktree {
    fn put(&mut self, environment: Option<&str>, path: &str, now: Instant) {
        self.0 = Some((environment.map(str::to_owned), path.to_owned(), now));
    }

    /// True once for the path and the target of the record, if it is not older than `MADE_TTL`.
    fn take(&mut self, environment: Option<&str>, path: &str, now: Instant) -> bool {
        let Some((env, made, at)) = &self.0 else {
            return false;
        };
        let fresh = now.saturating_duration_since(*at) < MADE_TTL;
        let same = env.as_deref() == environment && made == path;
        if same {
            self.0 = None;
        }
        same && fresh
    }
}

fn made_worktree() -> std::sync::MutexGuard<'static, MadeWorktree> {
    static MADE: OnceLock<Mutex<MadeWorktree>> = OnceLock::new();
    MADE.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Checks `environment` against the saved ones (nothing is asked for this machine).
fn check_listed(environment: Option<&str>) -> Result<(), String> {
    let Some(name) = environment else {
        return Ok(());
    };
    match read_environments() {
        Ok(environments) => check_environment(name, &environments),
        Err(RunError::Missing) => Err(not_installed()),
        Err(RunError::Failed(message)) => Err(message),
    }
}

fn not_installed() -> String {
    "Orca のコマンド（orca）が見つかりません".into()
}

/// Runs a write of the CLI once and gives its `result`. It is never run again: after a lost reply a second run would post twice (the CLI forbids a fresh retry of a launch).
fn write(args: &[String]) -> Result<Value, String> {
    let result = call(args, WRITE_TIMEOUT).map_err(message_of)?;
    check_accepted(&result)?;
    Ok(result)
}

fn send(handle: &str, text: &str, environment: Option<&str>) -> Result<(), String> {
    check_handle(handle)?;
    check_text(text)?;
    check_listed(environment)?;
    // The terminal may have closed since the list on the screen was read.
    let (ps, terminals) = read_lists(environment, true);
    check_session(
        &rows_of(&ps.map_err(message_of)?, &terminals.map_err(message_of)?),
        handle,
    )?;
    write(&send_args(handle, text, environment)).map(|_| ())
}

/// A call of this machine's Orca over its unix socket from a thread of `blocking`, so no CLI process is started.
fn local_blocking(method: &str, params: Value) -> Result<Value, String> {
    tokio::runtime::Handle::current().block_on(crate::orca_link::local_call(method, params))
}

/// The lines on the screen of a terminal: of this machine over its unix socket (`terminal.read`), of a saved environment through the CLI. The handle was checked by the caller.
fn read_lines(handle: &str, environment: Option<&str>) -> Result<Vec<String>, String> {
    match environment {
        None => local_blocking("terminal.read", screen_params(handle))
            .and_then(|result| screen_of(&result)),
        Some(_) => call(&screen_args(handle, environment), READ_TIMEOUT)
            .map(|result| screen_lines_of(&result))
            .map_err(message_of),
    }
}

/// Starts Claude in the worktree at `path`, with `prompt` as its first prompt when there is one (A-9; the Orca screen starts it with none).
fn launch(
    path: &str,
    prompt: Option<&str>,
    environment: Option<&str>,
) -> Result<OrcaStarted, String> {
    if let Some(text) = prompt {
        check_text(text)?;
    }
    // A-9: the worktree `create_worktree` just made was checked by it, so its launch asks for neither the saved environments nor the list.
    if made_worktree().take(environment, path, Instant::now()) {
        check_path(path)?;
    } else {
        check_start(path, environment)?;
    }
    write(&launch_args(path, prompt, environment)).map(|result| started_of(&result))
}

/// Opens a plain terminal in the worktree at `path` (A-16), once, with the checks of a launch.
fn open_terminal(path: &str, environment: Option<&str>) -> Result<OrcaStarted, String> {
    check_start(path, environment)?;
    write(&create_args(path, environment)).map(|result| created_of(&result))
}

/// Makes a new worktree named `name` in the project `project` of the target (A-9), once, and gives its path. The name, the branch and the base (when given) and the environment are validated, and the project must be in the list read just before; otherwise nothing is made.
fn create_worktree(
    project: &str,
    name: &str,
    branch: Option<&str>,
    base: Option<&str>,
    environment: Option<&str>,
) -> Result<String, String> {
    let name = check_worktree_name(name)?;
    let branch = check_ref("ブランチ名", branch)?;
    let base = check_ref("作成元", base)?;
    check_listed(environment)?;
    let (ps, _) = read_lists(environment, false);
    check_project(&ps.map_err(message_of)?, project)?;
    let result = write(&create_worktree_args(
        project,
        name,
        branch,
        base,
        environment,
    ))?;
    let path = created_worktree_path_of(&result)?;
    made_worktree().put(environment, &path, Instant::now());
    Ok(path)
}

/// What a launch and a new terminal check before they run: the path is absolute, the environment is a saved one, and the path is a worktree of the list read just now.
fn check_start(path: &str, environment: Option<&str>) -> Result<(), String> {
    check_path(path)?;
    check_listed(environment)?;
    let (ps, _) = read_lists(environment, false);
    check_worktree(&worktrees_of(&ps.map_err(message_of)?), path)
}

/// The `hostId` of the worktree at `path` of the target's list read just now (A-10): the path must be in it.
pub(crate) fn worktree_host(path: &str, environment: Option<&str>) -> Result<String, String> {
    worktree_confirmation(path, environment).map(|(host_id, _)| host_id)
}

/// The `hostId` and the project key of the worktree at `path` of the target's list read just now: the path must be in it.
fn worktree_confirmation(
    path: &str,
    environment: Option<&str>,
) -> Result<(String, String), String> {
    check_path(path)?;
    check_listed(environment)?;
    let (ps, _) = read_lists(environment, false);
    let ps = ps.map_err(message_of)?;
    check_worktree(&worktrees_of(&ps), path)?;
    confirmed_of(&ps, path).ok_or_else(|| "Orca が worktree のホストを答えませんでした".into())
}

/// The worktrees that were confirmed to be in a target's list, with their `hostId` and project key, so that the files of A-18 do not start `orca worktree ps` at every read of a folder.
/// An entry is for one path of one target (`None`: this machine, else the name of a saved environment) and is compared exactly, as the list is. It is believed for `HOST_TTL` only, and it leaves when Orca's list read by the screen no longer holds the worktree (`sync`), when the environment is no longer a saved one (`retain_environments`), and when a call made with it failed (`forget`).
#[derive(Default)]
pub(crate) struct WorktreeHosts {
    entries: HashMap<(Option<String>, String), (String, String, Instant)>,
}

impl WorktreeHosts {
    fn key(environment: Option<&str>, path: &str) -> (Option<String>, String) {
        (environment.map(str::to_owned), path.to_owned())
    }

    /// The `hostId` and the project key confirmed for `path` of the target at `now`, if the confirmation is not older than `HOST_TTL`.
    fn get(&self, environment: Option<&str>, path: &str, now: Instant) -> Option<(String, String)> {
        let (host_id, project, at) = self.entries.get(&Self::key(environment, path))?;
        (now.saturating_duration_since(*at) < HOST_TTL).then(|| (host_id.clone(), project.clone()))
    }

    fn put(
        &mut self,
        environment: Option<&str>,
        path: &str,
        confirmed: (&str, &str),
        now: Instant,
    ) {
        self.entries.insert(
            Self::key(environment, path),
            (confirmed.0.to_owned(), confirmed.1.to_owned(), now),
        );
    }

    fn forget(&mut self, environment: Option<&str>, path: &str) {
        self.entries.remove(&Self::key(environment, path));
    }

    /// Brings the entries of the target in step with a list of `orca worktree ps` (its `result`) just read: a worktree that is not in it leaves, and one that is takes the `hostId` and the project the list names. The time of an entry is not renewed: only a read that was made for the entry confirms it.
    fn sync(&mut self, environment: Option<&str>, ps: &Value) {
        self.entries.retain(|(env, path), entry| {
            if env.as_deref() != environment {
                return true;
            }
            match confirmed_of(ps, path) {
                Some((host_id, project)) => {
                    entry.0 = host_id;
                    entry.1 = project;
                    true
                }
                None => false,
            }
        });
    }

    /// Drops the entries of an environment that is not among the saved ones.
    fn retain_environments(&mut self, saved: &[String]) {
        self.entries
            .retain(|(env, _), _| env.as_ref().is_none_or(|name| saved.contains(name)));
    }
}

fn worktree_hosts() -> std::sync::MutexGuard<'static, WorktreeHosts> {
    static HOSTS: OnceLock<Mutex<WorktreeHosts>> = OnceLock::new();
    HOSTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// The runs that are on their way, by key: a call for a key that has one waits for its answer and runs nothing, so that calls made at the same time for the same key run once. The answer is kept for the calls that waited only, and the next call runs again.
pub(crate) struct Flights<K, V> {
    running: Mutex<HashMap<K, Arc<Mutex<Option<V>>>>>,
}

impl<K, V> Default for Flights<K, V> {
    fn default() -> Self {
        Self {
            running: Mutex::default(),
        }
    }
}

impl<K: std::hash::Hash + Eq + Clone, V: Clone> Flights<K, V> {
    fn running(&self) -> std::sync::MutexGuard<'_, HashMap<K, Arc<Mutex<Option<V>>>>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The answer of `run`, or of the run for `key` that was on its way when this was called. A run that panicked answers nothing, and a call that waited for it runs its own.
    fn run(&self, key: K, run: impl FnOnce() -> V) -> V {
        let slot = Arc::new(Mutex::new(None));
        // The slot is locked before the others can see it, so they wait until the run has answered.
        let mut answer = slot.lock().unwrap_or_else(PoisonError::into_inner);
        let on_its_way = match self.running().entry(key.clone()) {
            std::collections::hash_map::Entry::Occupied(held) => Some(Arc::clone(held.get())),
            std::collections::hash_map::Entry::Vacant(free) => {
                free.insert(Arc::clone(&slot));
                None
            }
        };
        let Some(other) = on_its_way else {
            // Leaves the table when the run ends, a panic included, before the slot is unlocked.
            struct Leave<'a, K: std::hash::Hash + Eq, V>(&'a Flights<K, V>, &'a K);
            impl<K: std::hash::Hash + Eq, V> Drop for Leave<'_, K, V> {
                fn drop(&mut self) {
                    let mut running = self
                        .0
                        .running
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    running.remove(self.1);
                }
            }
            let _leave = Leave(self, &key);
            let value = run();
            *answer = Some(value.clone());
            return value;
        };
        drop(answer);
        let theirs = other.lock().unwrap_or_else(PoisonError::into_inner).clone();
        theirs.unwrap_or_else(run)
    }

    /// How many calls wait for the answer of the run for `key`.
    #[cfg(test)]
    fn waiting(&self, key: &K) -> usize {
        self.running()
            .get(key)
            .map_or(0, |slot| Arc::strong_count(slot) - 2)
    }
}

/// `worktree_host` for the reads of A-18, with the project key of the worktree: the answer of an earlier one for the same path of the same target is used for `HOST_TTL`, so a folder is not read after a start of the CLI. Nothing is believed that the target's list did not hold when it was asked: the path is checked as it is by `worktree_confirmation`, and the cache holds only what that returned.
/// The reads that find nothing believed at the same time (the clock reads the tree and each tab shown together) confirm once: the first one asks the list, and the others wait for its answer, a refusal included.
pub(crate) fn worktree_host_cached(
    path: &str,
    environment: Option<&str>,
) -> Result<(String, String), String> {
    type Confirming = Flights<(Option<String>, String), Result<(String, String), String>>;
    static CONFIRMING: OnceLock<Confirming> = OnceLock::new();
    check_path(path)?;
    if let Some(confirmed) = worktree_hosts().get(environment, path, Instant::now()) {
        return Ok(confirmed);
    }
    CONFIRMING
        .get_or_init(Flights::default)
        .run(WorktreeHosts::key(environment, path), || {
            // A confirmation that ended between the look above and this run is the one to believe.
            if let Some(confirmed) = worktree_hosts().get(environment, path, Instant::now()) {
                return Ok(confirmed);
            }
            let (host_id, project) = worktree_confirmation(path, environment)?;
            worktree_hosts().put(environment, path, (&host_id, &project), Instant::now());
            Ok((host_id, project))
        })
}

/// Throws away what was confirmed for `path` of the target: a call made with it failed, so the next one asks the list again.
pub(crate) fn forget_worktree_host(path: &str, environment: Option<&str>) {
    worktree_hosts().forget(environment, path);
}

/// Hands the content to a new session (A-9): the prompt is composed here from the instruction the user wrote, the attached files, the content with its summary inside the block, then the launch of A-6 runs once with its checks.
fn handoff(
    destination: &OrcaDestination,
    instruction: &str,
    files: &[String],
    summary: &[String],
    context: Option<&HandoffContext>,
    environment: Option<&str>,
) -> Result<OrcaStarted, String> {
    let text = compose(&handoff_instruction(instruction, files)?, summary, context)?;
    let OrcaDestination::New { path } = destination;
    launch(path, Some(&text), environment)
}

/// Closes the tab of an Orca terminal; `ptyKilled` is not looked at. When the close of the tab answers `terminal_handle_stale` (which Orca also answers for a terminal that runs), the terminal is closed again with no `--tab`, once; any failure of that, `terminal_handle_stale` too, is an error, and the tab stays.
fn close(handle: &str, environment: Option<&str>) -> Result<(), String> {
    check_handle(handle)?;
    check_listed(environment)?;
    let out = run(&close_args(handle, environment), READ_TIMEOUT).map_err(message_of)?;
    if after_tab_close(&out)? == AfterTabClose::Done {
        return Ok(());
    }
    let out = run(&close_plain_args(handle, environment), READ_TIMEOUT).map_err(message_of)?;
    parse_output(&out).map(|_| ())
}

/// The terminals (a handle in this machine's Orca, or in a saved environment) that were checked against the list of their target, so only the first read or input of a terminal reads the list. A terminal leaves when a read or a send of it fails.
#[derive(Default, Clone)]
pub struct OrcaMirror(Arc<Mutex<HashSet<MirrorKey>>>);

/// The saved environment (none for this machine) and the handle of a terminal.
type MirrorKey = (Option<String>, String);

impl OrcaMirror {
    fn key(handle: &str, environment: Option<&str>) -> MirrorKey {
        (environment.map(str::to_owned), handle.to_owned())
    }

    fn knows(&self, handle: &str, environment: Option<&str>) -> bool {
        self.0
            .lock()
            .unwrap()
            .contains(&Self::key(handle, environment))
    }

    fn remember(&self, handle: &str, environment: Option<&str>) {
        self.0
            .lock()
            .unwrap()
            .insert(Self::key(handle, environment));
    }

    fn forget(&self, handle: &str, environment: Option<&str>) {
        self.0
            .lock()
            .unwrap()
            .remove(&Self::key(handle, environment));
    }
}

/// Checks that `handle` is a terminal (a Claude session's or a plain one) of the list of its target (this machine, or the saved environment `environment`) read just now, unless an earlier read or input of it did. A saved environment must be one of the saved ones.
fn check_mirrored(
    mirror: &OrcaMirror,
    handle: &str,
    environment: Option<&str>,
) -> Result<(), String> {
    check_handle(handle)?;
    if !mirror.knows(handle, environment) {
        check_listed(environment)?;
        let (ps, terminals) = read_lists(environment, true);
        let (ps, terminals) = (ps.map_err(message_of)?, terminals.map_err(message_of)?);
        let rows = rows_of(&ps, &terminals);
        check_terminal(&rows, &plain_terminals_of(&ps, &terminals, &rows), handle)?;
        mirror.remember(handle, environment);
    }
    Ok(())
}

/// The lines on the screen of a terminal for its mirror: of this machine over the unix socket (no CLI process is started; read once a second while its tab is shown), of a saved environment through the CLI (one process for each read, every 2 seconds). The list is read only the first time.
fn screen(
    mirror: &OrcaMirror,
    handle: &str,
    environment: Option<&str>,
) -> Result<Vec<String>, String> {
    check_mirrored(mirror, handle, environment)?;
    read_lines(handle, environment).inspect_err(|_| mirror.forget(handle, environment))
}

/// The params of `terminal.send`, as the CLI sends them: no `enter`, so control bytes reach the terminal as typed. `client` names this app (A-12 gives the id its stream subscribed with). With a `viewport` (the pane's size, A-12) the send claims that size again, as Orca's own screen does at every key.
pub(crate) fn input_params(
    handle: &str,
    text: &str,
    client: &str,
    viewport: Option<OrcaViewport>,
) -> Value {
    let mut params = serde_json::json!({
        "terminal": handle,
        "text": text,
        "enter": false,
        "client": {"id": client, "type": "desktop"},
    });
    if let Some(v) = viewport.map(clamp_viewport) {
        params["viewport"] = serde_json::json!({"cols": v.cols, "rows": v.rows});
        params["claimViewport"] = true.into();
    }
    params
}

/// The URL a ⌘+click in a terminal opens (A-8): an `http` or `https` URL with a host, read again by the `url` crate, so what reaches the browser is the parsed form and never another scheme.
fn browser_url(raw: &str) -> Result<String, String> {
    let url =
        url::Url::parse(raw).map_err(|_| "開けるのは http か https の URL だけです".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("開けるのは http か https の URL だけです".into());
    }
    Ok(url.into())
}

/// Opens the URL of a link that was ⌘+clicked in a terminal (A-8, A-12) in the default browser. Nothing else is opened.
#[tauri::command]
pub fn orca_open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = browser_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("ブラウザを開けません: {e}"))
}

/// Checks the keys and the terminal.
fn check_input(
    mirror: &OrcaMirror,
    handle: &str,
    environment: Option<&str>,
    text: &str,
) -> Result<(), String> {
    check_handle(handle)?;
    check_keys(text)?;
    check_mirrored(mirror, handle, environment)
}

/// The SSH hosts of this machine's Orca, from its runtime (not a public interface: it was written against Orca 1.4.248). A failure is an empty list.
pub(crate) async fn local_ssh_targets() -> Vec<OrcaSshTarget> {
    crate::orca_link::local_call("ssh.listEditableTargets", serde_json::json!({}))
        .await
        .map(|result| ssh_targets_of(&result))
        .unwrap_or_default()
}

fn set_target(dir: &Path, environment: Option<&str>) -> Result<(), String> {
    check_listed(environment)?;
    save_target(dir, environment)
}

pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

/// The agents of the Orca in use and the worktrees to start one in. `target` is the one the screen holds, used by every scope but `Full`.
#[tauri::command]
pub async fn orca_overview(
    app: tauri::AppHandle,
    scope: OrcaScope,
    target: Option<String>,
) -> Result<OrcaOverview, String> {
    let dir = config_dir(&app)?;
    if scope != OrcaScope::Full {
        return blocking(move || overview(&dir, scope, target)).await;
    }
    // The SSH hosts are read with the environments only, side by side with the CLI.
    let (view, ssh) = tokio::join!(
        blocking(move || overview(&dir, scope, target)),
        local_ssh_targets()
    );
    let mut view = view?;
    if view.known {
        view.ssh = ssh;
    }
    Ok(view)
}

/// A-9: the lists of the destination the side pane chose (`None`: this machine, else a saved environment's name, which is checked against the saved ones). It does not touch the target the Orca screen holds.
/// `force` is false only for the poll of a shown session, which skips the check (and the saved environments in the answer) for the destination it checked just before.
#[tauri::command]
pub async fn orca_destination(
    environment: Option<String>,
    force: bool,
) -> Result<OrcaOverview, String> {
    blocking(move || destination_overview(environment.as_deref(), force)).await
}

/// Saves the Orca to talk to: a saved environment's name, or `None` for this machine.
#[tauri::command]
pub async fn orca_set_target(
    app: tauri::AppHandle,
    environment: Option<String>,
) -> Result<(), String> {
    let dir = config_dir(&app)?;
    blocking(move || set_target(&dir, environment.as_deref())).await?
}

/// Sends `text` and Enter to the terminal `handle`.
#[tauri::command]
pub async fn orca_send(
    handle: String,
    text: String,
    environment: Option<String>,
) -> Result<(), String> {
    blocking(move || send(&handle, &text, environment.as_deref())).await?
}

/// Starts Claude in the worktree at `path` with no first prompt (the plus of the work pane, A-16). The answer is the session as Orca's reply names it.
#[tauri::command]
pub async fn orca_start(path: String, environment: Option<String>) -> Result<OrcaStarted, String> {
    blocking(move || launch(&path, None, environment.as_deref())).await?
}

/// Opens a plain terminal in the worktree at `path` (the plus of the work pane, A-16). The answer is the terminal as Orca's reply names it (its `handle`; no pane key).
#[tauri::command]
pub async fn orca_terminal_create(
    path: String,
    environment: Option<String>,
) -> Result<OrcaStarted, String> {
    blocking(move || open_terminal(&path, environment.as_deref())).await?
}

/// A-9: makes a new worktree named `name` in the project `project` (a repository key of the list) of the destination, and answers its path. Never run twice.
/// `branch` (the branch the worktree gets) and `base` (the ref it starts from) are passed to the CLI only when given.
#[tauri::command]
pub async fn orca_worktree_create(
    project: String,
    name: String,
    branch: Option<String>,
    base: Option<String>,
    environment: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        create_worktree(
            &project,
            &name,
            branch.as_deref(),
            base.as_deref(),
            environment.as_deref(),
        )
    })
    .await?
}

/// A-9: starts a session in a worktree with the instruction the user wrote (`instruction`), the text of each attached file (`files`, A-10), and, when `context` is given, the content quoted as data with the summary of it (`summary`) inside the block.
#[tauri::command]
pub async fn orca_handoff(
    destination: OrcaDestination,
    instruction: String,
    files: Vec<String>,
    summary: Vec<String>,
    context: Option<HandoffContext>,
    environment: Option<String>,
) -> Result<OrcaStarted, String> {
    blocking(move || {
        handoff(
            &destination,
            &instruction,
            &files,
            &summary,
            context.as_ref(),
            environment.as_deref(),
        )
    })
    .await?
}

/// Closes the tab of the Orca terminal `handle` (a Claude session or a plain terminal).
#[tauri::command]
pub async fn orca_close(handle: String, environment: Option<String>) -> Result<(), String> {
    blocking(move || close(&handle, environment.as_deref())).await?
}

/// The lines on the screen of the terminal `handle` of this machine, or of the saved environment `environment`, for the mirror.
#[tauri::command]
pub async fn orca_terminal_read(
    mirror: tauri::State<'_, OrcaMirror>,
    handle: String,
    environment: Option<String>,
) -> Result<Vec<String>, String> {
    let mirror = mirror.inner().clone();
    blocking(move || screen(&mirror, &handle, environment.as_deref())).await?
}

/// One `terminal.send` over the WebSocket of a saved environment; a send Orca did not take is a failure.
async fn send_keys(
    link: &mut crate::orca_link::WsLink,
    handle: &str,
    text: &str,
) -> Result<(), String> {
    let result = link
        .request(
            "terminal.send",
            input_params(handle, text, "cookapps", None),
        )
        .await
        .map_err(crate::orca_link::reason_of)?;
    check_accepted(&result)
}

/// Types `text` into the terminal `handle` as it is, as `terminal.send`: of this machine over its unix socket, of the saved environment `environment` over a WebSocket of its own, so the keys are in no argument of a process.
#[tauri::command]
pub async fn orca_terminal_input(
    mirror: tauri::State<'_, OrcaMirror>,
    handle: String,
    text: String,
    environment: Option<String>,
) -> Result<(), String> {
    let mirror = mirror.inner().clone();
    {
        let (mirror, handle, text, environment) = (
            mirror.clone(),
            handle.clone(),
            text.clone(),
            environment.clone(),
        );
        blocking(move || check_input(&mirror, &handle, environment.as_deref(), &text)).await??;
    }
    let sent = match environment.clone() {
        None => crate::orca_link::local_call(
            "terminal.send",
            input_params(&handle, &text, "cookapps", None),
        )
        .await
        .and_then(|result| check_accepted(&result)),
        Some(name) => match crate::orca_link::connect_environment(name).await {
            Ok(mut link) => send_keys(&mut link, &handle, &text).await,
            Err(reason) => Err(reason),
        },
    };
    if sent.is_err() {
        mirror.forget(&handle, environment.as_deref());
    }
    sent
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn agent(pane: &str, state: &str) -> Value {
        json!({
            "paneKey": pane, "parentPaneKey": null, "hasLivePty": true, "state": state,
            "agentType": "claude", "prompt": "Write the docs\nsecond line",
            "stateStartedAt": 2_000, "updatedAt": 3_000,
        })
    }

    fn ps(agents: &[Value]) -> Value {
        json!({"worktrees": [{
            "path": "/work/example", "repo": "example", "repoId": "repo1", "displayName": "feat/a",
            "agents": agents,
        }]})
    }

    fn terminals() -> Value {
        json!({"terminals": [
            {"handle": "term_1", "tabId": "tabA", "leafId": "leaf1"},
            {"handle": "term_2", "tabId": "tabB", "leafId": "leaf2"},
        ]})
    }

    #[test]
    fn a_link_to_open_is_an_http_or_https_url_read_again() {
        assert_eq!(
            browser_url("https://example.com/docs?q=1#top").unwrap(),
            "https://example.com/docs?q=1#top"
        );
        assert_eq!(
            browser_url("http://example.com").unwrap(),
            "http://example.com/"
        );
        assert_eq!(
            browser_url("HTTPS://Example.COM/A").unwrap(),
            "https://example.com/A"
        );
        assert_eq!(
            browser_url("http://localhost:3000/").unwrap(),
            "http://localhost:3000/"
        );
        assert_eq!(
            browser_url("https://example.com/日本語").unwrap(),
            "https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E"
        );
    }

    #[test]
    fn a_link_that_is_not_http_or_https_is_refused() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
            "ssh://example.com",
            "mailto:me@example.com",
            "data:text/html,x",
            "x-apple.systempreferences:com.apple.preference",
            "",
            "example.com",
            "/usr/bin/open",
            "https://",
        ] {
            assert!(browser_url(raw).is_err(), "{raw} was accepted");
        }
    }

    #[test]
    fn a_row_has_the_names_the_time_and_the_terminal() {
        let rows = rows_of(&ps(&[agent("tabA:leaf1", "working")]), &terminals());
        assert_eq!(
            rows,
            [OrcaRow {
                group: OrcaGroup::Working,
                repo: "example".into(),
                branch: "feat/a".into(),
                line: "Write the docs".into(),
                at_ms: 2_000,
                handle: Some("term_1".into()),
                pane_key: Some("tabA:leaf1".into()),
                path: "/work/example".into(),
                status: OrcaStatus::Working,
                project_key: "repo1".into(),
                environment: None,
            }]
        );
    }

    #[test]
    fn only_top_level_agents_of_a_live_terminal_are_kept() {
        let mut sub = agent("tabA:leaf1", "working");
        sub["parentPaneKey"] = json!("tabA:leaf0");
        let mut dead = agent("tabB:leaf2", "working");
        dead["hasLivePty"] = json!(false);
        let mut unknown = agent("tabB:leaf2", "working");
        unknown.as_object_mut().unwrap().remove("hasLivePty");
        let kept = agent("tabB:leaf2", "working");
        let rows = rows_of(&ps(&[sub, dead, unknown, kept]), &terminals());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].handle.as_deref(), Some("term_2"));
    }

    #[test]
    fn the_state_decides_the_group() {
        for (state, group) in [
            ("working", OrcaGroup::Working),
            ("waiting", OrcaGroup::Waiting),
            ("blocked", OrcaGroup::Waiting),
            ("permission", OrcaGroup::Waiting),
            ("done", OrcaGroup::Done),
            ("something-new", OrcaGroup::Working),
            ("", OrcaGroup::Working),
        ] {
            let rows = rows_of(&ps(&[agent("tabA:leaf1", state)]), &terminals());
            assert_eq!(rows[0].group, group, "{state}");
        }
        let mut no_state = agent("tabA:leaf1", "working");
        no_state.as_object_mut().unwrap().remove("state");
        assert_eq!(
            rows_of(&ps(&[no_state]), &terminals())[0].group,
            OrcaGroup::Working
        );
    }

    #[test]
    fn the_time_is_the_state_start_for_a_live_agent_and_the_update_for_a_done_one() {
        for (state, at) in [
            ("working", 2_000),
            ("waiting", 2_000),
            ("blocked", 2_000),
            ("done", 3_000),
        ] {
            let rows = rows_of(&ps(&[agent("tabA:leaf1", state)]), &terminals());
            assert_eq!(rows[0].at_ms, at, "{state}");
        }
    }

    #[test]
    fn the_line_takes_the_prompt_then_the_task_the_conversation_and_the_last_answer() {
        let mut a = agent("tabA:leaf1", "working");
        a["taskTitle"] = json!("Task\nsecond");
        a["conversationName"] = json!("Conversation");
        a["lastAssistantMessage"] = json!("\nAnswer\nmore");
        assert_eq!(line_of(&a, None), "Write the docs");
        a["prompt"] = json!("\n\n  \nfirst real line\nnext");
        assert_eq!(line_of(&a, None), "first real line");
        a["prompt"] = json!("  ");
        assert_eq!(line_of(&a, None), "Task");
        a["taskTitle"] = json!(" ");
        assert_eq!(line_of(&a, None), "Conversation");
        a["conversationName"] = Value::Null;
        assert_eq!(line_of(&a, None), "Answer");
        a.as_object_mut().unwrap().remove("lastAssistantMessage");
        assert_eq!(line_of(&a, None), "");
    }

    #[test]
    fn a_status_mark_and_its_space_are_taken_off_the_front_of_a_terminal_title() {
        for (title, line) in [
            ("◑ 題名", "題名"),
            ("✳ Claude Code", "Claude Code"),
            ("⠂ Fix the list", "Fix the list"),
            ("◑  two spaces", "two spaces"),
            ("題名", "題名"),
            ("Plain title", "Plain title"),
            ("1 first", "1 first"),
            ("「括弧」 題名", "「括弧」 題名"),
            ("◑題名", "◑題名"),
            ("◑ ◑ twice", "◑ twice"),
            ("◑", "◑"),
            ("", ""),
        ] {
            assert_eq!(without_status_mark(title), line, "{title}");
        }
    }

    #[test]
    fn the_line_falls_back_to_the_title_of_the_terminal_of_the_pane() {
        let mut a = agent("tabA:leaf1", "done");
        let obj = a.as_object_mut().unwrap();
        obj.remove("prompt");
        let titled = |title: &str| {
            json!({"terminals": [
                {"handle": "term_1", "tabId": "tabA", "leafId": "leaf1", "title": title},
                {"handle": "term_2", "tabId": "tabB", "leafId": "leaf2", "title": "◑ other pane"},
            ]})
        };
        let line = |a: &Value, terminals: &Value| {
            rows_of(&ps(std::slice::from_ref(a)), terminals)[0]
                .line
                .clone()
        };
        assert_eq!(
            line(&a, &titled("◑ Terminal title\nsecond")),
            "Terminal title"
        );
        assert_eq!(line(&a, &titled("Terminal title")), "Terminal title");
        assert_eq!(line(&a, &titled("  ")), "");
        assert_eq!(line(&a, &terminals()), "");
        assert_eq!(line(&a, &json!({"terminals": []})), "");
        a["lastAssistantMessage"] = json!("Answer");
        assert_eq!(line(&a, &titled("◑ Terminal title")), "Answer");
        a["prompt"] = json!("Prompt");
        assert_eq!(line(&a, &titled("◑ Terminal title")), "Prompt");
    }

    #[test]
    fn the_line_of_an_orphaned_terminal_pane_falls_back_to_its_title() {
        let mut a = agent("tabA:leaf1", "done");
        a.as_object_mut().unwrap().remove("prompt");
        let terminals = json!({"terminals": [{
            "handle": "term_9", "orphaned": true, "agentIdentity": "claude",
            "recordedPaneKey": "tabA:leaf1", "title": "✳ Orphan title",
        }]});
        assert_eq!(rows_of(&ps(&[a]), &terminals)[0].line, "Orphan title");
    }

    #[test]
    fn the_line_is_the_same_whatever_the_state_and_names_no_tool() {
        let mut a = agent("tabA:leaf1", "working");
        a["toolName"] = json!("Bash");
        a["lastAssistantMessage"] = json!("Old answer");
        for state in ["working", "waiting", "blocked", "done"] {
            a["state"] = json!(state);
            let rows = rows_of(&ps(&[a.clone()]), &terminals());
            assert_eq!(rows[0].line, "Write the docs", "{state}");
        }
    }

    #[test]
    fn a_long_line_is_cut() {
        let mut a = agent("tabA:leaf1", "working");
        a["prompt"] = json!("あ".repeat(LINE_LIMIT + 50));
        assert_eq!(line_of(&a, None).chars().count(), LINE_LIMIT);
    }

    #[test]
    fn rows_are_newest_first_across_groups() {
        let mut old = agent("tabA:leaf1", "done");
        old["updatedAt"] = json!(1_000);
        let mut new = agent("tabB:leaf2", "working");
        new["updatedAt"] = json!(9_000);
        let mut middle = agent("tabX:leafX", "waiting");
        middle["updatedAt"] = json!(5_000);
        let rows = rows_of(&ps(&[old, new, middle]), &terminals());
        let groups: Vec<_> = rows.iter().map(|r| r.group).collect();
        assert_eq!(
            groups,
            [OrcaGroup::Working, OrcaGroup::Waiting, OrcaGroup::Done]
        );
    }

    #[test]
    fn an_orphaned_terminal_is_found_by_the_pane_it_recorded() {
        let orphan = |handle: &str, pane: Option<&str>| {
            let mut t = json!({"handle": handle, "tabId": "pty:p", "leafId": "pty:p", "orphaned": true, "agentIdentity": "claude"});
            if let Some(pane) = pane {
                t["recordedPaneKey"] = json!(pane);
            }
            t
        };
        let handle_of = |list: Value| {
            rows_of(
                &ps(&[agent("tabA:leaf1", "working")]),
                &json!({"terminals": list}),
            )[0]
            .handle
            .clone()
        };
        assert_eq!(
            handle_of(json!([orphan("term_o", Some("tabA:leaf1"))])).as_deref(),
            Some("term_o")
        );
        // A live terminal of the pane comes first, wherever it is in the list.
        assert_eq!(
            handle_of(json!([
                orphan("term_o", Some("tabA:leaf1")),
                {"handle": "term_1", "tabId": "tabA", "leafId": "leaf1"},
            ]))
            .as_deref(),
            Some("term_1")
        );
        // An orphan of another pane, or one that recorded none, is not this agent's.
        assert_eq!(
            handle_of(json!([orphan("term_o", Some("tabZ:leafZ"))])),
            None
        );
        assert_eq!(handle_of(json!([orphan("term_o", None)])), None);
        // One that Orca does not say is Claude's may be a shell.
        let mut shell = orphan("term_o", Some("tabA:leaf1"));
        shell["agentIdentity"] = Value::Null;
        assert_eq!(handle_of(json!([shell])), None);
        // Two of the same pane cannot be told apart.
        assert_eq!(
            handle_of(json!([
                orphan("term_o", Some("tabA:leaf1")),
                orphan("term_p", Some("tabA:leaf1")),
            ])),
            None
        );
    }

    #[test]
    fn an_agent_without_a_matching_terminal_has_no_handle() {
        let rows = rows_of(
            &ps(&[
                agent("tabZ:leafZ", "working"),
                json!({"parentPaneKey": null, "hasLivePty": true, "state": "working", "agentType": "claude"}),
            ]),
            &terminals(),
        );
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.handle.is_none()));
        // Terminals with missing ids are skipped, not an error.
        let broken =
            json!({"terminals": [{"handle": "term_1"}, {"tabId": "tabA", "leafId": "leaf1"}, 7]});
        assert!(rows_of(&ps(&[agent("tabA:leaf1", "working")]), &broken)[0]
            .handle
            .is_none());
    }

    #[test]
    fn missing_or_odd_fields_are_tolerated() {
        for doc in [
            Value::Null,
            json!({}),
            json!({"worktrees": null}),
            json!({"worktrees": [null, 3, {"agents": "x"}, {"agents": [null, 5]}]}),
        ] {
            assert!(rows_of(&doc, &Value::Null).is_empty(), "{doc}");
            assert!(worktrees_of(&doc).is_empty(), "{doc}");
        }
        let bare = json!({"worktrees": [{"agents": [{
            "parentPaneKey": null, "hasLivePty": true,
            "updatedAt": "soon", "stateStartedAt": null, "agentType": "claude",
        }]}]});
        let rows = rows_of(&bare, &terminals());
        assert_eq!(
            rows,
            [OrcaRow {
                group: OrcaGroup::Working,
                repo: String::new(),
                branch: String::new(),
                line: String::new(),
                at_ms: 0,
                handle: None,
                pane_key: None,
                path: String::new(),
                status: OrcaStatus::Working,
                project_key: String::new(),
                environment: None,
            }]
        );
    }

    #[test]
    fn only_claude_agents_are_rows() {
        let mut codex = agent("tabA:leaf1", "working");
        codex["agentType"] = json!("codex");
        let mut unknown = agent("tabB:leaf2", "working");
        unknown.as_object_mut().unwrap().remove("agentType");
        let mut typed = agent("tabB:leaf2", "working");
        typed["agentType"] = json!(4);
        assert!(rows_of(&ps(&[codex, unknown, typed]), &terminals()).is_empty());
    }

    #[test]
    fn a_row_carries_the_pane_and_the_worktree_path_even_without_a_terminal() {
        let rows = rows_of(&ps(&[agent("tabZ:leafZ", "working")]), &terminals());
        assert_eq!(rows[0].handle, None);
        assert_eq!(rows[0].pane_key.as_deref(), Some("tabZ:leafZ"));
        assert_eq!(rows[0].path, "/work/example");
    }

    #[test]
    fn every_worktree_with_a_path_is_a_launch_target() {
        let doc = json!({"worktrees": [
            {"path": "/work/a", "repo": "a", "repoId": "repo-a", "displayName": "main", "branch": "refs/heads/main", "isMainWorktree": true, "agents": []},
            {"repo": "no-path", "displayName": "x"},
            {"path": "/work/b", "repo": "b", "branch": ""},
            {"path": "/ssh/c", "repo": "c", "repoId": "repo-c", "hostId": "box", "displayName": "dev", "branch": "refs/heads/feat/dev"},
            {"path": "/work/d", "repo": "d", "displayName": "fix-login", "branch": "refs/heads/feat/x"},
            {"path": "/work/e", "repo": "e", "displayName": "e", "branch": "HEAD"},
        ]});
        // Each carries the key of its project (A-16): the repository on this machine, `ssh:{hostId}` on a host, empty when a repository has no id.
        assert_eq!(
            worktrees_of(&doc),
            [
                OrcaWorktree {
                    path: "/work/a".into(),
                    repo: "a".into(),
                    branch: "main".into(),
                    git_branch: "main".into(),
                    project_key: "repo-a".into(),
                    is_main: true,
                    environment: None,
                },
                OrcaWorktree {
                    path: "/work/b".into(),
                    repo: "b".into(),
                    branch: String::new(),
                    git_branch: String::new(),
                    project_key: String::new(),
                    is_main: false,
                    environment: None,
                },
                OrcaWorktree {
                    path: "/ssh/c".into(),
                    repo: "c".into(),
                    branch: "dev".into(),
                    git_branch: "feat/dev".into(),
                    project_key: "ssh:box".into(),
                    is_main: false,
                    environment: None,
                },
                // A worktree made with a name keeps it as `displayName`, so the git branch is read from `branch`.
                OrcaWorktree {
                    path: "/work/d".into(),
                    repo: "d".into(),
                    branch: "fix-login".into(),
                    git_branch: "feat/x".into(),
                    project_key: String::new(),
                    is_main: false,
                    environment: None,
                },
                // A `branch` that is not `refs/heads/...` is not a local branch.
                OrcaWorktree {
                    path: "/work/e".into(),
                    repo: "e".into(),
                    branch: "e".into(),
                    git_branch: String::new(),
                    project_key: String::new(),
                    is_main: false,
                    environment: None,
                },
            ]
        );
    }

    #[test]
    fn environments_are_read_from_names_or_objects() {
        assert!(environments_of(&json!({"environments": []})).is_empty());
        assert!(environments_of(&Value::Null).is_empty());
        let doc = json!({"environments": [
            {"id": "env-1", "name": "Studio"}, {"id": "env-2"}, "Plain", {"name": " "}, 5, null, ""
        ]});
        assert_eq!(environments_of(&doc), ["Studio", "env-2", "Plain"]);
    }

    #[test]
    fn the_output_gives_its_result_or_the_error_message() {
        let ok = r#"{"ok": true, "result": {"a": 1}}"#;
        assert_eq!(parse_output(ok).unwrap(), json!({"a": 1}));
        assert_eq!(parse_output(r#"{"ok": true}"#).unwrap(), Value::Null);
        let err = r#"{"ok": false, "error": {"code": "not_found", "message": "No such terminal"}}"#;
        assert_eq!(parse_output(err).unwrap_err(), "No such terminal");
        let code_only = r#"{"ok": false, "error": {"code": "runtime_unavailable"}}"#;
        assert_eq!(parse_output(code_only).unwrap_err(), "runtime_unavailable");
        assert_eq!(
            parse_output(r#"{"ok": false}"#).unwrap_err(),
            "Orca の操作に失敗しました"
        );
        assert_eq!(
            parse_output(r#"{"result": {}}"#).unwrap_err(),
            "Orca の操作に失敗しました"
        );
        assert_eq!(
            parse_output("not json").unwrap_err(),
            "Orca の出力を読めません"
        );
        assert!(parse_output(" \n")
            .unwrap_err()
            .contains("応答がありません"));
    }

    #[test]
    fn the_cli_is_looked_for_at_absolute_places() {
        let places = locations();
        assert_eq!(places.len(), 2);
        assert!(places.iter().all(|p| p.is_absolute()));
    }

    #[test]
    fn text_must_be_filled_and_within_the_limit() {
        assert!(check_text("hello").is_ok());
        assert!(check_text(&"あ".repeat(TEXT_LIMIT)).is_ok());
        assert!(check_text("").is_err());
        assert!(check_text(" \n\t").is_err());
        // Characters are counted, not bytes.
        assert!(check_text(&"あ".repeat(TEXT_LIMIT + 1))
            .unwrap_err()
            .contains("100000"));
    }

    #[test]
    fn a_handle_is_term_and_an_id() {
        assert!(check_handle("term_1b7c4be1-bb60-4450-9d19-26885731499f").is_ok());
        assert!(check_handle("term_a_B-9").is_ok());
        for bad in [
            "", "term_", "terminal", "1b7c", "--json", "term_a b", "term_a=b", "term_a;b",
            "term_é", "xterm_1",
        ] {
            assert!(check_handle(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_pane_key_has_only_the_characters_of_an_id() {
        for ok in ["tabA:leaf1", "a1b2c3d4-e5f6-7890:leaf_2", &"a".repeat(256)] {
            assert!(check_pane_key(ok).is_ok(), "{ok}");
        }
        for bad in ["", "a b", "a;b", "a/b", "--x y", "é", &"a".repeat(257)] {
            assert!(check_pane_key(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_worktree_path_is_absolute() {
        assert!(check_path("/Users/example/work").is_ok());
        for bad in ["", "work", "./work", "--json", "~/work"] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_host_of_a_worktree_is_the_host_id_orca_names() {
        let host_id_of = |ps: &Value, path: &str| confirmed_of(ps, path).map(|c| c.0);
        let ps = json!({"worktrees": [
            {"path": "/work/a", "hostId": "local"},
            {"path": "/work/b", "hostId": "ssh:lab"},
            {"path": "/work/c"},
            {"path": "/work/d", "hostId": "  "},
        ]});
        assert_eq!(host_id_of(&ps, "/work/a").as_deref(), Some("local"));
        assert_eq!(host_id_of(&ps, "/work/b").as_deref(), Some("ssh:lab"));
        // No `hostId` is not taken for this machine here: the upload fails.
        for none in ["/work/c", "/work/d", "/work/x", ""] {
            assert_eq!(host_id_of(&ps, none), None, "{none}");
        }
        assert_eq!(host_id_of(&Value::Null, "/work/a"), None);
    }

    #[test]
    fn the_project_of_a_confirmed_worktree_is_its_key_in_the_list() {
        let ps = json!({"worktrees": [
            {"path": "/work/a", "hostId": "local", "repoId": "repo-1"},
            {"path": "/work/b", "hostId": "lab"},
            {"path": "/work/c", "hostId": "local"},
        ]});
        let of = |path| confirmed_of(&ps, path);
        assert_eq!(of("/work/a"), Some(("local".into(), "repo-1".into())));
        assert_eq!(of("/work/b"), Some(("lab".into(), "ssh:lab".into())));
        assert_eq!(of("/work/c"), Some(("local".into(), String::new())));
        assert_eq!(of("/work/x"), None);
        let t0 = Instant::now();
        let mut hosts = WorktreeHosts::default();
        hosts.put(None, "/work/a", ("local", "repo-0"), t0);
        assert_eq!(
            hosts.get(None, "/work/a", t0),
            Some(("local".into(), "repo-0".into()))
        );
        // A list read again names the project now, and the cache takes it.
        hosts.sync(None, &ps);
        assert_eq!(
            hosts.get(None, "/work/a", t0),
            Some(("local".into(), "repo-1".into()))
        );
    }

    #[test]
    fn a_confirmed_worktree_is_believed_for_its_target_and_path_until_the_time_is_up() {
        let t0 = Instant::now();
        let mut hosts = WorktreeHosts::default();
        assert_eq!(hosts.get(None, "/work/a", t0), None);
        hosts.put(None, "/work/a", ("local", "repo"), t0);
        hosts.put(Some("Studio"), "/work/a", ("env-1", "repo"), t0);
        assert_eq!(
            hosts.get(None, "/work/a", t0).map(|c| c.0).as_deref(),
            Some("local")
        );
        assert_eq!(
            hosts
                .get(Some("Studio"), "/work/a", t0)
                .map(|c| c.0)
                .as_deref(),
            Some("env-1")
        );
        // Another target, and a path that differs in any way, is not the one confirmed.
        assert_eq!(hosts.get(Some("Lab"), "/work/a", t0), None);
        for other in ["/work/a/", "/work/A", "/work/b", "/work/a/..", ""] {
            assert_eq!(hosts.get(None, other, t0), None, "{other}");
        }
        let almost = t0 + HOST_TTL - Duration::from_millis(1);
        assert_eq!(
            hosts.get(None, "/work/a", almost).map(|c| c.0).as_deref(),
            Some("local")
        );
        assert_eq!(hosts.get(None, "/work/a", t0 + HOST_TTL), None);
        assert_eq!(hosts.get(None, "/work/a", t0 + HOST_TTL * 2), None);
    }

    /// Waits until `n` calls wait for the answer of the one that runs for `key`.
    fn wait_for_waiting(flights: &Flights<&'static str, u32>, key: &'static str, n: usize) {
        let end = Instant::now() + Duration::from_secs(10);
        while flights.waiting(&key) != n {
            assert!(Instant::now() < end, "{n} calls never waited");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn calls_for_the_same_key_at_the_same_time_run_once_and_share_the_answer() {
        let flights = Flights::<&'static str, u32>::default();
        let flights = &flights;
        let runs = std::sync::atomic::AtomicU32::new(0);
        let (started, has_started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let run = || runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let answers = std::thread::scope(|scope| {
            let first = scope.spawn(move || {
                flights.run("a", || {
                    started.send(()).unwrap();
                    released.recv().unwrap();
                    run()
                })
            });
            has_started.recv().unwrap();
            let later: Vec<_> = (0..3)
                .map(|_| scope.spawn(move || flights.run("a", run)))
                .collect();
            wait_for_waiting(flights, "a", 3);
            // Another key does not wait for it, and runs its own.
            assert_eq!(flights.run("b", || 100), 100);
            release.send(()).unwrap();
            let mut answers = vec![first.join().unwrap()];
            answers.extend(later.into_iter().map(|t| t.join().unwrap()));
            answers
        });
        assert_eq!(answers, [1, 1, 1, 1]);
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
        // The answer is kept for the calls that waited only: the next call runs again.
        assert_eq!(flights.waiting(&"a"), 0);
        assert_eq!(flights.run("a", run), 2);
    }

    #[test]
    fn a_call_that_waited_for_one_that_panicked_runs_its_own() {
        let flights = Flights::<&'static str, u32>::default();
        let flights = &flights;
        let (started, has_started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        std::thread::scope(|scope| {
            let first = scope.spawn(move || {
                flights.run("a", || {
                    started.send(()).unwrap();
                    released.recv().unwrap();
                    panic!("the run failed")
                })
            });
            has_started.recv().unwrap();
            let later = scope.spawn(move || flights.run("a", || 7));
            wait_for_waiting(flights, "a", 1);
            release.send(()).unwrap();
            assert!(first.join().is_err());
            assert_eq!(later.join().unwrap(), 7);
        });
        // Nothing of the failed run is left to wait for.
        assert_eq!(flights.waiting(&"a"), 0);
        assert_eq!(flights.run("a", || 8), 8);
    }

    #[test]
    fn a_failed_call_makes_the_worktree_be_confirmed_again() {
        let t0 = Instant::now();
        let mut hosts = WorktreeHosts::default();
        hosts.put(None, "/work/a", ("local", "repo"), t0);
        hosts.put(Some("Studio"), "/work/a", ("env-1", "repo"), t0);
        hosts.forget(None, "/work/a");
        assert_eq!(hosts.get(None, "/work/a", t0), None);
        assert!(hosts.get(Some("Studio"), "/work/a", t0).is_some());
    }

    #[test]
    fn a_list_read_again_drops_the_worktrees_it_lacks_and_renews_no_time() {
        let t0 = Instant::now();
        let mut hosts = WorktreeHosts::default();
        hosts.put(None, "/work/a", ("local", "repo"), t0);
        hosts.put(None, "/work/b", ("local", "repo"), t0);
        hosts.put(None, "/work/c", ("local", "repo"), t0);
        hosts.put(Some("Studio"), "/work/b", ("env-1", "repo"), t0);
        let ps = json!({"worktrees": [
            {"path": "/work/a", "hostId": "local"},
            {"path": "/work/b", "hostId": "ssh:lab"},
            {"path": "/work/c"},
        ]});
        hosts.sync(None, &ps);
        assert_eq!(
            hosts.get(None, "/work/a", t0).map(|c| c.0).as_deref(),
            Some("local")
        );
        // The host the list names now is the one believed, a worktree with no host is not.
        assert_eq!(
            hosts.get(None, "/work/b", t0).map(|c| c.0).as_deref(),
            Some("ssh:lab")
        );
        assert_eq!(hosts.get(None, "/work/c", t0), None);
        // The list of this machine says nothing of another target's entries.
        assert_eq!(
            hosts
                .get(Some("Studio"), "/work/b", t0)
                .map(|c| c.0)
                .as_deref(),
            Some("env-1")
        );
        // The time is the confirmation's own: the list does not extend it.
        assert_eq!(hosts.get(None, "/work/a", t0 + HOST_TTL), None);
        hosts.sync(Some("Studio"), &json!({"worktrees": []}));
        assert_eq!(hosts.get(Some("Studio"), "/work/b", t0), None);
        assert_eq!(
            hosts.get(None, "/work/b", t0).map(|c| c.0).as_deref(),
            Some("ssh:lab")
        );
    }

    #[test]
    fn an_environment_that_is_no_longer_saved_loses_its_worktrees() {
        let t0 = Instant::now();
        let mut hosts = WorktreeHosts::default();
        hosts.put(None, "/work/a", ("local", "repo"), t0);
        hosts.put(Some("Studio"), "/work/a", ("env-1", "repo"), t0);
        hosts.put(Some("Lab"), "/work/a", ("env-2", "repo"), t0);
        hosts.retain_environments(&["Studio".to_owned()]);
        assert!(hosts.get(None, "/work/a", t0).is_some());
        assert!(hosts.get(Some("Studio"), "/work/a", t0).is_some());
        assert_eq!(hosts.get(Some("Lab"), "/work/a", t0), None);
    }

    #[test]
    fn an_environment_must_be_a_saved_one() {
        let saved = ["Studio".to_owned(), "Lab".to_owned()];
        assert!(check_environment("Studio", &saved).is_ok());
        assert!(check_environment("studio", &saved).is_err());
        assert!(check_environment("--json", &saved).is_err());
        assert!(check_environment("Studio", &[]).is_err());
    }

    #[test]
    fn a_destination_is_read_only_when_it_is_this_machine_or_a_saved_environment() {
        let saved = || Ok(vec!["Studio".to_owned(), "Lab".to_owned()]);
        assert_eq!(destination_check(None, saved()).unwrap(), ["Studio", "Lab"]);
        assert_eq!(
            destination_check(Some("Lab"), saved()).unwrap(),
            ["Studio", "Lab"]
        );
        // A name that is not saved is refused, and the saved ones stay in the answer so the pane can choose again.
        for name in ["lab", "--json", ""] {
            let view = destination_check(Some(name), saved()).unwrap_err();
            assert_eq!(view.state, OrcaState::Failed);
            assert_eq!(view.target.as_deref(), Some(name));
            assert_eq!(view.environments, ["Studio", "Lab"]);
            assert!(view.message.contains("保存されていない接続先"));
        }
    }

    #[test]
    fn the_launch_after_a_new_worktree_is_spared_its_checks_once_for_the_same_target_and_path() {
        let t0 = Instant::now();
        let mut made = MadeWorktree::default();
        assert!(!made.take(None, "/work/a", t0));
        made.put(Some("Lab"), "/work/a", t0);
        // Another target, or a path that differs in any way, checks as any launch, and leaves the record.
        assert!(!made.take(None, "/work/a", t0));
        assert!(!made.take(Some("Studio"), "/work/a", t0));
        for other in ["/work/a/", "/work/A", "/work/b", ""] {
            assert!(!made.take(Some("Lab"), other, t0), "{other}");
        }
        assert!(made.take(Some("Lab"), "/work/a", t0));
        // The launch used it up: a retry checks.
        assert!(!made.take(Some("Lab"), "/work/a", t0));
    }

    #[test]
    fn a_new_worktree_of_this_machine_is_spared_its_checks_too() {
        let t0 = Instant::now();
        let mut made = MadeWorktree::default();
        made.put(None, "/work/a", t0);
        assert!(!made.take(Some("Lab"), "/work/a", t0));
        assert!(made.take(None, "/work/a", t0));
    }

    #[test]
    fn a_new_worktree_is_believed_only_for_its_time_and_the_newest_one_replaces_it() {
        let t0 = Instant::now();
        let mut made = MadeWorktree::default();
        made.put(None, "/work/a", t0);
        assert!(made.take(None, "/work/a", t0 + MADE_TTL - Duration::from_millis(1)));
        made.put(None, "/work/a", t0);
        assert!(!made.take(None, "/work/a", t0 + MADE_TTL));
        // An old record that is late is gone, not kept for another look.
        assert!(!made.take(None, "/work/a", t0));
        made.put(None, "/work/a", t0);
        made.put(None, "/work/b", t0);
        assert!(!made.take(None, "/work/a", t0));
        assert!(made.take(None, "/work/b", t0));
    }

    /// The two lists of one target: a worktree of a repository with a Claude agent, and a worktree of an SSH host.
    fn lists_with_a_host() -> Lists {
        let mut ps = ps(&[agent("tabA:leaf1", "working")]);
        ps["worktrees"].as_array_mut().unwrap().push(json!({
            "path": "/home/e", "repo": "e", "hostId": "box", "displayName": "main", "agents": [],
        }));
        let mut terminals = terminals();
        terminals["terminals"].as_array_mut().unwrap().push(
            json!({"handle": "term_sh", "tabId": "tabC", "leafId": "leaf3", "worktreePath": "/work/example", "title": "zsh"}),
        );
        (Ok(ps), Ok(terminals))
    }

    /// The place of every item of the target's lists, in the order rows, worktrees, projects, hosts, terminals.
    fn places_of(view: &OrcaOverview) -> Vec<Option<&str>> {
        [
            view.rows
                .iter()
                .map(|i| i.environment.as_deref())
                .collect::<Vec<_>>(),
            view.worktrees
                .iter()
                .map(|i| i.environment.as_deref())
                .collect(),
            view.projects
                .iter()
                .map(|i| i.environment.as_deref())
                .collect(),
            view.hosts
                .iter()
                .map(|i| i.environment.as_deref())
                .collect(),
            view.terminals
                .iter()
                .map(|i| i.environment.as_deref())
                .collect(),
        ]
        .concat()
    }

    #[test]
    fn every_item_of_a_saved_environment_has_its_name_and_this_machines_has_none() {
        let view = assemble(
            Some("Lab".into()),
            vec!["Lab".into()],
            true,
            OrcaScope::Screen,
            lists_with_a_host(),
        );
        let places = places_of(&view);
        // The row, the two worktrees, the project, the host and the plain terminal.
        assert_eq!(places.len(), 6);
        assert!(places.iter().all(|p| *p == Some("Lab")), "{places:?}");
        let here = assemble(
            None,
            Vec::new(),
            false,
            OrcaScope::Screen,
            lists_with_a_host(),
        );
        assert_eq!(places_of(&here).len(), 6);
        assert!(places_of(&here).iter().all(Option::is_none));
    }

    #[test]
    fn the_lists_of_this_machine_come_beside_those_of_the_environment_with_no_place() {
        let lab = assemble(
            Some("Lab".into()),
            vec!["Lab".into()],
            true,
            OrcaScope::Screen,
            lists_with_a_host(),
        );
        let here = assemble(
            None,
            Vec::new(),
            false,
            OrcaScope::Screen,
            lists_with_a_host(),
        );
        let view = lab.with_local(here);
        assert_eq!(view.state, OrcaState::Ready);
        assert_eq!(view.target.as_deref(), Some("Lab"));
        let local = view.local.expect("this machine's lists");
        assert_eq!(local.state, OrcaState::Ready);
        assert_eq!(local.rows.len(), 1);
        assert_eq!(local.worktrees.len(), 2);
        assert_eq!(local.projects.len(), 1);
        assert_eq!(local.hosts.len(), 1);
        assert_eq!(local.terminals.len(), 1);
        let none = |places: Vec<Option<&String>>| places.iter().all(Option::is_none);
        assert!(none(
            local.rows.iter().map(|i| i.environment.as_ref()).collect()
        ));
        assert!(none(
            local
                .worktrees
                .iter()
                .map(|i| i.environment.as_ref())
                .collect()
        ));
        assert!(none(
            local
                .projects
                .iter()
                .map(|i| i.environment.as_ref())
                .collect()
        ));
        assert!(none(
            local.hosts.iter().map(|i| i.environment.as_ref()).collect()
        ));
        assert!(none(
            local
                .terminals
                .iter()
                .map(|i| i.environment.as_ref())
                .collect()
        ));
        assert_eq!(view.rows[0].environment.as_deref(), Some("Lab"));
    }

    #[test]
    fn a_failed_read_of_this_machine_leaves_the_environment_as_it_was_read() {
        let lab = assemble(
            Some("Lab".into()),
            vec!["Lab".into()],
            true,
            OrcaScope::Screen,
            lists_with_a_host(),
        );
        let broken = assemble(
            None,
            Vec::new(),
            false,
            OrcaScope::Screen,
            (
                Err(RunError::Failed("socket is gone".into())),
                Ok(Value::Null),
            ),
        );
        let view = lab.clone().with_local(broken);
        let local = view.local.clone().expect("this machine's state");
        assert_eq!(local.state, OrcaState::Failed);
        assert_eq!(local.message, "socket is gone");
        assert!(local.rows.is_empty() && local.worktrees.is_empty());
        assert_eq!(
            OrcaOverview {
                local: None,
                ..view
            },
            lab,
            "the environment's side is untouched"
        );
    }

    #[test]
    fn a_failed_read_of_the_environment_leaves_this_machines_lists() {
        let failed = assemble(
            Some("Lab".into()),
            vec!["Lab".into()],
            true,
            OrcaScope::Screen,
            (Ok(Value::Null), Err(RunError::Failed("offline".into()))),
        );
        let here = assemble(
            None,
            Vec::new(),
            false,
            OrcaScope::Screen,
            lists_with_a_host(),
        );
        let view = failed.with_local(here);
        assert_eq!(view.state, OrcaState::Failed);
        assert_eq!(view.message, "offline");
        assert_eq!(view.target.as_deref(), Some("Lab"));
        let local = view.local.expect("this machine's lists");
        assert_eq!(local.state, OrcaState::Ready);
        assert_eq!(local.rows.len(), 1);
    }

    #[test]
    fn a_missing_command_is_said_by_each_side_alone() {
        let view = assemble(
            None,
            Vec::new(),
            false,
            OrcaScope::Screen,
            (Err(RunError::Missing), Ok(Value::Null)),
        );
        assert_eq!(view.state, OrcaState::Missing);
        let with = OrcaOverview::empty(OrcaState::Ready).with_local(view);
        assert_eq!(with.state, OrcaState::Ready);
        assert_eq!(with.local.map(|l| l.state), Some(OrcaState::Missing));
    }

    #[test]
    fn items_are_placed_in_the_environment_given_or_in_this_machine() {
        let mut rows = rows_of(&ps(&[agent("tabA:leaf1", "working")]), &terminals());
        place_in(&mut rows, Some("Lab"));
        assert_eq!(rows[0].environment.as_deref(), Some("Lab"));
        place_in(&mut rows, None);
        assert_eq!(rows[0].environment, None);
    }

    #[test]
    fn only_the_poll_of_the_destination_checked_just_before_skips_the_check() {
        let lab = Some(Some("Lab".to_owned()));
        let here = Some(None);
        assert!(already_checked(&lab, Some("Lab"), false));
        assert!(already_checked(&here, None, false));
        // The first read, a read after a choice or a send, and another destination are checked.
        assert!(!already_checked(&None, Some("Lab"), false));
        assert!(!already_checked(&None, None, false));
        assert!(!already_checked(&lab, Some("Lab"), true));
        assert!(!already_checked(&lab, Some("Studio"), false));
        assert!(!already_checked(&lab, None, false));
        assert!(!already_checked(&here, Some("Lab"), false));
    }

    #[test]
    fn a_destination_whose_environments_cannot_be_listed_is_not_read() {
        let missing = destination_check(Some("Studio"), Err(RunError::Missing)).unwrap_err();
        assert_eq!(missing.state, OrcaState::Missing);
        let failed = destination_check(
            Some("Studio"),
            Err(RunError::Failed("応答がありません".into())),
        )
        .unwrap_err();
        assert_eq!(failed.state, OrcaState::Failed);
        assert_eq!(failed.message, "応答がありません");
        assert_eq!(failed.target.as_deref(), Some("Studio"));
        // This machine needs no environment, but the list is still asked for, so the pane can offer them.
        let this_machine =
            destination_check(None, Err(RunError::Failed("応答がありません".into()))).unwrap_err();
        assert_eq!(this_machine.state, OrcaState::Failed);
        assert_eq!(this_machine.target, None);
    }

    #[test]
    fn the_read_arguments() {
        assert_eq!(
            ps_args(None),
            ["worktree", "ps", "--limit", "200", "--json"]
        );
        assert_eq!(terminals_args(None), ["terminal", "list", "--json"]);
        assert_eq!(
            terminals_args(Some("Studio")),
            ["terminal", "list", "--json", "--environment=Studio"]
        );
        assert_eq!(
            ps_args(Some("Studio")).last().unwrap(),
            "--environment=Studio"
        );
    }

    #[test]
    fn a_send_needs_a_session_of_the_list_read_just_now() {
        let rows = rows_of(&ps(&[agent("tabA:leaf1", "working")]), &terminals());
        assert!(check_session(&rows, "term_1").is_ok());
        // A terminal that is listed but has no agent of a live pty, or one that is gone, is refused.
        for bad in ["term_2", "term_gone", ""] {
            assert!(
                check_session(&rows, bad).unwrap_err().contains("終了"),
                "{bad}"
            );
        }
        assert!(check_session(&[], "term_1").is_err());
        let mut dead = agent("tabA:leaf1", "working");
        dead["hasLivePty"] = json!(false);
        assert!(check_session(&rows_of(&ps(&[dead]), &terminals()), "term_1").is_err());
    }

    #[test]
    fn a_launch_needs_a_worktree_of_the_list_read_just_now() {
        let listed = worktrees_of(&ps(&[]));
        assert!(check_worktree(&listed, "/work/example").is_ok());
        for bad in ["/work/other", "/work/example/", "work/example", ""] {
            assert!(check_worktree(&listed, bad).is_err(), "{bad}");
        }
        assert!(check_worktree(&[], "/work/example").is_err());
    }

    #[test]
    fn a_send_the_terminal_did_not_take_is_a_failure() {
        assert!(check_accepted(&json!({"send": {"accepted": false}})).is_err());
        assert!(check_accepted(&json!({"send": {"accepted": true}})).is_ok());
        // A launch has no `send`, and an answer without the field is not a refusal.
        assert!(check_accepted(&json!({"outcome": {"kind": "terminal"}})).is_ok());
        assert!(check_accepted(&Value::Null).is_ok());
        let out = r#"{"ok": true, "result": {"send": {"accepted": false}}}"#;
        assert!(check_accepted(&parse_output(out).unwrap()).is_err());
    }

    #[test]
    fn a_new_terminal_is_made_in_the_worktree_with_no_focus_and_no_shell() {
        assert_eq!(
            create_args("/work/a", None),
            ["terminal", "create", "--worktree", "path:/work/a", "--json"]
        );
        assert_eq!(
            create_args("/work/a", Some("Studio")),
            [
                "terminal",
                "create",
                "--worktree",
                "path:/work/a",
                "--json",
                "--environment=Studio"
            ]
        );
        // A path that looks like an option stays one argument, joined to its selector.
        assert_eq!(create_args("/work/--json", None)[3], "path:/work/--json");
    }

    #[test]
    fn the_reply_of_a_new_terminal_names_its_handle_and_no_pane() {
        let out = r#"{"ok": true, "result": {"terminal": {"handle": "term_abc-1", "title": null, "surface": "background"}}}"#;
        assert_eq!(
            created_of(&parse_output(out).unwrap()),
            OrcaStarted {
                pane_key: None,
                handle: Some("term_abc-1".into())
            }
        );
        // The reply of a launch has no `terminal`, and an unusable handle is None, never an error.
        for odd in [
            Value::Null,
            json!({}),
            json!({"outcome": {"handle": "term_1"}}),
            json!({"terminal": "x"}),
            json!({"terminal": {"handle": ""}}),
            json!({"terminal": {"handle": "notterm"}}),
            json!({"terminal": {"handle": ["term_1"]}}),
        ] {
            assert_eq!(created_of(&odd), OrcaStarted::default(), "{odd}");
        }
    }

    #[test]
    fn a_new_worktree_is_made_in_the_repository_with_no_parent_and_no_shell() {
        assert_eq!(
            create_worktree_args("repo1", "fix-login", None, None, None),
            [
                "worktree",
                "create",
                "--repo=id:repo1",
                "--name=fix-login",
                "--no-parent",
                "--json"
            ]
        );
        assert_eq!(
            create_worktree_args("repo1", "fix-login", None, None, Some("Studio")),
            [
                "worktree",
                "create",
                "--repo=id:repo1",
                "--name=fix-login",
                "--no-parent",
                "--json",
                "--environment=Studio"
            ]
        );
        // A name with blanks or quotes stays one argument, joined to its flag.
        assert_eq!(
            create_worktree_args("repo1", "fix the \"login\"", None, None, None)[3],
            "--name=fix the \"login\""
        );
    }

    #[test]
    fn the_branch_and_the_base_of_a_new_worktree_are_passed_only_when_given() {
        assert_eq!(
            create_worktree_args(
                "repo1",
                "fix-login",
                Some("feat/login"),
                Some("origin/main"),
                None
            ),
            [
                "worktree",
                "create",
                "--repo=id:repo1",
                "--name=fix-login",
                "--branch=feat/login",
                "--base-branch=origin/main",
                "--no-parent",
                "--json"
            ]
        );
        assert_eq!(
            create_worktree_args(
                "repo1",
                "fix-login",
                Some("feat/login"),
                None,
                Some("Studio")
            ),
            [
                "worktree",
                "create",
                "--repo=id:repo1",
                "--name=fix-login",
                "--branch=feat/login",
                "--no-parent",
                "--json",
                "--environment=Studio"
            ]
        );
        assert_eq!(
            create_worktree_args("repo1", "fix-login", None, Some("main"), None),
            [
                "worktree",
                "create",
                "--repo=id:repo1",
                "--name=fix-login",
                "--base-branch=main",
                "--no-parent",
                "--json"
            ]
        );
    }

    #[test]
    fn a_branch_or_a_base_is_a_git_ref_trimmed_and_blank_means_none() {
        for ok in [
            "main",
            "feat/login",
            "origin/release-1.2",
            "refs/heads/fix_a",
            "ログイン",
            "a-b",
            "a@b",
            "v1.0",
            "HEAD",
        ] {
            assert_eq!(check_ref("ブランチ名", Some(ok)).unwrap(), Some(ok), "{ok}");
        }
        assert_eq!(
            check_ref(
                "ブランチ名",
                Some(
                    "  feat/login 
"
                )
            )
            .unwrap(),
            Some("feat/login")
        );
        assert_eq!(check_ref("ブランチ名", None).unwrap(), None);
        assert_eq!(check_ref("ブランチ名", Some("  	")).unwrap(), None);
        for bad in [
            "-fix",
            "  --json",
            "a..b",
            "a b",
            "a\u{3000}b",
            "a\nb",
            "a\tb",
            "a\0b",
            "a\u{7f}b",
            "a\u{85}b",
            "a\u{200b}b",
            "a\u{200d}b",
            "a\u{2060}b",
            "a\u{feff}b",
            "a\u{202e}b",
            "a\u{2066}b",
            "a\u{e0041}b",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[0]",
            "a\\b",
            "a@{u}",
            "@",
            "/a",
            "a/",
            "a//b",
            "a.",
            ".a",
            "a/.b",
            "a.lock",
            "a.lock/b",
        ] {
            let err = check_ref("作成元", Some(bad)).unwrap_err();
            assert!(err.starts_with("作成元"), "{bad:?}: {err}");
        }
    }

    #[tokio::test]
    async fn the_keys_of_a_saved_environment_go_over_its_websocket_and_a_refused_send_fails() {
        use crate::{
            orca_e2ee::testing::Desktop,
            orca_link::{
                ws_testing::{bind, FakeDesktop},
                WsLink,
            },
        };
        let (listener, url) = bind().await;
        let desktop = Desktop::new([31; 32]);
        let key = desktop.public_key_b64();
        let server = tokio::spawn(async move {
            let mut server = FakeDesktop::accept(&listener, desktop, "device-token", None).await;
            for accepted in [true, false] {
                let send = server.request().await;
                assert_eq!(send["method"], "terminal.send");
                assert_eq!(
                    send["params"],
                    input_params("term_1", "\u{3}--json", "cookapps", None)
                );
                server
                    .send(json!({"id": send["id"], "ok": true, "result": {"send": {"accepted": accepted}}}))
                    .await;
            }
        });
        let mut link = WsLink::connect(&url, "device-token", &key).await.unwrap();
        assert!(send_keys(&mut link, "term_1", "\u{3}--json").await.is_ok());
        assert!(send_keys(&mut link, "term_1", "\u{3}--json").await.is_err());
        server.await.unwrap();
    }

    #[test]
    fn the_project_of_a_new_worktree_is_a_repository_of_the_list_read_just_now() {
        let ps = json!({"worktrees": [
            {"path": "/work/a", "repoId": "repo1", "repo": "a"},
            {"path": "/work/b", "repoId": "repo2", "repo": "b", "isArchived": true},
            {"path": "/ssh/c", "repoId": "repo3", "hostId": "ssh-1", "repo": "c"},
        ]});
        assert!(check_project(&ps, "repo1").is_ok());
        for bad in [
            "repo2",
            "repo3",
            "ssh:ssh-1",
            "",
            "--json",
            "repo1 ",
            "unknown",
        ] {
            assert!(check_project(&ps, bad).is_err(), "{bad}");
        }
        assert!(check_project(&json!({"worktrees": []}), "repo1").is_err());
        assert!(check_project(&Value::Null, "repo1").is_err());
    }

    #[test]
    fn the_name_of_a_new_worktree_is_one_plain_line_that_is_no_option_or_path() {
        assert_eq!(check_worktree_name("fix-login").unwrap(), "fix-login");
        assert_eq!(
            check_worktree_name("  ログインを直す 2  ").unwrap(),
            "ログインを直す 2"
        );
        // A dash inside is fine; one at the start is an option.
        assert_eq!(check_worktree_name("a-b").unwrap(), "a-b");
        for bad in [
            "", "   ", "-fix", "  --json", "a/b", "a\\b", "/abs", ".", "..", "a\nb", "a\tb",
            "a\0b", "a\u{7f}b", "a\u{85}b",
        ] {
            assert!(check_worktree_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_reply_of_a_new_worktree_names_its_path() {
        let out = r#"{"ok": true, "result": {"worktree": {"id": "repo1::/work/fix-login", "path": "/work/fix-login", "branch": "refs/heads/fix-login"}, "warnings": []}}"#;
        assert_eq!(
            created_worktree_path_of(&parse_output(out).unwrap()).unwrap(),
            "/work/fix-login"
        );
        // A reply without a usable absolute path is an error: nothing can be started in it.
        for odd in [
            Value::Null,
            json!({}),
            json!({"worktree": null}),
            json!({"worktree": {}}),
            json!({"worktree": {"path": ""}}),
            json!({"worktree": {"path": "   "}}),
            json!({"worktree": {"path": "work/relative"}}),
            json!({"worktree": {"path": ["/work/a"]}}),
            json!({"path": "/work/a"}),
        ] {
            assert!(created_worktree_path_of(&odd).is_err(), "{odd}");
        }
        // A failure reply is the CLI's message, not a path.
        let failed =
            r#"{"ok": false, "error": {"code": "invalid_argument", "message": "No ready setup"}}"#;
        assert_eq!(parse_output(failed).unwrap_err(), "No ready setup");
    }

    #[test]
    fn a_launch_reply_names_its_pane_and_terminal() {
        let reply = json!({"outcome": {"kind": "terminal", "handle": "term_abc-1", "paneKey": "tab1:leaf2"}});
        assert_eq!(
            started_of(&reply),
            OrcaStarted {
                pane_key: Some("tab1:leaf2".into()),
                handle: Some("term_abc-1".into())
            }
        );
        // Absent, odd or unusable fields are None, never an error.
        for odd in [
            Value::Null,
            json!({}),
            json!({"outcome": "x"}),
            json!({"outcome": {"paneKey": "", "handle": ""}}),
            json!({"outcome": {"paneKey": "a b", "handle": "notterm"}}),
            json!({"outcome": {"paneKey": 3, "handle": ["term_1"]}}),
        ] {
            assert_eq!(started_of(&odd), OrcaStarted::default(), "{odd}");
        }
        let part = json!({"outcome": {"handle": "term_1"}});
        assert_eq!(started_of(&part).pane_key, None);
        assert_eq!(started_of(&part).handle.as_deref(), Some("term_1"));
        let out = r#"{"ok": true, "result": {"outcome": {"kind": "terminal", "handle": "term_9", "paneKey": "t:l"}}}"#;
        assert_eq!(
            started_of(&parse_output(out).unwrap()).pane_key.as_deref(),
            Some("t:l")
        );
    }

    #[test]
    fn a_handoff_destination_is_a_new_session() {
        let new: OrcaDestination =
            serde_json::from_value(json!({"kind": "new", "path": "/w"})).unwrap();
        assert_eq!(new, OrcaDestination::New { path: "/w".into() });
        assert!(serde_json::from_value::<OrcaDestination>(
            json!({"kind": "existing", "handle": "term_1"})
        )
        .is_err());
    }

    #[test]
    fn a_handoff_refuses_a_blank_instruction_before_it_runs_anything() {
        let destination = OrcaDestination::New { path: "/w".into() };
        assert_eq!(
            handoff(&destination, " \n", &[], &["a".into()], None, None).unwrap_err(),
            "指示を書いてください"
        );
    }

    #[test]
    fn a_handoff_checks_its_destination_like_a_launch() {
        let context = HandoffContext {
            kind: crate::orca_handoff::HandoffKind::Todo,
            title: "t".into(),
            body: "b".into(),
        };
        let bad_path = OrcaDestination::New {
            path: "relative".into(),
        };
        assert!(
            handoff(&bad_path, "i", &[], &["s".into()], Some(&context), None)
                .unwrap_err()
                .contains("worktree")
        );
    }

    #[test]
    fn the_text_is_joined_to_its_flag() {
        assert_eq!(
            send_args("term_1", "--json", None),
            [
                "terminal",
                "send",
                "--terminal",
                "term_1",
                "--text=--json",
                "--enter",
                "--json"
            ]
        );
        assert_eq!(
            send_args("term_1", "a b\nc", Some("Studio")),
            [
                "terminal",
                "send",
                "--terminal",
                "term_1",
                "--text=a b\nc",
                "--enter",
                "--json",
                "--environment=Studio"
            ]
        );
        assert_eq!(
            launch_args("/work/a", Some("--surface chat"), None),
            [
                "agent",
                "launch",
                "--agent",
                "claude",
                "--worktree",
                "path:/work/a",
                "--surface",
                "terminal",
                "--prompt=--surface chat",
                "--json"
            ]
        );
        assert_eq!(
            launch_args("/work/a", Some("go"), Some("Studio"))
                .last()
                .unwrap(),
            "--environment=Studio"
        );
        // A session started from the Orca screen has no prompt (the CLI takes none then).
        assert_eq!(
            launch_args("/work/a", None, Some("Studio")),
            [
                "agent",
                "launch",
                "--agent",
                "claude",
                "--worktree",
                "path:/work/a",
                "--surface",
                "terminal",
                "--json",
                "--environment=Studio"
            ]
        );
    }

    #[test]
    fn a_saved_target_stays_while_it_is_listed() {
        let saved = vec!["Studio".to_owned(), "Lab".to_owned()];
        let env = |name: &str| Saved::Target(Target::Environment { name: name.into() });
        assert_eq!(resolve_target(&env("Lab"), &saved), Ok(Some("Lab".into())));
        assert_eq!(
            resolve_target(&Saved::Target(Target::Local), &saved),
            Ok(None)
        );
        assert_eq!(resolve_target(&Saved::Target(Target::Local), &[]), Ok(None));
    }

    #[test]
    fn only_a_missing_file_chooses_the_target_by_itself() {
        let saved = vec!["Studio".to_owned(), "Lab".to_owned()];
        assert_eq!(
            resolve_target(&Saved::Nothing, &saved),
            Ok(Some("Studio".into()))
        );
        assert_eq!(resolve_target(&Saved::Nothing, &[]), Ok(None));
    }

    #[test]
    fn a_target_that_is_gone_or_a_file_that_is_broken_does_not_switch_by_itself() {
        let saved = vec!["Studio".to_owned()];
        let lost = Err("保存した接続先が見つかりません".to_owned());
        let gone = Saved::Target(Target::Environment {
            name: "Gone".into(),
        });
        assert_eq!(resolve_target(&gone, &saved), lost);
        assert_eq!(resolve_target(&gone, &[]), lost);
        assert_eq!(resolve_target(&Saved::Unusable, &saved), lost);
        // With no environment saved there is nothing else to choose.
        assert_eq!(resolve_target(&Saved::Unusable, &[]), Ok(None));
        assert_eq!(saved_name(&gone).as_deref(), Some("Gone"));
        assert_eq!(saved_name(&Saved::Unusable), None);
        assert_eq!(saved_name(&Saved::Target(Target::Local)), None);
    }

    #[test]
    fn the_target_setting_reads_what_it_says_and_nothing_else() {
        assert_eq!(
            parse_target(r#"{"kind":"local"}"#),
            Saved::Target(Target::Local)
        );
        assert_eq!(
            parse_target(r#"{"kind":"environment","name":"Studio"}"#),
            Saved::Target(Target::Environment {
                name: "Studio".into()
            })
        );
        for text in [
            "",
            "{",
            "{}",
            r#"{"kind":"remote"}"#,
            r#"{"kind":"environment"}"#,
        ] {
            assert_eq!(parse_target(text), Saved::Unusable, "{text}");
        }
    }

    #[test]
    fn the_target_load_gives_what_save_wrote() {
        let dir = std::env::temp_dir().join(format!("cookapps-orca-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_target(&dir), Saved::Nothing);
        save_target(&dir, Some("Studio")).unwrap();
        assert_eq!(
            load_target(&dir),
            Saved::Target(Target::Environment {
                name: "Studio".into()
            })
        );
        save_target(&dir, None).unwrap();
        assert_eq!(load_target(&dir), Saved::Target(Target::Local));
        // A file that exists but cannot be used is not "nothing saved".
        std::fs::write(dir.join(SETTINGS_FILE), "{").unwrap();
        assert_eq!(load_target(&dir), Saved::Unusable);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- A-8: statuses, projects, terminals ----

    #[test]
    fn an_orca_state_is_the_status_of_its_icon() {
        use OrcaStatus::*;
        for (word, status) in [
            ("waiting", Question),
            ("blocked", Question),
            ("permission", Question),
            ("failed", Failed),
            ("working", Working),
            ("monitoring", Monitoring),
            ("interrupted", Interrupted),
            ("unconfirmed", Interrupted),
            ("done", Done),
            ("active", Done),
            ("inactive", Idle),
        ] {
            assert_eq!(status_of(word, Idle), status, "{word}");
        }
        // A word not known yet, or none, is what the caller says: running for an agent, idle for a worktree.
        assert_eq!(status_of("something-new", Working), Working);
        assert_eq!(status_of("", Idle), Idle);
    }

    #[test]
    fn the_rank_is_orcas_with_the_question_first() {
        use OrcaStatus::*;
        let ranked = [
            Question,
            Failed,
            Working,
            Monitoring,
            Interrupted,
            Done,
            Idle,
        ];
        assert!(ranked.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn an_interrupted_agent_is_interrupted_unless_it_waits_or_failed() {
        let with = |state: &str, interrupted: bool| {
            agent_status(&json!({"state": state, "interrupted": interrupted}))
        };
        assert_eq!(with("working", true), OrcaStatus::Interrupted);
        assert_eq!(with("done", true), OrcaStatus::Interrupted);
        assert_eq!(with("waiting", true), OrcaStatus::Question);
        assert_eq!(with("failed", true), OrcaStatus::Failed);
        assert_eq!(with("working", false), OrcaStatus::Working);
        // No state and a state not known yet are running, as in A-6.
        assert_eq!(agent_status(&json!({})), OrcaStatus::Working);
        assert_eq!(with("something-new", false), OrcaStatus::Working);
    }

    #[test]
    fn a_worktree_takes_its_sidebar_status_then_its_status() {
        let status = |w: Value| worktree_status(&w);
        assert_eq!(
            status(json!({"sidebarStatus": "working", "status": "inactive"})),
            OrcaStatus::Working
        );
        assert_eq!(status(json!({"status": "active"})), OrcaStatus::Done);
        assert_eq!(
            status(json!({"sidebarStatus": "something-new"})),
            OrcaStatus::Idle
        );
        assert_eq!(status(json!({})), OrcaStatus::Idle);
    }

    #[test]
    fn a_row_carries_its_status_and_project() {
        let a = agent("tabA:leaf1", "waiting");
        let row = &rows_of(&ps(&[a]), &terminals())[0];
        assert_eq!(row.status, OrcaStatus::Question);
        assert_eq!(row.project_key, "repo1");
        // The group still follows A-6: waiting is 入力待ち whatever the icon.
        assert_eq!(row.group, OrcaGroup::Waiting);
    }

    /// Two repositories of this machine (one archived worktree), a worktree of an SSH host, and one that is not a repository's.
    fn projects_doc() -> Value {
        json!({"worktrees": [
            {"path": "/work/a", "repo": "alpha", "repoId": "ra", "displayName": "main", "hostId": "local",
             "isArchived": false, "sidebarStatus": "inactive", "lastActivityAt": 1_000, "agents": []},
            {"path": "/work/a2", "repo": "alpha", "repoId": "ra", "displayName": "feat/x", "hostId": "local",
             "isArchived": false, "sidebarStatus": "working", "lastActivityAt": 5_000,
             "agents": [{"parentPaneKey": null, "hasLivePty": true, "state": "waiting", "agentType": "claude"}]},
            {"path": "/work/old", "repo": "alpha", "repoId": "ra", "displayName": "old", "hostId": "local",
             "isArchived": true, "sidebarStatus": "failed", "lastActivityAt": 9_000, "agents": []},
            {"path": "/work/b", "repo": "beta", "repoId": "rb", "displayName": "main", "hostId": "local",
             "isArchived": false, "sidebarStatus": "inactive", "lastActivityAt": 3_000, "agents": []},
            {"path": "/work/only-archived", "repo": "gamma", "repoId": "rg", "displayName": "main", "hostId": "local",
             "isArchived": true, "agents": []},
            {"path": "/home/e", "repo": "alpha", "repoId": "ra", "displayName": "main", "hostId": "ssh-1",
             "isArchived": false, "sidebarStatus": "done", "lastActivityAt": 2_000,
             "agents": [{"parentPaneKey": null, "hasLivePty": true, "state": "working", "agentType": "claude"}]},
            {"path": "/work/no-repo", "repo": "x", "displayName": "main", "hostId": "local"},
        ]})
    }

    /// The Claude row of the pane `tc:lc` (`/work/a2`), holding the handle of the terminal of that pane in `terminals`.
    fn claude_rows(terminals: &Value) -> Vec<OrcaRow> {
        rows_of(
            &json!({"worktrees": [{
                "path": "/work/a2", "repo": "alpha", "repoId": "ra", "displayName": "feat/x",
                "agents": [{"paneKey": "tc:lc", "parentPaneKey": null, "hasLivePty": true, "state": "waiting", "agentType": "claude"}],
            }]}),
            terminals,
        )
    }

    fn plain_doc() -> Value {
        json!({"terminals": [
            {"handle": "term_sh", "worktreePath": "/work/b", "title": "zsh", "orphaned": false},
            {"handle": "term_codex", "worktreePath": "/work/a", "title": "codex", "agentIdentity": "codex"},
            {"handle": "term_claude", "tabId": "tc", "leafId": "lc", "worktreePath": "/work/a2", "agentIdentity": "claude"},
            {"handle": "term_orphan", "worktreePath": "/work/a", "orphaned": true},
            {"handle": "term_float", "worktreeId": "global-floating-terminal", "worktreePath": ""},
            {"handle": "term_unlisted", "worktreePath": "/work/elsewhere"},
            {"handle": "term_old", "worktreePath": "/work/old", "title": "archived"},
            {"worktreePath": "/work/a"},
            {"handle": "term_remote", "worktreePath": "/home/e", "title": "ssh shell"},
            {"handle": "term_notitle", "worktreePath": "/work/a"},
        ]})
    }

    #[test]
    fn a_plain_terminal_is_one_that_is_not_claudes_in_a_listed_worktree() {
        let rows = claude_rows(&plain_doc());
        let plain = plain_terminals_of(&projects_doc(), &plain_doc(), &rows);
        let handles: Vec<_> = plain.iter().map(|t| t.handle.as_str()).collect();
        // The one a Claude row holds, an orphaned one, the floating one, one outside a listed worktree, one with no handle, and one in an archived worktree are left out.
        assert_eq!(
            handles,
            ["term_sh", "term_codex", "term_remote", "term_notitle"]
        );
        assert_eq!(
            plain[0],
            OrcaTerminal {
                handle: "term_sh".into(),
                title: "zsh".into(),
                branch: "main".into(),
                project_key: "rb".into(),
                path: "/work/b".into(),
                environment: None,
            }
        );
        assert_eq!(plain[1].project_key, "ra");
        assert_eq!(plain[1].path, "/work/a");
        assert_eq!(plain[2].path, "/home/e");
        assert_eq!(plain[2].project_key, "ssh:ssh-1");
        assert_eq!(plain[3].title, "");
        assert!(plain_terminals_of(&projects_doc(), &Value::Null, &[]).is_empty());
        assert!(plain_terminals_of(&Value::Null, &plain_doc(), &rows).is_empty());
        // With no row, the terminal that Orca calls Claude's is a plain one: the kind is the row's.
        let all = plain_terminals_of(&projects_doc(), &plain_doc(), &[]);
        assert!(all.iter().any(|t| t.handle == "term_claude"));
    }

    /// Where the terminal `handle` shows in one read: how many Claude rows hold it, and how many plain terminals are it.
    fn appearances(ps: &Value, terminals: &Value, handle: &str) -> (usize, usize) {
        let rows = rows_of(ps, terminals);
        let plain = plain_terminals_of(ps, terminals, &rows);
        (
            rows.iter()
                .filter(|r| r.handle.as_deref() == Some(handle))
                .count(),
            plain.iter().filter(|t| t.handle == handle).count(),
        )
    }

    #[test]
    fn a_terminal_is_in_exactly_one_kind_in_every_state_between_the_lists() {
        // `orca terminal list` takes the kind from the process or the title; `worktree ps` has the agent only after a hook of Claude came.
        let ps_of = |agent: Option<Value>| {
            json!({"worktrees": [{
                "path": "/work/a", "repo": "alpha", "repoId": "ra", "displayName": "main",
                "agents": agent.into_iter().collect::<Vec<_>>(),
            }]})
        };
        let live = |pane_key: &str, live: bool, parent: Value| {
            json!({"paneKey": pane_key, "parentPaneKey": parent, "hasLivePty": live,
                   "state": "working", "agentType": "claude"})
        };
        let terminal = |identity: Value| {
            json!({"terminals": [{"handle": "term_x", "tabId": "t", "leafId": "l",
                   "worktreePath": "/work/a", "agentIdentity": identity}]})
        };
        // (the agent of ps, the agentIdentity of the terminal list, the result: (rows, plain))
        let cases = [
            (
                "both say Claude",
                Some(live("t:l", true, Value::Null)),
                json!("claude"),
                (1, 0),
            ),
            (
                "the list says Claude, ps has no agent yet",
                None,
                json!("claude"),
                (0, 1),
            ),
            (
                "ps has the agent, the list does not say Claude yet",
                Some(live("t:l", true, Value::Null)),
                Value::Null,
                (1, 0),
            ),
            (
                "ps has the agent, the list says another agent",
                Some(live("t:l", true, Value::Null)),
                json!("codex"),
                (1, 0),
            ),
            (
                "the agent has no live pty any more",
                Some(live("t:l", false, Value::Null)),
                json!("claude"),
                (0, 1),
            ),
            (
                "the agent is of another pane",
                Some(live("u:m", true, Value::Null)),
                json!("claude"),
                (0, 1),
            ),
            (
                "the agent is a sub-agent",
                Some(live("t:l", true, json!("p:q"))),
                json!("claude"),
                (0, 1),
            ),
            ("a shell, no agent", None, Value::Null, (0, 1)),
            ("another agent, no Claude row", None, json!("codex"), (0, 1)),
        ];
        for (name, agent, identity, want) in cases {
            assert_eq!(
                appearances(&ps_of(agent), &terminal(identity), "term_x"),
                want,
                "{name}"
            );
        }
    }

    fn project_lists(doc: &Value, plain: &Value) -> (Vec<OrcaProject>, Vec<OrcaProject>) {
        let rows = claude_rows(plain);
        let plain = plain_terminals_of(doc, plain, &rows);
        projects_of(doc, &rows, &plain)
    }

    #[test]
    fn projects_are_the_repositories_of_this_machine_newest_first() {
        let (projects, _) = project_lists(&projects_doc(), &Value::Null);
        let names: Vec<_> = projects
            .iter()
            .map(|p| (p.key.as_str(), p.name.as_str(), p.at_ms))
            .collect();
        // The archived worktree makes no project and does not move the activity of its repository; a repository with no id has none.
        assert_eq!(names, [("ra", "alpha", 5_000), ("rb", "beta", 3_000)]);
    }

    #[test]
    fn working_projects_come_first_and_each_part_is_newest_first() {
        let worktree = |repo: &str, host: &str, status: &str, at: u64| {
            json!({"path": format!("/w/{repo}"), "repo": repo, "repoId": repo, "displayName": "main", "hostId": host,
                   "isArchived": false, "sidebarStatus": status, "lastActivityAt": at, "agents": []})
        };
        let doc = json!({"worktrees": [
            worktree("old-working", "local", "working", 1_000),
            worktree("new-idle", "local", "inactive", 5_000),
            worktree("new-working", "local", "working", 3_000),
            // A waiting project is `question`, not `working`: it stays in the second part.
            worktree("newest-waiting", "local", "waiting", 9_000),
            worktree("ssh-old-working", "ssh-1", "working", 2_000),
            worktree("ssh-new-idle", "ssh-2", "inactive", 8_000),
        ]});
        let (projects, hosts) = projects_of(&doc, &[], &[]);
        let names: Vec<_> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            ["new-working", "old-working", "newest-waiting", "new-idle"]
        );
        // The SSH hosts keep their own order: newest activity first, whatever their status.
        let keys: Vec<_> = hosts.iter().map(|h| h.key.as_str()).collect();
        assert_eq!(keys, ["ssh:ssh-2", "ssh:ssh-1"]);
    }

    #[test]
    fn a_project_shows_the_highest_rank_of_its_agents_and_worktrees() {
        let (projects, _) = project_lists(&projects_doc(), &Value::Null);
        // alpha: a waiting agent (question) outranks a working worktree and an idle one; beta is idle.
        assert_eq!(projects[0].status, OrcaStatus::Question);
        assert_eq!(projects[1].status, OrcaStatus::Idle);
    }

    #[test]
    fn a_project_counts_its_claude_rows_and_plain_terminals_and_a_terminal_makes_it_active() {
        let (projects, _) = project_lists(&projects_doc(), &plain_doc());
        // alpha: one Claude row, and the Codex and untitled terminals; beta: its shell, which makes the idle project a green dot.
        assert_eq!(
            (projects[0].sessions, projects[0].status),
            (3, OrcaStatus::Question)
        );
        assert_eq!(
            (projects[1].sessions, projects[1].status),
            (1, OrcaStatus::Done)
        );
        let (bare, _) = project_lists(&projects_doc(), &Value::Null);
        assert_eq!(bare[0].sessions, 1);
        assert_eq!(bare[1].sessions, 0);
    }

    #[test]
    fn the_worktrees_of_an_ssh_host_are_its_row_apart_from_the_projects() {
        let (projects, hosts) = project_lists(&projects_doc(), &plain_doc());
        assert!(projects.iter().all(|p| !p.key.starts_with("ssh:")));
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].key, "ssh:ssh-1");
        assert_eq!(hosts[0].status, OrcaStatus::Working);
        assert_eq!(hosts[0].sessions, 1);
        assert_eq!(hosts[0].at_ms, 2_000);
    }

    #[test]
    fn projects_tolerate_odd_documents() {
        for doc in [
            Value::Null,
            json!({}),
            json!({"worktrees": [null, 3, {"agents": "x"}]}),
        ] {
            let (projects, hosts) = projects_of(&doc, &[], &[]);
            assert!(projects.is_empty() && hosts.is_empty(), "{doc}");
        }
    }

    #[test]
    fn an_ssh_target_needs_an_id_and_a_name() {
        let doc = json!({"targets": [
            {"id": "s1", "label": "Example\nsecond", "configHost": "example-host", "host": "203.0.113.5", "username": "u", "identityFile": "/k"},
            {"id": "s2", "configHost": "other"},
            {"id": "s3", "label": " ", "configHost": " "},
            {"label": "No id", "configHost": "noid"},
            {"id": "s5"},
            null, 5,
        ]});
        assert_eq!(
            ssh_targets_of(&doc),
            [
                OrcaSshTarget {
                    id: "s1".into(),
                    label: "Example".into(),
                },
                OrcaSshTarget {
                    id: "s2".into(),
                    label: "other".into(),
                },
            ]
        );
        assert!(ssh_targets_of(&Value::Null).is_empty());
        assert!(ssh_targets_of(&json!({"targets": "x"})).is_empty());
    }

    #[test]
    fn the_screen_lines_are_the_tail_of_the_read() {
        let result =
            json!({"terminal": {"source": "screen", "tail": ["$ ls", "", "a b", 7, null]}});
        assert_eq!(screen_lines_of(&result), ["$ ls", "", "a b"]);
        assert!(screen_lines_of(&Value::Null).is_empty());
        assert!(screen_lines_of(&json!({"terminal": {"tail": "x"}})).is_empty());
    }

    #[test]
    fn the_socket_read_asks_for_the_screen_and_refuses_a_stream() {
        assert_eq!(
            screen_params("term_1"),
            json!({"terminal": "term_1", "screen": true})
        );
        let screen = json!({"terminal": {"source": "screen", "tail": ["$ ls", "a"]}});
        assert_eq!(
            screen_of(&screen),
            Ok(vec!["$ ls".to_owned(), "a".to_owned()])
        );
        // An Orca that ignores `screen` answers the accumulated output with no source.
        assert!(screen_of(&json!({"terminal": {"tail": ["old output"]}})).is_err());
        assert!(screen_of(&Value::Null).is_err());
    }

    #[test]
    fn a_stale_handle_error_of_the_tab_close_closes_the_terminal_again() {
        let stale =
            r#"{"ok": false, "error": {"code": "terminal_handle_stale", "message": "gone"}}"#;
        assert_eq!(after_tab_close(stale), Ok(AfterTabClose::CloseAgain));
        assert_eq!(
            after_tab_close(r#"{"ok": true, "result": {"ptyKilled": false}}"#),
            Ok(AfterTabClose::Done)
        );
        assert_eq!(
            after_tab_close(r#"{"ok": false, "error": {"code": "not_found", "message": "no"}}"#),
            Err("no".to_owned())
        );
        assert!(after_tab_close("").is_err());
        assert!(after_tab_close("not json").is_err());
        // The second close has no excuse: a stale answer again is an error, and so is any other failure.
        assert_eq!(parse_output(stale), Err("gone".to_owned()));
        assert!(parse_output(r#"{"ok": true, "result": {"ptyKilled": true}}"#).is_ok());
    }

    #[test]
    fn only_a_stale_handle_error_is_a_stale_answer() {
        assert!(is_stale(
            r#"{"ok": false, "error": {"code": "terminal_handle_stale", "message": "gone"}}"#
        ));
        assert!(is_stale(
            "  {\"ok\":false,\"error\":{\"code\":\"terminal_handle_stale\"}}\n"
        ));
        for out in [
            r#"{"ok": false, "error": {"code": "not_found"}}"#,
            r#"{"ok": true, "result": {"ptyKilled": false}}"#,
            r#"{"ok": true, "error": {"code": "terminal_handle_stale"}}"#,
            "",
            "not json",
        ] {
            assert!(!is_stale(out), "{out}");
        }
    }

    #[test]
    fn the_close_and_read_arguments() {
        assert_eq!(
            close_args("term_1", None),
            [
                "terminal",
                "close",
                "--terminal",
                "term_1",
                "--tab",
                "--json"
            ]
        );
        assert_eq!(
            close_args("term_1", Some("Studio")).last().unwrap(),
            "--environment=Studio"
        );
        assert_eq!(
            close_plain_args("term_1", None),
            ["terminal", "close", "--terminal", "term_1", "--json"]
        );
        assert_eq!(
            close_plain_args("term_1", Some("Studio")).last().unwrap(),
            "--environment=Studio"
        );
        assert_eq!(
            screen_args("term_1", Some("Studio")),
            [
                "terminal",
                "read",
                "--terminal",
                "term_1",
                "--screen",
                "--json",
                "--environment=Studio"
            ]
        );
    }

    #[test]
    fn typed_keys_may_be_blank_or_control_bytes_but_not_nul_or_too_long() {
        for ok in ["a", " ", "\n", "\u{1b}[A", "\u{3}", "あ"] {
            assert!(check_keys(ok).is_ok(), "{ok:?}");
        }
        assert!(check_keys(&"あ".repeat(TEXT_LIMIT)).is_ok());
        assert!(check_keys("").is_err());
        assert!(check_keys("a\0b").is_err());
        assert!(check_keys(&"あ".repeat(TEXT_LIMIT + 1))
            .unwrap_err()
            .contains("100000"));
    }

    #[test]
    fn keys_go_only_to_a_terminal_of_the_list() {
        let rows = rows_of(&ps(&[agent("tabA:leaf1", "working")]), &terminals());
        let plain = plain_terminals_of(&projects_doc(), &plain_doc(), &rows);
        assert!(check_terminal(&rows, &plain, "term_sh").is_ok());
        // Orca's `agentIdentity` does not matter: no row holds it, so it is a plain terminal.
        assert!(check_terminal(&rows, &plain, "term_claude").is_ok());
        // A Claude session's terminal is mirrored too (every tab is a terminal, A-12).
        assert!(check_terminal(&rows, &plain, "term_1").is_ok());
        for bad in ["term_2", "term_gone", ""] {
            assert!(
                check_terminal(&rows, &plain, bad)
                    .unwrap_err()
                    .contains("終了"),
                "{bad}"
            );
        }
        assert!(check_terminal(&[], &[], "term_sh").is_err());
    }

    #[test]
    fn keys_and_closes_with_a_bad_handle_or_text_run_nothing() {
        let mirror = OrcaMirror::default();
        for environment in [None, Some("Studio")] {
            assert!(check_input(&mirror, "--json", environment, "x").is_err());
            assert!(check_input(&mirror, "term_1", environment, "").is_err());
            assert!(check_input(&mirror, "term_1", environment, "a\0").is_err());
            assert!(screen(&mirror, "term_a b", environment).is_err());
        }
        assert!(close("--json", None).is_err());
        assert!(mirror.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_checked_terminal_is_not_checked_again_until_a_failure_forgets_it() {
        let mirror = OrcaMirror::default();
        mirror.remember("term_1", None);
        // Checked before: no list is read (a list read would fail here, with no Orca).
        assert_eq!(check_mirrored(&mirror, "term_1", None), Ok(()));
        mirror.forget("term_1", None);
        assert!(mirror.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_handle_checked_in_one_target_is_not_checked_in_another() {
        let mirror = OrcaMirror::default();
        mirror.remember("term_1", Some("Studio"));
        // Checked before: no environment list and no terminal list is read.
        assert_eq!(check_mirrored(&mirror, "term_1", Some("Studio")), Ok(()));
        assert!(mirror.knows("term_1", Some("Studio")));
        assert!(!mirror.knows("term_1", None));
        assert!(!mirror.knows("term_1", Some("Other")));
        assert!(!mirror.knows("term_2", Some("Studio")));
        // A failure of a saved environment's terminal forgets that one and no other.
        mirror.remember("term_1", None);
        mirror.forget("term_1", Some("Studio"));
        assert!(!mirror.knows("term_1", Some("Studio")));
        assert!(mirror.knows("term_1", None));
    }

    #[test]
    fn the_keys_go_to_the_socket_as_the_cli_sends_them() {
        assert_eq!(
            input_params("term_1", "\u{3}--json", "cookapps", None),
            json!({
                "terminal": "term_1",
                "text": "\u{3}--json",
                "enter": false,
                "client": {"id": "cookapps", "type": "desktop"},
            })
        );
    }

    #[test]
    fn the_keys_of_a_terminal_that_fits_the_pane_claim_its_size_as_orca_does() {
        let viewport = |cols, rows| Some(OrcaViewport { cols, rows });
        assert_eq!(
            input_params("term_1", "ls\r", "cookapps-1", viewport(120, 40)),
            json!({
                "terminal": "term_1",
                "text": "ls\r",
                "enter": false,
                "client": {"id": "cookapps-1", "type": "desktop"},
                "viewport": {"cols": 120, "rows": 40},
                "claimViewport": true,
            })
        );
        // A pane too small or too large is claimed at the nearest size Orca takes, as the other messages of the size do.
        let params = input_params("term_1", "x", "cookapps-1", viewport(5, 900));
        assert_eq!(params["viewport"], json!({"cols": 20, "rows": 500}));
    }
}
