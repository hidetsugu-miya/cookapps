// A-40: the modal of the terminal of a session, opened by a right click on a session row of the Orca list.
import { callsOf, mock, orcaRow, sendStream, sendTerm, timers, waitForCalls } from "../support";
import { claudeTab, openOrca, orcaOverview, project, sample, selectedTab, streamList, worktrees } from "../orca-support";

const studioOnly = { target: "Studio", environments: ["Studio"] };
const arrow = (repo: string) => $(`#orca-feed .orca-arrow[data-key="arrow:proj_${repo}"]`);
const sessionOf = (repo: string) => $(`#orca-feed .orca-session[data-session="${claudeTab(repo)}"]`);
// The text of the terminal of the modal.
const peekText = () => $("#orca-peek-term .orca-term-box:not([hidden]) .xterm-rows").getText();

// The page's own right click on the session row of `repo`; says whether the page cancelled the default menu.
const rightClick = (repo: string) =>
  browser.execute((tab) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    document.querySelector(`#orca-feed .orca-session[data-session="${tab}"]`)!.dispatchEvent(event);
    return event.defaultPrevented;
  }, claudeTab(repo));

// Opens the project of `repo` in the list (its sessions under it) without selecting it.
async function openList(repo: string) {
  if ((await arrow(repo).getAttribute("aria-expanded")) !== "true") await arrow(repo).click();
  await expect(sessionOf(repo)).toBeDisplayed();
}

// The Orca screen with a saved environment as the target, its list streamed once.
async function openStudio(fixtures: Record<string, unknown> = {}) {
  await openOrca(orcaOverview([], [], studioOnly), fixtures);
  await waitForCalls("orca_stream_open");
  await sendStream(streamList(sample(), worktrees()));
}

