// A-10: files pasted or dropped on a terminal of the Orca screen or in the pane of A-9. A file is taken as a File and kept in memory as base64; nothing is stored here.
// A terminal puts the file in `.orca/drops/` of its worktree at once (`orca_attach_file`) and types the path of the file in itself; the pane keeps the files (an image as a thumbnail, any other by its name) until the send, which adds the paths to the instruction.
// The window's own file drop is off (`dragDropEnabled` false), so a drop gives File objects to the page; a file dropped anywhere else must not make the webview navigate to it.
import type { AttachedFile } from "./bindings/AttachedFile";
import { tag } from "./dom.js";
import { CLOSE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";

export interface Attachment {
  id: number;
  name: string;
  // Whether the strip shows the file as a thumbnail (its type is an image); any other file is shown by its name.
  image: boolean;
  // The data: URL of the file, which an image's thumbnail shows (the CSP allows data:, not blob:); its base64 is what `orca_attach_file` takes.
  url: string;
  // What the upload answered, by worktree and target: a send that failed after the upload does not upload it again.
  uploaded: Map<string, AttachedFile>;
}

let lastId = 0;
// The elements that take files: a file dragged anywhere else is refused.
const zones = new Set<HTMLElement>();

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
const inZone = (target: EventTarget | null) => [...zones].some((zone) => zone.contains(target as Node | null));

function read(file: File): Promise<Attachment> {
  const image = file.type.startsWith("image/");
  const name = file.name || (image ? "image" : "file");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id: ++lastId, name, image, url: String(reader.result), uploaded: new Map() });
    reader.onerror = () => reject(new Error(`${name} を読めません`));
    reader.readAsDataURL(file);
  });
}

// `files` read; and the message of the file that could not be read (a folder cannot be), null when all were read. A file that cannot be read refuses the whole take.
export async function readFiles(files: File[]): Promise<{ files: Attachment[]; message: string | null }> {
  try {
    return { files: await Promise.all(files.map(read)), message: null };
  } catch (e) {
    return { files: [], message: e instanceof Error ? e.message : String(e) };
  }
}

// Uploads each file in order to the worktree at `path` of `target` and gives what each was answered (the text for Claude, and whether it is a bracketed paste). A failure rejects with the message; the files that went are remembered.
export async function uploadAttachments(attachments: Attachment[], path: string, target: string | null): Promise<AttachedFile[]> {
  const key = `${target ?? ""}\n${path}`;
  const files: AttachedFile[] = [];
  for (const a of attachments) {
    let file = a.uploaded.get(key);
    if (file === undefined) {
      file = await invoke("orca_attach_file", { path, name: a.name, data: a.url.slice(a.url.indexOf(",") + 1), environment: target });
      a.uploaded.set(key, file);
    }
    files.push(file);
  }
  return files;
}

// The files of `attachments` in `strip`, an image as a thumbnail and any other file by its name, each with a button that calls `remove`. The strip is hidden when there is none.
export function drawStrip(strip: HTMLElement, attachments: Attachment[], remove: (a: Attachment) => void) {
  strip.hidden = attachments.length === 0;
  strip.replaceChildren(
    ...attachments.map((a) => {
      const item = tag("div", "attachment");
      let shown: HTMLElement;
      if (a.image) {
        const image = tag("img");
        image.src = a.url;
        image.alt = a.name;
        shown = image;
      } else {
        shown = tag("span", "attachment-name");
        shown.textContent = a.name;
      }
      const button = tag("button", "icon-btn");
      button.type = "button";
      button.setAttribute("aria-label", `${a.name} を外す`);
      button.innerHTML = CLOSE_SVG;
      button.onclick = () => remove(a);
      item.append(shown, button);
      return item;
    }),
  );
}

// Makes `zone` take files: the files pasted (a paste with no file is left alone; a file copied in Finder is one) and the files dropped on it. A file dragged over it outlines it.
export function listenForFiles(zone: HTMLElement, take: (files: File[]) => void) {
  zones.add(zone);
  // Capturing: the terminal's own paste handler stops the event before it bubbles.
  zone.addEventListener(
    "paste",
    (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      take(files);
    },
    true,
  );
  zone.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
    zone.classList.add("dropping");
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget as Node | null)) zone.classList.remove("dropping");
  });
  zone.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    zone.classList.remove("dropping");
    take([...e.dataTransfer!.files]);
  });
}

// Anywhere else a dropped file would open in the webview: the drop is cancelled (a drag of something else, as a text, is left alone).
export function initFileDrops() {
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!inZone(e.target)) e.dataTransfer!.dropEffect = "none";
  });
  document.addEventListener("drop", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
}
