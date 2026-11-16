//! The `ssh` command of this Mac, as the language server of a saved environment's worktree (A-34, `lsp.rs`) runs its programs through it, and the run of a process with a time limit.
//!
//! The host is a Host of `~/.ssh/config`, one element of ssh's argument list after `--`; what the host runs is a script that a caller gives, and nothing of what it reads or prints is kept or logged.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) const SSH: &str = "/usr/bin/ssh";
/// How long one call may take, the connection included (`ConnectTimeout` is 10 seconds of it).
pub(crate) const TIMEOUT: Duration = Duration::from_secs(30);
/// How long the output of an ssh that has ended is waited for.
const OUTPUT_WAIT: Duration = Duration::from_secs(2);
/// The most bytes of ssh's stderr that are read.
const STDERR_MAX: u64 = 16 * 1024;
/// The most characters of ssh's last line that a message shows.
const SHOWN_MAX: usize = 200;
/// The longest path of a unix socket (`sun_path` of macOS, with its end), and what ssh adds to the folder of `ControlPath`: the `/`, the 40 characters of `%C`, and the 17 of the temporary name it binds first.
const SOCKET_MAX: usize = 103;
const CONTROL_ADDS: usize = 1 + 40 + 17;

const BAD_HOST: &str = "SSH ホストの名前が正しくありません";
const NOT_CONNECTED: &str = "接続できません";
const NOT_RUN: &str = "ssh を実行できません";

/// ssh's own failure, as the exit code of a run.
const EXIT_SSH: i32 = 255;

/// The Host of `~/.ssh/config` that ssh is given: not empty, not an option (`-`), and no whitespace or control character.
pub(crate) fn check_host(host: &str) -> Result<&str, String> {
    let bad = host.is_empty()
        || host.starts_with('-')
        || host.chars().any(|c| c.is_whitespace() || c.is_control());
    if bad {
        Err(BAD_HOST.into())
    } else {
        Ok(host)
    }
}

/// What a run of ssh left: its exit code (none when a signal ended it), its stdout up to the limit asked for, and its stderr.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Ran {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// The arguments of ssh for `script` on `host`: no question is asked (`BatchMode`), the connection is shared through a socket in `control` when there is one, no terminal, and the host after `--` as one element.
pub(crate) fn ssh_args(host: &str, control: Option<&str>, script: &str) -> Vec<String> {
    let mut args: Vec<String> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
        .map(str::to_owned)
        .into();
    if let Some(dir) = control {
        // ssh reads `%` in the path as a token.
        let path = format!("ControlPath={}/%C", dir.replace('%', "%%"));
        args.extend(
            [
                "-o",
                "ControlMaster=auto",
                "-o",
                &path,
                "-o",
                "ControlPersist=60",
            ]
            .map(str::to_owned),
        );
    }
    args.push("-T".to_owned());
    args.extend(["--", host, script].map(str::to_owned));
    args
}

/// Where the sockets of the shared connections go, in the home folder `home`: none when the path of a socket there would be too long for a unix socket.
fn control_path(home: &Path) -> Option<PathBuf> {
    let dir = home.join(".cache/tsunagiai/ssh");
    (dir.as_os_str().len() + CONTROL_ADDS <= SOCKET_MAX).then_some(dir)
}

/// The folder of the sockets of the shared connections of this Mac, made when it is missing; none when there is no home folder or no safe folder to be had.
pub(crate) fn shared_control() -> Option<String> {
    dirs::home_dir()
        .and_then(|home| control_path(&home))
        .and_then(|dir| prepare_control(&dir))
}

/// Makes the folder of the sockets for the owner alone (0700), and answers it as text only when it is a folder that nobody else can enter.
#[cfg(unix)]
fn prepare_control(dir: &Path) -> Option<String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .ok()?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).ok()?;
    let meta = std::fs::symlink_metadata(dir).ok()?;
    (meta.is_dir() && meta.permissions().mode() & 0o077 == 0)
        .then(|| dir.to_str().map(str::to_owned))
        .flatten()
}

