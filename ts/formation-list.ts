// The list of the formations at the left of the orchestration mode (A-37): a row for each formation with its name, the time since it was made, its projects and the number of its children in each state (`formation_list`).
// The formation of the selected row is the one the middle pane (its orchestrator) and the right pane (its flow) show. The list is read on the clock of the flow (formation-flow.ts), so it is read only while the mode is shown.
import type { FormationEntry } from "./bindings/FormationEntry";
import type { FormationState } from "./bindings/FormationState";
import { FORMATION_NAME } from "./claude-code.js";
import { $, span, tag } from "./dom.js";
import { openFormationDialog } from "./formation-new.js";
import { PLUS_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { elapsed } from "./orca.js";

export const STATE_LABELS: Record<FormationState, string> = { working: "作業中", waiting: "承認待ち", done: "完了", planned: "予定" };
// The order of the counts of a row.
const COUNT_ORDER: FormationState[] = ["waiting", "working", "planned", "done"];

// The name of the formation the screen shows: the first one at each start of the app, in memory only.
let current = FORMATION_NAME;
export const currentFormation = () => current;

// The last read; a read that failed keeps it and says why in `failure`.
let formations: FormationEntry[] = [];
let failure: string | null = null;
let reading = false;
// Counts the formations made by this screen: a read that began before one was made does not know it, and its answer is dropped.
let made = 0;
// What the list shows now; it is drawn again only when the key changes.
let listKey = "";
// Told the name of the formation that was selected (a press, or the fallback when the shown one left the list).
let onChange: (name: string) => void = () => {};

// Reads the formations now. One call at a time; a hidden window reads nothing.
export async function readList() {
  if (reading || document.hidden) return;
  reading = true;
  let read = false;
  const before = made;
  try {
    const answer = await invoke("formation_list");
    if (before === made) {
      formations = answer.formations;
      failure = answer.readError;
      read = true;
    }
  } catch (e) {
    failure = String(e);
  } finally {
    reading = false;
  }
  // The shown formation left the list: its flow is read no more, and the first formation is shown.
  if (read && formations.length > 0 && !formations.some((f) => f.name === current)) choose(formations[0].name);
  draw();
}

// A formation was made in the dialog: it is in the list now, in the order of the names, and it is selected (its orchestrator starts).
function added(entry: FormationEntry) {
  made++;
  formations = [...formations.filter((f) => f.name !== entry.name), entry].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  choose(entry.name);
  void readList();
}

// Selects the formation `name`: its orchestrator and its flow are shown.
function choose(name: string) {
  if (name === current) return;
  current = name;
  draw();
  onChange(name);
}

function row(f: FormationEntry, now: number): HTMLButtonElement {
  const node = tag("button", "formation-row");
  node.type = "button";
  node.dataset.formation = f.name;
  node.setAttribute("aria-pressed", String(f.name === current));
  node.onclick = () => choose(f.name);
  const head = span("formation-row-head", "");
  head.append(span("formation-row-name", f.name));
  const time = f.createdAt === null ? "" : elapsed(f.createdAt, now, false);
  if (time !== "") head.append(tag("time", "formation-row-time", time));
  node.append(head);
  if (f.projects.length > 0) {
    const projects = span("formation-row-projects", "");
    for (const p of f.projects) projects.append(span("formation-row-project", p.repo));
    node.append(projects);
  }
  const counts = span("formation-row-counts", "");
  for (const state of COUNT_ORDER) {
    if (f.counts[state] === 0) continue;
    const count = span("formation-row-count", `${STATE_LABELS[state]} ${f.counts[state]}`);
    count.dataset.state = state;
    count.prepend(tag("i", "formation-dot"));
    counts.append(count);
  }
  if (counts.childElementCount > 0) node.append(counts);
  return node;
}

function draw() {
  const now = Date.now();
  $("formation-list-error").hidden = failure === null;
  $("formation-list-error").textContent = failure ?? "";
  const key = JSON.stringify([current, formations.map((f) => [f.name, f.projects, f.createdAt === null ? "" : elapsed(f.createdAt, now, false), f.counts])]);
  if (key === listKey) return;
  listKey = key;
  // The list is drawn again in place: the scroll and the focus stay where they were.
  const feed = $("formation-list-feed");
  const top = feed.scrollTop;
  const focused = feed.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.formation : undefined;
  feed.replaceChildren(...formations.map((f) => row(f, now)));
  feed.scrollTop = top;
  if (focused) feed.querySelector<HTMLElement>(`[data-formation="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

export function initFormationList(changed: (name: string) => void) {
  onChange = changed;
  const plus = $<HTMLButtonElement>("formation-new");
  plus.innerHTML = PLUS_SVG;
  plus.onclick = () => openFormationDialog(plus, added);
  draw();
}
