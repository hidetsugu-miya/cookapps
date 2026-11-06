// The terminals of the Orca screen (A-8, A-12): one xterm.js for each tab, in `#orca-term`, of which the selected one is shown. Every tab is a terminal, a Claude session's or a plain one.
// A saved environment streams the terminal shown (`orca_stream_terminal`): its screen first, then the bytes it prints. The terminal is fitted to the pane: the pane's size is sent, with the subscription, with each change and with the keys typed, and Orca sizes the terminal to it;
// the size Orca sends (the snapshot's and each `size`) is drawn, as another screen of Orca may take the size. Leaving the tab, the screen or a shown window ends the stream, and Orca gives the terminal back its own size.
// This machine's Orca cannot stream (its socket answers `method_not_supported`), so its terminal shown is a mirror: the screen is read every second (`orca_terminal_read`) and drawn again; it has no colors and its size is not sent.
// The keys typed go one send at a time, to the handle of the terminal they were typed in, and the keys typed while a send is on its way go together in the next one.
// Those not sent yet are dropped when the terminal stops (another tab, screen or a hidden window) or goes, so they never reach another terminal. Nothing a terminal prints or is typed is kept or logged here.
// Ghostty's settings (A-13) set the font and the keys that send a text; Shift+Enter sends a newline for Claude Code's input.
// The colors are those of the theme chosen in the settings (A-14), the light or the dark one by the system's appearance; the colors of Ghostty's settings are used only while there is no theme.
import type { OrcaTermEvent } from "./bindings/OrcaTermEvent";
import type { TerminalColors } from "./bindings/TerminalColors";
import type { TerminalSettings } from "./bindings/TerminalSettings";
import type { TextKeybind } from "./bindings/TextKeybind";
import { $, composing } from "./dom.js";
import { invoke } from "./ipc.js";

const SCROLLBACK = 5000;
const MIRROR_MS = 1000;
const FIT_DELAY_MS = 50;
// A send of typed keys carries at most this many characters (Rust takes 100,000).
const SEND_LIMIT = 50_000;
// The first frame of a mirror clears what the last one drew.
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";

const DEFAULT_FONT = "ui-monospace, Menlo, monospace";
const DEFAULT_FONT_SIZE = 13;
// Ghostty's `font-thicken`: the weight between regular and bold (a font without it draws regular).
const THICK_WEIGHT = 500;
// Shift+Enter makes a newline in the input of Claude Code, which a plain Enter would send. ESC CR is what Orca sends for it when the program has not asked for the Kitty protocol, which xterm.js has none of.
const SHIFT_ENTER: TextKeybind = { key: "Enter", shift: true, ctrl: false, alt: false, meta: false, text: "\x1b\r" };
// The names xterm.js gives the first 16 colors of the palette.
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];

// Where a terminal comes from: the stream of a saved environment, or the mirror of this machine.
export interface TermSource {
  kind: "stream" | "mirror";
  handle: string;
}

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
// The channel of the stream shown, null when none is: an event of another channel is not drawn.
let current: { onmessage: (event: OrcaTermEvent) => void } | null = null;
let unclosed = false;
let onError: (e: unknown) => void = () => {};
// Ghostty's settings as imported, null before the first import.
let settings: TerminalSettings | null = null;
// The colors of the theme chosen for each appearance (A-14), null before they are read.
let themeColors: { light: TerminalColors; dark: TerminalColors } | null = null;
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

const container = () => $("orca-term");
const visible = () => (visibleId === null ? undefined : instances.get(visibleId));

// The colors for the system's appearance: those of the chosen theme, else those of the imported settings; null when there are none.
const termColors = (): TerminalColors | null => {
  const dark = darkScheme.matches;
  return (dark ? themeColors?.dark : themeColors?.light) ?? (dark ? settings?.dark : settings?.light) ?? null;
};

