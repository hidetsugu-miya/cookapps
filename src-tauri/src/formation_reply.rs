//! The reply of a decision page (A-41): the answers the owner chose on the page of a child become the reply text, and the text goes into the leader's terminal under the line `判断ページの返信（{child}）`; the page is then no longer waiting.
//!
//! The reply text follows the reply format of the decision pages: a verdict line on an `approval` and a `code-review` page, then one block for each card that has an answer, the blocks and the verdict separated by one blank line. A block is `{number} {title}`, the answer line (`{key}. {label}` for a lettered option, the reply text of a fixed choice), and `補足: {text}`.
//! Everything in the reply is the child's text or the owner's, so it goes into the terminal as one bracketed paste with its control characters taken out (a paste end that the text carries cannot close the paste early, and an Enter in the middle of a line cannot send half of it), and Enter follows only after the paste has ended.

use std::{collections::HashSet, time::Duration};

use serde::Deserialize;
#[cfg(test)]
use ts_rs::TS;

use crate::{
    auth::config_dir,
    claude_code::ClaudeCode,
    formation::{self, LOCAL},
    formation_page::{self, Card, CardKind, DecisionPage, PageKind, Subject},
    orca,
};

/// What the owner chose on one card of the page: the key of the choice (a lettered option's, or a fixed choice's) and the free text.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct PageAnswer {
    /// The card's number.
    pub card: String,
    pub choice: Option<String>,
    pub note: String,
}

/// What the owner chose in the verdict box of an `approval` and a `code-review` page: to approve, or to ask for a revision.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum PageVerdict {
    Approve,
    Revise,
}

/// The choices of a kind that every card of it has, as `(key, reply text)`: the lettered options of the card come before them.
fn fixed(kind: CardKind) -> &'static [(&'static str, &'static str)] {
    match kind {
        CardKind::Question => &[("investigate", "調べてから決めて"), ("other", "その他")],
        CardKind::Nr => &[("other", "その他")],
        CardKind::ReviewDecision => &[("defer", "今回は対応しない"), ("other", "その他")],
        CardKind::MustFix => &[
            ("fix", "指摘のとおり修正する"),
            ("skip", "今回は対応しない"),
        ],
        CardKind::StructuralProposal => {
            &[("approve", "承認"), ("reject", "却下"), ("hold", "保留")]
        }
        CardKind::Adr => &[("keep", "残す"), ("decline", "不要")],
        CardKind::ReviewMustFix => &[
            ("fix", "修正して再レビューする"),
            ("accept", "現状で完了する"),
        ],
        CardKind::UnmetCriterion => &[],
    }
}

/// Whether a card of this kind must be answered before the reply can be sent.
fn required(kind: CardKind) -> bool {
    matches!(kind, CardKind::Question | CardKind::MustFix)
}

/// Whether the choice asks for a revision (an approve verdict cannot go with it).
fn revision(kind: CardKind, key: &str) -> bool {
    matches!(kind, CardKind::MustFix | CardKind::ReviewMustFix) && key == "fix"
}

/// The cards of the page that take an answer, in the order the page draws them.
fn asking_cards(page: &DecisionPage) -> Vec<&Card> {
    let groups: Vec<&Card> = match page.page_kind {
        PageKind::OpenQuestions => page.questions.iter().collect(),
        PageKind::Approval => page
            .needs_user_decision
            .iter()
            .chain(&page.residual_must_fix)
            .chain(&page.structural_proposals)
            .chain(page.adr.iter())
            .collect(),
        PageKind::CodeReview => page
            .residual_must_fix
            .iter()
            .chain(&page.unmet_criteria)
            .chain(&page.needs_user_decision)
            .collect(),
    };
    groups
        .into_iter()
        .filter(|card| !fixed(card.kind).is_empty())
        .collect()
}

