// The Orca screen (A-6, A-7): two panes. The list pane has the Claude agents that run in Orca, in three groups (waiting for the user, working, done); the work pane has the history of the selected one (orca-chat.ts) and a composer that posts to it,
// or, with none selected, the start of a new session. Nothing about a session is kept here.
// The list is read at startup for the sidebar button's count, every 10 seconds while the screen is shown and every 60 seconds otherwise, one read at a time, and no more once the `orca` command was found missing (the update button reads again).
// Only the first read, the screen being shown, the update button, a change of the target and a read after a failure ask for the environments; the clock reads the agents (the screen shown) or only their count (another screen).
// A read in the background swaps the rows in place: the selection, the text in the composer and the scroll position stay, and `show()` is never called by it.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaRow } from "./bindings/OrcaRow";
import type { OrcaSkill } from "./bindings/OrcaSkill";
import { $, composing, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { closeMenu, openMenu, showMenu } from "./menu.js";
import { currentScreen } from "./nav.js";
import { closeChat, initOrcaChat, openChat, setChatWorking } from "./orca-chat.js";
import { initSplit } from "./split.js";
import { setNavCount, show, showError } from "./view.js";

const STATE_LABELS = { waiting: "入力待ち", working: "作業中", done: "完了" } as const;
const THIS_MACHINE = "このマシン";
const SHOWN_MS = 10_000;
const HIDDEN_MS = 60_000;

// The last read, or null before the first. A failed read keeps the rows and worktrees of the one before it while the target is the same.
let view: OrcaOverview | null = null;
// How much a read asks for (see `orca_overview`).
type Scope = "full" | "screen" | "badge";
// The agents that wait or run, for the sidebar button: the rows held, or what a read for the count alone found.
let badge = 0;
// The target was just changed and the first read of the new one has not come back: nothing is said about it yet.
let switching = false;
// Reads: the latest request is the one used; one is on its way; when the last one started.
let loadSeq = 0;
let loading = false;
let lastTry = 0;
// The pane key of the selected row (null: the new-session pane shows), the worktree (its path) a new launch uses, and a post on its way.
let selected: string | null = null;
let newPath: string | null = null;
let busy = false;
// The session whose history is open (target, path and pane key), null when none is.
let chatKey: string | null = null;
// The skills of Claude Code on the machine the app runs on, whatever the target; read when the screen is first shown, by the update button, and again after a failure.
let skills: OrcaSkill[] = [];
let skillsStale = true;
let skillsSeq = 0;
// A read that failed is tried again by the list reads that follow, at most once in this long (the update button reads at once), so a target on another machine does not run a failing command every 10 seconds.
const SKILLS_RETRY_MS = 60_000;
let skillsFailedAt = 0;
// The open skill list: its matches and the one highlighted. `dismissed` keeps Escape's closing until the text changes.
let completion: { matches: OrcaSkill[]; active: number } | null = null;
let dismissed = false;
// What the feed, the header and the notice show now; they are drawn again only when this changes.
let feedKey = "";
let headerKey = "";
let noticeKey = "";

const input = () => $<HTMLTextAreaElement>("orca-input");
const feed = () => $("orca-feed");
const shown = () => currentScreen() === "orca";

const targetName = (v: OrcaOverview) => v.target ?? THIS_MACHINE;
const selectedRow = () => (selected === null ? null : (view?.rows.find((r) => r.paneKey === selected) ?? null));

// How long ago `ms` was: running and waiting agents show the time since their state began ("2 分"), a done one how long ago it ended ("18 分前").
function elapsed(ms: number, now: number, done: boolean) {
  if (!ms) return "";
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 1) return done ? "たった今" : "1 分未満";
  const text = min < 60 ? `${min} 分` : min < 1440 ? `${Math.floor(min / 60)} 時間` : `${Math.floor(min / 1440)} 日`;
  return done ? `${text}前` : text;
}

const countOf = (rows: OrcaRow[]) => rows.filter((r) => r.group !== "done").length;

function drawBadge() {
  setNavCount("nav-orca", badge, "Orca", "作業中");
}

