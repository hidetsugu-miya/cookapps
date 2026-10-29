mod accounts;
mod auth;
mod gmail;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(auth::Auth::new())
        .invoke_handler(tauri::generate_handler![
            auth::login,
            gmail::inbox,
            gmail::thread,
            gmail::trash,
            gmail::archive
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
