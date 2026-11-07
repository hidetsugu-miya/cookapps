// The thread detail view: the messages of the open thread, their folding, and the buttons of its header.
import type { MessageDetail } from "./bindings/MessageDetail";
import { $, span } from "./dom.js";
import { avatarColor, formatDate, formatDetailDate, initials, recipientsLabel, senderName, splitAddress, unescapeHtml } from "./format.js";
import { PERSON_SVG } from "./icons.js";
import { dismiss } from "./arrivals.js";
import { applySync, load, removeRow } from "./inbox.js";
import { rowKey, rows, setReadState, updateBadge } from "./inbox-rows.js";
import { invoke } from "./ipc.js";
import { autoFit, fitAfterImages, frameObserver, plainBody, routeLinks, withBodyCsp } from "./mail-frame.js";
import { externalImages, knownSenders, offerImages, resetImageBars, showCidImages, type ThreadCtx } from "./mail-images.js";
import { clearSummary, renderSummary, summaryPressed } from "./mail-summary.js";
import { linkify } from "./mail-text.js";
import { currentScreen, setScreen } from "./nav.js";
import { HandoffPane } from "./orca-handoff.js";
import { mailCard } from "./orca-handoff-cards.js";
import { initSplit } from "./split.js";
import { makeTodo } from "./todo-add.js";
import { show, showError } from "./view.js";

// The thread shown in the detail view and its list row (null for a thread opened from Todo that the list does not hold).
export interface OpenThread {
  id: string;
  account: string;
  li: HTMLLIElement | null;
  messages: MessageDetail[];
  subject: string;
}
export const opened: { current: OpenThread | null } = { current: null };

// The thread the detail view is waiting for, or shows a failure for, in place of `opened` (which is empty until the thread arrives).
export const loading: { current: { id: string; account: string } | null } = { current: null };

// The pane that hands the open thread to Orca (A-9).
let handoff: HandoffPane;

// The screen the open thread was opened from ("mail" or "todo"): where "戻る" goes.
let threadOrigin: "mail" | "todo" = "mail";

// Bumped by every openThread: a result that arrives for an earlier thread sees the number has moved on and leaves the page alone.
let openCount = 0;

