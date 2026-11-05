// The Orca screen (A-6, A-7, A-8): two panes. The list pane is the projects (a repository of this machine, an SSH host) or, with the bell pressed, the Claude agents that run in Orca in three groups (waiting for the user, working, done);
// the work pane has the sessions of the selected project as tabs: a Claude session shows its history (orca-chat.ts) and a composer that posts to it, a terminal fills the pane (orca-terminal.ts).
// With no project selected the work pane is the start of a new Claude session. Nothing about a session is kept here except the terminals of the app, which end with it.
// The list is read at startup for the sidebar button's count, every 10 seconds while the screen is shown and every 60 seconds otherwise, one read at a time, and no more once the `orca` command was found missing (the update button reads again).
// Only the first read, the screen being shown, the update button, a change of the target and a read after a failure ask for the environments (and the SSH hosts); the clock reads the agents (the screen shown) or only their count (another screen).
// The sidebar button's count is the agents that wait for the user plus the notices: the agents that stopped (done, failed, interrupted) while the app ran, until their session is shown on this screen, they run again or they leave the list (the first read of a target only sets the base).
// A read in the background swaps the rows in place: the selection, the text in the composer and the scroll position stay, and `show()` is never called by it.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaProject } from "./bindings/OrcaProject";
import type { OrcaRow } from "./bindings/OrcaRow";
import type { OrcaSkill } from "./bindings/OrcaSkill";
import type { OrcaSshTarget } from "./bindings/OrcaSshTarget";
import type { OrcaStatus } from "./bindings/OrcaStatus";
import type { OrcaTerminalTargets } from "./bindings/OrcaTerminalTargets";
import type { OrcaWorktree } from "./bindings/OrcaWorktree";
import { $, composing, tag } from "./dom.js";
import { CLAUDE_SVG, svgOf } from "./icons.js";
import { invoke, type TerminalTarget } from "./ipc.js";
import { closeMenu, openMenu, showMenu } from "./menu.js";
import { currentScreen, setScreen } from "./nav.js";
import { closeChat, initOrcaChat, isChatOwner, makeChatView, openChat, setChatWorking } from "./orca-chat.js";
import { closePty, hideTerminals, initOrcaTerminal, pruneMirrors, showTerminal, startPty } from "./orca-terminal.js";
import { initSplit } from "./split.js";
import { setNavCount, show, showError } from "./view.js";

export const GROUP_LABELS = { waiting: "入力待ち", working: "作業中", done: "完了" } as const;
// The name of each status icon (its `aria-label`), and the status each group of the working view draws.
export const STATUS_LABELS: Record<OrcaStatus, string> = { question: "入力待ち", failed: "失敗", working: "作業中", monitoring: "監視中", interrupted: "中断", done: "完了", idle: "動いていない" };
export const GROUP_STATUS: Record<OrcaRow["group"], OrcaStatus> = { waiting: "question", working: "working", done: "done" };
const ASK_SVG = svgOf('<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>');
const ACTIVITY_SVG = svgOf('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>');
const TERMINAL_SVG = svgOf('<path d="M5 8l4 4-4 4M12 17h7"/>');
const CLOSE_SVG = svgOf('<path d="M6 6l12 12M18 6L6 18"/>');
const THIS_MACHINE = "このマシン";
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
// The project selected (its key; null: none, and the work pane is the new-session pane), and its tab selected (a tab's id; null when it has no tabs).
let projectKey: string | null = null;
let selectedTab: string | null = null;
// The tab last selected in each project, which selecting the project goes back to.
const lastTab = new Map<string, string>();
// The order tabs were first seen in, so that a read that reorders the sessions does not move the tabs.
const seen = new Map<string, number>();
// The terminals of the app (A-8), which belong to a project of this machine and end with the app; `id` is the tab's.
interface PtyTab {
  id: string;
  project: string;
  // The name of the project or SSH host, for its row when the list does not show it.
  name: string;
  title: string;
  sub: string;
  exited: boolean;
}
let ptys: PtyTab[] = [];
let ptySeq = 0;
// The tabs of Orca whose close was asked for and is not answered.
const closing = new Set<string>();
// The worktree (its path) a new launch uses, and a post on its way.
let newPath: string | null = null;
let busy = false;
// The session whose history is open (target, path and pane key), null when none is.
let chatKey: string | null = null;
// The skills of Claude Code on the machine the app runs on, whatever the target; read when the screen is first shown, by the update button, and again after a failure.
let skills: OrcaSkill[] = [];
let skillsStale = true;
let skillsSeq = 0;
// A read that failed is tried again by the list reads that follow, at most once in this long (the update button reads at once), so a target on another machine does not run a failing command every 10 seconds.
const SKILLS_RETRY_MS = 60_000;
let skillsFailedAt = 0;
// The open skill list: its matches and the one highlighted. `dismissed` keeps Escape's closing until the text changes.
let completion: { matches: OrcaSkill[]; active: number } | null = null;
let dismissed = false;
// What the feed, the bell, the tabs, the header and the notice show now; they are drawn again only when this changes.
let feedKey = "";
let bellKey = "";
let tabsKey = "";
let headerKey = "";
let noticeKey = "";

