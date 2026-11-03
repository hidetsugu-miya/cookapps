// The Claude tab of the settings (the connection card, the model and effort selects of the four purposes, the prompt row), and the Claude state the sidebar's avatar and the Todo add field follow.
import type { ApiKeyState } from "./bindings/ApiKeyState";
import type { Claude } from "./bindings/Claude";
import type { ClaudeConnection } from "./bindings/ClaudeConnection";
import type { ClaudeSettings } from "./bindings/ClaudeSettings";
import type { Effort } from "./bindings/Effort";
import type { Method } from "./bindings/Method";
import type { Model } from "./bindings/Model";
import { $, tag } from "./dom.js";
import { CLAUDE_SVG, KEY_SVG, LINK_SVG } from "./icons.js";
import { closeClaudePopup } from "./accounts.js";
import { code, confirmUnlink, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { itemRow } from "./settings.js";
import { refreshSlackCompose } from "./slack-compose.js";
import { updateAddMode } from "./todo-add.js";
import { promptRow, refreshPrompt } from "./todo-prompt.js";
import { setClaudeReady, showError } from "./view.js";

// Whether Claude can be used (the method in use, A-4); null until checked.
let claude: Claude | null = null;
export const getClaude = () => claude;

// The settings card's view of the connection (the method, and the subscription's and the API key's own states); null while it is being asked, and after the asking failed.
let connection: ClaudeConnection | null = null;
// Why the asking failed (the rows are not pressable then); null otherwise.
let connectionError: string | null = null;
// The key field is open (to register a key, or to paste it again).
let keyFormOpen = false;
// A change of the method or the key is on its way: the rows wait.
let changing = false;

// A connection row: the radio that picks the method, then `row` (an `itemRow`). Pressing the row, but not a button in it, picks it.
function pickRow(row: HTMLElement, method: Method, pick: () => void) {
  const radio = tag("input", "radio");
  radio.type = "radio";
  radio.name = "claude-method";
  radio.checked = connection?.method === method;
  radio.disabled = changing;
  radio.setAttribute("aria-label", method === "apiKey" ? "API キーを使う" : "サブスクリプションを使う");
  row.prepend(radio);
  row.classList.add("pick");
  row.onclick = (e) => {
    if (!changing && !(e.target as Element).closest("button") && !getSelection()?.toString()) pick();
  };
  return row;
}

// The subscription row: who is logged in to Claude Code, and the state of that login.
function subscriptionRow(c: Claude) {
  const name = "サブスクリプション";
  switch (c.state) {
    case "ready": {
      const avatar = tag("span", "avatar claude");
      avatar.innerHTML = CLAUDE_SVG;
      const meta = [c.email, c.plan && `${c.plan} プラン`, c.version && `Claude Code ${c.version}`].filter(Boolean).join(" ・ ");
      return itemRow({ avatar, name, meta, status: ["ok", "ログイン中"] });
    }
    case "loggedOut":
      return itemRow({ name, meta: ["ログインしていません。ターミナルで ", code("claude auth login"), " を実行してください"], warn: true, status: ["warn", "未ログイン"] });
    case "missing":
      return itemRow({ name, meta: "Claude Code が見つかりません。入れると、Slack のメッセージを要約して Todo にしたり、メールを要約したりできます", status: ["off", "未導入"] });
    default:
      return itemRow({ name, meta: c.message, warn: true, status: ["warn", "確認できません"] });
  }
}

// The API key row: the state of the stored key, and the buttons that paste it again and delete it once there is one.
function keyRow(key: ApiKeyState) {
  const avatar = tag("span", "avatar key");
  avatar.innerHTML = KEY_SVG;
  const billing = "呼び出しごとに課金されます";
  if (key.state === "none") return itemRow({ avatar, name: "API キー", meta: billing, status: ["off", "未登録"] });
  const paste = tag("button", "text-btn", "貼り直す");
  paste.type = "button";
  paste.disabled = changing;
  paste.onclick = () => {
    keyFormOpen = !keyFormOpen;
    redrawClaudeItems();
    if (keyFormOpen) $("claude-key-input").focus();
  };
  const unlink = tag("button", "icon-btn");
  unlink.innerHTML = LINK_SVG;
  unlink.setAttribute("aria-label", "API キーの接続を解除");
  unlink.setAttribute("data-hint", "");
  unlink.disabled = changing;
  unlink.onclick = () =>
    confirmUnlink(
      unlink,
      "API キー",
      `キーを cookapps から削除します。${connection?.method === "apiKey" ? "サブスクリプションに戻しますが、Claude Code はログアウトされたままです。" : ""}Anthropic の Console のキーは残るので、不要なら取り消してください。`,
      () => changeConnection(() => invoke("claude_key_delete")),
    );
  const actions = [paste, unlink];
  switch (key.state) {
    case "ready":
      return itemRow({ avatar, name: "API キー", meta: `${key.workspaceId ? `ワークスペース ${key.workspaceId} ・ ` : ""}${billing}`, status: ["ok", "確認済み"], actions });
    case "unverified":
      return itemRow({ avatar, name: "API キー", meta: key.message, warn: true, status: ["warn", "確認できません"], actions });
    default:
      return itemRow({ avatar, name: "API キー", meta: key.message, warn: true, status: ["warn", "使えません"], actions });
  }
}

// The rows of the connection card (a placeholder while the connection is being asked, one failed row when asking it failed).
function connectionRows() {
  const c = connection;
  if (c === null && connectionError !== null) return [itemRow({ name: "接続", meta: connectionError, warn: true, status: ["warn", "確認できません"] })];
  if (c === null) return [itemRow({ name: "確認しています…", meta: "", status: ["off", "確認中"] })];
  return [
    pickRow(subscriptionRow(c.subscription), "subscription", pickSubscription),
    pickRow(keyRow(c.apiKey), "apiKey", pickKey),
  ];
}

function pickSubscription() {
  keyFormOpen = false;
  if (connection?.method === "subscription") return redrawClaudeItems();
  changeConnection(() => invoke("claude_method_set", { method: "subscription" }));
}

// Without a stored key, or with one Anthropic refuses, pressing the row only opens the field (nothing is switched or logged out); with a usable one, it switches to it.
function pickKey() {
  if (connection?.apiKey.state === "none" || connection?.apiKey.state === "rejected") {
    keyFormOpen = true;
    redrawClaudeItems();
    return $("claude-key-input").focus();
  }
  keyFormOpen = false;
  if (connection?.method === "apiKey") return redrawClaudeItems();
  changeConnection(() => invoke("claude_method_set", { method: "apiKey" }));
}

// Runs a change of the method or the key, then asks for the states again, so every row and the sidebar show what is now true.
// A failure shows its error; the field stays open unless the method was switched anyway (a switch whose logout did not hold keeps the key).
async function changeConnection(change: () => Promise<null>) {
  if (changing) return;
  const before = connection?.method;
  changing = true;
  $("error").hidden = true;
  redrawClaudeItems();
  let failed = false;
  try {
    await change();
  } catch (e) {
    failed = true;
    showError(e);
  }
  changing = false;
  await refreshClaude();
  if (!failed || (connection?.method === "apiKey" && before !== "apiKey")) keyFormOpen = false;
  redrawClaudeItems();
}

// Takes the answer of `claude_status`: the sidebar's Claude avatar (only while Claude is usable), the settings card, and the Todo add field follow.
function applyClaude(next: Claude | null) {
  claude = next;
  $("claude-btn").hidden = next?.state !== "ready";
  setClaudeReady(next?.state === "ready");
  if (next?.state === "ready") $("claude-btn").setAttribute("aria-label", `Claude: ${next.method === "apiKey" ? "API キー" : next.email}`);
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

// value, the text.
const MODELS: [Model, string][] = [["haiku", "Haiku"], ["sonnet", "Sonnet"], ["opus", "Opus"]];
const EFFORTS: [Effort, string][] = [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]];

// The model and effort selects of one purpose. `name` is the purpose's name for the labels (none: the labels are just "モデル" and "effort").
// The effort select carries its value in `data-effort`, which colors it.
function purposeSelects(purpose: Purpose, name: string) {
  const now = modelSettings![purpose];
  const select = <T extends string>(kind: "model" | "effort", options: [T, string][], value: T) => {
    const el = tag("select");
    el.setAttribute("aria-label", name ? `${name}の${kind === "model" ? "モデル" : " effort"}` : kind === "model" ? "モデル" : "effort");
    el.dataset.purpose = purpose;
    el.dataset.kind = kind;
    for (const [v, text] of options) el.append(new Option(text, v, false, v === value));
    if (kind === "effort") el.dataset.effort = value;
    el.disabled = savingModel;
    el.onchange = () => {
      if (kind === "effort") el.dataset.effort = el.value;
      saveModel(purpose, kind === "model" ? { model: el.value as Model } : { effort: el.value as Effort }, el);
    };
    return el;
  };
  return [select("model", MODELS, now.model), select("effort", EFFORTS, now.effort)];
}

// The block of the four purposes with its column headings, shown whether or not Claude is usable; none until the settings are read.
function modelBlock() {
  if (modelSettings === null) return [];
  const note = tag("div", "item-meta model-note", "次の呼び出しから使います。デフォルトは Sonnet と medium");
  const grid = tag("div", "model-grid");
  grid.append(tag("div", "th", "用途"), tag("div", "th", "モデル"), tag("div", "th", "effort"));
  for (const p of PURPOSES) {
    const who = tag("div", "who");
    who.append(tag("div", "", p.name), tag("div", "item-meta", p.meta));
    grid.append(who, ...purposeSelects(p.key, p.name));
  }
  return [note, grid];
}

// The two selects under the prompt screen's request field: the model and effort of the prompt conversation, the same values as the settings'.
export function redrawPromptModel() {
  $("prompt-model").replaceChildren(...(modelSettings === null ? [] : purposeSelects("promptChat", "")));
}

// Every select drawn, on the settings screen and on the prompt screen.
const modelSelects = () => [...document.querySelectorAll<HTMLSelectElement>("select[data-purpose]")];

// Puts the saved values into the drawn selects and lets them be used (or not, while a save is on its way).
function syncModelSelects() {
  for (const el of modelSelects()) {
    const now = modelSettings?.[el.dataset.purpose as Purpose];
    if (now) el.value = now[el.dataset.kind as "model" | "effort"];
    if (el.dataset.kind === "effort") el.dataset.effort = el.value;
    el.disabled = savingModel;
  }
}

// The selects show the saved values until the save succeeds; a failure puts them back and shows the error.
// The selects are not drawn again by the save itself, so the one the user operated keeps its place and gets the focus back that disabling it took away.
// When the card was drawn again meanwhile (a read or a Claude check), the operated select is gone, and the select of the same purpose and kind that is shown gets the focus.
// A change of the model sends the model alone, and Rust saves the effort the model is recommended with; a change of the effort sends both.
async function saveModel(purpose: Purpose, change: { model: Model } | { effort: Effort }, operated: HTMLSelectElement) {
  if (savingModel || modelSettings === null) return;
  savingModel = true;
  saves++;
  $("error").hidden = true;
  for (const el of modelSelects()) el.disabled = true;
  try {
    modelSettings = await invoke("claude_model_settings_save", "model" in change ? { purpose, model: change.model } : { purpose, model: modelSettings[purpose].model, effort: change.effort });
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

// The three cards: the connection rows (and the key field), the model and effort, and the Todo prompt (the last two are shown whether or not Claude is usable).
export function redrawClaudeItems() {
  $("claude-items").replaceChildren(...connectionRows());
  $("claude-key").hidden = !keyFormOpen;
  $("claude-models").replaceChildren(...modelBlock());
  $("claude-prompt").replaceChildren(promptRow());
}

// Asks for the usable state and for the connection card's view together.
// A failure of the usable state is shown as its failed state; a failure of the connection leaves it null, shows the error, and the card shows one failed row nothing can be pressed on.
export async function refreshClaude() {
  const button = $<HTMLButtonElement>("claude-recheck");
  button.disabled = true;
  connection = null;
  connectionError = null;
  applyClaude(null);
  const [status, card] = await Promise.allSettled([invoke("claude_status"), invoke("claude_connection")]);
  if (card.status === "fulfilled") connection = card.value;
  else {
    connectionError = String(card.reason);
    showError(card.reason);
  }
  applyClaude(status.status === "fulfilled" ? status.value : { state: "failed", message: String(status.reason) });
  button.disabled = false;
}

export function initClaude() {
  $("claude-recheck").onclick = refreshClaude;
  $("claude-key").onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("claude-key-input");
    const key = input.value;
    // The key is never shown: the field is emptied as soon as it is read.
    input.value = "";
    await changeConnection(() => invoke("claude_key_save", { key }));
    if (keyFormOpen) input.focus();
  };
  $("claude-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "Claude の使い方",
        [
          ["Claude Code を入れる"],
          ["ターミナルで ", code("claude auth login"), " を実行してログインする（サブスクリプション）"],
          ["API キーを使うときは、Anthropic の Console で、ワークスペースに限定したキーを作る"],
          ["キーを貼って「確認して保存」を押す。キーは OS の資格情報の保管場所に入れ、画面には出さない。キーに切り替えると、この Mac の Claude Code はログアウトされる（戻すときは ", code("claude auth login"), "）"],
          ["↻ で状態を確かめ直す"],
        ],
        "Slack のメッセージの本文（Todoist のプロジェクトの ID と名前を添えて）と、「AI 要約」を押したメールの件名、差出人、日時、本文を、要約のため Anthropic に送ります。Todo の要約プロンプトを Claude と編集するときは、編集欄の指示と会話を送ります。Slack に貼る文章を Claude と校正するときは、編集欄の文章、会話、依頼を、「校正する」か送信を押したときだけ送ります。モデルと effort は、Slack の要約、メールの要約、プロンプトの会話、Slack に貼る文章の校正のそれぞれに選べます",
      ),
    );
}
