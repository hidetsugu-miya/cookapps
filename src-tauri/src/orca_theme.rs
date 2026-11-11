//! The colors of the terminals of the Orca screen, chosen in the settings (A-14).
//!
//! The themes are Orca's built-in ones, which this app holds in `orca_themes.json`: 31 themes, each with the background, foreground, cursor, cursor text, selection colors and the 16 ANSI colors.
//! The table was taken from Orca 1.4.250 (`/Applications/Orca.app`): `app.asar` was extracted (`npx @electron/asar extract /Applications/Orca.app/Contents/Resources/app.asar DIR`) and
//! `TERMINAL_THEME_CATALOG` of `DIR/out/shared/terminal-themes/terminal-theme-catalog.js` (the themes of `defaults.js`, `popular-dark*.js`, `popular-light.js` and `classic.js`, in that order) was written out with `node`,
//! its `black` to `brightWhite` as `ansi` (the palette colors 0 to 15). A later Orca can add themes or change colors; then the table is taken again.
//!
//! The selection (a theme for the light appearance and one for the dark) is saved in `terminal-theme.json` in the app config directory.
//! Until it is saved, the first time the settings of the Orca on this Mac can be read, they give it: `terminalThemeLight` and `terminalThemeDark` of the `settings` document in
//! `profiles/local-default/profile-state.db` of Orca's settings folder, a SQLite file of Orca 1.4.250 that is not a public interface. It is opened read-only and never written.
//! A theme that is not built in (one the owner added to Orca, `custom:...`, or a name this table lacks) is replaced by the app's default for its slot.

use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts::write_synced,
    auth::config_dir,
    ghostty::{PaletteColor, TerminalColors},
    orca_link::orca_dir,
};

const SELECTION_FILE: &str = "terminal-theme.json";
const SELECTION_TMP_FILE: &str = "terminal-theme.json.tmp";
const CATALOG: &str = include_str!("orca_themes.json");

/// The app's default for the light appearance, which is also Orca's.
pub const DEFAULT_LIGHT: &str = "Builtin Tango Light";
/// The app's default for the dark appearance, which is also Orca's.
pub const DEFAULT_DARK: &str = "Ghostty Default Style Dark";

/// A theme of `orca_themes.json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    background: String,
    foreground: String,
    cursor: String,
    cursor_accent: String,
    selection_background: String,
    selection_foreground: String,
    /// The palette colors 0 to 15.
    ansi: Vec<String>,
}

/// A built-in theme of Orca: its name and its colors, all set.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct TerminalTheme {
    pub name: String,
    pub colors: TerminalColors,
}

/// Which theme the terminals draw: the one for the system's appearance, or always the light one or the dark one (A-15).
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

/// Anything but `"light"` and `"dark"` (a missing, unknown or mistyped value) follows the system.
impl<'de> Deserialize<'de> for Appearance {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(
            match serde_json::Value::deserialize(deserializer)?.as_str() {
                Some("light") => Self::Light,
                Some("dark") => Self::Dark,
                _ => Self::System,
            },
        )
    }
}

/// The theme of each appearance, by name, and which of them the terminals draw.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct ThemeSelection {
    pub light: String,
    pub dark: String,
    #[serde(default)]
    pub appearance: Appearance,
}

/// The themes to choose from, and the choice.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct TerminalThemes {
    pub themes: Vec<TerminalTheme>,
    pub selection: ThemeSelection,
}

/// The app's default choice.
fn default_selection() -> ThemeSelection {
    ThemeSelection {
        light: DEFAULT_LIGHT.into(),
        dark: DEFAULT_DARK.into(),
        appearance: Appearance::System,
    }
}

fn to_theme(entry: Entry) -> TerminalTheme {
    let palette = (0u8..)
        .zip(entry.ansi)
        .map(|(index, color)| PaletteColor { index, color })
        .collect();
    TerminalTheme {
        name: entry.name,
        colors: TerminalColors {
            background: Some(entry.background),
            foreground: Some(entry.foreground),
            cursor: Some(entry.cursor),
            cursor_accent: Some(entry.cursor_accent),
            selection_background: Some(entry.selection_background),
            selection_foreground: Some(entry.selection_foreground),
            palette,
        },
    }
}

/// The built-in themes, in Orca's order.
pub fn catalog() -> &'static [TerminalTheme] {
    static THEMES: OnceLock<Vec<TerminalTheme>> = OnceLock::new();
    THEMES.get_or_init(|| {
        serde_json::from_str::<Vec<Entry>>(CATALOG)
            .expect("orca_themes.json is valid")
            .into_iter()
            .map(to_theme)
            .collect()
    })
}

