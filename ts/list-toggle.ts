// The button that closes and opens a screen's list (A-23). The Orca screen's list of projects has it first in its header, and the pane at the left edge has it in its tab strip while the list is closed.
// The two buttons are one control in two places, so both are made here and say the same: a label that names the list and `aria-expanded` that says whether it is open.
import { tag } from "./dom.js";
import { SIDEBAR_SVG } from "./icons.js";

export function listToggle(label: string, onclick: () => void): HTMLButtonElement {
  const button = tag("button", "icon-btn list-toggle");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.innerHTML = SIDEBAR_SVG;
  button.onclick = onclick;
  return button;
}

export function drawListToggle(button: HTMLElement, open: boolean) {
  button.setAttribute("aria-expanded", String(open));
}
