//! A-7: the history of an Orca session. The conversation of a Claude agent that runs in Orca is read from Orca's own runtime (a local unix socket, or a paired server over an end-to-end encrypted WebSocket) and drawn by the screen; nothing of it is stored here.
//! What is read from Orca's files: `orca-runtime.json` (this machine) and `orca-environments.json` (a paired server), at each connect and never written.
//! A token, a key or an auth frame is in no log line, no error text and no `Debug` output (the types that hold one derive none).

use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    path::{Path, PathBuf},
    time::Duration,
};

use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt, StreamExt,
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
    time::{sleep_until, timeout, Instant},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
#[cfg(test)]
use ts_rs::TS;

use crate::{
    orca::{check_path, first_line, text_of},
    orca_e2ee::{AuthReply, Channel as Sealed, Handshake},
};

/// From the socket's open to the answer to the auth frame (`PAIRED_E2EE_HANDSHAKE_DEADLINE_MS` of Orca).
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);
/// The server pings every 15 seconds; no frame at all for this long is a dead connection.
const SILENCE_LIMIT: Duration = Duration::from_secs(60);
/// One request over an open connection.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// A call over the unix socket.
const UNIX_TIMEOUT: Duration = Duration::from_secs(15);
/// The size of one WebSocket message, and of one reply line of the unix socket.
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
/// Messages of the first page, and of each page of older ones.
const FIRST_PAGE: u32 = 40;
const OLDER_PAGE: u32 = 100;
const UNAVAILABLE: &str = "このセッションの履歴は読めません";
const AGENT: &str = "claude";
const ENVIRONMENTS_FILE: &str = "orca-environments.json";
const RUNTIME_FILE: &str = "orca-runtime.json";
/// The keys of a tool call's input, the first of which that is a string is its detail.
const DETAIL_KEYS: [&str; 9] = [
    "file_path",
    "path",
    "notebook_path",
    "command",
    "pattern",
    "query",
    "url",
    "description",
    "prompt",
];

/// How often the session looks again, and how often the unix socket (which cannot stream) is read.
#[derive(Clone, Copy)]
struct Timing {
    tabs_every: Duration,
    poll_every: Duration,
}

const TIMING: Timing = Timing {
    tabs_every: Duration::from_secs(30),
    poll_every: Duration::from_secs(3),
};

// ---- what the screen gets ----

/// One call of a tool run: its name and the first line of what it works on.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaToolCall {
    pub name: String,
    pub detail: String,
}

/// One thing the timeline draws.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OrcaChatItem {
    User {
        id: String,
        text: String,
    },
    Assistant {
        id: String,
        text: String,
    },
    /// Tool calls in a row. `running_summary` is set only while the last item is a run with a call that has no result yet.
    Tools {
        id: String,
        summary: String,
        running_summary: Option<String>,
        calls: Vec<OrcaToolCall>,
    },
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum OrcaChatState {
    Connecting,
    Live,
    Reconnecting,
    Unavailable,
}

/// What the session tells the screen.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OrcaChatEvent {
    /// Replace the timeline from `start` with `items`. Sent only when something changed.
    Items {
        #[cfg_attr(test, ts(type = "number"))]
        start: usize,
        items: Vec<OrcaChatItem>,
        has_more: bool,
    },
    Status {
        state: OrcaChatState,
        message: String,
    },
}

/// What a running session is told besides the events it sends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OrcaCommand {
    /// Read the page of older messages before the oldest one held.
    Older,
    /// End the session.
    Close,
}

// ---- the messages Orca sends ----

#[derive(Clone, Copy, Debug, PartialEq)]
enum Role {
    User,
    Assistant,
    /// Tool, reasoning, system: their text is not drawn, but their calls and results count.
    Other,
}

#[derive(Clone, Debug, PartialEq)]
enum Block {
    Text(String),
    Call {
        name: String,
        detail: String,
        call_id: Option<String>,
    },
    Result {
        call_id: Option<String>,
    },
}

/// A message reduced to what is drawn: no tool output, no reasoning.
#[derive(Clone, Debug, PartialEq)]
struct Held {
    id: String,
    role: Role,
    blocks: Vec<Block>,
}

/// A page of a read or of a snapshot.
struct Page {
    messages: Vec<Held>,
    has_more: bool,
    before_offset: Option<u32>,
}

// Markers of the turns the harness injects into a transcript (`isKnownHarnessInjectedUserTurnText` of Orca): only the shapes seen are matched.
const HARNESS_TAGS: [&str; 19] = [
    "agent-message",
    "bash-input",
    "bash-stderr",
    "bash-stdout",
    "command-args",
    "command-message",
    "command-name",
    "cross-session-message",
    "fork-boilerplate",
    "local-command-caveat",
    "local-command-stderr",
    "local-command-stdout",
    "mcp-polling-update",
    "mcp-resource-update",
    "system-reminder",
    "task-notification",
    "teammate-message",
    "user-memory-input",
    "user-prompt-submit-hook",
];
const HARNESS_PREFIXES: [&str; 7] = [
    "<channel source=",
    "[request interrupted",
    "a message arrived from ",
    "another claude session sent a message",
    "no response requested.",
    "caveat: the messages below were generated by the user while running local commands",
    "this session is being continued from a previous conversation",
];
/// Orca bounds the lowercasing of the head of a turn.
const HARNESS_HEAD_LIMIT: usize = 256;
const HARNESS_LEADING_SPACE_LIMIT: usize = 64;

/// The tag name when `head` starts with `<name` and then a space, `>` or its end.
fn leading_tag(head: &str) -> Option<&str> {
    let rest = head.strip_prefix('<')?;
    let name_len = rest
        .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
        .unwrap_or(rest.len());
    let name = &rest[..name_len];
    let valid_start = name.starts_with(|c: char| c.is_ascii_lowercase());
    let valid_end = rest[name_len..]
        .chars()
        .next()
        .is_none_or(|c| c.is_whitespace() || c == '>');
    (valid_start && valid_end).then_some(name)
}

/// Whether the text of a user turn is machinery of the harness, not something the user wrote.
fn is_harness_turn(text: &str) -> bool {
    let trimmed = text.trim_start_matches([' ', '\t', '\n', '\r', '\x0c']);
    // Only so many leading spaces are skipped; more of them leave a head that starts with a space, which matches nothing.
    let skipped = text.chars().count() - trimmed.chars().count();
    let head: String = if skipped > HARNESS_LEADING_SPACE_LIMIT {
        text.chars()
            .skip(HARNESS_LEADING_SPACE_LIMIT)
            .take(HARNESS_HEAD_LIMIT)
            .collect()
    } else {
        trimmed.chars().take(HARNESS_HEAD_LIMIT).collect()
    };
    let head = head.to_lowercase();
    if head.is_empty() {
        return false;
    }
    leading_tag(&head).is_some_and(|tag| HARNESS_TAGS.contains(&tag))
        || HARNESS_PREFIXES.iter().any(|p| head.starts_with(p))
}

/// A line of a user turn that only names the file an image came from (`[Image: source: /path]`).
fn is_image_source_line(line: &str) -> bool {
    let Some(rest) = line.trim_end().strip_prefix("[Image:") else {
        return false;
    };
    let Some(rest) = rest.trim_start().strip_prefix("source:") else {
        return false;
    };
    rest.strip_suffix(']')
        .is_some_and(|inner| !inner.is_empty())
}

