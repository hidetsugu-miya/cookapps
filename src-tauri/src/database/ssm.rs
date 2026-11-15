//! The port forward through AWS Systems Manager that a database connection goes through (D-1, #630).
//!
//! `Tunnels::open` finds the bastion by the `Name` tag among the managed nodes that are Online (`DescribeInstanceInformation`),
//! starts a session with the document `AWS-StartPortForwardingSessionToRemoteHost` (`StartSession`) and starts `session-manager-plugin` as a child process,
//! which opens a port on this machine and carries it to the DB host. The local port is not given: the plugin chooses a free one and writes
//! `Port N opened for sessionId …` on its standard output, which is read here (`muxportforwarding.go` of the plugin).
//! `close` stops the plugin and calls `TerminateSession`, because stopping the parent alone leaves the plugin running and the session Connected (#625).
//! The app's exit closes every tunnel that is still open (`Tunnels::close_all`, called from `lib.rs`).
//!
//! The arguments of the plugin follow `ValidateInputAndStartSession` of its `session.go`: the response of `StartSession`, the region, the operation name,
//! the AWS profile, the parameters of the call and the endpoint of SSM. The response (which holds the token of the data channel) is not put in the argument list,
//! where `ps` would show it: the plugin reads it from the environment variable named by the first argument when that name starts with `AWS_SSM_START_SESSION_RESPONSE`.
//! Nothing goes through a shell. The decisions (the places of the plugin, the arguments, the line with the port, the choice of the node, the error to show) are pure functions.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use aws_config::{BehaviorVersion, Region};
use aws_sdk_ssm::{
    error::{DisplayErrorContext, ProvideErrorMetadata, SdkError},
    types::{InstanceInformationStringFilter, PingStatus},
    Client,
};
use serde_json::json;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

const DOCUMENT: &str = "AWS-StartPortForwardingSessionToRemoteHost";
const OPERATION: &str = "StartSession";
const RESPONSE_ENV: &str = "AWS_SSM_START_SESSION_RESPONSE";
const PLUGIN: &str = "session-manager-plugin";
/// One call of the AWS API, loading the credentials included.
const API_TIMEOUT: Duration = Duration::from_secs(20);
/// From the start of the plugin to its line with the port (it took 2 seconds on 2026-11-14).
const PORT_TIMEOUT: Duration = Duration::from_secs(30);
const ERROR_MAX: usize = 300;
/// `CREATE_NO_WINDOW`: a GUI app that starts a console program must not flash a console window.
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

/// Where the tunnel goes: the fields of a connection profile that `use_ssm` uses.
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub aws_profile: String,
    pub region: String,
    /// The `Name` tag of the instance to forward through.
    pub bastion_name: String,
    pub db_host: String,
    pub db_port: u16,
}

/// An open tunnel: `close` takes `id`, and a client connects to `127.0.0.1:port`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Opened {
    pub id: u64,
    pub port: u16,
}

/// Why a tunnel could not be opened or closed. `message` is what the screen shows.
#[derive(Debug, PartialEq)]
enum Failure {
    AuthExpired,
    BastionNotFound(String),
    PluginMissing,
    Timeout,
    /// The plugin ended before it wrote the port; the last line it wrote, if any.
    Plugin(Option<String>),
    Aws(String),
}

impl Failure {
    fn message(&self) -> String {
        match self {
            Self::AuthExpired => "AWS の認証が切れています。手元で aws login を行ってから、もう一度お試しください".to_owned(),
            Self::BastionNotFound(name) => format!(
                "踏み台「{name}」が見つかりません。名前と、SSM の管理対象で Online になっていることを確かめてください"
            ),
            Self::PluginMissing => "session-manager-plugin が見つかりません。インストールしてください".to_owned(),
            Self::Timeout => "AWS への接続が時間内に終わりませんでした".to_owned(),
            Self::Plugin(Some(line)) => {
                format!("session-manager-plugin が終了しました: {}", shorten(line))
            }
            Self::Plugin(None) => "session-manager-plugin が、ポートを開く前に終了しました".to_owned(),
            Self::Aws(text) => format!("AWS の呼び出しに失敗しました: {}", shorten(text)),
        }
    }
}

