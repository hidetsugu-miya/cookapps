//! #780 (a part of #774): the folders of a saved environment's server, listed for the screen that picks the folder of a project to add. The call is `files.browseServerDir` of Orca's runtime (`{path}`, answered `{resolvedPath, entries, pathFlavor}`), over the WebSocket of the saved environment (the connection of A-10).
//! It is not a public interface of Orca: it was read in the `app.asar` of Orca 1.4.261 (its `browseDirectory`), and never run against a real saved environment. A token is in no log line, no error text and no return value.

use serde::Serialize;
use serde_json::{json, Value};
#[cfg(test)]
use ts_rs::TS;

use crate::{
    orca::{check_environment, message_of, read_environments},
    orca_attach::Rpc,
    orca_link::Connection,
};

/// Characters of the path to browse (the same bound as the folder of a project to add, `PROJECT_PATH_LIMIT` in `orca.rs`).
const PATH_LIMIT: usize = 4096;
/// What Orca reads as the home folder of its server. An empty path means it too (`browseDirectory` takes `path.trim() || "~"`); the call always says it, so no version of Orca has to read an empty string.
const HOME: &str = "~";
const NOT_READ: &str = "Orca のフォルダの一覧を読めません";

/// The folders inside one folder of a saved environment's server. `resolved_path` is the folder Orca opened (an empty or relative path is resolved by Orca against the home folder), and `folders` are the names of its folders, in the order of their names.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct BrowsedDir {
    pub resolved_path: String,
    pub folders: Vec<String>,
}

/// The path to browse (a value from outside): at most 4096 characters, with no NUL. Empty is allowed: it is the home folder.
fn check_browse_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("フォルダの場所に使えない文字が含まれています".into());
    }
    if path.chars().count() > PATH_LIMIT {
        return Err(format!("フォルダの場所は {PATH_LIMIT} 文字までです"));
    }
    Ok(())
}

/// The path of the call: the given one, or the home folder when it is empty.
fn call_path(path: &str) -> &str {
    if path.trim().is_empty() {
        HOME
    } else {
        path
    }
}

/// The name of a folder in an answer: a name with no `/` and no NUL, not `.` or `..` (a `\` stays: a Windows server lists its drives as `C:\`).
fn folder_name(entry: &Value) -> Option<&str> {
    if entry["isDirectory"].as_bool() != Some(true) {
        return None;
    }
    entry["name"]
        .as_str()
        .filter(|n| !n.is_empty() && !n.contains(['/', '\0']) && *n != "." && *n != "..")
}

/// The answer of `files.browseServerDir`: the folder Orca opened and the names of the folders in it, in the order of their names (without regard to case, then by the name itself). A link to a folder is a folder (Orca's `isDirectory` follows it), and a file, a link to a file and a broken link are left out.
/// An answer with no `resolvedPath` or no `entries` is unreadable.
fn parse_browse(answer: &Value) -> Result<BrowsedDir, String> {
    let resolved_path = answer["resolvedPath"]
        .as_str()
        .filter(|p| !p.is_empty())
        .ok_or(NOT_READ)?;
    let entries = answer["entries"].as_array().ok_or(NOT_READ)?;
    let mut folders: Vec<String> = entries
        .iter()
        .filter_map(folder_name)
        .map(str::to_owned)
        .collect();
    folders.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    Ok(BrowsedDir {
        resolved_path: resolved_path.to_owned(),
        folders,
    })
}

/// The folders in `path` of the server `rpc` talks to. A failed call is its message for the screen (Orca's code, never its message).
async fn browse(rpc: &mut impl Rpc, path: &str) -> Result<BrowsedDir, String> {
    let answer = rpc
        .call("files.browseServerDir", json!({"path": call_path(path)}))
        .await
        .map_err(|e| e.shown)?;
    parse_browse(&answer)
}

