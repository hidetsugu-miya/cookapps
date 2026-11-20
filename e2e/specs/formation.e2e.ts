import { boot, callsOf, count, decisionCard, decisionOption, decisionPage, formationChild, formationConsent, formationEntry, formationEnvironments, formationList, formationMessage, holds, inbox, listedChild, mock, onceId, orcaOverview, orcaRow, orcaTerminal, orcaWorktree, rejects, release, sendClaudeCode, sendStream, sendTerm, streamList, textsOf, timers, verificationCard, waitForCalls, CARDS, CARD } from "../support";
import { pickItem } from "../orca-support";

import type { DecisionPage } from "../../ts/bindings/DecisionPage";
import type { FormationList } from "../../ts/bindings/FormationList";

// The text of each element as it is, with the spaces that `textsOf` trims (a line of git's status starts with one).
const rawTextsOf = (selector: string) => browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.textContent ?? ""), selector);

// A-37: the orchestration of the development screen: the formations in the list of the Orca screen, and the leader and the flow in place of the work pane. The leader's pane is Claude Code of A-36 (`kind: "formation"`), so its process is the mocked `claude_code_start`.
const visible = (selector: string) => browser.execute((s) => document.querySelector(s)?.getClientRects().length !== 0 && !document.querySelector<HTMLElement>(s)!.hidden, selector);
const pressed = (selector: string) => browser.execute((s) => document.querySelector(s)!.getAttribute("aria-pressed"), selector);
const ground = (selector: string) => browser.execute((s) => getComputedStyle(document.querySelector(s)!).backgroundColor, selector);
const starts = async () => (await callsOf("claude_code_start")).length;
// The press is made in the page: the driver takes the focus to the button after its click, which a real press does before.
const waitForStarts = (n: number) => browser.waitUntil(async () => (await starts()) === n, { timeoutMsg: `claude_code_start was not called ${n} times` });

// A list with one project that has a session with no pane, so the project is a row of the list and pressing it shows the work pane of Orca with nothing to read.
const ORCA_LIST = () => orcaOverview([orcaRow("api", "main", "Write the docs", { handle: null, paneKey: null })]);
const PROJECT = '#orca-feed .orca-project[data-key="proj_api"]';
const ROW = (name: string) => `#formation-list-feed [data-formation="${name}"]`;
// The line of a formation holds its row, a button, and the count and the number beside it; it has the ground of the selected row (#1112).
const LINES = "#formation-list-feed .formation-line";
const LINE_OF = (name: string) => `${LINES}:has([data-formation="${name}"])`;

// Opens the development screen and selects a formation. No formation is selected at the start, so the row of `select` (the one the default fixture has, `formation`) is pressed unless it is `null`.
async function openFormation(select: string | null = "formation") {
  await $("#nav-orca").click();
  await expect($("#orca")).toBeDisplayed();
  if (select !== null) {
    await $(ROW(select)).click();
    await expect($("#formation")).toBeDisplayed();
  }
}

describe("development screen: orchestration", () => {
  beforeEach(async () => {
    await boot({ inbox: inbox() });
  });

  it("calls the sidebar's Orca button 開発, with the code icon", async () => {
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "開発");
    expect(await browser.execute(() => document.querySelector("#nav-orca svg path")!.getAttribute("d"))).toBe("m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16");
    await $("#nav-orca").click();
    await expect($("#nav-orca")).toHaveAttribute("aria-current", "page");
  });

  it("has no switch of a mode in the footer, on the development screen too: the bell alone", async () => {
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    expect(await browser.execute(() => ["footer-modes", "footer-mode-orca", "footer-mode-formation"].map((id) => document.getElementById(id)))).toEqual([null, null, null]);
    expect(await browser.execute(() => [...document.querySelectorAll("#footer button")].map((b) => b.id))).toEqual(["footer-bell"]);
    await expect($("#footer-bell")).toBeDisplayed();
  });

  it("starts with the work pane of Orca and the formations and the projects in one list under their headings", async () => {
    await boot({ inbox: inbox(), orca_overview: ORCA_LIST() });
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await expect($("#orca-session")).toBeDisplayed();
    await expect($("#formation")).not.toBeDisplayed();
    expect(await textsOf("#orca-list .orca-list-head")).toEqual(["フォーメーション", "プロジェクト"]);
    // The order of the list, from the top: the formations, the heading of the projects, the projects.
    const tops = await browser.execute(() => ["orca-formations", "orca-feed"].map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().top)));
    expect(tops[0]).toBeLessThan(tops[1]);
    expect(await textsOf("#formation-list-feed .formation-row-name")).toEqual(["formation"]);
    await expect($(PROJECT)).toBeDisplayed();
    // Only one list: the formations have no pane of their own at the left.
    expect(await browser.execute(() => ["formation-list", "formation-split"].map((id) => document.getElementById(id)))).toEqual([null, null]);
  });

  it("has the button that makes a formation in the header of the list, beside the one that adds a project", async () => {
    await $("#nav-orca").click();
    const place = await browser.execute(() => {
      const buttons = [...document.querySelectorAll("#orca-header button")].map((b) => b.id);
      return { buttons, inHeader: document.getElementById("formation-new")!.closest("#orca-header") !== null };
    });
    expect(place.inHeader).toBe(true);
    expect(place.buttons).toEqual(expect.arrayContaining(["formation-new", "orca-add"]));
    await expect($("#formation-new")).toHaveAttribute("aria-label", "フォーメーションを作る");
  });

  it("shows the leader and the flow in place of the work pane when a formation is pressed, with the ground of the selected row", async () => {
    await boot({ inbox: inbox(), orca_overview: ORCA_LIST(), formation_children: [formationChild("api-update", "planned")] });
    await openFormation();
    await expect($("#formation-flow")).toBeDisplayed();
    await expect($("#orca-session")).not.toBeDisplayed();
    await expect($("#orca-work")).not.toBeDisplayed();
    await expect($("#nav-orca")).toHaveAttribute("aria-current", "page");
    // The pale green ground (--soft) is the one of the selected row; a project's row has none.
    expect(await pressed(ROW("formation"))).toBe("true");
    expect(await ground(LINE_OF("formation"))).toBe("rgb(227, 244, 234)");
    expect(await pressed(PROJECT)).toBe("false");
    expect(await ground(PROJECT)).toBe("rgba(0, 0, 0, 0)");
    const lefts = await browser.execute(() => ["orca-list", "formation-orchestrator", "formation-flow"].map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().left)));
    expect(lefts[0]).toBeLessThan(lefts[1]);
    expect(lefts[1]).toBeLessThan(lefts[2]);
    await expect($("#formation-tab-leader-main .formation-tab-name")).toHaveText("リーダー");
    expect(await count("#formation-tab-leader-main .formation-tab-effort")).toBe(0);
  });

  it("shows the work pane again when a project is pressed, and the formation is no longer selected", async () => {
    await boot({ inbox: inbox(), orca_overview: ORCA_LIST() });
    await openFormation();
    await $(PROJECT).click();
    await expect($("#orca-session")).toBeDisplayed();
    await expect($("#formation")).not.toBeDisplayed();
    expect(await pressed(ROW("formation"))).toBe("false");
    expect(await pressed(PROJECT)).toBe("true");
    await $(ROW("formation")).click();
    await expect($("#formation")).toBeDisplayed();
    await expect($("#orca-session")).not.toBeDisplayed();
    expect(await pressed(PROJECT)).toBe("false");
  });

  it("keeps one divider for the list, whichever of the two is shown", async () => {
    await boot({ inbox: inbox(), orca_overview: ORCA_LIST() });
    await openFormation(null);
    const width = () => browser.execute(() => Math.round(document.getElementById("orca-list")!.getBoundingClientRect().width));
    const before = await width();
    await browser.execute((id) => window.__e2e_once__(id) && document.getElementById("orca-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })), onceId());
    const after = await width();
    expect(after).toBeGreaterThan(before);
    await $(ROW("formation")).click();
    expect(await width()).toBe(after);
    await $(PROJECT).click();
    expect(await width()).toBe(after);
  });

  it("shows the button that opens the list again in the head of the leader's pane while the list is closed and a formation is shown", async () => {
    await openFormation();
    // The list is open: the button of the header of the list is the only one.
    await expect($("#formation-list-toggle")).not.toBeDisplayed();
    await $("#orca-list-toggle").click();
    await expect($("#orca-list")).not.toBeDisplayed();
    const button = $("#formation-list-toggle");
    await expect(button).toBeDisplayed();
    await expect(button).toHaveAttribute("aria-label", "プロジェクト一覧");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    // It is the first thing in the head, before the tabs.
    expect(await browser.execute(() => document.getElementById("formation-head")!.firstElementChild!.id)).toBe("formation-list-toggle");
    await button.click();
    await expect($("#orca-list")).toBeDisplayed();
    await expect($("#formation-list-toggle")).not.toBeDisplayed();
    await expect($("#orca-list-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("starts the orchestrator with the pane id of its formation, Claude Code's own tools, no skill and no project, in the size of the left pane", async () => {
    await openFormation();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "formation:formation", builtinTools: true, permissionMode: "manual", skill: null });
    const { cols, rows } = (start as { viewport: { cols: number; rows: number } }).viewport;
    expect(cols).toBeGreaterThan(30);
    expect(rows).toBeGreaterThan(8);
    await sendClaudeCode({ kind: "output", data: "orchestrator ready" });
    await browser.waitUntil(async () => (await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).includes("orchestrator ready"));
    for (const command of ["orca_stream_terminal", "orca_terminal_read", "orca_stream_input"]) expect(await callsOf(command)).toEqual([]);
  });

  it("does not start the orchestrator again when a project is pressed, or the screen is left, and the formation is shown again", async () => {
    await boot({ inbox: inbox(), orca_overview: ORCA_LIST() });
    await openFormation();
    await waitForStarts(1);
    await $(PROJECT).click();
    await expect($("#formation-term")).not.toBeDisplayed();
    await $(ROW("formation")).click();
    await expect($("#formation-term")).toBeDisplayed();
    await $("#nav-mail").click();
    await $("#nav-orca").click();
    // The selection was kept while the screen was left.
    await expect($("#formation")).toBeDisplayed();
    await $("#nav-todo").click();
    await $("#nav-orca").click();
    await browser.pause(300);
    expect(await starts()).toBe(1);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("starts the orchestrator again when it is shown again after its process ended", async () => {
    await boot({ inbox: inbox(), orca_overview: ORCA_LIST() });
    await openFormation();
    await waitForStarts(1);
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました", clean: true });
    await $(PROJECT).click();
    await $(ROW("formation")).click();
    await waitForStarts(2);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("starts nothing for the orchestrator while no formation is selected", async () => {
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await browser.pause(300);
    expect(await starts()).toBe(0);
    expect(await visible("#formation")).toBe(false);
  });

  it("keeps the count and the label of the 開発 button while a formation is shown", async () => {
    await boot({ inbox: inbox(), orca_overview: orcaOverview([orcaRow("example-api", "main", "Task of example-api", { group: "waiting" })]) });
    await expect($("#nav-orca .nav-count")).toHaveText("1");
    await openFormation();
    await expect($("#nav-orca .nav-count")).toHaveText("1");
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "開発（確認待ち 1 件）");
  });

  it("shows the work pane of Orca and no formation selected when the app starts again", async () => {
    await openFormation();
    await boot({ inbox: inbox() });
    await $("#nav-orca").click();
    await expect($("#orca-session")).toBeDisplayed();
    await expect($("#formation")).not.toBeDisplayed();
    expect(await pressed(ROW("formation"))).toBe("false");
  });
});

// A-37: the flow pane of the orchestration.
const READ = 500;
const WAIT = READ * 1.2;
const cardNames = () => textsOf("#formation-flow-list .formation-card-name");
const cardStates = () => textsOf("#formation-flow-list .formation-card-state");
const rectOf = (selector: string) =>
  browser.execute((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, selector);
// The color a variable has once the page resolves it, as a ground.
const resolvedGround = (name: string) =>
  browser.execute((n) => {
    const probe = document.createElement("i");
    probe.style.backgroundColor = `var(${n})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, name);
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
const styleOf = (selector: string, property: "backgroundColor" | "borderRightColor" | "borderTopStyle" | "borderTopColor" | "borderLeftStyle" | "color" | "animationName") =>
  browser.execute((s, p) => getComputedStyle(document.querySelector(s)!)[p], selector, property);

// A pseudo-element's computed style: the branch of a card is the `::before` of its `li`, and the colored trunk the `::after` of a working one.
const pseudoOf = (selector: string, pseudo: "::before" | "::after", property: "backgroundColor" | "height" | "content") =>
  browser.execute((sel, ps, prop) => getComputedStyle(document.querySelector(sel)!, ps)[prop], selector, pseudo, property);
const FLOW_LI = (name: string) => `#formation-flow-list li[data-name="${name}"]`;

const FLOW_DONE = "#formation-flow-done";

// Presses the chip 「完了 N」 of the flow's heading unless it is pressed, so that the cards of the done children are drawn (#1113).
async function showDoneCards() {
  await $(FLOW_DONE).waitForDisplayed();
  if ((await $(FLOW_DONE).getAttribute("aria-pressed")) !== "true") await $(FLOW_DONE).click();
  await expect($(FLOW_DONE)).toHaveAttribute("aria-pressed", "true");
}

// Opens the formation. The done children's cards are left out until their chip is pressed, so the specs that look at those cards have it pressed here; `doneHidden` leaves the chip as it is drawn.
async function openFlow(children: unknown, extra: Record<string, unknown> = {}, doneHidden = false) {
  await boot({ inbox: inbox(), orca_overview: ORCA_LIST(), formation_children: children, ...timers({ formationFlow: READ }), ...extra });
  await openFormation();
  if (!doneHidden && Array.isArray(children) && children.some((c) => (c as { state?: string }).state === "done")) await showDoneCards();
}

const mixed = () => [
  formationChild("api-update", "done", { minutes: 25, reply: "PR #12 を出しました。" }),
  formationChild("web-update", "waiting", { minutes: 1, reply: "依存の衝突を無視して入れてよいか確認します。" }),
  formationChild("batch-update", "working", { minutes: 7, reply: "テストを実行しています。" }),
  formationChild("e2e-check", "planned"),
  formationChild("summary", "planned"),
];

describe("orchestration mode: the flow pane", () => {
  it("heads the pane 流れ, with no count, and starts the column with the leader's card", async () => {
    await openFlow(mixed());
    await expect($("#formation-flow-head h2")).toHaveText("流れ");
    await expect($("#formation-flow")).toHaveAttribute("aria-label", "流れ");
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    expect(await count("#formation-flow-count")).toBe(0);
    expect(await textsOf("#formation-flow-root .formation-card-name")).toEqual(["formation"]);
    expect(await textsOf("#formation-flow-root .formation-card-role")).toEqual(["リーダー"]);
    // The leader's card is above the children's, and "私" is not drawn.
    const [root, first] = [await rectOf("#formation-flow-root"), await rectOf("#formation-flow-list .formation-card")];
    expect(root.bottom).toBeLessThanOrEqual(first.top);
    expect(await browser.execute(() => document.getElementById("formation-flow")!.textContent!.includes("私"))).toBe(false);
  });

  it("draws the children as cards, working first, then waiting, then planned, and the done one last, with the state, the time and the first line of the last reply", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    expect(await cardNames()).toEqual(["batch-update", "web-update", "e2e-check", "summary", "api-update"]);
    expect(await cardStates()).toEqual(["作業中", "承認待ち", "予定", "予定", "完了"]);
    // A done child shows how long ago it ended, the others how long their state has lasted; a planned child has no time.
    expect(await textsOf("#formation-flow-list .formation-card-time")).toEqual(["7 分", "1 分", "25 分前"]);
    expect(await textsOf("#formation-flow-list .formation-card-msg")).toEqual(["テストを実行しています。", "依存の衝突を無視して入れてよいか確認します。", "PR #12 を出しました。"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#formation-flow-list .formation-card")].map((c) => (c as HTMLElement).dataset.state))).toEqual(["working", "waiting", "planned", "planned", "done"]);
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
    // The press of a planned card selects nothing: the leader's card stays the one marked.
    await (await $$(planned))[0].click();
    expect(await browser.execute(() => [...document.querySelectorAll('#formation-flow-list [aria-pressed="true"]')].map((e) => (e as HTMLElement).dataset.child))).toEqual([]);
    expect(await pressed("#formation-flow-root")).toBe("true");
    // A launched child's card is a solid button.
    expect(await styleOf('#formation-flow-list .formation-card[data-state="working"]', "borderTopStyle")).toBe("solid");
    expect(await browser.execute(() => document.querySelector('#formation-flow-list .formation-card[data-state="working"]')!.tagName)).toBe("BUTTON");
  });

  it("reads the children of the formation named formation", async () => {
    await openFlow(mixed());
    const calls = await waitForCalls("formation_children", 1);
    expect(calls[0]).toEqual({ name: "formation" });
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
    await browser.waitUntil(async () => (await cardStates()).join() === "作業中,作業中,承認待ち,予定,完了");
    expect(await cardNames()).toEqual(["batch-update", "e2e-check", "web-update", "summary", "api-update"]);
    expect(await browser.execute(() => document.querySelectorAll("#formation-flow-list button.formation-card").length)).toBe(4);
    // No tab opens by itself; the card of the launched child opens its tab, and the planned one has no card to press.
    expect(await count("#formation-tabs-mates .formation-tab")).toBe(0);
    await card("e2e-check").click();
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["e2e-check"]);
    expect(await browser.execute(() => document.querySelector('#formation-flow-list [data-name="summary"] .formation-card')!.tagName)).toBe("DIV");
  });

  it("joins each card to the trunk by a branch, thick and in the working color for a working child and thin and gray for the others, and colors the trunk down to the last working child", async () => {
    await openFlow([formationChild("web-update", "waiting"), formationChild("batch-update", "working"), formationChild("api-update", "working"), formationChild("e2e-check", "planned"), formationChild("old-one", "done")]);
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    expect(await cardNames()).toEqual(["batch-update", "api-update", "web-update", "e2e-check", "old-one"]);
    const working = await resolvedGround("--agent-working");
    const gray = await resolvedGround("--chip-line");
    for (const name of ["batch-update", "api-update"]) {
      expect(await pseudoOf(FLOW_LI(name), "::before", "backgroundColor")).toBe(working);
      expect(await pseudoOf(FLOW_LI(name), "::before", "height")).toBe("2.5px");
      expect(await pseudoOf(FLOW_LI(name), "::after", "backgroundColor")).toBe(working);
    }
    for (const name of ["web-update", "e2e-check", "old-one"]) {
      expect(await pseudoOf(FLOW_LI(name), "::before", "backgroundColor")).toBe(gray);
      expect(await pseudoOf(FLOW_LI(name), "::before", "height")).toBe("1.5px");
      expect(await pseudoOf(FLOW_LI(name), "::after", "content")).toBe("none");
    }
  });

  it("draws the trunk and every branch gray while no child works", async () => {
    await openFlow([formationChild("web-update", "waiting"), formationChild("e2e-check", "planned")]);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    const gray = await resolvedGround("--chip-line");
    for (const name of ["web-update", "e2e-check"]) {
      expect(await pseudoOf(FLOW_LI(name), "::before", "backgroundColor")).toBe(gray);
      expect(await pseudoOf(FLOW_LI(name), "::before", "height")).toBe("1.5px");
      expect(await pseudoOf(FLOW_LI(name), "::after", "content")).toBe("none");
    }
  });

  it("keeps a child that a decision page waits for in its own place among the cards, with its own state, and puts the page in a card of its own", async () => {
    const page = { title: "要件の未決事項", atMs: MARK_AT };
    await openFlow([formationChild("req-login", "working", { minutes: 5, reply: "調べています。", pendingPage: page }), formationChild("web-update", "waiting"), formationChild("batch-update", "working")], { formation_page_read: decisionPage() }, true);
    await browser.waitUntil(async () => (await cardNames()).length === 3);
    expect(await cardNames()).toEqual(["req-login", "batch-update", "web-update"]);
    // The card of the child says its own state and its own last words; the page is not in it.
    expect(await textsOf(`${FLOW_LI("req-login")} .formation-card-state`)).toEqual(["作業中"]);
    expect(await textsOf(`${FLOW_LI("req-login")} .formation-card-msg`)).toEqual(["調べています。"]);
    expect(await count(`${FLOW_LI("req-login")} .formation-card-open`)).toBe(0);
    expect(await count("#formation-flow-list [data-page]")).toBe(0);
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
    await browser.waitUntil(async () => (await textsOf("#formation-flow-list .formation-card-msg"))[0] === "続けています。");
    expect(await textsOf("#formation-flow-list .formation-card-msg")).toEqual(["続けています。", "実行してよいか確認します。", "PR #12 を出しました。"]);
    expect(await textsOf("#formation-flow-list .formation-card-time")).toEqual(["1 分未満", "1 分未満", "25 分前"]);
  });

  it("keeps the pressed card, and moves the selection to the leader's tab when its child is gone", async () => {
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
    expect(await browser.execute(() => [...document.querySelectorAll('#formation-flow-list [aria-pressed="true"]')].map((e) => (e as HTMLElement).dataset.child))).toEqual([]);
    expect(await pressed("#formation-flow-root")).toBe("true");
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
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
      document.getElementById("formation-flow-body")!.scrollTop = 120;
    });
    expect((await rectOf("#formation-flow-head")).top).toBe(headTop);
    const scrolled = await browser.execute(() => document.getElementById("formation-flow-body")!.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    // A read that changes the cards (the time of each) keeps the position.
    await mock("formation_children", many(9));
    await browser.waitUntil(async () => (await textsOf("#formation-flow-list .formation-card-time"))[0] === "9 分");
    expect(await browser.execute(() => document.getElementById("formation-flow-body")!.scrollTop)).toBe(scrolled);
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
    // Answer the next reads before the held one is released, so that the read that follows it is not held again; `mock` forgets the calls, and the next one is the first of the new answer.
    await mock("formation_children", [formationChild("api-update", "working")]);
    await release("formation_children", [formationChild("api-update", "working")]);
    await waitForCalls("formation_children", 1);
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update");
  });

  it("reads nothing while another screen is shown, and reads again when the screen is shown", async () => {
    await boot({ inbox: inbox(), ...timers({ formationFlow: READ, orcaClock: READ }) });
    await $("#nav-orca").click();
    // No formation is selected: the list is read, and no children.
    await waitForCalls("formation_list", 1);
    expect(await callsOf("formation_children")).toEqual([]);
    await $(ROW("formation")).click();
    const afterMode = (await callsOf("formation_children")).length;
    await waitForCalls("formation_children", afterMode + 1);
    await $("#nav-mail").click();
    const afterScreen = (await callsOf("formation_children")).length;
    await browser.pause(WAIT * 2);
    expect((await callsOf("formation_children")).length).toBe(afterScreen);
    await $("#nav-orca").click();
    await waitForCalls("formation_children", afterScreen + 1);
  });

  it("reads nothing while the window is hidden, and reads once when it is shown again", async () => {
    await openFlow(mixed());
    await waitForCalls("formation_children", 1);
    const setHidden = (hidden: boolean) =>
      browser.execute((h) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        if (!h) document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await setHidden(true);
    await mock("formation_children", mixed());
    await browser.pause(WAIT * 3);
    expect(await callsOf("formation_children")).toEqual([]);
    await setHidden(false);
    await waitForCalls("formation_children", 1);
  });

  it("has the chip 完了 N and the button of the view in the heading, the latter at its right end, and nothing that closes the pane, follows a child or a strip that stays", async () => {
    await openFlow(mixed());
    await expect($("#formation-flow")).toBeDisplayed();
    for (const id of ["formation-flow-toggle", "formation-strip", "formation-strip-open", "formation-flow-split", "formation-session", "formation-child-term", "formation-flow-count", "formation-follow"]) expect(await browser.execute((i) => document.getElementById(i), id)).toBeNull();
    expect(await browser.execute(() => [...document.querySelectorAll('#formation-flow-head button, #formation-flow-head [role="button"]')].map((e) => e.id))).toEqual(["formation-flow-done", "formation-flow-size"]);
    const [head, button] = [await rectOf("#formation-flow-head"), await rectOf("#formation-flow-size")];
    expect(head.right - button.right).toBeLessThan(24);
    expect(button.top).toBeGreaterThanOrEqual(head.top);
    expect(button.bottom).toBeLessThanOrEqual(head.bottom);
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

  it("shows the leader's card alone in the pane when the first read failed, because no child is known", async () => {
    await openFlow(rejects("Orca に届きません"));
    await waitForCalls("formation_children", 1);
    await expect($("#formation-flow")).toBeDisplayed();
    await expect($("#formation-flow-root")).toBeDisplayed();
    expect(await headName()).toBe("formation");
    expect(await cardNames()).toEqual([]);
  });

  it("keeps the pane of the last read that worked when a read fails", async () => {
    await openFlow([formationChild("api-update", "working")]);
    await expect($("#formation-flow")).toBeDisplayed();
    await mock("formation_children", rejects("Orca に届きません"));
    await expect($("#formation-flow-error")).toHaveText("Orca に届きません");
    await expect($("#formation-orchestrator")).toBeDisplayed();
    await expect($("#formation-flow")).toBeDisplayed();
    expect((await cardNames()).length).toBe(1);
  });
});

// A-37: the right pane appears with the first child.

describe("orchestration mode: the panes beside the list", () => {
  it("shows the right pane with the leader's card alone while no child is recorded, 260px wide at the right end, with no divider before it", async () => {
    await openFlow([]);
    await waitForCalls("formation_children", 1);
    await expect($("#formation-orchestrator")).toBeDisplayed();
    await expect($("#formation-flow")).toBeDisplayed();
    expect(await headName()).toBe("formation");
    await expect($("#formation-flow-root .formation-card-role")).toHaveText("リーダー");
    expect(await cardNames()).toEqual([]);
    const [orchestrator, flow, screen, divider] = [await rectOf("#formation-orchestrator"), await rectOf("#formation-flow"), await rectOf("#orca"), await rectOf("#orca-split")];
    expect(Math.abs(orchestrator.left - divider.right)).toBeLessThan(1);
    expect(Math.abs(orchestrator.right - flow.left)).toBeLessThan(1);
    expect(Math.abs(flow.right - screen.right)).toBeLessThan(1);
    expect(Math.round(flow.right - flow.left)).toBe(260);
    // The formation has the middle pane and the right pane alone: no divider, no strip. The list and its divider are the Orca screen's.
    expect(await browser.execute(() => [...document.getElementById("formation")!.children].map((e) => e.id))).toEqual(["formation-orchestrator", "formation-flow"]);
    expect(await browser.execute(() => [...document.getElementById("orca")!.children].map((e) => e.id))).toEqual(["orca-list", "orca-split", "orca-session", "formation"]);
  });

  it("draws the cards under the leader's card when a child, a planned one too, is recorded, and takes them away when the children are gone, with the pane as it was", async () => {
    await openFlow([]);
    await waitForCalls("formation_children", 1);
    const width = async () => {
      const r = await rectOf("#formation-flow");
      return Math.round(r.right - r.left);
    };
    expect(await width()).toBe(260);
    await mock("formation_children", [formationChild("api-update", "planned")]);
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update");
    expect(await width()).toBe(260);
    await mock("formation_children", []);
    await browser.waitUntil(async () => (await cardNames()).length === 0);
    await expect($("#formation-flow")).toBeDisplayed();
    await expect($("#formation-flow-root")).toBeDisplayed();
    expect(await width()).toBe(260);
    const [pane, flow] = [await rectOf("#formation-orchestrator"), await rectOf("#formation-flow")];
    expect(Math.abs(pane.right - flow.left)).toBeLessThan(1);
  });
});

// A-37: the view of the flow, and the session of the selected child under it.
const selectedCard = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>('#formation-flow-list [aria-pressed="true"]')].map((e) => e.dataset.child ?? null));
const card = (name: string) => $(`#formation-flow-list [data-child="${name}"]`);
const screenText = () => $("#formation-teammate-term .orca-term-box:not([hidden]) .xterm-rows").getText();
const readHandles = async () => [...new Set((await callsOf("orca_terminal_read")).map((c) => (c as { handle: string }).handle))];
const MIRROR = 250;

// No tab of a child is open when a formation is opened (#1165), and most of these specs look at a child's terminal: the card of the child that waits the longest, else of the first that works, is pressed, as the owner presses the card of the child to talk to.
async function openFirst(children: unknown) {
  const list = (children as { name: string; state: string; atMs: number; handle: string | null }[]).filter((c) => c.handle !== null);
  const waiting = list.filter((c) => c.state === "waiting").sort((a, b) => a.atMs - b.atMs)[0];
  const target = waiting ?? list.find((c) => c.state === "working");
  if (!target) return;
  await $(`#formation-flow-list [data-child="${target.name}"]`).click();
  await expect($(`#formation-tabs-mates [data-child="${target.name}"]`)).toHaveAttribute("aria-selected", "true");
}

async function openSession(children: unknown, extra: Record<string, unknown> = {}) {
  await openFlow(children, { ...timers({ formationFlow: READ, orcaMirror: MIRROR }), orca_terminal_read: ["$ claude", "> 確認します"], ...extra });
  await browser.waitUntil(async () => (await cardNames()).length > 0);
  await openFirst(children);
}

// Presses the card of each child named, in this order, so that their tabs are open (the last pressed is the selected one).
async function openTabs(names: string[]) {
  for (const name of names) await $(`#formation-flow-list [data-child="${name}"]`).click();
  await browser.waitUntil(async () => (await textsOf("#formation-tabs-mates .formation-tab-name")).length === names.length);
}

describe("orchestration mode: the view of the flow", () => {
  it("puts the leader's card on top and the children in one column under it, joined by a line at their left", async () => {
    await openFlow([formationChild("a-update", "working"), formationChild("b-update", "planned")]);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    const rects = await browser.execute(() => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      return { root: box(document.getElementById("formation-flow-root")!), cards: [...document.querySelectorAll("#formation-flow-list .formation-card")].map(box) };
    });
    expect(rects.cards.length).toBe(2);
    for (const c of rects.cards) expect(c.top).toBeGreaterThanOrEqual(rects.root.bottom);
    // One column: the cards share a left and a width, and follow each other from the top; the column is under the leader's card, a little to the right of it.
    expect(new Set(rects.cards.map((c) => Math.round(c.left))).size).toBe(1);
    expect(new Set(rects.cards.map((c) => Math.round(c.right - c.left))).size).toBe(1);
    expect(rects.cards[0].bottom).toBeLessThanOrEqual(rects.cards[1].top);
    expect(rects.cards[0].left).toBeGreaterThan(rects.root.left);
    // The line at the left of the column joins the cards to the leader's card.
    expect(await styleOf("#formation-flow-list", "borderLeftStyle")).toBe("solid");
    // 1.5px in the style sheet; the window of the E2E build has one device pixel to a pixel, which draws it as 1px.
    expect(await browser.execute(() => Number.parseFloat(getComputedStyle(document.getElementById("formation-flow-list")!).borderLeftWidth))).toBeGreaterThanOrEqual(1);
    const [list, root] = [await rectOf("#formation-flow-list"), await rectOf("#formation-flow-root")];
    expect(Math.abs(list.top - root.bottom)).toBeLessThan(1);
  });

  it("stacks the cards in one column that scrolls inside the pane", async () => {
    await openSession(Array.from({ length: 24 }, (_, i) => formationChild(`child-${String(i).padStart(2, "0")}`, "working")));
    await browser.waitUntil(async () => (await cardNames()).length === 24);
    const tops = await browser.execute(() => [...new Set([...document.querySelectorAll("#formation-flow-list .formation-card")].map((c) => Math.round(c.getBoundingClientRect().top)))]);
    expect(tops.length).toBe(24);
    const [body, flow, head] = [await rectOf("#formation-flow-body"), await rectOf("#formation-flow"), await rectOf("#formation-flow-head")];
    expect(Math.abs(body.bottom - flow.bottom)).toBeLessThan(1);
    expect(body.top).toBeGreaterThanOrEqual(head.bottom);
  });

  it("draws the leader's tab alone until a card is pressed, and then the tabs of the children that were pressed: those that work, then those that wait, then the done ones, after the leader's, with the mark of its state and no tag", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await browser.pause(WAIT * 2);
    expect(await textsOf("#formation-tabs .formation-tab-name")).toEqual(["リーダー"]);
    await openTabs(["api-update", "web-update", "batch-update"]);
    expect(await textsOf("#formation-tabs .formation-tab-name")).toEqual(["リーダー", "batch-update", "web-update", "api-update"]);
    expect(await count("#formation-tabs .formation-tab-effort")).toBe(0);
    expect(await count('#formation-tabs-mates .formation-tab[data-state="planned"]')).toBe(0);
    expect(await textsOf("#formation-tabs-mates .formation-tab-mark")).toEqual(["◐", "●", "✓"]);
    expect(await browser.execute(() => document.getElementById("formation-tabs")!.getAttribute("role"))).toBe("tablist");
    const marks = (state: string) => `#formation-tabs-mates .formation-tab[data-state="${state}"] .formation-tab-mark`;
    expect(await styleOf(marks("done"), "color")).toBe(await resolved("--agent-done"));
    expect(await styleOf(marks("waiting"), "color")).toBe(await resolved("--agent-question"));
    expect(await styleOf(marks("working"), "color")).toBe(await resolved("--agent-working"));
    // The tabs are in the header, and the header is above the terminal.
    const [head, tabs, term] = [await rectOf("#formation-head"), await rectOf("#formation-tabs"), await rectOf("#formation-teammate-term")];
    expect(tabs.top).toBeGreaterThanOrEqual(head.top);
    expect(tabs.bottom).toBeLessThanOrEqual(head.bottom + 1);
    expect(head.bottom).toBeLessThanOrEqual(term.top + 1);
  });

  it("marks a Codex child by its agent in its tab and on its card, and a Claude Code child has no tag", async () => {
    await openSession([formationChild("api-update", "working"), formationChild("review-codex", "working", { agent: "codex" })]);
    await card("review-codex").click();
    await expect($('#formation-tabs-mates [data-child="review-codex"]')).toHaveAttribute("aria-selected", "true");
    expect(await textsOf("#formation-tabs-mates .formation-tab-effort")).toEqual(["codex"]);
    expect(await textsOf("#formation-flow-list .formation-card-agent")).toEqual(["codex"]);
    expect(await textsOf("#formation-flow-list .formation-card-name")).toEqual(["api-update", "review-codex"]);
  });

  it("draws no tab for a planned child or a child with no terminal, and a done child's card has the × that deletes it, which no tab has", async () => {
    await openFlow([formationChild("a-update", "planned"), formationChild("b-update", "done"), formationChild("c-update", "done", { handle: null })]);
    await browser.waitUntil(async () => (await cardNames()).length === 3);
    await card("b-update").click();
    await card("c-update").click();
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["b-update"]);
    expect(await count('#formation-tabs-mates .formation-tab[data-state="planned"]')).toBe(0);
    // The × of a card closes (deletes) the child, and the cards of the done children have it, whether or not their terminal is still listed.
    expect(await count("#formation-flow-list .formation-card-close")).toBe(2);
    // The × of a tab only hides it.
    expect(await count("#formation-tabs-mates .formation-tab .formation-card-close")).toBe(0);
  });

  it("hides a tab with its ×, and leaves the child, its worktree and its card, and shows the leader's tab when it was the selected one", async () => {
    await openSession(mixed());
    await card("batch-update").click();
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["batch-update", "web-update"]);
    expect(await textsOf("#formation-tabs-mates .formation-tab-close")).toEqual(["×", "×"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#formation-tabs-mates .formation-tab-close")].map((b) => b.getAttribute("aria-label")))).toEqual(["batch-update のタブを閉じる", "web-update のタブを閉じる"]);
    // The selected tab is hidden: the leader's tab is shown, and the child is not touched.
    await $('#formation-tabs-mates [data-hide="batch-update"]').click();
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["web-update"]);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    expect(await cardNames()).toEqual(["batch-update", "web-update", "e2e-check", "summary", "api-update"]);
    expect(await selectedCard()).toEqual([]);
    // A tab that is not the selected one is hidden and the selection stays.
    await card("batch-update").click();
    await $('#formation-tabs-mates [data-hide="web-update"]').click();
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["batch-update"]);
    await expect($('#formation-tabs-mates [data-child="batch-update"]')).toHaveAttribute("aria-selected", "true");
    // The card opens the tab again.
    await card("web-update").click();
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["batch-update", "web-update"]);
    expect(await callsOf("formation_close_child")).toEqual([]);
  });

  it("shows the terminal of the selected child under the tabs, in place of the leader's", async () => {
    await openSession(mixed());
    await expect($("#formation-teammate-term")).toBeDisplayed();
    await expect($("#formation-term")).not.toBeDisplayed();
    await expect($('#formation-tabs-mates [data-child="web-update"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "false");
    const [head, term, flow, orchestrator] = [await rectOf("#formation-head"), await rectOf("#formation-teammate-term"), await rectOf("#formation-flow"), await rectOf("#formation-orchestrator")];
    expect(head.bottom).toBeLessThanOrEqual(term.top + 1);
    expect(Math.abs(term.bottom - orchestrator.bottom)).toBeLessThan(1);
    expect(Math.abs(term.right - flow.left)).toBeLessThan(1);
    expect(term.right - term.left).toBeGreaterThan(200);
    // The terminal is under the tabs: nothing of it is in the right pane.
    expect(await browser.execute(() => document.getElementById("formation-flow")!.querySelectorAll(".orca-term-box").length)).toBe(0);
  });

  it("selects the leader's tab with its tab and with its card, and shows its terminal", async () => {
    await openSession(mixed());
    await expect($("#formation-teammate-term")).toBeDisplayed();
    await $("#formation-tab-leader-main").click();
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    expect(await pressed("#formation-flow-root")).toBe("true");
    // The card of a child brings its tab and its terminal back (the tab of the child is open), and the leader's card does the leader's.
    await card("batch-update").click();
    await expect($("#formation-teammate-term")).toBeDisplayed();
    await expect($("#formation-term")).not.toBeDisplayed();
    await expect($('#formation-tabs-mates [data-child="batch-update"]')).toHaveAttribute("aria-selected", "true");
    await $("#formation-flow-root").click();
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
  });

  it("selects a child with its tab, as with its card", async () => {
    await openSession(mixed());
    await card("batch-update").click();
    await $("#formation-tab-leader-main").click();
    await $('#formation-tabs-mates [data-child="batch-update"]').click();
    await expect($('#formation-tabs-mates [data-child="batch-update"]')).toHaveAttribute("aria-selected", "true");
    expect(await selectedCard()).toEqual(["batch-update"]);
    await mock("orca_terminal_read", ["$ npm test", "実行中"]);
    await browser.waitUntil(async () => (await screenText()).includes("実行中"));
    expect(await readHandles()).toEqual(["term_batch-update"]);
  });
});

describe("orchestration mode: the session of a child", () => {
  it("starts on the leader's tab with no tab of a child while a child waits, and has no 自動で追う", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    // A child waits, and the middle pane stays on the leader's tab, where the owner types: nothing is selected, no tab of a child is drawn, and no terminal is read.
    await browser.pause(WAIT * 2);
    expect(await selectedCard()).toEqual([]);
    expect(await count("#formation-tabs-mates .formation-tab")).toBe(0);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    // The heading has no button that follows a child.
    expect(await count("#formation-follow")).toBe(0);
  });

  it("forgets the tabs that were opened when another formation is opened", async () => {
    await openList({ formation_children: mixed() });
    await showDoneCards();
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await card("web-update").click();
    await expect($('#formation-tabs-mates [data-child="web-update"]')).toHaveAttribute("aria-selected", "true");
    await row("won-2485").click();
    await browser.pause(READ * 2);
    expect(await count("#formation-tabs-mates .formation-tab")).toBe(0);
    expect(await selectedCard()).toEqual([]);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the selection where it is while the states change, and opens a tab only for a press", async () => {
    await openSession([formationChild("a-update", "working"), formationChild("b-update", "waiting", { minutes: 1 }), formationChild("c-update", "waiting", { minutes: 9 })]);
    expect(await selectedCard()).toEqual(["c-update"]);
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["c-update"]);
    await mock("formation_children", [formationChild("a-update", "working"), formationChild("b-update", "working", { minutes: 1 }), formationChild("c-update", "working")]);
    await browser.waitUntil(async () => (await card("b-update").getAttribute("data-state")) === "working");
    expect(await selectedCard()).toEqual(["c-update"]);
    // A child that waits has no tab of its own that opens by itself.
    await mock("formation_children", [formationChild("a-update", "waiting", { minutes: 20 }), formationChild("b-update", "working"), formationChild("c-update", "working")]);
    await browser.waitUntil(async () => (await card("a-update").getAttribute("data-state")) === "waiting");
    await browser.pause(WAIT);
    expect(await selectedCard()).toEqual(["c-update"]);
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["c-update"]);
  });


  it("keeps the leader's tab when no child waits or works, and nothing was selected", async () => {
    await openSession([formationChild("p-update", "planned"), formationChild("a-update", "done"), formationChild("b-update", "done")]);
    expect(await selectedCard()).toEqual([]);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
  });

  it("selects a card that is pressed and opens its tab, and keeps the selection when another child waits", async () => {
    await openSession(mixed());
    await card("api-update").click();
    expect(await selectedCard()).toEqual(["api-update"]);
    await expect($('#formation-tabs-mates [data-child="api-update"]')).toHaveAttribute("aria-selected", "true");
    await expect(card("api-update")).toHaveAttribute("aria-pressed", "true");
    // Another child waits now: the selection stays.
    await mock("formation_children", [formationChild("api-update", "done"), formationChild("web-update", "working"), formationChild("batch-update", "waiting", { minutes: 3 })]);
    await browser.waitUntil(async () => (await card("batch-update").getAttribute("data-state")) === "waiting");
    await browser.pause(WAIT);
    expect(await selectedCard()).toEqual(["api-update"]);
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["web-update", "api-update"]);
  });


  it("selects nothing when the card of a child with no terminal is pressed", async () => {
    await openSession(mixed());
    await card("batch-update").click();
    expect(await selectedCard()).toEqual(["batch-update"]);
    await mock("formation_children", [...mixed().slice(0, 2), formationChild("batch-update", "working"), formationChild("closed-one", "done", { handle: null })]);
    await browser.waitUntil(async () => (await cardNames()).includes("closed-one"));
    await card("closed-one").click();
    expect(await selectedCard()).toEqual(["batch-update"]);
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["batch-update", "web-update"]);
  });

  it("keeps the focus on the card it was on when the cards are drawn again", async () => {
    await openSession(mixed());
    // The selection stays where it is while the states change.
    await browser.execute(() => document.querySelector<HTMLElement>('#formation-flow-list [data-child="batch-update"]')!.click());
    await browser.execute(() => document.querySelector<HTMLElement>('#formation-flow-list [data-child="batch-update"]')!.focus());
    await mock("formation_children", [...mixed().slice(0, 2), formationChild("batch-update", "waiting"), ...mixed().slice(3)]);
    await browser.waitUntil(async () => (await card("batch-update").getAttribute("data-state")) === "waiting");
    expect(await browser.execute(() => ({ inside: document.getElementById("formation-flow-list")!.contains(document.activeElement), child: (document.activeElement as HTMLElement).dataset.child }))).toEqual({ inside: true, child: "batch-update" });
  });

  it("mirrors the terminal of the selected child, and reads the one shown only", async () => {
    await openSession(mixed());
    const [first] = await waitForCalls("orca_terminal_read");
    expect(first).toEqual({ handle: "term_web-update" });
    await browser.waitUntil(async () => (await screenText()).includes("確認します"));
    await card("batch-update").click();
    await mock("orca_terminal_read", ["$ npm test", "実行中"]);
    await browser.waitUntil(async () => (await screenText()).includes("実行中"));
    expect(await readHandles()).toEqual(["term_batch-update"]);
    expect(await browser.execute(() => document.querySelectorAll("#formation-teammate-term .orca-term-box:not([hidden])").length)).toBe(1);
  });

  it("sends the keys typed in the terminal to its child through orca_terminal_input", async () => {
    await openSession(mixed());
    const input = await mock("orca_terminal_input", null);
    // The press is made in the page: the driver takes the focus to the button after its click, which a real press does before.
    await browser.execute(() => document.querySelector<HTMLElement>('#formation-flow-list [data-child="batch-update"]')!.click());
    // The press gives the terminal of the session the keyboard.
    expect(await browser.execute(() => document.getElementById("formation-teammate-term")!.contains(document.activeElement))).toBe(true);
    await browser.keys(["c", "d"]);
    await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => (c as { handle: string }).handle === "term_batch-update")).toBe(true);
  });

  it("mirrors a child of a saved environment that the Orca screen does not stream, reading and typing in that environment, and the one of this Mac as before", async () => {
    await openSession([formationChild("a-update", "working"), formationChild("lab-update", "waiting", { minutes: 3, environment: "mac-studio" })]);
    // The follow selects the child that waits: it runs in the saved environment.
    expect((await waitForCalls("orca_terminal_read"))[0]).toEqual({ handle: "term_lab-update", environment: "mac-studio" });
    await browser.waitUntil(async () => (await screenText()).includes("確認します"));
    const input = await mock("orca_terminal_input", null);
    await browser.execute(() => document.querySelector<HTMLElement>('#formation-flow-list [data-child="lab-update"]')!.click());
    await browser.keys(["c", "d"]);
    await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => (c as { handle: string; environment: string }).handle === "term_lab-update" && (c as { environment: string }).environment === "mac-studio")).toBe(true);
    // The child of this Mac names no environment.
    await card("a-update").click();
    await mock("orca_terminal_read", ["$ npm test"]);
    await browser.waitUntil(async () => (await readHandles()).join() === "term_a-update");
    expect((await callsOf("orca_terminal_read")).every((c) => JSON.stringify(c) === JSON.stringify({ handle: "term_a-update" }))).toBe(true);
  });

  // A-37, #839: a saved environment that the Orca screen streams (A-12) streams the terminals of its children.
  const STUDIO = { orca_overview: orcaOverview([orcaRow("api", "main", "Write the docs", { handle: null, paneKey: null })], [], { target: "Studio", environments: ["Studio"] }) };
  const studioChildren = () => [formationChild("a-update", "working"), formationChild("lab-update", "waiting", { minutes: 3, environment: "Studio" })];
  const openStudio = async (children: unknown = studioChildren()) => {
    await openSession(children, STUDIO);
    await waitForCalls("orca_stream_open");
  };
  const streamed = async (n = 1) => (await waitForCalls("orca_stream_terminal", n)) as { handle: string; generation: number; viewport: { cols: number; rows: number } }[];
  const closed = async (n = 1) => (await waitForCalls("orca_stream_terminal_close", n)) as { handle: string; generation: number }[];

  it("streams the terminal of a child of the saved environment that the Orca screen streams, with the size of the pane and its colors, and reads nothing", async () => {
    await openStudio();
    await sendStream(streamList([], []));
    const [call] = await streamed();
    expect(call.handle).toBe("term_lab-update");
    const host = await rectOf("#formation-teammate-term");
    expect(call.viewport.cols).toBeGreaterThan(10);
    expect(call.viewport.cols).toBeLessThan(Math.ceil(host.right - host.left));
    await sendTerm({ kind: "snapshot", data: "\x1b[31m$ claude\x1b[0m\r\n> 確認します", cols: 80, rows: 24 });
    await browser.waitUntil(async () => (await screenText()).includes("確認します"), { timeoutMsg: "the streamed screen never showed" });
    // The color of the stream is drawn (red is the color 1 of the palette).
    expect(await browser.execute(() => document.querySelectorAll("#formation-teammate-term .xterm-fg-1").length)).toBeGreaterThan(0);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
  });

  it("sends the keys typed in a streamed terminal through orca_stream_input", async () => {
    await openStudio();
    await streamed();
    const input = await mock("orca_stream_input", null);
    await browser.execute(() => document.querySelector<HTMLElement>('#formation-flow-list [data-child="lab-update"]')!.click());
    await browser.keys(["c", "d"]);
    await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => (c as { handle: string }).handle === "term_lab-update")).toBe(true);
    expect(await callsOf("orca_terminal_input")).toEqual([]);
  });

  it("closes the stream when another child is selected, mirrors the child of this Mac, and streams the first again when it is selected again", async () => {
    await openStudio();
    const [first] = await streamed();
    await card("a-update").click();
    expect(await closed()).toEqual([{ handle: "term_lab-update", generation: first.generation }]);
    // The child of this Mac is mirrored (its Orca does not stream), and no other stream is asked for.
    await mock("orca_terminal_read", ["$ npm test"]);
    await browser.waitUntil(async () => (await readHandles()).join() === "term_a-update");
    expect((await callsOf("orca_terminal_read")).every((c) => JSON.stringify(c) === JSON.stringify({ handle: "term_a-update" }))).toBe(true);
    expect(await callsOf("orca_stream_terminal")).toHaveLength(1);
    await card("lab-update").click();
    const [, second] = await streamed(2);
    expect(second.handle).toBe("term_lab-update");
    expect(second.generation).not.toBe(first.generation);
    // The mirror of the child of this Mac has stopped.
    await mock("orca_terminal_read", ["$"]);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
  });

  it("closes the stream when the mode is left, and streams again when it is shown", async () => {
    await openStudio();
    const [first] = await streamed();
    await $(PROJECT).click();
    expect(await closed()).toEqual([{ handle: "term_lab-update", generation: first.generation }]);
    await $(ROW("formation")).click();
    // The tabs are forgotten each time a formation is opened: the card of the child opens its tab again.
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    await card("lab-update").click();
    const [, second] = await streamed(2);
    expect(second.handle).toBe("term_lab-update");
    await $("#nav-mail").click();
    expect(await closed(2)).toEqual([
      { handle: "term_lab-update", generation: first.generation },
      { handle: "term_lab-update", generation: second.generation },
    ]);
  });

  it("closes the stream of a child that is gone from the list", async () => {
    await openStudio();
    const [first] = await streamed();
    await mock("formation_children", [formationChild("a-update", "working")]);
    expect(await closed()).toEqual([{ handle: "term_lab-update", generation: first.generation }]);
    // The selection is at the leader's tab: the next child is shown when its card is pressed.
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await mock("orca_terminal_read", ["$ next"]);
    await card("a-update").click();
    await browser.waitUntil(async () => (await readHandles()).join() === "term_a-update");
    expect(await callsOf("orca_stream_terminal")).toHaveLength(1);
  });

  it("closes the stream of a child of the formation that was shown when another formation is pressed", async () => {
    await openList({ formation_children: studioChildren(), ...timers({ formationFlow: READ, orcaMirror: MIRROR }), ...STUDIO });
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    await card("lab-update").click();
    await waitForCalls("orca_stream_open");
    const [first] = await streamed();
    await mock("formation_children", []);
    await row("won-2485").click();
    expect(await closed()).toEqual([{ handle: "term_lab-update", generation: first.generation }]);
  });

  it("keeps the keyboard in the leader's terminal when children start to work, and the press of a card gives it to the terminal of the child", async () => {
    await openSession([formationChild("a-update", "planned")]);
    await $("#formation-term .orca-term-box:not([hidden]) .xterm-screen").click();
    await mock("formation_children", [formationChild("a-update", "working"), formationChild("b-update", "working")]);
    await browser.waitUntil(async () => (await card("b-update").isExisting()) && (await card("a-update").getAttribute("data-state")) === "working");
    await browser.pause(WAIT);
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    expect(await selectedCard()).toEqual([]);
    expect(await browser.execute(() => document.getElementById("formation-teammate-term")!.contains(document.activeElement))).toBe(false);
    await browser.execute(() => document.querySelector<HTMLElement>('#formation-flow-list [data-child="b-update"]')!.click());
    expect(await browser.execute(() => document.getElementById("formation-teammate-term")!.contains(document.activeElement))).toBe(true);
  });

  it("stops reading the terminal of a child that is gone from the list, opens no other tab by itself, and reads the next one when its card is pressed", async () => {
    await openSession(mixed());
    await waitForCalls("orca_terminal_read");
    await mock("formation_children", [formationChild("batch-update", "working")]);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update");
    await mock("orca_terminal_read", ["$ next"]);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    await expect($("#formation-term")).toBeDisplayed();
    await card("batch-update").click();
    await browser.waitUntil(async () => (await readHandles()).join() === "term_batch-update");
    await browser.pause(MIRROR * 3);
    expect(await readHandles()).toEqual(["term_batch-update"]);
    // No child: no read at all.
    await mock("formation_children", []);
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    await expect($("#formation-term")).toBeDisplayed();
    await mock("orca_terminal_read", ["$ none"]);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
  });

  it("reads no terminal while the mode is left, and reads it again when the mode is shown", async () => {
    await openSession(mixed());
    await waitForCalls("orca_terminal_read");
    await $(PROJECT).click();
    await mock("orca_terminal_read", ["$"]);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    await $(ROW("formation")).click();
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await card("web-update").click();
    expect((await waitForCalls("orca_terminal_read"))[0]).toEqual({ handle: "term_web-update" });
    await $("#nav-mail").click();
    await mock("orca_terminal_read", ["$"]);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
  });

  it("brings the card of the child whose row of the list is pressed into the view of the tree", async () => {
    const names = Array.from({ length: 24 }, (_, i) => `child-${String(i).padStart(2, "0")}`);
    const many = names.map((n) => formationChild(n, "working", { minutes: 2 }));
    await openList({ formation_list: formationList([formationEntry("formation", { children: names.map((n) => listedChild(n, "working")) })]), formation_children: many, ...timers({ formationFlow: READ, orcaMirror: MIRROR }), orca_terminal_read: ["$ claude"] }, null);
    await $("#formation-list-feed .formation-row").click();
    await browser.waitUntil(async () => (await cardNames()).length === 24);
    // The last card is below the view while the tree is at its top, and no card is selected.
    const inView = () =>
      browser.execute(() => {
        const [body, card] = [document.getElementById("formation-flow-body")!.getBoundingClientRect(), document.querySelector('#formation-flow-list [data-child="child-23"]')!.getBoundingClientRect()];
        return card.top >= body.top - 1 && card.bottom <= body.bottom + 1;
      });
    expect(await selectedCard()).toEqual([]);
    expect(await inView()).toBe(false);
    await $('#formation-list-feed .formation-child[data-child="child-23"]').click();
    await expect($('#formation-flow-list [data-child="child-23"]')).toHaveAttribute("aria-pressed", "true");
    await browser.waitUntil(() => inView());
  });
});

