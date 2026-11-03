// Changing a task: the screen is changed first, then Todoist, and the reload brings back what Todoist has.
import { $ } from "./dom.js";
import { invoke, type Commands } from "./ipc.js";
import { loadTodo, renderTodo } from "./todo.js";
import { editingField, isDueToday, moveLocal, moveUnderLocal, patchTask, setTodoCount, settleLocal, todoState, type TaskFields } from "./todo-data.js";
import { showError } from "./view.js";

// Reloads shortly after the last call, so a run of changes costs one load. Completed tasks are fetched again only when asked for by one of them.
let todoReloadTimer = 0;
let todoReloadDone = false;

export function cancelTodoReload() {
  clearTimeout(todoReloadTimer);
}

function scheduleTodoReload(withDone: boolean) {
  todoReloadDone ||= withDone;
  clearTimeout(todoReloadTimer);
  todoReloadTimer = setTimeout(() => {
    // The end of the last change in flight schedules it again.
    if (todoState.writes) return;
    const done = todoReloadDone;
    todoReloadDone = false;
    loadTodo(false, done);
  }, 300);
}

// The commands todoCall sends: they answer true or false, or null when a token is needed.
type Write = "todoist_add" | "todoist_add_subtask" | "todoist_set_done" | "todoist_update" | "todoist_move" | "todoist_move_under" | "todoist_delete";
const send = invoke as (command: Write, args: unknown) => Promise<boolean | null>;

// Runs a change, then reloads whether it worked or not, so the screen shows what Todoist has.
// `apply` first changes `todo` and draws it, so the screen does not wait for Todoist; a failed call is undone by the reload, as a removed mail row comes back.
// A load sent before a change started or ended is dropped (todoSeq): it could hold the state from before the change.
// A null answer (a token is needed) shows up in that reload. Returns the command's answer: null when it failed or a token is needed.
// `redraw` false (a name saved on blur) keeps the screen: a redraw there would drop the click or focus move that ended the edit.
export async function todoCall<C extends Write>(
  command: C,
  args: Commands[C]["args"],
  control?: HTMLInputElement | HTMLButtonElement | null,
  apply?: () => void,
  redraw = true,
) {
  $("error").hidden = true;
  if (control) control.disabled = true;
  todoState.writes++;
  todoState.seq++;
  let answer: boolean | null = null;
  try {
    if (apply) {
      apply();
      todoState.taskById = new Map(todoState.todo!.tasks.map((t) => [t.id, t]));
      setTodoCount(todoState.todo!.tasks.filter(isDueToday).length);
      // The screen no longer matches the last load, so a quiet reload must not skip drawing as unchanged.
      todoState.text = null;
      // Like a load: a field being typed in keeps what was typed, and the redraw waits.
      if (!redraw || editingField()) todoState.undrawn = true;
      else renderTodo();
    }
    answer = await send(command, args);
  } catch (e) {
    showError(e);
  } finally {
    todoState.writes--;
    todoState.seq++;
  }
  if (control) control.disabled = false;
  // Only completing or reopening a task changes the completed ones.
  scheduleTodoReload(command === "todoist_set_done");
  return answer;
}

export const saveTask = (id: string, fields: TaskFields) =>
  todoCall("todoist_update", { id, ...fields }, null, () => patchTask(id, fields), !("content" in fields));
export const moveTask = (id: string, projectId: string) => todoCall("todoist_move", { id, projectId }, null, () => moveLocal(id, projectId));
export async function moveUnder(id: string, parentId: string) {
  // The local move opens the parent so the moved row shows: a failed call closes it again if it was closed.
  const wasOpen = todoState.openTasks.has(parentId);
  const answer = await todoCall("todoist_move_under", { id, parentId }, null, () => moveUnderLocal(id, parentId));
  if (answer === null && !wasOpen) todoState.openTasks.delete(parentId);
  return answer;
}
export const setTaskDone = (id: string, done: boolean, box: HTMLInputElement) =>
  todoCall("todoist_set_done", { id, done }, box, () => settleLocal(id, done));
