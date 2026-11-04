//! A-8: the terminals of the app. A shell in a worktree of this machine, or `ssh` to a host Orca knows, runs in a real PTY (`portable-pty`) and its bytes go to the screen's xterm.js through a Tauri channel.
//! Nothing a terminal prints or is typed is in a log line, an error text or an event of the app; the screen never names a program, an argument or a host, only a worktree path or an SSH id that Rust checks against Orca's own list just before it runs.

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

use crate::orca::{
    local_ssh_targets, local_terminal_worktrees, OrcaSshTarget, OrcaTerminalWorktree,
};

/// The most columns or rows a terminal may have.
const MAX_SIZE: u16 = 1000;
/// The most bytes one `terminal_write` carries.
const MAX_INPUT: usize = 1024 * 1024;
/// The most bytes of output in one event: a burst is split into events of this size.
const CHUNK: usize = 16 * 1024;
const SSH: &str = "/usr/bin/ssh";

/// Where a terminal opens. Rust checks it against Orca's list just before it acts.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalTarget {
    /// A worktree of this machine, by its path.
    Worktree { path: String },
    /// An SSH host, by the id Orca gives it.
    Ssh { id: String },
}

/// What a terminal sends to the screen: its output (base64 of the bytes, which may end inside a UTF-8 character) and its end.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data {
        data: String,
    },
    /// The process ended; `code` is its exit code.
    Exit {
        code: Option<u32>,
    },
}

/// What runs: no `program` is the login shell of the user (from the password database).
#[derive(Debug, PartialEq)]
struct Spec {
    program: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    env: Vec<(String, String)>,
}

/// The variables a terminal is given on top of the app's own; `LANG` only when the app has none (a Finder launch has none, and a shell without it cannot show Japanese).
fn env_of(has_lang: bool) -> Vec<(String, String)> {
    let mut env = vec![
        ("TERM".to_owned(), "xterm-256color".to_owned()),
        ("COLORTERM".to_owned(), "truecolor".to_owned()),
    ];
    if !has_lang {
        env.push(("LANG".to_owned(), "en_US.UTF-8".to_owned()));
    }
    env
}

fn shell_spec(path: &str, has_lang: bool) -> Spec {
    Spec {
        program: None,
        args: Vec::new(),
        cwd: Some(path.to_owned()),
        env: env_of(has_lang),
    }
}

/// `ssh -- {configHost}` with no shell and no other argument: the host name is read from `~/.ssh/config`.
fn ssh_spec(config_host: &str, has_lang: bool) -> Spec {
    Spec {
        program: Some(SSH.to_owned()),
        args: vec!["--".to_owned(), config_host.to_owned()],
        cwd: None,
        env: env_of(has_lang),
    }
}

fn check_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if (1..=MAX_SIZE).contains(&cols) && (1..=MAX_SIZE).contains(&rows) {
        Ok(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    } else {
        Err(format!("ターミナルの大きさは 1 から {MAX_SIZE} までです"))
    }
}

fn check_input(data: &str) -> Result<(), String> {
    if data.len() > MAX_INPUT {
        Err("一度に送れる入力は 1 MiB までです".into())
    } else {
        Ok(())
    }
}

/// The worktree must be one of the list read just now.
fn check_worktree(worktrees: &[OrcaTerminalWorktree], path: &str) -> Result<(), String> {
    if worktrees.iter().any(|w| w.path == path) {
        Ok(())
    } else {
        Err("開く先の worktree が見つかりません。一覧を読み直してください".into())
    }
}

/// The host name of the SSH target `id` in the list read just now (a name `ssh` is run with is checked when the list is read).
fn ssh_host_of<'a>(targets: &'a [OrcaSshTarget], id: &str) -> Result<&'a str, String> {
    targets
        .iter()
        .find(|t| t.id == id)
        .map(|t| t.config_host.as_str())
        .ok_or_else(|| "接続先の SSH が見つかりません。一覧を読み直してください".to_owned())
}

fn data_event(bytes: &[u8]) -> TerminalEvent {
    TerminalEvent::Data {
        data: STANDARD.encode(bytes),
    }
}

// ---- the running terminals ----

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct Inner {
    ptys: Mutex<HashMap<String, Pty>>,
    next: AtomicU64,
}

/// The terminals that run now, by the id Rust gave them. They live as long as the app: a finished one stays until the screen closes it.
#[derive(Default, Clone)]
pub struct Terminals(Arc<Inner>);

