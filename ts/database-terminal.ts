// The terminal pane of the database screen (D-7): a pane at the right of the work pane that the icon at the right end of the work pane's header opens and closes, and a divider between them that is dragged.
// Whether it is open is the `aria-pressed` of the icon, and its width is the divider's (ts/split.ts); both are kept in memory only.
// Its head is a strip of tabs with a plus. The plus asks Orca for its worktrees, lets the user pick one (the dialog of A-16) and opens a plain terminal there (`orca_terminal_create`); the terminal is drawn by ts/orca-terminal.ts (A-8, A-12), with this pane as its owner.
// The pane holds one terminal: the one the plus opened last (the tabs come with a later requirement text of D-7).
// While a terminal is held, a tick (every second) shows it when the pane is in view and lets it go (`hideTerminals`: its stream or its reads end) when the pane is closed, the screen is left or the window is hidden. It also reads Orca's list, as long as the pane is in view, to see that the terminal is still there: first until the list holds it, then at the period of the Orca clock; a terminal the list lacks is forgotten.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaWorktree } from "./bindings/OrcaWorktree";
import { $, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { PLUS_SVG, TERMINAL_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { heldOrca, noticeOf, openWorktreeDialog, readDestination, refreshOrca, streamsEnvironment, worktreeLabel } from "./orca.js";
import { hideTerminals, isShowing, type Placement, releaseTerminal, showTerminals } from "./orca-terminal.js";
import { initSplit } from "./split.js";

// The owner of the terminal in `ts/orca-terminal.ts`.
const OWNER = "database-terminal";
const TICK_MS = 1000;
const LIST_MS = 10_000;
// How long the list may take to hold a terminal that Orca has just opened.
const WAIT_MS = 30_000;

// The terminal the pane holds: where it is (`environment`: null for this machine), the worktree's path, the title of its tab, when it was opened, whether the list has held it, and when the list was last read for it.
interface Held {
  handle: string;
  environment: string | null;
  path: string;
  title: string;
  since: number;
  listed: boolean;
  readAt: number;
}

let held: Held | null = null;
// The element the terminal is drawn in, and the notice above it (Orca's missing, a read or an open that failed).
let host: HTMLElement | null = null;
let notice: HTMLElement | null = null;
let timer: number | null = null;
// The press of the plus is on its way (the list is read, or the terminal is opened).
let busy = false;
let checking = false;

const body = () => $("database-terminal-body");
const plus = () => $("database-terminal-plus") as HTMLButtonElement;

function say(text: string | null) {
  notice?.remove();
  notice = null;
  if (text === null) return;
  notice = tag("div", "pending fail");
  notice.append(tag("span", "sp", text));
  body().prepend(notice);
}

function draw() {
  plus().disabled = busy;
  const tab = tag("button", "database-terminal-tab");
  tab.type = "button";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "true");
  tab.append(tag("span", "database-terminal-tab-title", held?.title ?? ""));
  $("database-terminal-tabs").replaceChildren(...(held ? [tab] : []));
}

function stopWatch() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

function startWatch() {
  if (timer === null) timer = window.setInterval(() => void tick(), periodMs("orcaMirror", TICK_MS));
}

// Forgets the terminal (the terminal itself stays in Orca): its stream or reads end, and its box and its tab go.
function forget() {
  stopWatch();
  if (held) releaseTerminal(held.handle, OWNER);
  held = null;
  host?.remove();
  host = null;
}

// The list of Orca that holds the terminals of `environment`: the screen's own while it is the target, else a read of that Orca alone (as the pane of A-9 does).
const listOf = (environment: string | null): Promise<OrcaOverview | null> => (heldOrca()?.target === environment ? refreshOrca(false) : readDestination(environment, false));

// Reads the list for `terminal`: it is listed once the list holds it; it is forgotten when a ready list that held it no longer does, or when the list has not held it in WAIT_MS.
async function check(terminal: Held) {
  if (checking) return;
  checking = true;
  try {
    const list = await listOf(terminal.environment);
    if (held !== terminal) return;
    terminal.readAt = Date.now();
    if (list?.state !== "ready") return;
    if (list.terminals.some((t) => t.handle === terminal.handle) || list.rows.some((r) => r.handle === terminal.handle)) terminal.listed = true;
    else if (terminal.listed) forget();
    else if (Date.now() - terminal.since > WAIT_MS) {
      forget();
      say("ターミナルが Orca の一覧に現れませんでした");
    }
  } finally {
    checking = false;
    draw();
  }
}

async function tick() {
  const terminal = held;
  if (terminal === null) return stopWatch();
  // A pane that is not in view (closed, another screen, a hidden window) reads and streams nothing.
  if (document.hidden || body().getClientRects().length === 0) return hideTerminals(OWNER);
  if (!terminal.listed || Date.now() - terminal.readAt >= periodMs("orcaClock", LIST_MS)) await check(terminal);
  if (held !== terminal || !terminal.listed || host === null) return;
  const placement: Placement = {
    id: terminal.handle,
    source: { kind: terminal.environment !== null && streamsEnvironment(terminal.environment) ? "stream" : "mirror", handle: terminal.handle, path: terminal.path, environment: terminal.environment },
    host,
  };
  if (!isShowing(placement, OWNER)) showTerminals([placement], terminal.handle, OWNER);
}

// Opens a plain terminal in `worktree`, in place of the one the pane holds.
async function open(worktree: OrcaWorktree) {
  if (busy) return;
  busy = true;
  say(null);
  draw();
  try {
    const environment = worktree.environment ?? null;
    const launched = await invoke("orca_terminal_create", { path: worktree.path, environment });
    if (launched.handle === null) return say("Orca がターミナルの名前を返しませんでした");
    forget();
    held = { handle: launched.handle, environment, path: worktree.path, title: worktreeLabel(worktree), since: Date.now(), listed: false, readAt: 0 };
    host = tag("div", "database-terminal-term");
    body().append(host);
    startWatch();
    void tick();
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

export function initDatabaseTerminal() {
  const toggle = $("database-terminal-toggle");
  toggle.innerHTML = TERMINAL_SVG;
  toggle.onclick = () => {
    const open = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(open));
    $("database-terminal").hidden = !open;
    $("database-terminal-split").hidden = !open;
    if (!open) {
      stopWatch();
      hideTerminals(OWNER);
    } else if (held) {
      startWatch();
      void tick();
    }
  };
  plus().innerHTML = PLUS_SVG;
  plus().onclick = () => void press();
  initSplit($("database"), $("database-terminal-split"), { min: 0.25, max: 0.5, initial: 0.35, property: "--terminal-w" });
}