// A-37: the list of the formations at the left, and the formation it selects.
const ROWS = "#formation-list-feed .formation-row";
const rowNames = () => textsOf(`${ROWS} .formation-row-name`);
const row = (name: string) => $(`${ROWS}[data-formation="${name}"]`);
const pressedRows = () => browser.execute((s) => [...document.querySelectorAll<HTMLElement>(`${s}[aria-pressed="true"]`)].map((e) => e.dataset.formation), ROWS);
// The name of the formation that is shown: the leader's card has it, which is drawn when the formation is selected (the pane is shown from the first child on).
const headName = () => browser.execute(() => document.querySelector("#formation-flow-root .formation-card-name")!.textContent);
const listed = () =>
  formationList([
    formationEntry("formation"),
    formationEntry("won-2485", { minutes: 12, repos: ["wonder-knowledge", "wonder-api"], counts: { planned: 3, waiting: 0, working: 1, done: 0 } }),
    formationEntry("mail-summary", { minutes: 90, repos: ["tsunagiai"], counts: { planned: 0, waiting: 1, working: 0, done: 2 } }),
  ]);

// A-37: the close of a child from its card.
describe("orchestration mode: close a child from its card", () => {
  const confirm = () => $('.pop[role="alertdialog"]');
  const yes = () => $('.pop[role="alertdialog"] .text-btn.danger');
  // The page's own right button on the card of `name`.
  const rightPress = (name: string) =>
    browser.execute(
      (n, once) => {
        if (!window.__e2e_once__(once)) return;
        const r = document.querySelector(`#formation-flow-list [data-name="${n}"]`)!.getBoundingClientRect();
        document.querySelector(`#formation-flow-list [data-name="${n}"] .formation-card`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 40, clientY: r.top + r.height / 2 }));
      },
      name,
      onceId(),
    );
  const without = (name: string) => mixed().filter((c) => c.name !== name);
  async function ask(name: string) {
    await rightPress(name);
    await $('.menu button[role="menuitem"]').click();
    await expect(confirm()).toBeDisplayed();
  }
  const gone = { closed: true, reason: null, changed: [], untracked: [], unpushed: [], path: "", environment: "", preservedBranch: null };
  const kept = { closed: false, path: "/w/web-update", environment: "local", preservedBranch: null, reason: "worktree にコミットしていない変更か、追跡していないファイルがあります。また、どのリモートにも届いていないコミットがあります", changed: [" M src/a.rb"], untracked: ["?? tmp/x.log", "?? tmp/y.log"], unpushed: ["abc1234 add a"] };

  it("opens a menu with 削除 alone on a right press of a card, a planned one too", async () => {
    await openSession(mixed());
    await rightPress("web-update");
    await expect($(".menu")).toBeDisplayed();
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["削除"]);
    await expect($('.menu button[role="menuitem"]')).toHaveElementClass("danger");
    expect(await count('.menu button[role="menuitem"] svg')).toBe(1);
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
    await rightPress("e2e-check");
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["削除"]);
  });

  it("asks first, with the name, and calls nothing on キャンセル", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child");
    await ask("web-update");
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("web-update を削除しますか？");
    await $('.pop[role="alertdialog"] .text-btn:not(.danger)').click();
    await expect(confirm()).not.toExist();
    expect(await callsOf(close)).toEqual([]);
    expect(await cardNames()).toHaveLength(5);
  });

  it("closes the child by its formation and name without force on 削除, and takes its card and its session away", async () => {
    await openSession(mixed());
    await waitForCalls("orca_terminal_read");
    expect(await readHandles()).toEqual(["term_web-update"]);
    const close = await mock("formation_close_child", gone);
    await mock("formation_children", without("web-update"));
    await ask("web-update");
    await yes().click();
    expect(await waitForCalls(close)).toEqual([{ formation: "formation", name: "web-update", force: false, path: null }]);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update,e2e-check,summary,api-update");
    await expect(confirm()).not.toExist();
    // The tab of the closed child is gone and the leader's tab is shown; the terminal of the closed one is read no more, and another child's is read when its card is pressed.
    expect(await count('#formation-tabs-mates [data-child="web-update"]')).toBe(0);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await mock("orca_terminal_read", ["$ next"]);
    await card("batch-update").click();
    await browser.waitUntil(async () => (await readHandles()).join() === "term_batch-update");
    await browser.pause(MIRROR * 3);
    expect(await readHandles()).toEqual(["term_batch-update"]);
  });

  it("says that a child in a folder tsunagiai did not make loses only its terminal, and closes it the same way", async () => {
    const folder = () => mixed().map((c) => (c.name === "web-update" ? { ...c, created: false } : c));
    await openSession(folder());
    const close = await mock("formation_close_child", gone);
    await mock("formation_children", folder().filter((c) => c.name !== "web-update"));
    await ask("web-update");
    await expect(confirm()).toHaveText(expect.stringContaining("ターミナルを閉じて、一覧から外します。フォルダ、worktree、ブランチは消しません。"));
    await expect(confirm()).not.toHaveText(expect.stringContaining("worktree とブランチを消します"));
    await yes().click();
    expect(await waitForCalls(close)).toEqual([{ formation: "formation", name: "web-update", force: false, path: null }]);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update,e2e-check,summary,api-update");
    await expect(confirm()).not.toExist();
    // A child that tsunagiai made has the words about the worktree and the branch.
    await ask("batch-update");
    await expect(confirm()).toHaveText(expect.stringContaining("worktree とブランチを消します。"));
  });

  it("closes a planned child the same way", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", gone);
    await mock("formation_children", without("summary"));
    await ask("summary");
    await yes().click();
    expect(await waitForCalls(close)).toEqual([{ formation: "formation", name: "summary", force: false, path: null }]);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update,web-update,e2e-check,api-update");
  });

  it("closes a done child with the × of its card, after the same confirmation, and takes its card and its tab away", async () => {
    await openSession(mixed());
    await card("api-update").click();
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["web-update", "api-update"]);
    const close = await mock("formation_close_child", gone);
    await mock("formation_children", without("api-update"));
    await $('#formation-flow-list [data-close="api-update"]').click();
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("api-update を削除しますか？");
    expect(await callsOf(close)).toEqual([]);
    await yes().click();
    expect(await waitForCalls(close)).toEqual([{ formation: "formation", name: "api-update", force: false, path: null }]);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update,web-update,e2e-check,summary");
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["web-update"]);
  });

  it("gives a tab only the × that hides it, and a card of a child that is not done has no × that deletes", async () => {
    await openSession(mixed());
    await card("api-update").click();
    expect(await count("#formation-tabs-mates [data-close]")).toBe(0);
    expect(await count("#formation-tabs-mates [data-hide]")).toBe(2);
    expect(await count('#formation-flow-list [data-close="web-update"]')).toBe(0);
    expect(await count('#formation-flow-list [data-close="api-update"]')).toBe(1);
    // Hiding the tab of the done child calls nothing and leaves its card.
    const close = await mock("formation_close_child", gone);
    await $('#formation-tabs-mates [data-hide="api-update"]').click();
    expect(await callsOf(close)).toEqual([]);
    expect(await count('#formation-flow-list [data-close="api-update"]')).toBe(1);
    expect(await cardNames()).toHaveLength(5);
  });

  it("asks for the force when git keeps the worktree of the child whose × of the card was pressed, and keeps the tab", async () => {
    await openSession(mixed());
    await card("api-update").click();
    const close = await mock("formation_close_child", kept);
    await $('#formation-flow-list [data-close="api-update"]').click();
    await yes().click();
    await waitForCalls(close);
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("api-update を削除できませんでした");
    await expect(yes()).toHaveText("強制削除");
    expect(await count('#formation-tabs-mates [data-child="api-update"]')).toBe(1);
    expect(await cardNames()).toHaveLength(5);
  });

  it("says why it was kept and what is lost, keeps the card, and calls nothing more on キャンセル", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", kept);
    await ask("web-update");
    await yes().click();
    await waitForCalls(close);
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("web-update を削除できませんでした");
    await expect(confirm()).toHaveText(expect.stringContaining(kept.reason));
    expect(await textsOf(".pop-lost-head")).toEqual(["変更のあるファイル", "追跡していないファイル", "どのリモートにもないコミット"]);
    // Git's lines as they are: the leading space of a status line stays in the text and on the screen.
    expect(await rawTextsOf(".pop-lost li")).toEqual([...kept.changed, ...kept.untracked, ...kept.unpushed]);
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".pop-lost li")!).whiteSpace)).toBe("pre-wrap");
    // Where the worktree is, which a force sends back.
    expect(await textsOf(".pop-lost-place")).toEqual(["この Mac: /w/web-update"]);
    await expect(yes()).toHaveText("強制削除");
    expect(await cardNames()).toHaveLength(5);
    await $('.pop[role="alertdialog"] .text-btn:not(.danger)').click();
    await expect(confirm()).not.toExist();
    expect(await callsOf(close)).toHaveLength(1);
    expect(await cardNames()).toHaveLength(5);
  });

  it("draws no head for a kind of file that git did not list", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", { ...kept, changed: [], unpushed: [] });
    await ask("web-update");
    await yes().click();
    await waitForCalls(close);
    expect(await textsOf(".pop-lost-head")).toEqual(["追跡していないファイル"]);
  });

  it("tells the branch that Orca kept when the worktree is closed, and drops the words at the next close", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", { ...gone, preservedBranch: "me/web-update" });
    await mock("formation_children", without("web-update"));
    await ask("web-update");
    await yes().click();
    await waitForCalls(close);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update,e2e-check,summary,api-update");
    await expect($("#formation-flow-error")).toHaveText(expect.stringContaining("「web-update」のブランチは、どのリモートにもないコミットがあるので、ローカルに残しました（me/web-update）"));
    await mock("formation_close_child", gone);
    await ask("summary");
    await yes().click();
    // `mock` set the calls back to none, so the second close is the first call of the new mock.
    await waitForCalls(close);
    await expect($("#formation-flow-error")).not.toBeDisplayed();
  });

  it("closes it with force on 強制削除, and takes the card away", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", kept);
    await ask("web-update");
    await yes().click();
    await waitForCalls(close);
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("web-update を削除できませんでした");
    await mock("formation_close_child", gone);
    await mock("formation_children", without("web-update"));
    await yes().click();
    expect(await waitForCalls(close)).toEqual([{ formation: "formation", name: "web-update", force: true, path: "/w/web-update" }]);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update,e2e-check,summary,api-update");
    await expect(confirm()).not.toExist();
  });

  it("shows the message of a failure where a failed read shows it, and keeps the cards", async () => {
    await openSession(mixed());
    const message = "子「web-update」の記録の worktree は、orca worktree ps に載っていません";
    const close = await mock("formation_close_child", rejects(message));
    await ask("web-update");
    await yes().click();
    await waitForCalls(close);
    await expect($("#formation-flow-error")).toHaveText(message);
    await expect(confirm()).not.toExist();
    expect(await cardNames()).toHaveLength(5);
    // The words go at the next read that works.
    await expect($("#formation-flow-error")).not.toBeDisplayed();
  });

  it("closes one child once while it is on its way, and marks its card busy", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", holds);
    await ask("web-update");
    await yes().click();
    await waitForCalls(close);
    await expect(card("web-update")).toHaveAttribute("aria-busy", "true");
    await rightPress("web-update");
    await browser.pause(200);
    await expect($(".menu")).not.toExist();
    expect(await callsOf(close)).toHaveLength(1);
    await mock("formation_children", without("web-update"));
    await release("formation_close_child", gone);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update,e2e-check,summary,api-update");
  });
});

// The list with a formation, `api-work`, whose name sorts before `formation`: no row is selected when the shown one goes, not the first row.
const listedFirst = () => formationList([formationEntry("api-work", { minutes: 3 }), ...listed().formations]);

async function openList(extra: Record<string, unknown> = {}, select: string | null = "formation") {
  await boot({ inbox: inbox(), orca_overview: ORCA_LIST(), formation_list: listed(), ...timers({ formationFlow: READ }), ...extra });
  await openFormation(null);
  const rows = ((extra.formation_list as FormationList | undefined) ?? listed()).formations.length;
  await browser.waitUntil(async () => (await rowNames()).length === rows);
  if (select !== null) await row(select).click();
}

