//! A-34: reading, read only, a file outside the worktree that ruby-lsp gave as a definition (a gem, for example).
//!
//! Only a path that the server of that (place, worktree) answered as a definition outside the worktree is read (`LspServers::knows_outside`); any other path is refused before anything is run. The way is the one the server is started by (`lsp::plan_for`, `lsp::run_on`): `cat` on this machine, `docker compose exec -T {service} cat` in the service of compose, and, for a saved environment, the same through ssh. The path is the server's own (the path inside the container for compose). Nothing is written, and nothing of the file is kept.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};
#[cfg(test)]
use ts_rs::TS;

use super::{
    plan_for, run_on, server::LspServers, shell_quote, LspLaunch, LspMethod, Route, MAX_TEXT,
};
use crate::{
    auth::config_dir,
    ssh_scratch::{failure, Ran},
};

/// The most bytes of a file that are read.
const MAX_FILE: usize = 1024 * 1024;

const NOT_KNOWN: &str = "言語サーバーが示した場所ではないので読めません";
const BAD_PATH: &str = "ファイルのパスが正しくありません";
const NO_WAY: &str = "ファイルを読む方法が見つかりません";
const NOT_READ: &str = "ファイルを読めません";
const TOO_LARGE: &str = "ファイルが大きすぎて読めません";
const NOT_UTF8: &str = "ファイルが UTF-8 ではありません";

/// A file outside the worktree, as the server sees it. `path` is the one asked for.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspOutsideFile {
    pub path: String,
    pub text: String,
}

/// The path of a file that may be read: absolute, not starting with `-`, no control character, no `.` or `..` or empty name between the slashes (the server's paths have none), and not longer than a setting.
fn check_path(path: &str) -> Result<(), String> {
    let ok = path.starts_with('/')
        && path.len() > 1
        && path.chars().count() <= MAX_TEXT
        && !path.chars().any(char::is_control)
        && path[1..]
            .split('/')
            .all(|name| !name.is_empty() && name != "." && name != "..");
    if ok {
        Ok(())
    } else {
        Err(BAD_PATH.into())
    }
}

/// The command, run in the worktree, that prints the file `path` of the server's side: `docker compose exec -T {service} cat -- {path}` when the server runs in a service of compose, `cat -- {path}` when it runs on the host, and none when there is no way decided. The service and the path are quoted, and `--` ends the options of `cat`.
fn cat_command(launch: &LspLaunch, path: &str) -> Result<String, String> {
    check_path(path)?;
    let path = shell_quote(path);
    match (launch.method, launch.service.as_deref()) {
        (LspMethod::Compose, Some(service)) => Ok(format!(
            "docker compose exec -T {} cat -- {path}",
            shell_quote(service)
        )),
        (LspMethod::Host, _) => Ok(format!("cat -- {path}")),
        _ => Err(NO_WAY.into()),
    }
}

/// The text that `cat` printed: only when it ended well, within the limit, and as UTF-8.
fn text_of(ran: Ran) -> Result<String, String> {
    if ran.code != Some(0) {
        return Err(failure(&ran, NOT_READ));
    }
    if ran.stdout.len() > MAX_FILE {
        return Err(TOO_LARGE.into());
    }
    String::from_utf8(ran.stdout).map_err(|_| NOT_UTF8.into())
}

/// The text of the file `path` of the server's side, for the worktree `worktree` of the project `project` of `environment`, read by `run` (a command, its folder's route and the most bytes to keep) the way the server is started there. It does not ask whether the server gave `path`.
fn read_outside(
    dir: &Path,
    environment: Option<&str>,
    project: &str,
    worktree: &str,
    path: &str,
    mut run: impl FnMut(&Route, &str, &str, usize) -> Result<Ran, String>,
) -> Result<String, String> {
    check_path(path)?;
    let (route, launch) = plan_for(dir, environment, project, worktree, &mut run)?;
    let command = cat_command(&launch, path)?;
    text_of(run(&route, worktree, &command, MAX_FILE + 1)?)
}

