//! The script that opens the way to a database before MySQL is logged in to (D-1, D-2, D-3, #718).
//!
//! A connection with a script runs it as a child process, with no shell: the body is written to a file of its own (the owner only, in a folder of its own, deleted when the script has ended)
//! and that file is run, so the first line decides the interpreter (`#!/bin/sh` is put before a body that has no `#!` line).
//! The port is the one the connection names (its host and its port, D-1); it is given to the script as `TSUNAGIAI_PORT` (and, for the scripts saved before the rename, as `COOKAPPS_PORT` too, with the same value), and the script is to listen there, for instance with a port forward.
//! A port that something answers on before the script is run is an error, and the script is not run.
//! The script is ready when a TCP connection to `{host}:{TSUNAGIAI_PORT}` succeeds. It fails when the script ends before that (an exit code of 0 too), when it is not ready in two minutes,
//! and, once it was ready, when it ends: the connection is then closed. The error holds the last lines of the script's standard error.
//! While it is awaited, the lines of its standard output and standard error go to the caller (`OnLine`, `screen_line`: the control and hidden characters taken out, each cut short; a line is read up to 4,096 bytes and the rest of it is dropped), and after it is ready nothing more is given on (the output is still read, so that the script never waits for a pipe).
//! The script runs in a process group of its own, which is sent SIGTERM when the connection is closed and the app exits, and SIGKILL when it is still there after a few seconds.
//!
//! `start` takes the folder for the script file as a `&Path`, so that `tsunagiai-mcp` can start a script the same way. `Scripts` keeps the scripts that are open for the app (`lib.rs`).
//! The decisions (the shebang, the lines kept, the words of an error) are pure functions.

use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    net::TcpStream,
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::{oneshot, watch, Mutex},
    task::JoinHandle,
};

use super::mysql::shorten;

/// The environment variable that gives the script the port it is to listen on.
pub const PORT_ENV: &str = "TSUNAGIAI_PORT";
/// The name that the variable had before the app was renamed. It is given the same value, so that a saved script that reads it keeps working.
pub const OLD_PORT_ENV: &str = "COOKAPPS_PORT";
const SCRIPT_FILE: &str = "script";
/// The most bytes of one line of the output that are kept; the rest of a longer line is dropped up to its line feed, so that an output with no line feed never grows a buffer.
const LINE_MAX: usize = 4096;
/// How many of the last lines of the standard error an error shows.
const TAIL_LINES: usize = 5;
/// How often the port is tried while the script is not ready.
const POLL: Duration = Duration::from_millis(100);
/// One try of the port.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
/// One lookup of the host's name.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the addresses found are kept while the port does not answer, before the name is looked up again.
const RELOOKUP: Duration = Duration::from_secs(2);
/// How long the end of the script waits for the last of its standard error.
const STDERR_WAIT: Duration = Duration::from_secs(1);
/// `ETXTBSY`: the file is still open for writing in another thread that forked meanwhile.
const TEXT_BUSY: i32 = 26;

/// How long a script may take to be ready, and how long the group has to end after SIGTERM before SIGKILL.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub ready: Duration,
    pub grace: Duration,
}

pub const TIMING: Timing = Timing {
    ready: Duration::from_secs(120),
    grace: Duration::from_secs(5),
};

