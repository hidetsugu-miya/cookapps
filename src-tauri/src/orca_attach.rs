//! A-10: an image attached in the composer of the Orca screen. The image is put in `.orca/drops/` of the destination worktree through Orca's runtime (`files.*`), on this machine over its unix socket and on a paired server over its WebSocket,
//! and the screen puts the path of the file in the text it posts, so Claude reads the image from that path.
//! The `files.*` calls are not a public interface of Orca: this was written against Orca 1.4.248. A token is in no log line, no error text and no return value; the image is in no log line either.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use crate::{
    orca::{check_path, worktree_host},
    orca_chat::{CallError, Connection},
};

/// The most an image may be, in bytes of the decoded file.
const MAX_IMAGE: usize = 20 * 1024 * 1024;
/// The bytes of a file one `files.writeBase64Chunk` carries: a larger frame closes the host's socket.
const CHUNK: usize = 384 * 1024;
/// Where the files go, inside the worktree.
const DROPS: &str = ".orca/drops";
/// Characters of the stem of a file name. A file name is at most 255 bytes, and the temporary one adds a suffix.
const STEM_LIMIT: usize = 40;
/// The characters a shell reads as more than a name: Orca's own paste of an image path (`shared/image-path-paste.js`) escapes the same ones.
const SHELL_SPECIAL: &str = " \"'`$;&|<>(){}[]*?!#\\";
const NOT_AN_IMAGE: &str = "画像（PNG、JPEG、GIF、WebP）だけを添付できます";

