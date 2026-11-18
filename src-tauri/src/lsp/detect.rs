//! A-34: finding the language servers that a worktree can have, from the table of the languages the app knows (the files that mark a language, and the commands of its servers).
//!
//! One read of the worktree answers all of it: a script of `sh` that prints a line for each mark file that is there (`mark {file}`), for each command of the table that exists (`have {command}`: `command -v` on the host, or the file of `node_modules/.bin`) and for each line of the `Gemfile.lock` that holds `ruby-lsp` (`lock {line}`). It is run in the worktree on the route of the project (this machine, or the ssh in front), and, when a service of compose mounts the worktree, again by `docker compose exec -T` in the service, where the server would run (the container that does not run is told as `containerDown`). What the script printed is read by `parse_probe` and `found_from`, which are pure.
//! The start of a server of a language whose settings hold no `command` uses the same table and the same script (`auto_command`), without the marks.

use std::collections::HashMap;

use serde::Serialize;
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use super::{
    candidates, check_worktree, choose, collect, has_ruby_lsp, route_of, run_on, settings_of,
    shell_quote, Launch, LspCandidate, LspServerSettings, Route, READ_MAX, RUBY,
};
use crate::{
    auth::config_dir,
    orca_files::check_worktree_of_project,
    ssh::{failure, Ran},
};

const NOT_PROBED: &str = "言語サーバーを調べられません";
const TOO_LARGE: &str = "言語サーバーの調べが大きすぎます";
const NOT_UTF8: &str = "言語サーバーの調べが UTF-8 ではありません";

/// A server of the table: `name` is how the screen calls it, `probe` the test (a shell condition, run in the worktree) that the command exists, none when it is not tested (ruby-lsp: the `Gemfile.lock` says it), and `command` what is run to start it.
pub(crate) struct Tool {
    pub name: &'static str,
    pub probe: Option<&'static str>,
    pub command: &'static str,
}

/// A language of the table: the files whose presence says that the worktree has it, and its servers in the order they are tried.
pub(crate) struct Known {
    pub language: &'static str,
    pub marks: &'static [&'static str],
    pub tools: &'static [Tool],
}

const TYPESCRIPT_SERVERS: &[Tool] = &[
    Tool {
        name: "typescript-language-server",
        probe: Some("[ -x node_modules/.bin/typescript-language-server ]"),
        command: "node_modules/.bin/typescript-language-server --stdio",
    },
    Tool {
        name: "typescript-language-server",
        probe: Some("command -v typescript-language-server"),
        command: "typescript-language-server --stdio",
    },
];

/// The table (A-34), in the order the screen shows it. A ruby-lsp that the `Gemfile.lock` lists is the mark of ruby; the other languages are marked by their files.
pub(crate) const TABLE: &[Known] = &[
    Known {
        language: RUBY,
        marks: &["Gemfile.lock"],
        tools: &[Tool {
            name: "ruby-lsp",
            probe: None,
            command: "bundle exec ruby-lsp",
        }],
    },
    Known {
        language: "rust",
        marks: &["Cargo.toml"],
        tools: &[Tool {
            name: "rust-analyzer",
            probe: Some("command -v rust-analyzer"),
            command: "rust-analyzer",
        }],
    },
    Known {
        language: "typescript",
        marks: &["package.json", "tsconfig.json"],
        tools: TYPESCRIPT_SERVERS,
    },
    Known {
        language: "javascript",
        marks: &["package.json", "tsconfig.json"],
        tools: TYPESCRIPT_SERVERS,
    },
    Known {
        language: "go",
        marks: &["go.mod"],
        tools: &[Tool {
            name: "gopls",
            probe: Some("command -v gopls"),
            command: "gopls",
        }],
    },
    Known {
        language: "python",
        marks: &["pyproject.toml", "requirements.txt"],
        tools: &[
            Tool {
                name: "pyright",
                probe: Some("command -v pyright-langserver"),
                command: "pyright-langserver --stdio",
            },
            Tool {
                name: "pylsp",
                probe: Some("command -v pylsp"),
                command: "pylsp",
            },
        ],
    },
];

