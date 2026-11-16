//! The side menu (#676): the order of the six screens that can move, and whether each is shown.
//!
//! The choice is saved in `side-menu.json` in the app config directory, as one list that holds each of the six screens once (`MenuScreen`).
//! The settings and the Claude and settings buttons at the bottom of the sidebar are not in it: they stay where they are.
//! The mail screen (the inbox) is always shown; it can move, but it cannot be turned off.
//! Rust brings every value into its shape, so a hand-edited or broken file never gives the screen a list it cannot draw: `load_settings` mends the list, and `checked` refuses a list that is not a whole one.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_atomic, auth::config_dir};

const FILE: &str = "side-menu.json";

/// A screen of the sidebar that can move. The names are those of `Screen` in `ts/nav.ts`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum MenuScreen {
    Mail,
    Calendar,
    Todo,
    Slack,
    Orca,
    Database,
}

/// The six screens, in the order the sidebar has had them.
const SCREENS: [MenuScreen; 6] = [
    MenuScreen::Mail,
    MenuScreen::Calendar,
    MenuScreen::Todo,
    MenuScreen::Slack,
    MenuScreen::Orca,
    MenuScreen::Database,
];

/// One place of the list: the screen, and whether the sidebar shows it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct MenuEntry {
    pub screen: MenuScreen,
    pub enabled: bool,
}

/// The six screens from top to bottom, each once.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct MenuSettings {
    pub items: Vec<MenuEntry>,
}

impl Default for MenuSettings {
    fn default() -> Self {
        Self {
            items: SCREENS
                .iter()
                .map(|&screen| MenuEntry {
                    screen,
                    enabled: true,
                })
                .collect(),
        }
    }
}

/// The list a saved value gives: a screen that is unknown or already listed is dropped, a screen that is missing is added at the end (shown), a `enabled` that is not a boolean is true, and the mail screen is shown.
fn mended(saved: Option<&Value>) -> MenuSettings {
    let mut items: Vec<MenuEntry> = Vec::new();
    let listed = saved.and_then(|v| v.get("items")).and_then(Value::as_array);
    for item in listed.into_iter().flatten() {
        let Some(screen) = item
            .get("screen")
            .and_then(|v| serde_json::from_value::<MenuScreen>(v.clone()).ok())
        else {
            continue;
        };
        if items.iter().any(|entry| entry.screen == screen) {
            continue;
        }
        let enabled = item.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        items.push(MenuEntry {
            screen,
            enabled: enabled || screen == MenuScreen::Mail,
        });
    }
    for screen in SCREENS {
        if !items.iter().any(|entry| entry.screen == screen) {
            items.push(MenuEntry {
                screen,
                enabled: true,
            });
        }
    }
    MenuSettings { items }
}

/// The saved settings; a missing file, one that is not JSON and a field that cannot be used give the first values.
pub fn load_settings(dir: &Path) -> MenuSettings {
    let saved = std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    mended(saved.as_ref())
}

fn save_settings(dir: &Path, settings: &MenuSettings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    write_atomic(dir, FILE, &text)
}

/// The settings a list from the screen gives: it must hold each of the six screens exactly once, and the mail screen must be shown.
fn checked(items: Vec<MenuEntry>) -> Result<MenuSettings, String> {
    let whole = items.len() == SCREENS.len()
        && SCREENS
            .iter()
            .all(|screen| items.iter().filter(|e| e.screen == *screen).count() == 1);
    if !whole {
        return Err("メニューの項目が正しくありません".into());
    }
    if items
        .iter()
        .any(|e| e.screen == MenuScreen::Mail && !e.enabled)
    {
        return Err("受信トレイは外せません".into());
    }
    Ok(MenuSettings { items })
}

