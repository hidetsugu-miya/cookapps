// The right pane of the orchestration mode (A-37): above, the view of the flow (the orchestrator's card and under it the children as small cards in the order `formation_children` gives), and below, the session of the selected child, a terminal mirrored from the Orca of the child's environment as the Orca screen's are (A-8).
// The children of the formation that the list has selected (formation-list.ts) are read every few seconds while the mode is shown, and the list is read on the same clock; no other formation's children are read. While Orca is the mode of the development screen, only the list is read, at the Orca list's period, to count the children that wait in all the formations, on the footer's icon.
// The cards are the tabs: the card of a child that has a terminal selects it, and 「自動で追う」 moves the selection to the child that waits. The terminals have an owner of their own, so that the Orca screen's terminals and these do not take each other.
import type { FormationChild } from "./bindings/FormationChild";
import { $, span, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { currentFormation, readList, STATE_LABELS } from "./formation-list.js";
import { invoke } from "./ipc.js";
import { setFormationWaiting } from "./footer.js";
import { elapsed, shownMs } from "./orca.js";
import { hideTerminals, isShowing, type Placement, releaseTerminal, showTerminals } from "./orca-terminal.js";

const READ_MS = 3000;
// The name of the owner of the terminals: what `showTerminals` and `hideTerminals` are told.
const OWNER = "formation-session";
// The environment of this Mac in `FormationChild.environment`; the terminal source calls it null, as the Orca screen's.
const LOCAL = "local";

// The last read; a read that failed keeps it and says why in `failure`.
let children: FormationChild[] = [];
let failure: string | null = null;
// The children that wait in all the formations, by the last read of the list in the Orca mode.
let counted = 0;
// The children that have a terminal (the last read), the selected child (its name) and whether 「自動で追う」 is on (on at first, in memory only).
let terms: FormationChild[] = [];
let selected: string | null = null;
let follow = true;
// The handles whose terminals were shown, to forget the ones of children that are gone.
const held = new Set<string>();
// The clock of the reads and what the reads are for (the pane, or the count only), and whether one is on its way (the next tick waits for it).
let timer: number | null = null;
let watching: "flow" | "count" | null = null;
let reading = false;
// Counts the switches of the formation, so that a read that was on its way when the formation changed is dropped.
let epoch = 0;
// What the tree shows now, and what the session band shows now; each is drawn again only when its key changes.
let treeKey = "";
let sessionKey: string | null = "";
// The child whose card was last brought into the view of the tree (the selection that moved is shown, the one that stays is not scrolled to again).
let scrolledTo: string | null = null;

async function read() {
  // A hidden window reads nothing, as the Orca list does; it reads once when it is shown again (initFormationFlow).
  if (document.hidden) return;
  // The list of the formations is read on this clock too, while the pane is shown (not for the count).
  if (watching === "flow") void readList();
  if (reading) return;
  reading = true;
  const mine = epoch;
  const counting = watching === "count";
  try {
    if (counting) {
      // A read that fails keeps the last count.
      const answer = await invoke("formation_list");
      counted = answer.formations.reduce((sum, f) => sum + f.counts.waiting, 0);
    } else {
      const got = await invoke("formation_children", { name: currentFormation() });
      if (mine !== epoch) return;
      children = got;
      failure = null;
    }
  } catch (e) {
    if (mine !== epoch) return;
    if (!counting) failure = String(e);
  } finally {
    if (mine === epoch) reading = false;
  }
  draw();
}

// Reads now and then by the clock, for `next`; one clock at a time, so the two ways never read together.
function watch(next: "flow" | "count", ms: number) {
  if (watching === next) return;
  stopFlow();
  watching = next;
  draw();
  void read();
  timer = window.setInterval(() => void read(), ms);
}

// Another formation is selected: what the pane shows of the last one is dropped (the children, the selection, the terminals of their sessions), and the children of the new one are read at once.
export function switchFormation() {
  epoch++;
  reading = false;
  children = [];
  failure = null;
  terms = [];
  selected = null;
  sessionKey = null;
  treeKey = "";
  scrolledTo = null;
  for (const handle of held) releaseTerminal(handle, OWNER);
  held.clear();
  hideTerminals(OWNER);
  drawRoot();
  draw();
  if (watching === "flow") void read();
}

// The orchestrator's card of the tree has the name of the formation that is shown.
function drawRoot() {
  $("formation-flow-root").querySelector(".formation-card-name")!.textContent = currentFormation();
}

// The mode is shown.
export const startFlow = () => watch("flow", periodMs("formationFlow", READ_MS));

// Orca is the mode of the development screen: the children that wait in all the formations are counted (from the list) at the period of the Orca list's read.
export const startCount = () => watch("count", shownMs());

// The mode or the screen is left: nothing is read until it is shown again.
export function stopFlow() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  watching = null;
  setFormationWaiting(0);
}

// The child that 「自動で追う」 selects: the one that has waited for approval the longest, else the selected one when it works, else the first one that works; null when none works.
export function followTarget(list: FormationChild[], current: string | null): string | null {
  const waiting = list.filter((c) => c.state === "waiting").sort((a, b) => a.atMs - b.atMs)[0];
  if (waiting) return waiting.name;
  const working = list.filter((c) => c.state === "working");
  return (working.find((c) => c.name === current) ?? working[0])?.name ?? null;
}

