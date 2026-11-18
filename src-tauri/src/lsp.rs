//! A-34: how a language server is started for a worktree of the Orca screen, and the settings of each repository that say otherwise.
//!
//! A repository has any number of servers (`LspServerSettings`): each has a name, the languages of A-21 it takes (one language belongs to one server of a repository, `server_for`), a command, and the rest. The way is decided for one server of it. A server that takes `ruby` has the automatic way of ruby-lsp, which is decided from what the worktree holds, in this order: a service of `docker compose config --format json` that bind mounts the worktree (`docker compose exec -T -w {mount} {service} bundle exec ruby-lsp`, the path of the worktree there being the mount's target), else a `Gemfile.lock` that lists `ruby-lsp` (`bundle exec ruby-lsp` on the host), else none. `decide` is a pure function of the two texts. A server that does not take `ruby` has no automatic command (it needs the `command` of its settings, else it has no way), and the services that mount the worktree and the mount are decided for it as they are for ruby-lsp.
//! The texts are read by one command each (the `Gemfile.lock` only for a server that takes `ruby`, and only when no service of compose mounts the worktree), run in the worktree: on this machine, or, for a worktree of a saved environment (A-33), through the `ssh` of this Mac to the host the settings name. The command is a shell script that is built in one place (`script`, `spawn_of`), so that the start of the server (`server`) goes the same way: this machine, a `docker compose exec -T` inside it, or the `ssh` in front of it.
//! What the definition pane draws of an answer (the name under the mouse, the place of each definition) is decided in `view`, from texts alone.
//! The server itself is in `server` (the processes that stay, one for each worktree and server name, their state and the questions) and `protocol` (the frame, the messages, the paths and the answers, as pure functions).
//! The settings of a repository are saved in `lsp-settings.json` (version 2) in the app config directory, under the place of the repository (this machine, or a saved environment) and the key of its project in Orca's list. A file of version 1, which held one ruby-lsp for each repository, is read as a repository with that one server, and the next save writes version 2.
//! A file outside the worktree that the server gave as a definition is read, read only, by the same route (`outside`).
//! The container of the service is started, only when the owner asks, by the same route (`container`).
//! The files of the server's languages that changed on the disk are told to the server before each question (`watch`, with `server::LspServers::refresh`).
//! Nothing of a file of a worktree is kept: the answers of the two commands are used and dropped.

pub mod container;
pub mod outside;
mod protocol;
pub mod server;
pub mod view;
mod watch;

use std::{path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts::write_atomic,
    auth::config_dir,
    orca_files::check_worktree_of_project,
    orca_language,
    ssh::{check_host, failure, run_process, shared_control, ssh_args, Ran, SSH, TIMEOUT},
};

const FILE: &str = "lsp-settings.json";
const VERSION: u32 = 2;
/// The longest name of a server, in characters.
const MAX_NAME: usize = 64;
/// The language whose servers have the automatic way of ruby-lsp, and the name of the server that a repository with nothing saved has.
const RUBY: &str = "ruby";
const DEFAULT_SERVER: &str = "ruby-lsp";
/// The longest text of a setting, in characters.
const MAX_TEXT: usize = 4096;
/// The most bytes of the compose configuration or of the `Gemfile.lock` that are read.
const READ_MAX: usize = 4 * 1024 * 1024;
/// The shell of this machine, and the folders that a shell started by a program with no login (this app, or a non-interactive ssh) lacks in its PATH: where `docker` is.
const SHELL: &str = "/bin/sh";
const EXTRA_PATH: &str = "/usr/local/bin:/opt/homebrew/bin";
/// The server, as Bundler starts it.
const RUBY_LSP: &str = "bundle exec ruby-lsp";
/// The names under which `docker compose` looks for the file in the folder it runs in.
const COMPOSE_FILES: [&str; 4] = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];
/// The file is read and written in turn by the commands of the screen, which may overlap.
static LOCK: Mutex<()> = Mutex::new(());

const NOT_COMPOSE: &str = "docker compose の設定を読めません";
const BAD_COMPOSE: &str = "docker compose の設定の形式が正しくありません";
const NOT_LOCK: &str = "Gemfile.lock を読めません";
const TOO_LARGE: &str = "設定が大きすぎて読めません";
const NOT_UTF8: &str = "設定が UTF-8 ではありません";
const NO_SSH_HOST: &str = "ssh の接続先が設定されていません";
const ON_SSH_HOST: &str = "SSH ホストの worktree には使えません";
const BAD_WORKTREE: &str = "worktree のパスが正しくありません";
const BAD_SERVER: &str = "サーバーの名前が正しくありません";

// ---- what the screen gets ----

/// A service of the compose file that bind mounts the worktree, and the path the worktree has in it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspCandidate {
    pub service: String,
    pub mount: String,
}

/// Where the server runs, as decided from the worktree: in a service of compose (`Compose`), on the host (`Host`), or nowhere (`None`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum LspMethod {
    Compose,
    Host,
    None,
}

/// The way ruby-lsp is started for a worktree, with the settings of its repository applied.
/// `candidates` are all the services that mount the worktree (empty unless `method` is `compose`), `service` the one used (the setting when it is among them, else the first). `command` is what is run in the worktree (the setting, else the one that `method` gives; none when there is neither), and `mount` is the path of the worktree where it runs (the setting, else the mount of the service, else the worktree's own path).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspLaunch {
    pub method: LspMethod,
    pub candidates: Vec<LspCandidate>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub service: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub command: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub mount: Option<String>,
}

/// The settings of one language server of a repository: its `name` (unique in the repository), the `languages` of A-21 it takes (at least one, each taken by no other server of the repository), and whether it starts by itself.
/// `command` and `mount` replace what `decide` gives (the command run in the worktree, and the path the worktree has where it runs), and `service` chooses among the services that mount the worktree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspServerSettings {
    pub name: String,
    pub languages: Vec<String>,
    pub auto_start: bool,
    #[cfg_attr(test, ts(optional = nullable))]
    pub command: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub mount: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub service: Option<String>,
}

impl LspServerSettings {
    /// The server that a repository with nothing saved has, and that a file of version 1 held: ruby-lsp, which takes `ruby` and starts by itself, with nothing replaced.
    fn ruby_lsp() -> Self {
        Self {
            name: DEFAULT_SERVER.to_owned(),
            languages: vec![RUBY.to_owned()],
            auto_start: true,
            command: None,
            mount: None,
            service: None,
        }
    }

    /// Whether the server has the automatic way of ruby-lsp.
    fn takes_ruby(&self) -> bool {
        self.languages.iter().any(|language| language == RUBY)
    }
}

/// The settings of a repository. `environment` is where its project is (`None` for this machine, else the name of the saved environment) and `project` its key in Orca's list (`OrcaProject::key`). `ssh_host` is the Host of `~/.ssh/config` through which a saved environment's worktrees are reached (Orca's environments say nothing of ssh), and `servers` its language servers.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspRepoSettings {
    #[cfg_attr(test, ts(optional = nullable))]
    pub environment: Option<String>,
    pub project: String,
    #[cfg_attr(test, ts(optional = nullable))]
    pub ssh_host: Option<String>,
    pub servers: Vec<LspServerSettings>,
}

impl LspRepoSettings {
    /// What a repository with nothing saved has: ruby-lsp, which starts by itself, and nothing is replaced.
    fn unset(environment: Option<&str>, project: &str) -> Self {
        Self {
            environment: environment.map(str::to_owned),
            project: project.to_owned(),
            ssh_host: None,
            servers: vec![LspServerSettings::ruby_lsp()],
        }
    }

    /// The server named `name`.
    fn server(&self, name: &str) -> Option<&LspServerSettings> {
        self.servers.iter().find(|server| server.name == name)
    }
}

/// The name of the server of `settings` that takes `language` (a language of A-21), none when no server does. A language belongs to one server of a repository (`clean`), so there is at most one.
pub(crate) fn server_for(settings: &LspRepoSettings, language: &str) -> Option<String> {
    settings
        .servers
        .iter()
        .find(|server| server.languages.iter().any(|taken| taken == language))
        .map(|server| server.name.clone())
}

// ---- the decision ----

/// What `decide` settled for a worktree.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Launch {
    Compose(Vec<LspCandidate>),
    Host,
    Unavailable,
}

/// A directory path as text, with the `/` that ends it left off (the root stays `/`).
fn trimmed(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() && path.starts_with('/') {
        "/"
    } else {
        trimmed
    }
}

