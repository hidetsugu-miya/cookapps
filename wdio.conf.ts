import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { resolve } from "node:path";

// `npm run e2e:build` puts the E2E binary here; Windows adds .exe. The exit code of `wdio run` (non-zero on a failed spec) is the result `npm run e2e` answers.
const binary = resolve("src-tauri/target/debug", process.platform === "win32" ? "tsunagiai.exe" : "tsunagiai");

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

// The service starts one app for each capability, so the specs are split into six capabilities and run in six apps at once.
// The first five capabilities name their specs. The tests of the Orca screen are two specs, orca and orca-files (the file pane and the editor), each in an app of its own with other specs beside it, so that the two halves run at the same time.
// The other specs are spread so that the apps take about the same time, by the seconds of the last full run of the five apps (2026-11-18, HEAD 622e1f5; wdio took 196 seconds in all, and the apps took 188, 190, 192, 180 and 183 seconds, four of them over the 180 of `.claude/rules/e2e.md`; the 20 specs add up to 933 seconds, 156 for each of six apps): orca 125, orca-files 122, formation 111 (117 since it grew to 166 tests, below), slack-list 107, todo 83, database 62, settings 50, orca-handoff 45, slack-thread 45, sidebar 41, orca-definition 25, inbox 25, slack-compose 24, thread 19, footer 12, calendar 10, todo-prompt 10, orca-peek 6, todo-claude 6, claude-code 4; that is 157 for orca, thread and footer, 158 for slack-list, orca-handoff and todo-claude, 156 for orca-files, slack-compose and todo-prompt, 156 for formation and slack-thread, 155 for todo, database and calendar, and 152 for the last app.
// Every spec not named here (a new one included) runs in the last one, which is settings, sidebar, orca-definition, inbox, orca-peek and claude-code today, so it has the least seconds to give a new spec room; when a new spec makes it the longest, name some of its specs in the first five.
// The sixth app is kept because the first full run of the six (2026-11-18, HEAD f989ef0) made wdio shorter than the 196 seconds of the five: 155 seconds, with the apps at 153, 153, 152, 151, 151 and 148 (`.claude/rules/e2e.md`, "Keep every app under 180 seconds"). After formation grew from 145 tests to 166, the run of HEAD 6672d63 took 160 seconds, with the apps at 151, 152, 150, 159 (formation 117 and slack-thread 42), 149 and 146.
// The seconds of a spec stayed within a few seconds in six full runs from 5cd81f6 to 51f88fe, except formation (102 to 151).
// `--spec` replaces the specs of every capability and keeps only their excludes, so a spec given there runs in each app that does not exclude it (six apps for an unnamed spec, five for a named one).
// `wdio:maxInstances: 1` keeps two workers out of one app.
const namedSpecs = [
  ["./e2e/specs/orca.e2e.ts", "./e2e/specs/thread.e2e.ts", "./e2e/specs/footer.e2e.ts"],
  ["./e2e/specs/slack-list.e2e.ts", "./e2e/specs/orca-handoff.e2e.ts", "./e2e/specs/todo-claude.e2e.ts"],
  ["./e2e/specs/orca-files.e2e.ts", "./e2e/specs/slack-compose.e2e.ts", "./e2e/specs/todo-prompt.e2e.ts"],
  ["./e2e/specs/formation.e2e.ts", "./e2e/specs/slack-thread.e2e.ts"],
  ["./e2e/specs/todo.e2e.ts", "./e2e/specs/database.e2e.ts", "./e2e/specs/calendar.e2e.ts"],
];
const appCapability = (specs: { "wdio:specs": string[] } | { "wdio:exclude": string[] }) => ({
  browserName: "tauri",
  "tauri:options": { application: binary },
  "wdio:maxInstances": 1,
  // onPrepare fills in `embeddedPort`.
  "wdio:tauriServiceOptions": {} as { embeddedPort?: number },
  ...specs,
});

// `run-e2e.sh --only {name}` sets E2E_ONLY and runs `e2e/specs/{name}.e2e.ts` in one app, to run a failed spec again alone (`.claude/rules/e2e.md`).
// It narrows the capabilities to one, so the spec runs once; `--spec` would run it in every capability.
const only = process.env.E2E_ONLY;
if (only !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(only)) throw new Error(`E2E_ONLY must be a spec name such as "inbox", got "${only}"`);
const onlySpec = only === undefined ? undefined : `./e2e/specs/${only}.e2e.ts`;
if (onlySpec !== undefined && !existsSync(onlySpec)) throw new Error(`${onlySpec} does not exist`);

