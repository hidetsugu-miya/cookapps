//! A-11: answers a question of Claude (AskUserQuestion) in the history of an Orca session. The picks are typed into the session's terminal one key at a time, as a user would:
//! before each key the screen is read until it shows what the key is for, so a key never lands in the composer of a session that does not ask.
//! The keys are digits and Tab, built here; nothing the screen holds becomes a key. It was written against Claude Code 2.1.318 and Orca 1.4.249, and an update of either can change the screens (then nothing is sent).

use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::orca::{blocking, check_target, press_key, read_screen};

/// Questions one call may answer, and choices one question may have (a choice is typed as one digit).
const MAX_QUESTIONS: usize = 10;
const MAX_OPTIONS: usize = 9;
/// How long a key waits for its screen, and how often the screen is read meanwhile.
const STEP_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);
const NOT_SHOWN: &str = "質問が画面に出ていません。ターミナルで答えてください";
const CHANGED: &str = "回答の途中で画面が変わりました。ターミナルで続けてください";
/// What follows the last answer on the screen that asks to submit.
const READY: &str = "Readytosubmityouranswers?";

/// One question with the choices picked, as the history shows it. `picks` are 0-based indexes into `options`.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct AnswerQuestion {
    pub text: String,
    pub multi: bool,
    pub options: Vec<String>,
    pub picks: Vec<usize>,
}

/// A screen of Claude Code a key waits for.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Screen<'a> {
    /// The question is asked and nothing of it is picked yet.
    QuestionShown(&'a AnswerQuestion),
    /// The choice (0-based) of a multiple-choice question is checked.
    OptionChecked(&'a AnswerQuestion, usize),
    /// The review of all the answers, asking to submit.
    Confirm(&'a [AnswerQuestion]),
}

/// A key and the screen it waits for.
#[derive(Clone, Debug, PartialEq)]
struct AnswerStep<'a> {
    wait: Screen<'a>,
    key: String,
}

fn check_questions(questions: &[AnswerQuestion]) -> Result<(), String> {
    if questions.is_empty() {
        return Err("答える質問がありません".into());
    }
    if questions.len() > MAX_QUESTIONS {
        return Err(format!("一度に答えられる質問は {MAX_QUESTIONS} 個までです"));
    }
    for q in questions {
        if q.text.trim().is_empty() {
            return Err("質問の文がありません".into());
        }
        if q.options.is_empty() || q.options.len() > MAX_OPTIONS {
            return Err(format!("選択肢は 1 個から {MAX_OPTIONS} 個までです"));
        }
        if q.options.iter().any(|o| o.trim().is_empty()) {
            return Err("選択肢の文がありません".into());
        }
        if q.picks.is_empty() {
            return Err("選択肢を選んでください".into());
        }
        if q.picks.iter().any(|&p| p >= q.options.len()) {
            return Err("選んだ選択肢がありません".into());
        }
        let mut picks = q.picks.clone();
        picks.sort_unstable();
        picks.dedup();
        if picks.len() != q.picks.len() {
            return Err("同じ選択肢を重ねて選べません".into());
        }
        if !q.multi && q.picks.len() != 1 {
            return Err("選べるのは 1 つだけの質問です".into());
        }
    }
    Ok(())
}

/// The keys that answer `questions` (already checked) and the screen each waits for. A single choice is a digit; a multiple choice is a digit for each pick in the order of the choices, then Tab.
/// The review is reached after the last question unless the only question is a single choice (it is sent by its digit), and its Submit is the digit 1.
fn answer_steps(questions: &[AnswerQuestion]) -> Vec<AnswerStep<'_>> {
    let mut steps = Vec::new();
    for q in questions {
        let mut picks = q.picks.clone();
        picks.sort_unstable();
        let mut wait = Screen::QuestionShown(q);
        for &pick in &picks {
            steps.push(AnswerStep {
                wait,
                key: (pick + 1).to_string(),
            });
            wait = Screen::OptionChecked(q, pick);
        }
        if q.multi {
            steps.push(AnswerStep {
                wait,
                key: "\t".into(),
            });
        }
    }
    if questions.len() > 1 || questions.iter().any(|q| q.multi) {
        steps.push(AnswerStep {
            wait: Screen::Confirm(questions),
            key: "1".into(),
        });
    }
    steps
}

