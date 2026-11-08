//! A-12: the Orca screen's stream from a saved environment (a paired server), over the end-to-end encrypted WebSocket of A-7.
//! The list of sessions comes from `session.tabs.subscribeAll`, named by `worktree.ps`, which is read once when the connection opens and again only when a worktree it did not list appears;
//! each terminal shown (one for each pane of the work pane, A-17) comes from its own `terminal.subscribe` (its size from `terminal.updateViewport`), and the keys go with `terminal.send`.
//! Nothing is read again by a clock. None of these methods is a public interface of Orca: they were checked on Orca 1.4.249. Nothing is stored here.
//! What a terminal prints and the keys typed are in no log line, no error text and no event but the terminal's own channel; a token is in none at all.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    sync::{
        mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
        oneshot,
    },
    time::{sleep_until, Instant},
};
#[cfg(test)]
use ts_rs::TS;

use crate::{
    orca::{
        check_accepted, check_handle, check_keys, input_params, plain_terminals_of, projects_of,
        rows_of, text_of, worktrees_of, OrcaProject, OrcaRow, OrcaTerminal, OrcaWorktree,
    },
    orca_chat::{backoff, connect_environment, reason_of, result_of, WsLink},
};

/// `worktree.ps` is asked for this many worktrees, as the CLI's read of A-6.
const WORKTREE_LIMIT: u64 = 200;
/// The sizes Orca takes for a viewport (`terminal.subscribe` takes 1 to 1000 columns, `terminal.updateViewport` 20 to 1024; rows 8 to 500 for both).
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 1000;
const MIN_ROWS: u16 = 8;
const MAX_ROWS: u16 = 500;

/// What the stream tells the screen about the list.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OrcaStreamEvent {
    /// The list as A-6 and A-8 draw it, built again whenever Orca sent a change (and sent only when it changed).
    List {
        rows: Vec<OrcaRow>,
        worktrees: Vec<OrcaWorktree>,
        projects: Vec<OrcaProject>,
        hosts: Vec<OrcaProject>,
        terminals: Vec<OrcaTerminal>,
    },
    /// The connection is up (`live`, once the first list came), or it failed and is tried again after a wait (`message` says why, in Japanese).
    Status { live: bool, message: String },
}

/// What the stream tells the screen about a terminal shown.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OrcaTermEvent {
    /// What the terminal shows now, with the history Orca keeps, to draw in place of everything drawn before; its size when Orca says it.
    Snapshot {
        data: String,
        cols: Option<u16>,
        rows: Option<u16>,
    },
    /// Bytes the terminal printed since.
    Output { data: String },
    /// Orca's size of the terminal changed.
    Size { cols: u16, rows: u16 },
    /// The terminal's stream ended (it exited, or Orca ended it), or could not start (`message` says why, in Japanese).
    Ended { message: String },
}

/// The size of the pane in cells, for a terminal that fits it.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaViewport {
    pub cols: u16,
    pub rows: u16,
}

/// A terminal the screen shows.
pub struct Watch {
    handle: String,
    /// The pane's size, which the terminal is fitted to.
    viewport: OrcaViewport,
    /// Gives an event to the screen; `false` when the screen no longer takes them.
    sink: Box<dyn FnMut(OrcaTermEvent) -> bool + Send>,
}

/// What the screen asks of the stream that runs.
pub enum StreamCommand {
    /// Show this terminal (it is subscribed in place of one shown before with the same handle); the others shown stay.
    Terminal(Watch),
    /// Show the terminal `handle` no more: it is unsubscribed.
    TerminalClose(String),
    /// The pane's size changed (the terminal `handle`, the first field, fits it).
    Viewport(String, OrcaViewport),
    /// Keys typed into the terminal `handle` (the first field); they go only while it is a terminal subscribed, and the answer says whether Orca took them.
    Input(String, String, oneshot::Sender<Result<(), String>>),
    Close,
}

// ---- what Orca sends ----

/// What an answer of `session.tabs.subscribeAll` did to the tabs held.
#[derive(Debug, PartialEq)]
enum TabsChange {
    Changed,
    Ended,
    Other,
}

/// Keeps the tabs of each worktree by its id: `snapshots` replaces them all, `updated` replaces one worktree's (`removed` drops it).
fn apply_tabs(tabs: &mut HashMap<String, Value>, result: &Value) -> TabsChange {
    fn put(tabs: &mut HashMap<String, Value>, snapshot: &Value) {
        let Some(id) = text_of(snapshot, "worktree") else {
            return;
        };
        if snapshot["removed"] == true {
            tabs.remove(id);
        } else {
            tabs.insert(id.to_owned(), snapshot["tabs"].clone());
        }
    }
    match result["type"].as_str() {
        Some("snapshots") => {
            tabs.clear();
            for snapshot in result["snapshots"].as_array().into_iter().flatten() {
                put(tabs, snapshot);
            }
            TabsChange::Changed
        }
        Some("updated") => {
            put(tabs, result);
            TabsChange::Changed
        }
        Some("end") => TabsChange::Ended,
        _ => TabsChange::Other,
    }
}

/// The terminal tabs of a worktree's tabs.
fn terminal_tabs(tabs: &Value) -> impl Iterator<Item = &Value> {
    tabs.as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["type"] == "terminal")
}

