// The modal that shows the terminal of one session of the Orca list (A-40): a right click on a session row of a project that is not selected opens it in the middle of the screen, over a dimmed screen, and the terminal takes the keyboard.
// The terminal is shown through `showTerminals` with an owner of its own, so the work pane stays as it was: this module never touches it. A terminal is shown in one place at a time, so the Orca screen does not open it for the selected project (orca.ts).
// What the modal shows is given by orca.ts at each drawing (`drawPeek`), and it closes when orca.ts gives none (the session left the list, its project was selected, or the screen is no longer shown). Esc and the ✕ close it, and closing forgets the terminal, which stops its stream or its reads.
import type { OrcaStatus } from "./bindings/OrcaStatus";
import { $, composing } from "./dom.js";
import { isShowing, releaseTerminal, showTerminals, type TermSource } from "./orca-terminal.js";

const OWNER = "orca-peek";

// What the head and the terminal of the modal show: the session's status and its name, the project's name, the saved environment the session is in (null: this machine), and where its terminal comes from.
export interface PeekView {
  status: OrcaStatus;
  label: string;
  project: string;
  title: string;
  environment: string | null;
  source: TermSource;
}

// The session the modal was opened for (`project` is the key of the project, `tab` the id of the session's tab), and the `data-key` of the row it was opened from, which has the focus again when the modal closes.
let target: { project: string; tab: string; opener: string } | null = null;
// The handle of the terminal shown, to forget at close.
let held: string | null = null;
// What the head shows now: it is drawn again only when this changes.
let drawn = "";
let icon: (status: OrcaStatus, label: string) => HTMLElement = () => document.createElement("span");
// The parts of the screen behind the modal, inert while it is open so that Tab stays inside.
let behind: HTMLElement[] = [];

// The session the modal shows now, null when it is closed.
export const peeking = () => (target === null ? null : { project: target.project, tab: target.tab });

// Opens the modal for the session `tab` of the project `project`. `opener` is the `data-key` of the row.
export function openPeek(project: string, tab: string, opener: string) {
  closePeek();
  target = { project, tab, opener };
  drawn = "";
  behind = [...document.querySelectorAll<HTMLElement>("#sidebar, #content")];
  for (const el of behind) el.inert = true;
  $("orca-peek").hidden = false;
}

// Draws the head and shows the terminal of `view` (null: the session cannot be shown any more, so the modal closes). Nothing is drawn again when nothing changed.
export function drawPeek(view: PeekView | null) {
  if (target === null) return;
  if (view === null) return closePeek();
  const key = JSON.stringify([view.status, view.label, view.project, view.title, view.environment]);
  if (key !== drawn) {
    drawn = key;
    $("orca-peek-icon").replaceChildren(icon(view.status, view.label));
    $("orca-peek-project").textContent = view.project;
    $("orca-peek-title").textContent = view.title;
    const env = $("orca-peek-env");
    env.hidden = view.environment === null;
    env.textContent = view.environment ?? "";
    env.title = view.environment ?? "";
  }
  const placement = { id: view.source.handle, source: view.source, host: $("orca-peek-term") };
  if (held !== null && held !== placement.id) releaseTerminal(held, OWNER);
  held = placement.id;
  if (!isShowing(placement, OWNER)) showTerminals([placement], placement.id, OWNER);
}

// Closes the modal and forgets the terminal it showed (the screen behind keeps what it had).
export function closePeek() {
  if (target === null) return;
  const { opener } = target;
  target = null;
  $("orca-peek").hidden = true;
  for (const el of behind) el.inert = false;
  behind = [];
  if (held !== null) releaseTerminal(held, OWNER);
  held = null;
  document.querySelector<HTMLElement>(`#orca-feed [data-key="${CSS.escape(opener)}"]`)?.focus({ preventScroll: true });
}

// `statusIcon` is the Orca screen's own icon of a status.
export function initPeek(statusIcon: (status: OrcaStatus, label: string) => HTMLElement) {
  icon = statusIcon;
  $("orca-peek-close").onclick = closePeek;
  // Before the terminal sees the key: Esc is the modal's, so it is not sent to the session. An Escape that cancels IME conversion is the field's.
  document.addEventListener(
    "keydown",
    (e) => {
      if (target === null || e.key !== "Escape" || composing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      closePeek();
    },
    true,
  );
}
