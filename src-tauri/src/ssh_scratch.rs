//! The scratchpad of an SSH host (A-30): the files of `~/.local/share/cookapps/scratchpad/` on the host, read and written by the `ssh` command of this Mac.
//!
//! The host is the `configHost` of a target of `ssh.listEditableTargets` (a Host of `~/.ssh/config`), read at each call, and it is one element of ssh's argument list. The command the host runs is one of the constant scripts below: a name and a text never go into it, they go to its standard input. Nothing of a file is kept or logged.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
#[cfg(test)]
use ts_rs::TS;

use crate::orca_files::{
    check_new_name, disk_text, editor_text, natural_cmp, too_large, OrcaFileText, OrcaSaveState,
    OrcaSaved, BAD_NAME, LIST_LIMIT, MAX_TEXT, NAME_TAKEN, NOT_CREATED, NOT_DELETED, NOT_FOUND,
    NOT_MOVED, NOT_UTF8, SAME_PLACE,
};

const SSH: &str = "/usr/bin/ssh";
/// How long one call may take, the connection included (`ConnectTimeout` is 10 seconds of it).
const TIMEOUT: Duration = Duration::from_secs(30);
/// How long the output of an ssh that has ended is waited for.
const OUTPUT_WAIT: Duration = Duration::from_secs(2);
/// The most bytes of ssh's stderr that are read.
const STDERR_MAX: u64 = 16 * 1024;
/// The most bytes of the list of names that are read.
const LIST_MAX: usize = 1024 * 1024;
/// The most characters of ssh's last line that a message shows.
const SHOWN_MAX: usize = 200;
/// The longest path of a unix socket (`sun_path` of macOS, with its end), and what ssh adds to the folder of `ControlPath`: the `/`, the 40 characters of `%C`, and the 17 of the temporary name it binds first.
const SOCKET_MAX: usize = 103;
const CONTROL_ADDS: usize = 1 + 40 + 17;

const NO_HOST: &str = "SSH ホストが見つかりません";
const BAD_HOST: &str = "SSH ホストの名前が正しくありません";
const NO_HOSTS: &str = "SSH ホストの一覧を読めません";
const NOT_CONNECTED: &str = "接続できません";
const NOT_RUN: &str = "ssh を実行できません";
const NOT_LISTED: &str = "ファイルの一覧を読めません";
const NOT_READ: &str = "ファイルを読めません";
const NOT_SAVED: &str = "保存できませんでした";

// ---- the scripts the host runs ----

/// The exit codes of the scripts (64 is an input they could not read, any other is a failure). ssh's own failure is 255.
const EXIT_MISSING: i32 = 66;
const EXIT_TOO_LARGE: i32 = 67;
const EXIT_TAKEN: i32 = 73;
const EXIT_CHANGED: i32 = 75;
const EXIT_TAKEN_OTHER: i32 = 76;
const EXIT_SSH: i32 = 255;

/// A command for the host's login shell: `sh -c` with a POSIX script in single quotes, where `$d` is the folder. The script holds no `'`, no `!` and no line break, so that sh, bash, zsh, fish and csh all pass it to `sh` as it is.
macro_rules! script {
    ($body:literal) => {
        concat!(
            "sh -c 'd=\"$HOME/.local/share/cookapps/scratchpad\"; ",
            $body,
            "'"
        )
    };
}

/// Prints each regular file of the folder (no symbolic link) as its name and `/` and a line end; a name holds no `/`, so one with a line break in it is still one piece. A folder that is missing is an empty list.
const LIST: &str = script!(
    r#"[ -d "$d" ] || exit 0; cd "$d" || exit 1; for f in * .*; do if [ -f "$f" ]; then if [ -L "$f" ]; then :; else printf "%s/\n" "$f"; fi; fi; done; exit 0"#
);

/// stdin: the name. Prints the bytes of the file. 66: no such file; 67: over 393216 bytes (`MAX_TEXT`).
const READ: &str = script!(
    r#"IFS= read -r n || exit 64; f="$d/$n"; if [ -L "$f" ]; then exit 66; fi; [ -f "$f" ] || exit 66; s=$(wc -c < "$f") || exit 1; [ $s -le 393216 ] || exit 67; cat -- "$f""#
);

/// stdin: the name, the `cksum` of the text that was read, the `cksum` of the new text, then the new text. Writes it to a temporary file beside the file (made with `cp -p`, so that it has the file's mode) and moves it over the file, only when the file still has the first `cksum` and the temporary file got the second. 66: no such file; 75: the file has another text.
const WRITE: &str = script!(
    r#"IFS= read -r n || exit 64; IFS= read -r e || exit 64; IFS= read -r w || exit 64; f="$d/$n"; if [ -L "$f" ]; then exit 66; fi; [ -f "$f" ] || exit 66; set -- $(cksum < "$f"); [ "$1 $2" = "$e" ] || exit 75; t="$d/.cookapps-$$.tmp"; rm -f -- "$t"; cp -p -- "$f" "$t" || { rm -f -- "$t"; exit 1; }; cat > "$t" || { rm -f -- "$t"; exit 1; }; set -- $(cksum < "$t"); [ "$1 $2" = "$w" ] || { rm -f -- "$t"; exit 1; }; mv -f -- "$t" "$f" || { rm -f -- "$t"; exit 1; }"#
);

