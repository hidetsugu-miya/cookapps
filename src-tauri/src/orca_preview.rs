//! A-31: an HTML file of a worktree on the Orca screen, opened in the default browser. The app serves the files of the worktree from an HTTP server of its own and opens the address of the file (`orca_file_open_in_browser`).
//! The server listens on `127.0.0.1` alone, on a port the OS gives, from the first open until the app ends. An address is `http://127.0.0.1:{port}/{token}/{path from the worktree}`: the token is random, one for each worktree of each target, and held in memory only, so a page of another site that guesses the port still cannot name a file.
//! Only GET and HEAD are answered, only with a `Host` of `127.0.0.1:{port}` (a name that was rebound to this address is refused), and only for a path that A-18 would read (`check_relative`, after the percent escapes are taken out) and that has no part starting with `.` (`.git/config`, `.env`: the script of an opened page could fetch them otherwise). A folder has no list.
//! A file is read as the download of A-22 reads it (`fetch_into`: `files.stat`, `files.readChunk`, never past the size, or `files.readPreview`) and goes to the browser as it is read; nothing of it is kept. A HEAD asks `files.stat` alone.
//! The bytes of a file, a path and a token are in no log line and no file of the app.

use std::{
    collections::HashMap,
    future::Future,
    net::SocketAddr,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

use crate::{
    orca_attach::Rpc,
    orca_files::{cached_host_of, check_relative, fetch_into, host_of, stat_size, Sink, NOT_FOUND},
    orca_link::Connection,
};

/// The address the server listens on: this machine alone.
const LOOPBACK: &str = "127.0.0.1";
/// The most bytes of a request that are read (its first line and its headers).
const MAX_HEAD: usize = 8 * 1024;
/// How long a connection may take to send its request.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the server waits after a failed accept before the next one.
const ACCEPT_PAUSE: Duration = Duration::from_millis(100);
/// The bytes of randomness in a token (32 hex characters).
const TOKEN_BYTES: usize = 16;
/// The headers every answer carries.
const COMMON_HEADERS: &str = "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n";
const NOT_HTML: &str = "HTML のファイルだけをブラウザで開けます";
const NOT_OPENED: &str = "ブラウザで開けません";

// ---- the request ----

/// What is read of a request: the method and the target of its first line, and its `Host` header (`None` when it has none, or more than one).
#[derive(Debug, PartialEq)]
struct Request {
    method: String,
    target: String,
    host: Option<String>,
}

/// The request in `head` (the bytes up to the empty line): a first line of `{method} {target} HTTP/1.x`, then header lines. Anything else is no request.
fn parse_request(head: &str) -> Option<Request> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if first.next().is_some()
        || method.is_empty()
        || target.is_empty()
        || !version.starts_with("HTTP/1.")
    {
        return None;
    }
    let mut hosts = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("host") {
            hosts.push(value.trim());
        }
    }
    let host = match hosts[..] {
        [host] => Some(host.to_owned()),
        _ => None,
    };
    Some(Request {
        method: method.to_owned(),
        target: target.to_owned(),
        host,
    })
}

/// Whether a request was sent to this server by its address: `Host` is exactly `127.0.0.1:{port}`. A page that reached the port through a name of its own (DNS rebinding) sends that name.
fn host_matches(host: Option<&str>, port: u16) -> bool {
    host == Some(format!("{LOOPBACK}:{port}").as_str())
}

/// `text` with its percent escapes taken out, when they are whole and the result is UTF-8.
fn percent_decode(text: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(text.len());
    let mut rest = text.bytes();
    while let Some(byte) = rest.next() {
        if byte == b'%' {
            let high = char::from(rest.next()?).to_digit(16)?;
            let low = char::from(rest.next()?).to_digit(16)?;
            bytes.push(u8::try_from(high * 16 + low).ok()?);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
}

/// `relative` as the path of an address: each byte that is not a letter, a digit, `-`, `.`, `_`, `~` or the `/` between the parts is escaped.
fn percent_encode(relative: &str) -> String {
    let mut encoded = String::with_capacity(relative.len());
    for byte in relative.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Whether a part of `relative` starts with `.` (`.env`, `.git/config`, `a/.b/c`). Such a file is not served, so that the script of an opened page cannot fetch the settings and the secrets a worktree keeps under those names.
fn has_hidden_part(relative: &str) -> bool {
    relative.split('/').any(|part| part.starts_with('.'))
}

/// The token and the path from the worktree that a target names: `/{token}/{path}`, without what follows a `?` or a `#`. The path has its percent escapes taken out and is then held to the checks of A-18 (`check_relative`), so an escaped `..` or `/` is seen as what it is, and to `has_hidden_part`, so an escaped `.` at the start of a part is too.
fn split_target(target: &str) -> Option<(&str, String)> {
    let path = target.split(['?', '#']).next()?;
    let (token, relative) = path.strip_prefix('/')?.split_once('/')?;
    let relative = percent_decode(relative)?;
    check_relative(&relative, false).ok()?;
    if has_hidden_part(&relative) {
        return None;
    }
    Some((token, relative))
}

/// The `Content-Type` of a file, by the extension of its name (the case does not count); a name it does not know is bytes.
fn content_type(relative: &str) -> &'static str {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    let extension = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => extension.to_ascii_lowercase(),
        _ => String::new(),
    };
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// A file to answer with: the worktree the token stands for, the path from it, and whether only the headers are asked for (HEAD).
#[derive(Debug, PartialEq)]
pub(crate) struct Wanted {
    pub(crate) environment: Option<String>,
    pub(crate) path: String,
    pub(crate) relative: String,
    pub(crate) head_only: bool,
}

/// What a request gets: a file, or the status that refuses it. A `Host` that is not this server's is 403 before anything else is looked at, a method other than GET and HEAD is 405, and a token no worktree has, or a path that is not one inside a worktree or has a part starting with `.`, is 404.
fn decide(request: &Request, port: u16, tokens: &Tokens) -> Result<Wanted, u16> {
    if !host_matches(request.host.as_deref(), port) {
        return Err(403);
    }
    let head_only = match request.method.as_str() {
        "GET" => false,
        "HEAD" => true,
        _ => return Err(405),
    };
    let (token, relative) = split_target(&request.target).ok_or(404_u16)?;
    let (environment, path) = tokens.worktree_of(token).ok_or(404_u16)?;
    Ok(Wanted {
        environment,
        path,
        relative,
        head_only,
    })
}

// ---- the answer ----

/// The answer that refuses a request: the status and the common headers, with no body.
fn refusal(status: u16) -> String {
    let (reason, allow) = match status {
        400 => ("Bad Request", ""),
        403 => ("Forbidden", ""),
        405 => ("Method Not Allowed", "Allow: GET, HEAD\r\n"),
        502 => ("Bad Gateway", ""),
        _ => ("Not Found", ""),
    };
    let status = if reason == "Not Found" { 404 } else { status };
    format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\n{allow}{COMMON_HEADERS}\r\n")
}

/// The headers of the answer that carries a file of `total` bytes.
fn file_headers(content_type: &str, total: u64) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {total}\r\n{COMMON_HEADERS}\r\n"
    )
}

