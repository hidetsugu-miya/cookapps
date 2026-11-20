//! A-36: the shared part of the Claude Code panes. tsunagiai opens a pseudo terminal itself (`portable-pty`, no Orca in between) and runs Claude Code in it; the screen draws it with xterm.js (`ts/claude-code.ts`).
//! Claude Code runs in a folder of its own, `claude-code/` in the app config directory, which holds a launch script and the `--mcp-config` file. The script is written by the app in a fixed form
//! (only paths the app decided are in it: nothing that comes from a mail, a message or a Todo), and it starts `claude --tools '' --permission-mode manual --setting-sources user --strict-mcp-config --mcp-config {the file}` (the built-in tools stay on when the screen asks, as the database screen does).
//! `manual` asks for every tool that writes, whatever `defaultMode` the owner's settings hold, and `--setting-sources user` leaves out the project and local settings of the shared folder, so an "always allow" chosen in one pane does not reach the others.
//! The calendar pane (C-6) starts in `auto` (#1074, `start-auto.sh`): it runs with no built-in tools and with an MCP config (`mcp-calendar.json`) that starts `tsunagiai-mcp --calendar`, which offers only the tools of the calendar screen (`CALENDAR_TOOLS`), so that no other tool that writes runs unasked.
//! The Slack compose pane (S-4) starts in `auto` too (#1144, `start-auto-slack-compose.sh`, `mcp-slack-compose.json`, `tsunagiai-mcp --slack-compose`, `SLACK_COMPOSE_TOOLS`), with `--model sonnet --effort high`, and `--settings` makes `slack_compose_post` ask the owner before a post.
//! The MCP config names `tsunagiai-mcp` next to the app's own executable (`Contents/MacOS/` in the bundle) and nothing else; the child is started as an argument array, with no shell of ours in between except `/bin/sh` running the script.
//! A session is a process group of its own (the pseudo terminal makes the child a session leader): closing a pane, the end of the app, and a screen that no longer takes the output stop the whole group.
//! What the terminal prints and the keys typed are only in the channel of the pane: no log line, no error text.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};
#[cfg(test)]
use ts_rs::TS;

use crate::{
    claude_auth::{self, EnvChange},
    formation_message,
    orca_stream::OrcaViewport,
    skills::{self, CallPlugin, SkillScreen},
};

/// The folder of Claude Code in the app config directory, which `claude` runs in.
const FOLDER: &str = "claude-code";
const MCP_FILE: &str = "mcp.json";
const SCRIPT_FILE: &str = "start.sh";
const SCRIPT_WITH_TOOLS_FILE: &str = "start-with-tools.sh";
/// #1074: the script and the MCP config of a pane in the `auto` permission mode.
const SCRIPT_AUTO_FILE: &str = "start-auto.sh";
const MCP_CALENDAR_FILE: &str = "mcp-calendar.json";
/// The script and the MCP config of the pane of the Slack compose screen, which starts in `auto` too (S-4, #1144).
const SCRIPT_AUTO_SLACK_COMPOSE_FILE: &str = "start-auto-slack-compose.sh";
const MCP_SLACK_COMPOSE_FILE: &str = "mcp-slack-compose.json";
/// The argument that makes `tsunagiai-mcp` offer the tools of the calendar pane only (`CALENDAR_TOOLS`, C-6).
const CALENDAR_MCP_ARG: &str = "--calendar";
/// The argument that makes `tsunagiai-mcp` offer the tools of the Slack compose pane only (`SLACK_COMPOSE_TOOLS`, S-4).
const SLACK_COMPOSE_MCP_ARG: &str = "--slack-compose";
/// A-37: the orchestrator of a formation is the pane whose id is this prefix and the formation's name (the screen names its pane so), and it runs in `formations/{name}/` of the config directory, not in `claude-code/`.
const FORMATION_ID_PREFIX: &str = "formation:";
const FORMATION_CLAUDE_MD_FILE: &str = "CLAUDE.md";
/// The text of the orchestrator's `CLAUDE.md`: its role and its steps, with `{name}` where its own name goes. It holds nothing that comes from outside.
const FORMATION_CLAUDE_MD: &str = include_str!("formation_claude.md");
const FORMATION_NAME_MARK: &str = "{name}";
/// A-41: the leader's skill is `feature-dev`, in `.claude/skills/` of the orchestrator's folder.
const LEADER_SKILL_FOLDER: &str = "feature-dev";
/// The argument that makes `tsunagiai-mcp` offer the tools of the orchestrator (`formation_*`), which the panes' own `mcp.json` does not pass. The name of the formation follows it.
const FORMATION_MCP_ARG: &str = "--formation";
/// The name the MCP server has in Claude Code (`mcp__tsunagiai__...`), as in `.mcp.json` of the repository.
const MCP_NAME: &str = "tsunagiai";
const MCP_BINARY: &str = "tsunagiai-mcp";
/// The tool that posts to Slack, as Claude Code names a tool of an MCP server (`mcp__{server}__{tool}`). The Slack compose pane asks the owner before it runs, though it is in `auto` (#1144).
const SLACK_COMPOSE_POST_TOOL: &str = "mcp__tsunagiai__slack_compose_post";
/// The characters one send of keys may carry (the screen sends at most half of it).
const INPUT_LIMIT: usize = 100_000;
/// The most cells a side of the terminal may have.
const SIZE_LIMIT: u16 = 1000;
/// How long a process group may take to end after SIGTERM before SIGKILL.
const GRACE: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(25);
const READ_BUFFER: usize = 16 * 1024;
/// The id of a pane, as the screen names it.
const ID_LIMIT: usize = 200;

/// What a pane's channel carries.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClaudeCodeEvent {
    /// What the terminal printed.
    Output { data: String },
    /// The process ended (`message` says how, in Japanese; `clean` is true only when it ended by itself with the exit code 0). Nothing follows.
    Ended { message: String, clean: bool },
}

/// How the pane's Claude Code asks for a tool (#1074): `manual` asks the owner for every tool that writes, `auto` runs the tools with no question, so it has the tools of the calendar only and none of Claude Code's own.
/// `auto-slack-compose` (#1144) is the Slack compose pane's `auto`: the tools of that screen only, the model Sonnet at the effort high, and a question before `slack_compose_post`.
/// The screen names one of the three, and any other text is refused when the argument is read.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum ClaudeCodePermissionMode {
    #[default]
    Manual,
    Auto,
    #[serde(rename = "auto-slack-compose")]
    AutoSlackCompose,
}

/// A saved skill that the pane's Claude Code is given with `--plugin-dir` (A-32).
#[derive(Deserialize, Debug)]
pub struct ClaudeCodeSkill {
    pub name: String,
    pub screen: SkillScreen,
}

// ---- the files Claude Code starts from ----

/// `claude-code/` in the config directory.
pub fn claude_code_dir(config: &Path) -> PathBuf {
    config.join(FOLDER)
}

/// The text of `mcp.json`: the one MCP server, `tsunagiai-mcp` at `mcp`, started with `args`.
pub(crate) fn mcp_config(mcp: &Path, args: &[&str]) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": { MCP_NAME: { "command": mcp.to_string_lossy(), "args": args } }
    }))
    .unwrap_or_default()
}

/// `text` as one word of a POSIX shell: in single quotes, a quote in it closed, escaped and opened again.
pub(crate) fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// The launch script. Only the three paths the app decided and the fixed flags are in it; what the app adds at the start (`--plugin-dir`) comes as arguments of the script, `"$@"`.
/// `--tools ''` takes the built-in tools off, so that a text in a mail or a message cannot make Claude Code run a command; `--permission-mode manual` asks the owner for every tool that writes (the `defaultMode` of the user settings does not decide it);
/// `--setting-sources user` does not read the `.claude/settings*.json` of the shared folder, where an "always allow" would stay for every pane; `--strict-mcp-config` leaves the MCP servers of any other file out.
fn launch_script(claude: &Path, mcp_config: &Path, builtin_tools: bool) -> String {
    let tools = if builtin_tools { "" } else { " --tools ''" };
    format!(
        "#!/bin/sh\n\
         # Written by tsunagiai (A-36) at each start of a Claude Code pane; a change here is lost.\n\
         PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"\n\
         exec {claude}{tools} --permission-mode manual --setting-sources user --strict-mcp-config --mcp-config {config} \"$@\"\n",
        claude = sh_quote(&claude.to_string_lossy()),
        config = sh_quote(&mcp_config.to_string_lossy()),
    )
}

/// The launch script of a pane in the `auto` permission mode (#1074): the same shape as `launch_script` without the built-in tools, with `--permission-mode auto`, and the MCP config that offers the calendar tools only.
fn auto_launch_script(claude: &Path, mcp_config: &Path) -> String {
    auto_script(claude, mcp_config, "")
}

/// The launch script of the Slack compose pane (S-4, #1144): the `auto` script with `--model sonnet --effort high`, and `--settings` that makes `slack_compose_post` ask the owner (`permissions.ask`, which `auto` still obeys). The settings are the fixed text of the tool's name.
fn slack_compose_launch_script(claude: &Path, mcp_config: &Path) -> String {
    let settings =
        serde_json::json!({"permissions": {"ask": [SLACK_COMPOSE_POST_TOOL]}}).to_string();
    auto_script(
        claude,
        mcp_config,
        &format!(
            " --model sonnet --effort high --settings {}",
            sh_quote(&settings)
        ),
    )
}

/// The `auto` script with `flags` after `--permission-mode auto`: each is a fixed flag and a value the app decided.
fn auto_script(claude: &Path, mcp_config: &Path, flags: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # Written by tsunagiai (A-36) at each start of a Claude Code pane; a change here is lost.\n\
         PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"\n\
         exec {claude} --tools '' --permission-mode auto{flags} --setting-sources user --strict-mcp-config --mcp-config {config} \"$@\"\n",
        claude = sh_quote(&claude.to_string_lossy()),
        config = sh_quote(&mcp_config.to_string_lossy()),
    )
}

/// What a start may ask for: `auto` runs tools with no question, so it is never given Claude Code's own tools (Bash would run unasked), and the orchestrator has its own script and mode (A-37).
fn check_permission_mode(
    formation: bool,
    builtin_tools: bool,
    mode: ClaudeCodePermissionMode,
) -> Result<(), String> {
    if mode == ClaudeCodePermissionMode::Manual {
        return Ok(());
    }
    if builtin_tools {
        return Err("auto mode のペインでは、Claude Code 自身のツールは使えません".to_owned());
    }
    if formation {
        return Err("オーケストレーターの権限モードは、画面からは選べません".to_owned());
    }
    Ok(())
}