// `E2E_MAX_INSTANCES` sets how many apps start and run at once, for a machine with fewer cores than this one (`.github/workflows/e2e.yml` sets 2); unset, six start. The service starts one app for each capability, so a number under six makes that many capabilities, not fewer workers over six apps.
// The first N - 1 capabilities name their specs, and the last one excludes them, as in the six. The named specs are spread by their seconds in the list above (the 16 specs of the table, largest first, each into the app with the least seconds so far; the last app starts with the 101 seconds of settings, sidebar, orca-peek and claude-code, which are not in the table and always run in the last app, as does a new spec). With 1 every spec runs in one app.
// A number of six or more changes nothing but `maxInstances`.
const maxInstancesEnv = process.env.E2E_MAX_INSTANCES;
if (maxInstancesEnv !== undefined && !/^[1-9][0-9]*$/.test(maxInstancesEnv)) throw new Error(`E2E_MAX_INSTANCES must be an integer of 1 or more, got "${maxInstancesEnv}"`);
const maxInstances = maxInstancesEnv === undefined ? namedSpecs.length + 1 : Number(maxInstancesEnv);
const specSeconds: Record<string, number> = {
  orca: 125,
  "orca-files": 122,
  formation: 117,
  "slack-list": 107,
  todo: 83,
  database: 62,
  "orca-handoff": 45,
  "slack-thread": 45,
  "orca-definition": 25,
  inbox: 25,
  "slack-compose": 24,
  thread: 19,
  footer: 12,
  calendar: 10,
  "todo-prompt": 10,
  "todo-claude": 6,
};
const unnamedSeconds = 101;
const spreadSpecs = (apps: number) => {
  const bins = Array.from({ length: apps }, (_, i) => ({ specs: [] as string[], seconds: i === apps - 1 ? unnamedSeconds : 0 }));
  for (const [name, seconds] of Object.entries(specSeconds).sort((a, b) => b[1] - a[1])) {
    const bin = bins.reduce((least, bin) => (bin.seconds < least.seconds ? bin : least));
    bin.specs.push(`./e2e/specs/${name}.e2e.ts`);
    bin.seconds += seconds;
  }
  return bins.slice(0, -1).map((bin) => bin.specs);
};
const groups = maxInstances < namedSpecs.length + 1 ? spreadSpecs(maxInstances) : namedSpecs;

export const config = {
  runner: "local",
  specs: ["./e2e/specs/**/*.e2e.ts"],
  maxInstances,
  services: [["@wdio/tauri-service", { appBinaryPath: binary, driverProvider: "embedded" }]],
  capabilities:
    onlySpec !== undefined
      ? [appCapability({ "wdio:specs": [onlySpec] })]
      : [
          ...groups.map((specs) => appCapability({ "wdio:specs": specs })),
          appCapability({ "wdio:exclude": groups.flat() }),
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
    // wdio 10 has no `browser.executeAsync`, and @wdio/tauri-service 1.5.1 still binds it in its own `before` (which runs after this one) and calls it in `browser.tauri.switchWindow`: without it the service stops halfway through its setup.
    const classic = browser as unknown as { executeAsync?: (script: string | ((...args: never[]) => unknown), ...args: unknown[]) => Promise<unknown> };
    classic.executeAsync ??= (script, ...args) => browser.executeAsyncScript(typeof script === "function" ? `return (${script}).apply(null, arguments)` : script, args as Parameters<typeof browser.executeAsyncScript>[1]);
    // The embedded WebDriver (tauri-plugin-wdio-webdriver 1.5.1) keeps the result of a lookup of several elements in one fixed place of the page (`window.__wd_temp_{i}`), so two such lookups in flight at once hand out each other's elements. wdio 10 looks up every `$()` that way (to count the matches), so these lookups go one at a time.
    let lastLookup: Promise<unknown> = Promise.resolve();
    const oneAtATime = (lookup: () => Promise<unknown>) => {
      const next = lastLookup.then(lookup, lookup);
      lastLookup = next.catch(() => {});
      return next;
    };
    const commands = browser as unknown as { overwriteCommand: (name: string, command: (original: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]) => Promise<unknown>, options?: { attachToElement: boolean } | boolean) => void };
    // @wdio/tauri-service 1.5.1 gives `overwriteCommand` the boolean wdio 9 took as "an element command", which wdio 10 refuses: read it as the option, so that the service's overrides of click, doubleClick, setValue and clearValue go in as they did.
    const overwrite = commands.overwriteCommand.bind(browser);
    commands.overwriteCommand = (name, command, options) => overwrite(name, command, typeof options === "boolean" ? { attachToElement: options } : options);
    for (const name of ["findElements", "findElementsFromElement", "findElementsFromShadowRoot"]) {
      commands.overwriteCommand(name, (original, ...args) => oneAtATime(() => original(...args)));
      commands.overwriteCommand(name, (original, ...args) => oneAtATime(() => original(...args)), { attachToElement: true });
    }
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
