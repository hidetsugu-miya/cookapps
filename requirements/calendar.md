# Calendar requirements

## C-1 View

Show the events of Google Calendar (read-only)

## C-2 Event detail

Press an event of the week (timed or all-day) and a popover beside it shows the color dot, the title, the time, a "Meet に参加" button with the URL and a copy button (only for a `https://meet.google.com/` link, from `hangoutLink`), the place, the description (HTML turned into text, links kept), the number of invited people (rooms left out) with how many accepted, the calendar and account, and the user's own answer. Nothing is fetched on a press: the detail comes with the week and is kept with it in `calendar-cache.json` (no name or address of an attendee is fetched). Another event switches it, the same one, ✕, Escape, a click elsewhere, a scroll, a resize, a week change or a screen change closes it, and a background redraw of the week keeps it open on the same event

## C-3 First day of the week

The settings screen has a "カレンダー" tab where the first day of the week is chosen from Sunday to Saturday (the default is Sunday). It is saved in `calendar-settings.json` in the app config directory and the calendar draws its weeks from that day
