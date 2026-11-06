// What every spec shares: booting the app with fixtures, mocking a command, and fixture data shaped like the Rust return values.
// The fixtures are typed by the types ts-rs writes from the Serialize structs (ts/bindings/), so a change of a struct's shape fails the type check here.
// Only example.com addresses and made-up names appear here: the repository is public.
import type { Channel } from "../ts/bindings/Channel";
import type { Checked } from "../ts/bindings/Checked";
import type { Claude } from "../ts/bindings/Claude";
import type { ClaudeConnection } from "../ts/bindings/ClaudeConnection";
import type { ClaudeSettings } from "../ts/bindings/ClaudeSettings";
import type { Comment } from "../ts/bindings/Comment";
import type { GhosttyImport } from "../ts/bindings/GhosttyImport";
import type { Inbox } from "../ts/bindings/Inbox";
import type { Info } from "../ts/bindings/Info";
import type { OrcaChatEvent } from "../ts/bindings/OrcaChatEvent";
import type { OrcaChatItem } from "../ts/bindings/OrcaChatItem";
import type { OrcaOverview } from "../ts/bindings/OrcaOverview";
import type { OrcaProject } from "../ts/bindings/OrcaProject";
import type { OrcaRow } from "../ts/bindings/OrcaRow";
import type { OrcaSshTarget } from "../ts/bindings/OrcaSshTarget";
import type { OrcaStatus } from "../ts/bindings/OrcaStatus";
import type { OrcaStreamEvent } from "../ts/bindings/OrcaStreamEvent";
import type { OrcaTermEvent } from "../ts/bindings/OrcaTermEvent";
import type { OrcaTerminal } from "../ts/bindings/OrcaTerminal";
import type { OrcaWorktree } from "../ts/bindings/OrcaWorktree";
import type { PromptEdit } from "../ts/bindings/PromptEdit";
import type { ResponseStatus } from "../ts/bindings/ResponseStatus";
import type { SlackLoad } from "../ts/bindings/SlackLoad";
import type { RichBlock } from "../ts/bindings/RichBlock";
import type { SlackThread } from "../ts/bindings/SlackThread";
import type { SocketState } from "../ts/bindings/SocketState";
import type { SocketStatus } from "../ts/bindings/SocketStatus";
import type { Span } from "../ts/bindings/Span";
import type { Summary } from "../ts/bindings/Summary";
import type { TaskItem } from "../ts/bindings/TaskItem";
import type { ThreadAttachment } from "../ts/bindings/ThreadAttachment";
import type { ThreadDetail } from "../ts/bindings/ThreadDetail";
import type { ThreadFile } from "../ts/bindings/ThreadFile";
import type { ThreadItem } from "../ts/bindings/ThreadItem";
import type { ThreadMessage } from "../ts/bindings/ThreadMessage";
import type { HiddenChannel } from "../ts/bindings/HiddenChannel";
import type { Timeline } from "../ts/bindings/Timeline";
import type { TimelineMessage } from "../ts/bindings/TimelineMessage";
import type { TimelineReply } from "../ts/bindings/TimelineReply";
import type { UnreadReplies } from "../ts/bindings/UnreadReplies";
import type { Todo } from "../ts/bindings/Todo";
import type { TodoPrompt } from "../ts/bindings/TodoPrompt";
import type { Week } from "../ts/bindings/Week";
import type { Workspace } from "../ts/bindings/Workspace";
import type { WorkspaceIcon } from "../ts/bindings/WorkspaceIcon";

declare global {
  interface Window {
    __e2e_once__(id: string): boolean;
  }
}

// When the result of `browser.execute` is lost, webdriver runs the same script again after the script timeout. The cause was found only for the script right after `refresh` (`boot`); CI also showed lost results of other commands.
// A script whose second run would change what the spec checks (a press, a key, a release) takes a fresh `onceId()` and returns at once when `window.__e2e_once__(id)` is false (e2e/fixtures.js).
// Any other script needs no id. An element's `.click()` can be run again the same way, and this guard does not cover it.
let onceCount = 0;
export const onceId = () => `once-${++onceCount}`;

