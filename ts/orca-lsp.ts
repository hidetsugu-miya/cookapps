// The language server of the Orca screen (A-34): the state of the language servers of a worktree and their settings, shown as a card for each server in the file pane, and when they are started and stopped. A repository has any number of servers, each with a name and the languages it takes; a Ruby file or any file whose language a server takes asks Rust for that server (`lsp_server_for`).
// Rust starts, keeps and stops the processes (`lsp_start`, `lsp_restart`, `lsp_stop`), tells each change of their state (the event `lsp-status`), reads how the servers are started from the worktree (`lsp_launches`, once for all of them) and saves the settings of the repository (`lsp_settings_set`); this module draws them and takes the presses.
// A file opened in the editor starts the server that takes its language when the settings say 「自動で起動」 (`ensureServer`); a server this screen started is stopped when no tab of its worktree is open any more, or when Orca's list has not the worktree any more (`syncServers`). The container is started only by its button, never by itself. Nothing is kept outside memory here.
// While the part is shown, the settings are read at an interval, so that a change made elsewhere (`tsunagiai-mcp`, A-34) is drawn: the text that is being typed in, the open card and a card that is not saved yet stay. The interval stops when the part is hidden, when another worktree is shown or when the project is gone from the list.
import type { LspLaunch } from "./bindings/LspLaunch";
import type { LspRepoSettings } from "./bindings/LspRepoSettings";
import type { LspServerSettings } from "./bindings/LspServerSettings";
import type { LspStatus } from "./bindings/LspStatus";
import type { LspStatusEvent } from "./bindings/LspStatusEvent";
import { $, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { confirmDelete } from "./hint.js";
import { CHEVRON_SVG, CLOSE_SVG, DELETE_SVG, MORE_SVG, PLUS_SVG, RELOAD_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { showError } from "./view.js";

// A worktree of a project, where it is (null: this machine).
export interface LspPlace {
  target: string | null;
  project: string;
  path: string;
}

const NOT_STARTED: LspStatus = { state: "stopped", reason: "notStarted" };
const STATE_LABELS = { indexing: "索引中", running: "動作中", stopped: "停止中" };
// How often the settings are read while the part is shown.
const WATCH_MS = 2000;

// What the screen is told: the settings of a project changed, so the files open in it look for their server again.
let changed: (place: LspPlace) => void = () => {};

// A server of a worktree: its name in the settings of the repository too.
interface ServerPlace extends LspPlace {
  server: string;
}

const keyOf = (target: string | null, path: string, server: string) => JSON.stringify([target, path, server]);

// The servers this screen asked to start, or found running: it stops them.
const started = new Map<string, ServerPlace>();
// The servers whose state is being looked at to be started (a second file opened meanwhile asks nothing more).
const checking = new Set<string>();
// The last state told of each server (a server that was not asked about is not started).
const statuses = new Map<string, LspStatus>();

// How a server is started in the worktree that is shown: what `lsp_launches` answered, or why it could not.
interface Read {
  launch: LspLaunch | null;
  error: string | null;
}

// The worktree the pane shows (null: none, and the part is hidden), what was read for it, and what is on its way.
let pane: LspPlace | null = null;
let loaded = false;
let settings: LspRepoSettings | null = null;
// The languages of A-21 that a server may take (read once).
let languages: string[] | null = null;
// The Hosts of this Mac's `~/.ssh/config`, read with the settings of a worktree of a saved environment (empty for this machine's).
let sshHosts: string[] = [];
const launches = new Map<string, Read>();
// The card that is open (null: none), and the card that is not saved yet: it waits for its first language.
let openName: string | null = null;
let draft: LspServerSettings | null = null;
// The message of a save, a restart or a start of the container that failed.
let note: string | null = null;
let busy: "restart" | "container" | null = null;
// Another worktree ends the reads of the old one.
let generation = 0;
// The saves, one after another: each takes the settings the one before it saved. `version` counts the settings that were taken, `pending` the saves that are not over.
let saving: Promise<void> = Promise.resolve();
let version = 0;
let pending = 0;
let timer: number | null = null;

const statusOf = (name: string): LspStatus => (pane === null ? NOT_STARTED : (statuses.get(keyOf(pane.target, pane.path, name)) ?? NOT_STARTED));
const args = (place: ServerPlace) => ({ environment: place.target, project: place.project, worktree: place.path, server: place.server });
const serverPlace = (name: string): ServerPlace | null => (pane === null ? null : { ...pane, server: name });
const savedServer = (name: string) => settings?.servers.find((s) => s.name === name) ?? null;
const serverNamed = (name: string) => (draft !== null && draft.name === name ? draft : savedServer(name));
const names = () => [...(settings?.servers.map((s) => s.name) ?? []), ...(draft === null ? [] : [draft.name])];

// The card that is open at first: the one whose server failed, else the first.
function ensureOpen() {
  if (settings === null || (openName !== null && names().includes(openName))) return;
  openName = settings.servers.find((s) => statusOf(s.name).reason === "failed")?.name ?? settings.servers[0]?.name ?? draft?.name ?? null;
}

// A name that no server of the repository has: server-1, server-2 and so on.
function freeName(): string {
  const taken = new Set(names());
  for (let n = 1; ; n++) if (!taken.has(`server-${n}`)) return `server-${n}`;
}

const methodOf = (launch: LspLaunch) => (launch.method === "compose" ? `compose の ${launch.service ?? ""}` : launch.method === "host" ? "ホスト" : "方法なし");

// ---- drawing ----

// The message of the open card: the first of the message of the last press that failed, the message of the stopped state and the message of the reading of the way that failed.
function messageOf(name: string | null): string | null {
  if (note !== null) return note;
  if (name === null || serverNamed(name) === null) return null;
  const status = statusOf(name);
  if (status.state === "stopped" && status.message) return status.message;
  return launches.get(name)?.error ?? null;
}

// The line of the message: in the open card, else (no card is open, or none is read) under the heading.
function drawNote() {
  const text = messageOf(openName);
  const inCard = document.getElementById("orca-lsp-note");
  const lines: [HTMLElement, boolean][] = [
    [$("orca-lsp-error"), inCard === null],
    ...(inCard === null ? [] : ([[inCard, true]] as [HTMLElement, boolean][])),
  ];
  for (const [line, here] of lines) {
    line.hidden = !here || text === null;
    line.textContent = here ? (text ?? "") : "";
  }
}

// The state of every card and the buttons that depend on it. A card is not drawn again: only its words change.
function drawState() {
  for (const root of $("orca-lsp-cards").querySelectorAll<HTMLElement>(".orca-lsp-card")) {
    const name = root.dataset.name ?? "";
    const server = serverNamed(name);
    const status = root.dataset.draft === "true" ? NOT_STARTED : statusOf(name);
    const dot = root.querySelector<HTMLElement>(".orca-lsp-dot")!;
    dot.dataset.state = status.state;
    if (status.reason) dot.dataset.reason = status.reason;
    else delete dot.dataset.reason;
    root.querySelector(".orca-lsp-state")!.textContent = STATE_LABELS[status.state];
    root.querySelector<HTMLButtonElement>(".orca-lsp-restart")!.disabled = busy !== null || root.dataset.draft === "true";
    const summary = root.querySelector(".orca-lsp-summary");
    if (summary !== null && server !== null) summary.textContent = [STATE_LABELS[status.state], server.languages.join(", "), launchOf(name) === null ? "" : methodOf(launchOf(name)!)].filter((part) => part !== "").join(" ・ ");
    const container = root.querySelector<HTMLButtonElement>("#orca-lsp-container");
    if (container !== null) {
      container.hidden = !(status.state === "stopped" && status.reason === "containerDown");
      container.disabled = busy !== null;
    }
  }
  drawNote();
}

const launchOf = (name: string): LspLaunch | null => launches.get(name)?.launch ?? null;

function textInput(id: string, field: string, value: string): HTMLInputElement {
  const input = tag("input");
  input.type = "text";
  input.id = id;
  input.dataset.field = field;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = value;
  return input;
}

function row(label: string, forId: string | null, ...nodes: Node[]): HTMLElement {
  const line = tag("div", "orca-lsp-row");
  const name = forId === null ? tag("span", "", label) : tag("label", "", label);
  if (forId !== null) (name as HTMLLabelElement).htmlFor = forId;
  line.append(name, ...nodes);
  return line;
}

const autoMark = () => tag("span", "chip", "自動");

// The text of a field as a setting: none when it is empty.
const textOf = (input: HTMLInputElement | HTMLSelectElement) => input.value.trim() || null;

// The fields of the open card.
function body(server: LspServerSettings, isDraft: boolean): HTMLElement {
  const name = server.name;
  const launch = isDraft ? null : launchOf(name);
  const box = tag("div", "orca-lsp-body");
  const noteLine = tag("p", "orca-file-note fail", "");
  noteLine.id = "orca-lsp-note";
  noteLine.setAttribute("role", "alert");
  noteLine.hidden = true;

  const nameInput = textInput("orca-lsp-name", "name", name);
  nameInput.onchange = () => {
    const value = nameInput.value.trim();
    if (value !== name) edit(name, { name: value });
  };

  const chips = tag("div", "orca-lsp-chips");
  for (const language of server.languages) {
    const chip = tag("span", "chip", language);
    const drop = tag("button", "orca-lsp-drop");
    drop.type = "button";
    drop.setAttribute("aria-label", `${language} を外す`);
    drop.innerHTML = CLOSE_SVG;
    drop.onclick = () => edit(name, { languages: server.languages.filter((l) => l !== language) });
    chip.append(drop);
    chips.append(chip);
  }
  const add = tag("button", "icon-btn orca-lsp-add-language");
  add.type = "button";
  add.setAttribute("aria-label", "言語を足す");
  add.innerHTML = PLUS_SVG;
  add.onclick = () =>
    openMenu(
      add,
      (languages ?? []).filter((l) => !server.languages.includes(l)).map((l) => ({ label: l, color: "", current: false, pick: () => edit(name, { languages: [...server.languages, l] }) })),
      { search: { label: "言語を検索", empty: "該当なし" } },
    );
  chips.append(add);

  const method = tag("span", "chip", launch === null ? "" : methodOf(launch));
  method.id = "orca-lsp-method";
  method.hidden = launch === null;
  const candidates = launch?.candidates ?? [];
  const service = tag("select");
  service.id = "orca-lsp-service";
  service.replaceChildren(
    ...candidates.map((c) => {
      const option = tag("option", "", c.service);
      option.value = c.service;
      return option;
    }),
  );
  service.value = launch?.service ?? "";
  service.hidden = candidates.length < 2;
  service.onchange = () => edit(name, { service: service.value });
  const how = tag("div", "orca-lsp-how");
  how.append(method, service);

  const command = textInput("orca-lsp-command", "command", launch === null ? (server.command ?? "") : (launch.command ?? ""));
  command.onchange = () => {
    const value = textOf(command);
    if (value !== (isDraft ? (server.command ?? null) : (launch?.command ?? null))) edit(name, { command: value });
  };
  const commandAuto = autoMark();
  commandAuto.id = "orca-lsp-command-auto";
  commandAuto.hidden = isDraft || server.command != null || launch?.command == null;
  const commandBox = tag("div", "orca-lsp-field");
  commandBox.append(command, commandAuto);

  const mount = textInput("orca-lsp-mount", "mount", launch === null ? (server.mount ?? "") : (launch.mount ?? ""));
  mount.onchange = () => {
    const value = textOf(mount);
    if (value !== (isDraft ? (server.mount ?? null) : (launch?.mount ?? null))) edit(name, { mount: value });
  };
  const mountAuto = autoMark();
  mountAuto.id = "orca-lsp-mount-auto";
  mountAuto.hidden = isDraft || server.mount != null || launch?.mount == null;
  const mountBox = tag("div", "orca-lsp-field");
  mountBox.append(mount, mountAuto);
  const places = tag("div", "orca-lsp-places");
  const here = tag("span", "orca-lsp-path", pane?.path ?? "");
  here.id = "orca-lsp-path";
  places.append(tag("span", "", "この Mac"), here, tag("span", "", "サーバー"), mountBox);

  const auto = tag("input");
  auto.type = "checkbox";
  auto.id = "orca-lsp-auto";
  auto.checked = server.autoStart;
  auto.onchange = () => edit(name, { autoStart: auto.checked });
  const autoLabel = tag("label", "orca-lsp-auto-label");
  autoLabel.append(auto, "自動で起動");

  const container = tag("button", "text-btn", "コンテナを起動");
  container.id = "orca-lsp-container";
  container.type = "button";
  container.hidden = true;
  container.onclick = () => void startContainer(name);
  const reset = tag("button", "text-btn", "自動に戻す");
  reset.id = "orca-lsp-reset";
  reset.type = "button";
  reset.disabled = server.command == null && server.mount == null && server.service == null;
  reset.onclick = () => edit(name, { command: null, mount: null, service: null });
  const foot = tag("div", "orca-lsp-foot");
  foot.append(container, reset);

  box.append(noteLine, row("名前", "orca-lsp-name", nameInput), row("言語", null, chips), row("起動の方法", null, how), row("起動コマンド", "orca-lsp-command", commandBox), row("worktree", null, places), autoLabel, foot);
  return box;
}

function card(server: LspServerSettings, isDraft: boolean): HTMLElement {
  const name = server.name;
  const open = openName === name;
  const root = tag("div", "orca-lsp-card");
  root.dataset.name = name;
  root.dataset.open = String(open);
  if (isDraft) root.dataset.draft = "true";
  const head = tag("div", "orca-lsp-card-head");
  const dot = tag("span", "orca-lsp-dot");
  const state = tag("span", "orca-lsp-state");
  state.setAttribute("role", "status");
  const restart = tag("button", "icon-btn orca-lsp-restart");
  restart.type = "button";
  restart.setAttribute("aria-label", "再起動");
  restart.innerHTML = RELOAD_SVG;
  restart.onclick = () => void restartServer(name);
  const menu = tag("button", "icon-btn orca-lsp-menu");
  menu.type = "button";
  menu.setAttribute("aria-label", "メニュー");
  menu.innerHTML = MORE_SVG;
  menu.onclick = () => openMenu(menu, [{ label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, pick: () => confirmDelete(menu, name, () => void removeServer(name)) }]);
  const toggle = tag("button", "icon-btn orca-lsp-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-label", open ? "閉じる" : "開く");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.innerHTML = CHEVRON_SVG;
  toggle.onclick = () => {
    openName = open ? null : name;
    note = null;
    drawCards();
  };
  head.append(dot, tag("span", "orca-lsp-name", name), state, restart, menu, toggle);
  root.append(head);
  if (open) root.append(body(server, isDraft));
  else root.append(tag("div", "orca-lsp-summary"));
  return root;
}

// The field that has the focus in a card, with its text and selection, to be put back when the cards are drawn again.
function focused(): { card: string; field: string; value: string; start: number | null; end: number | null } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || active.dataset.field === undefined) return null;
  const root = active.closest<HTMLElement>(".orca-lsp-card");
  if (root === null) return null;
  return { card: root.dataset.name ?? "", field: active.dataset.field, value: active.value, start: active.selectionStart, end: active.selectionEnd };
}

