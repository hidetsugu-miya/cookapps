//! The skills of cookapps: instructions the owner writes once and has Claude follow on the screens that talk to it.
//!
//! A skill is a `SKILL.md` in the shape Claude Code reads, at `skills/{name}/SKILL.md` in the app config directory.
//! The config directory is also a Claude Code plugin named `cookapps` (`.claude-plugin/plugin.json`, written with the first save),
//! so a later call can pass it with `--plugin-dir` and run a skill by `/cookapps:{name}`.
//! The front matter holds `name`, `description` (the keys Claude Code reads) and `cookapps-display-name` and `cookapps-screens` (cookapps's own);
//! the body is the instructions.
//! The name is the folder's, and it is checked before any path is made of it (`validate_name`), so a name never points outside `skills/`.
//! This file reads and writes only: nothing here calls Claude.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_atomic, auth::config_dir};

/// The folder of the skills, in the config directory.
const DIR: &str = "skills";
const FILE: &str = "SKILL.md";
/// The plugin's name: the `cookapps` of `/cookapps:{name}`.
const PLUGIN_NAME: &str = "cookapps";
const MANIFEST_DIR: &str = ".claude-plugin";
const MANIFEST_FILE: &str = "plugin.json";
const NAME_MAX: usize = 64;
const DISPLAY_NAME_MAX: usize = 100;
const DESCRIPTION_MAX: usize = 1024;
const INSTRUCTIONS_MAX: usize = 100_000;
/// A save writes a file by a temporary name beside it: two at once would meet there.
static SAVING: Mutex<()> = Mutex::new(());

/// A screen that can use skills: the ones that talk to Claude.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "kebab-case")]
pub enum SkillScreen {
    /// The screen that pastes a mail into Slack (S-1, S-4).
    SlackPaste,
    /// The talk about a Slack thread (S-7).
    SlackThread,
}

impl SkillScreen {
    const ALL: [SkillScreen; 2] = [SkillScreen::SlackPaste, SkillScreen::SlackThread];

    fn key(self) -> &'static str {
        match self {
            SkillScreen::SlackPaste => "slack-paste",
            SkillScreen::SlackThread => "slack-thread",
        }
    }
}

/// One skill. `name` is the folder name and what follows `/cookapps:`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub display_name: String,
    pub screens: Vec<SkillScreen>,
    pub description: String,
    /// The body of `SKILL.md`.
    pub instructions: String,
}

/// Whether `name` can follow `/cookapps:` and be a folder: 1 to 64 of a to z, 0 to 9 and `-`, not starting or ending with `-`, with no `--`.
/// Nothing else gets through, so no `/`, `\`, `.` or `..` can leave `skills/`.
pub fn validate_name(name: &str) -> Result<(), String> {
    let allowed = !name.is_empty()
        && name.len() <= NAME_MAX
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--");
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "スキルの名前は、半角の小文字、数字、ハイフンだけで、{NAME_MAX} 文字までにしてください。ハイフンは先頭と末尾に置けず、続けて 2 つ置くこともできません"
        ))
    }
}

/// A skill brought into the form that is saved: the texts trimmed, the screens in a fixed order with no repeat.
/// Refuses what cannot be saved, in Japanese.
fn check(skill: &Skill) -> Result<Skill, String> {
    validate_name(&skill.name)?;
    let display_name = skill.display_name.trim();
    if display_name.is_empty() {
        return Err("表示名を入れてください".to_string());
    }
    if display_name.chars().count() > DISPLAY_NAME_MAX || display_name.chars().any(char::is_control)
    {
        return Err(format!(
            "表示名は、改行などを含まない {DISPLAY_NAME_MAX} 文字までにしてください"
        ));
    }
    let description = skill.description.trim();
    if description.chars().count() > DESCRIPTION_MAX
        || description
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(format!(
            "説明は、制御文字を含まない {DESCRIPTION_MAX} 文字までにしてください"
        ));
    }
    let instructions = skill.instructions.trim();
    if instructions.is_empty() {
        return Err("指示を入れてください".to_string());
    }
    if instructions.chars().count() > INSTRUCTIONS_MAX {
        return Err(format!("指示は {INSTRUCTIONS_MAX} 文字までにしてください"));
    }
    Ok(Skill {
        name: skill.name.clone(),
        display_name: display_name.to_string(),
        screens: SkillScreen::ALL
            .into_iter()
            .filter(|screen| skill.screens.contains(screen))
            .collect(),
        description: description.to_string(),
        instructions: instructions.to_string(),
    })
}

/// A text as a double-quoted YAML scalar: JSON's escapes are YAML's, so Claude Code reads the same text back.
fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
}

