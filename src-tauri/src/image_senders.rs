//! The senders whose external images are shown without asking: a list of addresses in the settings folder.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{accounts::write_synced, auth::config_dir};

const FILE: &str = "image_senders.json";
const TMP_FILE: &str = "image_senders.json.tmp";

#[derive(Serialize, Deserialize)]
struct SendersFile {
    senders: Vec<String>,
}

/// The address of a `From` value, lowercased: `Name <a@example.com>` and `a@example.com` give `a@example.com`.
/// `None` when no single address can be read from it.
pub fn sender_address(from: &str) -> Option<String> {
    let inner = match from.rfind('<') {
        Some(i) => from[i + 1..].split_once('>')?.0,
        None => from,
    };
    let address = inner.trim().to_lowercase();
    let (local, domain) = address.split_once('@')?;
    let plain = address
        .chars()
        .all(|c| !c.is_whitespace() && !c.is_control() && !"<>()[],;:\"\\".contains(c));
    (plain && !local.is_empty() && !domain.is_empty() && !domain.contains('@')).then_some(address)
}

pub fn is_known(senders: &[String], from: &str) -> bool {
    sender_address(from).is_some_and(|a| senders.contains(&a))
}

/// Adds the sender of `from` unless it is listed or has no readable address.
pub fn with_sender(mut senders: Vec<String>, from: &str) -> Vec<String> {
    if let Some(address) = sender_address(from).filter(|a| !senders.contains(a)) {
        senders.push(address);
    }
    senders
}

/// Drops the sender of `from`; one not listed leaves the list as it is.
pub fn without_sender(senders: Vec<String>, from: &str) -> Vec<String> {
    let address = sender_address(from);
    senders
        .into_iter()
        .filter(|s| Some(s) != address.as_ref())
        .collect()
}

/// An empty list when image_senders.json does not exist yet.
fn load(dir: &Path) -> Result<Vec<String>, String> {
    let path = dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<SendersFile>(&text)
            .map(|f| f.senders)
            .map_err(|e| format!("{} の形式が不正です: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

fn save(dir: &Path, senders: Vec<String>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(FILE), dir.join(TMP_FILE));
    let text = serde_json::to_string_pretty(&SendersFile { senders }).map_err(|e| e.to_string())?;
    // Rename over the target so a crash mid-write leaves the old file, not a truncated one.
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// Whether the sender of `from` is remembered. Not `async`: commands without it run one at a time, so the writes below do not race.
#[tauri::command]
pub fn image_sender_known(app: AppHandle, from: String) -> Result<bool, String> {
    Ok(is_known(&load(&config_dir(&app)?)?, &from))
}

/// Remembers the sender of `from`.
#[tauri::command]
pub fn remember_image_sender(app: AppHandle, from: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    save(&dir, with_sender(load(&dir)?, &from))
}

/// Forgets the sender of `from`.
#[tauri::command]
pub fn forget_image_sender(app: AppHandle, from: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    save(&dir, without_sender(load(&dir)?, &from))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookup-senders-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn sender_address_takes_the_lowercased_address_of_any_from_form() {
        for (from, want) in [
            ("Alice <Alice@Example.COM>", "alice@example.com"),
            ("a@example.com", "a@example.com"),
            ("  <a@example.com> ", "a@example.com"),
            (r#""Doe, John" <j@x.com>"#, "j@x.com"),
            // The display name can hold another address; the one in the angle brackets is the sender.
            (r#""boss@corp.com" <spam@x.com>"#, "spam@x.com"),
        ] {
            assert_eq!(sender_address(from).as_deref(), Some(want), "{from}");
        }
    }

    #[test]
    fn sender_address_refuses_what_is_not_a_single_address() {
        for from in [
            "",
            "Alice",
            "Alice <>",
            "Alice <a@example.com",
            "<@example.com>",
            "<a@>",
            "a@b@c.com",
            "a b@c.com",
            "a@c.com, b@c.com",
        ] {
            assert_eq!(sender_address(from), None, "{from}");
        }
    }

    #[test]
    fn senders_are_matched_by_address_and_listed_once() {
        let list = with_sender(vec![], "Alice <A@x.com>");
        let list = with_sender(list, "other name <a@X.com>");
        let list = with_sender(list, "b@x.com");
        assert_eq!(list, ["a@x.com", "b@x.com"]);
        assert!(is_known(&list, "Anyone <A@x.com>"));
        assert!(!is_known(&list, "c@x.com"));
        assert!(!is_known(&list, "no address"));
        // A From with no readable address adds nothing.
        assert_eq!(with_sender(list.clone(), "no address"), list);
        assert_eq!(without_sender(list.clone(), "c@x.com"), list);
        assert_eq!(without_sender(list.clone(), "ALICE <a@x.com>"), ["b@x.com"]);
        assert_eq!(without_sender(list.clone(), "no address"), list);
    }

    #[test]
    fn load_is_empty_without_file_and_save_creates_dir_and_file() {
        let dir = temp_dir("save");
        assert_eq!(load(&dir), Ok(vec![]));
        save(&dir, vec!["a@x.com".into()]).unwrap();
        assert_eq!(load(&dir), Ok(vec!["a@x.com".to_string()]));
        save(&dir, vec!["b@x.com".into()]).unwrap();
        assert_eq!(load(&dir), Ok(vec!["b@x.com".to_string()]));
        assert!(!dir.join(TMP_FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failed_save_leaves_the_existing_file_untouched() {
        let dir = temp_dir("atomic");
        save(&dir, vec!["a@x.com".into()]).unwrap();
        // A directory in the temporary file's place makes the write fail before the rename.
        std::fs::create_dir(dir.join(TMP_FILE)).unwrap();
        assert!(save(&dir, vec!["b@x.com".into()]).is_err());
        assert_eq!(load(&dir), Ok(vec!["a@x.com".to_string()]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn load_reports_a_broken_file() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load(&dir).unwrap_err().contains("形式が不正"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
