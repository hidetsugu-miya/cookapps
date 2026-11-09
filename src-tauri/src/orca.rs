//! A-6, A-8: the Orca screen. Orca's CLI (`orca`) lists the agents that run in Orca, starts them and posts to them; nothing about a session is stored here.
//! The CLI is spawned with an argument list, never through a shell, and the prompt text is in no log line.
//! A-8 adds the project list and the terminals of Orca (closed through the CLI, and mirrored for this machine). A saved environment streams them instead (A-12, `orca_stream.rs`).

use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts::write_synced,
    auth::config_dir,
    orca_chat::check_pane_key,
    orca_handoff::{compose, HandoffContext},
    orca_stream::{clamp_viewport, OrcaViewport},
};

/// Reading the agents is a few local calls (or one to a paired server).
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// A launch starts an agent CLI, and a send waits for the terminal to take the text.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// `orca worktree ps` is asked for this many worktrees.
const WORKTREE_LIMIT: &str = "200";
/// Characters of a post (a send or the first prompt of a launch).
pub(crate) const TEXT_LIMIT: usize = 100_000;
/// Characters of the line a row shows; the screen cuts it with an ellipsis, this only keeps a long message from crossing the IPC.
const LINE_LIMIT: usize = 200;
const SETTINGS_FILE: &str = "orca-settings.json";
const SETTINGS_TMP_FILE: &str = "orca-settings.json.tmp";

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
    /// The agent's pane (`{tabId}:{leafId}`), which finds its session for the history (A-7); `None` when the agent has none.
    pub pane_key: Option<String>,
    /// The worktree's path, which the history asks Orca for the worktree's tabs.
    pub path: String,
    /// The latest action: `{tool}: {first line of its input}`, else the first line of the last answer, else empty (A-8).
    pub activity: String,
    /// The icon of the row (A-8).
    pub status: OrcaStatus,
    /// The project the row belongs to (`OrcaProject::key`); empty when its worktree has none.
    pub project_key: String,
}

/// The session a launch or a handoff reached (A-9), as far as Orca's reply says: a field the reply lacks (or holds in a shape that is not one) is `None`.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaStarted {
    /// The agent's pane (`{tabId}:{leafId}`), which finds its history (A-7).
    pub pane_key: Option<String>,
    /// The terminal that takes the next send.
    pub handle: Option<String>,
}

/// Where a handoff goes (A-9): a new session in a worktree, or the terminal of a running one.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OrcaDestination {
    New { path: String },
    Existing { handle: String },
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
    pub branch: String,
    /// The project the worktree belongs to (`OrcaProject::key`; empty when it has none), which the plus of the work pane narrows the worktrees by (A-16).
    pub project_key: String,
    /// Whether it is the repository's own folder (`isMainWorktree` of Orca), which the file pane shows for a project with no tab (A-18).
    pub is_main: bool,
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

/// The latest action of an agent: `{toolName}: {first line of toolInput}`, else the first line of its last answer, cut to `LINE_LIMIT` characters.
fn activity_of(agent: &Value) -> String {
    match text_of(agent, "toolName") {
        Some(tool) => {
            let line = match agent["toolInput"].as_str().and_then(first_line) {
                Some(input) => format!("{tool}: {input}"),
                None => tool.to_owned(),
            };
            line.chars().take(LINE_LIMIT).collect()
        }
        None => text_of(agent, "lastAssistantMessage")
            .and_then(first_line)
            .unwrap_or_default(),
    }
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
                    activity: activity_of(agent),
                    status: agent_status(agent),
                    project_key: project_key_of(worktree).unwrap_or_default(),
                },
            ));
        }
    }
    rows.sort_by_key(|(updated, _)| std::cmp::Reverse(*updated));
    rows.into_iter().map(|(_, row)| row).collect()
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
                project_key: project_key_of(w).unwrap_or_default(),
                is_main: w["isMainWorktree"] == true,
            })
        })
        .collect()
}