/// The answer being written: the headers go out with the first bytes of the file, when its size is known, and the bytes follow as they are read. For a HEAD (one on a host that lacks `files.stat`, which is read for its size) the read stops after the headers.
struct Answer<'a, S> {
    stream: &'a mut S,
    content_type: &'static str,
    head_only: bool,
    started: bool,
}

impl<S: AsyncWrite + Unpin> Sink for Answer<'_, S> {
    async fn put(&mut self, bytes: Vec<u8>, total: u64) -> Result<(), String> {
        // What the browser was told is not said here: the caller answers by `started` alone.
        let closed = |_| String::new();
        if !self.started {
            let headers = file_headers(self.content_type, total);
            self.stream
                .write_all(headers.as_bytes())
                .await
                .map_err(closed)?;
            self.started = true;
        }
        if self.head_only {
            // The size is known and the headers are out: nothing more is read.
            return Err(String::new());
        }
        self.stream.write_all(&bytes).await.map_err(closed)
    }
}

/// Answers a request for the file `relative` of the worktree at `path` on `stream`: the file, read as A-22 reads it, or 404 for a file that is not there and 502 for any other failure of the read. A HEAD is answered from the size `files.stat` gives, and nothing of the file is read; only on a host that lacks `files.stat` is the file read for its size. A read that fails after the headers went out ends the connection short of the length it promised. Answers `Ok` when the headers of the file went out, and the status of the refusal otherwise.
async fn respond<S: AsyncWrite + Unpin>(
    rpc: &mut impl Rpc,
    path: &str,
    relative: &str,
    head_only: bool,
    stream: &mut S,
) -> Result<(), u16> {
    let content_type = content_type(relative);
    let size = if head_only {
        stat_size(rpc, path, relative).await
    } else {
        Ok(None)
    };
    let read = match size {
        Ok(Some(total)) => {
            let headers = file_headers(content_type, total);
            let _ = stream.write_all(headers.as_bytes()).await;
            return Ok(());
        }
        Ok(None) => {
            let mut answer = Answer {
                stream,
                content_type,
                head_only,
                started: false,
            };
            let read = fetch_into(rpc, path, relative, &mut answer).await;
            if answer.started {
                return Ok(());
            }
            read.map(|_| ())
        }
        Err(reason) => Err(reason),
    };
    let status = if read.is_err_and(|reason| reason == NOT_FOUND) {
        404
    } else {
        502
    };
    let _ = stream.write_all(refusal(status).as_bytes()).await;
    Err(status)
}

/// Whether the confirmation of the worktree is dropped after `sent` (what `respond` answered), so that the next request asks the target's list again: after a failed read (502), which a worktree that is gone gives too. A file that is not there (404) says nothing of the worktree, so a page that asks for many such files keeps the confirmation.
fn drops_confirmation(sent: Result<(), u16>) -> bool {
    sent == Err(502)
}

// ---- the tokens ----

/// The tokens of the worktrees that were opened, in memory only: one for each path of each target (`None`: this machine, else the name of a saved environment).
#[derive(Default)]
struct Tokens {
    by_worktree: HashMap<(Option<String>, String), String>,
    by_token: HashMap<String, (Option<String>, String)>,
}

impl Tokens {
    /// The token of the worktree at `path` of the target: the one it has, or `fresh` when it has none yet.
    fn token_for(&mut self, environment: Option<&str>, path: &str, fresh: String) -> String {
        let worktree = (environment.map(str::to_owned), path.to_owned());
        if let Some(token) = self.by_worktree.get(&worktree) {
            return token.clone();
        }
        self.by_token.insert(fresh.clone(), worktree.clone());
        self.by_worktree.insert(worktree, fresh.clone());
        fresh
    }

