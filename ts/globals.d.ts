// What the page provides outside the modules: Tauri's global (`withGlobalTauri`) and the classic scripts of src/vendor/.
interface Window {
  __TAURI__: {
    core: {
      invoke(command: string, args?: unknown, options?: { headers: Record<string, string> }): Promise<unknown>;
      // A stream from Rust: it is passed as an argument of a command, and what Rust sends reaches `onmessage`.
      Channel: new <T>() => { onmessage: (message: T) => void };
    };
    // What Rust sends with `emit` (the Slack list's Socket Mode, S-16); the answer takes the listener off.
    event: {
      listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
    };
  };
}

declare const marked: { parse(markdown: string, options?: { breaks?: boolean }): string };
declare const DOMPurify: { sanitize(html: string, config?: Record<string, unknown>): string };

// xterm.js (src/vendor/xterm.js), its fit addon (src/vendor/addon-fit.js), its Unicode 11 addon (src/vendor/addon-unicode11.js) and its web links addon (src/vendor/addon-web-links.js): only what the terminals of the Orca screen use.
interface XTerm {
  cols: number;
  rows: number;
  // The widths of characters (Unicode 11, set when the addon is loaded); a proposed API of xterm.js, so the terminal is made with `allowProposedApi`.
  unicode: { activeVersion: string };
  open(parent: HTMLElement): void;
  // `callback` is called once the data is parsed.
  write(data: string, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  // Types `data` as a paste: wrapped in the bracketed-paste marks when the program asked for them (A-10).
  paste(data: string): void;
  // Drops the selection (a link that was opened leaves none, as in Orca).
  clearSelection(): void;
  hasSelection(): boolean;
  onSelectionChange(listener: () => void): { dispose(): void };
  dispose(): void;
  loadAddon(addon: unknown): void;
  onData(listener: (data: string) => void): { dispose(): void };
  // The options that are set while the terminal lives (A-13): the font of Ghostty's settings and the colors of the theme (A-14).
  options: { fontFamily: string; fontSize: number; fontWeight: string | number; theme: Record<string, unknown> };
  // `handler` gets the data of each OSC sequence with the number `ident` (OSC 52 asks for the clipboard); true says it was handled.
  parser: { registerOscHandler(ident: number, handler: (data: string) => boolean): { dispose(): void } };
  // `handler` is asked for each key event first; false keeps xterm.js from handling it.
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}
declare const Terminal: new (options?: Record<string, unknown>) => XTerm;
declare const FitAddon: { FitAddon: new () => { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined } };
declare const Unicode11Addon: { Unicode11Addon: new () => unknown };
// `handler` is called with the click on a link; `hover` and `leave` with the pointer over it; `urlRegex` finds the URLs in a line.
declare const WebLinksAddon: {
  WebLinksAddon: new (
    handler: (event: MouseEvent, uri: string) => void,
    options: { hover: (event: MouseEvent, uri: string) => void; leave: (event: MouseEvent, uri: string) => void; urlRegex: RegExp },
  ) => unknown;
};
