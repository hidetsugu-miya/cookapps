// One task opened on the Todo screen: its name, description, linked mail and subtasks, and beside them its project and due date.
import type { Due } from "./bindings/Due";
import type { TaskItem } from "./bindings/TaskItem";
import { $, composing, onEnter, tag } from "./dom.js";
import { addDays, isoDate, WEEKDAYS } from "./format.js";
import { DATE_SVG, MAIL_SVG, PLUS_SVG } from "./icons.js";
import { closeMenu, openMenu, showMenu } from "./menu.js";
import { accountSet, dueLabel, linkedMail, PRIORITY_COLORS, projectName, projectOf, todoState } from "./todo-data.js";
import { checkBox, openMailFromTodo, renderList } from "./todo-list.js";
import { moveTask, saveTask, setTaskDone, todoCall } from "./todo-write.js";
import { renderTodo, todoMode } from "./todo.js";

// A month of days to pick from, Sunday first; `shown` is the 1st of the month, `due` and today are marked.
function monthPicker(shown: Date, due: Due | null, pick: (iso: string) => void) {
  const box = tag("div", "dp");
  // The pressed arrow is replaced with the month, so the focus moves to the new one.
  const move = (n: number) => {
    const moved = monthPicker(new Date(shown.getFullYear(), shown.getMonth() + n, 1), due, pick);
    box.replaceWith(moved);
    moved.querySelectorAll<HTMLElement>(".dp-nav")[n < 0 ? 0 : 1].focus();
  };
  const head = tag("div", "dp-head");
  const prev = tag("button", "dp-nav", "‹");
  const next = tag("button", "dp-nav", "›");
  prev.setAttribute("aria-label", "前の月");
  next.setAttribute("aria-label", "次の月");
  prev.onclick = () => move(-1);
  next.onclick = () => move(1);
  head.append(prev, `${shown.getFullYear()}年${shown.getMonth() + 1}月`, next);
  const grid = tag("div", "dp-grid");
  for (const w of WEEKDAYS) grid.append(tag("span", "dp-wd", w));
  const today = isoDate(new Date());
  const first = isoDate(shown);
  for (let i = -shown.getDay(); i < 42 - shown.getDay(); i++) {
    const day = addDays(first, i);
    const iso = isoDate(day);
    const b = tag("button", "dp-day", String(day.getDate()));
    if (day.getMonth() !== shown.getMonth()) b.classList.add("other");
    if (iso === today) b.classList.add("today");
    if (iso === due?.date) b.classList.add("current");
    b.onclick = () => pick(iso);
    grid.append(b);
  }
  box.append(head, grid);
  return box;
}

// The due popover opens a text field taking Todoist's natural language ("明日 15時", "毎週月曜"; empty clears the due date) over a month to pick a day from.
// A repeating task gets the text field only: a picked day would replace its repeat.
export function openDuePop(anchor: Element, t: TaskItem) {
  const pop = tag("div", "menu due-pop");
  const input = tag("input", "chip-input");
  input.value = t.due?.string ?? "";
  input.placeholder = "例: 明日 15時";
  input.setAttribute("aria-label", "期限（空欄で期限なし）");
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key !== "Enter") return;
    closeMenu();
    if (input.value.trim() !== (t.due?.string ?? "")) saveTask(t.id, { dueString: input.value });
  };
  const month = t.due ? addDays(t.due.date, 0) : new Date();
  pop.append(input);
  if (!t.due?.recurring)
    pop.append(
      monthPicker(new Date(month.getFullYear(), month.getMonth(), 1), t.due, (iso) => {
        closeMenu();
        if (iso === t.due?.date) return;
        saveTask(t.id, { dueString: t.due?.time ? `${iso} ${t.due.time}` : iso });
      }),
    );
  showMenu(anchor, pop);
  input.focus();
  input.select();
}

export function openProjectMenu(anchor: Element, t: TaskItem) {
  openMenu(
    anchor,
    todoState.todo!.projects.map((p) => ({
      label: projectName(p),
      color: p.color,
      current: p.id === t.projectId,
      depth: p.depth,
      pick: () => p.id !== t.projectId && moveTask(t.id, p.id),
    })),
  );
}