/// The text of the file `path`, outside the worktree `worktree` of the project `project` of `environment` (`None`: this machine), that ruby-lsp gave as a definition (A-34). A path that the server of that worktree did not give is refused.
#[tauri::command]
pub async fn lsp_read_outside(
    app: AppHandle,
    servers: State<'_, LspServers>,
    environment: Option<String>,
    project: String,
    worktree: String,
    path: String,
) -> Result<LspOutsideFile, String> {
    check_path(&path)?;
    if !servers
        .knows_outside(environment.as_deref(), &worktree, &path)
        .await
    {
        return Err(NOT_KNOWN.into());
    }
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let text = read_outside(
            &dir,
            environment.as_deref(),
            &project,
            &worktree,
            &path,
            run_on,
        )?;
        Ok(LspOutsideFile { path, text })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::{LspCandidate, LspRepoSettings};
    use serde_json::json;
    use std::path::PathBuf;

    const WT: &str = "/Users/x/orca/workspaces/app/feature";
    const GEM: &str = "/usr/local/bundle/gems/rack-3.1.0/lib/rack.rb";

    fn launch(method: LspMethod, service: Option<&str>) -> LspLaunch {
        LspLaunch {
            method,
            candidates: Vec::<LspCandidate>::new(),
            service: service.map(str::to_owned),
            command: None,
            mount: None,
        }
    }

    fn ran(code: i32, stdout: &[u8], stderr: &str) -> Ran {
        Ran {
            code: Some(code),
            stdout: stdout.to_vec(),
            stderr: stderr.into(),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cookapps-lsp-outside-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    // ---- the path ----

    #[test]
    fn an_absolute_path_of_names_is_readable() {
        assert_eq!(check_path(GEM), Ok(()));
        assert_eq!(check_path("/a"), Ok(()));
        assert_eq!(check_path("/a b/it's/\u{3042}.rb"), Ok(()));
        assert_eq!(check_path("/-a/b"), Ok(()));
    }

    #[test]
    fn a_path_that_is_relative_empty_or_the_root_is_refused() {
        for path in ["", "/", "a/b", "rel", "-a", "-"] {
            assert_eq!(check_path(path), Err(BAD_PATH.into()), "{path:?}");
        }
    }

    #[test]
    fn a_path_with_a_control_character_is_refused() {
        for path in ["/a\nb", "/a\tb", "/a\0b", "/a\u{7f}b", "/a\r"] {
            assert_eq!(check_path(path), Err(BAD_PATH.into()), "{path:?}");
        }
    }

    #[test]
    fn a_path_with_a_dot_name_or_an_empty_name_is_refused() {
        for path in ["/a/../b", "/..", "/a/.", "/./a", "/a//b", "/a/"] {
            assert_eq!(check_path(path), Err(BAD_PATH.into()), "{path:?}");
        }
        assert_eq!(check_path("/a/.b/..c/d."), Ok(()));
    }

    #[test]
    fn a_path_longer_than_a_setting_is_refused() {
        let long = format!("/{}", "a".repeat(MAX_TEXT));
        assert_eq!(check_path(&long), Err(BAD_PATH.into()));
        let ok = format!("/{}", "a".repeat(MAX_TEXT - 1));
        assert_eq!(check_path(&ok), Ok(()));
    }

    // ---- the command ----

    #[test]
    fn in_compose_the_file_is_read_in_the_service_that_runs_the_server() {
        assert_eq!(
            cat_command(&launch(LspMethod::Compose, Some("app")), GEM).unwrap(),
            format!("docker compose exec -T app cat -- {GEM}")
        );
    }

    #[test]
    fn on_the_host_the_file_is_read_by_cat_alone() {
        assert_eq!(
            cat_command(&launch(LspMethod::Host, None), GEM).unwrap(),
            format!("cat -- {GEM}")
        );
    }

    #[test]
    fn the_service_and_the_path_are_quoted_and_a_dash_ends_the_options_of_cat() {
        assert_eq!(
            cat_command(&launch(LspMethod::Compose, Some("a b;c")), "/x/it's $(id)").unwrap(),
            r"docker compose exec -T 'a b;c' cat -- '/x/it'\''s $(id)'"
        );
        assert_eq!(
            cat_command(&launch(LspMethod::Host, None), "/-n").unwrap(),
            "cat -- /-n"
        );
        assert_eq!(
            cat_command(&launch(LspMethod::Host, None), "/a`b`;&|>").unwrap(),
            "cat -- '/a`b`;&|>'"
        );
    }

    #[test]
    fn with_no_way_decided_or_no_service_there_is_no_command() {
        assert_eq!(
            cat_command(&launch(LspMethod::None, None), GEM),
            Err(NO_WAY.into())
        );
        assert_eq!(
            cat_command(&launch(LspMethod::Compose, None), GEM),
            Err(NO_WAY.into())
        );
    }

    #[test]
    fn a_path_that_is_refused_makes_no_command() {
        assert_eq!(
            cat_command(&launch(LspMethod::Host, None), "-n"),
            Err(BAD_PATH.into())
        );
        assert_eq!(
            cat_command(&launch(LspMethod::Host, None), "/a\nb"),
            Err(BAD_PATH.into())
        );
    }

    // ---- what cat printed ----

    #[test]
    fn what_cat_printed_is_the_text() {
        assert_eq!(
            text_of(ran(0, "# \u{3042}\nclass A; end\n".as_bytes(), "")).unwrap(),
            "# \u{3042}\nclass A; end\n"
        );
        assert_eq!(text_of(ran(0, b"", "")).unwrap(), "");
    }

    #[test]
    fn a_failure_is_an_error_with_the_last_line_of_its_message() {
        let err = text_of(ran(1, b"", "cat: /x: No such file or directory\n")).unwrap_err();
        assert_eq!(
            err,
            format!("{NOT_READ}: cat: /x: No such file or directory")
        );
        let err = text_of(ran(
            255,
            b"",
            "ssh: connect to host dev port 22: Connection refused",
        ))
        .unwrap_err();
        assert!(err.starts_with("接続できません"), "{err}");
    }

    #[test]
    fn a_file_over_the_limit_or_not_utf8_is_an_error() {
        assert_eq!(
            text_of(ran(0, &vec![b'x'; MAX_FILE], "")).unwrap().len(),
            MAX_FILE
        );
        assert_eq!(
            text_of(ran(0, &vec![b'x'; MAX_FILE + 1], "")),
            Err(TOO_LARGE.into())
        );
        assert_eq!(text_of(ran(0, &[0xff, 0xfe], "")), Err(NOT_UTF8.into()));
    }

    // ---- the whole read ----

    fn compose_config() -> String {
        json!({"services": {"app": {"volumes": [
            {"type": "bind", "source": WT, "target": "/app"}
        ]}}})
        .to_string()
    }

    #[test]
    fn the_file_is_read_in_the_service_of_compose_in_the_worktree_with_a_limit_one_over() {
        let dir = temp_dir("compose");
        let config = compose_config();
        let mut seen = Vec::new();
        let text = read_outside(
            &dir,
            None,
            "repo-1",
            WT,
            GEM,
            |route, worktree, command, limit| {
                seen.push((
                    route.clone(),
                    worktree.to_owned(),
                    command.to_owned(),
                    limit,
                ));
                Ok(if command.contains("docker compose config") {
                    ran(0, config.as_bytes(), "")
                } else if command.contains("Gemfile.lock") {
                    ran(0, b"", "")
                } else {
                    ran(0, b"module Rack; end\n", "")
                })
            },
        )
        .unwrap();
        assert_eq!(text, "module Rack; end\n");
        let last = seen.last().unwrap();
        assert_eq!(
            last,
            &(
                Route::Local,
                WT.to_owned(),
                format!("docker compose exec -T app cat -- {GEM}"),
                MAX_FILE + 1
            )
        );
        assert!(seen
            .iter()
            .all(|(route, wt, _, _)| *route == Route::Local && wt == WT));
    }

    #[test]
    fn on_the_host_it_is_cat_and_for_a_saved_environment_it_goes_through_its_ssh_host() {
        let dir = temp_dir("ssh");
        crate::lsp::set_settings(
            &dir,
            LspRepoSettings {
                ssh_host: Some("dev".into()),
                ..LspRepoSettings::unset(Some("srv"), "repo-1")
            },
        )
        .unwrap();
        let mut seen = Vec::new();
        let text = read_outside(
            &dir,
            Some("srv"),
            "repo-1",
            WT,
            GEM,
            |route, _, command, _| {
                seen.push((route.clone(), command.to_owned()));
                Ok(if command.contains("Gemfile.lock") {
                    ran(0, b"DEPENDENCIES\n  ruby-lsp\n", "")
                } else if command.starts_with("cat -- ") {
                    ran(0, b"x = 1\n", "")
                } else {
                    ran(0, b"", "")
                })
            },
        )
        .unwrap();
        assert_eq!(text, "x = 1\n");
        assert_eq!(
            seen.last().unwrap(),
            &(Route::Ssh { host: "dev".into() }, format!("cat -- {GEM}"))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_refused_path_runs_nothing() {
        let dir = temp_dir("refused");
        let mut runs = 0;
        let err = read_outside(&dir, None, "repo-1", WT, "-n", |_, _, _, _| {
            runs += 1;
            Ok(ran(0, b"", ""))
        })
        .unwrap_err();
        assert_eq!(err, BAD_PATH);
        assert_eq!(runs, 0);
    }

    #[test]
    fn a_worktree_with_no_way_to_start_the_server_reads_nothing() {
        let dir = temp_dir("noway");
        let mut commands = Vec::new();
        let err = read_outside(&dir, None, "repo-1", WT, GEM, |_, _, command, _| {
            commands.push(command.to_owned());
            Ok(ran(0, b"", ""))
        })
        .unwrap_err();
        assert_eq!(err, NO_WAY);
        assert!(
            commands.iter().all(|c| !c.contains("cat -- ")),
            "{commands:?}"
        );
    }

    #[test]
    fn a_failed_run_is_told() {
        let dir = temp_dir("failed");
        let err = read_outside(&dir, None, "repo-1", WT, GEM, |_, _, _, _| {
            Err("ssh を実行できません".into())
        })
        .unwrap_err();
        assert_eq!(err, "ssh を実行できません");
    }
}
