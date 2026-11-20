//! A-41: the files of `src-tauri/formation/` that are embedded in the binary at build time (`build.rs`), and how they are written.
//! `PREVIEW_PLUGIN` (A-45) is the plugin of `src-tauri/preview-plugin/`, which `preview_plugin` writes with `ensure_plugin`.
//! `LEADER_SKILL` is the leader's skill `feature-dev`, written into the folder of the orchestrator of each formation (`claude_code::write_formation_files`).
//! `PLUGIN` is the plugin `feature-dev` (the unit procedures and the agents), written into `formation-plugin/` of the config folder before a child is launched (`formation::launch`) unless the folder already holds this very plugin, and given to the child's `claude` with `--plugin-dir`.
//! Each list is `(path relative to its folder with "/", contents)`.

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

use sha2::{Digest, Sha256};

include!(concat!(env!("OUT_DIR"), "/formation_assets.rs"));

/// The folder of the plugin in the config folder, which `claude --plugin-dir` is given.
const PLUGIN_FOLDER: &str = "formation-plugin";

/// `formation-plugin/` in the config directory.
pub fn plugin_dir(config: &Path) -> PathBuf {
    config.join(PLUGIN_FOLDER)
}

/// The file of `formation-plugin/` that holds the hash of the plugin that was written (`plugin_mark`): it is replaced with the folder, so the two cannot disagree.
const MARK_FILE: &str = ".tsunagiai-plugin-hash";

/// The hash of `files` (their paths and contents, in order): what tells that the folder holds this very plugin.
fn plugin_mark(files: &[(&str, &str)]) -> String {
    let mut hash = Sha256::new();
    for (path, text) in files {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(text.as_bytes());
        hash.update([0]);
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `dir` holds `files` as `replace_dir` wrote them for `mark`: a real folder (not a link), the mark file with `mark`, and every file there with the length it has, so that a file that a crash left empty or cut is told. The contents are not read again.
fn holds_plugin(dir: &Path, files: &[(&str, &str)], mark: &str) -> bool {
    std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir())
        && std::fs::read_to_string(dir.join(MARK_FILE)).is_ok_and(|text| text == mark)
        && files.iter().all(|(path, text)| {
            std::fs::symlink_metadata(dir.join(path))
                .is_ok_and(|m| m.is_file() && m.len() == text.len() as u64)
        })
}

/// Makes `dir` hold `plugin`, as a whole, with its mark. A folder that already holds this plugin (`holds_plugin`) is left as it is: a launch does not write the files again, and the others that read the folder never see it replaced.
pub(crate) fn ensure_plugin(dir: &Path, plugin: &[(&str, &str)]) -> Result<(), String> {
    let mark = plugin_mark(plugin);
    if !holds_plugin(dir, plugin, &mark) {
        let mut files = plugin.to_vec();
        files.push((MARK_FILE, &mark));
        replace_dir(dir, &files)?;
    }
    Ok(())
}

/// Makes `formation-plugin/` of `config` hold the embedded plugin, as a whole, and answers its path (`ensure_plugin`: a child's launch does not write every file again).
pub fn write_plugin(config: &Path) -> Result<PathBuf, String> {
    let dir = plugin_dir(config);
    ensure_plugin(&dir, PLUGIN)?;
    Ok(dir)
}

/// The Figma tools of the plugin's server as a permission rule names them: `mcp__plugin_{plugin}_{server}__{tool}` (the plugin `feature-dev`, the server `figma` of its `.mcp.json`; Claude Code's documentation of permissions, "MCP").
const FIGMA_RULE_PREFIX: &str = "mcp__plugin_feature-dev_figma__";

/// The tools of the Figma server that only read, and that `figma-fetcher` uses: the only ones a child's settings allow.
const FIGMA_READ_TOOLS: [&str; 3] = ["get_metadata", "get_design_context", "get_screenshot"];

/// The tools of the Figma server that write into a file, a library or the account, as Figma's page of its tools lists them ("Write tools"): a child's settings deny them, and `figma-fetcher` lists them in `disallowedTools`. A tool that page adds later is not here, and what is not allowed is left to the classifier of the auto mode.
const FIGMA_WRITE_TOOLS: [&str; 15] = [
    "add_code_connect_map",
    "create_generative_plugin",
    "create_new_file",
    "create_shader",
    "generate_diagram",
    "generate_figma_design",
    "generate_image",
    "generate_vector_illustration",
    "html_to_figma",
    "send_code_to_figma",
    "send_code_connect_mappings",
    "update_generative_plugin",
    "update_shader",
    "upload_assets",
    "use_figma",
];

fn figma_rules(tools: &[&str]) -> Vec<String> {
    tools
        .iter()
        .map(|tool| format!("{FIGMA_RULE_PREFIX}{tool}"))
        .collect()
}

/// The `permissions` of a child's `--settings` (A-41, #1162): the read tools of the Figma server are allowed and its write tools are denied, because the child runs in the auto mode and a write would run with no question to the owner. A deny rule wins over every other.
pub fn figma_permissions() -> serde_json::Value {
    serde_json::json!({
        "allow": figma_rules(&FIGMA_READ_TOOLS),
        "deny": figma_rules(&FIGMA_WRITE_TOOLS),
    })
}

static STAGING: AtomicUsize = AtomicUsize::new(0);

/// Makes `target` a folder that holds exactly `files` and nothing else: the files are written in a folder beside it, which then takes its place, so a file that `files` no longer lists does not stay and a failure leaves the old `target` as it was, with no half-written folder.
/// The folder beside it has a name that starts with a dot and holds the process and a count, so that two writers do not meet in it; it is removed when the write fails.
/// What was at `target` is moved aside by a rename and removed only after the new folder is in its place, so a reader never waits for a removal: `target` is missing for the time between two renames and no longer. The files are not synced one by one: the folder is synced before it is renamed.
/// A link in `target`'s place is moved aside and removed, not followed. When another process has put a folder there first, its folder is kept: both wrote the same files.
pub(crate) fn replace_dir(target: &Path, files: &[(&str, &str)]) -> Result<(), String> {
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(format!("{} を作れません", target.display()));
    };
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("{} を作れません: {e}", parent.display()))?;
    let beside = |kind: &str| {
        parent.join(format!(
            ".{}.{kind}-{}-{}",
            name.to_string_lossy(),
            std::process::id(),
            STAGING.fetch_add(1, Ordering::Relaxed)
        ))
    };
    let (staging, old) = (beside("new"), beside("old"));
    let _ = remove_old(&staging);
    let moved = write_files(&staging, files).and_then(|()| swap(&staging, target, &old));
    let _ = remove_old(&staging);
    let _ = remove_old(&old);
    moved
}

