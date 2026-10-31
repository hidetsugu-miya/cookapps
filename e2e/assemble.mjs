// Builds e2e/dist, the frontend of the E2E build: src/ plus the wdio plugin and the fixtures, loaded before the app.
// src/ itself never contains them, so the production frontend is unchanged.
import { cpSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}e2e/dist`;
rmSync(dist, { recursive: true, force: true });
cpSync(`${root}src`, dist, { recursive: true });
copyFileSync(`${root}node_modules/@wdio/tauri-plugin/dist-js/index.js`, `${dist}/wdio-plugin.js`);
copyFileSync(`${root}e2e/fixtures.js`, `${dist}/e2e-fixtures.js`);

// Module scripts run in document order. main.js is a classic script today, so it is made a module here;
// once the app itself is a module, only the two inserted tags remain needed.
const app = '<script src="main.js"></script>';
const html = readFileSync(`${dist}/index.html`, "utf8");
if (!html.includes(app)) throw new Error("index.html: the main.js tag changed, update e2e/assemble.mjs");
writeFileSync(
  `${dist}/index.html`,
  html.replace(
    app,
    '<script type="module" src="wdio-plugin.js"></script>\n  <script type="module" src="e2e-fixtures.js"></script>\n  <script type="module" src="main.js"></script>',
  ),
);
