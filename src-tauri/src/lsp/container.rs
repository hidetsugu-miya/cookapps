//! A-34: starting the container of the service that a language server runs in, when it does not run (the state `containerDown`).
//!
//! The app never starts a container by itself: this runs only when the owner presses 「コンテナを起動」. The way of the server named in the call is read from the worktree again (`lsp::plan_for`, the settings of the server applied) and the command is `docker compose up -d {service}`, run in the worktree by the route the server is started by (`run_on`): this machine's `/bin/sh -c`, or, for a saved environment, the ssh in front. Only the method `compose` has a container; any other method, even with a `command` in the settings, is an error before anything is run. The screen starts the server again once this has ended.

use std::{path::Path, time::Duration};

use tauri::AppHandle;

use super::{
    check_server, check_worktree, plan_for, run_on, shell_quote, spawn_of, LspLaunch, LspMethod,
    Route,
};
use crate::{
    auth::config_dir,
    orca_files::check_worktree_of_project,
    ssh::{failure, run_process, shared_control, Ran},
};

/// Longer than the reads of the worktree: `docker compose up -d` may pull an image or wait for a health check.
const UP_TIMEOUT: Duration = Duration::from_secs(180);
/// The most bytes of the output that are kept (the message takes the last line of the standard error, so nothing of the output is needed).
const UP_OUTPUT: usize = 4096;

const NO_CONTAINER: &str = "コンテナを起動する方法が見つかりません";
const NOT_UP: &str = "コンテナを起動できません";

/// The command, run in the worktree, that starts the container of the service the server runs in: `docker compose up -d {service}`, with the service quoted. Only for the method `compose` with a service.
fn up_command(launch: &LspLaunch) -> Result<String, String> {
    match (launch.method, launch.service.as_deref()) {
        (LspMethod::Compose, Some(service)) => {
            Ok(format!("docker compose up -d {}", shell_quote(service)))
        }
        _ => Err(NO_CONTAINER.into()),
    }
}

/// Whether `docker compose up -d` ended well; else its message, with the last line of what it printed (ssh's own failure is told as a failed connection).
fn up_result(ran: &Ran) -> Result<(), String> {
    if ran.code == Some(0) {
        Ok(())
    } else {
        Err(failure(ran, NOT_UP))
    }
}

/// Starts the container of the server `server` for the worktree `worktree` of the project `project` of `environment`. `read` runs the commands that decide the way (as `lsp::launches_for` does) and `up` runs the start; each is given the route, the worktree, the command and the most bytes to keep.
fn start_container(
    dir: &Path,
    environment: Option<&str>,
    project: &str,
    worktree: &str,
    server: &str,
    read: impl FnMut(&Route, &str, &str, usize) -> Result<Ran, String>,
    mut up: impl FnMut(&Route, &str, &str, usize) -> Result<Ran, String>,
) -> Result<(), String> {
    let planned = plan_for(dir, environment, project, worktree, server, read)?;
    let command = up_command(&planned.launch)?;
    up_result(&up(&planned.route, worktree, &command, UP_OUTPUT)?)
}

/// `run_on` with the time that a start of a container is given.
fn run_up(route: &Route, worktree: &str, command: &str, limit: usize) -> Result<Ran, String> {
    let control = match route {
        Route::Local => None,
        Route::Ssh { .. } => shared_control(),
    };
    let spawn = spawn_of(route, worktree, command, control.as_deref());
    run_process(&spawn.program, &spawn.args, Vec::new(), limit, UP_TIMEOUT)
}

