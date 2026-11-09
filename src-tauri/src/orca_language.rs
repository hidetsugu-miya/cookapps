//! The language of a file open in the editor of the Orca screen (A-21): the name of the language Orca's own editor would give it, and the name the highlighter of the page (`src/vendor/highlight.min.js`) knows it by.
//!
//! The decision is Orca 1.4.254's `detectLanguage` (`out/shared/editor-language/editor-language-detect.js` of `app.asar`, extracted with `npx @electron/asar extract /Applications/Orca.app/Contents/Resources/app.asar DIR`),
//! written again here: the tables `EXT_TO_LANGUAGE`, `FILENAME_TO_LANGUAGE` and `SHEBANG_INTERPRETER_TO_LANGUAGE` are copied from it, and `orca_language_associations.json` is its `monaco-language-associations.json` (the extensions and file names that Monaco's languages claim; `monaco-filename-language.js` reads it).
//! In this order, the first that gives a language wins:
//! 1. the file's name as it is in `FILENAME_TO_LANGUAGE` (`Dockerfile`), then the name in lower case in the same table (`dockerfile`);
//! 2. the extension in lower case (from the last dot of the name, a name that starts with a dot being all extension) in `EXT_TO_LANGUAGE`;
//! 3. Monaco's file names (`Gemfile`, `Rakefile`), then its extensions, the longest that the lower-case name ends with (a later language wins an extension two claim);
//! 4. a name that starts with `jenkinsfile.` (groovy), then `.env` or a name that starts with `.env.` (dotenv);
//! 5. else `plaintext`, and for a name with no extension only, the `#!` line of the text (its first 256 characters): the interpreter, with the directory, `.exe` and the digits and dots at its end taken off, and `env` and its flags skipped.
//!
//! Orca decides again at each key; the editor of this app decides once, when the file is read. A later Orca can change the tables; then they are taken again.

use std::{collections::HashMap, sync::OnceLock};

use serde::Deserialize;

const ASSOCIATIONS: &str = include_str!("orca_language_associations.json");

