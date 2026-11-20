//! The app's side of the server of A-37 (#891): it puts `tsunagiai-mcp` on the PC of a saved environment, starts it there, pins its key, and connects to it (`formation_server::Client`).
//! Everything on that PC is done through a terminal of that PC's Orca, the floating terminal (`FLOATING_WORKTREE`): the app types a command, reads the screen for the line the program prints (`formation_server::ready_line` or `error_line`) and closes the terminal.
//!
//! - `place` fetches the program of this app's version from the GitHub Release (the repository of the updater's endpoint), checks its signature against the Team ID of this app's own signature, puts it in `remote/` of that PC's config folder, starts it, and pins the key and the version of the server that the ready line carries.
//! - `connect` connects with the pinned key. When nobody answers it starts the server once and tries again, and when the server's version is not this app's it places the program again and tries again. An environment with no pinned key is refused: nothing was placed there.
//! - What is pinned is in `formation-remote.json`, for each environment by its name. The app's own key pair is in the keychain.
//! - `keep_pushes` keeps one connection to each saved environment's server open (#983): the daemon pushes the requests of that PC through it (`formation_server::Pushes`), and the app connects again when it ends. `Subscriptions` holds one such task for each environment of the list it is given, and ends the task of one that has left the list.
//!
//! A secret key is in no error text and no `Debug` output (the public keys that are pinned are not secret).

use std::{
    collections::BTreeMap,
    future::Future,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts,
    auth::config_dir,
    formation::{self, terminal_close_args, FLOATING_WORKTREE, LOCAL},
    formation_server::{
        self, canonical_32, error_line, parse_error_line, parse_ready_line, public_of, random_32,
        Client, PushHandler, PushRequest, STOPPED_LINE,
    },
    identity::IDENTIFIER,
    keychain, orca, orca_link, orca_preview,
};

/// The keychain service of the app's secret key, and the user of its item.
pub const KEYCHAIN_SERVICE: &str = "jp.mysis.tsunagiai.formation";
const KEYCHAIN_USER: &str = "client-key";
/// In the config folder of the app: the pinned servers.
const PINS_FILE: &str = "formation-remote.json";
/// The file of the program in `remote/` of the PC's config folder, the archive of a release, and the program in that archive.
const PROGRAM_FILE: &str = "tsunagiai-mcp";
const ASSET: &str = "tsunagiai.app.tar.gz";
const PROGRAM_IN_ASSET: &str = "tsunagiai.app/Contents/MacOS/tsunagiai-mcp";
/// The title of the terminal that does the work on the PC.
const TERMINAL_TITLE: &str = "tsunagiai-server";
/// How long to wait for the line of a placement (it fetches the program) and of a start.
const PLACE_WAIT: Duration = Duration::from_secs(120);
const START_WAIT: Duration = Duration::from_secs(20);
/// How often the screen is read.
const POLL: Duration = Duration::from_secs(1);
/// `tauri.conf.json` holds the repository of the releases, as the updater's endpoint.
const TAURI_CONF: &str = include_str!("../tauri.conf.json");

// ---- the app's key ----

/// The secret key of the app: the one in `get`, or a new one that `set` stores when there is none. A stored value that is not a key is an error and is not replaced, because every server pins the key that goes with it.
fn secret_with(
    get: &dyn Fn() -> Result<Option<String>, String>,
    set: &dyn Fn(&str) -> Result<(), String>,
) -> Result<[u8; 32], String> {
    if let Some(text) = get()? {
        return canonical_32(&text).ok_or_else(|| "キーチェーンのアプリの鍵が壊れています".into());
    }
    let secret = random_32()?;
    set(&STANDARD.encode(secret))?;
    Ok(secret)
}

/// The app's secret key, made and stored in the keychain at the first use, and kept in the process after that: the keychain is read once (the screen connects every few seconds). A failure is not kept.
pub fn app_secret() -> Result<[u8; 32], String> {
    static SECRET: OnceLock<[u8; 32]> = OnceLock::new();
    if let Some(secret) = SECRET.get() {
        return Ok(*secret);
    }
    let secret = secret_with(
        &|| keychain::read(KEYCHAIN_SERVICE, KEYCHAIN_USER),
        &|value| keychain::write(KEYCHAIN_SERVICE, KEYCHAIN_USER, value),
    )?;
    Ok(*SECRET.get_or_init(|| secret))
}

// ---- what is pinned ----

/// The server of an environment: its public key (padded base64) and the version it was placed or started with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pin {
    pub key: String,
    pub version: String,
}

#[derive(Default, Serialize, Deserialize)]
struct PinFile {
    #[serde(default)]
    environments: BTreeMap<String, Pin>,
}

fn parse_pins(text: &str) -> Result<BTreeMap<String, Pin>, String> {
    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str::<PinFile>(text)
        .map(|file| file.environments)
        .map_err(|e| format!("{PINS_FILE} の形式が不正です: {e}"))
}

fn render_pins(pins: &BTreeMap<String, Pin>) -> Result<String, String> {
    serde_json::to_string_pretty(&PinFile {
        environments: pins.clone(),
    })
    .map_err(|e| e.to_string())
}

/// The pinned servers, by the name of their environment. None when nothing was placed yet.
pub fn pins(config: &Path) -> Result<BTreeMap<String, Pin>, String> {
    match std::fs::read_to_string(config.join(PINS_FILE)) {
        Ok(text) => parse_pins(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(format!("{PINS_FILE} を読めません: {e}")),
    }
}

/// One writer at a time: a read, a change and a write of the file must not interleave.
static PINS_WRITE: Mutex<()> = Mutex::new(());

fn change_pins(
    config: &Path,
    change: impl FnOnce(&mut BTreeMap<String, Pin>) -> bool,
) -> Result<bool, String> {
    let _one = PINS_WRITE.lock().unwrap_or_else(PoisonError::into_inner);
    let mut all = pins(config)?;
    let changed = change(&mut all);
    if changed {
        accounts::write_atomic(config, PINS_FILE, &render_pins(&all)?)?;
    }
    Ok(changed)
}

/// Pins `pin` for `environment`, in the place of the one pinned before.
pub fn set_pin(config: &Path, environment: &str, pin: Pin) -> Result<(), String> {
    change_pins(config, |all| {
        all.insert(environment.to_owned(), pin);
        true
    })
    .map(|_| ())
}

/// Takes the pin of `environment` away; whether there was one.
pub fn forget_pin(config: &Path, environment: &str) -> Result<bool, String> {
    change_pins(config, |all| all.remove(environment).is_some())
}

// ---- where the server is ----

/// The address of a server as the shell of its PC gets it: an IP address, because the server binds to the address it is reached at and `--bind` takes no name.
pub(crate) fn parse_host(host: &str) -> Result<IpAddr, String> {
    host.parse().map_err(|_| {
        format!("接続先「{host}」は IP アドレスではないので、サーバーを置けません（Orca の環境の接続先を IP アドレスにしてください）")
    })
}

/// The address the server of `environment` is reached at and binds to: the host of its Orca endpoint (`orca_link::environment_host`), when that is an IP address.
pub fn bind_host(environment: &str) -> Result<String, String> {
    let host = orca_link::environment_host(environment)?;
    parse_host(&host).map(|address| address.to_string())
}

/// The folder of the program on its PC, as shell text that the shell of that PC expands: the config folder of this app's identifier, which `tsunagiai-mcp` of that PC resolves to as well.
fn remote_dir_shell() -> String {
    format!("$HOME/Library/Application Support/{IDENTIFIER}/remote")
}

/// Where `place` puts the program on its PC (shell text, see `remote_dir_shell`).
pub fn program_path() -> String {
    format!("{}/{PROGRAM_FILE}", remote_dir_shell())
}

// ---- the commands ----

/// `sh -c` with the statements as one line: one quoted word, typed into the login shell of the terminal, whichever shell that is. Nothing in the statements is a single quote, or a backslash that is not before a double quote, so the shells read the word the same way (`formation::orchestrator_command`).
fn sh_command(statements: &[String]) -> String {
    format!(
        "sh -c {}",
        crate::claude_code::sh_quote(&statements.join("; "))
    )
}

/// The statements every command starts with: `fail`, which prints the line of a failure and ends the command, after taking its temporary folder away. The line is printed from two halves of its prefix, so that the typed text, which the terminal shows too, is not taken for the line.
fn prelude() -> Vec<String> {
    let prefix = error_line("");
    let (head, tail) = prefix.split_at(prefix.len() / 2);
    vec![
        "t=".to_owned(),
        format!(
            "fail() {{ [ -z \"$t\" ] || rm -rf \"$t\"; echo \"{head}\"\"{tail}$1\"; exit 1; }}"
        ),
    ]
}

/// Whether `version` is a release version, `{major}.{minor}.{patch}`: a development build (`0.0.0`) has no release to fetch.
fn check_version(version: &str) -> Result<(), String> {
    let parts: Vec<&str> = version.split('.').collect();
    let number = |p: &&str| !p.is_empty() && p.len() <= 6 && p.chars().all(|c| c.is_ascii_digit());
    if parts.len() != 3 || !parts.iter().all(number) {
        return Err(format!(
            "つなぎAI の版「{version}」の形式が正しくありません"
        ));
    }
    if version == "0.0.0" {
        return Err(
            "開発版のつなぎAI は、サーバーを置けません（リリースされたものだけを置きます）".into(),
        );
    }
    Ok(())
}

/// The URL of the program's archive in the release of `version`: the repository is the one of the updater's endpoint in `conf`, the text of `tauri.conf.json`.
fn release_url(conf: &str, version: &str) -> Result<String, String> {
    check_version(version)?;
    let doc: Value = serde_json::from_str(conf).map_err(|e| e.to_string())?;
    let endpoint = doc["plugins"]["updater"]["endpoints"][0]
        .as_str()
        .unwrap_or_default();
    let repo = endpoint
        .strip_prefix("https://github.com/")
        .and_then(|rest| rest.strip_suffix("/releases/latest/download/latest.json"))
        .filter(|repo| {
            repo.split('/').count() == 2
                && repo
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
        })
        .ok_or("リリースのリポジトリを、更新の接続先から読めません")?;
    Ok(format!(
        "https://github.com/{repo}/releases/download/v{version}/{ASSET}"
    ))
}

/// The Team ID in the output of `codesign -dv` of this app's own program. An app with no signature, or none with a Team ID, has none, and the program of its release could not be told from any other.
fn parse_team_id(output: &str) -> Result<String, String> {
    let value = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("TeamIdentifier="))
        .map(str::trim);
    match value {
        Some(id)
            if id.len() == 10
                && id
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) =>
        {
            Ok(id.to_owned())
        }
        _ => Err("つなぎAI の署名に Team ID がないので、サーバーを置けません（署名されたアプリだけが置けます）".into()),
    }
}

/// The Team ID of this app's own signature, read now from its program.
fn own_team_id() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("自分の場所を知れません: {e}"))?;
    let out = std::process::Command::new("codesign")
        .args(["-dv", "--verbose=2"])
        .arg(&exe)
        .output()
        .map_err(|e| format!("codesign を動かせません: {e}"))?;
    // `codesign -d` prints to the standard error.
    parse_team_id(&String::from_utf8_lossy(&out.stderr))
}

/// The command that places the program and starts it: only on macOS arm64; fetches the archive of the release into a temporary folder and takes only the program out of it; checks its signature and that it is signed by the Team ID of this app; puts it in `remote/` by a rename, writes the version beside it, and runs it with `--serve`. The program prints the ready line, and a failure of any step prints the error line.
fn place_command(
    url: &str,
    version: &str,
    team_id: &str,
    host: &str,
    client_key: &str,
) -> Result<String, String> {
    check_version(version)?;
    let host = parse_host(host)?;
    if team_id.len() != 10 || !team_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Team ID の形式が正しくありません".into());
    }
    if canonical_32(client_key).is_none() {
        return Err("アプリの公開鍵の形式が正しくありません".into());
    }
    if !url.starts_with("https://github.com/")
        || !url
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ":/.-_".contains(c))
    {
        return Err("ダウンロード先の形式が正しくありません".into());
    }
    let dir = remote_dir_shell();
    let mut statements = prelude();
    statements.extend([
        "[ \"$(uname -sm)\" = \"Darwin arm64\" ] || fail \"この PC は macOS（Apple Silicon）ではありません\"".to_owned(),
        "t=$(mktemp -d) || fail \"一時フォルダを作れません\"".to_owned(),
        format!("curl -fsSL -o \"$t/app.tar.gz\" \"{url}\" || fail \"tsunagiai-mcp をダウンロードできません\""),
        format!("tar -xzf \"$t/app.tar.gz\" -C \"$t\" {PROGRAM_IN_ASSET} || fail \"tsunagiai-mcp を取り出せません\""),
        format!("m=\"$t/{PROGRAM_IN_ASSET}\""),
        "codesign --verify --strict \"$m\" || fail \"tsunagiai-mcp の署名が正しくありません\"".to_owned(),
        format!(
            "codesign --verify --strict -R=\"anchor apple generic and certificate leaf[subject.OU] = \\\"{team_id}\\\"\" \"$m\" || fail \"tsunagiai-mcp の署名が、つなぎAI の署名と違います\""
        ),
        format!("d=\"{dir}\""),
        "mkdir -p \"$d\" || fail \"remote フォルダを作れません\"".to_owned(),
        format!("cp \"$m\" \"$d/{PROGRAM_FILE}.new\" && mv -f \"$d/{PROGRAM_FILE}.new\" \"$d/{PROGRAM_FILE}\" || fail \"tsunagiai-mcp を置けません\""),
        format!("echo \"{version}\" > \"$d/version.new\" && mv -f \"$d/version.new\" \"$d/version\" || fail \"版を書けません\""),
        "rm -rf \"$t\"".to_owned(),
        format!("exec \"$d/{PROGRAM_FILE}\" --serve --bind {host} --client-key {client_key}"),
    ]);
    Ok(sh_command(&statements))
}