/// The row of the table for `language`.
pub(crate) fn known(language: &str) -> Option<&'static Known> {
    TABLE.iter().find(|known| known.language == language)
}

impl Known {
    /// The name the screen gives the server of this language when its settings have none: the name of the first server of the table.
    pub(crate) fn default_name(&self) -> &'static str {
        self.tools[0].name
    }

    /// Whether the command has to be looked for (a server with no `probe` has the one command, and nothing is asked of the worktree).
    fn needs_probe(&self) -> bool {
        self.tools.iter().any(|tool| tool.probe.is_some())
    }

    /// The server to start, from what the place answered: the first of the table that exists there. In a container that does not run nothing can be asked, so the first one is taken, and the start says that the container is down.
    fn pick(&self, reach: &Reach) -> Option<&'static Tool> {
        match reach {
            Reach::Down => self.tools.first(),
            Reach::Up(probe) => self.tools.iter().find(|tool| {
                tool.probe.is_none() || probe.have.iter().any(|have| have == tool.command)
            }),
        }
    }
}

/// Where a server is looked for and run: on the host of the worktree, or in a service of compose with the path the worktree has there.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Place {
    Host,
    Compose { service: String, mount: String },
}

/// What the script printed.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Probe {
    marks: Vec<String>,
    have: Vec<String>,
    lock: String,
}

/// What a place answered: the container does not run (`Down`), or the script ran.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Reach {
    Down,
    Up(Probe),
}

/// The script, for `sh -c`, that prints what `parse_probe` reads. With `marks` it also tells which mark files are there and the lines of the `Gemfile.lock` that hold ruby-lsp. Only text of the table is in it.
fn probe_script(marks: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    if marks {
        let mut seen: Vec<&str> = Vec::new();
        for mark in TABLE.iter().flat_map(|known| known.marks) {
            if !seen.contains(mark) {
                seen.push(mark);
                parts.push(format!(
                    "if [ -f {mark} ]; then printf '%s\\n' 'mark {mark}'; fi"
                ));
            }
        }
        parts.push(
            "if [ -f Gemfile.lock ]; then grep ruby-lsp Gemfile.lock | sed 's/^/lock /'; fi"
                .to_owned(),
        );
    }
    let mut seen: Vec<&str> = Vec::new();
    for tool in TABLE.iter().flat_map(|known| known.tools) {
        if let Some(probe) = tool.probe {
            if !seen.contains(&tool.command) {
                seen.push(tool.command);
                parts.push(format!(
                    "if {probe} >/dev/null 2>&1; then printf '%s\\n' 'have {}'; fi",
                    tool.command
                ));
            }
        }
    }
    format!("{{ {}; true; }}", parts.join("; "))
}

/// What the script printed, as `Probe`. A line it does not know is left out.
fn parse_probe(text: &str) -> Probe {
    let mut probe = Probe::default();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(mark) = line.strip_prefix("mark ") {
            probe.marks.push(mark.to_owned());
        } else if let Some(command) = line.strip_prefix("have ") {
            probe.have.push(command.to_owned());
        } else if let Some(rest) = line.strip_prefix("lock ") {
            probe.lock.push_str(rest);
            probe.lock.push('\n');
        }
    }
    probe
}

/// Runs the script in `place`: `run` runs a command in the worktree on its route. A container that does not run is `Reach::Down`; any other failure is an error.
pub(crate) fn probe(
    run: &mut impl FnMut(&str, usize) -> Result<Ran, String>,
    place: &Place,
    marks: bool,
) -> Result<Reach, String> {
    let script = probe_script(marks);
    let command = match place {
        Place::Host => script,
        Place::Compose { service, mount } => format!(
            "docker compose exec -T -w {} {} sh -c {}",
            shell_quote(mount),
            shell_quote(service),
            shell_quote(&script)
        ),
    };
    let ran = run(&command, READ_MAX + 1)?;
    if ran.code != Some(0) {
        if matches!(place, Place::Compose { .. }) && super::server::container_down(&ran.stderr) {
            return Ok(Reach::Down);
        }
        return Err(failure(&ran, NOT_PROBED));
    }
    if ran.stdout.len() > READ_MAX {
        return Err(TOO_LARGE.into());
    }
    let text = String::from_utf8(ran.stdout).map_err(|_| NOT_UTF8)?;
    Ok(Reach::Up(parse_probe(&text)))
}

