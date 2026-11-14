//! The threads `thread` has answered, held in memory for the run (never in a file), so that a thread opened again
//! is drawn at once while Gmail is asked again (M-2).

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use serde::Serialize;
#[cfg(test)]
use ts_rs::TS;

use super::{inline_key, InlineCache, MessageDetail, ThreadDetail};
use crate::images::{cid_refs, replace_cids};

/// Cap of `HeldThreads`, in bytes of the text they hold. A body carries its inlined images as data: URIs, up to
/// 27 MB a thread (`INLINE_CACHE_BYTES`), so this holds at least two threads of the largest size, and several
/// hundred threads of ordinary mail (about 100 KB each). It is the cap of the two image caches.
pub(super) const HELD_THREAD_BYTES: usize = 64 * 1024 * 1024;

/// Which thread: (account, thread ID).
type Key = (String, String);

struct Entry {
    /// Names this answer: `thread_refresh` compares with the entry only while it is the one the screen drew.
    stamp: u32,
    bytes: usize,
    detail: Arc<ThreadDetail>,
}

#[derive(Default)]
struct Entries {
    /// The stamp of the last entry put.
    last: u32,
    bytes: usize,
    threads: HashMap<Key, Entry>,
    /// The keys in the order they were put, the oldest first.
    order: VecDeque<Key>,
}

/// The last answer of `thread` (or `thread_refresh`) for each thread, capped in bytes. When a new one does not fit, the oldest go first.
#[derive(Default)]
pub struct HeldThreads(Mutex<Entries>);

impl HeldThreads {
    /// Holds `detail` as the thread's last answer. One larger than `limit` is not held, and what was held of the thread goes.
    pub(super) fn put(&self, limit: usize, account: &str, id: &str, detail: Arc<ThreadDetail>) {
        let e = &mut *self.0.lock().unwrap();
        let key = (account.to_owned(), id.to_owned());
        if let Some(old) = e.threads.remove(&key) {
            e.bytes -= old.bytes;
            e.order.retain(|k| *k != key);
        }
        let bytes = size(&detail);
        if bytes > limit {
            return;
        }
        while e.bytes + bytes > limit {
            let Some(oldest) = e.order.pop_front() else {
                break;
            };
            if let Some(gone) = e.threads.remove(&oldest) {
                e.bytes -= gone.bytes;
            }
        }
        e.last = e.last.wrapping_add(1);
        e.bytes += bytes;
        e.order.push_back(key.clone());
        let stamp = e.last;
        e.threads.insert(
            key,
            Entry {
                stamp,
                bytes,
                detail,
            },
        );
    }

    /// What is held of the thread, with its stamp.
    pub(super) fn get(&self, account: &str, id: &str) -> Option<(u32, Arc<ThreadDetail>)> {
        let e = self.0.lock().unwrap();
        let entry = e.threads.get(&(account.to_owned(), id.to_owned()))?;
        Some((entry.stamp, Arc::clone(&entry.detail)))
    }

    /// Drops every thread of `account`.
    pub fn forget(&self, account: &str) {
        let e = &mut *self.0.lock().unwrap();
        e.threads.retain(|k, _| k.0 != account);
        e.order.retain(|k| e.threads.contains_key(k));
        e.bytes = e.threads.values().map(|t| t.bytes).sum();
    }
}

/// The bytes of text in `d`: what it costs to hold.
fn size(d: &ThreadDetail) -> usize {
    let messages: usize = d
        .messages
        .iter()
        .map(|m| {
            [
                &m.id,
                &m.from,
                &m.from_name,
                &m.from_address,
                &m.to,
                &m.to_label,
                &m.snippet,
                &m.body,
            ]
            .iter()
            .map(|s| s.len())
            .sum::<usize>()
        })
        .sum();
    let pending: usize = d
        .pending_images
        .iter()
        .map(|p| {
            p.message_id.len()
                + p.cid.len()
                + p.attachment_id.len()
                + p.mime.len()
                + p.references.iter().map(String::len).sum::<usize>()
        })
        .sum();
    d.subject.len() + messages + pending
}

