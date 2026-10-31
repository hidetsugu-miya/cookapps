// A pane slides in from the right over a dimmed screen; ✕, Escape or a click on the dimmed part closes it. Focus goes into it and returns to what opened it.
// The screen behind is inert while it is open, so Tab stays inside. When a redraw removed the opener, focus goes to the Slack token field.
import { $, tag } from "./dom.js";
import { closeHint } from "./hint.js";
import { CLOSE_SVG } from "./icons.js";

let pane: { scrim: HTMLElement; behind: HTMLElement[]; opener: HTMLElement | null } | null = null;

export function closePane() {
  if (!pane) return;
  pane.scrim.remove();
  pane.behind.forEach((el) => (el.inert = false));
  (pane.opener?.isConnected ? pane.opener : $("slack-token-input")).focus();
  pane = null;
}

export function openPane(title: string, ...body: Node[]) {
  closePane();
  closeHint();
  const close = tag("button", "icon-btn");
  close.type = "button";
  close.innerHTML = CLOSE_SVG;
  close.setAttribute("aria-label", "閉じる");
  close.onclick = closePane;
  const head = tag("div", "pane-head");
  head.append(tag("h2", "", title), close);
  const node = tag("div", "pane");
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-modal", "true");
  node.setAttribute("aria-label", title);
  node.tabIndex = -1;
  node.append(head, ...body);
  const scrim = tag("div", "scrim");
  // A block body: a handler property that returns false cancels the event, which would keep focus out of the pane's fields.
  // On the dimmed part the default is cancelled, so the press does not move focus off the opener to the body.
  scrim.onpointerdown = (e) => {
    if (e.target !== scrim) return;
    e.preventDefault();
    closePane();
  };
  scrim.append(node);
  const behind = [...document.querySelectorAll<HTMLElement>("#sidebar, #content")];
  pane = { scrim, behind, opener: document.activeElement as HTMLElement | null };
  behind.forEach((el) => (el.inert = true));
  document.body.append(scrim);
  node.focus();
}