// A field of the side pane: its label over the value, a button that opens the menu or popover that changes it.
function field(label: string, value: HTMLButtonElement) {
  const f = tag("div", "field");
  f.append(tag("div", "field-label", label), value);
  return f;
}

function projectField(t: TaskItem) {
  const p = projectOf(t.projectId);
  const b = tag("button", "field-value");
  const dot = tag("span", "pdot");
  dot.style.background = p?.color as string;
  b.append(dot, projectName(p));
  b.onclick = () => openProjectMenu(b, t);
  return field("プロジェクト", b);
}

function dueField(t: TaskItem) {
  const b = tag("button", `field-value${t.bucket === "overdue" ? " over" : ""}`);
  b.insertAdjacentHTML("beforeend", DATE_SVG);
  b.append(t.due ? dueLabel(t.due) : "期限なし");
  b.onclick = () => openDuePop(b, t);
  return field("日付", b);
}

function subtaskRow(s: TaskItem["subtasks"][number]) {
  const li = tag("li", `task single${s.done ? " done" : ""}`);
  const box = checkBox(PRIORITY_COLORS[4], s.done, s.done ? "未完了に戻す" : "完了にする");
  box.onchange = () => {
    li.classList.toggle("done", box.checked);
    setTaskDone(s.id, box.checked, box);
  };
  // A subtask has a row among the tasks, so it opens like one; a done one has none.
  if (todoState.taskById.has(s.id)) {
    li.onclick = () => {
      todoState.open = s.id;
      renderTodo();
    };
    box.onclick = (e) => e.stopPropagation();
  }
  const body = tag("div", "body");
  body.append(tag("div", "t", s.content));
  const trail = tag("div", "trail");
  trail.append(tag("span", "due", s.due ? dueLabel(s.due) : ""));
  li.append(box, body, trail);
  return li;
}

// Only http(s) links stay: a relative link would resolve to the app's own origin, which Rust's on_navigation allows, and replace the screen.
// An http(s) link navigates this page and on_navigation opens it in the default browser, as a plain-text mail body's links do.
// No form controls or styles: they could draw a fake field over the screen. No id or name: they could shadow the screen's own elements for $().
const DESC_SANITIZE = {
  ALLOWED_URI_REGEXP: /^https?:/i,
  FORBID_TAGS: ["form", "input", "button", "textarea", "select", "style"],
  FORBID_ATTR: ["style", "id", "name"],
};

function growDesc(area: HTMLTextAreaElement) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

// The description of `t`: its Markdown shown in full, or, while it is edited, the textarea and its buttons.
function descParts(t: TaskItem): HTMLElement[] {
  if (todoState.descEdit?.id !== t.id) {
    // Another task was opened: what was typed for the old one is dropped.
    todoState.descEdit = null;
    const view = tag("div", t.description ? "desc" : "desc empty");
    // breaks: a single newline is a line break, as Todoist descriptions are written line by line.
    if (t.description) view.innerHTML = DOMPurify.sanitize(marked.parse(t.description, { breaks: true }), DESC_SANITIZE);
    else view.textContent = "説明を追加";
    view.dataset.field = "desc";
    view.tabIndex = 0;
    view.setAttribute("role", "button");
    // Not aria-label: it would replace the description itself for a screen reader.
    view.setAttribute("aria-description", "押すと編集");
    const edit = () => {
      todoState.descEdit = { id: t.id, value: t.description };
      renderDetail();
      const area = $("todo-detail").querySelector("textarea")!;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    };
    // A click on a link opens it, not the editor.
    view.onclick = (e) => (e.target as Element).closest("a") || edit();
    view.onkeydown = (e) => {
      if (e.key !== "Enter" || e.target !== view) return;
      // Without this the Enter reaches the textarea that edit() focuses, and adds a newline.
      e.preventDefault();
      edit();
    };
    return [view];
  }
  const area = tag("textarea", "desc-edit");
  area.value = todoState.descEdit.value;
  area.placeholder = "説明を追加";
  area.dataset.field = "desc";
  area.setAttribute("aria-label", "説明");
  area.oninput = () => {
    todoState.descEdit!.value = area.value;
    growDesc(area);
  };
  const close = () => {
    todoState.descEdit = null;
    renderDetail();
  };
  const cancel = tag("button", "text-btn", "キャンセル");
  cancel.onclick = close;
  const save = tag("button", "text-btn", "保存");
  save.onclick = () => {
    const value = area.value;
    todoState.descEdit = null;
    if (value === t.description) return renderDetail();
    // A failed save reopens the editor with what was typed, so a long description is not lost to the reload.
    saveTask(t.id, { description: value }).then((answer) => {
      if (answer !== null || todoState.open !== t.id || todoState.descEdit) return;
      todoState.descEdit = { id: t.id, value };
      renderDetail();
    });
  };
  const actions = tag("div", "desc-actions");
  actions.append(cancel, save);
  return [area, actions];
}

