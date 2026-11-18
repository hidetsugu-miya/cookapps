// The formations under their heading at the top of the list of the development screen (A-37): a row for each formation, with its name and the number of its launched children (`formation_list`), and under it, while it is open, a row for each of those children.
// The formation of the selected row is the one the middle pane (its leader) and the right pane (its flow) show; with no row selected (at each start, after a project or a session is selected, and after the selected one is deleted) neither pane is shown. The list is read on the clock of formation-flow.ts, so it is read while the development screen is shown.
import type { FormationEntry } from "./bindings/FormationEntry";
import type { FormationKeptChild } from "./bindings/FormationKeptChild";
import type { FormationListChild } from "./bindings/FormationListChild";
import type { FormationShown } from "./bindings/FormationShown";
import type { FormationState } from "./bindings/FormationState";
import type { OrcaStatus } from "./bindings/OrcaStatus";
import { $, span, tag } from "./dom.js";
import { openFormationDialog } from "./formation-new.js";
import { confirmFormationDelete, confirmFormationForce } from "./hint.js";
import { CHEVRON_SVG, DELETE_SVG, FOLDER_SVG, FORMATION_NEW_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { type MenuItem, openMenu } from "./menu.js";
import { statusIcon } from "./orca.js";

export const STATE_LABELS: Record<FormationState, string> = { working: "作業中", waiting: "承認待ち", done: "完了", planned: "予定" };

// A child's state as the status icon of a session draws it (the same icons as the sessions under a project); a planned child is not listed, so it has none.
const STATUS_OF: Record<FormationState, OrcaStatus> = { working: "working", waiting: "question", done: "done", planned: "idle" };

// The environment of this Mac in `FormationEntry.environment`.
const LOCAL = "local";
// The label at the right of a row whose leader waits for input, as Orca's list words it (`STATUS_LABELS.question` of orca.ts, which imports this file).
const WAITING_LABEL = "入力待ち";

// The name of the formation the screen shows: none at each start of the app, in memory only.
let current: string | null = null;
export const currentFormation = () => current;
// A project or a session was selected: no formation is shown any more.
export const deselectFormation = () => choose(null);
// The PC the formation `name` belongs to, from the last read: `local` (this Mac) or a saved environment. Its orchestrator runs there.
export const formationEnvironment = (name: string) => formations.find((f) => f.name === name)?.environment ?? LOCAL;

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
// Told the name of the child whose row was pressed, after its formation was selected: the tab of that child is shown.
let onChild: (name: string) => void = () => {};
// The formations whose children are folded away (in memory only); a formation shows its children until its arrow is pressed.
const folded = new Set<string>();
// The formations whose deletion is on its way (the children are being closed), and why the last deletion was refused.
const deleting = new Set<string>();
let deleteFailure: string | null = null;
// What a deletion that worked told that is no failure: the branches that Orca kept for the commits no remote has.
let deleteNotice: string | null = null;

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
  deleteNotice = null;
  formations = [...formations.filter((f) => f.name !== entry.name), entry].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  choose(entry.name);
  void readList();
}