function drawCards() {
  const keep = focused();
  const servers = [...(settings?.servers ?? []).map((s) => card(s, false)), ...(draft === null ? [] : [card(draft, true)])];
  $("orca-lsp-cards").replaceChildren(...servers);
  // The field that is being typed in keeps its text: a save of another field ends meanwhile and the cards are drawn.
  if (keep !== null) {
    const input = [...$("orca-lsp-cards").querySelectorAll<HTMLElement>(".orca-lsp-card")].find((c) => c.dataset.name === keep.card)?.querySelector<HTMLInputElement>(`[data-field="${keep.field}"]`);
    if (input) {
      input.value = keep.value;
      input.focus();
      input.setSelectionRange(keep.start, keep.end);
    }
  }
  drawState();
}

function drawSsh() {
  const saved = settings?.sshHost ?? "";
  // The Hosts, with the saved one when the file does not have it (it stays the chosen value).
  const hosts = saved === "" || sshHosts.includes(saved) ? sshHosts : [...sshHosts, saved];
  const ssh = $("orca-lsp-ssh") as HTMLSelectElement;
  ssh.replaceChildren(
    ...["", ...hosts].map((host) => {
      const option = tag("option", "", host);
      option.value = host;
      return option;
    }),
  );
  ssh.value = saved;
  ssh.disabled = settings === null;
  $("orca-lsp-ssh-row").hidden = pane === null || pane.target === null;
}

