//! The senders whose external images are shown without asking: a list of addresses in the settings folder.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, State};
use tokio::{sync::Mutex, task::spawn_blocking};

use crate::{accounts::write_atomic, auth::config_dir};

const FILE: &str = "image_senders.json";

#[derive(Deserialize)]
struct SendersFile {
    senders: Vec<String>,
}

/// The address of a `From` value, lowercased: `Name <a@example.com>` and `a@example.com` give `a@example.com`.
/// `None` when no single address can be read from it.
pub fn sender_address(from: &str) -> Option<String> {
    let inner = match from.rfind('<') {
        Some(i) => from[i + 1..].split_once('>')?.0,
        None => from,
    };
    let address = inner.trim().to_lowercase();
    let (local, domain) = address.split_once('@')?;
    let plain = address
        .chars()
        .all(|c| !c.is_whitespace() && !c.is_control() && !"<>()[],;:\"\\".contains(c));
    (plain && !local.is_empty() && !domain.is_empty() && !domain.contains('@')).then_some(address)
}

/// `text` without its RFC 5322 comments: `dmarc=pass (p=NONE) header.from=x` becomes `dmarc=pass  header.from=x`.
fn strip_comments(text: &str) -> String {
    let mut depth = 0u32;
    text.chars()
        .filter(|&c| match c {
            '(' => {
                depth += 1;
                false
            }
            ')' if depth > 0 => {
                depth -= 1;
                false
            }
            _ => depth == 0,
        })
        .collect()
}

/// The domain of an `Authentication-Results` property value: `@example.com` and `a@example.com` give `example.com`.
fn property_domain(value: &str) -> String {
    let domain = value.rsplit('@').next().unwrap_or_default();
    domain.trim_end_matches('.').to_lowercase()
}

/// Whether Gmail vouches for the sender of `from`. `results` are the `Authentication-Results` headers of the message;
/// only the ones Gmail itself added (`mx.google.com`) count. They vouch when they say `dmarc=pass`,
/// or `dkim=pass` for the very domain of `from`. Without a readable address in `from`, nothing does.
pub fn authenticated(results: &[&str], from: &str) -> bool {
    let Some(address) = sender_address(from) else {
        return false;
    };
    let from_domain = property_domain(&address);
    results.iter().any(|result| {
        let result = strip_comments(result);
        let mut parts = result.split(';');
        if parts.next().and_then(|id| id.split_whitespace().next()) != Some("mx.google.com") {
            return false;
        }
        parts.any(|info| {
            let mut words = info.split_whitespace();
            let Some((method, outcome)) = words.next().and_then(|w| w.split_once('=')) else {
                return false;
            };
            if !outcome.eq_ignore_ascii_case("pass") {
                return false;
            }
            let property = |name: &str| {
                info.split_whitespace()
                    .filter_map(|w| w.split_once('='))
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| property_domain(v))
            };
            match method.to_ascii_lowercase().as_str() {
                // The domain DMARC checked is the one of From; if the header names it, it must be this one.
                "dmarc" => property("header.from").is_none_or(|d| d == from_domain),
                "dkim" => property("header.d")
                    .or_else(|| property("header.i"))
                    .is_some_and(|d| d == from_domain),
                _ => false,
            }
        })
    })
}

pub fn is_known(senders: &[String], from: &str) -> bool {
    sender_address(from).is_some_and(|a| senders.contains(&a))
}

/// Adds the sender of `from` unless it is listed or has no readable address.
pub fn with_sender(mut senders: Vec<String>, from: &str) -> Vec<String> {
    if let Some(address) = sender_address(from).filter(|a| !senders.contains(a)) {
        senders.push(address);
    }
    senders
}

