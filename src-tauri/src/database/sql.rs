//! The SQL tab (D-6, #635): the text the user typed, run as it is on the open session, and its rows turned into the cells of D-4.
//!
//! The session is not read only (D-2): a write (INSERT, UPDATE, DELETE and the like) is run as it is and is committed at once (autocommit, the server's own default). This module words the errors of the server (`server_message`) and keeps the run small.
//! One statement is run at a time, as a prepared one, so its rows come in the binary protocol that `records::cells_of` reads. The text is not rewritten: only the whitespace and the semicolons at its end are cut (`statement`).
//! The database the tree has selected is chosen before the run by a `USE` of its own (the name quoted by `records::quote_identifier`), never put in the text of the user.
//! Before the run, one round trip (`prepare_sql`) sets the limits (`max_execution_time` stops a SELECT at `SERVER_LIMIT` and `sql_select_limit` ends a SELECT with no LIMIT one row after the limit of the rows) and selects the database.
//! After the run, whatever came of it (a failed `USE` too), `RESTORE` turns autocommit on again and puts the limits back,
//! a statement that gives no row is told by the rows it changed (`format_summary`),
//! and the rows are read as a stream that stops after `ROWS_MAX` of them (`collect_limited`), so the rows past the limit are never held.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use futures_util::{future::ready, Stream, StreamExt, TryStreamExt};
use serde::Serialize;
use sqlx::{
    mysql::{MySqlConnection, MySqlDatabaseError, MySqlRow},
    AssertSqlSafe, Column, Either, Executor, Row,
};
#[cfg(test)]
use ts_rs::TS;

use super::{
    mysql::{query_failure, shorten, QueryFailure},
    records::{cells_of, cells_tsv, quote_identifier, DatabaseCell},
    session::format_rows,
};

/// The rows of a result that are kept. One row more is read, to know that the result is longer.
pub const ROWS_MAX: usize = 1000;
/// How long MySQL lets a SELECT run.
pub const SERVER_LIMIT: Duration = Duration::from_secs(30);
/// How long the app waits for the whole run (the preface, the statement, the restore) before it closes the connection: for what `SERVER_LIMIT` does not stop (a statement that is not a SELECT, a server that does not answer).
pub const CLIENT_LIMIT: Duration = Duration::from_secs(35);
/// Turns autocommit on again and puts the limits back to the server's own, so that the reads of the tree and of the tabs after a run are as they were, and a `SET autocommit = 0` of the text of the user does not outlive its run (turning it on commits what the run left open).
const RESTORE: &str =
    "SET SESSION autocommit = 1, max_execution_time = DEFAULT, sql_select_limit = DEFAULT";
const EMPTY: &str = "SQL を入力してください";
const TIMED_OUT: &str =
    "実行が時間内に終わらなかったため、MySQL との接続を閉じました。もう一度開いてください";
const TIMED_OUT_WRITE: &str = "実行が時間内に終わらなかったため、MySQL との接続を閉じました。書き込みの文は、サーバーで確定している場合があります。もう一度開いてください";

/// The result of a run: the columns and the rows as D-4's cells, and the line under the table. A statement that gives no row has no column.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct DatabaseSqlResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<DatabaseCell>>,
    pub summary: String,
    /// The result as the copy button copies it (`records::cells_tsv`, #668).
    pub tsv: String,
}

/// The text to run: `sql` without the whitespace around it and the semicolons at its end (a prepared statement is one statement, and `;` is how one is ended by hand), or the reason there is nothing to run.
pub fn statement(sql: &str) -> Result<&str, String> {
    let text = sql
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .trim_start();
    if text.is_empty() {
        return Err(EMPTY.to_owned());
    }
    Ok(text)
}

/// Selects the database of the tree. It is a statement of its own and never part of the text of the user.
pub fn use_sql(database: &str) -> String {
    format!("USE {}", quote_identifier(database))
}

