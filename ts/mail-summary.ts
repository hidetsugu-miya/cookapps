// The AI summary of the open thread: the card under the subject, and what each thread's card holds.
// The states live in memory only: a summary is never saved, and it is gone when the app quits.
// The text is drawn with textContent only: it comes from an untrusted mail, so it never becomes HTML or a link.
import { $, tag } from "./dom.js";
import { CLOSE_SVG, SUMMARY_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { mailText } from "./mail-text.js";
import type { OpenThread } from "./thread.js";

type State = { phase: "loading" } | { phase: "done"; points: string[]; open: boolean } | { phase: "failed"; error: string };

// By account, thread and latest message: a thread that got a new message starts with no summary.
const states = new Map<string, State>();
const keyOf = (t: OpenThread) => `${t.account}/${t.id}/${t.messages.at(-1)!.id}`;

// The thread whose card is on the screen. A result for another thread is kept in `states` and drawn when that thread is opened again.
let shown: string | null = null;

function head(title: string, t: OpenThread) {
  const icon = tag("span");
  icon.innerHTML = SUMMARY_SVG;
  const close = tag("button", "icon-btn");
  close.setAttribute("aria-label", "閉じる");
  close.innerHTML = CLOSE_SVG;
  close.onclick = () => closeCard(t);
  const row = tag("div", "summary-head");
  row.append(icon, tag("span", "", title), close);
  return row;
}

// Draws the card of `t`, the thread now open: nothing for a thread with no summary or a closed one.
export function renderSummary(t: OpenThread) {
  shown = keyOf(t);
  const state = states.get(shown);
  const card = $("mail-summary");
  card.hidden = !state || (state.phase === "done" && !state.open);
  if (!state || card.hidden) return;
  card.dataset.phase = state.phase;
  switch (state.phase) {
    case "loading":
      card.replaceChildren(tag("span", "spin"), tag("span", "", "Claude が要約しています…"));
      break;
    case "done": {
      const list = tag("ul");
      list.append(...state.points.map((p) => tag("li", "", p)));
      card.replaceChildren(head("AI 要約", t), list);
      break;
    }
    case "failed": {
      const retry = tag("button", "text-btn", "やり直す");
      retry.onclick = () => start(t);
      card.replaceChildren(head("要約できませんでした", t), tag("div", "", state.error), retry);
    }
  }
}

// "×": a summary is folded away and kept (the icon shows it again); a failure is forgotten.
function closeCard(t: OpenThread) {
  const key = keyOf(t);
  const state = states.get(key);
  if (state?.phase === "done") state.open = false;
  else states.delete(key);
  renderSummary(t);
}

// Only the first press of a thread sends its text to Claude; a kept summary is shown and hidden without sending anything,
// and a press while it is being made does nothing.
async function start(t: OpenThread) {
  const key = keyOf(t);
  states.set(key, { phase: "loading" });
  renderSummary(t);
  try {
    const messages = t.messages.map((m) => ({ from: m.from, dateMs: m.dateMs, text: mailText(m) }));
    const { points } = await invoke("claude_summarize_mail", { subject: t.subject, messages });
    states.set(key, { phase: "done", points, open: true });
  } catch (e) {
    states.set(key, { phase: "failed", error: String(e) });
  }
  if (shown === key) renderSummary(t);
}

export function summaryPressed(t: OpenThread) {
  const state = states.get(keyOf(t));
  if (state?.phase === "loading") return;
  if (state?.phase === "done") {
    state.open = !state.open;
    renderSummary(t);
  } else {
    start(t);
  }
}
