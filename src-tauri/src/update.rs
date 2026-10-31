use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};
#[cfg(test)]
use ts_rs::TS;

use crate::gmail::log_failure;

/// The newer version GitHub Releases offers.
#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct UpdateInfo {
    pub version: String,
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
    found: tauri::State<'_, Mutex<Option<Update>>>,
) -> Result<Option<UpdateInfo>, String> {
    // Releases carry only the Apple Silicon macOS build, so elsewhere every check would fail.
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Ok(None);
    }
    let update = find(&app, "check_update").await?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
    });
    *found.lock().unwrap() = update;
    Ok(info)
}

/// Downloads the newer version, checks its signature, replaces the app and restarts it. Does nothing when there is none.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let kept = app.state::<Mutex<Option<Update>>>().lock().unwrap().take();
    let update = match kept {
        Some(u) => Some(u),
        None => find(&app, "install_update").await?,
    };
    if let Some(update) = update {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| log_failure("install_update", "-", format!("更新できません: {e}")))?;
        app.restart();
    }
    Ok(())
}
