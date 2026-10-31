// The external and cid: images of a mail: showing them, and remembering which senders' images are shown without asking.
import type { MessageDetail } from "./bindings/MessageDetail";
import { $ } from "./dom.js";
import { invoke } from "./ipc.js";
import { fitAfterImages, queryAll } from "./mail-frame.js";
import { showError } from "./view.js";

// `cids` resolves to the cid: images Rust fetched after the body, by message ID;
// `senders` to the Set of the thread's senders Rust remembers (`froms` asked about); `stale()` tells another thread was opened since.
export interface ThreadCtx {
  cids: Promise<Record<string, Record<string, string>>>;
  froms: string[];
  senders: Promise<Set<string>>;
  stale: () => boolean;
}

// The https image URLs of a loaded mail, once each. The images are not fetched: the frame's CSP allows data: only.
export const externalImages = (doc: Document) => [
  ...new Set(
    [...queryAll(doc, "img[src]")].map((i) => i.getAttribute("src")!.trim()).filter((s) => /^https:\/\//i.test(s)),
  ),
];

// The cid: images Rust had to fetch after the body was shown: swaps each reference in the loaded document's
// src, background and style attributes and <style> text for its data: URI. `uris` is {reference as written: URI}.
const CID_REF = /cid:[^"')<>\\\s]+/gi;
export function showCidImages(doc: Document, uris: Record<string, string>) {
  const swap = (text: string) => text.replace(CID_REF, (ref) => uris[ref] ?? ref);
  for (const el of queryAll(doc, "[src], [background], [style]")) {
    for (const name of ["src", "background", "style"]) {
      const value = Element.prototype.getAttribute.call(el, name) as string | null;
      if (value === null) continue;
      const swapped = swap(value);
      if (swapped !== value) Element.prototype.setAttribute.call(el, name, swapped);
    }
  }
  for (const style of queryAll(doc, "style")) {
    const swapped = swap(style.textContent!);
    if (swapped !== style.textContent) style.textContent = swapped;
  }
}

// Rust fetches the images, and the loaded document's images get them as data: URIs. Throws when none could be shown.
async function showImages(urls: string[], frame: HTMLIFrameElement, ctx: ThreadCtx) {
  const images = await invoke("fetch_images", { urls });
  // Another thread was opened meanwhile, and this frame is gone.
  if (ctx.stale()) return;
  const doc = frame.contentDocument!;
  let shown = 0;
  for (const img of queryAll<HTMLImageElement>(doc, "img[src]")) {
    const data = images[img.getAttribute("src")!.trim()];
    if (!data) continue;
    // The browser prefers srcset, and a <picture>'s <source>, over src.
    img.removeAttribute("srcset");
    img.closest("picture")?.querySelectorAll("source").forEach((source) => source.remove());
    img.setAttribute("src", data);
    shown++;
  }
  if (!shown) throw "画像を取得できませんでした";
  fitAfterImages(frame);
}

// A bar above a mail's frame with one button. The bar goes when `onClick` succeeds; a failure is shown.
function imagesBar(label: string, onClick: () => Promise<void>) {
  const bar = document.createElement("div");
  bar.className = "images-bar";
  const button = document.createElement("button");
  button.className = "text-btn";
  button.textContent = label;
  button.onclick = async () => {
    $("error").hidden = true;
    button.disabled = true;
    try {
      await onClick();
      bar.remove();
    } catch (e) {
      button.disabled = false;
      showError(e);
    }
  };
  bar.append(button);
  return bar;
}

// The "画像を表示" bars of the open thread that are still up.
const waiting = new Set<{ m: MessageDetail; frame: HTMLIFrameElement; urls: string[]; bar: HTMLElement }>();
// The "この送信者の画像を自動で表示しない" bars of the open thread that are still up.
const forgettable = new Set<{ m: MessageDetail; bar: HTMLElement }>();

// Opening a thread drops the bars of the one before.
export function resetImageBars() {
  waiting.clear();
  forgettable.clear();
}

// The ones of `froms` whose sender Rust remembers, as a Set.
export async function knownSenders(froms: string[]) {
  if (!froms.length) return new Set<string>();
  try {
    return new Set(await invoke("image_sender_known", { froms }));
  } catch (e) {
    showError(e);
    return new Set<string>();
  }
}

// Asks Rust again after a sender was remembered or forgotten. Rust matches by address, so the display name does not matter.
const refreshSenders = (ctx: ThreadCtx) => (ctx.senders = knownSenders(ctx.froms));

// Shows the mail's external images: at once when its sender is remembered and Gmail vouches for the sender (a forged From
// can name a remembered one), with a bar to forget the sender; otherwise, or when that fetch fails, behind a bar whose
// button shows them and remembers the sender.
export async function offerImages(m: MessageDetail, frame: HTMLIFrameElement, urls: string[], ctx: ThreadCtx) {
  if (m.authenticated && (await ctx.senders).has(m.from)) {
    try {
      await showImages(urls, frame, ctx);
      if (ctx.stale()) return;
      const bar = imagesBar("この送信者の画像を自動で表示しない", async () => {
        await invoke("forget_image_sender", { from: m.from });
        // The thread's other messages from this sender no longer show theirs by themselves either.
        const known = await refreshSenders(ctx);
        forgettable.forEach((f) => {
          if (!known.has(f.m.from)) {
            f.bar.remove();
            forgettable.delete(f);
          }
        });
      });
      forgettable.add({ m, bar });
      frame.before(bar);
      return;
    } catch {
      // No error: the bar below fetches again.
    }
  }
  if (ctx.stale()) return;
  const bar = imagesBar("画像を表示", async () => {
    await showImages(urls, frame, ctx);
    waiting.delete(entry);
    // The images are shown, so a failure to remember is only reported. The thread's other messages may be from this sender too.
    invoke("remember_image_sender", { from: m.from })
      .then(() => refreshSenders(ctx))
      .then(() => {
        if (ctx.stale()) return;
        [...waiting].forEach((w) => {
          w.bar.remove();
          waiting.delete(w);
          offerImages(w.m, w.frame, w.urls, ctx);
        });
      })
      .catch(showError);
  });
  const entry = { m, frame, urls, bar };
  waiting.add(entry);
  frame.before(bar);
}
