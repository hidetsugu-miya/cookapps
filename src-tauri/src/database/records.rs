//! The records of a table (D-4, #633): one page of ``SELECT * FROM `db`.`table` LIMIT ? OFFSET ?``, and each value of it turned into text here.
//!
//! The names of the database and of the table are put in the SQL text between backticks (a backtick inside is doubled, `quote_identifier`), and the limit and the offset are bound.
//! The statement is a prepared one, so the rows come in the binary protocol: the value of a column is its type's binary form (an integer is its little-endian bytes, a DATETIME is a length and its parts, a DECIMAL and a JSON are their text).
//! `cell_of` is the one place that turns it into what the screen draws, from the name of the column's type (`TypeInfo::name`) and the bytes, and it never fails: bytes that do not fit their type are told as binary.
//! A NULL is the text "NULL", a binary value is its length only, and a text longer than `TEXT_MAX` characters is cut with "…" (the rest is kept nowhere).
//! The SQL tab (#635) draws its result with the same cells.
//!
//! The answer also tells what the screen may write back (#863): the columns that name one row (`key`, chosen by `choose_key` from the unique indexes of `information_schema.STATISTICS`),
//! and for each row which cells can be written (`is_editable`: not binary, not a text that was cut) and whether the row can be updated or deleted at all (`row_edit`: the table has a key, and the cell of each key column can be written).

use std::borrow::Cow;

use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::{
    mysql::{MySqlConnection, MySqlRow},
    Column, Row, TypeInfo,
};
#[cfg(test)]
use ts_rs::TS;

use super::{
    session::{format_bytes, format_rows},
    sql::{collect_limited, column_names},
};

/// The rows of a page. One more is read to know that a next page exists.
pub const PAGE_SIZE: u64 = 100;
/// The characters of a text that a cell keeps.
pub const TEXT_MAX: usize = 200;
/// The columns of the unique indexes of the table bound to the two `?` (its schema and its name), one row for each column of an index: the name of the index, the place of the column in it, the column (none for an expression of MySQL 8) and `NULLABLE` (`YES` or empty).
const KEYS: &str = "SELECT CAST(INDEX_NAME AS CHAR), CAST(SEQ_IN_INDEX AS UNSIGNED), CAST(COLUMN_NAME AS CHAR), CAST(NULLABLE AS CHAR) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0";
/// The name MySQL gives the primary key.
const PRIMARY: &str = "PRIMARY";
/// The estimated number of rows of the table bound to the two `?`: its schema and its name.
const ESTIMATE: &str = "SELECT CAST(TABLE_ROWS AS UNSIGNED) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";

/// How the screen draws a value: a number is at the right, NULL and binary are in a quiet color.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum DatabaseCellKind {
    Null,
    Number,
    Text,
    Binary,
}

/// A value as text, ready to draw.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct DatabaseCell {
    pub kind: DatabaseCellKind,
    pub text: String,
}

/// One page of a table. `page` counts from 0; `summary` is the range and the estimated rows, worded for the footer.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRecords {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<DatabaseCell>>,
    pub page: u32,
    pub has_more: bool,
    /// The estimated rows of the table (none for a view). Read with the page 0 only; a later page is given the one the screen holds (`read`'s `known`) and answers it again.
    #[cfg_attr(test, ts(type = "number | null"))]
    pub estimate: Option<u64>,
    pub summary: String,
    /// The last page (from 0) that the estimate gives; none for a view, a stale estimate and a page with no row (`last_page`).
    pub last_page: Option<u32>,
    /// The number of pages worded for the footer, "/ 約 12" (`format_pages`); empty when `last_page` is none.
    pub pages: String,
    /// The page as the copy button copies it (`cells_tsv`, #668).
    pub tsv: String,
    /// The columns that name one row: the primary key, else the columns of a unique key that none of them may be NULL; empty when the table has neither (`choose_key`).
    pub key: Vec<String>,
    /// What can be written back, one for each row of `rows` (`row_edit`).
    pub edits: Vec<DatabaseRowEdit>,
}

/// What can be written back of one row (#863).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowEdit {
    /// The row can be updated and deleted: the table has a key, and the cell of each of its columns is whole (not cut, not binary).
    pub can_change: bool,
    /// For each cell of the row: its value can be written. A text cut at `TEXT_MAX` characters and a binary value cannot, as their full values are kept nowhere.
    pub cells: Vec<bool>,
}