/// The command that starts the server of `settings` when its settings have none, as the table says (without the `docker compose exec` in front, which `resolve` puts on): none for a language that is not in the table, for a way that is not decided (`Launch::Unavailable`), and when the settings have a command. `cache` keeps what each place answered, so that servers of one worktree ask it once.
pub(crate) fn auto_command(
    run: &mut impl FnMut(&str, usize) -> Result<Ran, String>,
    launch: &Launch,
    settings: &LspServerSettings,
    cache: &mut HashMap<Place, Reach>,
) -> Result<Option<String>, String> {
    if settings.command.is_some() {
        return Ok(None);
    }
    let Some(known) = known(&settings.language) else {
        return Ok(None);
    };
    let place = match launch {
        Launch::Compose(found) => match choose(found, settings) {
            Some(chosen) => Place::Compose {
                service: chosen.service.clone(),
                mount: chosen.mount.clone(),
            },
            None => return Ok(None),
        },
        Launch::Host => Place::Host,
        Launch::Unavailable => return Ok(None),
    };
    if !known.needs_probe() {
        return Ok(known.tools.first().map(|tool| tool.command.to_owned()));
    }
    if !cache.contains_key(&place) {
        let reach = probe(run, &place, false)?;
        cache.insert(place.clone(), reach);
    }
    Ok(known
        .pick(&cache[&place])
        .map(|tool| tool.command.to_owned()))
}

// ---- what the screen gets ----

/// Where the server found would run: on the host, or in a service of compose.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LspFoundPlace {
    Host,
    Compose { service: String },
}

/// What was found for a language: `found` (a server of the table exists there), `missing` (the language is in the worktree and no server of the table is), `containerDown` (the service that mounts the worktree does not run, so nothing could be asked).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum LspFoundState {
    Found,
    Missing,
    ContainerDown,
}

/// A language that the worktree has, with the server the table gives it: its `name`, the `command` to run in the worktree (with the `docker compose exec` in front when it runs in a service; none unless `found`), the `place` it runs in and the `mount`, the path that the worktree has there (the worktree's own path on the host).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspFound {
    pub language: String,
    pub name: String,
    #[cfg_attr(test, ts(optional = nullable))]
    pub command: Option<String>,
    pub place: LspFoundPlace,
    pub mount: String,
    pub state: LspFoundState,
}

/// Whether `known` is in the worktree: ruby by a `Gemfile.lock` that lists ruby-lsp, the others by one of their files.
fn marked(known: &Known, host: &Probe) -> bool {
    if known.language == RUBY {
        has_ruby_lsp(&host.lock)
    } else {
        known
            .marks
            .iter()
            .any(|mark| host.marks.iter().any(|seen| seen == mark))
    }
}

/// The languages of the table that the worktree has (`host`: what the script printed on the host) and the server each has. The servers run in the first service of `compose` (the services that mount the worktree) when there is one, and `container` is what that service answered; else on the host. The marks are the files of the worktree, which the service mounts, so they are read once, on the host.
pub(crate) fn found_from(
    worktree: &str,
    compose: &[LspCandidate],
    host: &Probe,
    container: Option<&Reach>,
) -> Vec<LspFound> {
    let service = compose.first();
    TABLE
        .iter()
        .filter(|known| marked(known, host))
        .map(|known| {
            let (place, mount, reach) = match (service, container) {
                (Some(candidate), Some(reach)) => (
                    LspFoundPlace::Compose {
                        service: candidate.service.clone(),
                    },
                    candidate.mount.clone(),
                    reach.clone(),
                ),
                _ => (
                    LspFoundPlace::Host,
                    worktree.to_owned(),
                    Reach::Up(host.clone()),
                ),
            };
            let tool = known.pick(&reach);
            let (name, command, state) = match (&reach, tool) {
                (Reach::Down, _) => (known.default_name(), None, LspFoundState::ContainerDown),
                (Reach::Up(_), Some(tool)) => (
                    tool.name,
                    Some(match &place {
                        LspFoundPlace::Host => tool.command.to_owned(),
                        LspFoundPlace::Compose { service } => format!(
                            "docker compose exec -T -w {} {} {}",
                            shell_quote(&mount),
                            shell_quote(service),
                            tool.command
                        ),
                    }),
                    LspFoundState::Found,
                ),
                (Reach::Up(_), None) => (known.default_name(), None, LspFoundState::Missing),
            };
            LspFound {
                language: known.language.to_owned(),
                name: name.to_owned(),
                command,
                place,
                mount,
                state,
            }
        })
        .collect()
}

