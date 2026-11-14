// The scratchpad of the Orca work pane (A-29): the small popover under the plus that asks for the name of a file in `.orca/scratchpad` of a worktree. Rust makes the file (`orca_scratchpad_create`, which answers the existing file when the name is taken); this module draws the field and takes the keys, and tells the caller the path of the file to open.
import { composing, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { showError } from "./view.js";

// What the field starts with: its text before the extension is selected, so that typing replaces the name and keeps the extension.
const START_NAME = "memo.md";
// The folder, as the fixed text before the field. Rust adds it to the name.
const PREFIX = ".orca/scratchpad/";

// Opens the popover under `anchor` for the worktree at `path` (of the target `environment`). `opened` runs with the path from the worktree of the file when it was made, or was there already.
export function openScratchpad(anchor: Element, path: string, environment: string | null, opened: (relative: string) => void) {
  const pop = tag("div", "menu orca-scratch-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "スクラッチパッド");
  const input = tag("input");
  input.type = "text";
  input.value = START_NAME;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "ファイル名");
  const field = tag("div", "orca-scratch-field");
  field.append(tag("span", "orca-scratch-prefix", PREFIX), input);
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
      const made = await invoke("orca_scratchpad_create", { path, name, environment });
      if (pop.isConnected) closeMenu();
      opened(made.relative);
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