/// The order and the on and off of the sidebar's screens (#676).
#[tauri::command]
pub async fn side_menu_settings(app: AppHandle) -> Result<MenuSettings, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || load_settings(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// Saves the whole list and answers the settings saved (#676). A list that is not each screen once, or that turns the mail screen off, is an error and nothing is written.
#[tauri::command]
pub async fn side_menu_settings_set(
    app: AppHandle,
    items: Vec<MenuEntry>,
) -> Result<MenuSettings, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let settings = checked(items)?;
        save_settings(&dir, &settings)?;
        Ok(settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tsunagiai-side-menu-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(screen: MenuScreen, enabled: bool) -> MenuEntry {
        MenuEntry { screen, enabled }
    }

    fn screens(settings: &MenuSettings) -> Vec<MenuScreen> {
        settings.items.iter().map(|e| e.screen).collect()
    }

    #[test]
    fn the_first_values_are_the_order_the_sidebar_has_had_with_every_screen_shown() {
        let first = MenuSettings::default();
        assert_eq!(screens(&first), SCREENS.to_vec());
        assert!(first.items.iter().all(|e| e.enabled));
        let dir = temp_dir("first");
        assert_eq!(load_settings(&dir), first);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_settings_are_saved_and_read_back() {
        let dir = temp_dir("roundtrip");
        let settings = MenuSettings {
            items: vec![
                entry(MenuScreen::Orca, true),
                entry(MenuScreen::Mail, true),
                entry(MenuScreen::Database, false),
                entry(MenuScreen::Todo, true),
                entry(MenuScreen::Calendar, false),
                entry(MenuScreen::Slack, true),
            ],
        };
        save_settings(&dir, &settings).unwrap();
        assert_eq!(load_settings(&dir), settings);
        // The temporary file does not stay.
        assert!(!dir.join("side-menu.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_is_json_with_a_list_of_screens_by_their_nav_names() {
        let dir = temp_dir("shape");
        save_settings(&dir, &MenuSettings::default()).unwrap();
        let text = std::fs::read_to_string(dir.join("side-menu.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        let names: Vec<&str> = value["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["screen"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["mail", "calendar", "todo", "slack", "orca", "database"]
        );
        assert_eq!(value["items"][0]["enabled"], json!(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_cannot_be_used_gives_the_first_values() {
        let dir = temp_dir("broken");
        for text in ["not json", "[]", "{}", r#"{"items":"mail"}"#, ""] {
            std::fs::write(dir.join("side-menu.json"), text).unwrap();
            assert_eq!(load_settings(&dir), MenuSettings::default(), "{text:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_list_in_the_file_is_mended_and_the_rest_stays() {
        let saved = json!({"items": [
            {"screen": "slack", "enabled": false},
            {"screen": "nowhere", "enabled": true},
            {"screen": "slack", "enabled": true},
            "text",
            {"enabled": true},
            {"screen": "todo"},
            {"screen": "orca", "enabled": "no"},
        ]});
        let mended = mended(Some(&saved));
        // The unknown, the repeated and the shapeless are gone; the missing three follow, shown, in the first order.
        assert_eq!(
            mended.items,
            vec![
                entry(MenuScreen::Slack, false),
                entry(MenuScreen::Todo, true),
                entry(MenuScreen::Orca, true),
                entry(MenuScreen::Mail, true),
                entry(MenuScreen::Calendar, true),
                entry(MenuScreen::Database, true),
            ]
        );
    }

    #[test]
    fn the_mail_screen_is_shown_whatever_the_file_says() {
        let saved = json!({"items": [{"screen": "mail", "enabled": false}]});
        let mended = mended(Some(&saved));
        assert_eq!(mended.items[0], entry(MenuScreen::Mail, true));
        assert_eq!(mended.items.len(), 6);
    }

    #[test]
    fn a_whole_list_is_taken_in_the_order_it_comes() {
        let items = vec![
            entry(MenuScreen::Database, true),
            entry(MenuScreen::Mail, true),
            entry(MenuScreen::Slack, false),
            entry(MenuScreen::Calendar, true),
            entry(MenuScreen::Orca, false),
            entry(MenuScreen::Todo, true),
        ];
        let settings = checked(items.clone()).unwrap();
        assert_eq!(settings.items, items);
    }

    #[test]
    fn a_list_that_is_not_each_screen_once_is_refused() {
        let whole = MenuSettings::default().items;
        let mut missing = whole.clone();
        missing.pop();
        let mut repeated = whole.clone();
        repeated[5] = entry(MenuScreen::Mail, true);
        let mut too_long = whole.clone();
        too_long.push(entry(MenuScreen::Mail, true));
        for items in [missing, repeated, too_long, Vec::new()] {
            assert_eq!(
                checked(items),
                Err("メニューの項目が正しくありません".to_string())
            );
        }
    }

    #[test]
    fn the_mail_screen_cannot_be_turned_off() {
        let mut items = MenuSettings::default().items;
        items[0].enabled = false;
        assert_eq!(checked(items), Err("受信トレイは外せません".to_string()));
    }

    #[test]
    fn a_refused_list_leaves_the_saved_file_as_it_was() {
        let dir = temp_dir("refused");
        let saved = MenuSettings {
            items: vec![
                entry(MenuScreen::Todo, true),
                entry(MenuScreen::Mail, true),
                entry(MenuScreen::Calendar, true),
                entry(MenuScreen::Slack, true),
                entry(MenuScreen::Orca, true),
                entry(MenuScreen::Database, false),
            ],
        };
        save_settings(&dir, &saved).unwrap();
        // The command checks before it writes.
        let mut items = saved.items.clone();
        items[1].enabled = false;
        assert!(checked(items).is_err());
        assert_eq!(load_settings(&dir), saved);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_screen_comes_by_its_nav_name() {
        let entry: MenuEntry =
            serde_json::from_value(json!({"screen": "database", "enabled": false})).unwrap();
        assert_eq!(
            entry,
            MenuEntry {
                screen: MenuScreen::Database,
                enabled: false
            }
        );
        assert!(serde_json::from_value::<MenuEntry>(
            json!({"screen": "settings", "enabled": true})
        )
        .is_err());
    }
}
