import { boot, callsOf, inbox, mock, onceId, orcaOverview, orcaRow, orcaSkill, orcaWorktree, rejects, textsOf, waitForCalls, waitForCount } from "../support";

// A running, a waiting, a second running and a done agent; the second running one has no terminal handle.
const sample = () => [
  orcaRow("example-app", "feat/a", "Write the docs ・ Bash を実行中", { minutes: 2 }),
  orcaRow("example-api", "main", "Fix the parser", { group: "waiting", minutes: 5 }),
  orcaRow("example-web", "dev", "Update the page", { minutes: 11, handle: null }),
  orcaRow("example-lib", "feature/x", "Opened the pull request.", { group: "done", agent: "Codex", minutes: 18 }),
];
const worktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];

// The app with `value` as what Orca answers, and the Orca screen open.
async function openOrca(value = orcaOverview(sample(), worktrees()), fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), orca_overview: value, orca_skills: [], ...fixtures });
  await $("#nav-orca").click();
  await expect($("#orca")).toBeDisplayed();
}

const rowTexts = (selector: string) => textsOf(`#orca-feed .orca-row ${selector}`);
const headings = () => textsOf("#orca-feed .feed-heading");
const rowOf = (repo: string) => $(`//div[@id="orca-feed"]//button[contains(@class,"orca-row")][.//b[text()="${repo}"]]`);
const classOf = (selector: string) => browser.execute((s) => document.querySelector(s)!.className, selector);
const pressed = (repo: string) => rowOf(repo).getAttribute("aria-pressed");

async function pickMenu(label: string) {
  for (const item of await $$(".menu button")) {
    if ((await item.getText()) === label) return item.click();
  }
  throw new Error(`no menu item "${label}"`);
}