describe("orchestration mode: the list of the formations", () => {
  it("heads the formations with フォーメーション in the list of the Orca screen, and the button that makes one is in its header", async () => {
    await openList();
    await expect($("#orca-formations h2")).toHaveText("フォーメーション");
    await expect($("#formation-new")).toHaveAttribute("aria-label", "フォーメーションを作る");
    expect(await textsOf("#formation-new")).toEqual([""]);
    expect(await count("#formation-new svg")).toBe(1);
    const place = await browser.execute(() => {
      const [head, button, add] = ["orca-header", "formation-new", "orca-add"].map((id) => document.getElementById(id)!.getBoundingClientRect());
      return { right: head.right - add.right < 16, inside: button.top >= head.top && button.bottom <= head.bottom, beside: button.right <= add.left };
    });
    expect(place).toEqual({ right: true, inside: true, beside: true });
  });

  it("draws a row for each formation, in the order given, with a gray ring and the name alone", async () => {
    await openList();
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
    // Nothing but the name: no time, no count of the children and no project.
    expect(await textsOf(ROWS)).toEqual(["formation", "won-2485", "mail-summary"]);
    expect(await count(".formation-row-time, .formation-row-count, .formation-row-projects, .formation-row-project")).toBe(0);
    expect(await count(`${ROWS} .formation-row-dot`)).toBe(3);
    // The ring is gray and hollow.
    expect(await browser.execute(() => {
      const style = getComputedStyle(document.querySelector(".formation-row-dot")!);
      return { background: style.backgroundColor, ringed: Number.parseFloat(style.borderTopWidth) >= 1, radius: style.borderTopLeftRadius };
    })).toEqual({ background: "rgba(0, 0, 0, 0)", ringed: true, radius: "50%" });
  });

  it("fills the ring orange and puts 入力待ち at the right of the row whose leader waits for input, and takes both off when it does not wait any more", async () => {
    const waitingList = (waiting: boolean) => formationList([formationEntry("formation"), formationEntry("won-2485", { minutes: 12, repos: ["wonder-api"], waiting }), formationEntry("mail-summary", { minutes: 90 })]);
    await openList({ formation_list: waitingList(true) }, null);
    const mark = () =>
      browser.execute((s) => {
        const text = (e: Element | null) => e?.textContent ?? null;
        const style = (name: string) => {
          const dot = document.querySelector(`${s}[data-formation="${name}"] .formation-row-dot`)!;
          const look = getComputedStyle(dot);
          return { filled: look.backgroundColor !== "rgba(0, 0, 0, 0)", halo: look.boxShadow !== "none", radius: look.borderTopLeftRadius };
        };
        return { labels: [...document.querySelectorAll(s)].map((e) => text(e.querySelector(".formation-row-waiting"))), waiting: style("won-2485"), idle: style("formation") };
      }, ROWS);
    expect(await mark()).toEqual({
      labels: [null, "入力待ち", null],
      waiting: { filled: true, halo: true, radius: "50%" },
      idle: { filled: false, halo: false, radius: "50%" },
    });
    // The label is at the right end of the row, and the name stays at the left.
    const place = await browser.execute((s) => {
      const r = document.querySelector(`${s}[data-formation="won-2485"]`)!.getBoundingClientRect();
      const label = document.querySelector(`${s}[data-formation="won-2485"] .formation-row-waiting`)!.getBoundingClientRect();
      const name = document.querySelector(`${s}[data-formation="won-2485"] .formation-row-name`)!.getBoundingClientRect();
      return { right: r.right - label.right < 16, beside: name.right <= label.left };
    }, ROWS);
    expect(place).toEqual({ right: true, beside: true });
    await mock("formation_list", waitingList(false));
    await browser.waitUntil(async () => (await mark()).labels.join() === ",,");
    expect(await mark()).toMatchObject({ waiting: { filled: false, halo: false } });
    // The row of a leader that waits shows nothing else.
    await mock("formation_list", waitingList(true));
    await browser.waitUntil(async () => (await mark()).labels[1] === "入力待ち");
  });

  it("draws 判断待ち on the row of a child that a decision page waits for, in the color of an approval that waits, and on the row of its formation, and takes both off when the page is answered", async () => {
    const pageList = (awaiting: boolean) =>
      formationList([
        formationEntry("formation"),
        formationEntry("won-2485", {
          awaitingPage: awaiting,
          children: [listedChild("auth-api", "working"), listedChild("req-login", "done", { awaitingPage: awaiting }), listedChild("old-stop", "done", { terminal: false, awaitingPage: awaiting })],
          counts: { planned: 0, waiting: 0, working: 1, done: 2 },
        }),
      ]);
    await openList({ formation_list: pageList(true) }, null);
    const look = () =>
      browser.execute(() => {
        const text = (e: Element | null) => e?.textContent ?? null;
        const row = document.querySelector('#formation-list-feed .formation-row[data-formation="won-2485"]') as HTMLElement;
        const children = [...document.querySelectorAll<HTMLElement>(".formation-child")].map((e) => {
          const icon = e.querySelector<HTMLElement>(".orca-ic")!;
          return { name: e.dataset.child, state: e.dataset.state, status: icon.dataset.status, label: icon.getAttribute("aria-label"), tag: text(e.querySelector(".formation-row-waiting")), color: getComputedStyle(e.querySelector(".formation-row-waiting") ?? e).color };
        });
        return { row: { waiting: row.dataset.waiting ?? null, tag: text(row.querySelector(".formation-row-waiting")) }, children, done: text(document.querySelector(".formation-done-count")), others: text(document.querySelector('.formation-row[data-formation="formation"] .formation-row-waiting')) };
      });
    const shown = await look();
    expect(shown.row).toEqual({ waiting: "true", tag: "判断待ち" });
    expect(shown.others).toBeNull();
    // A done child that a page waits for, with or without its terminal, is drawn as a waiting one and is not one of the done.
    expect(shown.children.map(({ name, state, status, label, tag }) => [name, state, status, label, tag])).toEqual([
      ["auth-api", "working", "working", "作業中", null],
      ["req-login", "waiting", "question", "判断待ち", "判断待ち"],
      ["old-stop", "waiting", "question", "判断待ち", "判断待ち"],
    ]);
    expect(shown.done).toBeNull();
    // The label has the color of the label 入力待ち.
    expect(shown.children[1].color).toBe(shown.children[2].color);
    await mock("formation_list", pageList(false));
    await browser.waitUntil(async () => (await look()).row.tag === null);
    const answered = await look();
    expect(answered.children.map(({ name, state, tag }) => [name, state, tag])).toEqual([
      ["auth-api", "working", null],
      ["req-login", "standby", null],
    ]);
    expect(answered.done).toBe("完了 2");
  });

  it("puts 入力待ち before 判断待ち on a row whose leader waits and that has a child that a page waits for", async () => {
    await openList({ formation_list: formationList([formationEntry("formation", { waiting: true, awaitingPage: true, children: [listedChild("req-login", "done", { awaitingPage: true })] })]) }, null);
    expect(await textsOf(`${ROWS} .formation-row-waiting`)).toEqual(["入力待ち"]);
    expect(await textsOf(".formation-child .formation-row-waiting")).toEqual(["判断待ち"]);
  });

  it("marks the leader's tab with the dot of a waiting teammate while the shown formation's leader waits, and not otherwise", async () => {
    const waitingList = (waiting: boolean) => formationList([formationEntry("formation", { waiting }), formationEntry("won-2485", { waiting: !waiting })]);
    await openList({ formation_list: waitingList(true) });
    const tab = () =>
      browser.execute(() => {
        const mark = document.getElementById("formation-tab-leader-mark")!;
        return { state: document.getElementById("formation-tab-leader")!.dataset.state, shown: !mark.hidden, text: mark.textContent, color: getComputedStyle(mark).color };
      });
    const orange = await browser.execute(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--agent-question)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(await tab()).toEqual({ state: "waiting", shown: true, text: "●", color: orange });
    // The row of another formation that waits does not mark this tab.
    await mock("formation_list", waitingList(false));
    await browser.waitUntil(async () => (await tab()).state === "");
    expect(await tab()).toMatchObject({ shown: false });
    await mock("formation_list", waitingList(true));
    await browser.waitUntil(async () => (await tab()).state === "waiting");
  });

  it("selects nothing at the start, shows the work pane of Orca and starts and reads nothing", async () => {
    await openList({ formation_children: mixed() }, null);
    expect(await pressedRows()).toEqual([]);
    await expect($("#orca-formations")).toBeDisplayed();
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-flow")).not.toBeDisplayed();
    await browser.pause(READ * 2);
    expect(await starts()).toBe(0);
    expect(await callsOf("formation_children")).toEqual([]);
  });

  it("selects the formation that is pressed, and reads its children and starts its orchestrator", async () => {
    await openList();
    expect(await pressedRows()).toEqual(["formation"]);
    expect((await waitForCalls("formation_children", 1))[0]).toEqual({ name: "formation" });
    expect(await headName()).toBe("formation");
    expect(await textsOf("#formation-flow-root .formation-card-name")).toEqual(["formation"]);
    expect((await waitForCalls("claude_code_start", 1))[0]).toMatchObject({ id: "formation:formation" });
    await expect($("#formation-orchestrator")).toBeDisplayed();
  });

  it("shows the heading alone when the list is empty", async () => {
    await openList({ formation_list: formationList([]) }, null);
    await expect($("#formation-new")).toBeDisplayed();
    await expect($("#orca-formations h2")).toHaveText("フォーメーション");
    expect(await rowNames()).toEqual([]);
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-flow")).not.toBeDisplayed();
    await browser.pause(READ * 2);
    expect(await starts()).toBe(0);
    expect(await callsOf("formation_children")).toEqual([]);
    expect(await textsOf("#formation-list-feed")).toEqual([""]);
  });

  it("shows the orchestrator and the flow of the formation that is pressed, and ends no process", async () => {
    await openList();
    await waitForStarts(1);
    await sendClaudeCode({ kind: "output", data: "first formation" });
    await browser.waitUntil(async () => (await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).includes("first formation"));
    await mock("formation_children", [formationChild("api-update", "working")]);
    await row("won-2485").click();
    expect(await pressedRows()).toEqual(["won-2485"]);
    await waitForStarts(2);
    expect(await callsOf("claude_code_start")).toMatchObject([{ id: "formation:formation", builtinTools: true }, { id: "formation:won-2485", builtinTools: true, skill: null }]);
    expect(await headName()).toBe("won-2485");
    expect(await textsOf("#formation-flow-root .formation-card-name")).toEqual(["won-2485"]);
    // The other formation's screen is not drawn, and its process is not ended.
    expect(await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).not.toContain("first formation");
    expect(await callsOf("claude_code_close")).toEqual([]);
    await browser.waitUntil(async () => (await callsOf("formation_children")).some((c) => (c as { name: string }).name === "won-2485"));
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update");
    // Pressed again, the first formation is drawn as it was and starts nothing.
    await row("formation").click();
    await browser.waitUntil(async () => (await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).includes("first formation"));
    await browser.pause(300);
    expect(await starts()).toBe(2);
    expect(await headName()).toBe("formation");
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("reads the children of the shown formation only", async () => {
    await openList();
    await waitForCalls("formation_children", 1);
    await row("mail-summary").click();
    await mock("formation_children", []);
    await waitForCalls("formation_children", 3);
    expect([...new Set((await callsOf("formation_children")).map((c) => (c as { name: string }).name))]).toEqual(["mail-summary"]);
  });

  it("drops the children of the last formation when another is pressed, and an answer of the last one that comes late", async () => {
    await openList({ formation_children: mixed() });
    await showDoneCards();
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await mock("formation_children", holds);
    await waitForCalls("formation_children", 1);
    await row("won-2485").click();
    // The cards go at once, before the read of the new formation answers; the pane keeps the leader's card, with the name of the new formation.
    await expect($("#formation-flow")).toBeDisplayed();
    expect(await headName()).toBe("won-2485");
    expect(await cardNames()).toEqual([]);
    // The new formation is read when the read of the last one has ended, not beside it: Orca is not asked twice at once.
    await browser.pause(READ * 2);
    expect(await callsOf("formation_children")).toHaveLength(1);
    // The answer of the read of the first formation is dropped, and the new formation is read at once.
    await release("formation_children", mixed());
    await browser.waitUntil(async () => {
      const calls = await callsOf("formation_children");
      return calls.length === 2 && (calls[1] as { name: string }).name === "won-2485";
    });
    expect(await cardNames()).toEqual([]);
    expect(await headName()).toBe("won-2485");
    // The read of the new formation is answered, and its children are drawn.
    await mock("formation_children", [formationChild("api-update", "working")]);
    await release("formation_children", [formationChild("api-update", "working")]);
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update");
  });

  it("selects nothing when the one that is shown leaves the list, and reads no children", async () => {
    await openList({ formation_list: listedFirst() });
    await row("mail-summary").click();
    await waitForStarts(2);
    await mock("formation_list", formationList([formationEntry("api-work", { minutes: 3 }), formationEntry("formation")]));
    await browser.waitUntil(async () => (await rowNames()).join() === "api-work,formation");
    expect(await pressedRows()).toEqual([]);
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-flow")).not.toBeDisplayed();
    await mock("formation_children", []);
    const before = (await callsOf("formation_children")).length;
    await browser.pause(READ * 3);
    expect((await callsOf("formation_children")).length).toBe(before);
    expect(await starts()).toBe(2);
  });

  it("reads the list for its rows while the development screen is shown, and reads it no more once the screen is left", async () => {
    await boot({ inbox: inbox(), orca_overview: ORCA_LIST(), formation_list: listed(), ...timers({ formationFlow: READ, orcaClock: READ }) });
    await $("#nav-orca").click();
    // No formation is selected: the rows are drawn from the first read, and no children are read.
    await browser.waitUntil(async () => (await rowNames()).length === 3);
    expect(await callsOf("formation_children")).toEqual([]);
    await $(PROJECT).click();
    await $(ROW("formation")).click();
    await $("#nav-mail").click();
    const afterScreen = (await callsOf("formation_list")).length;
    await browser.pause(WAIT * 2);
    expect((await callsOf("formation_list")).length).toBe(afterScreen);
  });

  it("says that a read of the list failed, and keeps the rows", async () => {
    await openList();
    await expect($("#formation-list-error")).not.toBeDisplayed();
    await mock("formation_list", rejects("一覧を読めません"));
    await expect($("#formation-list-error")).toHaveText("一覧を読めません");
    expect((await rowNames()).length).toBe(3);
    await mock("formation_list", formationList(listed().formations, "Orca に届きません"));
    await expect($("#formation-list-error")).toHaveText("Orca に届きません");
    await mock("formation_list", listed());
    await expect($("#formation-list-error")).not.toBeDisplayed();
  });

  it("has the divider of the Orca list for the formations too, at 19% of the screen at first", async () => {
    await openList();
    const share = () => browser.execute(() => document.getElementById("orca-list")!.getBoundingClientRect().width / document.getElementById("orca")!.getBoundingClientRect().width);
    const split = $("#orca-split");
    await expect(split).toHaveAttribute("role", "separator");
    await expect(split).toHaveAttribute("aria-valuemin", "15");
    await expect(split).toHaveAttribute("aria-valuemax", "50");
    await expect(split).toHaveAttribute("aria-valuenow", "19");
    expect(await share()).toBeCloseTo(0.19, 2);
    await browser.execute((id, k) => window.__e2e_once__(id) && document.getElementById("orca-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })), onceId(), "ArrowRight");
    await expect(split).toHaveAttribute("aria-valuenow", "21");
    expect(await share()).toBeCloseTo(0.21, 2);
  });
});

// A-37 (#823): the dialog that makes a formation.
describe("orchestration mode: the dialog that makes a formation", () => {
  const ENVIRONMENTS = () => formationEnvironments(["wonder-knowledge", "wonder-api", "tsunagiai"], { "dev-server": ["wonder-api"] });
  const dialog = () => $('.formation-new-pop:not(.formation-consent-pop)[role="dialog"]');
  const nameField = () => $('.formation-new-pop input[aria-label="名前"]');
  const filterField = () => $('.formation-new-pop input[aria-label="プロジェクトを絞り込む"]');
  const makeButton = () => $(".formation-new-actions .text-btn.primary");
  const repos = () => textsOf(".formation-new-repo");
  const checked = () => browser.execute(() => [...document.querySelectorAll<HTMLInputElement>(".formation-new-repo input")].map((b) => b.checked));
  // The page's own press: the driver's click takes the focus to the button after the handler, which a real press does not.
  const pressNew = () => browser.execute(() => document.getElementById("formation-new")!.click());
  async function ask(extra: Record<string, unknown> = {}) {
    await openList({ formation_environments: ENVIRONMENTS(), formation_consents: [formationConsent("dev-server")], ...extra });
    await pressNew();
    await expect(dialog()).toBeDisplayed();
    await browser.waitUntil(async () => (await repos()).length > 0);
  }
  // Presses the box of the n-th repository among all the rows of the list (the headers are not rows), in the page.
  const pick = (index: number) => browser.execute((i) => document.querySelectorAll<HTMLInputElement>(".formation-new-repo input")[i].click(), index);

  it("opens under the plus with a field for the name, a field that narrows the projects, the environments with their repositories as unchecked boxes, and the two buttons", async () => {
    await ask();
    await expect(nameField()).toBeFocused();
    expect(await textsOf(".formation-new-field > span")).toEqual(["名前", "プロジェクト"]);
    expect(await textsOf(".formation-new-env")).toEqual(["この Mac", "dev-server"]);
    expect(await repos()).toEqual(["wonder-knowledge", "wonder-api", "tsunagiai", "wonder-api"]);
    expect(await checked()).toEqual([false, false, false, false]);
    expect(await textsOf(".formation-new-actions button")).toEqual(["キャンセル", "作成"]);
    // The box is 16px square, and the row is at least 32px high with 10px between the box and the name (#886).
    const box = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>(".formation-new-repo")!;
      const [b, name] = [row.querySelector("input")!.getBoundingClientRect(), row.querySelector("span")!.getBoundingClientRect()];
      return { width: b.width, height: b.height, row: row.getBoundingClientRect().height >= 32, gap: Math.round(name.left - b.right) };
    });
    expect(box).toEqual({ width: 16, height: 16, row: true, gap: 10 });
    // No placeholder and no line of help.
    expect(await count(".formation-new-pop [placeholder]")).toBe(0);
    expect(await count(".formation-new-pop p:not(.formation-new-env)")).toBe(0);
    const where = await browser.execute(() => {
      const [p, b] = [document.querySelector(".formation-new-pop")!.getBoundingClientRect(), document.getElementById("formation-new")!.getBoundingClientRect()];
      return { belowPlus: p.top >= b.bottom, inside: p.right <= innerWidth && p.left >= 0 && p.bottom <= innerHeight };
    });
    expect(where).toEqual({ belowPlus: true, inside: true });
    // The environments are read once, and nothing is made until it is asked.
    expect(await callsOf("formation_environments")).toHaveLength(1);
    expect(await callsOf("formation_create")).toEqual([]);
  });

  it("narrows the repositories by the text of the filter, and hides the environment that has none left", async () => {
    await ask();
    await filterField().setValue("TSUNA");
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".formation-new-repo")].filter((e) => !e.hidden).map((e) => e.textContent))).toEqual(["tsunagiai"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".formation-new-env")].filter((e) => !e.hidden).map((e) => e.textContent))).toEqual(["この Mac"]);
    await filterField().setValue("");
    expect(await browser.execute(() => document.querySelectorAll(".formation-new-repo:not([hidden])").length)).toBe(4);
  });

  it("scrolls the list to its top when the filter is typed in or emptied, so that the rows that match are seen from the first (#942)", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `repo-${String(i).padStart(2, "0")}`);
    await ask({ formation_environments: formationEnvironments([...many, "tsunagiai"]) });
    const scrollTop = () => browser.execute(() => document.querySelector<HTMLElement>(".formation-new-list")!.scrollTop);
    const scrollDown = () =>
      browser.execute(() => {
        const l = document.querySelector<HTMLElement>(".formation-new-list")!;
        l.scrollTop = l.scrollHeight;
      });
    await scrollDown();
    expect(await scrollTop()).toBeGreaterThan(0);
    await filterField().setValue("tsuna");
    expect(await scrollTop()).toBe(0);
    // The row that matches is inside the box of the list.
    expect(
      await browser.execute(() => {
        const [l, r] = [document.querySelector(".formation-new-list")!.getBoundingClientRect(), document.querySelector<HTMLElement>(".formation-new-repo:not([hidden])")!.getBoundingClientRect()];
        return r.top >= l.top && r.bottom <= l.bottom;
      }),
    ).toBe(true);
    // Emptied, the list is at its top too.
    await filterField().setValue("");
    await scrollDown();
    expect(await scrollTop()).toBeGreaterThan(0);
    await filterField().setValue("repo-1");
    expect(await scrollTop()).toBe(0);
  });

  it("shows no heading for an environment with no repository, and none for one that could not be read", async () => {
    await ask({ formation_environments: formationEnvironments([], { "dev-server": ["wonder-api"], "empty-server": [] }, { "down-server": "届きません" }) });
    expect(await textsOf(".formation-new-env:not([hidden])")).toEqual(["dev-server"]);
    expect(await count(".formation-new-note")).toBe(0);
    expect(await repos()).toEqual(["wonder-api"]);
  });

  it("makes the formation with the name typed and the projects checked, in the order of the lists, and selects it so that its orchestrator starts", async () => {
    await ask();
    const create = await mock("formation_create", formationEntry("mail-api", { minutes: 0, repos: ["wonder-knowledge", "wonder-api"] }));
    await mock("formation_list", formationList([...listed().formations, formationEntry("mail-api", { minutes: 0, repos: ["wonder-knowledge", "wonder-api"] })]));
    await browser.keys("mail-api");
    // Chosen out of order: the call keeps the order of the lists.
    await pick(3);
    await pick(0);
    await makeButton().click();
    expect(await waitForCalls(create)).toEqual([{ name: "mail-api", projects: [{ environment: "local", repo: "wonder-knowledge" }, { environment: "dev-server", repo: "wonder-api" }] }]);
    await expect(dialog()).not.toExist();
    await browser.waitUntil(async () => (await pressedRows()).join() === "mail-api");
    expect(await rowNames()).toContain("mail-api");
    expect(await headName()).toBe("mail-api");
    await browser.waitUntil(async () => (await callsOf("claude_code_start")).some((c) => (c as { id: string }).id === "formation:mail-api"));
    await browser.waitUntil(async () => (await callsOf("formation_children")).some((c) => (c as { name: string }).name === "mail-api"));
    await expect($(CARDS)).not.toExist();
    // The projects are of two environments: Rust refuses that mix with its own reason, so no consent is asked for it.
    expect(await callsOf("formation_consents")).toEqual([]);
    expect(await callsOf("formation_consent")).toEqual([]);
  });

  it("asks Rust for the consents when the projects are of one saved environment, and makes the formation with no dialog when that PC has the consent", async () => {
    await ask();
    const create = await mock("formation_create", formationEntry("mail-api", { minutes: 0, environment: "dev-server", projects: [{ environment: "dev-server", repo: "wonder-api" }] }));
    const consent = await mock("formation_consent", formationConsent("dev-server"));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    expect(await waitForCalls(create)).toEqual([{ name: "mail-api", projects: [{ environment: "dev-server", repo: "wonder-api" }] }]);
    // Once for the dialog that makes the formation, and once when the new formation's orchestrator starts.
    expect(await callsOf("formation_consents")).toHaveLength(2);
    expect(await callsOf(consent)).toEqual([]);
    await expect($(".formation-consent-pop")).not.toExist();
  });

  it("makes it on Enter in the name field, with no project when none is checked", async () => {
    await ask();
    const create = await mock("formation_create", formationEntry("solo", { minutes: 0 }));
    await mock("formation_list", formationList([...listed().formations, formationEntry("solo", { minutes: 0 })]));
    await browser.keys("solo");
    await browser.keys("Enter");
    expect(await waitForCalls(create)).toEqual([{ name: "solo", projects: [] }]);
    // This Mac needs no consent: it is not asked.
    expect(await callsOf("formation_consents")).toEqual([]);
    await expect(dialog()).not.toExist();
    await browser.waitUntil(async () => (await pressedRows()).join() === "solo");
  });

  it("sends the name as typed, and sends nothing for an empty name", async () => {
    await ask();
    const create = await mock("formation_create", formationEntry("x", { minutes: 0 }));
    await makeButton().click();
    await browser.keys("Enter");
    await browser.pause(300);
    expect(await callsOf(create)).toEqual([]);
    await expect(dialog()).toBeDisplayed();
    await nameField().setValue(" Bad Name");
    await makeButton().click();
    expect((await waitForCalls(create))[0]).toMatchObject({ name: " Bad Name" });
  });

  it("shows the words of a failed creation on a card, and keeps the dialog with what was typed", async () => {
    await ask();
    await mock("formation_create", rejects("名前は、先頭が小文字の英数字で、小文字の英数字とハイフンだけの 40 文字までにしてください"));
    await browser.keys("Bad Name");
    await pick(1);
    await makeButton().click();
    await expect($(CARD)).toHaveText("名前は、先頭が小文字の英数字で、小文字の英数字とハイフンだけの 40 文字までにしてください");
    await expect(dialog()).toBeDisplayed();
    await expect(nameField()).toHaveValue("Bad Name");
    expect(await checked()).toEqual([false, true, false, false]);
    await expect(makeButton()).toBeEnabled();
    // The formation is not made, so none is selected in its place.
    expect(await pressedRows()).toEqual(["formation"]);
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
  });

  it("keeps the card of a failed creation when the name is corrected and the formation is made", async () => {
    await ask();
    await mock("formation_create", rejects("名前は、先頭が小文字の英数字で、小文字の英数字とハイフンだけの 40 文字までにしてください"));
    await browser.keys("Bad Name");
    await pick(1);
    await makeButton().click();
    await expect($(CARDS)).toBeDisplayed();
    const create = await mock("formation_create", formationEntry("bad-name", { minutes: 0 }));
    await mock("formation_list", formationList([...listed().formations, formationEntry("bad-name", { minutes: 0 })]));
    await nameField().setValue("bad-name");
    await makeButton().click();
    await waitForCalls(create);
    await expect($(CARDS)).toBeDisplayed();
    await expect(dialog()).not.toExist();
    await browser.waitUntil(async () => (await pressedRows()).join() === "bad-name");
  });

  it("keeps the card of a failed creation when the dialog is cancelled and opened again", async () => {
    await ask();
    await mock("formation_create", rejects("名前は、先頭が小文字の英数字で、小文字の英数字とハイフンだけの 40 文字までにしてください"));
    await browser.keys("Bad Name");
    await makeButton().click();
    await expect($(CARDS)).toBeDisplayed();
    await $(".formation-new-actions .text-btn:not(.primary)").click();
    await expect(dialog()).not.toExist();
    await pressNew();
    await expect(dialog()).toBeDisplayed();
    await expect($(CARDS)).toBeDisplayed();
  });

  it("keeps the card of a failed read of the environments when the dialog is opened again", async () => {
    await openList({ formation_environments: rejects("Orca に届きません") });
    await pressNew();
    await expect($(CARD)).toHaveText("Orca に届きません");
    await mock("formation_environments", ENVIRONMENTS());
    await pressNew();
    await expect(dialog()).toBeDisplayed();
    await browser.waitUntil(async () => (await repos()).length > 0);
    await expect($(CARDS)).toBeDisplayed();
  });

  it("shows the refusal of projects of two environments on a card, and makes no formation", async () => {
    await ask();
    const reason = "フォーメーションは一つの PC に属します。環境「local」と環境「dev-server」にまたがるプロジェクトは入れられません（リーダーと子が別の PC にいると、SendMessage が届かないためです）";
    const create = await mock("formation_create", rejects(reason));
    await browser.keys("mail-api");
    await pick(0);
    await pick(3);
    await makeButton().click();
    expect(await waitForCalls(create)).toEqual([{ name: "mail-api", projects: [{ environment: "local", repo: "wonder-knowledge" }, { environment: "dev-server", repo: "wonder-api" }] }]);
    await expect($(CARD)).toHaveText(reason);
    await expect(dialog()).toBeDisplayed();
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
  });

  // A-37 (#893): the project of a saved environment whose PC has no consent asks for it before the formation is made.
  const consentDialog = () => $('.formation-consent-pop[role="dialog"]');
  const agreeButton = () => $(".formation-consent-pop .text-btn.primary");
  const declineButton = () => $(".formation-consent-pop .text-btn:not(.primary)");

  it("asks for the consent of the PC before it makes a formation of its project, saying what is put there, and makes nothing yet", async () => {
    await ask({ formation_consents: [] });
    const create = await mock("formation_create", formationEntry("mail-api", { minutes: 0 }));
    const consent = await mock("formation_consent", formationConsent("dev-server"));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await expect(consentDialog()).toBeDisplayed();
    // It takes the place of the dialog that makes a formation.
    await expect(dialog()).not.toExist();
    await expect($(".formation-consent-pop h3")).toHaveText("「dev-server」に tsunagiai-mcp を置きますか？");
    expect(await textsOf(".formation-consent-pop li")).toEqual([
      "「dev-server」のつなぎAIの設定フォルダに、GitHub Release から、このアプリと同じ版の tsunagiai-mcp を置きます",
      "tsunagiai-mcp は、その PC でサーバーとして待ち受けます（ポート 47823）",
      "最初に、その PC の画面でファイアウォールの「許可」を押してください",
      "同意は、設定の開発タブで PC ごとに取り消せます",
    ]);
    expect(await textsOf(".formation-consent-pop .text-btn")).toEqual(["やめる", "同意する"]);
    expect(await callsOf("formation_consents")).toHaveLength(1);
    expect(await callsOf(consent)).toEqual([]);
    expect(await callsOf(create)).toEqual([]);
  });

  it("puts the program on the PC when 「同意する」 is pressed, and then makes the formation that was asked for", async () => {
    await ask({ formation_consents: [] });
    const create = await mock("formation_create", formationEntry("mail-api", { minutes: 0, environment: "dev-server", projects: [{ environment: "dev-server", repo: "wonder-api" }] }));
    await mock("formation_list", formationList([...listed().formations, formationEntry("mail-api", { minutes: 0 })]));
    const consent = await mock("formation_consent", formationConsent("dev-server"));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await expect(consentDialog()).toBeDisplayed();
    // Once the program is on the PC, Rust lists the consent: the orchestrator of the new formation starts with no second dialog.
    await mock("formation_consents", [formationConsent("dev-server")]);
    await agreeButton().click();
    expect(await waitForCalls(consent)).toEqual([{ environment: "dev-server" }]);
    expect(await waitForCalls(create)).toEqual([{ name: "mail-api", projects: [{ environment: "dev-server", repo: "wonder-api" }] }]);
    await expect(consentDialog()).not.toExist();
    await browser.waitUntil(async () => (await pressedRows()).join() === "mail-api");
  });

  it("opens the dialog of the consent where the button that made it was, not at the corner of the window", async () => {
    await ask({ formation_consents: [] });
    await mock("formation_create", formationEntry("mail-api", { minutes: 0 }));
    await browser.keys("mail-api");
    await pick(3);
    const button = await browser.execute(() => {
      const r = document.querySelector(".formation-new-actions .text-btn.primary")!.getBoundingClientRect();
      return { left: r.left, bottom: r.bottom };
    });
    await makeButton().click();
    await expect(consentDialog()).toBeDisplayed();
    const at = await browser.execute(() => {
      const r = document.querySelector(".formation-consent-pop")!.getBoundingClientRect();
      return { left: r.left, top: r.top, inside: r.right <= innerWidth && r.bottom <= innerHeight };
    });
    expect(at.top).toBeGreaterThanOrEqual(button.bottom);
    expect(at.left).toBeGreaterThan(8);
    expect(at.inside).toBe(true);
  });

  it("goes on with the formation when the dialog is pressed away or closed with Escape while the program is being put on the PC", async () => {
    await ask({ formation_consents: [] });
    const create = await mock("formation_create", formationEntry("mail-api", { minutes: 0, environment: "dev-server", projects: [{ environment: "dev-server", repo: "wonder-api" }] }));
    const consent = await mock("formation_consent", holds);
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await expect(consentDialog()).toBeDisplayed();
    await mock("formation_consents", [formationConsent("dev-server")]);
    await agreeButton().click();
    await waitForCalls(consent);
    await browser.keys("Escape");
    await expect(consentDialog()).not.toExist();
    // The owner agreed, and the program is on its way: the answer of the placement decides, not the closing of the dialog.
    await browser.pause(200);
    expect(await callsOf(create)).toEqual([]);
    await release(consent, formationConsent("dev-server"));
    expect(await waitForCalls(create)).toEqual([{ name: "mail-api", projects: [{ environment: "dev-server", repo: "wonder-api" }] }]);
  });

  it("makes nothing and puts nothing on the PC when 「やめる」 is pressed", async () => {
    await ask({ formation_consents: [] });
    const create = await mock("formation_create", formationEntry("mail-api", { minutes: 0 }));
    const consent = await mock("formation_consent", formationConsent("dev-server"));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await declineButton().click();
    await expect(consentDialog()).not.toExist();
    await expect(dialog()).not.toExist();
    await browser.pause(300);
    expect(await callsOf(create)).toEqual([]);
    expect(await callsOf(consent)).toEqual([]);
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
  });

  it("counts Escape as a refusal too", async () => {
    await ask({ formation_consents: [] });
    const create = await mock("formation_create", formationEntry("mail-api", { minutes: 0 }));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await expect(consentDialog()).toBeDisplayed();
    await browser.keys("Escape");
    await expect(consentDialog()).not.toExist();
    await browser.pause(300);
    expect(await callsOf(create)).toEqual([]);
  });

  it("keeps both buttons off while the program is being put on the PC", async () => {
    await ask({ formation_consents: [] });
    await mock("formation_create", formationEntry("mail-api", { minutes: 0 }));
    const consent = await mock("formation_consent", holds);
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await agreeButton().click();
    await waitForCalls(consent);
    await expect(agreeButton()).toBeDisabled();
    await expect(declineButton()).toBeDisabled();
    await agreeButton().click();
    await browser.pause(200);
    expect(await callsOf(consent)).toHaveLength(1);
    await release(consent, formationConsent("dev-server"));
    await expect(consentDialog()).not.toExist();
  });

  it("shows the words of a failed placement, makes nothing, and keeps the dialog so that the owner can agree again", async () => {
    await ask({ formation_consents: [] });
    const create = await mock("formation_create", formationEntry("mail-api", { minutes: 0 }));
    const reason = "サーバーを置けませんでした: この PC は macOS（Apple Silicon）ではありません";
    const consent = await mock("formation_consent", rejects(reason));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await agreeButton().click();
    await waitForCalls(consent);
    await expect($(CARD)).toHaveText(reason);
    await expect(consentDialog()).toBeDisplayed();
    await expect(agreeButton()).toBeEnabled();
    await expect(declineButton()).toBeEnabled();
    expect(await callsOf(create)).toEqual([]);
    await mock("formation_consent", formationConsent("dev-server"));
    await agreeButton().click();
    expect(await waitForCalls(create)).toEqual([{ name: "mail-api", projects: [{ environment: "dev-server", repo: "wonder-api" }] }]);
  });

  it("keeps the card of a failed placement when the owner agrees again", async () => {
    await ask({ formation_consents: [] });
    await mock("formation_create", formationEntry("mail-api", { minutes: 0 }));
    await mock("formation_consent", rejects("サーバーを置けませんでした: この PC は macOS（Apple Silicon）ではありません"));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await agreeButton().click();
    await expect($(CARDS)).toBeDisplayed();
    const consent = await mock("formation_consent", formationConsent("dev-server"));
    await agreeButton().click();
    await waitForCalls(consent);
    await expect($(CARDS)).toBeDisplayed();
  });

  it("keeps the card of a failed read of the consents when the formation is made again", async () => {
    await ask();
    await mock("formation_consents", rejects("同意を読めません"));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await expect($(CARD)).toHaveText("同意を読めません");
    await expect(dialog()).toBeDisplayed();
    await mock("formation_consents", []);
    await makeButton().click();
    await expect(consentDialog()).toBeDisplayed();
    await expect($(CARDS)).toBeDisplayed();
  });

  it("does not ask for a consent when the projects are of two environments, and leaves the refusal to Rust", async () => {
    await ask({ formation_consents: [] });
    const reason = "フォーメーションは一つの PC に属します。環境「local」と環境「dev-server」にまたがるプロジェクトは入れられません（リーダーと子が別の PC にいると、SendMessage が届かないためです）";
    const create = await mock("formation_create", rejects(reason));
    await browser.keys("mail-api");
    await pick(0);
    await pick(3);
    await makeButton().click();
    await waitForCalls(create);
    await expect($(CARD)).toHaveText(reason);
    await expect(consentDialog()).not.toExist();
    expect(await callsOf("formation_consents")).toEqual([]);
  });

  it("shows the words of Rust when it refuses a project whose PC has no consent, and keeps the dialog as it was typed", async () => {
    await ask();
    const reason = "環境「dev-server」には、tsunagiai-mcp を置くことへの同意がありません。同意してから、フォーメーションを作ってください";
    await mock("formation_create", rejects(reason));
    await browser.keys("mail-api");
    await pick(3);
    await makeButton().click();
    await expect($(CARD)).toHaveText(reason);
    await expect(dialog()).toBeDisplayed();
    await expect(nameField()).toHaveValue("mail-api");
  });

  it("makes no more than one formation while a creation is on its way", async () => {
    await ask();
    const create = await mock("formation_create", holds);
    await browser.keys("one");
    await makeButton().click();
    await waitForCalls(create);
    await expect(makeButton()).toBeDisabled();
    await browser.keys("Enter");
    await browser.pause(200);
    expect(await callsOf(create)).toHaveLength(1);
    await release("formation_create", formationEntry("one", { minutes: 0 }));
    await expect(dialog()).not.toExist();
  });

  it("closes on 「キャンセル」, on Escape and on a press outside, and makes nothing", async () => {
    await ask();
    const create = await mock("formation_create", formationEntry("x", { minutes: 0 }));
    await $(".formation-new-actions .text-btn:not(.primary)").click();
    await expect(dialog()).not.toExist();
    await pressNew();
    await expect(dialog()).toBeDisplayed();
    await browser.keys("Escape");
    await expect(dialog()).not.toExist();
    await pressNew();
    await expect(dialog()).toBeDisplayed();
    // WebDriver's element click sends no pointerdown, which is what closes a popup: the page's own press elsewhere.
    await browser.execute(
      (once) => {
        if (!window.__e2e_once__(once)) return;
        document.getElementById("orca-header")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 5, isPrimary: true }));
      },
      onceId(),
    );
    await expect(dialog()).not.toExist();
    await browser.pause(200);
    expect(await callsOf(create)).toEqual([]);
    expect(await pressedRows()).toEqual(["formation"]);
  });

  it("shows nothing of an environment that could not be read, nor of the list of the saved ones that could not, and lets the repositories that were read be chosen", async () => {
    await ask({ formation_environments: formationEnvironments(["tsunagiai"], {}, { "dev-server": "Orca is not running" }, "Orca is not running") });
    expect(await textsOf(".formation-new-env")).toEqual(["この Mac"]);
    expect(await count(".formation-new-pop p:not(.formation-new-env)")).toBe(0);
    expect(await repos()).toEqual(["tsunagiai"]);
    await pick(0);
    expect(await checked()).toEqual([true]);
  });

  it("opens with an empty list when no repository could be read, and can still be made", async () => {
    await openList({ formation_environments: formationEnvironments([], {}, { "dev-server": "Orca is not running" }, "Orca is not running") });
    await pressNew();
    await expect(dialog()).toBeDisplayed();
    await expect(makeButton()).toBeEnabled();
    expect(await count(".formation-new-pop p:not([hidden])")).toBe(0);
    expect(await repos()).toEqual([]);
  });

  it("closes with the words of the failure when the environments cannot be read", async () => {
    await openList({ formation_environments: rejects("Orca に届きません") });
    await pressNew();
    await expect($(CARD)).toHaveText("Orca に届きません");
    await expect(dialog()).not.toExist();
  });

  it("keeps the new formation selected when a read of the list that began before it was made answers late", async () => {
    await ask();
    const list = await mock("formation_list", holds);
    await waitForCalls(list);
    // The next reads answer with the formation; only the one that is on its way does not know it.
    const full = formationList([...listed().formations, formationEntry("late", { minutes: 0 })]);
    await mock("formation_list", full);
    await mock("formation_create", formationEntry("late", { minutes: 0 }));
    await browser.keys("late");
    await makeButton().click();
    await browser.waitUntil(async () => (await pressedRows()).join() === "late");
    // The answer of the read that began before the formation was made is dropped, and the formation that was shown is not selected in its place.
    await release("formation_list", listed());
    await browser.pause(READ * 2);
    expect(await pressedRows()).toEqual(["late"]);
    expect(await headName()).toBe("late");
    await browser.waitUntil(async () => (await rowNames()).includes("late"));
    expect(await pressedRows()).toEqual(["late"]);
  });
});

