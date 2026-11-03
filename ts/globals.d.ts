// What the page provides outside the modules: Tauri's global (`withGlobalTauri`) and the two classic scripts of src/vendor/.
interface Window {
  __TAURI__: { core: { invoke(command: string, args?: unknown, options?: { headers: Record<string, string> }): Promise<unknown> } };
}

declare const marked: { parse(markdown: string, options?: { breaks?: boolean }): string };
declare const DOMPurify: { sanitize(html: string, config?: Record<string, unknown>): string };
