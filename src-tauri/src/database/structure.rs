//! The structure of a table (D-5, #634): the columns of `information_schema.COLUMNS` as text, and the engine and the character set of the table under them.
//!
//! The schema and the table are bound values, never put in the SQL text, and every column is cast in the SQL (`CAST … AS CHAR`) so that it decodes on MySQL 5.7, 8.0 and 8.4 alike.
//! The words of the cells (`format_default`) and of the footer (`format_summary`, `charset_of`) are pure functions here, so the screen only draws them.
//! Indexes, foreign keys and triggers are not read.

use serde::Serialize;
use sqlx::mysql::MySqlConnection;
#[cfg(test)]
use ts_rs::TS;

/// The columns of the table bound to the two `?` (its schema and its name), in the order of the table.
const COLUMNS: &str = "SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), CAST(IS_NULLABLE AS CHAR), CAST(COLUMN_KEY AS CHAR), CAST(COLUMN_DEFAULT AS CHAR), CAST(COLUMN_COMMENT AS CHAR) \
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION";
/// The engine and the collation of the table bound to the two `?`; a view has neither.
const TABLE: &str = "SELECT CAST(ENGINE AS CHAR), CAST(TABLE_COLLATION AS CHAR) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";

type ColumnRow = (String, String, String, String, Option<String>, String);

/// A column of a table as the structure draws it. `key` is MySQL's own (`PRI`, `UNI`, `MUL` or empty); `default` and `comment` are text, empty for none.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct DatabaseColumn {
    pub name: String,
    pub column_type: String,
    pub nullable: bool,
    pub key: String,
    pub default: String,
    pub comment: String,
}

/// The structure of a table: its columns, and `summary` (the number of columns, the engine and the character set), worded for the footer.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct DatabaseStructure {
    pub columns: Vec<DatabaseColumn>,
    pub summary: String,
}

/// The default of a column as text. A column with no default (the server answers none) is empty, except one that may be NULL, whose default is NULL; an empty text is `''`.
pub fn format_default(nullable: bool, default: Option<&str>) -> String {
    match default {
        Some("") => "''".to_owned(),
        Some(text) => text.to_owned(),
        None if nullable => "NULL".to_owned(),
        None => String::new(),
    }
}

/// The character set of a collation: the name up to its first underscore (`utf8mb4_0900_ai_ci` is `utf8mb4`, `binary` is `binary`).
pub fn charset_of(collation: &str) -> &str {
    collation.split('_').next().unwrap_or(collation)
}

/// The text under the table: the number of columns, then the engine and the character set when the table has them (a view has neither).
pub fn format_summary(columns: usize, engine: Option<&str>, collation: Option<&str>) -> String {
    let mut parts = vec![format!("{columns} 列")];
    if let Some(engine) = engine.filter(|e| !e.is_empty()) {
        parts.push(engine.to_owned());
    }
    if let Some(collation) = collation.filter(|c| !c.is_empty()) {
        parts.push(charset_of(collation).to_owned());
    }
    parts.join(" / ")
}

fn to_column((name, column_type, nullable, key, default, comment): ColumnRow) -> DatabaseColumn {
    let nullable = nullable == "YES";
    DatabaseColumn {
        default: format_default(nullable, default.as_deref()),
        name,
        column_type,
        nullable,
        key,
        comment,
    }
}

/// The structure of `database`.`table` on the session.
pub async fn read(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<DatabaseStructure, sqlx::Error> {
    let rows = sqlx::query_as::<_, ColumnRow>(COLUMNS)
        .bind(database)
        .bind(table)
        .fetch_all(&mut *connection)
        .await?;
    let (engine, collation) = sqlx::query_as::<_, (Option<String>, Option<String>)>(TABLE)
        .bind(database)
        .bind(table)
        .fetch_optional(&mut *connection)
        .await?
        .unwrap_or((None, None));
    Ok(DatabaseStructure {
        summary: format_summary(rows.len(), engine.as_deref(), collation.as_deref()),
        columns: rows.into_iter().map(to_column).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_are_bound_values_and_not_put_in_the_text() {
        assert!(COLUMNS.contains("TABLE_SCHEMA = ? AND TABLE_NAME = ?"));
        assert_eq!(COLUMNS.matches('?').count(), 2);
        assert!(TABLE.contains("TABLE_SCHEMA = ? AND TABLE_NAME = ?"));
        assert_eq!(TABLE.matches('?').count(), 2);
    }

    #[test]
    fn only_the_columns_are_read_and_not_the_indexes_the_keys_or_the_triggers() {
        for sql in [COLUMNS, TABLE] {
            for word in ["STATISTICS", "KEY_COLUMN_USAGE", "TRIGGERS", "REFERENTIAL"] {
                assert!(!sql.contains(word), "{word}");
            }
        }
    }

    #[test]
    fn a_default_is_its_text_and_a_missing_one_is_null_only_for_a_column_that_may_be_null() {
        assert_eq!(format_default(false, Some("0")), "0");
        assert_eq!(
            format_default(true, Some("CURRENT_TIMESTAMP")),
            "CURRENT_TIMESTAMP"
        );
        assert_eq!(format_default(false, Some("")), "''");
        assert_eq!(format_default(true, Some("NULL")), "NULL");
        assert_eq!(format_default(true, None), "NULL");
        assert_eq!(format_default(false, None), "");
    }

    #[test]
    fn the_character_set_is_the_collation_up_to_its_first_underscore() {
        assert_eq!(charset_of("utf8mb4_0900_ai_ci"), "utf8mb4");
        assert_eq!(charset_of("utf8mb4_general_ci"), "utf8mb4");
        assert_eq!(charset_of("latin1_swedish_ci"), "latin1");
        assert_eq!(charset_of("binary"), "binary");
        assert_eq!(charset_of(""), "");
    }

    #[test]
    fn the_summary_has_the_columns_then_the_engine_and_the_character_set_that_the_table_has() {
        assert_eq!(
            format_summary(12, Some("InnoDB"), Some("utf8mb4_0900_ai_ci")),
            "12 列 / InnoDB / utf8mb4"
        );
        assert_eq!(format_summary(1, Some("MyISAM"), None), "1 列 / MyISAM");
        assert_eq!(
            format_summary(3, None, Some("utf8mb3_bin")),
            "3 列 / utf8mb3"
        );
        assert_eq!(format_summary(4, None, None), "4 列");
        assert_eq!(format_summary(0, Some(""), Some("")), "0 列");
    }

    #[test]
    fn a_row_becomes_the_cells_the_structure_draws() {
        let id = to_column((
            "id".to_owned(),
            "bigint unsigned".to_owned(),
            "NO".to_owned(),
            "PRI".to_owned(),
            None,
            "注文の ID".to_owned(),
        ));
        assert_eq!(
            id,
            DatabaseColumn {
                name: "id".to_owned(),
                column_type: "bigint unsigned".to_owned(),
                nullable: false,
                key: "PRI".to_owned(),
                default: String::new(),
                comment: "注文の ID".to_owned(),
            }
        );
        let note = to_column((
            "note".to_owned(),
            "varchar(255)".to_owned(),
            "YES".to_owned(),
            String::new(),
            None,
            String::new(),
        ));
        assert!(note.nullable);
        assert_eq!(note.default, "NULL");
        let status = to_column((
            "status".to_owned(),
            "tinyint(1)".to_owned(),
            "NO".to_owned(),
            "MUL".to_owned(),
            Some("0".to_owned()),
            String::new(),
        ));
        assert_eq!((status.key.as_str(), status.default.as_str()), ("MUL", "0"));
    }
}
