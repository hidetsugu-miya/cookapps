// The Todo screen: which part it shows, loading and refreshing from Todoist, and the buttons of its header.
import type { Offline } from "./bindings/Offline";
import type { Todo } from "./bindings/Todo";
import { $ } from "./dom.js";
import { pad2 } from "./format.js";
import { DELETE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { currentScreen } from "./nav.js";
import { renderDetail } from "./todo-detail.js";
import { editingField, isDueToday, projectOf, setTodoCount, settleLocal, todoState } from "./todo-data.js";
import { renderList, renderProjects } from "./todo-list.js";
import { cancelTodoReload, todoCall } from "./todo-write.js";
import { showError } from "./view.js";

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
  $("todo-delete").hidden = mode !== "detail";
  $("todo-disconnect").hidden = mode === "token";
  $("todo-reload").hidden = mode === "token";
  resetDelete();
}

function showTokenForm(note = "") {
  // No reload is due: the form is what the screen shows now, and a load still in flight must not draw over it.
  cancelTodoReload();
  todoState.seq++;
  todoState.todo = null;
  todoState.kept = false;
  setTodoCount(0);
  todoState.open = null;
  $("todo-notice").replaceChildren();
  todoMode("token");
  $("todo-title").textContent = "Todo";
  $("todo-token-note").textContent = note;
  $("todo-token-input").focus();
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
// Without `withDone` the backend reuses the completed tasks it fetched last. Returns true when a token is needed (the token form is shown).
export async function loadTodo(quiet = false, withDone = true) {
  if (quiet && (editingField() || todoState.writes)) return false;
  const seq = ++todoState.seq;
  try {
    const data = await invoke("todoist_load", { withDone });
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

// Todoist cannot undo a delete, so the button asks twice: the first press changes its label, the second deletes.
let deleteTimer = 0;
function resetDelete() {
  clearTimeout(deleteTimer);
  const b = $("todo-delete");
  b.classList.remove("confirm", "danger");
  b.innerHTML = DELETE_SVG;
  b.setAttribute("aria-label", "削除");
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
    const data = await invoke("todoist_load", { withDone: todoState.countWithDone });
    if (data) {
      todoState.countWithDone = false;
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
  $("todo-delete").onclick = () => {
    const b = $("todo-delete");
    if (!b.classList.contains("confirm")) {
      b.classList.add("confirm", "danger");
      b.textContent = "もう一度押すと削除";
      b.setAttribute("aria-label", "もう一度押すと削除");
      deleteTimer = setTimeout(resetDelete, 4000);
      return;
    }
    const id = todoState.open!;
    todoState.open = null;
    // Gone from the list at once; the reload after the call brings it back if Todoist refused.
    todoCall("todoist_delete", { id }, null, () => settleLocal(id, null));
  };
  $("todo-delete").onblur = resetDelete;
  $("todo-back").onclick = () => {
    todoState.open = null;
    renderTodo();
  };
  $("todo-reload").onclick = () => loadTodo();
  $("todo-disconnect").onclick = async () => {
    $("error").hidden = true;
    try {
      await invoke("todoist_disconnect");
      showTokenForm("Todoist の接続を解除しました");
    } catch (e) {
      showError(e);
    }
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
