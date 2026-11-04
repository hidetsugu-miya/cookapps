import {
  boot,
  callsOf,
  chatAssistant,
  chatItems,
  chatOpens,
  chatStatus,
  chatTools,
  chatUser,
  holds,
  inbox,
  isoDate,
  mock,
  onceId,
  orcaOverview,
  orcaRow,
  orcaSkill,
  orcaWorktree,
  rejects,
  release,
  sendChat,
  setClock,
  textsOf,
  waitForCalls,
  waitForCount,
  waitForOpens,
} from "../support";

// A running, a waiting and a done agent, and a second running one that has no pane (its session cannot be read).
const sample = () => [
  orcaRow("example-app", "feat/a", "Write the docs", { minutes: 2 }),
  orcaRow("example-api", "main", "Fix the parser", { group: "waiting", minutes: 5 }),
  orcaRow("example-web", "dev", "Update the page", { minutes: 11, handle: null, paneKey: null }),
  orcaRow("example-lib", "feature/x", "Opened the pull request.", { group: "done", minutes: 18 }),
];
const worktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];

// The app with `value` as what Orca answers, and the Orca screen open.
async function openOrca(value = orcaOverview(sample(), worktrees()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), orca_overview: value, orca_skills: [], ...fixtures });
  await $("#nav-orca").click();
  await expect($("#orca")).toBeDisplayed();
}

const rowTexts = (selector: string) => textsOf(`#orca-feed .orca-row ${selector}`);
const groups = () => textsOf("#orca-feed .orca-group");
// The row of the worktree `repo`: the third line of a row names it.
const rowOf = (repo: string) => $(`//div[@id="orca-feed"]//button[contains(@class,"orca-row")][.//span[@class="orca-where"][starts-with(., "${repo} ・")]]`);
const classOf = (selector: string) => browser.execute((s) => document.querySelector(s)!.className, selector);
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