// The app asks for its data while loading, before a spec can mock anything: hand it over through the fixture layer (e2e/fixtures.js) and reload.
// Mocks and recorded calls are page state, so a reload also clears them; call `mock` after `boot`.
export async function boot(fixtures: Record<string, unknown> = {}) {
  // `refresh` returns once the reload is issued, so the old document may still say "complete": mark it and wait for a page without the mark.
  await browser.execute((data) => {
    sessionStorage.setItem("e2e-fixtures", JSON.stringify(data));
    (window as unknown as { __e2e_old_page__: boolean }).__e2e_old_page__ = true;
  }, fixtures);
  await browser.refresh();
  // A script sent about 1 ms after `refresh` lost its result in 5 of 5 stalls in the local logs; with this pause, 15 local runs had none. Polling cannot replace it, because a poll is such a script.
  await browser.pause(200);
  await browser.waitUntil(
    () => browser.execute(() => document.readyState === "complete" && !(window as unknown as { __e2e_old_page__?: boolean }).__e2e_old_page__),
    { timeoutMsg: "page did not load" },
  );
}

// Answers `command` with `value` from now on and forgets its earlier calls. Returns `command`, the handle `callsOf` and `waitForCalls` take.
// The mock lives in the page (window.__e2e_mocks__, e2e/fixtures.js), so a reload clears it.
export async function mock(command: string, value: unknown = null) {
  await browser.execute(
    (c, v) => {
      const w = window as unknown as { __e2e_mocks__: Record<string, unknown>; __e2e_calls__: Record<string, unknown[]> };
      w.__e2e_mocks__[c] = v;
      w.__e2e_calls__[c] = [];
    },
    command,
    value,
  );
  return command;
}

// A `mock` value that makes the command fail with `message` (e2e/fixtures.js).
export const rejects = (message: string) => ({ __e2e_reject__: message });

// A `mock` value that keeps the command waiting until `release` (e2e/fixtures.js).
export const holds = { __e2e_hold__: true };

// Answers the oldest waiting call of `command` with `value`. Wait for the call first (`waitForCalls`).
export const release = (command: string, value: unknown) =>
  browser.execute(
    (id, c, v) => {
      if (!window.__e2e_once__(id)) return;
      (window as unknown as { __e2e_release__: Record<string, ((v: unknown) => void)[]> }).__e2e_release__[c].shift()!(v);
    },
    onceId(),
    command,
    value,
  );

// The arguments of every call of `command` so far.
export const callsOf = (command: string) =>
  browser.execute((c) => (window as unknown as { __e2e_calls__: Record<string, unknown[]> }).__e2e_calls__[c] ?? [], command);

// Waits until `command` was called `times` times, then returns the arguments of the calls.
export async function waitForCalls(command: string, times = 1) {
  await browser.waitUntil(async () => (await callsOf(command)).length >= times, { timeoutMsg: `${command} was not called ${times} time(s)` });
  return callsOf(command);
}

// `$$(selector).length` is typed as a promise; counting in the page is plain.
export const count = (selector: string) => browser.execute((s) => document.querySelectorAll(s).length, selector);

// The text of every element matching `selector`, hidden ones included (`getText` is empty for an element that is not displayed).
export const textsOf = (selector: string) =>
  browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.textContent?.trim() ?? ""), selector);

export const waitForText = (selector: string, text: string) =>
  browser.waitUntil(async () => (await textsOf(selector)).some((t) => t.includes(text)), { timeoutMsg: `${selector} never showed "${text}"` });

export const waitForCount = (selector: string, n: number) =>
  browser.waitUntil(async () => (await count(selector)) === n, { timeoutMsg: `expected ${n} of ${selector}` });

// Replaces navigator.clipboard.writeText with a function that keeps the text in the page, so a spec never touches the real clipboard. A reload undoes it.
export const stubClipboard = () =>
  browser.execute(() => {
    const w = window as unknown as { __e2e_copied__: string[] };
    w.__e2e_copied__ = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void w.__e2e_copied__.push(t) } });
  });

// The texts written to the stubbed clipboard so far.
export const copiedTexts = () => browser.execute(() => (window as unknown as { __e2e_copied__: string[] }).__e2e_copied__);

// Cmd+Z (Ctrl+Z off macOS), sent to the page as the key event the app listens for.
export const pressUndo = () =>
  browser.execute((id) => {
    if (!window.__e2e_once__(id)) return;
    const mac = /Mac/.test(navigator.platform);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: mac, ctrlKey: !mac, bubbles: true }));
  }, onceId());

// The row of the thread with `subject` in the unread or read list.
export const rowOf = (list: "unread-threads" | "read-threads", subject: string) =>
  $(`//ul[@id="${list}"]/li[contains(., "${subject}")]`);

