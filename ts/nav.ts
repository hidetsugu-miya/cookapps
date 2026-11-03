// Which screen the sidebar selected, and the sidebar's buttons.
import { renderGoogleCard } from "./accounts.js";
import { $ } from "./dom.js";
import { showCalendar } from "./calendar.js";
import { closeDetail } from "./calendar-detail.js";
import { closeHint } from "./hint.js";
import { loadSettings, selectSettingsTab, type SettingsTab } from "./settings.js";
import { loadTodo, renderTodo } from "./todo.js";
import { todoState } from "./todo-data.js";
import { show } from "./view.js";

export type Screen = "mail" | "calendar" | "todo" | "settings";

// Which screen the sidebar selected, or "slack" while the Slack compose screen is open (the sidebar then still shows the inbox).
// Background work reads it; only the sidebar and the compose screen's open and close change it.
let screen: Screen | "slack" = "mail";
export const currentScreen = () => screen;

function markNav(name: Screen) {
  for (const [id, target] of [["nav-mail", "mail"], ["nav-calendar", "calendar"], ["nav-todo", "todo"], ["nav-settings", "settings"]]) {
    if (target === name) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
}

// The Todo prompt screen. The sidebar stays on the settings, and so does `currentScreen()`, so background work does not draw another screen under it.
export function showPromptScreen() {
  screen = "settings";
  markNav("settings");
  closeHint();
  $("error").hidden = true;
  show("prompt");
}

// The Slack compose screen, opened from a thread. The sidebar stays on the inbox, but `currentScreen()` is not "mail", so a list load or a sync does not draw the list over it.
export function showSlackScreen() {
  screen = "slack";
  markNav("mail");
  closeHint();
  $("error").hidden = true;
  show("slack");
}

// Back from the Slack compose screen to the open thread, which was left as it was (nothing is fetched again).
export function showThreadScreen() {
  screen = "mail";
  $("error").hidden = true;
  show("thread");
}

// `tab` is the settings tab to open on (Google when none is named).
export function setScreen(name: Screen, tab?: SettingsTab) {
  screen = name;
  closeHint();
  closeDetail();
  markNav(name);
  $("error").hidden = true;
  if (name === "calendar") {
    showCalendar();
  } else if (name === "todo") {
    show("todo");
    if (todoState.kept) renderTodo();
    // The backend keeps the completed tasks of the last load; they are fetched again only while `doneStale` is set (until a load has fetched from Todoist).
    loadTodo(false, todoState.todo === null || todoState.kept);
  } else if (name === "settings") {
    show("settings");
    selectSettingsTab(tab ?? "google");
    renderGoogleCard();
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
