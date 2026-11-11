import type { OrcaDiffRow } from "../../ts/bindings/OrcaDiffRow";
import type { OrcaDir } from "../../ts/bindings/OrcaDir";
import type { OrcaFileDiff } from "../../ts/bindings/OrcaFileDiff";
import type { OrcaFileText } from "../../ts/bindings/OrcaFileText";
import type { OrcaSaved } from "../../ts/bindings/OrcaSaved";
import type { OrcaStarted } from "../../ts/bindings/OrcaStarted";
import type { PaneLayout } from "../../ts/bindings/PaneLayout";
import type { PaneNode } from "../../ts/bindings/PaneNode";
import {
  boot,
  callsOf,
  chooseAppearance,
  chooseOption,
  chooseTheme,
  copiedTexts,
  count,
  fire,
  fontSettings,
  ghosttyImport,
  holds,
  huge,
  image,
  inbox,
  isoDate,
  mock,
  note,
  onceId,
  orcaOverview,
  orcaRow,
  orcaSsh,
  orcaTerminal,
  orcaWorktree,
  PNG,
  rejects,
  release,
  rowOf as threadRowOf,
  sendStream,
  sendTerm,
  setClock,
  setDark,
  streamList,
  stubClipboard,
  terminalThemes,
  textsOf,
  threadDetail,
  waitForCalls,
  waitForCount,
} from "../support";

// A running, a waiting and a done agent, and a second running one that has no pane (its session has no tab). Each has its own project (`proj_{repo}`).
const sample = () => [
  orcaRow("example-app", "feat/a", "Write the docs", { minutes: 2, activity: "Bash: cargo test --all-features" }),
  orcaRow("example-api", "main", "Fix the parser", { group: "waiting", minutes: 5, activity: "Which one should I use?" }),
  orcaRow("example-web", "dev", "Update the page", { minutes: 11, handle: null, paneKey: null }),
  orcaRow("example-lib", "feature/x", "Opened the pull request.", { group: "done", minutes: 18, activity: "Edit: ts/orca.ts" }),
];
const worktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];
// example-app with a second worktree, so that the plus asks which one (A-16); example-api keeps its one.
const twoWorktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b" }), orcaWorktree("example-api", "main")];
// What `orca_start` answers for a session started in example-api, and its row once the list holds it (a pane that is not one of the sample's).
const reply: OrcaStarted = { paneKey: "tab_new:leaf_1", handle: "term_new" };
const startedRow = () => orcaRow("example-api", "main", "Write the docs", { paneKey: "tab_new:leaf_1", handle: "term_new" });
// What `orca_start` and `orca_terminal_create` answer when Orca's reply gave neither a pane key nor a handle.
const noPane: OrcaStarted = { paneKey: null, handle: null };
// What `orca_terminal_create` answers for a terminal made in example-api (it has a handle and no pane key), and the plain terminal once the list holds it.
const created: OrcaStarted = { paneKey: null, handle: "term_new_sh" };
const createdTerminal = () => orcaTerminal("example-api", "zsh", { handle: "term_new_sh" });
// The two items of the plus.
const CLAUDE = "Claude を起動";
const TERMINAL = "ターミナルを開く";
// A saved environment as the target: its list is streamed.
const studio = { target: "Studio", environments: ["Studio", "Lab"] };

// The app with `value` as what Orca answers, and the Orca screen open.
async function openOrca(value = orcaOverview(sample(), worktrees()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), orca_overview: value, ...fixtures });
  await $("#nav-orca").click();
  await expect($("#orca")).toBeDisplayed();
}

// The same with the working view (the bell pressed): the agents in their groups, which a row of selects.
async function openWorking(value = orcaOverview(sample(), worktrees()), fixtures: Record<string, unknown> = {}) {
  await openOrca(value, fixtures);
  await $("#orca-bell").click();
  await expect($("#orca-bell")).toHaveAttribute("aria-pressed", "true");
}

const rowTexts = (selector: string) => textsOf(`#orca-feed .orca-row ${selector}`);
const groups = () => textsOf("#orca-feed .orca-group");
// The row of the worktree `repo`: the third line of a row names it.
const rowOf = (repo: string) => $(`//div[@id="orca-feed"]//button[contains(@class,"orca-row")][.//span[@class="orca-where"][starts-with(., "${repo} ・")]]`);
const classOf = (selector: string) => browser.execute((s) => document.querySelector(s)!.className, selector);
// Whether the sidebar icon of Orca is marked as working (the yellow icon that fades; the fade itself is not tested).
const marked = () => browser.execute(() => document.getElementById("nav-orca")!.classList.contains("working"));
const pressed = (repo: string) => rowOf(repo).getAttribute("aria-pressed");
const selectedTab = () => $('.orca-tabs [role="tab"][aria-selected="true"]');
const tabTitles = () => textsOf(".orca-tabs .orca-tab-title");
const tabOf = (id: string) => $(`.orca-tabs [data-tab="${id}"]`);
const claudeTab = (repo: string) => `claude:tab_${repo}:leaf_1`;
// The text of the terminal shown (the terminals of the other tabs stay, hidden).
const screenText = () => $(".orca-term .orca-term-box:not([hidden]) .xterm-rows").getText();

async function pickMenu(label: string) {
  for (const item of await $$(".menu button")) {
    if ((await item.getText()) === label) return item.click();
  }
  throw new Error(`no menu item "${label}"`);
}

// Selects the project of `repo` in the list pane (the plus starts in the selected one).
async function pickProject(repo: string) {
  await $(`#orca-feed .orca-project[data-key="proj_${repo}"]`).click();
  await expect($(`#orca-feed .orca-project[data-key="proj_${repo}"]`)).toHaveAttribute("aria-pressed", "true");
}

// The page's own press of the plus and of an item of its menu (the driver's click focuses the button after the page's handler ran, which no real press does).
async function pressPlus(selector = ".orca-plus") {
  await browser.execute(
    (id, plus) => {
      if (window.__e2e_once__(id)) document.querySelector<HTMLElement>(plus)!.click();
    },
    onceId(),
    selector,
  );
  await expect($('.menu[role="menu"]')).toBeDisplayed();
}
async function pickItem(label: string) {
  await browser.execute(
    (id, text) => {
      if (!window.__e2e_once__(id)) return;
      [...document.querySelectorAll<HTMLElement>('.menu[role="menu"] button')].find((b) => b.textContent === text)!.click();
    },
    onceId(),
    label,
  );
}
// Selects the project of `repo`, then chooses `label` in the plus. The worktree dialog, when the project has none or several, is the caller's.
async function plus(repo: string, label: string) {
  await pickProject(repo);
  await pressPlus();
  await pickItem(label);
}
// The same, and picks the worktree at `path` in the dialog that a project with several asks with.
async function plusIn(repo: string, label: string, path: string) {
  await plus(repo, label);
  await expect($(".orca-dest-pop")).toBeDisplayed();
  await $(`.orca-dest-pop button[data-path="${path}"]`).click();
}

// Selects the row of `repo` in the working view.
async function select(repo: string) {
  await rowOf(repo).click();
  await expect(rowOf(repo)).toHaveAttribute("aria-pressed", "true");
}

// fixtures.js makes the page report a shown window; a spec turns it hidden or shown and tells the page.
const setWindowHidden = (hidden: boolean) =>
  browser.execute(
    (id, h) => {
      if (!window.__e2e_once__(id)) return;
      Object.defineProperty(document, "hidden", { get: () => h, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    },
    onceId(),
    hidden,
  );

type Row = ReturnType<typeof orcaRow>;

// The count of the sidebar button: 0 is no number at all.
const expectCount = (n: number) => (n === 0 ? expect($("#nav-orca .nav-count")).not.toBeDisplayed() : expect($("#nav-orca .nav-count")).toHaveText(String(n)));

// Answers the next read with `rows`, presses the reload button, and waits until the working view draws them (waiting, then working, then done), so a count checked after it is the one of that read.
async function reread(rows: Row[], extra: Partial<Parameters<typeof orcaOverview>[2]> = {}) {
  const overview = await mock("orca_overview", orcaOverview(rows, worktrees(), extra));
  await $("#orca-refresh").click();
  await waitForCalls(overview);
  const drawn = ["waiting", "working", "done"].flatMap((g) => rows.filter((r) => r.group === g).map((r) => `${r.line}:${r.status}`));
  await browser.waitUntil(
    async () => JSON.stringify(await browser.execute(() => [...document.querySelectorAll("#orca-feed .orca-row")].map((r) => `${r.querySelector(".orca-prompt")!.textContent}:${(r.querySelector(".orca-ic") as HTMLElement).dataset.status}`))) === JSON.stringify(drawn),
    { timeoutMsg: "the working view did not draw the read" },
  );
}

const working = (repo: string, extra: Partial<Row> = {}) => orcaRow(repo, "main", `Task of ${repo}`, extra);
// What Orca says of a finished agent, and of one stopped with Esc (`state` done with `interrupted` true).
const finished = (repo: string, extra: Partial<Row> = {}) => working(repo, { group: "done", ...extra });
const stopped = (repo: string) => finished(repo, { status: "interrupted" });

const project = (name: string) => $(`//div[@id="orca-feed"]//button[contains(@class,"orca-project")][.//span[@class="orca-project-name"][. = "${name}"]]`);

// A drag of the divider (pointer events, as the divider listens for them) that ends with the pointer at `fraction` of #orca's width from its left edge.
const dragDivider = (fraction: number) =>
  browser.execute((f) => {
    const box = document.getElementById("orca")!.getBoundingClientRect();
    const at = (x: number): PointerEventInit => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: box.left + box.width * x, clientY: box.top + 80 });
    document.getElementById("orca-split")!.dispatchEvent(new PointerEvent("pointerdown", at(0.3)));
    document.dispatchEvent(new PointerEvent("pointermove", at(f)));
    document.dispatchEvent(new PointerEvent("pointerup", at(f)));
  }, fraction);

describe("orca", () => {
  it("draws the agents in three groups with the count of what needs the user on the sidebar", async () => {
    await boot({ inbox: inbox(), orca_overview: orcaOverview(sample(), worktrees()) });
    // The count follows the first read, with the screen not shown: the waiting agent only, not the working ones and not the one done before the start.
    await expect($("#nav-orca .nav-count")).toHaveText("1");
    // The two working agents (the one with no pane too) are in the label and mark the icon, not in the count.
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（確認待ち 1 件、作業中 2 件）");
    expect(await marked()).toBe(true);
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    // The projects come first; the bell shows the agents.
    await $("#orca-bell").click();
    expect(await groups()).toEqual(["入力待ち1", "作業中2", "完了1"]);
    // Newest first inside a group is the order of the answer; the groups are in the order waiting, working, done.
    expect(await rowTexts(".orca-prompt")).toEqual(["Fix the parser", "Write the docs", "Update the page", "Opened the pull request."]);
    expect(await rowTexts(".orca-time")).toEqual(["5 分", "2 分", "11 分", "18 分前"]);
    // The second line is the latest action: the tool and its input, or the last answer; none when the agent has none.
    expect(await rowTexts(".orca-activity")).toEqual(["Which one should I use?", "Bash: cargo test --all-features", "", "Edit: ts/orca.ts"]);
    // The icon of a row is its status.
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-row .orca-ic")].map((i) => i.dataset.status))).toEqual(["question", "working", "working", "done"]);
    expect(await rowTexts(".orca-where")).toEqual(["example-api ・ main", "example-app ・ feat/a", "example-web ・ dev", "example-lib ・ feature/x"]);
    // No agent chip, no repository heading and no filter.
    expect(await rowTexts(".orca-agent")).toEqual([]);
    expect(await classOf("#orca-feed .orca-row.waiting")).toContain("waiting");
    await expect($("#orca-status")).toHaveText("このマシン に接続中");
    expect(await classOf("#orca-status")).toContain("ok");
    // No environment is saved: the label is plain text.
    await expect($("#orca-target")).not.toBeDisplayed();
  });

  it("makes the header of the list, the bar of a pane and the bar of the file pane a place to drag the window by", async () => {
    await openOrca();
    await expect($("#orca-header")).toHaveAttribute("data-tauri-drag-region");
    await expect($(".orca-tabbar")).toHaveAttribute("data-tauri-drag-region");
    await expect($("#orca-files-bar")).toHaveAttribute("data-tauri-drag-region");
    // The bell and the reload stay buttons that take the press.
    await expect($("#orca-bell")).not.toHaveAttribute("data-tauri-drag-region");
    await expect($("#orca-refresh")).not.toHaveAttribute("data-tauri-drag-region");
    await expect($("#orca-list-toggle")).not.toHaveAttribute("data-tauri-drag-region");
  });

  it("counts nothing while the agents only work", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api")], worktrees()));
    await expectCount(0);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（作業中 2 件）");
    expect(await marked()).toBe(true);
  });

  it("marks the icon while an agent works, and clears it when none does", async () => {
    await openWorking(orcaOverview([working("example-app")], worktrees()));
    expect(await marked()).toBe(true);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（作業中 1 件）");
    await reread([finished("example-app")]);
    expect(await marked()).toBe(false);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（確認待ち 1 件）");
    await reread([working("example-app")]);
    expect(await marked()).toBe(true);
    await reread([]);
    expect(await marked()).toBe(false);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca");
  });

  it("does not mark the icon for agents that wait or have stopped", async () => {
    await openWorking(orcaOverview([working("example-app")], worktrees()));
    await reread([working("example-api", { group: "waiting" }), finished("example-lib"), stopped("example-web"), working("example-app", { status: "failed" })]);
    expect(await marked()).toBe(false);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（確認待ち 4 件）");
  });

  it("clears the mark when a read fails or the command is missing", async () => {
    await openWorking(orcaOverview([working("example-app")], worktrees()));
    expect(await marked()).toBe(true);
    await mock("orca_overview", orcaOverview([], [], { state: "failed", message: "Orca is not running", environments: [] }));
    await $("#orca-refresh").click();
    await expect($("#orca-status")).toHaveText("このマシン に接続できません");
    expect(await marked()).toBe(false);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca");
    await mock("orca_overview", orcaOverview([working("example-app")], worktrees()));
    await $("#orca-refresh").click();
    await browser.waitUntil(marked, { timeoutMsg: "the mark never came back" });
    await mock("orca_overview", orcaOverview([], [], { state: "missing" }));
    await $("#orca-refresh").click();
    await expect($("#orca-status")).toHaveText("未インストール");
    expect(await marked()).toBe(false);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca");
  });

  it("clears the mark when the target changes, and marks again from the read of the new one", async () => {
    await openWorking(orcaOverview([working("example-app")], worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
    expect(await marked()).toBe(true);
    await mock("orca_set_target", null);
    await mock("orca_overview", orcaOverview([finished("lab-app")], [], { target: "Lab", environments: ["Studio", "Lab"] }));
    await $("#orca-target").click();
    await pickMenu("Lab");
    await expect($("#orca-target")).toHaveText("Lab に接続中");
    expect(await marked()).toBe(false);
    await reread([working("lab-app")], { target: "Lab", environments: ["Studio", "Lab"] });
    expect(await marked()).toBe(true);
  });

  it("marks and clears the icon from the read for the count alone while another screen is shown", async () => {
    await openWorking(orcaOverview([finished("example-lib")], worktrees()));
    expect(await marked()).toBe(false);
    await $("#nav-mail").click();
    await expect($("#orca")).not.toBeDisplayed();
    // The clock reads the count alone once a minute on another screen: a minute later the next tick does.
    const started = await mock("orca_overview", orcaOverview([working("example-app")], worktrees()));
    const at = (ms: number) => {
      const later = new Date(Date.now() + ms);
      return setClock(`${isoDate(later)}T${later.toTimeString().slice(0, 8)}`);
    };
    await at(61_000);
    expect(await waitForCalls(started)).toEqual([{ scope: "badge", target: null }]);
    await browser.waitUntil(marked, { timeoutMsg: "the icon was never marked by the read for the count" });
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（作業中 1 件）");
    const ended = await mock("orca_overview", orcaOverview([finished("example-app")], worktrees()));
    await at(130_000);
    expect(await waitForCalls(ended)).toEqual([{ scope: "badge", target: null }]);
    await browser.waitUntil(async () => !(await marked()), { timeoutMsg: "the mark was never cleared by the read for the count" });
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（確認待ち 1 件）");
  });

  it("does not count what had finished before the start, or stopped with Esc", async () => {
    await openWorking(orcaOverview([working("example-app"), finished("example-lib"), stopped("example-web")], worktrees()));
    await expectCount(0);
    await reread([working("example-app"), finished("example-lib"), stopped("example-web")]);
    await expectCount(0);
  });

  it("counts an agent that goes from working to done", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api")], worktrees()));
    await reread([finished("example-app"), working("example-api")]);
    await expectCount(1);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（確認待ち 1 件、作業中 1 件）");
  });

  it("counts an agent that appears in a later read already done", async () => {
    await openWorking(orcaOverview([working("example-app")], worktrees()));
    await reread([working("example-app"), finished("example-lib")]);
    await expectCount(1);
  });

  it("counts an interrupted agent and a failed one", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api")], worktrees()));
    await reread([stopped("example-app"), working("example-api", { status: "failed" })]);
    await expectCount(2);
  });

  it("counts a waiting agent and a stopped one together, and a waiting one with no pane", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api", { group: "waiting" })], worktrees()));
    await expectCount(1);
    await reread([finished("example-app"), working("example-api", { group: "waiting" }), working("example-web", { group: "waiting", paneKey: null, handle: null })]);
    await expectCount(3);
  });

  it("gives an agent with no pane no notice when it stops", async () => {
    await openWorking(orcaOverview([working("example-app", { paneKey: null, handle: null })], worktrees()));
    await reread([finished("example-app", { paneKey: null, handle: null })]);
    await expectCount(0);
  });

  it("drops the notice when the session is opened on the screen", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api")], worktrees()));
    await reread([finished("example-app"), finished("example-api")]);
    await expectCount(2);
    await select("example-app");
    await expectCount(1);
    // The session stays done, and is not noticed again by the next read.
    await reread([finished("example-app"), finished("example-api")]);
    await expectCount(1);
  });

  it("gives no notice to the session shown when it finishes", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api")], worktrees()));
    await select("example-app");
    await reread([finished("example-app"), working("example-api")]);
    await expectCount(0);
  });

  it("keeps the notice of a session finished while the window is hidden, and drops it when the window shows", async () => {
    await openWorking(orcaOverview([working("example-app")], worktrees()));
    await select("example-app");
    await setWindowHidden(true);
    await reread([finished("example-app")]);
    await expectCount(1);
    await setWindowHidden(false);
    await expectCount(0);
  });

  it("drops the notice when the agent runs again, or leaves the list", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api")], worktrees()));
    await reread([finished("example-app"), finished("example-api")]);
    await expectCount(2);
    await reread([working("example-app"), finished("example-api")]);
    await expectCount(1);
    await reread([working("example-app")]);
    await expectCount(0);
    // It stops again: a new notice.
    await reread([finished("example-app")]);
    await expectCount(1);
  });

  it("does not drop the notices when a read fails, and drops them when the command is missing", async () => {
    await openWorking(orcaOverview([working("example-app")], worktrees()));
    await reread([finished("example-app")]);
    await expectCount(1);
    await mock("orca_overview", orcaOverview([], [], { state: "failed", message: "Orca is not running", environments: [] }));
    await $("#orca-refresh").click();
    await expect($("#orca-status")).toHaveText("このマシン に接続できません");
    await expectCount(1);
    await mock("orca_overview", orcaOverview([], [], { state: "missing" }));
    await $("#orca-refresh").click();
    await expect($("#orca-status")).toHaveText("未インストール");
    await expectCount(0);
  });

  it("drops the notices when the target changes, and takes the first read of the new target as the base", async () => {
    await openWorking(orcaOverview([working("example-app")], worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
    await reread([finished("example-app")], { target: "Studio", environments: ["Studio", "Lab"] });
    await expectCount(1);
    await mock("orca_set_target", null);
    await mock("orca_overview", orcaOverview([finished("lab-app")], [], { target: "Lab", environments: ["Studio", "Lab"] }));
    await $("#orca-target").click();
    await pickMenu("Lab");
    await expect($("#orca-target")).toHaveText("Lab に接続中");
    await expectCount(0);
  });

  it("gives no new notice to a stopped agent that left the list for a read and comes back stopped", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api")], worktrees()));
    await reread([finished("example-app"), working("example-api")]);
    await expectCount(1);
    // It leaves the list: its notice goes, and the app remembers that it was stopped.
    await reread([working("example-api")]);
    await expectCount(0);
    await reread([finished("example-app"), working("example-api")]);
    await expectCount(0);
    // A pane the app never saw stopped still has a notice when it first appears stopped.
    await reread([finished("example-app"), working("example-api"), finished("example-lib")]);
    await expectCount(1);
  });

  it("drops the notices when a read names another target than the one held, and takes that read as the base", async () => {
    const environments = ["Studio", "Lab"];
    await openWorking(orcaOverview([working("example-app")], worktrees(), { target: "Studio", environments }));
    await reread([finished("example-app")], { target: "Studio", environments });
    await expectCount(1);
    // The target changed without the menu (for example the saved one was changed): the rows of the other target are only the base.
    await reread([finished("lab-app")], { target: "Lab", environments });
    await expect($("#orca-target")).toHaveText("Lab に接続中");
    await expectCount(0);
    await reread([finished("lab-app"), finished("lab-lib")], { target: "Lab", environments });
    await expectCount(1);
  });

  it("keeps the notice of a session that finished while another screen is shown, until the Orca screen shows it", async () => {
    await openWorking(orcaOverview([working("example-app"), working("example-api")], worktrees()));
    await select("example-app");
    await $("#nav-mail").click();
    await expect($("#orca")).not.toBeDisplayed();
    await waitForCount("#unread-threads li", 2);
    await mock("thread", threadDetail("請求書の件", "本文", false));
    await threadRowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("請求書の件");
    // The pane of the thread reads the list when it opens, and that read finds the selected session done.
    const overview = await mock("orca_overview", orcaOverview([finished("example-app"), working("example-api")], worktrees()));
    await $("#thread-orca").click();
    await waitForCalls(overview);
    await expectCount(1);
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await expectCount(0);
  });

  it("shows no waiting group when no agent waits, and says so when nothing runs", async () => {
    await openWorking(orcaOverview([orcaRow("example-app", "main", "Task")]));
    expect(await groups()).toEqual(["作業中1"]);
    await boot({ inbox: inbox(), orca_overview: orcaOverview([]) });
    await $("#nav-orca").click();
    await $("#orca-bell").click();
    await expect($("#orca-feed")).toHaveText(expect.stringContaining("動いているエージェントはありません"));
    await expect($("#nav-orca .nav-count")).not.toBeDisplayed();
  });


  it("has the list on the left with a header of 32px level with the tab bar, the divider, and an empty work pane at the start", async () => {
    await openOrca();
    const box = await browser.execute(() => {
      const r = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        listRight: r("#orca-list").right,
        splitLeft: r("#orca-split").left,
        splitRight: r("#orca-split").right,
        workLeft: r("#orca-work").left,
        share: r("#orca-list").width / r("#orca").width,
        header: r("#orca-header").height,
        tabs: r(".orca-tabbar").height,
        tabsRight: r(".orca-tabs").right,
        barRight: r(".orca-tabbar").right,
        plusLeft: r(".orca-plus").left,
        plusRight: r(".orca-plus").right,
        plusHeight: r(".orca-plus").height,
        headerTop: r("#orca-header").top,
        tabsTop: r(".orca-tabbar").top,
        buttons: [...document.querySelectorAll("#orca-header button")].map((b) => b.getBoundingClientRect().height),
      };
    });
    expect(box.listRight).toBeLessThanOrEqual(box.splitLeft + 1);
    expect(box.splitRight).toBeLessThanOrEqual(box.workLeft + 1);
    expect(box.share).toBeCloseTo(0.25, 2);
    expect(box.header).toBe(32);
    expect(box.tabs).toBe(32);
    expect(box.tabsTop).toBe(box.headerTop);
    expect(box.buttons).toEqual([24, 24, 24]);
    // No label and no 「新規」: the button of the list (A-23) at the left, the bell and the reload at the right.
    expect(await count("#orca-heading")).toBe(0);
    expect(await count("#orca-new")).toBe(0);
    await expect($("#orca-refresh")).toHaveAttribute("aria-label", "読み直す");
    const order = await browser.execute(() => [...document.querySelectorAll("#orca-header button")].map((b) => b.id));
    expect(order).toEqual(["orca-list-toggle", "orca-bell", "orca-refresh"]);
    // The plus is in the tab bar, after the strip of tabs (the button that opens the list is before the strip, and hidden while the list is open); it is a menu button, and waits for a project.
    await expect($(".orca-plus")).toHaveAttribute("aria-label", "セッションを始める");
    await expect($(".orca-plus")).toHaveAttribute("aria-haspopup", "menu");
    await expect($(".orca-plus")).toBeDisabled();
    expect(box.plusHeight).toBe(24);
    expect(box.plusLeft).toBeGreaterThanOrEqual(box.tabsRight - 1);
    expect(box.plusRight).toBeLessThanOrEqual(box.barRight);
    const barOrder = await browser.execute(() => [...document.querySelector(".orca-tabbar")!.children].map((e) => e.className));
    expect(barOrder).toEqual(["icon-btn list-toggle", "orca-tabs", "icon-btn orca-plus", "icon-btn orca-files-toggle"]);
    // Nothing selected: no tab, no terminal, and a line that says what to do.
    expect(await count(".orca-tabs .orca-tab")).toBe(0);
    await expect($(".orca-term")).not.toBeDisplayed();
    await expect($(".orca-empty")).toHaveText("プロジェクトを選んでください");
    // No composer and no history on this screen.
    expect(await count("#orca-input")).toBe(0);
    expect(await count("#orca-chat")).toBe(0);
    expect(await callsOf("orca_chat_open")).toEqual([]);
  });

  it("selects a row with a click and shows its tab as a terminal, mirrored from this machine", async () => {
    await openWorking();
    const read = await mock("orca_terminal_read", ["$ claude", "> Write the docs"]);
    await select("example-app");
    expect(await pressed("example-app")).toBe("true");
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    await expect($(".orca-term")).toBeDisplayed();
    expect((await waitForCalls(read))[0]).toEqual({ handle: "term_example-app" });
    await browser.waitUntil(async () => (await screenText()).includes("Write the docs"), { timeoutMsg: "the screen of the session never showed" });
    // This machine has no stream, and no history is read.
    expect(await callsOf("orca_stream_terminal")).toEqual([]);
    expect(await callsOf("orca_chat_open")).toEqual([]);
    // Another row takes the selection and its terminal.
    await mock("orca_terminal_read", ["$"]);
    await select("example-lib");
    expect(await pressed("example-app")).toBe("false");
    await expect(selectedTab()).toHaveText(expect.stringContaining("Opened the pull request."));
    expect((await waitForCalls("orca_terminal_read"))[0]).toEqual({ handle: "term_example-lib" });
  });

  it("cannot select a row that has no pane", async () => {
    await openWorking();
    await expect(rowOf("example-web")).toBeDisabled();
  });

  it("says a session with no terminal has none, and reads nothing for it", async () => {
    await openWorking(orcaOverview([orcaRow("example-app", "feat/a", "Write the docs", { handle: null })], worktrees()));
    await select("example-app");
    await expect($(".orca-empty")).toHaveText("このセッションのターミナルはありません");
    await expect($(".orca-term")).not.toBeDisplayed();
    await browser.pause(1500);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
  });

  it("is enabled by a selected project, and opens a menu of 「Claude を起動」 and 「ターミナルを開く」", async () => {
    await openOrca();
    await expect($(".orca-plus")).toBeDisabled();
    await pickProject("example-api");
    await expect($(".orca-plus")).toBeEnabled();
    await pressPlus();
    expect(await textsOf('.menu[role="menu"] button')).toEqual([CLAUDE, TERMINAL]);
    // Each item draws its own icon in place of the dot.
    expect(await count('.menu[role="menu"] button svg')).toBe(2);
    expect(await count('.menu[role="menu"] .pdot')).toBe(0);
    await expect($(".orca-plus")).toHaveAttribute("aria-expanded", "true");
    // Escape closes it, and nothing was started.
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
    expect(await callsOf("orca_start")).toHaveLength(0);
    expect(await callsOf("orca_terminal_create")).toHaveLength(0);
  });

  it("starts Claude at once in the one worktree of the selected project, with no prompt and the target the screen shows", async () => {
    await openOrca();
    const start = await mock("orca_start", noPane);
    const create = await mock("orca_terminal_create", noPane);
    await plus("example-api", CLAUDE);
    // One worktree: no dialog.
    expect(await waitForCalls(start)).toEqual([{ path: "/work/example-api", environment: null }]);
    await expect($(".orca-dest-pop")).not.toExist();
    expect(await callsOf(create)).toHaveLength(0);
    // Orca named neither its pane nor its terminal: nothing can be followed, and the plus starts another.
    await expect($("#orca-started")).toHaveText("セッションを始めました。Orca の画面で開けます。");
    await expect($(".orca-plus")).toBeEnabled();
    await plus("example-app", CLAUDE);
    expect(await waitForCalls(start, 2)).toEqual([
      { path: "/work/example-api", environment: null },
      { path: "/work/example-app", environment: null },
    ]);
  });

  it("opens a terminal at once in the one worktree of the selected project, with the target the screen shows", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), studio));
    const start = await mock("orca_start", noPane);
    const create = await mock("orca_terminal_create", noPane);
    await plus("example-api", TERMINAL);
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-api", environment: "Studio" }]);
    await expect($(".orca-dest-pop")).not.toExist();
    expect(await callsOf(start)).toHaveLength(0);
    await expect($("#orca-started")).toHaveText("セッションを始めました。Orca の画面で開けます。");
  });

  it("asks which worktree when the project has several, narrowed to that project's, and starts in the one picked", async () => {
    await openOrca(orcaOverview(sample(), twoWorktrees()));
    const start = await mock("orca_start", noPane);
    const create = await mock("orca_terminal_create", noPane);
    await plus("example-app", CLAUDE);
    const pop = $(".orca-dest-pop");
    await expect(pop).toBeDisplayed();
    // Only the worktrees of the selected project, not example-api's.
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-app", "example-app"]);
    expect(await textsOf(".orca-dest-pop button span")).toEqual(["feat/a", "feat/b"]);
    expect(await callsOf(start)).toHaveLength(0);
    await $('.orca-dest-pop button[data-path="/work/example-app-b"]').click();
    await expect(pop).not.toExist();
    expect(await waitForCalls(start)).toEqual([{ path: "/work/example-app-b", environment: null }]);
    expect(await callsOf(create)).toHaveLength(0);
    // The same dialog serves the terminal.
    await plusIn("example-app", TERMINAL, "/work/example-app");
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-app", environment: null }]);
  });

  it("narrows the worktrees of the plus with a filter, in two-line rows", async () => {
    await openOrca(orcaOverview(sample(), twoWorktrees()));
    await plus("example-app", CLAUDE);
    const pop = $(".orca-dest-pop");
    await expect(pop).toHaveAttribute("role", "dialog");
    const filter = $('.orca-dest-pop input[aria-label="worktree を絞り込む"]');
    await expect(filter).toBeFocused();
    // A row has the repository on its first line and the branch on its second.
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-app", "example-app"]);
    expect(await textsOf(".orca-dest-pop button span")).toEqual(["feat/a", "feat/b"]);
    // Case-insensitive, on `{repo} ・ {branch}`.
    await filter.setValue("B");
    expect(await textsOf(".orca-dest-pop button span")).toEqual(["feat/b"]);
    await filter.setValue("app ・ FEAT/A");
    expect(await textsOf(".orca-dest-pop button span")).toEqual(["feat/a"]);
    await filter.setValue("zzz");
    await expect(pop).toHaveText(expect.stringContaining("該当する worktree がありません"));
    expect(await textsOf(".orca-dest-pop button")).toEqual([]);
  });

  it("starts at once in the one worktree of the selected SSH host, with the target the screen shows", async () => {
    const hostRow = { key: "ssh:s1", name: "s1", status: "idle" as const, sessions: 0, atMs: 0 };
    const hostTree = orcaWorktree("remote-app", "main", { path: "/home/dev/remote-app", projectKey: "ssh:s1" });
    await openOrca(orcaOverview(sample(), [...worktrees(), hostTree], { ssh: [orcaSsh("s1", "example-host")], hosts: [hostRow], ...studio }));
    const start = await mock("orca_start", noPane);
    await $('#orca-feed .orca-project[data-key="ssh:s1"]').click();
    await pressPlus();
    await pickItem(CLAUDE);
    expect(await waitForCalls(start)).toEqual([{ path: "/home/dev/remote-app", environment: "Studio" }]);
    await expect($(".orca-dest-pop")).not.toExist();
  });

  it("asks among an SSH host's worktrees when it has several, and says so when a host has none", async () => {
    const hostRow = { key: "ssh:s1", name: "s1", status: "idle" as const, sessions: 0, atMs: 0 };
    const hostTrees = [orcaWorktree("remote-app", "main", { path: "/home/dev/a", projectKey: "ssh:s1" }), orcaWorktree("remote-lib", "dev", { path: "/home/dev/b", projectKey: "ssh:s1" })];
    await openOrca(orcaOverview(sample(), [...worktrees(), ...hostTrees], { ssh: [orcaSsh("s1", "example-host"), orcaSsh("s2", "idle-host")], hosts: [hostRow] }));
    const create = await mock("orca_terminal_create", noPane);
    await $('#orca-feed .orca-project[data-key="ssh:s1"]').click();
    await pressPlus();
    await pickItem(TERMINAL);
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["remote-app", "remote-lib"]);
    await $('.orca-dest-pop button[data-path="/home/dev/b"]').click();
    expect(await waitForCalls(create)).toEqual([{ path: "/home/dev/b", environment: null }]);
    // A host with no worktree: the dialog says there is none, and nothing starts.
    await $('#orca-feed .orca-project[data-key="ssh:s2"]').click();
    await expect($(".orca-plus")).toBeEnabled();
    await pressPlus();
    await pickItem(CLAUDE);
    await expect($(".orca-dest-pop")).toHaveText(expect.stringContaining("該当する worktree がありません"));
    expect(await callsOf("orca_start")).toHaveLength(0);
    expect(await callsOf(create)).toHaveLength(1);
  });

  it("shows the message when a launch or a new terminal fails, keeps the selection, and can be pressed again", async () => {
    await openOrca();
    const start = await mock("orca_start", rejects("Worktree not found"));
    await plus("example-app", CLAUDE);
    await waitForCalls(start);
    await expect($("#error")).toHaveText("Worktree not found");
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($(".orca-plus")).toBeEnabled();
    await expect($('#orca-feed .orca-project[data-key="proj_example-app"]')).toHaveAttribute("aria-pressed", "true");
    const create = await mock("orca_terminal_create", rejects("起動先の worktree が見つかりません。一覧を読み直してください"));
    await pressPlus();
    await pickItem(TERMINAL);
    await waitForCalls(create);
    await expect($("#error")).toHaveText("起動先の worktree が見つかりません。一覧を読み直してください");
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($(".orca-plus")).toBeEnabled();
  });

  it("disables the plus while a launch or a new terminal is on its way", async () => {
    await openOrca();
    const start = await mock("orca_start", holds);
    await plus("example-app", CLAUDE);
    await waitForCalls(start);
    await expect($(".orca-plus")).toBeDisabled();
    await release(start, noPane);
    await expect($(".orca-plus")).toBeEnabled();
    expect(await callsOf(start)).toHaveLength(1);
    const create = await mock("orca_terminal_create", holds);
    await pressPlus();
    await pickItem(TERMINAL);
    await waitForCalls(create);
    await expect($(".orca-plus")).toBeDisabled();
    await release(create, noPane);
    await expect($(".orca-plus")).toBeEnabled();
    expect(await callsOf(create)).toHaveLength(1);
  });

  it("follows the session it started: keeps the selection, waits for its row, starts no second one meanwhile, then selects its tab and shows its terminal", async () => {
    await openOrca();
    const start = await mock("orca_start", reply);
    // The read after the launch does not hold the session yet.
    await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await plus("example-api", CLAUDE);
    await waitForCalls(start);
    await expect($("#orca-started")).toHaveText("セッションを始めました。一覧に現れるのを待っています…");
    await expect($(".orca-plus")).toBeDisabled();
    // The project stays selected while the session is waited for.
    await expect($('#orca-feed .orca-project[data-key="proj_example-api"]')).toHaveAttribute("aria-pressed", "true");
    // The row appears in a later read: its project and tab are selected, and its terminal shows.
    const read = await mock("orca_terminal_read", ["$"]);
    await mock("orca_overview", orcaOverview([...sample(), startedRow()], worktrees()));
    await $("#orca-refresh").click();
    expect((await waitForCalls(read))[0]).toEqual({ handle: "term_new" });
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($('#orca-feed .orca-project[data-key="proj_example-api"]')).toHaveAttribute("aria-pressed", "true");
    await expect($('.orca-tabs [data-tab="claude:tab_new:leaf_1"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await expect($(".orca-plus")).toBeEnabled();
    expect(await callsOf(start)).toHaveLength(1);
  });

  it("finds the row of the session it started by the handle when the launch gave no pane key", async () => {
    await openOrca();
    const start = await mock("orca_start", { paneKey: null, handle: "term_new" } satisfies OrcaStarted);
    await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await plus("example-api", CLAUDE);
    await waitForCalls(start);
    await expect($("#orca-started")).toHaveText("セッションを始めました。一覧に現れるのを待っています…");
    await mock("orca_overview", orcaOverview([...sample(), startedRow()], worktrees()));
    await $("#orca-refresh").click();
    await expect($('.orca-tabs [data-tab="claude:tab_new:leaf_1"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#orca-started")).not.toBeDisplayed();
  });

  it("follows the terminal it opened: waits for its tab, then selects it and mirrors it", async () => {
    await openOrca();
    const create = await mock("orca_terminal_create", created);
    await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await plus("example-api", TERMINAL);
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-api", environment: null }]);
    await expect($("#orca-started")).toHaveText("セッションを始めました。一覧に現れるのを待っています…");
    await expect($(".orca-plus")).toBeDisabled();
    // The terminal appears in a later read: it is a plain terminal, so its tab is selected and its screen shows.
    const read = await mock("orca_terminal_read", ["$ pwd"]);
    await mock("orca_overview", orcaOverview(sample(), worktrees(), { terminals: [createdTerminal()] }));
    await $("#orca-refresh").click();
    expect((await waitForCalls(read))[0]).toEqual({ handle: "term_new_sh" });
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($('#orca-feed .orca-project[data-key="proj_example-api"]')).toHaveAttribute("aria-pressed", "true");
    await expect($('.orca-tabs [data-tab="orca:term_new_sh"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await expect($(".orca-plus")).toBeEnabled();
    expect(await callsOf(create)).toHaveLength(1);
  });

  it("selects the terminal it opened in a saved environment from the streamed list", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), studio));
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(sample(), worktrees()));
    const create = await mock("orca_terminal_create", created);
    await plus("example-api", TERMINAL);
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-api", environment: "Studio" }]);
    await expect($("#orca-started")).toHaveText("セッションを始めました。一覧に現れるのを待っています…");
    await sendStream(streamList(sample(), worktrees(), [createdTerminal()]));
    await expect($('.orca-tabs [data-tab="orca:term_new_sh"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#orca-started")).not.toBeDisplayed();
  });

  it("selects the terminal of a saved environment that the streamed list held before the reply came", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), studio));
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(sample(), worktrees()));
    const create = await mock("orca_terminal_create", holds);
    await plus("example-api", TERMINAL);
    await waitForCalls(create);
    // The list with the new terminal comes first, and no event comes after the reply.
    await sendStream(streamList(sample(), worktrees(), [createdTerminal()]));
    await release(create, created);
    await expect($('.orca-tabs [data-tab="orca:term_new_sh"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($(".orca-plus")).toBeEnabled();
  });

  it("drops the wait for a terminal of a saved environment after 30 seconds, with no streamed list", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), studio));
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(sample(), worktrees()));
    const create = await mock("orca_terminal_create", created);
    await plus("example-api", TERMINAL);
    await waitForCalls(create);
    await expect($("#orca-started")).toBeDisplayed();
    await expect($(".orca-plus")).toBeDisabled();
    const later = new Date(Date.now() + 31_000);
    await setClock(`${isoDate(later)}T${later.toTimeString().slice(0, 8)}`);
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($(".orca-plus")).toBeEnabled();
  });

  it("drops the wait when the user selects another project", async () => {
    await openOrca();
    const start = await mock("orca_start", reply);
    await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await plus("example-api", CLAUDE);
    await waitForCalls(start);
    await expect($("#orca-started")).toBeDisplayed();
    // Choosing a project drops the wait, and a row that appears later does not take the selection.
    await $('#orca-feed .orca-project[data-key="proj_example-app"]').click();
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($(".orca-plus")).toBeEnabled();
    await mock("orca_overview", orcaOverview([...sample(), startedRow()], worktrees()));
    await $("#orca-refresh").click();
    await waitForCalls("orca_overview");
    await expect($('#orca-feed .orca-project[data-key="proj_example-app"]')).toHaveAttribute("aria-pressed", "true");
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
  });

  it("does not follow a start when the user selected another project while it was on its way", async () => {
    await openOrca();
    const create = await mock("orca_terminal_create", holds);
    await plus("example-api", TERMINAL);
    await waitForCalls(create);
    await $('#orca-feed .orca-project[data-key="proj_example-app"]').click();
    await release(create, created);
    await expect($(".orca-plus")).toBeEnabled();
    await expect($("#orca-started")).not.toBeDisplayed();
    await mock("orca_overview", orcaOverview(sample(), worktrees(), { terminals: [createdTerminal()] }));
    await $("#orca-refresh").click();
    await waitForCalls("orca_overview");
    await expect($('#orca-feed .orca-project[data-key="proj_example-app"]')).toHaveAttribute("aria-pressed", "true");
  });

  it("says the command is missing, and does not read again by the clock", async () => {
    // The base answer is the one with no orca command.
    await boot({ inbox: inbox() });
    await $("#nav-orca").click();
    await expect($("#orca-status")).toHaveText("未インストール");
    expect(await classOf("#orca-status")).toContain("off");
    await expect($("#orca-notice")).toHaveText(expect.stringContaining("orca コマンドが見つかりません"));
    await expect($(".orca-plus")).toBeDisabled();
    // The start and showing the screen read; the clock (every 10 seconds on this screen) reads no more.
    const before = (await callsOf("orca_overview")).length;
    await browser.pause(12_000);
    expect(await callsOf("orca_overview")).toHaveLength(before);
    // The reload button looks again.
    await $("#orca-refresh").click();
    await waitForCalls("orca_overview", before + 1);
  });

  it("shows a failed read in orange with the message, and keeps the rows it had", async () => {
    await openWorking();
    expect(await rowTexts(".orca-prompt")).toHaveLength(4);
    await mock("orca_overview", orcaOverview([], [], { state: "failed", message: "Orca is not running", environments: [] }));
    await $("#orca-refresh").click();
    await expect($("#orca-status")).toHaveText("このマシン に接続できません");
    expect(await classOf("#orca-status")).toContain("warn");
    await expect($("#orca-notice")).toHaveText("読み込めませんでした: Orca is not running");
    expect(await rowTexts(".orca-prompt")).toHaveLength(4);
  });

  it("makes the label a menu of the targets once an environment is saved, and a change drops the selection", async () => {
    await openWorking(orcaOverview(sample(), worktrees(), studio));
    await expect($("#orca-target")).toHaveText("Studio に接続中");
    await expect($("#orca-status")).not.toBeDisplayed();
    // A launch names the target the screen shows.
    const start = await mock("orca_start", noPane);
    await select("example-app");
    await pressPlus();
    await pickItem(CLAUDE);
    expect(await waitForCalls(start)).toEqual([{ path: "/work/example-app", environment: "Studio" }]);
    await $("#orca-target").click();
    expect(await textsOf(".menu button")).toEqual(["このマシン", "Studio", "Lab"]);
    const save = await mock("orca_set_target", null);
    const overview = await mock("orca_overview", orcaOverview([orcaRow("lab-app", "main", "Lab task")], [], { target: null, environments: ["Studio", "Lab"] }));
    await pickMenu("このマシン");
    expect(await waitForCalls(save)).toEqual([{ environment: null }]);
    await waitForCalls(overview);
    await expect($("#orca-target")).toHaveText("このマシン に接続中");
    // The sessions of the old target are gone, with the selection, and the stream of the old target ends.
    await waitForCount("#orca-feed .orca-row", 1);
    await expect($(".orca-empty")).toHaveText("プロジェクトを選んでください");
    await waitForCalls("orca_stream_close");
  });

  it("keeps the selection through a read in the background, and does not start the terminal again", async () => {
    await openWorking();
    await mock("orca_terminal_read", ["$ first frame"]);
    await select("example-app");
    await browser.waitUntil(async () => (await screenText()).includes("first frame"), { timeoutMsg: "the first frame never showed" });
    await browser.execute(() => document.querySelector(".orca-term .orca-term-box:not([hidden])")!.setAttribute("data-mark", "same"));
    // The clock reads again within 10 seconds (the first read of this screen was at its opening).
    const overview = await mock("orca_overview", orcaOverview([...sample(), orcaRow("example-new", "main", "Fresh", { minutes: 1 })], worktrees()));
    await waitForCalls(overview);
    await waitForCount("#orca-feed .orca-row", 5);
    expect(await pressed("example-app")).toBe("true");
    await expect($("#orca")).toBeDisplayed();
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    await expect($('.orca-term .orca-term-box[data-mark="same"]')).toBeDisplayed();
  });

  it("drops the tab of a session that is gone, with its terminal", async () => {
    await openWorking();
    await select("example-app");
    await expect($(".orca-term")).toBeDisplayed();
    await mock("orca_overview", orcaOverview([orcaRow("example-api", "main", "Fix the parser")], worktrees()));
    await $("#orca-refresh").click();
    await waitForCount("#orca-feed .orca-row", 1);
    // The project is still selected, with no session left in it.
    await expect($(".orca-empty")).toHaveText("セッションはありません");
    expect(await count(".orca-tabs .orca-tab")).toBe(0);
    await expect($(".orca-term")).not.toBeDisplayed();
    expect(await count(".orca-term .orca-term-box")).toBe(0);
  });

  it("reads everything when the screen is shown or reloaded, and the clock only the agents of this machine", async () => {
    await openOrca();
    const scopes = async () => (await callsOf("orca_overview")).map((c) => (c as { scope: string }).scope);
    // The first read and showing the screen.
    expect(await scopes()).toEqual(["full", "full"]);
    // The clock, within 10 seconds on this screen.
    const overview = await mock("orca_overview", orcaOverview(sample(), worktrees()));
    expect(await waitForCalls(overview)).toEqual([{ scope: "screen", target: null }]);
    await $("#orca-refresh").click();
    expect(await waitForCalls(overview, 2)).toEqual([
      { scope: "screen", target: null },
      { scope: "full", target: null },
    ]);
  });

  it("says nothing about a new target until its first read comes back, and keeps the menu", async () => {
    await openWorking(orcaOverview(sample(), worktrees(), studio));
    await mock("orca_set_target", null);
    const overview = await mock("orca_overview", holds);
    await $("#orca-target").click();
    await pickMenu("このマシン");
    await waitForCalls(overview);
    await expect($("#orca-target")).toHaveText("確認中");
    await expect($("#orca-feed")).toHaveText(expect.stringContaining("読み込んでいます"));
    expect((await textsOf("#orca-feed"))[0]).not.toContain("動いているエージェントはありません");
    await $("#orca-target").click();
    expect(await textsOf(".menu button")).toEqual(["このマシン", "Studio", "Lab"]);
    await release(overview, orcaOverview([orcaRow("lab-app", "main", "Lab task")], [], { environments: ["Studio", "Lab"] }));
    await expect($("#orca-target")).toHaveText("このマシン に接続中");
    await waitForCount("#orca-feed .orca-row", 1);
  });

  it("keeps the target, the environments and the rows when the environments cannot be read", async () => {
    await openWorking(orcaOverview(sample(), worktrees(), studio));
    await mock("orca_overview", orcaOverview([], [], { state: "failed", message: "Orca is busy", known: false }));
    await $("#orca-refresh").click();
    await expect($("#orca-target")).toHaveText("Studio に接続できません");
    await expect($("#orca-notice")).toHaveText("読み込めませんでした: Orca is busy");
    expect(await rowTexts(".orca-prompt")).toHaveLength(4);
    await $("#orca-target").click();
    expect(await textsOf(".menu button")).toEqual(["このマシン", "Studio", "Lab"]);
  });

  it("does not pick another target for a saved one that is gone, and lets the owner choose again", async () => {
    await openOrca(orcaOverview([], [], { state: "failed", message: "保存した接続先が見つかりません", target: "Gone", environments: ["Studio"] }));
    await expect($("#orca-target")).toHaveText("Gone に接続できません");
    await expect($("#orca-notice")).toHaveText("読み込めませんでした: 保存した接続先が見つかりません");
    // A target that is not listed is not streamed.
    expect(await callsOf("orca_stream_open")).toEqual([]);
    const save = await mock("orca_set_target", null);
    await mock("orca_overview", orcaOverview([orcaRow("lab-app", "main", "Task")], [], { target: "Studio", environments: ["Studio"] }));
    await $("#orca-target").click();
    expect(await textsOf(".menu button")).toEqual(["このマシン", "Studio"]);
    await pickMenu("Studio");
    expect(await waitForCalls(save)).toEqual([{ environment: "Studio" }]);
    await expect($("#orca-target")).toHaveText("Studio に接続中");
  });
});

