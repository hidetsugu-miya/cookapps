mod accounts;
mod auth;
mod gmail;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(auth::Auth::new())
        .manage(gmail::SyncState::default())
        .invoke_handler(tauri::generate_handler![
            auth::login,
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
