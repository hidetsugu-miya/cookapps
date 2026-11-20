// The tabs and the right pane of the orchestration (A-37). The tabs are in the header of the middle pane: the leader first, then the tabs of the children: 作業中 first and 承認待ち after it (a child that a decision page waits for is one), each in the order `formation_children` gives, and none for a planned one; a done one has a ✓ and a ×, comes last, and has no tab while the chip 「完了 N」 of the flow pane is not pressed, unless a decision page waits for it, #1125). The tab that is selected shows its terminal under the strip: the leader's (formation.ts) or the child's, a terminal of the Orca of the child's environment, streamed when the Orca screen streams that environment (A-12), else mirrored (A-8), as the Orca screen's terminals are.
// The right pane, "流れ", is a column of cards: the leader's card, and under it the children's cards in the same order. A card is a tab's twin: pressing it selects that tab. The cards of the done children are left out until the chip 「完了 N」 of the heading is pressed (#1113), and so are their tabs, with the tab of a decision page of one (#1117); a done child that a decision page waits for is drawn without the chip (#1125).
// A child that has a decision page waiting (`pendingPage`, A-41) has a tab of its own right after its tab, 「判断: {title}」, and its card says 判断待ち with 「開く」. The tab (or 「開く」) shows the page in place of a terminal; the page is read when it is first shown and again when its mark's time changes, and the tab closes when the mark is gone.
// The children of the formation that the list has selected (formation-list.ts) are read every few seconds while it is selected, and the list is read on the same clock; no other formation's children are read. While no formation is selected, only the list is read, at the Orca list's period.
// The pane has two views, 「標準」 (the cards above) and 「コンパクト」 (78px wide: the leader as one orb, one arrow under it, and each child as one orb with its name under it; the card's content comes in a tip while the pointer or the focus is on an orb), switched by the button `#formation-flow-size` of the heading. The one chosen is kept in the page's `localStorage`, so it stays when the app starts again. The compact view also reads `formation_instructed` with each read of the children (#1087): the children that the leader told something and that have not answered are colored and go up under the leader's orb, sliding there.
// 「自動で追う」 is off when a formation is opened, so the middle pane stays on the leader, where the owner types; pressed on, it moves the selection to the child that waits. The terminals have an owner of their own, so that the Orca screen's terminals and these do not take each other.
import type { FormationChild } from "./bindings/FormationChild";
import type { FormationCloseAnswer } from "./bindings/FormationCloseAnswer";
import type { FormationState } from "./bindings/FormationState";
import type { PageAnswer } from "./bindings/PageAnswer";
import type { PageVerdict } from "./bindings/PageVerdict";
import { $, span, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { currentFormation, readList, STATE_LABELS } from "./formation-list.js";
import { drawPage } from "./formation-page.js";
import { confirmChildDelete, confirmChildForce } from "./hint.js";
import { DELETE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { elapsed, shownMs, streamsEnvironment } from "./orca.js";
import { hideTerminals, isShowing, type Placement, releaseTerminal, showTerminals } from "./orca-terminal.js";

const READ_MS = 3000;
// How long an orb takes to slide to its new place in the compact view.
const GLIDE_MS = 450;
// Where the view of the pane is kept: "1" is the compact one, anything else the standard one.
const COMPACT_KEY = "formation-flow-compact";
// The name of the owner of the terminals: what `showTerminals` and `hideTerminals` are told.
const OWNER = "formation-session";
// The environment of this Mac in `FormationChild.environment`; the terminal source calls it null, as the Orca screen's.
const LOCAL = "local";

// The last read; a read that failed keeps it and says why in `failure`.
let children: FormationChild[] = [];
let failure: string | null = null;
// The children that the leader told something and that have not answered (the last read of `formation_instructed`, newest first, #1087). Read only while the compact view is shown; the standard view has none.
let instructed: string[] = [];
// What a close told that is no failure: the branch that Orca kept for the commits no remote has. It stays until the next close or another formation, which a read of the children does not clear.
let notice: string | null = null;
// The children that have a terminal (the last read), the selected tab (the child's name; null is the leader's) and whether 「自動で追う」 is on (off at first and each time a formation is opened, in memory only).
let terms: FormationChild[] = [];
let selected: string | null = null;
let follow = false;
// The formations whose done children's cards and tabs are shown (in memory only, kept apart from the list's, #1113, #1117); they are left out until the chip 「完了 N」 of the heading is pressed.
const doneShown = new Set<string>();
// The child whose decision page the middle pane shows in place of a terminal (null: a terminal does). The selected tab stays as it was under it, and is shown again when the page closes.
let pageChild: string | null = null;
// The child whose row in the list of the formations was pressed (A-37): its tab is selected by the next read that lists it with a terminal, and a read that does not drops it.
let wanted: string | null = null;
// The pages that were read, by the child: the mark's time they were read for, and their element in `#formation-page` (null while the read is on its way, and after a read that failed, which says why in `error`). A page is read only while its tab is shown.
interface PageState {
  atMs: number;
  el: HTMLElement | null;
  error: string | null;
}
const pages = new Map<string, PageState>();
// What the middle pane does when the tab changes between the leader's and a child's: formation.ts shows or hides the leader's terminal.
let onTab: () => void = () => {};
// Whether the leader's tab is the one whose terminal is shown now (undefined: nothing yet), so that a read that changes nothing touches no terminal.
let shownLeader: boolean | undefined;
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
// What the cards and the tabs show now; each is drawn again only when its key changes.
let treeKey = "";
let tabsKey = "";
// Whether the compact view is shown (read from `localStorage` when the screen starts, `initFormationFlow`).
let compact = false;
// The selection whose card and tab were last brought into view (the selection that moved is shown, the one that stays is not scrolled to again).
let scrolledTo: string | null | undefined;

async function read() {
  // A hidden window reads nothing, as the Orca list does; it reads once when it is shown again (initFormationFlow).
  if (document.hidden) return;
  // The list of the formations is read on this clock too, whichever pane is shown.
  void readList();
  if (watching !== "flow" || reading) return;
  reading = true;
  const mine = epoch;
  let picked = false;
  try {
    const name = currentFormation();
    // No formation is selected: there is no child to read.
    const got = name === null ? [] : await invoke("formation_children", { name });
    // The compact view alone shows who was told something; a read of it that fails leaves the children read and says why.
    let told: string[] = [];
    let toldFailure: string | null = null;
    if (compact && name !== null) {
      try {
        told = await invoke("formation_instructed", { name });
      } catch (e) {
        toldFailure = String(e);
      }
    }
    if (mine === epoch) {
      children = got;
      instructed = told;
      failure = toldFailure;
      picked = takeWanted();
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
  // The terminal of the child that the list asked for takes the keyboard, as a press on its tab does.
  if (picked) showSelected(true);
}

// Selects the child that the list asked for when `children` has it with a terminal, and forgets the request either way: a read that does not list it, or lists it with no terminal (a done child whose terminal is gone), leaves the selection as it is. Returns whether it selected one.
function takeWanted(): boolean {
  const name = wanted;
  wanted = null;
  if (name === null || !children.some((c) => c.name === name && c.handle !== null)) return false;
  selected = name;
  pageChild = null;
  follow = false;
  // A done child's tab is drawn only while the chip is pressed, so the row that asked for it presses the chip.
  if (children.some((c) => c.name === name && c.state === "done")) doneShown.add(currentFormation() ?? "");
  return true;
}

// A child's row of the list of the formations was pressed, after its formation was selected: its tab is shown, at once when the children of that formation are read already, else with the read that lists them.
export function showChild(name: string) {
  wanted = name;
  if (watching !== "flow" || children.length === 0) return;
  const picked = takeWanted();
  draw();
  if (picked) showSelected(true);
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
  instructed = [];
  failure = null;
  notice = null;
  terms = [];
  selected = null;
  follow = false;
  pageChild = null;
  wanted = null;
  pages.clear();
  $("formation-page").replaceChildren();
  shownLeader = undefined;
  treeKey = "";
  tabsKey = "";
  scrolledTo = undefined;
  for (const handle of held) releaseTerminal(handle, OWNER);
  held.clear();
  hideTerminals(OWNER);
  hideTip();
  drawRoot();
  draw();
  if (watching === "flow") void read();
}

// The leader's card of the tree has the name of the formation that is shown.
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
  return { id: handle, source: { kind, handle, path: "", environment }, host: $("formation-teammate-term") };
}

// Shows the terminal of the selected tab and hides the others (their reads stop): a child's under the strip, or the leader's, which formation.ts shows (`onTab`). `focus` gives it the keyboard: only a press of the user does, never the follow, so the leader's terminal keeps the keys the owner is typing.
// The leader's terminal is hidden before a child's is placed and shown after the child's is hidden, so that the two never share the height of the pane; and it is not asked for while the screen is being shown (formation.ts shows it then).
function showSelected(focus: boolean) {
  const host = $("formation-teammate-term");
  // A decision page takes the place of the terminals, the leader's too.
  const child = pageChild === null ? terms.find((c) => c.name === selected) : undefined;
  if (!child && pageChild === null) {
    host.hidden = true;
    hideTerminals(OWNER);
    const changed = shownLeader === false;
    shownLeader = true;
    if (changed) onTab();
    return;
  }
  const changed = shownLeader !== false;
  shownLeader = false;
  if (changed) onTab();
  if (!child) {
    host.hidden = true;
    hideTerminals(OWNER);
    return;
  }
  host.hidden = false;
  const placement = placementOf(child);
  if (!isShowing(placement, OWNER) || focus) showTerminals([placement], focus ? placement.id : null, OWNER);
  held.add(placement.id);
}

const hasPage = (name: string) => children.some((c) => c.name === name && c.pendingPage !== null);

// Reads the page of `name` for the mark of the time `atMs` and puts it in the pane, hidden until its tab is shown (`syncPages`); a read that failed shows the violations or the reason in its place.
async function loadPage(formation: string, name: string, atMs: number) {
  const state: PageState = { atMs, el: null, error: null };
  pages.set(name, state);
  try {
    const page = await invoke("formation_page_read", { name: formation, child: name });
    if (pages.get(name) !== state) return;
    state.el = drawPage(page, formation, name, atMs, (answers, verdict, revision) => answerPage(formation, name, atMs, answers, verdict, revision));
  } catch (e) {
    if (pages.get(name) !== state) return;
    state.error = String(e);
    state.el = tag("p", "fp-error pending fail", state.error);
    state.el.setAttribute("role", "alert");
  }
  state.el.hidden = name !== pageChild;
  $("formation-page").append(state.el);
  draw();
}

// Sends the answers of the page of `name` (drawn for the mark's time `atMs`) to the leader (#923). A failure goes back to the page, which stays. After a send that went through the mark is gone from the child at once (the tab closes, the card is as it was), and a read that began before the send, which still has the mark, is dropped.
async function answerPage(formation: string, name: string, atMs: number, answers: PageAnswer[], verdict: PageVerdict | null, revision: string) {
  await invoke("formation_page_answer", { name: formation, child: name, atMs, answers, verdict, revision });
  // Another formation is shown now: its children are read when it is shown again.
  if (currentFormation() !== formation) return;
  children = children.map((c) => (c.name === name ? { ...c, pendingPage: null } : c));
  epoch++;
  draw();
  if (watching === "flow") void read();
}

// The pages follow the marks: a page whose mark is gone or whose time changed is forgotten, and the page of the selected tab is read when it is not held. The pane shows the page of the selected tab alone.
function syncPages() {
  for (const [name, state] of [...pages]) {
    if (state.atMs !== children.find((c) => c.name === name)?.pendingPage?.atMs) dropPage(name);
  }
  const mark = pageChild === null ? null : (children.find((c) => c.name === pageChild)?.pendingPage ?? null);
  const formation = currentFormation();
  if (pageChild !== null && mark !== null && formation !== null && !pages.has(pageChild)) void loadPage(formation, pageChild, mark.atMs);
  $("formation-page").hidden = pageChild === null;
  for (const [name, state] of pages) if (state.el) state.el.hidden = name !== pageChild;
}

// Whether the selected tab is the leader's.
export const isLeaderTab = () => selected === null && pageChild === null;

// formation.ts tells what to do when the tab changes between the leader's and a child's.
export function onTabChange(fn: () => void) {
  onTab = fn;
}

// The children of a read: the terminals follow them, the selection follows the waiting child while 「自動で追う」 is on, and the terminals of the children that are gone are forgotten. A selected child that is gone from the terminals leaves the selection at the leader's tab.
function syncSelection() {
  terms = children.filter((c) => c.handle !== null);
  // The page whose mark is gone (it was answered, or replaced and read again) closes: the tab that was selected before is shown again.
  if (pageChild !== null && !hasPage(pageChild)) pageChild = null;
  if (follow) selected = followTarget(terms, selected) ?? selected;
  if (selected !== null && !terms.some((c) => c.name === selected)) selected = null;
  // A child whose tab is left out (a planned one, or a done one while the chip is not pressed) is not the selection: the leader's tab is. Its page tab goes with it.
  const left = (name: string) => children.some((c) => c.name === name && !isTabShown(c));
  if (selected !== null && left(selected)) selected = null;
  if (pageChild !== null && left(pageChild)) pageChild = null;
  const handles = new Set(terms.map((c) => c.handle));
  for (const handle of held) {
    if (handles.has(handle)) continue;
    held.delete(handle);
    releaseTerminal(handle, OWNER);
  }
  showSelected(false);
}

// Asks before the child is closed: the same confirmation for the menu of a card and for the × of a done child's tab and card (it is anchored on the name, which a redraw does not touch while it is open).
function askClose(c: FormationChild, anchor: Element) {
  const formation = currentFormation();
  if (formation === null || closing.has(closingKey(formation, c.name))) return;
  confirmChildDelete(anchor, c.name, c.created, () => void closeChild(formation, c.name, false, null));
}

// The menu of a right press on a card: 「削除」 alone, as a row of the list has (formation-list.ts).
function openCardMenu(c: FormationChild, anchor: Element, e: MouseEvent) {
  e.preventDefault();
  const formation = currentFormation();
  if (formation === null || closing.has(closingKey(formation, c.name))) return;
  openMenu(anchor, [{ label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, pick: () => askClose(c, anchor) }], { at: { x: e.clientX, y: e.clientY } });
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
    // The child is gone from the tabs and from the cards at once (its terminal is let go), and a read that began before the close, which still lists it, is dropped.
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

// A press of the user on a tab or a card selects that child and turns 「自動で追う」 off. A child with no terminal is not selected.
function selectChild(name: string) {
  if (!terms.some((c) => c.name === name)) return;
  selected = name;
  pageChild = null;
  follow = false;
  draw();
  showSelected(true);
}

// A press of the user on a page's tab or on 「開く」: the page of that child is shown in place of the terminal, and 「自動で追う」 is turned off. A page whose read failed is read again.
function selectPage(name: string) {
  if (!children.some((c) => c.name === name && c.pendingPage !== null)) return;
  if (pages.get(name)?.error) dropPage(name);
  pageChild = name;
  follow = false;
  draw();
}

// What a page held is forgotten: its element goes out of the pane.
function dropPage(name: string) {
  pages.get(name)?.el?.remove();
  pages.delete(name);
}

// A press of the user on the leader's tab or card: the leader's terminal is shown (and takes the keyboard), and 「自動で追う」 is turned off.
function selectLeader() {
  selected = null;
  pageChild = null;
  follow = false;
  draw();
}

// The formation is deselected or the screen is left: the child's terminal is hidden and its reads stop, and the next show places the tab's terminal anew.
export function hideSession() {
  hideTerminals(OWNER);
  shownLeader = undefined;
}

// What the card of a child with a decision page says in place of its state (it looks as an approval that waits does).
const PAGE_LABEL = "判断待ち";
// Whether the tab or the card of `name` is the one that shows its terminal now.
const viewing = (name: string) => pageChild === null && selected === name;

// The attribute selector of the control that has the focus, to give it the focus again after a redraw.
function focusSelector(el: HTMLElement | null): string | undefined {
  for (const key of ["child", "page", "open", "orb"]) {
    const value = el?.dataset[key];
    if (value) return `[data-${key}="${CSS.escape(value)}"]`;
  }
  return undefined;
}

const MARKS: Record<FormationState, string> = { working: "◐", waiting: "●", done: "✓", planned: "○" };

// What a card says of a child, in its two rows: the name (with the agent of a Codex one and the time) and the state (with the last words, or the title of its decision page). The tip of an orb of the compact view says the same.
function cardRows(c: FormationChild, now: number) {
  const page = c.pendingPage;
  const planned = c.state === "planned";
  const row = span("formation-card-row", "");
  const name = span("formation-card-name", c.name);
  row.append(name);
  if (c.agent === "codex") row.append(span("formation-card-agent", c.agent));
  const time = planned ? "" : elapsed(c.atMs, now, c.state === "done");
  if (time !== "") row.append(tag("time", "formation-card-time", time));
  const line = span("formation-card-row", "");
  const label = span("formation-card-state", page === null ? STATE_LABELS[c.state] : PAGE_LABEL);
  label.prepend(tag("i", "formation-dot"));
  line.append(label);
  const msg = page === null ? c.reply : page.title;
  if (!planned && msg) line.append(span("formation-card-msg", msg));
  return { row, line, name };
}

function card(c: FormationChild, now: number): HTMLLIElement {
  const li = tag("li");
  const page = c.pendingPage;
  const state = page === null ? c.state : "waiting";
  li.dataset.state = state;
  li.dataset.name = c.name;
  const planned = c.state === "planned";
  const node = planned ? tag("div", "formation-card") : tag("button", "formation-card");
  node.dataset.state = state;
  if (page !== null) node.dataset.page = "true";
  const { row, line, name } = cardRows(c, now);
  node.append(row, line);
  // The menu and its confirmation are anchored on the name, which a redraw of the card does not touch while they are open.
  node.oncontextmenu = (e) => openCardMenu(c, name, e);
  if (closing.has(closingKey(currentFormation() ?? "", c.name))) node.setAttribute("aria-busy", "true");
  if (node instanceof HTMLButtonElement) {
    node.type = "button";
    node.dataset.child = c.name;
    node.setAttribute("aria-pressed", String(viewing(c.name)));
    node.onclick = () => selectChild(c.name);
  }
  li.append(node);
  if (page !== null) li.append(openButton(c.name));
  if (c.state === "done") li.append(closeButton(c, name, "formation-card-close"));
  return li;
}

// The children that are told something and have not answered (and are not done): the orbs that are colored and that go up.
const isInstructed = (c: FormationChild) => c.state !== "done" && instructed.includes(c.name);

// The order of the orbs of the compact view; the one place that decides it: the children that were told something first, the newest instruction first (the order of `instructed`), and under them the others in the order of the cards (`flowOrder`).
const compactOrder = (list: FormationChild[]): FormationChild[] => {
  const told = instructed.flatMap((name) => list.filter((c) => c.name === name && isInstructed(c)));
  return [...told, ...flowOrder(list.filter((c) => !told.includes(c)))];
};

// The orb of a child in the compact view: a circle with the first letter of its name, framed in the color of its state (a Codex child's has the blue ground and the tag 「cx」), and its name under it. It selects the child as its card does, and the card's content is its tip.
function orb(c: FormationChild): HTMLLIElement {
  const li = tag("li");
  const page = c.pendingPage;
  const planned = c.state === "planned";
  const node = planned ? tag("div", "formation-orb") : tag("button", "formation-orb");
  node.dataset.state = page === null ? c.state : "waiting";
  node.dataset.orb = c.name;
  if (page !== null) node.dataset.page = "true";
  if (isInstructed(c)) node.dataset.instructed = "true";
  const codex = c.agent === "codex";
  if (codex) node.dataset.agent = c.agent;
  node.setAttribute("aria-label", codex ? `${c.name} (${c.agent})` : c.name);
  const dot = span("formation-orb-dot", [...c.name][0]?.toUpperCase() ?? "");
  if (codex) dot.append(span("formation-orb-cx", "cx"));
  const name = span("formation-orb-name", c.name);
  node.append(dot, name);
  node.oncontextmenu = (e) => openCardMenu(c, name, e);
  node.onmouseenter = () => showChildTip(c, node);
  node.onmouseleave = hideTip;
  if (closing.has(closingKey(currentFormation() ?? "", c.name))) node.setAttribute("aria-busy", "true");
  if (node instanceof HTMLButtonElement) {
    node.type = "button";
    node.setAttribute("aria-pressed", String(viewing(c.name)));
    node.onclick = () => selectChild(c.name);
    node.onfocus = () => showChildTip(c, node);
    node.onblur = hideTip;
  }
  li.append(node);
  return li;
}

// The tip of an orb: the card's two rows in a card, beside the orb. It is one element outside the scrolling body, so that the body does not cut it.
function showTip(content: HTMLElement, anchor: Element) {
  const tip = $("formation-flow-tip");
  tip.replaceChildren(content);
  tip.hidden = false;
  const at = anchor.getBoundingClientRect();
  const high = tip.offsetHeight;
  tip.style.right = `${window.innerWidth - at.left + 8}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - high - 8, at.top + at.height / 2 - high / 2))}px`;
}

function hideTip() {
  const tip = $("formation-flow-tip");
  tip.hidden = true;
  tip.replaceChildren();
}

function showChildTip(c: FormationChild, anchor: Element) {
  const shown = tag("div", "formation-card");
  shown.dataset.state = c.pendingPage === null ? c.state : "waiting";
  if (c.pendingPage !== null) shown.dataset.page = "true";
  const { row, line } = cardRows(c, Date.now());
  shown.append(row, line);
  showTip(shown, anchor);
}

// The tip of the leader's orb: its card, with the name of the formation and the tag 「リーダー」.
function showLeaderTip() {
  const shown = tag("div", "formation-card");
  const row = span("formation-card-row", "");
  row.append(span("formation-card-name", currentFormation() ?? ""), span("formation-card-role", "リーダー"));
  shown.append(row);
  showTip(shown, $("formation-flow-leader"));
}

// 「開く」 of a card that has a decision page: it shows the page. It sits beside the card, not in it, because a button does not hold a button.
function openButton(name: string): HTMLButtonElement {
  const button = tag("button", "formation-card-open", "開く");
  button.type = "button";
  button.dataset.open = name;
  button.setAttribute("aria-pressed", String(pageChild === name));
  button.onclick = () => selectPage(name);
  return button;
}

// The × of a done child: the same close as 「削除」 of the menu of its card.
function closeButton(c: FormationChild, anchor: Element, className: string): HTMLButtonElement {
  const button = tag("button", className, "×");
  button.type = "button";
  button.dataset.close = c.name;
  button.setAttribute("aria-label", `${c.name} を閉じる`);
  button.onclick = () => askClose(c, anchor);
  return button;
}

// The tab of a child: the mark of its state and its name, and the tag 「codex」 for a Codex child; a done one has a × too. Only a child with a terminal is a button; a done one whose terminal is gone is shown and not pressed.
function tab(c: FormationChild): HTMLSpanElement {
  const wrap = tag("span", "formation-tab");
  wrap.dataset.state = c.state;
  wrap.dataset.name = c.name;
  const mark = span("formation-tab-mark", MARKS[c.state]);
  mark.setAttribute("aria-hidden", "true");
  const name = span("formation-tab-name", c.name);
  const label = c.agent === "codex" ? [mark, name, span("formation-tab-effort", c.agent)] : [mark, name];
  if (c.handle !== null) {
    const main = tag("button", "formation-tab-main");
    main.type = "button";
    main.setAttribute("role", "tab");
    main.setAttribute("aria-selected", String(viewing(c.name)));
    main.dataset.child = c.name;
    main.onclick = () => selectChild(c.name);
    main.append(...label);
    wrap.append(main);
  } else {
    const main = tag("span", "formation-tab-main");
    main.append(...label);
    wrap.append(main);
  }
  if (closing.has(closingKey(currentFormation() ?? "", c.name))) wrap.setAttribute("aria-busy", "true");
  if (c.state === "done") wrap.append(closeButton(c, name, "formation-tab-close"));
  return wrap;
}

// The tab of the decision page of a child: the mark that waits and 「判断: {title}」, right after the child's tab.
function pageTab(c: FormationChild): HTMLSpanElement {
  const wrap = tag("span", "formation-tab formation-tab-page");
  wrap.dataset.state = "waiting";
  wrap.dataset.pageOf = c.name;
  const main = tag("button", "formation-tab-main");
  main.type = "button";
  main.setAttribute("role", "tab");
  main.setAttribute("aria-selected", String(pageChild === c.name));
  main.dataset.page = c.name;
  main.onclick = () => selectPage(c.name);
  const mark = span("formation-tab-mark", MARKS.waiting);
  mark.setAttribute("aria-hidden", "true");
  main.append(mark, span("formation-tab-name", `判断: ${c.pendingPage!.title}`));
  wrap.append(main);
  return wrap;
}

// The tabs of the children, drawn again in place only when what they show changed; the leader's tab is always there.
function drawTabs() {
  $("formation-tab-leader-main").setAttribute("aria-selected", String(selected === null && pageChild === null));
  const shown = flowOrder(children.filter(isTabShown));
  const key = JSON.stringify([selected, pageChild, [...closing], shown.map((c) => [c.name, c.state, c.handle !== null, c.agent, c.pendingPage?.title ?? null])]);
  if (key === tabsKey) return;
  tabsKey = key;
  const box = $("formation-tabs-mates");
  const focused = focusSelector(box.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null);
  box.replaceChildren(...shown.flatMap((c) => (c.pendingPage === null ? [tab(c)] : [tab(c), pageTab(c)])));
  if (focused) box.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true });
}

const showDone = () => doneShown.has(currentFormation() ?? "");

// The order of the cards, the orbs and the tabs, the one place that decides it: 作業中 first, then 承認待ち (a child that a decision page waits for is one too), then 予定, then the done ones that are shown; the order of the read stays inside each.
const flowRank = (c: FormationChild) => (c.pendingPage !== null ? 1 : c.state === "working" ? 0 : c.state === "waiting" ? 1 : c.state === "planned" ? 2 : 3);
function flowOrder(list: FormationChild[]): FormationChild[] {
  return list.map((c, i) => ({ c, i })).sort((a, b) => flowRank(a.c) - flowRank(b.c) || a.i - b.i).map(({ c }) => c);
}

// The tabs of the children, in `flowOrder`. A planned child has no tab.
const isTabShown = (c: FormationChild) => c.state !== "planned" && isShown(c);

// Whether the card and the tab of `c` are drawn: a done child's only while the chip 「完了 N」 is pressed, unless a decision page waits for the owner (#1125).
const isShown = (c: FormationChild) => c.state !== "done" || c.pendingPage !== null || showDone();

// The chip 「完了 N」 in the heading: none while no child is done; pressed, the cards and the tabs of the done children are shown.
function drawDoneChip() {
  const chip = $("formation-flow-done");
  // Only the done children that the chip leaves out: one that a decision page waits for is drawn without it.
  const done = children.filter((c) => c.state === "done" && c.pendingPage === null).length;
  chip.hidden = done === 0;
  // The compact view has the room of a short chip: the mark and the number, with the words as its name.
  chip.textContent = compact ? `✓${done}` : `完了 ${done}`;
  if (compact) chip.setAttribute("aria-label", `完了 ${done}`);
  else chip.removeAttribute("aria-label");
  chip.setAttribute("aria-pressed", String(showDone()));
}

function draw() {
  const now = Date.now();
  if (watching === "list") return;
  // The selection first: the follow may move it, and the tabs and the cards mark it.
  if (watching === "flow") syncSelection();
  syncPages();
  drawTabs();
  $("formation-follow").setAttribute("aria-pressed", String(follow));
  $("formation-flow-root").setAttribute("aria-pressed", String(selected === null && pageChild === null));
  $("formation-flow-leader").setAttribute("aria-pressed", String(selected === null && pageChild === null));
  $("formation-flow").dataset.compact = String(compact);
  $("formation-flow-size").setAttribute("aria-pressed", String(compact));
  $("formation-flow-root").hidden = compact;
  $("formation-flow-list").hidden = compact;
  $("formation-flow-compact").hidden = !compact;
  const said = failure ?? notice;
  $("formation-flow-error").hidden = said === null;
  $("formation-flow-error").textContent = said ?? "";
  drawDoneChip();
  const key = JSON.stringify([compact, selected, pageChild, [...closing], showDone(), children.map((c) => [c.name, c.state, c.state === "planned" ? "" : elapsed(c.atMs, now, c.state === "done"), c.reply, c.pendingPage?.title ?? null]), instructed]);
  if (key === treeKey) return;
  treeKey = key;
  // The cards are drawn again in place: the scroll and the focus stay where they were.
  const body = $("formation-flow-body");
  const top = body.scrollTop;
  const list = $("formation-flow-list");
  const orbs = $("formation-flow-orbs");
  const box = compact ? orbs : list;
  const focused = focusSelector(body.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null);
  const shown = children.filter(isShown);
  const before = compact ? orbTops() : new Map<string, number>();
  hideTip();
  if (compact) {
    list.replaceChildren();
    orbs.replaceChildren(...compactOrder(shown).map(orb));
  } else {
    orbs.replaceChildren();
    list.replaceChildren(...flowOrder(shown).map((c) => card(c, now)));
  }
  $("formation-flow-arrow").toggleAttribute("hidden", shown.length === 0);
  body.scrollTop = top;
  if (compact) glide(before);
  if (focused) box.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true });
  // A selection that moved (the follow moves it too) is brought into the view of the cards and the tabs; the focus stays where it was.
  const view = pageChild === null ? selected : `page:${pageChild}`;
  if (view !== scrolledTo) {
    scrolledTo = view;
    box.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
    $("formation-tabs").querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }
}

