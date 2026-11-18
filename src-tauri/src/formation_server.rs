//! The server mode of `tsunagiai-mcp` (A-37, #890): it runs on the PC of a saved environment and lets the app read the records of the formations there, and take closed children out of them, over a WebSocket of its own.
//! Orca's `files.*` do not reach the config folder, so the records are served here instead.
//!
//! The pieces, from the bottom up.
//! - The frame: XSalsa20-Poly1305 under a key for each direction, with a nonce that is the direction and a counter, so that a replayed, reordered or reused frame does not open.
//! - The handshake: each side sends an ephemeral public key, and the keys are derived from the DH of the ephemeral keys and the DH of the two pinned (static) keys together with the transcript, so that one who does not know its static key cannot derive them.
//! - The API: JSON inside a frame (`version`, `children.read`, `children.drop`, `pages.read`, `page.read`, `stop`).
//! - The server (`serve`, the daemon of `--serve`) and the client (`Client`), which the app uses.
//!
//! A key is in no error text and no `Debug` output (the types that hold one derive none).
//! The files are in `remote/` of the config folder: `server.key` (secret, 0600), `server.pub`, `client.pub` (the app's key, pinned by `--client-key`), `version` (written by whoever puts the program there; `0.0.0` when missing) and `pid`.

use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use crypto_secretbox::{
    aead::{generic_array::GenericArray, AeadInPlace, KeyInit},
    Key, Nonce, XSalsa20Poly1305,
};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Notify, Semaphore},
    time::{timeout, Instant},
};
use tokio_tungstenite::{
    accept_async_with_config, client_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    WebSocketStream,
};
use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};

use crate::{
    formation::{self, Child, CHILDREN_FILE},
    formation_page::{self, DecisionPage, PageRecord},
};

/// The one port the server listens on, at the address `--bind` names.
pub const PORT: u16 = 47823;
const PROTOCOL: &str = "tsunagiai-formation/v1";
const HANDSHAKE_VERSION: u8 = 1;
/// The most a frame carries before it is sealed (a request or a reply).
pub const MAX_PAYLOAD: usize = 1024 * 1024;
const TAG_LENGTH: usize = 16;
/// A sealed frame: the tag, then the payload.
const MAX_FRAME: usize = MAX_PAYLOAD + TAG_LENGTH;
/// From the open of the socket to the first sealed frame.
pub(crate) const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);
/// How long a connection may stay silent before the server closes it.
const IDLE_LIMIT: Duration = Duration::from_secs(60);
/// One call of the client.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Connections served at once; more are closed at once.
const MAX_CONNECTIONS: usize = 16;
/// The most formations one `children.read` names.
const MAX_FORMATIONS: usize = 200;

const REMOTE_DIR: &str = "remote";
const SERVER_KEY_FILE: &str = "server.key";
const SERVER_PUB_FILE: &str = "server.pub";
const CLIENT_PUB_FILE: &str = "client.pub";
const VERSION_FILE: &str = "version";
const PID_FILE: &str = "pid";
const DEFAULT_VERSION: &str = "0.0.0";

/// The line `--serve` prints when the server is up: this prefix, the server's public key (base64) and its version, each after a space. The app reads it from the screen of a terminal, so it stays short.
const READY_PREFIX: &str = "TSUNAGIAI-SERVE ";
/// The line `--serve` and `--serve-stop` print when they fail: this prefix and the reason, in one line.
const ERROR_PREFIX: &str = "TSUNAGIAI-SERVE-ERROR ";
/// The line `--serve-stop` prints when no server runs any more.
pub const STOPPED_LINE: &str = "TSUNAGIAI-SERVE-STOPPED";

fn equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0, |d, (l, r)| d | (l ^ r)) == 0
}

/// A 32-byte value in canonical padded base64 (`None` for anything else, so one value has one spelling).
pub(crate) fn canonical_32(value: &str) -> Option<[u8; 32]> {
    let bytes = STANDARD.decode(value).ok()?;
    if STANDARD.encode(&bytes) != value {
        return None;
    }
    bytes.try_into().ok()
}

pub(crate) fn random_32() -> Result<[u8; 32], String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "乱数を作れません".to_owned())?;
    Ok(bytes)
}

pub(crate) fn public_of(secret: &[u8; 32]) -> [u8; 32] {
    x25519(*secret, X25519_BASEPOINT_BYTES)
}

// ---- the frame ----

#[derive(Clone, Copy)]
enum Role {
    Client,
    Server,
}

/// The keyed connection: a key and a counter for each direction.
pub struct Channel {
    send_key: [u8; 32],
    receive_key: [u8; 32],
    send_direction: u8,
    receive_direction: u8,
    sent: u64,
    received: u64,
}