/// An empty list when image_senders.json does not exist yet.
fn load(dir: &Path) -> Result<Vec<String>, String> {
    let path = dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<SendersFile>(&text)
            .map(|f| f.senders)
            .map_err(|e| format!("{} の形式が不正です: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

fn save(dir: &Path, senders: &[String]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&serde_json::json!({ "senders": senders }))
        .map_err(|e| e.to_string())?;
    write_atomic(dir, FILE, &text)
}

/// The remembered senders, read from the file on first use. The lock is held through a write, so changes keep their order.
#[derive(Default)]
pub struct ImageSenders(Mutex<Option<Vec<String>>>);

/// Runs the file work off the async threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    spawn_blocking(work).await.map_err(|e| e.to_string())?
}

impl ImageSenders {
    async fn loaded(
        &self,
        dir: &Path,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<Vec<String>>>, String> {
        let mut senders = self.0.lock().await;
        if senders.is_none() {
            let dir: PathBuf = dir.to_owned();
            *senders = Some(blocking(move || load(&dir)).await?);
        }
        Ok(senders)
    }

    /// Adds the sender of `from` to the list and saves it; the list in memory changes only once the file did.
    /// Nothing is written when the sender is listed already or has no readable address.
    async fn remember(&self, dir: PathBuf, from: String) -> Result<(), String> {
        let mut senders = self.loaded(&dir).await?;
        let current = senders.as_deref().unwrap_or_default();
        let new = with_sender(current.to_vec(), &from);
        if new.len() == current.len() {
            return Ok(());
        }
        *senders = Some(
            blocking(move || {
                save(&dir, &new)?;
                Ok(new)
            })
            .await?,
        );
        Ok(())
    }
}

/// The ones of `froms` whose sender is remembered.
#[tauri::command]
pub async fn image_sender_known(
    app: AppHandle,
    senders: State<'_, ImageSenders>,
    froms: Vec<String>,
) -> Result<Vec<String>, String> {
    let list = senders.loaded(&config_dir(&app)?).await?;
    let list = list.as_deref().unwrap_or_default();
    Ok(froms.into_iter().filter(|f| is_known(list, f)).collect())
}

/// Remembers the sender of `from`.
#[tauri::command]
pub async fn remember_image_sender(
    app: AppHandle,
    senders: State<'_, ImageSenders>,
    from: String,
) -> Result<(), String> {
    senders.remember(config_dir(&app)?, from).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-senders-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn sender_address_takes_the_lowercased_address_of_any_from_form() {
        for (from, want) in [
            ("Alice <Alice@Example.COM>", "alice@example.com"),
            ("a@example.com", "a@example.com"),
            ("  <a@example.com> ", "a@example.com"),
            (r#""Doe, John" <j@x.com>"#, "j@x.com"),
            // The display name can hold another address; the one in the angle brackets is the sender.
            (r#""boss@corp.com" <spam@x.com>"#, "spam@x.com"),
        ] {
            assert_eq!(sender_address(from).as_deref(), Some(want), "{from}");
        }
    }

    #[test]
    fn sender_address_refuses_what_is_not_a_single_address() {
        for from in [
            "",
            "Alice",
            "Alice <>",
            "Alice <a@example.com",
            "<@example.com>",
            "<a@>",
            "a@b@c.com",
            "a b@c.com",
            "a@c.com, b@c.com",
        ] {
            assert_eq!(sender_address(from), None, "{from}");
        }
    }

    const MX: &str = "mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=AbC; spf=pass (google.com: domain of a@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=a@example.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com";

    #[test]
    fn authenticated_takes_dmarc_pass_or_dkim_pass_for_the_from_domain() {
        let from = "Alice <a@example.com>";
        assert!(authenticated(&[MX], from));
        // dmarc=pass alone, in any case, and with the DKIM domain of a subdomain or another signer.
        assert!(authenticated(
            &["mx.google.com; DMARC=Pass header.from=Example.com"],
            from
        ));
        assert!(authenticated(
            &["mx.google.com; dmarc=pass (p=NONE) header.from=example.com"],
            "Bob <b@Example.com>"
        ));
        // dkim=pass alone, with header.d or header.i, a mailbox-style header.i, and several headers.
        assert!(authenticated(
            &["mx.google.com; dkim=pass header.d=example.com"],
            from
        ));
        assert!(authenticated(
            &["mx.google.com; dkim=pass header.i=news@example.com"],
            from
        ));
        assert!(authenticated(
            &[
                "other.example; dmarc=pass",
                "mx.google.com; dkim=pass header.d=example.com"
            ],
            from
        ));
        // The authserv-id may carry a version.
        assert!(authenticated(
            &["mx.google.com 1; dmarc=pass header.from=example.com"],
            from
        ));
    }

    #[test]
    fn authenticated_refuses_anything_else() {
        let from = "Alice <a@example.com>";
        for results in [
            // No header at all.
            vec![],
            // Not added by Gmail: a sender can write any header.
            vec!["evil.example; dmarc=pass header.from=example.com"],
            vec!["mx.google.com.evil.example; dmarc=pass"],
            // Failed, softfailed, or missing results.
            vec!["mx.google.com; dmarc=fail header.from=example.com; dkim=pass header.d=other.example"],
            vec!["mx.google.com; dkim=neutral header.d=example.com; spf=pass smtp.mailfrom=a@example.com"],
            vec!["mx.google.com; dkim=none"],
            vec!["mx.google.com"],
            // dkim=pass for a domain other than From's, even one that merely ends the same way.
            vec!["mx.google.com; dkim=pass header.d=other.example"],
            vec!["mx.google.com; dkim=pass header.d=badexample.com"],
            vec!["mx.google.com; dkim=pass header.i=@sub.example.com"],
            // dmarc=pass that names a different From domain.
            vec!["mx.google.com; dmarc=pass header.from=other.example"],
            // A pass written inside a comment is no result.
            vec!["mx.google.com; dmarc=fail (dmarc=pass header.from=example.com)"],
            // spf alone does not tie to From.
            vec!["mx.google.com; spf=pass smtp.mailfrom=a@example.com"],
        ] {
            assert!(!authenticated(&results, from), "{results:?}");
        }
        // A From with no readable address is never vouched for.
        assert!(!authenticated(&[MX], "no address"));
    }

    #[test]
    fn senders_are_matched_by_address_and_listed_once() {
        let list = with_sender(vec![], "Alice <A@x.com>");
        let list = with_sender(list, "other name <a@X.com>");
        let list = with_sender(list, "b@x.com");
        assert_eq!(list, ["a@x.com", "b@x.com"]);
        assert!(is_known(&list, "Anyone <A@x.com>"));
        assert!(!is_known(&list, "c@x.com"));
        assert!(!is_known(&list, "no address"));
        // A From with no readable address adds nothing.
        assert_eq!(with_sender(list.clone(), "no address"), list);
    }

    #[test]
    fn load_is_empty_without_file_and_save_creates_dir_and_file() {
        let dir = temp_dir("save");
        assert_eq!(load(&dir), Ok(vec![]));
        save(&dir, &["a@x.com".to_string()]).unwrap();
        assert_eq!(load(&dir), Ok(vec!["a@x.com".to_string()]));
        save(&dir, &["b@x.com".to_string()]).unwrap();
        assert_eq!(load(&dir), Ok(vec!["b@x.com".to_string()]));
        assert!(!dir.join("image_senders.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failed_save_leaves_the_existing_file_untouched() {
        let dir = temp_dir("atomic");
        save(&dir, &["a@x.com".to_string()]).unwrap();
        // A directory in the temporary file's place makes the write fail before the rename.
        std::fs::create_dir(dir.join("image_senders.json.tmp")).unwrap();
        assert!(save(&dir, &["b@x.com".to_string()]).is_err());
        assert_eq!(load(&dir), Ok(vec!["a@x.com".to_string()]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn load_reports_a_broken_file() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load(&dir).unwrap_err().contains("形式が不正"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
