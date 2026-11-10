//! A-10: a file pasted or dropped on a terminal of the Orca screen or in the pane of A-9. The file is put in `.orca/drops/` of the worktree of the session through Orca's runtime (`files.*`), on this machine over its unix socket and on a paired server over its WebSocket,
//! under its own name, and the screen types the path of the file in the terminal, or adds it to the instruction, so Claude reads the file from that path.
//! The `files.*` calls are not a public interface of Orca: this was written against Orca 1.4.248, and the names and the typed text follow Orca 1.4.253. A token is in no log line, no error text and no return value; the file is in no log line either.

use std::collections::HashSet;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(test)]
use ts_rs::TS;

use crate::{
    orca::{check_path, worktree_host},
    orca_chat::{CallError, Connection},
    orca_files::{parse_dir, LIST_LIMIT},
};

/// The most a file may be, in bytes of the decoded file.
const MAX_FILE: usize = 20 * 1024 * 1024;
/// The bytes of a file one `files.writeBase64Chunk` carries: a larger frame closes the host's socket.
const CHUNK: usize = 384 * 1024;
/// Where the files go, inside the worktree.
const DROPS: &str = ".orca/drops";
/// The bytes of a file name (`NAME_MAX`), the name of a copy included.
const NAME_MAX: usize = 255;
/// How many names `{name} copy`, `{name} copy 2`, ... are tried (Orca stops at 9999).
const COPIES: usize = 9999;
/// The characters a shell reads as more than a name: Orca's own paste of an image path (`shared/image-path-paste.js`) escapes the same ones.
const SHELL_SPECIAL: &str = " \"'`$;&|<>(){}[]*?!#\\";
const NAME_TOO_LONG: &str = "ファイル名が長すぎます（255 バイトまで）";

/// What the screen types for a file put in the worktree: the text, and whether the terminal gets it as a bracketed paste (an image path, which a program like Claude reads as an attachment) or as typed text.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct AttachedFile {
    pub text: String,
    pub bracketed: bool,
}

/// The call of one Orca, so that the upload is the same code for a unit test and for the real connection (A-18's files and editor use it too).
pub(crate) trait Rpc {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError>;
}

impl Rpc for Connection {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
        Connection::call(self, method, params).await
    }
}

// ---- the file ----

/// The extension of the image the bytes are, by their magic bytes: PNG, JPEG, GIF and WebP only. SVG and the rest are `None`, whatever name was given.
fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// The decoded file: base64 that is not too long, decoded, not empty, not over the limit.
fn decode(data: &str) -> Result<Vec<u8>, String> {
    let too_large = || format!("ファイルは {} MiB までです", MAX_FILE / 1024 / 1024);
    // Four characters are three bytes: refuse before the decode makes the copy.
    if data.len() > MAX_FILE / 3 * 4 + 8 {
        return Err(too_large());
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "ファイルを読めません".to_owned())?;
    if bytes.is_empty() {
        return Err("ファイルを読めません".into());
    }
    if bytes.len() > MAX_FILE {
        return Err(too_large());
    }
    Ok(bytes)
}

/// A character a name or a path may not hold: a control character (NUL included), or a bidirectional formatting character (U+200E and U+200F, U+202A to U+202E, U+2066 to U+2069), which would make the terminal show another name than the file's.
fn is_refused_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// The file name from the name the screen gave (a value from outside): kept as it is, but it must be one name in the folder: not empty, not `.` or `..`, with no `/`, `\`, control character (NUL included) or bidirectional formatting character, and at most 255 bytes.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err("ファイル名に使えない名前です".into());
    }
    if name
        .chars()
        .any(|c| c == '/' || c == '\\' || is_refused_char(c))
    {
        return Err("ファイル名に使えない文字が含まれています".into());
    }
    if name.len() > NAME_MAX {
        return Err(NAME_TOO_LONG.into());
    }
    Ok(())
}

/// The name and the extension (with its dot), split at the last dot as Orca does: a dot at the start is no extension (`.env`).
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    }
}

/// The name the file is put under: the given name checked, and for an image whose name has no extension the extension of its kind (`image_ext`), as Orca names an image pasted with none.
fn placed_name(name: &str, image_ext: Option<&str>) -> Result<String, String> {
    check_name(name)?;
    let named = match image_ext {
        Some(ext) if split_ext(name).1.is_empty() => format!("{name}.{ext}"),
        _ => name.to_owned(),
    };
    check_name(&named)?;
    Ok(named)
}