const pad = (n: number) => String(n).padStart(2, "0");
// Local "YYYY-MM-DD", as the app's isoDate.
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = isoDate(new Date());

// ---- Gmail ----

export const account = "me@example.com";

export const thread = (id: string, subject: string, unread: boolean): ThreadItem => ({
  id,
  account,
  from: "Alice <alice@example.com>",
  subject,
  snippet: `${subject} snippet`,
  dateMs: Date.now() - 60_000,
  unread,
});

export const inbox = (threads = [thread("t1", "First unread", true), thread("t2", "Second unread", true), thread("t3", "Already read", false)]): Inbox => ({
  accounts: [account],
  threads,
  needsLogin: [],
  failed: {},
  historyIds: { [account]: "100" },
});

// A thread of one plain-text message.
export const threadDetail = (subject: string, body: string, unread: boolean): ThreadDetail => ({
  subject,
  unread,
  messages: [
    { id: "m1", from: "Alice <alice@example.com>", to: account, dateMs: Date.now() - 60_000, snippet: body, html: false, body, authenticated: false },
  ],
});

// ---- Calendar ----

// The week holding today, starting on `firstDay` (0 = Sunday): all today.
// "Team sync" 10:00-11:00 has every detail (a Meet link, a place, a description with a link, 6 people of whom 4 accepted) and was accepted.
// "Maybe lunch" 12:00-13:00 is tentative and "Unanswered" 14:00-15:00 is unanswered; both have no detail. "Holiday" is an all-day event with no detail.
export const meetUrl = "https://meet.google.com/abc-defg-hij";
export function weekOfToday(firstDay = 0): Week {
  const now = new Date();
  const day = (now.getDay() + 7 - firstDay) % 7;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  const info = (summary: string, whenText: string, response: ResponseStatus = "unknown", detail: Partial<Info> = {}): Info => ({
    summary,
    color: null,
    account,
    response,
    calendar: "Work",
    whenText,
    meetUrl: null,
    location: null,
    description: null,
    attendees: 0,
    accepted: 0,
    ...detail,
  });
  const detail: Partial<Info> = {
    meetUrl,
    location: "Room B",
    description: "Review the plan.\nDocs: https://example.com/plan",
    attendees: 6,
    accepted: 4,
  };
  return {
    weekStart: isoDate(start),
    allDay: [{ day, ...info("Holiday", "11月3日（火）終日", "unknown", { calendar: "Holidays" }) }],
    timed: [
      { day, startMin: 600, endMin: 660, col: 0, cols: 1, ...info("Team sync", "11月2日（月）10:00 - 11:00", "accepted", detail) },
      { day, startMin: 720, endMin: 780, col: 0, cols: 1, ...info("Maybe lunch", "11月2日（月）12:00 - 13:00", "tentative") },
      { day, startMin: 840, endMin: 900, col: 0, cols: 1, ...info("Unanswered", "11月2日（月）14:00 - 15:00", "needsAction") },
    ],
    needsLogin: [],
    failed: {},
    calendarFailed: [],
  };
}

// ---- Todoist ----

// The epoch milliseconds of `time` (`HH:MM`, midnight by default) `day` days from today, in local time: a due moment as the app counts it.
export const moment = (day: number, time = "00:00") => {
  const [h, m] = time.split(":").map(Number);
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, h, m).getTime();
};

// The local `YYYY-MM-DD` of `n` days from today.
const dayFromToday = (n: number) => isoDate(new Date(moment(n)));

// A task with a due date that fits its bucket: yesterday, today or tomorrow, no time.
export const task = (id: string, content: string, projectId: string, bucket: "overdue" | "today" | "upcoming" | "none"): TaskItem => ({
  id,
  content,
  description: "",
  projectId,
  priority: 4,
  due: bucket === "none" ? null : { date: dayFromToday({ overdue: -1, today: 0, upcoming: 1 }[bucket]), time: null, string: bucket, recurring: false },
  bucket,
  subtasks: [],
  subDone: 0,
  subTotal: 0,
  mail: null,
  parent: null,
  url: `https://app.todoist.com/app/task/${id}`,
  labels: [],
});

