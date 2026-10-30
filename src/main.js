const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

// Gmail snippets arrive HTML-escaped (e.g. &#39;).
const unescapeHtml = (s) => new DOMParser().parseFromString(s, "text/html").documentElement.textContent;

// Short list date: today "9:05", this year "10月17日", older "2025/10/17".
function formatDate(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// A From header or one To entry as {name, address}: `Name <addr>` splits; anything else is an address with no name.
function splitAddress(s) {
  const m = s.match(/^\s*"?(.*?)"?\s*<([^>]*)>\s*$/);
  return m ? { name: m[1], address: m[2] } : { name: "", address: s.trim() };
}

// Display name of a From header: the Name of `Name <addr>`, else the address.
function senderName(from) {
  const { name, address } = splitAddress(from);
  return name || address;
}

// The entries of a To header, split at commas outside double quotes.
// shortcut: a backslash-escaped quote inside a quoted name is not understood, upgrade if such a header shows up.
function splitRecipients(to) {
  const entries = [];
  let entry = "";
  let quoted = false;
  for (const c of to) {
    if (c === '"') quoted = !quoted;
    if (c === "," && !quoted) {
      entries.push(entry);
      entry = "";
    } else {
      entry += c;
    }
  }
  entries.push(entry);
  return entries.map((e) => e.trim()).filter(Boolean);
}

// The To line of a message: "To 自分" when `account` is among the recipients, else the recipients' names (or addresses); "" with no To.
function recipientsLabel(to, account) {
  const people = splitRecipients(to).map(splitAddress);
  if (!people.length) return "";
  if (people.some((p) => p.address.toLowerCase() === account.toLowerCase())) return "To 自分";
  return `To ${people.map((p) => p.name || p.address).join(", ")}`;
}

// Date of a message in the detail view: today "7:12（30 分前）", this year "10月29日 13:05", older "2025/10/17 13:05".
function formatDetailDate(ms, now = Date.now()) {
  const d = new Date(ms);
  const clock = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() !== new Date(now).toDateString()) return `${formatDate(ms, now)} ${clock}`;
  const minutes = Math.max(1, Math.floor((now - ms) / 60000));
  return `${clock}（${minutes < 60 ? `${minutes} 分前` : `${Math.floor(minutes / 60)} 時間前`}）`;
}

// Up to two initials (first letters of the first two words), uppercased.
function initials(name) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0])
      .join("")
      .toUpperCase() || "?"
  );
}

// Same string, same color; no image is fetched from outside.
function avatarColor(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
const TODO_SVG = $("thread-todo").innerHTML.trim();

// #main scrolls both the list and the thread, so each view keeps its own position.
let listScroll = 0;

function show(view) {
  if (!$("threads").hidden) listScroll = $("main").scrollTop;
  // The calendar and Todo screens bring their own header.
  const own = view === "calendar" || view === "todo" || view === "settings";
  $("calendar").hidden = view !== "calendar";
  $("todo").hidden = view !== "todo";
  $("settings").hidden = view !== "settings";
  $("mail-header").hidden = own;
  $("main").hidden = own;
  $("login").hidden = view !== "login";
  $("relogin").hidden = view !== "list" || !$("relogin").hasChildNodes();
  $("threads").hidden = view !== "list";
  $("reload").hidden = view !== "list";
  $("thread").hidden = view !== "thread";
  $("back").hidden = view !== "thread";
  $("thread-slack").hidden = view !== "thread";
  $("thread-todo").hidden = view !== "thread";
  $("trash").hidden = view !== "thread";
  $("archive").hidden = view !== "thread";
  $("mail-header").classList.toggle("detail", view === "thread");
  $("title").hidden = view === "thread";
  $("main").scrollTop = view === "list" ? listScroll : 0;
}

function showError(e) {
  $("error").textContent = String(e);
  $("error").hidden = false;
}

// Puts the row in its section, unread above read, in date order.
function place(li, unread) {
  const list = $(unread ? "unread-threads" : "read-threads");
  const next = [...list.children].find((c) => Number(c.dataset.dateMs) < Number(li.dataset.dateMs));
  list.insertBefore(li, next || null);
}

// Reflects the read state in the row: bold, dot, checkbox, and its section.
function setReadState(t, li, read) {
  const moves = li.isConnected && li.classList.contains("unread") === read;
  t.unread = !read;
  li.classList.toggle("unread", !read);
  if (moves) place(li, !read);
  const box = li.querySelector(".read-box");
  box.checked = read;
  box.setAttribute("aria-label", read ? "未読にする" : "既読にする");
}

// Updates UNREAD in Gmail; `control` is disabled while sending. On failure the row returns to its last known state.
async function sendRead(t, li, read, control) {
  $("error").hidden = true;
  // The row moves to the other section, which drops the focus; keyboard users keep it on the control.
  const focused = document.activeElement === control;
  control.disabled = true;
  try {
    const done = await invoke("set_read", { account: t.account, id: t.id, read });
    if (done === null) return load();
    setReadState(t, li, read);
  } catch (e) {
    setReadState(t, li, !t.unread);
    showError(e);
  } finally {
    control.disabled = false;
    if (focused && control.isConnected) control.focus();
    updateBadge();
  }
}

// Round checkbox mirroring the read state: checked = read. Toggling it updates UNREAD in Gmail.
function readBox(t, li) {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "read-box";
  // The row opens the thread on click; the checkbox must not.
  box.onclick = (e) => e.stopPropagation();
  box.onchange = () => sendRead(t, li, box.checked, box);
  return box;
}

// Icon button shown in place of the date on hover; it must not open the thread.
function rowButton(className, label, svg, action) {
  const button = document.createElement("button");
  button.className = `row-btn ${className}`;
  button.setAttribute("aria-label", label);
  button.innerHTML = svg;
  button.onclick = (e) => {
    e.stopPropagation();
    action(button);
  };
  return button;
}

// Threads being archived / trashed ("account/id"); a list reload or sync must not bring them back meanwhile.
const pending = new Set();

// The rows on screen by "account/id": the thread data and its <li>.
let rows = new Map();
const rowKey = (t) => `${t.account}/${t.id}`;

// Unread threads among `rows`, minus those being archived / trashed.
const countUnread = (rows, pending) => [...rows].filter(([key, r]) => r.t.unread && !pending.has(key)).length;

// The count on a sidebar button (99+ from 100; none for 0). The label carries it too: the tooltip shows the label, e.g. "受信トレイ（未読 3 件）".
function setNavCount(id, count, name, kind) {
  const b = $(id);
  const badge = b.querySelector(".nav-count");
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : String(count);
  b.setAttribute("aria-label", count === 0 ? name : `${name}（${kind} ${count} 件）`);
}

// Dock badge and the inbox button show the unread count of the list; the calls are skipped when the count is unchanged.
let badge = 0;
function updateBadge() {
  const count = countUnread(rows, pending);
  if (count === badge) return;
  badge = count;
  setNavCount("nav-mail", count, "受信トレイ", "未読");
  invoke("set_badge", { count }).catch(() => {});
}

// What the last archive / trash did, for "元に戻す" and Cmd+Z: the command that reverses it and the thread data to put back.
// One only; a newer removal replaces it.
let lastRemoved = null;
let removeSeq = 0; // taken when a removal starts, so a slower older one cannot replace a newer one
let rememberedSeq = 0;
const REMOVALS = {
  archive: { undo: "unarchive", message: "アーカイブしました" },
  trash: { undo: "untrash", message: "ゴミ箱へ移動しました" },
};

// Takes the row out at once and runs "archive" / "trash" in the background; on failure the row comes back.
async function removeRow(command, account, id, li) {
  const key = `${account}/${id}`;
  const t = rows.get(key)?.t;
  const seq = ++removeSeq;
  pending.add(key);
  li.remove();
  updateBadge();
  $("error").hidden = true;
  try {
    const done = await invoke(command, { account, id });
    if (done === null) return load();
    rows.delete(key);
    if (t && seq > rememberedSeq) {
      rememberedSeq = seq;
      lastRemoved = { undo: REMOVALS[command].undo, account, id, t };
      toast(REMOVALS[command].message, { label: "元に戻す", run: undoRemove });
    }
  } catch (e) {
    // Back by the state it has now: a mark-as-read meanwhile moves it to the read section.
    place(li, li.classList.contains("unread"));
    showError(e);
  } finally {
    pending.delete(key);
    updateBadge();
  }
}

// Reverses the last removal in Gmail and puts the row back in date order; on failure it stays available.
async function undoRemove() {
  const op = lastRemoved;
  if (!op) return;
  lastRemoved = null;
  toastEl.hidden = true;
  $("error").hidden = true;
  try {
    const done = await invoke(op.undo, { account: op.account, id: op.id });
    if (done === null) return load();
    applyChanges([op.t], []);
    toast("元に戻しました");
  } catch (e) {
    lastRemoved ??= op;
    showError(e);
  }
}

function row(t) {
  const li = document.createElement("li");
  li.dataset.dateMs = t.dateMs;
  const cell = (cls, text) => {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    return span;
  };
  const subject = cell("subject", t.subject || "(件名なし)");
  subject.append(cell("snippet", ` — ${unescapeHtml(t.snippet)}`));
  li.onclick = () => openThread(t, li);
  const name = senderName(t.from);
  const avatar = cell("avatar", initials(name));
  avatar.style.background = avatarColor(name);
  // Marks which account the thread belongs to.
  const dot = cell("account-dot", "");
  dot.style.background = avatarColor(t.account);
  dot.title = t.account;
  avatar.append(dot);
  // The date and the hover buttons share one grid cell.
  const trail = cell("trail", "");
  const actions = cell("row-actions", "");
  actions.append(
    rowButton("archive-row", "アーカイブ", CHECK_SVG, () => removeRow("archive", t.account, t.id, li)),
    rowButton("trash-row", "ゴミ箱へ移動", $("trash").innerHTML, () => removeRow("trash", t.account, t.id, li)),
    rowButton("todo-row", "Todo にする", TODO_SVG, (button) => makeTodo(t.account, t.id, t.subject, button)),
  );
  trail.append(cell("date", formatDate(t.dateMs)), actions);
  li.append(readBox(t, li), cell("unread-dot", ""), avatar, cell("from", name), subject, trail);
  setReadState(t, li, !t.unread);
  return li;
}

// The mail's document can name elements after Document's own members (<img name="querySelectorAll">),
// which hides the real ones (DOM clobbering), so the prototype's are called explicitly.
const queryAll = (doc, selector) => Document.prototype.querySelectorAll.call(doc, selector);
const rootOf = Object.getOwnPropertyDescriptor(Document.prototype, "documentElement").get;

// The href getters are called through the prototypes for the same reason; they resolve the value against the document's <base>.
const hrefGetters = {
  a: Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "href").get,
  area: Object.getOwnPropertyDescriptor(HTMLAreaElement.prototype, "href").get,
};
const localNameOf = Object.getOwnPropertyDescriptor(Element.prototype, "localName").get;

const setAttr = Element.prototype.setAttribute;

