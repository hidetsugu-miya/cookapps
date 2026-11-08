import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { resolve } from "node:path";

// `npm run e2e:build` puts the E2E binary here; Windows adds .exe. The exit code of `wdio run` (non-zero on a failed spec) is the result `npm run e2e` answers.
const binary = resolve("src-tauri/target/debug", process.platform === "win32" ? "cookapps.exe" : "cookapps");

// `tauri dev` writes its binary to the same place, so tell the E2E build apart by its identifier (src-tauri/tauri.e2e.conf.json), which Tauri embeds in the binary.
const e2eIdentifier: string = JSON.parse(readFileSync("src-tauri/tauri.e2e.conf.json", "utf8")).identifier;

// The ports are taken together and given back together, so no two of them are the same.
const freePorts = async (count: number) => {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<Server>((done, fail) => {
          const server = createServer();
          server.once("error", fail);
          server.listen(0, "127.0.0.1", () => done(server));
        }),
    ),
  );
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  return ports;
};

// The service starts one app for each capability, so the specs are split into three capabilities and run in three apps at once.
// The first two capabilities name their specs, chosen so that all three take about the same time (the per-spec times of a run, in seconds: orca 124, slack-list 92, todo 59, inbox 49, sidebar 37, settings 32, slack-thread 26, orca-handoff 19, todo-prompt 10, thread 9, slack-compose 8, calendar 5; about 155 for each capability); every spec not named here (a new one included) runs in the last one.
// `--spec` replaces the specs of every capability and keeps only their excludes, so a spec given there runs in each app that does not exclude it (three apps for an unnamed spec, two for a named one).
// `wdio:maxInstances: 1` keeps two workers out of one app.
const namedSpecs = [
  ["./e2e/specs/orca.e2e.ts", "./e2e/specs/slack-thread.e2e.ts", "./e2e/specs/calendar.e2e.ts"],
  ["./e2e/specs/slack-list.e2e.ts", "./e2e/specs/todo.e2e.ts", "./e2e/specs/slack-compose.e2e.ts"],
];
const appCapability = (specs: { "wdio:specs": string[] } | { "wdio:exclude": string[] }) => ({
  browserName: "tauri",
  "tauri:options": { application: binary },
  "wdio:maxInstances": 1,
  // onPrepare fills in `embeddedPort`.
  "wdio:tauriServiceOptions": {} as { embeddedPort?: number },
  ...specs,
});

export const config = {
  runner: "local",
  specs: ["./e2e/specs/**/*.e2e.ts"],
  maxInstances: 3,
  services: [["@wdio/tauri-service", { appBinaryPath: binary, driverProvider: "embedded" }]],
  capabilities: [
    appCapability({ "wdio:specs": namedSpecs[0] }),
    appCapability({ "wdio:specs": namedSpecs[1] }),
    appCapability({ "wdio:exclude": namedSpecs.flat() }),
  ],
  framework: "mocha",
  reporters: ["spec"],
  // A `browser.execute` that loses its result costs the 3 s script timeout plus a retry, which used up the default 5 s of one `waitUntil`; 15 s fits that and stays far under the test's 60 s.
  // This is also the default of `expect` and `waitFor*`, so a failing check waits this long.
  waitforTimeout: 15000,
  mochaOpts: { ui: "bdd", timeout: 60000 },
  logLevel: "warn",
  onPrepare: async (_config: unknown, capabilities: { "wdio:tauriServiceOptions": { embeddedPort?: number } }[]) => {
    if (!existsSync(binary) || !readFileSync(binary).includes(e2eIdentifier)) {
      throw new Error(`${binary} is not the E2E build (no ${e2eIdentifier} in it): run \`npm run e2e:build\` first`);
    }
    // The service waits for any WebDriver server on its port, so on the default 4445 a second run would drive the first run's app. This hook runs before the service's.
    const ports = await freePorts(capabilities.length);
    capabilities.forEach((capability, i) => {
      capability["wdio:tauriServiceOptions"].embeddedPort = ports[i];
    });
  },
  // The result of `browser.execute` is sometimes lost (locally too; see `boot` in e2e/support.ts), and the plugin then waits for the default 30 s before webdriver retries the command and it recovers. Waiting longer does not bring the result back.
  // The scripts of the specs finish at once, so a short limit turns that wait into 3 s.
  before: async () => {
    await browser.setTimeout({ script: 3000 });
  },
  // Choosing the one window ("main", Tauri's default label) by hand stops the service's per-command focus check, whose eval can wait for the whole script timeout (set in `before`) on macOS.
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
