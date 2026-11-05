// What the page provides outside the modules: Tauri's global (`withGlobalTauri`) and the classic scripts of src/vendor/.
interface Window {
  __TAURI__: {
    core: {
      invoke(command: string, args?: unknown, options?: { headers: Record<string, string> }): Promise<unknown>;
      // A stream from Rust: it is passed as an argument of a command, and what Rust sends reaches `onmessage`.
      Channel: new <T>() => { onmessage: (message: T) => void };
    };
  };
}

declare const marked: { parse(markdown: string, options?: { breaks?: boolean }): string };
declare const DOMPurify: { sanitize(html: string, config?: Record<string, unknown>): string };

// xterm.js (src/vendor/xterm.js) and its fit addon (src/vendor/addon-fit.js): only what the terminal screen uses.
interface XTerm {
  cols: number;
  rows: number;
  open(parent: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  focus(): void;
  dispose(): void;
  loadAddon(addon: unknown): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
}
declare const Terminal: new (options?: Record<string, unknown>) => XTerm;
declare const FitAddon: { FitAddon: new () => { fit(): void } };
