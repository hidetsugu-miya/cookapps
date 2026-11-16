// The children's tabs of the orchestration mode (A-37): one tab for each child that has a terminal, in the order they were launched, and the terminal of the selected tab under them, mirrored from Orca as the Orca screen does (A-8).
// The owner of these terminals is this module's own, so that the Orca screen's terminals and these do not take each other. The selection is also what the flow pane marks, and 「自動で追う」 moves it to the child that waits.
import type { FormationChild } from "./bindings/FormationChild";
import { $, span, tag } from "./dom.js";
import { hideTerminals, isShowing, releaseTerminal, showTerminals, type Placement } from "./orca-terminal.js";

// The name of the owner of the terminals: what `showTerminals` and `hideTerminals` are told.
const OWNER = "formation-children";

// The children that have a terminal (the last read), the selected child (its name), whether 「自動で追う」 is on (on at first, in memory only), and what the strip shows now.
let tabs: FormationChild[] = [];
let selected: string | null = null;
let follow = true;
let stripKey = "";
let scrolledTo: string | null = null;
// The handles whose terminals this module showed, to forget the ones of children that are gone.
const held = new Set<string>();
// What the flow pane does when the selection changes (it marks the card).
let changed: () => void = () => {};

export const selectedChild = () => selected;

// The child that 「自動で追う」 selects: the one that has waited for approval the longest, else the selected one when it works, else the first one that works; null when none works.
export function followTarget(children: FormationChild[], current: string | null): string | null {
  const waiting = children.filter((c) => c.state === "waiting").sort((a, b) => a.atMs - b.atMs)[0];
  if (waiting) return waiting.name;
  const working = children.filter((c) => c.state === "working");
  return (working.find((c) => c.name === current) ?? working[0])?.name ?? null;
}

function placementOf(child: FormationChild): Placement {
  const handle = child.handle!;
  return { id: handle, source: { kind: "mirror", handle, path: "", environment: null }, host: $("formation-child-term") };
}

// Shows the terminal of the selected child, and hides the others (their reads stop). `focus` gives it the keyboard: only a press of the user does, never the follow, so the orchestrator's terminal keeps the keys the owner is typing.
function showSelected(focus: boolean) {
  const child = tabs.find((c) => c.name === selected);
  if (!child) return hideTerminals(OWNER);
  const placement = placementOf(child);
  if (!isShowing(placement, OWNER) || focus) showTerminals([placement], focus ? placement.id : null, OWNER);
  held.add(placement.id);
}

function tabNode(c: FormationChild): HTMLButtonElement {
  const node = tag("button", "formation-tab");
  node.type = "button";
  node.setAttribute("role", "tab");
  node.setAttribute("aria-selected", String(c.name === selected));
  node.dataset.state = c.state;
  node.dataset.child = c.name;
  node.append(tag("i", "formation-dot"), span("formation-tab-title", c.name));
  node.onclick = () => selectChild(c.name);
  return node;
}

function drawStrip() {
  $("formation-follow").setAttribute("aria-pressed", String(follow));
  const key = JSON.stringify([selected, tabs.map((c) => [c.name, c.state])]);
  if (key === stripKey) return;
  stripKey = key;
  // The strip is drawn again in place: its scroll and the focus stay where they were.
  const strip = $("formation-tabs");
  const left = strip.scrollLeft;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.child;
  strip.replaceChildren(...tabs.map(tabNode));
  strip.scrollLeft = left;
  if (focused) strip.querySelector<HTMLElement>(`[data-child="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  // A selection that moved is brought into view.
  if (selected !== scrolledTo) {
    scrolledTo = selected;
    strip.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

// The children of a read: the tabs follow them, the selection follows the waiting child while 「自動で追う」 is on, and the terminals of the children that are gone are forgotten.
export function syncTabs(children: FormationChild[]) {
  tabs = children.filter((c) => c.handle !== null);
  if (follow) selected = followTarget(tabs, selected) ?? selected;
  if (!tabs.some((c) => c.name === selected)) selected = tabs[0]?.name ?? null;
  const handles = new Set(tabs.map((c) => c.handle));
  for (const handle of held) {
    if (handles.has(handle)) continue;
    held.delete(handle);
    releaseTerminal(handle, OWNER);
  }
  drawStrip();
  showSelected(false);
}

// A press of the user on a tab or on a card of the flow selects that child and turns 「自動で追う」 off. A child with no tab is not selected.
export function selectChild(name: string) {
  if (!tabs.some((c) => c.name === name)) return;
  selected = name;
  follow = false;
  drawStrip();
  changed();
  showSelected(true);
}

// The mode or the screen is left: the terminal is hidden and its reads stop.
export function hideTabs() {
  hideTerminals(OWNER);
}

export function initFormationTabs(onChange: () => void) {
  changed = onChange;
  $("formation-follow").onclick = () => {
    follow = !follow;
    if (follow) selected = followTarget(tabs, selected) ?? selected;
    drawStrip();
    changed();
    showSelected(false);
  };
}
