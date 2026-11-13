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
    write_atomic(dir, FILE, &render(accounts)?)
}

/// Writes `text` to `file` in `dir` (made when missing) through `{file}.tmp` and a rename.
/// Renaming over the target means a crash mid-write leaves the old file, not a truncated one.
pub(crate) fn write_atomic(dir: &Path, file: &str, text: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(file), dir.join(format!("{file}.tmp")));
    write_synced(&tmp, text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

pub(crate) fn write_synced(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
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

/// Drops `email`; an address not listed leaves the list as it is.
pub fn without_account(accounts: Vec<String>, email: &str) -> Vec<String> {
    accounts.into_iter().filter(|a| a != email).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_account_drops_only_that_account_and_it_can_be_added_again() {
        let list = vec!["a@example.com".to_string(), "b@example.com".to_string()];
        let list = without_account(list, "a@example.com");
        assert_eq!(list, vec!["b@example.com"]);
        assert_eq!(without_account(list.clone(), "x@example.com"), list);
        assert_eq!(
            with_account(without_account(list, "b@example.com"), "b@example.com"),
            vec!["b@example.com"]
        );
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cookapps-test-{}-{name}", std::process::id()));
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
    fn load_is_none_without_file_and_save_creates_dir_and_file() {
        let dir = temp_dir("save");
        assert_eq!(load(&dir), Ok(None));
        save(&dir, &["a@example.com".to_string()]).unwrap();
        assert_eq!(load(&dir), Ok(Some(vec!["a@example.com".to_string()])));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failed_save_leaves_the_existing_file_untouched() {
        let dir = temp_dir("atomic");
        save(&dir, &["a@example.com".to_string()]).unwrap();
        // A directory in the temporary file's place makes the write fail before the rename.
        std::fs::create_dir(dir.join("accounts.json.tmp")).unwrap();
        assert!(save(&dir, &["b@example.com".to_string()]).is_err());
        assert_eq!(load(&dir), Ok(Some(vec!["a@example.com".to_string()])));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_replaces_the_file_without_leaving_the_temporary_one() {
        let dir = temp_dir("replace");
        save(&dir, &["a@example.com".to_string()]).unwrap();
        save(&dir, &["b@example.com".to_string()]).unwrap();
        assert_eq!(load(&dir), Ok(Some(vec!["b@example.com".to_string()])));
        assert!(!dir.join("accounts.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_atomic_makes_the_folder_and_replaces_the_file_without_a_temporary_one() {
        let dir = temp_dir("write-atomic").join("nested");
        write_atomic(&dir, "a.json", "one").unwrap();
        write_atomic(&dir, "a.json", "two").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.json")).unwrap(), "two");
        assert!(!dir.join("a.json.tmp").exists());
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn write_atomic_keeps_the_old_file_and_names_the_path_when_the_write_fails() {
        let dir = temp_dir("write-atomic-fail");
        write_atomic(&dir, "a.json", "one").unwrap();
        // A directory in the temporary file's place makes the write fail before the rename.
        std::fs::create_dir(dir.join("a.json.tmp")).unwrap();
        let err = write_atomic(&dir, "a.json", "two").unwrap_err();
        assert!(err.starts_with(&format!("{} を書けません", dir.join("a.json").display())));
        assert_eq!(std::fs::read_to_string(dir.join("a.json")).unwrap(), "one");
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
