// The editor of the Orca screen (A-18): a file of a worktree opened as a tab of the work pane, in a textarea with its text drawn in colors under it (A-21) and the numbers of its lines at its left. Rust reads and saves the text (`orca_file_read`, `orca_file_write`), decides whether a save went through and names the language to color it by; this module draws and takes the typing.
// A file is saved by itself: once the typing has stopped for the time of the settings, the text goes to Rust with the signature of the text that was read, and Orca writes only if the disk still holds it.
// When it does not (the file was changed elsewhere, or is gone), nothing is written and the heading says so; the text stays in the editor and is not tried again until the tab is opened anew.
// Typing that still waits for its timer when the window is closed is sent at once (`pagehide`).
// A scratchpad file of an SSH host (A-30) is a file of this editor too: it has no worktree (`path` is empty) and names its host, and Rust reads and saves it by ssh (`ssh_scratch_read`, `ssh_scratch_write`) with the same answers, so everything else here is the same.
// A file that a pane shows is read again by the clock of the Orca screen, and when it is shown again after it was out of the page (`refreshEditors`, `showEditors`): only a file with no typing that waits for the disk, and its text is replaced, with the caret and the scroll kept, only when the disk holds another text than the one that was read. A read that fails says nothing. A scratchpad file of an SSH host is not read again.
// The open files are kept in memory only, by target and project, as the tabs of the work pane (their ids are `file:{n}`); a tab that is not shown keeps its text, its timer and its save.
// A Markdown file (the language Rust names `markdown`) has two buttons in its heading, the source (`<>`) and the rich view (the pencil), and opens in the rich view (A-26): Milkdown draws the text, without its front matter. The rich view is edited (the edit is put into the text of the textarea by Rust, `markdown_patch`, and saved as any typing is) unless the file does not load and export the same twice or Rust cannot put an edit into it; then it is read only and the file opens in the source. The choice is kept for the file while it is open, in memory only.
import { tag } from "./dom.js";
import { CODE_SVG, EDIT_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { highlightReady, loadHighlight, loadMilkdown } from "./vendor-load.js";

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
  // The SSH host (the `id` of an `OrcaSshTarget`) whose scratchpad holds the file (A-30): `path` is then empty and `relative` is the name of the file. null: a file of a worktree.
  host: string | null;
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
  // The file is being moved (A-18): nothing is saved until the move is over, so that no save goes to the place it leaves.
  held: boolean;
  // The quiet read (`reread`) is on its way; the file was put in a pane once, and was taken out of the page after that (it is read again when it is put back).
  rereading: boolean;
  placed: boolean;
  out: boolean;
  // Focus the text when it is first shown.
  wantFocus: boolean;
  // The grammar of the highlighter for the file (null: none, drawn plain), and how to cancel the drawing of the layer that waits for the next frame or for the wait of a long text (null: none waits).
  highlight: string | null;
  cancelPaint: (() => void) | null;
  // A Markdown file: the buttons of the heading (`modes`, hidden for another file), the view that is shown (`mode`; "rich" is the start), the box of the text and numbers (`body`), the box of the rich view (`rich`) with the Milkdown editor in it (`view`, null: none), and the count that tells a drawing of the rich view that waits for the library that it is out of date.
  // The edit of the rich view: `richBase` is the text of the textarea when the view was drawn and `richBefore` what the editor exported then (the edit is put into `richBase` from them, so the text of the textarea is always the base with the whole edit in it); `richPending`: the document changed and the textarea does not hold it yet, `richTimer` waits to put it there, `richSync` is the put on its way. `richFirst`: the view was not drawn yet (a file that cannot be edited in it opens in the source).
  markdown: boolean;
  mode: "rich" | "source";
  modes: HTMLElement;
  sourceButton: HTMLButtonElement;
  richButton: HTMLButtonElement;
  body: HTMLElement;
  rich: HTMLElement;
  view: MilkdownView | null;
  richTurn: number;
  richBase: string;
  richBefore: string;
  richPending: boolean;
  richTimer: number | null;
  richSync: Promise<void> | null;
  richFirst: boolean;
  el: HTMLElement;
  area: HTMLTextAreaElement;
  // The layer under the textarea that carries the same text in colors.
  code: HTMLElement;
  // The numbers of the lines, one text node ("1\n2\n…") that grows and shrinks at its end with the line count (`lines`), in the box at the left of the text that follows the vertical scroll.
  nums: Text;
  numbers: HTMLElement;
  // The box of the numbers: its width is set (in `ch`) when the number of digits of the last number changes.
  gutter: HTMLElement;
  lines: number;
  state: HTMLElement;
  // The path of the heading.
  where: HTMLElement;
  note: HTMLElement;
}

