//! Socket Mode (S-16): a connection to Slack for each workspace that has an App-Level Token, which tells the app at once when a message is posted, changed or deleted.
//! An event never builds a row: it names the channel (and the thread) whose messages are read again with the same calls as the list, and the screen is told to draw from the cache.
//! The tokens are in the keychain (`APP_TOKEN_SERVICE`), and never logged or sent to the screen.

use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, Once},
    time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
    time::{sleep, sleep_until, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
#[cfg(test)]
use ts_rs::TS;
use url::Url;

use super::{
    blocking, call, call_scoped_retrying, check_threads, check_watched, held_messages,
    is_bot_token, kept_channel_name, load_hidden, load_thread_seen, load_watched, load_workspaces,
    lookup_users, needing_lookup, own_user_id, people_of, raw_of, refresh_read_marks,
    thread_candidates, token_key, token_of, unread_threads, valid_channel, valid_ts, Channel,
    Payload, Raw, SlackState, TimelineCache, WatchKey, Watched, Workspace, HISTORY_LIMIT,
    USER_LOOKUPS,
};
use crate::{
    auth::{config_dir, delete_entry, Auth},
    gmail::log_failure,
};

const APP_TOKEN_SERVICE: &str = "jp.mysis.cookapps.slack-app";
/// The events the screen listens for.
/// `EVENT_DIRTY`: the cache changed, draw the list from it. `EVENT_RESYNC`: a connection was made, read the list in full. `EVENT_STATUS`: a `SocketStatus`.
const EVENT_DIRTY: &str = "slack-timeline-dirty";
const EVENT_RESYNC: &str = "slack-socket-resync";
const EVENT_STATUS: &str = "slack-socket-status";
/// Events of one channel that come within this long of the first one are read again once.
const DEBOUNCE: Duration = Duration::from_secs(1);
/// The most threads of one channel a single read again checks.
const THREADS_PER_REFRESH: usize = 5;
/// The least time between two reads of the same channel by events. A busy channel would otherwise be read every second (a history call, and up to `THREADS_PER_REFRESH` replies calls);
/// the events in between are not lost: they wait, merged (their threads are added), for the next read.
const CHANNEL_GAP: Duration = Duration::from_secs(10);
/// The most calls (`conversations.history` and `conversations.replies`, a read of a channel being 1 and 1 for each thread it checks) events may make for one workspace in `BUDGET_WINDOW`.
/// Slack allows about 50 a minute for each method (Tier 3) and a full read uses up to 40 `conversations.history` calls (`HISTORY_BUDGET`), so these are kept to 20 to leave it room:
/// a 429 stops the full read's history reads for the workspace (`TimelineCache::limit`). Reads over the budget wait for the next minute, merged, and are not dropped.
const EVENT_CALLS_PER_WINDOW: usize = 20;
const BUDGET_WINDOW: Duration = Duration::from_secs(60);
/// A ping goes out this often, and a connection that has sent no frame for `SILENCE_LIMIT` is taken as dead.
const PING_EVERY: Duration = Duration::from_secs(30);
const SILENCE_LIMIT: Duration = Duration::from_secs(90);
const CONNECT_DEADLINE: Duration = Duration::from_secs(15);
const BACKOFF_FIRST: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
const BAD_APP_TOKEN: &str = "App-Level Token は xapp- で始まります";
const NO_SUCH_WORKSPACE: &str = "このワークスペースは接続されていません";

/// Whether a workspace is connected by Socket Mode: `Off` has no App-Level Token (or Slack refused it).
#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum SocketState {
    Off,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct SocketStatus {
    team_id: String,
    state: SocketState,
}

/// An App-Level Token: `xapp-` and the characters Slack's are made of.
fn valid_app_token(token: &str) -> bool {
    token.len() > "xapp-".len()
        && token.starts_with("xapp-")
        && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The channel (and the thread of it) an event of Socket Mode says changed.
#[derive(Debug, PartialEq, Clone)]
struct ChannelEvent {
    channel: String,
    thread_ts: Option<String>,
}

/// What to read again for a channel: the channel's messages, and the threads that had an event.
#[derive(Debug, PartialEq, Clone)]
struct Refresh {
    channel: String,
    threads: Vec<String>,
}

#[derive(Debug, PartialEq)]
enum Disconnect {
    /// About ten seconds before Slack closes the connection: nothing to do yet.
    Warning,
    /// Slack closes it to refresh it: connect again at once.
    Refresh,
    /// Socket Mode was turned off, or another reason: connect again after a wait.
    Other,
}

#[derive(Debug, PartialEq)]
enum Frame {
    Hello,
    Disconnect(Disconnect),
    /// A payload to answer with its `envelope_id`; `event` is set when it is a message event of a channel of this workspace.
    Envelope {
        id: String,
        event: Option<ChannelEvent>,
    },
    Other,
}

/// The frame a text message of the socket is. `team_id` is the workspace the connection is for: another workspace's event is not this one's.
fn parse_frame(text: &str, team_id: &str) -> Frame {
    let Ok(frame) = serde_json::from_str::<Value>(text) else {
        return Frame::Other;
    };
    match frame["type"].as_str() {
        Some("hello") => return Frame::Hello,
        Some("disconnect") => {
            return Frame::Disconnect(match frame["reason"].as_str() {
                Some("warning") => Disconnect::Warning,
                Some("refresh_requested") => Disconnect::Refresh,
                _ => Disconnect::Other,
            })
        }
        _ => {}
    }
    match frame["envelope_id"].as_str().filter(|id| !id.is_empty()) {
        Some(id) => Frame::Envelope {
            id: id.to_owned(),
            event: if frame["type"] == "events_api" {
                event_of(&frame["payload"], team_id)
            } else {
                None
            },
        },
        None => Frame::Other,
    }
}

/// The answer to an envelope: Slack resends what is not answered.
fn ack_text(envelope_id: &str) -> String {
    json!({ "envelope_id": envelope_id }).to_string()
}

/// The channel of a message event of a public or private channel of `team_id` (posted, changed or deleted), and its thread.
/// Direct messages (`channel_type` `im` or `mpim`), other events and another workspace's are `None`.
/// An event with no `channel_type` (the example of `message_deleted` has none) is taken: the channel list the app holds decides, in `refresh_channel`, which are channels the user is in.
fn event_of(payload: &Value, team_id: &str) -> Option<ChannelEvent> {
    if payload["type"] != "event_callback" || payload["team_id"] != team_id {
        return None;
    }
    let event = &payload["event"];
    if event["type"] != "message"
        || event["channel_type"]
            .as_str()
            .is_some_and(|kind| !matches!(kind, "channel" | "group"))
    {
        return None;
    }
    let channel = event["channel"].as_str().filter(|c| valid_channel(c))?;
    // A reply names its thread itself; a changed or deleted message carries the message it was.
    let thread_ts = [
        &event["thread_ts"],
        &event["message"]["thread_ts"],
        &event["previous_message"]["thread_ts"],
    ]
    .into_iter()
    .filter_map(Value::as_str)
    .find(|t| valid_ts(t))
    .map(str::to_owned);
    Some(ChannelEvent {
        channel: channel.to_owned(),
        thread_ts,
    })
}

/// The events that came and have not been read again yet: the time of the first of each channel decides when the channel is due.
#[derive(Default)]
struct Pending {
    waiting: Vec<(Instant, Refresh)>,
}

impl Pending {
    fn push(&mut self, event: ChannelEvent, now: Instant) {
        match self
            .waiting
            .iter_mut()
            .find(|(_, r)| r.channel == event.channel)
        {
            Some((_, refresh)) => {
                if let Some(thread) = event.thread_ts {
                    if !refresh.threads.contains(&thread) {
                        refresh.threads.push(thread);
                    }
                }
            }
            None => self.waiting.push((
                now,
                Refresh {
                    channel: event.channel,
                    threads: event.thread_ts.into_iter().collect(),
                },
            )),
        }
    }

    /// The channels whose first event is `debounce` old or older, removed from the waiting ones.
    fn take_due(&mut self, now: Instant, debounce: Duration) -> Vec<Refresh> {
        let (due, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.waiting)
            .into_iter()
            .partition(|(first, _)| now.saturating_duration_since(*first) >= debounce);
        self.waiting = rest;
        due.into_iter().map(|(_, refresh)| refresh).collect()
    }

    fn next_due(&self, debounce: Duration) -> Option<Instant> {
        self.waiting
            .iter()
            .map(|(first, _)| *first + debounce)
            .min()
    }
}

/// `refreshes` with each channel once, in the order the channels first come, and the threads of all its entries (`THREADS_PER_REFRESH` at most).
fn merge_refreshes(refreshes: Vec<Refresh>) -> Vec<Refresh> {
    let mut merged: Vec<Refresh> = Vec::new();
    for refresh in refreshes {
        match merged.iter_mut().find(|m| m.channel == refresh.channel) {
            Some(kept) => {
                for thread in refresh.threads {
                    if !kept.threads.contains(&thread) {
                        kept.threads.push(thread);
                    }
                }
            }
            None => merged.push(refresh),
        }
    }
    for refresh in &mut merged {
        refresh.threads.truncate(THREADS_PER_REFRESH);
    }
    merged
}

/// What the events may read now: `CHANNEL_GAP` between two reads of a channel and `EVENT_CALLS_PER_WINDOW` calls in `BUDGET_WINDOW`.
#[derive(Default)]
struct EventBudget {
    /// When each channel was last let through.
    last_read: HashMap<String, Instant>,
    /// When the calls were let through, and how many.
    spent: Vec<(Instant, usize)>,
}

impl EventBudget {
    /// Splits `waiting` into the reads to make now (and counts them as made) and the ones that wait, with the time the first of those can be read.
    /// A read waits while its channel is within `CHANNEL_GAP` of the last one, or while its calls (`1 +` the threads it checks) do not fit in what is left of `EVENT_CALLS_PER_WINDOW`;
    /// one that does not fit does not hold back a smaller one behind it. The order of `waiting` is kept in both.
    fn admit(
        &mut self,
        waiting: Vec<Refresh>,
        now: Instant,
    ) -> (Vec<Refresh>, Vec<Refresh>, Option<Instant>) {
        self.spent.retain(|(at, _)| *at + BUDGET_WINDOW > now);
        self.last_read.retain(|_, at| *at + CHANNEL_GAP > now);
        let (mut ready, mut rest, mut wake) = (Vec::new(), Vec::new(), None::<Instant>);
        for refresh in waiting {
            let cost = (1 + refresh.threads.len()).min(EVENT_CALLS_PER_WINDOW);
            let used: usize = self.spent.iter().map(|(_, n)| n).sum();
            let can_at = match self.last_read.get(&refresh.channel) {
                Some(last) => Some(*last + CHANNEL_GAP),
                None if used + cost > EVENT_CALLS_PER_WINDOW => Some(self.room_at(used, cost)),
                None => None,
            };
            match can_at {
                None => {
                    self.spent.push((now, cost));
                    self.last_read.insert(refresh.channel.clone(), now);
                    ready.push(refresh);
                }
                Some(at) => {
                    wake = Some(wake.map_or(at, |w| w.min(at)));
                    rest.push(refresh);
                }
            }
        }
        (ready, rest, wake)
    }

    /// The first time `cost` calls fit, when `used` are counted now: the calls leave the window oldest first.
    fn room_at(&self, used: usize, cost: usize) -> Instant {
        let mut used = used;
        let mut at = None;
        for (when, n) in &self.spent {
            used -= n;
            at = Some(*when + BUDGET_WINDOW);
            if used + cost <= EVENT_CALLS_PER_WINDOW {
                break;
            }
        }
        // `spent` is not empty whenever `used` is over the limit.
        at.unwrap_or_else(Instant::now)
    }
}

/// How long to wait before connecting again after the `attempt`th failure in a row (0 is the first): doubling from `BACKOFF_FIRST` up to `BACKOFF_MAX`.
fn reconnect_wait(attempt: u32) -> Duration {
    BACKOFF_FIRST
        .saturating_mul(1u32.checked_shl(attempt).unwrap_or(u32::MAX))
        .min(BACKOFF_MAX)
}

fn silent_too_long(since_last_frame: Duration) -> bool {
    since_last_frame >= SILENCE_LIMIT
}

/// Whether Slack's answer to `apps.connections.open` names a place to connect to: a `wss` address of slack.com.
fn socket_url_ok(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| {
        u.scheme() == "wss"
            && u.host_str()
                .is_some_and(|h| h == "slack.com" || h.ends_with(".slack.com"))
    })
}

/// The threads of `threads` (the `ts` of their own messages) of the channel, split into the watched ones and the others.
fn split_threads(
    team_id: &str,
    channel: &str,
    threads: &[String],
    watched: &[Watched],
) -> (Vec<WatchKey>, Vec<WatchKey>) {
    threads
        .iter()
        .map(|ts| (team_id.to_owned(), channel.to_owned(), ts.clone()))
        .partition(|key| watched.iter().any(|w| w.key() == *key))
}

struct Entry {
    generation: u64,
    state: SocketState,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
struct HubInner {
    next_generation: u64,
    entries: HashMap<String, Entry>,
}

/// The connections: a task each, with its state. A task changes its own state only while it is the current one of the workspace (`generation`).
#[derive(Default)]
pub struct SocketHub {
    inner: Mutex<HubInner>,
}

fn announce(app: &AppHandle, team_id: &str, state: SocketState) {
    let status = SocketStatus {
        team_id: team_id.to_owned(),
        state,
    };
    if let Err(e) = app.emit(EVENT_STATUS, status) {
        log_failure("slack_socket", team_id, e.to_string());
    }
}

impl SocketHub {
    fn statuses(&self) -> Vec<SocketStatus> {
        let mut all: Vec<SocketStatus> = self
            .inner
            .lock()
            .unwrap()
            .entries
            .iter()
            .map(|(team_id, entry)| SocketStatus {
                team_id: team_id.clone(),
                state: entry.state,
            })
            .collect();
        all.sort_by(|a, b| a.team_id.cmp(&b.team_id));
        all
    }

    /// Whether the workspaces are all connected (and there is one).
    pub(super) fn all_connected(&self, workspaces: &[Workspace]) -> bool {
        let inner = self.inner.lock().unwrap();
        !workspaces.is_empty()
            && workspaces.iter().all(|w| {
                inner
                    .entries
                    .get(&w.team_id)
                    .is_some_and(|e| e.state == SocketState::Connected)
            })
    }

    /// Starts the workspace's task with `spawn` (which is given the task's generation), in place of the one it has.
    fn start(
        &self,
        app: &AppHandle,
        team_id: &str,
        spawn: impl FnOnce(u64) -> tauri::async_runtime::JoinHandle<()>,
    ) {
        {
            // The lock is held through the spawn, so that the task finds its entry when it first sets its state.
            let mut inner = self.inner.lock().unwrap();
            if let Some(old) = inner.entries.remove(team_id) {
                if let Some(handle) = old.handle {
                    handle.abort();
                }
            }
            let generation = inner.next_generation;
            inner.next_generation += 1;
            let handle = spawn(generation);
            inner.entries.insert(
                team_id.to_owned(),
                Entry {
                    generation,
                    state: SocketState::Connecting,
                    handle: Some(handle),
                },
            );
        }
        announce(app, team_id, SocketState::Connecting);
    }

    /// Stops the workspace's task, if it has one.
    fn stop(&self, app: &AppHandle, team_id: &str) {
        let old = self.inner.lock().unwrap().entries.remove(team_id);
        if let Some(old) = old {
            if let Some(handle) = old.handle {
                handle.abort();
            }
            announce(app, team_id, SocketState::Off);
        }
    }

    /// The task of `generation` ended by itself: its entry goes, unless a newer task has taken its place.
    fn finish(&self, app: &AppHandle, team_id: &str, generation: u64) {
        let gone = {
            let mut inner = self.inner.lock().unwrap();
            let current = inner
                .entries
                .get(team_id)
                .is_some_and(|e| e.generation == generation);
            current && inner.entries.remove(team_id).is_some()
        };
        if gone {
            announce(app, team_id, SocketState::Off);
        }
    }

    fn set_state(&self, app: &AppHandle, team_id: &str, generation: u64, state: SocketState) {
        let changed = {
            let mut inner = self.inner.lock().unwrap();
            match inner.entries.get_mut(team_id) {
                Some(e) if e.generation == generation && e.state != state => {
                    e.state = state;
                    true
                }
                _ => false,
            }
        };
        if changed {
            announce(app, team_id, state);
        }
    }
}

fn app_entry(team_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(APP_TOKEN_SERVICE, team_id).map_err(|e| e.to_string())
}

/// The App-Level Token of the workspace. `None` means none is stored.
async fn read_app_secret(team_id: String) -> Result<Option<String>, String> {
    blocking(move || match app_entry(&team_id)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("資格情報の読み取りに失敗: {e}")),
    })
    .await
}