function draw() {
  $("orca-lsp").hidden = pane === null;
  if (pane === null) return;
  ($("orca-lsp-add") as HTMLButtonElement).disabled = settings === null;
  drawSsh();
  drawCards();
}

// ---- reading ----

// Reads how the servers `names` are started in the worktree, in one read of the worktree (and, for the servers that `withStatus` names, not asked about yet, their state).
async function readServers(names: string[], mine: number, withStatus: (name: string) => boolean) {
  const here = pane;
  if (here === null || names.length === 0) return;
  const [launched, states] = await Promise.all([
    invoke("lsp_launches", { environment: here.target, project: here.project, worktree: here.path, servers: names }).then(
      (all) => ({ all, error: null }),
      (e) => ({ all: null, error: String(e) }),
    ),
    Promise.allSettled(names.map((name) => (withStatus(name) ? invoke("lsp_status", { environment: here.target, worktree: here.path, server: name }) : Promise.resolve(null)))),
  ]);
  if (mine !== generation) return;
  for (const [i, name] of names.entries()) {
    launches.set(name, launched.all === null ? { launch: null, error: launched.error } : { launch: launched.all[i] ?? null, error: null });
    const state = states[i];
    if (state.status === "fulfilled" && state.value !== null) statuses.set(keyOf(here.target, here.path, name), state.value);
  }
  drawCards();
}