/// `text` for a terminal: line ends are `\n`, a tab is a blank, and every other control character (an ESC with the paste marks, a C1 control) is gone.
fn clean(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter_map(|c| match c {
            '\n' => Some('\n'),
            '\t' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

/// `clean`, on one line: a title or a label never breaks a line of the reply.
fn one_line(text: &str) -> String {
    clean(text).replace('\n', " ").trim().to_owned()
}

/// The verdict line of the page: the approve line, or the revise line, as the owner chose.
fn verdict(kind: PageKind, subject: Subject, chosen: PageVerdict) -> Result<&'static str, String> {
    let (approve, ask) = match (kind, subject) {
        (PageKind::Approval, Subject::Requirement) => {
            ("要件定義を承認します", "要件定義の修正を依頼します")
        }
        (PageKind::Approval, Subject::Design) => {
            ("基本設計を承認します", "基本設計の修正を依頼します")
        }
        (PageKind::CodeReview, Subject::Code) => ("この変更を承認します", "修正を依頼します"),
        _ => return Err("この判断ページには、返信の形式がありません".to_owned()),
    };
    Ok(match chosen {
        PageVerdict::Approve => approve,
        PageVerdict::Revise => ask,
    })
}

/// One card's block, and whether its choice asks for a revision; `None` for a card with no answer (no choice, or `その他` with no text, and no note that counts).
fn block_of(card: &Card, answer: Option<&PageAnswer>) -> Result<Option<(String, bool)>, String> {
    let Some(answer) = answer else {
        return Ok(None);
    };
    let key = answer.choice.as_deref().filter(|k| !k.is_empty());
    let lettered = card.kind.lettered();
    let text = match key {
        None => None,
        Some(key) => {
            let fixed_text = fixed(card.kind).iter().find(|(k, _)| *k == key);
            let option = lettered
                .then(|| card.options.iter().find(|o| o.key == key))
                .flatten();
            match (fixed_text, option) {
                (Some((_, text)), _) => Some((*text).to_owned()),
                (None, Some(option)) => {
                    Some(format!("{}. {}", option.key, one_line(&option.label)))
                }
                (None, None) => {
                    return Err(format!(
                        "カード「{}」に選択肢「{key}」はありません",
                        one_line(&card.number)
                    ))
                }
            }
        }
    };
    // The free text of a lettered card counts only under `その他`; the other kinds' counts whatever is chosen.
    let note = if lettered && key != Some("other") {
        String::new()
    } else {
        clean(&answer.note).trim().to_owned()
    };
    if note.is_empty() && (key.is_none() || key == Some("other")) {
        return Ok(None);
    }
    let mut lines = vec![format!(
        "{} {}",
        one_line(&card.number),
        one_line(&card.title)
    )];
    lines.extend(text);
    if !note.is_empty() {
        lines.push(format!("補足: {note}"));
    }
    Ok(Some((
        lines.join("\n"),
        key.is_some_and(|k| revision(card.kind, k)),
    )))
}

/// The heading of the owner's own request for a revision, which comes right after the revise line.
const REVISION_HEADING: &str = "修正してほしいこと";

/// The reply text of `page` from `answers`: on an approval and a code review, first the verdict line that the owner chose (`verdict`; none is refused), then, on a revise verdict, the owner's own request for a revision (`revision`, under `修正してほしいこと`, when it has text), then the block of each card that has an answer, in the page's order. A card that does not ask, a card number twice, a number that is not on the page and a key the card does not offer are refused, and so is a page with a required card (`question`, `must-fix`) that has no answer, an approve verdict while a card has a revision choice (`fix`), a request for a revision under an approve verdict, and a verdict or a request on an `open-questions` page: the reply is not sent then.
pub fn build_reply(
    page: &DecisionPage,
    answers: &[PageAnswer],
    verdict_chosen: Option<PageVerdict>,
    revision: &str,
) -> Result<String, String> {
    let cards = asking_cards(page);
    let mut seen = HashSet::new();
    for answer in answers {
        if !cards.iter().any(|c| c.number == answer.card) {
            return Err(format!(
                "ページに、答えを受けるカード「{}」はありません",
                one_line(&answer.card)
            ));
        }
        if !seen.insert(answer.card.as_str()) {
            return Err(format!(
                "カード「{}」の答えが二つあります",
                one_line(&answer.card)
            ));
        }
    }
    let revision = clean(revision).trim().to_owned();
    let mut blocks = Vec::new();
    let mut missing = Vec::new();
    let mut revising = Vec::new();
    for card in cards {
        let answer = answers.iter().find(|a| a.card == card.number);
        match block_of(card, answer)? {
            Some((block, asks)) => {
                if asks {
                    revising.push(one_line(&card.number));
                }
                blocks.push(block);
            }
            None if required(card.kind) => missing.push(one_line(&card.number)),
            None => {}
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "回答が必要なカードが未回答です: {}",
            missing.join("、")
        ));
    }
    let mut parts = Vec::new();
    if page.page_kind == PageKind::OpenQuestions {
        if verdict_chosen.is_some() || !revision.is_empty() {
            return Err("この判断ページには、判定がありません".to_owned());
        }
    } else {
        let Some(chosen) = verdict_chosen else {
            return Err("判定が選ばれていません".to_owned());
        };
        if chosen == PageVerdict::Approve && !revising.is_empty() {
            return Err(format!(
                "修正を選んだカードがあるので、承認の答えは送れません: {}",
                revising.join("、")
            ));
        }
        if chosen == PageVerdict::Approve && !revision.is_empty() {
            return Err("承認の答えに、修正してほしいことは付けられません".to_owned());
        }
        parts.push(verdict(page.page_kind, page.subject, chosen)?.to_owned());
        if !revision.is_empty() {
            parts.push(format!("{REVISION_HEADING}\n{revision}"));
        }
    }
    parts.extend(blocks);
    if parts.is_empty() {
        return Err("返信にする答えがありません".to_owned());
    }
    Ok(parts.join("\n\n"))
}

/// What the leader's terminal gets: the line that tells whose reply it is, then the reply.
pub fn terminal_text(child: &str, reply: &str) -> String {
    format!("判断ページの返信（{}）\n{}", one_line(child), clean(reply))
}

/// Enter, sent on its own after the paste has ended.
pub const ENTER: &str = "\r";
/// The pause between the end of the paste and Enter, so that the terminal's program has taken the paste as one before Enter arrives.
pub const ENTER_PAUSE: Duration = Duration::from_millis(250);
const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// The text as one bracketed paste: the control characters of the text are taken out first, so that its own paste end cannot close the paste, and nothing in it is an Enter (`\r`) that would send a line before the rest is in. The paste has no Enter: `ENTER` follows it. The limit of a send (`orca::TEXT_LIMIT`) is the paste's, its two marks counted.
pub fn paste_of(text: &str) -> Result<String, String> {
    let paste = format!("{PASTE_START}{}{PASTE_END}", clean(text));
    if paste.chars().count() > orca::TEXT_LIMIT {
        return Err(format!(
            "返信が長すぎます（印を入れて {} 文字までです）",
            orca::TEXT_LIMIT
        ));
    }
    Ok(paste)
}

/// Puts `text` into the leader's terminal of the formation `name` of this Mac (the pane `formation:{name}`): the paste, a pause, then Enter.
async fn send_here(sessions: &ClaudeCode, name: &str, paste: String) -> Result<(), String> {
    sessions.input_formation(name, paste)?;
    tokio::time::sleep(ENTER_PAUSE).await;
    sessions.input_formation(name, ENTER.to_owned())
}

/// Puts `text` into the leader's terminal `handle` in the Orca of the saved environment `environment`.
async fn send_orca(environment: &str, handle: &str, paste: String) -> Result<(), String> {
    orca::type_in_steps(environment, handle, &[paste, ENTER.to_owned()], ENTER_PAUSE).await
}

/// The pages whose reply is on its way, by formation and child: a second press while the first is not done sends nothing.
fn sending() -> &'static std::sync::Mutex<HashSet<(String, String)>> {
    static SENDING: std::sync::OnceLock<std::sync::Mutex<HashSet<(String, String)>>> =
        std::sync::OnceLock::new();
    SENDING.get_or_init(Default::default)
}