// Makes the page's clock read `at` (a local `YYYY-MM-DDTHH:MM:SS`) from now on, and keep running from there; another call sets it again.
// The page's `Date` is replaced for `new Date()` and `Date.now()` only: the app is not told, so it notices the new time at its next count.
export const setClock = (at: string) =>
  browser.execute((time) => {
    const w = window as unknown as { __e2e_real_date__?: DateConstructor; __e2e_offset__: number; Date: DateConstructor };
    w.__e2e_real_date__ ??= w.Date;
    const Real = w.__e2e_real_date__;
    w.__e2e_offset__ = new Real(time).getTime() - Real.now();
    if (w.Date === Real)
      w.Date = new Proxy(Real, {
        construct: (target, args) => (args.length === 0 ? new target(Real.now() + w.__e2e_offset__) : new target(...(args as [number]))),
        get: (target, prop) => (prop === "now" ? () => Real.now() + w.__e2e_offset__ : Reflect.get(target, prop)),
      });
  }, at);

// The task `t` due today at `time` (`HH:MM`), or with no time.
export const dueToday = (t: TaskItem, time: string | null): TaskItem => ({ ...t, bucket: "today", due: { date: today, time, string: "today", recurring: false } });

// The task `t` as a row under `parent`, and as an entry of the parent's subtask list.
const under = (parent: TaskItem, t: TaskItem): TaskItem => {
  parent.subtasks.push({ id: t.id, content: t.content, done: false, due: t.due });
  parent.subTotal++;
  return { ...t, parent: { id: parent.id, content: parent.content } };
};

// Work holds Design, which holds Sketch; Home is at the top. "Plan trip" has the subtask "Book flights", which has "Pick seat".
export const todoData = (): Todo => {
  const trip = task("k2", "Plan trip", "p1", "none");
  const flights = under(trip, task("k3", "Book flights", "p1", "none"));
  const seat = under(flights, task("k4", "Pick seat", "p1", "none"));
  return {
    projects: [
      { id: "p0", name: "Inbox", color: "#808080", inbox: true, parentId: null, depth: 0 },
      { id: "p1", name: "Work", color: "#1e7b52", inbox: false, parentId: null, depth: 0 },
      { id: "p2", name: "Design", color: "#246fe0", inbox: false, parentId: "p1", depth: 1 },
      { id: "p3", name: "Sketch", color: "#eb8909", inbox: false, parentId: "p2", depth: 2 },
      { id: "p4", name: "Home", color: "#d1453b", inbox: false, parentId: null, depth: 0 },
    ],
    labels: [
      { name: "Errand", color: "#42A393" },
      { name: "Urgent", color: "#B8255F" },
    ],
    tasks: [task("k1", "Write report", "p1", "today"), trip, flights, seat],
  };
};

// A comment of Todoist: `posted` is a local `{date, time}` as Rust answers it.
export const comment = (id: string, author: string, content: string, posted: Comment["posted"] = { date: "2000-01-02", time: "08:20" }, attachment: Comment["attachment"] = null): Comment => ({
  id,
  author,
  posted,
  content,
  attachment,
});