/// The services of `docker compose config --format json` (`config`) that bind mount `worktree`, by name, each with the target of the mount. That output has the anchors and the extensions of the file expanded and every volume in its long form, so a service that took its volumes from an anchor is listed as the others are. A volume that is not a bind (a named volume, a tmpfs), a bind of another folder, a target that is not an absolute path, and a name that ssh or docker could take for an option are left out; a service that mounts the worktree twice is listed once, at its first mount.
fn candidates(worktree: &str, config: &str) -> Result<Vec<LspCandidate>, String> {
    let config: Value = serde_json::from_str(config).map_err(|_| BAD_COMPOSE)?;
    if !config.is_object() {
        return Err(BAD_COMPOSE.into());
    }
    let want = trimmed(worktree);
    let mut found: Vec<LspCandidate> = config["services"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, _)| !name.is_empty() && !name.starts_with('-'))
        .filter_map(|(name, service)| {
            let mount = service["volumes"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|volume| {
                    let target = volume["target"].as_str().filter(|t| t.starts_with('/'))?;
                    let source = volume["source"].as_str()?;
                    (volume["type"] == "bind" && trimmed(source) == want).then(|| target.to_owned())
                })?;
            Some(LspCandidate {
                service: name.clone(),
                mount,
            })
        })
        .collect();
    found.sort_by(|a, b| a.service.cmp(&b.service));
    Ok(found)
}

/// Whether the text of a `Gemfile.lock` lists the gem `ruby-lsp` (as a locked spec or as a dependency), and not another gem whose name begins with it.
fn has_ruby_lsp(gemfile_lock: &str) -> bool {
    gemfile_lock.lines().any(|line| {
        let name = line.trim().split([' ', '(', '!']).next();
        name == Some("ruby-lsp")
    })
}

/// How ruby-lsp is started for `worktree`, from the compose configuration (`None`: the worktree has no compose file) and the `Gemfile.lock` (`None`: it has none).
pub(crate) fn decide(
    worktree: &str,
    compose: Option<&str>,
    gemfile_lock: Option<&str>,
) -> Result<Launch, String> {
    if let Some(config) = compose {
        let found = candidates(worktree, config)?;
        if !found.is_empty() {
            return Ok(Launch::Compose(found));
        }
    }
    Ok(if gemfile_lock.is_some_and(has_ruby_lsp) {
        Launch::Host
    } else {
        Launch::Unavailable
    })
}

/// `launch` with the settings of the server applied (`LspLaunch`). Only a server that takes `ruby` has a command of its own to decide (`bundle exec ruby-lsp`, in the service of compose or on the host).
fn resolve(launch: Launch, settings: &LspServerSettings, worktree: &str) -> LspLaunch {
    let (method, candidates) = match launch {
        Launch::Compose(found) => (LspMethod::Compose, found),
        Launch::Host => (LspMethod::Host, Vec::new()),
        Launch::Unavailable => (LspMethod::None, Vec::new()),
    };
    let chosen = settings
        .service
        .as_deref()
        .and_then(|name| candidates.iter().find(|c| c.service == name))
        .or_else(|| candidates.first());
    let service = chosen.map(|c| c.service.clone());
    let ruby = settings.takes_ruby();
    let (decided_command, decided_mount) = match (method, chosen) {
        (LspMethod::Compose, Some(c)) => (
            ruby.then(|| {
                format!(
                    "docker compose exec -T -w {} {} {RUBY_LSP}",
                    shell_quote(&c.mount),
                    shell_quote(&c.service)
                )
            }),
            Some(c.mount.clone()),
        ),
        (LspMethod::Host, _) => (ruby.then(|| RUBY_LSP.to_owned()), Some(worktree.to_owned())),
        _ => (None, None),
    };
    let command = settings.command.clone().or(decided_command);
    let mount = settings
        .mount
        .clone()
        .or(decided_mount)
        .or_else(|| command.is_some().then(|| worktree.to_owned()));
    LspLaunch {
        method,
        candidates,
        service,
        command,
        mount,
    }
}

// ---- the way to the worktree ----

/// `text` as one word of a POSIX shell: as it is when it holds only characters that need no quoting, else in single quotes.
pub(crate) fn shell_quote(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@+:,./-".contains(c));
    if plain {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

/// The script that runs `command` in `worktree`, for `sh -c`: the folders of `docker` are added to PATH, then it goes to the worktree. The worktree is quoted; `command` is shell text and is not (the owner's own, or one that `resolve` made with the mount and the service quoted).
pub(crate) fn script(worktree: &str, command: &str) -> String {
    format!(
        "PATH=\"$PATH:{EXTRA_PATH}\"; export PATH; cd {} && {command}",
        shell_quote(worktree)
    )
}

/// Where a worktree is: on this machine, or on the host of `~/.ssh/config` that this Mac reaches by ssh.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Route {
    Local,
    Ssh { host: String },
}

/// A program and its arguments, to be started without a shell of this machine in between.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Spawn {
    pub program: String,
    pub args: Vec<String>,
}

/// The process that runs `command` in `worktree` by `route`. On this machine it is `/bin/sh -c {script}`; by ssh the host is the one element after `--` and the script, quoted, is run by `sh -c` there, so that whatever shell the host gives the user reads it the same. `control` is the folder of the shared ssh connections (`shared_control`).
pub(crate) fn spawn_of(
    route: &Route,
    worktree: &str,
    command: &str,
    control: Option<&str>,
) -> Spawn {
    let script = script(worktree, command);
    match route {
        Route::Local => Spawn {
            program: SHELL.to_owned(),
            args: vec!["-c".to_owned(), script],
        },
        Route::Ssh { host } => Spawn {
            program: SSH.to_owned(),
            args: ssh_args(host, control, &format!("sh -c {}", shell_quote(&script))),
        },
    }
}

/// The route of the worktree of the project `project` of `environment` (`None`: this machine). A saved environment's worktree needs the host that the settings name.
fn route_of(
    environment: Option<&str>,
    project: &str,
    settings: &LspRepoSettings,
) -> Result<Route, String> {
    if project.starts_with("ssh:") {
        return Err(ON_SSH_HOST.into());
    }
    if environment.is_none() {
        return Ok(Route::Local);
    }
    let host = settings.ssh_host.as_deref().ok_or(NO_SSH_HOST)?;
    Ok(Route::Ssh {
        host: check_host(host)?.to_owned(),
    })
}

/// What is read from a worktree to decide: the compose configuration and the `Gemfile.lock`, each `None` when there is none.
#[derive(Debug, PartialEq)]
struct Inputs {
    compose: Option<String>,
    gemfile_lock: Option<String>,
}

/// The text of what `run` printed when it ended well, with nothing as `None`. `run` is given the command to run in the worktree and the most bytes to keep.
fn read_text(
    run: &mut impl FnMut(&str, usize) -> Result<Ran, String>,
    command: &str,
    what: &str,
) -> Result<Option<String>, String> {
    let ran = run(command, READ_MAX + 1)?;
    if ran.code != Some(0) {
        return Err(failure(&ran, what));
    }
    if ran.stdout.len() > READ_MAX {
        return Err(TOO_LARGE.into());
    }
    let text = String::from_utf8(ran.stdout).map_err(|_| NOT_UTF8)?;
    Ok((!text.trim().is_empty()).then_some(text))
}

/// Reads the compose configuration (`docker compose config --format json`, only when the folder has a compose file) and, when `ruby` (the server takes `ruby`) and no service of it mounts `worktree` (then the `Gemfile.lock` decides nothing), the `Gemfile.lock` of the worktree that `run` runs its commands in.
fn collect(
    run: &mut impl FnMut(&str, usize) -> Result<Ran, String>,
    worktree: &str,
    ruby: bool,
) -> Result<Inputs, String> {
    let has_file = COMPOSE_FILES
        .map(|file| format!("[ -f {file} ]"))
        .join(" || ");
    let compose = read_text(
        run,
        &format!("if {has_file}; then docker compose config --format json; fi"),
        NOT_COMPOSE,
    )?;
    let in_compose = match &compose {
        Some(config) => !candidates(worktree, config)?.is_empty(),
        None => false,
    };
    let gemfile_lock = if in_compose || !ruby {
        None
    } else {
        read_text(
            run,
            "if [ -f Gemfile.lock ]; then cat Gemfile.lock; fi",
            NOT_LOCK,
        )?
    };
    Ok(Inputs {
        compose,
        gemfile_lock,
    })
}

// ---- the settings file ----

#[derive(Serialize, Deserialize)]
struct Store {
    version: u32,
    repositories: Vec<LspRepoSettings>,
}

/// The first field of the file, to find which version it is before the rest is read.
#[derive(Deserialize)]
struct Head {
    version: u32,
}

/// A repository of a file of version 1: one ruby-lsp, whose settings were those of the repository.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoV1 {
    environment: Option<String>,
    project: String,
    auto_start: bool,
    command: Option<String>,
    mount: Option<String>,
    service: Option<String>,
    ssh_host: Option<String>,
}

#[derive(Deserialize)]
struct StoreV1 {
    repositories: Vec<RepoV1>,
}

