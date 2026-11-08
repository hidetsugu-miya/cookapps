// The layouts of the work pane of the Orca screen (A-17): for each project of each target, the panes with their tabs, as Rust holds and saves them (`orca_panes`).
// This module keeps what Rust answered, so the screen draws at once; it sends the tabs the screen shows with every call (Rust mends the saved layout against them), and an operation of the user.
// The calls go one at a time, in the order they were made, and only the latest answer of a project is taken, so an older answer never replaces a newer one.
// Selecting a tab or pressing a pane is also made here at once, before Rust's answer, so the screen follows the press.
import type { PaneLayout } from "./bindings/PaneLayout";
import type { PaneNode } from "./bindings/PaneNode";
import type { PaneOp } from "./bindings/PaneOp";
import { invoke } from "./ipc.js";

// A pane with its tabs in order and the one selected, as the layout holds it.
export type PaneInfo = Extract<PaneNode, { kind: "pane" }>;

// The layouts answered, by target and project; the tabs each project's layout was last asked for; the number of the latest call of each project.
const layouts = new Map<string, PaneLayout>();
const asked = new Map<string, string>();
const latest = new Map<string, number>();
let issued = 0;
let chain: Promise<void> = Promise.resolve();

const keyOf = (target: string | null, project: string) => JSON.stringify([target, project]);

export const layoutOf = (target: string | null, project: string) => layouts.get(keyOf(target, project)) ?? null;

// The panes of a layout, left to right and top to bottom.
export function panesOf(node: PaneNode | null): PaneInfo[] {
  if (node === null) return [];
  return node.kind === "pane" ? [node] : node.children.flatMap(panesOf);
}

// The tab shown in the pane that has the focus, null with no panes.
export function focusedTab(layout: PaneLayout | null) {
  const panes = panesOf(layout?.root ?? null);
  return (panes.find((p) => p.id === layout?.focus) ?? panes[0])?.selected ?? null;
}

// Whether the layout of the project was not asked for with exactly these tabs yet.
export const needsSync = (target: string | null, project: string, tabs: string[]) => asked.get(keyOf(target, project)) !== tabs.join("\n");

// Forgets every layout (the target changed: the tabs of the old one are not the new one's).
export function forgetPanes() {
  layouts.clear();
  asked.clear();
  latest.clear();
}

// Makes a press (a pane gets the focus, a tab is selected in its pane) on the layout held, as Rust will: nothing changes when the layout does not hold the tab or the pane.
export function applyLocal(target: string | null, project: string, op: PaneOp) {
  const layout = layouts.get(keyOf(target, project));
  if (!layout || op.kind === "move") return;
  const panes = panesOf(layout.root);
  const pane = op.kind === "focus" ? panes.find((p) => p.id === op.pane) : panes.find((p) => p.tabs.includes(op.tab));
  if (!pane) return;
  if (op.kind === "select") pane.selected = op.tab;
  layout.focus = pane.id;
}

// Asks Rust for the layout of the project with the tabs that `tabs` gives when the call is made (null: the screen no longer shows that project's tabs, so nothing is asked), after `op` when there is one.
// `done` runs once the layout held changed, and `fail` with the message of a call that failed (the project then has a layout of one pane until the next call that works).
export function syncPanes(target: string | null, project: string, tabs: () => string[] | null, op: PaneOp | null, done: () => void, fail: (e: unknown) => void) {
  const key = keyOf(target, project);
  const now = tabs();
  if (now === null) return;
  const mine = ++issued;
  latest.set(key, mine);
  asked.set(key, now.join("\n"));
  chain = chain.then(async () => {
    const ids = tabs();
    if (ids === null) return;
    asked.set(key, ids.join("\n"));
    try {
      const layout = await invoke("orca_panes", { environment: target, project, tabs: ids, op });
      if (latest.get(key) === mine) {
        layouts.set(key, layout);
        done();
      }
    } catch (e) {
      if (latest.get(key) === mine && !layouts.has(key)) {
        const first = ids[0];
        layouts.set(key, { root: first === undefined ? null : { kind: "pane", id: "p1", tabs: ids, selected: first }, focus: first === undefined ? null : "p1" });
        done();
      }
      fail(e);
    }
  });
}
