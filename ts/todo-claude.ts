// The Claude pane of the Todo screen (T-7): a conversation (claude-chat.ts) in which Claude answers a request about the owner's tasks and proposes tasks, drawn as cards under its reply.
// The pane's elements are in `index.html` (`todo-claude-*`); todo.ts opens and closes it with the Orca pane's frame. The conversation is held in memory only, and the cards create nothing in Todoist.
import type { TodoTaskProposal } from "./bindings/TodoTaskProposal";
import { createChat } from "./claude-chat.js";
import { showModelSlot } from "./claude.js";
import { $, tag } from "./dom.js";
import { DATE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { CARD_DUE } from "./todo-add.js";
import { dueLabel, projectName, projectOf } from "./todo-data.js";

// One card for each proposed task: the name, then the date and the project as chips (each only when the task has it).
function cards(tasks: TodoTaskProposal[]) {
  const box = tag("div", "chat-tasks");
  for (const t of tasks) {
    const card = tag("div", "chat-task");
    card.append(tag("div", "chat-task-name", t.content));
    const chips = tag("div", "review-chips");
    const due = t.due === null ? null : CARD_DUE.exec(t.due);
    if (due) {
      const chip = tag("span", "review-chip");
      chip.insertAdjacentHTML("beforeend", DATE_SVG);
      chip.append(dueLabel({ date: due[1], time: due[2] ?? null }));
      chips.append(chip);
    }
    const project = t.projectId === null ? undefined : projectOf(t.projectId);
    if (project) {
      const chip = tag("span", "review-chip");
      const dot = tag("span", "pdot");
      dot.style.background = project.color;
      chip.append(dot, projectName(project));
      chips.append(chip);
    }
    card.append(...(chips.childElementCount ? [chips] : []));
    box.append(card);
  }
  return box;
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
