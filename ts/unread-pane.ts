// The pane of the unread (A-35): the count in the footer opens it from the right, over the screen and down to the footer, and it lists the unread threads of the inbox and the unread messages of the Slack list, mixed, the newest first.
// A row says which of the two it is by its icon, then the sender's avatar and name, the channel (Slack), the time and one line (the subject, or the text). Its text button does what pressing the row of the inbox or of the Slack list does.
// While the pointer is on a row or the focus is in it, its icon buttons show: a mail's trash and archive (M-3, M-4: the list's `removeRow`), a Slack message's "既読にする" (only where it changes something) and "ウォッチ" (S-13). The row goes from the pane and the count of the footer falls.
// It draws what the inbox and the Slack list hold, with no call of its own, and it is drawn again where either changes (the inbox's unread rows, `drawUnreadPane` of slack-list.ts and the count of the footer). Everything is drawn as text.
import type { ThreadItem } from "./bindings/ThreadItem";
import type { TimelineMessage } from "./bindings/TimelineMessage";
import { $, el, span, tag } from "./dom.js";
import { watchFooterCount } from "./footer.js";
import { avatarColor, formatDate, initials } from "./format.js";
import { BOOKMARK_SVG, CHECK_SVG, MAIL_SVG, SLACK_SVG, TRASH_SVG } from "./icons.js";
import { removeRow } from "./inbox.js";
import { pending, rowKey, rows } from "./inbox-rows.js";
import { setScreen } from "./nav.js";
import { openUnreadMessage, readableMessage, readUnreadMessage, unreadMessages, watchUnreadMessage } from "./slack-list.js";
import { decorateAvatar, loadIcons, slackMs, workspaceColor } from "./slack-view.js";
import { openThread } from "./thread.js";

// The count in the heading: the footer's, which counts every unread message held and not only the rows the pane can list.
let count = 0;
// What the pane drew last, so that a redraw with nothing changed leaves the rows (and a hover or a focus on them) alone.
let drawnKey = "";

const isOpen = () => !$("unread-pane").hidden;

function close() {
  $("unread-pane").hidden = true;
  $("footer-bell").setAttribute("aria-expanded", "false");
}

function toggle() {
  if (isOpen()) return close();
  $("unread-pane").hidden = false;
  $("footer-bell").setAttribute("aria-expanded", "true");
  drawnKey = "";
  drawUnreadPane();
}

// One unread item as the pane draws it, in the order of `ms`.
type Item = { ms: number; key: string; node: () => HTMLLIElement };

// An icon button of a row: its press does `run` and does not reach the row, which would open the thread. The second click of a double click, which lands on the row that moved under the pointer, does nothing.
const DOUBLE_CLICK_MS = 500;
let lastActionAt = 0;
function iconButton(label: string, svg: string, run: () => void) {
  const button = tag("button", "icon-btn");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.innerHTML = svg;
  button.onclick = (e) => {
    e.stopPropagation();
    if (e.detail > 1 && Date.now() - lastActionAt < DOUBLE_CLICK_MS) return;
    lastActionAt = Date.now();
    run();
  };
  return button;
}

function line(avatar: HTMLElement, who: HTMLElement, text: string, icon: string, label: string, open: () => void, actions: HTMLButtonElement[]) {
  const li = tag("li", "unread-item");
  const kind = span("unread-kind", "");
  kind.innerHTML = icon;
  const body = el("unread-body");
  body.append(who, span("unread-line", text));
  const button = tag("button", "text-btn", label);
  button.type = "button";
  // The text button comes first in the document, so that the focus reaches the row before its icon buttons, which show only while the row has the pointer or the focus.
  const buttons = el("unread-actions");
  buttons.append(button, ...actions);
  li.append(kind, avatar, body, buttons);
  // The text button's press reaches the row, so the row alone opens it, once.
  li.onclick = () => {
    close();
    open();
  };
  return li;
}