/// The `n`th choice of a name that is taken (Orca's rule, 1.4.253): `n` 0 is the name, 1 is `{stem} copy{ext}` and from 2 `{stem} copy {n}{ext}`.
/// The stem is cut, on a character, so that the name stays within 255 bytes; an extension too long to leave a stem is refused.
fn numbered(name: &str, n: usize) -> Result<String, String> {
    if n == 0 {
        return Ok(name.to_owned());
    }
    let (stem, ext) = split_ext(name);
    let suffix = if n == 1 {
        " copy".to_owned()
    } else {
        format!(" copy {n}")
    };
    let room = NAME_MAX.saturating_sub(suffix.len() + ext.len());
    let mut end = stem.len().min(room);
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        return Err(NAME_TOO_LONG.into());
    }
    Ok(format!("{}{suffix}{ext}", &stem[..end]))
}

/// The path as the text for Claude of an image: the bare path, each blank and shell character with a backslash before it (Claude reads the image from such a path).
fn escape_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if SHELL_SPECIAL.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The path of a file that is not an image as one POSIX shell word: in single quotes, a `'` inside written `'\''`.
fn quote_posix(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// What the screen types for the file at `path`: an image is a backslash-escaped path and a bracketed paste, any other file a quoted path typed as it is, each followed by one blank.
/// A path with a control or bidirectional formatting character is refused, for a control character would end the line or the command and the other would make the terminal show another path.
fn typed_text(path: &str, image: bool) -> Result<AttachedFile, String> {
    if path.chars().any(is_refused_char) {
        return Err("ファイルの保存先に使えない文字が含まれています".into());
    }
    let word = if image {
        escape_path(path)
    } else {
        quote_posix(path)
    };
    Ok(AttachedFile {
        text: format!("{word} "),
        bracketed: image,
    })
}

/// An SSH host has no file calls (its `hostId` is `ssh:{id}`): only this machine and a paired server take a file.
fn check_host(host_id: &str) -> Result<(), String> {
    if host_id.starts_with("ssh:") {
        Err("SSH の接続先の worktree にはファイルを添付できません".into())
    } else {
        Ok(())
    }
}

/// The message of a failed call. A pairing of the `mobile` scope is refused by Orca with `forbidden`, which the code alone does not explain.
fn reason(error: CallError) -> String {
    if error.shown.contains("forbidden") {
        format!(
            "この接続先のペアリングにはファイルを置く権限がないため、ファイルを添付できません。{}",
            error.shown
        )
    } else {
        error.shown
    }
}

// ---- the upload ----

fn is_missing(error: &CallError) -> bool {
    error.detail.starts_with("ENOENT")
}

/// The parameters every call takes: the worktree by its path, and for a change the host Orca runs it on.
pub(crate) fn worktree_params(path: &str, host_id: Option<&str>, mut params: Value) -> Value {
    params["worktree"] = json!(format!("path:{path}"));
    if let Some(host_id) = host_id {
        params["expectedExecutionHostId"] = json!(host_id);
    }
    params
}

/// Whether the file exists: `files.stat` answers, or says `ENOENT`; any other failure is the upload's.
async fn exists(rpc: &mut impl Rpc, path: &str, relative: &str) -> Result<bool, String> {
    match rpc
        .call(
            "files.stat",
            worktree_params(path, None, json!({"relativePath": relative})),
        )
        .await
    {
        Ok(_) => Ok(true),
        Err(e) if is_missing(&e) => Ok(false),
        Err(e) => Err(reason(e)),
    }
}

async fn write_chunk(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    relative: &str,
    bytes: &[u8],
    append: bool,
) -> Result<(), CallError> {
    rpc.call(
        "files.writeBase64Chunk",
        worktree_params(
            path,
            Some(host_id),
            json!({
                "relativePath": relative,
                "contentBase64": STANDARD.encode(bytes),
                "append": append,
            }),
        ),
    )
    .await
    .map(|_| ())
}

/// The first name from `name` that is not in `taken`: `name`, else `{stem} copy{ext}`, `{stem} copy 2{ext}`, and so on (`numbered`).
fn first_free(taken: &HashSet<String>, name: &str) -> Result<String, String> {
    for n in 0..=COPIES {
        let candidate = numbered(name, n)?;
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("同じ名前のファイルが多すぎます".into())
}

/// The names `.orca/drops/` holds, from one `files.readDir`. A folder that is not there yet (`ENOENT`) holds none; any other failure is the upload's.
/// A name taken after this read, or beyond the page of the answer, is refused by `files.commitUpload`, so nothing is overwritten.
async fn taken_names(rpc: &mut impl Rpc, path: &str) -> Result<HashSet<String>, String> {
    match rpc
        .call(
            "files.readDir",
            worktree_params(
                path,
                None,
                json!({"relativePath": DROPS, "limit": LIST_LIMIT}),
            ),
        )
        .await
    {
        Ok(answer) => Ok(parse_dir(&answer, DROPS)?
            .0
            .into_iter()
            .map(|e| e.name)
            .collect()),
        Err(e) if is_missing(&e) => Ok(HashSet::new()),
        Err(e) => Err(reason(e)),
    }
}

/// Puts `bytes` in `.orca/drops/` of the worktree at `path` under `name` (checked by `placed_name`), or the first free name of `first_free` (against the one `taken_names` read) when that exists, and gives the absolute path of the file.
/// The file is written in chunks to a temporary name (`.orca-upload-{random}`, one of its own and short whatever the name is) and copied to its name, which fails when the name exists, so a file is never overwritten; the temporary file goes in every case.
/// `.orca/drops/.gitignore` (`*`) is written first when it is missing, so the files do not show as changes, and a failure of that is ignored.
async fn upload(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    name: &str,
    bytes: &[u8],
    random: &str,
) -> Result<String, String> {
    let ignore = format!("{DROPS}/.gitignore");
    if !exists(rpc, path, &ignore).await? {
        let _ = write_chunk(rpc, path, host_id, &ignore, b"*\n", false).await;
    }
    let name = first_free(&taken_names(rpc, path).await?, name)?;
    let temporary = format!("{DROPS}/.orca-upload-{random}");
    let sent = send_and_commit(
        rpc,
        path,
        host_id,
        &temporary,
        &format!("{DROPS}/{name}"),
        bytes,
    )
    .await;
    // Whether it worked or not: the temporary file is not left behind, and a failure of this delete is not the upload's.
    let _ = rpc
        .call(
            "files.delete",
            worktree_params(
                path,
                Some(host_id),
                json!({"relativePath": temporary, "recursive": false}),
            ),
        )
        .await;
    sent?;
    Ok(format!("{}/{DROPS}/{name}", path.trim_end_matches('/')))
}

async fn send_and_commit(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    temporary: &str,
    relative: &str,
    bytes: &[u8],
) -> Result<(), String> {
    for (n, chunk) in bytes.chunks(CHUNK).enumerate() {
        write_chunk(rpc, path, host_id, temporary, chunk, n > 0)
            .await
            .map_err(reason)?;
    }
    rpc.call(
        "files.commitUpload",
        worktree_params(
            path,
            Some(host_id),
            json!({"tempRelativePath": temporary, "finalRelativePath": relative}),
        ),
    )
    .await
    .map(|_| ())
    .map_err(reason)
}

fn random_hex() -> Result<String, String> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|_| "乱数を作れません".to_owned())?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}

