// The Todo screen's side list of projects and the task list: rows, the grip that moves a task to a project or under another task, the drag of a project, and the name edited in place.
import type { MailRef } from "./bindings/MailRef";
import type { ProjectItem } from "./bindings/ProjectItem";
import type { TaskItem } from "./bindings/TaskItem";
import { $, composing, tag } from "./dom.js";
import { confirmDelete } from "./hint.js";
import { CHEVRON_SVG, DATE_SVG, DAY_SVG, DELETE_SVG, EDIT_SVG, FOLDER_SVG, GRIP_SVG, INBOX_SVG, MAIL_SVG, OPEN_SVG, OUTDENT_SVG, SUB_SVG, svgOf, TAG_SVG } from "./icons.js";
import { rowButton, rows } from "./inbox-rows.js";
import { invoke } from "./ipc.js";
import { type MenuItem, openMenu } from "./menu.js";
import { setScreen } from "./nav.js";
import { openThread } from "./thread.js";
import { updateAddMode } from "./todo-add.js";
import { openDuePop, openProjectMenu } from "./todo-detail.js";
import { accountSet, canMoveUnder, dueLabel, editingField, inboxOf, isDueToday, linkedMail, moveTargets, PRIORITY_COLORS, projectName, projectOf, setTodoCount, subRows, TODO_GROUPS, todoState, viewProjectId, viewTasks } from "./todo-data.js";
import { archiveProject, deleteProject, moveProject, moveTask, moveUnder, saveTask, setTaskDone } from "./todo-write.js";
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

const ARCHIVE_SVG = svgOf('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>');

// The places the project `p` may be moved to (T-8): the top level, then the projects `moveTargets` leaves. The pick makes it the last sub-project there.
function movePlaces(p: ProjectItem) {
  const places: MenuItem[] = moveTargets(p).map((x) => ({ label: x.name, color: x.color, current: false, depth: x.depth, pick: () => void moveProject(p.id, x.id) }));
  if (p.parentId !== null) places.unshift({ label: "一番上の階層", color: "", icon: FOLDER_SVG, current: false, pick: () => void moveProject(p.id, null) });
  return places;
}

// The menu of a right press on the row of the project `p` (T-8): the items of what can be done to a project are listed here. 削除 asks first, as it cannot be undone.
function openProjectActions(row: HTMLElement, p: ProjectItem, e: MouseEvent) {
  e.preventDefault();
  const at = { x: e.clientX, y: e.clientY };
  const places = movePlaces(p);
  openMenu(
    row,
    [
      { label: "移動", color: "", icon: FOLDER_SVG, current: false, disabled: places.length === 0, pick: () => openMenu(row, places, { at }) },
      { label: "アーカイブ", color: "", icon: ARCHIVE_SVG, current: false, pick: () => void archiveProject(p.id) },
      { label: "削除", color: "", icon: DELETE_SVG, current: false, danger: true, pick: () => confirmDelete(document.querySelector<HTMLElement>(`#projects .proj[data-view="${CSS.escape(p.id)}"]`) ?? row, p.name, () => void deleteProject(p.id)) },
    ],
    { at },
  );
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
  setTodoCount(todo.tasks);
  const parents = new Set(todo.projects.map((p) => p.parentId));
  // The projects under a closed one, however deep.
  const hidden = new Set<string>();
  // The ids of the projects a project is nested under, for the toggle's animation.
  const under = new Map<string, string>();
  const lines: HTMLElement[] = [];
  for (const p of todo.projects) {
    if (p.parentId && (hidden.has(p.parentId) || todoState.closedProjects.has(p.parentId))) {
      hidden.add(p.id);
      continue;
    }
    under.set(p.id, p.parentId ? `${under.get(p.parentId) ?? ""} ${p.parentId}`.trim() : "");
    if (p === inbox) continue;
    const line = tag("div", "proj-line");
    line.dataset.under = under.get(p.id);
    line.style.paddingLeft = `${p.depth * 16}px`;
    const button = projectButton(p.id, p.color, p.name, counts.get(p.id) ?? 0);
    button.oncontextmenu = (e) => openProjectActions(button, p, e);
    projectDrag(button, line, p);
    line.append(button);
    if (parents.has(p.id)) {
      line.classList.add("parent");
      const closed = todoState.closedProjects.has(p.id);
      line.append(
        toggleButton(p.id, closed ? "サブプロジェクトを開く" : "サブプロジェクトを閉じる", !closed, () =>
          toggleNested(
            $("projects"),
            p.id,
            closed,
            () => (closed ? todoState.closedProjects.delete(p.id) : todoState.closedProjects.add(p.id)),
            renderProjects,
          ),
        ),
      );
    }
    lines.push(line);
  }
  // The button that closes the list (A-23) is the list's first child and stays.
  $("projects").replaceChildren(
    ...$("projects").querySelectorAll(":scope > .list-toggle"),
    projectButton("inbox", INBOX_SVG, "インボックス", counts.get(inbox?.id as string) ?? 0),
    projectButton("today", DAY_SVG, "今日", today),
    tag("h3", "", "プロジェクト"),
    ...lines,
  );
}

