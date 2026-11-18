// The failures (A-28): every one goes to the app's log, and a failure of something the user did (and a login that must be done again) also shows as a white card at the bottom right.
// A card stays until its × is pressed, and a new one is put above the others. A failure of a sync or a read goes to the log only (`logError`).
import { $, tag } from "./dom.js";
import { CLOSE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { setScreen } from "./nav.js";

// The text of a failure as the log and the card hold it: Rust's errors arrive as text, any other is made one.
const textOf = (e: unknown) => String(e);

// Writes a failure to the log. `source` names where it happened (the module). A log that cannot be written is left alone: it must not make another failure.
export function logError(source: string, e: unknown) {
  invoke("log_write", { level: "error", source, message: textOf(e) }).catch(() => {});
}

function card(text: string, extra: (HTMLElement | null)[]) {
  const root = tag("div", "error-card");
  root.setAttribute("role", "alert");
  const close = tag("button", "icon-btn error-card-close");
  close.type = "button";
  close.setAttribute("aria-label", "閉じる");
  close.innerHTML = CLOSE_SVG;
  const body = tag("div", "error-card-body");
  body.append(tag("div", "error-card-text", text), ...extra.filter((x) => x !== null));
  root.append(body, close);
  $("error-cards").prepend(root);
  return { root, close };
}

// Writes a failure of something the user did to the log and shows it as a card, with the button that opens the log tab of the settings.
// The same text that a card still shows is not drawn twice (the log keeps every one).
export function showFailure(source: string, e: unknown) {
  logError(source, e);
  const text = textOf(e);
  if ([...document.querySelectorAll(".error-card-text")].some((n) => n.textContent === text)) return;
  const log = tag("button", "text-btn error-card-log", "ログを見る");
  log.type = "button";
  const { root, close } = card(text, [log]);
  close.onclick = () => root.remove();
  log.onclick = () => setScreen("settings", "log");
}

// The cards that ask for a login again, by "{scope}:{account}": the entry is null once its × was pressed, so the card is not made again until the account has logged in and needs it again.
const logins = new Map<string, HTMLElement | null>();

// Takes the cards of `scope` off, those of `account` only when it is given: an account has logged in again or is gone, and the screen that made the card may not be the one shown. A card that is still needed is made again by the next read of that screen.
export function clearRelogin(scope: string, account: string | null = null) {
  for (const [key, node] of [...logins]) {
    if (!key.startsWith(`${scope}:`) || (account !== null && key !== `${scope}:${account}`)) continue;
    node?.remove();
    logins.delete(key);
  }
}

// Makes the cards of the accounts of `scope` that must log in again, with the button that logs them in (`run`). A card of an account that no longer needs it goes.
export function setRelogin(scope: string, accounts: string[], text: (account: string) => string, run: (account: string, button: HTMLButtonElement) => void) {
  for (const [key, node] of [...logins]) {
    if (!key.startsWith(`${scope}:`) || accounts.includes(key.slice(scope.length + 1))) continue;
    node?.remove();
    logins.delete(key);
  }
  for (const account of accounts) {
    const key = `${scope}:${account}`;
    if (logins.has(key)) continue;
    const button = tag("button", "text-btn error-card-login", "再ログイン");
    button.type = "button";
    button.onclick = () => run(account, button);
    const { root, close } = card(text(account), [button]);
    close.onclick = () => {
      root.remove();
      logins.set(key, null);
    };
    logins.set(key, root);
  }
}