/// A page whose reply was put into the leader's terminal and not yet marked as answered: its formation, its child and the time it was recorded at (`at`). The press that finds the page here marks it and sends nothing, so that a failed mark does not make the reply go twice.
type SentPage = (String, String, u64);

fn sent() -> &'static std::sync::Mutex<HashSet<SentPage>> {
    static SENT: std::sync::OnceLock<std::sync::Mutex<HashSet<SentPage>>> =
        std::sync::OnceLock::new();
    SENT.get_or_init(Default::default)
}

fn sent_pages() -> std::sync::MutexGuard<'static, HashSet<SentPage>> {
    sent()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Sends the reply with `send` unless it was sent already, then marks the page as answered with `mark`. The reply counts as sent from the moment `send` succeeds until `mark` does, so a press that follows a failed mark only marks.
async fn deliver(
    page: SentPage,
    send: impl AsyncFnOnce() -> Result<(), String>,
    mark: impl AsyncFnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !sent_pages().contains(&page) {
        send().await?;
        sent_pages().insert(page.clone());
    }
    mark()
        .await
        .map_err(|e| format!("返信は送りましたが、答えた印を付けられません: {e}"))?;
    sent_pages().remove(&page);
    Ok(())
}

/// Frees the place of a reply that is on its way when the send ends, whatever way it ends.
struct Sending((String, String));

