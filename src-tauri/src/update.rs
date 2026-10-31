use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::task::spawn_blocking;
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_synced, auth::config_dir, gmail::log_failure};

const FILE: &str = "update-settings.json";
const TMP_FILE: &str = "update-settings.json.tmp";

// Releases carry only the Apple Silicon macOS build, so elsewhere every check would fail.
const UPDATABLE: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

/// Whether the app replaces itself with a newer version by itself (`Auto`) or only when the update button is pressed (`Manual`).
#[derive(Serialize, Deserialize, Default, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    Manual,
    #[default]
    Auto,
}

#[derive(Serialize, Deserialize)]
struct SettingsFile {
    mode: UpdateMode,
}

/// The mode a settings file holds. A file that does not say one gives the default.
fn parse_mode(text: &str) -> UpdateMode {
    serde_json::from_str::<SettingsFile>(text)
        .map(|f| f.mode)
        .unwrap_or_default()
}

fn load(dir: &Path) -> UpdateMode {
    std::fs::read_to_string(dir.join(FILE))
        .map(|text| parse_mode(&text))
        .unwrap_or_default()
}

fn save(dir: &Path, mode: UpdateMode) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (path, tmp) = (dir.join(FILE), dir.join(TMP_FILE));
    let text = serde_json::to_string_pretty(&SettingsFile { mode }).map_err(|e| e.to_string())?;
    write_synced(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{} を書けません: {e}", path.display()))
}

/// The running version, and whether this build can update itself.
#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct AppInfo {
    pub version: String,
    pub updatable: bool,
}

/// The newer version GitHub Releases offers. `installed`: the app is already replaced, and only a restart is left.
#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct UpdateInfo {
    pub version: String,
    pub installed: bool,
}

/// The version `install_update` replaced the app with. The running app stays the old one until it restarts, so a check would find that version again.
/// `busy` lets one replacement run at a time: the auto install and the update button can both call `install_update`.
#[derive(Default)]
pub struct Installed(Mutex<Option<String>>, tokio::sync::Mutex<()>);

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        updatable: UPDATABLE,
    }
}

#[tauri::command]
pub async fn update_mode(app: tauri::AppHandle) -> Result<UpdateMode, String> {
    let dir = config_dir(&app)?;
    spawn_blocking(move || load(&dir))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_update_mode(app: tauri::AppHandle, mode: UpdateMode) -> Result<(), String> {
    let dir = config_dir(&app)?;
    spawn_blocking(move || save(&dir, mode))
        .await
        .map_err(|e| e.to_string())?
}

/// The newer release for this platform, or `None` when this one is the latest. The signature of `latest.json` is checked at the install, not here.
async fn find(app: &tauri::AppHandle, command: &str) -> Result<Option<Update>, String> {
    let fail = |e: tauri_plugin_updater::Error| {
        log_failure(command, "-", format!("更新を確認できません: {e}"))
    };
    app.updater().map_err(fail)?.check().await.map_err(fail)
}

/// Whether a newer version is out. The sidebar shows its update button only for `Some`. The found update is kept for `install_update`.
#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    found: State<'_, Mutex<Option<Update>>>,
    installed: State<'_, Installed>,
) -> Result<Option<UpdateInfo>, String> {
    if !UPDATABLE {
        return Ok(None);
    }
    let done = installed.0.lock().unwrap().clone();
    if let Some(version) = done {
        return Ok(Some(UpdateInfo {
            version,
            installed: true,
        }));
    }
    let update = find(&app, "check_update").await?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        installed: false,
    });
    *found.lock().unwrap() = update;
    Ok(info)
}

/// Downloads the newer version, checks its signature and replaces the app, without restarting it (`restart_app` does).
/// Does nothing when there is none, or when the app is already replaced.
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    found: State<'_, Mutex<Option<Update>>>,
    installed: State<'_, Installed>,
) -> Result<(), String> {
    // A second call waits here, then finds the app already replaced.
    let _busy = installed.1.lock().await;
    if installed.0.lock().unwrap().is_some() {
        return Ok(());
    }
    let kept = found.lock().unwrap().take();
    let update = match kept {
        Some(u) => Some(u),
        None => find(&app, "install_update").await?,
    };
    if let Some(update) = update {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| log_failure("install_update", "-", format!("更新できません: {e}")))?;
        *installed.0.lock().unwrap() = Some(update.version);
    }
    Ok(())
}

/// Restarts the app, which then runs the version `install_update` put in place.
#[tauri::command]
pub async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mode_reads_both_modes() {
        assert_eq!(parse_mode(r#"{"mode":"manual"}"#), UpdateMode::Manual);
        assert_eq!(parse_mode(r#"{"mode":"auto"}"#), UpdateMode::Auto);
    }

    #[test]
    fn parse_mode_falls_back_to_auto_when_the_file_says_none() {
        for text in ["", "{", "{}", r#"{"mode":"later"}"#, r#"{"mode":1}"#] {
            assert_eq!(parse_mode(text), UpdateMode::Auto, "{text}");
        }
    }

    #[test]
    fn load_gives_what_save_wrote_and_auto_for_no_file() {
        let dir = std::env::temp_dir().join(format!("cookapps-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), UpdateMode::Auto);
        save(&dir, UpdateMode::Manual).unwrap();
        assert_eq!(load(&dir), UpdateMode::Manual);
        save(&dir, UpdateMode::Auto).unwrap();
        assert_eq!(load(&dir), UpdateMode::Auto);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
