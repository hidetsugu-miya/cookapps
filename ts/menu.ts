// The menu under a button: a list to pick from, or any node (the due popover, the Slack dialog). One at a time.
import { composing, tag } from "./dom.js";

// The menu under `anchor`; one at a time, closed by a pick, a click elsewhere, or Escape.
let menuEl: HTMLElement | null = null;

export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

// Shows `node` as the open menu, under `anchor` and inside the window.
export function showMenu(anchor: Element, node: HTMLElement) {
  closeMenu();
  menuEl = node;
  document.body.append(node);
  const r = anchor.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(r.left, innerWidth - node.offsetWidth - 8))}px`;
  const top = Math.max(8, Math.min(r.bottom + 4, innerHeight - node.offsetHeight - 8));
  node.style.top = `${top}px`;
  // The top stays where it is when the menu grows later (the channel list), so the growth stops at the window's edge.
  node.style.maxHeight = `${innerHeight - top - 8}px`;
}

export interface MenuItem {
  label: string;
  color: string;
  current: boolean;
  // How deep the item is nested, shown as an indent.
  depth?: number;
  pick: () => unknown;
}

export function openMenu(anchor: Element, items: MenuItem[]) {
  const menu = tag("div", "menu");
  menu.setAttribute("role", "menu");
  for (const item of items) {
    const b = tag("button");
    b.setAttribute("role", "menuitem");
    b.setAttribute("aria-current", String(item.current));
    const dot = tag("span", "pdot");
    dot.style.background = item.color;
    if (item.depth) b.style.paddingLeft = `${10 + item.depth * 16}px`;
    b.append(dot, item.label);
    b.onclick = () => {
      closeMenu();
      item.pick();
    };
    menu.append(b);
  }
  showMenu(anchor, menu);
  menu.querySelector("button")!.focus();
}

export function initMenu() {
  document.addEventListener("pointerdown", (e) => {
    if (menuEl && !(e.target as Element).closest(".menu")) closeMenu();
  });
  // An Escape that cancels IME conversion is the field's, not the menu's.
  document.addEventListener("keydown", (e) => e.key === "Escape" && !composing(e) && closeMenu());
}
