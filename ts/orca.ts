// The Orca screen (A-6): the agents that run in Orca, in three groups (waiting for the user, running, done), and a composer that posts to the selected one or starts a new one. Nothing about a session is kept here.
// The list is read at startup for the sidebar button's count, every 10 seconds while the screen is shown and every 60 seconds otherwise, one read at a time, and no more once the `orca` command was found missing (the update button reads again).
// A read in the background swaps the rows in place: the selection, the text in the composer and the scroll position stay, and `show()` is never called by it.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaRow } from "./bindings/OrcaRow";
import type { OrcaSkill } from "./bindings/OrcaSkill";
import { $, composing, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { currentScreen } from "./nav.js";
import { setNavCount, show, showError } from "./view.js";

const AGENTS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];
const THIS_MACHINE = "このマシン";
const SHOWN_MS = 10_000;
const HIDDEN_MS = 60_000;

// The last read, or null before the first. A failed read keeps the rows and worktrees of the one before it while the target is the same.
let view: OrcaOverview | null = null;
// Reads: the latest request is the one used; one is on its way; when the last one started.
let loadSeq = 0;
let loading = false;
let lastTry = 0;
// The handle of the selected row, the worktree (its path) and the agent a new launch uses, and a post on its way.
let selected: string | null = null;
let newPath: string | null = null;
let agent = AGENTS[0].id;
let busy = false;
// The skills of Claude Code on the target in use; read again when the screen is first shown, when the target changes and by the update button.
let skills: OrcaSkill[] = [];
let skillsStale = true;
let skillsSeq = 0;
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
const selectedRow = () => (selected === null ? null : (view?.rows.find((r) => r.handle === selected) ?? null));
const isClaudeDest = () => {
  const row = selectedRow();
  return (row ? row.agent.toLowerCase() : agent) === "claude";
};

// How long ago `ms` was: running and waiting agents show the time since their state began ("2 分"), a done one how long ago it ended ("18 分前").
function elapsed(ms: number, now: number, done: boolean) {
  if (!ms) return "";
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 1) return done ? "たった今" : "1 分未満";
  const text = min < 60 ? `${min} 分` : min < 1440 ? `${Math.floor(min / 60)} 時間` : `${Math.floor(min / 1440)} 日`;
  return done ? `${text}前` : text;
}

function drawBadge() {
  const count = view?.rows.filter((r) => r.group !== "done").length ?? 0;
  setNavCount("nav-orca", count, "Orca", "動作中");
}

function drawHeader() {
  const v = view;
  const [cls, label] = !v ? ["off", "確認中"] : v.state === "missing" ? ["off", "未インストール"] : v.state === "failed" ? ["warn", `${targetName(v)} に接続できません`] : ["ok", `${targetName(v)} に接続中`];
  // The label is a menu of the targets once an environment is saved, plain text before.
  const menu = !!v && v.environments.length > 0;
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
  const v = view;
  const text = v?.state === "missing" ? "orca コマンドが見つかりません。Orca を入れると、動いているエージェントを見て、指示を送れます" : v?.state === "failed" ? `読み込めませんでした: ${v.message}` : null;
  const key = JSON.stringify([v?.state, text]);
  if (key === noticeKey) return;
  noticeKey = key;
  if (text === null) return $("orca-notice").replaceChildren();
  const row = tag("div", v?.state === "failed" ? "pending fail" : "pending");
  row.append(tag("span", "sp", text));
  $("orca-notice").replaceChildren(row);
}

function heading(label: string, n: number) {
  return tag("h2", "feed-heading", `${label} ${n}`);
}

function rowNode(r: OrcaRow, key: string, now: number) {
  const row = tag("button", `orca-row ${r.group}`);
  row.type = "button";
  row.dataset.key = key;
  // A row with no terminal cannot take a post.
  row.disabled = r.handle === null;
  row.setAttribute("aria-pressed", String(r.handle !== null && r.handle === selected));
  const name = tag("span");
  name.append(tag("b", "", r.repo), tag("span", "orca-branch", r.branch));
  const main = tag("span", "orca-main");
  main.append(name, tag("span", "orca-line", r.line));
  const side = tag("span", "orca-side");
  if (r.agent) side.append(tag("span", "orca-agent", r.agent));
  side.append(elapsed(r.atMs, now, r.group === "done"));
  row.append(tag("span", "orca-dot"), main, side);
  row.onclick = () => {
    selected = r.handle;
    drawFeed();
    drawComposer();
    input().focus();
  };
  return row;
}

function emptyNode() {
  if (view === null) {
    const loadingRow = tag("div", "pending");
    loadingRow.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    return loadingRow;
  }
  return view.state === "ready" ? tag("div", "feed-empty", "動いているエージェントはありません") : tag("div");
}

