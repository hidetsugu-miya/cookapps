//! A mail address header taken apart: a From header or one To entry as a display name and an address.

/// A From header or one To entry as its display name and its address.
#[derive(Debug, PartialEq, Eq)]
pub struct SplitAddress {
    /// The name of `Name <addr>`; empty when there is no name.
    pub name: String,
    pub address: String,
}

impl SplitAddress {
    /// What a list shows for the sender: the name, else the address.
    pub fn display(&self) -> &str {
        if self.name.is_empty() {
            &self.address
        } else {
            &self.name
        }
    }
}

/// `\s` of a JavaScript regular expression, which is also what `String.prototype.trim` removes.
/// Not `char::is_whitespace`: that has U+0085 and lacks U+FEFF.
fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// What `.` of a JavaScript regular expression does not match.
fn is_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The address of `Name <addr>`, with the name from `name_start`, if the rest of `chars` is that form.
/// `last` is the index of the last character that is not a space, and `after_gt` the index after the last `>` before it.
fn name_and_address(
    chars: &[char],
    name_start: usize,
    last: usize,
    after_gt: usize,
) -> Option<SplitAddress> {
    // The name is the shortest run of characters, none a line end, that is followed by an optional `"`, spaces and the `<`.
    // That `<` has no `>` between it and the last character, which is the `>` that closes the address.
    for name_end in name_start..=last {
        let after_quote = (chars.get(name_end) == Some(&'"')).then_some(name_end + 1);
        for from in after_quote.into_iter().chain([name_end]) {
            let open = from + chars[from..].iter().take_while(|&&c| is_space(c)).count();
            if open < last && open >= after_gt && chars[open] == '<' {
                return Some(SplitAddress {
                    name: chars[name_start..name_end].iter().collect(),
                    address: chars[open + 1..last].iter().collect(),
                });
            }
        }
        if is_line_end(chars[name_end]) {
            break;
        }
    }
    None
}

