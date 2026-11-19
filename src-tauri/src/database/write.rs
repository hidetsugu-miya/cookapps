//! The write of the records tab (D-4, #863): the inserts, updates and deletes that the screen has gathered, run in one transaction.
//!
//! `database_apply` takes the list of changes in the order the screen made them. Nothing is sent to MySQL before it: the screen holds them until its confirm button.
//! Rust does not take the screen's word for what the table is. Inside the session it reads the columns (`information_schema.COLUMNS`) and the key (`records::read_key`) of the table, and `plan` turns the changes into statements against them:
//! - A column that the table does not have, a binary column, a key that is not the table's key, a value that is not a number for a number column, and an update or a delete on a table with no key are refused in Japanese, before anything is run.
//! - The names of the database, the table and the columns are put in the text between backticks (`records::quote_identifier`); every value, the key's too, is bound. NULL (`None`) and the empty text (`Some("")`) are told apart.
//! - An update and a delete find their row by the key's columns and end with `LIMIT 1`; the rows MySQL says it matched (`CLIENT_FOUND_ROWS`, which sqlx sets) must be exactly 1, or everything is rolled back (`run_all`).
//! - The statements run in one transaction (`BEGIN`, then `COMMIT` when every one has run; any failure, a refusal included, is `ROLLBACK`). A run that is past the time of every query (`Sessions::apply`) closes the connection, which ends the transaction on the server.
//!
//! The checks of the input (`check_request`, `plan`, `check_affected`) and the words of a failure (`failure`) are pure functions.

use serde::{Deserialize, Serialize};
use sqlx::{
    mysql::{MySqlArguments, MySqlConnection, MySqlDatabaseError},
    query::Query,
    AssertSqlSafe, Connection, MySql,
};
#[cfg(test)]
use ts_rs::TS;

use super::{
    mysql::{query_failure, shorten, QueryFailure},
    records::{quote_identifier, read_key},
};

/// The changes of one call. The screen gathers them by hand, so this is far above what a person makes.
pub const CHANGES_MAX: usize = 1000;
/// The longest name of a database, a table or a column that MySQL has, in characters.
const NAME_MAX: usize = 64;
/// The longest value of a cell, in characters.
const VALUE_MAX: usize = 1_000_000;
/// The columns of the table bound to the two `?` (its schema and its name): the name, the type (`bigint`, `varchar`) and the full type (`bigint unsigned`), in the order of the table.
const COLUMNS: &str = "SELECT CAST(COLUMN_NAME AS CHAR), CAST(DATA_TYPE AS CHAR), CAST(COLUMN_TYPE AS CHAR) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION";
/// What a run that the app stopped at the time of every query tells: the transaction ended with the connection, unless the server had its `COMMIT` already.
pub const TIMED_OUT: &str = "書き込みが時間内に終わらなかったため、MySQL との接続を閉じました。変更は確定していない場合が多いですが、確定している場合もあります。レコードを読み直して確かめてください";
const ROLLED_BACK: &str = "変更はすべて取り消しました";

/// A value of a column. `value` is none for NULL and the text otherwise (an empty text is `Some("")`, not NULL).
/// The `value` is required in the JSON (`Raw`), so that a value left out is an error and never a NULL.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct DatabaseValue {
    pub column: String,
    pub value: Option<String>,
}

/// `DatabaseValue` as it is read: `Option::deserialize` makes the field required, which `Option` alone does not.
#[derive(Deserialize)]
struct Raw {
    column: String,
    #[serde(deserialize_with = "Option::deserialize")]
    value: Option<String>,
}

impl<'de> Deserialize<'de> for DatabaseValue {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let Raw { column, value } = Raw::deserialize(deserializer)?;
        Ok(Self { column, value })
    }
}

/// One change of the table. An update and a delete name their row by the values of the table's key columns, which must be the whole key and not NULL.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DatabaseChange {
    /// A new row with these columns; a column that is not named takes its default.
    Insert { values: Vec<DatabaseValue> },
    /// The row with this key gets these new values.
    Update {
        key: Vec<DatabaseValue>,
        values: Vec<DatabaseValue>,
    },
    /// The row with this key goes.
    Delete { key: Vec<DatabaseValue> },
}

/// How many rows each kind of change wrote.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct DatabaseApplied {
    pub inserted: u32,
    pub updated: u32,
    pub deleted: u32,
}

/// A column of the table as the server has it: how its value is bound is decided by its type.
#[derive(Clone, Debug, PartialEq)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub unsigned: bool,
}

type ColumnRow = (String, String, String);

fn to_info((name, data_type, column_type): ColumnRow) -> ColumnInfo {
    ColumnInfo {
        name,
        data_type: data_type.to_ascii_lowercase(),
        unsigned: column_type.to_ascii_lowercase().contains("unsigned"),
    }
}