// Up to this many characters the layer is drawn again once a frame while keys come; a longer text keeps the layer it has (old colors, old text) and is drawn again at most once in COLOR_WAIT_MS, as coloring a file of the size the editor takes (384 KiB) takes longer than a key.
const COLOR_NOW_MAX = 30000;
const COLOR_WAIT_MS = 150;
// After a change of the rich view, how long it waits for more changes before the edit is put into the textarea.
const RICH_WAIT_MS = 200;

const files = new Map<string, EditorFile>();
let lastId = 0;
let autosaveMs = 1000;
let changed: () => void = () => {};
let fail: (e: unknown) => void = () => {};

// The folder of the scratchpad files on an SSH host (A-30), as the screen shows it; Rust alone makes the real path.
export const SSH_SCRATCH_DIR = "~/.local/share/cookapps/scratchpad/";

export const nameOf = (relative: string) => relative.slice(relative.lastIndexOf("/") + 1);

// Sets how long after the typing stops a file is saved (the settings card).
export function setAutosaveMs(ms: number) {
  autosaveMs = ms;
}

const canSave = (f: EditorFile) => f.read === "ready" && f.dirty && !f.blocked && !f.held && f.save !== "error";

function setSave(f: EditorFile, save: Save) {
  f.save = save;
  f.state.textContent = SAVE_LABELS[save];
  f.state.dataset.state = save;
}

// Draws the text of the textarea in the layer under it: in colors by the grammar of the file, else plain. The layer holds the text of the textarea after this.
function draw(f: EditorFile) {
  const text = f.area.value;
  if (f.highlight && highlightReady()) f.code.innerHTML = hljs.highlight(text, { language: f.highlight, ignoreIllegals: true }).value;
  else {
    f.code.textContent = text;
    // highlight.js is read the first time a file is colored; the layer is drawn again, colored, once it is there. A read that fails once gives up the colors of the file while it is open, so a key does not read it again.
    if (f.highlight)
      loadHighlight().then(
        () => drawLater(f, nextFrame),
        (e) => {
          if (!f.highlight) return;
          f.highlight = null;
          fail(e);
        },
      );
  }
}

function cancelPaint(f: EditorFile) {
  f.cancelPaint?.();
  f.cancelPaint = null;
}

// Draws the layer once when the run comes, and asks for nothing more while that waits: the text it draws is the textarea's then.
function drawLater(f: EditorFile, wait: (run: () => void) => () => void) {
  if (f.cancelPaint) return;
  f.cancelPaint = wait(() => {
    f.cancelPaint = null;
    draw(f);
  });
}
const nextFrame = (run: () => void) => {
  const id = requestAnimationFrame(run);
  return () => cancelAnimationFrame(id);
};
const afterColorWait = (run: () => void) => {
  const id = window.setTimeout(run, COLOR_WAIT_MS);
  return () => clearTimeout(id);
};

// The first drawing, when the file is read: a long text is drawn plain at once and colored after COLOR_WAIT_MS.
function paint(f: EditorFile) {
  cancelPaint(f);
  if (f.highlight && f.area.value.length > COLOR_NOW_MAX) {
    f.code.textContent = f.area.value;
    drawLater(f, afterColorWait);
  } else {
    draw(f);
  }
}

// At each key, with the text of the textarea (read once by the caller): the text is drawn again once a frame, or, for a long text, at most once in COLOR_WAIT_MS with the old layer kept till then.
function repaint(f: EditorFile, text: string) {
  if (!f.highlight) draw(f);
  else drawLater(f, text.length <= COLOR_NOW_MAX ? nextFrame : afterColorWait);
}

// The layer under the textarea follows the scroll of the textarea, and the numbers follow its vertical scroll.
function followScroll(f: EditorFile) {
  f.code.style.transform = `translate(${-f.area.scrollLeft}px, ${-f.area.scrollTop}px)`;
  f.numbers.style.transform = `translateY(${-f.area.scrollTop}px)`;
}

