// What every spec shares: booting the app with fixtures, mocking a command, and fixture data shaped like the Rust return values.
// The fixtures are typed by the types ts-rs writes from the Serialize structs (ts/bindings/), so a change of a struct's shape fails the type check here.
// Only example.com addresses and made-up names appear here: the repository is public.
import type { Channel } from "../ts/bindings/Channel";
import type { CalendarChoices } from "../ts/bindings/CalendarChoices";
import type { Checked } from "../ts/bindings/Checked";
import type { Claude } from "../ts/bindings/Claude";
import type { ClaudeConnection } from "../ts/bindings/ClaudeConnection";
import type { ClaudeSettings } from "../ts/bindings/ClaudeSettings";
import type { Comment } from "../ts/bindings/Comment";
import type { Card } from "../ts/bindings/Card";
import type { DatabaseProfileView } from "../ts/bindings/DatabaseProfileView";
import type { DatabaseCell } from "../ts/bindings/DatabaseCell";
import type { DatabaseColumn } from "../ts/bindings/DatabaseColumn";
import type { DatabaseRecords } from "../ts/bindings/DatabaseRecords";
import type { DatabaseSqlResult } from "../ts/bindings/DatabaseSqlResult";
import type { DatabaseStructure } from "../ts/bindings/DatabaseStructure";
import type { DatabaseTable } from "../ts/bindings/DatabaseTable";
import type { DecisionPage } from "../ts/bindings/DecisionPage";
import type { EmojiCatalog } from "../ts/bindings/EmojiCatalog";
import type { EnvironmentsView } from "../ts/bindings/EnvironmentsView";
import type { FontSettings } from "../ts/bindings/FontSettings";
import type { FormationChild } from "../ts/bindings/FormationChild";
import type { FormationConsent } from "../ts/bindings/FormationConsent";
import type { FormationEntry } from "../ts/bindings/FormationEntry";
import type { FormationList } from "../ts/bindings/FormationList";
import type { FormationListChild } from "../ts/bindings/FormationListChild";
import type { FormationState } from "../ts/bindings/FormationState";
import type { GhosttyImport } from "../ts/bindings/GhosttyImport";
import type { HandoffSummary } from "../ts/bindings/HandoffSummary";
import type { Inbox } from "../ts/bindings/Inbox";
import type { Info } from "../ts/bindings/Info";
import type { LogEntry } from "../ts/bindings/LogEntry";
import type { OrcaOverview } from "../ts/bindings/OrcaOverview";
import type { OrcaProject } from "../ts/bindings/OrcaProject";
import type { OrcaRow } from "../ts/bindings/OrcaRow";
import type { OrcaStatus } from "../ts/bindings/OrcaStatus";
import type { OrcaStreamEvent } from "../ts/bindings/OrcaStreamEvent";
import type { ClaudeCodeEvent } from "../ts/bindings/ClaudeCodeEvent";
import type { OrcaTermEvent } from "../ts/bindings/OrcaTermEvent";
import type { OrcaTerminal } from "../ts/bindings/OrcaTerminal";
import type { OrcaWorktree } from "../ts/bindings/OrcaWorktree";
import type { ScreenAnswer } from "../ts/bindings/ScreenAnswer";
import type { Reaction } from "../ts/bindings/Reaction";
import type { ResponseStatus } from "../ts/bindings/ResponseStatus";
import type { Skill } from "../ts/bindings/Skill";
import type { SlackLoad } from "../ts/bindings/SlackLoad";
import type { RichBlock } from "../ts/bindings/RichBlock";
import type { SlackThread } from "../ts/bindings/SlackThread";
import type { SocketState } from "../ts/bindings/SocketState";
import type { SocketStatus } from "../ts/bindings/SocketStatus";
import type { Span } from "../ts/bindings/Span";
import type { Summary } from "../ts/bindings/Summary";
import type { TaskItem } from "../ts/bindings/TaskItem";
import type { TerminalTheme } from "../ts/bindings/TerminalTheme";
import type { TerminalThemes } from "../ts/bindings/TerminalThemes";
import type { ThemeSelection } from "../ts/bindings/ThemeSelection";
import type { ThreadAttachment } from "../ts/bindings/ThreadAttachment";
import type { ThreadDetail } from "../ts/bindings/ThreadDetail";
import type { ThreadFile } from "../ts/bindings/ThreadFile";
import type { ThreadItem } from "../ts/bindings/ThreadItem";
import type { ThreadMessage } from "../ts/bindings/ThreadMessage";
import type { HiddenChannel } from "../ts/bindings/HiddenChannel";
import type { SideChannel } from "../ts/bindings/SideChannel";
import type { SideWorkspace } from "../ts/bindings/SideWorkspace";
import type { Timeline } from "../ts/bindings/Timeline";
import type { TimelineMessage } from "../ts/bindings/TimelineMessage";
import type { UnreadChannel } from "../ts/bindings/UnreadChannel";
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
    __e2e_set_dark__(dark: boolean): void;
  }
}

