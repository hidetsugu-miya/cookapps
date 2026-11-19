// Which screen the sidebar selected, and the sidebar's buttons.
import { closePopup, renderGoogleCard } from "./accounts.js";
import type { MenuEntry } from "./bindings/MenuEntry";
import type { MenuScreen } from "./bindings/MenuScreen";
import { $, composing, isMac } from "./dom.js";
import { showCalendar } from "./calendar.js";
import { hideCalendarClaude, syncCalendarClaude } from "./calendar-claude.js";
import { closeCreate } from "./calendar-create.js";
import { closeDetail } from "./calendar-detail.js";
import { databaseChanges, discardDatabaseChanges, showDatabase } from "./database.js";
import { closeDatabaseForm } from "./database-form.js";
import { hideFormation, showFormation } from "./formation.js";
import { logError } from "./error-card.js";
import { closeHint, confirmDiscardChanges } from "./hint.js";
import { invoke } from "./ipc.js";
import { pauseLsp } from "./orca-lsp.js";
import { showOrca } from "./orca.js";
import { loadSettings, selectSettingsTab, type SettingsTab } from "./settings.js";
import { showSlackList } from "./slack-list.js";
import { hideThreadClaude } from "./slack-thread.js";
import { loadTodo, renderTodo } from "./todo.js";
import { fetchOpenComments } from "./todo-comments.js";
import { hideSlackComposeClaude } from "./slack-compose-claude.js";
import { hideDraftClaude, syncDraftClaude } from "./todo-draft.js";
import { hidePromptClaude } from "./todo-prompt.js";
import { hideTodoClaude, syncTodoClaude } from "./todo-claude.js";
import { todoState } from "./todo-data.js";
import { show } from "./view.js";

export type Screen = "mail" | "calendar" | "todo" | "slack" | "orca" | "database" | "settings";

// Which screen the sidebar selected, or "compose" while the Slack compose screen is open, or "new-mail" while the screen that writes a new mail is (the sidebar then still shows the inbox).
// Background work reads it; only the sidebar and those screens' open and close change it.
let screen: Screen | "compose" | "new-mail" = "mail";
export const currentScreen = () => screen;