/// #780: the folders in `path` of the saved environment `environment` (an empty `path` is its home folder). `environment` must be a saved one (read just now), so this machine and an SSH host are not asked, and `path` must hold no NUL and be at most 4096 characters. Only reads.
#[tauri::command]
pub async fn orca_browse_dir(environment: String, path: String) -> Result<BrowsedDir, String> {
    check_browse_path(&path)?;
    let name = environment.clone();
    tokio::task::spawn_blocking(move || {
        check_environment(&name, &read_environments().map_err(message_of)?)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut connection = Connection::open(Some(environment)).await?;
    browse(&mut connection, &path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orca_link::CallError;

    /// Orca's side of the call: the calls it was given, and its answer.
    struct Fake {
        calls: Vec<(String, Value)>,
        answer: Result<Value, CallError>,
    }

    impl Rpc for Fake {
        async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
            self.calls.push((method.to_owned(), params));
            match &self.answer {
                Ok(v) => Ok(v.clone()),
                Err(e) => Err(CallError {
                    shown: e.shown.clone(),
                    detail: e.detail.clone(),
                }),
            }
        }
    }

    fn fake(answer: Result<Value, CallError>) -> Fake {
        Fake {
            calls: Vec::new(),
            answer,
        }
    }

    fn entry(name: &str, dir: bool, link: bool) -> Value {
        json!({"name": name, "isDirectory": dir, "isSymlink": link})
    }

    #[test]
    fn only_the_folders_are_kept_in_the_order_of_their_names() {
        let answer = json!({
            "resolvedPath": "/home/me",
            "pathFlavor": "posix",
            "entries": [
                entry("zeta", true, false),
                entry("notes.txt", false, false),
                entry("Beta", true, false),
                entry("alpha", true, false),
                // A link to a folder is a folder; a link to a file or a broken one is not.
                entry("linked", true, true),
                entry("dead-link", false, true),
                entry("Alpha", true, false),
            ],
        });
        let dir = parse_browse(&answer).unwrap();
        assert_eq!(dir.resolved_path, "/home/me");
        assert_eq!(dir.folders, ["Alpha", "alpha", "Beta", "linked", "zeta"]);
    }

    #[test]
    fn a_folder_with_no_folder_is_an_empty_list() {
        let answer = json!({"resolvedPath": "/srv", "entries": [entry("a", false, false)]});
        assert!(parse_browse(&answer).unwrap().folders.is_empty());
        let answer = json!({"resolvedPath": "/srv", "entries": []});
        assert!(parse_browse(&answer).unwrap().folders.is_empty());
    }

    #[test]
    fn an_entry_that_is_no_usable_folder_is_left_out() {
        let answer = json!({
            "resolvedPath": "C:\\Users\\me",
            "entries": [
                entry("C:\\", true, false),
                entry("", true, false),
                entry(".", true, false),
                entry("..", true, false),
                entry("a/b", true, false),
                entry("nul\0", true, false),
                {"name": "no-flag"},
                {"name": "string-flag", "isDirectory": "true"},
                {"isDirectory": true},
                {"name": 3, "isDirectory": true},
                "text",
                Value::Null,
                entry("ok", true, false),
            ],
        });
        assert_eq!(parse_browse(&answer).unwrap().folders, ["C:\\", "ok"]);
    }

    #[test]
    fn an_answer_that_cannot_be_read_is_refused() {
        for answer in [
            Value::Null,
            json!([]),
            json!("/home/me"),
            json!({"entries": []}),
            json!({"resolvedPath": "", "entries": []}),
            json!({"resolvedPath": 3, "entries": []}),
            json!({"resolvedPath": "/home/me"}),
            json!({"resolvedPath": "/home/me", "entries": "none"}),
        ] {
            assert_eq!(parse_browse(&answer), Err(NOT_READ.to_owned()), "{answer}");
        }
    }

    #[tokio::test]
    async fn an_empty_path_asks_for_the_home_folder() {
        for path in ["", "  "] {
            let mut rpc = fake(Ok(json!({"resolvedPath": "/home/me", "entries": []})));
            let dir = browse(&mut rpc, path).await.unwrap();
            assert_eq!(dir.resolved_path, "/home/me");
            assert_eq!(
                rpc.calls,
                [("files.browseServerDir".to_owned(), json!({"path": "~"}))]
            );
        }
    }

    #[tokio::test]
    async fn a_path_is_sent_as_it_is() {
        let mut rpc = fake(Ok(json!({"resolvedPath": "/srv/app", "entries": []})));
        browse(&mut rpc, "/srv/app").await.unwrap();
        assert_eq!(rpc.calls[0].1, json!({"path": "/srv/app"}));
    }

    #[tokio::test]
    async fn a_failed_call_is_its_message_without_what_orca_said() {
        let mut rpc = fake(Err(CallError {
            shown: "Orca がエラーを返しました（runtime_error）".into(),
            detail: "/nope is not a directory".into(),
        }));
        assert_eq!(
            browse(&mut rpc, "/nope").await,
            Err("Orca がエラーを返しました（runtime_error）".to_owned())
        );
    }

    #[test]
    fn the_path_is_checked() {
        assert!(check_browse_path("").is_ok());
        assert!(check_browse_path("/srv/app").is_ok());
        assert!(check_browse_path("~/work").is_ok());
        assert!(check_browse_path("/a\0b").is_err());
        assert!(check_browse_path(&"a".repeat(PATH_LIMIT)).is_ok());
        assert!(check_browse_path(&"a".repeat(PATH_LIMIT + 1)).is_err());
        // The limit counts characters, not bytes.
        assert!(check_browse_path(&"あ".repeat(PATH_LIMIT)).is_ok());
    }
}