// The chevron that opens or closes what is nested under a project or a task. It must not reach the row or button it sits on.
function toggleButton(id: string, label: string, expanded: boolean, toggle: () => void) {
  const b = tag("button", "icon-btn toggle");
  b.dataset.id = id;
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-expanded", String(expanded));
  b.innerHTML = CHEVRON_SVG;
  b.onclick = (e) => {
    e.stopPropagation();
    toggle();
  };
  return b;
}

const SLIDE = { duration: 180, easing: "ease" };
// Clips the row to its shrinking height but not on the left, where a row's own toggle sits outside it (overflow: hidden would cut the toggle).
const CLIP = "inset(0 0 0 -30px)";
const SHRUNK = { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0, clipPath: CLIP };
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// The toggles whose rows are sliding shut; a click on one meanwhile does nothing.
const closing = new Set<string>();

// The row's own size, which the slide grows to or shrinks from.
function fullSize(el: Element) {
  const s = getComputedStyle(el);
  return { height: s.height, opacity: s.opacity, paddingTop: s.paddingTop, paddingBottom: s.paddingBottom, marginTop: s.marginTop, marginBottom: s.marginBottom, clipPath: CLIP };
}

// Slides the rows nested under `id` in and the chevron round, or out and back.
function slide(box: HTMLElement, id: string, opening: boolean) {
  const key = CSS.escape(id);
  const rows = [...box.querySelectorAll(`[data-under~="${key}"]`)];
  for (const el of rows) for (const a of el.getAnimations()) a.cancel();
  const sizes = rows.map(fullSize);
  const turn = [{ transform: "rotate(0deg)" }, { transform: "rotate(90deg)" }];
  const fill = opening ? "none" : "forwards";
  for (const [i, el] of rows.entries()) el.animate(opening ? [SHRUNK, sizes[i]] : [sizes[i], SHRUNK], { ...SLIDE, fill });
  box.querySelector(`.toggle[data-id="${key}"] svg`)!.animate(opening ? turn : turn.reverse(), { ...SLIDE, fill });
}

// Opens or closes what is nested under `id`: `change` sets the state and `redraw` draws an open.
// An open draws first and slides the new rows in; a close slides the rows shut first, since the redraw takes them away.
// A redraw from elsewhere meanwhile is harmless: the timer still ends the close, and the state is drawn once more.
// The timer draws what the screen shows by then (the detail opened, or the token form with no data), not `redraw`.
// A timer, not the animations' end: they do not run while the window is not painting.
function toggleNested(box: HTMLElement, id: string, opening: boolean, change: () => void, redraw: () => void) {
  const key = `${box.id}/${id}`;
  if (closing.has(key)) return;
  const quiet = still();
  if (opening) {
    change();
    redraw();
    if (!quiet) slide(box, id, true);
    return;
  }
  closing.add(key);
  if (!quiet) slide(box, id, false);
  setTimeout(() => {
    closing.delete(key);
    change();
    // Like a load: a name or a drag begun during the slide is kept, and drawn after it.
    if (editingField()) todoState.undrawn = true;
    else if (todoState.todo) renderTodo();
  }, quiet ? 0 : SLIDE.duration);
}

