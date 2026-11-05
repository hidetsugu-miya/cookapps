---
paths:
  - "src/**/*"
  - "ts/**/*"
---

# Frontend rules

## Dependencies

### Compile TypeScript with tsc only, and add no framework, bundler or npm runtime dependency

`tsc` (`npm run build:ts`) writes the TS in `ts/` to `src/js/` (gitignored), and `index.html` loads `js/main.js` as a module.
This keeps the build to one tsc step, and the only code loaded at runtime is our own code and `src/vendor/`.
Never edit `src/js/`. Edit `ts/`; `watch:ts` in `tauri dev` rewrites it.

```ts
// Good
import { $ } from "./dom.js";
const { invoke } = window.__TAURI__.core;
// Bad
import { createApp } from "example-framework";
```

### Give each module in `ts/` one responsibility, and pass state across modules through exported functions

Use one `{screen}.ts` per screen (`inbox.ts` for the list, `todo.ts` and `todo-*.ts` for Todo), and shared parts such as `dom.ts`, `format.ts` and `view.ts`.
`main.ts` only starts the app by calling each module's `init*`.
A module cannot rewrite another module's `let`, so the owner of a state and the place that changes it stay one.

```ts
// Good: state.ts owns the state and exposes a setter
export function setCount(n: number) { count = n; }
// Bad: another module reaches in
import { count } from "./state.js"; count = 3;
```

### Use the generated files in `ts/bindings/` for types shared with Rust, and never edit them by hand

Write the arguments and return values of commands in `Commands` in `ts/ipc.ts`, and import data types from `bindings/`, which ts-rs writes during `cargo test`.
The Rust struct decides the shape. A hand edit is overwritten by the next `cargo test`, and the bindings diff in `pre-git.sh` fails.

```ts
import type { Inbox } from "./bindings/Inbox";
// Bad: copying the struct's fields into a hand-written type
```

### Put a library's distribution file in `src/vendor/` as it is

Place a single-file distribution without changes, and load it with `index.html` as a classic script before `js/main.js`.
It is in neither a module nor npm, so TS uses it through a declaration in `globals.d.ts`.
Keep the version and license notice in the comment at the top of the distribution file.
This lets us use a library the owner chose to adopt without having a bundler (2026-10-31: marked and DOMPurify were adopted to render descriptions as Markdown).

```html
<!-- Good -->
<script src="vendor/marked.umd.js"></script>
<!-- Bad: loading from a CDN (violates the CSP and "load no external resources") -->
<script src="https://unpkg.com/marked"></script>
```

### Load no external resources

An avatar takes its color and initial from the sender's name.
Loading an external image or font adds destinations that conflict with the privacy policy.
The exceptions are the images of a mail or a Slack thread message whose "show images" button was pressed (S-11), and the Slack screen's user icons (`slack-edge.com` and `secure.gravatar.com`, at the owner's instruction, 2026-11-04) and attached images (`files.slack.com`). Rust fetches them as data: URIs, and the CSP is not loosened.
An avatar with no fetched icon falls back to the color and the initial.

