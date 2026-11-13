// The button that closes and opens a screen's list (A-23). The Orca screen has it in the tab strip of the pane at the left edge, whether its list of projects is open or closed.
// The buttons of the screens are one control in several places, so all are made here and say the same: a label that names the list and `aria-expanded` that says whether it is open.
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
