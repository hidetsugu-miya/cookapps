// The commands of src-tauri (`invoke_handler`): each one's arguments and answer. The data types are ts-rs's (bindings/).
// A command with no arguments is called as `invoke("inbox")`. An answer of `null` is what a Rust `()` or `None` becomes.
import type { AppInfo } from "./bindings/AppInfo";
import type { AttachedFile } from "./bindings/AttachedFile";
import type { BrowsedDir } from "./bindings/BrowsedDir";
import type { Channel } from "./bindings/Channel";
import type { CalendarChoices } from "./bindings/CalendarChoices";
import type { CreatedEvent } from "./bindings/CreatedEvent";
import type { EditedEvent } from "./bindings/EditedEvent";
import type { Checked } from "./bindings/Checked";
import type { Claude } from "./bindings/Claude";
import type { ClaudeConnection } from "./bindings/ClaudeConnection";
import type { DatabaseApplied } from "./bindings/DatabaseApplied";
import type { DatabaseChange } from "./bindings/DatabaseChange";
import type { DatabaseProfile } from "./bindings/DatabaseProfile";
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import type { DatabaseRecords } from "./bindings/DatabaseRecords";
import type { DatabaseSqlResult } from "./bindings/DatabaseSqlResult";
import type { DatabaseStructure } from "./bindings/DatabaseStructure";
import type { DatabaseTable } from "./bindings/DatabaseTable";
import type { DecisionPage } from "./bindings/DecisionPage";
import type { PageAnswer } from "./bindings/PageAnswer";
import type { PageVerdict } from "./bindings/PageVerdict";
import type { Effort } from "./bindings/Effort";
import type { EditorSettings } from "./bindings/EditorSettings";
import type { EmojiCatalog } from "./bindings/EmojiCatalog";
import type { EnvironmentsView } from "./bindings/EnvironmentsView";
import type { FontArea } from "./bindings/FontArea";
import type { FontSettings } from "./bindings/FontSettings";
import type { FormationChild } from "./bindings/FormationChild";
import type { FormationMessage } from "./bindings/FormationMessage";
import type { FormationCloseAnswer } from "./bindings/FormationCloseAnswer";
import type { FormationConsent } from "./bindings/FormationConsent";
import type { FormationDeleteAnswer } from "./bindings/FormationDeleteAnswer";
import type { FormationEntry } from "./bindings/FormationEntry";
import type { FormationOrchestrator } from "./bindings/FormationOrchestrator";
import type { FormationList } from "./bindings/FormationList";
import type { FormationProject } from "./bindings/FormationProject";
import type { FormationShown } from "./bindings/FormationShown";
import type { GhosttyImport } from "./bindings/GhosttyImport";
import type { Inbox } from "./bindings/Inbox";
import type { KeySaved } from "./bindings/KeySaved";
import type { LogEntry } from "./bindings/LogEntry";
import type { LogLevel } from "./bindings/LogLevel";
import type { LspFound } from "./bindings/LspFound";
import type { LspLanguageLook } from "./bindings/LspLanguageLook";
import type { LspLaunch } from "./bindings/LspLaunch";
import type { LspLocation } from "./bindings/LspLocation";
import type { LspOutsideFile } from "./bindings/LspOutsideFile";
import type { LspPlace } from "./bindings/LspPlace";
import type { LspRepoSettings } from "./bindings/LspRepoSettings";
import type { LspStatus } from "./bindings/LspStatus";
import type { MailSummary } from "./bindings/MailSummary";
import type { OutgoingMail } from "./bindings/OutgoingMail";
import type { PickedAttachment } from "./bindings/PickedAttachment";
import type { MarkdownParts } from "./bindings/MarkdownParts";
import type { MarkdownPatchResult } from "./bindings/MarkdownPatchResult";
import type { MenuEntry } from "./bindings/MenuEntry";
import type { MenuSettings } from "./bindings/MenuSettings";
import type { Method } from "./bindings/Method";
import type { Model } from "./bindings/Model";
import type { ClaudeSettings } from "./bindings/ClaudeSettings";
import type { Comment } from "./bindings/Comment";
import type { MonthGrid } from "./bindings/MonthGrid";
import type { HandoffKind } from "./bindings/HandoffKind";
import type { HandoffSummary } from "./bindings/HandoffSummary";
import type { ScreenAnswer } from "./bindings/ScreenAnswer";
import type { Skill } from "./bindings/Skill";
import type { ClaudeCodePermissionMode } from "./bindings/ClaudeCodePermissionMode";
import type { SkillScreen } from "./bindings/SkillScreen";
import type { NewEvent } from "./bindings/NewEvent";
import type { JiraSettings } from "./bindings/JiraSettings";
import type { JiraUser } from "./bindings/JiraUser";
import type { NotionAccount } from "./bindings/NotionAccount";
import type { OrcaBranchSwitched } from "./bindings/OrcaBranchSwitched";
import type { OrcaCommitFiles } from "./bindings/OrcaCommitFiles";
import type { OrcaCommitList } from "./bindings/OrcaCommitList";
import type { OrcaDeleteEntry } from "./bindings/OrcaDeleteEntry";
import type { OrcaDeleted } from "./bindings/OrcaDeleted";
import type { OrcaDir } from "./bindings/OrcaDir";
import type { OrcaFileDiff } from "./bindings/OrcaFileDiff";
import type { OrcaGitChange } from "./bindings/OrcaGitChange";
import type { OrcaFileText } from "./bindings/OrcaFileText";
import type { OrcaGitWorktree } from "./bindings/OrcaGitWorktree";
import type { OrcaLocalBranch } from "./bindings/OrcaLocalBranch";
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaRemoteBranch } from "./bindings/OrcaRemoteBranch";
import type { OrcaSaved } from "./bindings/OrcaSaved";
import type { OrcaScratchpad } from "./bindings/OrcaScratchpad";
import type { OrcaStarted } from "./bindings/OrcaStarted";
import type { OrcaViewport } from "./bindings/OrcaViewport";
import type { PaneLayout } from "./bindings/PaneLayout";
import type { PaneOp } from "./bindings/PaneOp";
import type { PickedDue } from "./bindings/PickedDue";
import type { PendingImage } from "./bindings/PendingImage";
import type { HeldThread } from "./bindings/HeldThread";
import type { HiddenChannel } from "./bindings/HiddenChannel";
import type { SlackAction } from "./bindings/SlackAction";
import type { ComposeRead } from "./bindings/ComposeRead";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { SlackThread } from "./bindings/SlackThread";
import type { SocketStatus } from "./bindings/SocketStatus";
import type { Summary } from "./bindings/Summary";
import type { Sync } from "./bindings/Sync";
import type { Target } from "./bindings/Target";
import type { TerminalThemes } from "./bindings/TerminalThemes";
import type { ThemeSelection } from "./bindings/ThemeSelection";
import type { Timeline } from "./bindings/Timeline";
import type { TimelineMessage } from "./bindings/TimelineMessage";
import type { ThreadDetail } from "./bindings/ThreadDetail";
import type { ThreadRefresh } from "./bindings/ThreadRefresh";
import type { Todo } from "./bindings/Todo";
import type { TodoPrompt } from "./bindings/TodoPrompt";
import type { UpdateInfo } from "./bindings/UpdateInfo";
import type { UpdateMode } from "./bindings/UpdateMode";
import type { Week } from "./bindings/Week";
import type { Workspace } from "./bindings/Workspace";
import type { WorkspaceIcon } from "./bindings/WorkspaceIcon";

// Where a handoff to Orca goes (A-9): a new session in a worktree. Rust checks it against Orca's list.
export type HandoffDestination = { kind: "new"; path: string };
// What is handed over: the card's kind, title and plain text.
export interface HandoffContext {
  kind: HandoffKind;
  title: string;
  body: string;
}

