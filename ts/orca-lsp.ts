// The language server of the Orca screen (A-34): the state of a language server for a worktree and its settings, shown under the definition in the file pane, and when it is started and stopped. A repository has any number of servers, each with a name; the pane shows and edits the first one of the settings, and a Ruby file asks Rust for the server that takes `ruby` (`lsp_server_for`).
// Rust starts, keeps and stops the process (`lsp_start`, `lsp_restart`, `lsp_stop`), tells each change of its state (the event `lsp-status`), reads how it is started from the worktree (`lsp_launch`) and saves the settings of the repository (`lsp_settings_set`); this module draws them and takes the presses.
// A Ruby file opened in the editor starts the server of `ruby` of its worktree when the settings say 「自動で起動」 (`ensureServer`); a server this screen started is stopped when no tab of its worktree is open any more, or when Orca's list has not the worktree any more (`syncServers`). The container is started only by its button, never by itself. Nothing is kept outside memory here.
import type { LspLaunch } from "./bindings/LspLaunch";
import type { LspRepoSettings } from "./bindings/LspRepoSettings";
import type { LspServerSettings } from "./bindings/LspServerSettings";
import type { LspStatus } from "./bindings/LspStatus";
import type { LspStatusEvent } from "./bindings/LspStatusEvent";
import { $, tag } from "./dom.js";
import { RELOAD_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { showError } from "./view.js";

// A worktree of a project, where it is (null: this machine).
export interface LspPlace {
  target: string | null;
  project: string;
  path: string;
}

const NOT_STARTED: LspStatus = { state: "stopped", reason: "notStarted" };
const STATE_LABELS = { indexing: "索引中", running: "動作中", stopped: "停止中" };

// A server of a worktree: its name in the settings of the repository too.
interface ServerPlace extends LspPlace {
  server: string;
}

const worktreeKey = (target: string | null, path: string) => JSON.stringify([target, path]);
const keyOf = (target: string | null, path: string, server: string) => JSON.stringify([target, path, server]);

// The servers this screen asked to start, or found running: it stops them.
const started = new Map<string, ServerPlace>();
// The worktrees whose server is being looked at to be started (a second Ruby file opened meanwhile asks nothing more).
const checking = new Set<string>();
// The last state told of each server (a server that was not asked about is not started).
const statuses = new Map<string, LspStatus>();

// The worktree the pane shows (null: none, and the part is hidden), what was read for it, and what is on its way.
let pane: LspPlace | null = null;
let loaded = false;
let settings: LspRepoSettings | null = null;
// The Hosts of this Mac's `~/.ssh/config`, read with the settings of a worktree of a saved environment (empty for this machine's).
let sshHosts: string[] = [];
let launch: LspLaunch | null = null;
let launchError: string | null = null;
// The message of a save, a restart or a start of the container that failed.
let note: string | null = null;
let busy: "restart" | "container" | null = null;
// Another worktree ends the reads of the old one.
let generation = 0;
// The saves, one after another: each takes the settings the one before it saved.
let saving: Promise<void> = Promise.resolve();

// The server the pane shows and edits: the first of the settings (none before they are read, or when the repository has none).
const shownServer = (): LspServerSettings | null => settings?.servers[0] ?? null;
const paneKey = () => {
  const name = shownServer()?.name;
  return pane === null || name === undefined ? null : keyOf(pane.target, pane.path, name);
};
const statusOf = (): LspStatus => statuses.get(paneKey() ?? "") ?? NOT_STARTED;
const args = (place: ServerPlace) => ({ environment: place.target, project: place.project, worktree: place.path, server: place.server });
const serverPlace = (place: LspPlace): ServerPlace | null => {
  const name = shownServer()?.name;
  return name === undefined ? null : { ...place, server: name };
};

// ---- drawing ----

function message(status: LspStatus): string | null {
  if (note !== null) return note;
  if (status.state === "stopped" && status.message) return status.message;
  return launchError;
}

// The state, its message, and the buttons that depend on it.
function drawState() {
  if (pane === null) return;
  const status = statusOf();
  $("orca-lsp-state-text").textContent = `${shownServer()?.name ?? "言語サーバー"} ${STATE_LABELS[status.state]}`;
  const dot = $("orca-lsp-dot");
  dot.dataset.state = status.state;
  if (status.reason) dot.dataset.reason = status.reason;
  else delete dot.dataset.reason;
  const text = message(status);
  const noteBox = $("orca-lsp-note");
  noteBox.hidden = text === null;
  noteBox.textContent = text ?? "";
  ($("orca-lsp-restart") as HTMLButtonElement).disabled = busy !== null;
  const container = $("orca-lsp-container") as HTMLButtonElement;
  container.hidden = !(status.state === "stopped" && status.reason === "containerDown");
  container.disabled = busy !== null;
}

// The fields, from what was read. Only a read or a save redraws them: a field that is being typed in is not touched by the state, nor by a read or a save that ends while it is typed in.
function drawFields() {
  if (pane === null) return;
  const server = shownServer();
  const ready = server !== null;
  const set = (id: string, value: string) => {
    const input = $(id) as HTMLInputElement;
    // The field that is being typed in keeps its text: a save of another field ends meanwhile and draws these.
    if (input !== document.activeElement) input.value = value;
    input.disabled = !ready;
  };
  set("orca-lsp-command", launch?.command ?? "");
  set("orca-lsp-mount", launch?.mount ?? "");
  // The Hosts, with the saved one when the file does not have it (it stays the chosen value).
  const saved = settings?.sshHost ?? "";
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
  $("orca-lsp-ssh-row").hidden = pane.target === null;
  const candidates = launch?.candidates ?? [];
  $("orca-lsp-service-row").hidden = candidates.length < 2;
  const select = $("orca-lsp-service") as HTMLSelectElement;
  select.replaceChildren(
    ...candidates.map((c) => {
      const option = tag("option", "", c.service);
      option.value = c.service;
      return option;
    }),
  );
  select.value = launch?.service ?? "";
  select.disabled = !ready;
  const auto = $("orca-lsp-auto") as HTMLInputElement;
  auto.checked = server?.autoStart ?? true;
  auto.disabled = !ready;
  const method = $("orca-lsp-method");
  method.hidden = launch === null;
  method.textContent = launch === null ? "" : launch.method === "compose" ? `compose の ${launch.service ?? ""}` : launch.method === "host" ? "ホスト" : "方法なし";
  ($("orca-lsp-reset") as HTMLButtonElement).disabled = server === null || (server.command == null && server.mount == null && server.service == null);
}

function draw() {
  $("orca-lsp").hidden = pane === null;
  drawState();
  drawFields();
}

// ---- reading and saving ----

async function readLaunch(mine: number) {
  const here = pane === null ? null : serverPlace(pane);
  if (here === null) return;
  let next: LspLaunch | null = null;
  let error: string | null = null;
  try {
    next = await invoke("lsp_launch", args(here));
  } catch (e) {
    error = String(e);
  }
  if (mine !== generation) return;
  launch = next;
  launchError = error;
  draw();
}

async function load() {
  const here = pane;
  if (here === null) return;
  const mine = generation;
  loaded = true;
  try {
    const read = await invoke("lsp_settings", { environment: here.target, project: here.project });
    if (mine !== generation) return;
    settings = read;
    // The list is read when the field is shown, which is for a saved environment only.
    sshHosts = here.target === null ? [] : await invoke("ssh_hosts");
    if (mine !== generation) return;
    const name = read.servers[0]?.name;
    if (name !== undefined) {
      const status = await invoke("lsp_status", { environment: here.target, worktree: here.path, server: name });
      if (mine !== generation) return;
      statuses.set(keyOf(here.target, here.path, name), status);
    }
  } catch (e) {
    if (mine !== generation) return;
    note = String(e);
    draw();
    return;
  }
  draw();
  await readLaunch(mine);
}

// What a save changes: the ssh Host of the repository, and the fields of the server the pane shows (the first).
interface Patch {
  sshHost?: string | null;
  server?: Partial<LspServerSettings>;
}

async function saveNow(patch: Patch) {
  const mine = generation;
  if (pane === null || settings === null) return;
  try {
    const next = await invoke("lsp_settings_set", {
      settings: { ...settings, ...(patch.sshHost === undefined ? {} : { sshHost: patch.sshHost }), servers: settings.servers.map((s, i) => (i === 0 ? { ...s, ...patch.server } : s)) },
    });
    if (mine !== generation) return;
    settings = next;
    note = null;
  } catch (e) {
    if (mine !== generation) return;
    note = String(e);
    draw();
    return;
  }
  await readLaunch(mine);
}

const save = (patch: Patch) => {
  saving = saving.then(() => saveNow(patch));
};

// The text of a field as a setting: none when it is empty.
const textOf = (id: string) => ($(id) as HTMLInputElement | HTMLSelectElement).value.trim() || null;

// ---- starting and stopping ----

// Starts the server of `place` and keeps what it answers; the later states come by the event.
async function startServer(place: ServerPlace) {
  const key = keyOf(place.target, place.path, place.server);
  started.set(key, place);
  statuses.set(key, await invoke("lsp_start", args(place)));
}

// Runs a press of the pane (the restart, the start of the container): the buttons wait, and a failure is the note of the pane.
async function run(kind: "restart" | "container", action: (place: ServerPlace) => Promise<void>) {
  const here = pane === null ? null : serverPlace(pane);
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

const restart = () =>
  run("restart", async (place) => {
    const key = keyOf(place.target, place.path, place.server);
    started.set(key, place);
    statuses.set(key, await invoke("lsp_restart", args(place)));
  });

const startContainer = () =>
  run("container", async (place) => {
    await invoke("lsp_container_start", args(place));
    await startServer(place);
  });

// A Ruby file of the worktree was opened (A-34): its server is started when the settings say so, unless it is there already (running, or ended: an ended one is started by the restart or the container button, not by every file). A server found running is the screen's to stop.
export async function ensureServer(place: LspPlace) {
  const worktree = worktreeKey(place.target, place.path);
  if ([...started.values()].some((s) => worktreeKey(s.target, s.path) === worktree) || checking.has(worktree)) return;
  checking.add(worktree);
  let key: string | null = null;
  try {
    const server = await invoke("lsp_server_for", { environment: place.target, project: place.project, language: "ruby" });
    if (server !== null) {
      const here = { ...place, server };
      key = keyOf(place.target, place.path, server);
      const status = await invoke("lsp_status", args(here));
      statuses.set(key, status);
      if (status.state !== "stopped") started.set(key, here);
      else if (status.reason === "notStarted" && (await invoke("lsp_settings", { environment: place.target, project: place.project })).servers.find((s) => s.name === server)?.autoStart) await startServer(here);
    }
  } catch (e) {
    showError(e);
  } finally {
    checking.delete(worktree);
  }
  if (key !== null && paneKey() === key) drawState();
}

// Stops the servers this screen started whose worktree `gone` says is gone (no tab of it is open, or Orca's list has not the worktree).
export function syncServers(gone: (target: string | null, path: string) => boolean) {
  for (const [key, place] of started) {
    if (!gone(place.target, place.path)) continue;
    started.delete(key);
    invoke("lsp_stop", { environment: place.target, worktree: place.path, server: place.server })
      .then(() => {
        statuses.delete(key);
        if (paneKey() === key) drawState();
      })
      .catch(showError);
  }
}

// ---- the pane ----

// Follows the file pane: the worktree it shows (null: none) and whether the definition is what it shows. The settings and the way of starting are read when the part is shown, for the worktree that is shown.
export function syncLsp(next: LspPlace | null, visible: boolean) {
  const same = next?.path === pane?.path && next?.target === pane?.target && next?.project === pane?.project;
  if (!same) {
    generation++;
    pane = next;
    loaded = false;
    settings = null;
    sshHosts = [];
    launch = null;
    launchError = null;
    note = null;
    busy = null;
    draw();
  }
  if (visible && pane !== null && !loaded) void load();
}

export function initLsp() {
  $("orca-lsp-restart").innerHTML = RELOAD_SVG;
  $("orca-lsp-restart").onclick = () => void restart();
  $("orca-lsp-container").onclick = () => void startContainer();
  $("orca-lsp-command").onchange = () => {
    const value = textOf("orca-lsp-command");
    if (value !== (launch?.command ?? null)) save({ server: { command: value } });
  };
  $("orca-lsp-mount").onchange = () => {
    const value = textOf("orca-lsp-mount");
    if (value !== (launch?.mount ?? null)) save({ server: { mount: value } });
  };
  $("orca-lsp-service").onchange = () => save({ server: { service: ($("orca-lsp-service") as HTMLSelectElement).value } });
  $("orca-lsp-ssh").onchange = () => save({ sshHost: textOf("orca-lsp-ssh") });
  $("orca-lsp-auto").onchange = () => save({ server: { autoStart: ($("orca-lsp-auto") as HTMLInputElement).checked } });
  $("orca-lsp-reset").onclick = () => save({ server: { command: null, mount: null, service: null } });
  window.__TAURI__.event.listen<LspStatusEvent>("lsp-status", ({ payload }) => {
    const key = keyOf(payload.environment ?? null, payload.worktree, payload.server);
    statuses.set(key, payload.status);
    if (paneKey() === key) drawState();
  });
}