async fn write_app_secret(team_id: String, token: String) -> Result<(), String> {
    blocking(move || {
        app_entry(&team_id)?
            .set_password(&token)
            .map_err(|e| format!("資格情報の保存に失敗: {e}"))
    })
    .await
}

async fn delete_app_secret(team_id: String) -> Result<(), String> {
    blocking(move || delete_entry(&app_entry(&team_id)?)).await
}

/// rustls needs a process-wide crypto provider when it is not told one, and more than one is built in (reqwest's and the updater's).
fn install_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

/// Why a connection could not be made.
enum Failure {
    /// The token is gone or Slack refuses it for good: the connection is not tried again.
    Gone,
    Retry(String),
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Asks Slack for a place to connect to (`apps.connections.open`) with the stored App-Level Token, and connects to it.
async fn open_socket(app: &AppHandle, team_id: &str) -> Result<Socket, Failure> {
    let token = match read_app_secret(team_id.to_owned()).await {
        Ok(Some(token)) => token,
        Ok(None) => return Err(Failure::Gone),
        Err(e) => return Err(Failure::Retry(e)),
    };
    let auth = app.state::<Auth>();
    let reply = match call(auth.http(), &token, "apps.connections.open", Payload::Empty).await {
        Ok(reply) => reply,
        Err(e) if e.token_dead => return Err(Failure::Gone),
        Err(e) => return Err(Failure::Retry(e.message)),
    };
    let url = reply["url"]
        .as_str()
        .filter(|u| socket_url_ok(u))
        .ok_or_else(|| Failure::Retry("Slack の返答に接続先がありません".to_owned()))?;
    install_crypto_provider();
    let (socket, _) = timeout(CONNECT_DEADLINE, connect_async(url))
        .await
        .map_err(|_| Failure::Retry("Slack に接続できません: 時間切れ".to_owned()))?
        .map_err(|e| Failure::Retry(format!("Slack に接続できません: {e}")))?;
    Ok(socket)
}

/// How a session ended: whether Slack said hello in it, and whether to connect again without a wait.
#[derive(Default)]
struct SessionEnd {
    greeted: bool,
    fast: bool,
}

/// Reads the socket until it ends: answers every envelope with its `envelope_id`, calls `on_hello` at the hello,
/// and sends the channels whose events have waited `debounce` to `tx`. A ping goes out every `PING_EVERY`; a socket silent for `SILENCE_LIMIT` is dropped.
async fn session<S>(
    socket: &mut WebSocketStream<S>,
    team_id: &str,
    tx: &UnboundedSender<Refresh>,
    debounce: Duration,
    on_hello: &mut (dyn FnMut() + Send),
) -> SessionEnd
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut end = SessionEnd::default();
    let mut pending = Pending::default();
    let mut last_frame = Instant::now();
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    loop {
        let due = pending.next_due(debounce);
        tokio::select! {
            received = socket.next() => {
                let Some(Ok(message)) = received else { return end };
                last_frame = Instant::now();
                match message {
                    Message::Text(text) => match parse_frame(text.as_str(), team_id) {
                        Frame::Hello => {
                            end.greeted = true;
                            on_hello();
                        }
                        Frame::Disconnect(Disconnect::Warning) | Frame::Other => {}
                        Frame::Disconnect(reason) => {
                            end.fast = reason == Disconnect::Refresh;
                            return end;
                        }
                        Frame::Envelope { id, event } => {
                            if socket.send(Message::text(ack_text(&id))).await.is_err() {
                                return end;
                            }
                            if let Some(event) = event {
                                pending.push(event, Instant::now());
                            }
                        }
                    },
                    Message::Close(_) => return end,
                    _ => {}
                }
            }
            () = wait_until(due) => {
                for refresh in pending.take_due(Instant::now(), debounce) {
                    if tx.send(refresh).is_err() {
                        return end;
                    }
                }
            }
            _ = ping.tick() => {
                if silent_too_long(last_frame.elapsed())
                    || socket.send(Message::Ping(Vec::new().into())).await.is_err()
                {
                    return end;
                }
            }
        }
    }
}

