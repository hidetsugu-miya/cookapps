// The orchestration mode of the development screen (A-37): three panes, the list of the formations at the left (formation-list.ts), the terminal of the orchestrator of the selected formation in the middle and its flow at the right, with the session of the selected child under it (formation-flow.ts).
// The mode is kept only while the app runs; the first one is Orca.
import { claudeCodeStarted, closeClaudeCode, formationPaneId, hideClaudeCode, isClaudeCodeShowing, showClaudeCode } from "./claude-code.js";
import { $ } from "./dom.js";
import { hideSession, startCount, startFlow, stopFlow, switchFormation } from "./formation-flow.js";
import { currentFormation, initFormationList } from "./formation-list.js";
import { RELOAD_SVG } from "./icons.js";
import { initSplit } from "./split.js";
import { show } from "./view.js";

export type DevMode = "orca" | "formation";

// The name of the pane's owner: what `hideClaudeCode` is told when the mode or the screen is left.
const OWNER = "formation-screen";
// The pane of the orchestrator of the formation the screen shows.
const pane = () => formationPaneId(currentFormation());

let mode: DevMode = "orca";
export const devMode = () => mode;
export function setDevMode(next: DevMode) {
  mode = next;
}

// Shows the terminal of the orchestrator of the formation that is shown, and hides the one of another (its process goes on). The process starts with the first show of a formation, and a show of a running one starts nothing (A-36).
function showPane() {
  $("formation-head-name").textContent = currentFormation();
  const host = $("formation-term");
  if (!isClaudeCodeShowing(host, pane(), OWNER)) showClaudeCode(host, { id: pane(), kind: "formation" }, OWNER);
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
    () => {
      switchFormation();
      showPane();
    },
    // A formation was deleted: Rust has ended its orchestrator's process, so its terminal is dropped. The release hides the shown terminal of this owner too, so the shown formation's is shown again.
    (name) => {
      closeClaudeCode(formationPaneId(name), OWNER);
      showPane();
    },
  );
  $("formation-restart").innerHTML = RELOAD_SVG;
  const button = $<HTMLButtonElement>("formation-restart");
  button.onclick = () => {
    button.disabled = true;
    const id = pane();
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

// Only the terminals are hidden: the count of the waiting children, when it is the read in hand, goes on.
export function hidePanes() {
  hideSession();
  hideClaudeCode(OWNER);
}

// Orca is the mode of the development screen: the children are read only to count those that wait.
export const watchFormation = startCount;
