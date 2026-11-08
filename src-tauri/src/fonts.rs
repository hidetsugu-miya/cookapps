//! A-20: the font (the family and the size) of each screen, chosen in the settings.
//!
//! The choice is saved in `font-settings.json` in the app config directory, one pick for each place of a screen (`FontArea`).
//! The families to choose from are those of the fonts on this Mac (`installed_families`: CoreText's `CTFontManagerCopyAvailableFontFamilyNames`); nothing is fetched and no font is loaded from outside.
//! Rust brings every value into its range, so a hand-edited or broken file never gives the screen a size or a name it cannot use: `load_settings` mends each field on its own, and `set_pick` refuses a family this Mac does not have.

use std::{path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_synced, auth::config_dir};

const FILE: &str = "font-settings.json";
const TMP_FILE: &str = "font-settings.json.tmp";
/// The sizes, in pixels: the range and the step.
const SIZE_MIN: f64 = 8.0;
const SIZE_MAX: f64 = 32.0;
const SIZE_STEP: f64 = 0.5;
/// The text size of the app's screens, and the first sizes of the terminals and of the editor (those they have had since A-8 and A-18).
const SIZE_TEXT: f64 = 14.0;
const SIZE_TERMINAL: f64 = 13.0;
const SIZE_EDITOR: f64 = 12.5;
/// The longest family name, in characters.
const FAMILY_MAX: usize = 200;
/// A save reads the file and writes it again: two at once would lose one.
static SAVING: Mutex<()> = Mutex::new(());

/// A place of a screen that has a font of its own.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum FontArea {
    Mail,
    Calendar,
    TodoList,
    TodoWork,
    Slack,
    OrcaList,
    OrcaWork,
    Editor,
}

/// The font of one place: the family (`None` is the app's own) and the size in pixels.
/// `ghostty` is true only for the work space of Orca (the terminals): they then draw with the family and size of Ghostty's import (A-13), and `family` and `size` wait for the choice to be changed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct FontPick {
    pub family: Option<String>,
    pub size: f64,
    pub ghostty: bool,
}

/// The fonts of every place.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct FontSettings {
    pub mail: FontPick,
    pub calendar: FontPick,
    pub todo_list: FontPick,
    pub todo_work: FontPick,
    pub slack: FontPick,
    pub orca_list: FontPick,
    pub orca_work: FontPick,
    pub editor: FontPick,
}

fn pick(size: f64, ghostty: bool) -> FontPick {
    FontPick {
        family: None,
        size,
        ghostty,
    }
}

impl Default for FontSettings {
    fn default() -> Self {
        Self {
            mail: pick(SIZE_TEXT, false),
            calendar: pick(SIZE_TEXT, false),
            todo_list: pick(SIZE_TEXT, false),
            todo_work: pick(SIZE_TEXT, false),
            slack: pick(SIZE_TEXT, false),
            orca_list: pick(SIZE_TEXT, false),
            orca_work: pick(SIZE_TERMINAL, true),
            editor: pick(SIZE_EDITOR, false),
        }
    }
}

impl FontSettings {
    fn pick_mut(&mut self, area: FontArea) -> &mut FontPick {
        match area {
            FontArea::Mail => &mut self.mail,
            FontArea::Calendar => &mut self.calendar,
            FontArea::TodoList => &mut self.todo_list,
            FontArea::TodoWork => &mut self.todo_work,
            FontArea::Slack => &mut self.slack,
            FontArea::OrcaList => &mut self.orca_list,
            FontArea::OrcaWork => &mut self.orca_work,
            FontArea::Editor => &mut self.editor,
        }
    }
}

/// The size a number gives: into 8 to 32 pixels, to the nearest half pixel (the upper one from the middle).
fn clamp_size(size: f64) -> f64 {
    (size.clamp(SIZE_MIN, SIZE_MAX) / SIZE_STEP).round() * SIZE_STEP
}

/// A family name that can be used: trimmed, not empty, at most 200 characters, with no control character.
fn valid_family(raw: &str) -> Option<String> {
    let name = raw.trim();
    let usable = !name.is_empty()
        && name.chars().count() <= FAMILY_MAX
        && !name.chars().any(char::is_control);
    usable.then(|| name.to_string())
}

