# Calendar requirements

## C-1 View

Show the events of Google Calendar (read-only)

## C-2 Event detail

Press an event of the week (timed or all-day) and a popover beside it shows the color dot, the title, the time, a "Meet に参加" button with the URL and a copy button (only for a `https://meet.google.com/` link, from `hangoutLink`), the place, the description (HTML turned into text, links kept), the number of invited people (rooms left out) with how many accepted, the calendar and account, and the user's own answer. Nothing is fetched on a press: the detail comes with the week and is kept with it in `calendar-cache.json` (no name or address of an attendee is fetched). Another event switches it, the same one, ✕, Escape, a click elsewhere, a scroll, a resize, a week change or a screen change closes it, and a background redraw of the week keeps it open on the same event

## C-3 First day of the week

The settings screen has a "カレンダー" tab where the first day of the week is chosen from Sunday to Saturday (the default is Sunday). It is saved in `calendar-settings.json` in the app config directory and the calendar draws its weeks from that day

## C-4 Calendars to show

The calendar screen has a panel, 248px wide, left of the week, headed "カレンダー". It groups the calendars by account, with the address as the heading of each group, and under it lists them in two parts, "マイカレンダー" (the calendars the account owns) and "他のカレンダー" (the others: a person's calendar added to the list, holidays, rooms), each as a checkbox and the calendar's name. The checkbox takes the calendar's color (the account's color when the calendar has none), and a part with no calendar is not drawn. Checking or unchecking a calendar saves the choice in `calendar-selection.json` in the app config directory, writes nothing to Google (the scope stays `calendar.readonly`), and draws the week again from the new choice at once; a choice that cannot be saved puts the checkbox back and shows the error. A calendar never chosen follows `selected` at Google. The panel is read when the calendar is opened and again when the week is refreshed or the accounts change. A button beside the heading closes the panel and the week takes its width; while it is closed the same button is first in the bar above the week, and pressing it opens the panel again. The panel is open when the app starts, and whether it is closed is held in memory only