const EXT_TO_LANGUAGE: &[(&str, &str)] = &[
    (".ts", "typescript"),
    (".tsx", "typescript"),
    (".cts", "typescript"),
    (".mts", "typescript"),
    (".js", "javascript"),
    (".jsx", "javascript"),
    (".mjs", "javascript"),
    (".cjs", "javascript"),
    (".json", "json"),
    (".jsonc", "json"),
    (".excalidraw", "json"),
    (".jsonl", "jsonl"),
    (".env", "dotenv"),
    (".ipynb", "notebook"),
    (".md", "markdown"),
    (".mdx", "markdown"),
    (".qmd", "quarto"),
    (".rmd", "quarto"),
    (".rmarkdown", "quarto"),
    (".mmd", "mermaid"),
    (".mermaid", "mermaid"),
    (".css", "css"),
    (".scss", "scss"),
    (".less", "less"),
    (".html", "html"),
    (".htm", "html"),
    (".jsp", "html"),
    (".jspf", "html"),
    (".liquid", "liquid"),
    (".twig", "twig"),
    (".xml", "xml"),
    (".svg", "xml"),
    (".py", "python"),
    (".rs", "rust"),
    (".zig", "zig"),
    (".go", "go"),
    (".java", "java"),
    (".kt", "kotlin"),
    (".kts", "kotlin"),
    (".c", "c"),
    (".h", "c"),
    (".cpp", "cpp"),
    (".cc", "cpp"),
    (".cxx", "cpp"),
    (".hpp", "cpp"),
    (".cu", "cuda-cpp"),
    (".cuh", "cuda-cpp"),
    (".cs", "csharp"),
    (".cls", "apex"),
    (".trigger", "apex"),
    (".apex", "apex"),
    (".rb", "ruby"),
    (".php", "php"),
    (".swift", "swift"),
    (".sh", "shell"),
    (".just", "shell"),
    (".bash", "shell"),
    (".zsh", "shell"),
    (".fish", "shell"),
    (".bat", "bat"),
    (".cmd", "bat"),
    (".ps1", "powershell"),
    (".yaml", "yaml"),
    (".yml", "yaml"),
    (".toml", "ini"),
    (".ini", "ini"),
    (".cfg", "ini"),
    (".conf", "ini"),
    (".sql", "sql"),
    (".graphql", "graphql"),
    (".gql", "graphql"),
    (".dockerfile", "dockerfile"),
    (".proto", "proto"),
    (".lua", "lua"),
    (".r", "r"),
    (".make", "makefile"),
    (".scala", "scala"),
    (".groovy", "groovy"),
    (".gvy", "groovy"),
    (".gy", "groovy"),
    (".gsh", "groovy"),
    (".gradle", "groovy"),
    (".jenkinsfile", "groovy"),
    (".dart", "dart"),
    (".ex", "elixir"),
    (".exs", "elixir"),
    (".erl", "erlang"),
    (".hrl", "erlang"),
    (".hs", "haskell"),
    (".clj", "clojure"),
    (".sol", "sol"),
    (".vue", "vue"),
    (".svelte", "svelte"),
    (".astro", "astro"),
    (".gjs", "glimmer-js"),
    (".gts", "glimmer-ts"),
    (".sv", "systemverilog"),
    (".svh", "systemverilog"),
    (".v", "verilog"),
    (".vh", "verilog"),
    (".nim", "nim"),
    (".nims", "nim"),
    (".nimble", "nim"),
    (".lean", "lean"),
    (".typ", "typst"),
    (".tf", "hcl"),
    (".hcl", "hcl"),
    (".abap", "abap"),
    (".prisma", "graphql"),
    (".csv", "csv"),
    (".tsv", "tsv"),
];

const FILENAME_TO_LANGUAGE: &[(&str, &str)] = &[
    ("Dockerfile", "dockerfile"),
    ("Jenkinsfile", "groovy"),
    ("Makefile", "makefile"),
    ("Justfile", "shell"),
    (".justfile", "shell"),
    ("CMakeLists.txt", "cmake"),
    (".gitignore", "ini"),
    (".gitattributes", "ini"),
    (".editorconfig", "ini"),
    (".env", "dotenv"),
    (".env.local", "dotenv"),
    (".env.development", "dotenv"),
    (".env.production", "dotenv"),
    (".envrc", "shell"),
    (".bashrc", "shell"),
    (".bash_profile", "shell"),
    (".bash_login", "shell"),
    (".bash_logout", "shell"),
    (".profile", "shell"),
    (".zshrc", "shell"),
    (".zshenv", "shell"),
    (".zprofile", "shell"),
    (".zlogin", "shell"),
    (".zlogout", "shell"),
];

const SHEBANG_INTERPRETER_TO_LANGUAGE: &[(&str, &str)] = &[
    ("sh", "shell"),
    ("bash", "shell"),
    ("zsh", "shell"),
    ("dash", "shell"),
    ("ksh", "shell"),
    ("ash", "shell"),
    ("fish", "shell"),
    ("python", "python"),
    ("pypy", "python"),
    ("node", "javascript"),
    ("nodejs", "javascript"),
    ("deno", "javascript"),
    ("bun", "javascript"),
    ("ts-node", "typescript"),
    ("tsx", "typescript"),
    ("ruby", "ruby"),
    ("perl", "perl"),
    ("php", "php"),
    ("lua", "lua"),
    ("luajit", "lua"),
    ("pwsh", "powershell"),
    ("powershell", "powershell"),
    ("groovy", "groovy"),
];

/// Monaco's associations: the file names and the extensions (in lower case) that name a language, and the extensions longest first.
struct Associations {
    filenames: HashMap<String, String>,
    extensions: HashMap<String, String>,
    suffixes: Vec<String>,
}