/// The command that starts the server of the placed program: only `--serve --bind {host}`, which keeps a key pinned before.
fn start_command(host: &str) -> Result<String, String> {
    let host = parse_host(host)?;
    let mut statements = prelude();
    statements.extend([
        format!("m=\"{}\"", program_path()),
        "[ -x \"$m\" ] || fail \"tsunagiai-mcp が置かれていません\"".to_owned(),
        format!("exec \"$m\" --serve --bind {host}"),
    ]);
    Ok(sh_command(&statements))
}

// ---- the terminal ----

/// What the program printed.
#[derive(Clone, Debug, PartialEq)]
pub enum Served {
    Ready { key: String, version: String },
    Failed(String),
}

/// The first line of the screen that is a ready line or an error line.
fn served_in(lines: &[String]) -> Option<Served> {
    lines.iter().find_map(|line| {
        parse_ready_line(line)
            .map(|(key, version)| Served::Ready { key, version })
            .or_else(|| parse_error_line(line).map(Served::Failed))
    })
}

/// Reads the screen with `read` every `poll` until `find` finds its line on it, up to `wait`. A read that fails is tried again until the time is out, and is then in the message.
fn wait_line<T>(
    read: &mut dyn FnMut() -> Result<Vec<String>, String>,
    wait: Duration,
    poll: Duration,
    find: &dyn Fn(&[String]) -> Option<T>,
) -> Result<T, String> {
    let deadline = Instant::now() + wait;
    let mut last_error = None;
    loop {
        match read() {
            Ok(lines) => {
                if let Some(found) = find(&lines) {
                    return Ok(found);
                }
            }
            Err(e) => last_error = Some(e),
        }
        if Instant::now() >= deadline {
            return Err(match last_error {
                Some(e) => format!("時間内にサーバーの答えを読めませんでした（{e}）"),
                None => "時間内にサーバーが答えませんでした".to_owned(),
            });
        }
        std::thread::sleep(poll);
    }
}

fn floating_create_args(environment: &str, command: &str) -> Vec<String> {
    let mut args = orca::args_of(&["terminal", "create", "--worktree"]);
    args.extend([
        FLOATING_WORKTREE.into(),
        "--title".into(),
        TERMINAL_TITLE.into(),
        "--command".into(),
        command.into(),
        "--json".into(),
    ]);
    orca::with_environment(args, Some(environment))
}

/// Makes a floating terminal in the Orca of `environment` that runs `command`, waits up to `wait` for the line that `find` finds on its screen, and closes the terminal, whatever came of it.
fn run_terminal_for<T>(
    environment: &str,
    command: &str,
    wait: Duration,
    poll: Duration,
    write: &dyn Fn(&[String]) -> Result<Value, String>,
    read: &dyn Fn(&[String]) -> Result<Value, String>,
    find: &dyn Fn(&[String]) -> Option<T>,
) -> Result<T, String> {
    let made = write(&floating_create_args(environment, command))?;
    let handle = orca::created_of(&made)
        .handle
        .ok_or("Orca がターミナルの handle を答えませんでした")?;
    let screen = orca::screen_args(&handle, Some(environment));
    let found = wait_line(
        &mut || read(&screen).map(|result| orca::screen_lines_of(&result)),
        wait,
        poll,
        find,
    );
    // The line is read; a terminal that does not close is the Orca's to show.
    let _ = write(&terminal_close_args(&handle, environment));
    found
}

/// `run_terminal_for` the line of a placement or a start.
fn run_terminal(
    environment: &str,
    command: &str,
    wait: Duration,
    poll: Duration,
    write: &dyn Fn(&[String]) -> Result<Value, String>,
    read: &dyn Fn(&[String]) -> Result<Value, String>,
) -> Result<Served, String> {
    run_terminal_for(environment, command, wait, poll, write, read, &served_in)
}

/// `run_terminal` through the CLI of Orca.
fn run_in_orca(environment: &str, command: &str, wait: Duration) -> Result<Served, String> {
    run_terminal(
        environment,
        command,
        wait,
        POLL,
        &|args| orca::write(args),
        &|args| orca::call(args, orca::READ_TIMEOUT).map_err(orca::message_of),
    )
}

/// What the line says, as the pin: a ready line is pinned for `environment` (its key replaces the one before), and when `version` is given it must be the version of the ready line. A failure line is its reason.
fn pin_served(
    config: &Path,
    environment: &str,
    served: Served,
    version: Option<&str>,
    what: &str,
) -> Result<Pin, String> {
    match served {
        Served::Failed(reason) => Err(format!("{what}: {reason}")),
        Served::Ready { key, version: got } => {
            if version.is_some_and(|expected| expected != got) {
                return Err(format!(
                    "{what}: サーバーの版（{got}）が、置いた版と違います"
                ));
            }
            let pin = Pin { key, version: got };
            set_pin(config, environment, pin.clone())?;
            Ok(pin)
        }
    }
}

// ---- place and start ----

/// What runs a command in a terminal of the PC and gives the line it printed.
type RunCommand<'a> = &'a dyn Fn(&str, Duration) -> Result<Served, String>;

fn place_with(
    config: &Path,
    environment: &str,
    app_version: &str,
    team_id: &str,
    client_public: &[u8; 32],
    host: &str,
    run: RunCommand<'_>,
) -> Result<Pin, String> {
    let url = release_url(TAURI_CONF, app_version)?;
    let command = place_command(
        &url,
        app_version,
        team_id,
        host,
        &STANDARD.encode(client_public),
    )?;
    let served = run(&command, PLACE_WAIT)?;
    pin_served(
        config,
        environment,
        served,
        Some(app_version),
        "サーバーを置けませんでした",
    )
}

/// Puts `tsunagiai-mcp` of `app_version` on the PC of `environment`, starts it there and pins its key and version (#891). The release of this version is fetched there, so this blocks for as long as that takes: run it where blocking is allowed. A development build, an app with no Team ID, a PC that is not macOS arm64 and an environment whose address is no IP address are refused with the reason.
/// The consent of the owner is not asked here: whoever calls it has it.
pub fn place(config: &Path, environment: &str, app_version: &str) -> Result<Pin, String> {
    check_version(app_version)?;
    let team_id = own_team_id()?;
    let host = bind_host(environment)?;
    let public = public_of(&app_secret()?);
    place_with(
        config,
        environment,
        app_version,
        &team_id,
        &public,
        &host,
        &|command, wait| run_in_orca(environment, command, wait),
    )
}

fn start_with(
    config: &Path,
    environment: &str,
    host: &str,
    run: RunCommand<'_>,
) -> Result<Pin, String> {
    let served = run(&start_command(host)?, START_WAIT)?;
    pin_served(
        config,
        environment,
        served,
        None,
        "サーバーを起動できませんでした",
    )
}

/// Starts the server that was placed on the PC of `environment` and pins the key and the version it prints. It blocks until the line is read.
pub fn start(config: &Path, environment: &str) -> Result<Pin, String> {
    let host = bind_host(environment)?;
    start_with(config, environment, &host, &|command, wait| {
        run_in_orca(environment, command, wait)
    })
}

// ---- the consent of the owner (#893) ----

/// The PC of a saved environment that the owner agreed to put `tsunagiai-mcp` on: it has a pinned key (`place` pins it), and that pin is the consent. The version is the one the server was placed or started with.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct FormationConsent {
    pub environment: String,
    pub version: String,
}

/// The consents given, in order of the environment's name.
pub fn consents(config: &Path) -> Result<Vec<FormationConsent>, String> {
    Ok(pins(config)?
        .into_iter()
        .map(|(environment, pin)| FormationConsent {
            environment,
            version: pin.version,
        })
        .collect())
}

/// What a consent can be given to: a saved environment. This Mac needs none, and an empty name names nothing.
fn check_consent_target(environment: &str) -> Result<(), String> {
    if environment.trim().is_empty() || environment == LOCAL {
        return Err("同意は、保存した環境の PC に対してだけ取れます".into());
    }
    Ok(())
}

/// How long to wait for the line of a stop.
const STOP_WAIT: Duration = START_WAIT;

/// The command that stops the server of the placed program on its PC and takes `remote/` away (its program, version, keys and pid), and prints the stopped line. A PC where the program is not there has nothing to stop. The program's own stopped line is not shown (it is kept in the shell's variable), so that the line printed last is the end of the command, and the terminal is not closed before `remote/` is gone. The line is printed from two halves, so that the typed text, which the terminal shows too, is not taken for the line.
fn stop_command() -> String {
    let (head, tail) = STOPPED_LINE.split_at(STOPPED_LINE.len() / 2);
    let mut statements = prelude();
    statements.extend([
        format!("d=\"{}\"", remote_dir_shell()),
        format!("m=\"$d/{PROGRAM_FILE}\""),
        "if [ -x \"$m\" ]; then o=$(\"$m\" --serve-stop) || { echo \"$o\"; fail \"サーバーを止められません\"; }; fi".to_owned(),
        "rm -rf \"$d\" || fail \"remote フォルダを消せません\"".to_owned(),
        format!("echo \"{head}\"\"{tail}\""),
    ]);
    sh_command(&statements)
}

/// The first line of the screen that is the stopped line (`Ok`) or an error line (its reason).
fn stopped_in(lines: &[String]) -> Option<Result<(), String>> {
    lines.iter().find_map(|line| {
        if line.trim() == STOPPED_LINE {
            Some(Ok(()))
        } else {
            parse_error_line(line).map(Err)
        }
    })
}

/// What runs the stop command in a terminal of the PC and gives the line it printed.
type RunStop<'a> = &'a dyn Fn(&str, Duration) -> Result<Result<(), String>, String>;

#[derive(Debug, PartialEq)]
enum Revoke {
    /// Stop the server and take the program away, then forget the pin.
    Stop,
    /// The environment is gone from Orca, so its PC cannot be reached: only the pin is forgotten.
    ForgetOnly,
}

/// What a revocation does: it is refused while a formation of that PC is left (its orchestrator and its children run on it, and the record of them is read from its server), else it stops the server there, unless the environment is gone from Orca (`gone`, asked only then).
fn revoke_plan(
    environment: &str,
    formations: &[String],
    gone: &dyn Fn() -> bool,
) -> Result<Revoke, String> {
    if !formations.is_empty() {
        return Err(format!(
            "環境「{environment}」には、フォーメーション（{}）が残っています。削除してから取り消してください",
            formations.join("、")
        ));
    }
    Ok(if gone() {
        Revoke::ForgetOnly
    } else {
        Revoke::Stop
    })
}

/// Takes the consent of `environment` back: the plan, the stop on its PC when there is one, and last the pin. A stop that failed keeps the pin, so that the revocation can be tried again.
fn revoke_with(
    config: &Path,
    environment: &str,
    formations: &[String],
    gone: &dyn Fn() -> bool,
    run: RunStop<'_>,
) -> Result<(), String> {
    if !pins(config)?.contains_key(environment) {
        return Err(format!("環境「{environment}」には同意がありません"));
    }
    if revoke_plan(environment, formations, gone)? == Revoke::Stop {
        run(&stop_command(), STOP_WAIT)?
            .map_err(|reason| format!("サーバーを止められませんでした: {reason}"))?;
    }
    forget_pin(config, environment)?;
    Ok(())
}

/// `run_terminal_for` the stop command, through the CLI of Orca.
fn run_stop_in_orca(
    environment: &str,
    command: &str,
    wait: Duration,
) -> Result<Result<(), String>, String> {
    run_terminal_for(
        environment,
        command,
        wait,
        POLL,
        &|args| orca::write(args),
        &|args| orca::call(args, orca::READ_TIMEOUT).map_err(orca::message_of),
        &stopped_in,
    )
}

