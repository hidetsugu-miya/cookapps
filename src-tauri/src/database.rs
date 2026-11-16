//! The connection profiles of the database screen (D-1): where a connection goes and how it logs in, saved one by one.
//!
//! The profiles are in `database-profiles.json` in the app config directory, written through `write_atomic`.
//! The password of a profile is in the OS keychain (service `KEYRING_SERVICE`, user the profile's id), never in the file and never in the answer of a command:
//! the screen is told only whether one is saved (`DatabaseProfileView::password_saved`).
//! The id is made here at the first save and never changes, so that renaming a connection leaves its password where it is.
//! The connections that are open (D-3) are in `session::Sessions`: `database_connect` opens one (the script of the connection when it has one, then the MySQL session) and reads the databases, `database_tables` reads the tables of one, `database_records` reads a page of a table's records (D-4, `records.rs`), `database_structure` reads the columns of a table (D-5, `structure.rs`), `database_sql` runs the text of the SQL tab (D-6, `sql.rs`), `database_disconnect` closes it and ends its script (`script.rs`: the script that opens the way to the database, #718).
//! `cookapps-mcp` saves a connection (`save_without_password`) and tests a saved one (`test_saved`) through the same functions (D-8).
//! The checks of an input (`check`, `upsert`, `password_change`) are pure functions; the keychain is behind `PasswordStore` so that the flows can be tried without it.

pub mod mysql;
pub mod records;
pub mod script;
pub mod session;
pub mod sql;
pub mod structure;

use std::{path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    accounts::write_atomic,
    auth::{config_dir, delete_entry},
};

const FILE: &str = "database-profiles.json";
const KEYRING_SERVICE: &str = "jp.mysis.cookapps.database";
const NAME_MAX: usize = 100;
const PORT_MAX: u32 = 65535;
/// A save reads the file, changes it and writes it again by a temporary name beside it: two at once would lose a change.
static SAVING: Mutex<()> = Mutex::new(());

/// One connection: the fields saved in the file, and the ones the screen sends. The password is not here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProfile {
    /// Empty when the screen sends a new connection; made at the first save.
    pub id: String,
    pub name: String,
    pub username: String,
    /// The body of the script that opens the way to the database (D-1): it runs before MySQL is logged in to, gets the port of the connection as `COOKAPPS_PORT` and listens there.
    /// Empty when the connection goes straight to the host and the port. Old files have none (`default`).
    #[serde(default)]
    pub script: String,
    /// The host MySQL is logged in to, with a script or without one (a script opens the way to it).
    pub db_host: String,
    /// A number wider than a port, so that a value out of range reaches `check` and is refused in Japanese.
    /// A file saved while a connection with a script needed none (#719) may hold 0, which `check_address` refuses until the owner puts a port in.
    pub db_port: u32,
}

/// A profile as the screen gets it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProfileView {
    #[serde(flatten)]
    #[cfg_attr(test, ts(flatten))]
    pub profile: DatabaseProfile,
    pub password_saved: bool,
}

#[derive(Serialize, Deserialize)]
struct ProfilesFile {
    profiles: Vec<DatabaseProfile>,
}

/// What a save does with the keychain.
#[derive(Debug, PartialEq)]
enum PasswordChange {
    /// The stored password stays as it is (an edit that left the field empty, or a new connection with none).
    Keep,
    Set(String),
}

/// An empty password is not a new password: the field of an edit is left empty to keep the saved one. The text is not trimmed, because a password may begin or end with a space.
fn password_change(password: Option<&str>) -> PasswordChange {
    match password {
        Some(p) if !p.is_empty() => PasswordChange::Set(p.to_owned()),
        _ => PasswordChange::Keep,
    }
}

fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

/// The port of `host` and `port` (the host trimmed already), or the first reason, in Japanese.
/// Every connection needs both, with a script or without one: `check` calls it, and so does the opening of a connection, which reads a profile that was saved with none (#745).
fn check_address(host: &str, port: u32) -> Result<u16, String> {
    if host.is_empty() {
        return Err("DB のホストを入力してください".to_owned());
    }
    if host.chars().any(char::is_whitespace) {
        return Err("DB のホストに空白は使えません".to_owned());
    }
    u16::try_from(port)
        .ok()
        .filter(|p| *p >= 1)
        .ok_or_else(|| format!("ポートは 1 から {PORT_MAX} の間で入力してください"))
}

/// `profile` trimmed and checked against the other profiles of `profiles` (the ones with another id), or the first reason, in Japanese.
/// The script is trimmed and its line breaks are `\n`; a control character in it is refused, but line feeds and tabs are not.
/// The host and the port are needed with a script or without one (D-1), and are checked by `check_address`.
fn check(
    profile: DatabaseProfile,
    profiles: &[DatabaseProfile],
) -> Result<DatabaseProfile, String> {
    let trim = |s: &str| s.trim().to_owned();
    let p = DatabaseProfile {
        name: trim(&profile.name),
        username: trim(&profile.username),
        script: trim(&profile.script).replace("\r\n", "\n"),
        db_host: trim(&profile.db_host),
        ..profile
    };
    if p.name.is_empty() {
        return Err("接続名を入力してください".to_owned());
    }
    if p.name.chars().count() > NAME_MAX {
        return Err(format!("接続名は {NAME_MAX} 文字までです"));
    }
    if profiles.iter().any(|o| o.id != p.id && o.name == p.name) {
        return Err(format!("同じ名前の接続があります: {}", p.name));
    }
    if p.username.is_empty() {
        return Err("ユーザー名を入力してください".to_owned());
    }
    check_address(&p.db_host, p.db_port)?;
    if [&p.name, &p.username, &p.db_host]
        .into_iter()
        .any(|s| has_control(s))
    {
        return Err("制御文字は使えません".to_owned());
    }
    if p.script
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err("スクリプトに使えない制御文字があります".to_owned());
    }
    Ok(p)
}

/// `profiles` with `input` saved, and the profile as saved. An empty id is a new connection and gets `fresh_id` (added at the end);
/// any other id must be one of `profiles` (so that a connection deleted meanwhile does not come back) and is replaced where it stands.
fn upsert(
    mut profiles: Vec<DatabaseProfile>,
    input: DatabaseProfile,
    fresh_id: &str,
) -> Result<(Vec<DatabaseProfile>, DatabaseProfile), String> {
    let mut saved = check(input, &profiles)?;
    if saved.id.is_empty() {
        saved.id = fresh_id.to_owned();
        profiles.push(saved.clone());
    } else {
        let at = profiles
            .iter()
            .position(|p| p.id == saved.id)
            .ok_or("接続が見つかりません。一覧を読み直してください")?;
        profiles[at] = saved.clone();
    }
    Ok((profiles, saved))
}

fn parse(text: &str) -> Result<Vec<DatabaseProfile>, serde_json::Error> {
    serde_json::from_str::<ProfilesFile>(text).map(|f| f.profiles)
}

fn render(profiles: &[DatabaseProfile]) -> Result<String, String> {
    serde_json::to_string_pretty(&ProfilesFile {
        profiles: profiles.to_vec(),
    })
    .map_err(|e| e.to_string())
}