impl Sending {
    fn take(formation: &str, child: &str) -> Result<Self, String> {
        let key = (formation.to_owned(), child.to_owned());
        let mut held = sending()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !held.insert(key.clone()) {
            return Err("この返信は送っているところです".to_owned());
        }
        Ok(Self(key))
    }
}

impl Drop for Sending {
    fn drop(&mut self) {
        sending()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// Sends the owner's `answers`, `verdict` and `revision` to the page that waits on the child `child` of the formation `name` (A-41) as the reply, into the leader's terminal, and takes the page off the waiting. `at_ms` is the time of the mark the screen drew the page for: a page that was replaced meanwhile is refused, because the answers belong to the page that was shown. The page is read again, so the reply is made of what is there now; nothing is sent when a required card has no answer or when the verdict is missing or does not fit the answers. A formation of this Mac has its leader in the app's own pseudo terminal; one of a saved environment has it in the terminal of that PC's Orca, and the page's record is on that PC. The page is read for its cards alone (`page_input_with_time`: its evidence is not resolved, because the reply holds none of it). A failure carries the message, and the page stays waiting; when the reply was sent and only the mark failed, the next press marks the page and sends nothing (`deliver`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn formation_page_answer(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, ClaudeCode>,
    name: String,
    child: String,
    at_ms: i64,
    answers: Vec<PageAnswer>,
    verdict: Option<PageVerdict>,
    revision: String,
) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let version = app.package_info().version.to_string();
    let sessions = sessions.inner().clone();
    formation::check_name(&name)?;
    formation::check_name(&child)?;
    let _sending = Sending::take(&name, &child)?;
    let at = u64::try_from(at_ms).map_err(|_| "ページの時刻が正しくありません".to_owned())?;
    let (environment, orchestrator) = formation::orchestrator_home(&dir, &name);
    let (page, current) = {
        let (dir, name, child, version) =
            (dir.clone(), name.clone(), child.clone(), version.clone());
        orca::blocking(move || {
            let open = formation::pc_connect(&dir, &version, true);
            formation_page::page_input_with_time(&dir, &name, &child, &open)
        })
        .await??
    };
    if current != at {
        return Err("ページが差し替わりました。開き直してください".to_owned());
    }
    let reply = build_reply(&page, &answers, verdict, &revision)?;
    let paste = paste_of(&terminal_text(&child, &reply))?;
    let key = (name.clone(), child.clone(), at);
    let leader_of = name.clone();
    deliver(
        key,
        async || {
            if environment == LOCAL {
                send_here(&sessions, &leader_of, paste).await
            } else {
                let handle = orchestrator
                    .ok_or_else(|| "リーダーのターミナルがまだ始まっていません".to_owned())?;
                send_orca(&environment, &handle, paste).await
            }
        },
        async move || {
            orca::blocking(move || {
                let open = formation::pc_connect(&dir, &version, true);
                formation_page::mark_page_answered(&dir, &name, &child, at, &open)
            })
            .await?
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use formation_page::{CardOption, Fact};

    fn option(key: &str, label: &str) -> CardOption {
        CardOption {
            key: key.to_owned(),
            label: label.to_owned(),
            detail: None,
        }
    }

    fn card(kind: CardKind, number: &str, title: &str) -> Card {
        Card {
            kind,
            number: number.to_owned(),
            title: title.to_owned(),
            summary: String::new(),
            options: if kind.lettered() {
                vec![option("A", "案 A"), option("B", "案 B")]
            } else {
                Vec::new()
            },
            recommendation: None,
            recommendation_reason: None,
            background: None,
            facts: Vec::<Fact>::new(),
            blocks: Vec::new(),
            evidence: Vec::new(),
            cards: Vec::new(),
        }
    }

    fn page(kind: PageKind, subject: Subject) -> DecisionPage {
        DecisionPage {
            page_kind: kind,
            subject,
            context_label: String::new(),
            title: "題".to_owned(),
            what: None,
            roots: Default::default(),
            previous_reply: None,
            questions: Vec::new(),
            approval_scope: Vec::new(),
            changes: Vec::new(),
            needs_user_decision: Vec::new(),
            residual_must_fix: Vec::new(),
            structural_proposals: Vec::new(),
            adr: None,
            risks: None,
            settled_decisions: Vec::new(),
            quality_loop: None,
            unmet_criteria: Vec::new(),
            pr: None,
        }
    }

    fn answer(card: &str, choice: Option<&str>, note: &str) -> PageAnswer {
        PageAnswer {
            card: card.to_owned(),
            choice: choice.map(str::to_owned),
            note: note.to_owned(),
        }
    }

    fn questions() -> DecisionPage {
        let mut page = page(PageKind::OpenQuestions, Subject::Requirement);
        page.questions = vec![
            card(CardKind::Question, "論点1", "どちらにしますか"),
            card(CardKind::Question, "論点2", "いつにしますか"),
        ];
        page
    }

    #[test]
    fn open_questions_have_no_verdict_and_one_block_for_each_answer_with_a_blank_line_between() {
        let reply = build_reply(
            &questions(),
            &[
                answer("論点1", Some("B"), "ignored for a lettered option"),
                answer("論点2", Some("investigate"), ""),
            ],
            None,
            "",
        )
        .unwrap();
        assert_eq!(
            reply,
            "論点1 どちらにしますか\nB. 案 B\n\n論点2 いつにしますか\n調べてから決めて"
        );
    }

    #[test]
    fn the_free_text_of_a_lettered_card_counts_only_under_other_and_an_empty_other_is_no_answer() {
        let reply = build_reply(
            &questions(),
            &[
                answer("論点1", Some("other"), "  自由な\n答え  "),
                answer("論点2", Some("A"), "x"),
            ],
            None,
            "",
        )
        .unwrap();
        assert_eq!(
            reply,
            "論点1 どちらにしますか\nその他\n補足: 自由な\n答え\n\n論点2 いつにしますか\nA. 案 A"
        );
        let missing = build_reply(
            &questions(),
            &[
                answer("論点1", Some("other"), "  "),
                answer("論点2", Some("A"), ""),
            ],
            None,
            "",
        );
        assert_eq!(
            missing.unwrap_err(),
            "回答が必要なカードが未回答です: 論点1"
        );
    }

    #[test]
    fn a_required_card_with_no_answer_cannot_be_sent_and_the_reason_names_the_cards() {
        let error = build_reply(&questions(), &[], None, "").unwrap_err();
        assert_eq!(error, "回答が必要なカードが未回答です: 論点1、論点2");
        let error =
            build_reply(&questions(), &[answer("論点2", Some("B"), "")], None, "").unwrap_err();
        assert_eq!(error, "回答が必要なカードが未回答です: 論点1");
    }

    fn approval() -> DecisionPage {
        let mut page = page(PageKind::Approval, Subject::Design);
        page.needs_user_decision = vec![card(CardKind::Nr, "NR-1", "判断")];
        page.residual_must_fix = vec![card(CardKind::MustFix, "MF-1", "直す")];
        page.structural_proposals = vec![card(CardKind::StructuralProposal, "SP-1", "構造")];
        page.adr = Some(card(CardKind::Adr, "ADR-1", "記録"));
        page
    }

    #[test]
    fn an_approval_without_a_revision_has_the_approve_line_and_the_blocks_in_the_pages_order() {
        let reply = build_reply(
            &approval(),
            &[
                answer("ADR-1", Some("keep"), ""),
                answer("MF-1", Some("skip"), "今回は見送る"),
                answer("SP-1", Some("reject"), "理由は別にある"),
                answer("NR-1", Some("A"), ""),
            ],
            Some(PageVerdict::Approve),
            "",
        )
        .unwrap();
        assert_eq!(
            reply,
            "基本設計を承認します\n\nNR-1 判断\nA. 案 A\n\nMF-1 直す\n今回は対応しない\n補足: 今回は見送る\n\nSP-1 構造\n却下\n補足: 理由は別にある\n\nADR-1 記録\n残す"
        );
    }

    #[test]
    fn a_revision_choice_makes_the_revise_line_and_an_unanswered_optional_card_leaves_no_block() {
        let reply = build_reply(
            &approval(),
            &[answer("MF-1", Some("fix"), "")],
            Some(PageVerdict::Revise),
            "",
        )
        .unwrap();
        assert_eq!(
            reply,
            "基本設計の修正を依頼します\n\nMF-1 直す\n指摘のとおり修正する"
        );
        let mut requirement = approval();
        requirement.subject = Subject::Requirement;
        let reply = build_reply(
            &requirement,
            &[answer("MF-1", Some("skip"), "")],
            Some(PageVerdict::Approve),
            "",
        )
        .unwrap();
        assert!(reply.starts_with("要件定義を承認します\n\n"));
        let reply = build_reply(
            &requirement,
            &[answer("MF-1", Some("fix"), "")],
            Some(PageVerdict::Revise),
            "",
        )
        .unwrap();
        assert!(reply.starts_with("要件定義の修正を依頼します\n\n"));
    }

    #[test]
    fn an_approval_cannot_be_sent_while_a_must_fix_card_has_no_answer() {
        let error = build_reply(
            &approval(),
            &[answer("NR-1", Some("A"), "")],
            Some(PageVerdict::Approve),
            "",
        )
        .unwrap_err();
        assert_eq!(error, "回答が必要なカードが未回答です: MF-1");
    }

    #[test]
    fn a_code_review_has_its_verdicts_and_the_criterion_takes_no_answer() {
        let mut review = page(PageKind::CodeReview, Subject::Code);
        review.residual_must_fix = vec![card(CardKind::ReviewMustFix, "RM-1", "指摘")];
        review.unmet_criteria = vec![card(CardKind::UnmetCriterion, "UC-1", "条件")];
        review.needs_user_decision = vec![card(CardKind::ReviewDecision, "RD-1", "判断")];
        assert_eq!(
            build_reply(&review, &[], Some(PageVerdict::Approve), "").unwrap(),
            "この変更を承認します"
        );
        let reply = build_reply(
            &review,
            &[
                answer("RD-1", Some("defer"), ""),
                answer("RM-1", Some("fix"), ""),
            ],
            Some(PageVerdict::Revise),
            "",
        )
        .unwrap();
        assert_eq!(
            reply,
            "修正を依頼します\n\nRM-1 指摘\n修正して再レビューする\n\nRD-1 判断\n今回は対応しない"
        );
        let accepted = build_reply(
            &review,
            &[answer("RM-1", Some("accept"), "")],
            Some(PageVerdict::Approve),
            "",
        )
        .unwrap();
        assert_eq!(
            accepted,
            "この変更を承認します\n\nRM-1 指摘\n現状で完了する"
        );
        let error = build_reply(
            &review,
            &[answer("UC-1", None, "x")],
            Some(PageVerdict::Approve),
            "",
        )
        .unwrap_err();
        assert!(error.contains("UC-1"), "{error}");
    }

    #[test]
    fn a_note_alone_is_an_answer_on_a_card_with_fixed_choices_and_has_no_answer_line() {
        let mut review = page(PageKind::CodeReview, Subject::Code);
        review.residual_must_fix = vec![card(CardKind::ReviewMustFix, "RM-1", "指摘")];
        let reply = build_reply(
            &review,
            &[answer("RM-1", None, "あとで見る")],
            Some(PageVerdict::Approve),
            "",
        )
        .unwrap();
        assert_eq!(reply, "この変更を承認します\n\nRM-1 指摘\n補足: あとで見る");
    }

    #[test]
    fn a_key_the_card_does_not_offer_a_number_twice_and_a_card_not_on_the_page_are_refused() {
        let page = questions();
        let error = build_reply(&page, &[answer("論点1", Some("Z"), "")], None, "").unwrap_err();
        assert!(error.contains("論点1") && error.contains('Z'), "{error}");
        // A fixed choice of another kind is no choice of a question card.
        assert!(build_reply(&page, &[answer("論点1", Some("fix"), "")], None, "").is_err());
        let error = build_reply(
            &page,
            &[
                answer("論点1", Some("A"), ""),
                answer("論点1", Some("B"), ""),
            ],
            None,
            "",
        )
        .unwrap_err();
        assert!(error.contains("二つ"), "{error}");
        let error = build_reply(&page, &[answer("論点9", Some("A"), "")], None, "").unwrap_err();
        assert!(error.contains("論点9"), "{error}");
    }

    #[test]
    fn a_page_kind_with_no_reply_format_is_refused() {
        let mut odd = approval();
        odd.subject = Subject::Code;
        assert!(build_reply(
            &odd,
            &[answer("MF-1", Some("skip"), "")],
            Some(PageVerdict::Approve),
            ""
        )
        .is_err());
    }

    #[test]
    fn control_characters_of_a_title_a_label_and_a_note_never_reach_the_reply() {
        let mut page = questions();
        page.questions[0].title = "題\x1b[201~\r名\n前".to_owned();
        page.questions[0].options[0].label = "案\x07 A".to_owned();
        let reply = build_reply(
            &page,
            &[
                answer("論点1", Some("A"), ""),
                answer("論点2", Some("other"), "a\x1b[201~b\x1b[200~c\tz\u{9b}"),
            ],
            None,
            "",
        )
        .unwrap();
        assert!(
            !reply.contains(['\x1b', '\x07', '\r', '\t', '\u{9b}']),
            "{reply:?}"
        );
        assert!(
            reply.starts_with("論点1 題[201~ 名 前\nA. 案 A\n\n"),
            "{reply:?}"
        );
        assert!(reply.ends_with("補足: a[201~b[200~c z"), "{reply:?}");
    }

    #[test]
    fn the_terminal_text_is_the_line_naming_the_child_and_then_the_reply() {
        assert_eq!(
            terminal_text("req-login", "基本設計を承認します\n\nNR-1 判断\nA. 案 A"),
            "判断ページの返信（req-login）\n基本設計を承認します\n\nNR-1 判断\nA. 案 A"
        );
    }

    #[test]
    fn the_paste_is_one_bracketed_paste_with_no_enter_and_no_paste_end_of_the_text_inside() {
        let text = terminal_text(
            "child",
            "論点1 題\nA. 案 A\n補足: \x1b[201~ここで貼り付けは終わらない\r\nEnter でもない",
        );
        let paste = paste_of(&text).unwrap();
        assert!(paste.starts_with("\x1b[200~判断ページの返信（child）\n"));
        assert!(paste.ends_with("\x1b[201~"));
        // The only paste marks are the first and the last; no Enter is in it.
        assert_eq!(paste.matches("\x1b[200~").count(), 1);
        assert_eq!(paste.matches("\x1b[201~").count(), 1);
        assert!(!paste.contains('\r'));
        // Every line of the reply is inside the one paste, and Enter is a separate send after it.
        let inside = &paste["\x1b[200~".len()..paste.len() - "\x1b[201~".len()];
        assert_eq!(inside.lines().count(), 5, "{inside:?}");
        assert_eq!(ENTER, "\r");
    }

    #[test]
    fn a_reply_over_the_limit_of_a_send_is_refused_with_the_paste_marks_counted() {
        let marks = PASTE_START.chars().count() + PASTE_END.chars().count();
        assert_eq!(marks, 12);
        let fits = paste_of(&"あ".repeat(orca::TEXT_LIMIT - marks)).unwrap();
        assert_eq!(fits.chars().count(), orca::TEXT_LIMIT);
        // What the send takes is the paste, so the text that fills the limit alone is refused.
        assert!(orca::check_keys(&fits).is_ok());
        assert!(paste_of(&"あ".repeat(orca::TEXT_LIMIT - marks + 1)).is_err());
        assert!(paste_of(&"あ".repeat(orca::TEXT_LIMIT)).is_err());
    }

    #[tokio::test]
    async fn a_reply_that_was_sent_and_not_marked_is_not_sent_again_by_the_next_press() {
        use std::cell::Cell;
        let page = ("f-deliver".to_owned(), "c".to_owned(), 7);
        let sends = Cell::new(0);
        let send = async || {
            sends.set(sends.get() + 1);
            Ok(())
        };
        // The send succeeds and the mark fails: the failure says the reply went.
        let error = deliver(page.clone(), send, async || Err("record".to_owned()))
            .await
            .unwrap_err();
        assert!(error.starts_with("返信は送りましたが"), "{error}");
        assert_eq!(sends.get(), 1);
        // The next press marks and sends nothing, and a mark that fails again keeps the memory.
        deliver(page.clone(), send, async || Err("x".to_owned()))
            .await
            .unwrap_err();
        assert_eq!(sends.get(), 1);
        deliver(page.clone(), send, async || Ok(())).await.unwrap();
        assert_eq!(sends.get(), 1);
        // The mark is made and the memory is freed: the same pair with a send to make sends.
        deliver(page.clone(), send, async || Ok(())).await.unwrap();
        assert_eq!(sends.get(), 2);
    }

    #[tokio::test]
    async fn a_reply_that_could_not_be_sent_is_not_remembered_and_the_page_is_not_marked() {
        let page = ("f-deliver".to_owned(), "failed".to_owned(), 9);
        let marked = std::cell::Cell::new(false);
        let error = deliver(
            page.clone(),
            async || Err("terminal".to_owned()),
            async || {
                marked.set(true);
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "terminal");
        assert!(!marked.get());
        assert!(!sent_pages().contains(&page));
    }

    #[test]
    fn a_reply_that_is_on_its_way_is_not_sent_twice_and_the_place_is_freed_at_the_end() {
        let first = Sending::take("f-guard", "c").unwrap();
        assert!(Sending::take("f-guard", "c").is_err());
        assert!(Sending::take("f-guard", "other").is_ok());
        assert!(Sending::take("other-formation", "c").is_ok());
        drop(first);
        assert!(Sending::take("f-guard", "c").is_ok());
    }
}
