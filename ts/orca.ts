// The Orca screen (A-6, A-8, A-12): two panes. The list pane is the projects (a repository of this machine, an SSH host) or, with the bell pressed, the Claude agents that run in Orca in three groups (waiting for the user, working, done);
// the work pane has the sessions of the selected project as tabs, and each tab is a terminal (orca-terminal.ts). "新規" starts Claude in a worktree, and the session is selected once it is listed. Nothing about a session is kept here.
// A saved environment streams the list (`orca_stream_open`: Orca sends each change) and nothing reads it by the clock. This machine's Orca cannot stream: its list is read every 10 seconds while the screen is shown and every 60 seconds otherwise, one read at a time,
// and no more once the `orca` command was found missing (the reload button reads again). Only the first read, the screen being shown, the reload button, a change of the target and a read after a failure ask for the environments (and the SSH hosts).
// The sidebar button's count is the agents that wait for the user plus the notices: the agents that stopped (done, failed, interrupted) while the app ran, until their session is shown on this screen, they run again or they leave the list (the first read of a target only sets the base).
// While an agent works, the button's icon is yellow and fades slowly; the number that work is only in the button's label.
// A read in the background swaps the rows in place: the selection and the scroll position stay, and `show()` is never called by it.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaProject } from "./bindings/OrcaProject";
import type { OrcaRow } from "./bindings/OrcaRow";
import type { OrcaSshTarget } from "./bindings/OrcaSshTarget";
import type { OrcaStatus } from "./bindings/OrcaStatus";
import type { OrcaStreamEvent } from "./bindings/OrcaStreamEvent";
import type { OrcaWorktree } from "./bindings/OrcaWorktree";
import { $, tag } from "./dom.js";
import { CLAUDE_SVG, svgOf } from "./icons.js";
import { invoke } from "./ipc.js";
import { closeMenu, openMenu, showMenu } from "./menu.js";
import { currentScreen, setScreen } from "./nav.js";
import { initOrcaChat } from "./orca-chat.js";
import { hideTerminals, initOrcaTerminal, pruneTerminals, showTerminal } from "./orca-terminal.js";
import { initSplit } from "./split.js";
import { setNavCount, show, showError } from "./view.js";

export const GROUP_LABELS = { waiting: "入力待ち", working: "作業中", done: "完了" } as const;
// The name of each status icon (its `aria-label`), and the status each group of the working view draws.
export const STATUS_LABELS: Record<OrcaStatus, string> = { question: "入力待ち", failed: "失敗", working: "作業中", monitoring: "監視中", interrupted: "中断", done: "完了", idle: "動いていない" };
export const GROUP_STATUS: Record<OrcaRow["group"], OrcaStatus> = { waiting: "question", working: "working", done: "done" };
const ASK_SVG = svgOf('<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>');
const ACTIVITY_SVG = svgOf('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>');
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
// The project selected (its key; null: none), and its tab selected (a tab's id; null when it has no tabs).
let projectKey: string | null = null;
let selectedTab: string | null = null;
// The tab last selected in each project, which selecting the project goes back to.
const lastTab = new Map<string, string>();
// The order tabs were first seen in, so that a read that reorders the sessions does not move the tabs.
const seen = new Map<string, number>();
// The tabs of Orca whose close was asked for and is not answered.
const closing = new Set<string>();
// A launch ("新規") on its way.
let busy = false;
// The launch that was answered: its pane key and handle (null when Orca's reply gave none), the target and when to stop waiting for its row. The row is selected as soon as the list holds it, and no other launch is made till then.
let started: { paneKey: string | null; handle: string | null; target: string | null; until: number } | null = null;
const START_WAIT_MS = 30_000;
// The saved environment whose list is streamed (null: none is, and the list is read by the clock), and the channel of the stream: an event of another channel is not taken.
let streamTarget: string | null = null;
let streamChannel: { onmessage: (event: OrcaStreamEvent) => void } | null = null;
// What the feed, the bell, the tabs, the header and the notice show now; they are drawn again only when this changes.
let feedKey = "";
let bellKey = "";
let tabsKey = "";
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
const viewedPane = () => (shown() && !document.hidden && selectedTab?.startsWith("claude:") ? selectedTab.slice("claude:".length) : null);

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

// A tab of the work pane: a Claude session, or a plain terminal of Orca. Both are terminals.
interface Tab {
  id: string;
  kind: "claude" | "plain";
  status: OrcaStatus;
  label: string;
  title: string;
  // The Orca terminal's handle (a Claude session may have none: it shows no terminal and cannot be closed).
  handle: string | null;
  // The worktree it runs in.
  path: string;
}

const claudeTabId = (paneKey: string) => `claude:${paneKey}`;
const plainTabId = (handle: string) => `orca:${handle}`;

