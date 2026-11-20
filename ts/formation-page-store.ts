// What the owner entered on a decision page, kept in the browser as it is entered and put back when the same page is drawn again (A-41, #1158). The key is made of the formation, the child and a hash of the page, so a page that the child wrote again starts clean. Where the browser refuses to keep anything (a full quota, a blocked store), the page works all the same, and leaving it with answers entered asks for confirmation.
import type { PageAnswer } from "./bindings/PageAnswer";
import type { PageVerdict } from "./bindings/PageVerdict";

export interface Saved {
  answers: PageAnswer[];
  verdict: PageVerdict | null;
  revision: string;
}

export interface Store {
  // The answers kept for this page, null when there are none or the store cannot be read.
  read: () => Saved | null;
  // Keeps what `snapshot` gives once the owner has stopped entering for `KEEP_DELAY` ms (a write for each character would read every card each time).
  keep: (snapshot: () => Saved) => void;
  // Forgets what was kept, and drops a write that waits.
  forget: () => void;
}

// How long after the last entry the answers are written.
const KEEP_DELAY = 300;

// A 32-bit FNV-1a hash of `text` in hex: the page's part of the key.
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Whether `saved` holds anything the owner entered.
export const entered = (saved: Saved) => saved.verdict !== null || saved.revision !== "" || saved.answers.some((a) => a.choice !== null || a.note !== "" || a.provisional);

// The pages that ask for confirmation when the window is left: those whose answers could not be kept, while they hold some. `flush` writes what waits, so that a page drawn again, or a window that is left, takes it.
interface Guard {
  anchor: HTMLElement;
  flush: () => void;
  holds: () => boolean;
}
const guards = new Set<Guard>();
function flushAll() {
  for (const guard of guards) {
    // A page that is gone from the document keeps nothing more.
    if (!guard.anchor.isConnected) guards.delete(guard);
    else guard.flush();
  }
}
window.addEventListener("beforeunload", (e) => {
  flushAll();
  for (const guard of guards) {
    if (guard.holds()) {
      e.preventDefault();
      e.returnValue = "";
      return;
    }
  }
});
window.addEventListener("pagehide", flushAll);

// The part of a key that the pages of one child share, and what follows it in the key of a page.
const keyStart = (formation: string, child: string) => `fp-answers:${formation}\n${child}:`;
const PAGE_HASH = /^[0-9a-f]{8}$/;

// Takes away what the earlier pages of the same child kept (their hash is another), which nothing reads any more.
function dropStale(store: Storage, start: string, key: string) {
  const stale: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const name = store.key(i);
    if (name !== null && name !== key && name.startsWith(start) && PAGE_HASH.test(name.slice(start.length))) stale.push(name);
  }
  for (const name of stale) store.removeItem(name);
}

// `anchor` is the page's element, and `unsaved` tells whether it holds answers.
export function openStore(formation: string, child: string, page: unknown, anchor: HTMLElement, unsaved: () => boolean): Store {
  const start = keyStart(formation, child);
  const key = `${start}${hash(JSON.stringify(page))}`;
  let broken = false;
  let store: Storage | null = null;
  try {
    store = window.localStorage;
    store.setItem(`${key}:probe`, "1");
    store.removeItem(`${key}:probe`);
  } catch {
    store = null;
    broken = true;
  }
  // What an earlier page of this child entered and has not been written yet is written before this page reads.
  flushAll();
  if (store !== null) {
    try {
      dropStale(store, start, key);
    } catch {
      // What cannot be taken away stays; the page works all the same.
    }
  }
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let snapshotOf: (() => Saved) | null = null;
  const flush = () => {
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
    const take = snapshotOf;
    snapshotOf = null;
    if (take !== null) write(take());
  };
  const write = (saved: Saved) => {
    try {
      if (!entered(saved)) store?.removeItem(key);
      else store?.setItem(key, JSON.stringify(saved));
    } catch {
      store = null;
      broken = true;
    }
  };
  guards.add({ anchor, flush, holds: () => broken && unsaved() });
  return {
    read() {
      try {
        const text = store?.getItem(key);
        const saved = text ? (JSON.parse(text) as Partial<Saved>) : null;
        return saved !== null && Array.isArray(saved.answers) ? { answers: saved.answers, verdict: saved.verdict ?? null, revision: saved.revision ?? "" } : null;
      } catch {
        return null;
      }
    },
    keep(snapshot) {
      snapshotOf = snapshot;
      if (waiting === null) waiting = setTimeout(flush, KEEP_DELAY);
    },
    forget() {
      if (waiting !== null) clearTimeout(waiting);
      waiting = null;
      snapshotOf = null;
      try {
        store?.removeItem(key);
      } catch {
        store = null;
        broken = true;
      }
    },
  };
}
