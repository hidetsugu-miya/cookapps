mod accounts;
mod auth;
mod calendar;
mod gmail;

fn main() {
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