async fn wait_until(due: Option<Instant>) {
    match due {
        Some(at) => sleep_until(tokio::time::Instant::from_std(at)).await,
        None => std::future::pending().await,
    }
}

/// Keeps the workspace connected: connects, reads (`session`), and connects again when the connection ends, after `reconnect_wait` unless Slack asked for the refresh.
/// It returns when the token is gone or refused.
async fn keep_connected(
    app: &AppHandle,
    team_id: &str,
    generation: u64,
    tx: UnboundedSender<Refresh>,
) {
    const COMMAND: &str = "slack_socket";
    let state = app.state::<SlackState>();
    let mut attempt = 0u32;
    loop {
        let end = match open_socket(app, team_id).await {
            Ok(mut socket) => {
                let mut on_hello = || {
                    state
                        .sockets
                        .set_state(app, team_id, generation, SocketState::Connected);
                    if let Err(e) = app.emit(EVENT_RESYNC, ()) {
                        log_failure(COMMAND, team_id, e.to_string());
                    }
                };
                session(&mut socket, team_id, &tx, DEBOUNCE, &mut on_hello).await
            }
            Err(Failure::Gone) => {
                log_failure(
                    COMMAND,
                    team_id,
                    "App-Level Token が使えないため、リアルタイム更新を止めます".to_owned(),
                );
                if let Err(e) = delete_app_secret(team_id.to_owned()).await {
                    log_failure(COMMAND, team_id, e);
                }
                state.sockets.finish(app, team_id, generation);
                return;
            }
            Err(Failure::Retry(message)) => {
                log_failure(COMMAND, team_id, message);
                SessionEnd::default()
            }
        };
        if end.greeted {
            attempt = 0;
        }
        state
            .sockets
            .set_state(app, team_id, generation, SocketState::Reconnecting);
        if !end.fast {
            sleep(reconnect_wait(attempt)).await;
            attempt = attempt.saturating_add(1);
        }
    }
}

