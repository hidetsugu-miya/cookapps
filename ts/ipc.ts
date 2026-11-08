// The commands of src-tauri (`invoke_handler`): each one's arguments and answer. The data types are ts-rs's (bindings/).
// A command with no arguments is called as `invoke("inbox")`. An answer of `null` is what a Rust `()` or `None` becomes.
import type { AppInfo } from "./bindings/AppInfo";
import type { Channel } from "./bindings/Channel";
import type { Checked } from "./bindings/Checked";
import type { Claude } from "./bindings/Claude";
import type { ClaudeConnection } from "./bindings/ClaudeConnection";
import type { Effort } from "./bindings/Effort";
import type { EditorSettings } from "./bindings/EditorSettings";
import type { GhosttyImport } from "./bindings/GhosttyImport";
import type { Inbox } from "./bindings/Inbox";
import type { KeySaved } from "./bindings/KeySaved";
import type { MailSummary } from "./bindings/MailSummary";
import type { MarkAll } from "./bindings/MarkAll";
import type { Method } from "./bindings/Method";
import type { Model } from "./bindings/Model";
import type { ClaudeSettings } from "./bindings/ClaudeSettings";
import type { Comment } from "./bindings/Comment";
import type { HandoffKind } from "./bindings/HandoffKind";
import type { OrcaDir } from "./bindings/OrcaDir";
import type { OrcaFileText } from "./bindings/OrcaFileText";
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaSaved } from "./bindings/OrcaSaved";
import type { OrcaStarted } from "./bindings/OrcaStarted";
import type { OrcaViewport } from "./bindings/OrcaViewport";
import type { PaneLayout } from "./bindings/PaneLayout";
import type { PaneOp } from "./bindings/PaneOp";
import type { PickedDue } from "./bindings/PickedDue";
import type { PendingImage } from "./bindings/PendingImage";
import type { PromptEdit } from "./bindings/PromptEdit";
import type { HiddenChannel } from "./bindings/HiddenChannel";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { SlackThread } from "./bindings/SlackThread";
import type { SocketStatus } from "./bindings/SocketStatus";
import type { Summary } from "./bindings/Summary";
import type { Sync } from "./bindings/Sync";
import type { Target } from "./bindings/Target";
import type { TerminalThemes } from "./bindings/TerminalThemes";
import type { ThemeSelection } from "./bindings/ThemeSelection";
import type { Timeline } from "./bindings/Timeline";
import type { ThreadDetail } from "./bindings/ThreadDetail";
import type { Todo } from "./bindings/Todo";
import type { TodoPrompt } from "./bindings/TodoPrompt";
import type { UpdateInfo } from "./bindings/UpdateInfo";
import type { UpdateMode } from "./bindings/UpdateMode";
import type { Week } from "./bindings/Week";
import type { Workspace } from "./bindings/Workspace";
import type { WorkspaceIcon } from "./bindings/WorkspaceIcon";