impl From<RepoV1> for LspRepoSettings {
    fn from(old: RepoV1) -> Self {
        Self {
            environment: old.environment,
            project: old.project,
            ssh_host: old.ssh_host,
            servers: vec![LspServerSettings {
                auto_start: old.auto_start,
                command: old.command,
                mount: old.mount,
                service: old.service,
                ..LspServerSettings::ruby_lsp()
            }],
        }
    }
}

fn load(dir: &Path) -> Result<Store, String> {
    let path = dir.join(FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Store {
                version: VERSION,
                repositories: Vec::new(),
            })
        }
        Err(e) => return Err(format!("{} を読めません: {e}", path.display())),
    };
    let bad = |e: serde_json::Error| format!("{} の形式が不正です: {e}", path.display());
    let head: Head = serde_json::from_str(&text).map_err(bad)?;
    let repositories = match head.version {
        1 => serde_json::from_str::<StoreV1>(&text)
            .map_err(bad)?
            .repositories
            .into_iter()
            .map(LspRepoSettings::from)
            .collect(),
        VERSION => {
            serde_json::from_str::<Store>(&text)
                .map_err(bad)?
                .repositories
        }
        other => {
            return Err(format!("{} の版 {other} は読めません", path.display()));
        }
    };
    Ok(Store {
        version: VERSION,
        repositories,
    })
}

fn save(dir: &Path, store: &Store) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    write_atomic(dir, FILE, &text)
}

/// The settings of the project `project` of `environment`: the saved ones, else the unset ones.
fn settings_of(
    dir: &Path,
    environment: Option<&str>,
    project: &str,
) -> Result<LspRepoSettings, String> {
    Ok(load(dir)?
        .repositories
        .into_iter()
        .find(|r| r.environment.as_deref() == environment && r.project == project)
        .unwrap_or_else(|| LspRepoSettings::unset(environment, project)))
}

/// A text that is a name, a key or a path in a setting: not empty, not longer than `MAX_TEXT`, with no control character.
fn check_text(what: &str, text: &str) -> Result<(), String> {
    if text.is_empty() || text.chars().count() > MAX_TEXT || text.chars().any(char::is_control) {
        return Err(format!("{what}が正しくありません"));
    }
    Ok(())
}

/// A text that may be left out: trimmed, and an empty one is none; the rest is checked as `check_text` does.
fn optional_text(what: &str, text: Option<String>) -> Result<Option<String>, String> {
    let Some(text) = text.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    check_text(what, &text)?;
    Ok(Some(text))
}

/// Whether `name` can be the name of a server: not empty, at most `MAX_NAME` characters, no control character.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= MAX_NAME && !name.chars().any(char::is_control)
}

/// The name of a server that a command is given.
pub(crate) fn check_server(name: &str) -> Result<(), String> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(BAD_SERVER.into())
    }
}

/// A server as it is saved: the name trimmed and checked, the languages checked (at least one, each a language of A-21 and none twice), and the other texts trimmed, an empty one taken as not set, each checked. `mount` must be an absolute path.
fn clean_server(server: LspServerSettings) -> Result<LspServerSettings, String> {
    let name = server.name.trim().to_owned();
    if !valid_name(&name) {
        return Err(BAD_SERVER.into());
    }
    if server.languages.is_empty() {
        return Err(format!("サーバー「{name}」の言語がありません"));
    }
    for (i, language) in server.languages.iter().enumerate() {
        if !orca_language::is_language(language) {
            return Err(format!(
                "サーバー「{name}」の言語「{language}」は使えません"
            ));
        }
        if server.languages[..i].contains(language) {
            return Err(format!(
                "サーバー「{name}」の言語「{language}」が重なっています"
            ));
        }
    }
    let mount = optional_text("パスの対応", server.mount)?;
    if mount.as_ref().is_some_and(|m| !m.starts_with('/')) {
        return Err("パスの対応が正しくありません".into());
    }
    Ok(LspServerSettings {
        name,
        command: optional_text("起動コマンド", server.command)?,
        service: optional_text("サービス", server.service)?,
        mount,
        ..server
    })
}

/// A setting as it is saved: each server cleaned (`clean_server`), no name twice and no language taken by two servers. The key (`environment`, `project`) must be real, and `ssh_host` is checked as `ssh::check_host` checks a host.
fn clean(settings: LspRepoSettings) -> Result<LspRepoSettings, String> {
    if let Some(environment) = &settings.environment {
        check_text("接続先", environment)?;
    }
    check_text("プロジェクト", &settings.project)?;
    let ssh_host = optional_text("ssh の接続先", settings.ssh_host)?;
    if let Some(host) = &ssh_host {
        check_host(host)?;
    }
    let servers = settings
        .servers
        .into_iter()
        .map(clean_server)
        .collect::<Result<Vec<_>, _>>()?;
    for (i, server) in servers.iter().enumerate() {
        for earlier in &servers[..i] {
            if earlier.name == server.name {
                return Err(format!("サーバーの名前「{}」が重なっています", server.name));
            }
            if let Some(language) = server
                .languages
                .iter()
                .find(|language| earlier.languages.contains(language))
            {
                return Err(format!(
                    "言語「{language}」は「{}」と「{}」のどちらかだけが受け持てます",
                    earlier.name, server.name
                ));
            }
        }
    }
    Ok(LspRepoSettings {
        ssh_host,
        servers,
        ..settings
    })
}

/// Saves `settings` in the place of its key, or drops that entry when they are the unset ones, and answers what was saved.
fn set_settings(dir: &Path, settings: LspRepoSettings) -> Result<LspRepoSettings, String> {
    let settings = clean(settings)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(dir)?;
    let at = store
        .repositories
        .iter()
        .position(|r| r.environment == settings.environment && r.project == settings.project);
    if settings == LspRepoSettings::unset(settings.environment.as_deref(), &settings.project) {
        if let Some(i) = at {
            store.repositories.remove(i);
            save(dir, &store)?;
        }
    } else {
        match at {
            Some(i) => store.repositories[i] = settings.clone(),
            None => store.repositories.push(settings.clone()),
        }
        save(dir, &store)?;
    }
    Ok(settings)
}

// ---- the commands ----

/// Runs `command` in `worktree` by `route`, and answers what it printed up to `limit` bytes.
fn run_on(route: &Route, worktree: &str, command: &str, limit: usize) -> Result<Ran, String> {
    let control = match route {
        Route::Local => None,
        Route::Ssh { .. } => shared_control(),
    };
    let spawn = spawn_of(route, worktree, command, control.as_deref());
    run_process(&spawn.program, &spawn.args, Vec::new(), limit, TIMEOUT)
}

/// The path of a worktree: absolute, with no control character.
fn check_worktree(worktree: &str) -> Result<(), String> {
    if worktree.starts_with('/')
        && worktree.chars().count() <= MAX_TEXT
        && !worktree.chars().any(char::is_control)
    {
        Ok(())
    } else {
        Err(BAD_WORKTREE.into())
    }
}

/// What `plan_for` decided for one server of a worktree: the route to the worktree, the way the server is started in it, and the languages it takes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Planned {
    pub route: Route,
    pub launch: LspLaunch,
    pub languages: Vec<String>,
}

/// The route to `worktree` and the way the server `server` of its repository is started in it, read from it by `run` (a command, its folder's route and the most bytes to keep). A server that the settings do not have is an error, before anything is run.
fn plan_for(
    dir: &Path,
    environment: Option<&str>,
    project: &str,
    worktree: &str,
    server: &str,
    mut run: impl FnMut(&Route, &str, &str, usize) -> Result<Ran, String>,
) -> Result<Planned, String> {
    check_worktree(worktree)?;
    let settings = settings_of(dir, environment, project)?;
    let server = settings
        .server(server)
        .ok_or_else(|| format!("言語サーバー「{server}」の設定がありません"))?;
    let route = route_of(environment, project, &settings)?;
    let inputs = collect(
        &mut |command, limit| run(&route, worktree, command, limit),
        worktree,
        server.takes_ruby(),
    )?;
    let launch = decide(
        worktree,
        inputs.compose.as_deref(),
        inputs.gemfile_lock.as_deref(),
    )?;
    Ok(Planned {
        route,
        launch: resolve(launch, server, worktree),
        languages: server.languages.clone(),
    })
}

/// The way the server `server` is started for `worktree`, read from it by `run` (a command, its folder's route and the most bytes to keep).
fn launch_for(
    dir: &Path,
    environment: Option<&str>,
    project: &str,
    worktree: &str,
    server: &str,
    run: impl FnMut(&Route, &str, &str, usize) -> Result<Ran, String>,
) -> Result<LspLaunch, String> {
    plan_for(dir, environment, project, worktree, server, run).map(|planned| planned.launch)
}

