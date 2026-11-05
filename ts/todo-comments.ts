// The comments of the task open in the Todo detail: the list with its authors and files, and the field that adds one, with a file if the user picked one.
// They are not part of the task load: they are fetched when a task's detail is opened, and the section draws itself in place when an answer arrives.
import type { Comment } from "./bindings/Comment";
import { $, composing, isMac, tag } from "./dom.js";
import { avatarColor, hostOf, initials } from "./format.js";
import { CHEVRON_SVG, CLIP_SVG, CLOSE_SVG, FILE_SVG, SEND_SVG } from "./icons.js";
import { invoke, invokeRaw, type Upload } from "./ipc.js";
import { dueLabel, markdownHtml, todoState } from "./todo-data.js";
import { loadTodo } from "./todo.js";
import { showError } from "./view.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
// The header that carries the file's name to `todoist_upload`, percent-encoded (the body is the file's bytes alone).
const FILE_NAME_HEADER = "x-file-name";

// What was typed for a task, and the file picked for it, with the upload's answer once it succeeded (a retry after a failed add reuses it, as long as the file is the same).
interface Draft {
  text: string;
  file: File | null;
  uploaded: Upload | null;
}

// Per task, in memory only: what was fetched or added, what was typed, the failure of the last fetch, and the requests and the fold in progress.
const held = new Map<string, Comment[]>();
const drafts = new Map<string, Draft>();
const failures = new Map<string, string>();
const loading = new Set<string>();
const sending = new Set<string>();
const folded = new Set<string>();

// The comments of a task that are loaded (none when they were not fetched), for the content handed to Orca (A-9).
export const loadedComments = (taskId: string) => held.get(taskId);

function draftOf(taskId: string) {
  const draft = drafts.get(taskId) ?? { text: "", file: null, uploaded: null };
  drafts.set(taskId, draft);
  return draft;
}

// The parts of the section drawn last, which an answer redraws. It is the section of the open task, or of one that was open; `redraw` checks.
interface View {
  taskId: string;
  count: HTMLElement;
  head: HTMLElement;
  list: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  clip: HTMLButtonElement;
  chip: HTMLElement;
}
let view: View | null = null;

function commentRow(c: Comment) {
  const row = tag("div", "c-row");
  const avatar = tag("div", "avatar", initials(c.author));
  avatar.style.background = avatarColor(c.author);
  const main = tag("div", "c-main");
  const meta = tag("div", "c-meta");
  meta.append(tag("b", "c-author", c.author));
  if (c.posted) meta.append(tag("span", "c-date", dueLabel(c.posted)));
  main.append(meta);
  // A comment of only a file has the file's name as its text, which the file card says already.
  const text = c.content.trim();
  if (text && text !== c.attachment?.fileName) {
    const body = tag("div", "c-text md");
    body.innerHTML = markdownHtml(c.content);
    main.append(body);
  }
  if (c.attachment) {
    // A card with no address is not a link.
    const card = c.attachment.fileUrl ? tag("a", "c-file") : tag("div", "c-file");
    if (card instanceof HTMLAnchorElement) {
      card.href = c.attachment.fileUrl!;
      // The name is the sender's to write and can differ from where the card goes: the host shows where.
      card.title = hostOf(c.attachment.fileUrl!);
    }
    card.insertAdjacentHTML("beforeend", FILE_SVG);
    card.append(tag("span", "c-file-name", c.attachment.fileName));
    main.append(card);
  }
  row.append(avatar, main);
  return row;
}

function drawList(v: View) {
  const comments = held.get(v.taskId);
  const failure = failures.get(v.taskId);
  const open = !folded.has(v.taskId);
  v.head.setAttribute("aria-expanded", String(open));
  v.count.textContent = comments?.length ? String(comments.length) : "";
  v.list.hidden = !open;
  const nodes: HTMLElement[] = (comments ?? []).map(commentRow);
  if (!comments && loading.has(v.taskId)) {
    const note = tag("div", "c-note");
    note.append(tag("span", "spin"), "読み込み中…");
    nodes.push(note);
  }
  if (comments?.length === 0 && !failure) nodes.push(tag("div", "c-note", "コメントはまだありません"));
  if (failure) nodes.push(tag("div", "c-note fail", `コメントを読み込めませんでした: ${failure}`));
  v.list.replaceChildren(...nodes);
}