/// Puts the folder `staging` in the place of `target`: what is at `target` goes to `old` first (and comes back when `staging` cannot be placed).
fn swap(staging: &Path, target: &Path, old: &Path) -> Result<(), String> {
    let aside = std::fs::symlink_metadata(target).is_ok()
        && std::fs::rename(target, old)
            .map_err(|e| format!("{} を外せません: {e}", target.display()))
            .map(|()| true)?;
    std::fs::rename(staging, target)
        .or_else(|e| if target.is_dir() { Ok(()) } else { Err(e) })
        .map_err(|e| {
            if aside {
                let _ = std::fs::rename(old, target);
            }
            format!("{} を置けません: {e}", target.display())
        })
}

fn write_files(dir: &Path, files: &[(&str, &str)]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{} を作れません: {e}", dir.display()))?;
    for (relative, text) in files {
        let path = dir.join(relative);
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)
                .map_err(|e| format!("{} を作れません: {e}", folder.display()))?;
        }
        std::fs::write(&path, text).map_err(|e| format!("{} を書けません: {e}", path.display()))?;
    }
    // The entries of the folder reach the disk before the rename that publishes it; a platform that cannot open a folder is left to its own order.
    if let Ok(folder) = std::fs::File::open(dir) {
        let _ = folder.sync_all();
    }
    Ok(())
}

