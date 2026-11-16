//! A-34: the Language Server Protocol as `lsp::server` speaks it with ruby-lsp, as pure functions: the frame (`Content-Length`), the messages, the state that `$/progress` gives, the paths of the server and of the worktree, and the answer to a definition.
//! What comes from the server is not trusted. A frame has a limit, a header that cannot be read ends the stream (there is no way to find the next frame), a body that is not JSON is dropped (its length was read, so the stream stays in step), and an answer that cannot be read is no location.
//! A position is of the unit the client asked for: UTF-16 (`initialize_params`), which is the unit of the index of a JavaScript string, so a position is passed on as it is.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};
#[cfg(test)]
use ts_rs::TS;

use crate::lsp::trimmed;

/// The longest body of a frame that is read: a larger one is an error, and the server is stopped.
pub(crate) const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_HEADER_LINE: usize = 1024;
const MAX_HEADERS: usize = 16;
/// The most locations of one answer that are kept.
const MAX_LOCATIONS: usize = 100;
/// The most `$/progress` tokens that are open at once that are counted.
const MAX_TOKENS: usize = 64;
/// The longest message of an error of the server that is shown.
const MAX_ERROR: usize = 200;
/// The longest relative path of a worktree that is sent to the server.
const MAX_PATH: usize = 4096;
const METHOD_NOT_FOUND: i64 = -32601;

const BROKEN: &str = "ruby-lsp の出力を読めません";
const BAD_HEADER: &str = "ruby-lsp の枠のヘッダーが正しくありません";
const NO_LENGTH: &str = "ruby-lsp の枠に長さがありません";
const TOO_LONG: &str = "ruby-lsp の枠が大きすぎます";
const CUT: &str = "ruby-lsp の枠が途中で終わりました";
const BAD_PATH: &str = "ファイルのパスが正しくありません";

// ---- the frame ----

/// One message as the bytes that go to the server: the header with the length of the body in bytes, then the body.
pub(crate) fn encode(message: &Value) -> Vec<u8> {
    let body = message.to_string();
    let mut bytes = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

/// What `read_frame` read: a message, or a frame whose body is not JSON (dropped).
#[derive(Debug, PartialEq)]
pub(crate) enum Frame {
    Message(Value),
    Unreadable,
}

/// The header of a frame as the value of its `Content-Length` (every other header is passed over).
fn length_of(line: &str, found: Option<usize>) -> Result<Option<usize>, String> {
    let (name, value) = line.split_once(':').ok_or(BAD_HEADER)?;
    if !name.trim().eq_ignore_ascii_case("content-length") {
        return Ok(found);
    }
    let value = value.trim();
    if found.is_some()
        || value.is_empty()
        || value.len() > 10
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(BAD_HEADER.into());
    }
    Ok(Some(value.parse().map_err(|_| BAD_HEADER)?))
}

/// Reads one frame. `None` is the end of the stream between two frames; the end inside a frame, a header that cannot be read, no length and a length over `MAX_FRAME` are errors, after which the stream is no more read. The body is read as it comes, never allocated for the length that the server said.
pub(crate) async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Frame>, String> {
    let mut length = None;
    let mut lines = 0;
    loop {
        let mut line = Vec::new();
        let n = (&mut *reader)
            .take(MAX_HEADER_LINE as u64 + 1)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| BROKEN)?;
        if n == 0 {
            return if lines == 0 {
                Ok(None)
            } else {
                Err(CUT.into())
            };
        }
        // A line with no end is the end of the stream, or one past the limit.
        if line.last() != Some(&b'\n') {
            return Err(if n > MAX_HEADER_LINE { BAD_HEADER } else { CUT }.into());
        }
        lines += 1;
        if lines > MAX_HEADERS {
            return Err(BAD_HEADER.into());
        }
        let text = std::str::from_utf8(&line)
            .map_err(|_| BAD_HEADER)?
            .trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            break;
        }
        length = length_of(text, length)?;
    }
    let length = length.ok_or(NO_LENGTH)?;
    if length > MAX_FRAME {
        return Err(TOO_LONG.into());
    }
    let mut body = Vec::new();
    (&mut *reader)
        .take(length as u64)
        .read_to_end(&mut body)
        .await
        .map_err(|_| BROKEN)?;
    if body.len() != length {
        return Err(CUT.into());
    }
    Ok(Some(match serde_json::from_slice(&body) {
        Ok(message) => Frame::Message(message),
        Err(_) => Frame::Unreadable,
    }))
}