/// The `SKILL.md` text of a skill that `check` accepted.
fn render(skill: &Skill) -> String {
    let screens: Vec<&str> = skill.screens.iter().map(|s| s.key()).collect();
    format!(
        "---\nname: {}\ndescription: {}\ncookapps-display-name: {}\ncookapps-screens: {}\n---\n\n{}\n",
        quoted(&skill.name),
        quoted(&skill.description),
        quoted(&skill.display_name),
        screens.join(", "),
        skill.instructions
    )
}

/// A front matter value: a double-quoted one is read as JSON, anything else as it stands, trimmed.
fn scalar(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') {
        if let Ok(text) = serde_json::from_str::<String>(value) {
            return text;
        }
    }
    value.to_string()
}

/// A skill from the text of its `SKILL.md`, which a hand may have written, as Claude Code's own are: `name` is the folder's,
/// a missing display name is the name, and a missing front matter makes the whole text the instructions.
fn parse(name: &str, text: &str) -> Skill {
    let text = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n");
    let (front, body) = split_front_matter(&text);
    let mut display_name = None;
    let mut description = String::new();
    let mut screens = Vec::new();
    for line in front.lines() {
        // An indented line is a continuation of a value the reader does not take.
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "description" => description = scalar(value),
            "cookapps-display-name" => display_name = Some(scalar(value)),
            "cookapps-screens" => {
                screens = SkillScreen::ALL
                    .into_iter()
                    .filter(|screen| value.split(',').any(|word| word.trim() == screen.key()))
                    .collect();
            }
            _ => {}
        }
    }
    Skill {
        name: name.to_string(),
        display_name: display_name
            .filter(|shown| !shown.trim().is_empty())
            .unwrap_or_else(|| name.to_string()),
        screens,
        description,
        instructions: body.trim().to_string(),
    }
}

/// The front matter (between the first line `---` and the next) and the rest; no front matter gives an empty one and the whole text.
fn split_front_matter(text: &str) -> (&str, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return ("", text);
    };
    let mut start = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return (&rest[..start], &rest[start + line.len()..]);
        }
        start += line.len();
    }
    ("", text)
}

fn skills_dir(dir: &Path) -> PathBuf {
    dir.join(DIR)
}

/// The skills saved, by name. A folder whose name is not a valid one, or with no readable `SKILL.md`, is left out.
fn list_skills(dir: &Path) -> Result<Vec<Skill>, String> {
    let entries = match std::fs::read_dir(skills_dir(dir)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("スキルの一覧を読めません: {e}")),
    };
    let mut skills: Vec<Skill> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            validate_name(&name).ok()?;
            let text = std::fs::read_to_string(entry.path().join(FILE)).ok()?;
            Some(parse(&name, &text))
        })
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn read_skill(dir: &Path, name: &str) -> Result<Skill, String> {
    validate_name(name)?;
    match std::fs::read_to_string(skills_dir(dir).join(name).join(FILE)) {
        Ok(text) => Ok(parse(name, &text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("スキル「{name}」がありません"))
        }
        Err(e) => Err(format!("スキル「{name}」を読めません: {e}")),
    }
}

/// The text of `plugin.json`.
fn manifest() -> String {
    format!("{{\"name\": {}}}\n", quoted(PLUGIN_NAME))
}

/// Makes the config directory a plugin named `cookapps`, unless `plugin.json` already says so.
fn ensure_manifest(dir: &Path) -> Result<(), String> {
    let wanted = manifest();
    let path = dir.join(MANIFEST_DIR).join(MANIFEST_FILE);
    if std::fs::read_to_string(&path).is_ok_and(|now| now == wanted) {
        return Ok(());
    }
    write_atomic(&dir.join(MANIFEST_DIR), MANIFEST_FILE, &wanted)
}

/// Saves a skill (a new one, or the one of that name replaced) and answers it as it was saved.
fn save_skill(dir: &Path, skill: &Skill) -> Result<Skill, String> {
    let skill = check(skill)?;
    ensure_manifest(dir)?;
    write_atomic(&skills_dir(dir).join(&skill.name), FILE, &render(&skill))?;
    Ok(skill)
}

/// Deletes the folder of a skill.
fn delete_skill(dir: &Path, name: &str) -> Result<(), String> {
    validate_name(name)?;
    let folder = skills_dir(dir).join(name);
    if !folder.join(FILE).is_file() {
        return Err(format!("スキル「{name}」がありません"));
    }
    std::fs::remove_dir_all(&folder).map_err(|e| format!("スキル「{name}」を消せません: {e}"))
}

/// The skills saved, by name.
#[tauri::command]
pub async fn skill_list(app: AppHandle) -> Result<Vec<Skill>, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || list_skills(&dir))
        .await
        .map_err(|e| e.to_string())?
}

