// The side menu of the database screen (D-1): the connections by name, each with the button of its menu (edit, delete).
// Drawing only: what is held and what each press does belong to database.ts. It is drawn again only when what it shows changes, and the focus stays.
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import { $, tag } from "./dom.js";
import { DATABASE_SVG, DELETE_SVG, EDIT_SVG, MORE_SVG } from "./icons.js";
import { openMenu } from "./menu.js";

export interface SideState {
  profiles: DatabaseProfileView[];
  // The connection that was pressed last, or none.
  selected: string | null;
}

export interface SideActions {
  choose: (profile: DatabaseProfileView) => void;
  edit: (profile: DatabaseProfileView) => void;
  // `anchor` is the button of the row's menu, which the confirmation opens under.
  remove: (profile: DatabaseProfileView, anchor: Element) => void;
}

let drawn = "";

function itemNode(state: SideState, profile: DatabaseProfileView, actions: SideActions) {
  const item = tag("div", "database-item");
  const button = tag("button", "database-btn");
  button.type = "button";
  button.dataset.key = profile.id;
  button.setAttribute("aria-pressed", String(state.selected === profile.id));
  button.onclick = () => actions.choose(profile);
  const ic = tag("span", "database-ic");
  ic.innerHTML = DATABASE_SVG;
  button.append(ic, tag("span", "database-name", profile.name));
  const more = tag("button", "icon-btn database-more");
  more.type = "button";
  more.dataset.key = `${profile.id}/more`;
  more.setAttribute("aria-label", `${profile.name} のメニュー`);
  more.setAttribute("aria-haspopup", "menu");
  more.innerHTML = MORE_SVG;
  more.onclick = () =>
    openMenu(more, [
      { label: "編集", color: "", icon: EDIT_SVG, current: false, pick: () => actions.edit(profile) },
      { label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, pick: () => actions.remove(profile, more) },
    ]);
  item.append(button, more);
  return item;
}

export function drawDatabaseSide(state: SideState, actions: SideActions) {
  const key = JSON.stringify(state);
  if (key === drawn) return;
  drawn = key;
  const box = $("database-side-feed");
  const top = box.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  box.replaceChildren(...state.profiles.map((p) => itemNode(state, p, actions)));
  box.scrollTop = top;
  if (focused) box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
