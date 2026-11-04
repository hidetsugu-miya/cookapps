//! A-6: the Orca screen. Orca's CLI (`orca`) lists the agents that run in Orca and posts to them; nothing about a session is stored here.
//! The CLI is spawned with an argument list, never through a shell, and the prompt text is in no log line.

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_synced, auth::config_dir};

/// Reading the agents is a few local calls (or one to a paired server).
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// A launch starts an agent CLI, and a send waits for the terminal to take the text.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// `orca worktree ps` is asked for this many worktrees.
const WORKTREE_LIMIT: &str = "200";
/// Characters of a post (a send or the first prompt of a launch).
const TEXT_LIMIT: usize = 100_000;
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

/// Which group of the screen an agent is in: waiting for the user (`waiting`, `blocked`), `done`, or running (every other state).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum OrcaGroup {
    Waiting,
    Working,
    Done,
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
}

/// A worktree a launch can start an agent in.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaWorktree {
    pub path: String,
    pub repo: String,
    pub branch: String,
}

/// A skill of Claude Code the composer offers while a `/` is typed.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaSkill {
    /// What is typed to call it: `/name`, or `/plugin:name` for a plugin's skill.
    pub command: String,
    /// One line.
    pub description: String,
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

/// The group an agent state belongs to: `waiting` and `blocked` need the user, `done` is finished, anything else (also a state not known yet) runs.
fn group_of(state: &str) -> OrcaGroup {
    match state {
        "waiting" | "blocked" => OrcaGroup::Waiting,
        "done" => OrcaGroup::Done,
        _ => OrcaGroup::Working,
    }
}

/// The text of a row's line: the first line of the prompt, else the task's title, the conversation's name, or the first line of the last answer.
fn line_of(agent: &Value) -> String {
    text_of(agent, "prompt")
        .and_then(first_line)
        .or_else(|| text_of(agent, "taskTitle").and_then(first_line))
        .or_else(|| text_of(agent, "conversationName").and_then(first_line))
        .or_else(|| text_of(agent, "lastAssistantMessage").and_then(first_line))
        .unwrap_or_default()
}

