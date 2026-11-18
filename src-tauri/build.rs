use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

/// The folders of `formation/` that are embedded in the binary (A-41), and the constant of each in the generated `formation_assets.rs`.
const EMBEDDED: [(&str, &str); 2] = [("leader/feature-dev", "LEADER_SKILL"), ("plugin", "PLUGIN")];

fn main() {
    tauri_build::build();
    embed_formation_files();
}

/// Writes `$OUT_DIR/formation_assets.rs`: for each folder of `EMBEDDED`, a list of `(relative path, contents)` of every file under it, in order of path.
/// The folders and the files are `rerun-if-changed`, so a file that is added, changed or removed is in the next build.
fn embed_formation_files() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default()).join("formation");
    let mut code = String::new();
    for (folder, constant) in EMBEDDED {
        let base = root.join(folder);
        println!("cargo:rerun-if-changed={}", base.display());
        let mut files = Vec::new();
        collect(&base, &base, &mut files);
        files.sort();
        code.push_str(&format!("pub const {constant}: &[(&str, &str)] = &[\n"));
        for (relative, path) in files {
            println!("cargo:rerun-if-changed={}", path.display());
            code.push_str(&format!(
                "    ({relative:?}, include_str!({:?})),\n",
                path.display().to_string()
            ));
        }
        code.push_str("];\n");
    }
    let out = PathBuf::from(env::var("OUT_DIR").unwrap_or_default()).join("formation_assets.rs");
    fs::File::create(&out)
        .and_then(|mut file| file.write_all(code.as_bytes()))
        .unwrap_or_else(|e| panic!("{} を書けません: {e}", out.display()));
}

/// The files under `dir` as `(path relative to base with "/", absolute path)`. A folder that is not there has none.
fn collect(base: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name() == ".DS_Store" {
            continue;
        }
        if path.is_dir() {
            println!("cargo:rerun-if-changed={}", path.display());
            collect(base, &path, files);
        } else if let Ok(relative) = path.strip_prefix(base) {
            let parts: Vec<String> = relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            files.push((parts.join("/"), path));
        }
    }
}
