//! A-34: what the definition pane of the file pane draws of the server's answer, decided from texts alone: the name under the mouse in the editor, and the place of each definition (its file, its line, and where it is: the folder in the worktree, or the gem and the folder in it).
//! Both are pure functions. Nothing is read from a disk or asked of the server.

use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

/// The place a definition is, as it is drawn: `file` and `line` (from 1) in the first line, `place` under it, and `outside` for a file the worktree does not hold (the mark "gem").
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct LspPlace {
    pub file: String,
    pub line: u32,
    pub place: String,
    pub outside: bool,
}

/// What `place_of` needs of a definition (an `LspLocation` has more, and it is sent as it is).
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspPlaceOf {
    pub path: String,
    pub outside: bool,
    pub line: u32,
}

/// The mark of the folder of the worktree itself.
const ROOT: &str = ".";
/// The longest run of `@` before a Ruby name (`@@count`).
const MAX_AT: usize = 2;
/// The length of a commit's id as a version.
const SHORT_SHA: usize = 7;

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The index in `chars` of the character that holds the UTF-16 unit `character`, none at or after the end of the line.
fn char_index(chars: &[char], character: usize) -> Option<usize> {
    let mut units = 0;
    for (i, c) in chars.iter().enumerate() {
        let next = units + c.len_utf16();
        if character < next {
            return Some(i);
        }
        units = next;
    }
    None
}

/// The Ruby name of the character at the UTF-16 unit `character` of the text of one line: letters, digits and `_` (`@`, `@@` or `$` before them, one `?` or `!` after them, as in `empty?`), none when that character is part of no name. A `!` before `=` is the operator `!=` and not part of a name.
pub fn word_at(line: &str, character: usize) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut at = char_index(&chars, character)?;
    let ends_name = |i: usize| {
        i > 0
            && is_word(chars[i - 1])
            && matches!(chars[i], '?' | '!')
            && chars.get(i + 1) != Some(&'=')
    };
    match chars[at] {
        '?' | '!' if ends_name(at) => at -= 1,
        '@' | '$' => {
            while matches!(chars.get(at), Some('@' | '$')) {
                at += 1;
            }
        }
        _ => {}
    }
    if !chars.get(at).copied().is_some_and(is_word) {
        return None;
    }
    let mut start = at;
    while start > 0 && is_word(chars[start - 1]) {
        start -= 1;
    }
    let mut end = at + 1;
    while end < chars.len() && is_word(chars[end]) {
        end += 1;
    }
    if end < chars.len() && ends_name(end) {
        end += 1;
    }
    if start > 0 && chars[start - 1] == '$' {
        start -= 1;
    } else {
        let mut ats = 0;
        while start > 0 && chars[start - 1] == '@' && ats < MAX_AT {
            start -= 1;
            ats += 1;
        }
    }
    Some(chars[start..end].iter().collect())
}

