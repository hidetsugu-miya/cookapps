//! A-34: the language server processes that stay, one for each worktree (the place of its project and its path) and language, their state, and the questions to them.
//!
//! A server is the one of a language of its repository (`lsp::LspServerSettings`), and every command is given that language as the server's key. A server is started by `lsp_start` (or replaced by `lsp_restart`) and stays until `lsp_stop`, the death of its process, or the end of the app (`LspServers::close_all`, from `lib.rs`). One task owns it: it reads how to start it (`lsp::plan_for`), starts the process (`/bin/sh -c`, a `docker compose exec -T` in it, or the `ssh` in front: `spawn_of`), talks LSP over its standard input and output (`session`), and ends when the process does. Whether the screen still needs a server is the screen's to decide: it calls `lsp_stop`.
//! The state is `indexing` from the start to the end of the progress the server shows (`protocol::Progress`), `running` after it, and `stopped` with a reason when the process is gone. A service of compose whose container does not run is told as `containerDown`, so that the screen can offer to start it; starting the container is not done here. Each change of the state is told by the event `lsp-status` (`LspStatusEvent`, with the server's name), and `lsp_status` answers the state as it is.
//! A server is stopped by `shutdown` and `exit`, and then by closing its standard input, which ends the server, through `docker compose exec` and `ssh` as well; a process that is still there after a moment is killed.
//! What a file holds is not kept: `lsp_definition` is given the text of the editor and sends it as the whole text of the file (`didOpen` the first time, `didChange` when it is not the text last sent, found by a hash), and only that hash is kept. The paths that the server answered outside the worktree (a gem) are remembered for each server (`LspServers::outside_way`): they are the only ones that are read from outside the worktree, and the way the server was started (`Way`) is the way they are read. Before each question the app tells the server which files of its languages changed on the disk (`LspServers::refresh`, `watch`), and a file is closed again once its question is answered (but for the one file that the question of the underline keeps open, until another file is asked about by it or the files change on the disk).

use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    future::Future,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{sleep_until, timeout, Instant},
};
#[cfg(test)]
use ts_rs::TS;

use super::{
    check_language, check_worktree, languages_taken, plan_for,
    protocol::{
        answer_request, classify, encode, error_response, initialize_params, locations,
        notification, read_frame, request, response, server_path, uri_of, Frame, Incoming,
        LspLocation, Progress,
    },
    run_on, spawn_of, watch, LspMethod, Planned, Route, Spawn,
};
use crate::{
    auth::config_dir,
    orca_files::check_worktree_of_project,
    orca_language,
    ssh::{failure, shared_control, Ran},
};

/// The event that tells the screen each change of a state (`LspStatusEvent`).
const EVENT: &str = "lsp-status";
/// How long `lsp_definition` waits for the answer of the server.
const DEFINITION_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a stop waits for the task of a server before it ends it.
const STOP_WAIT: Duration = Duration::from_secs(6);
/// The most bytes of the standard error of the process that are kept (the end of it).
const STDERR_KEEP: usize = 16 * 1024;
/// The most questions that wait for an answer at once.
const MAX_PENDING: usize = 32;
/// The longest text of a file that is sent.
const MAX_DOC: usize = 1024 * 1024;
/// How long the look at the files of the disk before a question is waited for.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(5);
/// The most paths outside the worktree that are remembered for a server.
const MAX_OUTSIDE: usize = 10_000;

const NOT_STARTED: &str = "言語サーバーが起動していません";
const STOPPED: &str = "言語サーバーが止まっています";
const NOT_READY: &str = "言語サーバーの準備がまだできていません";
const BUSY: &str = "言語サーバーへの問い合わせが多すぎます";
const TIMED_OUT: &str = "言語サーバーが時間内に答えませんでした";
const TOO_LARGE: &str = "ファイルが大きすぎます";
// What is said of the server, without its name: `named` puts the name in front of them.
const NO_WAY: &str = "を起動する方法が見つかりません";
const NOT_RUN: &str = "を起動できません";
const EXITED: &str = "が終了しました";
const INIT_TIMEOUT: &str = "が時間内に起動しませんでした";
const INIT_FAILED: &str = "の初期化に失敗しました";
const WRITE_FAILED: &str = "に送れません";
const WRITE_TIMEOUT: &str = "が時間内に受け取りませんでした";
const CONTAINER_DOWN: &str = "サービスのコンテナが動いていません";

// ---- what the screen gets ----

/// Where a server is: `Indexing` from its start to the end of its progress, `Running` after it, `Stopped` when it is gone.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum LspState {
    Indexing,
    Running,
    Stopped,
}

/// Why a server is stopped: `NotStarted` (none was started, or it was stopped by `lsp_stop`), `ContainerDown` (the container of the service does not run), `Failed` (it could not be started, or it ended; the `message` says how).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum LspStopReason {
    NotStarted,
    ContainerDown,
    Failed,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    pub state: LspState,
    /// Only when `state` is `stopped`.
    #[cfg_attr(test, ts(optional = nullable))]
    pub reason: Option<LspStopReason>,
    /// A line of Japanese for the screen, when the reason is `failed` or `containerDown`.
    #[cfg_attr(test, ts(optional = nullable))]
    pub message: Option<String>,
}

impl LspStatus {
    fn indexing() -> Self {
        Self {
            state: LspState::Indexing,
            reason: None,
            message: None,
        }
    }

    fn running() -> Self {
        Self {
            state: LspState::Running,
            ..Self::indexing()
        }
    }

    fn stopped(reason: LspStopReason, message: Option<String>) -> Self {
        Self {
            state: LspState::Stopped,
            reason: Some(reason),
            message,
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self::stopped(LspStopReason::Failed, Some(message.into()))
    }
}

/// What is said of the server `name`: its name, then `what` (one of the texts above, which goes on from the name).
fn named(name: &str, what: &str) -> String {
    format!("{name} {what}")
}

/// A change of the state of the server `server` of a worktree: the event `lsp-status`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspStatusEvent {
    #[cfg_attr(test, ts(optional = nullable))]
    pub environment: Option<String>,
    pub worktree: String,
    pub server: String,
    pub status: LspStatus,
}

// ---- the state from the end of a process ----

/// Whether the standard error of `docker compose exec` says that the container of the service does not run (`service "app" is not running` of compose v2, `No container found` of the older ones, and the daemon's `... is not running`). Only its last line is read: that is where `docker compose exec` says it, and a server that ended for another reason may have said it earlier.
pub(crate) fn container_down(stderr: &str) -> bool {
    let last = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .to_lowercase();
    last.contains("is not running") || last.contains("no container found")
}

/// The state of a server whose process ended (or never ran): `reason` is what ended it, `code` the exit code of the process and `stderr` what it printed on its standard error.
fn stopped_status(reason: &str, code: Option<i32>, stderr: &str) -> LspStatus {
    if container_down(stderr) {
        return LspStatus::stopped(LspStopReason::ContainerDown, Some(CONTAINER_DOWN.into()));
    }
    let ran = Ran {
        code,
        stdout: Vec::new(),
        stderr: stderr.to_owned(),
    };
    LspStatus::failed(failure(&ran, reason))
}

/// Adds `chunk` to the end of `kept`, and cuts the front off so that at most `cap` bytes are held.
fn push_tail(kept: &mut Vec<u8>, chunk: &[u8], cap: usize) {
    kept.extend_from_slice(chunk);
    if kept.len() > cap {
        kept.drain(..kept.len() - cap);
    }
}

fn status_of(progress: &Progress, initialized: bool) -> LspStatus {
    if initialized && !progress.is_indexing() {
        LspStatus::running()
    } else {
        LspStatus::indexing()
    }
}

// ---- the talk with one server ----

/// The times a server is given. Every wait of a session is one of these, so that a server that says nothing ends it.
pub(crate) struct Timing {
    /// From the start to the answer to `initialize`: ruby-lsp may set up its own bundle at its first start.
    init: Duration,
    /// How long after `initialized` a server that has shown no progress is waited for.
    grace: Duration,
    /// The answer to `shutdown`.
    shutdown: Duration,
    /// One write to the server.
    write: Duration,
    /// How long a process that has lost its standard input is given to end.
    child: Duration,
    /// How long the standard error is read after the process has ended.
    stderr: Duration,
}

impl Timing {
    const DEFAULT: Self = Self {
        init: Duration::from_secs(180),
        grace: Duration::from_secs(3),
        shutdown: Duration::from_secs(2),
        write: Duration::from_secs(10),
        child: Duration::from_secs(2),
        stderr: Duration::from_millis(300),
    };
}

/// What a question to the server can be.
pub(crate) enum Cmd {
    /// The definition at a position of the file `uri`, whose language is `language` and whole text is `text`. The answer is the `result` of the server, as it came.
    Definition {
        uri: String,
        language: String,
        text: String,
        line: u32,
        character: u32,
        /// Whether the file stays open once it is answered (the question of the underline, which comes again and again for the same file: `session` keeps one such file open).
        keep: bool,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    /// Files of the worktree that changed on the disk (`watch::message`): the notice `workspace/didChangeWatchedFiles`, as it is to be sent.
    Changed(Value),
    Stop,
}

/// How a session ended: on purpose (`Stop`, or the channel of the questions was dropped), or by the server (the reason).
#[derive(Debug, PartialEq)]
pub(crate) enum End {
    Closed,
    Died(String),
}

async fn send<W: AsyncWrite + Unpin>(
    writer: &mut W,
    message: &Value,
    limit: Duration,
) -> Result<(), String> {
    let bytes = encode(message);
    timeout(limit, async {
        writer.write_all(&bytes).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| WRITE_TIMEOUT)?
    .map_err(|_| WRITE_FAILED.to_owned())
}

/// The language id that LSP gives a file (`languageId` of `didOpen`), from the name of A-21 of its language and its path: the names are the same but for `shell` (`shellscript`) and the React files, which A-21 does not tell from plain TypeScript and JavaScript (`typescriptreact`, `javascriptreact`).
fn language_id(relative: &str, language: &str) -> String {
    let extension = relative
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, extension)| extension.to_lowercase());
    match (language, extension.as_deref()) {
        ("typescript", Some("tsx")) => "typescriptreact",
        ("javascript", Some("jsx")) => "javascriptreact",
        ("shell", _) => "shellscript",
        _ => language,
    }
    .to_owned()
}