// Brings the numbers to the line count of `text`, the value of the textarea: only the numbers that came or went are written, the rest of the text is left as it is. The box is as wide as the digits of the last number, set when their count changes.
function numberLines(f: EditorFile, text: string) {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  if (n === f.lines) return;
  if (n > f.lines) {
    let more = "";
    for (let i = f.lines + 1; i <= n; i++) more += `\n${i}`;
    f.nums.appendData(more);
  } else {
    const data = f.nums.data;
    let end = data.length;
    for (let i = f.lines; i > n; i--) end = data.lastIndexOf("\n", end - 1);
    f.nums.deleteData(end, data.length - end);
  }
  const digits = String(n).length;
  if (digits !== String(f.lines).length) f.gutter.style.setProperty("--digits", String(digits));
  f.lines = n;
}

function clearTimer(f: EditorFile) {
  if (f.timer !== null) clearTimeout(f.timer);
  f.timer = null;
}

// Saves the text now, once at a time: a call while a save is on its way waits for it. Typing that came in meanwhile is saved by a timer that the end of the save sets.
function flush(f: EditorFile): Promise<void> {
  clearTimer(f);
  if (f.writing) return f.writing;
  if (!f.richPending && !canSave(f)) return Promise.resolve();
  // An edit of the rich view that is not in the textarea yet is put there first.
  f.writing = syncRich(f)
    .then(() => (canSave(f) ? write(f) : undefined))
    .finally(() => {
      f.writing = null;
      changed();
    });
  return f.writing;
}

