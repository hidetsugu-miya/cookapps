//! The OS keychain, in one place: every module reads, writes and deletes its secrets through here.
//! The services are named after the identifier (`jp.mysis.tsunagiai`, `jp.mysis.tsunagiai.claude`, ...), and the ones of the old identifier (`jp.mysis.cookapps...`) are moved on the first read:
//! a read that finds nothing under the new service reads the same user under the old service, and copies what it finds to the new one. The old item is kept.
//! A delete removes the item under both services, or the next read would copy the old one back.
//! A secret is in no log, error text or `Debug` here: an error carries the keychain's own message only.

use crate::identity::{IDENTIFIER, OLD_IDENTIFIER};

/// Where the items are kept: the OS keychain, or a map in the tests.
pub(crate) trait Store {
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, user: &str, value: &str) -> Result<(), String>;
    /// A missing item counts as deleted, so a repeated or concurrent run ends in the same state.
    fn delete(&self, service: &str, user: &str) -> Result<(), String>;
}

struct Os;

fn os_entry(service: &str, user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, user).map_err(|e| e.to_string())
}

impl Store for Os {
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, String> {
        match os_entry(service, user)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("資格情報の読み取りに失敗: {e}")),
        }
    }

    fn set(&self, service: &str, user: &str, value: &str) -> Result<(), String> {
        os_entry(service, user)?
            .set_password(value)
            .map_err(|e| format!("資格情報の保存に失敗: {e}"))
    }

    fn delete(&self, service: &str, user: &str) -> Result<(), String> {
        match os_entry(service, user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("資格情報の削除に失敗: {e}")),
        }
    }
}

/// The secret under `service` and `user`; `None` means none is stored. An item that only the old service has is copied to the new one.
pub(crate) fn read(service: &str, user: &str) -> Result<Option<String>, String> {
    read_in(&Os, service, user)
}

/// Stores the secret under the new service only.
pub(crate) fn write(service: &str, user: &str, value: &str) -> Result<(), String> {
    Os.set(service, user, value)
}

/// Deletes the item under the new service and under the old one.
pub(crate) fn delete(service: &str, user: &str) -> Result<(), String> {
    delete_in(&Os, service, user)
}

/// The service of the old identifier that `service` replaces. `None` for a name that is not under the identifier.
pub(crate) fn old_service(service: &str) -> Option<String> {
    service
        .strip_prefix(IDENTIFIER)
        .map(|rest| format!("{OLD_IDENTIFIER}{rest}"))
}

/// What a read does with the two items.
struct Migration {
    value: Option<String>,
    /// Write `value` to the new service.
    copy: bool,
}

fn migration(new: Option<String>, old: Option<String>) -> Migration {
    Migration {
        copy: new.is_none() && old.is_some(),
        value: new.or(old),
    }
}

fn read_in(store: &impl Store, service: &str, user: &str) -> Result<Option<String>, String> {
    let new = store.get(service, user)?;
    let old = match (&new, old_service(service)) {
        (None, Some(old_service)) => store.get(&old_service, user)?,
        _ => None,
    };
    let found = migration(new, old);
    if let (true, Some(value)) = (found.copy, &found.value) {
        store.set(service, user, value)?;
    }
    Ok(found.value)
}