/// A name of the database or of a table or column, quoted for the SQL text: between backticks, a backtick inside doubled.
pub fn quote_identifier(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// The statement of a page. Its two `?` are the limit and the offset.
pub fn records_sql(database: &str, table: &str) -> String {
    format!(
        "SELECT * FROM {}.{} LIMIT ? OFFSET ?",
        quote_identifier(database),
        quote_identifier(table)
    )
}

fn cell(kind: DatabaseCellKind, text: String) -> DatabaseCell {
    DatabaseCell { kind, text }
}

fn binary_cell(length: usize) -> DatabaseCell {
    cell(
        DatabaseCellKind::Binary,
        format!("バイナリ {}", format_bytes(length as u64)),
    )
}

/// `text` cut to `TEXT_MAX` characters, with "…" where it was cut.
pub fn cut_text(text: &str) -> String {
    match text.char_indices().nth(TEXT_MAX) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

/// Whether `cell` holds the whole value, so that it can be written back: a NULL, a number and a text that was not cut can; binary and a cut text (`TEXT_MAX` characters and the "…") cannot.
/// An uncut text has at most `TEXT_MAX` characters, so one with more was cut.
pub fn is_editable(cell: &DatabaseCell) -> bool {
    match cell.kind {
        DatabaseCellKind::Binary => false,
        DatabaseCellKind::Text => cell.text.chars().nth(TEXT_MAX).is_none(),
        DatabaseCellKind::Null | DatabaseCellKind::Number => true,
    }
}

/// What can be written back of `row`, whose cells are those of `columns`, when the table's key is `key`.
/// A row can be changed only when the table has a key and the cell of each key column is there, whole and not NULL.
pub fn row_edit(columns: &[String], key: &[String], row: &[DatabaseCell]) -> DatabaseRowEdit {
    let cells: Vec<bool> = row.iter().map(is_editable).collect();
    let can_change = !key.is_empty()
        && key.iter().all(|name| {
            columns
                .iter()
                .position(|c| c == name)
                .is_some_and(|i| cells[i] && row[i].kind != DatabaseCellKind::Null)
        });
    DatabaseRowEdit { can_change, cells }
}

/// One column of a unique index, as `KEYS` answers it: the name of the index, the place of the column in it, the column and `NULLABLE`.
pub type KeyRow = (String, u64, Option<String>, Option<String>);

/// The columns that name one row, from the columns of the unique indexes: the primary key, else the unique key with the fewest columns (the first by name when they are as many) that none of them may be NULL; empty for none.
/// An index with an expression in it (no column name) or a column that may be NULL does not name a row: two rows may hold NULL there. The columns are in the order of the index.
pub fn choose_key(rows: &[KeyRow]) -> Vec<String> {
    let mut names: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    let columns_of = |name: &str| -> Option<Vec<String>> {
        let mut entries: Vec<&KeyRow> = rows.iter().filter(|r| r.0 == name).collect();
        entries.sort_by_key(|r| r.1);
        entries
            .iter()
            .map(|(_, _, column, nullable)| {
                column
                    .clone()
                    .filter(|_| nullable.as_deref() != Some("YES"))
            })
            .collect()
    };
    let usable: Vec<(&str, Vec<String>)> = names
        .into_iter()
        .filter_map(|name| columns_of(name).map(|columns| (name, columns)))
        .filter(|(_, columns)| !columns.is_empty())
        .collect();
    if let Some((_, columns)) = usable.iter().find(|(name, _)| *name == PRIMARY) {
        return columns.clone();
    }
    usable
        .into_iter()
        .min_by_key(|(_, columns)| columns.len())
        .map(|(_, columns)| columns)
        .unwrap_or_default()
}

/// The key of `database`.`table` (`choose_key`), read on the session. A view has no index, so no key.
pub async fn read_key(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query_as::<_, KeyRow>(KEYS)
        .bind(database)
        .bind(table)
        .fetch_all(&mut *connection)
        .await?;
    Ok(choose_key(&rows))
}

fn array<const N: usize>(bytes: &[u8]) -> Option<[u8; N]> {
    bytes.try_into().ok()
}

/// A number type's binary form as its decimal text; none for another type or for bytes that are not its size.
fn number_text(type_name: &str, bytes: &[u8]) -> Option<String> {
    Some(match type_name {
        "BOOLEAN" | "TINYINT" => i8::from_le_bytes(array(bytes)?).to_string(),
        "TINYINT UNSIGNED" => u8::from_le_bytes(array(bytes)?).to_string(),
        "SMALLINT" => i16::from_le_bytes(array(bytes)?).to_string(),
        "SMALLINT UNSIGNED" => u16::from_le_bytes(array(bytes)?).to_string(),
        "INT" | "MEDIUMINT" => i32::from_le_bytes(array(bytes)?).to_string(),
        "INT UNSIGNED" | "MEDIUMINT UNSIGNED" => u32::from_le_bytes(array(bytes)?).to_string(),
        "BIGINT" => i64::from_le_bytes(array(bytes)?).to_string(),
        "BIGINT UNSIGNED" => u64::from_le_bytes(array(bytes)?).to_string(),
        "FLOAT" => f32::from_le_bytes(array(bytes)?).to_string(),
        "DOUBLE" => f64::from_le_bytes(array(bytes)?).to_string(),
        "YEAR" => format!("{:04}", u16::from_le_bytes(array(bytes)?)),
        // BIT(M) is the bits as big-endian bytes, at most 8 of them.
        "BIT" if !bytes.is_empty() && bytes.len() <= 8 => bytes
            .iter()
            .fold(0u64, |value, byte| (value << 8) | u64::from(*byte))
            .to_string(),
        "DECIMAL" => std::str::from_utf8(bytes).ok()?.to_owned(),
        _ => return None,
    })
}

/// The seconds' fraction of a DATETIME or a TIME as ".123", the trailing zeros cut; empty for none.
fn fraction(micros: u32) -> String {
    if micros == 0 {
        return String::new();
    }
    format!(".{micros:06}").trim_end_matches('0').to_owned()
}

fn date_text(year: u16, month: u8, day: u8) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

/// A DATE, DATETIME or TIMESTAMP: a length byte (0, 4, 7 or 11; DATE 0 or 4) and then the year (2 bytes, little-endian), the month, the day, the hour, the minute, the second and the microseconds (4 bytes, little-endian) as far as the length goes.
/// A length of 0 is the zero date.
fn datetime_text(type_name: &str, bytes: &[u8]) -> Option<String> {
    let (&length, parts) = bytes.split_first()?;
    let length = usize::from(length);
    if parts.len() != length || !matches!(length, 0 | 4 | 7 | 11) {
        return None;
    }
    let (year, month, day) = if length == 0 {
        (0, 0, 0)
    } else {
        (u16::from_le_bytes([parts[0], parts[1]]), parts[2], parts[3])
    };
    let date = date_text(year, month, day);
    if type_name == "DATE" {
        return (length <= 4).then_some(date);
    }
    let (hour, minute, second) = if length >= 7 {
        (parts[4], parts[5], parts[6])
    } else {
        (0, 0, 0)
    };
    let micros = if length == 11 {
        u32::from_le_bytes([parts[7], parts[8], parts[9], parts[10]])
    } else {
        0
    };
    Some(format!(
        "{date} {hour:02}:{minute:02}:{second:02}{}",
        fraction(micros)
    ))
}

/// A TIME: a length byte (0, 8 or 12), the sign (1 is negative), the days (4 bytes, little-endian), the hour, the minute, the second and the microseconds (4 bytes, little-endian). The days are in the hours, as MySQL shows it.
fn time_text(bytes: &[u8]) -> Option<String> {
    let (&length, parts) = bytes.split_first()?;
    let length = usize::from(length);
    if parts.len() != length || !matches!(length, 0 | 8 | 12) {
        return None;
    }
    if length == 0 {
        return Some("00:00:00".to_owned());
    }
    let sign = if parts[0] == 1 { "-" } else { "" };
    let days = u32::from_le_bytes([parts[1], parts[2], parts[3], parts[4]]);
    let hours = u64::from(days) * 24 + u64::from(parts[5]);
    let micros = if length == 12 {
        u32::from_le_bytes([parts[8], parts[9], parts[10], parts[11]])
    } else {
        0
    };
    Some(format!(
        "{sign}{hours:02}:{:02}:{:02}{}",
        parts[6],
        parts[7],
        fraction(micros)
    ))
}

/// The types whose bytes are not text: the binary ones, and the number types (reached only when their bytes do not fit them).
fn is_binary_type(type_name: &str) -> bool {
    matches!(
        type_name,
        "BINARY"
            | "VARBINARY"
            | "TINYBLOB"
            | "BLOB"
            | "MEDIUMBLOB"
            | "LONGBLOB"
            | "GEOMETRY"
            | "BOOLEAN"
            | "TINYINT"
            | "TINYINT UNSIGNED"
            | "SMALLINT"
            | "SMALLINT UNSIGNED"
            | "INT"
            | "INT UNSIGNED"
            | "MEDIUMINT"
            | "MEDIUMINT UNSIGNED"
            | "BIGINT"
            | "BIGINT UNSIGNED"
            | "FLOAT"
            | "DOUBLE"
            | "YEAR"
            | "BIT"
            | "DECIMAL"
    )
}

/// The value of one column as the screen draws it. `type_name` is sqlx's name of the column's type (`TINYINT UNSIGNED`, `DATETIME`, `VARCHAR` and so on) and `bytes` its value in the binary protocol, none for NULL.
pub fn cell_of(type_name: &str, bytes: Option<&[u8]>) -> DatabaseCell {
    let Some(bytes) = bytes else {
        return cell(DatabaseCellKind::Null, "NULL".to_owned());
    };
    if let Some(number) = number_text(type_name, bytes) {
        return cell(DatabaseCellKind::Number, number);
    }
    let temporal = match type_name {
        "DATE" | "DATETIME" | "TIMESTAMP" => Some(datetime_text(type_name, bytes)),
        "TIME" => Some(time_text(bytes)),
        _ => None,
    };
    match (temporal, type_name) {
        (Some(Some(text)), _) => cell(DatabaseCellKind::Text, text),
        (Some(None), _) => binary_cell(bytes.len()),
        (None, name) if is_binary_type(name) => binary_cell(bytes.len()),
        // JSON, ENUM, SET, CHAR, VARCHAR and the TEXT types are text; so is a type that is not known, when it is.
        (None, _) => match std::str::from_utf8(bytes) {
            Ok(text) => cell(DatabaseCellKind::Text, cut_text(text)),
            Err(_) => binary_cell(bytes.len()),
        },
    }
}

/// The text under the table: the rows that are shown (1 based, with thousands separators) and the estimated rows of the table.
/// An estimate that is below the last row shown is stale and is left out.
pub fn format_summary(offset: u64, shown: usize, estimate: Option<u64>) -> String {
    if shown == 0 {
        return "0 行".to_owned();
    }
    let last = offset + shown as u64;
    let mut text = format!(
        "{}–{} 行目",
        format_rows(Some(offset + 1)),
        format_rows(Some(last))
    );
    if let Some(total) = estimate.filter(|total| *total >= last) {
        text.push_str(&format!(" / 約 {} 行", format_rows(Some(total))));
    }
    text
}

/// The page (from 0) that the text typed in the page field names: the number counted from 1.
/// A text that is not made of digits only (empty, a sign, a separator, a letter) and a number below 1 are the first page; a number past what a page number holds is the last page that `u32` holds, which shows no row.
pub fn page_of_input(text: &str) -> u32 {
    let text = text.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return 0;
    }
    let number = text.parse::<u64>().unwrap_or(u64::MAX);
    u32::try_from(number.saturating_sub(1)).unwrap_or(u32::MAX)
}

/// The last page (from 0) that the estimate gives, for the page that starts at `offset` and shows `shown` rows.
/// The estimate is left out as `format_summary` leaves it out (below the last row shown), and so is a page with no row.
pub fn last_page(offset: u64, shown: usize, estimate: Option<u64>) -> Option<u32> {
    let total = estimate.filter(|total| shown > 0 && *total >= offset + shown as u64)?;
    Some(u32::try_from(total.div_ceil(PAGE_SIZE) - 1).unwrap_or(u32::MAX))
}

/// The text beside the page field: "/ 約 {pages}", with thousands separators; empty when there is no last page.
pub fn format_pages(last_page: Option<u32>) -> String {
    last_page.map_or_else(String::new, |last| {
        format!("/ 約 {}", format_rows(Some(u64::from(last) + 1)))
    })
}

/// A field of a copied text: as it is, or, when it holds a tab, a line break or a quote, between quotes with each quote doubled, which is how a spreadsheet reads a field that holds them.
fn tsv_field(text: &str) -> Cow<'_, str> {
    if text.contains(['\t', '\n', '\r', '"']) {
        Cow::Owned(format!("\"{}\"", text.replace('"', "\"\"")))
    } else {
        Cow::Borrowed(text)
    }
}

