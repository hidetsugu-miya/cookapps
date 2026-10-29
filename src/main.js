const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

// Gmail snippets arrive HTML-escaped (e.g. &#39;).
const unescapeHtml = (s) => new DOMParser().parseFromString(s, "text/html").documentElement.textContent;

function show(view) {
  $("login").hidden = view !== "login";
  $("threads").hidden = view !== "list";
  $("reload").hidden = view !== "list";
  $("thread").hidden = view !== "thread";
  $("back").hidden = view !== "thread";
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
  li.append(cell("from", t.from), subject, cell("date", new Date(t.dateMs).toLocaleString("ja-JP")));
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
