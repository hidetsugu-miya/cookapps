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
  // Keeps `saved`, or forgets what was kept when it is null.
  write: (saved: Saved | null) => void;
}

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

// The pages that ask for confirmation when the window is left: those whose answers could not be kept, while they hold some.
interface Guard {
  anchor: HTMLElement;
  holds: () => boolean;
}
const guards = new Set<Guard>();
window.addEventListener("beforeunload", (e) => {
  for (const guard of guards) {
    // A page that is gone from the document needs no confirmation.
    if (!guard.anchor.isConnected) guards.delete(guard);
    else if (guard.holds()) {
      e.preventDefault();
      e.returnValue = "";
      return;
    }
  }
});

// `anchor` is the page's element, and `unsaved` tells whether it holds answers.
export function openStore(formation: string, child: string, page: unknown, anchor: HTMLElement, unsaved: () => boolean): Store {
  const key = `fp-answers:${formation}\n${child}:${hash(JSON.stringify(page))}`;
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
  guards.add({ anchor, holds: () => broken && unsaved() });
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
    write(saved) {
      try {
        if (saved === null || !entered(saved)) store?.removeItem(key);
        else store?.setItem(key, JSON.stringify(saved));
      } catch {
        store = null;
        broken = true;
      }
    },
  };
}
