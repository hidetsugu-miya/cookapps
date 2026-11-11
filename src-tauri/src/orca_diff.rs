//! A-24: the difference between a file at HEAD and the file in the working tree, as the two views of the diff tab of the Orca screen.
//! The lines are compared with Myers' algorithm (the `similar` crate, which works in linear space and stops at a deadline), and the answer is rows for each view:
//! side by side (a row for each line of the left, HEAD, paired with a line of the right, the working tree, or a blank) and inline (one column, the removed lines and then the added ones).
//! A row holds the numbers of its lines, not the text: the page draws the text of the lines it gets with the rows.
//! The blocks of changes (a run of rows that are not the same) are listed with the row each starts at in each view, for the count and the buttons to the previous and next change.

use std::time::{Duration, Instant};

use serde::Serialize;
use similar::{capture_diff_slices_deadline, Algorithm, DiffOp};
#[cfg(test)]
use ts_rs::TS;

/// How long the comparison may take. Two texts of the size the editor takes (384 KiB) differ in a time far below this; a pair that does not is cut to a coarse answer (`similar`), which is still a correct diff.
const DEADLINE: Duration = Duration::from_secs(2);

/// What a row of a view shows. `Changed` is only in the side by side view: a removed line and an added line on one row.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "kebab-case")]
pub enum OrcaDiffKind {
    Same,
    Changed,
    Removed,
    Added,
}

/// A row of a view: `old` is the number (from 1) of the line of HEAD it shows, `new` the one of the working tree; a number that is null is a blank (the other side only has a line there).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaDiffRow {
    pub kind: OrcaDiffKind,
    pub old: Option<u32>,
    pub new: Option<u32>,
}

/// A block of changes: the row it starts at in the side by side view and in the inline view.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct OrcaDiffChange {
    pub side: u32,
    pub inline: u32,
}

/// The rows of both views and the blocks of changes.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DiffRows {
    pub side: Vec<OrcaDiffRow>,
    pub inline: Vec<OrcaDiffRow>,
    pub changes: Vec<OrcaDiffChange>,
}

/// The lines of a text, with CRLF taken as LF. A line is its text and whether a line feed ends it, so a file that lacks the line feed at its end differs from one that has it (as `git diff` says): the text `a\nb` is `a` with a feed and `b` without, and the text `a\nb\n` is both with one. An empty text has no line.
pub fn lines_of(text: &str) -> Vec<(String, bool)> {
    let text = text.replace("\r\n", "\n");
    let mut lines: Vec<(String, bool)> = text
        .split('\n')
        .map(|line| (line.to_owned(), true))
        .collect();
    // `split` ends with a piece after the last feed: empty when the text ends with a feed (no line), else the last line, which no feed ends.
    match lines.pop() {
        Some((last, _)) if !last.is_empty() => lines.push((last, false)),
        _ => {}
    }
    lines
}

fn number(index: usize) -> Option<u32> {
    u32::try_from(index + 1).ok()
}

fn row(kind: OrcaDiffKind, old: Option<usize>, new: Option<usize>) -> OrcaDiffRow {
    OrcaDiffRow {
        kind,
        old: old.and_then(number),
        new: new.and_then(number),
    }
}