/// What is set on the session before a run, in one round trip: the time MySQL lets a SELECT run, the rows a SELECT with no LIMIT gives (one more than are kept), and the database of the tree.
/// The statements stop at the first that fails, so a `USE` that fails leaves the limits set, and `RESTORE` follows every run.
pub fn prepare_sql(database: &str) -> String {
    format!(
        "SET SESSION max_execution_time = {}, sql_select_limit = {}; {}",
        SERVER_LIMIT.as_millis(),
        ROWS_MAX + 1,
        use_sql(database)
    )
}

/// `elapsed` as "12 ms", and from a second on as "1.25 秒" (the hundredths cut, not rounded).
pub fn format_elapsed(elapsed: Duration) -> String {
    let ms = elapsed.as_millis();
    if ms < 1000 {
        return format!("{ms} ms");
    }
    format!("{}.{:02} 秒", ms / 1000, ms % 1000 / 10)
}

/// The line under the table: the rows and the time, and where the rows were cut, that they were and that the rest was not read.
/// A statement that gave no row and changed some (`changed`, the rows MySQL says it affected) is told by them: "3 行を変更 / 12 ms".
/// MySQL says 0 for a SELECT as well, so a statement that changed none reads as "0 行 / 12 ms".
pub fn format_summary(shown: usize, truncated: bool, changed: u64, elapsed: Duration) -> String {
    let rows = format_rows(Some(shown as u64));
    let time = format_elapsed(elapsed);
    if shown == 0 && changed > 0 {
        format!("{} 行を変更 / {time}", format_rows(Some(changed)))
    } else if truncated {
        format!("先頭の {rows} 行だけを表示しています（残りは読み込んでいません） / {time}")
    } else {
        format!("{rows} 行 / {time}")
    }
}

/// An error that MySQL answered to the text of the user, in words for the person who typed it: what it is, its number and the server's message.
/// The refusal of a write (1792, in a transaction the text started READ ONLY, and 1290 of a server that is read only) is told with the same ending.
pub fn server_message(number: u16, message: &str) -> String {
    let words = match number {
        1792 => "読み取り専用のトランザクションの中のため、データを書き換える文は実行できません"
            .to_owned(),
        1290 => {
            "MySQL サーバーが読み取り専用のため、データを書き換える文は実行できません".to_owned()
        }
        1044 | 1142 | 1143 | 1227 => "このユーザーには、この操作の権限がありません".to_owned(),
        1064 => "SQL の文法が正しくありません。1 回に実行できる文は 1 つです".to_owned(),
        1295 => "この種類の文は実行できません".to_owned(),
        1049 => "データベースが見つかりません".to_owned(),
        1146 => "テーブルが見つかりません".to_owned(),
        1054 => "列が見つかりません".to_owned(),
        1317 => "実行が中断されました".to_owned(),
        3024 => format!(
            "実行が {} 秒を超えたため、MySQL が止めました",
            SERVER_LIMIT.as_secs()
        ),
        _ => "MySQL がエラーを返しました".to_owned(),
    };
    format!("{words} ({number}): {}", shorten(message))
}

/// The words of a run that the app stopped at `CLIENT_LIMIT`. `body_started` is that the text of the user had been sent (the preface was over): a write may then have been committed on the server (autocommit), so the words say so.
pub fn timed_out(body_started: bool) -> &'static str {
    if body_started {
        TIMED_OUT_WRITE
    } else {
        TIMED_OUT
    }
}

/// What a run that failed is. An error that MySQL answered is worded by `server_message` and leaves the session as it was; the others are the words of every query (`mysql::query_failure`).
pub fn failure(error: &sqlx::Error) -> QueryFailure {
    if let sqlx::Error::Database(db) = error {
        if let Some(e) = db.try_downcast_ref::<MySqlDatabaseError>() {
            return QueryFailure {
                message: server_message(e.number(), e.message()),
                lost: false,
            };
        }
    }
    query_failure(error)
}

/// At most `limit` items of `stream`, and whether there was one more. It reads that one more and stops: the rest of the stream is not read.
pub(super) async fn collect_limited<S, T, E>(
    mut stream: S,
    limit: usize,
) -> Result<(Vec<T>, bool), E>
where
    S: Stream<Item = Result<T, E>> + Unpin,
{
    let mut items = Vec::new();
    while let Some(item) = stream.next().await {
        let item = item?;
        if items.len() == limit {
            return Ok((items, true));
        }
        items.push(item);
    }
    Ok((items, false))
}