/// Both deletes run even when the first fails, so a failure leaves the old item no later than the new one.
fn delete_in(store: &impl Store, service: &str, user: &str) -> Result<(), String> {
    let new = store.delete(service, user);
    let old = old_service(service).map_or(Ok(()), |old| store.delete(&old, user));
    new.and(old)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};

    const NEW: &str = "jp.mysis.tsunagiai.slack";
    const OLD: &str = "jp.mysis.cookapps.slack";

    /// Items in a map, with the calls that fail named.
    #[derive(Default)]
    struct Memory {
        items: RefCell<HashMap<(String, String), String>>,
        failing_service: Option<&'static str>,
    }

    impl Memory {
        fn with(items: &[(&str, &str, &str)]) -> Memory {
            let memory = Memory::default();
            for (service, user, value) in items {
                memory
                    .items
                    .borrow_mut()
                    .insert((service.to_string(), user.to_string()), value.to_string());
            }
            memory
        }

        fn item(&self, service: &str, user: &str) -> Option<String> {
            self.items
                .borrow()
                .get(&(service.to_owned(), user.to_owned()))
                .cloned()
        }

        fn check(&self, service: &str) -> Result<(), String> {
            match self.failing_service {
                Some(failing) if failing == service => Err("locked".into()),
                _ => Ok(()),
            }
        }
    }

    impl Store for Memory {
        fn get(&self, service: &str, user: &str) -> Result<Option<String>, String> {
            self.check(service)?;
            Ok(self.item(service, user))
        }

        fn set(&self, service: &str, user: &str, value: &str) -> Result<(), String> {
            self.check(service)?;
            self.items
                .borrow_mut()
                .insert((service.to_owned(), user.to_owned()), value.to_owned());
            Ok(())
        }

        fn delete(&self, service: &str, user: &str) -> Result<(), String> {
            self.check(service)?;
            self.items
                .borrow_mut()
                .remove(&(service.to_owned(), user.to_owned()));
            Ok(())
        }
    }

    #[test]
    fn the_old_service_replaces_the_identifier_in_the_name() {
        assert_eq!(old_service(IDENTIFIER).as_deref(), Some(OLD_IDENTIFIER));
        assert_eq!(
            old_service("jp.mysis.tsunagiai.slack-app").as_deref(),
            Some("jp.mysis.cookapps.slack-app")
        );
        assert_eq!(old_service("other.service"), None);
    }

    #[test]
    fn the_new_item_wins_and_nothing_is_copied() {
        let m = migration(Some("new".into()), Some("old".into()));
        assert_eq!((m.value.as_deref(), m.copy), (Some("new"), false));
    }

    #[test]
    fn only_the_old_item_is_copied() {
        let m = migration(None, Some("old".into()));
        assert_eq!((m.value.as_deref(), m.copy), (Some("old"), true));
    }

    #[test]
    fn neither_item_is_none_and_copies_nothing() {
        let m = migration(None, None);
        assert_eq!((m.value, m.copy), (None, false));
    }

    #[test]
    fn a_read_finding_the_new_item_does_not_touch_the_old_one() {
        let store = Memory::with(&[(NEW, "u", "new"), (OLD, "u", "old")]);
        assert_eq!(read_in(&store, NEW, "u").unwrap().as_deref(), Some("new"));
        assert_eq!(store.item(OLD, "u").as_deref(), Some("old"));
    }

    #[test]
    fn a_read_copies_the_old_item_to_the_new_service_and_keeps_the_old_one() {
        let store = Memory::with(&[(OLD, "u", "old"), (OLD, "other", "x")]);
        assert_eq!(read_in(&store, NEW, "u").unwrap().as_deref(), Some("old"));
        assert_eq!(store.item(NEW, "u").as_deref(), Some("old"));
        assert_eq!(store.item(OLD, "u").as_deref(), Some("old"));
        assert_eq!(store.item(NEW, "other"), None);
    }

    #[test]
    fn a_read_finding_nothing_writes_nothing() {
        let store = Memory::default();
        assert_eq!(read_in(&store, NEW, "u").unwrap(), None);
        assert!(store.items.borrow().is_empty());
    }

    #[test]
    fn a_service_outside_the_identifier_has_no_old_one() {
        let store = Memory::with(&[("other.service", "u", "x")]);
        assert_eq!(read_in(&store, "another.service", "u").unwrap(), None);
        assert!(store.item("another.service", "u").is_none());
    }

    #[test]
    fn a_delete_removes_both_so_the_old_item_is_not_copied_back() {
        let store = Memory::with(&[(OLD, "u", "old")]);
        assert_eq!(read_in(&store, NEW, "u").unwrap().as_deref(), Some("old"));
        delete_in(&store, NEW, "u").unwrap();
        assert_eq!(store.item(NEW, "u"), None);
        assert_eq!(store.item(OLD, "u"), None);
        assert_eq!(read_in(&store, NEW, "u").unwrap(), None);
    }

    #[test]
    fn a_delete_of_an_item_only_the_old_service_has_removes_it() {
        let store = Memory::with(&[(OLD, "u", "old"), (OLD, "keep", "k")]);
        delete_in(&store, NEW, "u").unwrap();
        assert_eq!(read_in(&store, NEW, "u").unwrap(), None);
        assert_eq!(store.item(OLD, "keep").as_deref(), Some("k"));
    }

    #[test]
    fn a_delete_of_nothing_succeeds() {
        assert_eq!(delete_in(&Memory::default(), NEW, "u"), Ok(()));
    }

    #[test]
    fn a_failed_delete_of_the_new_item_still_deletes_the_old_one() {
        let mut store = Memory::with(&[(NEW, "u", "new"), (OLD, "u", "old")]);
        store.failing_service = Some(NEW);
        assert_eq!(delete_in(&store, NEW, "u"), Err("locked".to_owned()));
        assert_eq!(store.item(OLD, "u"), None);
    }

    #[test]
    fn a_failed_read_of_the_new_service_is_an_error_and_the_old_one_is_not_read() {
        let mut store = Memory::with(&[(OLD, "u", "old")]);
        store.failing_service = Some(NEW);
        assert_eq!(read_in(&store, NEW, "u"), Err("locked".to_owned()));
        assert_eq!(store.item(NEW, "u"), None);
    }

    #[test]
    fn a_failed_copy_is_an_error() {
        // Reads work, the write to the new service fails: the secret is not used without being moved.
        struct NoWrite(Memory);
        impl Store for NoWrite {
            fn get(&self, s: &str, u: &str) -> Result<Option<String>, String> {
                self.0.get(s, u)
            }
            fn set(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
                Err("full".into())
            }
            fn delete(&self, s: &str, u: &str) -> Result<(), String> {
                self.0.delete(s, u)
            }
        }
        let store = NoWrite(Memory::with(&[(OLD, "u", "old")]));
        assert_eq!(read_in(&store, NEW, "u"), Err("full".to_owned()));
    }

    /// Writes, reads and deletes a real Windows Credential Manager entry under a service name only this test uses.
    #[cfg(windows)]
    #[test]
    fn credential_manager_round_trip() {
        let user = format!("round-trip-{}", std::process::id());
        let service = "jp.mysis.tsunagiai.test";
        let written = Os.set(service, &user, "secret-value");
        let read = Os.get(service, &user);
        // Deleted before any assertion, so a failed assertion leaves nothing behind.
        let deleted = Os.delete(service, &user);
        written.unwrap();
        assert_eq!(read.unwrap().as_deref(), Some("secret-value"));
        deleted.unwrap();
        assert_eq!(Os.get(service, &user).unwrap(), None);
    }
}
