// Which part of the window is shown, the error line, and the counts on the sidebar buttons (and their sum on the Dock).
import { $ } from "./dom.js";
import { invoke } from "./ipc.js";
import { toast } from "./toast.js";

// Whether `claude` can be used: the AI summary button is shown only then, in a thread.
let claudeReady = false;
const syncSummaryButton = () => {
  $("thread-summary").hidden = $("thread").hidden || !claudeReady;
};
export function setClaudeReady(ready: boolean) {
  claudeReady = ready;
  syncSummaryButton();
}

// "slack" is the compose screen of a mail; "slack-list" and "slack-thread" are the Slack screen's list and the detail of a message.
export type View = "list" | "thread" | "login" | "calendar" | "todo" | "settings" | "prompt" | "slack" | "slack-list" | "slack-thread";

// #main scrolls both the list and the thread, so each view keeps its own position.
let listScroll = 0;

export function show(view: View) {
  if (!$("threads").hidden) listScroll = $("main").scrollTop;
  // The calendar, Todo, settings, prompt and Slack screens bring their own header.
  const own = ["calendar", "todo", "settings", "prompt", "slack", "slack-list", "slack-thread"].includes(view);
  $("calendar").hidden = view !== "calendar";
  $("todo").hidden = view !== "todo";
  $("settings").hidden = view !== "settings";
  $("prompt").hidden = view !== "prompt";
  $("slack-compose").hidden = view !== "slack";
  $("slack-list").hidden = view !== "slack-list";
  $("slack-thread").hidden = view !== "slack-thread";
  // The mail header is the thread's toolbar: the list and the login screen have none.
  $("mail-header").hidden = view !== "thread";
  $("main").hidden = own;
  $("login").hidden = view !== "login";
  $("relogin").hidden = view !== "list" || !$("relogin").hasChildNodes();
  $("threads").hidden = view !== "list";
  $("thread").hidden = view !== "thread";
  syncSummaryButton();
  $("back").hidden = view !== "thread";
  $("thread-slack").hidden = view !== "thread";
  $("thread-todo").hidden = view !== "thread";
  $("trash").hidden = view !== "thread";
  $("archive").hidden = view !== "thread";
  $("main").scrollTop = view === "list" ? listScroll : 0;
}

export function showError(e: unknown) {
  $("error").textContent = String(e);
  $("error").hidden = false;
}

// Writes `text` to the clipboard and says `done`; false (with the error shown) when it is refused.
// Call it straight from the click: nothing may be awaited before writeText, or WKWebView refuses it.
export async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    showError(e);
    return false;
  }
  toast(done);
  return true;
}

// The counts of the inbox and Todo buttons, the due moments (epoch milliseconds) of the open tasks still ahead, and what was last sent to the Dock badge.
const navCounts: Record<string, number> = { "nav-mail": 0, "nav-todo": 0 };
let upcoming: number[] = [];
let sentToDock = "0:";

// The count on a sidebar button (99+ from 100, or `cap`+ above `cap`; none for 0). The label carries it too: the tooltip shows the label, e.g. "受信トレイ（未読 3 件）".
// The Dock badge shows the sum of the two buttons' counts, and Rust adds the `upcoming` moments as the clock passes them (they are the Todo button's; the mail button leaves them as they are).
// The call is skipped when neither the sum nor the moments changed.
export function setNavCount(id: string, count: number, name: string, kind: string, ahead?: number[], cap = 99) {
  navCounts[id] = count;
  if (ahead) upcoming = ahead.sort((a, b) => a - b);
  const sum = navCounts["nav-mail"] + navCounts["nav-todo"];
  const sent = `${sum}:${upcoming.join(",")}`;
  if (sent !== sentToDock) {
    sentToDock = sent;
    invoke("set_badge", { count: sum, upcoming }).catch(() => {});
  }
  const b = $(id);
  const badge = b.querySelector<HTMLElement>(".nav-count")!;
  badge.hidden = count === 0;
  badge.textContent = count > cap ? `${cap}+` : String(count);
  b.setAttribute("aria-label", count === 0 ? name : `${name}（${kind} ${count} 件）`);
}