/// The saved profiles; none when the file does not exist yet. A file that cannot be read is an error and is not replaced by an empty list, so a save never wipes it.
fn load(dir: &Path) -> Result<Vec<DatabaseProfile>, String> {
    let path = dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => parse(&text).map_err(|e| format!("{} の形式が不正です: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

fn store(dir: &Path, profiles: &[DatabaseProfile]) -> Result<(), String> {
    write_atomic(dir, FILE, &render(profiles)?)
}

/// 16 random bytes in hex.
fn new_id() -> Result<String, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "乱数を作れません".to_owned())?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}

/// Where the passwords are kept, by the id of a profile.
pub trait PasswordStore {
    fn exists(&self, id: &str) -> Result<bool, String>;
    /// The saved password; none when there is none.
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, password: &str) -> Result<(), String>;
    /// A missing password counts as deleted.
    fn delete(&self, id: &str) -> Result<(), String>;
}

/// The OS keychain.
pub struct Keychain;

fn password_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}

impl PasswordStore for Keychain {
    fn exists(&self, id: &str) -> Result<bool, String> {
        match password_entry(id)?.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(format!("資格情報の読み取りに失敗: {e}")),
        }
    }

    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match password_entry(id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("資格情報の読み取りに失敗: {e}")),
        }
    }

    fn set(&self, id: &str, password: &str) -> Result<(), String> {
        password_entry(id)?
            .set_password(password)
            .map_err(|e| format!("資格情報の保存に失敗: {e}"))
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        delete_entry(&password_entry(id)?)
    }
}

fn view(
    passwords: &impl PasswordStore,
    profile: DatabaseProfile,
) -> Result<DatabaseProfileView, String> {
    Ok(DatabaseProfileView {
        password_saved: passwords.exists(&profile.id)?,
        profile,
    })
}

/// The saved profiles, in the order they were made.
pub fn list(
    dir: &Path,
    passwords: &impl PasswordStore,
) -> Result<Vec<DatabaseProfileView>, String> {
    load(dir)?.into_iter().map(|p| view(passwords, p)).collect()
}

/// Saves a connection (new with an empty id, else the one of that id) and, when `password` is not empty, its password.
/// The file is written first: a keychain that refuses then leaves a connection to edit, not a password that belongs to no connection.
pub fn save(
    dir: &Path,
    passwords: &impl PasswordStore,
    profile: DatabaseProfile,
    password: Option<String>,
) -> Result<DatabaseProfileView, String> {
    let fresh_id = if profile.id.is_empty() {
        new_id()?
    } else {
        String::new()
    };
    let (profiles, saved) = upsert(load(dir)?, profile, &fresh_id)?;
    store(dir, &profiles)?;
    if let PasswordChange::Set(password) = password_change(password.as_deref()) {
        passwords
            .set(&saved.id, &password)
            .map_err(|e| format!("接続は保存しましたが、パスワードを保存できません: {e}"))?;
    }
    view(passwords, saved)
}

/// `save` with no password and with the lock of the app's own save (D-8: `cookapps-mcp` saves a connection and never sets its password). The lock covers this process only; the file is replaced whole through `write_atomic`, so the other process never reads a half written file.
/// The saved password is kept only while the connection logs in as the saved one does (`same_login`); an edit of the user, the script, the host or the port deletes it first,
/// so that a test of the connection never sends it to another place than the one it was saved for (D-2). The input is checked before the deletion, so a refused save deletes nothing.
pub fn save_without_password(
    dir: &Path,
    passwords: &impl PasswordStore,
    profile: DatabaseProfile,
) -> Result<DatabaseProfileView, String> {
    let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
    let profiles = load(dir)?;
    let checked = check(profile.clone(), &profiles)?;
    if let Some(saved) = profiles
        .iter()
        .find(|p| !checked.id.is_empty() && p.id == checked.id)
    {
        if !same_login(saved, &checked) {
            passwords.delete(&checked.id)?;
        }
    }
    save(dir, passwords, profile, None)
}

/// Deletes a connection and its password. The password goes first: a failure then leaves the connection, and no password is left that no connection shows.
/// An id that is not saved is already deleted.
pub fn delete(dir: &Path, passwords: &impl PasswordStore, id: &str) -> Result<(), String> {
    let mut profiles = load(dir)?;
    let Some(at) = profiles.iter().position(|p| p.id == id) else {
        return Ok(());
    };
    passwords.delete(id)?;
    profiles.remove(at);
    store(dir, &profiles)
}

/// Whether `typed` logs in as the same user at the same place as `saved`: the saved password is the one for that login and for no other.
/// The place of a connection is its script, its host and its port, with a script or without one: any of them changed is another place.
fn same_login(saved: &DatabaseProfile, typed: &DatabaseProfile) -> bool {
    saved.username == typed.username
        && saved.script == typed.script
        && saved.db_host == typed.db_host
        && saved.db_port == typed.db_port
}

/// The password a test of `profile` (already checked) logs in with: the one typed, else the one saved for its id, but only when the profile still logs in as the saved one does (`same_login`),
/// so that the saved password is never sent to another place than the one it was saved for. A new connection has no saved password, and an empty password is a login with none.
fn test_password(
    passwords: &impl PasswordStore,
    saved: &[DatabaseProfile],
    profile: &DatabaseProfile,
    typed: Option<&str>,
) -> Result<String, String> {
    if let PasswordChange::Set(password) = password_change(typed) {
        return Ok(password);
    }
    let Some(stored) = saved
        .iter()
        .find(|p| !profile.id.is_empty() && p.id == profile.id)
    else {
        return Ok(String::new());
    };
    if !same_login(stored, profile) {
        return Err("接続先やユーザーを変えたときは、パスワードを入力してください".to_owned());
    }
    Ok(passwords.get(&profile.id)?.unwrap_or_default())
}

/// Starts the script of `profile` when it has one (D-1) and answers where MySQL is reached, and the id of the script to end (none when there is no script).
/// The host and the port are the connection's own, and are checked here too: a profile saved with none (#719) is refused until they are put in.
/// The test of a connection (D-2) and the opening of one (D-3) both go through this.
async fn open_endpoint(
    scripts: &script::Scripts,
    profile: &DatabaseProfile,
) -> Result<(mysql::Endpoint, Option<u64>), String> {
    let port = check_address(&profile.db_host, profile.db_port)?;
    let script = if profile.script.is_empty() {
        None
    } else {
        Some(
            scripts
                .open(&profile.db_host, port, &profile.script)
                .await?,
        )
    };
    let endpoint = mysql::Endpoint {
        host: profile.db_host.clone(),
        port,
        scripted: script.is_some(),
    };
    Ok((endpoint, script))
}

/// Tests `profile` as typed (not as saved): starts its script when it has one, logs in, reads `SELECT VERSION()` and ends the script.
/// `profile` goes through the same checks as a save, apart from the name's being another connection's.
pub async fn test_connection(
    scripts: &script::Scripts,
    profile: DatabaseProfile,
    password: &str,
) -> Result<String, String> {
    let profile = check(profile, &[])?;
    let (endpoint, script) = open_endpoint(scripts, &profile).await?;
    let tested = mysql::server_version(&endpoint, &profile.username, password).await;
    if let Some(id) = script {
        scripts.close(id).await;
    }
    tested
}

