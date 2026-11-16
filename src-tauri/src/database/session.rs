//! The sessions that the database screen keeps open (D-3, #632): one MySQL session for each connection that is open, reused until it is closed, and the reads the tree and the table list make on it.
//!
//! A session is opened by `database::open_session` (the script of the connection when it has one, then `mysql::connect`, read only) and put here under the id of the connection.
//! It lives until `disconnect` (the menu of the row, a save of the connection, a delete, a query that shows the stream broken, a script that has ended) or the app's exit (`close_all`, called from `lib.rs` before the scripts are ended).
//! `disconnect` also ends the script of the session (`script::Scripts::close`).
//! A script that ends after it was ready closes its session (D-1): `reap` looks for such sessions before a session is looked up or listed, and a query that fails because of it is told with the words of the script's end.
//! The databases are read from `information_schema.SCHEMATA` and the tables from `information_schema.TABLES`, the name of the database as a bound value, never put in the SQL text.
//! The format of the row count and of the size (`format_rows`, `format_size`) are pure functions.

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::Serialize;
use sqlx::{mysql::MySqlConnection, Connection};
use tokio::sync::Mutex;
#[cfg(test)]
use ts_rs::TS;

use super::{
    mysql::{self, QueryFailure},
    records::{self, DatabaseRecords},
    script::Scripts,
    sql::{self, DatabaseSqlResult},
    structure::{self, DatabaseStructure},
    Login,
};

/// One query on an open session. A query that is past it leaves the stream in an unknown state, so the session is closed.
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const NOT_OPEN: &str = "接続が開いていません。もう一度開いてください";
const TIMED_OUT: &str = "MySQL への問い合わせが時間内に終わりませんでした。もう一度開いてください";
const SQL_TIMED_OUT: &str =
    "実行が時間内に終わらなかったため、MySQL との接続を閉じました。もう一度開いてください";
/// The names of the databases the user may see.
const DATABASES: &str =
    "SELECT CAST(SCHEMA_NAME AS CHAR) FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME";
/// The name, the engine, the estimated rows, the data and the index length of each table (and view) of the database bound to `?`.
const TABLES: &str = "SELECT CAST(TABLE_NAME AS CHAR), CAST(ENGINE AS CHAR), CAST(TABLE_ROWS AS UNSIGNED), CAST(DATA_LENGTH AS UNSIGNED), CAST(INDEX_LENGTH AS UNSIGNED) \
FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME";

type TableRow = (
    String,
    Option<String>,
    Option<u64>,
    Option<u64>,
    Option<u64>,
);

/// A table of a database as the table list draws it. `rows`, `size` and `engine` are text, empty for what the server does not know (a view has none of them).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct DatabaseTable {
    pub name: String,
    pub engine: String,
    pub rows: String,
    pub size: String,
}

/// `1234567` as `1,234,567`.
fn group_digits(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The estimated number of rows with thousands separators; empty when the server gives none.
pub fn format_rows(rows: Option<u64>) -> String {
    rows.map(group_digits).unwrap_or_default()
}

/// `bytes` as `512 B`, or with one decimal in KB, MB, GB or TB (1024 each; a value that rounds to 1024.0 is shown in the next unit).
pub(super) fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut unit = 1024u128;
    for (i, name) in UNITS.iter().enumerate() {
        let tenths = (u128::from(bytes) * 10 + unit / 2) / unit;
        if tenths < 10240 || i == UNITS.len() - 1 {
            return format!("{}.{} {name}", tenths / 10, tenths % 10);
        }
        unit *= 1024;
    }
    unreachable!("the last unit always returns")
}

/// The size of a table, its data and its index together; empty when the server gives neither.
pub fn format_size(data: Option<u64>, index: Option<u64>) -> String {
    if data.is_none() && index.is_none() {
        return String::new();
    }
    format_bytes(data.unwrap_or(0).saturating_add(index.unwrap_or(0)))
}

fn to_table((name, engine, rows, data, index): TableRow) -> DatabaseTable {
    DatabaseTable {
        name,
        engine: engine.unwrap_or_default(),
        rows: format_rows(rows),
        size: format_size(data, index),
    }
}