/// The languages that `worktree` of the project `project` of `environment` has, and the server each could have, read from the worktree by `run` (a route, a command, its folder and the most bytes to keep): the compose configuration, the script on the host, and, when a service mounts the worktree, the script in it.
pub(crate) fn detect_with(
    dir: &std::path::Path,
    environment: Option<&str>,
    project: &str,
    worktree: &str,
    mut run: impl FnMut(&Route, &str, &str, usize) -> Result<Ran, String>,
) -> Result<Vec<LspFound>, String> {
    check_worktree(worktree)?;
    let settings = settings_of(dir, environment, project)?;
    let route = route_of(environment, project, &settings)?;
    let mut here = |command: &str, limit: usize| run(&route, worktree, command, limit);
    let inputs = collect(&mut here, worktree, false)?;
    let services = match &inputs.compose {
        Some(config) => candidates(worktree, config)?,
        None => Vec::new(),
    };
    let host = match probe(&mut here, &Place::Host, true)? {
        Reach::Up(host) => host,
        Reach::Down => Probe::default(),
    };
    let container = match services.first() {
        Some(first) => Some(probe(
            &mut here,
            &Place::Compose {
                service: first.service.clone(),
                mount: first.mount.clone(),
            },
            false,
        )?),
        None => None,
    };
    Ok(found_from(worktree, &services, &host, container.as_ref()))
}