/// Tests the connection of `id` as saved, with the password saved for it (D-8), through `test_connection`, the function of the test of D-2.
pub async fn test_saved(
    dir: &Path,
    passwords: &impl PasswordStore,
    scripts: &script::Scripts,
    id: &str,
) -> Result<String, String> {
    let (profile, password) = saved_login(dir, passwords, id)?;
    test_connection(scripts, profile, &password).await
}

/// The saved connection of `id` and the password saved for it (none is an empty password, as in a test), or the reason it cannot be opened.
fn saved_login(
    dir: &Path,
    passwords: &impl PasswordStore,
    id: &str,
) -> Result<(DatabaseProfile, String), String> {
    let profile = load(dir)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("接続が見つかりません。一覧を読み直してください")?;
    let password = passwords.get(id)?.unwrap_or_default();
    Ok((profile, password))
}

/// Whether the login read again (`now`) is the one a session was opened with: a connection that was edited or deleted while it opened is not (the answer is then what the screen is told).
/// A login that could not be read again (the keychain, the file) is told as its own error, never as a change.
fn login_unchanged(
    opened: &(DatabaseProfile, String),
    now: &Result<(DatabaseProfile, String), String>,
) -> Result<(), String> {
    match now {
        Err(e) => Err(e.clone()),
        Ok(now) if now == opened => Ok(()),
        Ok(_) => Err("接続が変更または削除されました。もう一度開いてください".to_owned()),
    }
}

/// Starts the script and opens the read only session of `profile` and keeps it in `sessions`. A script started for a session that cannot be logged in to is ended again.
async fn open_session(
    sessions: &session::Sessions,
    scripts: &script::Scripts,
    profile: &DatabaseProfile,
    password: &str,
) -> Result<(), String> {
    let (endpoint, script) = open_endpoint(scripts, profile).await?;
    let connection = match mysql::connect(&endpoint, &profile.username, password).await {
        Ok(connection) => connection,
        Err(e) => {
            if let Some(id) = script {
                scripts.close(id).await;
            }
            return Err(e);
        }
    };
    sessions.add(scripts, &profile.id, script, connection).await;
    Ok(())
}

/// The saved connections, each with whether its password is saved.
#[tauri::command]
pub async fn database_profiles(app: AppHandle) -> Result<Vec<DatabaseProfileView>, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || list(&dir, &Keychain))
        .await
        .map_err(|e| e.to_string())?
}

/// Saves a connection and answers it as saved. An empty `password` leaves the saved password as it is.
/// An edited connection that is open is closed (D-3): its session was made with what is saved no more.
#[tauri::command]
pub async fn database_profile_save(
    app: AppHandle,
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
    profile: DatabaseProfile,
    password: Option<String>,
) -> Result<DatabaseProfileView, String> {
    let dir = config_dir(&app)?;
    let id = profile.id.clone();
    let saved = tokio::task::spawn_blocking(move || {
        let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
        save(&dir, &Keychain, profile, password)
    })
    .await
    .map_err(|e| e.to_string())??;
    if !id.is_empty() {
        sessions.disconnect(&scripts, &id).await;
    }
    Ok(saved)
}

