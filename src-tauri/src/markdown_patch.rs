//! #381: apply the edit made in the rich Markdown editor to the original text.
//! The editor rewrites the notation even when nothing is edited (bullet marks, table alignment, indentation), so its export is not saved as it is.
//! The export before the edit and the export after it are compared by lines, and only the lines that differ are put into the original text; every other line of the original stays as it was.
//! The front matter (a block at the top between two `---` or two `+++` lines) is cut off the text the editor gets and goes back as it was.
//! Nothing here reads a file or talks to a service.

use std::time::{Duration, Instant};

use serde::Serialize;
use similar::{capture_diff_slices_deadline, Algorithm, DiffOp};
#[cfg(test)]
use ts_rs::TS;

/// The largest text taken, in bytes: the size of the file the editor of A-18 opens.
pub const MAX_TEXT: usize = 384 * 1024;

/// How long a comparison may take. A text of `MAX_TEXT` differs in a time far below this; a pair that does not gets a coarse answer, which is still a correct diff.
const DEADLINE: Duration = Duration::from_secs(2);

/// Why an edit could not be applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchError {
    /// A text is over `MAX_TEXT`.
    TooLarge,
    /// A line the editor changed cannot be found in the original text, or its place there is not certain (the original was changed after the editor read it, or the editor rewrote the surroundings of the line beyond what can be paired). Nothing is applied.
    NoMatch,
}

/// A line of a text and the line end that follows it (`"\n"`, `"\r\n"`, or empty for a last line that has none).
#[derive(Clone, Copy)]
struct Line<'a> {
    text: &'a str,
    eol: &'a str,
}

fn split_lines(text: &str) -> Vec<Line<'_>> {
    text.split_inclusive('\n')
        .map(|raw| match raw.strip_suffix("\r\n") {
            Some(text) => Line { text, eol: "\r\n" },
            None => match raw.strip_suffix('\n') {
                Some(text) => Line { text, eol: "\n" },
                None => Line { text: raw, eol: "" },
            },
        })
        .collect()
}

fn check_size(text: &str) -> Result<(), PatchError> {
    if text.len() > MAX_TEXT {
        Err(PatchError::TooLarge)
    } else {
        Ok(())
    }
}

/// Cuts the front matter off the top of a text: `(front matter, body)`, which join back into the text. The front matter is the lines from an opening `---` (or `+++`) to the next line that is the same mark, both included with their line ends. A text that does not begin with the mark, or whose block is never closed, has none.
pub fn split_front_matter(text: &str) -> (&str, &str) {
    let mark = if text.starts_with("---") {
        "---"
    } else if text.starts_with("+++") {
        "+++"
    } else {
        return ("", text);
    };
    let mut end = 0;
    for (n, raw) in text.split_inclusive('\n').enumerate() {
        end += raw.len();
        let content = raw.trim_end_matches(['\r', '\n']).trim_end();
        if n == 0 {
            if content != mark {
                return ("", text);
            }
        } else if content == mark {
            return text.split_at(end);
        }
    }
    ("", text)
}

/// The key two lines are paired by when the original is lined up with the editor's export: the letters and digits of the line, or, for a line with none, its non-blank characters. A line the editor only re-marked (`* a` to `- a`, a table padded) keeps its key.
fn loose_key(text: &str) -> String {
    let key: String = text.chars().filter(|c| c.is_alphanumeric()).collect();
    if key.is_empty() {
        text.chars().filter(|c| !c.is_whitespace()).collect()
    } else {
        key
    }
}

/// For each boundary between lines of `before` (0 to its length), the smallest and the largest boundary of the original it can stand for. A boundary inside a stretch that the two do not pair line by line has none.
struct Boundaries {
    lo: Vec<Option<usize>>,
    hi: Vec<Option<usize>>,
}

