// The files of a reply (M-10) or of a new mail (M-11) being written (M-12): the clip beside "送信", a file dropped on the field or pasted in it, and the chips under the text (name, size, ×).
// The bytes are held in this module's memory as base64, never saved and never logged, and go to Rust with the mail (`send_mail`). Rust decides what may be added (`mail_attach_check`, and the dialog's pick, `mail_attach_pick`).
import type { OutgoingAttachment } from "./bindings/OutgoingAttachment";
import { tag } from "./dom.js";
import { showFailure } from "./error-card.js";
import { CLOSE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { listenForFiles } from "./orca-attach.js";

interface Held extends OutgoingAttachment {
  id: number;
  size: number;
}

// "980 B", "12 KB", "1.5 MB".
function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// The base64 of the file's bytes.
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error(`${file.name} を読めません`));
    reader.readAsDataURL(file);
  });
}

// `zone` takes dropped and pasted files, `open` (the clip) picks them in the dialog, and `strip` holds the chips (hidden while there is none). A failure shows on the card `card` (A-28).
export function mailAttachments(zone: HTMLElement, strip: HTMLElement, open: HTMLButtonElement, card: string) {
  let held: Held[] = [];
  let lastId = 0;
  let busy = false;
  // Counts the times the files were let go: a read that ends after that is for a mail that is gone.
  let epoch = 0;
  // The adds, one after another, so that each file is checked against what the ones before it added.
  let queue: Promise<void> = Promise.resolve();
  const total = () => held.reduce((n, f) => n + f.size, 0);

  function draw() {
    strip.hidden = held.length === 0;
    strip.replaceChildren(
      ...held.map((f) => {
        const chip = tag("span", "mail-attach-chip");
        const x = tag("button", "mail-reply-chip-x");
        x.type = "button";
        x.setAttribute("aria-label", `${f.name} を外す`);
        x.innerHTML = CLOSE_SVG;
        x.disabled = busy;
        x.onclick = () => {
          held = held.filter((h) => h.id !== f.id);
          draw();
        };
        chip.append(tag("span", "", f.name), tag("span", "mail-attach-size", sizeLabel(f.size)), x);
        return chip;
      }),
    );
  }

  // Runs `add` after the ones before it; a failure is shown, unless the files were let go meanwhile.
  function enqueue(add: (at: number) => Promise<void>) {
    if (busy) return;
    const at = epoch;
    queue = queue.then(() => add(at)).catch((e) => {
      if (at === epoch) showFailure(card, e);
    });
  }

  listenForFiles(zone, (files) =>
    enqueue(async (at) => {
      for (const file of files) {
        if (at !== epoch) return;
        const name = file.name || "file";
        await invoke("mail_attach_check", { name, size: file.size, held: total() });
        const data = await readBase64(file);
        if (at !== epoch) return;
        held.push({ id: ++lastId, name, size: file.size, data });
        draw();
      }
    }),
  );
  open.onclick = () =>
    enqueue(async (at) => {
      const picked = await invoke("mail_attach_pick", { held: total() });
      if (at !== epoch) return;
      held.push(...picked.map((p) => ({ id: ++lastId, name: p.name, size: p.size, data: p.data })));
      draw();
    });

  return {
    // What goes with the mail.
    files: (): OutgoingAttachment[] => held.map(({ name, data }) => ({ name, data })),
    // Lets every file go (the mail was sent or dropped).
    clear() {
      epoch++;
      held = [];
      draw();
    },
    // While a mail goes out, no file is added or taken off.
    setBusy(wait: boolean) {
      if (wait === busy) return;
      busy = wait;
      open.disabled = wait;
      draw();
    },
  };
}
