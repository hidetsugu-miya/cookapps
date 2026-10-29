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

// Display name of a From header: the Name of `Name <addr>`, else the address.
function senderName(from) {
  const m = from.match(/^\s*"?(.*?)"?\s*<([^>]*)>\s*$/);
  return m ? m[1] || m[2] : from.trim();
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
  const own = view === "calendar" || view === "todo";
  $("calendar").hidden = view !== "calendar";
  $("todo").hidden = view !== "todo";
  $("mail-header").hidden = own;
  $("main").hidden = own;
  $("login").hidden = view !== "login";
  $("relogin").hidden = view !== "list" || !$("relogin").hasChildNodes();
  $("threads").hidden = view !== "list";
  $("reload").hidden = view !== "list";
  $("thread").hidden = view !== "thread";
  $("back").hidden = view !== "thread";
  $("thread-todo").hidden = view !== "thread";
  $("trash").hidden = view !== "thread";
  $("archive").hidden = view !== "thread";
  $("thread-subject").hidden = view !== "thread";
  $("title").hidden = view === "thread";
  $("main").scrollTop = view === "list" ? listScroll : 0;
}

function showError(e) {
  $("error").textContent = String(e);
  $("error").hidden = false;
}

// Reflects the read state in the row: bold, dot, and checkbox.
function setReadState(t, li, read) {
  t.unread = !read;
  li.classList.toggle("unread", !read);
  const box = li.querySelector(".read-box");
  box.checked = read;
  box.setAttribute("aria-label", read ? "未読にする" : "既読にする");
}

