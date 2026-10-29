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

// #main scrolls both the list and the thread, so each view keeps its own position.
let listScroll = 0;

function show(view) {
  if (!$("threads").hidden) listScroll = $("main").scrollTop;
  $("calendar").hidden = view !== "calendar";
  $("mail-header").hidden = view === "calendar";
  $("main").hidden = view === "calendar";
  $("login").hidden = view !== "login";
  $("relogin").hidden = view !== "list" || !$("relogin").hasChildNodes();
  $("threads").hidden = view !== "list";
  $("reload").hidden = view !== "list";
  $("thread").hidden = view !== "thread";
  $("back").hidden = view !== "thread";
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
  button.title = label;
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

async function openThread({ id, account }, li) {
  $("error").hidden = true;
  try {
    const t = await invoke("thread", { account, id });
    // null: that account must log in again, which the list shows.
    if (t === null) return load();
    current = { id, account, li };
    $("thread-subject").textContent = t.subject || "(件名なし)";
    $("messages").replaceChildren(...t.messages.map(message));
    show("thread");
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

// Which screen the sidebar selected: "mail" or "calendar". Background work reads it; only the sidebar changes it.
let screen = "mail";

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
  show("list");
};
// Detail view "trash" / "archive": back to the list at once, the work runs in the background.
function removeCurrent(command) {
  show("list");
  removeRow(command, current.account, current.id, current.li);
}
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
  for (const [id, target] of [["nav-mail", "mail"], ["nav-calendar", "calendar"]]) {
    if (target === name) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  $("error").hidden = true;
  if (name === "calendar") {
    calScrolled = false;
    show("calendar");
    loadCalendar();
  } else {
    show("list");
  }
}

$("nav-mail").onclick = () => setScreen("mail");
$("nav-calendar").onclick = () => setScreen("calendar");
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

load();
