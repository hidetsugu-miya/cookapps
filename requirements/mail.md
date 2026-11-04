# Mail requirements

## M-1 List

Show the threads in the inbox, split into unread and read, each sorted newest first. The list has a header (`#inbox-header`, fixed above the list in the tint of the thread toolbar, shown on the list only: the title "受信トレイ" at the left and M-6's "すべて既読にする" at the right) and no reload button (the toolbar `#mail-header` is shown only in a thread). A load that failed (the call, or an account in its answer) is repeated by the sync round, which runs every 10 seconds and when the window is shown again, once the wait has passed since that load (60 seconds, doubled after each failed repeat up to 5 minutes), until a load succeeds with no failed account, which clears the wait; when a sync answers that an account needs a login while the list is not shown (a thread is open), the list is loaded again at the next sync round; a load never switches the screen; a repeated load clears only the error the inbox showed itself, and shows its failure only while the mail screen is shown; a load that draws the rows again keeps the focus on the same button of the same row

## M-2 Read

Open a thread and show its body

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