// The theme of xterm.js: the app's own colors, with those of the theme (or of the imported settings) over them.
function xtermTheme(): Record<string, unknown> {
  const style = getComputedStyle(document.documentElement);
  const colors = termColors();
  const theme: Record<string, unknown> = {
    background: colors?.background ?? style.getPropertyValue("--term-bg").trim(),
    foreground: colors?.foreground ?? style.getPropertyValue("--term-fg").trim(),
    cursor: colors?.cursor ?? undefined,
    cursorAccent: colors?.cursorAccent ?? undefined,
    selectionBackground: colors?.selectionBackground ?? undefined,
    selectionForeground: colors?.selectionForeground ?? undefined,
  };
  // The colors 16 and over go in `extendedAnsi` from its index 0; one that is not set (an empty string) stays xterm.js's.
  const extended: string[] = [];
  for (const { index, color } of colors?.palette ?? []) {
    if (index < ANSI.length) theme[ANSI[index]!] = color;
    else {
      while (extended.length < index - ANSI.length) extended.push("");
      extended[index - ANSI.length] = color;
    }
  }
  if (extended.length) theme.extendedAnsi = extended;
  return theme;
}

// The font and colors of the terminals: Ghostty's families come first, then the app's own.
function termOptions() {
  const families = [...(settings?.fontFamilies ?? []).map((name) => JSON.stringify(name)), DEFAULT_FONT];
  return { fontFamily: families.join(", "), fontSize: settings?.fontSize ?? DEFAULT_FONT_SIZE, fontWeight: settings?.fontThicken ? THICK_WEIGHT : "normal", theme: xtermTheme() };
}

// The keys that send a text: those of the settings, then Shift+Enter. Made when the settings are applied, not at each key event.
let keybinds: TextKeybind[] = [SHIFT_ENTER];

// The punctuation keys by `KeyboardEvent.code`; letters and digits are read from the code itself.
const CODE_CHARS: Record<string, string> = { Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/", Space: " " };

// The character of the key a `code` names on a US keyboard, which Option does not change.
function charOfCode(code: string) {
  const letterOrDigit = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  return letterOrDigit ? (letterOrDigit[1] ?? letterOrDigit[2])?.toLowerCase() : CODE_CHARS[code];
}

// The key of the settings (or Shift+Enter) that a key event is; Ghostty compares the character the key makes, case folded, and the exact set of modifiers.
// With Option held, macOS makes another character (Option+B is ∫), so a one-character key is also compared with the character of the physical key.
function keybindOf(event: KeyboardEvent) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const physical = event.altKey ? charOfCode(event.code) : undefined;
  return keybinds.find(
    (b) => (b.key === key || b.key === physical) && b.shift === event.shiftKey && b.ctrl === event.ctrlKey && b.alt === event.altKey && b.meta === event.metaKey,
  );
}

// Draws the font and colors in every terminal and in the pane around them.
function drawLook() {
  const options = termOptions();
  for (const { term } of instances.values()) Object.assign(term.options, options);
  container().style.background = termColors()?.background ?? "";
}

// Draws the theme chosen in the settings (A-14) in every terminal (null: the colors of Ghostty's settings, else the app's own).
export function applyTerminalTheme(next: { light: TerminalColors; dark: TerminalColors } | null) {
  themeColors = next;
  drawLook();
}

// Draws Ghostty's imported settings in every terminal and in the pane around them (null: the app's own font and keys).
export function applyTerminalSettings(next: TerminalSettings | null) {
  settings = next;
  keybinds = [...(next?.keybinds ?? []), SHIFT_ENTER];
  drawLook();
  // The size of a cell changed with the font: the terminal shown fits the pane again.
  fitSoon();
}