    /// The target and the path of the worktree `token` stands for.
    fn worktree_of(&self, token: &str) -> Option<(Option<String>, String)> {
        self.by_token.get(token).cloned()
    }
}

/// A new token: random bytes of the OS, in hex.
fn new_token() -> Result<String, String> {
    let mut random = [0_u8; TOKEN_BYTES];
    getrandom::fill(&mut random).map_err(|_| "乱数を作れません".to_owned())?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}

// ---- the server ----

/// The server that runs: the address its listener is bound to and the tokens it answers to.
struct Preview {
    address: SocketAddr,
    tokens: Mutex<Tokens>,
}

impl Preview {
    fn port(&self) -> u16 {
        self.address.port()
    }

    fn tokens(&self) -> std::sync::MutexGuard<'_, Tokens> {
        self.tokens.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The address of the file `relative` of the worktree `token` stands for.
    fn url(&self, token: &str, relative: &str) -> String {
        format!(
            "http://{LOOPBACK}:{}/{token}/{}",
            self.port(),
            percent_encode(relative)
        )
    }
}

/// The Orca a file is read from, so that the server is the same code for a unit test and for the real connection.
trait Orca: Send + Sync + 'static {
    /// Answers `wanted` on `stream`, with the file or with a refusal.
    fn send(&self, wanted: Wanted, stream: &mut TcpStream) -> impl Future<Output = ()> + Send;
}

/// The real Orca: the worktree is confirmed as a read of A-18 confirms it (the target's list, believed for a while; an SSH host and a worktree that left the list are refused), then the file is read over a connection of its own.
struct Live;

impl Orca for Live {
    async fn send(&self, wanted: Wanted, stream: &mut TcpStream) {
        let environment = wanted.environment.as_deref();
        if cached_host_of(&wanted.path, environment).await.is_err() {
            let _ = stream.write_all(refusal(404).as_bytes()).await;
            return;
        }
        let sent = match Connection::open(wanted.environment.clone()).await {
            Ok(mut connection) => {
                respond(
                    &mut connection,
                    &wanted.path,
                    &wanted.relative,
                    wanted.head_only,
                    stream,
                )
                .await
            }
            Err(_) => {
                let _ = stream.write_all(refusal(502).as_bytes()).await;
                Err(502)
            }
        };
        if drops_confirmation(sent) {
            crate::orca::forget_worktree_host(&wanted.path, environment);
        }
    }
}

/// The first line and the headers of the request on `stream`, up to the empty line; `None` when the connection ends first, sends more than `MAX_HEAD` bytes before it, or sends bytes that are not UTF-8.
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        head.extend_from_slice(&buffer[..read]);
        let end = head.windows(4).position(|w| w == b"\r\n\r\n");
        if end.unwrap_or(head.len()) > MAX_HEAD {
            return None;
        }
        if let Some(end) = end {
            head.truncate(end);
            return String::from_utf8(head).ok();
        }
    }
}

/// One connection: one request, one answer, and the connection is closed.
async fn connection(mut stream: TcpStream, preview: Arc<Preview>, orca: Arc<impl Orca>) {
    let head = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut stream)).await;
    let request = head.ok().flatten().as_deref().and_then(parse_request);
    let decided = match &request {
        Some(request) => decide(request, preview.port(), &preview.tokens()),
        None => Err(400),
    };
    match decided {
        Ok(wanted) => orca.send(wanted, &mut stream).await,
        Err(status) => {
            let _ = stream.write_all(refusal(status).as_bytes()).await;
        }
    }
    let _ = stream.shutdown().await;
}

/// Answers the connections of `listener` for as long as the app runs, each on a task of its own.
async fn serve(listener: TcpListener, preview: Arc<Preview>, orca: Arc<impl Orca>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(connection(stream, Arc::clone(&preview), Arc::clone(&orca)));
            }
            Err(_) => tokio::time::sleep(ACCEPT_PAUSE).await,
        }
    }
}

/// Starts a server on a port the OS gives, on `127.0.0.1` alone.
async fn start(orca: impl Orca) -> Result<Arc<Preview>, String> {
    let failed = |_| "プレビューのサーバーを始められません".to_owned();
    let listener = TcpListener::bind((LOOPBACK, 0)).await.map_err(failed)?;
    let address = listener.local_addr().map_err(failed)?;
    let preview = Arc::new(Preview {
        address,
        tokens: Mutex::default(),
    });
    tokio::spawn(serve(listener, Arc::clone(&preview), Arc::new(orca)));
    Ok(preview)
}

/// The app's one server, started at the first open and running until the app ends.
async fn server() -> Result<Arc<Preview>, String> {
    static SERVER: tokio::sync::OnceCell<Arc<Preview>> = tokio::sync::OnceCell::const_new();
    SERVER.get_or_try_init(|| start(Live)).await.map(Arc::clone)
}

// ---- the command ----

/// The path of a file the browser is opened on: a path inside the worktree (the checks of A-18) whose name ends with `.html`, whatever the case, and that has no part starting with `.` (the server would answer it 404).
fn check_html(relative: &str) -> Result<(), String> {
    check_relative(relative, false)?;
    let name = relative.rsplit('/').next().unwrap_or(relative);
    if name.to_ascii_lowercase().ends_with(".html") && !has_hidden_part(relative) {
        Ok(())
    } else {
        Err(NOT_HTML.into())
    }
}

