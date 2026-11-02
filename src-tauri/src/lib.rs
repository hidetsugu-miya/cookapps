pub mod accounts;
pub mod auth;
pub mod calendar;
pub mod claude;
mod disk_cache;
pub mod gmail;
pub mod image_senders;
pub mod images;
pub mod slack;
pub mod todoist;
pub mod update;

use tauri_plugin_opener::OpenerExt;

/// Where ts-rs writes the types the frontend shares (`#[ts(export_to = crate::BINDINGS)]`), on `cargo test`.
/// An absolute path, so the default `./bindings` directory is not created next to it.
#[cfg(test)]
const BINDINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../ts/bindings/");

// tao's macOS backend shows `Some(0)` as "0", so no unread must be `None`.
fn badge_of(count: u32) -> Option<i64> {
    (count > 0).then_some(i64::from(count))
}

/// Shows the unread count as the Dock badge; 0 removes it. Windows has no badge count (tao ignores it), so this does nothing there.
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

// wry asks about the navigations of every frame, not only the top window's, and cannot tell a click from a load.
// A WKWebView check found no load without a click that gets here: a mail's nested iframe, frame, object, embed (stopped by the CSP)
// and meta refresh (stopped by the sandbox) never reached the delegate.
fn navigation_of(url: &tauri::Url) -> Navigation {
    match (url.scheme(), url.host_str()) {
        // Only the mail frames' own document; any other about: page would blank the window or a frame.
        ("about", _) if url.path() == "srcdoc" => Navigation::Allow,
        ("tauri", Some("localhost")) => Navigation::Allow,
        // Windows and Android serve the app from this origin; on macOS it is no page of the app.
        #[cfg(any(windows, target_os = "android"))]
        ("http" | "https", Some("tauri.localhost")) => Navigation::Allow,
        ("http" | "https", _) => Navigation::Browser,
        _ => Navigation::Cancel,
    }
}

/// A mail body's frame may navigate the top window only by a user's click (its sandbox has
/// allow-top-navigation-by-user-activation); that navigation is always cancelled here, and an http(s) URL goes to the browser.
/// A link of a plain-text body is on the top window itself and comes here the same way.
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

/// Defense in depth under the JS-side mocks of the E2E build: no credential ever reaches the real keychain.
/// keyring's one-time init installs the native store on the first `Entry::new` (or `store_status`), so run it first and replace the store after.
#[cfg(feature = "e2e")]
fn use_mock_keyring() {
    let _ = keyring::Entry::store_status();
    keyring_core::set_default_store(keyring_core::mock::Store::new().expect("mock keyring store"));
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init())
        .setup(|_app| {
            // No Dock icon, and no focus taken from the developer's apps while the E2E run drives the window.
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            Ok(())
        });
    #[cfg(feature = "e2e")]
    use_mock_keyring();
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_plugin())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(auth::Auth::new())
        .manage(gmail::SyncState::default())
        .manage(gmail::InlineCache::default())
        .manage(gmail::PendingImages::default())
        .manage(images::ImageCache::default())
        .manage(image_senders::ImageSenders::default())
        .manage(calendar::CalendarCache::default())
        .manage(todoist::TodoistState::default())
        .manage(slack::SlackState::default())
        .manage(std::sync::Mutex::new(None::<tauri_plugin_updater::Update>))
        .manage(update::Installed::default())
        .invoke_handler(tauri::generate_handler![
            auth::login,
            auth::remove_account,
            calendar::calendar_week,
            calendar::calendar_cached,
            calendar::calendar_first_day,
            calendar::set_calendar_first_day,
            gmail::inbox,
            gmail::inbox_cached,
            gmail::thread,
            gmail::thread_images,
            gmail::trash,
            gmail::archive,
            gmail::untrash,
            gmail::unarchive,
            gmail::set_read,
            gmail::sync,
            images::fetch_images,
            image_senders::image_sender_known,
            image_senders::remember_image_sender,
            todoist::todoist_load,
            todoist::todoist_cached,
            todoist::todoist_save_token,
            todoist::todoist_disconnect,
            todoist::todoist_add,
            todoist::todoist_add_subtask,
            todoist::todoist_task_from_mail,
            todoist::todoist_summarize_slack,
            todoist::todoist_add_from_slack,
            todoist::todoist_set_done,
            todoist::todoist_update,
            todoist::todoist_move,
            todoist::todoist_delete,
            todoist::todoist_open,
            slack::slack_load,
            slack::slack_check,
            slack::slack_add_workspace,
            slack::slack_remove_workspace,
            slack::slack_channels,
            slack::slack_link,
            slack::slack_preview,
            slack::slack_post,
            claude::claude_status,
            claude::claude_summarize_mail,
            claude::claude_todo_prompt,
            claude::claude_todo_prompt_save,
            claude::claude_todo_prompt_reset,
            claude::claude_edit_todo_prompt,
            update::app_info,
            update::update_mode,
            update::set_update_mode,
            update::check_update,
            update::install_update,
            update::restart_app,
            set_badge
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "e2e")]
    #[test]
    fn e2e_build_keeps_credentials_out_of_the_keychain() {
        super::use_mock_keyring();
        // The entry must come from the mock store even though keyring's own init ran first.
        let _ = keyring::Entry::new("jp.mysis.cookapps.test", "u");
        assert!(keyring_core::get_default_store()
            .unwrap()
            .vendor()
            .contains("Mock"));
    }

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
            "about:srcdoc",
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
            "about:blank",
        ] {
            assert_eq!(navigation_of(&url(bad)), Navigation::Cancel, "{bad}");
        }
    }

    #[test]
    fn tauri_localhost_is_the_app_only_where_it_serves_the_app() {
        let expected = if cfg!(any(windows, target_os = "android")) {
            Navigation::Allow
        } else {
            Navigation::Browser
        };
        assert_eq!(navigation_of(&url("http://tauri.localhost/")), expected);
    }
}