// Updates UNREAD in Gmail; `control` is disabled while sending. On failure the row returns to its last known state.
async function sendRead(t, li, read, control) {
  $("error").hidden = true;
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

// Dock badge shows the unread count of the list; the call is skipped when the count is unchanged.
let badge = 0;
function updateBadge() {
  const count = countUnread(rows, pending);
  if (count === badge) return;
  badge = count;
  invoke("set_badge", { count }).catch(() => {});
}

// Takes the row out at once and runs "archive" / "trash" in the background; on failure the row comes back.
async function removeRow(command, account, id, li) {
  const key = `${account}/${id}`;
  const list = li.parentNode;
  const next = li.nextSibling;
  pending.add(key);
  li.remove();
  updateBadge();
  $("error").hidden = true;
  try {
    const done = await invoke(command, { account, id });
    if (done === null) return load();
    rows.delete(key);
  } catch (e) {
    list.insertBefore(li, next && next.parentNode === list ? next : null);
    showError(e);
  } finally {
    pending.delete(key);
    updateBadge();
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
    rowButton("todo-row", "Todo にする", TODO_SVG, (button) => makeTodo(t.account, t.id, t.subject, button)),
    rowButton("archive-row", "アーカイブ", CHECK_SVG, () => removeRow("archive", t.account, t.id, li)),
    rowButton("trash-row", "ゴミ箱へ移動", $("trash").innerHTML, () => removeRow("trash", t.account, t.id, li)),
  );
  trail.append(cell("date", formatDate(t.dateMs)), actions);
  li.append(readBox(t, li), cell("unread-dot", ""), avatar, cell("from", name), subject, trail);
  setReadState(t, li, !t.unread);
  return li;
}

function message(m) {
  const article = document.createElement("article");
  const head = document.createElement("div");
  head.className = "message-head";
  head.textContent = `${m.from} — ${new Date(m.dateMs).toLocaleString("ja-JP")}`;
  let body;
  if (m.html) {
    // Empty sandbox: no scripts, no same-origin access to the app.
    body = document.createElement("iframe");
    body.setAttribute("sandbox", "");
    body.srcdoc = m.body;
  } else {
    body = document.createElement("div");
    body.className = "plain";
    body.textContent = m.body;
  }
  article.append(head, body);
  return article;
}

// The thread shown in the detail view and its list row.
let current = null;

async function openThread({ id, account }, li, origin = "mail") {
  $("error").hidden = true;
  try {
    const t = await invoke("thread", { account, id });
    // null: that account must log in again, which the list shows.
    if (t === null) return load();
    current = { id, account, li };
    threadOrigin = origin;
    $("thread-subject").textContent = t.subject || "(件名なし)";
    $("messages").replaceChildren(...t.messages.map(message));
    show("thread");
    // A thread opened from Todo may be out of the list; with no row there is nothing to take out of it.
    $("trash").hidden = $("archive").hidden = !li;
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

// Which screen the sidebar selected: "mail", "calendar" or "todo". Background work reads it; only the sidebar changes it.
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
    $("threads").replaceChildren(...[...rows.values()].map((r) => r.li));
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
  if (old && old.li.dataset.dateMs === li.dataset.dateMs) {
    old.li.replaceWith(li);
  } else {
    if (old) old.li.remove();
    const next = [...$("threads").children].find((c) => Number(c.dataset.dateMs) < t.dateMs);
    $("threads").insertBefore(li, next || null);
  }
  if (old && current && current.li === old.li) current.li = li;
  if (focused) li.querySelector(`.${[...focused].join(".")}`)?.focus();
}

// Applies one account's changes in place: the first visible row stays where it is on screen.
// shortcut: with the detail view open the list cannot be measured, so rows added above shift it, upgrade if that bothers.
function applyChanges(threads, removedKeys) {
  const main = $("main");
  const top = main.getBoundingClientRect().top;
  const anchor = [...$("threads").children].find((li) => li.getBoundingClientRect().bottom > top);
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
  show("list");
  removeRow(command, current.account, current.id, current.li);
}
$("thread-todo").onclick = () => makeTodo(current.account, current.id, $("thread-subject").textContent, $("thread-todo"));
$("trash").onclick = () => removeCurrent("trash");
$("archive").onclick = () => removeCurrent("archive");
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
  box.append(el("cal-time", `${hhmm(e.startMin)} - ${hhmm(e.endMin)}`), el("cal-name", e.summary || "(件名なし)"));
  return box;
}

function chip(e) {
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
      const cell = mark(el("cal-cell"), i);
      cell.append(...w.allDay.filter((e) => e.day === i).map(chip));
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
      const col = mark(el("cal-col"), i);
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
  for (const [id, target] of [["nav-mail", "mail"], ["nav-calendar", "calendar"], ["nav-todo", "todo"]]) {
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
  } else {
    show("list");
  }
}

$("nav-mail").onclick = () => setScreen("mail");
$("nav-calendar").onclick = () => setScreen("calendar");
$("nav-todo").onclick = () => setScreen("todo");
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

function toast(text) {
  toastEl.textContent = text;
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
    if (done === null) return showError("Todoist に接続していません。Todo 画面でトークンを保存してください");
    toast(`受信箱に「${subject || "(件名なし)"}」を追加しました`);
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
}

const TODO_REFRESH_MS = 5 * 60 * 1000;
// The Todoist apps' colors for priorities 1 to 4.
const PRIORITY_COLORS = { 1: "#d1453b", 2: "#eb8909", 3: "#246fe0", 4: "#b4b9c2" };
const TODO_GROUPS = [["overdue", "期限切れ"], ["today", "今日"], ["upcoming", "明日以降"], ["none", "期限なし"]];
const svgOf = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const MAIL_SVG = svgOf('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>');
const SUB_SVG = svgOf('<path d="M6 4v10a3 3 0 0 0 3 3h9"/><path d="M15 14l3 3-3 3"/>');
const OPEN_SVG = svgOf('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>');
const DAY_SVG = svgOf('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M12 14v3"/>');
const DATE_SVG = svgOf('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>');
const FLAG_SVG = svgOf('<path d="M5 21V4h11l-2 4 2 4H5"/>');
const INBOX_SVG = $("nav-mail").innerHTML.trim();
const PLUS_SVG = $("add-account").innerHTML.trim();
const DELETE_SVG = $("todo-delete").innerHTML.trim();

function tag(name, className = "", text = "") {
  const node = document.createElement(name);
  node.className = className;
  node.textContent = text;
  return node;
}

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
  todoOpen = null;
  todoMode("token");
  $("todo-title").textContent = "Todo";
  $("todo-token-note").textContent = note;
  $("todo-token-input").focus();
}

