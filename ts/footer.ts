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

// The text of a count at the corner of a mode button (99+ from 100).
const countText = (count: number) => (count > 99 ? "99+" : String(count));

// A button of the development screen's switch (A-35, A-37), an icon alone: the number at its corner is what waits for the owner (orange, none for 0, 99+ from 100), and work alone is no number but the icon, yellow and slowly fading (`.working`, as the sidebar's 開発 button). The label is the name and both counts, and the tooltip shows it.
function drawMode(id: string, name: string, waitingLabel: string, waiting: number, working: number) {
  const button = $(id);
  const badge = button.querySelector<HTMLElement>(".footer-mode-count")!;
  badge.hidden = waiting === 0;
  badge.textContent = waiting === 0 ? "" : countText(waiting);
  button.classList.toggle("working", working > 0);
  const parts = [...(waiting > 0 ? [`${waitingLabel} ${waiting} 件`] : []), ...(working > 0 ? [`作業中 ${working} 件`] : [])];
  button.setAttribute("aria-label", parts.length === 0 ? name : `${name}（${parts.join("、")}）`);
}

// The orchestration's button, in both modes: the children that wait for approval in all the formations, and the formations with a child that works.
export function setFormationCount(waiting: number, working: number) {
  drawMode("footer-mode-formation", "オーケストレーション", "承認待ち", waiting, working);
}

// Orca's button, in both modes: what waits for a check in the sidebar's 開発 button, and the projects with a working Claude.
export function setOrcaCount(waiting: number, working: number) {
  drawMode("footer-mode-orca", "Orca", "確認待ち", waiting, working);
}

// The switch between Orca and the orchestration (A-37): shown only while the development screen is, with the mode that is on pressed.
export function drawDevSwitch(shown: boolean, mode: DevMode) {
  $("footer-modes").hidden = !shown;
  for (const m of ["orca", "formation"] as const) $(`footer-mode-${m}`).setAttribute("aria-pressed", String(m === mode));
}