type Account = { account: string };
// What Todoist says about an uploaded file (`file_name`, `file_url`, `file_type`, ...): it is handed back as the attachment of a comment, as it is.
export type Upload = Record<string, unknown>;
type Thread = { account: string; id: string };
type Mail = { subject: string; from: string; date: string; body: string };

export interface Commands {
  login: { args: { loginHint: string | null }; result: string };
  remove_account: { args: Account; result: null };
  // `firstDay`: the day the week starts on, 0 = Sunday to 6 = Saturday.
  calendar_week: { args: { date: string; firstDay: number; refresh: boolean }; result: Week };
  calendar_cached: { args: undefined; result: Week[] };
  calendar_first_day: { args: undefined; result: number };
  set_calendar_first_day: { args: { firstDay: number }; result: null };
  // The weeks that hold the month (1 to 12) of the small calendar of C-4.
  calendar_month: { args: { year: number; month: number; firstDay: number }; result: MonthGrid };
  calendar_choices: { args: undefined; result: CalendarChoices };
  set_calendar_shown: { args: { account: string; calendarId: string; shown: boolean }; result: null };
  // C-5: the calendars an event can be created in (those of each account that the user owns), in the shape of `calendar_choices`.
  calendar_owned: { args: undefined; result: CalendarChoices };
  // C-5: creates the event, with the invitations and the Google Meet it asks for. `null` means the account must log in again (it has not granted the permission to create events).
  calendar_create_event: { args: { event: NewEvent }; result: CreatedEvent | null };
  // C-7: rewrites an event that the user organized, on a calendar the user owns (one occurrence of a repeating event). `null` means the account must log in again.
  calendar_update_event: { args: { event: EditedEvent }; result: CreatedEvent | null };
  // C-7: deletes such an event. `true` when it is gone, `null` when the account must log in again.
  calendar_delete_event: { args: { account: string; calendarId: string; eventId: string }; result: boolean | null };
  inbox: { args: undefined; result: Inbox };
  sync: { args: Account & { startHistoryId: string }; result: Sync };
  thread: { args: Thread; result: ThreadDetail | null };
  thread_held: { args: Thread; result: HeldThread | null };
  thread_refresh: { args: Thread & { stamp: number }; result: ThreadRefresh | null };
  // By message ID, then by the reference as written in the body.
  thread_images: { args: Thread & { images: PendingImage[] }; result: Record<string, Record<string, string>> };
  // null: that account must log in again. true: done; false: nothing to do.
  trash: { args: Thread; result: boolean | null };
  archive: { args: Thread; result: boolean | null };
  untrash: { args: Thread; result: boolean | null };
  unarchive: { args: Thread; result: boolean | null };
  set_read: { args: Thread & { read: boolean }; result: boolean | null };
  // Sends the mail from the account (a reply when `replyThreadId` is set). null: that account must log in again. true: sent.
  send_mail: { args: Account & { mail: OutgoingMail }; result: boolean | null };
  // M-12: whether a file may be added to a mail that holds `held` bytes of files already (a refusal is a Japanese message); the page reads the file only after it was accepted. null: it may.
  mail_attach_check: { args: { name: string; size: number; held: number }; result: null };
  // M-12: opens the dialog that picks files, and answers them read (the dialog gives the place, never the page); an empty list when it was cancelled.
  mail_attach_pick: { args: { held: number }; result: PickedAttachment[] };
  fetch_images: { args: { urls: string[] }; result: Record<string, string> };
  image_sender_known: { args: { froms: string[] }; result: string[] };
  remember_image_sender: { args: { from: string }; result: null };
  // null: a token is needed.
  todoist_load: { args: { withDone: boolean }; result: Todo | null };
  todoist_cached: { args: undefined; result: Todo | null };
  // Whether a token is stored; asks Todoist nothing.
  todoist_connected: { args: undefined; result: boolean };
  todoist_save_token: { args: { token: string }; result: null };
  todoist_disconnect: { args: undefined; result: null };
  todoist_add: { args: { text: string; projectId?: string | null; today: boolean }; result: boolean | null };
  todoist_add_subtask: { args: { parentId: string; content: string }; result: boolean | null };
  todoist_task_from_mail: { args: Account & { threadId: string; subject: string }; result: boolean | null };
  // The summary of a Slack message, to be confirmed before it is added.
  todoist_summarize_slack: { args: { url: string }; result: Summary | null };
  // What the user confirmed; answers the task's name.
  todoist_add_from_slack: {
    args: { url: string; content: string; description: string; due: string; projectId?: string | null; today: boolean };
    result: string | null;
  };
  // One task with its name, its date (YYYY-MM-DD or YYYY-MM-DD HH:MM) and its project, as given (the tool todoist_add_task of tsunagiai-mcp makes the same one; the screen no longer calls this).
  todoist_add_task: { args: { content: string; due?: string | null; projectId?: string | null }; result: boolean | null };
  todoist_set_done: { args: { id: string; done: boolean }; result: boolean | null };
  todoist_update: {
    args: { id: string; content?: string; description?: string; dueString?: string; labels?: string[] };
    result: boolean | null;
  };
  // The due a text makes on a task (a day picked in the calendar, or empty for none), to put on it at once; null for other text, which Todoist reads.
  todoist_picked_due: { args: { text: string }; result: PickedDue | null };
  // Makes the personal label `name` and sets the task's labels to `labels` (its whole list, the new name in it).
  todoist_create_label: { args: { id: string; name: string; labels: string[] }; result: boolean | null };
  todoist_move: { args: { id: string; projectId: string }; result: boolean | null };
  todoist_move_under: { args: { id: string; parentId: string }; result: boolean | null };
  // T-2: puts the task under parentId, or at the top of projectId when parentId is null, before the sibling beforeId (last when null). null: a token is needed.
  todoist_place: {
    args: { id: string; parentId: string | null; projectId: string | null; beforeId: string | null };
    result: boolean | null;
  };
  todoist_delete: { args: { id: string }; result: boolean | null };
  // T-8: archives the project (its sub-projects with it); its tasks are kept in Todoist. null: a token is needed.
  todoist_archive_project: { args: { id: string }; result: boolean | null };
  // T-8: deletes the project for good, with its sub-projects, sections and tasks. null: a token is needed.
  todoist_delete_project: { args: { id: string }; result: boolean | null };
  // T-8: moves the project under `parentId` as its last sub-project, or to the top when `parentId` is null (its sub-projects go with it). null: a token is needed.
  todoist_move_project: { args: { id: string; parentId: string | null }; result: boolean | null };
  todoist_open: { args: { id: string }; result: null };
  // A task's comments, oldest first. `projectId` is the task's project, whose collaborators name the authors. null: a token is needed.
  todoist_comments: { args: { taskId: string; projectId: string }; result: Comment[] | null };
  // The file as raw bytes, sent with `invokeRaw` (its name travels in the `x-file-name` header); answers what Todoist says about it. null: a token is needed.
  todoist_upload: { args: Uint8Array; result: Upload | null };
  // `attachment` is what `todoist_upload` answered. null: a token is needed.
  todoist_add_comment: { args: { taskId: string; content: string; attachment: Upload | null }; result: Comment | null };
  slack_load: { args: undefined; result: SlackLoad };
  slack_check: { args: { teamId: string }; result: Checked };
  slack_add_workspace: { args: { token: string }; result: Workspace[] };
  slack_remove_workspace: { args: { teamId: string }; result: Workspace[] };
  // S-16: keeps the workspace's App-Level Token (xapp-) once Slack accepts it, and connects it by Socket Mode; answers the connections (a workspace not in the list has none).
  slack_app_token_set: { args: { teamId: string; token: string }; result: SocketStatus[] };
  // S-16: stops the workspace's connection and deletes its App-Level Token; answers the connections.
  slack_app_token_remove: { args: { teamId: string }; result: SocketStatus[] };
  // S-16: the connections now. A change is sent to the screen as the event `slack-socket-status` (one `SocketStatus`).
  slack_socket_status: { args: undefined; result: SocketStatus[] };
  // The connected Notion workspaces; `reconnect` is true when no token is kept. Asks Notion nothing.
  notion_accounts: { args: undefined; result: NotionAccount[] };
  // Opens the browser for Notion's consent and answers the connected workspace.
  notion_connect: { args: undefined; result: NotionAccount };
  // Revokes the grant at Notion and drops its token and entry.
  notion_disconnect: { args: { workspaceId: string }; result: null };
  // J-1: the saved site and email address of the Jira connection, and whether a token is kept; the token is never returned. Asks Jira nothing.
  jira_settings: { args: undefined; result: JiraSettings };
  // J-1: saves the connection (an empty token keeps the stored one); answers what is saved.
  jira_save: { args: { site: string; email: string; token: string }; result: JiraSettings };
  // J-1: asks the site who the credential of the form is (an empty token takes the stored one); saves nothing.
  jira_test: { args: { site: string; email: string; token: string }; result: JiraUser };
  slack_channels: { args: { teamId: string; refresh: boolean }; result: Channel[] };
  slack_link: { args: { url: string }; result: Target };
  // What a post of the mail starts out as (plain text); the user edits it on the compose screen.
  slack_preview: { args: Mail; result: string };
  // Posts `text` as it is (Rust escapes it for Slack and refuses a blank one or one past 10,000 characters). `written` true: the owner wrote the text in a card of "行うこと", and its `@here`, `@channel` and `@everyone` become mentions; false for the mail's content.
  // The answer is the time (`ts`) of the posted message, which a later post gives as `threadTs` to continue its thread (empty when Slack's answer had none).
  slack_post: {
    args: { teamId: string; channel: string; threadTs: string | null; name: string; text: string; written: boolean };
    result: string;
  };
  // The fields of the Slack compose screen that Claude Code reads (S-4, #734): `actions` are the cards of "行うこと" (the posted ones first), and the answer is the text of two JSON arrays, the cards with the numbers of their destinations and the destinations numbered from 1.
  // Rust keeps the numbered destinations for the next write.
  slack_compose_read: { args: { actions: SlackAction[] }; result: ComposeRead };
  // The cards after a write of the field `actions` (the text of a JSON array, S-4): the posted ones as they were, and the ones to post as the write made them. A number that is outside its list, or any other fault, is a Japanese message. Nothing is posted or saved.
  slack_compose_write: { args: { text: string; actions: SlackAction[] }; result: SlackAction[] };
  // The newest 10 unread rows of each joined channel (no direct messages) of every workspace, newest first: the unread messages (S-8) and the threads with unread replies (S-14, each with `unreadReplies`), and `watched`, the watched threads (S-13, each with `watch`, the newest activity first); `failed` are workspaces whose read failed (the messages their earlier reads kept are still listed),
  // `missing` the scopes a token lacks (users:read, files:read, channels:write, groups:write among them), `refreshSecs` the wait until the next read, `pendingChannels` the channels no read has reached yet,
  // `unreadTotal` the unread messages among all those held and the unread replies (the Slack button's badge), `unreadChannels` the channels with something unread, each with its number of unread messages, the newest one (`to`) that "既読にする" sets the position to, and its threads with unread replies. Messages are kept in memory only.
  // With `cached` true nothing is asked of Slack: the list is made again from what Rust holds (after a channel was hidden or put back).
  slack_timeline: { args: { cached: boolean } | undefined; result: Timeline };
  // The channels kept off the Slack list, in the order they were hidden, with the channel's name (its ID when the name is not known). Slack itself is not told (its mute cannot be read).
  slack_hidden_list: { args: undefined; result: HiddenChannel[] };
  slack_hide_channel: { args: { teamId: string; channel: string }; result: boolean };
  slack_side_folded: { args: undefined; result: string[] };
  slack_set_side_folded: { args: { teamIds: string[] }; result: boolean };
  slack_unhide_channel: { args: { teamId: string; channel: string }; result: boolean };
  // Sets the channel's read position to the message `ts` in Slack (`conversations.mark`), only when it is later than the one held; true when it was sent.
  slack_mark_read: { args: { teamId: string; channel: string; ts: string }; result: boolean };
  // Watches the thread `ts` (its own message's ts): the replies that exist now are not new. With `seenTs` (what `slack_unwatch` answered) it is put back as it was and Slack is asked nothing.
  slack_watch: { args: { teamId: string; channel: string; ts: string; seenTs?: string | null }; result: boolean };
  // Lets the thread go; answers the reply it had been seen up to (null: it was not watched).
  slack_unwatch: { args: { teamId: string; channel: string; ts: string }; result: string | null };
  // The watched thread was opened: its new replies count as seen, up to the newest reply the last check found or `latestTs` (the newest reply the thread detail read), whichever is later (asks Slack nothing).
  slack_watch_seen: { args: { teamId: string; channel: string; ts: string; latestTs?: string | null }; result: boolean };
  // The thread `ts` (not a watched one) was read up to the reply `latestTs`: the position kept here moves forward, since Slack cannot be told (asks Slack nothing). True when it moved.
  slack_thread_seen: { args: { teamId: string; channel: string; ts: string; latestTs: string }; result: boolean };
  // The whole thread starting at `ts`, oldest first. For a reply pass its `threadTs`, not its own `ts`.
  slack_thread: { args: { teamId: string; channel: string; ts: string }; result: SlackThread };
  // The newest messages of a joined channel (S-20), oldest first, drawn as the list's rows (`unread` false); it changes no read position.
  slack_channel_history: { args: { teamId: string; channel: string }; result: TimelineMessage[] };
  // Posts `text` to a channel of the side menu (S-21) under the user's own name (the checks and the errors of `slack_post`; the recent destinations are not touched).
  // `markdown` true: `text` is the Markdown of the rich field, turned into Slack's mrkdwn in Rust before it is checked and sent; absent or false: plain text, as before.
  slack_channel_post: { args: { teamId: string; channel: string; text: string; markdown?: boolean }; result: boolean };
  // Posts `text` as a reply in the thread (the checks and the errors of `slack_post`; the recent destinations are not touched). `markdown` as for `slack_channel_post`.
  slack_reply: { args: { teamId: string; channel: string; threadTs: string; text: string; markdown?: boolean }; result: boolean };
  // Adds (`add` true) or takes off (false) the user's reaction `name` (Slack's name of it: `tada`, `+1::skin-tone-2`, a custom emoji's name) on the message `ts` of `channel`, a channel, a DM or a group DM (S-25).
  // True when Slack changed it, false when it was so already (`already_reacted`, `no_reaction`).
  slack_react: { args: { teamId: string; channel: string; ts: string; name: string; add: boolean }; result: boolean };
  // What the emoji picker (S-25) lists for the workspace: the standard emoji (Slack's name and the Unicode emoji, no skin tone variant) and the custom emoji with an image (S-26; an `alias:` is not listed again). Nothing is saved.
  slack_emoji_catalog: { args: { teamId: string }; result: EmojiCatalog };
  // The attached images (a thread file's `thumbUrl`) as data: URIs by URL; the token goes to files.slack.com only. What cannot be fetched is not in the map.
  slack_file_images: { args: { teamId: string; urls: string[] }; result: Record<string, string> };
  // The user's own icon in each workspace.
  slack_icons: { args: undefined; result: WorkspaceIcon[] };
  // Whether Claude can be used with the method in use (the subscription logged in, or an API key that is not refused).
  claude_status: { args: undefined; result: Claude };
  // The settings card's view: the method in use, the subscription's and the API key's own states, and the usable state (`claude`) of the method in use.
  claude_connection: { args: undefined; result: ClaudeConnection };
  // Checks the key at Anthropic and, only if it works, stores it. With `switch` it also makes the key the method and logs Claude Code out (unless the key was the method already);
  // without it only the key is replaced. `logoutError` says that the key was stored but the logout could not be confirmed.
  claude_key_save: { args: { key: string; switch: boolean }; result: KeySaved };
  // The API key method needs a stored key; choosing it logs Claude Code out. The subscription only changes the method.
  claude_method_set: { args: { method: Method }; result: null };
  // Deletes the stored key; the method goes back to the subscription if the key was in use.
  claude_key_delete: { args: undefined; result: null };
  // The model and effort of each purpose of the `claude -p` calls (A-2): the saved ones, or the defaults. Saving one purpose answers the settings of all of them.
  claude_model_settings: { args: undefined; result: ClaudeSettings };
  // Without `effort`, the model's recommended effort is saved.
  claude_model_settings_save: { args: { purpose: keyof ClaudeSettings; model: Model; effort?: Effort }; result: ClaudeSettings };
  // The thread's messages in the order the thread has them; `text` is each body as plain text.
  claude_summarize_mail: { args: { subject: string; messages: { from: string; dateMs: number; text: string }[] }; result: MailSummary };
  // The instructions of the Slack summary: the one in use, saved (the default body removes the saved one), or back to the default. Each answers the state after it.
  claude_todo_prompt: { args: undefined; result: TodoPrompt };
  claude_todo_prompt_save: { args: { body: string }; result: TodoPrompt };
  claude_todo_prompt_reset: { args: undefined; result: TodoPrompt };
  // A-9: Claude's summary of the content to hand over (the mail, the Slack thread or the Todo of the card), as points. `context` is quoted to Claude as data, never followed; the instruction the user wrote is not sent to Claude: Rust only checks it with the content against the limit of the prompt, before the call. The model and effort are those of `orcaHandoff`. Nothing is saved.
  claude_summarize_handoff: { args: { context: HandoffContext; instruction: string }; result: HandoffSummary };
  // S-24: the history of the open channel as Claude Code reads it (the field `channel` of the target "slack-channel"): `teamId` and `channel` must be a connected workspace and a channel of its list (a refusal is a Japanese message), and `messages` are its recent messages as the screen draws them (`text` of `TimelineMessage`), oldest first.
  // The answer names the channel by the workspace's name and the channel's name Rust holds, and encloses the messages as data between boundary lines. Nothing is sent or saved.
  claude_channel_data: { args: { channel: { teamId: string; channel: string; messages: { name: string; ts: string; text: string }[] } }; result: string };
  // S-7: the open Slack thread as Claude Code reads it (the field `thread` of the target "slack-thread"): its messages as the screen shows them (`text` of `ThreadMessage`), with `truncated` (the read stopped before the end of the thread), enclosed as data between boundary lines. Nothing is sent or saved.
  claude_thread_data: { args: { thread: { name: string; ts: string; text: string }[]; truncated: boolean }; result: string };
  // The agents that run in the Orca in use and its worktrees. Never rejects for a read that failed: `state` says "missing" (no orca command) or "failed" (with `message`).
  // `scope` "full" reads the saved environments and resolves the target (the saved one; with no file saved yet the first environment, else this machine; a saved environment that is gone, or a file that cannot be used while an environment is saved, is a failed read that picks nothing, and the owner corrects the file),
  // "screen" reads the agents and their terminals of `target` (the one the screen holds), and "badge" only the agents, for the count (no terminals, so no handles). With "screen" and "badge", and when `environment list` itself failed, `known` is false and `target` and `environments` are not the answer: the screen keeps the ones it had.
  orca_overview: { args: { scope: "full" | "screen" | "badge"; target: string | null }; result: OrcaOverview };
  // A-9: the lists of the destination the side pane chose (null: this machine, else a saved environment's name, checked against the saved ones; one that is not saved is a failed read). It reads the agents and their terminals, the worktrees and the projects like "screen", with `environments` filled, and does not touch the target the Orca screen holds.
  // `force` is false only for the poll of a shown session: for the destination checked just before, the saved environments are not asked for again and `environments` is empty.
  orca_destination: { args: { environment: string | null; force: boolean }; result: OrcaOverview };
  // Sends `text` and Enter to the terminal `handle`; `environment` is the target the screen shows. Never run twice.
  orca_send: { args: { handle: string; text: string; environment: string | null }; result: null };
  // A-16: starts Claude in the worktree at `path` with no first prompt (the plus of the work pane). The answer is the session as Orca's reply names it (`paneKey` and `handle` are null when the reply lacks them). Never run twice.
  orca_start: { args: { path: string; environment: string | null }; result: OrcaStarted };
  // A-16: opens a plain terminal in the worktree at `path` (the plus of the work pane). The answer names its `handle` (`paneKey` is always null). Never run twice.
  orca_terminal_create: { args: { path: string; environment: string | null }; result: OrcaStarted };
  // A-9: makes a new worktree named `name` in the project `project` (an `OrcaProject.key` of the destination's list, checked against it; the name is one plain line, trimmed) of the destination (null: this machine, else a saved environment's name). The answer is the new worktree's absolute path. Never run twice.
  orca_worktree_create: { args: { project: string; name: string; branch: string | null; base: string | null; environment: string | null }; result: string };
  // A-9: starts a session in a worktree with the instruction the owner wrote (`instruction`), the text of each file attached to it (`files`, A-10), the summary of the content (`summary`, empty without the content) and, when `context` is not null, the content quoted as data after them. Never run twice.
  orca_handoff: { args: { destination: HandoffDestination; instruction: string; files: string[]; summary: string[]; context: HandoffContext | null; environment: string | null }; result: OrcaStarted };
  // A-38: adds the folder `path` on the server of the saved environment `environment` to Orca as a project. Never run twice. A failure carries the message. A folder of this Mac is added only by `orca_project_add_here`.
  orca_project_add: { args: { path: string; environment: string }; result: null };
  // A-38: Rust opens the folder dialog of this Mac (the page gives no place and has no dialog permission), and adds the folder picked. `false` when the dialog was cancelled (nothing was added). Never run twice. A failure carries the message.
  orca_project_add_here: { args: undefined; result: boolean };
  // A-38: the folders in `path` of the saved environment `environment` (an empty path is its home folder), for the dialog that picks the folder of a project to add. `resolvedPath` is the folder Orca opened, `folders` the names in it. A failure carries the message.
  orca_browse_dir: { args: { environment: string; path: string }; result: BrowsedDir };
  // A-10: puts the file `data` (base64, any kind, up to 20 MiB) in `.orca/drops/` of the worktree at `path` of the target `environment`, under its own `name` (a taken name gets `copy`, `copy 2`, ...), and answers `AttachedFile { text, bracketed }`: the text to type for it (the absolute path, one blank after it) and whether the terminal gets it as a bracketed paste (an image) or as typed text. Not tried again: a failure carries its message.
  orca_attach_file: { args: { path: string; name: string; data: string; environment: string | null }; result: AttachedFile };
  // Closes the tab of an Orca terminal (a Claude session or a plain terminal); `environment` is the target the screen shows. On `terminal_handle_stale` it closes once more without `--tab`, and a failure of that is an error.
  orca_close: { args: { handle: string; environment: string | null }; result: null };
  // The lines on the screen of the terminal `handle` (a Claude session's or a plain one) of this machine, or of the saved environment `environment` when given, for the mirror (no colors).
  orca_terminal_read: { args: { handle: string; environment?: string }; result: string[] };
  // Types `text` into the terminal `handle` of this machine, or of the saved environment `environment` when given, as it is (no Enter is added).
  orca_terminal_input: { args: { handle: string; text: string; environment?: string }; result: null };
  // A-8, A-12: opens `url` in the default browser, for a link ⌘+clicked in a terminal. Only an http or https URL is opened; any other fails with the message.
  orca_open_url: { args: { url: string }; result: null };
  // A-12: the stream of the saved environment `environment`: the list goes to `channel` (an `OrcaStreamEvent` at a time) until it is closed or another is opened; only one runs.
  orca_stream_open: { args: { environment: string; channel: unknown }; result: null };
  orca_stream_close: { args: undefined; result: null };
  // A-12, A-17: shows the terminal `handle` of the stream (the terminals of the other panes stay shown): its screen and its bytes go to `channel` (an `OrcaTermEvent` at a time). The terminal fits the pane's size, `viewport`.
  orca_stream_terminal: { args: { handle: string; generation: number; viewport: OrcaViewport; channel: unknown }; result: null };
  // A-12, A-17: shows the terminal `handle` no more; Orca gives it back its own size.
  orca_stream_terminal_close: { args: { handle: string; generation: number }; result: null };
  // A-12, A-17: the new size of the pane of the terminal `handle`.
  orca_stream_viewport: { args: { handle: string; viewport: OrcaViewport }; result: null };
  // A-12: types `text` into the terminal `handle` shown as it is (no Enter is added); the answer says whether Orca took it.
  orca_stream_input: { args: { handle: string; text: string }; result: null };
  // A-36: starts Claude Code in a pseudo terminal for the pane `id` (one that `id` had is ended): its output and its end go to `channel` (a `ClaudeCodeEvent` at a time). `builtinTools` leaves Claude Code's own tools on, `permissionMode` is "manual" (it asks the owner for every tool that writes), "auto" (the calendar pane, #1074), "auto-slack-compose" (the Slack compose pane, #1144: Sonnet at the effort high, and it asks the owner before a post) or "auto-todo-draft" (the pane of a Todo's draft, #1148: Sonnet at the effort high); Rust refuses all three with `builtinTools` and for the orchestrator, `skill` is a saved skill it is given, `prompt` is its first instruction (1 to 20,000 characters, null for none; passed as `claude [prompt]`, and the orchestrator takes none from here). The orchestrator of a formation (A-37, the id `formation:{name}`) gets the projects saved with its formation as its first instruction, which Rust reads itself. The answer is the number of this start. A failure is the message the pane shows.
  claude_code_start: { args: { id: string; viewport: OrcaViewport; builtinTools: boolean; permissionMode: ClaudeCodePermissionMode; skill: { name: string; screen: SkillScreen } | null; prompt: string | null; channel: unknown }; result: number };
  // A-36: types `text` into the pane `id` as it is (no Enter is added).
  claude_code_input: { args: { id: string; text: string }; result: null };
  // A-36: the new size of the pane `id` in cells.
  claude_code_resize: { args: { id: string; viewport: OrcaViewport }; result: null };
  // A-36: ends the process of the pane `id` that the start `launch` (its answer) made, and what it started; a process of a later start stays.
  claude_code_close: { args: { id: string; launch: number }; result: null };
  // A-36 (#731): the screen's answer to the ask `id` of the event "screen-bridge-ask" (the fields it holds for a read, `ok` for a write, or an error). An answer that comes after Rust stopped waiting is dropped.
  screen_bridge_answer: { args: { id: number; answer: ScreenAnswer }; result: null };
  // A-37: the children of the formation `name`, in the order of `formations/{name}/children.json`, each joined to its agent of the `orca worktree ps` of its environment (a planned one has no state yet, a launched one that left the list is done with no handle). A failure carries the message.
  formation_children: { args: { name: string }; result: FormationChild[] };
  // A-37 (#1084): the messages that the leader of the formation `name` and its children sent each other by SendMessage, oldest first, the last 500 at most: who sent it (`from`), to whom (`to`), when (`atMs`, epoch milliseconds) and the first line of the text (`line`, data from the sender, at most 200 characters). A formation of a saved environment is read from its PC. One that has none yet answers an empty list.
  formation_messages: { args: { name: string }; result: FormationMessage[] };
  formation_instructed: { args: { name: string }; result: string[] };
  // A-41: the decision page that waits on the child `child` of the formation `name` (the child's `pendingPage` is set), checked again and with its evidence resolved now: a formation of a saved environment has its PC's server do it. A failure carries the message: the violations of the page, one on each line, or why it could not be read.
  formation_page_read: { args: { name: string; child: string }; result: DecisionPage };
  // A-41 (#1153): an image of the page that waits on `child`, as a `data:` URI: the file `path` of the page's root `root` (an `image` block names it; a file over 3 MiB is made a smaller JPEG). The screen asks for each image when it draws it. A failure carries the reason.
  formation_page_image: { args: { name: string; child: string; root: string; path: string }; result: string };
  // A-41 (#923): sends the owner's answers to the page that waits on `child` as the reply to the leader's terminal (the pane of this Mac, or the terminal of the formation's PC in its Orca) and takes the page off the waiting. `atMs` is the time of the mark the page was drawn for: a page that was replaced meanwhile is refused. The page is read again and the reply is made in Rust; a required card with no answer, a key the card does not offer and a leader that is not running are failures with the message, and the page stays waiting.
  formation_page_answer: { args: { name: string; child: string; atMs: number; answers: PageAnswer[]; verdict: PageVerdict | null; revision: string }; result: null };
  // A-37: the environments (this Mac first, then the saved ones) with the repositories of each, read from Orca; an environment that could not be read has `ok` false and its `error`, and the others are read.
  formation_environments: { args: undefined; result: EnvironmentsView };
  // A-37: the terminal of the orchestrator of the formation `name`, which belongs to a saved environment (its `environment` in `formation_list` is not `local`): the one `formation.json` records while that Orca lists it, else a new one that Rust makes in the first project's repository there, waits for and gives the projects as its first instruction. `restart` closes the recorded one first. A failure carries the message the pane shows.
  formation_orchestrator: { args: { name: string; restart: boolean }; result: FormationOrchestrator };
  // A-37: the formations in order of name, each with its projects, the PC it belongs to (`environment`: `local` or a saved environment), when it was created (null for the first, which exists before any is created) and the number of its children in each state (`orca worktree ps` is read once for each environment). `readError` says why no launched child could be read; the counts take them as working then.
  formation_list: { args: undefined; result: FormationList };
  // A-37: makes the formation `name` (the shape of a child's name, not the name of a formation or of a child) of `projects` (each an environment and a repository of `formation_environments`, by name or id and by name or path). A failure carries the message.
  formation_create: { args: { name: string; projects: FormationProject[] }; result: FormationEntry };
  // A-37: deletes the formation `name`: every child of it is checked as `formation_close` checks it, and when none is refused its orchestrator's process ends, the children are closed and its folder is deleted. Children kept for what git says of their worktrees (a change, an untracked file, a commit no remote has) are the answer (`deleted` false, `kept` with the lines of git for each) and nothing is ended or closed; with `force` the children named in `shown` (each child's `name` and the `path` of the answer's `kept`, as the owner was shown them) are closed all the same, with `--force`, and their changes and untracked files are lost (the commits no remote has stay on the local branch, which Orca keeps: `preserved` of the answer names it); a child that `shown` does not name, or names with another path, is checked again as without `force`. Any other refusal carries the message and the formation stays; a child that is refused only when it is closed (its state changed) leaves the process ended.
  formation_delete: { args: { name: string; force: boolean; shown: FormationShown[] }; result: FormationDeleteAnswer };
  // A-37: closes the child `name` of the formation `formation` from its card, as `formation_close` does (its terminal, its worktree with its branch, its entry of the record; a child in a folder that tsunagiai did not make has only its terminal closed and its entry dropped, and no git look is made). A worktree with a change, an untracked file or a commit no remote has is kept: the answer has `closed` false with the reason and the lines of git. With `force` and the `path` the answer showed it is removed all the same, with `--force`, and its changes and untracked files are lost (the commits no remote has stay on the local branch, which Orca keeps: `preservedBranch` of the answer names it); with another `path`, or null, it is checked again as without `force`. Any other refusal carries the message.
  formation_close_child: { args: { formation: string; name: string; force: boolean; path: string | null }; result: FormationCloseAnswer };
  // A-37 (#893): the saved environments whose PC the owner agreed to put `tsunagiai-mcp` on, each with the version of its server, in order of the environment's name. The consent is the pinned key of that PC's server.
  formation_consents: { args: undefined; result: FormationConsent[] };
  // A-37 (#893): the owner agrees for the PC of the saved environment `environment`: Rust puts the program there, starts it and pins its key, which takes up to 2 minutes. A failure carries the words of its reason, and nothing is agreed.
  formation_consent: { args: { environment: string }; result: FormationConsent };
  // A-37 (#893): takes the consent of `environment` back: stops the server on its PC, deletes what was put there and forgets its key. The answer is the consents that are left. A PC that still has a formation is refused with the reason and nothing is changed; an environment gone from Orca loses only its consent.
  formation_consent_revoke: { args: { environment: string }; result: FormationConsent[] };
  // A-17: the layout of the work pane of the project `project` of `environment` (null: this machine): the saved one, mended against the tabs the screen shows now (`tabs`), after `op` when there is one. Rust saves it.
  orca_panes: { args: { environment: string | null; project: string; tabs: string[]; handles: Record<string, string>; was: Record<string, string>; op: PaneOp | null }; result: PaneLayout };
  // A-18: the entries of the folder `dir` (relative to the worktree; "" is its own folder) of the worktree at `path` of the target `environment`: the folders first, each with whether git ignores it. Not tried again: a failure carries its message.
  orca_files_list: { args: { path: string; dir: string; ignored: boolean; environment: string | null }; result: OrcaDir };
  orca_files_ignored: { args: { path: string; paths: string[]; environment: string | null }; result: string[] };
  // A-18: which of `paths` (entries of one list, relative to the worktree at `path`) differ from HEAD: `changed` (a file that is modified, deleted, renamed or copied) or `new` (untracked or added). A folder is what its files are, `changed` when both. The entries that do not differ are left out. A failed check answers none.
  orca_files_changes: { args: { path: string; paths: string[]; environment: string | null }; result: OrcaGitChange[] };
  // A-26: cuts the front matter off a Markdown text; the rich view is given the body only.
  markdown_split: { args: { text: string }; result: MarkdownParts };
  // A-26: puts the edit of the rich view into the original text. `before` and `after` are what the editor exported for the body when it was loaded and now; `conflict` when the edit cannot be put into the original.
  markdown_patch: { args: { original: string; before: string; after: string }; result: MarkdownPatchResult };
  // A-18: the text of the file `relative` of the worktree, for the editor, with LF line ends (`crlf`: the file has CRLF) and the signature of what the disk holds. A binary file, one over 384 KiB and one that is not UTF-8 are errors.
  orca_file_read: { args: { path: string; relative: string; environment: string | null }; result: OrcaFileText };
  // A-18: saves `content` over the file only if the disk still holds the text with `signature` (`crlf`: write CRLF). `state` says whether it was written (`saved`, with the new signature) or the disk had changed (`changed`, `missing`, `not-utf8`: nothing written).
  orca_file_write: { args: { path: string; relative: string; content: string; crlf: boolean; signature: string; environment: string | null }; result: OrcaSaved };
  // A-18: makes a file, or with `folder` a folder, named `name` in the folder `dir` of the worktree (the empty `dir` is its root), and answers its path from the worktree. A name that is not one name, and one that is taken, are errors; nothing is overwritten.
  orca_file_create: { args: { path: string; dir: string; name: string; folder: boolean; environment: string | null }; result: string };
  // A-18: deletes the files and folders `entries` (a folder with everything in it) of the worktree, for good (no Trash). An entry under a folder of the list goes with the folder, the root of the worktree and a path outside it are refused, and the delete stops at the first that fails: the answer holds the entries that are gone and that failure's message.
  orca_files_delete: { args: { path: string; entries: OrcaDeleteEntry[]; environment: string | null }; result: OrcaDeleted };
  // A-29: makes the scratchpad file `name` in `.orca/scratchpad` of the worktree and answers its path from the worktree; a file of that name that is there already is answered as it is (`existed`) and left as it is.
  orca_scratchpad_create: { args: { path: string; name: string; environment: string | null }; result: OrcaScratchpad };
  // A-34: the names of the Hosts of this Mac's `~/.ssh/config` (and of the files it includes), in the order they come, with no pattern (`*`, `?`, `!`) and no name that ssh is not given; the choices of the ssh Host of a repository. No file is an empty list.
  ssh_hosts: { args: undefined; result: string[] };
  // A-34: how the card of a language server draws each language of A-21 (`plaintext` too, each once, sorted): its title (`Ruby`, `TypeScript`; any other is its name) and its icon of src/vendor/jetbrains-icons/, none for a language that has none.
  lsp_language_looks: { args: undefined; result: LspLanguageLook[] };
  // A-34: the settings of the repository of the project `project` of `environment` (null: this machine) for the language servers: the saved ones, else the unset ones (one server, ruby-lsp, of the language `ruby`, with `autoStart` true and nothing replaced). A repository has one server for each language.
  lsp_settings: { args: { environment: string | null; project: string }; result: LspRepoSettings };
  // A-34: saves the settings of a repository and answers them as saved (texts trimmed, an empty one not set). Settings that are the unset ones take the entry away. A host that is not a Host name for ssh, a path of the mount that is not absolute, a text with a control character, a server name over 64 characters (an empty one is saved as the name of the app's table for the language, else the language), a language that is not one of A-21 and a language that two servers have are errors.
  lsp_settings_set: { args: { settings: LspRepoSettings }; result: LspRepoSettings };
  // A-34: the key of the server of the project `project` of `environment` that takes `language` (a language of A-21), which is the language itself, null when the repository has no server of it. The key is what every command below takes as `server`.
  // A-34, A-36: the first instruction of the Claude Code pane that sets up the language servers of `worktree` (`language`: only that one, null for every language of it): the values in a quote as data, the ssh Host saved for the repository, the worktree checked against Orca's list. A value that is refused is an error in Japanese.
  lsp_claude_request: { args: { environment: string | null; project: string; worktree: string; language: string | null }; result: string };
  lsp_server_for: { args: { environment: string | null; project: string; language: string }; result: string | null };
  // A-34: the languages that `worktree` of the project `project` of `environment` (null: this machine) has, each with the server of the app's table (name, command, where it runs, mount, and whether it was `found`, is `missing` or its container is down), read from the worktree just now (a saved environment's through the ssh Host of its settings; in the service of compose that mounts the worktree, when there is one). A language that the worktree does not show is not answered.
  lsp_detect: { args: { environment: string | null; project: string; worktree: string }; result: LspFound[] };
  // A-34: how the server of each of the languages `servers` is started in `worktree` of the project `project` of `environment` (null: this machine), in their order: read from the worktree just now, once for all of them (a saved environment's through the ssh Host of its settings), with the settings of each server applied.
  lsp_launches: { args: { environment: string | null; project: string; worktree: string; servers: string[] }; result: LspLaunch[] };
  // A-34: starts the server `server` for `worktree` of the project `project` of `environment` (null: this machine) and answers its state (`indexing`). A server that is there and not stopped is left as it is; a stopped one is started again. How it is started is read from the worktree by Rust; a failure of that or of the process is the state `stopped` with its message, told by the event `lsp-status` (`LspStatusEvent`).
  lsp_start: { args: { environment: string | null; project: string; worktree: string; server: string }; result: LspStatus };
  // A-34: stops the server `server` of `worktree` and starts it again (the restart of the screen), as `lsp_start` does, and answers its state (`indexing`). The places outside the worktree that the stopped server gave stay known to the new one.
  lsp_restart: { args: { environment: string | null; project: string; worktree: string; server: string }; result: LspStatus };
  // A-34: stops the server `server` of `worktree` (`shutdown`, `exit`, then its standard input is closed). A worktree with none is no error.
  lsp_stop: { args: { environment: string | null; worktree: string; server: string }; result: null };
  // A-34: the state of the server `server` of `worktree`: `indexing`, `running`, or `stopped` with the reason (`notStarted` when there is none, `containerDown` when the container of the service does not run, `failed` with a message).
  lsp_status: { args: { environment: string | null; worktree: string; server: string }; result: LspStatus };
  // A-34: the places of the definition of the name at `line` and `character` (UTF-16 units, the index of a JavaScript string) of the file `relative` of `worktree`, asked of the server `server`, whose text `text` is sent as the whole text of the file. A place inside the worktree has its path from the worktree; one outside has the absolute path on the server's side and `outside`. Nothing found is an empty list.
  lsp_definition: { args: { environment: string | null; worktree: string; server: string; relative: string; text: string; line: number; character: number }; result: LspLocation[] };
  // A-34: whether the same question as `lsp_definition` has at least one place, for the underline of the Command key: it tells the server of no change on the disk and keeps no place outside the worktree. Only a server that is `running` is asked; any other state, and no server, is an error, and nothing is started.
  lsp_definition_exists: { args: { environment: string | null; worktree: string; server: string; relative: string; text: string; line: number; character: number }; result: boolean };
  // A-34: the text, read only, of the file `path` outside `worktree` (an absolute path on the server's side) that the server `server` of that worktree gave as a definition with `outside`; any other path is an error. It is read the way the server is started (cat on this machine, `docker compose exec -T` in its service, ssh in front for a saved environment). A file over 1 MiB, one that is not UTF-8 and one that cannot be read are errors.
  lsp_read_outside: { args: { environment: string | null; project: string; worktree: string; server: string; path: string }; result: LspOutsideFile };
  // A-34: starts the container of the service that the server `server` runs in for `worktree` (`docker compose up -d {service}`, run the way the server is started: this machine, or through ssh for a saved environment). Only the method `compose` has a container; any other is an error. The server is not started by it.
  lsp_container_start: { args: { environment: string | null; project: string; worktree: string; server: string }; result: null };
  // A-34: the Ruby name at the UTF-16 unit `character` of `line`, the text of one line of the editor (a name may have `@`, `@@` or `$` before it and `?` or `!` after it); null where there is none.
  lsp_word: { args: { line: string; character: number }; result: string | null };
  // A-34: how the definition pane draws each of `locations`, in order: the file and its line (from 1), the folder in the worktree or the gem and the folder in it, and whether it is outside the worktree. It reads and asks for nothing.
  lsp_places: { args: { locations: LspLocation[] }; result: LspPlace[] };
  // A-18: moves or renames the file or folder `from` of the worktree to `to` (both paths from the worktree), making the folders of `to` that are missing. A place that is taken, the root, a path outside the worktree, the same place and a place inside `from` are errors; nothing is overwritten.
  orca_file_move: { args: { path: string; from: string; to: string; environment: string | null }; result: null };
  // A-24: the diff of the file `relative` of the worktree, HEAD against the working tree: the rows of both views, the blocks of changes and the language to color by.
  orca_file_diff: { args: { path: string; relative: string; environment: string | null }; result: OrcaFileDiff };
  // A-27: `limit` (1 to 200) commits of the worktree at `path` from HEAD, the newest first, after the first `skip`.
  orca_git_history: { args: { path: string; limit: number; skip: number; historyToken: string | null; environment: string | null }; result: OrcaCommitList };
  // A-27: the files the commit `commitId` (a full id) changed against its first parent.
  orca_commit_files: { args: { path: string; commitId: string; environment: string | null }; result: OrcaCommitFiles };
  // A-27: the diff of the file `relative` in the commit `commitId` from `parentId` (none for the first commit), as the diff tab draws it (`oldRelative`: where a renamed file came from).
  orca_commit_file_diff: { args: { path: string; commitId: string; parentId: string | null; relative: string; oldRelative: string | null; environment: string | null }; result: OrcaFileDiff };
  // A-25: the git worktrees of the project `repo` (`OrcaProject.key`): the ones Orca lists and, marked `gitOnly`, the ones only git has (Orca hides `.claude/worktrees/`). The file calls accept the path of a `gitOnly` one for a while after this.
  orca_git_worktrees: { args: { repo: string; environment: string | null }; result: OrcaGitWorktree[] };
  // A-25: the local branches of the worktree at `path`, the current one first, each with whether another worktree has it checked out.
  orca_local_branches: { args: { path: string; environment: string | null }; result: OrcaLocalBranch[] };
  // A-25: the remote branches (at most 50) whose names hold `query`, of the project `repo` (`OrcaProject.key`) of the worktree at `path`. With an empty `query` the ones picked before come first, the newest first.
  orca_remote_branches: { args: { path: string; repo: string; query: string; environment: string | null }; result: OrcaRemoteBranch[] };
  // A-25: remembers that the remote branch `name` (as Orca names it) was picked in the list of branches of the project `repo` (`OrcaProject.key`) of `environment`, so that `orca_remote_branches` answers it first to an empty `query` (at most 5 for each project of each Orca).
  orca_branch_used: { args: { repo: string; name: string; environment: string | null }; result: null };
  // A-25: switches the worktree at `path` to the local branch `name`, or to the remote one (`kind` "remote", `name` like `origin/feature/a`). Orca's refusal is the error's message; a `warning` comes with a switch that worked.
  orca_switch_branch: { args: { path: string; kind: "local" | "remote"; name: string; environment: string | null }; result: OrcaBranchSwitched };
  // A-44: stages (`orca_files_stage`), unstages (`orca_files_unstage`) or puts back as HEAD has them (`orca_files_revert`, which deletes a file that HEAD lacks, for good) the changes of `paths` (files and folders from the worktree; a folder is the changes under it). A path outside the worktree and the root are refused; Orca's refusal is the error's message.
  orca_files_stage: { args: { path: string; paths: string[]; environment: string | null }; result: null };
  orca_files_unstage: { args: { path: string; paths: string[]; environment: string | null }; result: null };
  orca_files_revert: { args: { path: string; paths: string[]; environment: string | null }; result: null };
  // A-22: copies the file `relative` of the worktree to this PC, to the place picked in the save dialog that Rust opens (the page gives none). The name of the file saved, or null when the dialog was cancelled.
  orca_file_download: { args: { path: string; relative: string; environment: string | null }; result: string | null };
  // A-31: opens the HTML file `relative` of the worktree in the default browser of this PC, from the server of the app. It answers nothing: the address is never given to the page.
  orca_file_open_in_browser: { args: { path: string; relative: string; environment: string | null }; result: null };
  // A-31: starts the same server and answers the address of the HTML file `relative` of the worktree, for the preview frame of the editor only.
  orca_file_preview_url: { args: { path: string; relative: string; environment: string | null }; result: string };
  // A-45: the checks of A-31 again for a request to open a preview that came from outside the app: the file is an HTML file inside the worktree, and the worktree is one of the target's list read just now. It starts no server.
  orca_preview_check: { args: { path: string; relative: string; environment: string | null }; result: null };
  // A-18: the settings of the editor: how long after the typing stops the file is saved.
  editor_settings: { args: undefined; result: EditorSettings };
  // A-18: saves the time of the automatic save, brought into 100 to 3000 ms in steps of 100, and answers the settings saved.
  editor_settings_set: { args: { autosaveMs: number }; result: EditorSettings };
  // A-20: the font (family and size) of each place of the screens, as saved. A file that is missing or broken gives the first values.
  font_settings: { args: undefined; result: FontSettings };
  // A-20: the families of the fonts on this Mac, in alphabetical order.
  font_families: { args: undefined; result: string[] };
  // A-20: saves the font of one place (`family` null is the app's own; `ghostty` only for orcaWork) and answers the settings saved. A family this Mac lacks is an error; a size is brought into 8 to 32 px in steps of 0.5.
  font_settings_set: { args: { area: FontArea; family: string | null; size: number; ghostty: boolean }; result: FontSettings };
  // #676: the order and the on and off of the six screens of the sidebar, as saved. A file that is missing or broken gives the first order, all shown.
  side_menu_settings: { args: undefined; result: MenuSettings };
  // #676: saves the whole list and answers the settings saved. A list that is not each screen once, or that turns the inbox off, is an error and nothing is written.
  side_menu_settings_set: { args: { items: MenuEntry[] }; result: MenuSettings };
  // The skills (`claude-plugin/skills/{name}/SKILL.md` in the config folder), by name. A folder that is not a skill is left out.
  skill_list: { args: undefined; result: Skill[] };
  // One skill by its name; an error when there is none or the name is not a valid one.
  skill_get: { args: { name: string }; result: Skill };
  // Saves a skill (a new one, or the one of that name replaced) and answers it as saved: trimmed, the screens in a fixed order. A name or text that cannot be saved is an error in Japanese.
  skill_save: { args: { skill: Skill; create: boolean }; result: Skill };
  // Deletes a skill; an error when there is none or the name is not a valid one. Answers null.
  skill_delete: { args: { name: string }; result: null };
  // A-28: adds a line to the app's log (`app-log.jsonl` in the config folder): the weight, the place and a few words of what happened, never a token, a mail, a message, what a terminal printed or what was typed. The text is cut to 500 characters and a word shaped like a token is masked. An empty text is an error in Japanese. Answers null.
  log_write: { args: { level: LogLevel; source: string; message: string }; result: null };
  // A-28: the lines of the log of the last 30 days, the newest first.
  log_read: { args: undefined; result: LogEntry[] };
  // A-3, A-28: opens the folder of the log (the config folder) in the file manager. The page gives no path. Answers null.
  log_open_folder: { args: undefined; result: null };
  // A-13: the import of Ghostty's settings saved last, null before the first one.
  ghostty_saved: { args: undefined; result: GhosttyImport | null };
  // A-13: reads Ghostty's config files, saves what the terminals take from them and answers it with the entries taken and left.
  ghostty_import: { args: undefined; result: GhosttyImport };
  // A-14: Orca's built-in terminal themes and the theme chosen for each appearance. The first time Orca's settings on this Mac can be read they give the choice.
  terminal_themes: { args: undefined; result: TerminalThemes };
  // A-14: saves the theme chosen for each appearance and answers it; a name that is not a built-in theme is an error.
  terminal_theme_set: { args: { selection: ThemeSelection }; result: ThemeSelection };
  app_info: { args: undefined; result: AppInfo };
  update_mode: { args: undefined; result: UpdateMode };
  set_update_mode: { args: { mode: UpdateMode }; result: null };
  // null: this is the latest version. install_update only replaces the app (UpdateInfo.installed afterwards); restart_app restarts it.
  check_update: { args: undefined; result: UpdateInfo | null };
  install_update: { args: undefined; result: null };
  restart_app: { args: undefined; result: null };
  // `count`: what is due or unread now. `upcoming`: the due moments (epoch milliseconds) of open tasks still ahead, which Rust adds once the clock passes them.
  set_badge: { args: { count: number; upcoming: number[] }; result: null };
  // The connections of the database screen (D-1), in the order they were made, each with whether its password is saved.
  database_profiles: { args: undefined; result: DatabaseProfileView[] };
  // Saves a connection (a new one with an empty `id`); an empty `password` leaves the saved one as it is. Answers it as saved.
  database_profile_save: { args: { profile: DatabaseProfile; password: string }; result: DatabaseProfileView };
  database_profile_delete: { args: { id: string }; result: null };
  // Tries the connection as typed (D-2): starts its script when it has one, logs in, reads `SELECT VERSION()`, ends the script. An empty `password` is the saved one of `profile.id`. Answers the version.
  database_test: { args: { profile: DatabaseProfile; password: string }; result: string };
  // D-3: opens the connection `id` when it is not open (its script when it has one, then a session) and answers the names of its databases. Called at every opening of its row: an open connection is reused.
  database_connect: { args: { id: string }; result: string[] };
  // D-3: the tables of a database of the open connection `id`, each with its estimated rows, size and engine as text.
  database_tables: { args: { id: string; database: string }; result: DatabaseTable[] };
  // D-5: the columns of a table of the open connection `id` (name, type, NULL, key, default and comment as text), and the summary of the number of columns, the engine and the character set.
  database_structure: { args: { id: string; database: string; table: string }; result: DatabaseStructure };
  // D-4: a page of the records of a table of the open connection `id` (`page` counts from 0), each value already text; one more row is read to tell whether a next page exists. The estimated rows are read with the page 0 only; `estimate` is the one that the page shown holds (null for none), which a later page answers again.
  database_records: { args: { id: string; database: string; table: string; page: number; estimate: number | null; typed?: string }; result: DatabaseRecords };
  // D-4: writes the `changes` (inserts, updates and deletes the records tab has gathered; an update and a delete name their row by the whole key of the `database_records` answer, and a value of null is NULL) to a table in one transaction. Any failure, and an update or a delete that does not match exactly one row, rolls all back. Answers the rows written of each kind.
  database_apply: { args: { id: string; database: string; table: string; changes: DatabaseChange[] }; result: DatabaseApplied };
  // D-6: runs the text `sql` as one statement in `database` of the open connection `id`: at most 1,000 rows as cells, the columns, and the line with the rows and the time. A write is committed at once (D-2).
  database_sql: { args: { id: string; database: string; sql: string }; result: DatabaseSqlResult };
  // D-3: closes the connection `id` and ends its script.
  database_disconnect: { args: { id: string }; result: null };
  // D-3: the ids of the connections that are open now.
  database_connections: { args: undefined; result: string[] };
}