/// How the value of a column is bound. A number column takes its number, so that MySQL never compares or stores it through a string (a string and a number are compared as floating-point numbers, which cannot tell two large ids apart; a BIT takes a string as bytes).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Signed,
    Unsigned,
    Text,
    Binary,
}

fn kind_of(column: &ColumnInfo) -> Kind {
    match column.data_type.as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" if column.unsigned => {
            Kind::Unsigned
        }
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" => Kind::Signed,
        "bit" => Kind::Unsigned,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "geometry"
        | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geomcollection" | "geometrycollection" => Kind::Binary,
        _ => Kind::Text,
    }
}

/// A value to bind.
#[derive(Clone, Debug, PartialEq)]
pub enum Bind {
    Null,
    Signed(i64),
    Unsigned(u64),
    Text(String),
}

/// The kind of a change, for the count and the words.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Op {
    Insert,
    Update,
    Delete,
}

impl Op {
    fn word(self) -> &'static str {
        match self {
            Self::Insert => "追加",
            Self::Update => "更新",
            Self::Delete => "削除",
        }
    }
}

/// One statement of the transaction and the values bound to its `?`, in order.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub op: Op,
    pub sql: String,
    pub binds: Vec<Bind>,
}

fn names(columns: &[&str]) -> Vec<String> {
    columns.iter().map(|c| quote_identifier(c)).collect()
}

fn table_sql(database: &str, table: &str) -> String {
    format!("{}.{}", quote_identifier(database), quote_identifier(table))
}

fn where_sql(key: &[&str]) -> String {
    names(key)
        .iter()
        .map(|k| format!("{k} = ?"))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// ``INSERT INTO `db`.`t` (`a`, `b`) VALUES (?, ?)``; with no column, ``() VALUES ()``, which takes every default.
pub fn insert_sql(database: &str, table: &str, columns: &[&str]) -> String {
    format!(
        "INSERT INTO {} ({}) VALUES ({})",
        table_sql(database, table),
        names(columns).join(", "),
        vec!["?"; columns.len()].join(", ")
    )
}

/// ``UPDATE `db`.`t` SET `a` = ?, `b` = ? WHERE `k` = ? LIMIT 1``: the values of the columns to set come first, then the key's.
pub fn update_sql(database: &str, table: &str, set: &[&str], key: &[&str]) -> String {
    format!(
        "UPDATE {} SET {} WHERE {} LIMIT 1",
        table_sql(database, table),
        names(set)
            .iter()
            .map(|c| format!("{c} = ?"))
            .collect::<Vec<_>>()
            .join(", "),
        where_sql(key)
    )
}

/// ``DELETE FROM `db`.`t` WHERE `k` = ? LIMIT 1``.
pub fn delete_sql(database: &str, table: &str, key: &[&str]) -> String {
    format!(
        "DELETE FROM {} WHERE {} LIMIT 1",
        table_sql(database, table),
        where_sql(key)
    )
}

fn check_name(name: &str, what: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{what}の名前が空です"));
    }
    if name.chars().count() > NAME_MAX {
        return Err(format!(
            "{what}の名前が長すぎます（{NAME_MAX} 文字まで）: {}",
            shorten(name)
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(format!("{what}の名前に制御文字は使えません"));
    }
    Ok(())
}

fn check_value(column: &str, value: &Option<String>) -> Result<(), String> {
    let Some(text) = value else {
        return Ok(());
    };
    if text.chars().count() > VALUE_MAX {
        return Err(format!(
            "列 {column} の値が長すぎます（{VALUE_MAX} 文字まで）"
        ));
    }
    // A text may have line breaks and tabs, and no other control character (NUL included).
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(format!("列 {column} の値に使えない制御文字があります"));
    }
    Ok(())
}

fn check_values(values: &[DatabaseValue]) -> Result<(), String> {
    for (i, v) in values.iter().enumerate() {
        check_name(&v.column, "列")?;
        check_value(&v.column, &v.value)?;
        if values[..i].iter().any(|before| before.column == v.column) {
            return Err(format!("列 {} が 2 回あります", v.column));
        }
    }
    Ok(())
}

/// The input of `database_apply` before anything is read from the server: the names, the number of changes, every value, and that an update has something to set and an update and a delete have a key whose values are not NULL.
/// The first reason, in Japanese.
pub fn check_request(
    database: &str,
    table: &str,
    changes: &[DatabaseChange],
) -> Result<(), String> {
    check_name(database, "データベース")?;
    check_name(table, "テーブル")?;
    if changes.is_empty() {
        return Err("変更がありません".to_owned());
    }
    if changes.len() > CHANGES_MAX {
        return Err(format!(
            "変更が多すぎます（1 回に {CHANGES_MAX} 件まで）: {} 件",
            changes.len()
        ));
    }
    for change in changes {
        let (key, values) = match change {
            DatabaseChange::Insert { values } => (None, Some(values)),
            DatabaseChange::Update { key, values } => (Some(key), Some(values)),
            DatabaseChange::Delete { key } => (Some(key), None),
        };
        if let Some(key) = key {
            check_values(key)?;
            if key.is_empty() {
                return Err("更新と削除には、行を決める鍵の値が要ります".to_owned());
            }
            if let Some(null) = key.iter().find(|k| k.value.is_none()) {
                return Err(format!("鍵の列 {} の値が NULL です", null.column));
            }
        }
        if let Some(values) = values {
            check_values(values)?;
        }
        if matches!(change, DatabaseChange::Update { values, .. } if values.is_empty()) {
            return Err("更新する列がありません".to_owned());
        }
    }
    Ok(())
}

/// The value of `column` as the bind of its type; a number column that is given a text that is not its number is refused.
fn bind_of(column: &ColumnInfo, value: &Option<String>) -> Result<Bind, String> {
    let Some(text) = value else {
        return Ok(Bind::Null);
    };
    let not_a_number = || {
        format!(
            "列 {} は数の列ですが、値が数ではありません: {}",
            column.name,
            shorten(text)
        )
    };
    match kind_of(column) {
        Kind::Signed => text
            .trim()
            .parse::<i64>()
            .map(Bind::Signed)
            .map_err(|_| not_a_number()),
        Kind::Unsigned => text
            .trim()
            .parse::<u64>()
            .map(Bind::Unsigned)
            .map_err(|_| not_a_number()),
        Kind::Text => Ok(Bind::Text(text.clone())),
        Kind::Binary => Err(binary_refused(&column.name)),
    }
}

fn binary_refused(name: &str) -> String {
    format!("列 {name} はバイナリのため、書き換えられません")
}

/// The column named `name` of the table.
fn column_of<'a>(columns: &'a [ColumnInfo], name: &str) -> Result<&'a ColumnInfo, String> {
    columns
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| format!("列 {name} が表にありません。レコードを読み直してください"))
}

