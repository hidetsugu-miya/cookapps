// What the two specs of the Orca screen share (`specs/orca.e2e.ts` and `specs/orca-files.e2e.ts`): the sample list, how the screen is opened, and how its tabs, projects and menus are found.
// A helper that only one of them uses stays in that spec. The mocks stay in `support.ts`; `orcaOverview` and `streamList` here put each item where the list was read from, on top of those of `support.ts`.
import type { OrcaLocal } from "../ts/bindings/OrcaLocal";
import type { OrcaOverview } from "../ts/bindings/OrcaOverview";
import type { OrcaRow } from "../ts/bindings/OrcaRow";
import type { OrcaStreamEvent } from "../ts/bindings/OrcaStreamEvent";
import type { OrcaTerminal } from "../ts/bindings/OrcaTerminal";
import type { OrcaWorktree } from "../ts/bindings/OrcaWorktree";
import { boot, inbox, onceId, orcaOverview as readOf, orcaRow, orcaWorktree, streamList as streamOf, textsOf } from "./support";

// A running, a waiting and a done agent, and a second running one that has no pane (its session has no tab). Each has its own project (`proj_{repo}`).
export const sample = () => [
  orcaRow("example-app", "feat/a", "Write the docs", { minutes: 2 }),
  orcaRow("example-api", "main", "Fix the parser", { group: "waiting", minutes: 5 }),
  orcaRow("example-web", "dev", "Update the page", { minutes: 11, handle: null, paneKey: null }),
  orcaRow("example-lib", "feature/x", "Opened the pull request.", { group: "done", minutes: 18 }),
];
export const worktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];

// Rust says where each item of a list is (`environment`: the name of the saved environment the list was read from, none for this machine). An item that names no place is put in `environment`; one that names it (null: this machine's) stays.
const placed = <T extends { environment?: string | null }>(items: T[], environment: string | null): T[] => (environment === null ? items : items.map((item) => (item.environment === undefined ? { ...item, environment } : item)));

// `orcaOverview` of `support.ts`, with every item put where the target is, as Rust does.
export const orcaOverview = (rows: OrcaRow[], worktrees: OrcaWorktree[] = [], extra: Partial<OrcaOverview> = {}): OrcaOverview => {
  const read = readOf(rows, worktrees, extra);
  const at = read.target;
  return { ...read, rows: placed(read.rows, at), worktrees: placed(read.worktrees, at), projects: placed(read.projects, at), terminals: placed(read.terminals, at) };
};

// `streamList` of `support.ts`, with every item put in the saved environment that streams it (`Studio`, as the specs stream it), as Rust does; `null` is this machine's Orca (A-12), whose items name no place.
export const streamList = (rows: OrcaRow[], worktrees: OrcaWorktree[] = [], terminals: OrcaTerminal[] = [], environment: string | null = "Studio"): OrcaStreamEvent => {
  const event = streamOf(rows, worktrees, terminals);
  if (event.kind !== "list") return event;
  return { ...event, rows: placed(event.rows, environment), worktrees: placed(event.worktrees, environment), projects: placed(event.projects, environment), terminals: placed(event.terminals, environment) };
};

// The list `read` with the projects of `repos` (and their rows, worktrees and terminals) on this machine, while the rest of it stays where it is: a list of a saved environment that holds this machine's items too.
export const onThisMachine = (read: OrcaOverview, ...repos: string[]): OrcaOverview => {
  const keys = repos.map((repo) => `proj_${repo}`);
  const move = <T extends { environment?: string | null }>(items: T[], keyOf: (item: T) => string): T[] => items.map((item) => (keys.includes(keyOf(item)) ? { ...item, environment: null } : item));
  return { ...read, rows: move(read.rows, (r) => r.projectKey), worktrees: move(read.worktrees, (w) => w.projectKey), projects: move(read.projects, (p) => p.key), terminals: move(read.terminals, (t) => t.projectKey) };
};

// `local` of `orca_overview` (A-6, A-33): this machine's lists beside those of a saved environment, which has its own state. Its items name no place (this machine's); `extra` gives another state or lists.
export const beside = (rows: OrcaRow[], worktrees: OrcaWorktree[] = [], extra: Partial<OrcaLocal> = {}): OrcaLocal => {
  const { state, message, rows: held, worktrees: trees, projects, terminals } = readOf(rows, worktrees);
  return { state, message, rows: held, worktrees: trees, projects, terminals, ...extra };
};

// A saved environment as the target: its list is streamed.
export const studio = { target: "Studio", environments: ["Studio", "Lab"] };

// The app with `value` as what Orca answers, and the Orca screen open.
export async function openOrca(value = orcaOverview(sample(), worktrees()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), orca_overview: value, ...fixtures });
  await $("#nav-orca").click();
  await expect($("#orca")).toBeDisplayed();
}

// Leaves the Orca screen and shows it again: showing the screen reads the list (with the environments), whatever read is on its way.
export async function showAgain() {
  await $("#nav-mail").click();
  await $("#nav-orca").click();
  await expect($("#orca")).toBeDisplayed();
}

export const selectedTab = () => $('.orca-tabs [role="tab"][aria-selected="true"]');
export const tabTitles = () => textsOf(".orca-tabs .orca-tab-title");
export const tabOf = (id: string) => $(`.orca-tabs [data-tab="${id}"]`);
export const claudeTab = (repo: string) => `claude:tab_${repo}:leaf_1`;

// The page's own press of an item of a menu (the driver's click focuses the button after the page's handler ran, which no real press does).
export async function pickItem(label: string) {
  await browser.execute(
    (id, text) => {
      if (!window.__e2e_once__(id)) return;
      [...document.querySelectorAll<HTMLElement>('.menu[role="menu"] button')].find((b) => b.textContent === text)!.click();
    },
    onceId(),
    label,
  );
}

// The button of the file pane that is on the screen (one at a time: the corner pane's while the pane is hidden, the pane's own while it is shown).
// The pane's own has no `hidden` of its own (the pane around it has), so it is found by the pane.
export const filesToggle = () => $(".orca-tabbar .orca-files-toggle:not([hidden]), #orca-files:not([hidden]) .orca-files-toggle");

export const project = (name: string) => $(`//div[@id="orca-feed"]//button[contains(@class,"orca-project")][.//span[@class="orca-project-name"][. = "${name}"]]`);
