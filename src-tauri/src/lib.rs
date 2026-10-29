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

/// What to do with a navigation of the webview or one of its frames.
#[derive(Debug, PartialEq)]
enum Navigation {
    /// The app's own page, or a frame's `about:srcdoc`.
    Allow,
    /// A link of a mail body: handed to the default browser.
    Browser,
    Cancel,
}

fn navigation_of(url: &tauri::Url) -> Navigation {
    match (url.scheme(), url.host_str()) {
        ("about", _) | ("tauri", Some("localhost")) => Navigation::Allow,
        // Windows and Android serve the app from this origin.
        ("http" | "https", Some("tauri.localhost")) => Navigation::Allow,
        ("http" | "https", _) => Navigation::Browser,
        _ => Navigation::Cancel,
    }
}

/// A mail body's frame may navigate the top window only by a user's click (its sandbox has
/// allow-top-navigation-by-user-activation); that navigation is always cancelled here, and an http(s) URL goes to the browser.
fn navigation_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("navigation")
        .on_navigation(|webview, url| {
            match navigation_of(url) {
                Navigation::Allow => return true,
                Navigation::Browser => {
                    if let Err(e) = webview.opener().open_url(url.as_str(), None::<&str>) {
                        gmail::log_failure("navigation", "-", format!("ブラウザを開けません: {e}"));
                    }
                }
                Navigation::Cancel => {}
            }
            false
        })
        .build()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_plugin())
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
            set_badge
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}

#[cfg(test)]
mod tests {
    use super::{badge_of, navigation_of, Navigation};

    fn url(raw: &str) -> tauri::Url {
        raw.parse().unwrap()
    }

    #[test]
    fn zero_removes_the_badge() {
        assert_eq!(badge_of(0), None);
    }

    #[test]
    fn positive_count_is_shown() {
        assert_eq!(badge_of(3), Some(3));
    }

    #[test]
    fn the_apps_own_pages_and_frames_are_allowed() {
        for ok in [
            "tauri://localhost/index.html",
            "tauri://localhost",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "about:srcdoc",
            "about:blank",
        ] {
            assert_eq!(navigation_of(&url(ok)), Navigation::Allow, "{ok}");
        }
    }

    #[test]
    fn web_links_go_to_the_browser() {
        for web in [
            "https://docs.google.com/document/d/x/edit?tab=t.0",
            "http://example.com",
            "HTTPS://example.com/",
            "https://tauri.localhost.example.com/",
        ] {
            assert_eq!(navigation_of(&url(web)), Navigation::Browser, "{web}");
        }
    }

    #[test]
    fn other_navigations_are_cancelled() {
        for bad in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "mailto:a@example.com",
            "tauri://example.com/",
            "ftp://example.com/",
        ] {
            assert_eq!(navigation_of(&url(bad)), Navigation::Cancel, "{bad}");
        }
    }
}