/// `held` as `thread` would answer it now: the images it left to fetch that are in the cache meanwhile
/// (`thread_images` fetched them) are inlined, as `fetch_thread` inlines them, and only the others stay pending.
pub(super) fn with_cached_images(
    cache: &InlineCache,
    account: &str,
    held: &Arc<ThreadDetail>,
) -> Arc<ThreadDetail> {
    let mut uris: HashMap<&str, HashMap<String, Arc<str>>> = HashMap::new();
    let mut pending_images = Vec::new();
    for p in &held.pending_images {
        match cache.get(&inline_key(account, &p.message_id, &p.cid)) {
            Some(uri) => {
                uris.entry(&p.message_id)
                    .or_default()
                    .insert(p.cid.clone(), uri);
            }
            None => pending_images.push(p.clone()),
        }
    }
    if uris.is_empty() {
        return Arc::clone(held);
    }
    let messages = held
        .messages
        .iter()
        .map(|m| match uris.get(m.id.as_str()) {
            Some(uris) => MessageDetail {
                body: replace_cids(&m.body, &cid_refs(&m.body), uris),
                ..without_body(m)
            },
            None => m.clone(),
        })
        .collect();
    Arc::new(ThreadDetail {
        subject: held.subject.clone(),
        unread: held.unread,
        messages,
        pending_images,
    })
}

/// `m` with an empty body, so that a body about to be replaced is not copied first.
fn without_body(m: &MessageDetail) -> MessageDetail {
    MessageDetail {
        id: m.id.clone(),
        from: m.from.clone(),
        from_name: m.from_name.clone(),
        from_address: m.from_address.clone(),
        to: m.to.clone(),
        to_label: m.to_label.clone(),
        date_ms: m.date_ms,
        snippet: m.snippet.clone(),
        html: m.html,
        body: String::new(),
        authenticated: m.authenticated,
    }
}

/// Whether the screen that drew `shown` would draw the same from `fresh`: the subject, the messages and the images
/// left to fetch. `unread` is not drawn, and Gmail may hand out a new attachment ID at every read, so neither counts.
fn same_drawing(shown: &ThreadDetail, fresh: &ThreadDetail) -> bool {
    fn images(d: &ThreadDetail) -> Vec<(&String, &String, &String, &Vec<String>)> {
        d.pending_images
            .iter()
            .map(|p| (&p.message_id, &p.cid, &p.mime, &p.references))
            .collect()
    }
    shown.subject == fresh.subject
        && shown.messages == fresh.messages
        && images(shown) == images(fresh)
}

/// What `thread_held` answers: the held copy to draw at once, and the stamp to give `thread_refresh`.
#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct HeldThread {
    pub(super) stamp: u32,
    pub(super) thread: Arc<ThreadDetail>,
}

/// What `thread_refresh` answers once Gmail has answered.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadRefresh {
    /// Some message of the thread carries the UNREAD label now (the held copy's own `unread` is from the earlier read).
    unread: bool,
    /// The thread to draw in place of the held copy; `None` when the screen already shows the same.
    pub(super) thread: Option<Arc<ThreadDetail>>,
}

