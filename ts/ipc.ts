// The commands of src-tauri (`invoke_handler`): each one's arguments and answer. The data types are ts-rs's (bindings/).
// A command with no arguments is called as `invoke("inbox")`. An answer of `null` is what a Rust `()` or `None` becomes.
import type { AppInfo } from "./bindings/AppInfo";
import type { Channel } from "./bindings/Channel";
import type { Checked } from "./bindings/Checked";
import type { Claude } from "./bindings/Claude";
import type { ClaudeConnection } from "./bindings/ClaudeConnection";
import type { Effort } from "./bindings/Effort";
import type { Inbox } from "./bindings/Inbox";
import type { MailSummary } from "./bindings/MailSummary";
import type { Method } from "./bindings/Method";
import type { Model } from "./bindings/Model";
import type { ClaudeSettings } from "./bindings/ClaudeSettings";
import type { PendingImage } from "./bindings/PendingImage";
import type { PromptEdit } from "./bindings/PromptEdit";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { Summary } from "./bindings/Summary";
import type { Sync } from "./bindings/Sync";
import type { Target } from "./bindings/Target";
import type { ThreadDetail } from "./bindings/ThreadDetail";
import type { Todo } from "./bindings/Todo";
import type { TodoPrompt } from "./bindings/TodoPrompt";
import type { UpdateInfo } from "./bindings/UpdateInfo";
import type { UpdateMode } from "./bindings/UpdateMode";
import type { Week } from "./bindings/Week";
import type { Workspace } from "./bindings/Workspace";

type Account = { account: string };
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
    args: { id: string; content?: string; description?: string; dueString?: string };
    result: boolean | null;
  };
  todoist_move: { args: { id: string; projectId: string }; result: boolean | null };
  todoist_move_under: { args: { id: string; parentId: string }; result: boolean | null };
  todoist_delete: { args: { id: string }; result: boolean | null };
  todoist_open: { args: { id: string }; result: null };
  slack_load: { args: undefined; result: SlackLoad };
  slack_check: { args: { teamId: string }; result: Checked };
  slack_add_workspace: { args: { token: string }; result: Workspace[] };
  slack_remove_workspace: { args: { teamId: string }; result: Workspace[] };
  slack_channels: { args: { teamId: string; refresh: boolean }; result: Channel[] };
  slack_link: { args: { url: string }; result: Target };
  // What a post of the mail starts out as (plain text); the user edits it on the compose screen.
  slack_preview: { args: Mail; result: string };
  // Posts `text` as it is (Rust escapes it for Slack and refuses a blank one or one past 10,000 characters).
  slack_post: {
    args: { teamId: string; channel: string; threadTs: string | null; name: string; text: string };
    result: boolean;
  };
  // Whether Claude can be used with the method in use (the subscription logged in, or an API key that is not refused).
  claude_status: { args: undefined; result: Claude };
  // The settings card's view: the method in use, and the subscription's and the API key's own states.
  claude_connection: { args: undefined; result: ClaudeConnection };
  // Checks the key at Anthropic and, only if it works, stores it, makes it the method and logs Claude Code out (an error says when the logout did not hold). null: done.
  claude_key_save: { args: { key: string }; result: null };
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
  app_info: { args: undefined; result: AppInfo };
  update_mode: { args: undefined; result: UpdateMode };
  set_update_mode: { args: { mode: UpdateMode }; result: null };
  // null: this is the latest version. install_update only replaces the app (UpdateInfo.installed afterwards); restart_app restarts it.
  check_update: { args: undefined; result: UpdateInfo | null };
  install_update: { args: undefined; result: null };
  restart_app: { args: undefined; result: null };
  set_badge: { args: { count: number }; result: null };
}

export type ArgsOf<C extends keyof Commands> = Commands[C]["args"] extends undefined ? [] : [Commands[C]["args"]];

// Read once, as the app always did: the E2E build replaces `core` with a wrapper before this module runs (e2e/fixtures.js).
const { invoke: tauriInvoke } = window.__TAURI__.core;

export function invoke<C extends keyof Commands>(command: C, ...args: ArgsOf<C>): Promise<Commands[C]["result"]> {
  return tauriInvoke(command, args[0]) as Promise<Commands[C]["result"]>;
}
