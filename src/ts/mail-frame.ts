// The frame a mail's HTML body is shown in: what is cleaned before it is written, how its links are routed, and how it is sized.
// The mail's document can name elements after Document's own members (<img name="querySelectorAll">),
// which hides the real ones (DOM clobbering), so the prototype's are called explicitly.
export const queryAll = <E extends Element = Element>(doc: Document, selector: string) =>
  Document.prototype.querySelectorAll.call(doc, selector) as NodeListOf<E>;
const rootOf = Object.getOwnPropertyDescriptor(Document.prototype, "documentElement")!.get as (this: Document) => HTMLElement;

// The href getters are called through the prototypes for the same reason; they resolve the value against the document's <base>.
const hrefGetters = {
  a: Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "href")!.get as (this: Element) => string,
  area: Object.getOwnPropertyDescriptor(HTMLAreaElement.prototype, "href")!.get as (this: Element) => string,
};
const localNameOf = Object.getOwnPropertyDescriptor(Element.prototype, "localName")!.get as (this: Element) => string;

const setAttr = Element.prototype.setAttribute;

// Sends a mail's links to Rust. The frame's sandbox lets only a user's click navigate the top window (allow-top-navigation-by-user-activation),
// and Rust's on_navigation cancels that and opens an http(s) URL in the default browser. WebKit calls no listener this page adds to the
// frame's document (the sandbox has no allow-scripts), so the links are rewritten here instead:
// - http(s): target="_top", with the resolved URL as the title, so a link whose text says otherwise shows. This is WebKit's plain title
//   display, slow or absent like any plain title (see the tooltip); mouse moves inside the frame never reach this page, so nothing else can be shown;
// - a #anchor: target="_self", so neither the mail's <base target> nor its own target reaches the top window;
// - an empty href, and anything else that is not http(s) or a #anchor (mailto:, a relative link, about:, ...), loses its href:
//   it would reload the frame, or navigate it away from the mail.
// SVG <a> is left out: its href is not a string.
export function routeLinks(doc: Document) {
  for (const a of queryAll(doc, "a[href]:not(svg a), area[href]")) {
    const raw = Element.prototype.getAttribute.call(a, "href")!.trim();
    if (!raw) {
      Element.prototype.removeAttribute.call(a, "href");
      continue;
    }
    // A #anchor is left to the frame.
    const url = raw.startsWith("#") ? "" : hrefGetters[localNameOf.call(a) as "a" | "area"].call(a);
    const web = /^https?:/i.test(url);
    if (!web && !raw.startsWith("#")) {
      Element.prototype.removeAttribute.call(a, "href");
      continue;
    }
    setAttr.call(a, "target", web ? "_top" : "_self");
    if (web) setAttr.call(a, "title", url);
  }
}

// Frames waiting to be sized. All of them are measured first and written after, in one animation frame,
// so a mail of many images does not force a layout per image.
const fitting = new Set<HTMLIFrameElement>();
function fitFrame(frame: HTMLIFrameElement) {
  if (!fitting.size) {
    requestAnimationFrame(() => {
      const frames = [...fitting];
      fitting.clear();
      const heights = frames.map((frame) => {
        // null: the frame left the page before this frame.
        const root = frame.contentDocument && rootOf.call(frame.contentDocument);
        if (!root) return null;
        // Content taller than the frame overflows it, which scrollHeight reports; otherwise the root's own height is the content's.
        return Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
      });
      frames.forEach((frame, i) => {
        if (heights[i] !== null && frame.style.height !== `${heights[i]}px`) frame.style.height = `${heights[i]}px`;
      });
    });
  }
  fitting.add(frame);
}

// A frame in a hidden view is 0 wide, so a width change fits it once the view is shown (and after a window resize).
// Its own height changes are not acted on.
export const frameObserver = new ResizeObserver((entries) => {
  for (const { target, contentRect } of entries) {
    const frame = target as HTMLIFrameElement & { fitWidth?: number };
    if (frame.fitWidth !== contentRect.width) {
      frame.fitWidth = contentRect.width;
      fitFrame(frame);
    }
  }
});

// Fits the frame again once the images in its document have decoded (or failed to). No load listener is added to the document:
// WebKit does not call one in a frame without allow-scripts. The prototype's decode is called for the same reason as `queryAll`.
const decodeImage = HTMLImageElement.prototype.decode;
export function fitAfterImages(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument;
  if (!doc) return;
  // loading=lazy images may never start loading, so their decode may never settle; the frame observer and the next call cover them.
  Promise.allSettled([...queryAll<HTMLImageElement>(doc, "img:not([loading=lazy i])")].map((img) => decodeImage.call(img))).then(() => fitFrame(frame));
}

// Fits the frame when its document loads and when its images are in, then hands the document to `onLoad`.
export function autoFit(frame: HTMLIFrameElement, onLoad: (doc: Document) => void) {
  frame.onload = () => {
    fitFrame(frame);
    fitAfterImages(frame);
    onLoad(frame.contentDocument!);
  };
  frameObserver.observe(frame);
}

// Parses a mail with DOMParser (no script or nested frame runs, and no declarative shadow root is attached) and writes it back
// without what `routeLinks` cannot reach or what could move a frame: nested frames, <object>, <embed>, meta refresh, and
// declarative shadow roots, whose <template> is replaced by its content. A DOCTYPE is written back only if the mail had one, as it was,
// so the rendering mode does not change.
const BLOCKED = "iframe, frame, frameset, object, embed, meta[http-equiv=refresh i]";
const SHADOW_TEMPLATE = "template[shadowrootmode], template[shadowroot]";
const doctypeOf = Object.getOwnPropertyDescriptor(Document.prototype, "doctype")!.get as (this: Document) => DocumentType | null;
export function plainBody(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // A template's content may hold another, so one is unwrapped at a time.
  const nextTemplate = () => queryAll<HTMLTemplateElement>(doc, SHADOW_TEMPLATE)[0];
  for (let t = nextTemplate(); t; t = nextTemplate()) t.replaceWith(...t.content.childNodes);
  for (const el of queryAll(doc, BLOCKED)) el.remove();
  const doctype = doctypeOf.call(doc);
  return (doctype ? new XMLSerializer().serializeToString(doctype) : "") + rootOf.call(doc).outerHTML;
}

// Limits a mail to inline styles and data: images. The frame's sandbox has allow-same-origin, so with no scripts allowed
// here the missing allow-scripts would be the only guard. It goes after a leading DOCTYPE, which must stay first for standards mode.
const BODY_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
export const withBodyCsp = (html: string) =>
  /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${BODY_CSP}`) : BODY_CSP + html;
