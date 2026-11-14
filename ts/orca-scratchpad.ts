// The scratchpad of the Orca work pane (A-29, A-30): the small popover under the plus that asks for the name of a file in `.orca/scratchpad` of a worktree, or in the scratchpad folder of an SSH host. Rust makes the file (`orca_scratchpad_create` or `ssh_scratch_create`, which answer the existing file when the name is taken); this module draws the field and takes the keys, and tells the caller the file to open.
import { composing, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { SSH_SCRATCH_DIR } from "./orca-editor.js";
import { showError } from "./view.js";

// What the field starts with: its text before the extension is selected, so that typing replaces the name and keeps the extension.
const START_NAME = "memo.md";
// The folder of a worktree, as the fixed text before the field (an SSH host's is `SSH_SCRATCH_DIR`). Rust adds it to the name.
const PREFIX = ".orca/scratchpad/";

// Where the file is made: a worktree (at `path`, of the target `environment`), or the SSH host `host` (the `id` of an `OrcaSshTarget`).
export type ScratchpadPlace = { path: string; environment: string | null } | { host: string };

// Opens the popover under `anchor` for `place`. `opened` runs when the file was made, or was there already, with its path from the worktree, or its name on the SSH host.
export function openScratchpad(anchor: Element, place: ScratchpadPlace, opened: (file: string) => void) {
  const pop = tag("div", "menu orca-scratch-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "スクラッチパッド");
  // The folder of an SSH host is longer: its popover is wider, so that the name still has room.
  if ("host" in place) pop.dataset.place = "host";
  const input = tag("input");
  input.type = "text";
  input.value = START_NAME;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "ファイル名");
  const field = tag("div", "orca-scratch-field");
  field.append(tag("span", "orca-scratch-prefix", "host" in place ? SSH_SCRATCH_DIR : PREFIX), input);
  const cancel = tag("button", "text-btn", "やめる");
  cancel.type = "button";
  const make = tag("button", "text-btn primary", "作って開く");
  make.type = "button";
  const actions = tag("div", "orca-scratch-actions");
  actions.append(cancel, make);
  pop.append(field, actions);

  let busy = false;
  const submit = async () => {
    const name = input.value.trim();
    if (busy || name === "") return;
    busy = true;
    make.disabled = true;
    try {
      const file = "host" in place ? (await invoke("ssh_scratch_create", { host: place.host, name })).name : (await invoke("orca_scratchpad_create", { path: place.path, name, environment: place.environment })).relative;
      if (pop.isConnected) closeMenu();
      opened(file);
    } catch (e) {
      // A failure keeps the popover (when it is still open) with the text.
      showError(e);
      busy = false;
      make.disabled = false;
    }
  };
  cancel.onclick = () => closeMenu();
  make.onclick = () => void submit();
  input.onkeydown = (e) => {
    if (composing(e) || e.key !== "Enter") return;
    e.preventDefault();
    void submit();
  };

  showMenu(anchor, pop);
  input.focus();
  input.setSelectionRange(0, Math.max(0, input.value.lastIndexOf(".")));
}