/// The settings of the project `project` of `environment` (`None`: this machine): the saved ones, else the unset ones (A-34).
#[tauri::command]
pub async fn lsp_settings(
    app: AppHandle,
    environment: Option<String>,
    project: String,
) -> Result<LspRepoSettings, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || settings_of(&dir, environment.as_deref(), &project))
        .await
        .map_err(|e| e.to_string())?
}

/// Saves the settings of a repository (A-34) and answers them as saved. Settings that are the unset ones (ruby-lsp alone, as nothing saved has it) take the entry away.
#[tauri::command]
pub async fn lsp_settings_set(
    app: AppHandle,
    settings: LspRepoSettings,
) -> Result<LspRepoSettings, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || set_settings(&dir, settings))
        .await
        .map_err(|e| e.to_string())?
}

/// The name of the server of the project `project` of `environment` that takes `language` (a language of A-21), none when no server does (A-34).
#[tauri::command]
pub async fn lsp_server_for(
    app: AppHandle,
    environment: Option<String>,
    project: String,
    language: String,
) -> Result<Option<String>, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        settings_of(&dir, environment.as_deref(), &project)
            .map(|settings| server_for(&settings, &language))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How the server `server` is started in `worktree` of the project `project` of `environment` (`None`: this machine), read from the worktree just now, with the settings of its repository applied (A-34).
