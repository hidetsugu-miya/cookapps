// The card of the fonts in the Font tab of the settings screen (A-20): the family and the size of each place of the screens, and of the editor of Orca.
// Rust holds the choice (`font-settings.json`), brings every value into its range and knows the families on this Mac; this module draws the selects, and applies the choice at once:
// a CSS variable for each place of an HTML screen (`--ff-*` the family, `--fs-*` the size as a multiple of the text size 14 px; `src/style.css` reads them), the editor's variables, and the terminals (`ts/orca-terminal.ts`).
import type { FontArea } from "./bindings/FontArea";
import type { FontPick } from "./bindings/FontPick";
import type { FontSettings } from "./bindings/FontSettings";
import { $, tag } from "./dom.js";
import { hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { applyTerminalFont } from "./orca-terminal.js";
import { showError } from "./view.js";

// The rows: the area, the name of its screen, and the place on the screen.
const ROWS: [FontArea, string, string][] = [
  ["mail", "メール", "画面全体"],
  ["calendar", "カレンダー", "画面全体"],
  ["todoList", "Todo", "プロジェクト一覧"],
  ["todoWork", "Todo", "作業スペース"],
  ["slack", "Slack", "画面全体"],
  ["orcaList", "Orca", "プロジェクト一覧"],
  ["orcaWork", "Orca", "作業スペース（ターミナル）"],
  ["editor", "Orca", "エディタ"],
];

// The sizes to choose from, in pixels; a size Rust holds between them (12.5) is added to the select that holds it.
const SIZES = Array.from({ length: 25 }, (_, i) => i + 8);
// The text size of the screens: the size of a place is drawn as a multiple of it.
const TEXT_SIZE = 14;
// The families the app draws with when none is chosen (the editor's is monospace).
const EDITOR_FALLBACK = "ui-monospace, Menlo, monospace";

// The values of the family select: the app's own, Ghostty's (the work space of Orca only), or a family (the name after the prefix).
const OWN = "own";
const GHOSTTY = "ghostty";
const FAMILY = "family:";

// The choice and the families on this Mac; null and empty until read.
let settings: FontSettings | null = null;
let families: string[] = [];
// A save is on its way: the selects wait.
let saving = false;

const kebab = (area: FontArea) => area.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const idOf = (area: FontArea, part: "family" | "size") => `font-${kebab(area)}-${part}`;

// Applies the choice: the variables of the places, those of the editor, and the font of the terminals.
function apply(next: FontSettings) {
  const root = document.documentElement.style;
  const set = (name: string, value: string | null) => (value === null ? root.removeProperty(name) : root.setProperty(name, value));
  for (const [area] of ROWS) {
    const pick = next[area];
    if (area === "editor") {
      set("--editor-family", pick.family && `${JSON.stringify(pick.family)}, ${EDITOR_FALLBACK}`);
      set("--editor-size", `${pick.size}px`);
    } else if (area === "orcaWork") {
      applyTerminalFont(pick.ghostty ? null : { family: pick.family, size: pick.size });
    } else {
      const name = kebab(area);
      set(`--ff-${name}`, pick.family && `${JSON.stringify(pick.family)}, var(--ff-base)`);
      set(`--fs-${name}`, pick.size === TEXT_SIZE ? null : String(Math.round((pick.size / TEXT_SIZE) * 10000) / 10000));
    }
  }
}

function familySelect(area: FontArea, pick: FontPick) {
  const select = tag("select", "font-family");
  select.id = idOf(area, "family");
  const name = ROWS.find(([a]) => a === area)!;
  select.setAttribute("aria-label", `${name[1]}の${name[2]}の書体`);
  select.append(new Option("システム標準", OWN));
  if (area === "orcaWork") select.append(new Option("Ghostty の設定に従う", GHOSTTY));
  for (const family of families) select.append(new Option(family, FAMILY + family));
  // A family this Mac no longer has stays in the select, so the choice is not changed by drawing it.
  if (pick.family && !families.includes(pick.family)) select.append(new Option(`${pick.family}（この Mac にありません）`, FAMILY + pick.family));
  select.value = pick.ghostty ? GHOSTTY : pick.family ? FAMILY + pick.family : OWN;
  select.disabled = saving;
  select.onchange = () => choose(area, select.value, pick.size);
  return select;
}

function sizeSelect(area: FontArea, pick: FontPick) {
  const select = tag("select", "font-size");
  select.id = idOf(area, "size");
  const name = ROWS.find(([a]) => a === area)!;
  select.setAttribute("aria-label", `${name[1]}の${name[2]}の大きさ`);
  const sizes = SIZES.includes(pick.size) ? SIZES : [...SIZES, pick.size].sort((a, b) => a - b);
  for (const size of sizes) select.append(new Option(`${size} px`, String(size)));
  select.value = String(pick.size);
  // The terminals follow Ghostty's size while the family does.
  select.disabled = saving || pick.ghostty;
  select.onchange = () => choose(area, familyValue(area, pick), Number(select.value));
  return select;
}

// The value of the family select that shows `pick`.
const familyValue = (area: FontArea, pick: FontPick) => (pick.ghostty && area === "orcaWork" ? GHOSTTY : pick.family ? FAMILY + pick.family : OWN);

function row([area, screen, place]: (typeof ROWS)[number]) {
  const pick = settings![area];
  const who = tag("div", "who");
  who.append(tag("div", "item-name", screen), tag("div", "item-meta", place));
  const item = tag("div", "item");
  item.append(who, familySelect(area, pick), sizeSelect(area, pick));
  return item;
}

function render() {
  $("font-items").replaceChildren(...(settings === null ? [] : ROWS.map(row)));
}

// Saves the font of one place. The selects show the saved choice again when the save fails, and wait while it is on its way; the one that was changed has the focus again.
async function choose(area: FontArea, familyChoice: string, size: number) {
  if (saving || settings === null) return;
  const held = settings[area];
  const ghostty = familyChoice === GHOSTTY;
  const family = ghostty ? held.family : familyChoice.startsWith(FAMILY) ? familyChoice.slice(FAMILY.length) : null;
  const focusId = idOf(area, familyChoice === familyValue(area, held) ? "size" : "family");
  saving = true;
  $("error").hidden = true;
  render();
  try {
    settings = await invoke("font_settings_set", { area, family, size, ghostty });
    apply(settings);
  } catch (e) {
    showError(e);
  } finally {
    saving = false;
    render();
    $(focusId).focus();
  }
}

export function initFontSettings() {
  render();
  $("font-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "フォント",
        [
          ["画面ごとに、書体と文字の大きさを選びます。選ぶとすぐ画面に反映し、設定のフォルダに保存します"],
          ["メール、カレンダー、Slack は画面全体で 1 組です。Todo と Orca は、左のプロジェクト一覧と右の作業スペースを別々に選びます"],
          ["書体は、この Mac に入っているものから選びます。「システム標準」は、cookapps が初めから使う書体です"],
          ["大きさは 8 から 32 ピクセルです。標準は 14 ピクセルで、画面の文字は、選んだ大きさとの比で大きく、または小さくなります"],
          ["Orca の作業スペースは、ターミナルの書体と大きさです。「Ghostty の設定に従う」を選ぶと、取り込んだ Ghostty の書体と大きさを使います。大きさは選べません"],
          ["Orca のエディタは、ファイルを開いたときの文字の書体と大きさで、ターミナルとは別に選びます"],
        ],
        "書体の名前は、この Mac が持つ一覧だけを使います。外の書体は読み込みません",
      ),
    );
  // The choice is applied as soon as it is read, so the screens have it before the settings are opened.
  invoke("font_settings").then(
    (read) => {
      settings = read;
      apply(read);
      render();
    },
    (e) => showError(e),
  );
  invoke("font_families").then(
    (read) => {
      families = read;
      render();
    },
    (e) => showError(e),
  );
}
