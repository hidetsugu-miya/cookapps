// What every spec shares: booting the app with fixtures, mocking a command, and fixture data shaped like the Rust return values.
// The fixtures are typed by the types ts-rs writes from the Serialize structs (ts/bindings/), so a change of a struct's shape fails the type check here.
// Only example.com addresses and made-up names appear here: the repository is public.
import type { Channel } from "../ts/bindings/Channel";
import type { Checked } from "../ts/bindings/Checked";
import type { Claude } from "../ts/bindings/Claude";
import type { ClaudeSettings } from "../ts/bindings/ClaudeSettings";
import type { Inbox } from "../ts/bindings/Inbox";
import type { Info } from "../ts/bindings/Info";
import type { PromptEdit } from "../ts/bindings/PromptEdit";
import type { ResponseStatus } from "../ts/bindings/ResponseStatus";
import type { SlackLoad } from "../ts/bindings/SlackLoad";
import type { Summary } from "../ts/bindings/Summary";
import type { TaskItem } from "../ts/bindings/TaskItem";
import type { ThreadDetail } from "../ts/bindings/ThreadDetail";
import type { ThreadItem } from "../ts/bindings/ThreadItem";
import type { Todo } from "../ts/bindings/Todo";
import type { TodoPrompt } from "../ts/bindings/TodoPrompt";
import type { Week } from "../ts/bindings/Week";
import type { Workspace } from "../ts/bindings/Workspace";

declare global {
  interface Window {
    __e2e_once__(id: string): boolean;
  }
}

// On the macOS runner the result of `browser.execute` is sometimes lost, and webdriver then runs the same script again.
// A script that must not run twice (a press, a key, a release) takes a fresh `onceId()` and returns at once when `window.__e2e_once__(id)` is false (e2e/fixtures.js).
// A script that only reads, or only sets a value, needs no id.
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

export const task = (id: string, content: string, projectId: string, bucket: "overdue" | "today" | "upcoming" | "none"): TaskItem => ({
  id,
  content,
  description: "",
  projectId,
  priority: 4,
  due: bucket === "none" ? null : { date: today, time: null, string: "today", recurring: false },
  bucket,
  subtasks: [],
  subDone: 0,
  subTotal: 0,
  mail: null,
  parent: null,
  url: `https://app.todoist.com/app/task/${id}`,
});

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
    tasks: [task("k1", "Write report", "p1", "today"), trip, flights, seat],
  };
};

// ---- Slack and Claude ----

export const workspace: Workspace = { teamId: "T1", team: "Example Team", user: "alice", url: "https://example-team.slack.com/" };
export const slackLoad: SlackLoad = { workspaces: [workspace], recent: [] };
export const slackMessageUrl = "https://example-team.slack.com/archives/C0123ABCD/p1700000000123456";

// What `todoist_summarize_slack` answers for `slackMessageUrl`.
export const slackSummary: Summary = { content: "Reply to the vendor", description: "- Asked for a quote\n- Wants an answer by Friday", due: "2026-11-06", projectId: null };

// What `claude_model_settings` answers (the same as the base answer in e2e/fixtures.js): the defaults, Sonnet and medium, for the four purposes.
export const claudeSettings: ClaudeSettings = {
  slackSummary: { model: "sonnet", effort: "medium" },
  mailSummary: { model: "sonnet", effort: "medium" },
  promptChat: { model: "sonnet", effort: "medium" },
  proofread: { model: "sonnet", effort: "medium" },
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

// What `slack_check` answers; `missingScopes` null means Slack sent no scopes to judge by.
export const checked = (missingScopes: string[] | null): Checked => ({ ...workspace, missingScopes });

export const claudeReady: Claude = { state: "ready", email: "claude@example.com", plan: "Max", version: "2.0.0" };
export const claudeLoggedOut: Claude = { state: "loggedOut", version: "2.0.0" };
export const claudeMissing: Claude = { state: "missing" };
