//! The connection to the Orca of a target: this machine's runtime over its unix socket, or a paired server over an end-to-end encrypted WebSocket (A-8, A-10, A-12, A-18 and the hand-over of A-9 call Orca through it). Nothing is stored here.
//! What is read from Orca's files: `orca-runtime.json` (this machine) and `orca-environments.json` (a paired server), at each connect and never written.
//! A token, a key or an auth frame is in no log line, no error text and no `Debug` output (the types that hold one derive none).

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    time::Duration,
};

use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt, StreamExt,
};
use serde_json::{json, Value};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};

use crate::{
    orca::text_of,
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
const ENVIRONMENTS_FILE: &str = "orca-environments.json";
const RUNTIME_FILE: &str = "orca-runtime.json";

/// How long to wait before connecting again after the `attempt`th failure in a row (counting from 0).
pub(crate) fn backoff(attempt: usize) -> Duration {
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

pub(crate) fn orca_dir() -> Option<PathBuf> {
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
        return Err("ws:// 以外の接続先にはつなげません".into());
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

pub(crate) enum LinkError {
    /// The connection or a frame failed: the session reconnects.
    Broken(String),
    /// Orca answered `ok: false`: the text to show (the code), and the message of Orca, which is only looked at (A-10 tells a missing file by it) and never shown.
    Remote(String, String),
}

fn broken(message: &str) -> LinkError {
    LinkError::Broken(message.to_owned())
}

/// The `result` of `{id, ok, result, error: {code}}`. The code is shown, never the message: it is the text of another program.
pub(crate) fn result_of(response: &Value) -> Result<Value, LinkError> {
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
            let message: String = response["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect();
            Err(LinkError::Remote(
                if code.is_empty() {
                    "Orca がエラーを返しました".into()
                } else {
                    format!("Orca がエラーを返しました（{code}）")
                },
                message,
            ))
        }
        _ => Err(broken("Orca の応答を読めません")),
    }
}

fn is_keepalive(value: &Value) -> bool {
    value["_keepalive"] == true
}

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// A paired server: a WebSocket whose frames are sealed. Answers are matched by `id`; a streamed answer carries its subscription's.
pub(crate) struct WsLink {
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
    pub(crate) async fn connect(
        url: &str,
        device_token: &str,
        public_key_b64: &str,
    ) -> Result<Self, String> {
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

    pub(crate) fn silence_deadline(&self) -> Instant {
        self.last_frame + SILENCE_LIMIT
    }

    /// Sends `method` as the sealed request `{id, deviceToken, method, params}` and gives its id.
    pub(crate) async fn send_request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<String, LinkError> {
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
    pub(crate) async fn next_response(&mut self) -> Result<Option<Value>, String> {
        if let Some(value) = self.queued.pop_front() {
            return Ok(Some(value));
        }
        Ok(match self.read_frame().await? {
            Frame::Json(value) => Some(value),
            Frame::Idle => None,
        })
    }

    /// A request and its one answer; answers of other requests that come first are queued.
    pub(crate) async fn request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, LinkError> {
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
        "このマシンの Orca には macOS からつなげますが、この OS からはつなげません",
    ))
}

/// A WebSocket to the saved environment `environment`, with its pairing read from Orca's files now (A-12 streams the Orca screen over it). No token is in the error.
pub(crate) async fn connect_environment(environment: String) -> Result<WsLink, String> {
    let pairing = tokio::task::spawn_blocking(move || load_pairing(Some(&environment)))
        .await
        .map_err(|e| e.to_string())??;
    match pairing {
        Pairing::WebSocket {
            url,
            device_token,
            public_key_b64,
        } => WsLink::connect(&url, &device_token, &public_key_b64).await,
        Pairing::Unix { .. } => Err("接続先の登録（ペアリング）が見つかりません".into()),
    }
}

/// A call of this machine's Orca over its unix socket (A-8 asks for the SSH hosts, which the CLI cannot list, and sends the keys of a mirrored terminal, which the CLI would put in its arguments). The `result`, or a Japanese message; no token is in it.
pub(crate) async fn local_call(method: &str, params: Value) -> Result<Value, String> {
    // The file is read off the async workers.
    let pairing = tokio::task::spawn_blocking(|| load_pairing(None))
        .await
        .map_err(|e| e.to_string())??;
    match pairing {
        Pairing::Unix { endpoint, token } => unix_request(&endpoint, &token, method, params)
            .await
            .map_err(|e| match e {
                LinkError::Broken(message) | LinkError::Remote(message, _) => message,
            }),
        Pairing::WebSocket { .. } => Err("Orca の接続情報を読めません".into()),
    }
}

/// A call that failed: `shown` is for the screen (Japanese, with Orca's code, never its message); `detail` is the message Orca sent (empty when the connection failed), for the caller to look at and not to show.
pub(crate) struct CallError {
    pub(crate) shown: String,
    pub(crate) detail: String,
}

/// One connection to the Orca of a target, kept for several calls (A-10 sends a file in many): for a paired server one WebSocket, for this machine the unix socket (a connection for each call, as `local_call`).
/// The pairing is read from Orca's files when it is opened; no token is in a return value or a log.
pub(crate) struct Connection(Link);

impl Connection {
    pub(crate) async fn open(environment: Option<String>) -> Result<Self, String> {
        let pairing = tokio::task::spawn_blocking(move || load_pairing(environment.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
        Link::open(pairing).await.map(Self)
    }

    pub(crate) async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
        self.0.request(method, params).await.map_err(|e| match e {
            LinkError::Broken(shown) => CallError {
                shown,
                detail: String::new(),
            },
            LinkError::Remote(shown, detail) => CallError { shown, detail },
        })
    }
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
pub(crate) fn reason_of(error: LinkError) -> String {
    match error {
        LinkError::Broken(message) | LinkError::Remote(message, _) => message,
    }
}

/// Orca's side of a paired connection, for the tests of this module and of A-12.
#[cfg(test)]
pub(crate) mod ws_testing {
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

    use crate::orca_e2ee::testing::Desktop;

    /// Orca's side of a paired connection, over a local socket.
    pub(crate) struct FakeDesktop {
        pub(crate) socket: WebSocketStream<tokio::net::TcpStream>,
        pub(crate) desktop: Desktop,
    }

    pub(crate) async fn next_text(socket: &mut WebSocketStream<tokio::net::TcpStream>) -> String {
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
        pub(crate) async fn accept(
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
        pub(crate) async fn request(&mut self) -> Value {
            let text = next_text(&mut self.socket).await;
            serde_json::from_str(&self.desktop.open_text(&text).unwrap()).unwrap()
        }

        pub(crate) async fn send(&mut self, value: Value) {
            let sealed = self.desktop.seal_text(&value.to_string());
            self.socket.send(Message::text(sealed)).await.unwrap();
        }
    }

    pub(crate) async fn bind() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        (listener, url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn an_answer_gives_its_result_or_the_code_and_never_the_message() {
        assert_eq!(
            result_of(&json!({"id": "1", "ok": true, "result": {"a": 1}})).ok(),
            Some(json!({"a": 1}))
        );
        let remote = |v: Value| match result_of(&v) {
            Err(LinkError::Remote(m, _)) => m,
            _ => panic!("{v}"),
        };
        assert_eq!(
            remote(
                json!({"ok": false, "error": {"code": "not_found", "message": "secret path /x"}})
            ),
            "Orca がエラーを返しました（not_found）"
        );
        assert_eq!(remote(json!({"ok": false})), "Orca がエラーを返しました");
        // The message is held for the caller to look at, cut at 200 characters.
        let held = |v: Value| match result_of(&v) {
            Err(LinkError::Remote(_, m)) => m,
            _ => panic!("{v}"),
        };
        assert_eq!(
            held(json!({"ok": false, "error": {"code": "runtime_error", "message": "ENOENT: x"}})),
            "ENOENT: x"
        );
        assert_eq!(held(json!({"ok": false})), "");
        assert_eq!(
            held(json!({"ok": false, "error": {"message": "x".repeat(500)}})).len(),
            200
        );
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

    // -- the sockets --

    use std::sync::{Arc, Mutex};

    use crate::orca_e2ee::testing::Desktop;

    use super::ws_testing::{bind, next_text, FakeDesktop};

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
        assert!(matches!(failed, Err(LinkError::Remote(m, _)) if m.contains("not_found")));
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
        assert!(matches!(refused, Err(LinkError::Remote(m, _)) if m.contains("unauthorized")));
        let missing = unix_request("/nonexistent/orca.sock", "t", "x", json!({})).await;
        assert!(matches!(missing, Err(LinkError::Broken(m)) if m.contains("起動")));
    }
}
