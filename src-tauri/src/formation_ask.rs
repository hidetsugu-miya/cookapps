//! A-37 (#1105): the mark that the leader asked the owner a question, so that the list shows 入力待ち only then.
//! The title of the leader's terminal starts with `✳` whenever Claude Code is back at its prompt, also while the leader waits for a child's report or for a command that runs in the background. The title alone cannot tell those from a question to the owner, so the leader calls `formation_ask_owner` before it asks, and that writes `asked-owner.json` in `formations/{formation}/`: `{"at": epoch milliseconds}`.
//! The list takes the leader as waiting when the mark is there and the title says `✳` (`judge`). The leader is still working when it calls the tool, so a mark with a title that is not `✳` yet is kept. The app clears the mark when the title leaves `✳` after it was seen with the mark, which is the owner's answer starting the leader again (`Seen`, kept in memory; a mark that was never seen waiting is not cleared, so it shows nothing until its leader is at its prompt).
//! A formation of a saved environment has its mark on that PC: the server's `asked.read` and `asked.clear` (`formation_server`) read and clear it.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};

use crate::{accounts::write_atomic, formation};

/// The mark of a formation, in `formations/{formation}/`.
pub const FILE: &str = "asked-owner.json";

#[derive(Serialize, Deserialize)]
struct Mark {
    at: u64,
}

fn path(config: &Path, formation: &str) -> PathBuf {
    formation::dir(config, formation).join(FILE)
}

/// Writes the mark of `formation` with the time `at`.
pub fn mark(config: &Path, formation: &str, at: u64) -> Result<(), String> {
    formation::check_name(formation)?;
    let text = serde_json::to_string(&Mark { at }).map_err(|e| e.to_string())?;
    write_atomic(&formation::dir(config, formation), FILE, &text)
}

/// Writes the mark of `formation` with the time of now; the time. A mark that is not later than the one there is gets the next millisecond, so that every question has a time of its own (`clear_if` and `Seen` tell marks by it).
pub fn mark_now(config: &Path, formation: &str) -> Result<u64, String> {
    formation::check_name(formation)?;
    let at =
        read(config, formation).map_or(formation::now_ms(), |old| formation::now_ms().max(old + 1));
    mark(config, formation, at)?;
    Ok(at)
}

/// The time of the mark of `formation`; none when there is none, or the file cannot be read (a mark that cannot be read is no mark: the list then does not show 入力待ち).
pub fn read(config: &Path, formation: &str) -> Option<u64> {
    let text = std::fs::read_to_string(path(config, formation)).ok()?;
    serde_json::from_str::<Mark>(&text).ok().map(|m| m.at)
}

/// Takes the mark away when it is the one with the time `at`: a mark that the leader wrote again meanwhile has another time and stays. Whether it was removed.
pub fn clear_if(config: &Path, formation: &str, at: u64) -> Result<bool, String> {
    formation::check_name(formation)?;
    if read(config, formation) != Some(at) {
        return Ok(false);
    }
    match std::fs::remove_file(path(config, formation)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!(
            "{} を消せません: {e}",
            path(config, formation).display()
        )),
    }
}

/// What the list does with a formation's mark and its leader's title.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict {
    /// No mark: the leader does not wait for the owner.
    NoMark,
    /// The mark (its time) and `✳`: the leader waits for the owner.
    Waiting(u64),
    /// The mark is there and the leader is not at its prompt yet (it is writing the question), or its title is not known: nothing is shown and nothing is cleared.
    Keep,
    /// The leader was seen waiting under this mark and its title is not `✳` now: it works again, so the mark goes.
    Clear(u64),
}

/// The decision, from the mark's time, the time of the mark that was seen with `✳`, and whether the title says `✳` (`None`: the title is not known).
pub fn judge(mark: Option<u64>, seen: Option<u64>, title_waits: Option<bool>) -> Verdict {
    match (mark, title_waits) {
        (None, _) => Verdict::NoMark,
        (Some(at), Some(true)) => Verdict::Waiting(at),
        (Some(at), Some(false)) if seen == Some(at) => Verdict::Clear(at),
        (Some(_), _) => Verdict::Keep,
    }
}

/// The marks that were seen with `✳`, by formation: the time of each. Kept in memory.
#[derive(Default)]
pub struct Seen(Mutex<HashMap<String, u64>>);

impl Seen {
    /// `judge` for `formation`, and the note of a mark seen waiting. A clear that fails leaves the note, so that the next poll clears again; the note goes when the mark is gone.
    pub fn settle(&self, formation: &str, mark: Option<u64>, title_waits: Option<bool>) -> Verdict {
        let mut seen = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let verdict = judge(mark, seen.get(formation).copied(), title_waits);
        match verdict {
            Verdict::Waiting(at) => {
                seen.insert(formation.to_owned(), at);
            }
            Verdict::NoMark => {
                seen.remove(formation);
            }
            Verdict::Keep | Verdict::Clear(_) => {}
        }
        verdict
    }
}

