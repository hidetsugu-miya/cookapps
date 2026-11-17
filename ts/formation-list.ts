// The list of the formations at the left of the orchestration mode (A-37): a row for each formation with its name, the time since it was made, its projects and the number of its children in each state (`formation_list`).
// The formation of the selected row is the one the middle pane (its orchestrator) and the right pane (its flow) show; with no row selected (at each start, and after the selected one is deleted) neither pane is shown. The list is read on the clock of the flow (formation-flow.ts), so it is read only while the mode is shown.
import type { FormationEntry } from "./bindings/FormationEntry";
import type { FormationKeptChild } from "./bindings/FormationKeptChild";
import type { FormationState } from "./bindings/FormationState";
import { $, span, tag } from "./dom.js";
import { openFormationDialog } from "./formation-new.js";
import { confirmFormationDelete, confirmFormationForce } from "./hint.js";
import { DELETE_SVG, PLUS_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { elapsed } from "./orca.js";

export const STATE_LABELS: Record<FormationState, string> = { working: "作業中", waiting: "承認待ち", done: "完了", planned: "予定" };
// The order of the counts of a row.
const COUNT_ORDER: FormationState[] = ["waiting", "working", "planned", "done"];

// The name of the formation the screen shows: none at each start of the app, in memory only.
let current: string | null = null;
export const currentFormation = () => current;

// The last read; a read that failed keeps it and says why in `failure`.
let formations: FormationEntry[] = [];
let failure: string | null = null;
let reading = false;
// Counts the formations made by this screen: a read that began before one was made does not know it, and its answer is dropped.
let made = 0;
// What the list shows now; it is drawn again only when the key changes.
let listKey = "";
// Told the name of the formation that was selected (a press), or null when none is selected any more (the shown one left the list).
let onChange: (name: string | null) => void = () => {};
// Told the name of a formation that was deleted, so that the terminal of its orchestrator is dropped.
let onRemoved: (name: string) => void = () => {};
// The formations whose deletion is on its way (the children are being closed), and why the last deletion was refused.
const deleting = new Set<string>();
let deleteFailure: string | null = null;

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
  // The shown formation left the list: its flow is read no more, and none is shown.
  if (read && current !== null && !formations.some((f) => f.name === current)) choose(null);
  draw();
}

// A formation was made in the dialog: it is in the list now, in the order of the names, and it is selected (its orchestrator starts).
function added(entry: FormationEntry) {
  made++;
  deleteFailure = null;
  formations = [...formations.filter((f) => f.name !== entry.name), entry].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  choose(entry.name);
  void readList();
}

// Deletes the formation `name` (the children are closed first; Rust deletes it only when all of them are). Without `force`, children that git keeps are the answer: nothing was closed, and the owner is asked to force it. A refusal that no force passes keeps the formation and shows its reason.
async function remove(name: string, force: boolean) {
  if (deleting.has(name)) return;
  deleting.add(name);
  deleteFailure = null;
  draw();
  let kept: FormationKeptChild[] | null = null;
  try {
    const answer = await invoke("formation_delete", { name, force });
    if (!answer.deleted) kept = answer.kept;
  } catch (e) {
    deleteFailure = String(e);
    deleting.delete(name);
    draw();
    // Some children may be closed already, so the counts are read again.
    void readList();
    return;
  }
  deleting.delete(name);
  if (kept !== null) {
    draw();
    const anchor = $("formation-list-feed").querySelector(`[data-formation="${CSS.escape(name)}"] .formation-row-name`) ?? $("formation-list-feed");
    confirmFormationForce(anchor, name, kept, () => void remove(name, true));
    return;
  }
  // A read that began before the deletion still lists it: its answer is dropped.
  made++;
  formations = formations.filter((f) => f.name !== name);
  // The shown formation is deleted: none is shown, and the read of the flow of the deleted one stops.
  if (current === name) choose(null);
  onRemoved(name);
  draw();
  void readList();
}

// The menu of a right press on a row.
function openRowMenu(f: FormationEntry, anchor: Element, e: MouseEvent) {
  e.preventDefault();
  if (deleting.has(f.name)) return;
  openMenu(anchor, [{ label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, pick: () => confirmFormationDelete(anchor, f.name, () => void remove(f.name, false)) }], { at: { x: e.clientX, y: e.clientY } });
}

// Selects the formation `name`: its orchestrator and its flow are shown. `null` selects none, and neither is shown.
function choose(name: string | null) {
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
  node.onclick = () => {
    deleteFailure = null;
    choose(f.name);
    draw();
  };
  if (deleting.has(f.name)) node.setAttribute("aria-busy", "true");
  const head = span("formation-row-head", "");
  const name = span("formation-row-name", f.name);
  // The menu and its confirmation are anchored on the name, which the button's own state does not touch.
  node.oncontextmenu = (e) => openRowMenu(f, name, e);
  head.append(name);
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
  const error = deleteFailure ?? failure;
  $("formation-list-error").hidden = error === null;
  $("formation-list-error").textContent = error ?? "";
  const key = JSON.stringify([current, [...deleting], formations.map((f) => [f.name, f.projects, f.createdAt === null ? "" : elapsed(f.createdAt, now, false), f.counts])]);
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

export function initFormationList(changed: (name: string | null) => void, removed: (name: string) => void) {
  onChange = changed;
  onRemoved = removed;
  const plus = $<HTMLButtonElement>("formation-new");
  plus.innerHTML = PLUS_SVG;
  plus.onclick = () => openFormationDialog(plus, added);
  draw();
}