describe("orca: peek at a session in a modal (A-40)", () => {
  it("opens the modal for the right clicked session of a project that is not selected, with the head and its terminal mirrored, and leaves the work pane as it was", async () => {
    await openOrca();
    await mock("orca_terminal_read", ["$ claude", "> Fix the parser"]);
    await openList("example-api");
    await expect($("#orca-peek")).not.toBeDisplayed();
    expect(await rightClick("example-api")).toBe(true);
    await expect($("#orca-peek")).toBeDisplayed();
    // The head: the status icon, the name of the project in bold, the title of the session; no tag of a place for this machine; the cross.
    const icon = await browser.execute(() => {
      const i = document.querySelector<HTMLElement>("#orca-peek-head .orca-ic")!;
      return [i.dataset.status, i.getAttribute("aria-label")];
    });
    expect(icon).toEqual(["question", "入力待ち"]);
    await expect($("#orca-peek-project")).toHaveText("example-api");
    expect(Number(await $("#orca-peek-project").getCSSProperty("font-weight").then((p) => p.value))).toBeGreaterThanOrEqual(700);
    await expect($("#orca-peek-title")).toHaveText("Fix the parser");
    expect((await $("#orca-peek-title").getCSSProperty("text-overflow")).value).toBe("ellipsis");
    await expect($("#orca-peek-env")).not.toBeDisplayed();
    await expect($("#orca-peek-close")).toHaveAttribute("aria-label", "閉じる");
    // The order of the head, and the cross at its right end.
    const order = await browser.execute(() => ["#orca-peek-icon", "#orca-peek-project", "#orca-peek-title", "#orca-peek-close"].map((s) => document.querySelector(s)!.getBoundingClientRect().left));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // No tab strip: the terminal alone under the head.
    expect(await browser.execute(() => document.querySelectorAll('#orca-peek [role="tab"], #orca-peek .orca-tabs').length)).toBe(0);
    // A margin on the four sides.
    const gaps = await browser.execute(() => {
      const r = document.getElementById("orca-peek-box")!.getBoundingClientRect();
      return [r.left, r.top, window.innerWidth - r.right, window.innerHeight - r.bottom];
    });
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(24);
    // The terminal of that session, read from this machine.
    expect((await waitForCalls("orca_terminal_read"))[0]).toEqual({ handle: "term_example-api" });
    await browser.waitUntil(async () => (await peekText()).includes("Fix the parser"), { timeoutMsg: "the screen of the session never showed in the modal" });
    // The work pane is as it was: no project selected, no tab, and the list's rows unchanged.
    await expect(project("example-api")).toHaveAttribute("aria-pressed", "false");
    await expect(sessionOf("example-api")).toHaveAttribute("aria-pressed", "false");
    await expect(selectedTab()).not.toExist();
    expect(await callsOf("orca_stream_terminal")).toEqual([]);
  });

  it("takes the keys typed with no click, and sends them to the terminal of the modal", async () => {
    await openOrca();
    await mock("orca_terminal_read", ["$"]);
    const input = await mock("orca_terminal_input", null);
    await openList("example-api");
    await rightClick("example-api");
    await browser.waitUntil(async () => (await peekText()).includes("$"), { timeoutMsg: "the screen of the session never showed in the modal" });
    await browser.keys(["c", "d"]);
    await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => (c as { handle: string }).handle === "term_example-api")).toBe(true);
  });

  it("shows the name of the saved environment in the head, and streams the terminal of a session on it", async () => {
    await openStudio();
    await mock("orca_stream_input", null);
    await openList("example-app");
    expect(await rightClick("example-app")).toBe(true);
    await expect($("#orca-peek")).toBeDisplayed();
    await expect($("#orca-peek-env")).toHaveText("Studio");
    expect(await $("#orca-peek-env").getAttribute("class")).toContain("orca-env");
    const [call] = await waitForCalls("orca_stream_terminal");
    expect(call).toMatchObject({ handle: "term_example-app" });
    // A stream, not a mirror.
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    await sendTerm({ kind: "snapshot", data: "$ claude\r\n> Write the docs", cols: 80, rows: 24 });
    await browser.waitUntil(async () => (await peekText()).includes("Write the docs"), { timeoutMsg: "the streamed screen never showed in the modal" });
    await browser.keys(["1", "Enter"]);
    await browser.waitUntil(async () => (await callsOf("orca_stream_input")).map((c) => (c as { text: string }).text).join("") === "1\r", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf("orca_stream_input")).every((c) => (c as { handle: string }).handle === "term_example-app")).toBe(true);
  });

  it("opens nothing on a session of the selected project, and nothing on a session with no terminal, and cancels the default menu for both", async () => {
    const rows = [orcaRow("example-app", "feat/a", "Write the docs"), orcaRow("example-api", "main", "Fix the parser", { group: "waiting", handle: null })];
    await openOrca(orcaOverview(rows, worktrees()));
    await mock("orca_terminal_read", ["$"]);
    await project("example-app").click();
    await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
    expect(await rightClick("example-app")).toBe(true);
    await openList("example-api");
    expect(await rightClick("example-api")).toBe(true);
    await browser.pause(300);
    await expect($("#orca-peek")).not.toBeDisplayed();
    expect(await browser.execute(() => document.querySelectorAll("#orca-peek-term .orca-term-box").length)).toBe(0);
  });

  it("closes with Escape, keeps the work pane and its terminal as they were, and stops reading the terminal of the modal", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), timers({ orcaMirror: 250 }));
    await mock("orca_terminal_read", ["$"]);
    const input = await mock("orca_terminal_input", null);
    await project("example-app").click();
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    await openList("example-api");
    await rightClick("example-api");
    await expect($("#orca-peek")).toBeDisplayed();
    await browser.waitUntil(async () => (await callsOf("orca_terminal_read")).some((c) => (c as { handle: string }).handle === "term_example-api"), { timeoutMsg: "the terminal of the modal was never read" });
    await browser.keys(["Escape"]);
    await expect($("#orca-peek")).not.toBeDisplayed();
    // The focus is back on the row.
    expect(await browser.execute(() => (document.activeElement as HTMLElement).dataset.session)).toBe(claudeTab("example-api"));
    // The Escape was the modal's: the session got no key.
    expect(await callsOf(input)).toEqual([]);
    // The work pane is as it was.
    await expect(project("example-app")).toHaveAttribute("aria-pressed", "true");
    await expect(selectedTab()).toHaveText(expect.stringContaining("Write the docs"));
    await expect($(".orca-term")).toBeDisplayed();
    // Only the terminal of the work pane is read now.
    await mock("orca_terminal_read", ["$"]);
    await waitForCalls("orca_terminal_read", 2);
    expect((await callsOf("orca_terminal_read")).every((c) => (c as { handle: string }).handle === "term_example-app")).toBe(true);
  });

  it("closes with the cross, and can be opened again for another session", async () => {
    await openOrca(orcaOverview(sample(), worktrees()));
    await mock("orca_terminal_read", ["$"]);
    await openList("example-api");
    await openList("example-lib");
    await rightClick("example-api");
    await expect($("#orca-peek-project")).toHaveText("example-api");
    await $("#orca-peek-close").click();
    await expect($("#orca-peek")).not.toBeDisplayed();
    await rightClick("example-lib");
    await expect($("#orca-peek")).toBeDisplayed();
    await expect($("#orca-peek-project")).toHaveText("example-lib");
    await expect($("#orca-peek-title")).toHaveText("Opened the pull request.");
    expect((await callsOf("orca_terminal_read")).some((c) => (c as { handle: string }).handle === "term_example-lib")).toBe(true);
  });

  it("closes by itself when the list no longer holds the session", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), timers({ orcaClock: 500, orcaMirror: 250 }));
    await mock("orca_terminal_read", ["$"]);
    await openList("example-api");
    await rightClick("example-api");
    await expect($("#orca-peek")).toBeDisplayed();
    await mock(
      "orca_overview",
      orcaOverview(
        sample().filter((r) => r.repo !== "example-api"),
        worktrees(),
      ),
    );
    await browser.waitUntil(async () => !(await $("#orca-peek").isDisplayed()), { timeoutMsg: "the modal stayed open after its session left the list" });
    // Its terminal is not read any more.
    await mock("orca_terminal_read", ["$"]);
    await browser.pause(600);
    expect((await callsOf("orca_terminal_read")).every((c) => (c as { handle: string }).handle !== "term_example-api")).toBe(true);
  });
});