fn nonce_of(direction: u8, counter: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[0] = direction;
    nonce[16..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

impl Channel {
    /// The frame of `payload`: the tag, then the sealed payload. An error when the payload is over `MAX_PAYLOAD`, or the counter is spent.
    pub fn seal(&mut self, payload: &[u8]) -> Result<Vec<u8>, String> {
        if payload.len() > MAX_PAYLOAD {
            return Err("送る内容が大きすぎます".to_owned());
        }
        let next = self
            .sent
            .checked_add(1)
            .ok_or("この接続で送れる数を超えました")?;
        let nonce = nonce_of(self.send_direction, self.sent);
        let mut body = payload.to_vec();
        let tag = XSalsa20Poly1305::new(Key::from_slice(&self.send_key))
            .encrypt_in_place_detached(Nonce::from_slice(&nonce), b"", &mut body)
            .map_err(|_| "封をできません".to_owned())?;
        self.sent = next;
        Ok([tag.as_slice(), &body].concat())
    }

    /// The payload of `frame` when it is the next frame of the other side: `None` for a frame that is too big or too short, that does not open (another key, a change in it), or that is a replay or out of order. A frame that does not open leaves the counter where it was.
    pub fn open(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if frame.len() < TAG_LENGTH || frame.len() > MAX_FRAME {
            return None;
        }
        let next = self.received.checked_add(1)?;
        let nonce = nonce_of(self.receive_direction, self.received);
        let (tag, body) = frame.split_at(TAG_LENGTH);
        let mut plaintext = body.to_vec();
        XSalsa20Poly1305::new(Key::from_slice(&self.receive_key))
            .decrypt_in_place_detached(
                Nonce::from_slice(&nonce),
                b"",
                &mut plaintext,
                GenericArray::from_slice(tag),
            )
            .ok()?;
        self.received = next;
        Some(plaintext)
    }
}

// ---- the handshake ----

fn field(name: &str, value: &[u8]) -> Vec<u8> {
    let length = |bytes: &[u8]| u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes();
    [
        &length(name.as_bytes())[..],
        name.as_bytes(),
        &length(value),
        value,
    ]
    .concat()
}

/// The keys of a connection, from this side's ephemeral and static secrets and the other side's two public keys.
fn derive(
    role: Role,
    ephemeral_secret: &[u8; 32],
    static_secret: &[u8; 32],
    peer_ephemeral: &[u8; 32],
    peer_static: &[u8; 32],
) -> Result<Channel, String> {
    const REFUSED: &str = "鍵を導けません";
    let own_ephemeral = public_of(ephemeral_secret);
    let own_static = public_of(static_secret);
    let (client_ephemeral, server_ephemeral, client_static, server_static) = match role {
        Role::Client => (own_ephemeral, *peer_ephemeral, own_static, *peer_static),
        Role::Server => (*peer_ephemeral, own_ephemeral, *peer_static, own_static),
    };
    let ephemeral_shared = x25519(*ephemeral_secret, *peer_ephemeral);
    let static_shared = x25519(*static_secret, *peer_static);
    // A low-order public key gives an all-zero secret, which anyone can compute.
    if equal(&ephemeral_shared, &[0u8; 32]) || equal(&static_shared, &[0u8; 32]) {
        return Err(REFUSED.to_owned());
    }
    let transcript = [
        field("protocol", PROTOCOL.as_bytes()),
        field("version", &[HANDSHAKE_VERSION]),
        field("client-ephemeral", &client_ephemeral),
        field("server-ephemeral", &server_ephemeral),
        field("client-static", &client_static),
        field("server-static", &server_static),
    ]
    .concat();
    let salt = Sha256::digest(format!("{PROTOCOL}/salt").as_bytes());
    let info = [
        format!("{PROTOCOL}/keys\0").as_bytes(),
        &Sha256::digest(&transcript),
    ]
    .concat();
    let mut secret = [0u8; 64];
    secret[..32].copy_from_slice(&ephemeral_shared);
    secret[32..].copy_from_slice(&static_shared);
    let mut expanded = [0u8; 64];
    Hkdf::<Sha256>::new(Some(&salt), &secret)
        .expand(&info, &mut expanded)
        .map_err(|_| REFUSED.to_owned())?;
    let client_to_server: [u8; 32] = expanded[..32].try_into().unwrap();
    let server_to_client: [u8; 32] = expanded[32..].try_into().unwrap();
    let (send_key, receive_key, send_direction, receive_direction) = match role {
        Role::Client => (client_to_server, server_to_client, 0, 1),
        Role::Server => (server_to_client, client_to_server, 1, 0),
    };
    Ok(Channel {
        send_key,
        receive_key,
        send_direction,
        receive_direction,
        sent: 0,
        received: 0,
    })
}

/// The one message of each side of the handshake: the version and the ephemeral public key.
fn handshake_message(ephemeral_public: &[u8; 32]) -> Vec<u8> {
    [&[HANDSHAKE_VERSION][..], ephemeral_public].concat()
}

fn ephemeral_of(message: &[u8]) -> Result<[u8; 32], String> {
    const REFUSED: &str = "接続の始まりが想定外です";
    match message.split_first() {
        Some((&HANDSHAKE_VERSION, key)) => key.try_into().map_err(|_| REFUSED.to_owned()),
        _ => Err(REFUSED.to_owned()),
    }
}

/// The client's half before the ready: its ephemeral key, its static secret and the server key it is pinned to.
pub struct ClientHandshake {
    ephemeral_secret: [u8; 32],
    static_secret: [u8; 32],
    server_public: [u8; 32],
}

impl ClientHandshake {
    pub fn new(static_secret: [u8; 32], server_public: [u8; 32]) -> Result<Self, String> {
        Ok(Self::with_ephemeral(
            random_32()?,
            static_secret,
            server_public,
        ))
    }

    fn with_ephemeral(
        ephemeral_secret: [u8; 32],
        static_secret: [u8; 32],
        server_public: [u8; 32],
    ) -> Self {
        Self {
            ephemeral_secret,
            static_secret,
            server_public,
        }
    }

    /// The first message to send.
    pub fn hello(&self) -> Vec<u8> {
        handshake_message(&public_of(&self.ephemeral_secret))
    }

    /// The channel, from the server's message.
    pub fn accept_ready(&self, ready: &[u8]) -> Result<Channel, String> {
        derive(
            Role::Client,
            &self.ephemeral_secret,
            &self.static_secret,
            &ephemeral_of(ready)?,
            &self.server_public,
        )
    }
}

/// The server's answer to a hello, and its channel. `client_public` is the key the app pinned: one who does not hold its secret derives other keys, and its first frame does not open.
fn accept_hello(
    static_secret: &[u8; 32],
    client_public: &[u8; 32],
    hello: &[u8],
) -> Result<(Vec<u8>, Channel), String> {
    let ephemeral_secret = random_32()?;
    answer_hello(&ephemeral_secret, static_secret, client_public, hello)
}

fn answer_hello(
    ephemeral_secret: &[u8; 32],
    static_secret: &[u8; 32],
    client_public: &[u8; 32],
    hello: &[u8],
) -> Result<(Vec<u8>, Channel), String> {
    let channel = derive(
        Role::Server,
        ephemeral_secret,
        static_secret,
        &ephemeral_of(hello)?,
        client_public,
    )?;
    Ok((handshake_message(&public_of(ephemeral_secret)), channel))
}

// ---- the API ----

#[derive(Deserialize)]
struct Request {
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
struct ReadParams {
    formations: Vec<String>,
}

#[derive(Deserialize)]
struct PagesParams {
    formation: String,
}

#[derive(Deserialize)]
struct PageParams {
    formation: String,
    child: String,
}

#[derive(Deserialize)]
struct DropParams {
    formation: String,
    names: Vec<String>,
}

/// The record of one formation as `children.read` answers it: its children, `None` when it has no `children.json` (the formation is not there, or has had no child), or why it could not be read.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct RemoteChildren {
    pub formation: String,
    pub children: Option<Vec<Child>>,
    pub error: Option<String>,
}

/// The answer to one request, and whether the server stops after sending it.
struct Reply {
    body: Value,
    stop: bool,
}

impl Reply {
    fn ok(result: Value) -> Self {
        Self {
            body: json!({"ok": true, "result": result}),
            stop: false,
        }
    }

    fn error(message: &str) -> Self {
        Self {
            body: json!({"ok": false, "error": message}),
            stop: false,
        }
    }
}

fn read_one(config: &Path, formation: &str) -> RemoteChildren {
    let found = formation::dir(config, formation)
        .join(CHILDREN_FILE)
        .is_file();
    let read = if found {
        formation::read_record(config, formation).map(Some)
    } else {
        Ok(None)
    };
    match read {
        Ok(children) => RemoteChildren {
            formation: formation.to_owned(),
            children,
            error: None,
        },
        Err(error) => RemoteChildren {
            formation: formation.to_owned(),
            children: None,
            error: Some(error),
        },
    }
}

/// Takes `names` out of the record of `formation`: it is read again and only those names go, so that a child added meanwhile stays (as `formation::drop_from_pc` asks it to). A record that holds none of them, or that is not there, is left alone. The number taken out.
fn drop_children(config: &Path, formation: &str, names: &[String]) -> Result<usize, String> {
    formation::check_name(formation)?;
    for name in names {
        formation::check_name(name)?;
    }
    if !formation::dir(config, formation)
        .join(CHILDREN_FILE)
        .is_file()
    {
        return Ok(0);
    }
    let current = formation::read_record(config, formation)?;
    if !current.iter().any(|c| names.contains(&c.name)) {
        return Ok(0);
    }
    let mut removed = 0;
    formation::update(config, formation, |children| {
        let before = children.len();
        let kept = formation::without_names(children, names);
        removed = before - kept.len();
        Ok(kept)
    })?;
    Ok(removed)
}

fn dispatch(config: &Path, version: &str, request: &[u8]) -> Reply {
    let Ok(request) = serde_json::from_slice::<Request>(request) else {
        return Reply::error("要求の形式が正しくありません");
    };
    let bad_params = || Reply::error("引数が正しくありません");
    match request.method.as_str() {
        "version" => Reply::ok(json!({"version": version})),
        "children.read" => {
            let Ok(params) = serde_json::from_value::<ReadParams>(request.params) else {
                return bad_params();
            };
            if params.formations.len() > MAX_FORMATIONS {
                return Reply::error("一度に読めるフォーメーションの数を超えました");
            }
            if let Some(Err(e)) = params
                .formations
                .iter()
                .map(|name| formation::check_name(name))
                .find(Result::is_err)
            {
                return Reply::error(&e);
            }
            let entries: Vec<RemoteChildren> = params
                .formations
                .iter()
                .map(|name| read_one(config, name))
                .collect();
            Reply::ok(json!({"formations": entries}))
        }
        "children.drop" => {
            let Ok(params) = serde_json::from_value::<DropParams>(request.params) else {
                return bad_params();
            };
            match drop_children(config, &params.formation, &params.names) {
                Ok(removed) => Reply::ok(json!({"removed": removed})),
                Err(e) => Reply::error(&e),
            }
        }
        "pages.read" => {
            let Ok(params) = serde_json::from_value::<PagesParams>(request.params) else {
                return bad_params();
            };
            if let Err(e) = formation::check_name(&params.formation) {
                return Reply::error(&e);
            }
            Reply::ok(json!({"pages": formation_page::read_pages(config, &params.formation)}))
        }
        "page.read" => {
            let Ok(params) = serde_json::from_value::<PageParams>(request.params) else {
                return bad_params();
            };
            match formation_page::read_here(config, &params.formation, &params.child) {
                Ok(page) => Reply::ok(json!({"page": page})),
                Err(e) => Reply::error(&e),
            }
        }
        "stop" => Reply {
            stop: true,
            ..Reply::ok(json!({"stopping": true}))
        },
        _ => Reply::error("その要求はありません"),
    }
}

// ---- the server ----

/// What a server needs to serve: the config folder the records are in, its static secret, the app's pinned public key and the version it answers.
pub struct Setup {
    pub config: PathBuf,
    pub secret: [u8; 32],
    pub client_public: [u8; 32],
    pub version: String,
}

fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME))
}

/// The next binary message; `None` when the peer closed, sent text, or broke the protocol (a message over the size limit included).
async fn next_binary<S>(socket: &mut WebSocketStream<S>) -> Option<Vec<u8>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match socket.next().await? {
            Ok(Message::Binary(bytes)) => return Some(bytes.to_vec()),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            _ => return None,
        }
    }
}

/// The sealed reply: the answer itself, or an error when it is too big to send.
fn sealed_reply(channel: &mut Channel, body: &Value) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(body).ok()?;
    if bytes.len() > MAX_PAYLOAD {
        let error = Reply::error("答えが大きすぎます").body;
        return channel.seal(&serde_json::to_vec(&error).ok()?).ok();
    }
    channel.seal(&bytes).ok()
}

