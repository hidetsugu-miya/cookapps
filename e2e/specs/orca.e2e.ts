import {
  boot,
  callsOf,
  chatAssistant,
  chatItems,
  chatQuestion,
  chatOpens,
  chatStatus,
  chatTools,
  chatUser,
  count,
  holds,
  inbox,
  isoDate,
  mock,
  onceId,
  orcaOverview,
  orcaRow,
  orcaSkill,
  orcaSsh,
  orcaTerminal,
  orcaWorktree,
  rejects,
  release,
  rowOf as threadRowOf,
  sendChat,
  sendTerminal,
  setClock,
  termData,
  termExit,
  terminalOpens,
  terminalTargets,
  terminalWorktree,
  textsOf,
  threadDetail,
  waitForCalls,
  waitForCount,
  waitForOpens,
  waitForTerminalOpens,
} from "../support";

// A running, a waiting and a done agent, and a second running one that has no pane (its session cannot be read). Each has its own project (`proj_{repo}`).
const sample = () => [
  orcaRow("example-app", "feat/a", "Write the docs", { minutes: 2, activity: "Bash: cargo test --all-features" }),
  orcaRow("example-api", "main", "Fix the parser", { group: "waiting", minutes: 5, activity: "Which one should I use?" }),
  orcaRow("example-web", "dev", "Update the page", { minutes: 11, handle: null, paneKey: null }),
  orcaRow("example-lib", "feature/x", "Opened the pull request.", { group: "done", minutes: 18, activity: "Edit: ts/orca.ts" }),
];
const worktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];

// The app with `value` as what Orca answers, and the Orca screen open.
async function openOrca(value = orcaOverview(sample(), worktrees()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), orca_overview: value, orca_skills: [], ...fixtures });
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

async function pickMenu(label: string) {
  for (const item of await $$(".menu button")) {
    if ((await item.getText()) === label) return item.click();
  }
  throw new Error(`no menu item "${label}"`);
}

// Chooses the worktree at `path` in the dialog under the "起動先" chip.
async function pickDest(path: string) {
  await $("#orca-dest-pick").click();
  await $(`.orca-dest-pop button[data-path="${path}"]`).click();
}

// Selects the row of `repo` and waits until its history was asked for, `times` opens in all.
async function select(repo: string, times = 1) {
  await rowOf(repo).click();
  await waitForOpens(times);
}

const chatTexts = (selector = "") => textsOf(`#orca-items > ${selector || "*"}`);
const statusLine = () => textsOf("#orca-chat-status");

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

// Answers the next read with `rows`, presses the update button, and waits until the working view draws them (waiting, then working, then done), so a count checked after it is the one of that read.
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

