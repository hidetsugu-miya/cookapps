//! M-12: the files of a mail being written. The screen holds the bytes of each file in memory only (no file, no log), and `send_mail` takes them with the mail (`mail_send.rs`).
//! What lives here is what Rust decides before a file is held: whether a file may be added (`mail_attach_check`, for a file dropped or pasted, which the page reads) and the pick of files in the open dialog (`mail_attach_pick`), where the place is the dialog's alone: the page gives no path.

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
#[cfg(test)]
use ts_rs::TS;

use crate::mail_send::{check_attachment, MAX_ATTACHMENTS};

/// A file the open dialog picked: its name, its size, and its bytes as base64.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct PickedAttachment {
    pub name: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub size: u64,
    pub data: String,
}

/// Whether the file may be added to a mail that holds `held` bytes of files already. A refusal is a Japanese message.
#[tauri::command]
pub fn mail_attach_check(name: String, size: u64, held: u64) -> Result<(), String> {
    check_attachment(&name, size, held)
}

/// The last part of the path, which is the name the mail carries.
fn name_of(path: &Path) -> Result<String, String> {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "ファイルの場所が正しくありません".to_owned())
}

/// Reads the files at `paths`, one after another, with `held` bytes of files in the mail already. One that may not be added, or cannot be read, refuses all of them: nothing is returned.
fn read_picked(paths: &[PathBuf], held: u64) -> Result<Vec<PickedAttachment>, String> {
    let mut total = held;
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let name = name_of(path)?;
        let unreadable = || format!("{name} を読めません");
        let meta = std::fs::metadata(path).map_err(|_| unreadable())?;
        if !meta.is_file() {
            return Err(format!("{name} はファイルではありません"));
        }
        check_attachment(&name, meta.len(), total)?;
        // The file may have grown since its size was read: the read stops one byte past what may still be added, and the size read is checked again.
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        File::open(path)
            .and_then(|f| f.take(MAX_ATTACHMENTS - total + 1).read_to_end(&mut bytes))
            .map_err(|_| unreadable())?;
        let size = bytes.len() as u64;
        check_attachment(&name, size, total)?;
        total += size;
        out.push(PickedAttachment {
            name,
            size,
            data: STANDARD.encode(&bytes),
        });
    }
    Ok(out)
}

/// Opens the dialog that picks files (one or several) and answers them, read; an empty list when the dialog was cancelled.
#[tauri::command]
pub async fn mail_attach_pick(
    app: AppHandle,
    window: WebviewWindow,
    held: u64,
) -> Result<Vec<PickedAttachment>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .pick_files(move |picked| {
            let _ = sender.send(picked);
        });
    let Some(picked) = receiver
        .await
        .map_err(|_| "ファイルを選べません".to_owned())?
    else {
        return Ok(Vec::new());
    };
    let paths = picked
        .into_iter()
        .map(|p| {
            p.into_path()
                .map_err(|_| "ファイルの場所が正しくありません".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    tokio::task::spawn_blocking(move || read_picked(&paths, held))
        .await
        .map_err(|_| "ファイルを読めません".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tsunagiai-attach-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_check_is_the_one_the_send_makes() {
        assert!(mail_attach_check("a.txt".into(), 10, 0).is_ok());
        assert_eq!(
            mail_attach_check("a.txt".into(), 1, MAX_ATTACHMENTS),
            Err("添付の合計は 25 MB までです".into())
        );
        assert_eq!(
            mail_attach_check("a.txt".into(), 0, 0),
            Err("a.txt は空のファイルです".into())
        );
    }

    #[test]
    fn reads_the_picked_files_with_their_names_sizes_and_bytes() {
        let dir = temp_dir("read");
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();
        std::fs::write(dir.join("請求書.pdf"), [0u8, 255, 7]).unwrap();
        let got = read_picked(&[dir.join("a.txt"), dir.join("請求書.pdf")], 0).unwrap();
        assert_eq!(
            got,
            [
                PickedAttachment {
                    name: "a.txt".into(),
                    size: 5,
                    data: STANDARD.encode("hello")
                },
                PickedAttachment {
                    name: "請求書.pdf".into(),
                    size: 3,
                    data: STANDARD.encode([0u8, 255, 7])
                },
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn one_file_that_may_not_be_added_refuses_every_file() {
        let dir = temp_dir("refuse");
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();
        std::fs::write(dir.join("empty.txt"), b"").unwrap();
        std::fs::create_dir(dir.join("folder")).unwrap();
        assert_eq!(
            read_picked(&[dir.join("a.txt"), dir.join("empty.txt")], 0),
            Err("empty.txt は空のファイルです".into())
        );
        assert_eq!(
            read_picked(&[dir.join("a.txt"), dir.join("folder")], 0),
            Err("folder はファイルではありません".into())
        );
        assert_eq!(
            read_picked(&[dir.join("missing.txt")], 0),
            Err("missing.txt を読めません".into())
        );
        // The files already in the mail count, and so do the ones read before.
        assert_eq!(
            read_picked(&[dir.join("a.txt")], MAX_ATTACHMENTS - 4),
            Err("添付の合計は 25 MB までです".into())
        );
        assert!(read_picked(&[dir.join("a.txt")], MAX_ATTACHMENTS - 5).is_ok());
        assert_eq!(
            read_picked(&[dir.join("a.txt"), dir.join("a.txt")], MAX_ATTACHMENTS - 9),
            Err("添付の合計は 25 MB までです".into())
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_over_the_limit_is_refused_before_it_is_read() {
        let dir = temp_dir("big");
        let big = File::create(dir.join("big.bin")).unwrap();
        big.set_len(MAX_ATTACHMENTS + 1).unwrap();
        assert_eq!(
            read_picked(&[dir.join("big.bin")], 0),
            Err("添付の合計は 25 MB までです".into())
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_path_with_no_name_is_refused() {
        assert_eq!(
            read_picked(&[PathBuf::from("/")], 0),
            Err("ファイルの場所が正しくありません".into())
        );
    }
}
