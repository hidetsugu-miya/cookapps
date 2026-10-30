//! Kept copies of the last fetched mail list, calendar weeks and Todo in the settings folder.
//! The screen draws them first at startup, then the fetch redraws; they are only a head start, so a broken file is as good as none.

use std::{path::Path, sync::Mutex};

use serde::{de::DeserializeOwned, Serialize};

use crate::accounts::write_synced;

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

pub(crate) fn save<T: Serialize>(dir: &Path, file: &str, value: &T) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    write(dir, file, value)
}

/// Replaces the kept value (a default one when none is readable) with `change` of it.
pub(crate) fn update<T: Serialize + DeserializeOwned + Default>(
    dir: &Path,
    file: &str,
    change: impl FnOnce(T) -> T,
) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    write(dir, file, &change(load(dir, file).unwrap_or_default()))
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

    #[test]
    fn saved_value_loads_back_and_leaves_no_temporary_file() {
        let dir = temp_dir("round-trip");
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), None);
        save(&dir, "a.json", &vec![1, 2]).unwrap();
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
        update(&dir, "a.json", |mut v: Vec<u32>| {
            v.push(1);
            v
        })
        .unwrap();
        update(&dir, "a.json", |mut v: Vec<u32>| {
            v.push(2);
            v
        })
        .unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), Some(vec![1, 2]));
        // A file that cannot be read starts over from the default.
        std::fs::write(dir.join("a.json"), "{").unwrap();
        update(&dir, "a.json", |mut v: Vec<u32>| {
            v.push(3);
            v
        })
        .unwrap();
        assert_eq!(load::<Vec<u32>>(&dir, "a.json"), Some(vec![3]));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
