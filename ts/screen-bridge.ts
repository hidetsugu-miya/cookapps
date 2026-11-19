// A-36 (#731): the fields of a screen that Claude Code reads and writes through tsunagiai-mcp, and the changes it is told of.
// A screen registers a target (a name that Rust lists in screen_bridge.rs, and the fields it holds); Rust asks it by the event "screen-bridge-ask" and takes the answer from the command screen_bridge_answer.
// A write keeps what the fields held before it, so that the screen's own button can take the write back (onUndoChange, canUndo, undoWrite); drawing that button is the screen's.
import type { ScreenAnswer } from "./bindings/ScreenAnswer";
import type { ScreenAsk } from "./bindings/ScreenAsk";
import { logError } from "./error-card.js";
import { invoke } from "./ipc.js";

export type Fields = Record<string, string>;

export interface DraftTarget {
  // False while the screen is not shown: a read and a write are refused then.
  isOpen(): boolean;
  // Every field the screen holds now, by name.
  read(): Fields | Promise<Fields>;
  // Puts the texts into the named fields, which are the screen's own fields only; it saves and sends nothing.
  write(fields: Fields): void | Promise<void>;
}

const targets = new Map<string, DraftTarget>();
// target -> the texts the fields of the last write held before it.
const undos = new Map<string, Fields>();
const undoListeners = new Map<string, Set<(can: boolean) => void>>();
const changeListeners = new Map<string, Set<() => void>>();

export function registerDraftTarget(name: string, target: DraftTarget) {
  targets.set(name, target);
}

export const canUndo = (name: string) => undos.has(name);

// Calls `run` with whether the last write of the target can be taken back, each time that changes.
export function onUndoChange(name: string, run: (can: boolean) => void) {
  const listeners = undoListeners.get(name) ?? new Set();
  listeners.add(run);
  undoListeners.set(name, listeners);
}

function setUndo(name: string, before: Fields | null) {
  if (before) undos.set(name, before);
  else undos.delete(name);
  for (const run of undoListeners.get(name) ?? []) run(before !== null);
}

// Puts the fields of the last write back to what they held before it, and forgets it.
export async function undoWrite(name: string) {
  const before = undos.get(name);
  const target = targets.get(name);
  if (!before || !target) return;
  await target.write(before);
  setUndo(name, null);
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
  const held = await target.read();
  if (ask.op === "read") return { ok: true, fields: held };
  const unknown = Object.keys(ask.fields).filter((name) => !(name in held));
  if (unknown.length) return failed(`欄 ${unknown.join("、")} はありません（${Object.keys(held).join("、")}）`);
  const before: Fields = {};
  for (const name of Object.keys(ask.fields)) before[name] = held[name];
  await target.write(ask.fields);
  setUndo(ask.target, before);
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