pub(super) fn shorten(text: &str) -> String {
    let mut chars = text.trim().chars();
    let head: String = chars.by_ref().take(ERROR_MAX).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// What an error of the AWS API is: `code` is the code of the error the service answered, `text` its whole text.
/// A credential that cannot be loaded or that the service refuses as expired is one thing, the owner's `aws login`; the SDK words the first as a message only.
fn classify(code: Option<&str>, text: &str) -> Failure {
    const CODES: [&str; 7] = [
        "ExpiredToken",
        "ExpiredTokenException",
        "InvalidClientTokenId",
        "UnrecognizedClientException",
        "InvalidSignatureException",
        "SignatureDoesNotMatch",
        "RequestExpired",
    ];
    const WORDS: [&str; 5] = [
        "credentials",
        "expired",
        "reauthenticate",
        "could not be found",
        "login",
    ];
    let lower = text.to_lowercase();
    if code.is_some_and(|c| CODES.contains(&c)) || WORDS.iter().any(|w| lower.contains(w)) {
        return Failure::AuthExpired;
    }
    Failure::Aws(text.to_owned())
}

fn aws_failure<E>(error: &SdkError<E>) -> Failure
where
    E: ProvideErrorMetadata + std::error::Error + 'static,
{
    if matches!(error, SdkError::TimeoutError(_)) {
        return Failure::Timeout;
    }
    classify(error.code(), &DisplayErrorContext(error).to_string())
}

/// A managed node as `DescribeInstanceInformation` lists it.
#[derive(Debug, PartialEq)]
struct Node {
    id: String,
    online: bool,
}

/// The first node that is Online. The filter of the call asks for Online too; this keeps a node that is not from being taken when the service ignores a filter.
fn choose_instance(nodes: &[Node]) -> Option<&str> {
    nodes
        .iter()
        .find(|n| n.online && !n.id.is_empty())
        .map(|n| n.id.as_str())
}

/// Where `session-manager-plugin` is looked for. A GUI app does not inherit the shell's PATH, so the folders of the installers (Homebrew, the AWS package) come first, as for `claude` (`claude.rs`).
fn plugin_locations(windows: bool) -> Vec<PathBuf> {
    if windows {
        return vec![
            PathBuf::from(
                r"C:\Program Files\Amazon\SessionManagerPlugin\bin\session-manager-plugin.exe",
            ),
            PathBuf::from("session-manager-plugin.exe"),
        ];
    }
    [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/local/sessionmanagerplugin/bin",
    ]
    .into_iter()
    .map(|dir| Path::new(dir).join(PLUGIN))
    .chain([PathBuf::from(PLUGIN)])
    .collect()
}

/// The first of `locations` that starts. A place that does not exist, or cannot be run, is passed over.
async fn find_plugin(locations: &[PathBuf]) -> Result<PathBuf, Failure> {
    for path in locations {
        let mut command = Command::new(path);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(NO_WINDOW);
        if command.status().await.is_ok() {
            return Ok(path.clone());
        }
    }
    Err(Failure::PluginMissing)
}

/// The endpoint of SSM that the plugin checks the stream URL against.
fn endpoint(region: &str) -> String {
    format!("https://ssm.{region}.amazonaws.com")
}

/// The parameters of the `StartSession` call, as the plugin reads them (`Target` is required).
fn session_parameters(instance_id: &str, host: &str, port: u16) -> String {
    json!({
        "Target": instance_id,
        "DocumentName": DOCUMENT,
        "Parameters": { "host": [host], "portNumber": [port.to_string()] },
    })
    .to_string()
}

/// The answer of `StartSession` as the plugin reads it.
fn session_response(session_id: &str, token: &str, stream_url: &str) -> String {
    json!({ "SessionId": session_id, "TokenValue": token, "StreamUrl": stream_url }).to_string()
}

/// The argument list of the plugin after its own name (`args[1]` to `args[6]` of `session.go`). The first is the name of the variable that holds the response.
fn plugin_args(region: &str, aws_profile: &str, parameters: &str) -> Vec<String> {
    vec![
        RESPONSE_ENV.to_owned(),
        region.to_owned(),
        OPERATION.to_owned(),
        aws_profile.to_owned(),
        parameters.to_owned(),
        endpoint(region),
    ]
}

/// The port of the plugin's line `Port 52418 opened for sessionId abc.`.
fn port_from_line(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("Port ")?;
    let (number, rest) = rest.split_once(' ')?;
    if !rest.starts_with("opened for sessionId") {
        return None;
    }
    number.parse::<u16>().ok().filter(|p| *p != 0)
}

/// Reads lines until the one with the port. The plugin has ended (or its output is not text) when it gives none: the last line it wrote is the error.
async fn find_port<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<u16, Option<String>> {
    let mut last = None;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => return Err(last),
            Ok(_) => {}
        }
        if let Some(port) = port_from_line(&line) {
            return Ok(port);
        }
        if !line.trim().is_empty() {
            last = Some(line.trim().to_owned());
        }
    }
}