impl Boundaries {
    fn new(before_keys: &[String], original_keys: &[String]) -> Self {
        let mut b = Boundaries {
            lo: vec![None; before_keys.len() + 1],
            hi: vec![None; before_keys.len() + 1],
        };
        b.note(0, 0);
        b.note(before_keys.len(), original_keys.len());
        let deadline = Instant::now().checked_add(DEADLINE);
        for op in
            capture_diff_slices_deadline(Algorithm::Myers, before_keys, original_keys, deadline)
        {
            match op {
                DiffOp::Equal {
                    old_index,
                    new_index,
                    len,
                } => b.pair(old_index, new_index, len),
                DiffOp::Delete {
                    old_index,
                    old_len,
                    new_index,
                } => b.edges(old_index, old_len, new_index, 0),
                DiffOp::Insert {
                    old_index,
                    new_index,
                    new_len,
                } => b.edges(old_index, 0, new_index, new_len),
                DiffOp::Replace {
                    old_index,
                    old_len,
                    new_index,
                    new_len,
                } => {
                    // The same number of lines on both sides are taken as the same lines re-marked, in order.
                    if old_len == new_len {
                        b.pair(old_index, new_index, old_len);
                    } else {
                        b.edges(old_index, old_len, new_index, new_len);
                    }
                }
            }
        }
        b
    }

    fn note(&mut self, k: usize, o: usize) {
        self.lo[k] = Some(self.lo[k].map_or(o, |v| v.min(o)));
        self.hi[k] = Some(self.hi[k].map_or(o, |v| v.max(o)));
    }

    /// `len` lines of `before` from `b` paired one by one with the lines of the original from `o`.
    fn pair(&mut self, b: usize, o: usize, len: usize) {
        for j in 0..=len {
            self.note(b + j, o + j);
        }
    }

    /// A stretch of `b_len` lines at `b` against `o_len` lines at `o`, not paired: only its two ends are certain.
    fn edges(&mut self, b: usize, b_len: usize, o: usize, o_len: usize) {
        self.note(b, o);
        self.note(b + b_len, o + o_len);
    }
}

/// A change the editor made: the lines `from..to` of `before` become `lines`.
struct Hunk {
    from: usize,
    to: usize,
    lines: Vec<String>,
}

fn hunks(before: &[Line], after: &[Line]) -> Vec<Hunk> {
    let before_texts: Vec<&str> = before.iter().map(|l| l.text).collect();
    let after_texts: Vec<&str> = after.iter().map(|l| l.text).collect();
    let deadline = Instant::now().checked_add(DEADLINE);
    let take = |index: usize, len: usize| -> Vec<String> {
        after_texts[index..index + len]
            .iter()
            .map(|t| (*t).to_owned())
            .collect()
    };
    capture_diff_slices_deadline(Algorithm::Myers, &before_texts, &after_texts, deadline)
        .into_iter()
        .filter_map(|op| match op {
            DiffOp::Equal { .. } => None,
            DiffOp::Delete {
                old_index, old_len, ..
            } => Some(Hunk {
                from: old_index,
                to: old_index + old_len,
                lines: Vec::new(),
            }),
            DiffOp::Insert {
                old_index,
                new_index,
                new_len,
            } => Some(Hunk {
                from: old_index,
                to: old_index,
                lines: take(new_index, new_len),
            }),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => Some(Hunk {
                from: old_index,
                to: old_index + old_len,
                lines: take(new_index, new_len),
            }),
        })
        .collect()
}

/// The line end new lines get: CRLF when the original has more of those than bare line feeds.
fn style_eol(original: &[Line]) -> &'static str {
    let crlf = original.iter().filter(|l| l.eol == "\r\n").count();
    let lf = original.iter().filter(|l| l.eol == "\n").count();
    if crlf > lf {
        "\r\n"
    } else {
        "\n"
    }
}