/// The worktrees that have terminals in the tabs and that `worktree.ps` (`ps`, its `result`) does not list.
fn unknown_worktrees(ps: &Value, tabs: &HashMap<String, Value>) -> HashSet<String> {
    let known: HashSet<&str> = ps["worktrees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|w| text_of(w, "worktreeId"))
        .collect();
    tabs.iter()
        .filter(|(id, tabs)| !known.contains(id.as_str()) && terminal_tabs(tabs).next().is_some())
        .map(|(id, _)| id.clone())
        .collect()
}

fn ms_of(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

/// The tabs as the two documents of the CLI that A-6 and A-8 read (`orca worktree ps` and `orca terminal list`), so that the same pure functions build the list.
/// A worktree's agents are the agents of its terminal tabs (a tab's agent is its pane's own, so it is top-level), with a live pty while the tab has a terminal;
/// its own status is left out (the stream does not refresh it), and its last activity is the latest of its own and its agents'. A terminal is each terminal tab that has a handle.
/// A tab that launched Claude and has a terminal but no `agentStatus` is an idle agent of its pane (`{parentTabId}:{leafId}`), so its row does not come and go with the status.
fn documents_of(ps: &Value, tabs: &HashMap<String, Value>) -> (Value, Value) {
    let mut terminals = Vec::new();
    let worktrees: Vec<Value> = ps["worktrees"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|worktree| {
            let mut worktree = worktree.clone();
            let mut agents = Vec::new();
            let mut at = ms_of(&worktree["lastActivityAt"]);
            let held = text_of(&worktree, "worktreeId").and_then(|id| tabs.get(id));
            for tab in held.into_iter().flat_map(terminal_tabs) {
                let handle = text_of(tab, "terminal");
                let status = &tab["agentStatus"];
                let agent_type =
                    text_of(status, "agentType").or_else(|| text_of(tab, "launchAgent"));
                if let Some(handle) = handle {
                    terminals.push(json!({
                        "handle": handle, "tabId": tab["parentTabId"], "leafId": tab["leafId"],
                        "title": tab["title"], "worktreePath": worktree["path"],
                        "agentIdentity": agent_type, "orphaned": false,
                    }));
                }
                if status.is_object() {
                    let mut agent = status.clone();
                    agent["hasLivePty"] = json!(handle.is_some());
                    agent["agentType"] = json!(agent_type);
                    at = at.max(ms_of(&status["updatedAt"]));
                    agents.push(agent);
                } else if let (Some("claude"), Some(_), Some(tab_id), Some(leaf_id)) = (
                    agent_type,
                    handle,
                    text_of(tab, "parentTabId"),
                    text_of(tab, "leafId"),
                ) {
                    // Orca drops `agentStatus` for a moment while the pane keeps its terminal: the tab stays a row of its pane (idle), so the screen keeps its tab and its terminal.
                    agents.push(json!({
                        "paneKey": format!("{tab_id}:{leaf_id}"), "parentPaneKey": null,
                        "state": "inactive", "agentType": "claude", "hasLivePty": true,
                    }));
                }
            }
            if let Some(fields) = worktree.as_object_mut() {
                fields.remove("sidebarStatus");
                fields.remove("status");
                fields.insert("agents".into(), Value::Array(agents));
                fields.insert("lastActivityAt".into(), json!(at));
            }
            worktree
        })
        .collect();
    (
        json!({"worktrees": worktrees}),
        json!({"terminals": terminals}),
    )
}

/// The list the screen draws, from `worktree.ps` (its `result`) and the tabs held.
fn list_of(ps: &Value, tabs: &HashMap<String, Value>) -> OrcaStreamEvent {
    let (worktrees_doc, terminals_doc) = documents_of(ps, tabs);
    let rows = rows_of(&worktrees_doc, &terminals_doc);
    let terminals = plain_terminals_of(&worktrees_doc, &terminals_doc);
    let (projects, hosts) = projects_of(&worktrees_doc, &rows, &terminals);
    OrcaStreamEvent::List {
        rows,
        worktrees: worktrees_of(ps),
        projects,
        hosts,
        terminals,
    }
}

/// Whether `handle` is the terminal of a tab held.
fn has_terminal(tabs: &HashMap<String, Value>, handle: &str) -> bool {
    tabs.values()
        .flat_map(terminal_tabs)
        .any(|t| text_of(t, "terminal") == Some(handle))
}

/// An answer of `terminal.subscribe` (its `result`) as an event for the screen: the screen now (`scrollback`, or `subscribed` for a terminal with no pty, whose lines are all there is),
/// the bytes since (`data`), a size Orca set (`fit-override-changed`) and the end. Anything else is of no use to the screen.
fn term_event_of(result: &Value) -> Option<OrcaTermEvent> {
    let size = |key: &str| {
        result[key]
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n > 0)
    };
    match result["type"].as_str()? {
        "scrollback" | "subscribed" => {
            let data = result["serialized"].as_str().map_or_else(
                || {
                    result["lines"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\r\n")
                },
                str::to_owned,
            );
            Some(OrcaTermEvent::Snapshot {
                data,
                cols: size("cols"),
                rows: size("rows"),
            })
        }
        "data" => result["chunk"].as_str().map(|data| OrcaTermEvent::Output {
            data: data.to_owned(),
        }),
        "fit-override-changed" => Some(OrcaTermEvent::Size {
            cols: size("cols")?,
            rows: size("rows")?,
        }),
        "end" => Some(OrcaTermEvent::Ended {
            message: String::new(),
        }),
        _ => None,
    }
}

/// A size Orca takes: a pane too small or too large for it is sent at the nearest size it takes.
pub(crate) fn clamp_viewport(viewport: OrcaViewport) -> OrcaViewport {
    OrcaViewport {
        cols: viewport.cols.clamp(MIN_COLS, MAX_COLS),
        rows: viewport.rows.clamp(MIN_ROWS, MAX_ROWS),
    }
}

fn client_of(client: &str) -> Value {
    json!({"id": client, "type": "desktop"})
}

/// `terminal.subscribe` as a desktop viewer named `client`; the terminal is sized to the pane while the subscription lasts, and Orca gives it back its own size after it.
fn subscribe_params(handle: &str, client: &str, viewport: OrcaViewport) -> Value {
    let v = clamp_viewport(viewport);
    json!({"terminal": handle, "client": client_of(client), "viewport": {"cols": v.cols, "rows": v.rows}})
}

/// `terminal.updateViewport`: the new size of the pane, claimed so that it is the size the terminal takes.
fn viewport_params(handle: &str, client: &str, viewport: OrcaViewport) -> Value {
    let v = clamp_viewport(viewport);
    json!({
        "terminal": handle, "client": client_of(client),
        "viewport": {"cols": v.cols, "rows": v.rows}, "claim": true,
    })
}

/// `terminal.unsubscribe` of the subscription made by the request `request_id` (the id of a desktop viewer's subscription is `{handle}:{client}`).
fn unsubscribe_params(handle: &str, client: &str, request_id: &str) -> Value {
    json!({"subscriptionId": format!("{handle}:{client}"), "requestId": request_id})
}

/// A name for this app's viewer that no other copy of the app has, so that two of them (a development build and the installed app) do not end each other's subscriptions.
fn new_client() -> String {
    let mut random = [0u8; 8];
    // Without randomness every copy shares the fallback name, which only risks that ending.
    let _ = getrandom::fill(&mut random);
    let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
    format!("cookapps-{hex}")
}

// ---- the stream ----

/// The request that subscribed a terminal on the connection.
struct Subscribed {
    request_id: String,
}

/// What one connection holds.
struct Connection {
    ps: Value,
    /// The worktrees a read of `worktree.ps` was made for, so that one it never lists is not asked for again and again.
    asked: HashSet<String>,
    ps_request: Option<String>,
    tabs_request: String,
    tabs: HashMap<String, Value>,
    loaded: bool,
    /// The terminals subscribed on the connection, by handle.
    terminals: HashMap<String, Subscribed>,
    /// The terminals the screen shows that have ended on this connection (not listed, refused or ended by Orca), so a change of the list does not subscribe them again; a terminal shown anew, or the next connection, does.
    ended: HashSet<String>,
    inputs: HashMap<String, oneshot::Sender<Result<(), String>>>,
    last_list: Option<OrcaStreamEvent>,
}

/// What lasts over the connections: the name of the viewer and the terminals the screen shows, by handle.
struct Stream {
    client: String,
    watches: HashMap<String, Watch>,
    attempt: usize,
}

const NOT_CONNECTED: &str = "接続先につながっていません";
const OTHER_TERMINAL: &str = "入力したターミナルは表示されていないため、送りませんでした";

impl Connection {
    /// Subscribes the terminals the screen shows that are not subscribed, once the list is held (each must be a terminal of it).
    async fn subscribe(&mut self, link: &mut WsLink, stream: &mut Stream) -> Result<(), String> {
        if !self.loaded {
            return Ok(());
        }
        let mut handles: Vec<String> = stream.watches.keys().cloned().collect();
        handles.sort();
        for handle in handles {
            if self.terminals.contains_key(&handle) || self.ended.contains(&handle) {
                continue;
            }
            let watch = stream
                .watches
                .get_mut(&handle)
                .expect("a handle just listed");
            if !has_terminal(&self.tabs, &handle) {
                self.ended.insert(handle);
                (watch.sink)(OrcaTermEvent::Ended {
                    message: "このターミナルは一覧にありません".into(),
                });
                continue;
            }
            let request_id = link
                .send_request(
                    "terminal.subscribe",
                    subscribe_params(&handle, &stream.client, watch.viewport),
                )
                .await
                .map_err(reason_of)?;
            self.terminals.insert(handle, Subscribed { request_id });
        }
        Ok(())
    }

    /// Ends the subscription of the terminal `handle`, so Orca gives the terminal back its own size. The answer is not waited for.
    async fn unsubscribe(
        &mut self,
        link: &mut WsLink,
        client: &str,
        handle: &str,
    ) -> Result<(), String> {
        if let Some(sub) = self.terminals.remove(handle) {
            link.send_request(
                "terminal.unsubscribe",
                unsubscribe_params(handle, client, &sub.request_id),
            )
            .await
            .map_err(reason_of)?;
        }
        Ok(())
    }

    /// Ends every subscription.
    async fn unsubscribe_all(&mut self, link: &mut WsLink, client: &str) -> Result<(), String> {
        let mut handles: Vec<String> = self.terminals.keys().cloned().collect();
        handles.sort();
        for handle in handles {
            self.unsubscribe(link, client, &handle).await?;
        }
        Ok(())
    }

    /// Sends the list when it changed, and asks `worktree.ps` again when a worktree it does not list has terminals.
    async fn publish(
        &mut self,
        link: &mut WsLink,
        sink: &mut impl FnMut(OrcaStreamEvent),
    ) -> Result<(), String> {
        let unknown = unknown_worktrees(&self.ps, &self.tabs);
        if self.ps_request.is_none() && !unknown.is_subset(&self.asked) {
            self.asked.extend(unknown);
            self.ps_request = Some(
                link.send_request("worktree.ps", json!({"limit": WORKTREE_LIMIT}))
                    .await
                    .map_err(reason_of)?,
            );
        }
        let list = list_of(&self.ps, &self.tabs);
        if self.last_list.as_ref() != Some(&list) {
            self.last_list = Some(list.clone());
            sink(list);
        }
        Ok(())
    }

    /// One answer of the connection.
    async fn on_response(
        &mut self,
        response: &Value,
        link: &mut WsLink,
        stream: &mut Stream,
        sink: &mut impl FnMut(OrcaStreamEvent),
    ) -> Result<(), String> {
        let id = response["id"].as_str().unwrap_or_default();
        if id == self.tabs_request {
            let result = result_of(response).map_err(reason_of)?;
            match apply_tabs(&mut self.tabs, &result) {
                TabsChange::Changed => {
                    if !self.loaded {
                        self.loaded = true;
                        stream.attempt = 0;
                        sink(OrcaStreamEvent::Status {
                            live: true,
                            message: String::new(),
                        });
                    }
                    self.publish(link, sink).await?;
                    self.subscribe(link, stream).await?;
                }
                TabsChange::Ended => return Err("一覧の購読が終わりました".into()),
                TabsChange::Other => {}
            }
        } else if self.ps_request.as_deref() == Some(id) {
            self.ps_request = None;
            // A failed read leaves the names held; the next unknown worktree asks again.
            if let Ok(ps) = result_of(response) {
                self.ps = ps;
                self.publish(link, sink).await?;
            }
        } else if let Some(handle) = self
            .terminals
            .iter()
            .find(|(_, t)| t.request_id == id)
            .map(|(handle, _)| handle.clone())
        {
            let event = match result_of(response) {
                Ok(result) => term_event_of(&result),
                Err(e) => Some(OrcaTermEvent::Ended {
                    message: reason_of(e),
                }),
            };
            if let Some(event) = event {
                if matches!(event, OrcaTermEvent::Ended { .. }) {
                    self.terminals.remove(&handle);
                    self.ended.insert(handle.clone());
                }
                let taken = stream
                    .watches
                    .get_mut(&handle)
                    .is_some_and(|w| (w.sink)(event));
                if !taken {
                    // The screen is gone: the terminal is let go.
                    stream.watches.remove(&handle);
                    self.unsubscribe(link, &stream.client, &handle).await?;
                }
            }
        } else if let Some(reply) = self.inputs.remove(id) {
            let _ = reply.send(
                result_of(response)
                    .map_err(reason_of)
                    .and_then(|result| check_accepted(&result)),
            );
        }
        Ok(())
    }

    /// One command of the screen; `false` ends the stream.
    async fn on_command(
        &mut self,
        command: Option<StreamCommand>,
        link: &mut WsLink,
        stream: &mut Stream,
    ) -> Result<bool, String> {
        match command {
            None | Some(StreamCommand::Close) => return Ok(false),
            Some(StreamCommand::Terminal(watch)) => {
                let handle = watch.handle.clone();
                self.unsubscribe(link, &stream.client, &handle).await?;
                self.ended.remove(&handle);
                stream.watches.insert(handle, watch);
                self.subscribe(link, stream).await?;
            }
            Some(StreamCommand::TerminalClose(handle)) => {
                stream.watches.remove(&handle);
                self.ended.remove(&handle);
                self.unsubscribe(link, &stream.client, &handle).await?;
            }
            Some(StreamCommand::Viewport(handle, viewport)) => {
                if let Some(watch) = stream.watches.get_mut(&handle) {
                    watch.viewport = viewport;
                    if self.terminals.contains_key(&handle) {
                        // The answer is of no use: a size Orca does not take leaves the terminal as it was.
                        link.send_request(
                            "terminal.updateViewport",
                            viewport_params(&handle, &stream.client, viewport),
                        )
                        .await
                        .map_err(reason_of)?;
                    }
                }
            }
            Some(StreamCommand::Input(handle, text, reply)) => {
                match (
                    self.terminals.contains_key(&handle),
                    stream.watches.get(&handle),
                ) {
                    (true, watch) => {
                        // The terminal fits its pane, so every send claims the pane's size, as Orca's own screen does.
                        let viewport = watch.map(|w| w.viewport);
                        let id = link
                            .send_request(
                                "terminal.send",
                                input_params(&handle, &text, &stream.client, viewport),
                            )
                            .await
                            .map_err(reason_of)?;
                        self.inputs.insert(id, reply);
                    }
                    // Keys typed into a terminal that is no longer shown (the screen showed another meanwhile) never reach it.
                    (false, None) => {
                        let _ = reply.send(Err(OTHER_TERMINAL.into()));
                    }
                    (false, Some(_)) => {
                        let _ = reply.send(Err(NOT_CONNECTED.into()));
                    }
                }
            }
        }
        Ok(true)
    }
}

/// Serves one connection until it fails (`Err`, with the reason) or the screen closes the stream (`Ok`).
async fn serve(
    link: &mut WsLink,
    stream: &mut Stream,
    commands: &mut UnboundedReceiver<StreamCommand>,
    sink: &mut impl FnMut(OrcaStreamEvent),
) -> Result<(), String> {
    let ps = link
        .request("worktree.ps", json!({"limit": WORKTREE_LIMIT}))
        .await
        .map_err(reason_of)?;
    let tabs_request = link
        .send_request("session.tabs.subscribeAll", json!({}))
        .await
        .map_err(reason_of)?;
    let mut connection = Connection {
        ps,
        asked: HashSet::new(),
        ps_request: None,
        tabs_request,
        tabs: HashMap::new(),
        loaded: false,
        terminals: HashMap::new(),
        ended: HashSet::new(),
        inputs: HashMap::new(),
        last_list: None,
    };
    loop {
        let silence = link.silence_deadline();
        tokio::select! {
            command = commands.recv() => {
                if !connection.on_command(command, link, stream).await? {
                    // Best effort: closing the socket ends the subscriptions anyway.
                    let _ = connection.unsubscribe_all(link, &stream.client).await;
                    return Ok(());
                }
            }
            () = sleep_until(silence) => return Err("接続先からの応答が途絶えました".into()),
            response = link.next_response() => {
                if let Some(response) = response? {
                    connection.on_response(&response, link, stream, sink).await?;
                }
            }
        }
    }
}

/// Connects and serves again and again, after a growing wait, until the screen closes the stream. While disconnected the terminal to show is remembered and keys are refused.
async fn run_loop<F, Fut>(
    mut open: F,
    mut commands: UnboundedReceiver<StreamCommand>,
    mut sink: impl FnMut(OrcaStreamEvent),
    client: String,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<WsLink, String>>,
{
    let mut stream = Stream {
        client,
        watches: HashMap::new(),
        attempt: 0,
    };
    loop {
        let result = match open().await {
            Ok(mut link) => serve(&mut link, &mut stream, &mut commands, &mut sink).await,
            Err(reason) => Err(reason),
        };
        let Err(reason) = result else {
            return;
        };
        sink(OrcaStreamEvent::Status {
            live: false,
            message: reason,
        });
        let until = Instant::now() + backoff(stream.attempt);
        stream.attempt += 1;
        loop {
            tokio::select! {
                () = sleep_until(until) => break,
                command = commands.recv() => match command {
                    None | Some(StreamCommand::Close) => return,
                    Some(StreamCommand::Terminal(watch)) => {
                        stream.watches.insert(watch.handle.clone(), watch);
                    }
                    Some(StreamCommand::TerminalClose(handle)) => {
                        stream.watches.remove(&handle);
                    }
                    Some(StreamCommand::Viewport(handle, viewport)) => {
                        if let Some(watch) = stream.watches.get_mut(&handle) {
                            watch.viewport = viewport;
                        }
                    }
                    Some(StreamCommand::Input(_, _, reply)) => {
                        let _ = reply.send(Err(NOT_CONNECTED.into()));
                    }
                },
            }
        }
    }
}

// ---- the commands ----

struct Active {
    task: tauri::async_runtime::JoinHandle<()>,
    commands: UnboundedSender<StreamCommand>,
}

/// The one stream that runs: opening another ends it.
#[derive(Default)]
pub struct OrcaStream(std::sync::Mutex<Option<Active>>);

impl OrcaStream {
    fn send(&self, command: StreamCommand) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .ok_or(NOT_CONNECTED)?
            .commands
            .send(command)
            .map_err(|_| NOT_CONNECTED.to_owned())
    }
}

/// Starts the stream of the saved environment `environment`, which sends the list through `channel` until the next open or close. A send that fails (the screen is gone) ends it.
#[tauri::command]
pub async fn orca_stream_open(
    state: tauri::State<'_, OrcaStream>,
    environment: String,
    channel: tauri::ipc::Channel<OrcaStreamEvent>,
) -> Result<(), String> {
    if environment.trim().is_empty() {
        return Err("接続先が正しくありません".into());
    }
    let mut active = state.0.lock().unwrap();
    if let Some(old) = active.take() {
        old.task.abort();
    }
    let (commands, receiver) = unbounded_channel();
    let closer = commands.clone();
    let task = tauri::async_runtime::spawn(run_loop(
        move || connect_environment(environment.clone()),
        receiver,
        move |event| {
            if channel.send(event).is_err() {
                let _ = closer.send(StreamCommand::Close);
            }
        },
        new_client(),
    ));
    *active = Some(Active { task, commands });
    Ok(())
}

/// Ends the stream that runs, if any (its subscriptions end with its connection).
#[tauri::command]
pub async fn orca_stream_close(state: tauri::State<'_, OrcaStream>) -> Result<(), String> {
    if let Some(active) = state.0.lock().unwrap().take() {
        let _ = active.commands.send(StreamCommand::Close);
    }
    Ok(())
}

/// Shows the terminal `handle` (as another pane's terminal may be shown too): its screen and what it prints go through `channel`. The terminal fits the pane's size, `viewport`.
#[tauri::command]
pub async fn orca_stream_terminal(
    state: tauri::State<'_, OrcaStream>,
    handle: String,
    viewport: OrcaViewport,
    channel: tauri::ipc::Channel<OrcaTermEvent>,
) -> Result<(), String> {
    check_handle(&handle)?;
    state.send(StreamCommand::Terminal(Watch {
        handle,
        viewport,
        sink: Box::new(move |event| channel.send(event).is_ok()),
    }))
}

/// Shows the terminal `handle` no more: it is unsubscribed, and Orca gives it back its own size.
#[tauri::command]
pub async fn orca_stream_terminal_close(
    state: tauri::State<'_, OrcaStream>,
    handle: String,
) -> Result<(), String> {
    check_handle(&handle)?;
    // With no stream there is nothing to let go.
    let _ = state.send(StreamCommand::TerminalClose(handle));
    Ok(())
}

/// The new size of the pane of the terminal `handle`.
#[tauri::command]
pub async fn orca_stream_viewport(
    state: tauri::State<'_, OrcaStream>,
    handle: String,
    viewport: OrcaViewport,
) -> Result<(), String> {
    check_handle(&handle)?;
    state.send(StreamCommand::Viewport(handle, viewport))
}

/// Types `text` into the terminal `handle`, as it is (no Enter is added), only while it is a terminal shown.
#[tauri::command]
pub async fn orca_stream_input(
    state: tauri::State<'_, OrcaStream>,
    handle: String,
    text: String,
) -> Result<(), String> {
    check_handle(&handle)?;
    check_keys(&text)?;
    let (reply, answer) = oneshot::channel();
    state.send(StreamCommand::Input(handle, text, reply))?;
    answer
        .await
        .unwrap_or_else(|_| Err("接続が切れたため、入力を送れたか分かりません".into()))
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use super::*;
    use crate::{
        orca::{OrcaGroup, OrcaStatus},
        orca_chat::ws_testing::{bind, FakeDesktop},
        orca_e2ee::testing::Desktop,
    };

    fn ps() -> Value {
        json!({"worktrees": [
            {"worktreeId": "r1::/w/a", "path": "/w/a", "repo": "a", "repoId": "r1", "displayName": "main",
             "lastActivityAt": 1_000, "sidebarStatus": "working",
             "agents": [{"paneKey": "old:old", "hasLivePty": true, "agentType": "claude", "state": "working"}]},
            {"worktreeId": "r2::/w/b", "path": "/w/b", "repo": "b", "repoId": "r2", "displayName": "dev", "lastActivityAt": 500},
        ]})
    }

    fn claude_tab(tab: &str, handle: Option<&str>, state: &str, updated: u64) -> Value {
        json!({
            "type": "terminal", "id": format!("{tab}-leaf"), "title": "claude", "parentTabId": tab, "leafId": "l1",
            "status": if handle.is_some() { "ready" } else { "pending-handle" }, "terminal": handle,
            "agentStatus": {"paneKey": format!("{tab}:l1"), "state": state, "agentType": "claude", "prompt": "Fix the bug\nmore",
                            "updatedAt": updated, "stateStartedAt": 900},
            "isActive": true,
        })
    }

    fn shell_tab(tab: &str, handle: &str, title: &str) -> Value {
        json!({"type": "terminal", "id": format!("{tab}-leaf"), "title": title, "parentTabId": tab, "leafId": "l2",
               "status": "ready", "terminal": handle, "agentStatus": null, "isActive": false})
    }

    fn snapshots(worktrees: &[(&str, Vec<Value>)]) -> Value {
        json!({"type": "snapshots", "snapshots": worktrees.iter().map(|(id, tabs)| json!({"worktree": id, "tabs": tabs})).collect::<Vec<_>>()})
    }

    fn held(result: &Value) -> HashMap<String, Value> {
        let mut tabs = HashMap::new();
        assert_eq!(apply_tabs(&mut tabs, result), TabsChange::Changed);
        tabs
    }

    #[test]
    fn snapshots_replace_the_tabs_and_an_update_replaces_or_removes_one_worktree() {
        let mut tabs = held(&snapshots(&[
            ("r1::/w/a", vec![shell_tab("t1", "term_1", "zsh")]),
            ("r2::/w/b", vec![]),
        ]));
        assert_eq!(tabs.len(), 2);
        let update = json!({"type": "updated", "worktree": "r2::/w/b", "tabs": [shell_tab("t2", "term_2", "vim")]});
        assert_eq!(apply_tabs(&mut tabs, &update), TabsChange::Changed);
        assert_eq!(tabs["r2::/w/b"][0]["terminal"], "term_2");
        let removed =
            json!({"type": "updated", "worktree": "r1::/w/a", "removed": true, "tabs": []});
        assert_eq!(apply_tabs(&mut tabs, &removed), TabsChange::Changed);
        assert!(!tabs.contains_key("r1::/w/a"));
        // A new snapshot drops what is not in it.
        let mut tabs2 = tabs.clone();
        apply_tabs(&mut tabs2, &snapshots(&[("r3::/w/c", vec![])]));
        assert_eq!(tabs2.keys().collect::<Vec<_>>(), ["r3::/w/c"]);
        assert_eq!(
            apply_tabs(&mut tabs, &json!({"type": "end"})),
            TabsChange::Ended
        );
        // Anything else, and a change with no worktree, changes nothing.
        let before = tabs.clone();
        assert_eq!(
            apply_tabs(&mut tabs, &json!({"type": "other"})),
            TabsChange::Other
        );
        apply_tabs(&mut tabs, &json!({"type": "updated", "tabs": []}));
        assert_eq!(tabs, before);
        assert_eq!(apply_tabs(&mut tabs, &Value::Null), TabsChange::Other);
    }

    #[test]
    fn the_list_is_built_from_the_tabs_and_named_by_the_worktrees() {
        let tabs = held(&snapshots(&[(
            "r1::/w/a",
            vec![
                claude_tab("t1", Some("term_c"), "working", 2_000),
                shell_tab("t2", "term_s", "zsh"),
                json!({"type": "browser", "id": "b1", "title": "docs"}),
            ],
        )]));
        let OrcaStreamEvent::List {
            rows,
            worktrees,
            projects,
            hosts,
            terminals,
        } = list_of(&ps(), &tabs)
        else {
            panic!()
        };
        // The agent of the tab, not the one `worktree.ps` had.
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.pane_key.as_deref(), Some("t1:l1"));
        assert_eq!(row.handle.as_deref(), Some("term_c"));
        assert_eq!(row.line, "Fix the bug");
        assert_eq!((row.repo.as_str(), row.branch.as_str()), ("a", "main"));
        assert_eq!(row.group, OrcaGroup::Working);
        assert_eq!(row.project_key, "r1");
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0].handle, "term_s");
        assert_eq!(terminals[0].title, "zsh");
        assert_eq!(worktrees.len(), 2);
        assert!(hosts.is_empty());
        // The project with tabs comes first (its agent is newer), and shows its agent: the worktree's own status is not taken.
        assert_eq!(projects[0].key, "r1");
        assert_eq!(projects[0].sessions, 2);
        assert_eq!(projects[0].status, OrcaStatus::Working);
        assert_eq!(projects[1].status, OrcaStatus::Idle);
    }

    #[test]
    fn a_tab_without_a_terminal_is_a_row_that_takes_no_keys() {
        let tabs = held(&snapshots(&[(
            "r1::/w/a",
            vec![claude_tab("t1", None, "waiting", 2_000)],
        )]));
        let (worktrees, terminals) = documents_of(&ps(), &tabs);
        assert_eq!(worktrees["worktrees"][0]["agents"][0]["hasLivePty"], false);
        assert_eq!(terminals["terminals"], json!([]));
        let OrcaStreamEvent::List { rows, .. } = list_of(&ps(), &tabs) else {
            panic!()
        };
        // `rows_of` keeps only agents of a live pty.
        assert!(rows.is_empty());
        assert!(!has_terminal(&tabs, "term_c"));
    }

    #[test]
    fn the_agent_type_falls_back_to_the_agent_the_tab_launched() {
        let mut tab = claude_tab("t1", Some("term_c"), "done", 2_000);
        tab["agentStatus"]
            .as_object_mut()
            .unwrap()
            .remove("agentType");
        tab["launchAgent"] = json!("claude");
        let tabs = held(&snapshots(&[("r1::/w/a", vec![tab])]));
        let OrcaStreamEvent::List {
            rows, terminals, ..
        } = list_of(&ps(), &tabs)
        else {
            panic!()
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].group, OrcaGroup::Done);
        // A Claude tab is not a plain terminal.
        assert!(terminals.is_empty());
        assert!(has_terminal(&tabs, "term_c"));
    }

    #[test]
    fn a_claude_tab_without_a_status_stays_a_row_of_its_pane() {
        // Orca drops `agentStatus` for a moment while the pane keeps its terminal: the tab must not leave the list.
        let mut tab = claude_tab("t1", Some("term_c"), "done", 2_000);
        tab["agentStatus"] = Value::Null;
        tab["launchAgent"] = json!("claude");
        let tabs = held(&snapshots(&[("r1::/w/a", vec![tab.clone()])]));
        let (worktrees, _) = documents_of(&ps(), &tabs);
        let agent = &worktrees["worktrees"][0]["agents"][0];
        assert_eq!(agent["paneKey"], "t1:l1");
        assert_eq!(agent["hasLivePty"], true);
        assert_eq!(agent["state"], "inactive");
        let OrcaStreamEvent::List {
            rows, terminals, ..
        } = list_of(&ps(), &tabs)
        else {
            panic!()
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pane_key.as_deref(), Some("t1:l1"));
        assert_eq!(rows[0].handle.as_deref(), Some("term_c"));
        assert_eq!(rows[0].group, OrcaGroup::Working);
        assert_eq!(rows[0].status, OrcaStatus::Idle);
        assert!(terminals.is_empty());
        // The row has the pane key it has with a status, so the screen keeps the tab and its terminal.
        let with_status = held(&snapshots(&[(
            "r1::/w/a",
            vec![claude_tab("t1", Some("term_c"), "done", 2_000)],
        )]));
        let OrcaStreamEvent::List { rows: after, .. } = list_of(&ps(), &with_status) else {
            panic!()
        };
        assert_eq!(after[0].pane_key, rows[0].pane_key);
        // A tab with no terminal, one that launched no agent and one of another agent get no such row.
        for (launch, handle) in [
            ("claude", None),
            ("", Some("term_c")),
            ("codex", Some("term_c")),
        ] {
            let mut other = tab.clone();
            other["launchAgent"] = json!(launch);
            other["terminal"] = json!(handle);
            let tabs = held(&snapshots(&[("r1::/w/a", vec![other])]));
            let (worktrees, _) = documents_of(&ps(), &tabs);
            assert_eq!(worktrees["worktrees"][0]["agents"], json!([]));
        }
        // Without the ids of its pane there is no pane to name.
        let mut no_leaf = tab;
        no_leaf["leafId"] = Value::Null;
        let tabs = held(&snapshots(&[("r1::/w/a", vec![no_leaf])]));
        let (worktrees, _) = documents_of(&ps(), &tabs);
        assert_eq!(worktrees["worktrees"][0]["agents"], json!([]));
    }

    #[test]
    fn only_a_worktree_with_terminals_that_ps_does_not_list_is_unknown() {
        let tabs = held(&snapshots(&[
            ("r1::/w/a", vec![shell_tab("t1", "term_1", "zsh")]),
            ("r9::/w/z", vec![shell_tab("t9", "term_9", "zsh")]),
            (
                "r8::/w/y",
                vec![json!({"type": "browser", "id": "b", "title": "x"})],
            ),
        ]));
        assert_eq!(
            unknown_worktrees(&ps(), &tabs),
            HashSet::from(["r9::/w/z".to_owned()])
        );
        assert_eq!(
            unknown_worktrees(&Value::Null, &HashMap::new()),
            HashSet::new()
        );
    }

    #[test]
    fn odd_documents_are_tolerated() {
        let OrcaStreamEvent::List {
            rows,
            worktrees,
            projects,
            terminals,
            ..
        } = list_of(&Value::Null, &HashMap::new())
        else {
            panic!()
        };
        assert!(
            rows.is_empty() && worktrees.is_empty() && projects.is_empty() && terminals.is_empty()
        );
        let mut tabs = HashMap::new();
        tabs.insert("r1::/w/a".to_owned(), json!("not tabs"));
        assert!(
            matches!(list_of(&ps(), &tabs), OrcaStreamEvent::List { rows, .. } if rows.is_empty())
        );
    }

    #[test]
    fn a_terminal_answer_is_its_screen_its_bytes_its_size_or_its_end() {
        assert_eq!(
            term_event_of(
                &json!({"type": "scrollback", "lines": ["x"], "serialized": "\u{1b}[1mhi", "cols": 100, "rows": 30})
            ),
            Some(OrcaTermEvent::Snapshot {
                data: "\u{1b}[1mhi".into(),
                cols: Some(100),
                rows: Some(30)
            })
        );
        // Without the serialized screen, the lines; a terminal with no pty says only its lines.
        assert_eq!(
            term_event_of(&json!({"type": "subscribed", "lines": ["a", "b"], "streamId": null})),
            Some(OrcaTermEvent::Snapshot {
                data: "a\r\nb".into(),
                cols: None,
                rows: None
            })
        );
        assert_eq!(
            term_event_of(&json!({"type": "data", "chunk": "ls\r\n"})),
            Some(OrcaTermEvent::Output {
                data: "ls\r\n".into()
            })
        );
        assert_eq!(
            term_event_of(
                &json!({"type": "fit-override-changed", "mode": "desktop-fit", "cols": 80, "rows": 24})
            ),
            Some(OrcaTermEvent::Size { cols: 80, rows: 24 })
        );
        assert_eq!(
            term_event_of(&json!({"type": "end"})),
            Some(OrcaTermEvent::Ended {
                message: String::new()
            })
        );
        for none in [
            json!({"type": "data"}),
            json!({"type": "fit-override-changed", "cols": 80}),
            json!({"type": "fit-override-changed", "cols": 0, "rows": 24}),
            json!({"type": "other"}),
            Value::Null,
        ] {
            assert_eq!(term_event_of(&none), None, "{none}");
        }
        // A size that is no size is left out.
        assert_eq!(
            term_event_of(&json!({"type": "scrollback", "cols": 70_000, "rows": -1})),
            Some(OrcaTermEvent::Snapshot {
                data: String::new(),
                cols: None,
                rows: None
            })
        );
    }

    #[test]
    fn the_params_name_the_viewer_and_a_size_orca_takes() {
        assert_eq!(
            subscribe_params("term_1", "cookapps-1", OrcaViewport { cols: 80, rows: 24 }),
            json!({"terminal": "term_1", "client": {"id": "cookapps-1", "type": "desktop"}, "viewport": {"cols": 80, "rows": 24}})
        );
        assert_eq!(
            subscribe_params("term_1", "cookapps-1", OrcaViewport { cols: 5, rows: 900 })
                ["viewport"],
            json!({"cols": 20, "rows": 500})
        );
        assert_eq!(
            viewport_params(
                "term_1",
                "cookapps-1",
                OrcaViewport {
                    cols: 2000,
                    rows: 1
                }
            ),
            json!({"terminal": "term_1", "client": {"id": "cookapps-1", "type": "desktop"},
                   "viewport": {"cols": 1000, "rows": 8}, "claim": true})
        );
        assert_eq!(
            unsubscribe_params("term_1", "cookapps-1", "c7"),
            json!({"subscriptionId": "term_1:cookapps-1", "requestId": "c7"})
        );
        let (a, b) = (new_client(), new_client());
        assert!(a.starts_with("cookapps-") && a.len() == "cookapps-".len() + 16);
        assert_ne!(a, b);
    }

    #[test]
    fn the_events_are_tagged_by_kind_in_camel_case() {
        assert_eq!(
            serde_json::to_value(OrcaStreamEvent::Status {
                live: false,
                message: "x".into()
            })
            .unwrap(),
            json!({"kind": "status", "live": false, "message": "x"})
        );
        assert_eq!(
            serde_json::to_value(OrcaTermEvent::Snapshot {
                data: "a".into(),
                cols: None,
                rows: Some(3)
            })
            .unwrap(),
            json!({"kind": "snapshot", "data": "a", "cols": null, "rows": 3})
        );
        let viewport: OrcaViewport =
            serde_json::from_value(json!({"cols": 80, "rows": 24})).unwrap();
        assert_eq!(viewport, OrcaViewport { cols: 80, rows: 24 });
    }

    // -- the stream against a stand-in for Orca --

    type Seen<T> = Arc<Mutex<Vec<T>>>;

    async fn until<T: Clone>(seen: &Seen<T>, count: usize) -> Vec<T> {
        for _ in 0..500 {
            if seen.lock().unwrap().len() >= count {
                return seen.lock().unwrap().clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("only {} events", seen.lock().unwrap().len());
    }

    fn watch(handle: &str, viewport: OrcaViewport) -> (Watch, Seen<OrcaTermEvent>) {
        let seen: Seen<OrcaTermEvent> = Arc::default();
        let into = seen.clone();
        let watch = Watch {
            handle: handle.into(),
            viewport,
            sink: Box::new(move |event| {
                into.lock().unwrap().push(event);
                true
            }),
        };
        (watch, seen)
    }

    async fn streamed(server: &mut FakeDesktop, id: &Value, result: Value) {
        server
            .send(json!({"id": id, "ok": true, "streaming": true, "result": result}))
            .await;
    }

    /// Adds a worktree that `worktree.ps` does not list, and answers the read it makes: once the read is asked, the change has been handled.
    async fn changed_with_new_worktree(
        server: &mut FakeDesktop,
        tabs_id: &Value,
        worktree: &str,
        handle: &str,
    ) {
        streamed(
            server,
            tabs_id,
            json!({"type": "updated", "worktree": worktree, "tabs": [shell_tab("t9", handle, "zsh")]}),
        )
        .await;
        let read = server.request().await;
        assert_eq!(read["method"], "worktree.ps");
        server
            .send(json!({"id": read["id"], "ok": true, "result": ps()}))
            .await;
    }

    #[tokio::test]
    async fn the_stream_lists_shows_a_terminal_fits_it_types_and_lets_it_go() {
        let (listener, url) = bind().await;
        let desktop = Desktop::new([41; 32]);
        let key = desktop.public_key_b64();
        let (commands, receiver) = unbounded_channel();
        let list: Seen<OrcaStreamEvent> = Arc::default();
        let into = list.clone();
        let task = tokio::spawn(run_loop(
            move || {
                let (url, key) = (url.clone(), key.clone());
                async move { WsLink::connect(&url, "device-token", &key).await }
            },
            receiver,
            move |event| into.lock().unwrap().push(event),
            "cookapps-test".into(),
        ));
        let mut server = FakeDesktop::accept(&listener, desktop, "device-token", None).await;

        // `worktree.ps` once, then the list's subscription.
        let request = server.request().await;
        assert_eq!(request["method"], "worktree.ps");
        assert_eq!(request["params"], json!({"limit": 200}));
        server
            .send(json!({"id": request["id"], "ok": true, "result": ps()}))
            .await;
        let tabs = server.request().await;
        assert_eq!(tabs["method"], "session.tabs.subscribeAll");
        let tabs_id = tabs["id"].clone();
        streamed(
            &mut server,
            &tabs_id,
            snapshots(&[(
                "r1::/w/a",
                vec![
                    claude_tab("t1", Some("term_c"), "working", 2_000),
                    shell_tab("t2", "term_s", "zsh"),
                ],
            )]),
        )
        .await;
        let events = until(&list, 2).await;
        assert_eq!(
            events[0],
            OrcaStreamEvent::Status {
                live: true,
                message: String::new()
            }
        );
        assert!(
            matches!(&events[1], OrcaStreamEvent::List { rows, terminals, .. } if rows.len() == 1 && terminals.len() == 1)
        );

        // The terminal shown is subscribed with the pane's size, and its screen and bytes reach the screen.
        let (shown, term) = watch(
            "term_c",
            OrcaViewport {
                cols: 100,
                rows: 30,
            },
        );
        commands.send(StreamCommand::Terminal(shown)).ok().unwrap();
        let subscribe = server.request().await;
        assert_eq!(subscribe["method"], "terminal.subscribe");
        assert_eq!(
            subscribe["params"],
            json!({"terminal": "term_c", "client": {"id": "cookapps-test", "type": "desktop"}, "viewport": {"cols": 100, "rows": 30}})
        );
        let sub_id = subscribe["id"].clone();
        streamed(
            &mut server,
            &sub_id,
            json!({"type": "scrollback", "serialized": "hello", "cols": 100, "rows": 30}),
        )
        .await;
        streamed(&mut server, &sub_id, json!({"type": "data", "chunk": "x"})).await;
        assert_eq!(
            until(&term, 2).await,
            [
                OrcaTermEvent::Snapshot {
                    data: "hello".into(),
                    cols: Some(100),
                    rows: Some(30)
                },
                OrcaTermEvent::Output { data: "x".into() }
            ]
        );

        // A new size of the pane.
        commands
            .send(StreamCommand::Viewport(
                "term_c".into(),
                OrcaViewport {
                    cols: 120,
                    rows: 40,
                },
            ))
            .ok()
            .unwrap();
        let resize = server.request().await;
        assert_eq!(resize["method"], "terminal.updateViewport");
        assert_eq!(
            resize["params"],
            viewport_params(
                "term_c",
                "cookapps-test",
                OrcaViewport {
                    cols: 120,
                    rows: 40
                }
            )
        );

        // Keys: Orca's answer decides, and a send Orca did not take is a failure.
        for (accepted, ok) in [(true, true), (false, false)] {
            let (reply, answer) = oneshot::channel();
            commands
                .send(StreamCommand::Input("term_c".into(), "ls\r".into(), reply))
                .ok()
                .unwrap();
            let send = server.request().await;
            assert_eq!(send["method"], "terminal.send");
            assert_eq!(
                send["params"],
                input_params(
                    "term_c",
                    "ls\r",
                    "cookapps-test",
                    Some(OrcaViewport {
                        cols: 120,
                        rows: 40
                    })
                )
            );
            server
                .send(json!({"id": send["id"], "ok": true, "result": {"send": {"accepted": accepted}}}))
                .await;
            assert_eq!(answer.await.unwrap().is_ok(), ok);
        }

        // Keys typed into a terminal that is not shown are refused without a request (the next request is the read below).
        let (reply, answer) = oneshot::channel();
        commands
            .send(StreamCommand::Input("term_s".into(), "\r".into(), reply))
            .ok()
            .unwrap();
        assert_eq!(answer.await.unwrap(), Err(OTHER_TERMINAL.to_owned()));

        // A worktree that `worktree.ps` did not list makes it read again, once.
        let update = json!({"type": "updated", "worktree": "r9::/w/z", "tabs": [shell_tab("t9", "term_9", "zsh")]});
        streamed(&mut server, &tabs_id, update.clone()).await;
        let again = server.request().await;
        assert_eq!(again["method"], "worktree.ps");
        server
            .send(json!({"id": again["id"], "ok": true, "result": ps()}))
            .await;
        streamed(&mut server, &tabs_id, update).await;

        // Shown no more: it is let go by the request that subscribed it.
        commands
            .send(StreamCommand::TerminalClose("term_c".into()))
            .ok()
            .unwrap();
        let unsubscribe = server.request().await;
        assert_eq!(unsubscribe["method"], "terminal.unsubscribe");
        assert_eq!(
            unsubscribe["params"],
            unsubscribe_params("term_c", "cookapps-test", sub_id.as_str().unwrap())
        );

        // Keys into a terminal shown no more are refused without a request.
        let (reply, answer) = oneshot::channel();
        commands
            .send(StreamCommand::Input("term_c".into(), "x".into(), reply))
            .ok()
            .unwrap();
        assert_eq!(answer.await.unwrap(), Err(OTHER_TERMINAL.to_owned()));

        commands.send(StreamCommand::Close).ok().unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn a_terminal_that_is_not_listed_or_that_fails_ends_and_a_lost_connection_is_said() {
        let (listener, url) = bind().await;
        let desktop = Desktop::new([42; 32]);
        let key = desktop.public_key_b64();
        let (commands, receiver) = unbounded_channel();
        let list: Seen<OrcaStreamEvent> = Arc::default();
        let into = list.clone();
        let task = tokio::spawn(run_loop(
            move || {
                let (url, key) = (url.clone(), key.clone());
                async move { WsLink::connect(&url, "device-token", &key).await }
            },
            receiver,
            move |event| into.lock().unwrap().push(event),
            "cookapps-test".into(),
        ));
        // Asked for before the list came: it waits for the list.
        let (gone, gone_events) = watch("term_gone", OrcaViewport { cols: 80, rows: 24 });
        commands.send(StreamCommand::Terminal(gone)).ok().unwrap();
        let mut server = FakeDesktop::accept(&listener, desktop, "device-token", None).await;
        let request = server.request().await;
        server
            .send(json!({"id": request["id"], "ok": true, "result": ps()}))
            .await;
        let tabs = server.request().await;
        streamed(
            &mut server,
            &tabs["id"],
            snapshots(&[("r1::/w/a", vec![shell_tab("t2", "term_s", "zsh")])]),
        )
        .await;
        assert!(
            matches!(&until(&gone_events, 1).await[0], OrcaTermEvent::Ended { message } if message.contains("一覧"))
        );
        // A list that changes after the end does not say it again (the read of the new worktree is the point to wait for).
        changed_with_new_worktree(&mut server, &tabs["id"], "r9::/w/z", "term_9").await;

        // Orca refuses the subscription: the terminal ends with Orca's code, and no unsubscribe follows.
        let (shown, term) = watch("term_s", OrcaViewport { cols: 80, rows: 24 });
        commands.send(StreamCommand::Terminal(shown)).ok().unwrap();
        let subscribe = server.request().await;
        assert_eq!(subscribe["method"], "terminal.subscribe");
        assert_eq!(
            subscribe["params"]["viewport"],
            json!({"cols": 80, "rows": 24})
        );
        assert_eq!(gone_events.lock().unwrap().len(), 1);
        server
            .send(json!({"id": subscribe["id"], "ok": false, "error": {"code": "no_connected_pty", "message": "secret"}}))
            .await;
        let ended = until(&term, 1).await;
        assert!(
            matches!(&ended[0], OrcaTermEvent::Ended { message } if message.contains("no_connected_pty") && !message.contains("secret"))
        );

        // A list that changes after the end does not subscribe the ended terminal again; showing a terminal anew does.
        changed_with_new_worktree(&mut server, &tabs["id"], "r8::/w/y", "term_8").await;
        let (anew, _) = watch(
            "term_s",
            OrcaViewport {
                cols: 100,
                rows: 30,
            },
        );
        commands.send(StreamCommand::Terminal(anew)).ok().unwrap();
        let subscribe = server.request().await;
        assert_eq!(subscribe["method"], "terminal.subscribe");
        assert_eq!(
            subscribe["params"]["viewport"],
            json!({"cols": 100, "rows": 30})
        );
        assert_eq!(term.lock().unwrap().len(), 1);

        // The connection is lost: the screen is told, and keys are refused while it is down.
        drop(server);
        let events = until(&list, 3).await;
        assert!(
            matches!(&events[2], OrcaStreamEvent::Status { live: false, message } if !message.is_empty())
        );
        let (reply, answer) = oneshot::channel();
        commands
            .send(StreamCommand::Input("term_c".into(), "x".into(), reply))
            .ok()
            .unwrap();
        assert_eq!(answer.await.unwrap(), Err(NOT_CONNECTED.to_owned()));
        commands.send(StreamCommand::Close).ok().unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn several_terminals_are_shown_at_once_each_with_its_own_size_and_keys() {
        let (listener, url) = bind().await;
        let desktop = Desktop::new([43; 32]);
        let key = desktop.public_key_b64();
        let (commands, receiver) = unbounded_channel();
        let task = tokio::spawn(run_loop(
            move || {
                let (url, key) = (url.clone(), key.clone());
                async move { WsLink::connect(&url, "device-token", &key).await }
            },
            receiver,
            |_| {},
            "cookapps-test".into(),
        ));
        let mut server = FakeDesktop::accept(&listener, desktop, "device-token", None).await;
        let request = server.request().await;
        server
            .send(json!({"id": request["id"], "ok": true, "result": ps()}))
            .await;
        let tabs = server.request().await;
        streamed(
            &mut server,
            &tabs["id"],
            snapshots(&[(
                "r1::/w/a",
                vec![
                    claude_tab("t1", Some("term_c"), "working", 2_000),
                    shell_tab("t2", "term_s", "zsh"),
                ],
            )]),
        )
        .await;
        // Two terminals shown: each is subscribed with its own size, and neither lets the other go.
        let (first, first_events) = watch(
            "term_c",
            OrcaViewport {
                cols: 100,
                rows: 30,
            },
        );
        let (second, second_events) = watch("term_s", OrcaViewport { cols: 60, rows: 20 });
        commands.send(StreamCommand::Terminal(first)).ok().unwrap();
        let one = server.request().await;
        assert_eq!(one["method"], "terminal.subscribe");
        assert_eq!(one["params"]["terminal"], "term_c");
        commands.send(StreamCommand::Terminal(second)).ok().unwrap();
        let two = server.request().await;
        assert_eq!(two["method"], "terminal.subscribe");
        assert_eq!(two["params"]["terminal"], "term_s");
        assert_eq!(two["params"]["viewport"], json!({"cols": 60, "rows": 20}));
        // What each prints goes to its own screen.
        streamed(
            &mut server,
            &one["id"],
            json!({"type": "data", "chunk": "c"}),
        )
        .await;
        streamed(
            &mut server,
            &two["id"],
            json!({"type": "data", "chunk": "s"}),
        )
        .await;
        assert_eq!(
            until(&first_events, 1).await,
            [OrcaTermEvent::Output { data: "c".into() }]
        );
        assert_eq!(
            until(&second_events, 1).await,
            [OrcaTermEvent::Output { data: "s".into() }]
        );
        // A size is for one terminal.
        commands
            .send(StreamCommand::Viewport(
                "term_s".into(),
                OrcaViewport { cols: 70, rows: 25 },
            ))
            .ok()
            .unwrap();
        let resize = server.request().await;
        assert_eq!(resize["method"], "terminal.updateViewport");
        assert_eq!(resize["params"]["terminal"], "term_s");
        assert_eq!(
            resize["params"]["viewport"],
            json!({"cols": 70, "rows": 25})
        );
        // Keys go to the terminal they were typed in, with its own size.
        let (reply, answer) = oneshot::channel();
        commands
            .send(StreamCommand::Input("term_c".into(), "a".into(), reply))
            .ok()
            .unwrap();
        let send = server.request().await;
        assert_eq!(
            send["params"],
            input_params(
                "term_c",
                "a",
                "cookapps-test",
                Some(OrcaViewport {
                    cols: 100,
                    rows: 30
                })
            )
        );
        server
            .send(json!({"id": send["id"], "ok": true, "result": {"send": {"accepted": true}}}))
            .await;
        assert!(answer.await.unwrap().is_ok());
        // One shown no more is let go and the other stays: its keys still go.
        commands
            .send(StreamCommand::TerminalClose("term_c".into()))
            .ok()
            .unwrap();
        let unsubscribe = server.request().await;
        assert_eq!(unsubscribe["method"], "terminal.unsubscribe");
        assert_eq!(
            unsubscribe["params"],
            unsubscribe_params("term_c", "cookapps-test", one["id"].as_str().unwrap())
        );
        let (reply, answer) = oneshot::channel();
        commands
            .send(StreamCommand::Input("term_s".into(), "b".into(), reply))
            .ok()
            .unwrap();
        let send = server.request().await;
        assert_eq!(send["method"], "terminal.send");
        server
            .send(json!({"id": send["id"], "ok": true, "result": {"send": {"accepted": true}}}))
            .await;
        assert!(answer.await.unwrap().is_ok());
        // Closing the stream lets the terminal still shown go.
        commands.send(StreamCommand::Close).ok().unwrap();
        let last = server.request().await;
        assert_eq!(last["method"], "terminal.unsubscribe");
        assert_eq!(
            last["params"],
            unsubscribe_params("term_s", "cookapps-test", two["id"].as_str().unwrap())
        );
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }
}