// The field's controls follow the draft: the send button needs text or a file and waits while a comment is on its way (the field stays, so it keeps its focus).
function drawComposer(v: View) {
  const draft = draftOf(v.taskId);
  const busy = sending.has(v.taskId);
  v.input.readOnly = busy;
  v.clip.disabled = busy;
  v.send.disabled = busy || (!draft.text.trim() && !draft.file);
  v.send.replaceChildren();
  if (busy) v.send.append(tag("span", "spin"));
  else v.send.insertAdjacentHTML("beforeend", SEND_SVG);
  v.chip.hidden = !draft.file;
  if (!draft.file) return v.chip.replaceChildren();
  const remove = tag("button", "icon-btn");
  remove.type = "button";
  remove.innerHTML = CLOSE_SVG;
  remove.setAttribute("aria-label", "ファイルを外す");
  remove.disabled = busy;
  remove.onclick = () => {
    draft.file = null;
    draft.uploaded = null;
    drawComposer(v);
  };
  v.chip.replaceChildren(tag("span", "c-chip-name", draft.file.name), remove);
}

// Draws what changed for `taskId`, the field's controls only when the comments did not change (the list is not drawn again under a selection or a press); nothing when its section is not the one on screen.
function redraw(taskId: string, composerOnly = false) {
  if (!view || view.taskId !== taskId || todoState.open !== taskId) return;
  if (!composerOnly) drawList(view);
  drawComposer(view);
}