struct Session {
    /// The login the session was opened with (not the saved file's, which `tsunagiai-mcp` may change meanwhile): what the script of the session listens for.
    login: Login,
    /// The script to end with the session; none when the connection goes straight to its host.
    script: Option<u64>,
    /// None once closed. A query holds the lock for its whole run, so two queries never share the stream.
    connection: Mutex<Option<MySqlConnection>>,
}

/// The open sessions by the id of the connection. Managed by Tauri (`lib.rs`), so that the app's exit closes them.
#[derive(Default)]
pub struct Sessions {
    open: Mutex<HashMap<String, Arc<Session>>>,
}

async fn close_connection(connection: MySqlConnection) {
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, connection.close()).await;
}

impl Sessions {
    pub async fn has(&self, scripts: &Scripts, id: &str) -> bool {
        self.reap(scripts).await;
        self.open.lock().await.contains_key(id)
    }

    /// The login the open session of `id` was opened with; none when it is not open.
    pub async fn opened_login(&self, scripts: &Scripts, id: &str) -> Option<Login> {
        self.reap(scripts).await;
        self.open.lock().await.get(id).map(|s| s.login.clone())
    }

    /// The ids of the connections that are open, in order.
    pub async fn ids(&self, scripts: &Scripts) -> Vec<String> {
        self.reap(scripts).await;
        let mut ids: Vec<String> = self.open.lock().await.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Keeps `connection` under `id`. When another press opened one first, that one stays and this one is closed with its script.
    pub async fn add(
        &self,
        scripts: &Scripts,
        id: &str,
        script: Option<u64>,
        login: Login,
        connection: MySqlConnection,
    ) {
        let mut open = self.open.lock().await;
        if open.contains_key(id) {
            drop(open);
            close_connection(connection).await;
            if let Some(script) = script {
                scripts.close(script).await;
            }
            return;
        }
        open.insert(
            id.to_owned(),
            Arc::new(Session {
                login,
                script,
                connection: Mutex::new(Some(connection)),
            }),
        );
    }

    /// Closes every session whose script has ended since it was ready, and answers the id of each with the words of the end.
    async fn reap(&self, scripts: &Scripts) -> Vec<(String, String)> {
        let candidates: Vec<(String, Arc<Session>)> = self
            .open
            .lock()
            .await
            .iter()
            .filter(|(_, session)| session.script.is_some())
            .map(|(id, session)| (id.clone(), session.clone()))
            .collect();
        let mut ended = Vec::new();
        for (id, session) in candidates {
            let Some(script) = session.script else {
                continue;
            };
            if let Some(words) = scripts.exited(script).await {
                self.disconnect_session(scripts, &id, &session).await;
                ended.push((id, words));
            }
        }
        ended
    }

    async fn session(&self, scripts: &Scripts, id: &str) -> Result<Arc<Session>, String> {
        if let Some((_, words)) = self
            .reap(scripts)
            .await
            .into_iter()
            .find(|(ended, _)| ended == id)
        {
            return Err(words);
        }
        self.open
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| NOT_OPEN.to_owned())
    }

    /// Closes the session of `id` and its script; an id that is not open is already closed.
    /// A query on its way holds the connection and is not waited for: ending the script ends it (a connection with no script is dropped when the query is done).
    pub async fn disconnect(&self, scripts: &Scripts, id: &str) {
        let Some(session) = self.open.lock().await.remove(id) else {
            return;
        };
        Self::close_session(scripts, &session).await;
    }

    /// Closes `session` (already out of `open`) and its script.
    async fn close_session(scripts: &Scripts, session: &Session) {
        if let Ok(mut guard) = session.connection.try_lock() {
            if let Some(connection) = guard.take() {
                close_connection(connection).await;
            }
        }
        if let Some(script) = session.script {
            scripts.close(script).await;
        }
    }

    /// Closes the session of `id` only when it is `session` itself: a query that began on a session that was closed meanwhile, and replaced by a new one, must not close the new one.
    async fn disconnect_session(&self, scripts: &Scripts, id: &str, session: &Arc<Session>) {
        let current = {
            let mut open = self.open.lock().await;
            if open.get(id).is_some_and(|s| Arc::ptr_eq(s, session)) {
                open.remove(id)
            } else {
                None
            }
        };
        if let Some(current) = current {
            Self::close_session(scripts, &current).await;
        }
    }

