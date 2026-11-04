// The updater: a popup at the bottom right, a dot on the settings button and on the update tab, and the settings card with the running version and the way to update.
// Manual: a newer version shows the popup, and its main button replaces the app and restarts it.
// Auto: a newer version is replaced in the background; the popup then asks for a restart (never by itself, so no screen in use is lost).
// "あとで" closes the popup for that version until the app quits; a newer version shows it again. The settings card keeps the same operation as a button.
import type { AppInfo } from "./bindings/AppInfo";
import type { UpdateInfo } from "./bindings/UpdateInfo";
import type { UpdateMode } from "./bindings/UpdateMode";
import { $, tag } from "./dom.js";
import { hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { itemRow } from "./settings.js";
import { showError } from "./view.js";

const CHECK_EVERY_MS = 5 * 60 * 1000;

// null until the backend has answered.
let info: AppInfo | null = null;
let mode: UpdateMode = "auto";
// The newer version, once found; `installed`: the app is already replaced and only a restart is left.
let update: UpdateInfo | null = null;
let checking = false;
let failed = false;
// When the last check started; a window shown again checks when it is older than CHECK_EVERY_MS.
let lastCheck = 0;
// The version whose background replacement failed: it is not downloaded again every few minutes; the popup still offers it.
let autoFailed: string | null = null;
// The version whose popup was closed with "あとで" (memory only).
let dismissed: string | null = null;
// The replacement and restart are on their way: the buttons wait.
let applying = false;

function status(): [string, string] {
  if (!info?.updatable) return ["off", "対応していません"];
  if (checking) return ["off", "確認中"];
  if (failed) return ["off", "確認できません"];
  if (!update) return ["ok", "最新"];
  return ["warn", update.installed ? `再起動で v${update.version} になります` : `v${update.version} があります`];
}

const goLabel = (u: UpdateInfo) => (u.installed ? "再起動" : "更新して再起動");

// Draws the popup. The toast stacks above it while it shows (--toast-bottom); the popup takes no focus.
function renderPopup() {
  const pop = $("update-pop");
  pop.hidden = update === null || update.version === dismissed;
  if (update) {
    $("update-pop-title").textContent = update.installed ? "新しい版の準備ができました" : `v${update.version} があります`;
    $("update-pop-text").textContent = update.installed ? `再起動すると v${update.version} になります` : "入れ替えて再起動します";
    const go = $<HTMLButtonElement>("update-go");
    go.textContent = goLabel(update);
    go.disabled = applying;
  }
  const root = document.documentElement.style;
  if (pop.hidden) root.removeProperty("--toast-bottom");
  else root.setProperty("--toast-bottom", `${24 + pop.offsetHeight + 8}px`);
}

function render() {
  if (!info) return;
  renderPopup();
  $("nav-settings").querySelector<HTMLElement>(".nav-dot")!.hidden = update === null;
  $("settings-tab-update").querySelector<HTMLElement>(".tab-dot")!.hidden = update === null;
  $("nav-settings").setAttribute("aria-label", update ? `設定（v${update.version} があります）` : "設定");
  const modes = (["manual", "auto"] as const).map((m) => {
    const b = tag("button", "text-btn", m === "auto" ? "自動" : "手動");
    b.type = "button";
    b.setAttribute("aria-pressed", String(m === mode));
    b.onclick = () => setMode(m);
    return b;
  });
  const actions = [...modes];
  if (update) {
    const go = tag("button", "text-btn primary", goLabel(update));
    go.type = "button";
    go.disabled = applying;
    go.onclick = applyUpdate;
    actions.push(go);
  }
  $("update-items").replaceChildren(itemRow({ name: `v${info.version}`, meta: "現在の版", status: status(), actions: info.updatable ? actions : [] }));
  $<HTMLButtonElement>("update-recheck").disabled = checking || !info.updatable;
}

async function check() {
  if (checking || !info?.updatable) return;
  checking = true;
  failed = false;
  lastCheck = Date.now();
  render();
  try {
    update = await invoke("check_update");
  } catch {
    // Offline or no release yet is no reason to bother the user: the card says so, the sidebar stays as it was. The backend logs it.
    failed = true;
  }
  if (!failed && mode === "auto" && update && !update.installed && update.version !== autoFailed) {
    try {
      await invoke("install_update");
      update.installed = true;
    } catch {
      // The popup still offers the update by hand. The backend logs it.
      autoFailed = update.version;
    }
  }
  checking = false;
  render();
}

async function setMode(next: UpdateMode) {
  if (next === mode) return;
  try {
    await invoke("set_update_mode", { mode: next });
  } catch (e) {
    return showError(e);
  }
  mode = next;
  render();
  // An update found while the mode was manual is replaced now.
  if (next === "auto") await check();
}

// Replaces the app if that is not done yet, then restarts it. A failure is shown and the popup stays.
async function applyUpdate() {
  if (!update || applying) return;
  applying = true;
  render();
  try {
    if (!update.installed) await invoke("install_update");
    await invoke("restart_app");
  } catch (e) {
    showError(e);
  }
  applying = false;
  render();
  await check();
}

export function initUpdate() {
  $("update-go").onclick = applyUpdate;
  $("update-later").onclick = () => {
    dismissed = update?.version ?? null;
    render();
  };
  $("update-recheck").onclick = check;
  $("update-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "アップデートの使い方",
        [
          ["GitHub Releases を、起動時と 5 分ごとに確認します（「今すぐ確認」でもできます）"],
          ["手動: 新しい版があると右下にポップアップが出ます。「更新して再起動」を押すと入れ替えて、再起動します"],
          ["自動: 新しい版を裏で入れ替えます。再起動は自動ではしません。右下のポップアップの「再起動」を押すと再起動します"],
          ["ポップアップを「あとで」で閉じると、同じ版では、アプリを終了するまで出ません。このタブの同じボタンでは更新できます"],
        ],
        "署名を確かめてから入れ替えます。対象は Apple Silicon の macOS だけです",
      ),
    );
  (async () => {
    try {
      [info, mode] = await Promise.all([invoke("app_info"), invoke("update_mode")]);
    } catch (e) {
      return showError(e);
    }
    render();
    await check();
    // Not while the window is hidden; when it is shown again, the check runs if the last one is old.
    setInterval(() => !document.hidden && check(), CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", () => !document.hidden && Date.now() - lastCheck >= CHECK_EVERY_MS && check());
  })();
}