/// Tests a connection as typed in the popup and answers the version of the server. An empty `password` is the saved one of `profile.id`.
#[tauri::command]
pub async fn database_test(
    app: AppHandle,
    scripts: tauri::State<'_, script::Scripts>,
    profile: DatabaseProfile,
    password: Option<String>,
) -> Result<String, String> {
    let dir = config_dir(&app)?;
    let profile = check(profile, &[])?;
    let tested = profile.clone();
    let password = tokio::task::spawn_blocking(move || {
        let saved = if profile.id.is_empty() {
            Vec::new()
        } else {
            load(&dir)?
        };
        test_password(&Keychain, &saved, &profile, password.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    test_connection(&scripts, tested, &password).await
}

/// Deletes a connection and its password. A connection that is open is closed first (D-3).
#[tauri::command]
pub async fn database_profile_delete(
    app: AppHandle,
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
    id: String,
) -> Result<(), String> {
    let dir = config_dir(&app)?;
    sessions.disconnect(&scripts, &id).await;
    let again = id.clone();
    tokio::task::spawn_blocking(move || {
        let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
        delete(&dir, &Keychain, &id)
    })
    .await
    .map_err(|e| e.to_string())??;
    // A connection that began to open before the delete may have put its session in meanwhile; it checks the file when it has opened, and this closes what it put in before that.
    sessions.disconnect(&scripts, &again).await;
    Ok(())
}

/// Opens the connection of `id` when it is not open (the script, then the read only session with the saved password) and answers the names of its databases.
/// A connection whose databases cannot be read is closed again.
#[tauri::command]
pub async fn database_connect(
    app: AppHandle,
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
    id: String,
) -> Result<Vec<String>, String> {
    if !sessions.has(&scripts, &id).await {
        let dir = config_dir(&app)?;
        let wanted = id.clone();
        let (profile, password) =
            tokio::task::spawn_blocking(move || saved_login(&dir, &Keychain, &wanted))
                .await
                .map_err(|e| e.to_string())??;
        open_session(&sessions, &scripts, &profile, &password).await?;
        // A save or a delete that came while it opened found no session to close: look again, and close what was opened with a login that is gone.
        let dir = config_dir(&app)?;
        let wanted = id.clone();
        let now = tokio::task::spawn_blocking(move || {
            let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
            saved_login(&dir, &Keychain, &wanted)
        })
        .await
        .map_err(|e| e.to_string())?;
        if let Err(why) = login_unchanged(&(profile, password), &now) {
            sessions.disconnect(&scripts, &id).await;
            return Err(why);
        }
    }
    match sessions.databases(&scripts, &id).await {
        Ok(databases) => Ok(databases),
        Err(e) => {
            sessions.disconnect(&scripts, &id).await;
            Err(e)
        }
    }
}

/// The tables of `database` on the open connection `id`, with the estimated rows, the size and the engine of each.
#[tauri::command]
pub async fn database_tables(
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
    id: String,
    database: String,
) -> Result<Vec<session::DatabaseTable>, String> {
    sessions.tables(&scripts, &id, &database).await
}

/// One page of the records of `table` in `database` on the open connection `id` (D-4): `page` counts from 0, and each value is already text.
/// The estimated rows are read with the page 0, or when `estimate` is none; `estimate` is the one the screen holds from it, which a later page answers again.
/// `typed` is the text of the page field: when it is given, it names the page (`records::page_of_input`) and `page` is not used.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn database_records(
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
    id: String,
    database: String,
    table: String,
    page: u32,
    estimate: Option<u64>,
    typed: Option<String>,
) -> Result<records::DatabaseRecords, String> {
    let page = typed.as_deref().map_or(page, records::page_of_input);
    sessions
        .records(&scripts, &id, &database, &table, page, estimate)
        .await
}

/// The columns of `table` in `database` on the open connection `id` (D-5), with the number of columns, the engine and the character set of the table.
#[tauri::command]
pub async fn database_structure(
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
    id: String,
    database: String,
    table: String,
) -> Result<structure::DatabaseStructure, String> {
    sessions.structure(&scripts, &id, &database, &table).await
}

/// The text `sql` run as one statement in `database` on the open connection `id` (D-6): at most 1,000 rows, each value already text, and the line with the rows and the time.
#[tauri::command]
pub async fn database_sql(
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
    id: String,
    database: String,
    sql: String,
) -> Result<sql::DatabaseSqlResult, String> {
    sessions.sql(&scripts, &id, &database, &sql).await
}

/// Closes the connection of `id` and ends its script. A connection that is not open is closed already.
#[tauri::command]
pub async fn database_disconnect(
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
    id: String,
) -> Result<(), String> {
    sessions.disconnect(&scripts, &id).await;
    Ok(())
}

/// The ids of the connections that are open now.
#[tauri::command]
pub async fn database_connections(
    sessions: tauri::State<'_, session::Sessions>,
    scripts: tauri::State<'_, script::Scripts>,
) -> Result<Vec<String>, String> {
    Ok(sessions.ids(&scripts).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, path::PathBuf};

    /// The passwords in memory, so that no test reaches the keychain.
    #[derive(Default)]
    struct Memory {
        passwords: Mutex<HashMap<String, String>>,
        refuse_set: bool,
    }

    impl Memory {
        fn get(&self, id: &str) -> Option<String> {
            self.passwords.lock().unwrap().get(id).cloned()
        }
    }

    impl PasswordStore for Memory {
        fn exists(&self, id: &str) -> Result<bool, String> {
            Ok(self.get(id).is_some())
        }

        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.get(id))
        }

        fn set(&self, id: &str, password: &str) -> Result<(), String> {
            if self.refuse_set {
                return Err("keychain is locked".to_owned());
            }
            self.passwords
                .lock()
                .unwrap()
                .insert(id.to_owned(), password.to_owned());
            Ok(())
        }

        fn delete(&self, id: &str) -> Result<(), String> {
            self.passwords.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-database-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn direct(name: &str) -> DatabaseProfile {
        DatabaseProfile {
            id: String::new(),
            name: name.to_owned(),
            username: "reader".to_owned(),
            script: String::new(),
            db_host: "127.0.0.1".to_owned(),
            db_port: 3306,
        }
    }

    fn scripted(name: &str) -> DatabaseProfile {
        DatabaseProfile {
            script: "#!/bin/sh\nexec forward-port \"$COOKAPPS_PORT\"".to_owned(),
            ..direct(name)
        }
    }

    fn reason(profile: DatabaseProfile, profiles: &[DatabaseProfile]) -> String {
        check(profile, profiles).unwrap_err()
    }

    #[test]
    fn a_complete_connection_passes_and_is_trimmed() {
        let input = DatabaseProfile {
            name: "  開発  ".to_owned(),
            username: " reader ".to_owned(),
            db_host: " 127.0.0.1\n".to_owned(),
            ..direct("")
        };
        let checked = check(input, &[]).unwrap();
        assert_eq!(checked.name, "開発");
        assert_eq!(checked.username, "reader");
        assert_eq!(checked.db_host, "127.0.0.1");
        assert_eq!(
            check(scripted("本番"), &[]).unwrap().script,
            "#!/bin/sh\nexec forward-port \"$COOKAPPS_PORT\""
        );
    }

    #[test]
    fn an_empty_or_blank_name_is_refused() {
        for name in ["", "   ", "\t\n"] {
            assert_eq!(reason(direct(name), &[]), "接続名を入力してください");
        }
    }

    #[test]
    fn a_name_of_100_characters_passes_and_101_is_refused() {
        assert!(check(direct(&"あ".repeat(100)), &[]).is_ok());
        assert!(reason(direct(&"あ".repeat(101)), &[]).contains("100"));
    }

    #[test]
    fn another_connections_name_is_refused_but_the_connections_own_is_not() {
        let saved = vec![
            DatabaseProfile {
                id: "a".to_owned(),
                ..direct("開発")
            },
            DatabaseProfile {
                id: "b".to_owned(),
                ..direct("本番")
            },
        ];
        let new = direct(" 開発 ");
        assert_eq!(reason(new, &saved), "同じ名前の接続があります: 開発");
        let renamed_to_other = DatabaseProfile {
            id: "b".to_owned(),
            ..direct("開発")
        };
        assert!(check(renamed_to_other, &saved).is_err());
        let own = DatabaseProfile {
            id: "a".to_owned(),
            ..direct("開発")
        };
        assert!(check(own, &saved).is_ok());
        assert!(check(direct("開発2"), &saved).is_ok());
    }

    #[test]
    fn the_username_and_the_host_are_needed_and_the_host_has_no_space() {
        let no_user = DatabaseProfile {
            username: " ".to_owned(),
            ..direct("a")
        };
        assert_eq!(reason(no_user, &[]), "ユーザー名を入力してください");
        let no_host = DatabaseProfile {
            db_host: String::new(),
            ..direct("a")
        };
        assert_eq!(reason(no_host, &[]), "DB のホストを入力してください");
        let spaced = DatabaseProfile {
            db_host: "db host".to_owned(),
            ..direct("a")
        };
        assert_eq!(reason(spaced, &[]), "DB のホストに空白は使えません");
    }

    #[test]
    fn the_port_is_1_to_65535() {
        for port in [1, 3306, 65535] {
            let p = DatabaseProfile {
                db_port: port,
                ..direct("a")
            };
            assert!(check(p, &[]).is_ok(), "{port}");
        }
        for port in [0, 65536, u32::MAX] {
            let p = DatabaseProfile {
                db_port: port,
                ..direct("a")
            };
            assert_eq!(
                reason(p, &[]),
                "ポートは 1 から 65535 の間で入力してください",
                "{port}"
            );
        }
    }

    #[test]
    fn a_connection_with_a_script_needs_a_host_and_a_port_as_one_with_none_does_and_keeps_them() {
        let checked = check(scripted("a"), &[]).unwrap();
        assert_eq!(
            (checked.db_host.as_str(), checked.db_port),
            ("127.0.0.1", 3306)
        );
        for with_script in [true, false] {
            let base = if with_script {
                scripted("a")
            } else {
                direct("a")
            };
            let no_host = DatabaseProfile {
                db_host: " ".to_owned(),
                ..base.clone()
            };
            assert_eq!(reason(no_host, &[]), "DB のホストを入力してください");
            let spaced = DatabaseProfile {
                db_host: "db host".to_owned(),
                ..base.clone()
            };
            assert_eq!(reason(spaced, &[]), "DB のホストに空白は使えません");
            let no_port = DatabaseProfile { db_port: 0, ..base };
            assert_eq!(
                reason(no_port, &[]),
                "ポートは 1 から 65535 の間で入力してください"
            );
        }
        // A blank script is none, and the host and the port are the same as before.
        let blank = DatabaseProfile {
            script: " \n".to_owned(),
            ..scripted("a")
        };
        let checked = check(blank, &[]).unwrap();
        assert_eq!(
            (
                checked.script.as_str(),
                checked.db_host.as_str(),
                checked.db_port
            ),
            ("", "127.0.0.1", 3306)
        );
    }

    #[test]
    fn the_save_of_the_mcp_server_needs_the_host_and_the_port_with_a_script_too() {
        let dir = temp_dir("mcp-script");
        let passwords = Memory::default();
        let without = DatabaseProfile {
            db_host: String::new(),
            db_port: 0,
            ..scripted("a")
        };
        assert_eq!(
            save_without_password(&dir, &passwords, without).unwrap_err(),
            "DB のホストを入力してください"
        );
        assert_eq!(list(&dir, &passwords).unwrap(), Vec::new());
        let input = DatabaseProfile {
            db_host: "localhost".to_owned(),
            db_port: 3307,
            ..scripted("a")
        };
        let saved = save_without_password(&dir, &passwords, input).unwrap();
        assert_eq!(
            (saved.profile.db_host.as_str(), saved.profile.db_port),
            ("localhost", 3307)
        );
        assert_eq!(list(&dir, &passwords).unwrap(), vec![saved]);
    }

    #[test]
    fn a_connection_with_a_script_is_saved_with_its_host_and_its_port() {
        let (profiles, saved) = upsert(
            Vec::new(),
            DatabaseProfile {
                db_host: "localhost".to_owned(),
                db_port: 3307,
                ..scripted("a")
            },
            "id-a",
        )
        .unwrap();
        assert_eq!((saved.db_host.as_str(), saved.db_port), ("localhost", 3307));
        assert_eq!(profiles, vec![saved]);
    }

    #[test]
    fn a_script_is_trimmed_and_its_line_breaks_are_line_feeds_and_a_blank_one_is_none() {
        let p = DatabaseProfile {
            script: "\n  #!/bin/bash\r\nexec forward-port\r\n\t\n ".to_owned(),
            ..direct("a")
        };
        assert_eq!(
            check(p, &[]).unwrap().script,
            "#!/bin/bash\nexec forward-port"
        );
        for blank in ["", "  ", "\n\t\r\n"] {
            let p = DatabaseProfile {
                script: blank.to_owned(),
                ..scripted("a")
            };
            assert_eq!(check(p, &[]).unwrap().script, "", "{blank:?}");
        }
    }

    #[test]
    fn a_script_may_have_line_feeds_and_tabs_but_no_other_control_character() {
        let p = DatabaseProfile {
            script: "a\n\tb".to_owned(),
            ..direct("a")
        };
        assert!(check(p, &[]).is_ok());
        for bad in ["a\u{0}b", "a\u{7}b", "a\rb", "a\u{1b}[0m"] {
            let p = DatabaseProfile {
                script: bad.to_owned(),
                ..direct("a")
            };
            assert_eq!(
                reason(p, &[]),
                "スクリプトに使えない制御文字があります",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_file_of_the_old_form_has_no_script_and_its_ssm_fields_are_dropped() {
        let text = r#"{"profiles":[{"id":"x","name":"a","username":"u","useSsm":true,"awsProfile":"dev","region":"r","bastionName":"b","dbHost":"h","dbPort":3306}]}"#;
        let profiles = parse(text).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].script, "");
        assert!(!render(&profiles).unwrap().contains("Ssm"));
    }

    #[test]
    fn a_file_saved_with_a_script_and_no_host_and_no_port_is_read() {
        let text = r#"{"profiles":[{"id":"x","name":"a","username":"u","script":"exec forward","dbHost":"","dbPort":0}]}"#;
        let profiles = parse(text).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(
            (
                profiles[0].script.as_str(),
                profiles[0].db_host.as_str(),
                profiles[0].db_port
            ),
            ("exec forward", "", 0)
        );
        // It is not saved again as it is: the next save is checked, and needs a host and a port.
        assert_eq!(
            reason(profiles[0].clone(), &[]),
            "DB のホストを入力してください"
        );
    }

    #[test]
    fn a_control_character_inside_a_field_is_refused() {
        let p = DatabaseProfile {
            username: "re\u{0}ader".to_owned(),
            ..direct("a")
        };
        assert_eq!(reason(p, &[]), "制御文字は使えません");
        let p = DatabaseProfile {
            db_host: "h\u{7}".to_owned(),
            ..direct("a")
        };
        assert_eq!(reason(p, &[]), "制御文字は使えません");
    }

    #[test]
    fn an_empty_password_keeps_the_saved_one_and_any_other_replaces_it() {
        assert_eq!(password_change(None), PasswordChange::Keep);
        assert_eq!(password_change(Some("")), PasswordChange::Keep);
        assert_eq!(
            password_change(Some(" p ")),
            PasswordChange::Set(" p ".to_owned())
        );
    }

    #[test]
    fn upsert_adds_a_new_connection_with_the_fresh_id_and_replaces_a_saved_one_in_place() {
        let (profiles, first) = upsert(Vec::new(), direct("a"), "id-a").unwrap();
        assert_eq!(first.id, "id-a");
        let (profiles, _) = upsert(profiles, direct("b"), "id-b").unwrap();
        let edited = DatabaseProfile {
            id: "id-a".to_owned(),
            db_port: 3307,
            ..direct("a2")
        };
        let (profiles, saved) = upsert(profiles, edited, "unused").unwrap();
        assert_eq!(saved.id, "id-a");
        let names: Vec<_> = profiles
            .iter()
            .map(|p| (&p.id[..], p.name.as_str()))
            .collect();
        assert_eq!(names, [("id-a", "a2"), ("id-b", "b")]);
        assert_eq!(profiles[0].db_port, 3307);
    }

    #[test]
    fn upsert_refuses_an_id_that_is_not_saved() {
        let (profiles, _) = upsert(Vec::new(), direct("a"), "id-a").unwrap();
        let gone = DatabaseProfile {
            id: "id-gone".to_owned(),
            ..direct("b")
        };
        assert!(upsert(profiles.clone(), gone, "unused")
            .unwrap_err()
            .contains("見つかりません"));
        assert_eq!(profiles.len(), 1);
    }

    #[test]
    fn render_and_parse_give_the_same_profiles_in_camel_case() {
        let profiles = vec![
            DatabaseProfile {
                id: "x".to_owned(),
                ..scripted("a")
            },
            DatabaseProfile {
                id: "y".to_owned(),
                ..direct("b")
            },
        ];
        let text = render(&profiles).unwrap();
        assert!(text.contains("\"dbPort\": 3306") && text.contains("\"script\": "));
        assert_eq!(parse(&text).unwrap(), profiles);
    }

    #[test]
    fn a_missing_file_is_no_profile_and_a_broken_one_is_an_error_that_a_save_does_not_replace() {
        let dir = temp_dir("load");
        assert_eq!(load(&dir).unwrap(), Vec::new());
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        let err = load(&dir).unwrap_err();
        assert!(
            err.contains(FILE) && err.contains("形式が不正です"),
            "{err}"
        );
        let passwords = Memory::default();
        assert!(save(&dir, &passwords, direct("a"), None).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join(FILE)).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn a_saved_connection_is_listed_after_a_reload_and_its_password_is_not_in_the_file() {
        let dir = temp_dir("save");
        let passwords = Memory::default();
        let saved = save(
            &dir,
            &passwords,
            scripted("開発"),
            Some("s3cret-value".to_owned()),
        )
        .unwrap();
        assert_eq!(saved.profile.id.len(), 32);
        assert!(saved.password_saved);
        assert_eq!(
            passwords.get(&saved.profile.id).as_deref(),
            Some("s3cret-value")
        );
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(
            !text.contains("s3cret-value") && !text.contains("assword"),
            "{text}"
        );
        assert!(!dir.join(format!("{FILE}.tmp")).exists());
        assert_eq!(list(&dir, &passwords).unwrap(), vec![saved]);
    }

    #[test]
    fn a_new_connection_without_a_password_is_listed_as_having_none() {
        let dir = temp_dir("nopassword");
        let passwords = Memory::default();
        let with = save(&dir, &passwords, direct("a"), Some("p".to_owned())).unwrap();
        let without = save(&dir, &passwords, direct("b"), Some(String::new())).unwrap();
        assert_ne!(with.profile.id, without.profile.id);
        let listed: Vec<_> = list(&dir, &passwords)
            .unwrap()
            .into_iter()
            .map(|v| (v.profile.name, v.password_saved))
            .collect();
        assert_eq!(listed, [("a".to_owned(), true), ("b".to_owned(), false)]);
    }

    #[test]
    fn an_edit_with_an_empty_password_leaves_the_keychain_and_a_new_password_replaces_it() {
        let dir = temp_dir("edit");
        let passwords = Memory::default();
        let first = save(&dir, &passwords, direct("a"), Some("old".to_owned())).unwrap();
        let id = first.profile.id.clone();
        let edit = |name: &str| DatabaseProfile {
            id: id.clone(),
            db_port: 3307,
            ..direct(name)
        };
        for kept in [None, Some(String::new())] {
            let saved = save(&dir, &passwords, edit("a2"), kept).unwrap();
            assert_eq!(saved.profile.id, id);
            assert!(saved.password_saved);
            assert_eq!(passwords.get(&id).as_deref(), Some("old"));
        }
        assert_eq!(list(&dir, &passwords).unwrap()[0].profile.db_port, 3307);
        save(&dir, &passwords, edit("a2"), Some("new".to_owned())).unwrap();
        assert_eq!(passwords.get(&id).as_deref(), Some("new"));
        assert_eq!(list(&dir, &passwords).unwrap().len(), 1);
    }

    #[test]
    fn an_invalid_save_changes_neither_the_file_nor_the_keychain() {
        let dir = temp_dir("invalid");
        let passwords = Memory::default();
        save(&dir, &passwords, direct("a"), Some("p".to_owned())).unwrap();
        let before = std::fs::read_to_string(dir.join(FILE)).unwrap();
        for bad in [
            direct(" "),
            direct("a"),
            DatabaseProfile {
                db_port: 0,
                ..direct("b")
            },
            DatabaseProfile {
                script: "a\u{0}".to_owned(),
                ..direct("c")
            },
            DatabaseProfile {
                id: "gone".to_owned(),
                ..direct("d")
            },
        ] {
            assert!(save(&dir, &passwords, bad, Some("q".to_owned())).is_err());
        }
        assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), before);
        assert_eq!(passwords.passwords.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_keychain_that_refuses_leaves_the_saved_connection_and_says_so() {
        let dir = temp_dir("refuse");
        let passwords = Memory {
            refuse_set: true,
            ..Memory::default()
        };
        let err = save(&dir, &passwords, direct("a"), Some("p".to_owned())).unwrap_err();
        assert!(
            err.contains("接続は保存しましたが") && err.contains("keychain is locked"),
            "{err}"
        );
        let listed = list(&dir, &passwords).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].password_saved);
    }

    #[test]
    fn delete_removes_the_connection_and_its_password_and_leaves_the_others() {
        let dir = temp_dir("delete");
        let passwords = Memory::default();
        let a = save(&dir, &passwords, direct("a"), Some("pa".to_owned())).unwrap();
        let b = save(&dir, &passwords, direct("b"), Some("pb".to_owned())).unwrap();
        delete(&dir, &passwords, &a.profile.id).unwrap();
        assert_eq!(list(&dir, &passwords).unwrap(), vec![b.clone()]);
        assert_eq!(passwords.get(&a.profile.id), None);
        assert_eq!(passwords.get(&b.profile.id).as_deref(), Some("pb"));
        // Deleted already: nothing to do, and the other connection is not touched.
        delete(&dir, &passwords, &a.profile.id).unwrap();
        delete(&dir, &passwords, "").unwrap();
        assert_eq!(list(&dir, &passwords).unwrap(), vec![b]);
        // The name can be used again.
        assert!(save(&dir, &passwords, direct("a"), None).is_ok());
    }

    #[test]
    fn a_test_logs_in_with_the_typed_password_else_the_saved_one_else_none() {
        let passwords = Memory::default();
        passwords.set("a", "saved").unwrap();
        let saved = [DatabaseProfile {
            id: "a".to_owned(),
            ..direct("a")
        }];
        let of = |id: &str, typed: Option<&str>| {
            let profile = DatabaseProfile {
                id: id.to_owned(),
                ..direct("a")
            };
            test_password(&passwords, &saved, &profile, typed).unwrap()
        };
        assert_eq!(of("a", Some(" typed ")), " typed ");
        assert_eq!(of("a", Some("")), "saved");
        assert_eq!(of("a", None), "saved");
        assert_eq!(of("b", None), "");
        assert_eq!(of("", Some("")), "");
        assert_eq!(of("", Some("new")), "new");
    }

    #[test]
    fn the_saved_password_is_used_only_for_the_login_it_was_saved_for() {
        let passwords = Memory::default();
        passwords.set("a", "saved").unwrap();
        for stored in [scripted("a"), direct("a")] {
            let stored = DatabaseProfile {
                id: "a".to_owned(),
                ..stored
            };
            let saved = [stored.clone()];
            let of = |profile: &DatabaseProfile, typed: Option<&str>| {
                test_password(&passwords, &saved, profile, typed)
            };
            assert_eq!(of(&stored, None), Ok("saved".to_owned()));
            // Each of the fields that say where and as whom the login goes refuses the saved password.
            let other_script = if stored.script.is_empty() {
                "exec other-forward".to_owned()
            } else {
                String::new()
            };
            let changed = [
                DatabaseProfile {
                    username: "root".to_owned(),
                    ..stored.clone()
                },
                DatabaseProfile {
                    script: other_script,
                    ..stored.clone()
                },
                DatabaseProfile {
                    script: "exec other-forward".to_owned(),
                    ..stored.clone()
                },
                DatabaseProfile {
                    db_host: "evil.example.com".to_owned(),
                    ..stored.clone()
                },
                DatabaseProfile {
                    db_port: 3307,
                    ..stored.clone()
                },
            ];
            for profile in &changed {
                let told = of(profile, None).unwrap_err();
                assert_eq!(
                    told, "接続先やユーザーを変えたときは、パスワードを入力してください",
                    "{profile:?}"
                );
                // A password typed goes where it was typed for.
                assert_eq!(of(profile, Some("typed")), Ok("typed".to_owned()));
            }
            // The name is not where the login goes.
            let renamed = DatabaseProfile {
                name: "renamed".to_owned(),
                ..stored
            };
            assert_eq!(of(&renamed, None), Ok("saved".to_owned()));
        }
    }

    #[test]
    fn a_test_whose_keychain_cannot_be_read_is_an_error() {
        struct Locked;
        impl PasswordStore for Locked {
            fn exists(&self, _: &str) -> Result<bool, String> {
                Err("locked".to_owned())
            }
            fn get(&self, _: &str) -> Result<Option<String>, String> {
                Err("locked".to_owned())
            }
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                Err("locked".to_owned())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Err("locked".to_owned())
            }
        }
        let a = DatabaseProfile {
            id: "a".to_owned(),
            ..direct("a")
        };
        let saved = [a.clone()];
        assert_eq!(
            test_password(&Locked, &saved, &a, None),
            Err("locked".to_owned())
        );
        assert_eq!(
            test_password(&Locked, &saved, &a, Some("typed")),
            Ok("typed".to_owned())
        );
    }

    #[test]
    fn the_saved_login_is_the_profile_of_the_id_with_its_password_or_none() {
        let dir = temp_dir("login");
        let passwords = Memory::default();
        let a = save(&dir, &passwords, direct("a"), Some("pa".to_owned())).unwrap();
        let b = save(&dir, &passwords, direct("b"), None).unwrap();
        let (profile, password) = saved_login(&dir, &passwords, &a.profile.id).unwrap();
        assert_eq!((profile, password.as_str()), (a.profile, "pa"));
        let (profile, password) = saved_login(&dir, &passwords, &b.profile.id).unwrap();
        assert_eq!((profile.name.as_str(), password.as_str()), ("b", ""));
        let gone = saved_login(&dir, &passwords, "gone").unwrap_err();
        assert!(gone.contains("見つかりません"), "{gone}");
    }

    #[test]
    fn a_session_is_kept_only_while_the_login_it_was_opened_with_is_still_saved() {
        let dir = temp_dir("opened");
        let passwords = Memory::default();
        let a = save(&dir, &passwords, direct("a"), Some("pa".to_owned())).unwrap();
        let id = a.profile.id.clone();
        let opened = saved_login(&dir, &passwords, &id).unwrap();
        assert_eq!(
            login_unchanged(&opened, &saved_login(&dir, &passwords, &id)),
            Ok(())
        );
        // Edited: another host, or only the password.
        let moved = DatabaseProfile {
            db_host: "10.0.0.9".to_owned(),
            ..a.profile.clone()
        };
        save(&dir, &passwords, moved, None).unwrap();
        let changed = "接続が変更または削除されました。もう一度開いてください";
        assert_eq!(
            login_unchanged(&opened, &saved_login(&dir, &passwords, &id)),
            Err(changed.to_owned())
        );
        let now = saved_login(&dir, &passwords, &id).unwrap();
        save(&dir, &passwords, now.0.clone(), Some("new".to_owned())).unwrap();
        assert_eq!(
            login_unchanged(&now, &saved_login(&dir, &passwords, &id)),
            Err(changed.to_owned())
        );
        // Deleted: the file no longer has it, which is a change.
        delete(&dir, &passwords, &id).unwrap();
        let gone = saved_login(&dir, &passwords, &id);
        assert!(gone.is_err());
        assert_eq!(login_unchanged(&now, &gone), Err(gone.clone().unwrap_err()));
    }

    #[test]
    fn a_login_that_cannot_be_read_again_is_told_as_that_error_and_not_as_a_change() {
        let opened = (direct("a"), "pa".to_owned());
        let failed = Err("キーチェーンを読めません".to_owned());
        assert_eq!(
            login_unchanged(&opened, &failed),
            Err("キーチェーンを読めません".to_owned())
        );
    }

    #[test]
    fn the_ids_are_32_hex_digits_and_differ() {
        let (a, b) = (new_id().unwrap(), new_id().unwrap());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn a_connection_with_no_script_goes_to_its_host_and_starts_nothing() {
        let scripts = script::Scripts::default();
        let profile = DatabaseProfile {
            db_host: "db.example.com".to_owned(),
            db_port: 3307,
            ..direct("a")
        };
        let (endpoint, script) = open_endpoint(&scripts, &profile).await.unwrap();
        assert_eq!(
            (endpoint.host.as_str(), endpoint.port, endpoint.scripted),
            ("db.example.com", 3307, false)
        );
        assert_eq!(script, None);
    }

    #[tokio::test]
    async fn a_profile_without_a_host_or_a_port_is_refused_before_a_script_is_run() {
        let scripts = script::Scripts::default();
        // What a file saved while a script needed none (#719) holds: the script, an empty host and the port 0.
        let old = DatabaseProfile {
            db_host: String::new(),
            db_port: 0,
            ..scripted("a")
        };
        assert_eq!(
            open_endpoint(&scripts, &old).await.unwrap_err(),
            "DB のホストを入力してください"
        );
        assert_eq!(
            test_connection(&scripts, old.clone(), "pw")
                .await
                .unwrap_err(),
            "DB のホストを入力してください"
        );
        let out_of_range = DatabaseProfile {
            db_port: 70000,
            ..scripted("a")
        };
        assert_eq!(
            open_endpoint(&scripts, &out_of_range).await.unwrap_err(),
            "ポートは 1 から 65535 の間で入力してください"
        );
        let no_port = DatabaseProfile {
            db_port: 0,
            ..direct("a")
        };
        assert_eq!(
            open_endpoint(&scripts, &no_port).await.unwrap_err(),
            "ポートは 1 から 65535 の間で入力してください"
        );
        let sessions = session::Sessions::default();
        assert_eq!(
            open_session(&sessions, &scripts, &old, "pw")
                .await
                .unwrap_err(),
            "DB のホストを入力してください"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_connection_with_a_script_runs_it_for_its_own_host_and_port_and_reaches_them() {
        use script::support::{free_port, listen_later};
        let scripts = script::Scripts::default();
        let port = free_port();
        let _listener = listen_later(port);
        let profile = DatabaseProfile {
            script: "sleep 30".to_owned(),
            db_host: "127.0.0.1".to_owned(),
            db_port: u32::from(port),
            ..direct("a")
        };
        let (endpoint, script) = open_endpoint(&scripts, &profile).await.unwrap();
        assert_eq!(
            (endpoint.host.as_str(), endpoint.port, endpoint.scripted),
            ("127.0.0.1", port, true)
        );
        let id = script.unwrap();
        assert_eq!(scripts.exited(id).await, None);
        scripts.close(id).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_port_in_use_before_the_script_is_run_stops_the_test_and_the_opening() {
        let scripts = script::Scripts::default();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let profile = DatabaseProfile {
            script: "exit 0".to_owned(),
            db_port: u32::from(port),
            ..direct("a")
        };
        let expected = format!("127.0.0.1:{port} は、スクリプトを実行する前から使われています。使っているものを止めるか、別のポートにしてください");
        assert_eq!(
            test_connection(&scripts, profile.clone(), "pw")
                .await
                .unwrap_err(),
            expected
        );
        let sessions = session::Sessions::default();
        assert_eq!(
            open_session(&sessions, &scripts, &profile, "pw")
                .await
                .unwrap_err(),
            expected
        );
        // With no script, a port in use is the connection's own place: nothing is refused for it.
        let plain = DatabaseProfile {
            script: String::new(),
            ..profile
        };
        assert!(open_endpoint(&scripts, &plain).await.is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_test_and_the_opening_of_a_connection_both_stop_at_a_script_that_ends_before_it_is_ready(
    ) {
        let scripts = script::Scripts::default();
        let profile = DatabaseProfile {
            script: "echo no route >&2\nexit 0".to_owned(),
            db_port: u32::from(script::support::free_port()),
            ..direct("a")
        };
        let expected = "接続のスクリプトが、準備ができる前に終了しました（終了コード 0）。標準エラーの最後の行: no route";
        assert_eq!(
            open_endpoint(&scripts, &profile).await.unwrap_err(),
            expected
        );
        assert_eq!(
            test_connection(&scripts, profile.clone(), "pw")
                .await
                .unwrap_err(),
            expected
        );
        let sessions = session::Sessions::default();
        assert_eq!(
            open_session(&sessions, &scripts, &profile, "pw")
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(sessions.ids(&scripts).await, Vec::<String>::new());
    }

    #[test]
    fn a_save_without_a_password_keeps_the_saved_one_and_sets_none() {
        let dir = temp_dir("mcp-save");
        let passwords = Memory::default();
        let first = save_without_password(&dir, &passwords, direct("a")).unwrap();
        assert!(!first.password_saved);
        assert_eq!(passwords.get(&first.profile.id), None);
        passwords.set(&first.profile.id, "secret").unwrap();
        let edited = DatabaseProfile {
            name: "b".to_owned(),
            ..first.profile.clone()
        };
        let second = save_without_password(&dir, &passwords, edited).unwrap();
        assert!(second.password_saved);
        assert_eq!(second.profile.name, "b");
        assert_eq!(passwords.get(&first.profile.id).as_deref(), Some("secret"));
        assert_eq!(list(&dir, &passwords).unwrap(), vec![second]);
        // Only the checks of a save: a name another connection has is refused, and nothing is written.
        let taken = save_without_password(&dir, &passwords, direct("b")).unwrap_err();
        assert_eq!(taken, "同じ名前の接続があります: b");
        assert_eq!(list(&dir, &passwords).unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A saved password and the connection that holds it, saved without a password.
    fn saved_with_password(
        name: &str,
        profile: DatabaseProfile,
    ) -> (PathBuf, Memory, DatabaseProfileView) {
        let dir = temp_dir(name);
        let passwords = Memory::default();
        let saved = save_without_password(&dir, &passwords, profile).unwrap();
        passwords.set(&saved.profile.id, "secret").unwrap();
        (dir, passwords, saved)
    }

    #[test]
    fn a_save_without_a_password_deletes_the_saved_one_when_the_login_goes_elsewhere() {
        type Edit = fn(&mut DatabaseProfile);
        let edits: [(&str, Edit); 4] = [
            ("user", |p| p.username = "other".to_owned()),
            ("host", |p| p.db_host = "db.elsewhere.example".to_owned()),
            ("port", |p| p.db_port = 3307),
            ("script", |p| p.script = "echo hi".to_owned()),
        ];
        for (what, edit) in edits {
            let (dir, passwords, saved) =
                saved_with_password(&format!("mcp-away-{what}"), direct("a"));
            let mut moved = saved.profile.clone();
            edit(&mut moved);
            let after = save_without_password(&dir, &passwords, moved).unwrap();
            assert!(!after.password_saved, "{what}");
            assert_eq!(passwords.get(&saved.profile.id), None, "{what}");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_save_without_a_password_of_a_script_connection_deletes_it_when_the_script_the_host_or_the_port_changes(
    ) {
        let (dir, passwords, saved) = saved_with_password("mcp-away-scripted", scripted("a"));
        // Only the name is not where the login goes.
        let renamed = DatabaseProfile {
            name: "renamed".to_owned(),
            ..saved.profile.clone()
        };
        assert!(
            save_without_password(&dir, &passwords, renamed)
                .unwrap()
                .password_saved
        );
        std::fs::remove_dir_all(dir).unwrap();
        type Edit = fn(&mut DatabaseProfile);
        let edits: [(&str, Edit); 3] = [
            ("script", |p| p.script = "exec other-forward".to_owned()),
            ("host", |p| p.db_host = "db.elsewhere.example".to_owned()),
            ("port", |p| p.db_port = 3307),
        ];
        for (what, edit) in edits {
            let (dir, passwords, saved) =
                saved_with_password(&format!("mcp-away-script-{what}"), scripted("a"));
            let mut moved = saved.profile.clone();
            edit(&mut moved);
            assert!(
                !save_without_password(&dir, &passwords, moved)
                    .unwrap()
                    .password_saved,
                "{what}"
            );
            assert_eq!(passwords.get(&saved.profile.id), None, "{what}");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_refused_save_without_a_password_deletes_nothing() {
        let (dir, passwords, saved) = saved_with_password("mcp-away-refused", direct("a"));
        let refused = DatabaseProfile {
            username: String::new(),
            ..saved.profile.clone()
        };
        assert_eq!(
            save_without_password(&dir, &passwords, refused).unwrap_err(),
            "ユーザー名を入力してください"
        );
        assert_eq!(passwords.get(&saved.profile.id).as_deref(), Some("secret"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_test_of_a_saved_connection_that_is_not_saved_is_refused() {
        let dir = temp_dir("mcp-test-missing");
        let scripts = script::Scripts::default();
        let error = test_saved(&dir, &Memory::default(), &scripts, "nope")
            .await
            .unwrap_err();
        assert_eq!(error, "接続が見つかりません。一覧を読み直してください");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_test_of_a_saved_connection_runs_its_script_and_tells_the_end_of_its_standard_error()
    {
        let dir = temp_dir("mcp-test-script");
        let passwords = Memory::default();
        let scripts = script::Scripts::default();
        let saved = save_without_password(
            &dir,
            &passwords,
            DatabaseProfile {
                script: "echo no route >&2\nexit 7".to_owned(),
                db_port: u32::from(script::support::free_port()),
                ..direct("a")
            },
        )
        .unwrap();
        let error = test_saved(&dir, &passwords, &scripts, &saved.profile.id)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "接続のスクリプトが、準備ができる前に終了しました（終了コード 7）。標準エラーの最後の行: no route"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