/// The columns and the binds of `values`, each against its column of the table.
fn bound<'a>(
    columns: &[ColumnInfo],
    values: &'a [DatabaseValue],
) -> Result<(Vec<&'a str>, Vec<Bind>), String> {
    let mut names = Vec::new();
    let mut binds = Vec::new();
    for v in values {
        let column = column_of(columns, &v.column)?;
        if kind_of(column) == Kind::Binary {
            return Err(binary_refused(&column.name));
        }
        binds.push(bind_of(column, &v.value)?);
        names.push(v.column.as_str());
    }
    Ok((names, binds))
}

/// The values of the key of a change, in the order of the table's key: they must be that key's columns exactly.
fn key_binds<'a>(
    columns: &[ColumnInfo],
    table_key: &'a [String],
    given: &[DatabaseValue],
) -> Result<(Vec<&'a str>, Vec<Bind>), String> {
    if table_key.is_empty() {
        return Err("この表には主キーも、NULL を許さないユニークキーもないため、更新と削除はできません（追加だけできます）".to_owned());
    }
    let same = given.len() == table_key.len()
        && table_key
            .iter()
            .all(|k| given.iter().any(|g| &g.column == k));
    if !same {
        return Err(
            "行を決める鍵の列が、表の鍵と合いません。レコードを読み直してください".to_owned(),
        );
    }
    let mut names = Vec::new();
    let mut binds = Vec::new();
    for k in table_key {
        let column = column_of(columns, k)?;
        if kind_of(column) == Kind::Binary {
            return Err(binary_refused(k));
        }
        let given = given.iter().find(|g| &g.column == k).map(|g| &g.value);
        binds.push(bind_of(column, given.unwrap_or(&None))?);
        names.push(k.as_str());
    }
    Ok((names, binds))
}

/// The statements for `changes` (already through `check_request`) on a table that has `columns` and the key `table_key`, in the order of the changes, or the first refusal.
pub fn plan(
    database: &str,
    table: &str,
    columns: &[ColumnInfo],
    table_key: &[String],
    changes: &[DatabaseChange],
) -> Result<Vec<Step>, String> {
    if columns.is_empty() {
        return Err("テーブルが見つかりません".to_owned());
    }
    changes
        .iter()
        .enumerate()
        .map(|(i, change)| {
            plan_one(database, table, columns, table_key, change)
                .map_err(|why| format!("{} 件目: {why}", i + 1))
        })
        .collect()
}

