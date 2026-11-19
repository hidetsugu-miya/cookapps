//! A-36 (#731): how the tools of `tsunagiai-mcp` read and write the fields a screen of the app holds (the text typed and not yet saved or sent), and how the app is told that something changed.
//!
//! The app opens one Unix domain socket, `screen-bridge.sock`, in its config folder (mode 0600, a stale file of an earlier start removed first). A client connects for one call: it sends one line of JSON (a `Request`) and reads one line (a `ScreenAnswer`).
//! `read`, `write` and `post` name a target (a screen's set of fields, registered in `ts/screen-bridge.ts` and listed in `RULES.targets`): the app passes them to the screen as the event `screen-bridge-ask` and waits for the screen to answer through the command `screen_bridge_answer` (the value the screen holds now; for a `post`, what the screen's own "投稿" did). `changed` tells the screens that something changed (the event `screen-bridge-changed`), and waits for nobody.
//! Every request is checked here (`check`: the name of the target, of each field, and the length of each text) before the screen is asked, and the client checks it too before it connects.

use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(unix)]
use tokio::{
    io::AsyncWriteExt,
    net::{UnixListener, UnixStream},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt},
    sync::oneshot,
    time::timeout,
};
#[cfg(test)]
use ts_rs::TS;

use crate::gmail;

/// The names and the texts of the fields of a screen.
pub type Fields = BTreeMap<String, String>;

/// The socket's file, in the app config folder.
pub const SOCKET_FILE: &str = "screen-bridge.sock";
/// The event that asks a screen to read or write a target (`ScreenAsk`).
const ASK_EVENT: &str = "screen-bridge-ask";
/// The event that tells the screens what changed (the name, a text).
const CHANGED_EVENT: &str = "screen-bridge-changed";

/// What the app lets through. `targets` are the screens that a tool may read and write (a screen adds its own name here when it registers its fields in `ts/screen-bridge.ts`), `changes` the names `changed` may carry, `wait` how long the app waits for a screen's answer.
pub struct Rules {
    pub targets: &'static [&'static str],
    pub changes: &'static [&'static str],
    pub wait: Duration,
    /// How long the app waits for a screen's `post` (a post to Slack is on its way meanwhile).
    pub post_wait: Duration,
}

pub const RULES: Rules = Rules {
    targets: &[
        "slack-compose",
        "calendar-slots",
        "calendar-form",
        "todo-prompt",
        "todo-draft",
        "slack-thread",
        "slack-channel",
        "mail-draft",
    ],
    changes: &["todo", "calendar", "calendar-shown", "skills"],
    wait: Duration::from_secs(5),
    post_wait: Duration::from_secs(40),
};

/// The most fields in one write, the longest name of a target or a field, and the most characters of one text.
const MAX_FIELDS: usize = 8;
const MAX_NAME: usize = 32;
const MAX_TEXT: usize = 10_000;
/// The longest line of a request or of an answer, in bytes.
const MAX_LINE: usize = 1024 * 1024;
/// How long a client waits for the whole call (it is longer than `RULES.wait`, so the app's own error comes first; a `post` waits `POST_CALL_TIMEOUT`, longer than `RULES.post_wait`), and how long the app waits for the line of a request.
const CALL_TIMEOUT: Duration = Duration::from_secs(8);
const POST_CALL_TIMEOUT: Duration = Duration::from_secs(45);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// The longest path of a socket that `sockaddr_un` holds (104 bytes on macOS, with the NUL).
#[cfg(unix)]
const MAX_SOCKET_PATH: usize = 100;

const NOT_RUNNING: &str = "つなぎAIが動いていません。アプリを起動してから、もう一度試してください";

/// One call from a client.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// The fields of `target` as the screen holds them now.
    Read { target: String },
    /// Replaces the text of each named field of `target`; the fields not named stay.
    Write { target: String, fields: Fields },
    /// Does what the screen's own "投稿" does with what it holds now (#734); the answer's `fields` say what happened (`state`).
    Post { target: String },
    /// Something changed (a name of `RULES.changes`, such as `todo`, `calendar` (an event), `calendar-shown` (the calendars shown) and `skills` (a skill saved)): the screens that registered for it read again.
    Changed { what: String },
}

/// The answer to a `Request`, and the screen's answer to an ask. `fields` is the answer of a read; `error` is Japanese text for the owner or the tool's caller.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct ScreenAnswer {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "Record<string, string>"))]
    pub fields: Option<Fields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub error: Option<String>,
}

impl ScreenAnswer {
    fn done() -> Self {
        Self {
            ok: true,
            ..Self::default()
        }
    }