// When the result of `browser.execute` is lost, webdriver runs the same script again after the script timeout. The cause was found only for the script right after `refresh` (`boot`); CI also showed lost results of other commands.
// A script whose second run would change what the spec checks (a press, a key, a release) takes a fresh `onceId()` and returns at once when `window.__e2e_once__(id)` is false (e2e/fixtures.js).
// Any other script needs no id. An element's `.click()` can be run again the same way, and this guard does not cover it.
let onceCount = 0;
export const onceId = () => `once-${++onceCount}`;

// The fixture that shortens the timers a spec waits for (ts/e2e-timers.ts, e2e/fixtures.js), in milliseconds: `orcaClock` is the Orca list's read while the screen is shown (10 s in the app), `orcaMirror` the read of a terminal's screen (1 s) `databaseProfiles` the read of the connections that the database screen does while it is shown, and its edit pane (2 s) `formationFlow` the read of the children by the flow pane of the orchestration mode (3 s) and `lspSettings` the read of the language servers' settings while the language server part of the file pane is shown (2 s).
// A wait for a period to pass is that period times 1.2. Put it in the fixtures of `boot`: `boot({ ...timers({ orcaMirror: 250 }) })`.
export const timers = (periods: { orcaClock?: number; orcaMirror?: number; databaseProfiles?: number; formationFlow?: number; lspSettings?: number }) => ({ e2e_timers: periods });

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

// Where the parts of a Claude pane's request field (ts/composer.ts) are: the field, the model and effort slot and the send button, all in the one frame (`.composer`) of `{prefix}-form`;
// the slot in the row under the field, at the left of the send button, which is round.
export const composerLayout = (prefix: string) =>
  browser.execute((p) => {
    const part = (name: string) => document.getElementById(`${p}-${name}`)!;
    const frame = document.querySelector(`#${p}-form > .composer`)!;
    const [input, model, send] = [part("input"), part("model"), part("send")];
    const box = (e: Element) => e.getBoundingClientRect();
    return {
      framed: [input, model, send].map((e) => e.closest(".composer") === frame),
      modelBelowInput: box(model).top >= box(input).bottom,
      sendRightOfModel: box(send).left >= box(model).right,
      sendInsideFrame: box(send).right <= box(frame).right && box(send).bottom <= box(frame).bottom,
      sendRadius: getComputedStyle(send).borderRadius,
      placeholder: input.getAttribute("placeholder"),
    };
  }, prefix);

// The text of every element matching `selector`, hidden ones included (`getText` is empty for an element that is not displayed).
export const textsOf = (selector: string) =>
  browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.textContent?.trim() ?? ""), selector);

export const waitForText = (selector: string, text: string) =>
  browser.waitUntil(async () => (await textsOf(selector)).some((t) => t.includes(text)), { timeoutMsg: `${selector} never showed "${text}"` });

// The failure cards at the bottom right (A-28, ts/error-card.ts): `CARD` matches the text of every card (the newest first: `$$(CARD)[0]`, as `$(CARD)` holds only while one card is drawn), and `CARDS` matches every card.
export const CARD = "#error-cards .error-card-text";
export const CARDS = "#error-cards .error-card";

// What the app wrote to its log (the arguments of `log_write`: `{ level, source, message }`), in the order written. A failure of a sync or a read is only here; a failure of something the user did is a card and a line here.
export const logged = async () => (await callsOf("log_write")) as { level: string; source: string; message: string }[];

// Waits until a line of the log holds `text`, and returns the line.
export async function waitForLog(text: string) {
  await browser.waitUntil(async () => (await logged()).some((l) => l.message.includes(text)), { timeoutMsg: `the log never got "${text}"` });
  return (await logged()).find((l) => l.message.includes(text))!;
}

export const waitForCount = (selector: string, n: number) =>
  browser.waitUntil(async () => (await count(selector)) === n, { timeoutMsg: `expected ${n} of ${selector}` });

// The app with Todoist connected and the Todo screen open.
export async function openTodo(claude: unknown = claudeReady) {
  await boot({ inbox: inbox(), todoist_load: todoData(), slack_load: slackLoad, claude_status: claude });
  await $("#nav-todo").click();
  await waitForCount("#todo-list li.task", 1);
}

export const heightOf = (selector: string) => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().height, selector);

// The aria-labels of the buttons of a rich field's toolbar (S-6, S-21).
export const TOOLS = ["太字", "斜体", "取り消し線", "リンク", "番号付きリスト", "箇条書き", "引用", "コード", "コードブロック"];

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
  fromName: "Alice",
  fromAddress: "alice@example.com",
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

// Waits until the detail view holds its thread: before that it shows the row's subject and a note in the body's place.
export const threadLoaded = () =>
  browser.waitUntil(() => browser.execute(() => !document.getElementById("thread")!.hasAttribute("aria-busy")), { timeoutMsg: "the thread did not arrive" });

