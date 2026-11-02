// The Claude card of the settings, and the Claude state the sidebar's avatar and the Todo add field follow.
import type { Claude } from "./bindings/Claude";
import type { Effort } from "./bindings/Effort";
import type { Model } from "./bindings/Model";
import type { ModelSettings } from "./bindings/ModelSettings";
import { $, tag } from "./dom.js";
import { CLAUDE_SVG } from "./icons.js";
import { closeClaudePopup } from "./accounts.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { itemRow } from "./settings.js";
import { updateAddMode } from "./todo-add.js";
import { promptRow, refreshPrompt } from "./todo-prompt.js";
import { setClaudeReady, showError } from "./view.js";

// Claude Code on this machine; null until checked.
let claude: Claude | null = null;
export const getClaude = () => claude;

// The Claude card's row for what `claude_status` said (null while it is being asked).
function claudeRow() {
  const c = claude;
  if (c === null) return itemRow({ name: "確認しています…", meta: "", status: ["off", "確認中"] });
  switch (c.state) {
    case "ready": {
      const avatar = tag("span", "avatar claude");
      avatar.innerHTML = CLAUDE_SVG;
      const meta = [c.plan && `${c.plan} プラン`, c.version && `Claude Code ${c.version}`].filter(Boolean).join(" ・ ");
      return itemRow({ avatar, name: c.email, meta, status: ["ok", "ログイン中"] });
    }
    case "loggedOut":
      return itemRow({
        name: "ログインしていません",
        meta: ["ターミナルで ", tag("code", "", "claude auth login"), " を実行してください"],
        status: ["warn", "未ログイン"],
      });
    case "missing":
      return itemRow({ name: "Claude Code が見つかりません", meta: "入れると、Slack のメッセージを要約して Todo にしたり、メールを要約したりできます", status: ["off", "未導入"] });
    default:
      return itemRow({ name: "状態を確認できません", meta: c.message, warn: true, status: ["warn", "確認できません"] });
  }
}

// Takes the answer of `claude_status`: the sidebar's Claude avatar (only while logged in), the settings card, and the Todo add field follow.
function applyClaude(next: Claude | null) {
  claude = next;
  $("claude-btn").hidden = next?.state !== "ready";
  setClaudeReady(next?.state === "ready");
  if (next?.state === "ready") $("claude-btn").setAttribute("aria-label", `Claude: ${next.email}`);
  else closeClaudePopup();
  redrawClaudeItems();
  updateAddMode();
  refreshPrompt();
}

// The model and effort of every `claude -p` call (A-2) as the card shows them; null until read.
let modelSettings: ModelSettings | null = null;
// A save is on its way: the selects wait, as saves would share one temporary file.
let savingModel = false;

const MODELS: [Model, string][] = [["haiku", "Haiku"], ["sonnet", "Sonnet（デフォルト）"], ["opus", "Opus"], ["fable", "Fable"]];
const EFFORTS: [Effort, string][] = [["low", "low"], ["medium", "medium（デフォルト）"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]];

function select<T extends string>(label: string, options: [T, string][], value: T, onchange: (value: T) => void) {
  const el = tag("select");
  el.setAttribute("aria-label", label);
  for (const [v, text] of options) el.append(new Option(text, v, false, v === value));
  el.disabled = savingModel;
  el.onchange = () => onchange(el.value as T);
  return el;
}

// The row of the two selects, shown whether or not Claude is logged in; none until the settings are read.
function modelRow() {
  const now = modelSettings;
  if (now === null) return [];
  const who = tag("div", "who");
  who.append(tag("div", "item-name", "モデルと effort"));
  const row = tag("div", "item");
  row.append(
    who,
    select("モデル", MODELS, now.model, (model) => saveModel({ model }, "モデル")),
    select("effort", EFFORTS, now.effort, (effort) => saveModel({ effort }, "effort")),
  );
  return [row];
}

// The selects of the card now, in the order model, effort.
const modelSelects = () => [...$("claude-items").querySelectorAll<HTMLSelectElement>("select")];

// The selects show the saved values until the save succeeds; a failure puts them back and shows the error.
// The row is not drawn again, so the select the user operated keeps its place; it gets the focus back that disabling it took away.
async function saveModel(change: Partial<ModelSettings>, operated: string) {
  if (savingModel || modelSettings === null) return;
  savingModel = true;
  $("error").hidden = true;
  for (const el of modelSelects()) el.disabled = true;
  try {
    modelSettings = await invoke("claude_model_settings_save", { ...modelSettings, ...change });
  } catch (e) {
    showError(e);
  } finally {
    savingModel = false;
    const [model, effort] = modelSelects();
    if (model && effort && modelSettings !== null) {
      [model.value, effort.value] = [modelSettings.model, modelSettings.effort];
    }
    for (const el of modelSelects()) {
      el.disabled = false;
      if (el.getAttribute("aria-label") === operated) el.focus();
    }
  }
}

// Reads the saved model and effort; the card follows.
export async function loadModelSettings() {
  try {
    modelSettings = await invoke("claude_model_settings");
  } catch (e) {
    return showError(e);
  }
  redrawClaudeItems();
}

// The card's rows: Claude's state, the model and effort, then the Todo prompt (the last two are shown whether or not Claude is logged in).
export function redrawClaudeItems() {
  $("claude-items").replaceChildren(claudeRow(), ...modelRow(), promptRow());
}

export async function refreshClaude() {
  const button = $<HTMLButtonElement>("claude-recheck");
  button.disabled = true;
  applyClaude(null);
  try {
    applyClaude(await invoke("claude_status"));
  } catch (e) {
    applyClaude({ state: "failed", message: String(e) });
  }
  button.disabled = false;
}

export function initClaude() {
  $("claude-recheck").onclick = refreshClaude;
  $("claude-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "Claude の使い方",
        [
          ["Claude Code を入れる"],
          ["ターミナルで ", code("claude auth login"), " を実行してログインする"],
          ["↻ で状態を確かめ直す"],
        ],
        "Slack のメッセージの本文（Todoist のプロジェクトの ID と名前を添えて）と、「AI 要約」を押したメールの件名、差出人、日時、本文を、要約のため Anthropic に送ります。Todo の要約プロンプトを Claude と編集するときは、編集欄の指示と会話を送ります。モデルと effort の設定は、Slack の要約、メールの要約、プロンプトの会話のすべてに使われます",
      ),
    );
}