/// stdin: the name. Makes the folder and an empty file in it, never over what is there (`set -C`). 73: a file of that name is there; 76: something else of that name is.
const CREATE: &str = script!(
    r#"IFS= read -r n || exit 64; mkdir -p -- "$d" || exit 1; f="$d/$n"; if [ -L "$f" ]; then exit 76; fi; if [ -f "$f" ]; then exit 73; fi; if [ -e "$f" ]; then exit 76; fi; ( set -C; : > "$f" ) && exit 0; if [ -f "$f" ]; then exit 73; fi; exit 1"#
);

/// stdin: the name, then the new name. Renames by a hard link and the removal of the old name, so that a name that is taken is never written over. 66: no such file; 73: the new name is taken.
const RENAME: &str = script!(
    r#"IFS= read -r n || exit 64; IFS= read -r m || exit 64; a="$d/$n"; b="$d/$m"; if [ -L "$a" ]; then exit 66; fi; [ -f "$a" ] || exit 66; if [ -e "$b" ]; then exit 73; fi; if [ -L "$b" ]; then exit 73; fi; ln -- "$a" "$b" || { if [ -e "$b" ]; then exit 73; fi; exit 1; }; rm -f -- "$a""#
);

/// stdin: the name. Deletes the file. 66: no such file.
const DELETE: &str = script!(
    r#"IFS= read -r n || exit 64; f="$d/$n"; if [ -L "$f" ]; then exit 66; fi; [ -f "$f" ] || exit 66; rm -f -- "$f""#
);

// ---- what the screen gets ----

/// The answer to the making of a scratchpad file on an SSH host: its name (trimmed), and whether the file was there already (nothing was written then).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct SshScratchFile {
    pub name: String,
    pub existed: bool,
}

// ---- the checks ----

/// The Host of `~/.ssh/config` that ssh is given: not empty, not an option (`-`), and no whitespace or control character.
fn check_host(host: &str) -> Result<&str, String> {
    let bad = host.is_empty()
        || host.starts_with('-')
        || host.chars().any(|c| c.is_whitespace() || c.is_control());
    if bad {
        Err(BAD_HOST.into())
    } else {
        Ok(host)
    }
}

/// The `configHost` of the target `id` in an answer of `ssh.listEditableTargets` (its `result`), checked.
fn config_host_of(result: &Value, id: &str) -> Result<String, String> {
    let target = result["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["id"].as_str() == Some(id))
        .ok_or(NO_HOST)?;
    check_host(target["configHost"].as_str().unwrap_or_default()).map(str::to_owned)
}

/// A temporary file of a save (`.cookapps-{pid}.tmp`), which is no file of the scratchpad.
fn is_temporary(name: &str) -> bool {
    name.starts_with(".cookapps-") && name.ends_with(".tmp")
}

/// The name of a scratchpad file: one name as A-18 takes for a new file (`check_new_name`), that does not start with `-` and is not a temporary file of a save.
fn check_name(name: &str) -> Result<&str, String> {
    let name = check_new_name(name)?;
    if name.starts_with('-') || is_temporary(name) {
        return Err(BAD_NAME.into());
    }
    Ok(name)
}

// ---- the signature ----

/// What POSIX `cksum` prints for `bytes`: the CRC and the count of bytes, with a space between. It is the signature of a text here, because the host can compute it again before it writes.
fn cksum(bytes: &[u8]) -> String {
    fn step(crc: u32, byte: u8) -> u32 {
        (0..8).fold(crc ^ (u32::from(byte) << 24), |c, _| {
            if c & 0x8000_0000 == 0 {
                c << 1
            } else {
                (c << 1) ^ 0x04C1_1DB7
            }
        })
    }
    let mut crc = bytes.iter().fold(0, |crc, byte| step(crc, *byte));
    let mut length = bytes.len();
    while length != 0 {
        crc = step(crc, (length & 0xFF) as u8);
        length >>= 8;
    }
    format!("{} {}", !crc, bytes.len())
}

/// Whether `signature` has the form of `cksum`: two numbers of at most 10 digits with one space between.
fn is_signature(signature: &str) -> bool {
    let number = |n: &str| (1..=10).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit());
    signature
        .split_once(' ')
        .is_some_and(|(crc, length)| number(crc) && number(length))
}

// ---- ssh ----

