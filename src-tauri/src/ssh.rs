//! The `ssh` command of this Mac, as the language server of a saved environment's worktree (A-34, `lsp.rs`) runs its programs through it, and the run of a process with a time limit.
//!
//! The host is a Host of `~/.ssh/config`, one element of ssh's argument list after `--`; what the host runs is a script that a caller gives, and nothing of what it reads or prints is kept or logged.
//! The names of those Hosts are read from the file for the select of the screen (`ssh_hosts`), and nothing else of it is.

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

/// How deep an `Include` goes: `~/.ssh/config` is 0, the file it includes 1, and the files from 5 on are not read.
const INCLUDE_DEPTH: usize = 4;

/// A line of `ssh_config` that names Hosts or files to include, with its words.
#[derive(Debug, PartialEq)]
enum Entry {
    Host(Vec<String>),
    Include(Vec<String>),
}

/// The `Host` and `Include` lines of the text of an `ssh_config` file, in order.
fn entries(text: &str) -> Vec<Entry> {
    let mut found = Vec::new();
    for line in text.lines() {
        let line = line.trim_start();
        let (key, rest) = line.split_at(
            line.find(|c: char| c.is_whitespace() || c == '=')
                .unwrap_or(line.len()),
        );
        let make: fn(Vec<String>) -> Entry = if key.eq_ignore_ascii_case("Host") {
            Entry::Host
        } else if key.eq_ignore_ascii_case("Include") {
            Entry::Include
        } else {
            continue;
        };
        // The keyword and its arguments are told apart by blanks and one `=`.
        let rest = rest.trim_start();
        let rest = rest.strip_prefix('=').unwrap_or(rest);
        found.push(make(words(rest)));
    }
    found
}

/// The arguments of a line: told apart by blanks, a word in double quotes kept whole, and a `#` that starts a word ending the line.
fn words(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut word: Option<String> = None;
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                word.get_or_insert_with(String::new);
            }
            c if c.is_whitespace() && !quoted => found.extend(word.take()),
            '#' if word.is_none() && !quoted => break,
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    found.extend(word);
    found
}

/// Whether `name` is a Host that is a name: no pattern (`*`, `?`) or negation (`!`), and one that ssh is given (`check_host`).
fn is_name(name: &str) -> bool {
    !name.contains(['*', '?', '!']) && check_host(name).is_ok()
}

/// Whether the name `name` matches the pattern `pattern` of `*` (any characters) and `?` (one).
fn glob_match(pattern: &[char], name: &[char]) -> bool {
    match pattern.split_first() {
        None => name.is_empty(),
        Some(('*', rest)) => (0..=name.len()).any(|n| glob_match(rest, &name[n..])),
        Some((p, rest)) => name
            .split_first()
            .is_some_and(|(c, tail)| (*p == '?' || p == c) && glob_match(rest, tail)),
    }
}

/// The files that the argument `pattern` of an `Include` names: `~` is the home folder `home`, a relative path is from `ssh_dir`, and `*` and `?` of a name are matched against the names of the folder (those that start with a dot only by a pattern that does), in the order of the names.
fn include_files(pattern: &str, home: &Path, ssh_dir: &Path) -> Vec<PathBuf> {
    let path = match pattern.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => ssh_dir.join(pattern),
    };
    let mut paths = vec![PathBuf::new()];
    for part in path.components() {
        let name = part.as_os_str().to_str().unwrap_or_default();
        if matches!(part, std::path::Component::Normal(_)) && name.contains(['*', '?']) {
            let pattern: Vec<char> = name.chars().collect();
            paths = paths
                .iter()
                .flat_map(|dir| {
                    let mut names: Vec<String> = std::fs::read_dir(dir)
                        .into_iter()
                        .flatten()
                        .flatten()
                        .filter_map(|entry| entry.file_name().into_string().ok())
                        .filter(|n| !n.starts_with('.') || name.starts_with('.'))
                        .filter(|n| glob_match(&pattern, &n.chars().collect::<Vec<_>>()))
                        .collect();
                    names.sort();
                    names.into_iter().map(|n| dir.join(n)).collect::<Vec<_>>()
                })
                .collect();
        } else {
            for p in &mut paths {
                p.push(part.as_os_str());
            }
        }
    }
    paths
}

