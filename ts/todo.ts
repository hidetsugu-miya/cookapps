// The Todo screen: which part it shows, loading and refreshing from Todoist, and the header's back button and the menu of the open task.
import type { Offline } from "./bindings/Offline";
import type { Todo } from "./bindings/Todo";
import { $, tag } from "./dom.js";
import { pad2 } from "./format.js";
import { COPY_SVG, DELETE_SVG, LINK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { currentScreen } from "./nav.js";
import { renderDetail } from "./todo-detail.js";
import { editingField, isDueToday, projectOf, setTodoCount, settleLocal, todoState } from "./todo-data.js";
import { renderList, renderProjects } from "./todo-list.js";
import { cancelTodoReload, todoCall } from "./todo-write.js";
import { copyText, showError } from "./view.js";

const TODO_REFRESH_MS = 10 * 1000;

// Which part the Todo screen shows: the token form, the task list, or one task.
export function todoMode(mode: "token" | "list" | "detail") {
  $("todo-token").hidden = mode !== "token";
  $("projects").hidden = mode === "token";
  $("todo-add").hidden = mode !== "list";
  $("todo-pending").hidden = mode !== "list";
  $("todo-list").hidden = mode !== "list";
  $("todo-detail").hidden = mode !== "detail";
  $("todo-back").hidden = mode !== "detail";
  $("todo-more").hidden = mode !== "detail";
  // A redraw of the same task keeps its menu open; another task or another part closes it.
  if (moreMenu && (mode !== "detail" || todoState.open !== moreMenu.id)) closeMoreMenu();
}

// Shows the token form and forgets the content: a missing token, or one the settings screen just removed.
export function showTokenForm(note = "") {
  // No reload is due: the form is what the screen shows now, and a load still in flight must not draw over it.
  cancelTodoReload();
  todoState.seq++;
  todoState.todo = null;
  todoState.kept = false;
  // The disconnect cleared the backend's completed tasks too.
  todoState.doneStale = true;
  setTodoCount(0);
  todoState.open = null;
  $("todo-notice").replaceChildren();
  todoMode("token");
  $("todo-title").textContent = "Todo";
  $("todo-token-note").textContent = note;
  // Not from the settings screen: the form is hidden there.
  if (currentScreen() === "todo") $("todo-token-input").focus();
}

export function renderTodo() {
  todoState.undrawn = false;
  if (!projectOf(todoState.view) && todoState.view !== "today" && todoState.view !== "inbox") todoState.view = "today";
  renderProjects();
  if (todoState.open) renderDetail();
  else renderList();
}

// Says that the list is the last one fetched (`offline` is set by the backend), or clears the notice.
function drawTodoNotice(offline: Offline | null | undefined) {
  const notice = $("todo-notice");
  let text = "";
  if (offline) {
    const d = new Date(offline.fetchedAt);
    text = `Todoist に接続できません（${offline.reason}）。${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())} 時点の内容を表示しています。`;
  }
  // Drawn again only when the words change.
  if (notice.textContent === text) return;
  const div = document.createElement("div");
  div.textContent = text;
  notice.replaceChildren(...(text ? [div] : []));
}

// Fetches the tasks and draws them. `quiet` is the timed refresh: it fetches nothing while a field is being typed in, and draws nothing when nothing changed.
// Without `withDone` the backend reuses the completed tasks it fetched last, unless `doneStale` says it has none. Returns true when a token is needed (the token form is shown).
export async function loadTodo(quiet = false, withDone = true) {
  if (quiet && (editingField() || todoState.writes)) return false;
  const seq = ++todoState.seq;
  try {
    const data = await invoke("todoist_load", { withDone: withDone || todoState.doneStale });
    if (data) todoState.doneStale = Boolean(data.offline);
    // Not while a change is in flight: the reload after the last one draws.
    if (seq !== todoState.seq || currentScreen() !== "todo" || todoState.writes) return false;
    if (data === null) {
      showTokenForm();
      return true;
    }
    const text = quiet ? JSON.stringify(data) : null;
    const same = text !== null && text === todoState.text;
    todoState.text = text;
    todoState.todo = data;
    todoState.loaded = seq;
    todoState.kept = false;
    todoState.countOff = false;
    // Also while a field is being typed in, when nothing is drawn below.
    setTodoCount(data.tasks.filter(isDueToday).length);
    todoState.projectById = new Map(data.projects.map((p) => [p.id, p]));
    todoState.taskById = new Map(data.tasks.map((t) => [t.id, t]));
    drawTodoNotice(data.offline);
    // A field being typed in keeps what was typed; the detail is drawn after the focus leaves, by the next save's load or the next refresh.
    if (editingField()) {
      todoState.undrawn = true;
      return false;
    }
    if (quiet && same && !todoState.undrawn) return false;
    renderTodo();
  } catch (e) {
    showError(e);
  }
  return false;
}

// The menu of the open task, opened for task `id`: every item acts on that task, whatever is open when it is pressed.
// Todoist cannot undo a delete, so 削除 asks twice: the first press changes its label, the second deletes.
let moreMenu: { id: string; timer: number } | null = null;

function closeMoreMenu() {
  if (!moreMenu) return;
  clearTimeout(moreMenu.timer);
  moreMenu = null;
  // The anchor is expanded only while this menu is the open one.
  if ($("todo-more").hasAttribute("aria-expanded")) closeMenu();
}

function menuItem(icon: string, label: string) {
  const b = tag("button");
  b.setAttribute("role", "menuitem");
  b.insertAdjacentHTML("beforeend", icon);
  const text = tag("span", "", label);
  b.append(text);
  return { b, text };
}

function openMoreMenu() {
  const id = todoState.open;
  if (!id) return;
  const menu = tag("div", "menu");
  menu.setAttribute("role", "menu");
  const url = todoState.taskById.get(id)?.url;
  // An empty url (an old cache, an ID the backend refuses) has nothing to copy.
  if (url) {
    const copy = menuItem(LINK_SVG, "タスクのリンクをコピー");
    copy.b.onclick = async () => {
      if (await copyText(url, "リンクをコピーしました")) closeMoreMenu();
    };
    menu.append(copy.b);
  }
  // Read when pressed: a refresh may have changed the description since the menu opened.
  if (todoState.taskById.get(id)?.description) {
    const copy = menuItem(COPY_SVG, "説明をコピー");
    copy.b.onclick = async () => {
      const text = todoState.taskById.get(id)?.description;
      if (text && (await copyText(text, "説明をコピーしました"))) closeMoreMenu();
    };
    menu.append(copy.b);
  }
  const del = menuItem(DELETE_SVG, "削除");
  del.b.classList.add("danger");
  let asked = false;
  del.b.onclick = () => {
    if (!moreMenu) return;
    if (!asked) {
      asked = true;
      del.text.textContent = "もう一度押すと削除";
      moreMenu.timer = setTimeout(() => {
        asked = false;
        del.text.textContent = "削除";
      }, 4000);
      return;
    }
    closeMoreMenu();
    todoState.open = null;
    // Gone from the list at once; the reload after the call brings it back if Todoist refused.
    todoCall("todoist_delete", { id }, null, () => settleLocal(id, null));
  };
  menu.append(del.b);
  closeMoreMenu();
  showMenu($("todo-more"), menu);
  moreMenu = { id, timer: 0 };
  menu.querySelector("button")!.focus();
}

// Draws the content the last run kept, on the sidebar's count and, if it is open, the Todo screen, while the first fetch is on its way.
// A fetch that answered first, a missing token (no kept content) or a failed read leaves everything to the fetch. The kept content carries no offline notice.
async function showKeptTodo() {
  let kept: Todo | null = null;
  try {
    kept = await invoke("todoist_cached");
  } catch {}
  if (!kept || todoState.todo !== null || todoState.seq !== 0) return;
  todoState.todo = kept;
  todoState.kept = true;
  todoState.projectById = new Map(kept.projects.map((p) => [p.id, p]));
  todoState.taskById = new Map(kept.tasks.map((t) => [t.id, t]));
  setTodoCount(kept.tasks.filter(isDueToday).length);
  if (currentScreen() === "todo") renderTodo();
}

// Fetches only for the Todo count on the sidebar while another screen is shown: `todo` and the Todo screen stay as they are, a missing token shows no count, and nothing shows a message.
async function loadTodoCount() {
  if (currentScreen() === "todo" || document.hidden || todoState.countOff || todoState.writes) return;
  // A change that started or ended while fetching makes the answer older than the screen's count.
  const seq = todoState.seq;
  let count = 0;
  try {
    const data = await invoke("todoist_load", { withDone: todoState.doneStale });
    if (data) {
      todoState.doneStale = Boolean(data.offline);
      count = data.tasks.filter(isDueToday).length;
    } else todoState.countOff = true;
  } catch {
    // A failure keeps the last count, so the Dock badge does not drop the Todo part meanwhile.
    return;
  }
  // The Todo screen sets the count itself, and its data is newer than this fetch.
  if (currentScreen() !== "todo" && !todoState.writes && seq === todoState.seq) setTodoCount(count);
}

// The timed refresh, also when the window comes back. The backend asks Todoist for the changes only, so it is cheap; the completed tasks are not fetched again.
// One at a time: while Todoist does not answer, the next rounds are skipped instead of piling up behind the backend's lock.
let refreshingTodo = false;
async function refreshTodo() {
  if (refreshingTodo || document.hidden) return;
  refreshingTodo = true;
  try {
    if (currentScreen() !== "todo") await loadTodoCount();
    // Not while the token form is up: a load would read the keychain and draw the form again, dropping what is typed in it.
    else if ($("todo-token").hidden) await loadTodo(true, false);
  } finally {
    refreshingTodo = false;
  }
}

export function initTodo() {
  // The document's pointerdown closes an open menu before the click, so whether this press found it open is read before that.
  let wasOpen = false;
  $("todo-more").onpointerdown = () => (wasOpen = $("todo-more").hasAttribute("aria-expanded"));
  $("todo-more").onclick = () => {
    const was = wasOpen || $("todo-more").hasAttribute("aria-expanded");
    wasOpen = false;
    if (was) closeMoreMenu();
    else openMoreMenu();
  };
  $("todo-back").onclick = () => {
    todoState.open = null;
    renderTodo();
  };
  $("todo-token").onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("todo-token-input");
    const token = input.value;
    // The token is never shown: the field is emptied as soon as it is read.
    input.value = "";
    $("error").hidden = true;
    try {
      await invoke("todoist_save_token", { token });
    } catch (err) {
      return showError(err);
    }
    // Only a rejected token says so; a failed load (network, 5xx) shows its own error.
    if (await loadTodo()) showTokenForm("トークンを確認できませんでした。もう一度入力してください");
  };
  showKeptTodo();
  loadTodoCount();
  setInterval(refreshTodo, TODO_REFRESH_MS);
  document.addEventListener("visibilitychange", refreshTodo);
}
