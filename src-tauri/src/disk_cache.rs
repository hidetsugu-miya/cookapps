//! Kept copies of the last fetched mail list, calendar weeks and Todo in the settings folder.
//! The screen draws them first at startup, then the fetch redraws; they are only a head start, so a broken file is as good as none.

use std::{path::Path, sync::Mutex};

use serde::{de::DeserializeOwned, Serialize};

use crate::accounts::{self, write_synced};

// One writer at a time: two saves would otherwise share the temporary file, and an update reads what the other wrote.
static WRITING: Mutex<()> = Mutex::new(());

fn write<T: Serialize>(dir: &Path, file: &str, value: &T) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(file), dir.join(format!("{file}.tmp")));
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    // Rename over the target so a crash mid-write leaves the old file, not a truncated one.
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// Whether every account in `used` is in `listed`.
fn all_listed<'a>(listed: &[String], used: impl IntoIterator<Item = &'a str>) -> bool {
    used.into_iter().all(|u| listed.iter().any(|l| l == u))
}

/// Whether `used` are all registered now. Called under the lock: a save that began before `remove_account` must not bring a removed account's data back.
/// An unreadable account list counts as no.
fn registered<'a>(dir: &Path, used: impl IntoIterator<Item = &'a str>) -> bool {
    matches!(accounts::load(dir), Ok(Some(listed)) if all_listed(&listed, used))
}

/// Keeps `value`, unless an account in `used` has been removed meanwhile.
pub(crate) fn save<'a, T: Serialize>(
    dir: &Path,
    file: &str,
    value: &T,
    used: impl IntoIterator<Item = &'a str>,
) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    if !registered(dir, used) {
        return Ok(());
    }
    write(dir, file, value)
}

/// Replaces the kept value (a default one when none is readable) with `change` of it; `None` leaves the file alone.
/// Nothing is kept when an account in `used` has been removed meanwhile.
pub(crate) fn update<'a, T: Serialize + DeserializeOwned + Default>(
    dir: &Path,
    file: &str,
    used: impl IntoIterator<Item = &'a str>,
    change: impl FnOnce(T) -> Option<T>,
) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    if !registered(dir, used) {
        return Ok(());
    }
    match change(load(dir, file).unwrap_or_default()) {
        Some(value) => write(dir, file, &value),
        None => Ok(()),
    }
}

/// Runs `f` while no save or update runs, so each of them sees the account list either before `f` or after it.
pub(crate) fn exclusive<R>(f: impl FnOnce() -> R) -> R {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// `None` when the file is missing or unreadable.
pub(crate) fn load<T: DeserializeOwned>(dir: &Path, file: &str) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(file)).ok()?).ok()
}

/// A missing file counts as removed.
pub(crate) fn remove(dir: &Path, file: &str) -> Result<(), String> {
    match std::fs::remove_file(dir.join(file)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("キャッシュを消せません: {e}"))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookup-disk-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    const A: &str = "a@example.com";

    fn register(dir: &Path, listed: &[&str]) {
        accounts::save(
            dir,
            &listed.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();
    }

    #[test]
    fn all_listed_needs_every_used_account_in_the_list() {
        let listed = vec![A.to_string(), "b@example.com".to_string()];
        assert!(all_listed(&listed, [A, "b@example.com"]));
        assert!(all_listed(&listed, []));
        assert!(!all_listed(&listed, [A, "c@example.com"]));
        assert!(!all_listed(&[], [A]));
    }

    #[test]
    fn nothing_is_kept_for_a_removed_account_or_without_an_account_list() {
        let dir = temp_dir("removed");
        save(&dir, "a.json", &vec![1], [A]).unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), None);
        register(&dir, &["b@example.com"]);
        save(&dir, "a.json", &vec![1], [A]).unwrap();
        update(&dir, "a.json", [A], |v: Vec<u32>| Some(v)).unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_that_returns_none_leaves_the_file_alone() {
        let dir = temp_dir("none");
        register(&dir, &[A]);
        save(&dir, "a.json", &vec![1], [A]).unwrap();
        update(&dir, "a.json", [A], |_: Vec<u32>| None).unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), Some(vec![1]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saved_value_loads_back_and_leaves_no_temporary_file() {
        let dir = temp_dir("round-trip");
        register(&dir, &[A]);
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), None);
        save(&dir, "a.json", &vec![1, 2], [A]).unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), Some(vec![1, 2]));
        assert!(!dir.join("a.json.tmp").exists());
        remove(&dir, "a.json").unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), None);
        // Removing what is already gone is not an error.
        remove(&dir, "a.json").unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn broken_file_is_none() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        for text in ["", "{", "[1,", "\"x\""] {
            std::fs::write(dir.join("a.json"), text).unwrap();
            assert_eq!(load::<Vec<u32>>(&dir, "a.json"), None, "{text}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_starts_from_the_kept_value_or_the_default() {
        let dir = temp_dir("update");
        register(&dir, &[A]);
        update(&dir, "a.json", [A], |mut v: Vec<u32>| {
            v.push(1);
            Some(v)
        })
        .unwrap();
        update(&dir, "a.json", [A], |mut v: Vec<u32>| {
            v.push(2);
            Some(v)
        })
        .unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), Some(vec![1, 2]));
        // A file that cannot be read starts over from the default.
        std::fs::write(dir.join("a.json"), "{").unwrap();
        update(&dir, "a.json", [A], |mut v: Vec<u32>| {
            v.push(3);
            Some(v)
        })
        .unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), Some(vec![3]));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
