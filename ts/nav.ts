// Which screen the sidebar selected, and the sidebar's buttons.
import { closePopup, renderGoogleCard } from "./accounts.js";
import { $ } from "./dom.js";
import { showCalendar } from "./calendar.js";
import { closeDetail } from "./calendar-detail.js";
import { closeHint } from "./hint.js";
import { showOrca } from "./orca.js";
import { loadSettings, selectSettingsTab, type SettingsTab } from "./settings.js";
import { showSlackList } from "./slack-list.js";
import { loadTodo, renderTodo } from "./todo.js";
import { fetchOpenComments } from "./todo-comments.js";
import { todoState } from "./todo-data.js";
import { show } from "./view.js";

export type Screen = "mail" | "calendar" | "todo" | "slack" | "orca" | "settings";

// Which screen the sidebar selected, or "compose" while the Slack compose screen is open (the sidebar then still shows the inbox).
// Background work reads it; only the sidebar and the compose screen's open and close change it.
let screen: Screen | "compose" = "mail";
export const currentScreen = () => screen;

function markNav(name: Screen) {
  for (const [id, target] of [["nav-mail", "mail"], ["nav-calendar", "calendar"], ["nav-todo", "todo"], ["nav-slack", "slack"], ["nav-orca", "orca"], ["nav-settings", "settings"]]) {
    if (target === name) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
}

// The accounts of a function sit under its icon in the sidebar, and only while that function is shown: the Google accounts under the calendar icon while the screen is mail
// (list, thread, the Slack compose screen) or calendar, the Slack workspaces under the Slack icon while the Slack screen is shown. Todo and settings (and the prompt screen reached from them) show neither.
// A popup of one of them closes with the screen.
function syncTrays() {
  closePopup();
  $("account-list").hidden = !(screen === "mail" || screen === "compose" || screen === "calendar");
  $("slack-workspace-list").hidden = screen !== "slack";
}

// The Todo prompt screen. The sidebar stays on the settings, and so does `currentScreen()`, so background work does not draw another screen under it.
export function showPromptScreen() {
  screen = "settings";
  markNav("settings");
  syncTrays();
  closeHint();
  $("error").hidden = true;
  show("prompt");
}

// The Slack compose screen, opened from a thread. The sidebar stays on the inbox, but `currentScreen()` is not "mail", so a list load or a sync does not draw the list over it.
export function showComposeScreen() {
  screen = "compose";
  markNav("mail");
  syncTrays();
  closeHint();
  $("error").hidden = true;
  show("slack");
}

// Back from the Slack compose screen to the open thread, which was left as it was (nothing is fetched again).
export function showThreadScreen() {
  screen = "mail";
  syncTrays();
  $("error").hidden = true;
  show("thread");
}

// `tab` is the settings tab to open on (Google when none is named).
export function setScreen(name: Screen, tab?: SettingsTab) {
  screen = name;
  closeHint();
  closeDetail();
  markNav(name);
  syncTrays();
  $("error").hidden = true;
  if (name === "calendar") {
    showCalendar();
  } else if (name === "todo") {
    show("todo");
    if (todoState.kept) renderTodo();
    fetchOpenComments();
    // The backend keeps the completed tasks of the last load; they are fetched again only while `doneStale` is set (until a load has fetched from Todoist).
    loadTodo(false, todoState.todo === null || todoState.kept);
  } else if (name === "slack") {
    showSlackList();
  } else if (name === "orca") {
    showOrca();
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
  $("nav-slack").onclick = () => setScreen("slack");
  $("nav-orca").onclick = () => setScreen("orca");
  syncTrays();
  $("nav-settings").onclick = () => setScreen("settings");
}
