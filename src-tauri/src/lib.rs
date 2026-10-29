pub mod accounts;
pub mod auth;
pub mod calendar;
pub mod gmail;
pub mod image_senders;
pub mod images;
pub mod todoist;

// tao's macOS backend shows `Some(0)` as "0", so no unread must be `None`.
fn badge_of(count: u32) -> Option<i64> {
    (count > 0).then_some(i64::from(count))
}

/// Shows the unread count as the Dock badge; 0 removes it.
#[tauri::command]
fn set_badge(window: tauri::WebviewWindow, count: u32) -> Result<(), String> {
    window
        .set_badge_count(badge_of(count))
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(auth::Auth::new())
        .manage(gmail::SyncState::default())
        .manage(gmail::InlineCache::default())
        .manage(images::ImageCache::default())
        .manage(image_senders::ImageSenders::default())
        .manage(calendar::CalendarCache::default())
        .manage(todoist::TodoistState::default())
        .invoke_handler(tauri::generate_handler![
            auth::login,
            auth::remove_account,
            calendar::calendar_week,
            gmail::inbox,
            gmail::thread,
            gmail::thread_images,
            gmail::trash,
            gmail::archive,
            gmail::set_read,
            gmail::sync,
            images::fetch_images,
            image_senders::image_sender_known,
            image_senders::remember_image_sender,
            image_senders::forget_image_sender,
            todoist::todoist_load,
            todoist::todoist_save_token,
            todoist::todoist_disconnect,
            todoist::todoist_add,
            todoist::todoist_add_subtask,
            todoist::todoist_task_from_mail,
            todoist::todoist_set_done,
            todoist::todoist_update,
            todoist::todoist_move,
            todoist::todoist_delete,
            todoist::todoist_open,
            set_badge
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}

#[cfg(test)]
mod tests {
    use super::badge_of;

    #[test]
    fn zero_removes_the_badge() {
        assert_eq!(badge_of(0), None);
    }

    #[test]
    fn positive_count_is_shown() {
        assert_eq!(badge_of(3), Some(3));
    }
}