describe("orca", () => {
  it("draws the agents in three groups with the running count on the sidebar", async () => {
    await boot({ inbox: inbox(), orca_overview: orcaOverview(sample(), worktrees()), orca_skills: [] });
    // The count follows the first read, with the screen not shown: running and waiting agents, not the done one.
    await expect($("#nav-orca .nav-count")).toHaveText("3");
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "Orca（動作中 3 件）");
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    expect(await headings()).toEqual(["入力待ち 1", "動作中 2", "完了 1"]);
    // Newest first inside a group is the order of the answer; the groups are in the order waiting, running, done.
    expect(await rowTexts("b")).toEqual(["example-api", "example-app", "example-web", "example-lib"]);
    expect(await rowTexts(".orca-branch")).toEqual(["main", "feat/a", "dev", "feature/x"]);
    expect(await rowTexts(".orca-line")).toEqual(["Fix the parser", "Write the docs ・ Bash を実行中", "Update the page", "Opened the pull request."]);
    expect(await rowTexts(".orca-agent")).toEqual(["Claude", "Claude", "Claude", "Codex"]);
    expect(await rowTexts(".orca-side")).toEqual(["Claude5 分", "Claude2 分", "Claude11 分", "Codex18 分前"]);
    expect(await classOf("#orca-feed .orca-row.waiting")).toContain("waiting");
    await expect($("#orca-status")).toHaveText("このマシン に接続中");
    expect(await classOf("#orca-status")).toContain("ok");
    // No environment is saved: the label is plain text.
    await expect($("#orca-target")).not.toBeDisplayed();
  });

  it("shows no waiting group when no agent waits, and says so when nothing runs", async () => {
    await openOrca(orcaOverview([orcaRow("example-app", "main", "Task")]));
    expect(await headings()).toEqual(["動作中 1"]);
    await boot({ inbox: inbox(), orca_overview: orcaOverview([]), orca_skills: [] });
    await $("#nav-orca").click();
    await expect($("#orca-feed")).toHaveText(expect.stringContaining("動いているエージェントはありません"));
    await expect($("#nav-orca .nav-count")).not.toBeDisplayed();
  });

  it("selects a row with a click, names it in the composer, and a new launch clears the selection", async () => {
    await openOrca();
    // Nothing selected: the destination is a worktree menu and an agent menu, and the button starts an agent.
    await expect($("#orca-dest-pick")).toBeDisplayed();
    await expect($("#orca-agent")).toHaveText("Claude");
    await expect($("#orca-send")).toHaveText("起動する");
    await expect($("#orca-input")).toHaveAttribute("placeholder", "起動するエージェントへの指示を書く");
    await expect($("#orca-new")).not.toBeDisplayed();
    await rowOf("example-app").click();
    expect(await pressed("example-app")).toBe("true");
    await expect($("#orca-dest-label")).toHaveText("example-app ・ feat/a のセッション");
    await expect($("#orca-send")).toHaveText("送る");
    await expect($("#orca-input")).toHaveAttribute("placeholder", "追加の指示を書く");
    await expect($("#orca-dest-pick")).not.toBeDisplayed();
    await expect($("#orca-agent")).not.toBeDisplayed();
    // Another row takes the selection.
    await rowOf("example-lib").click();
    expect(await pressed("example-app")).toBe("false");
    expect(await pressed("example-lib")).toBe("true");
    await $("#orca-new").click();
    expect(await pressed("example-lib")).toBe("false");
    await expect($("#orca-send")).toHaveText("起動する");
    await expect($("#orca-dest-pick")).toBeDisplayed();
  });

  it("cannot select a row that has no terminal", async () => {
    await openOrca();
    await expect(rowOf("example-web")).toBeDisabled();
    await expect(rowOf("example-app")).not.toBeDisabled();
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

  it("starts an agent in the chosen worktree with the chosen agent", async () => {
    await openOrca();
    const launch = await mock("orca_launch", null);
    // Needs a worktree before it can start.
    await $("#orca-input").setValue("Write the docs");
    await expect($("#orca-send")).toBeDisabled();
    await $("#orca-dest-pick").click();
    expect(await textsOf(".menu button")).toEqual(["example-app ・ feat/a", "example-api ・ main"]);
    await pickMenu("example-api ・ main");
    await expect($("#orca-dest-pick")).toHaveText("example-api ・ main");
    await $("#orca-agent").click();
    expect(await textsOf(".menu button")).toEqual(["Claude", "Codex"]);
    await pickMenu("Codex");
    await expect($("#orca-agent")).toHaveText("Codex");
    await $("#orca-send").click();
    expect(await waitForCalls(launch)).toEqual([{ agent: "codex", path: "/work/example-api", text: "Write the docs", environment: null }]);
    await expect($("#orca-input")).toHaveValue("");
  });

  it("keeps the text when the launch fails", async () => {
    await openOrca();
    const launch = await mock("orca_launch", rejects("Worktree not found"));
    await $("#orca-dest-pick").click();
    await pickMenu("example-app ・ feat/a");
    await $("#orca-input").setValue("Try this");
    await $("#orca-send").click();
    await waitForCalls(launch);
    await expect($("#orca-error")).toHaveText("Worktree not found");
    await expect($("#orca-input")).toHaveValue("Try this");
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
    expect(await rowTexts("b")).toHaveLength(4);
    await mock("orca_overview", orcaOverview([], [], { state: "failed", message: "Orca is not running", environments: [] }));
    await $("#orca-refresh").click();
    await expect($("#orca-status")).toHaveText("このマシン に接続できません");
    expect(await classOf("#orca-status")).toContain("warn");
    await expect($("#orca-notice")).toHaveText("読み込めませんでした: Orca is not running");
    expect(await rowTexts("b")).toHaveLength(4);
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

  it("keeps the selection and the text through a read in the background", async () => {
    await openOrca();
    await rowOf("example-app").click();
    await $("#orca-input").setValue("Half written");
    // The clock reads again within 10 seconds (the first read of this screen was at its opening).
    const overview = await mock("orca_overview", orcaOverview([...sample(), orcaRow("example-new", "main", "Fresh", { minutes: 1 })], worktrees()));
    await waitForCalls(overview);
    await waitForCount("#orca-feed .orca-row", 5);
    expect(await pressed("example-app")).toBe("true");
    await expect($("#orca-input")).toHaveValue("Half written");
    await expect($("#orca")).toBeDisplayed();
    await expect($("#orca-dest-label")).toHaveText("example-app ・ feat/a のセッション");
  });

  it("drops the selection of a session that is gone", async () => {
    await openOrca();
    await rowOf("example-app").click();
    await mock("orca_overview", orcaOverview([orcaRow("example-api", "main", "Fix the parser")], worktrees()));
    await $("#orca-refresh").click();
    await waitForCount("#orca-feed .orca-row", 1);
    await expect($("#orca-send")).toHaveText("起動する");
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

  it("is asked for once, with the target, and not on every keystroke", async () => {
    await openWithSkills();
    await $("#orca-input").setValue("/rev");
    await $("#orca-input").setValue("/revi");
    expect(await callsOf("orca_skills")).toEqual([{ environment: null }]);
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
    await expect($("#orca-input")).toHaveValue("/pr-review ");
    await expect(popup()).not.toBeDisplayed();
  });

  it("does not post on Enter while the list is open, and Enter puts the command in", async () => {
    await openWithSkills();
    const launch = await mock("orca_launch", null);
    await $("#orca-dest-pick").click();
    await pickMenu("example-app ・ feat/a");
    await $("#orca-input").setValue("/rev");
    await press("Enter");
    await expect($("#orca-input")).toHaveValue("/review ");
    await expect(popup()).not.toBeDisplayed();
    expect(await callsOf(launch)).toEqual([]);
    // The text goes on after the command.
    await $("#orca-input").addValue("now");
    await $("#orca-send").click();
    expect(await waitForCalls(launch)).toEqual([{ agent: "claude", path: "/work/example-app", text: "/review now", environment: null }]);
  });

  it("takes a click on a row", async () => {
    await openWithSkills();
    await $("#orca-input").setValue("/s");
    for (const option of await $$("#orca-complete .orca-skill")) {
      if ((await option.$("code").getText()) === "/simplify") await option.click();
    }
    await expect($("#orca-input")).toHaveValue("/simplify ");
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

  it("is not offered to Codex, whether chosen for a launch or selected as a session", async () => {
    await openWithSkills();
    await $("#orca-agent").click();
    await pickMenu("Codex");
    await $("#orca-input").setValue("/rev");
    await expect(popup()).not.toBeDisplayed();
    // Back to Claude: the same text opens it.
    await $("#orca-agent").click();
    await pickMenu("Claude");
    await expect(popup()).toBeDisplayed();
    // A selected session decides by its own agent: example-lib is Codex, example-app is Claude.
    await rowOf("example-lib").click();
    await expect(popup()).not.toBeDisplayed();
    await rowOf("example-app").click();
    await expect(popup()).toBeDisplayed();
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

  it("gives no list, and still posts, when the skills cannot be read", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_skills: rejects("skills failed") });
    await waitForCalls("orca_skills");
    const launch = await mock("orca_launch", null);
    await $("#orca-dest-pick").click();
    await pickMenu("example-app ・ feat/a");
    await $("#orca-input").setValue("/review");
    await expect(popup()).not.toBeDisplayed();
    await $("#orca-send").click();
    expect(await waitForCalls(launch)).toEqual([{ agent: "claude", path: "/work/example-app", text: "/review", environment: null }]);
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
