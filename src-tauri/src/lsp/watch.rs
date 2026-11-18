//! A-34: telling a language server which files of its languages changed in the worktree on the disk, as pure functions.
//!
//! A server such as ruby-lsp indexes the worktree once, when it starts, and then follows only what the client tells it (`workspace/didChangeWatchedFiles`): it registers no watcher of its own. So before each question the app lists, by one command run in the worktree by the route of the server (`command`), the files that changed since the last look and all the files there are now, of the extensions of the languages the server takes (`orca_language::extensions_of`), and tells the server the difference (`changes`, `message`). The command prints no more than the folders that hold the project's own code: `.git`, `node_modules`, `vendor/bundle`, `tmp`, `log` and `.claude/worktrees` (the worktrees of the children of a formation are made there, A-37) are not looked into. Nothing is written in the worktree, and `-mmin`, `-path` and `-prune` are what GNU, BSD and BusyBox `find` all have.

use std::{collections::HashSet, time::Duration};

use serde_json::{json, Value};

use super::{
    protocol::{notification, server_path, uri_of},
    shell_quote,
};

/// The most bytes of the listing that are kept.
pub(crate) const LIMIT: usize = 4 * 1024 * 1024;
/// The most files one notice tells of.
const MAX_CHANGES: usize = 2000;
/// The longest path of a file that is taken.
const MAX_PATH: usize = 4096;
/// The line between the changed files and all the files, and the last line of a listing that ended well.
const SPLIT: &str = "--";
const END: &str = "--end";
/// The folders that are not looked into, and what is looked at in the others: files.
const SKIP: &str = r"\( -name .git -o -name node_modules -o -path ./vendor/bundle -o -path ./tmp -o -path ./log -o -path ./.claude/worktrees \) -prune -o -type f";

/// How a file changed, as the numbers of LSP's `FileChangeType`.
const CREATED: u8 = 1;
const CHANGED: u8 = 2;
const DELETED: u8 = 3;

/// A file of the worktree that changed: its path from the worktree and how.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Change {
    pub path: String,
    pub kind: u8,
}

/// What the command printed: the files that changed lately, and all the files (`None` when the listing was cut or failed, so it says nothing of what is gone).
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Listing {
    pub recent: Vec<String>,
    pub all: Option<Vec<String>>,
}

/// The minutes to look back: those since the last look, rounded up, and one more, so that a clock a little off or a look that took a while loses nothing. Telling a file twice does no harm.
pub(crate) fn minutes_since(elapsed: Duration) -> u64 {
    elapsed.as_secs().div_ceil(60) + 1
}

/// The command, run in the worktree, that prints the files of the extensions `extensions` (each with its dot, as `orca_language::extensions_of` gives them) modified in the last `minutes` minutes, the line `--`, all the files of them, and the line `--end` when the second listing ended well. It is one script: `cd` failing runs none of it, and a `find` that failed somewhere prints no end. With no extension there is nothing to look at, and no command.
pub(crate) fn command(minutes: u64, extensions: &[String]) -> Option<String> {
    if extensions.is_empty() {
        return None;
    }
    let names: Vec<String> = extensions
        .iter()
        .map(|extension| format!("-name {}", shell_quote(&format!("*{extension}"))))
        .collect();
    let find = format!("{SKIP} \\( {} \\)", names.join(" -o "));
    Some(format!(
        "{{ find . {find} -mmin -{minutes} -print 2>/dev/null; echo {SPLIT}; find . {find} -print 2>/dev/null && echo {END}; }}"
    ))
}

/// A line of the listing as a path from the worktree: `./` is taken off, and a line that is not a path of a file (empty, with a control character, too long) is none.
fn path_of(line: &str) -> Option<String> {
    let path = line.strip_prefix("./")?;
    let ok =
        !path.is_empty() && path.chars().count() <= MAX_PATH && !path.chars().any(char::is_control);
    ok.then(|| path.to_owned())
}

/// Whether the script ran: the line between the two listings is there. A `cd` that failed, or an ssh that did not connect, prints none, and then the output says nothing about the files; a `find` that failed somewhere prints it all the same, and its listing is used as far as it goes (`parse`).
pub(crate) fn started(output: &str) -> bool {
    let whole = output.rfind('\n').map_or("", |at| &output[..=at]);
    whole.lines().any(|line| line == SPLIT)
}

/// The listing from what the command printed. A last line that was cut is dropped, and `all` is there only when the end line is.
pub(crate) fn parse(output: &str) -> Listing {
    let whole = output.rfind('\n').map_or("", |at| &output[..=at]);
    let mut listing = Listing::default();
    let mut all: Vec<String> = Vec::new();
    let mut after_split = false;
    for line in whole.lines() {
        match line {
            SPLIT if !after_split => after_split = true,
            END if after_split => {
                listing.all = Some(all);
                return listing;
            }
            _ => {
                if let Some(path) = path_of(line) {
                    if after_split {
                        all.push(path);
                    } else {
                        listing.recent.push(path);
                    }
                }
            }
        }
    }
    listing
}

