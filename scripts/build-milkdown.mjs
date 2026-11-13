// Bundles Milkdown (scripts/milkdown-entry.js) into the one file src/vendor/milkdown.js, with esbuild. Run it by hand after a change of the Milkdown version: `npm run vendor:milkdown`.
// The app's own build stays tsc alone; the bundle is committed like the other files of src/vendor/, and it loads nothing from outside.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = (name) => JSON.parse(readFileSync(`${root}node_modules/${name}/package.json`, "utf8")).version;

await build({
  entryPoints: [`${root}scripts/milkdown-entry.js`],
  outfile: `${root}src/vendor/milkdown.js`,
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "CookappsMilkdown",
  target: "safari15",
  legalComments: "none",
  banner: {
    js: `/* Milkdown ${version("@milkdown/kit")} (MIT, https://github.com/Milkdown/milkdown), bundled with esbuild ${version("esbuild")} (MIT) by scripts/build-milkdown.mjs. It holds ProseMirror, remark and unified and the other packages Milkdown depends on, each under its own MIT license. */`,
  },
});
