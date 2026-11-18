// The right pane of the orchestration, "チームメイト" (A-37): above, the view of the flow (the orchestrator's card and under it the children as small cards in the order `formation_children` gives), and below, the session of the selected child, a terminal of the Orca of the child's environment: streamed when the Orca screen streams that environment (A-12), else mirrored (A-8), as the Orca screen's terminals are.
// The children of the formation that the list has selected (formation-list.ts) are read every few seconds while it is selected, and the list is read on the same clock; no other formation's children are read. While no formation is selected, only the list is read, at the Orca list's period.
// The pane is opened and closed with the button of its heading (open at first, in memory only); closed, a strip of 40px stays at the right end with the button that opens it and a mark for the state of each child, and the terminal of the session is hidden (its reads stop).
// The cards are the tabs: the card of a child that has a terminal selects it, and 「自動で追う」 moves the selection to the child that waits. The terminals have an owner of their own, so that the Orca screen's terminals and these do not take each other.
import type { FormationChild } from "./bindings/FormationChild";
import type { FormationCloseAnswer } from "./bindings/FormationCloseAnswer";
import { $, span, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { currentFormation, readList, STATE_LABELS } from "./formation-list.js";
import { confirmChildDelete, confirmChildForce } from "./hint.js";
import { DELETE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { elapsed, shownMs, streamsEnvironment } from "./orca.js";
import { hideTerminals, isShowing, type Placement, releaseTerminal, showTerminals } from "./orca-terminal.js";

const READ_MS = 3000;
// The name of the owner of the terminals: what `showTerminals` and `hideTerminals` are told.
const OWNER = "formation-session";
// The environment of this Mac in `FormationChild.environment`; the terminal source calls it null, as the Orca screen's.
const LOCAL = "local";

// The last read; a read that failed keeps it and says why in `failure`.
let children: FormationChild[] = [];
let failure: string | null = null;
// What a close told that is no failure: the branch that Orca kept for the commits no remote has. It stays until the next close or another formation, which a read of the children does not clear.
let notice: string | null = null;
// The children that have a terminal (the last read), the selected child (its name) and whether 「自動で追う」 is on (on at first, in memory only).
let terms: FormationChild[] = [];
let selected: string | null = null;
let follow = true;
// Whether the pane is open (in memory only).
let open = true;
// The handles whose terminals were shown, to forget the ones of children that are gone.
const held = new Set<string>();
// The children whose close is on its way, by the formation and the name (`closingKey`); a second close of one is not started meanwhile.
const closing = new Set<string>();
const closingKey = (formation: string, name: string) => `${formation}\n${name}`;
// The clock of the reads and what the reads are for (the pane, or the list only), and whether one is on its way (the next tick waits for it).
let timer: number | null = null;
let watching: "flow" | "list" | null = null;
let reading = false;
// Counts the switches of the formation, so that a read that was on its way when the formation changed is dropped.
let epoch = 0;
// What the tree shows now, and what the session band and the marks of the strip show now; each is drawn again only when its key changes.
let treeKey = "";
let marksKey = "";
let sessionKey: string | null = "";
// The child whose card was last brought into the view of the tree (the selection that moved is shown, the one that stays is not scrolled to again).
let scrolledTo: string | null = null;

async function read() {
  // A hidden window reads nothing, as the Orca list does; it reads once when it is shown again (initFormationFlow).
  if (document.hidden) return;
  // The list of the formations is read on this clock too, whichever pane is shown.
  void readList();
  if (watching !== "flow" || reading) return;
  reading = true;
  const mine = epoch;
  try {
    const name = currentFormation();
    // No formation is selected: there is no child to read.
    const got = name === null ? [] : await invoke("formation_children", { name });
    if (mine === epoch) {
      children = got;
      failure = null;
    }
  } catch (e) {
    if (mine === epoch) failure = String(e);
  } finally {
    reading = false;
  }
  // The formation changed while this read ran: its answer is dropped, and the new formation is read now (one read at a time, so a repeated switch never runs the reads side by side).
  if (mine !== epoch) {
    if (watching === "flow") void read();
    return;
  }
  draw();
}

// Reads now and then by the clock, for `next`; one clock at a time, so the two ways never read together.
function watch(next: "flow" | "list", ms: number) {
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
  children = [];
  failure = null;
  notice = null;
  terms = [];
  selected = null;
  sessionKey = null;
  treeKey = "";
  marksKey = "";
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
  $("formation-flow-root").querySelector(".formation-card-name")!.textContent = currentFormation() ?? "";
}

// A formation is selected on the development screen.
export const startFlow = () => watch("flow", periodMs("formationFlow", READ_MS));

// No formation is selected on the development screen: only the list is read, at the period of the Orca list's read.
export const startList = () => watch("list", shownMs());

// The screen is left: nothing is read until it is shown again.
export function stopFlow() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  watching = null;
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
  // A saved environment that the Orca screen streams (A-12) streams the terminal, with its colors and the size of the pane; this Mac's Orca cannot stream, and a saved environment that is not streamed is mirrored, as the Orca screen's are.
  const kind = environment !== null && streamsEnvironment(environment) ? "stream" : "mirror";
  return { id: handle, source: { kind, handle, path: "", environment }, host: $("formation-child-term") };
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
  // A closed pane has no room for the terminal: it is shown again when the pane is opened.
  if (open) showSelected(false);
}

// The menu of a right press on a card: 「削除」 alone, as a row of the list has (formation-list.ts).
function openCardMenu(c: FormationChild, anchor: Element, e: MouseEvent) {
  e.preventDefault();
  const formation = currentFormation();
  if (formation === null || closing.has(closingKey(formation, c.name))) return;
  openMenu(anchor, [{ label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, pick: () => confirmChildDelete(anchor, c.name, c.created, () => void closeChild(formation, c.name, false, null)) }], { at: { x: e.clientX, y: e.clientY } });
}

// Closes the child `name` of `formation` (A-37). Without `force` a worktree that has something to lose is kept, and the answer asks the owner to force it; with it (`path`: where the worktree was shown to be) the worktree goes all the same, and only when Rust finds the child at that path. An error shows as a failed read does, and so does the branch that Orca kept (`notice`).
async function closeChild(formation: string, name: string, force: boolean, path: string | null) {
  const key = closingKey(formation, name);
  if (closing.has(key)) return;
  closing.add(key);
  draw();
  let error: string | null = null;
  let kept: FormationCloseAnswer | null = null;
  let closed = false;
  let preserved: string | null = null;
  try {
    const answer = await invoke("formation_close_child", { formation, name, force, path });
    closed = answer.closed;
    if (!closed) kept = answer;
    preserved = answer.preservedBranch;
  } catch (e) {
    error = String(e);
  } finally {
    closing.delete(key);
  }
  // Another formation is shown now: what this one answered is not drawn (its children are read when it is shown again).
  if (currentFormation() !== formation) return draw();
  if (error !== null) failure = error;
  notice = closed && preserved !== null ? `「${name}」のブランチは、どのリモートにもないコミットがあるので、ローカルに残しました（${preserved}）。` : null;
  if (closed) {
    // The child is gone from the pane and from the session at once (the session lets its terminal go), and a read that began before the close, which still lists it, is dropped.
    children = children.filter((c) => c.name !== name);
    failure = null;
    epoch++;
  }
  draw();
  if (closed && watching === "flow") void read();
  if (kept) {
    const anchor = $("formation-flow-list").querySelector(`[data-name="${CSS.escape(name)}"] .formation-card-name`) ?? $("formation-flow-list");
    confirmChildForce(anchor, name, kept, () => void closeChild(formation, name, true, kept.path));
  }
}

// A press of the user on a card selects that child and turns 「自動で追う」 off. A child with no terminal is not selected.
function selectChild(name: string) {
  if (!terms.some((c) => c.name === name)) return;
  selected = name;
  follow = false;
  draw();
  showSelected(true);
}

// The formation is deselected or the screen is left: the terminal is hidden and its reads stop.
export function hideSession() {
  hideTerminals(OWNER);
}

function card(c: FormationChild, now: number): HTMLLIElement {
  const li = tag("li");
  li.dataset.state = c.state;
  li.dataset.name = c.name;
  const planned = c.state === "planned";
  const node = planned ? tag("div", "formation-card") : tag("button", "formation-card");
  node.dataset.state = c.state;
  const row = span("formation-card-row", "");
  const name = span("formation-card-name", c.name);
  row.append(name);
  const time = planned ? "" : elapsed(c.atMs, now, c.state === "done");
  if (time !== "") row.append(tag("time", "formation-card-time", time));
  const line = span("formation-card-row", "");
  const state = span("formation-card-state", STATE_LABELS[c.state]);
  state.prepend(tag("i", "formation-dot"));
  line.append(state);
  if (!planned && c.reply) line.append(span("formation-card-msg", c.reply));
  node.append(row, line);
  // The menu and its confirmation are anchored on the name, which a redraw of the card does not touch while they are open.
  node.oncontextmenu = (e) => openCardMenu(c, name, e);
  if (closing.has(closingKey(currentFormation() ?? "", c.name))) node.setAttribute("aria-busy", "true");
  if (node instanceof HTMLButtonElement) {
    node.type = "button";
    node.dataset.child = c.name;
    node.setAttribute("aria-pressed", String(selected === c.name));
    node.onclick = () => selectChild(c.name);
  }
  li.append(node);
  return li;
}

// The strip of the closed pane: the label of the button that opens it says how many children work and wait for approval and how many are planned, and under it a mark for each child, in the order of the cards, with the dot of its state.
function drawStrip(planned: number) {
  const working = children.filter((c) => c.state === "working").length;
  const waiting = children.filter((c) => c.state === "waiting").length;
  $("formation-strip-open").setAttribute("aria-label", `チームメイトを開く（作業中 ${working}${waiting > 0 ? ` · 承認待ち ${waiting}` : ""} · 予定 ${planned}）`);
  const key = JSON.stringify(children.map((c) => [c.name, c.state]));
  if (key === marksKey) return;
  marksKey = key;
  $("formation-strip-marks").replaceChildren(
    ...children.map((c) => {
      const mark = tag("span", "formation-strip-mark");
      mark.dataset.state = c.state;
      mark.dataset.name = c.name;
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", `${c.name}（${STATE_LABELS[c.state]}）`);
      mark.append(tag("i", "formation-dot"));
      return mark;
    }),
  );
}

// Closes or opens the pane. The focus moves to the button that takes the place of the one pressed, and an opened pane shows the terminal of its session again.
function setOpen(next: boolean) {
  open = next;
  if (!open) hideTerminals(OWNER);
  marksKey = "";
  $("formation-flow-toggle").setAttribute("aria-expanded", String(open));
  draw();
  $(open ? "formation-flow-toggle" : "formation-strip-open").focus({ preventScroll: true });
}

function draw() {
  const now = Date.now();
  if (watching === "list") return;
  const launched = children.filter((c) => c.state !== "planned");
  const planned = children.length - launched.length;
  // The pane is shown from the first child (a planned one too) on, and the orchestrator has the whole width before. Closed, the strip is shown in its place and the divider is not.
  const any = children.length > 0;
  $("formation-flow").hidden = !any || !open;
  $("formation-flow-split").hidden = !any || !open;
  $("formation-strip").hidden = !any || open;
  // The session first: the follow may move the selection that the cards mark.
  if (watching === "flow") syncSession();
  $("formation-follow").setAttribute("aria-pressed", String(follow));
  $("formation-flow-count").textContent = `子 ${launched.length}${planned > 0 ? ` · 予定 ${planned}` : ""}`;
  if (!open) drawStrip(planned);
  const said = failure ?? notice;
  $("formation-flow-error").hidden = said === null;
  $("formation-flow-error").textContent = said ?? "";
  const key = JSON.stringify([selected, [...closing], children.map((c) => [c.name, c.state, c.state === "planned" ? "" : elapsed(c.atMs, now, c.state === "done"), c.reply])]);
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
  $("formation-flow-toggle").onclick = () => setOpen(false);
  $("formation-strip-open").onclick = () => setOpen(true);
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
