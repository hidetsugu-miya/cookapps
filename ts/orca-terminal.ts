// The terminals of the Orca screen (A-8, A-12): one xterm.js for each tab, in `#orca-term`, of which the selected one is shown. Every tab is a terminal, a Claude session's or a plain one.
// A saved environment streams the terminal shown (`orca_stream_terminal`): its screen first, then the bytes it prints. While it fits the pane ("画面に合わせる", the first state) the pane's size is sent and Orca sizes the terminal to it;
// "固定" keeps the font and Orca's size, and the box scrolls when it does not fit. Leaving the tab, the screen or a shown window ends the stream, and Orca gives the terminal back its own size.
// This machine's Orca cannot stream (its socket answers `method_not_supported`), so its terminal shown is a mirror: the screen is read every second (`orca_terminal_read`) and drawn again; it has no colors and its size is not sent.
// The keys typed go one send at a time, and the keys typed while a send is on its way go together in the next one. Nothing a terminal prints or is typed is kept or logged here.
import type { OrcaTermEvent } from "./bindings/OrcaTermEvent";
import { $ } from "./dom.js";
import { invoke } from "./ipc.js";

const SCROLLBACK = 5000;
const MIRROR_MS = 1000;
const FIT_DELAY_MS = 50;
// A send of typed keys carries at most this many characters (Rust takes 100,000).
const SEND_LIMIT = 50_000;
// The first frame of a mirror clears what the last one drew.
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";

// Where a terminal comes from: the stream of a saved environment, or the mirror of this machine.
export interface TermSource {
  kind: "stream" | "mirror";
  handle: string;
}

// How the terminal shown is sized: to the pane (the first state), or as Orca has it. Kept in memory only.
export type FitMode = "fit" | "fixed";

interface Instance {
  term: XTerm;
  fit: { fit(): void };
  el: HTMLElement;
  source: TermSource;
  // The mirror: its timer, the last frame drawn, and a read on its way.
  timer: number | null;
  last: string | null;
  reading: boolean;
  // The keys typed and not sent yet, and a send on its way.
  pending: string;
  sending: boolean;
}

const instances = new Map<string, Instance>();
// The tab whose terminal is shown, null when none is.
let visibleId: string | null = null;
let mode: FitMode = "fit";
// The channel of the stream shown, null when none is: an event of another channel is not drawn.
let current: { onmessage: (event: OrcaTermEvent) => void } | null = null;
let onError: (e: unknown) => void = () => {};

const container = () => $("orca-term");
const visible = () => (visibleId === null ? undefined : instances.get(visibleId));
// Only a stream can keep Orca's size: the mirror is always drawn at the pane's width.
const fixed = (instance: Instance) => instance.source.kind === "stream" && mode === "fixed";

function newInstance(source: TermSource): Instance {
  const style = getComputedStyle(document.documentElement);
  const term = new Terminal({
    scrollback: SCROLLBACK,
    cursorBlink: true,
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 13,
    allowProposedApi: true,
    theme: { background: style.getPropertyValue("--term-bg").trim(), foreground: style.getPropertyValue("--term-fg").trim() },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // An emoji or a CJK character takes the cells Unicode 11 gives it, as Orca's own terminal counts them.
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = "11";
  const el = document.createElement("div");
  el.className = "orca-term-box";
  container().append(el);
  term.open(el);
  const instance: Instance = { term, fit, el, source, timer: null, last: null, reading: false, pending: "", sending: false };
  term.onData((data) => {
    instance.pending += data;
    sendKeys(instance);
  });
  return instance;
}

// Fits the shown terminal to the pane, and tells the stream the new size. A fixed terminal keeps Orca's size.
function fitVisible() {
  const instance = visible();
  if (!instance || container().hidden || fixed(instance)) return;
  const { cols, rows } = instance.term;
  instance.fit.fit();
  if (instance.source.kind === "stream" && current !== null && (instance.term.cols !== cols || instance.term.rows !== rows)) {
    invoke("orca_stream_viewport", { viewport: { cols: instance.term.cols, rows: instance.term.rows } }).catch(() => {});
  }
}

// A drag of the divider or of the window changes the size many times a second, and each fit reflows the scrollback: fit once the size has rested.
let fitTimer: number | null = null;
function fitSoon() {
  if (fitTimer !== null) clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    fitTimer = null;
    fitVisible();
  }, FIT_DELAY_MS);
}

// ---- the keys ----

async function sendKeys(instance: Instance) {
  if (instance.sending || !instance.pending) return;
  const text = instance.pending.slice(0, SEND_LIMIT);
  instance.pending = instance.pending.slice(text.length);
  instance.sending = true;
  try {
    if (instance.source.kind === "stream") await invoke("orca_stream_input", { text });
    else await invoke("orca_terminal_input", { handle: instance.source.handle, text });
  } catch (e) {
    onError(e);
  }
  instance.sending = false;
  // What was typed meanwhile goes next; a mirror reads the frame that shows the effect soon.
  sendKeys(instance);
  if (instance.source.kind === "mirror") setTimeout(() => readFrame(instance), 150);
}

// ---- the mirror (this machine) ----

