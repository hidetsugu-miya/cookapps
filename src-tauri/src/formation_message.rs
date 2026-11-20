//! A-37 (#1084): the messages between the leader and its children, kept for the flow pane.
//! The leader and a child tell each other by SendMessage. Claude Code runs a `PostToolUse` hook after each call of that tool (measured on 2.1.329: the hook gets `tool_name`, `tool_input.to` and `.message`, and `tool_response.success`), and the hook is `tsunagiai-mcp --formation-message {formation} [--from {child}]`, which reads that input on its standard input and appends one line to `formations/{formation}/messages.jsonl`.
//! The leader's hook is in `message-hook.json` of its folder (`claude --settings`), a child's in `message-hook-{child}.json` of the same folder; both are written by the app's own code at each start, so the leader cannot keep a hook of its own there.
//! A line holds who sent it (`from`), to whom (`to`), when (`atMs`) and the first line of the text (`line`, at most `LINE_CHARS` characters). The rest of the text is not kept: it comes from outside and is data.

use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(test)]
use ts_rs::TS;

use crate::{
    auth::config_dir,
    claude_code::sh_quote,
    formation::{self, LOCAL},
    formation_server::Client,
    orca,
};

/// The record of a formation's messages, in `formations/{formation}/`: one JSON object on each line, oldest first.
pub const FILE: &str = "messages.jsonl";
/// The first line of a message is cut to this many characters (not bytes), and ends with `…` when it was cut.
const LINE_CHARS: usize = 200;
/// How many of the last records a read answers.
const READ_RECORDS: usize = 500;
/// How much of the end of the file a read looks at: a record is at most a few hundred bytes, so this holds more than `READ_RECORDS` of them.
const READ_BYTES: u64 = 512 * 1024;
/// How much of the hook's input is read: the message is in it whole, and only its first line is kept.
const HOOK_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MESSAGE_TOOL: &str = "SendMessage";
const FLAG: &str = "--formation-message";
const FROM_FLAG: &str = "--from";

/// One message between the leader and a child, as the record holds it and the screen reads it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct FormationMessage {
    /// Who sent it: the name of the formation (its leader) or of a child.
    pub from: String,
    /// Who it was sent to: the name of a child or of the formation.
    pub to: String,
    /// When it was sent (epoch milliseconds).
    #[cfg_attr(test, ts(type = "number"))]
    pub at_ms: u64,
    /// The first line of the text, data from the sender.
    pub line: String,
}

/// The first non-blank line of `text` with its control characters taken out, at most `LINE_CHARS` characters; empty when the text has none.
pub fn first_line(text: &str) -> String {
    let line: String = text
        .lines()
        .map(|line| {
            line.chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect::<String>()
        })
        .map(|line| line.trim().to_owned())
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if line.chars().count() <= LINE_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(LINE_CHARS).collect();
    cut.push('…');
    cut
}

/// The settings that `claude --settings` takes to run the hook: after each SendMessage, `mcp --formation-message {formation}` (and `--from {child}` for a child, whose messages go to the leader). A child's settings also hold the permissions for the Figma server of its plugin (`formation_assets::figma_permissions`). A name has passed `check_name`, so it is a word of its own in the shell.
pub fn hook_settings(mcp: &Path, formation: &str, from: Option<&str>) -> String {
    let mut command = format!("{} {FLAG} {formation}", sh_quote(&mcp.to_string_lossy()));
    if let Some(child) = from {
        command.push_str(&format!(" {FROM_FLAG} {child}"));
    }
    let mut settings = json!({
        "hooks": {"PostToolUse": [{
            "matcher": MESSAGE_TOOL,
            "hooks": [{"type": "command", "command": command, "timeout": 10}]
        }]}
    });
    // A child runs in the auto mode and reads Figma through the plugin's server: its settings allow that server's read tools and deny its write tools (A-41, #1162).
    if from.is_some() {
        settings["permissions"] = crate::formation_assets::figma_permissions();
    }
    serde_json::to_string_pretty(&settings).unwrap_or_default()
}

/// The file of the leader's hook in the folder of its formation.
pub const LEADER_HOOK_FILE: &str = "message-hook.json";

/// The file of a child's hook in the folder of its formation.
pub fn child_hook_file(child: &str) -> String {
    format!("message-hook-{child}.json")
}

