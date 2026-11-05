// The mirrors of the plain terminals of Orca on the Orca screen (A-8): one xterm.js for each terminal tab, in `#orca-term`.
// Orca cannot stream the bytes of a terminal to this app, so while its tab is shown the screen is read every second (`orca_terminal_read`) and drawn again,
// and the keys go to `orca_terminal_input`, batched and one send at a time. It has no colors, a full-screen program is only approximate, and its size is not sent.
// An instance lives while its tab exists and is only hidden when another tab shows. Nothing a terminal prints or is typed is kept or logged here.
import { $ } from "./dom.js";
import { invoke } from "./ipc.js";

const SCROLLBACK = 5000;
const MIRROR_MS = 1000;
const FIT_DELAY_MS = 50;
// A send of typed keys carries at most this many characters (Rust takes 100,000).
const SEND_LIMIT = 50_000;
// The first frame of a mirror clears what the last one drew.
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";

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
  mirror: Mirror;
}

const instances = new Map<string, Instance>();
// The tab whose terminal is shown, null when none is (an instance that is created later is shown only if it is this one).
let visibleId: string | null = null;
let onError: (e: unknown) => void = () => {};

const container = () => $("orca-term");

function newInstance(mirror: Mirror): Instance {
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
  return { term, fit, el, mirror };
}

// Fits the shown terminal to the pane.
function fitVisible() {
  const instance = visibleId === null ? undefined : instances.get(visibleId);
  if (instance && !container().hidden) instance.fit.fit();
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

// ---- the mirror ----

async function readFrame(instance: Instance) {
  const mirror = instance.mirror;
  if (mirror.reading) return;
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
  if (mirror.sending || !mirror.pending) return;
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
  // A hidden window reads nothing; it starts again when the window is shown (`initOrcaTerminal`).
  if (mirror.timer !== null || document.hidden) return;
  readFrame(instance);
  mirror.timer = window.setInterval(() => readFrame(instance), MIRROR_MS);
}

function stopMirrors() {
  for (const { mirror } of instances.values()) {
    if (mirror.timer !== null) clearInterval(mirror.timer);
    mirror.timer = null;
  }
}

// ---- showing ----

// Shows the mirror of the tab `id` (`mirror`: the plain terminal's handle and the target) and hides the others. It is created when its tab is first shown.
export function showTerminal(id: string, mirror: { handle: string; environment: string | null }) {
  // Already shown: a redraw of the screen must not read the mirror again or take the focus.
  if (visibleId === id && !container().hidden && instances.has(id)) return;
  visibleId = id;
  container().hidden = false;
  stopMirrors();
  let instance = instances.get(id);
  if (!instance) {
    instance = newInstance({ ...mirror, timer: null, last: null, reading: false, pending: "", sending: false });
    const made = instance;
    made.term.onData((data) => {
      made.mirror.pending += data;
      sendKeys(made);
    });
    instances.set(id, instance);
  }
  for (const [other, { el }] of instances) el.hidden = other !== id;
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
  if (instance.mirror.timer !== null) clearInterval(instance.mirror.timer);
  instance.term.dispose();
  instance.el.remove();
  instances.delete(id);
  if (visibleId === id) visibleId = null;
}

// Forgets every mirror whose id `keep` does not accept (the sessions that left Orca's list, or the target changed).
export function pruneMirrors(keep: (id: string) => boolean) {
  for (const id of [...instances.keys()]) if (!keep(id)) dropTerminal(id);
}

// What a failed send of typed keys does (the screen shows the message).
export function initOrcaTerminal(report: (e: unknown) => void) {
  onError = report;
  new ResizeObserver(fitSoon).observe(container());
  // A hidden window stops the reads of the mirror; shown again, the terminal that is shown reads at once and goes on.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return stopMirrors();
    const instance = visibleId === null ? undefined : instances.get(visibleId);
    if (instance && !container().hidden) startMirror(instance);
  });
}