/// The launch script of the orchestrator (A-37): the same shape, with Claude Code's own tools (no `--tools ''`), named by its formation (`-n {name}`), in the `auto` permission mode, at the effort `high` (#911), and reading the project settings of its folder too. `--settings {hook}` is the hook that records its SendMessage calls (`formation_message`, #1084).
/// Only the two paths and the name that the app decided (`name` has passed `check_name`) and the fixed flags are in it.
fn formation_script(claude: &Path, mcp_config: &Path, hook: &Path, name: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # Written by tsunagiai (A-37) at each start of the orchestrator; a change here is lost.\n\
         PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"\n\
         exec {claude} -n {name} --permission-mode auto --effort high --setting-sources user,project --settings {hook} --strict-mcp-config --mcp-config {config} \"$@\"\n",
        claude = sh_quote(&claude.to_string_lossy()),
        name = sh_quote(name),
        hook = sh_quote(&hook.to_string_lossy()),
        config = sh_quote(&mcp_config.to_string_lossy()),
    )
}

/// The `CLAUDE.md` of the orchestrator named `name`: its own name is the one the children tell by SendMessage.
fn formation_claude_md(name: &str) -> String {
    FORMATION_CLAUDE_MD.replace(FORMATION_NAME_MARK, name)
}

/// The name of the formation whose orchestrator the pane `id` is, or none for any other pane.
fn formation_of(id: &str) -> Option<&str> {
    id.strip_prefix(FORMATION_ID_PREFIX)
}

/// The arguments of `/bin/sh`: the script, then `--plugin-dir {folder}` when the pane has a skill, then `--` and `prompt`, the one positional argument of `claude [prompt]`, its first instruction. The `--` is needed because the script ends with `--mcp-config`, which takes several values, and would take the prompt for one of them (measured: `claude --mcp-config a.json "x"` reads `x` as a config file); it also keeps a prompt from being read as an option. The shell is not asked to read the prompt: it is one element of the list, and the script passes it on as `"$@"`.
fn launch_args(script: &Path, plugin_dir: Option<&Path>, prompt: Option<String>) -> Vec<String> {
    let mut args = vec![script.to_string_lossy().into_owned()];
    if let Some(dir) = plugin_dir {
        args.push("--plugin-dir".to_owned());
        args.push(dir.to_string_lossy().into_owned());
    }
    if let Some(prompt) = prompt {
        args.push("--".to_owned());
        args.push(prompt);
    }
    args
}

/// `tsunagiai-mcp` next to the executable `exe`: in the app bundle it is `Contents/MacOS/tsunagiai-mcp`.
fn mcp_binary(exe: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        format!("{MCP_BINARY}.exe")
    } else {
        MCP_BINARY.to_owned()
    };
    exe.with_file_name(name)
}

/// `tsunagiai-mcp` for `exe`, or why there is none (a development build has it only after `cargo build --bin tsunagiai-mcp`).
pub(crate) fn checked_mcp_binary(exe: &Path) -> Result<PathBuf, String> {
    let path = mcp_binary(exe);
    if path.is_file() {
        return Ok(path);
    }
    Err(format!(
        "{MCP_BINARY} が見つかりません（{}）。開発ビルドでは cargo build --bin {MCP_BINARY} で作ってください",
        path.display()
    ))
}

/// Where `claude` is: the first of `candidates` that is a file, a name with no folder searched in `path_dirs`.
fn find_claude(
    candidates: &[PathBuf],
    path_dirs: &[PathBuf],
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    candidates.iter().find_map(|candidate| {
        if candidate.components().count() > 1 {
            return is_file(candidate).then(|| candidate.clone());
        }
        path_dirs
            .iter()
            .map(|dir| dir.join(candidate))
            .find(|path| is_file(path))
    })
}

/// The folders `claude` is searched in: the app's own PATH (a GUI app has a short one), then the two folders a package manager puts it in.
fn search_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain(["/usr/local/bin", "/opt/homebrew/bin"].map(PathBuf::from))
        .collect()
}

fn claude_path() -> Result<PathBuf, String> {
    find_claude(
        &crate::claude::locations(dirs::home_dir(), cfg!(windows)),
        &search_dirs(),
        Path::is_file,
    )
    .ok_or_else(|| "Claude Code が見つかりません。入れてから、もう一度試してください".to_owned())
}

/// Two panes may start together and write the same files: one at a time (the files are replaced whole, with the same text for the same choice).
static FILES: Mutex<()> = Mutex::new(());

/// Writes `mcp.json` and the launch script in `claude-code/` of `config` and answers the script's path. In the `auto` mode it writes `mcp-calendar.json` (`--calendar`) and `start-auto.sh` instead, and in `auto-slack-compose` `mcp-slack-compose.json` (`--slack-compose`) and `start-auto-slack-compose.sh`, and `builtin_tools` has been refused before (`check_permission_mode`).
fn write_files(
    config: &Path,
    claude: &Path,
    mcp: &Path,
    builtin_tools: bool,
    mode: ClaudeCodePermissionMode,
) -> Result<PathBuf, String> {
    let dir = claude_code_dir(config);
    let _writing = FILES.lock().unwrap_or_else(|e| e.into_inner());
    if mode == ClaudeCodePermissionMode::Auto {
        crate::accounts::write_atomic(
            &dir,
            MCP_CALENDAR_FILE,
            &mcp_config(mcp, &[CALENDAR_MCP_ARG]),
        )?;
        crate::accounts::write_atomic(
            &dir,
            SCRIPT_AUTO_FILE,
            &auto_launch_script(claude, &dir.join(MCP_CALENDAR_FILE)),
        )?;
        return Ok(dir.join(SCRIPT_AUTO_FILE));
    }
    if mode == ClaudeCodePermissionMode::AutoSlackCompose {
        crate::accounts::write_atomic(
            &dir,
            MCP_SLACK_COMPOSE_FILE,
            &mcp_config(mcp, &[SLACK_COMPOSE_MCP_ARG]),
        )?;
        crate::accounts::write_atomic(
            &dir,
            SCRIPT_AUTO_SLACK_COMPOSE_FILE,
            &slack_compose_launch_script(claude, &dir.join(MCP_SLACK_COMPOSE_FILE)),
        )?;
        return Ok(dir.join(SCRIPT_AUTO_SLACK_COMPOSE_FILE));
    }
    let script = if builtin_tools {
        SCRIPT_WITH_TOOLS_FILE
    } else {
        SCRIPT_FILE
    };
    crate::accounts::write_atomic(&dir, MCP_FILE, &mcp_config(mcp, &[]))?;
    crate::accounts::write_atomic(
        &dir,
        script,
        &launch_script(claude, &dir.join(MCP_FILE), builtin_tools),
    )?;
    Ok(dir.join(script))
}

/// Writes `CLAUDE.md`, `mcp.json`, the launch script, the hook of its SendMessage calls `message-hook.json` (#1084), an empty `.claude/settings.json` and the leader's skill `.claude/skills/feature-dev/` (A-41, replaced as a whole) in `formations/{name}/` of `config` and answers the script's path. The other files of the folder stay. `mcp.json` names the formation (`--formation {name}`), so that the tools of `tsunagiai-mcp` read and write the record of that formation only.
/// The orchestrator reads the project settings of its folder (`--setting-sources user,project`), and it can write there in auto mode: the settings are made empty at each start, so a permission or a hook it added does not stay for the next one.
fn write_formation_files(
    config: &Path,
    name: &str,
    claude: &Path,
    mcp: &Path,
) -> Result<PathBuf, String> {
    crate::formation::check_name(name)?;
    crate::formation::migrate_legacy(config)?;
    let dir = crate::formation::dir(config, name);
    let _writing = FILES.lock().unwrap_or_else(|e| e.into_inner());
    crate::accounts::write_atomic(&dir, FORMATION_CLAUDE_MD_FILE, &formation_claude_md(name))?;
    crate::accounts::write_atomic(&dir, MCP_FILE, &mcp_config(mcp, &[FORMATION_MCP_ARG, name]))?;
    crate::accounts::write_atomic(
        &dir,
        SCRIPT_FILE,
        &formation_script(
            claude,
            &dir.join(MCP_FILE),
            &dir.join(formation_message::LEADER_HOOK_FILE),
            name,
        ),
    )?;
    crate::accounts::write_atomic(
        &dir,
        formation_message::LEADER_HOOK_FILE,
        &formation_message::hook_settings(mcp, name, None),
    )?;
    write_empty_settings(&dir.join(".claude"))?;
    write_leader_skill(&dir.join(".claude"))?;
    Ok(dir.join(SCRIPT_FILE))
}

/// What `tsunagiai-mcp --formation-start {name}` runs in place of itself (A-37): the launch script of the orchestrator under `/bin/sh`, in the folder of its formation.
#[derive(Debug, PartialEq)]
pub struct FormationStart {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

/// The start of the orchestrator on this machine, for `tsunagiai-mcp` at `mcp` (the running one): the files written as the app writes them for its own pane (`write_formation_files`), and the command that runs the script. `claude` is found as the panes find it. `projects` are the repositories of its formation, all of this machine (`local`): they are its first instruction, passed as `claude [prompt]` as in the pane of the app, so nothing has to be typed into the terminal (a typed text would wait behind Claude Code's question whether to trust the folder, which the owner answers on the screen, and which nothing here answers). With no project there is no instruction. A name that `first_prompt` refuses is an error before any file is written.
pub fn formation_start(
    config: &Path,
    name: &str,
    projects: &[String],
    mcp: &Path,
) -> Result<FormationStart, String> {
    formation_start_with(config, name, projects, &claude_path()?, mcp)
}

fn formation_start_with(
    config: &Path,
    name: &str,
    projects: &[String],
    claude: &Path,
    mcp: &Path,
) -> Result<FormationStart, String> {
    let prompt = crate::formation::local_first_prompt(projects)?;
    let script = write_formation_files(config, name, claude, mcp)?;
    Ok(FormationStart {
        program: "/bin/sh".to_owned(),
        args: launch_args(&script, None, prompt),
        cwd: crate::formation::dir(config, name),
    })
}

/// Removes `path` when it is a link, so that a write there does not follow it. The orchestrator can write in its folder, so a link it placed is what this meets.
fn drop_link(path: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        std::fs::remove_file(path).map_err(|e| format!("{} を外せません: {e}", path.display()))?;
    }
    Ok(())
}

/// Writes `{}` as `settings.json` in `claude_dir`. The orchestrator can write in its folder, so a link it placed there (the folder, the file or its temporary file) is removed first, and what it leads to is not written.
fn write_empty_settings(claude_dir: &Path) -> Result<(), String> {
    drop_link(claude_dir)?;
    std::fs::create_dir_all(claude_dir)
        .map_err(|e| format!("{} を作れません: {e}", claude_dir.display()))?;
    drop_link(&claude_dir.join("settings.json.tmp"))?;
    drop_link(&claude_dir.join("settings.json"))?;
    crate::accounts::write_atomic(claude_dir, "settings.json", "{}")
}

/// Replaces `skills/feature-dev/` in `claude_dir` with the leader's skill (A-41), as a whole: a file that the skill no longer has does not stay. A link in the place of `skills/` is removed first, as for the settings.
fn write_leader_skill(claude_dir: &Path) -> Result<(), String> {
    let skills = claude_dir.join("skills");
    drop_link(&skills)?;
    crate::formation_assets::replace_dir(
        &skills.join(LEADER_SKILL_FOLDER),
        crate::formation_assets::LEADER_SKILL,
    )
}

