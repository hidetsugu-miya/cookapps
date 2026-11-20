//! A-45 (#986): the plugin that gives a Claude Code started by "Claude を起動" (A-16) the tool `preview_open` of `tsunagiai-mcp`: its skill and plugin.json are the files of `src-tauri/preview-plugin/` that `build.rs` embeds (`formation_assets::PREVIEW_PLUGIN`), and its `.mcp.json` names the `tsunagiai-mcp` of this PC with the argument `--preview` (which offers `preview_open` and no other tool, A-45: the Claude Code of a launch can start from the text of a mail or a message, A-9).
//! The plugin is written into `preview-plugin/` of the config folder of the PC the Claude Code runs on, whole and only when the folder does not hold this very plugin (`formation_assets::ensure_plugin`): by the app for its own PC, and by `tsunagiai-mcp --preview-plugin` for the PC of a saved environment, which the command of the launch runs there. It is given to `claude` with `--plugin-dir`, and is not published.

use std::path::{Path, PathBuf};

use crate::formation_assets::{ensure_plugin, PREVIEW_PLUGIN};

/// The folder of the plugin in the config folder.
const FOLDER: &str = "preview-plugin";
/// The argument that `.mcp.json` gives `tsunagiai-mcp`: it offers `preview_open` only.
const SERVER_ARGS: [&str; 1] = ["--preview"];
/// The argument of `tsunagiai-mcp` that writes the plugin and prints the folder's path (one line on stdout), and serves nothing.
pub const FLAG: &str = "--preview-plugin";

/// `preview-plugin/` in the config directory.
pub fn plugin_dir(config: &Path) -> PathBuf {
    config.join(FOLDER)
}

/// Makes `preview-plugin/` of `config` hold the embedded plugin and the `.mcp.json` that starts `mcp` (the `tsunagiai-mcp` of this PC, an absolute path) with `--preview`, and answers its path. A folder that holds this very plugin, for this `mcp`, is left as it is.
pub fn write_plugin(config: &Path, mcp: &Path) -> Result<PathBuf, String> {
    let dir = plugin_dir(config);
    let mcp_json = crate::claude_code::mcp_config(mcp, &SERVER_ARGS);
    let mut files = PREVIEW_PLUGIN.to_vec();
    files.push((".mcp.json", &mcp_json));
    ensure_plugin(&dir, &files)?;
    Ok(dir)
}

/// Whether `--preview-plugin` is among `args`: `tsunagiai-mcp` then writes the plugin and serves nothing.
pub fn requested(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|arg| arg == FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-preview-plugin-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_plugin_is_embedded_with_its_manifest_skill_and_no_server_of_its_own() {
        let paths: Vec<&str> = PREVIEW_PLUGIN.iter().map(|(path, _)| *path).collect();
        assert_eq!(
            paths,
            [".claude-plugin/plugin.json", "skills/preview/SKILL.md"]
        );
        let manifest: serde_json::Value = serde_json::from_str(PREVIEW_PLUGIN[0].1).unwrap();
        assert_eq!(manifest["name"], "preview");
        assert!(manifest["description"]
            .as_str()
            .is_some_and(|d| !d.is_empty()));
        // The skill tells when to call the tool and how to give its two arguments.
        let skill = PREVIEW_PLUGIN[1].1;
        assert!(skill.starts_with("---\nname: preview\ndescription: "));
        for word in ["preview_open", "worktree", "file", ".html"] {
            assert!(skill.contains(word), "{word}");
        }
    }

    #[test]
    fn the_plugin_is_written_whole_with_an_mcp_json_that_starts_the_given_server_with_the_preview_argument(
    ) {
        let config = temp_dir("write");
        let mcp = Path::new("/Applications/tsunagiai.app/Contents/MacOS/tsunagiai-mcp");
        let dir = write_plugin(&config, mcp).unwrap();
        assert_eq!(dir, config.join("preview-plugin"));
        for (path, text) in PREVIEW_PLUGIN {
            assert_eq!(&std::fs::read_to_string(dir.join(path)).unwrap(), text);
        }
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"mcpServers": {"tsunagiai": {
                "command": "/Applications/tsunagiai.app/Contents/MacOS/tsunagiai-mcp",
                "args": ["--preview"]
            }}})
        );
        // Nothing else is beside the folder.
        let names: Vec<_> = std::fs::read_dir(&config)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["preview-plugin"]);
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn a_folder_that_holds_this_plugin_for_this_server_is_left_and_any_other_is_written_again() {
        let config = temp_dir("again");
        let mcp = Path::new("/a/tsunagiai-mcp");
        let dir = write_plugin(&config, mcp).unwrap();
        std::fs::write(dir.join("marker.txt"), "x").unwrap();
        write_plugin(&config, mcp).unwrap();
        assert!(dir.join("marker.txt").exists());
        // Another server's path changes `.mcp.json`, so the folder is written again.
        write_plugin(&config, Path::new("/b/tsunagiai-mcp")).unwrap();
        assert!(!dir.join("marker.txt").exists());
        assert!(std::fs::read_to_string(dir.join(".mcp.json"))
            .unwrap()
            .contains("/b/tsunagiai-mcp"));
        // A file that was cut short is written again too.
        std::fs::write(dir.join("marker.txt"), "x").unwrap();
        std::fs::write(dir.join(".mcp.json"), "{").unwrap();
        write_plugin(&config, Path::new("/b/tsunagiai-mcp")).unwrap();
        assert!(!dir.join("marker.txt").exists());
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_flag_is_found_among_the_arguments_and_nowhere_else() {
        let args = |list: &[&str]| list.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
        assert!(requested(args(&["--preview-plugin"])));
        assert!(requested(args(&["--calendar", "--preview-plugin"])));
        assert!(!requested(args(&[])));
        assert!(!requested(args(&["--calendar", "--formation", "x"])));
        assert!(!requested(args(&["--preview-plugin-x"])));
    }
}
