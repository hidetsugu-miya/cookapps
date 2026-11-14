// What the two specs of the Orca screen share (`specs/orca.e2e.ts` and `specs/orca-files.e2e.ts`): the sample list, how the screen is opened, and how its tabs, projects and menus are found.
// A helper that only one of them uses stays in that spec. The mocks and the typed fixture data stay in `support.ts`.
import { boot, inbox, onceId, orcaOverview, orcaRow, orcaWorktree, textsOf } from "./support";

// A running, a waiting and a done agent, and a second running one that has no pane (its session has no tab). Each has its own project (`proj_{repo}`).
export const sample = () => [
  orcaRow("example-app", "feat/a", "Write the docs", { minutes: 2 }),
  orcaRow("example-api", "main", "Fix the parser", { group: "waiting", minutes: 5 }),
  orcaRow("example-web", "dev", "Update the page", { minutes: 11, handle: null, paneKey: null }),
  orcaRow("example-lib", "feature/x", "Opened the pull request.", { group: "done", minutes: 18 }),
];
export const worktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];
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

export const project = (name: string) => $(`//div[@id="orca-feed"]//button[contains(@class,"orca-project")][.//span[@class="orca-project-name"][. = "${name}"]]`);