/// The rows of both views for the lines of HEAD (`old`) and of the working tree (`new`), as `lines_of` gives them.
pub fn diff_rows(old: &[(String, bool)], new: &[(String, bool)]) -> DiffRows {
    use OrcaDiffKind::{Added, Changed, Removed, Same};
    let deadline = Instant::now().checked_add(DEADLINE);
    let ops = capture_diff_slices_deadline(Algorithm::Myers, old, new, deadline);
    let mut rows = DiffRows::default();
    for op in ops {
        match op {
            DiffOp::Equal {
                old_index,
                new_index,
                len,
            } => {
                for k in 0..len {
                    let r = row(Same, Some(old_index + k), Some(new_index + k));
                    rows.side.push(r);
                    rows.inline.push(r);
                }
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                for k in 0..old_len {
                    let r = row(Removed, Some(old_index + k), None);
                    rows.side.push(r);
                    rows.inline.push(r);
                }
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                for k in 0..new_len {
                    let r = row(Added, None, Some(new_index + k));
                    rows.side.push(r);
                    rows.inline.push(r);
                }
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                // Side by side: the lines pair up in order, and the rest of the longer side stands alone beside a blank.
                for k in 0..old_len.max(new_len) {
                    let (o, n) = (
                        (k < old_len).then_some(old_index + k),
                        (k < new_len).then_some(new_index + k),
                    );
                    let kind = match (o, n) {
                        (Some(_), Some(_)) => Changed,
                        (Some(_), None) => Removed,
                        _ => Added,
                    };
                    rows.side.push(row(kind, o, n));
                }
                // Inline: every removed line, then every added one.
                for k in 0..old_len {
                    rows.inline.push(row(Removed, Some(old_index + k), None));
                }
                for k in 0..new_len {
                    rows.inline.push(row(Added, None, Some(new_index + k)));
                }
            }
        }
    }
    rows.changes = changes_of(&rows.side, &rows.inline);
    rows
}

