// The orchestration mode of the development screen (A-37): three panes, the list of the formations at the left (formation-list.ts), the terminal of the orchestrator of the selected formation in the middle and its flow at the right, with the session of the selected child under it (formation-flow.ts). While no formation is selected only the list is shown.
// A formation belongs to one PC. The orchestrator of one of this Mac runs in a pseudo terminal of the app (A-36); the one of a formation of a saved environment runs in a terminal of the Orca of that environment, which Rust makes (`formation_orchestrator`) and which is shown here as a child's session is: streamed when the Orca screen streams that environment, else mirrored.
// The mode is kept only while the app runs; the first one is Orca.
import type { FormationOrchestrator } from "./bindings/FormationOrchestrator";
import { claudeCodeStarted, closeClaudeCode, formationPaneId, hideClaudeCode, isClaudeCodeShowing, showClaudeCode } from "./claude-code.js";
import { $ } from "./dom.js";
import { hideSession, startCount, startFlow, stopFlow, switchFormation } from "./formation-flow.js";
import { currentFormation, formationEnvironment, initFormationList } from "./formation-list.js";
import { RELOAD_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { streamsEnvironment } from "./orca.js";
import { isShowing, releaseTerminal, showTerminals } from "./orca-terminal.js";
import { initSplit } from "./split.js";
import { show } from "./view.js";

export type DevMode = "orca" | "formation";

// The name of the pane's owner: what `hideClaudeCode` is told when the mode or the screen is left.
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
const failures = new Map<string, string>();

let mode: DevMode = "orca";
export const devMode = () => mode;
export function setDevMode(next: DevMode) {
  mode = next;
}

// Shows the terminal of the orchestrator of the formation that is shown, and hides the one of another (its process goes on). The process starts with the first show of a formation, and a show of a running one starts nothing (A-36).
// Nothing is shown while the mode or the screen is left: a selection or a deletion that ends then (it was on its way when the owner left) must not take the hidden pane.
// While no formation is selected the middle pane is not shown, and no orchestrator is started.
function showPane() {
  if (mode !== "formation" || $("formation").hidden) return;
  const id = pane();
  $("formation-orchestrator").hidden = id === null;
  $("formation-split").hidden = id === null;
  if (id === null) return hideClaudeCode(OWNER);
  const name = currentFormation()!;
  $("formation-head-name").textContent = name;
  const host = $("formation-term");
  const remote = formationEnvironment(name) !== LOCAL;
  const said = remote ? (failures.get(name) ?? null) : null;
  $("formation-term-error").hidden = said === null;
  $("formation-term-error").textContent = said ?? "";
  if (remote) return showRemote(name, host, said);
  if (!isClaudeCodeShowing(host, id, OWNER)) showClaudeCode(host, { id, kind: "formation" }, OWNER);
}

// Shows the terminal of the orchestrator of a formation of a saved environment, and starts it when it has none and no failure is on the screen (a failure is tried again by the restart button, or by pressing the formation again).
function showRemote(name: string, host: HTMLElement, failure: string | null) {
  const got = terminals.get(name);
  if (!got) {
    hideClaudeCode(OWNER);
    if (failure === null) void startRemote(name, false);
    return;
  }
  host.classList.add("claude-code-pane");
  const kind = streamsEnvironment(got.environment) ? "stream" : "mirror";
  const placement = { id: got.handle, source: { kind, handle: got.handle, path: "", environment: got.environment } as const, host };
  if (!isShowing(placement, OWNER)) showTerminals([placement], got.handle, OWNER);
}

// Asks Rust for the terminal of the orchestrator of `name` (one start at a time for a formation), and shows it when that formation is still the one shown. `restart` ends the one it has.
async function startRemote(name: string, restart: boolean) {
  if (starting.has(name)) return;
  starting.add(name);
  failures.delete(name);
  try {
    terminals.set(name, await invoke("formation_orchestrator", { name, restart }));
  } catch (e) {
    failures.set(name, String(e));
  } finally {
    starting.delete(name);
  }
  if (currentFormation() === name) showPane();
}

// Shows the mode and the orchestrator's terminal in it. The flow and the list are read while the mode is shown.
export function showFormation() {
  show("formation");
  startFlow();
  showPane();
}

// The restart button of the header: ends the process of the orchestrator of the formation that is shown, if it is running (or has ended), and begins a new one with the keyboard, as a first show does (A-37). The other formations' orchestrators and the children are not touched.
// The button is off until the new start has answered, because two starts of the pane's id at once could end each other's process.
export function initFormation() {
  initSplit($("formation"), $("formation-split"), { side: "left", min: 0.2, max: 0.5, initial: 0.25, property: "--list-w" });
  // Another formation is selected in the list: its flow is read in place of the last one's, and its orchestrator is shown in the middle.
  initFormationList(
    (name) => {
      // A formation that is pressed again tries again after a failure.
      if (name !== null) failures.delete(name);
      switchFormation();
      showPane();
    },
    // A formation was deleted: Rust has ended its orchestrator's process, so its terminal is dropped. The release hides the shown terminal of this owner too, so the shown formation's is shown again.
    (name) => {
      closeClaudeCode(formationPaneId(name), OWNER);
      const got = terminals.get(name);
      if (got) releaseTerminal(got.handle, OWNER);
      terminals.delete(name);
      failures.delete(name);
      showPane();
    },
  );
  $("formation-restart").innerHTML = RELOAD_SVG;
  const button = $<HTMLButtonElement>("formation-restart");
  button.onclick = () => {
    const id = pane();
    if (id === null) return;
    button.disabled = true;
    const name = currentFormation()!;
    if (formationEnvironment(name) !== LOCAL) {
      const got = terminals.get(name);
      if (got) releaseTerminal(got.handle, OWNER);
      terminals.delete(name);
      void startRemote(name, true).then(() => {
        button.disabled = false;
      });
      return;
    }
    closeClaudeCode(id, OWNER);
    showClaudeCode($("formation-term"), { id, kind: "formation" }, OWNER);
    void claudeCodeStarted(id).then(() => {
      button.disabled = false;
    });
  };
}

// The mode or the screen is left: the terminals are hidden (the orchestrator's process goes on, the children's mirrors stop), and the flow is no longer read.
export function hideFormation() {
  stopFlow();
  hidePanes();
}

// Only the terminals are hidden: the numbers of the footer, from the read in hand, go on.
export function hidePanes() {
  hideSession();
  hideClaudeCode(OWNER);
}

// Orca is the mode of the development screen: the children are read only to count those that wait.
export const watchFormation = startCount;
