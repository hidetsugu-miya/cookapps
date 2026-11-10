// The Claude pane of the Todo screen (T-7): a conversation (claude-chat.ts) in which Claude answers a request about the owner's tasks and proposes tasks, drawn as cards under its reply, which the owner can change and add or reject.
// The pane's elements are in `index.html` (`todo-claude-*`); todo.ts opens and closes it with the Orca pane's frame. The conversation is held in memory only, and Todoist gets a task only when its card's 追加 is pressed.
import type { TodoTaskProposal } from "./bindings/TodoTaskProposal";
import { createChat } from "./claude-chat.js";
import { showModelSlot } from "./claude.js";
import { $, tag } from "./dom.js";
import { DATE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { CARD_DUE } from "./todo-add.js";
import { dueLabel, inboxOf, projectName, projectOf, todoState } from "./todo-data.js";
import { openDueEditor, openProjectPicker } from "./todo-detail.js";
import { todoCall } from "./todo-write.js";

// What the owner has done with a proposed task: the values on its card (name, date as text, project; null is the inbox), and where the card is.
// It is kept by the proposal (a card is drawn again with every redraw of the log), in memory only, and goes with the conversation.
interface Card {
  content: string;
  due: string;
  projectId: string | null;
  status: "open" | "adding" | "added" | "rejected";
  error: string | null;
  // The node drawn now, replaced alone when the card changes; null once the card is closed.
  el: HTMLElement | null;
}
const cardsOf = new WeakMap<TodoTaskProposal, Card>();
function stateOf(t: TodoTaskProposal) {
  const known = cardsOf.get(t);
  if (known) return known;
  const s: Card = { content: t.content, due: t.due ?? "", projectId: t.projectId, status: "open", error: null, el: null };
  cardsOf.set(t, s);
  return s;
}

// The project the card shows: its own, or the inbox for none.
const shownProject = (s: Card) => projectOf(s.projectId ?? (todoState.todo ? inboxOf()?.id : undefined) ?? "");

// The date as the task list writes it when the calendar made the text, else the text as typed.
function dueText(s: Card) {
  const due = CARD_DUE.exec(s.due);
  return due ? dueLabel({ date: due[1], time: due[2] ?? null }) : s.due;
}

// Draws the card again where it is (it is taken off the page when closed).
function show(s: Card) {
  const old = s.el;
  if (s.status === "rejected") {
    s.el = null;
    const box = old?.parentElement;
    old?.remove();
    if (box && !box.childElementCount) box.hidden = true;
    return;
  }
  s.el = card(s);
  old?.replaceWith(s.el);
}

// Creates the task with the values on the card (todoist_add_task, which checks them: its refusal is shown on the card, which stays). The list is read again as after any change.
async function add(s: Card) {
  if (s.status !== "open") return;
  if (!s.content.trim()) return s.el?.querySelector<HTMLInputElement>(".chat-task-name")?.focus();
  s.status = "adding";
  s.error = null;
  show(s);
  let failure = null as string | null;
  const answer = await todoCall("todoist_add_task", { content: s.content, due: s.due || null, projectId: s.projectId }, null, undefined, true, (e) => (failure = String(e)));
  // null with no error: a token is needed, which the reload shows as the token form; the card stays as it was.
  s.status = answer === true ? "added" : "open";
  if (failure !== null) s.error = `追加できませんでした: ${failure}`;
  show(s);
}

// One proposed task: the name, the date and the project as chips (each opens the picker of the task detail), and 却下 and 追加. Added, it is one line.
function card(s: Card) {
  const node = tag("div", "chat-task");
  if (s.status === "added") {
    node.append(tag("div", "chat-task-done", `✓ ${s.content.trim()} を追加しました`));
    return node;
  }
  const busy = s.status === "adding";
  const name = tag("input", "review-name chat-task-name");
  name.value = s.content;
  name.setAttribute("aria-label", "タスクの名前");
  name.disabled = busy;
  name.oninput = () => (s.content = name.value);

  const dueChip = tag("button", "review-chip chat-task-due");
  dueChip.type = "button";
  dueChip.disabled = busy;
  dueChip.insertAdjacentHTML("beforeend", DATE_SVG);
  dueChip.append(dueText(s) || "期限なし");
  dueChip.onclick = () => {
    const picked = CARD_DUE.exec(s.due);
    openDueEditor(dueChip, {
      text: s.due,
      date: picked?.[1] ?? null,
      time: picked?.[2] ?? null,
      recurring: false,
      commit: (text) => {
        s.due = text.trim();
        show(s);
      },
    });
  };

  const project = shownProject(s);
  const projectChip = tag("button", "review-chip chat-task-project");
  projectChip.type = "button";
  projectChip.disabled = busy;
  const dot = tag("span", "pdot");
  dot.style.background = project?.color ?? "";
  projectChip.append(dot, projectName(project));
  projectChip.onclick = () =>
    todoState.todo &&
    openProjectPicker(projectChip, project?.id, (id) => {
      s.projectId = id;
      show(s);
    });
  const chips = tag("div", "review-chips");
  chips.append(dueChip, projectChip);

  const reject = tag("button", "text-btn", "却下");
  reject.type = "button";
  reject.disabled = busy;
  reject.onclick = () => {
    s.status = "rejected";
    show(s);
  };
  const addButton = tag("button", "text-btn primary chat-task-add");
  addButton.type = "button";
  addButton.disabled = busy;
  if (busy) addButton.append(tag("span", "spin"), "追加中");
  else addButton.textContent = "追加";
  addButton.onclick = () => add(s);
  const actions = tag("div", "review-actions");
  actions.append(reject, addButton);

  node.append(name, chips);
  if (s.error !== null) node.append(tag("div", "pending fail review-err", s.error));
  node.append(actions);
  return node;
}

// One card for each proposed task, until it is rejected.
function cards(tasks: TodoTaskProposal[]) {
  const box = tag("div", "chat-tasks");
  for (const t of tasks) {
    const s = stateOf(t);
    if (s.status === "rejected") continue;
    s.el = card(s);
    box.append(s.el);
  }
  box.hidden = box.childElementCount === 0;
  return box;
}

// What Claude is told of an earlier answer's tasks, as the cards show them now: a line each with the name, the date and the project; a rejected one is left out.
function tasksText(tasks: TodoTaskProposal[]) {
  return tasks
    .map(stateOf)
    .filter((s) => s.status !== "rejected")
    .map((s) => `- ${s.content}（日付: ${dueText(s) || "なし"}、プロジェクト: ${projectName(shownProject(s))}）`)
    .join("\n");
}

// There is no text to edit: the conversation is on whenever Claude can be used, and the projects are read by Rust from the last load of Todoist.
const chat = createChat({
  prefix: "todo-claude",
  loginNote: "設定の Claude タブで接続すると、Claude に相談できます",
  text: () => "",
  apply: () => {},
  ask: async (_text, history, instruction) => {
    const answer = await invoke("claude_chat_todo", { history, instruction });
    return { reply: answer.reply, body: null, diff: [], tasks: answer.tasks };
  },
  cards,
  tasksText,
  changed: () => chat.refresh(),
  keyHint: false,
});

// Draws what follows from the state again (Claude was connected or disconnected).
export const refreshTodoClaude = () => chat.refresh();

// The pane was opened: its selects need the settings, and the request field gets the focus.
export function openedTodoClaude() {
  showModelSlot("todo-claude-model");
  $("todo-claude-input").focus();
}

export function initTodoClaude() {
  chat.init();
  chat.draw();
}