// A-23: the list of projects is closed and opened by a button. Where the button is, what hides with the list, and the width the work pane takes.
describe("orca: closing the list (A-23)", () => {
  const rect = (selector: string) => browser.execute((q) => {
    const r = document.querySelector(q)!.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width };
  }, selector);

  it("has the button first in the header of the list, open, with the bell and the reload kept at the right", async () => {
    await openOrca();
    const button = $("#orca-list-toggle");
    await expect(button).toBeDisplayed();
    await expect(button).toHaveAttribute("aria-label", "プロジェクト一覧");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await classOf("#orca-list-toggle")).toContain("icon-btn");
    const [toggle, bell, refresh, header] = await Promise.all(["#orca-list-toggle", "#orca-bell", "#orca-refresh", "#orca-header"].map(rect));
    // At the left end of the header, and the bell and the reload at the right end, as before.
    expect(toggle.left - header.left).toBeLessThan(10);
    expect(toggle.right).toBeLessThan(bell.left);
    expect(header.right - refresh.right).toBeLessThan(10);
    // The button of the tab strip is for the closed list only.
    await expect($(".orca-tabbar .list-toggle")).not.toBeDisplayed();
  });

  it("closes the list with its divider and the bell and the reload, widens the work pane, and opens the list again at the width it had", async () => {
    await openOrca();
    await dragDivider(0.4);
    const before = await rect("#orca-list");
    expect(before.width / (await rect("#orca")).width).toBeCloseTo(0.4, 2);
    await $("#orca-list-toggle").click();
    await expect($("#orca-list")).not.toBeDisplayed();
    await expect($("#orca-split")).not.toBeDisplayed();
    await expect($("#orca-bell")).not.toBeDisplayed();
    await expect($("#orca-refresh")).not.toBeDisplayed();
    // The work pane takes the width up to the green column.
    const [screen, work] = await Promise.all(["#orca", "#orca-work"].map(rect));
    expect(work.left).toBeCloseTo(screen.left, 0);
    // The button is now at the left end of the tab strip of the pane at the left edge.
    const closed = $(".orca-tabbar .list-toggle");
    await expect(closed).toBeDisplayed();
    await expect(closed).toHaveAttribute("aria-expanded", "false");
    await expect(closed).toHaveAttribute("aria-label", "プロジェクト一覧");
    const [button, tabs, bar] = await Promise.all([".orca-tabbar .list-toggle", ".orca-tabs", ".orca-tabbar"].map(rect));
    expect(button.left).toBeGreaterThanOrEqual(bar.left);
    expect(button.right).toBeLessThanOrEqual(tabs.left + 1);
    expect(await browser.execute(() => document.querySelector(".orca-tabbar")!.firstElementChild!.classList.contains("list-toggle"))).toBe(true);
    await expect(closed).not.toHaveAttribute("data-tauri-drag-region");
    // The green column stays.
    await expect($("#sidebar")).toBeDisplayed();
    await closed.click();
    await expect($("#orca-list")).toBeDisplayed();
    await expect($("#orca-split")).toBeDisplayed();
    await expect($("#orca-bell")).toBeDisplayed();
    await expect($("#orca-refresh")).toBeDisplayed();
    await expect($("#orca-list-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect($(".orca-tabbar .list-toggle")).not.toBeDisplayed();
    expect((await rect("#orca-list")).width).toBeCloseTo(before.width, 0);
    await expect($("#orca-split")).toHaveAttribute("aria-valuenow", "40");
  });

  it("keeps the list closed while the screen is left and shown again, and opens it again when the app starts", async () => {
    await openOrca();
    await $("#orca-list-toggle").click();
    await expect($("#orca-list")).not.toBeDisplayed();
    await $("#nav-mail").click();
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await expect($("#orca-list")).not.toBeDisplayed();
    // Nothing is saved: a start gives the open list.
    await openOrca();
    await expect($("#orca-list")).toBeDisplayed();
    await expect($("#orca-list-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("gives the focus to the button that is shown after a press", async () => {
    await openOrca();
    await $("#orca-list-toggle").click();
    await browser.execute(() => document.querySelector<HTMLElement>(".orca-tabbar .list-toggle")!.focus());
    // The harness's synthesized Enter does not run the default action of a button (the keydown and keyup come, the keypress does not), so the focused button is clicked, as the keyboard would.
    await browser.execute(() => (document.activeElement as HTMLElement).click());
    await expect($("#orca-list")).toBeDisplayed();
    expect(await browser.execute(() => document.activeElement?.id)).toBe("orca-list-toggle");
    await browser.execute(() => (document.activeElement as HTMLElement).click());
    await expect($("#orca-list")).not.toBeDisplayed();
    expect(await browser.execute(() => document.activeElement?.classList.contains("list-toggle"))).toBe(true);
  });
});

describe("orca: the divider", () => {
  // The list pane's share of #orca.
  const share = () => browser.execute(() => document.getElementById("orca-list")!.getBoundingClientRect().width / document.getElementById("orca")!.getBoundingClientRect().width);
  const drag = dragDivider;
  const press = (key: string) =>
    browser.execute(
      (id, k) => window.__e2e_once__(id) && document.getElementById("orca-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })),
      onceId(),
      key,
    );

  it("is a vertical separator that starts at 25%", async () => {
    await openOrca();
    const split = $("#orca-split");
    await expect(split).toHaveAttribute("role", "separator");
    await expect(split).toHaveAttribute("aria-orientation", "vertical");
    await expect(split).toHaveAttribute("tabindex", "0");
    await expect(split).toHaveAttribute("aria-valuemin", "20");
    await expect(split).toHaveAttribute("aria-valuemax", "50");
    await expect(split).toHaveAttribute("aria-valuenow", "25");
    expect(await share()).toBeCloseTo(0.25, 2);
  });

  it("sets the list width by dragging, and keeps it between 20% and 50% however far it is dragged", async () => {
    await openOrca();
    await drag(0.4);
    expect(await share()).toBeCloseTo(0.4, 2);
    await expect($("#orca-split")).toHaveAttribute("aria-valuenow", "40");
    await drag(0.95);
    expect(await share()).toBeCloseTo(0.5, 2);
    await expect($("#orca-split")).toHaveAttribute("aria-valuenow", "50");
    await drag(0.01);
    expect(await share()).toBeCloseTo(0.2, 2);
    await expect($("#orca-split")).toHaveAttribute("aria-valuenow", "20");
  });

  it("is moved with the arrow keys inside the same range, and keeps its width when the screen is left and opened again", async () => {
    await openOrca();
    await press("ArrowRight");
    await press("ArrowRight");
    expect(await share()).toBeCloseTo(0.29, 2);
    for (let i = 0; i < 20; i++) await press("ArrowRight");
    expect(await share()).toBeCloseTo(0.5, 2);
    for (let i = 0; i < 30; i++) await press("ArrowLeft");
    expect(await share()).toBeCloseTo(0.2, 2);
    await press("ArrowRight");
    const widened = await share();
    await $("#nav-mail").click();
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    expect(await share()).toBeCloseTo(widened, 2);
  });
});

describe("orca: projects", () => {
  const hostRow = { key: "ssh:s1", name: "s1", status: "working" as const, sessions: 2, atMs: 0 };
  const withTerminals = () =>
    orcaOverview(sample(), [...worktrees(), orcaWorktree("example-idle", "main")], {
      terminals: [orcaTerminal("example-app", "zsh")],
      ssh: [orcaSsh("s1", "example-host"), orcaSsh("s2", "other-host")],
      hosts: [hostRow],
    });
  const projectNames = () => textsOf("#orca-feed .orca-project-name");
  const projectStatuses = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-project .orca-ic")].map((i) => i.dataset.status));

  it("starts with the projects: a status icon, the name and the number of sessions, then the SSH hosts", async () => {
    await openOrca(withTerminals());
    await expect($("#orca-bell")).toHaveAttribute("aria-pressed", "false");
    // The working projects come first (example-app, example-web), then the rest as the read lists them.
    expect(await projectNames()).toEqual(["example-app", "example-web", "example-api", "example-lib", "example-idle", "example-host", "other-host"]);
    // example-app has a running agent and a shell, example-api a waiting agent, example-lib a done one, example-idle nothing; the SSH host shows what its worktrees do.
    expect(await projectStatuses()).toEqual(["working", "working", "question", "done", "idle", "working", "idle"]);
    expect(await textsOf("#orca-feed .orca-n")).toEqual(["2", "1", "1", "1", "2"]);
    expect(await textsOf("#orca-feed .orca-sec")).toEqual(["SSH"]);
    await expect($("#orca-feed .orca-row")).not.toExist();
    // The status label is at the bottom of the list pane, under the list.
    const place = await browser.execute(() => {
      const r = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { listBottom: r("#orca-list").bottom, feedBottom: r("#orca-feed").bottom, statusTop: r("#orca-status").top, statusBottom: r("#orca-status").bottom };
    });
    expect(place.statusTop).toBeGreaterThanOrEqual(place.feedBottom - 1);
    expect(place.statusBottom).toBeLessThanOrEqual(place.listBottom + 1);
  });

  it("puts the stopped projects (a session, not working) under the working ones and above those with no session, each group in the order of the read", async () => {
    const overview = withTerminals();
    const byName = (name: string) => overview.projects.find((p) => p.name === name)!;
    // The read lists a project with no session before the stopped ones (example-api waits, example-lib is done), and the working one last.
    await openOrca({ ...overview, projects: [byName("example-idle"), byName("example-api"), byName("example-lib"), byName("example-app"), byName("example-web")] });
    expect(await projectNames()).toEqual(["example-app", "example-web", "example-api", "example-lib", "example-idle", "example-host", "other-host"]);
  });

  it("lists an SSH host of the target that this machine does not list, under SSH", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { ssh: [orcaSsh("s1", "example-host")], hosts: [{ key: "ssh:s9", name: "lost-host", status: "working", sessions: 1, atMs: 0 }] }));
    expect(await projectNames()).toEqual(["example-app", "example-web", "example-api", "example-lib", "example-host", "lost-host"]);
    expect(await textsOf("#orca-feed .orca-sec")).toEqual(["SSH"]);
    expect(await projectStatuses()).toEqual(["working", "working", "question", "done", "idle", "working"]);
    // Its row is a project like the others: it can be selected.
    await project("lost-host").click();
    await expect(project("lost-host")).toHaveAttribute("aria-pressed", "true");
    await expect($(".orca-empty")).toHaveText("セッションはありません");
  });

  it("does not draw the list again when only the time of activity of a project moved", async () => {
    await openOrca(withTerminals());
    await browser.execute(() => document.querySelector("#orca-feed .orca-project")!.setAttribute("data-marker", "kept"));
    const overview = await mock("orca_overview", { ...withTerminals(), projects: withTerminals().projects.map((p) => ({ ...p, atMs: 99_000 })) });
    await $("#orca-refresh").click();
    await waitForCalls(overview);
    await browser.pause(500);
    await expect($('#orca-feed .orca-project[data-marker="kept"]')).toExist();
  });

  it("says so when there is no project", async () => {
    await openOrca(orcaOverview([]));
    await expect($("#orca-feed")).toHaveText(expect.stringContaining("プロジェクトがありません"));
  });

  it("draws the icon of each status of Orca", async () => {
    const statuses = ["question", "working", "monitoring", "failed", "interrupted", "done"] as const;
    await openWorking(orcaOverview(statuses.map((status, i) => orcaRow(`example-${status}`, "main", `Task ${i}`, { status, group: status === "question" ? "waiting" : status === "done" ? "done" : "working" })), []));
    const icons = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-row .orca-ic")].map((i) => [i.dataset.status, i.getAttribute("aria-label")]));
    expect(icons).toEqual([
      ["question", "入力待ち"],
      ["working", "作業中"],
      ["monitoring", "監視中"],
      ["failed", "失敗"],
      ["interrupted", "中断"],
      ["done", "完了"],
    ]);
    // The ring turns.
    const ring = await browser.execute(() => getComputedStyle(document.querySelector("#orca-feed .orca-mark.working")!).animationName);
    expect(ring).toBe("spin");
  });

  it("switches between the projects and the working agents with the bell, with no heading", async () => {
    await openOrca();
    await expect($("#orca-bell")).toHaveAttribute("aria-label", "作業中を表示する");
    await $("#orca-bell").click();
    await expect($("#orca-bell")).toHaveAttribute("aria-pressed", "true");
    await expect($("#orca-bell")).toHaveAttribute("aria-label", "作業中の表示をやめる");
    await waitForCount("#orca-feed .orca-row", 4);
    await expect($("#orca-feed .orca-project")).not.toExist();
    expect((await textsOf("#orca-header"))[0]).not.toContain("プロジェクト");
    await $("#orca-bell").click();
    await expect($("#orca-bell")).toHaveAttribute("aria-pressed", "false");
    await waitForCount("#orca-feed .orca-project", 4);
    await expect($("#orca-feed .orca-row")).not.toExist();
  });

  it("shows at the bell the question icon with the number of agents that wait, else the working mark with the number that work, else nothing", async () => {
    await openOrca();
    const badge = () => browser.execute(() => ({ hidden: document.getElementById("orca-bell-badge")!.hidden, kind: document.getElementById("orca-bell-badge")!.dataset.kind, text: document.getElementById("orca-bell-badge")!.textContent, icon: document.querySelector<HTMLElement>("#orca-bell-badge .orca-ic")?.dataset.status }));
    expect(await badge()).toEqual({ hidden: false, kind: "question", text: "1", icon: "question" });
    await mock("orca_overview", orcaOverview([orcaRow("example-app", "feat/a", "Write the docs"), orcaRow("example-web", "dev", "Update the page"), orcaRow("example-lib", "main", "Done", { group: "done" })], worktrees()));
    await $("#orca-refresh").click();
    await browser.waitUntil(async () => (await badge()).kind === "working", { timeoutMsg: "the bell never showed the working count" });
    expect(await badge()).toEqual({ hidden: false, kind: "working", text: "2", icon: "working" });
    await mock("orca_overview", orcaOverview([orcaRow("example-lib", "main", "Done", { group: "done" })], worktrees()));
    await $("#orca-refresh").click();
    await browser.waitUntil(async () => (await badge()).hidden, { timeoutMsg: "the bell never lost its badge" });
  });

  it("shows the sessions of a selected project as tabs of one line, selects the first, and goes back to the one last selected", async () => {
    await openOrca(withTerminals());
    const read = await mock("orca_terminal_read", ["$ ls"]);
    await project("example-app").click();
    await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
    // The Claude session first, then the shell of Orca; a tab has its title only.
    expect(await tabTitles()).toEqual(["Write the docs", "zsh"]);
    expect(await count(".orca-tabs .orca-tab-sub")).toBe(0);
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".orca-tabs .orca-ic")].map((i) => [i.dataset.status, i.getAttribute("aria-label")]))).toEqual([
      ["working", "作業中"],
      ["done", "起動中"],
    ]);
    // A Claude session is a terminal too.
    await expect($(".orca-term")).toBeDisplayed();
    expect((await waitForCalls(read))[0]).toEqual({ handle: "term_example-app" });
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    await expect($(".orca-term")).toBeDisplayed();
    await project("example-api").click();
    await expect(selectedTab()).toHaveText(expect.stringContaining("Fix the parser"));
    await project("example-app").click();
    await expect(selectedTab()).toHaveText(expect.stringContaining("zsh"));
  });

  // Where the last tab, the plus and the bar end, and whether the strip of tabs scrolls.
  const edges = () =>
    browser.execute(() => {
      const r = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const lastTab = [...document.querySelectorAll(".orca-tabs .orca-tab")].pop()!.getBoundingClientRect();
      const tabs = document.querySelector(".orca-tabs")!;
      // The right end of the room of the strip and the plus: the button of the file pane (A-18) when the bar has it, else the bar's edge.
      const toggle = document.querySelector(".orca-tabbar .orca-files-toggle:not([hidden])");
      return { lastRight: lastTab.right, plusLeft: r(".orca-plus").left, plusRight: r(".orca-plus").right, barRight: toggle ? toggle.getBoundingClientRect().left : r(".orca-tabbar").right, scrolls: tabs.scrollWidth > tabs.clientWidth };
    });

  it("puts the plus right after the last tab", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "zsh")] }));
    await project("example-app").click();
    await expect(selectedTab()).toBeDisplayed();
    const one = await edges();
    expect(one.scrolls).toBe(false);
    expect(one.plusLeft - one.lastRight).toBeLessThanOrEqual(8);
    expect(one.plusLeft).toBeGreaterThanOrEqual(one.lastRight);
  });

  it("keeps the plus in view at the right end of the bar when the tabs overflow", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { terminals: Array.from({ length: 30 }, (_, i) => orcaTerminal("example-app", `terminal-with-a-long-name-${i}`)) }));
    await project("example-app").click();
    await expect(selectedTab()).toBeDisplayed();
    const many = await edges();
    expect(many.scrolls).toBe(true);
    expect(many.plusRight).toBeLessThanOrEqual(many.barRight);
    expect(many.barRight - many.plusRight).toBeLessThanOrEqual(8);
    await expect($(".orca-plus")).toBeDisplayed();
  });

  it("says a project has no session, with the tab strip empty", async () => {
    await openOrca(withTerminals());
    await project("example-idle").click();
    await expect($(".orca-empty")).toBeDisplayed();
    await expect($(".orca-empty")).toHaveText("セッションはありません");
    await expect($(".orca-tabs")).toBeDisplayed();
    expect(await count(".orca-tabs .orca-tab")).toBe(0);
    await expect($(".orca-term")).not.toBeDisplayed();
  });

  it("selects the project and the tab of a row of the working view, and keeps the order of the tabs through a read", async () => {
    await openWorking(withTerminals());
    await select("example-app");
    expect(await tabTitles()).toEqual(["Write the docs", "zsh"]);
    await $("#orca-bell").click();
    await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
    // A read that lists the new terminal before the old one does not move the tabs: they stay in the order they were first seen.
    await mock("orca_overview", orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "bash"), orcaTerminal("example-app", "zsh")] }));
    await $("#orca-refresh").click();
    await browser.waitUntil(async () => (await tabTitles()).length === 3, { timeoutMsg: "the new terminal never became a tab" });
    expect(await tabTitles()).toEqual(["Write the docs", "zsh", "bash"]);
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
  });

  describe("the groups of the working view (A-6)", () => {
    const toggle = (group: string) => $(`#orca-feed .orca-group-btn[data-key="group:${group}"]`);
    const expanded = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-group-btn")].map((b) => b.getAttribute("aria-expanded")));

    it("opens every group at first, hides the rows of a group when its heading is pressed and shows them again when it is pressed once more, keeping the heading and the number", async () => {
      await openWorking();
      expect(await expanded()).toEqual(["true", "true", "true"]);
      expect(await rowTexts(".orca-prompt")).toEqual(["Fix the parser", "Write the docs", "Update the page", "Opened the pull request."]);
      await toggle("working").click();
      await expect(toggle("working")).toHaveAttribute("aria-expanded", "false");
      expect(await expanded()).toEqual(["true", "false", "true"]);
      expect(await rowTexts(".orca-prompt")).toEqual(["Fix the parser", "Opened the pull request."]);
      // The heading and its number stay.
      expect(await groups()).toEqual(["入力待ち1", "作業中2", "完了1"]);
      await toggle("working").click();
      await expect(toggle("working")).toHaveAttribute("aria-expanded", "true");
      expect(await rowTexts(".orca-prompt")).toEqual(["Fix the parser", "Write the docs", "Update the page", "Opened the pull request."]);
    });

    // The harness's synthesized Enter and Space do not run the default action of a button (checked: neither `keys` nor `addValue` presses it), so the keyboard is checked by what makes it work: a native button that can be focused, and that keeps the focus when the list is drawn again.
    it("is a native button in the heading that a keyboard reaches, and keeps the focus when it opens or closes", async () => {
      await openWorking();
      const state = () =>
        browser.execute(() => {
          const b = document.querySelector<HTMLButtonElement>('#orca-feed .orca-group-btn[data-key="group:done"]')!;
          return [b.tagName, b.type, b.disabled, b.tabIndex, b.parentElement!.tagName];
        });
      expect(await state()).toEqual(["BUTTON", "button", false, 0, "H2"]);
      await browser.execute(() => document.querySelector<HTMLElement>('#orca-feed .orca-group-btn[data-key="group:done"]')!.focus());
      await browser.execute(() => document.querySelector<HTMLElement>('#orca-feed .orca-group-btn[data-key="group:done"]')!.click());
      await expect(toggle("done")).toHaveAttribute("aria-expanded", "false");
      await expect(toggle("done")).toBeFocused();
      await browser.execute(() => document.querySelector<HTMLElement>('#orca-feed .orca-group-btn[data-key="group:done"]')!.click());
      await expect(toggle("done")).toHaveAttribute("aria-expanded", "true");
      await expect(toggle("done")).toBeFocused();
    });
  });

  describe("the sessions under a project (A-8)", () => {
    const arrow = (repo: string) => $(`#orca-feed .orca-arrow[data-key="arrow:proj_${repo}"]`);
    const sessionTitles = () => textsOf("#orca-feed .orca-session .orca-session-title");
    const sessionOf = (id: string) => $(`#orca-feed .orca-session[data-session="${id}"]`);
    const pressedSessions = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-session")].filter((r) => r.getAttribute("aria-pressed") === "true").map((r) => r.dataset.session));

    it("puts an arrow at the left of each project that has a session tab, and none at the others (example-web's one session has no pane, and the host's number comes with no row of it), with the working project open at first and the others closed", async () => {
      await openOrca(withTerminals());
      expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-arrow")].map((a) => [a.dataset.key, a.getAttribute("aria-expanded")]))).toEqual([
        ["arrow:proj_example-app", "true"],
        ["arrow:proj_example-api", "false"],
        ["arrow:proj_example-lib", "false"],
      ]);
      expect(await sessionTitles()).toEqual(["Write the docs", "zsh"]);
      // The arrow is at the left of the row, before the status icon.
      const left = await browser.execute(() => {
        const r = (e: Element) => e.getBoundingClientRect();
        return [r(document.querySelector('.orca-arrow[data-key="arrow:proj_example-app"]')!).right, r(document.querySelector('.orca-project[data-key="proj_example-app"] .orca-ic')!).left];
      });
      expect(left[0]).toBeLessThanOrEqual(left[1]);
    });

    it("opens a project with its sessions under it without closing the others, so that several are open at once", async () => {
      await openOrca(withTerminals());
      // example-app works, so it is open at first; its sessions have the status icon and the title.
      expect(await sessionTitles()).toEqual(["Write the docs", "zsh"]);
      expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-session .orca-ic")].map((i) => [i.dataset.status, i.getAttribute("aria-label")]))).toEqual([
        ["working", "作業中"],
        ["done", "起動中"],
      ]);
      await project("example-api").click();
      await expect(arrow("example-api")).toHaveAttribute("aria-expanded", "true");
      await expect(arrow("example-app")).toHaveAttribute("aria-expanded", "true");
      expect(await sessionTitles()).toEqual(["Write the docs", "zsh", "Fix the parser"]);
      expect(await count("#orca-feed .orca-sessions")).toBe(2);
      // The arrow of a project that is not selected opens it and does not select it.
      await arrow("example-lib").click();
      await expect(arrow("example-lib")).toHaveAttribute("aria-expanded", "true");
      await expect(project("example-lib")).toHaveAttribute("aria-pressed", "false");
      await expect(project("example-api")).toHaveAttribute("aria-pressed", "true");
      expect(await sessionTitles()).toEqual(["Write the docs", "zsh", "Fix the parser", "Opened the pull request."]);
      // A session of a project that is not selected selects its project and its tab.
      await sessionOf(claudeTab("example-lib")).click();
      await expect(project("example-lib")).toHaveAttribute("aria-pressed", "true");
      expect(await pressedSessions()).toEqual([claudeTab("example-lib")]);
      await expect(selectedTab()).toHaveText(expect.stringContaining("Opened the pull request."));
    });

    it("draws a session row one level in from its project: its icon and title right of the project's name", async () => {
      await openOrca(withTerminals());
      const left = await browser.execute(() => {
        const r = (e: Element) => e.getBoundingClientRect();
        const session = document.querySelector("#orca-feed .orca-session")!;
        return {
          projectRow: r(document.querySelector('.orca-project[data-key="proj_example-app"]')!).left,
          name: r(document.querySelector('.orca-project[data-key="proj_example-app"] .orca-project-name')!).left,
          sessionRow: r(session).left,
          icon: r(session.querySelector(".orca-ic")!).left,
          title: r(session.querySelector(".orca-session-title")!).left,
        };
      });
      expect(left.sessionRow).toBeGreaterThan(left.projectRow);
      expect(left.icon).toBeGreaterThan(left.name);
      expect(left.title).toBeGreaterThan(left.name);
    });

    it("closes with the arrow of the selected project and opens again with it, keeping the tabs, the work pane and the number", async () => {
      await openOrca(withTerminals());
      await mock("orca_terminal_read", ["$ ls"]);
      await project("example-app").click();
      await expect($(".orca-term")).toBeDisplayed();
      const numbers = await textsOf("#orca-feed .orca-n");
      await arrow("example-app").click();
      await expect(arrow("example-app")).toHaveAttribute("aria-expanded", "false");
      await expect($("#orca-feed .orca-session")).not.toExist();
      await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
      expect(await tabTitles()).toEqual(["Write the docs", "zsh"]);
      await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
      await expect($(".orca-term")).toBeDisplayed();
      // The number stays a number.
      expect(await textsOf("#orca-feed .orca-n")).toEqual(numbers);
      await arrow("example-app").click();
      await expect(arrow("example-app")).toHaveAttribute("aria-expanded", "true");
      expect(await sessionTitles()).toEqual(["Write the docs", "zsh"]);
      // Pressing the closed project's row opens it too.
      await arrow("example-app").click();
      await expect($("#orca-feed .orca-session")).not.toExist();
      await project("example-app").click();
      expect(await sessionTitles()).toEqual(["Write the docs", "zsh"]);
    });

    describe("the working projects", () => {
      // A read as Orca lists it: the projects in the order given (the newest activity first), each working unless it is in `done` or `waiting`.
      const read = (order: string[], done: string[] = [], waiting: string[] = []) =>
        orcaOverview(
          order.map((repo) => orcaRow(repo, "main", `Task of ${repo}`, done.includes(repo) ? { group: "done" } : waiting.includes(repo) ? { group: "waiting" } : {})),
          order.map((repo) => orcaWorktree(repo, "main")),
        );
      const names = () => projectNames();
      const reread = async (value: ReturnType<typeof read>) => {
        const overview = await mock("orca_overview", value);
        await $("#orca-refresh").click();
        await waitForCalls(overview);
      };
      const expectNames = (want: string[]) => browser.waitUntil(async () => (await names()).join() === want.join(), { timeoutMsg: `the order never became ${want.join()}` });
      const expanded = (repo: string) => browser.execute((k) => document.querySelector(`#orca-feed .orca-arrow[data-key="${k}"]`)?.getAttribute("aria-expanded") ?? null, `arrow:proj_${repo}`);

      it("keeps the order of the working projects through reads that reorder them, puts one that starts at the front, and sends one that stops below", async () => {
        await openOrca(read(["w-a", "w-b", "w-q"], [], ["w-q"]));
        // The project that only waits for the user is not in the working group: it stays below.
        expect(await names()).toEqual(["w-a", "w-b", "w-q"]);
        // Orca lists the newest activity first, and it moves with the work: the order shown does not.
        await reread(read(["w-q", "w-b", "w-a"], [], ["w-q"]));
        await browser.pause(300);
        expect(await names()).toEqual(["w-a", "w-b", "w-q"]);
        // A project that starts to work goes in front of the others.
        await reread(read(["w-c", "w-b", "w-a", "w-q"], [], ["w-q"]));
        await expectNames(["w-c", "w-a", "w-b", "w-q"]);
        // One that stops goes below the working ones, and a project that only waits stays below them.
        await reread(read(["w-c", "w-b", "w-a", "w-q"], ["w-a"], ["w-q"]));
        await expectNames(["w-c", "w-b", "w-a", "w-q"]);
        // Starting again, it goes in front.
        await reread(read(["w-a", "w-c", "w-b", "w-q"], [], ["w-q"]));
        await expectNames(["w-a", "w-c", "w-b", "w-q"]);
        // The ones below keep the order of the read.
        await reread(read(["w-a", "w-c", "w-b", "w-q"], ["w-a", "w-b", "w-c"], ["w-q"]));
        await expectNames(["w-a", "w-c", "w-b", "w-q"]);
        await reread(read(["w-b", "w-c", "w-a", "w-q"], ["w-a", "w-b", "w-c"], ["w-q"]));
        await expectNames(["w-b", "w-c", "w-a", "w-q"]);
      });

      it("opens every working project at first, and a waiting or finished one is closed", async () => {
        await openOrca(read(["w-a", "w-b", "w-d", "w-q"], ["w-d"], ["w-q"]));
        expect(await expanded("w-a")).toBe("true");
        expect(await expanded("w-b")).toBe("true");
        expect(await expanded("w-d")).toBe("false");
        expect(await expanded("w-q")).toBe("false");
        expect(await sessionTitles()).toEqual(["Task of w-a", "Task of w-b"]);
      });

      it("opens a project again when it starts to work after the user closed it, and leaves it closed while it keeps working", async () => {
        await openOrca(read(["w-a", "w-b"]));
        await arrow("w-a").click();
        expect(await expanded("w-a")).toBe("false");
        // Still working: the user's closing stands.
        await reread(read(["w-b", "w-a"]));
        await browser.pause(300);
        expect(await expanded("w-a")).toBe("false");
        // It stops and starts again: a new work, so it opens.
        await reread(read(["w-b", "w-a"], ["w-a"]));
        await expectNames(["w-b", "w-a"]);
        expect(await expanded("w-a")).toBe("false");
        await reread(read(["w-a", "w-b"]));
        await browser.waitUntil(async () => (await expanded("w-a")) === "true", { timeoutMsg: "the project that began to work again stayed closed" });
        expect(await names()).toEqual(["w-a", "w-b"]);
        // A project that comes new and works opens at once.
        await reread(read(["w-c", "w-a", "w-b"]));
        await browser.waitUntil(async () => (await expanded("w-c")) === "true", { timeoutMsg: "the new working project stayed closed" });
        expect(await names()).toEqual(["w-c", "w-a", "w-b"]);
      });

      // A read of agents given one by one: `[repo, leaf, group]`, a project for each repo in the order of first appearance.
      const agents = (list: [string, string, "working" | "waiting" | "done"][]) => {
        const repos = [...new Set(list.map(([repo]) => repo))];
        return orcaOverview(
          list.map(([repo, leaf, group]) => orcaRow(repo, "main", `Task of ${repo} ${leaf}`, { group, paneKey: `tab_${repo}:${leaf}`, handle: `term_${repo}_${leaf}` })),
          repos.map((repo) => orcaWorktree(repo, "main")),
        );
      };

      it("keeps a project with a working session and a waiting one in the working group, open at first, through a question and its answer", async () => {
        await openOrca(agents([["w-q", "leaf_1", "waiting"], ["w-m", "leaf_1", "working"], ["w-m", "leaf_2", "waiting"], ["w-a", "leaf_1", "working"]]));
        // The status of w-m is the question (it outranks working), but a session of it works: it is in the group, and open. Only w-q, which just waits, is below.
        expect(await names()).toEqual(["w-m", "w-a", "w-q"]);
        expect(await expanded("w-m")).toBe("true");
        expect(await expanded("w-a")).toBe("true");
        expect(await expanded("w-q")).toBe("false");
        // The read lists the projects in another order, and the second session of w-m is answered: nothing moves.
        await reread(agents([["w-a", "leaf_1", "working"], ["w-q", "leaf_1", "waiting"], ["w-m", "leaf_1", "working"], ["w-m", "leaf_2", "working"]]));
        await browser.pause(300);
        expect(await names()).toEqual(["w-m", "w-a", "w-q"]);
        // It asks again: nothing moves, and the project stays open.
        await reread(agents([["w-m", "leaf_2", "waiting"], ["w-q", "leaf_1", "waiting"], ["w-m", "leaf_1", "working"], ["w-a", "leaf_1", "working"]]));
        await browser.pause(300);
        expect(await names()).toEqual(["w-m", "w-a", "w-q"]);
        expect(await expanded("w-m")).toBe("true");
      });

      it("puts a project whose icon works with no working Claude row in the working group, open, and opens it again when it begins to work again", async () => {
        // w-x works by its icon (another agent, or a worktree's status) but has only a plain terminal; w-y is idle with one.
        const read = (xStatus: "working" | "done") => {
          const base = orcaOverview([], [orcaWorktree("w-y", "main"), orcaWorktree("w-x", "main")], { terminals: [orcaTerminal("w-y", "zsh"), orcaTerminal("w-x", "zsh")] });
          return { ...base, projects: base.projects.map((p) => (p.key === "proj_w-x" ? { ...p, status: xStatus } : p)) };
        };
        await openOrca(read("working"));
        expect(await names()).toEqual(["w-x", "w-y"]);
        expect(await expanded("w-x")).toBe("true");
        expect(await expanded("w-y")).toBe("false");
        // The user closes it: the same work leaves it closed.
        await arrow("w-x").click();
        expect(await expanded("w-x")).toBe("false");
        await reread(read("working"));
        await browser.pause(300);
        expect(await expanded("w-x")).toBe("false");
        // It stops, leaves the group, and works again: a new work, so it opens.
        await reread(read("done"));
        await expectNames(["w-y", "w-x"]);
        await reread(read("working"));
        await expectNames(["w-x", "w-y"]);
        await browser.waitUntil(async () => (await expanded("w-x")) === "true", { timeoutMsg: "the project that works by its icon stayed closed" });
      });

      it("opens a project the user closed when another session of it begins to work, and leaves it closed on a read that adds none", async () => {
        await openOrca(agents([["w-a", "leaf_1", "working"], ["w-b", "leaf_1", "working"]]));
        await arrow("w-a").click();
        expect(await expanded("w-a")).toBe("false");
        // The same work, and a session that is done: the user's closing stands.
        await reread(agents([["w-a", "leaf_1", "working"], ["w-a", "leaf_2", "done"], ["w-b", "leaf_1", "working"]]));
        await browser.pause(300);
        expect(await expanded("w-a")).toBe("false");
        // Another session of w-a begins to work, while the first still does: it opens, and the group keeps its order.
        await reread(agents([["w-b", "leaf_1", "working"], ["w-a", "leaf_1", "working"], ["w-a", "leaf_2", "working"]]));
        await browser.waitUntil(async () => (await expanded("w-a")) === "true", { timeoutMsg: "the project with a new working session stayed closed" });
        expect(await names()).toEqual(["w-a", "w-b"]);
        // Closed again, and a read with the same two working sessions leaves it closed.
        await arrow("w-a").click();
        expect(await expanded("w-a")).toBe("false");
        await reread(agents([["w-a", "leaf_1", "working"], ["w-a", "leaf_2", "working"], ["w-b", "leaf_1", "working"]]));
        await browser.pause(300);
        expect(await expanded("w-a")).toBe("false");
        expect(await names()).toEqual(["w-a", "w-b"]);
      });
    });

    it("lists the sessions in the order of the tabs, through a read that reorders them", async () => {
      await openOrca(withTerminals());
      await project("example-app").click();
      await mock("orca_overview", orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "bash"), orcaTerminal("example-app", "zsh")] }));
      await $("#orca-refresh").click();
      await browser.waitUntil(async () => (await sessionTitles()).length === 3, { timeoutMsg: "the new terminal never became a session row" });
      expect(await sessionTitles()).toEqual(["Write the docs", "zsh", "bash"]);
      expect(await tabTitles()).toEqual(await sessionTitles());
    });

    it("selects the tab of a session row, and moves the selected row when a tab is pressed", async () => {
      await openOrca(withTerminals());
      await mock("orca_terminal_read", ["$ ls"]);
      await project("example-app").click();
      expect(await pressedSessions()).toEqual([claudeTab("example-app")]);
      await sessionOf("orca:term_example-app_zsh").click();
      await expect(selectedTab()).toHaveText(expect.stringContaining("zsh"));
      expect(await pressedSessions()).toEqual(["orca:term_example-app_zsh"]);
      await tabOf(claudeTab("example-app")).$(".orca-tab-btn").click();
      await browser.waitUntil(async () => (await pressedSessions()).join() === claudeTab("example-app"), { timeoutMsg: "the selected row did not follow the tab" });
      await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    });
  });

  it("closes a session in Orca with its handle and the target, reads the list, and keeps the selection when another tab is closed", async () => {
    await openOrca(withTerminals());
    await project("example-app").click();
    const close = await mock("orca_close", null);
    const overview = await mock("orca_overview", withTerminals());
    // The plain terminal's close button is beside its tab: it does not select it.
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-close").click();
    expect(await waitForCalls(close)).toEqual([{ handle: "term_example-app_zsh", environment: null }]);
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    // The list is read at once, and the tab leaves when the read no longer holds it.
    await waitForCalls(overview);
    await tabOf(claudeTab("example-app")).$(".orca-tab-close").click();
    expect(await waitForCalls(close, 2)).toEqual([
      { handle: "term_example-app_zsh", environment: null },
      { handle: "term_example-app", environment: null },
    ]);
    await mock("orca_overview", orcaOverview(sample().slice(1), worktrees()));
    await $("#orca-refresh").click();
    await expect($(".orca-empty")).toHaveText("セッションはありません");
    expect(await tabTitles()).toEqual([]);
  });

  it("drops the tab of a terminal that Orca closed, and selects the next one", async () => {
    await openOrca(withTerminals());
    await project("example-app").click();
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    await expect(selectedTab()).toHaveText(expect.stringContaining("zsh"));
    await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await $("#orca-refresh").click();
    await browser.waitUntil(async () => (await tabTitles()).length === 1, { timeoutMsg: "the tab of the closed terminal stayed" });
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
  });

  it("keeps the tab and shows the message when Orca cannot close it", async () => {
    await openOrca(withTerminals());
    await project("example-app").click();
    const close = await mock("orca_close", rejects("Orca が時間内に応答しませんでした"));
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-close").click();
    await waitForCalls(close);
    await expect($("#error")).toBeDisplayed();
    await expect($("#error")).toHaveText("Orca が時間内に応答しませんでした");
    expect(await tabTitles()).toHaveLength(2);
    // The button works again.
    await expect(tabOf("orca:term_example-app_zsh").$(".orca-tab-close")).toBeEnabled();
  });

  it("cannot close a Claude session that has no terminal", async () => {
    await openOrca(orcaOverview([orcaRow("example-app", "feat/a", "Write the docs", { handle: null })], worktrees()));
    await project("example-app").click();
    await expect(tabOf(claudeTab("example-app")).$(".orca-tab-close")).toBeDisabled();
  });

  describe("a terminal of this machine", () => {
    const zsh = "orca:term_example-app_zsh";

    it("mirrors the screen of the terminal once a second while its tab shows, and draws each frame again", async () => {
      await openOrca(withTerminals());
      await project("example-app").click();
      const read = await mock("orca_terminal_read", ["$ ls", "file-a  file-b"]);
      await tabOf(zsh).$(".orca-tab-btn").click();
      expect((await waitForCalls(read))[0]).toEqual({ handle: "term_example-app_zsh" });
      await browser.waitUntil(async () => (await screenText()).includes("file-b"), { timeoutMsg: "the first frame never showed" });
      await mock("orca_terminal_read", ["$ pwd", "/work/example-app"]);
      await browser.waitUntil(async () => (await screenText()).includes("/work/example-app"), { timeoutMsg: "the next frame never showed" });
      expect(await screenText()).not.toContain("file-b");
    });

    it("writes no clipboard for an OSC 52 request in a frame", async () => {
      await openOrca(withTerminals());
      await project("example-app").click();
      await stubClipboard();
      await mock("orca_terminal_read", [`\x1b]52;c;${Buffer.from("from a frame").toString("base64")}\x07$ ls`]);
      await tabOf(zsh).$(".orca-tab-btn").click();
      await browser.waitUntil(async () => (await screenText()).includes("$ ls"), { timeoutMsg: "the frame never showed" });
      await browser.pause(500);
      expect(await copiedTexts()).toEqual([]);
    });

    it("fits the terminal inside the pane, its last row included", async () => {
      await openOrca(withTerminals());
      await mock("orca_terminal_read", Array.from({ length: 200 }, (_, i) => `line ${i}`));
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      await browser.waitUntil(async () => (await screenText()).includes("line 199"), { timeoutMsg: "the last line never showed" });
      const box = await browser.execute(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".orca-term .orca-term-box:not([hidden]) .xterm-rows > div")];
        return { pane: r(".orca-term").bottom, screen: r(".orca-term .orca-term-box:not([hidden]) .xterm-screen").bottom, last: rows.at(-1)!.getBoundingClientRect().bottom };
      });
      expect(box.screen).toBeLessThanOrEqual(box.pane + 1);
      expect(box.last).toBeLessThanOrEqual(box.pane + 1);
    });

    it("stops reading while another tab shows", async () => {
      await openOrca(orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "zsh")] }));
      await project("example-app").click();
      const read = await mock("orca_terminal_read", ["$"]);
      await tabOf(zsh).$(".orca-tab-btn").click();
      await waitForCalls(read);
      await project("example-api").click();
      await mock("orca_terminal_read", ["$"]);
      await browser.pause(2500);
      // Only the terminal shown is read.
      expect((await callsOf("orca_terminal_read")).every((c) => (c as { handle: string }).handle === "term_example-api")).toBe(true);
    });

    it("stops reading while the window is hidden, and reads at once and goes on when it is shown", async () => {
      await openOrca(withTerminals());
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      await waitForCalls("orca_terminal_read");
      await setWindowHidden(true);
      await mock("orca_terminal_read", ["$"]);
      await browser.pause(2500);
      expect(await callsOf("orca_terminal_read")).toEqual([]);
      await setWindowHidden(false);
      expect((await waitForCalls("orca_terminal_read"))[0]).toEqual({ handle: "term_example-app_zsh" });
      await waitForCalls("orca_terminal_read", 2);
    });

    it("sends the typed keys as they are, to the terminal shown", async () => {
      await openOrca(withTerminals());
      await mock("orca_terminal_read", ["$"]);
      const input = await mock("orca_terminal_input", null);
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      await $(".orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
      await browser.keys(["c", "d"]);
      await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
      expect((await callsOf(input)).every((c) => (c as { handle: string }).handle === "term_example-app_zsh")).toBe(true);
    });

    it("shows the message when the keys cannot be sent", async () => {
      await openOrca(withTerminals());
      await mock("orca_terminal_read", ["$"]);
      const input = await mock("orca_terminal_input", rejects("宛先のターミナルは終了したか、見つかりません。一覧を読み直してください"));
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      await $(".orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
      await browser.keys(["l"]);
      await waitForCalls(input);
      await expect($("#error")).toHaveText("宛先のターミナルは終了したか、見つかりません。一覧を読み直してください");
    });
  });
});