fn patch_body(original: &str, before: &str, after: &str) -> Result<String, PatchError> {
    let original_lines = split_lines(original);
    let before_lines = split_lines(before);
    let after_lines = split_lines(after);
    let changes = hunks(&before_lines, &after_lines);

    let before_keys: Vec<String> = before_lines.iter().map(|l| loose_key(l.text)).collect();
    let original_keys: Vec<String> = original_lines.iter().map(|l| loose_key(l.text)).collect();
    let bounds = Boundaries::new(&before_keys, &original_keys);
    if changes.is_empty() {
        // Nothing to put, but the answer tells whether an edit could be put: every boundary of `before` must stand for a place of the original.
        return if bounds.lo.iter().all(Option::is_some) {
            Ok(original.to_owned())
        } else {
            Err(PatchError::NoMatch)
        };
    }

    // Each change as a range of the original lines and the lines that replace them. The start of a replaced range skips lines only the original has, and its end stops before them, so those stay; an insertion goes right after the line before it.
    let mut edits: Vec<(usize, usize, &[String])> = Vec::new();
    let mut floor = 0;
    for h in &changes {
        let (s, e) = if h.from < h.to {
            (bounds.hi[h.from], bounds.lo[h.to])
        } else {
            (bounds.lo[h.from], bounds.lo[h.from])
        };
        let (Some(s), Some(e)) = (s, e) else {
            return Err(PatchError::NoMatch);
        };
        if s > e || s < floor {
            return Err(PatchError::NoMatch);
        }
        // A line only the original has (a comment the editor does not write out) inside the replaced range would be dropped with it.
        if (h.from + 1..h.to).any(|k| bounds.lo[k] != bounds.hi[k]) {
            return Err(PatchError::NoMatch);
        }
        floor = e;
        edits.push((s, e, &h.lines));
    }

    let eol = style_eol(&original_lines);
    let mut out: Vec<(&str, &str)> = Vec::new();
    let mut pos = 0;
    let mut reaches_end = false;
    for (s, e, lines) in &edits {
        out.extend(original_lines[pos..*s].iter().map(|l| (l.text, l.eol)));
        out.extend(lines.iter().map(|t| (t.as_str(), eol)));
        pos = *e;
        reaches_end |= *e == original_lines.len();
    }
    out.extend(original_lines[pos..].iter().map(|l| (l.text, l.eol)));

    // Every line but the last needs a line end. The last keeps the original's habit of ending the text with one or not.
    let ends_with_eol = original_lines.last().map_or_else(
        || after_lines.last().is_some_and(|l| !l.eol.is_empty()),
        |l| !l.eol.is_empty(),
    );
    let last = out.len().saturating_sub(1);
    let mut text = String::with_capacity(original.len());
    for (n, (line, own)) in out.iter().enumerate() {
        text.push_str(line);
        if n < last {
            text.push_str(if own.is_empty() { eol } else { own });
        } else if reaches_end {
            if ends_with_eol {
                text.push_str(if own.is_empty() { eol } else { own });
            }
        } else {
            text.push_str(own);
        }
    }
    Ok(text)
}

/// Puts the edit of the editor into the original text. `before` and `after` are what the editor exported for the body (the original without its front matter) when it was loaded and when it is saved. An edit that changed nothing gives the original as it is, when its lines can be paired with the export's (`before == after` is the check that the page makes when it opens a file).
pub fn patch_markdown(original: &str, before: &str, after: &str) -> Result<String, PatchError> {
    check_size(original)?;
    check_size(before)?;
    check_size(after)?;
    let (front, body) = split_front_matter(original);
    let patched = patch_body(body, before, after)?;
    if !front.is_empty() && !front.ends_with('\n') && !patched.is_empty() {
        // The block was closed by the last line of the text, which had no line end.
        let eol = if front.ends_with('\r') { "\r\n" } else { "\n" };
        return Ok(format!("{front}{eol}{patched}"));
    }
    Ok(format!("{front}{patched}"))
}

/// A text cut into its front matter and the body the editor is given.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
pub struct MarkdownParts {
    pub front: String,
    pub body: String,
}

