// One task opened on the Todo screen: its name, description, linked mail and subtasks, and beside them its project and due date.
import type { TaskItem } from "./bindings/TaskItem";
import { $, composing, onEnter, tag } from "./dom.js";
import { addDays, isoDate, WEEKDAYS } from "./format.js";
import { CLOSE_SVG, COPY_SVG, DATE_SVG, MAIL_SVG, PLUS_SVG, RETURN_SVG } from "./icons.js";
import { closeMenu, openMenu, showMenu } from "./menu.js";
import { commentsSection, fitCommentInput } from "./todo-comments.js";
import { accountSet, dueLabel, linkedMail, markdownHtml, PRIORITY_COLORS, projectName, projectOf, todoState } from "./todo-data.js";
import { checkBox, openMailFromTodo, renderList } from "./todo-list.js";
import { createLabel, moveTask, saveTask, setTaskDone, todoCall } from "./todo-write.js";
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

// The time of what is typed in the due popover, as `HH:MM`, or null: "15:00", "9:30", "15時", "15時30分", each with 午前 or 午後 in front ("午後 3時"),
// alone or after a date, 今日, 明日 or 明後日 ("2026-11-06 15:00", "明日15時"). The whole text must be of this form: other words change what a number means ("夜8時"), so they are not read.
// An hour of 24 or more, or minutes of 60 or more, is not a time.
const TYPED_TIME = /^(?:(?:\d{4}-\d{2}-\d{2}|今日|明日|明後日)\s*)?(?:(午前|午後)\s*)?(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分)?)$/;
function typedTime(text: string): string | null {
  const m = TYPED_TIME.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3] ?? m[4] ?? 0);
  if (minute >= 60) return null;
  let h = hour;
  if (m[1]) {
    if (hour > 12) return null;
    h = (hour % 12) + (m[1] === "午後" ? 12 : 0);
  } else if (hour >= 24) return null;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
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
// The text in the field is confirmed by Enter or by a click elsewhere that closes the popover (what was typed is not lost); Escape cancels it.
// A picked day keeps the time typed in the field ("15:00", "15時", "明日 午後3時", "2026-11-06 15:00"; `typedTime`), else the time the due date had.
// The task's detail and the Slack summary card both open it; what is done with the new text is theirs.
export function openDueEditor(anchor: Element, e: DueEdit) {
  const pop = tag("div", "menu due-pop");
  const input = tag("input", "chip-input");
  input.value = e.text;
  input.placeholder = "例: 明日 15時";
  input.setAttribute("aria-label", "期限（空欄で期限なし）");
  const confirmText = () => {
    if (input.value.trim() !== e.text) e.commit(input.value);
  };
  input.onkeydown = (ev) => {
    if (composing(ev)) return;
    if (ev.key !== "Enter") return;
    closeMenu();
    confirmText();
  };
  const month = e.date ? addDays(e.date, 0) : new Date();
  pop.append(input);
  if (!e.recurring)
    pop.append(
      monthPicker(new Date(month.getFullYear(), month.getMonth(), 1), e.date, (iso) => {
        const time = typedTime(input.value) ?? e.time;
        closeMenu();
        const value = time ? `${iso} ${time}` : iso;
        if (value !== e.text) e.commit(value);
      }),
    );
  showMenu(anchor, pop, confirmText);
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
    // A repeat is lost with the date, so it takes two presses: the first arms, and leaving the button or 4 seconds disarms.
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

// The color of the label `name` among the labels to pick from.
const labelColor = (name: string) => todoState.todo!.labels.find((l) => l.name === name)?.color ?? "var(--muted)";

// The popover that sets the labels of the task `id`: a field that narrows the labels by what is typed over the list, each row toggling its label on the task.
// Text that is none of the labels offers a last row that makes it. Enter does what the row of an exact match, else the create row, does.
// The task's labels are read when a row is pressed, not when the popover opened: a refresh may have changed them since.
function openLabelPicker(anchor: Element, id: string) {
  const pop = tag("div", "menu label-pop");
  const input = tag("input", "chip-input");
  input.placeholder = "ラベルを検索または作成";
  input.setAttribute("aria-label", "ラベルを検索または作成");
  const list = tag("div", "label-list");
  const toggle = (name: string) => {
    const now = todoState.taskById.get(id)?.labels;
    closeMenu();
    // A refresh may have taken the task out of the list: its labels are unknown, and the whole list would be overwritten.
    if (now) saveTask(id, { labels: now.includes(name) ? now.filter((n) => n !== name) : [...now, name] });
  };
  const create = (name: string) => {
    const now = todoState.taskById.get(id)?.labels;
    closeMenu();
    if (now) createLabel(id, name, [...now, name]);
  };
  // What the typed text matches exactly (ignoring case), and what it is.
  const exact = () => todoState.todo!.labels.find((l) => l.name.toLowerCase() === input.value.trim().toLowerCase());
  const draw = () => {
    const text = input.value.trim();
    const on = todoState.taskById.get(id)?.labels ?? [];
    const rows = todoState.todo!.labels
      .filter((l) => l.name.toLowerCase().includes(text.toLowerCase()))
      .map((l) => {
        const b = tag("button");
        b.type = "button";
        b.setAttribute("aria-current", String(on.includes(l.name)));
        const dot = tag("span", "pdot");
        dot.style.background = l.color;
        // The name comes from Todoist, and may be a collaborator's: text only.
        b.append(dot, tag("span", "label-name", l.name));
        b.onclick = () => toggle(l.name);
        return b;
      });
    if (text && !exact()) {
      const b = tag("button", "label-create");
      b.type = "button";
      b.insertAdjacentHTML("beforeend", PLUS_SVG);
      b.append(`「${text}」を作成`);
      b.onclick = () => create(text);
      rows.push(b);
    }
    list.replaceChildren(...rows);
  };
  input.oninput = draw;
  input.onkeydown = (ev) => {
    if (composing(ev) || ev.key !== "Enter") return;
    const text = input.value.trim();
    if (!text) return;
    const same = exact();
    if (same) toggle(same.name);
    else create(text);
  };
  draw();
  pop.append(input, list);
  showMenu(anchor, pop);
  input.focus();
}

// The labels of `t`: a header with a button that opens the picker, and under it each label as a chip with a button that takes it off.
function labelsField(t: TaskItem) {
  const add = tag("button", "icon-btn field-add");
  add.insertAdjacentHTML("beforeend", PLUS_SVG);
  add.setAttribute("aria-label", "ラベルを追加");
  add.onclick = () => openLabelPicker(add, t.id);
  const head = tag("div", "field-head");
  head.append(tag("div", "field-label", "ラベル"), add);
  const f = tag("div", "field");
  f.append(head);
  if (t.labels.length) {
    const chips = tag("div", "label-chips");
    for (const name of t.labels) {
      const chip = tag("span", "label-chip");
      const dot = tag("span", "pdot");
      dot.style.background = labelColor(name);
      const x = tag("button", "icon-btn");
      x.insertAdjacentHTML("beforeend", CLOSE_SVG);
      x.setAttribute("aria-label", `ラベル「${name}」を外す`);
      x.onclick = () => saveTask(t.id, { labels: (todoState.taskById.get(t.id)?.labels ?? t.labels).filter((n) => n !== name) });
      chip.append(dot, tag("span", "label-name", name), x);
      chips.append(chip);
    }
    f.append(chips);
  }
  return f;
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

function growDesc(area: HTMLTextAreaElement) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

// The description of `t`: its Markdown shown in full, or, while it is edited, the textarea and its buttons.
function descParts(t: TaskItem): HTMLElement[] {
  if (todoState.descEdit?.id !== t.id) {
    // Another task was opened: what was typed for the old one is dropped.
    todoState.descEdit = null;
    const view = tag("div", t.description ? "desc md" : "desc empty");
    if (t.description) view.innerHTML = markdownHtml(t.description);
    else view.textContent = "説明を追加";
    view.dataset.field = "desc";
    view.tabIndex = 0;
    view.setAttribute("role", "button");
    // Not aria-label: it would replace the description itself for a screen reader.
    view.setAttribute("aria-description", "押すと編集");
    const edit = () => {
      todoState.descEdit = { id: t.id, value: t.description };
      renderDetail();
      const area = $("todo-detail").querySelector<HTMLTextAreaElement>(".desc-edit")!;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    };
    const selectedIn = () => {
      const sel = getSelection();
      return !!sel && !sel.isCollapsed && view.contains(sel.anchorNode) && view.contains(sel.focusNode);
    };
    // A click on a link opens it, and one that ends a text selection in the description (to copy it) is not a press to edit.
    // The edit waits for a second click: a double or triple click selects a word or a paragraph, and its first click has no selection yet.
    // element.click() has `detail` 0 and counts as a press.
    let editTimer = 0;
    view.onclick = (e) => {
      if ((e.target as Element).closest("a")) return;
      clearTimeout(editTimer);
      if (e.detail > 1 || selectedIn()) return;
      editTimer = setTimeout(() => {
        // The task was closed, a redraw replaced the view, a screen change hid it (offsetParent is null), or the selection came after the press.
        if (todoState.open === t.id && view.isConnected && view.offsetParent !== null && !selectedIn()) edit();
      }, 250);
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
  // The comments are fetched when this task was not the one shown: another task, or no detail at all.
  const fresh = !!$("todo-detail").hidden || $("todo-detail").dataset.task !== t.id;
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
  // The checkbox is beside the button, not in it: a button may hold no other control. Completing the parent takes the open task out of the list with it, and the detail falls back to the list.
  if (parent) {
    const chip = tag("div", "parent-chip");
    const parentBox = checkBox(PRIORITY_COLORS[parent.priority], false, "親タスクを完了にする");
    parentBox.onchange = () => setTaskDone(parent.id, true, parentBox);
    const link = tag("button", "parent-link");
    link.insertAdjacentHTML("beforeend", RETURN_SVG);
    link.append(tag("span", "pl-label", "親タスク"), tag("span", "pl-name", parent.content));
    link.onclick = () => {
      todoState.open = parent.id;
      renderTodo();
    };
    chip.append(parentBox, link);
    parts.unshift(chip);
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
  parts.push(title, subs, add, commentsSection(t.id, t.projectId, fresh));

  const main = tag("div", "detail-main");
  main.append(...parts);
  const side = tag("aside", "detail-side");
  side.append(projectField(t), dueField(t), labelsField(t));
  $("todo-detail").replaceChildren(main, side);
  $("todo-detail").dataset.task = t.id;
  const area = $("todo-detail").querySelector<HTMLTextAreaElement>(".desc-edit");
  if (area) growDesc(area);
  fitCommentInput();
  if (field) {
    const again = $("todo-detail").querySelector<HTMLInputElement>(`[data-field="${field}"]`);
    again?.focus();
    if (caret != null) again?.setSelectionRange?.(caret, caret);
  }
}