// Deletes the formation `name` (the children are closed first; Rust deletes it only when all of them are). Without `force`, children that git keeps are the answer: nothing was closed, and the owner is asked to force it; with it, `shown` are the children as the owner was shown them (their names and paths), and Rust forces only those. A refusal that no force passes keeps the formation and shows its reason.
async function remove(name: string, force: boolean, shown: FormationShown[]) {
  if (deleting.has(name)) return;
  deleting.add(name);
  deleteFailure = null;
  deleteNotice = null;
  draw();
  let kept: FormationKeptChild[] | null = null;
  try {
    const answer = await invoke("formation_delete", { name, force, shown });
    if (!answer.deleted) kept = answer.kept;
    else if (answer.preserved.length > 0) deleteNotice = `どのリモートにもないコミットがあるブランチは、ローカルに残しました: ${answer.preserved.join("、")}`;
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
    confirmFormationForce(anchor, name, kept, () => void remove(name, true, kept.map((child) => ({ name: child.name, path: child.answer.path }))));
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

// The menu of a right press on a row: the projects of the formation at the top, as headings that are not pressed (the row shows none), and under a line 「削除」.
function openRowMenu(f: FormationEntry, anchor: Element, e: MouseEvent) {
  e.preventDefault();
  if (deleting.has(f.name)) return;
  const projects: MenuItem[] = f.projects.map((p) => ({ label: p.repo, color: "", icon: `<span class="formation-menu-mark">${FOLDER_SVG}</span>`, current: false, disabled: true, pick: () => {} }));
  const del: MenuItem = { label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, divider: projects.length > 0, pick: () => confirmFormationDelete(anchor, f.name, () => void remove(f.name, false, [])) };
  openMenu(anchor, [...projects, del], { at: { x: e.clientX, y: e.clientY } });
  // A heading cannot take the focus, so the keys start on 「削除」.
  document.querySelector<HTMLElement>('.menu button:not(:disabled)')?.focus();
}

// Selects the formation `name`: its orchestrator and its flow are shown. `null` selects none, and neither is shown.
function choose(name: string | null) {
  if (name === current) return;
  current = name;
  draw();
  onChange(name);
}

function row(f: FormationEntry): HTMLButtonElement {
  const node = tag("button", "formation-row");
  node.type = "button";
  node.dataset.formation = f.name;
  node.setAttribute("aria-pressed", String(f.name === current));
  node.onclick = () => {
    deleteFailure = null;
    deleteNotice = null;
    choose(f.name);
    draw();
  };
  if (deleting.has(f.name)) node.setAttribute("aria-busy", "true");
  const name = span("formation-row-name", f.name);
  // The menu and its confirmation are anchored on the name, which the button's own state does not touch.
  node.oncontextmenu = (e) => openRowMenu(f, name, e);
  node.append(tag("i", "formation-row-dot"), name);
  // The leader waits for input: the dot is filled and a label says so (`FormationEntry.waiting`, #915).
  if (f.waiting) {
    node.dataset.waiting = "true";
    node.append(span("formation-row-waiting", WAITING_LABEL));
  }
  // The number of the launched children; none is drawn for a formation that has none.
  if (f.children.length > 0) {
    const count = span("formation-row-count", String(f.children.length));
    count.setAttribute("aria-label", `起動しているチームメイト ${f.children.length} 人`);
    node.append(count);
  }
  return node;
}

// A child of a formation: its state, its name and, under it, the project and the branch of its worktree. Pressing it selects the formation and shows the child's tab.
function childRow(f: FormationEntry, c: FormationListChild): HTMLButtonElement {
  const node = tag("button", "formation-child");
  node.type = "button";
  node.dataset.childOf = f.name;
  node.dataset.child = c.name;
  node.dataset.state = c.state;
  const text = tag("span", "formation-child-text");
  const where = c.branch === "" ? c.repo : `${c.repo} ・ ${c.branch}`;
  text.append(span("formation-child-name", c.name), span("formation-child-where", where));
  node.append(statusIcon(STATUS_OF[c.state], STATE_LABELS[c.state]), text);
  node.onclick = () => {
    deleteFailure = null;
    deleteNotice = null;
    choose(f.name);
    onChild(c.name);
    draw();
  };
  return node;
}

// A formation with its children: a formation that has some has the arrow at the left of its row (the one of a project, A-8), and its children under it while it is open.
function item(f: FormationEntry): HTMLDivElement {
  const wrap = tag("div", "formation-item");
  wrap.append(row(f));
  if (f.children.length === 0) return wrap;
  const open = !folded.has(f.name);
  const arrow = tag("button", "icon-btn orca-arrow");
  arrow.type = "button";
  arrow.dataset.arrow = f.name;
  arrow.setAttribute("aria-expanded", String(open));
  arrow.setAttribute("aria-label", open ? "チームメイトを閉じる" : "チームメイトを開く");
  arrow.innerHTML = CHEVRON_SVG;
  arrow.onclick = () => {
    if (!folded.delete(f.name)) folded.add(f.name);
    draw();
  };
  wrap.append(arrow);
  if (open) {
    const list = tag("div", "formation-children");
    list.append(...f.children.map((c) => childRow(f, c)));
    wrap.append(list);
  }
  return wrap;
}

// The mark of the leader's tab in the middle pane: the same state as the row of the shown formation.
function drawLeaderMark() {
  const waiting = formations.find((f) => f.name === current)?.waiting ?? false;
  $("formation-tab-leader").dataset.state = waiting ? "waiting" : "";
  $("formation-tab-leader-mark").hidden = !waiting;
}

// The selector of the control of the list that has the focus, to give it the focus again after a redraw: a formation's row, a child's row or an arrow.
function focusedControl(feed: HTMLElement): string | undefined {
  const el = feed.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  const { formation, childOf, child, arrow } = el?.dataset ?? {};
  if (arrow) return `[data-arrow="${CSS.escape(arrow)}"]`;
  if (childOf && child) return `[data-child-of="${CSS.escape(childOf)}"][data-child="${CSS.escape(child)}"]`;
  if (formation) return `[data-formation="${CSS.escape(formation)}"]`;
  return undefined;
}

function draw() {
  drawLeaderMark();
  const error = deleteFailure ?? failure ?? deleteNotice;
  $("formation-list-error").hidden = error === null;
  $("formation-list-error").textContent = error ?? "";
  const key = JSON.stringify([current, [...deleting], [...folded], formations.map((f) => [f.name, f.projects, f.waiting, f.children.map((c) => [c.name, c.repo, c.branch, c.state])])]);
  if (key === listKey) return;
  listKey = key;
  // The list is drawn again in place: the scroll and the focus stay where they were.
  const feed = $("formation-list-feed");
  const top = feed.scrollTop;
  const focused = focusedControl(feed);
  feed.replaceChildren(...formations.map(item));
  feed.scrollTop = top;
  if (focused) feed.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true });
}

export function initFormationList(changed: (name: string | null) => void, removed: (name: string) => void, child: (name: string) => void) {
  onChange = changed;
  onRemoved = removed;
  onChild = child;
  const plus = $<HTMLButtonElement>("formation-new");
  plus.innerHTML = FORMATION_NEW_SVG;
  plus.onclick = () => openFormationDialog(plus, added);
  draw();
}
