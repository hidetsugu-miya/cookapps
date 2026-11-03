// The Claude card of the settings (with the model and effort selects of the four purposes), and the Claude state the sidebar's avatar and the Todo add field follow.
import type { Claude } from "./bindings/Claude";
import type { ClaudeSettings } from "./bindings/ClaudeSettings";
import type { Effort } from "./bindings/Effort";
import type { Model } from "./bindings/Model";
import type { ModelSettings } from "./bindings/ModelSettings";
import { $, tag } from "./dom.js";
import { CLAUDE_SVG } from "./icons.js";
import { closeClaudePopup } from "./accounts.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { itemRow } from "./settings.js";
import { refreshSlackCompose } from "./slack-compose.js";
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
  refreshSlackCompose();
}

// The model and effort of each purpose of the `claude -p` calls (A-2) as the selects show them; null until read.
let modelSettings: ClaudeSettings | null = null;
// A save is on its way: the selects wait, as saves would share one temporary file.
let savingModel = false;
// How many saves have started; a read that began before one must not draw over it.
let saves = 0;

type Purpose = keyof ClaudeSettings;

// The `claude -p` calls whose model and effort are chosen apart: the settings key, the name, and when it is used.
const PURPOSES: { key: Purpose; name: string; meta: string }[] = [
  { key: "slackSummary", name: "Slack の要約", meta: "Slack のメッセージから Todo を作るとき" },
  { key: "mailSummary", name: "メールの要約", meta: "メール詳細の AI 要約" },
  { key: "promptChat", name: "プロンプトの会話", meta: "Todo の要約プロンプトを Claude と編集するとき" },
  { key: "proofread", name: "Slack に貼る文章の校正", meta: "Slack に貼る画面の「Claude と校正」" },
];

// value, the text on the settings screen, the short text on the prompt screen.
const MODELS: [Model, string, string][] = [["haiku", "Haiku", "Haiku"], ["sonnet", "Sonnet（デフォルト）", "Sonnet"], ["opus", "Opus", "Opus"], ["fable", "Fable", "Fable"]];
const EFFORTS: [Effort, string, string][] = [["low", "low", "low"], ["medium", "medium（デフォルト）", "medium"], ["high", "high", "high"], ["xhigh", "xhigh", "xhigh"], ["max", "max", "max"]];

// The model and effort selects of one purpose. `name` is the purpose's name for the labels (none: the labels are just "モデル" and "effort"); `compact` is the short text.
function purposeSelects(purpose: Purpose, name: string, compact: boolean) {
  const now = modelSettings![purpose];
  const select = <T extends string>(kind: "model" | "effort", options: [T, string, string][], value: T) => {
    const el = tag("select");
    el.setAttribute("aria-label", name ? `${name}の${kind === "model" ? "モデル" : " effort"}` : kind === "model" ? "モデル" : "effort");
    el.dataset.purpose = purpose;
    el.dataset.kind = kind;
    for (const [v, long, short] of options) el.append(new Option(compact ? short : long, v, false, v === value));
    el.disabled = savingModel;
    el.onchange = () => saveModel(purpose, { [kind]: el.value }, el);
    return el;
  };
  return [select("model", MODELS, now.model), select("effort", EFFORTS, now.effort)];
}

// The block of the four purposes, shown whether or not Claude is logged in; none until the settings are read.
function modelBlock() {
  if (modelSettings === null) return [];
  const head = tag("div", "model-head");
  head.append(tag("span", "item-name", "モデルと effort"), tag("span", "item-meta", "用途ごとに選ぶと、次の呼び出しから使います"));
  const grid = tag("div", "model-grid");
  for (const p of PURPOSES) {
    const who = tag("div", "who");
    who.append(tag("div", "", p.name), tag("div", "item-meta", p.meta));
    grid.append(who, ...purposeSelects(p.key, p.name, false));
  }
  const block = tag("div", "model-block");
  block.append(head, grid);
  return [block];
}

// The two selects under the prompt screen's request field: the model and effort of the prompt conversation, the same values as the settings'.
export function redrawPromptModel() {
  $("prompt-model").replaceChildren(...(modelSettings === null ? [] : purposeSelects("promptChat", "", true)));
}

// Every select drawn, on the settings screen and on the prompt screen.
const modelSelects = () => [...document.querySelectorAll<HTMLSelectElement>("select[data-purpose]")];

// Puts the saved values into the drawn selects and lets them be used (or not, while a save is on its way).
function syncModelSelects() {
  for (const el of modelSelects()) {
    const now = modelSettings?.[el.dataset.purpose as Purpose];
    if (now) el.value = now[el.dataset.kind as "model" | "effort"];
    el.disabled = savingModel;
  }
}

// The selects show the saved values until the save succeeds; a failure puts them back and shows the error.
// The selects are not drawn again by the save itself, so the one the user operated keeps its place and gets the focus back that disabling it took away.
// When the card was drawn again meanwhile (a read or a Claude check), the operated select is gone, and the select of the same purpose and kind that is shown gets the focus.
async function saveModel(purpose: Purpose, change: Partial<ModelSettings>, operated: HTMLSelectElement) {
  if (savingModel || modelSettings === null) return;
  savingModel = true;
  saves++;
  $("error").hidden = true;
  for (const el of modelSelects()) el.disabled = true;
  try {
    modelSettings = await invoke("claude_model_settings_save", { purpose, ...modelSettings[purpose], ...change });
  } catch (e) {
    showError(e);
  } finally {
    savingModel = false;
    syncModelSelects();
    const { purpose: p, kind } = operated.dataset;
    (operated.isConnected ? operated : modelSelects().find((el) => el.dataset.purpose === p && el.dataset.kind === kind && el.offsetParent !== null))?.focus();
  }
}

// Opens the prompt screen's selects: the settings are read the first time, and what was read is drawn if the selects are empty.
export function showPromptModel() {
  if (modelSettings === null) loadModelSettings();
  else if ($("prompt-model").childElementCount === 0) redrawPromptModel();
}

// Reads the saved model and effort; the card and the prompt screen follow. A read that a save overtook is dropped: the save's answer is newer.
export async function loadModelSettings() {
  const started = saves;
  let read: ClaudeSettings;
  try {
    read = await invoke("claude_model_settings");
  } catch (e) {
    return showError(e);
  }
  if (savingModel || saves !== started) return;
  modelSettings = read;
  redrawClaudeItems();
  redrawPromptModel();
}

// The card's rows: Claude's state, the model and effort, then the Todo prompt (the last two are shown whether or not Claude is logged in).
export function redrawClaudeItems() {
  $("claude-items").replaceChildren(claudeRow(), ...modelBlock(), promptRow());
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
        "Slack のメッセージの本文（Todoist のプロジェクトの ID と名前を添えて）と、「AI 要約」を押したメールの件名、差出人、日時、本文を、要約のため Anthropic に送ります。Todo の要約プロンプトを Claude と編集するときは、編集欄の指示と会話を送ります。Slack に貼る文章を Claude と校正するときは、編集欄の文章、会話、依頼を、「校正する」か送信を押したときだけ送ります。モデルと effort は、Slack の要約、メールの要約、プロンプトの会話、Slack に貼る文章の校正のそれぞれに選べます",
      ),
    );
}
