// The card of the editor in the Orca tab of the settings screen (A-18): how long after the typing stops a file is saved. Rust holds the value (`editor-settings.json`) and the range it is brought into (`autosaveMin`, `autosaveMax`, `autosaveStep`);
// this module draws the field and the hint from what Rust answered, and hands the value to the editor (`ts/orca-editor.ts`).
import type { EditorSettings } from "./bindings/EditorSettings";
import { $, onEnter, tag } from "./dom.js";
import { hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { setAutosaveMs } from "./orca-editor.js";
import { showError } from "./view.js";

// What Rust answered last, null until read.
let settings: EditorSettings | null = null;
// A save is on its way: the field waits.
let saving = false;

function render() {
  const input = tag("input", "editor-ms");
  input.id = "editor-autosave";
  input.type = "number";
  input.setAttribute("aria-label", "自動保存までの時間（ミリ秒）");
  if (settings) {
    input.min = String(settings.autosaveMin);
    input.max = String(settings.autosaveMax);
    input.step = String(settings.autosaveStep);
    input.value = String(settings.autosaveMs);
  }
  input.disabled = settings === null || saving;
  input.onchange = () => commit(input);
  onEnter(input, () => commit(input));
  const who = tag("div", "who");
  who.append(tag("div", "item-name", "自動保存までの時間"));
  const item = tag("div", "item");
  item.append(who, input, tag("span", "item-meta", "ms"));
  $("editor-items").replaceChildren(item);
}

// Saves the value typed. A value that is not a number leaves the one held; Rust's answer is what the field shows after.
async function commit(input: HTMLInputElement) {
  const typed = input.valueAsNumber;
  if (saving || Number.isNaN(typed)) return render();
  saving = true;
  $("error").hidden = true;
  render();
  try {
    settings = await invoke("editor_settings_set", { autosaveMs: Math.round(typed) });
    setAutosaveMs(settings.autosaveMs);
  } catch (e) {
    showError(e);
  } finally {
    saving = false;
    render();
  }
}

export function initEditorSettings() {
  render();
  $("editor-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "エディタ",
        [
          ["Orca 画面でファイルを開くと、打つのが止まってからこの時間がたつと、自動で保存します"],
          ...(settings
            ? [["時間は ", `${settings.autosaveMin} から ${settings.autosaveMax} ミリ秒まで、${settings.autosaveStep} ミリ秒刻みです。範囲の外の値は、近いほうの端になります`]]
            : []),
          ["保存の前に、ディスクのファイルが開いたときのままかを Orca が確かめます。別のところで変わっていたときは、上書きしません"],
        ],
        "ファイルは Orca を通して読み書きします",
      ),
    );
  invoke("editor_settings").then(
    (read) => {
      settings = read;
      setAutosaveMs(read.autosaveMs);
      render();
    },
    (e) => showError(e),
  );
}