/// The rows of `orca worktree ps` (`ps`, its `result`) with the terminals of `orca terminal list` (`terminals`, its `result`): the top-level Claude agents of a live terminal, newest first.
/// A field that is absent or of another type is left out, not an error.
pub fn rows_of(ps: &Value, terminals: &Value) -> Vec<OrcaRow> {
    // The pane of an agent is "{tabId}:{leafId}" of its terminal. A terminal that lost its tab is orphaned and still runs:
    // its ids are made up from the pty, and the pane it had is `recordedPaneKey`. A live terminal of the pane comes first.
    let (orphaned, live): (Vec<&Value>, Vec<&Value>) = terminals["terminals"]
        .as_array()
        .into_iter()
        .flatten()
        .partition(|t| t["orphaned"] == true);
    let handles: Vec<(String, &str)> = live
        .into_iter()
        .filter_map(|t| {
            Some((
                format!("{}:{}", text_of(t, "tabId")?, text_of(t, "leafId")?),
                text_of(t, "handle")?,
            ))
        })
        .chain(orphaned.into_iter().filter_map(|t| {
            Some((
                text_of(t, "recordedPaneKey")?.to_owned(),
                text_of(t, "handle")?,
            ))
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
            let handle = pane_key.and_then(|pane| {
                handles
                    .iter()
                    .find(|(key, _)| key == pane)
                    .map(|(_, handle)| (*handle).to_owned())
            });
            rows.push((
                updated,
                OrcaRow {
                    group,
                    repo: text_of(worktree, "repo").unwrap_or_default().to_owned(),
                    branch: text_of(worktree, "displayName")
                        .unwrap_or_default()
                        .to_owned(),
                    line: line_of(agent),
                    at_ms: if group == OrcaGroup::Done {
                        updated
                    } else {
                        ms_of(agent, "stateStartedAt")
                    },
                    handle,
                    pane_key: pane_key.map(str::to_owned),
                    path: text_of(worktree, "path").unwrap_or_default().to_owned(),
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
            })
        })
        .collect()
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

/// The plugin's name of a skill whose `sourceLabel` is "Claude plugin {plugin}".
fn plugin_of(label: &str) -> Option<&str> {
    label
        .strip_prefix("Claude plugin ")
        .map(str::trim)
        .filter(|p| !p.is_empty())
}

/// The skills of `orca skills installed` (its `result`) that Claude Code runs, as the commands to type: a plugin's skill is `/plugin:name` (its `name` has no prefix), any other `/name`.
/// A command listed twice is kept once; the list is sorted by command.
pub fn skills_of(result: &Value) -> Vec<OrcaSkill> {
    let mut skills: Vec<OrcaSkill> = Vec::new();
    for skill in result["skills"].as_array().into_iter().flatten() {
        let for_claude = skill["providers"]
            .as_array()
            .is_some_and(|p| p.iter().any(|p| p == "claude"));
        let Some(name) = text_of(skill, "name").filter(|_| for_claude) else {
            continue;
        };
        let plugin = text_of(skill, "sourceLabel")
            .filter(|_| skill["sourceKind"] == "plugin")
            .and_then(plugin_of);
        let command = plugin.map_or_else(|| format!("/{name}"), |p| format!("/{p}:{name}"));
        if skills.iter().any(|s| s.command == command) {
            continue;
        }
        skills.push(OrcaSkill {
            command,
            description: text_of(skill, "description")
                .and_then(first_line)
                .unwrap_or_default(),
        });
    }
    skills.sort_by(|a, b| a.command.cmp(&b.command));
    skills
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
fn check_handle(handle: &str) -> Result<(), String> {
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

/// The path must be a worktree of the list read just now.
fn check_worktree(worktrees: &[OrcaWorktree], path: &str) -> Result<(), String> {
    if worktrees.iter().any(|w| w.path == path) {
        Ok(())
    } else {
        Err("起動先の worktree が見つかりません。一覧を読み直してください".into())
    }
}

/// A send the terminal did not take (`result.send.accepted` false) is a failure although the CLI answered `ok`.
fn check_accepted(result: &Value) -> Result<(), String> {
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

/// Never with `--environment`: the CLI refuses it (`invalid_environment`), since it lists the skills of the machine it runs on.
fn skills_args() -> Vec<String> {
    args_of(&["skills", "installed", "--json"])
}

/// Always Claude: the history of A-7 reads only Claude's sessions.
fn launch_args(path: &str, text: &str, environment: Option<&str>) -> Vec<String> {
    let mut args = args_of(&["agent", "launch", "--agent", "claude"]);
    args.extend([
        "--worktree".into(),
        format!("path:{path}"),
        "--surface".into(),
        "terminal".into(),
        format!("--prompt={text}"),
        "--json".into(),
    ]);
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
        (Ok(ps), Ok(terminals)) => OrcaOverview {
            target,
            environments,
            rows: rows_of(&ps, &terminals),
            worktrees: worktrees_of(&ps),
            known,
            ..OrcaOverview::empty(OrcaState::Ready)
        },
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

/// Runs a write of the CLI once. It is never run again: after a lost reply a second run would post twice (the CLI forbids a fresh retry of a launch).
fn write(args: &[String]) -> Result<(), String> {
    call(args, WRITE_TIMEOUT)
        .map_err(message_of)
        .and_then(|result| check_accepted(&result))
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
    write(&send_args(handle, text, environment))
}

fn launch(path: &str, text: &str, environment: Option<&str>) -> Result<(), String> {
    check_path(path)?;
    check_text(text)?;
    check_listed(environment)?;
    let (ps, _) = read_lists(environment, false);
    check_worktree(&worktrees_of(&ps.map_err(message_of)?), path)?;
    write(&launch_args(path, text, environment))
}

fn skills() -> Result<Vec<OrcaSkill>, String> {
    match call(&skills_args(), READ_TIMEOUT) {
        Ok(result) => Ok(skills_of(&result)),
        Err(RunError::Missing) => Err(not_installed()),
        Err(RunError::Failed(message)) => Err(message),
    }
}

fn set_target(dir: &Path, environment: Option<&str>) -> Result<(), String> {
    check_listed(environment)?;
    save_target(dir, environment)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
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
    blocking(move || overview(&dir, scope, target)).await
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

/// The skills of Claude Code on the machine the app runs on (whatever the target), for the composer's `/` completion.
#[tauri::command]
pub async fn orca_skills() -> Result<Vec<OrcaSkill>, String> {
    blocking(skills).await?
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

/// Starts Claude in the worktree at `path`, with `text` as its first prompt.
#[tauri::command]
pub async fn orca_launch(
    path: String,
    text: String,
    environment: Option<String>,
) -> Result<(), String> {
    blocking(move || launch(&path, &text, environment.as_deref())).await?
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
            "path": "/work/example", "repo": "example", "displayName": "feat/a",
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
        assert_eq!(line_of(&a), "Write the docs");
        a["prompt"] = json!("\n\n  \nfirst real line\nnext");
        assert_eq!(line_of(&a), "first real line");
        a["prompt"] = json!("  ");
        assert_eq!(line_of(&a), "Task");
        a["taskTitle"] = json!(" ");
        assert_eq!(line_of(&a), "Conversation");
        a["conversationName"] = Value::Null;
        assert_eq!(line_of(&a), "Answer");
        a.as_object_mut().unwrap().remove("lastAssistantMessage");
        assert_eq!(line_of(&a), "");
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
        assert_eq!(line_of(&a).chars().count(), LINE_LIMIT);
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
            let mut t =
                json!({"handle": handle, "tabId": "pty:p", "leafId": "pty:p", "orphaned": true});
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
            {"path": "/work/a", "repo": "a", "displayName": "main", "agents": []},
            {"repo": "no-path", "displayName": "x"},
            {"path": "/work/b", "repo": "b"},
        ]});
        assert_eq!(
            worktrees_of(&doc),
            [
                OrcaWorktree {
                    path: "/work/a".into(),
                    repo: "a".into(),
                    branch: "main".into()
                },
                OrcaWorktree {
                    path: "/work/b".into(),
                    repo: "b".into(),
                    branch: String::new()
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

    fn skill(name: &str, providers: &[&str], kind: &str, label: &str) -> Value {
        json!({
            "id": format!("id-{name}"), "name": name, "description": format!("About {name}\nmore"),
            "providers": providers, "sourceKind": kind, "sourceLabel": label,
        })
    }

    #[test]
    fn a_skill_is_a_command_of_claude_code() {
        let doc = json!({"skills": [
            skill("review", &["claude", "codex"], "home", "Claude Code home"),
            skill("only-codex", &["codex", "agent-skills"], "home", "Codex home"),
            skill("shared", &["claude"], "home", "Codex home"),
            skill("no-providers", &[], "home", "Claude Code home"),
        ]});
        assert_eq!(
            skills_of(&doc),
            [
                OrcaSkill {
                    command: "/review".into(),
                    description: "About review".into()
                },
                OrcaSkill {
                    command: "/shared".into(),
                    description: "About shared".into()
                },
            ]
        );
    }

    #[test]
    fn a_plugin_skill_is_called_with_its_plugin() {
        let doc = json!({"skills": [
            skill("yomiyasu", &["claude"], "plugin", "Claude plugin yomiyasu"),
            skill("mempalace-recall", &["claude"], "plugin", "Claude plugin mempalace"),
            // Not a Claude plugin label, or a plugin of another kind of source: no prefix.
            skill("other", &["claude"], "plugin", "Codex plugin cache"),
            skill("home", &["claude"], "home", "Claude plugin x"),
            skill("blank", &["claude"], "plugin", "Claude plugin  "),
        ]});
        let commands: Vec<_> = skills_of(&doc).into_iter().map(|s| s.command).collect();
        assert_eq!(
            commands,
            [
                "/blank",
                "/home",
                "/mempalace:mempalace-recall",
                "/other",
                "/yomiyasu:yomiyasu"
            ]
        );
    }

    #[test]
    fn skills_are_deduplicated_and_sorted_by_command() {
        let doc = json!({"skills": [
            skill("b", &["claude"], "home", "Claude Code home"),
            skill("a", &["claude"], "bundled", "Claude Code home"),
            skill("b", &["claude"], "home", "Claude Code home"),
            skill("a", &["claude"], "plugin", "Claude plugin p"),
        ]});
        let mut first = skill("b", &["claude"], "home", "Claude Code home");
        first["description"] = json!("second b");
        let doc_dup = json!({"skills": [doc["skills"][0].clone(), first]});
        let commands: Vec<_> = skills_of(&doc).into_iter().map(|s| s.command).collect();
        assert_eq!(commands, ["/a", "/b", "/p:a"]);
        // The first of two with one command is kept.
        assert_eq!(skills_of(&doc_dup)[0].description, "About b");
    }

    #[test]
    fn skills_tolerate_odd_documents_and_long_descriptions() {
        for doc in [
            Value::Null,
            json!({}),
            json!({"skills": null}),
            json!({"skills": [null, 3, {"providers": "claude", "name": "x"}, {"providers": ["claude"]}]}),
        ] {
            assert!(skills_of(&doc).is_empty(), "{doc}");
        }
        let mut long = skill("long", &["claude"], "home", "Claude Code home");
        long["description"] = json!("あ".repeat(1_000));
        let mut none = skill("none", &["claude"], "home", "Claude Code home");
        none.as_object_mut().unwrap().remove("description");
        let listed = skills_of(&json!({"skills": [long, none]}));
        assert_eq!(listed[0].description.chars().count(), LINE_LIMIT);
        assert_eq!(listed[1].description, "");
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
    fn the_skills_arguments() {
        // Never an environment: the CLI refuses it for this command.
        assert_eq!(skills_args(), ["skills", "installed", "--json"]);
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
            launch_args("/work/a", "--surface chat", None),
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
            launch_args("/work/a", "go", Some("Studio")).last().unwrap(),
            "--environment=Studio"
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
}