// Picks a file for the comment field the way the file panel does: the file goes into the hidden input and `change` follows. The panel itself is never opened.
// `size` makes the file report that size without holding that many bytes.
export const pickFile = (name: string, content: string, size?: number) =>
  browser.execute(
    (id, n, c, sz) => {
      if (!window.__e2e_once__(id)) return;
      const file = new File([c], n, { type: "text/plain" });
      if (sz !== undefined) Object.defineProperty(file, "size", { value: sz });
      const data = new DataTransfer();
      data.items.add(file);
      const input = document.getElementById("comment-file") as HTMLInputElement;
      input.files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    onceId(),
    name,
    content,
    size,
  );

// ---- Slack and Claude ----

export const workspace: Workspace = { teamId: "T1", team: "Example Team", user: "alice", url: "https://example-team.slack.com/" };
export const slackLoad: SlackLoad = { workspaces: [workspace], recent: [] };
// A connection of Socket Mode (S-16) as `slack_socket_status` answers it; the workspace is `workspace`.
export const socketStatus = (state: SocketState, teamId = workspace.teamId): SocketStatus => ({ teamId, state });

// Sends the event Rust sends (`emit`) to the page, as Socket Mode's tasks do: `slack-timeline-dirty`, `slack-socket-resync` and `slack-socket-status` (a `SocketStatus`).
export const emitEvent = (name: string, payload: unknown = null) =>
  browser.execute(
    (id, n, p) => {
      if (!window.__e2e_once__(id)) return;
      (window as unknown as { __TAURI__: { event: { emit(event: string, payload: unknown): Promise<void> } } }).__TAURI__.event.emit(n, p);
    },
    onceId(),
    name,
    payload,
  );

export const slackMessageUrl = "https://example-team.slack.com/archives/C0123ABCD/p1700000000123456";

// What `todoist_summarize_slack` answers for `slackMessageUrl`.
export const slackSummary: Summary = { content: "Reply to the vendor", description: "- Asked for a quote\n- Wants an answer by Friday", due: "2026-11-06", projectId: null, omitted: 0, targetCut: false };

// What `claude_model_settings` answers (the same as the base answer in e2e/fixtures.js): the defaults, Sonnet and medium, and Sonnet and high for the Slack reply.
export const claudeSettings: ClaudeSettings = {
  slackSummary: { model: "sonnet", effort: "medium" },
  mailSummary: { model: "sonnet", effort: "medium" },
  promptChat: { model: "sonnet", effort: "medium" },
  proofread: { model: "sonnet", effort: "medium" },
  slackReply: { model: "sonnet", effort: "high" },
};

// What `claude_todo_prompt` answers (the same as the base answer in e2e/fixtures.js): the default instructions, not edited.
export const todoPrompt: TodoPrompt = { body: "Default body", defaultBody: "Default body", fixed: "Fixed part\nToday is {today}.\n{projects}", fixedAfter: "Fixed tail", edited: false };

// What `claude_edit_todo_prompt` answers when Claude proposes changing the line "Default body" to "Better body".
export const promptEdit: PromptEdit = {
  reply: "1行目を変えます",
  body: "Better body",
  diff: [
    { kind: "del", text: "Default body" },
    { kind: "ins", text: "Better body" },
  ],
};

// What `slack_preview` answers for the thread of `threadDetail("First unread", "Hello from Alice", …)`: the post as it starts out in the compose screen.
export const slackPreview = "*First unread*\nAlice <alice@example.com> ・ 2026/11/3 9:00\n\nHello from Alice";

// What `claude_proofread_slack` answers when Claude proposes adding a full stop to the last line of `slackPreview`.
export const proofreadEdit: PromptEdit = {
  reply: "文末に句点を付けました",
  body: `${slackPreview}。`,
  diff: [
    { kind: "del", text: "Hello from Alice" },
    { kind: "ins", text: "Hello from Alice。" },
  ],
};

// What `slack_channels` answers: the channels of the workspace `workspace`.
export const slackChannels: Channel[] = [{ id: "C0123ABCD", name: "general" }];

// What `slack_check` answers; `missingScopes` null means Slack sent no scopes to judge by. `missingOptional` is the same for users:read, files:read, channels:write and groups:write.
export const checked = (missingScopes: string[] | null, missingOptional: string[] | null = []): Checked => ({ ...workspace, missingScopes, missingOptional });

// A Slack timestamp `minutes` minutes ago ("1700000000.000100"); `n` tells apart messages of the same minute.
export const slackTs = (minutes: number, n = 0) => `${Math.floor(Date.now() / 1000) - minutes * 60}.${String(100 + n).padStart(6, "0")}`;

// The permalink of the message with `ts` in the channel `C0123ABCD` of `workspace`.
export const permalinkOf = (ts: string) => `${workspace.url}archives/C0123ABCD/p${ts.replace(".", "")}`;

// A message of the Slack list (`slack_timeline`), by `name` in `#channelName`; `extra` overrides any field.
export const timelineMessage = (ts: string, name: string, channelName: string, text: string, extra: Partial<TimelineMessage> = {}): TimelineMessage => ({
  teamId: workspace.teamId,
  team: workspace.team,
  workspaceUrl: workspace.url,
  channel: "C0123ABCD",
  channelName,
  ts,
  threadTs: null,
  user: "U1",
  name,
  iconUrl: null,
  text,
  rich: plain(text),
  blocks: [],
  showText: true,
  attachments: [],
  replyCount: 0,
  permalink: permalinkOf(ts),
  hasFiles: false,
  unread: false,
  watch: null,
  unreadReplies: null,
  ...extra,
});

// An unread reply under a row of the Slack list (S-14); its `rich` is its text with no style unless `extra` sets it.
export const timelineReply = (ts: string, name: string, text: string, extra: Partial<TimelineReply> = {}): TimelineReply => ({ ts, name, iconUrl: null, text, rich: plain(text), blocks: [], showText: true, attachments: [], hasFiles: false, ...extra });

// What a row's thread has unread (`TimelineMessage.unreadReplies`): the replies given, counted, the last one the newest, unless `extra` says another.
export const unreadRepliesOf = (replies: TimelineReply[], extra: Partial<UnreadReplies> = {}): UnreadReplies => ({ count: replies.length, uncounted: false, latestTs: replies[replies.length - 1]?.ts ?? "", replies, ...extra });

// A row of the watch section (`Timeline.watched`): the thread's own message, with `newReplies` new replies (and `status`, "ok" unless `extra` says another).
// `unreadTo` (the message opening the row moves the read position to) is the message itself when it is unread, unless `extra.watch` says another.
export const watchedMessage = (ts: string, name: string, channelName: string, text: string, newReplies = 0, extra: Partial<TimelineMessage> = {}): TimelineMessage => {
  const message = timelineMessage(ts, name, channelName, text, extra);
  return { ...message, watch: extra.watch ?? { newReplies, uncounted: false, status: "ok", unreadTo: message.unread ? message.ts : null } };
};

// What `slack_timeline` answers; `unreadTotal` is the number of unread messages and unread replies given unless `extra` says another (it counts the messages held, not only the ones listed),
// `markableChannels` the channels of the unread messages given, `unreadThreads` the rows with unread replies. `watched` is empty unless `extra` gives it.
export const timeline = (messages: TimelineMessage[], extra: Partial<Timeline> = {}): Timeline => ({
  messages,
  watched: [],
  failed: [],
  missing: [],
  refreshSecs: 120,
  pendingChannels: 0,
  unreadTotal: messages.filter((m) => m.unread).length + messages.reduce((n, m) => n + (m.unreadReplies ? (m.unreadReplies.uncounted ? 1 : m.unreadReplies.count) : 0), 0),
  markableChannels: new Set(messages.filter((m) => m.unread).map((m) => `${m.teamId}/${m.channel}`)).size,
  unreadThreads: messages.filter((m) => m.unreadReplies).length,
  ...extra,
});

// A channel kept off the Slack list (`slack_hidden_list`); `name` is the channel's ID when its name is not known.
export const hiddenChannel = (channel: string, name: string, extra: Partial<HiddenChannel> = {}): HiddenChannel => ({ teamId: workspace.teamId, team: workspace.team, channel, name, ...extra });

// A Slack text read for its styles (S-12): `plain` is a text with no style, `span` a run (`style` holds b, i, s and c for bold, italic, strike and code), `para` and `quote` hold spans.
export const span = (text: string, style = ""): Span => ({ text, bold: style.includes("b"), italic: style.includes("i"), strike: style.includes("s"), code: style.includes("c") });
export const para = (...spans: Span[]): RichBlock => ({ type: "paragraph", spans });
export const quote = (...spans: Span[]): RichBlock => ({ type: "quote", spans });
export const plain = (text: string): RichBlock[] => [para(span(text))];

// A message of a thread (`slack_thread`); its `rich` is its text with no style unless `extra` sets it.
export const threadMessage = (ts: string, name: string, text: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ ts, user: "U1", name, iconUrl: null, text, rich: plain(text), files: [], blocks: [], showText: true, attachments: [], imageUrls: [], ...extra });