function drawHeader() {
  const v = view;
  const [cls, label] = !v || switching ? ["off", "確認中"] : v.state === "missing" ? ["off", "未インストール"] : v.state === "failed" ? ["warn", `${targetName(v)} に接続できません`] : ["ok", `${targetName(v)} に接続中`];
  // The label is a menu of the targets once an environment is saved (or a saved one is the target, listed or not), plain text before.
  const menu = !!v && (v.environments.length > 0 || v.target !== null);
  const key = JSON.stringify([cls, label, menu]);
  if (key === headerKey) return;
  headerKey = key;
  for (const id of ["orca-status", "orca-target"]) {
    $(id).className = `status ${cls}`;
    $(id).textContent = label;
  }
  $("orca-status").hidden = menu;
  $("orca-target").hidden = !menu;
}

function drawNotice() {
  const v = switching ? null : view;
  const text = v?.state === "missing" ? "orca コマンドが見つかりません。Orca を入れると、動いているエージェントを見て、指示を送れます" : v?.state === "failed" ? `読み込めませんでした: ${v.message}` : null;
  const key = JSON.stringify([v?.state, text]);
  if (key === noticeKey) return;
  noticeKey = key;
  if (text === null) return $("orca-notice").replaceChildren();
  const row = tag("div", v?.state === "failed" ? "pending fail" : "pending");
  row.append(tag("span", "sp", text));
  $("orca-notice").replaceChildren(row);
}

function heading(group: OrcaRow["group"], n: number) {
  const h = tag("h2", `orca-group ${group}`);
  h.append(tag("span", "orca-dot"), STATE_LABELS[group], tag("span", "orca-count", String(n)));
  return h;
}

// Three lines: the prompt and the time, the state, and the worktree.
function rowNode(r: OrcaRow, key: string, now: number) {
  const row = tag("button", `orca-row ${r.group}`);
  row.type = "button";
  row.dataset.key = key;
  // A row with no pane has no session to read.
  row.disabled = r.paneKey === null;
  row.setAttribute("aria-pressed", String(r.paneKey !== null && r.paneKey === selected));
  const top = tag("span", "orca-top");
  top.append(tag("span", "orca-prompt", r.line), tag("span", "orca-time", elapsed(r.atMs, now, r.group === "done")));
  row.append(top, tag("span", "orca-state", STATE_LABELS[r.group]), tag("span", "orca-where", worktreeLabel(r)));
  row.onclick = () => {
    selected = r.paneKey;
    // A worktree chosen for a launch is chosen again for the next one.
    newPath = null;
    drawFeed();
    drawWork();
    drawComposer();
    syncChat();
    input().focus();
  };
  return row;
}

function emptyNode() {
  if (view === null || switching) {
    const loadingRow = tag("div", "pending");
    loadingRow.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    return loadingRow;
  }
  return view.state === "ready" ? tag("div", "feed-empty", "動いているエージェントはありません") : tag("div");
}