/// Starts the plugin and waits for its port. A plugin that does not give one in `wait`, or ends first, is stopped.
async fn start_plugin(
    path: &Path,
    args: &[String],
    response: &str,
    wait: Duration,
) -> Result<(Child, u16), Failure> {
    let mut command = Command::new(path);
    command
        .args(args)
        .env(RESPONSE_ENV, response)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(NO_WINDOW);
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Failure::PluginMissing
        } else {
            Failure::Aws(format!("session-manager-plugin を起動できません: {e}"))
        }
    })?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Err(Failure::Plugin(None));
    };
    let mut reader = BufReader::new(stdout);
    match tokio::time::timeout(wait, find_port(&mut reader)).await {
        Ok(Ok(port)) => {
            // The plugin goes on writing (a line for each connection): read it to the end, so that it never blocks on a full pipe.
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
            });
            Ok((child, port))
        }
        Ok(Err(last)) => {
            let _ = child.kill().await;
            Err(Failure::Plugin(last))
        }
        Err(_) => {
            let _ = child.kill().await;
            Err(Failure::Timeout)
        }
    }
}

async fn with_timeout<T>(
    call: impl std::future::Future<Output = Result<T, Failure>>,
) -> Result<T, Failure> {
    tokio::time::timeout(API_TIMEOUT, call)
        .await
        .map_err(|_| Failure::Timeout)?
}

async fn find_bastion(client: &Client, name: &str) -> Result<String, Failure> {
    let filter = |key: &str, value: &str| {
        InstanceInformationStringFilter::builder()
            .key(key)
            .values(value)
            .build()
            .map_err(|e| Failure::Aws(e.to_string()))
    };
    let request = client
        .describe_instance_information()
        .filters(filter("tag:Name", name)?)
        .filters(filter("PingStatus", "Online")?)
        .max_results(50);
    let answer = with_timeout(async { request.send().await.map_err(|e| aws_failure(&e)) }).await?;
    let nodes: Vec<Node> = answer
        .instance_information_list()
        .iter()
        .map(|i| Node {
            id: i.instance_id().unwrap_or_default().to_owned(),
            online: i.ping_status() == Some(&PingStatus::Online),
        })
        .collect();
    choose_instance(&nodes)
        .map(str::to_owned)
        .ok_or_else(|| Failure::BastionNotFound(name.to_owned()))
}

async fn terminate(client: &Client, session_id: &str) -> Result<(), Failure> {
    let request = client.terminate_session().session_id(session_id);
    with_timeout(async {
        request
            .send()
            .await
            .map(|_| ())
            .map_err(|e| aws_failure(&e))
    })
    .await
}

struct Tunnel {
    client: Client,
    session_id: String,
    child: Child,
}

impl Tunnel {
    /// Stops the plugin first, so that nothing is left listening, and then ends the session.
    async fn stop_plugin(&mut self) {
        let _ = self.child.kill().await;
    }
}

/// The tunnels that are open. Managed by Tauri (`lib.rs`), so that the app's exit closes them.
#[derive(Default)]
pub struct Tunnels {
    next: AtomicU64,
    open: Mutex<HashMap<u64, Tunnel>>,
}

impl Tunnels {
    /// Opens a tunnel to `target` and answers its id and the local port. The error is in Japanese:
    /// the AWS login that is no longer valid, a bastion that is not found, no plugin, and a time out are told apart.
    pub async fn open(&self, target: &Target) -> Result<Opened, String> {
        self.try_open(target).await.map_err(|f| f.message())
    }