// Where a handoff to Orca goes (A-9): a new session in a worktree, or the terminal of a running one. Rust checks both against Orca's list.
export type HandoffDestination = { kind: "new"; path: string } | { kind: "existing"; handle: string };
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
  inbox: { args: undefined; result: Inbox };
  inbox_cached: { args: undefined; result: Inbox | null };
  sync: { args: Account & { startHistoryId: string }; result: Sync };
  thread: { args: Thread; result: ThreadDetail | null };
  // By message ID, then by the reference as written in the body.
  thread_images: { args: Thread & { images: PendingImage[] }; result: Record<string, Record<string, string>> };
  // null: that account must log in again. true: done; false: nothing to do.
  trash: { args: Thread; result: boolean | null };
  archive: { args: Thread; result: boolean | null };
  untrash: { args: Thread; result: boolean | null };
  unarchive: { args: Thread; result: boolean | null };
  set_read: { args: Thread & { read: boolean }; result: boolean | null };
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
  todoist_delete: { args: { id: string }; result: boolean | null };
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
  slack_channels: { args: { teamId: string; refresh: boolean }; result: Channel[] };
  slack_link: { args: { url: string }; result: Target };
  // What a post of the mail starts out as (plain text); the user edits it on the compose screen.
  slack_preview: { args: Mail; result: string };
  // Posts `text` as it is (Rust escapes it for Slack and refuses a blank one or one past 10,000 characters).
  slack_post: {
    args: { teamId: string; channel: string; threadTs: string | null; name: string; text: string };
    result: boolean;
  };
  // The newest 20 rows of the joined channels (no direct messages) of every workspace, newest first: the unread messages (S-8) and the threads with unread replies (S-14, each with `unreadReplies`), and `watched`, the watched threads (S-13, each with `watch`, the newest activity first); `failed` are workspaces whose read failed (the messages their earlier reads kept are still listed),
  // `missing` the scopes a token lacks (users:read, files:read, channels:write, groups:write among them), `refreshSecs` the wait until the next read, `pendingChannels` the channels no read has reached yet,
  // `unreadTotal` the unread messages among all those held and the unread replies (the Slack button's badge), `markableChannels` the channels "すべて既読にする" would move, `unreadThreads` the threads it would clear. Messages are kept in memory only.
  // With `cached` true nothing is asked of Slack: the list is made again from what Rust holds (after a channel was hidden or put back).
  slack_timeline: { args: { cached: boolean } | undefined; result: Timeline };
  // The channels kept off the Slack list, in the order they were hidden, with the channel's name (its ID when the name is not known). Slack itself is not told (its mute cannot be read).
  slack_hidden_list: { args: undefined; result: HiddenChannel[] };
  slack_hide_channel: { args: { teamId: string; channel: string }; result: boolean };
  slack_unhide_channel: { args: { teamId: string; channel: string }; result: boolean };
  // Sets the channel's read position to the message `ts` in Slack (`conversations.mark`), only when it is later than the one held; true when it was sent.
  slack_mark_read: { args: { teamId: string; channel: string; ts: string }; result: boolean };
  // Sets the read position of every channel with an unread message (among all those held) to its newest unread message; the channels kept off the list and the workspaces whose token cannot write it are left out. Every thread with unread replies is seen up to its newest (kept here, for every workspace).
  slack_mark_all_read: { args: undefined; result: MarkAll };
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
  // Posts `text` as a reply in the thread (the checks and the errors of `slack_post`; the recent destinations are not touched).
  slack_reply: { args: { teamId: string; channel: string; threadTs: string; text: string }; result: boolean };
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
  // Claude's answer to a request about the instructions in the edit field; `history` is the conversation before this request. Nothing is saved.
  claude_edit_todo_prompt: { args: { body: string; history: { role: "user" | "assistant"; text: string }[]; instruction: string }; result: PromptEdit };
  // Claude's proofreading of the text in the Slack compose screen's edit field: the same answer, for `text` instead of the instructions. Nothing is saved.
  claude_proofread_slack: { args: { text: string; history: { role: "user" | "assistant"; text: string }[]; instruction: string }; result: PromptEdit };
  // The conversation in the Slack thread detail (its own model and effort, `slackReply`): proofread the reply, summarise the thread, write a reply. `text` is the reply field's text (it may be empty),
  // and `thread` the open thread's messages as the screen shows them (none while it is not read), which are sent too, with `truncated` (the read stopped before the end of the thread).
  claude_chat_thread: { args: { text: string; thread: { name: string; ts: string; text: string }[]; truncated: boolean; history: { role: "user" | "assistant"; text: string }[]; instruction: string }; result: PromptEdit };
  // The agents that run in the Orca in use and its worktrees. Never rejects for a read that failed: `state` says "missing" (no orca command) or "failed" (with `message`).
  // `scope` "full" reads the saved environments and resolves the target (the saved one; with no file saved yet the first environment, else this machine; a saved environment that is gone, or a file that cannot be used while an environment is saved, is a failed read that picks nothing, with the environments listed so the owner can choose again),
  // "screen" reads the agents and their terminals of `target` (the one the screen holds), and "badge" only the agents, for the count (no terminals, so no handles). With "screen" and "badge", and when `environment list` itself failed, `known` is false and `target` and `environments` are not the answer: the screen keeps the ones it had.
  orca_overview: { args: { scope: "full" | "screen" | "badge"; target: string | null }; result: OrcaOverview };
  // Saves the target: a saved environment's name, or null for this machine.
  orca_set_target: { args: { environment: string | null }; result: null };
  // Sends `text` and Enter to the terminal `handle`; `environment` is the target the screen shows. Never run twice.
  orca_send: { args: { handle: string; text: string; environment: string | null }; result: null };
  // A-16: starts Claude in the worktree at `path` with no first prompt (the plus of the work pane). The answer is the session as Orca's reply names it (`paneKey` and `handle` are null when the reply lacks them). Never run twice.
  orca_start: { args: { path: string; environment: string | null }; result: OrcaStarted };
  // A-16: opens a plain terminal in the worktree at `path` (the plus of the work pane). The answer names its `handle` (`paneKey` is always null). Never run twice.
  orca_terminal_create: { args: { path: string; environment: string | null }; result: OrcaStarted };
  // A-9: starts a session in a worktree, or posts to a running one, with the instruction and, when `context` is not null, the content quoted as data after it. Never run twice.
  // For a running session the answer has only its `handle`.
  orca_handoff: { args: { destination: HandoffDestination; instruction: string; context: HandoffContext | null; environment: string | null }; result: OrcaStarted };
  // Reads the history of the session in the pane `paneKey` of the worktree `path` (A-7) and sends it to `channel` (an `OrcaChatEvent` at a time) until it is closed or another is opened; only one session is read.
  orca_chat_open: { args: { environment: string | null; path: string; paneKey: string; channel: unknown }; result: null };
  orca_chat_close: { args: undefined; result: null };
  // Reads the page of older messages of the session that is read; they arrive as an `items` event.
  orca_chat_older: { args: undefined; result: null };
  // Pauses (`true`, the window is hidden) or resumes the periodic reads of the session that is read; the connection and what is held stay.
  orca_chat_pause: { args: { paused: boolean }; result: null };
  // A-10: puts the image `data` (base64) in `.orca/drops/` of the worktree at `path` of the target `environment` and answers the text for Claude: the absolute path of the file, with a backslash before a blank or shell character. `name` only gives the file a name; PNG, JPEG, GIF and WebP up to 20 MiB, by the bytes. Not tried again: a failure carries its message.
  orca_attach_image: { args: { path: string; name: string; data: string; environment: string | null }; result: string };
  // Closes the tab of an Orca terminal (a Claude session or a plain terminal); `environment` is the target the screen shows. A terminal that is already closed is a success.
  orca_close: { args: { handle: string; environment: string | null }; result: null };
  // A-11: answers the questions of a Claude session that waits (the picks are 0-based indexes into `options`), by typing digits and Tab into its terminal `handle` one key at a time, each only when the screen shows what it is for. Not tried again: a failure carries its message.
  orca_answer: { args: { handle: string; questions: { text: string; multi: boolean; options: string[]; picks: number[] }[]; environment: string | null }; result: null };
  // The lines on the screen of the terminal `handle` of this machine (a Claude session's or a plain one), for the mirror (no colors).
  orca_terminal_read: { args: { handle: string }; result: string[] };
  // Types `text` into the terminal `handle` of this machine as it is (no Enter is added).
  orca_terminal_input: { args: { handle: string; text: string }; result: null };
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
  // A-17: the layout of the work pane of the project `project` of `environment` (null: this machine): the saved one, mended against the tabs the screen shows now (`tabs`), after `op` when there is one. Rust saves it.
  orca_panes: { args: { environment: string | null; project: string; tabs: string[]; handles: Record<string, string>; was: Record<string, string>; op: PaneOp | null }; result: PaneLayout };
  // A-18: the entries of the folder `dir` (relative to the worktree; "" is its own folder) of the worktree at `path` of the target `environment`: the folders first, each with whether git ignores it. Not tried again: a failure carries its message.
  orca_files_list: { args: { path: string; dir: string; ignored: boolean; environment: string | null }; result: OrcaDir };
  // A-18: the text of the file `relative` of the worktree, for the editor, with LF line ends (`crlf`: the file has CRLF) and the signature of what the disk holds. A binary file, one over 384 KiB and one that is not UTF-8 are errors.
  orca_file_read: { args: { path: string; relative: string; environment: string | null }; result: OrcaFileText };
  // A-18: saves `content` over the file only if the disk still holds the text with `signature` (`crlf`: write CRLF). `state` says whether it was written (`saved`, with the new signature) or the disk had changed (`changed`, `missing`, `not-utf8`: nothing written).
  orca_file_write: { args: { path: string; relative: string; content: string; crlf: boolean; signature: string; environment: string | null }; result: OrcaSaved };
  // A-18: the settings of the editor: how long after the typing stops the file is saved.
  editor_settings: { args: undefined; result: EditorSettings };
  // A-18: saves the time of the automatic save, brought into 100 to 3000 ms in steps of 100, and answers the settings saved.
  editor_settings_set: { args: { autosaveMs: number }; result: EditorSettings };
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
