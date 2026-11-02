// The Claude card of the settings, and the Claude state the sidebar's avatar and the Todo add field follow.
import type { Claude } from "./bindings/Claude";
import { $, tag } from "./dom.js";
import { CLAUDE_SVG } from "./icons.js";
import { closeClaudePopup } from "./accounts.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { itemRow } from "./settings.js";
import { updateAddMode } from "./todo-add.js";
import { promptRow, refreshPrompt } from "./todo-prompt.js";
import { setClaudeReady } from "./view.js";

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

// The card's rows: Claude's state, then the Todo prompt (shown whether or not Claude is logged in).
export function redrawClaudeItems() {
  $("claude-items").replaceChildren(claudeRow(), promptRow());
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
        "Slack のメッセージの本文（Todoist のプロジェクトの名前を添えて）と、「AI 要約」を押したメールの件名、差出人、日時、本文を、要約のため Anthropic に送ります。Todo の要約プロンプトを Claude と編集するときは、編集欄の指示と会話を送ります",
      ),
    );
}