function markNav(name: Screen) {
  for (const [id, target] of [["nav-mail", "mail"], ["nav-calendar", "calendar"], ["nav-todo", "todo"], ["nav-slack", "slack"], ["nav-orca", "orca"], ["nav-database", "database"], ["nav-settings", "settings"]]) {
    if (target === name) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
}

// The accounts of a function sit under its icon in the sidebar, and only while that function is shown: the Google accounts under the calendar icon while the screen is mail
// (list, thread, the Slack compose screen) or calendar, the Slack workspaces under the Slack icon while the Slack screen is shown. Todo and settings (and the prompt screen reached from them) show neither.
// A popup of one of them closes with the screen.
function syncTrays() {
  closePopup();
  $("account-list").hidden = !(screen === "mail" || screen === "compose" || screen === "new-mail" || screen === "calendar");
  $("slack-workspace-list").hidden = screen !== "slack";
}

// The Todo prompt screen. The sidebar stays on the settings, and so does `currentScreen()`, so background work does not draw another screen under it.
export function showPromptScreen() {
  screen = "settings";
  markNav("settings");
  syncTrays();
  closeHint();
  show("prompt");
}

// The Slack compose screen, opened from a thread. The sidebar stays on the inbox, but `currentScreen()` is not "mail", so a list load or a sync does not draw the list over it.
export function showComposeScreen() {
  screen = "compose";
  markNav("mail");
  syncTrays();
  closeHint();
  show("slack");
}

// The screen that writes a new mail (M-11), opened from the header of the list. The sidebar stays on the inbox, but `currentScreen()` is not "mail", so a list load or a sync does not draw the list over it. It is left with `setScreen("mail")`.
export function showNewMailScreen() {
  screen = "new-mail";
  markNav("mail");
  syncTrays();
  closeHint();
  show("new-mail");
}

// Back from the Slack compose screen to the open thread, which was left as it was (nothing is fetched again).
export function showThreadScreen() {
  screen = "mail";
  syncTrays();
  show("thread");
}

// `tab` is the settings tab to open on (Google when none is named).
export function setScreen(name: Screen, tab?: SettingsTab) {
  // The changes that the records tab gathered and did not send go when the database screen is left, so it asks first (D-10).
  const gathered = screen === "database" && name !== "database" ? databaseChanges() : 0;
  if (gathered > 0) {
    confirmDiscardChanges($(`nav-${name}`), gathered, () => {
      discardDatabaseChanges();
      setScreen(name, tab);
    });
    return;
  }
  screen = name;
  closeHint();
  closeDetail();
  closeCreate();
  closeDatabaseForm();
  // The terminal of the Todo screen's Claude pane is hidden while another screen is shown (its process goes on).
  if (name !== "todo") {
    hideTodoClaude();
    // The same for the pane of the page of a Todo draft (S-18), which the Todo screen holds.
    hideDraftClaude();
  }
  // The same for the Claude pane of the calendar screen.
  if (name !== "calendar") hideCalendarClaude();
  // The same for the Claude pane of the Slack compose screen, which is left by every screen the sidebar shows.
  hideSlackComposeClaude();
  // The same for the Claude Code pane of the Slack thread (S-7).
  hideThreadClaude();
  // The same for the Claude pane of the Todo prompt screen, which "戻る" and the sidebar leave through here.
  hidePromptClaude();
  if (name !== "orca") {
    hideFormation();
    // The language server's settings are read by the clock only while the Orca screen is shown (A-34).
    pauseLsp();
  }
  markNav(name);
  syncTrays();
  if (name === "calendar") {
    showCalendar();
    syncCalendarClaude();
  } else if (name === "todo") {
    show("todo");
    syncTodoClaude();
    syncDraftClaude();
    if (todoState.kept) renderTodo();
    fetchOpenComments();
    // The backend keeps the completed tasks of the last load; they are fetched again only while `doneStale` is set (until a load has fetched from Todoist).
    loadTodo(false, todoState.todo === null || todoState.kept);
  } else if (name === "slack") {
    showSlackList();
  } else if (name === "orca") {
    // The development screen: the list, and the work pane of Orca or the panes of the formation, whichever the list has selected (A-37).
    showOrca();
    showFormation();
  } else if (name === "database") {
    showDatabase();
  } else if (name === "settings") {
    show("settings");
    selectSettingsTab(tab ?? "google");
    renderGoogleCard();
    loadSettings();
  } else {
    show("list");
  }
}

// The elements of the sidebar that belong to each screen the menu moves (A-5): its button, and the tray under it (the Google accounts under the calendar, the Slack workspaces under Slack).
const MENU_PARTS: Record<MenuScreen, string[]> = {
  mail: ["nav-mail"],
  calendar: ["nav-calendar", "account-list"],
  todo: ["nav-todo"],
  slack: ["nav-slack", "slack-workspace-list"],
  orca: ["nav-orca"],
  database: ["nav-database"],
};

// The screens the sidebar shows, from top to bottom: ⌘1 is the first. The order the sidebar was written in until the saved one is read.
let shown: MenuScreen[] = ["mail", "calendar", "todo", "slack", "orca", "database"];

// Puts the screens in the saved order above the bottom group, takes off the ones that are off, and gives each shown button its number for the tooltip and the keys.
function drawMenu(items: MenuEntry[]) {
  shown = items.filter((entry) => entry.enabled).map((entry) => entry.screen);
  for (const { screen, enabled } of items) {
    const [button, ...rest] = MENU_PARTS[screen].map($);
    for (const part of [button, ...rest]) {
      $("sidebar-bottom").before(part);
      part.classList.toggle("menu-off", !enabled);
    }
    if (enabled) button.dataset.shortcut = `${isMac ? "⌘" : "Ctrl+"}${shown.indexOf(screen) + 1}`;
    else delete button.dataset.shortcut;
  }
}

// ⌘1 to ⌘6 press the button of the screen at that place among the shown ones, as a click does (a button that is disabled does nothing). It is caught before the focused part sees it, so a terminal does not take it.
function initMenuKeys() {
  document.addEventListener(
    "keydown",
    (e) => {
      if (!(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey || e.shiftKey || composing(e) || !/^[1-6]$/.test(e.key)) return;
      const target = shown[Number(e.key) - 1];
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      $(MENU_PARTS[target][0]).click();
    },
    true,
  );
}

export function initNav() {
  $("nav-mail").onclick = () => setScreen("mail");
  $("nav-calendar").onclick = () => setScreen("calendar");
  $("nav-todo").onclick = () => setScreen("todo");
  $("nav-slack").onclick = () => setScreen("slack");
  $("nav-orca").onclick = () => setScreen("orca");
  $("nav-database").onclick = () => setScreen("database");
  syncTrays();
  $("nav-settings").onclick = () => setScreen("settings");
  initMenuKeys();
  invoke("side_menu_settings").then((settings) => drawMenu(settings.items), (e) => logError("side-menu", e));
}
