// The card 「このマシンの Orca」 of the 開発 tab (the tab `orca`) of the settings screen (A-12): the pairing link that Orca makes for "This computer", a save, and the button that takes the pairing back.
// The link holds a token, so it is never shown again: the field is emptied as soon as it is read, and Rust keeps the token in the keychain and answers only whether a pairing is kept.
import type { OrcaPairing } from "./bindings/OrcaPairing";
import { $, tag } from "./dom.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { pairingChanged } from "./orca.js";
import { itemRow } from "./settings.js";
import { logError, showFailure } from "./error-card.js";

// Whether a pairing is kept, as last read, or null until the first read.
let saved: OrcaPairing | null = null;
// Only the latest read may draw, and none that began before a save or a revoke.
let readSeq = 0;
// A save or a revoke is on its way.
let busy = false;

const input = () => $<HTMLInputElement>("orca-pairing-link");

function draw() {
  const revoke = tag("button", "text-btn", "取り消す");
  revoke.type = "button";
  revoke.setAttribute("aria-label", "ペアリングを取り消す");
  revoke.disabled = busy;
  revoke.onclick = () => run(() => invoke("orca_pairing_revoke"));
  $("orca-pairing-items").replaceChildren(itemRow({ name: "このマシンの Orca", meta: "", status: saved?.paired ? ["ok", "ペアリング済み"] : ["off", "未設定"], actions: saved?.paired ? [revoke] : [] }));
  $<HTMLButtonElement>("orca-pairing-save").disabled = busy;
}

// Runs a save or a revoke, and tells the Orca screen, which streams this machine's list only while a pairing is kept.
async function run(call: () => Promise<OrcaPairing>) {
  if (busy) return;
  busy = true;
  readSeq++;
  draw();
  try {
    saved = await call();
    pairingChanged();
  } catch (e) {
    showFailure("orca-pairing-settings", e);
  }
  busy = false;
  draw();
}

// Reads whether a pairing is kept and draws the row: each time the 開発 tab is shown. Orca is asked nothing.
export function showOrcaPairingCard() {
  const seq = ++readSeq;
  invoke("orca_pairing_status").then(
    (s) => {
      if (seq !== readSeq) return;
      saved = s;
      draw();
    },
    (e) => logError("orca-pairing-settings", e),
  );
}

export function initOrcaPairingCard() {
  draw();
  $("orca-pairing-form").onsubmit = (e) => {
    e.preventDefault();
    const link = input().value;
    input().value = "";
    if (link.trim() !== "") run(() => invoke("orca_pairing_save", { link }));
  };
  $("orca-pairing-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "このマシンの Orca",
        [
          ["Orca の設定で、ペアリングリンクを作ります。リンクの宛先は「This computer」にします"],
          ["作ったリンク（", code("orca://pair?code=…"), "）をここに貼って、「保存」を押します。リンクは使わないと 1 時間で切れます"],
          ["保存すると、Orca に一度つないで、リンクのトークンをこのアプリだけのトークンに替えます。Orca が起動している必要があります"],
          ["ペアリングがあると、このマシンの Orca のタブを、別の PC と同じ色付きのストリームで描きます。つながらないときは、これまでと同じ読み方に戻ります"],
          ["「取り消す」は、このアプリが持つトークンを消します。Orca の設定の一覧にも残るので、そこでも取り消せます"],
        ],
        "トークンは OS の資格情報の保管場所に入れ、画面には出しません",
      ),
    );
}