describe("orca", () => {
  it("draws the agents in three groups with the count of what needs the user on the sidebar", async () => {
    await boot({ inbox: inbox(), orca_overview: orcaOverview(sample(), worktrees()), orca_skills: [] });
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
    // The list pane's header is the heading "プロジェクト" with the bell, the update button and the plus button; the status label is in the footer.
    expect(await textsOf("#orca-heading")).toEqual(["プロジェクト"]);
    await expect($("#orca-new")).toHaveAttribute("aria-label", "新しく起動する");
    await expect($("#orca-new")).toHaveAttribute("aria-haspopup", "menu");
    await expect($("#orca-refresh")).toHaveAttribute("aria-label", "更新");
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
    await boot({ inbox: inbox(), orca_overview: orcaOverview([]), orca_skills: [] });
    await $("#nav-orca").click();
    await $("#orca-bell").click();
    await expect($("#orca-feed")).toHaveText(expect.stringContaining("動いているエージェントはありません"));
    await expect($("#nav-orca .nav-count")).not.toBeDisplayed();
  });

  it("has the list on the left, the divider, and the work pane in new-session state at the start", async () => {
    await openOrca();
    const box = await browser.execute(() => {
      const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return { listLeft: r("orca-list").left, listRight: r("orca-list").right, splitLeft: r("orca-split").left, splitRight: r("orca-split").right, workLeft: r("orca-work").left, share: r("orca-list").width / r("orca").width };
    });
    expect(box.listRight).toBeLessThanOrEqual(box.splitLeft + 1);
    expect(box.splitRight).toBeLessThanOrEqual(box.workLeft + 1);
    expect(box.share).toBeCloseTo(0.3, 2);
    await expect($("#orca-work-title")).toHaveText("新しいセッション");
    await expect($("#orca-dest")).toBeDisplayed();
    await expect($("#orca-dest-pick")).toHaveText("worktree を選ぶ");
    await expect($("#orca-send")).toHaveText("起動する");
    expect(await $("#orca-input").getProperty("placeholder")).toBe("");
    expect(await chatOpens()).toEqual([]);
  });

  it("selects a row with a click, shows its tab and opens its history", async () => {
    await openWorking();
    await select("example-app");
    expect(await pressed("example-app")).toBe("true");
    expect(await chatOpens()).toEqual([{ environment: null, path: "/work/example-app", paneKey: "tab_example-app:leaf_1", channel: true }]);
    // The tabs of its project replace the heading of the work pane.
    await expect($("#orca-work-title")).not.toBeDisplayed();
    await expect($('#orca-tabs [role="tab"][aria-selected="true"]')).toHaveText(expect.stringContaining("Write the docs"));
    await expect($("#orca-send")).toHaveText("送る");
    expect(await $("#orca-input").getProperty("placeholder")).toBe("");
    await expect($("#orca-dest")).not.toBeDisplayed();
    // Another row takes the selection and its history.
    await select("example-lib", 2);
    expect(await pressed("example-app")).toBe("false");
    expect(await pressed("example-lib")).toBe("true");
    expect((await chatOpens()).map((c) => c.path)).toEqual(["/work/example-app", "/work/example-lib"]);
    await expect($('#orca-tabs [role="tab"][aria-selected="true"]')).toHaveText(expect.stringContaining("Opened the pull request."));
  });

  it("closes the history and goes back to the new-session state with \"Claude を起動\" of the plus menu", async () => {
    await openWorking();
    const close = await mock("orca_chat_close", null);
    await select("example-lib");
    await $("#orca-new").click();
    await pickMenu("Claude を起動");
    expect(await pressed("example-lib")).toBe("false");
    expect(await waitForCalls(close)).toEqual([null]);
    await expect($("#orca-work-title")).toHaveText("新しいセッション");
    await expect($("#orca-tabs")).not.toBeDisplayed();
    await expect($("#orca-send")).toHaveText("起動する");
    await expect($("#orca-dest")).toBeDisplayed();
    expect(await chatOpens()).toHaveLength(1);
  });

  it("pauses the history read while the window is hidden, also for a session opened then, and resumes it when shown", async () => {
    await openWorking();
    const pause = await mock("orca_chat_pause", null);
    // fixtures.js makes the page report a shown window; the spec turns it hidden and tells the page.
    const setHidden = (hidden: boolean) =>
      browser.execute(
        (id, h) => {
          if (!window.__e2e_once__(id)) return;
          Object.defineProperty(document, "hidden", { get: () => h, configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
        },
        onceId(),
        hidden,
      );
    // No session is open: nothing to pause.
    await setHidden(true);
    await setHidden(false);
    await select("example-app");
    await setHidden(true);
    expect(await waitForCalls(pause)).toEqual([{ paused: true }]);
    // A session opened while hidden is paused once it is open.
    await select("example-lib", 2);
    expect(await waitForCalls(pause, 2)).toEqual([{ paused: true }, { paused: true }]);
    await setHidden(false);
    expect(await waitForCalls(pause, 3)).toEqual([{ paused: true }, { paused: true }, { paused: false }]);
  });

  it("cannot select a row that has no pane", async () => {
    await openWorking();
    await expect(rowOf("example-web")).toBeDisabled();
    await expect(rowOf("example-app")).not.toBeDisabled();
  });

  it("reads the history of a session that has no terminal, and does not post to it", async () => {
    await openWorking(orcaOverview([orcaRow("example-app", "feat/a", "Write the docs", { handle: null })], worktrees()));
    await select("example-app");
    await $("#orca-input").setValue("Hello");
    await expect($("#orca-send")).toHaveText("送る");
    await expect($("#orca-send")).toBeDisabled();
  });

  it("sends the text to the selected session, clears the field and reads the list at once", async () => {
    await openWorking();
    const send = await mock("orca_send", null);
    const overview = await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await rowOf("example-app").click();
    await expect($("#orca-send")).toBeDisabled();
    await $("#orca-input").setValue("--json is not an option");
    await $("#orca-send").click();
    expect(await waitForCalls(send)).toEqual([{ handle: "term_example-app", text: "--json is not an option", environment: null }]);
    await expect($("#orca-input")).toHaveValue("");
    expect(await waitForCalls(overview)).toHaveLength(1);
    await expect($("#orca-error")).not.toBeDisplayed();
    // The selection stays for the next post.
    expect(await pressed("example-app")).toBe("true");
  });

  it("keeps the text when the send fails, and shows the message", async () => {
    await openWorking();
    const send = await mock("orca_send", rejects("No such terminal"));
    await rowOf("example-app").click();
    await $("#orca-input").setValue("Please continue");
    await $("#orca-send").click();
    await waitForCalls(send);
    await expect($("#orca-error")).toHaveText("No such terminal");
    await expect($("#orca-input")).toHaveValue("Please continue");
    await expect($("#orca-send")).toBeEnabled();
    // Pressing again is a new attempt by the user, not a retry: the next success clears the message and the text.
    await mock("orca_send", null);
    await $("#orca-send").click();
    await expect($("#orca-input")).toHaveValue("");
    await expect($("#orca-error")).not.toBeDisplayed();
  });

  it("starts Claude in the chosen worktree, with no agent in the arguments", async () => {
    await openOrca();
    const launch = await mock("orca_launch", null);
    // Needs a worktree before it can start.
    await $("#orca-input").setValue("Write the docs");
    await expect($("#orca-send")).toBeDisabled();
    await pickDest("/work/example-api");
    await expect($("#orca-dest-pick")).toHaveText("example-api ・ main");
    await expect($(".orca-dest-pop")).not.toExist();
    await $("#orca-send").click();
    expect(await waitForCalls(launch)).toEqual([{ path: "/work/example-api", text: "Write the docs", environment: null }]);
    await expect($("#orca-input")).toHaveValue("");
  });

  it("keeps the text when the launch fails", async () => {
    await openOrca();
    const launch = await mock("orca_launch", rejects("Worktree not found"));
    await pickDest("/work/example-app");
    await $("#orca-input").setValue("Try this");
    await $("#orca-send").click();
    await waitForCalls(launch);
    await expect($("#orca-error")).toHaveText("Worktree not found");
    await expect($("#orca-input")).toHaveValue("Try this");
  });

  it("narrows the worktrees in the dialog with a filter, in two-line rows", async () => {
    await openOrca();
    // The driver's click focuses the button after the page's handler ran, which no real press does, so this press is the page's own.
    await browser.execute((id) => {
      if (window.__e2e_once__(id)) document.getElementById("orca-dest-pick")!.click();
    }, onceId());
    const pop = $(".orca-dest-pop");
    await expect(pop).toHaveAttribute("role", "dialog");
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
    await expect($("#orca-send")).toBeDisabled();
    await $("#orca-input").setValue("Hello");
    await expect($("#orca-send")).toBeDisabled();
    // The start and showing the screen read; the clock (every 10 seconds on this screen) reads no more.
    const before = (await callsOf("orca_overview")).length;
    await browser.pause(12_000);
    expect(await callsOf("orca_overview")).toHaveLength(before);
    // The update button looks again.
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

  it("makes the label a menu of the targets once an environment is saved", async () => {
    await openWorking(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
    await expect($("#orca-target")).toHaveText("Studio に接続中");
    await expect($("#orca-status")).not.toBeDisplayed();
    // Posts name the target the screen shows.
    const send = await mock("orca_send", null);
    await rowOf("example-app").click();
    await $("#orca-input").setValue("Hello");
    await $("#orca-send").click();
    expect(await waitForCalls(send)).toEqual([{ handle: "term_example-app", text: "Hello", environment: "Studio" }]);
    await $("#orca-target").click();
    expect(await textsOf(".menu button")).toEqual(["このマシン", "Studio", "Lab"]);
    const save = await mock("orca_set_target", null);
    const overview = await mock("orca_overview", orcaOverview([orcaRow("lab-app", "main", "Lab task")], [], { target: null, environments: ["Studio", "Lab"] }));
    await pickMenu("このマシン");
    expect(await waitForCalls(save)).toEqual([{ environment: null }]);
    await waitForCalls(overview);
    await expect($("#orca-target")).toHaveText("このマシン に接続中");
    // The sessions of the old target are gone, with the selection.
    await waitForCount("#orca-feed .orca-row", 1);
    await expect($("#orca-send")).toHaveText("起動する");
  });

  it("opens the history of the target the screen shows, and closes it when the target changes", async () => {
    await openWorking(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
    const close = await mock("orca_chat_close", null);
    await select("example-app");
    expect(await chatOpens()).toEqual([{ environment: "Studio", path: "/work/example-app", paneKey: "tab_example-app:leaf_1", channel: true }]);
    await mock("orca_set_target", null);
    await mock("orca_overview", orcaOverview([], [], { target: "Lab", environments: ["Studio", "Lab"] }));
    await $("#orca-target").click();
    await pickMenu("Lab");
    await waitForCalls(close);
    await expect($("#orca-work-title")).toHaveText("新しいセッション");
  });

  it("keeps the selection and the text through a read in the background, and does not draw the history again", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([chatUser("u1", "Hello there")]));
    await browser.execute(() => document.querySelector("#orca-items .orca-user")!.setAttribute("data-mark", "same"));
    await $("#orca-input").setValue("Half written");
    // The clock reads again within 10 seconds (the first read of this screen was at its opening).
    const overview = await mock("orca_overview", orcaOverview([...sample(), orcaRow("example-new", "main", "Fresh", { minutes: 1 })], worktrees()));
    await waitForCalls(overview);
    await waitForCount("#orca-feed .orca-row", 5);
    expect(await pressed("example-app")).toBe("true");
    await expect($("#orca-input")).toHaveValue("Half written");
    await expect($("#orca")).toBeDisplayed();
    await expect($('#orca-tabs [role="tab"][aria-selected="true"]')).toHaveText(expect.stringContaining("Write the docs"));
    // The same node is still there, and the history was not asked for again.
    await expect($('#orca-items .orca-user[data-mark="same"]')).toExist();
    expect(await chatOpens()).toHaveLength(1);
  });

  it("drops the tab of a session that is gone, and closes its history", async () => {
    await openWorking();
    const close = await mock("orca_chat_close", null);
    await select("example-app");
    await mock("orca_overview", orcaOverview([orcaRow("example-api", "main", "Fix the parser")], worktrees()));
    await $("#orca-refresh").click();
    await waitForCount("#orca-feed .orca-row", 1);
    // The project is still selected, with no session left in it.
    await expect($("#orca-empty")).toBeDisplayed();
    await expect($("#orca-empty")).toHaveText("セッションはありません");
    await expect($("#orca-tabs")).not.toBeDisplayed();
    await waitForCalls(close);
  });

  it("reads everything when the screen is shown or updated, and the clock only the agents of the target held", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }));
    const scopes = async () => (await callsOf("orca_overview")).map((c) => (c as { scope: string }).scope);
    // The first read and showing the screen.
    expect(await scopes()).toEqual(["full", "full"]);
    // The clock, within 10 seconds on this screen.
    const overview = await mock("orca_overview", orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }));
    expect(await waitForCalls(overview)).toEqual([{ scope: "screen", target: "Studio" }]);
    await $("#orca-refresh").click();
    expect(await waitForCalls(overview, 2)).toEqual([
      { scope: "screen", target: "Studio" },
      { scope: "full", target: "Studio" },
    ]);
  });

  it("disables the text while it is posted, and gives it back with the focus", async () => {
    await openWorking();
    const send = await mock("orca_send", holds);
    await rowOf("example-app").click();
    await $("#orca-input").setValue("Slow one");
    await $("#orca-send").click();
    await waitForCalls(send);
    await expect($("#orca-input")).toBeDisabled();
    await expect($("#orca-send")).toBeDisabled();
    await release(send, null);
    await expect($("#orca-input")).toBeEnabled();
    await expect($("#orca-input")).toHaveValue("");
    expect(await browser.execute(() => document.activeElement?.id)).toBe("orca-input");
  });

  it("asks for the worktree again after a row was selected", async () => {
    await openWorking();
    await pickDest("/work/example-app");
    await expect($("#orca-dest-pick")).toHaveText("example-app ・ feat/a");
    await rowOf("example-app").click();
    await $("#orca-new").click();
    await pickMenu("Claude を起動");
    await expect($("#orca-dest-pick")).toHaveText("worktree を選ぶ");
    await $("#orca-input").setValue("Go");
    await expect($("#orca-send")).toBeDisabled();
  });

  it("says nothing about a new target until its first read comes back, and keeps the menu", async () => {
    await openWorking(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
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
    await openWorking(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
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
  // A drag of the divider (pointer events, as the divider listens for them) that ends with the pointer at `fraction` of #orca's width from its left edge.
  const drag = (fraction: number) =>
    browser.execute((f) => {
      const box = document.getElementById("orca")!.getBoundingClientRect();
      const at = (x: number): PointerEventInit => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: box.left + box.width * x, clientY: box.top + 80 });
      document.getElementById("orca-split")!.dispatchEvent(new PointerEvent("pointerdown", at(0.3)));
      document.dispatchEvent(new PointerEvent("pointermove", at(f)));
      document.dispatchEvent(new PointerEvent("pointerup", at(f)));
    }, fraction);
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

describe("orca: the session history", () => {
  const user = chatUser("u1", "Make the list narrower");
  const answer = chatAssistant("a1", "I will narrow the **list** pane.\n\n- first\n- second");
  const tools = (calls: [string, string][] = [["Read", "ts/orca.ts"], ["Edit", "ts/orca.ts"], ["Bash", "npm test"]], running: string | null = null) =>
    chatTools("t1", `ツールを ${calls.length} 回実行`, calls, running);
  const scrollBox = () => ({
    atBottom: () => browser.execute(() => { const b = document.getElementById("orca-chat")!; return b.scrollHeight - b.scrollTop - b.clientHeight < 2; }),
    top: () => browser.execute(() => document.getElementById("orca-chat")!.scrollTop),
    set: (y: number) => browser.execute((v) => { document.getElementById("orca-chat")!.scrollTop = v; }, y),
    offsetOf: (id: string) =>
      browser.execute((i) => document.querySelector(`#orca-items [data-id="${i}"]`)!.getBoundingClientRect().top - document.getElementById("orca-chat")!.getBoundingClientRect().top, id),
  });
  const many = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => chatUser(`m${from + i}`, `message ${from + i}`));

  it("says it is loading until the first items come, and then nothing", async () => {
    await openWorking();
    await select("example-app");
    expect(await statusLine()).toEqual(["読み込んでいます…"]);
    await sendChat(chatStatus("live"));
    expect(await statusLine()).toEqual([""]);
    await sendChat(chatItems([user]));
    expect(await statusLine()).toEqual([""]);
  });

  it("draws the user's messages on the right, the agent's answers as Markdown and the tools as a folded line", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([user, answer, tools()]));
    expect(await textsOf("#orca-items .orca-user")).toEqual(["Make the list narrower"]);
    expect(await textsOf("#orca-items .orca-assistant strong")).toEqual(["list"]);
    expect(await textsOf("#orca-items .orca-assistant li")).toEqual(["first", "second"]);
    expect(await textsOf("#orca-items .orca-tools-label")).toEqual(["ツールを 3 回実行"]);
    await expect($(".orca-tools-btn")).toHaveAttribute("aria-expanded", "false");
    await expect($(".orca-tool-list")).not.toBeDisplayed();
    // The user's bubble is right-aligned; the agent's text starts at the left.
    const sides = await browser.execute(() => {
      const chat = document.getElementById("orca-chat")!.getBoundingClientRect();
      const left = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().left - chat.left;
      return { user: left(".orca-user"), assistant: left(".orca-assistant") };
    });
    expect(sides.user).toBeGreaterThan(sides.assistant + 50);
  });

  it("shows the agent's question unfolded, with its choices, and whether it waits or what was answered", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([chatQuestion("q1", null, true)]));
    await expect($("#orca-items .orca-question")).toBeDisplayed();
    await expect($("#orca-items .orca-question-text")).toHaveText("Which one?");
    expect(await textsOf("#orca-items .orca-question-label")).toEqual(["First", "Second"]);
    expect(await textsOf("#orca-items .orca-question-desc")).toEqual(["the first way"]);
    await expect($("#orca-items .orca-question-waiting")).toHaveText("回答待ち");
    await expect($("#orca-items .orca-question-answer")).not.toExist();
    await sendChat(chatItems([chatQuestion("q1", "First", false)]));
    await expect($("#orca-items .orca-question-answer")).toHaveText("回答: First");
    await expect($("#orca-items .orca-question-waiting")).not.toExist();
  });

  it("rules the cells of a table in the agent's answer", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([chatAssistant("a1", "| a | b |\n|---|---|\n| 1 | 2 |")]));
    await expect($("#orca-items .orca-assistant td")).toExist();
    for (const cell of ["th", "td"]) {
      const border = await browser.execute((s) => getComputedStyle(document.querySelector(s)!).borderTopWidth, `#orca-items .orca-assistant ${cell}`);
      expect(border).toBe("1px");
    }
  });

  it("does not load a remote image of the agent's answer", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([chatAssistant("a1", "![logo](https://example.com/logo.png) is shown")]));
    expect(await textsOf("#orca-items .orca-assistant")).toEqual(["logo is shown"]);
    await expect($("#orca-items img")).not.toExist();
  });

  it("replaces the timeline from the index an event names", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([user, chatAssistant("a1", "Narrowing now."), tools()]));
    await sendChat(chatItems([chatAssistant("a2", "Done."), chatUser("u2", "Thanks")], 2));
    expect(await chatTexts()).toEqual(["Make the list narrower", "Narrowing now.", "Done.", "Thanks"]);
    // From the start, and shorter: the rest is dropped.
    await sendChat(chatItems([chatUser("u3", "Only one")]));
    expect(await chatTexts()).toEqual(["Only one"]);
  });

  it("folds and unfolds the tool calls, and keeps a run open while it grows and the timeline is drawn again", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([user, tools([["Read", "ts/orca.ts"]])]));
    await $(".orca-tools-btn").click();
    await expect($(".orca-tools-btn")).toHaveAttribute("aria-expanded", "true");
    expect(await textsOf(".orca-tool-call")).toEqual(["Read  ts/orca.ts"]);
    // The run grows (the same id, drawn again from its index): it stays open.
    await sendChat(chatItems([tools([["Read", "ts/orca.ts"], ["Bash", "npm test"], ["TodoWrite", ""]])], 1));
    await expect($(".orca-tools-btn")).toHaveAttribute("aria-expanded", "true");
    await expect($(".orca-tool-list")).toBeDisplayed();
    expect(await textsOf(".orca-tool-call")).toEqual(["Read  ts/orca.ts", "Bash  npm test", "TodoWrite"]);
    // A whole redraw keeps it too.
    await sendChat(chatItems([user, tools([["Read", "ts/orca.ts"], ["Bash", "npm test"], ["TodoWrite", ""]])]));
    await expect($(".orca-tool-list")).toBeDisplayed();
    await $(".orca-tools-btn").click();
    await expect($(".orca-tools-btn")).toHaveAttribute("aria-expanded", "false");
    await expect($(".orca-tool-list")).not.toBeDisplayed();
    await sendChat(chatItems([tools([["Read", "ts/orca.ts"]])], 1));
    await expect($(".orca-tools-btn")).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the running summary of a run still going while the agent is working, and the summary when it is not", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([tools([["Edit", "ts/orca.ts"]], "ツールを実行中")]));
    expect(await textsOf(".orca-tools-label")).toEqual(["ツールを実行中"]);
    // The agent is done now: the next read of the list says so, and the label is the summary.
    await mock("orca_overview", orcaOverview([orcaRow("example-app", "feat/a", "Write the docs", { group: "done" })], worktrees()));
    await $("#orca-refresh").click();
    await browser.waitUntil(async () => (await textsOf(".orca-tools-label"))[0] === "ツールを 1 回実行", { timeoutMsg: "the label never became the summary" });
  });

  it("shows a run with no running summary by its summary even while the agent works", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([tools()]));
    expect(await textsOf(".orca-tools-label")).toEqual(["ツールを 3 回実行"]);
  });

  it("shows the reconnecting and unavailable messages above the chat, and takes them away when the read is live", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems([user]));
    await sendChat(chatStatus("reconnecting", "Orca に接続できません。つなぎ直しています"));
    expect(await statusLine()).toEqual(["Orca に接続できません。つなぎ直しています"]);
    await expect($("#orca-chat-status .pending")).toBeDisplayed();
    // What was drawn stays.
    expect(await chatTexts()).toEqual(["Make the list narrower"]);
    await sendChat(chatStatus("unavailable", "このセッションの履歴は読めません"));
    expect(await statusLine()).toEqual(["このセッションの履歴は読めません"]);
    await sendChat(chatStatus("live"));
    expect(await statusLine()).toEqual([""]);
  });

  it("shows the message of a history that could not be opened", async () => {
    await openWorking();
    await mock("orca_chat_open", rejects("エージェントの場所が正しくありません"));
    await rowOf("example-app").click();
    await waitForOpens();
    await browser.waitUntil(async () => (await statusLine())[0] === "エージェントの場所が正しくありません", { timeoutMsg: "the message never showed" });
  });

  it("ignores the events of a channel that is no longer the current one", async () => {
    await openWorking();
    await select("example-app");
    await select("example-lib", 2);
    await sendChat(chatItems([chatUser("old", "From the first session")]), 0);
    expect(await chatTexts()).toEqual([]);
    await sendChat(chatItems([chatUser("new", "From the second session")]), 1);
    expect(await chatTexts()).toEqual(["From the second session"]);
    // Another session starts from nothing.
    await select("example-app", 3);
    expect(await chatTexts()).toEqual([]);
  });

  it("closes the history when the screen is left and opens it again when the screen is shown with the row still selected", async () => {
    await openWorking();
    const close = await mock("orca_chat_close", null);
    await select("example-app");
    await $("#nav-mail").click();
    await waitForCalls(close);
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await waitForOpens(2);
    expect(await chatOpens()).toEqual([
      { environment: null, path: "/work/example-app", paneKey: "tab_example-app:leaf_1", channel: true },
      { environment: null, path: "/work/example-app", paneKey: "tab_example-app:leaf_1", channel: true },
    ]);
    // The new channel draws; the work pane still names the row.
    await sendChat(chatItems([user]));
    expect(await chatTexts()).toEqual(["Make the list narrower"]);
    await expect($('#orca-tabs [role="tab"][aria-selected="true"]')).toHaveText(expect.stringContaining("Write the docs"));
  });

  it("scrolls to the bottom when a session is opened, and stays at the bottom as items arrive", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems(many(0, 40)));
    expect(await scrollBox().atBottom()).toBe(true);
    expect(await scrollBox().top()).toBeGreaterThan(0);
    await sendChat(chatItems(many(40, 43), 40));
    expect(await scrollBox().atBottom()).toBe(true);
  });

  it("does not move the scroll position when items arrive while it is scrolled up", async () => {
    await openWorking();
    await select("example-app");
    await sendChat(chatItems(many(0, 40)));
    await scrollBox().set(300);
    const before = await scrollBox().offsetOf("m10");
    await sendChat(chatItems(many(40, 43), 40));
    expect(await scrollBox().top()).toBeCloseTo(300, 0);
    expect(await scrollBox().offsetOf("m10")).toBeCloseTo(before, 0);
    expect(await scrollBox().atBottom()).toBe(false);
  });

  it("offers older history while there is more, reads it on a press, and keeps the message in view where it is when it arrives", async () => {
    await openWorking();
    const older = await mock("orca_chat_older", null);
    await select("example-app");
    await expect($("#orca-older")).not.toBeDisplayed();
    await sendChat(chatItems(many(10, 50), 0, true));
    await expect($("#orca-older")).toBeDisplayed();
    await expect($("#orca-older")).toHaveText("以前の履歴を読む");
    await scrollBox().set(400);
    await $("#orca-older").click();
    expect(await waitForCalls(older)).toEqual([null]);
    // Measured after the press: the button is at the top of the list, so the driver scrolls up to it.
    const before = await scrollBox().offsetOf("m20");
    // The older page arrives as a redraw from the start with no more to read.
    await sendChat(chatItems(many(0, 50), 0, false));
    await expect($("#orca-older")).not.toBeDisplayed();
    // scrollTop moves in whole pixels.
    expect(Math.abs((await scrollBox().offsetOf("m20")) - before)).toBeLessThan(2);
    expect(await textsOf("#orca-items > *")).toHaveLength(50);
  });
});