function mailItem(t: ThreadItem): Item {
  const name = t.fromName || t.fromAddress;
  const subject = t.subject || "(件名なし)";
  const ms = t.dateMs;
  return {
    ms,
    key: JSON.stringify(["mail", rowKey(t), name, subject, ms]),
    node: () => {
      const avatar = span("avatar", initials(name));
      avatar.style.background = avatarColor(name);
      const who = el("unread-who");
      who.append(tag("b", "", name), span("unread-time", formatDate(ms)));
      // The row the list holds now, which a sync may have made again since the pane was drawn: the list's own removal takes it out, with the notice and the way back on a failure.
      const remove = (command: "trash" | "archive") => () => {
        const now = rows.get(rowKey(t));
        if (now) removeRow(command, t.account, t.id, now.li);
      };
      const li = line(
        avatar,
        who,
        subject,
        MAIL_SVG,
        "詳細を開く",
        () => {
          const now = rows.get(rowKey(t));
          setScreen("mail");
          openThread(now?.t ?? t, now?.li ?? null);
        },
        [iconButton("ゴミ箱へ移動", TRASH_SVG, remove("trash")), iconButton("アーカイブ", CHECK_SVG, remove("archive"))],
      );
      li.dataset.kind = "mail";
      return li;
    },
  };
}

// The message as a row says it: its plain text on one line, or the files it holds.
const lineOf = (m: TimelineMessage) => m.text.trim() || (m.hasFiles ? "（添付ファイル）" : "");

function slackItem(m: TimelineMessage): Item {
  const ms = slackMs(m.ts);
  const text = lineOf(m);
  // Pressing the check changes nothing for a message whose channel the token cannot write the position of (S-15): the row has no check then.
  const readable = readableMessage(m);
  return {
    ms,
    key: JSON.stringify(["slack", m.teamId, m.channel, m.ts, m.name, m.channelName, m.iconUrl, text, m.team, readable]),
    node: () => {
      const avatar = tag("span", "avatar feed-avatar");
      decorateAvatar(avatar, m.name, m.iconUrl);
      const dot = tag("i", "feed-ws");
      dot.style.background = workspaceColor(m.team);
      dot.title = m.team;
      avatar.append(dot);
      const who = el("unread-who");
      who.append(tag("b", "", m.name), span("unread-channel", `#${m.channelName}`), span("unread-time", formatDate(ms)));
      const actions = [iconButton("ウォッチ", BOOKMARK_SVG, () => watchUnreadMessage(m))];
      if (readable) actions.unshift(iconButton("既読にする", CHECK_SVG, () => readUnreadMessage(m)));
      const li = line(avatar, who, text, SLACK_SVG, "スレッドを開く", () => openUnreadMessage(m), actions);
      li.dataset.kind = "slack";
      return li;
    },
  };
}

// Draws the heading and, while the pane is open, the rows: the unread threads the inbox holds (those being archived or trashed left out) and the unread messages the Slack list holds, the newest first.
export function drawUnreadPane() {
  if (!isOpen()) return;
  $("unread-pane-title").textContent = `未読 ${count}`;
  const messages = unreadMessages();
  const items = [
    ...[...rows].filter(([key, r]) => r.t.unread && !pending.has(key)).map(([, r]) => mailItem(r.t)),
    ...messages.map(slackItem),
  ].sort((a, b) => b.ms - a.ms);
  const key = JSON.stringify(items.map((i) => i.key));
  if (key === drawnKey) return;
  drawnKey = key;
  $("unread-pane-list").replaceChildren(...items.map((i) => i.node()));
  // The icons not fetched yet come later and are painted onto the avatars in the page.
  loadIcons(messages.map((m) => m.iconUrl));
}

export function initUnreadPane() {
  watchFooterCount((n) => {
    count = n;
    drawUnreadPane();
  });
  $("footer-bell").onclick = toggle;
  $("unread-pane-close").onclick = close;
  // A press outside the pane (the bell excepted, which toggles it, and the notice of a trash or an archive from a row, whose 元に戻す is pressed with the pane open) closes it.
  document.addEventListener("mousedown", (e) => {
    const target = e.target as Element;
    if (isOpen() && !$("unread-pane").contains(target) && !$("footer-bell").contains(target) && !target.closest(".toast")) close();
  });
  // The inbox's unread rows change with every load, sync, removal and read toggle.
  new MutationObserver(drawUnreadPane).observe($("unread-threads"), { childList: true });
}
