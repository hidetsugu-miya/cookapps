// The card of the Notion tab of the settings screen (N-1): the connected workspaces (`notion_accounts`), each with its state and the button that unlinks it (`notion_disconnect`), and the button that starts the consent in the browser (`notion_connect`).
// A token is never shown; Rust keeps it in the keychain.
import type { NotionAccount } from "./bindings/NotionAccount";
import { $, tag } from "./dom.js";
import { avatarColor, initials } from "./format.js";
import { confirmUnlink, hintPopup, toggleHint } from "./hint.js";
import { LINK_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { itemRow } from "./settings.js";
import { logError, showFailure } from "./error-card.js";

// The workspaces as last read, or null until the first read.
let accounts: NotionAccount[] | null = null;
// Only the latest read, and no read that began before an unlink or a connection, may draw.
let readSeq = 0;

function row(a: NotionAccount) {
  const avatar = tag("span", "avatar", initials(a.workspaceName));
  avatar.style.background = avatarColor(a.workspaceName);
  const unlink = tag("button", "icon-btn");
  unlink.innerHTML = LINK_SVG;
  unlink.setAttribute("aria-label", `${a.workspaceName} の接続を解除`);
  unlink.setAttribute("data-hint", "");
  unlink.onclick = () =>
    confirmUnlink(unlink, a.workspaceName, "トークンを Notion で取り消し、つなぎAIから削除します。Notion のページは残ります。", async () => {
      readSeq++;
      try {
        await invoke("notion_disconnect", { workspaceId: a.workspaceId });
      } catch (e) {
        return showFailure("notion-settings", e);
      }
      accounts = (accounts ?? []).filter((x) => x.workspaceId !== a.workspaceId);
      draw();
    });
  return itemRow({
    avatar,
    name: a.workspaceName,
    meta: [a.userName, a.userEmail].filter((s) => s).join(" ・ "),
    status: a.reconnect ? ["warn", "再連携が要る"] : ["ok", "使える"],
    actions: [unlink],
  });
}

function draw() {
  if (accounts === null) return $("notion-accounts").replaceChildren();
  $("notion-accounts").replaceChildren(...(accounts.length ? accounts.map(row) : [tag("div", "card-empty", "ワークスペースはまだありません")]));
}

// Reads the workspaces and draws them: each time the Notion tab is shown. Notion is asked nothing.
export function showNotionTab() {
  const seq = ++readSeq;
  invoke("notion_accounts").then(
    (list) => {
      if (seq !== readSeq) return;
      accounts = list;
      draw();
    },
    (e) => logError("notion-settings", e),
  );
}

// Opens the browser for the consent of one workspace. Connecting a workspace again replaces its token, which is how a workspace that needs a new connection is fixed.
async function addWorkspace(button: HTMLButtonElement) {
  button.disabled = true;
  try {
    await invoke("notion_connect");
  } catch (e) {
    showFailure("notion-settings", e);
  } finally {
    button.disabled = false;
  }
  showNotionTab();
}

export function initNotionTab() {
  $("notion-add").onclick = (e) => addWorkspace(e.currentTarget as HTMLButtonElement);
  $("notion-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "Notion のワークスペースの追加",
        [
          ["「追加」を押すと、既定のブラウザが開きます"],
          ["Notion でワークスペースを選び、つなぎAIへのアクセスを許可します"],
          ["ワークスペースごとに追加します。何度でも足せます"],
          ["「再連携が要る」と出たワークスペースは、もう一度「追加」で許可すると使えるようになります"],
        ],
        "トークンは OS の資格情報の保管場所に入れ、画面には出しません",
      ),
    );
}