/// The PCs the owner agreed to (the settings screen lists them, and the dialog that makes a formation asks).
#[tauri::command]
pub async fn formation_consents(app: tauri::AppHandle) -> Result<Vec<FormationConsent>, String> {
    consents(&config_dir(&app)?)
}

/// The owner agreed to put `tsunagiai-mcp` on the PC of `environment`: puts the program there, starts it and pins its key (`place`), which is the consent. It blocks for as long as the fetch there takes, so it runs in a thread of its own. A failure carries the words of its reason and nothing is agreed.
#[tauri::command]
pub async fn formation_consent(
    app: tauri::AppHandle,
    environment: String,
) -> Result<FormationConsent, String> {
    let config = config_dir(&app)?;
    let app_version = app.package_info().version.to_string();
    let (kept_config, kept_version) = (config.clone(), app_version.clone());
    let consent = orca::blocking(move || {
        check_consent_target(&environment)?;
        let pin = place(&config, &environment, &app_version)?;
        Ok::<_, String>(FormationConsent {
            environment,
            version: pin.version,
        })
    })
    .await??;
    // The PC is agreed to now: its connection of pushes is opened at once (a failure is tried again by the clock).
    let _ = sync_pushes(&app, &kept_config, &kept_version).await;
    Ok(consent)
}

/// Takes the consent of `environment` back (`revoke_with`) and answers the consents that are left. A PC with a formation left is refused with the reason.
#[tauri::command]
pub async fn formation_consent_revoke(
    app: tauri::AppHandle,
    environment: String,
) -> Result<Vec<FormationConsent>, String> {
    let config = config_dir(&app)?;
    let app_version = app.package_info().version.to_string();
    let kept_config = config.clone();
    let left = orca::blocking(move || {
        let formations = formation::formations_on(&config, &environment)?;
        revoke_with(
            &config,
            &environment,
            &formations,
            &|| formation::environment_gone_now(&environment),
            &|command, wait| run_stop_in_orca(&environment, command, wait),
        )?;
        consents(&config)
    })
    .await??;
    // The consent is gone: the connection of pushes to that PC is ended at once.
    let _ = sync_pushes(&app, &kept_config, &app_version).await;
    Ok(left)
}

// ---- connect ----

/// What the server of a connection try said.
#[derive(Debug, PartialEq)]
enum Heard {
    Version(String),
    /// It was not reached, did not answer, or did not answer to the pinned key: the reason.
    Silent(String),
}

#[derive(Debug, PartialEq)]
enum Step {
    Use,
    Start,
    Place,
    GiveUp(String),
}

/// What to do after a try: use the connection when the server is of this app's version; place the program again when it is of another version (once); start the server when nobody answered (once). A placement also counts as a start, because it starts the server.
fn decide(heard: &Heard, app_version: &str, started: bool, placed: bool) -> Step {
    match heard {
        Heard::Version(version) if version == app_version => Step::Use,
        Heard::Version(_) if !placed => Step::Place,
        Heard::Version(version) => Step::GiveUp(format!(
            "サーバーの版（{version}）が、つなぎAI の版（{app_version}）と違います"
        )),
        Heard::Silent(_) if !started => Step::Start,
        Heard::Silent(reason) => Step::GiveUp(format!(
            "サーバーにつなげません: {reason}。その PC の画面にファイアウォールの確認が出ていたら「許可」を押して、もう一度試してください"
        )),
    }
}

/// Why an environment with no pinned key is refused: the owner has not allowed the app to put the server on its PC, which is what pins a key.
fn not_allowed(environment: &str) -> String {
    format!(
        "環境「{environment}」の PC にサーバーを置くことを、まだ許可していません。許可すると、つなぎAI がその PC にサーバーを置いて起動します"
    )
}

/// How long the connection and the handshake of a read that does not wait (`wait` false: the screen's reads) may take. The screen's reads give up after `SAVED_PS_TIMEOUT` (5 seconds), so a PC that takes the connection and then says nothing (a firewall waiting for an answer) has to be heard as silent within that, to reach the start and the words of the firewall.
pub(crate) const SCREEN_HANDSHAKE: Duration = Duration::from_secs(3);

/// The limit of the connection and the handshake of one try.
fn handshake_deadline(wait: bool) -> Duration {
    if wait {
        formation_server::HANDSHAKE_DEADLINE
    } else {
        SCREEN_HANDSHAKE
    }
}

/// One try: connects with the pinned key and asks the version. A connection that is not made within `deadline` is silent.
async fn probe(
    host: &str,
    port: u16,
    secret: [u8; 32],
    key: &str,
    deadline: Duration,
) -> (Heard, Option<Client>) {
    let Some(server_public) = canonical_32(key) else {
        return (
            Heard::Silent("固定したサーバーの鍵が壊れています".into()),
            None,
        );
    };
    let mut client = match Client::connect_within(host, port, secret, server_public, deadline).await
    {
        Ok(client) => client,
        Err(e) => return (Heard::Silent(e), None),
    };
    match client.version().await {
        Ok(version) => (Heard::Version(version), Some(client)),
        Err(e) => (Heard::Silent(e), None),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Do {
    Place,
    Start,
}

/// How long a start or a placement on a PC is not done again, whatever came of it.
const ACT_PAUSE: Duration = Duration::from_secs(30);

/// Whether a start or a placement done last at `last` may be done again at `now`.
fn act_due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|last| now.duration_since(last) >= ACT_PAUSE)
}

/// What a read that does not wait answers while the PC is being started or placed again, and what a read that waits answers when another has the PC in hand.
fn in_progress(what: Do) -> String {
    match what {
        Do::Start => "その PC のサーバーを起動しています".to_owned(),
        Do::Place => "その PC のサーバーを入れ直しています".to_owned(),
    }
}

#[derive(Default)]
struct ActingState {
    /// The start or the placement that is running on a PC now.
    running: BTreeMap<String, Do>,
    /// When the last one of each kind ended.
    acted: BTreeMap<(String, Do), Instant>,
}

/// The starts and placements of the PCs: one at a time for each environment, and none again within `ACT_PAUSE` of the last one, because the screen reads every few seconds and a PC that does not answer would get a terminal at each read.
#[derive(Clone, Default)]
struct Acting(Arc<Mutex<ActingState>>);

/// A start or a placement in hand: the environment is free for the next one (after the pause) when this is dropped.
struct Busy {
    acting: Acting,
    environment: String,
    what: Do,
}

impl Drop for Busy {
    fn drop(&mut self) {
        let mut state = self.acting.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.running.remove(&self.environment);
        state
            .acted
            .insert((self.environment.clone(), self.what), Instant::now());
    }
}

enum Begin {
    /// Nothing is running there, and the pause is over: the caller does it.
    Run(Busy),
    /// Another start or placement is running there.
    Running(Do),
    /// One of the kind ended a moment ago: nothing is done.
    Paused,
}

impl Acting {
    fn begin(&self, environment: &str, what: Do, now: Instant) -> Begin {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(running) = state.running.get(environment) {
            return Begin::Running(*running);
        }
        let last = state.acted.get(&(environment.to_owned(), what)).copied();
        if !act_due(last, now) {
            return Begin::Paused;
        }
        state.running.insert(environment.to_owned(), what);
        Begin::Run(Busy {
            acting: self.clone(),
            environment: environment.to_owned(),
            what,
        })
    }
}

static ACTING: LazyLock<Acting> = LazyLock::new(Acting::default);

/// What does a `Do` on the PC: blocking.
type Act = Arc<dyn Fn(Do) -> Result<(), String> + Send + Sync>;

/// Does `what` on the PC of `environment` through `act`. A read that waits (`wait`) waits for it. A read that does not goes on at once: the work runs in a thread of its own, and the answer is the words of what is going on. Where another start or placement is running on that PC, none is begun and the answer is the words of the one that runs. Ok when it was done, or when one ended a moment ago and nothing is done.
async fn act_on_pc(
    acting: &Acting,
    act: &Act,
    environment: &str,
    what: Do,
    wait: bool,
) -> Result<(), String> {
    let busy = match acting.begin(environment, what, Instant::now()) {
        Begin::Run(busy) => busy,
        Begin::Running(running) => return Err(in_progress(running)),
        Begin::Paused => return Ok(()),
    };
    let act = act.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _busy = busy;
        act(what)
    });
    if !wait {
        return Err(in_progress(what));
    }
    work.await.map_err(|e| e.to_string())?
}

/// Reads the pinned server of `environment`: the owner must have allowed it.
fn pin_of(config: &Path, environment: &str) -> Result<Pin, String> {
    pins(config)?
        .remove(environment)
        .ok_or_else(|| not_allowed(environment))
}

#[allow(clippy::too_many_arguments)]
async fn connect_with(
    config: &Path,
    environment: &str,
    app_version: &str,
    host: &str,
    port: u16,
    secret: [u8; 32],
    first: Pin,
    wait: bool,
    acting: &Acting,
    act: &Act,
) -> Result<Client, String> {
    let (mut started, mut placed) = (false, false);
    let mut pin = first;
    loop {
        let (heard, client) = probe(host, port, secret, &pin.key, handshake_deadline(wait)).await;
        match decide(&heard, app_version, started, placed) {
            Step::Use => return client.ok_or_else(|| "サーバーにつなげません".to_owned()),
            Step::Start => {
                act_on_pc(acting, act, environment, Do::Start, wait).await?;
                started = true;
            }
            Step::Place => {
                act_on_pc(acting, act, environment, Do::Place, wait).await?;
                (placed, started) = (true, true);
            }
            Step::GiveUp(reason) => return Err(reason),
        }
        // A start or a placement pins the key it found: read again after one.
        pin = pin_of(config, environment)?;
    }
}

/// Connects to the server of `environment` with the pinned key, and checks that its version is `app_version`. When nobody answers, the server is started on the PC once and the connection is tried again; when its version is another, the program is placed again once (`place`) and the connection is tried again. An environment with no pinned key is refused with the reason and nothing is done on its PC.
/// With `wait` false (the screen's reads) a start or a placement is not waited for: it runs in the background, one at a time for a PC, and the answer is the words of what is going on (`in_progress`), so that a read does not hold the screen for the 20 or 120 seconds it takes. A close or a delete waits.
pub async fn connect(
    config: &Path,
    environment: &str,
    app_version: &str,
    wait: bool,
) -> Result<Client, String> {
    let pin = pin_of(config, environment)?;
    let host = {
        let environment = environment.to_owned();
        orca::blocking(move || bind_host(&environment)).await??
    };
    let secret = orca::blocking(app_secret).await??;
    let act: Act = {
        let (config, environment, version) = (
            config.to_owned(),
            environment.to_owned(),
            app_version.to_owned(),
        );
        Arc::new(move |what| match what {
            Do::Place => place(&config, &environment, &version).map(|_| ()),
            Do::Start => start(&config, &environment).map(|_| ()),
        })
    };
    connect_with(
        config,
        environment,
        app_version,
        &host,
        formation_server::PORT,
        secret,
        pin,
        wait,
        &ACTING,
        &act,
    )
    .await
}

// ---- the connection of pushes ----

/// How long `keep_open` waits before it connects again: from `first`, doubled after each try that did not get a connection, up to `max`.
#[derive(Clone, Copy)]
struct Backoff {
    first: Duration,
    max: Duration,
}

const BACKOFF: Backoff = Backoff {
    first: Duration::from_secs(1),
    max: Duration::from_secs(30),
};

fn next_delay(current: Duration, backoff: Backoff) -> Duration {
    (current * 2).min(backoff.max)
}

/// Opens a connection with `open`, turns it into the connection of pushes and takes the pushes with `handler` until it ends; then waits and does it again, for ever. Every end is the same to it: a PC that was switched off, a server that was started again, a connection that went silent.
async fn keep_open<O, F>(open: O, handler: &PushHandler, backoff: Backoff)
where
    O: Fn() -> F,
    F: Future<Output = Result<Client, String>>,
{
    let mut delay = backoff.first;
    loop {
        let subscribed = match open().await {
            Ok(client) => client.subscribe().await,
            Err(e) => Err(e),
        };
        match subscribed {
            Ok(pushes) => {
                pushes.run(handler).await;
                delay = backoff.first;
            }
            Err(_) => delay = next_delay(delay, backoff),
        }
        tokio::time::sleep(delay).await;
    }
}

/// What the app runs for one saved environment: the connection of pushes of its PC, kept open (`connect` with no wait, so a server that is not there is started in the background as the screen's reads do it) and every push given to `handler`. It does not end; `Subscriptions` ends it.
pub async fn keep_pushes(
    config: PathBuf,
    environment: String,
    app_version: String,
    handler: PushHandler,
) {
    keep_open(
        || connect(&config, &environment, &app_version, false),
        &handler,
        BACKOFF,
    )
    .await;
}

