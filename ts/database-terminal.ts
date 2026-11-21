// The terminal pane of the database screen (D-7): a pane at the right of the work pane that the icon at the right end of the work pane's header opens and closes, and a divider between them that is dragged.
// Whether it is open is the `aria-pressed` of the icon, and its width is the divider's (ts/split.ts); both are kept in memory only.
// Its head is a strip of tabs with a plus. The first tab is the fixed "Claude" tab (A-36): opening the pane starts Claude Code in it when none runs (the built-in tools on, as the database screen runs `aws`), and it goes when the process ends by itself with the exit code 0 or its close button is pressed (an end with an exit code or a signal keeps it, with the message in its box); closing the pane, leaving the screen and closing the edit pane do not end it. The plus asks Orca for its worktrees, lets the user pick one (the dialog of A-16) and opens a plain terminal there (`orca_terminal_create`); the terminal is drawn by ts/orca-terminal.ts (A-8, A-12), with this pane as its owner.
// Each terminal the plus opened has a tab, in the order they were opened, and the newest is selected. A tab is pressed to show its terminal, and its close button (the one of the tabs of the Orca screen) closes the terminal in Orca (`orca_close`).
// Only the selected terminal is shown: a tick (every second) shows it when the pane is in view, and lets the others go (`hideTerminals`: their streams or reads end), as it lets all of them go when the pane is closed, the screen is left or the window is hidden. It also reads Orca's list, as long as the pane is in view, to see that each terminal is still there: first until the list holds it, then at the period of the Orca clock; a terminal the list lacks is forgotten, with its tab.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaWorktree } from "./bindings/OrcaWorktree";
import { closeClaudeCode, hideClaudeCode, isClaudeCodeShowing, showClaudeCode } from "./claude-code.js";
import { $, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { CLOSE_SVG, PLUS_SVG, TERMINAL_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { heldOrca, noticeOf, openWorktreeDialog, readDestination, refreshOrca, streamsEnvironment, worktreeLabel } from "./orca.js";
import { hideTerminals, isShowing, type Placement, releaseTerminal, showTerminals } from "./orca-terminal.js";
import { initSplit } from "./split.js";

// The owner of the terminal in `ts/orca-terminal.ts`.
const OWNER = "database-terminal";
// The id of the Claude Code pane (Rust names the process by it), its owner in `ts/orca-terminal.ts`, and the key that `selected` holds while its tab is the selected one.
const CLAUDE_ID = "database-claude";
const CLAUDE_OWNER = "database-claude";
const TICK_MS = 1000;
const LIST_MS = 10_000;
// How long the list may take to hold a terminal that Orca has just opened.
const WAIT_MS = 30_000;

// A terminal the pane holds: where it is (`environment`: null for this machine), the worktree's path, the title of its tab, when it was opened, whether the list has held it, and when the list was last read for it.
interface Held {
  handle: string;
  environment: string | null;
  path: string;
  title: string;
  since: number;
  listed: boolean;
  readAt: number;
}

// The terminals in the order they were opened, and the handle of the one the pane shows.
const terminals: Held[] = [];
// The handle of the terminal the pane shows, or CLAUDE_ID while the Claude tab is the selected one.
let selected: string | null = null;
// Whether the Claude tab is there (its process runs, or its start failed and the message is drawn), and the element its terminal is drawn in.
let claude = false;
let claudeHost: HTMLElement | null = null;
// The handles whose close is on its way.
const closing = new Set<string>();
// The element the selected terminal is drawn in (there while a terminal is held), and the notice above it (Orca's missing, a read, an open or a close that failed).
let host: HTMLElement | null = null;
let notice: HTMLElement | null = null;
let timer: number | null = null;
// The press of the plus is on its way (the list is read, or the terminal is opened).
let busy = false;
let checking = false;
// What the strip of tabs was drawn from, so that a tick that changes nothing does not draw it again under the pointer.
let drawn = "";

const body = () => $("database-terminal-body");
const plus = () => $("database-terminal-plus") as HTMLButtonElement;
const selectedTerminal = () => terminals.find((t) => t.handle === selected) ?? null;

function say(text: string | null) {
  notice?.remove();
  notice = null;
  if (text === null) return;
  notice = tag("div", "pending fail");
  notice.append(tag("span", "sp", text));
  body().prepend(notice);
}

// A tab, as the tabs of the Orca screen are: the close button is beside the tab, not in it, so that pressing it never selects the tab.
function makeTab(title: string, key: string, onSelect: () => void, onClose: () => void, closeOff: boolean) {
  const wrap = tag("div", "database-terminal-tab");
  wrap.setAttribute("role", "presentation");
  const select = tag("button", "database-terminal-tab-btn");
  select.type = "button";
  select.setAttribute("role", "tab");
  select.setAttribute("aria-selected", String(key === selected));
  select.append(tag("span", "database-terminal-tab-title", title));
  select.onclick = onSelect;
  const close = tag("button", "icon-btn database-terminal-tab-close");
  close.type = "button";
  close.setAttribute("aria-label", "閉じる");
  close.innerHTML = CLOSE_SVG;
  close.disabled = closeOff;
  close.onclick = onClose;
  wrap.append(select, close);
  return { wrap, select };
}

const tabOf = (terminal: Held) => makeTab(terminal.title, terminal.handle, () => choose(terminal.handle), () => void closeTab(terminal), closing.has(terminal.handle)).wrap;

// The fixed tab of Claude Code, the first of the strip.
function claudeTabOf() {
  const { wrap, select } = makeTab("Claude", CLAUDE_ID, () => choose(CLAUDE_ID), closeClaude, false);
  select.id = "database-claude-tab";
  return wrap;
}

function draw() {
  plus().disabled = busy;
  // Only the selected tab's terminal takes room in the body.
  if (host) host.hidden = selected === CLAUDE_ID;
  if (claudeHost) claudeHost.hidden = selected !== CLAUDE_ID;
  const key = [claude ? `claude\n${selected === CLAUDE_ID}` : "", ...terminals.map((t) => `${t.handle}\n${t.title}\n${t.handle === selected}\n${closing.has(t.handle)}`)].join("\n\n");
  if (key === drawn) return;
  drawn = key;
  $("database-terminal-tabs").replaceChildren(...(claude ? [claudeTabOf()] : []), ...terminals.map(tabOf));
}

function stopWatch() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

function startWatch() {
  if (timer === null) timer = window.setInterval(() => void tick(), periodMs("orcaMirror", TICK_MS));
}

// Shows the terminal of the tab pressed, and lets the one shown before go.
function choose(handle: string) {
  if (selected === handle) return;
  selected = handle;
  draw();
  void tick();
}

// Forgets a terminal (the terminal itself stays in Orca unless it was closed there): its stream or reads end, and its tab goes. The tab that followed it is selected, else the one before; with no terminal left the box goes and the tick stops.
function forget(handle: string) {
  const at = terminals.findIndex((t) => t.handle === handle);
  if (at < 0) return;
  terminals.splice(at, 1);
  closing.delete(handle);
  releaseTerminal(handle, OWNER);
  if (selected === handle) selected = (terminals[at] ?? terminals[at - 1])?.handle ?? (claude ? CLAUDE_ID : null);
  if (terminals.length === 0) {
    if (!claude) stopWatch();
    host?.remove();
    host = null;
  }
  draw();
  // Letting a terminal go hides the shown one with it, so the one that stays is shown again at once.
  void tick();
}

// The list of Orca that holds the terminals of `environment`: the screen's own while it is the target, else a read of that Orca alone (as the pane of A-9 does).
const listOf = (environment: string | null): Promise<OrcaOverview | null> => (heldOrca()?.target === environment ? refreshOrca(false) : readDestination(environment, false));

// Reads the lists for the terminals that are due (one read for each place): a terminal is listed once its list holds it; it is forgotten when a ready list that held it no longer does, or when the list has not held it in WAIT_MS.
async function check() {
  if (checking) return;
  const due = terminals.filter((t) => !t.listed || Date.now() - t.readAt >= periodMs("orcaClock", LIST_MS));
  if (due.length === 0) return;
  checking = true;
  try {
    for (const environment of new Set(due.map((t) => t.environment))) {
      const list = await listOf(environment);
      const now = Date.now();
      for (const terminal of terminals.filter((t) => t.environment === environment)) {
        terminal.readAt = now;
        if (list?.state !== "ready") continue;
        if (list.terminals.some((t) => t.handle === terminal.handle) || list.rows.some((r) => r.handle === terminal.handle)) terminal.listed = true;
        else if (terminal.listed) forget(terminal.handle);
        else if (now - terminal.since > WAIT_MS) {
          forget(terminal.handle);
          say("ターミナルが Orca の一覧に現れませんでした");
        }
      }
    }
  } finally {
    checking = false;
    draw();
  }
}

// Shows the terminal of Claude Code in its box; the process starts with the first show, and a show of a running one starts nothing.
function showClaude() {
  if (claudeHost === null || isClaudeCodeShowing(claudeHost, CLAUDE_ID, CLAUDE_OWNER)) return;
  showClaudeCode(claudeHost, { id: CLAUDE_ID, builtinTools: true, onEnd: closeClaude }, CLAUDE_OWNER);
}

async function tick() {
  if (terminals.length === 0 && !claude) return stopWatch();
  // A pane that is not in view (closed, another screen, a hidden window) reads and streams nothing; the process of Claude Code goes on.
  if (document.hidden || body().getClientRects().length === 0) {
    hideTerminals(OWNER);
    hideClaudeCode(CLAUDE_OWNER);
    return;
  }
  if (selected === CLAUDE_ID) {
    hideTerminals(OWNER);
    showClaude();
    return void (await check());
  }
  hideClaudeCode(CLAUDE_OWNER);
  await check();
  const terminal = selectedTerminal();
  // Only the selected terminal is shown, and only once the list holds it: the others read and stream nothing.
  if (terminal === null || !terminal.listed || host === null) return hideTerminals(OWNER);
  const placement: Placement = {
    id: terminal.handle,
    source: { kind: streamsEnvironment(terminal.environment) ? "stream" : "mirror", handle: terminal.handle, path: terminal.path, environment: terminal.environment },
    host,
  };
  if (!isShowing(placement, OWNER)) showTerminals([placement], terminal.handle, OWNER);
}

// Closes the terminal in Orca, as the close button of a tab of the Orca screen does (`orca_close`): its tab goes once Orca has closed it. A failure keeps the tab, says why, and reads the list again, so that a terminal Orca no longer holds goes at once.
async function closeTab(terminal: Held) {
  if (closing.has(terminal.handle)) return;
  closing.add(terminal.handle);
  say(null);
  draw();
  try {
    await invoke("orca_close", { handle: terminal.handle, environment: terminal.environment });
  } catch (e) {
    closing.delete(terminal.handle);
    say(String(e));
    draw();
    terminal.readAt = 0;
    void check();
    return;
  }
  forget(terminal.handle);
}

// Opens a plain terminal in `worktree`, with a tab of its own that is selected.
async function open(worktree: OrcaWorktree) {
  if (busy) return;
  busy = true;
  say(null);
  draw();
  try {
    const environment = worktree.environment ?? null;
    const launched = await invoke("orca_terminal_create", { path: worktree.path, environment });
    if (launched.handle === null) return say("Orca がターミナルの名前を返しませんでした");
    const handle = launched.handle;
    if (!terminals.some((t) => t.handle === handle)) terminals.push({ handle, environment, path: worktree.path, title: worktreeLabel(worktree), since: Date.now(), listed: false, readAt: 0 });
    selected = handle;
    if (host === null) {
      host = tag("div", "database-terminal-term");
      body().append(host);
    }
    // The pane may have been closed while the terminal was opened: it reads nothing then, and the next opening starts the tick.
    if (isDatabaseTerminalOpen()) {
      startWatch();
      void tick();
    }
  } catch (e) {
    say(String(e));
  } finally {
    busy = false;
    draw();
  }
}

// The plus: Orca's worktrees are read, and the one picked in the dialog under the plus gets the terminal.
async function press() {
  if (busy) return;
  busy = true;
  say(null);
  draw();
  try {
    const list = await refreshOrca(true);
    const text = noticeOf(list);
    if (text !== null || list === null) return say(text ?? "読み込めませんでした");
    openWorktreeDialog(plus(), list.worktrees, null, (worktree) => void open(worktree));
  } finally {
    busy = false;
    draw();
  }
}

// Whether the pane is open: the `aria-pressed` of the icon of the work pane's header.
export const isDatabaseTerminalOpen = () => $("database-terminal-toggle").getAttribute("aria-pressed") === "true";

// Puts the Claude tab first and selects it; the process starts when the tick shows it.
function startClaude() {
  claude = true;
  selected = CLAUDE_ID;
  claudeHost = tag("div");
  claudeHost.id = "database-claude-term";
  body().append(claudeHost);
  draw();
}

// Takes the Claude tab away (its process ended, or its close button was pressed): its process and what it started end. The first tab is selected; with no tab left the pane closes.
function closeClaude() {
  if (!claude) return;
  claude = false;
  closeClaudeCode(CLAUDE_ID, CLAUDE_OWNER);
  claudeHost?.remove();
  claudeHost = null;
  if (selected === CLAUDE_ID) selected = terminals[0]?.handle ?? null;
  // The strip is drawn before the pane closes, or the tab that went would stay in it.
  draw();
  if (terminals.length === 0) return setDatabaseTerminalOpen(false);
  void tick();
}

// Opens or closes the pane, and keeps the icon of the work pane's header and the icon of the edit pane (both open and close this pane) in step. Opening it starts Claude Code when no process runs; closing it ends nothing.
function setDatabaseTerminalOpen(open: boolean) {
  for (const id of ["database-terminal-toggle", "database-edit-terminal"]) document.getElementById(id)?.setAttribute("aria-pressed", String(open));
  $("database-terminal").hidden = !open;
  $("database-terminal-split").hidden = !open;
  if (!open) {
    stopWatch();
    hideTerminals(OWNER);
    hideClaudeCode(CLAUDE_OWNER);
    return;
  }
  if (!claude) startClaude();
  startWatch();
  void tick();
}

// The press of the icon of the work pane's header or of the edit pane's.
export const toggleDatabaseTerminal = () => setDatabaseTerminalOpen(!isDatabaseTerminalOpen());

export function initDatabaseTerminal() {
  const toggle = $("database-terminal-toggle");
  toggle.innerHTML = TERMINAL_SVG;
  toggle.onclick = toggleDatabaseTerminal;
  plus().innerHTML = PLUS_SVG;
  plus().onclick = () => void press();
  initSplit($("database"), $("database-terminal-split"), { min: 0.25, max: 0.5, initial: 0.35, property: "--terminal-w" });
}
