// The flow pane of the orchestration mode (A-37): the orchestrator's card and under it the children as small cards in the order `formation_children` gives, read every few seconds while the mode is shown.
// The same read feeds the children's tabs (formation-tabs.ts), and, while Orca is the mode of the development screen, it is made at the Orca list's period only to count the children that wait, on the footer's icon.
// The button that closes and opens the pane is in its heading while it is open and at the right end of the strip of the children's tabs while it is closed, as the file pane's of Orca is (A-18).
import type { FormationChild } from "./bindings/FormationChild";
import type { FormationState } from "./bindings/FormationState";
import { $, span, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { invoke } from "./ipc.js";
import { setFormationWaiting } from "./footer.js";
import { initFormationTabs, selectChild, selectedChild, syncTabs } from "./formation-tabs.js";
import { elapsed, shownMs } from "./orca.js";

const READ_MS = 3000;
const STATE_LABELS: Record<FormationState, string> = { working: "作業中", waiting: "承認待ち", done: "完了", planned: "予定" };

// The last read; a read that failed keeps it and says why in `failure`.
let children: FormationChild[] = [];
let failure: string | null = null;
// Whether the pane is open: kept in memory only, open at first.
let open = true;
// The clock of the reads and what the reads are for (the pane and the tabs, or the count only), and whether one is on its way (the next tick waits for it).
let timer: number | null = null;
let watching: "flow" | "count" | null = null;
let reading = false;
// What the tree shows now; it is drawn again only when this changes.
let treeKey = "";

async function read() {
  // A hidden window reads nothing, as the Orca list does; it reads once when it is shown again (initFormationFlow).
  if (reading || document.hidden) return;
  reading = true;
  try {
    children = await invoke("formation_children");
    failure = null;
  } catch (e) {
    failure = String(e);
  } finally {
    reading = false;
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

// The mode is shown.
export const startFlow = () => watch("flow", periodMs("formationFlow", READ_MS));

// Orca is the mode of the development screen: the children that wait are counted at the period of the Orca list's read.
export const startCount = () => watch("count", shownMs());

// The mode or the screen is left: nothing is read until it is shown again.
export function stopFlow() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  watching = null;
  setFormationWaiting(0);
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
    node.setAttribute("aria-pressed", String(selectedChild() === c.name));
    node.onclick = () => selectChild(c.name);
  }
  li.append(node);
  return li;
}

function draw() {
  const now = Date.now();
  const launched = children.filter((c) => c.state !== "planned");
  const planned = children.length - launched.length;
  const waiting = launched.filter((c) => c.state === "waiting").length;
  setFormationWaiting(watching === "count" ? waiting : 0);
  if (watching === "count") return;
  // The middle and the right columns are shown from the first child (a planned one too) on, and the orchestrator has the whole width before.
  // The middle column comes first, so that the terminal of a tab is placed in a host that has its size.
  const formed = children.length > 0;
  $("formation-children").hidden = !formed;
  // The tabs first: the follow may move the selection that the cards mark.
  if (watching === "flow") syncTabs(children);
  const selected = selectedChild();
  $("formation-flow").hidden = !formed || !open;
  $("formation-tabbar-toggle").hidden = open;
  $("formation-flow-count").textContent = `子 ${launched.length}${planned > 0 ? ` · 予定 ${planned}` : ""}`;
  // While the pane is closed the button shows how many children wait for the user.
  const label = !open && waiting > 0 ? `流れ（承認待ち ${waiting} 件）` : "流れ";
  for (const id of ["formation-flow-toggle", "formation-tabbar-toggle"]) {
    $(id).setAttribute("aria-pressed", String(open));
    $(id).setAttribute("aria-label", label);
  }
  const badge = $("formation-tabbar-toggle").querySelector<HTMLElement>(".formation-flow-badge")!;
  badge.hidden = open || waiting === 0;
  badge.textContent = String(waiting);
  $("formation-flow-error").hidden = failure === null;
  $("formation-flow-error").textContent = failure ?? "";
  const key = JSON.stringify([selected, children.map((c) => [c.name, c.state, c.state === "planned" ? "" : elapsed(c.atMs, now, c.state === "done"), c.reply])]);
  if (key === treeKey) return;
  treeKey = key;
  // The tree is drawn again in place: the scroll and the focus stay where they were.
  const body = $("formation-flow-body");
  const top = body.scrollTop;
  const list = $("formation-flow-list");
  // The tab of the same child carries the same name, so only a focus inside this list is put back.
  const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.child : undefined;
  $("formation-flow-list").replaceChildren(...children.map((c) => card(c, now)));
  body.scrollTop = top;
  if (focused) $("formation-flow-list").querySelector<HTMLElement>(`[data-child="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

// The pressed button is hidden by the draw, so the focus goes on to the button that is shown now.
function toggleFlow() {
  const focused = document.activeElement?.classList.contains("formation-flow-toggle") ?? false;
  open = !open;
  draw();
  if (focused) [...document.querySelectorAll<HTMLElement>(".formation-flow-toggle")].find((b) => b.offsetParent !== null)?.focus({ preventScroll: true });
}

export function initFormationFlow() {
  const icon = $("footer-mode-formation").querySelector("svg")!.outerHTML;
  for (const id of ["formation-flow-toggle", "formation-tabbar-toggle"]) {
    $(id).insertAdjacentHTML("afterbegin", icon);
    $(id).onclick = toggleFlow;
  }
  initFormationTabs(draw);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && watching !== null) void read();
  });
  draw();
}
