// The right drawer of a decision page (A-41, #1158): what a card, a change section or an entry of the page folds (「詳しく見る」, its evidence, 「根拠を見る」, 「中身を見る」) is shown here and not in the text, and so is the file that a code name of the page points at. The drawer is an overlay on the right of the page. Its head reads 「{owner} — {fold}」, the folds of one owner are its tabs, and the ×, Escape and nothing else close it.
// Every fold is drawn when the page is drawn and waits in the drawer, out of sight, so that each is in the page once; the diagrams and images in it wait until it is shown (`paintPending`). The text is the child's, so what goes in is made by the callers as `textContent`.
import { tag } from "./dom.js";

// The diagrams and the images that wait for their fold to be shown or opened: the function that draws one, by its box.
export const pending = new WeakMap<HTMLElement, () => void>();

// Draws the waiting diagrams and images of `root` that no closed `details` hides.
export function paintPending(root: HTMLElement) {
  for (const box of root.querySelectorAll<HTMLElement>(".fp-diagram-box[data-pending], .fp-image-box[data-pending]")) {
    if (box.closest("details:not([open])") !== null) continue;
    delete box.dataset.pending;
    pending.get(box)?.();
    pending.delete(box);
  }
}

// What an owner holds: its title (the number and the title of a card, or the heading of a change section or an entry) and its folds in page order.
interface Owner {
  title: string;
  folds: Fold[];
}

export interface Fold {
  label: string;
  owner: Owner;
  panel: HTMLElement;
}

// The lines of a file that the page holds: all of them when it holds the file whole (a listed Markdown or text file), else the lines of its excerpts.
interface Held {
  whole: boolean;
  lines: Map<number, string>;
}

interface Ref {
  key: string;
  start: number;
  end: number;
}

export interface Drawer {
  el: HTMLElement;
  held: Map<string, Held>;
  show: (fold: Fold, opener: HTMLElement | null) => void;
  showFile: (ref: Ref, fromFold: boolean) => void;
  hide: () => void;
  isOpen: () => boolean;
  panels: HTMLElement;
}

// The drawers of the pages drawn: Escape closes the one that is in view.
const drawers = new Set<Drawer>();
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const drawer of drawers) {
    if (!drawer.el.isConnected) drawers.delete(drawer);
    else if (drawer.isOpen() && drawer.el.getClientRects().length > 0) drawer.hide();
  }
});

export function createDrawer(): Drawer {
  const el = tag("aside", "fp-drawer");
  el.hidden = true;
  el.setAttribute("aria-label", "詳細");
  const back = tag("button", "text-btn fp-dr-back", "← 戻る");
  back.type = "button";
  back.hidden = true;
  const title = tag("span", "fp-dr-title");
  const close = tag("button", "fp-dr-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "閉じる");
  const head = tag("div", "fp-dr-head");
  head.append(back, title, close);
  const tabs = tag("div", "fp-dr-tabs");
  tabs.setAttribute("role", "tablist");
  const panels = tag("div", "fp-dr-body");
  const foldView = tag("div", "fp-dr-fold");
  foldView.append(tabs, panels);
  const note = tag("p", "fp-muted fp-dr-note");
  const lines = tag("div", "fp-dr-lines fp-code");
  const fileView = tag("div", "fp-dr-file");
  fileView.append(note, lines);
  fileView.hidden = true;
  el.append(head, foldView, fileView);
  let shown: Fold | null = null;
  let opener: HTMLElement | null = null;

  const view = (name: "fold" | "file", text: string, withBack: boolean) => {
    foldView.hidden = name !== "fold";
    fileView.hidden = name !== "file";
    back.hidden = !withBack;
    title.textContent = text;
    el.dataset.view = name;
    el.hidden = false;
  };

  const drawer: Drawer = {
    el,
    held: new Map(),
    panels,
    isOpen: () => !el.hidden,
    show(fold, from) {
      if (from !== null) opener = from;
      shown = fold;
      for (const panel of panels.children) (panel as HTMLElement).hidden = panel !== fold.panel;
      // Folds of one owner that read the same are told apart by their order.
      const names = fold.owner.folds.map((f) => {
        const same = fold.owner.folds.filter((g) => g.label === f.label);
        return same.length > 1 ? `${f.label} (${same.indexOf(f) + 1})` : f.label;
      });
      const mine = names[fold.owner.folds.indexOf(fold)];
      tabs.hidden = fold.owner.folds.length < 2;
      tabs.replaceChildren(
        ...fold.owner.folds.map((f, i) => {
          const tab = tag("button", "fp-dr-tab", names[i]);
          tab.type = "button";
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(f === fold));
          tab.onclick = () => drawer.show(f, null);
          return tab;
        }),
      );
      view("fold", `${fold.owner.title} — ${mine}`, false);
      paintPending(fold.panel);
      panels.scrollTop = 0;
    },
    showFile(ref, fromFold) {
      const file = drawer.held.get(ref.key);
      if (file === undefined) return;
      lines.replaceChildren();
      let prev = 0;
      for (const n of [...file.lines.keys()].sort((a, b) => a - b)) {
        if (n > prev + 1) {
          const gap = tag("div", "fp-line");
          gap.dataset.kind = "gap";
          gap.append(tag("span", "fp-ln", "…"), tag("span", "fp-lc"));
          lines.append(gap);
        }
        const row = tag("div", "fp-line");
        if (ref.start !== 0 && n >= ref.start && n <= ref.end) row.dataset.highlight = "true";
        row.append(tag("span", "fp-ln", String(n)), tag("span", "fp-lc", file.lines.get(n) ?? ""));
        lines.append(row);
        prev = n;
      }
      note.textContent = file.whole ? "" : "この画面に載せている行のみ";
      note.hidden = file.whole;
      view("file", ref.key + (ref.start === 0 ? "" : `:${ref.start}${ref.end > ref.start ? `-${ref.end}` : ""}`), fromFold);
      const first = lines.querySelector<HTMLElement>('[data-highlight="true"]');
      if (first !== null) first.scrollIntoView({ block: "center" });
      else lines.scrollTop = 0;
    },
    hide() {
      el.hidden = true;
      shown = null;
      opener?.focus();
      opener = null;
    },
  };
  close.onclick = () => drawer.hide();
  back.onclick = () => {
    if (shown !== null) drawer.show(shown, null);
  };
  drawers.add(drawer);
  return drawer;
}