async function load() {
  const here = pane;
  if (here === null) return;
  const mine = generation;
  loaded = true;
  let read: LspRepoSettings;
  try {
    read = await invoke("lsp_settings", { environment: here.target, project: here.project });
    if (mine !== generation) return;
    // The list is read when the field is shown, which is for a saved environment only.
    const [hosts, all, states] = await Promise.all([
      here.target === null ? Promise.resolve([]) : invoke("ssh_hosts"),
      languages === null ? invoke("orca_languages") : Promise.resolve(languages),
      Promise.all(read.servers.map((s) => invoke("lsp_status", { environment: here.target, worktree: here.path, server: s.name }))),
    ]);
    if (mine !== generation) return;
    settings = read;
    version++;
    sshHosts = hosts;
    languages = all;
    for (const [i, s] of read.servers.entries()) statuses.set(keyOf(here.target, here.path, s.name), states[i]);
  } catch (e) {
    if (mine !== generation) return;
    note = String(e);
    draw();
    return;
  }
  ensureOpen();
  draw();
  await readServers(
    read.servers.map((s) => s.name),
    mine,
    () => false,
  );
}

// Reads the settings again, and draws them when they are not the ones shown (a change made elsewhere).
let reading = false;
async function watch() {
  const here = pane;
  if (here === null || settings === null || reading || document.hidden) return;
  const mine = generation;
  const seen = version;
  reading = true;
  let read: LspRepoSettings;
  try {
    read = await invoke("lsp_settings", { environment: here.target, project: here.project });
  } catch {
    return;
  } finally {
    reading = false;
  }
  // A save of this screen made meanwhile is newer than this read.
  if (mine !== generation || seen !== version || pending > 0 || settings === null || JSON.stringify(read) === JSON.stringify(settings)) return;
  const before = settings;
  settings = read;
  version++;
  const same = (s: LspServerSettings) => before.servers.some((b) => JSON.stringify(b) === JSON.stringify(s));
  for (const gone of before.servers.filter((b) => !read.servers.some((s) => s.name === b.name))) void forget(gone.name);
  ensureOpen();
  draw();
  const ssh = before.sshHost !== read.sshHost;
  changed(here);
  await readServers(
    read.servers.filter((s) => ssh || !same(s)).map((s) => s.name),
    mine,
    (name) => !before.servers.some((b) => b.name === name),
  );
}