// ---- the messages ----

pub(crate) fn request(id: i64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

pub(crate) fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

/// The answer to a request of the server, `id` being the one it sent (a number or a text).
pub(crate) fn response(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub(crate) fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// The parameters of `initialize`: the worktree as the server sees it (`root_uri`) is its root. The client asks for UTF-16 positions, says that it shows the progress of the server (ruby-lsp sends its indexing only to a client that does), and takes the answer to a definition as a `Location` or a `LocationLink`. No process id is given: the server runs in a container or on another machine.
pub(crate) fn initialize_params(root_uri: &str) -> Value {
    json!({
        "processId": null,
        "clientInfo": {"name": "tsunagiai"},
        "rootUri": root_uri,
        "workspaceFolders": [{"uri": root_uri, "name": "worktree"}],
        "capabilities": {
            "general": {"positionEncodings": ["utf-16"]},
            "window": {"workDoneProgress": true},
            "textDocument": {
                "synchronization": {"dynamicRegistration": false},
                "definition": {"dynamicRegistration": false, "linkSupport": true},
            },
        },
    })
}

/// A message of the server, told by its keys.
#[derive(Debug, PartialEq)]
pub(crate) enum Incoming {
    /// The answer to a request of the client (`id` is a number: the client sends no other). An error is its message, with no control character and cut.
    Response {
        id: i64,
        result: Result<Value, String>,
    },
    /// A request of the server to the client, which wants an answer with the same `id`.
    Request {
        id: Value,
        method: String,
    },
    Notification {
        method: String,
        params: Value,
    },
    Other,
}

fn error_text(error: &Value) -> String {
    let text: String = error["message"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_ERROR)
        .collect();
    if text.is_empty() {
        "エラーが返りました".to_owned()
    } else {
        text
    }
}

pub(crate) fn classify(message: &Value) -> Incoming {
    let method = message["method"].as_str().map(str::to_owned);
    let id = message
        .get("id")
        .filter(|id| id.is_string() || id.is_number())
        .cloned();
    match (method, id) {
        (Some(method), Some(id)) => Incoming::Request { id, method },
        (Some(method), None) if message.get("id").is_none() => Incoming::Notification {
            method,
            params: message["params"].clone(),
        },
        (None, Some(id)) => match id.as_i64() {
            Some(id) => Incoming::Response {
                id,
                result: match message.get("error") {
                    Some(error) => Err(error_text(error)),
                    None => Ok(message["result"].clone()),
                },
            },
            None => Incoming::Other,
        },
        _ => Incoming::Other,
    }
}

/// The answer to a request of the server: `null` to those that ask the client to accept a progress or a registration, and "method not found" to every other.
pub(crate) fn answer_request(method: &str) -> Result<Value, (i64, &'static str)> {
    match method {
        "window/workDoneProgress/create"
        | "client/registerCapability"
        | "client/unregisterCapability" => Ok(Value::Null),
        _ => Err((METHOD_NOT_FOUND, "method not found")),
    }
}

// ---- the state from the progress ----

/// The progress of the server, from its `$/progress` notifications. Indexing is from the first `begin` to the `end` of every token that began; a server that has shown no progress is taken as indexing until `grace_over` (the time it was given to begin), so that a state is not "running" in the moment before the first `begin`.
#[derive(Default)]
pub(crate) struct Progress {
    open: HashSet<String>,
    began: bool,
    grace_over: bool,
}

impl Progress {
    /// The `params` of one `$/progress`. What cannot be read changes nothing.
    pub(crate) fn apply(&mut self, params: &Value) {
        let token = match &params["token"] {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            _ => return,
        };
        match params["value"]["kind"].as_str() {
            Some("begin") => {
                self.began = true;
                if self.open.len() < MAX_TOKENS {
                    self.open.insert(token);
                }
            }
            Some("end") => {
                self.open.remove(&token);
            }
            _ => {}
        }
    }

    pub(crate) fn grace_over(&mut self) {
        self.grace_over = true;
    }

    pub(crate) fn is_indexing(&self) -> bool {
        !self.open.is_empty() || (!self.began && !self.grace_over)
    }

    #[cfg(test)]
    fn open(&self) -> usize {
        self.open.len()
    }
}

// ---- the paths ----

/// The URI of an absolute path: every byte but the letters, the digits and `-._~/` is `%` and two digits, so that no character of a path is read as another part of the URI.
pub(crate) fn uri_of(path: &str) -> String {
    let mut uri = String::from("file://");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// The absolute path of a `file:///` URI, decoded. Another scheme, a host, a query or a fragment, an escape that is not one, bytes that are not UTF-8 and a control character in the path are no path.
pub(crate) fn path_of(uri: &str) -> Option<String> {
    let encoded = uri.strip_prefix("file://")?;
    if !encoded.starts_with('/') || encoded.contains(['?', '#']) {
        return None;
    }
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let digits = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            decoded.push(u8::from_str_radix(digits, 16).ok()?);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    let path = String::from_utf8(decoded).ok()?;
    (!path.chars().any(char::is_control)).then_some(path)
}

/// An absolute path without its `.` and `..` segments and its double slashes (a `..` over the root stays at the root); `None` for a path that is not absolute. It is read by the text alone: a link is not followed.
pub(crate) fn normalize(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let mut kept: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                kept.pop();
            }
            _ => kept.push(segment),
        }
    }
    Some(format!("/{}", kept.join("/")))
}

