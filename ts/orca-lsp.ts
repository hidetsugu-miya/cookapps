// The language server of the Orca screen (A-34): the state of ruby-lsp for a worktree and its settings, shown under the definition in the file pane, and when it is started and stopped.
// Rust starts, keeps and stops the process (`lsp_start`, `lsp_stop`), tells each change of its state (the event `lsp-status`), reads how it is started from the worktree (`lsp_launch`) and saves the settings of the repository (`lsp_settings_set`); this module draws them and takes the presses.
// A Ruby file opened in the editor starts the server of its worktree when the settings say 「自動で起動」 (`ensureServer`); a server this screen started is stopped when no tab of its worktree is open any more, or when Orca's list has not the worktree any more (`syncServers`). The container is started only by its button, never by itself. Nothing is kept outside memory here.
import type { LspLaunch } from "./bindings/LspLaunch";
import type { LspRepoSettings } from "./bindings/LspRepoSettings";
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

const keyOf = (target: string | null, path: string) => JSON.stringify([target, path]);

// The servers this screen asked to start, or found running: it stops them.
const started = new Map<string, LspPlace>();
// The worktrees whose server is being looked at to be started (a second Ruby file opened meanwhile asks nothing more).
const checking = new Set<string>();
// The last state told of each server (a worktree with none is not started).
const statuses = new Map<string, LspStatus>();

// The worktree the pane shows (null: none, and the part is hidden), what was read for it, and what is on its way.
let pane: LspPlace | null = null;
let loaded = false;
let settings: LspRepoSettings | null = null;
let launch: LspLaunch | null = null;
let launchError: string | null = null;
// The message of a save, a restart or a start of the container that failed.
let note: string | null = null;
let busy: "restart" | "container" | null = null;
// Another worktree ends the reads of the old one.
let generation = 0;
// The saves, one after another: each takes the settings the one before it saved.
let saving: Promise<void> = Promise.resolve();

const paneKey = () => (pane === null ? null : keyOf(pane.target, pane.path));
const statusOf = (): LspStatus => statuses.get(paneKey() ?? "") ?? NOT_STARTED;
const args = (place: LspPlace) => ({ environment: place.target, project: place.project, worktree: place.path });

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
  $("orca-lsp-state-text").textContent = `ruby-lsp ${STATE_LABELS[status.state]}`;
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

// The fields, from what was read. Only a read or a save redraws them: a field that is being typed in is not touched by the state.
function drawFields() {
  if (pane === null) return;
  const ready = settings !== null;
  const set = (id: string, value: string) => {
    const input = $(id) as HTMLInputElement;
    input.value = value;
    input.disabled = !ready;
  };
  set("orca-lsp-command", launch?.command ?? "");
  set("orca-lsp-mount", launch?.mount ?? "");
  set("orca-lsp-ssh", settings?.sshHost ?? "");
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
  auto.checked = settings?.autoStart ?? true;
  auto.disabled = !ready;
  const method = $("orca-lsp-method");
  method.hidden = launch === null;
  method.textContent = launch === null ? "" : launch.method === "compose" ? `compose の ${launch.service ?? ""}` : launch.method === "host" ? "ホスト" : "方法なし";
  ($("orca-lsp-reset") as HTMLButtonElement).disabled = settings === null || (settings.command == null && settings.mount == null && settings.service == null);
}

function draw() {
  $("orca-lsp").hidden = pane === null;
  drawState();
  drawFields();
}

// ---- reading and saving ----

async function readLaunch(mine: number) {
  const here = pane;
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
    const [read, status] = await Promise.all([invoke("lsp_settings", { environment: here.target, project: here.project }), invoke("lsp_status", { environment: here.target, worktree: here.path })]);
    if (mine !== generation) return;
    settings = read;
    statuses.set(keyOf(here.target, here.path), status);
  } catch (e) {
    if (mine !== generation) return;
    note = String(e);
    draw();
    return;
  }
  draw();
  await readLaunch(mine);
}

async function saveNow(patch: Partial<LspRepoSettings>) {
  const mine = generation;
  if (pane === null || settings === null) return;
  try {
    const next = await invoke("lsp_settings_set", { settings: { ...settings, ...patch } });
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

const save = (patch: Partial<LspRepoSettings>) => {
  saving = saving.then(() => saveNow(patch));
};

// The text of a field as a setting: none when it is empty.
const textOf = (id: string) => ($(id) as HTMLInputElement).value.trim() || null;

// ---- starting and stopping ----

// Starts the server of `place` and keeps what it answers; the later states come by the event.
async function startServer(place: LspPlace) {
  started.set(keyOf(place.target, place.path), place);
  statuses.set(keyOf(place.target, place.path), await invoke("lsp_start", args(place)));
}

// Runs a press of the pane (the restart, the start of the container): the buttons wait, and a failure is the note of the pane.
async function run(kind: "restart" | "container", action: (place: LspPlace) => Promise<void>) {
  const here = pane;
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
    await invoke("lsp_stop", { environment: place.target, worktree: place.path });
    await startServer(place);
  });

const startContainer = () =>
  run("container", async (place) => {
    await invoke("lsp_container_start", args(place));
    await startServer(place);
  });

// A Ruby file of the worktree was opened (A-34): its server is started when the settings say so, unless it is there already (running, or ended: an ended one is started by the restart or the container button, not by every file). A server found running is the screen's to stop.
export async function ensureServer(place: LspPlace) {
  const key = keyOf(place.target, place.path);
  if (started.has(key) || checking.has(key)) return;
  checking.add(key);
  try {
    const status = await invoke("lsp_status", { environment: place.target, worktree: place.path });
    statuses.set(key, status);
    if (status.state !== "stopped") started.set(key, place);
    else if (status.reason === "notStarted" && (await invoke("lsp_settings", { environment: place.target, project: place.project })).autoStart) await startServer(place);
  } catch (e) {
    showError(e);
  } finally {
    checking.delete(key);
  }
  if (paneKey() === key) drawState();
}

// Stops the servers this screen started whose worktree `gone` says is gone (no tab of it is open, or Orca's list has not the worktree).
export function syncServers(gone: (target: string | null, path: string) => boolean) {
  for (const [key, place] of started) {
    if (!gone(place.target, place.path)) continue;
    started.delete(key);
    invoke("lsp_stop", { environment: place.target, worktree: place.path })
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
    if (value !== (launch?.command ?? null)) save({ command: value });
  };
  $("orca-lsp-mount").onchange = () => {
    const value = textOf("orca-lsp-mount");
    if (value !== (launch?.mount ?? null)) save({ mount: value });
  };
  $("orca-lsp-service").onchange = () => save({ service: ($("orca-lsp-service") as HTMLSelectElement).value });
  $("orca-lsp-ssh").onchange = () => save({ sshHost: textOf("orca-lsp-ssh") });
  $("orca-lsp-auto").onchange = () => save({ autoStart: ($("orca-lsp-auto") as HTMLInputElement).checked });
  $("orca-lsp-reset").onclick = () => save({ command: null, mount: null, service: null });
  window.__TAURI__.event.listen<LspStatusEvent>("lsp-status", ({ payload }) => {
    const key = keyOf(payload.environment ?? null, payload.worktree);
    statuses.set(key, payload.status);
    if (paneKey() === key) drawState();
  });
}
