// The Todo prompt screen: the instructions Claude follows to turn a Slack message into a task. The user edits them in a field, or in a conversation with Claude
// whose proposals are applied to the field. Only the save button writes them (Rust keeps them in the settings folder).
import type { TodoPrompt } from "./bindings/TodoPrompt";
import { createChat } from "./claude-chat.js";
import { redrawPromptRow, showPromptModel } from "./claude.js";
import { $, tag } from "./dom.js";
import { CLAUDE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { setScreen, showPromptScreen } from "./nav.js";
import { itemRow, settingsTab } from "./settings.js";
import { toast } from "./toast.js";
import { showError } from "./view.js";

type Origin = "settings" | "todo";

// Where the screen was opened from; 戻る goes back there.
let origin: Origin = "settings";
// The instructions as saved; null until read.
let saved: TodoPrompt | null = null;
// What the edit field holds; null until the screen was opened once. It is kept, with the conversation, when the screen is left, and gone with the app.
let draft: string | null = null;

// A save or a reset is on its way: both buttons wait.
let busy = false;
// Resetting is armed by the first press (see the reset button's handler).
let resetTimer = 0;

// The conversation with Claude about the field's text (claude-chat.ts). Applying a proposal fills the field and does not save.
const chat = createChat({
  prefix: "prompt",
  loginNote: "設定の Claude タブで接続すると、会話で編集できます",
  text: () => (saved !== null ? draft : null),
  apply: (text) => {
    draft = text;
    $<HTMLTextAreaElement>("prompt-body").value = text;
  },
  ask: (body, history, instruction) => invoke("claude_edit_todo_prompt", { body, history, instruction }),
  changed: refreshPrompt,
});

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
  redrawPromptRow();
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
  chat.refresh();
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

// Opens the screen. The first time, the field takes the saved instructions; after that it keeps what the user left in it.
export async function openPrompt(from: Origin) {
  origin = from;
  showPromptScreen();
  $("prompt-error").hidden = true;
  // Opened from Todo, the settings may not be read; the selects under the request field need them.
  showPromptModel();
  if (draft === null) {
    if (saved === null) await loadPromptState();
    if (saved === null) return;
    draft = saved.body;
    $<HTMLTextAreaElement>("prompt-body").value = draft;
    $("prompt-fixed").textContent = saved.fixed;
    $("prompt-fixed-after").textContent = saved.fixedAfter;
  }
  chat.draw();
}

export function initPrompt() {
  $("prompt-back").onclick = () => setScreen(origin, settingsTab());
  // The way in from the Todo screen's heading.
  $("todo-prompt").innerHTML = CLAUDE_SVG;
  $("todo-prompt").onclick = () => openPrompt("todo");
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
    redrawPromptRow();
    refreshPrompt();
  };
  // The edits in the field are lost, so it takes two presses: the first arms, and leaving the button or 4 seconds disarms.
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
    redrawPromptRow();
    refreshPrompt();
  };
  $("prompt-reset").onblur = disarmReset;
  chat.init();
}
