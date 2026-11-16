import { boot, callsOf, formationChild, holds, inbox, mock, orcaOverview, orcaRow, rejects, release, sendClaudeCode, textsOf, timers, waitForCalls } from "../support";

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
    // The strip of the children's tabs has no tab yet.
    expect(await browser.execute(() => document.getElementById("formation-tabs")!.childElementCount)).toBe(0);
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

// A-37: the flow pane of the orchestration mode.
const READ = 500;
const WAIT = READ * 1.2;
const cardNames = () => textsOf("#formation-flow-list .formation-card-name");
const cardStates = () => textsOf("#formation-flow-list .formation-card-state");
const rectOf = (selector: string) =>
  browser.execute((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, selector);
// The color a variable has once the page resolves it.
const resolved = (name: string) =>
  browser.execute((n) => {
    const probe = document.createElement("i");
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
const styleOf = (selector: string, property: "backgroundColor" | "borderRightColor" | "borderTopStyle" | "borderTopColor" | "animationName") =>
  browser.execute((s, p) => getComputedStyle(document.querySelector(s)!)[p], selector, property);

async function openFlow(children: unknown, extra: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), formation_children: children, ...timers({ formationFlow: READ }), ...extra });
  await openFormation();
}

const mixed = () => [
  formationChild("api-update", "done", { minutes: 25, reply: "PR #12 を出しました。" }),
  formationChild("web-update", "waiting", { minutes: 1, reply: "依存の衝突を無視して入れてよいか確認します。" }),
  formationChild("batch-update", "working", { minutes: 7, reply: "テストを実行しています。" }),
  formationChild("e2e-check", "planned"),
  formationChild("summary", "planned"),
];

