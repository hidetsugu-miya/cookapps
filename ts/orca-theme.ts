// The card of the terminal colors in the Orca tab of the settings screen (A-14): a theme for the light appearance and one for the dark, each with a swatch of its colors.
// Rust holds the themes (Orca's built-in ones) and the choice (`terminal-theme.json`); this module draws them and hands the colors of the choice to the terminals (`ts/orca-terminal.ts`), which take those of the system's appearance.
import type { TerminalTheme } from "./bindings/TerminalTheme";
import type { ThemeSelection } from "./bindings/ThemeSelection";
import { $, tag } from "./dom.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { invoke } from "./ipc.js";
import { applyTerminalTheme } from "./orca-terminal.js";
import { showError } from "./view.js";

type Slot = keyof ThemeSelection;

// The rows: the key of the choice, the name, and when it is used.
const SLOTS: [Slot, string, string][] = [
  ["light", "ライト", "システムの外観がライトのとき"],
  ["dark", "ダーク", "システムの外観がダークのとき"],
];

// The themes to choose from and the choice; empty and null until read.
let themes: TerminalTheme[] = [];
let selection: ThemeSelection | null = null;
// A save is on its way: the selects wait.
let saving = false;

const themeOf = (name: string) => themes.find((theme) => theme.name === name);

// The background of the theme with a sample of its text, and its 16 colors under it.
function swatch(theme: TerminalTheme) {
  const { colors } = theme;
  const box = tag("div", "theme-swatch");
  box.dataset.theme = theme.name;
  box.style.background = colors.background ?? "";
  box.style.color = colors.foreground ?? "";
  const dots = tag("span", "theme-dots");
  for (const { color } of colors.palette) {
    const dot = tag("i");
    dot.style.background = color;
    dots.append(dot);
  }
  box.append(tag("span", "", "Aa"), dots);
  return box;
}

function row(slot: Slot, label: string, when: string, chosen: string) {
  const select = tag("select", "theme-select");
  select.id = `terminal-theme-${slot}`;
  select.setAttribute("aria-label", `${label}のテーマ`);
  for (const { name } of themes) select.append(new Option(name, name, false, name === chosen));
  select.disabled = saving;
  select.onchange = () => choose(slot, select.value);
  const who = tag("div", "who");
  who.append(tag("div", "item-name", label), tag("div", "item-meta", when));
  const item = tag("div", "item");
  const theme = themeOf(chosen);
  item.append(...(theme ? [swatch(theme)] : []), who, select);
  return item;
}

function render() {
  $("terminal-theme-items").replaceChildren(...(selection === null ? [] : SLOTS.map(([slot, label, when]) => row(slot, label, when, selection![slot]))));
}

// Gives the terminals the colors of the choice for both appearances.
function applyChoice() {
  const light = selection && themeOf(selection.light)?.colors;
  const dark = selection && themeOf(selection.dark)?.colors;
  applyTerminalTheme(light && dark ? { light, dark } : null);
}

// Saves a theme for one appearance. The selects show the saved choice again when the save fails, and wait while it is on its way.
async function choose(slot: Slot, name: string) {
  if (saving || selection === null) return;
  saving = true;
  $("error").hidden = true;
  render();
  try {
    selection = await invoke("terminal_theme_set", { selection: { ...selection, [slot]: name } });
    applyChoice();
  } catch (e) {
    showError(e);
  } finally {
    saving = false;
    render();
    $(`terminal-theme-${slot}`).focus();
  }
}

export function initOrcaTheme() {
  render();
  $("terminal-theme-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "ターミナルの配色",
        [
          ["Orca 画面のターミナルの配色を、ライトとダークで別々に選びます。システムの外観に合わせて切り替わります（Orca の外観の設定には合わせません）"],
          ["選べるのは Orca の組み込みのテーマです。色は cookapps が持っています"],
          ["初めての選択は、この Mac の Orca の設定（", code("terminalThemeLight"), "、", code("terminalThemeDark"), "）から取ります。読めたときの 1 回だけです。Orca で足したテーマや、組み込みにないテーマのときは、ライトは Builtin Tango Light、ダークは Ghostty Default Style Dark になります"],
          ["ここで選んだテーマは、Ghostty から取り込んだ色より優先します。Ghostty のフォントとキーはそのまま使います"],
        ],
        "Orca の設定は読むだけで、書き換えません",
      ),
    );
  invoke("terminal_themes").then(
    (read) => {
      themes = read.themes;
      selection = read.selection;
      applyChoice();
      render();
    },
    (e) => showError(e),
  );
}