impl Terminals {
    /// Ends every terminal (the app is quitting). Dropping a master hangs up its shell.
    pub fn kill_all(&self) {
        let all: Vec<Pty> = self
            .0
            .ptys
            .lock()
            .unwrap()
            .drain()
            .map(|(_, p)| p)
            .collect();
        for mut pty in all {
            let _ = pty.killer.kill();
        }
    }

    fn open(
        &self,
        spec: &Spec,
        size: PtySize,
        send: impl Fn(TerminalEvent) -> bool + Send + 'static,
    ) -> Result<String, String> {
        let failed = |_| "ターミナルを起動できません".to_owned();
        let pair = native_pty_system().openpty(size).map_err(failed)?;
        let mut command = match &spec.program {
            Some(program) => {
                let mut command = CommandBuilder::new(program);
                command.args(&spec.args);
                command
            }
            None => CommandBuilder::new_default_prog(),
        };
        if let Some(cwd) = &spec.cwd {
            command.cwd(cwd);
        }
        for (name, value) in &spec.env {
            command.env(name, value);
        }
        let mut child = pair.slave.spawn_command(command).map_err(failed)?;
        // The child holds the slave now; keeping ours open would stop the reader from seeing the end.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(failed)?;
        let writer = pair.master.take_writer().map_err(failed)?;
        let killer = child.clone_killer();
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; CHUNK];
            // The end of the output is the end of the terminal: a read error (EIO once the shell is gone) is the same as zero bytes.
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 || !send(data_event(&buffer[..n])) {
                    break;
                }
            }
            let code = child.wait().ok().map(|status| status.exit_code());
            send(TerminalEvent::Exit { code });
        });
        let id = format!("pty_{}", self.0.next.fetch_add(1, Ordering::Relaxed) + 1);
        self.0.ptys.lock().unwrap().insert(
            id.clone(),
            Pty {
                master: pair.master,
                writer,
                killer,
            },
        );
        Ok(id)
    }

    fn with<T>(
        &self,
        id: &str,
        f: impl FnOnce(&mut Pty) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut ptys = self.0.ptys.lock().unwrap();
        let pty = ptys.get_mut(id).ok_or("ターミナルは閉じられています")?;
        f(pty)
    }

    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        check_input(data)?;
        self.with(id, |pty| {
            pty.writer
                .write_all(data.as_bytes())
                .and_then(|()| pty.writer.flush())
                .map_err(|_| "ターミナルへ書き込めません。終了している可能性があります".to_owned())
        })
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let size = check_size(cols, rows)?;
        self.with(id, |pty| {
            pty.master
                .resize(size)
                .map_err(|_| "ターミナルの大きさを変えられません".to_owned())
        })
    }

    /// Ends the terminal and forgets it; one that is already gone is a success.
    fn close(&self, id: &str) {
        let pty = self.0.ptys.lock().unwrap().remove(id);
        if let Some(mut pty) = pty {
            let _ = pty.killer.kill();
        }
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

/// Opens a terminal at `target` with `cols` x `rows`, and sends its output and end to `channel`. The id it answers is the one the other commands take.
#[tauri::command]
pub async fn terminal_open(
    state: tauri::State<'_, Terminals>,
    target: TerminalTarget,
    cols: u16,
    rows: u16,
    channel: tauri::ipc::Channel<TerminalEvent>,
) -> Result<String, String> {
    let size = check_size(cols, rows)?;
    let has_lang = std::env::var_os("LANG").is_some();
    // Orca's list is read again just now, so a path or an id that is no longer there runs nothing.
    let spec = match target {
        TerminalTarget::Worktree { path } => {
            let worktrees = blocking(local_terminal_worktrees).await??;
            check_worktree(&worktrees, &path)?;
            shell_spec(&path, has_lang)
        }
        TerminalTarget::Ssh { id } => {
            let targets = local_ssh_targets().await;
            ssh_spec(ssh_host_of(&targets, &id)?, has_lang)
        }
    };
    let terminals = state.inner().clone();
    blocking(move || terminals.open(&spec, size, move |event| channel.send(event).is_ok())).await?
}

/// Types `data` into the terminal `id`.
#[tauri::command]
pub async fn terminal_write(
    state: tauri::State<'_, Terminals>,
    id: String,
    data: String,
) -> Result<(), String> {
    let terminals = state.inner().clone();
    blocking(move || terminals.write(&id, &data)).await?
}

/// Tells the terminal `id` its size changed.
#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

/// Ends the terminal `id` and forgets it.
#[tauri::command]
pub async fn terminal_close(state: tauri::State<'_, Terminals>, id: String) -> Result<(), String> {
    state.close(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, time::Duration};

    use super::*;
    use crate::orca::valid_config_host;

    fn size() -> PtySize {
        check_size(80, 24).unwrap()
    }

    fn sh(script: &str) -> Spec {
        Spec {
            program: Some("/bin/sh".into()),
            args: vec!["-c".into(), script.into()],
            cwd: None,
            env: env_of(true),
        }
    }

    /// Opens `spec` and collects its events: the output decoded and joined, then the exit code, once the end came.
    fn open(spec: &Spec) -> (Terminals, String, mpsc::Receiver<TerminalEvent>) {
        let terminals = Terminals::default();
        let (tx, rx) = mpsc::channel();
        let id = terminals
            .open(spec, size(), move |event| tx.send(event).is_ok())
            .unwrap();
        (terminals, id, rx)
    }

    /// Reads events until the output holds `needle`; the output so far.
    fn read_until(rx: &mpsc::Receiver<TerminalEvent>, needle: &str) -> String {
        let mut out = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                TerminalEvent::Data { data } => out.extend(STANDARD.decode(data).unwrap()),
                TerminalEvent::Exit { .. } => panic!("ended before {needle:?}: {out:?}"),
            }
            let text = String::from_utf8_lossy(&out).into_owned();
            if text.contains(needle) {
                return text;
            }
        }
    }

    fn exit_of(rx: &mpsc::Receiver<TerminalEvent>) -> Option<u32> {
        loop {
            if let TerminalEvent::Exit { code } = rx.recv_timeout(Duration::from_secs(10)).unwrap()
            {
                return code;
            }
        }
    }

    #[test]
    fn a_worktree_terminal_is_the_login_shell_in_the_path() {
        let spec = shell_spec("/work/example", true);
        assert_eq!(spec.program, None);
        assert!(spec.args.is_empty());
        assert_eq!(spec.cwd.as_deref(), Some("/work/example"));
    }

    #[test]
    fn an_ssh_terminal_runs_ssh_with_only_the_host_after_two_dashes() {
        let spec = ssh_spec("example-host", true);
        assert_eq!(spec.program.as_deref(), Some("/usr/bin/ssh"));
        assert_eq!(spec.args, ["--", "example-host"]);
        assert_eq!(spec.cwd, None);
    }

    #[test]
    fn the_terminal_type_is_set_and_lang_only_when_the_app_has_none() {
        let with = env_of(true);
        assert!(with.contains(&("TERM".into(), "xterm-256color".into())));
        assert!(with.contains(&("COLORTERM".into(), "truecolor".into())));
        assert!(!with.iter().any(|(name, _)| name == "LANG"));
        assert!(env_of(false).contains(&("LANG".into(), "en_US.UTF-8".into())));
    }

    #[test]
    fn the_size_is_one_to_a_thousand_and_nothing_is_clamped() {
        let ok = check_size(1000, 1).unwrap();
        assert_eq!((ok.cols, ok.rows), (1000, 1));
        for (cols, rows) in [(0, 24), (80, 0), (1001, 24), (80, 1001), (0, 0)] {
            assert!(
                check_size(cols, rows).unwrap_err().contains("1000"),
                "{cols}x{rows}"
            );
        }
    }

    #[test]
    fn an_input_is_at_most_a_mebibyte() {
        assert!(check_input("").is_ok());
        assert!(check_input(&"a".repeat(MAX_INPUT)).is_ok());
        assert!(check_input(&"a".repeat(MAX_INPUT + 1)).is_err());
        // Bytes are counted, not characters.
        assert!(check_input(&"あ".repeat(MAX_INPUT / 3 + 1)).is_err());
    }

    fn worktree(path: &str) -> OrcaTerminalWorktree {
        OrcaTerminalWorktree {
            path: path.into(),
            repo: "example".into(),
            branch: "main".into(),
            project_key: "repo1".into(),
        }
    }

    #[test]
    fn a_worktree_must_be_in_the_list_read_just_now() {
        let listed = [worktree("/work/a")];
        assert!(check_worktree(&listed, "/work/a").is_ok());
        for bad in ["/work/a/", "/work", "work/a", ""] {
            assert!(check_worktree(&listed, bad).is_err(), "{bad}");
        }
        assert!(check_worktree(&[], "/work/a").is_err());
    }

    #[test]
    fn an_ssh_target_must_be_in_the_list_and_gives_its_host() {
        let listed = [OrcaSshTarget {
            id: "ssh-1".into(),
            label: "Example".into(),
            connected: false,
            config_host: "example-host".into(),
        }];
        assert_eq!(ssh_host_of(&listed, "ssh-1"), Ok("example-host"));
        assert!(ssh_host_of(&listed, "ssh-2").is_err());
        assert!(ssh_host_of(&listed, "example-host").is_err());
        assert!(ssh_host_of(&[], "ssh-1").is_err());
    }

    #[test]
    fn a_host_name_cannot_be_read_as_an_option() {
        for ok in ["example-host", "a", "host.example.com", "h_1", "9lives"] {
            assert!(valid_config_host(ok), "{ok}");
        }
        for bad in [
            "",
            "-oProxyCommand=x",
            ".hidden",
            "a b",
            "a;b",
            "a/b",
            "ホスト",
            "a\n",
        ] {
            assert!(!valid_config_host(bad), "{bad}");
        }
        assert!(!valid_config_host(&"a".repeat(256)));
    }

    #[test]
    fn the_output_is_base64_of_the_bytes() {
        assert_eq!(
            data_event(&[0xe3, 0x81]),
            TerminalEvent::Data {
                data: "44E=".into()
            }
        );
    }

    #[test]
    fn a_terminal_sends_its_output_and_then_its_exit_code() {
        let (_terminals, _id, rx) = open(&sh("printf hello; exit 3"));
        // The PTY turns a newline into CR LF, so only the text is looked for.
        read_until(&rx, "hello");
        assert_eq!(exit_of(&rx), Some(3));
    }

    #[test]
    fn what_is_written_reaches_the_process_and_comes_back() {
        let (terminals, id, rx) = open(&sh("cat"));
        terminals.write(&id, "ping\n").unwrap();
        read_until(&rx, "ping");
        terminals.resize(&id, 100, 30).unwrap();
        assert!(terminals.resize(&id, 0, 30).is_err());
        assert!(terminals.write(&id, &"a".repeat(MAX_INPUT + 1)).is_err());
        terminals.close(&id);
        // Closing ends the process, which is the end of the output.
        exit_of(&rx);
        assert!(terminals
            .write(&id, "x")
            .unwrap_err()
            .contains("閉じられて"));
        assert!(terminals.resize(&id, 80, 24).is_err());
        // Closing again is no error.
        terminals.close(&id);
    }

    #[test]
    fn the_size_the_process_sees_is_the_one_asked_for_and_the_one_resized_to() {
        let (terminals, id, rx) = open(&sh("stty size; read x; stty size"));
        read_until(&rx, "24 80");
        terminals.resize(&id, 100, 30).unwrap();
        terminals.write(&id, "\n").unwrap();
        read_until(&rx, "30 100");
        terminals.close(&id);
    }

    #[test]
    fn the_process_gets_the_terminal_type_and_the_variables() {
        let (_terminals, _id, rx) = open(&sh("echo $TERM-$COLORTERM"));
        read_until(&rx, "xterm-256color-truecolor");
    }

    #[test]
    fn a_program_that_is_not_there_is_a_failure_with_no_detail() {
        let spec = Spec {
            program: Some("/nonexistent/example".into()),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
        };
        let error = Terminals::default()
            .open(&spec, size(), |_| true)
            .unwrap_err();
        assert_eq!(error, "ターミナルを起動できません");
    }

    #[test]
    fn quitting_ends_every_terminal() {
        let (terminals, id, rx) = open(&sh("cat"));
        terminals.kill_all();
        exit_of(&rx);
        assert!(terminals.write(&id, "x").is_err());
    }

    #[test]
    fn a_burst_is_split_into_events_of_a_bounded_size() {
        let (terminals, id, rx) = open(&sh("head -c 100000 /dev/zero | tr '\\\\0' 'a'"));
        let mut total = 0;
        while let TerminalEvent::Data { data } = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            let bytes = STANDARD.decode(data).unwrap();
            assert!(bytes.len() <= CHUNK);
            total += bytes.len();
        }
        assert!(total >= 100_000);
        terminals.close(&id);
    }
}
