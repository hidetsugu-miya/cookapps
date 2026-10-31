// Which screen the sidebar selected, and the sidebar's buttons.
import { $ } from "./dom.js";
import { showCalendar } from "./calendar.js";
import { closeHint } from "./hint.js";
import { loadSettings } from "./settings.js";
import { loadTodo, renderTodo } from "./todo.js";
import { todoState } from "./todo-data.js";
import { show } from "./view.js";

export type Screen = "mail" | "calendar" | "todo" | "settings";

// Which screen the sidebar selected. Background work reads it; only the sidebar changes it.
let screen: Screen = "mail";
export const currentScreen = () => screen;

export function setScreen(name: Screen) {
  screen = name;
  closeHint();
  for (const [id, target] of [["nav-mail", "mail"], ["nav-calendar", "calendar"], ["nav-todo", "todo"], ["nav-settings", "settings"]]) {
    if (target === name) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  $("error").hidden = true;
  if (name === "calendar") {
    showCalendar();
  } else if (name === "todo") {
    show("todo");
    if (todoState.kept) renderTodo();
    // The backend keeps the completed tasks of the last load; they are fetched again only on the first one.
    loadTodo(false, todoState.todo === null || todoState.kept);
  } else if (name === "settings") {
    show("settings");
    loadSettings();
  } else {
    show("list");
  }
}

export function initNav() {
  $("nav-mail").onclick = () => setScreen("mail");
  $("nav-calendar").onclick = () => setScreen("calendar");
  $("nav-todo").onclick = () => setScreen("todo");
  $("nav-settings").onclick = () => setScreen("settings");
}
