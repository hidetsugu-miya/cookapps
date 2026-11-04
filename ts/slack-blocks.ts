// The blocks (Block Kit) and attachments of a Slack message in the thread (S-11), drawn from what Rust made of them (src-tauri/src/slack_blocks.rs).
// Rust decides what is drawn and which addresses may be opened or fetched; this only builds the nodes. Every text is put in as text, and only its URLs become links (`linkify`).
// An image is drawn only after the user asked for the images of its message; until then it is left out, and with no address (or when it could not be fetched) its description is drawn as text.
import type { ThreadAttachment } from "./bindings/ThreadAttachment";
import type { ThreadBlock } from "./bindings/ThreadBlock";
import type { ThreadButton } from "./bindings/ThreadButton";
import type { ThreadImage } from "./bindings/ThreadImage";
import { tag } from "./dom.js";
import { linkify } from "./mail-text.js";

// `shown`: the images of this message were asked for. `uris`: the fetched images (data: URIs) by address.
export interface ImageContext {
  shown: boolean;
  uris: ReadonlyMap<string, string>;
}

function paragraph(text: string, className = "st-text") {
  const p = tag("p", className);
  p.append(...linkify(text));
  return p;
}

// A button with an address is a link (Rust's navigation hook opens it in the default browser); one without cannot be pressed, and only its name shows.
function buttonNode(b: ThreadButton) {
  if (!b.url) {
    const off = tag("button", "text-btn", b.text);
    off.disabled = true;
    return off;
  }
  const link = tag("a", "text-btn", b.text);
  link.href = b.url;
  return link;
}

function imageNode(img: ThreadImage, ctx: ImageContext, className: string) {
  const uri = img.url && ctx.shown ? ctx.uris.get(img.url) : undefined;
  if (uri) {
    const el = tag("img", className);
    el.src = uri;
    el.alt = img.alt;
    return el;
  }
  // Waiting for the user's press: nothing yet. Otherwise the description stands in for the image.
  if (img.url && !ctx.shown) return null;
  return img.alt ? tag("span", "st-alt", img.alt) : null;
}

function blockNode(b: ThreadBlock, ctx: ImageContext): Node | null {
  switch (b.type) {
    case "header":
      return tag("h3", "st-bh", b.text);
    case "section": {
      const box = tag("div", "st-sec");
      const main = tag("div", "st-sec-main");
      if (b.text) main.append(paragraph(b.text));
      if (b.fields.length) {
        const fields = tag("div", "st-fields");
        fields.append(...b.fields.map((f) => paragraph(f)));
        main.append(fields);
      }
      box.append(main);
      const accessory = b.accessory && (b.accessory.type === "button" ? buttonNode(b.accessory) : imageNode(b.accessory, ctx, "st-acc-img"));
      if (accessory) box.append(accessory);
      return box;
    }
    case "context": {
      const row = tag("div", "st-ctx");
      for (const e of b.elements) {
        if (e.type === "text") {
          const span = tag("span");
          span.append(...linkify(e.text));
          row.append(span);
        } else {
          const image = imageNode(e, ctx, "st-ctx-img");
          if (image) row.append(image);
        }
      }
      return row;
    }
    case "divider":
      return tag("hr", "st-hr");
    case "image": {
      const box = tag("div", "st-bimg");
      if (b.title) box.append(paragraph(b.title));
      const image = imageNode(b.image, ctx, "st-img");
      if (image) box.append(image);
      return box.childNodes.length ? box : null;
    }
    case "actions": {
      const row = tag("div", "st-acts");
      row.append(...b.buttons.map(buttonNode));
      return row;
    }
  }
}

export function blocksNode(blocks: ThreadBlock[], ctx: ImageContext) {
  const box = tag("div", "st-blocks");
  for (const b of blocks) {
    const node = blockNode(b, ctx);
    if (node) box.append(node);
  }
  return box;
}

export function attachmentNode(a: ThreadAttachment, ctx: ImageContext) {
  const box = tag("div", "st-att");
  // Rust passes a hex color only.
  if (a.color) box.style.setProperty("--att", a.color);
  if (a.pretext) box.append(paragraph(a.pretext));
  if (a.authorName) box.append(tag("p", "st-att-author", a.authorName));
  if (a.title) {
    if (a.titleLink) {
      const link = tag("a", "st-att-title", a.title);
      link.href = a.titleLink;
      box.append(link);
    } else box.append(tag("p", "st-att-title", a.title));
  }
  if (a.text) box.append(paragraph(a.text));
  if (a.fields.length) {
    const fields = tag("div", "st-fields");
    for (const f of a.fields) {
      const field = tag("div", "st-field");
      if (f.title) field.append(tag("b", "", f.title));
      if (f.value) field.append(paragraph(f.value));
      fields.append(field);
    }
    box.append(fields);
  }
  if (a.blocks.length) box.append(blocksNode(a.blocks, ctx));
  if (a.actions.length) {
    const row = tag("div", "st-acts");
    row.append(...a.actions.map(buttonNode));
    box.append(row);
  }
  if (a.footer) box.append(tag("p", "st-att-foot", a.footer));
  if (a.fallback) box.append(paragraph(a.fallback));
  return box;
}
