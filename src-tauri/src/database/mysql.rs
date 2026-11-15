//! The connection to a MySQL server (D-2, #631): the one function that opens a session, and the error told in words.
//!
//! `connect` is what the connection test and the later screens of the database (tables, records, SQL) open a session with.
//! The session is made read only at once (`SET SESSION TRANSACTION READ ONLY`), so that MySQL itself refuses a write.
//! TLS is the one the app already has (rustls with `aws_lc_rs`, the feature `tls-rustls-aws-lc-rs` of sqlx): it is used when the server offers it (`MySqlSslMode::Preferred`),
//! which is also what carries the password of `caching_sha2_password`; the RSA path of sqlx (the crate `rsa`) is not built in.
//! A connection that goes over a network (no tunnel, and a host that is not the machine itself) requires TLS (`MySqlSslMode::Required`, `ssl_mode_of`), so that nobody on the way can make it fall back to plain text; the certificate is not verified in either mode.
//! The time zone and the `sql_mode` of the session are the server's own: sqlx's defaults (`time_zone='+00:00'`, `PIPES_AS_CONCAT`) are turned off, so a TIMESTAMP and `NOW()` read as any other client reads them and `||` is OR.
//! The decisions (what an error of sqlx or of the server is, and what the screen is told for it) are pure functions.
//! A tunnel that opened while MySQL does not answer (the bastion does not reach the DB) is a failure of its own and never reads as a refused login.

use std::time::Duration;

use sqlx::{
    mysql::{MySqlConnectOptions, MySqlConnection, MySqlDatabaseError, MySqlSslMode},
    ConnectOptions, Connection, Executor,
};

use super::ssm::shorten;

/// From the start of the connection to the answer of the first query, TLS and login included.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const READ_ONLY: &str = "SET SESSION TRANSACTION READ ONLY";

/// Where the MySQL server is reached. `tunneled` is true when `host` and `port` are the local end of a tunnel, which changes what a failure is told as.
#[derive(Clone, Debug, PartialEq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub tunneled: bool,
}

/// Why a session could not be opened. `message` (with the endpoint) is what the screen shows.
#[derive(Debug, PartialEq)]
enum Failure {
    /// The connection came and went with no MySQL talking: the end of the stream, a reset.
    NoAnswer,
    Timeout,
    Refused,
    /// MySQL refused the user name or the password (1045, 1044, 1698).
    Auth(String),
    /// MySQL does not let this client's host in (1129, 1130).
    HostNotAllowed(String),
    /// The password of `caching_sha2_password` needs TLS, and the server offers none.
    NeedsTls,
    Tls(String),
    Server {
        number: u16,
        message: String,
    },
    Other(String),
}

impl Failure {
    fn message(&self, endpoint: &Endpoint) -> String {
        let at = format!("{}:{}", endpoint.host, endpoint.port);
        match self {
            Self::NoAnswer | Self::Refused if endpoint.tunneled => TUNNEL_SILENT.to_owned(),
            Self::Timeout if endpoint.tunneled => TUNNEL_SILENT.to_owned(),
            Self::NoAnswer => format!("{at} の MySQL が応えません"),
            Self::Refused => format!("{at} が接続を拒否しました。ホストとポートを確かめてください"),
            Self::Timeout => format!("{at} への接続が時間内に終わりませんでした"),
            Self::Auth(text) => format!(
                "MySQL へのログインに失敗しました。ユーザー名とパスワードを確かめてください: {}",
                shorten(text)
            ),
            Self::HostNotAllowed(text) => format!(
                "MySQL が、この接続元からのログインを許していません: {}",
                shorten(text)
            ),
            Self::NeedsTls => "このユーザーの認証 (caching_sha2_password) には TLS が要りますが、サーバーが TLS を使えません".to_owned(),
            Self::Tls(text) => format!("TLS の接続に失敗しました: {}", shorten(text)),
            Self::Server { number, message } => {
                format!("MySQL がエラーを返しました ({number}): {}", shorten(message))
            }
            Self::Other(text) => format!("MySQL への接続に失敗しました: {}", shorten(text)),
        }
    }
}