// ---- the pseudo terminal ----

/// What to run in a pseudo terminal, and the size it starts with.
struct Spec {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    env: Vec<EnvChange>,
    cols: u16,
    rows: u16,
}

type Sink = Box<dyn FnMut(ClaudeCodeEvent) -> bool + Send>;

/// The text of `bytes` after what is held from before: a character cut at the end waits in `pending` for the next read, a byte that is not UTF-8 becomes U+FFFD.
fn take_text(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    let mut text = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(all) => {
                text.push_str(all);
                pending.clear();
                return text;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                text.push_str(&String::from_utf8_lossy(&pending[..valid]));
                match e.error_len() {
                    Some(bad) => {
                        text.push('\u{FFFD}');
                        pending.drain(..valid + bad);
                    }
                    None => {
                        pending.drain(..valid);
                        return text;
                    }
                }
            }
        }
    }
}

/// The end of the process as the pane gets it: the words, and whether it was an exit with the code 0 (a failed read of the status, an exit code and a signal are not).
fn ended_event(status: std::io::Result<portable_pty::ExitStatus>) -> ClaudeCodeEvent {
    let clean = matches!(&status, Ok(status) if status.success());
    ClaudeCodeEvent::Ended {
        message: ended_text(status),
        clean,
    }
}

/// How the process ended, for the pane.
fn ended_text(status: std::io::Result<portable_pty::ExitStatus>) -> String {
    match status {
        Ok(status) if status.success() => "Claude Code が終わりました".to_owned(),
        Ok(status) => match status.signal() {
            Some(signal) => format!("Claude Code が終わりました（{signal}）"),
            None => format!(
                "Claude Code が終わりました（終了コード {}）",
                status.exit_code()
            ),
        },
        Err(e) => format!("Claude Code の終わり方を読めません: {e}"),
    }
}

#[cfg(unix)]
fn signal_group(pgid: i32, signal: i32) {
    // SAFETY: `kill` with a negative pid only sends a signal to a group; it touches no memory of ours.
    unsafe {
        libc::kill(-pgid, signal);
    }
}

#[cfg(not(unix))]
fn signal_group(_pgid: i32, _signal: i32) {}

#[cfg(unix)]
const TERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const KILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const TERM: i32 = 15;
#[cfg(not(unix))]
const KILL: i32 = 9;

/// Ends the process groups: SIGTERM to each, then SIGKILL to each that has not ended after `grace` (a group also holds what the process started, which a process that ended by itself does not take with it).
/// `ended` is set once the leader has been waited for. A pgid is not used again while a process of the group is there, and the signal is sent only after this has sent SIGTERM to the same group.
fn stop_groups(groups: &[(i32, Arc<AtomicBool>)], grace: Duration) {
    let groups: Vec<_> = groups.iter().filter(|(pgid, _)| *pgid > 0).collect();
    for (pgid, _) in &groups {
        signal_group(*pgid, TERM);
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && !groups.iter().all(|(_, ended)| ended.load(Ordering::SeqCst))
    {
        std::thread::sleep(POLL);
    }
    for (pgid, _) in &groups {
        signal_group(*pgid, KILL);
    }
}

/// `stop_groups` for one group on a thread of its own, so that a close does not wait for the grace.
fn stop_later(pgid: i32, ended: Arc<AtomicBool>) {
    std::thread::spawn(move || stop_groups(&[(pgid, ended)], GRACE));
}

/// The title that the program in a pane's terminal last wrote (OSC 0 or 2), as the pane's reader keeps it; `None` until it writes one.
type Title = Arc<Mutex<Option<String>>>;

/// The longest part of an unfinished title sequence that is kept for the next read; a longer one is no title.
const TITLE_CARRY_LIMIT: usize = 1024;

/// Finds the titles in the text a terminal prints (`ESC ] 0 ; title BEL`, `ESC ] 2 ; title ESC \`), also when a read cuts one in two (#915: Claude Code writes `✳` first in it while it waits for input, `formation::title_waits`).
#[derive(Default)]
struct TitleScan {
    carry: String,
}

impl TitleScan {
    /// Takes the next text and answers the last complete title in it, if there is one.
    fn feed(&mut self, text: &str) -> Option<String> {
        // Only a read that follows a cut one is joined to it; the others are scanned as they are, with no copy of the output.
        let joined;
        let all = if self.carry.is_empty() {
            text
        } else {
            joined = std::mem::take(&mut self.carry) + text;
            joined.as_str()
        };
        let mut last = None;
        let mut rest = all;
        while let Some(at) = rest.find('\x1b') {
            let from_escape = &rest[at..];
            let Some(body) = from_escape.strip_prefix("\x1b]") else {
                if from_escape.len() == 1 {
                    self.keep(from_escape);
                    break;
                }
                rest = &from_escape[1..];
                continue;
            };
            let Some(end) = body.find(['\x07', '\x1b']) else {
                self.keep(from_escape);
                break;
            };
            let after = &body[end + 1..];
            if body.as_bytes()[end] == 0x1b {
                if after.is_empty() {
                    self.keep(from_escape);
                    break;
                }
                if !after.starts_with('\\') {
                    rest = &body[end..];
                    continue;
                }
            }
            if let Some(("0" | "2", title)) = body[..end].split_once(';') {
                last = Some(title.to_owned());
            }
            rest = if body.as_bytes()[end] == 0x1b {
                &after[1..]
            } else {
                after
            };
        }
        last
    }

    fn keep(&mut self, tail: &str) {
        if tail.len() <= TITLE_CARRY_LIMIT {
            self.carry = tail.to_owned();
        }
    }
}

/// A pane's process. Dropping it closes the terminal; the plugin folder of the pane's skill goes with it.
struct Session {
    seq: u64,
    title: Title,
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<String>,
    pgid: i32,
    ended: Arc<AtomicBool>,
    _plugin: Option<CallPlugin>,
}

/// What reads the terminal until the process ends.
struct Reader {
    reader: Box<dyn Read + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    sink: Sink,
    pgid: i32,
    ended: Arc<AtomicBool>,
    title: Title,
}

#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<String, Session>>,
    seq: AtomicU64,
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forgets the session `seq` of `id` once its process has ended (a newer session of the same id stays).
    fn forget(&self, id: &str, seq: u64) {
        let mut sessions = self.lock();
        if sessions.get(id).is_some_and(|s| s.seq == seq) {
            sessions.remove(id);
        }
    }
}

impl Reader {
    /// Gives what the terminal prints to the sink until the end of the output, then waits for the process and tells the sink how it ended.
    /// A sink that takes no more (the screen is gone) ends the group.
    fn run(mut self, inner: &Inner, id: &str, seq: u64) {
        let mut buffer = vec![0u8; READ_BUFFER];
        let mut pending = Vec::new();
        let mut taken = true;
        // Only the leader of a formation has its title read (`formation_title`).
        let mut scan = formation_of(id).map(|_| TitleScan::default());
        loop {
            match self.reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = take_text(&mut pending, &buffer[..n]);
                    if let Some(title) = scan.as_mut().and_then(|scan| scan.feed(&data)) {
                        *self.title.lock().unwrap_or_else(|e| e.into_inner()) = Some(title);
                    }
                    if !data.is_empty() && !(self.sink)(ClaudeCodeEvent::Output { data }) {
                        taken = false;
                        break;
                    }
                }
            }
        }
        if !taken {
            stop_later(self.pgid, self.ended.clone());
        } else if !pending.is_empty() {
            let data = String::from_utf8_lossy(&pending).into_owned();
            taken = (self.sink)(ClaudeCodeEvent::Output { data });
        }
        let status = self.child.wait();
        self.ended.store(true, Ordering::SeqCst);
        if taken {
            (self.sink)(ended_event(status));
        }
        inner.forget(id, seq);
    }
}

/// Whether a variable of the environment makes a Claude Code of ours take its pane for Orca's: Orca's own (`ORCA_*`, which its state hooks read) and those of its orchestration (`CLAUDE_CODE_MESSAGING_*`).
/// They are in the environment when `tauri dev` runs in a terminal of Orca.
fn is_orca_env(name: &str) -> bool {
    name.starts_with("ORCA_") || name.starts_with("CLAUDE_CODE_MESSAGING_")
}

/// Takes the variables of Orca out of what `command` inherits.
fn remove_orca_env(command: &mut CommandBuilder) {
    let names: Vec<String> = command
        .iter_full_env_as_str()
        .map(|(name, _)| name)
        .filter(|name| is_orca_env(name))
        .map(str::to_owned)
        .collect();
    for name in names {
        command.env_remove(name);
    }
}