// An attachment of a thread's message (S-11) with nothing in it; `extra` sets the parts.
export const attachment = (extra: Partial<ThreadAttachment> = {}): ThreadAttachment => ({
  color: null, pretext: null, authorName: null, title: null, titleLink: null, text: null, fields: [], footer: null, actions: [], blocks: [], image: null, thumb: null, fallback: null, ...extra,
});

// An attached file; an image has a thumbnail URL on files.slack.com.
export const slackFile = (id: string, name: string, extra: Partial<ThreadFile> = {}): ThreadFile => ({ id, name, mimetype: "image/png", thumbUrl: null, permalink: `https://example-team.slack.com/files/U1/${id}/${name}`, ...extra });
export const thumbUrlOf = (id: string) => `https://files.slack.com/files-tmb/T1-${id}/thumb_360.png`;

// What `slack_thread` answers: the thread that starts at the first message.
export const slackThread = (messages: ThreadMessage[]): SlackThread => ({ teamId: workspace.teamId, channel: "C0123ABCD", ts: messages[0].ts, messages, truncated: false });

// What `slack_icons` answers: the user's own icon in `workspace`.
export const ownIcon = (iconUrl: string | null): WorkspaceIcon[] => [{ teamId: workspace.teamId, name: workspace.user, iconUrl }];