/// Whether `text` is the version of a gem: dot separated parts that are letters and digits, the first only digits, and, after a `-`, the platform (`1.16.0-x86_64-linux`).
fn is_version(text: &str) -> bool {
    let head = text.split('-').next().unwrap_or("");
    let mut parts = head.split('.');
    let first = parts.next().unwrap_or("");
    !first.is_empty()
        && first.chars().all(|c| c.is_ascii_digit())
        && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// The name and the version of a folder of an installed gem, `rack-test-2.1.0` (the first `-` after which a version begins, so that a name with a `-` keeps it).
fn gem_dir(dir: &str) -> Option<(&str, &str)> {
    dir.match_indices('-').find_map(|(i, _)| {
        let (name, version) = (&dir[..i], &dir[i + 1..]);
        (!name.is_empty() && is_version(version)).then_some((name, version))
    })
}

/// The name and the short commit of a gem that Bundler checked out of git: `bundler/gems/{name}-{commit}`.
fn git_gem_dir(dir: &str) -> Option<(&str, String)> {
    let (name, commit) = dir.rsplit_once('-')?;
    let ok = !name.is_empty()
        && commit.len() >= SHORT_SHA
        && commit.chars().all(|c| c.is_ascii_hexdigit());
    ok.then(|| (name, commit.chars().take(SHORT_SHA).collect()))
}

/// The gem a file of the server's side belongs to and the folder in it: the folder after the first `gems` that names an installed gem (`.../gems/railties-8.1.4.1/lib/rails.rb`), or a gem Bundler checked out of git (`.../bundler/gems/{name}-{commit}/...`). The text is `{name} {version}`, then ` / {folder}` when the file is not at the gem's top.
fn gem_place(segments: &[&str]) -> Option<String> {
    // The last segment is the file; a gem folder is before it.
    let folders = &segments[..segments.len().saturating_sub(1)];
    for (i, folder) in folders.iter().enumerate() {
        if *folder != "gems" || i + 1 >= folders.len() {
            continue;
        }
        let git = i > 0 && folders[i - 1] == "bundler";
        let found = if git {
            git_gem_dir(folders[i + 1]).map(|(n, v)| (n.to_owned(), v))
        } else {
            gem_dir(folders[i + 1]).map(|(n, v)| (n.to_owned(), v.to_owned()))
        };
        if let Some((name, version)) = found {
            let inside = folders[i + 2..].join("/");
            return Some(if inside.is_empty() {
                format!("{name} {version}")
            } else {
                format!("{name} {version} / {inside}")
            });
        }
    }
    None
}

/// How a definition is drawn. A file in the worktree: its name and line, and its folder from the worktree. A file outside it: the gem and the folder in the gem, or, when the path names no gem (the standard library, for one), the folder as the server has it.
pub fn place_of(of: &LspPlaceOf) -> LspPlace {
    let segments: Vec<&str> = of.path.split('/').filter(|s| !s.is_empty()).collect();
    let file = segments.last().copied().unwrap_or("").to_owned();
    let folder = |parts: &[&str]| parts.join("/");
    let place = if of.outside {
        gem_place(&segments).unwrap_or_else(|| {
            let parent = folder(&segments[..segments.len().saturating_sub(1)]);
            format!("/{parent}")
        })
    } else {
        let parent = folder(&segments[..segments.len().saturating_sub(1)]);
        if parent.is_empty() {
            ROOT.to_owned()
        } else {
            parent
        }
    };
    LspPlace {
        file,
        line: of.line + 1,
        place,
        outside: of.outside,
    }
}

/// The Ruby name at the UTF-16 unit `character` of the text of one line of the editor (A-34), none where there is no name.
#[tauri::command]
pub async fn lsp_word(line: String, character: u32) -> Result<Option<String>, String> {
    Ok(word_at(&line, character as usize))
}

/// How each definition is drawn in the definition pane (A-34): it reads and asks for nothing.
#[tauri::command]
pub async fn lsp_places(locations: Vec<LspPlaceOf>) -> Result<Vec<LspPlace>, String> {
    Ok(locations.iter().map(place_of).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(line: &str, character: usize) -> Option<String> {
        word_at(line, character)
    }

    fn place(path: &str, outside: bool, line: u32) -> LspPlace {
        place_of(&LspPlaceOf {
            path: path.into(),
            outside,
            line,
        })
    }

    #[test]
    fn a_name_is_taken_from_any_of_its_characters() {
        let line = "  Rails.logger.info(x)";
        for character in 2..7 {
            assert_eq!(at(line, character), Some("Rails".into()));
        }
        assert_eq!(at(line, 8), Some("logger".into()));
        assert_eq!(at(line, 13), Some("logger".into()));
        assert_eq!(at(line, 14), None);
        assert_eq!(at(line, 15), Some("info".into()));
    }

    #[test]
    fn the_character_between_names_and_past_the_end_have_none() {
        let line = "a.b (c)";
        assert_eq!(at(line, 1), None);
        assert_eq!(at(line, 3), None);
        assert_eq!(at(line, 4), None);
        assert_eq!(at(line, 7), None);
        assert_eq!(at(line, 100), None);
        assert_eq!(at("", 0), None);
    }

    #[test]
    fn a_constant_path_gives_the_part_under_the_mouse() {
        let line = "Foo::Bar.baz";
        assert_eq!(at(line, 1), Some("Foo".into()));
        assert_eq!(at(line, 3), None);
        assert_eq!(at(line, 6), Some("Bar".into()));
    }

    #[test]
    fn a_name_keeps_its_sign_and_its_question_or_bang() {
        assert_eq!(at("@name = 1", 0), Some("@name".into()));
        assert_eq!(at("@name = 1", 3), Some("@name".into()));
        assert_eq!(at("@@count += 1", 1), Some("@@count".into()));
        assert_eq!(at("$stdout.puts", 5), Some("$stdout".into()));
        assert_eq!(at("list.empty? && ok", 8), Some("empty?".into()));
        assert_eq!(at("list.empty? && ok", 10), Some("empty?".into()));
        assert_eq!(at("list.save! if ok", 9), Some("save!".into()));
    }

    #[test]
    fn a_bang_before_an_equal_sign_is_the_operator() {
        assert_eq!(at("a!= b", 0), Some("a".into()));
        assert_eq!(at("a!= b", 1), None);
        assert_eq!(at("a != b", 2), None);
        assert_eq!(at("a ! b", 2), None);
        assert_eq!(at("?a", 0), None);
    }

    #[test]
    fn a_sign_alone_has_no_name() {
        assert_eq!(at("@ x", 0), None);
        assert_eq!(at("$ x", 0), None);
    }

    #[test]
    fn the_position_counts_utf16_units() {
        // "😀" is two UTF-16 units and one character; the name starts after it and a space.
        let line = "😀 name";
        assert_eq!(at(line, 0), None);
        assert_eq!(at(line, 1), None);
        assert_eq!(at(line, 3), Some("name".into()));
        assert_eq!(at(line, 6), Some("name".into()));
        assert_eq!(at(line, 7), None);
    }

    #[test]
    fn letters_that_are_not_ascii_are_part_of_a_name() {
        assert_eq!(at("x = 名前", 5), Some("名前".into()));
    }

    #[test]
    fn a_file_of_the_worktree_has_its_folder_from_the_worktree() {
        assert_eq!(
            place("app/lib/rails_ext.rb", false, 0),
            LspPlace {
                file: "rails_ext.rb".into(),
                line: 1,
                place: "app/lib".into(),
                outside: false
            }
        );
        let root = place("Rakefile", false, 9);
        assert_eq!(
            (root.file.as_str(), root.line, root.place.as_str()),
            ("Rakefile", 10, ".")
        );
    }

    #[test]
    fn a_file_of_a_gem_has_the_gem_its_version_and_the_folder_in_it() {
        let rails = place(
            "/usr/local/bundle/ruby/3.3.0/gems/railties-8.1.4.1/lib/rails.rb",
            true,
            18,
        );
        assert_eq!(
            rails,
            LspPlace {
                file: "rails.rb".into(),
                line: 19,
                place: "railties 8.1.4.1 / lib".into(),
                outside: true
            }
        );
        let deep = place(
            "/usr/local/bundle/gems/actioncable-8.1.4.1/lib/rails/generators/channel/channel_generator.rb",
            true,
            2,
        );
        assert_eq!(
            deep.place,
            "actioncable 8.1.4.1 / lib/rails/generators/channel"
        );
        assert_eq!(deep.line, 3);
    }

    #[test]
    fn a_file_at_the_top_of_a_gem_has_no_folder() {
        let top = place("/bundle/gems/rake-13.2.1/Rakefile", true, 0);
        assert_eq!(top.place, "rake 13.2.1");
    }

    #[test]
    fn a_gem_name_with_a_dash_or_a_digit_keeps_it() {
        assert_eq!(
            place("/g/gems/rack-test-2.1.0/lib/a.rb", true, 0).place,
            "rack-test 2.1.0 / lib"
        );
        assert_eq!(
            place("/g/gems/oauth2-2.0.9/lib/a.rb", true, 0).place,
            "oauth2 2.0.9 / lib"
        );
        assert_eq!(
            place("/g/gems/ruby-2d-1.0.0/lib/a.rb", true, 0).place,
            "ruby-2d 1.0.0 / lib"
        );
    }

    #[test]
    fn the_platform_and_a_prerelease_are_part_of_the_version() {
        assert_eq!(
            place("/g/gems/nokogiri-1.16.0-x86_64-linux/lib/a.rb", true, 0).place,
            "nokogiri 1.16.0-x86_64-linux / lib"
        );
        assert_eq!(
            place("/g/gems/foo-1.0.0.pre1/lib/a.rb", true, 0).place,
            "foo 1.0.0.pre1 / lib"
        );
    }

    #[test]
    fn a_gem_that_bundler_checked_out_of_git_has_its_short_commit() {
        assert_eq!(
            place(
                "/bundle/ruby/3.3.0/bundler/gems/my_gem-0123456789ab/lib/my_gem.rb",
                true,
                0
            )
            .place,
            "my_gem 0123456 / lib"
        );
    }

    #[test]
    fn a_path_that_names_no_gem_has_the_folder_as_the_server_has_it() {
        let stdlib = place("/usr/local/lib/ruby/3.3.0/forwardable.rb", true, 4);
        assert_eq!(stdlib.place, "/usr/local/lib/ruby/3.3.0");
        assert!(stdlib.outside);
        // A `gems` folder with no version after it, or at the end, is not a gem.
        assert_eq!(
            place("/x/gems/not_versioned/a.rb", true, 0).place,
            "/x/gems/not_versioned"
        );
        assert_eq!(place("/x/gems", true, 0).place, "/x");
        assert_eq!(place("/a.rb", true, 0).place, "/");
    }

    #[test]
    fn the_command_answers_one_place_for_each_location_in_order() {
        let both = [
            LspPlaceOf {
                path: "a/b.rb".into(),
                outside: false,
                line: 1,
            },
            LspPlaceOf {
                path: "/g/gems/x-1.0/lib/y.rb".into(),
                outside: true,
                line: 2,
            },
        ];
        let places: Vec<LspPlace> = both.iter().map(place_of).collect();
        assert_eq!(places[0].file, "b.rb");
        assert_eq!(places[1].place, "x 1.0 / lib");
    }
}
