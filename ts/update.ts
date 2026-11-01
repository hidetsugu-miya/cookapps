// The updater: the sidebar's update button, a dot on the settings button, and the settings card with the running version and the way to update.
// Manual: a newer version shows the button, and pressing it replaces the app and restarts it.
// Auto: a newer version is replaced in the background; the button then restarts the app (never by itself, so no screen in use is lost).
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
// The version whose background replacement failed: it is not downloaded again every few minutes; the update button still offers it.
let autoFailed: string | null = null;

function status(): [string, string] {
  if (!info?.updatable) return ["off", "対応していません"];
  if (checking) return ["off", "確認中"];
  if (failed) return ["off", "確認できません"];
  if (!update) return ["ok", "最新"];
  return ["warn", update.installed ? `再起動で v${update.version} になります` : `v${update.version} があります`];
}

function render() {
  if (!info) return;
  const button = $("update-btn");
  button.hidden = update === null;
  if (update) button.setAttribute("aria-label", update.installed ? `再起動して v${update.version} にする` : `v${update.version} に更新`);
  $("nav-settings").querySelector<HTMLElement>(".nav-dot")!.hidden = update === null;
  $("nav-settings").setAttribute("aria-label", update ? `設定（v${update.version} があります）` : "設定");
  const modes = (["manual", "auto"] as const).map((m) => {
    const b = tag("button", "text-btn", m === "auto" ? "自動" : "手動");
    b.type = "button";
    b.setAttribute("aria-pressed", String(m === mode));
    b.onclick = () => setMode(m);
    return b;
  });
  $("update-items").replaceChildren(itemRow({ name: `v${info.version}`, meta: "現在の版", status: status(), actions: info.updatable ? modes : [] }));
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
      // The update button still offers the update by hand. The backend logs it.
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

export function initUpdate() {
  const button = $<HTMLButtonElement>("update-btn");
  button.onclick = async () => {
    if (!update) return;
    button.disabled = true;
    try {
      if (!update.installed) await invoke("install_update");
      await invoke("restart_app");
    } catch (e) {
      showError(e);
    }
    button.disabled = false;
    await check();
  };
  $("update-recheck").onclick = check;
  $("update-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "アップデートの使い方",
        [
          ["GitHub Releases を、起動時と 5 分ごとに確認します（「今すぐ確認」でもできます）"],
          ["手動: 新しい版があるとサイドメニューに更新ボタンが出ます。押すと入れ替えて、再起動します"],
          ["自動: 新しい版を裏で入れ替えます。再起動は自動ではしません。サイドメニューの更新ボタンを押すと再起動します"],
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