    async fn try_open(&self, target: &Target) -> Result<Opened, Failure> {
        let plugin = find_plugin(&plugin_locations(cfg!(windows))).await?;
        let config = tokio::time::timeout(
            API_TIMEOUT,
            aws_config::defaults(BehaviorVersion::latest())
                .profile_name(&target.aws_profile)
                .region(Region::new(target.region.clone()))
                .load(),
        )
        .await
        .map_err(|_| Failure::Timeout)?;
        let client = Client::new(&config);
        let instance_id = find_bastion(&client, &target.bastion_name).await?;
        let started = client
            .start_session()
            .target(&instance_id)
            .document_name(DOCUMENT)
            .parameters("host", vec![target.db_host.clone()])
            .parameters("portNumber", vec![target.db_port.to_string()]);
        let started =
            with_timeout(async { started.send().await.map_err(|e| aws_failure(&e)) }).await?;
        let (Some(session_id), Some(token), Some(stream_url)) = (
            started.session_id(),
            started.token_value(),
            started.stream_url(),
        ) else {
            return Err(Failure::Aws(
                "StartSession の応答に必要な値がありません".to_owned(),
            ));
        };
        let args = plugin_args(
            &target.region,
            &target.aws_profile,
            &session_parameters(&instance_id, &target.db_host, target.db_port),
        );
        let response = session_response(session_id, token, stream_url);
        let (child, port) = match start_plugin(&plugin, &args, &response, PORT_TIMEOUT).await {
            Ok(started) => started,
            Err(failure) => {
                // The session exists at AWS though no plugin carries it: end it, and keep the first reason.
                let _ = terminate(&client, session_id).await;
                return Err(failure);
            }
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.open.lock().await.insert(
            id,
            Tunnel {
                client,
                session_id: session_id.to_owned(),
                child,
            },
        );
        Ok(Opened { id, port })
    }

    /// Closes a tunnel: stops the plugin and calls `TerminateSession`. An id that is not open is already closed.
    pub async fn close(&self, id: u64) -> Result<(), String> {
        let Some(mut tunnel) = self.open.lock().await.remove(&id) else {
            return Ok(());
        };
        tunnel.stop_plugin().await;
        terminate(&tunnel.client, &tunnel.session_id)
            .await
            .map_err(|f| f.message())
    }

    /// Closes every open tunnel (the app's exit). The plugins are stopped first, and the sessions are ended together.
    pub async fn close_all(&self) {
        let mut tunnels: Vec<Tunnel> = {
            let mut open = self.open.lock().await;
            open.drain().map(|(_, t)| t).collect()
        };
        for tunnel in &mut tunnels {
            tunnel.stop_plugin().await;
        }
        let ends = tunnels.iter().map(|t| terminate(&t.client, &t.session_id));
        for result in futures_util::future::join_all(ends).await {
            if let Err(failure) = result {
                eprintln!("ssm: {}", failure.message());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, online: bool) -> Node {
        Node {
            id: id.to_owned(),
            online,
        }
    }

    #[test]
    fn reads_the_port_of_the_plugins_line() {
        assert_eq!(
            port_from_line("Port 52418 opened for sessionId abc-0123."),
            Some(52418)
        );
        assert_eq!(
            port_from_line("  Port 3306 opened for sessionId x.\n"),
            Some(3306)
        );
    }

    #[test]
    fn ignores_the_other_lines_of_the_plugin() {
        for line in [
            "",
            "Starting session with SessionId: abc-0123",
            "Waiting for connections...",
            "Connection accepted for session [abc-0123]",
            "Unix socket /tmp/x opened for sessionId abc.",
            "Port opened for sessionId abc.",
            "Port x opened for sessionId abc.",
            "Port 0 opened for sessionId abc.",
            "Port 65536 opened for sessionId abc.",
            "Port -1 opened for sessionId abc.",
            "Port 52418 closed for sessionId abc.",
            "Cannot perform start session: boom Port 5 opened for sessionId a.",
        ] {
            assert_eq!(port_from_line(line), None, "{line:?}");
        }
    }

    #[tokio::test]
    async fn finds_the_port_among_the_lines() {
        let mut out = &b"\nStarting session with SessionId: abc\nPort 40001 opened for sessionId abc.\nWaiting for connections...\n"[..];
        assert_eq!(find_port(&mut out).await, Ok(40001));
    }

    #[tokio::test]
    async fn finds_a_port_line_that_has_no_line_break() {
        // The plugin writes the line without one, and the next write starts with one: a line that ends with the output is read too.
        let mut out = &b"Port 40002 opened for sessionId abc."[..];
        assert_eq!(find_port(&mut out).await, Ok(40002));
    }

    #[tokio::test]
    async fn answers_the_last_line_when_the_output_ends_without_a_port() {
        let mut out = &b"Starting session\nCannot perform start session: boom\n\n"[..];
        assert_eq!(
            find_port(&mut out).await,
            Err(Some("Cannot perform start session: boom".to_owned()))
        );
        let mut empty = &b""[..];
        assert_eq!(find_port(&mut empty).await, Err(None));
    }

    #[test]
    fn puts_the_arguments_in_the_order_of_the_plugin() {
        let parameters = session_parameters("i-0abc", "db.example.internal", 3306);
        assert_eq!(
            plugin_args("ap-northeast-1", "dev", &parameters),
            [
                "AWS_SSM_START_SESSION_RESPONSE",
                "ap-northeast-1",
                "StartSession",
                "dev",
                parameters.as_str(),
                "https://ssm.ap-northeast-1.amazonaws.com",
            ]
        );
    }

    #[test]
    fn writes_the_parameters_the_plugin_reads() {
        let parameters: serde_json::Value =
            serde_json::from_str(&session_parameters("i-0abc", "db\" ; rm -rf /", 3306)).unwrap();
        assert_eq!(parameters["Target"], "i-0abc");
        assert_eq!(
            parameters["DocumentName"],
            "AWS-StartPortForwardingSessionToRemoteHost"
        );
        assert_eq!(parameters["Parameters"]["host"], json!(["db\" ; rm -rf /"]));
        assert_eq!(parameters["Parameters"]["portNumber"], json!(["3306"]));
        assert!(parameters["Parameters"].get("localPortNumber").is_none());
    }

    #[test]
    fn writes_the_response_the_plugin_reads() {
        let response: serde_json::Value = serde_json::from_str(&session_response(
            "s-1",
            "tok",
            "wss://ssmmessages.ap-northeast-1.amazonaws.com/v1/data-channel/s-1",
        ))
        .unwrap();
        assert_eq!(response["SessionId"], "s-1");
        assert_eq!(response["TokenValue"], "tok");
        assert_eq!(
            response["StreamUrl"],
            "wss://ssmmessages.ap-northeast-1.amazonaws.com/v1/data-channel/s-1"
        );
    }

    #[test]
    fn chooses_the_first_online_node() {
        let nodes = [node("i-1", false), node("i-2", true), node("i-3", true)];
        assert_eq!(choose_instance(&nodes), Some("i-2"));
        assert_eq!(choose_instance(&[node("i-1", false)]), None);
        assert_eq!(choose_instance(&[node("", true)]), None);
        assert_eq!(choose_instance(&[]), None);
    }

    #[test]
    fn looks_for_the_plugin_where_the_installers_put_it() {
        assert_eq!(
            plugin_locations(false),
            [
                PathBuf::from("/opt/homebrew/bin/session-manager-plugin"),
                PathBuf::from("/usr/local/bin/session-manager-plugin"),
                PathBuf::from("/usr/local/sessionmanagerplugin/bin/session-manager-plugin"),
                PathBuf::from("session-manager-plugin"),
            ]
        );
        assert_eq!(
            plugin_locations(true).last(),
            Some(&PathBuf::from("session-manager-plugin.exe"))
        );
    }

    #[test]
    fn tells_a_login_that_is_gone_from_the_other_errors() {
        for (code, text) in [
            (Some("ExpiredTokenException"), "service error"),
            (Some("UnrecognizedClientException"), "service error"),
            (Some("InvalidSignatureException"), "service error"),
            (None, "dispatch failure: failed to load credentials: cached Login token is expired"),
            (None, "the credential provider was not enabled: ProfileFile: the profile `dev` could not be found"),
            (None, "Your session has expired. Please reauthenticate."),
            (None, "dispatch failure: other: the credential provider was not enabled: no credentials found in chain"),
        ] {
            assert_eq!(classify(code, text), Failure::AuthExpired, "{code:?} {text}");
        }
        assert_eq!(
            classify(
                Some("AccessDeniedException"),
                "not authorized to perform ssm:StartSession"
            ),
            Failure::Aws("not authorized to perform ssm:StartSession".to_owned())
        );
        assert_eq!(
            classify(None, "dispatch failure: io error"),
            Failure::Aws("dispatch failure: io error".to_owned())
        );
    }

    #[test]
    fn says_each_failure_in_japanese() {
        let auth = Failure::AuthExpired.message();
        assert!(
            auth.contains("認証が切れ") && auth.contains("aws login"),
            "{auth}"
        );
        let bastion = Failure::BastionNotFound("dev-bastion".to_owned()).message();
        assert!(
            bastion.contains("踏み台「dev-bastion」が見つかりません"),
            "{bastion}"
        );
        let plugin = Failure::PluginMissing.message();
        assert!(
            plugin.contains("session-manager-plugin が見つかりません"),
            "{plugin}"
        );
        assert!(Failure::Timeout.message().contains("時間内"));
        assert!(
            Failure::Plugin(Some("Cannot perform start session: x".to_owned()))
                .message()
                .ends_with("Cannot perform start session: x")
        );
        assert!(Failure::Plugin(None).message().contains("ポートを開く前"));
        assert!(Failure::Aws("boom".to_owned()).message().ends_with("boom"));
        let all = [auth, bastion, plugin, Failure::Timeout.message()];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn cuts_a_long_error() {
        let long = "x".repeat(ERROR_MAX + 10);
        let cut = shorten(&long);
        assert_eq!(cut.chars().count(), ERROR_MAX + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(shorten("  short \n"), "short");
    }

    #[tokio::test]
    async fn passes_over_the_places_with_no_plugin() {
        let missing = PathBuf::from("/nonexistent/cookapps-test/session-manager-plugin");
        assert_eq!(
            find_plugin(std::slice::from_ref(&missing)).await,
            Err(Failure::PluginMissing)
        );
        assert_eq!(find_plugin(&[]).await, Err(Failure::PluginMissing));
        #[cfg(unix)]
        assert_eq!(
            find_plugin(&[missing, PathBuf::from("/bin/sh")]).await,
            Ok(PathBuf::from("/bin/sh"))
        );
    }

    /// A shell script that stands for the plugin, in a folder of its own that is deleted at the end.
    #[cfg(unix)]
    struct Fake(PathBuf);

    #[cfg(unix)]
    impl Fake {
        fn new(name: &str, body: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let dir =
                std::env::temp_dir().join(format!("cookapps-ssm-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("session-manager-plugin");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            Self(path)
        }
    }

    #[cfg(unix)]
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn starts_the_plugin_and_reads_its_port() {
        // The port is written only when the arguments and the environment are what the plugin reads.
        let fake = Fake::new(
            "port",
            r#"[ "$1" = AWS_SSM_START_SESSION_RESPONSE ] && [ "$2" = ap-northeast-1 ] && [ "$3" = StartSession ] && [ "$#" = 6 ] && [ "$AWS_SSM_START_SESSION_RESPONSE" = '{"SessionId":"s"}' ] && echo "Starting session" && printf 'Port 41234 opened for sessionId s.' && echo && echo "Waiting for connections..."
sleep 30"#,
        );
        let args = plugin_args("ap-northeast-1", "dev", "{}");
        let (mut child, port) = start_plugin(
            &fake.0,
            &args,
            r#"{"SessionId":"s"}"#,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(port, 41234);
        // Stopping it ends the process.
        child.kill().await.unwrap();
        assert!(child.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_what_the_plugin_said_when_it_ends_without_a_port() {
        let fake = Fake::new("ends", "echo 'Cannot perform start session: boom'");
        let result = start_plugin(&fake.0, &[], "{}", Duration::from_secs(10)).await;
        assert_eq!(
            result.err(),
            Some(Failure::Plugin(Some(
                "Cannot perform start session: boom".to_owned()
            )))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn times_out_and_stops_a_plugin_that_gives_no_port() {
        let fake = Fake::new("silent", "sleep 30");
        let result = start_plugin(&fake.0, &[], "{}", Duration::from_millis(200)).await;
        assert_eq!(result.err(), Some(Failure::Timeout));
    }

    #[tokio::test]
    async fn says_there_is_no_plugin_when_it_cannot_be_started() {
        let result = start_plugin(
            Path::new("/nonexistent/cookapps-test/session-manager-plugin"),
            &[],
            "{}",
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(result.err(), Some(Failure::PluginMissing));
    }

    #[tokio::test]
    async fn closing_a_tunnel_that_is_not_open_is_done() {
        let tunnels = Tunnels::default();
        assert_eq!(tunnels.close(7).await, Ok(()));
        tunnels.close_all().await;
    }
}