describe("orchestration mode: delete a formation", () => {
  const confirm = () => $('.pop[role="alertdialog"]');
  const yes = () => $('.pop[role="alertdialog"] .text-btn.danger');
  // The page's own right button on the row of `name`.
  const rightPress = (name: string) =>
    browser.execute(
      (n, once) => {
        if (!window.__e2e_once__(once)) return;
        const r = document.querySelector(`#formation-list-feed [data-formation="${n}"]`)!.getBoundingClientRect();
        document.querySelector(`#formation-list-feed [data-formation="${n}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 40, clientY: r.top + r.height / 2 }));
      },
      name,
      onceId(),
    );
  const without = (name: string) => formationList(listed().formations.filter((f) => f.name !== name));
  const done = { deleted: true, kept: [], preserved: [] };
  // Two children that git keeps: `api-update` has a change and an untracked file, `web-update` a commit that no remote has.
  const kept = {
    deleted: false,
    kept: [
      { name: "api-update", answer: { closed: false, path: "/w/api-update", environment: "local", preservedBranch: null, reason: "worktree にコミットしていない変更か、追跡していないファイルがあります", changed: [" M src/a.rb"], untracked: ["?? tmp/x.log"], unpushed: [] } },
      { name: "web-update", answer: { closed: false, path: "/srv/web-update", environment: "dev-server", preservedBranch: null, reason: "どのリモートにも届いていないコミットがあります", changed: [], untracked: [], unpushed: ["abc1234 add a", "def5678 add b"] } },
    ],
  };
  async function ask(name: string) {
    await rightPress(name);
    await $('.menu button.danger[role="menuitem"]').click();
    await expect(confirm()).toBeDisplayed();
  }

  it("opens a menu with the projects of the formation above a line and 削除 under it on a right press of a row, and 削除 alone for a formation with no project", async () => {
    await openList();
    await rightPress("won-2485");
    await expect($(".menu")).toBeDisplayed();
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["wonder-knowledge", "wonder-api", "削除"]);
    // The projects are headings that cannot be pressed, in the monospace of the names; 削除 is the one with the danger color and the keys.
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLButtonElement>('.menu button[role="menuitem"]')].map((b) => b.disabled))).toEqual([true, true, false]);
    expect(await count('.menu button[role="menuitem"] svg')).toBe(3);
    expect(await browser.execute(() => getComputedStyle(document.querySelector<HTMLElement>('.menu button[role="menuitem"]')!).fontFamily)).toContain("monospace");
    expect(await browser.execute(() => getComputedStyle(document.querySelector<HTMLElement>('.menu button[role="menuitem"]')!).opacity)).toBe("1");
    await expect($('.menu button[role="menuitem"]:last-child')).toHaveElementClass("danger");
    expect(await browser.execute(() => (document.activeElement as HTMLElement).textContent)).toBe("削除");
    // One line, between the projects and 削除.
    expect(await browser.execute(() => [...document.querySelector(".menu")!.children].map((e) => e.getAttribute("role") ?? e.tagName))).toEqual(["menuitem", "menuitem", "separator", "menuitem"]);
    // A press on a project calls nothing and keeps the menu.
    await browser.execute(() => document.querySelector<HTMLElement>('.menu button[role="menuitem"]')!.click());
    await expect($(".menu")).toBeDisplayed();
    expect(await callsOf("formation_delete")).toEqual([]);
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
    await rightPress("formation");
    await expect($(".menu")).toBeDisplayed();
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["削除"]);
    await expect($('.menu button[role="menuitem"]')).toHaveElementClass("danger");
    expect(await count('.menu button[role="menuitem"] svg')).toBe(1);
    expect(await count(".menu [role=separator]")).toBe(0);
  });

  it("deletes `formation` as any other, and selects nothing when it is the shown one", async () => {
    await openList();
    await waitForStarts(1);
    const del = await mock("formation_delete", done);
    await mock("formation_list", without("formation"));
    await mock("formation_children", []);
    await ask("formation");
    await yes().click();
    expect(await waitForCalls(del)).toEqual([{ name: "formation", force: false, shown: [] }]);
    await browser.waitUntil(async () => (await rowNames()).join() === "won-2485,mail-summary");
    expect(await pressedRows()).toEqual([]);
    expect(await callsOf("claude_code_close")).toMatchObject([{ id: "formation:formation" }]);
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-flow")).not.toBeDisplayed();
    expect(await starts()).toBe(1);
  });

  it("asks first, with the name, and calls nothing on キャンセル", async () => {
    await openList();
    const del = await mock("formation_delete", done);
    await ask("won-2485");
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("won-2485 を削除しますか？");
    await $('.pop[role="alertdialog"] .text-btn:not(.danger)').click();
    await expect(confirm()).not.toExist();
    expect(await callsOf(del)).toEqual([]);
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
  });

  it("deletes the formation by its name on 削除, and takes its row off the list", async () => {
    await openList();
    const del = await mock("formation_delete", done);
    await mock("formation_list", without("mail-summary"));
    await ask("mail-summary");
    await yes().click();
    expect(await waitForCalls(del)).toEqual([{ name: "mail-summary", force: false, shown: [] }]);
    await browser.waitUntil(async () => (await rowNames()).join() === "formation,won-2485");
    // The shown formation is another one: it stays shown, and its orchestrator is not started again.
    expect(await pressedRows()).toEqual(["formation"]);
    expect(await headName()).toBe("formation");
    expect(await starts()).toBe(1);
  });

  it("selects nothing and stops reading the deleted one's children when the shown one is deleted", async () => {
    await openList({ formation_list: listedFirst() });
    await row("won-2485").click();
    await waitForStarts(2);
    await waitForCalls("formation_children", 2);
    const del = await mock("formation_delete", done);
    await mock("formation_list", formationList(listedFirst().formations.filter((f) => f.name !== "won-2485")));
    await mock("formation_children", []);
    await ask("won-2485");
    await yes().click();
    await waitForCalls(del);
    await browser.waitUntil(async () => (await rowNames()).join() === "api-work,formation,mail-summary");
    expect(await pressedRows()).toEqual([]);
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-flow")).not.toBeDisplayed();
    // The terminal of the deleted formation's orchestrator is dropped, and no new start is made.
    expect(await callsOf("claude_code_close")).toMatchObject([{ id: "formation:won-2485" }]);
    expect(await starts()).toBe(2);
    // The read of the deleted formation's children stops, and no other formation is read in its place.
    const before = (await callsOf("formation_children")).length;
    await browser.pause(READ * 3);
    expect((await callsOf("formation_children")).length).toBe(before);
  });

  it("says why a child was refused, and keeps the formation, its row and what is shown", async () => {
    await openList();
    await row("won-2485").click();
    await waitForStarts(2);
    const message = "子「api-update」を閉じられないので、フォーメーション「won-2485」を削除していません（閉じ終えた子は閉じたままです）。worktree にコミットしていない変更か、追跡していないファイルがあります。消さずに残しました。消してよいか、オーナーに確かめてください";
    await mock("formation_delete", rejects(message));
    await ask("won-2485");
    await yes().click();
    await expect($("#formation-list-error")).toHaveText(message);
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
    expect(await pressedRows()).toEqual(["won-2485"]);
    expect(await headName()).toBe("won-2485");
    expect(await callsOf("claude_code_close")).toEqual([]);
    // The words go when another row is pressed.
    await row("formation").click();
    await expect($("#formation-list-error")).not.toBeDisplayed();
  });

  it("says why the children were kept and what is lost, keeps the formation, and calls nothing more on キャンセル", async () => {
    await openList();
    await row("won-2485").click();
    await waitForStarts(2);
    const del = await mock("formation_delete", kept);
    await ask("won-2485");
    await yes().click();
    expect(await waitForCalls(del)).toEqual([{ name: "won-2485", force: false, shown: [] }]);
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("won-2485 を削除できませんでした");
    expect(await textsOf(".pop-lost-child")).toEqual(["子「api-update」", "子「web-update」"]);
    await expect(confirm()).toHaveText(expect.stringContaining(kept.kept[0].answer.reason));
    await expect(confirm()).toHaveText(expect.stringContaining(kept.kept[1].answer.reason));
    // A kind that git did not list for a child has no head: the changed file and the untracked file of the first, the commits of the second.
    expect(await textsOf(".pop-lost-head")).toEqual(["変更のあるファイル", "追跡していないファイル", "どのリモートにもないコミット"]);
    expect(await rawTextsOf(".pop-lost li")).toEqual([" M src/a.rb", "?? tmp/x.log", "abc1234 add a", "def5678 add b"]);
    // Where each worktree is, which a force sends back.
    expect(await textsOf(".pop-lost-place")).toEqual(["この Mac: /w/api-update", "dev-server: /srv/web-update"]);
    await expect(yes()).toHaveText("強制削除");
    // Nothing was closed: the row stays, selected and shown, with no words of failure and no more calls.
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
    expect(await pressedRows()).toEqual(["won-2485"]);
    await expect(row("won-2485")).not.toHaveAttribute("aria-busy", "true");
    await expect($("#formation-list-error")).not.toBeDisplayed();
    expect(await callsOf("claude_code_close")).toEqual([]);
    await $('.pop[role="alertdialog"] .text-btn:not(.danger)').click();
    await expect(confirm()).not.toExist();
    expect(await callsOf(del)).toHaveLength(1);
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
  });

  it("deletes it with force on 強制削除, and takes its row off the list", async () => {
    await openList();
    const del = await mock("formation_delete", kept);
    await ask("mail-summary");
    await yes().click();
    await waitForCalls(del);
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("mail-summary を削除できませんでした");
    await mock("formation_delete", done);
    await mock("formation_list", without("mail-summary"));
    await yes().click();
    expect(await waitForCalls(del)).toEqual([{ name: "mail-summary", force: true, shown: [{ name: "api-update", path: "/w/api-update" }, { name: "web-update", path: "/srv/web-update" }] }]);
    await browser.waitUntil(async () => (await rowNames()).join() === "formation,won-2485");
    await expect(confirm()).not.toExist();
    await expect($("#formation-list-error")).not.toBeDisplayed();
  });

  it("tells the branches that Orca kept when the formation is deleted", async () => {
    await openList();
    const del = await mock("formation_delete", { deleted: true, kept: [], preserved: ["api-update: me/a", "web-update: me/web-update"] });
    await mock("formation_list", without("mail-summary"));
    await ask("mail-summary");
    await yes().click();
    await waitForCalls(del);
    await browser.waitUntil(async () => (await rowNames()).join() === "formation,won-2485");
    await expect($("#formation-list-error")).toHaveText("どのリモートにもないコミットがあるブランチは、ローカルに残しました: api-update: me/a、web-update: me/web-update");
  });

  it("shows the words of a forced deletion that is refused, and keeps the formation", async () => {
    await openList();
    const del = await mock("formation_delete", kept);
    await ask("mail-summary");
    await yes().click();
    await waitForCalls(del);
    const message = "子「api-update」を閉じられないので、フォーメーション「mail-summary」を削除していません（何も閉じておらず、リーダーのプロセスも終えていません）。記録にある worktree が Orca の一覧になく、または repository 本体のフォルダです";
    await mock("formation_delete", rejects(message));
    await yes().click();
    await expect($("#formation-list-error")).toHaveText(message);
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("deletes one formation once while the deletion is on its way, and marks its row busy", async () => {
    await openList();
    const del = await mock("formation_delete", holds);
    await ask("mail-summary");
    await yes().click();
    await waitForCalls(del);
    await expect(row("mail-summary")).toHaveAttribute("aria-busy", "true");
    await rightPress("mail-summary");
    await browser.pause(200);
    await expect($(".menu")).not.toExist();
    expect(await callsOf(del)).toHaveLength(1);
    await mock("formation_list", without("mail-summary"));
    await release("formation_delete", done);
    await browser.waitUntil(async () => (await rowNames()).join() === "formation,won-2485");
  });
});

describe("orchestration: the read of the list while no formation is selected", () => {
  it("reads the list and no children at the period of the Orca list's read, one call at a time", async () => {
    await boot({ inbox: inbox(), ...timers({ orcaClock: READ }) });
    await mock("formation_list", holds);
    await mock("formation_children", []);
    await $("#nav-orca").click();
    await waitForCalls("formation_list", 1);
    await browser.pause(READ * 3);
    expect((await callsOf("formation_list")).length).toBe(1);
    // Answer the next reads before the held one is released, so that the read that follows it is not held again; `mock` forgets the calls, and the next one is the first of the new answer.
    await mock("formation_list", listed());
    await release("formation_list", listed());
    await waitForCalls("formation_list", 1);
    await browser.waitUntil(async () => (await rowNames()).length === 3);
    expect(await callsOf("formation_children")).toEqual([]);
  });

  it("keeps the rows when a read of the list fails", async () => {
    await boot({ inbox: inbox(), formation_list: listed(), ...timers({ orcaClock: READ }) });
    await $("#nav-orca").click();
    await browser.waitUntil(async () => (await rowNames()).length === 3);
    await mock("formation_list", rejects("一覧を読めません"));
    await waitForCalls("formation_list", 1);
    expect((await rowNames()).length).toBe(3);
  });

  it("does not read again when the 開発 button is pressed on the development screen", async () => {
    await boot({ inbox: inbox(), formation_list: listed(), ...timers({ orcaClock: 5000 }) });
    await $("#nav-orca").click();
    await waitForCalls("formation_list", 1);
    const reads = (await callsOf("formation_list")).length;
    await $("#nav-orca").click();
    await browser.pause(300);
    expect((await callsOf("formation_list")).length).toBe(reads);
  });
});

describe("orchestration mode: the orchestrator of a formation of a saved environment", () => {
  const remote = (environment = "mac-studio") => formationList([formationEntry("formation"), formationEntry("studio-work", { minutes: 5, environment, projects: [{ environment, repo: "api" }] })]);
  const terminal = (environment = "mac-studio") => ({ environment, handle: "term_orch" });
  const orchestratorText = () => $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText();
  const SHOWN = { ...timers({ formationFlow: READ, orcaMirror: MIRROR }), orca_terminal_read: ["$ claude", "> リーダーです"], formation_consents: [formationConsent("mac-studio")] };

  it("asks for the terminal of the formation and mirrors it in that environment, with no pseudo terminal", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN }, "studio-work");
    expect(await waitForCalls("formation_orchestrator", 1)).toEqual([{ name: "studio-work", restart: false }]);
    expect((await waitForCalls("orca_terminal_read"))[0]).toEqual({ handle: "term_orch", environment: "mac-studio" });
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"), { timeoutMsg: "the terminal of the orchestrator never showed" });
    expect(await headName()).toBe("studio-work");
    await expect($("#formation-term-error")).not.toBeDisplayed();
    expect(await starts()).toBe(0);
  });

  it("types into the terminal of the orchestrator in that environment", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN }, "studio-work");
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"));
    const input = await mock("orca_terminal_input", null);
    await browser.keys(["c", "d"]);
    await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => JSON.stringify(c).includes('"handle":"term_orch"') && JSON.stringify(c).includes('"environment":"mac-studio"'))).toBe(true);
  });

  it("streams it when the Orca screen streams that environment, and reads nothing", async () => {
    const overview = orcaOverview([], [], { target: "Studio", environments: ["Studio"] });
    await openList({ formation_list: remote("Studio"), formation_orchestrator: terminal("Studio"), orca_overview: overview, formation_consents: [formationConsent("Studio")] }, null);
    await waitForCalls("orca_stream_open");
    await sendStream(streamList([], []));
    await row("studio-work").click();
    expect(await waitForCalls("orca_stream_terminal")).toMatchObject([{ handle: "term_orch" }]);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    expect(await starts()).toBe(0);
  });

  // #943: Claude Code ends, the terminal ends with it (the sentence replaces the login shell) and leaves the list of its Orca. The screen reads no more, keeps the last screen, and asks Rust for the leader again when the formation is shown next.
  it("stops reading a mirrored terminal that its Orca no longer lists, and asks for the leader again when the formation is pressed next", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN }, "studio-work");
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"));
    const read = await mock("orca_terminal_read", rejects("宛先のターミナルは終了したか、見つかりません。一覧を読み直してください"));
    await waitForCalls(read, 1);
    await browser.pause(MIRROR * 4);
    expect(await callsOf(read)).toHaveLength(1);
    expect(await orchestratorText()).toContain("リーダーです");
    const asked = await mock("formation_orchestrator", { environment: "mac-studio", handle: "term_orch2" });
    await mock("orca_terminal_read", ["$ claude", "> 新しいリーダーです"]);
    await row("formation").click();
    await waitForStarts(1);
    await row("studio-work").click();
    expect(await waitForCalls(asked, 1)).toEqual([{ name: "studio-work", restart: false }]);
    await browser.waitUntil(async () => (await orchestratorText()).includes("新しいリーダーです"), { timeoutMsg: "the new terminal of the leader never showed" });
    expect((await callsOf("orca_terminal_read")).every((c) => (c as { handle: string }).handle === "term_orch2")).toBe(true);
  });

  it("asks for the leader again when the stream of its terminal has ended, and not while it is still listed", async () => {
    const overview = orcaOverview([], [], { target: "Studio", environments: ["Studio"] });
    await openList({ formation_list: remote("Studio"), formation_orchestrator: terminal("Studio"), orca_overview: overview, formation_consents: [formationConsent("Studio")] }, null);
    await waitForCalls("orca_stream_open");
    await sendStream(streamList([], []));
    await row("studio-work").click();
    await waitForCalls("orca_stream_terminal");
    await sendTerm({ kind: "snapshot", data: "$ claude", cols: 80, rows: 24 });
    // A terminal that is still listed is shown again with nothing asked.
    await row("formation").click();
    await waitForStarts(1);
    await row("studio-work").click();
    await browser.pause(300);
    expect(await callsOf("formation_orchestrator")).toHaveLength(1);
    await sendTerm({ kind: "ended", message: "このターミナルは一覧にありません" });
    const asked = await mock("formation_orchestrator", { environment: "Studio", handle: "term_orch2" });
    await row("formation").click();
    await row("studio-work").click();
    expect(await waitForCalls(asked, 1)).toEqual([{ name: "studio-work", restart: false }]);
    await browser.waitUntil(async () => (await callsOf("orca_stream_terminal")).some((c) => (c as { handle: string }).handle === "term_orch2"), { timeoutMsg: "the new terminal of the leader was never streamed" });
  });

  // The children of such a formation are in its PC's `children.json`, which Rust reads through Orca (#860): the screen asks by the name of the formation, as for this Mac's, and draws the answer, whose children are in that environment.
  it("reads the children of the formation of a saved environment by its name, draws them, and reads their terminals in that environment", async () => {
    const children = [formationChild("api-update", "working", { environment: "mac-studio" }), formationChild("docs-update", "planned", { environment: "mac-studio" })];
    await openList({ formation_list: remote(), formation_children: children, formation_orchestrator: terminal(), ...SHOWN }, "studio-work");
    expect((await waitForCalls("formation_children", 1))[0]).toEqual({ name: "studio-work" });
    await browser.waitUntil(async () => (await cardNames()).length === 2, { timeoutMsg: "the children of the formation never showed" });
    expect(await cardNames()).toEqual(["api-update", "docs-update"]);
    expect(await cardStates()).toEqual(["作業中", "予定"]);
    await expect($("#formation-flow")).toBeDisplayed();
    // The terminal of a child is read when its tab is the selected one: the card of the child is pressed.
    await card("api-update").click();
    await browser.waitUntil(async () => (await callsOf("orca_terminal_read")).some((c) => (c as { handle: string }).handle === "term_api-update" && (c as { environment?: string }).environment === "mac-studio"), { timeoutMsg: "the terminal of the child was not read in its environment" });
    expect(await callsOf("formation_orchestrator")).toHaveLength(1);
    expect(await starts()).toBe(0);
  });

  it("asks only for the formations of a saved environment, and starts the pseudo terminal of this Mac's as before", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN }, "formation");
    await waitForStarts(1);
    expect(await callsOf("formation_orchestrator")).toEqual([]);
    await row("studio-work").click();
    await waitForCalls("formation_orchestrator", 1);
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"));
    // Back on this Mac's: its process is shown again, nothing is started, and the other terminal is not asked for again.
    await row("formation").click();
    await browser.waitUntil(async () => (await headName()) === "formation");
    await row("studio-work").click();
    await browser.pause(300);
    expect(await starts()).toBe(1);
    expect(await callsOf("formation_orchestrator")).toHaveLength(1);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("says in the pane why the terminal could not be made, and asks again when the formation is pressed again", async () => {
    const reason = "リーダーを起動できません（環境「mac-studio」）: Orca がターミナルの handle を答えませんでした";
    await openList({ formation_list: remote(), ...SHOWN }, null);
    await mock("formation_orchestrator", rejects(reason));
    await row("studio-work").click();
    await waitForCalls("formation_orchestrator", 1);
    await expect($("#formation-term-error")).toHaveText(reason);
    await expect($("#formation-term-error")).toHaveAttribute("role", "alert");
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    await browser.pause(300);
    expect(await callsOf("formation_orchestrator")).toHaveLength(1);
    await mock("formation_orchestrator", terminal());
    await row("formation").click();
    await waitForStarts(1);
    await row("studio-work").click();
    expect(await waitForCalls("formation_orchestrator", 1)).toEqual([{ name: "studio-work", restart: false }]);
    await expect($("#formation-term-error")).not.toBeDisplayed();
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"));
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  // #893: a formation made before the owner's consent for its PC asks for it when it is opened.
  const remoteDialog = () => $('.formation-consent-pop[role="dialog"]');

  it("asks for the consent of the PC when a formation of it is opened with none, and starts nothing before the answer", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN, formation_consents: [] }, "studio-work");
    await expect(remoteDialog()).toBeDisplayed();
    await expect($(".formation-consent-pop h3")).toHaveText("「mac-studio」に tsunagiai-mcp を置きますか？");
    expect(await textsOf(".formation-consent-pop .text-btn")).toEqual(["やめる", "同意する"]);
    await browser.pause(300);
    expect(await callsOf("formation_orchestrator")).toEqual([]);
    expect(await starts()).toBe(0);
  });

  it("goes on with the terminal of the orchestrator once the owner agrees", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN, formation_consents: [] }, "studio-work");
    const consent = await mock("formation_consent", formationConsent("mac-studio"));
    await expect(remoteDialog()).toBeDisplayed();
    await $(".formation-consent-pop .text-btn.primary").click();
    expect(await waitForCalls(consent)).toEqual([{ environment: "mac-studio" }]);
    expect(await waitForCalls("formation_orchestrator", 1)).toEqual([{ name: "studio-work", restart: false }]);
    await expect(remoteDialog()).not.toExist();
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"), { timeoutMsg: "the terminal of the orchestrator never showed" });
  });

  it("closes the dialog and does nothing when the owner declines, with no failure in the pane", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN, formation_consents: [] }, "studio-work");
    const consent = await mock("formation_consent", formationConsent("mac-studio"));
    await expect(remoteDialog()).toBeDisplayed();
    await $(".formation-consent-pop .text-btn:not(.primary)").click();
    await expect(remoteDialog()).not.toExist();
    await browser.pause(400);
    expect(await callsOf(consent)).toEqual([]);
    expect(await callsOf("formation_orchestrator")).toEqual([]);
    await expect($("#formation-term-error")).not.toBeDisplayed();
  });

  it("asks nothing of a PC that has the consent, and nothing of a formation of this Mac", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN }, "studio-work");
    await waitForCalls("formation_orchestrator", 1);
    expect(await callsOf("formation_consents")).toHaveLength(1);
    await expect(remoteDialog()).not.toExist();
    await row("formation").click();
    await waitForStarts(1);
    expect(await callsOf("formation_consents")).toHaveLength(1);
  });

});

// A-41: the decision page of a child, in a tab of the middle pane.
const MARK_AT = Date.now() - 3 * 60_000;
const asking = (extra: Record<string, unknown> = {}) => formationChild("req-login", "working", { pendingPage: { title: "要件の未決事項", atMs: MARK_AT }, ...extra });
const PAGE_TAB = '#formation-tabs-mates [data-page="req-login"]';
const OPEN = '#formation-flow-pages [data-page-card="req-login"]';
const pageCall = () => callsOf("formation_page_read");
// Whether a fold of the page is open.
const folded = (selector: string) => browser.execute((s) => document.querySelector<HTMLDetailsElement>(s)!.open, selector);
// The drawer on the right of the page (#1158): what a fold shows is in the panel in view, and the folds of one owner are its tabs.
const DRAWER = "#formation-page .fp-drawer";
const PANEL = `${DRAWER} .fp-dr-panel:not([hidden])`;
const tab = (label: string) => $(DRAWER).$(`button=${label}`);
const tabs = () => textsOf(`${DRAWER} .fp-dr-tab`);
// The head of the drawer: 「{owner} — {fold}」.
const drawerTitle = () => rawTextsOf(`${DRAWER} .fp-dr-title`);
// Opens every row of 「参考」 (a row that opens in place), so that a button in it can be pressed.
const openReferences = () =>
  browser.execute(() => {
    for (const row of document.querySelectorAll<HTMLDetailsElement>("#formation-page .fp-ref")) row.open = true;
  });

// Opens the page of `req-login`: the formation is shown with that child waiting on it, and the card of its page (「開く」) is pressed.
async function openPage(page = decisionPage(), children: unknown[] = [asking()]) {
  await openFlow(children, { formation_page_read: page });
  await browser.waitUntil(async () => (await cardNames()).length === children.length);
  await $(OPEN).click();
  await expect($("#formation-page")).toBeDisplayed();
}

const QUESTION = decisionCard("Q1", {
  title: "ログインに何回失敗したら止めるか",
  summary: "止める回数を決める",
  options: [
    decisionOption("A", "5 回で 15 分止める", "API の上限と同じ"),
    decisionOption("B", "10 回で 15 分止める", null),
  ],
  recommendation: "A",
  recommendationReason: "今の API の上限と同じ",
});

describe("orchestration mode: the decision page of a child", () => {
  it("draws a card of its own for a page that waits at the top of the right pane, apart from the card of its child, and opens no tab by itself", async () => {
    await openFlow([asking(), formationChild("api-update", "working")]);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    // The card of the child says its own state, and holds nothing of the page.
    const teammate = '#formation-flow-list [data-name="req-login"]';
    expect(await textsOf(`${teammate} .formation-card-state`)).toEqual(["作業中"]);
    expect(await count(`${teammate} .formation-card-open`)).toBe(0);
    // The group: the line 「判断待ち 1」, and a card with 「判断: {title}」, the name of the child and 「開く」.
    await expect($("#formation-flow-pages")).toBeDisplayed();
    expect(await textsOf("#formation-flow-pages-title")).toEqual(["判断待ち 1"]);
    expect(await textsOf(`${OPEN} .formation-card-title`)).toEqual(["判断: 要件の未決事項"]);
    expect(await textsOf(`${OPEN} .formation-card-name`)).toEqual(["req-login"]);
    expect(await textsOf(`${OPEN} .formation-card-open`)).toEqual(["開く"]);
    expect(await textsOf("#formation-flow-pages .formation-card-open")).toEqual(["開く"]);
    await expect($(OPEN)).toHaveAttribute("data-state", "waiting");
    expect(await browser.execute((sel) => getComputedStyle(document.querySelector(sel)!).borderTopColor, OPEN)).toBe(await resolvedGround("--agent-question"));
    // The group is above the leader's card, and a line parts it from it; the children are under the leader's card.
    const [pages, root, list] = [await rectOf("#formation-flow-pages"), await rectOf("#formation-flow-root"), await rectOf("#formation-flow-list")];
    expect(pages.bottom).toBeLessThanOrEqual(root.top);
    expect(root.bottom).toBeLessThanOrEqual(list.top + 1);
    // No tab opens by itself, neither the child's nor the page's, and the page is read only when it is shown.
    expect(await textsOf("#formation-tabs .formation-tab-name")).toEqual(["リーダー"]);
    await browser.pause(WAIT);
    expect(await textsOf("#formation-tabs .formation-tab-name")).toEqual(["リーダー"]);
    expect(await pageCall()).toEqual([]);
  });

  it("draws the cards of the pages that wait under 判断待ち with their number, and none while no page waits", async () => {
    await openFlow([asking(), formationChild("batch-update", "working", { pendingPage: { title: "設計の承認", atMs: MARK_AT } }), formationChild("api-update", "working")], { formation_page_read: decisionPage() });
    await browser.waitUntil(async () => (await cardNames()).length === 3);
    expect(await textsOf("#formation-flow-pages-title")).toEqual(["判断待ち 2"]);
    expect(await textsOf("#formation-flow-pages .formation-card-title")).toEqual(["判断: 要件の未決事項", "判断: 設計の承認"]);
    await mock("formation_children", [formationChild("req-login", "working"), formationChild("batch-update", "working"), formationChild("api-update", "working")]);
    await expect($("#formation-flow-pages")).not.toBeDisplayed();
    expect(await count("#formation-flow-pages .formation-card")).toBe(0);
  });

  it("shows the page in place of the terminal when its card is pressed, and reads it once for the formation and the child", async () => {
    await openPage(decisionPage({ contextLabel: "要件定義 · 未決事項 1 件", title: "要件の未決事項", questions: [QUESTION] }));
    expect(await waitForCalls("formation_page_read", 1)).toEqual([{ name: "formation", child: "req-login" }]);
    await expect($("#formation-term")).not.toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    await expect($(PAGE_TAB)).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "false");
    await expect($(OPEN)).toHaveAttribute("aria-pressed", "true");
    await expect($("#formation-page .fp-title")).toHaveText("要件の未決事項");
    await expect($("#formation-page .fp-from")).toHaveText("req-login から");
    await expect($("#formation-page .fp-context")).toHaveText("要件定義 · 未決事項 1 件");
    await expect($('#formation-page [data-card="Q1"] .fp-card-title')).toHaveText("ログインに何回失敗したら止めるか");
    // A poll that changes nothing reads the page no more.
    await browser.pause(READ * 3);
    expect(await pageCall()).toHaveLength(1);
    // The leader's tab shows the terminal again, and the page is kept for the next time.
    await $("#formation-tab-leader-main").click();
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-page")).not.toBeDisplayed();
    await $(PAGE_TAB).click();
    await expect($("#formation-page .fp-title")).toBeDisplayed();
    expect(await pageCall()).toHaveLength(1);
  });

  it("opens the tab of a page only when its card is pressed, and hides it with its ×, which keeps the card and the mark", async () => {
    await openFlow([asking()], { formation_page_read: decisionPage() });
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    expect(await count(PAGE_TAB)).toBe(0);
    await $(OPEN).click();
    await expect($(PAGE_TAB)).toHaveAttribute("aria-selected", "true");
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["判断: 要件の未決事項"]);
    await expect($("#formation-page .fp-title")).toBeDisplayed();
    await expect($("#formation-term")).not.toBeDisplayed();
    // The × hides the tab and the page, and shows the leader's terminal; the card of the page stays and shows it again.
    expect(await textsOf("#formation-tabs-mates .formation-tab-close")).toEqual(["×"]);
    await $('#formation-tabs-mates [data-hide-page="req-login"]').click();
    expect(await count(PAGE_TAB)).toBe(0);
    await expect($("#formation-page")).not.toBeDisplayed();
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await expect($(OPEN)).toHaveAttribute("aria-pressed", "false");
    await $(OPEN).click();
    await expect($(PAGE_TAB)).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-page .fp-title")).toBeDisplayed();
    expect(await pageCall()).toHaveLength(1);
  });

  it("draws a question with its options as radios, the recommended one marked with its reason, and free text for その他 only", async () => {
    await openPage(decisionPage({ questions: [QUESTION] }));
    const card = '#formation-page [data-card="Q1"]';
    expect(await textsOf(`${card} .fp-choice-label`)).toEqual(["A5 回で 15 分止める推奨", "B10 回で 15 分止める", "調べてから決めて", "その他"]);
    expect(await count(`${card} input[type="radio"]`)).toBe(4);
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} .fp-choice`)].map((e) => (e as HTMLElement).dataset.recommended ?? ""), card)).toEqual(["true", "", "", ""]);
    expect(await textsOf(`${card} .fp-reason`)).toEqual(["理由: 今の API の上限と同じ"]);
    const cancel = $(`${card} .fp-cancel`);
    await expect(cancel).toBeDisabled();
    await expect($(`${card} .fp-text`)).not.toBeDisplayed();
    await $(`${card} input[value="B"]`).click();
    await expect(cancel).toBeEnabled();
    await expect($(`${card} input[value="B"]`)).toBeSelected();
    await $(`${card} input[value="other"]`).click();
    await expect($(`${card} .fp-text`)).toBeDisplayed();
    await $(`${card} .fp-text`).setValue("5 回と 10 回の間");
    await expect($(`${card} input[value="B"]`)).not.toBeSelected();
    await cancel.click();
    await expect($(`${card} input[value="other"]`)).not.toBeSelected();
    await expect(cancel).toBeDisabled();
    await expect($(`${card} .fp-text`)).not.toBeDisplayed();
    // The page's one button that sends is in the bottom bar, after 「次の未回答へ」 and 「TOP へ戻る」.
    expect(await textsOf("#formation-page .fp-bar-bottom button")).toEqual(["次の未回答へ", "TOP へ戻る", "リーダーに送る"]);
  });

  it("gives the other kinds of card the fixed choices of their kind, and a field for a note", async () => {
    const approval = decisionPage({
      pageKind: "approval",
      subject: "design",
      what: "設計を承認します",
      needsUserDecision: [decisionCard("NR-1", { kind: "nr", options: [decisionOption("A", "案 A", null)], recommendation: "A", recommendationReason: "単純" })],
      residualMustFix: [decisionCard("MF-1", { kind: "must-fix", recommendation: "fix", recommendationReason: "壊れる" })],
      structuralProposals: [decisionCard("SP-1", { kind: "structural-proposal", recommendation: "approve", recommendationReason: "重複が減る" })],
      adr: decisionCard("ADR-1", { kind: "adr", recommendation: "keep", recommendationReason: "残す価値がある" }),
      qualityLoop: { rounds: 2, fixCycles: 1, mustFixResolved: 3 },
    });
    await openPage(approval);
    const labels = (n: string) => textsOf(`#formation-page [data-card="${n}"] .fp-choice-label`);
    expect(await labels("NR-1")).toEqual(["A案 A推奨", "その他"]);
    expect(await labels("MF-1")).toEqual(["指摘のとおり修正する推奨", "今回は対応しない"]);
    expect(await labels("SP-1")).toEqual(["承認推奨", "却下", "保留"]);
    expect(await labels("ADR-1")).toEqual(["残す推奨", "不要"]);
    expect(await textsOf('#formation-page [data-card="SP-1"] .fp-note > span')).toEqual(["理由（却下・保留のとき）"]);
    expect(await textsOf('#formation-page [data-card="MF-1"] .fp-note > span')).toEqual(["補足（任意）"]);
    expect(await textsOf("#formation-page .fp-sec")).toEqual(["何が変わるか", "判断が必要 1 件", "未解消の必ず直す指摘 1 件", "構造改善の提案 1 件", "ADR（設計判断の記録） 1 件", "参考", "あなたの判定"]);
    await $("#formation-page .fp-quality > summary").click();
    expect(await textsOf("#formation-page .fp-reference .fp-quality .fp-p")).toEqual(["実施回数: 2 回", "MustFix 修正: 1 回", "解消した必ず直す指摘: 3 件"]);
  });

  it("draws a code review with its changes open, the unmet criterion with no answer, and the pull request", async () => {
    await openPage(
      decisionPage({
        pageKind: "code-review",
        subject: "code",
        what: "ロックを足しました",
        changes: [{ heading: "api の変更", blocks: [{ type: "paragraph", text: "失敗の回数を数えます" }] }],
        unmetCriteria: [decisionCard("UC-1", { kind: "unmet-criterion", title: "条件 1", cards: ["RMF-1"] })],
        residualMustFix: [decisionCard("RMF-1", { kind: "review-must-fix", recommendation: "fix", recommendationReason: "落ちる" })],
        pr: { url: "https://example.com/pr/1", note: null },
      }),
    );
    expect(await folded("#formation-page .fp-change")).toBe(true);
    await expect($("#formation-page .fp-change .fp-p")).toHaveText("失敗の回数を数えます");
    expect(await textsOf('#formation-page [data-card="RMF-1"] .fp-choice-label')).toEqual(["修正して再レビューする推奨", "現状で完了する"]);
    expect(await count('#formation-page [data-card="UC-1"] input')).toBe(0);
    // The pull request is not in 「参考」: it is under the title.
    expect(await count("#formation-page .fp-reference")).toBe(0);
  });

  it("shows the pull request of a code review under the title, and 「開く」 opens its URL in the default browser", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", notices: ["集約の検査は通りました"], pr: { url: "https://github.com/o/r/pull/7", note: null } }));
    expect(await textsOf("#formation-page .fp-pr .fp-ev-path")).toEqual(["https://github.com/o/r/pull/7"]);
    expect(await textsOf("#formation-page .fp-pr button")).toEqual(["開く"]);
    // Right after the header and before 「何が変わるか」.
    expect(await browser.execute(() => document.querySelector(".fp-top")?.nextElementSibling?.className)).toBe("fp-pr");
    // 「参考」 holds the notices and not the pull request.
    await $("#formation-page .fp-notices > summary").click();
    expect(await textsOf("#formation-page .fp-reference .fp-p")).toEqual(["集約の検査は通りました"]);
    expect(await count("#formation-page .fp-reference .fp-ev-path")).toBe(0);
    const open = await mock("orca_open_url", null);
    await $("#formation-page .fp-pr button").click();
    expect(await waitForCalls(open)).toEqual([{ url: "https://github.com/o/r/pull/7" }]);
    await expect($("#formation-page .fp-pr .fp-error")).not.toBeDisplayed();
  });

  it("shows the reason in the place of the pull request when there is none", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", pr: { url: null, note: "ベースにない変更がありません" } }));
    expect(await textsOf("#formation-page .fp-pr .fp-p")).toEqual(["ベースにない変更がありません"]);
    expect(await count("#formation-page .fp-pr button")).toBe(0);
  });

  it("gives a URL that is not https no button", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", pr: { url: "http://example.com/pr/1", note: null } }));
    expect(await textsOf("#formation-page .fp-pr .fp-ev-path")).toEqual(["http://example.com/pr/1"]);
    expect(await count("#formation-page .fp-pr button")).toBe(0);
  });

  it("draws no pull request on a code review that has none", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", pr: null }));
    expect(await count("#formation-page .fp-pr")).toBe(0);
  });

  it("shows the reason when the pull request cannot be opened", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", pr: { url: "https://github.com/o/r/pull/7", note: null } }));
    await mock("orca_open_url", rejects("ブラウザを開けません"));
    await $("#formation-page .fp-pr button").click();
    await expect($("#formation-page .fp-pr .fp-error")).toHaveText("ブラウザを開けません");
  });

  it("draws the blocks, the facts and the evidence of a card behind 詳しく見る", async () => {
    const card = decisionCard("Q1", {
      background: "今の上限は 5 回",
      facts: [{ label: "場所", value: "api/auth", content: null }],
      blocks: [
        { type: "heading", text: "比べ方" },
        { type: "paragraph", text: "二つの案" },
        { type: "list", items: ["一つめ", "二つめ"] },
        { type: "callout", text: "注意してください" },
        { type: "table", header: ["案", "回数"], rows: [[{ text: "A", changed: false }, { text: "5", changed: true }]] },
        { type: "before-after", before: [{ type: "paragraph", text: "前の文" }], after: [{ type: "paragraph", text: "後の文" }], beforeCaption: null, afterCaption: "直したあと" },
        { type: "folded", summary: "詳しい理由", blocks: [{ type: "paragraph", text: "畳んだ文" }] },
      ],
      evidence: [
        { type: "excerpt", root: "deliverables", path: "design.md", start: 10, end: 12, highlight: [11], note: "ここが要", lines: ["一行め", "二行め", "三行め"] },
        {
          type: "diff",
          summary: "文言を変えた",
          name: "a.txt",
          before_source: "設計書（現行）",
          after_source: "基本設計 DESIGN-01",
          note: null,
          rows: [
            { kind: "hunk", left_no: null, left: "@@ -1,2 +1,3 @@", left_mark: null, right_no: null, right: null, right_mark: null },
            { kind: "context", left_no: 1, left: "同じ", left_mark: null, right_no: 1, right: "同じ", right_mark: null },
            { kind: "change", left_no: 2, left: "古い文言", left_mark: [0, 2], right_no: 2, right: "新しい文言", right_mark: [0, 3] },
            { kind: "change", left_no: null, left: null, left_mark: null, right_no: 3, right: "足した行", right_mark: null },
          ],
        },
        { type: "current", note: "変更後は基本設計で決めます", excerpts: [{ type: "excerpt", root: "deliverables", path: "now.md", start: 3, end: 4, highlight: [3], note: null, lines: ["今の一行", "今の二行"] }] },
        {
          type: "git-diff",
          summary: "回数を直した",
          root: "api",
          path: "lock.rb",
          base: "main",
          head: null,
          note: null,
          truncated: true,
          rows: [
            { kind: "hunk", left_no: null, left: "@@ -1,2 +1,2 @@", left_mark: null, right_no: null, right: null, right_mark: null },
            { kind: "change", left_no: 1, left: "LIMIT = 5", left_mark: [8, 9], right_no: 1, right: "LIMIT = 10", right_mark: [8, 10] },
            { kind: "context", left_no: 2, left: "keep", left_mark: null, right_no: 2, right: "keep", right_mark: null },
          ],
        },
        {
          type: "node",
          root: "deliverables",
          ref: "design.json#/designs/DESIGN-01",
          note: null,
          text: JSON.stringify(
            {
              id: "DESIGN-01",
              name: "認証の上限",
              kind: "api",
              repository: "api",
              release: 1,
              requirements: ["REQ-01"],
              depends_on: [{ id: "DESIGN-02", reason: "順番" }],
              purpose: "上限を決める",
              approach: "**回数**を数える",
              ui_spec: null,
              scope: { includes: "- 認証", excludes: "なし" },
              acceptance: ["5 回で止まる"],
              test_policy: "単体",
              user_confirmations: [],
              key_decisions: "回数は定数にする",
              decisions: [{ subject: "回数", recommended: "A", reason: "短い", options: [{ label: "5 回", description: "今のまま" }, { label: "10 回", description: "緩める" }], impact: ["api", "web"] }],
              extra_materials: [],
              inapplicable_materials: [{ name: "画面資料", reason: "画面はない" }],
            },
            null,
            2,
          ),
        },
      ],
    });
    await openPage(decisionPage({ questions: [card] }));
    // What 詳しく見る folds is not in the text of the card: it is in the drawer, which opens with the button, as the tabs 詳細 and 根拠 (and the tab of the fold inside 詳細).
    expect(await count("#formation-page .fp-scroll .fp-facts, #formation-page .fp-scroll .fp-evidence, #formation-page .fp-scroll .fp-callout")).toBe(0);
    await expect($(DRAWER)).not.toBeDisplayed();
    await $('#formation-page [data-card="Q1"] > .fp-fold-btn').click();
    await expect($(DRAWER)).toBeDisplayed();
    expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 詳細"]);
    expect(await tabs()).toEqual(["詳細", "詳しい理由", "根拠"]);
    const more = PANEL;
    expect(await textsOf(`${more} .fp-h`)).toEqual(["背景", "比べ方"]);
    expect(await textsOf(`${more} .fp-facts dt`)).toEqual(["場所"]);
    expect(await textsOf(`${more} .fp-facts dd`)).toEqual(["api/auth"]);
    expect(await textsOf(`${more} .fp-list li`)).toEqual(["一つめ", "二つめ"]);
    expect(await textsOf(`${more} .fp-callout`)).toEqual(["注意してください"]);
    const blockTable = `${more} .fp-table:not(.fp-doc .fp-table)`;
    expect(await textsOf(`${blockTable} th`)).toEqual(["案", "回数"]);
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} td`)].map((e) => (e as HTMLElement).dataset.changed ?? ""), blockTable)).toEqual(["", "true"]);
    expect(await textsOf(`${more} > .fp-before-after .fp-side-caption`)).toEqual(["今", "直したあと"]);
    expect(await textsOf(`${more} > .fp-fold-btn`)).toEqual(["詳しい理由"]);
    // The fold inside it is a tab of its own beside it.
    await $(`${more} > .fp-fold-btn`).click();
    expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 詳しい理由"]);
    expect(await textsOf(`${PANEL} .fp-p`)).toEqual(["畳んだ文"]);
    await tab("根拠").click();
    expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 根拠"]);
    // An excerpt has the numbers of its lines, and marks the highlighted one.
    const excerpt = `${more} .fp-evidence > [data-evidence="excerpt"]`;
    expect(await textsOf(`${excerpt} .fp-ln`)).toEqual(["10", "11", "12"]);
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} .fp-line`)].map((e) => (e as HTMLElement).dataset.highlight ?? ""), excerpt)).toEqual(["", "true", ""]);
    expect(await textsOf(`${excerpt} .fp-ev-note`)).toEqual(["ここが要"]);
    const kinds = (selector: string) => browser.execute((s) => [...document.querySelectorAll(s)].map((e) => (e as HTMLElement).dataset.kind), selector);
    // A difference: its two sides side by side, the characters that changed marked, and where each side comes from.
    const diff = `${more} [data-evidence="diff"]`;
    expect(await textsOf(`${diff} > .fp-ev-summary`)).toEqual(["文言を変えた"]);
    expect(await count(`${diff} .fp-diff-sides .fp-diff-row`)).toBe(3);
    expect(await textsOf(`${diff} .fp-diff-sides .fp-diff-row .fp-ln`)).toEqual(["1", "1", "2", "2", "", "3"]);
    expect(await textsOf(`${diff} .fp-diff-sides .fp-diff-row .fp-lc`)).toEqual(["同じ", "同じ", "古い文言", "新しい文言", "", "足した行"]);
    expect(await kinds(`${diff} .fp-diff-sides .fp-diff-row .fp-line`)).toEqual(["ctx", "ctx", "del", "ins", "empty", "ins"]);
    expect(await textsOf(`${diff} .fp-diff-sides .fp-diff-mark`)).toEqual(["古い", "新しい"]);
    expect(await textsOf(`${diff} .fp-diff-sides > .fp-line[data-kind="hunk"]`)).toEqual(["@@ -1,2 +1,3 @@"]);
    // The narrow view is one column: a line both share once, then the deletions of a run before its insertions.
    expect(await kinds(`${diff} .fp-diff-column .fp-line`)).toEqual(["hunk", "ctx", "del", "ins", "ins"]);
    expect(await textsOf(`${diff} > .fp-ev-note`)).toEqual(["変更前の出典: 設計書（現行）", "変更後の出典: 基本設計 DESIGN-01"]);
    // What is there now, with the note of where the after-state is decided.
    const current = `${more} [data-evidence="current"]`;
    expect(await textsOf(`${current} > .fp-ev-summary`)).toEqual(["今のコード変更後は基本設計で決めます"]);
    expect(await textsOf(`${current} .fp-badge`)).toEqual(["今のコード"]);
    expect(await textsOf(`${current} [data-evidence="excerpt"] .fp-ln`)).toEqual(["3", "4"]);
    // A git diff is drawn the same way, with the two revisions as its sources.
    const git = `${more} [data-evidence="git-diff"]`;
    expect(await kinds(`${git} .fp-diff-sides .fp-line`)).toEqual(["hunk", "del", "ins", "ctx", "ctx"]);
    expect(await textsOf(`${git} .fp-diff-sides .fp-diff-mark`)).toEqual(["5", "10"]);
    expect(await textsOf(`${git} .fp-ev-range`)).toEqual(["main → 作業ツリー"]);
    expect(await textsOf(`${git} > .fp-ev-note`)).toEqual(["変更前の出典: api/lock.rb（main）", "変更後の出典: api/lock.rb（作業ツリー）", "途中で切れています"]);
    // A node of design.json is drawn as the design item: its headings, its Markdown, its decision and its tables.
    const node = `${more} [data-evidence="node"]`;
    expect(await textsOf(`${node} .fp-doc > .fp-doc-title`)).toEqual(["DESIGN-01: 認証の上限"]);
    expect(await textsOf(`${node} .fp-doc > .fp-muted`)).toEqual(["種別: api / 対象リポジトリ: api / リリース: 1 / 要件: REQ-01 / 依存先: DESIGN-02"]);
    expect(await textsOf(`${node} .fp-doc-sub`)).toEqual(["目的", "アプローチ", "対象スコープ", "含む", "含まない", "完了条件", "テスト方針", "主要な設計判断", "選択肢と推奨案: 回数", "関連設計資料"]);
    expect(await textsOf(`${node} .fp-md strong`)).toEqual(["回数"]);
    expect(await textsOf(`${node} .fp-doc-block .fp-doc-list > li strong`)).toEqual(["(A) 5 回", "(B) 10 回"]);
    expect(await textsOf(`${node} .fp-doc-block > .fp-doc-text`)).toEqual(["推奨案は (A) 5 回（採択）、推奨理由は次のとおり。", "選択肢:", "影響範囲: api（主区分） / web"]);
    expect(await textsOf(`${node} .fp-table td`)).toEqual(["画面資料", "なし", "画面はない"]);
  });

  it("draws a node of requirement.json as the requirement, a shared material and an appendix, and any other node by its fields", async () => {
    const node = (ref: string, value: unknown) => ({ type: "node" as const, root: "deliverables", ref, note: null, text: JSON.stringify(value, null, 2) });
    const card = decisionCard("Q1", {
      evidence: [
        node("requirement.json#/requirements/REQ-01", {
          id: "REQ-01",
          name: "上限",
          summary: "回数を決める",
          expected_behaviors: ["5 回で止まる", "**10 回目**は通る"],
          user_decisions: [{ id: "UD-01", title: "回数", body: "5 回にする", provisional: true }],
          user_decision_refs: ["UD-09"],
          related_appendices: [{ topic: "limits", role: "一覧" }],
          extra_materials: [],
          inapplicable_materials: [],
        }),
        node("requirement.json#/shared/limits", { topic: "limits", name: "上限の一覧", applies_to: [{ id: "REQ-01", role: "基準" }], body: "表です", user_decisions: [] }),
        node("requirement.json#/appendices/limits", { topic: "limits", name: "上限の一覧", category: "集計", body: "- 五つ" }),
        node("requirement.json#/requirements/REQ-01/user_decisions/UD-01", { id: "UD-01", title: "回数", body: "本文", provisional: false }),
        node("requirement.json#/scope", { in_scope: "認証", design_scope: { api_contract: null }, list: ["a", "b"] }),
      ],
    });
    await openPage(decisionPage({ questions: [card] }));
    // A card with nothing for 詳細 opens 根拠 alone, with no tab to choose.
    await $('#formation-page [data-card="Q1"] > .fp-fold-btn').click();
    expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 根拠"]);
    await expect($(`${DRAWER} .fp-dr-tabs`)).not.toBeDisplayed();
    const more = PANEL;
    const at = (n: number) => `${more} .fp-evidence > .fp-ev:nth-child(${n})`;
    expect(await textsOf(`${at(1)} .fp-doc > .fp-doc-title`)).toEqual(["REQ-01: 上限"]);
    expect(await textsOf(`${at(1)} .fp-doc-sub`)).toEqual(["概要", "期待される動作", "関連 User Decision", "UD-01: 回数 仮置き（ビジネス側の確認待ち）", "関連要件資料"]);
    expect(await textsOf(`${at(1)} .fp-doc-li`)).toEqual(["5 回で止まる", "10 回目は通る"]);
    expect(await textsOf(`${at(1)} .fp-md strong`)).toEqual(["10 回目"]);
    expect(await textsOf(`${at(1)} .fp-provisional`)).toEqual(["仮置き（ビジネス側の確認待ち）"]);
    expect(await textsOf(`${at(1)} .fp-doc > .fp-doc-list > li`)).toEqual(["5 回で止まる", "10 回目は通る", "UD-09"]);
    expect(await textsOf(`${at(1)} .fp-table td`)).toEqual(["limits", "あり", "一覧"]);
    expect(await textsOf(`${at(2)} .fp-doc-title`)).toEqual(["上限の一覧 limits"]);
    expect(await textsOf(`${at(2)} .fp-table th`)).toEqual(["適用 REQ", "本 REQ での位置づけ"]);
    expect(await textsOf(`${at(2)} .fp-table td`)).toEqual(["REQ-01", "基準"]);
    expect(await textsOf(`${at(2)} .fp-doc-sub`)).toEqual(["適用対象", "内容"]);
    expect(await textsOf(`${at(3)} .fp-doc-title`)).toEqual(["上限の一覧 limits"]);
    expect(await textsOf(`${at(3)} .fp-muted`)).toEqual(["種別: 集計"]);
    expect(await textsOf(`${at(3)} .fp-md li`)).toEqual(["五つ"]);
    expect(await textsOf(`${at(4)} .fp-doc-sub`)).toEqual(["UD-01: 回数"]);
    expect(await count(`${at(4)} .fp-provisional`)).toBe(0);
    // A node with no template of its own is its fields: an object as names and values, an array as a list, nothing as 「未設定」.
    expect(await textsOf(`${at(5)} .fp-doc-root > .fp-doc-fields > dt`)).toEqual(["in_scope", "design_scope", "list"]);
    expect(await textsOf(`${at(5)} .fp-doc-fields .fp-doc-fields dt`)).toEqual(["api_contract"]);
    expect(await textsOf(`${at(5)} .fp-missing`)).toEqual(["未設定"]);
    expect(await textsOf(`${at(5)} .fp-doc-list > li`)).toEqual(["a", "b"]);
  });

  it("puts the text of a page in as text and never as HTML", async () => {
    const hostile = '<img src=x onerror="document.title=1"><b>太字</b>';
    await openFlow([asking({ pendingPage: { title: hostile, atMs: MARK_AT } })], {
      formation_page_read: decisionPage({ title: hostile, what: null, questions: [decisionCard("Q1", { title: hostile, summary: hostile })] }),
    });
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    await $(OPEN).click();
    await expect($("#formation-page .fp-title")).toHaveText(hostile);
    expect(await count("#formation-page img, #formation-page b, #formation-tabs img, #formation-flow-list img, #formation-flow-pages img, #formation-flow-pages b")).toBe(0);
    expect(await textsOf(PAGE_TAB)).toEqual([`●判断: ${hostile}`]);
    expect(await textsOf(`${OPEN} .formation-card-title`)).toEqual([`判断: ${hostile}`]);
  });

  it("draws a diagram with Mermaid as an SVG, and shows the source as text when it cannot", async () => {
    const good = "flowchart TD\n  A[開始] --> B[終了]";
    await openPage(decisionPage({ questions: [decisionCard("Q1", { options: [decisionOption("A", "案", null)], blocks: [{ type: "diagram", mermaid: good, caption: "流れ" }] })], changes: [] }));
    const box = '#formation-page [data-card="Q1"] .fp-diagram-box';
    await browser.waitUntil(async () => (await $(box).getAttribute("data-drawn")) === "true", { timeoutMsg: "Mermaid never drew the diagram" });
    expect(await count(`${box} svg`)).toBe(1);
    expect(await $(`${box} svg`).getAttribute("aria-label")).toBe("流れ");
    expect(await browser.execute((s) => document.querySelector(s)!.textContent, `${box} svg`)).toContain("開始");
    expect(await textsOf('#formation-page [data-card="Q1"] figcaption')).toEqual(["流れ"]);
    // The app's icon rule (`svg { width: 20px }`) does not shrink the diagram, and the first diagram of a card that asks is stretched to the width of the card (#1089, #1154).
    const size = await browser.execute((s) => {
      const svg = document.querySelector(s) as SVGSVGElement;
      const box = svg.parentElement as HTMLElement;
      const cs = getComputedStyle(box);
      return {
        width: svg.getBoundingClientRect().width,
        boxWidth: box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        fill: getComputedStyle(svg).fill,
        stroke: getComputedStyle(svg).stroke,
      };
    }, `${box} svg`);
    expect(size.width).not.toBe(20);
    expect(Math.abs(size.width - size.boxWidth)).toBeLessThan(1);
    expect(size.stroke).toBe("none");
    expect(await browser.execute(() => document.querySelectorAll('script[src$="mermaid.min.js"]').length)).toBe(1);
    // The diagram is in the card, not behind 詳しく見る.
    expect(await count('#formation-page [data-card="Q1"] .fp-fold-btn')).toBe(0);
  });

  it("draws a diagram behind 詳しく見る only when that fold is first opened", async () => {
    const good = "flowchart TD\n  A[開始] --> B[終了]";
    await openPage(
      decisionPage({
        questions: [
          decisionCard("Q1", {
            options: [decisionOption("A", "案", null)],
            blocks: [
              { type: "diagram", mermaid: good, caption: "表の図" },
              { type: "diagram", mermaid: good, caption: "中の図" },
            ],
          }),
        ],
        changes: [],
      }),
    );
    const boxes = '#formation-page [data-card="Q1"] .fp-diagram-box';
    const inside = `${DRAWER} .fp-diagram-box`;
    await browser.waitUntil(async () => $(`${boxes}[data-drawn="true"]`).isExisting(), { timeoutMsg: "the diagram of the card was not drawn" });
    // The diagram in the closed fold waits: it is not drawn and has no SVG.
    expect(await $(inside).getAttribute("data-pending")).toBe("true");
    expect(await $(inside).getAttribute("data-drawn")).toBe(null);
    expect(await count(`${inside} svg`)).toBe(0);
    await $('#formation-page [data-card="Q1"] > .fp-fold-btn').click();
    await browser.waitUntil(async () => (await $(inside).getAttribute("data-drawn")) === "true", { timeoutMsg: "the diagram was not drawn when the fold opened" });
    expect(await count(`${inside} svg`)).toBe(1);
    expect(await $(inside).getAttribute("data-pending")).toBe(null);
  });

  it("shows the Mermaid source as text when the diagram cannot be drawn", async () => {
    const bad = "flowchart TD\n  A[開始 --> ((";
    await openPage(decisionPage({ questions: [decisionCard("Q1", { blocks: [{ type: "paragraph", text: "x" }, { type: "diagram", mermaid: bad, caption: null }] })] }));
    const box = '#formation-page [data-card="Q1"] .fp-diagram-box';
    await browser.waitUntil(async () => (await $(box).getAttribute("data-failed")) === "true", { timeoutMsg: "the diagram did not fail" });
    expect(await count(`${box} svg`)).toBe(0);
    expect(await textsOf(`${box} .fp-diagram-source`)).toEqual([bad]);
    await expect($(`${box} .fp-diagram-source`)).toBeDisplayed();
  });

  // A card that asks of the earlier feature-dev: 「聞きたいこと」, the scene, the image of the screen, the flow, the choices and the details of each.
  const FLOW = "flowchart LR\n  subgraph S[共通の手順]\n    a[予約を受け付ける] --> b[診察が終わる]\n  end\n  subgraph OA[案 A の流れ]\n    c[会計待ちにできる<br/>（病院ごと）]\n  end\n  b --> c\n  classDef shared fill:#e8eefb,stroke:#2f5bd3,color:#1b2a4a\n  classDef resolves fill:#e8f3ec,stroke:#2e7d4f,color:#17402a\n  class a,b shared\n  class c resolves\n  style S fill:#f6f8fd,stroke:#2f5bd3\n  style OA fill:#f4faf6,stroke:#2e7d4f";
  const SHOT = { root: "deliverables", path: "ui/now.png", caption: "いまの画面" };
  const ASKING = decisionCard("Q1", {
    title: "会計待ちを選べるようにするか？",
    summary: "要約は出さない",
    scene: "診察を終えた予約を会計待ちにしようとしたとき、選べるかどうかが決まります。",
    sceneImage: SHOT,
    blocks: [
      { type: "diagram", mermaid: FLOW, caption: null },
      { type: "paragraph", text: "詳しい文" },
    ],
    conditions: [
      { id: "KO-01", text: "予約を失わない" },
      { id: "KO-02", text: "元に戻せる" },
    ],
    options: [
      decisionOption("A", "選べるようにする", "選ぶと会計待ちになる", {
        fix: "ステータスに会計待ちを足す",
        sample: { text: "会計待ち", fontSize: 18, fontWeight: 700, color: "#2f5bd3" },
        image: { root: "deliverables", path: "ui/after.png", caption: "直したあと" },
        diagram: "flowchart LR\n  x[選ぶ] --> y[会計待ち]",
      }),
      decisionOption("B", "今のままにする", null, { unmet: [{ id: "KO-02", reason: "戻す手段がありません" }] }),
    ],
    recommendation: "A",
    recommendationReason: "予約を失わないから",
    choiceDetails: { investigate: "調べるあいだ予約は今のままです" },
  });
  const CARD_Q = '#formation-page [data-card="Q1"]';

  it("opens a card that asks with 聞きたいこと, shows the scene and no summary, and draws the image of the screen in the card at 400px with 拡大する", async () => {
    await openPage(decisionPage({ questions: [ASKING] }));
    expect(await textsOf(`${CARD_Q} .fp-asks`)).toEqual(["聞きたいこと"]);
    expect(await textsOf(`${CARD_Q} .fp-card-head > *`)).toEqual(["Q1", "聞きたいこと", "会計待ちを選べるようにするか？"]);
    expect(await textsOf(`${CARD_Q} > .fp-p`)).toEqual(["診察を終えた予約を会計待ちにしようとしたとき、選べるかどうかが決まります。"]);
    expect(await textsOf(`${CARD_Q} > .fp-h`)).toEqual(["具体的な場面", "あなたの回答"]);
    expect(await browser.execute((s) => document.querySelector(s)!.textContent, CARD_Q)).not.toContain("要約は出さない");
    // The image is in the card, never in a fold, and is read by its root and path.
    expect(await count(`${CARD_Q} > .fp-image`)).toBe(1);
    expect(await waitForCalls("formation_page_image", 1)).toEqual([{ name: "formation", child: "req-login", root: "deliverables", path: "ui/now.png" }]);
    const picture = `${CARD_Q} > .fp-image img`;
    await browser.waitUntil(async () => (await count(picture)) === 1);
    const widthOf = () => browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().width, picture);
    expect(Math.round(await widthOf())).toBe(400);
    expect(await textsOf(`${CARD_Q} > .fp-image figcaption`)).toEqual(["いまの画面"]);
    await browser.waitUntil(async () => (await textsOf(`${CARD_Q} > .fp-image .fp-image-zoom`))[0] === "拡大する");
    await $(`${CARD_Q} > .fp-image .fp-image-zoom`).click();
    expect(await textsOf(`${CARD_Q} > .fp-image .fp-image-zoom`)).toEqual(["縮小する"]);
    expect(await widthOf()).toBeGreaterThan(400);
    await $(`${CARD_Q} > .fp-image .fp-image-zoom`).click();
    expect(Math.round(await widthOf())).toBe(400);
  });

  it("draws the first diagram of a card that asks as wide as the card, in the colors of its classDef and subgraph styles, and keeps the line break of a label", async () => {
    await openPage(decisionPage({ questions: [ASKING] }));
    const box = `${CARD_Q} > .fp-diagram .fp-diagram-box`;
    await browser.waitUntil(async () => (await $(box).getAttribute("data-drawn")) === "true", { timeoutMsg: "Mermaid never drew the diagram" });
    const drawn = await browser.execute((s) => {
      const svg = document.querySelector(`${s} svg`) as SVGSVGElement;
      const holder = svg.parentElement as HTMLElement;
      const cs = getComputedStyle(holder);
      const fillOf = (text: string) => {
        const label = [...svg.querySelectorAll("g.node")].find((g) => g.textContent?.includes(text));
        const shape = label?.querySelector("rect, polygon, path");
        return shape ? getComputedStyle(shape).fill : null;
      };
      const cluster = [...svg.querySelectorAll("g.cluster")].find((g) => g.textContent?.includes("案 A の流れ"));
      const joined = [...svg.querySelectorAll("g.node")].find((g) => g.textContent?.includes("会計待ちにできる"));
      return {
        width: svg.getBoundingClientRect().width,
        boxWidth: holder.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        shared: fillOf("予約を受け付ける"),
        resolves: fillOf("会計待ちにできる"),
        cluster: cluster?.querySelector("rect") ? getComputedStyle(cluster.querySelector("rect")!).fill : null,
        lines: joined ? [...joined.querySelectorAll("tspan")].map((t) => t.textContent) : [],
        text: svg.textContent ?? "",
      };
    }, box);
    expect(Math.abs(drawn.width - drawn.boxWidth)).toBeLessThan(1);
    expect(drawn.shared).toBe("rgb(232, 238, 251)");
    expect(drawn.resolves).toBe("rgb(232, 243, 236)");
    expect(drawn.cluster).toBe("rgb(244, 250, 246)");
    // `<br/>` is a line break, and is not drawn as the text `<br/>`.
    expect(drawn.text).not.toContain("<br");
    expect(drawn.lines.length).toBeGreaterThan(1);
  });

  it("opens 「この選択肢の詳細」 with the detail, 直し方, the sample in its style, the image, the diagram and the conditions the option fails, in that order", async () => {
    await openPage(decisionPage({ questions: [ASKING] }));
    const row = `${CARD_Q} [data-recommended="true"]`;
    const details = `${row} .fp-detail`;
    expect(await folded(details)).toBe(false);
    // Nothing of the fold is read before it is opened.
    expect(await count(`${details} img`)).toBe(0);
    expect(await callsOf("formation_page_image")).toHaveLength(1);
    await $(`${details} > summary`).click();
    expect(await folded(details)).toBe(true);
    expect(await browser.execute((s) => [...document.querySelector(s)!.children].slice(1).map((e) => e.className.split(" ")[0] || e.tagName.toLowerCase()), details)).toEqual(["fp-p", "fp-h", "fp-p", "fp-sample", "fp-image", "fp-diagram"]);
    expect(await textsOf(`${details} .fp-h`)).toEqual(["直し方"]);
    expect(await textsOf(`${details} .fp-p`)).toEqual(["選ぶと会計待ちになる", "ステータスに会計待ちを足す"]);
    const sample = await browser.execute((s) => {
      const frame = document.querySelector(`${s} .fp-sample-frame`) as HTMLElement;
      const style = getComputedStyle(frame);
      return { text: frame.textContent, size: style.fontSize, weight: style.fontWeight, color: style.color, note: document.querySelector(`${s} .fp-sample-note`)!.textContent };
    }, details);
    expect(sample).toEqual({ text: "会計待ち", size: "18px", weight: "700", color: "rgb(47, 91, 211)", note: "文字の大きさ 18px・太さ 700・色 #2f5bd3" });
    await browser.waitUntil(async () => (await count(`${details} img`)) === 1, { timeoutMsg: "the image of the option was not read" });
    expect(await waitForCalls("formation_page_image", 2)).toContainEqual({ name: "formation", child: "req-login", root: "deliverables", path: "ui/after.png" });
    expect(await textsOf(`${details} .fp-image figcaption`)).toEqual(["直したあと"]);
    await browser.waitUntil(async () => (await $(`${details} .fp-diagram-box`).getAttribute("data-drawn")) === "true", { timeoutMsg: "the diagram of the option was not drawn" });
    // The option that fails a condition says which, and why.
    const second = `${CARD_Q} .fp-choice:nth-child(3) .fp-detail`;
    await $(`${second} > summary`).click();
    expect(await textsOf(`${second} .fp-h`)).toEqual(["満たさない必須条件"]);
    expect(await textsOf(`${second} .fp-unmet > *`)).toEqual(["KO-02 元に戻せる", "戻す手段がありません"]);
    // A fixed choice has the details of its own key.
    const fixed = `${CARD_Q} .fp-choice:nth-child(4) .fp-detail`;
    await $(`${fixed} > summary`).click();
    expect(await textsOf(`${fixed} .fp-p`)).toEqual(["調べるあいだ予約は今のままです"]);
    expect(await count(`${CARD_Q} .fp-choice:nth-child(5) .fp-detail`)).toBe(0);
  });

  it("draws the conditions against the options as a table and the occurrence of the matter in 詳しく見る", async () => {
    const card = decisionCard("ND-1", {
      kind: "review-decision",
      title: "待たせるか？",
      scene: "ロックが取れないとき",
      options: [decisionOption("A", "待たせる"), decisionOption("B", "すぐ失敗にする", null, { unmet: [{ id: "KO-01", reason: "失敗が増えます" }] })],
      conditions: [{ id: "KO-01", text: "失敗を増やさない" }],
      recommendation: "A",
      recommendationReason: "r",
      occurrence: { conditions: ["同じ予約を二人が同時に開く"], likelihood: "occasional", basis: "実測: 手元で 3 回に 1 回起きた", impact: "片方の変更が消える", detectability: "気づかない" },
    });
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", needsUserDecision: [card, { ...card, number: "ND-2", occurrence: { ...card.occurrence!, conditions: ["一つめ", "二つめ"], likelihood: "rare" } }] }));
    // 詳細 holds the occurrence, and the table of the conditions is the tab 根拠 beside it.
    const more = PANEL;
    await $('#formation-page [data-card="ND-1"] > .fp-fold-btn').click();
    expect(await tabs()).toEqual(["詳細", "根拠"]);
    expect(await textsOf(`${more} .fp-h`)).toEqual(["発生条件", "発生頻度", "影響", "検知"]);
    expect(await textsOf(`${more} .fp-meter-cells`)).toEqual(["■■□"]);
    expect(await textsOf(`${more} .fp-meter-word`)).toEqual(["ときどき"]);
    expect(await textsOf(`${more} > .fp-muted`)).toEqual(["実測: 手元で 3 回に 1 回起きた"]);
    expect(await count(`${more} .fp-table`)).toBe(0);
    await tab("根拠").click();
    expect(await textsOf(`${more} .fp-table th`)).toEqual(["必須条件", "A", "B"]);
    expect(await textsOf(`${more} .fp-table td`)).toEqual(["KO-01 失敗を増やさない", "満たす", "満たさない"]);
    // Several conditions are a numbered list under the heading that says they must all hold.
    const second = PANEL;
    await $('#formation-page [data-card="ND-2"] > .fp-fold-btn').click();
    expect(await drawerTitle()).toEqual(["ND-2 待たせるか？ — 詳細"]);
    expect(await textsOf(`${second} .fp-h`)).toEqual(["発生条件（すべて重なったときだけ起きる）", "発生頻度", "影響", "検知"]);
    expect(await textsOf(`${second} ol.fp-list li`)).toEqual(["一つめ", "二つめ"]);
    expect(await textsOf(`${second} .fp-meter-cells`)).toEqual(["■□□"]);
  });

  it("shows an unmet release condition on the card that causes it, and in its own group only when no card of the page does", async () => {
    const ask = decisionCard("ND-1", { kind: "review-decision", title: "待たせるか？", scene: "場面", options: [decisionOption("A", "待たせる")], recommendation: "A", recommendationReason: "r" });
    const caused = decisionCard("UC-1", { kind: "unmet-criterion", title: "ロックを失わない", summary: "待たせないと失われます", cards: ["ND-1"] });
    const alone = decisionCard("UC-2", { kind: "unmet-criterion", title: "全件が通る", summary: "一件落ちます", cards: [] });
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", needsUserDecision: [ask], unmetCriteria: [caused, alone] }));
    expect(await textsOf('#formation-page [data-card="ND-1"] > .fp-h')).toEqual(["具体的な場面", "反するリリース条件", "あなたの回答"]);
    expect(await textsOf('#formation-page [data-card="ND-1"] .fp-cause')).toEqual(["ロックを失わない"]);
    expect(await count('#formation-page [data-card="UC-1"]')).toBe(0);
    expect(await count('#formation-page [data-card="UC-2"]')).toBe(1);
  });

  it("draws 「画面の AI 検証」 after the cards that need a decision: the failed and not-run cards open with their counts, the passed ones in a closed fold, and no answer", async () => {
    const image = (root: string, path: string, caption: string) => ({ root, path, caption });
    const ask = decisionCard("ND-1", { kind: "review-decision", title: "待たせるか？", scene: "場面", options: [decisionOption("A", "待たせる")], recommendation: "A", recommendationReason: "r" });
    const failed = verificationCard("SV-1", "一覧", {
      result: "fail",
      stateSetup: "予約が 3 件ある",
      steps: ["一覧を開く", "削除を押す"],
      expected: "確認が出る",
      basis: "確認が出ない",
      referenceImage: image("deliverables", "ui-references/list.png", "見本"),
      capturedImage: image("captures", "list.png", "撮影"),
    });
    const notRun = verificationCard("SV-2", "空の一覧", { result: "not-run", basis: "判定していません", missingReason: "ゴールの検証をしないで再開しました", referenceImage: image("screenshots", "empty.png", "空の見本") });
    const passes = [
      verificationCard("SV-3", "ヘッダー", { referenceImage: image("deliverables", "ui-references/head.png", "見本"), capturedImage: image("captures", "head.png", "撮影") }),
      verificationCard("SV-4", "フッター", { capturedImage: image("captures", "foot.png", "撮影") }),
    ];
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", needsUserDecision: [ask], screenVerifications: [failed, notRun, ...passes] }));
    const group = "#formation-page .fp-verifications";
    expect(await textsOf("#formation-page .fp-group > .fp-sec")).toEqual(["判断が必要 1 件", "画面の AI 検証"]);
    expect(await textsOf(`${group} .fp-verify-counts`)).toEqual(["不合格 1 件・未実施 1 件・合格 2 件"]);
    // The failed and the not-run cards stand open at the top, each with its result tag; the passed ones wait in one closed fold and have no tag.
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} > .fp-card`)].map((e) => (e as HTMLElement).dataset.card), group)).toEqual(["SV-1", "SV-2"]);
    expect(await textsOf(`${group} > .fp-card > .fp-card-head > .fp-result`)).toEqual(["不合格", "未実施"]);
    expect(await textsOf(`${group} > .fp-verify-pass > summary`)).toEqual(["合格 2 件の内容を見る"]);
    expect(await folded(`${group} > .fp-verify-pass`)).toBe(false);
    expect(await count(`${group} > .fp-verify-pass .fp-result`)).toBe(0);
    expect(await count(`${group} .fp-answer`)).toBe(0);
    expect(await textsOf(`${group} > .fp-card:first-of-type > .fp-p`)).toEqual(["一覧を見た"]);
    // No image is read before a fold is opened.
    expect(await callsOf("formation_page_image")).toHaveLength(0);
    const first = PANEL;
    await $(`${group} [data-card="SV-1"] > .fp-fold-btn`).click();
    expect(await drawerTitle()).toEqual(["SV-1 一覧 — 詳細"]);
    expect(await textsOf(`${first} > .fp-h`)).toEqual(["確認したこと", "状態の作り方", "操作", "操作のあとに出るもの", "結果と根拠"]);
    expect(await textsOf(`${first} > .fp-p`)).toEqual(["一覧の観点", "予約が 3 件ある", "確認が出る", "不合格 確認が出ない"]);
    expect(await textsOf(`${first} ol.fp-list li`)).toEqual(["一覧を開く", "削除を押す"]);
    expect(await textsOf(`${first} .fp-verify-col > .fp-h`)).toEqual(["参照画像", "撮影画像"]);
    expect(await waitForCalls("formation_page_image", 2)).toEqual(expect.arrayContaining([
      { name: "formation", child: "req-login", root: "deliverables", path: "ui-references/list.png" },
      { name: "formation", child: "req-login", root: "captures", path: "list.png" },
    ]));
    await browser.waitUntil(async () => (await count(`${first} .fp-verify-col img`)) === 2, { timeoutMsg: "the two images were not drawn" });
    // The two columns stand side by side.
    const rects = await browser.execute((s) => [...document.querySelectorAll(`${s} .fp-verify-col`)].map((e) => e.getBoundingClientRect()).map((r) => ({ left: Math.round(r.left), top: Math.round(r.top) })), first);
    expect(rects[0].top).toBe(rects[1].top);
    expect(rects[1].left).toBeGreaterThan(rects[0].left);
    // A card that was not run says why in the place of the capture.
    const second = PANEL;
    await $(`${group} [data-card="SV-2"] > .fp-fold-btn`).click();
    expect(await textsOf(`${second} > .fp-h`)).toEqual(["確認したこと", "結果と根拠"]);
    expect(await textsOf(`${second} .fp-verify-col > .fp-h`)).toEqual(["参照画像", "撮影画像"]);
    expect(await textsOf(`${second} .fp-missing`)).toEqual(["未取得: ゴールの検証をしないで再開しました"]);
    expect(await waitForCalls("formation_page_image", 3)).toContainEqual({ name: "formation", child: "req-login", root: "screenshots", path: "empty.png" });
    // The fold of the passed cards opens to cards that carry the images they have and no result tag.
    await $(`${group} > .fp-verify-pass > summary`).click();
    const pass = PANEL;
    await $(`${group} [data-card="SV-4"] > .fp-fold-btn`).click();
    expect(await textsOf(`${pass} .fp-verify-col > .fp-h`)).toEqual(["撮影画像"]);
    expect(await textsOf(`${pass} > .fp-p`)).toEqual(["フッターの観点", "フッターの根拠"]);
    expect(await waitForCalls("formation_page_image", 4)).toContainEqual({ name: "formation", child: "req-login", root: "captures", path: "foot.png" });
  });

  it("heads a group of passed cards alone with a note that no answer is needed, and draws it for a page that has only that group", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", screenVerifications: [verificationCard("SV-1", "一覧"), verificationCard("SV-2", "詳細")] }));
    const group = "#formation-page .fp-verifications";
    expect(await textsOf(`${group} .fp-verify-counts`)).toEqual(["すべて合格しました。回答は要りません。"]);
    expect(await count(`${group} > .fp-card`)).toBe(0);
    expect(await textsOf(`${group} > .fp-verify-pass > summary`)).toEqual(["合格 2 件の内容を見る"]);
    expect(await folded(`${group} > .fp-verify-pass`)).toBe(false);
  });

  it("gives a fact its 「中身を見る」: a node as the deliverable draws it, Markdown formatted, a file as text and an image as an image, and no raw HTML", async () => {
    const card = decisionCard("Q1", {
      scene: "場面",
      options: [decisionOption("A", "案")],
      recommendation: "A",
      recommendationReason: "r",
      facts: [
        { label: "設計", value: "第二の設計", content: { type: "node", root: "deliverables", ref: "design.json#/designs/DESIGN-02", text: JSON.stringify({ id: "DESIGN-02", name: "第二の設計", purpose: "目的の文" }, null, 2) } },
        { label: "メモ", value: "議事", content: { type: "markdown", root: "deliverables", path: "memo.md", text: "# 見出し\n\n- 一つめ\n- 二つめ\n\n[外へ](https://example.com/a) [中へ](../x.md) <img src=x onerror=\"document.title=1\"><b>raw</b>\n" } },
        { label: "ログ", value: "出力", content: { type: "text", root: "repo", path: "out.txt", text: "line 1\nline 2" } },
        { label: "画面", value: "いまの画面", content: { type: "image", root: "deliverables", path: "ui/now.png", caption: "いまの画面" } },
        { label: "なし", value: "引かない", content: null },
      ],
    });
    await openPage(decisionPage({ questions: [card] }));
    const open = () => $(`${CARD_Q} > .fp-fold-btn`).click();
    await open();
    expect(await textsOf(`${PANEL} .fp-facts dt`)).toEqual(["設計", "メモ", "ログ", "画面", "なし"]);
    // Each fact that cites something has 「中身を見る」, whose content is a tab of the card beside 詳細.
    expect(await textsOf(`${PANEL} .fp-facts .fp-fold-btn`)).toEqual(["中身を見る", "中身を見る", "中身を見る", "中身を見る"]);
    expect(await tabs()).toEqual(["詳細", "中身を見る: 第二の設計", "中身を見る: 議事", "中身を見る: 出力", "中身を見る: いまの画面"]);
    // The content of a fact is shown in its own tab, in a panel of its own.
    const fact = PANEL;
    for (const n of [1, 2, 3, 4]) {
      await open();
      await $(`${PANEL} .fp-facts dd:nth-of-type(${n}) > .fp-fold-btn`).click();
      await browser.waitUntil(async () => (await count(`${DRAWER} .fp-dr-panel:not([hidden])`)) === 1);
      if (n === 1) {
        expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 中身を見る: 第二の設計"]);
        expect(await textsOf(`${fact} .fp-doc > .fp-doc-title`)).toEqual(["DESIGN-02: 第二の設計"]);
        expect(await textsOf(`${fact} .fp-md`)).toEqual(["目的の文"]);
      }
      if (n === 2) {
        expect(await textsOf(`${fact} h1`)).toEqual(["見出し"]);
        expect(await textsOf(`${fact} li`)).toEqual(["一つめ", "二つめ"]);
        // A link to the web stays a link; one that is not http(s) is text only; raw HTML is no markup.
        expect(await browser.execute((s) => [...document.querySelectorAll(`${s} a`)].map((a) => a.getAttribute("href")), fact)).toEqual(["https://example.com/a", null]);
        expect(await count(`${fact} img, ${fact} b, ${fact} [onerror]`)).toBe(0);
      }
      if (n === 3) expect(await textsOf(`${fact} .fp-pre`)).toEqual(["line 1\nline 2"]);
      if (n === 4) {
        await browser.waitUntil(async () => (await count(`${fact} img`)) === 1, { timeoutMsg: "the image of the fact was not read" });
        expect(await textsOf(`${fact} .fp-image-zoom`)).toEqual(["拡大する"]);
      }
    }
  });

  it("closes the tab when the mark is gone and shows the tab that was selected before", async () => {
    await openFlow([asking(), formationChild("api-update", "working")], { ...timers({ formationFlow: READ, orcaMirror: MIRROR }), orca_terminal_read: ["$ claude", "> 確認します"], formation_page_read: decisionPage() });
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    await card("api-update").click();
    await expect($("#formation-teammate-term")).toBeDisplayed();
    await $(OPEN).click();
    await expect($("#formation-page")).toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    await mock("formation_children", [formationChild("req-login", "working"), formationChild("api-update", "working")]);
    await browser.waitUntil(async () => !(await $(PAGE_TAB).isExisting()), { timeoutMsg: "the tab never closed" });
    await expect($("#formation-page")).not.toBeDisplayed();
    expect(await count("#formation-page > *")).toBe(0);
    await expect($("#formation-teammate-term")).toBeDisplayed();
    expect(await count("#formation-flow-pages .formation-card")).toBe(0);
    await expect($("#formation-flow-pages")).not.toBeDisplayed();
    expect(await textsOf('#formation-flow-list [data-name="req-login"] .formation-card-state')).toEqual(["作業中"]);
  });

  it("reads the page again when the time of the mark changes, and not before", async () => {
    await openPage(decisionPage({ title: "最初のページ" }));
    await expect($("#formation-page .fp-title")).toHaveText("最初のページ");
    await mock("formation_page_read", decisionPage({ title: "置き換えたページ" }));
    await mock("formation_children", [asking({ pendingPage: { title: "置き換えたページ", atMs: MARK_AT + 60_000 } })]);
    await browser.waitUntil(async () => (await $("#formation-page .fp-title").getText()) === "置き換えたページ", { timeoutMsg: "the page was never read again" });
    expect(await pageCall()).toHaveLength(1);
    await expect($(PAGE_TAB)).toHaveAttribute("aria-selected", "true");
    expect(await textsOf("#formation-page .fp-title")).toEqual(["置き換えたページ"]);
  });

  it("says why when the page cannot be read, and reads it again when the tab is pressed again", async () => {
    await openFlow([asking()], { formation_page_read: rejects("$.questions[0].title: 空です\n$.what: ありません") });
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    await $(OPEN).click();
    await expect($("#formation-page .fp-error")).toBeDisplayed();
    expect(await rawTextsOf("#formation-page .fp-error")).toEqual(["$.questions[0].title: 空です\n$.what: ありません"]);
    await mock("formation_page_read", decisionPage({ title: "直したページ" }));
    await $("#formation-tab-leader-main").click();
    await $(PAGE_TAB).click();
    await expect($("#formation-page .fp-title")).toHaveText("直したページ");
  });

  const SEND = "#formation-page .fp-send-btn";
  const SEND_ERROR = "#formation-page .fp-send .fp-error";
  const QUESTION_2 = decisionCard("Q2", { title: "いつまでに決めるか", options: [decisionOption("A", "今週", null)], recommendation: "A", recommendationReason: "早い" });
  const answerCalls = () => callsOf("formation_page_answer");

  it("sends what was chosen to the leader with the mark's time, and reads the questions' choices and free text as they stand", async () => {
    await openPage(decisionPage({ questions: [QUESTION, QUESTION_2] }));
    await expect($(SEND)).toHaveText("リーダーに送る");
    // An open-questions page has no verdict to choose, and its button is ready.
    expect(await count("#formation-page .fp-verdict")).toBe(0);
    await expect($(SEND)).toBeEnabled();
    await $('#formation-page [data-card="Q1"] input[value="B"]').click();
    await $('#formation-page [data-card="Q2"] input[value="other"]').click();
    await $('#formation-page [data-card="Q2"] .fp-text').setValue("来週の頭");
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([
      {
        name: "formation",
        child: "req-login",
        atMs: MARK_AT,
        answers: [
          { card: "Q1", choice: "B", note: "", provisional: false },
          { card: "Q2", choice: "other", note: "来週の頭", provisional: false },
        ],
        verdict: null,
        revision: "",
      },
    ]);
  });

  it("sends a card with no choice as no choice, and a note on a card with fixed choices as it is typed", async () => {
    const approval = decisionPage({
      pageKind: "approval",
      subject: "design",
      what: "設計を承認します",
      residualMustFix: [decisionCard("MF-1", { kind: "must-fix", recommendation: "fix", recommendationReason: "壊れる" })],
      structuralProposals: [decisionCard("SP-1", { kind: "structural-proposal", recommendation: "approve", recommendationReason: "重複が減る" })],
      adr: decisionCard("ADR-1", { kind: "adr", recommendation: "keep", recommendationReason: "残す価値がある" }),
      unmetCriteria: [],
      qualityLoop: { rounds: 2, fixCycles: 1, mustFixResolved: 3 },
    });
    await openPage(approval);
    await $('#formation-page [data-card="MF-1"] input[value="skip"]').click();
    await $('#formation-page [data-card="SP-1"] input[value="reject"]').click();
    await $('#formation-page [data-card="SP-1"] .fp-text').setValue("重複は減らない");
    await $(`${VERDICT} input[value="approve"]`).click();
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([
      {
        name: "formation",
        child: "req-login",
        atMs: MARK_AT,
        answers: [
          { card: "MF-1", choice: "skip", note: "", provisional: false },
          { card: "SP-1", choice: "reject", note: "重複は減らない", provisional: false },
          { card: "ADR-1", choice: null, note: "", provisional: false },
        ],
        verdict: "approve",
        revision: "",
      },
    ]);
  });

  it("sends a page with no card that asks, with no answer", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です", qualityLoop: null }));
    await $(`${VERDICT} input[value="approve"]`).click();
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([{ name: "formation", child: "req-login", atMs: MARK_AT, answers: [], verdict: "approve", revision: "" }]);
  });

  it("keeps the page and the answers, and says why, when the reply could not be sent, and sends again when it is pressed again", async () => {
    await openPage(decisionPage({ questions: [QUESTION, QUESTION_2] }));
    await mock("formation_page_answer", rejects("回答が必要なカードが未回答です: Q2"));
    await $('#formation-page [data-card="Q1"] input[value="A"]').click();
    await $(SEND).click();
    await expect($(SEND_ERROR)).toBeDisplayed();
    expect(await rawTextsOf(SEND_ERROR)).toEqual(["回答が必要なカードが未回答です: Q2"]);
    await expect($(SEND_ERROR)).toHaveAttribute("role", "alert");
    // The tab, the page and the choice stay, and the button can be pressed again.
    await expect($(PAGE_TAB)).toBeDisplayed();
    await expect($("#formation-page .fp-title")).toBeDisplayed();
    await expect($('#formation-page [data-card="Q1"] input[value="A"]')).toBeSelected();
    await expect($(SEND)).toBeEnabled();
    expect(await answerCalls()).toHaveLength(1);
    await mock("formation_page_answer", null);
    await $('#formation-page [data-card="Q2"] input[value="A"]').click();
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([
      {
        name: "formation",
        child: "req-login",
        atMs: MARK_AT,
        answers: [
          { card: "Q1", choice: "A", note: "", provisional: false },
          { card: "Q2", choice: "A", note: "", provisional: false },
        ],
        verdict: null,
        revision: "",
      },
    ]);
    await expect($(SEND_ERROR)).not.toBeDisplayed();
  });

  const VERDICT = "#formation-page .fp-verdict";
  const verdictRadio = (key: string) => $(`${VERDICT} input[value="${key}"]`);
  const approvalPage = (extra: Partial<DecisionPage> = {}) =>
    decisionPage({
      pageKind: "approval",
      subject: "design",
      what: "設計を承認します",
      needsUserDecision: [decisionCard("NR-1", { kind: "nr", title: "どちらにするか", options: [decisionOption("A", "案 A", null)], recommendation: "A", recommendationReason: "単純" })],
      residualMustFix: [decisionCard("MF-1", { kind: "must-fix", recommendation: "fix", recommendationReason: "壊れる" })],
      structuralProposals: [decisionCard("SP-1", { kind: "structural-proposal", recommendation: "approve", recommendationReason: "重複が減る" })],
      qualityLoop: { rounds: 2, fixCycles: 1, mustFixResolved: 3 },
      ...extra,
    });

  it("puts 「あなたの判定」 under the cards with the two choices of the page's subject, and sends nothing until one is chosen", async () => {
    await openPage(approvalPage());
    expect(await textsOf(`${VERDICT} .fp-sec`)).toEqual(["あなたの判定"]);
    expect(await textsOf(`${VERDICT} .fp-choice-label`)).toEqual(["基本設計を承認する", "基本設計の修正を依頼する"]);
    // The verdict is below the cards, at the end of the page, and the button is in the bottom bar. Nothing is chosen at first.
    expect(await browser.execute((s) => document.querySelector(s)!.nextElementSibling, VERDICT)).toBe(null);
    expect(await count("#formation-page .fp-bar-bottom .fp-send .fp-send-btn")).toBe(1);
    await expect(verdictRadio("approve")).not.toBeSelected();
    await expect(verdictRadio("revise")).not.toBeSelected();
    await expect($(SEND)).toBeDisabled();
    await $(SEND).click();
    expect(await answerCalls()).toHaveLength(0);
    await verdictRadio("revise").click();
    await expect($(SEND)).toBeEnabled();
  });

  it("words the verdict of a requirement's approval by the requirement", async () => {
    await openPage(approvalPage({ subject: "requirement" }));
    expect(await textsOf(`${VERDICT} .fp-choice-label`)).toEqual(["要件定義を承認する", "要件定義の修正を依頼する"]);
  });

  it("words the verdict of a code review by the change", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です" }));
    expect(await textsOf(`${VERDICT} .fp-choice-label`)).toEqual(["この変更を承認する", "修正を依頼する"]);
  });

  it("does not let the approval be chosen while a card has its fix chosen, says why, and turns an approval chosen before into the request", async () => {
    await openPage(approvalPage());
    const fix = $('#formation-page [data-card="MF-1"] input[value="fix"]');
    const reason = $(`${VERDICT} .fp-verdict-reason`);
    await expect(reason).not.toBeDisplayed();
    await verdictRadio("approve").click();
    await expect(verdictRadio("approve")).toBeSelected();
    await fix.click();
    await expect(verdictRadio("revise")).toBeSelected();
    await expect(verdictRadio("approve")).toBeDisabled();
    await expect(reason).toBeDisplayed();
    expect(await rawTextsOf(`${VERDICT} .fp-verdict-reason`)).toEqual(["修正を選んだカード（MF-1）があるので、承認は選べません"]);
    // Taking the choice back lets the approval be chosen again, and the request stays chosen.
    await $('#formation-page [data-card="MF-1"] .fp-cancel').click();
    await expect(verdictRadio("approve")).toBeEnabled();
    await expect(verdictRadio("revise")).toBeSelected();
    await expect(reason).not.toBeDisplayed();
    // Another choice of the card is no revision.
    await $('#formation-page [data-card="MF-1"] input[value="skip"]').click();
    await expect(verdictRadio("approve")).toBeEnabled();
  });

  it("holds the approval back for the fix of a code review's card too, and names every card with a fix", async () => {
    await openPage(
      decisionPage({
        pageKind: "code-review",
        subject: "code",
        what: "変更です",
        residualMustFix: [decisionCard("RMF-1", { kind: "review-must-fix", recommendation: "fix", recommendationReason: "落ちる" }), decisionCard("RMF-2", { kind: "review-must-fix", recommendation: "fix", recommendationReason: "遅い" })],
      }),
    );
    await $('#formation-page [data-card="RMF-1"] input[value="fix"]').click();
    await $('#formation-page [data-card="RMF-2"] input[value="fix"]').click();
    await expect(verdictRadio("approve")).toBeDisabled();
    expect(await rawTextsOf(`${VERDICT} .fp-verdict-reason`)).toEqual(["修正を選んだカード（RMF-1、RMF-2）があるので、承認は選べません"]);
    await $('#formation-page [data-card="RMF-1"] input[value="accept"]').click();
    await expect(verdictRadio("approve")).toBeDisabled();
    await $('#formation-page [data-card="RMF-2"] input[value="accept"]').click();
    await expect(verdictRadio("approve")).toBeEnabled();
  });

  it("opens a box for what to revise with the request, and sends its text with the verdict", async () => {
    await openPage(approvalPage());
    const box = $(`${VERDICT} .fp-revision`);
    await expect(box).not.toBeDisplayed();
    await verdictRadio("revise").click();
    await expect(box).toBeDisplayed();
    await expect(box).toHaveAttribute("aria-label", "修正してほしいこと");
    await box.setValue("画面の名前を直す\n二行目");
    await $('#formation-page [data-card="MF-1"] input[value="skip"]').click();
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([
      {
        name: "formation",
        child: "req-login",
        atMs: MARK_AT,
        answers: [
          { card: "NR-1", choice: null, note: "", provisional: false },
          { card: "MF-1", choice: "skip", note: "", provisional: false },
          { card: "SP-1", choice: null, note: "", provisional: false },
        ],
        verdict: "revise",
        revision: "画面の名前を直す\n二行目",
      },
    ]);
  });

  it("closes the box again for the approval and sends no text with it", async () => {
    await openPage(approvalPage());
    await verdictRadio("revise").click();
    await $(`${VERDICT} .fp-revision`).setValue("やっぱり承認する");
    await verdictRadio("approve").click();
    await expect($(`${VERDICT} .fp-revision`)).not.toBeDisplayed();
    await $(SEND).click();
    const [call] = await waitForCalls("formation_page_answer", 1);
    expect(call).toMatchObject({ verdict: "approve", revision: "" });
  });

  it("says in one line which unanswered cards go with which choice, and drops a card from it when it is answered", async () => {
    await openPage(approvalPage({ residualMustFix: [], adr: null }));
    const line = `${VERDICT} .fp-unanswered`;
    expect(await rawTextsOf(line)).toEqual(["答えていないカードは、この案で送ります: NR-1 A. 案 A、SP-1 承認"]);
    await $('#formation-page [data-card="NR-1"] input[value="A"]').click();
    expect(await rawTextsOf(line)).toEqual(["答えていないカードは、この案で送ります: SP-1 承認"]);
    await $('#formation-page [data-card="SP-1"] input[value="reject"]').click();
    await expect($(line)).not.toBeDisplayed();
    // Taking an answer back puts the card in the line again.
    await $('#formation-page [data-card="SP-1"] .fp-cancel').click();
    expect(await rawTextsOf(line)).toEqual(["答えていないカードは、この案で送ります: SP-1 承認"]);
  });

  it("says that an unanswered fix card of a code review is sent as completing it as it is", async () => {
    await openPage(
      decisionPage({
        pageKind: "code-review",
        subject: "code",
        what: "変更です",
        residualMustFix: [decisionCard("RMF-1", { kind: "review-must-fix", recommendation: "fix", recommendationReason: "落ちる" })],
        needsUserDecision: [decisionCard("RD-1", { kind: "review-decision", options: [decisionOption("A", "案 A", null)], recommendation: "A", recommendationReason: "単純" })],
      }),
    );
    expect(await rawTextsOf(`${VERDICT} .fp-unanswered`)).toEqual(["答えていないカードは、この案で送ります: RMF-1 現状で完了する"]);
  });

  it("sends once however often it is pressed, and closes the tab and puts the card back when the reply went through", async () => {
    await openFlow([asking(), formationChild("api-update", "working")], { ...timers({ formationFlow: READ, orcaMirror: MIRROR }), orca_terminal_read: ["$ claude", "> 確認します"], formation_page_read: decisionPage({ questions: [QUESTION] }) });
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    await card("api-update").click();
    await $(OPEN).click();
    await expect($("#formation-page")).toBeDisplayed();
    await $('#formation-page [data-card="Q1"] input[value="A"]').click();
    await mock("formation_page_answer", holds);
    // The press is made in the page: a second press of the driver would wait for the first.
    await browser.execute((s) => {
      const button = document.querySelector<HTMLButtonElement>(s)!;
      button.click();
      button.click();
    }, SEND);
    await waitForCalls("formation_page_answer", 1);
    await browser.pause(READ * 2);
    expect(await answerCalls()).toHaveLength(1);
    await expect($(SEND)).toBeDisabled();
    await expect($(SEND)).toHaveAttribute("aria-busy", "true");
    // Until the reply is sent, the page waits: its tab is there.
    await expect($(PAGE_TAB)).toBeDisplayed();
    await mock("formation_children", [formationChild("req-login", "working"), formationChild("api-update", "working")]);
    await release("formation_page_answer", null);
    await browser.waitUntil(async () => !(await $(PAGE_TAB).isExisting()), { timeoutMsg: "the tab never closed" });
    await expect($("#formation-page")).not.toBeDisplayed();
    expect(await count("#formation-page > *")).toBe(0);
    // The tab that was selected before is shown again, the card of the page is gone, and the card of the child says what the child does.
    await expect($("#formation-teammate-term")).toBeDisplayed();
    await expect($("#formation-flow-pages")).not.toBeDisplayed();
    expect(await textsOf('#formation-flow-list [data-name="req-login"] .formation-card-state')).toEqual(["作業中"]);
    expect(await answerCalls()).toHaveLength(1);
  });

  it("leaves the page of another formation behind when a formation is selected", async () => {
    await openList({ formation_list: formationList([formationEntry("formation"), formationEntry("other")]), formation_children: [asking()], formation_page_read: decisionPage() });
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    await $(OPEN).click();
    await expect($("#formation-page")).toBeDisplayed();
    await mock("formation_children", []);
    await row("other").click();
    await expect($("#formation-page")).not.toBeDisplayed();
    expect(await count("#formation-page > *")).toBe(0);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
  });

  // The items of the page that the earlier decision pages had (#1156).
  const REQ_CARD = (n: string) => decisionCard(n, { title: `論点 ${n}`, options: [decisionOption("A", "案 A", null), decisionOption("B", "案 B", null)], recommendation: "A", recommendationReason: "単純" });
  const q = (n: string) => `#formation-page [data-card="${n}"]`;

  it("gives a word of terms a tooltip in the body text, and not in a title", async () => {
    await openPage(
      decisionPage({
        terms: [{ word: "与信", description: "支払いを先に押さえること" }],
        questions: [decisionCard("Q1", { title: "与信を作るか？", scene: "与信が残った病院で、与信の取り消しを決めます", options: [decisionOption("A", "作る", null)], recommendation: "A", recommendationReason: "単純" })],
      }),
    );
    expect(await textsOf(`${q("Q1")} .fp-scene .fp-term`)).toEqual(["与信", "与信"]);
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} .fp-term`)].map((e) => e.getAttribute("title")), q("Q1"))).toEqual(["支払いを先に押さえること", "支払いを先に押さえること"]);
    expect(await rawTextsOf(`${q("Q1")} .fp-scene`)).toEqual(["与信が残った病院で、与信の取り消しを決めます"]);
    expect(await count(`${q("Q1")} .fp-card-title .fp-term`)).toBe(0);
  });

  it("adds ビジネス側に確認する between 調べてから決めて and その他 when the page sets hold, with a box of its own that is sent with the answer", async () => {
    await openPage(decisionPage({ hold: true, questions: [REQ_CARD("Q1")] }));
    expect(await textsOf(`${q("Q1")} .fp-choice-label`)).toEqual(["A案 A推奨", "B案 B", "調べてから決めて", "ビジネス側に確認する", "その他"]);
    await expect($(`${q("Q1")} textarea[data-for="hold"]`)).not.toBeDisplayed();
    await $(`${q("Q1")} input[value="hold"]`).click();
    await $(`${q("Q1")} textarea[data-for="hold"]`).setValue("営業に聞く");
    await expect($(`${q("Q1")} textarea[data-for="other"]`)).not.toBeDisplayed();
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([{ name: "formation", child: "req-login", atMs: MARK_AT, answers: [{ card: "Q1", choice: "hold", note: "営業に聞く", provisional: false }], verdict: null, revision: "" }]);
  });

  it("has no ビジネス側に確認する row when the page does not set hold", async () => {
    await openPage(decisionPage({ questions: [REQ_CARD("Q1")] }));
    expect(await textsOf(`${q("Q1")} .fp-choice-label`)).toEqual(["A案 A推奨", "B案 B", "調べてから決めて", "その他"]);
  });

  it("puts the check 仮置き under the choices of a question of a requirement, sends it with the choice, and turns it off with 調べてから決めて and ビジネス側に確認する", async () => {
    await openPage(decisionPage({ hold: true, questions: [REQ_CARD("Q1")] }));
    const mark = `${q("Q1")} .fp-provisional input`;
    expect(await textsOf(`${q("Q1")} .fp-provisional`)).toEqual(["仮置き（ビジネス側の確認待ち）"]);
    await $(`${q("Q1")} input[value="B"]`).click();
    await $(mark).click();
    await expect($(mark)).toBeSelected();
    await expect($(`${q("Q1")} .fp-provisional`)).toHaveAttribute("data-on", "");
    await $(`${q("Q1")} input[value="investigate"]`).click();
    await expect($(mark)).not.toBeSelected();
    await expect($(mark)).toBeDisabled();
    await $(`${q("Q1")} input[value="hold"]`).click();
    await expect($(mark)).toBeDisabled();
    await $(`${q("Q1")} input[value="A"]`).click();
    await expect($(mark)).toBeEnabled();
    await expect($(mark)).not.toBeSelected();
    await $(mark).click();
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([{ name: "formation", child: "req-login", atMs: MARK_AT, answers: [{ card: "Q1", choice: "A", note: "", provisional: true }], verdict: null, revision: "" }]);
  });

  it("clears the check with 選択を取り消す, and shows it on no other page", async () => {
    await openPage(decisionPage({ questions: [REQ_CARD("Q1")] }));
    await $(`${q("Q1")} input[value="A"]`).click();
    await $(`${q("Q1")} .fp-provisional input`).click();
    await $(`${q("Q1")} .fp-cancel`).click();
    await expect($(`${q("Q1")} .fp-provisional input`)).not.toBeSelected();
    await expect($(`${q("Q1")} .fp-cancel`)).toBeDisabled();
  });

  it("shows the check 仮置き on no page but an open-questions page of a requirement", async () => {
    await openPage(decisionPage({ subject: "design", questions: [REQ_CARD("Q1")] }));
    expect(await count(`${q("Q1")} input[type="radio"]`)).toBe(4);
    expect(await count(`${q("Q1")} .fp-provisional`)).toBe(0);
  });

  it("starts from the answers that the earlier reply carried, says so until something changes, and sends them", async () => {
    const restored = [
      { card: "Q1", choice: "B", note: "", provisional: true },
      { card: "Q2", choice: "hold", note: "営業に聞く", provisional: false },
      { card: "Q3", choice: "other", note: "自由な答え", provisional: false },
    ];
    await openPage(decisionPage({ hold: true, previousReply: "（返信）", restored, questions: [REQ_CARD("Q1"), REQ_CARD("Q2"), REQ_CARD("Q3")] }));
    await expect($(`${q("Q1")} input[value="B"]`)).toBeSelected();
    await expect($(`${q("Q1")} .fp-provisional input`)).toBeSelected();
    await expect($(`${q("Q2")} input[value="hold"]`)).toBeSelected();
    await expect($(`${q("Q2")} textarea[data-for="hold"]`)).toHaveValue("営業に聞く");
    await expect($(`${q("Q3")} textarea[data-for="other"]`)).toHaveValue("自由な答え");
    await expect($(`${q("Q3")} textarea[data-for="other"]`)).toBeDisplayed();
    expect(await textsOf("#formation-page .fp-restored")).toEqual(["前の返信文から回答を復元しました。"]);
    // The earlier reply is not shown as text of the page.
    expect(await count("#formation-page pre")).toBe(0);
    await $(`${q("Q1")} input[value="A"]`).click();
    expect(await count("#formation-page .fp-restored")).toBe(0);
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([
      {
        name: "formation",
        child: "req-login",
        atMs: MARK_AT,
        answers: [
          { card: "Q1", choice: "A", note: "", provisional: true },
          { card: "Q2", choice: "hold", note: "営業に聞く", provisional: false },
          { card: "Q3", choice: "other", note: "自由な答え", provisional: false },
        ],
        verdict: null,
        revision: "",
      },
    ]);
  });

  it("restores the free text of a card with fixed choices whether or not it has a choice, and says nothing when nothing is restored", async () => {
    const approval = approvalPage({ previousReply: "（返信）", restored: [{ card: "MF-1", choice: null, note: "見送る理由", provisional: false }] });
    await openPage(approval);
    await expect($('#formation-page [data-card="MF-1"] textarea[data-for="note"]')).toHaveValue("見送る理由");
    expect(await count('#formation-page [data-card="MF-1"] input[type="radio"]:checked')).toBe(0);
    expect(await count("#formation-page .fp-restored")).toBe(1);
  });

  it("says nothing of a restore when nothing was restored", async () => {
    await openPage(approvalPage());
    expect(await count("#formation-page .fp-restored")).toBe(0);
  });

  it("lists the design items and the order of implementation of a design approval, and keeps the heading of the group in 承認の対象", async () => {
    const node = JSON.stringify({ id: "DESIGN-01", title: "最初", release: 2 }, null, 2);
    await openPage(
      approvalPage({
        approvalScope: [
          { heading: "設計項目", design: true, items: [] },
          { heading: "共有の設計資料", design: false, items: [{ root: "deliverables", ref: "design.json#/shared/data-model", path: null, description: "データモデル", extras: [], text: "{}" }] },
        ],
        designItems: [
          { id: "DESIGN-01", title: "最初。概要です", root: "deliverables", ref: "design.json#/designs/DESIGN-01", text: node, release: 2 },
          { id: "DESIGN-02", title: "二つめ", root: "deliverables", ref: "design.json#/designs/DESIGN-02", text: null, release: null },
        ],
        implementationOrder: ["example-api", "example-web"],
      }),
    );
    expect(await textsOf("#formation-page .fp-sec")).toEqual(["何が変わるか", "設計項目 2 件", "実装順序 2 件", "承認の対象", "判断が必要 1 件", "未解消の必ず直す指摘 1 件", "構造改善の提案 1 件", "参考", "あなたの判定"]);
    expect(await textsOf("#formation-page .fp-design-item > .fp-ev-path")).toEqual(["DESIGN-01", "DESIGN-02"]);
    expect(await textsOf("#formation-page .fp-design-item > .fp-p")).toEqual(["最初。概要です（リリース 2）", "二つめ"]);
    // Only the item whose node was read has 「中身を見る」.
    expect(await textsOf("#formation-page .fp-design-item > .fp-fold-btn")).toEqual(["中身を見る"]);
    expect(await textsOf("#formation-page .fp-order li")).toEqual(["example-api", "example-web"]);
    // The group of the design items keeps its heading and says where the items are; the other group lists its item.
    expect(await textsOf("#formation-page .fp-section:not(.fp-design-items) > .fp-h")).toEqual(["設計項目", "共有の設計資料"]);
    expect(await textsOf("#formation-page .fp-section:not(.fp-design-items) > .fp-muted")).toEqual(["上の「設計項目」に並べています。"]);
    expect(await textsOf("#formation-page .fp-section .fp-scope-item:not(.fp-design-item) .fp-ev-path")).toEqual(["design.json#/shared/data-model"]);
  });

  it("says what the approval covers in a fixed sentence by subject, under 承認の対象 and above the choice of the verdict", async () => {
    await openPage(approvalPage({ subject: "requirement", approvalScope: [{ heading: "要件", design: false, items: [] }] }));
    const sentence = "承認単位は requirement.json の全体です（technical-notes.md は内部調査資料のため承認対象外）。";
    expect(await textsOf("#formation-page .fp-unit")).toEqual([sentence, sentence]);
    expect(await browser.execute(() => document.querySelector(".fp-verdict .fp-unit")?.nextElementSibling?.tagName)).toBe("FIELDSET");
  });

  it("words the sentence of a design approval as the freezing of the design", async () => {
    await openPage(approvalPage({ approvalScope: [{ heading: "設計", design: false, items: [] }] }));
    const units = await textsOf("#formation-page .fp-unit");
    expect(units).toHaveLength(2);
    expect(units[0]).toContain("「契約」として凍結されます");
    expect(units[0]).toContain("本承認が最後の承認です");
  });

  it("shows no sentence on a code review's verdict", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です" }));
    expect(await count("#formation-page .fp-unit")).toBe(0);
  });

  it("puts the matters of an approval in 参考: the decisions that wait for the business side, the withdrawn questions, what was noticed and the quality loop", async () => {
    await openPage(
      approvalPage({
        subject: "requirement",
        settledDecisions: [
          { id: "UD-01", decision: "与信は 1 日で戻す", reason: "運用が決めた", evidence: [], provisional: true },
          { id: "UD-02", decision: "宛名は付ける", reason: "要望", evidence: [], provisional: false },
        ],
        withdrawnNeedsUserDecision: [{ number: "NR-3", title: "目標値", withdrawalReason: "回答で決まった" }],
        noticed: [{ title: "RC-1", text: "文言が揺れています", evidence: [] }],
        qualityLoop: { rounds: 2, fixCycles: null, mustFixResolved: 3 },
      }),
    );
    // 「参考」 is a heading with one row for each matter; a row opens in place, closed at first, with its heading as an h3 in the row.
    expect(await textsOf("#formation-page .fp-reference > .fp-sec")).toEqual(["参考"]);
    expect(await textsOf("#formation-page .fp-reference .fp-ref > summary > h3")).toEqual(["ビジネス側の確認待ち", "決まったこと", "取り下げた質問", "目標外の事柄", "品質チェックの結果"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLDetailsElement>("#formation-page .fp-ref")].map((d) => d.open))).toEqual([false, false, false, false, false]);
    await openReferences();
    expect(await textsOf("#formation-page .fp-awaiting .fp-settled")).toEqual(["UD-01与信は 1 日で戻す理由: 運用が決めた"]);
    expect(await textsOf("#formation-page .fp-settled-list .fp-settled")).toEqual(["UD-01与信は 1 日で戻す理由: 運用が決めた仮置き（ビジネス側の確認待ち）", "UD-02宛名は付ける理由: 要望"]);
    expect(await textsOf("#formation-page .fp-withdrawn .fp-settled")).toEqual(["NR-3目標値取り下げた理由: 回答で決まった"]);
    expect(await textsOf("#formation-page .fp-noticed .fp-muted")).toEqual(["名指しで依頼したものだけ直します。"]);
    expect(await textsOf("#formation-page .fp-noticed .fp-p")).toEqual(["文言が揺れています"]);
    // The answer form of a noticed matter: none.
    expect(await count("#formation-page .fp-noticed input, #formation-page .fp-noticed textarea")).toBe(0);
    expect(await textsOf("#formation-page .fp-quality .fp-p")).toEqual(["実施回数: 2 回", "解消した必ず直す指摘: 3 件"]);
  });

  it("does not list a provisional decision of a design as waiting for the business side", async () => {
    await openPage(approvalPage({ settledDecisions: [{ id: "UD-01", decision: "決めた", reason: "理由", evidence: [], provisional: true }] }));
    expect(await count("#formation-page .fp-awaiting")).toBe(0);
    expect(await count('#formation-page .fp-settled[data-provisional="true"]')).toBe(0);
  });

  it("puts the departures from the contract, the notices and the noticed matters of a code review in 参考, with the pull request still under the title", async () => {
    await openPage(
      decisionPage({
        pageKind: "code-review",
        subject: "code",
        what: "変更です",
        policyDeviations: [{ type: "paragraph", text: "契約と違い、検査を足しました" }],
        notices: ["集約の検査は通りました", "カバレッジは 91%"],
        noticed: [{ title: "FV-bound-1", text: "上限を 5 から 4 にしました", evidence: [] }],
        pr: { url: "https://github.com/o/r/pull/7", note: null },
      }),
    );
    await openReferences();
    expect(await textsOf("#formation-page .fp-reference .fp-ref > summary > h3")).toEqual(["実装方針からの変更", "お知らせ", "目標外の事柄"]);
    expect(await textsOf("#formation-page .fp-deviations .fp-p")).toEqual(["契約と違い、検査を足しました"]);
    expect(await textsOf("#formation-page .fp-notices .fp-p")).toEqual(["集約の検査は通りました", "カバレッジは 91%"]);
    expect(await textsOf("#formation-page .fp-noticed .fp-p")).toEqual(["上限を 5 から 4 にしました"]);
    expect(await textsOf("#formation-page .fp-pr .fp-ev-path")).toEqual(["https://github.com/o/r/pull/7"]);
  });

  it("draws the evidence of a noticed matter under 根拠を見る", async () => {
    await openPage(
      decisionPage({
        pageKind: "code-review",
        subject: "code",
        what: "変更です",
        noticed: [{ title: "OG-1", text: "範囲外の変更です", evidence: [{ type: "node", root: "deliverables", ref: "design.json#/designs/DESIGN-01", note: "元の記録", text: "{}" }] }],
      }),
    );
    await openReferences();
    expect(await textsOf("#formation-page .fp-noticed .fp-fold-btn")).toEqual(["根拠を見る"]);
    // The evidence is not in the text: it is in the drawer, headed by the matter.
    expect(await count("#formation-page .fp-scroll .fp-ev-note")).toBe(0);
    await $("#formation-page .fp-noticed .fp-fold-btn").click();
    expect(await drawerTitle()).toEqual(["OG-1 — 根拠"]);
    expect(await textsOf(`${PANEL} .fp-ev-note`)).toEqual(["元の記録"]);
  });

  // The drawer, the bars, the references and the kept answers of the earlier feature-dev's pages (#1158).
  const MEMO = { type: "markdown" as const, root: "deliverables", path: "memo.md", text: "# メモ\n\n`repo/src/lock.rb:11` を直す。`other.rb` は別。\n" };
  const LOCK = { type: "excerpt" as const, root: "repo", path: "src/lock.rb", start: 10, end: 12, highlight: [11], note: null, lines: ["def lock", "  wait 5", "end"] };
  const FOLDED = decisionCard("Q1", {
    background: "今の上限は 5 回",
    facts: [{ label: "メモ", value: "議事", content: MEMO }],
    evidence: [LOCK],
    options: [decisionOption("A", "案")],
    recommendation: "A",
    recommendationReason: "r",
  });

  it("shows 詳しく見る in the drawer on the right, headed by the card, with the tabs 詳細 and 根拠, and closes it with × and with Escape", async () => {
    await openPage(decisionPage({ questions: [FOLDED] }));
    const button = `${q("Q1")} > .fp-fold-btn`;
    await expect($(DRAWER)).not.toBeDisplayed();
    await $(button).click();
    await expect($(DRAWER)).toBeDisplayed();
    // It stands on the right of the pane, over the page, and at least 420px wide.
    const box = await browser.execute((d) => {
      const drawer = document.querySelector(d)!.getBoundingClientRect();
      const pane = document.getElementById("formation-page")!.getBoundingClientRect();
      return { right: Math.round(drawer.right - pane.right), top: Math.round(drawer.top - pane.top), wide: drawer.width >= 419 };
    }, DRAWER);
    expect(box).toEqual({ right: 0, top: 0, wide: true });
    expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 詳細"]);
    expect(await tabs()).toEqual(["詳細", "中身を見る: 議事", "根拠"]);
    await expect(tab("詳細")).toHaveAttribute("aria-selected", "true");
    expect(await textsOf(`${PANEL} .fp-h`)).toEqual(["背景"]);
    await tab("根拠").click();
    await expect(tab("根拠")).toHaveAttribute("aria-selected", "true");
    expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 根拠"]);
    expect(await count(`${PANEL} [data-evidence="excerpt"]`)).toBe(1);
    expect(await count(`${DRAWER} .fp-dr-panel:not([hidden])`)).toBe(1);
    // The × closes it, and the button that opened it has the focus again.
    await $(`${DRAWER} .fp-dr-close`).click();
    await expect($(DRAWER)).not.toBeDisplayed();
    expect(await browser.execute((b) => document.activeElement === document.querySelector(b), button)).toBe(true);
    // Escape closes it, and nothing else does.
    await $(button).click();
    await expect($(DRAWER)).toBeDisplayed();
    await $("#formation-page .fp-title").click();
    await expect($(DRAWER)).toBeDisplayed();
    await browser.keys("Escape");
    await expect($(DRAWER)).not.toBeDisplayed();
  });

  it("shows the file that a code name points at, with the lines it names marked, and 「← 戻る」 brings the fold back when the name was in a fold", async () => {
    await openPage(decisionPage({ questions: [FOLDED] }));
    await $(`${q("Q1")} > .fp-fold-btn`).click();
    await $(`${PANEL} .fp-facts .fp-fold-btn`).click();
    expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 中身を見る: 議事"]);
    // A name of a file that the page holds, with its lines, is a link; any other name stays code.
    expect(await browser.execute((p) => [...document.querySelectorAll(`${p} code`)].map((c) => c.classList.contains("fp-fileref")), PANEL)).toEqual([true, false]);
    await $(`${PANEL} code.fp-fileref`).click();
    expect(await drawerTitle()).toEqual(["repo/src/lock.rb:11"]);
    // The page holds lines 10 to 12 only, so a gap mark stands before them.
    expect(await textsOf(`${DRAWER} .fp-dr-lines .fp-ln`)).toEqual(["…", "10", "11", "12"]);
    expect(await rawTextsOf(`${DRAWER} .fp-dr-lines .fp-lc`)).toEqual(["", "def lock", "  wait 5", "end"]);
    expect(await browser.execute((d) => [...document.querySelectorAll(`${d} .fp-dr-lines .fp-line`)].map((l) => (l as HTMLElement).dataset.highlight ?? ""), DRAWER)).toEqual(["", "", "true", ""]);
    // Only the lines the page holds: it says so.
    expect(await rawTextsOf(`${DRAWER} .fp-dr-note`)).toEqual(["この画面に載せている行のみ"]);
    await expect($(`${DRAWER} .fp-dr-back`)).toBeDisplayed();
    await $(`${DRAWER} .fp-dr-back`).click();
    expect(await drawerTitle()).toEqual(["Q1 質問 Q1 — 中身を見る: 議事"]);
    expect(await count(`${PANEL} code.fp-fileref`)).toBe(1);
    // The path in the head of an excerpt is such a name too.
    await tab("根拠").click();
    await $(`${PANEL} .fp-ev-head code.fp-fileref`).click();
    expect(await drawerTitle()).toEqual(["repo/src/lock.rb"]);
    expect(await textsOf(`${DRAWER} .fp-dr-lines .fp-ln`)).toEqual(["…", "10", "11", "12"]);
    await $(`${DRAWER} .fp-dr-close`).click();
    await expect($(DRAWER)).not.toBeDisplayed();
  });

  it("shows a listed file of the page whole from a code name in the text, with no way back", async () => {
    await openPage(
      approvalPage({
        approvalScope: [{ heading: "要件", design: false, items: [{ root: "deliverables", ref: null, path: "requirement.md", description: "要件の本文", extras: [], text: "# 要件\n二行目\n三行目" }] }],
      }),
    );
    const name = "#formation-page .fp-scope-item .fp-ev-path";
    await expect($(name)).toHaveElementClass("fp-fileref");
    await $(name).click();
    expect(await drawerTitle()).toEqual(["requirement.md"]);
    expect(await textsOf(`${DRAWER} .fp-dr-lines .fp-lc`)).toEqual(["# 要件", "二行目", "三行目"]);
    expect(await count(`${DRAWER} .fp-dr-lines [data-highlight]`)).toBe(0);
    await expect($(`${DRAWER} .fp-dr-back`)).not.toBeDisplayed();
    await expect($(`${DRAWER} .fp-dr-note`)).not.toBeDisplayed();
  });

  it("shows the label of the page and a link to each section in the top bar, marks the one being read, and opens the section of a link", async () => {
    await openPage(approvalPage({ settledDecisions: [{ id: "UD-01", decision: "決めた", reason: "理由", evidence: [], provisional: false }] }));
    const bar = "#formation-page .fp-bar-top";
    expect(await textsOf(`${bar} .fp-context`)).toEqual(["要件定義 · 未決事項"]);
    expect(await textsOf(`${bar} .fp-nav a`)).toEqual(["何が変わるか", "判断が必要 1 件", "未解消の必ず直す指摘 1 件", "構造改善の提案 1 件", "参考", "あなたの判定"]);
    await browser.waitUntil(async () => (await browser.execute((b) => [...document.querySelectorAll(`${b} .fp-nav a`)].map((a) => a.getAttribute("aria-current") ?? ""), bar)).join() === "location,,,,,", { timeoutMsg: "the first section was not marked" });
    // A link goes to its section (the address of the page is `#{id}`), and a row of 「参考」 opens when its address is taken.
    await $(bar).$("a=参考").click();
    expect(await browser.execute(() => location.hash)).toBe("#fp-req-login-reference");
    await browser.execute(() => {
      location.hash = "fp-req-login-ref-settled";
    });
    await browser.waitUntil(() => folded("#formation-page .fp-settled-list"), { timeoutMsg: "the row of the address did not open" });
    expect(await folded("#formation-page .fp-quality")).toBe(false);
  });

  it("counts the required and the optional answers in the bottom bar, with the progress and 「次の未回答へ」, and 「TOP へ戻る」 goes to the top", async () => {
    await openPage(approvalPage());
    const bar = "#formation-page .fp-bar-bottom";
    expect(await textsOf(`${bar} .fp-count`)).toEqual(["必須 0 / 1 件", "任意 0 / 2 件"]);
    const progress = $(`${bar} .fp-progress`);
    await expect(progress).toHaveAttribute("role", "progressbar");
    await expect(progress).toHaveAttribute("aria-valuemax", "3");
    await expect(progress).toHaveAttribute("aria-valuenow", "0");
    // 「次の未回答へ」 goes to the first required card that has no answer, then to the first optional one.
    const focused = () => browser.execute(() => document.activeElement?.closest<HTMLElement>("[data-card]")?.dataset.card ?? "");
    // Pressed in the page: the driver's click focuses the button it clicked after the handler ran, which would take the focus from the card (a real press leaves it there).
    const pressNext = () => browser.execute((b) => document.querySelector<HTMLElement>(`${b} .fp-next`)!.click(), bar);
    await pressNext();
    expect(await focused()).toBe("MF-1");
    await $('#formation-page [data-card="SP-1"] input[value="reject"]').click();
    expect(await textsOf(`${bar} .fp-count`)).toEqual(["必須 0 / 1 件", "任意 1 / 2 件"]);
    await expect(progress).toHaveAttribute("aria-valuenow", "1");
    expect(await browser.execute((b) => document.querySelector<HTMLElement>(`${b} .fp-progress-fill`)!.style.width, bar)).toBe("33%");
    await $('#formation-page [data-card="MF-1"] input[value="skip"]').click();
    expect(await textsOf(`${bar} .fp-count`)).toEqual(["必須 1 / 1 件", "任意 1 / 2 件"]);
    await pressNext();
    expect(await focused()).toBe("NR-1");
    await $('#formation-page [data-card="NR-1"] input[value="A"]').click();
    // With every card answered it goes to the button that sends, or to the verdict while none is chosen.
    await pressNext();
    await expect($(VERDICT)).toBeDisplayedInViewport();
    await verdictRadio("approve").click();
    await pressNext();
    expect(await browser.execute(() => document.activeElement?.classList.contains("fp-send-btn"))).toBe(true);
    await $(`${bar} .fp-to-top`).click();
    expect(await browser.execute(() => document.querySelector(".fp-scroll")!.scrollTop)).toBe(0);
  });

  it("does not count 「その他」 with no text as an answer", async () => {
    await openPage(decisionPage({ questions: [QUESTION] }));
    const bar = "#formation-page .fp-bar-bottom";
    await $(`${q("Q1")} input[value="other"]`).click();
    expect(await textsOf(`${bar} .fp-count`)).toEqual(["必須 0 / 1 件"]);
    await $(`${q("Q1")} .fp-text`).setValue("5 回と 10 回の間");
    expect(await textsOf(`${bar} .fp-count`)).toEqual(["必須 1 / 1 件"]);
    await $(`${q("Q1")} .fp-cancel`).click();
    expect(await textsOf(`${bar} .fp-count`)).toEqual(["必須 0 / 1 件"]);
  });

  it("draws no count, progress or 「次の未回答へ」 on a page with no answer form", async () => {
    await openPage(decisionPage({ pageKind: "code-review", subject: "code", what: "変更です" }));
    expect(await count("#formation-page .fp-bar-bottom .fp-count, #formation-page .fp-bar-bottom .fp-progress, #formation-page .fp-bar-bottom .fp-next")).toBe(0);
    expect(await textsOf("#formation-page .fp-bar-bottom button")).toEqual(["TOP へ戻る", "リーダーに送る"]);
  });

  it("keeps the answers as they are entered and puts them back when the page is drawn again, and forgets them once they are sent", async () => {
    await openPage(decisionPage({ questions: [QUESTION, QUESTION_2] }));
    const kept = () => browser.execute(() => Object.keys(localStorage).filter((k) => k.startsWith("fp-answers:")).length);
    expect(await kept()).toBe(0);
    // The answers are written a moment after the last entry, not at each one.
    const keptIs = (n: number) => browser.waitUntil(async () => (await kept()) === n, { timeoutMsg: `the kept answers were not ${n}` });
    await $(`${q("Q1")} input[value="B"]`).click();
    await keptIs(1);
    // Taking every answer back keeps nothing.
    await $(`${q("Q1")} .fp-cancel`).click();
    await keptIs(0);
    await $(`${q("Q1")} input[value="B"]`).click();
    await $(`${q("Q2")} input[value="other"]`).click();
    await $(`${q("Q2")} .fp-text`).setValue("来週の頭");
    await keptIs(1);
    // The mark of the page changes: it is drawn anew, and starts from what was kept.
    await mock("formation_children", [asking({ pendingPage: { title: "要件の未決事項", atMs: MARK_AT + 60_000 } })]);
    await browser.waitUntil(async () => (await count("#formation-page .fp-restored")) === 1, { timeoutMsg: "the answers were not put back" });
    expect(await textsOf("#formation-page .fp-restored")).toEqual(["前回この画面で入力した回答を復元しました。"]);
    await expect($(`${q("Q1")} input[value="B"]`)).toBeSelected();
    await expect($(`${q("Q2")} textarea[data-for="other"]`)).toHaveValue("来週の頭");
    expect(await textsOf("#formation-page .fp-bar-bottom .fp-count")).toEqual(["必須 2 / 2 件"]);
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toEqual([
      {
        name: "formation",
        child: "req-login",
        atMs: MARK_AT + 60_000,
        answers: [
          { card: "Q1", choice: "B", note: "", provisional: false },
          { card: "Q2", choice: "other", note: "来週の頭", provisional: false },
        ],
        verdict: null,
        revision: "",
      },
    ]);
    // Once sent, nothing of it is kept.
    await browser.waitUntil(async () => (await kept()) === 0, { timeoutMsg: "the answers were kept after the send" });
  });

  it("takes away what an earlier page of the same child kept when the page is drawn, and leaves what is another child's", async () => {
    // `boot` takes every kept answer away, so the entries are put after it and before the page is opened.
    await openFlow([asking()], { formation_page_read: decisionPage({ questions: [QUESTION] }) });
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    await browser.execute(() => {
      localStorage.setItem("fp-answers:formation\nreq-login:deadbeef", "{}");
      localStorage.setItem("fp-answers:formation\nother:deadbeef", "{}");
    });
    await $(OPEN).click();
    await expect($("#formation-page")).toBeDisplayed();
    expect(await browser.execute(() => Object.keys(localStorage).filter((k) => k.startsWith("fp-answers:")))).toEqual(["fp-answers:formation\nother:deadbeef"]);
  });

  it("keeps the verdict and its writing too", async () => {
    await openPage(approvalPage());
    await verdictRadio("revise").click();
    await $(`${VERDICT} .fp-revision`).setValue("名前を直す");
    await $('#formation-page [data-card="SP-1"] input[value="hold"]').click();
    await mock("formation_children", [asking({ pendingPage: { title: "要件の未決事項", atMs: MARK_AT + 60_000 } })]);
    await browser.waitUntil(async () => (await count("#formation-page .fp-restored")) === 1, { timeoutMsg: "the answers were not put back" });
    await expect(verdictRadio("revise")).toBeSelected();
    await expect($(`${VERDICT} .fp-revision`)).toHaveValue("名前を直す");
    await expect($('#formation-page [data-card="SP-1"] input[value="hold"]')).toBeSelected();
  });

  it("works when the browser keeps nothing, and asks before the window is left only while it holds answers that could not be kept", async () => {
    await openFlow([asking()], { formation_page_read: decisionPage({ questions: [QUESTION] }) });
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    await browser.execute(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith("fp-answers:")) throw new Error("the quota is full");
        return set.call(this, key, value);
      };
    });
    await $(OPEN).click();
    await expect($("#formation-page")).toBeDisplayed();
    // The page works all the same.
    const leave = () =>
      browser.execute(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
    expect(await leave()).toBe(false);
    await $(`${q("Q1")} input[value="A"]`).click();
    expect(await leave()).toBe(true);
    await $(`${q("Q1")} .fp-cancel`).click();
    expect(await leave()).toBe(false);
    await $(`${q("Q1")} input[value="A"]`).click();
    await $(SEND).click();
    expect(await waitForCalls("formation_page_answer", 1)).toHaveLength(1);
  });

  it("asks nothing before the window is left when the answers are kept", async () => {
    await openPage(decisionPage({ questions: [QUESTION] }));
    await $(`${q("Q1")} input[value="A"]`).click();
    expect(
      await browser.execute(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    ).toBe(false);
  });

  it("marks a change by a form besides its color: a label on a changed cell, a bar and a mark on a highlighted line", async () => {
    const card = decisionCard("Q1", {
      blocks: [{ type: "table", header: ["案", "回数"], rows: [[{ text: "A", changed: false }, { text: "5", changed: true }]] }],
      evidence: [LOCK],
    });
    await openPage(decisionPage({ questions: [card] }));
    await $(`${q("Q1")} > .fp-fold-btn`).click();
    const cell = `${PANEL} .fp-table td[data-changed="true"]`;
    expect(await browser.execute((c) => getComputedStyle(document.querySelector(c)!, "::before").content, cell)).toBe('"変更"');
    expect(await browser.execute((c) => getComputedStyle(document.querySelector(c)!).borderLeftWidth, cell)).toBe("4px");
    await tab("根拠").click();
    const line = `${PANEL} .fp-line[data-highlight="true"]`;
    expect(await browser.execute((l) => getComputedStyle(document.querySelector(l)!).borderLeftWidth, line)).toBe("4px");
    expect(await browser.execute((l) => getComputedStyle(document.querySelector(`${l} .fp-ln`)!, "::before").content, line)).toBe('"▶"');
  });

  it("draws the choices as cards with a border that stands out, and gives every control of the page one ring of 2px at the accent color", async () => {
    await openPage(decisionPage({ questions: [FOLDED] }));
    const border = await browser.execute(() => getComputedStyle(document.querySelector(".fp-choice")!).borderTopColor);
    expect(border).toBe(await resolved("--muted"));
    // The ring is the rule of `:focus-visible`, which WebDriver's keys do not set in WKWebView, so the rule is read from the style sheet.
    const rule = await browser.execute(() => {
      for (const sheet of document.styleSheets) {
        for (const r of sheet.cssRules) {
          if (r instanceof CSSStyleRule && r.selectorText.includes("#formation-page :is(button") && r.selectorText.includes(":focus-visible")) {
            return { selector: r.selectorText, outline: r.style.getPropertyValue("outline") };
          }
        }
      }
      return null;
    });
    expect(rule).not.toBeNull();
    for (const part of ["2px", "solid", "var(--accent)"]) expect(rule!.outline).toContain(part);
    for (const control of ["button", "a", "summary", "input", "textarea", '[role="link"]', '[role="tab"]']) expect(rule!.selector).toContain(control);
  });

});