/// What the server is to be told: each recent file (a new one as created, when the full list says it is new; else as changed), each file of the full list that was not known (created), and each known file that is gone (deleted). `known` is the full list of the last look (`None` before the first: the server indexed everything when it started, so a recent file is a change). At most `MAX_CHANGES`.
pub(crate) fn changes(listing: &Listing, known: Option<&HashSet<String>>) -> Vec<Change> {
    let mut found: Vec<Change> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |path: &str, kind: u8| {
        if seen.insert(path.to_owned()) {
            found.push(Change {
                path: path.to_owned(),
                kind,
            });
        }
    };
    let new = |path: &String| known.is_some_and(|k| !k.contains(path)) && listing.all.is_some();
    for path in &listing.recent {
        add(path, if new(path) { CREATED } else { CHANGED });
    }
    if let (Some(known), Some(all)) = (known, &listing.all) {
        for path in all.iter().filter(|p| !known.contains(*p)) {
            add(path, CREATED);
        }
        let now: HashSet<&String> = all.iter().collect();
        let mut gone: Vec<&String> = known.iter().filter(|p| !now.contains(p)).collect();
        gone.sort();
        for path in gone {
            add(path, DELETED);
        }
    }
    found.truncate(MAX_CHANGES);
    found
}

/// The notice `workspace/didChangeWatchedFiles` for `changes`, the paths being those the server has below `mount`; none when no path makes a URI.
pub(crate) fn message(mount: &str, changes: &[Change]) -> Option<Value> {
    let listed: Vec<Value> = changes
        .iter()
        .filter_map(|change| {
            let path = server_path(mount, &change.path).ok()?;
            Some(json!({"uri": uri_of(&path), "type": change.kind}))
        })
        .collect();
    (!listed.is_empty()).then(|| {
        notification(
            "workspace/didChangeWatchedFiles",
            json!({"changes": listed}),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| (*p).to_owned()).collect()
    }

    fn listing(recent: &[&str], all: Option<&[&str]>) -> Listing {
        Listing {
            recent: recent.iter().map(|p| (*p).to_owned()).collect(),
            all: all.map(|a| a.iter().map(|p| (*p).to_owned()).collect()),
        }
    }

    fn change(path: &str, kind: u8) -> Change {
        Change {
            path: path.into(),
            kind,
        }
    }

    // ---- the command ----

    #[test]
    fn the_minutes_are_those_since_the_last_look_rounded_up_and_one_more() {
        assert_eq!(minutes_since(Duration::from_secs(0)), 1);
        assert_eq!(minutes_since(Duration::from_secs(1)), 2);
        assert_eq!(minutes_since(Duration::from_secs(60)), 2);
        assert_eq!(minutes_since(Duration::from_secs(61)), 3);
        assert_eq!(minutes_since(Duration::from_secs(3600)), 61);
    }

    #[test]
    fn the_command_lists_the_recent_files_then_all_of_them_and_skips_the_big_folders() {
        let command = command(5, &[".rb".to_owned()]).unwrap();
        assert!(command.starts_with("{ find . "), "{command}");
        assert!(command.ends_with("; }"), "{command}");
        assert!(command.contains("-mmin -5 -print"), "{command}");
        assert!(command.contains("echo --;"), "{command}");
        assert!(command.contains("&& echo --end"), "{command}");
        assert_eq!(command.matches("-name '*.rb'").count(), 2);
        for skipped in [
            "-name .git",
            "-name node_modules",
            "-path ./vendor/bundle",
            "-path ./tmp",
            "-path ./log",
            "-path ./.claude/worktrees",
        ] {
            assert_eq!(command.matches(skipped).count(), 2, "{skipped}");
        }
    }

    #[test]
    fn the_command_looks_for_every_extension_of_the_server_and_for_nothing_else() {
        let command = command(5, &[".ts".to_owned(), ".tsx".to_owned()]).unwrap();
        for name in ["-name '*.ts'", "-name '*.tsx'"] {
            assert_eq!(command.matches(name).count(), 2, "{name}");
        }
        assert!(!command.contains("*.rb"), "{command}");
        assert_eq!(
            command
                .matches(r"-type f \( -name '*.ts' -o -name '*.tsx' \) ")
                .count(),
            2,
            "{command}"
        );
    }

    #[test]
    fn an_extension_is_one_quoted_word_and_no_extension_is_no_command() {
        let command = command(1, &[".a b;c".to_owned()]).unwrap();
        assert!(command.contains("-name '*.a b;c'"), "{command}");
        assert_eq!(super::command(1, &[]), None);
    }

    // ---- what it printed ----

    #[test]
    fn the_script_has_run_when_the_line_between_the_listings_is_there() {
        assert!(started("--\n"));
        assert!(started("./a.rb\n--\n./a.rb\n"));
        // Nothing printed (a `cd` or ssh that failed), or a line cut before its end.
        assert!(!started(""));
        assert!(!started("./a.rb\n"));
        assert!(!started("./a.rb\n--"));
    }

    #[test]
    fn the_listing_is_the_recent_files_and_all_of_them() {
        let out = "./a.rb\n./app/b.rb\n--\n./a.rb\n./app/b.rb\n./app/c.rb\n--end\n";
        assert_eq!(
            parse(out),
            listing(
                &["a.rb", "app/b.rb"],
                Some(&["a.rb", "app/b.rb", "app/c.rb"])
            )
        );
        assert_eq!(parse("--\n--end\n"), listing(&[], Some(&[])));
    }

    #[test]
    fn a_listing_with_no_end_has_no_list_of_all_the_files() {
        // The second `find` failed, or the output was cut.
        assert_eq!(
            parse("./a.rb\n--\n./a.rb\n./b.rb\n"),
            listing(&["a.rb"], None)
        );
        assert_eq!(parse(""), listing(&[], None));
        // The end line before the split is no end.
        assert_eq!(parse("--end\n./a.rb\n"), listing(&["a.rb"], None));
    }

    #[test]
    fn a_last_line_that_was_cut_is_dropped() {
        assert_eq!(
            parse("./a.rb\n./b"),
            listing(&["a.rb"], None),
            "cut in the recent files"
        );
        assert_eq!(
            parse("./a.rb\n--\n./a.rb\n--en"),
            listing(&["a.rb"], None),
            "cut in the end line"
        );
    }

    #[test]
    fn a_line_that_is_no_path_of_a_file_is_left_out() {
        let long = format!("./{}", "a".repeat(MAX_PATH + 1));
        let out = format!("a.rb\n./\n./a\tb.rb\n{long}\n./ok.rb\n--\n./ok.rb\n--end\n");
        assert_eq!(parse(&out), listing(&["ok.rb"], Some(&["ok.rb"])));
    }

    // ---- what the server is told ----

    #[test]
    fn before_the_first_look_a_recent_file_is_a_change_and_nothing_is_gone() {
        let l = listing(&["a.rb"], Some(&["a.rb", "b.rb"]));
        assert_eq!(changes(&l, None), vec![change("a.rb", CHANGED)]);
    }

    #[test]
    fn a_recent_file_that_is_known_is_changed_and_one_that_is_not_is_created() {
        let known = set(&["a.rb", "b.rb"]);
        let l = listing(&["a.rb", "n.rb"], Some(&["a.rb", "b.rb", "n.rb"]));
        assert_eq!(
            changes(&l, Some(&known)),
            vec![change("a.rb", CHANGED), change("n.rb", CREATED)]
        );
    }

    #[test]
    fn a_file_that_is_new_with_an_old_time_is_created_and_a_file_that_is_gone_is_deleted() {
        let known = set(&["a.rb", "z.rb", "y.rb"]);
        // `moved.rb` kept its time, so it is not among the recent ones.
        let l = listing(&[], Some(&["a.rb", "moved.rb"]));
        assert_eq!(
            changes(&l, Some(&known)),
            vec![
                change("moved.rb", CREATED),
                change("y.rb", DELETED),
                change("z.rb", DELETED)
            ]
        );
    }

    #[test]
    fn with_no_list_of_all_the_files_nothing_is_created_by_guess_and_nothing_is_deleted() {
        let known = set(&["a.rb", "b.rb"]);
        let l = listing(&["a.rb", "n.rb"], None);
        assert_eq!(
            changes(&l, Some(&known)),
            vec![change("a.rb", CHANGED), change("n.rb", CHANGED)]
        );
    }

    #[test]
    fn nothing_changed_is_nothing_to_tell() {
        let known = set(&["a.rb"]);
        assert_eq!(
            changes(&listing(&[], Some(&["a.rb"])), Some(&known)),
            vec![]
        );
    }

    #[test]
    fn a_file_is_told_once_and_at_most_the_limit() {
        let known = set(&["a.rb"]);
        let l = listing(&["a.rb", "a.rb", "n.rb"], Some(&["a.rb", "n.rb"]));
        assert_eq!(
            changes(&l, Some(&known)),
            vec![change("a.rb", CHANGED), change("n.rb", CREATED)]
        );
        let many: Vec<String> = (0..MAX_CHANGES + 10).map(|i| format!("f{i}.rb")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(changes(&listing(&refs, None), None).len(), MAX_CHANGES);
    }

    #[test]
    fn the_notice_has_the_uri_below_the_mount_and_the_number_of_each_change() {
        let message = message(
            "/app",
            &[change("app/a b.rb", CHANGED), change("c.rb", DELETED)],
        )
        .unwrap();
        assert_eq!(
            message,
            json!({"jsonrpc": "2.0", "method": "workspace/didChangeWatchedFiles", "params": {"changes": [
                {"uri": "file:///app/app/a%20b.rb", "type": 2},
                {"uri": "file:///app/c.rb", "type": 3},
            ]}})
        );
    }

    #[test]
    fn a_path_that_makes_no_uri_is_left_out_and_no_path_is_no_notice() {
        let message = message(
            "/app",
            &[change("../x.rb", CHANGED), change("ok.rb", CREATED)],
        );
        assert_eq!(
            message.unwrap()["params"]["changes"],
            json!([{"uri": "file:///app/ok.rb", "type": 1}])
        );
        assert_eq!(super::message("/app", &[change("a//b.rb", CHANGED)]), None);
        assert_eq!(super::message("/app", &[]), None);
    }
}