```js
// Good
avatar.style.background = colorOf(name);
// Bad
img.src = `https://example.com/avatar/${address}`;
```

## CSS

### Hide an element that must not take clicks with `visibility: hidden`

An element with `opacity` below 1 creates a stacking context, and while transparent it still steals the click from a button above it.

```css
/* Good */
.row:hover .date { visibility: hidden; }
/* Bad: the transparent date still takes the click */
.row:hover .date { opacity: 0; }
```

### Make `[hidden]` `!important` globally

A rule such as `display: flex` beats the `hidden` attribute, and an element that should be hidden shows up.

```css
[hidden] { display: none !important; }
```

## Switching screens

### Do not call `show()` from a background update

If auto sync or a background task switches the view, the user is thrown from the thread they are reading back to the list.
Swap the row in place, and keep the scroll position and the focus.

```js
// Good
list.replaceChild(newRow, oldRow);
// Bad
await reload(); show("list");
```

## Checking

### Check a UI change with E2E, and make no throwaway mock

You cannot tell stacking order or event propagation by reading code.
For a screen change, add or fix that screen's spec (`e2e/specs/`), and have a real WebView operate it with `.claude/tools/run-e2e.sh` (`e2e.md`).
An HTML file opened in Chrome or a scratchpad mock behaves differently from the real WebView, and each one scatters another place that holds mocks, so make none.

```text
Good: when you add a button, add an it in e2e/specs that presses it and checks the command that is called
Bad:  make an HTML file that replaces window.__TAURI__ and open it in Chrome
```

### Check behavior inside the mail body iframe in WKWebView

For a document in an iframe without allow-scripts, WebKit does not call even the event listeners the parent attached. Chrome does call them, so it looks fine in Chrome.
For v0.10.6 and v0.10.7, the link click in the body was checked only in Chrome, and it had never worked on a real machine.
Use the Swift check programs in `.claude/tools/` to make real clicks and navigations happen in WKWebView.

```sh
swiftc -O .claude/tools/wk-click.swift -o /tmp/wk-click && /tmp/wk-click "allow-same-origin allow-top-navigation-by-user-activation"
swiftc -O .claude/tools/wk-nav.swift -o /tmp/wk-nav && /tmp/wk-nav "<iframe src='https://example.com/'></iframe>"
```

```text
Good: check the behavior of a link inside the frame with wk-click
Bad:  check a click listener inside the frame only in Chrome
```

## Appearance

### Set colors with the variables in `:root` of `src/style.css`

Do not write accent or background colors directly. When you need a new color, add a variable first, then use it.
This keeps a color-scheme change to one place, the variables (v0.13.6 unified the scheme to mint green).

```css
/* Good */
.badge { background: var(--soft); color: var(--accent); }
/* Bad */
.badge { background: #e3f4ea; color: #1e7b52; }
```

### Use the existing parts for buttons and popups

Use `.text-btn` for a text button, `.icon-btn` for an icon-only button (its `aria-label` becomes the tooltip), `.chip` for a small value, and the same frame and shadow as `#account-popup` for a floating window.
If each screen makes its own button shape, the look does not match.

```html
<!-- Good -->
<button class="icon-btn" aria-label="Disconnect">…</button>
<!-- Bad -->
<button class="unlink-button">Disconnect</button>
```

### Use three levels of corner radius

Use 8px for an icon button, 12px for a card and a popup, and half the height (round ends) for an input and a text button.
If the radii do not match, the parts look scattered on one screen.

```css
/* Good */
.card { border-radius: 12px; }
.field { height: 32px; border-radius: 16px; }
/* Bad */
.card { border-radius: 6px; }
```

### Make the settings for each integration a card of the same shape

Line up the header row (logo, name, and at the right end the actions and `?`), the rows for connected targets (avatar, name, note, status, actions), and the add row, in that order.
This way, even as integrations grow, you look for each thing in the same place (at the owner's instruction, 2026-10-31).
An integration whose tab holds more than the connection may use several cards, each with its own header row, the connection card first (the Claude tab has three, chosen by the owner on 2026-11-03).

```html
<section class="card">
  <div class="card-head"><h2>Example</h2><button class="icon-btn" aria-label="How to set up Example">?</button></div>
  <div class="item">…name, status, actions…</div>
  <form class="add">…</form>
</section>
```

### Put steps and side notes in the `?` hint, not on the screen

Write the setup steps, the scopes and where things are stored in the popup that the `?` icon button opens.
The text on the screen is only the status and errors.
If a long explanation is always visible, the status and the actions that matter get buried (at the owner's instruction, 2026-10-31).

```text
Good: ? at the top right of the card -> a popup with steps and scopes
Bad:  paragraphs of steps and scopes shown above the input
```

### Show status as a label with a dot

Green means usable (connected, logged in), orange means action is needed (missing permission, not logged in), and gray means not set up (not installed).
A status buried in a sentence cannot be read at a glance.

```html
<!-- Good -->
<span class="status ok">Connected</span>
<!-- Bad -->
<span>me@example.com · connected</span>
```