/// How a script ended: its exit code (none when a signal ended it) and the last lines of its standard error.
#[derive(Clone, Debug, PartialEq)]
struct Exit {
    code: Option<i32>,
    tail: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Stage {
    /// Ended before the port answered.
    Early,
    /// The port did not answer in time.
    Slow,
    /// Ended after the port answered.
    Late,
}

/// `body` with the interpreter line a file that is run needs: a body that has none is run by `/bin/sh`.
fn with_shebang(body: &str) -> String {
    if body.starts_with("#!") {
        body.to_owned()
    } else {
        format!("#!/bin/sh\n{body}")
    }
}

/// Where the lines of a script's output go while the script is awaited (the connection that opens shows the last one, D-3, #1027).
/// It is called with a line that `screen_line` made, never an empty one.
pub type OnLine = Arc<dyn Fn(String) + Send + Sync>;

/// What a line of the output is on the screen: the control characters taken out (a tab becomes a space), the hidden characters too (zero-width, bidirectional formatting and tag characters, the ones A-9 takes out of a card), and the line cut to `shorten`'s length; none when no text is left.
fn screen_line(raw: &str) -> Option<String> {
    let text: String = raw
        .chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .collect();
    let text = shorten(&crate::orca_handoff::without_hidden(&text));
    (!text.is_empty()).then_some(text)
}

/// Gives the lines of the output on while `awaited` holds, and nothing after that: a script that stays up writes for as long as it runs.
#[derive(Clone)]
struct Sink {
    on_line: OnLine,
    awaited: Arc<AtomicBool>,
}

impl Sink {
    fn line(&self, raw: &str) {
        if !self.awaited.load(Ordering::Relaxed) {
            return;
        }
        if let Some(text) = screen_line(raw) {
            (self.on_line)(text);
        }
    }
}

/// Ends the wait for the script when `start` returns, by any way.
struct Awaiting(Arc<AtomicBool>);

impl Drop for Awaiting {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// Keeps the last `TAIL_LINES` lines that have text, each cut short.
fn push_tail(tail: &mut VecDeque<String>, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    if tail.len() == TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(shorten(line));
}

fn code_text(code: Option<i32>) -> String {
    match code {
        Some(n) => format!("終了コード {n}"),
        None => "シグナルで終了".to_owned(),
    }
}

fn limit_text(limit: Duration) -> String {
    let secs = limit.as_secs();
    if secs >= 60 && secs.is_multiple_of(60) {
        format!("{} 分", secs / 60)
    } else {
        format!("{secs} 秒")
    }
}

/// What the screen is told of a script that failed, in Japanese, with the last lines of its standard error.
fn failure_text(stage: Stage, exit: &Exit, limit: Duration) -> String {
    let head = match stage {
        Stage::Early => format!(
            "接続のスクリプトが、準備ができる前に終了しました（{}）",
            code_text(exit.code)
        ),
        Stage::Slow => format!(
            "接続のスクリプトが {}たっても準備できませんでした",
            limit_text(limit)
        ),
        Stage::Late => format!(
            "接続のスクリプトが終了したため、接続を閉じました（{}）",
            code_text(exit.code)
        ),
    };
    if exit.tail.is_empty() {
        head
    } else {
        format!("{head}。標準エラーの最後の行: {}", exit.tail.join(" / "))
    }
}

/// How the text of `in_use_text` ends (the part that does not hold the host and the port).
const IN_USE_TAIL: &str = "使っているものを止めるか、別のポートにしてください";

/// What the screen is told when something already answers on the port the script is to listen on.
fn in_use_text(host: &str, port: u16) -> String {
    format!("{host}:{port} は、スクリプトを実行する前から使われています。{IN_USE_TAIL}")
}

/// Whether `text` is the error of a port that was in use before the script was run (`tsunagiai-mcp` adds its own hint to it).
pub fn is_in_use_text(text: &str) -> bool {
    text.ends_with(IN_USE_TAIL)
}

/// The addresses of `host:port`; none when the name cannot be looked up (a host that only a running script makes known, such as one behind a VPN, has none yet).
async fn resolve(host: &str, port: u16) -> Vec<SocketAddr> {
    match tokio::time::timeout(RESOLVE_TIMEOUT, tokio::net::lookup_host((host, port))).await {
        Ok(Ok(found)) => found.collect(),
        _ => Vec::new(),
    }
}

/// Whether a TCP connection to one of `addrs` succeeds now: the port is in use before the script is run, and it is ready after.
async fn answers(addrs: &[SocketAddr]) -> bool {
    tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect(addrs))
        .await
        .is_ok_and(|connected| connected.is_ok())
}

/// A folder of its own in `dir` (the owner only) with the script in it, made to be run. Deleted by `supervise`.
fn make_folder(dir: &Path, body: &str) -> std::io::Result<PathBuf> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(std::io::Error::other)?;
    let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let folder = dir.join(format!("tsunagiai-script-{name}"));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&folder)?;
    let written = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o700);
        let mut file = options.open(folder.join(SCRIPT_FILE))?;
        file.write_all(with_shebang(body).as_bytes())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&folder);
        return Err(e);
    }
    Ok(folder)
}

async fn spawn(command: &mut Command) -> std::io::Result<Child> {
    let mut tries = 0;
    loop {
        match command.spawn() {
            Err(e) if e.raw_os_error() == Some(TEXT_BUSY) && tries < 5 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            other => return other,
        }
    }
}

/// Reads `stream` to its end, line by line, and gives each to `each`. Text that is not UTF-8 is read with replacement characters.
/// A line keeps its first `LINE_MAX` bytes: the rest of it is read and dropped up to its line feed, so an output with no line feed holds no more than `LINE_MAX` bytes.
async fn read_lines<R: AsyncRead + Unpin>(stream: R, mut each: impl FnMut(&str)) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        let (used, ended) = match reader.fill_buf().await {
            Ok(buf) if !buf.is_empty() => {
                let feed = buf.iter().position(|&b| b == b'\n');
                let used = feed.map_or(buf.len(), |at| at + 1);
                let room = LINE_MAX.saturating_sub(line.len());
                line.extend_from_slice(&buf[..used.min(room)]);
                (used, feed.is_some())
            }
            _ => break,
        };
        reader.consume(used);
        if ended {
            each(&String::from_utf8_lossy(&line));
            line.clear();
        }
    }
    if !line.is_empty() {
        each(&String::from_utf8_lossy(&line));
    }
}

/// Reads the standard output and the standard error to their ends (the script must never wait for a pipe to be emptied): the lines of both go to `sink`, and the last lines of the standard error are kept in `tail`.
async fn read_output(
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    tail: Arc<StdMutex<VecDeque<String>>>,
    sink: Option<Sink>,
) {
    let out = async {
        if let Some(stdout) = stdout {
            read_lines(stdout, |text| {
                if let Some(sink) = &sink {
                    sink.line(text);
                }
            })
            .await;
        }
    };
    let err = async {
        if let Some(stderr) = stderr {
            read_lines(stderr, |text| {
                push_tail(&mut tail.lock().unwrap_or_else(|e| e.into_inner()), text);
                if let Some(sink) = &sink {
                    sink.line(text);
                }
            })
            .await;
        }
    };
    tokio::join!(out, err);
}

