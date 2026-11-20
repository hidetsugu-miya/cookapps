---
name: preview
description: Opens an HTML file of the worktree as a preview tab in the owner's app. Use it after you write or change an HTML file (a report, a page, a mock-up) that the owner should look at, and when the owner asks you to show or preview one.
---

# preview

## Purpose

Show the owner an HTML file you wrote, in the preview tab of the development screen of the app, so that the owner does not have to look for the file.

## Steps

1. Finish writing the HTML file inside the folder you work in (the worktree).
2. Call the tool `preview_open` of the MCP server `tsunagiai` with two arguments.
   - `worktree`: the absolute path of the folder you work in, as it is on this PC.
   - `file`: the path of the file from the worktree, with `/` between its parts (for example `docs/report.html`).
3. The answer only says that the app took the request. Do not wait for anything else, and do not call the tool again for the same file unless you changed it and the owner asks to see it again.

## Rules

- Only an `.html` file (whatever the case) inside the worktree opens, and no part of its path may start with a dot.
- The worktree must be one that Orca lists for the project. Any other is refused by the app.
- The tab opens in the owner's app, also when you run on another PC.
- When the tool fails, say what its answer says (the app is not running, is not connected to this PC, or refuses the request) and go on. Do not open the file by another means.