/// Opens the HTML file `relative` of the worktree at `path` in the default browser (A-31): the worktree is checked against the target's list read just now (an SSH host is refused), the server is started when it does not run yet, and the address of the file is handed to the system. The address, which holds the token, is not returned, logged or put in an error.
#[tauri::command]
pub async fn orca_file_open_in_browser(
    app: AppHandle,
    path: String,
    relative: String,
    environment: Option<String>,
) -> Result<(), String> {
    check_html(&relative)?;
    host_of(&path, environment.as_deref()).await?;
    let preview = server().await?;
    let token = preview
        .tokens()
        .token_for(environment.as_deref(), &path, new_token()?);
    app.opener()
        .open_url(preview.url(&token, &relative), None::<&str>)
        .map_err(|_| NOT_OPENED.to_owned())
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddr};

    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::{json, Value};

    use super::*;
    use crate::orca_link::CallError;

    fn request(method: &str, target: &str, host: Option<&str>) -> Request {
        Request {
            method: method.into(),
            target: target.into(),
            host: host.map(str::to_owned),
        }
    }

    fn tokens() -> Tokens {
        let mut tokens = Tokens::default();
        tokens.token_for(None, "/w/app", "tok".into());
        tokens
    }

    #[test]
    fn a_request_is_its_first_line_and_its_host() {
        assert_eq!(
            parse_request("GET /tok/a.html HTTP/1.1\r\nUser-Agent: x\r\nhOsT:  127.0.0.1:80 "),
            Some(request("GET", "/tok/a.html", Some("127.0.0.1:80")))
        );
        assert_eq!(
            parse_request("HEAD / HTTP/1.0"),
            Some(request("HEAD", "/", None))
        );
        // Two Host headers name no one host.
        assert_eq!(
            parse_request("GET / HTTP/1.1\r\nHost: a\r\nHost: b"),
            Some(request("GET", "/", None))
        );
        for bad in [
            "",
            "GET",
            "GET /",
            "GET / HTTP/2",
            "GET  / HTTP/1.1",
            "GET / HTTP/1.1 x",
            "GET / FTP/1.1",
            " / HTTP/1.1",
            "GET / HTTP/1.1\r\nno colon",
        ] {
            assert_eq!(parse_request(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_this_servers_address_is_its_host() {
        assert!(host_matches(Some("127.0.0.1:4100"), 4100));
        for bad in [
            None,
            Some("127.0.0.1"),
            Some("127.0.0.1:4101"),
            Some("localhost:4100"),
            Some("evil.example:4100"),
            Some("127.0.0.1:4100.evil.example"),
            Some(""),
        ] {
            assert!(!host_matches(bad, 4100), "{bad:?}");
        }
    }

    #[test]
    fn percent_escapes_are_taken_out_and_put_in() {
        assert_eq!(
            percent_decode("a%20b/%E3%81%82.html").unwrap(),
            "a b/あ.html"
        );
        assert_eq!(percent_decode("plain").unwrap(), "plain");
        assert_eq!(percent_decode("%2e%2E").unwrap(), "..");
        for bad in ["%", "%2", "%zz", "a%2", "%FF", "%E3%81"] {
            assert_eq!(percent_decode(bad), None, "{bad:?}");
        }
        assert_eq!(percent_encode("a b/あ.html"), "a%20b/%E3%81%82.html");
        assert_eq!(percent_encode("A-z_0.9~/x"), "A-z_0.9~/x");
        assert_eq!(percent_encode("a?b#c%d"), "a%3Fb%23c%25d");
        let odd = "docs/50% off & more?.html";
        assert_eq!(percent_decode(&percent_encode(odd)).unwrap(), odd);
    }

    #[test]
    fn a_target_is_a_token_and_a_path_inside_the_worktree() {
        assert_eq!(
            split_target("/tok/docs/a%20b.html?x=1#top"),
            Some(("tok", "docs/a b.html".to_owned()))
        );
        for bad in [
            "",
            "/",
            "/tok",
            "/tok/",
            "tok/a.html",
            "/tok/../a.html",
            "/tok/%2e%2e/a.html",
            "/tok/a/./b.html",
            "/tok/a//b.html",
            "/tok/%2Fetc/passwd",
            "/tok/a%00.html",
            "/tok/a%0A.html",
            "/tok/docs/",
            "/tok/%zz.html",
            "http://127.0.0.1/tok/a.html",
        ] {
            assert_eq!(split_target(bad), None, "{bad:?}");
        }
        // A part that starts with `.` is not served, escaped or not.
        for hidden in [
            "/tok/.env",
            "/tok/.git/config",
            "/tok/.npmrc",
            "/tok/a/.b/c",
            "/tok/docs/.a.html",
            "/tok/%2Egit/config",
            "/tok/a/%2eb/c.html",
        ] {
            assert_eq!(split_target(hidden), None, "{hidden:?}");
        }
        assert_eq!(
            split_target("/tok/a.b/c.d.html"),
            Some(("tok", "a.b/c.d.html".to_owned()))
        );
    }

    #[test]
    fn the_content_type_is_the_extensions() {
        for (name, kind) in [
            ("a.html", "text/html; charset=utf-8"),
            ("docs/A.HTM", "text/html; charset=utf-8"),
            ("a.css", "text/css; charset=utf-8"),
            ("a.js", "text/javascript; charset=utf-8"),
            ("a.mjs", "text/javascript; charset=utf-8"),
            ("a.json", "application/json"),
            ("a.js.map", "application/json"),
            ("a.svg", "image/svg+xml"),
            ("a.PNG", "image/png"),
            ("a.jpg", "image/jpeg"),
            ("a.jpeg", "image/jpeg"),
            ("a.gif", "image/gif"),
            ("a.webp", "image/webp"),
            ("a.avif", "image/avif"),
            ("a.ico", "image/x-icon"),
            ("a.txt", "text/plain; charset=utf-8"),
            ("a.md", "text/plain; charset=utf-8"),
            ("a.xml", "application/xml"),
            ("a.pdf", "application/pdf"),
            ("a.wasm", "application/wasm"),
            ("a.woff", "font/woff"),
            ("a.woff2", "font/woff2"),
            ("a.ttf", "font/ttf"),
            ("a.otf", "font/otf"),
            ("a.mp4", "video/mp4"),
            ("a.webm", "video/webm"),
            ("a.mp3", "audio/mpeg"),
            ("a.wav", "audio/wav"),
            ("a.bin", "application/octet-stream"),
            ("Makefile", "application/octet-stream"),
            ("a.html/readme", "application/octet-stream"),
            (".html", "application/octet-stream"),
        ] {
            assert_eq!(content_type(name), kind, "{name}");
        }
    }

    #[test]
    fn a_request_is_decided_by_host_then_method_then_token_and_path() {
        let tokens = tokens();
        let host = Some("127.0.0.1:4100");
        assert_eq!(
            decide(&request("GET", "/tok/a.html", host), 4100, &tokens),
            Ok(Wanted {
                environment: None,
                path: "/w/app".into(),
                relative: "a.html".into(),
                head_only: false,
            })
        );
        assert!(
            decide(&request("HEAD", "/tok/img/a.png", host), 4100, &tokens)
                .unwrap()
                .head_only
        );
        // The host is looked at first, so a stranger learns nothing of a token or a method.
        assert_eq!(
            decide(
                &request("POST", "/no/a.html", Some("evil:4100")),
                4100,
                &tokens
            ),
            Err(403)
        );
        assert_eq!(
            decide(&request("GET", "/tok/a.html", None), 4100, &tokens),
            Err(403)
        );
        for method in ["POST", "PUT", "DELETE", "OPTIONS", "get"] {
            assert_eq!(
                decide(&request(method, "/tok/a.html", host), 4100, &tokens),
                Err(405),
                "{method}"
            );
        }
        for target in [
            "/other/a.html",
            "/tok/../a.html",
            "/tok/",
            "/",
            "/tok/.env",
            "/tok/.git/config",
        ] {
            assert_eq!(
                decide(&request("GET", target, host), 4100, &tokens),
                Err(404),
                "{target}"
            );
        }
    }

    #[test]
    fn a_worktree_keeps_its_token_and_each_has_its_own() {
        let mut tokens = Tokens::default();
        assert_eq!(tokens.token_for(None, "/w/a", "one".into()), "one");
        assert_eq!(tokens.token_for(None, "/w/a", "two".into()), "one");
        assert_eq!(
            tokens.token_for(Some("srv"), "/w/a", "three".into()),
            "three"
        );
        assert_eq!(tokens.token_for(None, "/w/b", "four".into()), "four");
        assert_eq!(tokens.worktree_of("one"), Some((None, "/w/a".into())));
        assert_eq!(
            tokens.worktree_of("three"),
            Some((Some("srv".into()), "/w/a".into()))
        );
        // A token that was not kept stands for nothing.
        assert_eq!(tokens.worktree_of("two"), None);
        assert_eq!(tokens.worktree_of(""), None);
    }

    #[test]
    fn a_new_token_is_random_hex() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), TOKEN_BYTES * 2);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn only_an_html_file_inside_the_worktree_is_opened() {
        for good in ["a.html", "docs/Report.HTML", "a b/あ.Html", "a.b/c.d.html"] {
            assert_eq!(check_html(good), Ok(()), "{good}");
        }
        for bad in ["a.htm", "a.html.txt", "html", "a.md", "docs/a.html/x.js"] {
            assert_eq!(check_html(bad), Err(NOT_HTML.into()), "{bad}");
        }
        // A part that starts with `.` would be answered 404, so it is not opened.
        for hidden in [".html", ".a.html", ".git/a.html", "a/.b/c.html"] {
            assert_eq!(check_html(hidden), Err(NOT_HTML.into()), "{hidden}");
        }
        for bad in ["", "../a.html", "/a.html", "a//b.html", "a/./b.html"] {
            assert!(check_html(bad).is_err_and(|e| e != NOT_HTML), "{bad:?}");
        }
    }

    #[test]
    fn the_address_holds_the_port_the_token_and_the_escaped_path() {
        let preview = Preview {
            address: SocketAddr::from((Ipv4Addr::LOCALHOST, 4100)),
            tokens: Mutex::default(),
        };
        assert_eq!(
            preview.url("tok", "docs/a b.html"),
            "http://127.0.0.1:4100/tok/docs/a%20b.html"
        );
    }

    #[test]
    fn a_refusal_has_the_common_headers_and_no_body() {
        for (status, line) in [
            (400, "HTTP/1.1 400 Bad Request\r\n"),
            (403, "HTTP/1.1 403 Forbidden\r\n"),
            (404, "HTTP/1.1 404 Not Found\r\n"),
            (405, "HTTP/1.1 405 Method Not Allowed\r\n"),
            (502, "HTTP/1.1 502 Bad Gateway\r\n"),
            (500, "HTTP/1.1 404 Not Found\r\n"),
        ] {
            let text = refusal(status);
            assert!(text.starts_with(line), "{text}");
            assert!(text.contains("Content-Length: 0\r\n"));
            assert!(text.contains(COMMON_HEADERS));
            assert!(text.ends_with("\r\n\r\n"));
            assert_eq!(text.contains("Allow: GET, HEAD\r\n"), status == 405);
        }
    }

    // ---- the round trips ----

    /// Orca's side of the calls: the files of the one worktree it has, and the calls it was given.
    struct Fake {
        files: HashMap<&'static str, Vec<u8>>,
        /// The chunk (counted from 0) whose read fails, if any.
        fail_on_chunk: Option<usize>,
        has_stat: bool,
        has_chunks: bool,
        chunks: usize,
        calls: Arc<Mutex<Vec<(String, Value)>>>,
    }

    impl Rpc for Fake {
        async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_owned(), params.clone()));
            let failed = |shown: &str, detail: &str| CallError {
                shown: shown.into(),
                detail: detail.into(),
            };
            let name = params["relativePath"].as_str().unwrap_or_default();
            let Some(file) = self.files.get(name) else {
                return Err(failed("Orca がエラーを返しました", "ENOENT: no such file"));
            };
            match method {
                "files.stat" if !self.has_stat => Err(failed(
                    "Orca がエラーを返しました（method_not_found）",
                    "Unknown method: files.stat",
                )),
                "files.stat" => Ok(json!({"size": file.len()})),
                "files.readChunk" if !self.has_chunks => Err(failed(
                    "Orca がエラーを返しました（method_not_found）",
                    "Unknown method: files.readChunk",
                )),
                "files.readChunk" => {
                    self.chunks += 1;
                    if self.fail_on_chunk == Some(self.chunks - 1) {
                        return Err(failed("Orca に接続できません", ""));
                    }
                    let offset = usize::try_from(params["offset"].as_u64().unwrap()).unwrap();
                    let length = usize::try_from(params["length"].as_u64().unwrap()).unwrap();
                    let end = (offset + length).min(file.len());
                    let bytes = &file[offset.min(file.len())..end];
                    Ok(json!({
                        "contentBase64": STANDARD.encode(bytes),
                        "bytesRead": bytes.len(),
                        "eof": end >= file.len(),
                    }))
                }
                "files.readPreview" => Ok(json!({
                    "content": String::from_utf8(file.clone()).unwrap(),
                    "isBinary": false,
                })),
                _ => Err(failed("no answer", "")),
            }
        }
    }

    /// The target and the path of a worktree that was asked for.
    type Worktree = (Option<String>, String);

    /// The Orca of a test server: every request reads from a new `Fake` with these files.
    #[derive(Default)]
    struct FakeOrca {
        files: HashMap<&'static str, Vec<u8>>,
        fail_on_chunk: Option<usize>,
        no_stat: bool,
        no_chunks: bool,
        calls: Arc<Mutex<Vec<(String, Value)>>>,
        asked: Arc<Mutex<Vec<Worktree>>>,
    }

    impl FakeOrca {
        /// Orca's side of one request.
        fn rpc(&self) -> Fake {
            Fake {
                files: self.files.clone(),
                fail_on_chunk: self.fail_on_chunk,
                has_stat: !self.no_stat,
                has_chunks: !self.no_chunks,
                chunks: 0,
                calls: Arc::clone(&self.calls),
            }
        }
    }

    impl Orca for FakeOrca {
        async fn send(&self, wanted: Wanted, stream: &mut TcpStream) {
            self.asked
                .lock()
                .unwrap()
                .push((wanted.environment.clone(), wanted.path.clone()));
            let mut rpc = self.rpc();
            let _ = respond(
                &mut rpc,
                &wanted.path,
                &wanted.relative,
                wanted.head_only,
                stream,
            )
            .await;
        }
    }

    const PAGE: &[u8] = b"<!doctype html><title>a</title>";

    fn orca() -> FakeOrca {
        FakeOrca {
            files: HashMap::from([
                ("index.html", PAGE.to_vec()),
                ("img/a b.png", vec![0x89, b'P', b'N', b'G', 0, 255]),
                ("empty.css", Vec::new()),
            ]),
            ..FakeOrca::default()
        }
    }

    /// A server over `orca` with the worktree `/w/app` of this machine under the token `tok`.
    async fn serving(orca: FakeOrca) -> Arc<Preview> {
        let preview = start(orca).await.unwrap();
        preview.tokens().token_for(None, "/w/app", "tok".into());
        preview
    }

    /// Sends `request` (the port of the server stands for `{port}`) and answers the status line, the headers and the body.
    async fn exchange(preview: &Preview, request: &str) -> (String, String, Vec<u8>) {
        let mut stream = TcpStream::connect(preview.address).await.unwrap();
        let request = request.replace("{port}", &preview.port().to_string());
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        let _ = stream.read_to_end(&mut answer).await;
        let end = answer
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("an answer with headers");
        let head = String::from_utf8(answer[..end].to_vec()).unwrap();
        let (status, headers) = head.split_once("\r\n").unwrap();
        (
            status.to_owned(),
            format!("{headers}\r\n"),
            answer[end + 4..].to_vec(),
        )
    }

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{{port}}\r\n\r\n")
    }

    #[tokio::test]
    async fn a_file_of_the_worktree_is_served_with_its_headers() {
        let orca = orca();
        let (calls, asked) = (Arc::clone(&orca.calls), Arc::clone(&orca.asked));
        let preview = serving(orca).await;
        let (status, headers, body) = exchange(&preview, &get("/tok/index.html")).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(body, PAGE);
        assert!(headers.contains("Content-Type: text/html; charset=utf-8\r\n"));
        assert!(headers.contains(&format!("Content-Length: {}\r\n", PAGE.len())));
        assert!(headers.contains("Cache-Control: no-store\r\n"));
        assert!(headers.contains("X-Content-Type-Options: nosniff\r\n"));
        assert!(headers.contains("Referrer-Policy: no-referrer\r\n"));
        assert!(headers.contains("Connection: close\r\n"));
        assert_eq!(*asked.lock().unwrap(), [(None, "/w/app".to_owned())]);
        // The file is read as a download reads it, in the worktree the token stands for.
        let calls = calls.lock().unwrap();
        let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(methods, ["files.stat", "files.readChunk"]);
        assert!(calls
            .iter()
            .all(|(_, p)| p["worktree"] == "path:/w/app" && p["relativePath"] == "index.html"));
    }

    #[tokio::test]
    async fn a_file_beside_the_page_is_served_by_its_escaped_path() {
        let preview = serving(orca()).await;
        let (status, headers, body) = exchange(&preview, &get("/tok/img/a%20b.png?v=1")).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(body, [0x89, b'P', b'N', b'G', 0, 255]);
        assert!(headers.contains("Content-Type: image/png\r\n"));
        let (status, headers, body) = exchange(&preview, &get("/tok/empty.css")).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(headers.contains("Content-Length: 0\r\n"));
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn a_head_gets_the_headers_and_no_body() {
        let orca = orca();
        let calls = Arc::clone(&orca.calls);
        let preview = serving(orca).await;
        let request = "HEAD /tok/index.html HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n";
        let (status, headers, body) = exchange(&preview, request).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(headers.contains(&format!("Content-Length: {}\r\n", PAGE.len())));
        assert!(headers.contains("Content-Type: text/html; charset=utf-8\r\n"));
        assert!(body.is_empty());
        // The size is all that is asked of Orca: nothing of the file is read.
        let calls = calls.lock().unwrap();
        let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(methods, ["files.stat"]);
    }

    #[tokio::test]
    async fn a_head_on_an_orca_without_stat_reads_the_file_for_its_size() {
        let orca = FakeOrca {
            no_stat: true,
            ..orca()
        };
        let calls = Arc::clone(&orca.calls);
        let preview = serving(orca).await;
        let request = "HEAD /tok/index.html HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n";
        let (status, headers, body) = exchange(&preview, request).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(headers.contains(&format!("Content-Length: {}\r\n", PAGE.len())));
        assert!(body.is_empty());
        let calls = calls.lock().unwrap();
        let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(methods, ["files.stat", "files.stat", "files.readPreview"]);
    }

    #[tokio::test]
    async fn a_head_for_a_file_that_is_not_there_is_not_found() {
        let preview = serving(orca()).await;
        let request = "HEAD /tok/gone.html HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n";
        let (status, _, body) = exchange(&preview, request).await;
        assert_eq!(status, "HTTP/1.1 404 Not Found");
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn the_worktree_stays_confirmed_after_a_file_that_is_not_there() {
        let plain = orca();
        for head_only in [false, true] {
            let mut out = Vec::new();
            let sent = respond(&mut plain.rpc(), "/w/app", "gone.html", head_only, &mut out).await;
            assert_eq!(sent, Err(404));
            assert!(!drops_confirmation(sent));
            assert!(out.starts_with(b"HTTP/1.1 404 Not Found\r\n"));
        }
        // A read that fails another way may mean the worktree is gone: it is confirmed again.
        let failing = FakeOrca {
            fail_on_chunk: Some(0),
            ..plain
        };
        let mut out = Vec::new();
        let sent = respond(&mut failing.rpc(), "/w/app", "index.html", false, &mut out).await;
        assert_eq!(sent, Err(502));
        assert!(drops_confirmation(sent));
        // A file that went out keeps it.
        let mut out = Vec::new();
        let sent = respond(&mut orca().rpc(), "/w/app", "index.html", false, &mut out).await;
        assert_eq!(sent, Ok(()));
        assert!(!drops_confirmation(sent));
    }

    #[tokio::test]
    async fn a_path_with_a_hidden_part_is_not_found_and_orca_is_not_asked() {
        let mut orca = orca();
        orca.files.insert(".env", b"SECRET=1".to_vec());
        orca.files.insert(".git/config", b"[core]".to_vec());
        let asked = Arc::clone(&orca.asked);
        let preview = serving(orca).await;
        for target in [
            "/tok/.env",
            "/tok/%2Eenv",
            "/tok/.git/config",
            "/tok/img/.a.png",
        ] {
            let (status, _, body) = exchange(&preview, &get(target)).await;
            assert_eq!(status, "HTTP/1.1 404 Not Found", "{target}");
            assert!(body.is_empty());
        }
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_wrong_token_is_not_found_and_orca_is_not_asked() {
        let orca = orca();
        let asked = Arc::clone(&orca.asked);
        let preview = serving(orca).await;
        for target in ["/nope/index.html", "/index.html", "/tok", "/"] {
            let (status, headers, body) = exchange(&preview, &get(target)).await;
            assert_eq!(status, "HTTP/1.1 404 Not Found", "{target}");
            assert!(headers.contains(COMMON_HEADERS));
            assert!(body.is_empty());
        }
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_path_out_of_the_worktree_is_not_found_and_orca_is_not_asked() {
        let orca = orca();
        let asked = Arc::clone(&orca.asked);
        let preview = serving(orca).await;
        for target in [
            "/tok/../index.html",
            "/tok/%2e%2e/index.html",
            "/tok/%2E%2E%2Fetc/passwd",
            "/tok/%2Fetc/passwd",
            "/tok/img/",
            "/tok/",
            "/tok/a%00.html",
        ] {
            let (status, _, body) = exchange(&preview, &get(target)).await;
            assert_eq!(status, "HTTP/1.1 404 Not Found", "{target}");
            assert!(body.is_empty());
        }
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_method_other_than_get_and_head_is_refused() {
        let orca = orca();
        let asked = Arc::clone(&orca.asked);
        let preview = serving(orca).await;
        for method in ["POST", "PUT", "DELETE", "OPTIONS"] {
            let request =
                format!("{method} /tok/index.html HTTP/1.1\r\nHost: 127.0.0.1:{{port}}\r\n\r\n");
            let (status, headers, body) = exchange(&preview, &request).await;
            assert_eq!(status, "HTTP/1.1 405 Method Not Allowed", "{method}");
            assert!(headers.contains("Allow: GET, HEAD\r\n"));
            assert!(body.is_empty());
        }
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_host_that_is_not_the_servers_address_is_refused() {
        let orca = orca();
        let asked = Arc::clone(&orca.asked);
        let preview = serving(orca).await;
        for host in [
            "Host: localhost:{port}\r\n",
            "Host: evil.example\r\n",
            "Host: 127.0.0.1\r\n",
            "Host: 127.0.0.1:{port}\r\nHost: 127.0.0.1:{port}\r\n",
            "",
        ] {
            let request = format!("GET /tok/index.html HTTP/1.1\r\n{host}\r\n");
            let (status, _, body) = exchange(&preview, &request).await;
            assert_eq!(status, "HTTP/1.1 403 Forbidden", "{host:?}");
            assert!(body.is_empty());
        }
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn what_is_no_request_is_refused() {
        let preview = serving(orca()).await;
        let (status, _, _) = exchange(&preview, "hello\r\n\r\n").await;
        assert_eq!(status, "HTTP/1.1 400 Bad Request");
        let long = format!(
            "GET /tok/index.html HTTP/1.1\r\nX: {}\r\n\r\n",
            "a".repeat(MAX_HEAD)
        );
        let (status, _, _) = exchange(&preview, &long).await;
        assert_eq!(status, "HTTP/1.1 400 Bad Request");
    }

    #[tokio::test]
    async fn a_file_that_is_not_there_is_not_found() {
        let preview = serving(orca()).await;
        let (status, headers, body) = exchange(&preview, &get("/tok/gone.html")).await;
        assert_eq!(status, "HTTP/1.1 404 Not Found");
        assert!(headers.contains(COMMON_HEADERS));
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn a_read_that_fails_before_the_first_byte_is_a_bad_gateway() {
        let preview = serving(FakeOrca {
            fail_on_chunk: Some(0),
            ..orca()
        })
        .await;
        let (status, _, body) = exchange(&preview, &get("/tok/index.html")).await;
        assert_eq!(status, "HTTP/1.1 502 Bad Gateway");
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn a_read_that_fails_midway_ends_short_of_the_length() {
        let large = vec![b'x'; 400 * 1024];
        let mut orca = orca();
        orca.files.insert("large.js", large.clone());
        orca.fail_on_chunk = Some(1);
        let preview = serving(orca).await;
        let (status, headers, body) = exchange(&preview, &get("/tok/large.js")).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(headers.contains(&format!("Content-Length: {}\r\n", large.len())));
        assert!(body.len() < large.len());
        assert_eq!(body, large[..body.len()]);
    }

    #[tokio::test]
    async fn a_file_of_several_chunks_is_served_whole() {
        let large: Vec<u8> = (0..900 * 1024).map(|n| (n % 251) as u8).collect();
        let mut orca = orca();
        orca.files.insert("large.js", large.clone());
        let preview = serving(orca).await;
        let (status, headers, body) = exchange(&preview, &get("/tok/large.js")).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(headers.contains(&format!("Content-Length: {}\r\n", large.len())));
        assert_eq!(body, large);
    }

    #[tokio::test]
    async fn an_orca_without_chunks_is_read_by_the_preview() {
        let preview = serving(FakeOrca {
            no_chunks: true,
            ..orca()
        })
        .await;
        let (status, headers, body) = exchange(&preview, &get("/tok/index.html")).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(headers.contains(&format!("Content-Length: {}\r\n", PAGE.len())));
        assert_eq!(body, PAGE);
    }

    #[tokio::test]
    async fn the_server_listens_on_this_machine_alone() {
        let preview = serving(orca()).await;
        assert_eq!(preview.address.ip(), Ipv4Addr::LOCALHOST);
        assert_ne!(preview.port(), 0);
    }
}
