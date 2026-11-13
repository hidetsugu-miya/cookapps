// The Claude pane of the Slack screen (S-24): a conversation (claude-chat.ts) on the right of the unread list, the watch and a channel's history, in which Claude answers a request about the channel shown.
// The pane's elements are in `index.html` (`slack-claude-*`) except the request field, which composer.ts makes. The pane is always open while one of the three is shown; the thread has its own (S-7), and view.ts hides this one there.
// The conversation is held in memory only, one for the whole screen. Each request sends the channel the history shows at that moment (null in the list and the watch); Claude posts nothing: the draft of its answer is a card under the reply, whose button puts it into the post field of the channel shown (S-21).
import { createChat } from "./claude-chat.js";
import { showModelSlot } from "./claude.js";
import { createComposer } from "./composer.js";
import { $, tag } from "./dom.js";
import { invoke } from "./ipc.js";
import { putSlackDraft, slackChannelForClaude } from "./slack-channel.js";
import { initSplit } from "./split.js";

// The card of a draft: its text as text, and "投稿欄に入れる", which the CSS shows only while a channel's history is shown (the list and the watch have no post field).
function draftCard(draft: string) {
  const card = tag("div", "chat-draft");
  const put = tag("button", "text-btn primary chat-draft-put", "投稿欄に入れる");
  put.type = "button";
  put.onclick = () => putSlackDraft(draft);
  card.append(tag("div", "chat-draft-text", draft), put);
  return card;
}

// There is no text to edit: the conversation is on whenever Claude can be used.
const chat = createChat({
  prefix: "slack-claude",
  loginNote: "設定の Claude タブで接続すると、Claude に相談できます",
  text: () => "",
  apply: () => {},
  ask: async (_text, history, instruction) => {
    const answer = await invoke("claude_chat_slack", { channel: slackChannelForClaude(), history, instruction });
    return { reply: answer.reply, body: null, diff: [], draft: answer.draft };
  },
  draft: draftCard,
  changed: () => chat.refresh(),
  keyHint: false,
});

// Draws what follows from the state again (Claude was connected or disconnected).
export const refreshSlackClaude = () => chat.refresh();

// The Slack screen is shown: the pane's selects need the settings.
export const showSlackClaudeModels = () => showModelSlot("slack-claude-model");

export function initSlackClaude() {
  $("slack-claude-chat-note").after(createComposer({ prefix: "slack-claude", label: "Claude への依頼" }));
  chat.init();
  chat.draw();
  // 30% of the screen at first, between 25% and 40% (the CSS holds the same range).
  initSplit($("slack-screen"), $("slack-claude-split"), { min: 0.25, max: 0.4, initial: 0.3, property: "--slack-claude-w" });
}
