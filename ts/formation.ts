// The orchestration of the development screen (A-37): a formation selected in the list (formation-list.ts, under its heading at the top of the Orca screen's list) takes the place of the work pane of a project with two panes, the tabs in the middle (the leader's terminal and the children's, formation-flow.ts) and the flow at the right, a column of cards. While a project or a session is selected, or nothing, the work pane of Orca is shown.
// A formation belongs to one PC. The orchestrator of one of this Mac runs in a pseudo terminal of the app (A-36); the one of a formation of a saved environment runs in a terminal of the Orca of that environment, which Rust makes (`formation_orchestrator`) and which is shown here as a child's terminal is: streamed when the Orca screen streams that environment, else mirrored.
import type { FormationOrchestrator } from "./bindings/FormationOrchestrator";
import { claudeCodeStarted, closeClaudeCode, formationPaneId, hideClaudeCode, isClaudeCodeShowing, showClaudeCode } from "./claude-code.js";
import { $ } from "./dom.js";
import { ensureConsent } from "./formation-consent.js";
import { hideSession, isLeaderTab, onTabChange, showChild, startFlow, startList, stopFlow, switchFormation } from "./formation-flow.js";
import { currentFormation, formationEnvironment, initFormationList } from "./formation-list.js";
import { RELOAD_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { redrawOrca, streamsEnvironment } from "./orca.js";
import { isShowing, releaseTerminal, showTerminals } from "./orca-terminal.js";

// The name of the pane's owner: what `hideClaudeCode` is told when the formation is deselected or the screen is left.
const OWNER = "formation-screen";
// The pane of the orchestrator of the formation the screen shows; null while none is selected.
const pane = () => {
  const name = currentFormation();
  return name === null ? null : formationPaneId(name);
};

// The environment of this Mac in `FormationEntry.environment`.
const LOCAL = "local";
// The orchestrators of the formations of a saved environment, by the name of the formation: the terminal once Rust has made it (in memory only; Rust finds the recorded one again), the starts on their way, and the words of the ones that failed.
const terminals = new Map<string, FormationOrchestrator>();
const starting = new Set<string>();
// The formations of a saved environment whose orchestrator's terminal has ended (it left its Orca's list: Claude Code ended and the terminal went with it). The last screen stays drawn; the handle is dropped at the next show of the formation, which asks Rust again (it makes a new terminal when none is listed).
const ended = new Set<string>();
// The panes of the orchestrators of this Mac whose restart is on its way.
const restarting = new Set<string>();
const failures = new Map<string, string>();

// Whether the development screen is shown (set by `showFormation` and `hideFormation`).
let onScreen = false;

// Shows the terminal of the orchestrator of the formation that is shown, and hides the one of another (its process goes on). The process starts with the first show of a formation, and a show of a running one starts nothing (A-36).
// Nothing is shown while the screen is left: a selection or a deletion that ends then (it was on its way when the owner left) must not take the hidden pane.
// While no formation is selected the middle pane is not shown, and no orchestrator is started.
function showPane() {
  if (!onScreen) return;
  const id = pane();
  if (id === null) return hideClaudeCode(OWNER);
  const name = currentFormation()!;
  const host = $("formation-term");
  const remote = formationEnvironment(name) !== LOCAL;
  const said = remote ? (failures.get(name) ?? null) : null;
  // The leader's terminal and its words are shown only while the leader's tab is the selected one; a child's tab shows the child's terminal under the strip (formation-flow.ts), and the leader's process goes on.
  const leader = isLeaderTab();
  host.hidden = !leader;
  $("formation-term-error").hidden = said === null || !leader;
  $("formation-term-error").textContent = said ?? "";
  syncRestart();
  if (!leader) return hideClaudeCode(OWNER);
  if (remote) return showRemote(name, host, said);
  if (!isClaudeCodeShowing(host, id, OWNER)) showClaudeCode(host, { id, kind: "formation" }, OWNER);
}

// The restart button is off while the orchestrator of the shown formation is starting, because a restart pressed then would be dropped or would end the process of the one before it (one start at a time for a formation, and a first start can take long). It is set from the shown formation each time, so that the state of another formation does not stay on it.
function syncRestart() {
  const name = currentFormation();
  if (name === null) return;
  // It is off while a child's tab is the selected one too: it restarts the leader, whose terminal is not in view then.
  $<HTMLButtonElement>("formation-restart").disabled =
    !isLeaderTab() || (formationEnvironment(name) === LOCAL ? restarting.has(formationPaneId(name)) : starting.has(name));
}

// Shows the terminal of the orchestrator of a formation of a saved environment, and starts it when it has none and no failure is on the screen (a failure is tried again by the restart button, or by pressing the formation again).
function showRemote(name: string, host: HTMLElement, failure: string | null) {
  if (ended.delete(name)) dropRemote(name);
  const got = terminals.get(name);
  if (!got) {
    hideClaudeCode(OWNER);
    if (failure === null) void startRemote(name, false);
    return;
  }
  host.classList.add("claude-code-pane");
  const kind = streamsEnvironment(got.environment) ? "stream" : "mirror";
  const placement = { id: got.handle, source: { kind, handle: got.handle, path: "", environment: got.environment, onGone: () => gone(name, got.handle) } as const, host };
  if (!isShowing(placement, OWNER)) showTerminals([placement], got.handle, OWNER);
}

// The screen forgets the terminal of the orchestrator of `name`.
function dropRemote(name: string) {
  const got = terminals.get(name);
  if (got) releaseTerminal(got.handle, OWNER);
  terminals.delete(name);
}

// The terminal `handle` of `name` left the list of its Orca. The terminal stays as it was drawn; the next show of the formation drops it and asks Rust for the leader again. A terminal that this screen no longer holds for `name` (the restart made another) is not the leader's end.
function gone(name: string, handle: string) {
  if (terminals.get(name)?.handle === handle) ended.add(name);
}

// Asks Rust for the terminal of the orchestrator of `name` (one start at a time for a formation), and shows it when that formation is still the one shown. `restart` ends the one it has.
async function startRemote(name: string, restart: boolean) {
  if (starting.has(name)) return;
  starting.add(name);
  failures.delete(name);
  if (currentFormation() === name) syncRestart();
  try {
    // A formation made before the owner's consent for its PC (#893) asks for it first. When the owner declines nothing is started, and nothing is shown: pressing the formation again asks again.
    if (!(await ensureConsent($("formation-head"), formationEnvironment(name)))) {
      starting.delete(name);
      if (currentFormation() === name) syncRestart();
      return;
    }
    terminals.set(name, await invoke("formation_orchestrator", { name, restart }));
  } catch (e) {
    failures.set(name, String(e));
  } finally {
    starting.delete(name);
  }
  if (currentFormation() === name) showPane();
}

// The panes of the formation take the place of the work pane of Orca while a formation is selected, and the other way round. The list is read while the screen is shown, and the children of the selected formation with it.
function syncPanes() {
  if (!onScreen) return;
  const formation = currentFormation() !== null;
  $("formation").hidden = !formation;
  $("orca-session").hidden = formation;
  if (formation) startFlow();
  else {
    startList();
    hidePanes();
  }
  showPane();
}

// The development screen is shown.
export function showFormation() {
  onScreen = true;
  syncPanes();
}

// The restart button of the header: ends the process of the orchestrator of the formation that is shown, if it is running (or has ended), and begins a new one with the keyboard, as a first show does (A-37). The other formations' orchestrators and the children are not touched.
// The button is off until the new start has answered, because two starts of the pane's id at once could end each other's process.
export function initFormation() {
  // The tab changes between the leader's and a child's: the leader's terminal is hidden or shown.
  onTabChange(showPane);
  // Another formation is selected in the list, or none (a project or a session is): the panes of the selection are shown, its flow is read in place of the last one's, and its orchestrator is shown in the middle.
  initFormationList(
    (name) => {
      // A formation that is pressed again tries again after a failure.
      if (name !== null) failures.delete(name);
      switchFormation();
      syncPanes();
      redrawOrca();
    },
    // A formation was deleted: Rust has ended its orchestrator's process, so its terminal is dropped. The release hides the shown terminal of this owner too, so the shown formation's is shown again.
    (name) => {
      closeClaudeCode(formationPaneId(name), OWNER);
      dropRemote(name);
      ended.delete(name);
      failures.delete(name);
      showPane();
    },
    // The row of a child in the list was pressed, after its formation was selected: the child's tab is shown.
    showChild,
  );
  $("formation-restart").innerHTML = RELOAD_SVG;
  const button = $<HTMLButtonElement>("formation-restart");
  button.onclick = () => {
    const id = pane();
    if (id === null) return;
    const name = currentFormation()!;
    if (formationEnvironment(name) !== LOCAL) {
      dropRemote(name);
      ended.delete(name);
      void startRemote(name, true);
      return;
    }
    restarting.add(id);
    syncRestart();
    closeClaudeCode(id, OWNER);
    showClaudeCode($("formation-term"), { id, kind: "formation" }, OWNER);
    void claudeCodeStarted(id).then(() => {
      restarting.delete(id);
      syncRestart();
    });
  };
}

// The screen is left: the terminals are hidden (the orchestrator's process goes on, the children's mirrors stop), and nothing is read.
export function hideFormation() {
  onScreen = false;
  stopFlow();
  hidePanes();
}

// Only the terminals are hidden.
function hidePanes() {
  hideSession();
  hideClaudeCode(OWNER);
}
