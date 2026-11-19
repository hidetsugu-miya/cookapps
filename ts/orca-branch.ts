// The list of branches under the branch button in the heading of the file pane (A-25): the git worktrees of the project at the top, then the local branches of the worktree and, below them, the remote ones found by the text of the filter. A pick of a branch switches the worktree to it; a pick of a worktree shows that worktree in the file pane.
// The same list picks the ref a new worktree starts from and its existing branch (A-9, `openBranchList`).
// Rust reads the branches (`orca_local_branches`, `orca_remote_branches`), remembers a remote one that was picked (`orca_branch_used`) and switches (`orca_switch_branch`); this module draws the list and takes the press. The local branches are read when the list opens and narrowed by the filter here; the remote ones are asked for by the text, after the typing stops.
import type { OrcaGitWorktree } from "./bindings/OrcaGitWorktree";
import type { OrcaRemoteBranch } from "./bindings/OrcaRemoteBranch";
import { tag } from "./dom.js";
import { BRANCH_SVG, CHECK_SVG, CLOUD_SVG, DOWN_SVG, FOLDER_SVG } from "./icons.js";
import { periodMs } from "./e2e-timers.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { toast } from "./toast.js";
import { showFailure } from "./error-card.js";

// The worktree whose branch is switched: `repo` is the key of its project (the remote branches belong to the repository), `branch` the one it is on.
export interface BranchContext {
  target: string | null;
  path: string;
  repo: string;
  branch: string;
}

// How long the typing must stop before the remote branches are asked for again.
const SEARCH_MS = 250;

// How many remote branches show while the filter is empty; the button under them opens the rest (A-25). Rust puts the ones picked last first in the answer to an empty text (`orca_branch_used`), so these are the first of the answer as it comes.
const REMOTE_FIRST = 5;

// How long the worktrees of a project that were read are used again by the next list that opens, the period of the list of Orca (the clock of the screen, A-25).
const WORKTREES_MS = 10_000;

// The read of `orca_git_worktrees` of each Orca and project, kept for `WORKTREES_MS` after it started; a read that failed is dropped at once. There is no timer: an entry out of its time is dropped when a list opens, and a switch drops its own.
const worktreeReads = new Map<string, { at: number; read: Promise<OrcaGitWorktree[]> }>();
const worktreesKey = (here: BranchSource) => JSON.stringify([here.target, here.repo]);

// The read held for the project of `here`, or none when there is none or it is out of its time.
function heldWorktrees(here: BranchSource) {
  const limit = periodMs("orcaClock", WORKTREES_MS);
  const now = Date.now();
  for (const [key, held] of worktreeReads) {
    if (now - held.at >= limit) worktreeReads.delete(key);
  }
  return worktreeReads.get(worktreesKey(here));
}

// The worktrees of the project: the read held, or a new one. `told` is called once for each new read (the screen forgets the worktrees that the answer lacks).
function readWorktrees(here: BranchSource, told: (worktrees: OrcaGitWorktree[]) => void) {
  const held = heldWorktrees(here);
  if (held !== undefined) return held.read;
  const key = worktreesKey(here);
  const read = invoke("orca_git_worktrees", { repo: here.repo, environment: here.target }).then((worktrees) => {
    told(worktrees);
    return worktrees;
  });
  const entry = { at: Date.now(), read };
  worktreeReads.set(key, entry);
  read.catch(() => {
    if (worktreeReads.get(key) === entry) worktreeReads.delete(key);
  });
  return read;
}