/// Starts the container of the service that the server `server` runs in for `worktree` of the project `project` of `environment` (`None`: this machine): `docker compose up -d {service}` (A-34). The server is not started here.
#[tauri::command]
pub async fn lsp_container_start(
    app: AppHandle,
    environment: Option<String>,
    project: String,
    worktree: String,
    server: String,
) -> Result<(), String> {
    check_server(&server)?;
    check_worktree(&worktree)?;
    check_worktree_of_project(&worktree, environment.as_deref(), &project).await?;
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        start_container(
            &dir,
            environment.as_deref(),
            &project,
            &worktree,
            &server,
            run_on,
            run_up,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::{set_settings, LspRepoSettings, LspServerSettings};
    use serde_json::json;
    use std::path::PathBuf;

    const WT: &str = "/Users/x/orca/workspaces/app/feature";

    fn launch(method: LspMethod, service: Option<&str>) -> LspLaunch {
        LspLaunch {
            method,
            candidates: Vec::new(),
            service: service.map(str::to_owned),
            command: Some("bundle exec ruby-lsp".into()),
            mount: None,
        }
    }

    fn ran(code: i32, stdout: &str, stderr: &str) -> Ran {
        Ran {
            code: Some(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.into(),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-lsp-container-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn compose_config() -> String {
        json!({"services": {"app": {"volumes": [
            {"type": "bind", "source": WT, "target": "/app"}
        ]}}})
        .to_string()
    }

    // ---- the command ----

    #[test]
    fn the_container_of_the_service_is_started_detached() {
        assert_eq!(
            up_command(&launch(LspMethod::Compose, Some("app"))).unwrap(),
            "docker compose up -d app"
        );
    }

    #[test]
    fn the_service_is_quoted() {
        assert_eq!(
            up_command(&launch(LspMethod::Compose, Some("a b;$(id)"))).unwrap(),
            "docker compose up -d 'a b;$(id)'"
        );
        assert_eq!(
            up_command(&launch(LspMethod::Compose, Some("it's"))).unwrap(),
            r"docker compose up -d 'it'\''s'"
        );
    }

    #[test]
    fn only_the_method_compose_has_a_container() {
        for method in [LspMethod::Host, LspMethod::None] {
            assert_eq!(
                up_command(&launch(method, Some("app"))),
                Err(NO_CONTAINER.into())
            );
        }
        assert_eq!(
            up_command(&launch(LspMethod::Compose, None)),
            Err(NO_CONTAINER.into())
        );
    }

    // ---- the end of the command ----

    #[test]
    fn a_command_that_ended_well_is_done() {
        assert_eq!(
            up_result(&ran(0, "", " Container app-1  Started\n")),
            Ok(())
        );
    }

    #[test]
    fn a_failure_is_told_with_the_last_line_of_its_message() {
        let err = up_result(&ran(
            1,
            "",
            "Network app_default  Creating\nError response from daemon: port is already allocated\n",
        ))
        .unwrap_err();
        assert_eq!(
            err,
            format!("{NOT_UP}: Error response from daemon: port is already allocated")
        );
        assert_eq!(up_result(&ran(1, "", "")), Err(NOT_UP.to_owned()));
    }

    #[test]
    fn ssh_own_failure_is_told_as_a_failed_connection() {
        let err = up_result(&ran(
            255,
            "",
            "ssh: connect to host dev port 22: Connection refused",
        ))
        .unwrap_err();
        assert!(err.starts_with("接続できません"), "{err}");
    }

    // ---- the whole start ----

    #[test]
    fn it_reads_the_way_and_then_starts_the_service_in_the_worktree_on_this_machine() {
        let dir = temp_dir("local");
        let config = compose_config();
        let mut read = Vec::new();
        let mut upped = Vec::new();
        let result = start_container(
            &dir,
            None,
            "repo-1",
            WT,
            "ruby-lsp",
            |route, worktree, command, _| {
                read.push((route.clone(), worktree.to_owned()));
                Ok(if command.contains("docker compose config") {
                    ran(0, &config, "")
                } else {
                    ran(0, "", "")
                })
            },
            |route, worktree, command, limit| {
                upped.push((
                    route.clone(),
                    worktree.to_owned(),
                    command.to_owned(),
                    limit,
                ));
                Ok(ran(0, "", ""))
            },
        );
        assert_eq!(result, Ok(()));
        assert_eq!(
            upped,
            vec![(
                Route::Local,
                WT.to_owned(),
                "docker compose up -d app".to_owned(),
                UP_OUTPUT
            )]
        );
        assert!(read
            .iter()
            .all(|(route, worktree)| *route == Route::Local && worktree == WT));
    }

    #[test]
    fn the_service_of_the_settings_is_the_one_started_and_a_saved_environment_goes_through_its_ssh_host(
    ) {
        let dir = temp_dir("ssh");
        set_settings(
            &dir,
            LspRepoSettings {
                ssh_host: Some("dev".into()),
                servers: vec![LspServerSettings {
                    service: Some("worker".into()),
                    ..LspServerSettings::ruby_lsp()
                }],
                ..LspRepoSettings::unset(Some("srv"), "repo-1")
            },
        )
        .unwrap();
        let config = json!({"services": {
            "app": {"volumes": [{"type": "bind", "source": WT, "target": "/app"}]},
            "worker": {"volumes": [{"type": "bind", "source": WT, "target": "/app"}]},
        }})
        .to_string();
        let mut upped = Vec::new();
        start_container(
            &dir,
            Some("srv"),
            "repo-1",
            WT,
            "ruby-lsp",
            |_, _, command, _| {
                Ok(if command.contains("docker compose config") {
                    ran(0, &config, "")
                } else {
                    ran(0, "", "")
                })
            },
            |route, _, command, _| {
                upped.push((route.clone(), command.to_owned()));
                Ok(ran(0, "", ""))
            },
        )
        .unwrap();
        assert_eq!(
            upped,
            vec![(
                Route::Ssh { host: "dev".into() },
                "docker compose up -d worker".to_owned()
            )]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_server_that_does_not_take_ruby_starts_the_container_of_its_service_all_the_same() {
        let dir = temp_dir("other-server");
        set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![LspServerSettings {
                    name: "ts".into(),
                    languages: vec!["typescript".into()],
                    command: Some(
                        "docker compose exec -T app typescript-language-server --stdio".into(),
                    ),
                    ..LspServerSettings::ruby_lsp()
                }],
                ..LspRepoSettings::unset(None, "repo-1")
            },
        )
        .unwrap();
        let config = compose_config();
        let mut upped = Vec::new();
        start_container(
            &dir,
            None,
            "repo-1",
            WT,
            "ts",
            |_, _, command, _| {
                Ok(if command.contains("docker compose config") {
                    ran(0, &config, "")
                } else {
                    ran(0, "", "")
                })
            },
            |_, _, command, _| {
                upped.push(command.to_owned());
                Ok(ran(0, "", ""))
            },
        )
        .unwrap();
        assert_eq!(upped, vec!["docker compose up -d app".to_owned()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_worktree_with_no_compose_service_starts_nothing() {
        let dir = temp_dir("none");
        let mut runs = 0;
        let err = start_container(
            &dir,
            None,
            "repo-1",
            WT,
            "ruby-lsp",
            |_, _, command, _| {
                Ok(if command.contains("Gemfile.lock") {
                    ran(0, "DEPENDENCIES\n  ruby-lsp\n", "")
                } else {
                    ran(0, "", "")
                })
            },
            |_, _, _, _| {
                runs += 1;
                Ok(ran(0, "", ""))
            },
        )
        .unwrap_err();
        assert_eq!(err, NO_CONTAINER);
        assert_eq!(runs, 0);
    }

    #[test]
    fn a_failed_start_and_a_run_that_cannot_be_made_are_told() {
        let dir = temp_dir("failed");
        let config = compose_config();
        let read = |_: &Route, _: &str, command: &str, _: usize| -> Result<Ran, String> {
            Ok(if command.contains("docker compose config") {
                ran(0, &config, "")
            } else {
                ran(0, "", "")
            })
        };
        let err = start_container(&dir, None, "repo-1", WT, "ruby-lsp", read, |_, _, _, _| {
            Ok(ran(1, "", "no such service: app"))
        })
        .unwrap_err();
        assert_eq!(err, format!("{NOT_UP}: no such service: app"));
        let err = start_container(&dir, None, "repo-1", WT, "ruby-lsp", read, |_, _, _, _| {
            Err("ssh を実行できません".into())
        })
        .unwrap_err();
        assert_eq!(err, "ssh を実行できません");
    }
}