describe("orca: a saved environment's stream", () => {
  const studioOnly = { target: "Studio", environments: ["Studio"] };
  // The calls of a command that takes a channel, with the channel (which cannot cross the driver as it is) as `true`.
  const channelCalls = (command: string) =>
    browser.execute((c) => ((window as unknown as { __e2e_calls__: Record<string, { channel?: unknown }[]> }).__e2e_calls__[c] ?? []).map((call) => ({ ...call, channel: !!call.channel })), command);
  // The Orca screen with Studio as the target, its list streamed once.
  async function openStudio(rows = sample(), terminals: ReturnType<typeof orcaTerminal>[] = []) {
    await openOrca(orcaOverview([], [], studioOnly));
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(rows, worktrees(), terminals));
  }
  const viewportOf = (call: unknown) => (call as { viewport: { cols: number; rows: number } }).viewport;

  it("opens the stream of the saved environment, draws each list it sends, and reads nothing by the clock", async () => {
    await openOrca(orcaOverview([], [], studioOnly));
    expect(await channelCalls("orca_stream_open")).toEqual([{ environment: "Studio", channel: true }]);
    await sendStream(streamList(sample(), worktrees()));
    await waitForCount("#orca-feed .orca-project", 4);
    await expect($("#orca-target")).toHaveText("Studio に接続中");
    // The row that waits, and the finished one: the first read of Studio (at startup) had no rows, so it first appeared in a later read already stopped.
    await expect($("#nav-orca .nav-count")).toHaveText("2");
    // The next list replaces it.
    await sendStream(streamList([working("example-app"), finished("example-api")], worktrees()));
    await waitForCount("#orca-feed .orca-project", 2);
    // The clock reads this screen every 10 seconds; a streamed list is not read.
    const overview = await mock("orca_overview", orcaOverview([], [], studioOnly));
    await browser.pause(12_000);
    expect(await callsOf(overview)).toEqual([]);
  });

  it("says a lost connection, keeps the rows, and is live again with the next list", async () => {
    await openStudio();
    await sendStream({ kind: "status", live: false, message: "Studio is unreachable" });
    await expect($("#orca-target")).toHaveText("Studio に接続できません");
    await expect($("#orca-notice")).toHaveText("読み込めませんでした: Studio is unreachable");
    expect(await count("#orca-feed .orca-project")).toBe(4);
    await sendStream(streamList(sample(), worktrees()));
    await expect($("#orca-target")).toHaveText("Studio に接続中");
    expect(await textsOf("#orca-notice")).toEqual([""]);
  });

  it("streams the terminal of the selected tab at the pane's size, draws what it sends, and sends the keys typed", async () => {
    await openStudio();
    await project("example-app").click();
    const [call] = await waitForCalls("orca_stream_terminal");
    expect(call).toMatchObject({ handle: "term_example-app" });
    expect(viewportOf(call).cols).toBeGreaterThan(20);
    expect(viewportOf(call).rows).toBeGreaterThan(8);
    expect((await channelCalls("orca_stream_terminal"))[0].channel).toBe(true);
    // No mirror for a streamed terminal.
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    await sendTerm({ kind: "snapshot", data: "$ claude\r\n> Write the docs", cols: 80, rows: 24 });
    await browser.waitUntil(async () => (await screenText()).includes("Write the docs"), { timeoutMsg: "the screen never showed" });
    await sendTerm({ kind: "output", data: "\r\nDone." });
    await browser.waitUntil(async () => (await screenText()).includes("Done."), { timeoutMsg: "the output never showed" });
    const input = await mock("orca_stream_input", null);
    await $(".orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
    // A digit: the driver gives a letter the keyCode of its character, and xterm.js reads the keyCode of p to z as a function key (y is F10).
    await browser.keys(["1", "Enter"]);
    await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "1\r", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => (c as { handle: string }).handle === "term_example-app")).toBe(true);
  });

  it("drops the keys not sent yet when another tab shows, so none reaches its terminal", async () => {
    await openStudio(sample(), [orcaTerminal("example-app", "zsh")]);
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    const input = await mock("orca_stream_input", holds);
    await $(".orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
    await browser.keys(["1"]);
    await waitForCalls(input);
    // Typed while the first send is on its way: they wait for it.
    await browser.keys(["2", "Enter"]);
    await browser.pause(300);
    expect(await callsOf(input)).toHaveLength(1);
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    await waitForCalls("orca_stream_terminal", 2);
    await release(input, null);
    await browser.pause(500);
    expect(await callsOf(input)).toEqual([{ handle: "term_example-app", text: "1" }]);
  });

  it("shows the message when the keys cannot be sent", async () => {
    await openStudio();
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    const input = await mock("orca_stream_input", rejects("接続先につながっていません"));
    await $(".orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
    await browser.keys(["y"]);
    await waitForCalls(input);
    await expect($("#error")).toHaveText("接続先につながっていません");
  });

  // The OSC 52 request of a program (the ESC ] 52 ; target ; base64 BEL), as Claude Code makes it for what its mouse selection covers.
  const osc52 = (text: string, target = "c") => `\x1b]52;${target};${Buffer.from(text).toString("base64")}\x07`;
  // The streamed terminal of example-app shown, with the clipboard stubbed.
  async function openCopy() {
    await openStudio();
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    await stubClipboard();
  }
  // Waits until the output after the requests (the screen draws in order, so the earlier ones have been handled) has been parsed.
  const sendMark = async (mark: string) => {
    await sendTerm({ kind: "output", data: `\r\n${mark}` });
    await browser.waitUntil(async () => (await screenText()).includes(mark), { timeoutMsg: `${mark} never showed` });
  };

  it("writes the clipboard with the text of an OSC 52 request from the output, for the target c and for none", async () => {
    await openCopy();
    await sendTerm({ kind: "output", data: osc52("Cooked for 1m 56s\n二行目") });
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "the clipboard was never written" });
    await sendTerm({ kind: "output", data: osc52("no target", "") });
    await browser.waitUntil(async () => (await copiedTexts()).length === 2, { timeoutMsg: "the request with no target was never written" });
    expect(await copiedTexts()).toEqual(["Cooked for 1m 56s\n二行目", "no target"]);
  });

  it("writes nothing for an OSC 52 request that comes with a snapshot, and writes the next one from the output", async () => {
    await openCopy();
    await sendTerm({ kind: "snapshot", data: `${osc52("from the snapshot")}snapshot screen`, cols: 80, rows: 24 });
    await browser.waitUntil(async () => (await screenText()).includes("snapshot screen"), { timeoutMsg: "the snapshot never showed" });
    await sendTerm({ kind: "output", data: osc52("from the output") });
    await browser.waitUntil(async () => (await copiedTexts()).length > 0, { timeoutMsg: "the clipboard was never written" });
    await sendMark("done");
    expect(await copiedTexts()).toEqual(["from the output"]);
  });

  it("writes nothing for a request that is a read, has another target, an empty or a too long text, or text that is not base64", async () => {
    await openCopy();
    const limit = 128 * 1024;
    const requests = [
      "\x1b]52;c;?\x07",
      osc52("primary", "p"),
      "\x1b]52;c;\x07",
      "\x1b]52;c;!!not base64!!\x07",
      "\x1b]52;c;QUJD=RA==\x07",
      "\x1b]52;c\x07",
      `\x1b]52;c;${"QUJD".repeat(limit / 4 + 1)}\x07`,
    ];
    for (const data of requests) await sendTerm({ kind: "output", data });
    // One that is just inside the limit is written, so the refusals above are not a copy that never works.
    await sendTerm({ kind: "output", data: `\x1b]52;c;${"QUJD".repeat(limit / 4)}\x07` });
    await browser.waitUntil(async () => (await copiedTexts()).length > 0, { timeoutMsg: "the clipboard was never written" });
    await sendMark("done");
    expect(await copiedTexts()).toEqual(["ABC".repeat(limit / 4)]);
  });

  // The clipboard refuses every write (as WKWebView may for a write outside a user action); the number of writes tried is `refusals()`.
  const refuseClipboard = () =>
    browser.execute(() => {
      const w = window as unknown as { __e2e_refused__: number };
      w.__e2e_refused__ = 0;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            w.__e2e_refused__++;
            throw new Error("denied");
          },
        },
      });
    });
  const refusals = () => browser.execute(() => (window as unknown as { __e2e_refused__: number }).__e2e_refused__);
  // A copy event on the terminal shown, as ⌘C makes it (the event holds a stand-in for the clipboard): what was put in it, and whether the page took the copy.
  const copyEvent = () =>
    browser.execute(() => {
      const data: Record<string, string> = {};
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          setData: (type: string, value: string) => {
            data[type] = value;
          },
        },
      });
      document.querySelector(".orca-term-box:not([hidden]) .xterm-helper-textarea")!.dispatchEvent(event);
      return { data, taken: event.defaultPrevented };
    });

  it("writes only the last of the OSC 52 requests of one chunk, and leaves the next copy event to xterm.js once the clipboard took it", async () => {
    await openCopy();
    await sendTerm({ kind: "output", data: osc52("first") + osc52("last") });
    await browser.waitUntil(async () => (await copiedTexts()).length > 0, { timeoutMsg: "the clipboard was never written" });
    await sendMark("done");
    expect(await copiedTexts()).toEqual(["last"]);
    expect(await copyEvent()).toEqual({ data: {}, taken: false });
  });

  it("holds the text of an OSC 52 request that the clipboard refused, with no message, and gives it to the next copy event only", async () => {
    await openCopy();
    await refuseClipboard();
    await sendTerm({ kind: "output", data: osc52("first") + osc52("held text") });
    await browser.waitUntil(async () => (await refusals()) > 0, { timeoutMsg: "the write was never tried" });
    await sendMark("done");
    expect(await refusals()).toBe(1);
    await expect($("#error")).not.toBeDisplayed();
    expect(await copyEvent()).toEqual({ data: { "text/plain": "held text" }, taken: true });
    expect(await copyEvent()).toEqual({ data: {}, taken: false });
  });

  it("keeps the held text through a mouse mode and the alternate screen, which Claude Code sends often", async () => {
    await openCopy();
    await refuseClipboard();
    await sendTerm({ kind: "output", data: osc52("held text") });
    await browser.waitUntil(async () => (await refusals()) > 0, { timeoutMsg: "the write was never tried" });
    await sendTerm({ kind: "output", data: "\x1b[?1003h\x1b[?1049h" });
    await sendMark("done");
    expect(await copyEvent()).toEqual({ data: { "text/plain": "held text" }, taken: true });
  });

  it("drops the held text when a snapshot draws the screen again", async () => {
    await openCopy();
    await refuseClipboard();
    await sendTerm({ kind: "output", data: osc52("held text") });
    await browser.waitUntil(async () => (await refusals()) > 0, { timeoutMsg: "the write was never tried" });
    await sendTerm({ kind: "snapshot", data: "snapshot screen", cols: 80, rows: 24 });
    await browser.waitUntil(async () => (await screenText()).includes("snapshot screen"), { timeoutMsg: "the snapshot never showed" });
    expect(await copyEvent()).toEqual({ data: {}, taken: false });
  });

  it("draws the size Orca sends, from the snapshot and from each size", async () => {
    await openStudio();
    await project("example-app").click();
    const [call] = await waitForCalls("orca_stream_terminal");
    const paneRows = viewportOf(call).rows;
    const rowsDrawn = () => browser.execute(() => document.querySelectorAll(".orca-term .orca-term-box:not([hidden]) .xterm-rows > div").length);
    // Showing the pane makes the terminal fit it once more: the ResizeObserver tells (a frame later), and the fit waits FIT_DELAY_MS (50 ms) of ts/orca-terminal.ts. Let that fit pass, or it shrinks the size the snapshot draws.
    await browser.pause(300);
    // The terminal fits the pane, and Orca's size is drawn all the same: another screen of Orca may have taken it.
    await sendTerm({ kind: "snapshot", data: "from the snapshot", cols: 80, rows: paneRows + 3 });
    await browser.waitUntil(async () => (await screenText()).includes("from the snapshot"), { timeoutMsg: "the screen never showed" });
    expect(await rowsDrawn()).toBe(paneRows + 3);
    await sendTerm({ kind: "size", cols: 90, rows: paneRows + 5 });
    await browser.waitUntil(async () => (await rowsDrawn()) === paneRows + 5, { timeoutMsg: "the size of Orca never drew" });
  });

  it("sends the new size when the pane changes", async () => {
    await openStudio();
    await project("example-app").click();
    const [call] = await waitForCalls("orca_stream_terminal");
    const viewport = await mock("orca_stream_viewport", null);
    // The list narrows to 20%, so the terminal widens.
    await dragDivider(0.2);
    const [sent] = await waitForCalls(viewport);
    expect(viewportOf(sent).cols).toBeGreaterThan(viewportOf(call).cols);
    expect(viewportOf(sent).rows).toBe(viewportOf(call).rows);
  });

  it("ends the stream of the tab left and subscribes the other, and ends the stream of the terminal when another screen or a hidden window shows", async () => {
    await openStudio(sample(), [orcaTerminal("example-app", "zsh")]);
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    const close = await mock("orca_stream_terminal_close", null);
    const subscribe = await mock("orca_stream_terminal", null);
    // Another tab: its terminal is subscribed, and the one left is closed by its handle (a close names its terminal, so it ends no other stream).
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    expect(await waitForCalls(subscribe)).toMatchObject([{ handle: "term_example-app_zsh" }]);
    expect(await waitForCalls(close)).toEqual([{ handle: "term_example-app", generation: expect.any(Number) }]);
    // Another screen.
    await $("#nav-mail").click();
    await waitForCalls(close, 2);
    expect((await callsOf(close))[1]).toEqual({ handle: "term_example-app_zsh", generation: expect.any(Number) });
    // Back on the screen the stream starts again, and a hidden window ends it. Showing the screen reads the list once with the CLI, which holds what the stream sent.
    await mock("orca_overview", orcaOverview(sample(), worktrees(), { ...studioOnly, terminals: [orcaTerminal("example-app", "zsh")] }));
    await $("#nav-orca").click();
    await waitForCalls(subscribe, 2);
    await setWindowHidden(true);
    await waitForCalls(close, 3);
    await setWindowHidden(false);
    await waitForCalls(subscribe, 3);
  });

  it("ends the stream of the tab that leaves the list and subscribes the next tab", async () => {
    await openStudio();
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    const close = await mock("orca_stream_terminal_close", null);
    const subscribe = await mock("orca_stream_terminal", null);
    // The Claude row of the tab shown goes and the project keeps a shell: the tab and its terminal are dropped, with a close of its stream, and the shell is subscribed.
    await sendStream(streamList(sample().slice(1), worktrees(), [orcaTerminal("example-app", "zsh")]));
    expect(await waitForCalls(subscribe)).toMatchObject([{ handle: "term_example-app_zsh" }]);
    expect(await waitForCalls(close)).toEqual([{ handle: "term_example-app", generation: expect.any(Number) }]);
  });

  it("ends the stream of the terminal when the tab shown leaves the list and no tab is left to show", async () => {
    await openStudio();
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    const close = await mock("orca_stream_terminal_close", null);
    await sendStream(streamList(sample().slice(1), worktrees()));
    expect(await waitForCalls(close)).toEqual([{ handle: "term_example-app", generation: expect.any(Number) }]);
  });

  it("closes a session in Orca and leaves the tab to the next list, with no read", async () => {
    await openStudio();
    await project("example-app").click();
    const close = await mock("orca_close", null);
    const overview = await mock("orca_overview", orcaOverview([], [], studioOnly));
    await tabOf(claudeTab("example-app")).$(".orca-tab-close").click();
    expect(await waitForCalls(close)).toEqual([{ handle: "term_example-app", environment: "Studio" }]);
    await browser.pause(1500);
    expect(await callsOf(overview)).toEqual([]);
    await sendStream(streamList(sample().slice(1), worktrees()));
    await expect($(".orca-empty")).toHaveText("セッションはありません");
  });

  it("ends the stream of the list when the target becomes this machine", async () => {
    await openStudio();
    const close = await mock("orca_stream_close", null);
    await mock("orca_set_target", null);
    await mock("orca_overview", orcaOverview(sample(), worktrees(), { environments: ["Studio"] }));
    await $("#orca-target").click();
    await pickMenu("このマシン");
    await waitForCalls(close);
    await expect($("#orca-target")).toHaveText("このマシン に接続中");
    // An event of the old stream is not drawn.
    await sendStream(streamList([], worktrees()));
    await browser.pause(300);
    expect(await count("#orca-feed .orca-project")).toBe(4);
  });
});

