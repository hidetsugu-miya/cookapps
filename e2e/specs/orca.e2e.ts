import type { OrcaStarted } from "../../ts/bindings/OrcaStarted";
import {
  boot,
  callsOf,
  chooseAppearance,
  chooseTheme,
  count,
  fire,
  ghosttyImport,
  holds,
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
// What `orca_start` answers for a session started in example-api, and its row once the list holds it (a pane that is not one of the sample's).
const reply: OrcaStarted = { paneKey: "tab_new:leaf_1", handle: "term_new" };
const startedRow = () => orcaRow("example-api", "main", "Write the docs", { paneKey: "tab_new:leaf_1", handle: "term_new" });
// What `orca_start` answers when Orca's reply gave neither a pane key nor a handle.
const noPane: OrcaStarted = { paneKey: null, handle: null };
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
const selectedTab = () => $('#orca-tabs [role="tab"][aria-selected="true"]');
const tabTitles = () => textsOf("#orca-tabs .orca-tab-title");
const tabOf = (id: string) => $(`#orca-tabs [data-tab="${id}"]`);
const claudeTab = (repo: string) => `claude:tab_${repo}:leaf_1`;
// The text of the terminal shown (the terminals of the other tabs stay, hidden).
const screenText = () => $("#orca-term .orca-term-box:not([hidden]) .xterm-rows").getText();

async function pickMenu(label: string) {
  for (const item of await $$(".menu button")) {
    if ((await item.getText()) === label) return item.click();
  }
  throw new Error(`no menu item "${label}"`);
}

// Opens the dialog of "新規" (the page's own press: the driver's click focuses the button after the page's handler ran, which no real press does) and picks the worktree at `path`.
async function openNew() {
  await browser.execute((id) => {
    if (window.__e2e_once__(id)) document.getElementById("orca-new")!.click();
  }, onceId());
  await expect($(".orca-dest-pop")).toBeDisplayed();
}
async function startIn(path: string) {
  await openNew();
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


  it("has the list on the left with a header of 32px level with the tab strip, the divider, and an empty work pane at the start", async () => {
    await openOrca();
    const box = await browser.execute(() => {
      const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return {
        listRight: r("orca-list").right,
        splitLeft: r("orca-split").left,
        splitRight: r("orca-split").right,
        workLeft: r("orca-work").left,
        share: r("orca-list").width / r("orca").width,
        header: r("orca-header").height,
        tabs: r("orca-tabs").height,
        headerTop: r("orca-header").top,
        tabsTop: r("orca-tabs").top,
        buttons: [...document.querySelectorAll("#orca-header button")].map((b) => b.getBoundingClientRect().height),
      };
    });
    expect(box.listRight).toBeLessThanOrEqual(box.splitLeft + 1);
    expect(box.splitRight).toBeLessThanOrEqual(box.workLeft + 1);
    expect(box.share).toBeCloseTo(0.3, 2);
    expect(box.header).toBe(32);
    expect(box.tabs).toBe(32);
    expect(box.tabsTop).toBe(box.headerTop);
    expect(box.buttons).toEqual([24, 24, 24]);
    // No label: "新規" at the left, the bell and the reload at the right.
    expect(await count("#orca-heading")).toBe(0);
    expect(await textsOf("#orca-new")).toEqual(["新規"]);
    await expect($("#orca-new")).toHaveAttribute("aria-label", "新しいセッション");
    await expect($("#orca-refresh")).toHaveAttribute("aria-label", "読み直す");
    const order = await browser.execute(() => [...document.querySelectorAll("#orca-header button")].map((b) => b.id));
    expect(order).toEqual(["orca-new", "orca-bell", "orca-refresh"]);
    // Nothing selected: no tab, no terminal, and a line that says what to do.
    expect(await count("#orca-tabs .orca-tab")).toBe(0);
    await expect($("#orca-term")).not.toBeDisplayed();
    await expect($("#orca-empty")).toHaveText("プロジェクトを選んでください");
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
    await expect($("#orca-term")).toBeDisplayed();
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
    await expect($("#orca-empty")).toHaveText("このセッションのターミナルはありません");
    await expect($("#orca-term")).not.toBeDisplayed();
    await browser.pause(1500);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
  });

  it("starts Claude in the worktree picked under 新規, with no prompt and the target the screen shows", async () => {
    await openOrca();
    const start = await mock("orca_start", noPane);
    await startIn("/work/example-api");
    await expect($(".orca-dest-pop")).not.toExist();
    expect(await waitForCalls(start)).toEqual([{ path: "/work/example-api", environment: null }]);
    // Orca named neither its pane nor its terminal: nothing can be followed, and the next 新規 starts another.
    await expect($("#orca-started")).toHaveText("セッションを始めました。Orca の画面で開けます。");
    await expect($("#orca-new")).toBeEnabled();
    await startIn("/work/example-app");
    expect(await waitForCalls(start, 2)).toEqual([
      { path: "/work/example-api", environment: null },
      { path: "/work/example-app", environment: null },
    ]);
  });

  it("shows the message when the launch fails, and can be pressed again", async () => {
    await openOrca();
    const start = await mock("orca_start", rejects("Worktree not found"));
    await startIn("/work/example-app");
    await waitForCalls(start);
    await expect($("#error")).toHaveText("Worktree not found");
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($("#orca-new")).toBeEnabled();
  });

  it("disables 新規 while a launch is on its way", async () => {
    await openOrca();
    const start = await mock("orca_start", holds);
    await startIn("/work/example-app");
    await waitForCalls(start);
    await expect($("#orca-new")).toBeDisabled();
    await release(start, noPane);
    await expect($("#orca-new")).toBeEnabled();
    expect(await callsOf(start)).toHaveLength(1);
  });

  it("follows the session it started: waits for its row, starts no second one meanwhile, then selects its tab and shows its terminal", async () => {
    await openOrca();
    const start = await mock("orca_start", reply);
    // The read after the launch does not hold the session yet.
    await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await startIn("/work/example-api");
    await waitForCalls(start);
    await expect($("#orca-started")).toHaveText("セッションを始めました。一覧に現れるのを待っています…");
    await expect($("#orca-new")).toBeDisabled();
    // The row appears in a later read: its project and tab are selected, and its terminal shows.
    const read = await mock("orca_terminal_read", ["$"]);
    await mock("orca_overview", orcaOverview([...sample(), startedRow()], worktrees()));
    await $("#orca-refresh").click();
    expect((await waitForCalls(read))[0]).toEqual({ handle: "term_new" });
    await expect($("#orca-started")).not.toBeDisplayed();
    await expect($('#orca-feed .orca-project[data-key="proj_example-api"]')).toHaveAttribute("aria-pressed", "true");
    await expect($('#orca-tabs [data-tab="claude:tab_new:leaf_1"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#orca-new")).toBeEnabled();
    expect(await callsOf(start)).toHaveLength(1);
  });

  it("finds the row of the session it started by the handle when the launch gave no pane key", async () => {
    await openOrca();
    const start = await mock("orca_start", { paneKey: null, handle: "term_new" } satisfies OrcaStarted);
    await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await startIn("/work/example-api");
    await waitForCalls(start);
    await expect($("#orca-started")).toHaveText("セッションを始めました。一覧に現れるのを待っています…");
    await mock("orca_overview", orcaOverview([...sample(), startedRow()], worktrees()));
    await $("#orca-refresh").click();
    await expect($('#orca-tabs [data-tab="claude:tab_new:leaf_1"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#orca-started")).not.toBeDisplayed();
  });

  it("drops the wait when the user selects another project", async () => {
    await openOrca();
    const start = await mock("orca_start", reply);
    await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await startIn("/work/example-api");
    await waitForCalls(start);
    await expect($("#orca-started")).toBeDisplayed();
    // Choosing a project drops the wait, and a row that appears later does not take the selection.
    await $('#orca-feed .orca-project[data-key="proj_example-app"]').click();
    await expect($("#orca-started")).not.toBeDisplayed();
    await mock("orca_overview", orcaOverview([...sample(), startedRow()], worktrees()));
    await $("#orca-refresh").click();
    await waitForCalls("orca_overview");
    await expect($('#orca-feed .orca-project[data-key="proj_example-app"]')).toHaveAttribute("aria-pressed", "true");
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
  });

  it("narrows the worktrees of 新規 with a filter, in two-line rows", async () => {
    await openOrca();
    await openNew();
    const pop = $(".orca-dest-pop");
    await expect(pop).toHaveAttribute("role", "dialog");
    await expect($("#orca-new")).toHaveAttribute("aria-haspopup", "dialog");
    const filter = $('.orca-dest-pop input[aria-label="worktree を絞り込む"]');
    await expect(filter).toBeFocused();
    // A row has the repository on its first line and the branch on its second.
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-app", "example-api"]);
    expect(await textsOf(".orca-dest-pop button span")).toEqual(["feat/a", "main"]);
    // Case-insensitive, on `{repo} ・ {branch}`.
    await filter.setValue("API");
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-api"]);
    await filter.setValue("app ・ FEAT");
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-app"]);
    await filter.setValue("zzz");
    await expect(pop).toHaveText(expect.stringContaining("該当する worktree がありません"));
    expect(await textsOf(".orca-dest-pop button")).toEqual([]);
  });

  it("says the command is missing, and does not read again by the clock", async () => {
    // The base answer is the one with no orca command.
    await boot({ inbox: inbox() });
    await $("#nav-orca").click();
    await expect($("#orca-status")).toHaveText("未インストール");
    expect(await classOf("#orca-status")).toContain("off");
    await expect($("#orca-notice")).toHaveText(expect.stringContaining("orca コマンドが見つかりません"));
    await expect($("#orca-new")).toBeDisabled();
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
    await startIn("/work/example-app");
    expect(await waitForCalls(start)).toEqual([{ path: "/work/example-app", environment: "Studio" }]);
    await select("example-app");
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
    await expect($("#orca-empty")).toHaveText("プロジェクトを選んでください");
    await waitForCalls("orca_stream_close");
  });

  it("keeps the selection through a read in the background, and does not start the terminal again", async () => {
    await openWorking();
    await mock("orca_terminal_read", ["$ first frame"]);
    await select("example-app");
    await browser.waitUntil(async () => (await screenText()).includes("first frame"), { timeoutMsg: "the first frame never showed" });
    await browser.execute(() => document.querySelector("#orca-term .orca-term-box:not([hidden])")!.setAttribute("data-mark", "same"));
    // The clock reads again within 10 seconds (the first read of this screen was at its opening).
    const overview = await mock("orca_overview", orcaOverview([...sample(), orcaRow("example-new", "main", "Fresh", { minutes: 1 })], worktrees()));
    await waitForCalls(overview);
    await waitForCount("#orca-feed .orca-row", 5);
    expect(await pressed("example-app")).toBe("true");
    await expect($("#orca")).toBeDisplayed();
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    await expect($('#orca-term .orca-term-box[data-mark="same"]')).toBeDisplayed();
  });

  it("drops the tab of a session that is gone, with its terminal", async () => {
    await openWorking();
    await select("example-app");
    await expect($("#orca-term")).toBeDisplayed();
    await mock("orca_overview", orcaOverview([orcaRow("example-api", "main", "Fix the parser")], worktrees()));
    await $("#orca-refresh").click();
    await waitForCount("#orca-feed .orca-row", 1);
    // The project is still selected, with no session left in it.
    await expect($("#orca-empty")).toHaveText("セッションはありません");
    expect(await count("#orca-tabs .orca-tab")).toBe(0);
    await expect($("#orca-term")).not.toBeDisplayed();
    expect(await count("#orca-term .orca-term-box")).toBe(0);
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

  it("is a vertical separator that starts at 30%", async () => {
    await openOrca();
    const split = $("#orca-split");
    await expect(split).toHaveAttribute("role", "separator");
    await expect(split).toHaveAttribute("aria-orientation", "vertical");
    await expect(split).toHaveAttribute("tabindex", "0");
    await expect(split).toHaveAttribute("aria-valuemin", "20");
    await expect(split).toHaveAttribute("aria-valuemax", "50");
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    expect(await share()).toBeCloseTo(0.3, 2);
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
    expect(await share()).toBeCloseTo(0.34, 2);
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
    expect(await projectNames()).toEqual(["example-app", "example-api", "example-web", "example-lib", "example-idle", "example-host", "other-host"]);
    // example-app has a running agent and a shell, example-api a waiting agent, example-lib a done one, example-idle nothing; the SSH host shows what its worktrees do.
    expect(await projectStatuses()).toEqual(["working", "question", "working", "done", "idle", "working", "idle"]);
    expect(await textsOf("#orca-feed .orca-n")).toEqual(["2", "1", "1", "1", "2"]);
    expect(await textsOf("#orca-feed .orca-sec")).toEqual(["SSH"]);
    await expect($("#orca-feed .orca-row")).not.toExist();
    // The status label is at the bottom of the list pane, under the list.
    const place = await browser.execute(() => {
      const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return { listBottom: r("orca-list").bottom, feedBottom: r("orca-feed").bottom, statusTop: r("orca-status").top, statusBottom: r("orca-status").bottom };
    });
    expect(place.statusTop).toBeGreaterThanOrEqual(place.feedBottom - 1);
    expect(place.statusBottom).toBeLessThanOrEqual(place.listBottom + 1);
  });

  it("lists an SSH host of the target that this machine does not list, under SSH", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { ssh: [orcaSsh("s1", "example-host")], hosts: [{ key: "ssh:s9", name: "lost-host", status: "working", sessions: 1, atMs: 0 }] }));
    expect(await projectNames()).toEqual(["example-app", "example-api", "example-web", "example-lib", "example-host", "lost-host"]);
    expect(await textsOf("#orca-feed .orca-sec")).toEqual(["SSH"]);
    expect(await projectStatuses()).toEqual(["working", "question", "working", "done", "idle", "working"]);
    // Its row is a project like the others: it can be selected.
    await project("lost-host").click();
    await expect(project("lost-host")).toHaveAttribute("aria-pressed", "true");
    await expect($("#orca-empty")).toHaveText("セッションはありません");
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
    expect(await count("#orca-tabs .orca-tab-sub")).toBe(0);
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-tabs .orca-ic")].map((i) => [i.dataset.status, i.getAttribute("aria-label")]))).toEqual([
      ["working", "作業中"],
      ["done", "起動中"],
    ]);
    // A Claude session is a terminal too.
    await expect($("#orca-term")).toBeDisplayed();
    expect((await waitForCalls(read))[0]).toEqual({ handle: "term_example-app" });
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    await expect($("#orca-term")).toBeDisplayed();
    await project("example-api").click();
    await expect(selectedTab()).toHaveText(expect.stringContaining("Fix the parser"));
    await project("example-app").click();
    await expect(selectedTab()).toHaveText(expect.stringContaining("zsh"));
  });

  it("says a project has no session, with the tab strip empty", async () => {
    await openOrca(withTerminals());
    await project("example-idle").click();
    await expect($("#orca-empty")).toBeDisplayed();
    await expect($("#orca-empty")).toHaveText("セッションはありません");
    await expect($("#orca-tabs")).toBeDisplayed();
    expect(await count("#orca-tabs .orca-tab")).toBe(0);
    await expect($("#orca-term")).not.toBeDisplayed();
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
    await expect($("#orca-empty")).toHaveText("セッションはありません");
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

    it("fits the terminal inside the pane, its last row included", async () => {
      await openOrca(withTerminals());
      await mock("orca_terminal_read", Array.from({ length: 200 }, (_, i) => `line ${i}`));
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      await browser.waitUntil(async () => (await screenText()).includes("line 199"), { timeoutMsg: "the last line never showed" });
      const box = await browser.execute(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const rows = [...document.querySelectorAll("#orca-term .orca-term-box:not([hidden]) .xterm-rows > div")];
        return { pane: r("#orca-term").bottom, screen: r("#orca-term .orca-term-box:not([hidden]) .xterm-screen").bottom, last: rows.at(-1)!.getBoundingClientRect().bottom };
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
      await $("#orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
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
      await $("#orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
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
    await $("#orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
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
    await $("#orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
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
    await $("#orca-term .orca-term-box:not([hidden]) .xterm-screen").click();
    await browser.keys(["y"]);
    await waitForCalls(input);
    await expect($("#error")).toHaveText("接続先につながっていません");
  });

  it("draws the size Orca sends, from the snapshot and from each size", async () => {
    await openStudio();
    await project("example-app").click();
    const [call] = await waitForCalls("orca_stream_terminal");
    const paneRows = viewportOf(call).rows;
    const rowsDrawn = () => browser.execute(() => document.querySelectorAll("#orca-term .orca-term-box:not([hidden]) .xterm-rows > div").length);
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

  it("subscribes another tab with no close, and ends the stream of the terminal when another screen or a hidden window shows", async () => {
    await openStudio(sample(), [orcaTerminal("example-app", "zsh")]);
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    const close = await mock("orca_stream_terminal_close", null);
    const subscribe = await mock("orca_stream_terminal", null);
    // Another tab: the new subscription lets the old one go, with no close that could come after it.
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    expect(await waitForCalls(subscribe)).toMatchObject([{ handle: "term_example-app_zsh" }]);
    expect(await callsOf(close)).toEqual([]);
    // Another screen.
    await $("#nav-mail").click();
    await waitForCalls(close);
    // Back on the screen the stream starts again, and a hidden window ends it. Showing the screen reads the list once with the CLI, which holds what the stream sent.
    await mock("orca_overview", orcaOverview(sample(), worktrees(), { ...studioOnly, terminals: [orcaTerminal("example-app", "zsh")] }));
    await $("#nav-orca").click();
    await waitForCalls(subscribe, 2);
    await setWindowHidden(true);
    await waitForCalls(close, 2);
    await setWindowHidden(false);
    await waitForCalls(subscribe, 3);
  });

  it("subscribes the next tab with no close when the tab shown leaves the list", async () => {
    await openStudio();
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    const close = await mock("orca_stream_terminal_close", null);
    const subscribe = await mock("orca_stream_terminal", null);
    // The Claude row of the tab shown goes and the project keeps a shell: the tab and its terminal are dropped, and the shell's subscription lets the old one go.
    await sendStream(streamList(sample().slice(1), worktrees(), [orcaTerminal("example-app", "zsh")]));
    expect(await waitForCalls(subscribe)).toMatchObject([{ handle: "term_example-app_zsh" }]);
    await browser.pause(500);
    expect(await callsOf(close)).toEqual([]);
  });

  it("ends the stream of the terminal when the tab shown leaves the list and no tab is left to show", async () => {
    await openStudio();
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    const close = await mock("orca_stream_terminal_close", null);
    await sendStream(streamList(sample().slice(1), worktrees()));
    await waitForCalls(close);
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
    await expect($("#orca-empty")).toHaveText("セッションはありません");
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
      pane: getComputedStyle(document.getElementById("orca-term")!).backgroundColor,
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

describe("orca: images on a terminal (A-10)", () => {
  const dropped = (repo: string, name = "shot.png") => `/work/${repo}/.orca/drops/${name}`;
  const shown = ".orca-term-box:not([hidden]) .xterm-helper-textarea";
  const area = "#orca-term";
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
    const attach = await mock("orca_attach_image", dropped("example-app"));
    const input = await mock("orca_terminal_input", null);
    expect(await fire("paste", shown, [image()])).toBe(true);
    expect(await waitForCalls(attach)).toEqual([{ path: "/work/example-app", name: "shot.png", data: PNG, environment: null }]);
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app_zsh", text: `${dropped("example-app")} ` }]);
  });

  it("leaves a paste with no image, or with only a file that is not an image, to the terminal", async () => {
    await openMirror();
    const attach = await mock("orca_attach_image", dropped("example-app"));
    await fire("paste", shown, []);
    await fire("paste", shown, [note]);
    await browser.pause(300);
    expect(await callsOf(attach)).toEqual([]);
  });

  it("takes images dropped on the terminal, cancels a dragover that carries a file, and types the paths in order on one line", async () => {
    await openMirror();
    const attach = await mock("orca_attach_image", dropped("example-app", "first.png"));
    const input = await mock("orca_terminal_input", null);
    expect(await fire("dragover", area, [image()])).toBe(true);
    expect(await fire("dragover", area, [])).toBe(false);
    expect(await fire("drop", area, [image("first.png"), image("second.png")])).toBe(true);
    expect((await waitForCalls(attach, 2)).map((c) => (c as { name: string }).name)).toEqual(["first.png", "second.png"]);
    await waitForCalls(input);
    expect(await inputs(input)).toEqual([`${dropped("example-app", "first.png")} ${dropped("example-app", "first.png")} `]);
  });

  it("refuses a dropped file that is not an image with the message, and puts nothing", async () => {
    await openMirror();
    const attach = await mock("orca_attach_image", dropped("example-app"));
    const input = await mock("orca_terminal_input", null);
    await fire("drop", area, [note]);
    await expect($("#error")).toHaveText("画像だけを添付できます");
    expect(await callsOf(attach)).toEqual([]);
    expect(await callsOf(input)).toEqual([]);
  });

  it("shows the message of an image that cannot be put and types nothing", async () => {
    await openMirror();
    const attach = await mock("orca_attach_image", rejects("SSH の接続先の worktree には画像を添付できません"));
    const input = await mock("orca_terminal_input", null);
    await fire("paste", shown, [image()]);
    await waitForCalls(attach);
    await expect($("#error")).toHaveText("SSH の接続先の worktree には画像を添付できません");
    expect(await callsOf(input)).toEqual([]);
  });

  it("does not take a file dropped anywhere else, and does not let the webview navigate to it", async () => {
    await openMirror();
    const attach = await mock("orca_attach_image", dropped("example-app"));
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
    const attach = await mock("orca_attach_image", dropped("example-api"));
    const input = await mock("orca_stream_input", null);
    await fire("paste", shown, [image()]);
    expect(await waitForCalls(attach)).toEqual([{ path: "/work/example-api", name: "shot.png", data: PNG, environment: "Studio" }]);
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-api", text: `${dropped("example-api")} ` }]);
  });

  it("types the path in the terminal streamed from a saved environment, to its handle", async () => {
    await openStream();
    const attach = await mock("orca_attach_image", dropped("example-app"));
    const input = await mock("orca_stream_input", null);
    await fire("drop", area, [image()]);
    expect(await waitForCalls(attach)).toEqual([{ path: "/work/example-app", name: "shot.png", data: PNG, environment: "Studio" }]);
    expect(await waitForCalls(input)).toEqual([{ handle: "term_example-app_zsh", text: `${dropped("example-app")} ` }]);
  });

  it("does not type the path in another terminal when the tab changed while the image went", async () => {
    await openStream();
    const attach = await mock("orca_attach_image", holds);
    const input = await mock("orca_stream_input", null);
    await fire("paste", shown, [image()]);
    await waitForCalls(attach);
    await project("example-api").click();
    await waitForCalls("orca_stream_terminal", 2);
    await release(attach, dropped("example-app"));
    await browser.pause(500);
    expect(await callsOf(input)).toEqual([]);
  });
});

describe("orca: links in a terminal (A-8, A-12)", () => {
  const lines = ["$ open", "docs: https://example.com/docs。続きを読む", "see (https://example.org/a)."];
  const shownBox = "#orca-term .orca-term-box:not([hidden])";

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
  async function openStream(text: string) {
    await openOrca(orcaOverview([], [], { target: "Studio", environments: ["Studio"] }));
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(sample(), worktrees()));
    await project("example-app").click();
    await waitForCalls("orca_stream_terminal");
    await sendTerm({ kind: "snapshot", data: text, cols: 80, rows: 24 });
    await browser.waitUntil(async () => (await screenText()).includes("example"), { timeoutMsg: "the screen never showed" });
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
    await openStream("$ claude\r\ndocs: https://example.com/docs");
    const open = await mock("orca_open_url", null);
    await clickOn("example.com");
    await browser.pause(300);
    expect(await callsOf(open)).toEqual([]);
    await clickOn("example.com", { metaKey: true });
    expect(await waitForCalls(open)).toEqual([{ url: "https://example.com/docs" }]);
  });

  it("opens a link that a program set with OSC 8 the same way, and shows the message when Rust refuses its URL", async () => {
    await openStream("$ cat\r\n\x1b]8;;file:///etc/hosts\x1b\\hosts file\x1b]8;;\x1b\\");
    const open = await mock("orca_open_url", rejects("開けるのは http か https の URL だけです"));
    await clickOn("hosts", { metaKey: true });
    expect(await waitForCalls(open)).toEqual([{ url: "file:///etc/hosts" }]);
    await expect($("#error")).toHaveText("開けるのは http か https の URL だけです");
  });
});