describe("orchestration mode: the flow pane", () => {
  it("heads the pane with the counts and starts the tree with the orchestrator's card", async () => {
    await openFlow(mixed());
    await expect($("#formation-flow h2")).toHaveText("流れ");
    await browser.waitUntil(async () => (await $("#formation-flow-count").getText()) === "子 3 · 予定 2");
    expect(await textsOf("#formation-flow-root .formation-card-name")).toEqual(["formation"]);
    expect(await textsOf("#formation-flow-root .formation-card-role")).toEqual(["司令塔"]);
    // The orchestrator's card is above the children's, and "私" is not drawn.
    const [root, first] = [await rectOf("#formation-flow-root"), await rectOf("#formation-flow-list .formation-card")];
    expect(root.bottom).toBeLessThanOrEqual(first.top);
    expect(await browser.execute(() => document.getElementById("formation-flow")!.textContent!.includes("私"))).toBe(false);
  });

  it("draws the children as cards in the order given, with the state, the time and the first line of the last reply", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    expect(await cardNames()).toEqual(["api-update", "web-update", "batch-update", "e2e-check", "summary"]);
    expect(await cardStates()).toEqual(["完了", "承認待ち", "作業中", "予定", "予定"]);
    // A done child shows how long ago it ended, the others how long their state has lasted; a planned child has no time.
    expect(await textsOf("#formation-flow-list .formation-card-time")).toEqual(["25 分前", "1 分", "7 分"]);
    expect(await textsOf("#formation-flow-list .formation-card-msg")).toEqual(["PR #12 を出しました。", "依存の衝突を無視して入れてよいか確認します。", "テストを実行しています。"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#formation-flow-list .formation-card")].map((c) => (c as HTMLElement).dataset.state))).toEqual(["done", "waiting", "working", "planned", "planned"]);
  });

  it("colors the state with the colors of Orca", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    const dot = (state: string) => `#formation-flow-list .formation-card[data-state="${state}"] .formation-dot`;
    expect(await styleOf(dot("done"), "backgroundColor")).toBe(await resolved("--agent-done"));
    expect(await styleOf(dot("waiting"), "backgroundColor")).toBe(await resolved("--agent-question"));
    expect(await styleOf(dot("working"), "borderRightColor")).toBe(await resolved("--agent-working"));
    expect(await styleOf(dot("working"), "animationName")).toBe("spin");
  });

  it("draws a planned child with a dashed frame and a hollow dot, with no press", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    const planned = '#formation-flow-list .formation-card[data-state="planned"]';
    expect(await styleOf(planned, "borderTopStyle")).toBe("dashed");
    expect(await styleOf(`${planned} .formation-dot`, "backgroundColor")).toBe("rgba(0, 0, 0, 0)");
    expect(await browser.execute((s) => document.querySelector(s)!.tagName, planned)).toBe("DIV");
    expect(await browser.execute((s) => document.querySelector(s)!.querySelectorAll("time, .formation-card-msg").length, planned)).toBe(0);
    await (await $$(planned))[0].click();
    expect(await browser.execute(() => document.querySelectorAll('#formation-flow-list [aria-pressed="true"]').length)).toBe(0);
    // A launched child's card is a solid button.
    expect(await styleOf('#formation-flow-list .formation-card[data-state="working"]', "borderTopStyle")).toBe("solid");
    expect(await browser.execute(() => document.querySelector('#formation-flow-list .formation-card[data-state="working"]')!.tagName)).toBe("BUTTON");
  });

  it("makes a planned child a normal card in the same place when it is launched", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await mock("formation_children", [
      formationChild("api-update", "done", { minutes: 26 }),
      formationChild("web-update", "waiting"),
      formationChild("batch-update", "working"),
      formationChild("e2e-check", "working", { minutes: 0, reply: "調べ始めました。" }),
      formationChild("summary", "planned"),
    ]);
    await browser.waitUntil(async () => (await cardStates()).join() === "完了,承認待ち,作業中,作業中,予定");
    expect(await cardNames()).toEqual(["api-update", "web-update", "batch-update", "e2e-check", "summary"]);
    expect(await browser.execute(() => document.querySelectorAll("#formation-flow-list button.formation-card").length)).toBe(4);
    await expect($("#formation-flow-count")).toHaveText("子 4 · 予定 1");
  });

  it("draws a card again when the state or the reply changes, and leaves the others as they are", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await mock("formation_children", [
      formationChild("api-update", "done", { minutes: 25, reply: "PR #12 を出しました。" }),
      formationChild("web-update", "working", { minutes: 0, reply: "続けています。" }),
      formationChild("batch-update", "waiting", { minutes: 0, reply: "実行してよいか確認します。" }),
      formationChild("e2e-check", "planned"),
      formationChild("summary", "planned"),
    ]);
    await browser.waitUntil(async () => (await cardStates()).slice(0, 3).join() === "完了,作業中,承認待ち");
    expect(await textsOf("#formation-flow-list .formation-card-msg")).toEqual(["PR #12 を出しました。", "続けています。", "実行してよいか確認します。"]);
    expect(await textsOf("#formation-flow-list .formation-card-time")).toEqual(["25 分前", "1 分未満", "1 分未満"]);
  });

  it("keeps the pressed card, and drops the selection of a child that is gone", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await $('#formation-flow-list [data-child="batch-update"]').click();
    await expect($('#formation-flow-list [data-child="batch-update"]')).toHaveAttribute("aria-pressed", "true");
    expect(await browser.execute(() => document.querySelectorAll('#formation-flow-list [aria-pressed="true"]').length)).toBe(1);
    // A read that changes another card leaves the selection and the press that follows moves it.
    await mock("formation_children", [formationChild("api-update", "working"), ...mixed().slice(1)]);
    await browser.waitUntil(async () => (await cardStates())[0] === "作業中");
    await expect($('#formation-flow-list [data-child="batch-update"]')).toHaveAttribute("aria-pressed", "true");
    await $('#formation-flow-list [data-child="web-update"]').click();
    await expect($('#formation-flow-list [data-child="web-update"]')).toHaveAttribute("aria-pressed", "true");
    await expect($('#formation-flow-list [data-child="batch-update"]')).toHaveAttribute("aria-pressed", "false");
    await mock("formation_children", [formationChild("api-update", "working")]);
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    expect(await browser.execute(() => document.querySelectorAll('#formation-flow-list [aria-pressed="true"]').length)).toBe(0);
  });

  it("scrolls the tree alone, keeps the heading in place, and keeps the scroll when it is read again", async () => {
    const many = (minutes: number) => Array.from({ length: 24 }, (_, i) => formationChild(`child-${String(i).padStart(2, "0")}`, "working", { minutes, reply: "作業しています。" }));
    await openFlow(many(2));
    await browser.waitUntil(async () => (await cardNames()).length === 24);
    const measures = await browser.execute(() => {
      const body = document.getElementById("formation-flow-body")!;
      return { overflows: body.scrollHeight > body.clientHeight, pageScrolls: document.documentElement.scrollHeight > window.innerHeight, scroll: getComputedStyle(body).overflowY };
    });
    expect(measures).toEqual({ overflows: true, pageScrolls: false, scroll: "auto" });
    const headTop = (await rectOf("#formation-flow-head")).top;
    await browser.execute(() => {
      document.getElementById("formation-flow-body")!.scrollTop = 300;
    });
    expect((await rectOf("#formation-flow-head")).top).toBe(headTop);
    // A read that changes the cards (the time of each) keeps the position.
    await mock("formation_children", many(9));
    await browser.waitUntil(async () => (await textsOf("#formation-flow-list .formation-card-time"))[0] === "9 分");
    expect(await browser.execute(() => document.getElementById("formation-flow-body")!.scrollTop)).toBe(300);
    expect((await rectOf("#formation-flow-head")).top).toBe(headTop);
  });

  it("reads the children when the mode is shown and then every period, one call at a time", async () => {
    await boot({ inbox: inbox(), ...timers({ formationFlow: READ }) });
    await mock("formation_children", holds);
    await openFormation();
    await waitForCalls("formation_children", 1);
    // The read in hand is not answered, so no other starts while the periods pass.
    await browser.pause(READ * 3);
    expect((await callsOf("formation_children")).length).toBe(1);
    await release("formation_children", [formationChild("api-update", "working")]);
    await mock("formation_children", [formationChild("api-update", "working")]);
    await waitForCalls("formation_children", 2);
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update");
  });

  it("reads nothing while Orca is the mode, or another screen is shown, and reads again when the mode is shown", async () => {
    await boot({ inbox: inbox(), ...timers({ formationFlow: READ }) });
    await $("#nav-orca").click();
    await browser.pause(WAIT * 2);
    expect(await callsOf("formation_children")).toEqual([]);
    await $("#footer-mode-formation").click();
    await waitForCalls("formation_children", 2);
    await $("#footer-mode-orca").click();
    const afterMode = (await callsOf("formation_children")).length;
    await browser.pause(WAIT * 2);
    expect((await callsOf("formation_children")).length).toBe(afterMode);
    await $("#footer-mode-formation").click();
    await waitForCalls("formation_children", afterMode + 1);
    await $("#nav-mail").click();
    const afterScreen = (await callsOf("formation_children")).length;
    await browser.pause(WAIT * 2);
    expect((await callsOf("formation_children")).length).toBe(afterScreen);
    await $("#nav-orca").click();
    await waitForCalls("formation_children", afterScreen + 1);
  });

  it("is open at first, with its button at the right end of the heading", async () => {
    await openFlow(mixed());
    await expect($("#formation-flow")).toBeDisplayed();
    await expect($("#formation-flow-toggle")).toBeDisplayed();
    await expect($("#formation-tabbar-toggle")).not.toBeDisplayed();
    await expect($("#formation-flow-toggle")).toHaveAttribute("aria-pressed", "true");
    const [head, button, flow] = [await rectOf("#formation-flow-head"), await rectOf("#formation-flow-toggle"), await rectOf("#formation-flow")];
    expect(head.right - button.right).toBeLessThan(12);
    expect(button.left).toBeGreaterThan((flow.left + flow.right) / 2);
    expect(button.top).toBeGreaterThanOrEqual(head.top);
    expect(button.bottom).toBeLessThanOrEqual(head.bottom);
  });

  it("closes the pane to the right end of the tab strip, and opens it again from there", async () => {
    await openFlow(mixed());
    const before = await rectOf("#formation-children");
    await $("#formation-flow-toggle").click();
    await expect($("#formation-flow")).not.toBeDisplayed();
    await expect($("#formation-tabbar-toggle")).toBeDisplayed();
    await expect($("#formation-tabbar-toggle")).toHaveAttribute("aria-pressed", "false");
    const [strip, button, children] = [await rectOf("#formation-tabbar"), await rectOf("#formation-tabbar-toggle"), await rectOf("#formation-children")];
    expect(strip.right - button.right).toBeLessThan(12);
    expect(button.top).toBeGreaterThanOrEqual(strip.top);
    expect(button.bottom).toBeLessThanOrEqual(strip.bottom);
    // The middle column takes the width of the pane.
    expect(children.right - children.left).toBeGreaterThan(before.right - before.left + 200);
    await $("#formation-tabbar-toggle").click();
    await expect($("#formation-flow")).toBeDisplayed();
    await expect($("#formation-tabbar-toggle")).not.toBeDisplayed();
    expect(await cardNames()).toEqual(["api-update", "web-update", "batch-update", "e2e-check", "summary"]);
  });

  it("keeps the pane closed while the mode is left and shown again, and the tree stays", async () => {
    await openFlow(mixed());
    await $("#formation-flow-toggle").click();
    await $("#footer-mode-orca").click();
    await $("#footer-mode-formation").click();
    await expect($("#formation-flow")).not.toBeDisplayed();
    await expect($("#formation-tabbar-toggle")).toBeDisplayed();
  });

  it("shows the count of the children that wait on the button while the pane is closed", async () => {
    await openFlow([formationChild("a-update", "waiting"), formationChild("b-update", "waiting"), formationChild("c-update", "working"), formationChild("d-update", "planned")]);
    await browser.waitUntil(async () => (await cardNames()).length === 4);
    // Open: no count, and the label is the name.
    expect(await browser.execute(() => document.querySelector<HTMLElement>("#formation-tabbar-toggle .formation-flow-badge")!.hidden)).toBe(true);
    await $("#formation-flow-toggle").click();
    await expect($("#formation-tabbar-toggle .formation-flow-badge")).toBeDisplayed();
    await expect($("#formation-tabbar-toggle .formation-flow-badge")).toHaveText("2");
    await expect($("#formation-tabbar-toggle")).toHaveAttribute("aria-label", "流れ（承認待ち 2 件）");
    // The count follows the reads while the pane is closed.
    await mock("formation_children", [formationChild("a-update", "working"), formationChild("b-update", "waiting"), formationChild("c-update", "waiting"), formationChild("d-update", "waiting")]);
    await browser.waitUntil(async () => (await $("#formation-tabbar-toggle .formation-flow-badge").getText()) === "3");
    await mock("formation_children", [formationChild("a-update", "working"), formationChild("d-update", "planned")]);
    await expect($("#formation-tabbar-toggle .formation-flow-badge")).not.toBeDisplayed();
    await expect($("#formation-tabbar-toggle")).toHaveAttribute("aria-label", "流れ");
    await $("#formation-tabbar-toggle").click();
    await expect($("#formation-flow-toggle")).toHaveAttribute("aria-label", "流れ");
  });

  it("says that a read failed in the pane, keeps the tree, and clears the text when a read works", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await expect($("#formation-flow-error")).not.toBeDisplayed();
    await mock("formation_children", rejects("Orca に届きません"));
    await expect($("#formation-flow-error")).toBeDisplayed();
    await expect($("#formation-flow-error")).toHaveText("Orca に届きません");
    expect((await cardNames()).length).toBe(5);
    await mock("formation_children", [formationChild("api-update", "working")]);
    await expect($("#formation-flow-error")).not.toBeDisplayed();
    expect(await cardNames()).toEqual(["api-update"]);
  });

  it("says that the first read failed", async () => {
    await openFlow(rejects("Orca に届きません"));
    await expect($("#formation-flow-error")).toBeDisplayed();
    await expect($("#formation-flow-error")).toHaveText("Orca に届きません");
    expect(await cardNames()).toEqual([]);
  });
});