/// The rows each view's blocks of changes start at: a block is a run of rows that are not `Same`, and both views hold the same blocks.
fn changes_of(side: &[OrcaDiffRow], inline: &[OrcaDiffRow]) -> Vec<OrcaDiffChange> {
    let starts = |rows: &[OrcaDiffRow]| -> Vec<u32> {
        rows.iter()
            .enumerate()
            .filter(|(i, r)| {
                r.kind != OrcaDiffKind::Same && (*i == 0 || rows[i - 1].kind == OrcaDiffKind::Same)
            })
            .filter_map(|(i, _)| u32::try_from(i).ok())
            .collect()
    };
    starts(side)
        .into_iter()
        .zip(starts(inline))
        .map(|(side, inline)| OrcaDiffChange { side, inline })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use OrcaDiffKind::{Added, Changed, Removed, Same};

    fn rows_of(old: &str, new: &str) -> DiffRows {
        diff_rows(&lines_of(old), &lines_of(new))
    }

    fn r(kind: OrcaDiffKind, old: Option<u32>, new: Option<u32>) -> OrcaDiffRow {
        OrcaDiffRow { kind, old, new }
    }

    #[test]
    fn a_text_is_its_lines_and_whether_a_line_feed_ends_each() {
        assert!(lines_of("").is_empty());
        assert_eq!(lines_of("\n"), vec![(String::new(), true)]);
        assert_eq!(
            lines_of("a\nb\n"),
            vec![("a".to_owned(), true), ("b".to_owned(), true)]
        );
        assert_eq!(
            lines_of("a\nb"),
            vec![("a".to_owned(), true), ("b".to_owned(), false)]
        );
        assert_eq!(lines_of("a\r\nb\r\n"), lines_of("a\nb\n"));
    }

    #[test]
    fn the_same_text_has_no_change() {
        let d = rows_of("a\nb\n", "a\nb\n");
        assert_eq!(
            d.side,
            vec![r(Same, Some(1), Some(1)), r(Same, Some(2), Some(2))]
        );
        assert_eq!(d.side, d.inline);
        assert!(d.changes.is_empty());
        assert_eq!(rows_of("", ""), DiffRows::default());
    }

    #[test]
    fn added_lines_stand_beside_blanks() {
        let d = rows_of("a\nc\n", "a\nb\nc\n");
        assert_eq!(
            d.side,
            vec![
                r(Same, Some(1), Some(1)),
                r(Added, None, Some(2)),
                r(Same, Some(2), Some(3)),
            ]
        );
        assert_eq!(d.inline, d.side);
        assert_eq!(d.changes, vec![OrcaDiffChange { side: 1, inline: 1 }]);
    }

    #[test]
    fn removed_lines_stand_beside_blanks() {
        let d = rows_of("a\nb\nc\n", "a\nc\n");
        assert_eq!(
            d.side,
            vec![
                r(Same, Some(1), Some(1)),
                r(Removed, Some(2), None),
                r(Same, Some(3), Some(2)),
            ]
        );
        assert_eq!(d.inline, d.side);
        assert_eq!(d.changes.len(), 1);
    }

    #[test]
    fn changed_lines_pair_up_and_the_rest_of_the_longer_side_is_alone() {
        let d = rows_of("a\nb1\nb2\nc\n", "a\nx\ny\nz\nc\n");
        assert_eq!(
            d.side,
            vec![
                r(Same, Some(1), Some(1)),
                r(Changed, Some(2), Some(2)),
                r(Changed, Some(3), Some(3)),
                r(Added, None, Some(4)),
                r(Same, Some(4), Some(5)),
            ]
        );
        // Inline: the removed lines, then the added ones.
        assert_eq!(
            d.inline,
            vec![
                r(Same, Some(1), Some(1)),
                r(Removed, Some(2), None),
                r(Removed, Some(3), None),
                r(Added, None, Some(2)),
                r(Added, None, Some(3)),
                r(Added, None, Some(4)),
                r(Same, Some(4), Some(5)),
            ]
        );
        assert_eq!(d.changes, vec![OrcaDiffChange { side: 1, inline: 1 }]);
        let d = rows_of("a\nb1\nb2\nc\n", "a\nx\nc\n");
        assert_eq!(d.side[1], r(Changed, Some(2), Some(2)));
        assert_eq!(d.side[2], r(Removed, Some(3), None));
    }

    #[test]
    fn a_file_with_no_lines_at_head_is_all_added() {
        let d = rows_of("", "a\nb\n");
        assert_eq!(
            d.side,
            vec![r(Added, None, Some(1)), r(Added, None, Some(2))]
        );
        assert_eq!(d.inline, d.side);
        assert_eq!(d.changes, vec![OrcaDiffChange { side: 0, inline: 0 }]);
    }

    #[test]
    fn a_file_with_no_lines_in_the_working_tree_is_all_removed() {
        let d = rows_of("a\nb\n", "");
        assert_eq!(
            d.side,
            vec![r(Removed, Some(1), None), r(Removed, Some(2), None)]
        );
        assert_eq!(d.changes.len(), 1);
    }

    #[test]
    fn line_ends_do_not_make_a_change() {
        let d = rows_of("a\r\nb\r\n", "a\nb\n");
        assert!(d.changes.is_empty());
    }

    #[test]
    fn a_missing_last_line_feed_is_a_change() {
        let d = rows_of("a\nb\n", "a\nb");
        assert_eq!(
            d.side,
            vec![r(Same, Some(1), Some(1)), r(Changed, Some(2), Some(2))]
        );
        assert_eq!(d.changes.len(), 1);
    }

    #[test]
    fn changes_are_counted_by_block_in_both_views() {
        let d = rows_of("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\nf\n");
        assert_eq!(
            d.changes,
            vec![
                OrcaDiffChange { side: 1, inline: 1 },
                OrcaDiffChange { side: 4, inline: 5 },
            ]
        );
        assert_eq!(d.inline[5].kind, Removed);
        assert_eq!(d.side[4].kind, Changed);
    }

    #[test]
    fn big_texts_are_compared_fast() {
        // Every line differs, then a shift of every line by one: the worst cases of the comparison for texts of the size the editor takes.
        let a: String = (0..12_000).map(|i| format!("old line {i}\n")).collect();
        let b: String = (0..12_000).map(|i| format!("new line {i}\n")).collect();
        let started = Instant::now();
        let d = rows_of(&a, &b);
        assert_eq!(d.side.len(), 12_000);
        assert_eq!(d.inline.len(), 24_000);
        let shifted: String = std::iter::once("first\n".to_owned())
            .chain((0..12_000).map(|i| format!("old line {i}\n")))
            .collect();
        let d = rows_of(&a, &shifted);
        assert_eq!(d.changes.len(), 1);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
