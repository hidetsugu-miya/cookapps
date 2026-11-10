// The Orca screen (A-6, A-8, A-12, A-16, A-17, A-18): two panes, and the file pane on the right (orca-files.ts) when it is shown. The list pane is the projects (a repository of this machine, an SSH host) or, with the bell pressed, the Claude agents that run in Orca in three groups (waiting for the user, working, done);
// the work pane has the sessions of the selected project as tabs, and each tab is a terminal (orca-terminal.ts). The work pane is split into panes (A-17), each with its tabs and its terminal; Rust holds how it is split for each project (orca-panes.ts), and the selected tab is the one shown in the pane that has the focus.
// A file opened from the file pane is a tab of the strip too, with its editor (orca-editor.ts) in the pane where a terminal would be.
// The plus right after the tabs of a pane's strip starts Claude, or opens a terminal, in a worktree of the selected project, and the new tab is selected once it is listed. Nothing about a session is kept here.
// A saved environment streams the list (`orca_stream_open`: Orca sends each change) and nothing reads it by the clock. This machine's Orca cannot stream: its list is read every 10 seconds while the screen is shown and every 60 seconds otherwise, one read at a time,
// and no more once the `orca` command was found missing (the reload button reads again). Only the first read, the screen being shown, the reload button, a change of the target and a read after a failure ask for the environments (and the SSH hosts).
// The sidebar button's count is the agents that wait for the user plus the notices: the agents that stopped (done, failed, interrupted) while the app ran, until their session is shown on this screen, they run again or they leave the list (the first read of a target only sets the base).
// While an agent works, the button's icon is yellow and fades slowly; the number that work is only in the button's label.
// A search field above the projects (A-19) narrows them by name; ⌘J moves to it.
// A read in the background swaps the rows in place: the selection and the scroll position stay, and `show()` is never called by it.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaProject } from "./bindings/OrcaProject";
import type { OrcaRow } from "./bindings/OrcaRow";
import type { OrcaSshTarget } from "./bindings/OrcaSshTarget";
import type { OrcaStatus } from "./bindings/OrcaStatus";
import type { OrcaStreamEvent } from "./bindings/OrcaStreamEvent";
import type { OrcaTerminal } from "./bindings/OrcaTerminal";
import type { OrcaWorktree } from "./bindings/OrcaWorktree";
import type { PaneNode } from "./bindings/PaneNode";
import type { PaneOp } from "./bindings/PaneOp";
import { $, composing, isMac, partMatcher, tag } from "./dom.js";
import { CHEVRON_SVG, CLAUDE_SVG, FILE_SVG, svgOf, TERMINAL_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { closeMenu, openMenu, showMenu } from "./menu.js";
import { currentScreen, setScreen } from "./nav.js";
import { initOrcaChat } from "./orca-chat.js";
import { closeFile, dirtyIds, filesOf, initOrcaEditor, nameOf, openedIn, openFile as openEditorFile, showEditors } from "./orca-editor.js";
import { filesShown, initOrcaFiles, syncFiles, toggleFiles } from "./orca-files.js";
import { type PaneModel, drawTree, editorHostOf, initPaneTree, type TreeModel } from "./orca-pane-tree.js";
import { applyLocal, findTab, focusedTab, forgetPanes, layoutOf, needsSync, type PaneTabs, panesOf, syncPanes } from "./orca-panes.js";
import { hideTerminals, initOrcaTerminal, type Placement, pruneTerminals, showTerminals } from "./orca-terminal.js";
import { initSplit } from "./split.js";
import { setNavCount, show, showError } from "./view.js";

export const GROUP_LABELS = { waiting: "入力待ち", working: "作業中", done: "完了" } as const;
// The name of each status icon (its `aria-label`), and the status each group of the working view draws.
export const STATUS_LABELS: Record<OrcaStatus, string> = { question: "入力待ち", failed: "失敗", working: "作業中", monitoring: "監視中", interrupted: "中断", done: "完了", idle: "動いていない" };
export const GROUP_STATUS: Record<OrcaRow["group"], OrcaStatus> = { waiting: "question", working: "working", done: "done" };
const ASK_SVG = svgOf('<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>');
const ACTIVITY_SVG = svgOf('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>');
const CLOSE_SVG = svgOf('<path d="M6 6l12 12M18 6L6 18"/>');
export const THIS_MACHINE = "このマシン";
const SHOWN_MS = 10_000;
const HIDDEN_MS = 60_000;

// The last read, or null before the first. A failed read keeps the rows and worktrees of the one before it while the target is the same.
let view: OrcaOverview | null = null;
// The SSH hosts of this machine: the last read that said them (a read that does not say what the target is leaves them).
let ssh: OrcaSshTarget[] = [];
// How much a read asks for (see `orca_overview`).
type Scope = "full" | "screen" | "badge";
// The sidebar button's count: the agents that wait for the user, and the notices (see `track`). The rows held, or what a read for the count alone found.
let waitingCount = 0;
// The rows that work now (group `working`, with a status that says so). A failed read cannot say that any does, so it clears them: the sidebar icon turns yellow and fades while there is one (see `track`).
let workingCount = 0;
// The notices: the panes of the stopped agents (done, failed or interrupted) that changed while the app ran and have not been shown on this screen yet.
const notified = new Set<string>();
// The panes that were stopped when last seen (a pane that left the list stays here, so one that comes back stopped is not noticed again), and whether a read of the target was taken as the base (its rows are never noticed).
let wasStopped = new Set<string>();
let baselined = false;
// The target was just changed and the first read of the new one has not come back: nothing is said about it yet.
let switching = false;
// Reads: the latest request is the one used; one is on its way; when the last one started.
let loadSeq = 0;
let loading = false;
let lastTry = 0;
// The list pane shows the projects, or (the bell pressed) the working agents; the projects come first and the choice is kept in memory.
let working = false;
// The text of the search field (A-19): the list shows the projects and SSH hosts whose name holds it (blank: all of them), and the row the keys are on is `cursor` (a key; one the list does not show leaves the first).
let query = "";
let cursor: string | null = null;
// The project selected (its key; null: none). Its tab selected is the one shown in the pane of its layout that has the focus (`selectedTab`).
let projectKey: string | null = null;
// The projects open in the list (their sessions under them), by key, kept in memory only. Each has its own state: selecting a project opens it, its arrow opens and closes it, and a project that starts to work opens again.
const opened = new Set<string>();
// The projects with a working session, in the order they entered that group. A read does not reorder them (the project list of the read is newest first by activity, which moves with the work); one that starts to work is put first, one that stops leaves the group.
let workingOrder: string[] = [];
// The sessions that worked at the last read that worked, by project (the pane keys of the rows): a project opens when a read has one that was not here.
let workingIds = new Map<string, Set<string>>();
// The target `workingOrder`, `workingIds` and `opened` were made for: the keys of another target are not these.
let workingTarget: string | null = null;
// The groups of the working view that the user closed with their headings (A-6): held in memory only, every group is open at first.
const closedGroups = new Set<OrcaRow["group"]>();
// The host element of each pane drawn, by pane id: the terminals are placed in them.
let paneHosts = new Map<string, HTMLElement>();
// The order tabs were first seen in, so that a read that reorders the sessions does not move the tabs. A tab with a terminal is known by its handle, so a terminal that changes kind (a plain one where Claude starts, or the other way round) keeps its place.
const seen = new Map<string, number>();
// The tabs of Orca whose close was asked for and is not answered.
const closing = new Set<string>();
// A launch or a new terminal (the plus) on its way.
let busy = false;
// The launch or the terminal that was answered: what it started, its pane key and handle (null when Orca's reply gave none), the target and when to stop waiting for its tab. The tab is selected as soon as the list holds it, and no other start is made till then.
let started: { kind: StartKind; paneKey: string | null; handle: string | null; target: string | null; until: number } | null = null;
type StartKind = "claude" | "terminal";
const START_WAIT_MS = 30_000;
// The saved environment whose list is streamed (null: none is, and the list is read by the clock), and the channel of the stream: an event of another channel is not taken.
let streamTarget: string | null = null;
let streamChannel: { onmessage: (event: OrcaStreamEvent) => void } | null = null;
// What the feed, the bell, the tabs, the header and the notice show now; they are drawn again only when this changes.
let feedKey = "";
let bellKey = "";
let headerKey = "";
let noticeKey = "";

const feed = () => $("orca-feed");
const shown = () => currentScreen() === "orca";

const targetName = (v: OrcaOverview) => v.target ?? THIS_MACHINE;
export const worktreeLabel = (w: { repo: string; branch: string }) => `${w.repo} ・ ${w.branch}`;

// How long ago `ms` was: running and waiting agents show the time since their state began ("2 分"), a done one how long ago it ended ("18 分前").
export function elapsed(ms: number, now: number, done: boolean) {
  if (!ms) return "";
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 1) return done ? "たった今" : "1 分未満";
  const text = min < 60 ? `${min} 分` : min < 1440 ? `${Math.floor(min / 60)} 時間` : `${Math.floor(min / 1440)} 日`;
  return done ? `${text}前` : text;
}

