use serde::Serialize;
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
    app.updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| log_failure(command, "-", format!("更新を確認できません: {e}")))
}

/// Whether a newer version is out. The sidebar shows its update button only for `Some`.
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(find(&app, "check_update")
        .await?
        .map(|u| UpdateInfo { version: u.version }))
}

/// Downloads the newer version, checks its signature, replaces the app and restarts it. Does nothing when there is none.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(update) = find(&app, "install_update").await? {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| log_failure("install_update", "-", format!("更新できません: {e}")))?;
        app.restart();
    }
    Ok(())
}
