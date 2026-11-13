// Loads the libraries of src/vendor/ that only the Orca screens use, the first time one is wanted and not at start-up.
// Each group is read once: the scripts keep their order, and a failed read is tried again at the next ask, only for the scripts that failed.
// The paths are inside vendor/, so the CSP (`script-src 'self'`) is as it was.

const TERMINAL = ["vendor/xterm.js", "vendor/addon-fit.js", "vendor/addon-unicode11.js", "vendor/addon-web-links.js"];
const HIGHLIGHT = ["vendor/highlight.min.js", "vendor/highlight-languages.js"];
const MILKDOWN = ["vendor/milkdown.js"];

const loading = new Map<string, Promise<void>>();
const loaded = new Set<string>();
// The read of each script, kept while it is on its way or done; a failed one is let go, so the next ask reads it alone.
const scripts = new Map<string, Promise<void>>();

function script(src: string) {
  let read = scripts.get(src);
  if (!read) {
    read = add(src);
    scripts.set(src, read);
    read.catch(() => scripts.delete(src));
  }
  return read;
}

function add(src: string) {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    // A script added by code runs in the order it was added only when `async` is off.
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => {
      el.remove();
      reject(new Error(`${src} を読めませんでした`));
    };
    document.head.append(el);
  });
}

function once(group: string, srcs: string[]) {
  let pending = loading.get(group);
  if (!pending) {
    pending = Promise.all(srcs.map(script)).then(
      () => {
        loaded.add(group);
      },
      (e) => {
        loading.delete(group);
        throw e;
      },
    );
    loading.set(group, pending);
  }
  return pending;
}

// xterm.js and its three addons (the terminals, A-8 and A-9).
export const loadTerminalLibs = () => once("terminal", TERMINAL);
export const terminalLibsReady = () => loaded.has("terminal");

// highlight.js and its added grammars (the colors of the editor and the diff, A-21 and A-24).
export const loadHighlight = () => once("highlight", HIGHLIGHT);
export const highlightReady = () => loaded.has("highlight");

// Milkdown (the rich view of a Markdown file in the editor, A-26): one file that scripts/build-milkdown.mjs bundles.
export const loadMilkdown = () => once("milkdown", MILKDOWN);