// ---- saving ----

// What a save changes: the ssh Host of the repository, a server (by its name), or a server taken away.
interface Patch {
  sshHost?: string | null;
  server?: { name: string; change: Partial<LspServerSettings> };
  remove?: string;
}

// Stops what runs for a server that was renamed or deleted, and drops what is known of it.
async function forget(name: string) {
  const here = pane;
  if (here === null) return;
  const places = [...started.values()].filter((p) => p.server === name && p.target === here.target && p.project === here.project);
  const key = keyOf(here.target, here.path, name);
  if (statuses.get(key)?.state !== undefined && statuses.get(key)?.state !== "stopped" && !places.some((p) => p.path === here.path)) places.push({ ...here, server: name });
  for (const place of places) {
    started.delete(keyOf(place.target, place.path, name));
    statuses.delete(keyOf(place.target, place.path, name));
    invoke("lsp_stop", { environment: place.target, worktree: place.path, server: name }).catch(showError);
  }
  statuses.delete(key);
  launches.delete(name);
}

async function saveNow(patch: Patch) {
  const mine = generation;
  if (pane === null || settings === null) return;
  const before = settings;
  let servers = before.servers;
  let at = -1;
  if (patch.server !== undefined) {
    const { name, change } = patch.server;
    at = servers.findIndex((s) => s.name === name);
    if (at < 0) return;
    servers = servers.map((s, i) => (i === at ? { ...s, ...change } : s));
  }
  if (patch.remove !== undefined) servers = servers.filter((s) => s.name !== patch.remove);
  let next: LspRepoSettings;
  try {
    next = await invoke("lsp_settings_set", { settings: { ...before, ...(patch.sshHost === undefined ? {} : { sshHost: patch.sshHost }), servers } });
  } catch (e) {
    if (mine !== generation) return;
    note = String(e);
    draw();
    return;
  }
  if (mine !== generation) return;
  settings = next;
  version++;
  note = null;
  let renamed: string | null = null;
  if (patch.server !== undefined) {
    const was = patch.server.name;
    const now = next.servers[at]?.name;
    if (now !== undefined && now !== was) {
      renamed = now;
      await forget(was);
      if (openName === was) openName = now;
    }
  }
  if (patch.remove !== undefined) {
    await forget(patch.remove);
    if (openName === patch.remove) openName = null;
  }
  draw();
  if (mine !== generation) return;
  if (pane !== null) changed(pane);
  if (patch.sshHost !== undefined) {
    await readServers(
      next.servers.map((s) => s.name),
      mine,
      () => false,
    );
  } else if (patch.server !== undefined) await readServers([renamed ?? patch.server.name], mine, () => renamed !== null);
}