// Who a reply to the thread of `threadDetail` goes to (M-10): Alice for "返信"; Alice and Bob, with Carol in Cc, for "全員に返信".
const alice = { label: "Alice", mailbox: "Alice <alice@example.com>" };

// A thread of one plain-text message.
export const threadDetail = (subject: string, body: string, unread: boolean): ThreadDetail => ({
  subject,
  unread,
  messages: [
    {
      id: "m1",
      from: "Alice <alice@example.com>",
      fromName: "Alice",
      fromAddress: "alice@example.com",
      to: account,
      toLabel: "To 自分",
      dateMs: Date.now() - 60_000,
      snippet: body,
      html: false,
      body,
      authenticated: false,
    },
  ],
  reply: {
    one: { to: [alice], cc: [] },
    all: { to: [alice, { label: "Bob", mailbox: "Bob <bob@example.com>" }], cc: [{ label: "Carol", mailbox: "carol@example.com" }] },
  },
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
    eventId: "",
    calendarId: "",
    editable: false,
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
    allDay: false,
    start: "",
    end: "",
    guests: [],
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

// A local date and time ("YYYY-MM-DD", "HH:MM") as RFC 3339 with the offset of that moment, as the form of the calendar sends it.
export const rfc = (date: string, time: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const offset = -new Date(y, m - 1, d, h, mi).getTimezoneOffset();
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `${date}T${time}:00${offset < 0 ? "-" : "+"}${p(Math.floor(Math.abs(offset) / 60))}:${p(offset % 60)}`;
};

// The calendars of the account: "Work" is its own with a color of its own, "Holidays" is another one (the calendars of `weekOfToday`'s events) and takes the account's color.
export const calendarChoices = (): CalendarChoices => ({
  accounts: [
    {
      account,
      calendars: [
        { id: "work", name: "Work", color: "#1e7b52", mine: true, shown: true },
        { id: "holidays", name: "Holidays", color: null, mine: false, shown: true },
      ],
    },
  ],
  needsLogin: [],
  failed: {},
});

// The calendars of the account that an event can be created in (`calendar_owned`): its primary calendar (the ID is the account's address), the default of a form, and "Work".
export const ownedCalendars = (): CalendarChoices => ({
  accounts: [
    {
      account,
      calendars: [
        { id: "work", name: "Work", color: "#1e7b52", mine: true, shown: true },
        { id: account, name: "Me", color: null, mine: true, shown: true },
      ],
    },
  ],
  needsLogin: [],
  failed: {},
});

// ---- Todoist ----

// The `dueAt` a fixture task carries: the epoch milliseconds of `time` (`HH:MM`, midnight by default) `day` days from today, in local time.
// Rust computes it in the app; a fixture only gives it a value that fits the task's due, and a spec reads it back from the task.
const fixtureDueAt = (day: number, time = "00:00") => {
  const [h, m] = time.split(":").map(Number);
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, h, m).getTime();
};

// The local `YYYY-MM-DD` of `n` days from today.
const dayFromToday = (n: number) => isoDate(new Date(fixtureDueAt(n)));

// A task with a due date that fits its bucket: yesterday, today or tomorrow, no time.
export const task = (id: string, content: string, projectId: string, bucket: "overdue" | "today" | "upcoming" | "none"): TaskItem => ({
  id,
  content,
  description: "",
  projectId,
  priority: 4,
  due: bucket === "none" ? null : { date: dayFromToday({ overdue: -1, today: 0, upcoming: 1 }[bucket]), time: null, string: bucket, recurring: false },
  bucket,
  dueAt: bucket === "none" ? null : fixtureDueAt({ overdue: -1, today: 0, upcoming: 1 }[bucket]),
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
export const dueToday = (t: TaskItem, time: string | null): TaskItem => ({
  ...t,
  bucket: "today",
  due: { date: today, time, string: "today", recurring: false },
  dueAt: fixtureDueAt(0, time ?? "00:00"),
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

// A-36: what `tsunagiai-mcp` does through the app's socket: the event `screen-bridge-ask`, which the screen answers with `screen_bridge_answer` (e2e/fixtures.js records it). Returns the screen's answer (`ok`, and `fields` or `error`).
let screenAsks = 0;
export async function askScreen(op: "read" | "write" | "post", target: string, fields: Record<string, string> = {}) {
  const id = ++screenAsks;
  await emitEvent("screen-bridge-ask", { id, op, target, fields });
  let found: { id: number; answer: ScreenAnswer } | undefined;
  await browser.waitUntil(
    async () => {
      found = ((await callsOf("screen_bridge_answer")) as { id: number; answer: ScreenAnswer }[]).find((c) => c.id === id);
      return found !== undefined;
    },
    { timeoutMsg: `screen_bridge_answer was not called for the ask ${id}` },
  );
  return found!.answer;
}

export const slackMessageUrl = "https://example-team.slack.com/archives/C0123ABCD/p1700000000123456";

// What `todoist_summarize_slack` answers for `slackMessageUrl`.
export const slackSummary: Summary = { content: "Reply to the vendor", description: "- Asked for a quote\n- Wants an answer by Friday", due: "2026-11-06", projectId: null, omitted: 0, targetCut: false, targetText: "Could you send us the quote for the new plan by Friday?" };

// What `claude_model_settings` answers (the same as the base answer in e2e/fixtures.js): the defaults, Sonnet and medium, and Sonnet and high for the Slack reply.
export const claudeSettings: ClaudeSettings = {
  slackSummary: { model: "sonnet", effort: "medium" },
  mailSummary: { model: "sonnet", effort: "medium" },
  promptChat: { model: "sonnet", effort: "medium" },
  proofread: { model: "sonnet", effort: "medium" },
  slackReply: { model: "sonnet", effort: "high" },
  orcaHandoff: { model: "sonnet", effort: "medium" },
  todoChat: { model: "sonnet", effort: "medium" },
  slackChat: { model: "sonnet", effort: "medium" },
};

// A saved skill (A-32) as `skill_list` answers it; `extra` changes the parts.
export const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({ name, displayName: `Skill ${name}`, screens: [], description: `About ${name}`, instructions: `Do ${name}.`, ...extra });

// A line of the log (A-28) as `log_read` answers it.
export const logLine = (time: string, level: LogEntry["level"], source: string, message: string): LogEntry => ({ time, level, source, message });

// What `claude_todo_prompt` answers (the same as the base answer in e2e/fixtures.js): the default instructions, not edited.
export const todoPrompt: TodoPrompt = { body: "Default body", defaultBody: "Default body", fixed: "Fixed part\nToday is {today}.\n{projects}", fixedAfter: "Fixed tail", edited: false };

// What `slack_preview` answers for the thread of `threadDetail("First unread", "Hello from Alice", …)`: the post as it starts out in the compose screen.
export const slackPreview = "*First unread*\nAlice <alice@example.com> ・ 2026/11/3 9:00\n\nHello from Alice";

// What `slack_channels` answers: the channels of the workspace `workspace`.
export const slackChannels: Channel[] = [{ id: "C0123ABCD", name: "general", private: false }];

// What `slack_check` answers; `missingScopes` null means Slack sent no scopes to judge by. `missingOptional` is the same for users:read, files:read, channels:write, groups:write, emoji:read and reactions:write.
export const checked = (missingScopes: string[] | null, missingOptional: string[] | null = []): Checked => ({ ...workspace, missingScopes, missingOptional });

// A Slack timestamp `minutes` minutes ago ("1700000000.000100"); `n` tells apart messages of the same minute.
// "Ago" counts from the second this module was loaded, read once: the same arguments give the same timestamp at every call, so a message made twice in a spec is one message (the timestamp is part of its key).
const slackNow = Math.floor(Date.now() / 1000);
// A saved connection of the database screen (D-1) that goes straight to its host.
export const databaseProfile = (id: string, name: string, extra: Partial<DatabaseProfileView> = {}): DatabaseProfileView => ({
  id,
  name,
  username: "reader",
  script: "",
  dbHost: "db.example.com",
  dbPort: 3306,
  passwordSaved: false,
  ...extra,
});

// A table of a database as `database_tables` answers it (D-3): the row count, the size and the engine as Rust words them.
export const databaseTable = (name: string, extra: Partial<DatabaseTable> = {}): DatabaseTable => ({ name, engine: "InnoDB", rows: "1,200", size: "1.5 MB", ...extra });

// A value as `database_records` answers it (D-4): Rust has made the text and told how to draw it.
export const databaseCell = (text: string, kind: DatabaseCell["kind"] = "text"): DatabaseCell => ({ kind, text });
export const databaseNull = databaseCell("NULL", "null");

// A page of records as `database_records` answers it.
export const databaseRecords = (columns: string[], rows: DatabaseCell[][], extra: Partial<DatabaseRecords> = {}): DatabaseRecords => ({
  columns,
  rows,
  page: 0,
  hasMore: false,
  estimate: null,
  summary: rows.length === 0 ? "0 行" : `1–${rows.length} 行目`,
  lastPage: null,
  pages: "",
  tsv: "",
  key: [],
  edits: rows.map((row) => ({ canChange: false, cells: row.map(() => true) })),
  ...extra,
});

// A column of a table as `database_structure` answers it (D-5): the default and the comment are text, empty for none.
export const databaseColumn = (name: string, columnType: string, extra: Partial<DatabaseColumn> = {}): DatabaseColumn => ({ name, columnType, nullable: false, key: "", default: "", comment: "", ...extra });

// The structure of a table as `database_structure` answers it; `tsv` is the text Rust made for the copy button (#668), which a spec that copies gives.
export const databaseStructure = (columns: DatabaseColumn[], summary = `${columns.length} 列 / InnoDB / utf8mb4`, tsv = ""): DatabaseStructure => ({ columns, summary, tsv });

// The result of a statement as `database_sql` answers it (D-6): the cells as D-4's, and the line under the table.
export const databaseSqlResult = (columns: string[], rows: DatabaseCell[][], summary = `${rows.length} 行 / 3 ms`, tsv = ""): DatabaseSqlResult => ({ columns, rows, summary, tsv });

export const slackTs = (minutes: number, n = 0) => `${slackNow - minutes * 60}.${String(100 + n).padStart(6, "0")}`;

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
  repliers: [],
  latestReply: null,
  permalink: permalinkOf(ts),
  hasFiles: false,
  unread: false,
  watch: null,
  unreadReplies: null,
  reactions: [],
  threadReply: null,
  ...extra,
});

// An unread reply under a row of the Slack list (S-14); its `rich` is its text with no style unless `extra` sets it.
export const timelineReply = (ts: string, name: string, text: string, extra: Partial<TimelineReply> = {}): TimelineReply => ({ ts, name, iconUrl: null, text, rich: plain(text), blocks: [], showText: true, attachments: [], hasFiles: false, ...extra });

// What a row's thread has unread (`TimelineMessage.unreadReplies`): the replies given, counted (`share` too, what Rust adds to the badge), the last one the newest, unless `extra` says another.
export const unreadRepliesOf = (replies: TimelineReply[], extra: Partial<UnreadReplies> = {}): UnreadReplies => ({ count: replies.length, uncounted: false, share: replies.length, latestTs: replies[replies.length - 1]?.ts ?? "", replies, ...extra });

// A row of the watch section (`Timeline.watched`): the thread's own message, with `newReplies` new replies (and `status`, "ok" unless `extra` says another).
// `unreadTo` (the message opening the row moves the read position to) is the message itself when it is unread, unless `extra.watch` says another.
export const watchedMessage = (ts: string, name: string, channelName: string, text: string, newReplies = 0, extra: Partial<TimelineMessage> = {}): TimelineMessage => {
  const message = timelineMessage(ts, name, channelName, text, extra);
  return { ...message, watch: extra.watch ?? { newReplies, uncounted: false, status: "ok", unreadTo: message.unread ? message.ts : null } };
};

// What Rust says of the channels with something unread (`Timeline.unreadChannels`), from the rows given: each channel's unread messages, the newest of them (`to`, a number as Rust compares it) and the threads with unread replies.
export const unreadChannelsOf = (messages: TimelineMessage[]): UnreadChannel[] => {
  const channels: UnreadChannel[] = [];
  for (const m of messages) {
    if (!m.unread && !m.unreadReplies) continue;
    let c = channels.find((x) => x.teamId === m.teamId && x.channel === m.channel);
    if (!c) {
      c = { teamId: m.teamId, channel: m.channel, messages: 0, to: null, threads: [] };
      channels.push(c);
    }
    if (m.unread) {
      c.messages += 1;
      if (c.to === null || Number(m.ts) > Number(c.to)) c.to = m.ts;
    }
    if (m.unreadReplies) c.threads.push({ ts: m.ts, latestTs: m.unreadReplies.latestTs });
  }
  return channels;
};

// What `slack_timeline` answers; `unreadTotal` is the number of unread messages and unread replies given unless `extra` says another (it counts the messages held, not only the ones listed),
// `unreadChannels` is what `unreadChannelsOf` makes of the rows. `watched` and `side` (the side menu) are empty unless `extra` gives them.
export const timeline = (messages: TimelineMessage[], extra: Partial<Timeline> = {}): Timeline => ({
  messages,
  watched: [],
  failed: [],
  missing: [],
  refreshSecs: 120,
  pendingChannels: 0,
  unreadTotal: messages.filter((m) => m.unread).length + messages.reduce((n, m) => n + (m.unreadReplies?.share ?? 0), 0),
  unreadChannels: unreadChannelsOf(messages),
  side: [],
  ...extra,
});

// A channel of the side menu (S-19) of the workspace `team`: `channel` is its ID, `extra` overrides any field.
export const sideChannel = (channel: string, name: string, extra: Partial<SideChannel> = {}): SideChannel => ({ id: channel, name, private: false, unread: 0, ...extra });
// A workspace of the side menu with its channels in the order given (Rust sorts them by name).
export const sideWorkspace = (channels: SideChannel[], extra: Partial<SideWorkspace> = {}): SideWorkspace => ({ teamId: workspace.teamId, team: workspace.team, channels, ...extra });

// A channel kept off the Slack list (`slack_hidden_list`); `name` is the channel's ID when its name is not known.
export const hiddenChannel = (channel: string, name: string, extra: Partial<HiddenChannel> = {}): HiddenChannel => ({ teamId: workspace.teamId, team: workspace.team, channel, name, ...extra });

// A Slack text read for its styles (S-12): `plain` is a text with no style, `span` a run (`style` holds b, i, s and c for bold, italic, strike and code), `para` and `quote` hold spans.
export const span = (text: string, style = ""): Span => ({ text, bold: style.includes("b"), italic: style.includes("i"), strike: style.includes("s"), code: style.includes("c"), link: null });
// A span that is a link to `url` (S-11): Rust labels it "メッセージ" when the message unfurls that message.
export const linkSpan = (text: string, url: string): Span => ({ ...span(text), link: url });
export const para = (...spans: Span[]): RichBlock => ({ type: "paragraph", spans });
export const quote = (...spans: Span[]): RichBlock => ({ type: "quote", spans });
export const plain = (text: string): RichBlock[] => [para(span(text))];

// A message of a thread (`slack_thread`); its `rich` is its text with no style unless `extra` sets it.
export const threadMessage = (ts: string, name: string, text: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ ts, user: "U1", name, iconUrl: null, text, rich: plain(text), files: [], blocks: [], showText: true, attachments: [], imageUrls: [], reactions: [], ...extra });

// A reaction under a message (S-22): Slack's `name`, the `emoji` drawn for it, how many gave it, for a custom emoji the address of its `image` (S-26), and whether the user gave it themselves, `mine` (S-25).
export const reaction = (name: string, emoji: string, count: number, image: string | null = null, mine = false): Reaction => ({ name, emoji, count, image, mine });

// What `slack_emoji_catalog` answers (S-25): the standard emoji by Slack's name, and the custom emoji with their image addresses (S-26).
export const emojiCatalog = (standard: [string, string][], custom: [string, string][] = []): EmojiCatalog => ({
  standard: standard.map(([name, emoji]) => ({ name, emoji })),
  custom: custom.map(([name, image]) => ({ name, image })),
});

// An attachment of a thread's message (S-11) with nothing in it; `extra` sets the parts.
export const attachment = (extra: Partial<ThreadAttachment> = {}): ThreadAttachment => ({
  color: null, pretext: null, authorName: null, title: null, titleLink: null, text: null, textShort: null, fields: [], footer: null, actions: [], blocks: [], image: null, thumb: null, fallback: null, ...extra,
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
  return { group, repo, branch, line, latest: null, subagents: 0, atMs: Date.now() - minutes * 60_000 - 5_000, handle: `term_${repo}`, paneKey: `tab_${repo}:leaf_1`, path: `/work/${repo}`, status: GROUP_STATUS[group], projectKey: `proj_${repo}`, ...rest };
};

// A worktree of the project `proj_{repo}`, on the git branch of its name (`extra.gitBranch` gives another one, or "" for a detached HEAD); `extra` gives another path (a second worktree of the same project, which is not the main one) or another project.
export const orcaWorktree = (repo: string, branch: string, extra: Partial<OrcaWorktree> = {}): OrcaWorktree => ({ path: `/work/${repo}`, repo, branch, gitBranch: branch, projectKey: `proj_${repo}`, isMain: extra.path === undefined, ...extra });

// A plain terminal of Orca (a shell) in the project of `repo`.
export const orcaTerminal = (repo: string, title: string, extra: Partial<OrcaTerminal> = {}): OrcaTerminal => ({ handle: `term_${repo}_${title}`, title, branch: "main", projectKey: `proj_${repo}`, path: `/work/${repo}`, ...extra });

const STATUS_ORDER: OrcaStatus[] = ["question", "failed", "working", "monitoring", "interrupted", "done", "idle"];

// The project list of what is on the screen: one project for each repository of the rows, the worktrees and the terminals, the highest status of its rows (a terminal is a green dot), and its sessions.
function projectsOf(rows: OrcaRow[], worktrees: OrcaWorktree[], terminals: OrcaTerminal[]): OrcaProject[] {
  const keys = [...new Set([...rows.map((r) => r.projectKey), ...worktrees.map((w) => w.projectKey), ...terminals.map((t) => t.projectKey)])];
  return keys.map((key) => {
    const mine = rows.filter((r) => r.projectKey === key);
    const mineTerminals = terminals.filter((t) => t.projectKey === key);
    const statuses: OrcaStatus[] = [...mine.map((r) => r.status), ...mineTerminals.map((): OrcaStatus => "done"), "idle"];
    return { key, name: key.replace(/^proj_/, ""), status: statuses.sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))[0], sessions: mine.length + mineTerminals.length, atMs: 0 };
  });
}

// A child of the orchestrator as `formation_children` answers it (A-37). `minutes` is how long ago its state began (a done child: how long ago it ended); a planned child has no branch, time or terminal.
export const formationChild = (name: string, state: FormationState, extra: Partial<FormationChild> & { minutes?: number } = {}): FormationChild => {
  const { minutes = 2, ...rest } = extra;
  const planned = state === "planned";
  return { name, repo: "example-api", branch: planned ? "" : `formation/${name}`, state, atMs: planned ? 0 : Date.now() - minutes * 60_000 - 5_000, reply: null, toolName: null, handle: planned ? null : `term_${name}`, environment: "local", agent: "claude", created: true, pendingPage: null, ...rest };
};

// A decision page as `formation_page_read` answers it (A-41): an `open-questions` page with nothing on it, which `extra` fills in.
export const decisionPage = (extra: Partial<DecisionPage> = {}): DecisionPage => ({
  pageKind: "open-questions",
  subject: "requirement",
  contextLabel: "要件定義 · 未決事項",
  title: "要件の未決事項",
  what: null,
  roots: {},
  previousReply: null,
  questions: [],
  approvalScope: [],
  changes: [],
  needsUserDecision: [],
  residualMustFix: [],
  structuralProposals: [],
  adr: null,
  risks: null,
  settledDecisions: [],
  qualityLoop: null,
  unmetCriteria: [],
  pr: null,
  ...extra,
});

// A card of a decision page: a `question` with no option, which `extra` fills in.
export const decisionCard = (number: string, extra: Partial<Card> = {}): Card => ({
  kind: "question",
  number,
  title: `質問 ${number}`,
  summary: "",
  options: [],
  recommendation: null,
  recommendationReason: null,
  background: null,
  facts: [],
  blocks: [],
  evidence: [],
  cards: [],
  ...extra,
});

// A launched child of a formation as `formation_list` lists it (A-37): its project (`repo`), the branch and the worktree it has under `/work/`, which tsunagiai made (`created`), and its terminal and agent (`handle`, `paneKey`, as the Orca rows of `orcaRow` name them).
export const listedChild = (name: string, state: Exclude<FormationState, "planned">, extra: Partial<FormationListChild> = {}): FormationListChild => ({ name, repo: "example-api", branch: `formation/${name}`, path: `/work/${name}`, environment: "local", state, created: true, handle: `term_${name}`, paneKey: `tab_${name}:leaf_1`, terminal: true, ...extra });

// A formation as `formation_list` answers it (A-37): its projects (by repository name, in this Mac's Orca; `extra` gives those of a saved environment, with its `environment`), the time it was made (`minutes` ago; none for one with no `formation.json`) and the number of its children in each state; `waiting: true` in `extra` is a leader that waits for input (#915).
export const formationEntry = (name: string, extra: Partial<FormationEntry> & { minutes?: number; repos?: string[] } = {}): FormationEntry => {
  const { minutes, repos = [], ...rest } = extra;
  return {
    name,
    projects: repos.map((repo) => ({ environment: "local", repo })),
    environment: "local",
    createdAt: minutes === undefined ? null : Date.now() - minutes * 60_000 - 5_000,
    counts: { planned: 0, waiting: 0, working: 0, done: 0 },
    children: [],
    waiting: false,
    ...rest,
  };
};

// A PC that the owner agreed to put tsunagiai-mcp on, as `formation_consents`, `formation_consent` and `formation_consent_revoke` answer it (A-37, #893).
export const formationConsent = (environment: string, version = "1.2.3"): FormationConsent => ({ environment, version });

// What `formation_list` answers: the formations in the order given.
export const formationList = (formations: FormationEntry[], readError: string | null = null): FormationList => ({ formations, readError });

// What `formation_environments` answers (A-37): this Mac with the repositories given by name, and a saved environment for each entry of `saved` (its repositories by name; a name of `unreadable` is an environment whose repositories could not be read, with that text as the reason).
export const formationEnvironments = (local: string[], saved: Record<string, string[]> = {}, unreadable: Record<string, string> = {}, environmentListError: string | null = null): EnvironmentsView => ({
  environmentListError,
  environments: [
    { environment: "local", label: "この Mac", ok: true, repos: local.map((name) => ({ name, path: `/Users/me/${name}` })) },
    ...Object.entries(saved).map(([environment, repos]) => ({ environment, ok: true, repos: repos.map((name) => ({ name, path: `/srv/${name}` })) })),
    ...Object.entries(unreadable).map(([environment, error]) => ({ environment, ok: false, error })),
  ],
});

// What `orca_overview` answers: a read that worked, this machine's, unless `extra` says another.
export const orcaOverview = (rows: OrcaRow[], worktrees: OrcaWorktree[] = [], extra: Partial<OrcaOverview> = {}): OrcaOverview => ({
  state: "ready",
  message: "",
  target: null,
  environments: [],
  rows,
  worktrees,
  projects: projectsOf(rows, worktrees, extra.terminals ?? []),
  terminals: [],
  known: true,
  ...extra,
});

// A-12: the list a saved environment streams, as `orca_stream_open`'s channel gets it.
export const streamList = (rows: OrcaRow[], worktrees: OrcaWorktree[] = [], terminals: OrcaTerminal[] = []): OrcaStreamEvent => ({
  kind: "list",
  rows,
  worktrees,
  projects: projectsOf(rows, worktrees, terminals),
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

// A-14: a theme of example colors; its red (the palette color 1) is the given one.
export const terminalTheme = (name: string, background: string, foreground: string, red: string): TerminalTheme => ({
  name,
  colors: {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: "#445566",
    selectionForeground: foreground,
    palette: Array.from({ length: 16 }, (_, index) => ({ index, color: index === 1 ? red : "#808080" })),
  },
});

// A-14: what `terminal_themes` answers: four themes of example colors, and the choice (the defaults unless given).
export const terminalThemes = (selection: Partial<ThemeSelection> = {}): TerminalThemes => ({
  themes: [
    terminalTheme("Ghostty Default Style Dark", "#10203a", "#e0e0e0", "#cc0000"),
    terminalTheme("Builtin Tango Light", "#fafafa", "#202020", "#aa0000"),
    terminalTheme("Dracula", "#282a36", "#f8f8f2", "#ff5555"),
    terminalTheme("One Light", "#fdf6e3", "#657b83", "#dc322f"),
  ],
  selection: { light: "Builtin Tango Light", dark: "Ghostty Default Style Dark", appearance: "system", ...selection },
});

// Chooses a theme in the select of an appearance in the settings, as the user does (value, then change); the real WebView's select popup is not driven.
export const chooseTheme = (slot: "light" | "dark", name: string) =>
  browser.execute(
    (id, s, n) => {
      if (!window.__e2e_once__(id)) return;
      const select = document.getElementById(`terminal-theme-${s}`) as HTMLSelectElement;
      select.value = n;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    onceId(),
    slot,
    name,
  );

// A-20: what `font_settings` and `font_settings_set` answer: the first values, with the given places changed.
export const fontSettings = (parts: Partial<FontSettings> = {}): FontSettings => ({
  app: { family: null, size: 14, ghostty: false },
  mail: { family: null, size: 14, ghostty: false },
  calendar: { family: null, size: 14, ghostty: false },
  todoList: { family: null, size: 14, ghostty: false },
  todoWork: { family: null, size: 14, ghostty: false },
  slack: { family: null, size: 14, ghostty: false },
  orcaList: { family: null, size: 14, ghostty: false },
  orcaPane: { family: null, size: 14, ghostty: false },
  orcaWork: { family: null, size: 13, ghostty: true },
  editor: { family: null, size: 12.5, ghostty: false },
  mono: { family: null, size: 14, ghostty: false },
  ...parts,
});

// Chooses `value` in the select `id`, as the user does (value, then change); the real WebView's select popup is not driven.
export const chooseOption = (id: string, value: string) =>
  browser.execute(
    (once, i, v) => {
      if (!window.__e2e_once__(once)) return;
      const select = document.getElementById(i) as HTMLSelectElement;
      select.value = v;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    onceId(),
    id,
    value,
  );

// Chooses which appearance the terminals draw (A-15) in the select of the settings, as the user does.
export const chooseAppearance = (appearance: "system" | "light" | "dark") =>
  browser.execute(
    (id, a) => {
      if (!window.__e2e_once__(id)) return;
      const select = document.getElementById("terminal-theme-appearance") as HTMLSelectElement;
      select.value = a;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    onceId(),
    appearance,
  );

// Sets the system's appearance (see fixtures.js) and tells the app, as the system does.
export const setDark = (dark: boolean) =>
  browser.execute(
    (id, d) => {
      if (!window.__e2e_once__(id)) return;
      window.__e2e_set_dark__(d);
    },
    onceId(),
    dark,
  );

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
// A-36: an event of the process of a Claude Code pane (`claude_code_start`).
export const sendClaudeCode = (event: ClaudeCodeEvent, nth = -1) => deliver("claude_code_start", event, nth);

// ---- files pasted or dropped (A-10) ----

// A one-pixel PNG.
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// `bytes` makes a file of that many zero bytes in the page, for a file too large to give as base64.
export type GivenFile = { name: string; type: string; base64: string; bytes?: number };
export const image = (name = "shot.png"): GivenFile => ({ name, type: "image/png", base64: PNG });
export const note: GivenFile = { name: "notes.txt", type: "text/plain", base64: btoa("hello") };
export const huge: GivenFile = { name: "big.bin", type: "application/octet-stream", base64: "", bytes: 20 * 1024 * 1024 + 1 };

// Dispatches `kind` ("paste", "dragover" or "drop") on the element at `selector` ("document" is the page) carrying `files`, as the clipboard or the pointer would (the event objects hold plain stand-ins for the clipboard and the transfer,
// which WKWebView builds only from a real gesture). Answers whether the page cancelled the event.
export const fire = (kind: "paste" | "dragover" | "drop", selector: string, files: GivenFile[]) =>
  browser.execute(
    (k, sel, given) => {
      const list = given.map((g) => new File([g.bytes === undefined ? Uint8Array.from(atob(g.base64), (c) => c.charCodeAt(0)) : new Uint8Array(g.bytes)], g.name, { type: g.type }));
      const event = new Event(k, { bubbles: true, cancelable: true });
      const transfer = { files: list, types: list.length ? ["Files"] : ["text/plain"], dropEffect: "none", getData: () => "" };
      Object.defineProperty(event, k === "paste" ? "clipboardData" : "dataTransfer", { value: transfer });
      const target = sel === "document" ? document.body : document.querySelector(sel)!;
      return !target.dispatchEvent(event);
    },
    kind,
    selector,
    files,
  );

// What `claude_summarize_handoff` answers (A-9): the points of the summary of the content.
export const handoffSummary = (points: string[]): HandoffSummary => ({ points });
