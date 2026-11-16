import { boot, callsOf, inbox, orcaOverview, orcaRow, sendClaudeCode, waitForCalls } from "../support";

// A-37: the development screen's orchestration mode. The orchestrator's pane is Claude Code of A-36 (`kind: "formation"`), so its process is the mocked `claude_code_start`.
const FOOTER_MODES = "#footer-modes";
const visible = (selector: string) => browser.execute((s) => document.querySelector(s)?.getClientRects().length !== 0 && !document.querySelector<HTMLElement>(s)!.hidden, selector);
const pressed = (id: string) => browser.execute((i) => document.getElementById(i)!.getAttribute("aria-pressed"), id);
const nameOf = (id: string) => browser.execute((i) => [...document.querySelectorAll<HTMLElement>(`#${i} .footer-mode-name`)].filter((e) => !e.hidden).map((e) => e.textContent), id);
const starts = async () => (await callsOf("claude_code_start")).length;
const waitForStarts = (n: number) => browser.waitUntil(async () => (await starts()) === n, { timeoutMsg: `claude_code_start was not called ${n} times` });

async function openFormation() {
  await $("#nav-orca").click();
  await $("#footer-mode-formation").click();
  await expect($("#formation")).toBeDisplayed();
}

describe("development screen: orchestration mode", () => {
  beforeEach(async () => {
    await boot({ inbox: inbox() });
  });

  it("calls the sidebar's Orca button 開発, with the code icon", async () => {
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "開発");
    expect(await browser.execute(() => document.querySelector("#nav-orca svg path")!.getAttribute("d"))).toBe("m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16");
    await $("#nav-orca").click();
    await expect($("#nav-orca")).toHaveAttribute("aria-current", "page");
  });

  it("shows the footer's switch on the development screen only, with Orca on first", async () => {
    await expect($(FOOTER_MODES)).not.toBeDisplayed();
    await $("#nav-orca").click();
    await expect($(FOOTER_MODES)).toBeDisplayed();
    await expect($("#orca")).toBeDisplayed();
    await expect($("#formation")).not.toBeDisplayed();
    expect(await pressed("footer-mode-orca")).toBe("true");
    expect(await pressed("footer-mode-formation")).toBe("false");
    // The name is beside the icon of the mode that is on only.
    expect(await nameOf("footer-mode-orca")).toEqual(["Orca"]);
    expect(await nameOf("footer-mode-formation")).toEqual([]);
    for (const nav of ["#nav-mail", "#nav-calendar", "#nav-todo", "#nav-slack", "#nav-database", "#nav-settings"]) {
      await $(nav).click();
      await expect($(FOOTER_MODES)).not.toBeDisplayed();
    }
    await expect($("#footer-bell")).toBeDisplayed();
  });

  it("puts the switch at the left end of the footer, and the bell stays at the right end", async () => {
    await $("#nav-orca").click();
    const edges = await browser.execute(() => {
      const [modes, bell, footer] = ["footer-modes", "footer-bell", "footer"].map((id) => document.getElementById(id)!.getBoundingClientRect());
      return { modesFromLeft: Math.round(modes.left - footer.left), bellFromRight: Math.round(footer.right - bell.right), apart: bell.left - modes.right };
    });
    expect(edges.modesFromLeft).toBeLessThan(24);
    expect(edges.bellFromRight).toBeLessThan(24);
    expect(edges.apart).toBeGreaterThan(0);
  });

  it("switches to the orchestration with its three columns, and the name moves to its icon", async () => {
    await openFormation();
    await expect($("#orca")).not.toBeDisplayed();
    expect(await pressed("footer-mode-orca")).toBe("false");
    expect(await pressed("footer-mode-formation")).toBe("true");
    expect(await nameOf("footer-mode-orca")).toEqual([]);
    expect(await nameOf("footer-mode-formation")).toEqual(["オーケストレーション"]);
    await expect($("#nav-orca")).toHaveAttribute("aria-current", "page");
    const lefts = await browser.execute(() => ["formation-orchestrator", "formation-children", "formation-flow"].map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().left)));
    expect(lefts[0]).toBeLessThan(lefts[1]);
    expect(lefts[1]).toBeLessThan(lefts[2]);
    await expect($("#formation-orchestrator h1")).toHaveText("司令塔");
    // The middle and the right are empty containers.
    expect(await browser.execute(() => ["formation-children", "formation-flow"].map((id) => document.getElementById(id)!.childElementCount))).toEqual([0, 0]);
    await $("#footer-mode-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await expect($("#formation")).not.toBeDisplayed();
    expect(await nameOf("footer-mode-orca")).toEqual(["Orca"]);
  });

  it("starts the orchestrator with the pane id formation, Claude Code's own tools and no skill, in the size of the left pane", async () => {
    await openFormation();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "formation", builtinTools: true, skill: null });
    const { cols, rows } = (start as { viewport: { cols: number; rows: number } }).viewport;
    expect(cols).toBeGreaterThan(30);
    expect(rows).toBeGreaterThan(8);
    await sendClaudeCode({ kind: "output", data: "orchestrator ready" });
    await browser.waitUntil(async () => (await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).includes("orchestrator ready"));
    for (const command of ["orca_stream_terminal", "orca_terminal_read", "orca_stream_input"]) expect(await callsOf(command)).toEqual([]);
  });

  it("does not start the orchestrator again when the mode or the screen is left and shown again", async () => {
    await openFormation();
    await waitForStarts(1);
    await $("#footer-mode-orca").click();
    await expect($("#formation-term")).not.toBeDisplayed();
    await $("#footer-mode-formation").click();
    await expect($("#formation-term")).toBeDisplayed();
    await $("#nav-mail").click();
    await $("#nav-orca").click();
    // The mode was kept while the screen was left.
    await expect($("#formation")).toBeDisplayed();
    await $("#nav-todo").click();
    await $("#nav-orca").click();
    await browser.pause(300);
    expect(await starts()).toBe(1);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("starts the orchestrator again when it is shown again after its process ended", async () => {
    await openFormation();
    await waitForStarts(1);
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました", clean: true });
    await $("#footer-mode-orca").click();
    await $("#footer-mode-formation").click();
    await waitForStarts(2);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("starts nothing for the orchestrator while Orca is the mode", async () => {
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await browser.pause(300);
    expect(await starts()).toBe(0);
    expect(await visible("#formation")).toBe(false);
  });

  it("keeps the count and the label of the 開発 button in the orchestration mode", async () => {
    await boot({ inbox: inbox(), orca_overview: orcaOverview([orcaRow("example-api", "main", "Task of example-api", { group: "waiting" })]) });
    await expect($("#nav-orca .nav-count")).toHaveText("1");
    await openFormation();
    await expect($("#nav-orca .nav-count")).toHaveText("1");
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "開発（確認待ち 1 件）");
  });

  it("has Orca on again when the app starts again", async () => {
    await openFormation();
    await boot({ inbox: inbox() });
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    expect(await pressed("footer-mode-orca")).toBe("true");
  });
});