#[derive(Deserialize)]
struct Language {
    id: String,
    extensions: Vec<String>,
    filenames: Vec<String>,
}

fn associations() -> &'static Associations {
    static TABLE: OnceLock<Associations> = OnceLock::new();
    TABLE.get_or_init(|| {
        let languages: Vec<Language> =
            serde_json::from_str(ASSOCIATIONS).expect("orca_language_associations.json");
        let mut filenames = HashMap::new();
        let mut extensions = HashMap::new();
        // Like Monaco, a later registration wins an extension that two languages claim.
        for language in languages {
            for name in language.filenames {
                filenames.insert(name.to_lowercase(), language.id.clone());
            }
            for extension in language.extensions {
                extensions.insert(extension.to_lowercase(), language.id.clone());
            }
        }
        let mut suffixes: Vec<String> = extensions.keys().cloned().collect();
        suffixes.sort_by_key(|suffix| std::cmp::Reverse(suffix.len()));
        Associations {
            filenames,
            extensions,
            suffixes,
        }
    })
}

fn lookup(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(name, _)| *name == key).map(|(_, v)| *v)
}

/// The extension of a name, with its dot, or "" when it has none (a dot at the very start is an extension, `.gitignore`).
fn extension(filename: &str) -> &str {
    filename.rfind('.').map_or("", |dot| &filename[dot..])
}

/// The language of Monaco's own associations for the name: its file names, then the longest extension the name ends with.
fn monaco_language(filename: &str) -> Option<&'static str> {
    let table = associations();
    let lower = filename.to_lowercase();
    if let Some(id) = table.filenames.get(&lower) {
        return Some(id);
    }
    let suffix = table
        .suffixes
        .iter()
        .find(|suffix| lower.ends_with(suffix.as_str()))?;
    table.extensions.get(suffix).map(String::as_str)
}

/// The basename of an interpreter token: the part after the last `/` or `\`, in lower case, without `.exe`.
fn executable_basename(token: &str) -> String {
    let lower = token
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_owned()
}

/// The language a `#!` line on the first line of the text names, with the version of an interpreter (`python3.11`) taken off.
fn shebang_language(content: &str) -> Option<&'static str> {
    let prefix: String = content.chars().take(256).collect();
    let first = prefix.split('\n').next().unwrap_or("");
    let rest = first.trim_start().strip_prefix("#!")?;
    let interpreter = rest
        .split_whitespace()
        .map(executable_basename)
        .find(|name| !name.is_empty() && name != "env" && !name.starts_with('-'))?;
    let interpreter = interpreter.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    lookup(SHEBANG_INTERPRETER_TO_LANGUAGE, interpreter)
}

/// The language of Orca's editor for the file at `path` with the text `content`: Orca's name for it, `plaintext` when it has none.
pub fn detect_language(path: &str, content: &str) -> &'static str {
    let filename = path.rsplit(['/', '\\']).next().unwrap_or("");
    if let Some(language) = lookup(FILENAME_TO_LANGUAGE, filename) {
        return language;
    }
    let lower = filename.to_lowercase();
    if let Some((_, language)) = FILENAME_TO_LANGUAGE
        .iter()
        .find(|(name, _)| name.to_lowercase() == lower)
    {
        return language;
    }
    let ext = extension(filename).to_lowercase();
    let language = lookup(EXT_TO_LANGUAGE, &ext)
        .or_else(|| monaco_language(filename))
        .or_else(|| lower.starts_with("jenkinsfile.").then_some("groovy"))
        .or_else(|| (lower == ".env" || lower.starts_with(".env.")).then_some("dotenv"))
        .unwrap_or("plaintext");
    if language == "plaintext" && ext.is_empty() {
        return shebang_language(content).unwrap_or("plaintext");
    }
    language
}