    fn failed(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            fields: None,
            error: Some(error.into()),
        }
    }

    /// The fields of a read (none for a write), or the error text.
    fn into_result(self) -> Result<Fields, String> {
        if self.ok {
            Ok(self.fields.unwrap_or_default())
        } else {
            Err(self
                .error
                .unwrap_or_else(|| "画面の欄を読み書きできませんでした".to_owned()))
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum ScreenOp {
    Read,
    Write,
    Post,
}

/// What the app asks a screen (the event `screen-bridge-ask`); the screen answers it with `screen_bridge_answer(id, answer)`. `fields` is empty for a read.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct ScreenAsk {
    pub id: u32,
    pub op: ScreenOp,
    pub target: String,
    #[cfg_attr(test, ts(type = "Record<string, string>"))]
    pub fields: Fields,
}

// ---- the checks ----

/// A name of a target or of a field: 1 to `MAX_NAME` characters of a to z, 0 to 9, `-` and `_`.
fn check_name(kind: &str, name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= MAX_NAME
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{kind}の名前は、半角の小文字、数字、-、_ の 1 から {MAX_NAME} 文字にしてください"
        ))
    }
}

fn check_listed(kind: &str, name: &str, listed: &[&str]) -> Result<(), String> {
    check_name(kind, name)?;
    if listed.contains(&name) {
        Ok(())
    } else if listed.is_empty() {
        Err(format!("読み書きできる{kind}がありません"))
    } else {
        Err(format!(
            "{name} は読み書きできる{kind}ではありません（{}）",
            listed.join("、")
        ))
    }
}

/// Checks a request before anything is asked of a screen: the target (it must be in `rules.targets`), the names of the fields, how many there are and how long each text is (counted in characters).
pub fn check(request: &Request, rules: &Rules) -> Result<(), String> {
    match request {
        Request::Read { target } | Request::Post { target } => {
            check_listed("画面", target, rules.targets)
        }
        Request::Changed { what } => check_listed("変更", what, rules.changes),
        Request::Write { target, fields } => {
            check_listed("画面", target, rules.targets)?;
            if fields.is_empty() {
                return Err("書き込む欄がありません".to_owned());
            }
            if fields.len() > MAX_FIELDS {
                return Err(format!("一度に書き込める欄は {MAX_FIELDS} までです"));
            }
            for (name, text) in fields {
                check_name("欄", name)?;
                let length = text.chars().count();
                if length > MAX_TEXT {
                    return Err(format!(
                        "欄 {name} の文は {MAX_TEXT} 文字までです（{length} 文字）"
                    ));
                }
            }
            Ok(())
        }
    }
}

// ---- the asks that wait for a screen ----

#[derive(Default)]
struct PendingState {
    next: u32,
    waiting: HashMap<u32, oneshot::Sender<ScreenAnswer>>,
}

/// The asks that wait for a screen's answer, by id.
#[derive(Default)]
pub struct Pending(Mutex<PendingState>);

impl Pending {
    fn register(&self) -> (u32, oneshot::Receiver<ScreenAnswer>) {
        let mut state = self.0.lock().unwrap();
        let (sender, receiver) = oneshot::channel();
        let id = state.next;
        state.next = state.next.wrapping_add(1);
        state.waiting.insert(id, sender);
        (id, receiver)
    }

    /// Hands the screen's answer to the ask `id`; false when nothing waits for it (it timed out).
    fn answer(&self, id: u32, answer: ScreenAnswer) -> bool {
        let sender = self.0.lock().unwrap().waiting.remove(&id);
        sender.is_some_and(|sender| sender.send(answer).is_ok())
    }

    fn forget(&self, id: u32) {
        self.0.lock().unwrap().waiting.remove(&id);
    }
}

/// What the app tells the screens.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Ask(ScreenAsk),
    Changed(String),
}

async fn ask(
    pending: &Pending,
    emit: &impl Fn(Event) -> Result<(), String>,
    wait: Duration,
    op: ScreenOp,
    target: String,
    fields: Fields,
) -> ScreenAnswer {
    let (id, receiver) = pending.register();
    if let Err(e) = emit(Event::Ask(ScreenAsk {
        id,
        op,
        target,
        fields,
    })) {
        pending.forget(id);
        return ScreenAnswer::failed(e);
    }
    match timeout(wait, receiver).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(_)) => ScreenAnswer::failed("画面が答えませんでした"),
        Err(_) => {
            pending.forget(id);
            // A post may have gone out: the owner is told to look, not to try again.
            ScreenAnswer::failed(if op == ScreenOp::Post {
                "投稿の結果を待ちきれませんでした。投稿されたかどうかは、つなぎAIの画面で確かめてください"
            } else {
                "画面が時間内に答えませんでした。画面が開いているか確かめてください"
            })
        }
    }
}

/// Answers a request of a client: checks it, then asks the screen (a read, a write and a post) or tells the screens (a change). `emit` is how the screens are told.
pub async fn handle(
    pending: &Pending,
    emit: impl Fn(Event) -> Result<(), String>,
    rules: &Rules,
    request: Request,
) -> ScreenAnswer {
    if let Err(e) = check(&request, rules) {
        return ScreenAnswer::failed(e);
    }
    match request {
        Request::Changed { what } => match emit(Event::Changed(what)) {
            Ok(()) => ScreenAnswer::done(),
            Err(e) => ScreenAnswer::failed(e),
        },
        Request::Read { target } => {
            ask(
                pending,
                &emit,
                rules.wait,
                ScreenOp::Read,
                target,
                Fields::new(),
            )
            .await
        }
        Request::Write { target, fields } => {
            ask(pending, &emit, rules.wait, ScreenOp::Write, target, fields).await
        }
        Request::Post { target } => {
            ask(
                pending,
                &emit,
                rules.post_wait,
                ScreenOp::Post,
                target,
                Fields::new(),
            )
            .await
        }
    }
}

