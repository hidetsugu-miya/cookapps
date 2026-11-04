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
/// The agents a launch may start, as `orca agent launch --agent` takes them.
const AGENTS: [&str; 2] = ["claude", "codex"];
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
    /// The one line under the name: the task, and for a running agent the tool in use.
    pub line: String,
    /// "Claude", "Codex", or the agent's own type.
    pub agent: String,
    /// When the state began for a running or waiting agent, when it last changed for a done one (epoch milliseconds, 0 when unknown).
    #[cfg_attr(test, ts(type = "number"))]
    pub at_ms: i64,
    /// The terminal that takes a send; `None` when it was not found (the row cannot be selected).
    pub handle: Option<String>,
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
        }
    }
}

// ---- the CLI's JSON ----

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str().filter(|s| !s.trim().is_empty())
}

/// The first line of `text` that is not blank, cut to `LINE_LIMIT` characters.
fn first_line(text: &str) -> Option<String> {
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

fn agent_label(agent_type: &str) -> String {
    match agent_type {
        "claude" => "Claude".into(),
        "codex" => "Codex".into(),
        other => other.into(),
    }
}

/// The group an agent state belongs to: `waiting` and `blocked` need the user, `done` is finished, anything else (also a state not known yet) runs.
fn group_of(state: &str) -> OrcaGroup {
    match state {
        "waiting" | "blocked" => OrcaGroup::Waiting,
        "done" => OrcaGroup::Done,
        _ => OrcaGroup::Working,
    }
}

/// The text of a row's line: the task's title, else the conversation's name, else the first line of the prompt; a done agent prefers the first line of its last message,
/// a running one gets the tool in use after it.
fn line_of(agent: &Value, group: OrcaGroup) -> String {
    let task = text_of(agent, "taskTitle")
        .or_else(|| text_of(agent, "conversationName"))
        .and_then(first_line)
        .or_else(|| text_of(agent, "prompt").and_then(first_line));
    let text = if group == OrcaGroup::Done {
        text_of(agent, "lastAssistantMessage")
            .and_then(first_line)
            .or(task)
    } else {
        task
    };
    let tool = text_of(agent, "toolName").filter(|_| group == OrcaGroup::Working);
    match (text, tool) {
        (Some(text), Some(tool)) => format!("{text} ・ {tool} を実行中"),
        (Some(text), None) => text,
        (None, Some(tool)) => format!("{tool} を実行中"),
        (None, None) => String::new(),
    }
}

/// The rows of `orca worktree ps` (`ps`, its `result`) with the terminals of `orca terminal list` (`terminals`, its `result`): the top-level agents of a live terminal, newest first.
/// A field that is absent or of another type is left out, not an error.
pub fn rows_of(ps: &Value, terminals: &Value) -> Vec<OrcaRow> {
    // The pane of an agent is "{tabId}:{leafId}" of its terminal.
    let handles: Vec<(String, &str)> = terminals["terminals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            Some((
                format!("{}:{}", text_of(t, "tabId")?, text_of(t, "leafId")?),
                text_of(t, "handle")?,
            ))
        })
        .collect();
    let mut rows: Vec<(i64, OrcaRow)> = Vec::new();
    for worktree in ps["worktrees"].as_array().into_iter().flatten() {
        for agent in worktree["agents"].as_array().into_iter().flatten() {
            if !agent["parentPaneKey"].is_null() || agent["hasLivePty"] != true {
                continue;
            }
            let group = group_of(agent["state"].as_str().unwrap_or_default());
            let updated = ms_of(agent, "updatedAt");
            let handle = text_of(agent, "paneKey").and_then(|pane| {
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
                    line: line_of(agent, group),
                    agent: agent_label(agent["agentType"].as_str().unwrap_or_default()),
                    at_ms: if group == OrcaGroup::Done {
                        updated
                    } else {
                        ms_of(agent, "stateStartedAt")
                    },
                    handle,
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

/// The target a settings file holds; a file that does not say one (or none) gives `None`.
fn parse_target(text: &str) -> Option<Target> {
    serde_json::from_str(text).ok()
}

fn load_target(dir: &Path) -> Option<Target> {
    std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| parse_target(&text))
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

/// The environment to talk to (`None`: this machine). A saved target that is still listed stays; with nothing saved, or a saved environment that is gone, the first saved environment is used, else this machine.
fn resolve_target(saved: Option<Target>, environments: &[String]) -> Option<String> {
    match saved {
        Some(Target::Local) => None,
        Some(Target::Environment { name }) if environments.contains(&name) => Some(name),
        _ => environments.first().cloned(),
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

fn check_agent(agent: &str) -> Result<(), String> {
    if AGENTS.contains(&agent) {
        Ok(())
    } else {
        Err(format!("起動できないエージェントです: {agent}"))
    }
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

fn check_path(path: &str) -> Result<(), String> {
    if Path::new(path).is_absolute() {
        Ok(())
    } else {
        Err("worktree の場所が正しくありません".into())
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

fn skills_args(environment: Option<&str>) -> Vec<String> {
    with_environment(args_of(&["skills", "installed", "--json"]), environment)
}

fn launch_args(agent: &str, path: &str, text: &str, environment: Option<&str>) -> Vec<String> {
    let mut args = args_of(&["agent", "launch", "--agent", agent]);
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

fn overview(dir: &Path) -> OrcaOverview {
    let saved = load_target(dir);
    let failed =
        |message: String, target: Option<String>, environments: Vec<String>| OrcaOverview {
            message,
            target,
            environments,
            ..OrcaOverview::empty(OrcaState::Failed)
        };
    let environments = match read_environments() {
        Ok(environments) => environments,
        Err(RunError::Missing) => return OrcaOverview::empty(OrcaState::Missing),
        Err(RunError::Failed(message)) => {
            let target = match saved {
                Some(Target::Environment { name }) => Some(name),
                _ => None,
            };
            return failed(message, target, Vec::new());
        }
    };
    let target = resolve_target(saved, &environments);
    // Two processes, run side by side: the answer waits for the slower one, not for both.
    let (ps, terminals) = std::thread::scope(|scope| {
        let terminals = scope.spawn(|| call(&terminals_args(target.as_deref()), READ_TIMEOUT));
        let ps = call(&ps_args(target.as_deref()), READ_TIMEOUT);
        (ps, terminals.join().unwrap())
    });
    match (ps, terminals) {
        (Ok(ps), Ok(terminals)) => OrcaOverview {
            target,
            environments,
            rows: rows_of(&ps, &terminals),
            worktrees: worktrees_of(&ps),
            ..OrcaOverview::empty(OrcaState::Ready)
        },
        (Err(RunError::Missing), _) | (_, Err(RunError::Missing)) => {
            OrcaOverview::empty(OrcaState::Missing)
        }
        (Err(RunError::Failed(message)), _) | (_, Err(RunError::Failed(message))) => {
            failed(message, target, environments)
        }
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
    match call(args, WRITE_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(RunError::Missing) => Err(not_installed()),
        Err(RunError::Failed(message)) => Err(message),
    }
}

fn send(handle: &str, text: &str, environment: Option<&str>) -> Result<(), String> {
    check_handle(handle)?;
    check_text(text)?;
    check_listed(environment)?;
    write(&send_args(handle, text, environment))
}

fn launch(agent: &str, path: &str, text: &str, environment: Option<&str>) -> Result<(), String> {
    check_agent(agent)?;
    check_path(path)?;
    check_text(text)?;
    check_listed(environment)?;
    write(&launch_args(agent, path, text, environment))
}

fn skills(environment: Option<&str>) -> Result<Vec<OrcaSkill>, String> {
    check_listed(environment)?;
    match call(&skills_args(environment), READ_TIMEOUT) {
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

/// The agents of the Orca in use and the worktrees to start one in.
#[tauri::command]
pub async fn orca_overview(app: tauri::AppHandle) -> Result<OrcaOverview, String> {
    let dir = config_dir(&app)?;
    blocking(move || overview(&dir)).await
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

/// The skills of Claude Code on the Orca in use, for the composer's `/` completion.
#[tauri::command]
pub async fn orca_skills(environment: Option<String>) -> Result<Vec<OrcaSkill>, String> {
    blocking(move || skills(environment.as_deref())).await?
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

/// Starts `agent` in the worktree at `path`, with `text` as its first prompt.
#[tauri::command]
pub async fn orca_launch(
    agent: String,
    path: String,
    text: String,
    environment: Option<String>,
) -> Result<(), String> {
    blocking(move || launch(&agent, &path, &text, environment.as_deref())).await?
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
                agent: "Claude".into(),
                at_ms: 2_000,
                handle: Some("term_1".into()),
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
    fn the_line_takes_the_task_then_the_conversation_then_the_prompt() {
        let mut a = agent("tabA:leaf1", "working");
        a["taskTitle"] = json!("Task\nsecond");
        a["conversationName"] = json!("Conversation");
        assert_eq!(line_of(&a, OrcaGroup::Working), "Task");
        a["taskTitle"] = json!("  ");
        assert_eq!(line_of(&a, OrcaGroup::Working), "Conversation");
        a["conversationName"] = Value::Null;
        assert_eq!(line_of(&a, OrcaGroup::Working), "Write the docs");
        a["prompt"] = json!("\n\n  \nfirst real line\nnext");
        assert_eq!(line_of(&a, OrcaGroup::Working), "first real line");
        a.as_object_mut().unwrap().remove("prompt");
        assert_eq!(line_of(&a, OrcaGroup::Working), "");
    }

    #[test]
    fn a_done_row_prefers_the_first_line_of_the_last_message() {
        let mut a = agent("tabA:leaf1", "done");
        a["taskTitle"] = json!("Task");
        a["lastAssistantMessage"] = json!("\nDone: opened the pull request.\nDetails");
        assert_eq!(
            line_of(&a, OrcaGroup::Done),
            "Done: opened the pull request."
        );
        a["lastAssistantMessage"] = json!("   ");
        assert_eq!(line_of(&a, OrcaGroup::Done), "Task");
        // A running row does not show the last message.
        a["lastAssistantMessage"] = json!("Old answer");
        assert_eq!(line_of(&a, OrcaGroup::Working), "Task");
    }

    #[test]
    fn a_running_row_names_the_tool_in_use() {
        let mut a = agent("tabA:leaf1", "working");
        a["taskTitle"] = json!("Task");
        a["toolName"] = json!("Bash");
        assert_eq!(line_of(&a, OrcaGroup::Working), "Task ・ Bash を実行中");
        a["taskTitle"] = Value::Null;
        a.as_object_mut().unwrap().remove("prompt");
        assert_eq!(line_of(&a, OrcaGroup::Working), "Bash を実行中");
        // Only a running agent uses a tool; a waiting or done one does not.
        a["taskTitle"] = json!("Task");
        assert_eq!(line_of(&a, OrcaGroup::Waiting), "Task");
        assert_eq!(line_of(&a, OrcaGroup::Done), "Task");
    }

    #[test]
    fn a_long_line_is_cut() {
        let mut a = agent("tabA:leaf1", "working");
        a["taskTitle"] = json!("あ".repeat(LINE_LIMIT + 50));
        assert_eq!(line_of(&a, OrcaGroup::Working).chars().count(), LINE_LIMIT);
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
    fn an_agent_without_a_matching_terminal_has_no_handle() {
        let rows = rows_of(
            &ps(&[
                agent("tabZ:leafZ", "working"),
                json!({"parentPaneKey": null, "hasLivePty": true, "state": "working"}),
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
            "updatedAt": "soon", "stateStartedAt": null, "agentType": 4,
        }]}]});
        let rows = rows_of(&bare, &terminals());
        assert_eq!(
            rows,
            [OrcaRow {
                group: OrcaGroup::Working,
                repo: String::new(),
                branch: String::new(),
                line: String::new(),
                agent: String::new(),
                at_ms: 0,
                handle: None,
            }]
        );
    }

    #[test]
    fn an_agent_type_that_is_not_known_is_shown_as_it_is() {
        let mut a = agent("tabA:leaf1", "working");
        a["agentType"] = json!("codex");
        assert_eq!(rows_of(&ps(&[a.clone()]), &terminals())[0].agent, "Codex");
        a["agentType"] = json!("gemini");
        assert_eq!(rows_of(&ps(&[a]), &terminals())[0].agent, "gemini");
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
    fn only_listed_agents_launch() {
        assert!(check_agent("claude").is_ok());
        assert!(check_agent("codex").is_ok());
        for bad in ["", "Claude", "gemini", "claude --x", "--agent"] {
            assert!(check_agent(bad).is_err(), "{bad}");
        }
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
    fn the_skills_arguments() {
        assert_eq!(skills_args(None), ["skills", "installed", "--json"]);
        assert_eq!(
            skills_args(Some("Studio")),
            ["skills", "installed", "--json", "--environment=Studio"]
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
            launch_args("codex", "/work/a", "--surface chat", None),
            [
                "agent",
                "launch",
                "--agent",
                "codex",
                "--worktree",
                "path:/work/a",
                "--surface",
                "terminal",
                "--prompt=--surface chat",
                "--json"
            ]
        );
        assert_eq!(
            launch_args("claude", "/work/a", "go", Some("Studio"))
                .last()
                .unwrap(),
            "--environment=Studio"
        );
    }

    #[test]
    fn a_saved_target_stays_while_it_is_listed() {
        let saved = vec!["Studio".to_owned(), "Lab".to_owned()];
        let env = |name: &str| Some(Target::Environment { name: name.into() });
        assert_eq!(resolve_target(env("Lab"), &saved).as_deref(), Some("Lab"));
        assert_eq!(resolve_target(Some(Target::Local), &saved), None);
        // Nothing saved, or a saved environment that is gone: the first one, else this machine.
        assert_eq!(resolve_target(None, &saved).as_deref(), Some("Studio"));
        assert_eq!(
            resolve_target(env("Gone"), &saved).as_deref(),
            Some("Studio")
        );
        assert_eq!(resolve_target(None, &[]), None);
        assert_eq!(resolve_target(env("Gone"), &[]), None);
        assert_eq!(resolve_target(Some(Target::Local), &[]), None);
    }

    #[test]
    fn the_target_setting_reads_what_it_says_and_nothing_else() {
        assert_eq!(parse_target(r#"{"kind":"local"}"#), Some(Target::Local));
        assert_eq!(
            parse_target(r#"{"kind":"environment","name":"Studio"}"#),
            Some(Target::Environment {
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
            assert_eq!(parse_target(text), None, "{text}");
        }
    }

    #[test]
    fn the_target_load_gives_what_save_wrote() {
        let dir = std::env::temp_dir().join(format!("cookapps-orca-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_target(&dir), None);
        save_target(&dir, Some("Studio")).unwrap();
        assert_eq!(
            load_target(&dir),
            Some(Target::Environment {
                name: "Studio".into()
            })
        );
        save_target(&dir, None).unwrap();
        assert_eq!(load_target(&dir), Some(Target::Local));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