describe("orca skill list", () => {
  const skills = () => [
    orcaSkill("/commit", "Create a commit"),
    orcaSkill("/mempalace:search", "Search the palace"),
    orcaSkill("/pr-review", "Review a pull request"),
    orcaSkill("/review", "Review the changes"),
    orcaSkill("/simplify", "Simplify the code"),
  ];
  const popup = () => $("#orca-complete");
  const commands = () => textsOf("#orca-complete code");
  const activeCommand = () => browser.execute(() => document.querySelector('#orca-complete [aria-selected="true"] code')?.textContent ?? null);
  const press = (key: string) =>
    browser.execute(
      (id, k) => {
        if (!window.__e2e_once__(id)) return;
        document.getElementById("orca-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      },
      onceId(),
      key,
    );
  // The exact text of the field (`toHaveValue` trims what it reads) and whether the caret is at its end.
  const typed = () =>
    browser.execute(() => {
      const field = document.getElementById("orca-input") as HTMLTextAreaElement;
      return { value: field.value, caretAtEnd: field.selectionStart === field.value.length && field.selectionEnd === field.value.length };
    });
  const openWithSkills = async (list = skills(), rows = sample()) => {
    await openOrca(orcaOverview(rows, worktrees()), { orca_skills: list });
    await waitForCalls("orca_skills");
  };

  it("opens when the text starts with a slash, and narrows with prefix matches first", async () => {
    await openWithSkills();
    await $("#orca-input").setValue("/");
    await expect(popup()).toBeDisplayed();
    expect(await commands()).toEqual(["/commit", "/mempalace:search", "/pr-review", "/review", "/simplify"]);
    await expect($('#orca-complete [role="option"]')).toHaveText(expect.stringContaining("Create a commit"));
    await expect(popup()).toHaveAttribute("role", "listbox");
    await $("#orca-input").setValue("/rev");
    // "review" starts with the query; "pr-review" only contains it.
    expect(await commands()).toEqual(["/review", "/pr-review"]);
    await $("#orca-input").setValue("/SEARCH");
    expect(await commands()).toEqual(["/mempalace:search"]);
    await $("#orca-input").setValue("/zzz");
    await expect(popup()).not.toBeDisplayed();
  });

  it("is asked for once, with no environment, and not on every keystroke", async () => {
    await openWithSkills();
    await $("#orca-input").setValue("/rev");
    await $("#orca-input").setValue("/revi");
    expect(await callsOf("orca_skills")).toEqual([null]);
  });

  it("opens with a saved environment as the target, and asks for the skills with no environment", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }), { orca_skills: skills() });
    await waitForCalls("orca_skills");
    await $("#orca-input").setValue("/rev");
    await expect(popup()).toBeDisplayed();
    expect(await commands()).toEqual(["/review", "/pr-review"]);
    expect(await callsOf("orca_skills")).toEqual([null]);
  });

  it("opens while the target fails to read, and is not read again when the target changes", async () => {
    await openOrca(orcaOverview([], [], { state: "failed", message: "Orca is busy", target: "Studio", environments: ["Studio", "Lab"] }), { orca_skills: skills() });
    await waitForCalls("orca_skills");
    await $("#orca-input").setValue("/rev");
    await expect(popup()).toBeDisplayed();
    await mock("orca_set_target", null);
    await mock("orca_overview", orcaOverview([], [], { target: "Lab", environments: ["Studio", "Lab"] }));
    await $("#orca-target").click();
    await pickMenu("Lab");
    await expect($("#orca-target")).toHaveText("Lab に接続中");
    expect(await callsOf("orca_skills")).toEqual([null]);
  });

  it("moves with the arrow keys around the ends, and Tab puts the command in with one space", async () => {
    await openWithSkills();
    await $("#orca-input").setValue("/");
    expect(await activeCommand()).toBe("/commit");
    await press("ArrowUp");
    expect(await activeCommand()).toBe("/simplify");
    await expect(popup()).toHaveAttribute("aria-activedescendant", "orca-skill-4");
    await press("ArrowDown");
    expect(await activeCommand()).toBe("/commit");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(await activeCommand()).toBe("/pr-review");
    await press("Tab");
    expect(await typed()).toEqual({ value: "/pr-review ", caretAtEnd: true });
    await expect(popup()).not.toBeDisplayed();
  });

  it("does not post on Enter while the list is open, and Enter puts the command in", async () => {
    await openWithSkills();
    const launch = await mock("orca_launch", null);
    await pickDest("/work/example-app");
    await $("#orca-input").setValue("/rev");
    await press("Enter");
    expect(await typed()).toEqual({ value: "/review ", caretAtEnd: true });
    await expect(popup()).not.toBeDisplayed();
    expect(await callsOf(launch)).toEqual([]);
    // The text goes on after the command.
    await $("#orca-input").addValue("now");
    await $("#orca-send").click();
    expect(await waitForCalls(launch)).toEqual([{ path: "/work/example-app", text: "/review now", environment: null }]);
  });

  it("takes a click on a row", async () => {
    await openWithSkills();
    await $("#orca-input").setValue("/s");
    // The row is found by its place and clicked once: the list goes at the click, and a row looked up after it is gone.
    const index = (await commands()).indexOf("/simplify");
    expect(index).toBeGreaterThanOrEqual(0);
    await (await $$("#orca-complete .orca-skill"))[index].click();
    expect(await typed()).toEqual({ value: "/simplify ", caretAtEnd: true });
    await expect(popup()).not.toBeDisplayed();
  });

  it("closes on Escape until the text changes", async () => {
    await openWithSkills();
    await $("#orca-input").setValue("/re");
    await expect(popup()).toBeDisplayed();
    await press("Escape");
    await expect(popup()).not.toBeDisplayed();
    await $("#orca-input").addValue("v");
    await expect(popup()).toBeDisplayed();
  });

  it("is not offered once the first word has a space after it, or when the text does not start with a slash", async () => {
    await openWithSkills();
    await $("#orca-input").setValue("/review ");
    await expect(popup()).not.toBeDisplayed();
    await $("#orca-input").setValue("/review the");
    await expect(popup()).not.toBeDisplayed();
    await $("#orca-input").setValue("please /rev");
    await expect(popup()).not.toBeDisplayed();
  });

  it("shows at most 8 rows and scrolls the rest", async () => {
    await openWithSkills(Array.from({ length: 12 }, (_, i) => orcaSkill(`/skill-${String(i).padStart(2, "0")}`, `Skill ${i}`)));
    await $("#orca-input").setValue("/");
    await waitForCount("#orca-complete .orca-skill", 12);
    const box = await browser.execute(() => {
      const e = document.getElementById("orca-complete")!;
      const row = e.querySelector<HTMLElement>(".orca-skill")!;
      return { visible: Math.floor(e.clientHeight / row.offsetHeight), scrolls: e.scrollHeight > e.clientHeight };
    });
    expect(box.visible).toBeLessThanOrEqual(8);
    expect(box.scrolls).toBe(true);
    // Moving to the last row scrolls it into view.
    await press("ArrowUp");
    expect(await activeCommand()).toBe("/skill-11");
    expect(await browser.execute(() => document.getElementById("orca-complete")!.scrollTop)).toBeGreaterThan(0);
  });

  it("is offered for a selected session as for a new launch", async () => {
    await openWithSkills();
    await $("#orca-bell").click();
    await $("#orca-input").setValue("/rev");
    await expect(popup()).toBeDisplayed();
    // Selecting a session closes the list (the text lost the focus to the row), and the same text opens it again.
    await rowOf("example-app").click();
    await $("#orca-input").setValue("/rev");
    await expect(popup()).toBeDisplayed();
    expect(await commands()).toEqual(["/review", "/pr-review"]);
  });

  it("stays open with the same highlight through a read in the background", async () => {
    await openWithSkills();
    await $("#orca-bell").click();
    await $("#orca-input").setValue("/");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(await activeCommand()).toBe("/pr-review");
    const overview = await mock("orca_overview", orcaOverview([...sample(), orcaRow("example-new", "main", "Fresh")], worktrees()));
    await waitForCalls(overview);
    await waitForCount("#orca-feed .orca-row", 5);
    await expect(popup()).toBeDisplayed();
    expect(await activeCommand()).toBe("/pr-review");
  });

  it("does not open while the text has no focus, when a read in the background comes", async () => {
    await openWithSkills();
    await $("#orca-bell").click();
    await $("#orca-input").setValue("/re");
    await expect(popup()).toBeDisplayed();
    await browser.execute(() => document.getElementById("orca-input")!.blur());
    await expect(popup()).not.toBeDisplayed();
    const overview = await mock("orca_overview", orcaOverview([...sample(), orcaRow("example-new", "main", "Fresh")], worktrees()));
    await waitForCalls(overview);
    await waitForCount("#orca-feed .orca-row", 5);
    await expect(popup()).not.toBeDisplayed();
    // Back in the text, it opens again.
    await $("#orca-input").click();
    await expect(popup()).toBeDisplayed();
  });

  it("gives no list, and still posts, when the skills cannot be read", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_skills: rejects("skills failed") });
    await waitForCalls("orca_skills");
    const launch = await mock("orca_launch", null);
    await pickDest("/work/example-app");
    await $("#orca-input").setValue("/review");
    await expect(popup()).not.toBeDisplayed();
    await $("#orca-send").click();
    expect(await waitForCalls(launch)).toEqual([{ path: "/work/example-app", text: "/review", environment: null }]);
  });

  it("reads the skills again by itself after a failed read, once a minute at most", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_skills: rejects("skills failed") });
    await waitForCalls("orca_skills");
    const again = await mock("orca_skills", skills());
    // The list reads of the next seconds (the clock reads every 10 seconds on this screen) do not read the skills again.
    const overview = await mock("orca_overview", orcaOverview(sample(), worktrees()));
    await waitForCalls(overview);
    expect(await callsOf(again)).toEqual([]);
    // A minute later the next list read does, with no press of the update button.
    const later = new Date(Date.now() + 61_000);
    await setClock(`${isoDate(later)}T${later.toTimeString().slice(0, 8)}`);
    await waitForCalls(again);
    await $("#orca-input").setValue("/rev");
    await browser.waitUntil(async () => (await commands()).join() === "/review,/pr-review", { timeoutMsg: "the list never opened" });
  });

  it("reads the skills again after the update button", async () => {
    await openWithSkills();
    const skillsCalls = await mock("orca_skills", [orcaSkill("/fresh", "New")]);
    await $("#orca-refresh").click();
    await waitForCalls(skillsCalls);
    await $("#orca-input").setValue("/");
    await browser.waitUntil(async () => (await commands()).join() === "/fresh", { timeoutMsg: "the list never showed /fresh" });
  });
});

