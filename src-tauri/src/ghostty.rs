//! Ghostty's settings in the terminals of the Orca screen (A-13).
//!
//! The config files are read the way Orca 1.4.250 reads them (`discover` and `load` of its Ghostty import): the files that exist in the order of `config_paths`, a later file replacing an earlier one,
//! and the `theme` is resolved to the colors of its file. What can be drawn by xterm.js is kept in `ghostty-settings.json`; every other entry is listed as not imported.
//! The files are read and never written. A theme file is read for its colors only, and what the files hold is not logged.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_atomic, auth::config_dir};

const SETTINGS_FILE: &str = "ghostty-settings.json";
/// Orca refuses a config file over a million bytes, and a theme file over 256 KiB.
const CONFIG_LIMIT: u64 = 1_000_000;
const THEME_LIMIT: u64 = 262_144;
/// The longest text a key may send.
const TEXT_LIMIT: usize = 1000;

const NOT_SUPPORTED: &str = "対応していません";

/// One color of the palette (0 to 255) as `#rrggbb`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct PaletteColor {
    pub index: u8,
    pub color: String,
}

/// The colors of a terminal, each `#rrggbb`; a color that is `None` stays the app's.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalColors {
    pub background: Option<String>,
    pub foreground: Option<String>,
    pub cursor: Option<String>,
    pub cursor_accent: Option<String>,
    pub selection_background: Option<String>,
    pub selection_foreground: Option<String>,
    /// Sorted by index.
    pub palette: Vec<PaletteColor>,
}

/// A key that sends a text (`keybind = trigger=text:...`). `key` is a `KeyboardEvent.key`: a single character in lower case, or a name such as `Enter`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct TextKeybind {
    pub key: String,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
    pub text: String,
}

/// What the terminals take from the config. A theme with `light:` and `dark:` gives both colors; a single theme gives the same colors to both.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    /// In the order of the config: the first is the font, the others are tried after it.
    pub font_families: Vec<String>,
    pub font_size: Option<f64>,
    pub font_thicken: bool,
    pub light: Option<TerminalColors>,
    pub dark: Option<TerminalColors>,
    pub keybinds: Vec<TextKeybind>,
}

/// An entry of the config that was not imported, as written (`key = value`), and why.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct SkippedEntry {
    pub entry: String,
    pub reason: String,
}

/// The result of an import: the settings, the entries taken and left, and the files read (with `~` for the home folder).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct GhosttyImport {
    pub settings: TerminalSettings,
    pub imported: Vec<String>,
    pub skipped: Vec<SkippedEntry>,
    pub files: Vec<String>,
}

/// Where the config lives on this machine.
pub struct Places {
    pub home: PathBuf,
    pub xdg_config_home: Option<PathBuf>,
    pub resources_dir: Option<PathBuf>,
}

/// The `key = value` lines of a config file, in order. A comment is a line of its own; a double-quoted value loses its quotes.
fn parse_config(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let (key, value) = (key.trim(), value.trim());
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(value);
            (!key.is_empty()).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

/// The folder of Ghostty's config: `$XDG_CONFIG_HOME/ghostty`, else `~/.config/ghostty`.
fn xdg_dir(places: &Places) -> PathBuf {
    places
        .xdg_config_home
        .clone()
        .unwrap_or_else(|| places.home.join(".config"))
        .join("ghostty")
}

/// The config files Orca looks for, in the order it reads them: the XDG folder, then the macOS one, `config.ghostty` before `config` in each.
fn config_paths(places: &Places) -> Vec<PathBuf> {
    [
        xdg_dir(places),
        places
            .home
            .join("Library/Application Support/com.mitchellh.ghostty"),
    ]
    .iter()
    .flat_map(|dir| [dir.join("config.ghostty"), dir.join("config")])
    .collect()
}

/// The folders a theme name is looked for in, in order: the config folder, then Ghostty's own (`GHOSTTY_RESOURCES_DIR`, else the app in `/Applications` or the home folder).
fn theme_dirs(places: &Places) -> Vec<PathBuf> {
    let app = "Applications/Ghostty.app/Contents/Resources/ghostty/themes";
    let mut dirs = vec![xdg_dir(places).join("themes")];
    match &places.resources_dir {
        Some(dir) => dirs.push(dir.join("themes")),
        None => dirs.extend([Path::new("/").join(app), places.home.join(app)]),
    }
    dirs
}

/// `#rrggbb` from `rrggbb`, `#rrggbb`, `rgb` or `#rgb`.
fn parse_color(value: &str) -> Option<String> {
    let hex = value.strip_prefix('#').unwrap_or(value);
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let hex = hex.to_ascii_lowercase();
    match hex.len() {
        6 => Some(format!("#{hex}")),
        3 => Some(format!(
            "#{}",
            hex.chars().flat_map(|c| [c, c]).collect::<String>()
        )),
        _ => None,
    }
}

/// `palette = N=color`.
fn parse_palette(value: &str) -> Option<PaletteColor> {
    let (index, color) = value.split_once('=')?;
    Some(PaletteColor {
        index: index.trim().parse().ok()?,
        color: parse_color(color.trim())?,
    })
}

fn set_palette(palette: &mut Vec<PaletteColor>, entry: PaletteColor) {
    match palette.binary_search_by_key(&entry.index, |p| p.index) {
        Ok(at) => palette[at] = entry,
        Err(at) => palette.insert(at, entry),
    }
}

/// The color a config key sets, if it is one of the six single colors.
fn color_field<'a>(colors: &'a mut TerminalColors, key: &str) -> Option<&'a mut Option<String>> {
    Some(match key {
        "background" => &mut colors.background,
        "foreground" => &mut colors.foreground,
        "cursor-color" => &mut colors.cursor,
        "cursor-text" => &mut colors.cursor_accent,
        "selection-background" => &mut colors.selection_background,
        "selection-foreground" => &mut colors.selection_foreground,
        _ => return None,
    })
}