fn without_image_source_lines(text: &str) -> String {
    text.lines()
        .filter(|line| !is_image_source_line(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The first line of the first of the tool input's keys that holds a string, cut to the length of a row's line.
fn detail_of(input: &Value) -> String {
    DETAIL_KEYS
        .iter()
        .find_map(|key| input[*key].as_str())
        .and_then(first_line)
        .unwrap_or_default()
}

/// A message of a page reduced for the timeline. One without an `id` cannot be merged and is dropped.
/// A message the harness injected, or that starts an agent, is kept empty, so that an update of it by id still finds it.
fn held_of(message: &Value) -> Option<Held> {
    let id = text_of(message, "id")?.to_owned();
    let role_name = message["role"].as_str().unwrap_or_default();
    let role = match role_name {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        _ => Role::Other,
    };
    let blocks: &[Value] = message["blocks"].as_array().map_or(&[], Vec::as_slice);
    let starts_agent = !matches!(&message["agentStart"], Value::Null | Value::Bool(false));
    let has_tool = blocks
        .iter()
        .any(|b| matches!(b["type"].as_str(), Some("tool-call" | "tool-result")));
    let text_of_blocks: String = blocks
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect();
    let noise = !starts_agent
        && !has_tool
        && matches!(role_name, "user" | "system")
        && is_harness_turn(text_of_blocks.trim());
    if starts_agent || noise {
        return Some(Held {
            id,
            role,
            blocks: Vec::new(),
        });
    }
    let call_id = |block: &Value| text_of(block, "callId").map(str::to_owned);
    let blocks = blocks
        .iter()
        .filter_map(|block| match block["type"].as_str()? {
            "text" if role != Role::Other => {
                let text = block["text"].as_str()?;
                let text = if role == Role::User {
                    without_image_source_lines(text)
                } else {
                    text.to_owned()
                };
                let text = text.trim();
                (!text.is_empty()).then(|| Block::Text(text.to_owned()))
            }
            "tool-call" => Some(Block::Call {
                name: text_of(block, "name").unwrap_or("tool").to_owned(),
                detail: detail_of(&block["input"]),
                call_id: call_id(block),
            }),
            "tool-result" => Some(Block::Result {
                call_id: call_id(block),
            }),
            _ => None,
        })
        .collect();
    Some(Held { id, role, blocks })
}

/// `{messages, hasMore, beforeOffset}`; `None` when `messages` is not a list (Orca answered something else).
fn page_of(value: &Value) -> Option<Page> {
    let messages = value["messages"]
        .as_array()?
        .iter()
        .filter_map(held_of)
        .collect();
    Some(Page {
        messages,
        has_more: value["hasMore"] == true,
        before_offset: value["beforeOffset"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok()),
    })
}

/// What a streamed answer of `nativeChat.subscribe` says.
enum Streamed {
    Snapshot(Page),
    /// The first read failed (`error`), so the stream has no history to show.
    SnapshotFailed,
    Appended(Vec<Held>),
    Replacement(Page),
    End,
    Other,
}

fn streamed_of(result: &Value) -> Streamed {
    let page = || {
        page_of(result).unwrap_or(Page {
            messages: Vec::new(),
            has_more: false,
            before_offset: None,
        })
    };
    match result["type"].as_str() {
        Some("snapshot") if result["error"].is_string() => Streamed::SnapshotFailed,
        Some("snapshot") => Streamed::Snapshot(page()),
        Some("replacement") => Streamed::Replacement(page()),
        Some("appended") => Streamed::Appended(page().messages),
        Some("end") => Streamed::End,
        _ => Streamed::Other,
    }
}

// ---- merging ----

/// The held messages before the first one the snapshot also has, then the snapshot. With no id in common the snapshot stands alone.
/// Returns how many held messages were kept in front.
fn merge_snapshot(held: &mut Vec<Held>, snapshot: Vec<Held>) -> usize {
    let ids: HashSet<&str> = snapshot.iter().map(|m| m.id.as_str()).collect();
    let keep = held
        .iter()
        .position(|m| ids.contains(m.id.as_str()))
        .unwrap_or(0);
    held.truncate(keep);
    held.extend(snapshot);
    keep
}

/// A message with a held id replaces it where it is, any other goes last.
fn merge_appended(held: &mut Vec<Held>, appended: Vec<Held>) {
    for message in appended {
        match held.iter_mut().find(|m| m.id == message.id) {
            Some(slot) => *slot = message,
            None => held.push(message),
        }
    }
}

/// Older messages go in front, except the ones already held.
fn prepend_older(held: &mut Vec<Held>, older: Vec<Held>) {
    let have: HashSet<String> = held.iter().map(|m| m.id.clone()).collect();
    let mut merged: Vec<Held> = older
        .into_iter()
        .filter(|m| !have.contains(&m.id))
        .collect();
    merged.append(held);
    *held = merged;
}

// ---- the timeline ----

struct CallRef {
    name: String,
    detail: String,
    call_id: Option<String>,
}

struct Run {
    id: String,
    calls: Vec<CallRef>,
}

enum Entry {
    Item(OrcaChatItem),
    Run(Run),
}

/// The names of a run's calls with how many times each is called, in the order of first use: `Read 2、Edit 2、Bash 1`.
fn counts_text(calls: &[CallRef]) -> String {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for call in calls {
        match counts.iter_mut().find(|(name, _)| *name == call.name) {
            Some((_, n)) => *n += 1,
            None => counts.push((&call.name, 1)),
        }
    }
    counts
        .iter()
        .map(|(name, n)| format!("{name} {n}"))
        .collect::<Vec<_>>()
        .join("、")
}

fn tools_item(run: Run, running: bool) -> OrcaChatItem {
    let counts = counts_text(&run.calls);
    OrcaChatItem::Tools {
        summary: format!("ツールを {} 回実行（{counts}）", run.calls.len()),
        running_summary: running.then(|| format!("ツールを実行中（{counts}）")),
        calls: run
            .calls
            .into_iter()
            .map(|c| OrcaToolCall {
                name: c.name,
                detail: c.detail,
            })
            .collect(),
        id: run.id,
    }
}

/// Puts the text gathered so far in a message out as one item (which ends the run of tool calls), and empties it.
fn flush_text(
    message: &Held,
    parts: &mut usize,
    text: &mut Vec<&str>,
    entries: &mut Vec<Entry>,
    run: &mut Option<Run>,
) {
    if text.is_empty() {
        return;
    }
    if let Some(run) = run.take() {
        entries.push(Entry::Run(run));
    }
    let id = if *parts == 0 {
        message.id.clone()
    } else {
        format!("{}#t{}", message.id, *parts)
    };
    *parts += 1;
    let text = std::mem::take(text).join("\n\n");
    entries.push(Entry::Item(if message.role == Role::User {
        OrcaChatItem::User { id, text }
    } else {
        OrcaChatItem::Assistant { id, text }
    }));
}

/// The timeline of the held messages: the user's and the assistant's text, and the tool calls between them folded into runs.
/// A result, a message that is not drawn (reasoning, noise, an agent's start) does not break a run; text does, and so does a message in `page_starts`:
/// the first message before an older page came, so a run there keeps its id (and what is in view and what is open stay) when older calls arrive in front of it.
fn items_of(held: &[Held], page_starts: &HashSet<String>) -> Vec<OrcaChatItem> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut run: Option<Run> = None;
    let (mut calls_total, mut results_total) = (0usize, 0usize);
    let mut done: HashSet<&str> = HashSet::new();
    for message in held {
        if page_starts.contains(&message.id) {
            if let Some(run) = run.take() {
                entries.push(Entry::Run(run));
            }
        }
        let mut parts = 0usize;
        let mut text: Vec<&str> = Vec::new();
        for (index, block) in message.blocks.iter().enumerate() {
            match block {
                Block::Text(t) => text.push(t),
                Block::Call {
                    name,
                    detail,
                    call_id,
                } => {
                    flush_text(message, &mut parts, &mut text, &mut entries, &mut run);
                    calls_total += 1;
                    run.get_or_insert_with(|| Run {
                        id: format!("{}#c{index}", message.id),
                        calls: Vec::new(),
                    })
                    .calls
                    .push(CallRef {
                        name: name.clone(),
                        detail: detail.clone(),
                        call_id: call_id.clone(),
                    });
                }
                Block::Result { call_id } => {
                    results_total += 1;
                    if let Some(id) = call_id {
                        done.insert(id);
                    }
                }
            }
        }
        flush_text(message, &mut parts, &mut text, &mut entries, &mut run);
    }
    if let Some(run) = run {
        entries.push(Entry::Run(run));
    }
    let last = entries.len().saturating_sub(1);
    entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| match entry {
            Entry::Item(item) => item,
            Entry::Run(run) => {
                let pending = if run.calls.iter().all(|c| c.call_id.is_some()) {
                    run.calls
                        .iter()
                        .any(|c| !done.contains(c.call_id.as_deref().unwrap_or_default()))
                } else {
                    calls_total > results_total
                };
                tools_item(run, index == last && pending)
            }
        })
        .collect()
}

/// The first index at which the two timelines differ (the length of the shorter one when it is a prefix of the other).
fn changed_from(old: &[OrcaChatItem], new: &[OrcaChatItem]) -> usize {
    old.iter()
        .zip(new)
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| old.len().min(new.len()))
}

/// The event that brings a screen holding `old` to `new`; `None` when nothing differs.
fn items_event(
    old: &[OrcaChatItem],
    new: &[OrcaChatItem],
    old_more: bool,
    new_more: bool,
) -> Option<OrcaChatEvent> {
    let start = changed_from(old, new);
    if start == old.len() && start == new.len() && old_more == new_more {
        return None;
    }
    Some(OrcaChatEvent::Items {
        start,
        items: new[start..].to_vec(),
        has_more: new_more,
    })
}

/// How long to wait before connecting again after the `attempt`th failure in a row (counting from 0).
fn backoff(attempt: usize) -> Duration {
    Duration::from_secs([1, 2, 5, 10, 30][attempt.min(4)])
}

// ---- the pairing ----

/// How to reach Orca. Each holds a secret, so none derives `Debug`.
enum Pairing {
    Unix {
        endpoint: String,
        token: String,
    },
    WebSocket {
        url: String,
        device_token: String,
        public_key_b64: String,
    },
}

fn orca_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("orca"))
}

/// This machine: the unix transport of `orca-runtime.json`.
fn runtime_pairing(doc: &Value) -> Result<Pairing, String> {
    let token = text_of(doc, "authToken");
    let endpoint = doc["transports"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["kind"] == "unix")
        .and_then(|t| text_of(t, "endpoint"));
    match (token, endpoint) {
        (Some(token), Some(endpoint)) if Path::new(endpoint).is_absolute() => Ok(Pairing::Unix {
            endpoint: endpoint.to_owned(),
            token: token.to_owned(),
        }),
        _ => Err("Orca の接続情報（orca-runtime.json）を読めません".into()),
    }
}

/// A saved environment, chosen by its name (an unnamed one by its id), with its preferred endpoint, else the first WebSocket one.
fn environment_pairing(doc: &Value, environment: &str) -> Result<Pairing, String> {
    let entry = doc["environments"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|e| {
            e.is_object()
                && text_of(e, "name")
                    .or_else(|| text_of(e, "id"))
                    .is_some_and(|label| label == environment)
        })
        .ok_or("接続先の登録（ペアリング）が見つかりません")?;
    let endpoints: &[Value] = entry["endpoints"].as_array().map_or(&[], Vec::as_slice);
    let endpoint = text_of(entry, "preferredEndpointId")
        .and_then(|id| endpoints.iter().find(|e| e["id"] == id))
        .or_else(|| endpoints.iter().find(|e| e["kind"] == "websocket"))
        .ok_or("接続先の登録に WebSocket のエンドポイントがありません")?;
    let url = text_of(endpoint, "endpoint").unwrap_or_default();
    // The frames are end-to-end encrypted, but TLS is not built in: only `ws://` is reached.
    if !url
        .get(..5)
        .is_some_and(|p| p.eq_ignore_ascii_case("ws://"))
    {
        return Err("ws:// 以外の接続先の履歴は読めません".into());
    }
    match (
        text_of(endpoint, "deviceToken"),
        text_of(endpoint, "publicKeyB64"),
    ) {
        (Some(device_token), Some(public_key_b64)) => Ok(Pairing::WebSocket {
            url: url.to_owned(),
            device_token: device_token.to_owned(),
            public_key_b64: public_key_b64.to_owned(),
        }),
        _ => Err("接続先の登録にトークンまたは鍵がありません".into()),
    }
}

fn read_json(path: &Path, missing: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|_| missing.to_owned())?;
    serde_json::from_str(&text).map_err(|_| format!("{} を読めません", path.display()))
}

/// The pairing of the target, read from Orca's files now.
fn load_pairing(environment: Option<&str>) -> Result<Pairing, String> {
    let dir = orca_dir().ok_or("設定フォルダが見つかりません")?;
    match environment {
        Some(name) => environment_pairing(
            &read_json(
                &dir.join(ENVIRONMENTS_FILE),
                "接続先の登録（orca-environments.json）が見つかりません",
            )?,
            name,
        ),
        None => runtime_pairing(&read_json(
            &dir.join(RUNTIME_FILE),
            "Orca が起動していません（orca-runtime.json がありません）",
        )?),
    }
}

// ---- the connection ----

enum LinkError {
    /// The connection or a frame failed: the session reconnects.
    Broken(String),
    /// Orca answered `ok: false` with this message.
    Remote(String),
}

fn broken(message: &str) -> LinkError {
    LinkError::Broken(message.to_owned())
}

