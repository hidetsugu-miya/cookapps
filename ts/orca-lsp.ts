// The language server of the Orca screen (A-34): the state of the language servers of a worktree and their settings, shown in the file pane as one card for each language, and when they are started and stopped. A repository has one server for each language (a card each), and the language is the server's key in every command; a file whose language a server takes asks Rust for that server (`lsp_server_for`), which answers the language.
// Rust starts, keeps and stops the processes (`lsp_start`, `lsp_restart`, `lsp_stop`), tells each change of their state (the event `lsp-status`), reads how the servers are started from the worktree (`lsp_launches`, once for all of them), finds the languages that the worktree has and the server of the app's table for each (`lsp_detect`) and saves the settings of the repository (`lsp_settings_set`); this module draws them and takes the presses.
// A card of a language that the repository has a server of shows its state and the way it is started; the fields of the settings are opened only by 「手で直す」 of its menu. A language that the worktree has and the repository has no server of is a card of dotted line, where 「使う」 saves the server of the table with nothing replaced. 「使わない」 hides it while this worktree is shown.
// A file opened in the editor starts the server that takes its language when the settings say 「自動で起動」 (`ensureServer`), unless the owner stopped it with 「止める」; a server this screen started is stopped when no tab of its worktree is open any more, or when Orca's list has not the worktree any more (`syncServers`). The container is started only by its button, never by itself. Nothing is kept outside memory here.
// While the part is shown, the settings are read at an interval, so that a change made elsewhere (`tsunagiai-mcp`, A-34) is drawn: the text that is being typed in and the fields that are open stay. The interval stops when the part is hidden, when another worktree is shown or when the project is gone from the list.
import type { LspFound } from "./bindings/LspFound";
import type { LspLanguageLook } from "./bindings/LspLanguageLook";
import type { LspLaunch } from "./bindings/LspLaunch";
import type { LspRepoSettings } from "./bindings/LspRepoSettings";
import type { LspServerSettings } from "./bindings/LspServerSettings";
import type { LspStatus } from "./bindings/LspStatus";
import type { LspStatusEvent } from "./bindings/LspStatusEvent";
import { $, tag } from "./dom.js";
import { periodMs } from "./e2e-timers.js";
import { confirmDelete } from "./hint.js";
import { CLOSE_SVG, DELETE_SVG, EDIT_SVG, MORE_SVG, RELOAD_SVG, SERVER_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { openMenu } from "./menu.js";
import { logError, showFailure } from "./error-card.js";

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

// A server of a worktree: its key is the language it takes.
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
// The servers that the owner stopped with 「止める」: a file opened later does not start them. The restart and the button of the container take them out.
const halted = new Set<string>();

// How a server is started in the worktree that is shown: what `lsp_launches` answered, or why it could not.
interface Read {
  launch: LspLaunch | null;
  error: string | null;
}

// The worktree the pane shows (null: none, and the part is hidden), what was read for it, and what is on its way.
let pane: LspPlace | null = null;
let loaded = false;
let settings: LspRepoSettings | null = null;
// How a language is drawn (read once): the title and the icon.
let looks: Map<string, LspLanguageLook> | null = null;
// The Hosts of this Mac's `~/.ssh/config`, read with the settings of a worktree of a saved environment (empty for this machine's).
let sshHosts: string[] = [];
const launches = new Map<string, Read>();
// What the worktree has and the table gives a server for (null: not read, or it failed), and the languages whose card 「使わない」 hid while this worktree is shown.
let found: LspFound[] | null = null;
const dismissed = new Set<string>();
let detecting = false;
// The number of the last read of the languages: an older one that ends later is dropped.
let detectSeq = 0;
// The card whose fields 「手で直す」 opened (null: none), by its language.
let editing: string | null = null;
// The message of a save, a restart, a stop or a start of the container that failed, and the language of the card it belongs to (null: the heading).
let note: { key: string | null; text: string } | null = null;
let busy: "restart" | "container" | null = null;
// Another worktree ends the reads of the old one.
let generation = 0;
// The saves, one after another: each takes the settings the one before it saved. `version` counts the settings that were taken, `pending` the saves that are not over.
let saving: Promise<void> = Promise.resolve();
let version = 0;
let pending = 0;
let timer: number | null = null;

const statusOf = (language: string): LspStatus => (pane === null ? NOT_STARTED : (statuses.get(keyOf(pane.target, pane.path, language)) ?? NOT_STARTED));
const args = (place: ServerPlace) => ({ environment: place.target, project: place.project, worktree: place.path, server: place.server });
const serverPlace = (language: string): ServerPlace | null => (pane === null ? null : { ...pane, server: language });
const savedServer = (language: string) => settings?.servers.find((s) => s.language === language) ?? null;
const launchOf = (language: string): LspLaunch | null => launches.get(language)?.launch ?? null;
const lookOf = (language: string): { title: string; icon: string | null } => {
  const look = looks?.get(language);
  return { title: look?.title ?? language, icon: look?.icon ?? null };
};

const methodOf = (launch: LspLaunch) => (launch.method === "compose" ? `compose の ${launch.service ?? ""}` : launch.method === "host" ? "ホスト" : "方法なし");
const placeOf = (place: LspFound["place"]) => (place.kind === "compose" ? `compose の ${place.service}` : "ホスト");
// The server that 「使う」 saves for a language found: the one of the table, with nothing replaced.
const autoServer = (f: LspFound): LspServerSettings => ({ language: f.language, name: f.name, autoStart: true, command: null, mount: null, service: null });
// The cards of the languages that the worktree has and the repository has no server of, unless 「使わない」 hid them.
const foundCards = () => (found ?? []).filter((f) => savedServer(f.language) === null && !dismissed.has(f.language));

// ---- drawing ----

// The message of a card: the message of the last press that failed, else, for a server, the message of the stopped state and the message of the reading of the way that failed.
function messageOf(language: string): string | null {
  if (note?.key === language) return note.text;
  if (savedServer(language) === null) return null;
  const status = statusOf(language);
  if (status.state === "stopped" && status.message) return status.message;
  return launches.get(language)?.error ?? null;
}

// The line of each card, and the line under the heading for a message that no card holds (a read of the settings that failed, a press of the heading).
function drawNote() {
  const roots = [...$("orca-lsp-cards").querySelectorAll<HTMLElement>(".orca-lsp-card")];
  for (const root of roots) {
    const line = root.querySelector<HTMLElement>(".orca-lsp-note")!;
    const text = messageOf(root.dataset.name ?? "");
    line.hidden = text === null;
    line.textContent = text ?? "";
  }
  const loose = note !== null && !roots.some((root) => root.dataset.name === note?.key) ? note.text : null;
  $("orca-lsp-error").hidden = loose === null;
  $("orca-lsp-error").textContent = loose ?? "";
}

// The state of every card of a server and the buttons that depend on it. A card is not drawn again: only its words change.
function drawState() {
  for (const root of $("orca-lsp-cards").querySelectorAll<HTMLElement>('.orca-lsp-card[data-kind="server"]')) {
    const language = root.dataset.name ?? "";
    const server = savedServer(language);
    const status = statusOf(language);
    const dot = root.querySelector<HTMLElement>(".orca-lsp-dot")!;
    dot.dataset.state = status.state;
    if (status.reason) dot.dataset.reason = status.reason;
    else delete dot.dataset.reason;
    root.querySelector(".orca-lsp-state")!.textContent = STATE_LABELS[status.state];
    const launch = launchOf(language);
    if (server !== null) root.querySelector(".orca-lsp-summary")!.textContent = [server.name, launch === null ? "" : methodOf(launch)].filter((part) => part !== "").join(" ・ ");
    const container = root.querySelector<HTMLButtonElement>(".orca-lsp-container")!;
    container.hidden = !(status.state === "stopped" && status.reason === "containerDown");
    container.disabled = busy !== null;
  }
  for (const container of $("orca-lsp-cards").querySelectorAll<HTMLButtonElement>('.orca-lsp-card[data-kind="found"] .orca-lsp-container')) container.disabled = busy !== null;
  drawNote();
}

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

// The icon of a language (A-34): an SVG of JetBrains' that the app holds (src/vendor/jetbrains-icons/), drawn as an image of the same origin, else the line drawing of a server.
function languageIcon(language: string): HTMLElement {
  const node = tag("span", "orca-lsp-ic");
  const { icon } = lookOf(language);
  if (icon === null) node.innerHTML = SERVER_SVG;
  else {
    const image = document.createElement("img");
    image.src = `vendor/jetbrains-icons/${icon}.svg`;
    image.alt = "";
    image.draggable = false;
    node.append(image);
  }
  return node;
}

// The fields of the settings of a server, opened by 「手で直す」: the command and the path of the worktree in the server hold what was decided (the saved value, else the decided one) with the mark 「自動」 while nothing is saved.
function body(server: LspServerSettings): HTMLElement {
  const key = server.language;
  const launch = launchOf(key);
  const box = tag("div", "orca-lsp-body");

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
  service.onchange = () => edit(key, { service: service.value });

  const command = textInput("orca-lsp-command", "command", launch === null ? (server.command ?? "") : (launch.command ?? ""));
  command.onchange = () => {
    const value = textOf(command);
    if (value !== (launch === null ? (server.command ?? null) : (launch.command ?? null))) edit(key, { command: value });
  };
  const commandAuto = autoMark();
  commandAuto.id = "orca-lsp-command-auto";
  commandAuto.hidden = server.command != null || launch?.command == null;
  const commandBox = tag("div", "orca-lsp-field");
  commandBox.append(command, commandAuto);

  const mount = textInput("orca-lsp-mount", "mount", launch === null ? (server.mount ?? "") : (launch.mount ?? ""));
  mount.onchange = () => {
    const value = textOf(mount);
    if (value !== (launch === null ? (server.mount ?? null) : (launch.mount ?? null))) edit(key, { mount: value });
  };
  const mountAuto = autoMark();
  mountAuto.id = "orca-lsp-mount-auto";
  mountAuto.hidden = server.mount != null || launch?.mount == null;
  const mountBox = tag("div", "orca-lsp-field");
  mountBox.append(mount, mountAuto);

  const auto = tag("input");
  auto.type = "checkbox";
  auto.id = "orca-lsp-auto";
  auto.checked = server.autoStart;
  auto.onchange = () => edit(key, { autoStart: auto.checked });
  const autoLabel = tag("label", "orca-lsp-auto-label");
  autoLabel.append(auto, "自動で起動");

  const reset = tag("button", "text-btn", "自動に戻す");
  reset.id = "orca-lsp-reset";
  reset.type = "button";
  reset.disabled = server.command == null && server.mount == null && server.service == null;
  reset.onclick = () => edit(key, { command: null, mount: null, service: null });
  const foot = tag("div", "orca-lsp-foot");
  foot.append(autoLabel, reset);

  // The choice of the service is shown only when several services mount the worktree.
  box.append(...(candidates.length < 2 ? [] : [row("サービス", "orca-lsp-service", service)]), row("起動コマンド", "orca-lsp-command", commandBox), row("worktree", "orca-lsp-mount", mountBox), foot);
  return box;
}

function containerButton(onclick: () => void): HTMLButtonElement {
  const container = tag("button", "text-btn orca-lsp-container", "コンテナを起動");
  container.type = "button";
  container.hidden = true;
  container.onclick = onclick;
  return container;
}

function noteLine(): HTMLElement {
  const line = tag("p", "orca-file-note fail orca-lsp-note", "");
  line.setAttribute("role", "alert");
  line.hidden = true;
  return line;
}

// The card of a language that the repository has a server of.
function card(server: LspServerSettings): HTMLElement {
  const key = server.language;
  const root = tag("div", "orca-lsp-card");
  root.dataset.name = key;
  root.dataset.kind = "server";
  const head = tag("div", "orca-lsp-card-head");
  const status = tag("span", "orca-lsp-status");
  const state = tag("span", "orca-lsp-state");
  state.setAttribute("role", "status");
  status.append(tag("span", "orca-lsp-dot"), state);
  const menu = tag("button", "icon-btn orca-lsp-menu");
  menu.type = "button";
  menu.setAttribute("aria-label", "メニュー");
  menu.innerHTML = MORE_SVG;
  menu.onclick = () =>
    openMenu(menu, [
      { label: "再起動", color: "", icon: RELOAD_SVG, current: false, disabled: busy !== null, pick: () => void restartServer(key) },
      { label: "止める", color: "", icon: CLOSE_SVG, current: false, disabled: busy !== null, pick: () => void stopServer(key) },
      { label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, pick: () => confirmDelete(menu, lookOf(key).title, () => removeServer(key)) },
      {
        label: "手で直す",
        color: "",
        icon: EDIT_SVG,
        current: editing === key,
        pick: () => {
          editing = editing === key ? null : key;
          drawCards();
        },
      },
    ]);
  head.append(languageIcon(key), tag("span", "orca-lsp-name", lookOf(key).title), status, menu);
  root.append(head, tag("div", "orca-lsp-summary"), noteLine(), containerButton(() => void startContainer(key)));
  if (editing === key) root.append(body(server));
  return root;
}

// The card of a language that the worktree has and the repository has no server of: dotted, with what the table gives.
function foundCard(f: LspFound): HTMLElement {
  const root = tag("div", "orca-lsp-card");
  root.dataset.name = f.language;
  root.dataset.kind = "found";
  root.dataset.found = f.state;
  const head = tag("div", "orca-lsp-card-head");
  head.append(languageIcon(f.language), tag("span", "orca-lsp-name", lookOf(f.language).title));
  const line = tag("div", "orca-lsp-summary", f.state === "found" ? `${f.name} ・ ${placeOf(f.place)}` : f.state === "missing" ? "サーバーがありません" : "コンテナが止まっています");
  root.append(head, line, noteLine());
  if (f.state === "found") {
    const skip = tag("button", "text-btn orca-lsp-skip", "使わない");
    skip.type = "button";
    skip.onclick = () => {
      dismissed.add(f.language);
      drawCards();
    };
    const use = tag("button", "text-btn orca-lsp-use", "使う");
    use.type = "button";
    use.onclick = () => queue(() => saveNow({ add: autoServer(f) }));
    const actions = tag("div", "orca-lsp-actions");
    actions.append(skip, use);
    root.append(actions);
  } else if (f.state === "containerDown") {
    // The container is started for a server of the repository, so the server of the table is saved as 「使う」 does, and then its container is started.
    const container = containerButton(() =>
      queue(async () => {
        await saveNow({ add: autoServer(f) });
        if (savedServer(f.language) !== null) void startContainer(f.language);
      }),
    );
    container.hidden = false;
    const actions = tag("div", "orca-lsp-actions");
    actions.append(container);
    root.append(actions);
  }
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
  $("orca-lsp-cards").replaceChildren(...(settings?.servers ?? []).map(card), ...foundCards().map(foundCard));
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

function drawReload() {
  ($("orca-lsp-reload") as HTMLButtonElement).disabled = settings === null || detecting;
}

function draw() {
  $("orca-lsp").hidden = pane === null;
  if (pane === null) return;
  drawReload();
  drawSsh();
  drawCards();
}

// ---- reading ----

// Reads how the servers of the languages `targets` are started in the worktree, in one read of the worktree (and, for the servers that `withStatus` names, not asked about yet, their state).
async function readServers(targets: string[], mine: number, withStatus: (language: string) => boolean) {
  const here = pane;
  if (here === null || targets.length === 0) return;
  const [launched, states] = await Promise.all([
    invoke("lsp_launches", { environment: here.target, project: here.project, worktree: here.path, servers: targets }).then(
      (all) => ({ all, error: null }),
      (e) => ({ all: null, error: String(e) }),
    ),
    Promise.allSettled(targets.map((language) => (withStatus(language) ? invoke("lsp_status", { environment: here.target, worktree: here.path, server: language }) : Promise.resolve(null)))),
  ]);
  if (mine !== generation) return;
  for (const [i, language] of targets.entries()) {
    launches.set(language, launched.all === null ? { launch: null, error: launched.error } : { launch: launched.all[i] ?? null, error: null });
    const state = states[i];
    if (state.status === "fulfilled" && state.value !== null) statuses.set(keyOf(here.target, here.path, language), state.value);
  }
  drawCards();
}

// Reads the languages that the worktree has and the server of the table for each (`lsp_detect`): when the part is shown, by the reload button, and after the ssh Host changed. The cards of the languages that the repository has no server of are drawn from it; a failure is the line under the heading.
async function detect(mine: number) {
  const here = pane;
  if (here === null) return;
  const seq = ++detectSeq;
  detecting = true;
  drawReload();
  try {
    const all = await invoke("lsp_detect", { environment: here.target, project: here.project, worktree: here.path });
    if (mine !== generation || seq !== detectSeq) return;
    found = all;
  } catch (e) {
    if (mine !== generation || seq !== detectSeq) return;
    found = null;
    note = { key: null, text: String(e) };
  } finally {
    if (mine === generation && seq === detectSeq) {
      detecting = false;
      drawReload();
    }
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
      looks === null ? invoke("lsp_language_looks") : Promise.resolve([...looks.values()]),
      Promise.all(read.servers.map((s) => invoke("lsp_status", { environment: here.target, worktree: here.path, server: s.language }))),
    ]);
    if (mine !== generation) return;
    settings = read;
    version++;
    sshHosts = hosts;
    looks = new Map(all.map((look) => [look.language, look]));
    for (const [i, s] of read.servers.entries()) statuses.set(keyOf(here.target, here.path, s.language), states[i]);
  } catch (e) {
    if (mine !== generation) return;
    note = { key: null, text: String(e) };
    draw();
    return;
  }
  draw();
  void detect(mine);
  await readServers(
    read.servers.map((s) => s.language),
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
  for (const gone of before.servers.filter((b) => !read.servers.some((s) => s.language === b.language))) void forget(gone.language);
  if (editing !== null && savedServer(editing) === null) editing = null;
  draw();
  const ssh = before.sshHost !== read.sshHost;
  changed(here);
  await readServers(
    read.servers.filter((s) => ssh || !same(s)).map((s) => s.language),
    mine,
    (language) => !before.servers.some((b) => b.language === language),
  );
}

// ---- saving ----

// What a save changes: the ssh Host of the repository, a server (by its language), a server taken away, or a server added.
interface Patch {
  sshHost?: string | null;
  server?: { language: string; change: Partial<LspServerSettings> };
  remove?: string;
  add?: LspServerSettings;
}

// Stops what runs for the server of a language that was deleted, and drops what is known of it.
async function forget(language: string) {
  const here = pane;
  if (here === null) return;
  const places = [...started.values()].filter((p) => p.server === language && p.target === here.target && p.project === here.project);
  const key = keyOf(here.target, here.path, language);
  if (statuses.get(key)?.state !== undefined && statuses.get(key)?.state !== "stopped" && !places.some((p) => p.path === here.path)) places.push({ ...here, server: language });
  for (const place of places) {
    started.delete(keyOf(place.target, place.path, language));
    statuses.delete(keyOf(place.target, place.path, language));
    halted.delete(keyOf(place.target, place.path, language));
    invoke("lsp_stop", { environment: place.target, worktree: place.path, server: language }).catch((e) => showFailure("orca-lsp", e));
  }
  statuses.delete(key);
  halted.delete(key);
  launches.delete(language);
}

async function saveNow(patch: Patch) {
  const mine = generation;
  if (pane === null || settings === null) return;
  const before = settings;
  let servers = before.servers;
  if (patch.server !== undefined) {
    const { language, change } = patch.server;
    if (!servers.some((s) => s.language === language)) return;
    servers = servers.map((s) => (s.language === language ? { ...s, ...change } : s));
  }
  if (patch.remove !== undefined) servers = servers.filter((s) => s.language !== patch.remove);
  if (patch.add !== undefined) servers = [...servers, patch.add];
  const language = patch.server?.language ?? patch.remove ?? patch.add?.language ?? null;
  let next: LspRepoSettings;
  try {
    next = await invoke("lsp_settings_set", { settings: { ...before, ...(patch.sshHost === undefined ? {} : { sshHost: patch.sshHost }), servers } });
  } catch (e) {
    if (mine !== generation) return;
    note = { key: language, text: String(e) };
    draw();
    return;
  }
  if (mine !== generation) return;
  settings = next;
  version++;
  note = null;
  if (patch.remove !== undefined) {
    await forget(patch.remove);
    if (editing === patch.remove) editing = null;
  }
  draw();
  if (mine !== generation) return;
  if (pane !== null) changed(pane);
  if (patch.sshHost !== undefined) {
    // The Host is the route of every read of the worktree, so the languages are found again too.
    void detect(mine);
    await readServers(
      next.servers.map((s) => s.language),
      mine,
      () => false,
    );
  } else if (patch.server !== undefined) await readServers([patch.server.language], mine, () => false);
  else if (patch.add !== undefined) await readServers([patch.add.language], mine, () => true);
}

const queue = (task: () => Promise<void>) => {
  pending++;
  saving = saving.then(task).finally(() => {
    pending--;
  });
};

// A change of the fields of the server of `language`.
const edit = (language: string, change: Partial<LspServerSettings>) => queue(() => saveNow({ server: { language, change } }));

const removeServer = (language: string) => queue(() => saveNow({ remove: language }));

// ---- starting and stopping ----

// Starts the server of `place` and keeps what it answers; the later states come by the event.
async function startServer(place: ServerPlace) {
  const key = keyOf(place.target, place.path, place.server);
  started.set(key, place);
  halted.delete(key);
  statuses.set(key, await invoke("lsp_start", args(place)));
}

// Runs a press of a card (the restart, the start of the container): the buttons wait, and a failure is the note of the card.
async function run(kind: "restart" | "container", language: string, action: (place: ServerPlace) => Promise<void>) {
  const here = serverPlace(language);
  if (here === null || busy !== null) return;
  const mine = generation;
  busy = kind;
  note = null;
  drawState();
  try {
    await action(here);
  } catch (e) {
    if (mine === generation) note = { key: language, text: String(e) };
  }
  if (mine !== generation) {
    // Another worktree is shown now: the one this press was for is only started or not.
    if (busy === kind) busy = null;
    return;
  }
  busy = null;
  drawState();
}

const restartServer = (language: string) =>
  run("restart", language, async (place) => {
    const key = keyOf(place.target, place.path, place.server);
    started.set(key, place);
    halted.delete(key);
    statuses.set(key, await invoke("lsp_restart", args(place)));
  });

// 「止める」: stops the server, and a file opened later does not start it (the restart does).
async function stopServer(language: string) {
  const here = serverPlace(language);
  if (here === null) return;
  const mine = generation;
  const key = keyOf(here.target, here.path, language);
  halted.add(key);
  started.delete(key);
  note = null;
  try {
    await invoke("lsp_stop", { environment: here.target, worktree: here.path, server: language });
    statuses.set(key, NOT_STARTED);
  } catch (e) {
    if (mine === generation) note = { key: language, text: String(e) };
  }
  if (mine === generation) drawState();
}

const startContainer = (language: string) =>
  run("container", language, async (place) => {
    await invoke("lsp_container_start", args(place));
    await startServer(place);
  });

// A file of the worktree was opened (A-34) and `server` takes its language: that server is started when the settings say so, unless it is there already (running, or ended: an ended one is started by the restart or the container button, not by every file). A server found running is the screen's to stop.
export async function ensureServer(place: LspPlace, server: string) {
  const here = { ...place, server };
  const key = keyOf(place.target, place.path, server);
  if (started.has(key) || checking.has(key) || halted.has(key)) return;
  checking.add(key);
  try {
    const status = await invoke("lsp_status", { environment: place.target, worktree: place.path, server });
    statuses.set(key, status);
    if (status.state !== "stopped") started.set(key, here);
    else if (status.reason === "notStarted" && (await invoke("lsp_settings", { environment: place.target, project: place.project })).servers.find((s) => s.language === server)?.autoStart) await startServer(here);
  } catch (e) {
    logError("orca-lsp", e);
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
      .catch((e) => logError("orca-lsp", e));
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
    generation++;
    pane = next;
    loaded = false;
    settings = null;
    sshHosts = [];
    launches.clear();
    found = null;
    dismissed.clear();
    detecting = false;
    editing = null;
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
  $("orca-lsp-reload").innerHTML = RELOAD_SVG;
  // The reload finds the languages again, and shows the cards that 「使わない」 hid.
  $("orca-lsp-reload").onclick = () => {
    if (settings === null) return;
    dismissed.clear();
    note = null;
    void detect(generation);
  };
  $("orca-lsp-ssh").onchange = () => queue(() => saveNow({ sshHost: textOf($("orca-lsp-ssh") as HTMLSelectElement) }));
  window.__TAURI__.event.listen<LspStatusEvent>("lsp-status", ({ payload }) => {
    const key = keyOf(payload.environment ?? null, payload.worktree, payload.server);
    statuses.set(key, payload.status);
    if (pane?.target === (payload.environment ?? null) && pane?.path === payload.worktree) drawState();
  });
}
