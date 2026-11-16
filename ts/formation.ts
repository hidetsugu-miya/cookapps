// The orchestration mode of the development screen (A-37): three columns, the orchestrator's terminal at the left, the children's tabs in the middle and the flow at the right.
// The right column is the flow of the children (formation-flow.ts); the middle one holds only the strip of the tabs until the issue that fills it. The mode is kept only while the app runs; the first one is Orca.
import { FORMATION_ID, hideClaudeCode, isClaudeCodeShowing, showClaudeCode } from "./claude-code.js";
import { $ } from "./dom.js";
import { startFlow, stopFlow } from "./formation-flow.js";
import { show } from "./view.js";

export type DevMode = "orca" | "formation";

// The name of the pane's owner: what `hideClaudeCode` is told when the mode or the screen is left.
const OWNER = "formation-screen";

let mode: DevMode = "orca";
export const devMode = () => mode;
export function setDevMode(next: DevMode) {
  mode = next;
}

// Shows the mode and the orchestrator's terminal in it; the process starts with the first show, and a show of a running one starts nothing (A-36). The flow is read while the mode is shown.
export function showFormation() {
  show("formation");
  startFlow();
  const host = $("formation-term");
  if (!isClaudeCodeShowing(host, FORMATION_ID, OWNER)) showClaudeCode(host, { id: FORMATION_ID, kind: "formation" }, OWNER);
}

// The mode or the screen is left: the terminal is hidden and the process goes on, and the flow is no longer read.
export function hideFormation() {
  stopFlow();
  hideClaudeCode(OWNER);
}