// The field is one line high and grows with its text, up to 6 lines (the `max-height` of `.chat-input`; then it scrolls).
function growInput(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

// A detached field has no height to read, so the detail calls this once the section is in the page.
export function fitCommentInput() {
  if (view) growInput(view.input);
}

// The one file picker, outside the detail, which a redraw replaces: a redraw while the panel is open would drop the chosen file.
function filePicker() {
  let input = document.getElementById("comment-file") as HTMLInputElement | null;
  if (input) return input;
  input = tag("input");
  input.id = "comment-file";
  input.type = "file";
  input.hidden = true;
  input.onchange = () => {
    const file = input!.files?.[0];
    // Emptied so that the same file can be picked again.
    input!.value = "";
    const taskId = todoState.open;
    if (!file || !taskId) return;
    if (file.size > MAX_FILE_BYTES) return showError("ファイルが大きすぎます（100 MB まで）");
    const draft = draftOf(taskId);
    draft.file = file;
    draft.uploaded = null;
    redraw(taskId, true);
  };
  document.body.append(input);
  return input;
}

async function load(taskId: string, projectId: string) {
  if (loading.has(taskId)) return;
  loading.add(taskId);
  failures.delete(taskId);
  const before = new Set((held.get(taskId) ?? []).map((c) => c.id));
  redraw(taskId);
  let tokenNeeded = false;
  try {
    const answer = await invoke("todoist_comments", { taskId, projectId });
    if (answer === null) tokenNeeded = true;
    else {
      // A comment added while this was on its way is not in the answer, which may be older: it stays.
      const added = (held.get(taskId) ?? []).filter((c) => !before.has(c.id) && !answer.some((a) => a.id === c.id));
      held.set(taskId, [...answer, ...added]);
    }
  } catch (e) {
    failures.set(taskId, String(e));
  }
  loading.delete(taskId);
  redraw(taskId);
  // A token is needed: the load of the Todo screen shows the form for it.
  if (tokenNeeded) loadTodo();
}

// The Todo screen shown again with a task's detail still open: its comments are fetched, as for a detail that was not showing.
export function fetchOpenComments() {
  const task = todoState.open ? todoState.taskById.get(todoState.open) : undefined;
  if (task) load(task.id, task.projectId);
}

// Uploads the picked file, if any, then adds the comment. A failure shows the error and keeps the draft; a token that is needed takes the load that shows its form.
async function send(taskId: string) {
  const draft = draftOf(taskId);
  if ((!draft.text.trim() && !draft.file) || sending.has(taskId)) return;
  $("error").hidden = true;
  sending.add(taskId);
  redraw(taskId, true);
  let tokenNeeded = false;
  try {
    let attachment: Upload | null = null;
    if (draft.file) {
      if (!draft.uploaded) {
        const bytes = new Uint8Array(await draft.file.arrayBuffer());
        draft.uploaded = await invokeRaw("todoist_upload", bytes, { [FILE_NAME_HEADER]: encodeURIComponent(draft.file.name) });
      }
      attachment = draft.uploaded;
    }
    const comment = draft.file && attachment === null ? null : await invoke("todoist_add_comment", { taskId, content: draft.text, attachment });
    if (comment === null) tokenNeeded = true;
    else {
      // A fetch that answered first may hold the comment already.
      held.set(taskId, [...(held.get(taskId) ?? []).filter((x) => x.id !== comment.id), comment]);
      draft.text = "";
      draft.file = null;
      draft.uploaded = null;
      // The redraw below puts the empty draft in the field; one already drawn is emptied here, since the field is not rebuilt by an answer.
      if (view?.taskId === taskId) view.input.value = "";
    }
  } catch (e) {
    showError(e);
  }
  sending.delete(taskId);
  redraw(taskId);
  if (view?.taskId === taskId) growInput(view.input);
  if (tokenNeeded) loadTodo();
}

// The section drawn in the detail of a task: the heading that folds the comments, the comments, and the field. `fresh` fetches them.
export function commentsSection(taskId: string, projectId: string, fresh: boolean) {
  const root = tag("section", "comments");
  const head = tag("button", "c-head");
  head.type = "button";
  const chevron = tag("span", "c-chevron");
  chevron.innerHTML = CHEVRON_SVG;
  const count = tag("span", "c-count");
  head.append(chevron, "コメント", count);
  head.onclick = () => {
    if (!folded.delete(taskId)) folded.add(taskId);
    redraw(taskId);
  };
  const list = tag("div", "c-list");

  const form = tag("form", "c-form");
  const box = tag("div", "c-box");
  const input = tag("textarea", "chat-input c-input");
  input.rows = 1;
  input.placeholder = "コメント";
  input.dataset.field = "comment";
  input.setAttribute("aria-label", "コメント");
  input.autocomplete = "off";
  input.value = draftOf(taskId).text;
  input.oninput = () => {
    draftOf(taskId).text = input.value;
    growInput(input);
    redraw(taskId, true);
  };
  // Enter is a line break; Cmd+Enter (Ctrl+Enter off macOS) sends, unless it only confirms an IME conversion.
  input.onkeydown = (e) => {
    if (e.key !== "Enter" || composing(e) || !(isMac ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    send(taskId);
  };
  const clip = tag("button", "icon-btn c-clip");
  clip.type = "button";
  clip.innerHTML = CLIP_SVG;
  clip.setAttribute("aria-label", "ファイルを添付");
  const picker = filePicker();
  clip.onclick = () => picker.click();
  const sendButton = tag("button", "icon-btn c-send");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", isMac ? "送信（⌘↩）" : "送信（Ctrl+Enter）");
  box.append(input, clip, sendButton);
  const chip = tag("div", "c-chip");
  form.append(box, chip);
  form.onsubmit = (e) => {
    e.preventDefault();
    send(taskId);
  };

  root.append(head, list, form);
  view = { taskId, count, head, list, input, send: sendButton, clip, chip };
  drawList(view);
  drawComposer(view);
  if (fresh) load(taskId, projectId);
  return root;
}
