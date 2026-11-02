// One task opened on the Todo screen: its name, description, linked mail and subtasks, and beside them its project and due date.
import type { TaskItem } from "./bindings/TaskItem";
import { $, composing, onEnter, tag } from "./dom.js";
import { addDays, isoDate, WEEKDAYS } from "./format.js";
import { CLOSE_SVG, COPY_SVG, DATE_SVG, MAIL_SVG, PLUS_SVG, RETURN_SVG } from "./icons.js";
import { closeMenu, openMenu, showMenu } from "./menu.js";
import { accountSet, dueLabel, linkedMail, PRIORITY_COLORS, projectName, projectOf, todoState } from "./todo-data.js";
import { checkBox, openMailFromTodo, renderList } from "./todo-list.js";
import { moveTask, saveTask, setTaskDone, todoCall } from "./todo-write.js";
import { renderTodo, todoMode } from "./todo.js";
import { copyText } from "./view.js";

// A month of days to pick from, Sunday first; `shown` is the 1st of the month, `current` (a `YYYY-MM-DD` or null) and today are marked.
function monthPicker(shown: Date, current: string | null, pick: (iso: string) => void) {
  const box = tag("div", "dp");
  // The pressed arrow is replaced with the month, so the focus moves to the new one.
  const move = (n: number) => {
    const moved = monthPicker(new Date(shown.getFullYear(), shown.getMonth() + n, 1), current, pick);
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
    if (iso === current) b.classList.add("current");
    b.onclick = () => pick(iso);
    grid.append(b);
  }
  box.append(head, grid);
  return box;
}

// What the due popover edits. `text` is what its field starts with; `date` (`YYYY-MM-DD`) and `time` (`HH:MM`) are the day it marks and the time a picked day keeps,
// null for none; a `recurring` due date gets the text field only, since a picked day would replace its repeat. `commit` gets the new text, only when it differs.
export interface DueEdit {
  text: string;
  date: string | null;
  time: string | null;
  recurring: boolean;
  commit: (dueString: string) => void;
}

// The due popover opens a text field taking Todoist's natural language ("明日 15時", "毎週月曜"; empty clears the due date) over a month to pick a day from.
// A one-off due date is written "2026-11-02 12:00", which Todoist reads back as is; a repeat keeps Todoist's text, which a date cannot hold.
// The task's detail and the Slack summary card both open it; what is done with the new text is theirs.
export function openDueEditor(anchor: Element, e: DueEdit) {
  const pop = tag("div", "menu due-pop");
  const input = tag("input", "chip-input");
  input.value = e.text;
  input.placeholder = "例: 明日 15時";
  input.setAttribute("aria-label", "期限（空欄で期限なし）");
  input.onkeydown = (ev) => {
    if (composing(ev)) return;
    if (ev.key !== "Enter") return;
    closeMenu();
    if (input.value.trim() !== e.text) e.commit(input.value);
  };
  const month = e.date ? addDays(e.date, 0) : new Date();
  pop.append(input);
  if (!e.recurring)
    pop.append(
      monthPicker(new Date(month.getFullYear(), month.getMonth(), 1), e.date, (iso) => {
        closeMenu();
        if (iso === e.date) return;
        e.commit(e.time ? `${iso} ${e.time}` : iso);
      }),
    );
  showMenu(anchor, pop);
  input.focus();
  input.select();
}

export function openDuePop(anchor: Element, t: TaskItem) {
  const due = t.due;
  openDueEditor(anchor, {
    text: !due ? "" : due.recurring ? due.string : due.time ? `${due.date} ${due.time}` : due.date,
    date: due?.date ?? null,
    time: due?.time ?? null,
    recurring: !!due?.recurring,
    commit: (dueString) => saveTask(t.id, { dueString }),
  });
}

// The menu of projects, with `current` marked and, when given, `recommended` tagged; `pick` gets the ID of the one chosen.
export function openProjectPicker(anchor: Element, current: string | undefined, pick: (projectId: string) => unknown, recommended?: string | null) {
  openMenu(
    anchor,
    todoState.todo!.projects.map((p) => ({
      label: projectName(p),
      color: p.color,
      current: p.id === current,
      depth: p.depth,
      tag: p.id === recommended ? "推奨" : undefined,
      pick: () => pick(p.id),
    })),
  );
}

export function openProjectMenu(anchor: Element, t: TaskItem) {
  openProjectPicker(anchor, t.projectId, (id) => id !== t.projectId && moveTask(t.id, id));
}