/// The choice with every name that is not a built-in theme replaced by the default of its slot.
fn normalize(selection: ThemeSelection) -> ThemeSelection {
    let built_in = |name: &str| catalog().iter().any(|t| t.name == name);
    let or_default = |name: String, default: &str| {
        if built_in(&name) {
            name
        } else {
            default.to_owned()
        }
    };
    ThemeSelection {
        light: or_default(selection.light, DEFAULT_LIGHT),
        dark: or_default(selection.dark, DEFAULT_DARK),
        appearance: selection.appearance,
    }
}

/// The choice Orca's `settings` document makes, `None` when the text is not a JSON object.
/// The flag `terminalUseSeparateLightTheme` and the appearance `theme` of Orca are not looked at: the app has its own.
fn from_orca_settings(payload: &str) -> Option<ThemeSelection> {
    let document: serde_json::Value = serde_json::from_str(payload).ok()?;
    let document = document.as_object()?;
    let name = |key: &str, default: &str| {
        document
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or(default)
            .to_owned()
    };
    Some(normalize(ThemeSelection {
        light: name("terminalThemeLight", DEFAULT_LIGHT),
        dark: name("terminalThemeDark", DEFAULT_DARK),
        appearance: Appearance::System,
    }))
}

/// The `settings` document of the profile-state database, `None` when the file, the table or the row is not there or the file is not a database. The file is opened read-only.
fn read_orca_settings(db: &Path) -> Option<String> {
    let connection = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    // Orca writes while it runs; a reader of a WAL database does not wait for it, but a checkpoint can hold the lock for a moment.
    connection.busy_timeout(Duration::from_millis(500)).ok()?;
    connection
        .query_row(
            "SELECT payload FROM profile_state_documents WHERE domain = 'settings'",
            [],
            |row| row.get(0),
        )
        .ok()
}

/// The saved choice, `None` before the first (or when the file cannot be used). A name that is no longer built in is replaced by its slot's default.
fn load(dir: &Path) -> Option<ThemeSelection> {
    let text = std::fs::read_to_string(dir.join(SELECTION_FILE)).ok()?;
    serde_json::from_str(&text).ok().map(normalize)
}

fn save(dir: &Path, selection: &ThemeSelection) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(SELECTION_FILE), dir.join(SELECTION_TMP_FILE));
    let text = serde_json::to_string_pretty(selection).map_err(|e| e.to_string())?;
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// The choice in use: the saved one, else the one Orca's settings make (saved then), else the default (not saved, so that the next start reads Orca again).
fn resolve(dir: &Path, orca_db: Option<&Path>) -> Result<ThemeSelection, String> {
    if let Some(saved) = load(dir) {
        return Ok(saved);
    }
    match orca_db
        .and_then(read_orca_settings)
        .and_then(|payload| from_orca_settings(&payload))
    {
        Some(from_orca) => {
            save(dir, &from_orca)?;
            Ok(from_orca)
        }
        None => Ok(default_selection()),
    }
}

/// Saves a choice of built-in themes.
fn set(dir: &Path, selection: ThemeSelection) -> Result<ThemeSelection, String> {
    let built_in = |name: &str| catalog().iter().any(|t| t.name == name);
    if let Some(name) = [&selection.light, &selection.dark]
        .into_iter()
        .find(|name| !built_in(name))
    {
        return Err(format!("テーマ {name} は選べません"));
    }
    save(dir, &selection)?;
    Ok(selection)
}

fn orca_db() -> Option<PathBuf> {
    orca_dir().map(|d| d.join("profiles/local-default/profile-state.db"))
}

