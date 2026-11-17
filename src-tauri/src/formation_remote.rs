//! The app's side of the server of A-37 (#891): it puts `tsunagiai-mcp` on the PC of a saved environment, starts it there, pins its key, and connects to it (`formation_server::Client`).
//! Everything on that PC is done through a terminal of that PC's Orca, the floating terminal (`FLOATING_WORKTREE`): the app types a command, reads the screen for the line the program prints (`formation_server::ready_line` or `error_line`) and closes the terminal.
//!
//! - `place` fetches the program of this app's version from the GitHub Release (the repository of the updater's endpoint), checks its signature against the Team ID of this app's own signature, puts it in `remote/` of that PC's config folder, starts it, and pins the key and the version of the server that the ready line carries.
//! - `connect` connects with the pinned key. When nobody answers it starts the server once and tries again, and when the server's version is not this app's it places the program again and tries again. An environment with no pinned key is refused: nothing was placed there.
//! - What is pinned is in `formation-remote.json`, for each environment by its name. The app's own key pair is in the keychain.
//!
//! A secret key is in no error text and no `Debug` output (the public keys that are pinned are not secret).

use std::{
    collections::BTreeMap,
    net::IpAddr,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    accounts,
    formation::{terminal_close_args, FLOATING_WORKTREE},
    formation_server::{
        self, canonical_32, error_line, parse_error_line, parse_ready_line, public_of, random_32,
        Client,
    },
    identity::IDENTIFIER,
    keychain, orca, orca_link,
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
const POLL: Duration = Duration::from_millis(500);
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

/// The app's secret key, made and stored in the keychain at the first use.
pub fn app_secret() -> Result<[u8; 32], String> {
    secret_with(
        &|| keychain::read(KEYCHAIN_SERVICE, KEYCHAIN_USER),
        &|value| keychain::write(KEYCHAIN_SERVICE, KEYCHAIN_USER, value),
    )
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

/// Reads the screen with `read` every `poll` until a line is there, up to `wait`. A read that fails is tried again until the time is out, and is then in the message.
fn wait_served(
    read: &mut dyn FnMut() -> Result<Vec<String>, String>,
    wait: Duration,
    poll: Duration,
) -> Result<Served, String> {
    let deadline = Instant::now() + wait;
    let mut last_error = None;
    loop {
        match read() {
            Ok(lines) => {
                if let Some(served) = served_in(&lines) {
                    return Ok(served);
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

/// Makes a floating terminal in the Orca of `environment` that runs `command`, waits up to `wait` for the line it prints, and closes the terminal, whatever came of it.
fn run_terminal(
    environment: &str,
    command: &str,
    wait: Duration,
    poll: Duration,
    write: &dyn Fn(&[String]) -> Result<Value, String>,
    read: &dyn Fn(&[String]) -> Result<Value, String>,
) -> Result<Served, String> {
    let made = write(&floating_create_args(environment, command))?;
    let handle = orca::created_of(&made)
        .handle
        .ok_or("Orca がターミナルの handle を答えませんでした")?;
    let screen = orca::screen_args(&handle, Some(environment));
    let served = wait_served(
        &mut || read(&screen).map(|result| orca::screen_lines_of(&result)),
        wait,
        poll,
    );
    // The line is read; a terminal that does not close is the Orca's to show.
    let _ = write(&terminal_close_args(&handle, environment));
    served
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
        Heard::Silent(reason) => Step::GiveUp(format!("サーバーにつなげません: {reason}")),
    }
}

/// One try: connects with the pinned key and asks the version.
async fn probe(host: &str, port: u16, secret: [u8; 32], key: &str) -> (Heard, Option<Client>) {
    let Some(server_public) = canonical_32(key) else {
        return (
            Heard::Silent("固定したサーバーの鍵が壊れています".into()),
            None,
        );
    };
    let mut client = match Client::connect(host, port, secret, server_public).await {
        Ok(client) => client,
        Err(e) => return (Heard::Silent(e), None),
    };
    match client.version().await {
        Ok(version) => (Heard::Version(version), Some(client)),
        Err(e) => (Heard::Silent(e), None),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Do {
    Place,
    Start,
}

/// What does a `Do` on the PC: blocking.
type Act = Arc<dyn Fn(Do) -> Result<(), String> + Send + Sync>;

async fn act_on_pc(act: &Act, what: Do) -> Result<(), String> {
    let act = act.clone();
    tokio::task::spawn_blocking(move || act(what))
        .await
        .map_err(|e| e.to_string())?
}

async fn connect_with(
    config: &Path,
    environment: &str,
    app_version: &str,
    host: &str,
    port: u16,
    secret: [u8; 32],
    act: &Act,
) -> Result<Client, String> {
    let (mut started, mut placed) = (false, false);
    loop {
        // Read again at each try: a start or a placement pins the key it found.
        let pin = pins(config)?
            .remove(environment)
            .ok_or_else(|| format!("環境「{environment}」にはサーバーを置いていません"))?;
        let (heard, client) = probe(host, port, secret, &pin.key).await;
        match decide(&heard, app_version, started, placed) {
            Step::Use => return client.ok_or_else(|| "サーバーにつなげません".to_owned()),
            Step::Start => {
                act_on_pc(act, Do::Start).await?;
                started = true;
            }
            Step::Place => {
                act_on_pc(act, Do::Place).await?;
                (placed, started) = (true, true);
            }
            Step::GiveUp(reason) => return Err(reason),
        }
    }
}

/// Connects to the server of `environment` with the pinned key, and checks that its version is `app_version`. When nobody answers, the server is started on the PC once and the connection is tried again; when its version is another, the program is placed again once (`place`) and the connection is tried again. An environment with no pinned key is refused with the reason and nothing is done on its PC.
pub async fn connect(
    config: &Path,
    environment: &str,
    app_version: &str,
) -> Result<Client, String> {
    if !pins(config)?.contains_key(environment) {
        return Err(format!("環境「{environment}」にはサーバーを置いていません"));
    }
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
        &act,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formation_server::{serve, Setup};
    use std::{
        cell::RefCell,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use tokio::net::TcpListener;

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
        let got = wait_served(
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
        );
        assert_eq!(
            got,
            Ok(Served::Ready {
                key: key_text(2),
                version: "1.2.3".into()
            })
        );
        assert_eq!(reads, 3);
        let silent = wait_served(
            &mut || Ok(lines(&["$ "])),
            Duration::from_millis(30),
            Duration::from_millis(5),
        );
        assert_eq!(silent, Err("時間内にサーバーが答えませんでした".to_owned()));
        let broken = wait_served(
            &mut || Err("Orca が応答しません".into()),
            Duration::from_millis(30),
            Duration::from_millis(5),
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
            Step::GiveUp("サーバーにつなげません: refused".into())
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
            connect_with(
                &self.config,
                "pc",
                "1.2.3",
                "127.0.0.1",
                self.port,
                self.secret,
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
            reason.contains("環境「pc」") && reason.contains("置いていません"),
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
        assert!(reason.contains("サーバーにつなげません"), "{reason}");
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
}