// The commands that take JSON arguments; `todoist_upload` takes raw bytes (`invokeRaw`).
type JsonCommand = Exclude<keyof Commands, "todoist_upload">;

// A command whose arguments may be left out (`T | undefined`) takes them as an optional parameter.
export type ArgsOf<C extends JsonCommand> = Commands[C]["args"] extends undefined ? [] : undefined extends Commands[C]["args"] ? [Commands[C]["args"]?] : [Commands[C]["args"]];

// Read once, as the app always did: the E2E build replaces `core` with a wrapper before this module runs (e2e/fixtures.js).
const { invoke: tauriInvoke } = window.__TAURI__.core;

export function invoke<C extends JsonCommand>(command: C, ...args: ArgsOf<C>): Promise<Commands[C]["result"]> {
  return tauriInvoke(command, args[0]) as Promise<Commands[C]["result"]>;
}

// Calls a command with raw bytes as its body (Tauri's raw IPC). The rest of its arguments are the `headers`; a header value is ASCII, so the caller percent-encodes a name.
export function invokeRaw(command: "todoist_upload", body: Uint8Array, headers: Record<string, string>): Promise<Commands["todoist_upload"]["result"]> {
  return tauriInvoke(command, body, { headers }) as Promise<Commands["todoist_upload"]["result"]>;
}