/// The text that the copy button puts in the clipboard (#668): the header and the rows as lines of tab separated fields, with no line break after the last (`tsv_field` quotes what would break a line or a field). No column is no text.
pub fn tsv<H: AsRef<str>, C: AsRef<str>>(header: &[H], rows: &[Vec<C>]) -> String {
    if header.is_empty() {
        return String::new();
    }
    let line = |fields: &mut dyn Iterator<Item = &str>| {
        fields.map(tsv_field).collect::<Vec<_>>().join("\t")
    };
    let mut lines = vec![line(&mut header.iter().map(AsRef::as_ref))];
    lines.extend(
        rows.iter()
            .map(|row| line(&mut row.iter().map(AsRef::as_ref))),
    );
    lines.join("\n")
}

/// `tsv` of the columns and the cells of a page or of a result, with the text of each cell as the screen shows it.
pub fn cells_tsv(columns: &[String], rows: &[Vec<DatabaseCell>]) -> String {
    let texts: Vec<Vec<&str>> = rows
        .iter()
        .map(|row| row.iter().map(|c| c.text.as_str()).collect())
        .collect();
    tsv(columns, &texts)
}

pub(super) fn cells_of(row: &MySqlRow) -> Vec<DatabaseCell> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, column)| {
            // The bytes as they came, borrowed from the row, with no check of the type; an error is a NULL (and so is the zero date, which the typed decoders also take for one, so none is used).
            let bytes = row.try_get_unchecked::<&[u8], _>(i).ok();
            cell_of(column.type_info().name(), bytes)
        })
        .collect()
}