/// The people the replies kept for the thread draw.
fn thread_people(cache: &TimelineCache, key: &WatchKey) -> Vec<String> {
    cache
        .threads
        .lock()
        .unwrap()
        .get(key)
        .and_then(|entry| entry.read.as_ref())
        .map(|read| read.replies.iter().flat_map(people_of).collect())
        .unwrap_or_default()
}

/// Reads the channel again, as a read of the list does: `conversations.history`, the read position when none is kept, the threads the events named
/// (`conversations.replies`, as the watched threads and the threads with unread replies are checked), and the names of the people the new messages draw.
/// A channel kept off the list (S-9), one that is not in the channel list kept, or a workspace Slack has rate-limited is left alone. Whether the cache changed.
async fn refresh_channel(app: &AppHandle, team_id: &str, request: &Refresh) -> bool {
    const COMMAND: &str = "slack_socket";
    let state = app.state::<SlackState>();
    let auth = app.state::<Auth>();
    let cache = &state.timeline;
    let dir = match config_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            log_failure(COMMAND, team_id, e);
            return false;
        }
    };
    let hidden = load_hidden(&dir).await;
    if hidden
        .iter()
        .any(|h| h.team_id == team_id && h.channel == request.channel)
    {
        return false;
    }
    let Some(name) = kept_channel_name(&state.channels, team_id, &request.channel) else {
        return false;
    };
    if cache.rate_limited(team_id) {
        return false;
    }
    let token = match token_of(team_id).await {
        Ok(token) if !is_bot_token(&token) => token,
        Ok(_) => return false,
        Err(e) => {
            log_failure(COMMAND, team_id, e);
            return false;
        }
    };
    let http = auth.http();
    let channel = Channel {
        id: request.channel.clone(),
        name,
    };
    let form = [
        ("channel", channel.id.clone()),
        ("limit", HISTORY_LIMIT.to_owned()),
    ];
    let found: Vec<Raw> = match call_scoped_retrying(
        http,
        &token,
        "conversations.history",
        Payload::Form(&form),
        0,
    )
    .await
    {
        Ok((reply, scopes)) => {
            if let Some(scopes) = scopes {
                cache.put_scopes(team_id, &scopes);
            }
            reply["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|m| raw_of(team_id, &channel, m))
                .collect()
        }
        Err(e) => {
            match e.rate_limited {
                Some(wait) => {
                    cache.limit(team_id, wait);
                    log_failure(
                        COMMAND,
                        team_id,
                        format!("Slack の呼び出し制限のため {} 秒読みません", wait.as_secs()),
                    );
                }
                None => {
                    log_failure(COMMAND, team_id, e);
                }
            }
            return false;
        }
    };
    let mut people: Vec<String> = found.iter().flat_map(people_of).collect();
    cache.put_channel_history(team_id, &channel.id, found);
    // The unread marks are judged by the channel's read position: a channel that has none yet is asked for it.
    if cache.last_read(team_id, &channel.id).is_none() {
        refresh_read_marks(
            http,
            cache,
            vec![(team_id.to_owned(), token.clone(), channel.id.clone())],
        )
        .await;
    }
    if !request.threads.is_empty() && !cache.replies_limited(team_id) {
        let tokens = HashMap::from([(team_id, token.as_str())]);
        own_user_id(http, cache, team_id, &token).await;
        let watched = load_watched(&dir).await;
        let (watch, plain) = split_threads(team_id, &channel.id, &request.threads, &watched);
        check_watched(http, cache, &state.channels, &tokens, watch).await;
        if !plain.is_empty() {
            let workspaces = load_workspaces(&dir).await.unwrap_or_default();
            let seen = load_thread_seen(&dir).await;
            let held = held_messages(cache, &workspaces, &hidden);
            let unread = unread_threads(
                cache,
                &state.channels,
                &workspaces,
                &hidden,
                &watched,
                &seen,
            );
            let candidates = thread_candidates(cache, &held, &unread, &watched);
            let picked = plain
                .into_iter()
                .filter_map(|key| {
                    let count = candidates.iter().find(|c| c.key == key)?.reply_count;
                    Some((key, count))
                })
                .collect();
            check_threads(http, cache, &state.channels, &tokens, picked).await;
        }
        for ts in &request.threads {
            people.extend(thread_people(
                cache,
                &(team_id.to_owned(), channel.id.clone(), ts.clone()),
            ));
        }
    }
    let mut asked = HashSet::new();
    let wanted = people
        .into_iter()
        .filter(|user| asked.insert(user.clone()))
        .map(|user| (team_id.to_owned(), user));
    let wanted = needing_lookup(
        wanted,
        |(team, user)| cache.needs_lookup(team, user),
        USER_LOOKUPS,
    )
    .into_iter()
    .map(|(team, user)| (team, token.clone(), user))
    .collect();
    lookup_users(http, cache, wanted).await;
    true
}

