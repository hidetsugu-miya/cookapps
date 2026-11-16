//! The OS keychain, in one place: every module reads, writes and deletes its secrets through here.
//! The services are named after the identifier (`jp.mysis.tsunagiai`, `jp.mysis.tsunagiai.claude`, ...), and the ones of the old identifier (`jp.mysis.cookapps...`) are moved on the first read:
//! a read that finds nothing under the new service reads the same user under the old service, and copies what it finds to the new one. The old item is kept.
//! The old service is asked once for each item in a process (when it held nothing, the answer is remembered), and one read at a time, so a permission prompt of the OS is not asked twice.
//! A delete removes the item under both services, the old one first, or the next read would copy the old one back; a read that copied reads the old item once more, and takes its copy back when a delete took the old one meanwhile.
//! A secret is in no log, error text or `Debug` here: an error carries the keychain's own message only.

use std::{
    collections::BTreeSet,
    sync::{Mutex, PoisonError},
};

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

/// The items (new service, user) whose old service held nothing when it was asked. It is also the lock of the read of an old service.
type Asked = Mutex<BTreeSet<(String, String)>>;

static ASKED: Asked = Mutex::new(BTreeSet::new());

/// The secret under `service` and `user`; `None` means none is stored. An item that only the old service has is copied to the new one.
pub(crate) fn read(service: &str, user: &str) -> Result<Option<String>, String> {
    read_in(&Os, &ASKED, service, user)
}

/// Stores the secret under the new service only.
pub(crate) fn write(service: &str, user: &str, value: &str) -> Result<(), String> {
    Os.set(service, user, value)
}

/// Deletes the item under the old service and under the new one.
pub(crate) fn delete(service: &str, user: &str) -> Result<(), String> {
    delete_in(&Os, service, user)
}

/// The service of the old identifier that `service` replaces. `None` for a name that is not under the identifier.
pub(crate) fn old_service(service: &str) -> Option<String> {
    service
        .strip_prefix(IDENTIFIER)
        .map(|rest| format!("{OLD_IDENTIFIER}{rest}"))
}

fn read_in(
    store: &impl Store,
    asked: &Asked,
    service: &str,
    user: &str,
) -> Result<Option<String>, String> {
    if let Some(value) = store.get(service, user)? {
        return Ok(Some(value));
    }
    let Some(old_service) = old_service(service) else {
        return Ok(None);
    };
    // One read of the old service at a time: the reads that wait find the item copied, or the answer remembered.
    let mut asked = asked.lock().unwrap_or_else(PoisonError::into_inner);
    let key = (service.to_owned(), user.to_owned());
    if asked.contains(&key) {
        return Ok(None);
    }
    if let Some(value) = store.get(service, user)? {
        return Ok(Some(value));
    }
    let Some(value) = store.get(&old_service, user)? else {
        asked.insert(key);
        return Ok(None);
    };
    store.set(service, user, &value)?;
    // A delete (the app and `tsunagiai-mcp` are two processes) takes the old item first and the new one after, so an old item that is gone now was deleted while this read copied it.
    if store.get(&old_service, user)?.is_none() {
        store.delete(service, user)?;
        return Ok(None);
    }
    Ok(Some(value))
}

