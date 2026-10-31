// The Todo screen's add field: Quick Add, or a Slack message link summarised by Claude; and a task made from a mail.
import { getClaude } from "./claude.js";
import { $, tag } from "./dom.js";
import { hostOf } from "./format.js";
import { CLAUDE_SVG, CLOSE_SVG, SLACK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { setScreen } from "./nav.js";
import { getSlackWorkspaces, loadSlackWorkspaces } from "./slack-workspaces.js";
import { toast } from "./toast.js";
import { todoState, viewProjectId } from "./todo-data.js";
import { todoCall } from "./todo-write.js";
import { loadTodo } from "./todo.js";
import { showError } from "./view.js";

// Creates a Todoist task in the inbox that points at the thread, and says so.
export async function makeTodo(account: string, id: string, subject: string, button: HTMLButtonElement) {
  $("error").hidden = true;
  button.disabled = true;
  try {
    const done = await invoke("todoist_task_from_mail", { account, threadId: id, subject });
    if (done === null) return showError("Todoist のトークンが無いか無効です。Todo 画面でトークンを保存してください");
    toast(`受信箱に「${subject || "(件名なし)"}」を追加しました`);
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
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
  if (claude.state !== "ready") return { summarize: false, hint: "Claude にログインすると、要約して追加できます" };
  const workspace = workspaces.find((w) => hostOf(w.url) === host);
  if (!workspace) return { summarize: false, hint: "このリンクのワークスペースは Slack に接続されていません。設定で追加してください" };
  return { summarize: true, hint: `Slack のメッセージ（${workspace.team}）を Claude が要約し、「${$("todo-title").textContent}」に追加します` };
}

// What the add field's button and hint last showed; the list's redraw calls updateAddMode every 10 seconds.
let shownAddMode: { summarize: boolean; hint: string } | null = null;
export function updateAddMode() {
  const { summarize, hint } = addMode();
  if (shownAddMode?.summarize === summarize && shownAddMode.hint === hint) return;
  shownAddMode = { summarize, hint };
  const button = $("todo-add-button");
  button.className = summarize ? "text-btn primary" : "text-btn";
  if (summarize) button.innerHTML = `${CLAUDE_SVG}要約して追加`;
  else button.textContent = "追加";
  $("todo-add-input").classList.toggle("slack", summarize);
  const line = $("todo-add-hint");
  line.hidden = hint === "";
  line.replaceChildren();
  if (summarize) line.insertAdjacentHTML("beforeend", SLACK_SVG);
  line.append(hint);
}

// The Slack links being summarised or that failed, above the list. Several may run at once.
const pendingAdds: { id: number; host: string | null; failed: string | null }[] = [];
let pendingSeq = 0;

function renderPending() {
  $("todo-pending").replaceChildren(
    ...pendingAdds.map((job) => {
      const row = tag("div", `pending${job.failed ? " fail" : ""}`);
      if (!job.failed) {
        row.append(tag("span", "spin"), tag("span", "sp", "Claude が要約しています…"), tag("span", "pending-channel", job.host ?? ""));
        return row;
      }
      row.append(tag("span", "sp", `追加できませんでした: ${job.failed}`));
      // Rust's wording for a token that cannot read the message (slack.rs read_error).
      if (job.failed.includes("権限がありません")) {
        const open = tag("button", "text-btn", "設定を開く");
        open.onclick = () => setScreen("settings");
        row.append(open);
      }
      const close = tag("button", "icon-btn");
      close.innerHTML = CLOSE_SVG;
      close.setAttribute("aria-label", "閉じる");
      close.onclick = () => {
        pendingAdds.splice(pendingAdds.indexOf(job), 1);
        renderPending();
      };
      row.append(close);
      return row;
    }),
  );
}

// Sends the Slack link to Rust, which reads the message, has Claude summarise it and adds the task. The field is free at once; the result shows in the row above the list.
function addFromSlack(url: string) {
  const input = $<HTMLInputElement>("todo-add-input");
  // Like Quick Add: in "今日" the task goes to the inbox, due today unless the summary has a date.
  const inToday = todoState.view === "today";
  const projectId = inToday ? null : viewProjectId(todoState.view);
  input.value = "";
  updateAddMode();
  input.focus();
  const job = { id: ++pendingSeq, host: slackMessageHost(url), failed: null as string | null };
  pendingAdds.push(job);
  renderPending();
  invoke("todoist_add_from_slack", { url, projectId, today: inToday }).then(
    (name) => {
      pendingAdds.splice(pendingAdds.indexOf(job), 1);
      renderPending();
      // null: a token is needed, and the load shows the token form.
      if (name !== null) toast(`「${name}」を追加しました`);
      loadTodo(false, false);
    },
    (e) => {
      job.failed = String(e);
      renderPending();
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
    const added = await todoCall("todoist_add", { text, projectId, today: inToday }, input);
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
    input.focus();
  };
}
