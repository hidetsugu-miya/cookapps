// The list of branches under the branch button in the heading of the file pane (A-25): the local branches of the worktree and, below them, the remote ones found by the text of the filter. A pick switches the worktree to that branch.
// Rust reads the branches (`orca_local_branches`, `orca_remote_branches`) and switches (`orca_switch_branch`); this module draws the list and takes the press. The local branches are read when the list opens and narrowed by the filter here; the remote ones are asked for by the text, after the typing stops.
import type { OrcaLocalBranch } from "./bindings/OrcaLocalBranch";
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

// Opens the list under `anchor`. A pick closes it; the branch the worktree is on only closes it.
export function openBranchDialog(anchor: Element, here: BranchContext, switched: () => void) {
  const pop = tag("div", "menu orca-dest-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "ブランチ");
  const filter = tag("input");
  filter.setAttribute("aria-label", "ブランチを絞り込む");
  filter.placeholder = "ブランチを絞り込む";
  filter.autocomplete = "off";
  const list = tag("div", "orca-dest-list");
  // What was answered (null: not yet) and the message of a read that failed.
  let locals: OrcaLocalBranch[] | null = null;
  let localError: string | null = null;
  let remotes: OrcaRemoteBranch[] | null = null;
  let remoteError: string | null = null;

  const row = (kind: "local" | "remote", name: string, current: boolean, inUse: boolean) => {
    const b = tag("button", "orca-branch-row");
    b.type = "button";
    b.dataset.kind = kind;
    b.dataset.name = name;
    b.setAttribute("aria-current", String(current));
    b.disabled = inUse;
    b.append(tag("span", "", name));
    if (current) {
      const mark = tag("span", "orca-branch-mark");
      mark.innerHTML = CHECK_SVG;
      b.append(mark);
    }
    b.onclick = () => {
      closeMenu();
      if (!current) void switchTo(here, kind, name, switched);
    };
    return b;
  };
  const section = (title: string, rows: HTMLElement[], error: string | null, answered: boolean) => [
    tag("p", "orca-dest-sec", title),
    ...(error !== null ? [tag("p", "empty fail", error)] : rows.length > 0 ? rows : answered ? [tag("p", "empty", "該当するブランチがありません")] : []),
  ];
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const has = (name: string) => name.toLowerCase().includes(q);
    list.replaceChildren(
      ...section("ローカル", (locals ?? []).filter((b) => has(b.name)).map((b) => row("local", b.name, b.current, b.inUse)), localError, locals !== null),
      ...section("リモート", (remotes ?? []).filter((b) => has(b.name)).map((b) => row("remote", b.name, false, false)), remoteError, remotes !== null),
    );
  };

  let asked = 0;
  const searchRemote = async () => {
    const mine = ++asked;
    let next: OrcaRemoteBranch[] | null = null;
    let error: string | null = null;
    try {
      next = await invoke("orca_remote_branches", { path: here.path, repo: here.repo, query: filter.value.trim(), environment: here.target });
    } catch (e) {
      error = String(e);
    }
    if (mine !== asked || !pop.isConnected) return;
    remotes = next;
    remoteError = error;
    draw();
  };
  let timer = 0;
  filter.oninput = () => {
    draw();
    clearTimeout(timer);
    timer = window.setTimeout(() => pop.isConnected && void searchRemote(), SEARCH_MS);
  };

  draw();
  pop.append(filter, list);
  showMenu(anchor, pop);
  filter.focus();
  void searchRemote();
  invoke("orca_local_branches", { path: here.path, environment: here.target }).then(
    (read) => {
      locals = read;
      if (pop.isConnected) draw();
    },
    (e) => {
      localError = String(e);
      if (pop.isConnected) draw();
    },
  );
}