// Saves the card that is not saved yet, now that it has a language.
async function saveDraft() {
  const mine = generation;
  const added = draft;
  if (pane === null || settings === null || added === null) return;
  let next: LspRepoSettings;
  try {
    next = await invoke("lsp_settings_set", { settings: { ...settings, servers: [...settings.servers, added] } });
  } catch (e) {
    if (mine !== generation) return;
    note = String(e);
    draw();
    return;
  }
  if (mine !== generation) return;
  settings = next;
  version++;
  note = null;
  // What was typed into the card while the save was on its way is saved on the saved server, after this one.
  const later = draft;
  draft = null;
  const saved = next.servers[next.servers.length - 1]?.name ?? added.name;
  if (openName === added.name || (later !== null && openName === later.name)) openName = saved;
  if (later !== null && later !== added) {
    const change = Object.fromEntries(Object.entries(later).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(added[key as keyof LspServerSettings]))) as Partial<LspServerSettings>;
    if (Object.keys(change).length > 0) queue(() => saveNow({ server: { name: saved, change } }));
  }
  draw();
  if (pane !== null) changed(pane);
  await readServers([saved], mine, () => true);
}

const queue = (task: () => Promise<void>) => {
  pending++;
  saving = saving.then(task).finally(() => {
    pending--;
  });
};

// A change of the fields of the server `name`: the card that is not saved yet takes it into itself, and is saved once it has a language.
function edit(name: string, change: Partial<LspServerSettings>) {
  if (draft !== null && draft.name === name) {
    draft = { ...draft, ...change };
    if (openName === name) openName = draft.name;
    note = null;
    if (draft.languages.length > 0) queue(saveDraft);
    else drawCards();
    return;
  }
  queue(() => saveNow({ server: { name, change } }));
}

function removeServer(name: string) {
  if (draft !== null && draft.name === name) {
    draft = null;
    if (openName === name) openName = null;
    drawCards();
    return;
  }
  queue(() => saveNow({ remove: name }));
}

// ---- starting and stopping ----

// Starts the server of `place` and keeps what it answers; the later states come by the event.
async function startServer(place: ServerPlace) {
  const key = keyOf(place.target, place.path, place.server);
  started.set(key, place);
  statuses.set(key, await invoke("lsp_start", args(place)));
}

// Runs a press of a card (the restart, the start of the container): the buttons wait, and a failure is the note of the pane.
async function run(kind: "restart" | "container", name: string, action: (place: ServerPlace) => Promise<void>) {
  const here = serverPlace(name);
  if (here === null || busy !== null) return;
  const mine = generation;
  busy = kind;
  note = null;
  drawState();
  try {
    await action(here);
  } catch (e) {
    if (mine === generation) note = String(e);
  }
  if (mine !== generation) {
    // Another worktree is shown now: the one this press was for is only started or not.
    if (busy === kind) busy = null;
    return;
  }
  busy = null;
  drawState();
}