// An agent that stopped: finished, failed or interrupted (Orca says an interrupted one as `done` with `interrupted` true).
const isStopped = (r: OrcaRow) => r.group === "done" || r.status === "failed" || r.status === "interrupted";

// The pane of the session this screen shows now: the screen is shown, the window is not hidden, and the session is the selected tab (the side pane of A-9 does not count).
const viewedPane = () => {
  const tab = selectedTab();
  return shown() && !document.hidden && tab?.startsWith("claude:") ? tab.slice("claude:".length) : null;
};

// Takes the rows of a read as the one the count follows (the rows of one read, whatever its scope). The first read of a target is only the base: a notice is made for a row that went from not stopped to stopped,
// or that first appeared in a later read already stopped (a pane seen stopped before is never new, even after it left the list and came back). A notice goes when the agent runs again, leaves the list, or its session is shown. A row with no pane cannot be opened, so it has no notice.
function track(rows: OrcaRow[]) {
  waitingCount = rows.filter((r) => r.group === "waiting").length;
  workingCount = rows.filter((r) => r.group === "working" && (r.status === "working" || r.status === "monitoring")).length;
  const live = new Set<string>();
  for (const r of rows) {
    if (r.paneKey === null) continue;
    live.add(r.paneKey);
    if (!isStopped(r)) {
      notified.delete(r.paneKey);
      wasStopped.delete(r.paneKey);
    } else {
      if (baselined && !wasStopped.has(r.paneKey)) notified.add(r.paneKey);
      wasStopped.add(r.paneKey);
    }
  }
  for (const key of notified) if (!live.has(key)) notified.delete(key);
  baselined = true;
}

// Forgets the notices, the stopped panes seen and the base: the command is gone, or the target changed.
function forgetNotices() {
  waitingCount = 0;
  workingCount = 0;
  notified.clear();
  wasStopped = new Set();
  baselined = false;
}

// ---- icons ----

// The icon of a status (Orca's): the question mark, a ring that turns, the pulse, a green or a faint dot, and a small red or gray one. `label` names it where the word differs ("起動中" for a terminal).
export function statusIcon(status: OrcaStatus, label = STATUS_LABELS[status]) {
  const icon = tag("span", "orca-ic");
  icon.dataset.status = status;
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", label);
  if (status === "question") icon.innerHTML = ASK_SVG;
  else if (status === "monitoring") icon.innerHTML = ACTIVITY_SVG;
  else icon.append(tag("span", `orca-mark ${status}`));
  return icon;
}

// ---- tabs ----

// A tab of the work pane: a Claude session, or a plain terminal of Orca (both are terminals), or a file open in the editor (A-18).
interface Tab {
  id: string;
  kind: "claude" | "plain" | "file";
  status: OrcaStatus;
  label: string;
  title: string;
  // The Orca terminal's handle (a Claude session may have none: it shows no terminal and cannot be closed).
  handle: string | null;
  // The worktree it runs in (a file's: where the file is).
  path: string;
  // The worktree's name, "{repo} ・ {branch}", which the heading of the file pane shows.
  where: string;
}

const claudeTabId = (paneKey: string) => `claude:${paneKey}`;
const plainTabId = (handle: string) => `orca:${handle}`;

// What a tab is known by in `seen`: its handle, else its id. The id changes with the kind of the terminal; the handle does not.
const keyOfTab = (t: Tab) => t.handle ?? t.id;

// The handles of the terminals of the tabs the read holds: the terminals on the screen are known by them.
const liveHandles = () => new Set<string>([...(view?.rows ?? []).flatMap((r) => (r.paneKey === null || r.handle === null ? [] : [r.handle])), ...(view?.terminals ?? []).map((t) => t.handle)]);

// The tabs of the project `key`: its Claude sessions and its plain terminals, in the order they were first seen.
function tabsOf(key: string): Tab[] {
  const tabs: Tab[] = [];
  for (const r of view?.rows ?? []) {
    if (r.projectKey !== key || r.paneKey === null) continue;
    tabs.push({ id: claudeTabId(r.paneKey), kind: "claude", status: r.status, label: STATUS_LABELS[r.status], title: r.line || "（題名なし）", handle: r.handle, path: r.path, where: worktreeLabel(r) });
  }
  for (const t of view?.terminals ?? []) {
    if (t.projectKey !== key) continue;
    const repo = view?.worktrees.find((w) => w.path === t.path)?.repo ?? view?.projects.find((p) => p.key === t.projectKey)?.name ?? "";
    tabs.push({ id: plainTabId(t.handle), kind: "plain", status: "done", label: "起動中", title: t.title || "ターミナル", handle: t.handle, path: t.path, where: worktreeLabel({ repo, branch: t.branch }) });
  }
  for (const f of filesOf(view?.target ?? null, key)) {
    const where = tabs.find((t) => t.path === f.path)?.where ?? view?.worktrees.find((w) => w.path === f.path);
    tabs.push({ id: f.id, kind: "file", status: "done", label: "", title: nameOf(f.relative), handle: null, path: f.path, where: where === undefined ? "" : typeof where === "string" ? where : worktreeLabel(where) });
  }
  // A Claude row that got its handle after it was first seen keeps the place it had under its id.
  for (const t of tabs) if (!seen.has(keyOfTab(t))) seen.set(keyOfTab(t), seen.get(t.id) ?? seen.size);
  return tabs.sort((a, b) => seen.get(keyOfTab(a))! - seen.get(keyOfTab(b))!);
}

// The layout of the selected project's work pane, as Rust answered it (null: no project, or no answer yet).
const currentLayout = () => (projectKey === null ? null : layoutOf(view?.target ?? null, projectKey));

// The tab selected: the one shown in the pane that has the focus (null: no project, no answer yet, or no tab).
const selectedTab = () => focusedTab(currentLayout());

