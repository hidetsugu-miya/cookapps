import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// `npm run e2e:build` puts the E2E binary here; Windows adds .exe. The exit code of `wdio run` (non-zero on a failed spec) is the result CI reads.
const binary = resolve("src-tauri/target/debug", process.platform === "win32" ? "cookapps.exe" : "cookapps");

// `tauri dev` writes its binary to the same place, so tell the E2E build apart by its identifier (src-tauri/tauri.e2e.conf.json), which Tauri embeds in the binary.
const e2eIdentifier: string = JSON.parse(readFileSync("src-tauri/tauri.e2e.conf.json", "utf8")).identifier;

export const config = {
  runner: "local",
  specs: ["./e2e/specs/**/*.e2e.ts"],
  maxInstances: 1,
  services: [["@wdio/tauri-service", { appBinaryPath: binary, driverProvider: "embedded" }]],
  capabilities: [{ browserName: "tauri", "tauri:options": { application: binary } }],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60000 },
  logLevel: "warn",
  onPrepare: () => {
    if (!existsSync(binary) || !readFileSync(binary).includes(e2eIdentifier)) {
      throw new Error(`${binary} is not the E2E build (no ${e2eIdentifier} in it): run \`npm run e2e:build\` first`);
    }
  },
  // Choosing the one window ("main", Tauri's default label) by hand stops the service's per-command focus check, whose eval can wait 30 s on macOS.
  // `before` runs ahead of the service's own `before` (browser.tauri is not there yet), so this is the earliest hook that can do it.
  beforeSuite: async () => {
    await browser.tauri.switchWindow("main");
  },
  // A command the fixtures do not answer rejects (e2e/fixtures.js) and may be swallowed by the app: name it, so a failure points at the missing mock.
  afterTest: async (_test: unknown, _context: unknown, result: { passed: boolean }) => {
    if (result.passed) return;
    try {
      const missing = await browser.execute(() => (window as unknown as { __e2e_unmocked__?: string[] }).__e2e_unmocked__ ?? []);
      if (missing.length) console.error(`e2e: unmocked commands in the failed test: ${[...new Set(missing)].join(", ")}`);
    } catch {
      // The page is gone (a crash or a reload); the test's own error says so.
    }
  },
};
