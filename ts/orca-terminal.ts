// The terminals of the Orca screen (A-8, A-12, A-17): one xterm.js for each tab. The work pane is split into panes (A-17), and the tab selected in each pane is shown, in the host element of its pane; the others wait in `#orca-stash`.
// Every tab is a terminal, a Claude session's or a plain one.
// A saved environment streams each terminal shown (`orca_stream_terminal`): its screen first, then the bytes it prints. A terminal is fitted to its pane: the pane's size is sent, with the subscription, with each change and with the keys typed, and Orca sizes the terminal to it;
// the size Orca sends (the snapshot's and each `size`) is drawn, as another screen of Orca may take the size. Leaving the tab, the screen or a shown window ends the stream of that terminal (`orca_stream_terminal_close`), and Orca gives it back its own size.
// This machine's Orca cannot stream (its socket answers `method_not_supported`), so its terminals shown are mirrors: the screen is read every second (`orca_terminal_read`) and drawn again; it has no colors and its size is not sent.
// The keys typed go one send at a time, to the handle of the terminal they were typed in, and the keys typed while a send is on its way go together in the next one.
// Those not sent yet are dropped when the terminal stops (another tab, screen or a hidden window) or goes, so they never reach another terminal. Nothing a terminal prints or is typed is kept or logged here.
// An image pasted or dropped on a terminal shown is put in its worktree and its path is typed in that terminal (A-10).
// Ghostty's settings (A-13) set the font and the keys that send a text, and the font chosen in the settings (A-20) takes the place of their font; Shift+Enter sends a newline for Claude Code's input.
// A URL in the text, or in an OSC 8 link, opens in the default browser with ⌘+click (the left button, no Ctrl or Alt), as in Orca's own terminal; the click on a URL without ⌘ selects as before.
// A program that asks for the clipboard with OSC 52 (Claude Code does, for what is selected while it tracks the mouse) gets it, as in Orca's own terminal: a write is made only from what the terminal prints live, not from a snapshot or a mirror frame drawn again, and a read ("?") is never answered.
// The request comes by the stream, outside a user action, and WKWebView may refuse the write: the latest text is then held, and the next copy event (⌘C or Edit > Copy) puts it in the clipboard when xterm.js has no selection.
// Option+drag selects in xterm.js while a program tracks the mouse (`macOptionClickForcesSelection`, as Orca sets it).
// The colors are those of the theme chosen in the settings (A-14), the light or the dark one by the system's appearance, or the one the settings fix (A-15); the colors of Ghostty's settings are used only while there is no theme.
import type { Appearance } from "./bindings/Appearance";
import type { OrcaTermEvent } from "./bindings/OrcaTermEvent";
import type { TerminalColors } from "./bindings/TerminalColors";
import type { TerminalSettings } from "./bindings/TerminalSettings";
import type { TextKeybind } from "./bindings/TextKeybind";
import { $, composing } from "./dom.js";
import { invoke } from "./ipc.js";
import { listenForImages, readImages, uploadAttachments } from "./orca-attach.js";

const SCROLLBACK = 5000;
const MIRROR_MS = 1000;
const FIT_DELAY_MS = 50;
// A send of typed keys carries at most this many characters (Rust takes 100,000).
const SEND_LIMIT = 50_000;
// The first frame of a mirror clears what the last one drew.
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
// An OSC 52 request holds at most this many base64 characters, as in Orca's own terminal (128 KiB).
const OSC52_LIMIT = 128 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const DEFAULT_FONT = "ui-monospace, Menlo, monospace";
const DEFAULT_FONT_SIZE = 13;
// Ghostty's `font-thicken`: the weight between regular and bold (a font without it draws regular).
const THICK_WEIGHT = 500;
// Shift+Enter makes a newline in the input of Claude Code, which a plain Enter would send. ESC CR is what Orca sends for it when the program has not asked for the Kitty protocol, which xterm.js has none of.
const SHIFT_ENTER: TextKeybind = { key: "Enter", shift: true, ctrl: false, alt: false, meta: false, text: "\x1b\r" };
// The names xterm.js gives the first 16 colors of the palette.
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];

