//! The connection profiles of the database screen (D-1): where a connection goes and how it logs in, saved one by one.
//!
//! The profiles are in `database-profiles.json` in the app config directory, written through `write_atomic`.
//! The password of a profile is in the OS keychain (service `KEYRING_SERVICE`, user the profile's id), never in the file and never in the answer of a command:
//! the screen is told only whether one is saved (`DatabaseProfileView::password_saved`).
//! The id is made here at the first save and never changes, so that renaming a connection leaves its password where it is.
//! The checks of an input (`check`, `upsert`, `password_change`) are pure functions; the keychain is behind `PasswordStore` so that the flows can be tried without it.

pub mod ssm;

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
    /// Whether the connection goes through an AWS Systems Manager port forward. When it does not, only the host and the port are used.
    pub use_ssm: bool,
    pub aws_profile: String,
    pub region: String,
    /// The `Name` tag of the instance to forward through.
    pub bastion_name: String,
    pub db_host: String,
    /// A number wider than a port, so that a value out of range reaches `check` and is refused in Japanese.
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

/// `profile` trimmed and checked against the other profiles of `profiles` (the ones with another id), or the first reason, in Japanese.
/// A connection that does not use SSM keeps no AWS profile, region or bastion.
fn check(
    profile: DatabaseProfile,
    profiles: &[DatabaseProfile],
) -> Result<DatabaseProfile, String> {
    let trim = |s: &str| s.trim().to_owned();
    let mut p = DatabaseProfile {
        name: trim(&profile.name),
        username: trim(&profile.username),
        aws_profile: trim(&profile.aws_profile),
        region: trim(&profile.region),
        bastion_name: trim(&profile.bastion_name),
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
    if p.db_host.is_empty() {
        return Err("DB のホストを入力してください".to_owned());
    }
    if p.db_host.chars().any(char::is_whitespace) {
        return Err("DB のホストに空白は使えません".to_owned());
    }
    if !(1..=PORT_MAX).contains(&p.db_port) {
        return Err(format!("ポートは 1 から {PORT_MAX} の間で入力してください"));
    }
    if p.use_ssm {
        if p.aws_profile.is_empty() {
            return Err("AWS のプロファイル名を入力してください".to_owned());
        }
        if p.region.is_empty() {
            return Err("リージョンを入力してください".to_owned());
        }
        if p.bastion_name.is_empty() {
            return Err("踏み台の名前を入力してください".to_owned());
        }
    } else {
        p.aws_profile.clear();
        p.region.clear();
        p.bastion_name.clear();
    }
    if [
        &p.name,
        &p.username,
        &p.aws_profile,
        &p.region,
        &p.bastion_name,
        &p.db_host,
    ]
    .into_iter()
    .any(|s| has_control(s))
    {
        return Err("制御文字は使えません".to_owned());
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

/// The saved connections, each with whether its password is saved.
#[tauri::command]
pub async fn database_profiles(app: AppHandle) -> Result<Vec<DatabaseProfileView>, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || list(&dir, &Keychain))
        .await
        .map_err(|e| e.to_string())?
}

/// Saves a connection and answers it as saved. An empty `password` leaves the saved password as it is.
#[tauri::command]
pub async fn database_profile_save(
    app: AppHandle,
    profile: DatabaseProfile,
    password: Option<String>,
) -> Result<DatabaseProfileView, String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
        save(&dir, &Keychain, profile, password)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a connection and its password.
#[tauri::command]
pub async fn database_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
        delete(&dir, &Keychain, &id)
    })
    .await
    .map_err(|e| e.to_string())?
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
            use_ssm: false,
            aws_profile: String::new(),
            region: String::new(),
            bastion_name: String::new(),
            db_host: "127.0.0.1".to_owned(),
            db_port: 3306,
        }
    }

    fn ssm(name: &str) -> DatabaseProfile {
        DatabaseProfile {
            use_ssm: true,
            aws_profile: "dev".to_owned(),
            region: "ap-northeast-1".to_owned(),
            bastion_name: "dev-ecs".to_owned(),
            db_host: "db.cluster.example".to_owned(),
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
        assert_eq!(check(ssm("本番"), &[]).unwrap().bastion_name, "dev-ecs");
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
    fn a_connection_through_ssm_needs_the_profile_the_region_and_the_bastion() {
        type Blank = fn(&mut DatabaseProfile);
        let cases: [(Blank, &str); 3] = [
            (
                |p| p.aws_profile = "  ".to_owned(),
                "AWS のプロファイル名を入力してください",
            ),
            (|p| p.region = String::new(), "リージョンを入力してください"),
            (
                |p| p.bastion_name = String::new(),
                "踏み台の名前を入力してください",
            ),
        ];
        for (blank, message) in cases {
            let mut p = ssm("a");
            blank(&mut p);
            assert_eq!(reason(p, &[]), message);
        }
    }

    #[test]
    fn a_connection_without_ssm_drops_what_is_left_of_ssm() {
        let p = DatabaseProfile {
            use_ssm: false,
            ..ssm("a")
        };
        let checked = check(p, &[]).unwrap();
        assert_eq!(
            (checked.aws_profile, checked.region, checked.bastion_name),
            (String::new(), String::new(), String::new())
        );
        assert_eq!(checked.db_host, "db.cluster.example");
    }

    #[test]
    fn a_control_character_inside_a_field_is_refused() {
        let p = DatabaseProfile {
            username: "re\u{0}ader".to_owned(),
            ..direct("a")
        };
        assert_eq!(reason(p, &[]), "制御文字は使えません");
        let p = DatabaseProfile {
            region: "ap\u{7}".to_owned(),
            ..ssm("a")
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
                ..ssm("a")
            },
            DatabaseProfile {
                id: "y".to_owned(),
                ..direct("b")
            },
        ];
        let text = render(&profiles).unwrap();
        assert!(text.contains("\"dbPort\": 3306") && text.contains("\"useSsm\": true"));
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
            ssm("開発"),
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
                use_ssm: true,
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
    fn the_ids_are_32_hex_digits_and_differ() {
        let (a, b) = (new_id().unwrap(), new_id().unwrap());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
