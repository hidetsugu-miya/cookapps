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
// The oldest turns are dropped past this many; Claude is sent the last SENT_TURNS (the same as Rust's CHAT_TURNS).
const MAX_TURNS = 100;
const SENT_TURNS = 20;
let sending = false;
// A save or a reset is on its way: both buttons wait.
let busy = false;
// Resetting is armed by the first press (see the reset button's handler).
let resetTimer = 0;

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
  $<HTMLButtonElement>("prompt-save").disabled = !dirty || busy;
  $<HTMLButtonElement>("prompt-reset").disabled = !loaded || (!now.edited && text === now.defaultBody) || busy;
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

function addTurn(turn: Turn) {
  turns.push(turn);
  if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
}

// Runs a save or a reset with both buttons disabled; null when it failed (the error is shown).
async function write(call: () => Promise<TodoPrompt>) {
  $("prompt-error").hidden = true;
  busy = true;
  refreshPrompt();
  try {
    return await call();
  } catch (e) {
    showPromptError(e);
    return null;
  } finally {
    busy = false;
  }
}

function disarmReset() {
  clearTimeout(resetTimer);
  const reset = $("prompt-reset");
  reset.classList.remove("confirm", "danger");
  reset.textContent = "デフォルトに戻す";
}

async function send() {
  const input = $<HTMLInputElement>("prompt-input");
  const instruction = input.value.trim();
  if (!instruction || sending || draft === null) return;
  const body = draft;
  const history = turns
    .filter((t) => !t.failed)
    .slice(-SENT_TURNS)
    .map(({ role, text }) => ({ role, text }));
  input.value = "";
  addTurn({ role: "user", text: instruction });
  sending = true;
  drawLog();
  try {
    const answer = await invoke("claude_edit_todo_prompt", { body, history, instruction });
    addTurn({
      role: "assistant",
      text: answer.reply,
      proposal: answer.body === null ? undefined : { body: answer.body, diff: answer.diff, base: body, state: "open" },
    });
  } catch (e) {
    addTurn({ role: "assistant", text: `送れませんでした: ${e}`, failed: true });
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
    $("prompt-fixed-after").textContent = saved.fixedAfter;
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
    if (draft === null || busy) return;
    const body = draft;
    const next = await write(() => invoke("claude_todo_prompt_save", { body }));
    if (next === null) return refreshPrompt();
    saved = next;
    toast("保存しました");
    redrawClaudeItems();
    refreshPrompt();
  };
  // The edits in the field are lost, so it takes two presses, as the delete button does: the first arms, and leaving the button or 4 seconds disarms.
  $("prompt-reset").onclick = async () => {
    const reset = $("prompt-reset");
    if (busy) return;
    if (!reset.classList.contains("confirm")) {
      reset.classList.add("confirm", "danger");
      reset.textContent = "もう一度押すと戻す";
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    const next = await write(() => invoke("claude_todo_prompt_reset"));
    if (next === null) return refreshPrompt();
    saved = next;
    draft = saved.body;
    $<HTMLTextAreaElement>("prompt-body").value = draft;
    toast("デフォルトに戻しました");
    redrawClaudeItems();
    refreshPrompt();
  };
  $("prompt-reset").onblur = disarmReset;
  $("prompt-form").onsubmit = (e) => {
    e.preventDefault();
    send();
  };
}