/// One skill by its name; an error when there is none.
#[tauri::command]
pub async fn skill_get(app: AppHandle, name: String) -> Result<Skill, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || read_skill(&dir, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Saves a skill, a new one or the one of that name replaced, and answers it as saved.
#[tauri::command]
pub async fn skill_save(app: AppHandle, skill: Skill) -> Result<Skill, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
        save_skill(&dir, &skill)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a skill; an error when there is none.
#[tauri::command]
pub async fn skill_delete(app: AppHandle, name: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
        delete_skill(&dir, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-skills-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn skill(name: &str) -> Skill {
        Skill {
            name: name.to_string(),
            display_name: "校正".to_string(),
            screens: vec![SkillScreen::SlackThread, SkillScreen::SlackPaste],
            description: "文面を直す".to_string(),
            instructions: "# 手順\n\n1. 誤字を直す\n".to_string(),
        }
    }

    #[test]
    fn a_name_of_lowercase_digits_and_hyphens_is_valid() {
        for name in ["proofread", "a", "a1-b2", "0", &"a".repeat(64)] {
            assert!(validate_name(name).is_ok(), "{name}");
        }
    }

    #[test]
    fn a_name_that_could_leave_the_folder_or_is_not_callable_is_refused_in_japanese() {
        let too_long = "a".repeat(65);
        for name in [
            "", "../evil", "..", ".", "a/b", "a\\b", "/abs", "a.b", "A", "a b", "a\0b", "a\nb",
            "-a", "a-", "a--b", "校正", &too_long,
        ] {
            let err = validate_name(name).unwrap_err();
            assert!(err.contains("スキルの名前"), "{name:?}: {err}");
        }
    }

    #[test]
    fn check_trims_orders_the_screens_and_drops_repeats() {
        let mut given = skill("proofread");
        given.display_name = "  校正 ".to_string();
        given.screens = vec![
            SkillScreen::SlackThread,
            SkillScreen::SlackPaste,
            SkillScreen::SlackThread,
        ];
        given.instructions = "\n\n本文\n\n".to_string();
        let checked = check(&given).unwrap();
        assert_eq!(checked.display_name, "校正");
        assert_eq!(
            checked.screens,
            vec![SkillScreen::SlackPaste, SkillScreen::SlackThread]
        );
        assert_eq!(checked.instructions, "本文");
    }

    #[test]
    fn check_refuses_what_cannot_be_saved() {
        let mut given = skill("proofread");
        given.display_name = " ".to_string();
        assert_eq!(check(&given).unwrap_err(), "表示名を入れてください");
        let mut given = skill("proofread");
        given.display_name = "a\nb".to_string();
        assert!(check(&given).unwrap_err().contains("表示名"));
        let mut given = skill("proofread");
        given.description = "a\u{0}b".to_string();
        assert!(check(&given).unwrap_err().contains("説明"));
        let mut given = skill("proofread");
        given.description = "あ".repeat(DESCRIPTION_MAX + 1);
        assert!(check(&given).unwrap_err().contains("説明"));
        let mut given = skill("proofread");
        given.instructions = " \n".to_string();
        assert_eq!(check(&given).unwrap_err(), "指示を入れてください");
        let mut given = skill("proofread");
        given.instructions = "あ".repeat(INSTRUCTIONS_MAX + 1);
        assert!(check(&given).unwrap_err().contains("指示"));
        let mut given = skill("../x");
        given.display_name = "x".to_string();
        assert!(check(&given).unwrap_err().contains("スキルの名前"));
    }

    #[test]
    fn render_then_parse_gives_the_skill_back() {
        let mut given = skill("proofread");
        given.description = "行 1: \"引用\" と \\ と\n行 2 # ほか".to_string();
        given.instructions = "---\n本文の中の線\n---\n続き".to_string();
        let given = check(&given).unwrap();
        assert_eq!(parse("proofread", &render(&given)), given);
    }

    #[test]
    fn render_writes_the_front_matter_claude_code_reads() {
        let text = render(&check(&skill("proofread")).unwrap());
        assert_eq!(
            text,
            "---\nname: \"proofread\"\ndescription: \"文面を直す\"\ncookapps-display-name: \"校正\"\ncookapps-screens: slack-paste, slack-thread\n---\n\n# 手順\n\n1. 誤字を直す\n"
        );
    }

    #[test]
    fn parse_reads_a_skill_written_by_hand_in_claude_codes_form() {
        let text = "---\r\nname: other\r\ndescription: Fixes the text\r\nallowed-tools: Read\r\n---\r\n\r\nDo it.\r\n";
        let parsed = parse("proofread", text);
        assert_eq!(parsed.name, "proofread");
        assert_eq!(parsed.display_name, "proofread");
        assert_eq!(parsed.description, "Fixes the text");
        assert!(parsed.screens.is_empty());
        assert_eq!(parsed.instructions, "Do it.");
    }

    #[test]
    fn parse_takes_a_text_without_front_matter_as_the_instructions() {
        for text in ["Just this.\n", "---\nnever closed\n"] {
            let parsed = parse("a", text);
            assert_eq!(parsed.instructions, text.trim());
            assert_eq!(parsed.display_name, "a");
            assert_eq!(parsed.description, "");
        }
    }

    #[test]
    fn parse_skips_an_unknown_screen_and_a_continued_value() {
        let text = "---\ndescription: >\n  cookapps-screens: slack-paste\ncookapps-screens: slack-thread, nowhere, slack-thread\ncookapps-display-name: \"  \"\n---\nbody";
        let parsed = parse("a", text);
        assert_eq!(parsed.screens, vec![SkillScreen::SlackThread]);
        assert_eq!(parsed.display_name, "a");
    }

    #[test]
    fn a_saved_skill_is_listed_and_read_and_a_deleted_one_is_gone() {
        let dir = temp_dir("flow");
        assert_eq!(list_skills(&dir).unwrap(), Vec::<Skill>::new());
        let first = save_skill(&dir, &skill("proofread")).unwrap();
        save_skill(&dir, &skill("another")).unwrap();
        let names: Vec<_> = list_skills(&dir)
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["another", "proofread"]);
        assert_eq!(read_skill(&dir, "proofread").unwrap(), first);

        delete_skill(&dir, "proofread").unwrap();
        assert!(!dir.join("skills/proofread").exists());
        let names: Vec<_> = list_skills(&dir)
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["another"]);
        assert_eq!(
            read_skill(&dir, "proofread").unwrap_err(),
            "スキル「proofread」がありません"
        );
        assert_eq!(
            delete_skill(&dir, "proofread").unwrap_err(),
            "スキル「proofread」がありません"
        );
    }

    #[test]
    fn a_save_replaces_the_skill_of_that_name_and_leaves_no_temporary_file() {
        let dir = temp_dir("replace");
        save_skill(&dir, &skill("proofread")).unwrap();
        let mut again = skill("proofread");
        again.instructions = "別の指示".to_string();
        save_skill(&dir, &again).unwrap();
        assert_eq!(
            read_skill(&dir, "proofread").unwrap().instructions,
            "別の指示"
        );
        let files: Vec<_> = std::fs::read_dir(dir.join("skills/proofread"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(files, vec!["SKILL.md"]);
    }

    #[test]
    fn the_first_save_makes_the_config_folder_a_plugin_named_cookapps() {
        let dir = temp_dir("manifest");
        save_skill(&dir, &skill("proofread")).unwrap();
        let path = dir.join(".claude-plugin/plugin.json");
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["name"], "cookapps");
        // A hand-changed manifest is put right at the next save.
        std::fs::write(&path, "{\"name\": \"other\"}").unwrap();
        save_skill(&dir, &skill("proofread")).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["name"], "cookapps");
    }

    #[test]
    fn a_name_with_a_separator_is_refused_by_every_command_and_touches_nothing() {
        let dir = temp_dir("escape");
        let inside = dir.join("config");
        std::fs::create_dir_all(&inside).unwrap();
        for name in ["../evil", "a/b", "..", "a\\b", "/abs"] {
            assert!(save_skill(&inside, &skill(name)).is_err(), "{name}");
            assert!(read_skill(&inside, name).is_err(), "{name}");
            assert!(delete_skill(&inside, name).is_err(), "{name}");
        }
        // Nothing was made, in the config folder or beside it.
        let made: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(made, vec!["config"]);
        assert_eq!(std::fs::read_dir(&inside).unwrap().count(), 0);
    }

    #[test]
    fn a_delete_never_takes_a_folder_that_is_not_a_skill() {
        let dir = temp_dir("not-a-skill");
        std::fs::create_dir_all(dir.join("skills/notes")).unwrap();
        std::fs::write(dir.join("skills/notes/keep.txt"), "x").unwrap();
        assert!(delete_skill(&dir, "notes").is_err());
        assert!(dir.join("skills/notes/keep.txt").exists());
    }

    #[test]
    fn the_list_leaves_out_folders_that_are_not_skills() {
        let dir = temp_dir("list-skips");
        save_skill(&dir, &skill("proofread")).unwrap();
        std::fs::create_dir_all(dir.join("skills/empty")).unwrap();
        std::fs::create_dir_all(dir.join("skills/Bad Name")).unwrap();
        std::fs::write(dir.join("skills/Bad Name/SKILL.md"), "x").unwrap();
        std::fs::write(dir.join("skills/stray.md"), "x").unwrap();
        let names: Vec<_> = list_skills(&dir)
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["proofread"]);
    }
}