/// What a run of ssh left: its exit code (none when a signal ended it), its stdout up to the limit asked for, and its stderr.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Ran {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// One host, as ssh reaches it. `script` is one of the constants above, `stdin` what it reads, and `limit` the most bytes of its stdout that are kept.
pub(crate) trait Ssh {
    fn run(&mut self, script: &'static str, stdin: Vec<u8>, limit: usize) -> Result<Ran, String>;
}

/// The arguments of ssh for `script` on `host`: no question is asked (`BatchMode`), the connection is shared through a socket in `control` when there is one, no terminal, and the host after `--` as one element.
fn ssh_args(host: &str, control: Option<&str>, script: &'static str) -> Vec<String> {
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
    args.extend(["-T", "--", host, script].map(str::to_owned));
    args
}

/// Where the sockets of the shared connections go, in the home folder `home`: none when the path of a socket there would be too long for a unix socket.
fn control_path(home: &Path) -> Option<PathBuf> {
    let dir = home.join(".cache/cookapps/ssh");
    (dir.as_os_str().len() + CONTROL_ADDS <= SOCKET_MAX).then_some(dir)
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
fn failure(ran: &Ran, what: &str) -> String {
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
fn run_process(
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
        let mut kept = Vec::new();
        let mut errors = errors.take(STDERR_MAX);
        let mut buffer = [0_u8; 1024];
        while let Ok(n @ 1..) = errors.read(&mut buffer) {
            kept.extend_from_slice(&buffer[..n]);
            let _ = err_tx.send(kept.clone());
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
    // What stderr held when the process ended: the last of what its reader sent within a moment.
    let mut stderr = Vec::new();
    while let Ok(more) = err_rx.recv_timeout(Duration::from_millis(50)) {
        stderr = more;
    }
    Ok(Ran {
        code: status.code(),
        stdout,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// A host of `~/.ssh/config`, reached by this Mac's ssh.
struct Host {
    host: String,
    control: Option<String>,
}

impl Ssh for Host {
    fn run(&mut self, script: &'static str, stdin: Vec<u8>, limit: usize) -> Result<Ran, String> {
        let args = ssh_args(&self.host, self.control.as_deref(), script);
        run_process(SSH, &args, stdin, limit, TIMEOUT)
    }
}

// ---- the calls ----

/// The standard input of a script: each of `lines` with a line end, then `body`.
fn input(lines: &[&str], body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for line in lines {
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(body);
    bytes
}

/// The names in the output of `LIST`: the pieces that end with `/` and a line end, each a name `check_name` takes (a piece that is not is left out), in the order of A-18, at most as many as one list of A-18 holds.
fn names_of(stdout: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(stdout);
    let mut pieces: Vec<&str> = text.split("/\n").collect();
    // What follows the last end is no whole name (nothing, or a name cut by the limit).
    pieces.pop();
    let mut names: Vec<String> = pieces
        .into_iter()
        .filter(|name| check_name(name) == Ok(name))
        .map(str::to_owned)
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    names.truncate(LIST_LIMIT);
    names
}

fn list(ssh: &mut impl Ssh) -> Result<Vec<String>, String> {
    let ran = ssh.run(LIST, Vec::new(), LIST_MAX)?;
    match ran.code {
        Some(0) => Ok(names_of(&ran.stdout)),
        _ => Err(failure(&ran, NOT_LISTED)),
    }
}

/// The text of the file `name` for the editor, with the `cksum` of its bytes as the signature. A file over 384 KiB, one that is not UTF-8 and one with mixed line ends are refused, as A-18 does.
fn read(ssh: &mut impl Ssh, name: &str) -> Result<OrcaFileText, String> {
    let name = check_name(name)?;
    let ran = ssh.run(READ, input(&[name], &[]), MAX_TEXT + 1)?;
    match ran.code {
        Some(0) => {}
        Some(EXIT_MISSING) => return Err(NOT_FOUND.into()),
        Some(EXIT_TOO_LARGE) => return Err(too_large()),
        _ => return Err(failure(&ran, NOT_READ)),
    }
    if ran.stdout.len() > MAX_TEXT {
        return Err(too_large());
    }
    let content = std::str::from_utf8(&ran.stdout).map_err(|_| NOT_UTF8)?;
    editor_text(content, name, cksum(&ran.stdout))
}

/// Saves `content` over the file `name` when the host still holds the text whose signature is `signature`. A signature that is not one `read` gives matches no file, so nothing is sent.
fn write(
    ssh: &mut impl Ssh,
    name: &str,
    content: &str,
    crlf: bool,
    signature: &str,
) -> Result<OrcaSaved, String> {
    let name = check_name(name)?;
    let text = disk_text(content, crlf);
    if text.len() > MAX_TEXT {
        return Err(format!(
            "{} KiB を超えるファイルは保存できません",
            MAX_TEXT / 1024
        ));
    }
    let refused = |state| OrcaSaved {
        state,
        signature: signature.to_owned(),
    };
    if !is_signature(signature) {
        return Ok(refused(OrcaSaveState::Changed));
    }
    let new = cksum(text.as_bytes());
    let ran = ssh.run(WRITE, input(&[name, signature, &new], text.as_bytes()), 0)?;
    match ran.code {
        Some(0) => Ok(OrcaSaved {
            state: OrcaSaveState::Saved,
            signature: new,
        }),
        Some(EXIT_MISSING) => Ok(refused(OrcaSaveState::Missing)),
        Some(EXIT_CHANGED) => Ok(refused(OrcaSaveState::Changed)),
        _ => Err(failure(&ran, NOT_SAVED)),
    }
}

/// Makes the empty file `name`. A file of that name that is there is no failure: it is left as it is, and `existed` says so.
fn create(ssh: &mut impl Ssh, name: &str) -> Result<SshScratchFile, String> {
    let name = check_name(name)?;
    let ran = ssh.run(CREATE, input(&[name], &[]), 0)?;
    let existed = match ran.code {
        Some(0) => false,
        Some(EXIT_TAKEN) => true,
        Some(EXIT_TAKEN_OTHER) => return Err(NAME_TAKEN.into()),
        _ => return Err(failure(&ran, NOT_CREATED)),
    };
    Ok(SshScratchFile {
        name: name.to_owned(),
        existed,
    })
}

/// Renames the file `from` to `to`. A name that is taken is refused: nothing is written over.
fn rename(ssh: &mut impl Ssh, from: &str, to: &str) -> Result<(), String> {
    let (from, to) = (check_name(from)?, check_name(to)?);
    if from == to {
        return Err(SAME_PLACE.into());
    }
    let ran = ssh.run(RENAME, input(&[from, to], &[]), 0)?;
    match ran.code {
        Some(0) => Ok(()),
        Some(EXIT_MISSING) => Err(NOT_FOUND.into()),
        Some(EXIT_TAKEN) => Err(NAME_TAKEN.into()),
        _ => Err(failure(&ran, NOT_MOVED)),
    }
}

fn delete(ssh: &mut impl Ssh, name: &str) -> Result<(), String> {
    let name = check_name(name)?;
    let ran = ssh.run(DELETE, input(&[name], &[]), 0)?;
    match ran.code {
        Some(0) => Ok(()),
        Some(EXIT_MISSING) => Err(NOT_FOUND.into()),
        _ => Err(failure(&ran, NOT_DELETED)),
    }
}

// ---- the commands ----

/// Runs `call` off the async threads, on the SSH target `id` of this machine's Orca: its `configHost` is read from `ssh.listEditableTargets` just now.
async fn on_host<T: Send + 'static>(
    id: String,
    call: impl FnOnce(&mut Host) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let targets = crate::orca_link::local_call("ssh.listEditableTargets", json!({}))
        .await
        .map_err(|_| NO_HOSTS)?;
    let host = config_host_of(&targets, &id)?;
    crate::orca::blocking(move || {
        let control = dirs::home_dir()
            .and_then(|home| control_path(&home))
            .and_then(|dir| prepare_control(&dir));
        call(&mut Host { host, control })
    })
    .await?
}

/// The names of the scratchpad files of the SSH target `host` (the `id` of an `OrcaSshTarget`), in the order of A-18 (A-30). A host with no scratchpad folder has none.
#[tauri::command]
pub async fn ssh_scratch_list(host: String) -> Result<Vec<String>, String> {
    on_host(host, list).await
}

/// The text of the scratchpad file `name` of the SSH target `host`, for the editor (A-30).
#[tauri::command]
pub async fn ssh_scratch_read(host: String, name: String) -> Result<OrcaFileText, String> {
    check_name(&name)?;
    on_host(host, move |ssh| read(ssh, &name)).await
}

/// Saves the text of the editor over the scratchpad file `name` of the SSH target `host`, if the host still holds what was read (`signature`), and answers what happened (A-30). It is not tried again.
#[tauri::command]
pub async fn ssh_scratch_write(
    host: String,
    name: String,
    content: String,
    crlf: bool,
    signature: String,
) -> Result<OrcaSaved, String> {
    check_name(&name)?;
    on_host(host, move |ssh| {
        write(ssh, &name, &content, crlf, &signature)
    })
    .await
}

/// Makes the empty scratchpad file `name` on the SSH target `host`, with its folder (A-30); a file of that name that is there already is answered with `existed` true and left as it is.
#[tauri::command]
pub async fn ssh_scratch_create(host: String, name: String) -> Result<SshScratchFile, String> {
    check_name(&name)?;
    on_host(host, move |ssh| create(ssh, &name)).await
}

/// Renames the scratchpad file `from` of the SSH target `host` to `to` (A-30). A name that is taken is refused: nothing is written over.
#[tauri::command]
pub async fn ssh_scratch_rename(host: String, from: String, to: String) -> Result<(), String> {
    check_name(&from)?;
    check_name(&to)?;
    on_host(host, move |ssh| rename(ssh, &from, &to)).await
}

/// Deletes the scratchpad file `name` of the SSH target `host`, for good (A-30).
#[tauri::command]
pub async fn ssh_scratch_delete(host: String, name: String) -> Result<(), String> {
    check_name(&name)?;
    on_host(host, move |ssh| delete(ssh, &name)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPTS: [&str; 6] = [LIST, READ, WRITE, CREATE, RENAME, DELETE];

    /// A stand-in for the host: it records each run and answers the next of `answers`.
    #[derive(Default)]
    struct Fake {
        runs: Vec<(&'static str, Vec<u8>, usize)>,
        answers: Vec<Result<Ran, String>>,
    }

    impl Fake {
        fn answering(code: i32, stdout: &[u8]) -> Self {
            Self {
                answers: vec![Ok(ran(code, stdout, ""))],
                ..Self::default()
            }
        }
    }

    impl Ssh for Fake {
        fn run(
            &mut self,
            script: &'static str,
            stdin: Vec<u8>,
            limit: usize,
        ) -> Result<Ran, String> {
            self.runs.push((script, stdin, limit));
            self.answers.remove(0)
        }
    }

    fn ran(code: i32, stdout: &[u8], stderr: &str) -> Ran {
        Ran {
            code: Some(code),
            stdout: stdout.to_vec(),
            stderr: stderr.to_owned(),
        }
    }

    #[test]
    fn host_is_checked_and_found_by_id() {
        let doc = json!({"targets": [
            {"id": "s1", "label": "Example", "configHost": "example-host"},
            {"id": "s2", "configHost": "-oProxyCommand=x"},
            {"id": "s3", "configHost": "a b"},
            {"id": "s4", "configHost": ""},
            {"id": "s5"},
            {"id": "s6", "configHost": "a\nb"},
            {"id": "s7", "configHost": "a\u{3000}b"},
        ]});
        assert_eq!(config_host_of(&doc, "s1").unwrap(), "example-host");
        for id in ["s2", "s3", "s4", "s5", "s6", "s7"] {
            assert_eq!(config_host_of(&doc, id).unwrap_err(), BAD_HOST, "{id}");
        }
        assert_eq!(config_host_of(&doc, "none").unwrap_err(), NO_HOST);
        // The label is not the id.
        assert_eq!(config_host_of(&doc, "Example").unwrap_err(), NO_HOST);
        assert_eq!(config_host_of(&Value::Null, "s1").unwrap_err(), NO_HOST);
    }

    #[test]
    fn names_are_checked() {
        assert_eq!(check_name(" memo.md "), Ok("memo.md"));
        assert_eq!(check_name(".hidden"), Ok(".hidden"));
        for bad in [
            "",
            " ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "a\nb",
            "-rf",
            " -n",
            ".cookapps-12.tmp",
            &"a".repeat(256),
        ] {
            assert_eq!(check_name(bad).unwrap_err(), BAD_NAME, "{bad:?}");
        }
        assert_eq!(check_name(&"a".repeat(255)).map(str::len), Ok(255));
    }

    #[test]
    fn ssh_arguments_keep_the_host_after_the_options() {
        let args = ssh_args("example-host", Some("/home/u/.cache/cookapps/ssh"), LIST);
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
                "ControlPath=/home/u/.cache/cookapps/ssh/%C",
                "-o",
                "ControlPersist=60",
                "-T",
                "--",
                "example-host",
                LIST,
            ]
        );
        // With no folder for the sockets the connection is not shared.
        assert_eq!(
            ssh_args("h", None, READ),
            [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-T",
                "--",
                "h",
                READ
            ]
        );
        // A `%` of the folder is no token of ssh.
        assert!(ssh_args("h", Some("/a%b"), READ).contains(&"ControlPath=/a%%b/%C".to_owned()));
    }

    #[test]
    fn control_folder_must_fit_a_socket_path() {
        assert_eq!(
            control_path(Path::new("/Users/example")),
            Some(PathBuf::from("/Users/example/.cache/cookapps/ssh"))
        );
        // 45 bytes of folder is the most: 45 + 58 = 103.
        let home = |n: usize| format!("/{}", "a".repeat(n - 1));
        let tail = "/.cache/cookapps/ssh".len();
        assert!(control_path(Path::new(&home(45 - tail))).is_some());
        assert!(control_path(Path::new(&home(46 - tail))).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn control_folder_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("cookapps-ssh-test-{}", std::process::id()));
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
    fn scripts_are_constants_any_login_shell_passes_on() {
        for script in SCRIPTS {
            let body = script
                .strip_prefix("sh -c 'd=\"$HOME/.local/share/cookapps/scratchpad\"; ")
                .and_then(|rest| rest.strip_suffix('\''))
                .unwrap_or_else(|| panic!("{script}"));
            assert!(!body.contains(['\'', '!', '\n', '\r', '`']), "{script}");
            // The only backslash is the line end of printf.
            assert_eq!(body.replace("/\\n", "").matches('\\').count(), 0);
        }
        // The size the host refuses is the editor's limit.
        assert!(READ.contains(&format!("-le {MAX_TEXT} ")));
    }

    #[test]
    fn cksum_is_the_posix_one() {
        // `printf 123456789 | cksum` and `printf '' | cksum`.
        assert_eq!(cksum(b"123456789"), "930766865 9");
        assert_eq!(cksum(b""), "4294967295 0");
        assert!(is_signature(&cksum(b"abc")));
        for bad in [
            "",
            "1",
            "1  2",
            "1 2 3",
            "a 1",
            "1 -2",
            "12345678901 1",
            "1 2\n",
            " 1 2",
        ] {
            assert!(!is_signature(bad), "{bad:?}");
        }
    }

    #[test]
    fn list_reads_names_in_order() {
        let out = "b10.md/\nb2.md/\n.cookapps-9.tmp/\n-x/\nbad\nname/\nA.txt/\ncut-by-the-lim";
        let mut fake = Fake::answering(0, out.as_bytes());
        assert_eq!(list(&mut fake).unwrap(), ["A.txt", "b2.md", "b10.md"]);
        assert_eq!(fake.runs, [(LIST, Vec::new(), LIST_MAX)]);
        assert!(list(&mut Fake::answering(0, b"")).unwrap().is_empty());
    }

    #[test]
    fn list_failure_says_why() {
        let mut fake = Fake {
            answers: vec![Ok(ran(
                255,
                b"",
                "warning\nPermission denied (publickey).\n",
            ))],
            ..Fake::default()
        };
        assert_eq!(
            list(&mut fake).unwrap_err(),
            "接続できません: Permission denied (publickey)."
        );
        let mut fake = Fake {
            answers: vec![Ok(ran(1, b"", ""))],
            ..Fake::default()
        };
        assert_eq!(list(&mut fake).unwrap_err(), NOT_LISTED);
        // The runner's own failure (a timeout) is passed on.
        let mut fake = Fake {
            answers: vec![Err("接続できません: 時間内に応答がありません".into())],
            ..Fake::default()
        };
        assert_eq!(
            list(&mut fake).unwrap_err(),
            "接続できません: 時間内に応答がありません"
        );
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
        assert_eq!(failure(&killed, NOT_READ), "ファイルを読めません: e");
    }

    #[test]
    fn read_gives_the_text_and_its_cksum() {
        let mut fake = Fake::answering(0, b"a\r\nb\r\n");
        let text = read(&mut fake, " memo.md ").unwrap();
        assert_eq!(text.content, "a\nb\n");
        assert!(text.crlf);
        assert_eq!(text.signature, cksum(b"a\r\nb\r\n"));
        assert_eq!(text.language, "markdown");
        // The name is on stdin, not in the script, and one byte more than the limit is asked for.
        assert_eq!(fake.runs, [(READ, b"memo.md\n".to_vec(), MAX_TEXT + 1)]);
        assert!(!READ.contains("memo.md"));
    }

    #[test]
    fn read_refusals() {
        let err =
            |code: i32, stdout: &[u8]| read(&mut Fake::answering(code, stdout), "a").unwrap_err();
        assert_eq!(err(EXIT_MISSING, b""), NOT_FOUND);
        assert_eq!(err(EXIT_TOO_LARGE, b""), too_large());
        assert_eq!(err(0, &vec![b'a'; MAX_TEXT + 1]), too_large());
        assert_eq!(err(0, &[0xFF, 0xFE]), NOT_UTF8);
        assert_eq!(
            err(0, b"a\r\nb\n"),
            "改行コードが混ざっているファイルは開けません"
        );
        assert_eq!(err(64, b""), NOT_READ);
        assert!(read(&mut Fake::answering(0, &vec![b'a'; MAX_TEXT]), "a").is_ok());
        // A bad name runs nothing.
        let mut fake = Fake::default();
        assert_eq!(read(&mut fake, "../a").unwrap_err(), BAD_NAME);
        assert!(fake.runs.is_empty());
    }

    #[test]
    fn write_sends_the_name_the_two_cksums_and_the_text() {
        let old = cksum(b"old");
        let mut fake = Fake::answering(0, b"");
        let saved = write(&mut fake, "memo.md", "a\nb\n", true, &old).unwrap();
        let new = cksum(b"a\r\nb\r\n");
        assert_eq!(
            saved,
            OrcaSaved {
                state: OrcaSaveState::Saved,
                signature: new.clone()
            }
        );
        let stdin = format!("memo.md\n{old}\n{new}\na\r\nb\r\n").into_bytes();
        assert_eq!(fake.runs, [(WRITE, stdin, 0)]);
        assert!(!WRITE.contains("memo.md"));
    }

    #[test]
    fn write_states() {
        let old = cksum(b"old");
        let state = |code: i32| {
            write(&mut Fake::answering(code, b""), "a", "x", false, &old)
                .map(|saved| (saved.state, saved.signature == old))
        };
        assert_eq!(state(EXIT_MISSING), Ok((OrcaSaveState::Missing, true)));
        assert_eq!(state(EXIT_CHANGED), Ok((OrcaSaveState::Changed, true)));
        assert_eq!(state(1), Err(NOT_SAVED.to_owned()));
        // A signature that is not a cksum is of no file, and a text over the limit is refused: neither runs anything.
        let mut fake = Fake::default();
        let saved = write(&mut fake, "a", "x", false, "1\n2").unwrap();
        assert_eq!(saved.state, OrcaSaveState::Changed);
        let big = "a".repeat(MAX_TEXT + 1);
        assert_eq!(
            write(&mut fake, "a", &big, false, &old).unwrap_err(),
            "384 KiB を超えるファイルは保存できません"
        );
        // The line ends count: half the limit of lines is over it with CRLF.
        let lines = "\n".repeat(MAX_TEXT / 2 + 1);
        assert!(write(&mut fake, "a", &lines, true, &old).is_err());
        assert_eq!(
            write(&mut fake, "-a", "x", false, &old).unwrap_err(),
            BAD_NAME
        );
        assert!(fake.runs.is_empty());
    }

    #[test]
    fn create_answers_the_existing_file() {
        let mut fake = Fake::answering(0, b"");
        assert_eq!(
            create(&mut fake, " memo.md ").unwrap(),
            SshScratchFile {
                name: "memo.md".into(),
                existed: false
            }
        );
        assert_eq!(fake.runs, [(CREATE, b"memo.md\n".to_vec(), 0)]);
        let made = |code: i32| create(&mut Fake::answering(code, b""), "memo.md");
        assert!(made(EXIT_TAKEN).unwrap().existed);
        assert_eq!(made(EXIT_TAKEN_OTHER).unwrap_err(), NAME_TAKEN);
        assert_eq!(made(1).unwrap_err(), NOT_CREATED);
        let mut fake = Fake::default();
        assert_eq!(create(&mut fake, "a/b").unwrap_err(), BAD_NAME);
        assert!(fake.runs.is_empty());
    }

    #[test]
    fn rename_sends_both_names_and_never_overwrites() {
        let mut fake = Fake::answering(0, b"");
        rename(&mut fake, "a.md", " b.md ").unwrap();
        assert_eq!(fake.runs, [(RENAME, b"a.md\nb.md\n".to_vec(), 0)]);
        let moved = |code: i32| rename(&mut Fake::answering(code, b""), "a", "b").unwrap_err();
        assert_eq!(moved(EXIT_MISSING), NOT_FOUND);
        assert_eq!(moved(EXIT_TAKEN), NAME_TAKEN);
        assert_eq!(moved(1), NOT_MOVED);
        let mut fake = Fake::default();
        assert_eq!(rename(&mut fake, "a", " a ").unwrap_err(), SAME_PLACE);
        assert_eq!(rename(&mut fake, "a", "b/c").unwrap_err(), BAD_NAME);
        assert_eq!(rename(&mut fake, "-a", "b").unwrap_err(), BAD_NAME);
        assert!(fake.runs.is_empty());
    }

    #[test]
    fn delete_removes_one_file() {
        let mut fake = Fake::answering(0, b"");
        delete(&mut fake, "a.md").unwrap();
        assert_eq!(fake.runs, [(DELETE, b"a.md\n".to_vec(), 0)]);
        let gone = |code: i32| delete(&mut Fake::answering(code, b""), "a").unwrap_err();
        assert_eq!(gone(EXIT_MISSING), NOT_FOUND);
        assert_eq!(gone(1), NOT_DELETED);
        let mut fake = Fake::default();
        assert_eq!(delete(&mut fake, "..").unwrap_err(), BAD_NAME);
        assert!(fake.runs.is_empty());
    }

    /// This machine's `sh`, with a temporary folder as the home: it runs the command as a host's login shell would. No ssh is run.
    #[cfg(unix)]
    struct Local(&'static str, PathBuf);

    #[cfg(unix)]
    impl Ssh for Local {
        fn run(
            &mut self,
            script: &'static str,
            stdin: Vec<u8>,
            limit: usize,
        ) -> Result<Ran, String> {
            let mut child = Command::new(self.0)
                .args(["-c", script])
                .env("HOME", &self.1)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut input = child.stdin.take().unwrap();
            let writer = std::thread::spawn(move || {
                let _ = input.write_all(&stdin);
            });
            let out = child.wait_with_output().unwrap();
            writer.join().unwrap();
            let mut stdout = out.stdout;
            stdout.truncate(limit);
            Ok(Ran {
                code: out.status.code(),
                stdout,
                stderr: String::new(),
            })
        }
    }

    #[cfg(unix)]
    #[test]
    fn scripts_work_in_a_posix_shell() {
        // bash as `sh` on macOS, and dash where this machine has it.
        for shell in ["/bin/sh", "/bin/dash"] {
            if Path::new(shell).exists() {
                scripts_work_in(shell);
            }
        }
    }

    #[cfg(unix)]
    fn scripts_work_in(shell: &'static str) {
        use std::os::unix::fs::PermissionsExt;
        let home =
            std::env::temp_dir().join(format!("cookapps-scratch-test-{}", std::process::id()));
        let dir = home.join(".local/share/cookapps/scratchpad");
        std::fs::create_dir_all(&home).unwrap();
        let mut sh = Local(shell, home.clone());

        // No folder yet: an empty list, and a read finds nothing.
        assert!(list(&mut sh).unwrap().is_empty());
        assert_eq!(read(&mut sh, "memo.md").unwrap_err(), NOT_FOUND);

        // The make creates the folder and an empty file, and leaves a file that is there.
        assert!(!create(&mut sh, "memo.md").unwrap().existed);
        assert_eq!(std::fs::read(dir.join("memo.md")).unwrap(), b"");
        std::fs::write(dir.join("memo.md"), "first\n").unwrap();
        assert!(create(&mut sh, "memo.md").unwrap().existed);
        assert_eq!(std::fs::read(dir.join("memo.md")).unwrap(), b"first\n");

        // The list holds files only: no folder, no symbolic link, no temporary file.
        std::fs::create_dir(dir.join("folder")).unwrap();
        std::os::unix::fs::symlink(home.join("outside"), dir.join("link")).unwrap();
        std::fs::write(home.join("outside"), "secret").unwrap();
        std::fs::write(dir.join(".cookapps-1.tmp"), "").unwrap();
        std::fs::write(dir.join(".dot file"), "").unwrap();
        assert_eq!(list(&mut sh).unwrap(), [".dot file", "memo.md"]);
        assert_eq!(create(&mut sh, "folder").unwrap_err(), NAME_TAKEN);
        assert_eq!(create(&mut sh, "link").unwrap_err(), NAME_TAKEN);
        assert_eq!(read(&mut sh, "link").unwrap_err(), NOT_FOUND);
        assert_eq!(delete(&mut sh, "link").unwrap_err(), NOT_FOUND);
        assert_eq!(delete(&mut sh, "folder").unwrap_err(), NOT_FOUND);

        // A save writes when the file is as it was read, and keeps the file's mode.
        std::fs::set_permissions(dir.join("memo.md"), std::fs::Permissions::from_mode(0o600))
            .unwrap();
        let text = read(&mut sh, "memo.md").unwrap();
        assert_eq!(text.content, "first\n");
        let saved = write(
            &mut sh,
            "memo.md",
            "second $HOME 'q'\n",
            false,
            &text.signature,
        )
        .unwrap();
        assert_eq!(saved.state, OrcaSaveState::Saved);
        assert_eq!(
            std::fs::read(dir.join("memo.md")).unwrap(),
            b"second $HOME 'q'\n"
        );
        let mode = std::fs::metadata(dir.join("memo.md"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(read(&mut sh, "memo.md").unwrap().signature, saved.signature);
        // The old signature no longer matches, and nothing is written.
        let again = write(&mut sh, "memo.md", "third\n", false, &text.signature).unwrap();
        assert_eq!(again.state, OrcaSaveState::Changed);
        let none = write(&mut sh, "none.md", "x", false, &text.signature).unwrap();
        assert_eq!(none.state, OrcaSaveState::Missing);
        let link = write(&mut sh, "link", "x", false, &cksum(b"secret")).unwrap();
        assert_eq!(link.state, OrcaSaveState::Missing);
        assert_eq!(std::fs::read(home.join("outside")).unwrap(), b"secret");
        assert_eq!(list(&mut sh).unwrap(), [".dot file", "memo.md"]);

        // A file over the limit is refused by the host.
        std::fs::write(dir.join("big"), vec![b'a'; MAX_TEXT + 1]).unwrap();
        assert_eq!(read(&mut sh, "big").unwrap_err(), too_large());
        std::fs::write(dir.join("big"), vec![b'a'; MAX_TEXT]).unwrap();
        assert_eq!(read(&mut sh, "big").unwrap().content.len(), MAX_TEXT);

        // A rename never writes over a name that is taken.
        assert_eq!(rename(&mut sh, "memo.md", "big").unwrap_err(), NAME_TAKEN);
        assert_eq!(
            rename(&mut sh, "memo.md", "folder").unwrap_err(),
            NAME_TAKEN
        );
        assert_eq!(rename(&mut sh, "memo.md", "link").unwrap_err(), NAME_TAKEN);
        assert_eq!(rename(&mut sh, "none.md", "x").unwrap_err(), NOT_FOUND);
        rename(&mut sh, "memo.md", "a b $(id).md").unwrap();
        assert_eq!(
            std::fs::read(dir.join("a b $(id).md")).unwrap(),
            b"second $HOME 'q'\n"
        );
        assert!(!dir.join("memo.md").exists());

        delete(&mut sh, "a b $(id).md").unwrap();
        delete(&mut sh, "big").unwrap();
        assert_eq!(delete(&mut sh, "big").unwrap_err(), NOT_FOUND);
        assert_eq!(list(&mut sh).unwrap(), [".dot file"]);
        // Nothing outside the folder was touched.
        assert_eq!(std::fs::read(home.join("outside")).unwrap(), b"secret");
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// The runner, with programs of this machine that are not ssh.
    #[cfg(unix)]
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