/// Sends `signal` to every process of the group. False when the group has no process left (or the OS has no groups).
#[cfg(unix)]
fn signal_group(pgid: i32, signal: i32) -> bool {
    // SAFETY: `kill` with a negative pid only sends a signal to a group; it touches no memory of ours.
    unsafe { libc::kill(-pgid, signal) == 0 }
}

#[cfg(not(unix))]
fn signal_group(_pgid: i32, _signal: i32) -> bool {
    false
}

#[cfg(unix)]
const TERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const KILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const TERM: i32 = 15;
#[cfg(not(unix))]
const KILL: i32 = 9;

/// Ends what is left of the group once its first process is gone: SIGTERM, and SIGKILL when something is still there after `grace`.
async fn end_group(pgid: i32, grace: Duration) {
    if !signal_group(pgid, TERM) {
        return;
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Signal 0 only asks whether the group has a process.
        if !signal_group(pgid, 0) {
            return;
        }
    }
    signal_group(pgid, KILL);
}

/// Owns the child until it ends: by itself, or when `stop` comes (or the `Script` is dropped). Then it ends the group, waits for the last of the standard error, deletes the folder and tells how it ended.
#[allow(clippy::too_many_arguments)]
async fn supervise(
    mut child: Child,
    pgid: i32,
    reader: JoinHandle<()>,
    tail: Arc<StdMutex<VecDeque<String>>>,
    folder: PathBuf,
    grace: Duration,
    mut stop: oneshot::Receiver<()>,
    done: watch::Sender<Option<Exit>>,
) {
    let mut stopped = false;
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        _ = &mut stop => {
            stopped = true;
            None
        }
    };
    let status = if stopped {
        #[cfg(not(unix))]
        let _ = child.start_kill();
        signal_group(pgid, TERM);
        match tokio::time::timeout(grace, child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                signal_group(pgid, KILL);
                child.wait().await.ok()
            }
        }
    } else {
        status
    };
    end_group(pgid, grace).await;
    let _ = tokio::time::timeout(STDERR_WAIT, reader).await;
    let lines = tail
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .cloned()
        .collect();
    let _ = tokio::fs::remove_dir_all(&folder).await;
    let _ = done.send(Some(Exit {
        code: status.and_then(|s| s.code()),
        tail: lines,
    }));
}

/// A script that is running and ready.
pub struct Script {
    /// The process group of the script (0 when its id could not be read: no signal is sent then).
    pgid: i32,
    done: watch::Receiver<Option<Exit>>,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl Script {
    /// The words of the failure when the script has ended (after it was ready); none while it runs.
    pub fn exited(&self) -> Option<String> {
        self.done
            .borrow()
            .as_ref()
            .map(|exit| failure_text(Stage::Late, exit, TIMING.ready))
    }

    /// Ends the script: SIGTERM to its group, SIGKILL after the grace, and the folder is deleted when this has returned.
    pub async fn stop(self) {
        self.finish().await;
    }

    async fn finish(mut self) -> Option<Exit> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = (&mut self.task).await;
        self.done.borrow().clone()
    }
}

impl Drop for Script {
    /// A `Script` that is dropped while its group may still run (the runtime ended before `supervise` could end it, as when `tsunagiai-mcp` ends while `db_test` waits) kills the group,
    /// because `kill_on_drop` reaches only the first process and a child of the script (a `session-manager-plugin`, for instance) would stay. After `supervise` has ended the group (`done` is set) nothing is sent, as the id may be another process's by then.
    fn drop(&mut self) {
        if self.pgid > 0 && self.done.borrow().is_none() {
            signal_group(self.pgid, KILL);
        }
    }
}

