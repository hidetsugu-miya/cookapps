//! The records of a table (D-4, #633): one page of ``SELECT * FROM `db`.`table` LIMIT ? OFFSET ?``, and each value of it turned into text here.
//!
//! The names of the database and of the table are put in the SQL text between backticks (a backtick inside is doubled, `quote_identifier`), and the limit and the offset are bound.
//! The statement is a prepared one, so the rows come in the binary protocol: the value of a column is its type's binary form (an integer is its little-endian bytes, a DATETIME is a length and its parts, a DECIMAL and a JSON are their text).
//! `cell_of` is the one place that turns it into what the screen draws, from the name of the column's type (`TypeInfo::name`) and the bytes, and it never fails: bytes that do not fit their type are told as binary.
//! A NULL is the text "NULL", a binary value is its length only, and a text longer than `TEXT_MAX` characters is cut with "…" (the rest is kept nowhere).
//! The SQL tab (#635) draws its result with the same cells.

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

/// Whether the estimate is read for `page`: the first page reads it (a press on the table, and a reload of that page), a later one uses the one the screen holds, so the walk through the pages costs one round trip each.
pub fn reads_estimate(page: u32) -> bool {
    page == 0
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
    let estimate = if reads_estimate(page) {
        sqlx::query_scalar::<_, Option<u64>>(ESTIMATE)
            .bind(database)
            .bind(table)
            .fetch_optional(&mut *connection)
            .await?
            .flatten()
    } else {
        known
    };
    Ok(DatabaseRecords {
        columns: columns.unwrap_or_default(),
        summary: format_summary(offset, rows.len(), estimate),
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
    fn the_estimate_is_read_with_the_first_page_only() {
        assert!(reads_estimate(0));
        for page in [1, 2, 1000] {
            assert!(!reads_estimate(page), "{page}");
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
}