export function checkBox(color: string, checked: boolean, label: string) {
  const box = tag("input", "check");
  box.type = "checkbox";
  box.checked = checked;
  box.setAttribute("aria-label", label);
  box.style.setProperty("--p", color);
  return box;
}

// The row of `t`, and under it, while `t` is open, the rows of its subtasks, each indented one step more. The "today" list is flat.
function taskRows(t: TaskItem, showProject: boolean, accounts: Set<string | undefined>, under: string[] = []): HTMLElement[] {
  const li = taskRow(t, showProject, accounts);
  li.style.marginLeft = `${under.length * 28}px`;
  li.dataset.under = under.join(" ");
  const subs = showProject ? [] : subRows(t);
  if (subs.length === 0) return [li];
  const open = todoState.openTasks.has(t.id);
  li.append(
    toggleButton(t.id, open ? "サブタスクを閉じる" : "サブタスクを開く", open, () =>
      toggleNested($("todo-list"), t.id, !open, () => (open ? todoState.openTasks.delete(t.id) : todoState.openTasks.add(t.id)), renderList),
    ),
  );
  return open ? [li, ...subs.flatMap((s) => taskRows(s, showProject, accounts, [...under, t.id]))] : [li];
}

// A chip of the third line of a row: the icon and the text.
function metaChip(cls: string, icon: string, text: string) {
  const chip = tag("span", cls);
  chip.innerHTML = icon;
  chip.append(text);
  return chip;
}

