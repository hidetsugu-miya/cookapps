// The dialog that picks a folder on the server of a saved environment (A-38, issue #782), in the form of Orca's own "browse the host's file system": a breadcrumb with the buttons up and home, a field that narrows the names (and takes a path that starts with "/"), the folders of the folder shown, the path that will be added, and the two buttons.
// Rust lists the folders (`orca_browse_dir`) and adds the project (`orca_project_add`). The paths are POSIX paths: the folder above is cut at the last "/", and a name is joined with one. The names come from the server, so they are drawn as text, never as markup.
import { composing, partMatcher, tag } from "./dom.js";
import { CHEVRON_SVG, CLOSE_SVG, FOLDER_SVG, svgOf } from "./icons.js";
import { invoke } from "./ipc.js";
import { showError } from "./view.js";

const HOME_SVG = svgOf('<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>');
const UP_FOLDER_SVG = svgOf('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>');

const segmentsOf = (path: string) => path.split("/").filter((s) => s !== "");
const joinPath = (dir: string, name: string) => `${dir.endsWith("/") ? dir : `${dir}/`}${name}`;
const parentOf = (path: string) => `/${segmentsOf(path).slice(0, -1).join("/")}`;

// Opens the dialog for the saved environment `environment`. `anchor` is what has the focus again when it closes, and `added` runs after the folder was added, to read the list again.
export function openBrowseDialog(environment: string, anchor: Element, added: () => void) {
  const title = tag("h2", "", `${environment} のフォルダを選ぶ`);
  const closeButton = tag("button", "icon-btn");
  closeButton.type = "button";
  closeButton.innerHTML = CLOSE_SVG;
  closeButton.setAttribute("aria-label", "閉じる");
  const head = tag("div", "orca-browse-head");
  head.append(title, closeButton);

  const iconButton = (svg: string, label: string) => {
    const b = tag("button", "icon-btn");
    b.type = "button";
    b.innerHTML = svg;
    b.setAttribute("aria-label", label);
    return b;
  };
  const up = iconButton(UP_FOLDER_SVG, "上のフォルダ");
  const home = iconButton(HOME_SVG, "ホーム");
  const trail = tag("div", "orca-browse-trail");
  const crumbs = tag("div", "orca-browse-crumbs");
  crumbs.append(up, home, trail);

  const filter = tag("input", "orca-browse-filter");
  filter.type = "text";
  filter.autocomplete = "off";
  filter.spellcheck = false;
  filter.setAttribute("aria-label", "フォルダを絞り込む");
  const list = tag("div", "orca-browse-list");

  const chosenPath = tag("span", "orca-browse-path");
  const cancel = tag("button", "text-btn", "キャンセル");
  cancel.type = "button";
  const pick = tag("button", "text-btn primary", "フォルダを選ぶ");
  pick.type = "button";
  const buttons = tag("span", "orca-browse-buttons");
  buttons.append(cancel, pick);
  const foot = tag("div", "orca-browse-foot");
  foot.append(chosenPath, buttons);

  const dialog = tag("div", "orca-browse");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", `${environment} のフォルダを選ぶ`);
  dialog.append(head, crumbs, filter, list, foot);
  const scrim = tag("div", "scrim orca-browse-scrim");
  scrim.append(dialog);

  // The folder shown as Orca resolved it ("" until the first read), its folders, the words of a failed read, the folder the keys are on (a name of `folders`), and whether the add is on its way.
  let dir = "";
  let folders: string[] = [];
  let failure: string | null = null;
  let cursor: string | null = null;
  let busy = false;
  let closed = false;
  // The number of the last read: an answer of an earlier one, or one that comes after the dialog closed, is dropped.
  let reads = 0;

  const typedPath = () => (filter.value.trim().startsWith("/") ? filter.value.trim() : null);
  // A text that starts with "/" is a path to go to, not a name to narrow by.
  const shown = () => {
    const re = typedPath() === null ? partMatcher(filter.value) : null;
    return re === null ? folders : folders.filter((name) => re.test(name));
  };
  // The folder the add takes: the one the keys are on, else the one shown.
  const chosen = () => (cursor === null ? dir : joinPath(dir, cursor));

  const drawTrail = () => {
    trail.replaceChildren();
    if (dir === "") return;
    const crumb = (label: string, path: string, current: boolean) => {
      if (current) {
        const here = tag("span", "orca-browse-here", label);
        here.setAttribute("aria-current", "location");
        return here;
      }
      const b = tag("button", "orca-browse-crumb", label);
      b.type = "button";
      b.onclick = () => void load(path);
      return b;
    };
    if (!dir.startsWith("/")) {
      trail.append(crumb(dir, dir, true));
      return;
    }
    const segments = segmentsOf(dir);
    trail.append(crumb("/", "/", segments.length === 0));
    segments.forEach((name, i) => {
      const arrow = tag("span", "orca-browse-arrow");
      arrow.innerHTML = CHEVRON_SVG;
      trail.append(arrow, crumb(name, `/${segments.slice(0, i + 1).join("/")}`, i === segments.length - 1));
    });
    // The current folder stays in view when the trail is longer than the dialog.
    trail.scrollLeft = trail.scrollWidth;
  };

  const drawList = () => {
    list.replaceChildren();
    if (failure !== null) {
      list.append(tag("p", "orca-browse-note err", failure));
      return;
    }
    const names = shown();
    for (const name of names) {
      const row = tag("button", "orca-browse-row");
      row.type = "button";
      const icon = tag("span", "orca-browse-icon");
      icon.innerHTML = FOLDER_SVG;
      const next = tag("span", "orca-browse-next");
      next.innerHTML = CHEVRON_SVG;
      row.append(icon, tag("span", "orca-browse-name", name), next);
      if (name === cursor) row.dataset.cursor = "true";
      row.onclick = () => void load(joinPath(dir, name));
      list.append(row);
    }
    if (names.length === 0 && dir !== "") list.append(tag("p", "orca-browse-note", "フォルダがありません"));
  };

  // The buttons that depend on the state: nothing can be added while the folder shown is unknown or its read failed.
  const drawState = () => {
    up.disabled = !dir.startsWith("/") || dir === "/";
    pick.disabled = busy || dir === "" || failure !== null;
    chosenPath.textContent = dir === "" || failure !== null ? "" : chosen();
    chosenPath.title = chosenPath.textContent;
  };
  const draw = () => {
    drawTrail();
    drawList();
    drawState();
  };

  // Reads the folders in `path` ("" is the home folder). On an answer the folder shown is the one Orca opened and the field is emptied; a failure keeps the folder shown, and says why in the list.
  async function load(path: string) {
    const mine = ++reads;
    try {
      const read = await invoke("orca_browse_dir", { environment, path });
      if (mine !== reads || closed) return;
      dir = read.resolvedPath;
      folders = read.folders;
      failure = null;
      cursor = null;
      filter.value = "";
      draw();
      filter.focus();
    } catch (e) {
      if (mine !== reads || closed) return;
      failure = String(e);
      cursor = null;
      draw();
    }
  }

  // Moves the keys one row among the rows shown; from no row, down goes to the first and up to the last.
  const moveCursor = (step: 1 | -1) => {
    const names = shown();
    if (names.length === 0) return;
    const at = cursor === null ? -1 : names.indexOf(cursor);
    const to = at === -1 ? (step === 1 ? 0 : names.length - 1) : Math.min(names.length - 1, Math.max(0, at + step));
    // Only the mark moves: the rows are not drawn again, so a long list costs two rows, not all of them.
    const rows = list.querySelectorAll<HTMLElement>(".orca-browse-row");
    if (at !== -1) delete rows[at]?.dataset.cursor;
    cursor = names[to];
    if (rows[to] !== undefined) {
      rows[to].dataset.cursor = "true";
      rows[to].scrollIntoView({ block: "nearest" });
    }
    drawState();
  };

  const behind = [...document.querySelectorAll<HTMLElement>("#sidebar, #content")];
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.remove();
    for (const el of behind) el.inert = false;
    document.removeEventListener("keydown", onKey);
    (anchor as HTMLElement).focus?.();
  };
  // An Escape that cancels IME conversion is the field's.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !composing(e)) close();
  };

  closeButton.onclick = close;
  cancel.onclick = close;
  scrim.onpointerdown = (e) => {
    if (e.target !== scrim) return;
    e.preventDefault();
    close();
  };
  up.onclick = () => void load(parentOf(dir));
  home.onclick = () => void load("");
  filter.oninput = () => {
    cursor = null;
    drawList();
    drawState();
  };
  filter.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveCursor(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const typed = typedPath();
      if (cursor !== null) void load(joinPath(dir, cursor));
      else if (typed !== null) void load(typed);
    }
  };
  pick.onclick = async () => {
    if (pick.disabled) return;
    const path = chosen();
    busy = true;
    drawState();
    try {
      await invoke("orca_project_add", { path, environment });
      close();
      added();
    } catch (e) {
      close();
      showError(e);
    }
  };

  for (const el of behind) el.inert = true;
  document.addEventListener("keydown", onKey);
  document.body.append(scrim);
  draw();
  filter.focus();
  void load("");
}
