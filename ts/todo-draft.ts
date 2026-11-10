// The modal that opens when Claude has summarised a Slack message (S-2): the draft of the Todo on the left, shaped like the task detail (the name and the description, and beside them the project, the date and the labels),
// 破棄 at the bottom left and the add button at the bottom right. Nothing is created until the add button is pressed.
// The left part is `.draft-todo`; at its right is the pane for Claude (S-18, `.draft-chat`): a request there makes Claude propose a new name and description, drawn as a diff
// that 適用 puts into the left part and 却下 drops. The conversation is held in memory and is gone when the modal closes.
// The screen behind is inert while it is open, so Tab stays inside; ✕ and 破棄 close it, and Escape and a click on the dimmed part do not, so a draft is never lost by accident.
import type { PromptEdit } from "./bindings/PromptEdit";
import type { Summary } from "./bindings/Summary";
import { createChat } from "./claude-chat.js";
import { showModelSlot } from "./claude.js";
import { $, composing, isMac, tag } from "./dom.js";
import { hostOf } from "./format.js";
import { CLAUDE_SVG, CLOSE_SVG, DATE_SVG, PLUS_SVG, SLACK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { getSlackWorkspaces } from "./slack-workspaces.js";
import { addSlackTodo, CARD_DUE, type ReviewJob } from "./todo-add.js";
import { inboxOf, projectName, projectOf, todoState } from "./todo-data.js";
import { field, openDueEditor, openProjectPicker } from "./todo-detail.js";

// What the owner of the draft does with it: drop it (破棄, ✕), learn that the task was added (`added` is its name; null when Todoist needs a token), and open the prompt screen.
export interface DraftHooks {
  remove: () => void;
  added: (name: string | null) => void;
  editPrompt: () => void;
}

// The open draft: `scrim` is its node (hidden while the prompt screen is shown), `behind` the parts of the page made inert, `opener` where the focus returns.
let open: { scrim: HTMLElement; behind: HTMLElement[]; opener: HTMLElement | null; shown: boolean } | null = null;

// Whether a draft is open, shown or not.
export const draftOpen = () => open !== null;

// The left part of the open draft that the conversation reads and changes; `saving` is true while the add is on its way, when a proposal cannot be applied.
let live: { name: HTMLInputElement; description: HTMLTextAreaElement; saving: boolean } | null = null;

// The conversation with Claude about the name and the description (claude-chat.ts), one text for both: the two as a JSON array, so a proposal is stale as soon as either is edited by hand.
// The elements of its pane are made with the modal (`draft-*` ids), so it is reset before they go.
const chat = createChat({
  prefix: "draft",
  loginNote: "設定の Claude タブで接続すると、Claude と直せます",
  text: () => (live ? JSON.stringify([live.name.value, live.description.value]) : null),
  apply: (text) => {
    if (!live) return;
    const [content, desc] = JSON.parse(text) as [string, string];
    live.name.value = content;
    live.description.value = desc;
  },
  ask: async (text, history, instruction): Promise<PromptEdit> => {
    const [content, description] = JSON.parse(text) as [string, string];
    const r = await invoke("claude_edit_todo_draft", { content, description, history, instruction });
    if (r.content === null && r.description === null) return { reply: r.reply, body: null, diff: [] };
    return { reply: r.reply, body: JSON.stringify([r.content ?? content, r.description ?? description]), diff: [...r.contentDiff, ...r.descriptionDiff] };
  },
  // An answer that arrives after the modal closed belongs to a draft that is gone; the next draft's pane is drawn again.
  changed: () => live && chat.refresh(),
  locked: () => live?.saving ?? false,
  keyHint: false,
});

function close() {
  if (!open) return;
  const { scrim, behind, opener } = open;
  chat.reset();
  live = null;
  open = null;
  scrim.remove();
  for (const el of behind) el.inert = false;
  (opener?.isConnected ? opener : $("todo-add-input")).focus();
}

// The scrim stays in the page, hidden, because the conversation's pane is found by its ids.
function hide() {
  if (!open?.shown) return;
  open.shown = false;
  open.scrim.hidden = true;
  for (const el of open.behind) el.inert = false;
}

// Puts a draft that `hide` took off the page back, and focuses it.
export function resumeDraft() {
  if (!open || open.shown) return;
  open.shown = true;
  for (const el of open.behind) el.inert = true;
  open.scrim.hidden = false;
  // Claude may have been connected or disconnected on the settings screen meanwhile.
  chat.refresh();
  open.scrim.querySelector<HTMLElement>(".draft")!.focus();
}

export function openDraft(job: ReviewJob, summary: Summary, hooks: DraftHooks) {
  close();
  const name = tag("input", "name draft-name");
  name.value = summary.content;
  name.setAttribute("aria-label", "タスクの名前");
  const description = tag("textarea", "draft-desc");
  description.value = summary.description;
  description.setAttribute("aria-label", "説明");

  // The due date is text Todoist reads (or empty); the field opens the same popover as a task's detail, which changes only this text.
  let dueText = summary.due ?? "";
  const dueButton = tag("button", "field-value draft-due");
  dueButton.type = "button";
  const showDue = () => {
    dueButton.replaceChildren();
    dueButton.insertAdjacentHTML("beforeend", DATE_SVG);
    dueButton.append(dueText || (job.today ? "空なら今日" : "期限なし"));
  };
  showDue();
  dueButton.onclick = () => {
    const picked = CARD_DUE.exec(dueText);
    openDueEditor(dueButton, {
      text: dueText,
      date: picked?.[1] ?? null,
      time: picked?.[2] ?? null,
      recurring: false,
      commit: (text) => {
        dueText = text.trim();
        showDue();
      },
    });
  };

  const add = tag("button", "draft-add");
  add.type = "button";
  const projectButton = tag("button", "field-value draft-project");
  projectButton.type = "button";
  const showProject = () => {
    const id = job.projectId ?? inboxOf()?.id ?? "";
    const p = projectOf(id);
    const dot = tag("span", "pdot");
    dot.style.background = p?.color as string;
    projectButton.replaceChildren(dot, projectName(p));
    // Choosing another project takes the tag off the chip; the menu keeps it on its row.
    if (job.recommended !== null && id === job.recommended) projectButton.append(tag("span", "tag", "推奨"));
    add.setAttribute("aria-label", `${projectName(p)}に追加`);
  };
  showProject();
  projectButton.onclick = () =>
    todoState.todo &&
    openProjectPicker(
      projectButton,
      job.projectId ?? inboxOf()?.id,
      (id) => {
        job.projectId = id;
        showProject();
      },
      job.recommended,
    );
  // The labels are not sent: the add command takes none, so the field is only the frame of the task detail's.
  const labels = tag("div", "field");
  labels.append(tag("div", "field-label", "ラベル"));

  const team = getSlackWorkspaces()?.find((w) => hostOf(w.url) === job.host)?.team ?? job.host ?? "";
  const source = tag("div", "draft-src");
  source.title = job.url;
  source.insertAdjacentHTML("beforeend", SLACK_SVG);
  source.append(`${team} の Slack のメッセージ`);
  const editPrompt = tag("button", "link-btn draft-prompt", "プロンプトを編集");
  editPrompt.type = "button";
  const closeButton = tag("button", "icon-btn draft-close");
  closeButton.type = "button";
  closeButton.innerHTML = CLOSE_SVG;
  closeButton.setAttribute("aria-label", "閉じる");
  const head = tag("div", "draft-head");
  head.append(source, tag("span", "draft-grow"), editPrompt, closeButton);

  // The link of the message is put at the end of the description by Rust; it is shown here as it will be, and cannot be edited.
  const link = tag("div", "draft-link", job.url);
  // Only when the summary leaves out some of the thread's messages (a long thread, or a part that Claude could not summarise).
  const omitted = summary.omitted > 0 ? [tag("div", "draft-omitted", `${summary.omitted} 件のメッセージは要約に含まれていません`)] : [];
  // Only when the linked message was long enough to be cut before it was summarised.
  const targetCut = summary.targetCut ? [tag("div", "draft-target-cut", "対象のメッセージは長いため、先頭だけを要約しました")] : [];
  const error = tag("div", "pending fail draft-err");
  error.hidden = true;
  const main = tag("div", "draft-main");
  main.append(name, description, link, ...omitted, ...targetCut, error);
  const side = tag("aside", "detail-side");
  side.append(field("プロジェクト", projectButton), field("日付", dueButton), labels);

  const drop = tag("button", "text-btn danger draft-drop", "破棄");
  drop.type = "button";
  add.innerHTML = PLUS_SVG;
  const foot = tag("div", "draft-foot");
  foot.append(drop, tag("span", "draft-grow"), add);
  const todo = tag("section", "draft-todo");
  todo.append(head, main, side, foot);

  const dialog = tag("div", "draft");
  dialog.id = "todo-draft";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Todo の案");
  dialog.tabIndex = -1;
  const pane = claudePane();
  dialog.append(todo, pane);
  const scrim = tag("div", "scrim modal");
  scrim.append(dialog);
  // The dimmed part takes the press and does nothing; the default is cancelled so that the press does not move the focus out of the dialog.
  scrim.onpointerdown = (e) => e.target === scrim && e.preventDefault();

  live = { name, description, saving: false };
  // Editing the left part by hand makes an open proposal stale (it was made for the text it was asked about).
  name.oninput = description.oninput = () => chat.refresh();
  const commit = async () => {
    if (live!.saving) return;
    if (!name.value.trim()) return name.focus();
    live!.saving = true;
    drop.disabled = add.disabled = closeButton.disabled = true;
    add.replaceChildren(tag("span", "spin"));
    add.setAttribute("aria-label", "追加中");
    error.hidden = true;
    try {
      const added = await addSlackTodo(job, name.value, description.value, dueText);
      close();
      hooks.added(added);
    } catch (e) {
      // The draft stays as the user left it.
      error.textContent = `追加できませんでした: ${e}`;
      error.hidden = false;
      live!.saving = false;
      drop.disabled = add.disabled = closeButton.disabled = false;
      add.innerHTML = PLUS_SVG;
      showProject();
    }
  };
  add.onclick = commit;
  const discard = () => {
    close();
    hooks.remove();
  };
  drop.onclick = closeButton.onclick = discard;
  editPrompt.onclick = () => {
    hide();
    hooks.editPrompt();
  };
  // Enter in the name, or Cmd+Enter (Ctrl+Enter off macOS) anywhere in the draft, adds.
  // Not in the Claude pane, where Cmd+Enter sends the request.
  dialog.onkeydown = (e) => {
    if (e.key !== "Enter" || composing(e) || pane.contains(e.target as Node) || !(e.target === name || (isMac ? e.metaKey : e.ctrlKey))) return;
    e.preventDefault();
    commit();
  };

  const behind = [...document.querySelectorAll<HTMLElement>("#sidebar, #content")];
  open = { scrim, behind, opener: document.activeElement as HTMLElement | null, shown: true };
  for (const el of behind) el.inert = true;
  document.body.append(scrim);
  chat.init();
  chat.clearInput();
  chat.draw();
  showModelSlot("draft-model");
  dialog.focus();
}

// The pane for Claude, shaped like the Slack thread's (S-7): the log, the request field with its send button, and the model and effort under it. Its ids are the ones claude-chat.ts reads.
function claudePane() {
  const clear = tag("button", "text-btn chat-clear", "クリア");
  clear.id = "draft-clear";
  clear.type = "button";
  clear.disabled = true;
  const head = tag("div", "chat-head");
  head.insertAdjacentHTML("beforeend", CLAUDE_SVG);
  head.append("Claude と直す", clear);
  const log = tag("div", "chat-log");
  log.id = "draft-log";
  const note = tag("p", "chat-note");
  note.id = "draft-chat-note";
  note.hidden = true;
  const input = tag("textarea", "chat-input");
  input.id = "draft-input";
  input.rows = 1;
  input.setAttribute("aria-label", "Claude への指示");
  input.autocomplete = "off";
  const send = tag("button", "icon-btn chat-send chat-send-icon");
  send.id = "draft-send";
  send.setAttribute("aria-label", "送信");
  send.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>');
  const composerFoot = tag("div", "composer-foot");
  composerFoot.append(send);
  const composer = tag("div", "composer");
  composer.append(input, composerFoot);
  const model = tag("div", "chat-model");
  model.id = "draft-model";
  const form = tag("form", "chat-form");
  form.id = "draft-form";
  form.append(composer, model);
  const foot = tag("div", "chat-foot");
  foot.append(note, form);
  const pane = tag("aside", "chat-pane draft-chat");
  pane.id = "draft-chat";
  pane.setAttribute("aria-label", "Claude");
  pane.append(head, log, foot);
  return pane;
}