/// The colors a theme file sets. The other entries of the file are not read.
fn theme_colors(text: &str) -> TerminalColors {
    let mut colors = TerminalColors::default();
    for (key, value) in parse_config(text) {
        if key == "palette" {
            if let Some(entry) = parse_palette(&value) {
                set_palette(&mut colors.palette, entry);
            }
        } else if let Some(field) = color_field(&mut colors, &key) {
            if let Some(color) = parse_color(&value) {
                *field = Some(color);
            }
        }
    }
    colors
}

/// The colors of a theme (if any) with the colors of the config over them; `None` when no color is set at all.
fn with_config_colors(
    theme: Option<TerminalColors>,
    config: &TerminalColors,
) -> Option<TerminalColors> {
    let base = theme.unwrap_or_default();
    let mut palette: BTreeMap<u8, String> = base
        .palette
        .into_iter()
        .map(|p| (p.index, p.color))
        .collect();
    palette.extend(config.palette.iter().map(|p| (p.index, p.color.clone())));
    let colors = TerminalColors {
        background: config.background.clone().or(base.background),
        foreground: config.foreground.clone().or(base.foreground),
        cursor: config.cursor.clone().or(base.cursor),
        cursor_accent: config.cursor_accent.clone().or(base.cursor_accent),
        selection_background: config
            .selection_background
            .clone()
            .or(base.selection_background),
        selection_foreground: config
            .selection_foreground
            .clone()
            .or(base.selection_foreground),
        palette: palette
            .into_iter()
            .map(|(index, color)| PaletteColor { index, color })
            .collect(),
    };
    (colors != TerminalColors::default()).then_some(colors)
}

/// The light and dark theme a `theme` value names: one name for both, or `light:A,dark:B` (both needed, in either order). A name is a file name or an absolute path (`~/` too).
fn theme_names(value: &str) -> Option<(String, String)> {
    let valid = |name: &str| {
        !name.is_empty()
            && (name.starts_with('/')
                || name.starts_with("~/")
                || !(name.contains(['/', '\\']) || name == "." || name == ".."))
    };
    let value = value.trim();
    if !value.contains([',', ':']) {
        return valid(value).then(|| (value.to_owned(), value.to_owned()));
    }
    let (mut light, mut dark) = (None, None);
    for part in value.split(',') {
        let (which, name) = part.split_once(':')?;
        let name = name.trim();
        let slot = match which.trim() {
            "light" => &mut light,
            "dark" => &mut dark,
            _ => return None,
        };
        if slot.is_some() || !valid(name) {
            return None;
        }
        *slot = Some(name.to_owned());
    }
    Some((light?, dark?))
}

fn not_supported(detail: &str) -> String {
    format!("{NOT_SUPPORTED}（{detail}）")
}

/// The key of a Ghostty trigger as `KeyboardEvent.key` has it: a single character in lower case, or a named key.
fn dom_key(name: &str) -> Option<String> {
    if name.chars().count() == 1 {
        return Some(name.to_owned());
    }
    let named = match name {
        "enter" | "return" => "Enter",
        "tab" => "Tab",
        "space" => " ",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "escape" | "esc" => "Escape",
        "up" | "arrow_up" => "ArrowUp",
        "down" | "arrow_down" => "ArrowDown",
        "left" | "arrow_left" => "ArrowLeft",
        "right" | "arrow_right" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "page_up" => "PageUp",
        "page_down" => "PageDown",
        "insert" => "Insert",
        "plus" => "+",
        "equal" => "=",
        "minus" => "-",
        "comma" => ",",
        "period" => ".",
        "semicolon" => ";",
        "apostrophe" => "'",
        "slash" => "/",
        "backslash" => "\\",
        "bracket_left" => "[",
        "bracket_right" => "]",
        "backquote" | "grave_accent" => "`",
        _ => {
            let number: u8 = name.strip_prefix('f')?.parse().ok()?;
            return (1..=12).contains(&number).then(|| format!("F{number}"));
        }
    };
    Some(named.to_owned())
}

/// A trigger of one key with its modifiers (`ctrl+shift+a`), as a keybind with no text.
fn parse_trigger(trigger: &str) -> Result<TextKeybind, String> {
    if trigger.contains('>') {
        return Err(not_supported("キーの連続"));
    }
    let mut bind = TextKeybind {
        key: String::new(),
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
        text: String::new(),
    };
    let mut key = None;
    for part in trigger.split('+') {
        let part = part.trim().to_lowercase();
        let modifier = match part.as_str() {
            "shift" => &mut bind.shift,
            "ctrl" | "control" => &mut bind.ctrl,
            "alt" | "opt" | "option" => &mut bind.alt,
            "super" | "cmd" | "command" => &mut bind.meta,
            _ => {
                let name = dom_key(&part).ok_or_else(|| not_supported("キー"))?;
                if key.replace(name).is_some() {
                    return Err(not_supported("キーが 2 つあります"));
                }
                continue;
            }
        };
        if std::mem::replace(modifier, true) {
            return Err(not_supported("修飾キーが重なっています"));
        }
    }
    bind.key = key.ok_or_else(|| not_supported("キーがありません"))?;
    Ok(bind)
}