fn text_hash(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Tells the server the text of the file `uri`, whose language is `language` (A-21): `didOpen` the first time, `didChange` with the whole text when it is not the text sent last, nothing when it is. Only the version and the hash of the text are kept.
async fn sync_document<W: AsyncWrite + Unpin>(
    writer: &mut W,
    docs: &mut HashMap<String, (i64, u64)>,
    uri: &str,
    language: &str,
    text: &str,
    limit: Duration,
) -> Result<(), String> {
    let hash = text_hash(text);
    let message = match docs.get(uri) {
        None => {
            docs.insert(uri.to_owned(), (1, hash));
            notification(
                "textDocument/didOpen",
                json!({"textDocument": {"uri": uri, "languageId": language, "version": 1, "text": text}}),
            )
        }
        Some(&(_, sent)) if sent == hash => return Ok(()),
        Some(&(version, _)) => {
            docs.insert(uri.to_owned(), (version + 1, hash));
            notification(
                "textDocument/didChange",
                json!({"textDocument": {"uri": uri, "version": version + 1}, "contentChanges": [{"text": text}]}),
            )
        }
    };
    send(writer, &message, limit).await
}

/// The questions that wait for an answer: the file each is about, and where the answer goes.
type Pending = HashMap<i64, (String, oneshot::Sender<Result<Value, String>>)>;

/// Tells the server that the editor no longer has the file `uri` open (`didClose`), unless it is open and a question about it is still waiting: the server answers from the text it was given, and an open file is not re-read from the disk when it changes there (`workspace/didChangeWatchedFiles`), so a file is kept open only while it is asked about.
async fn close_unused<W: AsyncWrite + Unpin>(
    writer: &mut W,
    docs: &mut HashMap<String, (i64, u64)>,
    pending: &Pending,
    uri: &str,
    limit: Duration,
) -> Result<(), String> {
    if pending.values().any(|(asked, _)| asked == uri) || docs.remove(uri).is_none() {
        return Ok(());
    }
    let message = notification(
        "textDocument/didClose",
        json!({"textDocument": {"uri": uri}}),
    );
    send(writer, &message, limit).await
}

/// `shutdown` and `exit`, each as far as the server takes them: a server that does not answer in time is left to the closing of its standard input.
async fn say_goodbye<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frames: &mut mpsc::Receiver<Result<Value, String>>,
    id: i64,
    timing: &Timing,
) {
    if send(writer, &request(id, "shutdown", Value::Null), timing.write)
        .await
        .is_err()
    {
        return;
    }
    let _ = timeout(timing.shutdown, async {
        while let Some(Ok(message)) = frames.recv().await {
            if matches!(classify(&message), Incoming::Response { id: got, .. } if got == id) {
                break;
            }
        }
    })
    .await;
    let _ = send(writer, &notification("exit", Value::Null), timing.write).await;
}

/// The talk with one server over `reader` and `writer` (its standard output and input): `initialize`, `initialized`, the progress it shows, the answers to its requests, the questions of `rx`, and at the end `shutdown` and `exit`. `publish` is called with each state that follows from it. A frame that cannot be read, an end of the stream, a write that does not go through and a server that does not answer `initialize` in time end the session as `Died`; the writer is dropped when the function returns, which closes the standard input of the process.
pub(crate) async fn session<R, W, P>(
    reader: R,
    mut writer: W,
    root_uri: &str,
    timing: &Timing,
    rx: &mut mpsc::UnboundedReceiver<Cmd>,
    publish: &P,
) -> End
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin,
    P: Fn(LspStatus) + Sync,
{
    let (frames_tx, mut frames) = mpsc::channel::<Result<Value, String>>(64);
    // It ends at the end of the stream, at an error, or when nobody reads what it sends; below it is ended in any case.
    let reader_task = tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        loop {
            match read_frame(&mut reader).await {
                Ok(Some(Frame::Message(message))) => {
                    if frames_tx.send(Ok(message)).await.is_err() {
                        break;
                    }
                }
                Ok(Some(Frame::Unreadable)) => {}
                Ok(None) => break,
                Err(e) => {
                    let _ = frames_tx.send(Err(e)).await;
                    break;
                }
            }
        }
    });
    let end = drive(&mut writer, &mut frames, root_uri, timing, rx, publish).await;
    reader_task.abort();
    end
}

async fn drive<W, P>(
    writer: &mut W,
    frames: &mut mpsc::Receiver<Result<Value, String>>,
    root_uri: &str,
    timing: &Timing,
    rx: &mut mpsc::UnboundedReceiver<Cmd>,
    publish: &P,
) -> End
where
    W: AsyncWrite + Unpin,
    P: Fn(LspStatus) + Sync,
{
    let deadline = Instant::now() + timing.init;
    let mut next_id: i64 = 1;
    let init_id = next_id;
    let init = request(init_id, "initialize", initialize_params(root_uri));
    if let Err(e) = send(writer, &init, timing.write).await {
        return End::Died(e);
    }
    let mut initialized = false;
    let mut grace_at: Option<Instant> = None;
    let mut progress = Progress::default();
    let mut pending: Pending = HashMap::new();
    let mut docs: HashMap<String, (i64, u64)> = HashMap::new();
    // The one file that a question of the underline keeps open, so that the same text is not sent again at the next one.
    let mut kept: Option<String> = None;
    loop {
        tokio::select! {
            frame = frames.recv() => {
                let message = match frame {
                    Some(Ok(message)) => message,
                    Some(Err(e)) => return End::Died(e),
                    None => return End::Died(EXITED.into()),
                };
                match classify(&message) {
                    Incoming::Response { id, result } if id == init_id && !initialized => {
                        if let Err(e) = result {
                            return End::Died(format!("{INIT_FAILED}: {e}"));
                        }
                        if let Err(e) = send(writer, &notification("initialized", json!({})), timing.write).await {
                            return End::Died(e);
                        }
                        initialized = true;
                        grace_at = Some(Instant::now() + timing.grace);
                        publish(status_of(&progress, true));
                    }
                    Incoming::Response { id, result } => {
                        if let Some((uri, reply)) = pending.remove(&id) {
                            let _ = reply.send(result);
                            if kept.as_deref() != Some(uri.as_str()) {
                                if let Err(e) = close_unused(writer, &mut docs, &pending, &uri, timing.write).await {
                                    return End::Died(e);
                                }
                            }
                        }
                    }
                    Incoming::Request { id, method } => {
                        let answer = match answer_request(&method) {
                            Ok(result) => response(&id, result),
                            Err((code, text)) => error_response(&id, code, text),
                        };
                        if let Err(e) = send(writer, &answer, timing.write).await {
                            return End::Died(e);
                        }
                    }
                    Incoming::Notification { method, params } => {
                        if method == "$/progress" {
                            progress.apply(&params);
                            if initialized {
                                publish(status_of(&progress, true));
                            }
                        }
                    }
                    Incoming::Other => {}
                }
            }
            command = rx.recv() => match command {
                None | Some(Cmd::Stop) => {
                    if initialized {
                        next_id += 1;
                        say_goodbye(writer, frames, next_id, timing).await;
                    }
                    return End::Closed;
                }
                Some(Cmd::Changed(message)) => {
                    if initialized {
                        // A file that stayed open is not read again from the disk by the server: it is opened again by the next question, with the text of the editor.
                        if let Some(old) = kept.take() {
                            if let Err(e) = close_unused(writer, &mut docs, &pending, &old, timing.write).await {
                                return End::Died(e);
                            }
                        }
                        if let Err(e) = send(writer, &message, timing.write).await {
                            return End::Died(e);
                        }
                    }
                }
                Some(Cmd::Definition { uri, language, text, line, character, keep, reply }) => {
                    if !initialized {
                        let _ = reply.send(Err(NOT_READY.into()));
                        continue;
                    }
                    // A question that nobody waits for any more is dropped, and its file is closed when no other question needs it.
                    let abandoned: Vec<String> = pending
                        .values()
                        .filter(|(_, reply)| reply.is_closed())
                        .map(|(asked, _)| asked.clone())
                        .collect();
                    pending.retain(|_, (_, reply)| !reply.is_closed());
                    for asked in abandoned.into_iter().filter(|asked| kept.as_deref() != Some(asked.as_str())) {
                        if let Err(e) = close_unused(writer, &mut docs, &pending, &asked, timing.write).await {
                            return End::Died(e);
                        }
                    }
                    if pending.len() >= MAX_PENDING {
                        let _ = reply.send(Err(BUSY.into()));
                        continue;
                    }
                    if keep {
                        if let Some(old) = kept.take().filter(|old| *old != uri) {
                            if let Err(e) = close_unused(writer, &mut docs, &pending, &old, timing.write).await {
                                return End::Died(e);
                            }
                        }
                        kept = Some(uri.clone());
                    } else if kept.as_deref() == Some(uri.as_str()) {
                        kept = None;
                    }
                    if let Err(e) = sync_document(writer, &mut docs, &uri, &language, &text, timing.write).await {
                        return End::Died(e);
                    }
                    next_id += 1;
                    let params = json!({"textDocument": {"uri": uri}, "position": {"line": line, "character": character}});
                    if let Err(e) = send(writer, &request(next_id, "textDocument/definition", params), timing.write).await {
                        return End::Died(e);
                    }
                    pending.insert(next_id, (uri, reply));
                }
            },
            () = sleep_until(grace_at.unwrap_or(deadline)), if grace_at.is_some() => {
                grace_at = None;
                progress.grace_over();
                publish(status_of(&progress, initialized));
            }
            () = sleep_until(deadline), if !initialized => return End::Died(INIT_TIMEOUT.into()),
        }
    }
}

// ---- the process ----

/// Reads the standard error of the process into `kept`, the end of it.
async fn collect_stderr(mut stderr: impl AsyncRead + Unpin, kept: Arc<Mutex<Vec<u8>>>) {
    let mut buffer = [0_u8; 1024];
    while let Ok(n @ 1..) = stderr.read(&mut buffer).await {
        push_tail(
            &mut kept.lock().unwrap_or_else(|e| e.into_inner()),
            &buffer[..n],
            STDERR_KEEP,
        );
    }
}