/// A screen's answer to an ask (a late one, after the wait, is dropped).
#[tauri::command]
pub fn screen_bridge_answer(pending: State<'_, Pending>, id: u32, answer: ScreenAnswer) {
    pending.answer(id, answer);
}

// ---- the lines ----

/// Reads one line (without its end) of at most `MAX_LINE` bytes.
async fn read_line(read: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut reader = tokio::io::BufReader::new(read.take(MAX_LINE as u64 + 1));
    let mut line = Vec::new();
    let n = reader
        .read_until(b'\n', &mut line)
        .await
        .map_err(|e| format!("読めませんでした: {e}"))?;
    if n == 0 {
        return Err("接続が閉じました".to_owned());
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.len() > MAX_LINE {
        return Err("文が大きすぎます".to_owned());
    }
    Ok(line)
}

/// The line of an answer, with its end; an answer over `MAX_LINE` is replaced by an error.
fn line_of(answer: &ScreenAnswer) -> Vec<u8> {
    let mut line = serde_json::to_vec(answer).unwrap_or_default();
    if line.len() >= MAX_LINE {
        line =
            serde_json::to_vec(&ScreenAnswer::failed("欄の文が大きすぎます")).unwrap_or_default();
    }
    line.push(b'\n');
    line
}

pub fn socket_path(dir: &Path) -> PathBuf {
    dir.join(SOCKET_FILE)
}

// ---- the client (tsunagiai-mcp) ----

/// Checks the request and sends it to the app. A read answers the fields, a post the fields that say what the screen did (`state`), a write and a change an empty list. Every failure is a Japanese message: the app is not running, it did not answer in time, the screen is not open, the request was refused.
pub async fn request_app(dir: &Path, request: &Request) -> Result<Fields, String> {
    check(request, &RULES)?;
    let limit = match request {
        Request::Post { .. } => POST_CALL_TIMEOUT,
        _ => CALL_TIMEOUT,
    };
    call(dir, request, limit).await
}

#[cfg(unix)]
async fn call(dir: &Path, request: &Request, limit: Duration) -> Result<Fields, String> {
    let path = socket_path(dir);
    let work = async {
        let stream = UnixStream::connect(&path)
            .await
            .map_err(|_| NOT_RUNNING.to_owned())?;
        let (read, mut write) = stream.into_split();
        let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        line.push(b'\n');
        write
            .write_all(&line)
            .await
            .map_err(|_| "つなぎAIに送れませんでした".to_owned())?;
        let answer = read_line(read)
            .await
            .map_err(|e| format!("つなぎAIの答えを読めませんでした（{e}）"))?;
        serde_json::from_slice::<ScreenAnswer>(&answer)
            .map_err(|_| "つなぎAIの答えを読めませんでした".to_owned())
    };
    timeout(limit, work)
        .await
        .map_err(|_| "つなぎAIが時間内に答えませんでした".to_owned())??
        .into_result()
}

#[cfg(not(unix))]
async fn call(_: &Path, _: &Request, _: Duration) -> Result<Fields, String> {
    Err("この OS では、つなぎAIの画面の欄を読み書きできません".to_owned())
}

// ---- the server (the app) ----

/// Opens the socket at `path`: a stale socket file of an earlier start is removed (a file that is not a socket is never removed), and the new file is mode 0600, so only its owner can connect. Call it inside the async runtime.
#[cfg(unix)]
pub fn bind(path: &Path) -> Result<UnixListener, String> {
    use std::{
        fs,
        os::unix::fs::{FileTypeExt, PermissionsExt},
    };
    if path.as_os_str().len() > MAX_SOCKET_PATH {
        return Err(format!("ソケットの場所が長すぎます（{}）", path.display()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("{} を作れません: {e}", parent.display()))?;
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket() => fs::remove_file(path)
            .map_err(|e| format!("古いソケット {} を消せません: {e}", path.display()))?,
        Ok(_) => {
            return Err(format!(
                "{} にソケット以外のファイルがあります",
                path.display()
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{} を調べられません: {e}", path.display())),
    }
    let listener = UnixListener::bind(path)
        .map_err(|e| format!("ソケット {} を開けません: {e}", path.display()))?;
    if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
        let _ = fs::remove_file(path);
        return Err(format!("ソケットの権限を決められません: {e}"));
    }
    Ok(listener)
}

/// Serves the connections of `listener` until the task ends: each one is one request line and one answer line, and `handler` answers the request.
#[cfg(unix)]
pub async fn serve<F, Fut>(listener: UnixListener, handler: F)
where
    F: Fn(Request) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = ScreenAnswer> + Send + 'static,
{
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(serve_one(stream, handler.clone()));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

#[cfg(unix)]
async fn serve_one<F, Fut>(stream: UnixStream, handler: F)
where
    F: Fn(Request) -> Fut,
    Fut: Future<Output = ScreenAnswer>,
{
    let (read, mut write) = stream.into_split();
    let answer = match timeout(REQUEST_TIMEOUT, read_line(read)).await {
        Err(_) => ScreenAnswer::failed("要求が時間内に届きませんでした"),
        Ok(Err(e)) => ScreenAnswer::failed(format!("要求を読めませんでした（{e}）")),
        Ok(Ok(line)) => match serde_json::from_slice::<Request>(&line) {
            Ok(request) => handler(request).await,
            Err(_) => ScreenAnswer::failed("要求を読めませんでした"),
        },
    };
    let _ = write.write_all(&line_of(&answer)).await;
    let _ = write.shutdown().await;
}

fn emit_event(app: &AppHandle, event: Event) -> Result<(), String> {
    match event {
        Event::Ask(ask) => app.emit(ASK_EVENT, ask),
        Event::Changed(what) => app.emit(CHANGED_EVENT, what),
    }
    .map_err(|e| e.to_string())
}

/// Starts the socket of the app in `dir` (the config folder). A failure is logged and the app goes on without it.
#[cfg(unix)]
pub fn start(app: AppHandle, dir: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let listener = match bind(&socket_path(&dir)) {
            Ok(listener) => listener,
            Err(e) => {
                gmail::log_failure("screen_bridge", "-", e);
                return;
            }
        };
        serve(listener, move |request| {
            let app = app.clone();
            async move {
                let pending = app.state::<Pending>();
                handle(&pending, |event| emit_event(&app, event), &RULES, request).await
            }
        })
        .await;
    });
}

#[cfg(not(unix))]
pub fn start(_: AppHandle, _: PathBuf) {}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    const LISTED: Rules = Rules {
        targets: &["slack-compose", "mail-reply"],
        changes: &["todo"],
        wait: Duration::from_millis(300),
        post_wait: Duration::from_millis(600),
    };

    fn read(target: &str) -> Request {
        Request::Read {
            target: target.into(),
        }
    }

    fn write(target: &str, fields: &[(&str, &str)]) -> Request {
        Request::Write {
            target: target.into(),
            fields: fields
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
        }
    }

    fn post(target: &str) -> Request {
        Request::Post {
            target: target.into(),
        }
    }

    #[test]
    fn a_request_is_one_json_object_tagged_by_its_op() {
        let parse = |text: &str| serde_json::from_str::<Request>(text);
        assert_eq!(
            parse(r#"{"op":"read","target":"slack-compose"}"#).unwrap(),
            read("slack-compose")
        );
        assert_eq!(
            parse(r#"{"op":"write","target":"slack-compose","fields":{"text":"a\nb"}}"#).unwrap(),
            write("slack-compose", &[("text", "a\nb")])
        );
        assert_eq!(
            parse(r#"{"op":"post","target":"slack-compose"}"#).unwrap(),
            post("slack-compose")
        );
        assert_eq!(
            parse(r#"{"op":"changed","what":"todo"}"#).unwrap(),
            Request::Changed {
                what: "todo".into()
            }
        );
        for bad in [
            r#"{"op":"delete","target":"x"}"#,
            r#"{"target":"x"}"#,
            r#"{"op":"read"}"#,
            r#"{"op":"post"}"#,
            r#"{"op":"post","target":"x","fields":{}}"#,
            r#"{"op":"read","target":"x","extra":1}"#,
            r#"{"op":"write","target":"x","fields":{"a":1}}"#,
            "not json",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        let line = serde_json::to_string(&write("t", &[("a", "b")])).unwrap();
        assert_eq!(line, r#"{"op":"write","target":"t","fields":{"a":"b"}}"#);
    }

    #[test]
    fn an_answer_leaves_out_what_it_does_not_hold() {
        let text = |a: &ScreenAnswer| serde_json::to_string(a).unwrap();
        assert_eq!(text(&ScreenAnswer::done()), r#"{"ok":true}"#);
        assert_eq!(
            text(&ScreenAnswer::failed("だめ")),
            r#"{"ok":false,"error":"だめ"}"#
        );
        let answer: ScreenAnswer =
            serde_json::from_str(r#"{"ok":true,"fields":{"text":"a"}}"#).unwrap();
        assert_eq!(answer.into_result().unwrap()["text"], "a");
        assert_eq!(
            serde_json::from_str::<ScreenAnswer>(r#"{"ok":true}"#)
                .unwrap()
                .into_result()
                .unwrap(),
            Fields::new()
        );
        assert_eq!(
            ScreenAnswer::failed("だめ").into_result().unwrap_err(),
            "だめ"
        );
        assert!(ScreenAnswer::default().into_result().is_err());
    }

    #[test]
    fn a_target_must_be_in_the_list() {
        assert!(check(&read("slack-compose"), &LISTED).is_ok());
        assert!(check(&write("mail-reply", &[("body", "x")]), &LISTED).is_ok());
        let error = check(&read("todo"), &LISTED).unwrap_err();
        assert!(error.contains("slack-compose、mail-reply"), "{error}");
        // A post names a target of the list too.
        assert!(check(&post("slack-compose"), &LISTED).is_ok());
        assert!(check(&post("todo"), &LISTED).is_err());
        // The list the app has now holds the Slack compose screen only.
        assert!(check(&read("slack-compose"), &RULES).is_ok());
        assert!(check(&post("slack-compose"), &RULES).is_ok());
        assert!(check(&write("slack-compose", &[("a", "b")]), &RULES).is_ok());
        assert_eq!(
            RULES.targets,
            [
                "slack-compose",
                "calendar-slots",
                "calendar-form",
                "todo-prompt",
                "todo-draft",
                "slack-thread",
                "slack-channel",
                "mail-draft"
            ]
        );
        // The candidates of free time (C-6, #1063): a read and a write, no post.
        assert!(check(&read("calendar-slots"), &RULES).is_ok());
        assert!(check(&write("calendar-slots", &[("slot1", "a/b")]), &RULES).is_ok());
        // The form of an event that Claude fills in (C-6): the owner saves it.
        assert!(check(
            &write("calendar-form", &[("form", "{}"), ("description", "d")]),
            &RULES
        )
        .is_ok());
        assert!(check(&read("mail-reply"), &RULES).is_err());
        assert!(check(&post("mail-reply"), &RULES).is_err());
    }

    #[test]
    fn names_have_a_shape_before_they_are_looked_up() {
        let long = "a".repeat(33);
        for bad in ["", "Slack", "a b", "../x", "あ", "a.b", long.as_str()] {
            assert!(check(&read(bad), &LISTED).is_err(), "{bad}");
            assert!(
                check(&write("slack-compose", &[(bad, "x")]), &LISTED).is_err(),
                "{bad}"
            );
            assert!(
                check(&Request::Changed { what: bad.into() }, &LISTED).is_err(),
                "{bad}"
            );
        }
        assert!(check(&write("slack-compose", &[("a_b-1", "x")]), &LISTED).is_ok());
        assert!(check(&write("slack-compose", &[(&"a".repeat(32), "x")]), &LISTED).is_ok());
    }

    #[test]
    fn a_write_needs_fields_and_each_text_has_a_length() {
        assert!(check(&write("slack-compose", &[]), &LISTED).is_err());
        let ok = "あ".repeat(MAX_TEXT);
        assert!(check(&write("slack-compose", &[("text", &ok)]), &LISTED).is_ok());
        let long = "あ".repeat(MAX_TEXT + 1);
        let error = check(&write("slack-compose", &[("text", &long)]), &LISTED).unwrap_err();
        assert!(
            error.contains("10000") && error.contains("10001"),
            "{error}"
        );
        let names: Vec<String> = (0..=MAX_FIELDS).map(|i| format!("f{i}")).collect();
        let many: Vec<(&str, &str)> = names.iter().map(|n| (n.as_str(), "x")).collect();
        assert!(check(&write("slack-compose", &many[..MAX_FIELDS]), &LISTED).is_ok());
        assert!(check(&write("slack-compose", &many), &LISTED).is_err());
    }

    #[test]
    fn a_change_must_be_one_of_the_names() {
        let changed = |what: &str| Request::Changed { what: what.into() };
        assert!(check(&changed("todo"), &LISTED).is_ok());
        assert!(check(&changed("mail"), &LISTED).is_err());
        assert!(check(&changed("todo"), &RULES).is_ok());
        assert!(check(&changed("calendar"), &RULES).is_ok());
        assert!(check(&changed("calendar-shown"), &RULES).is_ok());
        assert!(check(&changed("skills"), &RULES).is_ok());
        assert!(check(&changed("skills"), &LISTED).is_err());
        assert!(check(&changed("calendar"), &LISTED).is_err());
    }

    #[test]
    fn an_answer_goes_to_the_ask_that_waits_and_only_once() {
        let pending = Pending::default();
        let (a, mut a_receiver) = pending.register();
        let (b, _b_receiver) = pending.register();
        assert_ne!(a, b);
        assert!(pending.answer(a, ScreenAnswer::done()));
        assert_eq!(a_receiver.try_recv().unwrap(), ScreenAnswer::done());
        assert!(!pending.answer(a, ScreenAnswer::done()));
        pending.forget(b);
        assert!(!pending.answer(b, ScreenAnswer::done()));
    }

    type Seen = Arc<Mutex<Vec<Event>>>;

    /// An emit that records what the screens were told, and answers each ask as the screen would (after a moment).
    fn screen(
        pending: &Arc<Pending>,
        reply: Option<ScreenAnswer>,
    ) -> (Seen, impl Fn(Event) -> Result<(), String> + Clone) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (log, pending) = (Arc::clone(&seen), Arc::clone(pending));
        let emit = move |event: Event| {
            log.lock().unwrap().push(event.clone());
            if let (Event::Ask(ask), Some(reply)) = (event, reply.clone()) {
                let pending = Arc::clone(&pending);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    pending.answer(ask.id, reply);
                });
            }
            Ok(())
        };
        (seen, emit)
    }

    #[tokio::test]
    async fn a_read_asks_the_screen_and_answers_what_it_holds() {
        let pending = Arc::new(Pending::default());
        let reply = ScreenAnswer {
            ok: true,
            fields: Some([("text".to_owned(), "draft".to_owned())].into()),
            error: None,
        };
        let (seen, emit) = screen(&pending, Some(reply.clone()));
        let answer = handle(&pending, emit, &LISTED, read("slack-compose")).await;
        assert_eq!(answer, reply);
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            [Event::Ask(ScreenAsk {
                id: 0,
                op: ScreenOp::Read,
                target: "slack-compose".into(),
                fields: Fields::new(),
            })]
        );
    }

    #[tokio::test]
    async fn a_post_asks_the_screen_to_do_what_its_button_does_and_answers_what_it_did() {
        let pending = Arc::new(Pending::default());
        let reply = ScreenAnswer {
            ok: true,
            fields: Some([("state".to_owned(), "posted".to_owned())].into()),
            error: None,
        };
        let (seen, emit) = screen(&pending, Some(reply.clone()));
        let answer = handle(&pending, emit, &LISTED, post("slack-compose")).await;
        assert_eq!(answer, reply);
        {
            let seen = seen.lock().unwrap();
            let Event::Ask(ask) = &seen[0] else {
                panic!("{seen:?}")
            };
            assert_eq!((ask.op, ask.fields.len()), (ScreenOp::Post, 0));
            let json = serde_json::to_value(ask).unwrap();
            assert_eq!(json["op"], "post");
        }
        // The screen's refusal is the answer, and a target that is not listed asks no screen.
        let (seen, emit) = screen(&pending, Some(ScreenAnswer::failed("投稿できません")));
        let answer = handle(&pending, emit.clone(), &LISTED, post("slack-compose")).await;
        assert_eq!(answer, ScreenAnswer::failed("投稿できません"));
        let before = seen.lock().unwrap().len();
        assert!(!handle(&pending, emit, &LISTED, post("todo")).await.ok);
        assert_eq!(seen.lock().unwrap().len(), before);
    }

    #[tokio::test]
    async fn a_post_waits_longer_than_a_read_and_never_tells_the_owner_to_try_again() {
        let pending = Arc::new(Pending::default());
        // The screen answers after 450 ms: a read (300 ms) is too late, a post (600 ms) is not.
        let late = |pending: &Arc<Pending>| {
            let pending = Arc::clone(pending);
            move |event: Event| {
                if let Event::Ask(ask) = event {
                    let pending = Arc::clone(&pending);
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(450)).await;
                        pending.answer(ask.id, ScreenAnswer::done());
                    });
                }
                Ok(())
            }
        };
        let read_answer = handle(&pending, late(&pending), &LISTED, read("slack-compose")).await;
        assert!(read_answer.error.unwrap().contains("時間内"));
        let post_answer = handle(&pending, late(&pending), &LISTED, post("slack-compose")).await;
        assert_eq!(post_answer, ScreenAnswer::done());
        // A screen that never answers a post: the words say to look at the screen.
        let (_, emit) = screen(&pending, None);
        let none = handle(&pending, emit, &LISTED, post("slack-compose")).await;
        let error = none.error.unwrap();
        assert!(
            error.contains("投稿の結果") && error.contains("確かめて"),
            "{error}"
        );
        assert!(!pending.answer(3, ScreenAnswer::done()));
    }

    #[tokio::test]
    async fn a_write_gives_the_screen_the_fields_and_answers_its_word() {
        let pending = Arc::new(Pending::default());
        let (seen, emit) = screen(&pending, Some(ScreenAnswer::done()));
        let answer = handle(
            &pending,
            emit,
            &LISTED,
            write("slack-compose", &[("text", "new")]),
        )
        .await;
        assert_eq!(answer, ScreenAnswer::done());
        let seen = seen.lock().unwrap();
        let Event::Ask(ask) = &seen[0] else {
            panic!("{seen:?}")
        };
        assert_eq!(
            (ask.op, ask.fields["text"].as_str()),
            (ScreenOp::Write, "new")
        );
        // The event the screen reads is {id, op, target, fields}.
        let json = serde_json::to_value(ask).unwrap();
        assert_eq!(json["op"], "write");
        assert_eq!(json["fields"]["text"], "new");
    }

    #[tokio::test]
    async fn the_screens_error_is_the_answer() {
        let pending = Arc::new(Pending::default());
        let (_, emit) = screen(&pending, Some(ScreenAnswer::failed("画面が開いていません")));
        let answer = handle(&pending, emit, &LISTED, read("slack-compose")).await;
        assert_eq!(answer, ScreenAnswer::failed("画面が開いていません"));
    }

    #[tokio::test]
    async fn a_screen_that_does_not_answer_ends_in_an_error_and_leaves_nothing_waiting() {
        let pending = Arc::new(Pending::default());
        let (_, emit) = screen(&pending, None);
        let answer = handle(&pending, emit, &LISTED, read("slack-compose")).await;
        assert!(!answer.ok);
        assert!(answer.error.unwrap().contains("時間内"));
        assert!(!pending.answer(0, ScreenAnswer::done()));
    }

    #[tokio::test]
    async fn a_refused_request_asks_no_screen() {
        let pending = Arc::new(Pending::default());
        let (seen, emit) = screen(&pending, Some(ScreenAnswer::done()));
        for request in [
            read("todo"),
            write("slack-compose", &[]),
            Request::Changed { what: "x".into() },
        ] {
            assert!(!handle(&pending, emit.clone(), &LISTED, request).await.ok);
        }
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_emit_is_an_error_and_leaves_nothing_waiting() {
        let pending = Pending::default();
        let answer = handle(
            &pending,
            |_| Err("送れません".to_owned()),
            &LISTED,
            read("slack-compose"),
        )
        .await;
        assert_eq!(answer, ScreenAnswer::failed("送れません"));
        assert!(!pending.answer(0, ScreenAnswer::done()));
    }

    #[tokio::test]
    async fn a_change_tells_the_screens_and_waits_for_nobody() {
        let pending = Arc::new(Pending::default());
        let (seen, emit) = screen(&pending, None);
        let answer = handle(
            &pending,
            emit,
            &LISTED,
            Request::Changed {
                what: "todo".into(),
            },
        )
        .await;
        assert_eq!(answer, ScreenAnswer::done());
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            [Event::Changed("todo".into())]
        );
    }

    #[test]
    fn an_answer_over_the_limit_is_replaced_by_an_error() {
        let big = ScreenAnswer {
            ok: true,
            fields: Some([("text".to_owned(), "x".repeat(MAX_LINE))].into()),
            error: None,
        };
        let line = line_of(&big);
        assert!(line.len() < 1000 && line.ends_with(b"\n"));
        let answer: ScreenAnswer = serde_json::from_slice(&line).unwrap();
        assert!(!answer.ok);
        assert_eq!(line_of(&ScreenAnswer::done()), b"{\"ok\":true}\n");
    }

    #[tokio::test]
    async fn a_line_is_read_up_to_its_end_and_up_to_the_limit() {
        assert_eq!(read_line(&b"abc\nrest"[..]).await.unwrap(), b"abc");
        assert_eq!(read_line(&b"abc"[..]).await.unwrap(), b"abc");
        assert!(read_line(&b""[..]).await.is_err());
        let mut long = vec![b'x'; MAX_LINE + 1];
        assert!(read_line(&long[..]).await.is_err());
        long.truncate(MAX_LINE);
        long.push(b'\n');
        assert_eq!(read_line(&long[..]).await.unwrap().len(), MAX_LINE);
    }

    #[cfg(unix)]
    mod socket {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// A folder of its own, near the root of the temporary folder: the path of a socket is short.
        fn folder(name: &str) -> PathBuf {
            let base = std::env::temp_dir();
            let base = if base.as_os_str().len() > 50 {
                PathBuf::from("/tmp")
            } else {
                base
            };
            let dir = base.join(format!("sb-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// A server that answers each request with `answer`, and the folder it listens in.
        fn server(
            name: &str,
            answer: impl Fn(Request) -> ScreenAnswer + Clone + Send + 'static,
        ) -> PathBuf {
            let dir = folder(name);
            let listener = bind(&socket_path(&dir)).unwrap();
            tokio::spawn(serve(listener, move |request| {
                let answer = answer.clone();
                async move { answer(request) }
            }));
            dir
        }

        const SECOND: Duration = Duration::from_secs(1);

        #[tokio::test]
        async fn the_socket_is_for_its_owner_only() {
            let dir = folder("mode");
            let _listener = bind(&socket_path(&dir)).unwrap();
            let mode = std::fs::metadata(socket_path(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        #[tokio::test]
        async fn a_stale_socket_is_replaced_and_another_file_is_not() {
            let dir = folder("stale");
            let path = socket_path(&dir);
            drop(bind(&path).unwrap());
            assert!(path.exists(), "a closed listener leaves its file");
            let _listener = bind(&path).unwrap();
            let other = folder("other");
            let file = socket_path(&other);
            std::fs::write(&file, "keep").unwrap();
            assert!(bind(&file).unwrap_err().contains("ソケット以外"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep");
        }

        #[tokio::test]
        async fn the_folder_is_made_and_a_path_that_is_too_long_is_refused() {
            let dir = folder("made").join("inner");
            let _listener = bind(&socket_path(&dir)).unwrap();
            assert!(socket_path(&dir).exists());
            let long = folder("long").join("x".repeat(100));
            assert!(bind(&socket_path(&long)).unwrap_err().contains("長すぎ"));
            assert!(!long.exists());
        }

        #[tokio::test]
        async fn a_call_goes_over_the_socket_and_the_fields_come_back() {
            let dir = server("round", |request| match request {
                Request::Read { target } => ScreenAnswer {
                    ok: true,
                    fields: Some([("target".to_owned(), target)].into()),
                    error: None,
                },
                Request::Write { fields, .. } if fields["text"] == "bad" => {
                    ScreenAnswer::failed("画面が開いていません")
                }
                _ => ScreenAnswer::done(),
            });
            let read = call(&dir, &read("slack-compose"), SECOND).await.unwrap();
            assert_eq!(read["target"], "slack-compose");
            let wrote = call(&dir, &write("slack-compose", &[("text", "ok")]), SECOND).await;
            assert_eq!(wrote.unwrap(), Fields::new());
            let failed = call(&dir, &write("slack-compose", &[("text", "bad")]), SECOND).await;
            assert_eq!(failed.unwrap_err(), "画面が開いていません");
            let changed = Request::Changed {
                what: "todo".into(),
            };
            assert!(call(&dir, &changed, SECOND).await.is_ok());
        }

        #[tokio::test]
        async fn the_whole_way_from_a_call_to_the_screen_and_back() {
            let dir = folder("whole");
            let listener = bind(&socket_path(&dir)).unwrap();
            let pending = Arc::new(Pending::default());
            let (seen, emit) = screen(
                &pending,
                Some(ScreenAnswer {
                    ok: true,
                    fields: Some([("text".to_owned(), "held".to_owned())].into()),
                    error: None,
                }),
            );
            let handler_pending = Arc::clone(&pending);
            tokio::spawn(serve(listener, move |request| {
                let (pending, emit) = (Arc::clone(&handler_pending), emit.clone());
                async move { handle(&pending, emit, &LISTED, request).await }
            }));
            let fields = call(&dir, &read("slack-compose"), SECOND).await.unwrap();
            assert_eq!(fields["text"], "held");
            let refused = call(&dir, &read("nowhere"), SECOND).await.unwrap_err();
            assert!(refused.contains("slack-compose"));
            assert_eq!(seen.lock().unwrap().len(), 1);
        }

        #[tokio::test]
        async fn an_app_that_is_not_running_is_a_japanese_error() {
            let dir = folder("none");
            let error = call(&dir, &read("slack-compose"), SECOND)
                .await
                .unwrap_err();
            assert_eq!(error, NOT_RUNNING);
            // A socket file that nobody listens on (the app was killed) is the same.
            drop(bind(&socket_path(&dir)).unwrap());
            let error = call(&dir, &read("slack-compose"), SECOND)
                .await
                .unwrap_err();
            assert_eq!(error, NOT_RUNNING);
            // A request that the list refuses never reaches the socket.
            let error = request_app(&dir, &read("nowhere")).await.unwrap_err();
            assert!(error.contains("slack-compose"), "{error}");
            let error = request_app(&dir, &post("nowhere")).await.unwrap_err();
            assert!(error.contains("slack-compose"), "{error}");
        }

        #[tokio::test]
        async fn an_app_that_does_not_answer_ends_the_call_by_the_time_limit() {
            let dir = folder("slow");
            let listener = bind(&socket_path(&dir)).unwrap();
            tokio::spawn(serve(listener, |_| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                ScreenAnswer::done()
            }));
            let error = call(&dir, &read("slack-compose"), Duration::from_millis(100))
                .await
                .unwrap_err();
            assert!(error.contains("時間内"), "{error}");
        }

        #[tokio::test]
        async fn a_line_that_is_not_a_request_is_answered_with_an_error() {
            use tokio::io::AsyncWriteExt;
            let dir = server("garbage", |_| ScreenAnswer::done());
            for body in [&b"not json\n"[..], &b"{\"op\":\"read\"}\n"[..]] {
                let stream = UnixStream::connect(socket_path(&dir)).await.unwrap();
                let (read, mut write) = stream.into_split();
                write.write_all(body).await.unwrap();
                let answer: ScreenAnswer =
                    serde_json::from_slice(&read_line(read).await.unwrap()).unwrap();
                assert!(!answer.ok);
            }
            // A line over the limit is refused, and the server keeps serving.
            let stream = UnixStream::connect(socket_path(&dir)).await.unwrap();
            let (reader, mut write) = stream.into_split();
            let _ = write.write_all(&vec![b'x'; MAX_LINE + 10]).await;
            let answer: ScreenAnswer =
                serde_json::from_slice(&read_line(reader).await.unwrap()).unwrap();
            assert!(!answer.ok);
            assert!(call(&dir, &read("a"), SECOND).await.is_ok());
        }
    }
}