// The drawer and the owner of the page being drawn: `drawPage` sets the drawer before it draws, and a card, a change section or an entry sets its owner while its folds are made.
let current: Drawer | null = null;
let owner: Owner | null = null;

export function useDrawer(drawer: Drawer) {
  current = drawer;
  owner = null;
}

// Draws what the folds of `title` are made in: each fold made meanwhile is a tab of that owner.
export function ownedBy<T>(title: string, draw: () => T): T {
  const before = owner;
  owner = { title, folds: [] };
  try {
    return draw();
  } finally {
    owner = before;
  }
}

// A fold of the owner being drawn: a panel of the drawer that `build` fills. It is registered before it is filled, so that a fold inside it comes after it in the tabs, which are in page order.
export function registerFold(label: string, build: (panel: HTMLElement) => void): Fold {
  const drawer = current;
  if (drawer === null) throw new Error("no drawer");
  const mine = owner ?? { title: label, folds: [] };
  const panel = tag("div", "fp-dr-panel");
  panel.setAttribute("role", "tabpanel");
  panel.hidden = true;
  const fold: Fold = { label, owner: mine, panel };
  mine.folds.push(fold);
  drawer.panels.append(panel);
  build(panel);
  return fold;
}

// The quiet button in the text that shows `fold` in the drawer.
export function foldButton(fold: Fold, text: string): HTMLButtonElement {
  const drawer = current;
  if (drawer === null) throw new Error("no drawer");
  const button = tag("button", "fp-fold-btn", text);
  button.type = "button";
  button.onclick = () => drawer.show(fold, button);
  return button;
}

export function foldOpener(label: string, text: string, build: (panel: HTMLElement) => void): HTMLButtonElement {
  return foldButton(registerFold(label, build), text);
}

// ---- The files that the page holds -------------------------------------------------------------------------------------------
// A code name of the page that names a file the page holds (the whole of a listed Markdown or text file, or the lines of an excerpt) shows that file's lines in the drawer.

// Holds the lines `lines` of a file, the first of which is line `start`, under each of its names.
export function holdLines(keys: string[], start: number, lines: string[]) {
  if (current === null) return;
  for (const key of keys) {
    const file = held(current, key);
    for (const [i, text] of lines.entries()) file.lines.set(start + i, text);
  }
}

// Holds the whole of a file.
export function holdWhole(keys: string[], text: string) {
  if (current === null) return;
  const rows = text.replace(/\n$/, "").split("\n");
  for (const key of keys) {
    const file = held(current, key);
    file.whole = true;
    for (const [i, row] of rows.entries()) file.lines.set(i + 1, row.replace(/\r$/, ""));
  }
}

function held(drawer: Drawer, key: string): Held {
  let file = drawer.held.get(key);
  if (file === undefined) {
    file = { whole: false, lines: new Map() };
    drawer.held.set(key, file);
  }
  return file;
}

// A code name as a path with the lines it names (0 when none); null when it is not of that form.
function parseRef(text: string): Ref | null {
  const m = /^([^\s:][^\s]*?)(?::([0-9]+)(?:-([0-9]+))?)?$/.exec(text.trim());
  if (m === null) return null;
  const start = m[2] ? Number.parseInt(m[2], 10) : 0;
  return { key: m[1], start, end: m[3] ? Number.parseInt(m[3], 10) : start };
}

// Whether the page holds the file the reference names, and every line it names.
function holds(drawer: Drawer, ref: Ref | null): ref is Ref {
  const file = ref === null ? undefined : drawer.held.get(ref.key);
  if (ref === null || file === undefined) return false;
  if (ref.start === 0) return true;
  if (ref.end < ref.start) return false;
  for (let n = ref.start; n <= ref.end; n++) if (!file.lines.has(n)) return false;
  return true;
}

// Makes a link of each code name in `root` (outside preformatted text) that names a file the page holds. It runs when the page is drawn, which is when every fold is in the drawer.
export function linkRefs(root: HTMLElement, drawer: Drawer) {
  const open = (code: HTMLElement) => {
    const ref = parseRef(code.textContent ?? "");
    if (holds(drawer, ref)) drawer.showFile(ref, code.closest(".fp-dr-panel") !== null);
  };
  for (const code of root.querySelectorAll<HTMLElement>("code")) {
    if (code.closest("pre, .fp-dr-file") !== null || !holds(drawer, parseRef(code.textContent ?? ""))) continue;
    code.classList.add("fp-fileref");
    code.setAttribute("role", "link");
    code.tabIndex = 0;
    code.onclick = () => open(code);
    code.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      open(code);
    };
  }
}