// A-37: the launched children under the row of their formation in the list.
const CHILD = (name: string) => `#formation-list-feed .formation-child[data-child="${name}"]`;
const childRows = () => textsOf("#formation-list-feed .formation-child");
const withChildren = () =>
  formationList([
    formationEntry("formation"),
    formationEntry("won-2485", { minutes: 12, repos: ["wonder-api"], children: [listedChild("auth-api", "working", { repo: "wonder-api", branch: "child-auth" }), listedChild("add-tests", "waiting", { repo: "wonder-front", branch: "child-test" })], counts: { planned: 1, waiting: 1, working: 1, done: 0 } }),
    formationEntry("mail-summary", { minutes: 90, children: [listedChild("old-one", "done", { repo: "tsunagiai", branch: "old" })], counts: { planned: 0, waiting: 0, working: 0, done: 1 } }),
  ]);

describe("orchestration mode: the children under a formation in the list", () => {
  it("shows the number of launched teammates at the right of a formation's row, and none for a formation that has none", async () => {
    await openList({ formation_list: withChildren() }, null);
    expect(await textsOf(`${LINES} .formation-row-count`)).toEqual(["2", "1"]);
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} .formation-row-count`)].map((e) => e.getAttribute("aria-label")), LINES)).toEqual(["起動しているチームメイト 2 人", "起動しているチームメイト 1 人"]);
    expect(await count(`${LINE_OF("formation")} .formation-row-count`)).toBe(0);
    // The count is at the right end of the row, after the name.
    const place = await browser.execute((s) => {
      const line = document.querySelector(`${s}[data-formation="won-2485"]`)!.closest(".formation-line")!;
      const r = line.getBoundingClientRect();
      const n = line.querySelector(".formation-row-count")!.getBoundingClientRect();
      const name = line.querySelector(".formation-row-name")!.getBoundingClientRect();
      return { right: r.right - n.right < 16, beside: name.right <= n.left };
    }, ROWS);
    expect(place).toEqual({ right: true, beside: true });
  });

  it("draws a row for each launched child under its formation: the name, and under it the project and the branch of its worktree, with the icon of its state", async () => {
    await openList({ formation_list: withChildren() }, null);
    // The done child of the third formation still has its terminal: it is drawn as waiting, with no chip pressed.
    expect(await childRows()).toEqual(["auth-api" + "wonder-api ・ child-auth", "add-tests" + "wonder-front ・ child-test", "old-one" + "tsunagiai ・ old"]);
    expect(await textsOf(".formation-child .formation-child-name")).toEqual(["auth-api", "add-tests", "old-one"]);
    expect(await textsOf(".formation-child .formation-child-where")).toEqual(["wonder-api ・ child-auth", "wonder-front ・ child-test", "tsunagiai ・ old"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".formation-child .orca-ic")].map((e) => [e.dataset.status, e.getAttribute("aria-label")]))).toEqual([
      ["working", "作業中"],
      ["question", "承認待ち"],
      ["idle", "待機"],
    ]);
    // A child is under its formation's row, below it and indented from its name.
    const [parent, first, second] = [await rectOf(`${ROWS}[data-formation="won-2485"]`), await rectOf(CHILD("auth-api")), await rectOf(CHILD("add-tests"))];
    expect(first.top).toBeGreaterThanOrEqual(parent.bottom - 1);
    expect(second.top).toBeGreaterThanOrEqual(first.bottom - 1);
    expect(first.left).toBeGreaterThan(parent.left);
  });

  it("folds the children away and opens them again with the arrow of the formation's row, and gives a formation with no child no arrow", async () => {
    await openList({ formation_list: withChildren() }, null);
    const arrow = '#formation-list-feed .orca-arrow[data-arrow="won-2485"]';
    expect(await count("#formation-list-feed .orca-arrow")).toBe(2);
    await expect($(arrow)).toHaveAttribute("aria-expanded", "true");
    await $(arrow).click();
    await expect($(arrow)).toHaveAttribute("aria-expanded", "false");
    // Only the children of that formation are folded away: the waiting child of the third formation stays.
    expect(await childRows()).toEqual(["old-one" + "tsunagiai ・ old"]);
    // The count stays while the children are folded, and the press of the arrow selects nothing.
    expect(await textsOf(`${LINES} .formation-row-count`)).toEqual(["2", "1"]);
    expect(await pressedRows()).toEqual([]);
    await $(arrow).click();
    await expect($(arrow)).toHaveAttribute("aria-expanded", "true");
    expect(await childRows()).toHaveLength(3);
  });

  it("keeps a folded formation folded when the list is read again", async () => {
    await openList({ formation_list: withChildren() }, null);
    await $('#formation-list-feed .orca-arrow[data-arrow="won-2485"]').click();
    await mock("formation_list", formationList([formationEntry("formation"), formationEntry("won-2485", { children: [listedChild("auth-api", "working", { repo: "wonder-api", branch: "child-auth" })] })]));
    await browser.waitUntil(async () => (await textsOf(`${LINES} .formation-row-count`)).join() === "1");
    expect(await count(".formation-child")).toBe(0);
  });

  it("selects the formation and shows the child's tab when its row is pressed", async () => {
    await openList({ formation_list: withChildren(), formation_children: [formationChild("auth-api", "working"), formationChild("add-tests", "waiting")] }, null);
    await $(CHILD("add-tests")).click();
    expect(await pressedRows()).toEqual(["won-2485"]);
    await expect($("#formation")).toBeDisplayed();
    await expect($('#formation-tabs-mates [data-child="add-tests"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "false");
    await expect($("#formation-teammate-term")).toBeDisplayed();
    // Another child of the same formation: no new formation, and its tab is shown at once.
    await $(CHILD("auth-api")).click();
    await expect($('#formation-tabs-mates [data-child="auth-api"]')).toHaveAttribute("aria-selected", "true");
    await expect($('#formation-tabs-mates [data-child="add-tests"]')).toHaveAttribute("aria-selected", "false");
    expect(await pressedRows()).toEqual(["won-2485"]);
  });

  it("shows the child's tab of another formation than the shown one, after its children are read", async () => {
    await openList({ formation_list: withChildren(), formation_children: [formationChild("old-one", "working")] });
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await $(CHILD("old-one")).click();
    expect(await pressedRows()).toEqual(["mail-summary"]);
    await expect($('#formation-tabs-mates [data-child="old-one"]')).toHaveAttribute("aria-selected", "true");
  });

  it("selects the formation and leaves the leader's tab for a child that has no terminal", async () => {
    await openList({ formation_list: withChildren(), formation_children: [formationChild("old-one", "done", { handle: null })] }, null);
    await $(CHILD("old-one")).click();
    expect(await pressedRows()).toEqual(["mail-summary"]);
    await showDoneCards();
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
  });

  it("lists the children of a formation of a saved environment as it lists those of this Mac", async () => {
    const saved = formationList([formationEntry("remote-work", { environment: "dev-server", repos: [], children: [listedChild("r-child", "working", { repo: "wonder-api", branch: "r-branch", environment: "dev-server", path: "/srv/work/r-child" })] })]);
    await openList({ formation_list: saved, formation_orchestrator: { environment: "dev-server", handle: "term_orch" }, formation_consents: [formationConsent("dev-server")], formation_children: [formationChild("r-child", "working", { environment: "dev-server" })] }, null);
    expect(await childRows()).toEqual(["r-child" + "wonder-api ・ r-branch"]);
    expect(await textsOf(`${LINES} .formation-row-count`)).toEqual(["1"]);
    await $(CHILD("r-child")).click();
    expect(await pressedRows()).toEqual(["remote-work"]);
    await expect($('#formation-tabs-mates [data-child="r-child"]')).toHaveAttribute("aria-selected", "true");
  });
});

describe("orchestration mode: the done children of a formation in the list", () => {
  const counts = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#formation-list-feed .formation-done-count")].map((e) => [e.dataset.doneFor, e.textContent, e.tagName]));
  // Two working or waiting children, a done child that still has its terminal (waiting for the next instruction) and two done children that were stopped (no terminal).
  const mixedList = () =>
    formationList([
      formationEntry("formation"),
      formationEntry("won-2485", {
        children: [listedChild("auth-api", "working"), listedChild("add-tests", "done"), listedChild("old-one", "waiting"), listedChild("last-one", "done", { terminal: false }), listedChild("stopped-one", "done", { terminal: false })],
        counts: { planned: 0, waiting: 1, working: 1, done: 3 },
      }),
    ]);

  it("leaves a stopped child out, draws a done child that has its terminal as 待機, and counts every done child in 完了 N", async () => {
    await openList({ formation_list: mixedList() }, null);
    expect(await childRows()).toEqual(["auth-api" + "example-api ・ formation/auth-api", "add-tests" + "example-api ・ formation/add-tests", "old-one" + "example-api ・ formation/old-one"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".formation-child")].map((e) => [e.dataset.child, e.dataset.state, e.querySelector<HTMLElement>(".orca-ic")!.dataset.status, e.querySelector(".orca-ic")!.getAttribute("aria-label")]))).toEqual([
      ["auth-api", "working", "working", "作業中"],
      ["add-tests", "standby", "idle", "待機"],
      ["old-one", "waiting", "question", "承認待ち"],
    ]);
    expect(await counts()).toEqual([["won-2485", "完了 3", "SPAN"]]);
    // The number counts every launched child, the stopped ones too.
    expect(await textsOf(`${LINES} .formation-row-count`)).toEqual(["5"]);
  });

  it("draws the mark of 待機 as a gray ring that a working child's ring and a done child's dot are told from", async () => {
    await openList({ formation_list: mixedList() }, null);
    const mark = (name: string) => browser.execute((n) => {
      const e = document.querySelector(`.formation-child[data-child="${n}"] .orca-mark`)!;
      const st = getComputedStyle(e);
      return { background: st.backgroundColor, border: st.borderTopWidth, animation: st.animationName };
    }, name);
    const standby = await mark("add-tests");
    expect(standby.border).toBe("2px");
    expect(standby.animation).toBe("none");
    expect(standby.background).toBe("rgba(0, 0, 0, 0)");
    expect(await mark("auth-api")).toMatchObject({ animation: "spin" });
  });

  it("puts the count 完了 N before the number, outside the button, and has none for a formation that has no done child", async () => {
    await openList({ formation_list: withChildren() }, null);
    expect(await counts()).toEqual([["mail-summary", "完了 1", "SPAN"]]);
    const place = await browser.execute(() => {
      const line = document.querySelector('#formation-list-feed .formation-row[data-formation="mail-summary"]')!.closest(".formation-line")!;
      const [row, chip, n] = [line.querySelector(".formation-row")!, line.querySelector(".formation-done-count")!, line.querySelector(".formation-row-count")!];
      return { before: chip.getBoundingClientRect().right <= n.getBoundingClientRect().left, beside: row.getBoundingClientRect().right <= chip.getBoundingClientRect().left, outside: !row.contains(chip), pressable: chip.closest("button") !== null };
    });
    expect(place).toEqual({ before: true, beside: true, outside: true, pressable: false });
  });

  it("selects nothing and shows nothing more with a press on the count, and draws no arrow for a formation whose children are all stopped", async () => {
    await openList({ formation_list: mixedList() }, null);
    await $(`${LINE_OF("won-2485")} .formation-done-count`).click();
    expect(await pressedRows()).toEqual([]);
    expect(await childRows()).toHaveLength(3);
    await mock("formation_list", formationList([formationEntry("formation"), formationEntry("won-2485", { children: [listedChild("last-one", "done", { terminal: false })] })]));
    await browser.waitUntil(async () => (await childRows()).length === 0);
    expect(await count("#formation-list-feed .orca-arrow")).toBe(0);
    expect(await counts()).toEqual([["won-2485", "完了 1", "SPAN"]]);
    expect(await textsOf(`${LINES} .formation-row-count`)).toEqual(["1"]);
  });

  it("keeps the count and the number in the line when the name is long, and cuts the name with an ellipsis", async () => {
    const long = "a-very-long-formation-name-that-does-not-fit-in-the-list-pane-at-all";
    await openList({ formation_list: formationList([formationEntry(long, { children: [listedChild("auth-api", "working"), listedChild("add-tests", "done")] })]) }, null);
    const fit = await browser.execute(() => {
      const line = document.querySelector("#formation-list-feed .formation-line")!.getBoundingClientRect();
      const name = document.querySelector<HTMLElement>("#formation-list-feed .formation-row-name")!;
      const [chip, n] = [".formation-done-count", ".formation-row-count"].map((s) => document.querySelector(s)!.getBoundingClientRect());
      return { cut: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, inside: chip.right <= n.left && n.right <= line.right, nameBeforeChip: name.getBoundingClientRect().right <= chip.left };
    });
    expect(fit).toEqual({ cut: true, ellipsis: "ellipsis", inside: true, nameBeforeChip: true });
  });
});

// A-8, A-16, A-37 (#947, #1134): the sessions of a launched child have no row under their project, the project's row has the mark of a formation and the number of the worktrees of the children, and the child's worktree is not offered where a session starts.
describe("orchestration mode: the children's worktrees in the projects", () => {
  const CHILD_PATH = "/work/child-a";
  const MAIN_PATH = "/work/api";
  const OTHER_PATH = "/work/api-other";
  // The project `api`: its own session, a session and a plain terminal in the worktree of a child, and its worktrees (its own folder, the child's, and one that the owner made, which is no child's).
  const ownRow = (extra: Record<string, unknown> = {}) => orcaRow("api", "main", "Own session", { path: MAIN_PATH, handle: "term_own", paneKey: "tab_own:leaf_1", ...extra });
  const childRow = (extra: Record<string, unknown> = {}) => orcaRow("api", "child-a", "Child session", { path: CHILD_PATH, handle: "term_child", paneKey: "tab_child:leaf_1", ...extra });
  const childTerminal = () => orcaTerminal("api", "zsh", { path: CHILD_PATH, handle: "term_child_sh", branch: "child-a" });
  const trees = () => [orcaWorktree("api", "main"), orcaWorktree("api", "child-a", { path: CHILD_PATH }), orcaWorktree("api", "other", { path: OTHER_PATH })];
  const overview = (rows = [ownRow(), childRow()], worktrees = trees()) => orcaOverview(rows, worktrees, { terminals: [childTerminal()] });
  const withChild = () => formationList([formationEntry("formation", { children: [listedChild("child-a", "working", { repo: "api", branch: "child-a", path: CHILD_PATH })], counts: { planned: 0, waiting: 0, working: 1, done: 0 } })]);
  // The row of a session is the branch of its worktree (A-8).
  const sessionNames = () => textsOf("#orca-feed .orca-session .orca-session-title");
  // The marks of the formations on the rows of the projects, by their `aria-label`: the number of the children's worktrees is in the mark, and the row draws no text of the formation's name.
  const formationMarks = () => browser.execute(() => [...document.querySelectorAll("#orca-feed .orca-project .orca-project-formation")].map((e) => e.getAttribute("aria-label")));
  // The project row has no count of its sessions (#1033): the counts are on the session rows. The number of the mark is another thing.
  const numberCount = () => count(`${PROJECT} .orca-n`);
  const arrow = () => $('#orca-feed [data-key="arrow:proj_api"]');

  // `ready`: the pill of the count is the sign that the list was read, and a formation with no child has none, so a spec of such a list names its own sign.
  async function openScreen(extra: Record<string, unknown> = {}, ready = async () => (await count(".formation-row-count")) === 1) {
    await boot({ inbox: inbox(), orca_overview: overview(), formation_list: withChild(), ...timers({ orcaClock: READ }), ...extra });
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await expect($(`${ROWS}[data-formation="formation"]`)).toBeDisplayed();
    await browser.waitUntil(ready);
  }
  // The page's own press of the plus of the work pane (the driver's click takes the focus to the button after the handler).
  async function pressPlus() {
    await $(PROJECT).click();
    await expect($(PROJECT)).toHaveAttribute("aria-pressed", "true");
    await browser.execute((id) => window.__e2e_once__(id) && document.querySelector<HTMLElement>(".orca-plus")!.click(), onceId());
    await expect($('.menu[role="menu"]')).toBeDisplayed();
  }

  it("draws no row for the sessions of a child's worktree, and draws the mark of the formation and the number of the child worktrees at the right of the project row", async () => {
    await openScreen({}, async () => (await formationMarks()).length === 1);
    expect(await sessionNames()).toEqual(["main"]);
    expect(await formationMarks()).toEqual(["フォーメーション 1"]);
    expect(await numberCount()).toBe(0);
    expect(await count('#orca-feed [data-session="claude:tab_child:leaf_1"], #orca-feed [data-session="orca:term_child_sh"]')).toBe(0);
    expect(await count("#orca-feed .orca-session-formation")).toBe(0);
    // The same drawing as the heading of the list, and a number as text.
    expect(await browser.execute(() => document.querySelector("#orca-feed .orca-project-formation svg")!.innerHTML === document.querySelector("#orca-formations .orca-list-head svg")!.innerHTML)).toBe(true);
    expect(await textsOf(`${PROJECT} .orca-project-formation`)).toEqual(["1"]);
  });

  it("puts the mark at the right end of the project row after its name, and gives the number of the formations to the aria-label and tooltip and to no text of the row", async () => {
    await openScreen({}, async () => (await formationMarks()).length === 1);
    const row = await browser.execute(() => {
      const project = document.querySelector<HTMLElement>("#orca-feed .orca-project")!;
      const mark = project.querySelector<HTMLElement>(".orca-project-formation")!;
      const [p, n, m] = [project, project.querySelector(".orca-project-name")!, mark].map((e) => e.getBoundingClientRect());
      return { after: n.right <= m.left, end: p.right - m.right < 16, role: mark.getAttribute("role"), label: mark.getAttribute("aria-label"), tooltip: mark.title, text: project.textContent };
    });
    expect(row).toMatchObject({ after: true, end: true, role: "img", label: "フォーメーション 1", tooltip: "フォーメーション 1", text: "api1" });
  });

  it("counts the worktrees of the children of the project, and the worktree of a stopped child too, and draws no row for any", async () => {
    const worktrees = [...trees(), orcaWorktree("api", "child-b", { path: "/work/child-b" })];
    const children = [listedChild("child-a", "done", { repo: "api", branch: "child-a", path: CHILD_PATH, terminal: false }), listedChild("child-b", "working", { repo: "api", branch: "child-b", path: "/work/child-b" })];
    await openScreen({ orca_overview: orcaOverview([ownRow()], worktrees), formation_list: formationList([formationEntry("formation", { children, counts: { planned: 0, waiting: 0, working: 1, done: 1 } })]) }, async () => (await formationMarks()).length === 1);
    expect(await formationMarks()).toEqual(["フォーメーション 2"]);
    expect(await textsOf(`${PROJECT} .orca-project-formation`)).toEqual(["2"]);
    expect(await sessionNames()).toEqual(["main"]);
  });

  it("draws no mark for the path of a child on another PC", async () => {
    await openScreen({}, async () => (await formationMarks()).length === 1);
    await mock("formation_list", formationList([formationEntry("formation", { children: [listedChild("d", "working", { repo: "api", path: CHILD_PATH, environment: "dev-server" })] })]));
    await browser.waitUntil(async () => (await formationMarks()).length === 0, { timeout: 15_000 });
  });

  it("keeps the row of a project with nothing but a child's sessions among the running projects, above the link of the ones that are not running", async () => {
    await openScreen({ orca_overview: overview([childRow({ group: "done" })], [...trees(), orcaWorktree("web", "main")]) }, async () => (await count(".orca-stopped-toggle")) === 1);
    // The row stays, with its mark and no session under it.
    expect(await formationMarks()).toEqual(["フォーメーション 1"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-project, #orca-feed .orca-stopped-toggle")].map((e) => e.dataset.key))).toEqual(["proj_api", "stopped-toggle"]);
    expect(await textsOf("#orca-feed .orca-stopped-toggle")).toEqual(["起動していない 1 件"]);
  });

  it("puts a project that works with nothing but a child's sessions last among the running projects, above the link of the ones that are not running, and keeps a project with an own working session where it was", async () => {
    // `api` works with the child's session alone and enters the working group first (the read lists it first); `web` works with its own session; `docs` has a session that is done; `blank` has none.
    const rows = [childRow(), orcaRow("web", "main", "Web session"), orcaRow("docs", "main", "Docs session", { group: "done" })];
    const worktrees = [...trees(), orcaWorktree("web", "main"), orcaWorktree("docs", "main"), orcaWorktree("blank", "main")];
    const keys = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-project, #orca-feed .orca-stopped-toggle")].map((e) => e.dataset.key));
    await openScreen({ orca_overview: orcaOverview(rows, worktrees) }, async () => (await formationMarks()).length === 1);
    expect(await keys()).toEqual(["proj_web", "proj_docs", "proj_api", "stopped-toggle"]);
    expect(await textsOf("#orca-feed .orca-stopped-toggle")).toEqual(["起動していない 1 件"]);
    // The project stays a running one: it is not under the link, and it has its mark.
    expect(await formationMarks()).toEqual(["フォーメーション 1"]);
    // An own session of the project that works too puts it back among the working projects, where the read listed it.
    await mock("orca_overview", orcaOverview([childRow(), ownRow(), ...rows.slice(1)], worktrees));
    await browser.waitUntil(async () => (await keys())[0] === "proj_api", { timeout: 15_000 });
    expect(await keys()).toEqual(["proj_api", "proj_web", "proj_docs", "stopped-toggle"]);
    // An own session that asks a question has not stopped either: the project stays where the read listed it.
    await mock("orca_overview", orcaOverview([childRow(), ...rows.slice(1)], worktrees));
    await browser.waitUntil(async () => (await keys())[0] === "proj_web", { timeout: 15_000 });
    await mock("orca_overview", orcaOverview([childRow(), ownRow({ group: "waiting" }), ...rows.slice(1)], worktrees));
    await browser.waitUntil(async () => (await keys())[0] === "proj_api", { timeout: 15_000 });
    expect(await keys()).toEqual(["proj_api", "proj_web", "proj_docs", "stopped-toggle"]);
  });

  it("draws every session of the project when no child of the record is in its worktrees", async () => {
    await openScreen({ formation_list: formationList([formationEntry("formation")]) }, async () => (await sessionNames()).length === 3);
    expect(await sessionNames()).toEqual(["main", "child-a", "child-a"]);
    expect(await formationMarks()).toEqual([]);
    // A child whose worktree is not the path of any row leaves every session as it is, and so does the same path on another PC.
    await mock("formation_list", formationList([formationEntry("formation", { children: [listedChild("c", "working", { path: "/work/elsewhere" }), listedChild("d", "working", { path: CHILD_PATH, environment: "dev-server" })] })]));
    await browser.waitUntil(async () => (await count(".formation-row-count")) === 1);
    expect(await sessionNames()).toEqual(["main", "child-a", "child-a"]);
    expect(await formationMarks()).toEqual([]);
  });

  it("takes the mark off the project and draws the sessions again when the child leaves the record", async () => {
    await openScreen({}, async () => (await formationMarks()).length === 1);
    expect(await sessionNames()).toEqual(["main"]);
    await mock("formation_list", formationList([formationEntry("formation")]));
    await browser.waitUntil(async () => (await formationMarks()).length === 0, { timeout: 15_000 });
    expect(await sessionNames()).toEqual(["main", "child-a", "child-a"]);
  });

  it("keeps the folder of a child that works in a folder that was there, and the owner's session in it, and draws no row for the child's own sessions", async () => {
    // The child works in the project's own folder (`created` false): its Claude row and its terminal leave the project, and the owner's session in the same folder stays. The folder is counted as the worktree of a child.
    const inFolder = (name: string, handle: string, paneKey: string) => listedChild(name, "working", { repo: "api", branch: "main", path: MAIN_PATH, created: false, handle, paneKey });
    const kept = formationList([formationEntry("formation", { children: [inFolder("child-a", "term_child", "tab_child:leaf_1"), inFolder("codex-a", "term_codex", "tab_codex:leaf_1")], counts: { planned: 0, waiting: 0, working: 2, done: 0 } })]);
    const inOwnFolder = orcaOverview([ownRow(), childRow({ path: MAIN_PATH, branch: "main" })], [orcaWorktree("api", "main"), orcaWorktree("api", "other", { path: OTHER_PATH })], { terminals: [orcaTerminal("api", "zsh", { path: MAIN_PATH, handle: "term_own_sh" }), orcaTerminal("api", "codex", { path: MAIN_PATH, handle: "term_codex" })] });
    await openScreen({ orca_overview: inOwnFolder, formation_list: kept });
    await browser.waitUntil(async () => (await formationMarks()).length === 1);
    expect(await formationMarks()).toEqual(["フォーメーション 1"]);
    expect(await sessionNames()).toEqual(["main", "main"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-session")].map((e) => e.dataset.session))).toEqual(["claude:tab_own:leaf_1", "orca:term_own_sh"]);
    // The work pane has the owner's tabs only, and the folder stays among the worktrees of the plus.
    await mock("orca_start", { paneKey: null, handle: null });
    await pressPlus();
    await expect($('[data-tab="claude:tab_own:leaf_1"]')).toExist();
    expect(await count('[data-tab="claude:tab_child:leaf_1"], [data-tab="orca:term_codex"]')).toBe(0);
    await pickItem("Claude を起動");
    await expect($(".orca-dest-pop")).toBeDisplayed();
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".orca-dest-pop button[data-path]")].map((b) => b.dataset.path))).toEqual([MAIN_PATH, OTHER_PATH]);
  });

  it("opens the project when a child works in it, and gives a project with nothing but a child's sessions no arrow and no row", async () => {
    // Its own session is done and the child's works: the project is opened for the child's work, as for any session's, and shows the owner's session only.
    await openScreen({ orca_overview: overview([ownRow({ group: "done" }), childRow()]) }, async () => (await formationMarks()).length === 1);
    await expect(arrow()).toHaveAttribute("aria-expanded", "true");
    expect(await sessionNames()).toEqual(["main"]);
    await openScreen({ orca_overview: overview([childRow()], trees()) }, async () => (await formationMarks()).length === 1);
    expect(await count('#orca-feed [data-key^="arrow:"]')).toBe(0);
    expect(await sessionNames()).toEqual([]);
    expect(await numberCount()).toBe(0);
  });

  it("still counts a child's session in the sidebar button, which marks the work and the wait", async () => {
    await openScreen({ orca_overview: overview([ownRow(), childRow({ group: "waiting" })]) }, async () => (await formationMarks()).length === 1);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "開発（確認待ち 1 件、作業中 1 件）");
    await expect($("#nav-orca .nav-count")).toHaveText("1");
    expect(await sessionNames()).toEqual(["main"]);
  });

  it("offers no child's worktree in the dialog of the plus, and offers the others of the project", async () => {
    await openScreen();
    await mock("orca_start", { paneKey: null, handle: null });
    await pressPlus();
    await pickItem("Claude を起動");
    await expect($(".orca-dest-pop")).toBeDisplayed();
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".orca-dest-pop button[data-path]")].map((b) => b.dataset.path))).toEqual([MAIN_PATH, OTHER_PATH]);
    expect(await callsOf("orca_start")).toEqual([]);
  });

  it("starts at once in the one worktree that is left when the project has a child's besides its own folder", async () => {
    await openScreen({ orca_overview: overview([ownRow(), childRow()], [orcaWorktree("api", "main"), orcaWorktree("api", "child-a", { path: CHILD_PATH })]) });
    const start = await mock("orca_start", { paneKey: null, handle: null });
    await pressPlus();
    await pickItem("Claude を起動");
    expect(await waitForCalls(start)).toEqual([{ path: MAIN_PATH, environment: null }]);
    await expect($(".orca-dest-pop")).not.toExist();
  });
});

// A-37 (#1113): the cards of the done children are left out until the chip 「完了 N」 of the flow pane's heading is pressed.
describe("orchestration mode: the done children of the flow pane", () => {
  const chip = () => browser.execute((s) => ((e) => (e.hidden ? null : [e.textContent, e.getAttribute("aria-pressed")]))(document.querySelector<HTMLButtonElement>(s)!), FLOW_DONE);
  const tabNames = () => textsOf("#formation-tabs-mates .formation-tab-name");
  const done = () => [formationChild("api-update", "done", { minutes: 25 }), formationChild("web-update", "working"), formationChild("old-one", "done", { minutes: 40 }), formationChild("later", "planned")];

  it("draws no chip while no child is done, and the chip 完了 N right of 流れ, before the button of the view, when some are", async () => {
    await openFlow([formationChild("web-update", "working"), formationChild("later", "planned")], {}, true);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    expect(await chip()).toBeNull();
    await expect($(FLOW_DONE)).not.toBeDisplayed();
    await mock("formation_children", done());
    await browser.waitUntil(async () => (await chip()) !== null);
    expect(await chip()).toEqual(["完了 2", "false"]);
    const place = await browser.execute((s) => {
      const [h2, c, size] = ["#formation-flow-head h2", s, "#formation-flow-size"].map((q) => document.querySelector(q)!.getBoundingClientRect());
      return { after: h2.right <= c.left, before: c.right <= size.left };
    }, FLOW_DONE);
    expect(place).toEqual({ after: true, before: true });
    await mock("formation_children", [formationChild("web-update", "working")]);
    await browser.waitUntil(async () => (await chip()) === null);
  });

  it("leaves the done cards out at first, and draws no tab of any child", async () => {
    await openFlow(done(), {}, true);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    expect(await cardNames()).toEqual(["web-update", "later"]);
    expect(await chip()).toEqual(["完了 2", "false"]);
    expect(await tabNames()).toEqual([]);
  });

  it("shows the done cards in the order given with a press on the chip, in the colors of a pressed chip, and leaves them out with another press", async () => {
    await openFlow(done(), {}, true);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    const unpressed = await styleOf(FLOW_DONE, "backgroundColor");
    await $(FLOW_DONE).click();
    expect(await cardNames()).toEqual(["web-update", "later", "api-update", "old-one"]);
    expect(await chip()).toEqual(["完了 2", "true"]);
    expect(await styleOf(FLOW_DONE, "backgroundColor")).toBe(await resolved("--soft"));
    expect(await styleOf(FLOW_DONE, "backgroundColor")).not.toBe(unpressed);
    expect(await count("#formation-flow-list .formation-card-close")).toBe(2);
    // The chip opens no tab.
    expect(await tabNames()).toEqual([]);
    // The shown cards stay through a read.
    await mock("formation_children", [...done(), formationChild("new-one", "working")]);
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    expect(await cardNames()).toEqual(["web-update", "new-one", "later", "api-update", "old-one"]);
    await $(FLOW_DONE).click();
    expect(await cardNames()).toEqual(["web-update", "new-one", "later"]);
    expect(await chip()).toEqual(["完了 2", "false"]);
    expect(await count("#formation-flow-list .formation-card-close")).toBe(0);
  });

  it("keeps the tab of a done child, and its selection, when the chip leaves its card out", async () => {
    await openFlow(done(), {}, true);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    await $(FLOW_DONE).click();
    await $('#formation-flow-list [data-child="old-one"]').click();
    await expect($('#formation-tabs-mates [data-child="old-one"]')).toHaveAttribute("aria-selected", "true");
    await expect($('#formation-flow-list [data-child="old-one"]')).toHaveAttribute("aria-pressed", "true");
    await browser.waitUntil(async () => (await readHandles()).includes("term_old-one"));
    // A read leaves the selection where it was.
    await mock("formation_children", [...done(), formationChild("new-one", "working")]);
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await expect($('#formation-tabs-mates [data-child="old-one"]')).toHaveAttribute("aria-selected", "true");
    // The card is left out, and the tab stays.
    await $(FLOW_DONE).click();
    expect(await count('#formation-flow-list [data-child="old-one"]')).toBe(0);
    expect(await tabNames()).toEqual(["old-one"]);
    await expect($('#formation-tabs-mates [data-child="old-one"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-teammate-term")).toBeDisplayed();
    await $(FLOW_DONE).click();
    await expect($('#formation-flow-list [data-child="old-one"]')).toHaveAttribute("aria-pressed", "true");
  });

  it("draws the card of the page of a done child with no press on the chip, counts the child as done, and opens its tab only when pressed", async () => {
    const page = { title: "要件の未決事項", atMs: MARK_AT };
    const children = () => [formationChild("req-login", "done", { minutes: 5, pendingPage: page }), formationChild("web-update", "working"), formationChild("old-one", "done", { minutes: 40 })];
    await openFlow(children(), { formation_page_read: decisionPage() }, true);
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    expect(await cardNames()).toEqual(["web-update"]);
    expect(await tabNames()).toEqual([]);
    expect(await chip()).toEqual(["完了 2", "false"]);
    await expect($("#formation-flow-pages")).toBeDisplayed();
    expect(await textsOf("#formation-flow-pages .formation-card-title")).toEqual(["判断: 要件の未決事項"]);
    await $(OPEN).click();
    await expect($(PAGE_TAB)).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-page")).toBeDisplayed();
    expect(await tabNames()).toEqual(["判断: 要件の未決事項"]);
    // Pressed, the chip shows the done children too.
    await $(FLOW_DONE).click();
    expect(await cardNames()).toEqual(["web-update", "req-login", "old-one"]);
    expect(await chip()).toEqual(["完了 2", "true"]);
    // The page is answered: its mark is gone, its card and its tab go, and the leader's terminal is shown.
    await mock("formation_children", [formationChild("req-login", "done", { minutes: 5, pendingPage: null }), formationChild("web-update", "working"), children()[2]]);
    await browser.waitUntil(async () => (await count(PAGE_TAB)) === 0);
    await expect($("#formation-flow-pages")).not.toBeDisplayed();
    await expect($("#formation-page")).not.toBeDisplayed();
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
  });

  it("opens the tab of a done child's row of the list with no press on the chip", async () => {
    const entry = formationEntry("formation", { children: [listedChild("old-one", "done")], counts: { planned: 0, waiting: 0, working: 0, done: 1 } });
    await openList({ formation_list: formationList([entry]), formation_children: [formationChild("old-one", "done", { minutes: 40 }), formationChild("web-update", "working")] }, null);
    await $(CHILD("old-one")).click();
    await expect($('#formation-tabs-mates [data-child="old-one"]')).toHaveAttribute("aria-selected", "true");
    expect(await chip()).toEqual(["完了 1", "false"]);
  });

  it("closes a done child from the × of its card, and takes its tab away", async () => {
    await openFlow(done(), {}, true);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    await $(FLOW_DONE).click();
    await $('#formation-flow-list [data-child="web-update"]').click();
    await $('#formation-flow-list [data-child="old-one"]').click();
    expect(await tabNames()).toEqual(["web-update", "old-one"]);
    const close = await mock("formation_close_child", { closed: true, reason: null, changed: [], untracked: [], unpushed: [], path: "", environment: "", preservedBranch: null });
    await mock("formation_children", done().filter((c) => c.name !== "old-one"));
    await $('#formation-flow-list [data-close="old-one"]').click();
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("old-one を削除しますか？");
    await $('.pop[role="alertdialog"] .text-btn.danger').click();
    expect((await waitForCalls(close))[0]).toMatchObject({ formation: "formation", name: "old-one" });
    await browser.waitUntil(async () => (await chip())?.[0] === "完了 1");
    expect(await tabNames()).toEqual(["web-update"]);
  });

  it("leaves the rows of the list as they are when the chip is pressed, and shows no card of a stopped child", async () => {
    const entry = () => formationEntry("formation", { children: [listedChild("api-update", "done"), listedChild("web-update", "working"), listedChild("old-one", "done", { terminal: false })], counts: { planned: 0, waiting: 0, working: 1, done: 2 } });
    await openList({ formation_list: formationList([entry()]), formation_children: done() });
    await browser.waitUntil(async () => (await chip()) !== null);
    // The list draws the done child that has its terminal as waiting, and not the stopped one; the flow pane's cards do not depend on it.
    expect(await childRows()).toHaveLength(2);
    expect(await cardNames()).toEqual(["web-update", "later"]);
    await $(FLOW_DONE).click();
    expect(await cardNames()).toHaveLength(4);
    expect(await chip()).toEqual(["完了 2", "true"]);
    expect(await childRows()).toHaveLength(2);
  });
});

// A-37: the compact view of the flow pane. The view that was chosen is kept in `localStorage`, which the app's page keeps between the specs too, so every spec leaves the standard view.
const COMPACT_KEY = "formation-flow-compact";
const forgetView = () => browser.execute((k) => localStorage.removeItem(k), COMPACT_KEY);
const storedView = () => browser.execute((k) => localStorage.getItem(k), COMPACT_KEY);
const widthOf = async (selector: string) => {
  const r = await rectOf(selector);
  return r.right - r.left;
};
const SIZE = "#formation-flow-size";
const ORB = (name: string) => `#formation-flow-orbs [data-orb="${name}"]`;
const PAGE_ORB = '#formation-flow-page-orbs [data-page-orb="req-login"]';
const orbNames = () => textsOf("#formation-flow-orbs .formation-orb-name");
// The tip is shown by a pointer over an orb or by the focus on it: the window has no pointer, so the events are dispatched, as the footer's spec does.
const fire = (selector: string, type: string) =>
  browser.execute(
    (s, t) => {
      document.querySelector(s)!.dispatchEvent(t === "focus" || t === "blur" ? new FocusEvent(t) : new MouseEvent(t));
    },
    selector,
    type,
  );
const asCompact = async (children: unknown, extra: Record<string, unknown> = {}, doneHidden = false) => {
  await openFlow(children, extra, doneHidden);
  await $(SIZE).click();
  await expect($(SIZE)).toHaveAttribute("aria-pressed", "true");
};

describe("orchestration mode: the compact flow pane", () => {
  beforeEach(forgetView);
  afterEach(forgetView);

  it("has a button of the view in the heading, and starts with the standard view, 260px wide", async () => {
    await openFlow(mixed());
    await expect($(SIZE)).toHaveAttribute("aria-label", "コンパクト表示");
    await expect($(SIZE)).toHaveAttribute("aria-pressed", "false");
    expect(await browser.execute(() => document.getElementById("formation-flow-size")!.classList.contains("icon-btn"))).toBe(true);
    expect(await textsOf(SIZE)).toEqual([""]);
    expect(await widthOf("#formation-flow")).toBe(260);
    await expect($("#formation-flow-root")).toBeDisplayed();
    expect(await visible("#formation-flow-compact")).toBe(false);
    expect(await storedView()).toBeNull();
  });

  it("takes the width of the sidebar, shows the leader as one orb, and puts one arrow under it and no arrow beside a child", async () => {
    await asCompact(mixed(), {}, true);
    expect(await widthOf("#formation-flow")).toBe(await widthOf("#sidebar"));
    expect(await widthOf("#formation-flow")).toBe(78);
    expect(await visible("#formation-flow-root")).toBe(false);
    expect(await visible("#formation-flow-list")).toBe(false);
    expect(await count("#formation-flow-list .formation-card")).toBe(0);
    await expect($("#formation-flow-leader")).toBeDisplayed();
    expect(await ground("#formation-flow-leader .formation-orb-dot")).toBe(await resolvedGround("--accent"));
    expect(await styleOf("#formation-flow-leader .formation-orb-dot", "color")).toBe(await resolved("--on-accent"));
    // The arrow is one SVG of 20 by 26, between the leader's orb and the children's orbs; the children have none.
    await expect($("#formation-flow-arrow")).toBeDisplayed();
    expect(await count("#formation-flow-compact svg")).toBe(1);
    expect(await count("#formation-flow-orbs svg")).toBe(0);
    expect(await browser.execute(() => {
      const r = document.getElementById("formation-flow-arrow")!.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    })).toEqual([20, 26]);
    const [leader, arrow, first] = [await rectOf("#formation-flow-leader"), await rectOf("#formation-flow-arrow"), await rectOf("#formation-flow-orbs .formation-orb")];
    expect(leader.bottom).toBeLessThanOrEqual(arrow.top);
    expect(arrow.bottom).toBeLessThanOrEqual(first.top);
    // Each child is one orb of 36px, with its name under it, in the order of the cards (the done one is left out until its chip is pressed).
    expect(await orbNames()).toEqual(["batch-update", "web-update", "e2e-check", "summary"]);
    expect(await widthOf("#formation-flow-orbs .formation-orb-dot")).toBe(36);
    expect(await count("#formation-flow-orbs .formation-orb-dot")).toBe(4);
    const [dot, name] = [await rectOf("#formation-flow-orbs .formation-orb-dot"), await rectOf("#formation-flow-orbs .formation-orb-name")];
    expect(dot.bottom).toBeLessThanOrEqual(name.top);
    expect(await textsOf("#formation-flow-orbs .formation-orb-dot")).toEqual(["B", "W", "E", "S"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#formation-flow-orbs .formation-orb")].map((e) => (e as HTMLElement).dataset.state))).toEqual(["working", "waiting", "planned", "planned"]);
  });

  it("flows the dashes of the arrow", async () => {
    await asCompact(mixed());
    expect(await styleOf("#formation-flow-arrow .formation-arrow-line", "animationName")).toBe("formation-arrow-flow");
    expect(await browser.execute(() => getComputedStyle(document.querySelector("#formation-flow-arrow .formation-arrow-line")!).strokeDasharray)).not.toBe("none");
  });

  it("frames each orb in the color of the card of its state, and draws a planned one dashed", async () => {
    await openFlow(mixed(), {}, true);
    const cards = {
      working: await styleOf('#formation-flow-list .formation-card[data-state="working"]', "borderTopColor"),
      waiting: await styleOf('#formation-flow-list .formation-card[data-state="waiting"]', "borderTopColor"),
    };
    await showDoneCards();
    const done = await styleOf('#formation-flow-list .formation-card[data-state="done"]', "borderTopColor");
    await $(SIZE).click();
    const dot = (state: string) => `#formation-flow-orbs .formation-orb[data-state="${state}"] .formation-orb-dot`;
    expect(await styleOf(dot("working"), "borderTopColor")).toBe(cards.working);
    expect(await styleOf(dot("waiting"), "borderTopColor")).toBe(cards.waiting);
    expect(await styleOf(dot("waiting"), "borderTopColor")).toBe(await resolved("--agent-question"));
    expect(await styleOf(dot("done"), "borderTopColor")).toBe(done);
    expect(await styleOf(dot("working"), "borderTopStyle")).toBe("solid");
    expect(await styleOf(dot("planned"), "borderTopStyle")).toBe("dashed");
    expect(await browser.execute((s) => getComputedStyle(document.querySelector(s)!).borderTopWidth, dot("working"))).toBe("3px");
  });

  it("shows a Codex child with the pale blue ground and the tag cx, also while it waits", async () => {
    await asCompact([formationChild("api-update", "working"), formationChild("review-codex", "waiting", { agent: "codex" }), formationChild("later-codex", "working", { agent: "codex" })]);
    expect(await textsOf("#formation-flow-orbs .formation-orb-cx")).toEqual(["cx", "cx"]);
    expect(await count(`${ORB("api-update")} .formation-orb-cx`)).toBe(0);
    for (const name of ["review-codex", "later-codex"]) {
      expect(await ground(`${ORB(name)} .formation-orb-dot`)).toBe("rgb(230, 237, 251)");
      expect(await styleOf(`${ORB(name)} .formation-orb-dot`, "color")).toBe("rgb(29, 63, 138)");
    }
    expect(await ground(`${ORB("api-update")} .formation-orb-dot`)).not.toBe("rgb(230, 237, 251)");
    // The frame still says the state.
    expect(await styleOf(`${ORB("review-codex")} .formation-orb-dot`, "borderTopColor")).toBe(await resolved("--agent-question"));
  });

  it("selects the tab of a child by pressing its orb, as its card does, and the leader's tab by the leader's orb", async () => {
    await asCompact(mixed());
    await expect($("#formation-flow-leader")).toHaveAttribute("aria-pressed", "true");
    await $(ORB("batch-update")).click();
    await expect($(ORB("batch-update"))).toHaveAttribute("aria-pressed", "true");
    await expect($('#formation-tabs-mates [data-child="batch-update"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-flow-leader")).toHaveAttribute("aria-pressed", "false");
    expect(await count('#formation-flow-orbs [aria-pressed="true"]')).toBe(1);
    await $(ORB("web-update")).click();
    await expect($(ORB("web-update"))).toHaveAttribute("aria-pressed", "true");
    await expect($(ORB("batch-update"))).toHaveAttribute("aria-pressed", "false");
    await expect($('#formation-tabs-mates [data-child="web-update"]')).toHaveAttribute("aria-selected", "true");
    // A planned child has no terminal: its orb is shown and a press selects nothing.
    expect(await browser.execute((s) => document.querySelector(s)!.tagName, ORB("e2e-check"))).toBe("DIV");
    await $("#formation-flow-leader").click();
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-flow-leader")).toHaveAttribute("aria-pressed", "true");
    await expect($(ORB("web-update"))).toHaveAttribute("aria-pressed", "false");
    // The same press on the card of the standard view selects the same tab.
    await $(SIZE).click();
    await $('#formation-flow-list [data-child="web-update"]').click();
    await expect($('#formation-tabs-mates [data-child="web-update"]')).toHaveAttribute("aria-selected", "true");
  });

  it("shows the content of the card in a tip beside an orb while the pointer or the focus is on it, and takes it away when they leave", async () => {
    await asCompact(mixed(), {}, true);
    expect(await visible("#formation-flow-tip")).toBe(false);
    await fire(ORB("web-update"), "mouseenter");
    await expect($("#formation-flow-tip")).toBeDisplayed();
    expect(await textsOf("#formation-flow-tip .formation-card-name")).toEqual(["web-update"]);
    expect(await textsOf("#formation-flow-tip .formation-card-state")).toEqual(["承認待ち"]);
    expect(await textsOf("#formation-flow-tip .formation-card-msg")).toEqual(["依存の衝突を無視して入れてよいか確認します。"]);
    expect(await textsOf("#formation-flow-tip .formation-card-time")).toEqual(["1 分"]);
    // It is beside the orb, at its left, and inside the window.
    const [tip, orb] = [await rectOf("#formation-flow-tip"), await rectOf(`${ORB("web-update")} .formation-orb-dot`)];
    expect(tip.right).toBeLessThanOrEqual(orb.left);
    expect(tip.left).toBeGreaterThanOrEqual(0);
    expect(tip.top).toBeGreaterThanOrEqual(0);
    await fire(ORB("web-update"), "mouseleave");
    expect(await visible("#formation-flow-tip")).toBe(false);
    await fire(ORB("batch-update"), "focus");
    expect(await textsOf("#formation-flow-tip .formation-card-state")).toEqual(["作業中"]);
    await fire(ORB("batch-update"), "blur");
    expect(await visible("#formation-flow-tip")).toBe(false);
    await fire(ORB("e2e-check"), "mouseenter");
    expect(await textsOf("#formation-flow-tip .formation-card-state")).toEqual(["予定"]);
    await fire(ORB("e2e-check"), "mouseleave");
    await fire("#formation-flow-leader", "mouseenter");
    expect(await textsOf("#formation-flow-tip .formation-card-name")).toEqual(["formation"]);
    expect(await textsOf("#formation-flow-tip .formation-card-role")).toEqual(["リーダー"]);
    await fire("#formation-flow-leader", "mouseleave");
    expect(await visible("#formation-flow-tip")).toBe(false);
  });

  it("names a Codex child in its tip, and a child with a decision page by its own state, with the page in an orb of its own", async () => {
    await asCompact([formationChild("review-codex", "working", { agent: "codex" }), formationChild("req-login", "working", { pendingPage: { title: "要件の未決事項", atMs: 1_700_000_000_000 } })]);
    await fire(ORB("review-codex"), "mouseenter");
    expect(await textsOf("#formation-flow-tip .formation-card-agent")).toEqual(["codex"]);
    await fire(ORB("review-codex"), "mouseleave");
    await fire(ORB("req-login"), "mouseenter");
    expect(await textsOf("#formation-flow-tip .formation-card-state")).toEqual(["作業中"]);
    await expect($(ORB("req-login"))).toHaveAttribute("data-state", "working");
    await fire(ORB("req-login"), "mouseleave");
    await fire(PAGE_ORB, "mouseenter");
    expect(await textsOf("#formation-flow-tip .formation-card-title")).toEqual(["判断: 要件の未決事項"]);
    expect(await textsOf("#formation-flow-tip .formation-card-name")).toEqual(["req-login"]);
    await fire(PAGE_ORB, "mouseleave");
    expect(await visible("#formation-flow-tip")).toBe(false);
  });

  it("draws an orb of its own for a page that waits above the leader's orb, and opens the page when it is pressed", async () => {
    await asCompact([asking(), formationChild("api-update", "working")], { formation_page_read: decisionPage() });
    expect(await count("#formation-flow-page-orbs .formation-orb")).toBe(1);
    await expect($(PAGE_ORB)).toHaveAttribute("data-state", "waiting");
    expect(await textsOf(`${PAGE_ORB} .formation-orb-dot`)).toEqual(["判"]);
    expect(await textsOf(`${PAGE_ORB} .formation-orb-name`)).toEqual(["req-login"]);
    await expect($(PAGE_ORB)).toHaveAttribute("aria-label", "判断: 要件の未決事項");
    expect(await styleOf(`${PAGE_ORB} .formation-orb-dot`, "borderTopColor")).toBe(await resolved("--agent-question"));
    const [page, leader] = [await rectOf(PAGE_ORB), await rectOf("#formation-flow-leader")];
    expect(page.bottom).toBeLessThanOrEqual(leader.top);
    // No tab is open until the orb is pressed.
    expect(await count("#formation-tabs-mates .formation-tab")).toBe(0);
    await $(PAGE_ORB).click();
    await expect($(PAGE_ORB)).toHaveAttribute("aria-pressed", "true");
    await expect($(PAGE_TAB)).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-page .fp-title")).toBeDisplayed();
    // The standard view has the card of the same page in place of the orb.
    await $(SIZE).click();
    await expect($(OPEN)).toHaveAttribute("aria-pressed", "true");
    expect(await count("#formation-flow-page-orbs .formation-orb")).toBe(0);
  });

  it("keeps the chip 完了 N in the heading, short, inside the 78px, and shows a done child's orb only while it is pressed", async () => {
    await asCompact(mixed(), {}, true);
    await expect($(FLOW_DONE)).toBeDisplayed();
    await expect($(FLOW_DONE)).toHaveText("✓1");
    await expect($(FLOW_DONE)).toHaveAttribute("aria-label", "完了 1");
    await expect($(FLOW_DONE)).toHaveAttribute("aria-pressed", "false");
    const [head, chip] = [await rectOf("#formation-flow-head"), await rectOf(FLOW_DONE)];
    expect(chip.left).toBeGreaterThanOrEqual(head.left);
    expect(chip.right).toBeLessThanOrEqual(head.right);
    expect(await widthOf("#formation-flow")).toBe(78);
    expect(await browser.execute(() => document.getElementById("formation-flow-head")!.scrollWidth <= document.getElementById("formation-flow-head")!.clientWidth)).toBe(true);
    expect(await orbNames()).not.toContain("api-update");
    await $(FLOW_DONE).click();
    await expect($(FLOW_DONE)).toHaveAttribute("aria-pressed", "true");
    expect(await orbNames()).toEqual(["batch-update", "web-update", "e2e-check", "summary", "api-update"]);
    await expect($(ORB("api-update"))).toHaveAttribute("data-state", "done");
    // The chip opens no tab, as in the standard view.
    expect(await count('#formation-tabs-mates [data-child="api-update"]')).toBe(0);
    await $(FLOW_DONE).click();
    expect(await orbNames()).not.toContain("api-update");
    // Back in the standard view the chip says 完了 N again.
    await $(SIZE).click();
    await expect($(FLOW_DONE)).toHaveText("完了 1");
    expect(await $(FLOW_DONE).getAttribute("aria-label")).toBeNull();
  });

  it("keeps the view that was chosen when the app starts again, and goes back to the standard one when it is pressed again", async () => {
    await openFlow(mixed());
    await $(SIZE).click();
    expect(await storedView()).toBe("1");
    await openFlow(mixed());
    await expect($(SIZE)).toHaveAttribute("aria-pressed", "true");
    expect(await widthOf("#formation-flow")).toBe(78);
    await expect($("#formation-flow-leader")).toBeDisplayed();
    await $(SIZE).click();
    await expect($(SIZE)).toHaveAttribute("aria-pressed", "false");
    expect(await storedView()).toBe("0");
    expect(await widthOf("#formation-flow")).toBe(260);
    await expect($("#formation-flow-root")).toBeDisplayed();
    expect(await cardNames()).toEqual(["batch-update", "web-update", "e2e-check", "summary", "api-update"]);
    await openFlow(mixed());
    await expect($(SIZE)).toHaveAttribute("aria-pressed", "false");
    expect(await widthOf("#formation-flow")).toBe(260);
  });

  it("draws the orbs again in place when a read changes a child, and drops the orb of a child that is gone", async () => {
    await asCompact(mixed(), {}, true);
    await mock("formation_children", [formationChild("web-update", "working"), formationChild("batch-update", "working"), formationChild("added", "working")]);
    await browser.waitUntil(async () => (await orbNames()).length === 3);
    expect(await orbNames()).toEqual(["web-update", "batch-update", "added"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#formation-flow-orbs .formation-orb")].map((e) => (e as HTMLElement).dataset.state))).toEqual(["working", "working", "working"]);
    await mock("formation_children", []);
    await browser.waitUntil(async () => (await orbNames()).length === 0);
    await expect($("#formation-flow-leader")).toBeDisplayed();
    expect(await visible("#formation-flow-arrow")).toBe(false);
  });

  // #1087: the children that the leader told something and that have not answered. The look is checked by the computed colors, not by the text of the rules.
  describe("a child that was told something", () => {
    const told = (...names: string[]) => mock("formation_instructed", names);
    const dotOf = (name: string) => `${ORB(name)} .formation-orb-dot`;
    const kids = () => [formationChild("web-update", "working"), formationChild("batch-update", "working"), formationChild("review-codex", "working", { agent: "codex" }), formationChild("api-update", "done")];

    it("fills the circle of the child in the color of its agent, Claude green and Codex blue, with white text, and leaves the others as they were", async () => {
      await asCompact(kids(), { formation_instructed: ["batch-update", "review-codex", "api-update"] }, true);
      await browser.waitUntil(async () => (await count('#formation-flow-orbs [data-instructed="true"]')) === 2);
      await expect($(ORB("batch-update"))).toHaveAttribute("data-instructed", "true");
      await expect($(ORB("review-codex"))).toHaveAttribute("data-instructed", "true");
      expect(await ground(dotOf("batch-update"))).toBe(await resolvedGround("--accent"));
      expect(await styleOf(dotOf("batch-update"), "color")).toBe(await resolved("--on-accent"));
      expect(await ground(dotOf("review-codex"))).toBe("rgb(37, 84, 180)");
      expect(await styleOf(dotOf("review-codex"), "color")).toBe(await resolved("--on-accent"));
      // The others keep their ground; a done child is not colored although it is in the answer (its orb is shown after the chip).
      expect(await ground(dotOf("web-update"))).not.toBe(await resolvedGround("--accent"));
      await $(FLOW_DONE).click();
      await expect($(ORB("api-update"))).not.toHaveAttribute("data-instructed", "true");
      // It beats; the one that is not told something does not.
      expect(await styleOf(dotOf("batch-update"), "animationName")).toBe("formation-orb-beat");
      expect(await styleOf(dotOf("web-update"), "animationName")).not.toBe("formation-orb-beat");
    });

    it("puts the told children right under the arrow, newest first, and the others after them in the order of the cards", async () => {
      await asCompact(kids(), {}, true);
      expect(await orbNames()).toEqual(["web-update", "batch-update", "review-codex"]);
      await told("review-codex", "batch-update");
      await browser.waitUntil(async () => (await orbNames())[0] === "review-codex");
      expect(await orbNames()).toEqual(["review-codex", "batch-update", "web-update"]);
      const [arrow, first] = [await rectOf("#formation-flow-arrow"), await rectOf("#formation-flow-orbs .formation-orb")];
      expect(arrow.bottom).toBeLessThanOrEqual(first.top);
      // The answer of the child takes it off, and the order is the cards' again.
      await told();
      await browser.waitUntil(async () => (await count('#formation-flow-orbs [data-instructed="true"]')) === 0);
      expect(await orbNames()).toEqual(["web-update", "batch-update", "review-codex"]);
    });

    it("puts the others after the told ones in the order of the cards: working, waiting, planned, and the done one once its chip is pressed", async () => {
      const list = () => [formationChild("plan-one", "planned"), formationChild("wait-one", "waiting"), formationChild("work-one", "working"), formationChild("work-two", "working"), formationChild("done-one", "done")];
      await asCompact(list(), {}, true);
      expect(await orbNames()).toEqual(["work-one", "work-two", "wait-one", "plan-one"]);
      await $(FLOW_DONE).click();
      await browser.waitUntil(async () => (await orbNames()).length === 5);
      expect(await orbNames()).toEqual(["work-one", "work-two", "wait-one", "plan-one", "done-one"]);
      await told("wait-one");
      await browser.waitUntil(async () => (await orbNames())[0] === "wait-one");
      expect(await orbNames()).toEqual(["wait-one", "work-one", "work-two", "plan-one", "done-one"]);
    });

    it("slides the orbs that moved, and does not when the system asks for less motion", async () => {
      await asCompact(kids(), {}, true);
      // Every call of `animate` is counted from here.
      await browser.execute(() => {
        const w = window as unknown as { __slid__: number };
        w.__slid__ = 0;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
          w.__slid__++;
          return animate.apply(this, args);
        };
      });
      await told("review-codex");
      await browser.waitUntil(async () => (await orbNames())[0] === "review-codex");
      const slid = await browser.execute(() => (window as unknown as { __slid__: number }).__slid__);
      // The told one moved up by two places and the two above it down by one.
      const reduced = await browser.execute(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      expect(slid).toBe(reduced ? 0 : 3);
    });

    it("reads it only in the compact view, with the formation's name", async () => {
      await openFlow(kids(), { formation_instructed: ["batch-update"] });
      await waitForCalls("formation_children", 2);
      expect(await callsOf("formation_instructed")).toEqual([]);
      await expect($(SIZE)).toHaveAttribute("aria-pressed", "false");
      await $(SIZE).click();
      const calls = await waitForCalls("formation_instructed", 1);
      expect(calls[0]).toEqual({ name: "formation" });
      await expect($(ORB("batch-update"))).toHaveAttribute("data-instructed", "true");
      // Back in the standard view nothing is called any more.
      await $(SIZE).click();
      const after = (await callsOf("formation_instructed")).length;
      await waitForCalls("formation_children", (await callsOf("formation_children")).length + 1);
      expect((await callsOf("formation_instructed")).length).toBe(after);
    });

    it("keeps the children when the read of the told ones fails, and says why", async () => {
      await asCompact(kids(), {}, true);
      await mock("formation_instructed", rejects("記録を読めません"));
      await browser.waitUntil(async () => (await textsOf("#formation-flow-error")).join("").includes("記録を読めません"));
      expect(await orbNames()).toEqual(["web-update", "batch-update", "review-codex"]);
    });
  });
});

// #1085: who the leader talks with, in the cards of the standard view.
describe("orchestration mode: the talk of the leader and the children in the flow pane", () => {
  const kids = () => [formationChild("req-login", "working"), formationChild("api-update", "working"), formationChild("review-codex", "working", { agent: "codex" })];
  const LI = (name: string) => `#formation-flow-list li[data-name="${name}"]`;
  const CARD_OF = (name: string) => `${LI(name)} .formation-card`;
  const reduced = () => browser.execute(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const talking = () => count("#formation-flow-list li[data-talk]");

  beforeEach(forgetView);
  afterEach(forgetView);

  it("draws an arrow from the trunk to the child the leader sent to, with the label, the blinking dots and a pulsing frame, and a thin gray branch to the others", async () => {
    await openFlow(kids(), { formation_messages: [formationMessage("formation", "req-login", 5)] });
    await browser.waitUntil(async () => (await talking()) === 1);
    await expect($(LI("req-login"))).toHaveAttribute("data-talk", "out");
    await expect($(CARD_OF("req-login"))).toHaveAttribute("data-talk", "out");
    expect(await textsOf(`${CARD_OF("req-login")} .formation-talk-label`)).toEqual(["リーダー → req-login"]);
    expect(await count(`${CARD_OF("req-login")} .formation-talk-dots i`)).toBe(3);
    expect(await textsOf(`${CARD_OF("req-login")} .formation-talk-dots`)).toEqual(["・・・"]);
    expect(await count(`${LI("req-login")} .formation-talk`)).toBe(1);
    // The arrow takes the place of the thin branch; the others keep it.
    expect(await pseudoOf(LI("req-login"), "::before", "backgroundColor")).toBe("rgba(0, 0, 0, 0)");
    expect(await count(`${LI("api-update")} .formation-talk`)).toBe(0);
    await expect($(LI("api-update"))).not.toHaveAttribute("data-talk");
    expect(await count(`${CARD_OF("api-update")} .formation-card-talk`)).toBe(0);
    expect(await pseudoOf(LI("api-update"), "::before", "backgroundColor")).not.toBe("rgba(0, 0, 0, 0)");
    // The frame is in the accent color and the card pulses, the dashes flow, the dot runs and the dots blink; with less motion none of them moves.
    expect(await styleOf(CARD_OF("req-login"), "borderTopColor")).toBe(await resolved("--accent"));
    const names = await browser.execute(() => {
      const one = (s: string, p?: string) => getComputedStyle(document.querySelector(s)!, p).animationName;
      return [one('#formation-flow-list li[data-name="req-login"] .formation-card'), one("#formation-flow-list .formation-talk"), one("#formation-flow-list .formation-talk", "::before"), one("#formation-flow-list .formation-talk-dots i")];
    });
    expect(names).toEqual((await reduced()) ? ["none", "none", "none", "none"] : ["formation-card-pulse", "formation-talk-flow", "formation-talk-dot", "formation-talk-blink"]);
    expect(await styleOf(CARD_OF("api-update"), "animationName")).toBe("none");
  });

  it("turns the arrow and the label round when the child answers", async () => {
    await openFlow(kids(), { formation_messages: [formationMessage("formation", "req-login", 20), formationMessage("req-login", "formation", 5)] });
    await browser.waitUntil(async () => (await talking()) === 1);
    await expect($(LI("req-login"))).toHaveAttribute("data-talk", "in");
    await expect($(CARD_OF("req-login"))).toHaveAttribute("data-talk", "in");
    expect(await textsOf(`${CARD_OF("req-login")} .formation-talk-label`)).toEqual(["req-login → リーダー"]);
    // The head of the arrow is at the trunk's end, the dot and the dashes run the other way.
    const heads = await browser.execute(() => {
      const arrow = document.querySelector("#formation-flow-list .formation-talk")!;
      const after = getComputedStyle(arrow, "::after");
      return [after.borderLeftWidth, after.borderRightWidth, getComputedStyle(arrow).animationDirection, getComputedStyle(arrow, "::before").animationDirection];
    });
    expect(heads).toEqual(["0px", "6px", "reverse", "reverse"]);
  });

  it("takes the direction of the latest message of each child alone, and does not count a message between two children", async () => {
    await openFlow(kids(), {
      formation_messages: [formationMessage("api-update", "formation", 30), formationMessage("formation", "api-update", 20), formationMessage("req-login", "api-update", 10), formationMessage("api-update", "req-login", 5)],
    });
    await browser.waitUntil(async () => (await talking()) === 1);
    await expect($(LI("api-update"))).toHaveAttribute("data-talk", "out");
    await expect($(LI("req-login"))).not.toHaveAttribute("data-talk");
    expect(await count(`${CARD_OF("req-login")} .formation-card-talk`)).toBe(0);
  });

  it("stops the arrow and the pulse when the latest message is older than 60 seconds, and leaves its last line and its time on the card", async () => {
    await openFlow(kids(), { formation_messages: [formationMessage("formation", "req-login", 70, "ログインの要件を確認してください")] });
    await browser.waitUntil(async () => (await count(`${CARD_OF("req-login")} .formation-card-last`)) === 1);
    expect(await talking()).toBe(0);
    expect(await count("#formation-flow-list .formation-talk")).toBe(0);
    expect(await count(`${CARD_OF("req-login")} .formation-talk-dots`)).toBe(0);
    expect(await textsOf(`${CARD_OF("req-login")} .formation-card-last-line`)).toEqual(["ログインの要件を確認してください"]);
    expect((await textsOf(`${CARD_OF("req-login")} .formation-card-last time`))[0]).toMatch(/^\d{2}:\d{2}$/);
    expect(await styleOf(CARD_OF("req-login"), "animationName")).toBe("none");
    expect(await pseudoOf(LI("req-login"), "::before", "backgroundColor")).not.toBe("rgba(0, 0, 0, 0)");
    // A child with no message has no such row.
    expect(await count(`${CARD_OF("api-update")} .formation-card-last`)).toBe(0);
  });

  it("stops by itself when the minute is over, and starts again with a newer message", async () => {
    await openFlow(kids(), { formation_messages: [formationMessage("formation", "req-login", 52)] });
    await browser.waitUntil(async () => (await talking()) === 1);
    await browser.waitUntil(async () => (await talking()) === 0, { timeout: 15_000 });
    await expect($(`${CARD_OF("req-login")} .formation-card-last`)).toBeDisplayed();
    await mock("formation_messages", [formationMessage("formation", "req-login", 70), formationMessage("req-login", "formation", 1)]);
    await browser.waitUntil(async () => (await talking()) === 1);
    await expect($(LI("req-login"))).toHaveAttribute("data-talk", "in");
  });

  it("draws the line of a message as text, never as markup", async () => {
    const line = '<img src="x" onerror="document.title=1"><b>太字</b>';
    await openFlow(kids(), { formation_messages: [formationMessage("formation", "req-login", 90, line)] });
    await browser.waitUntil(async () => (await count(`${CARD_OF("req-login")} .formation-card-last`)) === 1);
    expect(await textsOf(`${CARD_OF("req-login")} .formation-card-last-line`)).toEqual([line]);
    expect(await count(`${CARD_OF("req-login")} .formation-card-last img, ${CARD_OF("req-login")} .formation-card-last b`)).toBe(0);
  });

  it("tells a Codex child by the pale blue ground, and by the blue of its frame while it talks", async () => {
    await openFlow(kids(), { formation_messages: [formationMessage("formation", "review-codex", 5)] });
    await browser.waitUntil(async () => (await talking()) === 1);
    await expect($(CARD_OF("review-codex"))).toHaveAttribute("data-agent", "codex");
    await expect($(CARD_OF("req-login"))).not.toHaveAttribute("data-agent");
    expect(await ground(CARD_OF("review-codex"))).toBe(await resolvedGround("--codex-bg"));
    expect(await ground(CARD_OF("review-codex"))).toBe("rgb(230, 237, 251)");
    expect(await styleOf(CARD_OF("review-codex"), "color")).toBe(await resolved("--codex-fg"));
    expect(await styleOf(CARD_OF("review-codex"), "borderTopColor")).toBe("rgb(37, 84, 180)");
    expect(await ground(CARD_OF("req-login"))).not.toBe("rgb(230, 237, 251)");
    // The arrow is blue too, and a Codex child that is not talking has the ground alone.
    expect(await browser.execute(() => getComputedStyle(document.querySelector('#formation-flow-list li[data-name="review-codex"] .formation-talk')!).backgroundImage.includes("rgb(37, 84, 180)"))).toBe(true);
    await mock("formation_messages", [formationMessage("formation", "review-codex", 90)]);
    await browser.waitUntil(async () => (await talking()) === 0);
    expect(await ground(CARD_OF("review-codex"))).toBe("rgb(230, 237, 251)");
    expect(await styleOf(CARD_OF("review-codex"), "borderTopColor")).not.toBe("rgb(37, 84, 180)");
  });

  it("reads the messages with the formation's name on the clock of the children in the standard view only, and keeps the children when it fails", async () => {
    await openFlow(kids(), { formation_messages: [formationMessage("formation", "req-login", 5)] });
    const calls = await waitForCalls("formation_messages", 2);
    expect(calls[0]).toEqual({ name: "formation" });
    await mock("formation_messages", rejects("記録を読めません"));
    await browser.waitUntil(async () => (await textsOf("#formation-flow-error")).join("").includes("記録を読めません"));
    expect(await cardNames()).toEqual(["req-login", "api-update", "review-codex"]);
    await mock("formation_messages", []);
    await browser.waitUntil(async () => (await textsOf("#formation-flow-error")).join("") === "");
    expect(await talking()).toBe(0);
    // The compact view reads the told ones instead, and the view that comes back reads the messages again.
    await $(SIZE).click();
    await waitForCalls("formation_instructed", 1);
    const before = (await callsOf("formation_messages")).length;
    await browser.pause(WAIT * 2);
    expect((await callsOf("formation_messages")).length).toBe(before);
    await $(SIZE).click();
    await waitForCalls("formation_messages", before + 1);
  });

  it("reads nothing while another screen is shown", async () => {
    await openFlow(kids(), { formation_messages: [formationMessage("formation", "req-login", 5)] });
    await waitForCalls("formation_messages", 1);
    await $("#nav-mail").click();
    const after = (await callsOf("formation_messages")).length;
    await browser.pause(WAIT * 3);
    expect((await callsOf("formation_messages")).length).toBe(after);
  });
});
