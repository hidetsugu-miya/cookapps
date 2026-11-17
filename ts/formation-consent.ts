// The owner's consent to put `tsunagiai-mcp` on the PC of a saved environment (A-37, #893): one for each PC. The consent is Rust's (`formation_consents`: the PCs whose server is placed and pinned); this module asks for it in a dialog when a PC has none, and `formation_consent` puts the program there.
import { tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { showError } from "./view.js";

// The environment of this Mac: it needs no consent.
const LOCAL = "local";
// The port the server listens on (`formation_server::PORT`), told to the owner in the dialog.
const PORT = 47823;

// Whether the PC of `environment` has the owner's consent.
async function agreed(environment: string): Promise<boolean> {
  return (await invoke("formation_consents")).some((c) => c.environment === environment);
}

// The dialog under `anchor` (it replaces the menu that is open there). Resolves true once the owner agreed and Rust put the program on the PC; false when the owner declines, or closes the dialog some other way (Escape, a press elsewhere). A failure of the placement shows its words and keeps the dialog, so that the owner can agree again or decline.
function openConsentDialog(anchor: Element, environment: string): Promise<boolean> {
  const pop = tag("div", "menu formation-new-pop formation-consent-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", `${environment} に tsunagiai-mcp を置く`);
  const list = tag("ul");
  for (const line of [
    `「${environment}」のつなぎAIの設定フォルダに、GitHub Release から、このアプリと同じ版の tsunagiai-mcp を置きます`,
    `tsunagiai-mcp は、その PC でサーバーとして待ち受けます（ポート ${PORT}）`,
    "最初に、その PC の画面でファイアウォールの「許可」を押してください",
    "同意は、設定の Orca タブで PC ごとに取り消せます",
  ])
    list.append(tag("li", "", line));
  const decline = tag("button", "text-btn", "やめる");
  decline.type = "button";
  const agree = tag("button", "text-btn primary", "同意する");
  agree.type = "button";
  const actions = tag("div", "formation-new-actions");
  actions.append(decline, agree);
  pop.append(tag("h3", "", `「${environment}」に tsunagiai-mcp を置きますか？`), list, actions);

  return new Promise((resolve) => {
    let done = false;
    const settle = (answer: boolean) => {
      if (done) return;
      done = true;
      watch.disconnect();
      resolve(answer);
    };
    // Any way the dialog leaves the page is a decline (Escape and a press elsewhere close it without a button).
    const watch = new MutationObserver(() => {
      if (!pop.isConnected) settle(false);
    });
    watch.observe(document.body, { childList: true });
    decline.onclick = () => {
      closeMenu();
      settle(false);
    };
    let busy = false;
    agree.onclick = async () => {
      if (busy) return;
      busy = true;
      agree.disabled = decline.disabled = true;
      try {
        await invoke("formation_consent", { environment });
        if (pop.isConnected) closeMenu();
        settle(true);
      } catch (e) {
        // The reason is shown, and the dialog stays for another try.
        showError(e);
        busy = false;
        agree.disabled = decline.disabled = false;
      }
    };
    showMenu(anchor, pop);
    decline.focus();
  });
}

// Resolves true when the PC of `environment` has the owner's consent, asking for it in a dialog under `anchor` when it has none. This Mac needs none. False when the owner declines, and when the consents cannot be read (their words are shown).
export async function ensureConsent(anchor: Element, environment: string): Promise<boolean> {
  if (environment === LOCAL) return true;
  try {
    if (await agreed(environment)) return true;
  } catch (e) {
    showError(e);
    return false;
  }
  return openConsentDialog(anchor, environment);
}