    /// Closes every session (the app's exit), all at once, so that the exit waits for the slowest and not for the sum. The scripts are ended by `Scripts::close_all` after it.
    pub async fn close_all(&self) {
        let sessions: Vec<Arc<Session>> = self.open.lock().await.drain().map(|(_, s)| s).collect();
        futures_util::future::join_all(sessions.iter().map(|session| async move {
            if let Ok(mut guard) = session.connection.try_lock() {
                if let Some(connection) = guard.take() {
                    close_connection(connection).await;
                }
            }
        }))
        .await;
    }

    /// What a query answered. A session that the failure shows lost is closed with its script, so that the next press opens a new one.
    /// When the script has ended, that is what the failure is told as.
    /// `session` is the one the query ran on.
    async fn settle<T>(
        &self,
        scripts: &Scripts,
        id: &str,
        session: &Arc<Session>,
        read: Result<Result<T, sqlx::Error>, tokio::time::error::Elapsed>,
    ) -> Result<T, String> {
        self.settle_with(scripts, id, session, read, mysql::query_failure, TIMED_OUT)
            .await
    }

    /// `settle` with the words of the failure and of the time out given: the SQL tab words what MySQL answered itself (D-6).
    async fn settle_with<T>(
        &self,
        scripts: &Scripts,
        id: &str,
        session: &Arc<Session>,
        read: Result<Result<T, sqlx::Error>, tokio::time::error::Elapsed>,
        failed: fn(&sqlx::Error) -> QueryFailure,
        timed_out: &str,
    ) -> Result<T, String> {
        let failure = match read {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(e)) => failed(&e),
            Err(_) => QueryFailure {
                message: timed_out.to_owned(),
                lost: true,
            },
        };
        if failure.lost {
            let ended = match session.script {
                Some(script) => scripts.exited(script).await,
                None => None,
            };
            self.disconnect_session(scripts, id, session).await;
            return Err(ended.unwrap_or(failure.message));
        }
        Err(failure.message)
    }

    /// The names of the databases, in order.
    pub async fn databases(&self, scripts: &Scripts, id: &str) -> Result<Vec<String>, String> {
        let session = self.session(scripts, id).await?;
        let read = {
            let mut guard = session.connection.lock().await;
            let Some(connection) = guard.as_mut() else {
                return Err(NOT_OPEN.to_owned());
            };
            tokio::time::timeout(
                QUERY_TIMEOUT,
                sqlx::query_scalar::<_, String>(DATABASES).fetch_all(connection),
            )
            .await
        };
        self.settle(scripts, id, &session, read).await
    }

    /// The tables of `database`, by name.
    pub async fn tables(
        &self,
        scripts: &Scripts,
        id: &str,
        database: &str,
    ) -> Result<Vec<DatabaseTable>, String> {
        let session = self.session(scripts, id).await?;
        let read = {
            let mut guard = session.connection.lock().await;
            let Some(connection) = guard.as_mut() else {
                return Err(NOT_OPEN.to_owned());
            };
            tokio::time::timeout(
                QUERY_TIMEOUT,
                sqlx::query_as::<_, TableRow>(TABLES)
                    .bind(database)
                    .fetch_all(connection),
            )
            .await
        };
        Ok(self
            .settle(scripts, id, &session, read)
            .await?
            .into_iter()
            .map(to_table)
            .collect())
    }

    /// The page `page` (from 0) of the records of `table` in `database` (D-4).
    pub async fn records(
        &self,
        scripts: &Scripts,
        id: &str,
        database: &str,
        table: &str,
        page: u32,
        estimate: Option<u64>,
    ) -> Result<DatabaseRecords, String> {
        let session = self.session(scripts, id).await?;
        let read = {
            let mut guard = session.connection.lock().await;
            let Some(connection) = guard.as_mut() else {
                return Err(NOT_OPEN.to_owned());
            };
            tokio::time::timeout(
                QUERY_TIMEOUT,
                records::read(connection, database, table, page, estimate),
            )
            .await
        };
        self.settle(scripts, id, &session, read).await
    }

    /// The text of the user run as one statement in `database` (D-6).
    pub async fn sql(
        &self,
        scripts: &Scripts,
        id: &str,
        database: &str,
        text: &str,
    ) -> Result<DatabaseSqlResult, String> {
        let text = sql::statement(text)?;
        let session = self.session(scripts, id).await?;
        let read = {
            let mut guard = session.connection.lock().await;
            let Some(connection) = guard.as_mut() else {
                return Err(NOT_OPEN.to_owned());
            };
            tokio::time::timeout(sql::CLIENT_LIMIT, sql::run(connection, database, text)).await
        };
        self.settle_with(scripts, id, &session, read, sql::failure, SQL_TIMED_OUT)
            .await
    }

    /// The structure of `table` in `database` (D-5).
    pub async fn structure(
        &self,
        scripts: &Scripts,
        id: &str,
        database: &str,
        table: &str,
    ) -> Result<DatabaseStructure, String> {
        let session = self.session(scripts, id).await?;
        let read = {
            let mut guard = session.connection.lock().await;
            let Some(connection) = guard.as_mut() else {
                return Err(NOT_OPEN.to_owned());
            };
            tokio::time::timeout(QUERY_TIMEOUT, structure::read(connection, database, table)).await
        };
        self.settle(scripts, id, &session, read).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rows_have_thousands_separators_and_none_is_empty() {
        let cases = [
            (0, "0"),
            (7, "7"),
            (999, "999"),
            (1000, "1,000"),
            (12345, "12,345"),
            (1234567, "1,234,567"),
            (u64::MAX, "18,446,744,073,709,551,615"),
        ];
        for (n, text) in cases {
            assert_eq!(format_rows(Some(n)), text, "{n}");
        }
        assert_eq!(format_rows(None), "");
    }

    #[test]
    fn the_size_is_in_the_unit_that_keeps_it_short() {
        let cases: [(u64, &str); 12] = [
            (0, "0 B"),
            (1023, "1023 B"),
            (1024, "1.0 KB"),
            (1536, "1.5 KB"),
            (16384, "16.0 KB"),
            (1024 * 1024 - 1, "1.0 MB"),
            (1024 * 1024, "1.0 MB"),
            (5 * 1024 * 1024 + 512 * 1024, "5.5 MB"),
            (1024 * 1024 * 1024, "1.0 GB"),
            (3 * 1024 * 1024 * 1024 * 1024, "3.0 TB"),
            (2048 * 1024 * 1024 * 1024 * 1024, "2048.0 TB"),
            (1023 * 1024 + 900, "1023.9 KB"),
        ];
        for (bytes, text) in cases {
            assert_eq!(format_bytes(bytes), text, "{bytes}");
        }
    }

    #[test]
    fn the_size_adds_the_data_and_the_index_and_is_empty_when_the_server_gives_neither() {
        assert_eq!(format_size(Some(16384), Some(16384)), "32.0 KB");
        assert_eq!(format_size(Some(16384), None), "16.0 KB");
        assert_eq!(format_size(None, Some(0)), "0 B");
        assert_eq!(format_size(None, None), "");
        assert_eq!(format_size(Some(u64::MAX), Some(1)), format_bytes(u64::MAX));
    }

    #[test]
    fn a_table_row_becomes_the_text_the_list_draws_and_a_view_has_none_of_it() {
        let table = to_table((
            "orders".to_owned(),
            Some("InnoDB".to_owned()),
            Some(12345),
            Some(1048576),
            Some(524288),
        ));
        assert_eq!(
            table,
            DatabaseTable {
                name: "orders".to_owned(),
                engine: "InnoDB".to_owned(),
                rows: "12,345".to_owned(),
                size: "1.5 MB".to_owned(),
            }
        );
        let view = to_table(("v_orders".to_owned(), None, None, None, None));
        assert_eq!(
            (view.engine.as_str(), view.rows.as_str(), view.size.as_str()),
            ("", "", "")
        );
    }

    #[test]
    fn the_values_of_a_query_are_bound_and_not_put_in_the_text() {
        assert!(TABLES.contains("TABLE_SCHEMA = ?"));
        assert_eq!(TABLES.matches('?').count(), 1);
        assert!(!DATABASES.contains('?'));
    }

    fn empty_session() -> Arc<Session> {
        Arc::new(Session {
            login: Login::default(),
            script: None,
            connection: Mutex::new(None),
        })
    }

    #[tokio::test]
    async fn a_query_that_shows_the_stream_broken_closes_its_own_session_and_not_a_newer_one() {
        let sessions = Sessions::default();
        let scripts = Scripts::default();
        let old = empty_session();
        let new = empty_session();
        sessions
            .open
            .lock()
            .await
            .insert("a".to_owned(), new.clone());
        let broken = || {
            Ok::<Result<(), sqlx::Error>, tokio::time::error::Elapsed>(Err(sqlx::Error::Io(
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "broken pipe"),
            )))
        };
        // The query began on `old`, which was closed and replaced by `new` meanwhile: `new` stays.
        let told = sessions.settle(&scripts, "a", &old, broken()).await;
        assert!(told.unwrap_err().starts_with("MySQL との接続が切れました"));
        assert!(sessions.has(&scripts, "a").await);
        // A query on the session that is open is told lost, and it is closed.
        let _ = sessions.settle(&scripts, "a", &new, broken()).await;
        assert!(!sessions.has(&scripts, "a").await);
    }

    #[tokio::test]
    async fn a_connection_that_is_not_open_is_closed_already_and_cannot_be_read() {
        let sessions = Sessions::default();
        let scripts = Scripts::default();
        assert!(!sessions.has(&scripts, "a").await);
        assert_eq!(sessions.ids(&scripts).await, Vec::<String>::new());
        sessions.disconnect(&scripts, "a").await;
        assert_eq!(
            sessions.databases(&scripts, "a").await,
            Err(NOT_OPEN.to_owned())
        );
        assert_eq!(
            sessions.tables(&scripts, "a", "shop").await,
            Err(NOT_OPEN.to_owned())
        );
        assert_eq!(
            sessions
                .records(&scripts, "a", "shop", "orders", 0, None)
                .await,
            Err(NOT_OPEN.to_owned())
        );
        assert_eq!(
            sessions.structure(&scripts, "a", "shop", "orders").await,
            Err(NOT_OPEN.to_owned())
        );
        assert_eq!(
            sessions.sql(&scripts, "a", "shop", "SELECT 1").await,
            Err(NOT_OPEN.to_owned())
        );
        // Nothing to run is told before the connection is looked at.
        assert_eq!(
            sessions.sql(&scripts, "a", "shop", " ; ").await,
            Err("SQL を入力してください".to_owned())
        );
        sessions.close_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_session_whose_script_has_ended_is_closed_and_told_with_the_end_of_the_script() {
        use super::super::script::{
            start,
            support::{free_port, listen_later},
            Timing,
        };
        let dir =
            std::env::temp_dir().join(format!("tsunagiai-session-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (up_port, down_port) = (free_port(), free_port());
        let _up = listen_later(up_port);
        let timing = Timing {
            ready: Duration::from_secs(10),
            grace: Duration::from_millis(300),
        };
        let scripts = Scripts::default();
        let running = start(&dir, "127.0.0.1", up_port, "sleep 30", timing)
            .await
            .unwrap();
        // Each listener comes up after its own script is run, so that the port is free when it is.
        let _down = listen_later(down_port);
        let ending = start(
            &dir,
            "127.0.0.1",
            down_port,
            "sleep 1\necho gone >&2\nexit 2",
            timing,
        )
        .await
        .unwrap();
        let running = scripts.insert(running).await;
        let ending = scripts.insert(ending).await;
        let sessions = Sessions::default();
        for (id, script) in [("up", running), ("down", ending)] {
            sessions.open.lock().await.insert(
                id.to_owned(),
                Arc::new(Session {
                    login: Login::default(),
                    script: Some(script),
                    connection: Mutex::new(None),
                }),
            );
        }
        assert_eq!(sessions.ids(&scripts).await, ["down", "up"]);
        let mut told = Err(String::new());
        for _ in 0..100 {
            told = sessions.databases(&scripts, "down").await;
            if told.as_ref().err().is_some_and(|e| e != NOT_OPEN) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(
            told,
            Err("接続のスクリプトが終了したため、接続を閉じました（終了コード 2）。標準エラーの最後の行: gone".to_owned())
        );
        assert_eq!(sessions.ids(&scripts).await, ["up"]);
        assert!(!sessions.has(&scripts, "down").await);
        sessions.disconnect(&scripts, "up").await;
        assert_eq!(scripts.exited(running).await, None);
        scripts.close_all().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