#[tauri::command]
pub async fn lsp_launch(
    app: AppHandle,
    environment: Option<String>,
    project: String,
    worktree: String,
    server: String,
) -> Result<LspLaunch, String> {
    check_server(&server)?;
    check_worktree(&worktree)?;
    check_worktree_of_project(&worktree, environment.as_deref(), &project).await?;
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        launch_for(
            &dir,
            environment.as_deref(),
            &project,
            &worktree,
            &server,
            run_on,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    const WT: &str = "/Users/x/orca/workspaces/app/feature";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tsunagiai-lsp-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn bind(source: &str, target: &str) -> Value {
        json!({"type": "bind", "source": source, "target": target, "bind": {"create_host_path": true}})
    }

    fn compose(services: Value) -> String {
        json!({"name": "app", "services": services}).to_string()
    }

    fn cand(service: &str, mount: &str) -> LspCandidate {
        LspCandidate {
            service: service.into(),
            mount: mount.into(),
        }
    }

    fn ran(code: i32, stdout: &str, stderr: &str) -> Ran {
        Ran {
            code: Some(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.into(),
        }
    }

    // ---- the compose configuration ----

    #[test]
    fn every_service_that_binds_the_worktree_is_a_candidate_in_the_order_of_their_names() {
        // What `docker compose config` prints for services that took one `volumes` from an anchor: each service holds the whole list.
        let shared = json!([bind(WT, "/app"), {"type": "volume", "source": "bundle", "target": "/bundle", "volume": {}}]);
        let config = compose(json!({
            "worker": {"image": "app", "volumes": shared},
            "app": {"image": "app", "volumes": shared},
            "db": {"image": "mysql", "volumes": [{"type": "volume", "source": "data", "target": "/var/lib/mysql", "volume": {}}]},
        }));
        assert_eq!(
            candidates(WT, &config).unwrap(),
            vec![cand("app", "/app"), cand("worker", "/app")]
        );
    }

    #[test]
    fn a_mount_that_is_not_a_bind_of_the_worktree_is_no_candidate() {
        let config = compose(json!({
            "named": {"volumes": [{"type": "volume", "source": WT, "target": "/app", "volume": {}}]},
            "tmp": {"volumes": [{"type": "tmpfs", "target": "/app"}]},
            "inner": {"volumes": [bind(&format!("{WT}/src"), "/app/src")]},
            "outer": {"volumes": [bind("/Users/x/orca/workspaces/app", "/work")]},
            "sibling": {"volumes": [bind(&format!("{WT}-2"), "/app")]},
            "relative": {"volumes": [bind(WT, "app")]},
            "bare": {"image": "x"},
        }));
        assert_eq!(candidates(WT, &config).unwrap(), vec![]);
    }

    #[test]
    fn a_slash_at_the_end_of_the_source_or_of_the_worktree_makes_no_difference() {
        let config = compose(json!({"app": {"volumes": [bind(&format!("{WT}/"), "/app")]}}));
        assert_eq!(candidates(WT, &config).unwrap(), vec![cand("app", "/app")]);
        let config = compose(json!({"app": {"volumes": [bind(WT, "/app")]}}));
        assert_eq!(
            candidates(&format!("{WT}/"), &config).unwrap(),
            vec![cand("app", "/app")]
        );
        let config = compose(json!({"app": {"volumes": [bind("/", "/host")]}}));
        assert_eq!(
            candidates("/", &config).unwrap(),
            vec![cand("app", "/host")]
        );
    }

    #[test]
    fn a_service_that_mounts_the_worktree_twice_is_listed_once_at_its_first_mount() {
        let config = compose(json!({"app": {"volumes": [bind(WT, "/app"), bind(WT, "/again")]}}));
        assert_eq!(candidates(WT, &config).unwrap(), vec![cand("app", "/app")]);
    }

    #[test]
    fn a_name_that_could_be_taken_for_an_option_is_no_candidate() {
        let config = compose(
            json!({"-oProxyCommand=x": {"volumes": [bind(WT, "/app")]}, "": {"volumes": [bind(WT, "/app")]}}),
        );
        assert_eq!(candidates(WT, &config).unwrap(), vec![]);
    }

    #[test]
    fn a_configuration_without_services_has_no_candidate_and_a_broken_one_is_an_error() {
        assert_eq!(candidates(WT, r#"{"name": "app"}"#).unwrap(), vec![]);
        assert_eq!(candidates(WT, "{}").unwrap(), vec![]);
        assert_eq!(candidates(WT, "not json").unwrap_err(), BAD_COMPOSE);
        assert_eq!(candidates(WT, "[1]").unwrap_err(), BAD_COMPOSE);
        assert_eq!(candidates(WT, "").unwrap_err(), BAD_COMPOSE);
    }

    // ---- the Gemfile.lock ----

    const LOCK: &str = "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.1.0)\n    ruby-lsp (0.26.9)\n      language_server-protocol (~> 3.17.0)\n    ruby-lsp-rails (0.4.0)\n\nPLATFORMS\n  arm64-darwin\n\nDEPENDENCIES\n  rack\n  ruby-lsp (~> 0.26)\n";

    #[test]
    fn a_gemfile_lock_with_ruby_lsp_as_a_spec_or_a_dependency_has_it() {
        assert!(has_ruby_lsp(LOCK));
        assert!(has_ruby_lsp("GEM\n  specs:\n    ruby-lsp (0.26.9)\n"));
        assert!(has_ruby_lsp("DEPENDENCIES\n  ruby-lsp\n"));
        assert!(has_ruby_lsp("DEPENDENCIES\n  ruby-lsp!\n"));
        assert!(has_ruby_lsp("DEPENDENCIES\r\n  ruby-lsp (~> 0.26)\r\n"));
    }

    #[test]
    fn another_gem_or_a_url_that_holds_the_name_is_not_ruby_lsp() {
        assert!(!has_ruby_lsp(""));
        assert!(!has_ruby_lsp("GEM\n  specs:\n    ruby-lsp-rails (0.4.0)\n    ruby-lsp-rspec (0.1.0)\n    my-ruby-lsp (1.0)\n"));
        assert!(!has_ruby_lsp(
            "GIT\n  remote: https://github.com/Shopify/ruby-lsp.git\n  revision: abc\n"
        ));
        assert!(!has_ruby_lsp("DEPENDENCIES\n  ruby-lsp-rails\n"));
    }

    // ---- the decision ----

    #[test]
    fn compose_comes_first_then_the_host_then_nothing() {
        let config = compose(json!({"app": {"volumes": [bind(WT, "/app")]}}));
        assert_eq!(
            decide(WT, Some(&config), Some(LOCK)).unwrap(),
            Launch::Compose(vec![cand("app", "/app")])
        );
        assert_eq!(
            decide(WT, Some(&config), None).unwrap(),
            Launch::Compose(vec![cand("app", "/app")])
        );
        // A compose file whose services do not mount the worktree leaves it to the Gemfile.lock.
        let other = compose(json!({"db": {"image": "mysql"}}));
        assert_eq!(decide(WT, Some(&other), Some(LOCK)).unwrap(), Launch::Host);
        assert_eq!(decide(WT, None, Some(LOCK)).unwrap(), Launch::Host);
        assert_eq!(
            decide(WT, Some(&other), Some("GEM\n  specs:\n    rack (3.1.0)\n")).unwrap(),
            Launch::Unavailable
        );
        assert_eq!(decide(WT, None, None).unwrap(), Launch::Unavailable);
    }

    #[test]
    fn a_broken_compose_configuration_is_an_error_and_not_a_fall_through() {
        assert_eq!(
            decide(WT, Some("nope"), Some(LOCK)).unwrap_err(),
            BAD_COMPOSE
        );
    }

    // ---- the settings applied ----

    fn settings() -> LspRepoSettings {
        LspRepoSettings::unset(None, "repo-1")
    }

    fn server() -> LspServerSettings {
        LspServerSettings::ruby_lsp()
    }

    fn server_taking(languages: &[&str]) -> LspServerSettings {
        LspServerSettings {
            name: "other".into(),
            languages: languages.iter().map(|l| (*l).to_owned()).collect(),
            ..server()
        }
    }

    #[test]
    fn compose_uses_the_first_service_and_its_mount_and_the_command_for_it() {
        let launch = Launch::Compose(vec![cand("app", "/app"), cand("worker", "/srv")]);
        assert_eq!(
            resolve(launch, &server(), WT),
            LspLaunch {
                method: LspMethod::Compose,
                candidates: vec![cand("app", "/app"), cand("worker", "/srv")],
                service: Some("app".into()),
                command: Some("docker compose exec -T -w /app app bundle exec ruby-lsp".into()),
                mount: Some("/app".into()),
            }
        );
    }

    #[test]
    fn the_service_of_the_settings_is_used_when_it_is_a_candidate_and_ignored_when_it_is_not() {
        let launch = Launch::Compose(vec![cand("app", "/app"), cand("worker", "/srv")]);
        let chosen = LspServerSettings {
            service: Some("worker".into()),
            ..server()
        };
        let got = resolve(launch.clone(), &chosen, WT);
        assert_eq!(got.service.as_deref(), Some("worker"));
        assert_eq!(got.mount.as_deref(), Some("/srv"));
        assert_eq!(
            got.command.as_deref(),
            Some("docker compose exec -T -w /srv worker bundle exec ruby-lsp")
        );
        let stale = LspServerSettings {
            service: Some("gone".into()),
            ..server()
        };
        assert_eq!(resolve(launch, &stale, WT).service.as_deref(), Some("app"));
    }

    #[test]
    fn a_service_name_is_quoted_in_the_command() {
        let launch = Launch::Compose(vec![cand("a b;c", "/app")]);
        assert_eq!(
            resolve(launch, &server(), WT).command.as_deref(),
            Some("docker compose exec -T -w /app 'a b;c' bundle exec ruby-lsp")
        );
    }

    #[test]
    fn a_mount_is_quoted_in_the_command() {
        let launch = Launch::Compose(vec![cand("app", "/my work/it's;x")]);
        let got = resolve(launch, &server(), WT);
        assert_eq!(
            got.command.as_deref(),
            Some(r"docker compose exec -T -w '/my work/it'\''s;x' app bundle exec ruby-lsp")
        );
        assert_eq!(got.mount.as_deref(), Some("/my work/it's;x"));
    }

    #[test]
    fn the_command_and_the_mount_of_the_settings_replace_the_decided_ones() {
        let launch = Launch::Compose(vec![cand("app", "/app")]);
        let over = LspServerSettings {
            command: Some("docker compose exec -T web ruby-lsp".into()),
            mount: Some("/workspace".into()),
            ..server()
        };
        let got = resolve(launch, &over, WT);
        assert_eq!(got.method, LspMethod::Compose);
        assert_eq!(got.service.as_deref(), Some("app"));
        assert_eq!(
            got.command.as_deref(),
            Some("docker compose exec -T web ruby-lsp")
        );
        assert_eq!(got.mount.as_deref(), Some("/workspace"));
    }

    #[test]
    fn the_host_runs_bundler_in_the_worktree_and_sees_the_worktree_as_it_is() {
        assert_eq!(
            resolve(Launch::Host, &server(), WT),
            LspLaunch {
                method: LspMethod::Host,
                candidates: vec![],
                service: None,
                command: Some("bundle exec ruby-lsp".into()),
                mount: Some(WT.into()),
            }
        );
    }

    #[test]
    fn nothing_decided_has_no_command_unless_the_settings_give_one() {
        assert_eq!(
            resolve(Launch::Unavailable, &server(), WT),
            LspLaunch {
                method: LspMethod::None,
                candidates: vec![],
                service: None,
                command: None,
                mount: None,
            }
        );
        let over = LspServerSettings {
            command: Some("ruby-lsp".into()),
            ..server()
        };
        let got = resolve(Launch::Unavailable, &over, WT);
        assert_eq!(got.method, LspMethod::None);
        assert_eq!(got.command.as_deref(), Some("ruby-lsp"));
        assert_eq!(got.mount.as_deref(), Some(WT));
    }

    #[test]
    fn a_server_that_does_not_take_ruby_has_no_command_of_its_own_but_the_same_service_and_mount() {
        let launch = Launch::Compose(vec![cand("app", "/app"), cand("worker", "/srv")]);
        let got = resolve(launch.clone(), &server_taking(&["typescript"]), WT);
        assert_eq!(
            got,
            LspLaunch {
                method: LspMethod::Compose,
                candidates: vec![cand("app", "/app"), cand("worker", "/srv")],
                service: Some("app".into()),
                command: None,
                mount: Some("/app".into()),
            }
        );
        // The service and the command of its settings are used as they are for ruby-lsp.
        let over = LspServerSettings {
            service: Some("worker".into()),
            command: Some(
                "docker compose exec -T worker typescript-language-server --stdio".into(),
            ),
            ..server_taking(&["typescript"])
        };
        let got = resolve(launch, &over, WT);
        assert_eq!(got.service.as_deref(), Some("worker"));
        assert_eq!(got.mount.as_deref(), Some("/srv"));
        assert_eq!(
            got.command.as_deref(),
            Some("docker compose exec -T worker typescript-language-server --stdio")
        );
        // A host with a Gemfile.lock decides nothing for it.
        let got = resolve(Launch::Host, &server_taking(&["python"]), WT);
        assert_eq!(got.command, None);
        let over = LspServerSettings {
            command: Some("pyright-langserver --stdio".into()),
            ..server_taking(&["python"])
        };
        let got = resolve(Launch::Unavailable, &over, WT);
        assert_eq!(got.command.as_deref(), Some("pyright-langserver --stdio"));
        assert_eq!(got.mount.as_deref(), Some(WT));
    }

    #[test]
    fn a_server_that_takes_ruby_among_others_has_the_way_of_ruby_lsp() {
        let got = resolve(Launch::Host, &server_taking(&["python", "ruby"]), WT);
        assert_eq!(got.command.as_deref(), Some("bundle exec ruby-lsp"));
    }

    // ---- the server of a language ----

    #[test]
    fn the_server_that_takes_a_language_is_found_by_it() {
        let repo = LspRepoSettings {
            servers: vec![
                server(),
                LspServerSettings {
                    name: "ts".into(),
                    languages: vec!["typescript".into(), "javascript".into()],
                    ..server()
                },
            ],
            ..settings()
        };
        assert_eq!(server_for(&repo, "ruby").as_deref(), Some("ruby-lsp"));
        assert_eq!(server_for(&repo, "javascript").as_deref(), Some("ts"));
        assert_eq!(server_for(&repo, "typescript").as_deref(), Some("ts"));
        assert_eq!(server_for(&repo, "python"), None);
        assert_eq!(server_for(&repo, ""), None);
        // A repository with nothing saved has ruby-lsp for ruby.
        assert_eq!(server_for(&settings(), "ruby").as_deref(), Some("ruby-lsp"));
        assert_eq!(server_for(&settings(), "typescript"), None);
    }

    // ---- the way to the worktree ----

    #[test]
    fn shell_quote_leaves_a_plain_word_and_quotes_everything_else() {
        assert_eq!(shell_quote("app-1_web.x/y:z,@+"), "app-1_web.x/y:z,@+");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(shell_quote("a;b&c|d>e`f"), "'a;b&c|d>e`f'");
        assert_eq!(shell_quote("a\nb"), "'a\nb'");
        assert_eq!(shell_quote("~"), "'~'");
        assert_eq!(shell_quote("a=b"), "'a=b'");
    }

    #[test]
    fn the_script_adds_the_docker_folders_to_the_path_and_goes_to_the_quoted_worktree() {
        assert_eq!(
            script("/w/a b", "bundle exec ruby-lsp"),
            "PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"; export PATH; cd '/w/a b' && bundle exec ruby-lsp"
        );
        // A path that tries to end its quote stays one word.
        assert_eq!(
            script("/w/'; rm -rf ~; '", "true"),
            "PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin\"; export PATH; cd '/w/'\\''; rm -rf ~; '\\''' && true"
        );
    }

    #[test]
    fn on_this_machine_the_script_is_the_argument_of_sh() {
        let spawn = spawn_of(&Route::Local, "/w", "true", None);
        assert_eq!(spawn.program, "/bin/sh");
        assert_eq!(spawn.args, vec!["-c".to_owned(), script("/w", "true")]);
    }

    #[test]
    fn by_ssh_the_host_is_one_element_after_the_dashes_and_the_quoted_script_is_run_by_sh() {
        let route = Route::Ssh { host: "dev".into() };
        let spawn = spawn_of(&route, "/w/it's", "bundle exec ruby-lsp", Some("/c"));
        assert_eq!(spawn.program, "/usr/bin/ssh");
        let remote = format!(
            "sh -c {}",
            shell_quote(&script("/w/it's", "bundle exec ruby-lsp"))
        );
        assert_eq!(spawn.args, ssh_args("dev", Some("/c"), &remote));
        assert_eq!(
            &spawn.args[spawn.args.len() - 3..],
            ["--", "dev", remote.as_str()]
        );
    }

    #[test]
    fn a_worktree_of_this_machine_goes_local_and_one_of_an_environment_needs_its_host() {
        let plain = settings();
        assert_eq!(route_of(None, "repo-1", &plain), Ok(Route::Local));
        assert_eq!(
            route_of(Some("srv"), "repo-1", &plain),
            Err(NO_SSH_HOST.into())
        );
        let with_host = LspRepoSettings {
            ssh_host: Some("dev".into()),
            ..plain.clone()
        };
        assert_eq!(
            route_of(Some("srv"), "repo-1", &with_host),
            Ok(Route::Ssh { host: "dev".into() })
        );
        // The host of an environment's settings is not used for this machine.
        assert_eq!(route_of(None, "repo-1", &with_host), Ok(Route::Local));
    }

    #[test]
    fn a_host_that_ssh_would_take_for_an_option_is_refused() {
        let evil = LspRepoSettings {
            ssh_host: Some("-oProxyCommand=x".into()),
            ..settings()
        };
        assert!(route_of(Some("srv"), "repo-1", &evil).is_err());
        let spaced = LspRepoSettings {
            ssh_host: Some("a b".into()),
            ..settings()
        };
        assert!(route_of(Some("srv"), "repo-1", &spaced).is_err());
    }

    #[test]
    fn a_project_of_an_ssh_host_of_orca_is_refused() {
        assert_eq!(
            route_of(None, "ssh:dev", &LspRepoSettings::unset(None, "ssh:dev")),
            Err(ON_SSH_HOST.into())
        );
    }

    #[test]
    fn the_path_of_a_worktree_is_absolute_and_has_no_control_character() {
        assert_eq!(check_worktree(WT), Ok(()));
        assert_eq!(check_worktree("rel/path"), Err(BAD_WORKTREE.into()));
        assert_eq!(check_worktree(""), Err(BAD_WORKTREE.into()));
        assert_eq!(check_worktree("/a\nb"), Err(BAD_WORKTREE.into()));
    }

    // ---- reading the worktree ----

    #[test]
    fn collect_reads_the_compose_configuration_and_the_gemfile_lock() {
        let mut commands = Vec::new();
        let inputs = collect(
            &mut |command, _limit| {
                commands.push(command.to_owned());
                Ok(if command.contains("docker compose") {
                    ran(0, "{\"services\":{}}", "")
                } else {
                    ran(0, LOCK, "")
                })
            },
            WT,
            true,
        )
        .unwrap();
        assert_eq!(
            inputs,
            Inputs {
                compose: Some("{\"services\":{}}".into()),
                gemfile_lock: Some(LOCK.into()),
            }
        );
        assert_eq!(commands.len(), 2);
        assert!(commands[0].ends_with("docker compose config --format json; fi"));
        for name in COMPOSE_FILES {
            assert!(commands[0].contains(&format!("[ -f {name} ]")), "{name}");
        }
        assert!(commands[1].contains("cat Gemfile.lock"));
    }

    #[test]
    fn a_worktree_with_neither_has_neither() {
        let inputs = collect(&mut |_, _| Ok(ran(0, "", "")), WT, true).unwrap();
        assert_eq!(
            inputs,
            Inputs {
                compose: None,
                gemfile_lock: None
            }
        );
    }

    #[test]
    fn a_failed_docker_is_an_error_with_the_last_line_of_its_message() {
        let err = collect(
            &mut |command, _| {
                Ok(if command.contains("docker compose") {
                    ran(127, "", "sh: docker: not found\n")
                } else {
                    ran(0, "", "")
                })
            },
            WT,
            true,
        )
        .unwrap_err();
        assert_eq!(err, format!("{NOT_COMPOSE}: sh: docker: not found"));
    }

    #[test]
    fn a_failed_connection_is_told_as_one() {
        let err = collect(
            &mut |_, _| {
                Ok(ran(
                    255,
                    "",
                    "ssh: connect to host dev port 22: Connection refused",
                ))
            },
            WT,
            true,
        )
        .unwrap_err();
        assert!(err.starts_with("接続できません"), "{err}");
        let err = collect(&mut |_, _| Err("ssh を実行できません".into()), WT, true).unwrap_err();
        assert_eq!(err, "ssh を実行できません");
    }

    #[test]
    fn an_answer_over_the_limit_or_not_utf8_is_an_error() {
        let big = "x".repeat(READ_MAX + 1);
        let err = collect(&mut |_, _| Ok(ran(0, &big, "")), WT, true).unwrap_err();
        assert_eq!(err, TOO_LARGE);
        let err = collect(
            &mut |_, _| {
                Ok(Ran {
                    code: Some(0),
                    stdout: vec![0xff, 0xfe],
                    stderr: String::new(),
                })
            },
            WT,
            true,
        )
        .unwrap_err();
        assert_eq!(err, NOT_UTF8);
    }

    #[test]
    fn collect_asks_for_one_byte_more_than_it_accepts() {
        let mut limits = Vec::new();
        collect(
            &mut |_, limit| {
                limits.push(limit);
                Ok(ran(0, "", ""))
            },
            WT,
            true,
        )
        .unwrap();
        assert_eq!(limits, vec![READ_MAX + 1, READ_MAX + 1]);
    }

    #[test]
    fn the_gemfile_lock_is_not_read_for_a_server_that_does_not_take_ruby() {
        let mut commands = Vec::new();
        let inputs = collect(
            &mut |command, _| {
                commands.push(command.to_owned());
                Ok(if command.contains("docker compose") {
                    ran(0, "", "")
                } else {
                    ran(0, LOCK, "")
                })
            },
            WT,
            false,
        )
        .unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(inputs.gemfile_lock, None);
    }

    #[test]
    fn the_gemfile_lock_is_not_read_when_a_service_of_compose_mounts_the_worktree() {
        let config = compose(json!({"app": {"volumes": [bind(WT, "/app")]}}));
        let mut commands = Vec::new();
        let inputs = collect(
            &mut |command, _| {
                commands.push(command.to_owned());
                Ok(ran(0, &config, ""))
            },
            WT,
            true,
        )
        .unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(inputs.compose.as_deref(), Some(config.as_str()));
        assert_eq!(inputs.gemfile_lock, None);
        // A compose file whose services do not mount it leaves the decision to the lock, which is read.
        let other = compose(json!({"db": {"image": "mysql"}}));
        let mut commands = Vec::new();
        collect(
            &mut |command, _| {
                commands.push(command.to_owned());
                Ok(ran(0, &other, ""))
            },
            WT,
            true,
        )
        .unwrap();
        assert_eq!(commands.len(), 2);
        // A broken one is the error it is for `decide`.
        let err = collect(&mut |_, _| Ok(ran(0, "nope", "")), WT, true).unwrap_err();
        assert_eq!(err, BAD_COMPOSE);
    }

    // ---- the settings file ----

    fn read_file(dir: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("lsp-settings.json")).unwrap())
            .unwrap()
    }

    fn typescript() -> LspServerSettings {
        LspServerSettings {
            name: "ts".into(),
            languages: vec!["typescript".into(), "javascript".into()],
            auto_start: false,
            command: Some("typescript-language-server --stdio".into()),
            mount: Some("/workspace".into()),
            service: Some("web".into()),
        }
    }

    #[test]
    fn nothing_saved_gives_the_unset_settings_with_ruby_lsp_and_a_save_is_read_back() {
        let dir = temp_dir("roundtrip");
        let unset = settings_of(&dir, None, "r1").unwrap();
        assert_eq!(unset, LspRepoSettings::unset(None, "r1"));
        assert_eq!(
            unset.servers,
            vec![LspServerSettings {
                name: "ruby-lsp".into(),
                languages: vec!["ruby".into()],
                auto_start: true,
                command: None,
                mount: None,
                service: None,
            }]
        );
        let saved = set_settings(
            &dir,
            LspRepoSettings {
                ssh_host: Some("dev".into()),
                servers: vec![
                    LspServerSettings {
                        auto_start: false,
                        ..server()
                    },
                    typescript(),
                ],
                ..LspRepoSettings::unset(Some("srv"), "r1")
            },
        )
        .unwrap();
        assert_eq!(settings_of(&dir, Some("srv"), "r1").unwrap(), saved);
        // The same project key of this machine is another repository.
        assert_eq!(
            settings_of(&dir, None, "r1").unwrap(),
            LspRepoSettings::unset(None, "r1")
        );
        assert_eq!(
            settings_of(&dir, Some("srv"), "r2").unwrap(),
            LspRepoSettings::unset(Some("srv"), "r2")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_file_is_of_version_2_with_the_servers_of_each_repository_that_differs() {
        let dir = temp_dir("shape");
        set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![LspServerSettings {
                    auto_start: false,
                    ..server()
                }],
                ..LspRepoSettings::unset(None, "r1")
            },
        )
        .unwrap();
        set_settings(
            &dir,
            LspRepoSettings {
                ssh_host: Some("dev".into()),
                ..LspRepoSettings::unset(Some("srv"), "r1")
            },
        )
        .unwrap();
        set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![
                    LspServerSettings {
                        command: Some("x".into()),
                        ..server()
                    },
                    typescript(),
                ],
                ..LspRepoSettings::unset(None, "r1")
            },
        )
        .unwrap();
        let file = read_file(&dir);
        assert_eq!(file["version"], 2);
        assert_eq!(file["repositories"].as_array().unwrap().len(), 2);
        assert_eq!(
            file["repositories"][0],
            json!({
                "environment": null, "project": "r1", "sshHost": null,
                "servers": [
                    {"name": "ruby-lsp", "languages": ["ruby"], "autoStart": true, "command": "x", "mount": null, "service": null},
                    {"name": "ts", "languages": ["typescript", "javascript"], "autoStart": false, "command": "typescript-language-server --stdio", "mount": "/workspace", "service": "web"},
                ]
            })
        );
        assert!(!dir.join("lsp-settings.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_of_version_1_is_read_as_a_repository_with_one_ruby_lsp_and_saved_as_version_2() {
        let dir = temp_dir("v1");
        std::fs::create_dir_all(&dir).unwrap();
        let old = json!({"version": 1, "repositories": [
            {"environment": "srv", "project": "r1", "autoStart": false, "command": "docker compose exec -T web ruby-lsp", "mount": "/workspace", "service": "web", "sshHost": "dev"},
            {"environment": null, "project": "r2", "autoStart": true, "command": null, "mount": null, "service": null, "sshHost": null},
        ]});
        std::fs::write(dir.join("lsp-settings.json"), old.to_string()).unwrap();
        assert_eq!(
            settings_of(&dir, Some("srv"), "r1").unwrap(),
            LspRepoSettings {
                ssh_host: Some("dev".into()),
                servers: vec![LspServerSettings {
                    auto_start: false,
                    command: Some("docker compose exec -T web ruby-lsp".into()),
                    mount: Some("/workspace".into()),
                    service: Some("web".into()),
                    ..server()
                }],
                ..LspRepoSettings::unset(Some("srv"), "r1")
            }
        );
        assert_eq!(
            settings_of(&dir, None, "r2").unwrap(),
            LspRepoSettings::unset(None, "r2")
        );
        // Nothing is written by a read, and the next save writes every repository as version 2.
        assert_eq!(read_file(&dir)["version"], 1);
        set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![server(), typescript()],
                ..LspRepoSettings::unset(None, "r3")
            },
        )
        .unwrap();
        let file = read_file(&dir);
        assert_eq!(file["version"], 2);
        assert_eq!(file["repositories"].as_array().unwrap().len(), 3);
        assert_eq!(
            file["repositories"][0]["servers"],
            json!([{"name": "ruby-lsp", "languages": ["ruby"], "autoStart": false, "command": "docker compose exec -T web ruby-lsp", "mount": "/workspace", "service": "web"}])
        );
        assert_eq!(file["repositories"][0]["sshHost"], "dev");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn settings_that_are_the_unset_ones_take_their_entry_away() {
        let dir = temp_dir("drop");
        set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![LspServerSettings {
                    command: Some("x".into()),
                    ..server()
                }],
                ..settings()
            },
        )
        .unwrap();
        set_settings(&dir, settings()).unwrap();
        assert_eq!(read_file(&dir)["repositories"], json!([]));
        // Settings never saved and nothing set leave no file.
        let none = temp_dir("drop-none");
        set_settings(&none, settings()).unwrap();
        assert!(!none.join("lsp-settings.json").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_repository_may_have_no_server_and_that_is_kept() {
        let dir = temp_dir("none");
        let saved = set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![],
                ..settings()
            },
        )
        .unwrap();
        assert_eq!(saved.servers, vec![]);
        assert_eq!(settings_of(&dir, None, "repo-1").unwrap().servers, vec![]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn texts_are_trimmed_and_an_empty_one_is_not_set() {
        let dir = temp_dir("clean");
        let saved = set_settings(
            &dir,
            LspRepoSettings {
                ssh_host: Some(" dev ".into()),
                servers: vec![LspServerSettings {
                    name: "  ruby-lsp ".into(),
                    command: Some("  ruby-lsp  ".into()),
                    mount: Some("   ".into()),
                    service: Some("".into()),
                    ..server()
                }],
                ..settings()
            },
        )
        .unwrap();
        assert_eq!(saved.ssh_host.as_deref(), Some("dev"));
        assert_eq!(saved.servers[0].name, "ruby-lsp");
        assert_eq!(saved.servers[0].command.as_deref(), Some("ruby-lsp"));
        assert_eq!(saved.servers[0].mount, None);
        assert_eq!(saved.servers[0].service, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn with_server(change: impl FnOnce(&mut LspServerSettings)) -> LspRepoSettings {
        let mut s = server();
        change(&mut s);
        LspRepoSettings {
            servers: vec![s],
            ..settings()
        }
    }

    #[test]
    fn a_setting_that_is_not_usable_is_refused_and_nothing_is_written() {
        let dir = temp_dir("refuse");
        let bad = |change: fn(&mut LspRepoSettings)| {
            let mut s = settings();
            change(&mut s);
            set_settings(&dir, s)
        };
        let bad_server =
            |change: fn(&mut LspServerSettings)| set_settings(&dir, with_server(change));
        assert!(bad(|s| s.project = String::new()).is_err());
        assert!(bad(|s| s.project = "a\nb".into()).is_err());
        assert!(bad(|s| s.environment = Some(String::new())).is_err());
        assert!(bad(|s| s.ssh_host = Some("-oProxyCommand=x".into())).is_err());
        assert!(bad(|s| s.ssh_host = Some("a b".into())).is_err());
        assert!(bad_server(|s| s.command = Some("a\nb".into())).is_err());
        assert!(bad_server(|s| s.command = Some("x".repeat(MAX_TEXT + 1))).is_err());
        assert!(bad_server(|s| s.mount = Some("relative".into())).is_err());
        assert!(bad_server(|s| s.service = Some("a\tb".into())).is_err());
        assert!(!dir.join("lsp-settings.json").exists());
    }

    #[test]
    fn the_name_of_a_server_is_not_empty_has_no_control_character_and_is_at_most_64_characters() {
        let dir = temp_dir("names");
        let name = |name: String| set_settings(&dir, with_server(|s| s.name = name));
        assert_eq!(name(String::new()), Err(BAD_SERVER.into()));
        assert_eq!(name("   ".into()), Err(BAD_SERVER.into()));
        assert_eq!(name("a\nb".into()), Err(BAD_SERVER.into()));
        assert_eq!(name("a\u{7f}b".into()), Err(BAD_SERVER.into()));
        assert_eq!(name("x".repeat(65)), Err(BAD_SERVER.into()));
        assert!(name("x".repeat(64)).is_ok());
        // Characters are counted, not bytes.
        assert!(name("あ".repeat(64)).is_ok());
        assert_eq!(name("あ".repeat(65)), Err(BAD_SERVER.into()));
        assert_eq!(check_server("ruby-lsp"), Ok(()));
        assert_eq!(check_server(""), Err(BAD_SERVER.into()));
        assert_eq!(check_server("a\nb"), Err(BAD_SERVER.into()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_languages_of_a_server_are_one_or_more_languages_of_a21_with_no_repeat() {
        let dir = temp_dir("languages");
        let languages = |languages: &[&str]| {
            let languages: Vec<String> = languages.iter().map(|l| (*l).to_owned()).collect();
            set_settings(&dir, with_server(|s| s.languages = languages))
        };
        assert!(languages(&[]).unwrap_err().contains("言語がありません"));
        assert!(languages(&["cobol-2000"])
            .unwrap_err()
            .contains("「cobol-2000」は使えません"));
        assert!(languages(&["Ruby"]).is_err());
        assert!(languages(&[" ruby"]).is_err());
        assert!(languages(&["ruby", "python", "ruby"])
            .unwrap_err()
            .contains("「ruby」が重なっています"));
        assert!(languages(&["ruby", "python", "plaintext"]).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_name_is_used_once_and_a_language_is_taken_by_one_server_of_a_repository() {
        let dir = temp_dir("unique");
        let two = |second: LspServerSettings| {
            set_settings(
                &dir,
                LspRepoSettings {
                    servers: vec![server(), second],
                    ..settings()
                },
            )
        };
        let err = two(LspServerSettings {
            languages: vec!["python".into()],
            ..server()
        })
        .unwrap_err();
        assert!(err.contains("「ruby-lsp」が重なっています"), "{err}");
        // The trimmed name is the one that is compared.
        assert!(two(LspServerSettings {
            name: " ruby-lsp ".into(),
            languages: vec!["python".into()],
            ..server()
        })
        .is_err());
        let err = two(LspServerSettings {
            name: "other".into(),
            languages: vec!["python".into(), "ruby".into()],
            ..server()
        })
        .unwrap_err();
        assert!(err.contains("「ruby」は「ruby-lsp」と「other」"), "{err}");
        assert!(!dir.join("lsp-settings.json").exists());
        // The same language in two repositories is no matter.
        assert!(two(typescript()).is_ok());
        set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![typescript()],
                ..LspRepoSettings::unset(None, "repo-2")
            },
        )
        .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_broken_file_or_one_of_another_version_is_an_error_that_names_the_file_and_is_not_replaced()
    {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        for text in [
            "not json",
            r#"{"version":3,"repositories":[]}"#,
            r#"{"version":0,"repositories":[]}"#,
            r#"{"repositories":[]}"#,
            r#"{"version":1}"#,
            r#"{"version":2,"repositories":[{"project":"r"}]}"#,
        ] {
            std::fs::write(dir.join("lsp-settings.json"), text).unwrap();
            let err = settings_of(&dir, None, "r1").unwrap_err();
            assert!(err.contains("lsp-settings.json"), "{err}");
            assert!(set_settings(
                &dir,
                LspRepoSettings {
                    servers: vec![LspServerSettings {
                        command: Some("x".into()),
                        ..server()
                    }],
                    ..settings()
                }
            )
            .is_err());
            assert_eq!(
                std::fs::read_to_string(dir.join("lsp-settings.json")).unwrap(),
                text
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_save_leaves_the_saved_settings() {
        let dir = temp_dir("atomic");
        let with_command = |command: &str| LspRepoSettings {
            servers: vec![LspServerSettings {
                command: Some(command.into()),
                ..server()
            }],
            ..settings()
        };
        set_settings(&dir, with_command("one")).unwrap();
        // A folder in the temporary file's place makes the write fail before the rename.
        std::fs::create_dir(dir.join("lsp-settings.json.tmp")).unwrap();
        assert!(set_settings(&dir, with_command("two")).is_err());
        assert_eq!(
            settings_of(&dir, None, "repo-1").unwrap().servers[0]
                .command
                .as_deref(),
            Some("one")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // ---- the whole decision for a worktree ----

    #[test]
    fn launch_for_reads_the_worktree_by_the_route_and_applies_the_settings_of_the_server() {
        let dir = temp_dir("launch");
        set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![LspServerSettings {
                    service: Some("worker".into()),
                    ..server()
                }],
                ..settings()
            },
        )
        .unwrap();
        let config = compose(
            json!({"app": {"volumes": [bind(WT, "/app")]}, "worker": {"volumes": [bind(WT, "/srv")]}}),
        );
        let mut seen = Vec::new();
        let got = launch_for(
            &dir,
            None,
            "repo-1",
            WT,
            "ruby-lsp",
            |route, worktree, command, _| {
                seen.push((route.clone(), worktree.to_owned()));
                Ok(if command.contains("docker compose") {
                    ran(0, &config, "")
                } else {
                    ran(0, "", "")
                })
            },
        )
        .unwrap();
        assert_eq!(got.method, LspMethod::Compose);
        assert_eq!(got.service.as_deref(), Some("worker"));
        assert_eq!(got.mount.as_deref(), Some("/srv"));
        assert_eq!(got.candidates.len(), 2);
        // Only the compose configuration is read: a service mounts the worktree, so the lock decides nothing.
        assert_eq!(seen, vec![(Route::Local, WT.to_owned())]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn plan_for_a_server_that_does_not_take_ruby_never_reads_the_gemfile_lock_and_gives_its_languages(
    ) {
        let dir = temp_dir("launch-ts");
        set_settings(
            &dir,
            LspRepoSettings {
                servers: vec![server(), typescript()],
                ..settings()
            },
        )
        .unwrap();
        let mut commands = Vec::new();
        let got = plan_for(&dir, None, "repo-1", WT, "ts", |_, _, command, _| {
            commands.push(command.to_owned());
            Ok(ran(0, "", ""))
        })
        .unwrap();
        assert_eq!(commands.len(), 1);
        assert!(commands[0].contains("docker compose config"));
        assert_eq!(got.route, Route::Local);
        assert_eq!(got.launch.method, LspMethod::None);
        assert_eq!(
            got.launch.command.as_deref(),
            Some("typescript-language-server --stdio")
        );
        assert_eq!(got.launch.mount.as_deref(), Some("/workspace"));
        assert_eq!(got.languages, vec!["typescript", "javascript"]);
        // The same worktree for ruby-lsp reads the Gemfile.lock too.
        let mut commands = Vec::new();
        plan_for(&dir, None, "repo-1", WT, "ruby-lsp", |_, _, command, _| {
            commands.push(command.to_owned());
            Ok(ran(0, "", ""))
        })
        .unwrap();
        assert_eq!(commands.len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_server_that_the_settings_do_not_have_is_an_error_before_anything_is_run() {
        let dir = temp_dir("launch-none");
        let mut runs = 0;
        let err = launch_for(&dir, None, "repo-1", WT, "gone", |_, _, _, _| {
            runs += 1;
            Ok(ran(0, "", ""))
        })
        .unwrap_err();
        assert_eq!(err, "言語サーバー「gone」の設定がありません");
        assert_eq!(runs, 0);
    }

    #[test]
    fn launch_for_of_a_saved_environment_goes_through_the_host_of_its_settings() {
        let dir = temp_dir("launch-ssh");
        let env_settings = LspRepoSettings {
            ssh_host: Some("dev".into()),
            ..LspRepoSettings::unset(Some("srv"), "repo-1")
        };
        set_settings(&dir, env_settings).unwrap();
        let mut routes = Vec::new();
        let got = launch_for(
            &dir,
            Some("srv"),
            "repo-1",
            WT,
            "ruby-lsp",
            |route, _, _, _| {
                routes.push(route.clone());
                Ok(ran(0, "", ""))
            },
        )
        .unwrap();
        assert_eq!(got.method, LspMethod::None);
        assert_eq!(routes, vec![Route::Ssh { host: "dev".into() }; 2]);
        // Without the host nothing is run.
        let mut runs = 0;
        let err = launch_for(
            &dir,
            Some("other"),
            "repo-1",
            WT,
            "ruby-lsp",
            |_, _, _, _| {
                runs += 1;
                Ok(ran(0, "", ""))
            },
        )
        .unwrap_err();
        assert_eq!(err, NO_SSH_HOST);
        assert_eq!(runs, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn launch_for_refuses_a_bad_worktree_before_it_runs_anything() {
        let dir = temp_dir("launch-bad");
        let mut runs = 0;
        let err = launch_for(&dir, None, "repo-1", "rel", "ruby-lsp", |_, _, _, _| {
            runs += 1;
            Ok(ran(0, "", ""))
        })
        .unwrap_err();
        assert_eq!(err, BAD_WORKTREE);
        assert_eq!(runs, 0);
    }

    #[test]
    fn launch_for_falls_back_to_the_host_when_only_the_gemfile_lock_has_ruby_lsp() {
        let dir = temp_dir("launch-host");
        let got = launch_for(&dir, None, "repo-1", WT, "ruby-lsp", |_, _, command, _| {
            Ok(if command.contains("Gemfile.lock") {
                ran(0, LOCK, "")
            } else {
                ran(0, "", "")
            })
        })
        .unwrap();
        assert_eq!(got.method, LspMethod::Host);
        assert_eq!(got.command.as_deref(), Some("bundle exec ruby-lsp"));
        assert_eq!(got.mount.as_deref(), Some(WT));
    }
}
