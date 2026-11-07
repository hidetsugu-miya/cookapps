# Mail requirements

## M-1 List

Show the threads in the inbox, split into unread and read, each sorted newest first. The list has a header (`#inbox-header`, fixed above the list in the tint of the thread toolbar, shown on the list only: the title "受信トレイ" at the left and M-6's "すべて既読にする" at the right) and no reload button (the toolbar `#mail-header` is shown only in a thread). A load that failed (the call, or an account in its answer) is repeated by the sync round, which runs every 10 seconds and when the window is shown again, once the wait has passed since that load (60 seconds, doubled after each failed repeat up to 5 minutes), until a load succeeds with no failed account, which clears the wait; when a sync answers that an account needs a login while the list is not shown (a thread is open), the list is loaded again at the next sync round; a load never switches the screen; a repeated load clears only the error the inbox showed itself, and shows its failure only while the mail screen is shown; a load that draws the rows again keeps the focus on the same button of the same row

## M-2 Read

Open a thread and show its body. Pressing a row of the list (or "詳細を開く" of M-9, or a task's mail link) goes to the detail view at once and shows the subject and the sender that the row has (a thread opened from a task with no row shows neither), and in the body's place the note "読み込んでいます…" with gray lines; when the thread arrives they are replaced by the messages. Until it arrives, the buttons of the header other than "戻る" (the AI summary, Slack, Todo, Orca, trash and archive) cannot be pressed, and "戻る" goes back to where the thread was opened from. A press on another row or on "戻る" while it loads leaves the earlier answer ignored: it never draws over the screen then shown. When the call fails, the same error text as before is shown in the body's place (and the buttons stay disabled). When the answer says the account must log in again, the list is shown. The header of the open thread has the icon button "Orca に渡す" (A-9).

## M-3 Delete

Move a thread to the trash

## M-4 Archive

Remove the `INBOX` label from a thread

## M-5 Multiple accounts

Show the inboxes of several Gmail accounts together

## M-6 Mark read

Mark a thread read or unread with the checkbox in the list. The button "すべて既読にする" in the header of the list (disabled while no thread is unread or a run is on its way) makes every unread thread in the list (the ones shown, not unread threads that are not on the screen) read with the existing `set_read`, one request per thread, at most 4 at once: the rows change first, a row whose request fails (or answers that the account must log in again) goes back to unread and the failures are reported once, and a read box stays disabled while its request is on its way so that a sync leaves the row as it is (as for a single toggle). When it ends, the notice "N 件を既読にしました" offers "元に戻す", which makes the threads it changed (those still in the list) unread again the same way

## M-7 Auto sync

Sync the inbox with Gmail about every 10 seconds

## M-8 AI summary

In the mail detail, an icon summarizes the thread with the Claude Code CLI (`claude -p`, the model and effort of A-2 with sonnet and medium as the default, no tools, no MCP, no settings) and shows a short list of points, in Japanese, on a card under the subject. Only pressing the icon sends the subject and, of each message, the sender, the date and the text (newest first, up to 10,000 characters, the oldest dropped first). The summary is kept in memory per thread (and its latest message), never saved, and shown again without sending when the card is closed and reopened. The icon is shown only while Claude can be used (logged in, or an API key that is not refused, A-4)

## M-9 New mail popup

When auto sync (M-7) finds new mail, show a popup for each new thread at the bottom right of the app window, so that the mail can be handled at once. Nothing else shows it: the load at startup, a load or a reload after the history was too old, and a sync that only changes labels (an undo of a trash or an archive, a mark as read) show none, and no OS notification is used. A thread is new when the sync finds a message added to the inbox with the UNREAD label and the thread is still unread and in the inbox when it is fetched (Rust decides it and `sync` answers the IDs in `arrived`).

The popup shows the sender and the subject, and the actions "ゴミ箱へ移動" (M-3) and "アーカイブ" (M-4) as icon buttons, "詳細を開く" (M-2) as a text button, and a close button. Trash and archive call the same commands as the list row (`removeRow`), so the row leaves the list at once, the notice with "元に戻す" shows, and a failure brings the row back and shows the error. "詳細を開く" goes to the mail screen and opens the thread, even from another screen. The sync alone never changes the screen (`frontend.md`): the popup only appears over the current one. Each action closes the popup.

Details the owner left open:

- Several new threads at once: one card each, stacked, the newest at the bottom. At most 3 cards show; a fourth makes the oldest go (its thread stays in the list, unread).
- A card goes by itself after 10 seconds. The pointer or the focus on it holds it, and the 10 seconds start again when they leave. The close button closes it at once.
- A thread whose card is on screen gets no second card, and neither does the thread that is open on screen (or that the detail view is still loading). A card goes when its thread is opened, from the list or with "詳細を開く", so that no button of it acts on a thread the detail view holds.
- The cards stack above the toast, which is above the update popup.