/// The `hostId` Orca names for the worktree at `path` in `orca worktree ps` (its `result`); `None` when the worktree or its `hostId` is absent (A-10 sends a file there, and Orca wants this id with it).
fn host_id_of(ps: &Value, path: &str) -> Option<String> {
    ps["worktrees"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|w| text_of(w, "path") == Some(path))
        .and_then(|w| text_of(w, "hostId"))
        .map(str::to_owned)
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

/// The lines of `orca terminal read --screen` (its `result`): `terminal.tail`, an array of lines with no colors.
pub fn screen_lines_of(result: &Value) -> Vec<String> {
    result["terminal"]["tail"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect()
}

/// Whether the CLI's output says the terminal was already closed (`terminal_handle_stale`): closing it again is a success.
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
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(SETTINGS_FILE), dir.join(SETTINGS_TMP_FILE));
    let text = serde_json::to_string_pretty(&target).map_err(|e| e.to_string())?;
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
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

/// The keys of a mirrored terminal, written verbatim: no `--enter`, so control bytes reach the terminal as typed.
fn input_args(handle: &str, text: &str, environment: Option<&str>) -> Vec<String> {
    let mut args = args_of(&["terminal", "send", "--terminal", handle]);
    args.extend([format!("--text={text}"), "--json".into()]);
    with_environment(args, environment)
}

/// Always Claude: the history of A-7 reads only Claude's sessions. A session started from the Orca screen (A-12) has no first prompt: the user types it in the terminal.
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

/// `orca worktree ps` and, when `terminals` is true, `orca terminal list` of the target, run side by side: the answer waits for the slower one, not for both.
/// Without terminals the second answer is an empty document.
fn read_lists(
    environment: Option<&str>,
    terminals: bool,
) -> (Result<Value, RunError>, Result<Value, RunError>) {
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

fn overview(dir: &Path, scope: OrcaScope, held: Option<String>) -> OrcaOverview {
    let failed =
        |message: String, target: Option<String>, environments: Vec<String>| OrcaOverview {
            message,
            target,
            environments,
            ..OrcaOverview::empty(OrcaState::Failed)
        };
    // Only a full read asks for the environments and resolves the target; the others use the one the screen holds.
    let (target, environments, known) = if scope == OrcaScope::Full {
        let saved = load_target(dir);
        let environments = match read_environments() {
            Ok(environments) => environments,
            Err(RunError::Missing) => return OrcaOverview::empty(OrcaState::Missing),
            // The target and the environments are not learned: the screen keeps the ones it had.
            Err(RunError::Failed(message)) => {
                return OrcaOverview {
                    known: false,
                    ..failed(message, None, Vec::new())
                }
            }
        };
        match resolve_target(&saved, &environments) {
            Ok(target) => (target, environments, true),
            Err(message) => return failed(message, saved_name(&saved), environments),
        }
    } else {
        (held, Vec::new(), false)
    };
    let (ps, terminals) = read_lists(target.as_deref(), scope != OrcaScope::Badge);
    match (ps, terminals) {
        (Ok(ps), Ok(terminals)) => {
            let rows = rows_of(&ps, &terminals);
            // The count alone is wanted by a `Badge` read: its terminals and projects would not be drawn.
            let (plain, projects, hosts) = if scope == OrcaScope::Badge {
                (Vec::new(), Vec::new(), Vec::new())
            } else {
                let plain = plain_terminals_of(&ps, &terminals, &rows);
                let (projects, hosts) = projects_of(&ps, &rows, &plain);
                (plain, projects, hosts)
            };
            OrcaOverview {
                target,
                environments,
                rows,
                worktrees: worktrees_of(&ps),
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
            ..failed(message, target, environments)
        },
    }
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

/// A-11: the handle must be a row of the list the target gives just now, the environment a saved one.
pub(crate) fn check_target(handle: &str, environment: Option<&str>) -> Result<(), String> {
    check_handle(handle)?;
    check_listed(environment)?;
    let (ps, terminals) = read_lists(environment, true);
    check_session(
        &rows_of(&ps.map_err(message_of)?, &terminals.map_err(message_of)?),
        handle,
    )
}

/// A-11: the lines on the screen of the session `handle`, read without the mirror's check of the handle (the caller checked it).
pub(crate) fn read_screen(handle: &str, environment: Option<&str>) -> Result<Vec<String>, String> {
    call(&screen_args(handle, environment), READ_TIMEOUT)
        .map(|result| screen_lines_of(&result))
        .map_err(message_of)
}

/// A-11: one key typed into the session `handle` (no Enter), through the CLI like the keys of a mirror of a saved environment. Only digits and Tab come here, so no secret is in the arguments.
pub(crate) fn press_key(handle: &str, key: &str, environment: Option<&str>) -> Result<(), String> {
    write(&input_args(handle, key, environment)).map(|_| ())
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
    check_start(path, environment)?;
    write(&launch_args(path, prompt, environment)).map(|result| started_of(&result))
}

/// Opens a plain terminal in the worktree at `path` (A-16), once, with the checks of a launch.
fn open_terminal(path: &str, environment: Option<&str>) -> Result<OrcaStarted, String> {
    check_start(path, environment)?;
    write(&create_args(path, environment)).map(|result| created_of(&result))
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
    check_path(path)?;
    check_listed(environment)?;
    let (ps, _) = read_lists(environment, false);
    let ps = ps.map_err(message_of)?;
    check_worktree(&worktrees_of(&ps), path)?;
    host_id_of(&ps, path).ok_or_else(|| "Orca が worktree のホストを答えませんでした".into())
}

/// Hands the content to a new session or a running one (A-9): the prompt is composed here, then the launch or the send of A-6 runs once with its checks.
fn handoff(
    destination: &OrcaDestination,
    instruction: &str,
    context: Option<&HandoffContext>,
    environment: Option<&str>,
) -> Result<OrcaStarted, String> {
    let text = compose(instruction, context)?;
    match destination {
        OrcaDestination::New { path } => launch(path, Some(&text), environment),
        OrcaDestination::Existing { handle } => {
            send(handle, &text, environment)?;
            Ok(OrcaStarted {
                pane_key: None,
                handle: Some(handle.clone()),
            })
        }
    }
}

/// Closes the tab of an Orca terminal. A terminal that is already closed (`terminal_handle_stale`) is a success; `ptyKilled` is not looked at.
fn close(handle: &str, environment: Option<&str>) -> Result<(), String> {
    check_handle(handle)?;
    check_listed(environment)?;
    let out = run(&close_args(handle, environment), READ_TIMEOUT).map_err(message_of)?;
    if is_stale(&out) {
        return Ok(());
    }
    parse_output(&out).map(|_| ())
}

/// The handles that were checked against the terminals of this machine's list, so only the first read or input of a terminal reads the list. A handle leaves when a read or a send of its terminal fails.
#[derive(Default, Clone)]
pub struct OrcaMirror(Arc<Mutex<HashSet<String>>>);

impl OrcaMirror {
    fn forget(&self, handle: &str) {
        self.0.lock().unwrap().remove(handle);
    }
}

/// Checks that `handle` is a terminal (a Claude session's or a plain one) of this machine's list read just now, unless an earlier read or input of it did.
fn check_mirrored(mirror: &OrcaMirror, handle: &str) -> Result<(), String> {
    check_handle(handle)?;
    if !mirror.0.lock().unwrap().contains(handle) {
        let (ps, terminals) = read_lists(None, true);
        let (ps, terminals) = (ps.map_err(message_of)?, terminals.map_err(message_of)?);
        let rows = rows_of(&ps, &terminals);
        check_terminal(&rows, &plain_terminals_of(&ps, &terminals, &rows), handle)?;
        mirror.0.lock().unwrap().insert(handle.to_owned());
    }
    Ok(())
}

/// The lines on the screen of a terminal of this machine. Read once a second while its tab is shown, so the list is read only the first time.
fn screen(mirror: &OrcaMirror, handle: &str) -> Result<Vec<String>, String> {
    check_mirrored(mirror, handle)?;
    call(&screen_args(handle, None), READ_TIMEOUT)
        .map(|result| screen_lines_of(&result))
        .map_err(|e| {
            mirror.forget(handle);
            message_of(e)
        })
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
fn check_input(mirror: &OrcaMirror, handle: &str, text: &str) -> Result<(), String> {
    check_handle(handle)?;
    check_keys(text)?;
    check_mirrored(mirror, handle)
}

/// The SSH hosts of this machine's Orca, from its runtime (not a public interface: it was written against Orca 1.4.248). A failure is an empty list.
pub(crate) async fn local_ssh_targets() -> Vec<OrcaSshTarget> {
    crate::orca_chat::local_call("ssh.listEditableTargets", serde_json::json!({}))
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

/// A-9: starts a session in a worktree, or posts to a running one, with the instruction and, when `context` is given, the content quoted as data.
#[tauri::command]
pub async fn orca_handoff(
    destination: OrcaDestination,
    instruction: String,
    context: Option<HandoffContext>,
    environment: Option<String>,
) -> Result<OrcaStarted, String> {
    blocking(move || {
        handoff(
            &destination,
            &instruction,
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

/// The lines on the screen of the terminal `handle` of this machine, for the mirror.
#[tauri::command]
pub async fn orca_terminal_read(
    mirror: tauri::State<'_, OrcaMirror>,
    handle: String,
) -> Result<Vec<String>, String> {
    let mirror = mirror.inner().clone();
    blocking(move || screen(&mirror, &handle)).await?
}

/// Types `text` into the terminal `handle` of this machine as it is, over its unix socket (`terminal.send`), so the keys are in no argument of a process.
#[tauri::command]
pub async fn orca_terminal_input(
    mirror: tauri::State<'_, OrcaMirror>,
    handle: String,
    text: String,
) -> Result<(), String> {
    let mirror = mirror.inner().clone();
    {
        let (mirror, handle, text) = (mirror.clone(), handle.clone(), text.clone());
        blocking(move || check_input(&mirror, &handle, &text)).await??;
    }
    let sent = crate::orca_chat::local_call(
        "terminal.send",
        input_params(&handle, &text, "cookapps", None),
    )
    .await
    .and_then(|result| check_accepted(&result));
    if sent.is_err() {
        mirror.forget(&handle);
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
                activity: String::new(),
                status: OrcaStatus::Working,
                project_key: "repo1".into(),
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
                activity: String::new(),
                status: OrcaStatus::Working,
                project_key: String::new(),
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
            {"path": "/work/a", "repo": "a", "repoId": "repo-a", "displayName": "main", "isMainWorktree": true, "agents": []},
            {"repo": "no-path", "displayName": "x"},
            {"path": "/work/b", "repo": "b"},
            {"path": "/ssh/c", "repo": "c", "repoId": "repo-c", "hostId": "box", "displayName": "dev"},
        ]});
        // Each carries the key of its project (A-16): the repository on this machine, `ssh:{hostId}` on a host, empty when a repository has no id.
        assert_eq!(
            worktrees_of(&doc),
            [
                OrcaWorktree {
                    path: "/work/a".into(),
                    repo: "a".into(),
                    branch: "main".into(),
                    project_key: "repo-a".into(),
                    is_main: true
                },
                OrcaWorktree {
                    path: "/work/b".into(),
                    repo: "b".into(),
                    branch: String::new(),
                    project_key: String::new(),
                    is_main: false
                },
                OrcaWorktree {
                    path: "/ssh/c".into(),
                    repo: "c".into(),
                    branch: "dev".into(),
                    project_key: "ssh:box".into(),
                    is_main: false
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
    fn a_worktree_path_is_absolute() {
        assert!(check_path("/Users/example/work").is_ok());
        for bad in ["", "work", "./work", "--json", "~/work"] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_host_of_a_worktree_is_the_host_id_orca_names() {
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
    fn an_environment_must_be_a_saved_one() {
        let saved = ["Studio".to_owned(), "Lab".to_owned()];
        assert!(check_environment("Studio", &saved).is_ok());
        assert!(check_environment("studio", &saved).is_err());
        assert!(check_environment("--json", &saved).is_err());
        assert!(check_environment("Studio", &[]).is_err());
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
    fn a_handoff_destination_is_new_or_existing() {
        let new: OrcaDestination =
            serde_json::from_value(json!({"kind": "new", "path": "/w"})).unwrap();
        assert_eq!(new, OrcaDestination::New { path: "/w".into() });
        let old: OrcaDestination =
            serde_json::from_value(json!({"kind": "existing", "handle": "term_1"})).unwrap();
        assert_eq!(
            old,
            OrcaDestination::Existing {
                handle: "term_1".into()
            }
        );
        assert!(serde_json::from_value::<OrcaDestination>(json!({"kind": "other"})).is_err());
    }

    #[test]
    fn a_handoff_refuses_a_blank_instruction_before_it_runs_anything() {
        for destination in [
            OrcaDestination::New { path: "/w".into() },
            OrcaDestination::Existing {
                handle: "term_1".into(),
            },
        ] {
            assert_eq!(
                handoff(&destination, " \n", None, None).unwrap_err(),
                "指示を書いてください"
            );
        }
    }

    #[test]
    fn a_handoff_checks_its_destination_like_a_post() {
        let context = HandoffContext {
            kind: crate::orca_handoff::HandoffKind::Todo,
            title: "t".into(),
            body: "b".into(),
        };
        let bad_handle = OrcaDestination::Existing {
            handle: "--x".into(),
        };
        assert!(handoff(&bad_handle, "i", Some(&context), None).is_err());
        let bad_path = OrcaDestination::New {
            path: "relative".into(),
        };
        assert!(handoff(&bad_path, "i", Some(&context), None)
            .unwrap_err()
            .contains("worktree"));
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
    fn the_activity_is_the_tool_and_its_input_else_the_last_answer() {
        let mut a = agent("tabA:leaf1", "working");
        assert_eq!(activity_of(&a), "");
        a["lastAssistantMessage"] = json!("\nAnswer\nmore");
        assert_eq!(activity_of(&a), "Answer");
        a["toolName"] = json!("Bash");
        assert_eq!(activity_of(&a), "Bash");
        a["toolInput"] = json!("\ncargo test --all-features\nsecond");
        assert_eq!(activity_of(&a), "Bash: cargo test --all-features");
        // A tool is named whatever the state; an input that is not text, or blank, leaves the name alone.
        a["toolInput"] = json!({"command": "x"});
        assert_eq!(activity_of(&a), "Bash");
        a["toolInput"] = json!("  ");
        assert_eq!(activity_of(&a), "Bash");
        a["toolInput"] = json!("あ".repeat(LINE_LIMIT + 50));
        assert_eq!(activity_of(&a).chars().count(), LINE_LIMIT);
    }

    #[test]
    fn a_row_carries_its_activity_status_and_project() {
        let mut a = agent("tabA:leaf1", "waiting");
        a["toolName"] = json!("Edit");
        a["toolInput"] = json!("ts/orca.ts");
        let row = &rows_of(&ps(&[a]), &terminals())[0];
        assert_eq!(row.activity, "Edit: ts/orca.ts");
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
                path: "/work/b".into()
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
    fn only_a_stale_handle_error_is_an_already_closed_terminal() {
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
    fn the_close_read_and_input_arguments() {
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
        // No `--enter`, and the text joined to its flag so that control bytes and `--json` are taken as typed.
        assert_eq!(
            input_args("term_1", "\u{3}--json", None),
            [
                "terminal",
                "send",
                "--terminal",
                "term_1",
                "--text=\u{3}--json",
                "--json"
            ]
        );
        assert!(!input_args("term_1", "x", Some("Studio")).contains(&"--enter".to_owned()));
        assert_eq!(
            input_args("term_1", "x", Some("Studio")).last().unwrap(),
            "--environment=Studio"
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
        assert!(check_input(&mirror, "--json", "x").is_err());
        assert!(check_input(&mirror, "term_1", "").is_err());
        assert!(check_input(&mirror, "term_1", "a\0").is_err());
        assert!(close("--json", None).is_err());
        assert!(screen(&mirror, "term_a b").is_err());
        assert!(mirror.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_checked_terminal_is_not_checked_again_until_a_failure_forgets_it() {
        let mirror = OrcaMirror::default();
        mirror.0.lock().unwrap().insert("term_1".into());
        // Checked before: no list is read (a list read would fail here, with no Orca).
        assert_eq!(check_mirrored(&mirror, "term_1"), Ok(()));
        mirror.forget("term_1");
        assert!(mirror.0.lock().unwrap().is_empty());
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