/// A From header or one To entry as its name and address: `Name <addr>` (the name may be in double quotes) splits,
/// and anything else is an address with no name. This is the rule of `splitAddress` in `ts/format.ts`, which it replaces
/// (`/^\s*"?(.*?)"?\s*<([^>]*)>\s*$/`), and not that of `image_senders::sender_address`.
pub fn split_address(s: &str) -> SplitAddress {
    let chars: Vec<char> = s.chars().collect();
    let found = chars.iter().rposition(|&c| !is_space(c)).and_then(|last| {
        if chars[last] != '>' {
            return None;
        }
        let after_gt = chars[..last]
            .iter()
            .rposition(|&c| c == '>')
            .map_or(0, |i| i + 1);
        let start = chars.iter().take_while(|&&c| is_space(c)).count();
        // A `"` right after the spaces is taken into the pattern first, and left to the name only when that fails.
        let after_quote = (chars.get(start) == Some(&'"')).then_some(start + 1);
        after_quote
            .into_iter()
            .chain([start])
            .find_map(|name_start| name_and_address(&chars, name_start, last, after_gt))
    });
    found.unwrap_or_else(|| SplitAddress {
        name: String::new(),
        address: s.trim_matches(is_space).to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(s: &str) -> (String, String) {
        let a = split_address(s);
        (a.name, a.address)
    }

    fn pair(name: &str, address: &str) -> (String, String) {
        (name.to_owned(), address.to_owned())
    }

    #[test]
    fn splits_a_name_and_an_address() {
        assert_eq!(
            split("Alice <alice@example.com>"),
            pair("Alice", "alice@example.com")
        );
        assert_eq!(
            split("Alice Smith <alice@example.com>"),
            pair("Alice Smith", "alice@example.com")
        );
    }

    #[test]
    fn takes_the_double_quotes_off_a_name() {
        assert_eq!(
            split(r#""Alice Smith" <alice@example.com>"#),
            pair("Alice Smith", "alice@example.com")
        );
        assert_eq!(
            split(r#""Doe, John" <j@x.com>"#),
            pair("Doe, John", "j@x.com")
        );
        // Only the quote at each end goes; one inside stays.
        assert_eq!(split(r#""A "B" C" <a@x>"#), pair(r#"A "B" C"#, "a@x"));
        assert_eq!(split(r#""Alice <a@x>"#), pair("Alice", "a@x"));
    }

    #[test]
    fn a_header_without_angle_brackets_is_an_address() {
        assert_eq!(split("alice@example.com"), pair("", "alice@example.com"));
        assert_eq!(split("Alice"), pair("", "Alice"));
        assert_eq!(split(""), pair("", ""));
        assert_eq!(split("   "), pair("", ""));
        assert_eq!(split("<a@x"), pair("", "<a@x"));
        assert_eq!(split("a@x>"), pair("", "a@x>"));
    }

    #[test]
    fn spaces_around_the_parts_go() {
        assert_eq!(
            split("  Alice   <alice@example.com>  "),
            pair("Alice", "alice@example.com")
        );
        assert_eq!(
            split("  alice@example.com\t"),
            pair("", "alice@example.com")
        );
        // The spaces inside the brackets stay.
        assert_eq!(split("A < a@x >"), pair("A", " a@x "));
        // The name keeps its own inner spaces, and its trailing spaces go to the `\s*` before `<`.
        assert_eq!(split("A  B  <a@x>"), pair("A  B", "a@x"));
        assert_eq!(split("\u{3000}A\u{3000}<a@x>"), pair("A", "a@x"));
    }

    #[test]
    fn an_address_may_be_empty_or_have_no_name() {
        assert_eq!(split("<a@example.com>"), pair("", "a@example.com"));
        assert_eq!(split("<>"), pair("", ""));
        assert_eq!(split("<"), pair("", "<"));
        assert_eq!(split(">"), pair("", ">"));
        assert_eq!(split("Alice <>"), pair("Alice", ""));
        assert_eq!(split(r#""" <a@x>"#), pair("", "a@x"));
        assert_eq!(split(r#""<a@x>"#), pair("", "a@x"));
    }

    #[test]
    fn a_less_than_sign_inside_the_name_or_a_quote_is_read_as_the_regex_does() {
        // The first `<` that leaves the rest as `[^>]*>` wins; a `>` before the last one rules the earlier `<` out.
        assert_eq!(split(r#""A <B>" <a@x>"#), pair(r#"A <B>"#, "a@x"));
        assert_eq!(split("A <B <a@x>"), pair("A", "B <a@x"));
        assert_eq!(split("A <B> <a@x>"), pair("A <B>", "a@x"));
        assert_eq!(split("A <B> C"), pair("", "A <B> C"));
    }

    #[test]
    fn a_name_does_not_run_over_a_line_end_but_an_address_does() {
        assert_eq!(split("A\nB <a@x>"), pair("", "A\nB <a@x>"));
        assert_eq!(split("A\u{2028}B <a@x>"), pair("", "A\u{2028}B <a@x>"));
        assert_eq!(split("A <a\n@x>"), pair("A", "a\n@x"));
        // Line ends that are spaces are taken before the name and after the brackets.
        assert_eq!(split("\nA <a@x>\r\n"), pair("A", "a@x"));
        assert_eq!(split("A\n<a@x>"), pair("A", "a@x"));
    }

    #[test]
    fn the_spaces_are_those_of_javascript() {
        // U+FEFF is a space for `\s` and `trim`, and U+0085 is not.
        assert_eq!(split("\u{feff}A <a@x>"), pair("A", "a@x"));
        assert_eq!(split("\u{85}A <a@x>"), pair("\u{85}A", "a@x"));
        assert_eq!(split("\u{85}a@x"), pair("", "\u{85}a@x"));
        assert_eq!(split("\u{feff}a@x\u{a0}"), pair("", "a@x"));
    }

    #[test]
    fn the_list_shows_the_name_else_the_address() {
        assert_eq!(split_address("Alice <a@x>").display(), "Alice");
        assert_eq!(split_address("a@x").display(), "a@x");
        assert_eq!(split_address("<a@x>").display(), "a@x");
        assert_eq!(split_address("").display(), "");
    }
}