function projectButton(view, icon, name, count) {
  const b = tag("button", "proj");
  b.setAttribute("aria-current", String(view === todoView));
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
    if (t.bucket === "overdue" || t.bucket === "today") today++;
    if (!t.parent) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
  }
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
    // A subtask row opens the task that holds it.
    todoOpen = t.parent?.id ?? t.id;
    renderTodo();
  };
  const box = checkBox(PRIORITY_COLORS[t.priority], false, "完了にする");
  // The row opens the task on click; the checkbox must not.
  box.onclick = (e) => e.stopPropagation();
  box.onchange = () => {
    li.classList.add("done");
    todoCall("todoist_set_done", { id: t.id, done: true }, box);
  };
  const line = tag("div", "t");
  if (mail) line.insertAdjacentHTML("beforeend", MAIL_SVG);
  line.append(tag("span", "", t.content));
  if (t.parent) line.append(tag("span", "parent", t.parent.content));
  if (t.subTotal) {
    const count = tag("span", "subcount");
    count.innerHTML = SUB_SVG;
    count.append(`${t.subDone}/${t.subTotal}`);
    line.append(count);
  }
  const body = tag("div", "body");
  body.append(line);
  li.append(box, body);
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
  if (mail) actions.append(rowButton("mail-row", "メールを開く", MAIL_SVG, () => openMailFromTodo(mail)));
  actions.append(rowButton("open-row", "Todoist で開く", OPEN_SVG, () => invoke("todoist_open", { id: t.id }).catch(showError)));
  trail.append(tag("span", `due${t.bucket === "overdue" ? " over" : ""}`, t.due ? dueLabel(t.due) : ""), actions);
  li.append(trail);
  return li;
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
    const done = todoReloadDone;
    todoReloadDone = false;
    loadTodo(false, done);
  }, 300);
}

// Runs a change, then reloads whether it worked or not, so the screen shows what Todoist has.
// A null answer (a token is needed) shows up in that reload. Returns the command's answer: null when it failed or a token is needed.
async function todoCall(command, args, control) {
  $("error").hidden = true;
  if (control) control.disabled = true;
  let answer = null;
  try {
    answer = await invoke(command, args);
  } catch (e) {
    showError(e);
  }
  if (control) control.disabled = false;
  // Only completing or reopening a task changes the completed ones.
  scheduleTodoReload(command === "todoist_set_done");
  return answer;
}

const saveTask = (id, fields) => todoCall("todoist_update", { id, ...fields });

// The menu under `anchor`; one at a time, closed by a pick, a click elsewhere, or Escape.
let menuEl = null;

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

