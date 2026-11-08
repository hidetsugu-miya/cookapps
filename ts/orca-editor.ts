// The editor of the Orca screen (A-18): a file of a worktree opened as a tab of the work pane, in a textarea. Rust reads and saves the text (`orca_file_read`, `orca_file_write`) and decides whether a save went through; this module draws and takes the typing.
// A file is saved by itself: once the typing has stopped for the time of the settings, the text goes to Rust with the signature of the text that was read, and Orca writes only if the disk still holds it.
// When it does not (the file was changed elsewhere, or is gone), nothing is written and the heading says so; the text stays in the editor and is not tried again until the tab is opened anew.
// The open files are kept in memory only, by target and project, as the tabs of the work pane (their ids are `file:{n}`); a tab that is not shown keeps its text, its timer and its save.
import { tag } from "./dom.js";
import { invoke } from "./ipc.js";

// What the heading says of the save: nothing yet, waiting for the typing to stop, on its way, done, or not done (and why).
type Save = "idle" | "pending" | "saving" | "saved" | "changed" | "missing" | "not-utf8" | "error";

const SAVE_LABELS: Record<Save, string> = {
  idle: "",
  pending: "保存待ち",
  saving: "保存中",
  saved: "保存しました",
  changed: "ディスクのファイルが変わっています",
  missing: "ファイルが見つかりません",
  "not-utf8": "ディスクのファイルが UTF-8 ではなくなっています",
  error: "保存できません",
};

interface EditorFile {
  id: string;
  target: string | null;
  project: string;
  // The worktree, and the file in it (relative).
  path: string;
  relative: string;
  // The text of the read (null until it is read), whether the file has CRLF, and the signature of what the disk held then; a save that went through brings the signature up to date.
  signature: string;
  crlf: boolean;
  read: "loading" | "ready" | "failed";
  save: Save;
  // Typing not on the disk yet.
  dirty: boolean;
  // A save was refused: nothing is saved again.
  blocked: boolean;
  timer: number | null;
  writing: Promise<void> | null;
  // Focus the text when it is first shown.
  wantFocus: boolean;
  el: HTMLElement;
  area: HTMLTextAreaElement;
  state: HTMLElement;
  note: HTMLElement;
}

const files = new Map<string, EditorFile>();
let lastId = 0;
let autosaveMs = 1000;
let changed: () => void = () => {};
let fail: (e: unknown) => void = () => {};

export const nameOf = (relative: string) => relative.slice(relative.lastIndexOf("/") + 1);

// Sets how long after the typing stops a file is saved (the settings card).
export function setAutosaveMs(ms: number) {
  autosaveMs = ms;
}

const canSave = (f: EditorFile) => f.read === "ready" && f.dirty && !f.blocked && f.save !== "error";

function setSave(f: EditorFile, save: Save) {
  f.save = save;
  f.state.textContent = SAVE_LABELS[save];
  f.state.dataset.state = save;
}

function clearTimer(f: EditorFile) {
  if (f.timer !== null) clearTimeout(f.timer);
  f.timer = null;
}

// Saves the text now, once at a time: a call while a save is on its way waits for it. Typing that came in meanwhile is saved by a timer that the end of the save sets.
function flush(f: EditorFile): Promise<void> {
  clearTimer(f);
  if (f.writing) return f.writing;
  if (!canSave(f)) return Promise.resolve();
  f.writing = write(f).finally(() => {
    f.writing = null;
    changed();
  });
  return f.writing;
}

async function write(f: EditorFile) {
  const sent = f.area.value;
  setSave(f, "saving");
  try {
    const saved = await invoke("orca_file_write", { path: f.path, relative: f.relative, content: sent, crlf: f.crlf, signature: f.signature, environment: f.target });
    if (saved.state !== "saved") {
      f.blocked = true;
      setSave(f, saved.state);
      return;
    }
    f.signature = saved.signature;
    if (f.area.value === sent) {
      f.dirty = false;
      setSave(f, "saved");
    } else {
      schedule(f);
    }
  } catch (e) {
    setSave(f, "error");
    fail(e);
  }
}