/// A text written as a Zig string literal, as Ghostty reads `text:`. Only a text that can be typed into a terminal: no NUL, no byte alone above 0x7f.
fn parse_text(text: &str) -> Result<String, String> {
    let bad = || not_supported("文字の書き方");
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        out.push(match chars.next().ok_or_else(bad)? {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            c @ ('\\' | '\'' | '"') => c,
            'x' => {
                let hex: String = chars.by_ref().take(2).collect();
                if hex.len() != 2 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(bad());
                }
                let byte = u8::from_str_radix(&hex, 16).map_err(|_| bad())?;
                if !byte.is_ascii() {
                    return Err(bad());
                }
                char::from(byte)
            }
            'u' => {
                if chars.next() != Some('{') {
                    return Err(bad());
                }
                let hex: String = chars.by_ref().take_while(|&c| c != '}').collect();
                if hex.is_empty() || hex.len() > 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(bad());
                }
                u32::from_str_radix(&hex, 16)
                    .ok()
                    .and_then(char::from_u32)
                    .ok_or_else(bad)?
            }
            _ => return Err(bad()),
        });
    }
    if out.is_empty() || out.contains('\0') || out.chars().count() > TEXT_LIMIT {
        return Err(bad());
    }
    Ok(out)
}

/// What a `keybind` value is: the clearing of all keys, a key that sends text, or something left out (with its trigger when it has a valid one, since it replaces the key that had it).
enum Keybind {
    Clear,
    Text(TextKeybind),
    Left(Option<TextKeybind>, String),
}

fn parse_keybind(value: &str) -> Keybind {
    if value == "clear" {
        return Keybind::Clear;
    }
    let Some((trigger, action)) = value.split_once('=') else {
        return Keybind::Left(None, NOT_SUPPORTED.to_owned());
    };
    let mut bind = match parse_trigger(trigger) {
        Ok(bind) => bind,
        Err(reason) => return Keybind::Left(None, reason),
    };
    match action.strip_prefix("text:").map_or_else(
        || Err(not_supported("文字を送る割り当てではありません")),
        parse_text,
    ) {
        Ok(text) => {
            bind.text = text;
            Keybind::Text(bind)
        }
        Err(reason) => Keybind::Left(Some(bind), reason),
    }
}

/// Whether two keys have the same trigger, so that a later key replaces the earlier.
fn same_trigger(a: &TextKeybind, b: &TextKeybind) -> bool {
    (a.shift, a.ctrl, a.alt, a.meta, &a.key) == (b.shift, b.ctrl, b.alt, b.meta, &b.key)
}

/// Names a trigger for `taken`, which lists the entries in force.
fn trigger_id(bind: &TextKeybind) -> String {
    format!(
        "keybind:{}{}{}{}:{}",
        u8::from(bind.shift),
        u8::from(bind.ctrl),
        u8::from(bind.alt),
        u8::from(bind.meta),
        bind.key
    )
}

fn parse_font_size(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|size| (1.0..=200.0).contains(size))
}