/// The notes of this app: the list of the screen (`formation_list`) settles every formation against it.
pub static SEEN: LazyLock<Seen> = LazyLock::new(Seen::default);

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tsunagiai-ask-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_leader_waits_only_with_the_mark_and_the_title() {
        assert_eq!(judge(None, None, Some(true)), Verdict::NoMark);
        assert_eq!(judge(None, Some(5), Some(false)), Verdict::NoMark);
        assert_eq!(judge(Some(5), None, Some(true)), Verdict::Waiting(5));
        assert_eq!(judge(Some(5), Some(5), Some(true)), Verdict::Waiting(5));
        // A leader that works on shows nothing.
        assert_eq!(judge(Some(5), None, Some(false)), Verdict::Keep);
    }

    #[test]
    fn a_mark_goes_when_the_leader_that_was_seen_waiting_leaves_the_prompt() {
        assert_eq!(judge(Some(5), Some(5), Some(false)), Verdict::Clear(5));
        // The mark of an older question was seen, and the leader marked again: it is not cleared before it is seen waiting.
        assert_eq!(judge(Some(9), Some(5), Some(false)), Verdict::Keep);
        // A title that is not known clears nothing.
        assert_eq!(judge(Some(5), Some(5), None), Verdict::Keep);
        assert_eq!(judge(Some(5), None, None), Verdict::Keep);
    }

    #[test]
    fn a_mark_that_was_made_while_the_leader_works_is_not_cleared_before_it_waits() {
        let seen = Seen::default();
        // The leader called the tool and is writing the question: the title is still a spinner.
        assert_eq!(seen.settle("a", Some(5), Some(false)), Verdict::Keep);
        assert_eq!(seen.settle("a", Some(5), Some(false)), Verdict::Keep);
        // The question is out, the leader is at its prompt.
        assert_eq!(seen.settle("a", Some(5), Some(true)), Verdict::Waiting(5));
        assert_eq!(seen.settle("a", Some(5), Some(true)), Verdict::Waiting(5));
        // The owner answered: it works again, and the mark goes (again at the next poll when the clear failed).
        assert_eq!(seen.settle("a", Some(5), Some(false)), Verdict::Clear(5));
        assert_eq!(seen.settle("a", Some(5), Some(false)), Verdict::Clear(5));
        assert_eq!(seen.settle("a", None, Some(false)), Verdict::NoMark);
        // The note went with the mark: a mark made later is a new one.
        assert_eq!(seen.settle("a", Some(8), Some(false)), Verdict::Keep);
    }

    #[test]
    fn the_notes_of_two_formations_are_apart() {
        let seen = Seen::default();
        assert_eq!(seen.settle("a", Some(5), Some(true)), Verdict::Waiting(5));
        assert_eq!(seen.settle("b", Some(5), Some(false)), Verdict::Keep);
    }

    #[test]
    fn a_mark_is_written_read_and_cleared_only_at_its_own_time() {
        let config = temp_dir("file");
        assert_eq!(read(&config, "api-work"), None);
        mark(&config, "api-work", 7).unwrap();
        assert_eq!(read(&config, "api-work"), Some(7));
        // The leader asked again meanwhile: the mark of the other time stays.
        assert!(!clear_if(&config, "api-work", 6).unwrap());
        assert_eq!(read(&config, "api-work"), Some(7));
        assert!(clear_if(&config, "api-work", 7).unwrap());
        assert_eq!(read(&config, "api-work"), None);
        // No mark is no error, and no temporary file is left.
        assert!(!clear_if(&config, "api-work", 7).unwrap());
        assert!(!formation::dir(&config, "api-work")
            .join(format!("{FILE}.tmp"))
            .exists());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_mark_made_now_is_later_than_the_one_it_replaces() {
        let config = temp_dir("now");
        // A mark far in the future stands for one made in the same millisecond.
        mark(&config, "api-work", u64::MAX / 2).unwrap();
        let at = mark_now(&config, "api-work").unwrap();
        assert_eq!(at, u64::MAX / 2 + 1);
        assert_eq!(read(&config, "api-work"), Some(at));
        let first = mark_now(&config, "docs-work").unwrap();
        assert!(first > 0);
        assert_eq!(read(&config, "docs-work"), Some(first));
        assert!(mark_now(&config, "../x").is_err());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_name_that_leaves_the_folder_is_refused_and_a_broken_mark_is_none() {
        let config = temp_dir("names");
        assert!(mark(&config, "../x", 1).is_err());
        assert!(clear_if(&config, "../x", 1).is_err());
        let dir = formation::dir(&config, "api-work");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "nope").unwrap();
        assert_eq!(read(&config, "api-work"), None);
        std::fs::remove_dir_all(&config).unwrap();
    }
}