/// One connection, to its end. Anything that is not right (a frame that does not open included) ends it with no answer.
async fn handle<S>(stream: S, setup: &Setup, stop: &Notify) -> Option<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    // From the accept to the first sealed frame, one limit for the whole: a client that is slow in each step is cut at `HANDSHAKE_DEADLINE`, not at three times that.
    let begun = Instant::now();
    let mut socket = timeout(
        HANDSHAKE_DEADLINE,
        accept_async_with_config(stream, Some(socket_config())),
    )
    .await
    .ok()?
    .ok()?;
    let hello = timeout(
        HANDSHAKE_DEADLINE.saturating_sub(begun.elapsed()),
        next_binary(&mut socket),
    )
    .await
    .ok()??;
    let (ready, mut channel) = accept_hello(&setup.secret, &setup.client_public, &hello).ok()?;
    socket.send(Message::Binary(ready.into())).await.ok()?;
    let mut limit = HANDSHAKE_DEADLINE.saturating_sub(begun.elapsed());
    loop {
        let frame = timeout(limit, next_binary(&mut socket)).await.ok()??;
        limit = IDLE_LIMIT;
        let request = channel.open(&frame)?;
        // `page.read` runs `orca` and `git`, so a request is served on a thread that may block.
        let (config, version) = (setup.config.clone(), setup.version.clone());
        let reply = tokio::task::spawn_blocking(move || dispatch(&config, &version, &request))
            .await
            .ok()?;
        let sealed = sealed_reply(&mut channel, &reply.body)?;
        socket.send(Message::Binary(sealed.into())).await.ok()?;
        if reply.stop {
            stop.notify_one();
            return Some(());
        }
    }
}

/// Serves `listener` until a client sends `stop`.
pub async fn serve(listener: TcpListener, setup: Setup) {
    let setup = Arc::new(setup);
    let stop = Arc::new(Notify::new());
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        tokio::select! {
            () = stop.notified() => return,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                };
                let Ok(slot) = slots.clone().try_acquire_owned() else {
                    continue;
                };
                let (setup, stop) = (setup.clone(), stop.clone());
                tokio::spawn(async move {
                    handle(stream, &setup, &stop).await;
                    drop(slot);
                });
            }
        }
    }
}

// ---- the client ----

/// A connection to a server, for the app. Each call is one request and one answer.
pub struct Client {
    socket: WebSocketStream<TcpStream>,
    channel: Channel,
}

impl Client {
    /// Connects to `host:port` and does the handshake. The server is not known to hold the pinned key until a call is answered: with another key, the answer does not open.
    pub async fn connect(
        host: &str,
        port: u16,
        client_secret: [u8; 32],
        server_public: [u8; 32],
    ) -> Result<Self, String> {
        Self::connect_within(host, port, client_secret, server_public, HANDSHAKE_DEADLINE).await
    }

    /// `connect` with its own limit for the connection and the handshake together, for a caller that has less time than `HANDSHAKE_DEADLINE`.
    pub async fn connect_within(
        host: &str,
        port: u16,
        client_secret: [u8; 32],
        server_public: [u8; 32],
        deadline: Duration,
    ) -> Result<Self, String> {
        let handshake = ClientHandshake::new(client_secret, server_public)?;
        timeout(deadline, async {
            let stream = TcpStream::connect((host, port))
                .await
                .map_err(|e| format!("{host}:{port} につなげません: {e}"))?;
            let url = if host.contains(':') {
                format!("ws://[{host}]:{port}/")
            } else {
                format!("ws://{host}:{port}/")
            };
            let (mut socket, _) = client_async_with_config(url, stream, Some(socket_config()))
                .await
                .map_err(|e| format!("{host}:{port} と WebSocket を始められません: {e}"))?;
            socket
                .send(Message::Binary(handshake.hello().into()))
                .await
                .map_err(|e| e.to_string())?;
            let ready = next_binary(&mut socket)
                .await
                .ok_or("サーバーが応答しませんでした")?;
            let channel = handshake.accept_ready(&ready)?;
            Ok(Self { socket, channel })
        })
        .await
        .unwrap_or_else(|_| Err("時間内に接続できませんでした".to_owned()))
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let request = serde_json::to_vec(&json!({"method": method, "params": params}))
            .map_err(|e| e.to_string())?;
        let sealed = self.channel.seal(&request)?;
        timeout(CALL_TIMEOUT, async {
            self.socket
                .send(Message::Binary(sealed.into()))
                .await
                .map_err(|e| e.to_string())?;
            let frame = next_binary(&mut self.socket)
                .await
                .ok_or("サーバーが応答しませんでした")?;
            let plain = self
                .channel
                .open(&frame)
                .ok_or("サーバーの答えを開けませんでした")?;
            let reply: Value = serde_json::from_slice(&plain)
                .map_err(|_| "サーバーの答えの形式が正しくありません")?;
            if reply["ok"] == true {
                Ok(reply["result"].clone())
            } else {
                Err(reply["error"]
                    .as_str()
                    .unwrap_or("サーバーが断りました")
                    .to_owned())
            }
        })
        .await
        .unwrap_or_else(|_| Err("時間内に答えませんでした".to_owned()))
    }

    pub async fn version(&mut self) -> Result<String, String> {
        let result = self.call("version", Value::Null).await?;
        result["version"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "サーバーの答えの形式が正しくありません".to_owned())
    }

    /// The records of `formations`, in the order asked.
    pub async fn children_read(
        &mut self,
        formations: &[String],
    ) -> Result<Vec<RemoteChildren>, String> {
        let result = self
            .call("children.read", json!({"formations": formations}))
            .await?;
        serde_json::from_value(result["formations"].clone())
            .map_err(|_| "サーバーの答えの形式が正しくありません".to_owned())
    }

    /// Takes `names` out of the record of `formation`; the number taken out.
    pub async fn children_drop(
        &mut self,
        formation: &str,
        names: &[String],
    ) -> Result<usize, String> {
        let result = self
            .call(
                "children.drop",
                json!({"formation": formation, "names": names}),
            )
            .await?;
        result["removed"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| "サーバーの答えの形式が正しくありません".to_owned())
    }

    /// The decision pages that the PC records for `formation` (A-41, `pages.json`).
    pub async fn pages_read(&mut self, formation: &str) -> Result<Vec<PageRecord>, String> {
        let result = self
            .call("pages.read", json!({"formation": formation}))
            .await?;
        serde_json::from_value(result["pages"].clone())
            .map_err(|_| "サーバーの答えの形式が正しくありません".to_owned())
    }

    /// The page that waits on `child`, checked and with its evidence resolved on that PC (A-41). A refusal is the violations, one on each line.
    pub async fn page_read(
        &mut self,
        formation: &str,
        child: &str,
    ) -> Result<DecisionPage, String> {
        let result = self
            .call("page.read", json!({"formation": formation, "child": child}))
            .await?;
        serde_json::from_value(result["page"].clone())
            .map_err(|_| "サーバーの答えの形式が正しくありません".to_owned())
    }

    /// Stops the server.
    pub async fn stop(&mut self) -> Result<(), String> {
        self.call("stop", Value::Null).await.map(|_| ())
    }
}

// ---- the files of remote/ ----

pub fn remote_dir(config: &Path) -> PathBuf {
    config.join(REMOTE_DIR)
}

fn private_dir(dir: &Path) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("{} を作れません: {e}", dir.display());
    std::fs::create_dir_all(dir).map_err(failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(failed)?;
    }
    Ok(())
}

/// Writes `text` to `file` in `dir` through a temporary file and a rename, readable by this user only.
fn write_private(dir: &Path, file: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    let (path, tmp) = (dir.join(file), dir.join(format!("{file}.tmp")));
    let write = || -> std::io::Result<()> {
        let _ = std::fs::remove_file(&tmp);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&tmp)?;
        handle.write_all(text.as_bytes())?;
        handle.sync_all()?;
        std::fs::rename(&tmp, &path)
    };
    write().map_err(|e| format!("{} を書けません: {e}", path.display()))
}