// The tabs of the project `key`: its Claude sessions and its plain terminals, in the order they were first seen.
function tabsOf(key: string): Tab[] {
  const tabs: Tab[] = [];
  for (const r of view?.rows ?? []) {
    if (r.projectKey !== key || r.paneKey === null) continue;
    tabs.push({ id: claudeTabId(r.paneKey), kind: "claude", status: r.status, label: STATUS_LABELS[r.status], title: r.line || "（題名なし）", handle: r.handle, path: r.path });
  }
  for (const t of view?.terminals ?? []) {
    if (t.projectKey === key) tabs.push({ id: plainTabId(t.handle), kind: "plain", status: "done", label: "起動中", title: t.title || "ターミナル", handle: t.handle, path: t.path });
  }
  for (const t of tabs) if (!seen.has(t.id)) seen.set(t.id, seen.size);
  return tabs.sort((a, b) => seen.get(a.id)! - seen.get(b.id)!);
}

const selectedTabObj = () => (projectKey === null || selectedTab === null ? null : (tabsOf(projectKey).find((t) => t.id === selectedTab) ?? null));

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

// A row of the project list: a project of this machine or an SSH host.
type ProjectRow = Pick<OrcaProject, "key" | "name" | "status" | "sessions">;

// The rows of the list: the projects of the target, then the SSH hosts (the machine's, then the target's that it does not list).
function projectRows(): { local: ProjectRow[]; hosts: ProjectRow[] } {
  const local: ProjectRow[] = view?.projects ?? [];
  const hosts: ProjectRow[] = ssh.map((t) => {
    const host = view?.hosts.find((h) => h.key === `ssh:${t.id}`);
    return { key: `ssh:${t.id}`, name: t.label, status: host?.status ?? "idle", sessions: host?.sessions ?? 0 };
  });
  for (const h of view?.hosts ?? []) if (!hosts.some((r) => r.key === h.key)) hosts.push(h);
  return { local, hosts };
}

function projectNodes(): HTMLElement[] {
  const { local, hosts } = projectRows();
  const node = (r: ProjectRow) => projectNode(r.key, r.name, r.status, r.sessions);
  const nodes: HTMLElement[] = local.map(node);
  if (hosts.length) nodes.push(tag("h3", "orca-sec", "SSH"), ...hosts.map(node));
  return nodes.length ? nodes : [emptyNode("プロジェクトがありません")];
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
  const key = JSON.stringify([working, view?.state ?? null, working ? view?.rows : [view?.projects.map(rowOf), view?.hosts.map(rowOf), ssh], projectKey, selectedTab, switching, Math.floor(now / 60_000)]);
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
  select.append(statusIcon(t.status, t.label), tag("span", "orca-tab-title", t.title));
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

function drawTabs(tabs: Tab[]) {
  const key = JSON.stringify([tabs, selectedTab, [...closing]]);
  if (key === tabsKey) return;
  tabsKey = key;
  const box = $("orca-tabs");
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  box.replaceChildren(...tabs.map(tabNode));
  if (focused) box.querySelector<HTMLElement>(`[data-tab="${CSS.escape(focused)}"] .orca-tab-btn`)?.focus({ preventScroll: true });
}

// The work pane follows the selection: the tab strip (empty with no project), and the terminal of the selected tab, else a line that says why there is none.
function drawWork() {
  const tabs = projectKey === null ? [] : tabsOf(projectKey);
  drawTabs(tabs);
  const tab = selectedTabObj();
  const waiting = started !== null && projectKey === null;
  const empty = waiting ? null : projectKey === null ? "プロジェクトを選んでください" : tabs.length === 0 ? "セッションはありません" : tab?.handle === null ? "このセッションのターミナルはありません" : null;
  $("orca-empty").hidden = empty === null;
  $("orca-empty").textContent = empty ?? "";
  $<HTMLButtonElement>("orca-new").disabled = busy || startWaits() || view === null || view.state === "missing";
  drawStarted();
}

// Shows the terminal of the selected tab while the screen is shown: streamed from a saved environment, mirrored on this machine.
function syncTerminal() {
  const tab = shown() ? selectedTabObj() : null;
  if (!tab?.handle) return hideTerminals();
  showTerminal(tab.id, { kind: streaming() ? "stream" : "mirror", handle: tab.handle, path: tab.path, environment: view?.target ?? null });
}

// The note of a launch that was answered: it waits for the row of the session, or (Orca named neither its pane nor its terminal) says it was started.
function drawStarted() {
  const box = $("orca-started");
  box.hidden = started === null || projectKey !== null;
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
    const held = new Set([...view.rows.flatMap((r) => (r.paneKey === null ? [] : [claudeTabId(r.paneKey)])), ...view.terminals.map((t) => plainTabId(t.handle))]);
    pruneTerminals((id) => held.has(id));
  }
  if (view.state === "ready") forgetGone();
  claimStarted();
  ensureSelection();
}