/// The file of `data` (base64) checked: the name it is put under, whether it is an image (by its magic bytes, whatever the name), and the bytes.
fn prepare(name: &str, data: &str) -> Result<(String, bool, Vec<u8>), String> {
    let bytes = decode(data)?;
    let ext = image_ext(&bytes);
    Ok((placed_name(name, ext)?, ext.is_some(), bytes))
}

/// A-10: puts the file `data` (base64) in `.orca/drops/` of the worktree at `path` (one of the target's list read just now) under `name` and answers what the screen types: the absolute path of the file, as `typed_text` writes it for an image and for any other file.
/// `name` is a value from outside: it must be one file name (`check_name`), and the folder is fixed, so nothing is written outside it. Whether the file is an image is read from its bytes.
#[tauri::command]
pub async fn orca_attach_file(
    path: String,
    name: String,
    data: String,
    environment: Option<String>,
) -> Result<AttachedFile, String> {
    check_path(&path)?;
    let (name, image, bytes, host_id) = {
        let (path, environment) = (path.clone(), environment.clone());
        tokio::task::spawn_blocking(move || {
            let (name, image, bytes) = prepare(&name, &data)?;
            let host_id = worktree_host(&path, environment.as_deref())?;
            Ok::<_, String>((name, image, bytes, host_id))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    check_host(&host_id)?;
    let mut connection = Connection::open(environment).await?;
    let file = upload(
        &mut connection,
        &path,
        &host_id,
        &name,
        &bytes,
        &random_hex()?,
    )
    .await?;
    typed_text(&file, image)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn error(shown: &str, detail: &str) -> CallError {
        CallError {
            shown: shown.into(),
            detail: detail.into(),
        }
    }

    /// Orca's side of the calls: the files it has, the calls it was given, and the calls that fail (the method, which call of it counting from 0, and the error it gives).
    #[derive(Default)]
    struct Fake {
        files: HashSet<String>,
        calls: Vec<(String, Value)>,
        fail: Vec<(&'static str, usize, CallError)>,
    }

    impl Rpc for Fake {
        async fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
            let seen = self.calls.iter().filter(|(m, _)| m == method).count();
            self.calls.push((method.to_owned(), params.clone()));
            if let Some((_, _, e)) = self
                .fail
                .iter()
                .find(|(m, n, _)| *m == method && *n == seen)
            {
                return Err(error(&e.shown, &e.detail));
            }
            let relative = params["relativePath"].as_str().unwrap_or_default();
            match method {
                "files.stat" if self.files.contains(relative) => Ok(json!({"size": 1})),
                "files.stat" => Err(error(
                    "Orca がエラーを返しました（runtime_error）",
                    "ENOENT: no such file",
                )),
                "files.readDir" => {
                    let names: Vec<Value> = self
                        .files
                        .iter()
                        .filter_map(|f| f.strip_prefix(".orca/drops/"))
                        .map(|n| json!({"name": n, "isDirectory": false}))
                        .collect();
                    if names.is_empty() {
                        Err(error(
                            "Orca がエラーを返しました（runtime_error）",
                            "ENOENT: no such directory",
                        ))
                    } else {
                        Ok(json!({"entries": names, "total": names.len(), "hasMore": false}))
                    }
                }
                _ => Ok(json!({"ok": true})),
            }
        }
    }

    fn methods(fake: &Fake) -> Vec<&str> {
        fake.calls.iter().map(|(m, _)| m.as_str()).collect()
    }

    fn with_files(files: &[&str]) -> Fake {
        Fake {
            files: files.iter().map(|f| (*f).to_owned()).collect(),
            ..Fake::default()
        }
    }

    async fn run(fake: &mut Fake, bytes: &[u8]) -> Result<String, String> {
        upload(fake, "/work/a", "local", "shot.png", bytes, "r4nd").await
    }

    #[test]
    fn the_kind_is_read_from_the_bytes() {
        assert_eq!(image_ext(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_ext(&[0xFF, 0xD8, 0xFF, 0xE0, 0]), Some("jpg"));
        assert_eq!(image_ext(b"GIF87a.."), Some("gif"));
        assert_eq!(image_ext(b"GIF89a.."), Some("gif"));
        assert_eq!(image_ext(b"RIFF\x10\0\0\0WEBPVP8 "), Some("webp"));
        for no in [
            &b""[..],
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
            b"<?xml version=\"1.0\"?><svg/>",
            b"RIFF\x10\0\0\0WAVEfmt ",
            b"RIFF\x10\0\0\0WEB",
            b"GIF90a",
            b"\x89PNG",
            b"%PDF-1.7",
        ] {
            assert_eq!(image_ext(no), None, "{no:?}");
        }
    }

    #[test]
    fn the_data_is_base64_of_a_file_within_the_limit() {
        assert_eq!(decode(&STANDARD.encode(b"abc")).unwrap(), b"abc");
        for bad in ["", "not base64!", "YWJj=", "a"] {
            assert!(decode(bad).is_err(), "{bad}");
        }
        let at_limit = vec![0u8; MAX_FILE];
        assert_eq!(decode(&STANDARD.encode(&at_limit)).unwrap().len(), MAX_FILE);
        let over = vec![0u8; MAX_FILE + 1];
        assert!(decode(&STANDARD.encode(&over))
            .unwrap_err()
            .contains("20 MiB"));
        // Too long to be worth decoding.
        assert!(decode(&"A".repeat(MAX_FILE / 3 * 4 + 12))
            .unwrap_err()
            .contains("20 MiB"));
    }

    #[test]
    fn prepare_keeps_the_name_and_reads_whether_it_is_an_image_from_the_bytes() {
        let png = STANDARD.encode([PNG, b"data"].concat());
        let (name, image, bytes) = prepare("photo.jpeg", &png).unwrap();
        assert_eq!((name.as_str(), image), ("photo.jpeg", true));
        assert_eq!(bytes.len(), 12);
        // A file of any other kind is taken, whatever its name says.
        for (name, data, want) in [
            ("notes.txt", &b"hello"[..], "notes.txt"),
            ("fake.png", b"<svg/>", "fake.png"),
            ("report.pdf", b"%PDF-1.7", "report.pdf"),
            ("Makefile", b"all:", "Makefile"),
            (".env", b"A=1", ".env"),
        ] {
            let (name, image, bytes) = prepare(name, &STANDARD.encode(data)).unwrap();
            assert_eq!(
                (name.as_str(), image, bytes.as_slice()),
                (want, false, data)
            );
        }
        // An image whose name has no extension gets the one of its kind.
        assert_eq!(prepare("image", &png).unwrap().0, "image.png");
        assert_eq!(prepare(".shot", &png).unwrap().0, ".shot.png");
        assert_eq!(prepare("a.b", &png).unwrap().0, "a.b");
        let jpeg = STANDARD.encode([0xFF, 0xD8, 0xFF, 0xE0, 0]);
        assert_eq!(prepare("pic", &jpeg).unwrap().0, "pic.jpg");
        assert!(prepare("a.png", "!!").is_err());
        assert!(prepare("../a.png", &png).is_err());
    }

    #[test]
    fn a_name_is_one_file_name_and_what_cannot_be_one_is_refused() {
        for ok in [
            "photo.png",
            "my photo (1).png",
            "a.b.c",
            ".hidden",
            "...",
            "スクリーンショット 2026.png",
            "it's \"quoted\" $HOME `x`.txt",
            "  padded  ",
            &"a".repeat(NAME_MAX),
            &"あ".repeat(NAME_MAX / 3),
        ] {
            assert_eq!(check_name(ok), Ok(()), "{ok:?}");
        }
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "/etc/passwd",
            "../x",
            "x/..",
            "a\\b",
            "C:\\x",
            "a\0b",
            "a\nb",
            "a\rb",
            "a\tb",
            "a\u{1b}[0m",
            "a\u{7f}",
            "a\u{85}b",
            "a\u{200e}b",
            "a\u{200f}b",
            "a\u{202a}b",
            "a\u{202e}b",
            "a\u{2066}b",
            "a\u{2069}b",
            &"a".repeat(NAME_MAX + 1),
            &"あ".repeat(NAME_MAX / 3 + 1),
        ] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            check_name(&"a".repeat(NAME_MAX + 1)).unwrap_err(),
            NAME_TOO_LONG
        );
        // The extension added to an image may not push the name past the limit.
        let long = "a".repeat(NAME_MAX);
        assert!(placed_name(&long, Some("png")).is_err());
        assert_eq!(placed_name(&long, None).unwrap(), long);
    }

    #[test]
    fn a_name_is_split_at_its_last_dot_unless_that_dot_starts_it() {
        for (name, parts) in [
            ("a.txt", ("a", ".txt")),
            ("a.tar.gz", ("a.tar", ".gz")),
            ("noext", ("noext", "")),
            (".env", (".env", "")),
            (".env.local", (".env", ".local")),
            ("trailing.", ("trailing", ".")),
            ("あ.いう", ("あ", ".いう")),
        ] {
            assert_eq!(split_ext(name), parts, "{name}");
        }
    }

    #[test]
    fn a_taken_name_is_numbered_as_orca_does() {
        for (name, n, want) in [
            ("shot.png", 0, "shot.png"),
            ("shot.png", 1, "shot copy.png"),
            ("shot.png", 2, "shot copy 2.png"),
            ("shot.png", 9999, "shot copy 9999.png"),
            ("a.tar.gz", 3, "a.tar copy 3.gz"),
            ("Makefile", 1, "Makefile copy"),
            ("Makefile", 2, "Makefile copy 2"),
            (".env", 1, ".env copy"),
            (".env.local", 2, ".env copy 2.local"),
            ("my file.txt", 1, "my file copy.txt"),
        ] {
            assert_eq!(numbered(name, n).unwrap(), want, "{name} {n}");
        }
    }

    #[test]
    fn a_numbered_name_stays_within_the_limit_by_cutting_the_stem_on_a_character() {
        let long = format!("{}.png", "a".repeat(NAME_MAX - 4));
        for n in [1, 2, 9999] {
            let name = numbered(&long, n).unwrap();
            assert!(name.len() <= NAME_MAX, "{n}: {}", name.len());
            assert!(name.ends_with(".png"));
            assert!(name.contains(" copy"));
        }
        assert_eq!(numbered(&long, 1).unwrap().len(), NAME_MAX);
        // Three-byte characters: the cut is never inside one.
        let wide = format!("{}.txt", "あ".repeat(84));
        for n in [1, 2, 123] {
            let name = numbered(&wide, n).unwrap();
            assert!(name.len() <= NAME_MAX);
            assert!(name.ends_with(".txt"));
        }
        // An extension that leaves no room for a stem is refused.
        let ext = format!("a.{}", "b".repeat(NAME_MAX - 3));
        assert_eq!(numbered(&ext, 0).unwrap(), ext);
        assert_eq!(numbered(&ext, 1).unwrap_err(), NAME_TOO_LONG);
    }

    #[test]
    fn an_image_path_is_escaped_for_the_shell() {
        assert_eq!(
            escape_path("/work/a/.orca/drops/shot.png"),
            "/work/a/.orca/drops/shot.png"
        );
        assert_eq!(
            escape_path("/Users/me/my work/.orca/drops/shot copy.png"),
            "/Users/me/my\\ work/.orca/drops/shot\\ copy.png"
        );
        assert_eq!(
            escape_path("/a\"b'c`d$e;f&g|h<i>j(k)l{m}n[o]p*q?r!s#t\\u/x.png"),
            "/a\\\"b\\'c\\`d\\$e\\;f\\&g\\|h\\<i\\>j\\(k\\)l\\{m\\}n\\[o\\]p\\*q\\?r\\!s\\#t\\\\u/x.png"
        );
        // Characters that are not special stay: `~`, `=`, `%`, `,`, `@`, `+`, `:` and non-ASCII.
        assert_eq!(escape_path("/~=%,@+:/é.png"), "/~=%,@+:/é.png");
    }

    #[test]
    fn any_other_path_is_one_single_quoted_word() {
        assert_eq!(
            quote_posix("/work/a/.orca/drops/n.txt"),
            "'/work/a/.orca/drops/n.txt'"
        );
        assert_eq!(
            quote_posix("/w/it's here/a b.txt"),
            "'/w/it'\\''s here/a b.txt'"
        );
        assert_eq!(quote_posix("/w/''.txt"), "'/w/'\\'''\\''.txt'");
        assert_eq!(
            quote_posix("/w/$HOME `x` \"y\" \\ ; & | * ? ! #.txt"),
            "'/w/$HOME `x` \"y\" \\ ; & | * ? ! #.txt'"
        );
    }

    #[test]
    fn the_typed_text_is_a_bracketed_escaped_path_for_an_image_and_a_quoted_one_for_a_file() {
        let image = typed_text("/w/my dir/.orca/drops/shot copy.png", true).unwrap();
        assert_eq!(
            image,
            AttachedFile {
                text: "/w/my\\ dir/.orca/drops/shot\\ copy.png ".into(),
                bracketed: true
            }
        );
        let file = typed_text("/w/my dir/.orca/drops/notes copy.txt", false).unwrap();
        assert_eq!(
            file,
            AttachedFile {
                text: "'/w/my dir/.orca/drops/notes copy.txt' ".into(),
                bracketed: false
            }
        );
        // Each ends with exactly one blank.
        assert!(image.text.ends_with("png ") && !image.text.ends_with("  "));
        assert!(file.text.ends_with("' ") && !file.text.ends_with("  "));
        for image in [true, false] {
            for bad in [
                "/a\nb/x.png",
                "/a\rb",
                "/a\tb",
                "/a\0b",
                "/a\u{1b}[0m",
                "/a\u{202e}b",
                "/a\u{2067}b",
            ] {
                assert!(typed_text(bad, image).is_err(), "{bad:?}");
            }
        }
    }

    #[test]
    fn only_an_ssh_host_is_refused() {
        assert!(check_host("local").is_ok());
        assert!(check_host("server-1").is_ok());
        assert!(check_host("ssh:lab").unwrap_err().contains("SSH"));
    }

    #[test]
    fn forbidden_is_explained_and_other_errors_show_the_code() {
        let forbidden = reason(error("Orca がエラーを返しました（forbidden）", "no"));
        assert!(forbidden.contains("権限"));
        assert!(forbidden.contains("forbidden"));
        assert_eq!(
            reason(error(
                "Orca がエラーを返しました（runtime_error）",
                "ENOENT"
            )),
            "Orca がエラーを返しました（runtime_error）"
        );
    }

    #[tokio::test]
    async fn a_new_file_is_sent_in_chunks_and_committed_and_the_temporary_file_goes() {
        let mut fake = Fake::default();
        // Two full chunks and one byte.
        let bytes = vec![7u8; CHUNK * 2 + 1];
        let file = run(&mut fake, &bytes).await.unwrap();
        assert_eq!(file, "/work/a/.orca/drops/shot.png");
        assert_eq!(
            methods(&fake),
            [
                "files.stat",
                "files.writeBase64Chunk",
                "files.readDir",
                "files.writeBase64Chunk",
                "files.writeBase64Chunk",
                "files.writeBase64Chunk",
                "files.commitUpload",
                "files.delete",
            ]
        );
        let call = |n: usize| &fake.calls[n].1;
        // The ignore file first, `*` and a newline, a new file.
        assert_eq!(call(0)["relativePath"], ".orca/drops/.gitignore");
        assert_eq!(call(0)["worktree"], "path:/work/a");
        assert!(call(0).get("expectedExecutionHostId").is_none());
        assert_eq!(call(1)["relativePath"], ".orca/drops/.gitignore");
        assert_eq!(
            STANDARD
                .decode(call(1)["contentBase64"].as_str().unwrap())
                .unwrap(),
            b"*\n"
        );
        assert_eq!(call(1)["append"], false);
        assert_eq!(call(1)["expectedExecutionHostId"], "local");
        assert_eq!(call(2)["relativePath"], ".orca/drops");
        assert_eq!(call(2)["worktree"], "path:/work/a");
        assert_eq!(call(2)["limit"], LIST_LIMIT);
        // Chunks of the temporary file: the first creates it, the others append.
        let temporary = ".orca/drops/.orca-upload-r4nd";
        let sizes: Vec<(usize, bool)> = (3..6)
            .map(|n| {
                assert_eq!(call(n)["relativePath"], temporary);
                assert_eq!(call(n)["worktree"], "path:/work/a");
                assert_eq!(call(n)["expectedExecutionHostId"], "local");
                (
                    STANDARD
                        .decode(call(n)["contentBase64"].as_str().unwrap())
                        .unwrap()
                        .len(),
                    call(n)["append"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(sizes, [(CHUNK, false), (CHUNK, true), (1, true)]);
        assert_eq!(
            call(6),
            &json!({
                "worktree": "path:/work/a",
                "tempRelativePath": temporary,
                "finalRelativePath": ".orca/drops/shot.png",
                "expectedExecutionHostId": "local",
            })
        );
        assert_eq!(
            call(7),
            &json!({
                "worktree": "path:/work/a",
                "relativePath": temporary,
                "recursive": false,
                "expectedExecutionHostId": "local",
            })
        );
    }

    #[tokio::test]
    async fn an_existing_ignore_file_is_not_written_again() {
        let mut fake = with_files(&[".orca/drops/.gitignore"]);
        run(&mut fake, b"abc").await.unwrap();
        assert_eq!(
            methods(&fake),
            [
                "files.stat",
                "files.readDir",
                "files.writeBase64Chunk",
                "files.commitUpload",
                "files.delete"
            ]
        );
    }

    #[tokio::test]
    async fn a_failed_write_of_the_ignore_file_is_ignored() {
        let mut fake = Fake::default();
        // The first write is the ignore file: only that one fails, and the image goes on.
        fake.fail.push((
            "files.writeBase64Chunk",
            0,
            error("Orca がエラーを返しました（runtime_error）", "EACCES"),
        ));
        assert_eq!(
            run(&mut fake, b"abc").await.unwrap(),
            "/work/a/.orca/drops/shot.png"
        );
        assert_eq!(
            methods(&fake)
                .iter()
                .filter(|m| **m == "files.writeBase64Chunk")
                .count(),
            2
        );
        assert!(methods(&fake).contains(&"files.commitUpload"));
    }

    #[tokio::test]
    async fn a_taken_name_is_numbered_from_one_read_of_the_folder() {
        let mut fake = with_files(&[".orca/drops/.gitignore", ".orca/drops/shot.png"]);
        let file = run(&mut fake, b"abc").await.unwrap();
        assert_eq!(file, "/work/a/.orca/drops/shot copy.png");
        let count =
            |fake: &Fake, method: &str| methods(fake).iter().filter(|m| **m == method).count();
        assert_eq!(
            (count(&fake, "files.stat"), count(&fake, "files.readDir")),
            (1, 1)
        );
        let commit = fake
            .calls
            .iter()
            .find(|(m, _)| m == "files.commitUpload")
            .unwrap();
        assert_eq!(commit.1["finalRelativePath"], ".orca/drops/shot copy.png");
        assert_eq!(
            commit.1["tempRelativePath"],
            ".orca/drops/.orca-upload-r4nd"
        );

        let mut fake = with_files(&[
            ".orca/drops/.gitignore",
            ".orca/drops/shot.png",
            ".orca/drops/shot copy.png",
            ".orca/drops/shot copy 2.png",
        ]);
        assert_eq!(
            run(&mut fake, b"abc").await.unwrap(),
            "/work/a/.orca/drops/shot copy 3.png"
        );
        assert_eq!(
            (count(&fake, "files.stat"), count(&fake, "files.readDir")),
            (1, 1)
        );
    }

    #[tokio::test]
    async fn a_folder_that_is_not_there_yet_holds_no_name() {
        let mut fake = Fake::default();
        assert_eq!(
            run(&mut fake, b"abc").await.unwrap(),
            "/work/a/.orca/drops/shot.png"
        );
        assert!(methods(&fake).contains(&"files.commitUpload"));
    }

    #[tokio::test]
    async fn a_read_of_the_folder_that_fails_for_another_reason_is_the_uploads_failure() {
        let mut fake = with_files(&[".orca/drops/.gitignore"]);
        fake.fail.push((
            "files.readDir",
            0,
            error("Orca がエラーを返しました（forbidden）", "no"),
        ));
        let failed = run(&mut fake, b"abc").await.unwrap_err();
        assert!(failed.contains("forbidden"));
        assert!(!methods(&fake).contains(&"files.commitUpload"));
    }

    #[test]
    fn the_first_name_the_folder_does_not_hold_is_chosen() {
        let taken = |names: &[&str]| {
            names
                .iter()
                .map(|n| (*n).to_owned())
                .collect::<HashSet<_>>()
        };
        assert_eq!(first_free(&taken(&[]), "a.png").unwrap(), "a.png");
        assert_eq!(
            first_free(&taken(&["a.png"]), "a.png").unwrap(),
            "a copy.png"
        );
        assert_eq!(
            first_free(&taken(&["a.png", "a copy.png"]), "a.png").unwrap(),
            "a copy 2.png"
        );
        // A gap is filled: the first free one, not the one after the last.
        assert_eq!(
            first_free(&taken(&["a.png", "a copy 2.png"]), "a.png").unwrap(),
            "a copy.png"
        );
    }

    #[tokio::test]
    async fn a_name_with_no_free_copy_is_refused_after_9999_numbers() {
        let mut files = vec![
            ".orca/drops/.gitignore".to_owned(),
            ".orca/drops/n".to_owned(),
            ".orca/drops/n copy".to_owned(),
        ];
        files.extend((2..=COPIES).map(|n| format!(".orca/drops/n copy {n}")));
        let mut fake = Fake {
            files: files.into_iter().collect(),
            ..Fake::default()
        };
        let failed = upload(&mut fake, "/work/a", "local", "n", b"abc", "r")
            .await
            .unwrap_err();
        assert!(failed.contains("多すぎ"));
        assert!(!methods(&fake).contains(&"files.commitUpload"));
    }

    #[tokio::test]
    async fn the_name_goes_to_orca_as_given_inside_the_drops_folder_only() {
        let mut fake = with_files(&[".orca/drops/.gitignore"]);
        let name = "it's a \"name\" $x.txt";
        let file = upload(&mut fake, "/work/a", "local", name, b"abc", "r")
            .await
            .unwrap();
        assert_eq!(file, format!("/work/a/.orca/drops/{name}"));
        for (m, params) in &fake.calls {
            // The read of the folder names the folder itself.
            if m == "files.readDir" {
                assert_eq!(params["relativePath"], ".orca/drops");
                continue;
            }
            for key in ["relativePath", "tempRelativePath", "finalRelativePath"] {
                if let Some(path) = params[key].as_str() {
                    assert!(path.starts_with(".orca/drops/"), "{m} {path}");
                    assert!(!path[".orca/drops/".len()..].contains('/'), "{m} {path}");
                }
            }
        }
    }

    #[tokio::test]
    async fn a_failed_commit_deletes_the_temporary_file_and_passes_the_error() {
        let mut fake = with_files(&[".orca/drops/.gitignore"]);
        fake.fail.push((
            "files.commitUpload",
            0,
            error("Orca がエラーを返しました（runtime_error）", "EEXIST"),
        ));
        let failed = run(&mut fake, b"abc").await.unwrap_err();
        assert_eq!(failed, "Orca がエラーを返しました（runtime_error）");
        assert_eq!(methods(&fake).last(), Some(&"files.delete"));
    }

    #[tokio::test]
    async fn a_failed_chunk_stops_the_upload_and_deletes_the_temporary_file() {
        let mut fake = with_files(&[".orca/drops/.gitignore"]);
        fake.fail.push((
            "files.writeBase64Chunk",
            0,
            error("Orca がエラーを返しました（forbidden）", "no"),
        ));
        let failed = run(&mut fake, &vec![1u8; CHUNK * 2]).await.unwrap_err();
        assert!(failed.contains("権限"));
        let all = methods(&fake);
        assert_eq!(
            all.iter()
                .filter(|m| **m == "files.writeBase64Chunk")
                .count(),
            1
        );
        assert!(!all.contains(&"files.commitUpload"));
        assert_eq!(all.last(), Some(&"files.delete"));
    }

    #[tokio::test]
    async fn a_failed_delete_does_not_fail_the_upload() {
        let mut fake = with_files(&[".orca/drops/.gitignore"]);
        fake.fail.push((
            "files.delete",
            0,
            error("Orca がエラーを返しました（runtime_error）", "EPERM"),
        ));
        assert!(run(&mut fake, b"abc").await.is_ok());
    }

    #[tokio::test]
    async fn a_stat_that_fails_for_another_reason_is_the_uploads_failure() {
        let mut fake = Fake::default();
        fake.fail.push((
            "files.stat",
            0,
            error("Orca がエラーを返しました（forbidden）", "no"),
        ));
        let failed = run(&mut fake, b"abc").await.unwrap_err();
        assert!(failed.contains("forbidden"));
        assert_eq!(methods(&fake), ["files.stat"]);
        let mut fake = Fake::default();
        fake.fail.push((
            "files.stat",
            0,
            error(
                "Orca に接続できません。Orca が起動しているか確認してください",
                "",
            ),
        ));
        assert!(run(&mut fake, b"abc").await.is_err());
    }

    #[tokio::test]
    async fn a_trailing_slash_of_the_worktree_does_not_double_in_the_path() {
        let mut fake = with_files(&[".orca/drops/.gitignore"]);
        let file = upload(&mut fake, "/work/a/", "local", "shot.png", b"abc", "r")
            .await
            .unwrap();
        assert_eq!(file, "/work/a/.orca/drops/shot.png");
    }

    #[test]
    fn a_random_part_is_sixteen_hex_digits_and_differs() {
        let (a, b) = (random_hex().unwrap(), random_hex().unwrap());
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