async function write(f: EditorFile) {
  const sent = f.area.value;
  setSave(f, "saving");
  try {
    const saved = f.host === null ? await invoke("orca_file_write", { path: f.path, relative: f.relative, content: sent, crlf: f.crlf, signature: f.signature, environment: f.target }) : await invoke("ssh_scratch_write", { host: f.host, name: f.relative, content: sent, crlf: f.crlf, signature: f.signature });
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

// The text of the textarea changed (typed in the source, or put there from the rich view): draws it again, marks the file as changed and waits for the typing to stop.
function typed(f: EditorFile) {
  // The layers of the textarea are hidden while the rich view is shown: they are drawn when the source is shown (`setMode`).
  if (!(f.markdown && f.mode === "rich")) {
    const value = f.area.value;
    repaint(f, value);
    numberLines(f, value);
  }
  if (!f.dirty) {
    f.dirty = true;
    changed();
  }
  schedule(f);
}

// Waits for the typing to stop, then saves.
function schedule(f: EditorFile) {
  clearTimer(f);
  if (f.blocked) return;
  setSave(f, "pending");
  // A file that is being moved waits for the end of the move (`holdFiles`).
  if (f.held) return;
  f.timer = window.setTimeout(() => void flush(f), autosaveMs);
}

// The document of the rich view changed: the edit is put into the textarea after RICH_WAIT_MS (at most one wait at a time, so the text is put there while the typing goes on).
function richChanged(f: EditorFile) {
  f.richPending = true;
  if (f.richTimer === null)
    f.richTimer = window.setTimeout(() => {
      f.richTimer = null;
      void syncRich(f);
    }, RICH_WAIT_MS);
}

// Puts the edit of the rich view into the textarea (Rust's `markdown_patch` applies it to the text the view was drawn from) and waits until it is there; a call while a put is on its way waits for it.
function syncRich(f: EditorFile): Promise<void> {
  if (f.richTimer !== null) clearTimeout(f.richTimer);
  f.richTimer = null;
  if (!f.richPending) return f.richSync ?? Promise.resolve();
  f.richSync ??= putRich(f).finally(() => {
    f.richSync = null;
  });
  return f.richSync;
}

async function putRich(f: EditorFile) {
  while (f.richPending && f.view) {
    f.richPending = false;
    const turn = f.richTurn;
    try {
      const patched = await invoke("markdown_patch", { original: f.richBase, before: f.richBefore, after: f.view.markdown() });
      if (turn !== f.richTurn) return;
      if (patched.kind === "conflict") {
        // The edit cannot be put into the text: the text stays as it is, and is edited in the source.
        setMode(f, "source");
        fail("リッチビューの編集を元のテキストに反映できません");
        return;
      }
      if (patched.text !== f.area.value) {
        f.area.value = patched.text;
        typed(f);
      }
    } catch (e) {
      if (turn !== f.richTurn) return;
      setMode(f, "source");
      fail(e);
      return;
    }
  }
}

// Takes the Milkdown editor out of the rich view, and cancels a drawing of it that waits.
function clearRich(f: EditorFile) {
  f.richTurn++;
  if (f.richTimer !== null) clearTimeout(f.richTimer);
  f.richTimer = null;
  f.richPending = false;
  const view = f.view;
  f.view = null;
  void view?.destroy().catch(() => {});
  f.rich.replaceChildren();
}

// Draws the text of the file in the rich view: Milkdown is read the first time, and the front matter is cut off by Rust and kept out of the editor. A drawing that is out of date when the library or the cut comes (the view was left, the file closed) is dropped.
// The view is made editable when the editor loads and exports the text to the same text twice and Rust can put the (unchanged) export into the text; else it stays read only, and a file that was just opened is shown in the source.
async function drawRich(f: EditorFile) {
  clearRich(f);
  const turn = f.richTurn;
  const text = f.area.value;
  try {
    const [{ body }] = await Promise.all([invoke("markdown_split", { text }), loadMilkdown()]);
    if (turn !== f.richTurn) return;
    const host = tag("div");
    f.rich.append(host);
    const view = await CookappsMilkdown.mount(host, body);
    if (turn !== f.richTurn) {
      void view.destroy().catch(() => {});
      host.remove();
      return;
    }
    f.view = view;
    const before = view.markdown();
    const [again, patched] = await Promise.all([CookappsMilkdown.normalize(before), invoke("markdown_patch", { original: text, before, after: before })]);
    if (turn !== f.richTurn) return;
    const first = f.richFirst;
    f.richFirst = false;
    if (again === before && patched.kind === "patched" && patched.text === text) {
      f.richBase = text;
      f.richBefore = before;
      view.edit(() => richChanged(f));
    } else if (first) {
      setMode(f, "source");
    }
  } catch (e) {
    if (turn !== f.richTurn) return;
    // The text stays readable: the source is shown.
    setMode(f, "source");
    fail(e);
  }
}

// Shows the source or the rich view of a Markdown file (a file of another language has only its text).
function setMode(f: EditorFile, mode: "rich" | "source") {
  f.mode = mode;
  const rich = f.markdown && mode === "rich";
  f.modes.hidden = !f.markdown;
  f.sourceButton.setAttribute("aria-pressed", String(!rich));
  f.richButton.setAttribute("aria-pressed", String(rich));
  f.body.hidden = rich;
  f.rich.hidden = !rich;
  if (rich) void drawRich(f);
  else {
    clearRich(f);
    // The edits made in the rich view were not drawn in the layers of the textarea.
    if (f.markdown) {
      paint(f);
      numberLines(f, f.area.value);
    }
  }
}

async function load(f: EditorFile) {
  try {
    const text = f.host === null ? await invoke("orca_file_read", { path: f.path, relative: f.relative, environment: f.target }) : await invoke("ssh_scratch_read", { host: f.host, name: f.relative });
    f.area.value = text.content;
    f.highlight = text.highlight;
    f.markdown = text.language === "markdown";
    paint(f);
    numberLines(f, f.area.value);
    f.crlf = text.crlf;
    f.signature = text.signature;
    f.read = "ready";
    f.area.disabled = false;
    setMode(f, f.mode);
  } catch (e) {
    f.read = "failed";
    f.note.textContent = String(e);
    f.note.hidden = false;
    f.area.hidden = true;
    f.area.closest<HTMLElement>(".orca-edit-body")!.hidden = true;
  }
  changed();
}

// Whether the text may be replaced by the disk's: the file is read, is a worktree's, and has no typing that is not on the disk, on its way to it or refused by it.
const canReread = (f: EditorFile) => f.read === "ready" && f.host === null && !f.dirty && !f.blocked && !f.held && !f.richPending && f.richSync === null && f.writing === null && f.timer === null && f.save !== "error";

// Reads the file again without a word (the clock, and a tab shown again). The signature of the read says whether the disk still holds the text that was read: when it does, nothing is drawn. Another text takes the place of the one shown, with the caret, the selection and the scroll where they were (the rich view of a Markdown file is drawn again and keeps its scroll).
// Typing that came while the read was on its way keeps the text as it is, saved by then or not, and a failure keeps what is shown.
async function reread(f: EditorFile) {
  if (f.rereading || !canReread(f)) return;
  const relative = f.relative;
  // A save that ends while the read is on its way gives the file another signature: the answer is then older than the disk.
  const signature = f.signature;
  f.rereading = true;
  try {
    const text = await invoke("orca_file_read", { path: f.path, relative, environment: f.target });
    if (files.get(f.id) !== f || f.relative !== relative || !canReread(f) || f.signature !== signature || text.signature === f.signature) return;
    f.signature = text.signature;
    f.crlf = text.crlf;
    if (text.content === f.area.value) return;
    const area = f.area;
    const [start, end, top, left, richTop] = [area.selectionStart, area.selectionEnd, area.scrollTop, area.scrollLeft, f.rich.scrollTop];
    area.value = text.content;
    area.setSelectionRange(Math.min(start, text.content.length), Math.min(end, text.content.length));
    area.scrollTop = top;
    area.scrollLeft = left;
    f.highlight = text.highlight;
    setSave(f, "idle");
    if (f.markdown && f.mode === "rich") {
      void drawRich(f).then(() => {
        f.rich.scrollTop = richTop;
      });
    } else {
      paint(f);
      numberLines(f, area.value);
      followScroll(f);
    }
  } catch {
    // What is shown stays.
  } finally {
    f.rereading = false;
  }
}

function create(id: string, target: string | null, project: string, path: string, relative: string, host: string | null): EditorFile {
  // The path the heading shows: from the worktree, or the place on the SSH host.
  const shown = host === null ? relative : SSH_SCRATCH_DIR + relative;
  const el = tag("div", "orca-edit");
  el.dataset.file = id;
  const head = tag("div", "orca-edit-head");
  const state = tag("span", "orca-edit-state");
  state.setAttribute("role", "status");
  const sourceButton = tag("button", "icon-btn orca-edit-mode");
  sourceButton.type = "button";
  sourceButton.setAttribute("aria-label", "ソース");
  sourceButton.innerHTML = CODE_SVG;
  const richButton = tag("button", "icon-btn orca-edit-mode");
  richButton.type = "button";
  richButton.setAttribute("aria-label", "リッチ");
  richButton.innerHTML = EDIT_SVG;
  const modes = tag("span", "orca-edit-modes");
  modes.hidden = true;
  modes.append(sourceButton, richButton);
  const where = tag("span", "orca-edit-path", shown);
  head.append(where, state, modes);
  const note = tag("p", "orca-empty feed-empty");
  note.hidden = true;
  const area = tag("textarea", "orca-edit-area");
  area.spellcheck = false;
  area.disabled = true;
  area.setAttribute("aria-label", shown);
  const code = tag("code");
  const layer = tag("pre", "orca-edit-hl");
  layer.setAttribute("aria-hidden", "true");
  layer.append(code);
  const text = tag("div", "orca-edit-text");
  text.append(layer, area);
  const nums = document.createTextNode("1");
  const numbers = tag("div", "orca-edit-nums");
  numbers.append(nums);
  const gutter = tag("div", "orca-edit-gutter");
  gutter.setAttribute("aria-hidden", "true");
  gutter.append(numbers);
  const body = tag("div", "orca-edit-body");
  body.append(gutter, text);
  const rich = tag("div", "orca-edit-rich");
  rich.hidden = true;
  el.append(head, note, body, rich);
  const f: EditorFile = { id, target, project, path, relative, host, signature: "", crlf: false, read: "loading", save: "idle", dirty: false, blocked: false, timer: null, writing: null, held: false, rereading: false, placed: false, out: false, wantFocus: true, highlight: null, cancelPaint: null, markdown: false, mode: "rich", modes, sourceButton, richButton, body, rich, view: null, richTurn: 0, richBase: "", richBefore: "", richPending: false, richTimer: null, richSync: null, richFirst: true, el, area, code, nums, numbers, gutter, lines: 1, state, where, note };
  area.oninput = () => typed(f);
  area.onscroll = () => followScroll(f);
  sourceButton.onclick = async () => {
    if (f.mode === "source") return;
    // The edit of the rich view is in the textarea before the source is shown.
    await syncRich(f);
    setMode(f, "source");
    f.wantFocus = false;
    area.focus({ preventScroll: true });
  };
  richButton.onclick = () => {
    if (f.mode !== "rich") setMode(f, "rich");
  };
  // The wheel over the numbers scrolls the text, as it does over the text: by pixels, by lines (the line height of the text) or by pages (the height of the textarea), as the event counts.
  gutter.onwheel = (e) => {
    const unit = e.deltaMode === 1 ? Number.parseFloat(getComputedStyle(area).lineHeight) : e.deltaMode === 2 ? area.clientHeight : 1;
    area.scrollTop += e.deltaY * unit;
  };
  return f;
}

// Opens the file as a tab of the project and gives its id; a file that is open already is not read here (`showEditors` reads it again when its tab is put back in a pane). With `host`, it is the scratchpad file named `relative` of that SSH host (A-30), and `path` is empty.
export function openFile(target: string | null, project: string, path: string, relative: string, host: string | null = null) {
  const open = [...files.values()].find((f) => f.target === target && f.project === project && f.path === path && f.relative === relative && f.host === host);
  if (open) {
    open.wantFocus = true;
    return open.id;
  }
  const f = create(`file:${++lastId}`, target, project, path, relative, host);
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
  await syncRich(f);
  // A save that failed before is tried again by this close (one try: a failure ends the loop below).
  if (f.save === "error") setSave(f, "pending");
  while (canSave(f)) await flush(f);
  if (f.dirty && !f.blocked) return false;
  clearTimer(f);
  cancelPaint(f);
  clearRich(f);
  f.el.remove();
  files.delete(id);
  return true;
}

// Takes out the tabs of the files of the worktree at `path` that are gone from the disk (A-18): the file `relative`, or with `folder` every file under that folder. Their typing is not saved (there is nothing to save it to), and a save on its way is not waited for. True when a tab was closed.
export function discardFiles(target: string | null, project: string, path: string, relative: string, folder: boolean) {
  const gone = filesOf(target, project).filter((f) => f.path === path && (f.relative === relative || (folder && f.relative.startsWith(`${relative}/`))));
  for (const f of gone) {
    clearTimer(f);
    cancelPaint(f);
    clearRich(f);
    f.el.remove();
    files.delete(f.id);
  }
  return gone.length > 0;
}

// Holds the saves of the open files of the worktree at `path` that a move of `relative` takes along (the file itself, or the files under the folder), and waits for the save of each that is on its way, so that nothing is written to the old place once the move is asked for (A-18). The typing goes on and stays in the tab.
// The function it answers ends the hold: with `to`, the place `relative` was moved to, each file takes its new path (the heading and the name of the tab follow; the text, its signature and the language it was opened with stay), and with null (the move failed) the paths stay. Typing that waited is saved then, to the path the file has now. It answers whether a path changed.
export async function holdFiles(target: string | null, project: string, path: string, relative: string) {
  const moved = filesOf(target, project).filter((f) => f.path === path && !f.held && (f.relative === relative || f.relative.startsWith(`${relative}/`)));
  for (const f of moved) {
    f.held = true;
    clearTimer(f);
  }
  await Promise.all(moved.map((f) => f.writing));
  return (to: string | null) => {
    // A tab that was closed meanwhile is left out.
    const open = moved.filter((f) => files.get(f.id) === f);
    for (const f of open) {
      f.held = false;
      if (to !== null) {
        f.relative = to + f.relative.slice(relative.length);
        const shown = f.host === null ? f.relative : SSH_SCRATCH_DIR + f.relative;
        f.where.textContent = shown;
        f.area.setAttribute("aria-label", shown);
      }
      if (f.dirty && !f.blocked && f.save !== "error") schedule(f);
    }
    return to !== null && open.length > 0;
  };
}

// Reads again, without a word, the files that the panes show now (the clock of the Orca screen, and a branch that changed).
export function refreshEditors() {
  for (const f of files.values()) if (f.el.isConnected) void reread(f);
}

// Shows each file of `placements` in its host element and takes every other file out of the page (it keeps its text). With `fresh`, a file that was out of the page and is put back is read again.
export function showEditors(placements: { id: string; host: HTMLElement }[], fresh: boolean) {
  const shown = new Set(placements.map((p) => p.id));
  for (const [id, f] of files) {
    if (shown.has(id)) continue;
    f.el.remove();
    if (f.placed) f.out = true;
  }
  for (const { id, host } of placements) {
    const f = files.get(id);
    if (!f) continue;
    const back = f.out;
    f.placed = true;
    f.out = false;
    if (f.el.parentElement !== host) {
      host.replaceChildren(f.el);
      // A textarea that was out of the page starts at the top again.
      followScroll(f);
    }
    if (f.wantFocus && !f.area.disabled && !f.area.hidden && !f.body.hidden) {
      f.wantFocus = false;
      f.area.focus({ preventScroll: true });
    }
    if (back && fresh) void reread(f);
  }
}

export function initOrcaEditor(on: { changed: () => void; error: (e: unknown) => void }) {
  changed = on.changed;
  fail = on.error;
  // The page is going away (the window is closed): the typing that waits for its timer is sent now, for every file that can be saved.
  window.addEventListener("pagehide", () => {
    for (const f of files.values()) void flush(f);
  });
}