function newInstance(source: TermSource): Instance {
  const term = new Terminal({
    scrollback: SCROLLBACK,
    cursorBlink: true,
    allowProposedApi: true,
    ...termOptions(),
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
  // A key of the settings sends its text in place of the key. All three events of the key are kept from xterm.js, or its keypress would print the character too; the text goes once, at the keydown.
  term.attachCustomKeyEventHandler((event) => {
    const bind = composing(event) ? undefined : keybindOf(event);
    if (!bind) return true;
    if (event.type === "keydown") {
      event.preventDefault();
      instance.pending += bind.text;
      sendKeys(instance);
    }
    return false;
  });
  return instance;
}

// Fits the shown terminal to the pane, and tells the stream the new size.
function fitVisible() {
  const instance = visible();
  if (!instance || container().hidden) return;
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
    if (instance.source.kind === "stream") await invoke("orca_stream_input", { handle: instance.source.handle, text });
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
    if (event.cols && event.rows) term.resize(event.cols, event.rows);
    term.write(event.data);
  } else if (event.kind === "output") {
    term.write(event.data);
  } else if (event.kind === "size") {
    term.resize(event.cols, event.rows);
  } else {
    term.write(`\r\n\x1b[2m（ターミナルとのつながりが終わりました${event.message ? `: ${event.message}` : ""}）\x1b[0m`);
  }
}

// Subscribes the stream of the shown terminal, with the pane's size.
function startStream(instance: Instance) {
  if (document.hidden) return;
  const channel = new window.__TAURI__.core.Channel<OrcaTermEvent>();
  current = channel;
  unclosed = false;
  channel.onmessage = (event) => {
    if (current === channel) drawEvent(instance, event);
  };
  instance.fit.fit();
  const viewport = { cols: instance.term.cols, rows: instance.term.rows };
  invoke("orca_stream_terminal", { handle: instance.source.handle, viewport, channel }).catch((e) => {
    if (current === channel) drawEvent(instance, { kind: "ended", message: String(e) });
  });
}

// Ends the stream of the terminal shown, so Orca gives it back its own size. With `close` false another stream follows at once, and its subscription lets this one go:
// a close is a call of its own, which could reach Rust after that subscription and end it.
// A stream let go without a close is still subscribed in Rust until the next subscription or close: `unclosed` keeps that for the next close.
function stopStream(close = true) {
  if (current === null && !unclosed) return;
  const subscribed = current !== null;
  current = null;
  unclosed = !close && (subscribed || unclosed);
  if (close) invoke("orca_stream_terminal_close").catch(() => {});
}

// Starts what the shown terminal needs: its stream, or its mirror's reads.
function start(instance: Instance) {
  if (instance.source.kind === "stream") startStream(instance);
  else startMirror(instance);
}

function stop(close = true) {
  stopMirrors();
  stopStream(close);
  for (const instance of instances.values()) instance.pending = "";
}

// ---- showing ----

// Shows the terminal of the tab `id` (`source`: where it comes from) and hides the others. It is made when its tab is first shown.
export function showTerminal(id: string, source: TermSource) {
  // Already shown: a redraw of the screen must not start it again or take the focus.
  if (visibleId === id && !container().hidden && instances.has(id)) return;
  let instance = instances.get(id);
  // A stream that starts next lets the one shown go by itself (`stopStream`).
  stop(document.hidden || (instance?.source ?? source).kind !== "stream");
  visibleId = id;
  container().hidden = false;
  if (!instance) {
    instance = newInstance(source);
    instances.set(id, instance);
  }
  for (const [other, { el }] of instances) el.hidden = other !== id;
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
    // The tab shown next lets this stream go by its own subscription; with none (`hideTerminals`) the close is sent then.
    stop(false);
    visibleId = null;
  }
  if (instance.timer !== null) clearInterval(instance.timer);
  instance.pending = "";
  instance.term.dispose();
  instance.el.remove();
  instances.delete(id);
}

// Forgets every terminal whose id `keep` does not accept (the sessions that left Orca's list, or the target changed).
export function pruneTerminals(keep: (id: string) => boolean) {
  for (const id of instances.keys()) if (!keep(id)) dropTerminal(id);
}

// What a failed send of typed keys does (the screen shows the message).
export function initOrcaTerminal(report: (e: unknown) => void) {
  onError = report;
  new ResizeObserver(fitSoon).observe(container());
  // The cell size is measured with the font, so the fit is made again once the fonts are there.
  document.fonts?.ready.then(fitSoon).catch(() => {});
  // The system's appearance picks the light or the dark colors.
  darkScheme.addEventListener("change", () => applyTerminalSettings(settings));
  // A hidden window stops the reads and the stream; shown again, the terminal that is shown starts again (a stream sends its screen anew).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return stop();
    const instance = visible();
    if (instance && !container().hidden) start(instance);
  });
}
