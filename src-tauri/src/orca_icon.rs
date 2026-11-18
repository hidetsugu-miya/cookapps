//! The icon of a file in the file pane of the Orca screen (A-18): the name of one of the SVG files of JetBrains' New UI in `src/vendor/jetbrains-icons/` (the source, the commit and the license are in the `NOTICE` and `LICENSE` there), or none, for which the screen keeps its own line drawing.
//!
//! The icon is decided by the name of the file alone, in this order, and the first that gives one wins:
//! 1. the whole name (`.gitignore`);
//! 2. the extension in lower case, for the kinds that A-21 gives no language (`.toml`, images, archives, fonts);
//! 3. the language that `detect_language` (A-21) gives the name, so the file pane and the editor agree on what a file is (`Gemfile` and `.rb` are `ruby`).
//!
//! The text of a file is not read, so a file with no extension and a `#!` line has the icon of its name, which is none.

use crate::orca_language::detect_language;

/// The names of the icons that `src/vendor/jetbrains-icons/` holds (the file name without `.svg`), sorted.
#[cfg(test)]
const ICONS: &[&str] = &[
    "Csharp",
    "archive",
    "c",
    "config",
    "cpp",
    "css",
    "csv",
    "docker",
    "editorConfig",
    "font",
    "gitignore",
    "go",
    "graphql",
    "groovy",
    "html",
    "image",
    "java",
    "javaScript",
    "jenkins",
    "json",
    "jupyter",
    "kotlin",
    "markdown",
    "patch",
    "perl",
    "php",
    "properties",
    "python",
    "rst",
    "ruby",
    "rust",
    "scala",
    "shell",
    "sql",
    "swiftLang",
    "terraform",
    "toml",
    "typeScript",
    "vue",
    "xml",
    "yaml",
];

/// Whole names that have an icon of their own (the names are as Orca's editor takes them: `FILENAME_TO_LANGUAGE` of A-21, and `.gitignore` is `ini` there).
const FILENAME_TO_ICON: &[(&str, &str)] = &[
    (".gitignore", "gitignore"),
    (".editorconfig", "editorConfig"),
    ("Jenkinsfile", "jenkins"),
];

/// Extensions (no dot, lower case) of the kinds that have no language in A-21, or whose icon is more exact than their language's.
const EXTENSION_TO_ICON: &[(&str, &str)] = &[
    ("toml", "toml"),
    ("properties", "properties"),
    ("patch", "patch"),
    ("diff", "patch"),
    ("png", "image"),
    ("jpg", "image"),
    ("jpeg", "image"),
    ("gif", "image"),
    ("webp", "image"),
    ("bmp", "image"),
    ("ico", "image"),
    ("zip", "archive"),
    ("tar", "archive"),
    ("gz", "archive"),
    ("tgz", "archive"),
    ("bz2", "archive"),
    ("xz", "archive"),
    ("7z", "archive"),
    ("ttf", "font"),
    ("otf", "font"),
    ("woff", "font"),
    ("woff2", "font"),
];

/// The names of the languages of A-21 (`detect_language`) that have an icon.
const LANGUAGE_TO_ICON: &[(&str, &str)] = &[
    ("ruby", "ruby"),
    ("python", "python"),
    ("go", "go"),
    ("rust", "rust"),
    ("kotlin", "kotlin"),
    ("scala", "scala"),
    ("php", "php"),
    ("typescript", "typeScript"),
    ("javascript", "javaScript"),
    ("json", "json"),
    ("jsonl", "json"),
    ("markdown", "markdown"),
    ("mdx", "markdown"),
    ("css", "css"),
    ("scss", "css"),
    ("less", "css"),
    ("html", "html"),
    ("xml", "xml"),
    ("yaml", "yaml"),
    ("sql", "sql"),
    ("mysql", "sql"),
    ("pgsql", "sql"),
    ("redshift", "sql"),
    ("shell", "shell"),
    ("java", "java"),
    ("c", "c"),
    ("cpp", "cpp"),
    ("csharp", "Csharp"),
    ("swift", "swiftLang"),
    ("groovy", "groovy"),
    ("graphql", "graphql"),
    ("dockerfile", "docker"),
    ("ini", "config"),
    ("dotenv", "config"),
    ("hcl", "terraform"),
    ("vue", "vue"),
    ("csv", "csv"),
    ("tsv", "csv"),
    ("notebook", "jupyter"),
    ("perl", "perl"),
    ("restructuredtext", "rst"),
];

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, icon)| *icon)
}

