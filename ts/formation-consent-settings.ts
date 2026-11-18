// The card of the PCs in the Orca tab of the settings screen (A-37, #893): the saved environments that the owner agreed to put `tsunagiai-mcp` on (`formation_consents`), each with the button that takes the consent back (`formation_consent_revoke`).
// Rust refuses to take it back while a formation of that PC is left, and says why; the words are shown where the other settings show a failure.
import type { FormationConsent } from "./bindings/FormationConsent";
import { $, tag } from "./dom.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { itemRow } from "./settings.js";
import { logError, showFailure } from "./error-card.js";

// The consents as last read, and the PCs whose revocation is on its way (it stops the server there, which takes a while).
let consents: FormationConsent[] = [];
const revoking = new Set<string>();
// Only the latest read may draw.
let readSeq = 0;

function row(c: FormationConsent) {
  const revoke = tag("button", "text-btn", "取り消す");
  revoke.type = "button";
  revoke.setAttribute("aria-label", `${c.environment} の同意を取り消す`);
  revoke.disabled = revoking.has(c.environment);
  revoke.onclick = async () => {
    if (revoking.has(c.environment)) return;
    revoking.add(c.environment);
    draw();
    try {
      consents = await invoke("formation_consent_revoke", { environment: c.environment });
    } catch (e) {
      showFailure("formation-consent-settings", e);
    }
    revoking.delete(c.environment);
    draw();
  };
  return itemRow({ name: c.environment, meta: `tsunagiai-mcp ${c.version}`, status: ["ok", "置き済み"], actions: [revoke] });
}

function draw() {
  $("formation-consent-items").replaceChildren(...(consents.length ? consents.map(row) : [tag("div", "card-empty", "サーバーを置いた PC はありません")]));
}

// Reads the consents and draws them: each time the Orca tab is shown.
export function showConsentCard() {
  const seq = ++readSeq;
  invoke("formation_consents").then(
    (list) => {
      if (seq !== readSeq) return;
      consents = list;
      draw();
    },
    (e) => logError("formation-consent-settings", e),
  );
}

export function initConsentCard() {
  draw();
  $("formation-consent-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "サーバーを置いた PC",
        [
          ["保存した環境の PC でフォーメーションを作るとき、その PC に同意を取ります。同意すると、その PC のつなぎAIの設定フォルダの ", code("remote/"), " に、このアプリと同じ版の ", code("tsunagiai-mcp"), " を置いて、サーバーとして動かします"],
          ["「取り消す」は、その PC のサーバーを止めて、置いたプログラムを消し、同意をなくします。その PC のフォーメーションが残っているときは、取り消せません。先に削除します"],
          ["Orca から環境が消えているときは、その PC には何もせず、同意だけをなくします"],
        ],
        "プログラムは GitHub Release から取り、つなぎAIと同じ署名のものだけを置きます",
      ),
    );
}