function placementOf(child: FormationChild): Placement {
  const handle = child.handle!;
  // The terminal is read and typed into in the Orca of the child's environment.
  const environment = child.environment === LOCAL ? null : child.environment;
  return { id: handle, source: { kind: "mirror", handle, path: "", environment }, host: $("formation-child-term") };
}

// Shows the terminal of the selected child, and hides the others (their reads stop). `focus` gives it the keyboard: only a press of the user does, never the follow, so the orchestrator's terminal keeps the keys the owner is typing.
function showSelected(focus: boolean) {
  const child = terms.find((c) => c.name === selected);
  if (!child) return hideTerminals(OWNER);
  const placement = placementOf(child);
  if (!isShowing(placement, OWNER) || focus) showTerminals([placement], focus ? placement.id : null, OWNER);
  held.add(placement.id);
}

// The children of a read: the session follows them, the selection follows the waiting child while 「自動で追う」 is on, and the terminals of the children that are gone are forgotten.
// The session is shown before its terminal is placed, so that the terminal is placed in a host that has its size.
function syncSession() {
  terms = children.filter((c) => c.handle !== null);
  if (follow) selected = followTarget(terms, selected) ?? selected;
  if (!terms.some((c) => c.name === selected)) selected = terms[0]?.name ?? null;
  const handles = new Set(terms.map((c) => c.handle));
  for (const handle of held) {
    if (handles.has(handle)) continue;
    held.delete(handle);
    releaseTerminal(handle, OWNER);
  }
  const child = terms.find((c) => c.name === selected);
  const key = child ? `${child.name}\n${child.state}` : "";
  if (key !== sessionKey) {
    sessionKey = key;
    $("formation-session").hidden = !child;
    $("formation-session-head").dataset.state = child?.state ?? "";
    $("formation-session-name").textContent = child?.name ?? "";
  }
  showSelected(false);
}

// A press of the user on a card selects that child and turns 「自動で追う」 off. A child with no terminal is not selected.
function selectChild(name: string) {
  if (!terms.some((c) => c.name === name)) return;
  selected = name;
  follow = false;
  draw();
  showSelected(true);
}

// The mode or the screen is left: the terminal is hidden and its reads stop.
export function hideSession() {
  hideTerminals(OWNER);
}

function card(c: FormationChild, now: number): HTMLLIElement {
  const li = tag("li");
  li.dataset.state = c.state;
  const planned = c.state === "planned";
  const node = planned ? tag("div", "formation-card") : tag("button", "formation-card");
  node.dataset.state = c.state;
  const row = span("formation-card-row", "");
  row.append(span("formation-card-name", c.name));
  const time = planned ? "" : elapsed(c.atMs, now, c.state === "done");
  if (time !== "") row.append(tag("time", "formation-card-time", time));
  const line = span("formation-card-row", "");
  const state = span("formation-card-state", STATE_LABELS[c.state]);
  state.prepend(tag("i", "formation-dot"));
  line.append(state);
  if (!planned && c.reply) line.append(span("formation-card-msg", c.reply));
  node.append(row, line);
  if (node instanceof HTMLButtonElement) {
    node.type = "button";
    node.dataset.child = c.name;
    node.setAttribute("aria-pressed", String(selected === c.name));
    node.onclick = () => selectChild(c.name);
  }
  li.append(node);
  return li;
}

function draw() {
  const now = Date.now();
  setFormationWaiting(watching === "count" ? counted : 0);
  if (watching === "count") return;
  const launched = children.filter((c) => c.state !== "planned");
  const planned = children.length - launched.length;
  // The right pane is shown from the first child (a planned one too) on, and the orchestrator has the whole width before.
  $("formation-flow").hidden = children.length === 0;
  // The session first: the follow may move the selection that the cards mark.
  if (watching === "flow") syncSession();
  $("formation-follow").setAttribute("aria-pressed", String(follow));
  $("formation-flow-count").textContent = `子 ${launched.length}${planned > 0 ? ` · 予定 ${planned}` : ""}`;
  $("formation-flow-error").hidden = failure === null;
  $("formation-flow-error").textContent = failure ?? "";
  const key = JSON.stringify([selected, children.map((c) => [c.name, c.state, c.state === "planned" ? "" : elapsed(c.atMs, now, c.state === "done"), c.reply])]);
  if (key === treeKey) return;
  treeKey = key;
  // The tree is drawn again in place: the scroll and the focus stay where they were.
  const body = $("formation-flow-body");
  const top = body.scrollTop;
  const list = $("formation-flow-list");
  const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.child : undefined;
  list.replaceChildren(...children.map((c) => card(c, now)));
  body.scrollTop = top;
  if (focused) list.querySelector<HTMLElement>(`[data-child="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  // A selection that moved (the follow moves it too) is brought into the view of the tree; the focus stays where it was.
  if (selected !== scrolledTo) {
    scrolledTo = selected;
    list.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
  }
}

export function initFormationFlow() {
  $("formation-follow").onclick = () => {
    follow = !follow;
    draw();
  };
  drawRoot();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && watching !== null) void read();
  });
  draw();
}
