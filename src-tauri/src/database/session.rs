//! The sessions that the database screen keeps open (D-3, #632): one MySQL session for each connection that is open, reused until it is closed, and the reads the tree and the table list make on it.
//!
//! A session is opened by `database::open_session` (the tunnel when the connection uses SSM, then `mysql::connect`, read only) and put here under the id of the connection.
//! It lives until `disconnect` (the menu of the row, a save of the connection, a delete, a query that shows the stream broken) or the app's exit (`close_all`, called from `lib.rs` before the tunnels are closed).
//! `disconnect` also closes the tunnel of the session: stopping the plugin and ending the SSM session are `ssm::Tunnels::close`'s.
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
    ssm::Tunnels,
    structure::{self, DatabaseStructure},
};

/// One query on an open session. A query that is past it leaves the stream in an unknown state, so the session is closed.
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const NOT_OPEN: &str = "接続が開いていません。もう一度開いてください";
const TIMED_OUT: &str = "MySQL への問い合わせが時間内に終わりませんでした。もう一度開いてください";
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
    /// The tunnel to close with the session; none when the connection goes straight to its host.
    tunnel: Option<u64>,
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
    pub async fn has(&self, id: &str) -> bool {
        self.open.lock().await.contains_key(id)
    }

    /// The ids of the connections that are open, in order.
    pub async fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.open.lock().await.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Keeps `connection` under `id`. When another press opened one first, that one stays and this one is closed with its tunnel.
    pub async fn add(
        &self,
        tunnels: &Tunnels,
        id: &str,
        tunnel: Option<u64>,
        connection: MySqlConnection,
    ) {
        let mut open = self.open.lock().await;
        if open.contains_key(id) {
            drop(open);
            close_connection(connection).await;
            if let Some(tunnel) = tunnel {
                let _ = tunnels.close(tunnel).await;
            }
            return;
        }
        open.insert(
            id.to_owned(),
            Arc::new(Session {
                tunnel,
                connection: Mutex::new(Some(connection)),
            }),
        );
    }

    async fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        self.open
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| NOT_OPEN.to_owned())
    }

    /// Closes the session of `id` and its tunnel; an id that is not open is already closed.
    /// A query on its way holds the connection and is not waited for: the closing of the tunnel ends it (a connection with no tunnel is dropped when the query is done).
    pub async fn disconnect(&self, tunnels: &Tunnels, id: &str) -> Result<(), String> {
        let Some(session) = self.open.lock().await.remove(id) else {
            return Ok(());
        };
        if let Ok(mut guard) = session.connection.try_lock() {
            if let Some(connection) = guard.take() {
                close_connection(connection).await;
            }
        }
        match session.tunnel {
            Some(tunnel) => tunnels.close(tunnel).await,
            None => Ok(()),
        }
    }

    /// Closes every session (the app's exit). The tunnels are closed by `Tunnels::close_all` after it.
    pub async fn close_all(&self) {
        let sessions: Vec<Arc<Session>> = self.open.lock().await.drain().map(|(_, s)| s).collect();
        for session in sessions {
            if let Ok(mut guard) = session.connection.try_lock() {
                if let Some(connection) = guard.take() {
                    close_connection(connection).await;
                }
            }
        }
    }

    /// What a query answered. A session that the failure shows lost is closed with its tunnel, so that the next press opens a new one.
    async fn settle<T>(
        &self,
        tunnels: &Tunnels,
        id: &str,
        read: Result<Result<T, sqlx::Error>, tokio::time::error::Elapsed>,
    ) -> Result<T, String> {
        let failure = match read {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(e)) => mysql::query_failure(&e),
            Err(_) => QueryFailure {
                message: TIMED_OUT.to_owned(),
                lost: true,
            },
        };
        if failure.lost {
            let _ = self.disconnect(tunnels, id).await;
        }
        Err(failure.message)
    }

    /// The names of the databases, in order.
    pub async fn databases(&self, tunnels: &Tunnels, id: &str) -> Result<Vec<String>, String> {
        let session = self.session(id).await?;
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
        self.settle(tunnels, id, read).await
    }

    /// The tables of `database`, by name.
    pub async fn tables(
        &self,
        tunnels: &Tunnels,
        id: &str,
        database: &str,
    ) -> Result<Vec<DatabaseTable>, String> {
        let session = self.session(id).await?;
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
            .settle(tunnels, id, read)
            .await?
            .into_iter()
            .map(to_table)
            .collect())
    }

    /// The page `page` (from 0) of the records of `table` in `database` (D-4).
    pub async fn records(
        &self,
        tunnels: &Tunnels,
        id: &str,
        database: &str,
        table: &str,
        page: u32,
    ) -> Result<DatabaseRecords, String> {
        let session = self.session(id).await?;
        let read = {
            let mut guard = session.connection.lock().await;
            let Some(connection) = guard.as_mut() else {
                return Err(NOT_OPEN.to_owned());
            };
            tokio::time::timeout(
                QUERY_TIMEOUT,
                records::read(connection, database, table, page),
            )
            .await
        };
        self.settle(tunnels, id, read).await
    }

    /// The structure of `table` in `database` (D-5).
    pub async fn structure(
        &self,
        tunnels: &Tunnels,
        id: &str,
        database: &str,
        table: &str,
    ) -> Result<DatabaseStructure, String> {
        let session = self.session(id).await?;
        let read = {
            let mut guard = session.connection.lock().await;
            let Some(connection) = guard.as_mut() else {
                return Err(NOT_OPEN.to_owned());
            };
            tokio::time::timeout(QUERY_TIMEOUT, structure::read(connection, database, table)).await
        };
        self.settle(tunnels, id, read).await
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

    #[tokio::test]
    async fn a_connection_that_is_not_open_is_closed_already_and_cannot_be_read() {
        let sessions = Sessions::default();
        let tunnels = Tunnels::default();
        assert!(!sessions.has("a").await);
        assert_eq!(sessions.ids().await, Vec::<String>::new());
        assert_eq!(sessions.disconnect(&tunnels, "a").await, Ok(()));
        assert_eq!(
            sessions.databases(&tunnels, "a").await,
            Err(NOT_OPEN.to_owned())
        );
        assert_eq!(
            sessions.tables(&tunnels, "a", "shop").await,
            Err(NOT_OPEN.to_owned())
        );
        assert_eq!(
            sessions.records(&tunnels, "a", "shop", "orders", 0).await,
            Err(NOT_OPEN.to_owned())
        );
        assert_eq!(
            sessions.structure(&tunnels, "a", "shop", "orders").await,
            Err(NOT_OPEN.to_owned())
        );
        sessions.close_all().await;
    }
}