fn plan_one(
    database: &str,
    table: &str,
    columns: &[ColumnInfo],
    table_key: &[String],
    change: &DatabaseChange,
) -> Result<Step, String> {
    Ok(match change {
        DatabaseChange::Insert { values } => {
            let (set, binds) = bound(columns, values)?;
            Step {
                op: Op::Insert,
                sql: insert_sql(database, table, &set),
                binds,
            }
        }
        DatabaseChange::Update { key, values } => {
            let (key_names, key_binds) = key_binds(columns, table_key, key)?;
            let (set, mut binds) = bound(columns, values)?;
            binds.extend(key_binds);
            Step {
                op: Op::Update,
                sql: update_sql(database, table, &set, &key_names),
                binds,
            }
        }
        DatabaseChange::Delete { key } => {
            let (key_names, binds) = key_binds(columns, table_key, key)?;
            Step {
                op: Op::Delete,
                sql: delete_sql(database, table, &key_names),
                binds,
            }
        }
    })
}

/// An update and a delete name one row: they must have matched exactly one (`index` counts from 0).
pub fn check_affected(op: Op, index: usize, matched: u64) -> Result<(), String> {
    if op == Op::Insert || matched == 1 {
        return Ok(());
    }
    Err(format!(
        "{} 件目の{}で、対象の行が {matched} 行ありました（1 行のはずです）。{ROLLED_BACK}。レコードを読み直してください",
        index + 1,
        op.word()
    ))
}

/// The words of a number of an error that MySQL answered, for the writes; none for one that has no words of its own.
fn server_words(number: u16) -> Option<&'static str> {
    Some(match number {
        1062 => "同じ値がすでにあるため書き込めません（重複するキー）",
        1048 => "NULL にできない列に NULL は書き込めません",
        1364 => "値の指定がなく、既定値もない列があります",
        1406 | 1264 => "値がその列に入りきりません",
        1292 | 1366 | 1265 => "値がその列の型に合いません",
        1451 | 1452 => "他の表との参照の関係で書き込めません",
        3105 => "生成列には書き込めません",
        1792 => "読み取り専用のトランザクションの中のため、書き込めません",
        1290 => "MySQL サーバーが読み取り専用のため、書き込めません",
        1044 | 1142 | 1143 | 1227 => "このユーザーには、この操作の権限がありません",
        1049 => "データベースが見つかりません",
        1146 => "テーブルが見つかりません",
        1054 => "列が見つかりません",
        1205 | 1213 => "ほかの処理と競合したため書き込めません",
        _ => return None,
    })
}

/// What a write that failed is: an error that MySQL answered is told with its words and its number, and the transaction is rolled back; the others are the words of every query (`mysql::query_failure`).
pub fn failure(error: &sqlx::Error) -> QueryFailure {
    if let sqlx::Error::Database(db) = error {
        if let Some(e) = db.try_downcast_ref::<MySqlDatabaseError>() {
            let words = server_words(e.number()).unwrap_or("MySQL がエラーを返しました");
            return QueryFailure {
                message: format!(
                    "{words} ({}): {}。{ROLLED_BACK}",
                    e.number(),
                    shorten(e.message())
                ),
                lost: false,
            };
        }
    }
    query_failure(error)
}

fn bind_all<'q>(sql: &'q str, binds: &'q [Bind]) -> Query<'q, MySql, MySqlArguments> {
    let mut query = sqlx::query(AssertSqlSafe(sql.to_owned())).persistent(false);
    for bind in binds {
        query = match bind {
            Bind::Null => query.bind(None::<String>),
            Bind::Signed(n) => query.bind(*n),
            Bind::Unsigned(n) => query.bind(*n),
            Bind::Text(t) => query.bind(t.clone()),
        };
    }
    query
}

/// What runs a statement of the transaction and answers the rows MySQL says matched.
trait Runner {
    async fn run(&mut self, step: &Step) -> Result<u64, sqlx::Error>;
}

impl Runner for MySqlConnection {
    async fn run(&mut self, step: &Step) -> Result<u64, sqlx::Error> {
        Ok(bind_all(&step.sql, &step.binds)
            .execute(&mut *self)
            .await?
            .rows_affected())
    }
}

/// Runs the steps in order and stops at the first that fails or matches the wrong number of rows: the failure is the outer error, a refusal is the inner. Nothing after it is run.
/// The caller commits only when this answers `Ok(Ok(_))`, and rolls back in every other case.
async fn run_all<R: Runner>(
    runner: &mut R,
    steps: &[Step],
) -> Result<Result<DatabaseApplied, String>, sqlx::Error> {
    let mut applied = DatabaseApplied::default();
    for (i, step) in steps.iter().enumerate() {
        let matched = runner.run(step).await?;
        if let Err(why) = check_affected(step.op, i, matched) {
            return Ok(Err(why));
        }
        match step.op {
            Op::Insert => applied.inserted += 1,
            Op::Update => applied.updated += 1,
            Op::Delete => applied.deleted += 1,
        }
    }
    Ok(Ok(applied))
}

