// The terminal pane of the database screen (D-7): a pane at the right of the work pane that the icon at the right end of the work pane's header opens and closes, and a divider between them that is dragged.
// It holds nothing yet. Whether it is open is the `aria-pressed` of the icon, and its width is the divider's (ts/split.ts); both are kept in memory only.
import { $ } from "./dom.js";
import { TERMINAL_SVG } from "./icons.js";
import { initSplit } from "./split.js";

export function initDatabaseTerminal() {
  const toggle = $("database-terminal-toggle");
  toggle.innerHTML = TERMINAL_SVG;
  toggle.onclick = () => {
    const open = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(open));
    $("database-terminal").hidden = !open;
    $("database-terminal-split").hidden = !open;
  };
  initSplit($("database"), $("database-terminal-split"), { min: 0.25, max: 0.5, initial: 0.35, property: "--terminal-w" });
}
