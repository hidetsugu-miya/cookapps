import { el } from "./dom.js";

// Short notice at the bottom right; it fades after a few seconds.
let toastEl: HTMLElement;
let toastTimer = 0;

export function initToast() {
  toastEl = el("toast");
  toastEl.hidden = true;
  toastEl.setAttribute("role", "status");
  document.body.append(toastEl);
}

export const hideToast = () => (toastEl.hidden = true);

// `action` ({ label, run }) adds a button that hides the notice and runs `run`.
export function toast(text: string, action?: { label: string; run: () => void }) {
  toastEl.textContent = text;
  if (action) {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.onclick = () => {
      toastEl.hidden = true;
      action.run();
    };
    toastEl.append(button);
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
}