/// The tasks that keep the connections of pushes open, one for each environment.
#[derive(Default)]
pub struct Subscriptions(Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>);

impl Subscriptions {
    /// Makes the tasks those of `environments`: `start` gives the task of an environment that has none, and the task of one that is not in the list any more is ended, so that a PC that was taken out of the list is not connected to again. Call it in the tokio runtime, each time the list is read.
    pub fn set<F>(&self, environments: &[String], start: impl Fn(&str) -> F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let mut tasks = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        tasks.retain(|name, task| {
            let keep = environments.contains(name) && !task.is_finished();
            if !keep {
                task.abort();
            }
            keep
        });
        for name in environments {
            if !tasks.contains_key(name) {
                tasks.insert(name.clone(), tokio::spawn(start(name)));
            }
        }
    }
}

/// The reason a push is refused that no request of the app is.
const REFUSED_PUSH: &str = "アプリはこの依頼を受けられません";

/// What the app asks a screen for a push that came through the connection of `environment`: the fields of the screen that takes it, or the reason it is refused (with a reason that quotes nothing of the request: what the PC sent is data). The one request taken is to open an HTML preview (A-45).
fn screen_of_push(
    request: &PushRequest,
    environment: &str,
) -> Result<crate::screen_bridge::Fields, String> {
    orca_preview::open_fields_of_push(request, environment)
        .unwrap_or_else(|| Err(REFUSED_PUSH.to_owned()))
}

/// What the app does with a push of `environment`: the request to open a preview is given to the screen of the development screen (`preview-open`), which answers it, and every other push is refused.
fn push_handler(app: tauri::AppHandle, environment: String) -> PushHandler {
    Arc::new(move |request| {
        let (app, environment) = (app.clone(), environment.clone());
        Box::pin(async move {
            let fields = screen_of_push(&request, &environment)?;
            crate::screen_bridge::write_screen(&app, orca_preview::OPEN_TARGET, fields).await
        })
    })
}

/// The saved environments that the app keeps a connection of pushes to: those the owner agreed to (they have a pinned key), among the saved ones that Orca lists now.
fn push_targets(saved: &[String], pins: &BTreeMap<String, Pin>) -> Vec<String> {
    saved
        .iter()
        .filter(|name| pins.contains_key(*name))
        .cloned()
        .collect()
}

/// The one set of connections of pushes of the app.
static SUBSCRIPTIONS: LazyLock<Subscriptions> = LazyLock::new(Subscriptions::default);

/// Makes the connections of pushes those of the saved environments `saved` that the owner agreed to: one is opened for each that has none, and the one of an environment that is no longer in the list, or whose consent was taken back, is ended. Call it in the tokio runtime.
fn keep_pushes_to(
    app: &tauri::AppHandle,
    config: &Path,
    app_version: &str,
    saved: &[String],
) -> Result<(), String> {
    let targets = push_targets(saved, &pins(config)?);
    let (config, app_version) = (config.to_owned(), app_version.to_owned());
    SUBSCRIPTIONS.set(&targets, |environment| {
        keep_pushes(
            config.clone(),
            environment.to_owned(),
            app_version.clone(),
            push_handler(app.clone(), environment.to_owned()),
        )
    });
    Ok(())
}

/// Reads the saved environments and sets the connections of pushes by them (`keep_pushes_to`). A list that cannot be read changes nothing: the connections that are open stay.
pub async fn sync_pushes(
    app: &tauri::AppHandle,
    config: &Path,
    app_version: &str,
) -> Result<(), String> {
    let saved = orca::blocking(formation::saved_environment_names).await??;
    keep_pushes_to(app, config, app_version, &saved)
}

/// How often the list of saved environments is read for the connections of pushes, so that one taken out of Orca's list, or added to it, is noticed.
const PUSH_SYNC: Duration = Duration::from_secs(30);

/// Sets the connections of pushes at the start of the app and then every `PUSH_SYNC` (the consent of a PC sets them at once, `formation_consent`). A failure is logged when its words change, so that an Orca that is not there does not fill the log.
pub fn start_pushes(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let version = app.package_info().version.to_string();
        let mut last_failure: Option<String> = None;
        let mut tick = tokio::time::interval(PUSH_SYNC);
        loop {
            tick.tick().await;
            let done = match config_dir(&app) {
                Ok(config) => sync_pushes(&app, &config, &version).await,
                Err(e) => Err(e),
            };
            match done {
                Ok(()) => last_failure = None,
                Err(e) if last_failure.as_ref() != Some(&e) => {
                    crate::gmail::log_failure("formation_pushes", "-", e.clone());
                    last_failure = Some(e);
                }
                Err(_) => {}
            }
        }
    });
}