/// Starts the script `body` written in a folder of `dir`, with `port` given as `TSUNAGIAI_PORT` and `COOKAPPS_PORT`, and answers when `host:port` answers, or why it does not.
/// A port that answers before the script is run is an error, and nothing is run.
/// While the script is awaited, each line of its output goes to `on_line` (none: the output is read and dropped).
pub async fn start(
    dir: &Path,
    host: &str,
    port: u16,
    body: &str,
    timing: Timing,
    on_line: Option<OnLine>,
) -> Result<Script, String> {
    // A name that cannot be looked up is not in use: the script may be what makes it known.
    let mut addrs = resolve(host, port).await;
    if !addrs.is_empty() && answers(&addrs).await {
        return Err(in_use_text(host, port));
    }
    let folder = {
        let (dir, body) = (dir.to_owned(), body.to_owned());
        tokio::task::spawn_blocking(move || make_folder(&dir, &body))
            .await
            .map_err(std::io::Error::other)
            .and_then(|made| made)
            .map_err(|e| format!("スクリプトのファイルを作れません: {e}"))?
    };
    let mut command = Command::new(folder.join(SCRIPT_FILE));
    command
        .current_dir(&folder)
        .env(PORT_ENV, port.to_string())
        .env(OLD_PORT_ENV, port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match spawn(&mut command).await {
        Ok(child) => child,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&folder).await;
            return Err(format!("スクリプトを起動できません: {e}"));
        }
    };
    let pgid = child.id().and_then(|p| i32::try_from(p).ok()).unwrap_or(0);
    let tail = Arc::new(StdMutex::new(VecDeque::new()));
    let awaited = Arc::new(AtomicBool::new(true));
    let _awaiting = Awaiting(awaited.clone());
    let sink = on_line.map(|on_line| Sink { on_line, awaited });
    let reader = tokio::spawn(read_output(
        child.stdout.take(),
        child.stderr.take(),
        tail.clone(),
        sink,
    ));
    let (stop, stopped) = oneshot::channel();
    let (done_tx, done) = watch::channel(None);
    let task = tokio::spawn(supervise(
        child,
        pgid,
        reader,
        tail,
        folder,
        timing.grace,
        stopped,
        done_tx,
    ));
    let mut script = Script {
        pgid,
        done,
        stop: Some(stop),
        task,
    };
    let deadline = Instant::now() + timing.ready;
    let mut looked_up = Instant::now();
    loop {
        let ended = script.done.borrow().clone();
        if let Some(exit) = ended {
            let _ = script.finish().await;
            return Err(failure_text(Stage::Early, &exit, timing.ready));
        }
        if !addrs.is_empty() && answers(&addrs).await {
            return Ok(script);
        }
        // The name is looked up again while it has no address, and when the addresses found do not answer (every `RELOOKUP`).
        if addrs.is_empty() || looked_up.elapsed() >= RELOOKUP {
            let left = deadline.saturating_duration_since(Instant::now());
            let lookup = tokio::select! {
                found = resolve(host, port) => Some(found),
                _ = script.done.changed() => None,
                _ = tokio::time::sleep(left) => None,
            };
            looked_up = Instant::now();
            if let Some(found) = lookup.filter(|found| !found.is_empty()) {
                addrs = found;
                if answers(&addrs).await {
                    return Ok(script);
                }
            }
        }
        let now = Instant::now();
        if now >= deadline {
            let exit = script.finish().await.unwrap_or(Exit {
                code: None,
                tail: Vec::new(),
            });
            return Err(failure_text(Stage::Slow, &exit, timing.ready));
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL.min(deadline - now)) => {}
            _ = script.done.changed() => {}
        }
    }
}

/// The scripts that are open. Managed by Tauri (`lib.rs`), so that the app's exit ends them.
#[derive(Default)]
pub struct Scripts {
    next: AtomicU64,
    open: Mutex<HashMap<u64, Script>>,
}

impl Scripts {
    /// Starts the script `body`, in a folder of the system's temporary folder, and answers its id (what `close` takes) once `host:port` answers. The error is in Japanese.
    /// The lines of its output go to `on_line` until then (`start`).
    pub async fn open(
        &self,
        host: &str,
        port: u16,
        body: &str,
        on_line: Option<OnLine>,
    ) -> Result<u64, String> {
        let script = start(&std::env::temp_dir(), host, port, body, TIMING, on_line).await?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.open.lock().await.insert(id, script);
        Ok(id)
    }

    /// The words of the failure when the script of `id` has ended since it was ready; none while it runs, and none for an id that is not open.
    pub async fn exited(&self, id: u64) -> Option<String> {
        self.open.lock().await.get(&id)?.exited()
    }

    /// Keeps a script that was started by `start`, for the tests of the sessions.
    #[cfg(test)]
    pub(super) async fn insert(&self, script: Script) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.open.lock().await.insert(id, script);
        id
    }

    /// Ends the script of `id`. An id that is not open is ended already.
    pub async fn close(&self, id: u64) {
        let script = self.open.lock().await.remove(&id);
        if let Some(script) = script {
            script.stop().await;
        }
    }

    /// Ends every script that is open (the app's exit), all at once.
    pub async fn close_all(&self) {
        let scripts: Vec<Script> = self.open.lock().await.drain().map(|(_, s)| s).collect();
        futures_util::future::join_all(scripts.into_iter().map(Script::stop)).await;
    }
}

