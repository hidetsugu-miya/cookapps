// The Todo screen's data: the state the Todo modules share, and the functions that read it or change it in place.
import type { ParentRef } from "./bindings/ParentRef";
import type { ProjectItem } from "./bindings/ProjectItem";
import type { TaskItem } from "./bindings/TaskItem";
import type { Todo } from "./bindings/Todo";
import { accountButtons } from "./accounts.js";
import { $ } from "./dom.js";
import { isoDate } from "./format.js";
import { setNavCount } from "./view.js";

export const todoState = {
  // The last data from the backend, or null while a token is needed.
  todo: null as Todo | null,
  // Set while `todo` is the content the last run kept (drawn at startup), not a fetch of this run: the first load still takes the completed tasks.
  kept: false,
  // "today", "inbox", or a project's ID.
  view: "today",
  // The ID of the task shown in the detail view, or null for the list.
  open: null as string | null,
  // Only the latest of overlapping loads may draw.
  seq: 0,
  // The `seq` of the load whose data `todo` holds (whether or not it was drawn); the subtasks being created are shown until a load that began after their creation is drawn.
  loaded: 0,
  // Changes in flight (todoCall's writes). While any is, a load draws nothing: it could hold the state from before the change and put it back.
  writes: 0,
  // True while a row is dragged by its grip, so the timed refresh does not redraw the list under it.
  dragging: false,
  // Set when a load updated `todo` without drawing it (a field was being typed in), so the next quiet refresh draws it even if nothing else changed.
  undrawn: false,
  // The data of the last quiet load as text, to tell a refresh that changed nothing; null after any other load, since the screen may differ from it then.
  text: null as string | null,
  // The projects by ID, rebuilt on each load.
  projectById: new Map<string, ProjectItem>(),
  // The tasks by ID, rebuilt on each load.
  taskById: new Map<string, TaskItem>(),
  // Set when the count fetch finds no usable token: it stops reading the keychain until a load on the Todo screen succeeds.
  countOff: false,
  // True until a load has fetched from Todoist since the start or a disconnect; an answer from the cache (`offline`) leaves it as it is.
  // Every load asks for the completed tasks (`withDone`) while it is set, so the detail, the counts and the cache the backend saves keep the done subtasks once Todoist answers.
  doneStale: true,
  // The description being edited ({ id, value }), or null. It outlives a redraw, so a refresh keeps the mode and the text; the textarea's own caret is restored by renderDetail.
  descEdit: null as { id: string; value: string } | null,
  // The projects whose children the side list hides (all are shown at first). Kept in memory only.
  closedProjects: new Set<string>(),
  // The tasks whose subtasks the list shows (all are hidden at first). Kept in memory only, so a redraw after a load keeps them.
  openTasks: new Set<string>(),
};

// The Todoist apps' colors for priorities 1 to 4.
export const PRIORITY_COLORS: Record<number, string> = { 1: "#d1453b", 2: "#eb8909", 3: "#246fe0", 4: "#b4b9c2" };
export const TODO_GROUPS = [["overdue", "期限切れ"], ["today", "今日"], ["upcoming", "明日以降"], ["none", "期限なし"]] as const;

// What a task change sends to Todoist: `dueString` is a text Todoist reads ("明日 15時"), or `YYYY-MM-DD` from the calendar.
export interface TaskFields {
  content?: string;
  description?: string;
  dueString?: string;
}

// Open tasks that "今日" lists: overdue or due today.
export const isDueToday = (t: TaskItem) => t.bucket === "overdue" || t.bucket === "today";
export const setTodoCount = (count: number) => setNavCount("nav-todo", count, "Todo", "今日");

export const inboxOf = () => todoState.todo!.projects.find((p) => p.inbox);
export const projectOf = (id: string) => todoState.projectById.get(id);
export const projectName = (p: ProjectItem | undefined) => (p?.inbox ? "受信箱" : p?.name ?? "");
export const viewProjectId = (view: string) => (view === "inbox" ? inboxOf()?.id : view);

// The rows of `t`'s subtasks that are not done (a done one has no row), in Todoist's order.
export const subRows = (t: TaskItem) => t.subtasks.flatMap((s) => (s.done ? [] : todoState.taskById.get(s.id) ?? []));

export function viewTasks(view: string) {
  const { tasks } = todoState.todo!;
  if (view === "today") return tasks.filter((t) => t.bucket === "overdue" || t.bucket === "today");
  const id = viewProjectId(view);
  return tasks.filter((t) => t.projectId === id && !t.parent);
}

// "今日" for today (or its time), else "10/27", with the time if there is one.
export function dueLabel(due: { date: string; time: string | null }) {
  const today = due.date === isoDate(new Date());
  const [, m, d] = due.date.split("-").map(Number);
  if (today) return due.time ?? "今日";
  return due.time ? `${m}/${d} ${due.time}` : `${m}/${d}`;
}

// The thread a task links to, only when it is of an account cookapps has: a description can name any address.
export const linkedMail = (t: TaskItem, accounts: Set<string | undefined>) => (t.mail && accounts.has(t.mail.account) ? t.mail : null);
export const accountSet = () => new Set(accountButtons().map((b) => b.dataset.account));

