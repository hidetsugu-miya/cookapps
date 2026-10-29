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

// Reflects the read state in the row: bold, dot, checkbox, and the hover "mark read" button (unread rows only).
function setReadState(t, li, read) {
  t.unread = !read;
  li.classList.toggle("unread", !read);
  const box = li.querySelector(".read-box");
  box.checked = read;
  box.setAttribute("aria-label", read ? "未読にする" : "既読にする");
  li.querySelector(".mark-read").hidden = read;
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

async function trashRow(t, li, button) {
  $("error").hidden = true;
  button.disabled = true;
  try {
    const done = await invoke("trash", { account: t.account, id: t.id });
    if (done === null) return load();
    li.remove();
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
}

function row(t) {
  const li = document.createElement("li");
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
    rowButton("mark-read", "既読にする", CHECK_SVG, (b) => sendRead(t, li, true, b)),
    rowButton("trash-row", "ゴミ箱へ移動", $("trash").innerHTML, (b) => trashRow(t, li, b)),
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

// Sidebar avatars of every account, and a re-login row for each account that needs it.
function renderAccounts({ accounts, needsLogin }) {
  $("account-list").replaceChildren(
    ...accounts.map((a) => {
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = initials(a);
      avatar.style.background = avatarColor(a);
      avatar.title = a;
      avatar.setAttribute("role", "img");
      avatar.setAttribute("aria-label", a);
      return avatar;
    }),
  );
  $("relogin").replaceChildren(
    ...needsLogin.map((a) => {
      const div = document.createElement("div");
      const button = document.createElement("button");
      button.textContent = "再ログイン";
      button.onclick = () => addAccount(a, button);
      div.append(`${a} は再ログインが必要です`, button);
      return div;
    }),
  );
}

async function load() {
  $("error").hidden = true;
  try {
    const inbox = await invoke("inbox");
    renderAccounts(inbox);
    if (inbox.accounts.length === 0) return show("login");
    $("threads").replaceChildren(...inbox.threads.map(row));
  } catch (e) {
    showError(e);
  }
  show("list");
}

$("reload").onclick = load;
$("back").onclick = () => {
  $("error").hidden = true;
  show("list");
};
// Runs a thread command ("trash" / "archive"); on success the thread leaves the list.
async function removeCurrent(command) {
  const buttons = [$("trash"), $("archive")];
  $("error").hidden = true;
  buttons.forEach((b) => (b.disabled = true));
  try {
    const done = await invoke(command, { account: current.account, id: current.id });
    if (done === null) return load();
    current.li.remove();
    show("list");
  } catch (e) {
    showError(e);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
$("trash").onclick = () => removeCurrent("trash");
$("archive").onclick = () => removeCurrent("archive");
// Logs in (the account chosen in the browser, or `hint` preselected) and reloads the list.
async function addAccount(hint, button) {
  $("error").hidden = true;
  button.disabled = true;
  try {
    await invoke("login", { loginHint: hint });
    await load();
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
}
$("login-button").onclick = () => addAccount(null, $("login-button"));
$("add-account").onclick = () => addAccount(null, $("add-account"));

load();