// Sends a mail's links to Rust. The frame's sandbox lets only a user's click navigate the top window (allow-top-navigation-by-user-activation),
// and Rust's on_navigation cancels that and opens an http(s) URL in the default browser. WebKit calls no listener this page adds to the
// frame's document (the sandbox has no allow-scripts), so the links are rewritten here instead:
// - http(s): target="_top", with the resolved URL as the title, so a link whose text says otherwise shows. This is WebKit's plain title
//   display, slow or absent like any plain title (see the tooltip below); mouse moves inside the frame never reach this page, so nothing else can be shown;
// - a #anchor: target="_self", so neither the mail's <base target> nor its own target reaches the top window;
// - an empty href, and anything else that is not http(s) or a #anchor (mailto:, a relative link, about:, ...), loses its href:
//   it would reload the frame, or navigate it away from the mail.
// SVG <a> is left out: its href is not a string.
function routeLinks(doc) {
  for (const a of queryAll(doc, "a[href]:not(svg a), area[href]")) {
    const raw = Element.prototype.getAttribute.call(a, "href").trim();
    if (!raw) {
      Element.prototype.removeAttribute.call(a, "href");
      continue;
    }
    // A #anchor is left to the frame.
    const url = raw.startsWith("#") ? "" : hrefGetters[localNameOf.call(a)].call(a);
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
const fitting = new Set();
function fitFrame(frame) {
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
const frameObserver = new ResizeObserver((entries) => {
  for (const { target, contentRect } of entries) {
    if (target.fitWidth !== contentRect.width) {
      target.fitWidth = contentRect.width;
      fitFrame(target);
    }
  }
});

// Fits the frame again once the images in its document have decoded (or failed to). No load listener is added to the document:
// WebKit does not call one in a frame without allow-scripts. The prototype's decode is called for the same reason as `queryAll`.
const decodeImage = HTMLImageElement.prototype.decode;
function fitAfterImages(frame) {
  const doc = frame.contentDocument;
  if (!doc) return;
  // loading=lazy images may never start loading, so their decode may never settle; the frame observer and the next call cover them.
  Promise.allSettled([...queryAll(doc, "img:not([loading=lazy i])")].map((img) => decodeImage.call(img))).then(() => fitFrame(frame));
}

// Fits the frame when its document loads and when its images are in, then hands the document to `onLoad`.
function autoFit(frame, onLoad) {
  frame.onload = () => {
    fitFrame(frame);
    fitAfterImages(frame);
    onLoad(frame.contentDocument);
  };
  frameObserver.observe(frame);
}

// Parses a mail with DOMParser (no script or nested frame runs, and no declarative shadow root is attached) and writes it back
// without what `routeLinks` cannot reach or what could move a frame: nested frames, <object>, <embed>, meta refresh, and
// declarative shadow roots, whose <template> is replaced by its content. A DOCTYPE is written back only if the mail had one, as it was,
// so the rendering mode does not change.
const BLOCKED = "iframe, frame, frameset, object, embed, meta[http-equiv=refresh i]";
const SHADOW_TEMPLATE = "template[shadowrootmode], template[shadowroot]";
const doctypeOf = Object.getOwnPropertyDescriptor(Document.prototype, "doctype").get;
function plainBody(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // A template's content may hold another, so one is unwrapped at a time.
  for (let t; (t = queryAll(doc, SHADOW_TEMPLATE)[0]); ) t.replaceWith(...t.content.childNodes);
  queryAll(doc, BLOCKED).forEach((el) => el.remove());
  const doctype = doctypeOf.call(doc);
  return (doctype ? new XMLSerializer().serializeToString(doctype) : "") + rootOf.call(doc).outerHTML;
}

// Limits a mail to inline styles and data: images. The frame's sandbox has allow-same-origin, so with no scripts allowed
// here the missing allow-scripts would be the only guard. It goes after a leading DOCTYPE, which must stay first for standards mode.
const BODY_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
const withBodyCsp = (html) => (/^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${BODY_CSP}`) : BODY_CSP + html);

// The https image URLs of a loaded mail, once each. The images are not fetched: the frame's CSP allows data: only.
const externalImages = (doc) => [
  ...new Set(
    [...queryAll(doc, "img[src]")].map((i) => i.getAttribute("src").trim()).filter((s) => /^https:\/\//i.test(s)),
  ),
];

// The cid: images Rust had to fetch after the body was shown: swaps each reference in the loaded document's
// src, background and style attributes and <style> text for its data: URI. `uris` is {reference as written: URI}.
const CID_REF = /cid:[^"')<>\\\s]+/gi;
function showCidImages(doc, uris) {
  const swap = (text) => text.replace(CID_REF, (ref) => uris[ref] ?? ref);
  for (const el of queryAll(doc, "[src], [background], [style]")) {
    for (const name of ["src", "background", "style"]) {
      const value = Element.prototype.getAttribute.call(el, name);
      const swapped = value === null ? value : swap(value);
      if (swapped !== value) Element.prototype.setAttribute.call(el, name, swapped);
    }
  }
  for (const style of queryAll(doc, "style")) {
    const swapped = swap(style.textContent);
    if (swapped !== style.textContent) style.textContent = swapped;
  }
}

// Rust fetches the images, and the loaded document's images get them as data: URIs. Throws when none could be shown.
async function showImages(urls, frame, ctx) {
  const images = await invoke("fetch_images", { urls });
  // Another thread was opened meanwhile, and this frame is gone.
  if (ctx.stale()) return;
  const doc = frame.contentDocument;
  let shown = 0;
  for (const img of queryAll(doc, "img[src]")) {
    const data = images[img.getAttribute("src").trim()];
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
function imagesBar(label, onClick) {
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
const waiting = new Set();
// The "この送信者の画像を自動で表示しない" bars of the open thread that are still up.
const forgettable = new Set();

// The ones of `froms` whose sender Rust remembers, as a Set.
async function knownSenders(froms) {
  if (!froms.length) return new Set();
  try {
    return new Set(await invoke("image_sender_known", { froms }));
  } catch (e) {
    showError(e);
    return new Set();
  }
}

// Asks Rust again after a sender was remembered or forgotten. Rust matches by address, so the display name does not matter.
const refreshSenders = (ctx) => (ctx.senders = knownSenders(ctx.froms));

// Shows the mail's external images: at once when its sender is remembered and Gmail vouches for the sender (a forged From
// can name a remembered one), with a bar to forget the sender; otherwise, or when that fetch fails, behind a bar whose
// button shows them and remembers the sender.
async function offerImages(m, frame, urls, ctx) {
  if (m.authenticated && (await ctx.senders).has(m.from)) {
    try {
      await showImages(urls, frame, ctx);
      if (ctx.stale()) return;
      const entry = { m };
      entry.bar = imagesBar("この送信者の画像を自動で表示しない", async () => {
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
      forgettable.add(entry);
      frame.before(entry.bar);
      return;
    } catch {
      // No error: the bar below fetches again.
    }
  }
  if (ctx.stale()) return;
  const entry = { m, frame, urls };
  entry.bar = imagesBar("画像を表示", async () => {
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
  waiting.add(entry);
  frame.before(entry.bar);
}

// A plain-text body as text nodes and links to its http(s) URLs. A click navigates this page, which Rust's on_navigation
// cancels and opens in the default browser. A URL ends at whitespace, a non-ASCII character or " < > (never in a URL as is);
// trailing punctuation is left out, and a trailing ")" only when unpaired, as in "(https://example.com/a)" but not ".../Foo_(bar)".
const URL_IN_TEXT = /https?:\/\/[!#-;=?-~]+/gi;
function trimUrl(url) {
  let opens = url.split("(").length - 1;
  let closes = url.split(")").length - 1;
  let end = url.length;
  for (; end; end--) {
    const c = url[end - 1];
    if (c === ")" ? closes-- <= opens : !".,;:!?']".includes(c)) break;
  }
  return url.slice(0, end);
}
function linkify(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = trimUrl(match[0]);
    nodes.push(text.slice(last, match.index));
    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    nodes.push(a);
    last = match.index + url.length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

const PERSON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="M2 24c0-6 4.5-9 10-9s10 3 10 9z"/></svg>';

function span(className, text) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

// The header of an open message: avatar, sender, recipients and date. A div, so the address can be selected;
// when the message can be folded it acts as a button (`message` adds the click).
function openHead(m, account, foldable) {
  const { name, address } = splitAddress(m.from);
  const head = document.createElement("div");
  head.className = "msg-head";
  if (foldable) {
    head.setAttribute("role", "button");
    head.tabIndex = 0;
  }
  const avatar = span("msg-avatar", "");
  avatar.innerHTML = PERSON_SVG;
  const who = span("who", "");
  who.append(span("name", name || address));
  if (name) who.append(" ", span("addr", `<${address}>`));
  const to = recipientsLabel(m.to, account);
  if (to) who.append(span("to", to));
  head.append(avatar, who, span("when", formatDetailDate(m.dateMs)));
  return head;
}

// The one line an earlier message of a thread is folded to: small avatar, sender, snippet and date.
function foldedHead(m) {
  const name = senderName(m.from);
  const head = document.createElement("button");
  head.className = "msg-head folded";
  const avatar = span("avatar", initials(name));
  avatar.style.background = avatarColor(name);
  const snip = span("snip", "");
  snip.append(span("name", name), ` ${unescapeHtml(m.snippet)}`);
  head.append(avatar, snip, span("when", formatDate(m.dateMs)));
  return head;
}

// `ctx` is the open thread's: `cids` resolves to the cid: images Rust fetched after the body, by message ID;
// `senders` to the Set of its senders Rust remembers (`froms` asked about); `stale()` tells another thread was opened since.
// `folded` starts the message as one line; the head toggles it. A thread's only message has no toggle.
function message(m, ctx, account, folded, foldable) {
  const article = document.createElement("article");
  const open = openHead(m, account, foldable);
  const body = document.createElement("div");
  body.className = "msg-body";
  article.append(open, body);
  // A folded message is built when it is first opened, so its images are not fetched while it is out of sight.
  const build = () => {
    if (m.html) {
      // No allow-scripts: scripts do not run. allow-same-origin only lets this page read the document's height and rewrite its links.
      // allow-top-navigation-by-user-activation lets a click on a link navigate the top window, and only a click; Rust's on_navigation
      // always cancels that and opens the browser (see `routeLinks`).
      // Invariant: never add allow-scripts, allow-popups, allow-forms or allow-top-navigation, and never widen the sandbox beyond these two.
      // With the page's origin shared, the missing allow-scripts (backed by the CSP's script-src 'self') is the only guard.
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-same-origin allow-top-navigation-by-user-activation");
      frame.srcdoc = withBodyCsp(plainBody(m.body));
      autoFit(frame, (doc) => {
        routeLinks(doc);
        ctx.cids.then((byMessage) => {
          if (ctx.stale()) return;
          if (!byMessage[m.id]) return;
          showCidImages(doc, byMessage[m.id]);
          fitAfterImages(frame);
        });
        const urls = externalImages(doc);
        if (urls.length) offerImages(m, frame, urls, ctx);
      });
      body.append(frame);
    } else {
      const text = document.createElement("div");
      text.className = "plain";
      text.append(...linkify(m.body));
      body.append(text);
    }
  };
  if (foldable) {
    const line = foldedHead(m);
    article.prepend(line);
    open.setAttribute("aria-expanded", "true");
    line.setAttribute("aria-expanded", "false");
    // A frame folded after it was fitted is 0 wide when the message reopens; `frameObserver` fits it again.
    const fold = (folded) => {
      article.classList.toggle("folded", folded);
      line.hidden = !folded;
      open.hidden = folded;
      body.hidden = folded;
      if (!folded && !body.firstChild) build();
    };
    // The head that was clicked goes away, so the focus moves to its counterpart.
    line.onclick = () => (fold(false), open.focus());
    // Dragging over the address to copy it ends in a click; it must not fold the message.
    open.onclick = () => {
      if (getSelection().toString()) return;
      fold(true);
      line.focus();
    };
    open.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      fold(true);
      line.focus();
    };
    fold(folded);
  } else {
    build();
  }
  return article;
}

// Marks a just-opened unread thread read in Gmail and in its row, if the list has one. A failure is shown, the row stays unread.
async function markRead(account, id) {
  try {
    const done = await invoke("set_read", { account, id, read: true });
    // The detail view stays, as for a sync; the list shows the re-login row at the next load.
    if (done === null) return applySync(account, { kind: "needsLogin" });
    const r = rows.get(`${account}/${id}`);
    if (done && r) setReadState(r.t, r.li, true);
  } catch (e) {
    showError(e);
  } finally {
    updateBadge();
  }
}

// The thread shown in the detail view and its list row.
let current = null;

// Bumped by every openThread: a result that arrives for an earlier thread sees the number has moved on and leaves the page alone.
let openCount = 0;

async function openThread({ id, account }, li, origin = "mail") {
  $("error").hidden = true;
  const opened = ++openCount;
  try {
    const t = await invoke("thread", { account, id });
    if (opened !== openCount) return;
    // null: that account must log in again, which the list shows.
    if (t === null) return load();
    current = { id, account, li, latest: t.messages.at(-1), subject: t.subject };
    threadOrigin = origin;
    $("thread-subject").textContent = t.subject || "(件名なし)";
    // The images that had to be fetched come separately, so the body is not held up by them.
    const cids = t.pendingImages?.length
      ? invoke("thread_images", { account, id, images: t.pendingImages }).catch(() => ({}))
      : Promise.resolve({});
    // Only a message Gmail vouches for can show its images by itself, so only its sender is asked about.
    const froms = [...new Set(t.messages.filter((m) => m.html && m.authenticated).map((m) => m.from))];
    const ctx = { cids, froms, senders: knownSenders(froms), stale: () => opened !== openCount };
    frameObserver.disconnect();
    waiting.clear();
    forgettable.clear();
    // Only the latest message is open when the thread has several.
    const several = t.messages.length > 1;
    $("messages").replaceChildren(
      ...t.messages.map((m, i) => message(m, ctx, account, several && i < t.messages.length - 1, several)),
    );
    show("thread");
    // A thread opened from Todo may be out of the list; with no row there is nothing to take out of it.
    $("trash").hidden = $("archive").hidden = $("thread-label").hidden = !li;
    if (t.unread) markRead(account, id);
  } catch (e) {
    showError(e);
  }
}

// Per account, what the last load could not do; the account popup reads it.
let inboxIssues = { needsLogin: [], failed: {} };
// The account whose popup is open, or null.
let popupAccount = null;
// The account whose removal the popup is asking to confirm, or null.
let confirmingRemoval = null;
// What the popup shows now; it is redrawn only when this changes, so a sync does not drop a text selection.
let popupKey = "";

const accountButtons = () => [...$("account-list").children];

// Sidebar avatars of every account, a re-login row for each account that needs it, and an error row for each that failed to load.
function renderAccounts({ accounts, needsLogin, failed }) {
  inboxIssues = { needsLogin, failed };
  $("nav-calendar").disabled = accounts.length === 0;
  $("account-list").replaceChildren(
    ...accounts.map((a) => {
      const avatar = document.createElement("button");
      avatar.className = "avatar account-btn";
      avatar.dataset.account = a;
      avatar.textContent = initials(a);
      avatar.style.background = avatarColor(a);
      avatar.setAttribute("aria-label", a);
      avatar.setAttribute("aria-haspopup", "dialog");
      avatar.setAttribute("aria-controls", "account-popup");
      avatar.setAttribute("aria-expanded", String(a === popupAccount));
      avatar.onclick = () => togglePopup(a);
      return avatar;
    }),
  );
  refreshPopup();
  $("relogin").replaceChildren(
    ...needsLogin.map((a) => {
      const div = document.createElement("div");
      const button = document.createElement("button");
      button.textContent = "再ログイン";
      button.onclick = () => addAccount(a, button);
      div.append(`${a} は再ログインが必要です`, button);
      return div;
    }),
    ...Object.entries(failed).map(([a, message]) => {
      const div = document.createElement("div");
      div.textContent = `${a} の読み込みに失敗しました: ${message}`;
      return div;
    }),
  );
}

function closePopup() {
  popupAccount = null;
  confirmingRemoval = null;
  $("account-popup").hidden = true;
  accountButtons().forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function togglePopup(account) {
  if (popupAccount === account) return closePopup();
  popupAccount = account;
  confirmingRemoval = null;
  popupKey = "";
  $("account-popup").hidden = false;
  accountButtons().forEach((b) => b.setAttribute("aria-expanded", String(b.dataset.account === account)));
  refreshPopup();
}

// Redraws the open popup from the latest state and puts it right of the sidebar at its avatar's height, inside the window.
// The avatars are rebuilt on every render, so the popup finds its avatar again by the account.
function refreshPopup() {
  if (popupAccount === null) return;
  const a = popupAccount;
  const button = accountButtons().find((b) => b.dataset.account === a);
  if (!button) return closePopup();
  const popup = $("account-popup");
  const lines = [];
  if (a in inboxIssues.failed) lines.push(`受信トレイの読み込みに失敗しました: ${inboxIssues.failed[a]}`);
  if (inboxIssues.needsLogin.includes(a)) lines.push("再ログインが必要です");
  if (calShown?.needsLogin.includes(a)) lines.push("カレンダーの再ログインが必要です");
  const relogin = lines.some((l) => l.includes("再ログイン"));
  const unread = [...rows.values()].filter((r) => r.t.account === a && r.t.unread && r.li.isConnected).length;
  const confirming = confirmingRemoval === a;
  const key = JSON.stringify([a, lines, relogin, unread, confirming]);
  if (key !== popupKey) {
    popupKey = key;
    const hadFocus = popup.contains(document.activeElement);
    const avatar = el("avatar", initials(a));
    avatar.style.background = avatarColor(a);
    const textButton = (text, onclick) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.onclick = () => onclick(b);
      return b;
    };
    if (confirming) {
      const cancel = textButton("キャンセル", () => {
        confirmingRemoval = null;
        refreshPopup();
      });
      const remove = textButton("削除", (b) => removeAccount(a, b));
      remove.className = "danger";
      const actions = el("popup-actions");
      actions.append(remove, cancel);
      popup.replaceChildren(avatar, el("popup-email", a), el("popup-status", `${a} を cookup から削除します。Gmail のメールは消えません。`), actions);
      cancel.focus();
    } else {
      popup.replaceChildren(avatar, el("popup-email", a), ...lines.map((l) => el("popup-status", l)), el("popup-unread", `未読 ${unread} 件`));
      if (relogin) popup.append(textButton("再ログイン", (b) => addAccount(a, b)));
      popup.append(
        textButton("このアカウントを削除", () => {
          confirmingRemoval = a;
          refreshPopup();
        }),
      );
      if (hadFocus) button.focus();
    }
  }
  popup.style.left = `${$("sidebar").getBoundingClientRect().right + 8}px`;
  popup.style.top = `${Math.max(8, Math.min(button.getBoundingClientRect().top, innerHeight - popup.offsetHeight - 8))}px`;
}

// Another avatar or the popup handles its own click.
document.addEventListener("pointerdown", (e) => {
  if (popupAccount !== null && !e.target.closest("#account-popup, .account-btn")) closePopup();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || popupAccount === null) return;
  const inside = $("account-popup").contains(document.activeElement);
  const button = accountButtons().find((b) => b.dataset.account === popupAccount);
  closePopup();
  if (inside) button?.focus();
});
window.addEventListener("resize", refreshPopup);
// The unread count follows every change of the list: load, sync, read toggle, removal.
new MutationObserver(refreshPopup).observe($("threads"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

// Tooltip for icon-only controls. The native title is slow or missing in WKWebView, so the text is the control's aria-label.
const TIP_DELAY_MS = 300;
const tip = el("tooltip");
tip.hidden = true;
document.body.append(tip);
let tipTimer = 0;

function hideTip() {
  clearTimeout(tipTimer);
  tip.hidden = true;
}

// Right of a sidebar control, below any other; kept inside the window. While the account popup is open it covers that area, so the sidebar's account controls show none.
function showTip(target) {
  hideTip();
  const inSidebar = target.closest("#sidebar");
  if (popupAccount !== null && target.closest("#accounts")) return;
  tipTimer = setTimeout(() => {
    tip.textContent = target.getAttribute("aria-label");
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const left = inSidebar ? r.right + 8 : r.left + (r.width - tip.offsetWidth) / 2;
    const top = inSidebar ? r.top + (r.height - tip.offsetHeight) / 2 : r.bottom + 6;
    tip.style.left = `${Math.max(4, Math.min(left, innerWidth - tip.offsetWidth - 4))}px`;
    tip.style.top = `${Math.max(4, Math.min(top, innerHeight - tip.offsetHeight - 4))}px`;
  }, TIP_DELAY_MS);
}

// Delegated, so rows and avatars built later get tooltips too.
const TIP_TARGET = "button[aria-label], input[aria-label]";
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest?.(TIP_TARGET);
  if (t && !t.contains(e.relatedTarget)) showTip(t);
});
document.addEventListener("mouseout", (e) => {
  const t = e.target.closest?.(TIP_TARGET);
  if (t && !t.contains(e.relatedTarget)) hideTip();
});
// Only keyboard focus shows it; a click also focuses the control and must not bring the tooltip back.
document.addEventListener("focusin", (e) => {
  const t = e.target.closest?.(TIP_TARGET);
  if (t?.matches(":focus-visible")) showTip(t);
});
document.addEventListener("focusout", hideTip);
document.addEventListener("pointerdown", hideTip);
document.addEventListener("click", hideTip);
document.addEventListener("scroll", hideTip, true);
document.addEventListener("keydown", (e) => e.key === "Escape" && hideTip());

// Which screen the sidebar selected: "mail", "calendar", "todo" or "settings". Background work reads it; only the sidebar changes it.
let screen = "mail";

// The screen the open thread was opened from ("mail" or "todo"): where "戻る" goes.
let threadOrigin = "mail";

// Only the latest of overlapping loads may draw the list.
let loadSeq = 0;
// Loads in flight; a sync stays out of their way.
let loading = 0;
// Per account, the mailbox history ID as of the last load or sync: where the next sync starts.
let historyIds = new Map();

async function load() {
  const seq = ++loadSeq;
  loading++;
  $("error").hidden = true;
  try {
    const inbox = await invoke("inbox");
    if (seq !== loadSeq) return;
    renderAccounts(inbox);
    if (inbox.accounts.length === 0) return show("login");
    historyIds = new Map(Object.entries(inbox.historyIds));
    const shown = inbox.threads.filter((t) => !pending.has(rowKey(t)));
    rows = new Map(shown.map((t) => [rowKey(t), { t, li: row(t) }]));
    const all = [...rows.values()];
    $("unread-threads").replaceChildren(...all.filter((r) => r.t.unread).map((r) => r.li));
    $("read-threads").replaceChildren(...all.filter((r) => !r.t.unread).map((r) => r.li));
    updateBadge();
  } catch (e) {
    showError(e);
  } finally {
    loading--;
  }
  // A load that ends while the calendar is shown (e.g. after a re-login there) must not switch the screen.
  if (screen === "mail") show("list");
}

const sameRow = (a, b) => ["from", "subject", "snippet", "dateMs", "unread"].every((k) => a[k] === b[k]);

// Adds the row of `t` in date order, or swaps it for the one on screen; the rest of the list is left alone.
function upsert(t) {
  const key = rowKey(t);
  const old = rows.get(key);
  if (pending.has(key) || (old && sameRow(old.t, t))) return;
  // shortcut: a row whose read toggle is in flight keeps its optimistic state, upgrade if that ever shows stale.
  if (old && old.li.querySelector(".read-box").disabled) return;
  const li = row(t);
  rows.set(key, { t, li });
  const focused = old && old.li.contains(document.activeElement) ? document.activeElement.classList : null;
  if (old && old.li.dataset.dateMs === li.dataset.dateMs && old.t.unread === t.unread) {
    old.li.replaceWith(li);
  } else {
    if (old) old.li.remove();
    place(li, t.unread);
  }
  if (old && current && current.li === old.li) current.li = li;
  if (focused) li.querySelector(`.${[...focused].join(".")}`)?.focus();
}

// Applies one account's changes in place: the first visible row stays where it is on screen.
// shortcut: with the detail view open the list cannot be measured, so rows added above shift it, upgrade if that bothers.
function applyChanges(threads, removedKeys) {
  const main = $("main");
  const top = main.getBoundingClientRect().top;
  const anchor = [...$("threads").querySelectorAll("li")].find((li) => li.getBoundingClientRect().bottom > top);
  const before = anchor && anchor.getBoundingClientRect().top;
  for (const key of removedKeys) {
    const r = rows.get(key);
    if (r) r.li.remove();
    rows.delete(key);
  }
  threads.forEach(upsert);
  if (anchor && anchor.isConnected && main.scrollTop > 0) main.scrollTop += anchor.getBoundingClientRect().top - before;
  updateBadge();
}

function applySync(account, r) {
  if (r.kind === "changed") {
    applyChanges(r.threads, r.removed.map((id) => `${account}/${id}`));
  } else if (r.kind === "reloaded") {
    const keep = new Set(r.threads.map(rowKey));
    applyChanges(r.threads, [...rows.keys()].filter((k) => k.startsWith(`${account}/`) && !keep.has(k)));
  } else if (r.kind === "needsLogin") {
    // The detail view stays; the list shows the re-login row at the next load.
    historyIds.delete(account);
    if (!$("threads").hidden) load();
    return;
  } else {
    return;
  }
  historyIds.set(account, r.historyId);
}

const SYNC_MS = 10000;
// Consecutive sync rounds with an error; one failure is not worth the user's attention.
let syncFails = 0;
let syncing = false;

// Brings the list up to date with Gmail through `sync`, without leaving the current view.
async function syncAll() {
  if (syncing || loading || document.hidden || historyIds.size === 0) return;
  syncing = true;
  const seq = loadSeq;
  let failure = null;
  try {
    for (const [account, startHistoryId] of [...historyIds]) {
      try {
        const r = await invoke("sync", { account, startHistoryId });
        // A load that started meanwhile redraws everything from a newer state.
        if (seq !== loadSeq || loading) return;
        applySync(account, r);
      } catch (e) {
        failure = e;
      }
    }
  } finally {
    syncing = false;
  }
  syncFails = failure ? syncFails + 1 : 0;
  if (syncFails === 3) showError(`自動同期に失敗しています: ${failure}`);
}

setInterval(syncAll, SYNC_MS);
document.addEventListener("visibilitychange", syncAll);

$("reload").onclick = load;
$("back").onclick = () => {
  $("error").hidden = true;
  if (threadOrigin === "todo") setScreen("todo");
  else show("list");
};
// Detail view "trash" / "archive": back to the list at once, the work runs in the background.
function removeCurrent(command) {
  if (threadOrigin === "todo") setScreen("todo");
  else show("list");
  removeRow(command, current.account, current.id, current.li);
}
$("thread-todo").onclick = () => makeTodo(current.account, current.id, $("thread-subject").textContent, $("thread-todo"));
$("trash").onclick = () => removeCurrent("trash");
$("archive").onclick = () => removeCurrent("archive");
// Cmd+Z undoes the last removal; in a text field it stays that field's own undo.
document.addEventListener("keydown", (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key !== "z" || composing(e) || !lastRemoved) return;
  const a = document.activeElement;
  if (a?.isContentEditable || a?.closest?.("input, textarea")) return;
  e.preventDefault();
  undoRemove();
});
// Logs in (the account chosen in the browser, or `hint` preselected) and reloads the list.
async function addAccount(hint, button) {
  $("error").hidden = true;
  button.disabled = true;
  try {
    await invoke("login", { loginHint: hint });
    // The accounts changed: weeks kept so far and the calendar lists behind them are stale.
    calCache.clear();
    calEpoch++;
    calRefresh = true;
    // The login may have fixed the calendar too; the popup must not keep the old state until the calendar is opened.
    calShown = null;
    await load();
    if (screen === "calendar") await loadCalendar();
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
}
// Removes the account in the backend (revokes Google's grant, deletes its token), then drops what the screen kept of it.
async function removeAccount(account, button) {
  $("error").hidden = true;
  button.disabled = true;
  try {
    await invoke("remove_account", { account });
  } catch (e) {
    confirmingRemoval = null;
    popupKey = "";
    refreshPopup();
    return showError(e);
  }
  closePopup();
  for (const [key, r] of rows) {
    if (r.t.account !== account) continue;
    r.li.remove();
    rows.delete(key);
  }
  historyIds.delete(account);
  if (lastRemoved?.account === account) lastRemoved = null;
  calCache.clear();
  calEpoch++;
  calRefresh = true;
  calShown = null;
  updateBadge();
  await load();
  if (screen !== "calendar") return;
  // With no account left there is no calendar to show: back to the mail screen, which shows the login.
  if (accountButtons().length === 0) {
    setScreen("mail");
    show("login");
  } else {
    await loadCalendar();
  }
}
$("login-button").onclick = () => addAccount(null, $("login-button"));
$("add-account").onclick = () => addAccount(null, $("add-account"));

const HOUR_PX = 64;
// Keep in step with MIN_MINUTES in calendar.rs.
const MIN_EVENT_MIN = 20;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const CAL_REFRESH_MS = 5 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// Local midnight of the "YYYY-MM-DD" date, `days` later.
const addDays = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d + days);
};
const hhmm = (min) => `${Math.floor(min / 60)}:${pad2(min % 60)}`;

function el(className, text = "") {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  return div;
}

// A day of the week on screen, as "YYYY-MM-DD", and the week drawn now once loaded.
let calDate = isoDate(new Date());
let calShown = null;
let calSeq = 0;
// Weeks fetched so far by their Sunday ("YYYY-MM-DD"), oldest first; memory only.
const calCache = new Map();
const CAL_CACHE_MAX = 10;
// Bumped when the cache is dropped, so a fetch that began before cannot put its week back.
let calEpoch = 0;
// The next fetch makes the backend list the calendars again.
let calRefresh = false;
// Weeks being fetched ahead.
const calAhead = new Set();
// The first render after opening the calendar scrolls to the morning; later ones keep the position.
let calScrolled = false;

// The event's own color (its calendar's); events with none take the account's, as the mail list does.
const eventColor = (e) => e.color || avatarColor(e.account);

function eventBox(e) {
  const box = el("cal-event" + (e.declined ? " declined" : ""));
  box.style.top = `${(e.startMin / 60) * HOUR_PX}px`;
  box.style.height = `${(Math.max(e.endMin - e.startMin, MIN_EVENT_MIN) / 60) * HOUR_PX - 1}px`;
  box.style.left = `${(e.col / e.cols) * 100}%`;
  box.style.width = `${100 / e.cols}%`;
  box.style.setProperty("--c", eventColor(e));
  box.title = `${e.summary}\n${e.account}`;
  box.append(el("cal-name", e.summary || "(件名なし)"));
  // Under 45 minutes has no room for a second line, so the title takes the only one.
  if (e.endMin - e.startMin < 45) box.classList.add("short");
  else box.append(el("cal-time", `${hhmm(e.startMin)} - ${hhmm(e.endMin)}`));
  return box;
}

function allDayChip(e) {
  const c = el("cal-chip" + (e.declined ? " declined" : ""), e.summary || "(件名なし)");
  c.style.setProperty("--c", eventColor(e));
  c.title = `${e.summary}\n${e.account}`;
  return c;
}

// The current-time line in today's column and its label in the time gutter, if the shown week holds today.
function drawNow() {
  document.querySelectorAll(".cal-now").forEach((n) => n.remove());
  if (!calShown) return;
  const now = new Date();
  const day = [0, 1, 2, 3, 4, 5, 6].find((i) => isoDate(addDays(calShown.weekStart, i)) === isoDate(now));
  if (day === undefined) return;
  const top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px`;
  const line = el("cal-now cal-now-line");
  const label = el("cal-now cal-now-label", `${now.getHours()}:${pad2(now.getMinutes())}`);
  line.style.top = label.style.top = top;
  // Children of #cal-body: the time gutter, then the seven day columns.
  $("cal-body").children[day + 1].append(line);
  $("cal-body").firstElementChild.append(label);
}

function renderWeek(w) {
  calShown = w;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(w.weekStart, i));
  const todayIndex = days.findIndex((d) => isoDate(d) === isoDate(new Date()));
  const mark = (node, i) => {
    if (i === todayIndex) node.classList.add("today");
    return node;
  };
  // The title names the month of the middle of the week.
  const year = document.createElement("span");
  year.className = "year";
  year.textContent = ` ${days[3].getFullYear()}`;
  $("cal-title").replaceChildren(`${days[3].getMonth() + 1}月`, year);
  $("cal-head").replaceChildren(
    el("cal-gutter"),
    ...days.map((d, i) => {
      const cell = mark(el("cal-day", `${WEEKDAYS[d.getDay()]} `), i);
      cell.append(el("cal-date", d.getDate()));
      return cell;
    }),
  );
  $("cal-allday").replaceChildren(
    el("cal-allday-label", "終日"),
    ...days.map((_, i) => {
      const cell = el("cal-cell");
      cell.append(...w.allDay.filter((e) => e.day === i).map(allDayChip));
      return cell;
    }),
  );
  const gutter = el("cal-gutter");
  for (let h = 1; h < 24; h++) {
    const label = el("cal-hour", `${h}:00`);
    label.style.top = `${h * HOUR_PX}px`;
    gutter.append(label);
  }
  $("cal-body").replaceChildren(
    gutter,
    ...days.map((_, i) => {
      const col = el("cal-col");
      col.append(...w.timed.filter((e) => e.day === i).map(eventBox));
      return col;
    }),
  );
  drawNow();
  $("cal-notice").replaceChildren(
    ...w.needsLogin.map((a) => {
      const div = document.createElement("div");
      const button = document.createElement("button");
      button.textContent = "再ログイン";
      button.onclick = () => addAccount(a, button);
      div.append(`${a} はカレンダーを読むため再ログインが必要です`, button);
      return div;
    }),
    ...Object.entries(w.failed).map(([a, message]) => {
      const div = document.createElement("div");
      div.textContent = `${a} の予定の読み込みに失敗しました: ${message}`;
      return div;
    }),
    ...w.calendarFailed.map((message) => {
      const div = document.createElement("div");
      div.textContent = message;
      return div;
    }),
  );
  refreshPopup();
  if (!calScrolled) {
    // Three hours before now at the top (11:00 shows from 8:00); a little less keeps the hour label whole.
    $("cal-scroll").scrollTop = Math.max(0, (new Date().getHours() - 3) * HOUR_PX - 12);
    calScrolled = true;
  }
}

// The Sunday of the week holding the "YYYY-MM-DD" date.
const weekKey = (iso) => isoDate(addDays(iso, -addDays(iso, 0).getDay()));

// Fetches the week holding `date` and keeps it, dropping the oldest beyond CAL_CACHE_MAX.
async function fetchWeek(date, refresh) {
  const epoch = calEpoch;
  refresh ||= calRefresh;
  calRefresh = false;
  const week = await invoke("calendar_week", { date, refresh });
  if (epoch === calEpoch) {
    calCache.delete(week.weekStart);
    calCache.set(week.weekStart, week);
    while (calCache.size > CAL_CACHE_MAX) calCache.delete(calCache.keys().next().value);
  }
  return week;
}

// Fetches in the background the weeks before and after `key` that are not kept yet; a failure is left to when the week is opened.
function prefetchAround(key) {
  for (const k of [isoDate(addDays(key, -7)), isoDate(addDays(key, 7))]) {
    if (calCache.has(k) || calAhead.has(k)) continue;
    calAhead.add(k);
    fetchWeek(k, false)
      .catch(() => {})
      .finally(() => calAhead.delete(k));
  }
}

// Shows the week of `calDate`: the kept one at once, then the fetched one if it differs, so the scroll position stays.
// With none kept, the old week stays (dimmed) until the new one arrives.
async function loadCalendar(refresh = false) {
  const seq = ++calSeq;
  const key = weekKey(calDate);
  const kept = calCache.get(key);
  $("error").hidden = true;
  if (kept) {
    if (calShown?.weekStart !== key) renderWeek(kept);
  } else {
    $("calendar").classList.add("loading");
  }
  try {
    const week = await fetchWeek(calDate, refresh);
    if (seq === calSeq) {
      if (JSON.stringify(week) !== JSON.stringify(calShown)) renderWeek(week);
      prefetchAround(key);
    }
  } catch (e) {
    if (seq === calSeq) showError(e);
  } finally {
    if (seq === calSeq) $("calendar").classList.remove("loading");
  }
}

function setScreen(name) {
  screen = name;
  for (const [id, target] of [["nav-mail", "mail"], ["nav-calendar", "calendar"], ["nav-todo", "todo"], ["nav-settings", "settings"]]) {
    if (target === name) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  $("error").hidden = true;
  if (name === "calendar") {
    calScrolled = false;
    show("calendar");
    loadCalendar();
  } else if (name === "todo") {
    show("todo");
    // The backend keeps the completed tasks of the last load; they are fetched again only on the first one.
    loadTodo(false, todo === null);
  } else if (name === "settings") {
    show("settings");
    loadSettings();
  } else {
    show("list");
  }
}

$("nav-mail").onclick = () => setScreen("mail");
$("nav-calendar").onclick = () => setScreen("calendar");
$("nav-todo").onclick = () => setScreen("todo");
$("nav-settings").onclick = () => setScreen("settings");
const moveWeek = (date) => {
  calDate = date;
  loadCalendar();
};
$("cal-prev").onclick = () => moveWeek(isoDate(addDays(calDate, -7)));
$("cal-next").onclick = () => moveWeek(isoDate(addDays(calDate, 7)));
$("cal-today").onclick = () => moveWeek(isoDate(new Date()));
$("calendar").style.setProperty("--hour", `${HOUR_PX}px`);
setInterval(() => screen === "calendar" && !document.hidden && loadCalendar(true), CAL_REFRESH_MS);
setInterval(() => screen === "calendar" && drawNow(), 60000);

// Short notice at the bottom right; it fades after a few seconds.
const toastEl = el("toast");
toastEl.hidden = true;
toastEl.setAttribute("role", "status");
document.body.append(toastEl);
let toastTimer = 0;

// `action` ({ label, run }) adds a button that hides the notice and runs `run`.
function toast(text, action) {
  toastEl.textContent = text;
  if (action) {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.onclick = () => {
      toastEl.hidden = true;
      action.run();
    };
    toastEl.append(button);
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
}

// Creates a Todoist task in the inbox that points at the thread, and says so.
async function makeTodo(account, id, subject, button) {
  $("error").hidden = true;
  button.disabled = true;
  try {
    const done = await invoke("todoist_task_from_mail", { account, threadId: id, subject });
    if (done === null) return showError("Todoist のトークンが無いか無効です。Todo 画面でトークンを保存してください");
    toast(`受信箱に「${subject || "(件名なし)"}」を追加しました`);
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
}

const TODO_REFRESH_MS = 10 * 1000;
// The Todoist apps' colors for priorities 1 to 4.
const PRIORITY_COLORS = { 1: "#d1453b", 2: "#eb8909", 3: "#246fe0", 4: "#b4b9c2" };
const TODO_GROUPS = [["overdue", "期限切れ"], ["today", "今日"], ["upcoming", "明日以降"], ["none", "期限なし"]];
const svgOf = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const MAIL_SVG = svgOf('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>');
const SUB_SVG = svgOf('<path d="M6 4v10a3 3 0 0 0 3 3h9"/><path d="M15 14l3 3-3 3"/>');
const OPEN_SVG = svgOf('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>');
const DAY_SVG = svgOf('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M12 14v3"/>');
const DATE_SVG = svgOf('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>');
const GRIP_SVG = svgOf('<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/>');
const FLAG_SVG = svgOf('<path d="M5 21V4h11l-2 4 2 4H5"/>');
const EDIT_SVG = svgOf('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>');
const FOLDER_SVG = svgOf('<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>');
const INBOX_SVG = $("nav-mail").querySelector("svg").outerHTML;
const PLUS_SVG = $("add-account").innerHTML.trim();
const DELETE_SVG = $("todo-delete").innerHTML.trim();

function tag(name, className = "", text = "") {
  const node = document.createElement(name);
  node.className = className;
  node.textContent = text;
  return node;
}

// Open tasks that "今日" lists: overdue or due today.
const isDueToday = (t) => t.bucket === "overdue" || t.bucket === "today";
const setTodoCount = (count) => setNavCount("nav-todo", count, "Todo", "今日");
// Set when the count fetch finds no usable token: it stops reading the keychain until a load on the Todo screen succeeds.
let todoCountOff = false;
// The first count fetch also takes the completed tasks, so the cache it saves keeps the done subtasks.
let countWithDone = true;

// The last data from the backend, or null while a token is needed.
let todo = null;
// "today", "inbox", or a project's ID.
let todoView = "today";
// The ID of the task shown in the detail view, or null for the list.
let todoOpen = null;
// Only the latest of overlapping loads may draw.
let todoSeq = 0;

// The projects by ID, rebuilt on each load.
let projectById = new Map();
// The tasks by ID, rebuilt on each load.
let taskById = new Map();

const inboxOf = () => todo.projects.find((p) => p.inbox);
const projectOf = (id) => projectById.get(id);
const projectName = (p) => (p?.inbox ? "受信箱" : p?.name ?? "");
const viewProjectId = (view) => (view === "inbox" ? inboxOf()?.id : view);

function viewTasks(view) {
  if (view === "today") return todo.tasks.filter((t) => t.bucket === "overdue" || t.bucket === "today");
  const id = viewProjectId(view);
  return todo.tasks.filter((t) => t.projectId === id && !t.parent);
}

// "今日" for today (or its time), else "10/27", with the time if there is one.
function dueLabel(due) {
  const today = due.date === isoDate(new Date());
  const [, m, d] = due.date.split("-").map(Number);
  if (today) return due.time ?? "今日";
  return due.time ? `${m}/${d} ${due.time}` : `${m}/${d}`;
}

// Which part the Todo screen shows: the token form, the task list, or one task.
function todoMode(mode) {
  $("todo-token").hidden = mode !== "token";
  $("projects").hidden = mode === "token";
  $("todo-add").hidden = mode !== "list";
  $("todo-list").hidden = mode !== "list";
  $("todo-detail").hidden = mode !== "detail";
  $("todo-back").hidden = mode !== "detail";
  $("todo-delete").hidden = mode !== "detail";
  $("todo-disconnect").hidden = mode === "token";
  $("todo-reload").hidden = mode === "token";
  resetDelete();
}

function showTokenForm(note = "") {
  // No reload is due: the form is what the screen shows now, and a load still in flight must not draw over it.
  clearTimeout(todoReloadTimer);
  todoSeq++;
  todo = null;
  setTodoCount(0);
  todoOpen = null;
  $("todo-notice").replaceChildren();
  todoMode("token");
  $("todo-title").textContent = "Todo";
  $("todo-token-note").textContent = note;
  $("todo-token-input").focus();
}

function projectButton(view, icon, name, count) {
  const b = tag("button", "proj");
  b.setAttribute("aria-current", String(view === todoView));
  b.dataset.view = view;
  if (typeof icon === "string" && icon.startsWith("<")) b.innerHTML = icon;
  else {
    const dot = tag("span", "pdot");
    dot.style.background = icon;
    b.append(dot);
  }
  b.append(tag("span", "name", name), tag("span", "count", String(count)));
  b.onclick = () => {
    todoView = view;
    todoOpen = null;
    renderTodo();
  };
  return b;
}

function renderProjects() {
  const inbox = inboxOf();
  // One pass over the tasks counts what each list shows (the same tasks as viewTasks).
  const counts = new Map();
  let today = 0;
  for (const t of todo.tasks) {
    if (isDueToday(t)) today++;
    if (!t.parent) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
  }
  setTodoCount(today);
  $("projects").replaceChildren(
    projectButton("today", DAY_SVG, "今日", today),
    projectButton("inbox", INBOX_SVG, "受信箱", counts.get(inbox?.id) ?? 0),
    tag("h3", "", "プロジェクト"),
    ...todo.projects.filter((p) => p !== inbox).map((p) => projectButton(p.id, p.color, p.name, counts.get(p.id) ?? 0)),
  );
}

function checkBox(color, checked, label) {
  const box = tag("input", "check");
  box.type = "checkbox";
  box.checked = checked;
  box.setAttribute("aria-label", label);
  box.style.setProperty("--p", color);
  return box;
}

// The thread a task links to, only when it is of an account cookup has: a description can name any address.
const linkedMail = (t, accounts) => (t.mail && accounts.has(t.mail.account) ? t.mail : null);
const accountSet = () => new Set(accountButtons().map((b) => b.dataset.account));

function taskRow(t, showProject, accounts) {
  const mail = linkedMail(t, accounts);
  const li = tag("li", `task${showProject ? "" : " single"}`);
  li.onclick = () => {
    // A drag that starts in the name field and ends elsewhere on the row clicks the row; the edit keeps it.
    if (li.querySelector(".row-edit")) return;
    // A subtask row opens the task that holds it.
    todoOpen = t.parent?.id ?? t.id;
    renderTodo();
  };
  const box = checkBox(PRIORITY_COLORS[t.priority], false, "完了にする");
  // The row opens the task on click; the checkbox must not.
  box.onclick = (e) => e.stopPropagation();
  box.onchange = () => {
    li.classList.add("done");
    setTaskDone(t.id, true, box);
  };
  const line = tag("div", "t");
  if (mail) line.insertAdjacentHTML("beforeend", MAIL_SVG);
  const name = tag("span", "", t.content);
  line.append(name);
  if (t.parent) line.append(tag("span", "parent", t.parent.content));
  if (t.subTotal) {
    const count = tag("span", "subcount");
    count.innerHTML = SUB_SVG;
    count.append(`${t.subDone}/${t.subTotal}`);
    line.append(count);
  }
  const body = tag("div", "body");
  body.append(line);
  li.append(box, body, gripOf(li, t));
  if (showProject) {
    const p = projectOf(t.projectId);
    const tagEl = tag("div", "ptag");
    const dot = tag("span", "pdot");
    dot.style.background = p?.color;
    tagEl.append(dot, projectName(p));
    li.append(tagEl);
  }
  const trail = tag("div", "trail");
  const actions = tag("div", "row-actions");
  actions.append(
    rowButton("edit-row", "名前を変更", EDIT_SVG, () => editRowName(name, t)),
    rowButton("due-row", "期限を変更", DATE_SVG, (button) => openDuePop(button, t)),
    rowButton("project-row", "プロジェクトを移動", FOLDER_SVG, (button) => openProjectMenu(button, t)),
  );
  if (mail) actions.append(rowButton("mail-row", "メールを開く", MAIL_SVG, () => openMailFromTodo(mail)));
  actions.append(rowButton("open-row", "Todoist で開く", OPEN_SVG, () => invoke("todoist_open", { id: t.id }).catch(showError)));
  trail.append(tag("span", `due${t.bucket === "overdue" ? " over" : ""}`, t.due ? dueLabel(t.due) : ""), actions);
  li.append(trail);
  return li;
}

// True while a row is dragged by its grip, so the timed refresh does not redraw the list under it.
let todoDragging = false;

// The grip at a row's left edge: drag it onto a project in the side list to move the task there.
// Pointer events, not HTML5 drag and drop, which clashes with the window's file drop.
function gripOf(li, t) {
  const grip = tag("span", "grip");
  grip.setAttribute("role", "img");
  grip.setAttribute("aria-label", "ドラッグしてプロジェクトへ移動");
  grip.innerHTML = GRIP_SVG;
  // The row opens the task on click; the grip must not, nor the click that ends a drag.
  grip.onclick = (e) => e.stopPropagation();
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pointer = e.pointerId;
    // Keeps the events coming outside the window; if a redraw takes the grip out, they still reach the document.
    grip.setPointerCapture(pointer);
    const [x0, y0] = [e.clientX, e.clientY];
    let ghost = null;
    let over = null;
    // On the document, not the grip: a redraw during the drag takes the grip out, and its events would stop.
    const mine = (f) => (e) => e.pointerId === pointer && f(e);
    const move = mine((e) => {
      if (!ghost) {
        // A press that hardly moves is not a drag.
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
        todoDragging = true;
        ghost = tag("div", "drag-ghost", t.content);
        document.body.append(ghost);
        li.classList.add("dragging");
        document.body.classList.add("dragging-task");
      }
      // Read before the ghost moves, so the move does not force a style recalculation each time.
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest("#projects .proj");
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      // Not the "today" list, nor the project the task is in.
      const next = b && b.dataset.view !== "today" && viewProjectId(b.dataset.view) !== t.projectId ? b : null;
      if (next === over) return;
      over?.classList.remove("drop");
      next?.classList.add("drop");
      over = next;
    });
    const up = mine(() => end(true));
    const cancel = mine(() => end(false));
    const onKey = (e) => e.key === "Escape" && end(false);
    const end = (drop) => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", onKey);
      if (!ghost) return;
      const projectId = drop && over ? viewProjectId(over.dataset.view) : null;
      ghost.remove();
      ghost = null;
      over?.classList.remove("drop");
      li.classList.remove("dragging");
      document.body.classList.remove("dragging-task");
      todoDragging = false;
      // The click that ends a drag may go to what is under the pointer (a project button); it must not act.
      const swallow = (e) => e.stopPropagation();
      document.addEventListener("click", swallow, true);
      setTimeout(() => document.removeEventListener("click", swallow, true));
      if (projectId) moveTask(t.id, projectId);
      // Only a redraw held back during the drag; the next refresh fetches.
      else if (todoUndrawn) renderTodo();
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", onKey);
  };
  return grip;
}

// Turns a row's name into a text field: Enter or leaving the field saves, Escape puts the name back.
function editRowName(name, t) {
  const input = tag("input", "row-edit");
  input.value = t.content;
  input.setAttribute("aria-label", "タスクの名前");
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    if (save && input.value.trim() && input.value !== t.content) {
      name.textContent = input.value;
      saveTask(t.id, { content: input.value });
    }
    input.replaceWith(name);
  };
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  // The row opens the task on click; the field must not.
  input.onclick = (e) => e.stopPropagation();
  name.replaceWith(input);
  input.focus();
  input.select();
}

function renderList() {
  todoMode("list");
  const showProject = todoView === "today";
  const tasks = viewTasks(todoView);
  $("todo-title").textContent = todoView === "today" ? "今日" : todoView === "inbox" ? "受信箱" : projectOf(todoView).name;
  const accounts = accountSet();
  const parts = [];
  for (const [bucket, label] of TODO_GROUPS) {
    const items = tasks.filter((t) => t.bucket === bucket);
    if (items.length === 0) continue;
    const list = tag("ul");
    list.append(...items.map((t) => taskRow(t, showProject, accounts)));
    parts.push(tag("div", `group${bucket === "overdue" ? " overdue" : ""}`, label), list);
  }
  $("todo-list").replaceChildren(...(parts.length ? parts : [tag("p", "todo-empty", "タスクはありません")]));
}

// Opens the thread of a task's mail link in the mail screen.
async function openMailFromTodo({ account, threadId }) {
  setScreen("mail");
  await openThread({ id: threadId, account }, rows.get(`${account}/${threadId}`)?.li ?? null, "todo");
}

// Reloads shortly after the last call, so a run of changes costs one load. Completed tasks are fetched again only when asked for by one of them.
let todoReloadTimer = 0;
let todoReloadDone = false;

function scheduleTodoReload(withDone) {
  todoReloadDone ||= withDone;
  clearTimeout(todoReloadTimer);
  todoReloadTimer = setTimeout(() => {
    // The end of the last change in flight schedules it again.
    if (todoWrites) return;
    const done = todoReloadDone;
    todoReloadDone = false;
    loadTodo(false, done);
  }, 300);
}

// Changes in flight (todoCall's writes). While any is, a load draws nothing: it could hold the state from before the change and put it back.
let todoWrites = 0;

// Runs a change, then reloads whether it worked or not, so the screen shows what Todoist has.
// `apply` first changes `todo` and draws it, so the screen does not wait for Todoist; a failed call is undone by the reload, as a removed mail row comes back.
// A load sent before a change started or ended is dropped (todoSeq): it could hold the state from before the change.
// A null answer (a token is needed) shows up in that reload. Returns the command's answer: null when it failed or a token is needed.
// `redraw` false (a name or description saved on blur) keeps the screen: a redraw there would drop the click or focus move that ended the edit.
async function todoCall(command, args, control, apply, redraw = true) {
  $("error").hidden = true;
  if (control) control.disabled = true;
  todoWrites++;
  todoSeq++;
  let answer = null;
  try {
    if (apply) {
      apply();
      taskById = new Map(todo.tasks.map((t) => [t.id, t]));
      setTodoCount(todo.tasks.filter(isDueToday).length);
      // The screen no longer matches the last load, so a quiet reload must not skip drawing as unchanged.
      todoText = null;
      // Like a load: a field being typed in keeps what was typed, and the redraw waits.
      if (!redraw || editingField()) todoUndrawn = true;
      else renderTodo();
    }
    answer = await invoke(command, args);
  } catch (e) {
    showError(e);
  } finally {
    todoWrites--;
    todoSeq++;
  }
  if (control) control.disabled = false;
  // Only completing or reopening a task changes the completed ones.
  scheduleTodoReload(command === "todoist_set_done");
  return answer;
}

// What the screen shows for a due text the calendar picked (`YYYY-MM-DD`, with ` HH:MM` for a task with a time), or an empty one (no due date).
// Other text is Todoist's to read, so the task stays as it is until the reload.
const PICKED_DUE = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/;

// shortcut: the list is not re-sorted after a due date change; the next reload fixes it.
function patchTask(id, { dueString, ...fields }) {
  const t = taskById.get(id);
  if (!t) return;
  Object.assign(t, fields);
  if (dueString === undefined) return;
  const text = dueString.trim();
  const m = PICKED_DUE.exec(text);
  if (m) {
    const today = isoDate(new Date());
    t.due = { date: m[1], time: m[2] ?? null, string: text, recurring: false };
    t.bucket = m[1] < today ? "overdue" : m[1] === today ? "today" : "upcoming";
  } else if (text === "") {
    t.due = null;
    t.bucket = "none";
  }
}

// Whether `t` is below the task `id`, through any number of parents.
function isUnder(t, id) {
  for (let p = t.parent; p; p = taskById.get(p.id)?.parent) if (p.id === id) return true;
  return false;
}

// A task and the rows of its subtasks, which Todoist moves with it.
// shortcut: a subtask that has a row, moved to another project, is not redrawn as a task there, and the parent's subtasks[] keeps its content and due; the next reload fixes them.
function moveLocal(id, projectId) {
  for (const t of todo.tasks) if (t.id === id || isUnder(t, id)) t.projectId = projectId;
}

// Completes (`done` true), reopens (false) or deletes (null) a task. In the subtask list of the task holding it, it turns done, open or goes, and the counts follow.
// A completed or deleted one leaves the list with the rows of its subtasks. A reopened one has no row until the reload, which has the data for it.
function settleLocal(id, done) {
  for (const p of todo.tasks) {
    const s = p.subtasks.find((s) => s.id === id);
    if (!s) continue;
    if (done === null) p.subtasks = p.subtasks.filter((x) => x !== s);
    else s.done = done;
    // Active subtasks first, then the completed ones.
    p.subtasks.sort((a, b) => a.done - b.done);
    p.subDone = p.subtasks.filter((x) => x.done).length;
    p.subTotal = p.subtasks.length;
  }
  // shortcut: a reopened subtask keeps its place among the done ones, and has no row; the next reload fixes it.
  if (done !== false) todo.tasks = todo.tasks.filter((t) => t.id !== id && !isUnder(t, id));
}

const saveTask = (id, fields) =>
  todoCall("todoist_update", { id, ...fields }, null, () => patchTask(id, fields), !("content" in fields || "description" in fields));
const moveTask = (id, projectId) => todoCall("todoist_move", { id, projectId }, null, () => moveLocal(id, projectId));
const setTaskDone = (id, done, box) => todoCall("todoist_set_done", { id, done }, box, () => settleLocal(id, done));

// The menu under `anchor`; one at a time, closed by a pick, a click elsewhere, or Escape.
let menuEl = null;

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

// Shows `node` as the open menu, under `anchor` and inside the window.
function showMenu(anchor, node) {
  closeMenu();
  menuEl = node;
  document.body.append(node);
  const r = anchor.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(r.left, innerWidth - node.offsetWidth - 8))}px`;
  const top = Math.max(8, Math.min(r.bottom + 4, innerHeight - node.offsetHeight - 8));
  node.style.top = `${top}px`;
  // The top stays where it is when the menu grows later (the channel list), so the growth stops at the window's edge.
  node.style.maxHeight = `${innerHeight - top - 8}px`;
}

function openMenu(anchor, items) {
  const menu = tag("div", "menu");
  menu.setAttribute("role", "menu");
  for (const item of items) {
    const b = tag("button");
    b.setAttribute("role", "menuitem");
    b.setAttribute("aria-current", String(item.current));
    const dot = tag("span", "pdot");
    dot.style.background = item.color;
    b.append(dot, item.label);
    b.onclick = () => {
      closeMenu();
      item.pick();
    };
    menu.append(b);
  }
  showMenu(anchor, menu);
  menu.querySelector("button").focus();
}

document.addEventListener("pointerdown", (e) => {
  if (menuEl && !e.target.closest(".menu")) closeMenu();
});
// An Escape that cancels IME conversion is the field's, not the menu's.
document.addEventListener("keydown", (e) => e.key === "Escape" && !composing(e) && closeMenu());

function chip(svg, text, className = "") {
  const b = tag("button", `chip ${className}`.trim());
  b.insertAdjacentHTML("beforeend", svg);
  b.append(text);
  return b;
}

// A month of days to pick from, Sunday first; `shown` is the 1st of the month, `due` and today are marked.
function monthPicker(shown, due, pick) {
  const box = tag("div", "dp");
  // The pressed arrow is replaced with the month, so the focus moves to the new one.
  const move = (n) => {
    const moved = monthPicker(new Date(shown.getFullYear(), shown.getMonth() + n, 1), due, pick);
    box.replaceWith(moved);
    moved.querySelectorAll(".dp-nav")[n < 0 ? 0 : 1].focus();
  };
  const head = tag("div", "dp-head");
  const prev = tag("button", "dp-nav", "‹");
  const next = tag("button", "dp-nav", "›");
  prev.setAttribute("aria-label", "前の月");
  next.setAttribute("aria-label", "次の月");
  prev.onclick = () => move(-1);
  next.onclick = () => move(1);
  head.append(prev, `${shown.getFullYear()}年${shown.getMonth() + 1}月`, next);
  const grid = tag("div", "dp-grid");
  for (const w of WEEKDAYS) grid.append(tag("span", "dp-wd", w));
  const today = isoDate(new Date());
  const first = isoDate(shown);
  for (let i = -shown.getDay(); i < 42 - shown.getDay(); i++) {
    const day = addDays(first, i);
    const iso = isoDate(day);
    const b = tag("button", "dp-day", String(day.getDate()));
    if (day.getMonth() !== shown.getMonth()) b.classList.add("other");
    if (iso === today) b.classList.add("today");
    if (iso === due?.date) b.classList.add("current");
    b.onclick = () => pick(iso);
    grid.append(b);
  }
  box.append(head, grid);
  return box;
}

// The due popover opens a text field taking Todoist's natural language ("明日 15時", "毎週月曜"; empty clears the due date) over a month to pick a day from.
// A repeating task gets the text field only: a picked day would replace its repeat.
function openDuePop(anchor, t) {
  const pop = tag("div", "menu due-pop");
  const input = tag("input", "chip-input");
  input.value = t.due?.string ?? "";
  input.placeholder = "例: 明日 15時";
  input.setAttribute("aria-label", "期限（空欄で期限なし）");
  input.onkeydown = (e) => {
    if (composing(e)) return;
    if (e.key !== "Enter") return;
    closeMenu();
    if (input.value.trim() !== (t.due?.string ?? "")) saveTask(t.id, { dueString: input.value });
  };
  const month = t.due ? addDays(t.due.date, 0) : new Date();
  pop.append(input);
  if (!t.due?.recurring)
    pop.append(
      monthPicker(new Date(month.getFullYear(), month.getMonth(), 1), t.due, (iso) => {
        closeMenu();
        if (iso === t.due?.date) return;
        saveTask(t.id, { dueString: t.due?.time ? `${iso} ${t.due.time}` : iso });
      }),
    );
  showMenu(anchor, pop);
  input.focus();
  input.select();
}

function dueChip(t) {
  const b = chip(DATE_SVG, t.due ? dueLabel(t.due) : "期限なし", t.bucket === "overdue" ? "over" : "");
  b.onclick = () => openDuePop(b, t);
  return b;
}

function openProjectMenu(anchor, t) {
  openMenu(
    anchor,
    todo.projects.map((x) => ({
      label: projectName(x),
      color: x.color,
      current: x.id === t.projectId,
      pick: () => x.id !== t.projectId && moveTask(t.id, x.id),
    })),
  );
}

function projectChip(t) {
  const p = projectOf(t.projectId);
  const b = tag("button", "chip");
  const dot = tag("span", "pdot");
  dot.style.background = p?.color;
  b.append(dot, projectName(p));
  b.onclick = () => openProjectMenu(b, t);
  return b;
}

function priorityChip(t) {
  const b = chip(FLAG_SVG, `優先度 ${t.priority}`);
  b.style.color = PRIORITY_COLORS[t.priority];
  b.onclick = () =>
    openMenu(
      b,
      [1, 2, 3, 4].map((n) => ({
        label: `優先度 ${n}`,
        color: PRIORITY_COLORS[n],
        current: n === t.priority,
        pick: () => n !== t.priority && saveTask(t.id, { priority: n }),
      })),
    );
  return b;
}

// WebKit fires compositionend before the keydown of the Enter that confirms a conversion, so isComposing is already false then; keyCode is 229.
const composing = (e) => e.isComposing || e.keyCode === 229;

// Pressing Enter in a field commits it; Enter that confirms an IME conversion does not.
const onEnter = (input, action) => {
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !composing(e)) action();
  };
};

function subtaskRow(s) {
  const li = tag("li", `task single${s.done ? " done" : ""}`);
  const box = checkBox(PRIORITY_COLORS[4], s.done, s.done ? "未完了に戻す" : "完了にする");
  box.onchange = () => {
    li.classList.toggle("done", box.checked);
    setTaskDone(s.id, box.checked, box);
  };
  // A subtask with subtasks of its own has a row among the tasks, so it opens like one; otherwise nothing could reach its subtasks.
  if (taskById.has(s.id)) {
    li.onclick = () => {
      todoOpen = s.id;
      renderTodo();
    };
    box.onclick = (e) => e.stopPropagation();
  }
  const body = tag("div", "body");
  body.append(tag("div", "t", s.content));
  const trail = tag("div", "trail");
  trail.append(tag("span", "due", s.due ? dueLabel(s.due) : ""));
  li.append(box, body, trail);
  return li;
}

function renderDetail() {
  const t = taskById.get(todoOpen);
  if (!t) {
    todoOpen = null;
    return renderList();
  }
  // A reload redraws the whole detail; the field being typed in keeps the focus and the caret.
  const active = document.activeElement;
  const field = $("todo-detail").contains(active) ? active.dataset.field : null;
  const caret = active.selectionStart;
  // What was typed into the subtask field of this task is not lost to the redraw.
  const typed = $("todo-detail").dataset.task === t.id ? $("todo-detail").querySelector('[data-field="sub"]')?.value ?? "" : "";
  todoMode("detail");
  $("todo-title").textContent = projectName(projectOf(t.projectId));

  const box = checkBox(PRIORITY_COLORS[t.priority], false, "完了にする");
  box.onchange = () => setTaskDone(t.id, true, box);
  const name = tag("input", "name");
  name.value = t.content;
  name.dataset.field = "name";
  name.setAttribute("aria-label", "タスクの名前");
  name.onchange = () => (name.value.trim() ? saveTask(t.id, { content: name.value }) : (name.value = t.content));
  onEnter(name, () => name.blur());
  const head = tag("div", "head");
  head.append(box, name);

  const meta = tag("div", "meta");
  meta.append(dueChip(t), projectChip(t), priorityChip(t));

  const desc = tag("textarea");
  desc.value = t.description;
  desc.placeholder = "説明を追加";
  desc.dataset.field = "desc";
  desc.setAttribute("aria-label", "説明");
  desc.onblur = () => desc.value !== t.description && saveTask(t.id, { description: desc.value });

  const parts = [head, meta, desc];
  const mail = linkedMail(t, accountSet());
  if (mail) {
    const card = tag("div", "mail-link");
    card.insertAdjacentHTML("beforeend", MAIL_SVG);
    const text = tag("span");
    text.append(tag("b", "", t.content), ` — ${mail.account}`);
    card.append(text, tag("span", "go", "メールを開く"));
    card.onclick = () => openMailFromTodo(mail);
    parts.push(card);
  }

  const title = tag("div", "section-title", t.subTotal ? `サブタスク ${t.subDone}/${t.subTotal}` : "サブタスク");
  if (t.subTotal) {
    const bar = tag("span", "bar");
    const fill = tag("i");
    fill.style.width = `${(t.subDone / t.subTotal) * 100}%`;
    bar.append(fill);
    title.append(bar);
  }
  const subs = tag("ul", "subs");
  subs.append(...t.subtasks.map(subtaskRow));
  const add = tag("div", "add-sub");
  add.insertAdjacentHTML("beforeend", PLUS_SVG);
  const input = tag("input");
  input.placeholder = "サブタスクを追加";
  input.dataset.field = "sub";
  input.value = typed;
  input.setAttribute("aria-label", "サブタスクを追加");
  onEnter(input, () => {
    const content = input.value;
    if (!content.trim()) return;
    // Emptied before the call, or the redraw after it would restore the text.
    input.value = "";
    // No control is passed: disabling the field would drop its focus, and the next subtask could not be typed at once.
    todoCall("todoist_add_subtask", { parentId: t.id, content });
  });
  add.append(input);
  parts.push(title, subs, add);

  $("todo-detail").replaceChildren(...parts);
  $("todo-detail").dataset.task = t.id;
  if (field) {
    const again = $("todo-detail").querySelector(`[data-field="${field}"]`);
    again?.focus();
    if (caret != null) again?.setSelectionRange?.(caret, caret);
  }
}

function renderTodo() {
  todoUndrawn = false;
  if (!projectOf(todoView) && todoView !== "today" && todoView !== "inbox") todoView = "today";
  renderProjects();
  if (todoOpen) renderDetail();
  else renderList();
}

// Whether a text field holds what the user is typing (a field of the open task, or a name being edited in the list); a redraw would replace it with Todoist's older value.
// The subtask field counts only while it has text: it is emptied on Enter, and the redraw must show the subtask just added.
function editingField() {
  if (todoDragging) return true;
  const a = document.activeElement;
  if ($("todo-list").contains(a)) return a.matches(".row-edit");
  return $("todo-detail").contains(a) && a.matches("textarea, input:not([type=checkbox])") && (a.dataset.field !== "sub" || a.value !== "");
}

// The data of the last quiet load as text, to tell a refresh that changed nothing; null after any other load, since the screen may differ from it then.
let todoText = null;

// Set when a load updated `todo` without drawing it (a field was being typed in), so the next quiet refresh draws it even if nothing else changed.
let todoUndrawn = false;

// Says that the list is the last one fetched (`offline` is set by the backend), or clears the notice.
function drawTodoNotice(offline) {
  const notice = $("todo-notice");
  let text = "";
  if (offline) {
    const d = new Date(offline.fetchedAt);
    text = `Todoist に接続できません（${offline.reason}）。${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())} 時点の内容を表示しています。`;
  }
  // Drawn again only when the words change.
  if (notice.textContent === text) return;
  const div = document.createElement("div");
  div.textContent = text;
  notice.replaceChildren(...(text ? [div] : []));
}

// Fetches the tasks and draws them. `quiet` is the timed refresh: it fetches nothing while a field is being typed in, and draws nothing when nothing changed.
// Without `withDone` the backend reuses the completed tasks it fetched last. Returns true when a token is needed (the token form is shown).
async function loadTodo(quiet = false, withDone = true) {
  if (quiet && (editingField() || todoWrites)) return false;
  const seq = ++todoSeq;
  try {
    const data = await invoke("todoist_load", { withDone });
    // Not while a change is in flight: the reload after the last one draws.
    if (seq !== todoSeq || screen !== "todo" || todoWrites) return false;
    if (data === null) {
      showTokenForm();
      return true;
    }
    const text = quiet ? JSON.stringify(data) : null;
    const same = text !== null && text === todoText;
    todoText = text;
    todo = data;
    todoCountOff = false;
    // Also while a field is being typed in, when nothing is drawn below.
    setTodoCount(data.tasks.filter(isDueToday).length);
    projectById = new Map(data.projects.map((p) => [p.id, p]));
    taskById = new Map(data.tasks.map((t) => [t.id, t]));
    drawTodoNotice(data.offline);
    // A field being typed in keeps what was typed; the detail is drawn after the focus leaves, by the next save's load or the next refresh.
    if (editingField()) {
      todoUndrawn = true;
      return false;
    }
    if (quiet && same && !todoUndrawn) return false;
    renderTodo();
  } catch (e) {
    showError(e);
  }
  return false;
}

// Todoist cannot undo a delete, so the button asks twice: the first press changes its label, the second deletes.
let deleteTimer = 0;
function resetDelete() {
  clearTimeout(deleteTimer);
  const b = $("todo-delete");
  b.classList.remove("confirm", "danger");
  b.innerHTML = DELETE_SVG;
  b.setAttribute("aria-label", "削除");
}

$("todo-delete").onclick = () => {
  const b = $("todo-delete");
  if (!b.classList.contains("confirm")) {
    b.classList.add("confirm", "danger");
    b.textContent = "もう一度押すと削除";
    b.setAttribute("aria-label", "もう一度押すと削除");
    deleteTimer = setTimeout(resetDelete, 4000);
    return;
  }
  const id = todoOpen;
  todoOpen = null;
  // Gone from the list at once; the reload after the call brings it back if Todoist refused.
  todoCall("todoist_delete", { id }, null, () => settleLocal(id, null));
};
$("todo-delete").onblur = resetDelete;
$("todo-back").onclick = () => {
  todoOpen = null;
  renderTodo();
};
$("todo-reload").onclick = () => loadTodo();
$("todo-disconnect").onclick = async () => {
  $("error").hidden = true;
  try {
    await invoke("todoist_disconnect");
    showTokenForm("Todoist の接続を解除しました");
  } catch (e) {
    showError(e);
  }
};
$("todo-token").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("todo-token-input");
  const token = input.value;
  // The token is never shown: the field is emptied as soon as it is read.
  input.value = "";
  $("error").hidden = true;
  try {
    await invoke("todoist_save_token", { token });
  } catch (err) {
    return showError(err);
  }
  // Only a rejected token says so; a failed load (network, 5xx) shows its own error.
  if (await loadTodo()) showTokenForm("トークンを確認できませんでした。もう一度入力してください");
};
$("todo-add").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("todo-add-input");
  const text = input.value.trim();
  if (!text) return;
  // In "今日" the task goes where Quick Add puts it (the inbox, or the project named in the text), and a text with no date is due today.
  const inToday = todoView === "today";
  const projectId = inToday ? null : viewProjectId(todoView);
  const added = await todoCall("todoist_add", { text, projectId, today: inToday }, input);
  if (added !== null) {
    input.value = "";
    // false: created, but the move into the project failed (it is in the inbox) or, in "今日", the due date could not be set.
    toast(
      added
        ? "タスクを追加しました"
        : inToday
          ? "タスクを追加しましたが、期限を今日にできませんでした"
          : "タスクを追加しましたが、プロジェクトへ移せませんでした。受信箱にあります",
    );
  }
  input.focus();
};

// Fetches only for the Todo count on the sidebar while another screen is shown: `todo` and the Todo screen stay as they are, and a missing token or a failure shows no count and no message.
async function loadTodoCount() {
  if (screen === "todo" || document.hidden || todoCountOff || todoWrites) return;
  // A change that started or ended while fetching makes the answer older than the screen's count.
  const seq = todoSeq;
  let count = 0;
  try {
    const data = await invoke("todoist_load", { withDone: countWithDone });
    if (data) {
      countWithDone = false;
      count = data.tasks.filter(isDueToday).length;
    } else todoCountOff = true;
  } catch {}
  // The Todo screen sets the count itself, and its data is newer than this fetch.
  if (screen !== "todo" && !todoWrites && seq === todoSeq) setTodoCount(count);
}
loadTodoCount();

// The timed refresh, also when the window comes back. The backend asks Todoist for the changes only, so it is cheap; the completed tasks are not fetched again.
// One at a time: while Todoist does not answer, the next rounds are skipped instead of piling up behind the backend's lock.
let refreshingTodo = false;
async function refreshTodo() {
  if (refreshingTodo || document.hidden) return;
  refreshingTodo = true;
  try {
    if (screen !== "todo") await loadTodoCount();
    // Not while the token form is up: a load would read the keychain and draw the form again, dropping what is typed in it.
    else if ($("todo-token").hidden) await loadTodo(true, false);
  } finally {
    refreshingTodo = false;
  }
}
setInterval(refreshTodo, TODO_REFRESH_MS);
document.addEventListener("visibilitychange", refreshTodo);

// Settings: the Slack workspaces. A token is never shown; Rust keeps it in the keychain.
let settingsSeq = 0;

// teamId -> the last `slack_check` of that workspace's token. A redraw after an add or a removal reuses it,
// except for a workspace that is new, has a different user (its token was replaced), or was not usable.
const wsChecks = new Map();
function checkWorkspace(w) {
  const prev = wsChecks.get(w.teamId);
  if (prev && !prev.bad && prev.user === w.user) return prev;
  const c = { user: w.user, bad: false };
  c.done = invoke("slack_check", { teamId: w.teamId }).then(
    (r) => ({ text: `${r.user} ・ 接続済み`, bad: false }),
    (e) => {
      c.bad = true;
      return { text: `確認できません: ${e}`, bad: true };
    },
  );
  wsChecks.set(w.teamId, c);
  return c;
}

// Draws the workspaces, then asks Slack about each token that has not been asked: a row says why when its token is not usable.
function renderWorkspaces(list) {
  const seq = ++settingsSeq;
  $("slack-workspaces").replaceChildren(
    ...(list.length ? list : [null]).map((w) => {
      const li = tag("li");
      if (!w) {
        li.append(tag("span", "ws-meta", "ワークスペースはまだありません"));
        return li;
      }
      const meta = tag("span", "ws-meta", `${w.user} ・ 確認しています…`);
      const del = tag("button", "text-btn danger", "接続を解除");
      del.setAttribute("aria-label", `${w.team} の接続を解除`);
      del.onclick = async () => {
        $("error").hidden = true;
        try {
          const left = await invoke("slack_remove_workspace", { teamId: w.teamId });
          wsChecks.delete(w.teamId);
          renderWorkspaces(left);
        } catch (e) {
          showError(e);
        }
      };
      li.append(tag("span", "ws-name", w.team), meta, del);
      checkWorkspace(w).done.then((r) => {
        if (seq !== settingsSeq) return;
        meta.textContent = r.text;
        meta.classList.toggle("bad", r.bad);
      });
      return li;
    }),
  );
}

async function loadSettings() {
  const seq = ++settingsSeq;
  $("error").hidden = true;
  let loaded;
  try {
    loaded = await invoke("slack_load");
  } catch (e) {
    return showError(e);
  }
  if (seq !== settingsSeq) return;
  // Opening the settings asks about every token again.
  wsChecks.clear();
  renderWorkspaces(loaded.workspaces);
}

$("slack-token").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("slack-token-input");
  const token = input.value;
  // The token is never shown: the field is emptied as soon as it is read.
  input.value = "";
  $("error").hidden = true;
  try {
    renderWorkspaces(await invoke("slack_add_workspace", { token }));
  } catch (err) {
    showError(err);
  }
};

// "Slack に貼る": posts the open thread's latest message. The text of an HTML message is read from its frame (allow-same-origin).
function latestText() {
  const m = current.latest;
  if (!m.html) return m.body;
  const doc = $("messages").lastElementChild?.querySelector("iframe")?.contentDocument;
  return doc?.body?.innerText.trim() || unescapeHtml(m.snippet);
}
const slackDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

$("thread-slack").onclick = async () => {
  $("error").hidden = true;
  let loaded;
  try {
    loaded = await invoke("slack_load");
  } catch (e) {
    return showError(e);
  }
  const { workspaces, recent } = loaded;
  if (!workspaces.length)
    return toast("Slack のワークスペースを設定で追加してください", { label: "設定を開く", run: () => setScreen("settings") });
  const mail = {
    subject: current.subject || "(件名なし)",
    from: current.latest.from,
    date: slackDate(current.latest.dateMs),
    body: latestText(),
  };
  let preview;
  try {
    preview = await invoke("slack_preview", mail);
  } catch (e) {
    return showError(e);
  }
  const wsName = (teamId) => workspaces.find((w) => w.teamId === teamId)?.team ?? "";
  const label = (t) => `#${t.name}${t.threadTs ? "（スレッド）" : ""}`;
  const pop = tag("div", "menu slack-pop");
  const input = (name, placeholder) => {
    const node = tag("input");
    node.setAttribute("aria-label", name);
    node.placeholder = placeholder;
    node.autocomplete = "off";
    return node;
  };

  // The workspace whose channels are searched; with one workspace it is not shown.
  const wsSelect = tag("select");
  wsSelect.setAttribute("aria-label", "ワークスペース");
  workspaces.forEach((w) => wsSelect.append(new Option(w.team, w.teamId)));
  const chosenEl = tag("p", "chosen", "貼り付け先を選んでください");
  const note = tag("textarea");
  note.rows = 2;
  note.placeholder = "ひとこと（任意）";
  note.setAttribute("aria-label", "ひとこと");
  const err = tag("p", "err");
  err.setAttribute("role", "alert");
  err.hidden = true;
  const post = tag("button", "text-btn", "貼る");
  post.disabled = true;

  // Where the mail goes: set by a recent destination, a channel, or a link.
  let chosen = null;
  const choose = (t) => {
    chosen = t;
    chosenEl.textContent = `貼り付け先: ${wsName(t.teamId)} ・ ${label(t)}`;
    err.hidden = true;
    post.disabled = false;
    if (wsSelect.value !== t.teamId) {
      wsSelect.value = t.teamId;
      loadChannels(false);
    }
  };

  const recentList = tag("div", "pick-list");
  recentList.append(
    ...recent.map((r) => {
      const b = tag("button", "", label(r));
      b.append(tag("span", "ws", wsName(r.teamId)));
      b.onclick = () => choose(r);
      return b;
    }),
  );

  const search = input("チャンネルを検索", "チャンネルを検索");
  const reload = tag("button", "text-btn", "更新");
  reload.setAttribute("aria-label", "チャンネルの一覧を取り直す");
  const channelList = tag("div", "pick-list");
  let channels = [];
  let channelsSeq = 0;
  const drawChannels = () => {
    const q = search.value.trim().toLowerCase();
    const hits = channels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 50);
    channelList.replaceChildren(
      ...(hits.length
        ? hits.map((c) => {
            const b = tag("button", "", `#${c.name}`);
            b.onclick = () => choose({ teamId: wsSelect.value, channel: c.id, name: c.name, threadTs: null });
            return b;
          })
        : [tag("p", "empty", "該当するチャンネルがありません")]),
    );
  };
  const loadChannels = async (refresh) => {
    const seq = ++channelsSeq;
    channels = [];
    channelList.replaceChildren(tag("p", "empty", "読み込んでいます…"));
    try {
      const got = await invoke("slack_channels", { teamId: wsSelect.value, refresh });
      if (seq !== channelsSeq) return;
      channels = got;
      drawChannels();
    } catch (e) {
      if (seq === channelsSeq) channelList.replaceChildren(tag("p", "err", String(e)));
    }
  };
  search.oninput = drawChannels;
  wsSelect.onchange = () => loadChannels(false);
  reload.onclick = () => loadChannels(true);

  const link = tag("form", "row");
  const url = input("Slack のリンク", "https://…slack.com/archives/…");
  link.append(url, tag("button", "text-btn", "選ぶ"));
  link.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      choose(await invoke("slack_link", { url: url.value }));
    } catch (error) {
      err.textContent = String(error);
      err.hidden = false;
    }
  };

  post.onclick = async () => {
    const t = chosen;
    err.hidden = true;
    post.disabled = true;
    try {
      await invoke("slack_post", { teamId: t.teamId, channel: t.channel, threadTs: t.threadTs, name: t.name, note: note.value, ...mail });
      closeMenu();
      toast(`${wsName(t.teamId)} の ${label(t)} に貼りました`);
    } catch (e) {
      err.textContent = String(e);
      err.hidden = false;
      post.disabled = false;
    }
  };

  const searchRow = tag("div", "row");
  searchRow.append(search, reload);
  if (workspaces.length > 1) pop.append(wsSelect);
  if (recent.length) pop.append(tag("h3", "", "最近使った先"), recentList);
  pop.append(tag("h3", "", "チャンネルを探す"), searchRow, channelList, tag("h3", "", "リンクから選ぶ"), link, chosenEl);
  pop.append(tag("pre", "preview", preview), note, err, post);
  showMenu($("thread-slack"), pop);
  loadChannels(false);
  search.focus();
};


load();