const restartServer = (name: string) =>
  run("restart", name, async (place) => {
    const key = keyOf(place.target, place.path, place.server);
    started.set(key, place);
    statuses.set(key, await invoke("lsp_restart", args(place)));
  });

const startContainer = (name: string) =>
  run("container", name, async (place) => {
    await invoke("lsp_container_start", args(place));
    await startServer(place);
  });

// A file of the worktree was opened (A-34) and `server` takes its language: that server is started when the settings say so, unless it is there already (running, or ended: an ended one is started by the restart or the container button, not by every file). A server found running is the screen's to stop.
export async function ensureServer(place: LspPlace, server: string) {
  const here = { ...place, server };
  const key = keyOf(place.target, place.path, server);
  if (started.has(key) || checking.has(key)) return;
  checking.add(key);
  try {
    const status = await invoke("lsp_status", { environment: place.target, worktree: place.path, server });
    statuses.set(key, status);
    if (status.state !== "stopped") started.set(key, here);
    else if (status.reason === "notStarted" && (await invoke("lsp_settings", { environment: place.target, project: place.project })).servers.find((s) => s.name === server)?.autoStart) await startServer(here);
  } catch (e) {
    showError(e);
  } finally {
    checking.delete(key);
  }
  if (pane?.target === place.target && pane?.path === place.path) drawState();
}

// Stops the servers this screen started whose worktree `gone` says is gone (no tab of it is open, or Orca's list has not the worktree).
export function syncServers(gone: (target: string | null, path: string) => boolean) {
  for (const [key, place] of started) {
    if (!gone(place.target, place.path)) continue;
    started.delete(key);
    invoke("lsp_stop", { environment: place.target, worktree: place.path, server: place.server })
      .then(() => {
        statuses.delete(key);
        if (pane?.target === place.target && pane?.path === place.path) drawState();
      })
      .catch(showError);
  }
}

// ---- the pane ----

function startWatch() {
  if (timer === null) timer = window.setInterval(() => void watch(), periodMs("lspSettings", WATCH_MS));
}

function stopWatch() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

// The Orca screen is left (or the work pane is not shown): nothing is read by the clock until the file pane is drawn again.
export const pauseLsp = stopWatch;

// Whether a question of the Command key may be sent to the server `server` of the worktree: not when it is known to be indexing or stopped (it can only refuse), and when nothing is known of it yet Rust says.
export function mayAsk(target: string | null, path: string, server: string) {
  const state = statuses.get(keyOf(target, path, server))?.state;
  return state === undefined || state === "running";
}

// Follows the file pane: the worktree it shows (null: none) and whether the language server is what it shows. The settings and the way of starting are read when the part is shown, for the worktree that is shown.
export function syncLsp(next: LspPlace | null, visible: boolean) {
  const same = next?.path === pane?.path && next?.target === pane?.target && next?.project === pane?.project;
  if (!same) {
    // A card that is not saved yet and the card that is open belong to the repository: another project drops them.
    if (next?.target !== pane?.target || next?.project !== pane?.project) {
      draft = null;
      openName = null;
    }
    generation++;
    pane = next;
    loaded = false;
    settings = null;
    sshHosts = [];
    launches.clear();
    note = null;
    busy = null;
    reading = false;
    draw();
  }
  if (visible && pane !== null) {
    startWatch();
    if (!loaded) void load();
  } else stopWatch();
}

export function initLsp(on: { changed: (place: LspPlace) => void }) {
  changed = on.changed;
  $("orca-lsp-add").innerHTML = PLUS_SVG;
  $("orca-lsp-add").onclick = () => {
    if (settings === null) return;
    if (draft === null) draft = { name: freeName(), languages: [], autoStart: true, command: null, mount: null, service: null };
    openName = draft.name;
    note = null;
    drawCards();
  };
  $("orca-lsp-ssh").onchange = () => queue(() => saveNow({ sshHost: textOf($("orca-lsp-ssh") as HTMLSelectElement) }));
  window.__TAURI__.event.listen<LspStatusEvent>("lsp-status", ({ payload }) => {
    const key = keyOf(payload.environment ?? null, payload.worktree, payload.server);
    statuses.set(key, payload.status);
    if (pane?.target === (payload.environment ?? null) && pane?.path === payload.worktree) drawState();
  });
}