/// The answer of `markdown_patch`: the new text, or that the edit could not be put into the original (`conflict`), so the page can say so and keep the editor's text.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MarkdownPatchResult {
    Patched { text: String },
    Conflict,
}

fn too_large() -> String {
    format!("{} KiB を超える文書は編集できません", MAX_TEXT / 1024)
}

fn split(text: &str) -> Result<MarkdownParts, String> {
    check_size(text).map_err(|_| too_large())?;
    let (front, body) = split_front_matter(text);
    Ok(MarkdownParts {
        front: front.to_owned(),
        body: body.to_owned(),
    })
}

fn patch(original: &str, before: &str, after: &str) -> Result<MarkdownPatchResult, String> {
    match patch_markdown(original, before, after) {
        Ok(text) => Ok(MarkdownPatchResult::Patched { text }),
        Err(PatchError::TooLarge) => Err(too_large()),
        Err(PatchError::NoMatch) => Ok(MarkdownPatchResult::Conflict),
    }
}

/// Cuts the front matter off a Markdown text. The page gives the body to the editor.
#[tauri::command]
pub async fn markdown_split(text: String) -> Result<MarkdownParts, String> {
    tokio::task::spawn_blocking(move || split(&text))
        .await
        .map_err(|e| e.to_string())?
}