// ---- drawing ----

function drawBadge() {
  const viewed = viewedPane();
  if (viewed !== null) notified.delete(viewed);
  const waiting = waitingCount + notified.size;
  setNavCount("nav-orca", waiting, "Orca", "確認待ち");
  // The number that work is not drawn: the button's icon is yellow and fades, and the label says it (read aloud, and in the tooltip on hover).
  const nav = $("nav-orca");
  nav.classList.toggle("working", workingCount > 0);
  const parts = [...(waiting > 0 ? [`確認待ち ${waiting} 件`] : []), ...(workingCount > 0 ? [`作業中 ${workingCount} 件`] : [])];
  nav.setAttribute("aria-label", parts.length === 0 ? "Orca" : `Orca（${parts.join("、")}）`);
}

// The status label sits at the bottom of the list pane; with an environment saved it is the menu of the targets.
function drawHeader() {
  const v = view;
  const [cls, label] = !v || switching ? ["off", "確認中"] : v.state === "missing" ? ["off", "未インストール"] : v.state === "failed" ? ["warn", `${targetName(v)} に接続できません`] : ["ok", `${targetName(v)} に接続中`];
  // The label is a menu of the targets once an environment is saved (or a saved one is the target, listed or not), plain text before.
  const menu = !!v && (v.environments.length > 0 || v.target !== null);
  const key = JSON.stringify([cls, label, menu]);
  if (key === headerKey) return;
  headerKey = key;
  for (const id of ["orca-status", "orca-target"]) {
    $(id).className = `status ${cls}`;
    $(id).textContent = label;
  }
  $("orca-status").hidden = menu;
  $("orca-target").hidden = !menu;
}

// What a read that did not work says (the Orca screen and the side pane show it alike), else null.
export function noticeOf(v: OrcaOverview | null) {
  return v?.state === "missing" ? "orca コマンドが見つかりません。Orca を入れると、動いているエージェントを見て、指示を送れます" : v?.state === "failed" ? `読み込めませんでした: ${v.message}` : null;
}

function drawNotice() {
  const v = switching ? null : view;
  const text = noticeOf(v);
  const key = JSON.stringify([v?.state, text]);
  if (key === noticeKey) return;
  noticeKey = key;
  if (text === null) return $("orca-notice").replaceChildren();
  const row = tag("div", v?.state === "failed" ? "pending fail" : "pending");
  row.append(tag("span", "sp", text));
  $("orca-notice").replaceChildren(row);
}

// The bell: pressed while the working view shows. At its right shoulder the question icon and the number of agents that wait, else the working mark and the number that work, else nothing.
function drawBell() {
  const rows = view?.rows ?? [];
  const waiting = rows.filter((r) => r.group === "waiting").length;
  const running = rows.filter((r) => r.group === "working").length;
  const key = JSON.stringify([working, waiting, running]);
  if (key === bellKey) return;
  bellKey = key;
  const bell = $("orca-bell");
  bell.setAttribute("aria-pressed", String(working));
  bell.setAttribute("aria-label", working ? "作業中の表示をやめる" : "作業中を表示する");
  const note = $("orca-bell-badge");
  note.hidden = waiting + running === 0;
  note.dataset.kind = waiting ? "question" : "working";
  note.replaceChildren(statusIcon(waiting ? "question" : "working"), String(waiting || running));
}

// The search field belongs to the list of projects: it is hidden in the working view, and its clear button shows while something is typed.
function drawSearch() {
  $("orca-search").hidden = working;
  $("orca-search-clear").hidden = query === "";
}

// The heading of a group is one button: the arrow, the status icon, the name and the number. Pressing it closes the group's rows (the heading and the number stay) or opens them again.
function heading(group: OrcaRow["group"], n: number) {
  const h = tag("h2", `orca-group ${group}`);
  const button = tag("button", "orca-group-btn");
  button.type = "button";
  button.dataset.key = `group:${group}`;
  button.setAttribute("aria-expanded", String(!closedGroups.has(group)));
  const arrow = tag("span", "orca-group-arrow");
  arrow.innerHTML = CHEVRON_SVG;
  button.append(arrow, statusIcon(GROUP_STATUS[group], GROUP_LABELS[group]), GROUP_LABELS[group], tag("span", "orca-count", String(n)));
  button.onclick = () => toggleGroup(group);
  h.append(button);
  return h;
}

function toggleGroup(group: OrcaRow["group"]) {
  if (!closedGroups.delete(group)) closedGroups.add(group);
  draw();
}

// Three lines: the status icon, the title and the time; the latest action; and Claude's mark with the worktree.
function rowNode(r: OrcaRow, key: string, now: number) {
  const row = tag("button", `orca-row ${r.group}`);
  row.type = "button";
  row.dataset.key = key;
  // A row with no pane has no session to read.
  row.disabled = r.paneKey === null;
  row.setAttribute("aria-pressed", String(r.paneKey !== null && claudeTabId(r.paneKey) === selectedTab() && r.projectKey === projectKey));
  const where = tag("span", "orca-where");
  where.innerHTML = CLAUDE_SVG;
  where.append(worktreeLabel(r));
  row.append(statusIcon(r.status), tag("span", "orca-prompt", r.line), tag("span", "orca-time", elapsed(r.atMs, now, r.group === "done")), tag("span", "orca-activity", r.activity), where);
  row.onclick = () => selectRow(r);
  return row;
}

// A session of the open project: its status icon and title, selected when it is the tab selected.
function sessionNode(t: Tab, key: string) {
  const row = tag("button", "orca-session");
  row.type = "button";
  row.dataset.key = `tab:${t.id}`;
  // Not `data-tab`: that names a tab of the work pane, which the pane tree looks for with `closest`.
  row.dataset.session = t.id;
  row.setAttribute("aria-pressed", String(key === projectKey && t.id === selectedTab()));
  row.append(statusIcon(t.status, t.label), tag("span", "orca-session-title", t.title));
  row.onclick = () => selectSession(key, t.id);
  return row;
}

// A project, or an SSH host: its status icon, its name and the number of its sessions (none drawn when there are none). A project with sessions has the arrow at its left, and while it is open its sessions are under it, in the order of the tabs (`tabs`: its tabs other than files).
function projectNode(key: string, name: string, status: OrcaStatus, sessions: number, tabs: Tab[], onCursor: boolean, re: RegExp | null) {
  const wrap = tag("div", "orca-proj");
  const row = tag("button", "orca-project");
  row.type = "button";
  row.dataset.key = key;
  row.setAttribute("aria-pressed", String(key === projectKey));
  if (onCursor) row.dataset.cursor = "true";
  const label = tag("span", "orca-project-name");
  label.append(...nameNodes(name, re));
  row.append(statusIcon(status), label);
  if (sessions > 0) row.append(tag("span", "orca-n", String(sessions)));
  row.onclick = () => selectProject(key);
  wrap.append(row);
  // A row of Orca with no pane gives no tab, so the arrow follows the tabs and not the number.
  if (!tabs.length) return wrap;
  const open = opened.has(key);
  const arrow = tag("button", "icon-btn orca-arrow");
  arrow.type = "button";
  arrow.dataset.key = `arrow:${key}`;
  arrow.setAttribute("aria-expanded", String(open));
  arrow.setAttribute("aria-label", open ? "セッションを閉じる" : "セッションを開く");
  arrow.innerHTML = CHEVRON_SVG;
  arrow.onclick = () => toggleProject(key);
  wrap.append(arrow);
  if (open) {
    const list = tag("div", "orca-sessions");
    list.append(...tabs.map((t) => sessionNode(t, key)));
    wrap.append(list);
  }
  return wrap;
}

