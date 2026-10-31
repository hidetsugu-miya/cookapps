// The Todo screen's side list of projects and the task list: rows, the grip that moves a task to a project, and the name edited in place.
import type { MailRef } from "./bindings/MailRef";
import type { TaskItem } from "./bindings/TaskItem";
import { $, composing, tag } from "./dom.js";
import { DATE_SVG, DAY_SVG, EDIT_SVG, FOLDER_SVG, GRIP_SVG, INBOX_SVG, MAIL_SVG, OPEN_SVG, SUB_SVG } from "./icons.js";
import { rowButton, rows } from "./inbox-rows.js";
import { invoke } from "./ipc.js";
import { setScreen } from "./nav.js";
import { openThread } from "./thread.js";
import { updateAddMode } from "./todo-add.js";
import { openDuePop, openProjectMenu } from "./todo-detail.js";
import { accountSet, dueLabel, inboxOf, isDueToday, linkedMail, PRIORITY_COLORS, projectName, projectOf, setTodoCount, TODO_GROUPS, todoState, viewProjectId, viewTasks } from "./todo-data.js";
import { moveTask, saveTask, setTaskDone } from "./todo-write.js";
import { renderTodo, todoMode } from "./todo.js";
import { showError } from "./view.js";

function projectButton(view: string, icon: string, name: string, count: number) {
  const b = tag("button", "proj");
  b.setAttribute("aria-current", String(view === todoState.view));
  b.dataset.view = view;
  if (typeof icon === "string" && icon.startsWith("<")) b.innerHTML = icon;
  else {
    const dot = tag("span", "pdot");
    dot.style.background = icon;
    b.append(dot);
  }
  b.append(tag("span", "name", name), tag("span", "count", String(count)));
  b.onclick = () => {
    todoState.view = view;
    todoState.open = null;
    renderTodo();
  };
  return b;
}

export function renderProjects() {
  const todo = todoState.todo!;
  const inbox = inboxOf();
  // One pass over the tasks counts what each list shows (the same tasks as viewTasks).
  const counts = new Map<string, number>();
  let today = 0;
  for (const t of todo.tasks) {
    if (isDueToday(t)) today++;
    if (!t.parent) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
  }
  setTodoCount(today);
  $("projects").replaceChildren(
    projectButton("today", DAY_SVG, "今日", today),
    projectButton("inbox", INBOX_SVG, "受信箱", counts.get(inbox?.id as string) ?? 0),
    tag("h3", "", "プロジェクト"),
    ...todo.projects.filter((p) => p !== inbox).map((p) => projectButton(p.id, p.color, p.name, counts.get(p.id) ?? 0)),
  );
}

export function checkBox(color: string, checked: boolean, label: string) {
  const box = tag("input", "check");
  box.type = "checkbox";
  box.checked = checked;
  box.setAttribute("aria-label", label);
  box.style.setProperty("--p", color);
  return box;
}

function taskRow(t: TaskItem, showProject: boolean, accounts: Set<string | undefined>) {
  const mail = linkedMail(t, accounts);
  const li = tag("li", `task${showProject ? "" : " single"}`);
  li.onclick = () => {
    // A drag that starts in the name field and ends elsewhere on the row clicks the row; the edit keeps it.
    if (li.querySelector(".row-edit")) return;
    // A subtask row opens the task that holds it.
    todoState.open = t.parent?.id ?? t.id;
    renderTodo();
  };
  const box = checkBox(PRIORITY_COLORS[t.priority], false, "完了にする");
  // The row opens the task on click; the checkbox must not.
  box.onclick = (e) => e.stopPropagation();
  box.onchange = () => {
    li.classList.add("done");
    setTaskDone(t.id, true, box);
  };
  const line = tag("div", "t");
  if (mail) line.insertAdjacentHTML("beforeend", MAIL_SVG);
  const name = tag("span", "", t.content);
  line.append(name);
  if (t.parent) line.append(tag("span", "parent", t.parent.content));
  if (t.subTotal) {
    const count = tag("span", "subcount");
    count.innerHTML = SUB_SVG;
    count.append(`${t.subDone}/${t.subTotal}`);
    line.append(count);
  }
  const body = tag("div", "body");
  body.append(line);
  li.append(box, body, gripOf(li, t));
  if (showProject) {
    const p = projectOf(t.projectId);
    const tagEl = tag("div", "ptag");
    const dot = tag("span", "pdot");
    dot.style.background = p?.color as string;
    tagEl.append(dot, projectName(p));
    li.append(tagEl);
  }
  const trail = tag("div", "trail");
  const actions = tag("div", "row-actions");
  actions.append(
    rowButton("edit-row", "名前を変更", EDIT_SVG, () => editRowName(name, t)),
    rowButton("due-row", "期限を変更", DATE_SVG, (button) => openDuePop(button, t)),
    rowButton("project-row", "プロジェクトを移動", FOLDER_SVG, (button) => openProjectMenu(button, t)),
  );
  if (mail) actions.append(rowButton("mail-row", "メールを開く", MAIL_SVG, () => openMailFromTodo(mail)));
  actions.append(rowButton("open-row", "Todoist で開く", OPEN_SVG, () => invoke("todoist_open", { id: t.id }).catch(showError)));
  trail.append(tag("span", `due${t.bucket === "overdue" ? " over" : ""}`, t.due ? dueLabel(t.due) : ""), actions);
  li.append(trail);
  return li;
}

