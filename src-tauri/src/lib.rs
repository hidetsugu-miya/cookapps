pub mod accounts;
pub mod auth;
pub mod calendar;
pub mod gmail;
pub mod image_senders;
pub mod images;
pub mod todoist;

use tauri_plugin_opener::OpenerExt;

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

/// Parses a link from a mail body; only http(s) may be handed to the browser.
fn web_link(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "リンクの URL が不正です".to_owned())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("http と https 以外のリンクは開けません".into()),
    }
}

/// Opens a link of a mail body in the default browser.
#[tauri::command]
fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = web_link(&url).map_err(|e| gmail::log_failure("open_link", "-", e))?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| gmail::log_failure("open_link", "-", format!("ブラウザを開けません: {e}")))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(auth::Auth::new())
        .manage(gmail::SyncState::default())
        .manage(gmail::InlineCache::default())
        .manage(gmail::PendingImages::default())
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
            open_link,
            set_badge
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}

#[cfg(test)]
mod tests {
    use super::{badge_of, web_link};

    #[test]
    fn zero_removes_the_badge() {
        assert_eq!(badge_of(0), None);
    }

    #[test]
    fn positive_count_is_shown() {
        assert_eq!(badge_of(3), Some(3));
    }

    #[test]
    fn web_links_are_http_and_https_only() {
        let url = web_link(" https://docs.google.com/document/d/x/edit?tab=t.0 ").unwrap();
        assert_eq!(
            url.as_str(),
            "https://docs.google.com/document/d/x/edit?tab=t.0"
        );
        assert!(web_link("http://example.com").is_ok());
        assert!(web_link("HTTPS://example.com").is_ok());
        for bad in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "mailto:a@example.com",
            "//example.com",
            "/relative",
            "",
        ] {
            assert!(web_link(bad).is_err(), "{bad}");
        }
    }
}