function emptyNode(text: string) {
  if (view === null || switching) {
    const loadingRow = tag("div", "pending");
    loadingRow.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    return loadingRow;
  }
  return view.state === "ready" ? tag("div", "feed-empty", text) : tag("div");
}

// A row of the project list: a project of this machine or an SSH host.
type ProjectRow = Pick<OrcaProject, "key" | "name" | "status" | "sessions">;

// Keeps `workingOrder` and `opened` in step with the sessions of a read that worked. A project is in the working group when a session of it works (its own status may be a question, which outranks working), or when its icon works with no working Claude row (another agent, or a worktree's status). One that works and was not in the group enters it at the front (the newest first among those that enter together, as the read lists them); one that does not work leaves it. A project opens when work appears in it that the last read did not have (a working session, or the project's own work with no such session), also when the user closed it; work that went on leaves it as the user left it. The first read of a target puts all that work in, so they all open. A read that failed, or the first one of a new target, says nothing. A project the list no longer holds is forgotten by `opened`.
function trackWorking() {
  if (view === null || view.state !== "ready" || switching) return;
  if (view.target !== workingTarget) {
    workingTarget = view.target;
    workingOrder = [];
    workingIds = new Map();
    opened.clear();
    // The project chosen before the first read of this target (A-9) stays open.
    if (projectKey !== null) opened.add(projectKey);
  }
  const now = new Map<string, Set<string>>();
  for (const r of view.rows) {
    if (r.status !== "working") continue;
    const ids = now.get(r.projectKey) ?? new Set<string>();
    ids.add(r.paneKey ?? `${r.repo}/${r.branch}`);
    now.set(r.projectKey, ids);
  }
  // A project whose icon works with no working Claude row: its own id, which no pane key is.
  for (const p of view.projects) if (p.status === "working" && !now.has(p.key)) now.set(p.key, new Set([`project:${p.key}`]));
  const keys = view.projects.map((p) => p.key).filter((k) => now.has(k));
  const kept = workingOrder.filter((k) => keys.includes(k));
  for (const k of keys) if ([...now.get(k)!].some((id) => !workingIds.get(k)?.has(id))) opened.add(k);
  workingOrder = [...keys.filter((k) => !kept.includes(k)), ...kept];
  workingIds = now;
  const known = new Set([...view.projects.map((p) => p.key), ...view.hosts.map((h) => h.key), ...ssh.map((t) => `ssh:${t.id}`)]);
  for (const k of opened) if (!known.has(k)) opened.delete(k);
}

// The rows of the list: the projects of the target (the working ones first, in the order they began to work, then the stopped ones, which have a session and do not work, then those with no session, both as the read lists them), then the SSH hosts (the machine's, then the target's that it does not list).
function projectRows(): { local: ProjectRow[]; hosts: ProjectRow[] } {
  const all: ProjectRow[] = view?.projects ?? [];
  const rest = all.filter((p) => !workingOrder.includes(p.key));
  const local: ProjectRow[] = [...workingOrder.flatMap((k) => all.filter((p) => p.key === k)), ...rest.filter((p) => p.sessions > 0), ...rest.filter((p) => p.sessions === 0)];
  const hosts: ProjectRow[] = ssh.map((t) => {
    const host = view?.hosts.find((h) => h.key === `ssh:${t.id}`);
    return { key: `ssh:${t.id}`, name: t.label, status: host?.status ?? "idle", sessions: host?.sessions ?? 0 };
  });
  for (const h of view?.hosts ?? []) if (!hosts.some((r) => r.key === h.key)) hosts.push(h);
  return { local, hosts };
}

// The search text (A-19), trimmed, and as a regular expression (`partMatcher` of dom.ts: special characters escaped, a case-folded part of a name). The expression is made once for each drawing (null while nothing is typed); its capture group serves `split` below.
const needle = () => query.trim();
const matcher = () => partMatcher(query);

// A name with the letters that match the search text in bold (`split` with a capture group puts the matches at the odd places).
function nameNodes(name: string, re: RegExp | null): (string | HTMLElement)[] {
  if (re === null) return [name];
  return name
    .split(re)
    .map((part, i) => (i % 2 ? tag("b", "", part) : part))
    .filter((part) => part !== "");
}

// The rows the list shows: all of them, or those whose name holds the search text. Only the name is searched (not the sessions under a project), so the sessions of an open project that the search leaves out go with its row.
function visibleRows(re: RegExp | null) {
  const { local, hosts } = projectRows();
  if (re === null) return { local, hosts };
  return { local: local.filter((r) => re.test(r.name)), hosts: hosts.filter((r) => re.test(r.name)) };
}

// The keys of the rows the keys of the search field can reach, in the order of the list (none while nothing is typed), and the one they are on.
function reachable(rows = visibleRows(matcher())) {
  if (needle() === "") return [];
  return [...rows.local, ...rows.hosts].map((r) => r.key);
}
function cursorKey(rows = visibleRows(matcher())) {
  const keys = reachable(rows);
  return cursor !== null && keys.includes(cursor) ? cursor : (keys[0] ?? null);
}

// `openTabs`: the tabs other than files of the open projects, found once for the drawing; the others are found here.
function projectNodes(re: RegExp | null, rows: ReturnType<typeof visibleRows>, on: string | null, openTabs: Map<string, Tab[]>): HTMLElement[] {
  const { local, hosts } = rows;
  const node = (r: ProjectRow) => projectNode(r.key, r.name, r.status, r.sessions, openTabs.get(r.key) ?? tabsOf(r.key).filter((t) => t.kind !== "file"), r.key === on, re);
  const nodes: HTMLElement[] = local.map(node);
  if (hosts.length) nodes.push(tag("h3", "orca-sec", "SSH"), ...hosts.map(node));
  return nodes.length ? nodes : [emptyNode(needle() === "" ? "プロジェクトがありません" : "一致するプロジェクトがありません")];
}

function workingNodes(now: number): HTMLElement[] {
  const rows = view?.rows ?? [];
  const nodes: HTMLElement[] = [];
  for (const group of ["waiting", "working", "done"] as const) {
    const list = rows.filter((r) => r.group === group);
    if (!list.length) continue;
    nodes.push(heading(group, list.length));
    if (!closedGroups.has(group)) nodes.push(...list.map((r) => rowNode(r, r.paneKey ?? `${group}/${r.repo}/${r.branch}/${r.line}`, now)));
  }
  return nodes.length ? nodes : [emptyNode("動いているエージェントはありません")];
}