// The terminal of the Claude session of example-app (this machine's mirror), shown with the given fixtures; the answer of the command that takes its keys is the returned name.
async function openTerminal(fixtures: Record<string, unknown> = {}) {
  await openOrca(orcaOverview(sample(), worktrees()), fixtures);
  await mock("orca_terminal_read", ["$ ls"]);
  const input = await mock("orca_terminal_input", null);
  await project("example-app").click();
  await browser.waitUntil(async () => (await screenText()).includes("$ ls"), { timeoutMsg: "the screen never showed" });
  return input;
}

// What xterm.js draws the terminal with (the only one made), and the pane around it.
const look = () =>
  browser.execute(() => {
    const rows = document.querySelector(".orca-term-box .xterm-rows")!;
    const style = getComputedStyle(rows);
    const span = rows.querySelector("span");
    return {
      size: style.fontSize,
      family: style.fontFamily,
      color: style.color,
      weight: span ? getComputedStyle(span).fontWeight : null,
      pane: getComputedStyle(document.querySelector(".orca-term")!).backgroundColor,
    };
  });

describe("orca: Ghostty's settings in the terminals (A-13)", () => {
  const colors = { background: "#112233", foreground: "#ddeeff", cursor: null, cursorAccent: null, selectionBackground: null, selectionForeground: null, palette: [{ index: 1, color: "#ff0000" }] };
  // Imported settings with a font, colors for both appearances (so the system's does not matter) and two keys.
  const saved = ghosttyImport({
    settings: {
      fontFamilies: ["Example Mono"],
      fontSize: 15,
      fontThicken: true,
      light: colors,
      dark: colors,
      keybinds: [
        { key: "Delete", shift: false, ctrl: false, alt: false, meta: false, text: "\x08" },
        { key: "Enter", shift: false, ctrl: true, alt: false, meta: false, text: "\n" },
      ],
    },
  });

  // A keydown on the terminal shown, as the key event xterm.js listens for.
  const press = (init: KeyboardEventInit) =>
    browser.execute(
      (id, i) => {
        if (!window.__e2e_once__(id)) return;
        document.querySelector(".orca-term-box:not([hidden]) .xterm-helper-textarea")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i }));
      },
      onceId(),
      init,
    );

  it("keeps the app's own font until something is imported", async () => {
    await openTerminal();
    const own = await look();
    expect(own.size).toBe("13px");
    expect(own.family).not.toContain("Example Mono");
    expect(own.weight).toBe("400");
  });

  it("draws the terminal with the font of the import saved before", async () => {
    await openTerminal({ ghostty_saved: saved });
    expect(await look()).toMatchObject({ size: "15px", weight: "500" });
    expect((await look()).family).toContain("Example Mono");
  });

  it("draws the terminals again with an import made in the settings, with no restart", async () => {
    await openTerminal();
    await $("#nav-settings").click();
    await $("#settings-tab-orca").click();
    const imported = await mock("ghostty_import", saved);
    await $("#ghostty-import").click();
    await waitForCalls(imported);
    await $("#nav-orca").click();
    await browser.waitUntil(async () => (await look()).size === "15px", { timeoutMsg: "the terminal never took the font" });
    expect((await look()).family).toContain("Example Mono");
  });

  it("sends the text of a key of the import in place of the key", async () => {
    const input = await openTerminal({ ghostty_saved: saved });
    await press({ key: "Delete" });
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app", text: "\x08" }]);
    await press({ key: "Enter", ctrlKey: true });
    await waitForCalls(input, 2);
    expect(await callsOf(input)).toEqual([
      { handle: "term_example-app", text: "\x08" },
      { handle: "term_example-app", text: "\n" },
    ]);
  });

  it("sends a newline for Shift+Enter, with or without an import", async () => {
    const input = await openTerminal();
    await press({ key: "Enter", shiftKey: true });
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app", text: "\x1b\r" }]);
  });

  it("matches an Alt key by its physical key, since Option makes another character on macOS", async () => {
    const altB = { key: "b", shift: false, ctrl: false, alt: true, meta: false, text: "\x1bb" };
    const input = await openTerminal({ ghostty_saved: ghosttyImport({ settings: { ...saved.settings, keybinds: [altB] } }) });
    // Option+B makes ∫ on a US keyboard; the physical key is KeyB.
    await press({ key: "∫", code: "KeyB", altKey: true });
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app", text: "\x1bb" }]);
  });

  it("lets a key of the import for Shift+Enter take the place of the newline", async () => {
    const shiftEnter = { key: "Enter", shift: true, ctrl: false, alt: false, meta: false, text: "\n" };
    const input = await openTerminal({ ghostty_saved: ghosttyImport({ settings: { ...saved.settings, keybinds: [shiftEnter] } }) });
    await press({ key: "Enter", shiftKey: true });
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app", text: "\n" }]);
  });
});

// A-20: the fonts chosen in the settings. The terminals take the family and the size of the choice in place of Ghostty's, until the choice follows Ghostty again.
describe("orca: the fonts of the screens (A-20)", () => {
  const imported = ghosttyImport({ settings: { fontFamilies: ["Example Mono"], fontSize: 15, fontThicken: true, light: null, dark: null, keybinds: [] } });
  const menlo = fontSettings({ orcaWork: { family: "Menlo", size: 18, ghostty: false } });

  it("draws the terminal with the family and size chosen, with the app's own after them and no thickening", async () => {
    await openTerminal({ ghostty_saved: imported, font_settings: menlo });
    await browser.waitUntil(async () => (await look()).size === "18px", { timeoutMsg: "the terminal never took the size" });
    const chosen = await look();
    expect(chosen.family).toContain("Menlo");
    expect(chosen.family).not.toContain("Example Mono");
    expect(chosen.weight).toBe("400");
  });

  it("keeps Ghostty's font while the choice follows it, whatever family and size the choice holds", async () => {
    await openTerminal({ ghostty_saved: imported, font_settings: fontSettings({ orcaWork: { family: "Menlo", size: 18, ghostty: true } }) });
    expect(await look()).toMatchObject({ size: "15px", weight: "500" });
    expect((await look()).family).toContain("Example Mono");
  });

  it("draws the terminals again with a font chosen in the settings, with no restart, and with Ghostty's again when it is chosen", async () => {
    await openTerminal({ ghostty_saved: imported });
    expect((await look()).size).toBe("15px");
    await $("#nav-settings").click();
    await $("#settings-tab-font").click();
    const set = await mock("font_settings_set", menlo);
    await chooseOption("font-orca-work-family", "family:Menlo");
    await waitForCalls(set);
    await $("#nav-orca").click();
    await browser.waitUntil(async () => (await look()).size === "18px", { timeoutMsg: "the terminal never took the font" });
    expect((await look()).family).toContain("Menlo");
    await $("#nav-settings").click();
    const back = await mock("font_settings_set", fontSettings({ orcaWork: { family: "Menlo", size: 18, ghostty: true } }));
    await chooseOption("font-orca-work-family", "ghostty");
    await waitForCalls(back);
    await $("#nav-orca").click();
    await browser.waitUntil(async () => (await look()).size === "15px", { timeoutMsg: "the terminal never took Ghostty's font again" });
    expect((await look()).family).toContain("Example Mono");
  });

  it("draws the project list with its own family and size, and the work space of the terminals apart", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { font_settings: fontSettings({ orcaList: { family: "Menlo", size: 21, ghostty: false } }) });
    const listSize = () => browser.execute(() => getComputedStyle(document.getElementById("orca-list")!).fontSize);
    await browser.waitUntil(async () => (await listSize()) === "21px", { timeoutMsg: "the list never took the size" });
    expect(await browser.execute(() => getComputedStyle(document.getElementById("orca-work")!).fontSize)).toBe("14px");
    expect(await browser.execute(() => getComputedStyle(document.getElementById("orca-list")!).fontFamily)).toContain("Menlo");
  });

  // The family and the size (in pixels) the page draws the element `id` with.
  const drawn = (id: string) =>
    browser.execute((i) => {
      const style = getComputedStyle(document.getElementById(i)!);
      return { size: style.fontSize, family: style.fontFamily };
    }, id);
  const rootVar = (name: string) => browser.execute((n) => document.documentElement.style.getPropertyValue(n), name);

  it("draws the chat and the file pane with the family and size chosen for the pane, apart from the project list and the terminals", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { font_settings: fontSettings({ orcaPane: { family: "Menlo", size: 21, ghostty: false } }) });
    await browser.waitUntil(async () => (await drawn("orca-work")).size === "21px", { timeoutMsg: "the work pane never took the size" });
    expect((await drawn("orca-work")).family).toContain("Menlo");
    expect(await drawn("orca-files")).toEqual(await drawn("orca-work"));
    // The heading of the file pane is 12px of its own: 12 * 21 / 14.
    expect((await drawn("orca-files-title")).size).toBe("18px");
    expect(await drawn("orca-list")).toMatchObject({ size: "14px" });
    expect((await drawn("orca-list")).family).not.toContain("Menlo");
  });

  it("puts no variable on the root for the work pane while none is chosen", async () => {
    await openOrca(orcaOverview(sample(), worktrees()));
    expect((await drawn("orca-work")).size).toBe("14px");
    expect((await drawn("orca-files")).size).toBe("14px");
    expect(await rootVar("--ff-orca-pane")).toBe("");
    expect(await rootVar("--fs-orca-pane")).toBe("");
  });

  it("draws the work pane with the family of the whole app when none is chosen for it, and not its size", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { font_settings: fontSettings({ app: { family: "Menlo", size: 20, ghostty: false } }) });
    await browser.waitUntil(async () => (await drawn("orca-work")).family.includes("Menlo"), { timeoutMsg: "the work pane never took the family of the app" });
    // The size of the whole app does not reach a place.
    expect((await drawn("orca-work")).size).toBe("14px");
    expect((await drawn("orca-list")).family).toContain("Menlo");
  });
});