// A 1x1 transparent PNG as a data: URI, what `fetch_images` and `slack_file_images` answer for an image.
export const pngUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// What `claude_chat_thread` answers when Claude proposes changing the reply `before` to `after`.
export const replyEdit = (before: string, after: string): PromptEdit => ({
  reply: "言い回しを直しました",
  body: after,
  diff: [
    { kind: "del", text: before },
    { kind: "ins", text: after },
  ],
});

export const claudeReady: Claude = { state: "ready", email: "claude@example.com", plan: "Max", version: "2.0.0", method: "subscription" };
export const claudeLoggedOut: Claude = { state: "loggedOut", version: "2.0.0" };
export const claudeMissing: Claude = { state: "missing" };
// The usable state with an API key in use: no email and no plan.
export const claudeKeyReady: Claude = { state: "ready", email: "", plan: "", version: "2.0.0", method: "apiKey" };

// What `claude_connection` answers: the method in use, the subscription's state and the API key's state, and the usable state (`claude`; by default the subscription's own, or the key ready when the key is in use).
export const connection = (
  method: ClaudeConnection["method"],
  subscription: Claude,
  apiKey: ClaudeConnection["apiKey"],
  claude: Claude = method === "apiKey" ? claudeKeyReady : subscription,
): ClaudeConnection => ({ method, subscription, apiKey, claude });

// The Orca screen (A-6, A-8, A-12). `minutes` is how long ago the state began (the time of a running or waiting agent) or the agent ended (a done one). The row's icon follows its group unless `extra` says another status, and its project is `proj_{repo}`.
const GROUP_STATUS: Record<OrcaRow["group"], OrcaStatus> = { waiting: "question", working: "working", done: "done" };
export const orcaRow = (repo: string, branch: string, line: string, extra: Partial<OrcaRow> & { minutes?: number } = {}): OrcaRow => {
  const { minutes = 2, ...rest } = extra;
  const group = rest.group ?? "working";
  return { group, repo, branch, line, atMs: Date.now() - minutes * 60_000 - 5_000, handle: `term_${repo}`, paneKey: `tab_${repo}:leaf_1`, path: `/work/${repo}`, activity: "", status: GROUP_STATUS[group], projectKey: `proj_${repo}`, ...rest };
};

export const orcaWorktree = (repo: string, branch: string): OrcaWorktree => ({ path: `/work/${repo}`, repo, branch });

// A plain terminal of Orca (a shell) in the project of `repo`.
export const orcaTerminal = (repo: string, title: string, extra: Partial<OrcaTerminal> = {}): OrcaTerminal => ({ handle: `term_${repo}_${title}`, title, branch: "main", projectKey: `proj_${repo}`, ...extra });
export const orcaSsh = (id: string, label: string): OrcaSshTarget => ({ id, label });

const STATUS_ORDER: OrcaStatus[] = ["question", "failed", "working", "monitoring", "interrupted", "done", "idle"];

// The project list of what is on the screen: one project for each repository of the rows, the worktrees and the terminals, the highest status of its rows (a terminal is a green dot), and its sessions.
function projectsOf(rows: OrcaRow[], worktrees: OrcaWorktree[], terminals: OrcaTerminal[]): OrcaProject[] {
  const keys = [...new Set([...rows.map((r) => r.projectKey), ...worktrees.map((w) => `proj_${w.repo}`), ...terminals.map((t) => t.projectKey)])];
  return keys.map((key) => {
    const mine = rows.filter((r) => r.projectKey === key);
    const mineTerminals = terminals.filter((t) => t.projectKey === key);
    const statuses: OrcaStatus[] = [...mine.map((r) => r.status), ...mineTerminals.map((): OrcaStatus => "done"), "idle"];
    return { key, name: key.replace(/^proj_/, ""), status: statuses.sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))[0], sessions: mine.length + mineTerminals.length, atMs: 0 };
  });
}

// What `orca_overview` answers: a read that worked, this machine's, unless `extra` says another.
export const orcaOverview = (rows: OrcaRow[], worktrees: OrcaWorktree[] = [], extra: Partial<OrcaOverview> = {}): OrcaOverview => ({
  state: "ready",
  message: "",
  target: null,
  environments: [],
  rows,
  worktrees,
  projects: projectsOf(rows, worktrees, extra.terminals ?? []),
  hosts: [],
  terminals: [],
  ssh: [],
  known: true,
  ...extra,
});