// Draws the list where it is: the scroll position and the focused row stay, and nothing is drawn when nothing changed.
function drawFeed() {
  const now = Date.now();
  trackWorking();
  // The sessions under the open projects: what is drawn of them.
  const openTabs = new Map([...opened].map((k): [string, Tab[]] => [k, tabsOf(k).filter((t) => t.kind !== "file")]));
  const sessions = [...openTabs].map(([k, tabs]) => [k, tabs.map((t) => [t.id, t.status, t.label, t.title])]);
  // Only what is drawn: a project's time of activity moves with the work and would redraw the list (and restart the working mark) for nothing.
  const rowOf = (p: OrcaProject) => [p.key, p.name, p.status, p.sessions];
  // The rows of the projects, the search expression and the row the keys are on: found once for this drawing.
  const re = working ? null : matcher();
  const rows = visibleRows(re);
  const on = working ? null : cursorKey(rows);
  const key = JSON.stringify([working, view?.state ?? null, working ? view?.rows : [view?.projects.map(rowOf), view?.hosts.map(rowOf), ssh, needle(), on], projectKey, sessions, selectedTab(), switching, [...closedGroups], Math.floor(now / 60_000)]);
  if (key === feedKey) return;
  feedKey = key;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  box.replaceChildren(...(working ? workingNodes(now) : projectNodes(re, rows, on, openTabs)));
  box.scrollTop = top;
  if (focused) box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function tabNode(t: Tab, selected: boolean) {
  const wrap = tag("div", "orca-tab");
  wrap.dataset.tab = t.id;
  wrap.setAttribute("role", "presentation");
  const select = tag("button", "orca-tab-btn");
  select.type = "button";
  select.setAttribute("role", "tab");
  select.setAttribute("aria-selected", String(selected));
  select.append(t.kind === "file" ? fileIcon() : statusIcon(t.status, t.label), tag("span", "orca-tab-title", t.title));
  if (t.kind === "file") {
    wrap.dataset.file = "true";
    if (dirtyIds().has(t.id)) {
      const unsaved = tag("span", "orca-tab-dirty");
      unsaved.setAttribute("role", "img");
      unsaved.setAttribute("aria-label", "未保存");
      select.append(unsaved);
    }
  }
  select.onclick = () => selectTab(t.id);
  // The close button is beside the tab, not in it, so that pressing it never selects the tab.
  const close = tag("button", "icon-btn orca-tab-close");
  close.type = "button";
  close.setAttribute("aria-label", "閉じる");
  close.innerHTML = CLOSE_SVG;
  close.disabled = (t.kind === "claude" && t.handle === null) || closing.has(t.id);
  close.onclick = () => closeTab(t);
  wrap.append(select, close);
  return wrap;
}

// The mark of a file's tab (the status icon of a terminal's).
function fileIcon() {
  const icon = tag("span", "orca-ic orca-file-tab-ic");
  icon.innerHTML = FILE_SVG;
  return icon;
}

// The line under a pane's strip that says why it shows no terminal, else null.
function emptyText(tabs: Tab[], tab: Tab | undefined) {
  if (started !== null) return null;
  if (projectKey === null) return "プロジェクトを選んでください";
  if (tabs.length === 0) return "セッションはありません";
  return tab !== undefined && tab.kind !== "file" && tab.handle === null ? "このセッションのターミナルはありません" : null;
}

// The tree of the layout for drawing: each pane with the tabs it holds that the list still has (a tab that left shows no more before Rust's next answer), and the one it shows.
// A tab id the layout holds from before a terminal changed kind is taken as the tab with the same handle (`find`) until Rust's answer.
function treeOf(node: PaneNode, tabs: Tab[], focus: string | null, plusDisabled: boolean, find: (id: string) => Tab | undefined): TreeModel {
  if (node.kind === "split") return { kind: "split", direction: node.direction, children: node.children.map((c) => treeOf(c, tabs, focus, plusDisabled, find)) };
  const mine = [...new Set(node.tabs.flatMap((id) => find(id) ?? []))];
  const dirty = dirtyIds();
  const selected = find(node.selected);
  const tab = mine.find((t) => t.id === selected?.id);
  const pane: PaneModel = {
    id: node.id,
    key: JSON.stringify([mine, node.selected, [...closing], mine.filter((t) => dirty.has(t.id)).map((t) => t.id)]),
    tabs: () => mine.map((t) => tabNode(t, t.id === tab?.id)),
    focused: node.id === focus,
    empty: emptyText(tabs, tab),
    terminal: !!tab?.handle,
    editor: tab?.kind === "file",
    plusDisabled,
    filesShown: filesShown(),
  };
  return { kind: "pane", pane };
}

// The work pane follows the layout: the panes with their tab strips (a project with no layout yet, or with no tab, has one empty pane), and the terminal of the tab selected in each pane, else a line that says why there is none.
function drawWork(tabs: Tab[]) {
  syncLayout(tabs);
  const layout = currentLayout();
  const plusDisabled = busy || startWaits() || projectKey === null || view === null || view.state === "missing";
  const empty: TreeModel = { kind: "pane", pane: { id: "", key: "", tabs: () => [], focused: false, empty: emptyText(tabs, undefined), terminal: false, editor: false, plusDisabled, filesShown: filesShown() } };
  paneHosts = drawTree(layout?.root ? treeOf(layout.root, tabs, layout.focus, plusDisabled, (id) => findTab(view?.target ?? null, projectKey!, tabs, id)) : empty);
  drawStarted();
}

// Shows the terminal of the tab selected in each pane while the screen is shown: streamed from a saved environment, mirrored on this machine.
function syncTerminal(tabs: Tab[] = projectKey === null ? [] : tabsOf(projectKey)) {
  const layout = shown() ? currentLayout() : null;
  const placements: Placement[] = [];
  for (const pane of panesOf(layout?.root ?? null)) {
    const tab = findTab(view?.target ?? null, projectKey!, tabs, pane.selected);
    const host = paneHosts.get(pane.id);
    if (tab?.handle && host) placements.push({ id: tab.handle, source: { kind: streaming() ? "stream" : "mirror", handle: tab.handle, path: tab.path, environment: view?.target ?? null }, host });
  }
  if (placements.length === 0) return hideTerminals();
  showTerminals(placements, findTab(view?.target ?? null, projectKey!, tabs, selectedTab() ?? "")?.handle ?? null);
}

// Shows the editor of the file tab selected in each pane while the screen is shown.
function syncEditor(tabs: Tab[]) {
  const layout = shown() ? currentLayout() : null;
  const placements: { id: string; host: HTMLElement }[] = [];
  for (const pane of panesOf(layout?.root ?? null)) {
    const tab = findTab(view?.target ?? null, projectKey!, tabs, pane.selected);
    const host = editorHostOf(pane.id);
    if (tab?.kind === "file" && host) placements.push({ id: tab.id, host });
  }
  showEditors(placements);
}

// The worktree the file pane shows: the selected tab's, else (no tab) the main worktree of the selected project. An SSH host's row has no files to read, so a project with no tab gives none there.
function filesWorktree(tabs: Tab[]): { path: string; label: string } | null {
  const tab = findTab(view?.target ?? null, projectKey ?? "", tabs, selectedTab() ?? "");
  if (tab !== undefined) return { path: tab.path, label: tab.where };
  if (projectKey === null || projectKey.startsWith("ssh:")) return null;
  const main = view?.worktrees.find((w) => w.projectKey === projectKey && w.isMain);
  // A project with tabs whose layout is not answered yet has no selected tab for a moment: nothing is read for it,
  // except when the only tabs are files of the main worktree (the first file opened in a project with no tab), whose tree stays.
  if (tabs.some((t) => t.kind !== "file" || t.path !== main?.path)) return null;
  return main === undefined ? null : { path: main.path, label: worktreeLabel(main) };
}

// The file pane follows its worktree and the files open in it.
function drawFiles(tabs: Tab[]) {
  const worktree = filesWorktree(tabs);
  const target = view?.target ?? null;
  syncFiles(worktree === null ? null : { target, path: worktree.path, label: worktree.label }, worktree === null || projectKey === null ? new Set() : openedIn(target, projectKey, worktree.path));
}

// A file of the file pane was pressed twice: it opens as a tab in the focused pane and is selected, and the editor takes the typing.
function openFile(relative: string) {
  const worktree = projectKey === null ? null : filesWorktree(tabsOf(projectKey));
  if (worktree === null || projectKey === null || view === null) return;
  started = null;
  const id = openEditorFile(view.target, projectKey, worktree.path, relative);
  // The select asks Rust for the layout with the new tab in it (`runPaneOp` reads the tabs when it asks).
  chooseTab(id);
  draw();
}

// The note of a start that was answered: it waits for the tab of the session, or (Orca named neither its pane nor its terminal) says it was started.
function drawStarted() {
  const box = $("orca-started");
  box.hidden = started === null;
  if (box.hidden) return;
  const waiting = startWaits();
  const key = String(waiting);
  if (box.dataset.state === key) return;
  box.dataset.state = key;
  box.replaceChildren(...(waiting ? [tag("span", "spin"), tag("span", "sp", "セッションを始めました。一覧に現れるのを待っています…")] : [tag("span", "sp", "セッションを始めました。Orca の画面で開けます。")]));
}

// Takes a read as the one shown. A read that did not learn the target and the environments (a poll, or a failed `environment list`) leaves the ones held (and the SSH hosts);
// a failed read keeps the rows, worktrees, projects and terminals held while the target is the same; a missing command empties them.
function adopt(read: OrcaOverview) {
  const next = !read.known && view !== null ? { ...read, target: view.target, environments: view.environments } : read;
  const keep = next.state === "failed" && view !== null && view.state !== "missing" && view.target === next.target;
  // A target that changed without `chooseTarget` (the saved one is gone, or the file was changed): the notices and the base of the old one are not the new one's.
  if (view !== null && next.target !== view.target) forgetNotices();
  view = keep ? { ...next, rows: view!.rows, worktrees: view!.worktrees, projects: view!.projects, hosts: view!.hosts, terminals: view!.terminals } : next;
  if (read.known) ssh = read.ssh;
  if (view.state === "ready") track(view.rows);
  else if (view.state === "missing") forgetNotices();
  else workingCount = 0;
  switching = false;
  // A terminal that left Orca's list leaves the tabs, with its screen.
  if (!keep && view.state === "ready") {
    const held = liveHandles();
    pruneTerminals((handle) => held.has(handle));
  }
  if (view.state === "ready") forgetGone();
  claimStarted();
}

// A start that gave a pane key or a handle waits for its tab: a Claude session's row is matched by either (as the side pane of A-9 does), a terminal by its handle.
const startWaits = () => started !== null && (started.paneKey !== null || started.handle !== null);

// A start whose tab the read holds now is selected (its project and its tab, so its terminal shows); one that waited too long, even if the read failed, or one for another target, is dropped.
function claimStarted() {
  if (!startWaits()) return;
  const wait = started!;
  if (Date.now() > wait.until) {
    started = null;
    return;
  }
  if (view === null || view.state !== "ready") return;
  const same = wait.target === view.target;
  const row = same && wait.kind === "claude" ? view.rows.find((r) => (wait.paneKey !== null && r.paneKey === wait.paneKey) || (wait.handle !== null && r.handle === wait.handle)) : undefined;
  const terminal = same && wait.kind === "terminal" && wait.handle !== null ? view.terminals.find((t) => t.handle === wait.handle) : undefined;
  if (row?.paneKey) pickRow(row);
  if (terminal) pickTerminal(terminal);
  if (row || terminal || !same) started = null;
}

// The order of tabs that are no longer anywhere is dropped, so it does not pile up.
function forgetGone() {
  const live = new Set<string>([...(view?.rows ?? []).flatMap((r) => (r.paneKey === null ? [] : [r.handle ?? claudeTabId(r.paneKey)])), ...(view?.terminals ?? []).map((t) => t.handle), ...filesOf(view?.target ?? null, projectKey ?? "").map((f) => f.id)]);
  for (const key of seen.keys()) if (!live.has(key)) seen.delete(key);
}

function draw() {
  drawBadge();
  if (!shown()) return;
  drawHeader();
  drawNotice();
  drawBell();
  drawSearch();
  const tabs = projectKey === null ? [] : tabsOf(projectKey);
  drawFeed();
  drawWork(tabs);
  drawFiles(tabs);
  syncTerminal(tabs);
  syncEditor(tabs);
}

// ---- the stream of a saved environment ----

// Whether the list of the target held is streamed.
const streaming = () => streamTarget !== null && streamTarget === view?.target;

// Streams the list while the target is a saved environment that is listed (and the command is there), and ends the stream otherwise. The stream tries a lost connection again by itself.
function syncStream() {
  const want = view !== null && view.state !== "missing" && !switching && view.target !== null && view.environments.includes(view.target) ? view.target : null;
  if (want === streamTarget) return;
  // A new stream ends the old one by itself: a close is a call of its own, which could reach Rust after the open and end the new stream.
  if (streamTarget !== null && want === null) invoke("orca_stream_close").catch(() => {});
  streamTarget = want;
  streamChannel = null;
  if (want === null) return;
  const channel = new window.__TAURI__.core.Channel<OrcaStreamEvent>();
  streamChannel = channel;
  channel.onmessage = (event) => {
    if (streamChannel === channel && view?.target === want) onStream(event);
  };
  invoke("orca_stream_open", { environment: want, channel }).catch((e) => {
    if (streamChannel === channel && view?.target === want) onStream({ kind: "status", live: false, message: String(e) });
  });
}

// A list of the stream is taken as a read that worked; a lost connection as one that failed (the rows stay, and the status says so until the list comes again).
function onStream(event: OrcaStreamEvent) {
  if (view === null) return;
  if (event.kind === "status") {
    if (event.live) return;
    adopt({ ...view, state: "failed", message: event.message, ssh: [], known: false });
  } else {
    adopt({ ...view, state: "ready", message: "", rows: event.rows, worktrees: event.worktrees, projects: event.projects, hosts: event.hosts, terminals: event.terminals, ssh: [], known: false });
  }
  draw();
}

// What a read after a failure, the first one and one with the command missing ask for: everything. A working list is read for its agents (the screen shown) or their count.
const clockScope = (): Scope => (view?.state !== "ready" ? "full" : shown() ? "screen" : "badge");

// Reads the list. Only the latest request is used; `force` starts one although another is on its way (after a launch, a close or a change of the target).
async function load(scope: Scope, force = false) {
  if (loading && !force) return;
  const seq = ++loadSeq;
  loading = true;
  lastTry = Date.now();
  let next: OrcaOverview;
  try {
    next = await invoke("orca_overview", { scope, target: view?.target ?? null });
  } catch (e) {
    next = { state: "failed", message: String(e), target: null, environments: [], rows: [], worktrees: [], projects: [], hosts: [], terminals: [], ssh: [], known: false };
  }
  if (seq !== loadSeq) return;
  loading = false;
  lastTry = Date.now();
  // A read for the count alone has no terminals: it only moves the count, and a failure of it is left to the next read.
  if (scope === "badge" && next.state !== "missing") {
    if (next.state === "ready") track(next.rows);
    else workingCount = 0;
    drawBadge();
    return;
  }
  adopt(next);
  syncStream();
  draw();
}

function refresh() {
  // The terminals are shown only while the screen is shown.
  if (!shown()) syncTerminal();
  // The wait for a new tab ends after its 30 seconds, also while a streamed list is not read by the clock.
  if (startWaits() && Date.now() > started!.until) {
    started = null;
    draw();
  }
  // A streamed list is not read by the clock.
  if (document.hidden || loading || streaming()) return;
  // A missing command is not looked for again by the clock.
  if (view?.state === "missing") return;
  if (Date.now() - lastTry >= (shown() ? SHOWN_MS : HIDDEN_MS)) load(clockScope());
}

// ---- the side pane's share (A-9) ----

// The last read, for a side pane to draw at once while it reads again.
export const heldOrca = () => view;

// Reads the list for a side pane (the agents with their terminals, and the worktrees), whatever screen is shown, and gives what is held after it. `force` starts the read although another is on its way (the first read of a pane and the read after a send); the poll of a shown session does not. The first read of the app asks for the target too.
export async function refreshOrca(force: boolean) {
  // A streamed list is what Orca holds now.
  if (!streaming()) await load(view?.state === "ready" ? "screen" : "full", force);
  return view;
}

// Reads the lists of one destination for the side pane (A-9), whatever target the Orca screen holds, and changes nothing of the screen. A `force` false (the poll of a shown session) does not ask for the saved environments again. A read that threw is a failed one.
export async function readDestination(environment: string | null, force: boolean): Promise<OrcaOverview> {
  try {
    return await invoke("orca_destination", { environment, force });
  } catch (e) {
    return { state: "failed", message: String(e), target: environment, environments: [], rows: [], worktrees: [], projects: [], hosts: [], terminals: [], ssh: [], known: false };
  }
}

// Selects the session of the pane `paneKey` on the Orca screen and shows the screen ("Orca の画面で開く"). A session the list does not hold yet leaves the selection as it is.
export function openInOrca(paneKey: string | null) {
  const row = paneKey === null ? null : (view?.rows.find((r) => r.paneKey === paneKey) ?? null);
  if (row) {
    setProject(row.projectKey);
    chooseTab(claudeTabId(row.paneKey!));
  }
  setScreen("orca");
}

// The Orca screen is shown: what was read stays on screen while a new read is on its way.
export function showOrca() {
  show("orca");
  headerKey = noticeKey = feedKey = bellKey = "";
  draw();
  // The environments are read when the screen is shown, whatever read is on its way.
  load("full", true);
}

async function chooseTarget(environment: string | null) {
  if (view === null || environment === view.target) return;
  loadSeq++;
  loading = false;
  try {
    await invoke("orca_set_target", { environment });
  } catch (e) {
    showError(e);
    return;
  }
  // The sessions and worktrees belong to the old target, and so do the terminals' screens and the stream.
  setProject(null);
  started = null;
  forgetPanes();
  pruneTerminals(() => false);
  view = { ...view, target: environment, rows: [], worktrees: [], projects: [], hosts: [], terminals: [] };
  forgetNotices();
  switching = true;
  syncStream();
  draw();
  load("full", true);
}

function openTargetMenu(anchor: Element) {
  if (view === null) return;
  const items = [null, ...view.environments].map((name) => ({ label: name ?? THIS_MACHINE, color: "var(--accent)", current: name === view!.target, pick: () => chooseTarget(name) }));
  openMenu(anchor, items);
}

// The dialog of the worktrees, narrowed by a filter on `{repo} ・ {branch}`, under the plus of the work pane and under the chip of the side pane of A-9. A pick closes it.
export function openWorktreeDialog(anchor: Element, worktrees: OrcaWorktree[], chosen: string | null, pick: (path: string) => void) {
  const pop = tag("div", "menu orca-dest-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "起動先の worktree");
  const filter = tag("input");
  filter.setAttribute("aria-label", "worktree を絞り込む");
  filter.placeholder = "worktree を絞り込む";
  filter.autocomplete = "off";
  const rows = tag("div", "orca-dest-list");
  const drawRows = () => {
    const q = filter.value.trim().toLowerCase();
    const hits = worktrees.filter((w) => worktreeLabel(w).toLowerCase().includes(q));
    rows.replaceChildren(
      ...(hits.length
        ? hits.map((w) => {
            const b = tag("button");
            b.type = "button";
            b.dataset.path = w.path;
            b.setAttribute("aria-current", String(w.path === chosen));
            b.append(tag("b", "", w.repo), tag("span", "", w.branch));
            b.onclick = () => {
              closeMenu();
              pick(w.path);
            };
            return b;
          })
        : [tag("p", "empty", "該当する worktree がありません")]),
    );
  };
  filter.oninput = drawRows;
  drawRows();
  pop.append(filter, rows);
  showMenu(anchor, pop);
  filter.focus();
}

// ---- selecting and closing ----

// Makes `key` the selected project, open in the list (the others stay as they are).
function setProject(key: string | null) {
  projectKey = key;
  if (key !== null) opened.add(key);
}

// Selects the project and, in it, the tab last selected there, else the first. The project opens.
function selectProject(key: string) {
  started = null;
  setProject(key);
  draw();
}

// The arrow of a project: opens or closes its sessions in the list, and only that (the selection, the tabs and the work pane stay as they are).
function toggleProject(key: string) {
  if (!opened.delete(key)) opened.add(key);
  draw();
}

// A session of an open project: selects the project and its tab.
function selectSession(key: string, id: string) {
  started = null;
  setProject(key);
  chooseTab(id);
  draw();
}

function selectTab(id: string) {
  started = null;
  chooseTab(id);
  draw();
}

// Asks Rust for the layout of the selected project, with `op` when the user did something to it; the screen is drawn again once it answers. A failure shows its message.
function runPaneOp(op: PaneOp | null) {
  const key = projectKey;
  if (key === null || view === null) return;
  const target = view.target;
  const tabs = (): PaneTabs | null => {
    if (view === null || view.target !== target || view.state === "missing" || switching) return null;
    const now = tabsOf(key);
    return { ids: now.map((t) => t.id), handles: Object.fromEntries(now.flatMap((t) => (t.handle === null ? [] : [[t.id, t.handle]]))) };
  };
  syncPanes(target, key, tabs, op, () => draw(), showError);
}

// Asks for the layout when the project's tabs are not the ones it was asked for with (the first time, and each time a tab came or went); only a read that worked says what the tabs are.
function syncLayout(tabs: Tab[]) {
  if (projectKey === null || view === null || view.state !== "ready" || switching) return;
  if (needsSync(view.target, projectKey, tabs.map((t) => t.id))) runPaneOp(null);
}

// Selects the tab in its pane and gives the pane the focus, at once and then in Rust (nothing is asked when it is the selected tab already).
function chooseTab(id: string) {
  if (projectKey === null || view === null || selectedTab() === id) return;
  const op: PaneOp = { kind: "select", tab: id };
  applyLocal(view.target, projectKey, op);
  runPaneOp(op);
}

// The pane was pressed: it takes the focus.
function focusPane(pane: string) {
  const layout = currentLayout();
  if (projectKey === null || view === null || layout === null || layout.focus === pane || !panesOf(layout.root).some((p) => p.id === pane)) return;
  const op: PaneOp = { kind: "focus", pane };
  applyLocal(view.target, projectKey, op);
  runPaneOp(op);
  draw();
}

// A row of the working view selects its project and its tab.
function selectRow(r: OrcaRow) {
  if (r.paneKey === null) return;
  started = null;
  pickRow(r);
  draw();
}

// Makes the row's project and tab the selection (the row has a pane key).
function pickRow(r: OrcaRow) {
  setProject(r.projectKey);
  chooseTab(claudeTabId(r.paneKey!));
}

// Makes the plain terminal's project and tab the selection.
function pickTerminal(t: OrcaTerminal) {
  setProject(t.projectKey);
  chooseTab(plainTabId(t.handle));
}

// Closes a tab. An Orca terminal is closed in Orca, and the list is read at once: it leaves the tabs then, and a failure keeps the tab and shows the message.
async function closeTab(tab: Tab) {
  if (closing.has(tab.id)) return;
  closing.add(tab.id);
  draw();
  if (tab.kind === "file") {
    // A file is closed here once its typing is saved (a save that cannot be made keeps the tab, and its message was shown).
    await closeFile(tab.id);
    closing.delete(tab.id);
    draw();
    return;
  }
  try {
    await invoke("orca_close", { handle: tab.handle!, environment: view?.target ?? null });
  } catch (e) {
    showError(e);
    closing.delete(tab.id);
    draw();
    return;
  }
  closing.delete(tab.id);
  draw();
  // A streamed list says the close by itself.
  if (!streaming()) load(clockScope(), true);
}

// The menu of a tab (the right button): it splits its pane, which takes the tab to a new pane at its right or below it. A pane with one tab cannot be split, so it has no menu.
function openTabMenu(anchor: Element, tab: string, pane: string) {
  if ((panesOf(currentLayout()?.root ?? null).find((p) => p.id === pane)?.tabs.length ?? 0) < 2) return;
  const item = (label: string, edge: "right" | "bottom") => ({ label, color: "var(--accent)", current: false, pick: () => runPaneOp({ kind: "move", tab, pane, edge }) });
  openMenu(anchor, [item("右に分割", "right"), item("下に分割", "bottom")]);
}

// The plus (A-16): a menu of "Claude を起動" and "ターミナルを開く", which start in a worktree of the project (or SSH host) selected in the list pane.
function openStartMenu(anchor: Element) {
  if (view === null || projectKey === null) return;
  const item = (label: string, icon: string, kind: StartKind) => ({ label, color: "var(--accent)", icon, current: false, pick: () => chooseWorktree(anchor, kind) });
  openMenu(anchor, [item("Claude を起動", CLAUDE_SVG, "claude"), item("ターミナルを開く", TERMINAL_SVG, "terminal")]);
}

// A project with one worktree starts in it at once; with none or more than one, the dialog of the worktrees narrowed to the project's asks (a project with none says so there).
function chooseWorktree(anchor: Element, kind: StartKind) {
  if (view === null || projectKey === null) return;
  const mine = view.worktrees.filter((w) => w.projectKey === projectKey);
  if (mine.length === 1) void start(kind, mine[0].path);
  else openWorktreeDialog(anchor, mine, null, (path) => start(kind, path));
}

// Starts Claude (with no first prompt: the user types it in the terminal) or a plain terminal in the worktree, once; a failure shows its message. The project and its tab stay selected, and the new tab is followed: once the list holds it, it is selected.
async function start(kind: StartKind, path: string) {
  if (busy || startWaits() || view === null) return;
  const target = view.target;
  const [from, tab] = [projectKey, selectedTab()];
  busy = true;
  started = null;
  draw();
  try {
    const launched = await invoke(kind === "claude" ? "orca_start" : "orca_terminal_create", { path, environment: target });
    // A selection made while the start was on its way is not left for the new tab.
    if (projectKey === from && selectedTab() === tab) {
      started = { kind, paneKey: launched.paneKey, handle: launched.handle, target, until: Date.now() + START_WAIT_MS };
      // A streamed list that held the new tab before this reply came is matched now; no event is to come for it.
      claimStarted();
    }
    if (!streaming()) load(clockScope(), true);
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
    draw();
  }
}

// The button of the file pane (A-18) is in the top row of the pane while it is shown, and at the right end of the tab strip of the corner pane while it is hidden.
// The pressed button is hidden by the draw, so the focus goes on to the button that is shown now.
function toggleFilesAndDraw() {
  const focused = document.activeElement?.classList.contains("orca-files-toggle") ?? false;
  toggleFiles();
  draw();
  if (focused) {
    const shown = [...document.querySelectorAll<HTMLElement>(".orca-files-toggle")].find((b) => b.offsetParent !== null);
    shown?.focus({ preventScroll: true });
  }
}

// ---- the search field (A-19) ----

const searchInput = () => $<HTMLInputElement>("orca-search-input");

// What a change of the text or of the row the keys are on redraws: the field and the list. The work pane does not change with it.
function drawSearchList() {
  drawSearch();
  drawFeed();
}

// Ends the search: the list is the whole list again.
function clearSearch() {
  query = "";
  cursor = null;
  searchInput().value = "";
  drawSearchList();
}

// ⌘J: the field takes the focus with its text selected. The working view has no field, so it gives way to the projects.
function focusSearch() {
  working = false;
  draw();
  searchInput().focus();
  searchInput().select();
}

// ↑ and ↓ move the row the keys are on along the rows the search leaves, and stop at the first and the last.
function moveCursor(step: number) {
  const keys = reachable();
  const at = cursorKey();
  if (at === null) return;
  cursor = keys[Math.min(keys.length - 1, Math.max(0, keys.indexOf(at) + step))];
  drawSearchList();
  feed().querySelector('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
}

function initSearch() {
  const input = searchInput();
  input.oninput = () => {
    query = input.value;
    cursor = null;
    drawSearchList();
  };
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key === "Escape") {
      clearSearch();
      input.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveCursor(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      const key = cursorKey();
      if (key !== null) selectProject(key);
    }
  };
  $("orca-search-clear").onclick = () => {
    clearSearch();
    input.focus();
  };
  // Capture phase, so that a terminal or the editor with the focus does not take the key first.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!shown() || e.key !== "j" || !(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey || composing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      focusSearch();
    },
    true,
  );
}