// The first line of a description that is not empty, for the second line of a row.
function firstLine(description: string) {
  for (const line of description.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
}

function taskRow(t: TaskItem, showProject: boolean, accounts: Set<string | undefined>) {
  const mail = linkedMail(t, accounts);
  const li = tag("li", "task tall");
  li.dataset.id = t.id;
  li.onclick = () => {
    // A drag that starts in the name field and ends elsewhere on the row clicks the row; the edit keeps it.
    if (li.querySelector(".row-edit")) return;
    todoState.open = t.id;
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
  const name = tag("span", "tname", t.content);
  line.append(name);
  const body = tag("div", "body");
  body.append(line);
  li.append(box, body, gripOf(li, t));
  // The second line: the first line of the description, underlined when it is an address (it is not a link; the row opens the task).
  const first = firstLine(t.description);
  if (first) li.append(tag("div", `desc${/^https?:\/\//.test(first) ? " url" : ""}`, first));
  // The third line: the due moment, labels, subtask count and, where a subtask belongs (in the "today" list; in a project it is nested under its parent), its parent; at the right end the project.
  const chips = tag("span", "chips");
  if (t.due) chips.append(metaChip(`due${t.bucket === "overdue" ? " over" : ""}`, DATE_SVG, dueLabel(t.due)));
  for (const label of t.labels) chips.append(metaChip("label", TAG_SVG, label));
  if (t.subTotal) chips.append(metaChip("subcount", SUB_SVG, `${t.subDone}/${t.subTotal}`));
  if (t.parent && showProject) chips.append(tag("span", "parent", t.parent.content));
  if (chips.childElementCount || showProject) {
    const meta = tag("div", "meta");
    meta.append(chips);
    if (showProject) {
      const p = projectOf(t.projectId);
      const tagEl = tag("div", "ptag");
      const dot = tag("span", "pdot");
      dot.style.background = p?.color as string;
      tagEl.append(dot, tag("span", "pname", projectName(p)));
      meta.append(tagEl);
    }
    li.append(meta);
  }
  const actions = tag("div", "row-actions");
  actions.append(
    rowButton("edit-row", "名前を変更", EDIT_SVG, () => editRowName(name, t)),
    rowButton("due-row", "期限を変更", DATE_SVG, (button) => openDuePop(button, t)),
    rowButton("project-row", "プロジェクトを移動", FOLDER_SVG, (button) => openProjectMenu(button, t)),
  );
  // A subtask stands alone in its own project, at the end of the top-level tasks.
  if (t.parent) actions.append(rowButton("unparent-row", "親タスクから外す", OUTDENT_SVG, () => moveTask(t.id, t.projectId)));
  if (mail) actions.append(rowButton("mail-row", "メールを開く", MAIL_SVG, () => openMailFromTodo(mail)));
  actions.append(rowButton("open-row", "Todoist で開く", OPEN_SVG, () => invoke("todoist_open", { id: t.id }).catch(showError)));
  li.append(actions);
  return li;
}

// What the task `t` may be dropped on at `el`: a project in the side list (not "today"; the project it is in only when it is a subtask, which then stands alone),
// or the row of another task it may become a subtask of: a row of the list, or a subtask row of the open task's detail.
function dropTarget(el: Element | null | undefined, t: TaskItem) {
  const proj = el?.closest<HTMLElement>("#projects .proj");
  if (proj) return proj.dataset.view !== "today" && (viewProjectId(proj.dataset.view!) !== t.projectId || t.parent) ? proj : null;
  const row = el?.closest<HTMLElement>("#todo-list li.task, #todo-detail .subs li.task[data-id]");
  return row && canMoveUnder(t, row.dataset.id!) ? row : null;
}

// A drag that the press `e` on `anchor` may become, by pointer events, not HTML5 drag and drop, which clashes with the window's file drop (T-2, T-8).
// `row` is the row dragged (it gets `dragging`), `find` says what a drop may land on at an element (it gets `drop` while the pointer is over it), and `drop` runs once when the drag ends: with the element the pointer was released over, or null.
// A press that hardly moves is not a drag: `drop` does not run, and the click goes on as it was.
function pressDrag(e: PointerEvent, anchor: HTMLElement, label: string, row: HTMLElement, find: (el: Element | null | undefined) => HTMLElement | null, drop: (target: HTMLElement | null) => void) {
  const pointer = e.pointerId;
  // Keeps the events coming outside the window; if a redraw takes the anchor out, they still reach the document.
  anchor.setPointerCapture(pointer);
  const [x0, y0] = [e.clientX, e.clientY];
  let ghost: HTMLElement | null = null;
  let over: HTMLElement | null = null;
  // On the document, not the anchor: a redraw during the drag takes the anchor out, and its events would stop.
  const mine = (f: (e: PointerEvent) => void) => (e: PointerEvent) => e.pointerId === pointer && f(e);
  const move = mine((e) => {
    if (!ghost) {
      // A press that hardly moves is not a drag.
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
      todoState.dragging = true;
      ghost = tag("div", "drag-ghost", label);
      document.body.append(ghost);
      row.classList.add("dragging");
      document.body.classList.add("dragging-task");
    }
    // Read before the ghost moves, so the move does not force a style recalculation each time.
    const next = find(document.elementFromPoint(e.clientX, e.clientY));
    ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    if (next === over) return;
    over?.classList.remove("drop");
    next?.classList.add("drop");
    over = next;
  });
  const up = mine(() => end(true));
  const cancel = mine(() => end(false));
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && end(false);
  const end = (release: boolean) => {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("keydown", onKey);
    if (!ghost) return;
    const target = release ? (over as HTMLElement | null) : null;
    (ghost as HTMLElement).remove();
    ghost = null;
    (over as HTMLElement | null)?.classList.remove("drop");
    row.classList.remove("dragging");
    document.body.classList.remove("dragging-task");
    todoState.dragging = false;
    // The click that ends a drag may go to what is under the pointer (a project button); it must not act.
    const swallow = (e: Event) => e.stopPropagation();
    document.addEventListener("click", swallow, true);
    setTimeout(() => document.removeEventListener("click", swallow, true));
    drop(target);
  };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancel, true);
  document.addEventListener("keydown", onKey);
}

// The grip at a row's left edge: drag it onto a project in the side list to move the task there, or onto another task's row to make it that task's subtask.
export function gripOf(li: HTMLElement, t: TaskItem) {
  const grip = tag("span", "grip");
  grip.setAttribute("role", "img");
  grip.setAttribute("aria-label", "ドラッグしてプロジェクトまたは親タスクへ移動");
  grip.innerHTML = GRIP_SVG;
  // The row opens the task on click; the grip must not, nor the click that ends a drag.
  grip.onclick = (e) => e.stopPropagation();
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    pressDrag(e, grip, t.content, li, (el) => dropTarget(el, t), (target) => {
      // A project of the side list has a `data-view`, a task's row a `data-id`.
      const projectId = target?.dataset.view && viewProjectId(target.dataset.view);
      const parentId = target?.dataset.id;
      if (projectId) moveTask(t.id, projectId);
      else if (parentId) moveUnder(t.id, parentId);
      // Only a redraw held back during the drag; the next refresh fetches.
      else if (todoState.undrawn) renderTodo();
    });
  };
  return grip;
}

