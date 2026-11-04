// The terminals of the Orca screen (A-8): one xterm.js for each terminal tab, in `#orca-term`.
// A terminal of the app runs in a PTY in Rust (`terminal_open`): the bytes it prints arrive through a channel, what is typed goes to `terminal_write`, and the size to `terminal_resize`.
// A plain terminal of Orca is a mirror: Orca cannot stream its bytes to this app, so while its tab is shown the screen is read every second (`orca_terminal_read`) and drawn again,
// and the keys go to `orca_terminal_input`, batched and one send at a time. It has no colors, a full-screen program is only approximate, and its size is not sent.
// An instance lives while its tab exists and is only hidden when another tab shows. Nothing a terminal prints or is typed is kept or logged here.
import type { TerminalEvent } from "./bindings/TerminalEvent";
import { $ } from "./dom.js";
import { invoke, type TerminalTarget } from "./ipc.js";

const SCROLLBACK = 5000;
const MIRROR_MS = 1000;
// A send of typed keys carries at most this many characters (Rust takes 100,000).
const SEND_LIMIT = 50_000;
// The first frame of a mirror clears what the last one drew.
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
const ENDED = "\r\n[終了しました]\r\n";

interface Mirror {
  handle: string;
  environment: string | null;
  timer: number | null;
  last: string | null;
  reading: boolean;
  pending: string;
  sending: boolean;
}

interface Instance {
  term: XTerm;
  fit: { fit(): void };
  el: HTMLElement;
  // The id Rust gave a terminal of the app, null until `terminal_open` answers.
  rustId: string | null;
  mirror: Mirror | null;
  // Where a terminal of the app was last sized to, so that a size is sent only when it changed.
  size: { cols: number; rows: number };
  // Whether the process of a terminal of the app has ended: nothing is written to it then.
  ended: boolean;
}

const instances = new Map<string, Instance>();
// The tab whose terminal is shown, null when none is (an instance that is created later is shown only if it is this one).
let visibleId: string | null = null;
let onError: (e: unknown) => void = () => {};

const container = () => $("orca-term");

