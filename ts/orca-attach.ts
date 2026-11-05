// A-10: the images attached in the composer of the Orca screen. An image is taken by paste (the textarea) or by drop (the composer form), shown as a thumbnail above the composer, and kept in memory as base64 until the post.
// A post puts each image in `.orca/drops/` of its worktree (`orca_attach_image`), which answers the text for Claude (the path of the file); orca.ts adds those lines to the text it posts. Nothing is stored here.
// The window's own file drop is off (`dragDropEnabled` false), so a drop gives File objects to the page; a file dropped anywhere else must not make the webview navigate to it.
import { $, tag } from "./dom.js";
import { svgOf } from "./icons.js";
import { invoke } from "./ipc.js";

const CLOSE_SVG = svgOf('<path d="M6 6l12 12M18 6L6 18"/>');
export const ONLY_IMAGES = "画像だけを添付できます";

interface Attachment {
  name: string;
  // Base64 of the file, as `orca_attach_image` takes it.
  data: string;
  // The data: URL the thumbnail shows (the CSP allows data:, not blob:).
  thumb: string;
  // The text for Claude of the upload, by worktree and target: a post that failed after the upload does not upload it again.
  uploaded: Map<string, string>;
}

let attachments: Attachment[] = [];
// What the screen gives: `busy` (a post is on its way: nothing is added or removed), `changed` (the composer's button follows) and `fail` (the post error line; null clears it).
let screen: { busy: () => boolean; changed: () => void; fail: (message: string | null) => void };

export const hasAttachments = () => attachments.length > 0;

export function clearAttachments() {
  attachments = [];
  drawStrip();
}

const isImage = (file: File) => file.type.startsWith("image/");

function read(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ name: file.name || "image", data: url.slice(url.indexOf(",") + 1), thumb: url, uploaded: new Map() });
    };
    reader.onerror = () => reject(new Error(`${file.name || "画像"} を読めません`));
    reader.readAsDataURL(file);
  });
}

function drawStrip() {
  const strip = $("orca-attachments");
  strip.hidden = attachments.length === 0;
  strip.replaceChildren(
    ...attachments.map((a) => {
      const item = tag("div", "orca-attachment");
      const image = tag("img");
      image.src = a.thumb;
      image.alt = a.name;
      const remove = tag("button", "icon-btn");
      remove.type = "button";
      remove.setAttribute("aria-label", `${a.name} を外す`);
      remove.innerHTML = CLOSE_SVG;
      remove.onclick = () => {
        if (screen.busy()) return;
        attachments = attachments.filter((x) => x !== a);
        drawStrip();
        screen.changed();
      };
      item.append(image, remove);
      return item;
    }),
  );
}

// Adds the images among `files`; a file that is not an image is refused with the message of the post error.
async function add(files: File[]) {
  if (screen.busy()) return;
  const images = files.filter(isImage);
  screen.fail(images.length < files.length ? ONLY_IMAGES : null);
  try {
    attachments = [...attachments, ...(await Promise.all(images.map(read)))];
  } catch (e) {
    screen.fail(e instanceof Error ? e.message : String(e));
  }
  drawStrip();
  screen.changed();
}

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

// Uploads each image in order to the worktree at `path` of `target` and gives the text for Claude of each. A failure rejects with the message and leaves the images; the ones that went are remembered.
export async function uploadAttachments(path: string, target: string | null): Promise<string[]> {
  const key = `${target ?? ""}\n${path}`;
  const lines: string[] = [];
  for (const a of attachments) {
    let line = a.uploaded.get(key);
    if (line === undefined) {
      line = await invoke("orca_attach_image", { path, name: a.name, data: a.data, environment: target });
      a.uploaded.set(key, line);
    }
    lines.push(line);
  }
  return lines;
}

export function initOrcaAttach(hooks: typeof screen) {
  screen = hooks;
  const form = $("orca-form");
  // A pasted image is taken; a paste with no image is left to the textarea.
  $("orca-input").addEventListener("paste", (e) => {
    const images = [...((e as ClipboardEvent).clipboardData?.files ?? [])].filter(isImage);
    if (!images.length) return;
    e.preventDefault();
    add(images);
  });
  form.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
    form.classList.add("dropping");
  });
  form.addEventListener("dragleave", (e) => {
    if (!form.contains(e.relatedTarget as Node | null)) form.classList.remove("dropping");
  });
  form.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    form.classList.remove("dropping");
    add([...e.dataTransfer!.files]);
  });
  // Anywhere else a dropped file would open in the webview: the drop is cancelled (a drag of something else, as a text, is left alone).
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!form.contains(e.target as Node)) e.dataTransfer!.dropEffect = "none";
  });
  document.addEventListener("drop", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
}