fn read_key(dir: &Path, file: &str) -> Result<Option<[u8; 32]>, String> {
    match std::fs::read_to_string(dir.join(file)) {
        Ok(text) => canonical_32(text.trim())
            .map(Some)
            .ok_or_else(|| format!("{file} の形式が正しくありません")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{file} を読めません: {e}")),
    }
}

/// The server's key pair, made and kept when it is not there yet.
fn load_or_create_keys(dir: &Path) -> Result<([u8; 32], [u8; 32]), String> {
    let secret = match read_key(dir, SERVER_KEY_FILE)? {
        Some(secret) => secret,
        None => {
            let secret = random_32()?;
            write_private(dir, SERVER_KEY_FILE, &STANDARD.encode(secret))?;
            secret
        }
    };
    let public = public_of(&secret);
    write_private(dir, SERVER_PUB_FILE, &STANDARD.encode(public))?;
    Ok((secret, public))
}

/// Pins the app's public key when `--client-key` gives one; whether it changed what was pinned. Without one, a key pinned before stands, and none pinned is an error.
fn pin_client_key(dir: &Path, given: Option<&str>) -> Result<bool, String> {
    let pinned = read_key(dir, CLIENT_PUB_FILE)?;
    let Some(given) = given else {
        return pinned
            .map(|_| false)
            .ok_or_else(|| "アプリの公開鍵が固定されていません".to_owned());
    };
    let key = canonical_32(given).ok_or("アプリの公開鍵の形式が正しくありません")?;
    if pinned.is_some_and(|p| equal(&p, &key)) {
        return Ok(false);
    }
    write_private(dir, CLIENT_PUB_FILE, &STANDARD.encode(key))?;
    Ok(true)
}

/// The text of the `version` file, or `0.0.0` when it is missing or is not a single word.
fn read_version(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(VERSION_FILE))
        .ok()
        .map(|text| text.trim().to_owned())
        .filter(|v| !v.is_empty() && v.len() <= 32 && v.chars().all(|c| c.is_ascii_graphic()))
        .unwrap_or_else(|| DEFAULT_VERSION.to_owned())
}

pub(crate) fn bind_address(bind: &str) -> Result<IpAddr, String> {
    bind.parse()
        .map_err(|_| "--bind には IP アドレスを指定してください".to_owned())
}

/// What the `pid` file holds: the process, the version it serves and the address it listens on.
#[derive(Debug, PartialEq)]
struct Running {
    pid: i32,
    version: String,
    bind: String,
}

fn pid_line(pid: u32, version: &str, bind: &str) -> String {
    format!("{pid} {version} {bind}")
}

fn parse_pid_line(text: &str) -> Option<Running> {
    let mut words = text.split_whitespace();
    let pid = words.next()?.parse::<i32>().ok().filter(|p| *p > 1)?;
    let (version, bind) = (words.next()?, words.next()?);
    words.next().is_none().then(|| Running {
        pid,
        version: version.to_owned(),
        bind: bind.to_owned(),
    })
}

#[derive(Debug, PartialEq)]
enum Plan {
    /// The server that runs is the one asked for.
    Keep,
    /// Another version, address or key: stop it and start again.
    Restart,
    Start,
}

fn plan(running: Option<&Running>, version: &str, bind: &str, key_changed: bool) -> Plan {
    match running {
        None => Plan::Start,
        Some(r) if r.version == version && r.bind == bind && !key_changed => Plan::Keep,
        Some(_) => Plan::Restart,
    }
}

// ---- the lines `--serve` prints ----

/// The line of a started server.
pub fn ready_line(public_key_b64: &str, version: &str) -> String {
    format!("{READY_PREFIX}{public_key_b64} {version}")
}

/// The public key and the version of a line `ready_line` made; `None` for any other line (an error line included).
pub fn parse_ready_line(line: &str) -> Option<(String, String)> {
    let mut words = line.trim().strip_prefix(READY_PREFIX)?.split(' ');
    let (key, version) = (words.next()?, words.next()?);
    (words.next().is_none() && canonical_32(key).is_some() && !version.is_empty())
        .then(|| (key.to_owned(), version.to_owned()))
}

/// The line of a failure, with the reason in one line.
pub fn error_line(reason: &str) -> String {
    let one_line: Vec<&str> = reason.split_whitespace().collect();
    format!("{ERROR_PREFIX}{}", one_line.join(" "))
}

/// The reason of a line `error_line` made; `None` for any other line.
pub fn parse_error_line(line: &str) -> Option<String> {
    line.trim().strip_prefix(ERROR_PREFIX).map(str::to_owned)
}

// ---- the processes ----

#[cfg(unix)]
mod process {
    use std::{path::Path, time::Duration};

    pub fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only asks whether the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Whether `pid` is a `tsunagiai-mcp` that runs the server, so that a pid the system gave to another program is left alone.
    pub fn is_server(pid: i32) -> bool {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "args="])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .is_some_and(|o| {
                let args = String::from_utf8_lossy(&o.stdout);
                args.contains("tsunagiai-mcp") && args.contains("--serve-run")
            })
    }

    fn wait_gone(pid: i32, tries: u32) -> bool {
        for _ in 0..tries {
            if !alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        !alive(pid)
    }

    /// Ends the server: SIGTERM, and SIGKILL when it does not go.
    pub fn terminate(pid: i32) -> bool {
        // SAFETY: a signal to a process that `is_server` named.
        unsafe { libc::kill(pid, libc::SIGTERM) };
        if wait_gone(pid, 60) {
            return true;
        }
        // SAFETY: as above.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        wait_gone(pid, 60)
    }

    /// Starts `exe --serve-run --bind {bind}` as a daemon: a session of its own, and no standard input or output.
    pub fn spawn(exe: &Path, bind: &str) -> std::io::Result<std::process::Child> {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new(exe);
        command
            .args(["--serve-run", "--bind", bind])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // SAFETY: setsid is async-signal-safe, and nothing else runs between fork and exec.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        command.spawn()
    }
}

#[cfg(not(unix))]
mod process {
    use std::path::Path;

    pub fn alive(_: i32) -> bool {
        false
    }

    pub fn is_server(_: i32) -> bool {
        false
    }

    pub fn terminate(_: i32) -> bool {
        false
    }

    pub fn spawn(_: &Path, _: &str) -> std::io::Result<std::process::Child> {
        Err(std::io::Error::other("unix のみ対応しています"))
    }
}

/// The server that the `pid` file names, when it runs.
fn running_server(dir: &Path) -> Option<Running> {
    let running = parse_pid_line(&std::fs::read_to_string(dir.join(PID_FILE)).ok()?)?;
    (process::alive(running.pid) && process::is_server(running.pid)).then_some(running)
}

fn stop_running(dir: &Path, running: &Running) -> Result<(), String> {
    if !process::terminate(running.pid) {
        return Err("動いているサーバーを止められません".to_owned());
    }
    let _ = std::fs::remove_file(dir.join(PID_FILE));
    Ok(())
}

/// Starts the daemon, and returns when it listens (it writes its `pid` file once it has bound the port).
fn start_daemon(dir: &Path, exe: &Path, bind: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(dir.join(PID_FILE));
    let mut child =
        process::spawn(exe, bind).map_err(|e| format!("サーバーを起動できません: {e}"))?;
    let pid = i32::try_from(child.id()).unwrap_or(0);
    let started = |text: String| parse_pid_line(&text).is_some_and(|r| r.pid == pid);
    for _ in 0..100 {
        if std::fs::read_to_string(dir.join(PID_FILE)).is_ok_and(started) {
            return Ok(());
        }
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "サーバーが待ち受けを始められませんでした（{bind}:{PORT} が使われていないか確かめてください）"
    ))
}

/// `--serve`: makes the keys, pins the app's key, starts the daemon unless one of this version already runs, and gives the line to print.
pub fn serve_command(
    config: &Path,
    exe: &Path,
    bind: &str,
    client_key: Option<&str>,
) -> Result<String, String> {
    bind_address(bind)?;
    let dir = remote_dir(config);
    private_dir(&dir)?;
    let (_, public) = load_or_create_keys(&dir)?;
    let key_changed = pin_client_key(&dir, client_key)?;
    let version = read_version(&dir);
    let running = running_server(&dir);
    match plan(running.as_ref(), &version, bind, key_changed) {
        Plan::Keep => {}
        Plan::Restart => {
            if let Some(running) = &running {
                stop_running(&dir, running)?;
            }
            start_daemon(&dir, exe, bind)?;
        }
        Plan::Start => start_daemon(&dir, exe, bind)?,
    }
    Ok(ready_line(&STANDARD.encode(public), &version))
}

/// `--serve-stop`: ends the server that runs, if one does.
pub fn serve_stop(config: &Path) -> Result<(), String> {
    let dir = remote_dir(config);
    if let Some(running) = running_server(&dir) {
        stop_running(&dir, &running)?;
    }
    Ok(())
}

