// A-10: images pasted or dropped on a terminal of the Orca screen or in the pane of A-9. An image is taken as a File and kept in memory as base64; nothing is stored here.
// A terminal puts the image in `.orca/drops/` of its worktree at once (`orca_attach_file`) and types the path of the file in itself; the pane keeps the images as thumbnails until the send, which adds the paths to the instruction.
// The window's own file drop is off (`dragDropEnabled` false), so a drop gives File objects to the page; a file dropped anywhere else must not make the webview navigate to it.
import type { AttachedFile } from "./bindings/AttachedFile";
import { tag } from "./dom.js";
import { CLOSE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";

export const ONLY_IMAGES = "画像だけを添付できます";

export interface Attachment {
  id: number;
  name: string;
  // The data: URL of the file, which the thumbnail shows (the CSP allows data:, not blob:); its base64 is what `orca_attach_file` takes.
  thumb: string;
  // What the upload answered, by worktree and target: a send that failed after the upload does not upload it again.
  uploaded: Map<string, AttachedFile>;
}

let lastId = 0;
// The elements that take images: a file dragged anywhere else is refused.
const zones = new Set<HTMLElement>();

const isImage = (file: File) => file.type.startsWith("image/");
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
const inZone = (target: EventTarget | null) => [...zones].some((zone) => zone.contains(target as Node | null));

function read(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ id: ++lastId, name: file.name || "image", thumb: url, uploaded: new Map() });
    };
    reader.onerror = () => reject(new Error(`${file.name || "画像"} を読めません`));
    reader.readAsDataURL(file);
  });
}

// The images among `files`, read; and the message of what was refused (a file that is not an image) or could not be read, null when there is none.
export async function readImages(files: File[]): Promise<{ images: Attachment[]; message: string | null }> {
  const images = files.filter(isImage);
  const refused = images.length < files.length ? ONLY_IMAGES : null;
  try {
    return { images: await Promise.all(images.map(read)), message: refused };
  } catch (e) {
    return { images: [], message: e instanceof Error ? e.message : String(e) };
  }
}

// Uploads each image in order to the worktree at `path` of `target` and gives what each was answered (the text for Claude, and whether it is a bracketed paste). A failure rejects with the message; the images that went are remembered.
export async function uploadAttachments(images: Attachment[], path: string, target: string | null): Promise<AttachedFile[]> {
  const key = `${target ?? ""}\n${path}`;
  const files: AttachedFile[] = [];
  for (const a of images) {
    let file = a.uploaded.get(key);
    if (file === undefined) {
      file = await invoke("orca_attach_file", { path, name: a.name, data: a.thumb.slice(a.thumb.indexOf(",") + 1), environment: target });
      a.uploaded.set(key, file);
    }
    files.push(file);
  }
  return files;
}

// The thumbnails of `images` in `strip`, each with a button that calls `remove`. The strip is hidden when there is none.
export function drawStrip(strip: HTMLElement, images: Attachment[], remove: (a: Attachment) => void) {
  strip.hidden = images.length === 0;
  strip.replaceChildren(
    ...images.map((a) => {
      const item = tag("div", "attachment");
      const image = tag("img");
      image.src = a.thumb;
      image.alt = a.name;
      const button = tag("button", "icon-btn");
      button.type = "button";
      button.setAttribute("aria-label", `${a.name} を外す`);
      button.innerHTML = CLOSE_SVG;
      button.onclick = () => remove(a);
      item.append(image, button);
      return item;
    }),
  );
}

// Makes `zone` take images: a pasted image (a paste with no image is left alone) and the files dropped on it, all of them, so `take` can refuse the ones that are not images. A file dragged over it outlines it.
export function listenForImages(zone: HTMLElement, take: (files: File[]) => void) {
  zones.add(zone);
  // Capturing: the terminal's own paste handler stops the event before it bubbles.
  zone.addEventListener(
    "paste",
    (e) => {
      const images = [...(e.clipboardData?.files ?? [])].filter(isImage);
      if (!images.length) return;
      e.preventDefault();
      e.stopPropagation();
      take(images);
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
