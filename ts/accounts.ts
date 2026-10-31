// The sidebar's accounts: their avatars, the popup of an account (or of Claude), logging in and removing an account.
import type { Claude } from "./bindings/Claude";
import { calendarNeedsLogin, loadCalendar, resetCalendar } from "./calendar.js";
import { getClaude } from "./claude.js";
import { $, el, tag } from "./dom.js";
import { avatarColor, initials } from "./format.js";
import { CLAUDE_SVG } from "./icons.js";
import { forgetRemoved, historyIds, load } from "./inbox.js";
import { rows, updateBadge } from "./inbox-rows.js";
import { invoke } from "./ipc.js";
import { currentScreen, setScreen } from "./nav.js";
import { goBack, opened } from "./thread.js";
import { show, showError } from "./view.js";

// Per account, what the last load could not do; the account popup reads it.
let inboxIssues: { needsLogin: string[]; failed: Record<string, string> } = { needsLogin: [], failed: {} };
// The account whose popup is open, or null.
let popupAccount: string | null = null;
// Whether the Claude avatar's popup is open (it is drawn in the same #account-popup).
let claudePopup = false;
// The account whose removal the popup is asking to confirm, or null.
let confirmingRemoval: string | null = null;
// What the popup shows now; it is redrawn only when this changes, so a sync does not drop a text selection.
let popupKey = "";

export const accountButtons = () => [...$("account-list").children] as HTMLElement[];

// Closes the popup if it is Claude's (Claude is no longer logged in).
export function closeClaudePopup() {
  if (claudePopup) closePopup();
}

// Whether the popup of an account or of Claude is open.
export const popupOpen = () => popupAccount !== null || claudePopup;

// Sidebar avatars of every account, a re-login row for each account that needs it, and an error row for each that failed to load.
export function renderAccounts({ accounts, needsLogin, failed }: { accounts: string[]; needsLogin: string[]; failed: Record<string, string> }) {
  inboxIssues = { needsLogin, failed };
  $<HTMLButtonElement>("nav-calendar").disabled = accounts.length === 0;
  $("account-list").replaceChildren(
    ...accounts.map((a) => {
      const avatar = document.createElement("button");
      avatar.className = "avatar account-btn";
      avatar.dataset.account = a;
      avatar.textContent = initials(a);
      avatar.style.background = avatarColor(a);
      avatar.setAttribute("aria-label", a);
      avatar.setAttribute("aria-haspopup", "dialog");
      avatar.setAttribute("aria-controls", "account-popup");
      avatar.setAttribute("aria-expanded", String(a === popupAccount));
      avatar.onclick = () => togglePopup(a);
      return avatar;
    }),
  );
  refreshPopup();
  $("relogin").replaceChildren(
    ...needsLogin.map((a) => {
      const div = document.createElement("div");
      const button = document.createElement("button");
      button.textContent = "再ログイン";
      button.onclick = () => addAccount(a, button);
      div.append(`${a} は再ログインが必要です`, button);
      return div;
    }),
    ...Object.entries(failed).map(([a, message]) => {
      const div = document.createElement("div");
      div.textContent = `${a} の読み込みに失敗しました: ${message}`;
      return div;
    }),
  );
}

export function closePopup() {
  popupAccount = null;
  claudePopup = false;
  confirmingRemoval = null;
  $("account-popup").hidden = true;
  for (const b of accountButtons()) b.setAttribute("aria-expanded", "false");
  $("claude-btn").setAttribute("aria-expanded", "false");
}

function togglePopup(account: string) {
  if (popupAccount === account) return closePopup();
  popupAccount = account;
  claudePopup = false;
  confirmingRemoval = null;
  popupKey = "";
  $("account-popup").hidden = false;
  for (const b of accountButtons()) b.setAttribute("aria-expanded", String(b.dataset.account === account));
  $("claude-btn").setAttribute("aria-expanded", "false");
  refreshPopup();
}

// Puts the popup right of the sidebar at its avatar's height, inside the window.
function placePopup(button: HTMLElement) {
  const popup = $("account-popup");
  popup.style.left = `${$("sidebar").getBoundingClientRect().right + 8}px`;
  popup.style.top = `${Math.max(8, Math.min(button.getBoundingClientRect().top, innerHeight - popup.offsetHeight - 8))}px`;
}

// Claude's popup: who is logged in and the plan. Nothing to change here; the settings hold the rest.
function toggleClaudePopup() {
  if (claudePopup) return closePopup();
  popupAccount = null;
  confirmingRemoval = null;
  claudePopup = true;
  for (const b of accountButtons()) b.setAttribute("aria-expanded", "false");
  $("claude-btn").setAttribute("aria-expanded", "true");
  // The button is only shown while Claude is logged in.
  const claude = getClaude() as Extract<Claude, { state: "ready" }>;
  const avatar = el("avatar claude");
  avatar.innerHTML = CLAUDE_SVG;
  const open = tag("button", "text-btn", "設定を開く");
  open.onclick = () => {
    closePopup();
    setScreen("settings");
  };
  $("account-popup").replaceChildren(
    avatar,
    el("popup-email", claude.email),
    el("popup-plan", claude.plan ? `Claude ・ ${claude.plan} プラン` : "Claude"),
    tag("span", "status ok", "ログイン中"),
    open,
  );
  $("account-popup").hidden = false;
  placePopup($("claude-btn"));
}

