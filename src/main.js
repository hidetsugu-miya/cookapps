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

// #main scrolls both the list and the thread, so each view keeps its own position.
let listScroll = 0;

function show(view) {
  if (!$("threads").hidden) listScroll = $("main").scrollTop;
  $("login").hidden = view !== "login";
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

function row(t) {
  const li = document.createElement("li");
  li.className = t.unread ? "unread" : "";
  const cell = (cls, text) => {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    return span;
  };
  const subject = cell("subject", t.subject || "(件名なし)");
  subject.append(cell("snippet", ` — ${unescapeHtml(t.snippet)}`));
  li.onclick = () => openThread(t.id, li);
  const name = senderName(t.from);
  const avatar = cell("avatar", initials(name));
  avatar.style.background = avatarColor(name);
  li.append(avatar, cell("from", name), subject, cell("date", formatDate(t.dateMs)));
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

async function openThread(id, li) {
  $("error").hidden = true;
  try {
    const t = await invoke("thread", { id });
    if (t === null) return show("login");
    current = { id, li };
    $("thread-subject").textContent = t.subject || "(件名なし)";
    $("messages").replaceChildren(...t.messages.map(message));
    show("thread");
  } catch (e) {
    showError(e);
  }
}

async function load() {
  $("error").hidden = true;
  try {
    const threads = await invoke("inbox");
    if (threads === null) return show("login");
    $("threads").replaceChildren(...threads.map(row));
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
    const done = await invoke(command, { id: current.id });
    if (done === null) return show("login");
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
$("login-button").onclick = async () => {
  $("error").hidden = true;
  $("login-button").disabled = true;
  try {
    await invoke("login");
    await load();
  } catch (e) {
    showError(e);
  } finally {
    $("login-button").disabled = false;
  }
};

load();