/// The pick a saved value gives: each field that cannot be used becomes the default's.
/// Only the work space of Orca may follow Ghostty.
fn pick_from(value: Option<&Value>, default: &FontPick, may_follow_ghostty: bool) -> FontPick {
    let field = |key: &str| value.and_then(|v| v.get(key));
    FontPick {
        family: field("family")
            .and_then(Value::as_str)
            .and_then(valid_family),
        size: field("size")
            .and_then(Value::as_f64)
            .map_or(default.size, clamp_size),
        ghostty: may_follow_ghostty
            && field("ghostty")
                .and_then(Value::as_bool)
                .unwrap_or(default.ghostty),
    }
}

/// The saved settings; a missing file, one that is not JSON and a field that cannot be used give the first values.
fn load_settings(dir: &Path) -> FontSettings {
    let saved = std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let saved = saved.as_ref();
    let first = FontSettings::default();
    let of = |key: &str, default: &FontPick, follow: bool| {
        pick_from(saved.and_then(|v| v.get(key)), default, follow)
    };
    FontSettings {
        mail: of("mail", &first.mail, false),
        calendar: of("calendar", &first.calendar, false),
        todo_list: of("todoList", &first.todo_list, false),
        todo_work: of("todoWork", &first.todo_work, false),
        slack: of("slack", &first.slack, false),
        orca_list: of("orcaList", &first.orca_list, false),
        orca_work: of("orcaWork", &first.orca_work, true),
        editor: of("editor", &first.editor, false),
    }
}

fn save_settings(dir: &Path, settings: &FontSettings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(FILE), dir.join(TMP_FILE));
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Rename over the target so a crash mid-write leaves the old file, not a truncated one.
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// The settings with the pick of `area` changed. The family must be one of `installed`; the size is brought into its range; only the work space of Orca may follow Ghostty.
fn set_pick(
    settings: &FontSettings,
    area: FontArea,
    family: Option<&str>,
    size: f64,
    ghostty: bool,
    installed: &[String],
) -> Result<FontSettings, String> {
    if ghostty && area != FontArea::OrcaWork {
        return Err("Ghostty の設定に従えるのは、Orca の作業スペースだけです".into());
    }
    if size.is_nan() {
        return Err("大きさが正しくありません".into());
    }
    let family = match family {
        None => None,
        Some(raw) => Some(
            valid_family(raw)
                .filter(|name| installed.contains(name))
                .ok_or_else(|| format!("書体「{}」はこの Mac にありません", raw.trim()))?,
        ),
    };
    let mut next = settings.clone();
    *next.pick_mut(area) = FontPick {
        family,
        size: clamp_size(size),
        ghostty,
    };
    Ok(next)
}

/// The family names a list of the system gives, for choosing from: trimmed, the hidden ones of the system (a name that starts with a dot) and the unusable ones left out, in alphabetical order without regard to case, once each.
fn clean_families(names: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = names
        .iter()
        .filter(|name| !name.trim_start().starts_with('.'))
        .filter_map(|name| valid_family(name))
        .collect();
    names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
    names.dedup();
    names
}

/// The families of the fonts on this Mac. Other systems give none.
#[cfg(target_os = "macos")]
fn installed_families() -> Vec<String> {
    use objc2_core_foundation::{CFRetained, CFString};
    use objc2_core_text::CTFontManagerCopyAvailableFontFamilyNames;

    // SAFETY: the call takes no argument and has no precondition. The array it returns is made of CFStrings (the family names), so the cast of its element type holds.
    let names = unsafe {
        CFRetained::cast_unchecked::<objc2_core_foundation::CFArray<CFString>>(
            CTFontManagerCopyAvailableFontFamilyNames(),
        )
    };
    clean_families(names.iter().map(|name| name.to_string()).collect())
}

#[cfg(not(target_os = "macos"))]
fn installed_families() -> Vec<String> {
    Vec::new()
}

/// The fonts of every screen (A-20).
#[tauri::command]
pub async fn font_settings(app: AppHandle) -> Result<FontSettings, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || load_settings(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// The families of the fonts on this Mac (A-20).
#[tauri::command]
pub async fn font_families() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(installed_families)
        .await
        .map_err(|e| e.to_string())
}

