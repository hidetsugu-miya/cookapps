// The list of branches under the branch button in the heading of the file pane (A-25): the local branches of the worktree and, below them, the remote ones found by the text of the filter. A pick switches the worktree to that branch.
// The same list picks the ref a new worktree starts from and its existing branch (A-9, `openBranchList`).
// Rust reads the branches (`orca_local_branches`, `orca_remote_branches`) and switches (`orca_switch_branch`); this module draws the list and takes the press. The local branches are read when the list opens and narrowed by the filter here; the remote ones are asked for by the text, after the typing stops.
import type { OrcaRemoteBranch } from "./bindings/OrcaRemoteBranch";
import { tag } from "./dom.js";
import { CHECK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { toast } from "./toast.js";
import { showError } from "./view.js";

// The worktree whose branch is switched: `repo` is the key of its project (the remote branches belong to the repository), `branch` the one it is on.
export interface BranchContext {
  target: string | null;
  path: string;
  repo: string;
  branch: string;
}

// How long the typing must stop before the remote branches are asked for again.
const SEARCH_MS = 250;

// Switches the worktree. A refusal is shown as the error; a switch that worked with a warning says so; the list of the screen is read again after a switch.
async function switchTo(here: BranchContext, kind: "local" | "remote", name: string, switched: () => void) {
  try {
    const done = await invoke("orca_switch_branch", { path: here.path, kind, name, environment: here.target });
    if (done.warning !== null) toast(`${done.branch} に切り替えました: ${done.warning}`);
  } catch (e) {
    showError(e);
    return;
  }
  switched();
}

// The list that was opened last; it is open while it is in the page (another menu, a pick or a click elsewhere takes it out).
let openPop: HTMLElement | null = null;

// Where the branches are read from: a worktree of the project (its local branches and which are in use), and the project's key (the remote branches belong to the repository).
export interface BranchSource {
  target: string | null;
  path: string;
  repo: string;
}

// A branch picked: `name` as Orca names it (`origin/feature/a` for a remote one), `localName` the local branch it is or would be.
export interface PickedBranch {
  kind: "local" | "remote";
  name: string;
  localName: string;
}

// How a list is used: what is marked, whether a branch in use elsewhere is refused, a row above the sections, and what a pick does.
export interface BranchListOptions {
  // True for the row to mark; `checkedOut` is whether the worktree has the local branch checked out.
  current: (kind: "local" | "remote", name: string, checkedOut: boolean) => boolean;
  // A branch another worktree has checked out cannot be picked (git cannot check it out twice).
  refuseInUse: boolean;
  // The local branch the folder being read has checked out cannot be picked either (a new worktree cannot check it out beside that folder).
  refuseCurrent?: boolean;
  // A row above the sections that picks none (the default base of a new worktree).
  top?: { label: string; current: boolean; pick: () => void };
  // A row marked `current` closes the list and picks nothing when `pickCurrent` is false.
  pickCurrent: boolean;
  pick: (branch: PickedBranch) => void;
}

// Closes the list of branches if it is the menu that is open, and leaves any other menu alone.
export function closeBranchDialog() {
  if (openPop?.isConnected) closeMenu();
}

// Opens the list under `anchor`. A pick closes it; the branch the worktree is on only closes it.
export function openBranchDialog(anchor: Element, here: BranchContext, switched: () => void) {
  openBranchList(anchor, here, {
    current: (_kind, _name, checkedOut) => checkedOut,
    refuseInUse: true,
    pickCurrent: false,
    pick: (b) => void switchTo(here, b.kind, b.name, switched),
  });
}

// Opens the list of branches under `anchor`: the local ones of `here.path` and, by the text of the filter, the remote ones of the repository. The list of A-25 and the choices of a new worktree (A-9) are made by it.
export function openBranchList(anchor: Element, here: BranchSource, options: BranchListOptions) {
  const pop = tag("div", "menu orca-dest-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "ブランチ");
  const filter = tag("input");
  filter.setAttribute("aria-label", "ブランチを絞り込む");
  filter.placeholder = "ブランチを絞り込む";
  filter.autocomplete = "off";
  const list = tag("div", "orca-dest-list");
  // A section keeps its rows between the typing: the filter only hides them, and a row is made again only when its answer comes.
  const makeSection = (title: string) => {
    const box = tag("div");
    list.append(tag("p", "orca-dest-sec", title), box);
    return { box, rows: [] as HTMLElement[], none: tag("p", "empty", "該当するブランチがありません"), answered: false, failed: false };
  };
  if (options.top) {
    const top = tag("button", "orca-branch-row", options.top.label);
    top.type = "button";
    top.setAttribute("aria-current", String(options.top.current));
    top.onclick = () => {
      closeMenu();
      options.top?.pick();
    };
    list.prepend(top);
  }
  const localSection = makeSection("ローカル");
  const remoteSection = makeSection("リモート");

  const row = (kind: "local" | "remote", name: string, localName: string, current: boolean, inUse: boolean) => {
    const b = tag("button", "orca-branch-row");
    b.type = "button";
    b.dataset.kind = kind;
    b.dataset.name = name;
    b.setAttribute("aria-current", String(current));
    b.disabled = options.refuseInUse && inUse;
    b.append(tag("span", "", name));
    if (current) {
      const mark = tag("span", "orca-branch-mark");
      mark.innerHTML = CHECK_SVG;
      b.append(mark);
    }
    b.onclick = () => {
      closeMenu();
      if (!current || options.pickCurrent) options.pick({ kind, name, localName });
    };
    return b;
  };
  // Hides the rows that do not hold the text of the filter, and says so when none is left in an answered section.
  const narrow = () => {
    const q = filter.value.trim().toLowerCase();
    for (const s of [localSection, remoteSection]) {
      let shown = 0;
      for (const r of s.rows) {
        r.hidden = !(r.dataset.name ?? "").toLowerCase().includes(q);
        if (!r.hidden) shown++;
      }
      s.none.hidden = !(s.answered && !s.failed && shown === 0);
    }
  };
  // Draws the answer of a section: its rows, or the message of the read that failed.
  const fill = (s: typeof localSection, rows: HTMLElement[], error: string | null) => {
    s.rows = rows;
    s.answered = true;
    s.failed = error !== null;
    s.box.replaceChildren(...(error !== null ? [tag("p", "empty fail", error)] : [...rows, s.none]));
    narrow();
  };

  // The remote branches are asked for one text at a time: a text typed while one is asked for waits, and only the last of them is asked for.
  let asking = false;
  let again = false;
  const searchRemote = async () => {
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    do {
      again = false;
      let next: OrcaRemoteBranch[] = [];
      let error: string | null = null;
      try {
        next = await invoke("orca_remote_branches", { path: here.path, repo: here.repo, query: filter.value.trim(), environment: here.target });
      } catch (e) {
        error = String(e);
      }
      if (!pop.isConnected) break;
      if (!again) fill(remoteSection, next.map((b) => row("remote", b.name, b.localName, options.current("remote", b.name, false), false)), error);
    } while (again);
    asking = false;
  };
  let timer = 0;
  filter.oninput = () => {
    narrow();
    clearTimeout(timer);
    timer = window.setTimeout(() => pop.isConnected && void searchRemote(), SEARCH_MS);
  };

  pop.append(filter, list);
  showMenu(anchor, pop);
  openPop = pop;
  filter.focus();
  void searchRemote();
  invoke("orca_local_branches", { path: here.path, environment: here.target }).then(
    (read) => pop.isConnected && fill(localSection, read.map((b) => row("local", b.name, b.name, options.current("local", b.name, b.current), b.inUse || (options.refuseCurrent === true && b.current))), null),
    (e) => pop.isConnected && fill(localSection, [], String(e)),
  );
}