async function readFrame(instance: Instance) {
  if (instance.reading) return;
  instance.reading = true;
  try {
    const lines = await invoke("orca_terminal_read", { handle: instance.source.handle });
    const text = lines.join("\r\n");
    if (text !== instance.last) {
      instance.last = text;
      instance.term.write(CLEAR + text);
    }
  } catch {
    // The tab goes when the list says the terminal is gone; a read that fails is tried again.
  } finally {
    instance.reading = false;
  }
}

function startMirror(instance: Instance) {
  // A hidden window reads nothing; it starts again when the window is shown (`initOrcaTerminal`).
  if (instance.timer !== null || document.hidden) return;
  readFrame(instance);
  instance.timer = window.setInterval(() => readFrame(instance), MIRROR_MS);
}

function stopMirrors() {
  for (const instance of instances.values()) {
    if (instance.timer !== null) clearInterval(instance.timer);
    instance.timer = null;
  }
}

// ---- the stream (a saved environment) ----

function drawEvent(instance: Instance, event: OrcaTermEvent) {
  const term = instance.term;
  if (event.kind === "snapshot") {
    // The screen now replaces everything drawn before (a resubscription after a lost connection sends it again).
    term.reset();
    if (fixed(instance) && event.cols && event.rows) term.resize(event.cols, event.rows);
    term.write(event.data);
  } else if (event.kind === "output") {
    term.write(event.data);
  } else if (event.kind === "size") {
    if (fixed(instance)) term.resize(event.cols, event.rows);
  } else {
    term.write(`\r\n\x1b[2m（ターミナルとのつながりが終わりました${event.message ? `: ${event.message}` : ""}）\x1b[0m`);
  }
}

// Subscribes the stream of the shown terminal, with the pane's size while it fits the pane.
function startStream(instance: Instance) {
  if (document.hidden) return;
  const channel = new window.__TAURI__.core.Channel<OrcaTermEvent>();
  current = channel;
  channel.onmessage = (event) => {
    if (current === channel) drawEvent(instance, event);
  };
  if (!fixed(instance)) instance.fit.fit();
  const viewport = fixed(instance) ? null : { cols: instance.term.cols, rows: instance.term.rows };
  invoke("orca_stream_terminal", { handle: instance.source.handle, viewport, channel }).catch((e) => {
    if (current === channel) drawEvent(instance, { kind: "ended", message: String(e) });
  });
}

// Ends the stream of the terminal shown, so Orca gives it back its own size.
function stopStream() {
  if (current === null) return;
  current = null;
  invoke("orca_stream_terminal_close").catch(() => {});
}

// Starts what the shown terminal needs: its stream, or its mirror's reads.
function start(instance: Instance) {
  if (instance.source.kind === "stream") startStream(instance);
  else startMirror(instance);
}

function stop() {
  stopMirrors();
  stopStream();
}

// ---- showing ----

// Shows the terminal of the tab `id` (`source`: where it comes from) and hides the others. It is made when its tab is first shown.
export function showTerminal(id: string, source: TermSource) {
  // Already shown: a redraw of the screen must not start it again or take the focus.
  if (visibleId === id && !container().hidden && instances.has(id)) return;
  stop();
  visibleId = id;
  container().hidden = false;
  let instance = instances.get(id);
  if (!instance) {
    instance = newInstance(source);
    instances.set(id, instance);
  }
  for (const [other, { el }] of instances) el.hidden = other !== id;
  container().classList.toggle("fixed", fixed(instance));
  fitVisible();
  start(instance);
  instance.term.focus();
}

// Hides every terminal and stops their reads and streams (another screen, a tab with no terminal, or no tab shows).
export function hideTerminals() {
  if (visibleId === null && container().hidden) return;
  visibleId = null;
  stop();
  container().hidden = true;
}

// Forgets the terminal of the tab `id` (its tab is gone).
function dropTerminal(id: string) {
  const instance = instances.get(id);
  if (!instance) return;
  if (visibleId === id) {
    stop();
    visibleId = null;
  }
  if (instance.timer !== null) clearInterval(instance.timer);
  instance.term.dispose();
  instance.el.remove();
  instances.delete(id);
}

// Forgets every terminal whose id `keep` does not accept (the sessions that left Orca's list, or the target changed).
export function pruneTerminals(keep: (id: string) => boolean) {
  for (const id of instances.keys()) if (!keep(id)) dropTerminal(id);
}

export const fitMode = () => mode;

// Switches how the terminal shown is sized. A stream shown is subscribed again: with the pane's size to fit it, without to give Orca its own.
export function setFitMode(next: FitMode) {
  if (next === mode) return;
  mode = next;
  const instance = visible();
  if (!instance || container().hidden) return;
  container().classList.toggle("fixed", fixed(instance));
  if (instance.source.kind !== "stream") return fitVisible();
  stopStream();
  startStream(instance);
}

// What a failed send of typed keys does (the screen shows the message).
export function initOrcaTerminal(report: (e: unknown) => void) {
  onError = report;
  new ResizeObserver(fitSoon).observe(container());
  // The cell size is measured with the font, so the fit is made again once the fonts are there.
  document.fonts?.ready.then(fitSoon).catch(() => {});
  // A hidden window stops the reads and the stream; shown again, the terminal that is shown starts again (a stream sends its screen anew).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return stop();
    const instance = visible();
    if (instance && !container().hidden) start(instance);
  });
}