/// Adds the Host names of the file `file` and of the files it includes (each `Include` where it stands, down to `INCLUDE_DEPTH`) to `names`. A file that cannot be read is skipped.
fn collect_hosts(file: &Path, depth: usize, home: &Path, names: &mut Vec<String>) {
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    for entry in entries(&text) {
        match entry {
            Entry::Host(list) => {
                for name in list.into_iter().filter(|n| is_name(n)) {
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
            Entry::Include(patterns) if depth < INCLUDE_DEPTH => {
                for pattern in patterns {
                    for path in include_files(&pattern, home, &home.join(".ssh")) {
                        collect_hosts(&path, depth + 1, home, names);
                    }
                }
            }
            Entry::Include(_) => {}
        }
    }
}

/// The Host names of the file `~/.ssh/config` of the home folder `home`, in the order they come, with the files it includes read where their `Include` stands.
fn hosts_in(home: &Path) -> Vec<String> {
    let mut names = Vec::new();
    collect_hosts(&home.join(".ssh/config"), 0, home, &mut names);
    names
}

/// The Host names of this Mac's `~/.ssh/config` (A-34): the select of the ssh Host of a repository takes its choices from it. An empty list when there is no file.
#[tauri::command]
pub async fn ssh_hosts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        dirs::home_dir()
            .map(|home| hosts_in(&home))
            .unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())
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

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| (*w).to_owned()).collect()
    }

    #[test]
    fn lines_name_hosts_and_includes() {
        let text = "# Host commented\n\
            \n\
            Include ~/.orbstack/ssh/config\n\
            host  a   b\t\"c d\"  # not e\n\
            \tHOST=f\n\
            Host = g\n\
            HostName not-a-host\n\
            Hostname=x\n\
            Match host h\n\
            include conf.d/*.conf \"with space/*\"\n\
            Host\n";
        assert_eq!(
            entries(text),
            [
                Entry::Include(words(&["~/.orbstack/ssh/config"])),
                Entry::Host(words(&["a", "b", "c d"])),
                Entry::Host(words(&["f"])),
                Entry::Host(words(&["g"])),
                Entry::Include(words(&["conf.d/*.conf", "with space/*"])),
                Entry::Host(Vec::new()),
            ]
        );
    }

    /// A home folder in the temporary folder with the files `files` (a path from it and its text).
    fn home_with(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let home =
            std::env::temp_dir().join(format!("tsunagiai-ssh-hosts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        for (path, text) in files {
            let path = home.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        home
    }

    #[test]
    fn hosts_are_the_names_ssh_takes() {
        let home = home_with(
            "names",
            &[(
                ".ssh/config",
                "Host github.com host-one *.example\nHost !skip dev? build\nHost -oProxyCommand=x host-one studio\nHost a*\n  HostName ignored\nHost [a]\n",
            )],
        );
        assert_eq!(
            hosts_in(&home),
            ["github.com", "host-one", "build", "studio", "[a]"]
        );
        std::fs::remove_dir_all(&home).unwrap();
        // No file, no hosts.
        assert_eq!(hosts_in(&home), Vec::<String>::new());
    }

    #[test]
    fn includes_are_read_where_they_stand() {
        let home = home_with(
            "include",
            &[
                (".ssh/config", "Host first\nInclude conf.d/*.conf ~/other/one missing/*\nInclude /nowhere ~/.ssh/config\nHost last first\n"),
                (".ssh/conf.d/b.conf", "Host b\n"),
                (".ssh/conf.d/a.conf", "Host a\nInclude deep\n"),
                (".ssh/conf.d/skip.txt", "Host skip\n"),
                (".ssh/conf.d/.hidden.conf", "Host hidden\n"),
                (".ssh/deep", "Host deep\n"),
                ("other/one", "Host one\n"),
            ],
        );
        // The glob is in the order of the names, a file read twice (its own include) adds nothing more, and a file that is not there is no error.
        assert_eq!(hosts_in(&home), ["first", "a", "deep", "b", "one", "last"]);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn globs_match_names() {
        let m = |p: &str, n: &str| {
            glob_match(
                &p.chars().collect::<Vec<_>>(),
                &n.chars().collect::<Vec<_>>(),
            )
        };
        assert!(m("*.conf", "a.conf") && m("*.conf", ".conf") && m("a?c", "abc") && m("*", ""));
        assert!(!m("*.conf", "a.confx") && !m("a?c", "ac") && !m("a", "ab") && !m("", "a"));
    }

    #[test]
    fn includes_stop_at_the_depth() {
        let chain: Vec<(String, String)> = (0..7)
            .map(|n| {
                let path = if n == 0 {
                    ".ssh/config".to_owned()
                } else {
                    format!(".ssh/c{n}")
                };
                (path, format!("Host h{n}\nInclude c{}\n", n + 1))
            })
            .collect();
        let files: Vec<(&str, &str)> = chain
            .iter()
            .map(|(p, t)| (p.as_str(), t.as_str()))
            .collect();
        let home = home_with("depth", &files);
        assert_eq!(hosts_in(&home), ["h0", "h1", "h2", "h3", "h4"]);
        std::fs::remove_dir_all(&home).unwrap();
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