/// What the tests of the scripts and of the sessions share: a port that is free now, and a listener that comes up after the script is run, as a script's own does.
#[cfg(test)]
pub(super) mod support {
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicU16, Ordering},
            mpsc, OnceLock,
        },
        thread,
        time::Duration,
    };

    /// The ports of `free_port`: 10000 to 29999, in `WINDOWS` windows of `WINDOW` ports.
    const FIRST_PORT: u16 = 10_000;
    const WINDOW: u16 = 100;
    const WINDOWS: u32 = 200;

    /// A port that nothing answers on now, outside the range the OS gives to outgoing connections (49152 and up on macOS, 32768 and up on Linux).
    /// It is never bound, even for an instant: a script that another test starts in that instant is forked with the listener's file and holds it until its `exec`, and `start` of this test then finds the port answering before its script is run.
    /// The tests of the process take the ports one after another, so no two of them have the same one, and the process has a window of `WINDOW` ports that no other test process has (`window`).
    pub fn free_port() -> u16 {
        static NEXT: AtomicU16 = AtomicU16::new(0);
        let (window, _) = window();
        loop {
            let port = FIRST_PORT + window * WINDOW + NEXT.fetch_add(1, Ordering::Relaxed) % WINDOW;
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_err() {
                return port;
            }
        }
    }

    /// The window of ports of this process: the first of the `WINDOWS` whose file in the temporary folder it can lock, from the one its id gives. The lock is kept (with the file) until the process ends.
    fn window() -> &'static (u16, std::fs::File) {
        static WINDOW_OF_PROCESS: OnceLock<(u16, std::fs::File)> = OnceLock::new();
        WINDOW_OF_PROCESS.get_or_init(|| {
            let first = std::process::id() % WINDOWS;
            (0..WINDOWS)
                .find_map(|step| {
                    let window = u16::try_from((first + step) % WINDOWS).unwrap();
                    let file = std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(false)
                        .open(std::env::temp_dir().join(format!("tsunagiai-test-ports-{window}")))
                        .ok()?;
                    file.try_lock().ok()?;
                    Some((window, file))
                })
                .expect("a window of ports that no other test process has")
        })
    }

    /// Listens on `port` from when it is told to until it is dropped.
    pub struct Later {
        stop: Option<mpsc::Sender<()>>,
        thread: Option<thread::JoinHandle<()>>,
    }

    /// Listens on `port` from when the file `marker` exists (the script makes it as its first line, so `start` has looked at the port already) until it is dropped.
    pub fn listen_after(port: u16, marker: PathBuf) -> Later {
        let (stop, stopped) = mpsc::channel::<()>();
        let thread = thread::spawn(move || {
            // A drop of `Later` ends the wait: the channel is disconnected.
            while !marker.exists() {
                if !matches!(
                    stopped.recv_timeout(Duration::from_millis(5)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    return;
                }
            }
            let _listener = std::net::TcpListener::bind(("127.0.0.1", port));
            let _ = stopped.recv();
        });
        Later {
            stop: Some(stop),
            thread: Some(thread),
        }
    }

    impl Drop for Later {
        fn drop(&mut self) {
            drop(self.stop.take());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit(code: Option<i32>, tail: &[&str]) -> Exit {
        Exit {
            code,
            tail: tail.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn a_body_with_no_interpreter_line_gets_bin_sh() {
        assert_eq!(with_shebang("echo hi"), "#!/bin/sh\necho hi");
        assert_eq!(with_shebang("#!/bin/bash\necho hi"), "#!/bin/bash\necho hi");
        assert_eq!(with_shebang(""), "#!/bin/sh\n");
    }

    #[test]
    fn keeps_the_last_lines_that_have_text() {
        let mut tail = VecDeque::new();
        push_tail(&mut tail, "   \n");
        for n in 1..=7 {
            push_tail(&mut tail, &format!("line {n}\n"));
        }
        assert_eq!(
            tail.iter().map(String::as_str).collect::<Vec<_>>(),
            ["line 3", "line 4", "line 5", "line 6", "line 7"]
        );
        let mut long = VecDeque::new();
        push_tail(&mut long, &"x".repeat(1000));
        assert!(long[0].chars().count() < 400);
    }

    #[test]
    fn a_line_of_the_output_loses_its_control_characters_and_is_cut() {
        assert_eq!(screen_line("hello\n").as_deref(), Some("hello"));
        assert_eq!(
            screen_line("\u{1b}[32mok\u{1b}[0m\r").as_deref(),
            Some("[32mok[0m")
        );
        assert_eq!(screen_line("a\tb\u{7}c").as_deref(), Some("a bc"));
        assert_eq!(screen_line("\u{85}x\u{9f}y").as_deref(), Some("xy"));
        assert_eq!(screen_line("   \t \n"), None);
        assert_eq!(screen_line("\u{1b}\u{7}\r\n"), None);
        assert_eq!(screen_line(""), None);
        let long = screen_line(&"x".repeat(1000)).unwrap();
        assert_eq!(long.chars().count(), 301);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn a_line_of_the_output_loses_its_hidden_characters() {
        // Zero-width, bidirectional formatting, word joiner, BOM and tag characters (the ones A-9 takes out of a card) do not reach the screen.
        assert_eq!(
            screen_line("a\u{200b}b\u{202e}c\u{2066}d\u{2069}e\u{2060}f\u{feff}g\u{e0041}h")
                .as_deref(),
            Some("abcdefgh")
        );
        assert_eq!(screen_line("\u{200b}\u{202e}\u{feff}\n"), None);
    }

    async fn lines_of(output: &[u8]) -> Vec<String> {
        let mut got = Vec::new();
        read_lines(output, |text| got.push(text.to_owned())).await;
        got
    }

    #[tokio::test]
    async fn the_output_is_read_line_by_line_to_its_end() {
        assert_eq!(
            lines_of(b"a\nb\r\n\n\nlast").await,
            ["a\n", "b\r\n", "\n", "\n", "last"]
        );
        assert!(lines_of(b"").await.is_empty());
        let bytes = [b"caf".as_slice(), &[0xff], b"\n"].concat();
        assert_eq!(lines_of(&bytes).await, ["caf\u{fffd}\n"]);
    }

    #[tokio::test]
    async fn a_line_longer_than_the_limit_is_cut_and_the_rest_of_it_is_skipped() {
        let mut output = Vec::new();
        output.extend_from_slice(b"before\n");
        output.extend(std::iter::repeat_n(b'x', LINE_MAX * 3 + 17));
        output.extend_from_slice(b"\nafter\n");
        let got = lines_of(&output).await;
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], "before\n");
        assert_eq!(got[1], "x".repeat(LINE_MAX));
        assert_eq!(got[2], "after\n");
        // A line of exactly the limit with its line feed, and a long last line with none.
        let mut exact = vec![b'y'; LINE_MAX - 1];
        exact.push(b'\n');
        exact.extend(std::iter::repeat_n(b'z', LINE_MAX * 2));
        let got = lines_of(&exact).await;
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].len(), LINE_MAX);
        assert_eq!(got[1], "z".repeat(LINE_MAX));
    }

    #[test]
    fn says_each_failure_in_japanese_with_the_last_lines() {
        let limit = Duration::from_secs(120);
        let before = failure_text(Stage::Early, &exit(Some(0), &["a", "b"]), limit);
        assert_eq!(
            before,
            "接続のスクリプトが、準備ができる前に終了しました（終了コード 0）。標準エラーの最後の行: a / b"
        );
        assert_eq!(
            failure_text(Stage::Early, &exit(None, &[]), limit),
            "接続のスクリプトが、準備ができる前に終了しました（シグナルで終了）"
        );
        assert_eq!(
            failure_text(Stage::Slow, &exit(None, &["x"]), limit),
            "接続のスクリプトが 2 分たっても準備できませんでした。標準エラーの最後の行: x"
        );
        assert!(
            failure_text(Stage::Slow, &exit(None, &[]), Duration::from_secs(90))
                .contains("90 秒たっても")
        );
        assert_eq!(
            failure_text(Stage::Late, &exit(Some(3), &["oops"]), limit),
            "接続のスクリプトが終了したため、接続を閉じました（終了コード 3）。標準エラーの最後の行: oops"
        );
    }

    #[test]
    fn tells_the_text_of_a_port_in_use_from_the_other_errors() {
        assert!(is_in_use_text(&in_use_text("127.0.0.1", 3307)));
        assert!(!is_in_use_text("スクリプトを起動できません: x"));
    }

    #[test]
    fn says_that_the_port_is_in_use_with_the_host_and_the_port() {
        assert_eq!(
            in_use_text("127.0.0.1", 3307),
            "127.0.0.1:3307 は、スクリプトを実行する前から使われています。使っているものを止めるか、別のポートにしてください"
        );
    }

    #[tokio::test]
    async fn closing_a_script_that_is_not_open_is_done() {
        let scripts = Scripts::default();
        scripts.close(7).await;
        assert_eq!(scripts.exited(7).await, None);
        scripts.close_all().await;
    }

    #[cfg(unix)]
    mod running {
        use super::support::{free_port, listen_after};
        use super::*;

        const HOST: &str = "127.0.0.1";

        /// A folder of the test's own for the files of the scripts, deleted at the end.
        struct Dir(PathBuf);

        impl Dir {
            fn new(name: &str) -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "tsunagiai-script-test-{}-{name}",
                    std::process::id()
                ));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                Self(dir)
            }

            fn leftovers(&self) -> usize {
                std::fs::read_dir(&self.0)
                    .unwrap()
                    .filter(|e| {
                        e.as_ref().is_ok_and(|e| {
                            e.file_name()
                                .to_string_lossy()
                                .starts_with("tsunagiai-script-")
                        })
                    })
                    .count()
            }

            fn file(&self, name: &str) -> PathBuf {
                self.0.join(name)
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        fn quick(ready_ms: u64) -> Timing {
            Timing {
                ready: Duration::from_millis(ready_ms),
                grace: Duration::from_millis(300),
            }
        }

        fn alive(pid: i32) -> bool {
            // SAFETY: signal 0 only asks whether the process exists.
            unsafe { libc::kill(pid, 0) == 0 }
        }

        async fn read_pid(path: &Path) -> i32 {
            for _ in 0..100 {
                if let Ok(text) = std::fs::read_to_string(path) {
                    if let Ok(pid) = text.trim().parse() {
                        return pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("no pid in {}", path.display());
        }

        async fn gone(pid: i32) -> bool {
            for _ in 0..100 {
                if !alive(pid) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            false
        }

        #[tokio::test]
        async fn is_ready_when_the_port_answers_and_is_given_the_port_in_the_environment() {
            let dir = Dir::new("ready");
            let port = free_port();
            let out = dir.file("port");
            let _listener = listen_after(port, out.clone());
            let body = format!(
                "echo \"${PORT_ENV} ${OLD_PORT_ENV}\" > '{}'\nsleep 30",
                out.display()
            );
            let script = start(&dir.0, HOST, port, &body, quick(10_000), None)
                .await
                .unwrap();
            assert_eq!(script.exited(), None);
            assert_eq!(dir.leftovers(), 1);
            for _ in 0..100 {
                if out.exists() && std::fs::read_to_string(&out).unwrap().ends_with('\n') {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            // The variable of the new name, and the old name with the same value for a saved script.
            assert_eq!(
                std::fs::read_to_string(&out).unwrap().trim(),
                format!("{port} {port}")
            );
            assert_eq!(PORT_ENV, "TSUNAGIAI_PORT");
            assert_eq!(OLD_PORT_ENV, "COOKAPPS_PORT");
            script.stop().await;
            assert_eq!(dir.leftovers(), 0, "the folder of the script is deleted");
        }

        #[tokio::test]
        async fn runs_a_body_with_its_own_interpreter_line() {
            let dir = Dir::new("shebang");
            let port = free_port();
            let out = dir.file("shell");
            let _listener = listen_after(port, out.clone());
            let body = format!(
                "#!/bin/bash\necho \"$BASH_VERSION\" > '{}'\nsleep 30",
                out.display()
            );
            let script = start(&dir.0, HOST, port, &body, quick(10_000), None)
                .await
                .unwrap();
            for _ in 0..100 {
                if std::fs::read_to_string(&out).is_ok_and(|t| t.ends_with('\n')) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(!std::fs::read_to_string(&out).unwrap().trim().is_empty());
            script.stop().await;
        }

        /// A place for the lines that a script's output gives while it is awaited.
        fn collect() -> (OnLine, Arc<StdMutex<Vec<String>>>) {
            let lines = Arc::new(StdMutex::new(Vec::new()));
            let into = lines.clone();
            let on_line: OnLine = Arc::new(move |line| into.lock().unwrap().push(line));
            (on_line, lines)
        }

        #[tokio::test]
        async fn gives_the_lines_of_both_outputs_while_it_is_awaited_and_keeps_the_error_tail() {
            let dir = Dir::new("lines");
            let (on_line, lines) = collect();
            let result = start(
                &dir.0,
                HOST,
                free_port(),
                "echo one\nsleep 0.3\necho two >&2\nsleep 0.3\necho '  '\nprintf 'x\\033y\\n'\nexit 1",
                quick(10_000),
                Some(on_line),
            )
            .await;
            assert_eq!(*lines.lock().unwrap(), ["one", "two", "xy"]);
            // The standard error is still the error's tail, and the standard output is not.
            assert_eq!(
                result.err().as_deref(),
                Some("接続のスクリプトが、準備ができる前に終了しました（終了コード 1）。標準エラーの最後の行: two")
            );
        }

        #[tokio::test]
        async fn gives_no_line_once_the_script_is_ready_and_still_reads_what_it_writes() {
            let dir = Dir::new("after-ready");
            let port = free_port();
            let marker = dir.file("up");
            let _listener = listen_after(port, marker.clone());
            let (on_line, lines) = collect();
            let body = format!(
                "echo before\ntouch '{}'\nsleep 1\necho late\necho late >&2\nsleep 30",
                marker.display()
            );
            let script = start(&dir.0, HOST, port, &body, quick(10_000), Some(on_line))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(1_800)).await;
            assert!(!lines.lock().unwrap().contains(&"late".to_owned()));
            assert_eq!(script.exited(), None);
            script.stop().await;
        }

        #[tokio::test]
        async fn fails_with_the_last_lines_when_it_ends_before_it_is_ready_even_with_exit_code_0() {
            let dir = Dir::new("early");
            let result = start(
                &dir.0,
                HOST,
                free_port(),
                "echo one >&2\necho two >&2\necho three >&2\nexit 0",
                quick(10_000),
                None,
            )
            .await;
            assert_eq!(
                result.err().as_deref(),
                Some("接続のスクリプトが、準備ができる前に終了しました（終了コード 0）。標準エラーの最後の行: one / two / three")
            );
            assert_eq!(dir.leftovers(), 0);
        }

        #[tokio::test]
        async fn fails_with_the_exit_code_of_a_script_that_fails_before_it_is_ready() {
            let dir = Dir::new("early-code");
            let err = start(
                &dir.0,
                HOST,
                free_port(),
                "echo nope >&2\nexit 7",
                quick(10_000),
                None,
            )
            .await
            .err()
            .unwrap();
            assert!(
                err.contains("終了コード 7") && err.ends_with("nope"),
                "{err}"
            );
        }

        #[tokio::test]
        async fn fails_when_it_is_not_ready_in_time_and_ends_its_whole_group() {
            let dir = Dir::new("slow");
            let pid_file = dir.file("pid");
            let body = format!(
                "echo waiting >&2\nsleep 30 &\necho $! > '{}'\nwait",
                pid_file.display()
            );
            let started = Instant::now();
            // 2 s, not less: on a loaded machine the stderr of the script was not read yet after 400 ms.
            let err = start(&dir.0, HOST, free_port(), &body, quick(2_000), None)
                .await
                .err()
                .unwrap();
            assert!(started.elapsed() < Duration::from_secs(10));
            assert!(err.contains("2 秒たっても準備できませんでした"), "{err}");
            assert!(err.ends_with("waiting"), "{err}");
            // The `sleep` is a child of the script, in its group: it is ended with it.
            assert!(gone(read_pid(&pid_file).await).await);
            assert_eq!(dir.leftovers(), 0);
        }

        #[tokio::test]
        async fn tells_that_it_ended_after_it_was_ready() {
            let dir = Dir::new("after");
            let port = free_port();
            let up = dir.file("up");
            let _listener = listen_after(port, up.clone());
            let script = start(
                &dir.0,
                HOST,
                port,
                &format!("touch '{}'\nsleep 1\necho oops >&2\nexit 3", up.display()),
                quick(10_000),
                None,
            )
            .await
            .unwrap();
            assert_eq!(script.exited(), None);
            let mut told = None;
            for _ in 0..100 {
                told = script.exited();
                if told.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert_eq!(
                told.as_deref(),
                Some("接続のスクリプトが終了したため、接続を閉じました（終了コード 3）。標準エラーの最後の行: oops")
            );
            script.stop().await;
        }

        #[tokio::test]
        async fn sigkills_a_group_that_ignores_sigterm_after_the_grace() {
            let dir = Dir::new("stubborn");
            let port = free_port();
            let pid_file = dir.file("pid");
            let _listener = listen_after(port, pid_file.clone());
            let body = format!(
                "trap '' TERM\necho $$ > '{}'\nwhile true; do sleep 0.1; done",
                pid_file.display()
            );
            let script = start(&dir.0, HOST, port, &body, quick(10_000), None)
                .await
                .unwrap();
            let pid = read_pid(&pid_file).await;
            assert!(alive(pid));
            let started = Instant::now();
            script.stop().await;
            assert!(started.elapsed() < Duration::from_secs(10));
            assert!(gone(pid).await);
            assert_eq!(dir.leftovers(), 0);
        }

        #[test]
        fn a_script_dropped_after_its_runtime_ended_takes_its_children_with_it() {
            let dir = Dir::new("drop");
            let port = free_port();
            let pid_file = dir.file("pid");
            let _listener = listen_after(port, pid_file.clone());
            let body = format!("sleep 300 &\necho $! > '{}'\nwait", pid_file.display());
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let script = runtime
                .block_on(start(&dir.0, HOST, port, &body, quick(10_000), None))
                .unwrap();
            let child = runtime.block_on(read_pid(&pid_file));
            assert!(alive(child));
            // The runtime ends with the task that would end the group: only the first process dies with it (`kill_on_drop`).
            drop(runtime);
            assert!(alive(child), "the child of the script outlives the runtime");
            drop(script);
            let ended = (0..100).any(|_| {
                std::thread::sleep(Duration::from_millis(50));
                !alive(child)
            });
            assert!(ended, "the Drop of the script kills its group");
        }

        #[tokio::test]
        async fn ends_a_script_with_sigterm_at_once() {
            let dir = Dir::new("term");
            let port = free_port();
            let up = dir.file("up");
            let _listener = listen_after(port, up.clone());
            let timing = Timing {
                ready: Duration::from_secs(10),
                grace: Duration::from_secs(3),
            };
            let body = format!("touch '{}'\nsleep 30", up.display());
            let script = start(&dir.0, HOST, port, &body, timing, None)
                .await
                .unwrap();
            let started = Instant::now();
            script.stop().await;
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "SIGTERM is enough, no wait for the grace"
            );
        }

        #[tokio::test]
        async fn a_port_that_answers_before_the_script_is_run_is_an_error_and_runs_nothing() {
            let dir = Dir::new("in-use");
            let listener = std::net::TcpListener::bind((HOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let ran = dir.file("ran");
            let body = format!("echo run > '{}'\nsleep 30", ran.display());
            let err = start(&dir.0, HOST, port, &body, quick(10_000), None)
                .await
                .err()
                .unwrap();
            assert_eq!(err, in_use_text(HOST, port));
            assert_eq!(dir.leftovers(), 0, "no file of the script is made");
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!ran.exists(), "the script is not run");
            // The same port, once it is free, is taken by the script.
            // A script that another test forks at the moment of the drop holds the listener's file until its `exec`: the port is free when nothing answers.
            drop(listener);
            let addr = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
            for _ in 0..500 {
                if std::net::TcpStream::connect(addr).is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let _listener = listen_after(port, ran);
            let script = start(&dir.0, HOST, port, &body, quick(10_000), None)
                .await
                .unwrap();
            script.stop().await;
        }

        #[tokio::test]
        async fn a_name_that_cannot_be_looked_up_still_runs_the_script_and_waits_for_it() {
            let dir = Dir::new("unresolved");
            let host = "no-such-host.invalid";
            assert!(resolve(host, 3307).await.is_empty());
            let ran = dir.file("ran");
            let body = format!("echo run > '{}'\necho waiting >&2\nsleep 30", ran.display());
            let err = start(&dir.0, host, free_port(), &body, quick(1_500), None)
                .await
                .err()
                .unwrap();
            assert!(err.contains("準備できませんでした"), "{err}");
            assert!(err.ends_with("waiting"), "{err}");
            assert!(ran.exists(), "the script is run");
            assert_eq!(dir.leftovers(), 0);
        }

        #[tokio::test]
        async fn scripts_open_with_the_host_and_the_port_of_the_connection_and_close_by_id() {
            let dir = Dir::new("open");
            let port = free_port();
            let up = dir.file("up");
            let _listener = listen_after(port, up.clone());
            let scripts = Scripts::default();
            let body = format!("touch '{}'\nsleep 30", up.display());
            let id = scripts.open(HOST, port, &body, None).await.unwrap();
            assert_eq!(scripts.exited(id).await, None);
            scripts.close(id).await;
            assert!(scripts.open.lock().await.is_empty());
        }

        #[tokio::test]
        async fn scripts_open_close_and_tell_the_end_by_id() {
            let dir = Dir::new("scripts");
            let port = free_port();
            let up = dir.file("up");
            let _listener = listen_after(port, up.clone());
            let scripts = Scripts::default();
            let body = format!("touch '{}'\nsleep 30", up.display());
            let script = start(&dir.0, HOST, port, &body, quick(10_000), None)
                .await
                .unwrap();
            scripts.open.lock().await.insert(5, script);
            assert_eq!(scripts.exited(5).await, None);
            scripts.close(5).await;
            assert_eq!(scripts.exited(5).await, None);
            assert!(scripts.open.lock().await.is_empty());
            assert_eq!(dir.leftovers(), 0);
        }
    }
}