// The project view, the tabs and the terminals (A-8).
describe("orca: projects", () => {
  const hostRow = { key: "ssh:s1", name: "s1", status: "working" as const, sessions: 2, atMs: 0 };
  const withTerminals = () =>
    orcaOverview(sample(), [...worktrees(), orcaWorktree("example-idle", "main")], {
      terminals: [orcaTerminal("example-app", "zsh")],
      ssh: [orcaSsh("s1", "example-host"), orcaSsh("s2", "other-host", false)],
      hosts: [hostRow],
    });
  const projectNames = () => textsOf("#orca-feed .orca-project-name");
  const projectStatuses = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-project .orca-ic")].map((i) => i.dataset.status));
  const project = (name: string) => $(`//div[@id="orca-feed"]//button[contains(@class,"orca-project")][.//span[@class="orca-project-name"][. = "${name}"]]`);
  const tabTitles = () => textsOf("#orca-tabs .orca-tab-title");
  const tabSubs = () => textsOf("#orca-tabs .orca-tab-sub");
  const selectedTab = () => $('#orca-tabs [role="tab"][aria-selected="true"]');
  const tabOf = (id: string) => $(`#orca-tabs [data-tab="${id}"]`);
  const claudeTab = (repo: string) => `claude:tab_${repo}:leaf_1`;

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
    // Its row is a project like the others: selecting it names it.
    await project("lost-host").click();
    await expect(project("lost-host")).toHaveAttribute("aria-pressed", "true");
    await expect($("#orca-work-title")).toHaveText("lost-host");
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

  it("switches between the projects and the working agents with the bell, and the heading stays", async () => {
    await openOrca();
    await expect($("#orca-bell")).toHaveAttribute("aria-label", "作業中を表示する");
    await $("#orca-bell").click();
    await expect($("#orca-bell")).toHaveAttribute("aria-pressed", "true");
    await expect($("#orca-bell")).toHaveAttribute("aria-label", "作業中の表示をやめる");
    await waitForCount("#orca-feed .orca-row", 4);
    await expect($("#orca-feed .orca-project")).not.toExist();
    expect(await textsOf("#orca-heading")).toEqual(["プロジェクト"]);
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

  it("shows the sessions of a selected project as tabs, selects the first, and goes back to the one last selected", async () => {
    await openOrca(withTerminals());
    await mock("orca_terminal_read", ["$ ls"]);
    await project("example-app").click();
    await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
    // The Claude session first, then the shell of Orca; no heading while the tabs show.
    expect(await tabTitles()).toEqual(["Write the docs", "zsh"]);
    expect(await tabSubs()).toEqual(["feat/a ・ 2 分", "main"]);
    await expect($("#orca-work-title")).not.toBeDisplayed();
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    await waitForOpens();
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-tabs .orca-ic")].map((i) => [i.dataset.status, i.getAttribute("aria-label")]))).toEqual([
      ["working", "作業中"],
      ["done", "起動中"],
    ]);
    // A terminal fills the pane: no history and no composer.
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-btn").click();
    await expect($("#orca-term")).toBeDisplayed();
    await expect($("#orca-form")).not.toBeDisplayed();
    await expect($("#orca-chat")).not.toBeDisplayed();
    await project("example-api").click();
    await expect(selectedTab()).toHaveText(expect.stringContaining("Fix the parser"));
    await project("example-app").click();
    await expect(selectedTab()).toHaveText(expect.stringContaining("zsh"));
    // Back on the Claude tab the history and the composer show again.
    await tabOf(claudeTab("example-app")).$(".orca-tab-btn").click();
    await expect($("#orca-form")).toBeDisplayed();
    await expect($("#orca-term")).not.toBeDisplayed();
  });

  it("says a project has no session, and shows its name", async () => {
    await openOrca(withTerminals());
    await project("example-idle").click();
    await expect($("#orca-empty")).toBeDisplayed();
    await expect($("#orca-empty")).toHaveText("セッションはありません");
    await expect($("#orca-tabs")).not.toBeDisplayed();
    await expect($("#orca-work-title")).toHaveText("example-idle");
    await expect($("#orca-form")).not.toBeDisplayed();
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

  it("closes a Claude session in Orca with its handle and the target, reads the list, and keeps the selection when another tab is closed", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"], terminals: [orcaTerminal("example-app", "zsh")] }));
    await mock("orca_terminal_read", []);
    await project("example-app").click();
    const close = await mock("orca_close", null);
    // The plain terminal's close button is beside its tab: it does not select it.
    await tabOf("orca:term_example-app_zsh").$(".orca-tab-close").click();
    expect(await waitForCalls(close)).toEqual([{ handle: "term_example-app_zsh", environment: "Studio" }]);
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    // The tab leaves at the next read of the list, which follows the close.
    const overview = await mock("orca_overview", orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }));
    await tabOf(claudeTab("example-app")).$(".orca-tab-close").click();
    expect(await waitForCalls(close, 2)).toEqual([
      { handle: "term_example-app_zsh", environment: "Studio" },
      { handle: "term_example-app", environment: "Studio" },
    ]);
    await waitForCalls(overview);
    await mock("orca_overview", orcaOverview(sample().slice(1), worktrees(), { target: "Studio", environments: ["Studio"] }));
    await $("#orca-refresh").click();
    await expect($("#orca-empty")).toBeDisplayed();
    expect(await tabTitles()).toEqual([]);
  });

  it("drops the tab of a terminal that Orca closed, and selects the next one", async () => {
    await openOrca(withTerminals());
    await mock("orca_terminal_read", []);
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
    await mock("orca_terminal_read", []);
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

  it("opens the plus menu with Claude and the terminal", async () => {
    await openOrca();
    await $("#orca-new").click();
    expect(await textsOf(".menu button")).toEqual(["Claude を起動", "ターミナルを開く"]);
    await expect($("#orca-new")).toHaveAttribute("aria-expanded", "true");
    await pickMenu("Claude を起動");
    await expect($("#orca-work-title")).toHaveText("新しいセッション");
    await expect($(".menu")).not.toExist();
  });

  it("lists the destinations of a terminal: the worktrees of this machine and the SSH hosts, narrowed by a filter", async () => {
    await openOrca();
    await mock("orca_terminal_targets", terminalTargets([terminalWorktree("example-app", "feat/a"), terminalWorktree("example-api", "main")], [orcaSsh("s1", "example-host"), orcaSsh("s2", "other-host", false)]));
    await $("#orca-new").click();
    await pickMenu("ターミナルを開く");
    const pop = $(".orca-dest-pop");
    await expect(pop).toHaveAttribute("role", "dialog");
    await expect(pop).toHaveAttribute("aria-label", "起動先");
    const filter = $('.orca-dest-pop input[aria-label="起動先を絞り込む"]');
    await expect(filter).toBeFocused();
    await waitForCount(".orca-dest-pop button", 4);
    expect(await textsOf(".orca-dest-pop .orca-dest-group")).toEqual(["このマシン", "SSH"]);
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-app", "example-api", "example-host", "other-host"]);
    // The branch, and 未接続 for a host that is not connected (it can still be chosen).
    expect(await textsOf(".orca-dest-pop button span")).toEqual(["feat/a", "main", "", "未接続"]);
    await filter.setValue("API");
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-api"]);
    await filter.setValue("other");
    expect(await textsOf(".orca-dest-pop .orca-dest-group")).toEqual(["SSH"]);
    await filter.setValue("zzz");
    await expect(pop).toHaveText(expect.stringContaining("該当する起動先がありません"));
  });

  it("says why the worktrees could not be read in the dialog, and still lists the SSH hosts", async () => {
    await openOrca();
    await mock("orca_terminal_targets", terminalTargets([], [orcaSsh("s1", "example-host")], "Orca が時間内に応答しませんでした"));
    await $("#orca-new").click();
    await pickMenu("ターミナルを開く");
    await waitForCount(".orca-dest-pop button", 1);
    await expect($(".orca-dest-pop")).toHaveText(expect.stringContaining("Orca が時間内に応答しませんでした"));
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-host"]);
  });

  describe("a terminal of the app", () => {
    // The app with a worktree and an SSH host to open a terminal in, the dialog open on the plus button.
    async function openDialog() {
      await openOrca(withTerminals());
      await mock("orca_terminal_targets", terminalTargets([terminalWorktree("example-app", "feat/a")], [orcaSsh("s1", "example-host")]));
      await $("#orca-new").click();
      await pickMenu("ターミナルを開く");
      await $('.orca-dest-pop button[data-path="/work/example-app"]').waitForDisplayed();
    }
    const screenText = () => $("#orca-term .xterm-rows").getText();
    const written = async (write: string) => (await callsOf(write)).map((c) => (c as { data: string }).data).join("");
    const dragDivider = (fraction: number) =>
      browser.execute((f) => {
        const box = document.getElementById("orca")!.getBoundingClientRect();
        const at = (x: number): PointerEventInit => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: box.left + box.width * x, clientY: box.top + 80 });
        document.getElementById("orca-split")!.dispatchEvent(new PointerEvent("pointerdown", at(0.3)));
        document.dispatchEvent(new PointerEvent("pointermove", at(f)));
        document.dispatchEvent(new PointerEvent("pointerup", at(f)));
      }, fraction);

    it("opens at the chosen worktree with the size of the pane, and shows it as the selected tab of its project", async () => {
      await openDialog();
      const open = await mock("terminal_open", "pty_1");
      await $('.orca-dest-pop button[data-path="/work/example-app"]').click();
      const [call] = await waitForTerminalOpens();
      expect(call.target).toEqual({ kind: "worktree", path: "/work/example-app" });
      expect(call.channel).toBe(true);
      expect(call.cols).toBeGreaterThan(0);
      expect(call.rows).toBeGreaterThan(0);
      expect(await callsOf(open)).toHaveLength(1);
      await expect($(".menu")).not.toExist();
      await expect($("#orca-term")).toBeDisplayed();
      await expect($("#orca-form")).not.toBeDisplayed();
      await expect(selectedTab().$(".orca-tab-title")).toHaveText("ターミナル");
      await expect(selectedTab().$(".orca-tab-sub")).toHaveText("feat/a");
      await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
      // The session count of the project includes it.
      await expect(project("example-app").$(".orca-n")).toHaveText("3");
    });

    it("draws the output, sends the typed keys, and sends the new size when the pane changes", async () => {
      await openDialog();
      await mock("terminal_open", "pty_1");
      const write = await mock("terminal_write", null);
      const resize = await mock("terminal_resize", null);
      await $('.orca-dest-pop button[data-path="/work/example-app"]').click();
      const [call] = await waitForTerminalOpens();
      await sendTerminal(termData("cookapps % hello 端末"));
      await browser.waitUntil(async () => (await screenText()).includes("hello 端末"), { timeoutMsg: "the output never showed" });
      await $("#orca-term .xterm-screen").click();
      // The driver gives a typed letter the keyCode of its lower case (s is 115, which xterm.js reads as F4), so p to z are not typed here.
      await browser.keys(["c", "d", "Enter"]);
      await browser.waitUntil(async () => (await written(write)) === "cd\r", { timeoutMsg: `the keys were not sent: ${await written(write)}` });
      expect((await callsOf(write)).every((c) => (c as { id: string }).id === "pty_1")).toBe(true);
      // A narrower pane (the divider dragged to the right) has fewer columns, which Rust is told.
      await dragDivider(0.5);
      await browser.waitUntil(async () => (await callsOf(resize)).some((c) => (c as { cols: number }).cols < call.cols), { timeoutMsg: "no narrower size was sent" });
      const sizes = (await callsOf(resize)) as { id: string; cols: number; rows: number }[];
      expect(sizes.every((c) => c.id === "pty_1" && c.cols > 0 && c.rows > 0)).toBe(true);
    });

    it("confirms the output it has drawn to Rust in steps, so that a program that prints faster than the screen draws is held back", async () => {
      await openDialog();
      await mock("terminal_open", "pty_1");
      const ack = await mock("terminal_ack", null);
      await $('.orca-dest-pop button[data-path="/work/example-app"]').click();
      await waitForTerminalOpens();
      // A little output is not confirmed yet.
      await sendTerminal(termData("short"));
      await browser.waitUntil(async () => (await screenText()).includes("short"), { timeoutMsg: "the output never showed" });
      expect(await callsOf(ack)).toEqual([]);
      // Enough of it is, once, with all the bytes drawn so far.
      await sendTerminal(termData("a".repeat(40_000)));
      expect(await waitForCalls(ack)).toEqual([{ id: "pty_1", bytes: 40_005 }]);
    });

    it("shows the green dot on a project or an SSH host that Orca calls idle while a terminal of the app runs there, and the gray one when it ended", async () => {
      await openOrca(withTerminals());
      await mock("orca_terminal_targets", terminalTargets([terminalWorktree("example-idle", "main")], [orcaSsh("s2", "other-host", false)]));
      await mock("terminal_open", "pty_1");
      const dot = (name: string) => project(name).$(".orca-ic");
      await expect(dot("example-idle")).toHaveAttribute("data-status", "idle");
      await expect(dot("other-host")).toHaveAttribute("data-status", "idle");
      await $("#orca-new").click();
      await pickMenu("ターミナルを開く");
      await $('.orca-dest-pop button[data-path="/work/example-idle"]').click();
      await waitForTerminalOpens();
      await expect(dot("example-idle")).toHaveAttribute("data-status", "done");
      await expect(dot("other-host")).toHaveAttribute("data-status", "idle");
      await mock("terminal_open", "pty_2");
      await $("#orca-new").click();
      await pickMenu("ターミナルを開く");
      await $('.orca-dest-pop button[data-ssh="s2"]').click();
      // `mock` cleared the record of the first call.
      await waitForTerminalOpens();
      await expect(dot("other-host")).toHaveAttribute("data-status", "done");
      await sendTerminal(termExit(0));
      await expect(dot("other-host")).toHaveAttribute("data-status", "idle");
      await expect(dot("example-idle")).toHaveAttribute("data-status", "done");
    });

    it("keeps a row for a project the list does not show (another machine is the target) while a terminal of the app runs there, and drops it when the last one is closed", async () => {
      await openOrca({ ...withTerminals(), target: "Studio", environments: ["Studio"] });
      await mock("orca_terminal_targets", terminalTargets([terminalWorktree("example-local", "main")]));
      await mock("terminal_open", "pty_1");
      const close = await mock("terminal_close", null);
      await $("#orca-new").click();
      await pickMenu("ターミナルを開く");
      await $('.orca-dest-pop button[data-path="/work/example-local"]').click();
      await waitForTerminalOpens();
      // Under the heading of this machine, selected, with the green dot and the count.
      await expect(project("example-local")).toHaveAttribute("aria-pressed", "true");
      await expect(project("example-local").$(".orca-ic")).toHaveAttribute("data-status", "done");
      await expect(project("example-local").$(".orca-n")).toHaveText("1");
      expect(await textsOf("#orca-feed .orca-sec")).toEqual(["このマシン", "SSH"]);
      // Another project shows, and the row brings the terminal back.
      await project("example-api").click();
      await expect($("#orca-term")).not.toBeDisplayed();
      await project("example-local").click();
      await expect($("#orca-term")).toBeDisplayed();
      await $('#orca-tabs [data-tab^="pty:"] .orca-tab-close').click();
      expect(await waitForCalls(close)).toEqual([{ id: "pty_1" }]);
      await browser.waitUntil(async () => !(await project("example-local").isExisting()), { timeoutMsg: "the row of the project stayed" });
      // The work pane does not stay on a project with no row.
      await expect($("#orca-work-title")).toHaveText("新しいセッション");
    });

    it("goes back to the project that was shown when the terminal cannot be opened", async () => {
      await openOrca({ ...withTerminals(), target: "Studio", environments: ["Studio"] });
      await mock("orca_terminal_targets", terminalTargets([terminalWorktree("example-local", "main")]));
      await project("example-api").click();
      await expect(selectedTab()).toHaveText(expect.stringContaining("Fix the parser"));
      await mock("terminal_open", rejects("ターミナルを起動できません"));
      await $("#orca-new").click();
      await pickMenu("ターミナルを開く");
      await $('.orca-dest-pop button[data-path="/work/example-local"]').click();
      await waitForTerminalOpens();
      await expect($("#error")).toHaveText("ターミナルを起動できません");
      await expect(project("example-api")).toHaveAttribute("aria-pressed", "true");
      await expect(selectedTab()).toHaveText(expect.stringContaining("Fix the parser"));
      await expect(project("example-local")).not.toExist();
    });

    it("keeps running while another project shows, and ends and forgets it when its tab is closed", async () => {
      await openDialog();
      await mock("terminal_open", "pty_1");
      const close = await mock("terminal_close", null);
      await $('.orca-dest-pop button[data-path="/work/example-app"]').click();
      await waitForTerminalOpens();
      await sendTerminal(termData("still here"));
      await project("example-api").click();
      await expect($("#orca-term")).not.toBeDisplayed();
      expect(await callsOf(close)).toEqual([]);
      await project("example-app").click();
      await browser.waitUntil(async () => (await tabTitles()).length === 3, { timeoutMsg: "the tabs were not drawn" });
      await expect(selectedTab()).toHaveText(expect.stringContaining("ターミナル"));
      await browser.waitUntil(async () => (await screenText()).includes("still here"), { timeoutMsg: "the screen was not kept" });
      await $('#orca-tabs [data-tab^="pty:"] .orca-tab-close').click();
      expect(await waitForCalls(close)).toEqual([{ id: "pty_1" }]);
      expect(await tabTitles()).toHaveLength(2);
      await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    });

    it("keeps a finished terminal as a tab with a gray dot and the line 終了しました, and writes nothing to it", async () => {
      await openDialog();
      await mock("terminal_open", "pty_1");
      const write = await mock("terminal_write", null);
      await $('.orca-dest-pop button[data-path="/work/example-app"]').click();
      await waitForTerminalOpens();
      await sendTerminal(termExit(0));
      await browser.waitUntil(async () => (await screenText()).includes("[終了しました]"), { timeoutMsg: "the end was never drawn" });
      await expect(selectedTab().$(".orca-ic")).toHaveAttribute("data-status", "idle");
      await expect(selectedTab()).toBeDisplayed();
      await $("#orca-term .xterm-screen").click();
      await browser.keys(["l"]);
      await browser.pause(300);
      expect(await callsOf(write)).toEqual([]);
    });

    it("opens an SSH host by its id, and puts the tab in the host's row", async () => {
      await openDialog();
      await mock("terminal_open", "pty_2");
      await $('.orca-dest-pop button[data-ssh="s1"]').click();
      const [call] = await waitForTerminalOpens();
      expect(call.target).toEqual({ kind: "ssh", id: "s1" });
      await expect(project("example-host")).toHaveAttribute("aria-pressed", "true");
      await expect(selectedTab().$(".orca-tab-title")).toHaveText("ターミナル");
      await expect(selectedTab().$(".orca-tab-sub")).toHaveText("example-host");
    });

    it("shows the message and leaves no tab when the terminal cannot be opened", async () => {
      await openDialog();
      await mock("terminal_open", rejects("ターミナルを起動できません"));
      await $('.orca-dest-pop button[data-path="/work/example-app"]').click();
      await waitForTerminalOpens();
      await expect($("#error")).toHaveText("ターミナルを起動できません");
      // The selection is where it was (none: the new-session pane), and no tab was left behind.
      await expect($("#orca-work-title")).toHaveText("新しいセッション");
      await expect(project("example-app")).toHaveAttribute("aria-pressed", "false");
      expect(await tabTitles()).toEqual([]);
      expect(await terminalOpens()).toHaveLength(1);
    });
  });

  describe("a plain terminal of Orca", () => {
    const zsh = "orca:term_example-app_zsh";
    const screenText = () => $("#orca-term .xterm-rows").getText();

    it("mirrors the screen of the terminal once a second while its tab shows, and draws each frame again", async () => {
      await openOrca(withTerminals());
      const read = await mock("orca_terminal_read", ["$ ls", "file-a  file-b"]);
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      expect((await waitForCalls(read))[0]).toEqual({ handle: "term_example-app_zsh", environment: null });
      await browser.waitUntil(async () => (await screenText()).includes("file-b"), { timeoutMsg: "the first frame never showed" });
      await mock("orca_terminal_read", ["$ pwd", "/work/example-app"]);
      await browser.waitUntil(async () => (await screenText()).includes("/work/example-app"), { timeoutMsg: "the next frame never showed" });
      expect(await screenText()).not.toContain("file-b");
    });

    it("stops reading while another tab shows", async () => {
      await openOrca(withTerminals());
      const read = await mock("orca_terminal_read", ["$"]);
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      await waitForCalls(read);
      await tabOf(claudeTab("example-app")).$(".orca-tab-btn").click();
      await mock("orca_terminal_read", ["$"]);
      await browser.pause(2500);
      expect(await callsOf("orca_terminal_read")).toEqual([]);
    });

    it("stops reading while the window is hidden, and reads at once and goes on when it is shown", async () => {
      await openOrca(withTerminals());
      const read = await mock("orca_terminal_read", ["$"]);
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      await waitForCalls(read);
      await setWindowHidden(true);
      await mock("orca_terminal_read", ["$"]);
      await browser.pause(2500);
      expect(await callsOf("orca_terminal_read")).toEqual([]);
      await setWindowHidden(false);
      expect((await waitForCalls("orca_terminal_read"))[0]).toEqual({ handle: "term_example-app_zsh", environment: null });
      await waitForCalls("orca_terminal_read", 2);
    });

    it("sends the typed keys as they are, with the target the screen shows", async () => {
      await openOrca({ ...withTerminals(), target: "Studio", environments: ["Studio"] });
      const read = await mock("orca_terminal_read", ["$"]);
      const input = await mock("orca_terminal_input", null);
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      expect((await waitForCalls(read))[0]).toEqual({ handle: "term_example-app_zsh", environment: "Studio" });
      await $("#orca-term .xterm-screen").click();
      await browser.keys(["c", "d"]);
      await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
      expect((await callsOf(input)).every((c) => (c as { handle: string; environment: string }).handle === "term_example-app_zsh" && (c as { environment: string }).environment === "Studio")).toBe(true);
    });

    it("shows the message when the keys cannot be sent", async () => {
      await openOrca(withTerminals());
      await mock("orca_terminal_read", ["$"]);
      const input = await mock("orca_terminal_input", rejects("宛先のターミナルは終了したか、見つかりません。一覧を読み直してください"));
      await project("example-app").click();
      await tabOf(zsh).$(".orca-tab-btn").click();
      await $("#orca-term .xterm-screen").click();
      await browser.keys(["l"]);
      await waitForCalls(input);
      await expect($("#error")).toHaveText("宛先のターミナルは終了したか、見つかりません。一覧を読み直してください");
    });
  });
});

