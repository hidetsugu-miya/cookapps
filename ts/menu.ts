// The menu under a button: a list to pick from, or any node (the due popover, the Slack destination picker). One at a time.
import { composing, tag } from "./dom.js";

// The menu under `anchor`; one at a time, closed by a pick, a click elsewhere, or Escape.
let menuEl: HTMLElement | null = null;
// The anchor of the open menu carries aria-expanded="true" while it is open.
let menuAnchor: Element | null = null;
// What the open menu does when a click elsewhere closes it (the due popover confirms its text); no other way of closing runs it.
let menuOnOutside: (() => void) | null = null;

export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  menuOnOutside = null;
  menuAnchor?.removeAttribute("aria-expanded");
  menuAnchor = null;
}

// Shows `node` as the open menu, under `anchor` and inside the window. `onOutside` runs after a click elsewhere closed it.
export function showMenu(anchor: Element, node: HTMLElement, onOutside?: () => void) {
  closeMenu();
  menuEl = node;
  menuOnOutside = onOutside ?? null;
  menuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
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
  // The markup of a line icon (a constant of icons.ts, never text from outside) shown in place of the dot of `color`.
  icon?: string;
  current: boolean;
  // How deep the item is nested, shown as an indent.
  depth?: number;
  // A small label at the right end of the row.
  tag?: string;
  pick: () => unknown;
}

export function openMenu(anchor: Element, items: MenuItem[]) {
  const menu = tag("div", "menu");
  menu.setAttribute("role", "menu");
  for (const item of items) {
    const b = tag("button");
    b.setAttribute("role", "menuitem");
    b.setAttribute("aria-current", String(item.current));
    if (item.icon) b.innerHTML = item.icon;
    else {
      const dot = tag("span", "pdot");
      dot.style.background = item.color;
      b.append(dot);
    }
    if (item.depth) b.style.paddingLeft = `${10 + item.depth * 16}px`;
    b.append(item.label);
    if (item.tag) b.append(tag("span", "tag", item.tag));
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
    if (!menuEl || (e.target as Element).closest(".menu")) return;
    const onOutside = menuOnOutside;
    closeMenu();
    onOutside?.();
  });
  // An Escape that cancels IME conversion is the field's, not the menu's.
  document.addEventListener("keydown", (e) => e.key === "Escape" && !composing(e) && closeMenu());
}
