// A-36 (#731): the fields of a screen that Claude Code reads and writes through tsunagiai-mcp, and the changes it is told of.
// A screen registers a target (a name that Rust lists in screen_bridge.rs, and the fields it holds); Rust asks it by the event "screen-bridge-ask" and takes the answer from the command screen_bridge_answer.
// A write is taken back by the screen's own button: it keeps what its fields held before each write itself, because only the screen knows when a change of the owner's makes the way back unusable.
import type { ScreenAnswer } from "./bindings/ScreenAnswer";
import type { ScreenAsk } from "./bindings/ScreenAsk";
import { logError } from "./error-card.js";
import { invoke } from "./ipc.js";

export type Fields = Record<string, string>;

export interface DraftTarget {
  // The names of the fields a write may name; a read answers each of them (a field that is only read answers it too, and its write is refused by `write`).
  names: readonly string[];
  // False while the screen is not shown: a read, a write and a post are refused then.
  isOpen(): boolean;
  // Every field the screen holds now, by name.
  read(): Fields | Promise<Fields>;
  // Puts the texts into the named fields, which are the screen's own fields only; it saves and sends nothing. A refusal is a thrown error with a Japanese message.
  write(fields: Fields): void | Promise<void>;
  // Does what the screen's own "投稿" button does, and answers what happened as fields (`state`); a screen without it refuses a post. A refusal is a thrown error with a Japanese message.
  post?(): Fields | Promise<Fields>;
}

const targets = new Map<string, DraftTarget>();
const changeListeners = new Map<string, Set<() => void>>();

export function registerDraftTarget(name: string, target: DraftTarget) {
  targets.set(name, target);
}

// Calls `run` when Rust tells that `what` changed (for example "todo"), so the screen reads its list again.
export function onScreenChanged(what: string, run: () => void) {
  const listeners = changeListeners.get(what) ?? new Set();
  listeners.add(run);
  changeListeners.set(what, listeners);
}

const failed = (error: string): ScreenAnswer => ({ ok: false, error });

async function answerOf(ask: ScreenAsk): Promise<ScreenAnswer> {
  const target = targets.get(ask.target);
  if (!target) return failed(`${ask.target} の画面はまだ使えません`);
  if (!target.isOpen()) return failed(`${ask.target} の画面が開いていません`);
  if (ask.op === "read") return { ok: true, fields: await target.read() };
  if (ask.op === "post") return target.post ? { ok: true, fields: await target.post() } : failed(`${ask.target} の画面は投稿できません`);
  const unknown = Object.keys(ask.fields).filter((name) => !target.names.includes(name));
  if (unknown.length) return failed(`欄 ${unknown.join("、")} はありません（${target.names.join("、")}）`);
  await target.write(ask.fields);
  return { ok: true };
}

export function initScreenBridge() {
  const { listen } = window.__TAURI__.event;
  listen<ScreenAsk>("screen-bridge-ask", ({ payload }) => {
    answerOf(payload)
      .catch((e) => failed(String(e instanceof Error ? e.message : e)))
      .then((answer) => invoke("screen_bridge_answer", { id: payload.id, answer }))
      .catch((e) => logError("screen-bridge", e));
  });
  listen<string>("screen-bridge-changed", ({ payload }) => {
    for (const run of changeListeners.get(payload) ?? []) {
      try {
        run();
      } catch (e) {
        logError("screen-bridge", e);
      }
    }
  });
}