export function renderDetail() {
  const t = todoState.taskById.get(todoState.open!);
  if (!t) {
    todoState.open = null;
    return renderList();
  }
  // A reload redraws the whole detail; the field being typed in keeps the focus and the caret.
  const active = document.activeElement as HTMLInputElement;
  const field = $("todo-detail").contains(active) ? active.dataset.field : null;
  const caret = active.selectionStart;
  // What was typed into the subtask field of this task is not lost to the redraw.
  const typed = $("todo-detail").dataset.task === t.id ? $("todo-detail").querySelector<HTMLInputElement>('[data-field="sub"]')?.value ?? "" : "";
  todoMode("detail");
  $("todo-title").textContent = projectName(projectOf(t.projectId));

  const box = checkBox(PRIORITY_COLORS[t.priority], false, "完了にする");
  box.onchange = () => setTaskDone(t.id, true, box);
  const name = tag("input", "name");
  name.value = t.content;
  name.dataset.field = "name";
  name.setAttribute("aria-label", "タスクの名前");
  name.onchange = () => {
    if (name.value.trim()) saveTask(t.id, { content: name.value });
    else name.value = t.content;
  };
  onEnter(name, () => name.blur());
  const head = tag("div", "head");
  head.append(box, name);

  const parts: HTMLElement[] = [head, ...descParts(t)];
  const mail = linkedMail(t, accountSet());
  if (mail) {
    const card = tag("div", "mail-link");
    card.insertAdjacentHTML("beforeend", MAIL_SVG);
    const text = tag("span");
    text.append(tag("b", "", t.content), ` — ${mail.account}`);
    card.append(text, tag("span", "go", "メールを開く"));
    card.onclick = () => openMailFromTodo(mail);
    parts.push(card);
  }

  const title = tag("div", "section-title", t.subTotal ? `サブタスク ${t.subDone}/${t.subTotal}` : "サブタスク");
  if (t.subTotal) {
    const bar = tag("span", "bar");
    const fill = tag("i");
    fill.style.width = `${(t.subDone / t.subTotal) * 100}%`;
    bar.append(fill);
    title.append(bar);
  }
  const subs = tag("ul", "subs");
  subs.append(...t.subtasks.map(subtaskRow));
  const add = tag("div", "add-sub");
  add.insertAdjacentHTML("beforeend", PLUS_SVG);
  const input = tag("input");
  input.placeholder = "サブタスクを追加";
  input.dataset.field = "sub";
  input.value = typed;
  input.setAttribute("aria-label", "サブタスクを追加");
  onEnter(input, () => {
    const content = input.value;
    if (!content.trim()) return;
    // Emptied before the call, or the redraw after it would restore the text.
    input.value = "";
    // No control is passed: disabling the field would drop its focus, and the next subtask could not be typed at once.
    todoCall("todoist_add_subtask", { parentId: t.id, content });
  });
  add.append(input);
  parts.push(title, subs, add);

  const main = tag("div", "detail-main");
  main.append(...parts);
  const side = tag("aside", "detail-side");
  side.append(projectField(t), dueField(t));
  $("todo-detail").replaceChildren(main, side);
  $("todo-detail").dataset.task = t.id;
  const area = $("todo-detail").querySelector("textarea");
  if (area) growDesc(area);
  if (field) {
    const again = $("todo-detail").querySelector<HTMLInputElement>(`[data-field="${field}"]`);
    again?.focus();
    if (caret != null) again?.setSelectionRange?.(caret, caret);
  }
}
