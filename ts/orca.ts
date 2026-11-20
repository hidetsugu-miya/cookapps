// The Orca screen (A-6, A-8, A-12, A-16, A-17, A-18, A-27): two panes, and the file pane on the right (orca-files.ts, with the history of A-27 in orca-history.ts) when it is shown. The list pane is the projects (a repository of this machine or of a saved environment);
// the work pane has the sessions of the selected project as tabs, and each tab is a terminal (orca-terminal.ts). The work pane is split into panes (A-17), each with its tabs and its terminal; Rust holds how it is split for each project (orca-panes.ts), and the selected tab is the one shown in the pane that has the focus.
// A file opened from the file pane is a tab of the strip too, with its editor (orca-editor.ts) in the pane where a terminal would be, and so is the difference of a file from HEAD (A-24, orca-diff.ts), from the menu of the file's row, or of a file of a commit (A-27), from the history, and the definition of a name of the editor (A-34, orca-definition.ts), one tab for a project, that opens in a pane under the pane of the editor, and so are a table and the SQL of a database from the database part of the file pane (A-43, orca-database-tabs.ts).
// The plus right after the tabs of a pane's strip starts Claude, or opens a terminal, in a worktree of the selected project, and the new tab is selected once it is listed. Nothing about a session is kept here.
// A saved environment streams the list (`orca_stream_open`: Orca sends each change, and Rust reads the worktrees again every 10 seconds and after a switch of the branch) and nothing here reads it by the clock. This machine's Orca cannot stream: its list is read every 10 seconds while the screen is shown and every 60 seconds otherwise, one read at a time,
// and no more once the `orca` command was found missing (showing the screen reads again). Only the first read, the screen being shown, a change of the target and a read after a failure ask for the environments.
// The sidebar button's count is the agents that wait for the user plus the notices: the agents that stopped (done, failed, interrupted) while the app ran, until their session is shown on this screen, they run again or they leave the list (the first read of a target only sets the base).
// While an agent works, the button's icon is yellow and fades slowly; the number that work is only in the button's label.
// A search field in the row of the heading 「プロジェクト」 (A-19), opened by the magnifier at the right end of the row or by ⌘J, narrows the projects by name.
// While the screen and the file pane are shown, the clock also reads again, every 10 seconds, what the file pane shows and the files and differences that the panes show (`rereadFiles`; A-18, A-24, A-27), without a word.
// A read in the background swaps the rows in place: the selection and the scroll position stay, and `show()` is never called by it.
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import type { OrcaLocal } from "./bindings/OrcaLocal";
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaProject } from "./bindings/OrcaProject";
import type { OrcaRow } from "./bindings/OrcaRow";
import type { OrcaSubagent } from "./bindings/OrcaSubagent";
import type { OrcaStatus } from "./bindings/OrcaStatus";
import type { OrcaStreamEvent } from "./bindings/OrcaStreamEvent";
import type { OrcaTerminal } from "./bindings/OrcaTerminal";
import type { OrcaWorktree } from "./bindings/OrcaWorktree";
import type { PaneNode } from "./bindings/PaneNode";
import type { PaneOp } from "./bindings/PaneOp";
import { $, composing, isMac, partMatcher, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { currentFormation, deselectFormation, isChildFolder, isChildSession, isChildWorktree, readForChoice } from "./formation-list.js";
import { CHEVRON_SVG, CLAUDE_SVG, COLUMNS_SVG, COPY_PATH_SVG, DATABASE_SVG, DEFINITION_SVG, DIFF_SVG, FILE_SVG, FORMATION_SVG, LOCK_SVG, ROWS_SVG, SCRATCHPAD_SVG, svgOf, TERMINAL_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { drawListToggle, listToggle } from "./list-toggle.js";
import { closeMenu, type MenuItem, openMenu, showMenu } from "./menu.js";
import { currentScreen, setScreen } from "./nav.js";
import { closeDefinition, type DefinitionOpen, type DefinitionQuery, definitionsOf, hasDefinitionIn, initDefinition, openDefinition, showDefinitions } from "./orca-definition.js";
import { openAddProject } from "./orca-add.js";
import { closeConnectionTabs, closeDatabaseTab, databaseTabsOf, openQuery, openTable, showDatabaseTabs } from "./orca-database-tabs.js";
import { initOrcaDatabase } from "./orca-database.js";
import { closeDiff, type DiffCommit, diffsOf, hasDiffIn, openDiff as openDiffTab, refreshDiffs, showDiffs } from "./orca-diff.js";
import { closeFile, dirtyIds, discardFiles, filesOf, goTo, hasFileIn, holdFiles, initOrcaEditor, nameOf, openedIn, openFile as openEditorFile, refreshEditors, resolveServers, showEditors } from "./orca-editor.js";
import { ensureServer, initLsp, mayAsk, pauseLsp, syncServers } from "./orca-lsp.js";
import { filesShown, initOrcaFiles, refreshFiles, rereadScratchpad, syncFiles, toggleFiles } from "./orca-files.js";
import { type PaneModel, drawTree, editorHostOf, initPaneTree, type TreeModel } from "./orca-pane-tree.js";
import { applyLocal, findTab, focusedTab, layoutOf, needsSync, type PaneTabs, panesOf, syncPanes } from "./orca-panes.js";
import { closePeek, drawPeek, initPeek, openPeek, peeking } from "./orca-peek.js";
import { openScratchpad } from "./orca-scratchpad.js";
import { hideTerminals, initOrcaTerminal, type Placement, pruneTerminals, showTerminals } from "./orca-terminal.js";
import { type Fields, registerDraftTarget } from "./screen-bridge.js";
import { initSplit } from "./split.js";
import { showFailure } from "./error-card.js";
import { copyText, setNavCount, show } from "./view.js";

// The name of each status icon (its `aria-label`).
export const STATUS_LABELS: Record<OrcaStatus, string> = { question: "入力待ち", failed: "失敗", working: "作業中", monitoring: "監視中", interrupted: "中断", done: "完了", idle: "動いていない" };
const ASK_SVG = svgOf('<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>');
const ACTIVITY_SVG = svgOf('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>');
const ROBOT_SVG = svgOf('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>');
const PLAY_SVG = svgOf('<polygon points="6 3 20 12 6 21 6 3"/>');
const CLOSE_SVG = svgOf('<path d="M6 6l12 12M18 6L6 18"/>');
export const THIS_MACHINE = "このマシン";
const SHOWN_MS = 10_000;
// The clock ticks once a second, and a spec that shortens `SHOWN_MS` (`periodMs`) shortens the tick in the same proportion.
export const shownMs = () => periodMs("orcaClock", SHOWN_MS);
const HIDDEN_MS = 60_000;

// The last read, or null before the first. A failed read keeps the rows and worktrees of the one before it while the target is the same.
let view: OrcaOverview | null = null;
// This machine's lists beside a saved environment's (A-33), null while this machine is the target (its lists are `view`'s own) or before a read of it. A read that failed keeps the lists of the last good one and says its state.
let here: OrcaLocal | null = null;
// When this machine's lists were last read by the clock while the target is streamed (`loadHere`); the read of `orca_overview` sets it too, as the first read of a target does.
let hereTry = 0;
let hereLoading = false;
// The latest read of this machine's lists is the one used (as `loadSeq` is for `load`).
let hereSeq = 0;
// The lists the screen draws: the target's (`view`) and this machine's (`here`) in one (A-33). Every item says where it is (`environment`), so a row of a saved environment is the one with a name.
interface Lists {
  rows: OrcaRow[];
  worktrees: OrcaWorktree[];
  projects: OrcaProject[];
  terminals: OrcaTerminal[];
}
let mix: Lists = { rows: [], worktrees: [], projects: [], terminals: [] };
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
// Reads: the latest request is the one used; one is on its way; when the last one started.
let loadSeq = 0;
let loading = false;
let lastTry = 0;
// When the clock last read the files again (`rereadFiles`), or last found the screen, the window or the file pane hidden: the next read is one period after it.
let filesAt = Date.now();
// Whether the list of projects is open (A-23): held in memory only, so the screen is open again when the app starts.
let listOpen = true;
// The text of the search field (A-19): the list shows the projects whose name holds it (blank: all of them), and the row the keys are on is `cursor` (a key; one the list does not show leaves the first).
let query = "";
// Whether the projects that are not running are listed under the link that follows the running ones (A-8). The search lists them all whatever this is, and clearing it leaves this as it was; in memory only.
let stoppedOpen = false;
// Whether the search field (A-19) is open: it takes the place of the heading's row. It is closed again when its text is empty and the focus leaves it, or with Escape; while text is kept it stays open.
let searchOpen = false;
let cursor: string | null = null;
// The project selected (its key; null: none). Its tab selected is the one shown in the pane of its layout that has the focus (`selectedTab`).
let projectKey: string | null = null;
// The projects open in the list (their sessions under them), by key, kept in memory only. Each has its own state: selecting a project opens it, its arrow opens and closes it, and a project that starts to work opens again.
const opened = new Set<string>();
// The sessions whose breakdown (the subagents and the command at work) is open under their row, by tab id, kept in memory only. A session starts closed, and one that left the list is forgotten.
const worksOpen = new Set<string>();
// The projects with a working session, in the order they entered that group. A read does not reorder them (the project list of the read is newest first by activity, which moves with the work); one that starts to work is put first, one that stops leaves the group.
let workingOrder: string[] = [];
// The sessions that worked at the last read that worked, by project (the pane keys of the rows): a project opens when a read has one that was not here.
let workingIds = new Map<string, Set<string>>();
// The target `workingOrder`, `workingIds` and `opened` were made for: the keys of another target are not these.
let workingTarget: string | null = null;
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
// What the feed, the tabs and the notice show now; they are drawn again only when this changes.
let feedKey = "";
let noticeKey = "";

const feed = () => $("orca-feed");
// The development screen is shown: the list is.
const listShown = () => currentScreen() === "orca";
// The work pane of Orca is shown: the screen is, and no formation is selected (a formation takes the place of the work pane, A-37).
const shown = () => listShown() && currentFormation() === null;
// The project the list marks as selected: none while a formation is.
const pickedProject = () => (currentFormation() === null ? projectKey : null);

// The selection of the list changed to or from a formation: what the screen shows is drawn again.
export const redrawOrca = () => draw();

export const worktreeLabel = (w: { repo: string; branch: string }) => `${w.repo} ・ ${w.branch}`;

// The name a session row of the list shows (A-8): the git branch of the worktree the item is in, and the worktree's name (the right side of `worktreeLabel`) when it has no branch.
const rowBranch = (item: { path: string; environment?: string | null; branch: string }) => mix.worktrees.find((w) => w.path === item.path && placeOf(w) === placeOf(item))?.gitBranch || item.branch;

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
  const working = rows.filter((r) => r.group === "working" && (r.status === "working" || r.status === "monitoring"));
  workingCount = working.length;
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

// A tab of the work pane: a Claude session, or a plain terminal of Orca (both are terminals), or a file open in the editor (A-18), or the difference of a file from HEAD (A-24), or the definition of a name of the editor (A-34), or a table or the SQL of a database (A-43).
interface Tab {
  id: string;
  kind: "claude" | "plain" | "file" | "diff" | "definition" | "database";
  status: OrcaStatus;
  label: string;
  title: string;
  // The first line of the newer of a Claude session's prompt and last answer, which its row in the list shows in place of the title (the tab shows the title); null for the rest, and for a session whose newer message has no text.
  latest: string | null;
  // How many subagents of a Claude session are at work, which its row in the list shows at its right end (the tab shows none); 0 for the rest.
  subagents: number;
  // The subagents at work with their names and tasks, which the breakdown of its row in the list shows (the tab shows none); empty for the rest.
  agents: OrcaSubagent[];
  // The command of the shell a Claude session is running (empty when Orca gave none), which its row in the list shows as a badge left of the subagents' (the tab shows none); null when it runs none, and for the rest.
  shell: string | null;
  // The Orca terminal's handle (a Claude session may have none: it shows no terminal and cannot be closed).
  handle: string | null;
  // The worktree it runs in (a file's: where the file is).
  path: string;
  // The worktree's name, "{repo} ・ {branch}", which the heading of the file pane shows.
  where: string;
  // The name a session row of the list shows (A-8): the git branch of its worktree, else the worktree's name (`rowBranch`). Only a Claude session and a plain terminal have one; the rest show `where`.
  branch?: string;
  // Where the tab is: null for this machine, else the name of the saved environment. A terminal's comes from its row, a file's and a diff's from the project they were opened in.
  environment: string | null;
  // A file outside the worktree that a definition named (A-34): the tab has a lock, and the file is read only. `gem` marks one that is a Ruby file.
  outside?: boolean;
  gem?: boolean;
}

// A tab with no terminal, whose page is a document of the worktree: a file in the editor, the difference of a file, or the definition of a name; or the page of a database (it has the main worktree of its project, so the file pane keeps its worktree).
const isDocument = (t: Tab) => t.kind === "file" || t.kind === "diff" || t.kind === "definition" || t.kind === "database";

// Where an item of a list is (A-6): the saved environment's name, null for this machine (an item with no `environment` is this machine's).
const placeOf = (item: { environment?: string | null }) => item.environment ?? null;

// Where the project `key` of the list is, which the layout of its panes, its files and its diffs are kept under. A key the list does not hold (a project that left) has no place of its own: the screen's target.
function projectPlace(key: string): string | null {
  const project = mix.projects.find((p) => p.key === key);
  return project === undefined ? (view?.target ?? null) : placeOf(project);
}

const claudeTabId = (paneKey: string) => `claude:${paneKey}`;
const plainTabId = (handle: string) => `orca:${handle}`;

// What a tab is known by in `seen`: its handle, else its id. The id changes with the kind of the terminal; the handle does not.
const keyOfTab = (t: Tab) => t.handle ?? t.id;

// The handles of the terminals of the tabs the read holds: the terminals on the screen are known by them.
const liveHandles = () => new Set<string>([...mix.rows.flatMap((r) => (r.paneKey === null || r.handle === null ? [] : [r.handle])), ...mix.terminals.map((t) => t.handle)]);

// Whether a worktree of the list is one made for a formation's child: the choices of a worktree leave it out (A-9, A-16, A-37).
const inChildWorktree = (item: { path: string; environment?: string | null }) => isChildWorktree(item.path, placeOf(item));

// The sessions of the project `key` that the list shows: its tabs other than files and diffs. A formation's child has no tab (A-37) and no row (A-8), so `tabsOf` has none of its sessions.
const ownTabs = (key: string) => tabsOf(key).filter((t) => !isDocument(t));

// How many worktrees of the project `key` are a launched child's folder (A-8): the list draws no row for them, and the project's row counts them beside the mark of a formation.
const childFolderCount = (key: string) => mix.worktrees.filter((w) => w.projectKey === key && isChildFolder(w.path, placeOf(w))).length;

// The tabs of the project `key`: its Claude sessions and its plain terminals, in the order they were first seen.
function tabsOf(key: string): Tab[] {
  const tabs: Tab[] = [];
  for (const r of mix.rows) {
    if (r.projectKey !== key || r.paneKey === null || isChildSession(r)) continue;
    tabs.push({ id: claudeTabId(r.paneKey), kind: "claude", status: r.status, label: STATUS_LABELS[r.status], title: r.line || "（題名なし）", latest: r.latest, subagents: r.subagents, agents: r.subagentList ?? [], shell: r.shell ?? null, handle: r.handle, path: r.path, where: worktreeLabel(r), branch: rowBranch(r), environment: placeOf(r) });
  }
  for (const t of mix.terminals) {
    if (t.projectKey !== key || isChildSession(t)) continue;
    const repo = mix.worktrees.find((w) => w.path === t.path && placeOf(w) === placeOf(t))?.repo ?? mix.projects.find((p) => p.key === t.projectKey)?.name ?? "";
    tabs.push({ id: plainTabId(t.handle), kind: "plain", status: "done", label: "起動中", title: t.title || "ターミナル", latest: null, subagents: 0, agents: [], shell: null, handle: t.handle, path: t.path, where: worktreeLabel({ repo, branch: t.branch }), branch: rowBranch(t), environment: placeOf(t) });
  }
  const place = projectPlace(key);
  for (const f of filesOf(place, key)) {
    const where = tabs.find((t) => t.path === f.path)?.where ?? mix.worktrees.find((w) => w.path === f.path && placeOf(w) === f.target) ?? gitWorktrees.get(gitKey(f.target, f.path))?.label;
    tabs.push({ id: f.id, kind: "file", status: "done", label: "", title: nameOf(f.relative), latest: null, subagents: 0, agents: [], shell: null, handle: null, path: f.path, where: where === undefined ? "" : typeof where === "string" ? where : worktreeLabel(where), environment: f.target, outside: f.outside, gem: f.outside && f.language === "ruby" });
  }
  for (const d of diffsOf(place, key)) {
    const where = tabs.find((t) => t.path === d.path)?.where ?? mix.worktrees.find((w) => w.path === d.path && placeOf(w) === d.target) ?? gitWorktrees.get(gitKey(d.target, d.path))?.label;
    tabs.push({ id: d.id, kind: "diff", status: "done", label: "", title: d.commit === null ? nameOf(d.relative) : `${nameOf(d.relative)} ${d.commit.shortId}`, latest: null, subagents: 0, agents: [], shell: null, handle: null, path: d.path, where: where === undefined ? "" : typeof where === "string" ? where : worktreeLabel(where), environment: d.target });
  }
  for (const d of definitionsOf(place, key)) {
    const where = tabs.find((t) => t.path === d.query.path)?.where ?? mix.worktrees.find((w) => w.path === d.query.path && placeOf(w) === d.target) ?? gitWorktrees.get(gitKey(d.target, d.query.path))?.label;
    tabs.push({ id: d.id, kind: "definition", status: "done", label: "", title: `定義 ・ ${d.query.word}`, latest: null, subagents: 0, agents: [], shell: null, handle: null, path: d.query.path, where: where === undefined ? "" : typeof where === "string" ? where : worktreeLabel(where), environment: d.target });
  }
  const main = mix.worktrees.find((w) => w.projectKey === key && w.isMain);
  for (const d of databaseTabsOf(place, key)) {
    tabs.push({ id: d.id, kind: "database", status: "done", label: "", title: d.title, latest: null, subagents: 0, agents: [], shell: null, handle: null, path: main?.path ?? "", where: main === undefined ? "" : worktreeLabel(main), environment: d.target });
  }
  // A Claude row that got its handle after it was first seen keeps the place it had under its id.
  for (const t of tabs) if (!seen.has(keyOfTab(t))) seen.set(keyOfTab(t), seen.get(t.id) ?? seen.size);
  return tabs.sort((a, b) => seen.get(keyOfTab(a))! - seen.get(keyOfTab(b))!);
}

// The layout of the selected project's work pane, as Rust answered it (null: no project, or no answer yet).
const currentLayout = () => (projectKey === null ? null : layoutOf(projectPlace(projectKey), projectKey));

// The tab of the selected project that a tab id of its layout means (`findTab`).
const tabOfId = (tabs: Tab[], id: string) => findTab(projectPlace(projectKey ?? ""), projectKey ?? "", tabs, id);

// The tab selected: the one shown in the pane that has the focus (null: no project, no answer yet, or no tab).
const selectedTab = () => focusedTab(currentLayout());

// ---- drawing ----

function drawBadge() {
  const viewed = viewedPane();
  if (viewed !== null) notified.delete(viewed);
  const waiting = waitingCount + notified.size;
  setNavCount("nav-orca", waiting, "開発", "確認待ち");
  // The number that work is not drawn: the button's icon is yellow and fades, and the label says it (read aloud, and in the tooltip on hover).
  const nav = $("nav-orca");
  nav.classList.toggle("working", workingCount > 0);
  const parts = [...(waiting > 0 ? [`確認待ち ${waiting} 件`] : []), ...(workingCount > 0 ? [`作業中 ${workingCount} 件`] : [])];
  nav.setAttribute("aria-label", parts.length === 0 ? "開発" : `開発（${parts.join("、")}）`);
}

const MISSING_NOTICE = "orca コマンドが見つかりません。Orca を入れると、動いているエージェントを見て、指示を送れます";

// What a read that did not work says (the side pane of A-9 shows it alike), else null.
export function noticeOf(v: OrcaOverview | null) {
  return v?.state === "missing" ? MISSING_NOTICE : v?.state === "failed" ? `読み込めませんでした: ${v.message}` : null;
}

// The lines of the notice above the list (A-6, A-33). While this machine is the target, or the command is missing, it is the one line of `noticeOf`. While a saved environment is the target, this machine and the saved environment are read apart,
// so each read that failed has a line of its own that names its place, this machine's first as in the list; the other place's rows stay drawn.
function noticeLines() {
  if (view === null) return [];
  if (view.target === null || view.state === "missing") {
    const text = noticeOf(view);
    return text === null ? [] : [{ text, failed: view.state === "failed" }];
  }
  const failed = (place: string, message: string) => ({ text: `${place} を読み込めませんでした: ${message}`, failed: true });
  const lines: { text: string; failed: boolean }[] = [];
  if (here?.state === "failed") lines.push(failed(THIS_MACHINE, here.message));
  if (view.state === "failed") lines.push(failed(view.target, view.message));
  return lines;
}

function drawNotice() {
  const lines = noticeLines();
  const key = JSON.stringify(lines);
  if (key === noticeKey) return;
  noticeKey = key;
  $("orca-notice").replaceChildren(
    ...lines.map((line) => {
      const row = tag("div", line.failed ? "pending fail" : "pending");
      row.append(tag("span", "sp", line.text));
      return row;
    }),
  );
}

// The heading's row or the search field shows (A-19), and the clear button of the field shows while something is typed.
function drawSearch() {
  $("orca-projects-head").hidden = searchOpen;
  $("orca-search").hidden = !searchOpen;
  $("orca-search-clear").hidden = query === "";
}

// The name of the saved environment a row of the list is in (A-33): a project of a saved environment has it, and those of this machine have none. The sessions, the tabs and the terminals show no place.
function environmentChip(environment: string) {
  const chip = tag("span", "orca-env", environment);
  chip.title = environment;
  return chip;
}

// The icon and the number of one kind of work in a session. The label comes from outside (the command): it is the title and the label, never markup.
function countNode(className: string, icon: string, n: number, label: string) {
  const badge = tag("span", className);
  badge.title = label;
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", label);
  badge.innerHTML = icon;
  badge.append(String(n));
  return badge;
}

// A line of the breakdown of a session: the icon of its kind, then the name and the task of a subagent, or the command. Everything comes from outside, so it is text and never markup.
function workNode(className: string, icon: string, text: string, task: string | null = null) {
  const line = tag("div", `orca-work ${className}`);
  line.innerHTML = icon;
  const name = tag("span", "orca-work-name", text);
  name.title = task === null ? text : `${text}: ${task}`;
  line.append(name);
  if (task !== null) line.append(tag("span", "orca-work-task", task));
  return line;
}

// A session of the open project and, when it has work in it, the arrow at its left and the breakdown under it while the arrow is open.
function sessionWithWorks(t: Tab, key: string) {
  const wrap = tag("div", "orca-sess");
  wrap.append(sessionNode(t, key));
  if (t.agents.length === 0 && t.shell === null) return wrap;
  const open = worksOpen.has(t.id);
  const arrow = tag("button", "icon-btn orca-session-arrow");
  arrow.type = "button";
  arrow.dataset.key = `works:${t.id}`;
  arrow.setAttribute("aria-expanded", String(open));
  arrow.setAttribute("aria-label", open ? "作業の内訳を閉じる" : "作業の内訳を開く");
  arrow.innerHTML = CHEVRON_SVG;
  arrow.onclick = () => toggleWorks(t.id);
  wrap.append(arrow);
  if (open) {
    const list = tag("div", "orca-works");
    list.append(...t.agents.map((a) => workNode("orca-work-agent", ROBOT_SVG, a.name === "" ? "サブエージェント" : a.name, a.task ?? null)));
    if (t.shell !== null) list.append(workNode("orca-work-shell", PLAY_SVG, t.shell === "" ? "シェルを実行中" : t.shell));
    wrap.append(list);
  }
  return wrap;
}

// A session of the open project: its status icon and the name of its worktree at the left, and at the right end an icon and a number for each kind of work in it (none for a kind that is 0). It is selected when it is the tab selected.
function sessionNode(t: Tab, key: string) {
  const row = tag("button", "orca-session");
  row.type = "button";
  row.dataset.key = `tab:${t.id}`;
  // Not `data-tab`: that names a tab of the work pane, which the pane tree looks for with `closest`.
  row.dataset.session = t.id;
  row.setAttribute("aria-pressed", String(key === pickedProject() && t.id === selectedTab()));
  row.append(statusIcon(t.status, t.label));
  // The branch of the worktree the session works in, else the worktree's name (the `branch` of its tab); the title of the tab is the line of A-6.
  row.append(tag("span", "orca-session-title", t.branch ?? t.where));
  // The AI (the subagents) and the commands. A session runs at most one command (`shell`), so its number is 1.
  const counts = tag("span", "orca-session-counts");
  if (t.subagents > 0) counts.append(countNode("orca-session-subagents", ROBOT_SVG, t.subagents, `サブエージェント ${t.subagents} 件が作業中`));
  if (t.shell !== null) counts.append(countNode("orca-session-shell", PLAY_SVG, 1, t.shell === "" ? "シェルを実行中" : `シェルを実行中: ${t.shell}`));
  if (counts.children.length) row.append(counts);
  row.onclick = () => selectSession(key, t.id);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    // A terminal is shown in one place at a time: the selected project's is in the work pane, and a session with no terminal has none to show.
    if (key === pickedProject() || (tabsOf(key).find((x) => x.id === t.id)?.handle ?? null) === null) return;
    openPeek(key, t.id, `tab:${t.id}`);
    syncPeek();
  };
  return row;
}

// A project: its status icon and its name, and at the right end the chip of its saved environment and the mark of the formations with the number of their worktrees. A project with sessions has the arrow at its left, and while it is open its sessions are under it, in the order of the tabs (`tabs`: its tabs other than files).
function projectNode(key: string, name: string, status: OrcaStatus, environment: string | null, tabs: Tab[], onCursor: boolean, re: RegExp | null) {
  const wrap = tag("div", "orca-proj");
  const row = tag("button", "orca-project");
  row.type = "button";
  row.dataset.key = key;
  row.setAttribute("aria-pressed", String(key === pickedProject()));
  if (onCursor) row.dataset.cursor = "true";
  const label = tag("span", "orca-project-name");
  label.append(...nameNodes(name, re));
  row.append(statusIcon(status), label);
  if (environment !== null) row.append(environmentChip(environment));
  // The worktrees of the launched children of the formations, which the list draws no row for: the mark of a formation and their number, at the right end (none when there is none).
  const children = childFolderCount(key);
  if (children > 0) row.append(countNode("orca-project-formation", FORMATION_SVG, children, `フォーメーション ${children}`));
  row.onclick = () => selectProject(key);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    // The first session of the project (A-40). A selected project's terminal is in the work pane, and a project with no session, or a session with no terminal, has none to show.
    // Read at the press: the row is not drawn again when its first session changes.
    const first = ownTabs(key)[0];
    if (key === pickedProject() || first === undefined || first.handle === null) return;
    openPeek(key, first.id, key);
    syncPeek();
  };
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
    list.append(...tabs.map((t) => sessionWithWorks(t, key)));
    wrap.append(list);
  }
  return wrap;
}

