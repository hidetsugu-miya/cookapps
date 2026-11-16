// The footer under every screen (A-35): the bell with the unread count of the inbox and of the Slack list added up, and, while the development screen is shown, the switch of its mode at the left end (A-37).
import { $ } from "./dom.js";
import type { DevMode } from "./formation.js";

// What the pane of the unread (unread-pane.ts) does when the count changes: it draws its heading again.
let onCount: ((count: number) => void) | null = null;
export function watchFooterCount(listener: (count: number) => void) {
  onCount = listener;
}

// The count on the bell (99+ from 100; none for 0). The label carries it too.
export function setFooterCount(count: number) {
  const badge = $("footer-bell").querySelector<HTMLElement>(".footer-count")!;
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : String(count);
  $("footer-bell").setAttribute("aria-label", count === 0 ? "通知" : `通知（未読 ${count} 件）`);
  onCount?.(count);
}

// The count of the children that wait for approval, at the corner of the orchestration's icon while Orca is the mode (A-37).
export function setFormationWaiting(count: number) {
  const button = $("footer-mode-formation");
  const badge = button.querySelector<HTMLElement>(".footer-mode-count")!;
  badge.hidden = count === 0;
  badge.textContent = String(count);
  button.setAttribute("aria-label", count === 0 ? "オーケストレーション" : `オーケストレーション（承認待ち ${count} 件）`);
}

// The switch between Orca and the orchestration (A-37): shown only while the development screen is, with the name beside the icon of the mode that is on.
export function drawDevSwitch(shown: boolean, mode: DevMode) {
  $("footer-modes").hidden = !shown;
  for (const m of ["orca", "formation"] as const) {
    const button = $(`footer-mode-${m}`);
    button.setAttribute("aria-pressed", String(m === mode));
    button.querySelector<HTMLElement>(".footer-mode-name")!.hidden = m !== mode;
  }
}
