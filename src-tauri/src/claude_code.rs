//! A-36: the shared part of the Claude Code panes. tsunagiai opens a pseudo terminal itself (`portable-pty`, no Orca in between) and runs Claude Code in it; the screen draws it with xterm.js (`ts/claude-code.ts`).
//! Claude Code runs in a folder of its own, `claude-code/` in the app config directory, which holds a launch script and the `--mcp-config` file. The script is written by the app in a fixed form
//! (only paths the app decided are in it: nothing that comes from a mail, a message or a Todo), and it starts `claude --tools '' --permission-mode manual --setting-sources user --strict-mcp-config --mcp-config {the file}` (the built-in tools stay on when the screen asks, as the database screen does).
//! `manual` asks for every tool that writes, whatever `defaultMode` the owner's settings hold, and `--setting-sources user` leaves out the project and local settings of the shared folder, so an "always allow" chosen in one pane does not reach the others.
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
    orca_stream::OrcaViewport,
    skills::{self, CallPlugin, SkillScreen},
};

/// The folder of Claude Code in the app config directory, which `claude` runs in.
const FOLDER: &str = "claude-code";
const MCP_FILE: &str = "mcp.json";
const SCRIPT_FILE: &str = "start.sh";
const SCRIPT_WITH_TOOLS_FILE: &str = "start-with-tools.sh";
/// The name the MCP server has in Claude Code (`mcp__tsunagiai__...`), as in `.mcp.json` of the repository.
const MCP_NAME: &str = "tsunagiai";
const MCP_BINARY: &str = "tsunagiai-mcp";
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
    /// The process ended (`message` says how, in Japanese). Nothing follows.
    Ended { message: String },
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

/// The text of `mcp.json`: the one MCP server, `tsunagiai-mcp` at `mcp`.
fn mcp_config(mcp: &Path) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": { MCP_NAME: { "command": mcp.to_string_lossy(), "args": [] } }
    }))
    .unwrap_or_default()
}

/// `text` as one word of a POSIX shell: in single quotes, a quote in it closed, escaped and opened again.
fn sh_quote(text: &str) -> String {
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

/// The arguments of `/bin/sh`: the script, then `--plugin-dir {folder}` when the pane has a skill.
fn launch_args(script: &Path, plugin_dir: Option<&Path>) -> Vec<String> {
    let mut args = vec![script.to_string_lossy().into_owned()];
    if let Some(dir) = plugin_dir {
        args.push("--plugin-dir".to_owned());
        args.push(dir.to_string_lossy().into_owned());
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
fn checked_mcp_binary(exe: &Path) -> Result<PathBuf, String> {
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

/// Writes `mcp.json` and the launch script in `claude-code/` of `config` and answers the script's path.
fn write_files(
    config: &Path,
    claude: &Path,
    mcp: &Path,
    builtin_tools: bool,
) -> Result<PathBuf, String> {
    let dir = claude_code_dir(config);
    let script = if builtin_tools {
        SCRIPT_WITH_TOOLS_FILE
    } else {
        SCRIPT_FILE
    };
    let _writing = FILES.lock().unwrap_or_else(|e| e.into_inner());
    crate::accounts::write_atomic(&dir, MCP_FILE, &mcp_config(mcp))?;
    crate::accounts::write_atomic(
        &dir,
        script,
        &launch_script(claude, &dir.join(MCP_FILE), builtin_tools),
    )?;
    Ok(dir.join(script))
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

/// A pane's process. Dropping it closes the terminal; the plugin folder of the pane's skill goes with it.
struct Session {
    seq: u64,
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
        loop {
            match self.reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = take_text(&mut pending, &buffer[..n]);
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
            (self.sink)(ClaudeCodeEvent::Ended {
                message: ended_text(status),
            });
        }
        inner.forget(id, seq);
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
    let session = Session {
        seq,
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

/// What a start needs: the files written, the sign-in read, the skill's plugin folder made.
fn prepare(
    config: &Path,
    exe: &Path,
    builtin_tools: bool,
    skill: Option<ClaudeCodeSkill>,
    (cols, rows): (u16, u16),
) -> Result<(Spec, Option<CallPlugin>), String> {
    let mcp = checked_mcp_binary(exe)?;
    let claude = claude_path()?;
    let connection = claude_auth::load_connection(config)?;
    let plugin = skill
        .map(|s| skills::plugin_for(config, &s.name, s.screen))
        .transpose()?;
    let script = write_files(config, &claude, &mcp, builtin_tools)?;
    let spec = Spec {
        program: "/bin/sh".to_owned(),
        args: launch_args(&script, plugin.as_ref().map(CallPlugin::path)),
        cwd: claude_code_dir(config),
        env: connection.env(),
        cols,
        rows,
    };
    Ok((spec, plugin))
}

/// Starts Claude Code in a pseudo terminal for the pane `id`: its output and its end go through `channel`. `builtin_tools` leaves Claude Code's own tools on (the screens give it only the tools of `tsunagiai-mcp` otherwise),
/// and `skill` is a saved skill that it is given. A failure is the message the pane shows. An `id` that has a process is ended first. The answer is the number of this start, which `claude_code_close` takes with the id.
#[tauri::command]
pub async fn claude_code_start(
    app: AppHandle,
    sessions: State<'_, ClaudeCode>,
    id: String,
    viewport: OrcaViewport,
    builtin_tools: bool,
    skill: Option<ClaudeCodeSkill>,
    channel: Channel<ClaudeCodeEvent>,
) -> Result<u64, String> {
    check_id(&id)?;
    let size = check_size(viewport)?;
    let config = crate::auth::config_dir(&app)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sessions = sessions.inner().clone();
    tokio::task::spawn_blocking(move || {
        let (spec, plugin) = prepare(&config, &exe, builtin_tools, skill, size)?;
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
        let config: serde_json::Value = serde_json::from_str(&mcp_config(Path::new(
            "/Applications/tsunagiai.app/Contents/MacOS/tsunagiai-mcp",
        )))
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
    fn the_script_gets_the_plugin_folder_as_arguments() {
        assert_eq!(launch_args(Path::new("/c/start.sh"), None), ["/c/start.sh"]);
        assert_eq!(
            launch_args(
                Path::new("/c/start.sh"),
                Some(Path::new("/tmp/tsunagiai-skill-1"))
            ),
            ["/c/start.sh", "--plugin-dir", "/tmp/tsunagiai-skill-1"]
        );
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
                Ok(ClaudeCodeEvent::Ended { message }) => return (text, Some(message)),
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