/// The built-in themes and the choice (A-14). The first time Orca's settings can be read they give the choice.
#[tauri::command]
pub async fn terminal_themes(app: AppHandle) -> Result<TerminalThemes, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        Ok(TerminalThemes {
            themes: catalog().to_vec(),
            selection: resolve(&dir, orca_db().as_deref())?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the choice of a theme for each appearance (A-14).
#[tauri::command]
pub async fn terminal_theme_set(
    app: AppHandle,
    selection: ThemeSelection,
) -> Result<ThemeSelection, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || set(&dir, selection))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-theme-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn selection(light: &str, dark: &str) -> ThemeSelection {
        ThemeSelection {
            light: light.into(),
            dark: dark.into(),
            appearance: Appearance::System,
        }
    }

    fn is_hex(color: &str) -> bool {
        color.len() == 7
            && color.starts_with('#')
            && color[1..]
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    }

    /// A database as Orca makes it: the `settings` document in the table `profile_state_documents`, in WAL mode. The connection is returned so that the WAL stays.
    fn orca_db_with(dir: &Path, payload: Option<&str>) -> (PathBuf, Connection) {
        let path = dir.join("profile-state.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE profile_state_documents (
               domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL,
               domain_version INTEGER NOT NULL, revision INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO profile_state_documents VALUES ('terminal', '{}', 1, 1, 0, 'x')",
            [],
        )
        .unwrap();
        if let Some(payload) = payload {
            db.execute(
                "INSERT INTO profile_state_documents VALUES ('settings', ?1, 1, 1, 0, 'x')",
                [payload],
            )
            .unwrap();
        }
        (path, db)
    }

    #[test]
    fn the_catalog_is_orcas_built_in_themes_with_every_color() {
        let themes = catalog();
        assert_eq!(themes.len(), 31);
        assert_eq!(themes[0].name, DEFAULT_DARK);
        assert_eq!(themes[1].name, DEFAULT_LIGHT);
        let mut names: Vec<_> = themes.iter().map(|t| t.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 31);
        for theme in themes {
            let c = &theme.colors;
            for color in [
                &c.background,
                &c.foreground,
                &c.cursor,
                &c.cursor_accent,
                &c.selection_background,
                &c.selection_foreground,
            ] {
                assert!(is_hex(color.as_deref().unwrap()), "{}", theme.name);
            }
            let indexes: Vec<u8> = c.palette.iter().map(|p| p.index).collect();
            assert_eq!(indexes, (0..16).collect::<Vec<u8>>(), "{}", theme.name);
            assert!(c.palette.iter().all(|p| is_hex(&p.color)), "{}", theme.name);
        }
    }

    #[test]
    fn a_theme_gives_its_colors_to_the_terminal() {
        let tango = &catalog()[1];
        let c = &tango.colors;
        assert_eq!(c.background.as_deref(), Some("#ffffff"));
        assert_eq!(c.foreground.as_deref(), Some("#2e3434"));
        assert_eq!(c.selection_background.as_deref(), Some("#accef7"));
        // Orca darkens yellow and white of Tango for a white ground.
        assert_eq!(
            c.palette[3],
            PaletteColor {
                index: 3,
                color: "#8e7700".into()
            }
        );
        assert_eq!(c.palette[7].color, "#6a6a6a");
        assert_eq!(c.palette[15].color, "#3d3d3d");
    }

    #[test]
    fn orcas_choice_is_taken_when_both_are_built_in() {
        let payload = r##"{"theme":"dark","terminalUseSeparateLightTheme":false,"terminalThemeLight":"One Light","terminalThemeDark":"Dracula","terminalCustomThemes":[]}"##;
        assert_eq!(
            from_orca_settings(payload),
            Some(selection("One Light", "Dracula"))
        );
    }

    #[test]
    fn what_orca_leaves_out_is_the_default() {
        let expected = Some(default_selection());
        assert_eq!(from_orca_settings("{}"), expected);
        assert_eq!(
            from_orca_settings(r#"{"terminalThemeLight":"","terminalThemeDark":7}"#),
            expected
        );
        assert_eq!(
            from_orca_settings(r#"{"terminalThemeLight":null,"terminalThemeDark":["Dracula"]}"#),
            expected
        );
    }

    #[test]
    fn a_theme_that_is_not_built_in_becomes_the_default_of_its_slot() {
        let payload = r#"{"terminalThemeLight":"custom:ghostty:paper","terminalThemeDark":"Dracula","terminalCustomThemes":[{"id":"ghostty:paper","name":"Paper"}]}"#;
        assert_eq!(
            from_orca_settings(payload),
            Some(selection(DEFAULT_LIGHT, "Dracula"))
        );
        let payload =
            r#"{"terminalThemeLight":"Solarized Light","terminalThemeDark":"No Such Theme"}"#;
        assert_eq!(
            from_orca_settings(payload),
            Some(selection("Solarized Light", DEFAULT_DARK))
        );
        // A plugin's palette, and a name in another case, are not built in either.
        let payload = r#"{"terminalThemeLight":"plugin:x","terminalThemeDark":"dracula"}"#;
        assert_eq!(from_orca_settings(payload), Some(default_selection()));
    }

    #[test]
    fn a_text_that_is_not_an_object_gives_nothing() {
        for text in ["", "{", "[]", "\"Dracula\"", "null", "7"] {
            assert_eq!(from_orca_settings(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_theme_the_catalog_lacks_is_replaced_in_a_choice() {
        assert_eq!(
            normalize(selection("custom:a", "Dracula")),
            selection(DEFAULT_LIGHT, "Dracula")
        );
        assert_eq!(
            normalize(selection("One Light", "Nope")),
            selection("One Light", DEFAULT_DARK)
        );
        // A light theme may be chosen for the dark appearance and the other way round.
        assert_eq!(
            normalize(selection("Dracula", "One Light")),
            selection("Dracula", "One Light")
        );
    }

    #[test]
    fn the_settings_document_is_read_from_a_database_in_wal_mode() {
        let dir = temp_dir("read");
        let (path, _live) = orca_db_with(&dir, Some(r#"{"terminalThemeDark":"Nord"}"#));
        assert!(dir.join("profile-state.db-wal").exists());
        assert_eq!(
            read_orca_settings(&path).as_deref(),
            Some(r#"{"terminalThemeDark":"Nord"}"#)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_database_without_the_settings_row_gives_nothing() {
        let dir = temp_dir("norow");
        let (path, _live) = orca_db_with(&dir, None);
        assert_eq!(read_orca_settings(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_foreign_file_gives_nothing_and_is_not_made() {
        let dir = temp_dir("missing");
        let path = dir.join("none.db");
        assert_eq!(read_orca_settings(&path), None);
        assert!(!path.exists());
        std::fs::write(&path, "not a database, just text").unwrap();
        assert_eq!(read_orca_settings(&path), None);
        // A database of another shape has no such table.
        let other = dir.join("other.db");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE t (a)")
            .unwrap();
        assert_eq!(read_orca_settings(&other), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_does_not_write_the_database() {
        let dir = temp_dir("readonly");
        let (path, live) = orca_db_with(&dir, Some("{}"));
        live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(live);
        let before = std::fs::read(&path).unwrap();
        assert!(read_orca_settings(&path).is_some());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_choice_is_saved_and_read_back() {
        let dir = temp_dir("save");
        assert_eq!(load(&dir), None);
        save(&dir, &selection("One Light", "Dracula")).unwrap();
        assert_eq!(load(&dir), Some(selection("One Light", "Dracula")));
        assert!(!dir.join(SELECTION_TMP_FILE).exists());
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(SELECTION_FILE)).unwrap())
                .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"light": "One Light", "dark": "Dracula", "appearance": "system"})
        );
        // A file that cannot be used is as good as none.
        std::fs::write(dir.join(SELECTION_FILE), "{").unwrap();
        assert_eq!(load(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_appearance_is_saved_and_read_back_for_each_value() {
        let dir = temp_dir("appearance");
        for (appearance, text) in [
            (Appearance::System, "system"),
            (Appearance::Light, "light"),
            (Appearance::Dark, "dark"),
        ] {
            let chosen = ThemeSelection {
                appearance,
                ..selection("One Light", "Dracula")
            };
            assert_eq!(set(&dir, chosen.clone()).unwrap(), chosen);
            assert_eq!(load(&dir), Some(chosen));
            let json: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join(SELECTION_FILE)).unwrap())
                    .unwrap();
            assert_eq!(json["appearance"], text);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_without_an_appearance_or_with_a_bad_one_follows_the_system() {
        let dir = temp_dir("appearance-bad");
        let expected = Some(selection("One Light", "Nord"));
        for text in [
            r#"{"light":"One Light","dark":"Nord"}"#,
            r#"{"light":"One Light","dark":"Nord","appearance":"sepia"}"#,
            r#"{"light":"One Light","dark":"Nord","appearance":"Dark "}"#,
            r#"{"light":"One Light","dark":"Nord","appearance":7}"#,
            r#"{"light":"One Light","dark":"Nord","appearance":null}"#,
            r#"{"light":"One Light","dark":"Nord","appearance":["dark"]}"#,
        ] {
            std::fs::write(dir.join(SELECTION_FILE), text).unwrap();
            assert_eq!(load(&dir), expected, "{text}");
        }
        // A bad name still falls back by slot, and the appearance is kept.
        std::fs::write(
            dir.join(SELECTION_FILE),
            r#"{"light":"Gone","dark":"Nord","appearance":"dark"}"#,
        )
        .unwrap();
        assert_eq!(
            load(&dir),
            Some(ThemeSelection {
                appearance: Appearance::Dark,
                ..selection(DEFAULT_LIGHT, "Nord")
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_defaults_and_orcas_choice_follow_the_system() {
        assert_eq!(default_selection().appearance, Appearance::System);
        assert_eq!(
            from_orca_settings(r#"{"theme":"dark","terminalThemeDark":"Nord"}"#)
                .unwrap()
                .appearance,
            Appearance::System
        );
        // The appearance chosen in the app is not lost when a name is replaced.
        let chosen = ThemeSelection {
            appearance: Appearance::Light,
            ..selection("custom:a", "Nord")
        };
        assert_eq!(normalize(chosen).appearance, Appearance::Light);
    }

    #[test]
    fn the_saved_choice_wins_and_orca_is_not_read() {
        let dir = temp_dir("saved");
        save(&dir, &selection("One Light", "Nord")).unwrap();
        let missing = dir.join("none.db");
        assert_eq!(
            resolve(&dir, Some(&missing)).unwrap(),
            selection("One Light", "Nord")
        );
        assert!(!missing.exists());
        // A saved name that is no longer built in is replaced by the default of its slot.
        std::fs::write(
            dir.join(SELECTION_FILE),
            r#"{"light":"Gone","dark":"Nord"}"#,
        )
        .unwrap();
        assert_eq!(
            resolve(&dir, None).unwrap(),
            selection(DEFAULT_LIGHT, "Nord")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_time_orca_can_be_read_it_gives_the_choice_once() {
        let dir = temp_dir("first");
        let (path, db) = orca_db_with(
            &dir,
            Some(r#"{"terminalThemeLight":"Rose Pine Dawn","terminalThemeDark":"Kanagawa"}"#),
        );
        assert_eq!(
            resolve(&dir, Some(&path)).unwrap(),
            selection("Rose Pine Dawn", "Kanagawa")
        );
        assert_eq!(load(&dir), Some(selection("Rose Pine Dawn", "Kanagawa")));
        // Orca changes later: the app keeps what it took.
        db.execute(
            "UPDATE profile_state_documents SET payload = ?1 WHERE domain = 'settings'",
            [r#"{"terminalThemeLight":"One Light","terminalThemeDark":"Nord"}"#],
        )
        .unwrap();
        assert_eq!(
            resolve(&dir, Some(&path)).unwrap(),
            selection("Rose Pine Dawn", "Kanagawa")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_custom_theme_in_orca_is_not_taken_and_the_default_is_saved() {
        let dir = temp_dir("custom");
        let (path, _db) = orca_db_with(
            &dir,
            Some(r#"{"terminalThemeLight":"custom:manual:mine","terminalThemeDark":"Monokai"}"#),
        );
        assert_eq!(
            resolve(&dir, Some(&path)).unwrap(),
            selection(DEFAULT_LIGHT, "Monokai")
        );
        assert_eq!(load(&dir), Some(selection(DEFAULT_LIGHT, "Monokai")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn when_orca_cannot_be_read_the_default_is_used_and_not_saved() {
        let dir = temp_dir("unreadable");
        assert_eq!(resolve(&dir, None).unwrap(), default_selection());
        let missing = dir.join("none.db");
        assert_eq!(resolve(&dir, Some(&missing)).unwrap(), default_selection());
        assert_eq!(load(&dir), None);
        // Orca can be read at a later start: it gives the choice then.
        let (path, _db) = orca_db_with(&dir, Some(r#"{"terminalThemeDark":"Nord"}"#));
        assert_eq!(
            resolve(&dir, Some(&path)).unwrap(),
            selection(DEFAULT_LIGHT, "Nord")
        );
        // A document that is not an object is not readable either.
        let dir2 = temp_dir("unreadable2");
        let (path2, _db2) = orca_db_with(&dir2, Some("[]"));
        assert_eq!(resolve(&dir2, Some(&path2)).unwrap(), default_selection());
        assert_eq!(load(&dir2), None);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn a_failed_save_of_the_first_choice_is_an_error() {
        let dir = temp_dir("nosave");
        let (path, _db) = orca_db_with(&dir, Some("{}"));
        // The config folder is a file, so nothing can be saved in it.
        let blocked = dir.join("blocked");
        std::fs::write(&blocked, "").unwrap();
        assert!(resolve(&blocked, Some(&path)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_choice_is_saved_when_every_name_is_built_in() {
        let dir = temp_dir("set");
        let saved = set(&dir, selection("Dracula", "One Light")).unwrap();
        assert_eq!(saved, selection("Dracula", "One Light"));
        assert_eq!(load(&dir), Some(selection("Dracula", "One Light")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_choice_with_an_unknown_name_is_refused_and_nothing_is_saved() {
        let dir = temp_dir("setbad");
        save(&dir, &selection("One Light", "Nord")).unwrap();
        let error = set(&dir, selection("custom:x", "Nord")).unwrap_err();
        assert!(error.contains("custom:x"), "{error}");
        let error = set(&dir, selection("One Light", "Nope")).unwrap_err();
        assert!(error.contains("Nope"), "{error}");
        assert_eq!(load(&dir), Some(selection("One Light", "Nord")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