/// The tunnel is open and nothing of MySQL comes through it: the bastion does not reach the DB host and port (the security group of the DB does not let the bastion in, or the host is wrong).
const TUNNEL_SILENT: &str = "トンネルは開きましたが、MySQL が応えません。踏み台から DB のホストとポートに届くか（DB のセキュリティグループが踏み台からの接続を許しているか）を確かめてください";

/// What an error that MySQL answered (its number and message) is.
fn from_server(number: u16, message: &str) -> Failure {
    match number {
        1044 | 1045 | 1698 => Failure::Auth(message.to_owned()),
        1129 | 1130 => Failure::HostNotAllowed(message.to_owned()),
        _ => Failure::Server {
            number,
            message: message.to_owned(),
        },
    }
}

/// What an error of the socket is. A stream that ends or is reset is a server that did not talk; a refusal and a time out are their own.
fn from_io(kind: std::io::ErrorKind, text: &str) -> Failure {
    use std::io::ErrorKind::*;
    match kind {
        ConnectionRefused => Failure::Refused,
        TimedOut => Failure::Timeout,
        UnexpectedEof | ConnectionReset | ConnectionAborted | BrokenPipe => Failure::NoAnswer,
        _ => Failure::Other(text.to_owned()),
    }
}

/// An error of the protocol that is told apart by its words: sqlx has no type for it.
fn from_protocol(text: &str) -> Failure {
    if text.contains("RSA auth backend disabled") {
        Failure::NeedsTls
    } else {
        Failure::Other(text.to_owned())
    }
}

fn classify(error: &sqlx::Error) -> Failure {
    match error {
        sqlx::Error::Io(e) => from_io(e.kind(), &e.to_string()),
        sqlx::Error::Tls(e) => Failure::Tls(e.to_string()),
        sqlx::Error::Protocol(text) => from_protocol(text),
        sqlx::Error::Database(db) => match db.try_downcast_ref::<MySqlDatabaseError>() {
            Some(e) => from_server(e.number(), e.message()),
            None => Failure::Other(db.message().to_owned()),
        },
        other => Failure::Other(other.to_string()),
    }
}

/// How TLS is asked for. A tunnel ends at `127.0.0.1` and is encrypted by SSM already; a host that is the machine itself (`localhost`, a loopback address) goes nowhere on the network.
/// Any other host is reached over a network, and TLS is required there: with `Preferred` an attacker on the way could make the server look as if it had no TLS, and the password would go in plain text.
fn ssl_mode_of(endpoint: &Endpoint) -> MySqlSslMode {
    let loopback = endpoint.host.eq_ignore_ascii_case("localhost")
        || endpoint
            .host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if endpoint.tunneled || loopback {
        MySqlSslMode::Preferred
    } else {
        MySqlSslMode::Required
    }
}

/// A read only session on `endpoint`, or the reason it could not be opened. The password is not logged and is not in any error.
async fn open(
    endpoint: &Endpoint,
    username: &str,
    password: &str,
    limit: Duration,
) -> Result<MySqlConnection, Failure> {
    let mut options = MySqlConnectOptions::new()
        .host(&endpoint.host)
        .port(endpoint.port)
        .username(username)
        .ssl_mode(ssl_mode_of(endpoint))
        .timezone(None)
        .pipes_as_concat(false);
    if !password.is_empty() {
        options = options.password(password);
    }
    let opened = tokio::time::timeout(limit, async {
        let mut connection = options.connect().await?;
        connection.execute(READ_ONLY).await?;
        Ok::<_, sqlx::Error>(connection)
    })
    .await;
    match opened {
        Err(_) => Err(Failure::Timeout),
        Ok(result) => result.map_err(|e| classify(&e)),
    }
}

/// Opens a read only session on `endpoint`. The error is in Japanese.
pub async fn connect(
    endpoint: &Endpoint,
    username: &str,
    password: &str,
) -> Result<MySqlConnection, String> {
    open(endpoint, username, password, CONNECT_TIMEOUT)
        .await
        .map_err(|f| f.message(endpoint))
}

/// What a query on an open session that failed is: the words for the screen, and whether the session is gone with it.
/// A broken stream, TLS or the protocol (the session cannot be used again) is lost; an error the server answered, or a value that does not decode, is not.
#[derive(Debug, PartialEq)]
pub struct QueryFailure {
    pub message: String,
    pub lost: bool,
}