/// Starts the process `spawn`, talks to it (`session`) and, when it ended, tells how: the process is waited for (a moment, then killed), and a session that the server ended gives the state from the exit code and the standard error. `mount` is the path the worktree has where the server runs.
async fn run_spawn(ctx: &mut Ctx, spawn: &Spawn, mount: &str, timing: &Timing) {
    let mut command = Command::new(&spawn.program);
    command
        .args(&spawn.args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let name = ctx.publisher.key.server.clone();
    let Ok(mut child) = command.spawn() else {
        ctx.publisher.set(LspStatus::failed(named(&name, NOT_RUN)));
        return;
    };
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill().await;
        ctx.publisher.set(LspStatus::failed(named(&name, NOT_RUN)));
        return;
    };
    let kept = Arc::new(Mutex::new(Vec::new()));
    let mut errors = tokio::spawn(collect_stderr(stderr, kept.clone()));
    let publisher = ctx.publisher.clone();
    // The first state the session tells is the one at `initialized`: the files on the disk are looked at then, once, so that what is gone or renamed by the first question is told then (`look`).
    let first = AtomicBool::new(true);
    let (watch, way) = (ctx.watch.clone(), ctx.way.clone());
    let end = session(
        stdout,
        stdin,
        &uri_of(mount),
        timing,
        &mut ctx.rx,
        &|status| {
            if first.swap(false, Ordering::SeqCst) {
                let (watch, way) = (watch.clone(), way.clone());
                let worktree = publisher.key.worktree.clone();
                tokio::spawn(async move {
                    let way = way.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if let Some(way) = way {
                        look(&watch, &way, &worktree, run_on).await;
                    }
                });
            }
            publisher.set(status);
        },
    )
    .await;
    let code = match timeout(timing.child, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        _ => {
            let _ = child.kill().await;
            None
        }
    };
    // The standard error may stay open after the process (a shared ssh connection holds it).
    if timeout(timing.stderr, &mut errors).await.is_err() {
        errors.abort();
    }
    if let End::Died(reason) = end {
        let stderr =
            String::from_utf8_lossy(&kept.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
        ctx.publisher
            .set(stopped_status(&named(&name, &reason), code, &stderr));
    }
}

/// How a server was started, as it was decided when it started: where its worktree is, the path the worktree has where it runs, the method and the service, and the extensions of the files of its languages (`orca_language::extensions_of`). What it needs later (reading a file of its side, looking at the disk) goes by this and not by what the worktree or the settings say then, which may have changed.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Way {
    pub mount: String,
    pub route: Route,
    pub method: LspMethod,
    pub service: Option<String>,
    pub extensions: Vec<String>,
}

/// The extensions of the files of `languages`, each once.
fn extensions_of(languages: &[String]) -> Vec<String> {
    let mut found: Vec<String> = languages
        .iter()
        .flat_map(|language| orca_language::extensions_of(language))
        .collect();
    found.sort();
    found.dedup();
    found
}

/// How the server `server` of a worktree is started, read from the worktree: the process, and how it was decided. Blocking (it runs the commands of `lsp::plan_for`).
fn plan(
    dir: &Path,
    environment: Option<&str>,
    project: &str,
    worktree: &str,
    server: &str,
) -> Result<(Spawn, Way), String> {
    let Planned {
        route,
        launch,
        language,
    } = plan_for(dir, environment, project, worktree, server, run_on)?;
    let command = launch.command.ok_or_else(|| named(server, NO_WAY))?;
    let mount = launch.mount.unwrap_or_else(|| worktree.to_owned());
    let control = match route {
        Route::Local => None,
        Route::Ssh { .. } => shared_control(),
    };
    let spawn = spawn_of(&route, worktree, &command, control.as_deref());
    Ok((
        spawn,
        Way {
            mount,
            route,
            method: launch.method,
            service: launch.service,
            extensions: extensions_of(&languages_taken(&language)),
        },
    ))
}

/// The whole life of the server of a worktree: how it is started, the process, the talk and the end.
async fn run_server(mut ctx: Ctx, dir: PathBuf, key: Key, project: String) {
    let planned = tokio::task::spawn_blocking(move || {
        plan(
            &dir,
            key.environment.as_deref(),
            &project,
            &key.worktree,
            &key.server,
        )
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|planned| planned);
    match planned {
        Ok((spawn, way)) => {
            let mount = way.mount.clone();
            *ctx.way.lock().unwrap_or_else(|e| e.into_inner()) = Some(way);
            run_spawn(&mut ctx, &spawn, &mount, &Timing::DEFAULT).await;
        }
        Err(message) => ctx.publisher.set(LspStatus::failed(message)),
    }
}

// ---- the servers ----

/// A server is known by the place of its project (`None`: this machine, else the name of the saved environment), its worktree and its language (the language of its entry in the settings of its repository).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    environment: Option<String>,
    worktree: String,
    server: String,
}

type Emit = Arc<dyn Fn(LspStatusEvent) + Send + Sync>;

/// Writes the state of one server and tells it, when it changed.
#[derive(Clone)]
pub(crate) struct Publisher {
    key: Key,
    status: Arc<Mutex<LspStatus>>,
    emit: Emit,
}

impl Publisher {
    fn set(&self, status: LspStatus) {
        {
            let mut current = self.status.lock().unwrap_or_else(|e| e.into_inner());
            if *current == status {
                return;
            }
            *current = status.clone();
        }
        (self.emit)(LspStatusEvent {
            environment: self.key.environment.clone(),
            worktree: self.key.worktree.clone(),
            server: self.key.server.clone(),
            status,
        });
    }
}

/// What the task of a server is given.
pub(crate) struct Ctx {
    rx: mpsc::UnboundedReceiver<Cmd>,
    publisher: Publisher,
    /// How the server is started, set by the task once it is known.
    way: Arc<Mutex<Option<Way>>>,
    /// What the app knows of the files of the worktree on the disk; the task takes the first look at `initialized`.
    watch: Arc<tokio::sync::Mutex<Watch>>,
}

/// What the app knows of the files of the worktree on the disk: when it last looked, and the `*.rb` files it saw then (`None` before the first look).
struct Watch {
    at: Instant,
    known: Option<HashSet<String>>,
}

struct Server {
    status: Arc<Mutex<LspStatus>>,
    way: Arc<Mutex<Option<Way>>>,
    commands: mpsc::UnboundedSender<Cmd>,
    task: Mutex<Option<JoinHandle<()>>>,
    /// The paths outside the worktree that the server answered as a definition.
    outside: Mutex<HashSet<String>>,
    watch: Arc<tokio::sync::Mutex<Watch>>,
}

impl Server {
    fn status(&self) -> LspStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// How the server was started; none until the task has read it.
    fn way(&self) -> Option<Way> {
        self.way.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Asks the task to stop, and waits for it for a while; a task that is still there is ended (its process is killed with it).
    async fn finish(&self) {
        let _ = self.commands.send(Cmd::Stop);
        let task = self.task.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(mut task) = task {
            if timeout(STOP_WAIT, &mut task).await.is_err() {
                task.abort();
            }
        }
    }
}

/// The servers of the app, one for each worktree and language (managed state).
#[derive(Default)]
pub struct LspServers {
    inner: tokio::sync::Mutex<HashMap<Key, Arc<Server>>>,
}

impl LspServers {
    /// Starts the server of `key` with `run`, which is given what the task needs. A server that is there and not stopped is left as it is; one that is stopped is replaced. Answers the state.
    pub(crate) async fn start_with<F, Fut>(&self, key: Key, emit: Emit, run: F) -> LspStatus
    where
        F: FnOnce(Ctx) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.start_carrying(key, emit, run, HashSet::new()).await
    }

    /// Stops the server of `key` if there is one, and starts it again with `run` (the restart of the screen). The places outside the worktree that the one it replaces gave stay known to the new one, because the list of definitions that shows them is still on the screen. Answers the state.
    pub(crate) async fn restart_with<F, Fut>(&self, key: Key, emit: Emit, run: F) -> LspStatus
    where
        F: FnOnce(Ctx) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let old = self.inner.lock().await.remove(&key);
        let mut outside = HashSet::new();
        if let Some(old) = old {
            old.finish().await;
            outside = std::mem::take(&mut *old.outside.lock().unwrap_or_else(|e| e.into_inner()));
        }
        self.start_carrying(key, emit, run, outside).await
    }

    /// `start_with`, where `outside` are the places outside the worktree that the server to be started knows from the start.
    async fn start_carrying<F, Fut>(
        &self,
        key: Key,
        emit: Emit,
        run: F,
        mut outside: HashSet<String>,
    ) -> LspStatus
    where
        F: FnOnce(Ctx) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let mut servers = self.inner.lock().await;
        if let Some(server) = servers.get(&key) {
            let status = server.status();
            if status.state != LspState::Stopped {
                let mut known = server.outside.lock().unwrap_or_else(|e| e.into_inner());
                let room = MAX_OUTSIDE.saturating_sub(known.len());
                known.extend(outside.into_iter().take(room));
                return status;
            }
        }
        // The places that the server of a definition gave stay known to the one that replaces it: the list that shows them is still on the screen.
        if let Some(old) = servers.remove(&key) {
            if let Some(task) = old.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
                task.abort();
            }
            outside.extend(std::mem::take(
                &mut *old.outside.lock().unwrap_or_else(|e| e.into_inner()),
            ));
        }
        let (commands, rx) = mpsc::unbounded_channel();
        let status = Arc::new(Mutex::new(LspStatus::indexing()));
        let way = Arc::new(Mutex::new(None));
        let watch = Arc::new(tokio::sync::Mutex::new(Watch {
            at: Instant::now(),
            known: None,
        }));
        let publisher = Publisher {
            key: key.clone(),
            status: status.clone(),
            emit,
        };
        let task = tokio::spawn(run(Ctx {
            rx,
            publisher,
            way: way.clone(),
            watch: watch.clone(),
        }));
        servers.insert(
            key,
            Arc::new(Server {
                status,
                way,
                commands,
                task: Mutex::new(Some(task)),
                outside: Mutex::new(outside),
                watch,
            }),
        );
        LspStatus::indexing()
    }

    async fn get(&self, key: &Key) -> Option<Arc<Server>> {
        self.inner.lock().await.get(key).cloned()
    }

    /// The state of the server of `key`; one that is not there is stopped, `NotStarted`.
    pub(crate) async fn status(&self, key: &Key) -> LspStatus {
        match self.get(key).await {
            Some(server) => server.status(),
            None => LspStatus::stopped(LspStopReason::NotStarted, None),
        }
    }

    /// Stops the server of `key` and takes it away.
    pub(crate) async fn stop(&self, key: &Key) {
        let server = self.inner.lock().await.remove(key);
        if let Some(server) = server {
            server.finish().await;
        }
    }

    /// Stops every server, all at once, so that the end of the app waits for the slowest and not for the sum.
    pub async fn close_all(&self) {
        let servers: Vec<Arc<Server>> = self.inner.lock().await.drain().map(|(_, s)| s).collect();
        futures_util::future::join_all(servers.iter().map(|server| server.finish())).await;
    }

    /// The places that the server of `key` gives as the definition of the name at a position of the file `relative` of the worktree, whose text is `text` (the whole of it, as the editor holds it now). The paths of the places are from the worktree, or, when `outside`, the server's (and remembered, for `outside_way`).
    pub(crate) async fn definition(
        &self,
        key: &Key,
        relative: &str,
        text: String,
        line: u32,
        character: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let (server, found) = self
            .locate(key, false, relative, text, line, character)
            .await?;
        let mut outside = server.outside.lock().unwrap_or_else(|e| e.into_inner());
        for place in found.iter().filter(|place| place.outside) {
            if outside.len() < MAX_OUTSIDE {
                outside.insert(place.path.clone());
            }
        }
        Ok(found)
    }

    /// Whether the server of `key` has a definition for the name at the position (the question of `definition`, which keeps no place outside the worktree: nothing is shown). Only a server that is `running` is asked; one that is indexing is `NOT_READY`, and one that is stopped or not there is refused, so that nothing is asked of a server that cannot answer yet and nothing is started (A-34).
    pub(crate) async fn definition_exists(
        &self,
        key: &Key,
        relative: &str,
        text: String,
        line: u32,
        character: u32,
    ) -> Result<bool, String> {
        let (_, found) = self
            .locate(key, true, relative, text, line, character)
            .await?;
        Ok(!found.is_empty())
    }

    /// The server of `key` and the places it gives for the question of `definition`; with `running_only` a server that is not `running` is refused.
    async fn locate(
        &self,
        key: &Key,
        running_only: bool,
        relative: &str,
        text: String,
        line: u32,
        character: u32,
    ) -> Result<(Arc<Server>, Vec<LspLocation>), String> {
        let server = self.get(key).await.ok_or(NOT_STARTED)?;
        match server.status().state {
            LspState::Stopped => return Err(STOPPED.into()),
            LspState::Indexing if running_only => return Err(NOT_READY.into()),
            _ => {}
        }
        let mount = server.way().ok_or(NOT_READY)?.mount;
        if text.len() > MAX_DOC {
            return Err(TOO_LARGE.into());
        }
        let uri = uri_of(&server_path(&mount, relative)?);
        let language = language_id(relative, orca_language::detect_language(relative, &text));
        let (reply, answer) = oneshot::channel();
        server
            .commands
            .send(Cmd::Definition {
                uri,
                language,
                text,
                line,
                character,
                keep: running_only,
                reply,
            })
            .map_err(|_| STOPPED)?;
        let result = match timeout(DEFINITION_TIMEOUT, answer).await {
            Err(_) => return Err(TIMED_OUT.into()),
            Ok(Err(_)) => return Err(STOPPED.into()),
            Ok(Ok(result)) => result,
        };
        let found = locations(&result?, &mount);
        Ok((server, found))
    }

    /// How the server `server` of the worktree was started, when it gave `path` as a definition outside the worktree: only such a path may be read from the server's side, and it is read the way the server was started (`Way`), not the way the worktree says now.
    pub(crate) async fn outside_way(
        &self,
        environment: Option<&str>,
        worktree: &str,
        server: &str,
        path: &str,
    ) -> Option<Way> {
        let server = self.get(&key_of(environment, worktree, server)).await?;
        let known = server
            .outside
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(path);
        known.then(|| server.way()).flatten()
    }

    /// Tells the server of `key` which files of its languages in the worktree changed on the disk since the last look (`look`): `run` runs the listing in the worktree by the route of the server. A look that fails is left out and tried again at the next question, and the question goes on without it.
    pub(crate) async fn refresh<F>(&self, key: &Key, run: F)
    where
        F: FnOnce(&Route, &str, &str, usize) -> Result<Ran, String> + Send + 'static,
    {
        let Some(server) = self.get(key).await else {
            return;
        };
        let Some(way) = server.way() else {
            return;
        };
        let changes = look(&server.watch, &way, &key.worktree, run).await;
        if let Some(message) = watch::message(&way.mount, &changes) {
            let _ = server.commands.send(Cmd::Changed(message));
        }
    }
}