/// Reads the channels whose events arrive, one channel at a time, as `EventBudget` lets them through, and tells the screen to draw from the cache after each.
/// What the budget holds back waits here, merged with the events that come meanwhile, and is read when the budget allows.
async fn refresh_worker(app: &AppHandle, team_id: &str, mut rx: UnboundedReceiver<Refresh>) {
    let mut budget = EventBudget::default();
    let mut waiting: Vec<Refresh> = Vec::new();
    let mut wake: Option<Instant> = None;
    loop {
        tokio::select! {
            incoming = rx.recv() => {
                let Some(first) = incoming else { return };
                waiting.push(first);
                while let Ok(more) = rx.try_recv() {
                    waiting.push(more);
                }
                waiting = merge_refreshes(std::mem::take(&mut waiting));
            }
            () = wait_until(wake) => {}
        }
        let (ready, rest, next_wake) = budget.admit(std::mem::take(&mut waiting), Instant::now());
        (waiting, wake) = (rest, next_wake);
        for request in ready {
            if refresh_channel(app, team_id, &request).await {
                if let Err(e) = app.emit(EVENT_DIRTY, ()) {
                    log_failure("slack_socket", team_id, e.to_string());
                }
            }
        }
    }
}

async fn run(app: AppHandle, team_id: String, generation: u64) {
    let (tx, rx) = unbounded_channel();
    tokio::join!(
        keep_connected(&app, &team_id, generation, tx),
        refresh_worker(&app, &team_id, rx)
    );
}

/// Starts (or restarts) the workspace's connection.
fn start(app: &AppHandle, team_id: &str) {
    let state = app.state::<SlackState>();
    state.sockets.start(app, team_id, |generation| {
        tauri::async_runtime::spawn(run(app.clone(), team_id.to_owned(), generation))
    });
}

/// Connects the workspaces that have an App-Level Token. Run once at startup; the list is read in full by the screen as it starts.
pub async fn start_all(app: AppHandle) {
    let dir = match config_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            log_failure("slack_socket", "-", e);
            return;
        }
    };
    let workspaces = match load_workspaces(&dir).await {
        Ok(list) => list,
        Err(e) => {
            log_failure("slack_socket", "-", e);
            return;
        }
    };
    for workspace in workspaces {
        let Ok(team_id) = token_key(&workspace.team_id) else {
            continue;
        };
        match read_app_secret(team_id.clone()).await {
            Ok(Some(_)) => start(&app, &team_id),
            Ok(None) => {}
            Err(e) => {
                log_failure("slack_socket", &team_id, e);
            }
        }
    }
}

/// Stops the workspace's connection and deletes its App-Level Token.
pub(super) async fn forget_workspace(app: &AppHandle, hub: &SocketHub, team_id: &str) {
    hub.stop(app, team_id);
    if let Err(e) = delete_app_secret(team_id.to_owned()).await {
        log_failure("slack_socket", team_id, e);
    }
}

/// Keeps the App-Level Token of a connected workspace in the keychain once Slack accepts it (`apps.connections.open`), and connects.
/// A token already kept for the workspace is replaced. It is never logged or returned. Answers the connections.
#[tauri::command]
pub async fn slack_app_token_set(
    app: AppHandle,
    auth: State<'_, Auth>,
    state: State<'_, SlackState>,
    team_id: String,
    token: String,
) -> Result<Vec<SocketStatus>, String> {
    let command = "slack_app_token_set";
    let token = token.trim().to_owned();
    if !valid_app_token(&token) {
        return Err(BAD_APP_TOKEN.into());
    }
    let user = token_key(&team_id).map_err(|e| log_failure(command, &team_id, e))?;
    let dir = config_dir(&app)?;
    // The ticket Slack gives is not used: this only finds out whether the token is accepted.
    call(auth.http(), &token, "apps.connections.open", Payload::Empty)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    let _files = state.files.lock().await;
    let workspaces = load_workspaces(&dir)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    if !workspaces.iter().any(|w| w.team_id == team_id) {
        return Err(NO_SUCH_WORKSPACE.into());
    }
    write_app_secret(user, token)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    start(&app, &team_id);
    Ok(state.sockets.statuses())
}

/// Stops the workspace's connection and deletes its App-Level Token from the keychain. Answers the connections.
#[tauri::command]
pub async fn slack_app_token_remove(
    app: AppHandle,
    state: State<'_, SlackState>,
    team_id: String,
) -> Result<Vec<SocketStatus>, String> {
    let command = "slack_app_token_remove";
    let user = token_key(&team_id).map_err(|e| log_failure(command, &team_id, e))?;
    let _files = state.files.lock().await;
    state.sockets.stop(&app, &team_id);
    delete_app_secret(user)
        .await
        .map_err(|e| log_failure(command, &team_id, e))?;
    Ok(state.sockets.statuses())
}