export function initOrca() {
  // The history of A-7 is read only by the side pane of A-9 now; it still pauses with the window.
  initOrcaChat();
  initOrcaTerminal(showError);
  initSplit($("orca"), $("orca-split"), { side: "left", min: 0.2, max: 0.5, initial: 0.25, property: "--list-w" });
  initSplit($("orca"), $("orca-files-split"), { side: "right", min: 0.15, max: 0.4, initial: 0.22, property: "--files-w" });
  initOrcaEditor({ changed: draw, error: showError });
  initOrcaFiles({ open: openFile, toggle: toggleFilesAndDraw });
  setInterval(refresh, 1000);
  document.addEventListener("visibilitychange", () => {
    // A session shown again after the window was hidden is seen.
    drawBadge();
    refresh();
  });
  initSearch();
  $("orca-refresh").onclick = () => load("full", true);
  $("orca-bell").onclick = () => {
    working = !working;
    draw();
  };
  $("orca-target").onclick = (e) => openTargetMenu(e.currentTarget as Element);
  initPaneTree($("orca-panes"), {
    plus: (anchor, pane) => {
      focusPane(pane);
      openStartMenu(anchor);
    },
    files: toggleFilesAndDraw,
    focus: focusPane,
    move: (tab, pane, edge) => runPaneOp({ kind: "move", tab, pane, edge }),
    menu: openTabMenu,
  });
  load("full");
}