// A field of the side pane: its label over the value, a button that opens the menu or popover that changes it.
function field(label: string, value: HTMLElement) {
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

// A task with a due date, a repeating one too, gets a button beside the value that clears it; a repeating one asks for a second press.
function dueField(t: TaskItem) {
  const b = tag("button", `field-value${t.bucket === "overdue" ? " over" : ""}${t.due ? " clearable" : ""}`);
  b.insertAdjacentHTML("beforeend", DATE_SVG);
  b.append(t.due ? dueLabel(t.due) : "期限なし");
  b.onclick = () => openDuePop(b, t);
  const row = tag("div", "field-row");
  row.append(b);
  if (t.due) {
    const clear = tag("button", "icon-btn field-clear");
    clear.insertAdjacentHTML("beforeend", CLOSE_SVG);
    clear.setAttribute("aria-label", "日付をクリア");
    // A repeat is lost with the date, so it takes two presses, as the delete button does: the first arms, and leaving the button or 4 seconds disarms.
    let armTimer = 0;
    const disarm = () => {
      clearTimeout(armTimer);
      clear.classList.remove("confirm", "danger");
      clear.innerHTML = CLOSE_SVG;
      clear.setAttribute("aria-label", "日付をクリア");
    };
    clear.onclick = () => {
      if (t.due?.recurring && !clear.classList.contains("confirm")) {
        clear.classList.add("confirm", "danger");
        clear.textContent = "もう一度押すとクリア";
        clear.setAttribute("aria-label", "もう一度押すと繰り返しごと日付をクリア");
        armTimer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      saveTask(t.id, { dueString: "" });
    };
    clear.onblur = disarm;
    row.append(clear);
  }
  return field("日付", row);
}

// The subtasks being created, shown at the end of their parent's list: a row stays until the request fails, or, once it succeeded, until a load that began after it is drawn.
// `settled` is `todoState.seq` when the request succeeded; `el` is the row last drawn for it.
interface Creating {
  parentId: string;
  content: string;
  settled: number | null;
  el: HTMLElement | null;
}
const creating: Creating[] = [];

function creatingRow(job: Creating) {
  const li = tag("li", "task single creating");
  const body = tag("div", "body");
  body.append(tag("div", "t", job.content));
  li.append(tag("span", "spin"), body, tag("span", "creating-label", "作成中"));
  job.el = li;
  return li;
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
    // A click on a link opens it, and one that ends a text selection in the description (to copy it) is not a press to edit.
    view.onclick = (e) => {
      if ((e.target as Element).closest("a")) return;
      const sel = getSelection();
      if (sel && !sel.isCollapsed && view.contains(sel.anchorNode) && view.contains(sel.focusNode)) return;
      edit();
    };
    view.onkeydown = (e) => {
      if (e.key !== "Enter" || e.target !== view) return;
      // Without this the Enter reaches the textarea that edit() focuses, and adds a newline.
      e.preventDefault();
      edit();
    };
    // The button is beside the view, not in it: the view is a role="button" and may hold no other control.
    const wrap = tag("div", "desc-wrap");
    wrap.append(view);
    if (t.description) {
      wrap.classList.add("copyable");
      const copy = tag("button", "icon-btn desc-copy");
      copy.type = "button";
      copy.innerHTML = COPY_SVG;
      copy.setAttribute("aria-label", "説明をコピー");
      copy.onclick = () => void copyText(t.description, "説明をコピーしました");
      wrap.append(copy);
    }
    return [wrap];
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

  // The subtasks created since that load are in it now: their rows are drawn for real.
  for (let i = creating.length - 1; i >= 0; i--) if (creating[i].settled !== null && creating[i].settled! < todoState.loaded) creating.splice(i, 1);
  const parts: HTMLElement[] = [head, ...descParts(t)];
  // A subtask's direct parent, when it has a row to open.
  const parent = t.parent && todoState.taskById.get(t.parent.id);
  if (parent) {
    const link = tag("button", "parent-link");
    link.insertAdjacentHTML("beforeend", RETURN_SVG);
    link.append(tag("span", "pl-label", "親タスク"), tag("span", "pl-name", parent.content));
    link.onclick = () => {
      todoState.open = parent.id;
      renderTodo();
    };
    parts.unshift(link);
  }
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
  subs.append(...t.subtasks.map(subtaskRow), ...creating.filter((c) => c.parentId === t.id).map(creatingRow));
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
    const job: Creating = { parentId: t.id, content, settled: null, el: null };
    creating.push(job);
    subs.append(creatingRow(job));
    // No control is passed: disabling the field would drop its focus, and the next subtask could not be typed at once.
    todoCall("todoist_add_subtask", { parentId: t.id, content }).then((answer) => {
      if (answer === null) {
        creating.splice(creating.indexOf(job), 1);
        job.el?.remove();
      } else {
        job.settled = todoState.seq;
        job.el = null;
      }
    });
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