/// The `result` of `{id, ok, result, error: {code}}`. The code is shown, never the message: it is the text of another program.
fn result_of(response: &Value) -> Result<Value, LinkError> {
    match response["ok"] {
        Value::Bool(true) => Ok(response["result"].clone()),
        Value::Bool(false) => {
            let code: String = response["error"]["code"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                .take(64)
                .collect();
            Err(LinkError::Remote(if code.is_empty() {
                "Orca がエラーを返しました".into()
            } else {
                format!("Orca がエラーを返しました（{code}）")
            }))
        }
        _ => Err(broken("Orca の応答を読めません")),
    }
}

fn is_keepalive(value: &Value) -> bool {
    value["_keepalive"] == true
}

fn session_params(session_id: &str, limit: u32) -> Value {
    json!({"agent": AGENT, "sessionId": session_id, "limit": limit})
}

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// A paired server: a WebSocket whose frames are sealed. Answers are matched by `id`; a streamed answer carries its subscription's.
struct WsLink {
    write: SplitSink<Socket, Message>,
    read: SplitStream<Socket>,
    sealed: Sealed,
    device_token: String,
    next_id: u64,
    last_frame: Instant,
    /// Answers of other requests that arrived while one was waited for.
    queued: VecDeque<Value>,
}

/// What one WebSocket message was.
enum Frame {
    /// A ping, pong, binary payload or keepalive: only a sign of life.
    Idle,
    Json(Value),
}

impl WsLink {
    /// Connects and authenticates within the handshake deadline.
    async fn connect(url: &str, device_token: &str, public_key_b64: &str) -> Result<Self, String> {
        let handshake = Handshake::new(public_key_b64).map_err(str::to_owned)?;
        timeout(HANDSHAKE_DEADLINE, async {
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_MESSAGE))
                .max_frame_size(Some(MAX_MESSAGE));
            let (socket, _) = connect_async_with_config(url, Some(config), false)
                .await
                .map_err(|_| "接続先に接続できません")?;
            let (mut write, mut read) = socket.split();
            write
                .send(Message::text(handshake.hello_text()))
                .await
                .map_err(|_| "接続先に送れません")?;
            let ready = Self::next_text(&mut read).await?;
            let mut sealed = handshake.accept_ready(&ready).map_err(str::to_owned)?;
            write
                .send(Message::text(sealed.auth_frame(device_token)))
                .await
                .map_err(|_| "接続先に送れません")?;
            let reply = Self::next_text(&mut read).await?;
            let reply = sealed.open_text(&reply).ok_or("接続先の応答を開けません")?;
            if sealed.auth_reply(&reply) != AuthReply::Authenticated {
                return Err(
                    "接続先に認証されませんでした（登録したトークンを確認してください）".to_owned(),
                );
            }
            Ok(Self {
                write,
                read,
                sealed,
                device_token: device_token.to_owned(),
                next_id: 1,
                last_frame: Instant::now(),
                queued: VecDeque::new(),
            })
        })
        .await
        .map_err(|_| "接続先が時間内に応答しませんでした".to_owned())?
        .map_err(|e: String| e)
    }

    /// The next text message of the socket before the sealing starts (control messages are skipped).
    async fn next_text(read: &mut SplitStream<Socket>) -> Result<String, String> {
        loop {
            match read.next().await {
                Some(Ok(Message::Text(text))) => return Ok(text.as_str().to_owned()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => return Err("接続先が接続を閉じました".into()),
            }
        }
    }

    fn silence_deadline(&self) -> Instant {
        self.last_frame + SILENCE_LIMIT
    }

    /// Sends `method` as the sealed request `{id, deviceToken, method, params}` and gives its id.
    async fn send_request(&mut self, method: &str, params: Value) -> Result<String, LinkError> {
        let id = format!("c{}", self.next_id);
        self.next_id += 1;
        let text = json!({
            "id": id, "deviceToken": self.device_token, "method": method, "params": params,
        })
        .to_string();
        let frame = self.sealed.seal_text(&text);
        self.write
            .send(Message::text(frame))
            .await
            .map_err(|_| broken("接続先に送れません"))?;
        Ok(id)
    }

    /// One message of the socket, opened. Anything that does not open ends the connection.
    async fn read_frame(&mut self) -> Result<Frame, String> {
        let message = self
            .read
            .next()
            .await
            .ok_or("接続先が接続を閉じました")?
            .map_err(|_| "接続先との通信が途切れました")?;
        self.last_frame = Instant::now();
        match message {
            Message::Text(text) => {
                let plaintext = self
                    .sealed
                    .open_text(text.as_str())
                    .ok_or("接続先の応答を開けません")?;
                let value: Value = serde_json::from_str(&plaintext)
                    .map_err(|_| "接続先の応答を読めません".to_owned())?;
                Ok(if is_keepalive(&value) {
                    Frame::Idle
                } else {
                    Frame::Json(value)
                })
            }
            Message::Binary(bytes) => {
                // The payload is of no use, but opening it moves the counter both kinds share.
                self.sealed
                    .open_binary(&bytes)
                    .ok_or("接続先の応答を開けません")?;
                Ok(Frame::Idle)
            }
            Message::Close(_) => Err("接続先が接続を閉じました".into()),
            _ => Ok(Frame::Idle),
        }
    }

    /// The next answer: one queued, else one read. `None` is a message that carries none.
    async fn next_response(&mut self) -> Result<Option<Value>, String> {
        if let Some(value) = self.queued.pop_front() {
            return Ok(Some(value));
        }
        Ok(match self.read_frame().await? {
            Frame::Json(value) => Some(value),
            Frame::Idle => None,
        })
    }

    /// A request and its one answer; answers of other requests that come first are queued.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, LinkError> {
        let id = self.send_request(method, params).await?;
        let wait = async {
            loop {
                let Frame::Json(value) = self.read_frame().await.map_err(LinkError::Broken)? else {
                    continue;
                };
                if value["id"] == id.as_str() {
                    return result_of(&value);
                }
                self.queued.push_back(value);
            }
        };
        timeout(REQUEST_TIMEOUT, wait)
            .await
            .map_err(|_| broken("接続先が時間内に応答しませんでした"))?
    }
}

/// This machine: one connection and one JSON line for each call.
#[cfg(unix)]
async fn unix_request(
    endpoint: &str,
    token: &str,
    method: &str,
    params: Value,
) -> Result<Value, LinkError> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let call = async {
        let stream = tokio::net::UnixStream::connect(endpoint)
            .await
            .map_err(|_| broken("Orca に接続できません。Orca が起動しているか確認してください"))?;
        let (read, mut write) = stream.into_split();
        let line = format!(
            "{}\n",
            json!({"id": "1", "authToken": token, "method": method, "params": params})
        );
        write
            .write_all(line.as_bytes())
            .await
            .map_err(|_| broken("Orca に送れません"))?;
        let mut reader = BufReader::new(read.take(0));
        loop {
            reader.get_mut().set_limit(MAX_MESSAGE as u64 + 1);
            let mut buf = Vec::new();
            let n = reader
                .read_until(b'\n', &mut buf)
                .await
                .map_err(|_| broken("Orca の応答を読めません"))?;
            if n == 0 {
                return Err(broken("Orca が接続を閉じました"));
            }
            if buf.len() > MAX_MESSAGE {
                return Err(broken("Orca の応答が大きすぎます"));
            }
            let value: Value =
                serde_json::from_slice(&buf).map_err(|_| broken("Orca の応答を読めません"))?;
            if !is_keepalive(&value) {
                return result_of(&value);
            }
        }
    };
    timeout(UNIX_TIMEOUT, call)
        .await
        .map_err(|_| broken("Orca が時間内に応答しませんでした"))?
}

#[cfg(not(unix))]
async fn unix_request(_: &str, _: &str, _: &str, _: Value) -> Result<Value, LinkError> {
    Err(broken(
        "このマシンの履歴は macOS では読めますが、この OS では読めません",
    ))
}

enum Link {
    Ws(Box<WsLink>),
    Unix { endpoint: String, token: String },
}

