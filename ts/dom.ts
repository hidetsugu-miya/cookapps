// Small DOM helpers shared by every screen.
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function el(className: string, text = ""): HTMLDivElement {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  return div;
}

export function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

export function tag<K extends keyof HTMLElementTagNameMap>(name: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  node.className = className;
  node.textContent = text;
  return node;
}

// WebKit fires compositionend before the keydown of the Enter that confirms a conversion, so isComposing is already false then; keyCode is 229.
export const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;

// Pressing Enter in a field commits it; Enter that confirms an IME conversion does not.
export const onEnter = (input: HTMLInputElement, action: () => void) => {
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !composing(e)) action();
  };
};

// The matcher of a search field (A-9, A-19): the text, trimmed, as a regular expression with its special characters escaped, so that a "." or a "(" matches itself, and case ignored. Null while the text is blank (no search). The capture group serves `split` (the bold letters of the Orca list).
export function partMatcher(text: string): RegExp | null {
  const needle = text.trim();
  return needle === "" ? null : new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i");
}

// Whether this is macOS: Cmd is the shortcut key there, Ctrl elsewhere.
export const isMac = /Mac/.test(navigator.platform);
