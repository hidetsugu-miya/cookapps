// Which part of the window is shown, and the counts on the sidebar buttons (and their sum on the Dock).
import { $ } from "./dom.js";
import { setFooterCount } from "./footer.js";
import { showFailure } from "./error-card.js";
import { invoke } from "./ipc.js";
import { syncSlackClaude } from "./slack-claude.js";
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

// "slack" is the compose screen of a mail; "slack-list", "slack-channel" and "slack-thread" are the Slack screen's list, the history of a channel and the detail of a message.
export type View = "list" | "thread" | "login" | "calendar" | "todo" | "settings" | "prompt" | "slack" | "slack-list" | "slack-channel" | "slack-thread" | "orca" | "database" | "new-mail";

// #main scrolls both the list and the thread, so each view keeps its own position.
let listScroll = 0;

export function show(view: View) {
  if (!$("threads").hidden) listScroll = $("main").scrollTop;
  // The calendar, Todo, settings, prompt, Slack, Orca (with its orchestration) and database screens bring their own header.
  const own = ["calendar", "todo", "settings", "prompt", "slack", "slack-list", "slack-channel", "slack-thread", "orca", "database"].includes(view);
  $("calendar").hidden = view !== "calendar";
  $("todo").hidden = view !== "todo";
  $("settings").hidden = view !== "settings";
  $("prompt").hidden = view !== "prompt";
  $("slack-compose").hidden = view !== "slack";
  $("slack-screen").hidden = view !== "slack-list" && view !== "slack-channel" && view !== "slack-thread";
  $("slack-list").hidden = view !== "slack-list";
  $("slack-channel").hidden = view !== "slack-channel";
  $("slack-thread").hidden = view !== "slack-thread";
  // The thread has a Claude pane of its own (S-7); the other three share the one of S-24.
  $("slack-claude").hidden = view === "slack-thread";
  $("slack-claude-split").hidden = view === "slack-thread";
  // The terminal of the pane of S-24 is shown while the pane is in view, and hidden (its process goes on) when a thread, another view or another screen is.
  syncSlackClaude();
  $("orca").hidden = view !== "orca";
  $("database").hidden = view !== "database";
  // The mail header is the thread's bar with "戻る": the list and the login screen have none.
  $("mail-header").hidden = view !== "thread";
  // The inbox has its own header (the unread operation); the login screen has none.
  $("inbox-header").hidden = view !== "list";
  // The screen that writes a new mail (M-11) has a header of its own, and takes the place of the thread in #main.
  $("new-mail-header").hidden = view !== "new-mail";
  $("new-mail").hidden = view !== "new-mail";
  $("main").hidden = own;
  $("mail-area").hidden = own;
  $("login").hidden = view !== "login";
  $("relogin").hidden = view !== "list" || !$("relogin").hasChildNodes();
  $("inbox-state").hidden = view !== "list";
  $("threads").hidden = view !== "list";
  $("thread").hidden = view !== "thread";
  syncSummaryButton();
  $("back").hidden = view !== "thread";
  $("thread-slack").hidden = view !== "thread";
  $("thread-todo").hidden = view !== "thread";
  $("thread-orca").hidden = view !== "thread";
  $("trash").hidden = view !== "thread";
  $("archive").hidden = view !== "thread";
  $("main").scrollTop = view === "list" ? listScroll : 0;
}

// Writes `text` to the clipboard and says `done`; false (with the failure shown as a card) when it is refused.
// Call it straight from the click: nothing may be awaited before writeText, or WKWebView refuses it.
export async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    showFailure("clipboard", e);
    return false;
  }
  toast(done);
  return true;
}

// The counts of the sidebar buttons (inbox, Todo, Slack, Orca) by id (the footer's bell shows the sum of the inbox's and Slack's, A-35), the due moments (epoch milliseconds) of the open tasks still ahead, and what was last sent to the Dock badge.
const navCounts: Record<string, number> = {};
let upcoming: number[] = [];
let sentToDock = "0:";

// The count on a sidebar button (99+ from 100, or `cap`+ above `cap`; none for 0). The label carries it too: the tooltip shows the label, e.g. "受信トレイ（未読 3 件）".
// The Dock badge shows the sum of the buttons' counts (the numbers themselves, not what a button shows above its cap), and Rust adds the `upcoming` moments as the clock passes them (they are the Todo button's; the mail button leaves them as they are).
// The call is skipped when neither the sum nor the moments changed.
export function setNavCount(id: string, count: number, name: string, kind: string, ahead?: number[], cap = 99) {
  navCounts[id] = count;
  if (ahead) upcoming = ahead.sort((a, b) => a - b);
  const sum = Object.values(navCounts).reduce((a, b) => a + b, 0);
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
  if (id === "nav-mail" || id === "nav-slack") setFooterCount((navCounts["nav-mail"] ?? 0) + (navCounts["nav-slack"] ?? 0));
}