/// Both deletes run even when the first fails, and the error of either is returned.
/// The old one goes first, so a read that copies the old item to the new service while a delete runs finds the old item gone when it looks again.
fn delete_in(store: &impl Store, service: &str, user: &str) -> Result<(), String> {
    let old = old_service(service).map_or(Ok(()), |old| store.delete(&old, user));
    let new = store.delete(service, user);
    old.and(new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};

    const NEW: &str = "jp.mysis.tsunagiai.slack";
    const OLD: &str = "jp.mysis.cookapps.slack";

    /// A read with nothing remembered, as the first read of a process.
    fn read_in_fresh(
        store: &impl Store,
        service: &str,
        user: &str,
    ) -> Result<Option<String>, String> {
        read_in(store, &Mutex::new(BTreeSet::new()), service, user)
    }

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
    fn a_read_finding_the_new_item_does_not_touch_the_old_one() {
        let store = Memory::with(&[(NEW, "u", "new"), (OLD, "u", "old")]);
        assert_eq!(
            read_in_fresh(&store, NEW, "u").unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(store.item(OLD, "u").as_deref(), Some("old"));
    }

    #[test]
    fn a_read_copies_the_old_item_to_the_new_service_and_keeps_the_old_one() {
        let store = Memory::with(&[(OLD, "u", "old"), (OLD, "other", "x")]);
        assert_eq!(
            read_in_fresh(&store, NEW, "u").unwrap().as_deref(),
            Some("old")
        );
        assert_eq!(store.item(NEW, "u").as_deref(), Some("old"));
        assert_eq!(store.item(OLD, "u").as_deref(), Some("old"));
        assert_eq!(store.item(NEW, "other"), None);
    }

    #[test]
    fn a_read_finding_nothing_writes_nothing() {
        let store = Memory::default();
        assert_eq!(read_in_fresh(&store, NEW, "u").unwrap(), None);
        assert!(store.items.borrow().is_empty());
    }

    #[test]
    fn a_service_outside_the_identifier_has_no_old_one() {
        let store = Memory::with(&[("other.service", "u", "x")]);
        assert_eq!(read_in_fresh(&store, "another.service", "u").unwrap(), None);
        assert!(store.item("another.service", "u").is_none());
    }

    #[test]
    fn a_delete_removes_both_so_the_old_item_is_not_copied_back() {
        let store = Memory::with(&[(OLD, "u", "old")]);
        assert_eq!(
            read_in_fresh(&store, NEW, "u").unwrap().as_deref(),
            Some("old")
        );
        delete_in(&store, NEW, "u").unwrap();
        assert_eq!(store.item(NEW, "u"), None);
        assert_eq!(store.item(OLD, "u"), None);
        assert_eq!(read_in_fresh(&store, NEW, "u").unwrap(), None);
    }

    #[test]
    fn a_delete_of_an_item_only_the_old_service_has_removes_it() {
        let store = Memory::with(&[(OLD, "u", "old"), (OLD, "keep", "k")]);
        delete_in(&store, NEW, "u").unwrap();
        assert_eq!(read_in_fresh(&store, NEW, "u").unwrap(), None);
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
    fn a_failed_delete_of_the_old_item_still_deletes_the_new_one() {
        let mut store = Memory::with(&[(NEW, "u", "new"), (OLD, "u", "old")]);
        store.failing_service = Some(OLD);
        assert_eq!(delete_in(&store, NEW, "u"), Err("locked".to_owned()));
        assert_eq!(store.item(NEW, "u"), None);
    }

    #[test]
    fn the_old_service_is_asked_once_for_an_item_it_does_not_hold() {
        struct Counting(Memory, RefCell<Vec<String>>);
        impl Store for Counting {
            fn get(&self, s: &str, u: &str) -> Result<Option<String>, String> {
                self.1.borrow_mut().push(s.to_owned());
                self.0.get(s, u)
            }
            fn set(&self, s: &str, u: &str, v: &str) -> Result<(), String> {
                self.0.set(s, u, v)
            }
            fn delete(&self, s: &str, u: &str) -> Result<(), String> {
                self.0.delete(s, u)
            }
        }
        let store = Counting(Memory::default(), RefCell::default());
        let asked = Mutex::new(BTreeSet::new());
        for _ in 0..3 {
            assert_eq!(read_in(&store, &asked, NEW, "u").unwrap(), None);
        }
        let old_reads = store.1.borrow().iter().filter(|s| *s == OLD).count();
        assert_eq!(old_reads, 1);
        // Another item of the same service is asked on its own.
        assert_eq!(read_in(&store, &asked, NEW, "other").unwrap(), None);
        assert_eq!(store.1.borrow().iter().filter(|s| *s == OLD).count(), 2);
    }

    #[test]
    fn an_item_that_was_copied_is_not_remembered_as_missing() {
        // Only an item that the old service did not hold is remembered, so the item is copied again once the new one is gone.
        let asked = Mutex::new(BTreeSet::new());
        let store = Memory::with(&[(OLD, "u", "old")]);
        assert_eq!(
            read_in(&store, &asked, NEW, "u").unwrap().as_deref(),
            Some("old")
        );
        store
            .items
            .borrow_mut()
            .remove(&(NEW.to_owned(), "u".to_owned()));
        assert_eq!(
            read_in(&store, &asked, NEW, "u").unwrap().as_deref(),
            Some("old")
        );
    }

    #[test]
    fn a_delete_that_lands_between_the_read_and_the_copy_does_not_bring_the_item_back() {
        // Another process deletes the item after this read found the old one and before it writes the new one.
        struct DeleteBeforeSet(Memory);
        impl Store for DeleteBeforeSet {
            fn get(&self, s: &str, u: &str) -> Result<Option<String>, String> {
                self.0.get(s, u)
            }
            fn set(&self, s: &str, u: &str, v: &str) -> Result<(), String> {
                delete_in(&self.0, s, u)?;
                self.0.set(s, u, v)
            }
            fn delete(&self, s: &str, u: &str) -> Result<(), String> {
                self.0.delete(s, u)
            }
        }
        let store = DeleteBeforeSet(Memory::with(&[(OLD, "u", "old")]));
        assert_eq!(read_in_fresh(&store, NEW, "u").unwrap(), None);
        assert_eq!(store.0.item(NEW, "u"), None);
        assert_eq!(store.0.item(OLD, "u"), None);
    }

    #[test]
    fn a_failed_read_of_the_new_service_is_an_error_and_the_old_one_is_not_read() {
        let mut store = Memory::with(&[(OLD, "u", "old")]);
        store.failing_service = Some(NEW);
        assert_eq!(read_in_fresh(&store, NEW, "u"), Err("locked".to_owned()));
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
        assert_eq!(read_in_fresh(&store, NEW, "u"), Err("full".to_owned()));
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