describe("orca: the terminal colors (A-14, A-15)", () => {
  // The light theme is on a cream ground, the dark one on a dark violet.
  const light = { pane: "rgb(253, 246, 227)", color: "rgb(101, 123, 131)" };
  const dark = { pane: "rgb(40, 42, 54)", color: "rgb(248, 248, 242)" };
  const chosen = terminalThemes({ light: "One Light", dark: "Dracula" });
  const colorsNow = async () => {
    const { pane, color } = await look();
    return { pane, color };
  };

  it("draws the terminal with the theme of the system's appearance, and with the other one when it changes", async () => {
    await openTerminal({ terminal_themes: chosen });
    await setDark(false);
    await browser.waitUntil(async () => (await look()).pane === light.pane, { timeoutMsg: "the terminal never took the light theme" });
    expect(await colorsNow()).toEqual(light);
    await setDark(true);
    await browser.waitUntil(async () => (await look()).pane === dark.pane, { timeoutMsg: "the terminal never took the dark theme" });
    expect(await colorsNow()).toEqual(dark);
    await setDark(false);
    await browser.waitUntil(async () => (await look()).pane === light.pane, { timeoutMsg: "the terminal never went back to the light theme" });
    expect(await colorsNow()).toEqual(light);
  });

  it("prefers the theme to the colors of the Ghostty import, and keeps the import's font", async () => {
    const colors = { background: "#112233", foreground: "#ddeeff", cursor: null, cursorAccent: null, selectionBackground: null, selectionForeground: null, palette: [] };
    const imported = ghosttyImport({ settings: { fontFamilies: ["Example Mono"], fontSize: 15, fontThicken: false, light: colors, dark: colors, keybinds: [] } });
    await openTerminal({ terminal_themes: chosen, ghostty_saved: imported });
    await setDark(true);
    await browser.waitUntil(async () => (await look()).pane === dark.pane, { timeoutMsg: "the terminal never took the dark theme" });
    expect(await colorsNow()).toEqual(dark);
    expect((await look()).size).toBe("15px");
  });

  it("draws the colors of the Ghostty import while no theme could be read", async () => {
    const colors = { background: "#112233", foreground: "#ddeeff", cursor: null, cursorAccent: null, selectionBackground: null, selectionForeground: null, palette: [] };
    const imported = ghosttyImport({ settings: { fontFamilies: [], fontSize: null, fontThicken: false, light: colors, dark: colors, keybinds: [] } });
    await openTerminal({ terminal_themes: rejects("テーマを読めません"), ghostty_saved: imported });
    expect(await colorsNow()).toEqual({ pane: "rgb(17, 34, 51)", color: "rgb(221, 238, 255)" });
  });

  it("draws the terminals again with a theme chosen in the settings, with no restart", async () => {
    await openTerminal({ terminal_themes: chosen });
    await setDark(true);
    await browser.waitUntil(async () => (await look()).pane === dark.pane, { timeoutMsg: "the terminal never took the dark theme" });
    await $("#nav-settings").click();
    await $("#settings-tab-orca").click();
    const set = await mock("terminal_theme_set", { light: "One Light", dark: "Ghostty Default Style Dark", appearance: "system" });
    await chooseTheme("dark", "Ghostty Default Style Dark");
    expect(await waitForCalls(set)).toEqual([{ selection: { light: "One Light", dark: "Ghostty Default Style Dark", appearance: "system" } }]);
    await $("#nav-orca").click();
    await browser.waitUntil(async () => (await look()).pane === "rgb(16, 32, 58)", { timeoutMsg: "the terminal never took the chosen theme" });
    // The theme of the other appearance is unchanged.
    await setDark(false);
    await browser.waitUntil(async () => (await look()).pane === light.pane, { timeoutMsg: "the terminal never took the light theme" });
  });

  it("draws the light theme whatever the system's appearance is when the appearance is fixed to light", async () => {
    await openTerminal({ terminal_themes: terminalThemes({ light: "One Light", dark: "Dracula", appearance: "light" }) });
    await setDark(true);
    await browser.waitUntil(async () => (await look()).pane === light.pane, { timeoutMsg: "the terminal never took the light theme" });
    expect(await colorsNow()).toEqual(light);
    // A change of the system's appearance does not move it, and the pane keeps its ground.
    await setDark(false);
    await setDark(true);
    expect(await colorsNow()).toEqual(light);
  });

  it("draws the dark theme whatever the system's appearance is when the appearance is fixed to dark", async () => {
    await openTerminal({ terminal_themes: terminalThemes({ light: "One Light", dark: "Dracula", appearance: "dark" }) });
    await setDark(false);
    await browser.waitUntil(async () => (await look()).pane === dark.pane, { timeoutMsg: "the terminal never took the dark theme" });
    expect(await colorsNow()).toEqual(dark);
    await setDark(true);
    await setDark(false);
    expect(await colorsNow()).toEqual(dark);
  });

  it("draws the terminals again at once when the appearance is chosen in the settings, and follows the system again with 'system'", async () => {
    await openTerminal({ terminal_themes: chosen });
    await setDark(true);
    await browser.waitUntil(async () => (await look()).pane === dark.pane, { timeoutMsg: "the terminal never took the dark theme" });
    await $("#nav-settings").click();
    await $("#settings-tab-orca").click();
    const set = await mock("terminal_theme_set", { light: "One Light", dark: "Dracula", appearance: "light" });
    await chooseAppearance("light");
    expect(await waitForCalls(set)).toEqual([{ selection: { light: "One Light", dark: "Dracula", appearance: "light" } }]);
    await $("#nav-orca").click();
    await browser.waitUntil(async () => (await look()).pane === light.pane, { timeoutMsg: "the terminal never took the fixed light theme" });
    await mock("terminal_theme_set", { light: "One Light", dark: "Dracula", appearance: "system" });
    await $("#nav-settings").click();
    await chooseAppearance("system");
    await $("#nav-orca").click();
    await browser.waitUntil(async () => (await look()).pane === dark.pane, { timeoutMsg: "the terminal never followed the system again" });
  });
});

describe("orca: files on a terminal (A-10)", () => {
  const dropped = (repo: string, name = "shot.png") => `/work/${repo}/.orca/drops/${name}`;
  // What `orca_attach_file` answers for an image: the path with its blank, to be pasted as a bracketed paste.
  const attached = (repo: string, name = "shot.png") => ({ text: `${dropped(repo, name)} `, bracketed: true });
  // What it answers for any other file: the path in quotes with its blank, to be typed as it is.
  const attachedNote = (repo: string, name = "notes.txt") => ({ text: `'${dropped(repo, name)}' `, bracketed: false });
  const NOTE = btoa("hello");
  const shown = ".orca-term-box:not([hidden]) .xterm-helper-textarea";
  const area = ".orca-term";
  const inputs = (command: string) => callsOf(command).then((calls) => calls.map((c) => (c as { text: string }).text));

  // The screen with the terminal of the project example-app shown: the mirror of this machine, else the stream of Studio.
  async function openMirror() {
    await openOrca(orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "zsh")] }));
    await mock("orca_terminal_read", ["$"]);
    await project("example-app").click();
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    await waitForCalls("orca_terminal_read");
  }
  async function openStream() {
    await openOrca(orcaOverview([], [], { target: "Studio", environments: ["Studio"] }));
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(sample(), worktrees(), [orcaTerminal("example-app", "zsh")]));
    await project("example-app").click();
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    await waitForCalls("orca_stream_terminal");
  }

  it("puts a pasted image in the worktree of a terminal of this machine and types its path there", async () => {
    await openMirror();
    const attach = await mock("orca_attach_file", attached("example-app"));
    const input = await mock("orca_terminal_input", null);
    expect(await fire("paste", shown, [image()])).toBe(true);
    expect(await waitForCalls(attach)).toEqual([{ path: "/work/example-app", name: "shot.png", data: PNG, environment: null }]);
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app_zsh", text: `${dropped("example-app")} ` }]);
  });

  it("puts a pasted file that is not an image in the worktree and types its quoted path as it is", async () => {
    await openMirror();
    const attach = await mock("orca_attach_file", attachedNote("example-app"));
    const input = await mock("orca_terminal_input", null);
    expect(await fire("paste", shown, [note])).toBe(true);
    expect(await waitForCalls(attach)).toEqual([{ path: "/work/example-app", name: "notes.txt", data: NOTE, environment: null }]);
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app_zsh", text: `'${dropped("example-app", "notes.txt")}' ` }]);
  });

  it("leaves a paste with no file to the terminal", async () => {
    await openMirror();
    const attach = await mock("orca_attach_file", attached("example-app"));
    await fire("paste", shown, []);
    await browser.pause(300);
    expect(await callsOf(attach)).toEqual([]);
  });

  it("takes images dropped on the terminal, cancels a dragover that carries a file, and types the paths in order on one line", async () => {
    await openMirror();
    const attach = await mock("orca_attach_file", attached("example-app", "first.png"));
    const input = await mock("orca_terminal_input", null);
    expect(await fire("dragover", area, [image()])).toBe(true);
    expect(await fire("dragover", area, [])).toBe(false);
    expect(await fire("drop", area, [image("first.png"), image("second.png")])).toBe(true);
    expect((await waitForCalls(attach, 2)).map((c) => (c as { name: string }).name)).toEqual(["first.png", "second.png"]);
    await waitForCalls(input);
    expect(await inputs(input)).toEqual([`${dropped("example-app", "first.png")} ${dropped("example-app", "first.png")} `]);
  });

  it("puts a dropped file that is not an image in the worktree and types its quoted path as it is", async () => {
    await openMirror();
    const attach = await mock("orca_attach_file", attachedNote("example-app"));
    const input = await mock("orca_terminal_input", null);
    expect(await fire("dragover", area, [note])).toBe(true);
    expect(await fire("drop", area, [note])).toBe(true);
    expect(await waitForCalls(attach)).toEqual([{ path: "/work/example-app", name: "notes.txt", data: NOTE, environment: null }]);
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app_zsh", text: `'${dropped("example-app", "notes.txt")}' ` }]);
  });

  it("refuses a file over 20 MiB with the message, without reading it or calling the command, and types nothing", async () => {
    await openMirror();
    const attach = await mock("orca_attach_file", attachedNote("example-app"));
    const input = await mock("orca_terminal_input", null);
    await fire("drop", area, [huge]);
    await expect($("#error")).toHaveText("ファイルは 20 MiB までです");
    expect(await callsOf(attach)).toEqual([]);
    expect(await callsOf(input)).toEqual([]);
  });

  it("shows the message of a file that cannot be put and types nothing", async () => {
    await openMirror();
    const attach = await mock("orca_attach_file", rejects("SSH の接続先の worktree にはファイルを添付できません"));
    const input = await mock("orca_terminal_input", null);
    await fire("paste", shown, [image()]);
    await waitForCalls(attach);
    await expect($("#error")).toHaveText("SSH の接続先の worktree にはファイルを添付できません");
    expect(await callsOf(input)).toEqual([]);
  });

  it("does not take a file dropped anywhere else, and does not let the webview navigate to it", async () => {
    await openMirror();
    const attach = await mock("orca_attach_file", attached("example-app"));
    const before = await browser.execute(() => location.href);
    expect(await fire("dragover", "document", [image()])).toBe(true);
    expect(await fire("drop", "document", [image()])).toBe(true);
    expect(await fire("drop", "#orca-feed", [image()])).toBe(true);
    // A drag that holds no file is not touched.
    expect(await fire("drop", "document", [])).toBe(false);
    expect(await browser.execute(() => location.href)).toBe(before);
    expect(await callsOf(attach)).toEqual([]);
  });

  it("puts the image in the worktree of the Claude session shown, with the target", async () => {
    await openOrca(orcaOverview([], [], { target: "Studio", environments: ["Studio"] }));
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(sample(), worktrees()));
    await project("example-api").click();
    await waitForCalls("orca_stream_terminal");
    const attach = await mock("orca_attach_file", attached("example-api"));
    const input = await mock("orca_stream_input", null);
    await fire("paste", shown, [image()]);
    expect(await waitForCalls(attach)).toEqual([{ path: "/work/example-api", name: "shot.png", data: PNG, environment: "Studio" }]);
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-api", text: `${dropped("example-api")} ` }]);
  });

  it("types the path in the terminal streamed from a saved environment, to its handle", async () => {
    await openStream();
    const attach = await mock("orca_attach_file", attached("example-app"));
    const input = await mock("orca_stream_input", null);
    await fire("drop", area, [image()]);
    expect(await waitForCalls(attach)).toEqual([{ path: "/work/example-app", name: "shot.png", data: PNG, environment: "Studio" }]);
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app_zsh", text: `${dropped("example-app")} ` }]);
  });

  it("types the text of a file whose answer is not bracketed as it is, and pastes a bracketed one, in a terminal that asked for the bracketed paste", async () => {
    await openStream();
    await sendTerm({ kind: "output", data: "\x1b[?2004h" });
    const attach = await mock("orca_attach_file", attachedNote("example-app"));
    const input = await mock("orca_stream_input", null);
    await fire("paste", shown, [note]);
    await waitForCalls(attach);
    expect(await inputs(input)).toEqual([`'${dropped("example-app", "notes.txt")}' `]);
    await mock("orca_attach_file", attached("example-app"));
    await fire("paste", shown, [image()]);
    await browser.waitUntil(async () => (await inputs(input)).length === 2, { timeoutMsg: "the bracketed paste never went" });
    expect((await inputs(input))[1]).toBe(`\x1b[200~${dropped("example-app")} \x1b[201~`);
  });

  it("does not type the path in another terminal when the tab changed while the image went", async () => {
    await openStream();
    const attach = await mock("orca_attach_file", holds);
    const input = await mock("orca_stream_input", null);
    await fire("paste", shown, [image()]);
    await waitForCalls(attach);
    await project("example-api").click();
    await waitForCalls("orca_stream_terminal", 2);
    await release(attach, attached("example-app"));
    await browser.pause(500);
    expect(await callsOf(input)).toEqual([]);
  });
});

describe("orca: links in a terminal (A-8, A-12)", () => {
  const lines = ["$ open", "docs: https://example.com/docs。続きを読む", "see (https://example.org/a)."];
  const shownBox = ".orca-term .orca-term-box:not([hidden])";

  // The centre of `needle` on the screen of the terminal shown (the text of a row is drawn in the DOM).
  const aim = (needle: string) =>
    browser.execute(
      (selector, text) => {
        const walker = document.createTreeWalker(document.querySelector(`${selector} .xterm-rows`)!, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(text);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const box = range.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }
        throw new Error(`no "${text}" on the screen`);
      },
      shownBox,
      needle,
    );
  const mouse = (type: "mousemove" | "mousedown" | "mouseup", at: { x: number; y: number }, init: MouseEventInit) =>
    browser.execute(
      (selector, t, point, extra) => {
        document.querySelector(`${selector} .xterm-screen`)!.dispatchEvent(new MouseEvent(t, { clientX: point.x, clientY: point.y, button: 0, bubbles: true, cancelable: true, ...extra }));
      },
      shownBox,
      type,
      at,
      init,
    );
  // A click on `needle` with the modifiers in `init`: the pointer comes first, so xterm.js finds the link under it.
  async function clickOn(needle: string, init: MouseEventInit = {}) {
    const at = await aim(needle);
    await mouse("mousemove", at, init);
    await browser.pause(100);
    await mouse("mousedown", at, init);
    await mouse("mouseup", at, init);
  }
  const titleOf = () => browser.execute((selector) => document.querySelector(selector)!.getAttribute("title") ?? "", shownBox);

  async function openMirror() {
    await openOrca(orcaOverview(sample(), worktrees()));
    await mock("orca_terminal_read", lines);
    await project("example-app").click();
    await browser.waitUntil(async () => (await screenText()).includes("example.org"), { timeoutMsg: "the screen never showed" });
  }
  // `shows` is a word of `text` that the screen has once it is drawn (not a phrase: the DOM renderer draws a space as U+00A0).
  async function openStream(text: string, shows: string) {
    await openOrca(orcaOverview([], [], { target: "Studio", environments: ["Studio"] }));
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(sample(), worktrees()));
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    // Showing the pane makes the terminal fit it once more (the ResizeObserver, then FIT_DELAY_MS of ts/orca-terminal.ts). Let that fit pass, or it moves the text under the pointer.
    await browser.pause(300);
    await sendTerm({ kind: "snapshot", data: text, cols: 80, rows: 24 });
    await browser.waitUntil(async () => (await screenText()).includes(shows), { timeoutMsg: "the screen never showed" });
  }

  it("opens the URL of a link ⌘+clicked in the mirror of this machine, cut where the Japanese sentence goes on and before the closing bracket", async () => {
    await openMirror();
    const open = await mock("orca_open_url", null);
    await clickOn("example.com", { metaKey: true });
    expect(await waitForCalls(open)).toEqual([{ url: "https://example.com/docs" }]);
    await clickOn("example.org", { metaKey: true });
    expect(await waitForCalls(open, 2)).toEqual([{ url: "https://example.com/docs" }, { url: "https://example.org/a" }]);
  });

  it("opens nothing for a click without ⌘, with Ctrl or Alt held, or with another button", async () => {
    await openMirror();
    const open = await mock("orca_open_url", null);
    await clickOn("example.com");
    await clickOn("example.com", { metaKey: true, ctrlKey: true });
    await clickOn("example.com", { metaKey: true, altKey: true });
    await clickOn("example.com", { metaKey: true, button: 2 });
    await browser.pause(300);
    expect(await callsOf(open)).toEqual([]);
    // The same click with ⌘ alone opens it, so the clicks above did reach the link.
    await clickOn("example.com", { metaKey: true });
    expect(await waitForCalls(open)).toEqual([{ url: "https://example.com/docs" }]);
  });

  it("shows the URL as the title while the pointer is over a link, and takes it away when the pointer leaves", async () => {
    await openMirror();
    await mock("orca_open_url", null);
    await mouse("mousemove", await aim("example.com"), {});
    await browser.waitUntil(async () => (await titleOf()) === "https://example.com/docs", { timeoutMsg: "the title never showed the URL" });
    await mouse("mousemove", await aim("$ open"), {});
    await browser.waitUntil(async () => (await titleOf()) === "", { timeoutMsg: "the title stayed" });
  });

  it("opens the URL of a link ⌘+clicked in the terminal streamed from a saved environment", async () => {
    await openStream("$ claude\r\ndocs: https://example.com/docs", "example.com");
    const open = await mock("orca_open_url", null);
    await clickOn("example.com");
    await browser.pause(300);
    expect(await callsOf(open)).toEqual([]);
    await clickOn("example.com", { metaKey: true });
    expect(await waitForCalls(open)).toEqual([{ url: "https://example.com/docs" }]);
  });

  it("opens a link that a program set with OSC 8 the same way, and shows the message when Rust refuses its URL", async () => {
    await openStream("$ cat\r\n\x1b]8;;file:///etc/hosts\x1b\\hosts file\x1b]8;;\x1b\\", "hosts");
    const open = await mock("orca_open_url", rejects("開けるのは http か https の URL だけです"));
    await clickOn("hosts", { metaKey: true });
    expect(await waitForCalls(open)).toEqual([{ url: "file:///etc/hosts" }]);
    await expect($("#error")).toHaveText("開けるのは http か https の URL だけです");
  });
});

