// The Todo prompt screen: the instructions Claude follows to turn a Slack message into a task. The user edits them in a field, or in a conversation with Claude
// whose proposals are applied to the field. Only the save button writes them (Rust keeps them in the settings folder).
import type { DiffLine } from "./bindings/DiffLine";
import type { TodoPrompt } from "./bindings/TodoPrompt";
import { getClaude, redrawClaudeItems } from "./claude.js";
import { $, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { setScreen, showPromptScreen } from "./nav.js";
import { itemRow } from "./settings.js";
import { toast } from "./toast.js";
import { showError } from "./view.js";

type Origin = "settings" | "todo";

// Where the screen was opened from; 戻る goes back there.
let origin: Origin = "settings";
// The instructions as saved; null until read.
let saved: TodoPrompt | null = null;
// What the edit field holds; null until the screen was opened once. It is kept, with the conversation, when the screen is left, and gone with the app.
let draft: string | null = null;

// A change Claude proposed: the whole new body, the lines that differ, and the field's text when it was asked (an `open` proposal applies only to that text).
interface Proposal {
  body: string;
  diff: DiffLine[];
  base: string;
  state: "open" | "applied" | "rejected";
}
interface Turn {
  role: "user" | "assistant";
  text: string;
  // An error shown in the conversation; it is not part of what Claude is sent.
  failed?: boolean;
  proposal?: Proposal;
}
const turns: Turn[] = [];
let sending = false;

// The apply buttons of the open proposals drawn now, with the line that says why one is disabled.
let applyControls: { proposal: Proposal; apply: HTMLButtonElement; stale: HTMLElement }[] = [];

// The settings' Claude card row: the state of the instructions and the way in.
export function promptRow() {
  const open = tag("button", "text-btn", "確認・編集");
  open.onclick = () => openPrompt("settings");
  return itemRow({
    name: "Todo の要約プロンプト",
    meta: "Slack のメッセージを Todo にするときの指示",
    status: saved === null ? ["off", "確認中"] : saved.edited ? ["ok", "編集済み"] : ["off", "デフォルト"],
    actions: [open],
  });
}

// Reads the saved instructions; the settings row and the screen follow.
export async function loadPromptState() {
  try {
    saved = await invoke("claude_todo_prompt");
  } catch (e) {
    return showError(e);
  }
  redrawClaudeItems();
  refreshPrompt();
}

function showPromptError(e: unknown) {
  $("prompt-error").textContent = String(e);
  $("prompt-error").hidden = false;
}

// Draws what follows from the state: the status, the buttons, the field, and whether the conversation can be used.
export function refreshPrompt() {
  const [now, text] = [saved, draft];
  const loaded = now !== null && text !== null;
  const dirty = loaded && text !== now.body;
  $("prompt-status").hidden = !dirty;
  $<HTMLButtonElement>("prompt-save").disabled = !dirty;
  $<HTMLButtonElement>("prompt-reset").disabled = !loaded || (!now.edited && text === now.defaultBody);
  $<HTMLTextAreaElement>("prompt-body").disabled = !loaded;
  const ready = getClaude()?.state === "ready";
  const chat = loaded && ready && !sending;
  $<HTMLInputElement>("prompt-input").disabled = !chat;
  $<HTMLButtonElement>("prompt-send").disabled = !chat;
  $("prompt-chat-note").hidden = ready;
  $("prompt-chat-note").textContent = "Claude にログインすると、会話で編集できます";
  for (const { proposal, apply, stale } of applyControls) {
    apply.disabled = proposal.base !== draft;
    stale.hidden = !apply.disabled;
  }
}

function diffCard(p: Proposal) {
  const card = tag("div", "chat-diff");
  for (const d of p.diff) card.append(tag("div", d.kind === "del" ? "diff-del" : "diff-ins", `${d.kind === "del" ? "-" : "+"} ${d.text}`));
  const foot = tag("div", "diff-foot");
  if (p.state !== "open") {
    foot.append(tag("span", "diff-state", p.state === "applied" ? "適用しました" : "却下しました"));
  } else {
    const stale = tag("span", "diff-stale", "編集欄が変わったため適用できません");
    const reject = tag("button", "text-btn", "却下");
    const apply = tag("button", "text-btn primary", "適用");
    reject.onclick = () => {
      p.state = "rejected";
      drawLog();
    };
    apply.onclick = () => {
      draft = p.body;
      $<HTMLTextAreaElement>("prompt-body").value = p.body;
      p.state = "applied";
      drawLog();
    };
    applyControls.push({ proposal: p, apply, stale });
    foot.append(stale, reject, apply);
  }
  card.append(foot);
  return card;
}

function turnNode(t: Turn) {
  if (t.failed) return tag("div", "pending fail", t.text);
  if (t.role === "user") return tag("div", "chat-user", t.text);
  const node = tag("div", "chat-ai", t.text);
  if (t.proposal) node.append(diffCard(t.proposal));
  return node;
}

function drawLog() {
  applyControls = [];
  const thinking = tag("div", "pending");
  thinking.append(tag("span", "spin"), tag("span", "sp", "Claude が考えています…"));
  const log = $("prompt-log");
  log.replaceChildren(...turns.map(turnNode), ...(sending ? [thinking] : []));
  log.scrollTop = log.scrollHeight;
  refreshPrompt();
}

async function send() {
  const input = $<HTMLInputElement>("prompt-input");
  const instruction = input.value.trim();
  if (!instruction || sending || draft === null) return;
  const body = draft;
  const history = turns.filter((t) => !t.failed).map(({ role, text }) => ({ role, text }));
  input.value = "";
  turns.push({ role: "user", text: instruction });
  sending = true;
  drawLog();
  try {
    const answer = await invoke("claude_edit_todo_prompt", { body, history, instruction });
    turns.push({
      role: "assistant",
      text: answer.reply,
      proposal: answer.body === null ? undefined : { body: answer.body, diff: answer.diff, base: body, state: "open" },
    });
  } catch (e) {
    turns.push({ role: "assistant", text: `送れませんでした: ${e}`, failed: true });
  }
  sending = false;
  drawLog();
}

// Opens the screen. The first time, the field takes the saved instructions; after that it keeps what the user left in it.
export async function openPrompt(from: Origin) {
  origin = from;
  showPromptScreen();
  $("prompt-error").hidden = true;
  if (draft === null) {
    if (saved === null) await loadPromptState();
    if (saved === null) return;
    draft = saved.body;
    $<HTMLTextAreaElement>("prompt-body").value = draft;
    $("prompt-fixed").textContent = saved.fixed;
  }
  drawLog();
}

export function initPrompt() {
  $("prompt-back").onclick = () => setScreen(origin);
  $<HTMLTextAreaElement>("prompt-body").oninput = (e) => {
    draft = (e.currentTarget as HTMLTextAreaElement).value;
    $("prompt-error").hidden = true;
    refreshPrompt();
  };
  $("prompt-save").onclick = async () => {
    if (draft === null) return;
    $("prompt-error").hidden = true;
    try {
      saved = await invoke("claude_todo_prompt_save", { body: draft });
    } catch (e) {
      return showPromptError(e);
    }
    toast("保存しました");
    redrawClaudeItems();
    refreshPrompt();
  };
  $("prompt-reset").onclick = async () => {
    $("prompt-error").hidden = true;
    try {
      saved = await invoke("claude_todo_prompt_reset");
    } catch (e) {
      return showPromptError(e);
    }
    draft = saved.body;
    $<HTMLTextAreaElement>("prompt-body").value = draft;
    toast("デフォルトに戻しました");
    redrawClaudeItems();
    refreshPrompt();
  };
  $("prompt-form").onsubmit = (e) => {
    e.preventDefault();
    send();
  };
}
