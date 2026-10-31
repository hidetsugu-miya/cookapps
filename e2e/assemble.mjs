// Builds e2e/dist, the frontend of the E2E build: src/ plus the wdio plugin and the fixtures, loaded before the app.
// src/ itself never contains them, so the production frontend is unchanged.
import { cpSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}e2e/dist`;
if (!existsSync(`${root}src/js/main.js`)) throw new Error("src/js/main.js is missing: run `npm run build:ts` first");
rmSync(dist, { recursive: true, force: true });
cpSync(`${root}src`, dist, { recursive: true });
// Still needed: @wdio/tauri-service finds the app through this frontend plugin (its docs: the import must run before the tests), and the Rust side has tauri-plugin-wdio.
copyFileSync(`${root}node_modules/@wdio/tauri-plugin/dist-js/index.js`, `${dist}/wdio-plugin.js`);
copyFileSync(`${root}e2e/fixtures.js`, `${dist}/e2e-fixtures.js`);

// Module scripts run in document order: the plugin and the fixtures go before the app's own module, so the app finds their `window.__TAURI__.core` in place.
// `npm run build:ts` has to have run: the app is src/js/main.js, the output of tsc.
const app = '<script type="module" src="js/main.js"></script>';
const html = readFileSync(`${dist}/index.html`, "utf8");
if (!html.includes(app)) throw new Error("index.html: the app's module tag changed, update e2e/assemble.mjs");
writeFileSync(
  `${dist}/index.html`,
  html.replace(app, `<script type="module" src="wdio-plugin.js"></script>\n  <script type="module" src="e2e-fixtures.js"></script>\n  ${app}`),
);