// The history of the work pane. It owns the read (orca-chat.ts) while the screen shows a selected session, and a side pane (orca-handoff.ts) may take it while the screen is not shown.
const screenChat = makeChatView($("orca-chat"), $("orca-items"), $("orca-older"), $("orca-chat-status"));

const input = () => $<HTMLTextAreaElement>("orca-input");
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
const viewedPane = () => (shown() && !document.hidden && selectedTab?.startsWith("claude:") ? selectedTab.slice("claude:".length) : null);

// Takes the rows of a read as the one the count follows (the rows of one read, whatever its scope). The first read of a target is only the base: a notice is made for a row that went from not stopped to stopped,
// or that first appeared in a later read already stopped (a pane seen stopped before is never new, even after it left the list and came back). A notice goes when the agent runs again, leaves the list, or its session is shown. A row with no pane cannot be opened, so it has no notice.
function track(rows: OrcaRow[]) {
  waitingCount = rows.filter((r) => r.group === "waiting").length;
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

// A tab of the work pane: a Claude session, a plain terminal of Orca, or a terminal of the app.
interface Tab {
  id: string;
  kind: "claude" | "plain" | "pty";
  status: OrcaStatus;
  label: string;
  title: string;
  sub: string;
  // The Orca terminal's handle (a Claude session may have none: it can be read but not closed).
  handle: string | null;
}

const claudeTabId = (paneKey: string) => `claude:${paneKey}`;
const plainTabId = (handle: string) => `orca:${handle}`;

// The tabs of the project `key`: its Claude sessions, its plain terminals and the terminals of the app, in the order they were first seen.
function tabsOf(key: string): Tab[] {
  const now = Date.now();
  const tabs: Tab[] = [];
  for (const r of view?.rows ?? []) {
    if (r.projectKey !== key || r.paneKey === null) continue;
    const time = elapsed(r.atMs, now, r.group === "done");
    tabs.push({ id: claudeTabId(r.paneKey), kind: "claude", status: r.status, label: STATUS_LABELS[r.status], title: r.line || "（題名なし）", sub: time ? `${r.branch} ・ ${time}` : r.branch, handle: r.handle });
  }
  for (const t of view?.terminals ?? []) {
    if (t.projectKey === key) tabs.push({ id: plainTabId(t.handle), kind: "plain", status: "done", label: "起動中", title: t.title || "ターミナル", sub: t.branch, handle: t.handle });
  }
  for (const p of ptys) {
    if (p.project === key) tabs.push({ id: p.id, kind: "pty", status: p.exited ? "idle" : "done", label: p.exited ? "終了" : "起動中", title: p.title, sub: p.sub, handle: null });
  }
  for (const t of tabs) if (!seen.has(t.id)) seen.set(t.id, seen.size);
  return tabs.sort((a, b) => seen.get(a.id)! - seen.get(b.id)!);
}

const selectedTabObj = () => (projectKey === null || selectedTab === null ? null : (tabsOf(projectKey).find((t) => t.id === selectedTab) ?? null));
const rowOfTab = (id: string) => view?.rows.find((r) => r.paneKey !== null && claudeTabId(r.paneKey) === id) ?? null;
const selectedRow = () => (selectedTab === null || !selectedTab.startsWith("claude:") ? null : rowOfTab(selectedTab));

// The tab selected is one of the project's: when it is gone (its session left Orca's list) the one last selected there, else the first.
function ensureSelection() {
  if (projectKey === null) {
    selectedTab = null;
    return;
  }
  const tabs = tabsOf(projectKey);
  if (selectedTab !== null && tabs.some((t) => t.id === selectedTab)) return;
  const last = lastTab.get(projectKey);
  selectedTab = tabs.find((t) => t.id === last)?.id ?? tabs[0]?.id ?? null;
}

const projectName = (key: string) => (key.startsWith("ssh:") ? ssh.find((t) => `ssh:${t.id}` === key)?.label : view?.projects.find((p) => p.key === key)?.name) ?? view?.hosts.find((h) => h.key === key)?.name ?? ptys.find((p) => p.project === key)?.name ?? "";

// ---- drawing ----

function drawBadge() {
  const viewed = viewedPane();
  if (viewed !== null) notified.delete(viewed);
  setNavCount("nav-orca", waitingCount + notified.size, "Orca", "確認待ち");
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

function heading(group: OrcaRow["group"], n: number) {
  const h = tag("h2", `orca-group ${group}`);
  h.append(statusIcon(GROUP_STATUS[group], GROUP_LABELS[group]), GROUP_LABELS[group], tag("span", "orca-count", String(n)));
  return h;
}

// Three lines: the status icon, the title and the time; the latest action; and Claude's mark with the worktree.
function rowNode(r: OrcaRow, key: string, now: number) {
  const row = tag("button", `orca-row ${r.group}`);
  row.type = "button";
  row.dataset.key = key;
  // A row with no pane has no session to read.
  row.disabled = r.paneKey === null;
  row.setAttribute("aria-pressed", String(r.paneKey !== null && claudeTabId(r.paneKey) === selectedTab && r.projectKey === projectKey));
  const where = tag("span", "orca-where");
  where.innerHTML = CLAUDE_SVG;
  where.append(worktreeLabel(r));
  row.append(statusIcon(r.status), tag("span", "orca-prompt", r.line), tag("span", "orca-time", elapsed(r.atMs, now, r.group === "done")), tag("span", "orca-activity", r.activity), where);
  row.onclick = () => selectRow(r);
  return row;
}

// A project, or an SSH host: its status icon, its name and the number of its sessions (none drawn when there are none).
function projectNode(key: string, name: string, status: OrcaStatus, sessions: number) {
  const row = tag("button", "orca-project");
  row.type = "button";
  row.dataset.key = key;
  row.setAttribute("aria-pressed", String(key === projectKey));
  row.append(statusIcon(status), tag("span", "orca-project-name", name));
  if (sessions > 0) row.append(tag("span", "orca-n", String(sessions)));
  row.onclick = () => selectProject(key);
  return row;
}

function emptyNode(text: string) {
  if (view === null || switching) {
    const loadingRow = tag("div", "pending");
    loadingRow.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    return loadingRow;
  }
  return view.state === "ready" ? tag("div", "feed-empty", text) : tag("div");
}

const ptyCount = (key: string) => ptys.filter((p) => p.project === key).length;
// Orca does not know the terminals of the app, so a row it calls idle shows the green dot while one of them runs there.
const withPtys = (key: string, status: OrcaStatus): OrcaStatus => (status === "idle" && ptys.some((p) => p.project === key && !p.exited) ? "done" : status);

// A row of the project list: a project of this machine or an SSH host.
type ProjectRow = Pick<OrcaProject, "key" | "name" | "status" | "sessions">;

// The rows of the list: the projects of the target, then the SSH hosts (the machine's, then the target's that it does not list).
// A terminal of the app whose project the list does not show (another machine is the target, or a read failed) has a row of its own, so it can still be reached and closed.
function projectRows(): { local: ProjectRow[]; hosts: ProjectRow[]; strays: ProjectRow[] } {
  const local: ProjectRow[] = view?.projects ?? [];
  const hosts: ProjectRow[] = ssh.map((t) => {
    const host = view?.hosts.find((h) => h.key === `ssh:${t.id}`);
    return { key: `ssh:${t.id}`, name: t.label, status: host?.status ?? "idle", sessions: host?.sessions ?? 0 };
  });
  for (const h of view?.hosts ?? []) if (!hosts.some((r) => r.key === h.key)) hosts.push(h);
  const strays: ProjectRow[] = [];
  for (const p of ptys) {
    if (![...local, ...hosts, ...strays].some((r) => r.key === p.project)) strays.push({ key: p.project, name: p.name, status: "idle", sessions: 0 });
  }
  return { local, hosts, strays };
}

function projectNodes(): HTMLElement[] {
  const { local, hosts, strays } = projectRows();
  const node = (r: ProjectRow) => projectNode(r.key, r.name, withPtys(r.key, r.status), r.sessions + ptyCount(r.key));
  const here = strays.filter((r) => !r.key.startsWith("ssh:"));
  const remote = [...hosts, ...strays.filter((r) => r.key.startsWith("ssh:"))];
  const nodes: HTMLElement[] = local.map(node);
  if (here.length) nodes.push(tag("h3", "orca-sec", THIS_MACHINE), ...here.map(node));
  if (remote.length) nodes.push(tag("h3", "orca-sec", "SSH"), ...remote.map(node));
  return nodes.length ? nodes : [emptyNode("プロジェクトがありません")];
}

// The project selected is no place to stay when the list shows no row for it and it has no tab (the last terminal of such a project was closed or failed to open).
function leaveUnlistedProject() {
  if (projectKey === null) return;
  const { local, hosts, strays } = projectRows();
  if (![...local, ...hosts, ...strays].some((r) => r.key === projectKey)) {
    projectKey = null;
    selectedTab = null;
  }
}

function workingNodes(now: number): HTMLElement[] {
  const rows = view?.rows ?? [];
  const nodes: HTMLElement[] = [];
  for (const group of ["waiting", "working", "done"] as const) {
    const list = rows.filter((r) => r.group === group);
    if (!list.length) continue;
    nodes.push(heading(group, list.length), ...list.map((r) => rowNode(r, r.paneKey ?? `${group}/${r.repo}/${r.branch}/${r.line}`, now)));
  }
  return nodes.length ? nodes : [emptyNode("動いているエージェントはありません")];
}

// Draws the list where it is: the scroll position and the focused row stay, and nothing is drawn when nothing changed.
function drawFeed() {
  const now = Date.now();
  // Only what is drawn: a project's time of activity moves with the work and would redraw the list (and restart the working mark) for nothing.
  const rowOf = (p: OrcaProject) => [p.key, p.name, p.status, p.sessions];
  const key = JSON.stringify([working, view?.state ?? null, working ? view?.rows : [view?.projects.map(rowOf), view?.hosts.map(rowOf), ssh, ptys], projectKey, selectedTab, switching, Math.floor(now / 60_000)]);
  if (key === feedKey) return;
  feedKey = key;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  box.replaceChildren(...(working ? workingNodes(now) : projectNodes()));
  box.scrollTop = top;
  if (focused) box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function tabNode(t: Tab) {
  const wrap = tag("div", "orca-tab");
  wrap.dataset.tab = t.id;
  wrap.setAttribute("role", "presentation");
  const select = tag("button", "orca-tab-btn");
  select.type = "button";
  select.setAttribute("role", "tab");
  select.setAttribute("aria-selected", String(t.id === selectedTab));
  const text = tag("span", "orca-tab-text");
  text.append(tag("span", "orca-tab-title", t.title), tag("span", "orca-tab-sub", t.sub));
  select.append(statusIcon(t.status, t.label), text);
  select.onclick = () => selectTab(t.id);
  // The close button is beside the tab, not in it, so that pressing it never selects the tab.
  const close = tag("button", "icon-btn orca-tab-close");
  close.type = "button";
  close.setAttribute("aria-label", "閉じる");
  close.innerHTML = CLOSE_SVG;
  close.disabled = t.kind === "claude" ? t.handle === null || closing.has(t.id) : closing.has(t.id);
  close.onclick = () => closeTab(t);
  wrap.append(select, close);
  return wrap;
}

function drawTabs(tabs: Tab[]) {
  const key = JSON.stringify([tabs, selectedTab, [...closing]]);
  if (key === tabsKey) return;
  tabsKey = key;
  const box = $("orca-tabs");
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  box.replaceChildren(...tabs.map(tabNode));
  if (focused) box.querySelector<HTMLElement>(`[data-tab="${CSS.escape(focused)}"] .orca-tab-btn`)?.focus({ preventScroll: true });
}

// The work pane follows the selection. No project: the new-session pane. A project with sessions: its tabs (no heading), and the selected tab's content. A project with none says so.
function drawWork() {
  const newPane = projectKey === null;
  const tabs = projectKey === null ? [] : tabsOf(projectKey);
  const tab = selectedTabObj();
  const tabbed = tabs.length > 0;
  $("orca-work-title").textContent = projectKey === null ? "新しいセッション" : projectName(projectKey);
  $("orca-work-title").hidden = tabbed;
  $("orca-tabs").hidden = !tabbed;
  $("orca-work-head").classList.toggle("tabbed", tabbed);
  drawTabs(tabs);
  $("orca-empty").hidden = newPane || tabbed;
  const claude = tab?.kind === "claude";
  for (const id of ["orca-chat", "orca-chat-status", "orca-form"]) $(id).hidden = !(newPane || claude);
  $("orca-dest").hidden = !newPane;
  setChatWorking(screenChat, selectedRow()?.group === "working");
}

// Shows the terminal of the selected tab, if it is one, and hides them while another screen or another kind of tab is shown.
function syncTerminal() {
  const tab = shown() ? selectedTabObj() : null;
  if (tab?.kind === "pty") showTerminal(tab.id);
  else if (tab?.kind === "plain") showTerminal(tab.id, { handle: tab.handle!, environment: view?.target ?? null });
  else hideTerminals();
}

// Reads the history of the selected session while the screen is shown, and closes it when there is none, the target or the session changed, or the screen was left.
function syncChat() {
  const row = shown() ? selectedRow() : null;
  const want = row?.paneKey ? JSON.stringify([view?.target ?? null, row.path, row.paneKey]) : null;
  // A side pane may have taken the read since: then the screen opens it again.
  if (want === chatKey && (want === null || isChatOwner(screenChat))) return;
  chatKey = want;
  if (row?.paneKey && want) openChat(screenChat, view?.target ?? null, row.path, row.paneKey, row.group === "working");
  else closeChat(screenChat);
}

// The composer's chip and button follow the selection: a selected session is posted to; in the new-session pane, a worktree is chosen and a new agent is started.
function drawComposer() {
  const row = selectedRow();
  const worktrees = view?.worktrees ?? [];
  const worktree = worktrees.find((w) => w.path === newPath) ?? null;
  const pick = $<HTMLButtonElement>("orca-dest-pick");
  pick.disabled = worktrees.length === 0;
  pick.textContent = worktree ? worktreeLabel(worktree) : worktrees.length ? "worktree を選ぶ" : "worktree がありません";
  // The text is the one being posted while a post is on its way.
  input().disabled = busy;
  input().placeholder = row ? "追加の指示を書く（/ でスキル）" : "起動するエージェントへの指示を書く（/ でスキル）";
  const send = $<HTMLButtonElement>("orca-send");
  send.textContent = row ? "送る" : "起動する";
  // A session with no terminal can be read but takes no post.
  send.disabled = busy || view?.state === "missing" || !input().value.trim() || (row ? row.handle === null : !worktree);
  updateCompletion();
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
  switching = false;
  if (newPath !== null && !view.worktrees.some((w) => w.path === newPath)) newPath = null;
  // A plain terminal that left Orca's list leaves the tabs, with its screen.
  if (!keep && view.state === "ready") {
    const held = new Set(view.terminals.map((t) => plainTabId(t.handle)));
    pruneMirrors((id) => held.has(id));
  }
  if (view.state === "ready") forgetGone();
  ensureSelection();
}

// The order and the last selection of tabs that are no longer anywhere are dropped, so they do not pile up.
function forgetGone() {
  const live = new Set<string>([...(view?.rows ?? []).flatMap((r) => (r.paneKey === null ? [] : [claudeTabId(r.paneKey)])), ...(view?.terminals ?? []).map((t) => plainTabId(t.handle)), ...ptys.map((p) => p.id)]);
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
  for (const [key, id] of lastTab) if (!live.has(id)) lastTab.delete(key);
}

function draw() {
  drawBadge();
  if (!shown()) return;
  drawHeader();
  drawNotice();
  drawBell();
  drawFeed();
  drawWork();
  drawComposer();
  syncChat();
  syncTerminal();
}

// What a read after a failure, the first one and one with the command missing ask for: everything. A working list is read for its agents (the screen shown) or their count.
const clockScope = (): Scope => (view?.state !== "ready" ? "full" : shown() ? "screen" : "badge");

// Reads the list. Only the latest request is used; `force` starts one although another is on its way (after a post or a change of the target).
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
    drawBadge();
    return;
  }
  adopt(next);
  draw();
  fetchSkills();
}

// Reads the skills when they are due and the screen is shown with the command found (the target may be failing). A failure only means no list for now: it is read again later (`SKILLS_RETRY_MS`).
async function fetchSkills() {
  if (!skillsStale || !shown() || view === null || view.state === "missing") return;
  if (Date.now() - skillsFailedAt < SKILLS_RETRY_MS) return;
  skillsStale = false;
  const seq = ++skillsSeq;
  let list: OrcaSkill[] = [];
  let failed = false;
  try {
    list = await invoke("orca_skills");
  } catch {
    // No list, no popup; posting does not depend on it.
    failed = true;
  }
  if (seq !== skillsSeq) return;
  if (failed) {
    skillsStale = true;
    skillsFailedAt = Date.now();
  }
  skills = list;
  updateCompletion();
}

function refresh() {
  // The history and the terminals are shown only while the screen is shown.
  if (!shown()) {
    syncChat();
    syncTerminal();
  }
  if (document.hidden || loading) return;
  // A missing command is not looked for again by the clock.
  if (view?.state === "missing") return;
  if (Date.now() - lastTry >= (shown() ? SHOWN_MS : HIDDEN_MS)) load(clockScope());
}

// ---- the side pane's share (A-9) ----

// The last read, for a side pane to draw at once while it reads again.
export const heldOrca = () => view;

// Reads the list for a side pane (the agents with their terminals, and the worktrees), whatever screen is shown, and gives what is held after it. `force` starts the read although another is on its way (the first read of a pane and the read after a send); the poll of a shown session does not. The first read of the app asks for the target too.
export async function refreshOrca(force: boolean) {
  await load(view?.state === "ready" ? "screen" : "full", force);
  return view;
}

// Selects the session of the pane `paneKey` on the Orca screen and shows the screen ("Orca の画面で開く"). A session the list does not hold yet leaves the selection as it is.
export function openInOrca(paneKey: string | null) {
  const row = paneKey === null ? null : (view?.rows.find((r) => r.paneKey === paneKey) ?? null);
  if (row) {
    projectKey = row.projectKey;
    selectedTab = claudeTabId(row.paneKey!);
    lastTab.set(row.projectKey, selectedTab);
    newPath = null;
  }
  setScreen("orca");
}

// The Orca screen is shown: what was read stays on screen while a new read is on its way.
export function showOrca() {
  show("orca");
  headerKey = noticeKey = feedKey = bellKey = tabsKey = "";
  draw();
  fetchSkills();
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
  // The sessions and worktrees belong to the old target, and so do the plain terminals' screens; the terminals of the app stay, they run on this machine.
  projectKey = null;
  selectedTab = null;
  newPath = null;
  pruneMirrors(() => false);
  view = { ...view, target: environment, rows: [], worktrees: [], projects: [], hosts: [], terminals: [] };
  forgetNotices();
  switching = true;
  draw();
  load("full", true);
}

function openTargetMenu(anchor: Element) {
  if (view === null) return;
  const items = [null, ...view.environments].map((name) => ({ label: name ?? THIS_MACHINE, color: "var(--accent)", current: name === view!.target, pick: () => chooseTarget(name) }));
  openMenu(anchor, items);
}

function pickWorktree(path: string) {
  newPath = path;
  drawComposer();
  input().focus();
}

// The dialog under the "起動先" chip: the worktrees, narrowed by a filter on `{repo} ・ {branch}`. A pick closes it. The side pane of A-9 opens it too.
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

const openDestPicker = (anchor: Element) => openWorktreeDialog(anchor, view?.worktrees ?? [], newPath, pickWorktree);

function showPostError(message: string | null) {
  $("orca-error").hidden = message === null;
  $("orca-error").textContent = message ?? "";
}

// ---- selecting and closing ----

// Selects the project and, in it, the tab last selected there, else the first.
function selectProject(key: string) {
  projectKey = key;
  selectedTab = null;
  newPath = null;
  ensureSelection();
  draw();
  if (selectedRow()) input().focus();
}

function selectTab(id: string) {
  selectedTab = id;
  if (projectKey !== null) lastTab.set(projectKey, id);
  newPath = null;
  draw();
  if (selectedRow()) input().focus();
}

// A row of the working view selects its project and its tab.
function selectRow(r: OrcaRow) {
  if (r.paneKey === null) return;
  projectKey = r.projectKey;
  selectedTab = claudeTabId(r.paneKey);
  lastTab.set(r.projectKey, selectedTab);
  // A worktree chosen for a launch is chosen again for the next one.
  newPath = null;
  draw();
  input().focus();
}

// The new-session pane: no project, no tab.
function newSession() {
  projectKey = null;
  selectedTab = null;
  draw();
  input().focus();
}

// Closes a tab. An Orca terminal is closed in Orca, and the list is read at once: it leaves the tabs then, and a failure keeps the tab and shows the message. A terminal of the app is ended and forgotten.
async function closeTab(tab: Tab) {
  if (closing.has(tab.id)) return;
  if (tab.kind === "pty") {
    ptys = ptys.filter((p) => p.id !== tab.id);
    await closePty(tab.id);
    ensureSelection();
    leaveUnlistedProject();
    draw();
    return;
  }
  closing.add(tab.id);
  draw();
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
  load(clockScope(), true);
}

// Opens a terminal of the app at `target` in the project `project`, selects it, and fits it to the pane. A failure shows the message and leaves no tab.
async function openTerminal(target: TerminalTarget, project: string, name: string, sub: string) {
  const tab: PtyTab = { id: `pty:${++ptySeq}`, project, name, title: "ターミナル", sub, exited: false };
  const before = { projectKey, selectedTab };
  ptys.push(tab);
  projectKey = project;
  selectedTab = tab.id;
  lastTab.set(project, tab.id);
  newPath = null;
  draw();
  try {
    await startPty(tab.id, target, () => {
      tab.exited = true;
      draw();
    });
  } catch (e) {
    ptys = ptys.filter((p) => p !== tab);
    // Back to where the user was.
    ({ projectKey, selectedTab } = before);
    ensureSelection();
    leaveUnlistedProject();
    draw();
    showError(e);
  }
}

// The dialog of the destinations of a terminal: the worktrees of this machine and the SSH hosts, narrowed by a filter. A pick opens the terminal and closes it.
async function openTerminalDialog(anchor: Element) {
  const pop = tag("div", "menu orca-dest-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "起動先");
  const filter = tag("input");
  filter.setAttribute("aria-label", "起動先を絞り込む");
  filter.placeholder = "起動先を絞り込む";
  filter.autocomplete = "off";
  const rows = tag("div", "orca-dest-list");
  rows.append(tag("p", "empty", "読み込んでいます…"));
  pop.append(filter, rows);
  showMenu(anchor, pop);
  filter.focus();
  let targets: OrcaTerminalTargets;
  try {
    targets = await invoke("orca_terminal_targets");
  } catch (e) {
    targets = { worktrees: [], ssh: [], message: String(e) };
  }
  // The dialog was closed while it read.
  if (!pop.isConnected) return;
  const drawDest = () => {
    const q = filter.value.trim().toLowerCase();
    const worktrees = targets.worktrees.filter((w) => worktreeLabel(w).toLowerCase().includes(q));
    const hosts = targets.ssh.filter((t) => t.label.toLowerCase().includes(q));
    const nodes: HTMLElement[] = [];
    if (targets.message) nodes.push(tag("p", "empty", targets.message));
    if (worktrees.length) {
      nodes.push(tag("p", "orca-dest-group", THIS_MACHINE));
      for (const w of worktrees) {
        const b = tag("button");
        b.type = "button";
        b.dataset.path = w.path;
        b.append(tag("b", "", w.repo), tag("span", "", w.branch));
        b.onclick = () => {
          closeMenu();
          openTerminal({ kind: "worktree", path: w.path }, w.projectKey, w.repo, w.branch);
        };
        nodes.push(b);
      }
    }
    if (hosts.length) {
      nodes.push(tag("p", "orca-dest-group", "SSH"));
      for (const t of hosts) {
        const b = tag("button");
        b.type = "button";
        b.dataset.ssh = t.id;
        b.append(tag("b", "", t.label), tag("span", "", t.connected ? "" : "未接続"));
        b.onclick = () => {
          closeMenu();
          openTerminal({ kind: "ssh", id: t.id }, `ssh:${t.id}`, t.label, t.label);
        };
        nodes.push(b);
      }
    }
    rows.replaceChildren(...(nodes.length ? nodes : [tag("p", "empty", "該当する起動先がありません")]));
  };
  filter.oninput = drawDest;
  drawDest();
}

// The plus button's menu: start Claude (the new-session pane), or open a terminal.
function openNewMenu(anchor: Element) {
  const menu = tag("div", "menu");
  menu.setAttribute("role", "menu");
  for (const [label, icon, pick] of [
    ["Claude を起動", CLAUDE_SVG, newSession],
    ["ターミナルを開く", TERMINAL_SVG, () => openTerminalDialog(anchor)],
  ] as const) {
    const b = tag("button", "orca-menu-item");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.innerHTML = icon;
    b.append(label);
    b.onclick = () => {
      closeMenu();
      pick();
    };
    menu.append(b);
  }
  showMenu(anchor, menu);
  menu.querySelector("button")!.focus();
}

// Sends the text to the selected session, or starts an agent with it. The text stays on a failure and goes on success, which reads the list at once. Nothing is tried twice.
async function post() {
  const text = input().value;
  const row = selectedRow();
  const target = view?.target ?? null;
  if (busy || !text.trim() || view === null) return;
  if (row ? row.handle === null : projectKey !== null || !newPath) return;
  busy = true;
  showPostError(null);
  drawComposer();
  try {
    if (row) await invoke("orca_send", { handle: row.handle!, text, environment: target });
    else await invoke("orca_launch", { path: newPath!, text, environment: target });
    input().value = "";
    load(clockScope(), true);
  } catch (e) {
    showPostError(String(e));
  } finally {
    busy = false;
    drawComposer();
    // A disabled text lost the focus.
    input().focus();
  }
}

// ---- the skill list ----

// The first word of the text when it starts with "/" and the caret is still in it (no space yet), without the slash; null otherwise.
function slashQuery(): string | null {
  const text = input().value;
  const word = /^\/\S*/.exec(text)?.[0];
  if (!word || (input().selectionStart ?? 0) > word.length) return null;
  return word.slice(1);
}

// The skills that contain the query, case-insensitively, those that start with it first.
function matchesOf(query: string) {
  const q = query.toLowerCase();
  const found = skills.filter((s) => s.command.slice(1).toLowerCase().includes(q));
  const starts = (s: OrcaSkill) => s.command.slice(1).toLowerCase().startsWith(q);
  return [...found.filter(starts), ...found.filter((s) => !starts(s))];
}

function closeCompletion() {
  completion = null;
  $("orca-complete").hidden = true;
  $("orca-complete").replaceChildren();
  for (const id of ["orca-complete", "orca-input"]) $(id).removeAttribute("aria-activedescendant");
}

function markActive() {
  if (!completion) return;
  const options = [...$("orca-complete").children] as HTMLElement[];
  const { active } = completion;
  for (const [i, option] of options.entries()) option.setAttribute("aria-selected", String(i === active));
  const id = options[active]?.id ?? "";
  for (const el of [$("orca-complete"), input()]) el.setAttribute("aria-activedescendant", id);
  options[active]?.scrollIntoView({ block: "nearest" });
}

// Opens, narrows or closes the list for the text and the caret as they are. The highlight stays on the same skill while it is still listed; `reset` (typing) puts it on the first.
function updateCompletion(reset = false) {
  // Only the text being typed in opens it: a read in the background must not.
  const query = !dismissed && document.activeElement === input() ? slashQuery() : null;
  const matches = query === null ? [] : matchesOf(query);
  if (!matches.length) {
    if (completion) closeCompletion();
    return;
  }
  const keep = reset ? undefined : completion?.matches[completion.active]?.command;
  const active = Math.max(0, matches.findIndex((m) => m.command === keep));
  const same = completion && completion.matches.length === matches.length && completion.matches.every((m, i) => m.command === matches[i].command);
  completion = { matches, active };
  if (!same) {
    const box = $("orca-complete");
    box.hidden = false;
    box.replaceChildren(
      ...matches.map((m, i) => {
        const option = tag("div", "orca-skill");
        option.id = `orca-skill-${i}`;
        option.setAttribute("role", "option");
        option.append(tag("code", "", m.command), tag("span", "", m.description));
        // A press keeps the focus in the text.
        option.onmousedown = (e) => e.preventDefault();
        option.onclick = () => accept(i);
        return option;
      }),
    );
    box.scrollTop = 0;
  }
  markActive();
}

// Puts the command in the place of the first word, followed by one space, and does not post.
function accept(index: number) {
  const skill = completion?.matches[index];
  if (!skill) return;
  const field = input();
  const rest = field.value.replace(/^\/\S*/, "").trimStart();
  field.value = `${skill.command} ${rest}`;
  const caret = skill.command.length + 1;
  field.setSelectionRange(caret, caret);
  closeCompletion();
  drawComposer();
}

function onKey(e: KeyboardEvent) {
  if (!completion || composing(e)) return;
  const n = completion.matches.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    completion.active = (completion.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    markActive();
  } else if (e.key === "Tab" || e.key === "Enter") {
    accept(completion.active);
  } else if (e.key === "Escape") {
    dismissed = true;
    closeCompletion();
  } else {
    return;
  }
  e.preventDefault();
}

export function initOrca() {
  initOrcaChat();
  initOrcaTerminal(showError);
  initSplit($("orca"), $("orca-split"), { side: "left", min: 0.2, max: 0.5, initial: 0.3, property: "--list-w" });
  setInterval(refresh, 1000);
  document.addEventListener("visibilitychange", () => {
    // A session shown again after the window was hidden is seen.
    drawBadge();
    refresh();
  });
  $("orca-refresh").onclick = () => {
    skillsStale = true;
    skillsFailedAt = 0;
    load("full", true);
  };
  $("orca-bell").onclick = () => {
    working = !working;
    draw();
  };
  $("orca-target").onclick = (e) => openTargetMenu(e.currentTarget as Element);
  $("orca-dest-pick").onclick = (e) => openDestPicker(e.currentTarget as Element);
  $("orca-new").onclick = (e) => openNewMenu(e.currentTarget as Element);
  $("orca-form").onsubmit = (e) => {
    e.preventDefault();
    post();
  };
  input().addEventListener("input", () => {
    dismissed = false;
    drawComposer();
    updateCompletion(true);
  });
  input().addEventListener("keydown", onKey);
  // The caret moving out of the first word closes the list, and moving back in opens it.
  for (const type of ["keyup", "click", "focus"]) input().addEventListener(type, () => updateCompletion());
  input().addEventListener("blur", () => closeCompletion());
  load("full");
}