/// The text with every blank removed: the screen wraps and pads lines, so only the characters are compared.
fn squash(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The choices of `q` that are picked, in the order of the choices, as the review lists them.
fn picked_labels(q: &AnswerQuestion) -> String {
    let mut picks = q.picks.clone();
    picks.sort_unstable();
    picks
        .iter()
        .map(|&p| q.options[p].as_str())
        .collect::<Vec<_>>()
        .join(",")
}

/// Whether the screen is the one `want` names. The comparison has no blanks, so a wrapped line still matches.
fn screen_shows(lines: &[String], want: Screen) -> bool {
    let screen = squash(&lines.concat());
    let has = |text: &str| screen.contains(&squash(text));
    match want {
        Screen::QuestionShown(q) => {
            let mark = if q.multi { "[ ]" } else { "" };
            has(&q.text)
                && q.options
                    .iter()
                    .enumerate()
                    .all(|(i, label)| has(&format!("{}.{mark}{label}", i + 1)))
        }
        Screen::OptionChecked(q, option) => {
            has(&format!("{}.[✔]{}", option + 1, q.options[option]))
        }
        Screen::Confirm(questions) => {
            has("Ready to submit your answers?")
                && has("1. Submit answers")
                && questions.iter().all(|q| {
                    // The answer ends where the next one or the question to submit starts: "Banana" is not "Banana, Bean".
                    let answer = squash(&format!("●{}→{}", q.text, picked_labels(q)));
                    screen.match_indices(&answer).any(|(at, found)| {
                        let rest = &screen[at + found.len()..];
                        rest.starts_with('●') || rest.starts_with(READY)
                    })
                })
        }
    }
}

/// The message of a failure after some keys were typed: they are in the terminal.
fn midway(message: String, started: bool) -> String {
    if started {
        format!("{message}（回答は途中までターミナルに入っています。ターミナルで続けてください）")
    } else {
        message
    }
}

/// Types the steps one key at a time. Before each key the screen is read every `poll` for at most `wait`, until it is the step's; a screen that never gets there stops the answer.
fn run_steps(
    steps: &[AnswerStep],
    mut read: impl FnMut() -> Result<Vec<String>, String>,
    mut press: impl FnMut(&str) -> Result<(), String>,
    wait: Duration,
    poll: Duration,
) -> Result<(), String> {
    for (i, step) in steps.iter().enumerate() {
        let started = i > 0;
        let deadline = Instant::now() + wait;
        loop {
            let lines = read().map_err(|e| midway(e, started))?;
            if screen_shows(&lines, step.wait) {
                break;
            }
            if Instant::now() >= deadline {
                return Err(if started { CHANGED } else { NOT_SHOWN }.into());
            }
            std::thread::sleep(poll);
        }
        press(&step.key).map_err(|e| midway(e, started))?;
    }
    Ok(())
}

fn answer(
    handle: &str,
    questions: &[AnswerQuestion],
    environment: Option<&str>,
) -> Result<(), String> {
    check_questions(questions)?;
    check_target(handle, environment)?;
    run_steps(
        &answer_steps(questions),
        || read_screen(handle, environment),
        |key| press_key(handle, key, environment),
        STEP_WAIT,
        POLL,
    )
}

/// Answers the questions of the session `handle` (A-11). Each key is typed only when the screen shows what it is for; a send is never tried again.
#[tauri::command]
pub async fn orca_answer(
    handle: String,
    questions: Vec<AnswerQuestion>,
    environment: Option<String>,
) -> Result<(), String> {
    blocking(move || answer(&handle, &questions, environment.as_deref())).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(text: &str, multi: bool, options: &[&str], picks: &[usize]) -> AnswerQuestion {
        AnswerQuestion {
            text: text.into(),
            multi,
            options: options.iter().map(|o| (*o).into()).collect(),
            picks: picks.to_vec(),
        }
    }

    fn alpha(pick: usize) -> AnswerQuestion {
        question("Pick alpha?", false, &["Apple", "Avocado"], &[pick])
    }

    fn beta(picks: &[usize]) -> AnswerQuestion {
        question("Pick beta?", true, &["Banana", "Berry", "Bean"], picks)
    }

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_owned).collect()
    }

    /// The screens of Claude Code 2.1.318, as measured.
    const ECHO: &str = "> ask me Pick alpha?\n\nThinking...";
    const ALPHA: &str =
        "Pick alpha?\n❯ 1. Apple\n  2. Avocado\n  3. Type something\n  4. Chat about this";
    const BETA: &str =
        "Pick beta?\n❯ 1. [ ] Banana\n  2. [ ] Berry\n  3. [ ] Bean\n  4. Type something";
    const BETA_CHECKED: &str =
        "Pick beta?\n❯ 1. [✔] Banana\n  2. [ ] Berry\n  3. [ ] Bean\n  4. Type something";
    const CONFIRM: &str = "Review your answers\n\n ● Pick alpha?\n   → Avocado\n ● Pick beta?\n   → Banana, Bean\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel";

    fn shows(text: &str, want: Screen) -> bool {
        screen_shows(&lines(text), want)
    }

    #[test]
    fn the_questions_are_checked_before_anything_is_typed() {
        let ok = [alpha(1), beta(&[0, 2])];
        assert_eq!(check_questions(&ok), Ok(()));
        let many = vec![alpha(0); MAX_QUESTIONS + 1];
        let bad = [
            (vec![], "答える質問がありません"),
            (many, "一度に答えられる質問は 10 個までです"),
            (
                vec![question(" ", false, &["A"], &[0])],
                "質問の文がありません",
            ),
            (
                vec![question("Q", false, &[], &[0])],
                "選択肢は 1 個から 9 個までです",
            ),
            (
                vec![question("Q", false, &["a"; 10], &[0])],
                "選択肢は 1 個から 9 個までです",
            ),
            (
                vec![question("Q", false, &["A", " "], &[0])],
                "選択肢の文がありません",
            ),
            (
                vec![question("Q", true, &["A"], &[])],
                "選択肢を選んでください",
            ),
            (
                vec![question("Q", false, &["A", "B"], &[2])],
                "選んだ選択肢がありません",
            ),
            (
                vec![question("Q", true, &["A", "B"], &[1, 1])],
                "同じ選択肢を重ねて選べません",
            ),
            (
                vec![question("Q", false, &["A", "B"], &[0, 1])],
                "選べるのは 1 つだけの質問です",
            ),
        ];
        for (questions, message) in bad {
            assert_eq!(check_questions(&questions), Err(message.into()));
        }
        // 9 choices and 10 questions are the most.
        assert_eq!(
            check_questions(&vec![question("Q", false, &["a"; 9], &[8]); MAX_QUESTIONS]),
            Ok(())
        );
    }

    fn keys<'a>(steps: &'a [AnswerStep]) -> Vec<&'a str> {
        steps.iter().map(|s| s.key.as_str()).collect()
    }

    #[test]
    fn one_single_choice_is_sent_by_its_digit_with_no_review() {
        let questions = [alpha(1)];
        let steps = answer_steps(&questions);
        assert_eq!(
            steps,
            [AnswerStep {
                wait: Screen::QuestionShown(&questions[0]),
                key: "2".into()
            }]
        );
    }

    #[test]
    fn one_multiple_choice_toggles_in_the_order_of_the_choices_then_tabs_to_the_review() {
        // The picks come in any order; the keys follow the choices.
        let questions = [beta(&[2, 0])];
        let steps = answer_steps(&questions);
        assert_eq!(keys(&steps), ["1", "3", "\t", "1"]);
        assert_eq!(steps[0].wait, Screen::QuestionShown(&questions[0]));
        assert_eq!(steps[1].wait, Screen::OptionChecked(&questions[0], 0));
        assert_eq!(steps[2].wait, Screen::OptionChecked(&questions[0], 2));
        assert_eq!(steps[3].wait, Screen::Confirm(&questions));
    }

    #[test]
    fn two_single_choices_go_on_by_digit_and_end_at_the_review() {
        let questions = [
            alpha(0),
            question("Pick gamma?", false, &["Fig", "Grape"], &[1]),
        ];
        let steps = answer_steps(&questions);
        assert_eq!(keys(&steps), ["1", "2", "1"]);
        assert_eq!(steps[0].wait, Screen::QuestionShown(&questions[0]));
        assert_eq!(steps[1].wait, Screen::QuestionShown(&questions[1]));
        assert_eq!(steps[2].wait, Screen::Confirm(&questions));
    }

    #[test]
    fn a_single_choice_then_a_multiple_choice() {
        let questions = [alpha(1), beta(&[0, 2])];
        let steps = answer_steps(&questions);
        assert_eq!(keys(&steps), ["2", "1", "3", "\t", "1"]);
        assert_eq!(steps[1].wait, Screen::QuestionShown(&questions[1]));
        assert_eq!(steps[2].wait, Screen::OptionChecked(&questions[1], 0));
        assert_eq!(steps[3].wait, Screen::OptionChecked(&questions[1], 2));
    }

    #[test]
    fn a_question_is_shown_with_all_its_numbered_choices() {
        let q = alpha(0);
        assert!(shows(ALPHA, Screen::QuestionShown(&q)));
        // The echo of the prompt has the question but no numbered choices.
        assert!(!shows(ECHO, Screen::QuestionShown(&q)));
        // Only some of the choices are there yet.
        assert!(!shows("Pick alpha?\n❯ 1. Apple", Screen::QuestionShown(&q)));
        // The choices of another question.
        assert!(!shows(BETA, Screen::QuestionShown(&q)));
        // The review has the question and the answer, not the numbered choices.
        assert!(!shows(CONFIRM, Screen::QuestionShown(&q)));
        // An answered screen of the history.
        assert!(!shows(
            "● Pick alpha?\n  → Apple",
            Screen::QuestionShown(&q)
        ));
    }

    #[test]
    fn a_multiple_choice_is_shown_only_while_nothing_of_it_is_checked() {
        let q = beta(&[0]);
        assert!(shows(BETA, Screen::QuestionShown(&q)));
        assert!(!shows(BETA_CHECKED, Screen::QuestionShown(&q)));
        // A single-choice screen has no boxes.
        assert!(!shows(ALPHA, Screen::QuestionShown(&q)));
    }

    #[test]
    fn a_wrapped_or_padded_screen_still_matches() {
        let q = question(
            "Which of the long-named things?",
            false,
            &["Fruit and nuts"],
            &[0],
        );
        let wrapped = [
            "Which of the long-named",
            "  things?",
            "❯ 1. Fruit and",
            "     nuts",
        ]
        .map(String::from);
        assert!(screen_shows(&wrapped, Screen::QuestionShown(&q)));
        // A label cut in the middle of a word by the wrap.
        let cut = ["Which of the long-named things?", "❯ 1. Fruit a", "nd nuts"].map(String::from);
        assert!(screen_shows(&cut, Screen::QuestionShown(&q)));
    }

    #[test]
    fn a_choice_is_checked_when_its_box_has_the_mark() {
        let q = beta(&[0, 1]);
        assert!(shows(BETA_CHECKED, Screen::OptionChecked(&q, 0)));
        assert!(!shows(BETA_CHECKED, Screen::OptionChecked(&q, 1)));
        assert!(!shows(BETA, Screen::OptionChecked(&q, 0)));
        let both = "Pick beta?\n❯ 1. [✔] Banana\n  2. [✔] Berry\n  3. [ ] Bean";
        assert!(shows(both, Screen::OptionChecked(&q, 1)));
    }

    #[test]
    fn the_review_must_show_every_answer_as_it_will_be_submitted() {
        let questions = [alpha(1), beta(&[2, 0])];
        assert!(shows(CONFIRM, Screen::Confirm(&questions)));
        // Another pick of the first question.
        assert!(!shows(CONFIRM, Screen::Confirm(&[alpha(0), beta(&[0, 2])])));
        // "Banana" alone is not "Banana, Bean".
        assert!(!shows(CONFIRM, Screen::Confirm(&[alpha(1), beta(&[0])])));
        // "Banana, Bean" is not "Bean" either.
        assert!(!shows(CONFIRM, Screen::Confirm(&[alpha(1), beta(&[2])])));
        // A question that is not in the review.
        let other = question("Pick gamma?", false, &["Fig"], &[0]);
        assert!(!shows(CONFIRM, Screen::Confirm(&[alpha(1), other])));
        // Without the request to submit it is not the review.
        let early = "● Pick alpha?\n  → Avocado\n● Pick beta?\n  → Banana, Bean";
        assert!(!shows(early, Screen::Confirm(&questions)));
    }

    #[test]
    fn the_last_answer_of_the_review_is_not_taken_for_a_longer_one() {
        let single = [question("Pick gamma?", false, &["Fig", "Fig pie"], &[0])];
        let review = "Review your answers\n● Pick gamma?\n  → Fig pie\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel";
        assert!(!shows(review, Screen::Confirm(&single)));
        let other = [question("Pick gamma?", false, &["Fig", "Fig pie"], &[1])];
        assert!(shows(review, Screen::Confirm(&other)));
    }

    /// A terminal that shows the next screen after each key typed, and the last one for good. A read or a send can be made to fail.
    struct Terminal {
        screens: Vec<&'static str>,
        at: usize,
        reads: usize,
        typed: Vec<String>,
        read_fails_at: Option<usize>,
        press_fails_at: Option<usize>,
    }

    impl Terminal {
        fn new(screens: &[&'static str]) -> Self {
            Terminal {
                screens: screens.to_vec(),
                at: 0,
                reads: 0,
                typed: Vec::new(),
                read_fails_at: None,
                press_fails_at: None,
            }
        }

        /// Runs the steps against it; gives the result and the keys typed.
        fn run(self, steps: &[AnswerStep]) -> (Result<(), String>, Vec<String>) {
            let this = std::cell::RefCell::new(self);
            let result = run_steps(
                steps,
                || {
                    let mut t = this.borrow_mut();
                    t.reads += 1;
                    if t.read_fails_at == Some(t.reads) {
                        return Err("読めません".into());
                    }
                    Ok(lines(t.screens[t.at]))
                },
                |key| {
                    let mut t = this.borrow_mut();
                    if t.press_fails_at == Some(t.typed.len()) {
                        return Err("送れません".into());
                    }
                    t.typed.push(key.into());
                    t.at = (t.at + 1).min(t.screens.len() - 1);
                    Ok(())
                },
                Duration::from_millis(30),
                Duration::from_millis(1),
            );
            (result, this.into_inner().typed)
        }
    }

    const BETA_CHECKED_BOTH: &str =
        "Pick beta?\n❯ 1. [✔] Banana\n  2. [ ] Berry\n  3. [✔] Bean\n  4. Type something";

    #[test]
    fn a_single_choice_is_typed_once_the_question_is_shown() {
        let questions = [alpha(1)];
        let (result, typed) = Terminal::new(&[ALPHA, "done"]).run(&answer_steps(&questions));
        assert_eq!(result, Ok(()));
        assert_eq!(typed, ["2"]);
    }

    #[test]
    fn two_questions_are_typed_key_by_key_through_to_the_submit() {
        let questions = [alpha(1), beta(&[2, 0])];
        let screens = [
            ALPHA,
            BETA,
            BETA_CHECKED,
            BETA_CHECKED_BOTH,
            CONFIRM,
            "done",
        ];
        let (result, typed) = Terminal::new(&screens).run(&answer_steps(&questions));
        assert_eq!(result, Ok(()));
        assert_eq!(typed, ["2", "1", "3", "\t", "1"]);
    }

    #[test]
    fn nothing_is_typed_while_the_question_is_not_on_the_screen() {
        // The prompt's echo has the question text, not the numbered choices.
        let questions = [alpha(0)];
        let (result, typed) = Terminal::new(&[ECHO]).run(&answer_steps(&questions));
        assert_eq!(result, Err(NOT_SHOWN.into()));
        assert!(typed.is_empty());
    }

    #[test]
    fn a_screen_that_comes_late_is_waited_for() {
        let questions = [alpha(0)];
        let steps = answer_steps(&questions);
        let mut reads = 0;
        let mut typed = Vec::new();
        let result = run_steps(
            &steps,
            || {
                reads += 1;
                Ok(lines(if reads < 4 { ECHO } else { ALPHA }))
            },
            |key| {
                typed.push(key.to_owned());
                Ok(())
            },
            Duration::from_millis(500),
            Duration::from_millis(1),
        );
        assert_eq!(result, Ok(()));
        assert_eq!(typed, ["1"]);
        assert_eq!(reads, 4);
    }

    #[test]
    fn a_screen_that_changes_midway_stops_after_the_keys_already_typed() {
        let questions = [alpha(1), beta(&[0])];
        let (result, typed) = Terminal::new(&[ALPHA, ECHO]).run(&answer_steps(&questions));
        assert_eq!(result, Err(CHANGED.into()));
        assert_eq!(typed, ["2"]);
    }

    #[test]
    fn a_multiple_choice_that_did_not_check_stops_before_the_next_key() {
        // The digit did not toggle the box: the next digit is not typed.
        let questions = [beta(&[0, 1])];
        let (result, typed) = Terminal::new(&[BETA, BETA]).run(&answer_steps(&questions));
        assert_eq!(result, Err(CHANGED.into()));
        assert_eq!(typed, ["1"]);
    }

    #[test]
    fn a_failed_read_or_send_says_whether_keys_are_already_in() {
        let questions = [alpha(1), beta(&[0])];
        let steps = answer_steps(&questions);
        let screens = [ALPHA, BETA, BETA_CHECKED, CONFIRM];
        let midway = |m: &str| {
            format!("{m}（回答は途中までターミナルに入っています。ターミナルで続けてください）")
        };
        let mut first = Terminal::new(&screens);
        first.read_fails_at = Some(1);
        let (result, typed) = first.run(&steps);
        assert_eq!(result, Err("読めません".into()));
        assert!(typed.is_empty());
        let mut later = Terminal::new(&screens);
        later.read_fails_at = Some(2);
        let (result, typed) = later.run(&steps);
        assert_eq!(result, Err(midway("読めません")));
        assert_eq!(typed, ["2"]);
        let mut press = Terminal::new(&screens);
        press.press_fails_at = Some(1);
        let (result, typed) = press.run(&steps);
        assert_eq!(result, Err(midway("送れません")));
        assert_eq!(typed, ["2"]);
        let mut first_key = Terminal::new(&screens);
        first_key.press_fails_at = Some(0);
        assert_eq!(first_key.run(&steps).0, Err("送れません".into()));
    }
}