function newInstance(): Instance {
  const style = getComputedStyle(document.documentElement);
  const term = new Terminal({
    scrollback: SCROLLBACK,
    cursorBlink: true,
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 13,
    theme: { background: style.getPropertyValue("--term-bg").trim(), foreground: style.getPropertyValue("--term-fg").trim() },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.className = "orca-term-box";
  container().append(el);
  term.open(el);
  return { term, fit, el, rustId: null, mirror: null, size: { cols: term.cols, rows: term.rows }, ended: false };
}

// Fits the shown terminal to the pane; its `onResize` tells Rust.
function fitVisible() {
  const instance = visibleId === null ? undefined : instances.get(visibleId);
  if (instance && !container().hidden) instance.fit.fit();
}

// ---- the mirror ----

async function readFrame(instance: Instance) {
  const mirror = instance.mirror;
  if (!mirror || mirror.reading) return;
  mirror.reading = true;
  try {
    const lines = await invoke("orca_terminal_read", { handle: mirror.handle, environment: mirror.environment });
    const text = lines.join("\r\n");
    if (text !== mirror.last) {
      mirror.last = text;
      instance.term.write(CLEAR + text);
    }
  } catch {
    // The tab goes when the list says the terminal is gone; a read that fails is tried again.
  } finally {
    mirror.reading = false;
  }
}

async function sendKeys(instance: Instance) {
  const mirror = instance.mirror;
  if (!mirror || mirror.sending || !mirror.pending) return;
  const text = mirror.pending.slice(0, SEND_LIMIT);
  mirror.pending = mirror.pending.slice(text.length);
  mirror.sending = true;
  try {
    await invoke("orca_terminal_input", { handle: mirror.handle, text, environment: mirror.environment });
  } catch (e) {
    onError(e);
  }
  mirror.sending = false;
  // What was typed meanwhile goes next, and the frame that shows the effect is read soon.
  sendKeys(instance);
  setTimeout(() => readFrame(instance), 150);
}

function startMirror(instance: Instance) {
  const mirror = instance.mirror;
  if (!mirror || mirror.timer !== null) return;
  readFrame(instance);
  mirror.timer = window.setInterval(() => readFrame(instance), MIRROR_MS);
}

function stopMirrors() {
  for (const { mirror } of instances.values()) {
    if (mirror?.timer != null) clearInterval(mirror.timer);
    if (mirror) mirror.timer = null;
  }
}

// ---- showing ----

// Shows the terminal of the tab `id` and hides the others. A mirror (`mirror`: the plain terminal's handle and the target) is created when its tab is first shown; a terminal of the app that is still being opened shows when it is ready.
export function showTerminal(id: string, mirror?: { handle: string; environment: string | null }) {
  // Already shown: a redraw of the screen must not read the mirror again or take the focus.
  if (visibleId === id && !container().hidden && (instances.has(id) || !mirror)) return;
  visibleId = id;
  container().hidden = false;
  stopMirrors();
  let instance = instances.get(id);
  if (!instance && mirror) {
    instance = newInstance();
    instance.mirror = { ...mirror, timer: null, last: null, reading: false, pending: "", sending: false };
    const made = instance;
    made.term.onData((data) => {
      made.mirror!.pending += data;
      sendKeys(made);
    });
    instances.set(id, instance);
  }
  for (const [other, { el }] of instances) el.hidden = other !== id;
  if (!instance) return;
  fitVisible();
  startMirror(instance);
  instance.term.focus();
}

// Hides every terminal and stops the reads of the mirrors (another screen or another kind of tab shows).
export function hideTerminals() {
  visibleId = null;
  stopMirrors();
  container().hidden = true;
}

// Forgets the terminal of the tab `id` (its tab is gone).
export function dropTerminal(id: string) {
  const instance = instances.get(id);
  if (!instance) return;
  if (instance.mirror?.timer != null) clearInterval(instance.mirror.timer);
  instance.term.dispose();
  instance.el.remove();
  instances.delete(id);
  if (visibleId === id) visibleId = null;
}

// Forgets every mirror whose id `keep` does not accept (the sessions that left Orca's list, or the target changed).
export function pruneMirrors(keep: (id: string) => boolean) {
  for (const [id, { mirror }] of instances) if (mirror && !keep(id)) dropTerminal(id);
}

// ---- a terminal of the app ----

const decode = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

// Opens a terminal of the app for the tab `id` at `target`, sized to the pane when it is shown. `ended` runs when the process ends. A failure is thrown and leaves no terminal behind.
export async function startPty(id: string, target: TerminalTarget, ended: () => void) {
  const instance = newInstance();
  instances.set(id, instance);
  instance.el.hidden = visibleId !== id;
  if (visibleId === id) instance.fit.fit();
  const channel = new window.__TAURI__.core.Channel<TerminalEvent>();
  channel.onmessage = (event) => {
    if (instances.get(id) !== instance) return;
    if (event.kind === "data") {
      instance.term.write(decode(event.data));
    } else {
      instance.ended = true;
      instance.term.write(ENDED);
      ended();
    }
  };
  instance.size = { cols: instance.term.cols, rows: instance.term.rows };
  try {
    instance.rustId = await invoke("terminal_open", { target, cols: instance.term.cols, rows: instance.term.rows, channel });
  } catch (e) {
    dropTerminal(id);
    throw e;
  }
  // The tab may have been closed while Rust opened it.
  if (instances.get(id) !== instance) {
    invoke("terminal_close", { id: instance.rustId }).catch(() => {});
    return;
  }
  instance.term.onData((data) => {
    if (instance.rustId && !instance.ended) invoke("terminal_write", { id: instance.rustId, data }).catch(onError);
  });
  instance.term.onResize(({ cols, rows }) => sendSize(instance, cols, rows));
  // The pane may have been sized differently while Rust opened it.
  sendSize(instance, instance.term.cols, instance.term.rows);
  if (visibleId === id) instance.term.focus();
}

function sendSize(instance: Instance, cols: number, rows: number) {
  if (!instance.rustId || (instance.size.cols === cols && instance.size.rows === rows)) return;
  instance.size = { cols, rows };
  invoke("terminal_resize", { id: instance.rustId, cols, rows }).catch(() => {});
}

// Ends the terminal of the app of the tab `id` and forgets it.
export async function closePty(id: string) {
  const instance = instances.get(id);
  dropTerminal(id);
  if (instance?.rustId) await invoke("terminal_close", { id: instance.rustId }).catch(() => {});
}

// What a failed send of typed keys or of a write does (the screen shows the message).
export function initOrcaTerminal(report: (e: unknown) => void) {
  onError = report;
  new ResizeObserver(fitVisible).observe(container());
}