pub(super) fn column_names(row: &MySqlRow) -> Vec<String> {
    row.columns().iter().map(|c| c.name().to_owned()).collect()
}

/// What a run read: the columns (those of the first row), the rows up to `ROWS_MAX` as cells, whether the rows were cut, and the rows the statement changed.
type Read = (Vec<String>, Vec<Vec<DatabaseCell>>, bool, u64);

/// The rows of `text` on the session, up to `ROWS_MAX`, as cells, and the rows it changed. The statement is not kept in sqlx's cache of prepared statements.
async fn read(connection: &mut MySqlConnection, text: &str) -> Result<Read, sqlx::Error> {
    let mut columns: Option<Vec<String>> = None;
    let mut changed = 0u64;
    let query = sqlx::query(AssertSqlSafe(text.to_owned())).persistent(false);
    let rows = (&mut *connection).fetch_many(query).try_filter_map(|item| {
        ready(Ok(match item {
            Either::Left(done) => {
                changed += done.rows_affected();
                None
            }
            Either::Right(row) => {
                columns.get_or_insert_with(|| column_names(&row));
                Some(cells_of(&row))
            }
        }))
    });
    let (rows, truncated) = collect_limited(Box::pin(rows), ROWS_MAX).await?;
    Ok((columns.unwrap_or_default(), rows, truncated, changed))
}

