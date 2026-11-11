// The popups for new Slack messages (S-17): a card in the stack of the new-mail popups (arrivals.ts) for each unread message that a read of the Slack list found, with the actions "既読にする" (S-17), "ウォッチ" (S-13) and "スレッドを開く" (S-6).
// The card draws the plain text of the message only (`textContent`), and what each action does is the Slack list's own, handed in by it.
import type { TimelineMessage } from "./bindings/TimelineMessage";
import { action, dismiss, dismissWhere, isShown, stackCard } from "./arrivals.js";
import { el, span, tag } from "./dom.js";
import { BOOKMARK_SVG, CHECK_SVG, CLOSE_SVG } from "./icons.js";
import { decorateAvatar, workspaceColor } from "./slack-view.js";

// What the buttons of a card do; a card is closed by any of them first. `read` is null when pressing the check would change nothing (S-17).
export interface SlackCardActions {
  read: (() => void) | null;
  watch: () => void;
  open: () => void;
}

const PREFIX = "slack:";
// The key of the message's card in the stack, apart from a mail card's "account/id".
export const slackKey = (m: Pick<TimelineMessage, "teamId" | "channel" | "ts">) => `${PREFIX}${m.teamId}/${m.channel}/${m.ts}`;

// The message as the card says it: its plain text on one line, or the files it holds.
const lineOf = (m: TimelineMessage) => m.text.trim() || (m.hasFiles ? "（添付ファイル）" : "");

// Shows the card of a new message, drawn as the list draws a row's sender: the icon with the workspace's color, the name and `#channel`, then the text. A message already announced gets none.
// `born` is the number of the answer that carries it (see `pruneSlackArrivals`). The caller loads the icons of the cards (`loadIcons`) once for all of them.
export function announceSlackArrival(m: TimelineMessage, born: number, actions: SlackCardActions) {
  const key = slackKey(m);
  if (isShown(key)) return;
  const card = el("arrival pop");
  card.setAttribute("role", "status");
  card.dataset.born = String(born);
  const avatar = tag("span", "avatar feed-avatar");
  decorateAvatar(avatar, m.name, m.iconUrl);
  const dot = tag("i", "feed-ws");
  dot.style.background = workspaceColor(m.team);
  dot.title = m.team;
  avatar.append(dot);
  const who = el("arrival-who");
  who.append(tag("b", "", m.name), span("arrival-channel", `#${m.channelName}`));
  const text = el("arrival-text");
  text.append(who, span("arrival-subject", lineOf(m)));
  const close = action(tag("button", "icon-btn"), "閉じる", key, () => {});
  close.innerHTML = CLOSE_SVG;
  const head = el("arrival-head");
  head.append(avatar, text, close);

  const buttons = el("arrival-actions");
  if (actions.read) {
    const read = action(tag("button", "icon-btn"), "既読にする", key, actions.read);
    read.innerHTML = CHECK_SVG;
    buttons.append(read);
  }
  const watch = action(tag("button", "icon-btn"), "ウォッチ", key, actions.watch);
  watch.innerHTML = BOOKMARK_SVG;
  buttons.append(watch, action(tag("button", "text-btn", "スレッドを開く"), "", key, actions.open));
  card.append(head, buttons);
  stackCard(key, card);
}

// Closes the card of a message (the list opened its thread, S-6).
export const dismissSlackArrival = (m: Pick<TimelineMessage, "teamId" | "channel" | "ts">) => dismiss(slackKey(m));

// Closes the cards whose message is not among the unread rows of the list any more (read here or in Slack, kept off the list, watched, or gone), so that a card never stays for a message that needs no attention.
// `unread` gives the keys of the unread rows, and is called only when a Slack card is on screen; `answer` is the number of the answer the list holds. A card born of a later answer (one passed over, whose messages the list does not hold yet) stays until that answer is held.
export function pruneSlackArrivals(unread: () => Set<string>, answer: number) {
  let keys: Set<string> | null = null;
  const isUnread = (key: string) => {
    keys ??= unread();
    return keys.has(key);
  };
  dismissWhere((key, card) => key.startsWith(PREFIX) && Number(card.dataset.born) <= answer && !isUnread(key));
}