// Draws the rows where they are: the scroll position and the focused row stay, and nothing is drawn when nothing changed.
function drawFeed() {
  const now = Date.now();
  const key = JSON.stringify([view?.state ?? null, view?.rows ?? null, selected, Math.floor(now / 60_000)]);
  if (key === feedKey) return;
  feedKey = key;
  const box = feed();
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const rows = view?.rows ?? [];
  const nodes: HTMLElement[] = [];
  for (const [group, label] of [["waiting", "入力待ち"], ["working", "動作中"], ["done", "完了"]] as const) {
    const list = rows.filter((r) => r.group === group);
    if (!list.length) continue;
    nodes.push(heading(label, list.length), ...list.map((r) => rowNode(r, r.handle ?? `${group}/${r.repo}/${r.branch}/${r.line}`, now)));
  }
  box.replaceChildren(...(nodes.length ? nodes : [emptyNode()]));
  box.scrollTop = top;
  if (focused) box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

const worktreeLabel = (w: { repo: string; branch: string }) => `${w.repo} ・ ${w.branch}`;

// The composer's chips and button follow the selection: a selected session is named and posted to; with none, a worktree and an agent are chosen and a new agent is started.
function drawComposer() {
  const row = selectedRow();
  const worktrees = view?.worktrees ?? [];
  const worktree = worktrees.find((w) => w.path === newPath) ?? null;
  $("orca-dest-label").hidden = !row;
  $("orca-dest-label").textContent = row ? `${worktreeLabel(row)} のセッション` : "";
  const pick = $<HTMLButtonElement>("orca-dest-pick");
  pick.hidden = !!row;
  pick.disabled = worktrees.length === 0;
  pick.textContent = worktree ? worktreeLabel(worktree) : worktrees.length ? "worktree を選ぶ" : "worktree がありません";
  $("orca-agent").hidden = !!row;
  $("orca-agent").textContent = AGENTS.find((a) => a.id === agent)!.label;
  $("orca-new").hidden = !row;
  input().placeholder = row ? "追加の指示を書く" : "起動するエージェントへの指示を書く";
  const send = $<HTMLButtonElement>("orca-send");
  send.textContent = row ? "送る" : "起動する";
  send.disabled = busy || view?.state === "missing" || !input().value.trim() || (!row && !worktree);
  updateCompletion();
}

// Takes a read as the one shown. A failed read keeps the rows and worktrees held while the target is the same; a missing command empties them.
function adopt(next: OrcaOverview) {
  const keep = next.state === "failed" && view !== null && view.state !== "missing" && view.target === next.target;
  view = keep ? { ...next, rows: view!.rows, worktrees: view!.worktrees } : next;
  if (selected !== null && !view.rows.some((r) => r.handle === selected)) selected = null;
  if (newPath !== null && !view.worktrees.some((w) => w.path === newPath)) newPath = null;
}

function draw() {
  drawBadge();
  if (!shown()) return;
  drawHeader();
  drawNotice();
  drawFeed();
  drawComposer();
}

// Reads the list. Only the latest request is used; `force` starts one although another is on its way (after a post or a change of the target).
async function load(force = false) {
  if (loading && !force) return;
  const seq = ++loadSeq;
  loading = true;
  lastTry = Date.now();
  let next: OrcaOverview;
  try {
    next = await invoke("orca_overview");
  } catch (e) {
    next = { state: "failed", message: String(e), target: view?.target ?? null, environments: view?.environments ?? [], rows: [], worktrees: [] };
  }
  if (seq !== loadSeq) return;
  loading = false;
  lastTry = Date.now();
  adopt(next);
  draw();
  fetchSkills();
}

// Reads the skills when they are due and the screen is shown with a working command. A failure only means no list.
async function fetchSkills() {
  if (!skillsStale || !shown() || view?.state !== "ready") return;
  skillsStale = false;
  const seq = ++skillsSeq;
  let list: OrcaSkill[] = [];
  try {
    list = await invoke("orca_skills", { environment: view.target });
  } catch {
    // No list, no popup; posting does not depend on it.
  }
  if (seq !== skillsSeq) return;
  skills = list;
  updateCompletion();
}

function refresh() {
  if (document.hidden || loading) return;
  // A missing command is not looked for again by the clock.
  if (view?.state === "missing") return;
  if (Date.now() - lastTry >= (shown() ? SHOWN_MS : HIDDEN_MS)) load();
}

// The Orca screen is shown: what was read stays on screen while a new read is on its way.
export function showOrca() {
  show("orca");
  headerKey = noticeKey = feedKey = "";
  draw();
  fetchSkills();
  if (!loading) load();
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
  skills = [];
  skillsStale = true;
  view = { ...view, target: environment, rows: [], worktrees: [] };
  draw();
  load(true);
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

function pickAgent(id: string) {
  agent = id;
  drawComposer();
  input().focus();
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
  if (!row && !newPath) return;
  busy = true;
  showPostError(null);
  drawComposer();
  try {
    if (row) await invoke("orca_send", { handle: row.handle!, text, environment: target });
    else await invoke("orca_launch", { agent, path: newPath!, text, environment: target });
    input().value = "";
    load(true);
  } catch (e) {
    showPostError(String(e));
  } finally {
    busy = false;
    drawComposer();
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
  const query = !dismissed && isClaudeDest() ? slashQuery() : null;
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
  setInterval(refresh, 1000);
  document.addEventListener("visibilitychange", refresh);
  $("orca-refresh").onclick = () => {
    skillsStale = true;
    load(true);
  };
  $("orca-target").onclick = (e) => openTargetMenu(e.currentTarget as Element);
  $("orca-dest-pick").onclick = (e) => {
    const items = (view?.worktrees ?? []).map((w) => ({ label: worktreeLabel(w), color: "var(--chip-line)", current: w.path === newPath, pick: () => pickWorktree(w.path) }));
    openMenu(e.currentTarget as Element, items);
  };
  $("orca-agent").onclick = (e) => {
    const items = AGENTS.map((a) => ({ label: a.label, color: "var(--accent)", current: a.id === agent, pick: () => pickAgent(a.id) }));
    openMenu(e.currentTarget as Element, items);
  };
  $("orca-new").onclick = () => {
    selected = null;
    drawFeed();
    drawComposer();
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
  load();
}
