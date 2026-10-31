// Tooltip for icon-only controls. The native title is slow or missing in WKWebView, so the text is the control's aria-label.
import { popupOpen } from "./accounts.js";
import { el } from "./dom.js";

const TIP_DELAY_MS = 300;
let tip: HTMLElement;
let tipTimer = 0;

function hideTip() {
  clearTimeout(tipTimer);
  tip.hidden = true;
}

// Right of a sidebar control, below any other; kept inside the window. While the account popup is open it covers that area, so the sidebar's account and Claude avatars show none.
function showTip(target: Element) {
  hideTip();
  const inSidebar = target.closest("#sidebar");
  if (popupOpen() && target.closest("#account-list, #claude-btn")) return;
  tipTimer = setTimeout(() => {
    tip.textContent = target.getAttribute("aria-label");
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const left = inSidebar ? r.right + 8 : r.left + (r.width - tip.offsetWidth) / 2;
    const top = inSidebar ? r.top + (r.height - tip.offsetHeight) / 2 : r.bottom + 6;
    tip.style.left = `${Math.max(4, Math.min(left, innerWidth - tip.offsetWidth - 4))}px`;
    tip.style.top = `${Math.max(4, Math.min(top, innerHeight - tip.offsetHeight - 4))}px`;
  }, TIP_DELAY_MS);
}

// Delegated, so rows and avatars built later get tooltips too.
const TIP_TARGET = "button[aria-label], input[aria-label]";
const targetOf = (e: Event) => (e.target as Element).closest?.(TIP_TARGET);

export function initTooltip() {
  tip = el("tooltip");
  tip.hidden = true;
  document.body.append(tip);
  document.addEventListener("mouseover", (e) => {
    const t = targetOf(e);
    if (t && !t.contains(e.relatedTarget as Node | null)) showTip(t);
  });
  document.addEventListener("mouseout", (e) => {
    const t = targetOf(e);
    if (t && !t.contains(e.relatedTarget as Node | null)) hideTip();
  });
  // Only keyboard focus shows it; a click also focuses the control and must not bring the tooltip back.
  document.addEventListener("focusin", (e) => {
    const t = targetOf(e);
    if (t?.matches(":focus-visible")) showTip(t);
  });
  document.addEventListener("focusout", hideTip);
  document.addEventListener("pointerdown", hideTip);
  document.addEventListener("click", hideTip);
  document.addEventListener("scroll", hideTip, true);
  document.addEventListener("keydown", (e) => e.key === "Escape" && hideTip());
}