/// The path that the server has for the file `relative` of the worktree (relative to the worktree's root, with `/` between its names), below `mount`, the path the worktree has where the server runs. A path that is empty, absolute, with an empty name, `.` or `..`, with a control character or too long is an error.
pub(crate) fn server_path(mount: &str, relative: &str) -> Result<String, String> {
    let bad = relative.is_empty()
        || relative.chars().count() > MAX_PATH
        || relative.chars().any(char::is_control)
        || relative
            .split('/')
            .any(|name| name.is_empty() || name == "." || name == "..");
    if bad {
        return Err(BAD_PATH.into());
    }
    let mount = trimmed(mount);
    Ok(if mount == "/" {
        format!("/{relative}")
    } else {
        format!("{mount}/{relative}")
    })
}

// ---- the answer to a definition ----

/// A place that the server gave as the definition. `path` is from the worktree when `outside` is false; when it is true it is the absolute path on the server's side (a gem, for example), and the worktree has nothing of it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub path: String,
    pub outside: bool,
    pub line: u32,
    pub character: u32,
}

fn position(range: &Value) -> Option<(u32, u32)> {
    let start = &range["start"];
    let number = |value: &Value| u32::try_from(value.as_u64()?).ok();
    Some((number(&start["line"])?, number(&start["character"])?))
}

/// One entry of the answer: a `Location` (`uri`, `range`) or a `LocationLink` (`targetUri`, and the range of the name, else of the whole target).
fn location_of(entry: &Value, mount: &str) -> Option<LspLocation> {
    let (uri, at) = match entry["targetUri"].as_str() {
        Some(uri) => (
            uri,
            position(&entry["targetSelectionRange"]).or_else(|| position(&entry["targetRange"]))?,
        ),
        None => (entry["uri"].as_str()?, position(&entry["range"])?),
    };
    let path = normalize(&path_of(uri)?)?;
    let mount = trimmed(mount);
    let below = if mount == "/" {
        path.strip_prefix('/')
    } else {
        path.strip_prefix(mount)
            .and_then(|rest| rest.strip_prefix('/'))
    };
    match below {
        // The mount itself is a folder, not a file.
        Some("") => None,
        Some(relative) => Some(LspLocation {
            path: relative.to_owned(),
            outside: false,
            line: at.0,
            character: at.1,
        }),
        None if path == mount => None,
        None => Some(LspLocation {
            path,
            outside: true,
            line: at.0,
            character: at.1,
        }),
    }
}