/// `shown` is what the screen drew (`None` when it is not known any more): `fresh` goes to the screen only when it draws differently.
pub(super) fn refresh_answer(
    shown: Option<&ThreadDetail>,
    fresh: Arc<ThreadDetail>,
) -> ThreadRefresh {
    let same = shown.is_some_and(|shown| same_drawing(shown, &fresh));
    ThreadRefresh {
        unread: fresh.unread,
        thread: (!same).then_some(fresh),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::PendingImage;

    fn message(id: &str, body: &str) -> MessageDetail {
        MessageDetail {
            id: id.into(),
            from: "Alice <alice@example.com>".into(),
            from_name: "Alice".into(),
            from_address: "alice@example.com".into(),
            to: "me@example.com".into(),
            to_label: "To 自分".into(),
            date_ms: 1,
            snippet: String::new(),
            html: true,
            body: body.into(),
            authenticated: false,
        }
    }

    fn detail(bodies: &[&str]) -> ThreadDetail {
        ThreadDetail {
            subject: "s".into(),
            unread: false,
            messages: bodies
                .iter()
                .enumerate()
                .map(|(n, body)| message(&format!("m{n}"), body))
                .collect(),
            pending_images: Vec::new(),
        }
    }

    fn pending(message_id: &str, cid: &str, attachment_id: &str) -> PendingImage {
        PendingImage {
            message_id: message_id.into(),
            cid: cid.into(),
            attachment_id: attachment_id.into(),
            mime: "image/png".into(),
            references: vec![format!("cid:{cid}")],
        }
    }

    /// A thread of one message whose body is `n` bytes.
    fn sized(n: usize) -> Arc<ThreadDetail> {
        Arc::new(detail(&[&"x".repeat(n)]))
    }

    /// The cost of a thread with an empty body.
    fn overhead() -> usize {
        size(&detail(&[""]))
    }

    #[test]
    fn holds_the_last_answer_of_each_thread_with_a_new_stamp() {
        let held = HeldThreads::default();
        assert!(held.get("a", "t1").is_none());
        held.put(1000, "a", "t1", Arc::new(detail(&["one"])));
        held.put(1000, "b", "t1", Arc::new(detail(&["other"])));
        let (first, d) = held.get("a", "t1").unwrap();
        assert_eq!(d.messages[0].body, "one");
        held.put(1000, "a", "t1", Arc::new(detail(&["two"])));
        let (second, d) = held.get("a", "t1").unwrap();
        assert_eq!(d.messages[0].body, "two");
        assert_ne!(first, second);
        assert_eq!(held.get("b", "t1").unwrap().1.messages[0].body, "other");
    }

    #[test]
    fn drops_the_oldest_threads_when_a_new_one_does_not_fit() {
        let held = HeldThreads::default();
        let limit = 3 * (overhead() + 100);
        for id in ["t1", "t2", "t3"] {
            held.put(limit, "a", id, sized(100));
        }
        // Put again, t1 is the newest: t2 is the oldest now.
        held.put(limit, "a", "t1", sized(100));
        held.put(limit, "a", "t4", sized(100));
        assert!(held.get("a", "t2").is_none());
        for id in ["t1", "t3", "t4"] {
            assert!(held.get("a", id).is_some(), "{id}");
        }
        // One that takes the whole cap leaves only itself.
        held.put(limit, "a", "t5", sized(limit - overhead()));
        for id in ["t1", "t3", "t4"] {
            assert!(held.get("a", id).is_none(), "{id}");
        }
        assert!(held.get("a", "t5").is_some());
        assert_eq!(held.0.lock().unwrap().bytes, limit);
    }

    #[test]
    fn does_not_hold_a_thread_over_the_cap_and_drops_what_it_held_of_it() {
        let held = HeldThreads::default();
        let limit = overhead() + 100;
        held.put(limit, "a", "t1", sized(100));
        held.put(limit, "a", "t1", sized(101));
        assert!(held.get("a", "t1").is_none());
        let e = held.0.lock().unwrap();
        assert_eq!((e.bytes, e.order.len()), (0, 0));
    }

    #[test]
    fn forgets_the_threads_of_one_account_only() {
        let held = HeldThreads::default();
        held.put(10_000, "a", "t1", sized(100));
        held.put(10_000, "b", "t1", sized(50));
        held.put(10_000, "a", "t2", sized(100));
        held.forget("a");
        assert!(held.get("a", "t1").is_none());
        assert!(held.get("a", "t2").is_none());
        assert!(held.get("b", "t1").is_some());
        let e = held.0.lock().unwrap();
        assert_eq!((e.bytes, e.order.len()), (overhead() + 50, 1));
    }

    #[test]
    fn counts_every_text_of_a_thread() {
        let mut d = detail(&["body"]);
        let before = size(&d);
        d.subject.push_str("12345");
        d.messages[0].snippet.push_str("123");
        d.pending_images.push(pending("m0", "c", "att"));
        let image = "m0".len() + "c".len() + "att".len() + "image/png".len() + "cid:c".len();
        assert_eq!(size(&d), before + 5 + 3 + image);
    }

    #[test]
    fn inlines_the_pending_images_that_are_cached_meanwhile() {
        let cache = InlineCache::default();
        let mut d = detail(&[
            r#"<img src="cid:one"><img src="cid:two">"#,
            r#"<img src="cid:one">"#,
        ]);
        d.pending_images = vec![
            pending("m0", "one", "a1"),
            pending("m0", "two", "a2"),
            pending("m1", "one", "a3"),
        ];
        let held = Arc::new(d);
        // Nothing cached: the held copy itself, not a copy of it.
        assert!(Arc::ptr_eq(
            &with_cached_images(&cache, "acc", &held),
            &held
        ));
        cache.put(1000, inline_key("acc", "m0", "two"), Arc::from("data:2"));
        cache.put(1000, inline_key("acc", "m1", "one"), Arc::from("data:3"));
        // Another account's image of the same message and Content-ID is not this one's.
        cache.put(1000, inline_key("other", "m0", "one"), Arc::from("data:x"));
        let now = with_cached_images(&cache, "acc", &held);
        assert_eq!(
            now.messages[0].body,
            r#"<img src="cid:one"><img src="data:2">"#
        );
        assert_eq!(now.messages[1].body, r#"<img src="data:3">"#);
        assert_eq!(now.pending_images, [pending("m0", "one", "a1")]);
        assert_eq!(now.subject, held.subject);
        assert_eq!(now.messages[0].from, held.messages[0].from);
    }

    #[test]
    fn answers_no_thread_when_the_screen_shows_the_same() {
        let mut shown = detail(&["<p>hello</p>"]);
        shown.unread = true;
        shown.pending_images = vec![pending("m0", "one", "old")];
        let mut fresh = detail(&["<p>hello</p>"]);
        // Read since, and Gmail handed out a new attachment ID: neither is drawn.
        fresh.pending_images = vec![pending("m0", "one", "new")];
        assert_eq!(
            refresh_answer(Some(&shown), Arc::new(fresh)),
            ThreadRefresh {
                unread: false,
                thread: None
            }
        );
    }

    #[test]
    fn answers_the_thread_when_it_draws_differently_or_the_shown_one_is_unknown() {
        let shown = detail(&["<p>hello</p>"]);
        let changed = |change: fn(&mut ThreadDetail)| {
            let mut fresh = detail(&["<p>hello</p>"]);
            change(&mut fresh);
            fresh
        };
        let cases: [fn(&mut ThreadDetail); 5] = [
            |d| d.subject.push('!'),
            |d| d.messages.push(message("m1", "reply")),
            |d| d.messages[0].body.push('!'),
            |d| d.messages[0].snippet.push('!'),
            |d| d.pending_images.push(pending("m0", "one", "a")),
        ];
        for (n, change) in cases.into_iter().enumerate() {
            let fresh = Arc::new(changed(change));
            let answer = refresh_answer(Some(&shown), Arc::clone(&fresh));
            assert_eq!(answer.thread, Some(fresh), "case {n}");
        }
        let mut unread = detail(&["<p>hello</p>"]);
        unread.unread = true;
        let fresh = Arc::new(unread);
        assert_eq!(
            refresh_answer(None, Arc::clone(&fresh)),
            ThreadRefresh {
                unread: true,
                thread: Some(fresh)
            }
        );
    }
}