function emptyNode(text: string) {
  if (view === null) {
    const loadingRow = tag("div", "pending");
    loadingRow.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    return loadingRow;
  }
  return view.state === "ready" ? tag("div", "feed-empty", text) : tag("div");
}

// Keeps `workingOrder` and `opened` in step with the sessions of a read that worked. A project is in the working group when a session of it works (its own status may be a question, which outranks working), or when its icon works with no working Claude row (another agent, or a worktree's status). One that works and was not in the group enters it at the front (the newest first among those that enter together, as the read lists them); one that does not work leaves it. A project opens when work appears in it that the last read did not have (a working session, or the project's own work with no such session), also when the user closed it; work that went on leaves it as the user left it. The first read of a target puts all that work in, so they all open. A read that failed, or the first one of a new target, says nothing. A project the list no longer holds is forgotten by `opened`.
function trackWorking() {
  if (view === null || (view.state !== "ready" && here?.state !== "ready")) return;
  if (view.target !== workingTarget) {
    workingTarget = view.target;
    workingOrder = [];
    workingIds = new Map();
    opened.clear();
    // The project chosen before the first read of this target (A-9) stays open.
    if (projectKey !== null) opened.add(projectKey);
  }
  const now = new Map<string, Set<string>>();
  for (const r of mix.rows) {
    if (r.status !== "working") continue;
    const ids = now.get(r.projectKey) ?? new Set<string>();
    ids.add(r.paneKey ?? `${r.repo}/${r.branch}`);
    now.set(r.projectKey, ids);
  }
  // A project whose icon works with no working Claude row: its own id, which no pane key is.
  for (const p of mix.projects) if (p.status === "working" && !now.has(p.key)) now.set(p.key, new Set([`project:${p.key}`]));
  const keys = mix.projects.map((p) => p.key).filter((k) => now.has(k));
  const kept = workingOrder.filter((k) => keys.includes(k));
  for (const k of keys) if ([...now.get(k)!].some((id) => !workingIds.get(k)?.has(id))) opened.add(k);
  workingOrder = [...keys.filter((k) => !kept.includes(k)), ...kept];
  workingIds = now;
  const known = new Set(mix.projects.map((p) => p.key));
  for (const k of opened) if (!known.has(k)) opened.delete(k);
  const live = new Set(mix.rows.flatMap((r) => (r.paneKey === null ? [] : [claudeTabId(r.paneKey)])));
  for (const id of worksOpen) if (!live.has(id)) worksOpen.delete(id);
}

