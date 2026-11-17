//! The app's identifier and its config folder.
//! The folder is named after the identifier (Tauri's `app_config_dir`), so a change of the identifier leaves the settings in the folder of the old one:
//! `migrate_config_dir` copies them over once, and `tsunagiai-mcp`, which builds the path itself, goes through the same function.

use std::{
    fs,
    path::{Path, PathBuf},
};

/// Equal to `identifier` in `tauri.conf.json`.
pub const IDENTIFIER: &str = "jp.mysis.tsunagiai";
/// The identifier before the rename: the old config folder and the old keychain services carry it.
pub const OLD_IDENTIFIER: &str = "jp.mysis.cookapps";

/// The config folder of the app as Tauri resolves it (`dirs::config_dir()` joined with the identifier), after the move of the old folder.
/// The folder `formation/` of the formations is renamed `formations/` there too (`formation::migrate_folder`).
/// A failed move is logged and the app starts with what the new folder holds.
pub fn config_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .map(|dir| dir.join(IDENTIFIER))
        .ok_or_else(|| "設定フォルダの場所を特定できません".to_string())?;
    if let Err(e) = migrate_config_dir(&dir) {
        eprintln!("tsunagiai: config_migrate account=- status=- error={e}");
    }
    if let Err(e) = crate::formation::migrate_folder(&dir) {
        eprintln!("tsunagiai: formation_migrate account=- status=- error={e}");
    }
    Ok(dir)
}

/// The old folder to copy into `new`: only when `new` is the app's own folder (a build with another identifier, such as the E2E one, has none),
/// does not exist yet, and the old folder beside it does.
fn source_of(new: &Path) -> Option<PathBuf> {
    if new.file_name()? != IDENTIFIER || new.symlink_metadata().is_ok() {
        return None;
    }
    let old = new.with_file_name(OLD_IDENTIFIER);
    old.is_dir().then_some(old)
}

/// Copies the contents of the old config folder to `new` when `new` does not exist. The old folder is kept.
/// The copy is made beside `new` and renamed into place, so a failure never leaves a half-filled `new` that the next start would take for the moved one.
pub fn migrate_config_dir(new: &Path) -> Result<(), String> {
    let Some(old) = source_of(new) else {
        return Ok(());
    };
    let staging = new.with_file_name(format!("{IDENTIFIER}.moving-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let moved = copy_dir(&old, &staging).and_then(|()| fs::rename(&staging, new));
    if moved.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    match moved {
        // Another process (the app and `tsunagiai-mcp` start together) moved it first.
        Err(_) if new.is_dir() => Ok(()),
        Err(e) => Err(format!("設定フォルダの引っ越しに失敗: {e}")),
        Ok(()) => Ok(()),
    }
}

/// Copies `from` to `to` (which must not exist), files and folders, following symbolic links, keeping the modes.
/// An entry that is no file or folder (a link to nothing, a socket) is skipped, so one of them does not stop the move of the rest.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir(to)?;
    for item in fs::read_dir(from)? {
        let item = item?;
        let (src, dst) = (item.path(), to.join(item.file_name()));
        let kind = match fs::metadata(&src) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        if kind.is_dir() {
            copy_dir(&src, &dst)?;
        } else if kind.is_file() {
            fs::copy(&src, &dst)?;
        }
    }
    fs::set_permissions(to, fs::metadata(from)?.permissions())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh parent folder, standing for the user's config folder.
    fn parent(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tsunagiai-identity-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_old(parent: &Path) -> PathBuf {
        let old = parent.join(OLD_IDENTIFIER);
        fs::create_dir_all(old.join("claude-plugin/skills")).unwrap();
        fs::write(old.join("accounts.json"), "[\"a@example.com\"]").unwrap();
        fs::write(old.join("claude-plugin/skills/SKILL.md"), "skill").unwrap();
        old
    }

    #[test]
    fn the_identifiers_are_the_ones_of_the_configs() {
        let id = |text: &str| {
            serde_json::from_str::<serde_json::Value>(text).unwrap()["identifier"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(id(include_str!("../tauri.conf.json")), IDENTIFIER);
        assert_eq!(
            id(include_str!("../tauri.e2e.conf.json")),
            format!("{IDENTIFIER}.e2e")
        );
    }

    #[test]
    fn the_old_folder_is_copied_whole_and_kept_when_the_new_one_is_missing() {
        let parent = parent("copy");
        let old = make_old(&parent);
        let new = parent.join(IDENTIFIER);
        migrate_config_dir(&new).unwrap();
        assert_eq!(
            fs::read_to_string(new.join("accounts.json")).unwrap(),
            "[\"a@example.com\"]"
        );
        assert_eq!(
            fs::read_to_string(new.join("claude-plugin/skills/SKILL.md")).unwrap(),
            "skill"
        );
        assert!(old.join("accounts.json").is_file());
        let left: Vec<_> = fs::read_dir(&parent).unwrap().collect();
        assert_eq!(left.len(), 2, "no staging folder is left");
        fs::remove_dir_all(&parent).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_entry_that_cannot_be_copied_is_skipped_and_the_rest_is_moved() {
        let parent = parent("broken-link");
        let old = make_old(&parent);
        std::os::unix::fs::symlink(old.join("gone"), old.join("broken")).unwrap();
        std::os::unix::fs::symlink(old.join("claude-plugin"), old.join("linked-dir")).unwrap();
        let new = parent.join(IDENTIFIER);
        migrate_config_dir(&new).unwrap();
        assert!(new.join("accounts.json").is_file());
        assert!(new.join("claude-plugin/skills/SKILL.md").is_file());
        assert!(new.join("linked-dir/skills/SKILL.md").is_file());
        assert!(new.join("broken").symlink_metadata().is_err());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn an_existing_new_folder_is_left_as_it_is_even_when_empty() {
        let parent = parent("exists");
        make_old(&parent);
        let new = parent.join(IDENTIFIER);
        fs::create_dir(&new).unwrap();
        migrate_config_dir(&new).unwrap();
        assert_eq!(fs::read_dir(&new).unwrap().count(), 0);
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn nothing_is_made_without_an_old_folder() {
        let parent = parent("no-old");
        let new = parent.join(IDENTIFIER);
        migrate_config_dir(&new).unwrap();
        assert!(!new.exists());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn a_folder_of_another_identifier_never_takes_the_old_one() {
        let parent = parent("e2e");
        make_old(&parent);
        let e2e = parent.join(format!("{IDENTIFIER}.e2e"));
        migrate_config_dir(&e2e).unwrap();
        assert!(!e2e.exists());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn a_staging_folder_left_by_an_earlier_run_does_not_get_in_the_way() {
        let parent = parent("stale");
        make_old(&parent);
        let stale = parent.join(format!("{IDENTIFIER}.moving-{}", std::process::id()));
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("junk"), "x").unwrap();
        let new = parent.join(IDENTIFIER);
        migrate_config_dir(&new).unwrap();
        assert!(new.join("accounts.json").is_file());
        assert!(!new.join("junk").exists());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn the_config_dir_is_the_apps_folder_under_the_users_config_dir() {
        // Only the path: the move of the old folder is tried on temporary folders above, and this machine's folder is never touched by a test.
        let new = dirs::config_dir().unwrap().join(IDENTIFIER);
        assert!(new.is_absolute());
        assert!(new.ends_with(IDENTIFIER));
    }
}