/// Runs `text` (already checked by `statement`) in `database` on the session, under the limits of MySQL, and puts the limits back.
/// `body_started` is set once the preface is over and the text is about to be sent, so that the caller that stops the run at `CLIENT_LIMIT` knows how to word it (`timed_out`).
pub async fn run(
    connection: &mut MySqlConnection,
    database: &str,
    text: &str,
    body_started: &AtomicBool,
) -> Result<DatabaseSqlResult, sqlx::Error> {
    // The statements of the preface and of the restore are run as text, because the protocol of a prepared statement does not take `USE`.
    let prepared = sqlx::raw_sql(AssertSqlSafe(prepare_sql(database)))
        .execute(&mut *connection)
        .await;
    let started = Instant::now();
    let read = match prepared {
        Ok(_) => {
            body_started.store(true, Ordering::Relaxed);
            read(connection, text).await
        }
        Err(e) => Err(e),
    };
    let elapsed = started.elapsed();
    // After a failure that MySQL answered (a `USE` that failed too) the session is still there and is put back; after a broken one this fails as well, and the failure of the run is the one told.
    let restored = sqlx::raw_sql(RESTORE).execute(&mut *connection).await;
    let (columns, rows, truncated, changed) = read?;
    restored?;
    Ok(DatabaseSqlResult {
        tsv: cells_tsv(&columns, &rows),
        columns,
        summary: format_summary(rows.len(), truncated, changed, elapsed),
        rows,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures_util::stream;

    use super::*;

    #[test]
    fn the_text_is_run_as_typed_but_for_the_whitespace_and_the_semicolons_at_its_ends() {
        assert_eq!(statement("SELECT 1"), Ok("SELECT 1"));
        assert_eq!(statement("  SELECT 1 ;\n"), Ok("SELECT 1"));
        assert_eq!(statement("SELECT 1;;  ; \n;"), Ok("SELECT 1"));
        // Inside the text nothing is touched, a second statement included (MySQL refuses it).
        assert_eq!(
            statement("SELECT ';' ; SELECT 2;"),
            Ok("SELECT ';' ; SELECT 2")
        );
        assert_eq!(
            statement("SELECT\n  a,\n  b\nFROM t -- note"),
            Ok("SELECT\n  a,\n  b\nFROM t -- note")
        );
        assert_eq!(
            statement("INSERT INTO t VALUES (1)"),
            Ok("INSERT INTO t VALUES (1)")
        );
    }

    #[test]
    fn nothing_to_run_is_refused_in_japanese() {
        for text in ["", "   ", "\n\t", ";", " ; ;\n"] {
            assert_eq!(
                statement(text),
                Err("SQL を入力してください".to_owned()),
                "{text:?}"
            );
        }
    }

    #[test]
    fn the_session_is_limited_before_a_run_and_put_back_after_it_and_is_not_made_read_only() {
        assert_eq!(
            prepare_sql("shop"),
            "SET SESSION max_execution_time = 30000, sql_select_limit = 1001; USE `shop`"
        );
        assert_eq!(
            RESTORE,
            "SET SESSION autocommit = 1, max_execution_time = DEFAULT, sql_select_limit = DEFAULT"
        );
        // Nothing of the run says READ ONLY: a write is run as it is.
        assert!(!prepare_sql("shop").to_uppercase().contains("READ ONLY"));
        assert!(!RESTORE.to_uppercase().contains("READ ONLY"));
        // The name of the database is quoted in the preface too.
        assert!(prepare_sql("a`b").ends_with("USE `a``b`"));
        // The client waits longer than MySQL, so that MySQL's own stop is the one that comes first.
        assert!(CLIENT_LIMIT > SERVER_LIMIT);
    }

    #[test]
    fn a_run_stopped_by_the_app_says_that_a_write_may_have_been_committed_only_once_the_text_was_sent(
    ) {
        let before = timed_out(false);
        assert_eq!(
            before,
            "実行が時間内に終わらなかったため、MySQL との接続を閉じました。もう一度開いてください"
        );
        assert!(!before.contains("書き込みの文は"));
        let after = timed_out(true);
        assert!(after.contains("書き込みの文は、サーバーで確定している場合があります"));
        assert!(after.starts_with("実行が時間内に終わらなかったため、MySQL との接続を閉じました。"));
        assert!(after.ends_with("もう一度開いてください"));
    }

    #[test]
    fn the_database_is_selected_by_a_statement_of_its_own_with_the_name_quoted() {
        assert_eq!(use_sql("shop"), "USE `shop`");
        assert_eq!(use_sql("a`b"), "USE `a``b`");
        assert_eq!(use_sql("x; DROP TABLE y"), "USE `x; DROP TABLE y`");
    }

    #[test]
    fn the_time_is_in_milliseconds_and_from_a_second_on_in_seconds_with_two_decimals() {
        let ms = Duration::from_millis;
        assert_eq!(format_elapsed(Duration::from_micros(400)), "0 ms");
        assert_eq!(format_elapsed(ms(12)), "12 ms");
        assert_eq!(format_elapsed(ms(999)), "999 ms");
        assert_eq!(format_elapsed(ms(1000)), "1.00 秒");
        assert_eq!(format_elapsed(ms(1259)), "1.25 秒");
        assert_eq!(format_elapsed(ms(30_000)), "30.00 秒");
    }

    #[test]
    fn the_line_under_the_table_has_the_rows_and_the_time_and_says_where_the_rows_were_cut() {
        let ms = Duration::from_millis;
        assert_eq!(format_summary(0, false, 0, ms(3)), "0 行 / 3 ms");
        assert_eq!(format_summary(1, false, 0, ms(40)), "1 行 / 40 ms");
        assert_eq!(format_summary(999, false, 0, ms(1500)), "999 行 / 1.50 秒");
        assert_eq!(
            format_summary(ROWS_MAX, true, 0, ms(120)),
            "先頭の 1,000 行だけを表示しています（残りは読み込んでいません） / 120 ms"
        );
    }

    #[test]
    fn a_statement_with_no_row_is_told_by_the_rows_it_changed() {
        let ms = Duration::from_millis;
        assert_eq!(format_summary(0, false, 3, ms(12)), "3 行を変更 / 12 ms");
        assert_eq!(
            format_summary(0, false, 1, ms(1500)),
            "1 行を変更 / 1.50 秒"
        );
        assert_eq!(
            format_summary(0, false, 12_345, ms(7)),
            "12,345 行を変更 / 7 ms"
        );
        // Rows that were read are told as rows, whatever the server says it affected.
        assert_eq!(format_summary(2, false, 5, ms(12)), "2 行 / 12 ms");
        assert_eq!(
            format_summary(ROWS_MAX, true, 5, ms(120)),
            "先頭の 1,000 行だけを表示しています（残りは読み込んでいません） / 120 ms"
        );
        // A statement that changed none is the same line as a SELECT that found none.
        assert_eq!(format_summary(0, false, 0, ms(3)), "0 行 / 3 ms");
    }

    #[test]
    fn a_refused_write_is_told_in_japanese_with_the_number_and_the_message_of_the_server() {
        let text = server_message(1792, "Cannot execute statement in a READ ONLY transaction.");
        assert_eq!(
            text,
            "読み取り専用のトランザクションの中のため、データを書き換える文は実行できません (1792): Cannot execute statement in a READ ONLY transaction."
        );
        assert_eq!(
            server_message(1290, "--read-only"),
            "MySQL サーバーが読み取り専用のため、データを書き換える文は実行できません (1290): --read-only"
        );
    }

    #[test]
    fn the_other_errors_of_a_statement_are_told_in_japanese_too() {
        let cases = [
            (1044, "このユーザーには、この操作の権限がありません"),
            (1142, "このユーザーには、この操作の権限がありません"),
            (1143, "このユーザーには、この操作の権限がありません"),
            (1227, "このユーザーには、この操作の権限がありません"),
            (
                1064,
                "SQL の文法が正しくありません。1 回に実行できる文は 1 つです",
            ),
            (1295, "この種類の文は実行できません"),
            (1049, "データベースが見つかりません"),
            (1146, "テーブルが見つかりません"),
            (1054, "列が見つかりません"),
            (1317, "実行が中断されました"),
            (3024, "実行が 30 秒を超えたため、MySQL が止めました"),
            (1234, "MySQL がエラーを返しました"),
        ];
        for (number, words) in cases {
            assert_eq!(
                server_message(number, "m"),
                format!("{words} ({number}): m"),
                "{number}"
            );
        }
    }

    #[test]
    fn a_long_message_of_the_server_is_cut() {
        let text = server_message(1064, &"あ".repeat(1000));
        assert!(text.ends_with('…') && text.chars().count() < 400);
    }

    #[test]
    fn a_run_that_failed_without_an_answer_of_the_server_is_worded_as_every_query_is() {
        let broken = failure(&sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "broken pipe",
        )));
        assert!(broken.lost);
        assert!(broken.message.starts_with("MySQL との接続が切れました"));
        let other = failure(&sqlx::Error::RowNotFound);
        assert!(!other.lost);
        assert!(other.message.starts_with("問い合わせに失敗しました"));
    }

    #[tokio::test]
    async fn the_rows_are_kept_up_to_the_limit_and_one_more_is_all_that_is_read() {
        let pulled = AtomicUsize::new(0);
        let source = stream::iter(0..).map(|n| {
            pulled.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(n)
        });
        let (items, truncated) = collect_limited(Box::pin(source), 3).await.unwrap();
        assert_eq!(items, [0, 1, 2]);
        assert!(truncated);
        assert_eq!(pulled.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn a_result_of_exactly_the_limit_is_not_cut() {
        let rows = |n: usize| stream::iter((0..n).map(Ok::<_, String>));
        assert_eq!(
            collect_limited(Box::pin(rows(3)), 3).await,
            Ok((vec![0, 1, 2], false))
        );
        assert_eq!(
            collect_limited(Box::pin(rows(4)), 3).await,
            Ok((vec![0, 1, 2], true))
        );
        assert_eq!(
            collect_limited(Box::pin(rows(0)), 3).await,
            Ok((vec![], false))
        );
    }

    #[tokio::test]
    async fn an_error_in_the_stream_ends_the_read_with_that_error() {
        let source = stream::iter(vec![Ok(1), Err("broken".to_owned()), Ok(3)]);
        assert_eq!(
            collect_limited(Box::pin(source), 10).await,
            Err("broken".to_owned())
        );
    }
}