/// `--serve-run`, the daemon itself: binds, writes the `pid` file and serves until a client sends `stop`.
pub async fn run_daemon(config: &Path, bind: &str) -> Result<(), String> {
    let address = bind_address(bind)?;
    let dir = remote_dir(config);
    let secret = read_key(&dir, SERVER_KEY_FILE)?.ok_or("サーバーの鍵がありません")?;
    let client_public = read_key(&dir, CLIENT_PUB_FILE)?
        .ok_or("アプリの公開鍵が固定されていないので、待ち受けません")?;
    let version = read_version(&dir);
    let listener = TcpListener::bind((address, PORT))
        .await
        .map_err(|e| format!("{bind}:{PORT} で待ち受けられません: {e}"))?;
    let pid = std::process::id();
    write_private(&dir, PID_FILE, &pid_line(pid, &version, bind))?;
    serve(
        listener,
        Setup {
            config: config.to_owned(),
            secret,
            client_public,
            version,
        },
    )
    .await;
    // The file of a server that was replaced is another process's: leave it.
    if std::fs::read_to_string(dir.join(PID_FILE))
        .ok()
        .and_then(|text| parse_pid_line(&text))
        .is_some_and(|r| r.pid as u32 == pid)
    {
        let _ = std::fs::remove_file(dir.join(PID_FILE));
    }
    Ok(())
}

// ---- the arguments of tsunagiai-mcp ----

#[derive(Debug, PartialEq)]
pub enum Mode {
    /// `--serve --bind {host} [--client-key {key}]`
    Serve {
        bind: String,
        client_key: Option<String>,
    },
    /// `--serve-run --bind {host}`: what `--serve` starts as the daemon.
    Run { bind: String },
    /// `--serve-stop`
    Stop,
}

/// The server mode that `args` ask for, or none when the first argument is no `--serve*` flag: a `--serve-stop` that is the value of another flag (`--formation-start x --project --serve-stop`) is no mode. A flag with no value, or `--serve` with no `--bind`, is an error.
pub fn mode_of(args: impl IntoIterator<Item = String>) -> Result<Option<Mode>, String> {
    let args: Vec<String> = args.into_iter().collect();
    let has = |flag: &str| args.first().is_some_and(|a| a == flag);
    let value = |flag: &str| -> Result<Option<String>, String> {
        match args.iter().position(|a| a == flag) {
            None => Ok(None),
            Some(at) => args
                .get(at + 1)
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("{flag} に値がありません")),
        }
    };
    let bind = || value("--bind")?.ok_or_else(|| "--bind がありません".to_owned());
    if has("--serve-stop") {
        Ok(Some(Mode::Stop))
    } else if has("--serve-run") {
        Ok(Some(Mode::Run { bind: bind()? }))
    } else if has("--serve") {
        Ok(Some(Mode::Serve {
            bind: bind()?,
            client_key: value("--client-key")?,
        }))
    } else {
        Ok(None)
    }
}