/// The settings and the report of `entries`. `load_theme` gives the text of the theme file a name (or an absolute path) stands for.
///
/// The entries are taken in order, as Ghostty does: a later value replaces an earlier one, and an empty value gives the default again. An entry that is replaced is not listed.
/// `taken` holds the entries in force, by what they set, and `left` those that were not imported.
fn build(
    entries: &[(String, String)],
    load_theme: &dyn Fn(&str) -> Option<String>,
) -> GhosttyImport {
    let mut settings = TerminalSettings::default();
    let mut config_colors = TerminalColors::default();
    let mut taken: BTreeMap<String, usize> = BTreeMap::new();
    let mut left: Vec<(usize, String)> = Vec::new();
    let mut theme_entry = None;
    for (i, (key, value)) in entries.iter().enumerate() {
        let key = key.as_str();
        if value.is_empty() {
            // The default again. A key that has none is not supported anyway.
            match key {
                "font-family" => {
                    settings.font_families.clear();
                    taken.retain(|slot, _| !slot.starts_with("font-family:"));
                }
                "font-size" => settings.font_size = None,
                "font-thicken" => settings.font_thicken = false,
                "theme" => theme_entry = None,
                "palette" => {
                    config_colors.palette.clear();
                    taken.retain(|slot, _| !slot.starts_with("palette:"));
                }
                _ => match color_field(&mut config_colors, key) {
                    Some(field) => *field = None,
                    None => {
                        left.push((i, NOT_SUPPORTED.to_owned()));
                        continue;
                    }
                },
            }
            taken.remove(key);
            continue;
        }
        match key {
            "font-family" => {
                settings.font_families.push(value.clone());
                taken.insert(format!("font-family:{i}"), i);
            }
            "font-size" => match parse_font_size(value) {
                Some(size) => {
                    settings.font_size = Some(size);
                    taken.insert(key.to_owned(), i);
                }
                None => left.push((i, "1 から 200 の数にしてください".to_owned())),
            },
            "font-thicken" => match value.as_str() {
                "true" | "false" => {
                    settings.font_thicken = value == "true";
                    taken.insert(key.to_owned(), i);
                }
                _ => left.push((i, "true か false にしてください".to_owned())),
            },
            "theme" => {
                theme_entry = Some(i);
                taken.insert(key.to_owned(), i);
            }
            "palette" => match parse_palette(value) {
                Some(entry) => {
                    taken.insert(format!("palette:{}", entry.index), i);
                    set_palette(&mut config_colors.palette, entry);
                }
                None => left.push((i, "N=#rrggbb の形にしてください".to_owned())),
            },
            "keybind" => match parse_keybind(value) {
                Keybind::Clear => {
                    settings.keybinds.clear();
                    taken.retain(|slot, _| !slot.starts_with("keybind:"));
                    taken.insert("keybind-clear".to_owned(), i);
                }
                Keybind::Text(bind) => {
                    settings.keybinds.retain(|b| !same_trigger(b, &bind));
                    taken.insert(trigger_id(&bind), i);
                    settings.keybinds.push(bind);
                }
                Keybind::Left(trigger, reason) => {
                    if let Some(bind) = &trigger {
                        settings.keybinds.retain(|b| !same_trigger(b, bind));
                        taken.remove(&trigger_id(bind));
                    }
                    left.push((i, reason));
                }
            },
            _ => match color_field(&mut config_colors, key) {
                Some(field) => match parse_color(value) {
                    Some(color) => {
                        *field = Some(color);
                        taken.insert(key.to_owned(), i);
                    }
                    None => left.push((i, "#rrggbb の形にしてください".to_owned())),
                },
                None => left.push((i, NOT_SUPPORTED.to_owned())),
            },
        }
    }

    let mut themes = (None, None);
    if let Some(i) = theme_entry {
        match theme_names(&entries[i].1) {
            None => {
                taken.remove("theme");
                left.push((i, "テーマの書き方が正しくありません".to_owned()));
            }
            Some((light, dark)) => {
                let load = |name: &String| load_theme(name).map(|text| theme_colors(&text));
                themes = (load(&light), load(&dark));
                let mut missing: Vec<&str> = Vec::new();
                for (name, found) in [(&light, themes.0.is_some()), (&dark, themes.1.is_some())] {
                    if !found && !missing.contains(&name.as_str()) {
                        missing.push(name.as_str());
                    }
                }
                if themes.0.is_none() && themes.1.is_none() {
                    taken.remove("theme");
                }
                if !missing.is_empty() {
                    left.push((i, format!("テーマ {} が見つかりません", missing.join("、"))));
                }
            }
        }
    }
    settings.light = with_config_colors(themes.0, &config_colors);
    settings.dark = with_config_colors(themes.1, &config_colors);

    let line = |i: usize| format!("{} = {}", entries[i].0, entries[i].1);
    let mut imported: Vec<usize> = taken.into_values().collect();
    imported.sort_unstable();
    left.sort_by_key(|(i, _)| *i);
    GhosttyImport {
        settings,
        imported: imported.into_iter().map(line).collect(),
        skipped: left
            .into_iter()
            .map(|(i, reason)| SkippedEntry {
                entry: line(i),
                reason,
            })
            .collect(),
        files: Vec::new(),
    }
}

/// The text of a regular file of at most `limit` bytes.
fn read_limited(path: &Path, limit: u64) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    // A byte that is not UTF-8 (a comment in another encoding) is replaced, so the rest of the file is still read.
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// A path with `~` for the home folder.
fn shown(places: &Places, path: &Path) -> String {
    match path.strip_prefix(&places.home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// Reads the config files of `places` and builds the import.
fn import_from(places: &Places) -> Result<GhosttyImport, String> {
    let (mut entries, mut files) = (Vec::new(), Vec::new());
    let paths = config_paths(places);
    for path in &paths {
        if let Some(text) = read_limited(path, CONFIG_LIMIT) {
            entries.extend(parse_config(&text));
            files.push(shown(places, path));
        }
    }
    if files.is_empty() {
        let looked: Vec<_> = paths.iter().map(|p| shown(places, p)).collect();
        return Err(format!(
            "Ghostty の設定ファイルが見つかりません（1 MB を超えるファイルは読みません）。探した場所: {}",
            looked.join("、")
        ));
    }
    let dirs = theme_dirs(places);
    let load_theme = |name: &str| {
        if let Some(rest) = name.strip_prefix("~/") {
            read_limited(&places.home.join(rest), THEME_LIMIT)
        } else if name.starts_with('/') {
            read_limited(Path::new(name), THEME_LIMIT)
        } else {
            dirs.iter()
                .find_map(|dir| read_limited(&dir.join(name), THEME_LIMIT))
        }
    };
    Ok(GhosttyImport {
        files,
        ..build(&entries, &load_theme)
    })
}

fn load(dir: &Path) -> Option<GhosttyImport> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(SETTINGS_FILE)).ok()?).ok()
}

fn save(dir: &Path, import: &GhosttyImport) -> Result<(), String> {
    let text = serde_json::to_string_pretty(import).map_err(|e| e.to_string())?;
    write_atomic(dir, SETTINGS_FILE, &text)
}

fn places_from_env() -> Result<Places, String> {
    let var = |name| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    Ok(Places {
        home: dirs::home_dir().ok_or("ホームフォルダが分かりません")?,
        xdg_config_home: var("XDG_CONFIG_HOME"),
        resources_dir: var("GHOSTTY_RESOURCES_DIR"),
    })
}