/// One look at the `*.rb` files of the worktree on the disk (`state`: what was seen at the last one): one run of `run`, within `REFRESH_TIMEOUT`, and the changes since then. A run that fails, is cut or is late, or a script that did not run (`cd` or ssh failed), tells nothing, and the time and the known files stay. Otherwise the time of the look is kept, and the known files too when the full list ended well (`--end`): a `find` that met a folder it cannot read has an exit code of 1, and the files it listed are still the answer.
async fn look<F>(
    state: &tokio::sync::Mutex<Watch>,
    way: &Way,
    worktree: &str,
    run: F,
) -> Vec<watch::Change>
where
    F: FnOnce(&Route, &str, &str, usize) -> Result<Ran, String> + Send + 'static,
{
    let mut state = state.lock().await;
    let looked_at = Instant::now();
    let Some(command) = watch::command(
        watch::minutes_since(looked_at.duration_since(state.at)),
        &way.extensions,
    ) else {
        return Vec::new();
    };
    let (route, worktree) = (way.route.clone(), worktree.to_owned());
    let ran = timeout(
        REFRESH_TIMEOUT,
        tokio::task::spawn_blocking(move || run(&route, &worktree, &command, watch::LIMIT)),
    )
    .await;
    let Ok(Ok(Ok(ran))) = ran else {
        return Vec::new();
    };
    let output = String::from_utf8_lossy(&ran.stdout);
    if !watch::started(&output) {
        return Vec::new();
    }
    let listing = watch::parse(&output);
    let changes = watch::changes(&listing, state.known.as_ref());
    state.at = looked_at;
    if let Some(all) = listing.all {
        state.known = Some(all.into_iter().collect());
    }
    changes
}

fn key_of(environment: Option<&str>, worktree: &str, server: &str) -> Key {
    Key {
        environment: environment.map(str::to_owned),
        worktree: worktree.to_owned(),
        server: server.to_owned(),
    }
}

fn emitter(app: AppHandle) -> Emit {
    Arc::new(move |event| {
        // A screen that is not listening loses nothing: `lsp_status` answers the state.
        let _ = app.emit(EVENT, event);
    })
}

// ---- the commands ----

/// Starts the server `server` for `worktree` of the project `project` of `environment` (`None`: this machine), and answers its state, `indexing`. A server that is there and not stopped is left as it is, a stopped one is started again. How it is started is read from the worktree by the task, and a failure of that, or of the process, is its state `stopped` with the message, told by the event `lsp-status` (A-34).
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    servers: State<'_, LspServers>,
    environment: Option<String>,
    project: String,
    worktree: String,
    server: String,
) -> Result<LspStatus, String> {
    check_language(&server)?;
    check_worktree(&worktree)?;
    check_worktree_of_project(&worktree, environment.as_deref(), &project).await?;
    let dir = config_dir(&app)?;
    let key = key_of(environment.as_deref(), &worktree, &server);
    let run_key = key.clone();
    Ok(servers
        .start_with(key, emitter(app), move |ctx| {
            run_server(ctx, dir, run_key, project)
        })
        .await)
}

/// Stops the server `server` of `worktree` and starts it again, as `lsp_start` does (the restart of the screen), and answers the state, `indexing`. The places outside the worktree that the stopped one gave stay known to the new one, which `lsp_stop` and `lsp_start` one after the other would lose (A-34).
#[tauri::command]
pub async fn lsp_restart(
    app: AppHandle,
    servers: State<'_, LspServers>,
    environment: Option<String>,
    project: String,
    worktree: String,
    server: String,
) -> Result<LspStatus, String> {
    check_language(&server)?;
    check_worktree(&worktree)?;
    check_worktree_of_project(&worktree, environment.as_deref(), &project).await?;
    let dir = config_dir(&app)?;
    let key = key_of(environment.as_deref(), &worktree, &server);
    let run_key = key.clone();
    Ok(servers
        .restart_with(key, emitter(app), move |ctx| {
            run_server(ctx, dir, run_key, project)
        })
        .await)
}

/// Stops the server `server` of `worktree`: `shutdown` and `exit`, then its standard input is closed, which ends the process. Nothing to stop is no error (A-34).
#[tauri::command]
pub async fn lsp_stop(
    servers: State<'_, LspServers>,
    environment: Option<String>,
    worktree: String,
    server: String,
) -> Result<(), String> {
    servers
        .stop(&key_of(environment.as_deref(), &worktree, &server))
        .await;
    Ok(())
}

/// The state of the server `server` of `worktree`, `stopped` with the reason `notStarted` when there is none (A-34).
#[tauri::command]
pub async fn lsp_status(
    servers: State<'_, LspServers>,
    environment: Option<String>,
    worktree: String,
    server: String,
) -> Result<LspStatus, String> {
    Ok(servers
        .status(&key_of(environment.as_deref(), &worktree, &server))
        .await)
}

/// The places of the definition of the name at `line` and `character` (UTF-16 units, as the index of a string of the editor) of the file `relative` of `worktree`, whose text now is `text`, asked of the server `server` (A-34). A place inside the worktree has its path from the worktree; one outside has the server's absolute path and `outside`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lsp_definition(
    servers: State<'_, LspServers>,
    environment: Option<String>,
    worktree: String,
    server: String,
    relative: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Vec<LspLocation>, String> {
    let key = key_of(environment.as_deref(), &worktree, &server);
    servers.refresh(&key, run_on).await;
    servers
        .definition(&key, &relative, text, line, character)
        .await
}