/// The name the page's highlighter knows an Orca language by, or None when it has no grammar for it (the text is then drawn plain).
/// Every name here is in `src/vendor/highlight.min.js` or `src/vendor/highlight-languages.js` (a test checks it).
pub fn highlight_name(language: &str) -> Option<&'static str> {
    HIGHLIGHT_NAMES
        .iter()
        .find(|(orca, _)| *orca == language)
        .map(|(_, name)| *name)
}

/// Orca's language to the highlighter's: the same name for most, another for those the highlighter calls differently or covers with a close grammar (HTML and the component formats as XML, Apex as Java, CUDA as C++).
const HIGHLIGHT_NAMES: &[(&str, &str)] = &[
    ("typescript", "typescript"),
    ("javascript", "javascript"),
    ("json", "json"),
    ("jsonl", "json"),
    ("notebook", "json"),
    ("dotenv", "ini"),
    ("markdown", "markdown"),
    ("mdx", "markdown"),
    ("quarto", "markdown"),
    ("css", "css"),
    ("scss", "scss"),
    ("less", "less"),
    ("html", "xml"),
    ("xml", "xml"),
    ("vue", "xml"),
    ("svelte", "xml"),
    ("astro", "xml"),
    ("twig", "twig"),
    ("handlebars", "handlebars"),
    ("glimmer-js", "javascript"),
    ("glimmer-ts", "typescript"),
    ("python", "python"),
    ("rust", "rust"),
    ("go", "go"),
    ("java", "java"),
    ("apex", "java"),
    ("kotlin", "kotlin"),
    ("c", "c"),
    ("cpp", "cpp"),
    ("cuda-cpp", "cpp"),
    ("csharp", "csharp"),
    ("fsharp", "fsharp"),
    ("objective-c", "objectivec"),
    ("ruby", "ruby"),
    ("php", "php"),
    ("perl", "perl"),
    ("swift", "swift"),
    ("shell", "bash"),
    ("bat", "dos"),
    ("powershell", "powershell"),
    ("yaml", "yaml"),
    ("ini", "ini"),
    ("sql", "sql"),
    ("graphql", "graphql"),
    ("dockerfile", "dockerfile"),
    ("proto", "protobuf"),
    ("lua", "lua"),
    ("r", "r"),
    ("makefile", "makefile"),
    ("cmake", "cmake"),
    ("scala", "scala"),
    ("groovy", "groovy"),
    ("dart", "dart"),
    ("elixir", "elixir"),
    ("erlang", "erlang"),
    ("haskell", "haskell"),
    ("clojure", "clojure"),
    ("julia", "julia"),
    ("coffeescript", "coffeescript"),
    ("scheme", "scheme"),
    ("tcl", "tcl"),
    ("vb", "vbnet"),
    ("pascal", "delphi"),
    ("nim", "nim"),
    ("verilog", "verilog"),
    ("systemverilog", "verilog"),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// (path, text, language) as Orca 1.4.254's own `detectLanguage` answers them, taken by running its `editor-language-detect.js` under node on each pair.
    const ORACLE: &[(&str, &str, &str)] = &[
        ("src/main.rs", "", "rust"),
        ("ts/a.tsx", "", "typescript"),
        ("a/b/Dockerfile", "", "dockerfile"),
        ("dockerfile", "", "dockerfile"),
        ("Dockerfile.dev", "", "plaintext"),
        ("x.dockerfile", "", "dockerfile"),
        ("Gemfile", "", "ruby"),
        ("gemfile", "", "ruby"),
        ("Rakefile", "", "ruby"),
        ("Makefile", "", "makefile"),
        ("makefile", "", "makefile"),
        ("GNUmakefile", "", "plaintext"),
        ("Jenkinsfile", "", "groovy"),
        ("Jenkinsfile.release", "", "groovy"),
        ("Jenkinsfile.md", "", "markdown"),
        ("CMakeLists.txt", "", "cmake"),
        ("notes.txt", "", "plaintext"),
        ("LICENSE", "", "plaintext"),
        (".gitignore", "", "ini"),
        (".gitattributes", "", "ini"),
        (".editorconfig", "", "ini"),
        (".gitconfig", "", "ini"),
        (".env", "", "dotenv"),
        (".env.local", "", "dotenv"),
        (".env.staging", "", "dotenv"),
        ("a/.env.test.local", "", "dotenv"),
        (".envrc", "", "shell"),
        (".bashrc", "", "shell"),
        (".zshrc", "", "shell"),
        (".profile", "", "shell"),
        ("foo.json", "", "json"),
        ("tsconfig.json", "", "json"),
        (".eslintrc", "", "json"),
        (".babelrc", "", "json"),
        ("a.har", "", "json"),
        ("a.jsonl", "", "jsonl"),
        ("a.excalidraw", "", "json"),
        ("README.md", "", "markdown"),
        ("a.mdx", "", "markdown"),
        ("a.qmd", "", "quarto"),
        ("a.RMD", "", "quarto"),
        ("a.mmd", "", "mermaid"),
        ("A.HTML", "", "html"),
        ("a.htm", "", "html"),
        ("a.html.liquid", "", "liquid"),
        ("a.liquid", "", "liquid"),
        ("a.jsp", "", "html"),
        ("a.svg", "", "xml"),
        ("a.vue", "", "vue"),
        ("a.svelte", "", "svelte"),
        ("a.astro", "", "astro"),
        ("a.cls", "", "apex"),
        ("a.trigger", "", "apex"),
        ("a.hh", "", "cpp"),
        ("a.hxx", "", "cpp"),
        ("a.cu", "", "cuda-cpp"),
        ("a.cuh", "", "cuda-cpp"),
        ("a.csx", "", "csharp"),
        ("a.cake", "", "csharp"),
        ("a.sh", "", "shell"),
        ("a.just", "", "shell"),
        ("Justfile", "", "shell"),
        (".justfile", "", "shell"),
        ("a.fish", "", "shell"),
        ("a.ps1", "", "powershell"),
        ("a.psm1", "", "powershell"),
        ("a.psd1", "", "powershell"),
        ("a.toml", "", "ini"),
        ("Cargo.lock", "", "plaintext"),
        ("a.cfg", "", "ini"),
        ("a.conf", "", "ini"),
        ("config", "", "ini"),
        ("a.ini", "", "ini"),
        ("a.proto", "", "proto"),
        ("a.R", "", "r"),
        ("a.r", "", "r"),
        ("a.make", "", "makefile"),
        ("a.mk", "", "plaintext"),
        ("a.tf", "", "hcl"),
        ("a.tfvars", "", "hcl"),
        ("a.hcl", "", "hcl"),
        ("a.prisma", "", "graphql"),
        ("a.csv", "", "csv"),
        ("a.tsv", "", "tsv"),
        ("a.sol", "", "sol"),
        ("a.zig", "", "zig"),
        ("a.nim", "", "nim"),
        ("a.lean", "", "lean"),
        ("a.typ", "", "typst"),
        ("a.abap", "", "abap"),
        ("a.sv", "", "systemverilog"),
        ("a.v", "", "verilog"),
        ("a.vh", "", "verilog"),
        ("a.gts", "", "glimmer-ts"),
        ("a.gjs", "", "glimmer-js"),
        ("a.py", "", "python"),
        ("a.pyw", "", "python"),
        ("a.pyi", "", "plaintext"),
        ("a.rb", "", "ruby"),
        ("a.erb", "", "plaintext"),
        ("a.php", "", "php"),
        ("a.pl", "", "perl"),
        ("a.pm", "", "perl"),
        ("a.lua", "", "lua"),
        ("a.go", "", "go"),
        ("a.java", "", "java"),
        ("a.kt", "", "kotlin"),
        ("a.swift", "", "swift"),
        ("a.m", "", "objective-c"),
        ("a.mm", "", "plaintext"),
        ("a.hs", "", "haskell"),
        ("a.ex", "", "elixir"),
        ("a.erl", "", "erlang"),
        ("a.clj", "", "clojure"),
        ("a.cljs", "", "clojure"),
        ("a.edn", "", "clojure"),
        ("a.scala", "", "scala"),
        ("a.sbt", "", "scala"),
        ("a.groovy", "", "groovy"),
        ("a.gradle", "", "groovy"),
        ("a.dart", "", "dart"),
        ("a.sql", "", "sql"),
        ("a.graphql", "", "graphql"),
        ("a.gql", "", "graphql"),
        ("a.yaml", "", "yaml"),
        ("a.yml", "", "yaml"),
        ("a.xml", "", "xml"),
        ("a.xsl", "", "xml"),
        ("a.xsd", "", "xml"),
        ("a.plist", "", "plaintext"),
        ("a.tpl", "", "plaintext"),
        ("a.twig", "", "twig"),
        ("a.pug", "", "pug"),
        ("a.jade", "", "pug"),
        ("a.hbs", "", "handlebars"),
        ("a.handlebars", "", "handlebars"),
        ("a.scss", "", "scss"),
        ("a.less", "", "less"),
        ("a.css", "", "css"),
        ("a.bat", "", "bat"),
        ("a.cmd", "", "bat"),
        ("a.bicep", "", "bicep"),
        ("a.coffee", "", "coffeescript"),
        ("a.fs", "", "fsharp"),
        ("a.fsx", "", "fsharp"),
        ("a.jl", "", "julia"),
        ("a.tcl", "", "tcl"),
        ("a.pas", "", "pascal"),
        ("a.scm", "", "scheme"),
        ("a.ss", "", "scheme"),
        ("a.rst", "", "restructuredtext"),
        ("a.sparql", "", "plaintext"),
        ("a.wgsl", "", "wgsl"),
        ("a.ipynb", "", "notebook"),
        ("a.PY", "", "python"),
        ("dir.d/file", "", "plaintext"),
        ("dir.d\\file", "", "plaintext"),
        ("a\\b\\Makefile", "", "makefile"),
        ("", "", "plaintext"),
        ("/", "", "plaintext"),
        ("a.", "", "plaintext"),
        (".", "", "plaintext"),
        ("..", "", "plaintext"),
        ("a.b.c.d", "", "plaintext"),
        ("archive.tar.gz", "", "plaintext"),
        ("a.pp", "", "ruby"),
        ("a.mjs", "", "javascript"),
        ("a.cjs", "", "javascript"),
        ("a.cts", "", "typescript"),
        ("a.mts", "", "typescript"),
        ("a.jsx", "", "javascript"),
        ("a.js", "", "javascript"),
        ("script", "#!/bin/bash\necho", "shell"),
        ("script", "#!/usr/bin/env python3\nprint()", "python"),
        ("script", "#! /usr/bin/env -S node --flag\n", "javascript"),
        ("script", "#!/usr/bin/python3.11\n", "python"),
        ("script", "#!/usr/bin/env\n", "plaintext"),
        ("script", "#!\n", "plaintext"),
        ("script", "#!/bin/sh", "shell"),
        ("script", "  #!/usr/bin/env ruby\n", "ruby"),
        ("script", "#!/usr/bin/perl -w\n", "perl"),
        ("script", "#!/usr/bin/env deno run\n", "javascript"),
        ("script", "#!/usr/bin/env tsx\n", "typescript"),
        ("script", "#!/usr/bin/env ts-node\n", "typescript"),
        ("script", "#!/usr/bin/env bun\n", "javascript"),
        (
            "script",
            "#!C:\\Program Files\\PowerShell\\pwsh.EXE\n",
            "plaintext",
        ),
        ("script", "#!/usr/bin/awk -f\n", "plaintext"),
        ("script", "#!/usr/bin/env luajit\n", "lua"),
        ("script", "#!/usr/bin/env -S -i bash\n", "shell"),
        ("script", "\n#!/bin/bash\n", "plaintext"),
        ("script", "#!/usr/bin/env groovy\n", "groovy"),
        ("script", "#!/bin/bash\r\necho", "shell"),
        ("script", "", "plaintext"),
        ("script", "plain", "plaintext"),
        ("run.txt", "#!/bin/bash\n", "plaintext"),
        ("a.unknown", "#!/bin/bash\n", "plaintext"),
        ("script.sh", "#!/usr/bin/python\n", "shell"),
        ("Makefile", "#!/bin/bash\n", "makefile"),
        ("script", "#!/usr/bin/env python3.11.4\n", "python"),
        ("script", "#!/usr/bin/nodejs\n", "javascript"),
        ("script", "#!/usr/bin/env pypy3\n", "python"),
        ("script", "#!/usr/bin/env ash\n", "shell"),
        ("script", "#!/usr/bin/dash\n", "shell"),
        ("script", "#!/usr/bin/ksh93\n", "shell"),
    ];

    #[test]
    fn the_language_is_the_one_orca_decides() {
        for (path, content, language) in ORACLE {
            assert_eq!(
                detect_language(path, content),
                *language,
                "{path:?} {content:?}"
            );
        }
    }

    #[test]
    fn a_file_name_decides_before_the_extension() {
        assert_eq!(detect_language("a/b/Dockerfile", ""), "dockerfile");
        assert_eq!(detect_language("Gemfile", ""), "ruby");
        assert_eq!(detect_language("Makefile", ""), "makefile");
        assert_eq!(detect_language("CMakeLists.txt", ""), "cmake");
        assert_eq!(detect_language(".gitignore", ""), "ini");
        assert_eq!(detect_language("a.rs", ""), "rust");
        assert_eq!(detect_language("notes.txt", ""), "plaintext");
    }

    #[test]
    fn only_a_name_without_extension_takes_its_language_from_the_shebang() {
        assert_eq!(
            detect_language("run", "#!/usr/bin/env python3\nprint()"),
            "python"
        );
        assert_eq!(detect_language("run.txt", "#!/bin/bash\n"), "plaintext");
        assert_eq!(detect_language("run", "echo"), "plaintext");
    }

    /// The names of the grammars the vendored highlighter holds: the common build (`grmr_{name}`) and the added ones (`registerLanguage("{name}"`).
    fn holds(name: &str) -> bool {
        let common = include_str!("../../src/vendor/highlight.min.js");
        let added = include_str!("../../src/vendor/highlight-languages.js");
        common.contains(&format!("grmr_{}", name.replace('-', "_")))
            || added.contains(&format!("registerLanguage(\"{name}\""))
    }

    #[test]
    fn every_highlighter_name_is_a_grammar_the_page_holds() {
        for (orca, name) in HIGHLIGHT_NAMES {
            assert!(holds(name), "{orca} -> {name}");
        }
    }

    #[test]
    fn every_orca_language_is_named_by_orca() {
        let known: Vec<&str> = EXT_TO_LANGUAGE
            .iter()
            .chain(FILENAME_TO_LANGUAGE)
            .map(|(_, language)| *language)
            .chain(associations().extensions.values().map(String::as_str))
            .collect();
        for (orca, _) in HIGHLIGHT_NAMES {
            assert!(known.contains(orca), "{orca}");
        }
    }

    #[test]
    fn a_language_without_a_grammar_is_drawn_plain() {
        assert_eq!(highlight_name("rust"), Some("rust"));
        assert_eq!(highlight_name("html"), Some("xml"));
        assert_eq!(highlight_name("zig"), None);
        assert_eq!(highlight_name("plaintext"), None);
    }
}