// What the project `p` may be dropped on at `el` (T-8): a project of `places` (the IDs `moveTargets` leaves, as in the "移動" menu), or the heading "プロジェクト" for the top level (not for a project that is there already).
function projectDropTarget(el: Element | null | undefined, p: ProjectItem, places: Set<string>) {
  const proj = el?.closest<HTMLElement>("#projects .proj");
  if (proj) return places.has(proj.dataset.view!) ? proj : null;
  return p.parentId === null ? null : (el?.closest<HTMLElement>("#projects h3") ?? null);
}

// Makes the button of the project `p` the handle of a drag (T-8): drop it on a project to make it that project's last sub-project, or on the heading "プロジェクト" for the last of the top level.
// The whole button is the handle, with no grip: the row has no room for one beside the name, the count and the toggle, and a press that moves less than 4px stays the click that opens the project.
// The press is not cancelled (no preventDefault), so the focus and that click are as before; the right press is not taken, and opens the menu as before.
function projectDrag(button: HTMLElement, line: HTMLElement, p: ProjectItem) {
  button.onpointerdown = (e) => {
    if (e.button !== 0) return;
    // Made when the drag starts (the first `find`), not at each press: a press that is only a click needs none.
    let places: Set<string> | null = null;
    const placesOf = () => {
      places ??= new Set(moveTargets(p).map((x) => x.id));
      return places;
    };
    pressDrag(e, button, p.name, line, (el) => projectDropTarget(el, p, placesOf()), (target) => {
      // A project button's `data-view` is its ID; the heading has none.
      if (target) void moveProject(p.id, target.dataset.view ?? null);
      // Only a redraw held back during the drag; the next refresh fetches.
      else if (todoState.undrawn) renderTodo();
    });
  };
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
  $("todo-title").textContent = view === "today" ? "今日" : view === "inbox" ? "インボックス" : projectOf(view)!.name;
  updateAddMode();
  const accounts = accountSet();
  const parts: HTMLElement[] = [];
  for (const [bucket, label] of TODO_GROUPS) {
    const items = tasks.filter((t) => t.bucket === bucket);
    if (items.length === 0) continue;
    const list = tag("ul");
    list.append(...items.flatMap((t) => taskRows(t, showProject, accounts)));
    parts.push(tag("div", `group${bucket === "overdue" ? " overdue" : ""}`, label), list);
  }
  $("todo-list").replaceChildren(...(parts.length ? parts : [tag("p", "todo-empty", "タスクはありません")]));
}

// Opens the thread of a task's mail link in the mail screen.
export async function openMailFromTodo({ account, threadId }: MailRef) {
  setScreen("mail");
  const row = rows.get(`${account}/${threadId}`);
  await openThread(row?.t ?? { id: threadId, account }, row?.li ?? null, "todo");
}