/// Removes what is at `path` (a folder with its contents, a file, or a link, which is not followed). Nothing there is fine.
fn remove_old(path: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    let removed = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    removed.map_err(|e| format!("{} を外せません: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-formation-assets-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_childs_settings_allow_the_figma_read_tools_and_deny_its_write_tools() {
        let permissions = figma_permissions();
        let list = |key: &str| -> Vec<String> {
            permissions[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|rule| rule.as_str().unwrap().to_owned())
                .collect()
        };
        let (allow, deny) = (list("allow"), list("deny"));
        assert_eq!(
            allow,
            [
                "mcp__plugin_feature-dev_figma__get_metadata",
                "mcp__plugin_feature-dev_figma__get_design_context",
                "mcp__plugin_feature-dev_figma__get_screenshot"
            ]
        );
        assert_eq!(deny.len(), FIGMA_WRITE_TOOLS.len());
        assert!(deny.contains(&"mcp__plugin_feature-dev_figma__use_figma".to_owned()));
        // A rule has no parenthesis (Claude Code skips an `mcp__` rule that has one), and no tool is in both lists.
        for rule in allow.iter().chain(&deny) {
            assert!(!rule.contains('(') && !rule.contains('*'), "{rule}");
        }
        assert!(allow.iter().all(|rule| !deny.contains(rule)));
    }

    #[test]
    fn the_rules_name_the_server_of_the_plugin_and_figma_fetcher_lists_the_denied_tools() {
        let file = |name: &str| PLUGIN.iter().find(|(path, _)| *path == name).unwrap().1;
        let plugin: serde_json::Value =
            serde_json::from_str(file(".claude-plugin/plugin.json")).unwrap();
        let mcp: serde_json::Value = serde_json::from_str(file(".mcp.json")).unwrap();
        let servers: Vec<&String> = mcp["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(servers, ["figma"]);
        assert_eq!(
            FIGMA_RULE_PREFIX,
            format!("mcp__plugin_{}_figma__", plugin["name"].as_str().unwrap())
        );
        let fetcher = file("agents/figma-fetcher.md");
        let line = fetcher
            .lines()
            .find(|line| line.starts_with("disallowedTools:"))
            .unwrap();
        let listed: Vec<&str> = line["disallowedTools:".len()..]
            .split(',')
            .map(str::trim)
            .collect();
        for rule in figma_rules(&FIGMA_WRITE_TOOLS) {
            assert!(listed.contains(&rule.as_str()), "{rule}");
        }
    }

    #[test]
    fn the_plugin_is_embedded_with_its_manifest_and_every_path_stays_inside_its_folder() {
        let manifest = PLUGIN
            .iter()
            .find(|(path, _)| *path == ".claude-plugin/plugin.json")
            .expect("plugin.json is embedded");
        let json: serde_json::Value = serde_json::from_str(manifest.1).unwrap();
        assert_eq!(json["name"], "feature-dev");
        assert!(json["description"].as_str().is_some_and(|d| !d.is_empty()));
        for (path, _) in PLUGIN.iter().chain(LEADER_SKILL) {
            assert!(
                !path.is_empty()
                    && !path.starts_with('/')
                    && !path.split('/').any(|part| part.is_empty() || part == ".."),
                "{path}"
            );
        }
        let mut paths: Vec<&str> = PLUGIN.iter().map(|(path, _)| *path).collect();
        let count = paths.len();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), count);
    }

    #[test]
    fn replacing_a_folder_leaves_exactly_the_listed_files() {
        let root = temp_dir("replace");
        let target = root.join("a/b");
        std::fs::create_dir_all(target.join("old")).unwrap();
        std::fs::write(target.join("old/stale.md"), "stale").unwrap();
        std::fs::write(target.join("SKILL.md"), "old").unwrap();
        replace_dir(&target, &[("SKILL.md", "new"), ("references/x/y.md", "y")]).unwrap();
        assert_eq!(entries(&target), ["SKILL.md", "references"]);
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("references/x/y.md")).unwrap(),
            "y"
        );
        // Nothing of the writing stays beside the folder, and the next replacement works the same.
        assert_eq!(entries(&root.join("a")), ["b"]);
        replace_dir(&target, &[("only.md", "1")]).unwrap();
        assert_eq!(entries(&target), ["only.md"]);
        replace_dir(&target, &[]).unwrap();
        assert!(entries(&target).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_write_keeps_the_old_folder_and_leaves_no_half_written_one() {
        let root = temp_dir("replace-fails");
        let target = root.join("skill");
        replace_dir(&target, &[("SKILL.md", "old")]).unwrap();
        // `a` is a file, so `a/b` cannot be written.
        let err = replace_dir(&target, &[("a", "x"), ("a/b", "y")]).unwrap_err();
        assert!(err.contains("を作れません"), "{err}");
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "old"
        );
        assert_eq!(entries(&root), ["skill"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_place_of_the_folder_is_removed_and_not_followed() {
        let root = temp_dir("replace-link");
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("keep.md"), "keep").unwrap();
        let target = root.join("skill");
        std::os::unix::fs::symlink(&elsewhere, &target).unwrap();
        replace_dir(&target, &[("SKILL.md", "new")]).unwrap();
        assert!(!std::fs::symlink_metadata(&target).unwrap().is_symlink());
        assert_eq!(entries(&target), ["SKILL.md"]);
        assert_eq!(entries(&elsewhere), ["keep.md"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_plugin_is_written_as_a_whole_in_the_config_folder() {
        let config = temp_dir("plugin");
        let dir = plugin_dir(&config);
        assert_eq!(dir, config.join("formation-plugin"));
        std::fs::create_dir_all(dir.join("skills/gone")).unwrap();
        std::fs::write(dir.join("skills/gone/SKILL.md"), "old").unwrap();
        assert_eq!(write_plugin(&config).unwrap(), dir);
        assert!(!dir.join("skills/gone").exists());
        for (path, text) in PLUGIN {
            assert_eq!(&std::fs::read_to_string(dir.join(path)).unwrap(), text);
        }
        assert_eq!(
            std::fs::read_to_string(dir.join(MARK_FILE)).unwrap(),
            plugin_mark(PLUGIN)
        );
        assert_eq!(entries(&config), ["formation-plugin"]);
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn a_folder_that_holds_this_plugin_is_not_written_again_and_any_other_is() {
        let config = temp_dir("plugin-again");
        let dir = plugin_dir(&config);
        write_plugin(&config).unwrap();
        // A file that the plugin does not list stays: nothing was replaced.
        std::fs::write(dir.join("marker.txt"), "still here").unwrap();
        assert_eq!(write_plugin(&config).unwrap(), dir);
        assert!(dir.join("marker.txt").exists());
        let (path, text) = PLUGIN
            .iter()
            .find(|(_, text)| !text.is_empty())
            .expect("a plugin file with text");
        // A file that a crash cut short, or left missing, makes the folder be written again.
        std::fs::write(dir.join(path), &text[..text.len() - 1]).unwrap();
        write_plugin(&config).unwrap();
        assert!(!dir.join("marker.txt").exists());
        assert_eq!(&std::fs::read_to_string(dir.join(path)).unwrap(), text);
        std::fs::write(dir.join("marker.txt"), "x").unwrap();
        std::fs::remove_file(dir.join(path)).unwrap();
        write_plugin(&config).unwrap();
        assert!(!dir.join("marker.txt").exists());
        // So does another mark (another plugin), and a folder with none.
        std::fs::write(dir.join("marker.txt"), "x").unwrap();
        std::fs::write(dir.join(MARK_FILE), "another").unwrap();
        write_plugin(&config).unwrap();
        assert!(!dir.join("marker.txt").exists());
        std::fs::write(dir.join("marker.txt"), "x").unwrap();
        std::fs::remove_file(dir.join(MARK_FILE)).unwrap();
        write_plugin(&config).unwrap();
        assert!(!dir.join("marker.txt").exists());
        assert_eq!(entries(&config), ["formation-plugin"]);
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_mark_of_a_plugin_changes_with_any_path_or_text() {
        let base = plugin_mark(&[("a.md", "1"), ("b.md", "2")]);
        assert_eq!(base, plugin_mark(&[("a.md", "1"), ("b.md", "2")]));
        assert_ne!(base, plugin_mark(&[("a.md", "1"), ("b.md", "3")]));
        assert_ne!(base, plugin_mark(&[("a.md", "1"), ("c.md", "2")]));
        assert_ne!(base, plugin_mark(&[("a.md", "12"), ("b.md", "")]));
        assert_ne!(base, plugin_mark(&[("a.md", "1")]));
    }

    #[test]
    fn a_replaced_folder_is_swapped_in_with_the_old_one_removed_only_afterwards() {
        let root = temp_dir("swap");
        let target = root.join("skill");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("SKILL.md"), "old").unwrap();
        let (staging, old) = (root.join(".new"), root.join(".old"));
        write_files(&staging, &[("SKILL.md", "new")]).unwrap();
        swap(&staging, &target, &old).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "new"
        );
        // What was there is beside it until it is removed, whole.
        assert_eq!(
            std::fs::read_to_string(old.join("SKILL.md")).unwrap(),
            "old"
        );
        assert!(!staging.exists());
        // A staging folder that cannot be placed gives the old folder back.
        let missing = root.join(".missing");
        let again_old = root.join(".old2");
        std::fs::remove_dir_all(&target).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("SKILL.md"), "kept").unwrap();
        assert!(swap(&missing, &target, &again_old).is_err());
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "kept"
        );
        assert!(!again_old.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
