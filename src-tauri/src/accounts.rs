use std::path::Path;

use serde::{Deserialize, Serialize};

const FILE: &str = "accounts.json";

#[derive(Serialize, Deserialize)]
struct AccountsFile {
    accounts: Vec<String>,
}

/// `None` means accounts.json does not exist yet.
pub fn load(dir: &Path) -> Result<Option<Vec<String>>, String> {
    let path = dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => parse(&text)
            .map(Some)
            .map_err(|e| format!("{} の形式が不正です: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

pub fn save(dir: &Path, accounts: &[String]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(FILE);
    std::fs::write(&path, render(accounts)?)
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

fn parse(text: &str) -> Result<Vec<String>, serde_json::Error> {
    serde_json::from_str::<AccountsFile>(text).map(|f| f.accounts)
}

fn render(accounts: &[String]) -> Result<String, String> {
    serde_json::to_string_pretty(&AccountsFile {
        accounts: accounts.to_vec(),
    })
    .map_err(|e| e.to_string())
}

/// Appends `email` unless already listed (re-login of the same account keeps one entry).
pub fn with_account(mut accounts: Vec<String>, email: &str) -> Vec<String> {
    if !accounts.iter().any(|a| a == email) {
        accounts.push(email.to_owned());
    }
    accounts
}

/// The single-account keychain entry moves to a per-account one only while accounts.json is absent.
pub fn needs_migration(accounts_file_exists: bool, legacy_token_exists: bool) -> bool {
    !accounts_file_exists && legacy_token_exists
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cookup-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn render_then_parse_round_trips() {
        let list = vec!["a@example.com".to_string(), "b@example.com".to_string()];
        assert_eq!(parse(&render(&list).unwrap()).unwrap(), list);
    }

    #[test]
    fn parse_rejects_wrong_shape() {
        assert!(parse(r#"["a@example.com"]"#).is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn with_account_appends_new_and_keeps_existing_once() {
        let list = with_account(vec![], "a@example.com");
        let list = with_account(list, "b@example.com");
        let list = with_account(list, "a@example.com");
        assert_eq!(list, vec!["a@example.com", "b@example.com"]);
    }

    #[test]
    fn migrates_only_when_file_absent_and_legacy_present() {
        assert!(needs_migration(false, true));
        assert!(!needs_migration(true, true));
        assert!(!needs_migration(false, false));
        assert!(!needs_migration(true, false));
    }

    #[test]
    fn already_migrated_state_starts_without_migrating() {
        // accounts.json exists and the legacy entry is gone: the list loads from the file as is.
        let dir = temp_dir("migrated");
        save(&dir, &["a@example.com".to_string()]).unwrap();
        let stored = load(&dir).unwrap();
        assert!(!needs_migration(stored.is_some(), false));
        assert_eq!(stored, Some(vec!["a@example.com".to_string()]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn load_is_none_without_file_and_save_creates_dir_and_file() {
        let dir = temp_dir("save");
        assert_eq!(load(&dir), Ok(None));
        save(&dir, &["a@example.com".to_string()]).unwrap();
        assert_eq!(load(&dir), Ok(Some(vec!["a@example.com".to_string()])));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn load_reports_broken_file() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load(&dir).unwrap_err().contains("形式が不正"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
