// The orchestration mode of the development screen (A-37): three columns, the orchestrator's terminal at the left, the children's tabs and terminals in the middle (formation-tabs.ts) and the flow at the right (formation-flow.ts).
// The mode is kept only while the app runs; the first one is Orca.
import { FORMATION_ID, hideClaudeCode, isClaudeCodeShowing, showClaudeCode } from "./claude-code.js";
import { $ } from "./dom.js";
import { startCount, startFlow, stopFlow } from "./formation-flow.js";
import { hideTabs } from "./formation-tabs.js";
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

// The mode or the screen is left: the terminals are hidden (the orchestrator's process goes on, the children's mirrors stop), and the flow is no longer read.
export function hideFormation() {
  stopFlow();
  hidePanes();
}

// Only the terminals are hidden: the count of the waiting children, when it is the read in hand, goes on.
export function hidePanes() {
  hideTabs();
  hideClaudeCode(OWNER);
}

// Orca is the mode of the development screen: the children are read only to count those that wait.
export const watchFormation = startCount;
