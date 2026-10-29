pub mod accounts;
pub mod auth;
pub mod calendar;
pub mod gmail;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(auth::Auth::new())
        .manage(gmail::SyncState::default())
        .manage(calendar::CalendarCache::default())
        .invoke_handler(tauri::generate_handler![
            auth::login,
            calendar::calendar_week,
            gmail::inbox,
            gmail::thread,
            gmail::trash,
            gmail::archive,
            gmail::set_read,
            gmail::sync
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