// What a link in the text is: it starts with http:// or https:// and ends before a space, a quote, a bracket, or a full-width punctuation mark or bracket (U+3000 to U+303F and U+FF00 to U+FFEF), so a URL in a Japanese sentence is cut where the sentence goes on.
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`\u3000-\u303f\uff00-\uffef]*[^\s"':,.!?{}|\\^~[\]`()<>\u3000-\u303f\uff00-\uffef]/;

// Where a terminal comes from: the stream of a saved environment, or the mirror of this machine.
// `path` is the worktree the terminal runs in and `environment` the target, where an image dropped on it is put (A-10).
export interface TermSource {
  kind: "stream" | "mirror";
  handle: string;
  path: string;
  environment: string | null;
}

// A terminal to show: its handle (the id of its screen, which a change of the tab's kind, plain to Claude or back, does not change), where it comes from, and the host element of the pane that holds it.
export interface Placement {
  id: string;
  source: TermSource;
  host: HTMLElement;
}

interface Instance {
  term: XTerm;
  fit: { fit(): void };
  el: HTMLElement;
  source: TermSource;
  // The host element of its pane while it is shown, else null (its box waits in the stash).
  host: HTMLElement | null;
  // The channel of its stream, null when it has none: an event of another channel is not drawn.
  channel: { onmessage: (event: OrcaTermEvent) => void } | null;
  // The number of the showing of its stream: Rust ends a showing only by a close of the same number, whatever order the calls arrive in.
  generation: number;
  // The mirror: its timer, the last frame drawn, and a read on its way.
  timer: number | null;
  last: string | null;
  reading: boolean;
  // The keys typed and not sent yet, and a send on its way.
  pending: string;
  sending: boolean;
  // The writes on their way that draw a screen again (a snapshot, a mirror frame): an OSC 52 request in them is not made.
  replaying: number;
  // The latest text of an OSC 52 request that the clipboard has not taken yet, and whether its write is queued for the end of the parse.
  copy: string | null;
  copyQueued: boolean;
}

const instances = new Map<string, Instance>();
// The handles of the terminals shown (one for each pane), and the one that last took the focus.
const shown = new Set<string>();
let focusedId: string | null = null;
// The host elements that are watched for their size.
const watched = new Set<HTMLElement>();
// The number the last showing of a stream took.
let streamSeq = 0;
// The host elements that take images already.
const listening = new WeakSet<HTMLElement>();
let onError: (e: unknown) => void = () => {};
// Ghostty's settings as imported, null before the first import.
let settings: TerminalSettings | null = null;
// The font chosen in the settings for the terminals (A-20): the family (null is the app's own) and the size; null follows Ghostty's settings.
let chosenFont: { family: string | null; size: number } | null = null;
// The colors of the theme chosen for each appearance, and which of them is drawn (A-14, A-15); null before they are read.
export type ThemeColors = { light: TerminalColors; dark: TerminalColors; appearance: Appearance };
let themeColors: ThemeColors | null = null;
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

// The size of a host element is the size of its pane: a change fits its terminal (the cell size is measured with the font, so the fit is made again once the fonts are there).
const resizes = new ResizeObserver(() => fitSoon());
const stash = () => $("orca-stash");
const shownInstances = () => [...shown].flatMap((id) => instances.get(id) ?? []);