// A-17: the work pane split into panes. Rust decides what an operation does to the layout (unit tests); here the screen is checked: what it asks of `orca_panes`, and how it draws the layout the answer holds.
describe("orca: split panes (A-17)", () => {
  const claude = claudeTab("example-app");
  const zsh = "orca:term_example-app_zsh";
  const bash = "orca:term_example-app_bash";
  const apiTab = claudeTab("example-api");
  const pane = (id: string, tabs: string[], selected = tabs[0]): PaneNode => ({ kind: "pane", id, tabs, selected });
  const row = (...children: PaneNode[]): PaneNode => ({ kind: "split", direction: "row", children });
  const column = (...children: PaneNode[]): PaneNode => ({ kind: "split", direction: "column", children });
  const layout = (root: PaneNode, focus: string): PaneLayout => ({ root, focus });
  // The Orca handle of each tab that has a terminal.
  const handles = { [claude]: "term_example-app", [zsh]: "term_example-app_zsh", [bash]: "term_example-app_bash" };
  // example-app has its Claude session and two shells, in that order.
  const overview = () => orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "zsh"), orcaTerminal("example-app", "bash")] });
  // Claude and bash on the left, zsh on the right.
  const saved = () => layout(row(pane("p1", [claude, bash]), pane("p2", [zsh])), "p1");
  const paneTabs = (id: string) => textsOf(`.orca-pane[data-pane="${id}"] .orca-tab-title`);
  const moves = async () => (await callsOf("orca_panes")).filter((c) => (c as { op: { kind: string } | null }).op?.kind === "move");

  // The right button on the tab, as the page gets it.
  const rightClick = (tab: string) =>
    browser.execute(
      (id, once) => {
        if (!window.__e2e_once__(once)) return;
        document.querySelector(`[data-tab="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
      },
      tab,
      onceId(),
    );

  // The pointer's press on the terminal of a pane, as the page gets it (the driver's click on a terminal sends no pointer event).
  const pressPane = (id: string) =>
    browser.execute(
      (paneId, once) => {
        if (!window.__e2e_once__(once)) return;
        document.querySelector(`.orca-pane[data-pane="${paneId}"] .orca-term .xterm-screen`)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 5, isPrimary: true }));
      },
      id,
      onceId(),
    );

  // The pointer's press on a tab, its move to a point of the pane `to`, and (unless `hold`) its release. `at` is the share of the pane's body from its left and from its top; a negative top is its tab strip.
  const drag = (tab: string, to: string, at: [number, number], hold = false) =>
    browser.execute(
      (id, once, paneId, [fx, fy], stay) => {
        if (!window.__e2e_once__(once)) return;
        const fire = (target: EventTarget, type: string, x: number, y: number) =>
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 3, isPrimary: true }));
        const button = document.querySelector(`[data-tab="${id}"] .orca-tab-btn`)!.getBoundingClientRect();
        const target = document.querySelector(`.orca-pane[data-pane="${paneId}"]`)!;
        const box = target.getBoundingClientRect();
        const bar = target.querySelector(".orca-tabbar")!.getBoundingClientRect();
        const x = box.left + box.width * fx;
        const y = fy < 0 ? bar.top + bar.height / 2 : bar.bottom + (box.bottom - bar.bottom) * fy;
        fire(document.querySelector(`[data-tab="${id}"] .orca-tab-btn`)!, "pointerdown", button.left + 5, button.top + 5);
        fire(document, "pointermove", x, y);
        if (!stay) fire(document, "pointerup", x, y);
      },
      tab,
      onceId(),
      to,
      at,
      hold,
    );

  // The project of example-app selected, with the layout that `orca_panes` answers from the start.
  const leaves = (node: PaneNode | null): number => (node === null ? 0 : node.kind === "pane" ? 1 : node.children.reduce((n, c) => n + leaves(c), 0));
  async function openSplit(value = overview(), answer: PaneLayout = saved(), fixtures: Record<string, unknown> = {}) {
    await openOrca(value, { orca_panes: answer, orca_terminal_read: ["$"], ...fixtures });
    await project("example-app").click();
    await waitForCount(".orca-pane", leaves(answer.root));
  }
  // The layout Rust answers once `focus` is pressed, or `selected` is chosen in the left pane (the answer of a press agrees with the screen, which showed it at once).
  const focusedOn = (focus: string, selected = claude) => layout(row(pane("p1", [claude, bash], selected), pane("p2", [zsh])), focus);

  it("asks Rust for the layout of the project with its tabs, and draws the panes it answers, each with its tab strip and its plus", async () => {
    await openSplit();
    const [first] = await callsOf("orca_panes");
    expect(first).toEqual({ environment: null, project: "proj_example-app", tabs: [claude, zsh, bash], handles, was: {}, op: null });
    expect(await paneTabs("p1")).toEqual(["Write the docs", "bash"]);
    expect(await paneTabs("p2")).toEqual(["zsh"]);
    expect(await count(".orca-plus")).toBe(2);
    expect(await count(".orca-tabs")).toBe(2);
    expect(await browser.execute(() => document.querySelector(".orca-split-node")!.getAttribute("data-direction"))).toBe("row");
    // The two panes lie side by side, with the first on the left.
    const [left, right] = await browser.execute(() => [...document.querySelectorAll(".orca-pane")].map((e) => e.getBoundingClientRect().left));
    expect(left).toBeLessThan(right);
    await expect($('.orca-pane[data-pane="p1"] [aria-selected="true"]')).toHaveText(expect.stringContaining("Write the docs"));
  });

  it("draws a column split with its panes one above the other, and a split in a split", async () => {
    await openSplit(overview(), layout(column(pane("p1", [claude, bash]), row(pane("p2", [zsh]), pane("p3", [apiTab]))), "p1"));
    expect(await browser.execute(() => [...document.querySelectorAll(".orca-split-node")].map((e) => e.getAttribute("data-direction")))).toEqual(["column", "row"]);
    const [top, bottom] = await browser.execute(() => ["p1", "p2"].map((id) => document.querySelector(`.orca-pane[data-pane="${id}"]`)!.getBoundingClientRect().top));
    expect(top).toBeLessThan(bottom);
  });

  it("splits by the right-click menu of a tab: 「右に分割」 and 「下に分割」 ask for the tab at the right and at the bottom of its pane", async () => {
    await openOrca(overview(), { orca_terminal_read: ["$"] });
    await project("example-app").click();
    await waitForCalls("orca_panes");
    const panes = await mock("orca_panes", layout(row(pane("p1", [claude, bash]), pane("p2", [zsh])), "p2"));
    await rightClick(zsh);
    await expect($('.menu[role="menu"]')).toBeDisplayed();
    expect(await textsOf('.menu[role="menu"] button')).toEqual(["右に分割", "下に分割"]);
    await pickItem("右に分割");
    expect(await waitForCalls(panes)).toEqual([{ environment: null, project: "proj_example-app", tabs: [claude, zsh, bash], handles, was: handles, op: { kind: "move", tab: zsh, pane: "p1", edge: "right" } }]);
    await waitForCount(".orca-pane", 2);
    expect(await paneTabs("p2")).toEqual(["zsh"]);
    // Below: the next answer is a column.
    const below = await mock("orca_panes", layout(column(pane("p1", [claude, zsh]), pane("p2", [bash])), "p2"));
    await rightClick(bash);
    await pickItem("下に分割");
    expect(await waitForCalls(below)).toEqual([{ environment: null, project: "proj_example-app", tabs: [claude, zsh, bash], handles, was: handles, op: { kind: "move", tab: bash, pane: "p1", edge: "bottom" } }]);
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".orca-split-node")?.getAttribute("data-direction"))) === "column", { timeoutMsg: "the column never drew" });
  });

  it("puts the button that opens the list (A-23) in the strip of the pane at the left edge only: the first pane of a row, the top pane of a column", async () => {
    await openSplit();
    await $("#orca-list-toggle").click();
    await expect($('.orca-pane[data-pane="p1"] .list-toggle')).toBeDisplayed();
    await expect($('.orca-pane[data-pane="p2"] .list-toggle')).not.toBeDisplayed();
    await $('.orca-pane[data-pane="p1"] .list-toggle').click();
    await expect($("#orca-list")).toBeDisplayed();
    await expect($('.orca-pane[data-pane="p1"] .list-toggle')).not.toBeDisplayed();
    await openSplit(overview(), layout(column(pane("p1", [claude, bash]), row(pane("p2", [zsh]), pane("p3", [apiTab]))), "p1"));
    await $("#orca-list-toggle").click();
    await expect($('.orca-pane[data-pane="p1"] .list-toggle')).toBeDisplayed();
    await expect($('.orca-pane[data-pane="p2"] .list-toggle')).not.toBeDisplayed();
    await expect($('.orca-pane[data-pane="p3"] .list-toggle')).not.toBeDisplayed();
  });

  it("has no menu on a tab that is alone in its pane", async () => {
    await openSplit();
    await rightClick(zsh);
    await browser.pause(300);
    expect(await count(".menu")).toBe(0);
  });

  it("splits by dragging a tab to an edge of another pane, joins it by dragging it to the strip or the middle, and asks nothing for a drop that changes nothing", async () => {
    await openSplit();
    // The hint shows while the tab is over a place that takes it, and goes with Escape, which leaves the tab where it was.
    await drag(bash, "p2", [0.5, 0.95], true);
    await expect($(".orca-drop")).toBeDisplayed();
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await waitForCount(".orca-drop", 0);
    expect(await moves()).toEqual([]);
    // The bottom edge of the other pane, its left edge, its strip, and its middle.
    for (const [at, edge] of [[[0.5, 0.95], "bottom"], [[0.03, 0.5], "left"], [[0.5, 0.5], "center"], [[0.5, -1], "center"], [[0.97, 0.5], "right"], [[0.5, 0.03], "top"]] as [[number, number], string][]) {
      const before = (await moves()).length;
      await drag(bash, "p2", at);
      await browser.waitUntil(async () => (await moves()).length === before + 1, { timeoutMsg: `no move for ${edge}` });
      expect((await moves()).at(-1)).toEqual({ environment: null, project: "proj_example-app", tabs: [claude, zsh, bash], handles, was: handles, op: { kind: "move", tab: bash, pane: "p2", edge } });
    }
    expect(await count(".orca-drop")).toBe(0);
    // The edge of its own pane, which has another tab, splits it; its own strip or middle, and the edge of a pane it is alone in, change nothing.
    const before = (await moves()).length;
    await drag(bash, "p1", [0.97, 0.5]);
    await browser.waitUntil(async () => (await moves()).length === before + 1, { timeoutMsg: "no move on its own pane" });
    expect((await moves()).at(-1)).toMatchObject({ op: { tab: bash, pane: "p1", edge: "right" } });
    await drag(bash, "p1", [0.5, 0.5]);
    await drag(bash, "p1", [0.5, -1]);
    await drag(zsh, "p2", [0.97, 0.5]);
    await drag(zsh, "p2", [0.5, 0.5]);
    await browser.pause(300);
    expect((await moves()).length).toBe(before + 1);
    // A press that does not move selects the tab as a click does, and a drag does not.
    expect(await count(".orca-drop")).toBe(0);
  });

  it("does not select the tab that was dragged", async () => {
    await openSplit();
    const panes = await mock("orca_panes", saved());
    await drag(bash, "p2", [0.5, 0.5]);
    await browser.pause(300);
    expect((await callsOf(panes)).filter((c) => (c as { op: { kind: string } | null }).op?.kind === "select")).toEqual([]);
  });

  it("selects a tab of a pane by pressing it, and gives a pane the focus by pressing it", async () => {
    await openSplit();
    const panes = await mock("orca_panes", focusedOn("p1", bash));
    await tabOf(bash).$(".orca-tab-btn").click();
    expect(await waitForCalls(panes)).toMatchObject([{ op: { kind: "select", tab: bash } }]);
    // The terminal of the other pane: pressing it gives its pane the focus.
    await mock("orca_panes", focusedOn("p2", bash));
    await pressPane("p2");
    await browser.waitUntil(async () => (await callsOf("orca_panes")).some((c) => (c as { op: { kind: string } | null }).op?.kind === "focus"), { timeoutMsg: "no focus" });
    expect((await callsOf("orca_panes")).at(-1)).toMatchObject({ op: { kind: "focus", pane: "p2" } });
  });

  it("draws the focused pane's bar marked, and the selected tab of each pane", async () => {
    await openSplit(overview(), layout(row(pane("p1", [claude, bash], bash), pane("p2", [zsh])), "p2"));
    expect(await browser.execute(() => document.querySelector(".orca-pane[data-focused='true']")!.getAttribute("data-pane"))).toBe("p2");
    await expect($('.orca-pane[data-pane="p1"] [aria-selected="true"]')).toHaveText(expect.stringContaining("bash"));
    await expect($('.orca-pane[data-pane="p2"] [aria-selected="true"]')).toHaveText(expect.stringContaining("zsh"));
  });

  it("mirrors the terminal selected in each pane, each in its own pane", async () => {
    await openSplit();
    await browser.waitUntil(async () => new Set((await callsOf("orca_terminal_read")).map((c) => (c as { handle: string }).handle)).size === 2, { timeoutMsg: "the two terminals were not both read" });
    expect(new Set((await callsOf("orca_terminal_read")).map((c) => (c as { handle: string }).handle))).toEqual(new Set(["term_example-app", "term_example-app_zsh"]));
    expect(await count(".orca-term:not([hidden])")).toBe(2);
    expect(await count(".orca-pane[data-pane='p1'] .orca-term .orca-term-box:not([hidden])")).toBe(1);
    expect(await count(".orca-pane[data-pane='p2'] .orca-term .orca-term-box:not([hidden])")).toBe(1);
    // The terminal of a tab that is not selected waits, and another tab of the pane shows its own.
    await mock("orca_panes", focusedOn("p1", bash));
    await tabOf(bash).$(".orca-tab-btn").click();
    await browser.waitUntil(async () => (await callsOf("orca_terminal_read")).some((c) => (c as { handle: string }).handle === "term_example-app_bash"), { timeoutMsg: "bash was never read" });
  });

  it("sends the keys typed in a pane to the terminal of that pane", async () => {
    await openSplit();
    const input = await mock("orca_terminal_input", null);
    await mock("orca_panes", focusedOn("p2"));
    await pressPane("p2");
    await browser.keys(["c", "d"]);
    await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => (c as { handle: string }).handle === "term_example-app_zsh")).toBe(true);
  });

  it("asks again, with the tabs now listed, when a tab leaves, and draws the layout without its pane", async () => {
    await openSplit();
    // The shell of the second pane is closed in Orca: the list no longer has it, and Rust answers a layout of one pane.
    const panes = await mock("orca_panes", layout(pane("p1", [claude, bash]), "p1"));
    await mock("orca_overview", orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "bash")] }));
    await $("#orca-refresh").click();
    expect(await waitForCalls(panes)).toEqual([{ environment: null, project: "proj_example-app", tabs: [claude, bash], handles: { [claude]: handles[claude], [bash]: handles[bash] }, was: handles, op: null }]);
    await waitForCount(".orca-pane", 1);
    expect(await count(".orca-split-node")).toBe(0);
    expect(await paneTabs("p1")).toEqual(["Write the docs", "bash"]);
    // The terminal of the pane that closed is no longer read.
    await mock("orca_terminal_read", ["$"]);
    await browser.pause(2500);
    expect((await callsOf("orca_terminal_read")).every((c) => (c as { handle: string }).handle !== "term_example-app_zsh")).toBe(true);
  });

  it("keeps the split, the place and the selection of a terminal, and its screen, when Claude starts in a plain terminal and when it ends there again", async () => {
    await openSplit();
    // The shell of the right pane is mirrored; its screen is marked, to tell it from one made again.
    await browser.waitUntil(async () => (await count(".orca-pane[data-pane='p2'] .orca-term .orca-term-box:not([hidden])")) === 1, { timeoutMsg: "the right pane showed no terminal" });
    await browser.execute(() => document.querySelector(".orca-pane[data-pane='p2'] .orca-term .orca-term-box")!.setAttribute("data-mark", "same"));
    // `claude` runs in it: Orca lists the terminal as a Claude session under the same handle, and Rust answers the layout with the tab of the pane replaced.
    const zshClaude = "claude:tab_example-app_zsh:leaf_1";
    const started = await mock("orca_panes", layout(row(pane("p1", [claude, bash]), pane("p2", [zshClaude])), "p2"));
    const sessions = [...sample(), orcaRow("example-app", "feat/a", "Run the tests", { paneKey: "tab_example-app_zsh:leaf_1", handle: "term_example-app_zsh" })];
    await mock("orca_overview", orcaOverview(sessions, worktrees(), { terminals: [orcaTerminal("example-app", "bash")] }));
    await $("#orca-refresh").click();
    expect(await waitForCalls(started)).toEqual([
      { environment: null, project: "proj_example-app", tabs: [claude, zshClaude, bash], handles: { [claude]: handles[claude], [zshClaude]: handles[zsh], [bash]: handles[bash] }, was: handles, op: null },
    ]);
    await browser.waitUntil(async () => (await paneTabs("p2")).join() === "Run the tests", { timeoutMsg: "the right pane did not draw the Claude tab" });
    expect(await count(".orca-pane")).toBe(2);
    expect(await paneTabs("p1")).toEqual(["Write the docs", "bash"]);
    await expect($('.orca-pane[data-pane="p2"] [aria-selected="true"]')).toHaveText(expect.stringContaining("Run the tests"));
    await expect($('.orca-pane[data-pane="p2"] .orca-term .orca-term-box[data-mark="same"]')).toBeDisplayed();
    // Claude ends and the shell is back: the terminal is a plain one again, in the same pane.
    const ended = await mock("orca_panes", saved());
    await mock("orca_overview", overview());
    await $("#orca-refresh").click();
    expect(await waitForCalls(ended)).toEqual([
      { environment: null, project: "proj_example-app", tabs: [claude, zsh, bash], handles, was: { [claude]: handles[claude], [zshClaude]: handles[zsh], [bash]: handles[bash] }, op: null },
    ]);
    await browser.waitUntil(async () => (await paneTabs("p2")).join() === "zsh", { timeoutMsg: "the right pane did not draw the plain tab" });
    expect(await count(".orca-pane")).toBe(2);
    await expect($('.orca-pane[data-pane="p2"] .orca-term .orca-term-box[data-mark="same"]')).toBeDisplayed();
  });

  it("keeps the terminal of a pane shown, and its screen, while Rust's answer to a read where the terminal changed kind has not come", async () => {
    await openSplit();
    await browser.waitUntil(async () => (await count(".orca-pane[data-pane='p2'] .orca-term .orca-term-box:not([hidden])")) === 1, { timeoutMsg: "the right pane showed no terminal" });
    await browser.execute(() => document.querySelector(".orca-pane[data-pane='p2'] .orca-term .orca-term-box")!.setAttribute("data-mark", "same"));
    // `claude` runs in the shell, and the answer still holds the old tab id (the layout of the read before).
    const old = await mock("orca_panes", saved());
    const sessions = [...sample(), orcaRow("example-app", "feat/a", "Run the tests", { paneKey: "tab_example-app_zsh:leaf_1", handle: "term_example-app_zsh" })];
    await mock("orca_overview", orcaOverview(sessions, worktrees(), { terminals: [orcaTerminal("example-app", "bash")] }));
    await $("#orca-refresh").click();
    await waitForCalls(old);
    await browser.waitUntil(async () => (await paneTabs("p2")).join() === "Run the tests", { timeoutMsg: "the right pane did not draw the Claude tab" });
    await expect($('.orca-pane[data-pane="p2"] [aria-selected="true"]')).toHaveText(expect.stringContaining("Run the tests"));
    await expect($('.orca-pane[data-pane="p2"] .orca-term .orca-term-box[data-mark="same"]')).toBeDisplayed();
  });

  it("gives the plus of a pane the focus first and starts the session in the project", async () => {
    await openSplit();
    const panes = await mock("orca_panes", saved());
    const create = await mock("orca_terminal_create", { paneKey: null, handle: "term_new" });
    await pressPlus('.orca-pane[data-pane="p2"] .orca-plus');
    await pickItem("ターミナルを開く");
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-app", environment: null }]);
    expect(await callsOf(panes)).toMatchObject([{ op: { kind: "focus", pane: "p2" } }]);
  });

  it("keeps working with one pane of all the tabs when Rust cannot answer, and shows the message", async () => {
    await openOrca(overview(), { orca_panes: rejects("orca-panes.json を書けません"), orca_terminal_read: ["$"] });
    await project("example-app").click();
    await expect($("#error")).toHaveText("orca-panes.json を書けません");
    await waitForCount(".orca-pane", 1);
    expect(await paneTabs("p1")).toEqual(["Write the docs", "zsh", "bash"]);
  });

  describe("on a saved environment", () => {
    const studioOnly = { target: "Studio", environments: ["Studio"] };
    const viewportOf = (call: unknown) => (call as { viewport: { cols: number; rows: number } }).viewport;
    async function openStudioSplit() {
      await openOrca(orcaOverview([], [], studioOnly));
      await waitForCalls("orca_stream_open");
      await mock("orca_panes", saved());
      await sendStream(streamList(sample(), worktrees(), [orcaTerminal("example-app", "zsh"), orcaTerminal("example-app", "bash")]));
      await project("example-app").click();
      await waitForCount(".orca-pane", 2);
    }

    it("streams the terminal of each pane at its pane's size, and draws each one's events in its own pane", async () => {
      await openStudioSplit();
      const calls = await waitForCalls("orca_stream_terminal", 2);
      expect(calls.map((c) => (c as { handle: string }).handle).sort()).toEqual(["term_example-app", "term_example-app_zsh"]);
      for (const call of calls) {
        expect(viewportOf(call).cols).toBeGreaterThan(20);
        expect(viewportOf(call).rows).toBeGreaterThan(8);
      }
      const nth = (handle: string) => calls.findIndex((c) => (c as { handle: string }).handle === handle);
      await sendTerm({ kind: "snapshot", data: "left screen", cols: 80, rows: 24 }, nth("term_example-app"));
      await sendTerm({ kind: "snapshot", data: "right screen", cols: 80, rows: 24 }, nth("term_example-app_zsh"));
      await browser.waitUntil(async () => (await $('.orca-pane[data-pane="p1"] .xterm-rows').getText()).includes("left screen"), { timeoutMsg: "the left screen never showed" });
      await browser.waitUntil(async () => (await $('.orca-pane[data-pane="p2"] .xterm-rows').getText()).includes("right screen"), { timeoutMsg: "the right screen never showed" });
      expect(await $('.orca-pane[data-pane="p1"] .xterm-rows').getText()).not.toContain("right screen");
      // The keys go to the terminal of the pane they were typed in.
      const input = await mock("orca_stream_input", null);
      await mock("orca_panes", focusedOn("p2"));
      await pressPane("p2");
      await browser.keys(["1"]);
      await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "1", { timeoutMsg: "the keys were not sent" });
      expect(await callsOf(input)).toEqual([{ handle: "term_example-app_zsh", text: "1" }]);
    });

    it("ends the stream of a terminal that leaves its pane's view, and no other", async () => {
      await openStudioSplit();
      await waitForCalls("orca_stream_terminal", 2);
      const close = await mock("orca_stream_terminal_close", null);
      await mock("orca_panes", focusedOn("p1", bash));
      // Another tab in the left pane: its terminal is subscribed and the one it replaces is closed by its handle; the right pane's stream stays.
      await tabOf(bash).$(".orca-tab-btn").click();
      expect(await waitForCalls(close)).toEqual([{ handle: "term_example-app", generation: expect.any(Number) }]);
      await browser.pause(500);
      expect(await callsOf(close)).toEqual([{ handle: "term_example-app", generation: expect.any(Number) }]);
    });

    it("puts a new tab in one pane with all the tabs when a later call for the layout fails, and shows the message", async () => {
      await openStudioSplit();
      await mock("orca_panes", rejects("orca-panes.json を書けません"));
      await sendStream(streamList(sample(), worktrees(), [orcaTerminal("example-app", "zsh"), orcaTerminal("example-app", "bash"), orcaTerminal("example-app", "fish")]));
      await expect($("#error")).toHaveText("orca-panes.json を書けません");
      await waitForCount(".orca-pane", 1);
      expect(await paneTabs("p1")).toEqual(["Write the docs", "zsh", "bash", "fish"]);
    });

    it("sends the new size of the pane whose width changed", async () => {
      await openStudioSplit();
      const calls = await waitForCalls("orca_stream_terminal", 2);
      const viewport = await mock("orca_stream_viewport", null);
      await dragDivider(0.2);
      const sent = await waitForCalls(viewport, 2);
      expect(sent.map((c) => (c as { handle: string }).handle).sort()).toEqual(["term_example-app", "term_example-app_zsh"]);
      expect(viewportOf(sent[0]).cols).toBeGreaterThan(viewportOf(calls[0]).cols);
    });
  });
});

// A-18: the file pane and the editor. Rust reads the folders, reads and saves the text, and decides whether a save went through (unit tests); here the screen is checked: what it asks of Rust, and how it draws the answers.
describe("orca: files and editor (A-18)", () => {
  const claude = claudeTab("example-app");
  const zsh = "orca:term_example-app_zsh";
  const pane = (id: string, tabs: string[], selected = tabs[0]): PaneNode => ({ kind: "pane", id, tabs, selected });
  const layout = (root: PaneNode, focus: string): PaneLayout => ({ root, focus });
  // The entries of the folder `dir`: [name, is a folder, ignored by git]. Rust lists a folder with no entry marked unless the folder itself is ignored (the third is then true); the marks of the others come from `orca_files_ignored`.
  const dirOf = (dir: string, entries: [string, boolean, boolean?][]): OrcaDir => ({
    entries: entries.map(([name, isDirectory, ignored = false]) => ({ name, path: dir === "" ? name : `${dir}/${name}`, isDirectory, ignored })),
    total: entries.length,
  });
  const root = () =>
    dirOf("", [
      ["src", true],
      ["target", true],
      ["a.rs", false],
      ["b.log", false],
    ]);
  // What `orca_files_ignored` answers for the root.
  const rootIgnored = ["target", "b.log"];
  const isIgnored = (path: string) => browser.execute((p) => document.querySelector<HTMLElement>(`.orca-file[data-path="${p}"]`)?.dataset.ignored, path);
  const text = (content: string, signature = "sig-1", language = "plaintext", highlight: string | null = null): OrcaFileText => ({ content, crlf: false, signature, language, highlight });
  const saved = (signature: string): OrcaSaved => ({ state: "saved", signature });
  const names = () => textsOf("#orca-files-tree .orca-file-name");
  // The button of the file pane that is on the screen (one at a time: the corner pane's while the pane is hidden, the pane's own while it is shown).
  const filesToggle = () => $(".orca-files-toggle:not([hidden])");
  const toggleBoxes = () =>
    browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>(".orca-files-toggle")]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { top: r.top, right: r.right, bottom: r.bottom, inFiles: e.closest("#orca-files") !== null, pressed: e.getAttribute("aria-pressed"), label: e.getAttribute("aria-label") };
        }),
    );
  const row = (path: string) => $(`#orca-files-tree .orca-file[data-path="${path}"]`);
  const stateText = () => $(".orca-edit-state");
  const dirtyMarks = () => count(".orca-tab-dirty");

  // The app with the example-app project selected, its Claude session the selected tab, the file pane open and its root read.
  async function openFiles(fixtures: Record<string, unknown> = {}, value = orcaOverview(sample(), worktrees())) {
    await openOrca(value, { orca_terminal_read: ["$"], orca_files_list: root(), orca_files_ignored: rootIgnored, editor_settings: { autosaveMs: 100 }, ...fixtures });
    await project("example-app").click();
    await expect(selectedTab()).toBeDisplayed();
    await filesToggle().click();
    await expect($("#orca-files")).toBeDisplayed();
  }

  // The page's own double press on a file of the tree, and typing in the editor shown (value, then input).
  const doublePress = (path: string) =>
    browser.execute(
      (p, once) => {
        if (!window.__e2e_once__(once)) return;
        document.querySelector(`.orca-file[data-path="${p}"]`)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      },
      path,
      onceId(),
    );
  const type = (add: string) =>
    browser.execute(
      (t, once) => {
        if (!window.__e2e_once__(once)) return;
        const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
        area.value += t;
        area.dispatchEvent(new Event("input", { bubbles: true }));
      },
      add,
      onceId(),
    );
  // Opens a.rs with the answer of the read and waits for its text.
  async function openFileWith(read: OrcaFileText, rows = 4) {
    await mock("orca_file_read", read);
    await waitForCount("#orca-files-tree .orca-file", rows);
    await doublePress("a.rs");
    await expect($(".orca-edit-area")).toHaveValue(read.content, { trim: false });
  }
  // Opens a.rs with `content` and waits for its text (`rows` is how many rows the tree has).
  const openA = (content = "fn main() {}\n", signature = "sig-1", rows = 4) => openFileWith(text(content, signature), rows);

  it("draws the text of the editor with the family and size chosen in the settings (A-20), apart from the terminals", async () => {
    await openFiles({ font_settings: fontSettings({ editor: { family: "Menlo", size: 18, ghostty: false }, orcaWork: { family: null, size: 13, ghostty: false } }) });
    await openA();
    const area = () => browser.execute(() => ({ size: getComputedStyle(document.querySelector(".orca-edit-area")!).fontSize, family: getComputedStyle(document.querySelector(".orca-edit-area")!).fontFamily }));
    await browser.waitUntil(async () => (await area()).size === "18px", { timeoutMsg: "the editor never took the size" });
    expect((await area()).family).toContain("Menlo");
  });

  it("draws the heading of the editor with the family and size chosen for the work pane, and the text with those of the editor (A-20)", async () => {
    await openFiles({ font_settings: fontSettings({ orcaPane: { family: "Menlo", size: 21, ghostty: false } }) });
    await openA();
    const head = () => browser.execute(() => ({ size: getComputedStyle(document.querySelector(".orca-edit-head")!).fontSize, family: getComputedStyle(document.querySelector(".orca-edit-head")!).fontFamily }));
    // The heading is 12px of its own: 12 * 21 / 14.
    await browser.waitUntil(async () => (await head()).size === "18px", { timeoutMsg: "the heading never took the size" });
    expect((await head()).family).toContain("Menlo");
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".orca-edit-area")!).fontSize)).toBe("12.5px");
  });

  it("keeps the text of the tab bar, the tabs, the file pane's heading and the editor's heading inside their boxes at the largest size of the work pane (A-20)", async () => {
    await openFiles({ font_settings: fontSettings({ orcaPane: { family: null, size: 32, ghostty: false } }) });
    await openA();
    await browser.waitUntil(async () => (await browser.execute(() => getComputedStyle(document.getElementById("orca-work")!).fontSize)) === "32px", { timeoutMsg: "the work pane never took the size" });
    const outside = await browser.execute(() => {
      const pairs: [string, string][] = [
        [".orca-tabbar", ".orca-tab"],
        [".orca-tab", ".orca-tab-title"],
        ["#orca-files-head", "#orca-files-title"],
        [".orca-edit-head", ".orca-edit-path"],
        [".orca-edit-head", ".orca-edit-state"],
      ];
      const found: string[] = [];
      let checked = 0;
      for (const [box, text] of pairs) {
        for (const t of document.querySelectorAll(`${box} ${text}`)) {
          const b = t.closest(box)!.getBoundingClientRect();
          const r = t.getBoundingClientRect();
          checked++;
          if (r.height > 0 && (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5)) found.push(`${text} in ${box}`);
        }
      }
      return { found, checked };
    });
    expect(outside.checked).toBeGreaterThanOrEqual(5);
    expect(outside.found).toEqual([]);
  });

  it("draws the text of the editor with the first font while none is chosen", async () => {
    await openFiles();
    await openA();
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".orca-edit-area")!).fontSize)).toBe("12.5px");
  });

  // A-21: the colors of the editor. The language is Rust's (`orca_file_read` answers `language` and `highlight`); the tokens are the highlighter's elements under the textarea.
  const tokens = (kind: string) => textsOf(`.orca-edit-hl .hljs-${kind}`);
  const layerText = () => browser.execute(() => document.querySelector(".orca-edit-hl")!.textContent);
  const rust = (content: string) => text(content, "sig-1", "rust", "rust");

  it("colors the text of a file by its language, in a layer under the textarea that holds the same text (A-21)", async () => {
    await openFiles();
    await openFileWith(rust('fn main() {\n    let x = "a"; // note\n}\n'));
    expect(await tokens("keyword")).toEqual(["fn", "let"]);
    expect(await tokens("string")).toEqual(['"a"']);
    expect(await tokens("comment")).toEqual(["// note"]);
    expect(await layerText()).toBe('fn main() {\n    let x = "a"; // note\n}\n');
    await expect($(".orca-edit-hl")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows the colors of the tokens and the caret of the textarea, whose own text is transparent (A-21)", async () => {
    await openFiles();
    await openFileWith(rust("fn a() {}\n"));
    const colors = await browser.execute(() => ({
      keyword: getComputedStyle(document.querySelector(".orca-edit-hl .hljs-keyword")!).color,
      plain: getComputedStyle(document.querySelector(".orca-edit-hl code")!).color,
      area: getComputedStyle(document.querySelector(".orca-edit-area")!).color,
    }));
    expect(colors.keyword).toBe("rgb(207, 34, 46)");
    expect(colors.area).toBe("rgba(0, 0, 0, 0)");
    expect(colors.plain).not.toBe(colors.keyword);
  });

  it("draws the text plain, in the same layer, for a language the highlighter has no grammar for (A-21)", async () => {
    await openFiles();
    await openFileWith(text("const std = @import(\"std\");\n", "sig-1", "zig", null));
    expect(await count(".orca-edit-hl [class^='hljs-']")).toBe(0);
    expect(await layerText()).toBe('const std = @import("std");\n');
  });

  it("escapes the text of the file in the layer, so a tag in it stays text (A-21)", async () => {
    await openFiles();
    await openFileWith(text('<img src=x onerror="alert(1)"> &amp;\n', "sig-1", "plaintext", null));
    expect(await count(".orca-edit-hl img")).toBe(0);
    expect(await layerText()).toBe('<img src=x onerror="alert(1)"> &amp;\n');
  });

  it("colors the text again at each key, and the layer keeps the text of the textarea (A-21)", async () => {
    await openFiles();
    await openFileWith(rust("let a = 1;\n"));
    expect(await tokens("comment")).toEqual([]);
    await type("// typed\n");
    await browser.waitUntil(async () => (await tokens("comment")).length === 1, { timeoutMsg: "the typed line was never colored" });
    expect(await tokens("comment")).toEqual(["// typed"]);
    expect(await layerText()).toBe("let a = 1;\n// typed\n");
  });

  it("moves the layer with the scroll of the textarea (A-21)", async () => {
    await openFiles();
    await openFileWith(rust("let a = 1;\n".repeat(200)));
    await browser.execute(() => {
      const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
      area.scrollTop = 48;
      area.dispatchEvent(new Event("scroll"));
    });
    const moved = await browser.execute(() => document.querySelector<HTMLElement>(".orca-edit-hl code")!.style.transform);
    expect(moved.replace(/\s/g, "")).toBe("translate(0px,-48px)");
  });

  // A-18: the numbers of the lines, in a box at the left of the text (`.orca-edit-gutter`, one text node of the numbers in lines).
  const numbers = () => browser.execute(() => document.querySelector(".orca-edit-nums")!.textContent!.split("\n"));
  const countTo = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
  const gutterWidth = () => browser.execute(() => document.querySelector(".orca-edit-gutter")!.getBoundingClientRect().width);
  // The textarea's value set to `value`, as a deletion would.
  const setText = (value: string) =>
    browser.execute(
      (v, once) => {
        if (!window.__e2e_once__(once)) return;
        const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
        area.value = v;
        area.dispatchEvent(new Event("input", { bubbles: true }));
      },
      value,
      onceId(),
    );

  it("numbers the lines of the text from 1, one number for each line, in the font of the text and in a fainter color (A-18)", async () => {
    await openFiles();
    await openA("fn main() {\n    run();\n}\n");
    // The empty line after the last line break is a line of the textarea, and has its number.
    expect(await numbers()).toEqual(["1", "2", "3", "4"]);
    const look = await browser.execute(() => {
      const g = getComputedStyle(document.querySelector(".orca-edit-gutter")!);
      const a = getComputedStyle(document.querySelector(".orca-edit-area")!);
      const h = getComputedStyle(document.querySelector(".orca-edit-hl code")!);
      return { gutter: [g.fontFamily, g.fontSize, g.lineHeight, g.color, g.textAlign], area: [a.fontFamily, a.fontSize, a.lineHeight, a.color], code: h.color };
    });
    expect(look.gutter.slice(0, 3)).toEqual(look.area.slice(0, 3));
    expect(look.gutter[4]).toBe("right");
    expect(look.gutter[3]).not.toBe(look.code);
    expect(look.gutter[3]).toBe("rgb(90, 107, 98)");
  });

  it("numbers the lines with the family and size chosen for the editor (A-18, A-20)", async () => {
    await openFiles({ font_settings: fontSettings({ editor: { family: "Menlo", size: 18, ghostty: false }, orcaWork: { family: null, size: 13, ghostty: false } }) });
    await openA("a\nb\n");
    await browser.waitUntil(async () => (await browser.execute(() => getComputedStyle(document.querySelector(".orca-edit-gutter")!).fontSize)) === "18px", { timeoutMsg: "the numbers never took the size" });
    const font = await browser.execute(() => ({ gutter: getComputedStyle(document.querySelector(".orca-edit-gutter")!).fontFamily, area: getComputedStyle(document.querySelector(".orca-edit-area")!).fontFamily }));
    expect(font.gutter).toContain("Menlo");
    expect(font.gutter).toBe(font.area);
  });

  it("keeps the numbers in step with the lines as they are typed and deleted, and widens the box with the digits (A-18)", async () => {
    await openFiles();
    await openA("1\n2\n3\n4\n5\n6\n7\n8\n");
    expect(await numbers()).toEqual(countTo(9));
    const narrow = await gutterWidth();
    await type("9\n");
    await browser.waitUntil(async () => (await numbers()).length === 10, { timeoutMsg: "the numbers never grew" });
    expect(await numbers()).toEqual(countTo(10));
    expect(await gutterWidth()).toBeGreaterThan(narrow);
    await setText("1\n2\n3\n");
    await browser.waitUntil(async () => (await numbers()).length === 4, { timeoutMsg: "the numbers never shrank" });
    expect(await numbers()).toEqual(countTo(4));
    expect(await gutterWidth()).toBe(narrow);
    // Typing inside a line changes no number.
    await setText("1\n2x\n3\n");
    expect(await numbers()).toEqual(countTo(4));
    // An empty text is one line.
    await setText("");
    await browser.waitUntil(async () => (await numbers()).length === 1, { timeoutMsg: "the numbers never came back to one" });
    expect(await numbers()).toEqual(["1"]);
  });

  it("numbers a long text, and one line more at a key (A-18)", async () => {
    await openFiles();
    await openA("x\n".repeat(5000));
    expect(await numbers()).toEqual(countTo(5001));
    await type("y\n");
    await browser.waitUntil(async () => (await numbers()).length === 5002, { timeoutMsg: "the numbers never grew" });
    expect(await numbers()).toEqual(countTo(5002));
  });

  it("moves the numbers with the vertical scroll of the text and not with the horizontal one (A-18)", async () => {
    await openFiles();
    await openA(`${"x".repeat(400)}\n`.repeat(200));
    const before = await browser.execute(() => document.querySelector(".orca-edit-gutter")!.getBoundingClientRect().left);
    await browser.execute(() => {
      const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
      area.scrollTop = 48;
      area.scrollLeft = 60;
      area.dispatchEvent(new Event("scroll"));
    });
    const moved = await browser.execute(() => {
      const nums = document.querySelector<HTMLElement>(".orca-edit-nums")!;
      return { transform: nums.style.transform, left: document.querySelector(".orca-edit-gutter")!.getBoundingClientRect().left, numsLeft: nums.getBoundingClientRect().left };
    });
    expect(moved.transform.replace(/\s/g, "")).toBe("translateY(-48px)");
    expect(moved.left).toBe(before);
    expect(moved.numsLeft).toBe(before);
    // The first number of the rows still in view sits on the line of the text it numbers: the text is 48 px up, and so are the numbers.
    const rows = await browser.execute(() => {
      const nums = document.querySelector(".orca-edit-nums")!.getBoundingClientRect();
      const gutter = document.querySelector(".orca-edit-gutter")!.getBoundingClientRect();
      return { up: gutter.top - nums.top };
    });
    expect(rows.up).toBe(48);
  });

  it("forwards the wheel over the numbers to the text (A-18)", async () => {
    await openFiles();
    await openA("x\n".repeat(300));
    await browser.execute((once) => {
      if (!window.__e2e_once__(once)) return;
      document.querySelector(".orca-edit-gutter")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 64, bubbles: true, cancelable: true }));
    }, onceId());
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.scrollTop)) === 64, { timeoutMsg: "the text never scrolled" });
    // The numbers follow at the scroll event, which comes after the scroll itself.
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector<HTMLElement>(".orca-edit-nums")!.style.transform.replace(/\s/g, ""))) === "translateY(-64px)", { timeoutMsg: "the numbers never followed" });
  });

  it("keeps the numbers out of the selection, the copy and the reading aloud, and out of the textarea (A-18)", async () => {
    await openFiles();
    await openA("alpha\nbeta\n");
    const gutter = await browser.execute(() => {
      const g = document.querySelector<HTMLElement>(".orca-edit-gutter")!;
      const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
      area.focus();
      area.select();
      return { hidden: g.getAttribute("aria-hidden"), userSelect: getComputedStyle(g).getPropertyValue("-webkit-user-select"), inArea: area.contains(g), selected: area.value.slice(area.selectionStart, area.selectionEnd), value: area.value };
    });
    expect(gutter.hidden).toBe("true");
    expect(gutter.userSelect).toBe("none");
    expect(gutter.inArea).toBe(false);
    // What a copy of the text takes is the text and nothing of the numbers.
    expect(gutter.selected).toBe("alpha\nbeta\n");
    expect(gutter.value).toBe("alpha\nbeta\n");
  });

  it("colors a long text after it is read, and draws it again with the typed line within the wait (A-21)", async () => {
    await openFiles();
    const long = "let a = 1;\n".repeat(3000);
    await openFileWith(rust(long));
    await browser.waitUntil(async () => (await count(".orca-edit-hl .hljs-keyword")) > 0, { timeoutMsg: "the long text was never colored" });
    await type("let b = 2;\n");
    await browser.waitUntil(async () => (await tokens("keyword")).length === 3001, { timeoutMsg: "the typed line was never colored" });
    expect(await layerText()).toBe(`${long}let b = 2;\n`);
  });

  it("has the colors in variables of the page, apart from the layout (A-21)", async () => {
    await openFiles();
    await openFileWith(rust("fn a() {}\n"));
    await browser.execute(() => document.documentElement.style.setProperty("--hl-keyword", "rgb(1, 2, 3)"));
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".orca-edit-hl .hljs-keyword")!).color)).toBe("rgb(1, 2, 3)");
  });

  it("has one button that shows and hides the file pane: in the upper row of the pane while it is shown, at the right end of the tab strip while it is hidden", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_terminal_read: ["$"] });
    await expect($("#orca-files")).not.toBeDisplayed();
    await expect($("#orca-files-split")).not.toBeDisplayed();
    const hidden = await toggleBoxes();
    expect(hidden).toHaveLength(1);
    expect(hidden[0].inFiles).toBe(false);
    expect(hidden[0].pressed).toBe("false");
    expect(hidden[0].label).toBe("ファイル欄");
    await mock("orca_files_list", root());
    await project("example-app").click();
    await filesToggle().click();
    await expect($("#orca-files")).toBeDisplayed();
    await expect($("#orca-files-split")).toBeDisplayed();
    const shown = await toggleBoxes();
    expect(shown).toHaveLength(1);
    expect(shown[0].inFiles).toBe(true);
    expect(shown[0].pressed).toBe("true");
    expect(shown[0].label).toBe("ファイル欄");
    const box = await browser.execute(() => {
      const r = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { workRight: r("#orca-work").right, splitLeft: r("#orca-files-split").left, splitRight: r("#orca-files-split").right, filesLeft: r("#orca-files").left, filesRight: r("#orca-files").right, share: r("#orca-files").width / r("#orca").width, barTop: r("#orca-files-bar").top, barHeight: r("#orca-files-bar").height, headTop: r("#orca-files-head").top, headBottom: r("#orca-files-head").bottom, tabsTop: r(".orca-tabbar").top, tabs: r(".orca-tabbar").height, toggleRight: r("#orca-files-toggle").right, reloadRight: r("#orca-files-reload").right };
    });
    expect(box.workRight).toBeLessThanOrEqual(box.splitLeft + 1);
    expect(box.splitRight).toBeLessThanOrEqual(box.filesLeft + 1);
    expect(box.share).toBeCloseTo(0.22, 2);
    // The upper row is as high as the tab strip and level with it; the heading is under it. The button is at the right end of the row.
    expect(box.barHeight).toBe(box.tabs);
    expect(box.barTop).toBe(box.tabsTop);
    expect(box.headTop).toBeGreaterThanOrEqual(box.barTop + box.barHeight - 1);
    expect(box.toggleRight).toBeLessThanOrEqual(box.filesRight);
    expect(box.filesRight - box.toggleRight).toBeLessThanOrEqual(8);
    expect(box.reloadRight).toBeLessThanOrEqual(box.filesRight);
    await filesToggle().click();
    await expect($("#orca-files")).not.toBeDisplayed();
    await expect($("#orca-files-split")).not.toBeDisplayed();
    const back = await toggleBoxes();
    expect(back).toHaveLength(1);
    expect(back[0].inFiles).toBe(false);
    expect(back[0].pressed).toBe("false");
    const corner = await browser.execute(() => {
      const bar = document.querySelector(".orca-tabbar")!.getBoundingClientRect();
      const toggle = document.querySelector(".orca-tabbar .orca-files-toggle:not([hidden])")!.getBoundingClientRect();
      const plus = document.querySelector(".orca-plus")!.getBoundingClientRect();
      return { barRight: bar.right, toggleRight: toggle.right, plusRight: plus.right };
    });
    expect(corner.toggleRight).toBeLessThanOrEqual(corner.barRight);
    expect(corner.toggleRight).toBeGreaterThan(corner.plusRight);
  });

  it("moves the focus to the button that is shown when the focused button is pressed", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_terminal_read: ["$"] });
    await mock("orca_files_list", root());
    await project("example-app").click();
    await $(".orca-tabbar [data-tab]").waitForDisplayed();
    // A press from the keyboard is a click on the focused button; the shown terminal would take the keys of WebDriver, so the click is made on the focused button itself.
    const pressFocused = (selector: string) =>
      browser.execute((s) => {
        const b = document.querySelector<HTMLElement>(s)!;
        b.focus();
        b.click();
        const a = document.activeElement;
        return { files: a?.closest("#orca-files") !== null, tabs: a?.closest(".orca-tabbar") !== null, toggle: a?.classList.contains("orca-files-toggle") ?? false };
      }, selector);
    const shown = await pressFocused(".orca-tabbar .orca-files-toggle:not([hidden])");
    await expect($("#orca-files")).toBeDisplayed();
    expect(shown).toEqual({ files: true, tabs: false, toggle: true });
    const hidden = await pressFocused("#orca-files-toggle");
    await expect($("#orca-files")).not.toBeDisplayed();
    expect(hidden).toEqual({ files: false, tabs: true, toggle: true });
  });

  it("puts the button in the pane in the top right corner only", async () => {
    const two = orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "zsh")] });
    const side = layout({ kind: "split", direction: "row", children: [pane("p1", [claude]), pane("p2", [zsh])] }, "p1");
    await openOrca(two, { orca_terminal_read: ["$"], orca_panes: side });
    await project("example-app").click();
    await waitForCount(".orca-pane", 2);
    await expect($('.orca-pane[data-pane="p1"] .orca-files-toggle')).not.toBeDisplayed();
    await expect($('.orca-pane[data-pane="p2"] .orca-files-toggle')).toBeDisplayed();
    expect(await toggleBoxes()).toHaveLength(1);
    const stacked = layout({ kind: "split", direction: "column", children: [pane("p1", [claude]), pane("p2", [zsh])] }, "p1");
    await openOrca(two, { orca_terminal_read: ["$"], orca_panes: stacked });
    await project("example-app").click();
    await waitForCount(".orca-pane", 2);
    await expect($('.orca-pane[data-pane="p1"] .orca-files-toggle')).toBeDisplayed();
    await expect($('.orca-pane[data-pane="p2"] .orca-files-toggle')).not.toBeDisplayed();
    expect(await toggleBoxes()).toHaveLength(1);
  });

  it("shows the heading of the selected session's worktree, reads its root, and draws the folders first, with the ignored ones in italics once git has answered", async () => {
    await openFiles({ orca_files_ignored: holds });
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/a");
    await waitForCount("#orca-files-tree .orca-file", 4);
    expect(await callsOf("orca_files_list")).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    // The folder is drawn while git has not answered: nothing is marked yet, and the question is the entries of the list in its order.
    expect(await waitForCalls("orca_files_ignored")).toEqual([{ path: "/work/example-app", paths: ["src", "target", "a.rs", "b.log"], environment: null }]);
    const kinds = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>(".orca-file")].map((e) => [e.dataset.kind, e.dataset.ignored]));
    expect(await kinds()).toEqual([["dir", "false"], ["dir", "false"], ["file", "false"], ["file", "false"]]);
    await release("orca_files_ignored", rootIgnored);
    await browser.waitUntil(async () => (await isIgnored("b.log")) === "true", { timeoutMsg: "the ignored mark never came" });
    expect(await kinds()).toEqual([["dir", "false"], ["dir", "true"], ["file", "false"], ["file", "true"]]);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    const look = await browser.execute(() => {
      const style = (path: string) => getComputedStyle(document.querySelector(`.orca-file[data-path="${path}"] .orca-file-name`)!);
      const row = (path: string) => getComputedStyle(document.querySelector(`.orca-file[data-path="${path}"]`)!);
      return { plain: style("a.rs").fontStyle, ignored: style("b.log").fontStyle, plainOpacity: row("a.rs").opacity, ignoredOpacity: row("b.log").opacity };
    });
    expect(look).toEqual({ plain: "normal", ignored: "italic", plainOpacity: "1", ignoredOpacity: "0.55" });
  });

  it("marks nothing when git cannot answer, and shows no message for it", async () => {
    await openFiles({ orca_files_ignored: rejects("Orca に接続できません") });
    await waitForCount("#orca-files-tree .orca-file", 4);
    await waitForCalls("orca_files_ignored");
    await browser.pause(300);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    expect(await isIgnored("target")).toBe("false");
    expect(await count("#orca-files-tree .orca-file-note")).toBe(0);
  });

  it("reads a folder when it is pressed the first time, and draws it from what was read when it is opened again", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const list = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "src", ignored: false, environment: null }]);
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await names()).toEqual(["src", "lib", "main.rs", "target", "a.rs", "b.log"]);
    // A child is one level in.
    const depths = await browser.execute(() => ["src", "src/lib"].map((p) => document.querySelector<HTMLElement>(`.orca-file[data-path="${p}"]`)!.style.getPropertyValue("--depth")));
    expect(depths).toEqual(["0", "1"]);
    await row("src").click();
    await expect(row("src")).toHaveAttribute("aria-expanded", "false");
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    // Opened again, it is drawn at once from the list that is held: neither the folder nor its marks are asked for again.
    const marks = await mock("orca_files_ignored", ["src/lib"]);
    await row("src").click();
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await names()).toEqual(["src", "lib", "main.rs", "target", "a.rs", "b.log"]);
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(1);
    expect(await callsOf(marks)).toEqual([]);
  });

  it("reads the root and the open folders again with the reload button", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 5);
    const list = await mock("orca_files_list", dirOf("", [["src", true], ["new.rs", false]]));
    await expect($("#orca-files-reload")).toHaveAttribute("aria-label", "ファイルを読み直す");
    await $("#orca-files-reload").click();
    const calls = await waitForCalls(list, 2);
    expect(calls).toEqual([
      { path: "/work/example-app", dir: "", ignored: false, environment: null },
      { path: "/work/example-app", dir: "src", ignored: false, environment: null },
    ]);
  });

  it("reads the root alone first, then the open folders again side by side, not one after the other", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 5);
    await mock("orca_files_list", dirOf("src/lib", [["x", false]]));
    await row("src/lib").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    const list = await mock("orca_files_list", holds);
    await $("#orca-files-reload").click();
    // Only the root is on its way while it has not been answered.
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(1);
    await release(list, dirOf("", [["src", true], ["target", true]]));
    // Both folders are on their way while neither has been answered.
    expect(await waitForCalls(list, 3)).toEqual([
      { path: "/work/example-app", dir: "", ignored: false, environment: null },
      { path: "/work/example-app", dir: "src", ignored: false, environment: null },
      { path: "/work/example-app", dir: "src/lib", ignored: false, environment: null },
    ]);
    await release(list, dirOf("src", [["lib", true]]));
    await release(list, dirOf("src/lib", [["y", false]]));
    await browser.waitUntil(async () => (await names()).join() === "src,lib,y,target", { timeoutMsg: "the reads never drew" });
  });

  it("reads at most 16 folders at once, after the root, when the reload button is pressed", async () => {
    const folders = Array.from({ length: 17 }, (_, i) => `d${i}`);
    await openFiles({ orca_files_list: dirOf("", folders.map((f) => [f, true])) });
    await waitForCount("#orca-files-tree .orca-file", 17);
    for (const f of folders) {
      const list = await mock("orca_files_list", dirOf(f, [["x", false]]));
      await row(f).click();
      await waitForCalls(list);
    }
    await waitForCount("#orca-files-tree .orca-file", 34);
    const list = await mock("orca_files_list", holds);
    await $("#orca-files-reload").click();
    await waitForCalls(list);
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(1);
    await release(list, dirOf("", folders.map((f) => [f, true])));
    await waitForCalls(list, 17);
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(17);
    // One answer frees one place, and the last folder is read.
    await release(list, dirOf("d0", [["x", false]]));
    expect(await waitForCalls(list, 18)).toHaveLength(18);
  });

  it("keeps the ignored marks through a reload until git answers, and keeps them when git cannot", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await browser.waitUntil(async () => (await isIgnored("b.log")) === "true", { timeoutMsg: "the ignored mark never came" });
    const marks = await mock("orca_files_ignored", holds);
    await $("#orca-files-reload").click();
    await waitForCalls(marks);
    await browser.pause(300);
    expect(await isIgnored("b.log")).toBe("true");
    expect(await isIgnored("target")).toBe("true");
    expect(await isIgnored("a.rs")).toBe("false");
    // The answer replaces the marks: b.log is no longer named.
    await release(marks, ["target"]);
    await browser.waitUntil(async () => (await isIgnored("b.log")) === "false", { timeoutMsg: "the answer never replaced the marks" });
    expect(await isIgnored("target")).toBe("true");
    // An answer that fails leaves the kept marks.
    const failing = await mock("orca_files_ignored", rejects("Orca に接続できません"));
    await $("#orca-files-reload").click();
    await waitForCalls(failing);
    await browser.pause(300);
    expect(await isIgnored("target")).toBe("true");
  });

  it("reads a folder that was closed again after the reload button, because the reload dropped it", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 5);
    await row("src").click();
    await expect(row("src")).toHaveAttribute("aria-expanded", "false");
    const list = await mock("orca_files_list", dirOf("", [["src", true], ["target", true]]));
    await $("#orca-files-reload").click();
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "src,target", { timeoutMsg: "the root never drew" });
    const inner = await mock("orca_files_list", dirOf("src", [["new.rs", false]]));
    await row("src").click();
    expect(await waitForCalls(inner)).toEqual([{ path: "/work/example-app", dir: "src", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "src,new.rs,target", { timeoutMsg: "the folder was not read again" });
  });

  it("does not ask for the ignore marks of a folder that the list marked as ignored", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await browser.waitUntil(async () => (await isIgnored("target")) === "true", { timeoutMsg: "the ignored mark never came" });
    const marks = await mock("orca_files_ignored", []);
    const list = await mock("orca_files_list", dirOf("target", [["debug", true, true]]));
    await row("target").click();
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "target", ignored: true, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 5);
    expect(await isIgnored("target/debug")).toBe("true");
    // A folder in it is ignored as well, and is read as one.
    const inner = await mock("orca_files_list", dirOf("target/debug", [["x", false, true]]));
    await row("target/debug").click();
    expect(await waitForCalls(inner)).toEqual([{ path: "/work/example-app", dir: "target/debug", ignored: true, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 6);
    await browser.pause(300);
    expect(await callsOf(marks)).toEqual([]);
  });

  it("asks for the ignore marks of a folder that is opened, after it is drawn", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const marks = await mock("orca_files_ignored", ["src/gen.rs"]);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["gen.rs", false]]));
    await row("src").click();
    expect(await waitForCalls(marks)).toEqual([{ path: "/work/example-app", paths: ["src/lib", "src/gen.rs"], environment: null }]);
    await browser.waitUntil(async () => (await isIgnored("src/gen.rs")) === "true", { timeoutMsg: "the ignored mark never came" });
    expect(await isIgnored("src/lib")).toBe("false");
  });

  it("drops the ignore marks that come after another worktree's tree took the place", async () => {
    const value = orcaOverview(sample(), [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b" })], {
      terminals: [orcaTerminal("example-app", "zsh", { path: "/work/example-app-b", branch: "feat/b" })],
    });
    await openFiles({ orca_files_ignored: holds }, value);
    await waitForCount("#orca-files-tree .orca-file", 4);
    await waitForCalls("orca_files_ignored");
    const list = await mock("orca_files_list", dirOf("", [["target", true]]));
    await tabOf(zsh).$(".orca-tab-btn").click();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/b");
    await waitForCalls(list);
    await browser.waitUntil(async () => (await names()).join() === "target", { timeoutMsg: "the tree of the other worktree never showed" });
    // The answer for the first worktree comes now, and names a path the new tree has too.
    await release("orca_files_ignored", ["target"]);
    await browser.pause(300);
    expect(await isIgnored("target")).toBe("false");
  });

  it("shows another worktree's tree, and its name, when another tab is selected", async () => {
    const value = orcaOverview(sample(), [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b" })], {
      terminals: [orcaTerminal("example-app", "zsh", { path: "/work/example-app-b", branch: "feat/b" })],
    });
    await openFiles({}, value);
    await waitForCount("#orca-files-tree .orca-file", 4);
    const list = await mock("orca_files_list", dirOf("", [["only-b.rs", false]]));
    await tabOf(zsh).$(".orca-tab-btn").click();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/b");
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app-b", dir: "", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "only-b.rs", { timeoutMsg: "the tree of the other worktree never showed" });
  });

  // example-idle has no session (so no tab), and lists a worktree that is not the main one before the main one; example-app has a Claude session in a worktree that is not the main one.
  const withIdle = (extra: Record<string, unknown> = {}, more: ReturnType<typeof orcaWorktree>[] = []) =>
    orcaOverview(
      [orcaRow("example-app", "feat/b", "Write the docs", { path: "/work/example-app-b" })],
      [
        orcaWorktree("example-app", "main"),
        orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b" }),
        orcaWorktree("example-idle", "feat/z", { path: "/work/example-idle-z" }),
        orcaWorktree("example-idle", "main"),
        ...more,
      ],
      extra,
    );

  it("shows the main worktree of the selected project when it has no tab, and the selected tab's worktree once a project with a tab is selected", async () => {
    await openOrca(withIdle(), { orca_terminal_read: ["$"], orca_files_list: root() });
    await project("example-idle").click();
    await expect($(".orca-empty")).toHaveText("セッションはありません");
    await filesToggle().click();
    await expect($("#orca-files-title")).toHaveText("example-idle ・ main");
    await waitForCount("#orca-files-tree .orca-file", 4);
    expect(await callsOf("orca_files_list")).toEqual([{ path: "/work/example-idle", dir: "", ignored: false, environment: null }]);
    const list = await mock("orca_files_list", dirOf("", [["only-b.rs", false]]));
    await project("example-app").click();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/b");
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app-b", dir: "", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "only-b.rs", { timeoutMsg: "the tree of the selected tab never showed" });
  });

  it("opens a file of the main worktree in a tab when the project has no tab", async () => {
    await openOrca(withIdle(), { orca_terminal_read: ["$"], orca_files_list: root(), editor_settings: { autosaveMs: 100 } });
    await project("example-idle").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const read = await mock("orca_file_read", text("fn main() {}\n"));
    await doublePress("a.rs");
    expect(await waitForCalls(read)).toEqual([{ path: "/work/example-idle", relative: "a.rs", environment: null }]);
    await expect(selectedTab().$(".orca-tab-title")).toHaveText("a.rs");
    await expect($("#orca-files-title")).toHaveText("example-idle ・ main");
  });

  it("keeps the open folders and does not read the root again when the first file of a project with no tab is opened", async () => {
    await openOrca(withIdle(), { orca_terminal_read: ["$"], orca_files_list: root(), editor_settings: { autosaveMs: 100 } });
    await project("example-idle").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const inner = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCalls(inner);
    await waitForCount("#orca-files-tree .orca-file", 6);
    const list = await mock("orca_files_list", root());
    const read = await mock("orca_file_read", text("fn main() {}\n"));
    await doublePress("src/main.rs");
    expect(await waitForCalls(read)).toEqual([{ path: "/work/example-idle", relative: "src/main.rs", environment: null }]);
    await expect(selectedTab().$(".orca-tab-title")).toHaveText("main.rs");
    await expect($("#orca-files-title")).toHaveText("example-idle ・ main");
    expect(await names()).toEqual(["src", "lib", "main.rs", "target", "a.rs", "b.log"]);
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await callsOf(list)).toEqual([]);
  });

  it("leaves the pane empty for a project with no tab when the row cannot be read, as an SSH host's", async () => {
    const hostRow = { key: "ssh:s1", name: "s1", status: "idle" as const, sessions: 0, atMs: 0 };
    const hostTree = orcaWorktree("remote-app", "main", { path: "/home/dev/remote-app", projectKey: "ssh:s1", isMain: true });
    await openOrca(withIdle({ ssh: [orcaSsh("s1", "example-host")], hosts: [hostRow] }, [hostTree]), { orca_terminal_read: ["$"], orca_files_list: root() });
    await project("example-idle").click();
    await filesToggle().click();
    await expect($("#orca-files-title")).toHaveText("example-idle ・ main");
    const list = await mock("orca_files_list", root());
    await $('#orca-feed .orca-project[data-key="ssh:s1"]').click();
    await expect($("#orca-files-title")).toHaveText("");
    expect(await count("#orca-files-tree .orca-file")).toBe(0);
    await expect($("#orca-files-reload")).toBeDisabled();
    expect(await callsOf(list)).toEqual([]);
  });

  it("reads a saved environment's files with its name", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), studio), { orca_terminal_read: ["$"], orca_files_list: root() });
    await project("example-app").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 4);
    expect(await callsOf("orca_files_list")).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: "Studio" }]);
  });

  it("shows the message of a root that cannot be read, and of a folder that cannot", async () => {
    await openFiles({ orca_files_list: rejects("Orca に接続できません") });
    await expect($("#orca-files-tree .orca-file-note.fail")).toHaveText("Orca に接続できません");
    await mock("orca_files_list", root());
    await $("#orca-files-reload").click();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", rejects("ファイルが見つかりません"));
    await row("src").click();
    await expect($("#orca-files-tree .orca-file-note.fail")).toHaveText("ファイルが見つかりません");
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
  });

  it("says how many more entries a folder holds than were listed", async () => {
    await openFiles({ orca_files_list: { ...dirOf("", [["a.rs", false]]), total: 5001 } });
    await expect($("#orca-files-tree .orca-file-note")).toHaveText("ほか 5000 件");
  });

  it("opens a file in a tab with a file mark on a double press, selects it, and colors the file in the tree", async () => {
    await openFiles();
    const read = await mock("orca_file_read", text("fn main() {}\n"));
    await waitForCount("#orca-files-tree .orca-file", 4);
    // A single press only selects: nothing is read.
    await row("a.rs").click();
    expect(await callsOf(read)).toEqual([]);
    await expect(row("a.rs")).toHaveAttribute("data-open", "false");
    await doublePress("a.rs");
    expect(await waitForCalls(read)).toEqual([{ path: "/work/example-app", relative: "a.rs", environment: null }]);
    await expect(tabOf("file:1")).toBeExisting();
    await expect(selectedTab().$(".orca-tab-title")).toHaveText("a.rs");
    expect(await count('.orca-tabs [data-tab="file:1"] .orca-file-tab-ic')).toBe(1);
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n", { trim: false });
    await expect($(".orca-edit-path")).toHaveText("a.rs");
    await expect($(".orca-term")).not.toBeDisplayed();
    await expect(row("a.rs")).toHaveAttribute("data-open", "true");
    // The tab was asked for as one of the project's tabs.
    const asked = (await callsOf("orca_panes")).map((c) => (c as { tabs: string[] }).tabs);
    expect(asked[asked.length - 1]).toEqual([claude, "file:1"]);
    // The heading still names the worktree, with the file selected.
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/a");
    expect(await browser.execute(() => document.activeElement?.classList.contains("orca-edit-area"))).toBe(true);
  });

  it("opens a file that is open already by selecting its tab, without reading it again", async () => {
    await openFiles();
    await openA();
    await tabOf(claude).$(".orca-tab-btn").click();
    await expect($(".orca-edit-area")).not.toBeExisting();
    await doublePress("a.rs");
    await expect(selectedTab().$(".orca-tab-title")).toHaveText("a.rs");
    expect(await count(".orca-tabs [data-file]")).toBe(1);
    expect(await callsOf("orca_file_read")).toHaveLength(1);
  });

  it("keeps the typing of a file when another tab is shown and the file again", async () => {
    await openFiles({ editor_settings: { autosaveMs: 3000 } });
    await openA();
    await type("// more\n");
    await tabOf(claude).$(".orca-tab-btn").click();
    await tabOf("file:1").$(".orca-tab-btn").click();
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n// more\n", { trim: false });
    expect(await callsOf("orca_file_read")).toHaveLength(1);
  });

  it("shows the message of a file that cannot be read in the tab, with no editor", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_file_read", rejects("バイナリのファイルは開けません"));
    await doublePress("a.rs");
    await expect($(".orca-edit .orca-empty")).toHaveText("バイナリのファイルは開けません");
    await expect($(".orca-edit-area")).not.toBeDisplayed();
    expect(await dirtyMarks()).toBe(0);
  });

  it("saves by itself once the typing has stopped: waiting, saving, saved, and the mark of the tab goes", async () => {
    await openFiles({ editor_settings: { autosaveMs: 500 } });
    await openA();
    await expect(stateText()).toHaveText("");
    const write = await mock("orca_file_write", holds);
    await type("// x\n");
    expect(await dirtyMarks()).toBe(1);
    await expect(stateText()).toHaveText("保存待ち");
    expect(await callsOf(write)).toEqual([]);
    expect(await waitForCalls(write)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\n// x\n", crlf: false, signature: "sig-1", environment: null }]);
    await expect(stateText()).toHaveText("保存中");
    expect(await dirtyMarks()).toBe(1);
    await release(write, saved("sig-2"));
    await expect(stateText()).toHaveText("保存しました");
    await browser.waitUntil(async () => (await dirtyMarks()) === 0, { timeoutMsg: "the mark of the tab stayed" });
  });

  it("saves the typing that waits for its timer when the page is hidden for good", async () => {
    await openFiles({ editor_settings: { autosaveMs: 3000 } });
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await type("// x\n");
    await expect(stateText()).toHaveText("保存待ち");
    expect(await callsOf(write)).toEqual([]);
    await browser.execute((once) => {
      if (!window.__e2e_once__(once)) return;
      window.dispatchEvent(new Event("pagehide"));
    }, onceId());
    expect(await waitForCalls(write)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\n// x\n", crlf: false, signature: "sig-1", environment: null }]);
    await expect(stateText()).toHaveText("保存しました");
  });

  it("restarts the wait with each key, and saves the whole text once", async () => {
    await openFiles({ editor_settings: { autosaveMs: 600 } });
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await type("1");
    await browser.pause(300);
    await type("2");
    await browser.pause(300);
    await type("3");
    expect(await callsOf(write)).toEqual([]);
    const calls = await waitForCalls(write);
    expect((calls[0] as { content: string }).content).toBe("fn main() {}\n123");
    await browser.pause(800);
    expect(await callsOf(write)).toHaveLength(1);
  });

  it("sends the signature of the last save with the next one", async () => {
    await openFiles();
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await type("a");
    await waitForCalls(write);
    await expect(stateText()).toHaveText("保存しました");
    await mock("orca_file_write", saved("sig-3"));
    await type("b");
    const calls = await waitForCalls("orca_file_write");
    expect(calls).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\nab", crlf: false, signature: "sig-2", environment: null }]);
  });

  it("sends what was typed while a save was on its way as the next save, once the first is done", async () => {
    await openFiles();
    await openA();
    const write = await mock("orca_file_write", holds);
    await type("a");
    await waitForCalls(write);
    await type("b");
    await release(write, saved("sig-2"));
    await expect(stateText()).not.toHaveText("保存しました");
    await mock("orca_file_write", saved("sig-3"));
    const calls = await waitForCalls("orca_file_write");
    expect(calls).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\nab", crlf: false, signature: "sig-2", environment: null }]);
    await expect(stateText()).toHaveText("保存しました");
    await browser.waitUntil(async () => (await dirtyMarks()) === 0, { timeoutMsg: "the mark of the tab stayed" });
  });

  it("does not save a file that the disk changed, says so in the heading, keeps the mark, and does not try again", async () => {
    await openFiles();
    await openA();
    const write = await mock("orca_file_write", { state: "changed", signature: "sig-1" } satisfies OrcaSaved);
    await type("a");
    await waitForCalls(write);
    await expect(stateText()).toHaveText("ディスクのファイルが変わっています");
    expect(await dirtyMarks()).toBe(1);
    await type("b");
    await browser.pause(600);
    expect(await callsOf(write)).toHaveLength(1);
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\nab", { trim: false });
    await expect($("#error")).not.toBeDisplayed();
  });

  it("says when the file is gone or is no longer text", async () => {
    await openFiles();
    await openA();
    await mock("orca_file_write", { state: "missing", signature: "sig-1" } satisfies OrcaSaved);
    await type("a");
    await expect(stateText()).toHaveText("ファイルが見つかりません");
    await tabOf(claude).$(".orca-tab-btn").click();
    await mock("orca_file_read", text("x\n", "sig-x"));
    await mock("orca_files_list", dirOf("", [["a.rs", false], ["c.rs", false]]));
    await $("#orca-files-reload").click();
    await waitForCount("#orca-files-tree .orca-file", 2);
    await doublePress("c.rs");
    await mock("orca_file_write", { state: "not-utf8", signature: "sig-x" } satisfies OrcaSaved);
    await type("b");
    await expect(stateText()).toHaveText("ディスクのファイルが UTF-8 ではなくなっています");
  });

  it("shows the message of a save that failed, and saves again with the next typing", async () => {
    await openFiles();
    await openA();
    await mock("orca_file_write", rejects("Orca に接続できません"));
    await type("a");
    await expect($("#error")).toHaveText("Orca に接続できません");
    await expect(stateText()).toHaveText("保存できません");
    expect(await dirtyMarks()).toBe(1);
    const again = await mock("orca_file_write", saved("sig-2"));
    await type("b");
    expect(await waitForCalls(again)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\nab", crlf: false, signature: "sig-1", environment: null }]);
    await expect(stateText()).toHaveText("保存しました");
  });

  it("saves the typing of a file when its tab is closed, then closes it", async () => {
    await openFiles({ editor_settings: { autosaveMs: 3000 } });
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await type("a");
    await tabOf("file:1").$(".orca-tab-close").click();
    expect(await waitForCalls(write)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\na", crlf: false, signature: "sig-1", environment: null }]);
    await expect(tabOf("file:1")).not.toBeExisting();
    expect(await tabTitles()).toEqual(["Write the docs"]);
    await expect(row("a.rs")).toHaveAttribute("data-open", "false");
    await expect($(".orca-term")).toBeDisplayed();
  });

  it("closes a file with nothing to save without a save", async () => {
    await openFiles();
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await tabOf("file:1").$(".orca-tab-close").click();
    await expect(tabOf("file:1")).not.toBeExisting();
    expect(await callsOf(write)).toEqual([]);
  });

  it("keeps the tab of a file whose save failed, and closes one whose save was refused", async () => {
    await openFiles({ editor_settings: { autosaveMs: 3000 } });
    await openA();
    await mock("orca_file_write", rejects("Orca に接続できません"));
    await type("a");
    await tabOf("file:1").$(".orca-tab-close").click();
    await expect($("#error")).toHaveText("Orca に接続できません");
    await expect(tabOf("file:1")).toBeExisting();
    expect(await dirtyMarks()).toBe(1);
    await mock("orca_file_write", { state: "changed", signature: "sig-1" } satisfies OrcaSaved);
    await tabOf("file:1").$(".orca-tab-close").click();
    await expect(tabOf("file:1")).not.toBeExisting();
  });

  it("opens a second file as a second tab, each with its own text", async () => {
    await openFiles({ orca_files_list: dirOf("", [["a.rs", false], ["b.rs", false]]) });
    await openA("fn main() {}\n", "sig-1", 2);
    await mock("orca_file_read", text("pub fn b() {}\n", "sig-b"));
    await doublePress("b.rs");
    await expect($(".orca-edit-area")).toHaveValue("pub fn b() {}\n", { trim: false });
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs", "b.rs"]);
    await tabOf("file:1").$(".orca-tab-btn").click();
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n", { trim: false });
    expect(await callsOf("orca_file_read")).toHaveLength(1);
  });

  // The right button on a row of the tree, as the page gets it; whether the page kept the browser's own menu from showing.
  const rightClickRow = (path: string) =>
    browser.execute(
      (p, once) => {
        if (!window.__e2e_once__(once)) return false;
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
        document.querySelector(`.orca-file[data-path="${p}"]`)!.dispatchEvent(event);
        return event.defaultPrevented;
      },
      path,
      onceId(),
    );

  it("opens a menu of the two copies, the download and the diff on the right button of a file, and writes the path and the path from the worktree", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await stubClipboard();
    expect(await rightClickRow("a.rs")).toBe(true);
    await expect($('.menu[role="menu"]')).toBeDisplayed();
    expect(await textsOf('.menu[role="menu"] button')).toEqual(["パスのコピー", "相対パスをコピー", "ダウンロード", "差分を表示"]);
    expect(await count('.menu[role="menu"] button svg')).toBe(4);
    expect(await count('.menu[role="menu"] .pdot')).toBe(0);
    await pickItem("パスのコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "the path was never copied" });
    await expect($(".toast")).toHaveText(expect.stringContaining("パスをコピーしました"));
    await expect($(".menu")).not.toExist();
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("相対パスをコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 2, { timeoutMsg: "the relative path was never copied" });
    expect(await copiedTexts()).toEqual(["/work/example-app/a.rs", "a.rs"]);
  });

  it("opens the same menu on a folder, and on a file in an open folder with its path from the worktree", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    await stubClipboard();
    expect(await rightClickRow("src")).toBe(true);
    expect(await textsOf('.menu[role="menu"] button')).toEqual(["パスのコピー", "相対パスをコピー"]);
    expect(await count('.menu[role="menu"] button svg')).toBe(2);
    expect(await count('.menu[role="menu"] .pdot')).toBe(0);
    await pickItem("パスのコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "the path was never copied" });
    expect(await rightClickRow("src/main.rs")).toBe(true);
    await pickItem("相対パスをコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 2, { timeoutMsg: "the relative path was never copied" });
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await rightClickRow("src/main.rs")).toBe(true);
    await pickItem("パスのコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 3, { timeoutMsg: "the path was never copied" });
    expect(await copiedTexts()).toEqual(["/work/example-app/src", "src/main.rs", "/work/example-app/src/main.rs"]);
  });

  // A-22: the download of a file. Rust opens the save dialog and writes where it says; the page sends the worktree, the path from it and the target, and never a place to save.
  it("downloads a file from the menu with the worktree, its path and no place to save, and says the name of the file saved", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const download = await mock("orca_file_download", "a.rs");
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("ダウンロード");
    expect(await waitForCalls(download)).toEqual([{ path: "/work/example-app", relative: "a.rs", environment: null }]);
    await expect($(".toast")).toHaveText(expect.stringContaining("a.rs をダウンロードしました"));
    await expect($(".menu")).not.toExist();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("sends the path from the worktree of a file in an open folder", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    const download = await mock("orca_file_download", "main.rs");
    expect(await rightClickRow("src/main.rs")).toBe(true);
    await pickItem("ダウンロード");
    expect(await waitForCalls(download)).toEqual([{ path: "/work/example-app", relative: "src/main.rs", environment: null }]);
  });

  it("shows nothing when the save dialog is cancelled", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const download = await mock("orca_file_download", null);
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("ダウンロード");
    await waitForCalls(download);
    await browser.pause(300);
    await expect($(".toast")).not.toBeDisplayed();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("shows the message of a download that failed, and no toast", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const download = await mock("orca_file_download", rejects("この PC にファイルを書けません: Permission denied"));
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("ダウンロード");
    await waitForCalls(download);
    await expect($("#error")).toHaveText("この PC にファイルを書けません: Permission denied");
    await expect($(".toast")).not.toBeDisplayed();
  });

  // A-24: the diff tab. Rust compares the two texts (`orca_file_diff`): the rows of both views and the blocks of changes; the page draws them and colors the text.
  const row_ = (kind: OrcaDiffRow["kind"], old: number | null, nw: number | null): OrcaDiffRow => ({ kind, old, new: nw });
  const diffOfA = (): OrcaFileDiff => ({
    oldLines: ["fn main() {", "    old();", "}", "/* a", "b */"],
    newLines: ["fn main() {", "    new();", "    more();", "}", "/* a", "b */", "// tail"],
    side: [row_("same", 1, 1), row_("changed", 2, 2), row_("added", null, 3), row_("same", 3, 4), row_("same", 4, 5), row_("same", 5, 6), row_("added", null, 7)],
    inline: [row_("same", 1, 1), row_("removed", 2, null), row_("added", null, 2), row_("added", null, 3), row_("same", 3, 4), row_("same", 4, 5), row_("same", 5, 6), row_("added", null, 7)],
    changes: [
      { side: 1, inline: 1 },
      { side: 6, inline: 7 },
    ],
    language: "rust",
    highlight: "rust",
  });
  // 200 rows, with a change at the second row and another at the 150th, so that the rows scroll.
  const many = (): OrcaFileDiff => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const side = lines.map((_, i) => row_(i === 1 || i === 149 ? "changed" : "same", i + 1, i + 1));
    return { oldLines: lines, newLines: lines.map((l, i) => (i === 1 || i === 149 ? `${l} new` : l)), side, inline: side.flatMap((r) => (r.kind === "changed" ? [row_("removed", r.old, null), row_("added", null, r.new)] : [r])), changes: [{ side: 1, inline: 1 }, { side: 149, inline: 150 }], language: "plaintext", highlight: null };
  };
  const diffRows = () => count(".orca-diff-rows .odf-row");
  const diffButton = (label: string) => $(`.orca-diff [aria-label="${label}"]`);
  const diffCell = (row: number, cell: string) => browser.execute((r, c) => document.querySelectorAll(".orca-diff-rows .odf-row")[r].querySelector(c)!.textContent, row, cell);
  async function openDiffOf(relative = "a.rs", value: unknown = diffOfA()) {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const diff = await mock("orca_file_diff", value);
    expect(await rightClickRow(relative)).toBe(true);
    await pickItem("差分を表示");
    return diff;
  }

  it("opens the diff of a file from the menu of its row with the worktree, its path and the target, as a tab that is selected (A-24)", async () => {
    const diff = await openDiffOf();
    expect(await waitForCalls(diff)).toEqual([{ path: "/work/example-app", relative: "a.rs", environment: null }]);
    await expect($(".menu")).not.toExist();
    await expect(tabOf("diff:1")).toBeDisplayed();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await expect(tabOf("diff:1").$(".orca-tab-btn")).toHaveAttribute("aria-selected", "true");
    await expect($(".orca-diff .orca-edit-path")).toHaveText("a.rs");
    await expect($(".orca-diff-count")).toHaveText("変更 2 件");
    expect(await diffRows()).toBe(7);
    await expect($("#error")).not.toBeDisplayed();
  });

  it("draws HEAD on the left, the working tree on the right and the numbers between, with a blank where a side has no line (A-24)", async () => {
    await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect($(".orca-diff-rows")).toHaveAttribute("data-view", "side");
    expect(await diffCell(1, ".old")).toBe("    old();");
    expect(await diffCell(1, ".new")).toBe("    new();");
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(2) .odf-num")).toEqual(["2", "2"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(3) .odf-num")).toEqual(["", "3"]);
    expect(await diffCell(2, ".old")).toBe("");
    expect(await diffCell(2, ".new")).toBe("    more();");
    const kinds = await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".orca-diff-rows .odf-row")].map((r) => r.dataset.kind));
    expect(kinds).toEqual(["same", "changed", "added", "same", "same", "same", "added"]);
    const colors = await browser.execute(() => {
      const bg = (row: number, cell: string) => getComputedStyle(document.querySelectorAll(".orca-diff-rows .odf-row")[row].querySelector(cell)!).backgroundColor;
      return { removed: bg(1, ".old"), added: bg(1, ".new"), blank: bg(2, ".old"), added2: bg(2, ".new"), same: bg(0, ".old") };
    });
    expect(colors.removed).toBe("rgb(255, 235, 233)");
    expect(colors.added).toBe("rgb(218, 251, 225)");
    expect(colors.added2).toBe(colors.added);
    expect(colors.blank).toBe("rgb(246, 248, 250)");
    expect(colors.same).toBe("rgba(0, 0, 0, 0)");
  });

  it("colors the text by the language, a token of several lines on each of its lines (A-24)", async () => {
    await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(1) .old .hljs-keyword")).toEqual(["fn"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(1) .new .hljs-keyword")).toEqual(["fn"]);
    // The block comment starts on one line and ends on the next: both are comments.
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(5) .old .hljs-comment")).toEqual(["/* a"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(6) .old .hljs-comment")).toEqual(["b */"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(7) .new .hljs-comment")).toEqual(["// tail"]);
  });

  it("draws the text plain and escaped for a language with no grammar (A-24)", async () => {
    const plain: OrcaFileDiff = { ...diffOfA(), oldLines: ["<b>x</b> &amp;"], newLines: ["<b>y</b>"], side: [row_("changed", 1, 1)], inline: [row_("removed", 1, null), row_("added", null, 1)], changes: [{ side: 0, inline: 0 }], language: "zig", highlight: null };
    await openDiffOf("a.rs", plain);
    await waitForCount(".orca-diff-rows .odf-row", 1);
    expect(await diffCell(0, ".old")).toBe("<b>x</b> &amp;");
    expect(await count(".orca-diff-rows b")).toBe(0);
    expect(await count(".orca-diff-rows [class^='hljs-']")).toBe(0);
  });

  it("switches to one column with the marks and two columns of numbers, and back, with the button of the tab (A-24)", async () => {
    await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect(diffButton("1 列で表示")).toHaveAttribute("aria-pressed", "false");
    await diffButton("1 列で表示").click();
    await waitForCount(".orca-diff-rows .odf-row", 8);
    await expect($(".orca-diff-rows")).toHaveAttribute("data-view", "inline");
    await expect(diffButton("左右に並べて表示")).toHaveAttribute("aria-pressed", "true");
    expect(await textsOf(".orca-diff-rows .odf-mark")).toEqual(["", "−", "+", "+", "", "", "", "+"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(2) .odf-num")).toEqual(["2", ""]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(3) .odf-num")).toEqual(["", "2"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(2) .odf-code")).toEqual(["old();"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(3) .odf-code")).toEqual(["new();"]);
    const colors = await browser.execute(() => {
      const bg = (row: number) => getComputedStyle(document.querySelectorAll(".orca-diff-rows .odf-row")[row].querySelector(".odf-code")!).backgroundColor;
      return [bg(1), bg(2), bg(0)];
    });
    expect(colors).toEqual(["rgb(255, 235, 233)", "rgb(218, 251, 225)", "rgba(0, 0, 0, 0)"]);
    expect(await count(".orca-diff-rows .odf-row:nth-child(2) .hljs-keyword, .orca-diff-rows .odf-row:nth-child(1) .hljs-keyword")).toBe(1);
    expect(await callsOf("orca_file_diff")).toHaveLength(1);
    await diffButton("左右に並べて表示").click();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect($(".orca-diff-rows")).toHaveAttribute("data-view", "side");
  });

  it("goes to the previous and the next block of changes, and counts them (A-24)", async () => {
    await openDiffOf("a.rs", many());
    await waitForCount(".orca-diff-rows .odf-row", 200);
    await expect($(".orca-diff-count")).toHaveText("変更 2 件");
    const view = () => browser.execute(() => {
      const box = document.querySelector(".orca-diff-rows")!.getBoundingClientRect();
      const r = document.querySelectorAll(".orca-diff-rows .odf-row")[149].getBoundingClientRect();
      return { top: document.querySelector(".orca-diff-rows")!.scrollTop, visible: r.top >= box.top && r.bottom <= box.bottom };
    });
    await expect(diffButton("前の変更")).toBeDisabled();
    await expect(diffButton("次の変更")).toBeEnabled();
    expect((await view()).visible).toBe(false);
    await diffButton("次の変更").click();
    await browser.waitUntil(async () => (await view()).visible, { timeoutMsg: "the second change never came into view" });
    await expect(diffButton("次の変更")).toBeDisabled();
    await expect(diffButton("前の変更")).toBeEnabled();
    await diffButton("前の変更").click();
    await browser.waitUntil(async () => !(await view()).visible, { timeoutMsg: "the first change never came back" });
    await expect(diffButton("前の変更")).toBeDisabled();
  });

  it("draws a tab that is out of the page in the view chosen when it is put back, at the block last moved to (A-24)", async () => {
    await openDiffOf("a.rs", many());
    await waitForCount(".orca-diff-rows .odf-row", 200);
    await diffButton("次の変更").click();
    await expect(diffButton("次の変更")).toBeDisabled();
    expect(await rightClickRow("b.log")).toBe(true);
    await pickItem("差分を表示");
    await expect(tabOf("diff:2")).toBeDisplayed();
    await waitForCount(".orca-diff-rows .odf-row", 200);
    await diffButton("1 列で表示").click();
    await waitForCount(".orca-diff-rows .odf-row", 202);
    await tabOf("diff:1").$(".orca-tab-btn").click();
    await expect($(".orca-diff-rows")).toHaveAttribute("data-view", "inline");
    await waitForCount(".orca-diff-rows .odf-row", 202);
    await expect(diffButton("左右に並べて表示")).toHaveAttribute("aria-pressed", "true");
    await expect(diffButton("次の変更")).toBeDisabled();
    // The second block (the 151st row of one column) is in view, not the pixel place of the other view.
    const visible = () => browser.execute(() => {
      const box = document.querySelector(".orca-diff-rows")!.getBoundingClientRect();
      const r = document.querySelectorAll(".orca-diff-rows .odf-row")[150].getBoundingClientRect();
      return r.top >= box.top && r.bottom <= box.bottom;
    });
    await browser.waitUntil(visible, { timeoutMsg: "the second change was not in view after the tab was put back" });
  });

  it("says there is no change for a file with none, and the buttons of the changes are off (A-24)", async () => {
    const none: OrcaFileDiff = { ...diffOfA(), oldLines: ["a"], newLines: ["a"], side: [row_("same", 1, 1)], inline: [row_("same", 1, 1)], changes: [] };
    await openDiffOf("a.rs", none);
    await expect($(".orca-diff-count")).toHaveText("変更はありません");
    await expect(diffButton("前の変更")).toBeDisabled();
    await expect(diffButton("次の変更")).toBeDisabled();
  });

  it("shows the reason Rust gives in place of the diff (A-24)", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const diff = await mock("orca_file_diff", rejects("バイナリのファイルの差分は表示できません"));
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("差分を表示");
    await waitForCalls(diff);
    await expect($(".orca-diff .feed-empty")).toHaveText("バイナリのファイルの差分は表示できません");
    await expect($(".orca-diff-rows")).not.toBeDisplayed();
    await expect($(".orca-diff-count")).toHaveText("");
    await expect(diffButton("1 列で表示")).toBeDisabled();
    await expect(diffButton("次の変更")).toBeDisabled();
    await expect($("#error")).not.toBeDisplayed();
    // The reload button reads again, and draws the diff when it can.
    await mock("orca_file_diff", diffOfA());
    await diffButton("読み直す").click();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect($(".orca-diff .feed-empty")).not.toBeDisplayed();
  });

  it("reads the diff again with the reload button, and selects the tab instead of opening a second one for the same file (A-24)", async () => {
    const diff = await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await diffButton("読み直す").click();
    expect(await waitForCalls(diff, 2)).toHaveLength(2);
    await tabOf(claudeTab("example-app")).$(".orca-tab-btn").click();
    await expect($(".orca-diff")).not.toExist();
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("差分を表示");
    await browser.waitUntil(async () => (await callsOf("orca_file_diff")).length === 3, { timeoutMsg: "the diff was never read again" });
    await expect(tabOf("diff:1").$(".orca-tab-btn")).toHaveAttribute("aria-selected", "true");
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await expect($(".orca-diff")).toBeDisplayed();
    expect(await diffRows()).toBe(7);
  });

  it("opens the diff of another file as another tab, and closes a diff tab without asking Rust (A-24)", async () => {
    await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    expect(await rightClickRow("b.log")).toBe(true);
    await pickItem("差分を表示");
    await expect(tabOf("diff:2")).toBeDisplayed();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs", "b.log"]);
    await expect($(".orca-diff .orca-edit-path")).toHaveText("b.log");
    await tabOf("diff:2").$(".orca-tab-close").click();
    await expect(tabOf("diff:2")).not.toExist();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
  });

  it("opens the diff of a file in an open folder with its path from the worktree (A-24)", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    const diff = await mock("orca_file_diff", diffOfA());
    expect(await rightClickRow("src/main.rs")).toBe(true);
    await pickItem("差分を表示");
    expect(await waitForCalls(diff)).toEqual([{ path: "/work/example-app", relative: "src/main.rs", environment: null }]);
    expect(await tabTitles()).toEqual(["Write the docs", "main.rs"]);
  });

  it("closes the menu of a row with Escape and writes nothing", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await stubClipboard();
    expect(await rightClickRow("b.log")).toBe(true);
    await expect($('.menu[role="menu"]')).toBeDisplayed();
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
    expect(await copiedTexts()).toEqual([]);
  });
});