/// Puts the editor's edit into the original text (`patch_markdown`). It reads no file and calls no service.
#[tauri::command]
pub async fn markdown_patch(
    original: String,
    before: String,
    after: String,
) -> Result<MarkdownPatchResult, String> {
    tokio::task::spawn_blocking(move || patch(&original, &before, &after))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_yaml_and_toml_front_matter() {
        assert_eq!(
            split_front_matter("---\ntitle: a\n---\n# H\n"),
            ("---\ntitle: a\n---\n", "# H\n")
        );
        assert_eq!(
            split_front_matter("+++\na = 1\n+++\nbody"),
            ("+++\na = 1\n+++\n", "body")
        );
    }

    #[test]
    fn splits_crlf_trailing_blanks_and_a_block_closed_at_the_end() {
        assert_eq!(
            split_front_matter("---  \r\na: 1\r\n---\r\nbody\r\n"),
            ("---  \r\na: 1\r\n---\r\n", "body\r\n")
        );
        assert_eq!(split_front_matter("---\na: 1\n---"), ("---\na: 1\n---", ""));
    }

    #[test]
    fn has_no_front_matter_when_not_opened_or_closed_alike() {
        assert_eq!(split_front_matter("# H\n---\n"), ("", "# H\n---\n"));
        assert_eq!(
            split_front_matter("----\na\n----\n"),
            ("", "----\na\n----\n")
        );
        assert_eq!(
            split_front_matter("---\na: 1\n+++\n"),
            ("", "---\na: 1\n+++\n")
        );
        assert_eq!(split_front_matter("---\na: 1\n"), ("", "---\na: 1\n"));
        assert_eq!(split_front_matter(""), ("", ""));
    }

    #[test]
    fn joins_back_into_the_text() {
        for t in ["---\na\n---\nb\n", "x\n", "+++\n+++\n", "---\na\n---"] {
            let (f, b) = split_front_matter(t);
            assert_eq!(format!("{f}{b}"), t);
        }
    }

    #[test]
    fn no_edit_gives_the_original_even_when_the_editor_would_rewrite_it() {
        let original = "---\nt: 1\n---\n* a\n* b\n\n|a|b|\n|-|-|\n|1|2|\n";
        let export = "- a\n- b\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
        assert_eq!(patch_markdown(original, export, export).unwrap(), original);
    }

    #[test]
    fn puts_only_the_edited_line_into_the_original() {
        let original = "# Title\n\n* one\n* two\n* three\n\nend\n";
        let before = "# Title\n\n- one\n- two\n- three\n\nend\n";
        let after = "# Title\n\n- one\n- two!\n- three\n\nend\n";
        assert_eq!(
            patch_markdown(original, before, after).unwrap(),
            "# Title\n\n* one\n- two!\n* three\n\nend\n"
        );
    }

    #[test]
    fn keeps_the_front_matter_and_edits_the_body() {
        let original = "---\ntitle: x\n---\n# A\n\ntext\n";
        let patched = patch_markdown(original, "# A\n\ntext\n", "# A\n\ntext more\n").unwrap();
        assert_eq!(patched, "---\ntitle: x\n---\n# A\n\ntext more\n");
    }

    #[test]
    fn inserts_and_deletes_lines() {
        let original = "a\n\nb\n\nc\n";
        assert_eq!(
            patch_markdown(original, original, "a\n\nb\n\nnew\n\nc\n").unwrap(),
            "a\n\nb\n\nnew\n\nc\n"
        );
        assert_eq!(
            patch_markdown(original, original, "a\n\nc\n").unwrap(),
            "a\n\nc\n"
        );
        assert_eq!(
            patch_markdown(original, original, "start\n\na\n\nb\n\nc\n").unwrap(),
            "start\n\na\n\nb\n\nc\n"
        );
    }

    #[test]
    fn keeps_crlf_in_old_and_new_lines() {
        let original = "# T\r\n\r\n* a\r\n* b\r\n";
        let before = "# T\n\n- a\n- b\n";
        let after = "# T\n\n- a\n- b\n- c\n";
        assert_eq!(
            patch_markdown(original, before, after).unwrap(),
            "# T\r\n\r\n* a\r\n* b\r\n- c\r\n"
        );
    }

    #[test]
    fn keeps_lf_when_the_original_is_lf() {
        let original = "a\nb\n";
        assert_eq!(
            patch_markdown(original, "a\nb\n", "a\nb\nc\n").unwrap(),
            "a\nb\nc\n"
        );
    }

    #[test]
    fn keeps_a_text_without_a_final_line_end() {
        assert_eq!(patch_markdown("a\nb", "a\nb", "a\nB").unwrap(), "a\nB");
        assert_eq!(
            patch_markdown("a\nb", "a\nb", "a\nb\nc").unwrap(),
            "a\nb\nc"
        );
        assert_eq!(
            patch_markdown("a\nb", "a\nb\n", "a\nb\nc\n").unwrap(),
            "a\nb\nc"
        );
        assert_eq!(patch_markdown("a\nb\n", "a\nb", "a\nB").unwrap(), "a\nB\n");
    }

    #[test]
    fn writes_into_an_empty_original() {
        assert_eq!(patch_markdown("", "", "hello\n").unwrap(), "hello\n");
    }

    #[test]
    fn edits_a_line_the_editor_rewrote_by_replacing_that_line() {
        // The table is padded by the editor; a cell is edited. The line is replaced as the editor wrote it, the rest stays.
        let original = "intro\n\n|a|b|\n|-|-|\n|1|2|\n\nend\n";
        let before = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nend\n";
        let after = "intro\n\n| a | b |\n| - | - |\n| 1 | 3 |\n\nend\n";
        assert_eq!(
            patch_markdown(original, before, after).unwrap(),
            "intro\n\n|a|b|\n|-|-|\n| 1 | 3 |\n\nend\n"
        );
    }

    #[test]
    fn edits_a_renumbered_list_line() {
        let original = "1. a\n1. b\n1. c\n";
        let before = "1. a\n2. b\n3. c\n";
        let after = "1. a\n2. bb\n3. c\n";
        assert_eq!(
            patch_markdown(original, before, after).unwrap(),
            "1. a\n2. bb\n1. c\n"
        );
    }

    #[test]
    fn keeps_lines_only_the_original_has() {
        // A comment the editor drops is not in `before`; it stays.
        let original = "a\n<!-- note -->\nb\n";
        assert_eq!(
            patch_markdown(original, "a\nb\n", "a\nB\n").unwrap(),
            "a\n<!-- note -->\nB\n"
        );
    }

    #[test]
    fn no_match_for_an_edit_over_a_line_only_the_original_has() {
        // The comment lies inside the replaced range: replacing the range would drop it.
        let original = "a\n<!-- c -->\nb\n";
        assert_eq!(
            patch_markdown(original, "a\nb\n", "A\nB\n"),
            Err(PatchError::NoMatch)
        );
        // An edit on one side of it leaves it.
        assert_eq!(
            patch_markdown(original, "a\nb\n", "A\nb\n").unwrap(),
            "A\n<!-- c -->\nb\n"
        );
    }

    #[test]
    fn no_edit_is_no_match_when_the_lines_cannot_be_paired() {
        // The answer of the open-time check: the original and the export do not line up.
        assert_eq!(
            patch_markdown("x\ny\nz\n", "a\nb\nc\nd\n", "a\nb\nc\nd\n"),
            Err(PatchError::NoMatch)
        );
        assert_eq!(
            patch_markdown("---\nt: 1\n---\nx\ny\nz\n", "a\nb\nc\nd\n", "a\nb\nc\nd\n"),
            Err(PatchError::NoMatch)
        );
    }

    #[test]
    fn no_edit_is_the_original_when_the_lines_pair_up() {
        let original = "a\n<!-- c -->\n* b\n";
        assert_eq!(
            patch_markdown(original, "a\n- b\n", "a\n- b\n").unwrap(),
            original
        );
    }

    #[test]
    fn is_no_match_when_the_original_no_longer_holds_the_edited_lines() {
        let original = "x\ny\nz\n";
        assert_eq!(
            patch_markdown(original, "a\nb\nc\nd\n", "a\nB\nc\nd\n"),
            Err(PatchError::NoMatch)
        );
    }

    #[test]
    fn is_no_match_inside_an_unpaired_stretch() {
        // Three lines of `before` face four of the original, none alike: which of them the edit means is not certain.
        let original = "top\n* p\n* q\n* r\n* s\nbottom\n";
        let before = "top\n- x\n- y\n- z\nbottom\n";
        let after = "top\n- x\n- w\n- z\nbottom\n";
        assert_eq!(
            patch_markdown(original, before, after),
            Err(PatchError::NoMatch)
        );
    }

    #[test]
    fn replaces_a_whole_unpaired_stretch() {
        let original = "top\n* a\n* a2\n* a3\nbottom\n";
        let before = "top\n- a\n- b\nbottom\n";
        let after = "top\nnew\nbottom\n";
        assert_eq!(
            patch_markdown(original, before, after).unwrap(),
            "top\nnew\nbottom\n"
        );
    }

    #[test]
    fn is_too_large_over_the_limit_in_any_argument() {
        let big = "a".repeat(MAX_TEXT + 1);
        let small = "a\n";
        assert_eq!(
            patch_markdown(&big, small, small),
            Err(PatchError::TooLarge)
        );
        assert_eq!(
            patch_markdown(small, &big, small),
            Err(PatchError::TooLarge)
        );
        assert_eq!(
            patch_markdown(small, small, &big),
            Err(PatchError::TooLarge)
        );
        assert!(patch_markdown(&"a".repeat(MAX_TEXT), small, small).is_ok());
    }

    #[test]
    fn the_commands_map_the_results() {
        assert_eq!(
            patch("a\n", "a\n", "b\n").unwrap(),
            MarkdownPatchResult::Patched {
                text: "b\n".to_owned()
            }
        );
        assert_eq!(
            patch("x\n", "a\nb\nc\nd\n", "a\nB\nc\nd\n").unwrap(),
            MarkdownPatchResult::Conflict
        );
        let big = "a".repeat(MAX_TEXT + 1);
        assert!(patch(&big, "", "").is_err());
        assert!(split(&big).is_err());
        assert_eq!(
            split("---\na: 1\n---\nb\n").unwrap(),
            MarkdownParts {
                front: "---\na: 1\n---\n".to_owned(),
                body: "b\n".to_owned()
            }
        );
    }
}