// The colors for the appearance (the system's, unless the settings fix it to light or dark): those of the chosen theme, else those of the imported settings; null when there are none.
const termColors = (): TerminalColors | null => {
  const dark = themeColors && themeColors.appearance !== "system" ? themeColors.appearance === "dark" : darkScheme.matches;
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

// The font and colors of the terminals. A font chosen in the settings (A-20) is the family and the size, with the app's own after it; without one, Ghostty's families come first, then the app's own.
function termOptions() {
  if (chosenFont) return { fontFamily: [...(chosenFont.family ? [JSON.stringify(chosenFont.family)] : []), DEFAULT_FONT].join(", "), fontSize: chosenFont.size, fontWeight: "normal", theme: xtermTheme() };
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

// Draws the font and colors in every terminal and in the panes around them.
function drawLook() {
  const options = termOptions();
  for (const { term } of instances.values()) Object.assign(term.options, options);
  for (const { host } of shownInstances()) if (host) host.style.background = termColors()?.background ?? "";
}

// Draws the font chosen in the settings in every terminal (null: Ghostty's family and size, A-13).
export function applyTerminalFont(next: { family: string | null; size: number } | null) {
  chosenFont = next;
  drawLook();
  // The size of a cell changed with the font: the terminals shown fit their panes again.
  fitSoon();
}

// Draws the theme chosen in the settings (A-14, A-15) in every terminal (null: the colors of Ghostty's settings, else the app's own).
export function applyTerminalTheme(next: ThemeColors | null) {
  themeColors = next;
  drawLook();
}

// Draws Ghostty's imported settings in every terminal and in the pane around them (null: the app's own font and keys).
export function applyTerminalSettings(next: TerminalSettings | null) {
  settings = next;
  keybinds = [...(next?.keybinds ?? []), SHIFT_ENTER];
  drawLook();
  // The size of a cell changed with the font: the terminals shown fit their panes again.
  fitSoon();
}

// The text an OSC 52 request (the data after `52;`: the target, `;`, base64 of UTF-8) asks to put in the clipboard.
// null when it is not a write to the clipboard (the target is not `c` or empty, a read, an empty text, too long, not base64).
function osc52Text(data: string): string | null {
  const semi = data.indexOf(";");
  if (semi === -1) return null;
  const target = data.slice(0, semi);
  if (target !== "" && target !== "c") return null;
  const payload = data.slice(semi + 1);
  if (payload.length > OSC52_LIMIT) return null;
  const base64 = payload.replace(/\s/g, "");
  if (!BASE64.test(base64)) return null;
  try {
    const binary = atob(base64);
    const text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

// Writes the latest OSC 52 text of the terminal to the clipboard once the parse is over, so requests of one chunk write only the last (as Orca's own terminal does).
// A refused write says nothing and leaves the text held for the copy event.
function copyLater(instance: Instance, text: string) {
  instance.copy = text;
  if (instance.copyQueued) return;
  instance.copyQueued = true;
  queueMicrotask(() => {
    instance.copyQueued = false;
    const latest = instance.copy;
    if (latest === null) return;
    navigator.clipboard
      .writeText(latest)
      .then(() => {
        if (instance.copy === latest) instance.copy = null;
      })
      .catch(() => {});
  });
}

// Draws `data` as a screen drawn again: an OSC 52 request in it is not made.
// xterm.js parses the writes in order and calls the callback of each right after its parse, so the count is up only while `data` itself is parsed, and the live output queued before it keeps its requests.
function writeAgain(instance: Instance, data: string) {
  instance.term.write("", () => {
    instance.replaying++;
  });
  instance.term.write(data, () => {
    instance.replaying--;
  });
}

function newInstance(source: TermSource): Instance {
  const el = document.createElement("div");
  el.className = "orca-term-box";
  el.hidden = true;
  stash().append(el);
  // The click on a link: only ⌘ with the left button opens it, and the selection goes. Rust opens http and https URLs and refuses the others (an OSC 8 link may name any: xterm.js drops a non-http one before this unless `allowNonHttpProtocols` is set, as Orca sets it).
  const open = (event: MouseEvent, uri: string) => {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.button !== 0) return;
    invoke("orca_open_url", { url: uri }).catch(onError);
    term.clearSelection();
  };
  // The URL is the tooltip of the box while the pointer is over a link.
  const hover = (_event: MouseEvent, uri: string) => {
    el.title = uri;
  };
  const leave = () => {
    el.title = "";
  };
  const term = new Terminal({
    scrollback: SCROLLBACK,
    cursorBlink: true,
    macOptionClickForcesSelection: true,
    allowProposedApi: true,
    linkHandler: { allowNonHttpProtocols: true, activate: open, hover, leave },
    ...termOptions(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // An emoji or a CJK character takes the cells Unicode 11 gives it, as Orca's own terminal counts them.
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon.WebLinksAddon(open, { hover, leave, urlRegex: URL_REGEX }));
  term.open(el);
  const instance: Instance = { term, fit, el, source, host: null, channel: null, generation: 0, timer: null, last: null, reading: false, pending: "", sending: false, replaying: 0, copy: null, copyQueued: false };
  // The clipboard request of a program. Returning true says it was handled, so xterm.js passes it on to nobody.
  term.parser.registerOscHandler(52, (data) => {
    const text = instance.replaying > 0 ? null : osc52Text(data);
    if (text !== null) copyLater(instance, text);
    return true;
  });
  // A new selection makes the held text old. xterm.js also says a change when there is none (a mouse mode, the alternate screen and a resize do), which Claude Code sends often: that leaves the held text.
  term.onSelectionChange(() => {
    if (term.hasSelection()) instance.copy = null;
  });
  // The copy of the user (⌘C, Edit > Copy) takes the held text when xterm.js has no selection to copy; xterm.js copies its own selection before this, on the element inside.
  el.addEventListener("copy", (event) => {
    if (instance.copy === null || term.hasSelection() || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", instance.copy);
    event.preventDefault();
    instance.copy = null;
  });
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

// Fits a shown terminal to its pane, and tells the stream the new size.
function fitInstance(instance: Instance) {
  if (!instance.host || instance.host.hidden) return;
  const { cols, rows } = instance.term;
  instance.fit.fit();
  if (instance.source.kind === "stream" && instance.channel !== null && (instance.term.cols !== cols || instance.term.rows !== rows)) {
    invoke("orca_stream_viewport", { handle: instance.source.handle, viewport: { cols: instance.term.cols, rows: instance.term.rows } }).catch(() => {});
  }
}

// A drag of the divider or of the window changes the size many times a second, and each fit reflows the scrollback: fit once the size has rested.
let fitTimer: number | null = null;
function fitSoon() {
  if (fitTimer !== null) clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    fitTimer = null;
    for (const instance of shownInstances()) fitInstance(instance);
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

// ---- images (A-10) ----

// Puts the images pasted or dropped on the terminal shown in its worktree and types their paths in it, as Orca's own terminal does. A file that is not an image is refused with the message.
async function attach(host: HTMLElement, files: File[]) {
  const instance = shownInstances().find((i) => i.host === host);
  if (!instance) return;
  const { images, message } = await readImages(files);
  if (message !== null) onError(message);
  if (!images.length) return;
  try {
    const lines = await uploadAttachments(images, instance.source.path, instance.source.environment);
    // The paths go only to the terminal the images were put on.
    if (instance.host === host) instance.term.paste(`${lines.join(" ")} `);
  } catch (e) {
    onError(e);
  }
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
      writeAgain(instance, CLEAR + text);
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

function stopMirror(instance: Instance) {
  if (instance.timer !== null) clearInterval(instance.timer);
  instance.timer = null;
}

// ---- the stream (a saved environment) ----

function drawEvent(instance: Instance, event: OrcaTermEvent) {
  const term = instance.term;
  if (event.kind === "snapshot") {
    // The screen now replaces everything drawn before (a resubscription after a lost connection sends it again).
    term.reset();
    instance.copy = null;
    if (event.cols && event.rows) term.resize(event.cols, event.rows);
    writeAgain(instance, event.data);
  } else if (event.kind === "output") {
    term.write(event.data);
  } else if (event.kind === "size") {
    term.resize(event.cols, event.rows);
  } else {
    term.write(`\r\n\x1b[2m（ターミナルとのつながりが終わりました${event.message ? `: ${event.message}` : ""}）\x1b[0m`);
  }
}

// Subscribes the stream of a shown terminal, with its pane's size.
function startStream(instance: Instance) {
  if (document.hidden || instance.channel !== null) return;
  const channel = new window.__TAURI__.core.Channel<OrcaTermEvent>();
  instance.channel = channel;
  channel.onmessage = (event) => {
    if (instance.channel === channel) drawEvent(instance, event);
  };
  instance.fit.fit();
  const viewport = { cols: instance.term.cols, rows: instance.term.rows };
  instance.generation = ++streamSeq;
  invoke("orca_stream_terminal", { handle: instance.source.handle, generation: instance.generation, viewport, channel }).catch((e) => {
    if (instance.channel === channel) drawEvent(instance, { kind: "ended", message: String(e) });
  });
}

// Ends the stream of a terminal, so Orca gives it back its own size. The close names the terminal and its showing, so it ends no other stream, and it cannot end a showing made after it.
function stopStream(instance: Instance) {
  if (instance.channel === null) return;
  instance.channel = null;
  invoke("orca_stream_terminal_close", { handle: instance.source.handle, generation: instance.generation }).catch(() => {});
}

// Starts what a shown terminal needs: its stream, or its mirror's reads.
function start(instance: Instance) {
  if (instance.source.kind === "stream") startStream(instance);
  else startMirror(instance);
}

// Stops the reads or the stream of a terminal, and drops the keys not sent yet.
function stop(instance: Instance) {
  stopMirror(instance);
  stopStream(instance);
  instance.pending = "";
}

// ---- showing ----

// Shows the terminals of `placements` (the handle, where it comes from, and the host element of its pane) and hides the others. A terminal is made when it is first shown.
// `focusId` is the handle of the terminal of the pane that has the focus: its terminal takes the keyboard when it is new or when it just became the focused one.
export function showTerminals(placements: Placement[], focusId: string | null) {
  const next = new Set(placements.map((p) => p.id));
  for (const id of [...shown]) {
    if (next.has(id)) continue;
    const gone = instances.get(id);
    shown.delete(id);
    if (!gone) continue;
    stop(gone);
    gone.host = null;
    gone.el.hidden = true;
    stash().append(gone.el);
  }
  const fresh: Instance[] = [];
  const hosts = new Set<HTMLElement>();
  let moved = false;
  for (const { id, source, host } of placements) {
    let instance = instances.get(id);
    if (!instance) {
      instance = newInstance(source);
      instances.set(id, instance);
    }
    if (!shown.has(id)) fresh.push(instance);
    shown.add(id);
    instance.host = host;
    // Shown again in a new pane: the keys of the old one are not for the new.
    if (instance.el.parentElement !== host) {
      host.append(instance.el);
      host.style.background = termColors()?.background ?? "";
      moved = true;
    }
    instance.el.hidden = false;
    hosts.add(host);
    if (!listening.has(host)) {
      listening.add(host);
      listenForImages(host, (files) => attach(host, files));
    }
    if (!watched.has(host)) {
      watched.add(host);
      resizes.observe(host);
    }
  }
  for (const host of watched) {
    if (hosts.has(host)) continue;
    watched.delete(host);
    resizes.unobserve(host);
  }
  for (const instance of fresh) {
    fitInstance(instance);
    start(instance);
  }
  // A terminal that moved to another pane is fitted to it once the pane has its size.
  if (moved) fitSoon();
  const focus = focusId === null ? undefined : instances.get(focusId);
  if (focus && shown.has(focusId!) && (focusId !== focusedId || fresh.includes(focus))) focus.term.focus();
  focusedId = focusId;
}

// Hides every terminal and stops their reads and streams (another screen, or no tab shows).
export function hideTerminals() {
  if (shown.size === 0) return;
  showTerminals([], null);
}

// Forgets the terminal of the handle `id` (its tab is gone).
function dropTerminal(id: string) {
  const instance = instances.get(id);
  if (!instance) return;
  stop(instance);
  shown.delete(id);
  instance.term.dispose();
  instance.el.remove();
  instances.delete(id);
}

// Forgets every terminal whose handle `keep` does not accept (the sessions that left Orca's list, or the target changed).
export function pruneTerminals(keep: (id: string) => boolean) {
  for (const id of instances.keys()) if (!keep(id)) dropTerminal(id);
}

// What a failed send of typed keys does (the screen shows the message).
export function initOrcaTerminal(report: (e: unknown) => void) {
  onError = report;
  document.fonts?.ready.then(fitSoon).catch(() => {});
  // The system's appearance picks the light or the dark colors (unless the settings fix it, then a change of it draws nothing new).
  darkScheme.addEventListener("change", () => {
    if (themeColors && themeColors.appearance !== "system") return;
    applyTerminalSettings(settings);
  });
  // A hidden window stops the reads and the streams; shown again, the terminals that are shown start again (a stream sends its screen anew).
  document.addEventListener("visibilitychange", () => {
    for (const instance of shownInstances()) {
      if (document.hidden) stop(instance);
      else if (instance.host && !instance.host.hidden) start(instance);
    }
  });
}