// The grip at a row's left edge: drag it onto a project in the side list to move the task there.
// Pointer events, not HTML5 drag and drop, which clashes with the window's file drop.
function gripOf(li: HTMLElement, t: TaskItem) {
  const grip = tag("span", "grip");
  grip.setAttribute("role", "img");
  grip.setAttribute("aria-label", "ドラッグしてプロジェクトへ移動");
  grip.innerHTML = GRIP_SVG;
  // The row opens the task on click; the grip must not, nor the click that ends a drag.
  grip.onclick = (e) => e.stopPropagation();
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pointer = e.pointerId;
    // Keeps the events coming outside the window; if a redraw takes the grip out, they still reach the document.
    grip.setPointerCapture(pointer);
    const [x0, y0] = [e.clientX, e.clientY];
    let ghost: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    // On the document, not the grip: a redraw during the drag takes the grip out, and its events would stop.
    const mine = (f: (e: PointerEvent) => void) => (e: PointerEvent) => e.pointerId === pointer && f(e);
    const move = mine((e) => {
      if (!ghost) {
        // A press that hardly moves is not a drag.
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
        todoState.dragging = true;
        ghost = tag("div", "drag-ghost", t.content);
        document.body.append(ghost);
        li.classList.add("dragging");
        document.body.classList.add("dragging-task");
      }
      // Read before the ghost moves, so the move does not force a style recalculation each time.
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("#projects .proj");
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      // Not the "today" list, nor the project the task is in.
      const next = b && b.dataset.view !== "today" && viewProjectId(b.dataset.view!) !== t.projectId ? b : null;
      if (next === over) return;
      over?.classList.remove("drop");
      next?.classList.add("drop");
      over = next;
    });
    const up = mine(() => end(true));
    const cancel = mine(() => end(false));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && end(false);
    const end = (drop: boolean) => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", onKey);
      if (!ghost) return;
      const projectId = drop && over ? viewProjectId((over as HTMLElement).dataset.view!) : null;
      (ghost as HTMLElement).remove();
      ghost = null;
      (over as HTMLElement | null)?.classList.remove("drop");
      li.classList.remove("dragging");
      document.body.classList.remove("dragging-task");
      todoState.dragging = false;
      // The click that ends a drag may go to what is under the pointer (a project button); it must not act.
      const swallow = (e: Event) => e.stopPropagation();
      document.addEventListener("click", swallow, true);
      setTimeout(() => document.removeEventListener("click", swallow, true));
      if (projectId) moveTask(t.id, projectId);
      // Only a redraw held back during the drag; the next refresh fetches.
      else if (todoState.undrawn) renderTodo();
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", onKey);
  };
  return grip;
}

// Turns a row's name into a text field: Enter or leaving the field saves, Escape puts the name back.
function editRowName(name: HTMLElement, t: TaskItem) {
  const input = tag("input", "row-edit");
  input.value = t.content;
  input.setAttribute("aria-label", "タスクの名前");
  let finished = false;
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    if (save && input.value.trim() && input.value !== t.content) {
      name.textContent = input.value;
      saveTask(t.id, { content: input.value });
    }
    input.replaceWith(name);
  };
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  // The row opens the task on click; the field must not.
  input.onclick = (e) => e.stopPropagation();
  name.replaceWith(input);
  input.focus();
  input.select();
}

export function renderList() {
  todoState.descEdit = null;
  todoMode("list");
  const view = todoState.view;
  const showProject = view === "today";
  const tasks = viewTasks(view);
  $("todo-title").textContent = view === "today" ? "今日" : view === "inbox" ? "受信箱" : projectOf(view)!.name;
  updateAddMode();
  const accounts = accountSet();
  const parts: HTMLElement[] = [];
  for (const [bucket, label] of TODO_GROUPS) {
    const items = tasks.filter((t) => t.bucket === bucket);
    if (items.length === 0) continue;
    const list = tag("ul");
    list.append(...items.map((t) => taskRow(t, showProject, accounts)));
    parts.push(tag("div", `group${bucket === "overdue" ? " overdue" : ""}`, label), list);
  }
  $("todo-list").replaceChildren(...(parts.length ? parts : [tag("p", "todo-empty", "タスクはありません")]));
}

// Opens the thread of a task's mail link in the mail screen.
export async function openMailFromTodo({ account, threadId }: MailRef) {
  setScreen("mail");
  await openThread({ id: threadId, account }, rows.get(`${account}/${threadId}`)?.li ?? null, "todo");
}