/// The arguments of the hook: the formation and, for a child, its name.
#[derive(Debug, PartialEq)]
pub struct HookArgs {
    pub formation: String,
    pub from: Option<String>,
}

/// `--formation-message {formation}` and, optionally, `--from {child}`: none when the first is not there. A flag with no value, or a name that is not one, is an error.
pub fn hook_args(args: impl IntoIterator<Item = String>) -> Result<Option<HookArgs>, String> {
    let args: Vec<String> = args.into_iter().collect();
    let value_after = |flag: &str| -> Result<Option<String>, String> {
        let Some(at) = args.iter().position(|arg| arg == flag) else {
            return Ok(None);
        };
        let value = args
            .get(at + 1)
            .ok_or_else(|| format!("{flag} には名前が要ります"))?;
        formation::check_name(value)?;
        Ok(Some(value.clone()))
    };
    let Some(formation) = value_after(FLAG)? else {
        return Ok(None);
    };
    Ok(Some(HookArgs {
        formation,
        from: value_after(FROM_FLAG)?,
    }))
}

/// The message that a hook's input records, or none when the call is not one to record: another tool, a call that was not delivered (`tool_response.success` is `false`), one with no text (a subscription to a child's idle), or one that is not between the leader and a child of this formation. The leader's messages go to one of `children`, a child's to the leader (the formation's name). An input that is not JSON is an error.
pub fn message_of_hook(
    args: &HookArgs,
    children: &[String],
    input: &str,
    at_ms: u64,
) -> Result<Option<FormationMessage>, String> {
    let input: Value =
        serde_json::from_str(input).map_err(|e| format!("フックの入力を読めません: {e}"))?;
    if input["tool_name"].as_str() != Some(MESSAGE_TOOL)
        || input["tool_response"]["success"] == Value::Bool(false)
    {
        return Ok(None);
    }
    let (Some(to), Some(text)) = (
        input["tool_input"]["to"].as_str(),
        input["tool_input"]["message"].as_str(),
    ) else {
        return Ok(None);
    };
    let (from, to) = match &args.from {
        Some(child) if to == args.formation => (child.as_str(), to),
        None if children.iter().any(|name| name == to) => (args.formation.as_str(), to),
        _ => return Ok(None),
    };
    let line = first_line(text);
    if line.is_empty() {
        return Ok(None);
    }
    Ok(Some(FormationMessage {
        from: from.to_owned(),
        to: to.to_owned(),
        at_ms,
        line,
    }))
}

/// The children of `formation` that the leader told something and that have not answered yet (#1087): the latest message between the leader (named as the formation) and the child is the leader's. A message between two children is not counted. Newest instruction first; `messages` is oldest first, as `read` gives it.
pub fn instructed(messages: &[FormationMessage], formation: &str) -> Vec<String> {
    // The latest message of each child: where it stands in the record, when it was sent, and whether the leader sent it.
    let mut last: HashMap<&str, (usize, u64, bool)> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        let (child, from_leader) = if message.from == formation && message.to != formation {
            (message.to.as_str(), true)
        } else if message.to == formation && message.from != formation {
            (message.from.as_str(), false)
        } else {
            continue;
        };
        last.insert(child, (index, message.at_ms, from_leader));
    }
    let mut open: Vec<(u64, usize, &str)> = last
        .into_iter()
        .filter(|(_, (_, _, from_leader))| *from_leader)
        .map(|(child, (index, at_ms, _))| (at_ms, index, child))
        .collect();
    open.sort_by_key(|&(at_ms, index, _)| std::cmp::Reverse((at_ms, index)));
    open.into_iter()
        .map(|(_, _, child)| child.to_owned())
        .collect()
}

/// The record's path, or the reason it cannot be used: a link or anything but a file in its place is refused, because the leader can write in its folder, and a link there would lead the append to a file elsewhere.
fn record_path(config: &Path, formation: &str) -> Result<PathBuf, String> {
    formation::check_name(formation)?;
    let path = formation::dir(config, formation).join(FILE);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() => Err(format!("{} はファイルではありません", path.display())),
        Ok(_) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(e) => Err(format!("{} を調べられません: {e}", path.display())),
    }
}

