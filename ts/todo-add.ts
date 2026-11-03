// The Todo screen's add field: Quick Add, or a Slack message link summarised by Claude and confirmed on a card; and a task made from a mail.
import { getClaude } from "./claude.js";
import type { Summary } from "./bindings/Summary";
import { $, composing, isMac, tag } from "./dom.js";
import { hostOf } from "./format.js";
import { CLAUDE_SVG, CLOSE_SVG, DATE_SVG, FOLDER_SVG, SLACK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { setScreen } from "./nav.js";
import { getSlackWorkspaces, loadSlackWorkspaces } from "./slack-workspaces.js";
import { toast } from "./toast.js";
import { inboxOf, PICKED_DUE, projectName, projectOf, todoState, viewProjectId } from "./todo-data.js";
import { openDueEditor, openProjectPicker } from "./todo-detail.js";
import { openPrompt } from "./todo-prompt.js";
import { todoCall } from "./todo-write.js";
import { loadTodo } from "./todo.js";
import { showError } from "./view.js";

// Creates a Todoist task in the inbox that points at the thread, and says so. The button shows a spinner in place of its icon meanwhile.
export async function makeTodo(account: string, id: string, subject: string, button: HTMLButtonElement) {
  $("error").hidden = true;
  button.disabled = true;
  const icon = button.innerHTML;
  button.classList.add("busy");
  button.replaceChildren(tag("span", "spin"));
  try {
    const done = await invoke("todoist_task_from_mail", { account, threadId: id, subject });
    if (done === null) return showError("Todoist のトークンが無いか無効です。Todo 画面でトークンを保存してください");
    toast(`受信箱に「${subject || "(件名なし)"}」を追加しました`);
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
    button.innerHTML = icon;
  }
}

// A Slack message link, `https://{ws}.slack.com/archives/{channel}/p{16 digits}` (a reply's has `?thread_ts=` too); Rust checks it again. Returns its host, or null.
function slackMessageHost(text: string) {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const slack = url.hostname === "slack.com" || url.hostname.endsWith(".slack.com");
  return url.protocol === "https:" && slack && /^\/archives\/[A-Z0-9]+\/p\d{16}\/?$/.test(url.pathname) ? url.host : null;
}

// What the add field does with its text: a Slack message link of a connected workspace, with Claude usable, is summarised; any other text is Quick Add.
// `hint` is the line under the field.
function addMode() {
  const host = slackMessageHost($<HTMLInputElement>("todo-add-input").value);
  if (host === null) return { summarize: false, hint: "" };
  const workspaces = getSlackWorkspaces();
  if (workspaces === null) {
    loadSlackWorkspaces();
    return { summarize: false, hint: "" };
  }
  const claude = getClaude();
  if (claude === null) return { summarize: false, hint: "" };
  if (claude.state !== "ready") return { summarize: false, hint: "設定の Claude タブで接続すると、要約して追加できます" };
  const workspace = workspaces.find((w) => hostOf(w.url) === host);
  if (!workspace) return { summarize: false, hint: "このリンクのワークスペースは Slack に接続されていません。設定で追加してください" };
  return { summarize: true, hint: `Slack のメッセージ（${workspace.team}）を Claude が要約します。内容を確かめてから「${$("todo-title").textContent}」に追加します` };
}

// Whether a Quick Add is on its way: the button then shows a spinner and is disabled (the input is, by todoCall).
let adding = false;

// What the add field's button and hint last showed; the list's redraw calls updateAddMode every 10 seconds.
let shownAddMode: { summarize: boolean; hint: string; adding: boolean } | null = null;
export function updateAddMode() {
  const { summarize, hint } = addMode();
  if (shownAddMode?.summarize === summarize && shownAddMode.hint === hint && shownAddMode.adding === adding) return;
  shownAddMode = { summarize, hint, adding };
  const button = $<HTMLButtonElement>("todo-add-button");
  button.className = summarize ? "text-btn primary" : "text-btn";
  button.disabled = adding;
  if (adding) button.replaceChildren(tag("span", "spin"), "追加中");
  else if (summarize) button.innerHTML = `${CLAUDE_SVG}要約する`;
  else button.textContent = "追加";
  $("todo-add-input").classList.toggle("slack", summarize);
  const line = $("todo-add-hint");
  line.hidden = hint === "";
  line.replaceChildren();
  if (summarize) line.insertAdjacentHTML("beforeend", SLACK_SVG);
  line.append(hint);
}

// The Slack links being summarised, waiting for the user's confirmation, or that failed, above the list. Several may be there at once.
// `el` is the row drawn for it: a row is replaced alone, so a card being typed in keeps its focus when another one changes.
interface PendingAdd {
  url: string;
  host: string | null;
  failed: string | null;
  // Set when Claude has answered; the card then asks the user to confirm it.
  summary: Summary | null;
  // Where the task goes: null is the inbox (a link pasted in "今日"). `today` is whether a task with no due date is due today.
  projectId: string | null;
  // The project Claude recommended (it is the first `projectId`), or null; the chip and the menu tag it.
  recommended: string | null;
  today: boolean;
  el: HTMLElement | null;
}
const pendingAdds: PendingAdd[] = [];

function closeButton(onclick: () => void) {
  const close = tag("button", "icon-btn");
  close.innerHTML = CLOSE_SVG;
  close.setAttribute("aria-label", "閉じる");
  close.onclick = onclick;
  return close;
}

// Draws the job's row where it is, or at the end for a new job.
function showPending(job: PendingAdd) {
  const row = job.failed ? failedRow(job) : job.summary ? reviewCard(job, job.summary) : busyRow(job);
  if (job.el) job.el.replaceWith(row);
  else $("todo-pending").append(row);
  job.el = row;
}

function removePending(job: PendingAdd) {
  pendingAdds.splice(pendingAdds.indexOf(job), 1);
  job.el?.remove();
}

function busyRow(job: PendingAdd) {
  const row = tag("div", "pending");
  row.append(tag("span", "spin"), tag("span", "sp", "Claude が要約しています…"), tag("span", "pending-channel", job.host ?? ""));
  return row;
}

function failedRow(job: PendingAdd) {
  const row = tag("div", "pending fail");
  row.append(tag("span", "sp", `要約できませんでした: ${job.failed}`));
  // Rust's wording for a token that cannot read the message (slack.rs read_error).
  if (job.failed?.includes("権限がありません")) {
    const open = tag("button", "text-btn", "設定を開く");
    open.onclick = () => setScreen("settings", "slack");
    row.append(open);
  }
  row.append(closeButton(() => removePending(job)));
  return row;
}

function reviewField(label: string, control: HTMLElement) {
  const field = tag("label", "review-field");
  field.append(tag("span", "review-label", label), control);
  return field;
}

// The card that asks the user to confirm Claude's summary: name, description, due date and project can be changed, the link cannot (it ends the description).
function reviewCard(job: PendingAdd, summary: Summary) {
  const name = tag("input", "review-name");
  name.value = summary.content;
  const description = tag("textarea", "review-desc");
  description.value = summary.description;
  // The due date is text Todoist reads (or empty); the chip opens the same popover as a task's detail, which changes only this text.
  let dueText = summary.due ?? "";
  const dueChip = tag("button", "review-chip review-due");
  dueChip.type = "button";
  const showDue = () => {
    dueChip.replaceChildren();
    dueChip.insertAdjacentHTML("beforeend", DATE_SVG);
    dueChip.append(dueText || (job.today ? "空なら今日" : "期限なし"));
  };
  showDue();
  dueChip.onclick = () => {
    const picked = PICKED_DUE.exec(dueText);
    openDueEditor(dueChip, {
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
  const project = tag("button", "review-chip review-project");
  project.type = "button";
  const showProject = () => {
    project.replaceChildren();
    project.insertAdjacentHTML("beforeend", FOLDER_SVG);
    const id = job.projectId ?? inboxOf()?.id ?? "";
    project.append(projectName(projectOf(id)));
    // Choosing another project takes the tag off the chip; the menu keeps it on its row.
    if (job.recommended !== null && id === job.recommended) project.append(tag("span", "tag", "推奨"));
  };
  showProject();
  project.onclick = () =>
    todoState.todo &&
    openProjectPicker(
      project,
      job.projectId ?? inboxOf()?.id,
      (id) => {
        job.projectId = id;
        showProject();
      },
      job.recommended,
    );
  const team = getSlackWorkspaces()?.find((w) => hostOf(w.url) === job.host)?.team ?? job.host ?? "";
  const source = tag("div", "review-src");
  source.title = job.url;
  source.insertAdjacentHTML("beforeend", SLACK_SVG);
  source.append(`${team} の Slack のメッセージ（リンクは説明の末尾に付きます）`);
  // Only when the summary leaves out some of the thread's messages (a long thread, or a part that Claude could not summarise).
  const omitted = summary.omitted > 0 ? [tag("div", "review-omitted", `途中の ${summary.omitted} 件は要約に含まれていません`)] : [];
  const error = tag("div", "pending fail review-err");
  error.hidden = true;
  const drop = tag("button", "text-btn review-drop", "破棄");
  const add = tag("button", "text-btn primary review-add", "追加");
  const keys = tag("span", "review-keys");
  keys.append(tag("kbd", "", isMac ? "⌘" : "Ctrl"), tag("kbd", "", "Enter"), " で追加");
  const actions = tag("div", "review-actions");
  actions.append(keys, drop, add);
  const editPrompt = tag("button", "link-btn", "プロンプトを編集");
  editPrompt.type = "button";
  editPrompt.onclick = () => openPrompt("todo");
  const head = tag("div", "review-head");
  head.insertAdjacentHTML("beforeend", CLAUDE_SVG);
  head.append(tag("span", "review-head-text", "Claude の要約です。確かめてから追加してください"), editPrompt);
  const chips = tag("div", "review-chips");
  chips.append(dueChip, project);
  const body = tag("div", "review-body");
  body.append(reviewField("名前", name), reviewField("説明", description), chips, source, ...omitted, error, actions);
  const card = tag("div", "review");
  card.append(head, body);

  let saving = false;
  const commit = async () => {
    if (saving) return;
    if (!name.value.trim()) return name.focus();
    saving = true;
    drop.disabled = add.disabled = true;
    add.replaceChildren(tag("span", "spin"), "追加中");
    error.hidden = true;
    try {
      const added = await invoke("todoist_add_from_slack", {
        url: job.url,
        content: name.value,
        description: description.value,
        due: dueText,
        projectId: job.projectId,
        today: job.today,
      });
      removePending(job);
      // null: a token is needed, and the load shows the token form.
      if (added !== null) toast(`「${added}」を追加しました`);
      loadTodo(false, false);
    } catch (e) {
      // The card stays as the user left it.
      error.textContent = `追加できませんでした: ${e}`;
      error.hidden = false;
      saving = false;
      drop.disabled = add.disabled = false;
      add.textContent = "追加";
    }
  };
  add.onclick = commit;
  drop.onclick = () => removePending(job);
  // Enter in the name, or Cmd+Enter (Ctrl+Enter off macOS) anywhere on the card, adds. Escape does nothing: it would lose a summary by accident.
  card.onkeydown = (e) => {
    if (e.key !== "Enter" || composing(e) || !(e.target === name || (isMac ? e.metaKey : e.ctrlKey))) return;
    e.preventDefault();
    commit();
  };
  // Focus without scrolling the list away from where the user is, and only when nothing is being typed (a summary takes seconds,
  // and taking the focus from a row's name would save the half-typed name on blur).
  setTimeout(() => {
    const active = document.activeElement;
    const idle = active === document.body || (active instanceof HTMLInputElement && active.id === "todo-add-input" && !active.value);
    if (name.isConnected && idle) name.focus({ preventScroll: true });
  });
  return card;
}

// Sends the Slack link to Rust, which reads the message and has Claude summarise it. The field is free at once; the result shows in the row above the list as a card to confirm.
function addFromSlack(url: string) {
  const input = $<HTMLInputElement>("todo-add-input");
  // Like Quick Add: in "今日" the task goes to the inbox, due today unless the user gives a date.
  const inToday = todoState.view === "today";
  input.value = "";
  updateAddMode();
  input.focus();
  const job: PendingAdd = { url, host: slackMessageHost(url), failed: null, summary: null, projectId: inToday ? null : (viewProjectId(todoState.view) ?? null), recommended: null, today: inToday, el: null };
  pendingAdds.push(job);
  showPending(job);
  invoke("todoist_summarize_slack", { url }).then(
    (summary) => {
      // null: a token is needed, and the load shows the token form. Todoist disconnected meanwhile: there is no project to add to.
      if (summary === null || todoState.todo === null) {
        removePending(job);
        loadTodo(false, false);
        return;
      }
      // Claude's project starts the card, when the list has it (Rust checked it against the sync it last read).
      if (summary.projectId !== null && projectOf(summary.projectId)) job.projectId = job.recommended = summary.projectId;
      job.summary = summary;
      showPending(job);
    },
    (e) => {
      job.failed = String(e);
      showPending(job);
    },
  );
}

export function initTodoAdd() {
  $("todo-add-input").oninput = updateAddMode;
  $("todo-add").onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("todo-add-input");
    const text = input.value.trim();
    if (!text) return;
    // Until Claude's state and the workspaces are known, a Slack link would go to Quick Add as plain text: wait for the next Enter.
    if (slackMessageHost(text) !== null && (getClaude() === null || getSlackWorkspaces() === null)) return;
    if (addMode().summarize) return addFromSlack(text);
    // In "今日" the task goes where Quick Add puts it (the inbox, or the project named in the text), and a text with no date is due today.
    const inToday = todoState.view === "today";
    const projectId = inToday ? null : viewProjectId(todoState.view);
    adding = true;
    updateAddMode();
    const added = await todoCall("todoist_add", { text, projectId, today: inToday }, input);
    adding = false;
    if (added !== null) {
      input.value = "";
      // false: created, but the move into the project failed (it is in the inbox) or, in "今日", the due date could not be set.
      toast(
        added
          ? "タスクを追加しました"
          : inToday
            ? "タスクを追加しましたが、期限を今日にできませんでした"
            : "タスクを追加しましたが、プロジェクトへ移せませんでした。受信箱にあります",
      );
    }
    updateAddMode();
    input.focus();
  };
}
