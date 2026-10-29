const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

// Gmail snippets arrive HTML-escaped (e.g. &#39;).
const unescapeHtml = (s) => new DOMParser().parseFromString(s, "text/html").documentElement.textContent;

function show(view) {
  $("login").hidden = view !== "login";
  $("threads").hidden = view !== "list";
  $("reload").hidden = view !== "list";
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
  li.append(cell("from", t.from), subject, cell("date", new Date(t.dateMs).toLocaleString("ja-JP")));
  return li;
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