// Redraws the open popup from the latest state and puts it right of the sidebar at its avatar's height, inside the window.
// The avatars are rebuilt on every render, so the popup finds its avatar again by the account.
export function refreshPopup() {
  if (claudePopup) return placePopup($("claude-btn"));
  if (popupAccount === null) return;
  const a = popupAccount;
  const button = accountButtons().find((b) => b.dataset.account === a);
  if (!button) return closePopup();
  const popup = $("account-popup");
  const lines: string[] = [];
  if (a in inboxIssues.failed) lines.push(`受信トレイの読み込みに失敗しました: ${inboxIssues.failed[a]}`);
  if (inboxIssues.needsLogin.includes(a)) lines.push("再ログインが必要です");
  if (calendarNeedsLogin(a)) lines.push("カレンダーの再ログインが必要です");
  const relogin = lines.some((l) => l.includes("再ログイン"));
  const unread = [...rows.values()].filter((r) => r.t.account === a && r.t.unread && r.li.isConnected).length;
  const confirming = confirmingRemoval === a;
  const key = JSON.stringify([a, lines, relogin, unread, confirming]);
  if (key !== popupKey) {
    popupKey = key;
    const hadFocus = popup.contains(document.activeElement);
    const avatar = el("avatar", initials(a));
    avatar.style.background = avatarColor(a);
    const textButton = (text: string, onclick: (b: HTMLButtonElement) => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.onclick = () => onclick(b);
      return b;
    };
    if (confirming) {
      const cancel = textButton("キャンセル", () => {
        confirmingRemoval = null;
        refreshPopup();
      });
      const remove = textButton("削除", (b) => removeAccount(a, b));
      remove.className = "danger";
      const actions = el("popup-actions");
      actions.append(remove, cancel);
      popup.replaceChildren(avatar, el("popup-email", a), el("popup-status", `${a} を cookapps から削除します。Gmail のメールは消えません。`), actions);
      cancel.focus();
    } else {
      popup.replaceChildren(avatar, el("popup-email", a), ...lines.map((l) => el("popup-status", l)), el("popup-unread", `未読 ${unread} 件`));
      if (relogin) popup.append(textButton("再ログイン", (b) => addAccount(a, b)));
      popup.append(
        textButton("このアカウントを削除", () => {
          confirmingRemoval = a;
          refreshPopup();
        }),
      );
      if (hadFocus) button.focus();
    }
  }
  placePopup(button);
}

// Logs in (the account chosen in the browser, or `hint` preselected) and reloads the list.
export async function addAccount(hint: string | null, button: HTMLButtonElement) {
  $("error").hidden = true;
  button.disabled = true;
  try {
    await invoke("login", { loginHint: hint });
    // The accounts changed: weeks kept so far and the calendar lists behind them are stale.
    // The login may have fixed the calendar too; the popup must not keep the old state until the calendar is opened.
    resetCalendar(false);
    await load();
    if (currentScreen() === "calendar") await loadCalendar();
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
}

// Removes the account in the backend (revokes Google's grant, deletes its token), then drops what the screen kept of it.
async function removeAccount(account: string, button: HTMLButtonElement) {
  $("error").hidden = true;
  button.disabled = true;
  try {
    await invoke("remove_account", { account });
  } catch (e) {
    confirmingRemoval = null;
    popupKey = "";
    refreshPopup();
    return showError(e);
  }
  closePopup();
  for (const [key, r] of rows) {
    if (r.t.account !== account) continue;
    r.li.remove();
    rows.delete(key);
  }
  historyIds.delete(account);
  forgetRemoved(account);
  // An open thread of this account cannot be acted on any more.
  if (!$("thread").hidden && opened.current?.account === account) goBack();
  resetCalendar(true);
  updateBadge();
  await load();
  if (currentScreen() !== "calendar") return;
  // With no account left there is no calendar to show: back to the mail screen, which shows the login.
  if (accountButtons().length === 0) {
    setScreen("mail");
    show("login");
  } else {
    await loadCalendar();
  }
}

export function initAccounts() {
  $("claude-btn").onclick = toggleClaudePopup;
  // Another avatar or the popup handles its own click.
  document.addEventListener("pointerdown", (e) => {
    if ((popupAccount !== null || claudePopup) && !(e.target as Element).closest("#account-popup, .account-btn")) closePopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || (popupAccount === null && !claudePopup)) return;
    const inside = $("account-popup").contains(document.activeElement);
    const button = claudePopup ? $("claude-btn") : accountButtons().find((b) => b.dataset.account === popupAccount);
    closePopup();
    if (inside) button?.focus();
  });
  window.addEventListener("resize", refreshPopup);
  // The unread count follows every change of the list: load, sync, read toggle, removal.
  new MutationObserver(refreshPopup).observe($("threads"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  $("login-button").onclick = () => addAccount(null, $<HTMLButtonElement>("login-button"));
  $("add-account").onclick = () => addAccount(null, $<HTMLButtonElement>("add-account"));
}
