// The menu under a button: a list to pick from, or any node (the due popover, the Slack destination picker). One at a time.
import { composing, partMatcher, tag } from "./dom.js";

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
// `point` puts the menu at that place (the pointer of a right press) instead of under `anchor`.
export function showMenu(anchor: Element, node: HTMLElement, onOutside?: () => void, point?: { x: number; y: number }) {
  closeMenu();
  menuEl = node;
  menuOnOutside = onOutside ?? null;
  menuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  document.body.append(node);
  const r = anchor.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(point?.x ?? r.left, innerWidth - node.offsetWidth - 8))}px`;
  const top = Math.max(8, Math.min(point?.y ?? r.bottom + 4, innerHeight - node.offsetHeight - 8));
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
  // A line drawn above the row, to set it apart from the rows before it.
  divider?: boolean;
  // A small label at the right end of the row.
  tag?: string;
  // A second line under the label (A-9: the branch under the name of a worktree); the search matches it too.
  sub?: string;
  pick: () => unknown;
}

export interface MenuOptions {
  // A field at the top of the menu that narrows the rows to those whose label holds the text (A-9): its `aria-label`, and the line shown when no row matches.
  search?: { label: string; empty: string };
  // Where the menu opens when it is not under its anchor (the pointer of a right press).
  at?: { x: number; y: number };
}

export function openMenu(anchor: Element, items: MenuItem[], options: MenuOptions = {}) {
  const menu = tag("div", "menu");
  menu.setAttribute("role", "menu");
  // With a search field the rows scroll in `list` and the field stays above them.
  const list = options.search ? tag("div", "menu-list") : menu;
  const rows = items.map((item) => {
    if (item.divider) {
      const line = tag("div", "menu-sep");
      line.setAttribute("role", "separator");
      list.append(line);
    }
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
    if (item.sub) {
      b.classList.add("menu-two-line");
      const text = tag("span", "menu-text");
      text.append(tag("span", "menu-main", item.label), tag("span", "menu-sub", item.sub));
      b.append(text);
    } else b.append(item.label);
    if (item.tag) b.append(tag("span", "tag", item.tag));
    b.onclick = () => {
      closeMenu();
      item.pick();
    };
    list.append(b);
    return { item, b };
  });
  if (!options.search) {
    showMenu(anchor, menu, undefined, options.at);
    menu.querySelector("button")!.focus();
    return;
  }
  const input = tag("input", "menu-search");
  input.type = "text";
  input.placeholder = "検索";
  input.setAttribute("aria-label", options.search.label);
  input.autocomplete = "off";
  input.spellcheck = false;
  const none = tag("div", "menu-empty", options.search.empty);
  none.hidden = true;
  list.append(none);
  menu.classList.add("menu-searchable");
  menu.append(input, list);
  // The rows the text leaves, and the one the keys are on (the first, until a key moves it; a change of the text puts it on the first again).
  let shown = rows;
  let at = 0;
  const mark = (scroll: boolean) => {
    for (const r of rows) delete r.b.dataset.cursor;
    const on = shown[at];
    if (!on) return;
    on.b.dataset.cursor = "true";
    if (scroll) on.b.scrollIntoView({ block: "nearest" });
  };
  input.oninput = () => {
    const re = partMatcher(input.value);
    for (const r of rows) r.b.hidden = re !== null && !re.test(r.item.label) && !(r.item.sub !== undefined && re.test(r.item.sub));
    shown = rows.filter((r) => !r.b.hidden);
    none.hidden = shown.length > 0;
    at = 0;
    mark(true);
  };
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = Math.min(shown.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
      mark(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      shown[at]?.b.click();
    }
  };
  showMenu(anchor, menu);
  // The width stays while the rows shrink, so that the menu does not jump under the pointer.
  menu.style.minWidth = `${menu.offsetWidth}px`;
  mark(false);
  input.focus();
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