// Waits for the typing to stop, then saves.
function schedule(f: EditorFile) {
  clearTimer(f);
  if (f.blocked) return;
  setSave(f, "pending");
  f.timer = window.setTimeout(() => void flush(f), autosaveMs);
}

async function load(f: EditorFile) {
  try {
    const text = await invoke("orca_file_read", { path: f.path, relative: f.relative, environment: f.target });
    f.area.value = text.content;
    f.crlf = text.crlf;
    f.signature = text.signature;
    f.read = "ready";
    f.area.disabled = false;
  } catch (e) {
    f.read = "failed";
    f.note.textContent = String(e);
    f.note.hidden = false;
    f.area.hidden = true;
  }
  changed();
}

function create(id: string, target: string | null, project: string, path: string, relative: string): EditorFile {
  const el = tag("div", "orca-edit");
  el.dataset.file = id;
  const head = tag("div", "orca-edit-head");
  const state = tag("span", "orca-edit-state");
  state.setAttribute("role", "status");
  head.append(tag("span", "orca-edit-path", relative), state);
  const note = tag("p", "orca-empty feed-empty");
  note.hidden = true;
  const area = tag("textarea", "orca-edit-area");
  area.spellcheck = false;
  area.disabled = true;
  area.setAttribute("aria-label", relative);
  el.append(head, note, area);
  const f: EditorFile = { id, target, project, path, relative, signature: "", crlf: false, read: "loading", save: "idle", dirty: false, blocked: false, timer: null, writing: null, wantFocus: true, el, area, state, note };
  area.oninput = () => {
    if (!f.dirty) {
      f.dirty = true;
      changed();
    }
    schedule(f);
  };
  return f;
}

// Opens the file as a tab of the project and gives its id; a file that is open already is not read again.
export function openFile(target: string | null, project: string, path: string, relative: string) {
  const open = [...files.values()].find((f) => f.target === target && f.project === project && f.path === path && f.relative === relative);
  if (open) {
    open.wantFocus = true;
    return open.id;
  }
  const f = create(`file:${++lastId}`, target, project, path, relative);
  files.set(f.id, f);
  void load(f);
  return f.id;
}

// The open files of the project, in the order they were opened.
export const filesOf = (target: string | null, project: string) => [...files.values()].filter((f) => f.target === target && f.project === project);

// The ids of the files with typing that is not on the disk.
export const dirtyIds = () => new Set([...files.values()].filter((f) => f.dirty).map((f) => f.id));

// The files of the worktree at `path` that are open in the project, by their relative paths (the file list colors them).
export const openedIn = (target: string | null, project: string, path: string) => new Set(filesOf(target, project).filter((f) => f.path === path).map((f) => f.relative));

// Closes the tab after its typing is saved. A save that cannot be made keeps the tab (its message is shown); one that was refused (the disk changed) is said in the heading already, and the tab closes without it.
export async function closeFile(id: string) {
  const f = files.get(id);
  if (!f) return true;
  // A save that failed before is tried again by this close (one try: a failure ends the loop below).
  if (f.save === "error") setSave(f, "pending");
  while (canSave(f)) await flush(f);
  if (f.dirty && !f.blocked) return false;
  clearTimer(f);
  f.el.remove();
  files.delete(id);
  return true;
}

// Shows each file of `placements` in its host element and takes every other file out of the page (it keeps its text).
export function showEditors(placements: { id: string; host: HTMLElement }[]) {
  const shown = new Set(placements.map((p) => p.id));
  for (const [id, f] of files) if (!shown.has(id)) f.el.remove();
  for (const { id, host } of placements) {
    const f = files.get(id);
    if (!f) continue;
    if (f.el.parentElement !== host) host.replaceChildren(f.el);
    if (f.wantFocus && !f.area.disabled && !f.area.hidden) {
      f.wantFocus = false;
      f.area.focus({ preventScroll: true });
    }
  }
}

export function initOrcaEditor(on: { changed: () => void; error: (e: unknown) => void }) {
  changed = on.changed;
  fail = on.error;
}