// A-12: the list a saved environment streams, as `orca_stream_open`'s channel gets it.
export const streamList = (rows: OrcaRow[], worktrees: OrcaWorktree[] = [], terminals: OrcaTerminal[] = []): OrcaStreamEvent => ({
  kind: "list",
  rows,
  worktrees,
  projects: projectsOf(rows, worktrees, terminals),
  hosts: [],
  terminals,
});

// A-13: what `ghostty_import` and `ghostty_saved` answer: an import of nothing (one config file read), with the given parts.
export const ghosttyImport = (parts: Partial<GhosttyImport> = {}): GhosttyImport => ({
  settings: { fontFamilies: [], fontSize: null, fontThicken: false, light: null, dark: null, keybinds: [] },
  imported: [],
  skipped: [],
  files: ["~/.config/ghostty/config"],
  ...parts,
});

// Gives `event` to the channel of the last call of `command` (or the `nth`, counting from 0), as Rust does.
const deliver = (command: string, event: unknown, nth: number) =>
  browser.execute(
    (id, c, e, n) => {
      if (!window.__e2e_once__(id)) return;
      const calls = (window as unknown as { __e2e_calls__: Record<string, { channel: { onmessage: (event: unknown) => void } }[]> }).__e2e_calls__[c];
      calls.at(n)!.channel.onmessage(e);
    },
    onceId(),
    command,
    event,
    nth,
  );

// A-12: an event of the stream of the list (`orca_stream_open`), and of the terminal shown (`orca_stream_terminal`).
export const sendStream = (event: OrcaStreamEvent, nth = -1) => deliver("orca_stream_open", event, nth);
export const sendTerm = (event: OrcaTermEvent, nth = -1) => deliver("orca_stream_terminal", event, nth);

// The session history (A-7): the items the screen draws, and the delivery of an event to the channel the screen gave `orca_chat_open` (the last one, or the `nth` counting from 0).
export const chatUser = (id: string, text: string, context: Extract<OrcaChatItem, { kind: "user" }>["context"] = null): OrcaChatItem => ({ kind: "user", id, text, context });
export const chatAssistant = (id: string, text: string): OrcaChatItem => ({ kind: "assistant", id, text });
export const chatTools = (id: string, summary: string, calls: [string, string][], runningSummary: string | null = null): OrcaChatItem => ({
  kind: "tools",
  id,
  summary,
  runningSummary,
  calls: calls.map(([name, detail]) => ({ name, detail })),
});
export const chatQuestion = (id: string, answer: string | null, waiting: boolean, multi = false): OrcaChatItem => ({
  kind: "question",
  id,
  questions: [{ text: "Which one?", options: [{ label: "First", description: "the first way" }, { label: "Second", description: "" }], multi, answer }],
  waiting,
});
// A question with several parts (A-11): each is `[text, multi, labels]`, without an answer.
export const chatQuestions = (id: string, waiting: boolean, parts: [string, boolean, string[]][]): OrcaChatItem => ({
  kind: "question",
  id,
  questions: parts.map(([text, multi, labels]) => ({ text, multi, options: labels.map((label) => ({ label, description: "" })), answer: null })),
  waiting,
});
export const chatItems = (items: OrcaChatItem[], start = 0, hasMore = false): OrcaChatEvent => ({ kind: "items", start, items, hasMore });
export const chatStatus = (state: "connecting" | "live" | "reconnecting" | "unavailable", message = ""): OrcaChatEvent => ({ kind: "status", state, message });

// The arguments of every `orca_chat_open` so far, with the channel (an object that cannot cross the driver) as `true`.
export const chatOpens = () =>
  browser.execute(() => {
    const calls = (window as unknown as { __e2e_calls__: Record<string, { environment: string | null; path: string; paneKey: string; channel?: unknown }[]> }).__e2e_calls__.orca_chat_open ?? [];
    return calls.map((c) => ({ ...c, channel: !!c.channel }));
  });

export const sendChat = (event: OrcaChatEvent, nth = -1) => deliver("orca_chat_open", event, nth);

// Waits until `orca_chat_open` was called `times` times; the calls are read with `chatOpens`.
export async function waitForOpens(times = 1) {
  await browser.waitUntil(async () => (await chatOpens()).length >= times, { timeoutMsg: `orca_chat_open was not called ${times} time(s)` });
  return chatOpens();
}