/// Adds `message` to the record of `formation`. The line is one write to a file opened for appending, so the hooks of the leader and of several children that run at once do not mix their lines.
pub fn append(config: &Path, formation: &str, message: &FormationMessage) -> Result<(), String> {
    let path = record_path(config, formation)?;
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)
            .map_err(|e| format!("{} を作れません: {e}", folder.display()))?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .map_err(|e| format!("{} に書けません: {e}", path.display()))
}

/// The last `READ_RECORDS` messages of the record of `formation`, oldest first. A missing or unusable record reads as none, and a line that is not a message is passed over.
pub fn read(config: &Path, formation: &str) -> Vec<FormationMessage> {
    let Ok(path) = record_path(config, formation) else {
        return Vec::new();
    };
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let Ok(length) = file.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    let cut = length > READ_BYTES;
    if cut && file.seek(SeekFrom::Start(length - READ_BYTES)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.take(READ_BYTES).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    // The first line of a cut read starts in the middle of a record.
    let skip = usize::from(cut);
    let mut messages: Vec<FormationMessage> = text
        .lines()
        .skip(skip)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let extra = messages.len().saturating_sub(READ_RECORDS);
    messages.drain(..extra);
    messages
}

/// Records the message of one hook call in the record of its formation, and answers whether there was one to record.
pub fn record_hook(
    config: &Path,
    args: &HookArgs,
    input: &str,
    at_ms: u64,
) -> Result<bool, String> {
    formation::check_name(&args.formation)?;
    let children: Vec<String> = formation::read_children(config, &args.formation)
        .into_iter()
        .map(|child| child.name)
        .collect();
    match message_of_hook(args, &children, input, at_ms)? {
        Some(message) => append(config, &args.formation, &message).map(|()| true),
        None => Ok(false),
    }
}

/// Runs the hook for `tsunagiai-mcp`: reads the input of Claude Code on the standard input, records its message and answers the exit code. A failure is a line on stderr and exit 1, which Claude Code shows as a notice and goes on: the hook never stops a call.
pub fn run_hook(args: &HookArgs) -> i32 {
    let mut input = String::new();
    let done = std::io::stdin()
        .take(HOOK_INPUT_BYTES)
        .read_to_string(&mut input)
        .map_err(|e| format!("フックの入力を読めません: {e}"))
        .and_then(|_| {
            let config = crate::identity::config_dir()?;
            record_hook(&config, args, &input, formation::now_ms())
        });
    match done {
        Ok(_) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// The messages of `formation` for the screen: read here for a formation of this Mac, and from the server of its PC for a formation of a saved environment, where its leader and children ran the hook. A formation whose orchestrator was never started on its PC has none.
fn messages_for_screen(
    config: &Path,
    formation: &str,
    open: &impl AsyncFn(&str) -> Result<Client, String>,
) -> Result<Vec<FormationMessage>, String> {
    formation::check_name(formation)?;
    let (environment, started) = formation::formation_home(config, formation);
    if environment == LOCAL {
        return Ok(read(config, formation));
    }
    if !started {
        return Ok(Vec::new());
    }
    formation::on_pc(
        &environment,
        open,
        formation::SAVED_PS_TIMEOUT,
        async |client| client.messages_read(formation).await,
    )
}

/// The messages that the leader of the formation `name` and its children sent each other, oldest first (A-37, #1084).
#[tauri::command]
pub async fn formation_messages(
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<FormationMessage>, String> {
    let dir = config_dir(&app)?;
    let version = app.package_info().version.to_string();
    orca::blocking(move || {
        messages_for_screen(&dir, &name, &formation::pc_connect(&dir, &version, false))
    })
    .await?
}

/// The children of the formation `name` that the leader told something and that have not answered yet, newest instruction first (A-37, #1087). The compact view of the flow pane reads it.
#[tauri::command]
pub async fn formation_instructed(
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<String>, String> {
    let dir = config_dir(&app)?;
    let version = app.package_info().version.to_string();
    orca::blocking(move || {
        messages_for_screen(&dir, &name, &formation::pc_connect(&dir, &version, false))
            .map(|messages| instructed(&messages, &name))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tsunagiai-message-{name}-{}-{}",
            std::process::id(),
            formation::now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn args(from: Option<&str>) -> HookArgs {
        HookArgs {
            formation: "api-work".to_owned(),
            from: from.map(str::to_owned),
        }
    }

    fn names(of: &[&str]) -> Vec<String> {
        of.iter().map(|n| (*n).to_owned()).collect()
    }

    fn input(to: &str, message: &str) -> String {
        json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "SendMessage",
            "tool_input": {"to": to, "summary": "s", "message": message, "type": "message"},
            "tool_response": {"success": true, "message": "sent"}
        })
        .to_string()
    }

    fn message(from: &str, to: &str, at_ms: u64, line: &str) -> FormationMessage {
        FormationMessage {
            from: from.to_owned(),
            to: to.to_owned(),
            at_ms,
            line: line.to_owned(),
        }
    }

    #[test]
    fn the_first_line_is_the_first_one_with_text_and_has_no_control_characters() {
        assert_eq!(first_line("DONE a: x\nsecond"), "DONE a: x");
        assert_eq!(first_line("\n  \r\n  QUESTION b: y  \nz"), "QUESTION b: y");
        assert_eq!(first_line("a\tb\u{1b}[31mc"), "a b [31mc");
        assert_eq!(first_line(" \n \n"), "");
        assert_eq!(first_line(""), "");
    }

    #[test]
    fn a_long_first_line_is_cut_by_characters_and_marked() {
        let exact = "あ".repeat(LINE_CHARS);
        assert_eq!(first_line(&exact), exact);
        let cut = first_line(&"あ".repeat(LINE_CHARS + 1));
        assert_eq!(cut.chars().count(), LINE_CHARS + 1);
        assert!(cut.starts_with(&exact) && cut.ends_with('…'));
    }

    #[test]
    fn the_leader_sends_to_a_child_and_the_child_to_the_leader() {
        let children = names(&["req", "impl"]);
        assert_eq!(
            message_of_hook(&args(None), &children, &input("req", "ANSWER x\nbody"), 7).unwrap(),
            Some(message("api-work", "req", 7, "ANSWER x"))
        );
        assert_eq!(
            message_of_hook(
                &args(Some("req")),
                &children,
                &input("api-work", "DONE x: y\nmore"),
                8
            )
            .unwrap(),
            Some(message("req", "api-work", 8, "DONE x: y"))
        );
    }

    #[test]
    fn a_call_that_is_not_between_the_leader_and_its_children_is_not_recorded() {
        let children = names(&["req"]);
        // The leader to something that is not a child of the formation.
        assert_eq!(
            message_of_hook(&args(None), &children, &input("other", "x"), 1).unwrap(),
            None
        );
        // A child to something that is not the leader.
        assert_eq!(
            message_of_hook(&args(Some("req")), &children, &input("impl", "x"), 1).unwrap(),
            None
        );
        // A child to itself or the leader to the leader is no message of the flow either.
        assert_eq!(
            message_of_hook(&args(None), &children, &input("api-work", "x"), 1).unwrap(),
            None
        );
    }

    #[test]
    fn a_call_that_was_not_delivered_or_has_no_text_or_is_another_tool_is_not_recorded() {
        let children = names(&["req"]);
        let call = |value: Value| message_of_hook(&args(None), &children, &value.to_string(), 1);
        let ok = || {
            json!({
                "tool_name": "SendMessage",
                "tool_input": {"to": "req", "message": "x"},
                "tool_response": {"success": true}
            })
        };
        assert!(call(ok()).unwrap().is_some());
        let mut failed = ok();
        failed["tool_response"]["success"] = json!(false);
        assert_eq!(call(failed).unwrap(), None);
        let mut other = ok();
        other["tool_name"] = json!("Bash");
        assert_eq!(call(other).unwrap(), None);
        // A subscription to the idle of a child has no message.
        let mut idle = ok();
        idle["tool_input"] = json!({"to": "req", "notify_when_idle": true, "content": ""});
        assert_eq!(call(idle).unwrap(), None);
        // A message that is not text, or whose text is blank.
        let mut object = ok();
        object["tool_input"]["message"] = json!({"type": "shutdown_request"});
        assert_eq!(call(object).unwrap(), None);
        let mut blank = ok();
        blank["tool_input"]["message"] = json!(" \n ");
        assert_eq!(call(blank).unwrap(), None);
        // A response with no `success` is taken as delivered.
        let mut bare = ok();
        bare["tool_response"] = json!({});
        assert!(call(bare).unwrap().is_some());
    }

    #[test]
    fn an_input_that_is_not_json_is_an_error() {
        assert!(message_of_hook(&args(None), &[], "not json", 1).is_err());
    }

    #[test]
    fn the_hook_arguments_name_the_formation_and_the_child() {
        let a = |list: &[&str]| hook_args(list.iter().map(|s| (*s).to_owned()));
        assert_eq!(
            a(&["--formation-message", "api-work"]),
            Ok(Some(HookArgs {
                formation: "api-work".into(),
                from: None
            }))
        );
        assert_eq!(
            a(&["--formation-message", "api-work", "--from", "req"]),
            Ok(Some(HookArgs {
                formation: "api-work".into(),
                from: Some("req".into())
            }))
        );
        assert_eq!(a(&[]), Ok(None));
        assert_eq!(a(&["--from", "req"]), Ok(None));
        for bad in [
            &["--formation-message"][..],
            &["--formation-message", "../x"],
            &["--formation-message", "a", "--from"],
            &["--formation-message", "a", "--from", "B"],
        ] {
            assert!(a(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_hook_settings_run_this_program_after_a_send_message() {
        let leader: Value =
            serde_json::from_str(&hook_settings(Path::new("/a b/mcp"), "api-work", None)).unwrap();
        let hook = &leader["hooks"]["PostToolUse"][0];
        assert_eq!(hook["matcher"], "SendMessage");
        assert_eq!(hook["hooks"][0]["type"], "command");
        assert_eq!(
            hook["hooks"][0]["command"],
            "'/a b/mcp' --formation-message api-work"
        );
        let child: Value =
            serde_json::from_str(&hook_settings(Path::new("/m/mcp"), "api-work", Some("req")))
                .unwrap();
        assert_eq!(
            child["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "'/m/mcp' --formation-message api-work --from req"
        );
        // Only a child reads Figma, so only its settings carry the permissions for it.
        assert!(leader.get("permissions").is_none());
        assert_eq!(
            child["permissions"],
            crate::formation_assets::figma_permissions()
        );
    }

    #[test]
    fn the_hook_files_are_named_by_the_leader_and_by_each_child() {
        assert_eq!(LEADER_HOOK_FILE, "message-hook.json");
        assert_eq!(child_hook_file("req"), "message-hook-req.json");
    }

    #[test]
    fn the_record_is_read_in_the_order_it_was_written_and_a_bad_line_is_passed_over() {
        let config = temp_dir("order");
        assert!(read(&config, "api-work").is_empty());
        append(&config, "api-work", &message("api-work", "req", 1, "a")).unwrap();
        append(&config, "api-work", &message("req", "api-work", 2, "b")).unwrap();
        let path = formation::dir(&config, "api-work").join(FILE);
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("broken\n{\"from\":1}\n");
        std::fs::write(&path, text).unwrap();
        append(&config, "api-work", &message("api-work", "req", 3, "c")).unwrap();
        let read = read(&config, "api-work");
        assert_eq!(read.iter().map(|m| m.at_ms).collect::<Vec<_>>(), [1, 2, 3]);
        // The line has the keys the screen reads.
        let first: Value = serde_json::from_str(
            std::fs::read_to_string(&path)
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            first,
            json!({"from": "api-work", "to": "req", "atMs": 1, "line": "a"})
        );
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_read_answers_the_last_records_only() {
        let config = temp_dir("last");
        for at in 0..(READ_RECORDS as u64 + 5) {
            append(&config, "api-work", &message("api-work", "req", at, "x")).unwrap();
        }
        let read = read(&config, "api-work");
        assert_eq!(read.len(), READ_RECORDS);
        assert_eq!(read[0].at_ms, 5);
        assert_eq!(read[READ_RECORDS - 1].at_ms, READ_RECORDS as u64 + 4);
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_read_of_a_big_file_drops_the_record_that_the_cut_went_through() {
        let config = temp_dir("big");
        let dir = formation::dir(&config, "api-work");
        std::fs::create_dir_all(&dir).unwrap();
        let record =
            serde_json::to_string(&message("api-work", "req", 9, &"x".repeat(150))).unwrap();
        let count = (READ_BYTES as usize / record.len()) + 50;
        std::fs::write(dir.join(FILE), format!("{record}\n").repeat(count)).unwrap();
        let read = read(&config, "api-work");
        // Every record that is answered is whole.
        assert_eq!(read.len(), READ_RECORDS);
        assert!(read.iter().all(|m| m.at_ms == 9 && m.line.len() == 150));
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_place_of_the_record_is_neither_written_nor_read() {
        let config = temp_dir("link");
        let dir = formation::dir(&config, "api-work");
        std::fs::create_dir_all(&dir).unwrap();
        let elsewhere = config.join("elsewhere.txt");
        std::fs::write(&elsewhere, "keep\n").unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.join(FILE)).unwrap();
        assert!(append(&config, "api-work", &message("api-work", "req", 1, "a")).is_err());
        assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "keep\n");
        assert!(read(&config, "api-work").is_empty());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_name_that_leads_out_of_the_folder_is_refused() {
        let config = temp_dir("name");
        assert!(append(&config, "../x", &message("a", "b", 1, "c")).is_err());
        assert!(read(&config, "../x").is_empty());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_hook_call_is_recorded_against_the_children_of_the_record() {
        let config = temp_dir("hook");
        let dir = formation::dir(&config, "api-work");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(formation::CHILDREN_FILE),
            json!({"children": [{"name": "req", "repo": "r"}]}).to_string(),
        )
        .unwrap();
        assert!(record_hook(&config, &args(None), &input("req", "ANSWER x"), 5).unwrap());
        assert!(record_hook(
            &config,
            &args(Some("req")),
            &input("api-work", "DONE x: y"),
            6
        )
        .unwrap());
        // To a name that is not a child, nothing is written.
        assert!(!record_hook(&config, &args(None), &input("zzz", "x"), 7).unwrap());
        assert_eq!(
            read(&config, "api-work"),
            [
                message("api-work", "req", 5, "ANSWER x"),
                message("req", "api-work", 6, "DONE x: y")
            ]
        );
        assert!(record_hook(
            &config,
            &HookArgs {
                formation: "../x".into(),
                from: None
            },
            &input("req", "x"),
            1
        )
        .is_err());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_formation_of_this_mac_is_read_from_its_own_record() {
        let config = temp_dir("screen");
        append(&config, "api-work", &message("api-work", "req", 1, "a")).unwrap();
        let open = async |_: &str| -> Result<Client, String> { Err("no connection".into()) };
        assert_eq!(
            messages_for_screen(&config, "api-work", &open).unwrap(),
            [message("api-work", "req", 1, "a")]
        );
        assert!(messages_for_screen(&config, "../x", &open).is_err());
        std::fs::remove_dir_all(&config).unwrap();
    }

    #[test]
    fn a_child_the_leader_told_last_is_instructed_and_an_answer_ends_it() {
        let record = vec![
            message("api-work", "req", 1, "ASK"),
            message("req", "api-work", 2, "DONE"),
            message("api-work", "impl", 3, "GO"),
        ];
        assert_eq!(instructed(&record, "api-work"), names(&["impl"]));
        let more = [record, vec![message("api-work", "req", 4, "AGAIN")]].concat();
        assert_eq!(instructed(&more, "api-work"), names(&["req", "impl"]));
    }

    #[test]
    fn the_instructed_children_are_newest_first_and_one_message_counts_once() {
        let record = vec![
            message("api-work", "a", 10, "1"),
            message("api-work", "b", 20, "2"),
            message("api-work", "a", 30, "3"),
            message("api-work", "c", 5, "4"),
        ];
        assert_eq!(instructed(&record, "api-work"), names(&["a", "b", "c"]));
        assert_eq!(instructed(&[], "api-work"), Vec::<String>::new());
    }

    #[test]
    fn messages_between_children_and_of_another_formation_are_not_counted() {
        let record = vec![
            message("a", "b", 1, "x"),
            message("other", "c", 2, "y"),
            message("c", "other", 3, "z"),
            message("api-work", "api-work", 4, "w"),
        ];
        assert_eq!(instructed(&record, "api-work"), Vec::<String>::new());
        let mixed = [record, vec![message("api-work", "a", 5, "go")]].concat();
        assert_eq!(instructed(&mixed, "api-work"), names(&["a"]));
    }
}