/// Whether the estimate is read for `page`: the first page reads it (a press on the table, and a reload of that page), a later one uses the one the screen holds (`known`), so the walk through the pages costs one round trip each; a screen that holds none (a read failed meanwhile) has it read again.
pub fn reads_estimate(page: u32, known: Option<u64>) -> bool {
    page == 0 || known.is_none()
}

/// The page `page` (from 0) of `database`.`table` on the session, and the estimated rows of the table (`known` is the one the screen holds, used for a page that does not read it).
/// The rows are turned into cells one by one as they come, and the 101st is only counted, so no more than a page is held.
pub async fn read(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
    page: u32,
    known: Option<u64>,
) -> Result<DatabaseRecords, sqlx::Error> {
    let offset = u64::from(page) * PAGE_SIZE;
    // The names are quoted by `quote_identifier`; the limit and the offset are bound.
    let sql = records_sql(database, table);
    let mut columns: Option<Vec<String>> = None;
    let stream = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(PAGE_SIZE + 1)
        .bind(offset)
        .fetch(&mut *connection)
        .map_ok(|row| {
            columns.get_or_insert_with(|| column_names(&row));
            cells_of(&row)
        });
    let (rows, has_more) = collect_limited(Box::pin(stream), PAGE_SIZE as usize).await?;
    let estimate = if reads_estimate(page, known) {
        sqlx::query_scalar::<_, Option<u64>>(ESTIMATE)
            .bind(database)
            .bind(table)
            .fetch_optional(&mut *connection)
            .await?
            .flatten()
    } else {
        known
    };
    let last_page = last_page(offset, rows.len(), estimate);
    let columns = columns.unwrap_or_default();
    let key = read_key(connection, database, table).await?;
    let edits = rows
        .iter()
        .map(|row| row_edit(&columns, &key, row))
        .collect();
    Ok(DatabaseRecords {
        key,
        edits,
        tsv: cells_tsv(&columns, &rows),
        columns,
        summary: format_summary(offset, rows.len(), estimate),
        pages: format_pages(last_page),
        last_page,
        rows,
        page,
        has_more,
        estimate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(type_name: &str, bytes: &[u8]) -> (DatabaseCellKind, String) {
        let c = cell_of(type_name, Some(bytes));
        (c.kind, c.text)
    }

    fn number(type_name: &str, bytes: &[u8]) -> String {
        let (kind, text) = text(type_name, bytes);
        assert_eq!(kind, DatabaseCellKind::Number, "{type_name}");
        text
    }

    fn plain(type_name: &str, bytes: &[u8]) -> String {
        let (kind, text) = text(type_name, bytes);
        assert_eq!(kind, DatabaseCellKind::Text, "{type_name}");
        text
    }

    #[test]
    fn a_name_is_between_backticks_and_a_backtick_inside_is_doubled() {
        assert_eq!(quote_identifier("orders"), "`orders`");
        assert_eq!(quote_identifier("a`b"), "`a``b`");
        assert_eq!(quote_identifier("`"), "````");
        assert_eq!(quote_identifier("``"), "``````");
        assert_eq!(quote_identifier(""), "``");
        assert_eq!(
            quote_identifier("my db; DROP TABLE x"),
            "`my db; DROP TABLE x`"
        );
        assert_eq!(quote_identifier("注文.履歴"), "`注文.履歴`");
    }

    #[test]
    fn the_statement_has_the_two_names_in_the_text_and_binds_only_the_limit_and_the_offset() {
        assert_eq!(
            records_sql("shop", "orders"),
            "SELECT * FROM `shop`.`orders` LIMIT ? OFFSET ?"
        );
        let sql = records_sql("sh`op", "or? ders");
        assert_eq!(sql, "SELECT * FROM `sh``op`.`or? ders` LIMIT ? OFFSET ?");
        assert!(sql.ends_with(" LIMIT ? OFFSET ?"));
        assert_eq!(ESTIMATE.matches('?').count(), 2);
    }

    #[test]
    fn a_text_is_cut_after_the_limit_in_characters_and_not_in_bytes() {
        let exact = "あ".repeat(TEXT_MAX);
        assert_eq!(cut_text(&exact), exact);
        let long = "あ".repeat(TEXT_MAX + 1);
        let cut = cut_text(&long);
        assert_eq!(cut.chars().count(), TEXT_MAX + 1);
        assert!(cut.ends_with('…') && cut.starts_with("ああ"));
        assert_eq!(cut_text(""), "");
        assert_eq!(cut_text("short"), "short");
    }

    #[test]
    fn the_integers_are_their_little_endian_bytes_and_the_sign_follows_the_type() {
        assert_eq!(number("TINYINT", &[0xff]), "-1");
        assert_eq!(number("TINYINT UNSIGNED", &[0xff]), "255");
        assert_eq!(number("BOOLEAN", &[1]), "1");
        assert_eq!(number("SMALLINT", &[0xfe, 0xff]), "-2");
        assert_eq!(number("SMALLINT UNSIGNED", &[0xfe, 0xff]), "65534");
        assert_eq!(number("INT", &[0x00, 0x00, 0x00, 0x80]), "-2147483648");
        assert_eq!(
            number("INT UNSIGNED", &[0xff, 0xff, 0xff, 0xff]),
            "4294967295"
        );
        assert_eq!(number("MEDIUMINT", &[0x01, 0x00, 0x00, 0x00]), "1");
        assert_eq!(
            number("MEDIUMINT UNSIGNED", &[0x40, 0x42, 0x0f, 0x00]),
            "1000000"
        );
        assert_eq!(
            number("BIGINT", &i64::MIN.to_le_bytes()),
            "-9223372036854775808"
        );
        assert_eq!(
            number("BIGINT UNSIGNED", &u64::MAX.to_le_bytes()),
            "18446744073709551615"
        );
    }

    #[test]
    fn the_floats_the_year_and_the_bits_are_numbers() {
        assert_eq!(number("FLOAT", &1.5f32.to_le_bytes()), "1.5");
        assert_eq!(number("FLOAT", &0.1f32.to_le_bytes()), "0.1");
        assert_eq!(number("DOUBLE", &(-2.25f64).to_le_bytes()), "-2.25");
        assert_eq!(
            number("DOUBLE", &1e21f64.to_le_bytes()),
            "1000000000000000000000"
        );
        assert_eq!(number("YEAR", &2024u16.to_le_bytes()), "2024");
        assert_eq!(number("YEAR", &0u16.to_le_bytes()), "0000");
        assert_eq!(number("BIT", &[0x01]), "1");
        assert_eq!(number("BIT", &[0x01, 0x02]), "258");
        assert_eq!(number("BIT", &[0xff; 8]), "18446744073709551615");
    }

    #[test]
    fn a_decimal_is_its_text_as_a_number() {
        assert_eq!(number("DECIMAL", b"12345.6789"), "12345.6789");
        assert_eq!(number("DECIMAL", b"-0.50"), "-0.50");
        assert_eq!(
            number("DECIMAL", b"99999999999999999999999999999.999999"),
            "99999999999999999999999999999.999999"
        );
    }

    #[test]
    fn bytes_that_do_not_fit_their_type_are_told_as_binary_and_never_fail() {
        for (name, bytes) in [
            ("INT", &[1u8, 2, 3][..]),
            ("BIGINT", &[]),
            ("DOUBLE", &[0; 4]),
            ("BIT", &[]),
            ("BIT", &[0; 9]),
            ("DECIMAL", &[0xff, 0xfe]),
            ("DATETIME", &[7, 1, 2]),
            ("DATE", &[]),
            ("TIME", &[9, 0, 0]),
            ("DATETIME", &[5, 0, 0, 0, 0, 0]),
        ] {
            let c = cell_of(name, Some(bytes));
            assert_eq!(c.kind, DatabaseCellKind::Binary, "{name} {bytes:?}");
            assert_eq!(c.text, format!("バイナリ {} B", bytes.len()), "{name}");
        }
    }

    #[test]
    fn a_date_is_year_month_day_and_the_zero_date_is_zeros() {
        assert_eq!(plain("DATE", &[4, 0xe8, 0x07, 1, 2]), "2024-01-02");
        assert_eq!(plain("DATE", &[4, 0x0f, 0x27, 12, 31]), "9999-12-31");
        assert_eq!(plain("DATE", &[0]), "0000-00-00");
        assert_eq!(plain("DATETIME", &[0]), "0000-00-00 00:00:00");
        assert_eq!(plain("TIMESTAMP", &[0]), "0000-00-00 00:00:00");
        // a length of 7 or 11 is not a DATE
        assert_eq!(
            cell_of("DATE", Some(&[7, 0xe8, 0x07, 1, 2, 3, 4, 5])).kind,
            DatabaseCellKind::Binary
        );
    }

    #[test]
    fn a_datetime_has_its_time_and_a_fraction_only_when_it_has_one() {
        assert_eq!(
            plain("DATETIME", &[4, 0xe8, 0x07, 1, 2]),
            "2024-01-02 00:00:00"
        );
        assert_eq!(
            plain("DATETIME", &[7, 0xe8, 0x07, 1, 2, 3, 4, 5]),
            "2024-01-02 03:04:05"
        );
        assert_eq!(
            plain("TIMESTAMP", &[7, 0xe8, 0x07, 11, 12, 23, 59, 59]),
            "2024-11-12 23:59:59"
        );
        let with = |micros: u32| {
            let mut bytes = vec![11, 0xe8, 0x07, 1, 2, 3, 4, 5];
            bytes.extend_from_slice(&micros.to_le_bytes());
            plain("DATETIME", &bytes)
        };
        assert_eq!(with(0), "2024-01-02 03:04:05");
        assert_eq!(with(123_000), "2024-01-02 03:04:05.123");
        assert_eq!(with(120_000), "2024-01-02 03:04:05.12");
        assert_eq!(with(1), "2024-01-02 03:04:05.000001");
        assert_eq!(with(999_999), "2024-01-02 03:04:05.999999");
    }

    #[test]
    fn a_time_counts_the_days_in_the_hours_and_has_a_sign() {
        assert_eq!(plain("TIME", &[0]), "00:00:00");
        assert_eq!(plain("TIME", &[8, 0, 0, 0, 0, 0, 12, 34, 56]), "12:34:56");
        assert_eq!(plain("TIME", &[8, 1, 0, 0, 0, 0, 1, 2, 3]), "-01:02:03");
        // 34 days and 22 hours: 838:59:59, the largest TIME
        assert_eq!(plain("TIME", &[8, 0, 34, 0, 0, 0, 22, 59, 59]), "838:59:59");
        assert_eq!(
            plain("TIME", &[8, 1, 34, 0, 0, 0, 22, 59, 59]),
            "-838:59:59"
        );
        let mut bytes = vec![12, 0, 0, 0, 0, 0, 1, 2, 3];
        bytes.extend_from_slice(&500_000u32.to_le_bytes());
        assert_eq!(plain("TIME", &bytes), "01:02:03.5");
    }

    #[test]
    fn a_null_is_the_word_null_and_an_empty_text_is_not_one() {
        let null = cell_of("VARCHAR", None);
        assert_eq!(
            (null.kind, null.text.as_str()),
            (DatabaseCellKind::Null, "NULL")
        );
        for name in ["INT", "DATETIME", "BLOB", "JSON", "DECIMAL"] {
            assert_eq!(cell_of(name, None).kind, DatabaseCellKind::Null, "{name}");
        }
        assert_eq!(
            text("VARCHAR", b""),
            (DatabaseCellKind::Text, String::new())
        );
        assert_eq!(plain("VARCHAR", b"NULL"), "NULL");
    }

    #[test]
    fn a_binary_value_is_its_length_only() {
        for name in [
            "BINARY",
            "VARBINARY",
            "TINYBLOB",
            "BLOB",
            "MEDIUMBLOB",
            "LONGBLOB",
            "GEOMETRY",
        ] {
            let c = cell_of(name, Some(&[0xde, 0xad, 0xbe, 0xef]));
            assert_eq!(
                (c.kind, c.text.as_str()),
                (DatabaseCellKind::Binary, "バイナリ 4 B"),
                "{name}"
            );
        }
        assert_eq!(cell_of("BLOB", Some(&[])).text, "バイナリ 0 B");
        assert_eq!(cell_of("BLOB", Some(&[0u8; 1536])).text, "バイナリ 1.5 KB");
        // text that is valid UTF-8 is still binary in a binary column
        assert_eq!(
            cell_of("VARBINARY", Some(b"abc")).kind,
            DatabaseCellKind::Binary
        );
    }

    #[test]
    fn the_text_types_are_text_cut_when_long_and_binary_when_not_valid_utf8() {
        assert_eq!(plain("VARCHAR", "注文 abc".as_bytes()), "注文 abc");
        assert_eq!(plain("CHAR", b"x"), "x");
        assert_eq!(plain("TEXT", b"line1\nline2"), "line1\nline2");
        assert_eq!(plain("ENUM", b"paid"), "paid");
        assert_eq!(plain("SET", b"a,b"), "a,b");
        assert_eq!(
            plain("JSON", br#"{"a": [1, 2], "b": null}"#),
            r#"{"a": [1, 2], "b": null}"#
        );
        assert_eq!(plain("SOMETHING NEW", b"ok"), "ok");
        let long = "x".repeat(TEXT_MAX + 50);
        let cut = plain("LONGTEXT", long.as_bytes());
        assert_eq!(cut.chars().count(), TEXT_MAX + 1);
        assert!(cut.ends_with('…'));
        let bad = cell_of("VARCHAR", Some(&[0x61, 0xff, 0xfe]));
        assert_eq!(
            (bad.kind, bad.text.as_str()),
            (DatabaseCellKind::Binary, "バイナリ 3 B")
        );
    }

    #[test]
    fn the_estimate_is_read_with_the_first_page_and_when_the_screen_holds_none() {
        assert!(reads_estimate(0, Some(5)));
        assert!(reads_estimate(0, None));
        for page in [1, 2, 1000] {
            assert!(!reads_estimate(page, Some(5)), "{page}");
            assert!(reads_estimate(page, None), "{page}");
        }
    }

    #[test]
    fn the_summary_has_the_rows_shown_and_the_estimate_when_it_is_not_stale() {
        assert_eq!(
            format_summary(0, 100, Some(1200)),
            "1–100 行目 / 約 1,200 行"
        );
        assert_eq!(
            format_summary(100, 100, Some(1200)),
            "101–200 行目 / 約 1,200 行"
        );
        assert_eq!(
            format_summary(1100, 3, Some(1103)),
            "1,101–1,103 行目 / 約 1,103 行"
        );
        assert_eq!(format_summary(0, 7, None), "1–7 行目");
        // an estimate below the last row shown is stale
        assert_eq!(format_summary(0, 100, Some(0)), "1–100 行目");
        assert_eq!(format_summary(100, 50, Some(149)), "101–150 行目");
        assert_eq!(format_summary(0, 0, Some(1200)), "0 行");
        assert_eq!(format_summary(300, 0, None), "0 行");
    }

    #[test]
    fn a_typed_number_is_the_page_counted_from_one_and_anything_else_is_the_first_page() {
        assert_eq!(page_of_input("1"), 0);
        assert_eq!(page_of_input("2"), 1);
        assert_eq!(page_of_input("15062"), 15061);
        assert_eq!(page_of_input("  7 "), 6);
        // below 1, not a number, empty, a sign, a separator, a fraction, other digits
        for text in [
            "0", "00", "", "   ", "-3", "+5", "abc", "1a", "1,000", "2.5", "１２", "٣",
        ] {
            assert_eq!(page_of_input(text), 0, "{text:?}");
        }
        // a number past every page is read as it is (it shows no row), and one past u32 is the last page u32 has
        assert_eq!(page_of_input("4294967296"), u32::MAX);
        assert_eq!(page_of_input("99999999999999999999999999"), u32::MAX);
    }

    #[test]
    fn the_last_page_is_the_estimate_in_pages_and_none_when_it_is_stale_or_unknown() {
        assert_eq!(last_page(0, 100, Some(1200)), Some(11));
        assert_eq!(last_page(0, 100, Some(1201)), Some(12));
        assert_eq!(last_page(1100, 100, Some(1200)), Some(11));
        assert_eq!(last_page(0, 7, Some(7)), Some(0));
        assert_eq!(last_page(0, 1, Some(100)), Some(0));
        assert_eq!(last_page(0, 1, Some(101)), Some(1));
        // none for a view, an estimate below the last row shown (as the summary leaves it out), and a page with no row
        assert_eq!(last_page(0, 7, None), None);
        assert_eq!(last_page(0, 100, Some(0)), None);
        assert_eq!(last_page(100, 50, Some(149)), None);
        assert_eq!(last_page(0, 0, Some(1200)), None);
        assert_eq!(last_page(300, 0, None), None);
    }

    fn cells(texts: &[&str]) -> Vec<DatabaseCell> {
        texts
            .iter()
            .map(|t| cell(DatabaseCellKind::Text, (*t).to_owned()))
            .collect()
    }

    #[test]
    fn the_copy_is_the_header_and_the_rows_as_tab_separated_lines() {
        let columns = vec!["id".to_owned(), "name".to_owned()];
        let rows = vec![cells(&["1", "Alice"]), cells(&["2", ""])];
        assert_eq!(cells_tsv(&columns, &rows), "id\tname\n1\tAlice\n2\t");
        // NULL and a binary value are copied as the screen shows them
        let shown = vec![vec![
            cell(DatabaseCellKind::Null, "NULL".to_owned()),
            binary_cell(16),
        ]];
        assert_eq!(cells_tsv(&columns, &shown), "id\tname\nNULL\tバイナリ 16 B");
        // no row is the header alone, and no column is nothing at all
        assert_eq!(cells_tsv(&columns, &[]), "id\tname");
        assert_eq!(cells_tsv(&[], &[]), "");
    }

    #[test]
    fn a_value_with_a_tab_a_line_break_or_a_quote_is_quoted_as_a_spreadsheet_reads_it() {
        let columns = vec!["a\tb".to_owned(), "c".to_owned()];
        let rows = vec![
            cells(&["x\ty", "line1\nline2"]),
            cells(&["say \"hi\"", "cr\rlf"]),
        ];
        assert_eq!(
            cells_tsv(&columns, &rows),
            "\"a\tb\"\tc\n\"x\ty\"\t\"line1\nline2\"\n\"say \"\"hi\"\"\"\t\"cr\rlf\""
        );
        // a quote alone, and other whitespace or Japanese, are left as they are
        assert_eq!(tsv(&["q"], &[vec!["\""]]), "q\n\"\"\"\"");
        assert_eq!(
            tsv(&["q"], &[vec![" 日本語 \u{3000}"]]),
            "q\n 日本語 \u{3000}"
        );
        // a field is quoted once, not again when it is copied
        assert_eq!(tsv(&["q"], &[vec!["a\tb"]]), "q\n\"a\tb\"");
    }

    fn key_row(index: &str, seq: u64, column: Option<&str>, nullable: &str) -> KeyRow {
        (
            index.to_owned(),
            seq,
            column.map(str::to_owned),
            Some(nullable.to_owned()),
        )
    }

    fn strings(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn the_key_is_the_primary_key_and_a_composite_one_is_in_the_order_of_its_index() {
        let rows = vec![
            key_row("PRIMARY", 2, Some("b"), ""),
            key_row("PRIMARY", 1, Some("a"), ""),
            key_row("by_code", 1, Some("code"), ""),
        ];
        assert_eq!(choose_key(&rows), strings(&["a", "b"]));
        assert!(KEYS.contains("NON_UNIQUE = 0") && KEYS.matches('?').count() == 2);
    }

    #[test]
    fn with_no_primary_key_the_unique_key_of_the_fewest_columns_that_cannot_be_null_is_the_key() {
        let rows = vec![
            key_row("pair", 1, Some("x"), ""),
            key_row("pair", 2, Some("y"), ""),
            key_row("nullable", 1, Some("n"), "YES"),
            key_row("zeta", 1, Some("z"), ""),
            key_row("alpha", 1, Some("p"), ""),
        ];
        // `alpha` and `zeta` have one column each, and the first by name wins; `nullable` may hold two NULLs, so it names no row
        assert_eq!(choose_key(&rows), strings(&["p"]));
        let only_wide = vec![
            key_row("pair", 1, Some("x"), ""),
            key_row("pair", 2, Some("y"), ""),
            key_row("nullable", 1, Some("n"), "YES"),
        ];
        assert_eq!(choose_key(&only_wide), strings(&["x", "y"]));
    }

    #[test]
    fn an_index_with_a_nullable_column_or_an_expression_names_no_row_and_no_index_is_no_key() {
        // one nullable column in a composite index is enough to leave it out
        let mixed = vec![
            key_row("pair", 1, Some("x"), ""),
            key_row("pair", 2, Some("y"), "YES"),
        ];
        assert_eq!(choose_key(&mixed), Vec::<String>::new());
        // an expression of MySQL 8 has no column name
        let expression = vec![key_row("by_lower", 1, None, "")];
        assert_eq!(choose_key(&expression), Vec::<String>::new());
        assert_eq!(choose_key(&[]), Vec::<String>::new());
    }

    fn texts(kind: DatabaseCellKind, text: &str) -> DatabaseCell {
        cell(kind, text.to_owned())
    }

    #[test]
    fn a_cell_can_be_written_unless_it_is_binary_or_a_text_that_was_cut() {
        assert!(is_editable(&cell_of("VARCHAR", None)));
        assert!(is_editable(&cell_of("INT", Some(&5i32.to_le_bytes()))));
        assert!(is_editable(&cell_of("VARCHAR", Some(b""))));
        let exact = "あ".repeat(TEXT_MAX);
        assert!(is_editable(&cell_of("TEXT", Some(exact.as_bytes()))));
        let long = "あ".repeat(TEXT_MAX + 1);
        assert!(!is_editable(&cell_of("TEXT", Some(long.as_bytes()))));
        assert!(!is_editable(&cell_of("BLOB", Some(b"abc"))));
        assert!(!is_editable(&cell_of("INT", Some(&[1, 2, 3]))));
        assert!(is_editable(&cell_of("DATETIME", Some(&[0]))));
        // a text that is not cut and ends with the sign of a cut is still whole
        assert!(is_editable(&texts(DatabaseCellKind::Text, "wait…")));
    }

    #[test]
    fn a_row_can_change_only_with_a_key_whose_cells_are_whole() {
        let columns = strings(&["id", "note", "photo"]);
        let key = strings(&["id"]);
        let whole = vec![
            texts(DatabaseCellKind::Number, "1"),
            texts(DatabaseCellKind::Text, "a"),
            binary_cell(10),
        ];
        let edit = row_edit(&columns, &key, &whole);
        assert_eq!(
            edit,
            DatabaseRowEdit {
                can_change: true,
                cells: vec![true, true, false]
            }
        );
        // a table with no key can change no row, and the cells are still told
        let none = row_edit(&columns, &[], &whole);
        assert!(!none.can_change);
        assert_eq!(none.cells, vec![true, true, false]);
        // a key cell that is cut, binary or NULL, and a key column that is not in the page
        let cut = "x".repeat(TEXT_MAX + 1);
        let text_key = strings(&["note"]);
        let long = vec![
            texts(DatabaseCellKind::Number, "1"),
            cell(DatabaseCellKind::Text, cut_text(&cut)),
            binary_cell(1),
        ];
        assert!(!row_edit(&columns, &text_key, &long).can_change);
        assert!(!row_edit(&columns, &strings(&["photo"]), &whole).can_change);
        let null = vec![
            cell(DatabaseCellKind::Null, "NULL".to_owned()),
            texts(DatabaseCellKind::Text, "a"),
            binary_cell(1),
        ];
        assert!(!row_edit(&columns, &key, &null).can_change);
        assert!(!row_edit(&columns, &strings(&["hidden"]), &whole).can_change);
        // one of two key columns that is not whole is enough
        let pair = strings(&["id", "photo"]);
        assert!(!row_edit(&columns, &pair, &whole).can_change);
    }

    #[test]
    fn the_pages_are_worded_with_the_estimate_and_thousands_separators() {
        assert_eq!(format_pages(Some(11)), "/ 約 12");
        assert_eq!(format_pages(Some(15061)), "/ 約 15,062");
        assert_eq!(format_pages(Some(0)), "/ 約 1");
        assert_eq!(format_pages(None), "");
    }
}
