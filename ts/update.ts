// The sidebar's update button: shown only while a newer version is out; pressing it installs that version and restarts the app.
import { $ } from "./dom.js";
import { invoke } from "./ipc.js";
import { showError } from "./view.js";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

async function check() {
  try {
    const update = await invoke("check_update");
    const button = $("update-btn");
    button.hidden = update === null;
    if (update) button.setAttribute("aria-label", `v${update.version} に更新`);
  } catch {
    // Not shown: offline or no release yet is no reason to bother the user. The backend logs it.
  }
}

export function initUpdate() {
  const button = $<HTMLButtonElement>("update-btn");
  button.onclick = async () => {
    button.disabled = true;
    try {
      await invoke("install_update");
    } catch (e) {
      showError(e);
    }
    button.disabled = false;
    await check();
  };
  check();
  setInterval(check, CHECK_EVERY_MS);
}