/// Does what `mode` asks, prints its line and gives the exit code. A line is on standard output, which the app reads from a terminal; the daemon prints nothing (its standard output is gone).
pub fn run(mode: Mode) -> i32 {
    let finish = |done: Result<Option<String>, String>| match done {
        Ok(line) => {
            if let Some(line) = line {
                println!("{line}");
            }
            0
        }
        Err(reason) => {
            println!("{}", error_line(&reason));
            1
        }
    };
    let config = match crate::identity::config_dir() {
        Ok(config) => config,
        Err(e) => return finish(Err(e)),
    };
    match mode {
        Mode::Serve { bind, client_key } => finish(
            std::env::current_exe()
                .map_err(|e| format!("自分の場所を知れません: {e}"))
                .and_then(|exe| serve_command(&config, &exe, &bind, client_key.as_deref()))
                .map(Some),
        ),
        Mode::Stop => finish(serve_stop(&config).map(|()| Some(STOPPED_LINE.to_owned()))),
        Mode::Run { bind } => {
            let done = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())
                .and_then(|runtime| runtime.block_on(run_daemon(&config, &bind)));
            i32::from(done.is_err())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-formation-server-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn pair(seed: u8) -> ([u8; 32], [u8; 32]) {
        let secret = [seed; 32];
        (secret, public_of(&secret))
    }

    /// Both ends of a handshake with the keys each side holds: the client's static secret and the server key it pins, the server's static secret and the client key it pins.
    fn channels(
        client_secret: [u8; 32],
        pinned_server: [u8; 32],
        server_secret: [u8; 32],
        pinned_client: [u8; 32],
    ) -> (Channel, Channel) {
        let client = ClientHandshake::with_ephemeral([7; 32], client_secret, pinned_server);
        let (ready, server) =
            answer_hello(&[9; 32], &server_secret, &pinned_client, &client.hello()).unwrap();
        (client.accept_ready(&ready).unwrap(), server)
    }

    fn matched() -> (Channel, Channel) {
        let (client_secret, client_public) = pair(1);
        let (server_secret, server_public) = pair(2);
        channels(client_secret, server_public, server_secret, client_public)
    }

    fn child(name: &str) -> Child {
        Child {
            name: name.to_owned(),
            repo: "repo".to_owned(),
            environment: "pc".to_owned(),
            agent: formation::FormationAgent::Claude,
            launch: None,
        }
    }

    fn write_record(config: &Path, formation: &str, names: &[&str]) {
        let dir = formation::dir(config, formation);
        std::fs::create_dir_all(&dir).unwrap();
        let children: Vec<Child> = names.iter().map(|n| child(n)).collect();
        std::fs::write(
            dir.join(CHILDREN_FILE),
            serde_json::to_string(&json!({"children": children})).unwrap(),
        )
        .unwrap();
    }

    fn names_of(config: &Path, formation: &str) -> Vec<String> {
        formation::read_record(config, formation)
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect()
    }

    // ---- the frame ----

    #[test]
    fn frames_go_both_ways_in_order() {
        let (mut client, mut server) = matched();
        for i in 0..3u8 {
            let frame = client.seal(&[i; 5]).unwrap();
            assert_eq!(server.open(&frame), Some(vec![i; 5]));
            let frame = server.seal(&[i; 7]).unwrap();
            assert_eq!(client.open(&frame), Some(vec![i; 7]));
        }
    }

    #[test]
    fn a_frame_is_not_opened_twice_nor_out_of_order() {
        let (mut client, mut server) = matched();
        let first = client.seal(b"one").unwrap();
        let second = client.seal(b"two").unwrap();
        assert_eq!(server.open(&second), None, "out of order");
        assert_eq!(server.open(&first), Some(b"one".to_vec()));
        assert_eq!(server.open(&first), None, "replay");
        assert_eq!(server.open(&second), Some(b"two".to_vec()));
    }

    #[test]
    fn a_frame_sent_back_to_its_sender_is_not_opened() {
        let (mut client, mut server) = matched();
        let frame = client.seal(b"one").unwrap();
        assert_eq!(client.open(&frame), None);
        assert_eq!(server.open(&frame), Some(b"one".to_vec()));
    }

    #[test]
    fn a_changed_frame_is_not_opened_and_the_counter_stays() {
        let (mut client, mut server) = matched();
        let frame = client.seal(b"payload").unwrap();
        for at in [0, TAG_LENGTH, frame.len() - 1] {
            let mut bad = frame.clone();
            bad[at] ^= 1;
            assert_eq!(server.open(&bad), None, "byte {at}");
        }
        assert_eq!(server.open(&frame[..frame.len() - 1]), None);
        assert_eq!(server.open(&[]), None);
        assert_eq!(server.open(&frame), Some(b"payload".to_vec()));
    }

    #[test]
    fn a_frame_over_the_limit_is_refused_both_ways() {
        let (mut client, mut server) = matched();
        assert!(client.seal(&vec![0; MAX_PAYLOAD + 1]).is_err());
        let frame = client.seal(&vec![1; MAX_PAYLOAD]).unwrap();
        assert_eq!(frame.len(), MAX_FRAME);
        assert_eq!(server.open(&frame).map(|p| p.len()), Some(MAX_PAYLOAD));
        assert_eq!(server.open(&vec![0; MAX_FRAME + 1]), None);
    }

    #[test]
    fn the_counter_is_spent_after_u64_max_frames() {
        let (mut client, _) = matched();
        client.sent = u64::MAX;
        assert!(client.seal(b"x").is_err());
    }

    // ---- the handshake ----

    #[test]
    fn a_client_with_another_static_key_derives_other_keys() {
        let (_, client_public) = pair(1);
        let (server_secret, server_public) = pair(2);
        let (mut stranger, mut server) =
            channels([3; 32], server_public, server_secret, client_public);
        let frame = stranger.seal(b"hello").unwrap();
        assert_eq!(server.open(&frame), None);
    }

    #[test]
    fn a_server_that_does_not_hold_the_pinned_key_cannot_answer() {
        let (client_secret, client_public) = pair(1);
        let (_, server_public) = pair(2);
        // The impostor knows the client's public key but not the secret of the key the client pinned.
        let (mut client, mut impostor) =
            channels(client_secret, server_public, [4; 32], client_public);
        let frame = impostor.seal(b"answer").unwrap();
        assert_eq!(client.open(&frame), None);
        let frame = client.seal(b"ask").unwrap();
        assert_eq!(impostor.open(&frame), None);
    }

    #[test]
    fn another_ephemeral_key_makes_other_keys() {
        let (client_secret, client_public) = pair(1);
        let (server_secret, server_public) = pair(2);
        let client = ClientHandshake::with_ephemeral([7; 32], client_secret, server_public);
        let (ready, _) =
            answer_hello(&[9; 32], &server_secret, &client_public, &client.hello()).unwrap();
        let (_, mut other_server) =
            answer_hello(&[10; 32], &server_secret, &client_public, &client.hello()).unwrap();
        let mut channel = client.accept_ready(&ready).unwrap();
        let frame = channel.seal(b"x").unwrap();
        assert_eq!(other_server.open(&frame), None);
    }

    #[test]
    fn a_handshake_message_of_another_shape_is_refused() {
        let (secret, public) = pair(1);
        let mut hello = handshake_message(&public_of(&[7; 32]));
        assert!(answer_hello(&[9; 32], &secret, &public, &hello).is_ok());
        hello[0] = 2;
        assert!(answer_hello(&[9; 32], &secret, &public, &hello).is_err());
        assert!(answer_hello(&[9; 32], &secret, &public, &[]).is_err());
        assert!(answer_hello(&[9; 32], &secret, &public, &hello[..32]).is_err());
        let client = ClientHandshake::with_ephemeral([7; 32], secret, public);
        assert!(client.accept_ready(&[HANDSHAKE_VERSION; 10]).is_err());
    }

    #[test]
    fn a_low_order_public_key_is_refused() {
        let (secret, public) = pair(1);
        let zero_ephemeral = handshake_message(&[0; 32]);
        assert!(answer_hello(&[9; 32], &secret, &public, &zero_ephemeral).is_err());
        let hello = handshake_message(&public_of(&[7; 32]));
        assert!(answer_hello(&[9; 32], &secret, &[0; 32], &hello).is_err());
    }

    // ---- the lines ----

    #[test]
    fn the_ready_line_goes_round() {
        let key = STANDARD.encode(public_of(&[5; 32]));
        let line = ready_line(&key, "0.82.5");
        assert!(line.len() < 80, "it must fit a line of a terminal");
        assert_eq!(
            parse_ready_line(&line),
            Some((key.clone(), "0.82.5".to_owned()))
        );
        assert_eq!(
            parse_ready_line(&format!("  {line}\r\n")),
            Some((key, "0.82.5".to_owned()))
        );
    }

    #[test]
    fn a_line_that_is_not_the_ready_line_is_not_read_as_one() {
        let key = STANDARD.encode(public_of(&[5; 32]));
        assert_eq!(parse_ready_line(&error_line("だめです")), None);
        assert_eq!(
            parse_ready_line(&format!("TSUNAGIAI-SERVE-ERROR {key} 1")),
            None
        );
        assert_eq!(
            parse_ready_line(&format!("{READY_PREFIX}not-a-key 1.0")),
            None
        );
        assert_eq!(parse_ready_line(&format!("{READY_PREFIX}{key}")), None);
        assert_eq!(
            parse_ready_line(&format!("{READY_PREFIX}{key} 1.0 extra")),
            None
        );
        assert_eq!(
            parse_ready_line("$ tsunagiai-mcp --serve --bind 10.0.0.1"),
            None
        );
    }

    #[test]
    fn the_error_line_goes_round_in_one_line() {
        let line = error_line("ポートが\n使われています\r\n  です");
        assert!(!line.contains('\n') && !line.contains('\r'));
        assert_eq!(
            parse_error_line(&line),
            Some("ポートが 使われています です".to_owned())
        );
        assert_eq!(
            parse_error_line(&ready_line(&STANDARD.encode([1; 32]), "1")),
            None
        );
        assert_eq!(parse_error_line(STOPPED_LINE), None);
    }

    // ---- the arguments and the decisions ----

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|a| (*a).to_owned()).collect()
    }

    #[test]
    fn the_server_modes_are_read_from_the_arguments() {
        assert_eq!(
            mode_of(args(&["--serve", "--bind", "10.0.0.2"])),
            Ok(Some(Mode::Serve {
                bind: "10.0.0.2".to_owned(),
                client_key: None
            }))
        );
        assert_eq!(
            mode_of(args(&[
                "--serve",
                "--client-key",
                "k",
                "--bind",
                "10.0.0.2"
            ])),
            Ok(Some(Mode::Serve {
                bind: "10.0.0.2".to_owned(),
                client_key: Some("k".to_owned())
            }))
        );
        assert_eq!(
            mode_of(args(&["--serve-run", "--bind", "::1"])),
            Ok(Some(Mode::Run {
                bind: "::1".to_owned()
            }))
        );
        assert_eq!(mode_of(args(&["--serve-stop"])), Ok(Some(Mode::Stop)));
        assert_eq!(mode_of(args(&["--formation", "a"])), Ok(None));
        assert_eq!(mode_of(args(&[])), Ok(None));
        // Only the first argument names a mode: the same words further on are the values of other flags.
        for other in [
            &["--formation-start", "x", "--project", "--serve-stop"][..],
            &["--formation-start", "x", "--project", "--serve-run"],
            &["--formation-start", "x", "--project", "--serve"],
            &["--formation", "a", "--serve", "--bind", "10.0.0.2"],
        ] {
            assert_eq!(mode_of(args(other)), Ok(None), "{other:?}");
        }
        for bad in [
            &["--serve"][..],
            &["--serve", "--bind"],
            &["--serve", "--bind", "1.2.3.4", "--client-key"],
            &["--serve-run"],
        ] {
            assert!(mode_of(args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_bind_is_an_ip_address() {
        assert!(bind_address("127.0.0.1").is_ok());
        assert!(bind_address("fe80::1").is_ok());
        assert!(bind_address("example.com").is_err());
        assert!(bind_address("").is_err());
    }

    #[test]
    fn the_pid_line_goes_round() {
        let line = pid_line(4242, "0.82.5", "10.0.0.2");
        assert_eq!(
            parse_pid_line(&line),
            Some(Running {
                pid: 4242,
                version: "0.82.5".to_owned(),
                bind: "10.0.0.2".to_owned()
            })
        );
        for bad in [
            "",
            "4242",
            "4242 1.0",
            "x 1.0 a",
            "1 1.0 a",
            "4242 1.0 a b",
            "-5 1.0 a",
        ] {
            assert_eq!(parse_pid_line(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_running_server_is_kept_only_when_nothing_differs() {
        let running = Running {
            pid: 10,
            version: "1.0".to_owned(),
            bind: "10.0.0.2".to_owned(),
        };
        assert_eq!(plan(None, "1.0", "10.0.0.2", false), Plan::Start);
        assert_eq!(plan(Some(&running), "1.0", "10.0.0.2", false), Plan::Keep);
        assert_eq!(
            plan(Some(&running), "1.1", "10.0.0.2", false),
            Plan::Restart
        );
        assert_eq!(
            plan(Some(&running), "1.0", "10.0.0.3", false),
            Plan::Restart
        );
        assert_eq!(plan(Some(&running), "1.0", "10.0.0.2", true), Plan::Restart);
    }

    // ---- the files ----

    #[test]
    fn the_keys_are_made_once_and_kept_private() {
        let config = temp_dir("keys");
        let dir = remote_dir(&config);
        private_dir(&dir).unwrap();
        let (secret, public) = load_or_create_keys(&dir).unwrap();
        assert_eq!(public, public_of(&secret));
        assert_eq!(load_or_create_keys(&dir).unwrap(), (secret, public));
        assert_eq!(read_key(&dir, SERVER_PUB_FILE).unwrap(), Some(public));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(dir.clone()), 0o700);
            assert_eq!(mode(dir.join(SERVER_KEY_FILE)), 0o600);
        }
        std::fs::write(dir.join(SERVER_KEY_FILE), "broken").unwrap();
        assert!(load_or_create_keys(&dir).is_err());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn the_apps_key_is_pinned_by_the_argument_and_never_without_one() {
        let config = temp_dir("pin");
        let dir = remote_dir(&config);
        private_dir(&dir).unwrap();
        let key = STANDARD.encode(public_of(&[1; 32]));
        let other = STANDARD.encode(public_of(&[2; 32]));
        assert!(pin_client_key(&dir, None).is_err(), "nothing pinned");
        assert!(pin_client_key(&dir, Some("short")).is_err());
        assert_eq!(pin_client_key(&dir, Some(&key)), Ok(true));
        assert_eq!(pin_client_key(&dir, Some(&key)), Ok(false));
        assert_eq!(pin_client_key(&dir, None), Ok(false));
        assert_eq!(pin_client_key(&dir, Some(&other)), Ok(true));
        assert_eq!(
            read_key(&dir, CLIENT_PUB_FILE).unwrap(),
            canonical_32(&other)
        );
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn the_version_is_the_file_or_0_0_0() {
        let config = temp_dir("version");
        let dir = remote_dir(&config);
        private_dir(&dir).unwrap();
        assert_eq!(read_version(&dir), "0.0.0");
        std::fs::write(dir.join(VERSION_FILE), "0.82.5\n").unwrap();
        assert_eq!(read_version(&dir), "0.82.5");
        for bad in ["", "a b", "1.0\n2.0", "あ"] {
            std::fs::write(dir.join(VERSION_FILE), bad).unwrap();
            assert_eq!(read_version(&dir), "0.0.0", "{bad:?}");
        }
        std::fs::remove_dir_all(&config).unwrap();
    }

    // ---- the API ----

    fn call(config: &Path, method: &str, params: Value) -> Reply {
        let request = serde_json::to_vec(&json!({"method": method, "params": params})).unwrap();
        dispatch(config, "1.2.3", &request)
    }

    #[test]
    fn version_stop_and_the_unknown_are_answered() {
        let config = temp_dir("api-basic");
        let reply = call(&config, "version", Value::Null);
        assert_eq!(
            reply.body,
            json!({"ok": true, "result": {"version": "1.2.3"}})
        );
        assert!(!reply.stop);
        assert!(call(&config, "stop", Value::Null).stop);
        let unknown = call(&config, "nope", Value::Null);
        assert_eq!(unknown.body["ok"], false);
        assert!(!unknown.stop);
        assert_eq!(dispatch(&config, "1", b"not json").body["ok"], false);
        assert_eq!(
            call(&config, "children.read", json!({"x": 1})).body["ok"],
            false
        );
        assert_eq!(
            call(&config, "children.drop", json!({"formation": "a"})).body["ok"],
            false
        );
    }

    #[test]
    fn the_pages_of_a_formation_are_read_by_name_and_a_page_that_is_not_there_is_refused() {
        let config = temp_dir("api-pages");
        write_record(&config, "api-work", &["one"]);
        let none = call(&config, "pages.read", json!({"formation": "api-work"}));
        assert_eq!(none.body, json!({"ok": true, "result": {"pages": []}}));
        let page = json!({"child": "one", "path": "/p.json", "title": "t", "page_kind": "approval", "subject": "design", "at": 5});
        std::fs::write(
            formation::dir(&config, "api-work").join("pages.json"),
            json!({"pages": [page]}).to_string(),
        )
        .unwrap();
        let read = call(&config, "pages.read", json!({"formation": "api-work"}));
        assert_eq!(read.body["result"]["pages"], json!([page]));
        // A name that leaves the folder, and arguments that do not fit, are refused and nothing is read.
        assert_eq!(
            call(&config, "pages.read", json!({"formation": "../x"})).body["ok"],
            false
        );
        assert_eq!(call(&config, "pages.read", json!({})).body["ok"], false);
        assert_eq!(
            call(&config, "page.read", json!({"formation": "api-work"})).body["ok"],
            false
        );
        // A child with no page waiting (its launch is after the page, or it has none) is refused before Orca is asked.
        let missing = call(
            &config,
            "page.read",
            json!({"formation": "api-work", "child": "two"}),
        );
        assert_eq!(missing.body["ok"], false);
        assert!(missing.body["error"].as_str().unwrap().contains("two"));
        let bad = call(
            &config,
            "page.read",
            json!({"formation": "api-work", "child": "../x"}),
        );
        assert_eq!(bad.body["ok"], false);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn the_records_are_read_by_name_and_a_missing_one_is_none() {
        let config = temp_dir("api-read");
        write_record(&config, "api-work", &["one", "two"]);
        std::fs::create_dir_all(formation::dir(&config, "empty")).unwrap();
        write_record(&config, "broken", &[]);
        std::fs::write(formation::dir(&config, "broken").join(CHILDREN_FILE), "{").unwrap();
        let names = ["api-work", "gone", "empty", "broken"].map(str::to_owned);
        let reply = call(&config, "children.read", json!({"formations": names}));
        let entries: Vec<RemoteChildren> =
            serde_json::from_value(reply.body["result"]["formations"].clone()).unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].formation, "api-work");
        assert_eq!(entries[0].children, Some(vec![child("one"), child("two")]));
        assert_eq!(entries[1].children, None);
        assert_eq!(entries[1].error, None);
        assert_eq!(entries[2].children, None);
        assert!(entries[3].children.is_none() && entries[3].error.is_some());
        assert!(
            !formation::dir(&config, "gone").exists(),
            "a read makes nothing"
        );
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_name_that_leaves_the_folder_is_refused_and_nothing_outside_is_touched() {
        let config = temp_dir("api-names");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join(CHILDREN_FILE), "outside").unwrap();
        for bad in ["../x", "a/b", "..", ".", "", "A", "a b", "-a"] {
            let read = call(&config, "children.read", json!({"formations": [bad]}));
            assert_eq!(read.body["ok"], false, "{bad:?}");
            let dropped = call(
                &config,
                "children.drop",
                json!({"formation": bad, "names": []}),
            );
            assert_eq!(dropped.body["ok"], false, "{bad:?}");
        }
        write_record(&config, "ok", &["one"]);
        let bad_child = call(
            &config,
            "children.drop",
            json!({"formation": "ok", "names": ["../one"]}),
        );
        assert_eq!(bad_child.body["ok"], false);
        assert_eq!(names_of(&config, "ok"), ["one"]);
        assert_eq!(
            std::fs::read_to_string(config.join(CHILDREN_FILE)).unwrap(),
            "outside"
        );
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_drop_takes_out_only_the_names_and_keeps_the_children_added_since() {
        let config = temp_dir("api-drop");
        write_record(&config, "api-work", &["one", "two", "three"]);
        let reply = call(
            &config,
            "children.drop",
            json!({"formation": "api-work", "names": ["one", "three", "unknown"]}),
        );
        assert_eq!(reply.body, json!({"ok": true, "result": {"removed": 2}}));
        assert_eq!(names_of(&config, "api-work"), ["two"]);
        // The orchestrator adds a child after the app read the record: the drop is made on what is there now.
        write_record(&config, "api-work", &["two", "four"]);
        let reply = call(
            &config,
            "children.drop",
            json!({"formation": "api-work", "names": ["two"]}),
        );
        assert_eq!(reply.body["result"]["removed"], 1);
        assert_eq!(names_of(&config, "api-work"), ["four"]);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_drop_that_changes_nothing_writes_nothing_and_makes_no_folder() {
        let config = temp_dir("api-drop-none");
        write_record(&config, "api-work", &["one"]);
        let path = formation::dir(&config, "api-work").join(CHILDREN_FILE);
        std::fs::write(
            &path,
            r#"{"children":[{"name":"one","repo":"r","environment":"pc"}]}"#,
        )
        .unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        let reply = call(
            &config,
            "children.drop",
            json!({"formation": "api-work", "names": ["other"]}),
        );
        assert_eq!(reply.body["result"]["removed"], 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        let reply = call(
            &config,
            "children.drop",
            json!({"formation": "gone", "names": ["one"]}),
        );
        assert_eq!(reply.body["result"]["removed"], 0);
        assert!(!formation::dir(&config, "gone").exists());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_drop_does_not_write_over_a_record_it_cannot_read() {
        let config = temp_dir("api-drop-broken");
        write_record(&config, "api-work", &["one"]);
        let path = formation::dir(&config, "api-work").join(CHILDREN_FILE);
        std::fs::write(&path, "{").unwrap();
        let reply = call(
            &config,
            "children.drop",
            json!({"formation": "api-work", "names": ["one"]}),
        );
        assert_eq!(reply.body["ok"], false);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{");
        std::fs::remove_dir_all(&config).unwrap();
    }

    // ---- both ends over a local socket ----

    struct Served {
        config: PathBuf,
        port: u16,
        client_secret: [u8; 32],
        server_public: [u8; 32],
        task: tokio::task::JoinHandle<()>,
    }

    async fn served(name: &str) -> Served {
        let config = temp_dir(name);
        std::fs::create_dir_all(&config).unwrap();
        let (client_secret, client_public) = pair(1);
        let (server_secret, server_public) = pair(2);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let setup = Setup {
            config: config.clone(),
            secret: server_secret,
            client_public,
            version: "9.9.9".to_owned(),
        };
        let task = tokio::spawn(serve(listener, setup));
        Served {
            config,
            port,
            client_secret,
            server_public,
            task,
        }
    }

    impl Served {
        async fn client(&self) -> Client {
            Client::connect(
                "127.0.0.1",
                self.port,
                self.client_secret,
                self.server_public,
            )
            .await
            .unwrap()
        }
    }

    #[tokio::test]
    async fn the_pages_and_the_page_of_a_child_are_read_over_the_socket() {
        let served = served("net-pages").await;
        write_record(&served.config, "api-work", &["one"]);
        let mut client = served.client().await;
        assert_eq!(client.pages_read("api-work").await.unwrap(), []);
        let page = json!({"child": "one", "path": "/p.json", "title": "t", "page_kind": "approval", "subject": "design", "at": 5});
        std::fs::write(
            formation::dir(&served.config, "api-work").join("pages.json"),
            json!({"pages": [page]}).to_string(),
        )
        .unwrap();
        let pages = client.pages_read("api-work").await.unwrap();
        assert_eq!((pages[0].child.as_str(), pages[0].at), ("one", 5));
        assert!(client.pages_read("../x").await.is_err());
        // The page of a child whose record has no launch is refused with the reason, before Orca is asked.
        let error = client.page_read("api-work", "one").await.unwrap_err();
        assert!(error.contains("one"), "{error}");
        served.task.abort();
        std::fs::remove_dir_all(&served.config).unwrap();
    }

    #[tokio::test]
    async fn the_right_key_reads_drops_and_stops() {
        let served = served("net-ok").await;
        write_record(&served.config, "api-work", &["one", "two"]);
        let mut client = served.client().await;
        assert_eq!(client.version().await.unwrap(), "9.9.9");
        let read = client
            .children_read(&["api-work".to_owned(), "gone".to_owned()])
            .await
            .unwrap();
        assert_eq!(read[0].children, Some(vec![child("one"), child("two")]));
        assert_eq!(read[1].children, None);
        assert_eq!(
            client
                .children_drop("api-work", &["one".to_owned()])
                .await
                .unwrap(),
            1
        );
        assert!(client.children_drop("../x", &[]).await.is_err());
        let read = client
            .children_read(&["api-work".to_owned()])
            .await
            .unwrap();
        assert_eq!(read[0].children, Some(vec![child("two")]));
        // A second connection works while the first is open, and the first still does.
        let mut other = served.client().await;
        assert_eq!(other.version().await.unwrap(), "9.9.9");
        assert_eq!(client.version().await.unwrap(), "9.9.9");
        client.stop().await.unwrap();
        timeout(Duration::from_secs(5), served.task)
            .await
            .unwrap()
            .unwrap();
        std::fs::remove_dir_all(&served.config).unwrap();
    }

    #[tokio::test]
    async fn another_static_key_gets_no_answer() {
        let served = served("net-wrong-client").await;
        write_record(&served.config, "api-work", &["one"]);
        let mut stranger = Client::connect("127.0.0.1", served.port, [3; 32], served.server_public)
            .await
            .unwrap();
        assert!(stranger.version().await.is_err());
        assert!(stranger
            .children_read(&["api-work".to_owned()])
            .await
            .is_err());
        // The server is still there for the right key.
        assert_eq!(served.client().await.version().await.unwrap(), "9.9.9");
        assert_eq!(names_of(&served.config, "api-work"), ["one"]);
        served.task.abort();
        std::fs::remove_dir_all(&served.config).unwrap();
    }

    #[tokio::test]
    async fn a_server_with_another_key_is_not_believed() {
        let served = served("net-wrong-server").await;
        let (_, other_public) = pair(5);
        let mut client =
            Client::connect("127.0.0.1", served.port, served.client_secret, other_public)
                .await
                .unwrap();
        assert!(client.version().await.is_err());
        served.task.abort();
        std::fs::remove_dir_all(&served.config).unwrap();
    }

    /// A raw socket that did the handshake with the right keys, so that frames can be sent as the test likes.
    async fn raw(served: &Served) -> (WebSocketStream<TcpStream>, Channel) {
        let stream = TcpStream::connect(("127.0.0.1", served.port))
            .await
            .unwrap();
        let (mut socket, _) = client_async_with_config(
            format!("ws://127.0.0.1:{}/", served.port),
            stream,
            Some(socket_config()),
        )
        .await
        .unwrap();
        let handshake = ClientHandshake::new(served.client_secret, served.server_public).unwrap();
        socket
            .send(Message::Binary(handshake.hello().into()))
            .await
            .unwrap();
        let ready = next_binary(&mut socket).await.unwrap();
        (socket, handshake.accept_ready(&ready).unwrap())
    }

    #[tokio::test]
    async fn a_replayed_a_changed_and_an_oversized_frame_end_the_connection() {
        let served = served("net-frames").await;
        let request = serde_json::to_vec(&json!({"method": "version"})).unwrap();

        let (mut socket, mut channel) = raw(&served).await;
        let frame = channel.seal(&request).unwrap();
        socket
            .send(Message::Binary(frame.clone().into()))
            .await
            .unwrap();
        assert!(channel
            .open(&next_binary(&mut socket).await.unwrap())
            .is_some());
        socket.send(Message::Binary(frame.into())).await.unwrap();
        assert_eq!(next_binary(&mut socket).await, None, "a replay ends it");

        let (mut socket, mut channel) = raw(&served).await;
        let mut frame = channel.seal(&request).unwrap();
        frame[TAG_LENGTH] ^= 1;
        socket.send(Message::Binary(frame.into())).await.unwrap();
        assert_eq!(next_binary(&mut socket).await, None, "a change ends it");

        let (mut socket, _) = raw(&served).await;
        // Over the limit of a message: the sending side may be refused by its own library, and the server closes either way.
        let _ = socket
            .send(Message::Binary(vec![0; MAX_FRAME + 1].into()))
            .await;
        assert_eq!(next_binary(&mut socket).await, None, "a big frame ends it");

        assert_eq!(served.client().await.version().await.unwrap(), "9.9.9");
        served.task.abort();
        std::fs::remove_dir_all(&served.config).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn the_deadline_to_the_first_frame_is_one_for_the_accept_and_the_steps_after_it() {
        let (client_secret, client_public) = pair(1);
        let (server_secret, server_public) = pair(2);
        let setup = Setup {
            config: temp_dir("net-deadline"),
            secret: server_secret,
            client_public,
            version: "9.9.9".to_owned(),
        };
        let (client_end, server_end) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move { handle(server_end, &setup, &Notify::new()).await });
        let (mut socket, _) =
            client_async_with_config("ws://x/".to_owned(), client_end, Some(socket_config()))
                .await
                .unwrap();
        // The hello comes 6 seconds after the accept, which leaves 4 of the 10 for the first request.
        tokio::time::sleep(Duration::from_secs(6)).await;
        let handshake = ClientHandshake::new(client_secret, server_public).unwrap();
        socket
            .send(Message::Binary(handshake.hello().into()))
            .await
            .unwrap();
        assert!(next_binary(&mut socket).await.is_some());
        // No request follows: the server closes at 10 seconds from the accept (4 from now), not 10 from the answer.
        let heard = timeout(Duration::from_secs(8), next_binary(&mut socket)).await;
        assert_eq!(heard, Ok(None), "the server must have closed it");
        assert_eq!(server.await.unwrap(), None);
    }

    #[tokio::test]
    async fn text_before_the_handshake_ends_the_connection() {
        let served = served("net-text").await;
        let stream = TcpStream::connect(("127.0.0.1", served.port))
            .await
            .unwrap();
        let (mut socket, _) = client_async_with_config(
            format!("ws://127.0.0.1:{}/", served.port),
            stream,
            Some(socket_config()),
        )
        .await
        .unwrap();
        socket.send(Message::Text("hello".into())).await.unwrap();
        assert_eq!(next_binary(&mut socket).await, None);
        served.task.abort();
        std::fs::remove_dir_all(&served.config).unwrap();
    }

    #[tokio::test]
    async fn an_answer_that_is_too_big_is_an_error() {
        let served = served("net-big").await;
        let mut client = served.client().await;
        // Each record is about 100 bytes: 200 formations of 600 children each do not fit one frame.
        let names: Vec<String> = (0..600)
            .map(|i| format!("child-{i}-{}", "x".repeat(20)))
            .collect();
        let children: Vec<Child> = names.iter().map(|n| child(n)).collect();
        let formations: Vec<String> = (0..200).map(|i| format!("f{i}")).collect();
        for formation in &formations {
            let dir = formation::dir(&served.config, formation);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join(CHILDREN_FILE),
                serde_json::to_string(&json!({"children": children})).unwrap(),
            )
            .unwrap();
        }
        let error = client.children_read(&formations).await.unwrap_err();
        assert_eq!(error, "答えが大きすぎます");
        assert_eq!(
            client.version().await.unwrap(),
            "9.9.9",
            "the connection goes on"
        );
        served.task.abort();
        std::fs::remove_dir_all(&served.config).unwrap();
    }
}