/// Whether the name at `line` and `character` of the file `relative` of `worktree` (its text now `text`) has a definition for the server `server`: the question that draws the underline while the Command key is down (A-34). It reads no change of the disk, and a server that is not `running` is refused with its reason, not started and not asked.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lsp_definition_exists(
    servers: State<'_, LspServers>,
    environment: Option<String>,
    worktree: String,
    server: String,
    relative: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<bool, String> {
    let key = key_of(environment.as_deref(), &worktree, &server);
    servers
        .definition_exists(&key, &relative, text, line, character)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::protocol::MAX_FRAME;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::{split, DuplexStream, WriteHalf},
        sync::Notify,
    };

    type Log = Arc<Mutex<Vec<Value>>>;

    /// How the stand-in for ruby-lsp behaves.
    #[derive(Clone)]
    struct Plan {
        /// Answers `initialize`.
        initialize: bool,
        /// Shows its progress after `initialized`: a `workDoneProgress/create`, a `begin`, and the `end` when `end` is notified.
        progress: bool,
        /// Answers `shutdown`.
        shutdown: bool,
        /// Ends (drops its streams) when it is told `initialized`.
        dies: bool,
        /// What it answers to a definition.
        definition: Arc<Mutex<Value>>,
        end: Arc<Notify>,
    }

    impl Plan {
        fn new() -> Self {
            Self {
                initialize: true,
                progress: true,
                shutdown: true,
                dies: false,
                definition: Arc::new(Mutex::new(Value::Null)),
                end: Arc::new(Notify::new()),
            }
        }
    }

    type Writer = Arc<tokio::sync::Mutex<WriteHalf<DuplexStream>>>;

    async fn say(writer: &Writer, message: Value) {
        let mut writer = writer.lock().await;
        writer.write_all(&encode(&message)).await.unwrap();
        writer.flush().await.unwrap();
    }

    /// The stand-in for ruby-lsp: reads each frame the client sends, keeps it in `log`, and answers as `plan` says.
    async fn serve(io: DuplexStream, log: Log, plan: Plan) {
        let (reader, writer) = split(io);
        let writer: Writer = Arc::new(tokio::sync::Mutex::new(writer));
        let mut reader = BufReader::new(reader);
        while let Ok(Some(Frame::Message(message))) = read_frame(&mut reader).await {
            log.lock().unwrap().push(message.clone());
            let id = message["id"].clone();
            match message["method"].as_str() {
                Some("initialize") if plan.initialize => {
                    say(&writer, response(&id, json!({"capabilities": {}}))).await;
                }
                Some("initialized") if plan.dies => break,
                Some("initialized") if plan.progress => {
                    say(&writer, request_of("s1", "window/workDoneProgress/create")).await;
                    say(
                        &writer,
                        notification(
                            "$/progress",
                            json!({"token": "indexing-progress", "value": {"kind": "begin", "title": "Indexing"}}),
                        ),
                    )
                    .await;
                    let (writer, end) = (writer.clone(), plan.end.clone());
                    tokio::spawn(async move {
                        end.notified().await;
                        say(
                            &writer,
                            notification(
                                "$/progress",
                                json!({"token": "indexing-progress", "value": {"kind": "end"}}),
                            ),
                        )
                        .await;
                    });
                }
                Some("textDocument/definition") => {
                    let result = plan.definition.lock().unwrap().clone();
                    say(&writer, response(&id, result)).await;
                }
                Some("shutdown") if plan.shutdown => say(&writer, response(&id, Value::Null)).await,
                Some("exit") => break,
                _ => {}
            }
        }
    }

    fn request_of(id: &str, method: &str) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": {}})
    }

    const FAST: Timing = Timing {
        init: Duration::from_secs(5),
        grace: Duration::from_millis(200),
        shutdown: Duration::from_millis(200),
        write: Duration::from_secs(1),
        child: Duration::from_secs(3),
        stderr: Duration::from_millis(100),
    };

    /// A session of the client against the stand-in: the commands, the states it published, what the stand-in received, and the end.
    struct Run {
        commands: mpsc::UnboundedSender<Cmd>,
        states: Arc<Mutex<Vec<LspStatus>>>,
        log: Log,
        plan: Plan,
        ended: JoinHandle<End>,
    }

    fn run(plan: Plan) -> Run {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let log: Log = Arc::default();
        tokio::spawn(serve(server, log.clone(), plan.clone()));
        let (commands, mut rx) = mpsc::unbounded_channel();
        let states: Arc<Mutex<Vec<LspStatus>>> = Arc::default();
        let seen = states.clone();
        let ended = tokio::spawn(async move {
            let (reader, writer) = split(client);
            session(
                reader,
                writer,
                "file:///app",
                &FAST,
                &mut rx,
                &move |status| {
                    let mut seen = seen.lock().unwrap();
                    if seen.last() != Some(&status) {
                        seen.push(status);
                    }
                },
            )
            .await
        });
        Run {
            commands,
            states,
            log,
            plan,
            ended,
        }
    }

    impl Run {
        async fn definition(
            &self,
            uri: &str,
            text: &str,
            line: u32,
            character: u32,
        ) -> Result<Value, String> {
            self.definition_in(uri, "ruby", text, line, character).await
        }

        async fn definition_in(
            &self,
            uri: &str,
            language: &str,
            text: &str,
            line: u32,
            character: u32,
        ) -> Result<Value, String> {
            self.ask(uri, language, text, line, character, false).await
        }

        /// A question of the underline: the file stays open once it is answered.
        async fn probe(&self, uri: &str, text: &str) -> Result<Value, String> {
            self.ask(uri, "ruby", text, 0, 0, true).await
        }

        async fn ask(
            &self,
            uri: &str,
            language: &str,
            text: &str,
            line: u32,
            character: u32,
            keep: bool,
        ) -> Result<Value, String> {
            let (reply, answer) = oneshot::channel();
            self.commands
                .send(Cmd::Definition {
                    uri: uri.into(),
                    language: language.into(),
                    text: text.into(),
                    line,
                    character,
                    keep,
                    reply,
                })
                .unwrap();
            answer.await.map_err(|_| "dropped".to_owned())?
        }

        /// What the stand-in received that has a method (the answers to its own requests are left out).
        fn calls(&self) -> Vec<Value> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .filter(|m| m["method"].is_string())
                .cloned()
                .collect()
        }

        fn methods(&self) -> Vec<String> {
            self.calls()
                .iter()
                .map(|m| m["method"].as_str().unwrap().to_owned())
                .collect()
        }

        fn states(&self) -> Vec<LspState> {
            self.states
                .lock()
                .unwrap()
                .iter()
                .map(|s| s.state)
                .collect()
        }

        /// Waits until the client has published `count` states.
        async fn until_states(&self, count: usize) {
            for _ in 0..1000 {
                if self.states.lock().unwrap().len() >= count {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            panic!("states: {:?}", self.states());
        }

        async fn stop(self) -> End {
            self.commands.send(Cmd::Stop).unwrap();
            self.ended.await.unwrap()
        }
    }

    // ---- the pure parts ----

    #[test]
    fn a_container_that_does_not_run_is_told_from_its_standard_error() {
        for stderr in [
            "service \"app\" is not running\n",
            "Error response from daemon: Container 3f2a is not running",
            "No container found for app_1",
            "SERVICE \"APP\" IS NOT RUNNING",
        ] {
            assert!(container_down(stderr), "{stderr}");
        }
        for stderr in [
            "",
            "bundler: command not found: ruby-lsp",
            "Cannot connect to the Docker daemon",
            // Said earlier by a server that ended for another reason.
            "service \"app\" is not running\nbundler: command not found: ruby-lsp\n",
            "No container found for app_1\n/usr/bin/ruby: segfault\n\n",
        ] {
            assert!(!container_down(stderr), "{stderr}");
        }
        // The last line that has text is the one read.
        assert!(container_down("warn\nservice \"app\" is not running\n\n"));
    }

    #[test]
    fn the_end_of_a_process_is_a_container_that_is_down_or_a_failure_with_the_last_line() {
        assert_eq!(
            stopped_status(EXITED, Some(1), "service \"app\" is not running\n"),
            LspStatus::stopped(LspStopReason::ContainerDown, Some(CONTAINER_DOWN.into()))
        );
        assert_eq!(
            stopped_status(
                EXITED,
                Some(1),
                "warn\nbundler: command not found: ruby-lsp\n"
            ),
            LspStatus::failed(format!("{EXITED}: bundler: command not found: ruby-lsp"))
        );
        assert_eq!(
            stopped_status(EXITED, Some(0), ""),
            LspStatus::failed(EXITED)
        );
        // The exit code of ssh's own failure.
        assert_eq!(
            stopped_status(
                EXITED,
                Some(255),
                "ssh: connect to host x port 22: Connection refused"
            ),
            LspStatus::failed("接続できません: ssh: connect to host x port 22: Connection refused")
        );
    }

    #[test]
    fn the_standard_error_keeps_its_end() {
        let mut kept = Vec::new();
        push_tail(&mut kept, b"abcdef", 8);
        push_tail(&mut kept, b"ghij", 8);
        assert_eq!(kept, b"cdefghij");
        push_tail(&mut kept, &[b'x'; 100], 8);
        assert_eq!(kept, b"xxxxxxxx");
    }

    #[test]
    fn the_state_is_indexing_until_the_session_is_initialized_and_the_progress_is_over() {
        let mut progress = Progress::default();
        assert_eq!(status_of(&progress, false), LspStatus::indexing());
        assert_eq!(status_of(&progress, true), LspStatus::indexing());
        progress.grace_over();
        assert_eq!(status_of(&progress, true), LspStatus::running());
        assert_eq!(status_of(&progress, false), LspStatus::indexing());
    }

    // ---- the talk ----

    #[tokio::test]
    async fn the_client_initializes_then_is_indexing_until_the_progress_ends() {
        let run = run(Plan::new());
        run.until_states(1).await;
        assert_eq!(run.states(), vec![LspState::Indexing]);
        run.plan.end.notify_one();
        run.until_states(2).await;
        assert_eq!(run.states(), vec![LspState::Indexing, LspState::Running]);
        assert_eq!(run.methods()[..2], ["initialize", "initialized"]);
        let init = run.log.lock().unwrap()[0].clone();
        assert_eq!(init["params"]["rootUri"], "file:///app");
        assert_eq!(run.stop().await, End::Closed);
    }

    #[tokio::test]
    async fn the_request_of_the_server_for_a_progress_is_answered_with_null_and_an_unknown_one_is_refused(
    ) {
        let run = run(Plan::new());
        run.until_states(1).await;
        run.plan.end.notify_one();
        run.until_states(2).await;
        let answer = run
            .log
            .lock()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "s1")
            .cloned()
            .unwrap();
        assert_eq!(answer, response(&json!("s1"), Value::Null));
        run.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_that_shows_no_progress_is_running_when_the_grace_is_over() {
        let mut plan = Plan::new();
        plan.progress = false;
        let run = run(plan);
        run.until_states(2).await;
        assert_eq!(run.states(), vec![LspState::Indexing, LspState::Running]);
        run.stop().await;
    }

    /// Waits until the stand-in has received `count` calls that have a method.
    async fn until_calls(run: &Run, count: usize) {
        for _ in 0..1000 {
            if run.calls().len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("calls: {:?}", run.methods());
    }

    #[tokio::test]
    async fn the_text_is_sent_whole_as_an_open_and_the_file_is_closed_once_it_is_answered() {
        let run = run(Plan::new());
        run.plan.end.notify_one();
        run.until_states(2).await;
        *run.plan.definition.lock().unwrap() =
            json!({"uri": "file:///app/b.rb", "range": {"start": {"line": 1, "character": 2}}});
        let got = run
            .definition("file:///app/a.rb", "x = 1\n", 0, 4)
            .await
            .unwrap();
        assert_eq!(got["uri"], "file:///app/b.rb");
        run.definition("file:///app/a.rb", "x = 2\n", 0, 0)
            .await
            .unwrap();
        run.definition("file:///app/other.rb", "y\n", 0, 0)
            .await
            .unwrap();
        // 2 calls of the handshake, then an open, the question and a close for each question.
        until_calls(&run, 2 + 9).await;
        assert_eq!(
            run.methods()[2..],
            [
                "textDocument/didOpen",
                "textDocument/definition",
                "textDocument/didClose",
                "textDocument/didOpen",
                "textDocument/definition",
                "textDocument/didClose",
                "textDocument/didOpen",
                "textDocument/definition",
                "textDocument/didClose",
            ]
        );
        let log = run.calls();
        assert_eq!(
            log[2]["params"]["textDocument"],
            json!({"uri": "file:///app/a.rb", "languageId": "ruby", "version": 1, "text": "x = 1\n"})
        );
        assert_eq!(
            log[3]["params"],
            json!({"textDocument": {"uri": "file:///app/a.rb"}, "position": {"line": 0, "character": 4}})
        );
        assert_eq!(
            log[4]["params"],
            json!({"textDocument": {"uri": "file:///app/a.rb"}})
        );
        // The file is opened again with its new text, not changed.
        assert_eq!(
            log[5]["params"]["textDocument"],
            json!({"uri": "file:///app/a.rb", "languageId": "ruby", "version": 1, "text": "x = 2\n"})
        );
        drop(log);
        run.stop().await;
    }

    #[tokio::test]
    async fn the_language_id_of_an_open_is_the_language_of_the_file() {
        let run = run(Plan::new());
        run.plan.end.notify_one();
        run.until_states(2).await;
        run.definition_in("file:///app/a.ts", "typescript", "let x = 1\n", 0, 4)
            .await
            .unwrap();
        until_calls(&run, 2 + 3).await;
        assert_eq!(
            run.calls()[2]["params"]["textDocument"],
            json!({"uri": "file:///app/a.ts", "languageId": "typescript", "version": 1, "text": "let x = 1\n"})
        );
        run.stop().await;
    }

    #[tokio::test]
    async fn a_notice_of_changed_files_is_sent_as_it_is_and_the_next_question_follows_it() {
        let run = run(Plan::new());
        run.plan.end.notify_one();
        run.until_states(2).await;
        let notice = crate::lsp::watch::message(
            "/app",
            &[crate::lsp::watch::Change {
                path: "lib/a.rb".into(),
                kind: 2,
            }],
        )
        .unwrap();
        run.commands.send(Cmd::Changed(notice.clone())).unwrap();
        run.definition("file:///app/a.rb", "x\n", 0, 0)
            .await
            .unwrap();
        until_calls(&run, 2 + 4).await;
        assert_eq!(
            run.methods()[2..],
            [
                "workspace/didChangeWatchedFiles",
                "textDocument/didOpen",
                "textDocument/definition",
                "textDocument/didClose",
            ]
        );
        assert_eq!(run.calls()[2]["params"], notice["params"]);
        run.stop().await;
    }

    #[tokio::test]
    async fn a_file_that_the_underline_asks_about_stays_open_until_another_file_is_asked_or_the_disk_changed(
    ) {
        let run = run(Plan::new());
        run.plan.end.notify_one();
        run.until_states(2).await;
        run.probe("file:///app/a.rb", "x = 1\n").await.unwrap();
        run.probe("file:///app/a.rb", "x = 1\n").await.unwrap();
        // The text of the editor changed: it is told as a change, not opened again.
        run.probe("file:///app/a.rb", "x = 2\n").await.unwrap();
        until_calls(&run, 2 + 5).await;
        assert_eq!(
            run.methods()[2..],
            [
                "textDocument/didOpen",
                "textDocument/definition",
                "textDocument/definition",
                "textDocument/didChange",
                "textDocument/definition",
            ]
        );
        // Another file takes its place: the first is closed, and only one is kept.
        run.probe("file:///app/b.rb", "y\n").await.unwrap();
        until_calls(&run, 2 + 8).await;
        assert_eq!(
            run.methods()[7..],
            [
                "textDocument/didClose",
                "textDocument/didOpen",
                "textDocument/definition",
            ]
        );
        // A change of the files on the disk closes the kept one before it is told.
        let notice = crate::lsp::watch::message(
            "/app",
            &[crate::lsp::watch::Change {
                path: "lib/a.rb".into(),
                kind: 2,
            }],
        )
        .unwrap();
        run.commands.send(Cmd::Changed(notice)).unwrap();
        // A question that is not the underline's opens the file again, and closes it once it is answered.
        run.definition("file:///app/b.rb", "y\n", 0, 0)
            .await
            .unwrap();
        until_calls(&run, 2 + 8 + 5).await;
        assert_eq!(
            run.methods()[10..],
            [
                "textDocument/didClose",
                "workspace/didChangeWatchedFiles",
                "textDocument/didOpen",
                "textDocument/definition",
                "textDocument/didClose",
            ]
        );
        run.stop().await;
    }

    #[test]
    fn a_language_id_is_the_one_that_lsp_names() {
        assert_eq!(language_id("a.rb", "ruby"), "ruby");
        assert_eq!(language_id("src/App.tsx", "typescript"), "typescriptreact");
        assert_eq!(language_id("src/app.ts", "typescript"), "typescript");
        assert_eq!(language_id("src/App.JSX", "javascript"), "javascriptreact");
        assert_eq!(language_id("bin/run", "shell"), "shellscript");
        assert_eq!(language_id("a.sh", "shell"), "shellscript");
        assert_eq!(language_id("Dockerfile", "dockerfile"), "dockerfile");
    }

    #[tokio::test]
    async fn a_file_is_closed_only_when_no_other_question_about_it_waits() {
        let uri = "file:///app/a.rb";
        let mut docs: HashMap<String, (i64, u64)> = HashMap::new();
        docs.insert(uri.into(), (1, 7));
        let (other, _keep) = oneshot::channel();
        let mut pending: Pending = HashMap::new();
        pending.insert(5, (uri.into(), other));
        let mut written: Vec<u8> = Vec::new();
        close_unused(
            &mut written,
            &mut docs,
            &pending,
            uri,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert!(written.is_empty());
        assert!(docs.contains_key(uri));
        // Another file's question does not keep it open.
        pending.clear();
        let (third, _keep) = oneshot::channel();
        pending.insert(6, ("file:///app/b.rb".into(), third));
        close_unused(
            &mut written,
            &mut docs,
            &pending,
            uri,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let text = String::from_utf8(written.clone()).unwrap();
        assert!(
            text.contains(r#""method":"textDocument/didClose""#),
            "{text}"
        );
        assert!(text.contains(r#""uri":"file:///app/a.rb""#), "{text}");
        assert!(docs.is_empty());
        // A file that is not open is not closed.
        written.clear();
        close_unused(
            &mut written,
            &mut docs,
            &pending,
            uri,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert!(written.is_empty());
    }

    #[tokio::test]
    async fn an_error_of_the_server_for_a_definition_is_the_answer_and_the_session_goes_on() {
        let plan = Plan::new();
        let (client, server) = tokio::io::duplex(64 * 1024);
        // A server that answers the definition with an error.
        let (reader, writer) = split(server);
        let writer: Writer = Arc::new(tokio::sync::Mutex::new(writer));
        tokio::spawn({
            let writer = writer.clone();
            async move {
                let mut reader = BufReader::new(reader);
                while let Ok(Some(Frame::Message(m))) = read_frame(&mut reader).await {
                    match m["method"].as_str() {
                        Some("initialize") => say(&writer, response(&m["id"], json!({}))).await,
                        Some("textDocument/definition") => {
                            say(
                                &writer,
                                error_response(&m["id"], -32603, "internal\u{7}error"),
                            )
                            .await
                        }
                        _ => {}
                    }
                }
            }
        });
        let (commands, mut rx) = mpsc::unbounded_channel();
        let ended = tokio::spawn(async move {
            let (reader, writer) = split(client);
            session(reader, writer, "file:///app", &FAST, &mut rx, &|_| {}).await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (reply, answer) = oneshot::channel();
        commands
            .send(Cmd::Definition {
                uri: "file:///app/a.rb".into(),
                language: "ruby".into(),
                text: "a".into(),
                line: 0,
                character: 0,
                keep: false,
                reply,
            })
            .unwrap();
        assert_eq!(answer.await.unwrap(), Err("internalerror".to_owned()));
        commands.send(Cmd::Stop).unwrap();
        assert_eq!(ended.await.unwrap(), End::Closed);
        drop(plan);
    }

    #[tokio::test(start_paused = true)]
    async fn a_question_before_the_server_has_initialized_is_refused() {
        let mut plan = Plan::new();
        plan.initialize = false;
        let run = run(plan);
        assert_eq!(
            run.definition("file:///app/a.rb", "a", 0, 0).await,
            Err(NOT_READY.to_owned())
        );
        // A server that never answers `initialize` ends the session when `init` is over.
        assert_eq!(run.ended.await.unwrap(), End::Died(INIT_TIMEOUT.into()));
    }

    #[tokio::test]
    async fn stopping_says_shutdown_then_exit_and_ends_the_session() {
        let run = run(Plan::new());
        run.plan.end.notify_one();
        run.until_states(2).await;
        let log = run.log.clone();
        assert_eq!(run.stop().await, End::Closed);
        let methods: Vec<String> = log
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| m["method"].as_str().map(str::to_owned))
            .collect();
        assert_eq!(methods[methods.len() - 2..], ["shutdown", "exit"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_that_does_not_answer_shutdown_is_not_waited_for_longer_than_the_time_given() {
        let mut plan = Plan::new();
        plan.shutdown = false;
        let run = run(plan);
        run.until_states(1).await;
        let began = Instant::now();
        assert_eq!(run.stop().await, End::Closed);
        assert!(Instant::now() - began <= FAST.shutdown + Duration::from_millis(50));
    }

    #[tokio::test]
    async fn stopping_before_the_server_has_initialized_sends_nothing_more() {
        let mut plan = Plan::new();
        plan.initialize = false;
        let run = run(plan);
        let log = run.log.clone();
        assert_eq!(run.stop().await, End::Closed);
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_server_that_ends_ends_the_session_and_drops_the_questions_that_wait() {
        let mut plan = Plan::new();
        plan.dies = true;
        let run = run(plan);
        let (reply, answer) = oneshot::channel();
        run.commands
            .send(Cmd::Definition {
                uri: "file:///app/a.rb".into(),
                language: "ruby".into(),
                text: "a".into(),
                line: 0,
                character: 0,
                keep: false,
                reply,
            })
            .unwrap();
        assert_eq!(run.ended.await.unwrap(), End::Died(EXITED.into()));
        // Either refused (not initialized yet) or dropped: it never waits.
        assert!(answer.await.map_or(true, |result| result.is_err()));
    }

    #[tokio::test]
    async fn a_frame_that_cannot_be_trusted_ends_the_session() {
        let (client, mut server) = tokio::io::duplex(64 * 1024);
        let (_commands, mut rx) = mpsc::unbounded_channel();
        let ended = tokio::spawn(async move {
            let (reader, writer) = split(client);
            session(reader, writer, "file:///app", &FAST, &mut rx, &|_| {}).await
        });
        server
            .write_all(format!("Content-Length: {}\r\n\r\n", MAX_FRAME + 1).as_bytes())
            .await
            .unwrap();
        let End::Died(reason) = ended.await.unwrap() else {
            panic!("not died")
        };
        assert!(reason.contains("大きすぎます"), "{reason}");
    }

    #[tokio::test]
    async fn a_server_that_refuses_initialize_ends_the_session_with_its_words() {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let (reader, writer) = split(server);
        let writer: Writer = Arc::new(tokio::sync::Mutex::new(writer));
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            if let Ok(Some(Frame::Message(m))) = read_frame(&mut reader).await {
                say(&writer, error_response(&m["id"], -32600, "bad root")).await;
            }
            // Kept open: the session ends by the answer, not by the end of the stream.
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let (_commands, mut rx) = mpsc::unbounded_channel();
        let (reader, writer) = split(client);
        assert_eq!(
            session(reader, writer, "file:///app", &FAST, &mut rx, &|_| {}).await,
            End::Died(format!("{INIT_FAILED}: bad root"))
        );
    }

    #[tokio::test]
    async fn a_session_ends_when_its_channel_of_questions_is_dropped() {
        let run = run(Plan::new());
        run.until_states(1).await;
        let Run {
            commands, ended, ..
        } = run;
        drop(commands);
        assert_eq!(ended.await.unwrap(), End::Closed);
    }

    // ---- the servers ----

    fn key(worktree: &str) -> Key {
        key_of(None, worktree, "ruby-lsp")
    }

    fn collector() -> (Emit, Arc<Mutex<Vec<LspStatusEvent>>>) {
        let events: Arc<Mutex<Vec<LspStatusEvent>>> = Arc::default();
        let seen = events.clone();
        (
            Arc::new(move |event| seen.lock().unwrap().push(event)),
            events,
        )
    }

    fn way_of(mount: &str) -> Way {
        Way {
            mount: mount.into(),
            route: Route::Local,
            method: LspMethod::Compose,
            service: Some("app".into()),
            extensions: vec![".rb".into()],
        }
    }

    /// The task of a server that talks to the stand-in, with `/app` as its mount.
    fn standin(
        plan: Plan,
        started: Arc<AtomicUsize>,
    ) -> impl FnOnce(Ctx) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> {
        move |mut ctx| {
            Box::pin(async move {
                started.fetch_add(1, Ordering::SeqCst);
                let (client, server) = tokio::io::duplex(64 * 1024);
                tokio::spawn(serve(server, Arc::default(), plan));
                *ctx.way.lock().unwrap() = Some(way_of("/app"));
                let publisher = ctx.publisher.clone();
                let (reader, writer) = split(client);
                if let End::Died(reason) =
                    session(reader, writer, "file:///app", &FAST, &mut ctx.rx, &|s| {
                        publisher.set(s)
                    })
                    .await
                {
                    publisher.set(LspStatus::failed(reason));
                }
            })
        }
    }

    async fn until(mut done: impl FnMut() -> bool) {
        for _ in 0..1000 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("never");
    }

    async fn wait_for(servers: &LspServers, key: &Key, want: LspState) -> LspStatus {
        for _ in 0..1000 {
            let status = servers.status(key).await;
            if status.state == want {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("never {want:?}: {:?}", servers.status(key).await);
    }

    #[tokio::test]
    async fn a_server_that_is_there_is_not_started_again_and_its_state_is_told_by_events() {
        let servers = LspServers::default();
        let (emit, events) = collector();
        let started = Arc::new(AtomicUsize::new(0));
        let plan = Plan::new();
        let k = key("/w/a");
        assert_eq!(
            servers.status(&k).await,
            LspStatus::stopped(LspStopReason::NotStarted, None)
        );
        let first = servers
            .start_with(
                k.clone(),
                emit.clone(),
                standin(plan.clone(), started.clone()),
            )
            .await;
        assert_eq!(first, LspStatus::indexing());
        let second = servers
            .start_with(
                k.clone(),
                emit.clone(),
                standin(plan.clone(), started.clone()),
            )
            .await;
        assert_eq!(second, LspStatus::indexing());
        plan.end.notify_one();
        wait_for(&servers, &k, LspState::Running).await;
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert_eq!(
            servers
                .start_with(k.clone(), emit, standin(plan, started.clone()))
                .await,
            LspStatus::running()
        );
        assert_eq!(started.load(Ordering::SeqCst), 1);
        let states: Vec<LspState> = events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.status.state)
            .collect();
        assert_eq!(states, vec![LspState::Running]);
        let event = events.lock().unwrap()[0].clone();
        assert_eq!(
            (event.environment, event.worktree, event.server),
            (None, "/w/a".to_owned(), "ruby-lsp".to_owned())
        );
        servers.close_all().await;
    }

    #[tokio::test]
    async fn the_servers_of_two_places_are_kept_apart() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let started = Arc::new(AtomicUsize::new(0));
        let plan = Plan::new();
        for k in [
            key_of(None, "/w", "ruby-lsp"),
            key_of(Some("srv"), "/w", "ruby-lsp"),
            key_of(None, "/other", "ruby-lsp"),
            key_of(None, "/w", "ts"),
        ] {
            servers
                .start_with(k, emit.clone(), standin(plan.clone(), started.clone()))
                .await;
        }
        until(|| started.load(Ordering::SeqCst) == 4).await;
        servers.stop(&key_of(Some("srv"), "/w", "ruby-lsp")).await;
        assert_eq!(
            servers
                .status(&key_of(Some("srv"), "/w", "ruby-lsp"))
                .await
                .reason,
            Some(LspStopReason::NotStarted)
        );
        // The other server of the same worktree is another server, and keeps running.
        servers.stop(&key_of(None, "/w", "ts")).await;
        assert_eq!(
            servers.status(&key_of(None, "/w", "ts")).await.reason,
            Some(LspStopReason::NotStarted)
        );
        assert_ne!(
            servers.status(&key_of(None, "/w", "ruby-lsp")).await.state,
            LspState::Stopped
        );
        servers.close_all().await;
    }

    #[tokio::test]
    async fn a_server_that_died_is_stopped_with_its_message_and_is_started_again_by_a_start() {
        let servers = LspServers::default();
        let (emit, events) = collector();
        let started = Arc::new(AtomicUsize::new(0));
        let mut dying = Plan::new();
        dying.dies = true;
        let k = key("/w/a");
        servers
            .start_with(k.clone(), emit.clone(), standin(dying, started.clone()))
            .await;
        let status = wait_for(&servers, &k, LspState::Stopped).await;
        assert_eq!(status.reason, Some(LspStopReason::Failed));
        assert_eq!(status.message.as_deref(), Some(EXITED));
        assert_eq!(events.lock().unwrap().last().unwrap().status, status);
        // A question to a server that is stopped is refused, not waited for.
        assert_eq!(
            servers.definition(&k, "a.rb", "a".into(), 0, 0).await,
            Err(STOPPED.to_owned())
        );
        let again = servers
            .start_with(k.clone(), emit, standin(Plan::new(), started.clone()))
            .await;
        assert_eq!(again, LspStatus::indexing());
        until(|| started.load(Ordering::SeqCst) == 2).await;
        assert_ne!(servers.status(&k).await.state, LspState::Stopped);
        servers.close_all().await;
    }

    #[tokio::test]
    async fn stop_takes_the_server_away_and_a_stop_of_none_is_no_error() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let started = Arc::new(AtomicUsize::new(0));
        let k = key("/w/a");
        servers.stop(&k).await;
        servers
            .start_with(k.clone(), emit, standin(Plan::new(), started))
            .await;
        servers.stop(&k).await;
        assert_eq!(
            servers.status(&k).await,
            LspStatus::stopped(LspStopReason::NotStarted, None)
        );
        assert_eq!(
            servers.definition(&k, "a.rb", "a".into(), 0, 0).await,
            Err(NOT_STARTED.to_owned())
        );
    }

    #[tokio::test]
    async fn a_definition_gives_paths_from_the_worktree_and_remembers_those_outside() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let plan = Plan::new();
        *plan.definition.lock().unwrap() = json!([
            {"uri": "file:///app/app/models/user.rb", "range": {"start": {"line": 3, "character": 6}}},
            {"uri": "file:///usr/local/bundle/gems/rack-3.1.0/lib/rack.rb", "range": {"start": {"line": 10, "character": 2}}},
        ]);
        let k = key("/w/a");
        servers
            .start_with(k.clone(), emit, standin(plan.clone(), Arc::default()))
            .await;
        plan.end.notify_one();
        wait_for(&servers, &k, LspState::Running).await;
        let got = servers
            .definition(&k, "lib/a.rb", "User\n".into(), 0, 2)
            .await
            .unwrap();
        assert_eq!(
            got,
            vec![
                LspLocation {
                    path: "app/models/user.rb".into(),
                    outside: false,
                    line: 3,
                    character: 6
                },
                LspLocation {
                    path: "/usr/local/bundle/gems/rack-3.1.0/lib/rack.rb".into(),
                    outside: true,
                    line: 10,
                    character: 2
                },
            ]
        );
        let gem = "/usr/local/bundle/gems/rack-3.1.0/lib/rack.rb";
        // The way it was started by comes with the path.
        assert_eq!(
            servers.outside_way(None, "/w/a", "ruby-lsp", gem).await,
            Some(way_of("/app"))
        );
        assert_eq!(
            servers
                .outside_way(None, "/w/a", "ruby-lsp", "/etc/passwd")
                .await,
            None
        );
        assert_eq!(
            servers
                .outside_way(None, "/w/a", "ruby-lsp", "app/models/user.rb")
                .await,
            None
        );
        assert_eq!(
            servers
                .outside_way(Some("srv"), "/w/a", "ruby-lsp", gem)
                .await,
            None
        );
        assert_eq!(
            servers.outside_way(None, "/w/other", "ruby-lsp", gem).await,
            None
        );
        servers.close_all().await;
    }

    #[tokio::test]
    async fn whether_a_definition_exists_is_asked_of_a_running_server_only_and_keeps_no_place_outside(
    ) {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let plan = Plan::new();
        let k = key("/w/a");
        let ask = |text: &str| servers.definition_exists(&k, "lib/a.rb", text.into(), 0, 2);
        assert_eq!(ask("User\n").await, Err(NOT_STARTED.to_owned()));
        servers
            .start_with(k.clone(), emit, standin(plan.clone(), Arc::default()))
            .await;
        // Indexing: nothing is asked.
        assert_eq!(ask("User\n").await, Err(NOT_READY.to_owned()));
        plan.end.notify_one();
        wait_for(&servers, &k, LspState::Running).await;
        let gem = "/usr/local/bundle/gems/rack-3.1.0/lib/rack.rb";
        *plan.definition.lock().unwrap() = json!([
            {"uri": format!("file://{gem}"), "range": {"start": {"line": 10, "character": 2}}},
        ]);
        assert_eq!(ask("Rack\n").await, Ok(true));
        assert_eq!(
            servers.outside_way(None, "/w/a", "ruby-lsp", gem).await,
            None
        );
        *plan.definition.lock().unwrap() = json!([]);
        assert_eq!(ask("x\n").await, Ok(false));
        *plan.definition.lock().unwrap() = json!(null);
        assert_eq!(ask("x\n").await, Ok(false));
        assert!(servers
            .definition_exists(&k, "../x.rb", "a".into(), 0, 0)
            .await
            .is_err());
        assert_eq!(
            servers
                .definition_exists(&k, "a.rb", "a".repeat(MAX_DOC + 1), 0, 0)
                .await,
            Err(TOO_LARGE.to_owned())
        );
        servers.stop(&k).await;
        assert_eq!(ask("x\n").await, Err(NOT_STARTED.to_owned()));
        servers.close_all().await;
    }

    #[tokio::test]
    async fn a_stopped_server_is_refused_the_question_of_whether_a_definition_exists() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let mut dying = Plan::new();
        dying.dies = true;
        let k = key("/w/a");
        servers
            .start_with(k.clone(), emit, standin(dying, Arc::default()))
            .await;
        wait_for(&servers, &k, LspState::Stopped).await;
        assert_eq!(
            servers
                .definition_exists(&k, "a.rb", "a".into(), 0, 0)
                .await,
            Err(STOPPED.to_owned())
        );
    }

    #[tokio::test]
    async fn a_restart_replaces_the_running_server_and_keeps_the_places_outside_the_worktree() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let plan = Plan::new();
        *plan.definition.lock().unwrap() = json!([
            {"uri": "file:///usr/local/bundle/gems/rack-3.1.0/lib/rack.rb", "range": {"start": {"line": 10, "character": 2}}},
        ]);
        let started = Arc::new(AtomicUsize::new(0));
        let k = key("/w/a");
        servers
            .start_with(
                k.clone(),
                emit.clone(),
                standin(plan.clone(), started.clone()),
            )
            .await;
        plan.end.notify_one();
        wait_for(&servers, &k, LspState::Running).await;
        servers
            .definition(&k, "lib/a.rb", "Rack\n".into(), 0, 2)
            .await
            .unwrap();
        let gem = "/usr/local/bundle/gems/rack-3.1.0/lib/rack.rb";
        let again = Plan::new();
        assert_eq!(
            servers
                .restart_with(k.clone(), emit, standin(again.clone(), started.clone()))
                .await,
            LspStatus::indexing()
        );
        // The new server is the one that is there, and it knows what the old one gave.
        until(|| started.load(Ordering::SeqCst) == 2).await;
        again.end.notify_one();
        wait_for(&servers, &k, LspState::Running).await;
        assert_eq!(
            servers.outside_way(None, "/w/a", "ruby-lsp", gem).await,
            Some(way_of("/app"))
        );
        servers.close_all().await;
    }

    #[tokio::test]
    async fn a_restart_of_a_worktree_with_no_server_starts_one() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let k = key("/w/a");
        let plan = Plan::new();
        let started = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            servers
                .restart_with(k.clone(), emit, standin(plan.clone(), started.clone()))
                .await,
            LspStatus::indexing()
        );
        plan.end.notify_one();
        wait_for(&servers, &k, LspState::Running).await;
        until(|| started.load(Ordering::SeqCst) == 1).await;
        servers.close_all().await;
    }

    // ---- the look at the disk ----

    fn new_watch() -> Arc<tokio::sync::Mutex<Watch>> {
        Arc::new(tokio::sync::Mutex::new(Watch {
            at: Instant::now(),
            known: None,
        }))
    }

    fn printed(
        code: i32,
        stdout: &str,
    ) -> impl FnOnce(&Route, &str, &str, usize) -> Result<Ran, String> + Send + 'static {
        let stdout = stdout.as_bytes().to_vec();
        move |_, _, _, _| {
            Ok(Ran {
                code: Some(code),
                stdout,
                stderr: String::new(),
            })
        }
    }

    fn change(path: &str, kind: u8) -> watch::Change {
        watch::Change {
            path: path.into(),
            kind,
        }
    }

    #[tokio::test]
    async fn a_look_whose_find_met_a_folder_it_cannot_read_still_tells_what_it_listed() {
        let state = new_watch();
        // The second `find` ended with 1 (Permission denied), so there is no `--end`, and so the whole script has the code 1.
        let got = look(
            &state,
            &way_of("/app"),
            "/w/a",
            printed(1, "./a.rb\n--\n./a.rb\n./b.rb\n"),
        )
        .await;
        assert_eq!(got, vec![change("a.rb", 2)]);
        // The list was cut, so it says nothing of the files that are gone.
        assert_eq!(state.lock().await.known, None);
    }

    #[tokio::test]
    async fn a_look_that_ended_well_keeps_the_list_even_with_a_failing_code() {
        let state = new_watch();
        look(
            &state,
            &way_of("/app"),
            "/w/a",
            printed(1, "--\n./a.rb\n./b.rb\n--end\n"),
        )
        .await;
        assert_eq!(
            state.lock().await.known,
            Some(["a.rb".to_owned(), "b.rb".to_owned()].into())
        );
    }

    #[tokio::test]
    async fn a_script_that_did_not_run_and_a_run_that_failed_tell_nothing_and_keep_what_was_known()
    {
        let state = new_watch();
        let at = state.lock().await.at;
        let first = look(&state, &way_of("/app"), "/w/a", printed(255, "")).await;
        let second = look(
            &state,
            &way_of("/app"),
            "/w/a",
            |_: &Route, _: &str, _: &str, _: usize| Err("no".to_owned()),
        )
        .await;
        assert!(first.is_empty() && second.is_empty());
        let kept = state.lock().await;
        assert_eq!((kept.at, kept.known.clone()), (at, None));
    }

    #[tokio::test]
    async fn the_first_look_is_the_start_for_the_files_that_are_gone_by_the_first_question() {
        let state = new_watch();
        // The look at `initialized`: nothing is told, the list is kept.
        look(
            &state,
            &way_of("/app"),
            "/w/a",
            printed(0, "--\n./a.rb\n./b.rb\n--end\n"),
        )
        .await;
        // At the first question `b.rb` is gone: it is told as deleted.
        let got = look(
            &state,
            &way_of("/app"),
            "/w/a",
            printed(0, "--\n./a.rb\n--end\n"),
        )
        .await;
        assert_eq!(got, vec![change("b.rb", 3)]);
    }

    #[tokio::test]
    async fn a_definition_refuses_a_path_that_is_not_below_the_worktree_and_a_text_that_is_too_large(
    ) {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let plan = Plan::new();
        let k = key("/w/a");
        servers
            .start_with(k.clone(), emit, standin(plan.clone(), Arc::default()))
            .await;
        plan.end.notify_one();
        wait_for(&servers, &k, LspState::Running).await;
        for relative in ["", "../x.rb", "/etc/passwd", "a/../../x.rb"] {
            assert!(
                servers
                    .definition(&k, relative, "a".into(), 0, 0)
                    .await
                    .is_err(),
                "{relative}"
            );
        }
        assert_eq!(
            servers
                .definition(&k, "a.rb", "a".repeat(MAX_DOC + 1), 0, 0)
                .await,
            Err(TOO_LARGE.to_owned())
        );
        servers.close_all().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_definition_before_the_mount_is_known_is_refused() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let k = key("/w/a");
        servers
            .start_with(k.clone(), emit, |_ctx: Ctx| async {
                std::future::pending::<()>().await
            })
            .await;
        assert_eq!(
            servers.definition(&k, "a.rb", "a".into(), 0, 0).await,
            Err(NOT_READY.to_owned())
        );
        // A task that does not end for `Stop` is ended after `STOP_WAIT`.
        servers.stop(&k).await;
    }

    #[tokio::test]
    async fn close_all_stops_every_server_at_once() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let plan = Plan::new();
        for worktree in ["/w/a", "/w/b", "/w/c"] {
            servers
                .start_with(
                    key(worktree),
                    emit.clone(),
                    standin(plan.clone(), Arc::default()),
                )
                .await;
        }
        servers.close_all().await;
        for worktree in ["/w/a", "/w/b", "/w/c"] {
            assert_eq!(
                servers.status(&key(worktree)).await.reason,
                Some(LspStopReason::NotStarted)
            );
        }
    }

    // ---- a real process ----

    fn sh(script: &str) -> Spawn {
        Spawn {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
        }
    }

    fn ctx_for(
        k: &Key,
    ) -> (
        Ctx,
        mpsc::UnboundedSender<Cmd>,
        Arc<Mutex<Vec<LspStatusEvent>>>,
    ) {
        let (emit, events) = collector();
        let (commands, rx) = mpsc::unbounded_channel();
        let ctx = Ctx {
            rx,
            publisher: Publisher {
                key: k.clone(),
                status: Arc::new(Mutex::new(LspStatus::indexing())),
                emit,
            },
            way: Arc::default(),
            watch: new_watch(),
        };
        (ctx, commands, events)
    }

    #[tokio::test]
    async fn a_process_that_says_its_container_is_not_running_is_a_stopped_server_with_that_reason()
    {
        let (mut ctx, _commands, events) = ctx_for(&key("/w/a"));
        run_spawn(
            &mut ctx,
            &sh("echo 'service \"app\" is not running' >&2; exit 1"),
            "/app",
            &FAST,
        )
        .await;
        assert_eq!(
            events.lock().unwrap().last().unwrap().status,
            LspStatus::stopped(LspStopReason::ContainerDown, Some(CONTAINER_DOWN.into()))
        );
    }

    #[tokio::test]
    async fn a_process_that_ends_with_a_message_is_a_failure_with_its_last_line() {
        let (mut ctx, _commands, events) = ctx_for(&key("/w/a"));
        run_spawn(&mut ctx, &sh("echo 'boom' >&2; exit 3"), "/app", &FAST).await;
        assert_eq!(
            events.lock().unwrap().last().unwrap().status,
            LspStatus::failed(format!("ruby-lsp {EXITED}: boom"))
        );
    }

    #[tokio::test]
    async fn a_program_that_is_not_there_is_a_failure_to_start() {
        let (mut ctx, _commands, events) = ctx_for(&key("/w/a"));
        let spawn = Spawn {
            program: "/nonexistent/tsunagiai-lsp-test".into(),
            args: Vec::new(),
        };
        run_spawn(&mut ctx, &spawn, "/app", &FAST).await;
        assert_eq!(
            events.lock().unwrap().last().unwrap().status,
            LspStatus::failed(format!("ruby-lsp {NOT_RUN}"))
        );
    }

    #[tokio::test]
    async fn a_process_that_keeps_its_input_open_is_ended_by_closing_it() {
        // `cat` reads its standard input to the end: it exits only when the standard input is closed.
        let (mut ctx, commands, events) = ctx_for(&key("/w/a"));
        let began = std::time::Instant::now();
        commands.send(Cmd::Stop).unwrap();
        // With `Stop` queued, the session ends at once: no `initialize` was answered, so no shutdown is said.
        run_spawn(&mut ctx, &sh("cat >/dev/null"), "/app", &FAST).await;
        assert!(began.elapsed() < FAST.child, "{:?}", began.elapsed());
        // A stop on purpose is no failure: no state of `stopped` was told.
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_task_that_ignores_the_stop_is_ended_after_the_wait() {
        let servers = LspServers::default();
        let (emit, _) = collector();
        let k = key("/w/a");
        servers
            .start_with(k.clone(), emit, |_ctx: Ctx| async {
                std::future::pending::<()>().await
            })
            .await;
        let began = Instant::now();
        servers.stop(&k).await;
        assert!(Instant::now() - began >= STOP_WAIT);
    }
}
