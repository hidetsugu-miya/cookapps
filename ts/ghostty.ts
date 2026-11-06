// The card of Ghostty's settings in the Orca tab of the settings screen (A-13): the button that reads Ghostty's config into the terminals of the Orca screen, and what it took and left.
// This module holds the import last made (Rust keeps it in `ghostty-settings.json`) and hands its settings to the terminals (`ts/orca-terminal.ts`).
import type { GhosttyImport } from "./bindings/GhosttyImport";
import { $, tag } from "./dom.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { applyTerminalSettings } from "./orca-terminal.js";
import { itemRow } from "./settings.js";
import { showError } from "./view.js";

// The import held, null before the first one.
let current: GhosttyImport | null = null;
let importing = false;

// A list of entries under a heading; `reason` is shown beside an entry that has one.
function report(id: string, title: string, entries: { entry: string; reason?: string }[]) {
  const list = tag("ul");
  list.id = id;
  for (const { entry, reason } of entries) {
    const item = tag("li");
    item.append(code(entry));
    if (reason) item.append(tag("span", "ghostty-reason", reason));
    list.append(item);
  }
  const box = tag("div", "ghostty-report");
  box.append(tag("h3", "", `${title}（${entries.length}）`), ...(entries.length ? [list] : []));
  return box;
}

function render() {
  const nodes: HTMLElement[] = [];
  if (current === null) {
    nodes.push(itemRow({ name: "Ghostty の設定", meta: "まだ取り込んでいません", status: ["off", "未取り込み"] }));
  } else {
    const { imported, skipped, files } = current;
    nodes.push(
      itemRow({
        name: "Ghostty の設定",
        meta: [`読んだファイル: `, ...files.flatMap((file, i) => [...(i ? ["、"] : []), code(file)])],
        status: ["ok", "取り込み済み"],
      }),
      report("ghostty-imported", "取り込んだ項目", imported.map((entry) => ({ entry }))),
      report("ghostty-skipped", "取り込めなかった項目", skipped),
    );
  }
  $("ghostty-items").replaceChildren(...nodes);
  $<HTMLButtonElement>("ghostty-import").disabled = importing;
}

async function importConfig() {
  if (importing) return;
  importing = true;
  $("error").hidden = true;
  render();
  try {
    current = await invoke("ghostty_import");
    applyTerminalSettings(current.settings);
  } catch (e) {
    showError(e);
  } finally {
    importing = false;
    render();
  }
}

export function initGhostty() {
  render();
  $("ghostty-import").onclick = importConfig;
  $("ghostty-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "Ghostty の設定の取り込み",
        [
          ["Ghostty の設定ファイルを読んで、Orca 画面のターミナルに取り込みます。ファイルは ", code("~/.config/ghostty/"), " と ", code("~/Library/Application Support/com.mitchellh.ghostty/"), " の ", code("config.ghostty"), "、", code("config"), " の順に読み（Orca と同じ場所と順です）、後のファイルが前のものを上書きします"],
          ["取り込むのは、", code("font-family"), "、", code("font-size"), "、", code("font-thicken"), "、", code("theme"), "（", code("light:…,dark:…"), " も。macOS の外観に合わせます）、", code("background"), " などの色、", code("palette"), "、文字を送る ", code("keybind"), "（例 ", code("delete=text:\\x08"), "）です"],
          ["ほかの項目は「取り込めなかった項目」に理由とともに出ます。設定を変えたら、もう一度取り込みます"],
          ["Shift+Enter は、取り込まなくても改行になります（Claude Code の入力で送信しません）"],
        ],
        "設定ファイルは読むだけで、書き換えません",
      ),
    );
  invoke("ghostty_saved").then(
    (saved) => {
      // An import made while this was on its way is newer.
      if (current !== null) return;
      current = saved;
      applyTerminalSettings(saved?.settings ?? null);
      render();
    },
    (e) => showError(e),
  );
}