/// The languages of the worktree (A-34) and the server of the table for each, read from the worktree just now, on this machine or through the ssh host of the project's settings. A language that the worktree does not show is not answered.
#[tauri::command]
pub async fn lsp_detect(
    app: AppHandle,
    environment: Option<String>,
    project: String,
    worktree: String,
) -> Result<Vec<LspFound>, String> {
    check_worktree(&worktree)?;
    check_worktree_of_project(&worktree, environment.as_deref(), &project).await?;
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        detect_with(&dir, environment.as_deref(), &project, &worktree, run_on)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::{set_settings, LspRepoSettings};
    use serde_json::json;
    use std::path::PathBuf;

    const WT: &str = "/Users/x/orca/workspaces/app/feature";
    const LOCK: &str = "    ruby-lsp (0.26.9)\n    ruby-lsp-rails (0.4.0)\n";

    fn ran(code: i32, stdout: &str, stderr: &str) -> Ran {
        Ran {
            code: Some(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.into(),
        }
    }

    fn cand(service: &str, mount: &str) -> LspCandidate {
        LspCandidate {
            service: service.into(),
            mount: mount.into(),
        }
    }

    fn probe_of(marks: &[&str], have: &[&str], lock: &str) -> Probe {
        Probe {
            marks: marks.iter().map(|m| (*m).to_owned()).collect(),
            have: have.iter().map(|m| (*m).to_owned()).collect(),
            lock: lock.to_owned(),
        }
    }

    fn language_of<'a>(found: &'a [LspFound], language: &str) -> &'a LspFound {
        found.iter().find(|f| f.language == language).unwrap()
    }

    // ---- the table ----

    #[test]
    fn every_language_of_the_table_is_a_language_of_a21_with_a_name_and_a_mark() {
        for known in TABLE {
            assert!(
                crate::orca_language::is_language(known.language),
                "{}",
                known.language
            );
            assert!(!known.marks.is_empty(), "{}", known.language);
            assert!(!known.tools.is_empty(), "{}", known.language);
            assert_eq!(known.default_name(), known.tools[0].name);
        }
        assert_eq!(known("ruby").unwrap().default_name(), "ruby-lsp");
        assert_eq!(known("rust").unwrap().default_name(), "rust-analyzer");
        assert!(known("cobol-2000").is_none());
    }

    #[test]
    fn what_the_table_puts_in_the_script_has_no_quote_and_ruby_is_not_looked_for() {
        for known in TABLE {
            for text in known.marks.iter().copied().chain(
                known
                    .tools
                    .iter()
                    .flat_map(|t| [t.command].into_iter().chain(t.probe)),
            ) {
                assert!(!text.contains('\''), "{text}");
                assert!(!text.contains('\n'), "{text}");
            }
        }
        assert!(!known("ruby").unwrap().needs_probe());
        assert!(known("rust").unwrap().needs_probe());
    }

    #[test]
    fn the_script_tells_the_marks_the_lock_and_the_commands_and_ends_well() {
        let script = probe_script(true);
        for mark in [
            "Cargo.toml",
            "package.json",
            "tsconfig.json",
            "go.mod",
            "pyproject.toml",
            "requirements.txt",
            "Gemfile.lock",
        ] {
            assert!(
                script.contains(&format!(
                    "if [ -f {mark} ]; then printf '%s\\n' 'mark {mark}'; fi"
                )),
                "{mark}"
            );
        }
        assert!(script.contains("grep ruby-lsp Gemfile.lock | sed 's/^/lock /'"));
        for command in [
            "rust-analyzer",
            "node_modules/.bin/typescript-language-server --stdio",
            "typescript-language-server --stdio",
            "gopls",
            "pyright-langserver --stdio",
            "pylsp",
        ] {
            assert!(script.contains(&format!("'have {command}'")), "{command}");
        }
        // A command shared by two languages is asked once.
        assert_eq!(
            script
                .matches("'have typescript-language-server --stdio'")
                .count(),
            1
        );
        assert!(script.starts_with("{ ") && script.ends_with("; true; }"));
        // Without the marks it asks about the commands only.
        let tools = probe_script(false);
        assert!(!tools.contains("mark ") && !tools.contains("Gemfile.lock"));
        assert!(tools.contains("'have gopls'"));
    }

    // ---- what the script printed ----

    #[test]
    fn the_lines_of_the_script_are_read_and_the_others_are_left_out() {
        let probe = parse_probe(
            "mark Cargo.toml\r\nmark package.json\nhave rust-analyzer\nlock     ruby-lsp (0.26.9)\nlock     rack (3.1.0)\nnoise\n mark x\n",
        );
        assert_eq!(
            probe,
            probe_of(
                &["Cargo.toml", "package.json"],
                &["rust-analyzer"],
                "    ruby-lsp (0.26.9)\n    rack (3.1.0)\n"
            )
        );
        assert_eq!(parse_probe(""), Probe::default());
    }

    // ---- what is found ----

    #[test]
    fn a_language_is_found_by_its_mark_and_the_first_command_of_the_table_that_the_host_has() {
        let host = probe_of(
            &["Cargo.toml", "package.json", "go.mod"],
            &["rust-analyzer", "typescript-language-server --stdio"],
            "",
        );
        let found = found_from(WT, &[], &host, None);
        let languages: Vec<&str> = found.iter().map(|f| f.language.as_str()).collect();
        assert_eq!(languages, ["rust", "typescript", "javascript", "go"]);
        assert_eq!(
            *language_of(&found, "rust"),
            LspFound {
                language: "rust".into(),
                name: "rust-analyzer".into(),
                command: Some("rust-analyzer".into()),
                place: LspFoundPlace::Host,
                mount: WT.into(),
                state: LspFoundState::Found,
            }
        );
        assert_eq!(
            language_of(&found, "javascript").command.as_deref(),
            Some("typescript-language-server --stdio")
        );
        // The command of node_modules comes first, and python takes the first of its two that exists.
        let host = probe_of(
            &["package.json", "requirements.txt"],
            &[
                "typescript-language-server --stdio",
                "node_modules/.bin/typescript-language-server --stdio",
                "pylsp",
            ],
            "",
        );
        let found = found_from(WT, &[], &host, None);
        assert_eq!(
            language_of(&found, "typescript").command.as_deref(),
            Some("node_modules/.bin/typescript-language-server --stdio")
        );
        let python = language_of(&found, "python");
        assert_eq!(
            (python.name.as_str(), python.command.as_deref()),
            ("pylsp", Some("pylsp"))
        );
    }

    #[test]
    fn a_language_with_no_server_is_missing_and_one_with_no_mark_is_not_answered() {
        let host = probe_of(&["go.mod"], &[], "");
        let found = found_from(WT, &[], &host, None);
        assert_eq!(
            found,
            vec![LspFound {
                language: "go".into(),
                name: "gopls".into(),
                command: None,
                place: LspFoundPlace::Host,
                mount: WT.into(),
                state: LspFoundState::Missing,
            }]
        );
        assert_eq!(found_from(WT, &[], &Probe::default(), None), vec![]);
    }

    #[test]
    fn ruby_is_found_only_when_the_gemfile_lock_lists_ruby_lsp() {
        let with = probe_of(&["Gemfile.lock"], &[], LOCK);
        let found = found_from(WT, &[], &with, None);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].language, "ruby");
        assert_eq!(found[0].name, "ruby-lsp");
        assert_eq!(found[0].command.as_deref(), Some("bundle exec ruby-lsp"));
        let without = probe_of(&["Gemfile.lock"], &[], "    ruby-lsp-rails (0.4.0)\n");
        assert_eq!(found_from(WT, &[], &without, None), vec![]);
    }

    #[test]
    fn in_a_service_of_compose_the_command_runs_there_with_the_mount_of_the_service() {
        let host = probe_of(&["Cargo.toml", "Gemfile.lock"], &[], LOCK);
        let services = [cand("app", "/app"), cand("worker", "/srv")];
        let up = Reach::Up(probe_of(&[], &["rust-analyzer"], ""));
        let found = found_from(WT, &services, &host, Some(&up));
        assert_eq!(
            *language_of(&found, "rust"),
            LspFound {
                language: "rust".into(),
                name: "rust-analyzer".into(),
                command: Some("docker compose exec -T -w /app app rust-analyzer".into()),
                place: LspFoundPlace::Compose {
                    service: "app".into()
                },
                mount: "/app".into(),
                state: LspFoundState::Found,
            }
        );
        assert_eq!(
            language_of(&found, "ruby").command.as_deref(),
            Some("docker compose exec -T -w /app app bundle exec ruby-lsp")
        );
        // What the host has is not what the service has.
        let host_has = probe_of(&["Cargo.toml"], &["rust-analyzer"], "");
        let none = Reach::Up(Probe::default());
        let found = found_from(WT, &services, &host_has, Some(&none));
        assert_eq!(language_of(&found, "rust").state, LspFoundState::Missing);
        assert_eq!(language_of(&found, "rust").command, None);
        assert_eq!(
            language_of(&found, "rust").place,
            LspFoundPlace::Compose {
                service: "app".into()
            }
        );
    }

    #[test]
    fn a_container_that_does_not_run_is_told_for_every_language() {
        let host = probe_of(&["Cargo.toml", "go.mod"], &[], "");
        let found = found_from(WT, &[cand("app", "/app")], &host, Some(&Reach::Down));
        assert_eq!(found.len(), 2);
        for each in &found {
            assert_eq!(each.state, LspFoundState::ContainerDown);
            assert_eq!(each.command, None);
            assert_eq!(each.mount, "/app");
        }
        assert_eq!(found[0].name, "rust-analyzer");
    }

    #[test]
    fn what_the_screen_gets_has_the_shape_of_the_bindings() {
        let found = LspFound {
            language: "rust".into(),
            name: "rust-analyzer".into(),
            command: None,
            place: LspFoundPlace::Compose {
                service: "app".into(),
            },
            mount: "/app".into(),
            state: LspFoundState::ContainerDown,
        };
        assert_eq!(
            serde_json::to_value(&found).unwrap(),
            json!({"language": "rust", "name": "rust-analyzer", "command": null, "place": {"kind": "compose", "service": "app"}, "mount": "/app", "state": "containerDown"})
        );
        assert_eq!(
            serde_json::to_value(LspFoundPlace::Host).unwrap(),
            json!({"kind": "host"})
        );
    }

    // ---- reading the worktree ----

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tsunagiai-detect-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn compose_config() -> String {
        json!({"services": {"app": {"volumes": [{"type": "bind", "source": WT, "target": "/app"}]}}}).to_string()
    }

    #[test]
    fn the_host_is_asked_once_with_the_marks_and_a_service_that_mounts_the_worktree_once_more() {
        let dir = temp_dir("both");
        let config = compose_config();
        let mut commands = Vec::new();
        let found = detect_with(
            &dir,
            None,
            "repo-1",
            WT,
            |route, worktree, command, limit| {
                assert_eq!((route, worktree), (&Route::Local, WT));
                assert_eq!(limit, READ_MAX + 1);
                commands.push(command.to_owned());
                Ok(if command.contains("docker compose config") {
                    ran(0, &config, "")
                } else if command.starts_with("docker compose exec") {
                    ran(0, "have gopls\n", "")
                } else {
                    ran(0, "mark go.mod\nmark Cargo.toml\n", "")
                })
            },
        )
        .unwrap();
        assert_eq!(commands.len(), 3);
        assert!(commands[1].contains("mark go.mod"));
        assert!(commands[2].starts_with("docker compose exec -T -w /app app sh -c '"));
        // The container's script has no mark: the files are the worktree's, which the host read.
        assert!(!commands[2].contains("Gemfile.lock"));
        assert_eq!(found.len(), 2);
        assert_eq!(
            language_of(&found, "go").command.as_deref(),
            Some("docker compose exec -T -w /app app gopls")
        );
        assert_eq!(language_of(&found, "rust").state, LspFoundState::Missing);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn with_no_compose_service_only_the_host_is_asked() {
        let dir = temp_dir("host");
        let mut commands = Vec::new();
        let found = detect_with(&dir, None, "repo-1", WT, |_, _, command, _| {
            commands.push(command.to_owned());
            Ok(if command.contains("docker compose config") {
                ran(0, "", "")
            } else {
                ran(0, "mark Cargo.toml\nhave rust-analyzer\n", "")
            })
        })
        .unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].place, LspFoundPlace::Host);
        // A worktree that shows no language answers nothing.
        let none = detect_with(&dir, None, "repo-1", WT, |_, _, _, _| Ok(ran(0, "", ""))).unwrap();
        assert_eq!(none, vec![]);
    }

    #[test]
    fn a_container_that_is_down_is_told_and_any_other_failure_is_an_error() {
        let dir = temp_dir("down");
        let config = compose_config();
        let found = detect_with(&dir, None, "repo-1", WT, |_, _, command, _| {
            Ok(if command.contains("docker compose config") {
                ran(0, &config, "")
            } else if command.starts_with("docker compose exec") {
                ran(1, "", "service \"app\" is not running\n")
            } else {
                ran(0, "mark go.mod\n", "")
            })
        })
        .unwrap();
        assert_eq!(found[0].state, LspFoundState::ContainerDown);
        let err = detect_with(&dir, None, "repo-1", WT, |_, _, command, _| {
            Ok(if command.contains("docker compose config") {
                ran(0, &config, "")
            } else if command.starts_with("docker compose exec") {
                ran(2, "", "OCI runtime exec failed\n")
            } else {
                ran(0, "mark go.mod\n", "")
            })
        })
        .unwrap_err();
        assert!(err.contains("OCI runtime exec failed"), "{err}");
        // A host that fails is an error too (the container is told only for a service).
        let err = detect_with(&dir, None, "repo-1", WT, |_, _, _, _| {
            Ok(ran(1, "", "service \"app\" is not running\n"))
        })
        .unwrap_err();
        assert!(err.contains("not running"), "{err}");
    }

    #[test]
    fn a_saved_environment_goes_through_its_host_and_a_bad_worktree_runs_nothing() {
        let dir = temp_dir("ssh");
        set_settings(
            &dir,
            LspRepoSettings {
                ssh_host: Some("dev".into()),
                ..LspRepoSettings::unset(Some("srv"), "repo-1")
            },
        )
        .unwrap();
        let mut routes = Vec::new();
        detect_with(&dir, Some("srv"), "repo-1", WT, |route, _, _, _| {
            routes.push(route.clone());
            Ok(ran(0, "", ""))
        })
        .unwrap();
        assert_eq!(routes, vec![Route::Ssh { host: "dev".into() }; 2]);
        let mut runs = 0;
        let err = detect_with(&dir, Some("srv"), "repo-1", "rel", |_, _, _, _| {
            runs += 1;
            Ok(ran(0, "", ""))
        })
        .unwrap_err();
        assert_eq!(err, "worktree のパスが正しくありません");
        let err = detect_with(&dir, Some("other"), "repo-1", WT, |_, _, _, _| {
            runs += 1;
            Ok(ran(0, "", ""))
        })
        .unwrap_err();
        assert_eq!(err, "ssh の接続先が設定されていません");
        assert_eq!(runs, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // ---- the command of a server with none ----

    fn settings_of_language(language: &str) -> LspServerSettings {
        LspServerSettings {
            language: language.into(),
            name: language.into(),
            auto_start: true,
            command: None,
            mount: None,
            service: None,
        }
    }

    #[test]
    fn the_command_of_the_settings_a_language_not_in_the_table_and_no_way_ask_nothing() {
        let mut runs = 0;
        let mut run = |_: &str, _: usize| {
            runs += 1;
            Ok(ran(0, "", ""))
        };
        let mut cache = HashMap::new();
        let own = LspServerSettings {
            command: Some("x".into()),
            ..settings_of_language("rust")
        };
        assert_eq!(
            auto_command(&mut run, &Launch::Host, &own, &mut cache),
            Ok(None)
        );
        let plain = settings_of_language("plaintext");
        assert_eq!(
            auto_command(&mut run, &Launch::Host, &plain, &mut cache),
            Ok(None)
        );
        let rust = settings_of_language("rust");
        assert_eq!(
            auto_command(&mut run, &Launch::Unavailable, &rust, &mut cache),
            Ok(None)
        );
        // Ruby has the one command, which nothing is asked for.
        let ruby = settings_of_language("ruby");
        assert_eq!(
            auto_command(&mut run, &Launch::Host, &ruby, &mut cache),
            Ok(Some("bundle exec ruby-lsp".into()))
        );
        assert_eq!(runs, 0);
    }

    #[test]
    fn a_place_is_asked_once_for_all_the_servers_of_a_worktree() {
        let commands = std::cell::RefCell::new(Vec::<String>::new());
        let mut run = |command: &str, _: usize| {
            commands.borrow_mut().push(command.to_owned());
            Ok(ran(0, "have gopls\nhave pylsp\n", ""))
        };
        let mut cache = HashMap::new();
        let go = auto_command(
            &mut run,
            &Launch::Host,
            &settings_of_language("go"),
            &mut cache,
        );
        let python = auto_command(
            &mut run,
            &Launch::Host,
            &settings_of_language("python"),
            &mut cache,
        );
        assert_eq!(go, Ok(Some("gopls".into())));
        assert_eq!(python, Ok(Some("pylsp".into())));
        assert_eq!(commands.borrow().len(), 1);
        // The service of the settings is the place when it is one of the services that mount the worktree.
        let services = Launch::Compose(vec![cand("app", "/app"), cand("worker", "/srv")]);
        let worker = LspServerSettings {
            service: Some("worker".into()),
            ..settings_of_language("go")
        };
        let got = auto_command(&mut run, &services, &worker, &mut cache);
        assert_eq!(got, Ok(Some("gopls".into())));
        assert_eq!(commands.borrow().len(), 2);
        assert!(commands.borrow()[1].starts_with("docker compose exec -T -w /srv worker sh -c '"));
    }
}