// Whether the project `key` works with nothing but a launched child's sessions (A-8): it has a working session, and every working session is a child's.
const childOnlyWorking = (key: string) => {
  const working = mix.rows.filter((r) => r.projectKey === key && r.status === "working");
  return working.length > 0 && working.every(isChildSession);
};

// The rows of the list: the projects of the target (the working ones first, in the order they began to work, then the stopped ones, which have a session and do not work, then those with no session, both as the read lists them). The working projects that work with a child's sessions alone go last, so that they sit above the link of the projects that are not running.
function projectRows(): OrcaProject[] {
  const all = mix.projects;
  const rest = all.filter((p) => !workingOrder.includes(p.key));
  const pick = (keys: string[]) => keys.flatMap((k) => all.filter((p) => p.key === k));
  return [...pick(workingOrder.filter((k) => !childOnlyWorking(k))), ...rest.filter((p) => p.sessions > 0), ...rest.filter((p) => p.sessions === 0), ...pick(workingOrder.filter(childOnlyWorking))];
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

// A project that is not running (A-8): the gray dot (nothing works, waits or has stopped there), and no session and no terminal. The selected project is never one, so the row the work pane shows stays in the list.
const isNotRunning = (p: OrcaProject) => p.status === "idle" && p.sessions === 0 && p.key !== pickedProject();

// The rows the list shows, the running ones first and then the ones that are not running: the whole list while a search text is typed (the rows whose name holds it), else the running ones, and the others only while the link is open.
function visibleRows(re: RegExp | null) {
  const rows = projectRows();
  const running = rows.filter((r) => !isNotRunning(r));
  const stopped = rows.filter((r) => isNotRunning(r));
  if (re !== null) return [...running, ...stopped].filter((r) => re.test(r.name));
  return stoppedOpen ? [...running, ...stopped] : running;
}

// How many projects are not running, which the link counts (none while a search text is typed, which has no link).
const stoppedCount = () => (needle() === "" ? mix.projects.filter(isNotRunning).length : 0);

// The link under the running projects (A-8): "› 起動していない N 件" while the others are closed, "起動していないものを隠す" while they are listed under it.
function stoppedToggle(count: number) {
  const button = tag("button", "orca-stopped-toggle");
  button.type = "button";
  button.dataset.key = "stopped-toggle";
  button.setAttribute("aria-expanded", String(stoppedOpen));
  button.innerHTML = CHEVRON_SVG;
  button.append(stoppedOpen ? "起動していないものを隠す" : `起動していない ${count} 件`);
  button.onclick = () => {
    stoppedOpen = !stoppedOpen;
    drawFeed();
  };
  return button;
}

// The keys of the rows the keys of the search field can reach, in the order of the list (none while nothing is typed), and the one they are on.
function reachable(rows = visibleRows(matcher())) {
  if (needle() === "") return [];
  return rows.map((r) => r.key);
}
function cursorKey(rows = visibleRows(matcher())) {
  const keys = reachable(rows);
  return cursor !== null && keys.includes(cursor) ? cursor : (keys[0] ?? null);
}

// `openTabs`: the tabs other than files of the open projects, found once for the drawing; the others are found here. The link goes after the last running project, and the ones that are not running, when it is open, follow it.
function projectNodes(re: RegExp | null, rows: ReturnType<typeof visibleRows>, on: string | null, openTabs: Map<string, Tab[]>): HTMLElement[] {
  const node = (r: OrcaProject) => projectNode(r.key, r.name, r.status, placeOf(r), openTabs.get(r.key) ?? ownTabs(r.key), r.key === on, re);
  const count = stoppedCount();
  const nodes = count === 0 ? rows.map(node) : [...rows.filter((r) => !isNotRunning(r)).map(node), stoppedToggle(count), ...rows.filter(isNotRunning).map(node)];
  return nodes.length ? nodes : [emptyNode(needle() === "" ? "プロジェクトがありません" : "一致するプロジェクトがありません")];
}

// Draws the list where it is: the scroll position and the focused row stay, and nothing is drawn when nothing changed.
function drawFeed() {
  trackWorking();
  // The sessions under the open projects: what is drawn of them.
  const openTabs = new Map([...opened].map((k): [string, Tab[]] => [k, ownTabs(k)]));
  const sessions = [...openTabs].map(([k, tabs]) => [k, tabs.map((t) => [t.id, t.status, t.label, t.title, t.where, t.branch, t.subagents, t.agents, t.shell, t.environment, worksOpen.has(t.id)])]);
  // Only what is drawn: a project's time of activity moves with the work and would redraw the list (and restart the working mark) for nothing.
  const rowOf = (p: OrcaProject) => [p.key, p.name, p.status, p.sessions, placeOf(p), childFolderCount(p.key), childOnlyWorking(p.key)];
  // The rows of the projects, the search expression and the row the keys are on: found once for this drawing.
  const re = matcher();
  const rows = visibleRows(re);
  const on = cursorKey(rows);
  const key = JSON.stringify([view?.state ?? null, mix.projects.map(rowOf), needle(), on, pickedProject(), sessions, selectedTab(), stoppedOpen]);
  if (key === feedKey) return;
  feedKey = key;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  box.replaceChildren(...projectNodes(re, rows, on, openTabs));
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
  select.append(t.outside ? lockIcon() : t.kind === "file" ? fileIcon() : t.kind === "diff" ? diffIcon() : t.kind === "definition" ? definitionIcon() : t.kind === "database" ? databaseIcon() : statusIcon(t.status, t.label), tag("span", "orca-tab-title", t.title));
  if (t.kind === "definition") wrap.dataset.definition = "true";
  if (t.kind === "database") wrap.dataset.database = "true";
  if (t.kind === "file") {
    wrap.dataset.file = "true";
    if (t.outside) {
      wrap.dataset.outside = "true";
      if (t.gem) select.append(tag("span", "orca-tab-gem", "gem"));
    }
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

// The mark of the tab of a file outside the worktree: it is read only (A-34).
function lockIcon() {
  const icon = tag("span", "orca-ic orca-file-tab-ic");
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", "読み取り専用");
  icon.innerHTML = LOCK_SVG;
  return icon;
}

// The mark of a diff's tab.
function diffIcon() {
  const icon = tag("span", "orca-ic orca-file-tab-ic");
  icon.innerHTML = DIFF_SVG;
  return icon;
}

// The mark of a definition's tab.
function definitionIcon() {
  const icon = tag("span", "orca-ic orca-file-tab-ic");
  icon.innerHTML = DEFINITION_SVG;
  return icon;
}

// The mark of a database tab.
function databaseIcon() {
  const icon = tag("span", "orca-ic orca-file-tab-ic");
  icon.innerHTML = DATABASE_SVG;
  return icon;
}

// The line under a pane's strip that says why it shows no terminal, else null.
function emptyText(tabs: Tab[], tab: Tab | undefined) {
  if (started !== null) return null;
  if (projectKey === null) return "プロジェクトを選んでください";
  if (tabs.length === 0) return "セッションはありません";
  return tab !== undefined && !isDocument(tab) && tab.handle === null ? "このセッションのターミナルはありません" : null;
}

// The tree of the layout for drawing: each pane with the tabs it holds that the list still has (a tab that left shows no more before Rust's next answer), and the one it shows.
// A tab id the layout holds from before a terminal changed kind is taken as the tab with the same handle (`find`) until Rust's answer.
function treeOf(node: PaneNode, tabs: Tab[], focus: string | null, plusDisabled: boolean, find: (id: string) => Tab | undefined): TreeModel {
  if (node.kind === "split") return { kind: "split", direction: node.direction, children: node.children.map((c) => treeOf(c, tabs, focus, plusDisabled, find)), sizes: node.sizes };
  const mine = [...new Set(node.tabs.flatMap((id) => find(id) ?? []))];
  const dirty = dirtyIds();
  const selected = find(node.selected);
  const tab = mine.find((t) => t.id === selected?.id);
  const pane: PaneModel = {
    id: node.id,
    key: JSON.stringify([mine.map(({ latest, subagents, agents, shell, ...t }) => t), node.selected, [...closing], mine.filter((t) => dirty.has(t.id)).map((t) => t.id)]),
    tabs: () => mine.map((t) => tabNode(t, t.id === tab?.id)),
    focused: node.id === focus,
    empty: emptyText(tabs, tab),
    terminal: !!tab?.handle,
    editor: tab !== undefined && isDocument(tab),
    plusDisabled,
    filesShown: filesShown(),
    listOpen,
  };
  return { kind: "pane", pane };
}

// The work pane follows the layout: the panes with their tab strips (a project with no layout yet, or with no tab, has one empty pane), and the terminal of the tab selected in each pane, else a line that says why there is none.
function drawWork(tabs: Tab[]) {
  syncLayout(tabs);
  const layout = currentLayout();
  const plusDisabled = busy || startWaits() || projectKey === null || view === null || view.state === "missing";
  const empty: TreeModel = { kind: "pane", pane: { id: "", key: "", tabs: () => [], focused: false, empty: emptyText(tabs, undefined), terminal: false, editor: false, plusDisabled, filesShown: filesShown(), listOpen } };
  paneHosts = drawTree(layout?.root ? treeOf(layout.root, tabs, layout.focus, plusDisabled, (id) => tabOfId(tabs, id)) : empty);
  drawStarted();
}

// Shows the terminal of the tab selected in each pane while the screen is shown: streamed from a saved environment, mirrored on this machine.
function syncTerminal(tabs: Tab[] = projectKey === null ? [] : tabsOf(projectKey)) {
  const layout = shown() ? currentLayout() : null;
  const placements: Placement[] = [];
  for (const pane of panesOf(layout?.root ?? null)) {
    const tab = tabOfId(tabs, pane.selected);
    const host = paneHosts.get(pane.id);
    if (tab?.handle && host) placements.push({ id: tab.handle, source: { kind: tab.environment !== null && streamsEnvironment(tab.environment) ? "stream" : "mirror", handle: tab.handle, path: tab.path, environment: tab.environment }, host });
  }
  if (placements.length === 0) return hideTerminals();
  showTerminals(placements, tabOfId(tabs, selectedTab() ?? "")?.handle ?? null);
}

// Shows the editor of the file tab selected in each pane while the screen is shown.
function syncEditor(tabs: Tab[]) {
  const layout = shown() ? currentLayout() : null;
  const placements: { id: string; host: HTMLElement }[] = [];
  for (const pane of panesOf(layout?.root ?? null)) {
    const tab = tabOfId(tabs, pane.selected);
    const host = editorHostOf(pane.id);
    if (tab?.kind === "file" && host) placements.push({ id: tab.id, host });
  }
  // A file that comes back into a pane is read again while the file pane is shown (A-18).
  showEditors(placements, filesShown());
}

// Shows the difference of the diff tab selected in each pane while the screen is shown (in the host of the editor, which a pane shows one of).
function syncDiff(tabs: Tab[]) {
  const layout = shown() ? currentLayout() : null;
  const placements: { id: string; host: HTMLElement }[] = [];
  for (const pane of panesOf(layout?.root ?? null)) {
    const tab = tabOfId(tabs, pane.selected);
    const host = editorHostOf(pane.id);
    if (tab?.kind === "diff" && host) placements.push({ id: tab.id, host });
  }
  showDiffs(placements, filesShown());
}

// Shows the definition of the definition tab selected in each pane while the screen is shown (in the host of the editor, which a pane shows one of).
function syncDefinition(tabs: Tab[]) {
  const layout = shown() ? currentLayout() : null;
  const placements: { id: string; host: HTMLElement }[] = [];
  for (const pane of panesOf(layout?.root ?? null)) {
    const tab = tabOfId(tabs, pane.selected);
    const host = editorHostOf(pane.id);
    if (tab?.kind === "definition" && host) placements.push({ id: tab.id, host });
  }
  showDefinitions(placements);
}

// Shows the page of the database tab selected in each pane while the screen is shown (in the host of the editor, which a pane shows one of).
function syncDatabase(tabs: Tab[]) {
  const layout = shown() ? currentLayout() : null;
  const placements: { id: string; host: HTMLElement }[] = [];
  for (const pane of panesOf(layout?.root ?? null)) {
    const tab = tabOfId(tabs, pane.selected);
    const host = editorHostOf(pane.id);
    if (tab?.kind === "database" && host) placements.push({ id: tab.id, host });
  }
  showDatabaseTabs(placements);
}

// The git worktrees that the list of branches of the file pane showed and Orca's list lacks (A-25), by target and path: the label of their heading and of the tabs of their files, and the git branch they are on.
const gitWorktrees = new Map<string, { project: string; target: string | null; path: string; label: string; gitBranch: string }>();
const gitKey = (target: string | null, path: string) => `${target ?? ""}\n${path}`;
// The worktree picked in the list of branches (A-25): the file pane shows it instead of the selected tab's worktree, for the tab that was selected then of the project then. Another tab, or another project, ends it.
let pickedWorktree: { project: string; tab: string; target: string | null; path: string; label: string } | null = null;

// The worktree the file pane shows: the one picked in the list of branches while the tab stays selected, else the selected tab's, else (no tab) the main worktree of the selected project.
function filesWorktree(tabs: Tab[]): { path: string; label: string; environment: string | null } | null {
  if (pickedWorktree !== null) {
    if (pickedWorktree.project === projectKey && pickedWorktree.tab === (selectedTab() ?? "")) return { path: pickedWorktree.path, label: pickedWorktree.label, environment: pickedWorktree.target };
    pickedWorktree = null;
  }
  const tab = tabOfId(tabs, selectedTab() ?? "");
  if (tab !== undefined && tab.path !== "") return { path: tab.path, label: tab.where, environment: tab.environment };
  if (tab !== undefined || projectKey === null) return null;
  const main = mix.worktrees.find((w) => w.projectKey === projectKey && w.isMain);
  // A project with tabs whose layout is not answered yet has no selected tab for a moment: nothing is read for it,
  // except when the only tabs are files of the main worktree (the first file opened in a project with no tab), whose tree stays.
  if (tabs.some((t) => !isDocument(t) || t.path !== main?.path)) return null;
  return main === undefined ? null : { path: main.path, label: worktreeLabel(main), environment: placeOf(main) };
}

// The file pane follows its worktree and the files open in it.
function drawFiles(tabs: Tab[]) {
  const worktree = filesWorktree(tabs);
  const target = worktree?.environment ?? null;
  // The branch of the heading is a button (A-25) for a worktree of the list that is on a git branch. It is the git branch, not Orca's name of the worktree.
  const listed = worktree === null ? undefined : mix.worktrees.find((w) => w.path === worktree.path && placeOf(w) === target);
  // A git worktree that Orca's list lacks has its branch from the list of branches.
  const git = worktree === null || listed !== undefined ? undefined : gitWorktrees.get(gitKey(target, worktree.path));
  const branch = listed !== undefined ? (listed.gitBranch !== "" && worktree?.label === worktreeLabel(listed) ? listed.gitBranch : null) : git !== undefined && git.gitBranch !== "" && worktree?.label === git.label ? git.gitBranch : null;
  syncFiles(worktree === null ? null : { target, path: worktree.path, label: worktree.label, project: projectKey ?? "", branch }, worktree === null || projectKey === null ? new Set() : openedIn(target, projectKey, worktree.path));
}

// A file of the file pane was pressed twice: it opens as a tab in the focused pane and is selected, and the editor takes the typing.
function openFile(relative: string) {
  const worktree = projectKey === null ? null : filesWorktree(tabsOf(projectKey));
  if (worktree === null || projectKey === null || view === null) return;
  started = null;
  const id = openEditorFile(worktree.environment, projectKey, worktree.path, relative);
  // The select asks Rust for the layout with the new tab in it (`runPaneOp` reads the tabs when it asks).
  chooseTab(id);
  draw();
}

// A name of the editor was pressed with the Command key and the right button (A-34): the definition tab of the project (made when there is none) asks for the definition of the name. A new tab is split off below the pane of the editor that asked (A-17); the tab that is open already, wherever it is, is selected, and the layout stays.
function askDefinition(query: DefinitionQuery) {
  if (projectKey === null || view === null) return;
  started = null;
  const { tab, created } = openDefinition(query);
  const pane = panesOf(currentLayout()?.root ?? null).find((p) => p.tabs.includes(query.tab));
  // The move adds the new tab to the layout before it moves it (Rust mends the layout against the tabs the screen shows first).
  if (created && pane !== undefined) runPaneOp({ kind: "move", tab: tab.id, pane: pane.id, edge: "bottom" });
  else chooseTab(tab.id);
  draw();
}

// A place of a definition was opened (A-34): its file is a tab of the editor, in the pane of the editor that asked (the first pane that is not the definition's when that tab is gone), and the caret goes to the place when the text is shown. A file that is open already is selected where it is.
function openPlace(place: DefinitionOpen) {
  const { query, path, outside, line, character } = place;
  if (projectKey === null || view === null) return;
  started = null;
  const id = openEditorFile(query.target, query.project, query.path, path, outside ? query.server : null);
  const panes = panesOf(currentLayout()?.root ?? null);
  const near = panes.find((p) => p.tabs.includes(query.tab)) ?? panes.find((p) => !p.tabs.includes(place.definition));
  if (near !== undefined && !panes.some((p) => p.tabs.includes(id))) runPaneOp({ kind: "move", tab: id, pane: near.id, edge: "center" });
  else chooseTab(id);
  draw();
  goTo(id, line, character);
}

// A request to open an HTML preview (A-45, #985), from a Claude Code through the app (a push of a saved environment's PC, or the screen bridge of this PC): the file is a tab of the project that has the worktree, in the preview, and the tab is selected when that project is the one selected. The request is data from outside, so Rust checks it again (`orca_preview_check`: the file A-31 opens, a worktree of the list read just now), and the list held here must have the worktree (it is read again once when it lacks it, for a worktree that was made a moment ago). The screen is not switched and no project is selected for it: another project, or a formation selected, only gets the tab; a screen that is not shown has it ready when it is shown again.
// The screen answers once the check has passed, and opens the tab after the answer: the read of the list may take longer than the wait of the bridge (5 seconds), and a tool that failed on the wait would leave a tab that opens later. A refusal after the answer is a card (A-28).
async function openPreview(fields: Fields) {
  const [path, relative, environment] = [fields.path ?? "", fields.relative ?? "", fields.environment || null];
  if (view === null) throw new Error("開発の画面の一覧をまだ読めていません");
  await invoke("orca_preview_check", { path, relative, environment });
  void openCheckedPreview(path, relative, environment).catch((e) => showFailure("orca", e instanceof Error ? e.message : e));
}

async function openCheckedPreview(path: string, relative: string, environment: string | null) {
  const find = () => mix.worktrees.find((w) => w.path === path && placeOf(w) === environment);
  let worktree = find();
  if (worktree === undefined) {
    await refreshOrca(true);
    worktree = find();
  }
  if (worktree === undefined) throw new Error("そのフォルダは、一覧のプロジェクトにありません");
  const id = openEditorFile(environment, worktree.projectKey, path, relative);
  if (currentFormation() === null && worktree.projectKey === projectKey) chooseTab(id);
  draw();
}

registerDraftTarget("preview-open", {
  names: ["path", "relative", "environment"],
  isOpen: () => true,
  // The target only takes a request: a read holds nothing.
  read: () => ({ path: "", relative: "", environment: "" }),
  write: openPreview,
});

// A table of the database part of the file pane was pressed (A-43): it opens as a tab in the focused pane and is selected, with the first page of its records; one that is open already is selected and read again.
function openDatabaseTable(profile: DatabaseProfileView, database: string, table: string) {
  if (projectKey === null || view === null) return;
  started = null;
  chooseTab(openTable(projectPlace(projectKey), projectKey, profile, database, table).tab.id);
  draw();
}

// 「新規クエリ」 of a database of the database part was pressed (A-43): the SQL of the database opens as a new tab in the focused pane, and takes the typing.
function openDatabaseQuery(profile: DatabaseProfileView, database: string) {
  if (projectKey === null || view === null) return;
  started = null;
  chooseTab(openQuery(projectPlace(projectKey), projectKey, profile, database).id);
  draw();
}

// The difference of a file of the file pane from HEAD (its menu), or, with `commit`, of a file of a commit of the history (A-27): it opens as a tab in the focused pane and is selected; one that is open already is selected and read again.
function openDiff(relative: string, commit: DiffCommit | null = null) {
  const worktree = projectKey === null ? null : filesWorktree(tabsOf(projectKey));
  if (worktree === null || projectKey === null || view === null) return;
  started = null;
  const id = openDiffTab(worktree.environment, projectKey, worktree.path, relative, commit);
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

// Takes a read as the one shown. A read that did not learn the target and the environments (a poll, or a failed `environment list`) leaves the ones held;
// a failed read keeps the rows, worktrees, projects and terminals held while the target is the same; a missing command empties them.
function adopt(read: OrcaOverview) {
  const next = !read.known && view !== null ? { ...read, target: view.target, environments: view.environments } : read;
  const keep = next.state === "failed" && view !== null && view.state !== "missing" && view.target === next.target;
  // A target that changed (the saved one is gone, or the file was changed): the notices and the base of the old one are not the new one's.
  if (view !== null && next.target !== view.target) forgetNotices();
  view = keep ? { ...next, rows: view!.rows, worktrees: view!.worktrees, projects: view!.projects, terminals: view!.terminals } : next;
  // The count and the notices are the target's alone (A-6): `view` holds the target's lists, and this machine's, beside them, are not tracked.
  if (view.state === "ready") track(view.rows);
  else if (view.state === "missing") forgetNotices();
  else workingCount = 0;
  adoptHere(next.local);
  settle();
}

// Takes this machine's read beside a saved environment's (A-33): while this machine is the target, or the command is missing, there is none. A read that did not come with one (a poll that failed before it, an event of the stream) leaves what is held,
// and one that failed keeps the lists of the last good read and says its state, so that this machine's rows stay while it cannot be read.
function adoptHere(read: OrcaLocal | null | undefined) {
  if (view === null || view.target === null || view.state === "missing") here = null;
  else if (read) {
    here = read.state === "ready" ? read : { ...read, rows: here?.rows ?? [], worktrees: here?.worktrees ?? [], projects: here?.projects ?? [], terminals: here?.terminals ?? [] };
    hereTry = Date.now();
  }
  remix();
}

// Puts the lists of the target and of this machine in one (A-33): this machine's first, and the projects newest first as each list is (a stable sort keeps this machine's first on a tie). The sidebar's count and the side pane of A-9 read `view`, not this.
function remix() {
  if (view === null || view.target === null || here === null) {
    mix = { rows: view?.rows ?? [], worktrees: view?.worktrees ?? [], projects: view?.projects ?? [], terminals: view?.terminals ?? [] };
    return;
  }
  mix = {
    rows: [...here.rows, ...view.rows],
    worktrees: [...here.worktrees, ...view.worktrees],
    projects: [...here.projects, ...view.projects].sort((a, b) => b.atMs - a.atMs),
    terminals: [...here.terminals, ...view.terminals],
  };
}

// What a read of the lists leaves to do: a terminal that left Orca's list leaves the tabs with its screen (in each place that was read well), the order of tabs gone is dropped, and a start that waits is looked for.
function settle() {
  if (view === null) return;
  const read = [...(view.state === "ready" ? [view.target] : []), ...(here?.state === "ready" ? [null] : [])];
  if (read.length > 0) {
    const held = liveHandles();
    pruneTerminals((handle, source) => !read.includes(source.environment) || held.has(handle));
    forgetGone();
  }
  claimStarted();
}

// A start that gave a pane key or a handle waits for its tab: a Claude session's row is matched by either (as the side pane of A-9 does), a terminal by its handle.
const startWaits = () => started !== null && (started.paneKey !== null || started.handle !== null);

// A start whose tab the read holds now is selected (its project and its tab, so its terminal shows); one that waited too long, even if the read failed, or one for another target, is dropped.
function claimStarted() {
  if (!startWaits()) return;
  const wait = started!;
  // A formation is selected meanwhile: the session is not selected, because that would take the screen back to the work pane (the start is dropped).
  if (currentFormation() !== null) {
    started = null;
    return;
  }
  if (Date.now() > wait.until) {
    started = null;
    return;
  }
  if (view === null) return;
  // The list of the place the start was made in: the target's, or this machine's beside it (A-33). Another target, or no read of this machine yet, ends the wait; a list that failed (or is not read yet) keeps it till its 30 seconds are over.
  const place = wait.target === view.target ? view : wait.target === null ? here : null;
  if (place === null) {
    started = null;
    return;
  }
  if (place.state !== "ready") return;
  const row = wait.kind === "claude" ? mix.rows.find((r) => (wait.paneKey !== null && r.paneKey === wait.paneKey) || (wait.handle !== null && r.handle === wait.handle)) : undefined;
  const terminal = wait.kind === "terminal" && wait.handle !== null ? mix.terminals.find((t) => t.handle === wait.handle) : undefined;
  if (row?.paneKey) pickRow(row);
  if (terminal) pickTerminal(terminal);
  if (row || terminal) started = null;
}

// The order of tabs that are no longer anywhere is dropped, so it does not pile up.
function forgetGone() {
  const live = new Set<string>([...mix.rows.flatMap((r) => (r.paneKey === null ? [] : [r.handle ?? claudeTabId(r.paneKey)])), ...mix.terminals.map((t) => t.handle), ...filesOf(projectPlace(projectKey ?? ""), projectKey ?? "").map((f) => f.id), ...diffsOf(projectPlace(projectKey ?? ""), projectKey ?? "").map((d) => d.id), ...definitionsOf(projectPlace(projectKey ?? ""), projectKey ?? "").map((d) => d.id), ...databaseTabsOf(projectPlace(projectKey ?? ""), projectKey ?? "").map((d) => d.id)]);
  for (const key of seen.keys()) if (!live.has(key)) seen.delete(key);
}

// Whether the language server of the worktree at `path` of `environment` is to stop (A-34): no tab of the worktree is open (a session, a terminal, a file, a difference or a definition of any project), or it has not the worktree any more in a list that was read well. A place that the screen does not list now (another saved environment than the one it shows) has no session or terminal tab open, so it needs no list: its server stops when no file or difference of the worktree is open.
function serverGone(environment: string | null, path: string) {
  const listed = environment === view?.target || (environment === null && here !== null);
  const kept = () => hasFileIn(environment, path) || hasDiffIn(environment, path) || hasDefinitionIn(environment, path);
  if (!listed) return !kept();
  if (!listRead(environment)) return false;
  if (worktreeGone(environment, path)) return true;
  const open = mix.rows.some((r) => r.paneKey !== null && r.path === path && placeOf(r) === environment) || mix.terminals.some((t) => t.path === path && placeOf(t) === environment);
  return !open && !kept();
}

// Whether the list of `environment` is on the screen and was read well.
const listRead = (environment: string | null) => (environment === view?.target ? view?.state === "ready" : environment === null && here?.state === "ready");

// Whether Orca's list, read well, has not the worktree at `path` of `environment` any more (A-34: the pane of Claude Code of the language servers closes by this alone, and not with the last tab of the worktree). A list that is not on the screen or not read well does not say it.
function worktreeGone(environment: string | null, path: string) {
  return listRead(environment) && !mix.worktrees.some((w) => w.path === path && placeOf(w) === environment);
}

// The modal of A-40 shows the session it was opened for as the list has it now, and closes when the list no longer has it, when its project was selected, or when the screen is not shown.
function syncPeek() {
  const at = peeking();
  if (at === null) return;
  const t = listShown() && at.project !== pickedProject() ? tabsOf(at.project).find((x) => x.id === at.tab) : undefined;
  if (t === undefined || t.handle === null) return closePeek();
  const name = mix.projects.find((p) => p.key === at.project)?.name ?? "";
  drawPeek({ status: t.status, label: t.label, project: name, title: t.latest ?? t.title, environment: t.environment, source: { kind: t.environment !== null && streamsEnvironment(t.environment) ? "stream" : "mirror", handle: t.handle, path: t.path, environment: t.environment } });
}

function draw() {
  syncServers(serverGone, worktreeGone);
  drawBadge();
  // Before the terminals of the screen are shown, so that a terminal the project selected now owns is not held by the modal.
  syncPeek();
  if (!listShown()) return pauseLsp();
  drawNotice();
  drawSearch();
  drawFeed();
  // A formation takes the place of the work pane: the terminals of the pane are hidden, and nothing else of it is drawn.
  if (!shown()) {
    pauseLsp();
    return syncTerminal();
  }
  const tabs = projectKey === null ? [] : tabsOf(projectKey);
  drawWork(tabs);
  drawFiles(tabs);
  syncTerminal(tabs);
  syncEditor(tabs);
  syncDiff(tabs);
  syncDefinition(tabs);
  syncDatabase(tabs);
}

// ---- the stream of a saved environment ----

// Whether the list of the target held is streamed.
const streaming = () => streamTarget !== null && streamTarget === view?.target;

// Streams the list while the target is a saved environment that is listed (and the command is there), and ends the stream otherwise. The stream tries a lost connection again by itself.
function syncStream() {
  const want = view !== null && view.state !== "missing" && view.target !== null && view.environments.includes(view.target) ? view.target : null;
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
    adopt({ ...view, state: "failed", message: event.message, known: false, local: null });
  } else {
    adopt({ ...view, state: "ready", message: "", rows: event.rows, worktrees: event.worktrees, projects: event.projects, terminals: event.terminals, known: false, local: null });
  }
  draw();
}

// What a read after a failure, the first one and one with the command missing ask for: everything. A working list is read for its agents (the screen shown) or their count.
const clockScope = (): Scope => (view?.state !== "ready" ? "full" : listShown() ? "screen" : "badge");

// Reads the list. Only the latest request is used; `force` starts one although another is on its way (after a launch, a close or a change of the target).
async function load(scope: Scope, force = false) {
  if (loading && !force) return;
  const seq = ++loadSeq;
  loading = true;
  lastTry = Date.now();
  // A read of the lists reads this machine's beside a saved environment's, so the clock's read of it (`loadHere`) waits one period.
  if (scope !== "badge" && view?.target != null) hereTry = Date.now();
  let next: OrcaOverview;
  try {
    next = await invoke("orca_overview", { scope, target: view?.target ?? null });
  } catch (e) {
    next = { state: "failed", message: String(e), target: null, environments: [], rows: [], worktrees: [], projects: [], terminals: [], known: false };
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

// Reads this machine's lists while a saved environment is the target and streamed (A-33): the stream gives the target's, and `orca_overview` is not read by the clock then. `force` starts a read although another is on its way (after a start or a close), and the return of the older one is dropped. It is the read of the pane of A-9 for this machine (`orca_destination`),
// which changes nothing else of the screen. A read of a target that changed meanwhile is dropped, and one that failed keeps the lists of the last good one (`adoptHere`).
async function loadHere(force = false) {
  const target = view?.target ?? null;
  if ((hereLoading && !force) || target === null || !streaming()) return;
  const seq = ++hereSeq;
  hereLoading = true;
  hereTry = Date.now();
  const read = await readDestination(null, false);
  if (seq !== hereSeq) return;
  hereLoading = false;
  hereTry = Date.now();
  if (view?.target !== target || !streaming()) return;
  adoptHere(read);
  settle();
  draw();
}

// Reads the list again after an operation in `place` (a start, a close): `orca_overview` reads both places, and a streamed target says its own change by itself, so only this machine's is read then.
function reread(place: string | null) {
  if (!streaming()) load(clockScope(), true);
  else if (place === null) void loadHere(true);
}

// Reads again, without a word, the files and the differences that the panes show now (the clock, and a branch of the worktree that changed).
function rereadTabs() {
  refreshEditors();
  refreshDiffs();
}

// The clock's read of the files (A-18, A-24, A-27): what the file pane shows (the tree, or the history) and the tabs of files and differences that the panes show. Each skips what is still being read.
function rereadFiles() {
  refreshFiles(true);
  rereadTabs();
}

function refresh() {
  // The terminals are shown only while the screen is shown.
  if (!shown()) syncTerminal();
  syncPeek();
  // The files are read again every period while the screen, the window and the file pane are shown, whatever the list does (streamed or being read).
  if (!shown() || document.hidden || !filesShown()) filesAt = Date.now();
  else if (Date.now() - filesAt >= shownMs()) {
    filesAt = Date.now();
    rereadFiles();
  }
  // The wait for a new tab ends after its 30 seconds, also while a streamed list is not read by the clock.
  if (startWaits() && Date.now() > started!.until) {
    started = null;
    draw();
  }
  // A streamed list is not read by the clock, but this machine's beside it is, every period while the screen is shown (A-33).
  if (streaming() && listShown() && !document.hidden && Date.now() - hereTry >= shownMs()) void loadHere();
  if (document.hidden || loading || streaming()) return;
  // A missing command is not looked for again by the clock.
  if (view?.state === "missing") return;
  if (Date.now() - lastTry >= (listShown() ? shownMs() : HIDDEN_MS)) load(clockScope());
}

// ---- the side pane's share (A-9) ----

// The last read, for a side pane to draw at once while it reads again.
export const heldOrca = () => view;

// Whether the stream of the list is that of the saved environment `environment`: only then can a pane of A-9 stream the terminal of a session on it (A-12).
export const streamsEnvironment = (environment: string) => streaming() && view?.target === environment;

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
    return { state: "failed", message: String(e), target: environment, environments: [], rows: [], worktrees: [], projects: [], terminals: [], known: false };
  }
}

// Selects the session of the pane `paneKey` on the Orca screen and shows the screen ("Orca の画面で開く"). A session the list does not hold yet leaves the project and the tab as they are, and the work pane is shown all the same: no formation stays selected.
export function openInOrca(paneKey: string | null) {
  deselectFormation();
  const row = paneKey === null ? null : (mix.rows.find((r) => r.paneKey === paneKey) ?? null);
  if (row) {
    setProject(row.projectKey);
    chooseTab(claudeTabId(row.paneKey!));
  }
  setScreen("orca");
}

// The Orca screen is shown: what was read stays on screen while a new read is on its way.
export function showOrca() {
  show("orca");
  noticeKey = feedKey = "";
  draw();
  // The environments are read when the screen is shown, whatever read is on its way.
  load("full", true);
}

// The dialog of the worktrees, narrowed by a filter on `{repo} ・ {branch}`, under the plus of the work pane and under the chip of the side pane of A-9. A pick closes it.
export function openWorktreeDialog(anchor: Element, worktrees: OrcaWorktree[], chosen: string | null, pick: (worktree: OrcaWorktree) => void) {
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
              pick(w);
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
  if (key !== null) {
    opened.add(key);
    // A project or a session is selected: no formation is.
    deselectFormation();
  }
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

// The arrow of a session: opens or closes its breakdown, and only that.
function toggleWorks(id: string) {
  if (!worksOpen.delete(id)) worksOpen.add(id);
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
  const [target, place] = [view.target, projectPlace(key)];
  const tabs = (): PaneTabs | null => {
    if (view === null || view.target !== target || view.state === "missing") return null;
    const now = tabsOf(key);
    return { ids: now.map((t) => t.id), handles: Object.fromEntries(now.flatMap((t) => (t.handle === null ? [] : [[t.id, t.handle]]))) };
  };
  syncPanes(place, key, tabs, op, () => draw(), (e) => showFailure("orca", e));
}

// Asks for the layout when the project's tabs are not the ones it was asked for with (the first time, and each time a tab came or went); only a read that worked says what the tabs are.
function syncLayout(tabs: Tab[]) {
  if (projectKey === null || view === null || view.state !== "ready") return;
  if (needsSync(projectPlace(projectKey), projectKey, tabs.map((t) => t.id))) runPaneOp(null);
}

// Selects the tab in its pane and gives the pane the focus, at once and then in Rust (nothing is asked when it is the selected tab already).
function chooseTab(id: string) {
  if (projectKey === null || view === null || selectedTab() === id) return;
  const op: PaneOp = { kind: "select", tab: id };
  applyLocal(projectPlace(projectKey), projectKey, op);
  runPaneOp(op);
}

// The pane was pressed: it takes the focus.
function focusPane(pane: string) {
  const layout = currentLayout();
  if (projectKey === null || view === null || layout === null || layout.focus === pane || !panesOf(layout.root).some((p) => p.id === pane)) return;
  const op: PaneOp = { kind: "focus", pane };
  applyLocal(projectPlace(projectKey), projectKey, op);
  runPaneOp(op);
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

// Closes a tab. An Orca terminal is closed in Orca, and the list is read at once: it leaves the tabs then, and a failure keeps the tab, shows the message and reads the list again.
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
  if (tab.kind === "diff" || tab.kind === "definition" || tab.kind === "database") {
    (tab.kind === "diff" ? closeDiff : tab.kind === "definition" ? closeDefinition : closeDatabaseTab)(tab.id);
    closing.delete(tab.id);
    draw();
    return;
  }
  try {
    await invoke("orca_close", { handle: tab.handle!, environment: tab.environment });
  } catch (e) {
    showFailure("orca", e);
    closing.delete(tab.id);
    draw();
    // The terminal may be gone from Orca already: the list is read again, and the tab leaves only if the read no longer holds it.
    reread(tab.environment);
    return;
  }
  closing.delete(tab.id);
  draw();
  // A streamed list says the close by itself.
  reread(tab.environment);
}

// The menu of a tab (the right button): it splits its pane, which takes the tab to a new pane at its right or below it (a pane with one tab cannot be split, so it has no split); and on a file of a worktree it copies the file's path and its path from the worktree, as the menu of the file pane does (A-18), after a line when the split is there. A tab with neither has no menu.
function openTabMenu(anchor: Element, tab: string, pane: string) {
  const item = (label: string, icon: string, pick: () => unknown): MenuItem => ({ label, color: "var(--accent)", icon, current: false, pick });
  const split = (panesOf(currentLayout()?.root ?? null).find((p) => p.id === pane)?.tabs.length ?? 0) >= 2;
  const file = projectKey === null ? undefined : filesOf(projectPlace(projectKey), projectKey).find((f) => f.id === tab);
  const items: MenuItem[] = split ? [item("右に分割", COLUMNS_SVG, () => runPaneOp({ kind: "move", tab, pane, edge: "right" })), item("下に分割", ROWS_SVG, () => runPaneOp({ kind: "move", tab, pane, edge: "bottom" }))] : [];
  if (file !== undefined && !file.outside) {
    const [path, from] = [`${file.path.replace(/\/+$/, "")}/${file.relative}`, file.relative];
    items.push({ ...item("パスのコピー", COPY_PATH_SVG, () => void copyText(path, "パスをコピーしました")), divider: split }, item("相対パスをコピー", COPY_PATH_SVG, () => void copyText(from, "相対パスをコピーしました")));
  }
  if (items.length > 0) openMenu(anchor, items);
}

// The plus (A-16, A-29): a menu of "Claude を起動", "ターミナルを開く" and "スクラッチパッド". The first two start in a worktree of the project selected in the list pane, and the scratchpad is a file of that worktree.
function openStartMenu(anchor: Element) {
  if (view === null || projectKey === null) return;
  const item = (label: string, icon: string, pick: () => void) => ({ label, color: "var(--accent)", icon, current: false, pick });
  openMenu(anchor, [
    item("Claude を起動", CLAUDE_SVG.replace("<svg ", '<svg class="orca-start-claude" '), () => void chooseWorktree(anchor, (w) => start("claude", w))),
    item("ターミナルを開く", TERMINAL_SVG, () => void chooseWorktree(anchor, (w) => start("terminal", w))),
    item("スクラッチパッド", SCRATCHPAD_SVG, () => void chooseWorktree(anchor, (w) => askScratchpad(anchor, w.path, placeOf(w)))),
  ]);
}

// A project with one worktree acts in it at once; with none or more than one, the dialog of the worktrees narrowed to the project's asks (a project with none says so there). The worktrees of the formations' children are not among them (A-16, A-37); the list of the formations is waited for only when it was never read, and is read again behind the choice when it is not recent.
async function chooseWorktree(anchor: Element, act: (worktree: OrcaWorktree) => void) {
  if (view === null || projectKey === null) return;
  const from = projectKey;
  await readForChoice();
  if (view === null || projectKey !== from) return;
  const mine = mix.worktrees.filter((w) => w.projectKey === projectKey && !inChildWorktree(w));
  if (mine.length === 1) act(mine[0]);
  else openWorktreeDialog(anchor, mine, null, act);
}

// Asks for the name of the scratchpad file in the worktree at `path` (A-29). The file opens in the project that was selected when it was asked for; a selection made meanwhile leaves it made and not opened.
function askScratchpad(anchor: Element, path: string, environment: string | null) {
  if (view === null || projectKey === null) return;
  const from = projectKey;
  openScratchpad(anchor, { path, environment }, (file) => {
    if (projectKey !== from || projectPlace(from) !== environment) return;
    started = null;
    const id = openEditorFile(environment, from, path, file);
    chooseTab(id);
    draw();
    rereadScratchpad(environment, path);
  });
}

// Starts Claude (with no first prompt: the user types it in the terminal) or a plain terminal in the worktree, once; a failure shows its message. The project and its tab stay selected, and the new tab is followed: once the list holds it, it is selected.
async function start(kind: StartKind, worktree: OrcaWorktree) {
  if (busy || startWaits() || view === null) return;
  const { path } = worktree;
  const target = placeOf(worktree);
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
    reread(target);
  } catch (e) {
    showFailure("orca", e);
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

// The button that opens the list again while a formation is shown (A-23, A-37): the tab strip of the work pane, which has it otherwise, is hidden then, so the head of the leader's pane has the same button, only while the list is closed.
function drawFormationToggle() {
  const button = $("formation-list-toggle");
  button.hidden = listOpen;
  drawListToggle(button, listOpen);
}

// Closes the list of projects with its divider, or opens it again (A-23). The divider's ratio is kept, so the list opens at the width it had.
// The pressed button is hidden by it, so the focus goes on to the button that is shown now.
function toggleList() {
  const focused = document.activeElement?.classList.contains("list-toggle") ?? false;
  listOpen = !listOpen;
  $("orca-list").hidden = !listOpen;
  $("orca-split").hidden = !listOpen;
  drawListToggle($("orca-list-toggle"), listOpen);
  drawFormationToggle();
  draw();
  if (focused) {
    const shown = [...document.querySelectorAll<HTMLElement>(".list-toggle")].find((b) => b.offsetParent !== null);
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

// Ends the search: the list is the whole list again (the field stays as it is).
function clearSearch() {
  query = "";
  cursor = null;
  searchInput().value = "";
  drawSearchList();
}

// Opens the field in place of the heading's row, and gives it the focus with its text selected.
function openSearch() {
  searchOpen = true;
  drawSearch();
  searchInput().focus();
  searchInput().select();
}

// Clears the text and shows the heading's row again.
function closeSearch() {
  searchOpen = false;
  clearSearch();
}

// ⌘J: the list opens if it is closed, and the field opens and takes the focus.
function focusSearch() {
  if (!listOpen) toggleList();
  draw();
  openSearch();
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
      closeSearch();
      input.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveCursor(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      const key = cursorKey();
      if (key !== null) selectProject(key);
    }
  };
  // The focus left the field with no text in it: the heading's row comes back. A window that lost the focus keeps the field as the active element, and keeps it open.
  input.onblur = () =>
    setTimeout(() => {
      if (searchOpen && input.value === "" && document.activeElement !== input) closeSearch();
    }, 0);
  $("orca-search-open").onclick = openSearch;
  $("orca-search-clear").onclick = () => {
    clearSearch();
    input.focus();
  };
  // Capture phase, so that a terminal or the editor with the focus does not take the key first.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!listShown() || e.key !== "j" || !(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey || composing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      focusSearch();
    },
    true,
  );
}

export function initOrca() {
  initOrcaTerminal((e) => showFailure("orca", e));
  initPeek(statusIcon, selectSession);
  initSplit($("orca"), $("orca-split"), { side: "left", min: 0.15, max: 0.5, initial: 0.19, property: "--list-w" });
  initSplit($("orca"), $("orca-files-split"), { side: "right", min: 0.15, max: 0.4, initial: 0.22, property: "--files-w" });
  initOrcaEditor({ changed: draw, error: (e) => showFailure("orca", e), definition: askDefinition, serve: (target, project, path, server) => void ensureServer({ target, project, path }, server), mayAsk });
  initLsp({ changed: ({ target, project }) => resolveServers(target, project) });
  initDefinition({ open: openPlace });
  initOrcaDatabase({ table: openDatabaseTable, query: openDatabaseQuery, gone: (id) => {
      if (closeConnectionTabs(id)) draw();
    } });
  initOrcaFiles({ open: (relative) => openFile(relative), diff: (relative) => openDiff(relative), commitDiff: openDiff, toggle: toggleFilesAndDraw,
    // A-25: after the app's own switch the tabs shown are read again with the tree, and the list (a streamed one is read again by Rust, which the switch told).
    // A git worktree that Orca's list lacks is on the branch the switch made, which the list cannot say.
    switched: (here, branch) => {
      const git = gitWorktrees.get(gitKey(here.target, here.path));
      if (git !== undefined) git.gitBranch = branch;
      rereadTabs();
      void refreshOrca(true);
    },
    // A-25: a worktree picked in the list of branches is shown in the file pane, for as long as the tab selected now stays selected. One that Orca's list lacks is named after the project and its folder.
    picked: (here, worktree) => {
      if (projectKey === null) return;
      const listed = mix.worktrees.find((w) => w.path === worktree.path && placeOf(w) === here.target);
      const name = mix.projects.find((p) => p.key === projectKey)?.name ?? "";
      const label = listed !== undefined ? worktreeLabel(listed) : worktreeLabel({ repo: name, branch: worktree.name });
      if (listed === undefined) gitWorktrees.set(gitKey(here.target, worktree.path), { project: here.project, target: here.target, path: worktree.path, label, gitBranch: worktree.gitBranch });
      pickedWorktree = { project: projectKey, tab: selectedTab() ?? "", target: here.target, path: worktree.path, label };
      draw();
    },
    // A-25: a git worktree that the answer of the list of branches does not hold any more is forgotten.
    read: (here, read) => {
      for (const [key, git] of gitWorktrees) {
        if (git.project === here.project && git.target === here.target && !read.some((w) => w.path === git.path)) gitWorktrees.delete(key);
      }
    },
    moved: rereadTabs,
    // One draw for the whole delete, not one for each entry whose tabs closed.
    deleted: (here, deleted) => {
      let closed = false;
      for (const { relative, folder } of deleted) closed = discardFiles(here.target, here.project, here.path, relative, folder) || closed;
      if (closed) draw();
    },
    // A-18: the tabs of the files that a move takes along wait with their saves, and take the new path (and the new name of the tab) when it is done.
    moving: async (here, relative) => {
      const release = await holdFiles(here.target, here.project, here.path, relative);
      return (to) => {
        if (release(to)) draw();
      };
    },
  });
  setInterval(refresh, (1000 * shownMs()) / SHOWN_MS);
  document.addEventListener("visibilitychange", () => {
    // A session shown again after the window was hidden is seen.
    drawBadge();
    refresh();
  });
  // The files and the history of the file pane are read again when the app is activated (A-18, A-27), and by the clock (`refresh`), as nothing watches the disk.
  window.addEventListener("focus", () => shown() && refreshFiles());
  initSearch();
  const toggle = listToggle("プロジェクト一覧", toggleList);
  toggle.id = "orca-list-toggle";
  drawListToggle(toggle, listOpen);
  $("orca-header").prepend(toggle);
  const inFormation = listToggle("プロジェクト一覧", toggleList);
  inFormation.id = "formation-list-toggle";
  $("formation-head").prepend(inFormation);
  drawFormationToggle();
  const add = $("orca-add");
  // The places are this Mac and the target when it is a saved environment: those are the lists the screen reads again after the add (A-33).
  add.onclick = () => openAddProject(add, view !== null && view.target !== null && view.environments.includes(view.target) ? [view.target] : [], () => void load("full", true));
  initPaneTree($("orca-panes"), {
    plus: (anchor, pane) => {
      focusPane(pane);
      openStartMenu(anchor);
    },
    files: toggleFilesAndDraw,
    list: toggleList,
    focus: focusPane,
    move: (tab, pane, edge) => runPaneOp({ kind: "move", tab, pane, edge }),
    resize: (before, after, share) => {
      const op: PaneOp = { kind: "resize", before, after, share };
      if (projectKey !== null && view !== null) applyLocal(projectPlace(projectKey), projectKey, op);
      runPaneOp(op);
    },
    menu: openTabMenu,
  });
  load("full");
}