/// Opens the pseudo terminal and starts the process in it.
fn open(
    spec: &Spec,
    seq: u64,
    plugin: Option<CallPlugin>,
    sink: Sink,
) -> Result<(Session, Reader), String> {
    let size = PtySize {
        rows: spec.rows,
        cols: spec.cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("疑似端末を開けません: {e}"))?;
    let mut command = CommandBuilder::new(&spec.program);
    command.args(&spec.args);
    command.cwd(&spec.cwd);
    remove_orca_env(&mut command);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    for change in &spec.env {
        match change {
            EnvChange::Set(name, value) => command.env(name, value),
            EnvChange::Remove(name) => command.env_remove(name),
        }
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Claude Code を起動できません: {e}"))?;
    // Only the child holds the slave now, so the end of the child is the end of the output.
    drop(pair.slave);
    let pgid = child
        .process_id()
        .and_then(|pid| i32::try_from(pid).ok())
        .unwrap_or(0);
    let ended = Arc::new(AtomicBool::new(false));
    let opened = pair
        .master
        .try_clone_reader()
        .and_then(|reader| pair.master.take_writer().map(|writer| (reader, writer)));
    let (reader, mut writer) = match opened {
        Ok(opened) => opened,
        Err(e) => {
            stop_later(pgid, ended.clone());
            return Err(format!("疑似端末を読めません: {e}"));
        }
    };
    let (input, typed) = mpsc::channel::<String>();
    // The keys go through a thread of their own, so a full terminal never holds up a command.
    std::thread::spawn(move || {
        for text in typed {
            if writer
                .write_all(text.as_bytes())
                .and_then(|()| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    let title = Title::default();
    let session = Session {
        seq,
        title: title.clone(),
        master: pair.master,
        input,
        pgid,
        ended: ended.clone(),
        _plugin: plugin,
    };
    let reader = Reader {
        reader,
        child,
        sink,
        pgid,
        ended,
        title,
    };
    Ok((session, reader))
}

/// The sessions of the panes, by the id the screen gave each.
#[derive(Default, Clone)]
pub struct ClaudeCode {
    inner: Arc<Inner>,
}

impl ClaudeCode {
    /// Starts the process of `spec` for `id` (one that `id` had is ended first); its output and its end go to `sink`. The answer is the number of this start, which only a close of the same number ends.
    fn start(
        &self,
        id: &str,
        spec: &Spec,
        plugin: Option<CallPlugin>,
        sink: Sink,
    ) -> Result<u64, String> {
        let seq = self.inner.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let (session, reader) = open(spec, seq, plugin, sink)?;
        // The session is held before the reader can see the process end, so its end finds it.
        let old = self.inner.lock().insert(id.to_owned(), session);
        if let Some(old) = old {
            stop_later(old.pgid, old.ended.clone());
        }
        let inner = self.inner.clone();
        let id = id.to_owned();
        std::thread::spawn(move || reader.run(&inner, &id, seq));
        Ok(seq)
    }

    /// Types `text` into the terminal of `id`; nothing happens when it has ended.
    fn input(&self, id: &str, text: String) {
        if let Some(session) = self.inner.lock().get(id) {
            let _ = session.input.send(text);
        }
    }

    /// Types `text` into the terminal of the orchestrator of the formation `name` (the pane `formation:{name}`), as it is: a failure when it has no process, or has ended, so that a reply for the leader is never taken for sent when nobody is there to read it (A-41).
    pub fn input_formation(&self, name: &str, text: String) -> Result<(), String> {
        check_input(&text)?;
        let gone = || {
            "リーダーの Claude Code が動いていません。リーダーを始めてから、もう一度送ってください"
                .to_owned()
        };
        let sessions = self.inner.lock();
        let session = sessions
            .get(format!("{FORMATION_ID_PREFIX}{name}").as_str())
            .ok_or_else(gone)?;
        if session.ended.load(Ordering::SeqCst) {
            return Err(gone());
        }
        session.input.send(text).map_err(|_| gone())
    }

    /// Gives the terminal of `id` a new size; nothing happens when it has ended.
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.inner.lock();
        let Some(session) = sessions.get(id) else {
            return Ok(());
        };
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("疑似端末の大きさを変えられません: {e}"))
    }

    /// Ends the process group of `id` started as `launch` (pane closed). A close that comes late, after the pane started `id` again, finds another number and ends nothing.
    fn close(&self, id: &str, launch: u64) {
        let session = {
            let mut sessions = self.inner.lock();
            if sessions.get(id).is_some_and(|s| s.seq == launch) {
                sessions.remove(id)
            } else {
                None
            }
        };
        if let Some(session) = session {
            stop_later(session.pgid, session.ended.clone());
        }
    }

    /// The title that the leader of the formation `name` (the pane `formation:{name}`) last wrote in its terminal; `None` when it has no process or has written none (#915).
    pub fn formation_title(&self, name: &str) -> Option<String> {
        let sessions = self.inner.lock();
        let session = sessions.get(format!("{FORMATION_ID_PREFIX}{name}").as_str())?;
        let title = session
            .title
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        title
    }

    /// Ends the process of the orchestrator of the formation `name` (the pane `formation:{name}`), whichever start made it: the formation is deleted (A-37), so no pane is left to close it with its number.
    /// It returns only when the process group has ended or has been sent the KILL (the grace of `stop_groups` is waited for on this thread, unlike `close`), because the folder of the formation is deleted after it: a tool that the orchestrator started must not write into the folder after that.
    pub fn close_formation(&self, name: &str) {
        let session = self
            .inner
            .lock()
            .remove(format!("{FORMATION_ID_PREFIX}{name}").as_str());
        if let Some(session) = session {
            stop_groups(&[(session.pgid, session.ended.clone())], GRACE);
        }
    }

    /// Ends every process group and waits for them (the app ends).
    pub fn close_all(&self) {
        let sessions: Vec<Session> = self.inner.lock().drain().map(|(_, s)| s).collect();
        let groups: Vec<_> = sessions.iter().map(|s| (s.pgid, s.ended.clone())).collect();
        stop_groups(&groups, GRACE);
    }
}

// ---- the commands ----

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.chars().count() > ID_LIMIT || id.chars().any(char::is_control) {
        return Err("Claude Code のペインの名前が正しくありません".to_owned());
    }
    Ok(())
}

/// The limit counts characters, as Orca's input does, not the bytes of UTF-8.
fn check_input(text: &str) -> Result<(), String> {
    if text.chars().count() > INPUT_LIMIT {
        return Err("一度に送れる文字数を超えています".to_owned());
    }
    Ok(())
}

fn check_size(viewport: OrcaViewport) -> Result<(u16, u16), String> {
    let range = 1..=SIZE_LIMIT;
    if range.contains(&viewport.cols) && range.contains(&viewport.rows) {
        return Ok((viewport.cols, viewport.rows));
    }
    Err("ターミナルの大きさが正しくありません".to_owned())
}

/// The first instruction that a screen gives a pane (A-36, #976): none, or the text as `formation::check_prompt` lets it through (1 to 20,000 characters, hidden and control characters taken out, no NUL), the refusal in Japanese.
fn pane_prompt(prompt: Option<String>) -> Result<Option<String>, String> {
    prompt
        .as_deref()
        .map(crate::formation::check_prompt)
        .transpose()
}

/// What a start needs: the files written, the sign-in read, the skill's plugin folder made. `formation` is the name of the formation whose orchestrator it is (A-37): its own folder and script, the built-in tools always on, and the projects saved with its formation (`formation.json`) as its first instruction.
#[allow(clippy::too_many_arguments)]
fn prepare(
    config: &Path,
    exe: &Path,
    formation: Option<&str>,
    builtin_tools: bool,
    permission_mode: ClaudeCodePermissionMode,
    skill: Option<ClaudeCodeSkill>,
    prompt: Option<String>,
    (cols, rows): (u16, u16),
) -> Result<(Spec, Option<CallPlugin>), String> {
    check_permission_mode(formation.is_some(), builtin_tools, permission_mode)?;
    let mcp = checked_mcp_binary(exe)?;
    let claude = claude_path()?;
    let connection = claude_auth::load_connection(config)?;
    let plugin = skill
        .map(|s| skills::plugin_for(config, &s.name, s.screen))
        .transpose()?;
    let (script, cwd, prompt) = if let Some(name) = formation {
        let prompt =
            crate::formation::first_prompt(&crate::formation::read_projects(config, name)?)?;
        (
            write_formation_files(config, name, &claude, &mcp)?,
            crate::formation::dir(config, name),
            prompt,
        )
    } else {
        (
            write_files(config, &claude, &mcp, builtin_tools, permission_mode)?,
            claude_code_dir(config),
            prompt,
        )
    };
    let spec = Spec {
        program: "/bin/sh".to_owned(),
        args: launch_args(&script, plugin.as_ref().map(CallPlugin::path), prompt),
        cwd,
        env: connection.env(),
        cols,
        rows,
    };
    Ok((spec, plugin))
}

/// Starts Claude Code in a pseudo terminal for the pane `id` (the pane `formation:{name}` is the orchestrator of the formation `name`, A-37): its output and its end go through `channel`. The orchestrator's first instruction names the projects saved with its formation, which Rust reads itself. `builtin_tools` leaves Claude Code's own tools on (the screens give it only the tools of `tsunagiai-mcp` otherwise), `permission_mode` is `manual`, `auto` (#1074: for the calendar pane, with the calendar tools only) or `auto-slack-compose` (#1144: for the Slack compose pane, with that screen's tools only); `auto` and `auto-slack-compose` with `builtin_tools`, or for the orchestrator, are refused,
/// `skill` is a saved skill that it is given, and `prompt` is its first instruction (A-36, #976: passed as `claude [prompt]` after a `--`, as the orchestrator's is; the orchestrator takes none from the screen). A failure is the message the pane shows. An `id` that has a process is ended first. The answer is the number of this start, which `claude_code_close` takes with the id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn claude_code_start(
    app: AppHandle,
    sessions: State<'_, ClaudeCode>,
    id: String,
    viewport: OrcaViewport,
    builtin_tools: bool,
    permission_mode: ClaudeCodePermissionMode,
    skill: Option<ClaudeCodeSkill>,
    prompt: Option<String>,
    channel: Channel<ClaudeCodeEvent>,
) -> Result<u64, String> {
    check_id(&id)?;
    let size = check_size(viewport)?;
    let prompt = pane_prompt(prompt)?;
    let config = crate::auth::config_dir(&app)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sessions = sessions.inner().clone();
    tokio::task::spawn_blocking(move || {
        let (spec, plugin) = prepare(
            &config,
            &exe,
            formation_of(&id),
            builtin_tools,
            permission_mode,
            skill,
            prompt,
            size,
        )?;
        sessions.start(
            &id,
            &spec,
            plugin,
            Box::new(move |event| channel.send(event).is_ok()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Types `text` into the pane `id`, as it is (no Enter is added).
#[tauri::command]
pub async fn claude_code_input(
    sessions: State<'_, ClaudeCode>,
    id: String,
    text: String,
) -> Result<(), String> {
    check_id(&id)?;
    check_input(&text)?;
    sessions.input(&id, text);
    Ok(())
}

/// The new size of the pane `id` in cells.
#[tauri::command]
pub async fn claude_code_resize(
    sessions: State<'_, ClaudeCode>,
    id: String,
    viewport: OrcaViewport,
) -> Result<(), String> {
    check_id(&id)?;
    let (cols, rows) = check_size(viewport)?;
    sessions.resize(&id, cols, rows)
}

/// Ends the process of the pane `id` that `launch` (the answer of `claude_code_start`) started (the pane is closed); a process that a later start made stays.
#[tauri::command]
pub async fn claude_code_close(
    sessions: State<'_, ClaudeCode>,
    id: String,
    launch: u64,
) -> Result<(), String> {
    check_id(&id)?;
    sessions.close(&id, launch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-claude-code-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_folder_is_claude_code_in_the_config_directory() {
        assert_eq!(
            claude_code_dir(Path::new("/c/app")),
            PathBuf::from("/c/app/claude-code")
        );
    }

    #[test]
    fn the_mcp_config_names_only_tsunagiai_mcp() {
        let config: serde_json::Value = serde_json::from_str(&mcp_config(
            Path::new("/Applications/tsunagiai.app/Contents/MacOS/tsunagiai-mcp"),
            &[],
        ))
        .unwrap();
        assert_eq!(
            config,
            serde_json::json!({"mcpServers": {"tsunagiai": {
                "command": "/Applications/tsunagiai.app/Contents/MacOS/tsunagiai-mcp",
                "args": []
            }}})
        );
    }

    #[test]
    fn the_orchestrators_mcp_config_passes_formation_and_nothing_else_changes() {
        let config: serde_json::Value = serde_json::from_str(&mcp_config(
            Path::new("/app/tsunagiai-mcp"),
            &["--formation", "formation"],
        ))
        .unwrap();
        assert_eq!(
            config,
            serde_json::json!({"mcpServers": {"tsunagiai": {
                "command": "/app/tsunagiai-mcp",
                "args": ["--formation", "formation"]
            }}})
        );
    }

    #[test]
    fn a_word_in_single_quotes_keeps_a_quote_in_it() {
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn the_script_takes_the_built_in_tools_off_and_reads_only_its_mcp_config() {
        let script = launch_script(
            Path::new("/Users/x/.local/bin/claude"),
            Path::new("/c/app/claude-code/mcp.json"),
            false,
        );
        assert_eq!(
            script,
            "#!/bin/sh\n\
             # Written by tsunagiai (A-36) at each start of a Claude Code pane; a change here is lost.\n\
             PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"\n\
             exec '/Users/x/.local/bin/claude' --tools '' --permission-mode manual --setting-sources user --strict-mcp-config --mcp-config '/c/app/claude-code/mcp.json' \"$@\"\n"
        );
    }

    #[test]
    fn the_script_for_the_screens_that_keep_the_tools_has_no_tools_flag() {
        let script = launch_script(Path::new("/bin/claude"), Path::new("/c/mcp.json"), true);
        assert!(!script.contains("--tools"));
        assert!(script.contains(
            "--permission-mode manual --setting-sources user --strict-mcp-config --mcp-config '/c/mcp.json' \"$@\""
        ));
    }

    #[test]
    fn both_scripts_ask_for_the_writing_tools_and_read_only_the_user_settings() {
        for builtin_tools in [false, true] {
            let script = launch_script(
                Path::new("/bin/claude"),
                Path::new("/c/mcp.json"),
                builtin_tools,
            );
            assert!(script.contains(" --permission-mode manual "));
            assert!(script.contains(" --setting-sources user "));
        }
    }

    #[test]
    fn a_path_with_a_quote_stays_one_word_of_the_script() {
        let script = launch_script(
            Path::new("/Users/o'neil/claude"),
            Path::new("/c/mcp.json"),
            false,
        );
        assert!(script.contains(r"exec '/Users/o'\''neil/claude' --tools ''"));
    }

    #[test]
    fn the_auto_script_has_no_built_in_tools_and_reads_only_the_calendar_mcp_config() {
        let script = auto_launch_script(
            Path::new("/Users/x/.local/bin/claude"),
            Path::new("/c/app/claude-code/mcp-calendar.json"),
        );
        assert_eq!(
            script,
            "#!/bin/sh\n\
             # Written by tsunagiai (A-36) at each start of a Claude Code pane; a change here is lost.\n\
             PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"\n\
             exec '/Users/x/.local/bin/claude' --tools '' --permission-mode auto --setting-sources user --strict-mcp-config --mcp-config '/c/app/claude-code/mcp-calendar.json' \"$@\"\n"
        );
        let quoted = auto_launch_script(Path::new("/Users/o'neil/claude"), Path::new("/c/m.json"));
        assert!(
            quoted.contains(r"exec '/Users/o'\''neil/claude' --tools '' --permission-mode auto")
        );
    }

    #[test]
    fn the_permission_mode_takes_manual_and_auto_and_nothing_else() {
        let read = |text: &str| serde_json::from_str::<ClaudeCodePermissionMode>(text);
        assert_eq!(
            read("\"manual\"").unwrap(),
            ClaudeCodePermissionMode::Manual
        );
        assert_eq!(read("\"auto\"").unwrap(), ClaudeCodePermissionMode::Auto);
        for bad in [
            "\"Auto\"",
            "\"AUTO\"",
            "\"plan\"",
            "\"bypassPermissions\"",
            "\"\"",
            "\"manual \"",
            "null",
            "true",
            "1",
        ] {
            assert!(read(bad).is_err(), "{bad}");
        }
        assert_eq!(
            ClaudeCodePermissionMode::default(),
            ClaudeCodePermissionMode::Manual
        );
    }

    #[test]
    fn auto_is_refused_with_the_built_in_tools_and_for_the_orchestrator() {
        use ClaudeCodePermissionMode::{Auto, Manual};
        // manual is as it was, whatever the pane is.
        for (formation, builtin_tools) in
            [(false, false), (false, true), (true, false), (true, true)]
        {
            assert_eq!(
                check_permission_mode(formation, builtin_tools, Manual),
                Ok(())
            );
        }
        assert_eq!(check_permission_mode(false, false, Auto), Ok(()));
        assert!(check_permission_mode(false, true, Auto)
            .unwrap_err()
            .contains("ツール"));
        assert!(check_permission_mode(true, false, Auto)
            .unwrap_err()
            .contains("オーケストレーター"));
        assert!(check_permission_mode(true, true, Auto).is_err());
    }

    #[test]
    fn an_auto_start_writes_the_calendar_config_and_its_own_script_and_leaves_the_others() {
        let config = temp_dir("files-auto");
        let manual = write_files(
            &config,
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
            false,
            ClaudeCodePermissionMode::Manual,
        )
        .unwrap();
        let manual_text = std::fs::read_to_string(&manual).unwrap();
        let auto = write_files(
            &config,
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
            false,
            ClaudeCodePermissionMode::Auto,
        )
        .unwrap();
        assert_eq!(auto, config.join("claude-code/start-auto.sh"));
        let auto_text = std::fs::read_to_string(&auto).unwrap();
        assert!(auto_text.contains(" --permission-mode auto "));
        assert!(auto_text.contains("--tools ''"));
        assert!(auto_text.contains(&format!(
            "--mcp-config '{}'",
            config.join("claude-code/mcp-calendar.json").display()
        )));
        let calendar: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(config.join("claude-code/mcp-calendar.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            calendar,
            serde_json::json!({"mcpServers": {"tsunagiai": {
                "command": "/app/tsunagiai-mcp",
                "args": ["--calendar"]
            }}})
        );
        // The manual script and `mcp.json` are as they were, and name no calendar flag.
        assert_eq!(std::fs::read_to_string(&manual).unwrap(), manual_text);
        assert!(manual_text.contains(" --permission-mode manual "));
        let mcp = std::fs::read_to_string(config.join("claude-code/mcp.json")).unwrap();
        assert!(!mcp.contains("--calendar"));
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_slack_compose_script_is_the_auto_script_with_sonnet_high_and_a_question_before_a_post() {
        let script = slack_compose_launch_script(
            Path::new("/Users/x/.local/bin/claude"),
            Path::new("/c/app/claude-code/mcp-slack-compose.json"),
        );
        assert_eq!(
            script,
            "#!/bin/sh\n\
             # Written by tsunagiai (A-36) at each start of a Claude Code pane; a change here is lost.\n\
             PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"\n\
             exec '/Users/x/.local/bin/claude' --tools '' --permission-mode auto --model sonnet --effort high --settings '{\"permissions\":{\"ask\":[\"mcp__tsunagiai__slack_compose_post\"]}}' --setting-sources user --strict-mcp-config --mcp-config '/c/app/claude-code/mcp-slack-compose.json' \"$@\"\n"
        );
        // The question is asked of the tool the MCP config names: the server's name is the one in `mcp__{server}__{tool}`.
        let config: serde_json::Value =
            serde_json::from_str(&mcp_config(Path::new("/app/tsunagiai-mcp"), &[])).unwrap();
        let server = config["mcpServers"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        assert_eq!(
            SLACK_COMPOSE_POST_TOOL,
            format!("mcp__{server}__slack_compose_post")
        );
        // The calendar pane's script is not changed by it: no model, no effort, no settings.
        let calendar = auto_launch_script(Path::new("/bin/claude"), Path::new("/c/m.json"));
        for flag in ["--model", "--effort", "--settings"] {
            assert!(!calendar.contains(flag), "{flag}");
        }
        let quoted =
            slack_compose_launch_script(Path::new("/Users/o'neil/claude"), Path::new("/c/m.json"));
        assert!(
            quoted.contains(r"exec '/Users/o'\''neil/claude' --tools '' --permission-mode auto")
        );
    }

    #[test]
    fn the_slack_compose_mode_is_read_as_its_own_word_and_is_refused_as_auto_is() {
        use ClaudeCodePermissionMode::{Auto, AutoSlackCompose};
        let read = |text: &str| serde_json::from_str::<ClaudeCodePermissionMode>(text);
        assert_eq!(read("\"auto-slack-compose\"").unwrap(), AutoSlackCompose);
        for bad in [
            "\"autoslackcompose\"",
            "\"auto_slack_compose\"",
            "\"slack-compose\"",
            "\"Auto-slack-compose\"",
        ] {
            assert!(read(bad).is_err(), "{bad}");
        }
        assert_eq!(
            check_permission_mode(false, false, AutoSlackCompose),
            Ok(())
        );
        assert!(check_permission_mode(false, true, AutoSlackCompose)
            .unwrap_err()
            .contains("ツール"));
        assert!(check_permission_mode(true, false, AutoSlackCompose)
            .unwrap_err()
            .contains("オーケストレーター"));
        assert!(check_permission_mode(true, true, AutoSlackCompose).is_err());
        assert_ne!(Auto, AutoSlackCompose);
    }

    #[test]
    fn a_slack_compose_start_writes_its_own_config_and_script_and_leaves_the_calendar_ones() {
        let config = temp_dir("files-slack-compose");
        let calendar = write_files(
            &config,
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
            false,
            ClaudeCodePermissionMode::Auto,
        )
        .unwrap();
        let calendar_text = std::fs::read_to_string(&calendar).unwrap();
        let calendar_mcp =
            std::fs::read_to_string(config.join("claude-code/mcp-calendar.json")).unwrap();
        let compose = write_files(
            &config,
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
            false,
            ClaudeCodePermissionMode::AutoSlackCompose,
        )
        .unwrap();
        assert_eq!(
            compose,
            config.join("claude-code/start-auto-slack-compose.sh")
        );
        let text = std::fs::read_to_string(&compose).unwrap();
        assert!(text.contains(" --permission-mode auto --model sonnet --effort high "));
        assert!(text.contains(&format!(
            "--mcp-config '{}'",
            config.join("claude-code/mcp-slack-compose.json").display()
        )));
        let mcp: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(config.join("claude-code/mcp-slack-compose.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            mcp,
            serde_json::json!({"mcpServers": {"tsunagiai": {
                "command": "/app/tsunagiai-mcp",
                "args": ["--slack-compose"]
            }}})
        );
        // The calendar pane's files are as they were.
        assert_eq!(std::fs::read_to_string(&calendar).unwrap(), calendar_text);
        assert_eq!(
            std::fs::read_to_string(config.join("claude-code/mcp-calendar.json")).unwrap(),
            calendar_mcp
        );
        assert!(!calendar_text.contains("--model"));
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_orchestrators_script_keeps_the_built_in_tools_and_reads_the_project_settings() {
        let script = formation_script(
            Path::new("/Users/x/.local/bin/claude"),
            Path::new("/c/app/formations/formation/mcp.json"),
            Path::new("/c/app/formations/formation/message-hook.json"),
            "formation",
        );
        assert_eq!(
            script,
            "#!/bin/sh\n\
             # Written by tsunagiai (A-37) at each start of the orchestrator; a change here is lost.\n\
             PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"\n\
             exec '/Users/x/.local/bin/claude' -n 'formation' --permission-mode auto --effort high --setting-sources user,project --settings '/c/app/formations/formation/message-hook.json' --strict-mcp-config --mcp-config '/c/app/formations/formation/mcp.json' \"$@\"\n"
        );
        assert!(!script.contains("--tools"));
    }

    #[test]
    fn a_path_with_a_quote_stays_one_word_of_the_orchestrators_script() {
        let script = formation_script(
            Path::new("/Users/o'neil/claude"),
            Path::new("/c/o'neil/mcp.json"),
            Path::new("/c/o'neil/message-hook.json"),
            "formation",
        );
        assert!(script.contains(r"exec '/Users/o'\''neil/claude' -n 'formation'"));
        assert!(script.contains(r"--mcp-config '/c/o'\''neil/mcp.json' "));
    }

    #[test]
    fn the_script_gets_the_plugin_folder_as_arguments() {
        assert_eq!(
            launch_args(Path::new("/c/start.sh"), None, None),
            ["/c/start.sh"]
        );
        assert_eq!(
            launch_args(
                Path::new("/c/start.sh"),
                Some(Path::new("/tmp/tsunagiai-skill-1")),
                None
            ),
            ["/c/start.sh", "--plugin-dir", "/tmp/tsunagiai-skill-1"]
        );
    }

    #[test]
    fn the_first_instruction_follows_a_double_dash_as_one_element_whatever_it_holds() {
        let prompt = "> 環境: local / a'b \"c\" $(x) `y`; -z\n".to_owned();
        assert_eq!(
            launch_args(Path::new("/c/start.sh"), None, Some(prompt.clone())),
            ["/c/start.sh".to_owned(), "--".to_owned(), prompt.clone()]
        );
        assert_eq!(
            launch_args(
                Path::new("/c/start.sh"),
                Some(Path::new("/tmp/p")),
                Some(prompt.clone())
            ),
            [
                "/c/start.sh".to_owned(),
                "--plugin-dir".to_owned(),
                "/tmp/p".to_owned(),
                "--".to_owned(),
                prompt
            ]
        );
    }

    #[test]
    fn a_pane_without_a_first_instruction_gets_none_and_one_with_it_gets_it_checked() {
        assert_eq!(pane_prompt(None), Ok(None));
        assert_eq!(
            pane_prompt(Some("> 環境: local\n調べてください\n".to_owned())),
            Ok(Some("> 環境: local\n調べてください\n".to_owned()))
        );
        // What hides or controls in a terminal is taken out before it is an argument.
        assert_eq!(
            pane_prompt(Some("a\u{200b}b\u{1b}c\u{85}d".to_owned())),
            Ok(Some("abcd".to_owned()))
        );
    }

    #[test]
    fn a_first_instruction_that_is_empty_too_long_or_holds_nul_is_refused_in_japanese() {
        for bad in [String::new(), " \n".to_owned(), "a\0b".to_owned()] {
            assert!(pane_prompt(Some(bad.clone())).is_err(), "{bad:?}");
        }
        assert!(pane_prompt(Some("あ".repeat(20_000))).is_ok());
        let err = pane_prompt(Some("あ".repeat(20_001))).unwrap_err();
        assert!(err.contains("20000"), "{err}");
    }

    #[test]
    fn a_pane_is_the_orchestrator_of_the_formation_its_id_names() {
        assert_eq!(formation_of("formation:api-work"), Some("api-work"));
        assert_eq!(formation_of("formation:formation"), Some("formation"));
        // A name that is no formation's reaches `write_formation_files`, which refuses it.
        assert_eq!(formation_of("formation:"), Some(""));
        for id in [
            "formation",
            "claude-code-1",
            "database-claude",
            "x-formation:a",
        ] {
            assert_eq!(formation_of(id), None, "{id}");
        }
    }

    #[test]
    fn the_mcp_server_is_next_to_the_executable() {
        assert_eq!(
            mcp_binary(Path::new(
                "/Applications/tsunagiai.app/Contents/MacOS/tsunagiai"
            )),
            PathBuf::from("/Applications/tsunagiai.app/Contents/MacOS/tsunagiai-mcp")
        );
    }

    #[test]
    fn a_missing_mcp_server_is_a_japanese_message_with_the_path() {
        let dir = temp_dir("no-mcp");
        let exe = dir.join("tsunagiai");
        let message = checked_mcp_binary(&exe).unwrap_err();
        assert!(message.contains("tsunagiai-mcp が見つかりません"));
        assert!(message.contains(&dir.join("tsunagiai-mcp").display().to_string()));
        std::fs::write(dir.join("tsunagiai-mcp"), "").unwrap();
        assert_eq!(checked_mcp_binary(&exe).unwrap(), dir.join("tsunagiai-mcp"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn claude_is_the_installers_file_first_then_the_first_folder_of_the_path() {
        let candidates = [
            PathBuf::from("/h/.local/bin/claude"),
            PathBuf::from("claude"),
        ];
        let dirs = [
            PathBuf::from("/usr/bin"),
            PathBuf::from("/opt/homebrew/bin"),
        ];
        let both = |p: &Path| {
            p == Path::new("/h/.local/bin/claude") || p == Path::new("/opt/homebrew/bin/claude")
        };
        assert_eq!(
            find_claude(&candidates, &dirs, both),
            Some(PathBuf::from("/h/.local/bin/claude"))
        );
        let only_path = |p: &Path| p == Path::new("/opt/homebrew/bin/claude");
        assert_eq!(
            find_claude(&candidates, &dirs, only_path),
            Some(PathBuf::from("/opt/homebrew/bin/claude"))
        );
        assert_eq!(find_claude(&candidates, &dirs, |_| false), None);
    }

    #[test]
    fn the_files_are_written_in_the_folder_and_the_script_is_for_the_choice_of_tools() {
        let config = temp_dir("files");
        let script = write_files(
            &config,
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
            false,
            ClaudeCodePermissionMode::Manual,
        )
        .unwrap();
        assert_eq!(script, config.join("claude-code/start.sh"));
        assert!(std::fs::read_to_string(&script)
            .unwrap()
            .contains("--tools ''"));
        let with_tools = write_files(
            &config,
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
            true,
            ClaudeCodePermissionMode::Manual,
        )
        .unwrap();
        assert_eq!(with_tools, config.join("claude-code/start-with-tools.sh"));
        assert!(!std::fs::read_to_string(&with_tools)
            .unwrap()
            .contains("--tools"));
        // The first script stays as it was written.
        assert!(std::fs::read_to_string(&script)
            .unwrap()
            .contains("--tools ''"));
        let mcp = std::fs::read_to_string(config.join("claude-code/mcp.json")).unwrap();
        assert!(mcp.contains("/app/tsunagiai-mcp"));
        assert!(!config.join("claude-code/mcp.json.tmp").exists());
        std::fs::remove_dir_all(config).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_orchestrators_settings_are_written_where_a_link_of_its_own_would_not_lead() {
        use std::os::unix::fs::symlink;
        let config = temp_dir("formation-links");
        let dir = config.join("formations/formation");
        let elsewhere = config.join("elsewhere");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("settings.json"), "keep").unwrap();
        let write = || {
            write_formation_files(
                &config,
                "formation",
                Path::new("/bin/claude"),
                Path::new("/app/tsunagiai-mcp"),
            )
            .unwrap()
        };
        // `.claude` linked to another folder: the link goes, and its target is not written.
        symlink(&elsewhere, dir.join(".claude")).unwrap();
        write();
        assert!(!std::fs::symlink_metadata(dir.join(".claude"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(dir.join(".claude/settings.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            std::fs::read_to_string(elsewhere.join("settings.json")).unwrap(),
            "keep"
        );
        // The temporary file and the file itself linked to files elsewhere.
        let (tmp_target, target) = (elsewhere.join("tmp-target"), elsewhere.join("target"));
        std::fs::write(&tmp_target, "keep tmp").unwrap();
        std::fs::write(&target, "keep target").unwrap();
        std::fs::remove_file(dir.join(".claude/settings.json")).unwrap();
        symlink(&tmp_target, dir.join(".claude/settings.json.tmp")).unwrap();
        symlink(&target, dir.join(".claude/settings.json")).unwrap();
        write();
        for (file, text) in [(&tmp_target, "keep tmp"), (&target, "keep target")] {
            assert_eq!(std::fs::read_to_string(file).unwrap(), text);
        }
        assert_eq!(
            std::fs::read_to_string(dir.join(".claude/settings.json")).unwrap(),
            "{}"
        );
        assert!(!dir.join(".claude/settings.json.tmp").exists());
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_orchestrators_files_are_written_in_its_folder_and_the_other_files_stay() {
        let config = temp_dir("formation-files");
        let dir = config.join("formations/formation");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("children.json"), "[]").unwrap();
        // What the orchestrator added to its project settings in an earlier run does not stay.
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(
            dir.join(".claude/settings.json"),
            r#"{"permissions": {"allow": ["Bash(*)"]}}"#,
        )
        .unwrap();
        let script = write_formation_files(
            &config,
            "formation",
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
        )
        .unwrap();
        assert_eq!(script, dir.join("start.sh"));
        let script_text = std::fs::read_to_string(&script).unwrap();
        assert!(script_text.contains("-n 'formation' --permission-mode auto --effort high"));
        assert!(script_text.contains(&format!(
            "--mcp-config '{}'",
            dir.join("mcp.json").display()
        )));
        let mcp: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("mcp.json")).unwrap()).unwrap();
        assert_eq!(
            mcp["mcpServers"]["tsunagiai"]["args"],
            serde_json::json!(["--formation", "formation"])
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
            formation_claude_md("formation")
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(".claude/settings.json")).unwrap(),
            "{}"
        );
        assert!(!dir.join(".claude/settings.json.tmp").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("children.json")).unwrap(),
            "[]"
        );
        // The folder of the other panes is not touched.
        assert!(!config.join("claude-code").exists());
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_leaders_skill_is_replaced_as_a_whole_at_each_write() {
        let config = temp_dir("formation-skill");
        let claude = Path::new("/bin/claude");
        let mcp = Path::new("/app/tsunagiai-mcp");
        let skill = config.join("formations/api-work/.claude/skills/feature-dev");
        // A file of an older skill, and a skill the owner put beside it.
        std::fs::create_dir_all(skill.join("references")).unwrap();
        std::fs::write(skill.join("references/removed.md"), "old").unwrap();
        std::fs::write(skill.join("SKILL.md"), "old").unwrap();
        std::fs::create_dir_all(config.join("formations/api-work/.claude/skills/other")).unwrap();
        for _ in 0..2 {
            write_formation_files(&config, "api-work", claude, mcp).unwrap();
            assert!(!skill.join("references/removed.md").exists());
            for (path, text) in crate::formation_assets::LEADER_SKILL {
                assert_eq!(&std::fs::read_to_string(skill.join(path)).unwrap(), text);
            }
            let mut names: Vec<_> = std::fs::read_dir(skill.parent().unwrap())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            // No folder of the writing stays beside the skill.
            assert_eq!(names, ["feature-dev", "other"]);
        }
        std::fs::remove_dir_all(config).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_place_of_the_skills_folder_is_removed_and_not_written_through() {
        let config = temp_dir("formation-skill-link");
        let elsewhere = config.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let claude_dir = config.join("formations/api-work/.claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::os::unix::fs::symlink(&elsewhere, claude_dir.join("skills")).unwrap();
        write_formation_files(
            &config,
            "api-work",
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
        )
        .unwrap();
        assert!(claude_dir.join("skills").is_dir());
        assert!(!std::fs::symlink_metadata(claude_dir.join("skills"))
            .unwrap()
            .is_symlink());
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_files_of_a_formation_are_written_in_its_own_folder_and_name_it_in_mcp_json() {
        let config = temp_dir("formation-named");
        let claude = Path::new("/bin/claude");
        let mcp_binary = Path::new("/app/tsunagiai-mcp");
        let script = write_formation_files(&config, "api-work", claude, mcp_binary).unwrap();
        let dir = config.join("formations/api-work");
        assert_eq!(script, dir.join("start.sh"));
        let mcp: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("mcp.json")).unwrap()).unwrap();
        assert_eq!(
            mcp["mcpServers"]["tsunagiai"]["args"],
            serde_json::json!(["--formation", "api-work"])
        );
        assert!(!config.join("formations/formation").exists());
        // The orchestrator is named for its formation in the script and in its `CLAUDE.md`, and the other name is nowhere in them.
        let script_text = std::fs::read_to_string(&script).unwrap();
        assert!(script_text.contains("-n 'api-work' --permission-mode auto --effort high"));
        assert!(!script_text.contains("-n 'formation'"));
        let claude_md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert!(claude_md.contains("名前は `api-work` です。"));
        assert!(claude_md.contains("SendMessage で `api-work` に知らせること"));
        assert!(!claude_md.contains("{name}"));
        assert!(!claude_md.contains("`formation` に"));
        // A name that is not a folder name of its own writes nothing, least of all outside `formations/`.
        for bad in ["", "..", "../x", "a/b", "A", ".claude"] {
            assert!(
                write_formation_files(&config, bad, claude, mcp_binary).is_err(),
                "{bad:?}"
            );
        }
        assert!(!config.join("x").exists());
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_start_on_this_machine_writes_the_files_and_runs_the_script_in_the_folder() {
        let config = temp_dir("formation-start");
        let start = formation_start_with(
            &config,
            "api-work",
            &[],
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
        )
        .unwrap();
        let dir = config.join("formations/api-work");
        // With no project there is no first instruction.
        assert_eq!(
            start,
            FormationStart {
                program: "/bin/sh".to_owned(),
                args: vec![dir.join("start.sh").to_string_lossy().into_owned()],
                cwd: dir.clone(),
            }
        );
        // `mcp.json` points at the running `tsunagiai-mcp` with the name of the formation, and the script is the one the app's own pane runs.
        let mcp: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("mcp.json")).unwrap()).unwrap();
        assert_eq!(
            mcp["mcpServers"]["tsunagiai"],
            serde_json::json!({"command": "/app/tsunagiai-mcp", "args": ["--formation", "api-work"]})
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("start.sh")).unwrap(),
            formation_script(
                "/bin/claude".as_ref(),
                &dir.join("mcp.json"),
                &dir.join("message-hook.json"),
                "api-work"
            )
        );
        for file in ["CLAUDE.md", ".claude/settings.json", "message-hook.json"] {
            assert!(dir.join(file).is_file(), "{file}");
        }
        // The hook runs the same `tsunagiai-mcp` for this formation's leader.
        assert_eq!(
            std::fs::read_to_string(dir.join("message-hook.json")).unwrap(),
            formation_message::hook_settings(Path::new("/app/tsunagiai-mcp"), "api-work", None)
        );
        // A name that is not a formation's writes nothing.
        assert!(formation_start_with(
            &config,
            "../x",
            &[],
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp")
        )
        .is_err());
        assert!(!config.join("x").exists());
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_start_on_this_machine_passes_the_projects_as_the_first_instruction_in_local() {
        let config = temp_dir("formation-start-prompt");
        let start = formation_start_with(
            &config,
            "api-work",
            &["api".to_owned(), "x'; rm -rf $HOME".to_owned()],
            Path::new("/bin/claude"),
            Path::new("/app/tsunagiai-mcp"),
        )
        .unwrap();
        let script = config.join("formations/api-work/start.sh");
        // The script, then `--` and the prompt as one element: no shell reads it.
        assert_eq!(start.args.len(), 3);
        assert_eq!(start.args[0], script.to_string_lossy());
        assert_eq!(start.args[1], "--");
        let prompt = &start.args[2];
        assert!(
            prompt.contains("> 環境: local / リポジトリ: api\n"),
            "{prompt}"
        );
        assert!(
            prompt.contains("> 環境: local / リポジトリ: x'; rm -rf $HOME\n"),
            "{prompt}"
        );
        assert_eq!(
            Some(prompt.clone()),
            crate::formation::first_prompt(&[
                crate::formation::FormationProject {
                    environment: "local".into(),
                    repo: "api".into()
                },
                crate::formation::FormationProject {
                    environment: "local".into(),
                    repo: "x'; rm -rf $HOME".into()
                },
            ])
            .unwrap()
        );
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn a_project_name_that_the_instruction_refuses_stops_the_start_before_any_file_is_written() {
        let config = temp_dir("formation-start-bad-project");
        let many: Vec<String> = (0..51).map(|i| format!("r{i}")).collect();
        for bad in [vec!["a\nb".to_owned()], vec![String::new()], many] {
            assert!(formation_start_with(
                &config,
                "api-work",
                &bad,
                Path::new("/bin/claude"),
                Path::new("/app/tsunagiai-mcp")
            )
            .is_err());
            assert!(!config.join("formations/api-work").exists());
        }
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_orchestrators_claude_md_names_the_tools_and_the_rules_of_the_steps() {
        for needle in [
            "formation_launch",
            "formation_plan",
            "formation_close",
            "formation_stop",
            "formation_environments",
            "formation_worktrees",
            "formation_files",
            "formation_read",
            "formation_git",
            "オーナーに聞きます",
            "formation_ask_owner",
            "SendMessage",
            "AskUserQuestion",
            "英小文字、数字、ハイフン",
            "プロジェクト",
            "目的、ゴール",
            "`folder`",
            "取り消せない操作",
            "あなたは、子と同じ PC で動いています",
            "子を起動できるのは、その PC（環境 `local`）だけです",
            "SendMessage は、同じ PC の中でしか届かない",
            "ほかの環境のリポジトリは、読めます。子は置けません",
        ] {
            assert!(FORMATION_CLAUDE_MD.contains(needle), "{needle}");
        }
        // A finished child stays until the owner closes it (#912).
        assert!(FORMATION_CLAUDE_MD.contains("明示して頼んだときだけ"));
        assert!(!FORMATION_CLAUDE_MD.contains("codex のレビューの子"));
        assert!(!FORMATION_CLAUDE_MD.contains("閉じてかまいません"));
    }

    #[test]
    fn the_variables_of_orca_and_its_orchestration_are_the_ones_taken_out() {
        for name in [
            "ORCA_PANE_KEY",
            "ORCA_TERMINAL_HANDLE",
            "ORCA_",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_",
        ] {
            assert!(is_orca_env(name), "{name}");
        }
        for name in [
            "PATH",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "TSUNAGIAI_ORCA_X",
            "ORCA",
            "orca_pane",
        ] {
            assert!(!is_orca_env(name), "{name}");
        }
    }

    #[test]
    fn a_command_loses_the_variables_of_orca_and_keeps_the_others() {
        let mut command = CommandBuilder::new("/bin/sh");
        command.env("ORCA_PANE_KEY", "tab:1");
        command.env("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/s");
        command.env("TSUNAGIAI_KEEP", "yes");
        remove_orca_env(&mut command);
        assert_eq!(command.get_env("ORCA_PANE_KEY"), None);
        assert_eq!(command.get_env("CLAUDE_CODE_MESSAGING_SOCKET"), None);
        assert_eq!(
            command.get_env("TSUNAGIAI_KEEP"),
            Some(std::ffi::OsStr::new("yes"))
        );
    }

    #[test]
    fn a_character_cut_between_two_reads_is_held_for_the_next() {
        let bytes = "あい".as_bytes();
        let mut pending = Vec::new();
        assert_eq!(take_text(&mut pending, &bytes[..4]), "あ");
        assert_eq!(pending, &bytes[3..4]);
        assert_eq!(take_text(&mut pending, &bytes[4..]), "い");
        assert!(pending.is_empty());
    }

    #[test]
    fn the_scan_gives_the_last_title_of_osc_0_and_2_ended_by_bel_or_st() {
        let mut scan = TitleScan::default();
        assert_eq!(scan.feed("plain text"), None);
        assert_eq!(
            scan.feed("\u{1b}]0;✳ Claude Code\u{7}"),
            Some("✳ Claude Code".into())
        );
        assert_eq!(
            scan.feed("\u{1b}]2;◐ work\u{1b}\\ \u{1b}]0;✳ done\u{7}"),
            Some("✳ done".into())
        );
        assert_eq!(scan.feed("\u{1b}]2;◐ work\u{1b}\\"), Some("◐ work".into()));
        // Other sequences are no title: a link (OSC 8), a query (OSC 11), and a color.
        assert_eq!(
            scan.feed("\u{1b}]8;id=a;https://x\u{7}\u{1b}]11;?\u{7}\u{1b}[31m"),
            None
        );
        // An empty title is a title: the program cleared it.
        assert_eq!(scan.feed("\u{1b}]0;\u{7}"), Some(String::new()));
    }

    #[test]
    fn the_scan_joins_a_title_that_a_read_cut_in_two() {
        let text = "\u{1b}]0;✳ Claude\u{1b}\\";
        for cut in 1..text.len() {
            if !text.is_char_boundary(cut) {
                continue;
            }
            let mut scan = TitleScan::default();
            assert_eq!(scan.feed(&text[..cut]), None, "cut at {cut}");
            assert_eq!(
                scan.feed(&text[cut..]),
                Some("✳ Claude".into()),
                "cut at {cut}"
            );
        }
        // A cut that falls inside a sequence that is no title ends it too.
        let mut scan = TitleScan::default();
        assert_eq!(scan.feed("\u{1b}"), None);
        assert_eq!(scan.feed("[0m\u{1b}]0;a\u{7}"), Some("a".into()));
    }

    #[test]
    fn the_scan_drops_what_is_not_a_title_and_what_is_too_long() {
        let mut scan = TitleScan::default();
        // An ESC that ends a body but is not followed by a backslash aborts the sequence.
        assert_eq!(
            scan.feed("\u{1b}]0;lost\u{1b}[0m\u{1b}]0;kept\u{7}"),
            Some("kept".into())
        );
        assert_eq!(
            scan.feed(&format!("\u{1b}]0;{}", "a".repeat(TITLE_CARRY_LIMIT))),
            None
        );
        assert_eq!(scan.feed("tail\u{7}"), None);
        assert_eq!(scan.feed("\u{1b}]0;next\u{7}"), Some("next".into()));
    }

    #[test]
    fn a_byte_that_is_not_utf8_becomes_the_replacement_character() {
        let mut pending = Vec::new();
        assert_eq!(take_text(&mut pending, b"a\xffb"), "a\u{FFFD}b");
        assert!(pending.is_empty());
        assert_eq!(take_text(&mut pending, b""), "");
    }

    #[test]
    fn the_id_and_the_size_are_checked() {
        assert!(check_id("claude-code-1").is_ok());
        assert!(check_id("").is_err());
        assert!(check_id("a\nb").is_err());
        assert!(check_id(&"a".repeat(201)).is_err());
        let size = |cols, rows| check_size(OrcaViewport { cols, rows });
        assert_eq!(size(80, 24), Ok((80, 24)));
        assert!(size(0, 24).is_err());
        assert!(size(80, 1001).is_err());
    }

    #[test]
    fn how_the_process_ended_is_told_in_japanese() {
        use portable_pty::ExitStatus;
        assert_eq!(
            ended_text(Ok(ExitStatus::with_exit_code(0))),
            "Claude Code が終わりました"
        );
        assert_eq!(
            ended_text(Ok(ExitStatus::with_exit_code(3))),
            "Claude Code が終わりました（終了コード 3）"
        );
    }

    #[test]
    fn only_an_exit_with_the_code_0_is_a_clean_end() {
        use portable_pty::ExitStatus;
        let clean = |status| match ended_event(status) {
            ClaudeCodeEvent::Ended { clean, .. } => clean,
            other => panic!("{other:?}"),
        };
        assert!(clean(Ok(ExitStatus::with_exit_code(0))));
        assert!(!clean(Ok(ExitStatus::with_exit_code(3))));
        assert!(!clean(Ok(ExitStatus::with_signal("Terminated"))));
        assert!(!clean(Err(std::io::Error::other("no status"))));
    }

    // ---- real pseudo terminals, running short commands (never `claude`) ----

    const WAIT: Duration = Duration::from_secs(10);

    fn spec(script: &str) -> Spec {
        Spec {
            program: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), script.to_owned()],
            cwd: std::env::temp_dir(),
            env: Vec::new(),
            cols: 80,
            rows: 24,
        }
    }

    fn collecting() -> (Sink, mpsc::Receiver<ClaudeCodeEvent>) {
        let (tx, rx) = mpsc::channel();
        (Box::new(move |event| tx.send(event).is_ok()), rx)
    }

    /// Reads the events until one holds `needle` in the output so far (the text so far), or the end (then the text and the message).
    fn until(rx: &mpsc::Receiver<ClaudeCodeEvent>, needle: &str) -> (String, Option<String>) {
        let deadline = Instant::now() + WAIT;
        let mut text = String::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(ClaudeCodeEvent::Output { data }) => {
                    text.push_str(&data);
                    if text.contains(needle) {
                        return (text, None);
                    }
                }
                Ok(ClaudeCodeEvent::Ended { message, .. }) => return (text, Some(message)),
                Err(_) => {}
            }
        }
        panic!("no {needle:?} in {text:?}");
    }

    fn wait_for(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("{what}");
    }

    fn held(code: &ClaudeCode) -> usize {
        code.inner.lock().len()
    }

    #[test]
    fn a_command_prints_through_the_sink_and_its_end_is_told_with_the_code() {
        let code = ClaudeCode::default();
        let (sink, rx) = collecting();
        code.start("a", &spec("printf 'こんにちは\\n'; exit 3"), None, sink)
            .unwrap();
        let (text, ended) = until(&rx, "never");
        assert!(text.contains("こんにちは"), "{text:?}");
        assert_eq!(ended.unwrap(), "Claude Code が終わりました（終了コード 3）");
        wait_for("the session stays after its end", || held(&code) == 0);
    }

    #[test]
    fn the_command_runs_in_the_folder_with_the_terminal_and_the_environment_given() {
        let dir = temp_dir("cwd");
        let code = ClaudeCode::default();
        let (sink, rx) = collecting();
        let mut run = spec("echo \"$TERM|$TSUNAGIAI_TEST|${HOME-unset}|$(basename \"$PWD\")\"");
        run.cwd = dir.clone();
        run.env = vec![
            EnvChange::Set("TSUNAGIAI_TEST", "set".to_owned()),
            EnvChange::Remove("HOME"),
        ];
        code.start("a", &run, None, sink).unwrap();
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let (text, _) = until(&rx, &format!("xterm-256color|set|unset|{name}"));
        assert!(text.contains("xterm-256color|set|unset|"), "{text:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn typed_keys_reach_the_terminal() {
        let code = ClaudeCode::default();
        let (sink, rx) = collecting();
        code.start("a", &spec("read line; echo \"got:$line\""), None, sink)
            .unwrap();
        code.input("a", "hello\r".to_owned());
        let (text, _) = until(&rx, "got:hello");
        assert!(text.contains("got:hello"), "{text:?}");
    }

    #[test]
    fn the_reply_for_a_leader_reaches_the_terminal_of_its_formation_in_order_and_fails_where_nobody_reads(
    ) {
        let code = ClaudeCode::default();
        // No pane, and a pane of another formation, take nothing.
        assert!(code.input_formation("api-work", "x".to_owned()).is_err());
        let (sink, rx) = collecting();
        code.start(
            "formation:api-work",
            &spec("read line; echo \"got:$line\""),
            None,
            sink,
        )
        .unwrap();
        assert!(code.input_formation("other", "x".to_owned()).is_err());
        // The text, and then Enter in a send of its own, as a reply is typed.
        code.input_formation("api-work", "reply-text".to_owned())
            .unwrap();
        code.input_formation("api-work", "\r".to_owned()).unwrap();
        let (text, _) = until(&rx, "got:reply-text");
        assert!(text.contains("got:reply-text"), "{text:?}");
        // More than one send of a pane takes is refused.
        let long = "あ".repeat(INPUT_LIMIT + 1);
        assert!(code.input_formation("api-work", long).is_err());
    }

    #[test]
    fn a_leader_whose_process_has_ended_takes_no_reply() {
        let code = ClaudeCode::default();
        let (sink, rx) = collecting();
        code.start("formation:api-work", &spec("echo done"), None, sink)
            .unwrap();
        until(&rx, "done");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(code.input_formation("api-work", "x".to_owned()).is_err());
    }

    #[test]
    fn the_size_the_pane_gives_is_the_size_of_the_terminal() {
        let code = ClaudeCode::default();
        let (sink, rx) = collecting();
        code.start("a", &spec("stty size; read line; stty size"), None, sink)
            .unwrap();
        until(&rx, "24 80");
        code.resize("a", 100, 30).unwrap();
        code.input("a", "\r".to_owned());
        let (text, _) = until(&rx, "30 100");
        assert!(text.contains("30 100"), "{text:?}");
    }

    #[test]
    fn keys_and_a_resize_for_a_pane_that_is_gone_do_nothing() {
        let code = ClaudeCode::default();
        code.input("none", "x".to_owned());
        assert_eq!(code.resize("none", 80, 24), Ok(()));
        code.close("none", 1);
    }

    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only asks whether the process is there.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn closing_a_pane_ends_the_processes_it_started_too() {
        let code = ClaudeCode::default();
        let (sink, rx) = collecting();
        let launch = code
            .start("a", &spec("sleep 30 & echo \"child:$!\"; wait"), None, sink)
            .unwrap();
        let (text, _) = until(&rx, "child:");
        let pid: i32 = text
            .split("child:")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!(alive(pid));
        code.close("a", launch);
        wait_for("the started process is still there", || !alive(pid));
        assert_eq!(held(&code), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_process_that_ignores_sigterm_is_killed_after_the_grace() {
        let code = ClaudeCode::default();
        let (sink, rx) = collecting();
        let launch = code
            .start(
                "a",
                &spec("trap '' TERM; echo \"pid:$$\"; while true; do sleep 1; done"),
                None,
                sink,
            )
            .unwrap();
        let (text, _) = until(&rx, "pid:");
        let pid: i32 = text.split("pid:").nth(1).unwrap().trim().parse().unwrap();
        code.close("a", launch);
        std::thread::sleep(Duration::from_millis(500));
        assert!(alive(pid), "SIGTERM alone does not end it");
        wait_for("SIGKILL after the grace did not end it", || !alive(pid));
    }

    #[test]
    fn a_sink_that_takes_no_more_ends_the_process_and_the_session() {
        let code = ClaudeCode::default();
        let (tx, rx) = mpsc::channel::<()>();
        let sink: Sink = Box::new(move |_| {
            let _ = tx.send(());
            false
        });
        code.start(
            "a",
            &spec("while true; do echo x; sleep 0.05; done"),
            None,
            sink,
        )
        .unwrap();
        rx.recv_timeout(WAIT).unwrap();
        wait_for("the session stays after the screen is gone", || {
            held(&code) == 0
        });
    }

    #[test]
    fn starting_an_id_again_ends_the_old_process_and_keeps_the_new_one() {
        let code = ClaudeCode::default();
        let (old_sink, old_rx) = collecting();
        code.start("a", &spec("sleep 30"), None, old_sink).unwrap();
        let (sink, rx) = collecting();
        code.start("a", &spec("echo second; sleep 30"), None, sink)
            .unwrap();
        let (_, ended) = until(&old_rx, "never");
        assert!(ended.is_some());
        until(&rx, "second");
        assert_eq!(held(&code), 1);
        code.close_all();
        assert_eq!(held(&code), 0);
    }

    #[test]
    fn the_input_limit_counts_characters_not_bytes() {
        assert!(check_input(&"あ".repeat(INPUT_LIMIT)).is_ok());
        assert!(check_input(&"a".repeat(INPUT_LIMIT)).is_ok());
        assert!(check_input(&"あ".repeat(INPUT_LIMIT + 1)).is_err());
    }

    #[test]
    fn a_close_of_an_old_start_leaves_the_new_process_of_the_same_id() {
        let code = ClaudeCode::default();
        let (old_sink, _old_rx) = collecting();
        let old = code.start("a", &spec("sleep 30"), None, old_sink).unwrap();
        let (sink, rx) = collecting();
        let new = code
            .start("a", &spec("echo second; sleep 30"), None, sink)
            .unwrap();
        assert_ne!(old, new);
        code.close("a", old);
        until(&rx, "second");
        assert_eq!(held(&code), 1);
        code.close("a", new);
        assert_eq!(held(&code), 0);
    }

    #[test]
    fn a_program_that_is_not_there_is_a_message_for_the_pane() {
        let code = ClaudeCode::default();
        let (sink, _rx) = collecting();
        let mut run = spec("");
        run.program = "/nonexistent/tsunagiai-test".to_owned();
        let message = code.start("a", &run, None, sink).unwrap_err();
        assert!(
            message.starts_with("Claude Code を起動できません"),
            "{message}"
        );
        assert_eq!(held(&code), 0);
    }
}
