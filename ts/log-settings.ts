// The Log tab of the settings screen (A-3, A-28): the lines of the app's log, the newest first, as a table of the time, the weight, the place and the text.
// Rust keeps the log (`ts/ipc.ts`: `log_read`, `log_open_folder`); this module draws the lines and filters them by weight, and copies what is shown.
import type { LogEntry } from "./bindings/LogEntry";
import type { LogLevel } from "./bindings/LogLevel";
import { $, tag } from "./dom.js";
import { logTime } from "./format.js";
import { invoke } from "./ipc.js";
import { logError, showFailure } from "./error-card.js";
import { copyText } from "./view.js";

type Filter = "all" | "error" | "warn";

const LEVEL_LABELS: Record<LogLevel, string> = { error: "エラー", warn: "警告", info: "情報" };
const FILTERS: Filter[] = ["all", "error", "warn"];
const COLUMNS = ["時刻", "重さ", "場所", "内容"];

// The lines as last read, and the filter chosen.
let entries: LogEntry[] = [];
let filter: Filter = "all";
// Only the latest read may draw the table.
let readSeq = 0;

// The lines the filter lets through: every one, or the ones of that weight.
const shown = () => (filter === "all" ? entries : entries.filter((e) => e.level === filter));

function row(e: LogEntry) {
  const level = tag("span", `log-level ${e.level}`, LEVEL_LABELS[e.level]);
  const cells = [tag("td", "log-time", logTime(e.time)), tag("td"), tag("td", "", e.source), tag("td", "", e.message)];
  cells[1]!.append(level);
  const tr = tag("tr", `log-row ${e.level}`);
  tr.append(...cells);
  return tr;
}

function draw() {
  const lines = shown();
  for (const f of FILTERS) $(`log-filter-${f}`).setAttribute("aria-pressed", String(f === filter));
  $<HTMLButtonElement>("log-copy").disabled = lines.length === 0;
  if (lines.length === 0) return $("log-body").replaceChildren(tag("div", "card-empty", "ログはありません"));
  const head = tag("tr");
  head.append(...COLUMNS.map((c) => tag("th", "", c)));
  const table = tag("table", "log-table");
  table.append(tag("thead"), tag("tbody"));
  table.tHead!.append(head);
  table.tBodies[0]!.append(...lines.map(row));
  $("log-body").replaceChildren(table);
}

// Reads the log again; called each time the tab is shown.
export async function showLogTab() {
  const seq = ++readSeq;
  let read: LogEntry[];
  try {
    read = await invoke("log_read");
  } catch (e) {
    return logError("log-settings", e);
  }
  if (seq !== readSeq) return;
  entries = read;
  draw();
}

export function initLogSettings() {
  for (const f of FILTERS)
    $(`log-filter-${f}`).onclick = () => {
      filter = f;
      draw();
    };
  // The lines on the screen, one a line: the time as the file holds it, the weight, the place and the text, apart by a tab.
  $("log-copy").onclick = () => {
    void copyText(shown().map((e) => [e.time, LEVEL_LABELS[e.level], e.source, e.message].join("\t")).join("\n"), "ログをコピーしました");
  };
  $("log-open-folder").onclick = async () => {
    try {
      await invoke("log_open_folder");
    } catch (e) {
      showFailure("log-settings", e);
    }
  };
  draw();
}