// The header of an open message: avatar, sender, recipients and date. A div, so the address can be selected;
// when the message can be folded it acts as a button (`message` adds the click).
function openHead(m: MessageDetail, account: string, foldable: boolean) {
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
function foldedHead(m: MessageDetail) {
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

// `ctx` is the open thread's.
// `folded` starts the message as one line; the head toggles it. A thread's only message has no toggle.
function message(m: MessageDetail, ctx: ThreadCtx, account: string, folded: boolean, foldable: boolean) {
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
    const fold = (folded: boolean) => {
      article.classList.toggle("folded", folded);
      line.hidden = !folded;
      open.hidden = folded;
      body.hidden = folded;
      if (!folded && !body.firstChild) build();
    };
    // The head that was clicked goes away, so the focus moves to its counterpart.
    line.onclick = () => {
      fold(false);
      open.focus();
    };
    // Dragging over the address to copy it ends in a click; it must not fold the message.
    open.onclick = () => {
      if (getSelection()!.toString()) return;
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
async function markRead(account: string, id: string) {
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

// The buttons of the header that act on the loaded thread. They are disabled until it arrives; "戻る" is not one of them.
const ACTIONS = ["thread-summary", "thread-slack", "thread-todo", "thread-orca", "trash", "archive"];

// What the detail view holds until the thread arrives: the sender the list row has (none for a thread opened from Todo with no row),
// and in the body's place a note and gray lines. The body is returned, so a failure can take its place.
function loadingMessage(from: string | undefined) {
  const article = document.createElement("article");
  const head = document.createElement("div");
  head.className = "msg-head";
  const avatar = span("msg-avatar", "");
  avatar.innerHTML = PERSON_SVG;
  const who = span("who", "");
  if (from) {
    const { name, address } = splitAddress(from);
    who.append(span("name", name || address));
    if (name) who.append(" ", span("addr", `<${address}>`));
  }
  head.append(avatar, who);
  const body = document.createElement("div");
  body.className = "msg-body";
  body.setAttribute("role", "status");
  const note = document.createElement("div");
  note.className = "msg-loading";
  note.append(span("spin", ""), "読み込んでいます…");
  const bars = document.createElement("div");
  bars.className = "msg-bars";
  bars.append(span("", ""), span("", ""), span("", ""));
  body.append(note, bars);
  article.append(head, body);
  return { article, body };
}

// `thread` is the row's item (or just the ids, for a thread opened from Todo with no row): its subject and sender are shown at once, and the body once Gmail answers.
export async function openThread(
  { id, account, subject, from }: { id: string; account: string; subject?: string; from?: string },
  li: HTMLLIElement | null,
  origin: "mail" | "todo" = "mail",
) {
  $("error").hidden = true;
  dismiss(rowKey({ id, account }));
  const seq = ++openCount;
  // Until the thread arrives nothing is open: no button acts on the thread that was open before.
  opened.current = null;
  loading.current = { id, account };
  threadOrigin = origin;
  clearSummary();
  const { article, body } = loadingMessage(from);
  $("thread-subject").textContent = subject === undefined ? "" : subject || "(件名なし)";
  $("messages").replaceChildren(article);
  show("thread");
  $("thread").setAttribute("aria-busy", "true");
  for (const button of ACTIONS) $<HTMLButtonElement>(button).disabled = true;
  // A thread opened from Todo may be out of the list; with no row there is nothing to take out of it.
  $("trash").hidden = $("archive").hidden = $("thread-label").hidden = !li;
  handoff.sync();
  try {
    const t = await invoke("thread", { account, id });
    if (seq !== openCount) return;
    $("thread").removeAttribute("aria-busy");
    loading.current = null;
    // null: that account must log in again, which the list shows.
    if (t === null) {
      if (currentScreen() === "mail") show("list");
      handoff.sync();
      return load();
    }
    opened.current = { id, account, li, messages: t.messages, subject: t.subject };
    $("thread-subject").textContent = t.subject || "(件名なし)";
    // The images that had to be fetched come separately, so the body is not held up by them.
    const cids = t.pendingImages?.length
      ? invoke("thread_images", { account, id, images: t.pendingImages }).catch(() => ({}))
      : Promise.resolve({});
    // Only a message Gmail vouches for can show its images by itself, so only its sender is asked about.
    const froms = [...new Set(t.messages.filter((m) => m.html && m.authenticated).map((m) => m.from))];
    const ctx: ThreadCtx = { cids, froms, senders: knownSenders(froms), stale: () => seq !== openCount };
    frameObserver.disconnect();
    resetImageBars();
    // Newest first. Only the latest message (the first) is open when the thread has several.
    const several = t.messages.length > 1;
    $("messages").replaceChildren(
      ...[...t.messages].reverse().map((m, i) => message(m, ctx, account, several && i > 0, several)),
    );
    // A Todo still being made from the thread opened before keeps its button until it ends.
    for (const button of ACTIONS) {
      $<HTMLButtonElement>(button).disabled = button === "thread-todo" && $(button).classList.contains("busy");
    }
    renderSummary(opened.current);
    if (t.unread) markRead(account, id);
    handoff.sync();
  } catch (e) {
    if (seq !== openCount) return;
    $("thread").removeAttribute("aria-busy");
    // The loading body is gone once the messages replaced it: the error then goes where every error does.
    if (body.isConnected) body.replaceChildren(span("msg-fail", String(e)));
    else showError(e);
  }
}

export function goBack() {
  $("error").hidden = true;
  // A thread still loading is left: its answer is ignored.
  openCount++;
  loading.current = null;
  if (threadOrigin === "todo") setScreen("todo");
  else show("list");
  handoff.sync();
}

// Detail view "trash" / "archive": back to the list at once, the work runs in the background.
function removeCurrent(command: "archive" | "trash") {
  if (threadOrigin === "todo") setScreen("todo");
  else show("list");
  handoff.sync();
  const current = opened.current!;
  removeRow(command, current.account, current.id, current.li!);
}

export function initThread() {
  handoff = new HandoffPane({
    root: $("mail-handoff"),
    current: () => {
      const t = opened.current;
      return $("thread").hidden || !t ? null : { key: `mail:${t.account}/${t.id}`, card: () => mailCard(t.subject, t.messages) };
    },
    onOpen: (open) => {
      $("mail-handoff").hidden = !open;
      $("mail-split").hidden = !open;
      $("thread-orca").setAttribute("aria-pressed", String(open));
    },
  });
  $("thread-orca").onclick = () => handoff.toggle();
  initSplit($("mail-area"), $("mail-split"), { initial: 0.37 });
  $("back").onclick = goBack;
  $("thread-todo").onclick = () => {
    const current = opened.current;
    if (!current) return;
    makeTodo(current.account, current.id, $("thread-subject").textContent!, $<HTMLButtonElement>("thread-todo"));
  };
  $("thread-summary").onclick = () => summaryPressed(opened.current!);
  $("trash").onclick = () => removeCurrent("trash");
  $("archive").onclick = () => removeCurrent("archive");
}