describe("orca: attached images", () => {
  // A one-pixel PNG, and what Rust answers for it: the text for Claude, the path of the file in the worktree.
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const dropped = (repo: string, name = "shot.png") => `/work/${repo}/.orca/drops/${name}`;
  // `size` stands in for the size of a file too large to be made here.
  type Given = { name: string; type: string; base64: string; size?: number };
  const image = (name = "shot.png"): Given => ({ name, type: "image/png", base64: PNG });
  const note: Given = { name: "notes.txt", type: "text/plain", base64: btoa("hello") };

  // Dispatches `kind` ("paste", "dragover" or "drop") on the element at `selector` carrying `files`, as the clipboard or the pointer would (the event objects hold plain stand-ins for the clipboard and the transfer,
  // which WKWebView builds only from a real gesture). Answers whether the page cancelled the event; `later` are more events at once, with no wait for the reads of the first.
  const fire = (kind: "paste" | "dragover" | "drop", selector: string, files: Given[], ...later: Given[][]) =>
    browser.execute(
      (k, sel, batches) => {
        const target = sel === "document" ? document.body : document.querySelector(sel)!;
        const cancelled = batches.map((given) => {
          const list = given.map((g) => {
            const file = new File([Uint8Array.from(atob(g.base64), (c) => c.charCodeAt(0))], g.name, { type: g.type });
            if (g.size !== undefined) Object.defineProperty(file, "size", { value: g.size });
            return file;
          });
          const event = new Event(k, { bubbles: true, cancelable: true });
          const transfer = { files: list, types: list.length ? ["Files"] : ["text/plain"], dropEffect: "none" };
          Object.defineProperty(event, k === "paste" ? "clipboardData" : "dataTransfer", { value: transfer });
          return !target.dispatchEvent(event);
        });
        return cancelled[0];
      },
      kind,
      selector,
      [files, ...later],
    );
  const thumbs = () => count("#orca-attachments .orca-attachment");
  const paste = (...files: Given[]) => fire("paste", "#orca-input", files);

  it("takes a pasted image as a thumbnail with a button to remove it, and leaves a paste of text alone", async () => {
    await openWorking();
    await rowOf("example-app").click();
    await expect($("#orca-attachments")).not.toBeDisplayed();
    expect(await paste()).toBe(false);
    expect(await thumbs()).toBe(0);
    expect(await paste(image())).toBe(true);
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await expect($("#orca-attachments")).toBeDisplayed();
    await expect($("#orca-attachments img")).toHaveAttribute("alt", "shot.png");
    expect(await $("#orca-attachments img").getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    await $('button[aria-label="shot.png を外す"]').click();
    await waitForCount("#orca-attachments .orca-attachment", 0);
    await expect($("#orca-attachments")).not.toBeDisplayed();
  });

  it("keeps both images when two are pasted in a row, before the first is read", async () => {
    await openWorking();
    await rowOf("example-app").click();
    expect(await fire("paste", "#orca-input", [image("first.png")], [image("second.png")])).toBe(true);
    await waitForCount("#orca-attachments .orca-attachment", 2);
    expect(await browser.execute(() => [...document.querySelectorAll("#orca-attachments img")].map((i) => (i as HTMLImageElement).alt))).toEqual(["first.png", "second.png"]);
    await expect($("#orca-send")).toBeEnabled();
  });

  it("refuses a file over 20 MiB before reading it, and adds the other images", async () => {
    await openWorking();
    await rowOf("example-app").click();
    const big: Given = { ...image("big.png"), size: 20 * 1024 * 1024 + 1 };
    await fire("drop", "#orca-form", [big]);
    await expect($("#orca-error")).toHaveText("画像は 20 MiB までです");
    expect(await thumbs()).toBe(0);
    await expect($("#orca-send")).toBeDisabled();
    // A file of exactly 20 MiB is taken, and the image beside the large one too.
    await fire("drop", "#orca-form", [big, { ...image("edge.png"), size: 20 * 1024 * 1024 }]);
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await expect($("#orca-attachments img")).toHaveAttribute("alt", "edge.png");
    await expect($("#orca-error")).toHaveText("画像は 20 MiB までです");
  });

  it("takes an image dropped on the composer, and cancels the dragover that carries a file", async () => {
    await openWorking();
    await rowOf("example-app").click();
    expect(await fire("dragover", "#orca-form", [image()])).toBe(true);
    expect(await fire("dragover", "#orca-form", [])).toBe(false);
    expect(await fire("drop", "#orca-form", [image("a.png"), image("b.png")])).toBe(true);
    await waitForCount("#orca-attachments .orca-attachment", 2);
    expect(await browser.execute(() => [...document.querySelectorAll("#orca-attachments img")].map((i) => (i as HTMLImageElement).alt))).toEqual(["a.png", "b.png"]);
  });

  it("refuses a file that is not an image with the message of the post error, and does not add it", async () => {
    await openWorking();
    await rowOf("example-app").click();
    await fire("drop", "#orca-form", [note]);
    await expect($("#orca-error")).toHaveText("画像だけを添付できます");
    expect(await thumbs()).toBe(0);
    // An image among them is added and the message stays.
    await fire("drop", "#orca-form", [note, image()]);
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await expect($("#orca-error")).toHaveText("画像だけを添付できます");
    // A paste of a file that is not an image is left to the textarea.
    expect(await paste(note)).toBe(false);
  });

  it("does not take a file dropped anywhere else, and does not let the webview navigate to it", async () => {
    await openWorking();
    await rowOf("example-app").click();
    const before = await browser.execute(() => location.href);
    expect(await fire("dragover", "document", [image()])).toBe(true);
    expect(await fire("drop", "document", [image()])).toBe(true);
    expect(await fire("drop", "#orca-feed", [image()])).toBe(true);
    // A drag that holds no file is not touched.
    expect(await fire("drop", "document", [])).toBe(false);
    expect(await browser.execute(() => location.href)).toBe(before);
    expect(await thumbs()).toBe(0);
  });

  it("enables the button for an image alone, and not before", async () => {
    await openOrca();
    await pickDest("/work/example-api");
    await expect($("#orca-send")).toBeDisabled();
    await paste(image());
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await expect($("#orca-send")).toBeEnabled();
    await $('button[aria-label="shot.png を外す"]').click();
    await expect($("#orca-send")).toBeDisabled();
  });

  it("puts each image in the worktree of the selected session, then sends the text with the paths", async () => {
    await openWorking();
    const attach = await mock("orca_attach_image", dropped("example-app"));
    const send = await mock("orca_send", null);
    await rowOf("example-app").click();
    await $("#orca-input").setValue("Look at this");
    await paste(image("shot.png"));
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await $("#orca-send").click();
    expect(await waitForCalls(send)).toEqual([{ handle: "term_example-app", text: `Look at this\n\n${dropped("example-app")}`, environment: null }]);
    expect(await callsOf(attach)).toEqual([{ path: "/work/example-app", name: "shot.png", data: PNG, environment: null }]);
    expect(await callsOf("orca_compose_text")).toEqual([{ text: "Look at this", paths: [dropped("example-app")] }]);
    await expect($("#orca-input")).toHaveValue("");
    await expect($("#orca-attachments")).not.toBeDisplayed();
    await expect($("#orca-error")).not.toBeDisplayed();
  });

  // The mock answers the same path for both images; the order of the uploads is the order of their calls.
  it("sends only the paths, one for each line in order, when the text is blank", async () => {
    await openWorking();
    const attach = await mock("orca_attach_image", dropped("example-app", "first.png"));
    const send = await mock("orca_send", null);
    await rowOf("example-app").click();
    await fire("drop", "#orca-form", [image("first.png"), image("second.png")]);
    await waitForCount("#orca-attachments .orca-attachment", 2);
    await $("#orca-send").click();
    expect(await waitForCalls(send)).toEqual([{ handle: "term_example-app", text: `${dropped("example-app", "first.png")}\n${dropped("example-app", "first.png")}`, environment: null }]);
    expect((await callsOf(attach)).map((c) => (c as { name: string }).name)).toEqual(["first.png", "second.png"]);
    expect(await callsOf("orca_compose_text")).toEqual([{ text: "", paths: [dropped("example-app", "first.png"), dropped("example-app", "first.png")] }]);
  });

  it("puts the image in the chosen worktree and the saved target when it starts a session", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }));
    const attach = await mock("orca_attach_image", dropped("example-api"));
    const launch = await mock("orca_launch", null);
    await pickDest("/work/example-api");
    await $("#orca-input").setValue("Write the docs");
    await paste(image());
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await $("#orca-send").click();
    expect(await waitForCalls(launch)).toEqual([{ path: "/work/example-api", text: `Write the docs\n\n${dropped("example-api")}`, environment: "Studio" }]);
    expect(await callsOf(attach)).toEqual([{ path: "/work/example-api", name: "shot.png", data: PNG, environment: "Studio" }]);
    await expect($("#orca-attachments")).not.toBeDisplayed();
  });

  it("keeps the text and the images and sends nothing when an image cannot be put in the worktree", async () => {
    await openWorking();
    const attach = await mock("orca_attach_image", rejects("Orca がエラーを返しました（forbidden）"));
    const send = await mock("orca_send", null);
    await rowOf("example-app").click();
    await $("#orca-input").setValue("Look at this");
    await paste(image());
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await $("#orca-send").click();
    await waitForCalls(attach);
    await expect($("#orca-error")).toHaveText("Orca がエラーを返しました（forbidden）");
    await expect($("#orca-input")).toHaveValue("Look at this");
    expect(await thumbs()).toBe(1);
    await expect($("#orca-send")).toBeEnabled();
    expect(await callsOf(send)).toEqual([]);
  });

  it("does not put an image in the worktree again when the send after it failed and is pressed again", async () => {
    await openWorking();
    const attach = await mock("orca_attach_image", dropped("example-app"));
    await mock("orca_send", rejects("No such terminal"));
    await rowOf("example-app").click();
    await $("#orca-input").setValue("Look at this");
    await paste(image());
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await $("#orca-send").click();
    await expect($("#orca-error")).toHaveText("No such terminal");
    await expect($("#orca-input")).toHaveValue("Look at this");
    expect(await thumbs()).toBe(1);
    const send = await mock("orca_send", null);
    await $("#orca-send").click();
    expect(await waitForCalls(send)).toEqual([{ handle: "term_example-app", text: `Look at this\n\n${dropped("example-app")}`, environment: null }]);
    expect(await callsOf(attach)).toHaveLength(1);
    await expect($("#orca-attachments")).not.toBeDisplayed();
  });

  it("refuses to attach to a session whose worktree is not known", async () => {
    await openWorking(orcaOverview([orcaRow("example-app", "feat/a", "Write the docs", { path: "" })], worktrees()));
    const attach = await mock("orca_attach_image", null);
    const send = await mock("orca_send", null);
    await rowOf("example-app").click();
    await paste(image());
    await waitForCount("#orca-attachments .orca-attachment", 1);
    await $("#orca-send").click();
    await expect($("#orca-error")).toHaveText("画像を置く worktree が分かりません");
    expect(await callsOf(attach)).toEqual([]);
    expect(await callsOf(send)).toEqual([]);
    expect(await thumbs()).toBe(1);
  });
});