pub fn query_failure(error: &sqlx::Error) -> QueryFailure {
    match error {
        sqlx::Error::Io(_) | sqlx::Error::Tls(_) | sqlx::Error::Protocol(_) => QueryFailure {
            message: format!(
                "MySQL との接続が切れました。もう一度開いてください: {}",
                shorten(&error.to_string())
            ),
            lost: true,
        },
        sqlx::Error::Database(db) => QueryFailure {
            message: match db.try_downcast_ref::<MySqlDatabaseError>() {
                Some(e) => format!(
                    "MySQL がエラーを返しました ({}): {}",
                    e.number(),
                    shorten(e.message())
                ),
                None => format!("MySQL がエラーを返しました: {}", shorten(db.message())),
            },
            lost: false,
        },
        other => QueryFailure {
            message: format!("問い合わせに失敗しました: {}", shorten(&other.to_string())),
            lost: false,
        },
    }
}

/// The version the server answers to `SELECT VERSION()`, on a session that is closed afterwards.
pub async fn server_version(
    endpoint: &Endpoint,
    username: &str,
    password: &str,
) -> Result<String, String> {
    let mut connection = connect(endpoint, username, password).await?;
    let version = tokio::time::timeout(
        CONNECT_TIMEOUT,
        sqlx::query_scalar::<_, String>("SELECT VERSION()").fetch_one(&mut connection),
    )
    .await;
    let version = match version {
        Err(_) => Err(Failure::Timeout),
        Ok(result) => result.map_err(|e| classify(&e)),
    };
    let _ = connection.close().await;
    version.map_err(|f| f.message(endpoint))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    fn direct() -> Endpoint {
        Endpoint {
            host: "db.example.com".to_owned(),
            port: 3306,
            tunneled: false,
        }
    }

    fn tunneled() -> Endpoint {
        Endpoint {
            host: "127.0.0.1".to_owned(),
            port: 50123,
            tunneled: true,
        }
    }

    #[test]
    fn the_errors_of_the_server_that_are_about_the_login_are_auth() {
        for number in [1044, 1045, 1698] {
            assert_eq!(
                from_server(number, "Access denied"),
                Failure::Auth("Access denied".to_owned()),
                "{number}"
            );
        }
        for number in [1129, 1130] {
            assert!(matches!(
                from_server(number, "x"),
                Failure::HostNotAllowed(_)
            ));
        }
        assert_eq!(
            from_server(1040, "Too many connections"),
            Failure::Server {
                number: 1040,
                message: "Too many connections".to_owned()
            }
        );
    }

    #[test]
    fn a_stream_that_ends_or_is_reset_is_no_answer_and_is_not_auth() {
        use std::io::ErrorKind::*;
        for kind in [
            UnexpectedEof,
            ConnectionReset,
            ConnectionAborted,
            BrokenPipe,
        ] {
            assert_eq!(from_io(kind, "x"), Failure::NoAnswer, "{kind:?}");
        }
        assert_eq!(from_io(ConnectionRefused, "x"), Failure::Refused);
        assert_eq!(from_io(TimedOut, "x"), Failure::Timeout);
        assert_eq!(
            from_io(PermissionDenied, "denied"),
            Failure::Other("denied".to_owned())
        );
    }

    #[test]
    fn the_rsa_error_of_sqlx_is_told_as_a_server_without_tls() {
        assert_eq!(
            from_protocol("RSA auth backend disabled; enable feature mysql-rsa or use TLS."),
            Failure::NeedsTls
        );
        assert_eq!(
            from_protocol("unexpected packet 0x07"),
            Failure::Other("unexpected packet 0x07".to_owned())
        );
    }

    #[test]
    fn a_tunnel_that_opened_and_a_server_that_is_silent_is_told_apart_from_a_login_that_failed() {
        let silent = tunneled();
        for failure in [Failure::NoAnswer, Failure::Timeout, Failure::Refused] {
            let text = failure.message(&silent);
            assert!(
                text.starts_with("トンネルは開きましたが、MySQL が応えません"),
                "{text}"
            );
            assert!(text.contains("セキュリティグループ"));
            assert!(!text.contains("ログイン"));
        }
        let auth = Failure::Auth("Access denied for user".to_owned()).message(&silent);
        assert!(auth.contains("ログインに失敗") && !auth.contains("トンネル"));
        assert_ne!(Failure::NoAnswer.message(&silent), auth);
    }

    #[test]
    fn a_direct_connection_names_the_host_and_the_port() {
        let direct = direct();
        assert!(Failure::NoAnswer
            .message(&direct)
            .starts_with("db.example.com:3306 の MySQL が応えません"));
        assert!(Failure::Refused
            .message(&direct)
            .contains("db.example.com:3306"));
        assert!(Failure::Timeout.message(&direct).contains("時間内"));
        assert!(!Failure::NoAnswer.message(&direct).contains("トンネル"));
    }

    #[test]
    fn a_broken_stream_loses_the_session_and_an_error_of_the_decoding_does_not() {
        let broken = query_failure(&sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "broken pipe",
        )));
        assert!(broken.lost);
        assert!(broken.message.starts_with("MySQL との接続が切れました"));
        assert!(broken.message.contains("broken pipe"));
        assert!(query_failure(&sqlx::Error::Protocol("unexpected packet".to_owned())).lost);
        let other = query_failure(&sqlx::Error::RowNotFound);
        assert!(!other.lost);
        assert!(other.message.starts_with("問い合わせに失敗しました"));
    }

    #[test]
    fn a_long_message_of_the_server_is_cut() {
        let text = Failure::Server {
            number: 1,
            message: "あ".repeat(1000),
        }
        .message(&direct());
        assert!(text.ends_with('…') && text.chars().count() < 400);
    }

    // A MySQL server of a few lines: it says the handshake of MariaDB 10.4.7 (mysql_native_password, no TLS) and then does what `Server` says.
    const HANDSHAKE: &[u8] = b"\n5.5.5-10.4.7-MariaDB-1:10.4.7+maria~bionic\x00\x0b\x00\x00\x00t6L\\j\"dS\x00\xfe\xf7\x08\x02\x00\xff\x81\x15\x00\x00\x00\x00\x00\x00\x07\x00\x00\x00U14Oph9\"<H5n\x00mysql_native_password\x00";
    const OK: &[u8] = b"\x00\x00\x00\x02\x00\x00\x00";

    #[derive(Clone, Copy)]
    enum Server {
        /// Takes the connection and closes it.
        Close,
        /// Takes the connection and says nothing.
        Silent,
        /// Refuses the login (1045).
        Deny,
        /// Lets the login in and answers every query with OK.
        Allow,
    }

    fn frame(seq: u8, payload: &[u8]) -> Vec<u8> {
        let len = payload.len() as u32;
        let mut out = vec![len as u8, (len >> 8) as u8, (len >> 16) as u8, seq];
        out.extend_from_slice(payload);
        out
    }

    async fn read_packet(stream: &mut TcpStream) -> Option<Vec<u8>> {
        let mut head = [0u8; 4];
        stream.read_exact(&mut head).await.ok()?;
        let len = head[0] as usize | (head[1] as usize) << 8 | (head[2] as usize) << 16;
        let mut payload = vec![0u8; len];
        stream.read_exact(&mut payload).await.ok()?;
        Some(payload)
    }

    /// The server on a local port, and the task that ends with the queries it was sent.
    async fn serve(how: Server) -> (Endpoint, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut queries = Vec::new();
            match how {
                Server::Close => {}
                Server::Silent => {
                    let mut rest = Vec::new();
                    let _ = stream.read_to_end(&mut rest).await;
                }
                Server::Deny | Server::Allow => {
                    stream.write_all(&frame(0, HANDSHAKE)).await.unwrap();
                    let _login = read_packet(&mut stream).await;
                    if matches!(how, Server::Deny) {
                        let mut err = vec![0xff, 0x15, 0x04, b'#'];
                        err.extend_from_slice(b"28000Access denied for user 'reader'@'localhost' (using password: YES)");
                        stream.write_all(&frame(2, &err)).await.unwrap();
                        return queries;
                    }
                    stream.write_all(&frame(2, OK)).await.unwrap();
                    while let Some(packet) = read_packet(&mut stream).await {
                        if packet.first() == Some(&0x03) {
                            queries.push(String::from_utf8_lossy(&packet[1..]).into_owned());
                            stream.write_all(&frame(1, OK)).await.unwrap();
                        } else {
                            break;
                        }
                    }
                }
            }
            queries
        });
        let endpoint = Endpoint {
            host: "127.0.0.1".to_owned(),
            port,
            tunneled: true,
        };
        (endpoint, task)
    }

    const SECOND: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn a_server_that_closes_the_connection_is_no_answer() {
        let (endpoint, _server) = serve(Server::Close).await;
        let failure = open(&endpoint, "reader", "pw", SECOND).await.unwrap_err();
        assert_eq!(failure, Failure::NoAnswer);
        assert!(failure
            .message(&endpoint)
            .starts_with("トンネルは開きましたが"));
    }

    #[tokio::test]
    async fn a_server_that_says_nothing_is_a_time_out() {
        let (endpoint, _server) = serve(Server::Silent).await;
        let failure = open(&endpoint, "reader", "pw", Duration::from_millis(300))
            .await
            .unwrap_err();
        assert_eq!(failure, Failure::Timeout);
        assert!(failure
            .message(&endpoint)
            .starts_with("トンネルは開きましたが"));
    }

    #[tokio::test]
    async fn a_login_that_the_server_refuses_is_auth_with_the_message_of_the_server() {
        let (endpoint, _server) = serve(Server::Deny).await;
        let failure = open(&endpoint, "reader", "pw", SECOND).await.unwrap_err();
        assert!(
            matches!(&failure, Failure::Auth(text) if text.contains("Access denied")),
            "{failure:?}"
        );
        let text = failure.message(&endpoint);
        assert!(text.contains("ログインに失敗") && !text.contains("トンネルは開きましたが"));
        assert!(!text.contains("pw"));
    }

    #[tokio::test]
    async fn a_port_that_nothing_listens_on_is_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let endpoint = Endpoint {
            host: "127.0.0.1".to_owned(),
            port,
            tunneled: false,
        };
        let failure = open(&endpoint, "reader", "", SECOND).await.unwrap_err();
        assert_eq!(failure, Failure::Refused);
    }

    #[tokio::test]
    async fn a_session_that_is_opened_is_made_read_only_before_anything_else_is_asked() {
        let (endpoint, server) = serve(Server::Allow).await;
        let connection = open(&endpoint, "reader", "", SECOND).await.unwrap();
        connection.close().await.unwrap();
        let queries = server.await.unwrap();
        assert_eq!(queries.last().map(String::as_str), Some(READ_ONLY));
    }

    #[tokio::test]
    async fn a_session_keeps_the_time_zone_and_the_sql_mode_of_the_server() {
        let (endpoint, server) = serve(Server::Allow).await;
        let connection = open(&endpoint, "reader", "", SECOND).await.unwrap();
        connection.close().await.unwrap();
        let queries = server.await.unwrap();
        // sqlx's own preface sets time_zone='+00:00' and adds PIPES_AS_CONCAT to the sql_mode unless it is told not to.
        assert!(!queries.is_empty());
        for query in &queries {
            assert!(!query.contains("time_zone"), "{query}");
            assert!(!query.contains("PIPES_AS_CONCAT"), "{query}");
        }
    }

    fn at(host: &str, tunneled: bool) -> MySqlSslMode {
        ssl_mode_of(&Endpoint {
            host: host.to_owned(),
            port: 3306,
            tunneled,
        })
    }

    #[test]
    fn a_connection_over_a_network_requires_tls_and_one_to_this_machine_or_through_a_tunnel_does_not(
    ) {
        for host in [
            "db.example.com",
            "10.0.0.5",
            "2001:db8::1",
            "127.0.0.1.example.com",
        ] {
            assert!(matches!(at(host, false), MySqlSslMode::Required), "{host}");
        }
        for host in ["127.0.0.1", "127.1.2.3", "::1", "localhost", "LocalHost"] {
            assert!(matches!(at(host, false), MySqlSslMode::Preferred), "{host}");
        }
        // The local end of a tunnel is 127.0.0.1; the tunnel is encrypted by SSM.
        assert!(matches!(at("127.0.0.1", true), MySqlSslMode::Preferred));
        assert!(matches!(
            at("db.example.com", true),
            MySqlSslMode::Preferred
        ));
    }
}