function openMenu(anchor, items) {
  closeMenu();
  menuEl = tag("div", "menu");
  menuEl.setAttribute("role", "menu");
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
    menuEl.append(b);
  }
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  menuEl.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menuEl.offsetWidth - 8))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - menuEl.offsetHeight - 8))}px`;
  menuEl.querySelector("button").focus();
}

document.addEventListener("pointerdown", (e) => {
  if (menuEl && !e.target.closest(".menu")) closeMenu();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

function chip(svg, text, className = "") {
  const b = tag("button", `chip ${className}`.trim());
  b.insertAdjacentHTML("beforeend", svg);
  b.append(text);
  return b;
}

// The due chip turns into a text field taking Todoist's natural language ("明日 15時", "毎週月曜"); empty clears the due date.
function dueChip(t) {
  const b = chip(DATE_SVG, t.due ? dueLabel(t.due) : "期限なし", t.bucket === "overdue" ? "over" : "");
  b.onclick = () => {
    const input = tag("input", "chip-input");
    input.value = t.due?.string ?? "";
    input.placeholder = "例: 明日 15時";
    input.setAttribute("aria-label", "期限（空欄で期限なし）");
    b.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      // Back to the chip either way: the field left in place would keep the focus, and the reload after the save would not redraw.
      const dueString = input.value;
      input.replaceWith(b);
      if (save && dueString.trim() !== (t.due?.string ?? "")) saveTask(t.id, { dueString });
    };
    input.onkeydown = (e) => {
      if (composing(e)) return;
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    };
    input.onblur = () => finish(false);
  };
  return b;
}

function projectChip(t) {
  const p = projectOf(t.projectId);
  const b = tag("button", "chip");
  const dot = tag("span", "pdot");
  dot.style.background = p?.color;
  b.append(dot, projectName(p));
  b.onclick = () =>
    openMenu(
      b,
      todo.projects.map((x) => ({
        label: projectName(x),
        color: x.color,
        current: x.id === t.projectId,
        pick: () => x.id !== t.projectId && todoCall("todoist_move", { id: t.id, projectId: x.id }),
      })),
    );
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
    todoCall("todoist_set_done", { id: s.id, done: box.checked }, box);
  };
  // A subtask with subtasks of its own has a row among the tasks, so it opens like one; otherwise nothing could reach its subtasks.
  if (todo.tasks.some((x) => x.id === s.id)) {
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
  const t = todo.tasks.find((x) => x.id === todoOpen);
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
  box.onchange = () => todoCall("todoist_set_done", { id: t.id, done: true }, box);
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

// Whether a text field of the open task holds what the user is typing; a redraw would replace it with Todoist's older value.
// The subtask field counts only while it has text: it is emptied on Enter, and the redraw must show the subtask just added.
function editingDetail() {
  const a = document.activeElement;
  return $("todo-detail").contains(a) && a.matches("textarea, input:not([type=checkbox])") && (a.dataset.field !== "sub" || a.value !== "");
}

// The data of the last quiet load as text, to tell a refresh that changed nothing; null after any other load, since the screen may differ from it then.
let todoText = null;

// Set when a load updated `todo` without drawing it (a field was being typed in), so the next quiet refresh draws it even if nothing else changed.
let todoUndrawn = false;

// Fetches the tasks and draws them. `quiet` is the timed refresh: it fetches nothing while a field is being typed in, and draws nothing when nothing changed.
// Without `withDone` the backend reuses the completed tasks it fetched last. Returns true when a token is needed (the token form is shown).
async function loadTodo(quiet = false, withDone = true) {
  if (quiet && editingDetail()) return false;
  const seq = ++todoSeq;
  try {
    const data = await invoke("todoist_load", { withDone });
    if (seq !== todoSeq || screen !== "todo") return false;
    if (data === null) {
      showTokenForm();
      return true;
    }
    const text = quiet ? JSON.stringify(data) : null;
    const same = text !== null && text === todoText;
    todoText = text;
    todo = data;
    projectById = new Map(data.projects.map((p) => [p.id, p]));
    // A field being typed in keeps what was typed; the detail is drawn after the focus leaves, by the next save's load or the next refresh.
    if (editingDetail()) {
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
  todo.tasks = todo.tasks.filter((t) => t.id !== id);
  renderTodo();
  todoCall("todoist_delete", { id });
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
  // In "今日" the task goes where Quick Add puts it (the inbox, or the project named in the text).
  const projectId = todoView === "today" ? null : viewProjectId(todoView);
  const added = await todoCall("todoist_add", { text, projectId }, input);
  if (added !== null) {
    input.value = "";
    // false: created, but the move into the project failed; it is in the inbox.
    toast(added ? "タスクを追加しました" : "タスクを追加しましたが、プロジェクトへ移せませんでした。受信箱にあります");
  }
  input.focus();
};
// Not while the token form is up: a load would read the keychain and draw the form again, dropping what is typed in it.
setInterval(() => screen === "todo" && $("todo-token").hidden && !document.hidden && loadTodo(true), TODO_REFRESH_MS);

load();