/// The call of one Orca, so that the upload is the same code for a unit test and for the real connection.
trait Rpc {
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

/// The decoded image: base64 that is not too long, decoded, not empty, not over the limit.
fn decode(data: &str) -> Result<Vec<u8>, String> {
    let too_large = || format!("画像は {} MiB までです", MAX_IMAGE / 1024 / 1024);
    // Four characters are three bytes: refuse before the decode makes the copy.
    if data.len() > MAX_IMAGE / 3 * 4 + 8 {
        return Err(too_large());
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "画像を読めません".to_owned())?;
    if bytes.is_empty() {
        return Err("画像を読めません".into());
    }
    if bytes.len() > MAX_IMAGE {
        return Err(too_large());
    }
    Ok(bytes)
}

/// The stem of the file name, from the name the screen gave: one path element without its extension, with only Unicode letters, digits, `-` and `_` (others become `-`, so there is no dot and no space),
/// cut to `STEM_LIMIT` characters and trimmed of `-` at both ends; `image` when nothing is left.
fn file_stem(name: &str) -> String {
    let element = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let stem = element.rsplit_once('.').map_or(element, |(stem, _)| stem);
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(STEM_LIMIT)
        .collect();
    let stem = stem.trim_matches('-');
    if stem.is_empty() {
        "image".into()
    } else {
        stem.to_owned()
    }
}

/// The path as the text for Claude: the bare path, each blank and shell character with a backslash before it (Claude reads the image from such a path). A control character is refused, for it would end the line or the command.
fn escape_path(path: &str) -> Result<String, String> {
    if path.chars().any(char::is_control) {
        return Err("画像の保存先に使えない文字が含まれています".into());
    }
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if SHELL_SPECIAL.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    Ok(out)
}

/// An SSH host has no file calls (its `hostId` is `ssh:{id}`): only this machine and a paired server take an image.
fn check_host(host_id: &str) -> Result<(), String> {
    if host_id.starts_with("ssh:") {
        Err("SSH の接続先の worktree には画像を添付できません".into())
    } else {
        Ok(())
    }
}

/// The message of a failed call. A pairing of the `mobile` scope is refused by Orca with `forbidden`, which the code alone does not explain.
fn reason(error: CallError) -> String {
    if error.shown.contains("forbidden") {
        format!(
            "この接続先のペアリングにはファイルを置く権限がないため、画像を添付できません。{}",
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
fn worktree_params(path: &str, host_id: Option<&str>, mut params: Value) -> Value {
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

/// Puts `bytes` in `.orca/drops/` of the worktree at `path` under the name `{stem}.{ext}`, or `{stem}-{random}.{ext}` when that exists (one `files.stat`), and gives the absolute path of the file.
/// The file is written in chunks to a temporary name (`random` makes it one of its own) and copied to its name, which fails when the name exists, so a file is never overwritten; the temporary file goes in every case.
/// `.orca/drops/.gitignore` (`*`) is written first when it is missing, so the images do not show as changes, and a failure of that is ignored.
async fn upload(
    rpc: &mut impl Rpc,
    path: &str,
    host_id: &str,
    stem: &str,
    ext: &str,
    bytes: &[u8],
    random: &str,
) -> Result<String, String> {
    let ignore = format!("{DROPS}/.gitignore");
    if !exists(rpc, path, &ignore).await? {
        let _ = write_chunk(rpc, path, host_id, &ignore, b"*\n", false).await;
    }
    let name = if exists(rpc, path, &format!("{DROPS}/{stem}.{ext}")).await? {
        format!("{stem}-{random}.{ext}")
    } else {
        format!("{stem}.{ext}")
    };
    let temporary = format!("{DROPS}/.{name}.orca-upload-{random}");
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

/// The image of `data` (base64) checked: its extension by what the bytes are, and the stem of its file name.
fn prepare(name: &str, data: &str) -> Result<(String, &'static str, Vec<u8>), String> {
    let bytes = decode(data)?;
    let ext = image_ext(&bytes).ok_or(NOT_AN_IMAGE)?;
    Ok((file_stem(name), ext, bytes))
}

/// A-10: puts the image `data` (base64) in `.orca/drops/` of the worktree at `path` (one of the target's list read just now) and answers the text for Claude: the absolute path of the file, with the escapes of `escape_path`.
/// `name` only gives the file name a stem; the kind of the image is read from its bytes.
#[tauri::command]
pub async fn orca_attach_image(
    path: String,
    name: String,
    data: String,
    environment: Option<String>,
) -> Result<String, String> {
    check_path(&path)?;
    let (stem, ext, bytes) = prepare(&name, &data)?;
    let host_id = {
        let (path, environment) = (path.clone(), environment.clone());
        tokio::task::spawn_blocking(move || worktree_host(&path, environment.as_deref()))
            .await
            .map_err(|e| e.to_string())??
    };
    check_host(&host_id)?;
    let mut connection = Connection::open(environment).await?;
    let file = upload(
        &mut connection,
        &path,
        &host_id,
        &stem,
        ext,
        &bytes,
        &random_hex()?,
    )
    .await?;
    escape_path(&file)
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
        upload(fake, "/work/a", "local", "shot", "png", bytes, "r4nd").await
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
        let at_limit = vec![0u8; MAX_IMAGE];
        assert_eq!(
            decode(&STANDARD.encode(&at_limit)).unwrap().len(),
            MAX_IMAGE
        );
        let over = vec![0u8; MAX_IMAGE + 1];
        assert!(decode(&STANDARD.encode(&over))
            .unwrap_err()
            .contains("20 MiB"));
        // Too long to be worth decoding.
        assert!(decode(&"A".repeat(MAX_IMAGE / 3 * 4 + 12))
            .unwrap_err()
            .contains("20 MiB"));
    }

    #[test]
    fn prepare_takes_the_extension_from_the_bytes_and_refuses_what_is_not_an_image() {
        let png = STANDARD.encode([PNG, b"data"].concat());
        let (stem, ext, bytes) = prepare("photo.jpeg", &png).unwrap();
        assert_eq!((stem.as_str(), ext), ("photo", "png"));
        assert_eq!(bytes.len(), 12);
        for text in [&b"<svg/>"[..], b"hello"] {
            assert_eq!(
                prepare("a.png", &STANDARD.encode(text)).unwrap_err(),
                NOT_AN_IMAGE
            );
        }
        assert!(prepare("a.png", "!!").is_err());
    }

    #[test]
    fn a_stem_is_one_path_element_of_safe_characters() {
        for (name, stem) in [
            ("photo.png", "photo"),
            ("photo", "photo"),
            ("my photo (1).png", "my-photo--1"),
            ("a.b.c.png", "a-b-c"),
            ("/etc/passwd.png", "passwd"),
            ("C:\\Users\\me\\shot.png", "shot"),
            ("../../x.png", "x"),
            (".hidden.png", "hidden"),
            (".png", "image"),
            ("", "image"),
            ("...", "image"),
            ("???.png", "image"),
            ("スクリーンショット 2026.png", "スクリーンショット-2026"),
            ("under_score-dash.png", "under_score-dash"),
            ("a/", "image"),
        ] {
            assert_eq!(file_stem(name), stem, "{name}");
        }
        let long = file_stem(&format!("{}.png", "あ".repeat(100)));
        assert_eq!(long.chars().count(), STEM_LIMIT);
        assert!(long.len() + "-0123456789abcdef.webp.orca-upload-0123456789abcdef".len() < 255);
    }

    #[test]
    fn a_path_is_escaped_for_the_shell_and_never_holds_a_control_character() {
        assert_eq!(
            escape_path("/work/a/.orca/drops/shot.png").unwrap(),
            "/work/a/.orca/drops/shot.png"
        );
        assert_eq!(
            escape_path("/Users/me/my work/.orca/drops/shot copy.png").unwrap(),
            "/Users/me/my\\ work/.orca/drops/shot\\ copy.png"
        );
        assert_eq!(
            escape_path("/a\"b'c`d$e;f&g|h<i>j(k)l{m}n[o]p*q?r!s#t\\u/x.png").unwrap(),
            "/a\\\"b\\'c\\`d\\$e\\;f\\&g\\|h\\<i\\>j\\(k\\)l\\{m\\}n\\[o\\]p\\*q\\?r\\!s\\#t\\\\u/x.png"
        );
        // Characters that are not special stay: `~`, `=`, `%`, `,`, `@`, `+`, `:` and non-ASCII.
        assert_eq!(escape_path("/~=%,@+:/é.png").unwrap(), "/~=%,@+:/é.png");
        for bad in ["/a\nb/x.png", "/a\rb", "/a\tb", "/a\0b", "/a\u{1b}[0m"] {
            assert!(escape_path(bad).is_err(), "{bad:?}");
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
                "files.stat",
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
        assert_eq!(call(2)["relativePath"], ".orca/drops/shot.png");
        // Chunks of the temporary file: the first creates it, the others append.
        let temporary = ".orca/drops/.shot.png.orca-upload-r4nd";
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
                "files.stat",
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
    async fn a_taken_name_gets_the_random_part_after_one_stat() {
        let mut fake = with_files(&[".orca/drops/.gitignore", ".orca/drops/shot.png"]);
        let file = run(&mut fake, b"abc").await.unwrap();
        assert_eq!(file, "/work/a/.orca/drops/shot-r4nd.png");
        let stats = methods(&fake)
            .iter()
            .filter(|m| **m == "files.stat")
            .count();
        assert_eq!(stats, 2);
        let commit = fake
            .calls
            .iter()
            .find(|(m, _)| m == "files.commitUpload")
            .unwrap();
        assert_eq!(commit.1["finalRelativePath"], ".orca/drops/shot-r4nd.png");
        assert_eq!(
            commit.1["tempRelativePath"],
            ".orca/drops/.shot-r4nd.png.orca-upload-r4nd"
        );
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
        let file = upload(&mut fake, "/work/a/", "local", "shot", "png", b"abc", "r")
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