/// The import saved last, `None` before the first one (or when the file cannot be used).
#[tauri::command]
pub async fn ghostty_saved(app: AppHandle) -> Result<Option<GhosttyImport>, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || load(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// Reads Ghostty's config and saves what the terminals take from it (A-13).
#[tauri::command]
pub async fn ghostty_import(app: AppHandle) -> Result<GhosttyImport, String> {
    let dir = config_dir(&app)?;
    let places = places_from_env()?;
    tokio::task::spawn_blocking(move || {
        let import = import_from(&places)?;
        save(&dir, &import)?;
        Ok(import)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(text: &str) -> Vec<(String, String)> {
        parse_config(text)
    }

    fn no_themes(_: &str) -> Option<String> {
        None
    }

    fn run(text: &str) -> GhosttyImport {
        build(&entries(text), &no_themes)
    }

    fn skipped(import: &GhosttyImport) -> Vec<&str> {
        import.skipped.iter().map(|s| s.entry.as_str()).collect()
    }

    const DRACULA: &str = "palette = 0=#21222c\npalette = 1=#ff5555\nbackground = #282a36\nforeground = #f8f8f2\ncursor-color = #f8f8f2\ncursor-text = #282a36\nselection-background = #44475a\nselection-foreground = #ffffff\nbold-color = #ffffff\n";
    const PAPER: &str = "background = #ffffff\nforeground = #111111\npalette = 1=#aa0000\n";

    fn themes(name: &str) -> Option<String> {
        match name {
            "Dracula" => Some(DRACULA.into()),
            "Paper" => Some(PAPER.into()),
            _ => None,
        }
    }

    /// `mods` holds s (shift), c (ctrl), a (alt) and m (meta).
    fn kb(key: &str, mods: &str, text: &str) -> TextKeybind {
        TextKeybind {
            key: key.into(),
            shift: mods.contains('s'),
            ctrl: mods.contains('c'),
            alt: mods.contains('a'),
            meta: mods.contains('m'),
            text: text.into(),
        }
    }

    // ---- the file format ----

    #[test]
    fn parses_key_value_lines() {
        let got = entries(
            "# a comment\n\nfont-size = 14\nbackground=282c34\n  theme =  \"Paper\"  \nkeybind = a=text:x\nkeybind = b=text:y\nno equals here\n= no key\n",
        );
        assert_eq!(
            got,
            [
                ("font-size", "14"),
                ("background", "282c34"),
                ("theme", "Paper"),
                ("keybind", "a=text:x"),
                ("keybind", "b=text:y"),
            ]
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
        );
    }

    #[test]
    fn a_hash_after_the_value_is_part_of_the_value() {
        // Ghostty has comments on lines of their own only.
        assert_eq!(
            entries("background = #282c34 # dark\n"),
            [("background".to_owned(), "#282c34 # dark".to_owned())]
        );
    }

    #[test]
    fn the_config_files_are_read_in_orcas_order() {
        let places = Places {
            home: "/h".into(),
            xdg_config_home: None,
            resources_dir: None,
        };
        let paths: Vec<_> = config_paths(&places)
            .iter()
            .map(|p| p.to_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            paths,
            [
                "/h/.config/ghostty/config.ghostty",
                "/h/.config/ghostty/config",
                "/h/Library/Application Support/com.mitchellh.ghostty/config.ghostty",
                "/h/Library/Application Support/com.mitchellh.ghostty/config",
            ]
        );
        let places = Places {
            xdg_config_home: Some("/x".into()),
            ..places
        };
        assert_eq!(
            config_paths(&places)[0],
            PathBuf::from("/x/ghostty/config.ghostty")
        );
    }

    #[test]
    fn the_theme_folders_are_looked_in_orcas_order() {
        let places = Places {
            home: "/h".into(),
            xdg_config_home: None,
            resources_dir: None,
        };
        assert_eq!(
            theme_dirs(&places),
            [
                "/h/.config/ghostty/themes",
                "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
                "/h/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
            ]
            .map(PathBuf::from)
        );
        let places = Places {
            xdg_config_home: Some("/x".into()),
            resources_dir: Some("/r".into()),
            ..places
        };
        assert_eq!(
            theme_dirs(&places),
            ["/x/ghostty/themes", "/r/themes"].map(PathBuf::from)
        );
    }

    // ---- fonts ----

    #[test]
    fn imports_the_font() {
        let got = run(
            "font-family = JetBrains Mono\nfont-family = Noto Sans Mono CJK JP\nfont-size = 13.5\nfont-thicken = true\n",
        );
        assert_eq!(
            got.settings.font_families,
            ["JetBrains Mono", "Noto Sans Mono CJK JP"]
        );
        assert_eq!(got.settings.font_size, Some(13.5));
        assert!(got.settings.font_thicken);
        assert_eq!(got.imported.len(), 4);
        assert!(got.skipped.is_empty());
    }

    #[test]
    fn an_empty_font_family_forgets_the_ones_before() {
        let got = run("font-family = A\nfont-family =\nfont-family = B\n");
        assert_eq!(got.settings.font_families, ["B"]);
        assert_eq!(got.imported, ["font-family = B"]);
    }

    #[test]
    fn the_last_value_of_a_single_setting_wins() {
        let got =
            run("font-size = 12\nfont-size = 15\nfont-thicken = true\nfont-thicken = false\n");
        assert_eq!(got.settings.font_size, Some(15.0));
        assert!(!got.settings.font_thicken);
        assert_eq!(got.imported, ["font-size = 15", "font-thicken = false"]);
    }

    #[test]
    fn a_bad_font_size_or_thicken_is_not_imported_and_keeps_the_earlier_value() {
        let got = run(
            "font-size = 12\nfont-size = big\nfont-size = 0\nfont-size = 500\nfont-thicken = maybe\n",
        );
        assert_eq!(got.settings.font_size, Some(12.0));
        assert!(!got.settings.font_thicken);
        assert_eq!(
            skipped(&got),
            [
                "font-size = big",
                "font-size = 0",
                "font-size = 500",
                "font-thicken = maybe"
            ]
        );
    }

    // ---- colors and themes ----

    #[test]
    fn imports_the_colors_of_the_config() {
        let got = run("background = 282c34\nforeground = #ABB2BF\ncursor-color = #fc0\ncursor-text = 000000\nselection-background = #3e4451\nselection-foreground = #ffffff\npalette = 1=#e06c75\npalette = 255=#eeeeee\npalette = 1=#ff0000\n");
        let colors = TerminalColors {
            background: Some("#282c34".into()),
            foreground: Some("#abb2bf".into()),
            cursor: Some("#ffcc00".into()),
            cursor_accent: Some("#000000".into()),
            selection_background: Some("#3e4451".into()),
            selection_foreground: Some("#ffffff".into()),
            palette: vec![
                PaletteColor {
                    index: 1,
                    color: "#ff0000".into(),
                },
                PaletteColor {
                    index: 255,
                    color: "#eeeeee".into(),
                },
            ],
        };
        assert_eq!(got.settings.light, Some(colors.clone()));
        assert_eq!(got.settings.dark, Some(colors));
        // The palette entry that the later one replaced is not listed.
        assert_eq!(got.imported.len(), 8);
        assert!(!got.imported.contains(&"palette = 1=#e06c75".to_owned()));
        assert!(got.skipped.is_empty());
    }

    #[test]
    fn a_color_that_is_not_hex_is_not_imported() {
        let got = run("background = red\nforeground = #12345\ncursor-color = cell-foreground\npalette = 300=#ffffff\npalette = 1=blue\npalette = x\n");
        assert_eq!(got.settings.light, None);
        assert_eq!(got.skipped.len(), 6);
        assert!(got.imported.is_empty());
    }

    #[test]
    fn a_single_theme_gives_its_colors_to_both() {
        let got = build(&entries("theme = Dracula\n"), &themes);
        let dracula = got.settings.dark.clone().unwrap();
        assert_eq!(got.settings.light, got.settings.dark);
        assert_eq!(dracula.background.as_deref(), Some("#282a36"));
        assert_eq!(dracula.cursor_accent.as_deref(), Some("#282a36"));
        assert_eq!(dracula.palette.len(), 2);
        assert_eq!(got.imported, ["theme = Dracula"]);
        // `bold-color` of the theme file is not read, and not reported either.
        assert!(got.skipped.is_empty());
    }

    #[test]
    fn a_light_dark_theme_gives_each_its_own() {
        let got = build(&entries("theme = light:Paper,dark: Dracula\n"), &themes);
        assert_eq!(
            got.settings.light.unwrap().background.as_deref(),
            Some("#ffffff")
        );
        assert_eq!(
            got.settings.dark.unwrap().background.as_deref(),
            Some("#282a36")
        );
        assert_eq!(got.imported, ["theme = light:Paper,dark: Dracula"]);
    }

    #[test]
    fn the_colors_of_the_config_win_over_the_theme() {
        let got = build(
            &entries(
                "background = #000000\ntheme = Dracula\npalette = 1=#111111\npalette = 5=#555555\n",
            ),
            &themes,
        );
        let dark = got.settings.dark.unwrap();
        assert_eq!(dark.background.as_deref(), Some("#000000"));
        assert_eq!(dark.foreground.as_deref(), Some("#f8f8f2"));
        let palette: Vec<_> = dark
            .palette
            .iter()
            .map(|p| (p.index, p.color.as_str()))
            .collect();
        assert_eq!(palette, [(0, "#21222c"), (1, "#111111"), (5, "#555555")]);
    }

    #[test]
    fn a_theme_that_is_not_found_is_listed_and_the_other_one_is_kept() {
        let got = build(&entries("theme = Nope\n"), &themes);
        assert_eq!(got.settings.dark, None);
        assert_eq!(skipped(&got), ["theme = Nope"]);
        assert!(got.skipped[0].reason.contains("Nope"));
        assert!(got.imported.is_empty());

        let got = build(&entries("theme = light:Nope,dark:Dracula\n"), &themes);
        assert_eq!(got.settings.light, None);
        assert!(got.settings.dark.is_some());
        assert_eq!(got.imported, ["theme = light:Nope,dark:Dracula"]);
        assert_eq!(skipped(&got), ["theme = light:Nope,dark:Dracula"]);
    }

    #[test]
    fn a_theme_that_is_not_written_right_is_not_looked_for() {
        for value in [
            "a/b",
            "..",
            "light:Paper",
            "dark:Paper",
            "light:A,dark:B,dark:C",
            "x:Paper",
        ] {
            let asked = std::cell::Cell::new(false);
            let got = build(&entries(&format!("theme = {value}\n")), &|_: &str| {
                asked.set(true);
                Some(DRACULA.into())
            });
            assert!(!asked.get(), "{value}");
            assert_eq!(got.settings.dark, None, "{value}");
            assert_eq!(got.skipped.len(), 1, "{value}");
        }
    }

    #[test]
    fn an_absolute_path_is_a_theme() {
        let got = build(&entries("theme = /themes/mine\n"), &|name: &str| {
            (name == "/themes/mine").then(|| PAPER.to_owned())
        });
        assert!(got.settings.dark.is_some());
    }

    #[test]
    fn an_empty_theme_forgets_the_one_before() {
        let got = build(&entries("theme = Dracula\ntheme =\n"), &themes);
        assert_eq!(got.settings.dark, None);
        assert!(got.imported.is_empty() && got.skipped.is_empty());
    }

    // ---- keys ----

    #[test]
    fn imports_a_key_that_sends_text() {
        let got = run("keybind = delete=text:\\x08\nkeybind = shift+enter=text:\\n\nkeybind = ctrl+alt+shift+super+a=text:\\u{1b}[x\nkeybind = cmd+Left=text:\\x01\n");
        assert_eq!(
            got.settings.keybinds,
            [
                kb("Delete", "", "\x08"),
                kb("Enter", "s", "\n"),
                kb("a", "casm", "\x1b[x"),
                kb("ArrowLeft", "m", "\x01"),
            ]
        );
        assert_eq!(got.imported.len(), 4);
        assert!(got.skipped.is_empty());
    }

    #[test]
    fn the_escapes_of_a_text_are_zigs() {
        let text = |t: &str| {
            run(&format!("keybind = a=text:{t}\n"))
                .settings
                .keybinds
                .first()
                .map(|k| k.text.clone())
        };
        assert_eq!(text("\\n\\r\\t\\\\\\'\\\"").as_deref(), Some("\n\r\t\\'\""));
        assert_eq!(text("plain ü").as_deref(), Some("plain ü"));
        assert_eq!(text("\\x1b\\r").as_deref(), Some("\x1b\r"));
        assert_eq!(text("\\u{3042}").as_deref(), Some("あ"));
        // Not a text: unknown escape, a byte that is no character alone, NUL, nothing, a broken escape, too long.
        let long = "a".repeat(TEXT_LIMIT + 1);
        for bad in [
            "\\q",
            "\\xff",
            "\\x00",
            "\\u{0}",
            "",
            "\\x1",
            "\\u{110000}",
            "\\",
            &long,
        ] {
            assert_eq!(text(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_later_key_with_the_same_trigger_replaces_the_earlier() {
        let got = run(
            "keybind = shift+enter=text:a\nkeybind = SHIFT+Enter=text:b\nkeybind = return+shift=text:c\n",
        );
        assert_eq!(got.settings.keybinds, [kb("Enter", "s", "c")]);
        assert_eq!(got.imported, ["keybind = return+shift=text:c"]);
    }

    #[test]
    fn a_key_for_another_action_takes_the_trigger_from_the_text() {
        let got = run("keybind = shift+enter=text:a\nkeybind = shift+enter=new_window\nkeybind = ctrl+a=text:b\nkeybind = ctrl+a=csi:A\n");
        assert!(got.settings.keybinds.is_empty());
        assert_eq!(
            skipped(&got),
            ["keybind = shift+enter=new_window", "keybind = ctrl+a=csi:A"]
        );
        assert!(got.imported.is_empty());
    }

    #[test]
    fn keybind_clear_forgets_the_keys_before() {
        let got = run("keybind = a=text:x\nkeybind = clear\nkeybind = b=text:y\n");
        assert_eq!(got.settings.keybinds, [kb("b", "", "y")]);
        assert_eq!(got.imported, ["keybind = clear", "keybind = b=text:y"]);
    }

    #[test]
    fn keys_that_cannot_be_matched_are_listed() {
        let got = run("keybind = ctrl+a>n=text:x\nkeybind = global:ctrl+a=text:x\nkeybind = unconsumed:a=text:x\nkeybind = ctrl+ctrl+a=text:x\nkeybind = ctrl+a+b=text:x\nkeybind = shift=text:x\nkeybind = key_a=text:x\nkeybind = nothing\nkeybind = a=\nkeybind = ctrl+=text:x\n");
        assert!(got.settings.keybinds.is_empty());
        assert_eq!(got.skipped.len(), 10);
        assert!(got.imported.is_empty());
    }

    #[test]
    fn named_keys_are_the_keys_of_the_keyboard_event() {
        let key = |name: &str| {
            run(&format!("keybind = {name}=text:x\n"))
                .settings
                .keybinds
                .first()
                .map(|k| k.key.clone())
        };
        for (name, want) in [
            ("enter", "Enter"),
            ("return", "Enter"),
            ("tab", "Tab"),
            ("space", " "),
            ("backspace", "Backspace"),
            ("delete", "Delete"),
            ("escape", "Escape"),
            ("esc", "Escape"),
            ("up", "ArrowUp"),
            ("arrow_down", "ArrowDown"),
            ("left", "ArrowLeft"),
            ("arrow_right", "ArrowRight"),
            ("home", "Home"),
            ("end", "End"),
            ("page_up", "PageUp"),
            ("page_down", "PageDown"),
            ("insert", "Insert"),
            ("f1", "F1"),
            ("f12", "F12"),
            ("plus", "+"),
            ("equal", "="),
            ("minus", "-"),
            ("comma", ","),
            ("period", "."),
            ("slash", "/"),
            ("bracket_left", "["),
            ("A", "a"),
            ("あ", "あ"),
        ] {
            assert_eq!(key(name).as_deref(), Some(want), "{name}");
        }
        for bad in ["f13", "KeyA", "catch_all", "bogus"] {
            assert_eq!(key(bad), None, "{bad}");
        }
    }

    // ---- the report ----

    #[test]
    fn every_other_entry_is_listed_as_not_imported_in_the_order_of_the_config() {
        let got = run(
            "window-width = 100\nfont-size = 12\nconfig-file = more\ncursor-style = bar\nfont-size = 14\n",
        );
        assert_eq!(
            skipped(&got),
            [
                "window-width = 100",
                "config-file = more",
                "cursor-style = bar"
            ]
        );
        assert!(got.skipped.iter().all(|s| s.reason == NOT_SUPPORTED));
        assert_eq!(got.imported, ["font-size = 14"]);
    }

    #[test]
    fn an_empty_config_imports_nothing() {
        assert_eq!(run(""), GhosttyImport::default());
    }

    // ---- the files ----

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-ghostty-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn places(home: &Path) -> Places {
        Places {
            home: home.to_owned(),
            xdg_config_home: None,
            resources_dir: Some(home.join("resources")),
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn the_later_file_replaces_the_earlier_and_the_theme_comes_from_a_folder() {
        let home = temp_dir("files");
        write(
            &home.join(".config/ghostty/config"),
            "font-size = 12\nfont-family = A\ntheme = Mine\n",
        );
        write(
            &home.join("Library/Application Support/com.mitchellh.ghostty/config.ghostty"),
            "font-size = 15\nfont-family = B\n",
        );
        write(&home.join(".config/ghostty/themes/Mine"), PAPER);
        // The same name in the app's folder is not used: the config folder comes first.
        write(&home.join("resources/themes/Mine"), DRACULA);
        let got = import_from(&places(&home)).unwrap();
        assert_eq!(got.settings.font_size, Some(15.0));
        assert_eq!(got.settings.font_families, ["A", "B"]);
        assert_eq!(
            got.settings.dark.unwrap().background.as_deref(),
            Some("#ffffff")
        );
        assert_eq!(
            got.files,
            [
                "~/.config/ghostty/config",
                "~/Library/Application Support/com.mitchellh.ghostty/config.ghostty"
            ]
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_theme_of_the_resources_folder_and_one_by_its_path_are_found() {
        let home = temp_dir("themes");
        let by_path = home.join("mine.theme");
        write(&by_path, PAPER);
        write(&home.join("resources/themes/Dracula"), DRACULA);
        write(
            &home.join(".config/ghostty/config.ghostty"),
            &format!("theme = light:{},dark:Dracula\n", by_path.display()),
        );
        let got = import_from(&places(&home)).unwrap();
        assert_eq!(
            got.settings.light.unwrap().background.as_deref(),
            Some("#ffffff")
        );
        assert_eq!(
            got.settings.dark.unwrap().background.as_deref(),
            Some("#282a36")
        );
        assert!(got.skipped.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_theme_over_the_limit_is_not_found() {
        let home = temp_dir("big");
        write(&home.join(".config/ghostty/config"), "theme = Big\n");
        write(
            &home.join(".config/ghostty/themes/Big"),
            &format!("background = #000000\n{}", "# x\n".repeat(70_000)),
        );
        let got = import_from(&places(&home)).unwrap();
        assert_eq!(got.settings.dark, None);
        assert_eq!(skipped(&got), ["theme = Big"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn no_config_file_is_an_error_naming_where_it_was_looked_for() {
        let home = temp_dir("none");
        let err = import_from(&places(&home)).unwrap_err();
        assert!(err.contains("見つかりません"));
        assert!(err.contains("~/.config/ghostty/config.ghostty"));
        // A folder named like the file is no file.
        std::fs::create_dir_all(home.join(".config/ghostty/config")).unwrap();
        assert!(import_from(&places(&home)).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_config_over_the_limit_is_not_read() {
        let home = temp_dir("huge");
        write(
            &home.join(".config/ghostty/config"),
            &format!("font-size = 12\n{}", "# x\n".repeat(300_000)),
        );
        assert!(import_from(&places(&home)).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_file_with_a_byte_that_is_not_utf8_is_still_read() {
        let home = temp_dir("latin1");
        let path = home.join(".config/ghostty/config");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"# caf\xe9\nfont-size = 12\n").unwrap();
        let got = import_from(&places(&home)).unwrap();
        assert_eq!(got.settings.font_size, Some(12.0));
        assert_eq!(got.files, ["~/.config/ghostty/config"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_empty_config_file_is_an_import_of_nothing() {
        let home = temp_dir("empty");
        write(&home.join(".config/ghostty/config.ghostty"), "");
        let got = import_from(&places(&home)).unwrap();
        assert!(got.imported.is_empty() && got.skipped.is_empty());
        assert_eq!(got.files, ["~/.config/ghostty/config.ghostty"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    // ---- the saved file ----

    #[test]
    fn the_import_is_saved_and_read_back() {
        let dir = temp_dir("save");
        assert_eq!(load(&dir), None);
        let import = build(
            &entries("font-size = 14\nkeybind = a=text:x\nwindow-width = 9\ntheme = Dracula\n"),
            &themes,
        );
        save(&dir, &import).unwrap();
        assert_eq!(load(&dir), Some(import));
        assert!(!dir.join("ghostty-settings.json.tmp").exists());
        // A file that cannot be used is as good as none.
        std::fs::write(dir.join(SETTINGS_FILE), "{").unwrap();
        assert_eq!(load(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_saved_file_is_in_camel_case() {
        let json = serde_json::to_value(run("font-size = 14\nbackground = #000000\n")).unwrap();
        assert_eq!(json["settings"]["fontSize"], 14.0);
        assert_eq!(
            json["settings"]["light"]["selectionBackground"],
            serde_json::Value::Null
        );
    }
}
