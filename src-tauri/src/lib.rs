pub mod accounts;
pub mod app_log;
pub mod auth;
pub mod calendar;
pub mod claude;
pub mod claude_auth;
mod disk_cache;
pub mod fonts;
pub mod ghostty;
pub mod gmail;
pub mod image_senders;
pub mod images;
pub mod mail_address;
pub mod markdown_patch;
pub mod notion;
pub mod orca;
pub mod orca_attach;
pub mod orca_diff;
pub mod orca_e2ee;
pub mod orca_files;
pub mod orca_handoff;
pub mod orca_language;
pub mod orca_link;
pub mod orca_panes;
pub mod orca_stream;
pub mod orca_theme;
pub mod skills;
pub mod slack;
mod slack_blocks;
mod slack_emoji;
mod slack_markdown;
mod slack_mrkdwn;
pub mod todoist;
pub mod update;

use std::{sync::Mutex, time::Duration};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Where ts-rs writes the types the frontend shares (`#[ts(export_to = crate::BINDINGS)]`), on `cargo test`.
/// An absolute path, so the default `./bindings` directory is not created next to it.
#[cfg(test)]
const BINDINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../ts/bindings/");

// tao's macOS backend shows `Some(0)` as "0", so no unread must be `None`.
fn badge_of(count: u32) -> Option<i64> {
    (count > 0).then_some(i64::from(count))
}

/// The label of the window the badge belongs to (Tauri's default for the first window).
const MAIN_WINDOW: &str = "main";
/// How often the Dock badge is checked against the clock. A due moment is noticed up to this late.
const BADGE_CHECK: Duration = Duration::from_secs(15);

/// What the Dock badge is made of: the count of what is due or unread now (`count`), and the due moments (epoch milliseconds) of the open tasks that are still ahead (`upcoming`).
/// The screen sends it when either changes; Rust counts the moments that pass meanwhile, so the badge follows the clock when the WebView's timers are suspended.
#[derive(Default)]
struct Badge {
    count: u32,
    upcoming: Vec<i64>,
    /// What was last set on the Dock (`Some(None)` is a removed badge); `None` before the first time.
    shown: Option<Option<i64>>,
}

/// The number to show at `now_ms`: `count` plus the `upcoming` moments that have come.
fn badge_total(count: u32, upcoming: &[i64], now_ms: i64) -> u32 {
    let passed = upcoming.iter().filter(|&&at| at <= now_ms).count();
    count.saturating_add(u32::try_from(passed).unwrap_or(u32::MAX))
}

/// Sets the Dock badge to what `Badge` makes of the clock now, only when that differs from what is shown.
/// Windows has no badge count (tao ignores it), so this does nothing visible there.
fn apply_badge(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<Badge>>();
    let mut badge = state.lock().unwrap();
    let value = badge_of(badge_total(
        badge.count,
        &badge.upcoming,
        chrono::Utc::now().timestamp_millis(),
    ));
    if badge.shown == Some(value) {
        return Ok(());
    }
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("ウィンドウが見つかりません")?;
    window.set_badge_count(value).map_err(|e| e.to_string())?;
    badge.shown = Some(value);
    Ok(())
}

/// Takes the count and the coming due moments from the screen and shows the Dock badge for them; 0 removes it.
#[tauri::command]
fn set_badge(
    app: AppHandle,
    state: State<'_, Mutex<Badge>>,
    count: u32,
    upcoming: Vec<i64>,
) -> Result<(), String> {
    {
        let mut badge = state.lock().unwrap();
        badge.count = count;
        badge.upcoming = upcoming;
    }
    apply_badge(&app)
}