impl Drop for Subscriptions {
    fn drop(&mut self) {
        for task in self
            .0
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formation_server::{serve, serve_with, Hub, Setup};
    use std::{
        cell::RefCell,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use tokio::net::TcpListener;

    #[test]
    fn a_start_or_a_placement_is_not_done_again_until_the_pause_is_over() {
        let now = Instant::now();
        assert!(act_due(None, now));
        assert!(!act_due(Some(now), now));
        assert!(!act_due(
            Some(now),
            now + ACT_PAUSE - Duration::from_secs(1)
        ));
        assert!(act_due(Some(now), now + ACT_PAUSE));
    }

    #[test]
    fn a_pc_has_one_start_or_placement_at_a_time_and_a_pause_after_it() {
        let acting = Acting::default();
        let now = Instant::now();
        let Begin::Run(first) = acting.begin("pc", Do::Start, now) else {
            panic!("the first one runs");
        };
        // Another environment is free, and this one answers what runs on it, whatever is asked.
        assert!(matches!(
            acting.begin("other", Do::Start, now),
            Begin::Run(_)
        ));
        assert!(matches!(
            acting.begin("pc", Do::Place, now),
            Begin::Running(Do::Start)
        ));
        drop(first);
        // The kind that ended is paused; the other kind is not.
        assert!(matches!(
            acting.begin("pc", Do::Start, Instant::now()),
            Begin::Paused
        ));
        assert!(matches!(
            acting.begin("pc", Do::Place, Instant::now()),
            Begin::Run(_)
        ));
        assert_eq!(in_progress(Do::Start), "その PC のサーバーを起動しています");
        assert_eq!(
            in_progress(Do::Place),
            "その PC のサーバーを入れ直しています"
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-formation-remote-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn key_text(seed: u8) -> String {
        STANDARD.encode([seed; 32])
    }

    // ---- the app's key ----

    #[test]
    fn the_app_key_is_made_once_and_then_read() {
        let stored = RefCell::new(None::<String>);
        let sets = RefCell::new(0);
        let get = || -> Result<Option<String>, String> { Ok(stored.borrow().clone()) };
        let set = |value: &str| -> Result<(), String> {
            *stored.borrow_mut() = Some(value.to_owned());
            *sets.borrow_mut() += 1;
            Ok(())
        };
        let first = secret_with(&get, &set).unwrap();
        let second = secret_with(&get, &set).unwrap();
        assert_eq!(first, second);
        assert_eq!(*sets.borrow(), 1);
        assert_eq!(
            stored.borrow().as_deref(),
            Some(STANDARD.encode(first).as_str())
        );
    }

    #[test]
    fn a_stored_value_that_is_no_key_is_an_error_and_is_not_replaced() {
        let set = |_: &str| -> Result<(), String> { panic!("must not be written") };
        for bad in ["", "abc", "AAAA", &STANDARD.encode([1u8; 16])] {
            let error = secret_with(&|| Ok(Some(bad.to_owned())), &set).unwrap_err();
            assert!(error.contains("壊れています"), "{bad:?}: {error}");
        }
        assert!(secret_with(&|| Err("locked".into()), &set).is_err());
        let failing = |_: &str| -> Result<(), String> { Err("denied".into()) };
        assert_eq!(secret_with(&|| Ok(None), &failing).unwrap_err(), "denied");
    }

    // ---- what is pinned ----

    #[test]
    fn pins_are_read_written_and_forgotten_by_environment() {
        let config = temp_dir("pins");
        assert!(pins(&config).unwrap().is_empty());
        let pin = |seed: u8, version: &str| Pin {
            key: key_text(seed),
            version: version.to_owned(),
        };
        set_pin(&config, "mac-studio", pin(1, "0.83.0")).unwrap();
        set_pin(&config, "mac-mini", pin(2, "0.83.0")).unwrap();
        // A pin replaces the one before it.
        set_pin(&config, "mac-studio", pin(3, "0.84.0")).unwrap();
        let all = pins(&config).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all["mac-studio"], pin(3, "0.84.0"));
        assert_eq!(all["mac-mini"], pin(2, "0.83.0"));
        assert!(forget_pin(&config, "mac-studio").unwrap());
        assert!(!forget_pin(&config, "mac-studio").unwrap());
        assert_eq!(
            pins(&config).unwrap().keys().collect::<Vec<_>>(),
            ["mac-mini"]
        );
        // The write is atomic: no temporary file is left.
        assert!(!config.join("formation-remote.json.tmp").exists());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_file_of_pins_that_is_no_pins_is_an_error_and_an_empty_or_new_one_has_none() {
        assert!(parse_pins("").unwrap().is_empty());
        assert!(parse_pins("{}").unwrap().is_empty());
        assert!(parse_pins(r#"{"environments":{"a":{"key":"k","version":"1.0.0"}}}"#).is_ok());
        for bad in [
            "[1]",
            "{",
            r#"{"environments":{"a":{"key":"k"}}}"#,
            r#"{"environments":[]}"#,
        ] {
            assert!(parse_pins(bad).is_err(), "{bad}");
        }
        let config = temp_dir("pins-bad");
        std::fs::write(config.join(PINS_FILE), "nope").unwrap();
        assert!(pins(&config).is_err());
        let pin = Pin {
            key: key_text(1),
            version: "1.0.0".into(),
        };
        assert!(set_pin(&config, "x", pin).is_err());
        assert_eq!(
            std::fs::read_to_string(config.join(PINS_FILE)).unwrap(),
            "nope"
        );
        std::fs::remove_dir_all(&config).unwrap();
    }

    // ---- the pieces of a command ----

    #[test]
    fn only_a_release_version_has_a_program_to_fetch() {
        for ok in ["0.83.0", "1.2.3", "10.20.30"] {
            assert!(check_version(ok).is_ok(), "{ok}");
        }
        let dev = check_version("0.0.0").unwrap_err();
        assert!(dev.contains("開発版"), "{dev}");
        for bad in [
            "",
            "1.2",
            "1.2.3.4",
            "1.2.x",
            "v1.2.3",
            "1.2.3-beta",
            "1..3",
            "1.2.3; rm -rf /",
            "1.2.1234567",
        ] {
            assert!(check_version(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_release_is_the_one_of_the_updater_endpoint_of_the_app() {
        let url = release_url(TAURI_CONF, "0.83.0").unwrap();
        let suffix = "/releases/download/v0.83.0/tsunagiai.app.tar.gz";
        assert!(
            url.starts_with("https://github.com/") && url.ends_with(suffix),
            "{url}"
        );
        // The same repository as the endpoint the updater reads.
        let repo = url
            .strip_prefix("https://github.com/")
            .unwrap()
            .strip_suffix(suffix)
            .unwrap();
        assert!(TAURI_CONF.contains(&format!(
            "https://github.com/{repo}/releases/latest/download/latest.json"
        )));
        let conf = |endpoint: &str| {
            serde_json::json!({"plugins": {"updater": {"endpoints": [endpoint]}}}).to_string()
        };
        assert_eq!(
            release_url(
                &conf("https://github.com/o/r/releases/latest/download/latest.json"),
                "1.2.3"
            )
            .unwrap(),
            "https://github.com/o/r/releases/download/v1.2.3/tsunagiai.app.tar.gz"
        );
        for bad in [
            "https://example.com/o/r/releases/latest/download/latest.json",
            "http://github.com/o/r/releases/latest/download/latest.json",
            "https://github.com/o/r/x/releases/latest/download/latest.json",
            "https://github.com/o/releases/latest/download/latest.json",
            "https://github.com/o r/r/releases/latest/download/latest.json",
            "https://github.com/o/r/releases/latest/download/other.json",
            "",
        ] {
            assert!(release_url(&conf(bad), "1.2.3").is_err(), "{bad}");
        }
        assert!(release_url("{}", "1.2.3").is_err());
        assert!(release_url("nope", "1.2.3").is_err());
        assert!(release_url(TAURI_CONF, "0.0.0").is_err());
    }

    #[test]
    fn the_team_id_is_read_from_the_signature_of_the_app_and_none_is_a_reason() {
        let signed = "Executable=/x\nIdentifier=jp.mysis.tsunagiai\nAuthority=Apple Development: someone (ABCDE12345)\nTeamIdentifier=ABCDE12345\nSealed Resources=none\n";
        assert_eq!(parse_team_id(signed).unwrap(), "ABCDE12345");
        assert_eq!(
            parse_team_id("TeamIdentifier=0123456789").unwrap(),
            "0123456789"
        );
        for bad in [
            "",
            "Signature=adhoc\nTeamIdentifier=not set\n",
            "code object is not signed at all",
            "TeamIdentifier=\n",
            "TeamIdentifier=abcde12345\n",
            "TeamIdentifier=ABCDE1234\n",
            "TeamIdentifier=ABCDE12345X\n",
            "TeamIdentifier=ABC\"E12345\n",
        ] {
            let reason = parse_team_id(bad).unwrap_err();
            assert!(reason.contains("Team ID"), "{bad:?}: {reason}");
        }
    }

    #[test]
    fn the_server_is_put_at_an_ip_address_and_a_name_is_refused_with_the_reason() {
        assert_eq!(parse_host("10.0.0.2").unwrap().to_string(), "10.0.0.2");
        assert_eq!(parse_host("fe80::1").unwrap().to_string(), "fe80::1");
        for bad in [
            "mac-studio.local",
            "",
            "10.0.0.2:6768",
            "[::1]",
            "10.0.0.2; rm",
            "fe80::1%en0",
        ] {
            let reason = parse_host(bad).unwrap_err();
            assert!(reason.contains("IP アドレス"), "{bad:?}: {reason}");
        }
    }

    const URL: &str = "https://github.com/o/r/releases/download/v1.2.3/tsunagiai.app.tar.gz";

    fn place_text() -> String {
        place_command(URL, "1.2.3", "ABCDE12345", "10.0.0.2", &key_text(1)).unwrap()
    }

    #[test]
    fn the_place_command_is_one_line_in_one_quoted_word_that_no_shell_reads_differently() {
        let command = place_text();
        assert!(command.starts_with("sh -c '") && command.ends_with('\''));
        assert!(!command.contains('\n'));
        // The script has no single quote, so the word is closed by the last one only; and no backslash but before a double quote, which fish does not read as an escape in single quotes.
        assert_eq!(command.matches('\'').count(), 2);
        let mut rest = command.as_str();
        while let Some(at) = rest.find('\\') {
            assert!(rest[at + 1..].starts_with('"'), "{}", &rest[at..]);
            rest = &rest[at + 2..];
        }
        // It is the steps, in order, with the values the caller gave.
        let at = |needle: &str| {
            command
                .find(needle)
                .unwrap_or_else(|| panic!("{needle} is not in {command}"))
        };
        let steps = [
            "uname -sm",
            "mktemp -d",
            URL,
            "tar -xzf",
            "tsunagiai.app/Contents/MacOS/tsunagiai-mcp",
            "codesign --verify --strict \"$m\"",
            "leaf[subject.OU] = ",
            "ABCDE12345",
            "mkdir -p \"$d\"",
            "mv -f \"$d/tsunagiai-mcp.new\" \"$d/tsunagiai-mcp\"",
            "mv -f \"$d/version.new\" \"$d/version\"",
            "exec \"$d/tsunagiai-mcp\" --serve --bind 10.0.0.2 --client-key ",
        ];
        let places: Vec<usize> = steps.iter().map(|s| at(s)).collect();
        assert!(places.windows(2).all(|w| w[0] <= w[1]), "{places:?}");
        assert!(command.contains("echo \"1.2.3\" > \"$d/version.new\""));
        assert!(command.contains(&format!("--client-key {}'", key_text(1))));
        assert!(command.contains("$HOME/Library/Application Support/jp.mysis.tsunagiai/remote"));
        // The typed text does not hold the prefix of the error line, which the terminal shows back.
        assert!(!command.contains(error_line("").trim_end()));
        assert!(command.contains("fail()"));
    }

    #[test]
    fn a_value_that_a_shell_could_read_is_refused_before_a_command_is_made() {
        let key = key_text(1);
        let make = |url: &str, version: &str, team: &str, host: &str, client: &str| {
            place_command(url, version, team, host, client)
        };
        assert!(make(URL, "1.2.3", "ABCDE12345", "10.0.0.2", &key).is_ok());
        assert!(make(URL, "0.0.0", "ABCDE12345", "10.0.0.2", &key).is_err());
        assert!(make(URL, "1.2.3; x", "ABCDE12345", "10.0.0.2", &key).is_err());
        assert!(make(URL, "1.2.3", "ABCDE1234", "10.0.0.2", &key).is_err());
        assert!(make(URL, "1.2.3", "ABCDE1234\"", "10.0.0.2", &key).is_err());
        assert!(make(URL, "1.2.3", "ABCDE12345", "mac.local", &key).is_err());
        assert!(make(URL, "1.2.3", "ABCDE12345", "10.0.0.2; x", &key).is_err());
        assert!(make(URL, "1.2.3", "ABCDE12345", "10.0.0.2", "AAAA").is_err());
        assert!(make(URL, "1.2.3", "ABCDE12345", "10.0.0.2", "a; b").is_err());
        assert!(make(
            "http://github.com/x",
            "1.2.3",
            "ABCDE12345",
            "10.0.0.2",
            &key
        )
        .is_err());
        assert!(make(
            "https://github.com/x\"; id",
            "1.2.3",
            "ABCDE12345",
            "10.0.0.2",
            &key
        )
        .is_err());
        assert!(make(
            "https://example.com/x",
            "1.2.3",
            "ABCDE12345",
            "10.0.0.2",
            &key
        )
        .is_err());
    }

    #[test]
    fn the_start_command_runs_the_placed_program_with_serve_and_bind_only() {
        let command = start_command("10.0.0.2").unwrap();
        assert!(command.starts_with("sh -c '") && command.ends_with("--serve --bind 10.0.0.2'"));
        assert!(!command.contains('\n') && !command.contains("--client-key"));
        assert_eq!(command.matches('\'').count(), 2);
        assert!(command.contains(
            "m=\"$HOME/Library/Application Support/jp.mysis.tsunagiai/remote/tsunagiai-mcp\""
        ));
        assert!(!command.contains(error_line("").trim_end()));
        assert!(start_command("mac.local").is_err());
        assert!(start_command("10.0.0.2; x").is_err());
    }

    // ---- the commands, run by a real sh with stand-ins for what they call ----

    struct Pc {
        home: PathBuf,
        bin: PathBuf,
    }

    impl Pc {
        /// A PC whose `uname`, `curl`, `tar` and `codesign` are stand-ins: `curl` writes a file and keeps its URL, `tar` makes the program (a script that keeps its arguments and prints a ready line), and `codesign` keeps its arguments and fails as `FAIL_CODESIGN` says (`any`: every call, `team`: the one with `-R`).
        fn new(name: &str, machine: &str) -> Self {
            let root = temp_dir(name);
            let (home, bin) = (root.join("home"), root.join("bin"));
            std::fs::create_dir_all(&home).unwrap();
            std::fs::create_dir_all(&bin).unwrap();
            let pc = Self { home, bin };
            pc.stand_in("uname", &format!("echo '{machine}'"));
            pc.stand_in(
                "curl",
                "while [ $# -gt 0 ]; do case \"$1\" in -o) out=\"$2\"; shift;; http*) url=\"$1\";; esac; shift; done; echo \"$url\" >> \"$HOME/curl.log\"; echo archive > \"$out\"",
            );
            let ready = format!("TSUNAGIAI-SERVE {} 1.2.3", key_text(5));
            pc.stand_in(
                "tar",
                &format!(
                    "while [ $# -gt 0 ]; do case \"$1\" in -C) dir=\"$2\"; shift;; tsunagiai.app/*) member=\"$1\";; esac; shift; done; mkdir -p \"$dir/$(dirname \"$member\")\"; printf '%s\\n' '#!/bin/sh' 'echo \"$@\" > \"$(dirname \"$0\")/args\"' 'echo \"{ready}\"' > \"$dir/$member\"; chmod 755 \"$dir/$member\""
                ),
            );
            pc.stand_in(
                "codesign",
                "echo \"$@\" >> \"$HOME/codesign.log\"; case \"$FAIL_CODESIGN\" in any) exit 1;; team) case \"$*\" in *-R=*) exit 1;; esac;; esac; exit 0",
            );
            pc
        }

        fn stand_in(&self, name: &str, script: &str) {
            use std::os::unix::fs::PermissionsExt;
            let path = self.bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        fn remote(&self) -> PathBuf {
            self.home
                .join("Library/Application Support/jp.mysis.tsunagiai/remote")
        }

        /// Runs `command` as a shell of the PC does, and gives what it printed.
        fn run(&self, command: &str, fail_codesign: &str) -> String {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .env_clear()
                .env("HOME", &self.home)
                .env("PATH", format!("{}:/usr/bin:/bin", self.bin.display()))
                .env("FAIL_CODESIGN", fail_codesign)
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        fn done(self) {
            std::fs::remove_dir_all(self.home.parent().unwrap()).unwrap();
        }
    }

    fn first_served(output: &str) -> Served {
        let lines: Vec<String> = output.lines().map(str::to_owned).collect();
        served_in(&lines).unwrap_or_else(|| panic!("no line in {output:?}"))
    }

    #[test]
    fn the_place_command_puts_the_program_with_its_version_and_starts_it() {
        let pc = Pc::new("place-ok", "Darwin arm64");
        let output = pc.run(&place_text(), "");
        assert_eq!(
            first_served(&output),
            Served::Ready {
                key: key_text(5),
                version: "1.2.3".into()
            }
        );
        let remote = pc.remote();
        assert_eq!(
            std::fs::read_to_string(remote.join("version")).unwrap(),
            "1.2.3\n"
        );
        // The program that runs is the placed one, and it got what the app gave.
        assert_eq!(
            std::fs::read_to_string(remote.join("args")).unwrap().trim(),
            format!("--serve --bind 10.0.0.2 --client-key {}", key_text(1))
        );
        assert!(remote.join("tsunagiai-mcp").is_file());
        assert!(!remote.join("tsunagiai-mcp.new").exists() && !remote.join("version.new").exists());
        assert_eq!(
            std::fs::read_to_string(pc.home.join("curl.log"))
                .unwrap()
                .trim(),
            URL
        );
        // The signature and then the Team ID are checked.
        let log = std::fs::read_to_string(pc.home.join("codesign.log")).unwrap();
        let calls: Vec<&str> = log.lines().collect();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].starts_with("--verify --strict ") && !calls[0].contains("-R="));
        assert!(calls[1]
            .contains("-R=anchor apple generic and certificate leaf[subject.OU] = \"ABCDE12345\""));
        pc.done();
    }

    #[test]
    fn a_place_command_that_fails_prints_the_reason_and_puts_nothing() {
        let cases = [
            ("Darwin x86_64", "", "macOS"),
            ("Linux aarch64", "", "macOS"),
            ("Darwin arm64", "any", "署名が正しくありません"),
            ("Darwin arm64", "team", "署名が、つなぎAI の署名と違います"),
        ];
        for (n, (machine, fail, reason)) in cases.into_iter().enumerate() {
            let pc = Pc::new(&format!("place-fail-{n}"), machine);
            let output = pc.run(&place_text(), fail);
            match first_served(&output) {
                Served::Failed(text) => {
                    assert!(text.contains(reason), "{machine} {fail}: {text}");
                }
                other => panic!("{other:?}"),
            }
            assert!(
                !pc.remote().join("tsunagiai-mcp").exists(),
                "{machine} {fail}"
            );
            assert!(!pc.remote().join("version").exists(), "{machine} {fail}");
            pc.done();
        }
    }

    #[test]
    fn the_start_command_runs_the_placed_program_and_says_when_there_is_none() {
        let pc = Pc::new("start", "Darwin arm64");
        let command = start_command("10.0.0.2").unwrap();
        match first_served(&pc.run(&command, "")) {
            Served::Failed(text) => assert!(text.contains("置かれていません"), "{text}"),
            other => panic!("{other:?}"),
        }
        pc.run(&place_text(), "");
        std::fs::remove_file(pc.remote().join("args")).unwrap();
        assert!(matches!(
            first_served(&pc.run(&command, "")),
            Served::Ready { .. }
        ));
        assert_eq!(
            std::fs::read_to_string(pc.remote().join("args"))
                .unwrap()
                .trim(),
            "--serve --bind 10.0.0.2"
        );
        pc.done();
    }

    // ---- the lines on the screen ----

    fn lines(list: &[&str]) -> Vec<String> {
        list.iter().map(|l| (*l).to_owned()).collect()
    }

    #[test]
    fn the_first_ready_or_error_line_of_the_screen_is_what_the_program_printed() {
        let ready = formation_server::ready_line(&key_text(2), "1.2.3");
        let failed = error_line("ポートが使われています");
        assert_eq!(
            served_in(&lines(&["$ sh -c 'x'", "", &format!("  {ready}  "), "$ "])),
            Some(Served::Ready {
                key: key_text(2),
                version: "1.2.3".into()
            })
        );
        assert_eq!(
            served_in(&lines(&["$ x", &failed])),
            Some(Served::Failed("ポートが使われています".into()))
        );
        // The first one counts.
        assert_eq!(
            served_in(&lines(&[&failed, &ready])),
            Some(Served::Failed("ポートが使われています".into()))
        );
        for none in [
            lines(&[]),
            lines(&["$ ", "TSUNAGIAI-SERVE-STOPPED", "TSUNAGIAI-SERVE nokey 1"]),
            lines(&[&format!("$ echo {ready}")]),
        ] {
            assert_eq!(served_in(&none), None, "{none:?}");
        }
    }

    #[test]
    fn the_screen_is_read_until_a_line_is_there_and_not_past_the_time() {
        let ready = formation_server::ready_line(&key_text(2), "1.2.3");
        let mut reads = 0;
        let got = wait_line(
            &mut || {
                reads += 1;
                match reads {
                    1 => Ok(lines(&["$ "])),
                    2 => Err("busy".into()),
                    _ => Ok(lines(&["$ ", &ready])),
                }
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
            &served_in,
        );
        assert_eq!(
            got,
            Ok(Served::Ready {
                key: key_text(2),
                version: "1.2.3".into()
            })
        );
        assert_eq!(reads, 3);
        let silent = wait_line(
            &mut || Ok(lines(&["$ "])),
            Duration::from_millis(30),
            Duration::from_millis(5),
            &served_in,
        );
        assert_eq!(silent, Err("時間内にサーバーが答えませんでした".to_owned()));
        let broken = wait_line(
            &mut || Err("Orca が応答しません".into()),
            Duration::from_millis(30),
            Duration::from_millis(5),
            &served_in,
        )
        .unwrap_err();
        assert!(broken.contains("Orca が応答しません"), "{broken}");
    }

    #[test]
    fn the_terminal_is_made_in_the_floating_terminal_of_the_environment_and_always_closed() {
        let ready = formation_server::ready_line(&key_text(2), "1.2.3");
        let failed = error_line("no");
        let run = |screens: Vec<Result<Value, String>>, create: Value| {
            let calls = RefCell::new(Vec::<Vec<String>>::new());
            let queue = RefCell::new(screens.into_iter());
            let write = |args: &[String]| {
                calls.borrow_mut().push(args.to_vec());
                Ok(create.clone())
            };
            let read = |args: &[String]| {
                calls.borrow_mut().push(args.to_vec());
                queue
                    .borrow_mut()
                    .next()
                    .unwrap_or(Ok(serde_json::json!({})))
            };
            let got = run_terminal(
                "mac-studio",
                "sh -c 'x'",
                Duration::from_millis(40),
                Duration::from_millis(5),
                &write,
                &read,
            );
            (got, calls.into_inner())
        };
        let screen = |text: &str| Ok(serde_json::json!({"terminal": {"tail": ["$ ", text]}}));
        let made = serde_json::json!({"terminal": {"handle": "term_1"}});
        // A ready line: the terminal is made, read and closed.
        let (got, calls) = run(vec![screen(&ready)], made.clone());
        assert_eq!(
            got,
            Ok(Served::Ready {
                key: key_text(2),
                version: "1.2.3".into()
            })
        );
        let steps: Vec<String> = calls.iter().map(|a| a[..2].join(" ")).collect();
        assert_eq!(
            steps,
            ["terminal create", "terminal read", "terminal close"]
        );
        assert_eq!(
            calls[0],
            [
                "terminal",
                "create",
                "--worktree",
                "global-floating-terminal",
                "--title",
                "tsunagiai-server",
                "--command",
                "sh -c 'x'",
                "--json",
                "--environment=mac-studio"
            ]
        );
        assert_eq!(
            calls[1],
            [
                "terminal",
                "read",
                "--terminal",
                "term_1",
                "--screen",
                "--json",
                "--environment=mac-studio"
            ]
        );
        assert_eq!(calls[2][..4], ["terminal", "close", "--terminal", "term_1"]);
        assert_eq!(calls[2].last().unwrap(), "--environment=mac-studio");
        // An error line and a time out close it too.
        let (got, calls) = run(vec![screen(&failed)], made.clone());
        assert_eq!(got, Ok(Served::Failed("no".into())));
        assert_eq!(calls.last().unwrap()[1], "close");
        let (got, calls) = run(vec![], made);
        assert!(got.is_err());
        assert_eq!(calls.last().unwrap()[1], "close");
        // A terminal that was not made has nothing to close.
        let (got, calls) = run(vec![], serde_json::json!({}));
        assert!(got.is_err());
        assert_eq!(calls.len(), 1);
    }

    // ---- the consent of the owner (#893) ----

    #[test]
    fn the_consents_are_the_pinned_environments_in_order_with_their_versions() {
        let config = temp_dir("consents");
        assert!(consents(&config).unwrap().is_empty());
        let pin = |seed: u8, version: &str| Pin {
            key: key_text(seed),
            version: version.to_owned(),
        };
        set_pin(&config, "mac-studio", pin(1, "0.83.0")).unwrap();
        set_pin(&config, "box", pin(2, "0.84.0")).unwrap();
        assert_eq!(
            consents(&config).unwrap(),
            [
                FormationConsent {
                    environment: "box".into(),
                    version: "0.84.0".into()
                },
                FormationConsent {
                    environment: "mac-studio".into(),
                    version: "0.83.0".into()
                }
            ]
        );
        std::fs::write(config.join(PINS_FILE), "nope").unwrap();
        assert!(consents(&config).is_err());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_consent_is_taken_for_a_saved_environment_only() {
        assert!(check_consent_target("mac-studio").is_ok());
        for bad in ["local", "", "  "] {
            assert!(check_consent_target(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_stop_command_stops_the_placed_program_takes_remote_away_and_prints_its_own_line() {
        let command = stop_command();
        assert!(command.starts_with("sh -c '"), "{command}");
        assert!(command.contains("--serve-stop"), "{command}");
        // Only the folder of the program is deleted, and it is the one `place` puts the program in.
        assert!(
            command.contains(&format!("d=\"{}\"", remote_dir_shell())),
            "{command}"
        );
        assert!(command.contains("rm -rf \"$d\""), "{command}");
        assert!(
            command.contains(&format!("m=\"$d/{PROGRAM_FILE}\"")),
            "{command}"
        );
        // A PC without the program has nothing to stop.
        assert!(command.contains("if [ -x \"$m\" ]"), "{command}");
        // The lines are printed from two halves: the typed text is no line.
        assert!(!command.contains(STOPPED_LINE), "{command}");
        assert!(!command.contains(&error_line("")), "{command}");
        // The stopped line is the last statement, after `remote/` is gone.
        let rm = command.find("rm -rf").unwrap();
        let echo = command.rfind("echo").unwrap();
        assert!(rm < echo, "{command}");
        // No quote inside the quoted word.
        assert_eq!(command.matches('\'').count(), 2, "{command}");
    }

    #[test]
    fn the_first_stopped_or_error_line_of_the_screen_is_what_the_stop_printed() {
        assert_eq!(
            stopped_in(&lines(&["$ x", "  TSUNAGIAI-SERVE-STOPPED  ", "$ "])),
            Some(Ok(()))
        );
        assert_eq!(
            stopped_in(&lines(&[&error_line("止められません"), STOPPED_LINE])),
            Some(Err("止められません".into()))
        );
        for none in [
            lines(&[]),
            lines(&["$ echo TSUNAGIAI-SERVE-STOPPED"]),
            lines(&[&formation_server::ready_line(&key_text(2), "1.2.3")]),
        ] {
            assert_eq!(stopped_in(&none), None, "{none:?}");
        }
    }

    fn pinned_config(name: &str) -> PathBuf {
        let config = temp_dir(name);
        for environment in ["mac-studio", "box"] {
            set_pin(
                &config,
                environment,
                Pin {
                    key: key_text(1),
                    version: "0.83.0".into(),
                },
            )
            .unwrap();
        }
        config
    }

    fn pinned_names(config: &Path) -> Vec<String> {
        pins(config).unwrap().into_keys().collect()
    }

    #[test]
    fn a_revocation_with_a_formation_left_on_the_pc_is_refused_with_the_names_and_does_nothing() {
        let config = pinned_config("revoke-left");
        let asked = RefCell::new(0);
        let err = revoke_with(
            &config,
            "mac-studio",
            &["won-1".to_owned(), "won-2".to_owned()],
            &|| {
                *asked.borrow_mut() += 1;
                false
            },
            &|_, _| panic!("nothing is run on the PC"),
        )
        .unwrap_err();
        assert!(
            err.contains("環境「mac-studio」") && err.contains("won-1、won-2"),
            "{err}"
        );
        // The environment is not even looked up, and the consent stays.
        assert_eq!(*asked.borrow(), 0);
        assert_eq!(pinned_names(&config), ["box", "mac-studio"]);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_revocation_runs_the_stop_on_the_pc_and_then_forgets_only_that_pin() {
        let config = pinned_config("revoke-stop");
        let seen = RefCell::new(Vec::<(String, Duration)>::new());
        revoke_with(&config, "mac-studio", &[], &|| false, &|command, wait| {
            // The pin is still there while the command runs: a failure keeps it.
            assert!(pins(&config).unwrap().contains_key("mac-studio"));
            seen.borrow_mut().push((command.to_owned(), wait));
            Ok(Ok(()))
        })
        .unwrap();
        assert_eq!(*seen.borrow(), [(stop_command(), STOP_WAIT)]);
        assert_eq!(pinned_names(&config), ["box"]);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_revocation_of_an_environment_gone_from_orca_touches_no_pc_and_forgets_the_pin() {
        let config = pinned_config("revoke-gone");
        revoke_with(&config, "box", &[], &|| true, &|_, _| {
            panic!("nothing is run on the PC")
        })
        .unwrap();
        assert_eq!(pinned_names(&config), ["mac-studio"]);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_stop_that_failed_keeps_the_consent_with_the_reason() {
        let config = pinned_config("revoke-failed");
        let reason = revoke_with(&config, "box", &[], &|| false, &|_, _| {
            Ok(Err("サーバーを止められません".into()))
        })
        .unwrap_err();
        assert!(
            reason.contains("サーバーを止められませんでした") && reason.contains("止められません"),
            "{reason}"
        );
        let silent = revoke_with(&config, "box", &[], &|| false, &|_, _| {
            Err("時間内にサーバーが答えませんでした".into())
        })
        .unwrap_err();
        assert_eq!(silent, "時間内にサーバーが答えませんでした");
        assert_eq!(pinned_names(&config), ["box", "mac-studio"]);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn an_environment_with_no_consent_has_none_to_take_back_and_nothing_is_run() {
        let config = pinned_config("revoke-none");
        let err = revoke_with(&config, "mac-mini", &[], &|| false, &|_, _| {
            panic!("nothing is run on the PC")
        })
        .unwrap_err();
        assert!(
            err.contains("環境「mac-mini」") && err.contains("同意がありません"),
            "{err}"
        );
        assert_eq!(pinned_names(&config), ["box", "mac-studio"]);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn the_stop_terminal_waits_for_the_stopped_line_and_is_closed() {
        let calls = RefCell::new(Vec::<String>::new());
        let write = |args: &[String]| {
            calls.borrow_mut().push(args[..2].join(" "));
            Ok(serde_json::json!({"terminal": {"handle": "term_1"}}))
        };
        let read = |args: &[String]| {
            calls.borrow_mut().push(args[..2].join(" "));
            Ok(serde_json::json!({"terminal": {"tail": ["$ ", STOPPED_LINE]}}))
        };
        let got = run_terminal_for(
            "mac-studio",
            &stop_command(),
            Duration::from_millis(40),
            Duration::from_millis(5),
            &write,
            &read,
            &stopped_in,
        );
        assert_eq!(got, Ok(Ok(())));
        assert_eq!(
            *calls.borrow(),
            ["terminal create", "terminal read", "terminal close"]
        );
    }

    // ---- place and start ----

    fn client_public() -> [u8; 32] {
        public_of(&[1; 32])
    }

    fn ready(seed: u8, version: &str) -> Served {
        Served::Ready {
            key: key_text(seed),
            version: version.to_owned(),
        }
    }

    #[test]
    fn a_placement_pins_the_key_and_the_version_of_the_ready_line() {
        let config = temp_dir("place-pin");
        let seen = RefCell::new(Vec::<(String, Duration)>::new());
        let run = |command: &str, wait: Duration| {
            seen.borrow_mut().push((command.to_owned(), wait));
            Ok(ready(7, "1.2.3"))
        };
        let pin = place_with(
            &config,
            "mac-studio",
            "1.2.3",
            "ABCDE12345",
            &client_public(),
            "10.0.0.2",
            &run,
        )
        .unwrap();
        assert_eq!(
            pin,
            Pin {
                key: key_text(7),
                version: "1.2.3".into()
            }
        );
        assert_eq!(pins(&config).unwrap()["mac-studio"], pin);
        let seen = seen.borrow();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].0.contains("--serve --bind 10.0.0.2 --client-key "));
        assert!(seen[0].0.contains(&STANDARD.encode(client_public())));
        assert_eq!(seen[0].1, PLACE_WAIT);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_placement_that_fails_pins_nothing_and_says_why() {
        let config = temp_dir("place-fail");
        let place = |version: &str, team: &str, host: &str, served: Result<Served, String>| {
            let called = RefCell::new(0);
            let run = |_: &str, _: Duration| {
                *called.borrow_mut() += 1;
                served.clone()
            };
            let got = place_with(
                &config,
                "mac-studio",
                version,
                team,
                &client_public(),
                host,
                &run,
            );
            (got, called.into_inner())
        };
        // A failure line: its words come back.
        let (got, called) = place(
            "1.2.3",
            "ABCDE12345",
            "10.0.0.2",
            Ok(Served::Failed(
                "この PC は macOS（Apple Silicon）ではありません".into(),
            )),
        );
        let reason = got.unwrap_err();
        assert!(
            reason.contains("サーバーを置けませんでした") && reason.contains("Apple Silicon"),
            "{reason}"
        );
        assert_eq!(called, 1);
        // The ready line of another version than the one placed.
        let (got, _) = place("1.2.3", "ABCDE12345", "10.0.0.2", Ok(ready(7, "1.2.2")));
        assert!(got.unwrap_err().contains("1.2.2"));
        // The terminal gave nothing.
        let (got, _) = place(
            "1.2.3",
            "ABCDE12345",
            "10.0.0.2",
            Err("時間内にサーバーが答えませんでした".into()),
        );
        assert!(got.unwrap_err().contains("時間内"));
        // Nothing is typed for a development build, a name and a bad Team ID.
        for (version, team, host) in [
            ("0.0.0", "ABCDE12345", "10.0.0.2"),
            ("1.2.3", "ABCDE12345", "mac.local"),
            ("1.2.3", "x", "10.0.0.2"),
        ] {
            let (got, called) = place(version, team, host, Ok(ready(7, "1.2.3")));
            assert!(got.is_err(), "{version} {team} {host}");
            assert_eq!(called, 0, "{version} {team} {host}");
        }
        assert!(pins(&config).unwrap().is_empty());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_start_runs_the_serve_command_and_pins_what_the_server_says() {
        let config = temp_dir("start-pin");
        set_pin(
            &config,
            "mac-studio",
            Pin {
                key: key_text(1),
                version: "1.2.2".into(),
            },
        )
        .unwrap();
        let seen = RefCell::new(Vec::<(String, Duration)>::new());
        let run = |command: &str, wait: Duration| {
            seen.borrow_mut().push((command.to_owned(), wait));
            Ok(ready(9, "1.2.3"))
        };
        let pin = start_with(&config, "mac-studio", "10.0.0.2", &run).unwrap();
        assert_eq!(
            pin,
            Pin {
                key: key_text(9),
                version: "1.2.3".into()
            }
        );
        assert_eq!(pins(&config).unwrap()["mac-studio"], pin);
        assert_eq!(seen.borrow()[0].0, start_command("10.0.0.2").unwrap());
        assert!(seen.borrow()[0].1 < PLACE_WAIT);
        // A failure line leaves the pin as it was.
        let failing = |_: &str, _: Duration| Ok(Served::Failed("ポートが使われています".into()));
        let reason = start_with(&config, "mac-studio", "10.0.0.2", &failing).unwrap_err();
        assert!(
            reason.contains("サーバーを起動できませんでした") && reason.contains("ポート"),
            "{reason}"
        );
        assert_eq!(pins(&config).unwrap()["mac-studio"], pin);
        assert!(start_with(&config, "mac-studio", "mac.local", &run).is_err());
        std::fs::remove_dir_all(&config).unwrap();
    }

    // ---- connect ----

    #[test]
    fn what_to_do_after_a_try_is_use_start_place_or_give_up() {
        let version = |v: &str| Heard::Version(v.into());
        let silent = || Heard::Silent("refused".into());
        // The version of the app: use it, whatever was done before.
        for (started, placed) in [(false, false), (true, false), (true, true)] {
            assert_eq!(
                decide(&version("1.2.3"), "1.2.3", started, placed),
                Step::Use
            );
        }
        // Nobody answers: start once, then give up.
        assert_eq!(decide(&silent(), "1.2.3", false, false), Step::Start);
        assert_eq!(
            decide(&silent(), "1.2.3", true, false),
            Step::GiveUp(
                "サーバーにつなげません: refused。その PC の画面にファイアウォールの確認が出ていたら「許可」を押して、もう一度試してください"
                    .into()
            )
        );
        // Another version: place once, then give up; a start before does not stop a placement.
        assert_eq!(
            decide(&version("1.2.2"), "1.2.3", false, false),
            Step::Place
        );
        assert_eq!(decide(&version("1.2.2"), "1.2.3", true, false), Step::Place);
        assert!(matches!(
            decide(&version("1.2.2"), "1.2.3", true, true),
            Step::GiveUp(m) if m.contains("1.2.2") && m.contains("1.2.3")
        ));
        // A placement starts the server, so a silence after it is given up on, not started again.
        assert!(matches!(
            decide(&silent(), "1.2.3", true, true),
            Step::GiveUp(_)
        ));
    }

    struct Pcs {
        config: PathBuf,
        port: u16,
        secret: [u8; 32],
        server_secret: [u8; 32],
    }

    impl Pcs {
        fn new(name: &str) -> Self {
            let port = {
                let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                probe.local_addr().unwrap().port()
            };
            Self {
                config: temp_dir(name),
                port,
                secret: [1; 32],
                server_secret: [2; 32],
            }
        }

        /// Starts a server on the port, the way the program of the PC does, serving `version`.
        fn serve(&self, version: &str) -> tokio::task::JoinHandle<()> {
            serve_at(
                self.port,
                self.config.clone(),
                self.server_secret,
                public_of(&self.secret),
                version,
            )
        }

        fn pin(&self, key_of: &[u8; 32], version: &str) {
            set_pin(
                &self.config,
                "pc",
                Pin {
                    key: STANDARD.encode(public_of(key_of)),
                    version: version.into(),
                },
            )
            .unwrap();
        }

        async fn connect(&self, act: &Act) -> Result<Client, String> {
            self.connect_in(&Acting::default(), true, act).await
        }

        async fn connect_in(
            &self,
            acting: &Acting,
            wait: bool,
            act: &Act,
        ) -> Result<Client, String> {
            connect_with(
                &self.config,
                "pc",
                "1.2.3",
                "127.0.0.1",
                self.port,
                self.secret,
                pin_of(&self.config, "pc")?,
                wait,
                acting,
                act,
            )
            .await
        }
    }

    /// A server on `port` that is bound before this returns, so that a connection made at once is taken.
    fn serve_at(
        port: u16,
        config: PathBuf,
        secret: [u8; 32],
        client_public: [u8; 32],
        version: &str,
    ) -> tokio::task::JoinHandle<()> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let setup = Setup {
            config,
            secret,
            client_public,
            version: version.to_owned(),
        };
        tokio::spawn(async move {
            serve(TcpListener::from_std(listener).unwrap(), setup).await;
        })
    }

    fn counting(
        calls: &Arc<Mutex<Vec<Do>>>,
        each: impl Fn(Do) -> Result<(), String> + Send + Sync + 'static,
    ) -> Act {
        let calls = calls.clone();
        Arc::new(move |what| {
            calls.lock().unwrap().push(what);
            each(what)
        })
    }

    #[tokio::test]
    async fn an_environment_with_no_pinned_key_is_refused_and_nothing_is_done_on_its_pc() {
        let pcs = Pcs::new("connect-no-pin");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let act = counting(&calls, |_| Ok(()));
        let reason = pcs.connect(&act).await.err().unwrap();
        assert!(
            reason.contains("環境「pc」") && reason.contains("許可していません"),
            "{reason}"
        );
        assert!(calls.lock().unwrap().is_empty());
        // Another environment's pin is not this one's.
        set_pin(
            &pcs.config,
            "other",
            Pin {
                key: key_text(1),
                version: "1.2.3".into(),
            },
        )
        .unwrap();
        assert!(pcs.connect(&act).await.is_err());
        assert!(calls.lock().unwrap().is_empty());
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    #[tokio::test]
    async fn a_server_of_the_version_of_the_app_is_connected_to_without_a_start() {
        let pcs = Pcs::new("connect-ok");
        pcs.pin(&pcs.server_secret, "1.2.3");
        let task = pcs.serve("1.2.3");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut client = pcs.connect(&counting(&calls, |_| Ok(()))).await.unwrap();
        assert_eq!(client.version().await.unwrap(), "1.2.3");
        assert!(calls.lock().unwrap().is_empty());
        client.stop().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    #[tokio::test]
    async fn when_nobody_answers_the_server_is_started_once_and_the_connection_is_tried_again() {
        let pcs = Pcs::new("connect-start");
        pcs.pin(&pcs.server_secret, "1.2.3");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let tasks = Arc::new(Mutex::new(Vec::new()));
        let act = {
            let tasks = tasks.clone();
            let handle = tokio::runtime::Handle::current();
            let (port, config, secret, server_secret) =
                (pcs.port, pcs.config.clone(), pcs.secret, pcs.server_secret);
            counting(&calls, move |_| {
                // What the start does on the PC: a server that listens.
                let _in_runtime = handle.enter();
                tasks.lock().unwrap().push(serve_at(
                    port,
                    config.clone(),
                    server_secret,
                    public_of(&secret),
                    "1.2.3",
                ));
                Ok(())
            })
        };
        let mut client = pcs.connect(&act).await.unwrap();
        assert_eq!(client.version().await.unwrap(), "1.2.3");
        assert_eq!(*calls.lock().unwrap(), [Do::Start]);
        client.stop().await.unwrap();
        let started: Vec<_> = tasks.lock().unwrap().drain(..).collect();
        for task in started {
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
        }
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    #[tokio::test]
    async fn a_start_that_fails_or_does_not_help_is_one_start_and_a_reason() {
        let pcs = Pcs::new("connect-start-fails");
        pcs.pin(&pcs.server_secret, "1.2.3");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let reason = pcs
            .connect(&counting(&calls, |_| {
                Err("サーバーを起動できませんでした: ポートが使われています".into())
            }))
            .await
            .err()
            .unwrap();
        assert!(reason.contains("ポートが使われています"), "{reason}");
        assert_eq!(*calls.lock().unwrap(), [Do::Start]);
        // A start that says it worked, and nobody answers still: not started again.
        let calls = Arc::new(Mutex::new(Vec::new()));
        let reason = pcs
            .connect(&counting(&calls, |_| Ok(())))
            .await
            .err()
            .unwrap();
        assert!(
            reason.contains("サーバーにつなげません") && reason.contains("ファイアウォール"),
            "{reason}"
        );
        assert_eq!(*calls.lock().unwrap(), [Do::Start]);
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    #[tokio::test]
    async fn a_server_of_another_version_is_placed_again_once() {
        let pcs = Pcs::new("connect-place");
        pcs.pin(&pcs.server_secret, "1.2.2");
        let task = pcs.serve("1.2.2");
        let calls = Arc::new(Mutex::new(Vec::new()));
        // A placement that leaves the old server running: one placement, and the versions in the reason.
        let reason = pcs
            .connect(&counting(&calls, |_| Ok(())))
            .await
            .err()
            .unwrap();
        assert!(
            reason.contains("1.2.2") && reason.contains("1.2.3"),
            "{reason}"
        );
        assert_eq!(*calls.lock().unwrap(), [Do::Place]);
        // A placement that fails is its reason, and the server is not started after it.
        let calls = Arc::new(Mutex::new(Vec::new()));
        let reason = pcs
            .connect(&counting(&calls, |_| {
                Err("サーバーを置けませんでした: 署名".into())
            }))
            .await
            .err()
            .unwrap();
        assert!(reason.contains("署名"), "{reason}");
        assert_eq!(*calls.lock().unwrap(), [Do::Place]);
        task.abort();
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    #[tokio::test]
    async fn a_pin_of_another_key_is_started_for_the_key_the_server_says_and_then_believed() {
        let pcs = Pcs::new("connect-stale-key");
        // The pin is of a key the server does not have: it does not answer to it.
        pcs.pin(&[9; 32], "1.2.3");
        let task = pcs.serve("1.2.3");
        let calls = Arc::new(AtomicUsize::new(0));
        let act: Act = {
            let (config, count) = (pcs.config.clone(), calls.clone());
            let server_public = STANDARD.encode(public_of(&pcs.server_secret));
            Arc::new(move |what| {
                assert_eq!(what, Do::Start);
                count.fetch_add(1, Ordering::SeqCst);
                // What a start does: pins the key the program prints.
                set_pin(
                    &config,
                    "pc",
                    Pin {
                        key: server_public.clone(),
                        version: "1.2.3".into(),
                    },
                )
            })
        };
        let mut client = pcs.connect(&act).await.unwrap();
        assert_eq!(client.version().await.unwrap(), "1.2.3");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        client.stop().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }
    /// An act that waits until `release` is sent, so that a start or a placement is "running" for as long as a test wants.
    fn held(calls: &Arc<Mutex<Vec<Do>>>) -> (Act, std::sync::mpsc::Sender<()>) {
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let wait = Mutex::new(wait);
        let act = counting(calls, move |_| {
            let _ = wait.lock().unwrap().recv();
            Ok(())
        });
        (act, release)
    }

    async fn free(acting: &Acting, environment: &str) {
        for _ in 0..100 {
            if !acting.0.lock().unwrap().running.contains_key(environment) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the start did not end");
    }

    #[tokio::test]
    async fn a_read_that_does_not_wait_starts_the_server_in_the_background_and_answers_what_is_going_on(
    ) {
        let pcs = Pcs::new("connect-no-wait-start");
        pcs.pin(&pcs.server_secret, "1.2.3");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (act, release) = held(&calls);
        let acting = Acting::default();
        let began = Instant::now();
        let reason = pcs.connect_in(&acting, false, &act).await.err().unwrap();
        assert!(reason.contains("起動しています"), "{reason}");
        // It did not wait for the start, which is still held.
        assert!(began.elapsed() < Duration::from_secs(5));
        // The next read finds it running: the same words, and no second start.
        let reason = pcs.connect_in(&acting, false, &act).await.err().unwrap();
        assert!(reason.contains("起動しています"), "{reason}");
        // A read that waits does not begin a second one either, and does not wait for the first.
        let reason = pcs.connect_in(&acting, true, &act).await.err().unwrap();
        assert!(reason.contains("起動しています"), "{reason}");
        release.send(()).unwrap();
        free(&acting, "pc").await;
        assert_eq!(*calls.lock().unwrap(), [Do::Start]);
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    #[tokio::test]
    async fn a_read_that_does_not_wait_places_the_program_again_in_the_background_and_says_so() {
        let pcs = Pcs::new("connect-no-wait-place");
        pcs.pin(&pcs.server_secret, "1.2.2");
        let task = pcs.serve("1.2.2");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (act, release) = held(&calls);
        let acting = Acting::default();
        let reason = pcs.connect_in(&acting, false, &act).await.err().unwrap();
        assert!(reason.contains("入れ直しています"), "{reason}");
        let reason = pcs.connect_in(&acting, false, &act).await.err().unwrap();
        assert!(reason.contains("入れ直しています"), "{reason}");
        release.send(()).unwrap();
        free(&acting, "pc").await;
        assert_eq!(*calls.lock().unwrap(), [Do::Place]);
        task.abort();
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    #[test]
    fn a_read_that_does_not_wait_gives_the_handshake_a_shorter_deadline() {
        assert_eq!(
            handshake_deadline(true),
            formation_server::HANDSHAKE_DEADLINE
        );
        assert_eq!(handshake_deadline(false), SCREEN_HANDSHAKE);
        assert!(SCREEN_HANDSHAKE < formation_server::HANDSHAKE_DEADLINE);
    }

    #[tokio::test]
    async fn a_read_that_does_not_wait_takes_a_pc_that_connects_and_says_nothing_for_silent_and_starts_it(
    ) {
        // What a PC does while its firewall waits for an answer: the TCP connection is taken, and nothing comes back.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut pcs = Pcs::new("connect-no-wait-silent");
        pcs.port = listener.local_addr().unwrap().port();
        let silent = tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    held.push(stream);
                }
            }
        });
        pcs.pin(&pcs.server_secret, "1.2.3");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (act, release) = held(&calls);
        let acting = Acting::default();
        let began = Instant::now();
        let reason = pcs.connect_in(&acting, false, &act).await.err().unwrap();
        // The silence reached `decide`, which started the server in the background, within the shorter deadline.
        assert!(reason.contains("起動しています"), "{reason}");
        assert!(
            began.elapsed() >= SCREEN_HANDSHAKE && began.elapsed() < SCREEN_HANDSHAKE * 2,
            "{:?}",
            began.elapsed()
        );
        release.send(()).unwrap();
        free(&acting, "pc").await;
        assert_eq!(*calls.lock().unwrap(), [Do::Start]);
        silent.abort();
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    #[tokio::test]
    async fn a_read_that_does_not_wait_uses_a_server_that_answers_with_no_start() {
        let pcs = Pcs::new("connect-no-wait-ok");
        pcs.pin(&pcs.server_secret, "1.2.3");
        let task = pcs.serve("1.2.3");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut client = pcs
            .connect_in(&Acting::default(), false, &counting(&calls, |_| Ok(())))
            .await
            .unwrap();
        assert_eq!(client.version().await.unwrap(), "1.2.3");
        assert!(calls.lock().unwrap().is_empty());
        client.stop().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        std::fs::remove_dir_all(&pcs.config).unwrap();
    }

    // ---- the connection of pushes ----

    const FAST: Backoff = Backoff {
        first: Duration::from_millis(10),
        max: Duration::from_millis(40),
    };

    fn push_request(method: &str) -> PushRequest {
        PushRequest {
            method: method.to_owned(),
            params: Value::Null,
        }
    }

    fn free_port() -> u16 {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        probe.local_addr().unwrap().port()
    }

    /// A server with a hub of its own on `port`; aborting the task closes its connections too.
    fn serve_hub_at(
        port: u16,
        secret: [u8; 32],
        client_public: [u8; 32],
    ) -> (tokio::task::JoinHandle<()>, Arc<Hub>) {
        // The port can be held for a moment by a socket of the app's own tries while no server is on it (未確認: a connection of the ephemeral range to itself): bind again until it is free.
        let until = Instant::now() + Duration::from_secs(5);
        let listener = loop {
            match std::net::TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => break listener,
                Err(e) if Instant::now() > until => panic!("port {port}: {e}"),
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        listener.set_nonblocking(true).unwrap();
        let setup = Setup {
            config: std::env::temp_dir(),
            secret,
            client_public,
            version: "1.2.3".to_owned(),
        };
        let hub = Hub::new();
        let task = tokio::spawn(serve_with(
            TcpListener::from_std(listener).unwrap(),
            setup,
            hub.clone(),
        ));
        (task, hub)
    }

    /// Pushes until the app's connection is there to take it (it connects again after a back-off).
    async fn push_when_connected(hub: &Hub, method: &str) {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            match hub.push(push_request(method)).await {
                Ok(()) => return,
                Err(e) if Instant::now() > until => panic!("not delivered: {e}"),
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    }

    fn pushed_to(seen: &Arc<Mutex<Vec<PushRequest>>>) -> PushHandler {
        let seen = seen.clone();
        Arc::new(move |request| {
            seen.lock().unwrap().push(request);
            Box::pin(async { Ok(()) })
        })
    }

    #[tokio::test]
    async fn the_connection_of_pushes_is_opened_again_after_it_is_cut() {
        let (client_secret, server_secret) = ([1; 32], [2; 32]);
        let port = free_port();
        let (first, hub) = serve_hub_at(port, server_secret, public_of(&client_secret));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = pushed_to(&seen);
        let kept = tokio::spawn(async move {
            keep_open(
                || Client::connect("127.0.0.1", port, client_secret, public_of(&server_secret)),
                &handler,
                FAST,
            )
            .await;
        });
        push_when_connected(&hub, "one").await;
        // The server goes away with its connections, and another takes its port.
        first.abort();
        let _ = first.await;
        let (second, hub) = serve_hub_at(port, server_secret, public_of(&client_secret));
        push_when_connected(&hub, "two").await;
        let methods: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.method.clone())
            .collect();
        assert_eq!(methods, ["one", "two"]);
        kept.abort();
        second.abort();
    }

    #[tokio::test]
    async fn an_app_that_the_server_does_not_know_is_never_pushed_to() {
        let port = free_port();
        let (task, hub) = serve_hub_at(port, [2; 32], public_of(&[1; 32]));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = pushed_to(&seen);
        // The app holds another key than the one the server pinned.
        let kept = tokio::spawn(async move {
            keep_open(
                || Client::connect("127.0.0.1", port, [9; 32], public_of(&[2; 32])),
                &handler,
                FAST,
            )
            .await;
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(hub.push(push_request("one")).await.is_err());
        assert!(seen.lock().unwrap().is_empty());
        assert!(!kept.is_finished(), "it goes on trying");
        kept.abort();
        task.abort();
    }

    #[test]
    fn the_wait_before_the_next_try_doubles_up_to_its_limit() {
        let delays: Vec<Duration> =
            std::iter::successors(Some(BACKOFF.first), |d| Some(next_delay(*d, BACKOFF)))
                .take(8)
                .collect();
        let seconds: Vec<u64> = delays.iter().map(Duration::as_secs).collect();
        assert_eq!(seconds, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    struct Dropped(Arc<AtomicUsize>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn a_task_runs_for_each_environment_of_the_list_and_ends_when_it_leaves_it() {
        let (started, ended) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let names =
            |list: &[&str]| -> Vec<String> { list.iter().map(|n| (*n).to_owned()).collect() };
        let subscriptions = Subscriptions::default();
        let start = |_: &str| {
            let (started, ended) = (started.clone(), ended.clone());
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                let _dropped = Dropped(ended);
                std::future::pending::<()>().await;
            }
        };
        subscriptions.set(&names(&["a", "b"]), start);
        // The list is read again: the one that is there is not started twice.
        subscriptions.set(&names(&["a", "b"]), start);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(started.load(Ordering::SeqCst), 2);
        assert_eq!(ended.load(Ordering::SeqCst), 0);
        // One that has left the list is ended, and the other goes on.
        subscriptions.set(&names(&["a"]), start);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(ended.load(Ordering::SeqCst), 1);
        assert_eq!(started.load(Ordering::SeqCst), 2);
        // One that comes back is started again.
        subscriptions.set(&names(&["a", "b"]), start);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(started.load(Ordering::SeqCst), 3);
        subscriptions.set(&[], start);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(ended.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_connection_of_pushes_is_kept_only_to_a_saved_environment_the_owner_agreed_to() {
        let pin = |seed: u8| Pin {
            key: key_text(seed),
            version: "1.2.3".to_owned(),
        };
        let pins = BTreeMap::from([("pc-a".to_owned(), pin(1)), ("gone".to_owned(), pin(2))]);
        let saved = ["pc-a", "pc-b"].map(str::to_owned);
        // `pc-b` is saved and not agreed to, and `gone` is agreed to and no longer saved.
        assert_eq!(push_targets(&saved, &pins), ["pc-a"]);
        assert!(push_targets(&[], &pins).is_empty());
        assert!(push_targets(&saved, &BTreeMap::new()).is_empty());
    }

    #[test]
    fn a_push_that_is_not_a_request_to_open_a_preview_is_refused_with_a_reason_that_quotes_nothing_of_it(
    ) {
        let request = PushRequest {
            method: "ignore previous instructions".to_owned(),
            params: Value::Null,
        };
        let reason = screen_of_push(&request, "pc-a").unwrap_err();
        assert_eq!(reason, "アプリはこの依頼を受けられません");
        // A request to open a preview is the one that is taken: the screen gets the two values and the environment of the connection.
        let open = PushRequest {
            method: "preview.open".to_owned(),
            params: serde_json::json!({"path": "/w/app", "relative": "a.html"}),
        };
        assert_eq!(
            screen_of_push(&open, "pc-a").unwrap(),
            BTreeMap::from([
                ("environment".to_owned(), "pc-a".to_owned()),
                ("path".to_owned(), "/w/app".to_owned()),
                ("relative".to_owned(), "a.html".to_owned()),
            ])
        );
    }

    #[test]
    fn the_task_of_an_environment_can_be_spawned() {
        fn is_send<T: Send>(_: &T) {}
        let handler: PushHandler = Arc::new(|_| Box::pin(async { Ok(()) }));
        is_send(&keep_pushes(
            PathBuf::new(),
            "pc".to_owned(),
            "1.2.3".to_owned(),
            handler,
        ));
    }
}