#[cfg(not(unix))]
fn prepare_control(_dir: &Path) -> Option<String> {
    None
}

/// The last line of ssh's stderr that is not blank, with no control character, cut at 200 characters.
fn last_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(|line| {
            line.chars()
                .filter(|c| !c.is_control())
                .take(SHOWN_MAX)
                .collect::<String>()
        })
        .rfind(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_owned())
}

/// The message of a run that did not do what was asked: ssh's own failure (255) is a failed connection, anything else is `what`; each with ssh's last line.
pub(crate) fn failure(ran: &Ran, what: &str) -> String {
    let what = if ran.code == Some(EXIT_SSH) {
        NOT_CONNECTED
    } else {
        what
    };
    match last_line(&ran.stderr) {
        Some(line) => format!("{what}: {line}"),
        None => what.to_owned(),
    }
}

/// Runs `program` with `args`, gives it `stdin`, and answers its exit code, its stdout up to `limit` bytes and its stderr. A run past `timeout` is killed. The end is the end of the process, not of its output: the ssh that stays behind for a shared connection can hold stderr open.
pub(crate) fn run_process(
    program: &str,
    args: &[String],
    stdin: Vec<u8>,
    limit: usize,
    timeout: Duration,
) -> Result<Ran, String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| NOT_RUN)?;
    let mut input = child.stdin.take().ok_or(NOT_RUN)?;
    let output = child.stdout.take().ok_or(NOT_RUN)?;
    let errors = child.stderr.take().ok_or(NOT_RUN)?;
    // A script that ends before it has read everything closes the pipe: that is no failure of the write.
    std::thread::spawn(move || {
        let _ = input.write_all(&stdin);
    });
    let (out_tx, out_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut output = output.take(limit as u64);
        let _ = output.read_to_end(&mut kept);
        let _ = out_tx.send(kept);
        // The rest is read and dropped, so that the process can end.
        let _ = std::io::copy(&mut output.into_inner(), &mut std::io::sink());
    });
    let (err_tx, err_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut errors = errors.take(STDERR_MAX);
        let mut buffer = [0_u8; 1024];
        while let Ok(n @ 1..) = errors.read(&mut buffer) {
            let _ = err_tx.send(buffer[..n].to_vec());
        }
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{NOT_CONNECTED}: 時間内に応答がありません"));
            }
        }
    };
    let stdout = out_rx.recv_timeout(OUTPUT_WAIT).map_err(|_| NOT_RUN)?;
    // What stderr held when the process ended: the pieces its reader sent within a moment.
    let mut stderr = Vec::new();
    while let Ok(more) = err_rx.recv_timeout(Duration::from_millis(50)) {
        stderr.extend(more);
    }
    Ok(Ran {
        code: status.code(),
        stdout,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "sh -c 'true'";

    fn ran(code: i32, stdout: &[u8], stderr: &str) -> Ran {
        Ran {
            code: Some(code),
            stdout: stdout.to_vec(),
            stderr: stderr.to_owned(),
        }
    }

    #[test]
    fn host_is_checked() {
        assert_eq!(check_host("example-host"), Ok("example-host"));
        for host in ["", "-oProxyCommand=x", "a b", "a\nb", "a\u{3000}b"] {
            assert_eq!(check_host(host).unwrap_err(), BAD_HOST, "{host:?}");
        }
    }

    #[test]
    fn ssh_arguments_keep_the_host_after_the_options() {
        let args = ssh_args("example-host", Some("/home/u/.cache/tsunagiai/ssh"), SCRIPT);
        assert_eq!(
            args,
            [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ControlMaster=auto",
                "-o",
                "ControlPath=/home/u/.cache/tsunagiai/ssh/%C",
                "-o",
                "ControlPersist=60",
                "-T",
                "--",
                "example-host",
                SCRIPT,
            ]
        );
        // With no folder for the sockets the connection is not shared.
        assert_eq!(
            ssh_args("h", None, SCRIPT),
            [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-T",
                "--",
                "h",
                SCRIPT
            ]
        );
        // A `%` of the folder is no token of ssh.
        assert!(ssh_args("h", Some("/a%b"), SCRIPT).contains(&"ControlPath=/a%%b/%C".to_owned()));
    }

    #[test]
    fn control_folder_must_fit_a_socket_path() {
        assert_eq!(
            control_path(Path::new("/Users/example")),
            Some(PathBuf::from("/Users/example/.cache/tsunagiai/ssh"))
        );
        // 45 bytes of folder is the most: 45 + 58 = 103.
        let home = |n: usize| format!("/{}", "a".repeat(n - 1));
        let tail = "/.cache/tsunagiai/ssh".len();
        assert!(control_path(Path::new(&home(45 - tail))).is_some());
        assert!(control_path(Path::new(&home(46 - tail))).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn control_folder_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("tsunagiai-ssh-test-{}", std::process::id()));
        let dir = root.join("a/b");
        assert_eq!(prepare_control(&dir).as_deref(), dir.to_str());
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        // A folder that was open to others is closed.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(prepare_control(&dir).is_some());
        assert_eq!(mode(&dir), 0o700);
        // A file in its place is refused.
        let file = root.join("file");
        std::fs::write(&file, "").unwrap();
        assert_eq!(prepare_control(&file), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn last_line_is_cut_and_cleaned() {
        assert_eq!(last_line(""), None);
        assert_eq!(last_line("\n \n"), None);
        assert_eq!(last_line("a\n b\u{1b}[0m \n\n").as_deref(), Some("b[0m"));
        let long = "x".repeat(300);
        assert_eq!(last_line(&long).map(|l| l.chars().count()), Some(200));
        // A signal's end (no code) is not ssh's own failure.
        let killed = Ran {
            code: None,
            stderr: "e".into(),
            ..Ran::default()
        };
        assert_eq!(failure(&killed, "読めません"), "読めません: e");
        // ssh's own failure is a failed connection.
        let refused = ran(EXIT_SSH, b"", "no route");
        assert_eq!(failure(&refused, "読めません"), "接続できません: no route");
    }

    #[test]
    fn runner_pipes_and_stops() {
        let sh = |script: &str| ["-c".to_owned(), script.to_owned()];
        let second = Duration::from_secs(10);
        let got = run_process("/bin/cat", &[], b"abc".to_vec(), 10, second).unwrap();
        assert_eq!(got, ran(0, b"abc", ""));
        // The stdout past the limit is dropped, and the code and stderr are kept.
        let got = run_process(
            "/bin/sh",
            &sh("cat; echo no >&2; exit 66"),
            b"abcdef".to_vec(),
            4,
            second,
        )
        .unwrap();
        assert_eq!(got, ran(66, b"abcd", "no\n"));
        // A stderr that comes in several pieces is put together in order.
        let got = run_process(
            "/bin/sh",
            &sh("i=0; while [ $i -lt 300 ]; do printf %010d $i >&2; i=$((i+1)); done"),
            Vec::new(),
            0,
            second,
        )
        .unwrap();
        let whole: String = (0..300).map(|i| format!("{i:010}")).collect();
        assert_eq!(got.stderr, whole);
        // A program that does not read its input is no failure.
        let big = vec![b'a'; 1024 * 1024];
        let got = run_process("/bin/sh", &sh("exit 75"), big, 0, second).unwrap();
        assert_eq!(got.code, Some(75));
        // A run past its time is killed.
        let started = Instant::now();
        let late = run_process(
            "/bin/sleep",
            &["30".to_owned()],
            Vec::new(),
            0,
            Duration::from_millis(100),
        );
        assert_eq!(
            late.unwrap_err(),
            "接続できません: 時間内に応答がありません"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(
            run_process("/nonexistent/ssh", &[], Vec::new(), 0, second).unwrap_err(),
            NOT_RUN
        );
    }
}