/// Writes `changes` to `database`.`table` on the session in one transaction (`check_request` has passed already).
/// The columns and the key of the table are read first, and a refusal of `plan` is answered before the transaction begins.
/// The answer is `Err` for a failure of the session or of MySQL, and `Ok(Err(_))` for a refusal and for a wrong number of rows, with the transaction rolled back in both.
pub async fn apply(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
    changes: &[DatabaseChange],
) -> Result<Result<DatabaseApplied, String>, sqlx::Error> {
    let columns: Vec<ColumnInfo> = sqlx::query_as::<_, ColumnRow>(COLUMNS)
        .bind(database)
        .bind(table)
        .fetch_all(&mut *connection)
        .await?
        .into_iter()
        .map(to_info)
        .collect();
    let key = read_key(connection, database, table).await?;
    let steps = match plan(database, table, &columns, &key, changes) {
        Ok(steps) => steps,
        Err(why) => return Ok(Err(why)),
    };
    let mut transaction = connection.begin().await?;
    let done = run_all(&mut *transaction, &steps).await;
    if matches!(done, Ok(Ok(_))) {
        transaction.commit().await?;
    } else {
        // The error that ended the run is the one told; a rollback that fails too leaves the session broken, which the next use shows.
        let _ = transaction.rollback().await;
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(column: &str, value: Option<&str>) -> DatabaseValue {
        DatabaseValue {
            column: column.to_owned(),
            value: value.map(str::to_owned),
        }
    }

    fn column(name: &str, data_type: &str, column_type: &str) -> ColumnInfo {
        to_info((
            name.to_owned(),
            data_type.to_owned(),
            column_type.to_owned(),
        ))
    }

    fn shop() -> Vec<ColumnInfo> {
        vec![
            column("id", "bigint", "bigint unsigned"),
            column("name", "varchar", "varchar(20)"),
            column("qty", "int", "int"),
            column("photo", "blob", "blob"),
            column("flags", "bit", "bit(8)"),
        ]
    }

    fn id_key() -> Vec<String> {
        vec!["id".to_owned()]
    }

    #[test]
    fn the_statements_have_the_names_quoted_and_every_value_as_a_question_mark() {
        assert_eq!(
            insert_sql("shop", "orders", &["id", "na`me"]),
            "INSERT INTO `shop`.`orders` (`id`, `na``me`) VALUES (?, ?)"
        );
        assert_eq!(
            insert_sql("shop", "orders", &[]),
            "INSERT INTO `shop`.`orders` () VALUES ()"
        );
        assert_eq!(
            update_sql("shop", "orders", &["name", "qty"], &["id"]),
            "UPDATE `shop`.`orders` SET `name` = ?, `qty` = ? WHERE `id` = ? LIMIT 1"
        );
        assert_eq!(
            update_sql("sh`op", "or ders", &["a"], &["k1", "k2"]),
            "UPDATE `sh``op`.`or ders` SET `a` = ? WHERE `k1` = ? AND `k2` = ? LIMIT 1"
        );
        assert_eq!(
            delete_sql("shop", "orders", &["id"]),
            "DELETE FROM `shop`.`orders` WHERE `id` = ? LIMIT 1"
        );
        // A name that looks like SQL stays inside its backticks, and no value is in the text.
        let sql = update_sql("shop", "orders", &["x`; DROP TABLE y; --"], &["id"]);
        assert_eq!(
            sql,
            "UPDATE `shop`.`orders` SET `x``; DROP TABLE y; --` = ? WHERE `id` = ? LIMIT 1"
        );
        assert_eq!(COLUMNS.matches('?').count(), 2);
    }

    #[test]
    fn a_plan_binds_the_values_first_and_the_key_after_them_and_tells_null_from_empty() {
        let changes = vec![
            DatabaseChange::Insert {
                values: vec![value("name", Some("")), value("qty", None)],
            },
            DatabaseChange::Update {
                key: vec![value("id", Some("7"))],
                values: vec![value("name", Some("NULL")), value("qty", Some("-3"))],
            },
            DatabaseChange::Delete {
                key: vec![value("id", Some("9007199254740993"))],
            },
        ];
        let steps = plan("shop", "orders", &shop(), &id_key(), &changes).unwrap();
        assert_eq!(
            steps,
            vec![
                Step {
                    op: Op::Insert,
                    sql: "INSERT INTO `shop`.`orders` (`name`, `qty`) VALUES (?, ?)".to_owned(),
                    binds: vec![Bind::Text(String::new()), Bind::Null],
                },
                Step {
                    op: Op::Update,
                    sql: "UPDATE `shop`.`orders` SET `name` = ?, `qty` = ? WHERE `id` = ? LIMIT 1"
                        .to_owned(),
                    binds: vec![
                        Bind::Text("NULL".to_owned()),
                        Bind::Signed(-3),
                        Bind::Unsigned(7)
                    ],
                },
                Step {
                    op: Op::Delete,
                    sql: "DELETE FROM `shop`.`orders` WHERE `id` = ? LIMIT 1".to_owned(),
                    binds: vec![Bind::Unsigned(9_007_199_254_740_993)],
                },
            ]
        );
    }

    #[test]
    fn a_composite_key_is_in_the_order_of_the_table_whatever_order_the_screen_gave() {
        let columns = vec![
            column("a", "int", "int"),
            column("b", "varchar", "varchar(5)"),
            column("c", "text", "text"),
        ];
        let key = vec!["a".to_owned(), "b".to_owned()];
        let change = DatabaseChange::Update {
            key: vec![value("b", Some("x")), value("a", Some("1"))],
            values: vec![value("c", Some("new"))],
        };
        let steps = plan("d", "t", &columns, &key, &[change]).unwrap();
        assert_eq!(
            steps[0].sql,
            "UPDATE `d`.`t` SET `c` = ? WHERE `a` = ? AND `b` = ? LIMIT 1"
        );
        assert_eq!(
            steps[0].binds,
            vec![
                Bind::Text("new".to_owned()),
                Bind::Signed(1),
                Bind::Text("x".to_owned())
            ]
        );
    }

    #[test]
    fn a_table_with_no_key_takes_inserts_only() {
        let update = DatabaseChange::Update {
            key: vec![value("id", Some("1"))],
            values: vec![value("name", Some("a"))],
        };
        let delete = DatabaseChange::Delete {
            key: vec![value("id", Some("1"))],
        };
        for change in [update, delete] {
            let why = plan("shop", "log", &shop(), &[], &[change]).unwrap_err();
            assert!(why.starts_with("1 件目: この表には主キーも"), "{why}");
            assert!(why.contains("追加だけできます"));
        }
        let insert = DatabaseChange::Insert {
            values: vec![value("name", Some("a"))],
        };
        assert!(plan("shop", "log", &shop(), &[], &[insert]).is_ok());
    }

    #[test]
    fn a_key_that_is_not_the_tables_key_is_refused() {
        let wrong = |key: Vec<DatabaseValue>| {
            plan(
                "shop",
                "orders",
                &shop(),
                &id_key(),
                &[DatabaseChange::Delete { key }],
            )
            .unwrap_err()
        };
        for key in [
            vec![value("name", Some("a"))],
            vec![value("id", Some("1")), value("name", Some("a"))],
        ] {
            assert!(wrong(key).contains("鍵の列が、表の鍵と合いません"));
        }
        // a key with a NULL, an empty key and an update with nothing to set are refused before the server is read
        let refuse = |change| check_request("shop", "orders", &[change]).unwrap_err();
        assert_eq!(
            refuse(DatabaseChange::Delete {
                key: vec![value("id", None)]
            }),
            "鍵の列 id の値が NULL です"
        );
        assert_eq!(
            refuse(DatabaseChange::Delete { key: vec![] }),
            "更新と削除には、行を決める鍵の値が要ります"
        );
        assert_eq!(
            refuse(DatabaseChange::Update {
                key: vec![value("id", Some("1"))],
                values: vec![]
            }),
            "更新する列がありません"
        );
    }

    #[test]
    fn a_column_the_table_lacks_a_binary_column_and_a_value_that_is_not_a_number_are_refused() {
        let insert = |v: DatabaseValue| DatabaseChange::Insert { values: vec![v] };
        let why = |v| plan("shop", "orders", &shop(), &id_key(), &[insert(v)]).unwrap_err();
        assert!(why(value("nope", Some("a"))).contains("列 nope が表にありません"));
        assert!(why(value("photo", Some("a"))).contains("列 photo はバイナリのため"));
        assert!(why(value("photo", None)).contains("列 photo はバイナリのため"));
        assert!(why(value("qty", Some("abc"))).contains("列 qty は数の列ですが"));
        assert!(why(value("qty", Some(""))).contains("列 qty は数の列ですが"));
        assert!(why(value("id", Some("-1"))).contains("列 id は数の列ですが"));
        assert!(why(value("qty", Some("2147483648.5"))).contains("列 qty は数の列ですが"));
        // a binary column in the key is refused too
        let columns = vec![column("k", "varbinary", "varbinary(8)")];
        let key = vec!["k".to_owned()];
        let delete = DatabaseChange::Delete {
            key: vec![value("k", Some("a"))],
        };
        assert!(plan("d", "t", &columns, &key, &[delete])
            .unwrap_err()
            .contains("列 k はバイナリのため"));
        // a table the server does not know has no column
        assert_eq!(
            plan("d", "t", &[], &[], &[insert(value("a", None))]).unwrap_err(),
            "テーブルが見つかりません"
        );
        // the number of the change is in the words
        let two = vec![
            insert(value("name", Some("ok"))),
            insert(value("nope", Some("x"))),
        ];
        assert!(plan("shop", "orders", &shop(), &id_key(), &two)
            .unwrap_err()
            .starts_with("2 件目: "));
    }

    #[test]
    fn a_number_column_binds_its_number_and_a_bit_binds_a_number_not_bytes() {
        let kind = |name: &str, full: &str| kind_of(&column("c", name, full));
        assert_eq!(kind("bigint", "bigint"), Kind::Signed);
        assert_eq!(kind("bigint", "bigint unsigned"), Kind::Unsigned);
        assert_eq!(kind("tinyint", "tinyint(1)"), Kind::Signed);
        assert_eq!(kind("int", "int(10) unsigned zerofill"), Kind::Unsigned);
        assert_eq!(kind("bit", "bit(8)"), Kind::Unsigned);
        for text in [
            "varchar", "text", "decimal", "double", "datetime", "json", "enum",
        ] {
            assert_eq!(kind(text, text), Kind::Text, "{text}");
        }
        for binary in [
            "binary",
            "blob",
            "longblob",
            "geometry",
            "point",
            "varbinary",
        ] {
            assert_eq!(kind(binary, binary), Kind::Binary, "{binary}");
        }
        let flags = column("flags", "bit", "bit(8)");
        assert_eq!(
            bind_of(&flags, &Some("5".to_owned())),
            Ok(Bind::Unsigned(5))
        );
        let big = column("id", "bigint", "bigint");
        assert_eq!(
            bind_of(&big, &Some("-9223372036854775808".to_owned())),
            Ok(Bind::Signed(i64::MIN))
        );
        assert!(bind_of(&big, &Some("9223372036854775808".to_owned())).is_err());
        assert_eq!(bind_of(&big, &None), Ok(Bind::Null));
    }

    #[test]
    fn the_input_is_checked_for_its_names_its_values_and_the_number_of_changes() {
        let one = |v: DatabaseValue| vec![DatabaseChange::Insert { values: vec![v] }];
        assert_eq!(
            check_request("shop", "orders", &one(value("a", None))),
            Ok(())
        );
        assert_eq!(
            check_request("shop", "orders", &[]),
            Err("変更がありません".to_owned())
        );
        let bad = |db: &str, table: &str, v: DatabaseValue| {
            check_request(db, table, &one(v)).unwrap_err()
        };
        assert_eq!(bad("", "t", value("a", None)), "データベースの名前が空です");
        assert_eq!(bad("d", "", value("a", None)), "テーブルの名前が空です");
        assert!(bad(&"x".repeat(65), "t", value("a", None)).contains("長すぎます"));
        assert!(check_request(&"x".repeat(64), "t", &one(value("a", None))).is_ok());
        assert_eq!(
            bad("d\n", "t", value("a", None)),
            "データベースの名前に制御文字は使えません"
        );
        assert_eq!(
            bad("d", "t\0", value("a", None)),
            "テーブルの名前に制御文字は使えません"
        );
        assert_eq!(bad("d", "t", value("", None)), "列の名前が空です");
        assert_eq!(
            bad("d", "t", value("a\tb", None)),
            "列の名前に制御文字は使えません"
        );
        // a value may hold line breaks and tabs, and nothing else of the control characters
        assert!(check_request("d", "t", &one(value("a", Some("l1\r\nl2\t")))).is_ok());
        for text in ["a\0b", "a\u{7}", "a\u{1b}[0m", "a\u{85}"] {
            assert_eq!(
                bad("d", "t", value("a", Some(text))),
                "列 a の値に使えない制御文字があります",
                "{text:?}"
            );
        }
        assert!(check_request("d", "t", &one(value("a", Some(&"あ".repeat(VALUE_MAX))))).is_ok());
        assert!(bad("d", "t", value("a", Some(&"あ".repeat(VALUE_MAX + 1)))).contains("長すぎます"));
        let twice = DatabaseChange::Insert {
            values: vec![value("a", None), value("a", Some("1"))],
        };
        assert_eq!(
            check_request("d", "t", &[twice]),
            Err("列 a が 2 回あります".to_owned())
        );
        let many = vec![DatabaseChange::Insert { values: vec![] }; CHANGES_MAX + 1];
        assert!(check_request("d", "t", &many)
            .unwrap_err()
            .contains("多すぎます"));
        assert!(check_request("d", "t", &many[..CHANGES_MAX]).is_ok());
    }

    #[test]
    fn an_update_and_a_delete_must_match_one_row_and_an_insert_is_not_counted() {
        assert_eq!(check_affected(Op::Update, 0, 1), Ok(()));
        assert_eq!(check_affected(Op::Delete, 3, 1), Ok(()));
        assert_eq!(check_affected(Op::Insert, 0, 1), Ok(()));
        assert_eq!(check_affected(Op::Insert, 0, 0), Ok(()));
        let none = check_affected(Op::Update, 2, 0).unwrap_err();
        assert!(none.starts_with("3 件目の更新で、対象の行が 0 行ありました"));
        assert!(none.contains("変更はすべて取り消しました"));
        assert!(check_affected(Op::Delete, 0, 2)
            .unwrap_err()
            .starts_with("1 件目の削除で、対象の行が 2 行ありました"));
    }

    /// Answers each statement with the next number of the list and keeps what it was asked.
    struct Fake {
        matched: Vec<u64>,
        ran: Vec<String>,
        fail_at: Option<usize>,
    }

    impl Runner for Fake {
        async fn run(&mut self, step: &Step) -> Result<u64, sqlx::Error> {
            if self.fail_at == Some(self.ran.len()) {
                return Err(sqlx::Error::PoolClosed);
            }
            self.ran.push(step.sql.clone());
            Ok(self.matched[self.ran.len() - 1])
        }
    }

    fn steps(ops: &[Op]) -> Vec<Step> {
        ops.iter()
            .enumerate()
            .map(|(i, op)| Step {
                op: *op,
                sql: format!("statement {i}"),
                binds: vec![],
            })
            .collect()
    }

    #[tokio::test]
    async fn the_steps_run_in_order_and_are_counted_by_their_kind() {
        let mut fake = Fake {
            matched: vec![1, 1, 1, 1],
            ran: vec![],
            fail_at: None,
        };
        let done = run_all(
            &mut fake,
            &steps(&[Op::Insert, Op::Update, Op::Delete, Op::Insert]),
        )
        .await
        .unwrap();
        assert_eq!(
            done,
            Ok(DatabaseApplied {
                inserted: 2,
                updated: 1,
                deleted: 1
            })
        );
        assert_eq!(fake.ran.len(), 4);
        assert_eq!(fake.ran[0], "statement 0");
    }

    #[tokio::test]
    async fn a_step_that_does_not_match_one_row_stops_the_run_and_nothing_after_it_is_run() {
        let mut fake = Fake {
            matched: vec![1, 0, 1],
            ran: vec![],
            fail_at: None,
        };
        let done = run_all(&mut fake, &steps(&[Op::Insert, Op::Update, Op::Delete]))
            .await
            .unwrap();
        // the caller rolls back on this answer (it commits only on Ok(Ok(_)))
        assert!(done.unwrap_err().starts_with("2 件目の更新で"));
        assert_eq!(fake.ran.len(), 2);
    }

    #[tokio::test]
    async fn a_step_that_fails_stops_the_run_with_its_error() {
        let mut fake = Fake {
            matched: vec![1, 1, 1],
            ran: vec![],
            fail_at: Some(1),
        };
        let done = run_all(&mut fake, &steps(&[Op::Update, Op::Delete, Op::Insert])).await;
        assert!(matches!(done, Err(sqlx::Error::PoolClosed)));
        assert_eq!(fake.ran.len(), 1);
    }

    #[test]
    fn the_value_of_a_change_is_required_in_the_json_and_null_is_not_a_missing_value() {
        let change: DatabaseChange = serde_json::from_str(
            r#"{"kind":"update","key":[{"column":"id","value":"1"}],"values":[{"column":"a","value":null},{"column":"b","value":""}]}"#,
        )
        .unwrap();
        let DatabaseChange::Update { values, .. } = change else {
            panic!("an update");
        };
        assert_eq!(values[0].value, None);
        assert_eq!(values[1].value, Some(String::new()));
        // a value that is left out is an error, never a NULL
        assert!(serde_json::from_str::<DatabaseChange>(
            r#"{"kind":"delete","key":[{"column":"id"}]}"#
        )
        .is_err());
        assert!(serde_json::from_str::<DatabaseChange>(r#"{"kind":"truncate"}"#).is_err());
    }

    #[test]
    fn a_failure_is_in_japanese_with_the_rollback_and_a_lost_session_is_not_a_rollback_word() {
        let lost = failure(&sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "broken pipe",
        )));
        assert!(lost.lost);
        assert!(lost.message.starts_with("MySQL との接続が切れました"));
        assert!(server_words(1062).is_some_and(|w| w.contains("重複")));
        assert_eq!(server_words(9999), None);
        assert!(TIMED_OUT.contains("確定している場合もあります"));
    }
}