// Draws the rows where they are: the scroll position and the focused row stay, and nothing is drawn when nothing changed.
function drawFeed() {
  const now = Date.now();
  const key = JSON.stringify([view?.state ?? null, view?.rows ?? null, selected, switching, Math.floor(now / 60_000)]);
  if (key === feedKey) return;
  feedKey = key;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const rows = view?.rows ?? [];
  const nodes: HTMLElement[] = [];
  for (const group of ["waiting", "working", "done"] as const) {
    const list = rows.filter((r) => r.group === group);
    if (!list.length) continue;
    nodes.push(heading(group, list.length), ...list.map((r) => rowNode(r, r.paneKey ?? `${group}/${r.repo}/${r.branch}/${r.line}`, now)));
  }
  box.replaceChildren(...(nodes.length ? nodes : [emptyNode()]));
  box.scrollTop = top;
  if (focused) box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

const worktreeLabel = (w: { repo: string; branch: string }) => `${w.repo} ・ ${w.branch}`;

// The work pane's header and the plus button follow the selection: a selected session is named, with none the new-session pane shows.
function drawWork() {
  const row = selectedRow();
  $("orca-work-title").textContent = row ? worktreeLabel(row) : "新しいセッション";
  $("orca-new").setAttribute("aria-pressed", String(!row));
  $("orca-dest").hidden = !!row;
  setChatWorking(row?.group === "working");
}

// Reads the history of the selected session while the screen is shown, and closes it when there is none, the target or the session changed, or the screen was left.
function syncChat() {
  const row = shown() ? selectedRow() : null;
  const want = row?.paneKey ? JSON.stringify([view?.target ?? null, row.path, row.paneKey]) : null;
  if (want === chatKey) return;
  chatKey = want;
  if (row?.paneKey && want) openChat(view?.target ?? null, row.path, row.paneKey);
  else closeChat();
}

// The composer's chip and button follow the selection: a selected session is posted to; with none, a worktree is chosen and a new agent is started.
function drawComposer() {
  const row = selectedRow();
  const worktrees = view?.worktrees ?? [];
  const worktree = worktrees.find((w) => w.path === newPath) ?? null;
  const pick = $<HTMLButtonElement>("orca-dest-pick");
  pick.disabled = worktrees.length === 0;
  pick.textContent = worktree ? worktreeLabel(worktree) : worktrees.length ? "worktree を選ぶ" : "worktree がありません";
  // The text is the one being posted while a post is on its way.
  input().disabled = busy;
  input().placeholder = row ? "追加の指示を書く（/ でスキル）" : "起動するエージェントへの指示を書く（/ でスキル）";
  const send = $<HTMLButtonElement>("orca-send");
  send.textContent = row ? "送る" : "起動する";
  // A session with no terminal can be read but takes no post.
  send.disabled = busy || view?.state === "missing" || !input().value.trim() || (row ? row.handle === null : !worktree);
  updateCompletion();
}

// Takes a read as the one shown. A read that did not learn the target and the environments (a poll, or a failed `environment list`) leaves the ones held;
// a failed read keeps the rows and worktrees held while the target is the same; a missing command empties them.
function adopt(read: OrcaOverview) {
  const next = !read.known && view !== null ? { ...read, target: view.target, environments: view.environments } : read;
  const keep = next.state === "failed" && view !== null && view.state !== "missing" && view.target === next.target;
  view = keep ? { ...next, rows: view!.rows, worktrees: view!.worktrees } : next;
  badge = countOf(view.rows);
  switching = false;
  if (selected !== null && !view.rows.some((r) => r.paneKey === selected)) selected = null;
  if (newPath !== null && !view.worktrees.some((w) => w.path === newPath)) newPath = null;
}

function draw() {
  drawBadge();
  if (!shown()) return;
  drawHeader();
  drawNotice();
  drawFeed();
  drawWork();
  drawComposer();
  syncChat();
}

// What a read after a failure, the first one and one with the command missing ask for: everything. A working list is read for its agents (the screen shown) or their count.
const clockScope = (): Scope => (view?.state !== "ready" ? "full" : shown() ? "screen" : "badge");

// Reads the list. Only the latest request is used; `force` starts one although another is on its way (after a post or a change of the target).
async function load(scope: Scope, force = false) {
  if (loading && !force) return;
  const seq = ++loadSeq;
  loading = true;
  lastTry = Date.now();
  let next: OrcaOverview;
  try {
    next = await invoke("orca_overview", { scope, target: view?.target ?? null });
  } catch (e) {
    next = { state: "failed", message: String(e), target: null, environments: [], rows: [], worktrees: [], known: false };
  }
  if (seq !== loadSeq) return;
  loading = false;
  lastTry = Date.now();
  // A read for the count alone has no terminals: it only moves the count, and a failure of it is left to the next read.
  if (scope === "badge" && next.state !== "missing") {
    if (next.state === "ready") badge = countOf(next.rows);
    drawBadge();
    return;
  }
  adopt(next);
  draw();
  fetchSkills();
}

// Reads the skills when they are due and the screen is shown with the command found (the target may be failing). A failure only means no list for now: it is read again later (`SKILLS_RETRY_MS`).
async function fetchSkills() {
  if (!skillsStale || !shown() || view === null || view.state === "missing") return;
  if (Date.now() - skillsFailedAt < SKILLS_RETRY_MS) return;
  skillsStale = false;
  const seq = ++skillsSeq;
  let list: OrcaSkill[] = [];
  let failed = false;
  try {
    list = await invoke("orca_skills");
  } catch {
    // No list, no popup; posting does not depend on it.
    failed = true;
  }
  if (seq !== skillsSeq) return;
  if (failed) {
    skillsStale = true;
    skillsFailedAt = Date.now();
  }
  skills = list;
  updateCompletion();
}

function refresh() {
  // The history is read only while the screen is shown.
  if (!shown()) syncChat();
  if (document.hidden || loading) return;
  // A missing command is not looked for again by the clock.
  if (view?.state === "missing") return;
  if (Date.now() - lastTry >= (shown() ? SHOWN_MS : HIDDEN_MS)) load(clockScope());
}

// The Orca screen is shown: what was read stays on screen while a new read is on its way.
export function showOrca() {
  show("orca");
  headerKey = noticeKey = feedKey = "";
  draw();
  fetchSkills();
  // The environments are read when the screen is shown, whatever read is on its way.
  load("full", true);
}

async function chooseTarget(environment: string | null) {
  if (view === null || environment === view.target) return;
  loadSeq++;
  loading = false;
  try {
    await invoke("orca_set_target", { environment });
  } catch (e) {
    showError(e);
    return;
  }
  // The sessions and worktrees belong to the old target.
  selected = null;
  newPath = null;
  view = { ...view, target: environment, rows: [], worktrees: [] };
  badge = 0;
  switching = true;
  draw();
  load("full", true);
}

function openTargetMenu(anchor: Element) {
  if (view === null) return;
  const items = [null, ...view.environments].map((name) => ({ label: name ?? THIS_MACHINE, color: "var(--accent)", current: name === view!.target, pick: () => chooseTarget(name) }));
  openMenu(anchor, items);
}

function pickWorktree(path: string) {
  newPath = path;
  drawComposer();
  input().focus();
}

// The dialog under the "起動先" chip: the worktrees, narrowed by a filter on `{repo} ・ {branch}`. A pick closes it.
function openDestPicker(anchor: Element) {
  const worktrees = view?.worktrees ?? [];
  const pop = tag("div", "menu orca-dest-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "起動先の worktree");
  const filter = tag("input");
  filter.setAttribute("aria-label", "worktree を絞り込む");
  filter.placeholder = "worktree を絞り込む";
  filter.autocomplete = "off";
  const rows = tag("div", "orca-dest-list");
  const drawRows = () => {
    const q = filter.value.trim().toLowerCase();
    const hits = worktrees.filter((w) => worktreeLabel(w).toLowerCase().includes(q));
    rows.replaceChildren(
      ...(hits.length
        ? hits.map((w) => {
            const b = tag("button");
            b.type = "button";
            b.dataset.path = w.path;
            b.setAttribute("aria-current", String(w.path === newPath));
            b.append(tag("b", "", w.repo), tag("span", "", w.branch));
            b.onclick = () => {
              closeMenu();
              pickWorktree(w.path);
            };
            return b;
          })
        : [tag("p", "empty", "該当する worktree がありません")]),
    );
  };
  filter.oninput = drawRows;
  drawRows();
  pop.append(filter, rows);
  showMenu(anchor, pop);
  filter.focus();
}

function showPostError(message: string | null) {
  $("orca-error").hidden = message === null;
  $("orca-error").textContent = message ?? "";
}

// Sends the text to the selected session, or starts an agent with it. The text stays on a failure and goes on success, which reads the list at once. Nothing is tried twice.
async function post() {
  const text = input().value;
  const row = selectedRow();
  const target = view?.target ?? null;
  if (busy || !text.trim() || view === null) return;
  if (row ? row.handle === null : !newPath) return;
  busy = true;
  showPostError(null);
  drawComposer();
  try {
    if (row) await invoke("orca_send", { handle: row.handle!, text, environment: target });
    else await invoke("orca_launch", { path: newPath!, text, environment: target });
    input().value = "";
    load(clockScope(), true);
  } catch (e) {
    showPostError(String(e));
  } finally {
    busy = false;
    drawComposer();
    // A disabled text lost the focus.
    input().focus();
  }
}

// ---- the skill list ----

// The first word of the text when it starts with "/" and the caret is still in it (no space yet), without the slash; null otherwise.
function slashQuery(): string | null {
  const text = input().value;
  const word = /^\/\S*/.exec(text)?.[0];
  if (!word || (input().selectionStart ?? 0) > word.length) return null;
  return word.slice(1);
}

// The skills that contain the query, case-insensitively, those that start with it first.
function matchesOf(query: string) {
  const q = query.toLowerCase();
  const found = skills.filter((s) => s.command.slice(1).toLowerCase().includes(q));
  const starts = (s: OrcaSkill) => s.command.slice(1).toLowerCase().startsWith(q);
  return [...found.filter(starts), ...found.filter((s) => !starts(s))];
}

function closeCompletion() {
  completion = null;
  $("orca-complete").hidden = true;
  $("orca-complete").replaceChildren();
  for (const id of ["orca-complete", "orca-input"]) $(id).removeAttribute("aria-activedescendant");
}

function markActive() {
  if (!completion) return;
  const options = [...$("orca-complete").children] as HTMLElement[];
  const { active } = completion;
  for (const [i, option] of options.entries()) option.setAttribute("aria-selected", String(i === active));
  const id = options[active]?.id ?? "";
  for (const el of [$("orca-complete"), input()]) el.setAttribute("aria-activedescendant", id);
  options[active]?.scrollIntoView({ block: "nearest" });
}

// Opens, narrows or closes the list for the text and the caret as they are. The highlight stays on the same skill while it is still listed; `reset` (typing) puts it on the first.
function updateCompletion(reset = false) {
  // Only the text being typed in opens it: a read in the background must not.
  const query = !dismissed && document.activeElement === input() ? slashQuery() : null;
  const matches = query === null ? [] : matchesOf(query);
  if (!matches.length) {
    if (completion) closeCompletion();
    return;
  }
  const keep = reset ? undefined : completion?.matches[completion.active]?.command;
  const active = Math.max(0, matches.findIndex((m) => m.command === keep));
  const same = completion && completion.matches.length === matches.length && completion.matches.every((m, i) => m.command === matches[i].command);
  completion = { matches, active };
  if (!same) {
    const box = $("orca-complete");
    box.hidden = false;
    box.replaceChildren(
      ...matches.map((m, i) => {
        const option = tag("div", "orca-skill");
        option.id = `orca-skill-${i}`;
        option.setAttribute("role", "option");
        option.append(tag("code", "", m.command), tag("span", "", m.description));
        // A press keeps the focus in the text.
        option.onmousedown = (e) => e.preventDefault();
        option.onclick = () => accept(i);
        return option;
      }),
    );
    box.scrollTop = 0;
  }
  markActive();
}

// Puts the command in the place of the first word, followed by one space, and does not post.
function accept(index: number) {
  const skill = completion?.matches[index];
  if (!skill) return;
  const field = input();
  const rest = field.value.replace(/^\/\S*/, "").trimStart();
  field.value = `${skill.command} ${rest}`;
  const caret = skill.command.length + 1;
  field.setSelectionRange(caret, caret);
  closeCompletion();
  drawComposer();
}

function onKey(e: KeyboardEvent) {
  if (!completion || composing(e)) return;
  const n = completion.matches.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    completion.active = (completion.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    markActive();
  } else if (e.key === "Tab" || e.key === "Enter") {
    accept(completion.active);
  } else if (e.key === "Escape") {
    dismissed = true;
    closeCompletion();
  } else {
    return;
  }
  e.preventDefault();
}

export function initOrca() {
  initOrcaChat();
  initSplit($("orca"), $("orca-split"), { side: "left", min: 0.2, max: 0.5, initial: 0.3, property: "--list-w" });
  setInterval(refresh, 1000);
  document.addEventListener("visibilitychange", refresh);
  $("orca-refresh").onclick = () => {
    skillsStale = true;
    skillsFailedAt = 0;
    load("full", true);
  };
  $("orca-target").onclick = (e) => openTargetMenu(e.currentTarget as Element);
  $("orca-dest-pick").onclick = (e) => openDestPicker(e.currentTarget as Element);
  $("orca-new").onclick = () => {
    selected = null;
    drawFeed();
    drawWork();
    drawComposer();
    syncChat();
    input().focus();
  };
  $("orca-form").onsubmit = (e) => {
    e.preventDefault();
    post();
  };
  input().addEventListener("input", () => {
    dismissed = false;
    drawComposer();
    updateCompletion(true);
  });
  input().addEventListener("keydown", onKey);
  // The caret moving out of the first word closes the list, and moving back in opens it.
  for (const type of ["keyup", "click", "focus"]) input().addEventListener(type, () => updateCompletion());
  input().addEventListener("blur", () => closeCompletion());
  load("full");
}