// A launch that gave a pane key or a handle waits for its row, which is matched by either (as the side pane of A-9 does).
const startWaits = () => started !== null && (started.paneKey !== null || started.handle !== null);

// A launch whose row the read holds now is selected (its project and its tab, so its terminal shows); one that waited too long, even if the read failed, or one for another target, is dropped.
function claimStarted() {
  if (!startWaits()) return;
  const wait = started!;
  if (Date.now() > wait.until) {
    started = null;
    return;
  }
  if (view === null || view.state !== "ready") return;
  const row = wait.target === view.target ? view.rows.find((r) => (wait.paneKey !== null && r.paneKey === wait.paneKey) || (wait.handle !== null && r.handle === wait.handle)) : undefined;
  if (row?.paneKey) pickRow(row);
  if (row || wait.target !== view.target) started = null;
}

// The order and the last selection of tabs that are no longer anywhere are dropped, so they do not pile up.
function forgetGone() {
  const live = new Set<string>([...(view?.rows ?? []).flatMap((r) => (r.paneKey === null ? [] : [claudeTabId(r.paneKey)])), ...(view?.terminals ?? []).map((t) => plainTabId(t.handle))]);
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
  syncTerminal();
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

// Selects the session of the pane `paneKey` on the Orca screen and shows the screen ("Orca の画面で開く"). A session the list does not hold yet leaves the selection as it is.
export function openInOrca(paneKey: string | null) {
  const row = paneKey === null ? null : (view?.rows.find((r) => r.paneKey === paneKey) ?? null);
  if (row) {
    projectKey = row.projectKey;
    selectedTab = claudeTabId(row.paneKey!);
    lastTab.set(row.projectKey, selectedTab);
  }
  setScreen("orca");
}

// The Orca screen is shown: what was read stays on screen while a new read is on its way.
export function showOrca() {
  show("orca");
  headerKey = noticeKey = feedKey = bellKey = tabsKey = "";
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
  projectKey = null;
  selectedTab = null;
  started = null;
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

// The dialog of the worktrees, narrowed by a filter on `{repo} ・ {branch}`, under "新規" and under the chip of the side pane of A-9. A pick closes it.
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

// Selects the project and, in it, the tab last selected there, else the first.
function selectProject(key: string) {
  started = null;
  projectKey = key;
  selectedTab = null;
  ensureSelection();
  draw();
}

function selectTab(id: string) {
  started = null;
  selectedTab = id;
  if (projectKey !== null) lastTab.set(projectKey, id);
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
  projectKey = r.projectKey;
  selectedTab = claudeTabId(r.paneKey!);
  lastTab.set(r.projectKey, selectedTab);
}

// Closes a tab. An Orca terminal is closed in Orca, and the list is read at once: it leaves the tabs then, and a failure keeps the tab and shows the message.
async function closeTab(tab: Tab) {
  if (closing.has(tab.id)) return;
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
  // A streamed list says the close by itself.
  if (!streaming()) load(clockScope(), true);
}

// "新規": the worktrees of the list; picking one starts Claude in it with no first prompt (the user types it in the terminal). The session is then followed: once the list holds it, its project and its tab are selected.
// A launch is never tried twice; a failure shows its message. No project is selected meanwhile, so the work pane says that the session was started.
function openNewDialog(anchor: Element) {
  if (view === null) return;
  openWorktreeDialog(anchor, view.worktrees, null, (path) => start(path));
}

async function start(path: string) {
  if (busy || startWaits() || view === null) return;
  const target = view.target;
  busy = true;
  started = null;
  projectKey = null;
  selectedTab = null;
  draw();
  try {
    const launched = await invoke("orca_start", { path, environment: target });
    // A session picked while the launch was on its way is not left for the new one.
    if (projectKey === null) started = { paneKey: launched.paneKey, handle: launched.handle, target, until: Date.now() + START_WAIT_MS };
    if (!streaming()) load(clockScope(), true);
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
    draw();
  }
}

export function initOrca() {
  // The history of A-7 is read only by the side pane of A-9 now; it still pauses with the window.
  initOrcaChat();
  initOrcaTerminal(showError);
  initSplit($("orca"), $("orca-split"), { side: "left", min: 0.2, max: 0.5, initial: 0.3, property: "--list-w" });
  setInterval(refresh, 1000);
  document.addEventListener("visibilitychange", () => {
    // A session shown again after the window was hidden is seen.
    drawBadge();
    refresh();
  });
  $("orca-refresh").onclick = () => load("full", true);
  $("orca-bell").onclick = () => {
    working = !working;
    draw();
  };
  $("orca-target").onclick = (e) => openTargetMenu(e.currentTarget as Element);
  $("orca-new").onclick = (e) => openNewDialog(e.currentTarget as Element);
  load("full");
}