describe("orca: search the list (A-19)", () => {
  // example-app, example-web, example-api, example-lib and example-idle as projects (the working ones, example-app and example-web, come first), then the SSH hosts example-host and other-host.
  const overview = () =>
    orcaOverview(sample(), [...worktrees(), orcaWorktree("example-idle", "main")], {
      terminals: [orcaTerminal("example-app", "zsh")],
      ssh: [orcaSsh("s1", "example-host"), orcaSsh("s2", "other-host")],
      hosts: [{ key: "ssh:s1", name: "s1", status: "working" as const, sessions: 2, atMs: 0 }],
    });
  const ALL = ["example-app", "example-web", "example-api", "example-lib", "example-idle", "example-host", "other-host"];
  const input = () => $("#orca-search-input");
  const names = () => textsOf("#orca-feed .orca-project-name");
  const secs = () => textsOf("#orca-feed .orca-sec");
  const focusedId = () => browser.execute(() => document.activeElement?.id ?? "");
  // The name of each row and the letters of it in bold.
  const bolds = () =>
    browser.execute(() => [...document.querySelectorAll("#orca-feed .orca-project")].map((r) => [r.querySelector(".orca-project-name")!.textContent, [...r.querySelectorAll("b")].map((b) => b.textContent)]));
  const cursorOn = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-project")].filter((r) => r.dataset.cursor === "true").map((r) => r.dataset.key));
  const search = async (text: string) => {
    await input().setValue(text);
    await browser.waitUntil(async () => (await names()).length !== ALL.length || text.trim() === "", { timeoutMsg: "the list never changed with the search" });
  };
  // Cmd+J as the page gets it, from the element that has the focus.
  const cmdJ = (init: KeyboardEventInit = { metaKey: true }) =>
    browser.execute((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true, ...i })), init);

  it("has a field between the header and the list, and the clear button only while something is typed", async () => {
    await openOrca(overview());
    await expect($("#orca-search")).toBeDisplayed();
    await expect(input()).toHaveAttribute("aria-label", "プロジェクトを検索");
    await expect(input()).toHaveAttribute("placeholder", "検索");
    await expect($("#orca-search-clear")).not.toBeDisplayed();
    const place = await browser.execute(() => {
      const r = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { headerBottom: r("#orca-header").bottom, searchTop: r("#orca-search").top, searchBottom: r("#orca-search").bottom, feedTop: r("#orca-feed").top };
    });
    expect(place.searchTop).toBeGreaterThanOrEqual(place.headerBottom - 1);
    expect(place.feedTop).toBeGreaterThanOrEqual(place.searchBottom - 1);
    await search("app");
    await expect($("#orca-search-clear")).toBeDisplayed();
    expect(await names()).toEqual(["example-app"]);
  });

  it("narrows the list to the rows whose name holds the text, case ignored, in the order of the list", async () => {
    await openOrca(overview());
    expect(await names()).toEqual(ALL);
    await search("E-A");
    expect(await names()).toEqual(["example-app", "example-api"]);
    expect(await secs()).toEqual([]);
    // The text is trimmed, and a blank text is no search.
    await search("  app ");
    expect(await names()).toEqual(["example-app"]);
    await search("   ");
    expect(await names()).toEqual(ALL);
  });

  it("makes the letters that match bold, at every place in the name", async () => {
    await openOrca(overview());
    await search("AP");
    expect(await bolds()).toEqual([
      ["example-app", ["ap"]],
      ["example-api", ["ap"]],
    ]);
    await search("p");
    expect((await bolds())[0]).toEqual(["example-app", ["p", "p", "p"]]);
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#orca-feed .orca-project-name b")!).fontWeight)).toBe("800");
  });

  it("shows the SSH heading only when an SSH host matches", async () => {
    await openOrca(overview());
    await search("app");
    expect(await secs()).toEqual([]);
    await search("other");
    expect(await names()).toEqual(["other-host"]);
    expect(await secs()).toEqual(["SSH"]);
    await search("host");
    expect(await names()).toEqual(["example-host", "other-host"]);
    expect(await secs()).toEqual(["SSH"]);
  });

  it("matches a character that a regular expression takes as its own as itself, and says so when nothing matches", async () => {
    await openOrca(overview());
    for (const text of [".", "(", "zzz"]) {
      await search(text);
      await expect($("#orca-feed")).toHaveText("一致するプロジェクトがありません");
      expect(await count("#orca-feed .orca-project")).toBe(0);
      expect(await secs()).toEqual([]);
    }
    await $("#orca-search-clear").click();
    expect(await names()).toEqual(ALL);
  });

  it("does not say the projects are missing while the search finds none of those there are", async () => {
    await openOrca(orcaOverview([]));
    await expect($("#orca-feed")).toHaveText(expect.stringContaining("プロジェクトがありません"));
    await search("zzz");
    await expect($("#orca-feed")).toHaveText("一致するプロジェクトがありません");
  });

  it("drops the row of a selected project that does not match with its sessions, and keeps the tabs", async () => {
    await openOrca(overview());
    await mock("orca_terminal_read", ["$ ls"]);
    await project("example-app").click();
    await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
    expect(await textsOf("#orca-feed .orca-session .orca-session-title")).toEqual(["Write the docs", "zsh"]);
    await search("api");
    expect(await names()).toEqual(["example-api"]);
    await expect($("#orca-feed .orca-session")).not.toExist();
    expect(await tabTitles()).toEqual(["Write the docs", "zsh"]);
    // The sessions are not searched: "zsh" finds no row.
    await search("zsh");
    await expect($("#orca-feed")).toHaveText("一致するプロジェクトがありません");
    await $("#orca-search-clear").click();
    await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
    expect(await textsOf("#orca-feed .orca-session .orca-session-title")).toEqual(["Write the docs", "zsh"]);
  });

  it("puts the line on the first row, moves it with Down and Up to the ends, and goes on to the SSH hosts", async () => {
    await openOrca(overview());
    await search("e-a");
    expect(await cursorOn()).toEqual(["proj_example-app"]);
    await browser.keys("ArrowDown");
    expect(await cursorOn()).toEqual(["proj_example-api"]);
    await browser.keys("ArrowDown");
    expect(await cursorOn()).toEqual(["proj_example-api"]);
    await browser.keys("ArrowUp");
    expect(await cursorOn()).toEqual(["proj_example-app"]);
    await browser.keys("ArrowUp");
    expect(await cursorOn()).toEqual(["proj_example-app"]);
    // A change of the text puts it on the first row again.
    await browser.keys("ArrowDown");
    await search("ex");
    expect(await cursorOn()).toEqual(["proj_example-app"]);
    await search("host");
    expect(await cursorOn()).toEqual(["ssh:s1"]);
    await browser.keys("ArrowDown");
    expect(await cursorOn()).toEqual(["ssh:s2"]);
  });

  it("has no line while nothing is typed, and Down does nothing", async () => {
    await openOrca(overview());
    await input().click();
    await browser.keys("ArrowDown");
    expect(await cursorOn()).toEqual([]);
  });

  it("selects the row with Enter as pressing it does, and keeps the text and the narrowed list", async () => {
    await openOrca(overview());
    await mock("orca_terminal_read", ["$ ls"]);
    await search("e-a");
    await browser.keys(["ArrowDown", "Enter"]);
    await expect(project("example-api")).toHaveAttribute("aria-pressed", "true");
    await expect(selectedTab()).toHaveText(expect.stringContaining("Fix the parser"));
    await expect(input()).toHaveValue("e-a");
    expect(await names()).toEqual(["example-app", "example-api"]);
  });

  it("selects nothing with Enter when no row matches", async () => {
    await openOrca(overview());
    await search("zzz");
    await browser.keys("Enter");
    expect(await count('#orca-feed .orca-project[aria-pressed="true"]')).toBe(0);
  });

  it("clears the text and leaves the field with Escape", async () => {
    await openOrca(overview());
    await search("app");
    await browser.keys("Escape");
    await expect(input()).toHaveValue("");
    expect(await names()).toEqual(ALL);
    expect(await focusedId()).not.toBe("orca-search-input");
    await expect($("#orca-search-clear")).not.toBeDisplayed();
  });

  it("clears the text with the clear button and keeps the focus in the field", async () => {
    await openOrca(overview());
    await search("app");
    // The page's own press (the driver's click focuses the button after the page's handler ran, which no real press does).
    await browser.execute(() => document.getElementById("orca-search-clear")!.click());
    await expect(input()).toHaveValue("");
    expect(await names()).toEqual(ALL);
    expect(await focusedId()).toBe("orca-search-input");
  });

  it("moves the focus to the field with Cmd+J, with the text selected", async () => {
    await openOrca(overview());
    await search("app");
    await $("#orca-refresh").click();
    expect(await focusedId()).not.toBe("orca-search-input");
    await cmdJ();
    expect(await focusedId()).toBe("orca-search-input");
    expect(await browser.execute(() => [(document.activeElement as HTMLInputElement).selectionStart, (document.activeElement as HTMLInputElement).selectionEnd])).toEqual([0, 3]);
  });

  it("opens a closed list (A-23) with Cmd+J before it takes the field", async () => {
    await openOrca(overview());
    await $("#orca-list-toggle").click();
    await expect($("#orca-list")).not.toBeDisplayed();
    await cmdJ();
    await expect($("#orca-list")).toBeDisplayed();
    expect(await focusedId()).toBe("orca-search-input");
  });

  it("takes Cmd+J from a terminal that has the focus, and from the working view, which gives way to the projects", async () => {
    await openOrca(overview());
    await mock("orca_terminal_read", ["$ ls"]);
    await project("example-app").click();
    await expect($(".orca-term")).toBeDisplayed();
    await browser.execute(() => document.querySelector<HTMLElement>(".orca-term-box:not([hidden]) .xterm-helper-textarea")!.focus());
    await cmdJ();
    expect(await focusedId()).toBe("orca-search-input");
    await $("#orca-bell").click();
    await expect($("#orca-bell")).toHaveAttribute("aria-pressed", "true");
    await expect($("#orca-search")).not.toBeDisplayed();
    await cmdJ();
    await expect($("#orca-bell")).toHaveAttribute("aria-pressed", "false");
    await expect($("#orca-search")).toBeDisplayed();
    expect(await focusedId()).toBe("orca-search-input");
    expect(await names()).toEqual(ALL);
  });

  it("does not take J without Cmd, with Shift or with Alt, nor Cmd+J on another screen", async () => {
    await openOrca(overview());
    await cmdJ({ ctrlKey: true });
    await cmdJ({ metaKey: true, shiftKey: true });
    await cmdJ({ metaKey: true, altKey: true });
    expect(await focusedId()).not.toBe("orca-search-input");
    await $("#nav-mail").click();
    await cmdJ();
    expect(await focusedId()).not.toBe("orca-search-input");
  });

  it("hides the field in the working view, which is not narrowed, and has the text again when the bell is pressed again", async () => {
    await openOrca(overview());
    await search("app");
    await $("#orca-bell").click();
    await expect($("#orca-search")).not.toBeDisplayed();
    await waitForCount("#orca-feed .orca-row", 4);
    await $("#orca-bell").click();
    await expect($("#orca-search")).toBeDisplayed();
    await expect(input()).toHaveValue("app");
    expect(await names()).toEqual(["example-app"]);
  });

  it("keeps the text through a read in the background, and narrows the rows that came", async () => {
    await openOrca(overview());
    await search("app");
    await mock("orca_overview", orcaOverview(sample(), [...worktrees(), orcaWorktree("example-apple", "main")]));
    await $("#orca-refresh").click();
    await browser.waitUntil(async () => (await names()).length === 2, { timeoutMsg: "the new project never matched" });
    expect(await names()).toEqual(["example-app", "example-apple"]);
    await expect(input()).toHaveValue("app");
  });
});