/// The icon of the file called `name` (the last part of its path), or none.
pub fn file_icon(name: &str) -> Option<&'static str> {
    if let Some(icon) = lookup(FILENAME_TO_ICON, name) {
        return Some(icon);
    }
    if let Some((_, extension)) = name.rsplit_once('.') {
        if let Some(icon) = lookup(EXTENSION_TO_ICON, &extension.to_lowercase()) {
            return Some(icon);
        }
    }
    lookup(LANGUAGE_TO_ICON, detect_language(name, ""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, path::PathBuf};

    fn icon_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/vendor/jetbrains-icons")
    }

    #[test]
    fn a_ruby_file_has_the_ruby_icon() {
        for name in ["user.rb", "Gemfile", "Rakefile", "USER.RB", "task.rake"] {
            assert_eq!(file_icon(name), Some("ruby"), "{name}");
        }
    }

    #[test]
    fn a_language_gives_its_icon() {
        let cases = [
            ("a.py", "python"),
            ("main.go", "go"),
            ("lib.rs", "rust"),
            ("a.ts", "typeScript"),
            ("a.tsx", "typeScript"),
            ("a.js", "javaScript"),
            ("a.json", "json"),
            ("README.md", "markdown"),
            ("a.css", "css"),
            ("a.scss", "css"),
            ("a.html", "html"),
            ("a.yml", "yaml"),
            ("a.sql", "sql"),
            ("run.sh", "shell"),
            (".zshrc", "shell"),
            ("A.java", "java"),
            ("a.c", "c"),
            ("a.cpp", "cpp"),
            ("a.cs", "Csharp"),
            ("a.swift", "swiftLang"),
            ("Dockerfile", "docker"),
            ("a.vue", "vue"),
            ("a.csv", "csv"),
            ("a.ipynb", "jupyter"),
            ("a.pl", "perl"),
            ("a.rst", "rst"),
            ("a.php", "php"),
            ("a.kt", "kotlin"),
            ("a.scala", "scala"),
            ("a.graphql", "graphql"),
            ("a.groovy", "groovy"),
            ("main.hcl", "terraform"),
            (".env", "config"),
            ("a.ini", "config"),
        ];
        for (name, icon) in cases {
            assert_eq!(file_icon(name), Some(icon), "{name}");
        }
    }

    #[test]
    fn a_file_name_gives_its_icon_before_its_language() {
        assert_eq!(file_icon(".gitignore"), Some("gitignore"));
        assert_eq!(file_icon(".editorconfig"), Some("editorConfig"));
        assert_eq!(file_icon("Jenkinsfile"), Some("jenkins"));
        assert_eq!(file_icon(".gitattributes"), Some("config"));
    }

    #[test]
    fn a_kind_with_no_language_gives_its_icon_by_the_extension() {
        let cases = [
            ("Cargo.toml", "toml"),
            ("app.properties", "properties"),
            ("a.patch", "patch"),
            ("a.diff", "patch"),
            ("a.png", "image"),
            ("PHOTO.JPG", "image"),
            ("a.zip", "archive"),
            ("a.tar.gz", "archive"),
            ("a.woff2", "font"),
        ];
        for (name, icon) in cases {
            assert_eq!(file_icon(name), Some(icon), "{name}");
        }
    }

    #[test]
    fn a_kind_the_table_lacks_has_no_icon() {
        for name in [
            "notes.txt",
            "LICENSE",
            "Makefile",
            "a.lock",
            "Gemfile.lock",
            "no-extension",
            "",
        ] {
            assert_eq!(file_icon(name), None, "{name}");
        }
    }

    #[test]
    fn every_icon_of_the_tables_is_one_the_folder_holds_and_the_folder_holds_no_other() {
        let tables = FILENAME_TO_ICON
            .iter()
            .chain(EXTENSION_TO_ICON)
            .chain(LANGUAGE_TO_ICON)
            .map(|(_, icon)| *icon);
        for icon in tables {
            assert!(ICONS.contains(&icon), "{icon} is not in ICONS");
        }
        let held: BTreeSet<String> = std::fs::read_dir(icon_dir())
            .unwrap()
            .filter_map(|e| {
                let name = e.unwrap().file_name().into_string().unwrap();
                name.strip_suffix(".svg").map(str::to_owned)
            })
            .collect();
        let named: BTreeSet<String> = ICONS.iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(held, named);
        assert_eq!(ICONS.len(), named.len(), "an icon is named twice");
    }

    #[test]
    fn every_icon_of_the_tables_is_used() {
        let used: BTreeSet<&str> = FILENAME_TO_ICON
            .iter()
            .chain(EXTENSION_TO_ICON)
            .chain(LANGUAGE_TO_ICON)
            .map(|(_, icon)| *icon)
            .collect();
        for icon in ICONS {
            assert!(used.contains(icon), "{icon} is in no table");
        }
    }
}