impl Link {
    async fn open(pairing: Pairing) -> Result<Self, String> {
        match pairing {
            Pairing::WebSocket {
                url,
                device_token,
                public_key_b64,
            } => Ok(Self::Ws(Box::new(
                WsLink::connect(&url, &device_token, &public_key_b64).await?,
            ))),
            Pairing::Unix { endpoint, token } => Ok(Self::Unix { endpoint, token }),
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, LinkError> {
        match self {
            Self::Ws(ws) => ws.request(method, params).await,
            Self::Unix { endpoint, token } => unix_request(endpoint, token, method, params).await,
        }
    }
}

// ---- the session ----

/// What the session holds between connections, and what it has sent.
struct Chat {
    held: Vec<Held>,
    /// The messages that were first when an older page came in front of them.
    page_starts: HashSet<String>,
    has_more: bool,
    before_offset: Option<u32>,
    session_id: Option<String>,
    /// Whether a page of this session has been read.
    loaded: bool,
    sent_items: Vec<OrcaChatItem>,
    sent_more: bool,
    status: Option<(OrcaChatState, String)>,
}

impl Chat {
    fn new() -> Self {
        Self {
            held: Vec::new(),
            page_starts: HashSet::new(),
            has_more: false,
            before_offset: None,
            session_id: None,
            loaded: false,
            sent_items: Vec::new(),
            sent_more: false,
            status: None,
        }
    }

    /// Sends the status only when it differs from the last one.
    fn set_status(
        &mut self,
        state: OrcaChatState,
        message: &str,
        sink: &mut impl FnMut(OrcaChatEvent),
    ) {
        let now = (state, message.to_owned());
        if self.status.as_ref() == Some(&now) {
            return;
        }
        self.status = Some(now);
        sink(OrcaChatEvent::Status {
            state,
            message: message.to_owned(),
        });
    }

    /// Sends what changed in the timeline since the last send.
    fn publish(&mut self, sink: &mut impl FnMut(OrcaChatEvent)) {
        let items = items_of(&self.held, &self.page_starts);
        if let Some(event) = items_event(&self.sent_items, &items, self.sent_more, self.has_more) {
            sink(event);
        }
        self.sent_items = items;
        self.sent_more = self.has_more;
    }

    /// A different session (also the first one): nothing of the old one is kept.
    fn start_session(&mut self, id: String, sink: &mut impl FnMut(OrcaChatEvent)) {
        self.session_id = Some(id);
        self.held.clear();
        self.page_starts.clear();
        self.has_more = false;
        self.before_offset = None;
        self.loaded = false;
        self.publish(sink);
        self.set_status(OrcaChatState::Connecting, "", sink);
    }

    fn loaded(&mut self, sink: &mut impl FnMut(OrcaChatEvent)) {
        self.loaded = true;
        self.publish(sink);
        self.set_status(OrcaChatState::Live, "", sink);
    }

    fn apply_snapshot(&mut self, page: Page, sink: &mut impl FnMut(OrcaChatEvent)) {
        let kept = merge_snapshot(&mut self.held, page.messages);
        // Older messages kept in front say whether there are still more before them; with none, the snapshot does.
        if kept == 0 {
            self.has_more = page.has_more;
            self.before_offset = page.before_offset;
        }
        self.loaded(sink);
    }

    fn apply_replacement(&mut self, page: Page, sink: &mut impl FnMut(OrcaChatEvent)) {
        self.held = page.messages;
        self.page_starts.clear();
        self.has_more = page.has_more;
        self.before_offset = page.before_offset;
        self.loaded(sink);
    }

    fn apply_appended(&mut self, messages: Vec<Held>, sink: &mut impl FnMut(OrcaChatEvent)) {
        merge_appended(&mut self.held, messages);
        self.loaded(sink);
    }

    fn apply_older(&mut self, page: Page, sink: &mut impl FnMut(OrcaChatEvent)) {
        if let Some(first) = self.held.first() {
            self.page_starts.insert(first.id.clone());
        }
        prepend_older(&mut self.held, page.messages);
        self.has_more = page.has_more;
        self.before_offset = page.before_offset;
        self.publish(sink);
    }

    fn unavailable(&mut self, sink: &mut impl FnMut(OrcaChatEvent)) {
        self.set_status(OrcaChatState::Unavailable, UNAVAILABLE, sink);
    }
}

/// The provider session of the tab whose agent is in pane `pane_key`.
fn session_id_of(tabs: &Value, pane_key: &str) -> Option<String> {
    tabs["tabs"].as_array()?.iter().find_map(|tab| {
        let status = &tab["agentStatus"];
        if status["paneKey"] != pane_key {
            return None;
        }
        text_of(&status["providerSession"], "id").map(str::to_owned)
    })
}

fn reason_of(error: LinkError) -> String {
    match error {
        LinkError::Broken(message) | LinkError::Remote(message) => message,
    }
}

/// The end of a session that is not a failure: the screen closed it.
fn is_closing(command: Option<OrcaCommand>) -> bool {
    matches!(command, None | Some(OrcaCommand::Close))
}

struct Target<'a> {
    worktree: &'a str,
    pane_key: &'a str,
}

/// Reads the session's tabs, switches to a changed session, and starts reading a session that is not being read yet.
/// `subscription` is the stream of this connection (WebSocket only).
async fn check_session(
    link: &mut Link,
    chat: &mut Chat,
    target: &Target<'_>,
    subscription: &mut Option<String>,
    sink: &mut impl FnMut(OrcaChatEvent),
) -> Result<(), String> {
    let tabs = link
        .request(
            "session.tabs.list",
            json!({"worktree": format!("path:{}", target.worktree)}),
        )
        .await
        .map_err(reason_of)?;
    if matches!(&chat.status, Some((OrcaChatState::Reconnecting, _))) {
        let state = if chat.loaded {
            OrcaChatState::Live
        } else {
            OrcaChatState::Connecting
        };
        chat.set_status(state, "", sink);
    }
    match session_id_of(&tabs, target.pane_key) {
        None => {
            if chat.session_id.is_none() {
                chat.unavailable(sink);
            }
        }
        Some(id) => {
            if chat.session_id.as_deref() != Some(&id) {
                if let (Link::Ws(ws), Some(old)) = (&mut *link, subscription.take()) {
                    // Best effort: the answer is not waited for, and a connection that ends drops it anyway.
                    let _ = ws
                        .send_request("nativeChat.unsubscribe", json!({"subscriptionId": old}))
                        .await;
                }
                chat.start_session(id, sink);
            }
        }
    }
    if let (Link::Ws(ws), Some(id)) = (link, chat.session_id.clone()) {
        if subscription.is_none() {
            let mut params = session_params(&id, FIRST_PAGE);
            let mut random = [0u8; 8];
            getrandom::fill(&mut random).map_err(|_| "乱数を作れません".to_owned())?;
            let sub: String = random.iter().map(|b| format!("{b:02x}")).collect();
            params["subscriptionId"] = json!(sub);
            let request_id = ws
                .send_request("nativeChat.subscribe", params)
                .await
                .map_err(reason_of)?;
            // The streamed answers carry the id of this request.
            *subscription = Some(request_id);
        }
    }
    Ok(())
}

/// The unix socket cannot stream: the newest page is read again and treated as a snapshot.
async fn poll(
    link: &mut Link,
    chat: &mut Chat,
    sink: &mut impl FnMut(OrcaChatEvent),
) -> Result<(), String> {
    let Some(id) = chat.session_id.clone() else {
        return Ok(());
    };
    match link
        .request("nativeChat.readSession", session_params(&id, FIRST_PAGE))
        .await
    {
        Ok(result) => match page_of(&result) {
            Some(page) => chat.apply_snapshot(page, sink),
            None => chat.unavailable(sink),
        },
        Err(LinkError::Remote(_)) => chat.unavailable(sink),
        Err(LinkError::Broken(message)) => return Err(message),
    }
    Ok(())
}

/// The page of older messages, over the connection that is open.
async fn older(
    link: &mut Link,
    chat: &mut Chat,
    sink: &mut impl FnMut(OrcaChatEvent),
) -> Result<(), String> {
    let (Some(id), true, Some(offset)) =
        (chat.session_id.clone(), chat.has_more, chat.before_offset)
    else {
        return Ok(());
    };
    let mut params = session_params(&id, OLDER_PAGE);
    params["beforeOffset"] = json!(offset);
    match link.request("nativeChat.readSession", params).await {
        Ok(result) => {
            if let Some(page) = page_of(&result) {
                chat.apply_older(page, sink);
            }
        }
        // The button can be pressed again.
        Err(LinkError::Remote(_)) => {}
        Err(LinkError::Broken(message)) => return Err(message),
    }
    Ok(())
}

/// An answer of the WebSocket: the streamed ones of the subscription change the timeline, any other is of no use.
fn on_response(
    response: &Value,
    chat: &mut Chat,
    subscription: &mut Option<String>,
    sink: &mut impl FnMut(OrcaChatEvent),
) -> ResponseEffect {
    let Some(sub) = subscription.as_deref() else {
        return ResponseEffect::None;
    };
    if response["id"] != sub {
        return ResponseEffect::None;
    }
    let Ok(result) = result_of(response) else {
        *subscription = None;
        chat.unavailable(sink);
        return ResponseEffect::None;
    };
    match streamed_of(&result) {
        Streamed::Snapshot(page) => chat.apply_snapshot(page, sink),
        Streamed::SnapshotFailed => chat.unavailable(sink),
        Streamed::Replacement(page) => chat.apply_replacement(page, sink),
        Streamed::Appended(messages) => chat.apply_appended(messages, sink),
        Streamed::End => {
            *subscription = None;
            return ResponseEffect::Resubscribe;
        }
        Streamed::Other => {}
    }
    ResponseEffect::None
}

enum ResponseEffect {
    None,
    /// The stream ended: subscribe again, but not at once, so a server that ends every stream cannot make this spin.
    Resubscribe,
}

/// Serves one connection until it fails (`Err`, with the reason) or the screen closes the session (`Ok`).
async fn serve(
    link: &mut Link,
    chat: &mut Chat,
    target: &Target<'_>,
    commands: &mut UnboundedReceiver<OrcaCommand>,
    timing: Timing,
    attempt: &mut usize,
    sink: &mut impl FnMut(OrcaChatEvent),
) -> Result<(), String> {
    let mut subscription: Option<String> = None;
    check_session(link, chat, target, &mut subscription, sink).await?;
    // A connection that answered is a success: the next failure waits the shortest time again.
    *attempt = 0;
    let streaming = matches!(link, Link::Ws(_));
    let mut next_tabs = Instant::now() + timing.tabs_every;
    let mut next_poll = Instant::now();
    loop {
        let silence = match &*link {
            Link::Ws(ws) => ws.silence_deadline(),
            Link::Unix { .. } => next_poll,
        };
        tokio::select! {
            command = commands.recv() => match command {
                Some(OrcaCommand::Older) => older(link, chat, sink).await?,
                other => {
                    debug_assert!(is_closing(other));
                    return Ok(());
                }
            },
            () = sleep_until(next_tabs) => {
                check_session(link, chat, target, &mut subscription, sink).await?;
                next_tabs = Instant::now() + timing.tabs_every;
            }
            () = sleep_until(next_poll), if !streaming && chat.session_id.is_some() => {
                poll(link, chat, sink).await?;
                next_poll = Instant::now() + timing.poll_every;
            }
            () = sleep_until(silence), if streaming => {
                return Err("接続先からの応答が途絶えました".into());
            }
            response = async {
                match &mut *link {
                    Link::Ws(ws) => ws.next_response().await,
                    Link::Unix { .. } => std::future::pending().await,
                }
            }, if streaming => {
                if let Some(response) = response? {
                    if let ResponseEffect::Resubscribe =
                        on_response(&response, chat, &mut subscription, sink)
                    {
                        next_tabs = Instant::now() + Duration::from_secs(1);
                    }
                }
            }
        }
    }
}

/// Connects and serves again and again until the screen closes the session.
async fn run_loop<F, Fut>(
    mut open: F,
    worktree: String,
    pane_key: String,
    mut commands: UnboundedReceiver<OrcaCommand>,
    timing: Timing,
    mut sink: impl FnMut(OrcaChatEvent),
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Link, String>>,
{
    let target = Target {
        worktree: &worktree,
        pane_key: &pane_key,
    };
    let mut chat = Chat::new();
    chat.set_status(OrcaChatState::Connecting, "", &mut sink);
    let mut attempt = 0usize;
    loop {
        let result = match open().await {
            Ok(mut link) => {
                serve(
                    &mut link,
                    &mut chat,
                    &target,
                    &mut commands,
                    timing,
                    &mut attempt,
                    &mut sink,
                )
                .await
            }
            Err(reason) => Err(reason),
        };
        let Err(reason) = result else {
            return;
        };
        chat.set_status(OrcaChatState::Reconnecting, &reason, &mut sink);
        let until = Instant::now() + backoff(attempt);
        attempt += 1;
        loop {
            tokio::select! {
                () = sleep_until(until) => break,
                // A request for older messages while disconnected is dropped; the button can be pressed again.
                command = commands.recv() => if is_closing(command) { return; },
            }
        }
    }
}

/// Reads the history of the session in pane `pane_key` of the worktree at `worktree` from the Orca of `environment` (`None`: this machine) and sends it to `sink`
/// until a `Close` comes (or the sender is dropped). It reconnects by itself and returns only then.
pub async fn run_session(
    environment: Option<String>,
    worktree: String,
    pane_key: String,
    commands: UnboundedReceiver<OrcaCommand>,
    sink: impl FnMut(OrcaChatEvent),
) {
    run_loop(
        || {
            let environment = environment.clone();
            async move { Link::open(load_pairing(environment.as_deref())?).await }
        },
        worktree,
        pane_key,
        commands,
        TIMING,
        sink,
    )
    .await;
}

// ---- the commands ----

struct Active {
    task: tauri::async_runtime::JoinHandle<()>,
    commands: UnboundedSender<OrcaCommand>,
}

/// The one session that runs: opening another ends it.
#[derive(Default)]
pub struct OrcaChat(std::sync::Mutex<Option<Active>>);

/// A pane is `{tabId}:{leafId}`; nothing else is accepted, and a key is never put in a command line.
fn check_pane_key(pane_key: &str) -> Result<(), String> {
    if !pane_key.is_empty()
        && pane_key.chars().count() <= 256
        && pane_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        Ok(())
    } else {
        Err("エージェントの場所が正しくありません".into())
    }
}

impl OrcaChat {
    fn stop(&self) {
        if let Some(active) = self.0.lock().unwrap().take() {
            active.task.abort();
        }
    }
}

/// Starts reading the history of the session in pane `pane_key` of the worktree at `path`, and sends it through `channel` until the next open or close.
/// A send that fails (the screen is gone) ends the session.
#[tauri::command]
pub async fn orca_chat_open(
    state: tauri::State<'_, OrcaChat>,
    environment: Option<String>,
    path: String,
    pane_key: String,
    channel: tauri::ipc::Channel<OrcaChatEvent>,
) -> Result<(), String> {
    check_path(&path)?;
    check_pane_key(&pane_key)?;
    state.stop();
    let (commands, receiver) = unbounded_channel();
    let closer = commands.clone();
    let task = tauri::async_runtime::spawn(run_session(
        environment,
        path,
        pane_key,
        receiver,
        move |event| {
            if channel.send(event).is_err() {
                let _ = closer.send(OrcaCommand::Close);
            }
        },
    ));
    *state.0.lock().unwrap() = Some(Active { task, commands });
    Ok(())
}

/// Ends the session that runs, if any.
#[tauri::command]
pub async fn orca_chat_close(state: tauri::State<'_, OrcaChat>) -> Result<(), String> {
    state.stop();
    Ok(())
}

/// Reads the page of older messages of the session that runs.
#[tauri::command]
pub async fn orca_chat_older(state: tauri::State<'_, OrcaChat>) -> Result<(), String> {
    if let Some(active) = state.0.lock().unwrap().as_ref() {
        let _ = active.commands.send(OrcaCommand::Older);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(role: &str, id: &str, text: &str) -> Value {
        json!({"id": id, "role": role, "blocks": [{"type": "text", "text": text}]})
    }

    fn call(id: &str, name: &str, input: Value, call_id: &str) -> Value {
        json!({"id": id, "role": "assistant", "blocks": [
            {"type": "tool-call", "name": name, "input": input, "callId": call_id}]})
    }

    fn result(id: &str, call_id: &str) -> Value {
        json!({"id": id, "role": "tool", "blocks": [
            {"type": "tool-result", "output": "SECRET OUTPUT", "callId": call_id}]})
    }

    fn held(messages: &[Value]) -> Vec<Held> {
        messages.iter().filter_map(held_of).collect()
    }

    fn items(messages: &[Value]) -> Vec<OrcaChatItem> {
        items_of(&held(messages), &HashSet::new())
    }

    fn user(id: &str, text: &str) -> OrcaChatItem {
        OrcaChatItem::User {
            id: id.into(),
            text: text.into(),
        }
    }

    fn assistant(id: &str, text: &str) -> OrcaChatItem {
        OrcaChatItem::Assistant {
            id: id.into(),
            text: text.into(),
        }
    }

    // -- noise --

    #[test]
    fn harness_turns_are_known_by_their_tag_or_their_opening() {
        for yes in [
            "<system-reminder>x</system-reminder>",
            "  \n<Command-Name>/clear</command-name>",
            "<local-command-stdout>ok",
            "<bash-input>ls</bash-input>",
            "<task-notification>",
            "<teammate-message teammate_id=\"a\">",
            "<channel source=\"x\">hi",
            "[Request interrupted by user]",
            "A message arrived from another session",
            "Another Claude session sent a message",
            "No response requested.",
            "Caveat: The messages below were generated by the user while running local commands. DO NOT respond",
            "This session is being continued from a previous conversation that ran out of context.",
            "<system-reminder",
        ] {
            assert!(is_harness_turn(yes), "{yes}");
        }
        for no in [
            "",
            "   ",
            "hello",
            "<channel>rss</channel>",
            "<custom-tag>x</custom-tag>",
            "<system-reminders>x",
            "<system-reminder-x>",
            "< system-reminder>",
            "text <system-reminder>",
            "[request",
            "please summarize this session is being continued",
            "<user_query>x</user_query>",
        ] {
            assert!(!is_harness_turn(no), "{no}");
        }
    }

    #[test]
    fn only_so_many_leading_spaces_are_skipped() {
        let tag = "<system-reminder>x";
        assert!(is_harness_turn(&format!("{}{tag}", " ".repeat(64))));
        assert!(!is_harness_turn(&format!("{}{tag}", " ".repeat(65))));
        assert!(!is_harness_turn(&" ".repeat(10)));
    }

    #[test]
    fn a_noise_message_is_kept_but_draws_nothing() {
        let messages = [
            text("user", "n1", "<system-reminder>x</system-reminder>"),
            text("user", "u1", "hello"),
            // A turn with a tool block is never noise.
            json!({"id": "n2", "role": "user", "blocks": [
                {"type": "text", "text": "<system-reminder>x"},
                {"type": "tool-result", "callId": "k"}]}),
            json!({"id": "s", "role": "assistant", "agentStart": true,
                "blocks": [{"type": "text", "text": "start"}]}),
            json!({"id": "s2", "role": "assistant", "agentStart": false,
                "blocks": [{"type": "text", "text": "answer"}]}),
        ];
        let held = held(&messages);
        assert_eq!(held.len(), 5);
        assert!(held[0].blocks.is_empty());
        assert!(held[3].blocks.is_empty());
        // The turn with a tool block is not noise, so Orca draws it as the user's.
        assert_eq!(
            items_of(&held, &HashSet::new()),
            [
                user("u1", "hello"),
                user("n2", "<system-reminder>x"),
                assistant("s2", "answer")
            ]
        );
    }

    #[test]
    fn image_source_lines_are_dropped_from_user_text() {
        for yes in [
            "[Image: source: /tmp/a b.png]",
            "[Image:source:/x]  ",
            "[Image:   source:   /x]",
            "[Image: source: ]",
        ] {
            assert!(is_image_source_line(yes), "{yes}");
        }
        for no in [
            "[Image #1]",
            "[Image: source:]",
            "[Image: source: /x",
            "see [Image: source: /x]",
            "[image: source: /x]",
            "",
        ] {
            assert!(!is_image_source_line(no), "{no}");
        }
        let user_text = "[Image: source: /tmp/a.png]\nlook at this\n[Image: source: /tmp/b.png]";
        assert_eq!(
            items(&[text("user", "u", user_text)]),
            [user("u", "look at this")]
        );
        // Only such lines: the message is dropped.
        assert!(items(&[text("user", "u", "[Image: source: /tmp/a.png]")]).is_empty());
        // An assistant's text is left as written.
        assert_eq!(
            items(&[text("assistant", "a", "[Image: source: /x]")]),
            [assistant("a", "[Image: source: /x]")]
        );
    }

    // -- reducing --

    #[test]
    fn a_message_without_an_id_is_dropped_and_the_rest_is_tolerated() {
        for message in [
            json!({"role": "user", "blocks": []}),
            json!({"id": "", "role": "user"}),
            json!(7),
            Value::Null,
        ] {
            assert!(held_of(&message).is_none(), "{message}");
        }
        let odd =
            held_of(&json!({"id": "x", "blocks": [null, 3, {"type": "image"}, {"type": "text"}]}));
        assert_eq!(odd.unwrap().blocks, []);
        // Text of a reasoning, tool or system message is not drawn.
        for role in ["reasoning", "tool", "system"] {
            let m = held_of(&text(role, "r", "thinking"));
            assert_eq!(m.unwrap().blocks, [], "{role}");
        }
    }

    #[test]
    fn a_tool_call_keeps_its_name_its_detail_and_no_output() {
        let m = held_of(&call(
            "m",
            "Bash",
            json!({"command": "ls -la\nsecond", "description": "list"}),
            "k1",
        ))
        .unwrap();
        assert_eq!(
            m.blocks,
            [Block::Call {
                name: "Bash".into(),
                detail: "ls -la".into(),
                call_id: Some("k1".into())
            }]
        );
        let r = held_of(&result("r", "k1")).unwrap();
        assert!(!format!("{r:?}").contains("SECRET"));
        assert_eq!(
            r.blocks,
            [Block::Result {
                call_id: Some("k1".into())
            }]
        );
    }

    #[test]
    fn the_detail_is_the_first_key_that_is_a_string() {
        let cases = [
            (json!({"file_path": "/a", "command": "ls"}), "/a"),
            (json!({"path": "/p", "pattern": "x"}), "/p"),
            (json!({"notebook_path": "/n.ipynb"}), "/n.ipynb"),
            (json!({"pattern": "foo", "query": "q"}), "foo"),
            (json!({"query": "q", "url": "u"}), "q"),
            (json!({"url": "https://example.com"}), "https://example.com"),
            (json!({"description": "d", "prompt": "p"}), "d"),
            (json!({"prompt": "p"}), "p"),
            // A key that is not a string is passed over.
            (json!({"file_path": 3, "command": "ls"}), "ls"),
            (json!({"other": "x"}), ""),
            (json!("text"), ""),
            (Value::Null, ""),
        ];
        for (input, expected) in cases {
            assert_eq!(detail_of(&input), expected, "{input}");
        }
        assert_eq!(
            detail_of(&json!({"command": "あ".repeat(500)}))
                .chars()
                .count(),
            200
        );
    }

    #[test]
    fn a_page_reads_its_messages_and_offsets() {
        let page = page_of(&json!({
            "messages": [text("user", "a", "x"), json!(null)],
            "hasMore": true, "beforeOffset": 1234,
        }))
        .unwrap();
        assert_eq!(page.messages.len(), 1);
        assert!(page.has_more);
        assert_eq!(page.before_offset, Some(1234));
        let bare = page_of(&json!({"messages": []})).unwrap();
        assert!(!bare.has_more);
        assert_eq!(bare.before_offset, None);
        assert!(page_of(&json!({"notFound": true})).is_none());
        assert!(page_of(&json!({"messages": "x"})).is_none());
        assert!(page_of(&Value::Null).is_none());
    }

    #[test]
    fn a_streamed_answer_is_told_by_its_type() {
        let m = text("user", "a", "x");
        assert!(matches!(
            streamed_of(&json!({"type": "snapshot", "messages": [m], "hasMore": false, "beforeOffset": 0})),
            Streamed::Snapshot(p) if p.messages.len() == 1
        ));
        assert!(matches!(
            streamed_of(
                &json!({"type": "snapshot", "messages": [], "error": "Transcript unavailable"})
            ),
            Streamed::SnapshotFailed
        ));
        assert!(matches!(
            streamed_of(&json!({"type": "replacement", "messages": [m], "hasMore": true, "beforeOffset": 5})),
            Streamed::Replacement(p) if p.has_more && p.before_offset == Some(5)
        ));
        assert!(matches!(
            streamed_of(&json!({"type": "appended", "messages": [m]})),
            Streamed::Appended(v) if v.len() == 1
        ));
        assert!(matches!(
            streamed_of(&json!({"type": "end"})),
            Streamed::End
        ));
        for other in [json!({"type": "something"}), json!({}), Value::Null] {
            assert!(matches!(streamed_of(&other), Streamed::Other));
        }
    }

    // -- merging --

    fn ids(held: &[Held]) -> Vec<&str> {
        held.iter().map(|m| m.id.as_str()).collect()
    }

    fn msgs(ids: &[&str]) -> Vec<Held> {
        held(
            &ids.iter()
                .map(|id| text("user", id, id))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn a_snapshot_keeps_the_older_messages_in_front_of_it() {
        let mut h = msgs(&["a", "b", "c", "d"]);
        let kept = merge_snapshot(&mut h, msgs(&["c", "d", "e"]));
        assert_eq!(kept, 2);
        assert_eq!(ids(&h), ["a", "b", "c", "d", "e"]);
        // The snapshot's copy of a message is the one that stands.
        let mut h = msgs(&["a", "b"]);
        let mut snap = msgs(&["b"]);
        snap[0].blocks = vec![Block::Text("new".into())];
        merge_snapshot(&mut h, snap);
        assert_eq!(h[1].blocks, [Block::Text("new".into())]);
    }

    #[test]
    fn a_snapshot_with_no_id_in_common_stands_alone() {
        let mut h = msgs(&["a", "b"]);
        let kept = merge_snapshot(&mut h, msgs(&["x", "y"]));
        assert_eq!(kept, 0);
        assert_eq!(ids(&h), ["x", "y"]);
        let mut empty = Vec::new();
        assert_eq!(merge_snapshot(&mut empty, msgs(&["x"])), 0);
        let mut h = msgs(&["a"]);
        merge_snapshot(&mut h, Vec::new());
        assert!(h.is_empty());
    }

    #[test]
    fn a_snapshot_never_duplicates_an_id() {
        let mut h = msgs(&["a", "b", "c"]);
        merge_snapshot(&mut h, msgs(&["x", "b", "c", "d"]));
        let mut seen = ids(&h);
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), h.len());
        assert_eq!(ids(&h), ["a", "x", "b", "c", "d"]);
    }

    #[test]
    fn an_appended_message_replaces_by_id_or_goes_last() {
        let mut h = msgs(&["a", "b"]);
        let mut changed = msgs(&["a"]);
        changed[0].blocks = vec![Block::Text("changed".into())];
        let mut again = changed.clone();
        again.extend(msgs(&["c", "c"]));
        merge_appended(&mut h, again);
        assert_eq!(ids(&h), ["a", "b", "c"]);
        assert_eq!(h[0].blocks, [Block::Text("changed".into())]);
    }

    #[test]
    fn older_messages_go_in_front_without_the_ones_held() {
        let mut h = msgs(&["c", "d"]);
        prepend_older(&mut h, msgs(&["a", "b", "c"]));
        assert_eq!(ids(&h), ["a", "b", "c", "d"]);
        let mut h = msgs(&["a"]);
        prepend_older(&mut h, msgs(&["a"]));
        assert_eq!(ids(&h), ["a"]);
    }

    // -- the timeline --

    #[test]
    fn text_is_the_users_and_the_assistants_only() {
        let timeline = items(&[
            text("user", "u1", "hi"),
            text("reasoning", "r1", "hmm"),
            text("assistant", "a1", "hello"),
            text("system", "s1", "sys"),
        ]);
        assert_eq!(timeline, [user("u1", "hi"), assistant("a1", "hello")]);
    }

    #[test]
    fn a_message_with_text_and_calls_gives_the_text_first_in_block_order() {
        let timeline = items(&[json!({"id": "a", "role": "assistant", "blocks": [
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
            {"type": "tool-call", "name": "Read", "input": {"file_path": "/x"}, "callId": "k"},
            {"type": "text", "text": "after"},
        ]})]);
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[0], assistant("a", "first\n\nsecond"));
        assert!(
            matches!(&timeline[1], OrcaChatItem::Tools { id, calls, .. } if id == "a#c2" && calls.len() == 1)
        );
        assert_eq!(timeline[2], assistant("a#t1", "after"));
    }

    #[test]
    fn consecutive_calls_fold_into_one_run_that_results_and_unseen_messages_do_not_break() {
        let timeline = items(&[
            text("user", "u", "go"),
            call("c1", "Read", json!({"file_path": "/a"}), "k1"),
            result("r1", "k1"),
            text("reasoning", "think", "..."),
            call("c2", "Edit", json!({"file_path": "/a"}), "k2"),
            text("user", "n", "<system-reminder>x"),
            result("r2", "k2"),
            call("c3", "Read", json!({"file_path": "/b"}), "k3"),
            result("r3", "k3"),
            text("assistant", "a", "done"),
        ]);
        assert_eq!(timeline.len(), 3);
        assert_eq!(
            timeline[1],
            OrcaChatItem::Tools {
                id: "c1#c0".into(),
                summary: "ツールを 3 回実行（Read 2、Edit 1）".into(),
                running_summary: None,
                calls: vec![
                    OrcaToolCall {
                        name: "Read".into(),
                        detail: "/a".into()
                    },
                    OrcaToolCall {
                        name: "Edit".into(),
                        detail: "/a".into()
                    },
                    OrcaToolCall {
                        name: "Read".into(),
                        detail: "/b".into()
                    },
                ],
            }
        );
        // Text breaks the run: a second run is a new item.
        let timeline = items(&[
            call("c1", "Read", json!({}), "k1"),
            text("assistant", "a", "between"),
            call("c2", "Bash", json!({}), "k2"),
        ]);
        assert_eq!(timeline.len(), 3);
    }

    #[test]
    fn a_runs_id_is_stable_while_it_grows() {
        let mut messages = vec![text("user", "u", "go"), call("c1", "Read", json!({}), "k1")];
        let before = items(&messages);
        messages.push(call("c2", "Edit", json!({}), "k2"));
        let after = items(&messages);
        let id = |items: &[OrcaChatItem]| match &items[1] {
            OrcaChatItem::Tools { id, .. } => id.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(id(&before), id(&after));
    }

    #[test]
    fn a_run_keeps_its_id_when_an_older_page_ends_in_calls() {
        let page = |id: &str, name: &str| {
            held_of(&json!({"id": id, "role": "assistant", "blocks": [
                {"type": "tool-call", "name": name, "input": {}, "callId": id},
            ]}))
            .unwrap()
        };
        let ids = |items: &[OrcaChatItem]| -> Vec<String> {
            items
                .iter()
                .map(|i| match i {
                    OrcaChatItem::Tools { id, .. } => id.clone(),
                    other => panic!("{other:?}"),
                })
                .collect()
        };
        let newer = vec![page("c", "Edit"), page("d", "Bash")];
        let before = ids(&items_of(&newer, &HashSet::new()));
        let mut held = newer;
        let mut starts = HashSet::new();
        starts.insert(held[0].id.clone());
        prepend_older(&mut held, vec![page("a", "Read"), page("b", "Read")]);
        // Older calls stand as a run of their own, and the run that was on screen has the same id.
        assert_eq!(
            ids(&items_of(&held, &starts)),
            vec!["a#c0".to_owned(), before[0].clone()]
        );
        // Without the mark they would join it under an older id.
        assert_eq!(
            ids(&items_of(&held, &HashSet::new())),
            vec!["a#c0".to_owned()]
        );
    }

    fn running(timeline: &[OrcaChatItem]) -> Option<String> {
        match timeline.last() {
            Some(OrcaChatItem::Tools {
                running_summary, ..
            }) => running_summary.clone(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_run_at_the_end_with_a_call_without_a_result_is_running() {
        let timeline = items(&[
            call("c1", "Edit", json!({}), "k1"),
            call("c2", "Edit", json!({}), "k2"),
            call("c3", "Read", json!({}), "k3"),
            result("r1", "k1"),
            result("r3", "k3"),
        ]);
        assert_eq!(
            running(&timeline).as_deref(),
            Some("ツールを実行中（Edit 2、Read 1）")
        );
        // All have results: not running.
        let done = items(&[call("c1", "Edit", json!({}), "k1"), result("r1", "k1")]);
        assert_eq!(running(&done), None);
        // A run that is not the last item is not running, even without a result.
        let not_last = items(&[
            call("c1", "Edit", json!({}), "k1"),
            text("assistant", "a", "moved on"),
        ]);
        assert!(matches!(
            &not_last[0],
            OrcaChatItem::Tools {
                running_summary: None,
                ..
            }
        ));
    }

    #[test]
    fn without_call_ids_the_counts_decide() {
        let bare_call = |id: &str| {
            json!({"id": id, "role": "assistant", "blocks": [
            {"type": "tool-call", "name": "Bash", "input": {}}]})
        };
        let bare_result = |id: &str| {
            json!({"id": id, "role": "tool", "blocks": [
            {"type": "tool-result"}]})
        };
        let two_one = items(&[bare_call("a"), bare_call("b"), bare_result("r")]);
        assert_eq!(
            running(&two_one).as_deref(),
            Some("ツールを実行中（Bash 2）")
        );
        let two_two = items(&[
            bare_call("a"),
            bare_call("b"),
            bare_result("r"),
            bare_result("s"),
        ]);
        assert_eq!(running(&two_two), None);
    }

    #[test]
    fn what_changed_is_found_from_the_first_difference() {
        let a = vec![user("1", "a"), assistant("2", "b"), user("3", "c")];
        assert_eq!(changed_from(&a, &a), 3);
        assert_eq!(changed_from(&[], &a), 0);
        assert_eq!(changed_from(&a, &[]), 0);
        assert_eq!(changed_from(&a, &a[..2]), 2);
        assert_eq!(changed_from(&a[..1], &a), 1);
        let mut b = a.clone();
        b[1] = assistant("2", "changed");
        assert_eq!(changed_from(&a, &b), 1);
        b[0] = user("1", "first");
        assert_eq!(changed_from(&a, &b), 0);
    }

    #[test]
    fn an_items_event_is_sent_only_when_something_changed() {
        let a = vec![user("1", "a"), assistant("2", "b")];
        assert_eq!(items_event(&a, &a, false, false), None);
        assert_eq!(items_event(&[], &[], false, false), None);
        assert_eq!(
            items_event(&a, &a, false, true),
            Some(OrcaChatEvent::Items {
                start: 2,
                items: vec![],
                has_more: true
            })
        );
        let mut grown = a.clone();
        grown.push(user("3", "c"));
        assert_eq!(
            items_event(&a, &grown, false, false),
            Some(OrcaChatEvent::Items {
                start: 2,
                items: vec![user("3", "c")],
                has_more: false
            })
        );
        // Dropped from the end.
        assert_eq!(
            items_event(&a, &a[..1], false, false),
            Some(OrcaChatEvent::Items {
                start: 1,
                items: vec![],
                has_more: false
            })
        );
        assert_eq!(
            items_event(&a, &[], false, false),
            Some(OrcaChatEvent::Items {
                start: 0,
                items: vec![],
                has_more: false
            })
        );
    }

    #[test]
    fn the_events_are_tagged_by_kind_in_camel_case() {
        let event = OrcaChatEvent::Items {
            start: 1,
            items: vec![OrcaChatItem::Tools {
                id: "t".into(),
                summary: "s".into(),
                running_summary: Some("r".into()),
                calls: vec![OrcaToolCall {
                    name: "n".into(),
                    detail: "d".into(),
                }],
            }],
            has_more: true,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({"kind": "items", "start": 1, "hasMore": true, "items": [{
                "kind": "tools", "id": "t", "summary": "s", "runningSummary": "r",
                "calls": [{"name": "n", "detail": "d"}],
            }]})
        );
        assert_eq!(
            serde_json::to_value(OrcaChatEvent::Status {
                state: OrcaChatState::Reconnecting,
                message: "m".into()
            })
            .unwrap(),
            json!({"kind": "status", "state": "reconnecting", "message": "m"})
        );
    }

    #[test]
    fn the_wait_before_connecting_again_grows_to_thirty_seconds() {
        let waits: Vec<u64> = (0..7).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(waits, [1, 2, 5, 10, 30, 30, 30]);
        assert_eq!(backoff(usize::MAX).as_secs(), 30);
    }

    // -- the pairing --

    fn environments() -> Value {
        json!({"environments": [
            "plain",
            {"id": "env-1", "name": "Studio", "preferredEndpointId": "e2", "endpoints": [
                {"id": "e1", "kind": "websocket", "endpoint": "ws://10.0.0.1:6768", "deviceToken": "tok1", "publicKeyB64": "key1"},
                {"id": "e2", "kind": "websocket", "endpoint": "ws://10.0.0.2:6768", "deviceToken": "tok2", "publicKeyB64": "key2"},
            ]},
            {"id": "env-2", "endpoints": [
                {"id": "r", "kind": "relay", "endpoint": "wss://relay.example/x", "deviceToken": "t", "publicKeyB64": "k"},
                {"id": "w", "kind": "websocket", "endpoint": "WS://lan:1", "deviceToken": "tok3", "publicKeyB64": "key3"},
            ]},
            {"name": "Tls", "endpoints": [
                {"id": "w", "kind": "websocket", "endpoint": "wss://host:1", "deviceToken": "t", "publicKeyB64": "k"}]},
            {"name": "NoToken", "endpoints": [
                {"id": "w", "kind": "websocket", "endpoint": "ws://host:1", "publicKeyB64": "k"}]},
            {"name": "NoEndpoint", "endpoints": [{"id": "r", "kind": "relay", "endpoint": "ws://x"}]},
        ]})
    }

    fn ws_of(pairing: Result<Pairing, String>) -> (String, String, String) {
        match pairing {
            Ok(Pairing::WebSocket {
                url,
                device_token,
                public_key_b64,
            }) => (url, device_token, public_key_b64),
            Ok(Pairing::Unix { .. }) => panic!("unix"),
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn an_environment_is_chosen_by_name_else_id_and_its_preferred_endpoint() {
        let doc = environments();
        assert_eq!(
            ws_of(environment_pairing(&doc, "Studio")),
            ("ws://10.0.0.2:6768".into(), "tok2".into(), "key2".into())
        );
        // An environment without a name is listed by its id; with no preferred endpoint the first WebSocket one is used.
        assert_eq!(
            ws_of(environment_pairing(&doc, "env-2")),
            ("WS://lan:1".into(), "tok3".into(), "key3".into())
        );
        // A name hides the id.
        assert!(environment_pairing(&doc, "env-1").is_err());
        assert!(environment_pairing(&doc, "plain").is_err());
        assert!(environment_pairing(&doc, "studio").is_err());
    }

    #[test]
    fn only_a_ws_endpoint_with_a_token_and_a_key_is_used() {
        let doc = environments();
        for name in ["Tls", "NoToken", "NoEndpoint", "Missing"] {
            assert!(environment_pairing(&doc, name).is_err(), "{name}");
        }
        assert!(environment_pairing(&Value::Null, "Studio").is_err());
        assert!(environment_pairing(&json!({"environments": null}), "Studio").is_err());
        let tls = environment_pairing(&doc, "Tls").err().unwrap();
        assert!(tls.contains("ws://"));
        // A token never reaches an error text.
        for name in ["Tls", "NoToken", "NoEndpoint"] {
            let message = environment_pairing(&doc, name).err().unwrap();
            assert!(!message.contains("tok"), "{message}");
        }
    }

    #[test]
    fn this_machine_is_the_unix_transport_of_the_runtime_file() {
        let doc = json!({"authToken": "secret", "transports": [
            {"kind": "ws", "endpoint": "ws://x"},
            {"kind": "unix", "endpoint": "/tmp/orca.sock"},
        ]});
        assert!(matches!(
            runtime_pairing(&doc),
            Ok(Pairing::Unix { endpoint, token }) if endpoint == "/tmp/orca.sock" && token == "secret"
        ));
        for bad in [
            json!({"transports": [{"kind": "unix", "endpoint": "/tmp/x"}]}),
            json!({"authToken": "t", "transports": [{"kind": "ws", "endpoint": "/tmp/x"}]}),
            json!({"authToken": "t", "transports": [{"kind": "unix", "endpoint": "relative.sock"}]}),
            json!({"authToken": "t"}),
            Value::Null,
        ] {
            let error = runtime_pairing(&bad).err().unwrap();
            assert!(
                !error.contains('t') || error.contains("orca-runtime.json"),
                "{error}"
            );
        }
    }

    // -- the tabs and the answers --

    #[test]
    fn the_session_is_found_by_the_pane_of_the_agent() {
        let tabs = json!({"tabs": [
            {"id": "t1", "agentStatus": {"paneKey": "tabA:leaf1", "providerSession": {"id": "sess-1"}}},
            {"id": "t2", "agentStatus": {"paneKey": "tabB:leaf2"}},
            {"id": "t3"},
            {"id": "t4", "agentStatus": {"paneKey": "tabC:leaf3", "providerSession": {"id": " "}}},
            {"id": "t5", "agentStatus": {"paneKey": "tabD:leaf4", "providerSession": {"id": "sess-4"}}},
        ]});
        assert_eq!(
            session_id_of(&tabs, "tabA:leaf1").as_deref(),
            Some("sess-1")
        );
        assert_eq!(
            session_id_of(&tabs, "tabD:leaf4").as_deref(),
            Some("sess-4")
        );
        for none in ["tabB:leaf2", "tabC:leaf3", "tabX:leafX", ""] {
            assert_eq!(session_id_of(&tabs, none), None, "{none}");
        }
        assert_eq!(session_id_of(&Value::Null, "a"), None);
        assert_eq!(session_id_of(&json!({"tabs": 3}), "a"), None);
    }

    #[test]
    fn an_answer_gives_its_result_or_the_code_and_never_the_message() {
        assert_eq!(
            result_of(&json!({"id": "1", "ok": true, "result": {"a": 1}})).ok(),
            Some(json!({"a": 1}))
        );
        let remote = |v: Value| match result_of(&v) {
            Err(LinkError::Remote(m)) => m,
            _ => panic!("{v}"),
        };
        assert_eq!(
            remote(
                json!({"ok": false, "error": {"code": "not_found", "message": "secret path /x"}})
            ),
            "Orca がエラーを返しました（not_found）"
        );
        assert_eq!(remote(json!({"ok": false})), "Orca がエラーを返しました");
        // Odd characters of a code are dropped and the code is cut.
        let odd =
            remote(json!({"ok": false, "error": {"code": format!("a b\n{}", "x".repeat(100))}}));
        assert!(!odd.contains(' ') || odd.starts_with("Orca がエラーを返しました（"));
        assert!(odd.chars().count() < 100);
        assert!(matches!(
            result_of(&json!({"id": "1"})),
            Err(LinkError::Broken(_))
        ));
        assert!(matches!(result_of(&Value::Null), Err(LinkError::Broken(_))));
    }

    #[test]
    fn a_pane_key_has_only_the_characters_of_an_id() {
        for ok in ["tabA:leaf1", "a1b2c3d4-e5f6-7890:leaf_2", &"a".repeat(256)] {
            assert!(check_pane_key(ok).is_ok(), "{ok}");
        }
        for bad in ["", "a b", "a;b", "a/b", "--x y", "é", &"a".repeat(257)] {
            assert!(check_pane_key(bad).is_err(), "{bad}");
        }
    }

    // -- the sockets --

    use std::sync::{Arc, Mutex};

    use tokio::net::TcpListener;

    use crate::orca_e2ee::testing::Desktop;

    /// Orca's side of a paired connection, over a local socket.
    struct FakeDesktop {
        socket: WebSocketStream<tokio::net::TcpStream>,
        desktop: Desktop,
    }

    async fn next_text(socket: &mut WebSocketStream<tokio::net::TcpStream>) -> String {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => return text.as_str().to_owned(),
                Message::Ping(_) | Message::Pong(_) => {}
                other => panic!("{other:?}"),
            }
        }
    }

    impl FakeDesktop {
        /// Takes a connection, answers the hello, and checks the auth frame before it says the client is authenticated (`reply` unset) or refuses it.
        async fn accept(
            listener: &TcpListener,
            mut desktop: Desktop,
            token: &str,
            reply: Option<Value>,
        ) -> Self {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let hello = next_text(&mut socket).await;
            socket
                .send(Message::text(desktop.ready_for(&hello)))
                .await
                .unwrap();
            let auth = desktop.open_text(&next_text(&mut socket).await).unwrap();
            let auth: Value = serde_json::from_str(&auth).unwrap();
            assert_eq!(auth["type"], "e2ee_auth");
            assert_eq!(auth["v"], 2);
            assert_eq!(auth["deviceToken"], token);
            assert_eq!(auth["transcriptHashB64"], desktop.transcript_hash_b64());
            assert_eq!(auth.as_object().unwrap().len(), 4);
            let reply = reply.unwrap_or_else(|| {
                json!({"type": "e2ee_authenticated", "v": 2, "transcriptHashB64": desktop.transcript_hash_b64()})
            });
            let sealed = desktop.seal_text(&reply.to_string());
            socket.send(Message::text(sealed)).await.unwrap();
            Self { socket, desktop }
        }

        /// The next request of the client, opened.
        async fn request(&mut self) -> Value {
            let text = next_text(&mut self.socket).await;
            serde_json::from_str(&self.desktop.open_text(&text).unwrap()).unwrap()
        }

        async fn send(&mut self, value: Value) {
            let sealed = self.desktop.seal_text(&value.to_string());
            self.socket.send(Message::text(sealed)).await.unwrap();
        }
    }

    async fn bind() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        (listener, url)
    }

    #[tokio::test]
    async fn a_websocket_handshakes_authenticates_and_answers_a_request() {
        let (listener, url) = bind().await;
        let desktop = Desktop::new([21; 32]);
        let key = desktop.public_key_b64();
        let server = tokio::spawn(async move {
            let mut server = FakeDesktop::accept(&listener, desktop, "device-token", None).await;
            let request = server.request().await;
            assert_eq!(request["method"], "session.tabs.list");
            assert_eq!(request["params"], json!({"worktree": "path:/w"}));
            assert_eq!(request["deviceToken"], "device-token");
            assert_eq!(request.as_object().unwrap().len(), 4);
            let id = request["id"].clone();
            // A keepalive, a binary frame, a streamed answer of another request, then the answer.
            server.send(json!({"_keepalive": true})).await;
            let binary = server.desktop.seal_binary(b"ignored");
            server.socket.send(Message::binary(binary)).await.unwrap();
            server
                .socket
                .send(Message::Ping(Vec::new().into()))
                .await
                .unwrap();
            server
                .send(json!({"id": "other", "ok": true, "result": {"type": "appended"}}))
                .await;
            server
                .send(json!({"id": id, "ok": true, "result": {"tabs": []}}))
                .await;
            // A failure of the next request.
            let request = server.request().await;
            server.send(json!({"id": request["id"], "ok": false, "error": {"code": "not_found", "message": "x"}})).await;
        });
        let mut link = WsLink::connect(&url, "device-token", &key).await.unwrap();
        let result = link
            .request("session.tabs.list", json!({"worktree": "path:/w"}))
            .await;
        assert_eq!(result.ok(), Some(json!({"tabs": []})));
        // The answer of the other request waits for whoever reads it.
        let queued = link.next_response().await.unwrap().unwrap();
        assert_eq!(queued["id"], "other");
        let failed = link.request("nativeChat.readSession", json!({})).await;
        assert!(matches!(failed, Err(LinkError::Remote(m)) if m.contains("not_found")));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn a_refused_token_or_another_key_fails_without_the_token_in_the_error() {
        let (listener, url) = bind().await;
        let desktop = Desktop::new([22; 32]);
        let key = desktop.public_key_b64();
        let server = tokio::spawn(async move {
            let refusal = json!({"type": "error", "error": {"code": "unauthorized"}});
            FakeDesktop::accept(&listener, desktop, "secret-token", Some(refusal)).await;
        });
        let error = WsLink::connect(&url, "secret-token", &key)
            .await
            .err()
            .unwrap();
        assert!(error.contains("認証"), "{error}");
        assert!(!error.contains("secret-token"));
        server.await.unwrap();

        // The desktop answers with a key other than the one the pairing names.
        let (listener, url) = bind().await;
        let other = Desktop::new([23; 32]);
        let pinned = Desktop::new([24; 32]).public_key_b64();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let hello = next_text(&mut socket).await;
            let mut other = other;
            socket
                .send(Message::text(other.ready_for(&hello)))
                .await
                .unwrap();
        });
        let error = WsLink::connect(&url, "secret-token", &pinned)
            .await
            .err()
            .unwrap();
        assert!(error.contains("鍵"), "{error}");
        server.await.unwrap();

        // Nobody listens; a pairing with a broken key.
        let (closed, url) = bind().await;
        drop(closed);
        assert!(
            WsLink::connect(&url, "t", &Desktop::new([1; 32]).public_key_b64())
                .await
                .is_err()
        );
        assert!(WsLink::connect(&url, "t", "bad key").await.is_err());
    }

    /// Orca's unix socket: one JSON line in, `answer` of it out (after a keepalive line), a connection at a time.
    fn unix_server(
        name: &str,
        answer: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) -> (String, Arc<Mutex<Vec<Value>>>) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let path = std::env::temp_dir().join(format!("ck-{}-{name}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&log);
        let answer = Arc::new(answer);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (seen, answer) = (Arc::clone(&seen), Arc::clone(&answer));
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut line = String::new();
                    BufReader::new(read).read_line(&mut line).await.unwrap();
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let response = answer(&request);
                    seen.lock().unwrap().push(request);
                    write.write_all(b"{\"_keepalive\":true}\n").await.unwrap();
                    write
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                });
            }
        });
        (path.to_str().unwrap().to_owned(), log)
    }

    #[tokio::test]
    async fn a_unix_call_sends_a_line_and_reads_the_answer() {
        let (path, log) = unix_server("call", |request| {
            if request["authToken"] != "runtime-token" {
                return json!({"id": request["id"], "ok": false, "error": {"code": "unauthorized"}});
            }
            json!({"id": request["id"], "ok": true, "result": {"echo": request["params"]}})
        });
        let result = unix_request(
            &path,
            "runtime-token",
            "session.tabs.list",
            json!({"worktree": "path:/w"}),
        )
        .await;
        assert_eq!(result.ok(), Some(json!({"echo": {"worktree": "path:/w"}})));
        {
            let seen = log.lock().unwrap();
            assert_eq!(seen[0]["method"], "session.tabs.list");
            assert_eq!(seen[0].as_object().unwrap().len(), 4);
        }
        let refused = unix_request(&path, "wrong", "x", json!({})).await;
        assert!(matches!(refused, Err(LinkError::Remote(m)) if m.contains("unauthorized")));
        let missing = unix_request("/nonexistent/orca.sock", "t", "x", json!({})).await;
        assert!(matches!(missing, Err(LinkError::Broken(m)) if m.contains("起動")));
    }

    // -- the session --

    type Events = tokio::sync::mpsc::UnboundedReceiver<OrcaChatEvent>;

    fn sink() -> (impl FnMut(OrcaChatEvent), Events) {
        let (tx, rx) = unbounded_channel();
        (move |event| drop(tx.send(event)), rx)
    }

    /// Collects the events until one satisfies `done`.
    async fn until(
        events: &mut Events,
        done: impl Fn(&OrcaChatEvent) -> bool,
    ) -> Vec<OrcaChatEvent> {
        let mut seen = Vec::new();
        loop {
            let event = timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("an event")
                .expect("the session ended");
            let stop = done(&event);
            seen.push(event);
            if stop {
                return seen;
            }
        }
    }

    fn status(state: OrcaChatState, message: &str) -> OrcaChatEvent {
        OrcaChatEvent::Status {
            state,
            message: message.into(),
        }
    }

    fn page(ids: &[&str], more: bool, offset: u32) -> Value {
        json!({
            "messages": ids.iter().map(|id| text("user", id, id)).collect::<Vec<_>>(),
            "hasMore": more, "beforeOffset": offset,
        })
    }

    fn tabs(pane: &str, session: &str) -> Value {
        json!({"tabs": [{"agentStatus": {"paneKey": pane, "providerSession": {"id": session}}}]})
    }

    const FAST: Timing = Timing {
        tabs_every: Duration::from_millis(60),
        poll_every: Duration::from_millis(15),
    };

    fn opener(
        pairing: impl Fn() -> Pairing,
    ) -> impl FnMut() -> std::future::Ready<Result<Link, String>> {
        move || {
            std::future::ready(match pairing() {
                Pairing::Unix { endpoint, token } => Ok(Link::Unix { endpoint, token }),
                Pairing::WebSocket { .. } => Err("not here".to_owned()),
            })
        }
    }

    #[tokio::test]
    async fn the_unix_session_reads_older_messages_and_follows_a_new_session() {
        let tabs_calls = Arc::new(Mutex::new(0usize));
        let counter = Arc::clone(&tabs_calls);
        let (path, log) = unix_server("session", move |request| {
            let id = request["id"].clone();
            let result = match request["method"].as_str().unwrap() {
                "session.tabs.list" => {
                    assert_eq!(request["params"], json!({"worktree": "path:/w"}));
                    let mut n = counter.lock().unwrap();
                    *n += 1;
                    // The session changes (a /clear) from the fifth look.
                    tabs("tab:leaf", if *n < 5 { "s1" } else { "s2" })
                }
                "nativeChat.readSession" => match (
                    request["params"]["sessionId"].as_str(),
                    request["params"].get("beforeOffset"),
                ) {
                    (Some("s1"), None) => page(&["m3", "m4"], true, 7),
                    (Some("s1"), Some(offset)) => {
                        assert_eq!(*offset, 7);
                        assert_eq!(request["params"]["limit"], 100);
                        page(&["m1", "m2"], false, 0)
                    }
                    (Some("s2"), None) => page(&["n1"], false, 0),
                    other => panic!("{other:?}"),
                },
                other => panic!("{other}"),
            };
            json!({"id": id, "ok": true, "result": result})
        });
        let (commands, receiver) = unbounded_channel();
        let (sink, mut events) = sink();
        let task = tokio::spawn(run_loop(
            opener(move || Pairing::Unix {
                endpoint: path.clone(),
                token: "t".into(),
            }),
            "/w".into(),
            "tab:leaf".into(),
            receiver,
            FAST,
            sink,
        ));
        let first = until(&mut events, |e| {
            matches!(
                e,
                OrcaChatEvent::Status {
                    state: OrcaChatState::Live,
                    ..
                }
            )
        })
        .await;
        let ids = |e: &OrcaChatEvent| match e {
            OrcaChatEvent::Items {
                start,
                items,
                has_more,
            } => Some((
                *start,
                items
                    .iter()
                    .map(|i| match i {
                        OrcaChatItem::User { id, .. }
                        | OrcaChatItem::Assistant { id, .. }
                        | OrcaChatItem::Tools { id, .. } => id.clone(),
                    })
                    .collect::<Vec<_>>(),
                *has_more,
            )),
            OrcaChatEvent::Status { .. } => None,
        };
        let drawn: Vec<_> = first.iter().filter_map(ids).collect();
        assert_eq!(drawn, [(0, vec!["m3".to_owned(), "m4".to_owned()], true)]);
        assert_eq!(first[0], status(OrcaChatState::Connecting, ""));
        // Older messages go in front, and the polling does not undo them.
        commands.send(OrcaCommand::Older).unwrap();
        let older = until(&mut events, |e| {
            matches!(e, OrcaChatEvent::Items { start: 0, .. })
        })
        .await;
        let drawn: Vec<_> = older.iter().filter_map(ids).collect();
        assert_eq!(
            drawn,
            [(
                0,
                ["m1", "m2", "m3", "m4"].map(String::from).to_vec(),
                false
            )]
        );
        // The new session drops the old messages, then shows its own.
        let after = until(&mut events, |e| {
            matches!(
                e,
                OrcaChatEvent::Status {
                    state: OrcaChatState::Live,
                    ..
                }
            )
        })
        .await;
        let drawn: Vec<_> = after.iter().filter_map(ids).collect();
        assert_eq!(
            drawn,
            [(0, vec![], false), (0, vec!["n1".to_owned()], false)]
        );
        assert!(after.contains(&status(OrcaChatState::Connecting, "")));
        commands.send(OrcaCommand::Close).unwrap();
        task.await.unwrap();
        let reads = log
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "nativeChat.readSession")
            .count();
        assert!(reads >= 3);
    }

    #[tokio::test]
    async fn a_pane_without_a_session_is_unavailable_and_looked_for_again() {
        let calls = Arc::new(Mutex::new(0usize));
        let counter = Arc::clone(&calls);
        let (path, _) = unix_server("nosession", move |request| {
            let result = if request["method"] == "session.tabs.list" {
                let mut n = counter.lock().unwrap();
                *n += 1;
                if *n < 3 {
                    json!({"tabs": []})
                } else {
                    tabs("tab:leaf", "s1")
                }
            } else {
                page(&["m1"], false, 0)
            };
            json!({"id": request["id"], "ok": true, "result": result})
        });
        let (commands, receiver) = unbounded_channel();
        let (sink, mut events) = sink();
        let task = tokio::spawn(run_loop(
            opener(move || Pairing::Unix {
                endpoint: path.clone(),
                token: "t".into(),
            }),
            "/w".into(),
            "tab:leaf".into(),
            receiver,
            FAST,
            sink,
        ));
        let seen = until(&mut events, |e| {
            matches!(
                e,
                OrcaChatEvent::Status {
                    state: OrcaChatState::Live,
                    ..
                }
            )
        })
        .await;
        assert!(seen.contains(&status(OrcaChatState::Unavailable, UNAVAILABLE)));
        assert!(matches!(
            seen.last(),
            Some(OrcaChatEvent::Status {
                state: OrcaChatState::Live,
                ..
            })
        ));
        commands.send(OrcaCommand::Close).unwrap();
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_connection_is_tried_again_after_a_growing_wait() {
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&attempts);
        let (commands, receiver) = unbounded_channel();
        let (sink, mut events) = sink();
        let started = Instant::now();
        let task = tokio::spawn(run_loop(
            move || {
                let mut at = record.lock().unwrap();
                at.push(started.elapsed().as_secs());
                let n = at.len();
                std::future::ready(Err::<Link, _>(format!("failure {n}")))
            },
            "/w".into(),
            "tab:leaf".into(),
            receiver,
            FAST,
            sink,
        ));
        let seen = until(&mut events, |e| {
            *e == status(OrcaChatState::Reconnecting, "failure 3")
        })
        .await;
        assert_eq!(seen[0], status(OrcaChatState::Connecting, ""));
        assert_eq!(seen[1], status(OrcaChatState::Reconnecting, "failure 1"));
        // A request for older messages while waiting is dropped, not queued.
        commands.send(OrcaCommand::Older).unwrap();
        commands.send(OrcaCommand::Close).unwrap();
        task.await.unwrap();
        assert_eq!(*attempts.lock().unwrap(), [0, 1, 3]);
    }

    #[tokio::test]
    async fn the_websocket_session_subscribes_and_follows_the_stream() {
        let (listener, url) = bind().await;
        let desktop = Desktop::new([31; 32]);
        let key = desktop.public_key_b64();
        let server = tokio::spawn(async move {
            let mut server = FakeDesktop::accept(&listener, desktop, "device-token", None).await;
            let list = server.request().await;
            assert_eq!(list["method"], "session.tabs.list");
            server
                .send(json!({"id": list["id"], "ok": true, "result": tabs("tab:leaf", "s1")}))
                .await;
            let subscribe = server.request().await;
            assert_eq!(subscribe["method"], "nativeChat.subscribe");
            let params = &subscribe["params"];
            assert_eq!(params["agent"], "claude");
            assert_eq!(params["sessionId"], "s1");
            assert_eq!(params["limit"], 40);
            assert!(params["subscriptionId"]
                .as_str()
                .is_some_and(|s| !s.is_empty()));
            let sub = subscribe["id"].clone();
            let mut snapshot = page(&["m2", "m3"], true, 9);
            snapshot["type"] = json!("snapshot");
            server
                .send(json!({"id": sub, "ok": true, "result": snapshot}))
                .await;
            server.send(json!({"id": sub, "ok": true, "result": {"type": "appended", "messages": [text("assistant", "m4", "answer")]}})).await;
            // The screen asks for older messages: answered on the same connection, between stream frames.
            let older = server.request().await;
            assert_eq!(older["method"], "nativeChat.readSession");
            assert_eq!(older["params"]["beforeOffset"], 9);
            assert_eq!(older["params"]["limit"], 100);
            server.send(json!({"id": sub, "ok": true, "result": {"type": "appended", "messages": [text("assistant", "m4", "answer, longer")]}})).await;
            server
                .send(json!({"id": older["id"], "ok": true, "result": page(&["m1"], false, 0)}))
                .await;
            // The stream ends: the client subscribes again.
            server
                .send(json!({"id": sub, "ok": true, "result": {"type": "end"}}))
                .await;
            let again = server.request().await;
            let again = if again["method"] == "session.tabs.list" {
                server
                    .send(json!({"id": again["id"], "ok": true, "result": tabs("tab:leaf", "s1")}))
                    .await;
                server.request().await
            } else {
                again
            };
            assert_eq!(again["method"], "nativeChat.subscribe");
            assert_ne!(again["params"]["subscriptionId"], params["subscriptionId"]);
            let mut snapshot = page(&["m2", "m3", "m4"], true, 9);
            snapshot["type"] = json!("snapshot");
            server
                .send(json!({"id": again["id"], "ok": true, "result": snapshot}))
                .await;
            // The first subscription's late frames are ignored.
            server.send(json!({"id": sub, "ok": true, "result": {"type": "appended", "messages": [text("user", "late", "late")]}})).await;
            let mut replacement = page(&["z1"], false, 0);
            replacement["type"] = json!("replacement");
            server
                .send(json!({"id": again["id"], "ok": true, "result": replacement}))
                .await;
            server
        });
        let (commands, receiver) = unbounded_channel();
        let (sink, mut events) = sink();
        let task = tokio::spawn(run_loop(
            move || {
                let (url, key) = (url.clone(), key.clone());
                async move {
                    Link::open(Pairing::WebSocket {
                        url,
                        device_token: "device-token".into(),
                        public_key_b64: key,
                    })
                    .await
                }
            },
            "/w".into(),
            "tab:leaf".into(),
            receiver,
            FAST,
            sink,
        ));
        let first = until(&mut events, |e| {
            matches!(e, OrcaChatEvent::Items { start: 2, .. })
        })
        .await;
        assert!(first.contains(&status(OrcaChatState::Live, "")));
        commands.send(OrcaCommand::Older).unwrap();
        let older = until(&mut events, |e| matches!(e, OrcaChatEvent::Items { start: 0, items, has_more: false } if items.len() == 4)).await;
        assert!(matches!(older.last(), Some(OrcaChatEvent::Items { .. })));
        // The replacement drops everything held.
        let last = until(&mut events, |e| matches!(e, OrcaChatEvent::Items { items, .. } if items.len() == 1 && matches!(&items[0], OrcaChatItem::User { id, .. } if id == "z1"))).await;
        assert!(!last.iter().any(|e| matches!(e, OrcaChatEvent::Items { items, .. } if items.iter().any(|i| matches!(i, OrcaChatItem::User { id, .. } if id == "late")))));
        commands.send(OrcaCommand::Close).unwrap();
        task.await.unwrap();
        drop(server.await.unwrap());
    }
}
