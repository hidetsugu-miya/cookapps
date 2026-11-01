// The commands of src-tauri (`invoke_handler`): each one's arguments and answer. The data types are ts-rs's (bindings/).
// A command with no arguments is called as `invoke("inbox")`. An answer of `null` is what a Rust `()` or `None` becomes.
import type { AppInfo } from "./bindings/AppInfo";
import type { Channel } from "./bindings/Channel";
import type { Checked } from "./bindings/Checked";
import type { Claude } from "./bindings/Claude";
import type { Inbox } from "./bindings/Inbox";
import type { PendingImage } from "./bindings/PendingImage";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { Summary } from "./bindings/Summary";
import type { Sync } from "./bindings/Sync";
import type { Target } from "./bindings/Target";
import type { ThreadDetail } from "./bindings/ThreadDetail";
import type { Todo } from "./bindings/Todo";
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
  calendar_week: { args: { date: string; refresh: boolean }; result: Week };
  calendar_cached: { args: undefined; result: Week[] };
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
  forget_image_sender: { args: { from: string }; result: null };
  // null: a token is needed.
  todoist_load: { args: { withDone: boolean }; result: Todo | null };
  todoist_cached: { args: undefined; result: Todo | null };
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
  todoist_delete: { args: { id: string }; result: boolean | null };
  todoist_open: { args: { id: string }; result: null };
  slack_load: { args: undefined; result: SlackLoad };
  slack_check: { args: { teamId: string }; result: Checked };
  slack_add_workspace: { args: { token: string }; result: Workspace[] };
  slack_remove_workspace: { args: { teamId: string }; result: Workspace[] };
  slack_channels: { args: { teamId: string; refresh: boolean }; result: Channel[] };
  slack_link: { args: { url: string }; result: Target };
  slack_preview: { args: Mail; result: string };
  slack_post: {
    args: Mail & { teamId: string; channel: string; threadTs: string | null; name: string; note: string };
    result: boolean;
  };
  claude_status: { args: undefined; result: Claude };
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