/// The workspaces that have a connection and its state; a workspace not in the list has no App-Level Token.
#[tauri::command]
pub fn slack_socket_status(state: State<'_, SlackState>) -> Vec<SocketStatus> {
    state.sockets.statuses()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slack::name_in;

    fn at(secs: u64) -> Instant {
        // One fixed origin per test is enough: the checks use the differences.
        static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        *ORIGIN.get_or_init(Instant::now) + Duration::from_secs(secs)
    }

    fn event(channel: &str, thread: Option<&str>) -> ChannelEvent {
        ChannelEvent {
            channel: channel.into(),
            thread_ts: thread.map(str::to_owned),
        }
    }

    fn refresh(channel: &str, threads: &[&str]) -> Refresh {
        Refresh {
            channel: channel.into(),
            threads: threads.iter().map(|t| (*t).to_owned()).collect(),
        }
    }

    fn message_payload(event: Value) -> Value {
        json!({"type": "event_callback", "team_id": "T1", "event": event})
    }

    #[test]
    fn app_tokens_start_with_xapp() {
        assert!(valid_app_token("xapp-1-A0123-4567-abcdef0123"));
        assert!(!valid_app_token("xoxp-1-2-3"));
        assert!(!valid_app_token("xoxb-1-2-3"));
        assert!(!valid_app_token("xapp-"));
        assert!(!valid_app_token(""));
        assert!(!valid_app_token("xapp-1 2"));
        assert!(!valid_app_token("XAPP-1-2"));
    }

    #[test]
    fn hello_and_disconnect_frames() {
        assert_eq!(
            parse_frame(r#"{"type":"hello","num_connections":1}"#, "T1"),
            Frame::Hello
        );
        let reason = |r: &str| {
            parse_frame(
                &json!({"type": "disconnect", "reason": r}).to_string(),
                "T1",
            )
        };
        assert_eq!(reason("warning"), Frame::Disconnect(Disconnect::Warning));
        assert_eq!(
            reason("refresh_requested"),
            Frame::Disconnect(Disconnect::Refresh)
        );
        assert_eq!(
            reason("link_disabled"),
            Frame::Disconnect(Disconnect::Other)
        );
        assert_eq!(
            parse_frame(r#"{"type":"disconnect"}"#, "T1"),
            Frame::Disconnect(Disconnect::Other)
        );
    }

    #[test]
    fn an_envelope_is_answered_whatever_it_carries() {
        let text =
            json!({"envelope_id": "e1", "type": "events_api", "payload": message_payload(json!({
                "type": "message", "channel": "C1", "channel_type": "channel", "ts": "1.2"
            }))})
            .to_string();
        assert_eq!(
            parse_frame(&text, "T1"),
            Frame::Envelope {
                id: "e1".into(),
                event: Some(event("C1", None))
            }
        );
        // Another kind of payload, and an event nobody lists, are answered and ignored.
        let slash =
            json!({"envelope_id": "e2", "type": "slash_commands", "payload": {}}).to_string();
        assert_eq!(
            parse_frame(&slash, "T1"),
            Frame::Envelope {
                id: "e2".into(),
                event: None
            }
        );
        let other = json!({"envelope_id": "e3", "type": "events_api", "payload": message_payload(json!({"type": "reaction_added"}))}).to_string();
        assert_eq!(
            parse_frame(&other, "T1"),
            Frame::Envelope {
                id: "e3".into(),
                event: None
            }
        );
    }

    #[test]
    fn frames_that_are_not_understood_are_other() {
        assert_eq!(parse_frame("not json", "T1"), Frame::Other);
        assert_eq!(parse_frame(r#"{"type":"something"}"#, "T1"), Frame::Other);
        assert_eq!(parse_frame(r#"{"envelope_id": 5}"#, "T1"), Frame::Other);
        assert_eq!(parse_frame(r#"{"envelope_id": ""}"#, "T1"), Frame::Other);
    }

    #[test]
    fn the_answer_names_the_envelope_only() {
        let answer: Value = serde_json::from_str(&ack_text("abc-1")).unwrap();
        assert_eq!(answer, json!({"envelope_id": "abc-1"}));
    }

    #[test]
    fn posts_and_replies_of_channels_and_groups_name_the_channel() {
        let post = message_payload(
            json!({"type": "message", "channel": "C1", "channel_type": "channel", "ts": "1.2"}),
        );
        assert_eq!(event_of(&post, "T1"), Some(event("C1", None)));
        let private = message_payload(
            json!({"type": "message", "channel": "G9", "channel_type": "group", "ts": "1.2"}),
        );
        assert_eq!(event_of(&private, "T1"), Some(event("G9", None)));
        let reply = message_payload(
            json!({"type": "message", "channel": "C1", "channel_type": "channel", "ts": "3.4", "thread_ts": "1.2"}),
        );
        assert_eq!(event_of(&reply, "T1"), Some(event("C1", Some("1.2"))));
    }

    #[test]
    fn a_change_or_a_deletion_names_the_thread_of_the_message() {
        let changed = message_payload(json!({
            "type": "message", "subtype": "message_changed", "channel": "C1", "channel_type": "channel", "ts": "5.6",
            "message": {"ts": "3.4", "thread_ts": "1.2"}
        }));
        assert_eq!(event_of(&changed, "T1"), Some(event("C1", Some("1.2"))));
        let deleted = message_payload(json!({
            "type": "message", "subtype": "message_deleted", "channel": "C1", "channel_type": "channel", "ts": "5.6", "deleted_ts": "3.4",
            "previous_message": {"ts": "3.4", "thread_ts": "1.2"}
        }));
        assert_eq!(event_of(&deleted, "T1"), Some(event("C1", Some("1.2"))));
        let deleted_top = message_payload(json!({
            "type": "message", "subtype": "message_deleted", "channel": "C1", "channel_type": "channel", "ts": "5.6", "deleted_ts": "3.4"
        }));
        assert_eq!(event_of(&deleted_top, "T1"), Some(event("C1", None)));
    }

    #[test]
    fn a_deletion_or_a_change_with_no_channel_type_names_the_channel() {
        // The example of message_deleted in Slack's reference has no channel_type: the channel list decides whether it is a channel the user is in.
        let deleted = message_payload(json!({
            "type": "message", "subtype": "message_deleted", "hidden": true, "channel": "C1", "ts": "5.6", "deleted_ts": "3.4"
        }));
        assert_eq!(event_of(&deleted, "T1"), Some(event("C1", None)));
        let changed = message_payload(json!({
            "type": "message", "subtype": "message_changed", "channel": "G9", "ts": "5.6", "message": {"ts": "3.4", "thread_ts": "1.2"}
        }));
        assert_eq!(event_of(&changed, "T1"), Some(event("G9", Some("1.2"))));
        // A direct message has an ID of its own kind, and is not in the list of channels.
        let list = vec![Channel {
            id: "C1".into(),
            name: "dev".into(),
        }];
        assert_eq!(name_in(&list, "C1").as_deref(), Some("dev"));
        assert_eq!(name_in(&list, "D1"), None);
        assert_eq!(name_in(&list, "C2"), None);
        assert_eq!(name_in(&[], "C1"), None);
    }

    #[test]
    fn other_conversations_events_and_workspaces_are_not_taken() {
        let message = |channel_type: Option<&str>| {
            let mut e = json!({"type": "message", "channel": "C1", "ts": "1.2"});
            if let Some(t) = channel_type {
                e["channel_type"] = json!(t);
            }
            message_payload(e)
        };
        assert_eq!(event_of(&message(Some("im")), "T1"), None);
        assert_eq!(event_of(&message(Some("mpim")), "T1"), None);
        assert_eq!(event_of(&message(Some("channel")), "T2"), None);
        let mut no_team = message(Some("channel"));
        no_team.as_object_mut().unwrap().remove("team_id");
        assert_eq!(event_of(&no_team, "T1"), None);
        let mut wrong_kind = message(Some("channel"));
        wrong_kind["type"] = json!("url_verification");
        assert_eq!(event_of(&wrong_kind, "T1"), None);
        let bad_channel = message_payload(
            json!({"type": "message", "channel": "../x", "channel_type": "channel"}),
        );
        assert_eq!(event_of(&bad_channel, "T1"), None);
        let bad_thread = message_payload(
            json!({"type": "message", "channel": "C1", "channel_type": "channel", "thread_ts": "soon"}),
        );
        assert_eq!(event_of(&bad_thread, "T1"), Some(event("C1", None)));
    }

    #[test]
    fn events_of_a_channel_within_the_interval_are_one_read() {
        let mut pending = Pending::default();
        let debounce = Duration::from_secs(1);
        assert_eq!(pending.next_due(debounce), None);
        pending.push(event("C1", None), at(10));
        pending.push(event("C2", None), at(10));
        pending.push(event("C1", Some("1.2")), at(11));
        pending.push(event("C1", Some("1.2")), at(11));
        pending.push(event("C1", Some("3.4")), at(11));
        // The interval runs from the first event of the channel, so a steady stream is still read once a second.
        assert_eq!(pending.next_due(debounce), Some(at(11)));
        assert_eq!(pending.take_due(at(10), debounce), vec![]);
        assert_eq!(
            pending.take_due(at(11), debounce),
            vec![refresh("C1", &["1.2", "3.4"]), refresh("C2", &[])]
        );
        assert_eq!(pending.next_due(debounce), None);
    }

    #[test]
    fn a_channel_with_a_later_first_event_waits_for_its_own_interval() {
        let mut pending = Pending::default();
        let debounce = Duration::from_secs(1);
        pending.push(event("C1", None), at(10));
        pending.push(event("C2", None), at(10) + Duration::from_millis(600));
        assert_eq!(pending.take_due(at(11), debounce), vec![refresh("C1", &[])]);
        assert_eq!(
            pending.next_due(debounce),
            Some(at(10) + Duration::from_millis(1600))
        );
    }

    #[test]
    fn a_backlog_is_merged_by_channel() {
        let merged = merge_refreshes(vec![
            refresh("C1", &["1.2"]),
            refresh("C2", &[]),
            refresh("C1", &["1.2", "3.4"]),
        ]);
        assert_eq!(
            merged,
            vec![refresh("C1", &["1.2", "3.4"]), refresh("C2", &[])]
        );
        assert_eq!(merge_refreshes(vec![]), vec![]);
        let many: Vec<String> = (0..9).map(|n| format!("{n}.1")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(
            merge_refreshes(vec![refresh("C1", &many)])[0].threads.len(),
            THREADS_PER_REFRESH
        );
    }

    #[test]
    fn the_wait_doubles_up_to_a_limit() {
        let waits: Vec<u64> = (0..9).map(|n| reconnect_wait(n).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(reconnect_wait(u32::MAX), BACKOFF_MAX);
    }

    #[test]
    fn a_connection_that_sent_nothing_for_long_is_dead() {
        assert!(!silent_too_long(Duration::from_secs(89)));
        assert!(silent_too_long(SILENCE_LIMIT));
    }

    #[test]
    fn only_a_wss_address_of_slack_is_connected_to() {
        assert!(socket_url_ok(
            "wss://wss-primary.slack.com/link/?ticket=1234-5678&app_id=A1"
        ));
        assert!(socket_url_ok("wss://slack.com/link/?ticket=1"));
        assert!(!socket_url_ok("ws://wss-primary.slack.com/link/?ticket=1"));
        assert!(!socket_url_ok("wss://example.com/link/?ticket=1"));
        assert!(!socket_url_ok("wss://evilslack.com/link/"));
        assert!(!socket_url_ok("wss://slack.com.example.com/link/"));
        assert!(!socket_url_ok("https://wss-primary.slack.com/link/"));
        assert!(!socket_url_ok("not a url"));
    }

    fn watched(team: &str, channel: &str, ts: &str) -> Watched {
        serde_json::from_value(json!({"teamId": team, "channel": channel, "ts": ts, "seenTs": ts}))
            .unwrap()
    }

    #[test]
    fn watched_threads_are_split_from_the_others() {
        let list = vec![
            watched("T1", "C1", "1.2"),
            watched("T1", "C2", "3.4"),
            watched("T2", "C1", "5.6"),
        ];
        let threads = vec!["1.2".to_owned(), "3.4".to_owned(), "5.6".to_owned()];
        let (watch, plain) = split_threads("T1", "C1", &threads, &list);
        assert_eq!(
            watch,
            vec![("T1".to_owned(), "C1".to_owned(), "1.2".to_owned())]
        );
        assert_eq!(
            plain,
            vec![
                ("T1".to_owned(), "C1".to_owned(), "3.4".to_owned()),
                ("T1".to_owned(), "C1".to_owned(), "5.6".to_owned())
            ]
        );
    }

    fn workspace(team: &str) -> Workspace {
        serde_json::from_value(
            json!({"teamId": team, "team": team, "user": "me", "url": "https://x.slack.com/"}),
        )
        .unwrap()
    }

    fn hub_with(states: &[(&str, SocketState)]) -> SocketHub {
        let hub = SocketHub::default();
        let mut inner = hub.inner.lock().unwrap();
        for (n, (team, state)) in states.iter().enumerate() {
            inner.entries.insert(
                (*team).to_owned(),
                Entry {
                    generation: n as u64,
                    state: *state,
                    handle: None,
                },
            );
        }
        drop(inner);
        hub
    }

    #[test]
    fn the_list_is_live_only_when_every_workspace_is_connected() {
        let both = [workspace("T1"), workspace("T2")];
        let hub = hub_with(&[
            ("T1", SocketState::Connected),
            ("T2", SocketState::Connected),
        ]);
        assert!(hub.all_connected(&both));
        assert!(!hub_with(&[
            ("T1", SocketState::Connected),
            ("T2", SocketState::Reconnecting)
        ])
        .all_connected(&both));
        assert!(!hub_with(&[
            ("T1", SocketState::Connected),
            ("T2", SocketState::Connecting)
        ])
        .all_connected(&both));
        assert!(!hub_with(&[("T1", SocketState::Connected)]).all_connected(&both));
        assert!(!hub.all_connected(&[]));
        // A connection of a workspace that is not in the list does not count for it.
        assert!(hub.all_connected(&[workspace("T1")]));
    }

    #[test]
    fn the_statuses_are_in_the_order_of_the_workspaces_ids() {
        let hub = hub_with(&[
            ("T2", SocketState::Connecting),
            ("T1", SocketState::Connected),
        ]);
        assert_eq!(
            hub.statuses(),
            vec![
                SocketStatus {
                    team_id: "T1".into(),
                    state: SocketState::Connected
                },
                SocketStatus {
                    team_id: "T2".into(),
                    state: SocketState::Connecting
                },
            ]
        );
    }

    fn envelope(id: &str, channel: &str, thread: Option<&str>) -> String {
        let mut event =
            json!({"type": "message", "channel": channel, "channel_type": "channel", "ts": "9.1"});
        if let Some(t) = thread {
            event["thread_ts"] = json!(t);
        }
        json!({"envelope_id": id, "type": "events_api", "payload": message_payload(event)})
            .to_string()
    }

    async fn server() -> (tokio::net::TcpListener, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        (listener, url)
    }

    #[test]
    fn a_channel_is_read_at_once_and_again_only_after_the_gap_with_the_events_in_between_merged() {
        let mut budget = EventBudget::default();
        let (ready, rest, wake) = budget.admit(vec![refresh("C1", &["1.2"])], at(100));
        assert_eq!(ready, vec![refresh("C1", &["1.2"])]);
        assert!(rest.is_empty());
        assert_eq!(wake, None);
        // Events of the channel in the gap wait, with their threads merged, until the gap is over.
        let (ready, rest, wake) = budget.admit(vec![refresh("C1", &["3.4"])], at(103));
        assert!(ready.is_empty());
        assert_eq!(rest, vec![refresh("C1", &["3.4"])]);
        assert_eq!(wake, Some(at(100) + CHANNEL_GAP));
        let (ready, rest, wake) = budget.admit(rest, at(100) + CHANNEL_GAP);
        assert_eq!(ready, vec![refresh("C1", &["3.4"])]);
        assert!(rest.is_empty());
        assert_eq!(wake, None);
        // Another channel is not held by it.
        let (ready, _, _) = budget.admit(vec![refresh("C2", &[])], at(111));
        assert_eq!(ready, vec![refresh("C2", &[])]);
    }

    #[test]
    fn a_workspace_gets_a_limited_number_of_calls_a_minute_and_the_rest_waits_for_the_next() {
        let mut budget = EventBudget::default();
        // Each read of a channel with four threads is 5 calls: four of them are the whole budget of 20.
        let four = ["1.1", "1.2", "1.3", "1.4"];
        let waiting: Vec<Refresh> = (1..=6).map(|n| refresh(&format!("C{n}"), &four)).collect();
        let (ready, rest, wake) = budget.admit(waiting, at(200));
        assert_eq!(
            ready.iter().map(|r| r.channel.as_str()).collect::<Vec<_>>(),
            ["C1", "C2", "C3", "C4"]
        );
        assert_eq!(
            rest.iter().map(|r| r.channel.as_str()).collect::<Vec<_>>(),
            ["C5", "C6"]
        );
        // The calls of the first read leave the minute after it was made.
        assert_eq!(wake, Some(at(200) + BUDGET_WINDOW));
        let (ready, rest, _) = budget.admit(rest.clone(), at(259));
        assert!(ready.is_empty());
        assert_eq!(rest.len(), 2);
        // Nothing was dropped, and the next minute lets them through (all four calls of the minute are over together here).
        let (ready, rest, wake) = budget.admit(rest, at(200) + BUDGET_WINDOW);
        assert_eq!(
            ready.iter().map(|r| r.channel.as_str()).collect::<Vec<_>>(),
            ["C5", "C6"]
        );
        assert!(rest.is_empty());
        assert_eq!(wake, None);
    }

    #[test]
    fn a_read_that_fits_is_let_through_past_one_that_does_not() {
        let mut budget = EventBudget::default();
        let four = ["1.1", "1.2", "1.3", "1.4"];
        let mut waiting: Vec<Refresh> = (1..=3).map(|n| refresh(&format!("C{n}"), &four)).collect();
        // 15 calls so far; a read of 5 more fits, one of 6 does not.
        waiting.push(refresh("C4", &["1.1", "1.2", "1.3", "1.4", "1.5"]));
        waiting.push(refresh("C5", &[]));
        let (ready, rest, _) = budget.admit(waiting, at(300));
        assert_eq!(
            ready.iter().map(|r| r.channel.as_str()).collect::<Vec<_>>(),
            ["C1", "C2", "C3", "C5"]
        );
        assert_eq!(
            rest.iter().map(|r| r.channel.as_str()).collect::<Vec<_>>(),
            ["C4"]
        );
    }

    #[test]
    fn the_wake_is_the_earliest_time_something_can_be_read() {
        let mut budget = EventBudget::default();
        budget.admit(vec![refresh("C1", &[])], at(400));
        let (_, rest, _) = budget.admit(
            vec![refresh("C2", &["1.1", "1.2", "1.3", "1.4", "1.5"])],
            at(402),
        );
        assert!(rest.is_empty());
        // C1 waits for its gap (410) and C2 for its own (412): the earlier is the wake.
        let (ready, rest, wake) =
            budget.admit(vec![refresh("C1", &[]), refresh("C2", &[])], at(405));
        assert!(ready.is_empty());
        assert_eq!(rest.len(), 2);
        assert_eq!(wake, Some(at(400) + CHANNEL_GAP));
    }

    #[tokio::test]
    async fn a_session_answers_every_envelope_and_passes_the_events_on_once() {
        let (listener, url) = server().await;
        let slack = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.send(Message::text(r#"{"type":"hello","num_connections":1}"#))
                .await
                .unwrap();
            // A warning does not end the session; two events of a channel, one of another workspace and one that is no event.
            ws.send(Message::text(r#"{"type":"disconnect","reason":"warning"}"#))
                .await
                .unwrap();
            ws.send(Message::text(envelope("e1", "C1", None)))
                .await
                .unwrap();
            ws.send(Message::text(envelope("e2", "C1", Some("1.2"))))
                .await
                .unwrap();
            let other = json!({"envelope_id": "e3", "type": "events_api", "payload": {"type": "event_callback", "team_id": "T9", "event": {"type": "message", "channel": "C2", "channel_type": "channel"}}});
            ws.send(Message::text(other.to_string())).await.unwrap();
            ws.send(Message::text(
                r#"{"envelope_id":"e4","type":"slash_commands","payload":{}}"#,
            ))
            .await
            .unwrap();
            let mut acks = Vec::new();
            while acks.len() < 4 {
                if let Some(Ok(Message::Text(text))) = ws.next().await {
                    acks.push(serde_json::from_str::<Value>(text.as_str()).unwrap());
                }
            }
            // Longer than the session's interval, so that the events are read again before the connection ends.
            sleep(Duration::from_millis(300)).await;
            ws.send(Message::text(
                r#"{"type":"disconnect","reason":"refresh_requested"}"#,
            ))
            .await
            .unwrap();
            acks
        });
        let (mut socket, _) = connect_async(&url).await.unwrap();
        let (tx, mut rx) = unbounded_channel();
        let mut hellos = 0;
        let mut on_hello = || hellos += 1;
        let end = session(
            &mut socket,
            "T1",
            &tx,
            Duration::from_millis(100),
            &mut on_hello,
        )
        .await;
        assert!(end.greeted);
        assert!(end.fast);
        assert_eq!(hellos, 1);
        assert_eq!(rx.try_recv().unwrap(), refresh("C1", &["1.2"]));
        assert!(rx.try_recv().is_err());
        let acks = slack.await.unwrap();
        let ids: Vec<&Value> = acks.iter().map(|a| &a["envelope_id"]).collect();
        assert_eq!(ids, ["e1", "e2", "e3", "e4"]);
        assert!(acks.iter().all(|a| a.as_object().unwrap().len() == 1));
    }

    #[tokio::test]
    async fn a_session_that_is_closed_before_the_hello_is_not_greeted() {
        let (listener, url) = server().await;
        let slack = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.close(None).await.unwrap();
        });
        let (mut socket, _) = connect_async(&url).await.unwrap();
        let (tx, _rx) = unbounded_channel();
        let mut on_hello = || panic!("no hello was sent");
        let end = session(
            &mut socket,
            "T1",
            &tx,
            Duration::from_millis(100),
            &mut on_hello,
        )
        .await;
        assert!(!end.greeted);
        assert!(!end.fast);
        slack.await.unwrap();
    }

    #[tokio::test]
    async fn a_session_that_slack_disconnects_for_another_reason_waits_before_connecting_again() {
        let (listener, url) = server().await;
        let slack = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.send(Message::text(r#"{"type":"hello"}"#)).await.unwrap();
            ws.send(Message::text(
                r#"{"type":"disconnect","reason":"link_disabled"}"#,
            ))
            .await
            .unwrap();
            // Keeps the socket open until the client has read the frame.
            let _ = ws.next().await;
        });
        let (mut socket, _) = connect_async(&url).await.unwrap();
        let (tx, _rx) = unbounded_channel();
        let mut on_hello = || {};
        let end = session(
            &mut socket,
            "T1",
            &tx,
            Duration::from_millis(100),
            &mut on_hello,
        )
        .await;
        assert!(end.greeted);
        assert!(!end.fast);
        drop(socket);
        slack.await.unwrap();
    }
}