/// The places of the answer to `textDocument/definition` (`null`, one `Location`, or a list of `Location` and `LocationLink`), at most `MAX_LOCATIONS`, in the order of the server and each once. `mount` is the path the worktree has on the server's side. An entry that cannot be read is left out.
pub(crate) fn locations(result: &Value, mount: &str) -> Vec<LspLocation> {
    let entries: &[Value] = match result {
        Value::Array(list) => list,
        Value::Object(_) => std::slice::from_ref(result),
        _ => return Vec::new(),
    };
    let mut found: Vec<LspLocation> = Vec::new();
    for location in entries.iter().filter_map(|entry| location_of(entry, mount)) {
        if found.len() == MAX_LOCATIONS {
            break;
        }
        if !found.contains(&location) {
            found.push(location);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncWriteExt, BufReader};

    fn framed(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
    }

    async fn read_all(bytes: &[u8]) -> Vec<Result<Option<Frame>, String>> {
        let mut reader = BufReader::new(bytes);
        let mut all = Vec::new();
        loop {
            let one = read_frame(&mut reader).await;
            let stop = !matches!(one, Ok(Some(_)));
            all.push(one);
            if stop {
                return all;
            }
        }
    }

    // ---- the frame ----

    #[test]
    fn a_frame_has_the_length_of_its_bytes_not_of_its_characters() {
        let bytes = encode(&json!({"a": "あ"}));
        let text = String::from_utf8(bytes).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert_eq!(body, r#"{"a":"あ"}"#);
        assert_eq!(head, format!("Content-Length: {}", body.len()));
        assert_ne!(body.len(), body.chars().count());
    }

    #[tokio::test]
    async fn frames_are_read_one_after_the_other_and_the_end_of_the_stream_is_none() {
        let mut bytes = framed(r#"{"id":1}"#);
        bytes.extend(framed(r#"{"id":2}"#));
        let all = read_all(&bytes).await;
        assert_eq!(
            all,
            vec![
                Ok(Some(Frame::Message(json!({"id": 1})))),
                Ok(Some(Frame::Message(json!({"id": 2})))),
                Ok(None),
            ]
        );
    }

    #[tokio::test]
    async fn the_header_name_is_not_case_sensitive_and_other_headers_are_passed_over() {
        let bytes = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 2\r\n\r\n{}";
        assert_eq!(
            read_all(bytes).await,
            vec![Ok(Some(Frame::Message(json!({})))), Ok(None)]
        );
    }

    #[tokio::test]
    async fn a_body_that_is_not_json_is_dropped_and_the_next_frame_is_still_read() {
        let mut bytes = framed("not json");
        bytes.extend(framed(r#"{"ok":true}"#));
        assert_eq!(
            read_all(&bytes).await,
            vec![
                Ok(Some(Frame::Unreadable)),
                Ok(Some(Frame::Message(json!({"ok": true})))),
                Ok(None),
            ]
        );
    }

    #[tokio::test]
    async fn a_frame_that_arrives_in_pieces_is_read_whole() {
        let (mut tx, rx) = tokio::io::duplex(8);
        let bytes = framed(r#"{"method":"x","params":{"long":"aaaaaaaaaaaaaaaaaaaaaaaa"}}"#);
        let writer = tokio::spawn(async move {
            for piece in bytes.chunks(5) {
                tx.write_all(piece).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let mut reader = BufReader::new(rx);
        let got = read_frame(&mut reader).await.unwrap().unwrap();
        writer.await.unwrap();
        assert_eq!(
            got,
            Frame::Message(json!({"method":"x","params":{"long":"aaaaaaaaaaaaaaaaaaaaaaaa"}}))
        );
        assert_eq!(read_frame(&mut reader).await, Ok(None));
    }

    #[tokio::test]
    async fn a_length_over_the_limit_is_refused_before_anything_is_read() {
        let over = format!("Content-Length: {}\r\n\r\n", MAX_FRAME + 1);
        assert!(read_all(over.as_bytes()).await[0].is_err());
        // The longest frame is accepted up to its length: a cut one is an error, not a wait.
        let at = format!("Content-Length: {}\r\n\r\n{{}}", MAX_FRAME);
        assert!(read_all(at.as_bytes()).await[0].is_err());
    }

    #[tokio::test]
    async fn a_header_that_cannot_be_trusted_is_an_error() {
        let long = format!("X: {}\r\nContent-Length: 2\r\n\r\n{{}}", "a".repeat(2000));
        let many = format!("{}Content-Length: 2\r\n\r\n{{}}", "X: 1\r\n".repeat(40));
        let cases: Vec<&[u8]> = vec![
            b"\r\n{}",
            b"Content-Type: x\r\n\r\n{}",
            b"Content-Length: -1\r\n\r\n{}",
            b"Content-Length: +2\r\n\r\n{}",
            b"Content-Length: 2e0\r\n\r\n{}",
            b"Content-Length: \r\n\r\n{}",
            b"Content-Length: 99999999999999999999\r\n\r\n{}",
            b"Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
            b"no colon here\r\n\r\n{}",
            long.as_bytes(),
            many.as_bytes(),
        ];
        for case in cases {
            assert!(
                read_all(case).await[0].is_err(),
                "{}",
                String::from_utf8_lossy(&case[..case.len().min(40)])
            );
        }
    }

    #[tokio::test]
    async fn a_stream_that_ends_inside_a_frame_is_an_error_and_one_that_ends_between_frames_is_not()
    {
        assert!(read_all(b"Content-Length: 10\r\n\r\n{}").await[0].is_err());
        assert!(read_all(b"Content-Length: 10\r\n").await[0].is_err());
        assert!(read_all(b"Content-Len").await[0].is_err());
        assert_eq!(read_all(b"").await, vec![Ok(None)]);
    }

    // ---- the messages ----

    #[test]
    fn a_request_a_notification_and_a_response_have_the_shape_of_json_rpc() {
        assert_eq!(
            request(3, "textDocument/definition", json!({"a": 1})),
            json!({"jsonrpc": "2.0", "id": 3, "method": "textDocument/definition", "params": {"a": 1}})
        );
        assert_eq!(
            notification("initialized", json!({})),
            json!({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        );
        assert_eq!(
            response(&json!("srv-1"), Value::Null),
            json!({"jsonrpc": "2.0", "id": "srv-1", "result": null})
        );
        assert_eq!(
            error_response(&json!(7), -32601, "no"),
            json!({"jsonrpc": "2.0", "id": 7, "error": {"code": -32601, "message": "no"}})
        );
    }

    #[test]
    fn initialize_names_the_root_asks_for_utf16_and_says_it_shows_progress() {
        let params = initialize_params("file:///app");
        assert_eq!(params["processId"], Value::Null);
        assert_eq!(params["rootUri"], "file:///app");
        assert_eq!(params["workspaceFolders"][0]["uri"], "file:///app");
        assert_eq!(
            params["capabilities"]["general"]["positionEncodings"],
            json!(["utf-16"])
        );
        assert_eq!(params["capabilities"]["window"]["workDoneProgress"], true);
    }

    #[test]
    fn a_message_is_told_as_a_response_a_request_or_a_notification() {
        assert_eq!(
            classify(&json!({"jsonrpc": "2.0", "id": 4, "result": {"a": 1}})),
            Incoming::Response {
                id: 4,
                result: Ok(json!({"a": 1}))
            }
        );
        assert_eq!(
            classify(&json!({"id": 5, "result": null})),
            Incoming::Response {
                id: 5,
                result: Ok(Value::Null)
            }
        );
        assert_eq!(
            classify(&json!({"id": 1, "method": "window/workDoneProgress/create", "params": {}})),
            Incoming::Request {
                id: json!(1),
                method: "window/workDoneProgress/create".into()
            }
        );
        assert_eq!(
            classify(&json!({"id": "a", "method": "client/registerCapability"})),
            Incoming::Request {
                id: json!("a"),
                method: "client/registerCapability".into()
            }
        );
        assert_eq!(
            classify(&json!({"method": "$/progress", "params": {"token": "t"}})),
            Incoming::Notification {
                method: "$/progress".into(),
                params: json!({"token": "t"})
            }
        );
        assert_eq!(
            classify(&json!({"method": "initialized"})),
            Incoming::Notification {
                method: "initialized".into(),
                params: Value::Null
            }
        );
    }

    #[test]
    fn what_is_not_a_message_of_the_server_is_other() {
        for message in [
            json!([1]),
            json!("x"),
            json!({}),
            json!({"id": "s", "result": 1}),
            json!({"id": 1.5, "result": 1}),
            json!({"id": null, "result": 1}),
            json!({"id": {"a": 1}, "method": "x"}),
            json!({"method": 5}),
        ] {
            assert_eq!(classify(&message), Incoming::Other, "{message}");
        }
    }

    #[test]
    fn an_error_response_gives_the_message_of_the_server_without_control_characters_and_cut() {
        let Incoming::Response { result, .. } =
            classify(&json!({"id": 1, "error": {"code": -1, "message": "bad\u{1b}[31m\nthing"}}))
        else {
            panic!("not a response")
        };
        assert_eq!(result, Err("bad[31mthing".to_owned()));
        let Incoming::Response { result, .. } =
            classify(&json!({"id": 1, "error": {"message": "x".repeat(500)}}))
        else {
            panic!("not a response")
        };
        assert_eq!(result.unwrap_err().chars().count(), 200);
        let Incoming::Response { result, .. } = classify(&json!({"id": 1, "error": {}})) else {
            panic!("not a response")
        };
        assert!(result.is_err());
    }

    #[test]
    fn the_requests_of_the_server_that_a_client_may_ignore_are_answered_with_null_and_the_rest_are_refused(
    ) {
        assert_eq!(
            answer_request("window/workDoneProgress/create"),
            Ok(Value::Null)
        );
        assert_eq!(answer_request("client/registerCapability"), Ok(Value::Null));
        assert_eq!(
            answer_request("client/unregisterCapability"),
            Ok(Value::Null)
        );
        assert_eq!(answer_request("workspace/applyEdit").unwrap_err().0, -32601);
        assert_eq!(answer_request("").unwrap_err().0, -32601);
    }

    // ---- the state from the progress ----

    fn begin(token: Value) -> Value {
        json!({"token": token, "value": {"kind": "begin", "title": "Indexing"}})
    }
    fn report(token: Value) -> Value {
        json!({"token": token, "value": {"kind": "report", "percentage": 50}})
    }
    fn end(token: Value) -> Value {
        json!({"token": token, "value": {"kind": "end"}})
    }

    #[test]
    fn a_server_that_has_shown_no_progress_is_indexing_until_the_grace_is_over() {
        let mut progress = Progress::default();
        assert!(progress.is_indexing());
        progress.grace_over();
        assert!(!progress.is_indexing());
    }

    #[test]
    fn it_is_indexing_from_begin_to_end_and_not_again_for_the_grace() {
        let mut progress = Progress::default();
        progress.apply(&begin(json!("indexing-progress")));
        assert!(progress.is_indexing());
        progress.apply(&report(json!("indexing-progress")));
        assert!(progress.is_indexing());
        progress.apply(&end(json!("indexing-progress")));
        // It began and ended: the grace need not be waited for.
        assert!(!progress.is_indexing());
        progress.grace_over();
        assert!(!progress.is_indexing());
    }

    #[test]
    fn it_is_indexing_while_any_token_is_open_and_a_number_is_a_token_too() {
        let mut progress = Progress::default();
        progress.apply(&begin(json!(1)));
        progress.apply(&begin(json!("b")));
        progress.apply(&end(json!(1)));
        assert!(progress.is_indexing());
        progress.apply(&end(json!("b")));
        assert!(!progress.is_indexing());
        progress.apply(&begin(json!(1)));
        assert!(progress.is_indexing());
    }

    #[test]
    fn the_grace_does_not_end_an_indexing_that_began() {
        let mut progress = Progress::default();
        progress.apply(&begin(json!("t")));
        progress.grace_over();
        assert!(progress.is_indexing());
    }

    #[test]
    fn a_progress_that_cannot_be_read_changes_nothing_and_the_open_tokens_are_limited() {
        let mut progress = Progress::default();
        for params in [
            json!(null),
            json!({}),
            json!({"token": "t"}),
            json!({"token": null, "value": {"kind": "begin"}}),
            json!({"token": ["a"], "value": {"kind": "begin"}}),
            json!({"token": "t", "value": {"kind": "other"}}),
            json!({"token": "t", "value": {"kind": 5}}),
        ] {
            progress.apply(&params);
        }
        assert!(progress.is_indexing());
        progress.grace_over();
        assert!(!progress.is_indexing());
        for n in 0..10_000 {
            progress.apply(&begin(json!(n)));
        }
        assert!(progress.open() <= 64);
    }

    // ---- the paths ----

    #[test]
    fn a_path_becomes_a_uri_and_comes_back() {
        assert_eq!(uri_of("/app/lib/a.rb"), "file:///app/lib/a.rb");
        assert_eq!(
            uri_of("/app/a b#c%d?e.rb"),
            "file:///app/a%20b%23c%25d%3Fe.rb"
        );
        for path in [
            "/app/a b#c%d?e.rb",
            "/app/日本語/ファイル.rb",
            "/",
            "/a+b/c~d/e-f_g.h",
        ] {
            assert_eq!(path_of(&uri_of(path)).as_deref(), Some(path), "{path}");
        }
        assert_eq!(uri_of("/app/日"), "file:///app/%E6%97%A5");
    }

    #[test]
    fn only_a_file_uri_with_an_absolute_path_that_decodes_is_a_path() {
        assert_eq!(
            path_of("file:///usr/lib/x.rb").as_deref(),
            Some("/usr/lib/x.rb")
        );
        assert_eq!(path_of("file:///a%2Fb").as_deref(), Some("/a/b"));
        for uri in [
            "",
            "file:",
            "file://",
            "file://host/x",
            "http://x/y",
            "untitled:Untitled-1",
            "rubydoc:///x",
            "file:///x%zz",
            "file:///x%4",
            "file:///x%ff",
            "file:///x?a=1",
            "file:///x#top",
            "file:///x%00y",
            "file:///x%0Ay",
        ] {
            assert_eq!(path_of(uri), None, "{uri}");
        }
    }

    #[test]
    fn a_path_is_read_without_its_dots_and_double_slashes() {
        assert_eq!(normalize("/a/./b//c/../d").as_deref(), Some("/a/b/d"));
        assert_eq!(normalize("/a/b/").as_deref(), Some("/a/b"));
        assert_eq!(normalize("/..").as_deref(), Some("/"));
        assert_eq!(normalize("/a/../..").as_deref(), Some("/"));
        assert_eq!(normalize("/").as_deref(), Some("/"));
        assert_eq!(normalize("a/b"), None);
        assert_eq!(normalize(""), None);
    }

    #[test]
    fn a_relative_path_of_the_worktree_is_the_path_below_the_mount() {
        assert_eq!(server_path("/app", "lib/a.rb").unwrap(), "/app/lib/a.rb");
        assert_eq!(server_path("/app/", "a.rb").unwrap(), "/app/a.rb");
        assert_eq!(server_path("/", "a.rb").unwrap(), "/a.rb");
        for relative in [
            "",
            "/etc/passwd",
            "../x",
            "a/../b",
            "a/./b",
            "a//b",
            ".",
            "a\nb",
            "a\0b",
            "a/",
        ] {
            assert!(server_path("/app", relative).is_err(), "{relative:?}");
        }
        assert!(server_path("/app", &"a".repeat(5000)).is_err());
    }

    // ---- the answer to a definition ----

    fn at(line: u32, character: u32) -> Value {
        json!({"start": {"line": line, "character": character}, "end": {"line": line, "character": character + 3}})
    }

    fn loc(path: &str, line: u32, character: u32) -> LspLocation {
        LspLocation {
            path: path.into(),
            outside: false,
            line,
            character,
        }
    }

    fn out(path: &str, line: u32, character: u32) -> LspLocation {
        LspLocation {
            outside: true,
            ..loc(path, line, character)
        }
    }

    #[test]
    fn a_location_below_the_mount_is_told_from_the_worktree() {
        let result = json!({"uri": "file:///app/app/models/user.rb", "range": at(3, 6)});
        assert_eq!(
            locations(&result, "/app"),
            vec![loc("app/models/user.rb", 3, 6)]
        );
    }

    #[test]
    fn a_list_of_locations_and_of_location_links_is_read_in_order() {
        let result = json!([
            {"uri": "file:///app/a.rb", "range": at(0, 0)},
            {
                "targetUri": "file:///app/b.rb",
                "targetRange": {"start": {"line": 1, "character": 0}, "end": {"line": 9, "character": 3}},
                "targetSelectionRange": at(2, 4),
                "originSelectionRange": at(7, 7),
            },
            {"targetUri": "file:///app/c.rb", "targetRange": at(5, 1)},
        ]);
        assert_eq!(
            locations(&result, "/app"),
            vec![loc("a.rb", 0, 0), loc("b.rb", 2, 4), loc("c.rb", 5, 1)]
        );
    }

    #[test]
    fn a_path_outside_the_mount_stays_the_path_of_the_server() {
        let result = json!([
            {"uri": "file:///usr/local/bundle/gems/rack-3.1.0/lib/rack.rb", "range": at(10, 2)},
            {"uri": "file:///app2/x.rb", "range": at(0, 0)},
            {"uri": "file:///app/../etc/passwd", "range": at(0, 0)},
            {"uri": "file:///app/a/../../etc/hosts", "range": at(1, 1)},
        ]);
        assert_eq!(
            locations(&result, "/app"),
            vec![
                out("/usr/local/bundle/gems/rack-3.1.0/lib/rack.rb", 10, 2),
                out("/app2/x.rb", 0, 0),
                out("/etc/passwd", 0, 0),
                out("/etc/hosts", 1, 1),
            ]
        );
    }

    #[test]
    fn the_mount_itself_is_no_file_and_a_root_mount_holds_everything() {
        let result = json!([
            {"uri": "file:///app", "range": at(0, 0)},
            {"uri": "file:///app/", "range": at(0, 0)},
            {"uri": "file:///app/x.rb", "range": at(0, 0)},
        ]);
        assert_eq!(locations(&result, "/app"), vec![loc("x.rb", 0, 0)]);
        assert_eq!(locations(&result, "/app/"), vec![loc("x.rb", 0, 0)]);
        let result = json!([{"uri": "file:///usr/x.rb", "range": at(0, 0)}]);
        assert_eq!(locations(&result, "/"), vec![loc("usr/x.rb", 0, 0)]);
    }

    #[test]
    fn nothing_and_what_cannot_be_read_is_no_location() {
        for result in [
            json!(null),
            json!([]),
            json!({}),
            json!(5),
            json!("file:///app/a.rb"),
            json!([null, 1, "x", []]),
        ] {
            assert_eq!(locations(&result, "/app"), vec![], "{result}");
        }
        let result = json!([
            {"range": at(0, 0)},
            {"uri": 5, "range": at(0, 0)},
            {"uri": "http://example.com/a.rb", "range": at(0, 0)},
            {"uri": "file:///app/a.rb"},
            {"uri": "file:///app/a.rb", "range": {"start": {"line": -1, "character": 0}}},
            {"uri": "file:///app/a.rb", "range": {"start": {"line": 1.5, "character": 0}}},
            {"uri": "file:///app/a.rb", "range": {"start": {"line": "1", "character": 0}}},
            {"uri": "file:///app/a.rb", "range": {"start": {"line": 4294967296_u64, "character": 0}}},
            {"uri": "file:///app/a%0Ab.rb", "range": at(0, 0)},
            {"uri": "file:///app/ok.rb", "range": at(1, 2)},
        ]);
        assert_eq!(locations(&result, "/app"), vec![loc("ok.rb", 1, 2)]);
    }

    #[test]
    fn the_same_place_is_listed_once_and_the_list_is_limited() {
        let result = json!([
            {"uri": "file:///app/a.rb", "range": at(1, 1)},
            {"uri": "file:///app/./a.rb", "range": at(1, 1)},
            {"uri": "file:///app/a.rb", "range": at(1, 2)},
        ]);
        assert_eq!(
            locations(&result, "/app"),
            vec![loc("a.rb", 1, 1), loc("a.rb", 1, 2)]
        );
        let many: Vec<Value> = (0..500)
            .map(|n| json!({"uri": format!("file:///app/{n}.rb"), "range": at(0, 0)}))
            .collect();
        assert_eq!(locations(&json!(many), "/app").len(), MAX_LOCATIONS);
    }

    #[test]
    fn the_position_is_the_one_of_the_server_in_utf16_units() {
        // The client asked for UTF-16, which is the unit of a JavaScript string's index: nothing is converted.
        let result = json!({"uri": "file:///app/a.rb", "range": at(12, 40)});
        assert_eq!(locations(&result, "/app"), vec![loc("a.rb", 12, 40)]);
    }
}