// Switches the worktree. A refusal is shown as a failure card; a switch that worked with a warning says so; the list of the screen is read again after a switch (`switched` is told the branch the worktree is on now).
async function switchTo(here: BranchContext, kind: "local" | "remote", name: string, switched: (branch: string) => void) {
  let branch: string;
  try {
    const done = await invoke("orca_switch_branch", { path: here.path, kind, name, environment: here.target });
    if (done.warning !== null) toast(`${done.branch} に切り替えました: ${done.warning}`);
    branch = done.branch;
  } catch (e) {
    showFailure("orca-branch", e);
    return;
  }
  switched(branch);
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
  // The section of the git worktrees of the project above the branches (A-25): `current` is the path the pane shows, and a pick of another one is `pick`'s. The list of A-9 has none.
  worktrees?: { current: string; pick: (worktree: OrcaGitWorktree) => void; read: (worktrees: OrcaGitWorktree[]) => void };
}

// Closes the list of branches if it is the menu that is open, and leaves any other menu alone.
export function closeBranchDialog() {
  if (openPop?.isConnected) closeMenu();
}

// Opens the list under `anchor`. A pick closes it; the branch the worktree is on, and the worktree the pane shows, only close it. `pickWorktree` shows the worktree picked.
export function openBranchDialog(anchor: Element, here: BranchContext, switched: (branch: string) => void, pickWorktree: (worktree: OrcaGitWorktree) => void, worktreesRead: (worktrees: OrcaGitWorktree[]) => void) {
  openBranchList(anchor, here, {
    current: (_kind, _name, checkedOut) => checkedOut,
    refuseInUse: true,
    pickCurrent: false,
    pick: (b) =>
      void switchTo(here, b.kind, b.name, (branch) => {
        // The branch of the worktree changed, so the worktrees held are stale.
        worktreeReads.delete(worktreesKey(here));
        switched(branch);
      }),
    worktrees: { current: here.path, pick: pickWorktree, read: worktreesRead },
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
  // `limit` is how many rows show while the filter is empty and the section is folded (null: all); the button of `more` folds and opens the rest.
  const makeSection = (title: string, icon: string, limit: number | null, none = "該当するブランチがありません") => {
    const mark = tag("span", "orca-dest-icon");
    mark.innerHTML = icon;
    const count = tag("span", "orca-dest-count");
    count.hidden = true;
    const head = tag("p", "orca-dest-sec");
    head.append(mark, tag("span", "orca-dest-name", title), count);
    const box = tag("div");
    const section = tag("div", "orca-dest-section");
    section.append(head, box);
    const label = tag("span");
    const chevron = tag("span", "orca-dest-chev");
    chevron.innerHTML = DOWN_SVG;
    const toggle = tag("button", "orca-dest-more-btn");
    toggle.type = "button";
    toggle.append(label, chevron);
    const more = tag("div", "orca-dest-more");
    more.hidden = true;
    more.append(toggle);
    const s = { section, box, count, more, toggle, label, limit, expanded: false, rows: [] as HTMLElement[], none: tag("p", "empty", none), answered: false, failed: false };
    toggle.onclick = () => {
      s.expanded = !s.expanded;
      narrow();
    };
    return s;
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
  const localSection = makeSection("ローカル", BRANCH_SVG, null);
  const remoteSection = makeSection("リモート", CLOUD_SVG, REMOTE_FIRST);
  list.append(localSection.section, remoteSection.section);
  // The worktrees are above the branches, and the section is put in the list when its answer has a worktree or failed, so that a project with none draws no heading.
  const worktreeSection = makeSection("worktree", FOLDER_SVG, null, "該当する worktree がありません");
  const sections = options.worktrees ? [worktreeSection, localSection, remoteSection] : [localSection, remoteSection];

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
      if (current && !options.pickCurrent) return;
      // Remembered for the order of the remote rows (the first five are the ones picked last). It changes nothing but that order, so a failure neither stops the pick nor is shown.
      if (kind === "remote") invoke("orca_branch_used", { repo: here.repo, name, environment: here.target }).catch(() => {});
      options.pick({ kind, name, localName });
    };
    return b;
  };
  // A git worktree: its folder, the branch it is on, a mark `git` when Orca's list lacks it, and a check mark for the one the pane shows. A press on another one shows it in the pane.
  const worktreeRow = (w: OrcaGitWorktree) => {
    const current = w.path.replace(/\/+$/, "") === (options.worktrees?.current ?? "").replace(/\/+$/, "");
    const b = tag("button", "orca-branch-row");
    b.type = "button";
    b.dataset.kind = "worktree";
    b.dataset.name = w.name;
    b.dataset.path = w.path;
    b.dataset.search = `${w.name} ${w.gitBranch}`;
    b.setAttribute("aria-current", String(current));
    const tail = tag("span", "orca-wt-tail");
    if (w.gitBranch !== "") tail.append(tag("span", "orca-wt-branch", w.gitBranch));
    if (w.gitOnly) tail.append(tag("span", "chip orca-wt-git", "git"));
    if (current) {
      const mark = tag("span", "orca-branch-mark");
      mark.innerHTML = CHECK_SVG;
      tail.append(mark);
    }
    b.append(tag("span", "", w.name), tail);
    b.onclick = () => {
      closeMenu();
      if (!current) options.worktrees?.pick(w);
    };
    return b;
  };
  // Hides the rows that do not hold the text of the filter, and says so when none is left in an answered section.
  // With no text, a folded section shows its first `limit` rows and the button for the rest; a text shows every match, with no button, and folds the section again for when the text is cleared.
  const narrow = () => {
    const q = filter.value.trim().toLowerCase();
    for (const s of sections) {
      if (q !== "") s.expanded = false;
      const limit = s.limit ?? Infinity;
      const cap = q === "" && !s.expanded ? limit : Infinity;
      let matched = 0;
      let shown = 0;
      for (const r of s.rows) {
        const hit = (r.dataset.search ?? r.dataset.name ?? "").toLowerCase().includes(q);
        if (hit) matched++;
        r.hidden = !hit || matched > cap;
        if (!r.hidden) shown++;
      }
      const listed = s.answered && !s.failed;
      s.count.hidden = !listed;
      s.count.textContent = String(matched);
      s.none.hidden = !(listed && shown === 0);
      s.more.hidden = !(listed && q === "" && matched > limit);
      s.toggle.setAttribute("aria-expanded", String(s.expanded));
      s.label.textContent = s.expanded ? "たたむ" : `ほか ${matched - limit} 件を表示`;
    }
  };
  // Draws the answer of a section: its rows, or the message of the read that failed.
  const fill = (s: typeof localSection, rows: HTMLElement[], error: string | null) => {
    s.rows = rows;
    s.answered = true;
    s.failed = error !== null;
    s.box.replaceChildren(...(error !== null ? [tag("p", "empty fail", error)] : [...rows, ...(s.limit === null ? [] : [s.more]), s.none]));
    if (s === worktreeSection && !s.section.isConnected && (error !== null || rows.length > 0)) list.prepend(s.section);
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
  // The branches are drawn first: the worktrees are asked for when the local branches have answered, so that the read of them (a process and a call to Orca) does not hold the rows back. A read held is drawn at once.
  const local = invoke("orca_local_branches", { path: here.path, environment: here.target }).then(
    (read) => pop.isConnected && fill(localSection, read.map((b) => row("local", b.name, b.name, options.current("local", b.name, b.current), b.inUse || (options.refuseCurrent === true && b.current))), null),
    (e) => pop.isConnected && fill(localSection, [], String(e)),
  );
  const worktrees = options.worktrees;
  if (worktrees) {
    const showWorktrees = () => {
      if (!pop.isConnected) return;
      readWorktrees(here, worktrees.read).then(
        (read) => pop.isConnected && fill(worktreeSection, read.map(worktreeRow), null),
        (e) => pop.isConnected && fill(worktreeSection, [], String(e)),
      );
    };
    if (heldWorktrees(here) !== undefined) showWorktrees();
    else void local.then(showWorktrees);
  }
}