describe("orca", () => {
  it("draws the agents in three groups with the working count on the sidebar", async () => {
    await boot({ inbox: inbox(), orca_overview: orcaOverview(sample(), worktrees()), orca_skills: [] });
    // The count follows the first read, with the screen not shown: working and waiting agents, not the done one.
    await expect($("#nav-orca .nav-count")).toHaveText("3");
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（作業中 3 件）");
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    expect(await groups()).toEqual(["入力待ち1", "作業中2", "完了1"]);
    // Newest first inside a group is the order of the answer; the groups are in the order waiting, working, done.
    expect(await rowTexts(".orca-prompt")).toEqual(["Fix the parser", "Write the docs", "Update the page", "Opened the pull request."]);
    expect(await rowTexts(".orca-time")).toEqual(["5 分", "2 分", "11 分", "18 分前"]);
    expect(await rowTexts(".orca-state")).toEqual(["入力待ち", "作業中", "作業中", "完了"]);
    expect(await rowTexts(".orca-where")).toEqual(["example-api ・ main", "example-app ・ feat/a", "example-web ・ dev", "example-lib ・ feature/x"]);
    // No agent chip, no repository heading and no filter.
    expect(await rowTexts(".orca-agent")).toEqual([]);
    expect(await classOf("#orca-feed .orca-row.waiting")).toContain("waiting");
    await expect($("#orca-status")).toHaveText("このマシン に接続中");
    expect(await classOf("#orca-status")).toContain("ok");
    // The list pane has no "Orca" heading; its header holds the status, the new-session button and the update button.
    expect(await textsOf("#orca-header h1")).toEqual([]);
    await expect($("#orca-new")).toHaveAttribute("aria-label", "新しく起動する");
    await expect($("#orca-refresh")).toHaveAttribute("aria-label", "更新");
    // No environment is saved: the label is plain text.
    await expect($("#orca-target")).not.toBeDisplayed();
  });

  it("shows no waiting group when no agent waits, and says so when nothing runs", async () => {
    await openOrca(orcaOverview([orcaRow("example-app", "main", "Task")]));
    expect(await groups()).toEqual(["作業中1"]);
    await boot({ inbox: inbox(), orca_overview: orcaOverview([]), orca_skills: [] });
    await $("#nav-orca").click();
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
    await expect($("#orca-new")).toHaveAttribute("aria-pressed", "true");
    await expect($("#orca-dest")).toBeDisplayed();
    await expect($("#orca-dest-pick")).toHaveText("worktree を選ぶ");
    await expect($("#orca-send")).toHaveText("起動する");
    await expect($("#orca-input")).toHaveAttribute("placeholder", "起動するエージェントへの指示を書く（/ でスキル）");
    expect(await chatOpens()).toEqual([]);
  });

  it("selects a row with a click, names it in the work pane and opens its history", async () => {
    await openOrca();
    await select("example-app");
    expect(await pressed("example-app")).toBe("true");
    expect(await chatOpens()).toEqual([{ environment: null, path: "/work/example-app", paneKey: "tab_example-app:leaf_1", channel: true }]);
    await expect($("#orca-work-title")).toHaveText("example-app ・ feat/a");
    await expect($("#orca-new")).toHaveAttribute("aria-pressed", "false");
    await expect($("#orca-send")).toHaveText("送る");
    await expect($("#orca-input")).toHaveAttribute("placeholder", "追加の指示を書く（/ でスキル）");
    await expect($("#orca-dest")).not.toBeDisplayed();
    // Another row takes the selection and its history.
    await select("example-lib", 2);
    expect(await pressed("example-app")).toBe("false");
    expect(await pressed("example-lib")).toBe("true");
    expect((await chatOpens()).map((c) => c.path)).toEqual(["/work/example-app", "/work/example-lib"]);
    await expect($("#orca-work-title")).toHaveText("example-lib ・ feature/x");
  });

  it("closes the history and goes back to the new-session state with the plus button", async () => {
    await openOrca();
    const close = await mock("orca_chat_close", null);
    await select("example-lib");
    await $("#orca-new").click();
    expect(await pressed("example-lib")).toBe("false");
    expect(await waitForCalls(close)).toEqual([null]);
    await expect($("#orca-work-title")).toHaveText("新しいセッション");
    await expect($("#orca-new")).toHaveAttribute("aria-pressed", "true");
    await expect($("#orca-send")).toHaveText("起動する");
    await expect($("#orca-dest")).toBeDisplayed();
    expect(await chatOpens()).toHaveLength(1);
  });

  it("pauses the history read while the window is hidden, also for a session opened then, and resumes it when shown", async () => {
    await openOrca();
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
    await openOrca();
    await expect(rowOf("example-web")).toBeDisabled();
    await expect(rowOf("example-app")).not.toBeDisabled();
  });

  it("reads the history of a session that has no terminal, and does not post to it", async () => {
    await openOrca(orcaOverview([orcaRow("example-app", "feat/a", "Write the docs", { handle: null })], worktrees()));
    await select("example-app");
    await $("#orca-input").setValue("Hello");
    await expect($("#orca-send")).toHaveText("送る");
    await expect($("#orca-send")).toBeDisabled();
  });

  it("sends the text to the selected session, clears the field and reads the list at once", async () => {
    await openOrca();
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
    await openOrca();
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
    await openOrca();
    expect(await rowTexts(".orca-prompt")).toHaveLength(4);
    await mock("orca_overview", orcaOverview([], [], { state: "failed", message: "Orca is not running", environments: [] }));
    await $("#orca-refresh").click();
    await expect($("#orca-status")).toHaveText("このマシン に接続できません");
    expect(await classOf("#orca-status")).toContain("warn");
    await expect($("#orca-notice")).toHaveText("読み込めませんでした: Orca is not running");
    expect(await rowTexts(".orca-prompt")).toHaveLength(4);
  });

  it("makes the label a menu of the targets once an environment is saved", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
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
    await openOrca(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
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
    await openOrca();
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
    await expect($("#orca-work-title")).toHaveText("example-app ・ feat/a");
    // The same node is still there, and the history was not asked for again.
    await expect($('#orca-items .orca-user[data-mark="same"]')).toExist();
    expect(await chatOpens()).toHaveLength(1);
  });

  it("drops the selection of a session that is gone, and closes its history", async () => {
    await openOrca();
    const close = await mock("orca_chat_close", null);
    await select("example-app");
    await mock("orca_overview", orcaOverview([orcaRow("example-api", "main", "Fix the parser")], worktrees()));
    await $("#orca-refresh").click();
    await waitForCount("#orca-feed .orca-row", 1);
    await expect($("#orca-send")).toHaveText("起動する");
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
    await openOrca();
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
    await openOrca();
    await pickDest("/work/example-app");
    await expect($("#orca-dest-pick")).toHaveText("example-app ・ feat/a");
    await rowOf("example-app").click();
    await $("#orca-new").click();
    await expect($("#orca-dest-pick")).toHaveText("worktree を選ぶ");
    await $("#orca-input").setValue("Go");
    await expect($("#orca-send")).toBeDisabled();
  });

  it("says nothing about a new target until its first read comes back, and keeps the menu", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
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
    await openOrca(orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio", "Lab"] }));
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
    chatTools("t1", `ツールを ${calls.length} 回実行（Read 1、Edit 1、Bash 1）`, calls, running);
  const scrollBox = () => ({
    atBottom: () => browser.execute(() => { const b = document.getElementById("orca-chat")!; return b.scrollHeight - b.scrollTop - b.clientHeight < 2; }),
    top: () => browser.execute(() => document.getElementById("orca-chat")!.scrollTop),
    set: (y: number) => browser.execute((v) => { document.getElementById("orca-chat")!.scrollTop = v; }, y),
    offsetOf: (id: string) =>
      browser.execute((i) => document.querySelector(`#orca-items [data-id="${i}"]`)!.getBoundingClientRect().top - document.getElementById("orca-chat")!.getBoundingClientRect().top, id),
  });
  const many = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => chatUser(`m${from + i}`, `message ${from + i}`));

  it("says it is loading until the first items come, and then nothing", async () => {
    await openOrca();
    await select("example-app");
    expect(await statusLine()).toEqual(["読み込んでいます…"]);
    await sendChat(chatStatus("live"));
    expect(await statusLine()).toEqual([""]);
    await sendChat(chatItems([user]));
    expect(await statusLine()).toEqual([""]);
  });

  it("draws the user's messages on the right, the agent's answers as Markdown and the tools as a folded line", async () => {
    await openOrca();
    await select("example-app");
    await sendChat(chatItems([user, answer, tools()]));
    expect(await textsOf("#orca-items .orca-user")).toEqual(["Make the list narrower"]);
    expect(await textsOf("#orca-items .orca-assistant strong")).toEqual(["list"]);
    expect(await textsOf("#orca-items .orca-assistant li")).toEqual(["first", "second"]);
    expect(await textsOf("#orca-items .orca-tools-label")).toEqual(["ツールを 3 回実行（Read 1、Edit 1、Bash 1）"]);
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

  it("does not load a remote image of the agent's answer", async () => {
    await openOrca();
    await select("example-app");
    await sendChat(chatItems([chatAssistant("a1", "![logo](https://example.com/logo.png) is shown")]));
    expect(await textsOf("#orca-items .orca-assistant")).toEqual(["logo is shown"]);
    await expect($("#orca-items img")).not.toExist();
  });

  it("replaces the timeline from the index an event names", async () => {
    await openOrca();
    await select("example-app");
    await sendChat(chatItems([user, chatAssistant("a1", "Narrowing now."), tools()]));
    await sendChat(chatItems([chatAssistant("a2", "Done."), chatUser("u2", "Thanks")], 2));
    expect(await chatTexts()).toEqual(["Make the list narrower", "Narrowing now.", "Done.", "Thanks"]);
    // From the start, and shorter: the rest is dropped.
    await sendChat(chatItems([chatUser("u3", "Only one")]));
    expect(await chatTexts()).toEqual(["Only one"]);
  });

  it("folds and unfolds the tool calls, and keeps a run open while it grows and the timeline is drawn again", async () => {
    await openOrca();
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

  it("names what a run still going works on while the agent is working, and the summary when it is not", async () => {
    await openOrca();
    await select("example-app");
    await sendChat(chatItems([tools([["Edit", "ts/orca.ts"]], "ツールを実行中（Edit 1）")]));
    expect(await textsOf(".orca-tools-label")).toEqual(["ツールを実行中（Edit 1）"]);
    // The agent is done now: the next read of the list says so, and the label is the summary.
    await mock("orca_overview", orcaOverview([orcaRow("example-app", "feat/a", "Write the docs", { group: "done" })], worktrees()));
    await $("#orca-refresh").click();
    await browser.waitUntil(async () => (await textsOf(".orca-tools-label"))[0] === "ツールを 1 回実行（Read 1、Edit 1、Bash 1）", { timeoutMsg: "the label never became the summary" });
  });

  it("shows a run with no running summary by its summary even while the agent works", async () => {
    await openOrca();
    await select("example-app");
    await sendChat(chatItems([tools()]));
    expect(await textsOf(".orca-tools-label")).toEqual(["ツールを 3 回実行（Read 1、Edit 1、Bash 1）"]);
  });

  it("shows the reconnecting and unavailable messages above the chat, and takes them away when the read is live", async () => {
    await openOrca();
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
    await openOrca();
    await mock("orca_chat_open", rejects("エージェントの場所が正しくありません"));
    await rowOf("example-app").click();
    await waitForOpens();
    await browser.waitUntil(async () => (await statusLine())[0] === "エージェントの場所が正しくありません", { timeoutMsg: "the message never showed" });
  });

  it("ignores the events of a channel that is no longer the current one", async () => {
    await openOrca();
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
    await openOrca();
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
    await expect($("#orca-work-title")).toHaveText("example-app ・ feat/a");
  });

  it("scrolls to the bottom when a session is opened, and stays at the bottom as items arrive", async () => {
    await openOrca();
    await select("example-app");
    await sendChat(chatItems(many(0, 40)));
    expect(await scrollBox().atBottom()).toBe(true);
    expect(await scrollBox().top()).toBeGreaterThan(0);
    await sendChat(chatItems(many(40, 43), 40));
    expect(await scrollBox().atBottom()).toBe(true);
  });

  it("does not move the scroll position when items arrive while it is scrolled up", async () => {
    await openOrca();
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
    await openOrca();
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