// Where each orb of the compact view is now (the top of its `li`, by the child's name), to slide the orbs from there when they are drawn again in another order.
function orbTops(): Map<string, number> {
  const tops = new Map<string, number>();
  for (const orb of $("formation-flow-orbs").querySelectorAll<HTMLElement>("[data-orb]")) tops.set(orb.dataset.orb!, orb.parentElement!.getBoundingClientRect().top);
  return tops;
}

// The orbs that moved slide from where they were to where they are (FLIP); an orb that is new, or that did not move, does not. The slide is left out while the system asks for less motion.
function glide(before: Map<string, number>) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const orb of $("formation-flow-orbs").querySelectorAll<HTMLElement>("[data-orb]")) {
    const from = before.get(orb.dataset.orb!);
    if (from === undefined) continue;
    const li = orb.parentElement!;
    const moved = from - li.getBoundingClientRect().top;
    if (moved !== 0) li.animate([{ transform: `translateY(${moved}px)` }, { transform: "translateY(0)" }], { duration: GLIDE_MS, easing: "ease-out" });
  }
}

// Whether the compact view was chosen last time; a storage that cannot be read gives the standard view.
function readCompact(): boolean {
  try {
    return localStorage.getItem(COMPACT_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCompact() {
  try {
    localStorage.setItem(COMPACT_KEY, compact ? "1" : "0");
  } catch {
    // The view stays as chosen until the app ends.
  }
}

export function initFormationFlow() {
  compact = readCompact();
  $("formation-tab-leader-main").onclick = selectLeader;
  $("formation-flow-root").onclick = selectLeader;
  const leader = $("formation-flow-leader");
  leader.onclick = selectLeader;
  leader.onmouseenter = showLeaderTip;
  leader.onmouseleave = hideTip;
  leader.onfocus = showLeaderTip;
  leader.onblur = hideTip;
  $("formation-flow-size").onclick = () => {
    compact = !compact;
    saveCompact();
    // The compact view reads who was told something, and the standard view forgets it.
    if (!compact) instructed = [];
    draw();
    if (compact && watching === "flow") void read();
  };
  $("formation-flow-done").onclick = () => {
    const formation = currentFormation() ?? "";
    if (!doneShown.delete(formation)) doneShown.add(formation);
    draw();
  };
  $("formation-follow").onclick = () => {
    follow = !follow;
    // Pressed on, it moves to the child that waits: a page that is shown gives way.
    if (follow) pageChild = null;
    draw();
  };
  drawRoot();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && watching !== null) void read();
  });
  draw();
}