// Whether a text field holds what the user is typing (a field of the open task, or a name being edited in the list); a redraw would replace it with Todoist's older value.
// The subtask field counts only while it has text: it is emptied on Enter, and the redraw must show the subtask just added.
export function editingField() {
  if (todoState.dragging) return true;
  const a = document.activeElement as HTMLElement;
  if ($("todo-list").contains(a)) return a.matches(".row-edit");
  return $("todo-detail").contains(a) && a.matches("textarea, input:not([type=checkbox])") && (a.dataset.field !== "sub" || (a as HTMLInputElement).value !== "");
}

// What the screen shows for a due text the calendar picked (`YYYY-MM-DD`, with ` HH:MM` for a task with a time), or an empty one (no due date).
// Other text is Todoist's to read, so the task stays as it is until the reload.
export const PICKED_DUE = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/;

// shortcut: the list is not re-sorted after a due date change; the next reload fixes it.
export function patchTask(id: string, { dueString, ...fields }: TaskFields) {
  const t = todoState.taskById.get(id);
  if (!t) return;
  Object.assign(t, fields);
  if (dueString === undefined) return;
  const text = dueString.trim();
  const m = PICKED_DUE.exec(text);
  if (m) {
    const today = isoDate(new Date());
    t.due = { date: m[1], time: m[2] ?? null, string: text, recurring: false };
    t.bucket = m[1] < today ? "overdue" : m[1] === today ? "today" : "upcoming";
  } else if (text === "") {
    t.due = null;
    t.bucket = "none";
  }
}

// Whether `t` is below the task `id`, through any number of parents.
function isUnder(t: TaskItem, id: string) {
  for (let p: ParentRef | null | undefined = t.parent; p; p = todoState.taskById.get(p.id)?.parent) if (p.id === id) return true;
  return false;
}

// Whether the task `t` may be dropped on the row of the task `id`: not on itself, not on a task below it, and not on the parent it already has.
export function canMoveUnder(t: TaskItem, id: string) {
  const target = todoState.taskById.get(id);
  return !!target && id !== t.id && id !== t.parent?.id && !isUnder(target, t.id);
}

// Takes `t` out of the subtask list of its parent, which counts one less, and makes `t` a top-level task.
function leaveParent(t: TaskItem) {
  const old = t.parent && todoState.taskById.get(t.parent.id);
  t.parent = null;
  if (!old) return;
  old.subtasks = old.subtasks.filter((s) => s.id !== t.id);
  recount(old);
}

const recount = (p: TaskItem) => {
  p.subDone = p.subtasks.filter((s) => s.done).length;
  p.subTotal = p.subtasks.length;
};

// Moves a task and the rows of its subtasks, which Todoist moves with it, into a project.
// The task becomes a top-level task there, a subtask too: moving it into its own project makes it stand alone.
export function moveLocal(id: string, projectId: string) {
  const t = todoState.taskById.get(id);
  if (t) leaveParent(t);
  for (const x of todoState.todo!.tasks) if (x.id === id || isUnder(x, id)) x.projectId = projectId;
}

// Moves a task and the rows of its subtasks under the task `parentId`, as its last subtask, in that task's project. The parent is opened so the moved row shows.
export function moveUnderLocal(id: string, parentId: string) {
  const t = todoState.taskById.get(id);
  const parent = todoState.taskById.get(parentId);
  if (!t || !parent) return;
  leaveParent(t);
  t.parent = { id: parent.id, content: parent.content };
  parent.subtasks.push({ id: t.id, content: t.content, done: false, due: t.due });
  // Active subtasks first, then the completed ones.
  parent.subtasks.sort((a, b) => Number(a.done) - Number(b.done));
  recount(parent);
  for (const x of todoState.todo!.tasks) if (x.id === id || isUnder(x, id)) x.projectId = parent.projectId;
  todoState.openTasks.add(parentId);
}

// Completes (`done` true), reopens (false) or deletes (null) a task. In the subtask list of the task holding it, it turns done, open or goes, and the counts follow.
// A completed or deleted one leaves the list with the rows of its subtasks. A reopened one has no row until the reload, which has the data for it.
export function settleLocal(id: string, done: boolean | null) {
  const todo = todoState.todo!;
  for (const p of todo.tasks) {
    const s = p.subtasks.find((s) => s.id === id);
    if (!s) continue;
    if (done === null) p.subtasks = p.subtasks.filter((x) => x !== s);
    else s.done = done;
    // Active subtasks first, then the completed ones.
    p.subtasks.sort((a, b) => Number(a.done) - Number(b.done));
    p.subDone = p.subtasks.filter((x) => x.done).length;
    p.subTotal = p.subtasks.length;
  }
  // shortcut: a reopened subtask keeps its place among the done ones, and has no row; the next reload fixes it.
  if (done !== false) todo.tasks = todo.tasks.filter((t) => t.id !== id && !isUnder(t, id));
}