/// Saves the font of one place and answers the settings saved (A-20).
#[tauri::command]
pub async fn font_settings_set(
    app: AppHandle,
    area: FontArea,
    family: Option<String>,
    size: f64,
    ghostty: bool,
) -> Result<FontSettings, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
        let settings = set_pick(
            &load_settings(&dir),
            area,
            family.as_deref(),
            size,
            ghostty,
            &installed_families(),
        )?;
        save_settings(&dir, &settings)?;
        Ok(settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-fonts-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_first_values_are_the_sizes_the_screens_have_had() {
        let d = FontSettings::default();
        for p in [
            &d.mail,
            &d.calendar,
            &d.todo_list,
            &d.todo_work,
            &d.slack,
            &d.orca_list,
        ] {
            assert_eq!(
                *p,
                FontPick {
                    family: None,
                    size: 14.0,
                    ghostty: false
                }
            );
        }
        assert_eq!(
            d.orca_work,
            FontPick {
                family: None,
                size: 13.0,
                ghostty: true
            }
        );
        assert_eq!(
            d.editor,
            FontPick {
                family: None,
                size: 12.5,
                ghostty: false
            }
        );
    }

    #[test]
    fn a_size_is_brought_into_the_range_and_to_the_nearest_half() {
        assert_eq!(clamp_size(14.0), 14.0);
        assert_eq!(clamp_size(12.5), 12.5);
        assert_eq!(clamp_size(7.0), 8.0);
        assert_eq!(clamp_size(-3.0), 8.0);
        assert_eq!(clamp_size(99.0), 32.0);
        assert_eq!(clamp_size(f64::INFINITY), 32.0);
        assert_eq!(clamp_size(13.2), 13.0);
        assert_eq!(clamp_size(13.3), 13.5);
        // The middle between two steps goes to the upper one.
        assert_eq!(clamp_size(13.25), 13.5);
        assert_eq!(clamp_size(8.2), 8.0);
        assert_eq!(clamp_size(31.8), 32.0);
    }

    #[test]
    fn a_family_name_is_trimmed_and_must_be_usable() {
        assert_eq!(valid_family("Menlo").as_deref(), Some("Menlo"));
        assert_eq!(
            valid_family("  Hiragino Sans ").as_deref(),
            Some("Hiragino Sans")
        );
        assert_eq!(valid_family(""), None);
        assert_eq!(valid_family("   "), None);
        assert_eq!(valid_family("a\nb"), None);
        assert_eq!(valid_family("a\u{0}b"), None);
        assert_eq!(valid_family(&"x".repeat(200)).map(|s| s.len()), Some(200));
        assert_eq!(valid_family(&"x".repeat(201)), None);
        // 200 characters, not bytes.
        assert!(valid_family(&"あ".repeat(200)).is_some());
        // A quote is part of a name; the screen quotes it.
        assert_eq!(valid_family("A\"B").as_deref(), Some("A\"B"));
    }

    #[test]
    fn the_list_of_families_is_cleaned_and_sorted() {
        let got = clean_families(names(&[
            "Zapfino",
            ".SF NS",
            "menlo",
            " Menlo ",
            "Arial",
            "",
            "Menlo",
            "bad\nname",
            "Hiragino Sans",
            "arial",
        ]));
        // Sorted without regard to case; a name that differs only in case is another family, and the same name is once.
        assert_eq!(
            got,
            names(&[
                "Arial",
                "arial",
                "Hiragino Sans",
                "Menlo",
                "menlo",
                "Zapfino"
            ])
        );
        assert!(clean_families(vec![]).is_empty());
    }

    #[test]
    fn the_settings_are_saved_and_read_back() {
        let dir = temp_dir("roundtrip");
        assert_eq!(load_settings(&dir), FontSettings::default());
        let settings = FontSettings {
            mail: FontPick {
                family: Some("Hiragino Sans".into()),
                size: 16.0,
                ghostty: false,
            },
            orca_work: FontPick {
                family: Some("Menlo".into()),
                size: 15.5,
                ghostty: false,
            },
            ..FontSettings::default()
        };
        save_settings(&dir, &settings).unwrap();
        assert_eq!(load_settings(&dir), settings);
        // The temporary file does not stay.
        assert!(!dir.join("font-settings.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_is_json_with_a_pick_for_each_place() {
        let dir = temp_dir("shape");
        save_settings(&dir, &FontSettings::default()).unwrap();
        let text = std::fs::read_to_string(dir.join("font-settings.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut expected = vec![
            "mail", "calendar", "todoList", "todoWork", "slack", "orcaList", "orcaWork", "editor",
        ];
        let mut got = keys.clone();
        got.sort_unstable();
        expected.sort_unstable();
        assert_eq!(got, expected);
        assert_eq!(
            value["orcaWork"],
            serde_json::json!({"family": null, "size": 13.0, "ghostty": true})
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_cannot_be_used_gives_the_first_values() {
        let dir = temp_dir("broken");
        for text in ["", "not json", "[]", "null", "42", "\"x\"", "{"] {
            std::fs::write(dir.join("font-settings.json"), text).unwrap();
            assert_eq!(load_settings(&dir), FontSettings::default(), "{text}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_field_that_cannot_be_used_is_mended_and_the_others_stay() {
        let dir = temp_dir("mend");
        let text = r#"{
            "mail": {"family": "Hiragino Sans", "size": 18, "ghostty": false},
            "calendar": {"family": "", "size": 999, "ghostty": false},
            "todoList": {"family": 5, "size": "big", "ghostty": true},
            "todoWork": "x",
            "slack": {"family": "  Menlo  ", "size": 7.9},
            "orcaWork": {"family": "Menlo", "size": 13.3},
            "editor": {"family": null, "size": null, "ghostty": true}
        }"#;
        std::fs::write(dir.join("font-settings.json"), text).unwrap();
        let got = load_settings(&dir);
        assert_eq!(
            got.mail,
            FontPick {
                family: Some("Hiragino Sans".into()),
                size: 18.0,
                ghostty: false
            }
        );
        // An empty name is no name; a size out of the range is brought into it.
        assert_eq!(
            got.calendar,
            FontPick {
                family: None,
                size: 32.0,
                ghostty: false
            }
        );
        // A name that is not a string and a size that is not a number are the first values; only Orca's work space follows Ghostty.
        assert_eq!(
            got.todo_list,
            FontPick {
                family: None,
                size: 14.0,
                ghostty: false
            }
        );
        assert_eq!(
            got.todo_work,
            FontPick {
                family: None,
                size: 14.0,
                ghostty: false
            }
        );
        assert_eq!(
            got.slack,
            FontPick {
                family: Some("Menlo".into()),
                size: 8.0,
                ghostty: false
            }
        );
        // A work space whose file leaves out `ghostty` keeps following it only when the first values do.
        assert_eq!(
            got.orca_work,
            FontPick {
                family: Some("Menlo".into()),
                size: 13.5,
                ghostty: true
            }
        );
        assert_eq!(got.orca_list, FontSettings::default().orca_list);
        assert_eq!(
            got.editor,
            FontPick {
                family: None,
                size: 12.5,
                ghostty: false
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_work_space_of_orca_can_stop_following_ghostty_in_the_file() {
        let dir = temp_dir("ghostty");
        let text = r#"{"orcaWork": {"family": null, "size": 13, "ghostty": false}}"#;
        std::fs::write(dir.join("font-settings.json"), text).unwrap();
        assert!(!load_settings(&dir).orca_work.ghostty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pick_is_set_with_its_family_checked_against_the_installed_ones() {
        let installed = names(&["Hiragino Sans", "Menlo"]);
        let base = FontSettings::default();
        let got = set_pick(
            &base,
            FontArea::TodoWork,
            Some(" Menlo "),
            15.2,
            false,
            &installed,
        )
        .unwrap();
        assert_eq!(
            got.todo_work,
            FontPick {
                family: Some("Menlo".into()),
                size: 15.0,
                ghostty: false
            }
        );
        // The other places stay.
        assert_eq!(got.todo_list, base.todo_list);
        assert_eq!(got.mail, base.mail);
        // No family is the app's own, whatever is installed.
        let got = set_pick(&got, FontArea::TodoWork, None, 14.0, false, &[]).unwrap();
        assert_eq!(
            got.todo_work,
            FontPick {
                family: None,
                size: 14.0,
                ghostty: false
            }
        );
        // A size out of the range is brought into it.
        let got = set_pick(&base, FontArea::Editor, None, 100.0, false, &installed).unwrap();
        assert_eq!(got.editor.size, 32.0);
    }

    #[test]
    fn a_family_this_mac_lacks_is_refused_in_japanese() {
        let installed = names(&["Menlo"]);
        let err = set_pick(
            &FontSettings::default(),
            FontArea::Mail,
            Some("Comic Neue"),
            14.0,
            false,
            &installed,
        )
        .unwrap_err();
        assert!(err.contains("Comic Neue"), "{err}");
        assert!(err.contains("この Mac"), "{err}");
        // A name that is not usable is refused the same way, and so is a name when nothing is installed.
        assert!(set_pick(
            &FontSettings::default(),
            FontArea::Mail,
            Some(""),
            14.0,
            false,
            &installed
        )
        .is_err());
        assert!(set_pick(
            &FontSettings::default(),
            FontArea::Mail,
            Some("Menlo"),
            14.0,
            false,
            &[]
        )
        .is_err());
        // The case of a name counts: it is the name the system gives.
        assert!(set_pick(
            &FontSettings::default(),
            FontArea::Mail,
            Some("menlo"),
            14.0,
            false,
            &installed
        )
        .is_err());
    }

    #[test]
    fn a_size_that_is_not_a_number_is_refused() {
        let err = set_pick(
            &FontSettings::default(),
            FontArea::Mail,
            None,
            f64::NAN,
            false,
            &[],
        )
        .unwrap_err();
        assert!(err.contains("大きさ"), "{err}");
    }

    #[test]
    fn only_the_work_space_of_orca_may_follow_ghostty() {
        let base = FontSettings::default();
        for area in [
            FontArea::Mail,
            FontArea::Calendar,
            FontArea::TodoList,
            FontArea::TodoWork,
            FontArea::Slack,
            FontArea::OrcaList,
            FontArea::Editor,
        ] {
            let err = set_pick(&base, area, None, 14.0, true, &[]).unwrap_err();
            assert!(err.contains("Ghostty"), "{area:?}: {err}");
        }
        let got = set_pick(
            &base,
            FontArea::OrcaWork,
            Some("Menlo"),
            15.0,
            true,
            &names(&["Menlo"]),
        )
        .unwrap();
        // Following Ghostty keeps the family and the size, for the day the choice is changed.
        assert_eq!(
            got.orca_work,
            FontPick {
                family: Some("Menlo".into()),
                size: 15.0,
                ghostty: true
            }
        );
        let got = set_pick(
            &got,
            FontArea::OrcaWork,
            Some("Menlo"),
            15.0,
            false,
            &names(&["Menlo"]),
        )
        .unwrap();
        assert!(!got.orca_work.ghostty);
    }

    #[test]
    fn every_area_is_set_in_its_own_place() {
        let installed = names(&["Menlo"]);
        let areas = [
            FontArea::Mail,
            FontArea::Calendar,
            FontArea::TodoList,
            FontArea::TodoWork,
            FontArea::Slack,
            FontArea::OrcaList,
            FontArea::OrcaWork,
            FontArea::Editor,
        ];
        for (i, area) in areas.into_iter().enumerate() {
            let mut got = set_pick(
                &FontSettings::default(),
                area,
                Some("Menlo"),
                20.0,
                false,
                &installed,
            )
            .unwrap();
            assert_eq!(
                got.pick_mut(area).family.as_deref(),
                Some("Menlo"),
                "{area:?}"
            );
            // Exactly one place changed.
            let changed = areas
                .into_iter()
                .filter(|a| got.pick_mut(*a).family.is_some())
                .count();
            assert_eq!(changed, 1, "{i} {area:?}");
        }
    }

    #[test]
    fn an_area_comes_by_its_camel_case_name() {
        let area: FontArea = serde_json::from_str("\"todoList\"").unwrap();
        assert_eq!(area, FontArea::TodoList);
        let area: FontArea = serde_json::from_str("\"orcaWork\"").unwrap();
        assert_eq!(area, FontArea::OrcaWork);
        assert!(serde_json::from_str::<FontArea>("\"todo_list\"").is_err());
        assert!(serde_json::from_str::<FontArea>("\"sidebar\"").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_has_families_to_choose_from() {
        let families = installed_families();
        assert!(
            families.iter().any(|f| f == "Helvetica"),
            "{} families",
            families.len()
        );
        assert!(families.iter().all(|f| !f.starts_with('.')));
        assert!(families
            .windows(2)
            .all(|w| w[0].to_lowercase() <= w[1].to_lowercase()));
    }
}