/// Checks the badge against the wall clock every `BADGE_CHECK`, whether or not the window is shown or its page runs timers.
/// The clock is read each time (not slept until the next moment), so a machine that slept notices the moments that passed at the next check.
fn start_badge_clock(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(BADGE_CHECK);
        loop {
            tick.tick().await;
            if let Err(e) = apply_badge(&app) {
                gmail::log_failure("badge", "-", e);
            }
        }
    });
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
        .plugin(tauri_plugin_wdio_webdriver::init());
    #[cfg(feature = "e2e")]
    use_mock_keyring();
    builder
        .plugin(tauri_plugin_dialog::init())
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
        .manage(notion::NotionState::default())
        .manage(std::sync::Mutex::new(None::<tauri_plugin_updater::Update>))
        .manage(update::Installed::default())
        .manage(orca::OrcaMirror::default())
        .manage(orca_stream::OrcaStream::default())
        .manage(Mutex::new(Badge::default()))
        .setup(|app| {
            // No Dock icon, and no focus taken from the developer's apps while the E2E run drives the window.
            #[cfg(all(feature = "e2e", target_os = "macos"))]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            start_badge_clock(app.handle().clone());
            tauri::async_runtime::spawn(slack::socket::start_all(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::login,
            auth::remove_account,
            calendar::calendar_week,
            calendar::calendar_cached,
            calendar::calendar_first_day,
            calendar::set_calendar_first_day,
            calendar::calendar_month,
            calendar::calendar_choices,
            calendar::set_calendar_shown,
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
            todoist::todoist_connected,
            todoist::todoist_save_token,
            todoist::todoist_disconnect,
            todoist::todoist_add,
            todoist::todoist_add_subtask,
            todoist::todoist_task_from_mail,
            todoist::todoist_summarize_slack,
            todoist::todoist_add_from_slack,
            todoist::todoist_add_task,
            todoist::todoist_set_done,
            todoist::todoist_update,
            todoist::todoist_picked_due,
            todoist::todoist_create_label,
            todoist::todoist_move,
            todoist::todoist_move_under,
            todoist::todoist_delete,
            todoist::todoist_comments,
            todoist::todoist_upload,
            todoist::todoist_add_comment,
            todoist::todoist_open,
            slack::slack_load,
            slack::slack_check,
            slack::slack_add_workspace,
            slack::slack_remove_workspace,
            slack::slack_channels,
            slack::slack_link,
            slack::slack_preview,
            slack::slack_post,
            slack::slack_timeline,
            slack::slack_mark_read,
            slack::slack_watch,
            slack::slack_unwatch,
            slack::slack_watch_seen,
            slack::slack_thread_seen,
            slack::slack_hidden_list,
            slack::slack_hide_channel,
            slack::slack_side_folded,
            slack::slack_set_side_folded,
            slack::slack_unhide_channel,
            slack::slack_thread,
            slack::slack_channel_history,
            slack::slack_channel_post,
            slack::slack_reply,
            slack::slack_react,
            slack::slack_emoji_catalog,
            slack::slack_file_images,
            slack::slack_icons,
            slack::socket::slack_app_token_set,
            slack::socket::slack_app_token_remove,
            slack::socket::slack_socket_status,
            notion::notion_accounts,
            notion::notion_connect,
            notion::notion_disconnect,
            claude::claude_status,
            claude::claude_connection,
            claude::claude_key_save,
            claude::claude_method_set,
            claude::claude_key_delete,
            claude::claude_summarize_mail,
            claude::claude_todo_prompt,
            claude::claude_todo_prompt_save,
            claude::claude_todo_prompt_reset,
            claude::claude_model_settings,
            claude::claude_model_settings_save,
            claude::claude_edit_todo_prompt,
            claude::claude_edit_todo_draft,
            claude::claude_summarize_handoff,
            claude::claude_chat_todo,
            claude::claude_chat_slack,
            claude::claude_proofread_slack,
            claude::claude_chat_thread,
            orca::orca_overview,
            orca::orca_destination,
            orca::orca_set_target,
            orca::orca_send,
            orca::orca_start,
            orca::orca_terminal_create,
            orca::orca_worktree_create,
            orca::orca_handoff,
            orca::orca_close,
            orca::orca_terminal_read,
            orca::orca_terminal_input,
            orca::orca_open_url,
            orca_attach::orca_attach_file,
            orca_stream::orca_stream_open,
            orca_stream::orca_stream_close,
            orca_stream::orca_stream_terminal,
            orca_stream::orca_stream_terminal_close,
            orca_stream::orca_stream_viewport,
            orca_stream::orca_stream_input,
            orca_panes::orca_panes,
            orca_files::orca_files_list,
            orca_files::orca_files_ignored,
            orca_files::orca_file_read,
            orca_files::orca_file_write,
            orca_files::orca_file_download,
            orca_files::orca_file_diff,
            orca_files::orca_local_branches,
            orca_files::orca_remote_branches,
            orca_files::orca_switch_branch,
            orca_files::orca_git_history,
            orca_files::orca_commit_files,
            orca_files::orca_commit_file_diff,
            orca_files::editor_settings,
            orca_files::editor_settings_set,
            fonts::font_settings,
            fonts::font_families,
            fonts::font_settings_set,
            skills::skill_list,
            skills::skill_get,
            skills::skill_save,
            skills::skill_delete,
            markdown_patch::markdown_split,
            markdown_patch::markdown_patch,
            ghostty::ghostty_saved,
            ghostty::ghostty_import,
            orca_theme::terminal_themes,
            orca_theme::terminal_theme_set,
            app_log::log_write,
            app_log::log_read,
            update::app_info,
            update::update_mode,
            update::set_update_mode,
            update::check_update,
            update::install_update,
            update::restart_app,
            set_badge
        ])
        .build(tauri::generate_context!())
        .expect("failed to build tauri application")
        .run(|_, _| {});
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

    use super::{badge_of, badge_total, navigation_of, Navigation};

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
    fn the_badge_adds_the_moments_that_have_come() {
        let upcoming = [1_000, 2_000, 2_000, 5_000];
        assert_eq!(badge_total(3, &upcoming, 999), 3);
        // A moment counts from the very millisecond it is.
        assert_eq!(badge_total(3, &upcoming, 1_000), 4);
        assert_eq!(badge_total(3, &upcoming, 2_500), 6);
        assert_eq!(badge_total(0, &upcoming, 9_000), 4);
        assert_eq!(badge_total(0, &[], 9_000), 0);
    }

    #[test]
    fn the_badge_total_does_not_overflow() {
        assert_eq!(badge_total(u32::MAX, &[0], 1), u32::MAX);
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
