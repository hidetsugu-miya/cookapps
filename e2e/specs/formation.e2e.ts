import { boot, callsOf, count, decisionCard, decisionPage, formationChild, formationConsent, formationEntry, formationEnvironments, formationList, holds, inbox, listedChild, mock, onceId, orcaOverview, orcaRow, orcaTerminal, orcaWorktree, rejects, release, sendClaudeCode, sendStream, sendTerm, streamList, textsOf, timers, waitForCalls, CARDS, CARD } from "../support";
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
const pressRestart = () => browser.execute(() => document.getElementById("formation-restart")!.click());
const waitForStarts = (n: number) => browser.waitUntil(async () => (await starts()) === n, { timeoutMsg: `claude_code_start was not called ${n} times` });

// A list with one project that has a session with no pane, so the project is a row of the list and pressing it shows the work pane of Orca with nothing to read.
const ORCA_LIST = () => orcaOverview([orcaRow("api", "main", "Write the docs", { handle: null, paneKey: null })]);
const PROJECT = '#orca-feed .orca-project[data-key="proj_api"]';
const ROW = (name: string) => `#formation-list-feed [data-formation="${name}"]`;
// The line of a formation holds its row, a button, and the chip and the number beside it; it has the ground of the selected row (#1112).
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
    await expect($("#formation-tab-leader-main .formation-tab-effort")).toHaveText("high");
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

  it("has the restart button at the right end of the orchestrator's header, with the icon only", async () => {
    await openFormation();
    const button = $("#formation-restart");
    await expect(button).toHaveAttribute("aria-label", "リーダーを再起動");
    expect(await button.getText()).toBe("");
    expect(await browser.execute(() => document.querySelectorAll("#formation-restart svg").length)).toBe(1);
    const place = await browser.execute(() => {
      const head = document.getElementById("formation-head")!.getBoundingClientRect();
      const button = document.getElementById("formation-restart")!.getBoundingClientRect();
      const tabs = document.getElementById("formation-tabs")!.getBoundingClientRect();
      return { fromRight: Math.round(head.right - button.right), afterTitle: button.left >= tabs.right, children: document.getElementById("formation-head")!.lastElementChild!.id };
    });
    expect(place.children).toBe("formation-restart");
    expect(place.afterTitle).toBe(true);
    expect(place.fromRight).toBeLessThan(40);
  });

  it("ends the running process and starts a new one with the keyboard when the restart button is pressed, and calls no Orca command", async () => {
    await openFormation();
    await waitForStarts(1);
    await sendClaudeCode({ kind: "output", data: "old conversation" });
    await browser.waitUntil(async () => (await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).includes("old conversation"));
    await pressRestart();
    await waitForStarts(2);
    expect(await waitForCalls("claude_code_close")).toEqual([{ id: "formation:formation", launch: 1 }]);
    expect(await callsOf("claude_code_start")).toMatchObject([{ id: "formation:formation", builtinTools: true, skill: null }, { id: "formation:formation", builtinTools: true, skill: null }]);
    // The screen is new, and the terminal takes the keys.
    expect(await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).not.toContain("old conversation");
    expect(await browser.execute(() => document.activeElement?.classList.contains("xterm-helper-textarea") && !!document.activeElement.closest("#formation-term"))).toBe(true);
    await sendClaudeCode({ kind: "output", data: "new conversation" });
    await browser.waitUntil(async () => (await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).includes("new conversation"));
    for (const command of ["orca_stream_terminal", "orca_terminal_read", "orca_stream_input", "formation_launch", "formation_close"]) expect(await callsOf(command)).toEqual([]);
  });

  it("leaves the restart button off until the new start has answered, so a second press starts nothing", async () => {
    await openFormation();
    await waitForStarts(1);
    const start = await mock("claude_code_start", holds);
    await pressRestart();
    await waitForCalls(start);
    await expect($("#formation-restart")).toBeDisabled();
    await pressRestart();
    await browser.pause(300);
    expect(await starts()).toBe(1);
    await release(start, 1);
    await expect($("#formation-restart")).toBeEnabled();
    await mock("claude_code_start", 1);
    await pressRestart();
    await waitForStarts(1);
  });

  it("starts a new process when the restart button is pressed after the process ended", async () => {
    await openFormation();
    await waitForStarts(1);
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました", clean: true });
    await browser.waitUntil(async () => (await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).includes("Claude Code が終わりました"));
    await pressRestart();
    await waitForStarts(2);
    expect(await callsOf("claude_code_start")).toMatchObject([{ id: "formation:formation" }, { id: "formation:formation" }]);
    expect(await $("#formation-term .orca-term-box:not([hidden]) .xterm-rows").getText()).not.toContain("Claude Code が終わりました");
    expect(await browser.execute(() => document.activeElement?.classList.contains("xterm-helper-textarea") && !!document.activeElement.closest("#formation-term"))).toBe(true);
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

async function openFlow(children: unknown, extra: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), orca_overview: ORCA_LIST(), formation_children: children, ...timers({ formationFlow: READ }), ...extra });
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
    await browser.waitUntil(async () => (await cardStates()).join() === "完了,承認待ち,作業中,作業中,予定");
    expect(await cardNames()).toEqual(["api-update", "web-update", "batch-update", "e2e-check", "summary"]);
    expect(await browser.execute(() => document.querySelectorAll("#formation-flow-list button.formation-card").length)).toBe(4);
    // The tabs follow the cards: a tab that is pressed for each launched child, and a tab that is not for the planned one.
    expect(await count('#formation-tabs-mates button[role="tab"]')).toBe(4);
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["api-update", "web-update", "batch-update", "e2e-check", "summary"]);
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

  it("has one button in the heading, 自動で追う at its right end, and nothing that closes the pane or a strip that stays", async () => {
    await openFlow(mixed());
    await expect($("#formation-flow")).toBeDisplayed();
    for (const id of ["formation-flow-toggle", "formation-strip", "formation-strip-open", "formation-flow-split", "formation-session", "formation-child-term", "formation-flow-count"]) expect(await browser.execute((i) => document.getElementById(i), id)).toBeNull();
    expect(await browser.execute(() => [...document.querySelectorAll('#formation-flow-head button, #formation-flow-head [role="button"]')].map((e) => e.id))).toEqual(["formation-follow"]);
    const [head, button] = [await rectOf("#formation-flow-head"), await rectOf("#formation-follow")];
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

// 「自動で追う」 is off when a formation is opened, and most of these specs follow: it is pressed on.
async function followOn() {
  await $("#formation-follow").click();
  await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "true");
}

async function openSession(children: unknown, extra: Record<string, unknown> = {}) {
  await openFlow(children, { ...timers({ formationFlow: READ, orcaMirror: MIRROR }), orca_terminal_read: ["$ claude", "> 確認します"], ...extra });
  await browser.waitUntil(async () => (await cardNames()).length > 0);
  await followOn();
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

  it("puts a tab for each child in the header of the middle pane after the leader's, with the mark of its state and its effort", async () => {
    await openSession(mixed());
    expect(await textsOf("#formation-tabs .formation-tab-name")).toEqual(["リーダー", "api-update", "web-update", "batch-update", "e2e-check", "summary"]);
    expect(await textsOf("#formation-tabs .formation-tab-effort")).toEqual(["high", "medium", "medium", "medium", "medium", "medium"]);
    expect(await textsOf("#formation-tabs-mates .formation-tab-mark")).toEqual(["✓", "●", "◐", "○", "○"]);
    expect(await browser.execute(() => document.getElementById("formation-tabs")!.getAttribute("role"))).toBe("tablist");
    const marks = (state: string) => `#formation-tabs-mates .formation-tab[data-state="${state}"] .formation-tab-mark`;
    expect(await styleOf(marks("done"), "color")).toBe(await resolved("--agent-done"));
    expect(await styleOf(marks("waiting"), "color")).toBe(await resolved("--agent-question"));
    expect(await styleOf(marks("working"), "color")).toBe(await resolved("--agent-working"));
    // The tabs are in the header, level with the restart button at its right end, and the header is above the terminal.
    const [head, tabs, term] = [await rectOf("#formation-head"), await rectOf("#formation-tabs"), await rectOf("#formation-teammate-term")];
    expect(tabs.top).toBeGreaterThanOrEqual(head.top);
    expect(tabs.bottom).toBeLessThanOrEqual(head.bottom + 1);
    expect(head.bottom).toBeLessThanOrEqual(term.top + 1);
  });

  it("marks a Codex child by its agent in its tab, where a Claude Code child has its effort, and on its card", async () => {
    await openSession([formationChild("api-update", "working"), formationChild("review-codex", "working", { agent: "codex" })]);
    expect(await textsOf("#formation-tabs-mates .formation-tab-effort")).toEqual(["medium", "codex"]);
    expect(await textsOf("#formation-flow-list .formation-card-agent")).toEqual(["codex"]);
    expect(await textsOf("#formation-flow-list .formation-card-name")).toEqual(["api-update", "review-codex"]);
  });

  it("draws a planned child's tab dashed and not pressed, and a done child's with a ✓ and a ×", async () => {
    await openSession([formationChild("a-update", "planned"), formationChild("b-update", "done"), formationChild("c-update", "done", { handle: null })]);
    const planned = '#formation-tabs-mates .formation-tab[data-state="planned"]';
    expect(await styleOf(planned, "borderTopStyle")).toBe("dashed");
    expect(await browser.execute((s) => document.querySelector(`${s} .formation-tab-main`)!.tagName, planned)).toBe("SPAN");
    expect(await count(`${planned} .formation-tab-close`)).toBe(0);
    // A done child has the × beside its name, whether or not its terminal is still listed; a done child with no terminal is shown and not pressed.
    expect(await textsOf("#formation-tabs-mates .formation-tab-close")).toEqual(["×", "×"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#formation-tabs-mates .formation-tab-close")].map((b) => b.getAttribute("aria-label")))).toEqual(["b-update を閉じる", "c-update を閉じる"]);
    expect(await browser.execute(() => [...document.querySelectorAll("#formation-tabs-mates .formation-tab")].map((t) => t.querySelector(".formation-tab-main")!.tagName))).toEqual(["SPAN", "BUTTON", "SPAN"]);
    // The cards of the done children have it too, and the card of a child that works has none.
    expect(await count("#formation-flow-list .formation-card-close")).toBe(2);
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
    // The restart button restarts the leader, so it is off while a child's tab is the selected one.
    await expect($("#formation-restart")).toBeDisabled();
  });

  it("selects the leader's tab with its tab and with its card, shows its terminal, and turns 自動で追う off", async () => {
    await openSession(mixed());
    await expect($("#formation-teammate-term")).toBeDisplayed();
    await $("#formation-tab-leader-main").click();
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    expect(await pressed("#formation-flow-root")).toBe("true");
    expect(await pressed("#formation-follow")).toBe("false");
    await expect($("#formation-restart")).toBeEnabled();
    // The card of a child brings its tab and its terminal back, and the leader's card does the leader's.
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
    await $('#formation-tabs-mates [data-child="batch-update"]').click();
    await expect($('#formation-tabs-mates [data-child="batch-update"]')).toHaveAttribute("aria-selected", "true");
    expect(await selectedCard()).toEqual(["batch-update"]);
    expect(await pressed("#formation-follow")).toBe("false");
    await mock("orca_terminal_read", ["$ npm test", "実行中"]);
    await browser.waitUntil(async () => (await screenText()).includes("実行中"));
    expect(await readHandles()).toEqual(["term_batch-update"]);
  });
});

describe("orchestration mode: the session of a child", () => {
  it("starts with 自動で追う off, as an icon button at the right end of the heading of the right pane, and keeps the leader's tab until it is pressed on", async () => {
    await openFlow(mixed());
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    const follow = $("#formation-follow");
    await expect(follow).toHaveAttribute("aria-label", "自動で追う");
    await expect(follow).toHaveAttribute("aria-pressed", "false");
    await expect(follow).toHaveElementClass("icon-btn");
    expect(await follow.getText()).toBe("");
    expect(await count("#formation-follow svg")).toBe(1);
    // A child waits, and the middle pane stays on the leader's tab, where the owner types: nothing is selected.
    await browser.pause(WAIT * 2);
    expect(await selectedCard()).toEqual([]);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    // The heading has it at its right end, after the title.
    expect(await browser.execute(() => document.getElementById("formation-flow-head")!.lastElementChild!.id)).toBe("formation-follow");
    const [head, button, title] = [await rectOf("#formation-flow-head"), await rectOf("#formation-follow"), await rectOf("#formation-flow-head h2")];
    expect(head.right - button.right).toBeLessThan(40);
    expect(title.right).toBeLessThanOrEqual(button.left);
    expect(button.top).toBeGreaterThanOrEqual(head.top);
    expect(button.bottom).toBeLessThanOrEqual(head.bottom);
    // Pressed on, it selects the child that waits, and its tab.
    await follow.click();
    await expect(follow).toHaveAttribute("aria-pressed", "true");
    expect(await selectedCard()).toEqual(["web-update"]);
    await expect($('#formation-tabs-mates [data-child="web-update"]')).toHaveAttribute("aria-selected", "true");
  });

  it("turns 自動で追う off again when another formation is opened", async () => {
    await openList({ formation_children: mixed() });
    await browser.waitUntil(async () => (await cardNames()).length === 5);
    await $("#formation-follow").click();
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "true");
    await row("won-2485").click();
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "false");
    await browser.pause(READ * 2);
    expect(await selectedCard()).toEqual([]);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
  });

  it("shows 自動で追う on with a pale green ground and a green icon, and off with none", async () => {
    await openSession(mixed());
    const look = () =>
      browser.execute(() => {
        const style = getComputedStyle(document.getElementById("formation-follow")!);
        return { ground: style.backgroundColor, icon: style.color };
      });
    expect(await look()).toEqual({ ground: await resolvedGround("--soft"), icon: await resolved("--accent-text") });
    await card("api-update").click();
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "false");
    expect((await look()).ground).toBe("rgba(0, 0, 0, 0)");
    expect((await look()).icon).not.toBe(await resolved("--accent-text"));
  });

  it("follows the child that has waited the longest, and the working child when none waits", async () => {
    await openSession([formationChild("a-update", "working"), formationChild("b-update", "waiting", { minutes: 1 }), formationChild("c-update", "waiting", { minutes: 9 })]);
    expect(await selectedCard()).toEqual(["c-update"]);
    await mock("formation_children", [formationChild("a-update", "working"), formationChild("b-update", "waiting", { minutes: 1 }), formationChild("c-update", "working")]);
    await browser.waitUntil(async () => (await selectedCard())[0] === "b-update");
    await mock("formation_children", [formationChild("a-update", "done"), formationChild("b-update", "working"), formationChild("c-update", "working")]);
    await browser.waitUntil(async () => (await selectedCard())[0] === "b-update");
    // A working child stays selected when another one starts to work before it in the order.
    await mock("formation_children", [formationChild("a-update", "working"), formationChild("b-update", "working"), formationChild("c-update", "done")]);
    await browser.waitUntil(async () => (await card("a-update").getAttribute("data-state")) === "working");
    expect(await selectedCard()).toEqual(["b-update"]);
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the leader's tab when no child waits or works, and nothing was selected", async () => {
    await openSession([formationChild("p-update", "planned"), formationChild("a-update", "done"), formationChild("b-update", "done")]);
    expect(await selectedCard()).toEqual([]);
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-term")).toBeDisplayed();
    await expect($("#formation-teammate-term")).not.toBeDisplayed();
  });

  it("selects a card that is pressed, turns 自動で追う off, and turns it on again with the button", async () => {
    await openSession(mixed());
    await card("api-update").click();
    expect(await selectedCard()).toEqual(["api-update"]);
    await expect($('#formation-tabs-mates [data-child="api-update"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "false");
    await expect(card("api-update")).toHaveAttribute("aria-pressed", "true");
    // Another child waits now: the selection stays.
    await mock("formation_children", [formationChild("api-update", "done"), formationChild("web-update", "working"), formationChild("batch-update", "waiting", { minutes: 3 })]);
    await browser.waitUntil(async () => (await card("batch-update").getAttribute("data-state")) === "waiting");
    expect(await selectedCard()).toEqual(["api-update"]);
    await $("#formation-follow").click();
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "true");
    expect(await selectedCard()).toEqual(["batch-update"]);
    await expect($('#formation-tabs-mates [data-child="batch-update"]')).toHaveAttribute("aria-selected", "true");
  });

  it("selects nothing when the card of a child with no terminal is pressed", async () => {
    await openSession(mixed());
    await card("batch-update").click();
    expect(await selectedCard()).toEqual(["batch-update"]);
    await mock("formation_children", [...mixed().slice(0, 2), formationChild("batch-update", "working"), formationChild("closed-one", "done", { handle: null })]);
    await browser.waitUntil(async () => (await cardNames()).includes("closed-one"));
    await card("closed-one").click();
    expect(await selectedCard()).toEqual(["batch-update"]);
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the focus on the card it was on when the cards are drawn again", async () => {
    await openSession(mixed());
    // A press turns 自動で追う off, so the selection stays where it is while the states change.
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
    // 自動で追う is off each time a formation is opened.
    await followOn();
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
    await mock("orca_terminal_read", ["$ next"]);
    await browser.waitUntil(async () => (await readHandles()).join() === "term_a-update");
    expect(await callsOf("orca_stream_terminal")).toHaveLength(1);
  });

  it("closes the stream of a child of the formation that was shown when another formation is pressed", async () => {
    await openList({ formation_children: studioChildren(), ...timers({ formationFlow: READ, orcaMirror: MIRROR }), ...STUDIO });
    await followOn();
    await waitForCalls("orca_stream_open");
    const [first] = await streamed();
    await mock("formation_children", []);
    await row("won-2485").click();
    expect(await closed()).toEqual([{ handle: "term_lab-update", generation: first.generation }]);
  });

  it("does not give the terminal of the child the keyboard when the follow moves the selection to it, and the press of a tab does", async () => {
    await openSession([formationChild("a-update", "planned")]);
    await $("#formation-term .orca-term-box:not([hidden]) .xterm-screen").click();
    await mock("formation_children", [formationChild("a-update", "working"), formationChild("b-update", "working")]);
    await browser.waitUntil(async () => (await selectedCard())[0] === "a-update");
    await expect($("#formation-teammate-term")).toBeDisplayed();
    expect(await browser.execute(() => document.getElementById("formation-teammate-term")!.contains(document.activeElement))).toBe(false);
    await browser.execute(() => document.querySelector<HTMLElement>('#formation-tabs-mates [data-child="b-update"]')!.click());
    expect(await browser.execute(() => document.getElementById("formation-teammate-term")!.contains(document.activeElement))).toBe(true);
  });

  it("stops reading the terminal of a child that is gone from the list, and draws the next one", async () => {
    await openSession(mixed());
    await waitForCalls("orca_terminal_read");
    await mock("formation_children", [formationChild("batch-update", "working")]);
    await browser.waitUntil(async () => (await cardNames()).join() === "batch-update");
    await mock("orca_terminal_read", ["$ next"]);
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
    await followOn();
    expect((await waitForCalls("orca_terminal_read"))[0]).toEqual({ handle: "term_web-update" });
    await $("#nav-mail").click();
    await mock("orca_terminal_read", ["$"]);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
  });

  it("brings the card of the child that the follow selects into the view of the tree", async () => {
    const many = (lastState: "working" | "waiting") => Array.from({ length: 24 }, (_, i) => formationChild(`child-${String(i).padStart(2, "0")}`, i === 23 ? lastState : "working", { minutes: 2 }));
    await openSession(many("working"));
    await browser.waitUntil(async () => (await cardNames()).length === 24);
    await expect($('#formation-flow-list [data-child="child-00"]')).toHaveAttribute("aria-pressed", "true");
    // The last card is below the view while the tree is at its top.
    const inView = (name: string) =>
      browser.execute((n) => {
        const [body, card] = [document.getElementById("formation-flow-body")!.getBoundingClientRect(), document.querySelector(`#formation-flow-list [data-child="${n}"]`)!.getBoundingClientRect()];
        return card.top >= body.top - 1 && card.bottom <= body.bottom + 1;
      }, name);
    expect(await inView("child-23")).toBe(false);
    await mock("formation_children", many("waiting"));
    await expect($('#formation-flow-list [data-child="child-23"]')).toHaveAttribute("aria-pressed", "true");
    await browser.waitUntil(() => inView("child-23"));
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
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update,batch-update,e2e-check,summary");
    await expect(confirm()).not.toExist();
    // The selection goes to the next child, and the terminal of the closed one is read no more.
    await expect($('#formation-tabs-mates [data-child="batch-update"]')).toHaveAttribute("aria-selected", "true");
    await mock("orca_terminal_read", ["$ next"]);
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
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update,batch-update,e2e-check,summary");
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
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update,web-update,batch-update,e2e-check");
  });

  it("closes a done child with the × of its tab, after the same confirmation, and takes its tab and its card away", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", gone);
    await mock("formation_children", without("api-update"));
    await $('#formation-tabs-mates [data-close="api-update"]').click();
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("api-update を削除しますか？");
    expect(await callsOf(close)).toEqual([]);
    await yes().click();
    expect(await waitForCalls(close)).toEqual([{ formation: "formation", name: "api-update", force: false, path: null }]);
    await browser.waitUntil(async () => (await cardNames()).join() === "web-update,batch-update,e2e-check,summary");
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["web-update", "batch-update", "e2e-check", "summary"]);
  });

  it("closes a done child with the × of its card the same way, and a tab of a child that is not done has no ×", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", gone);
    await mock("formation_children", without("api-update"));
    expect(await count('#formation-tabs-mates [data-close="web-update"]')).toBe(0);
    expect(await count('#formation-flow-list [data-close="web-update"]')).toBe(0);
    await $('#formation-flow-list [data-close="api-update"]').click();
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("api-update を削除しますか？");
    await yes().click();
    expect(await waitForCalls(close)).toEqual([{ formation: "formation", name: "api-update", force: false, path: null }]);
    await browser.waitUntil(async () => (await cardNames()).join() === "web-update,batch-update,e2e-check,summary");
  });

  it("asks for the force when git keeps the worktree of the child whose × was pressed, and keeps the tab", async () => {
    await openSession(mixed());
    const close = await mock("formation_close_child", kept);
    await $('#formation-tabs-mates [data-close="api-update"]').click();
    await yes().click();
    await waitForCalls(close);
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("api-update を削除できませんでした");
    await expect(yes()).toHaveText("強制削除");
    expect(await count('#formation-tabs-mates [data-close="api-update"]')).toBe(1);
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
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update,batch-update,e2e-check,summary");
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
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update,batch-update,e2e-check,summary");
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
    await browser.waitUntil(async () => (await cardNames()).join() === "api-update,batch-update,e2e-check,summary");
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

  it("restarts the orchestrator of the shown formation only", async () => {
    await openList();
    await waitForStarts(1);
    await row("won-2485").click();
    await waitForStarts(2);
    await pressRestart();
    await waitForStarts(3);
    expect(await waitForCalls("claude_code_close")).toMatchObject([{ id: "formation:won-2485" }]);
    expect(await callsOf("claude_code_start")).toMatchObject([{ id: "formation:formation" }, { id: "formation:won-2485" }, { id: "formation:won-2485" }]);
  });

  it("drops the children of the last formation when another is pressed, and an answer of the last one that comes late", async () => {
    await openList({ formation_children: mixed() });
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
    // 「自動で追う」 is off, and the terminal of a child is read when its tab is the selected one: the child is followed.
    await $("#formation-follow").click();
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

  it("says in the pane why the terminal could not be made, and asks again on the restart button", async () => {
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
    await pressRestart();
    expect(await waitForCalls("formation_orchestrator", 1)).toEqual([{ name: "studio-work", restart: true }]);
    await expect($("#formation-term-error")).not.toBeDisplayed();
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"));
    expect(await starts()).toBe(0);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("leaves the restart button off while the first start of the terminal is on its way, so a press is not dropped", async () => {
    await openList({ formation_list: remote(), ...SHOWN }, null);
    const start = await mock("formation_orchestrator", holds);
    await row("studio-work").click();
    await waitForCalls(start);
    await expect($("#formation-restart")).toBeDisabled();
    await release(start, terminal());
    await expect($("#formation-restart")).toBeEnabled();
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"));
  });

  it("does not carry the off restart button of a start on its way over to a formation of this Mac", async () => {
    await openList({ formation_list: remote(), ...SHOWN }, null);
    const start = await mock("formation_orchestrator", holds);
    await row("studio-work").click();
    await waitForCalls(start);
    await expect($("#formation-restart")).toBeDisabled();
    await row("formation").click();
    await waitForStarts(1);
    await expect($("#formation-restart")).toBeEnabled();
    await pressRestart();
    await waitForStarts(2);
    await release(start, terminal());
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
    await expect($("#formation-restart")).toBeEnabled();
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

  it("restarts the terminal through Rust, and shows the new one in place of the old", async () => {
    await openList({ formation_list: remote(), formation_orchestrator: terminal(), ...SHOWN }, "studio-work");
    await browser.waitUntil(async () => (await orchestratorText()).includes("リーダーです"));
    await mock("formation_orchestrator", { environment: "mac-studio", handle: "term_orch2" });
    await mock("orca_terminal_read", ["$ claude", "> 新しいリーダー"]);
    await pressRestart();
    expect(await waitForCalls("formation_orchestrator", 1)).toEqual([{ name: "studio-work", restart: true }]);
    await browser.waitUntil(async () => (await orchestratorText()).includes("新しいリーダー"), { timeoutMsg: "the new terminal never showed" });
    expect((await callsOf("orca_terminal_read")).some((c) => (c as { handle: string }).handle === "term_orch2")).toBe(true);
    await expect($("#formation-restart")).toBeEnabled();
  });
});

// A-41: the decision page of a child, in a tab of the middle pane.
const MARK_AT = Date.now() - 3 * 60_000;
const asking = (extra: Record<string, unknown> = {}) => formationChild("req-login", "working", { pendingPage: { title: "要件の未決事項", atMs: MARK_AT }, ...extra });
const PAGE_TAB = '#formation-tabs-mates [data-page="req-login"]';
const OPEN = '#formation-flow-list [data-open="req-login"]';
const pageCall = () => callsOf("formation_page_read");
// Whether a fold of the page is open.
const folded = (selector: string) => browser.execute((s) => document.querySelector<HTMLDetailsElement>(s)!.open, selector);

// Opens the page of `req-login`: the formation is shown with that child waiting on it, and 「開く」 is pressed.
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
    { key: "A", label: "5 回で 15 分止める", detail: "API の上限と同じ" },
    { key: "B", label: "10 回で 15 分止める", detail: null },
  ],
  recommendation: "A",
  recommendationReason: "今の API の上限と同じ",
});

describe("orchestration mode: the decision page of a child", () => {
  it("says 判断待ち on the card of a child that has a page, with 開く, and gives it a tab right after its own", async () => {
    await openFlow([asking(), formationChild("api-update", "working")]);
    await browser.waitUntil(async () => (await cardNames()).length === 2);
    const card = '#formation-flow-list [data-name="req-login"]';
    expect(await textsOf(`${card} .formation-card-state`)).toEqual(["判断待ち"]);
    expect(await textsOf(`${card} .formation-card-msg`)).toEqual(["要件の未決事項"]);
    expect(await textsOf(`${card} .formation-card-open`)).toEqual(["開く"]);
    await expect($(`${card} .formation-card`)).toHaveAttribute("data-state", "waiting");
    expect(await browser.execute((sel) => getComputedStyle(document.querySelector(sel)!).borderTopColor, `${card} .formation-card`)).toBe(await resolvedGround("--agent-question"));
    expect(await textsOf("#formation-flow-list .formation-card-open")).toEqual(["開く"]);
    expect(await textsOf("#formation-tabs-mates .formation-tab-name")).toEqual(["req-login", "判断: 要件の未決事項", "api-update"]);
    await expect($(PAGE_TAB)).toHaveAttribute("role", "tab");
    await expect($(PAGE_TAB)).toHaveAttribute("aria-selected", "false");
    // The page is read only when it is shown.
    expect(await pageCall()).toEqual([]);
  });

  it("shows the page in place of the terminal when 開く is pressed, and reads it once for the formation and the child", async () => {
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

  it("opens the same page from its tab", async () => {
    await openFlow([asking()], { formation_page_read: decisionPage() });
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    await $(PAGE_TAB).click();
    await expect($("#formation-page .fp-title")).toBeDisplayed();
    await expect($("#formation-term")).not.toBeDisplayed();
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
    // The page's one button that sends is at its end.
    expect(await textsOf("#formation-page button")).toEqual(["選択を取り消す", "リーダーに送る"]);
  });

  it("gives the other kinds of card the fixed choices of their kind, and a field for a note", async () => {
    const approval = decisionPage({
      pageKind: "approval",
      subject: "design",
      what: "設計を承認します",
      needsUserDecision: [decisionCard("NR-1", { kind: "nr", options: [{ key: "A", label: "案 A", detail: null }], recommendation: "A", recommendationReason: "単純" })],
      residualMustFix: [decisionCard("MF-1", { kind: "must-fix", recommendation: "fix", recommendationReason: "壊れる" })],
      structuralProposals: [decisionCard("SP-1", { kind: "structural-proposal", recommendation: "approve", recommendationReason: "重複が減る" })],
      adr: decisionCard("ADR-1", { kind: "adr", recommendation: "keep", recommendationReason: "残す価値がある" }),
      qualityLoop: { rounds: 2, mustFixResolved: 3 },
    });
    await openPage(approval);
    const labels = (n: string) => textsOf(`#formation-page [data-card="${n}"] .fp-choice-label`);
    expect(await labels("NR-1")).toEqual(["A案 A推奨", "その他"]);
    expect(await labels("MF-1")).toEqual(["指摘のとおり修正する推奨", "今回は対応しない"]);
    expect(await labels("SP-1")).toEqual(["承認推奨", "却下", "保留"]);
    expect(await labels("ADR-1")).toEqual(["残す推奨", "不要"]);
    expect(await textsOf('#formation-page [data-card="SP-1"] .fp-note > span')).toEqual(["理由（却下・保留のとき）"]);
    expect(await textsOf('#formation-page [data-card="MF-1"] .fp-note > span')).toEqual(["補足（任意）"]);
    expect(await textsOf("#formation-page .fp-sec")).toEqual(["何が変わるか", "判断が必要 1 件", "未解消の必ず直す指摘 1 件", "構造改善の提案 1 件", "ADR（設計判断の記録） 1 件", "あなたの判定"]);
    await $("#formation-page .fp-reference > summary").click();
    expect(await textsOf("#formation-page .fp-reference .fp-ref .fp-p")).toEqual(["実施回数: 2 回", "解消した必ず直す指摘: 3 件"]);
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
    await $("#formation-page .fp-reference > summary").click();
    expect(await textsOf("#formation-page .fp-reference .fp-ev-path")).toEqual(["https://example.com/pr/1"]);
  });

  it("draws the blocks, the facts and the evidence of a card behind 詳しく見る", async () => {
    const card = decisionCard("Q1", {
      background: "今の上限は 5 回",
      facts: [{ label: "場所", value: "api/auth" }],
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
        { type: "diff", summary: "文言を変えた", name: "a.txt", before: ["古い"], after: ["新しい"], note: null },
        { type: "git-diff", summary: "回数を直した", root: "api", path: "lock.rb", base: "main", head: null, note: null, diff: "@@ -1 +1 @@\n-LIMIT = 5\n+LIMIT = 10\n keep", truncated: true },
        { type: "node", root: "deliverables", ref: "design.json#/designs/DESIGN-01", note: null, text: JSON.stringify({ id: "DESIGN-01", steps: ["a", "b"], deep: { n: 1 } }, null, 2) },
      ],
    });
    await openPage(decisionPage({ questions: [card] }));
    const more = '#formation-page [data-card="Q1"] .fp-more';
    expect(await folded(more)).toBe(false);
    await $(`${more} > summary`).click();
    expect(await folded(more)).toBe(true);
    expect(await textsOf(`${more} .fp-h`)).toEqual(["背景", "比べ方"]);
    expect(await textsOf(`${more} .fp-facts dt`)).toEqual(["場所"]);
    expect(await textsOf(`${more} .fp-facts dd`)).toEqual(["api/auth"]);
    expect(await textsOf(`${more} .fp-list li`)).toEqual(["一つめ", "二つめ"]);
    expect(await textsOf(`${more} .fp-callout`)).toEqual(["注意してください"]);
    expect(await textsOf(`${more} .fp-table th`)).toEqual(["案", "回数"]);
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} .fp-table td`)].map((e) => (e as HTMLElement).dataset.changed ?? ""), more)).toEqual(["", "true"]);
    expect(await textsOf(`${more} > .fp-before-after .fp-side-caption`)).toEqual(["今", "直したあと"]);
    expect(await textsOf(`${more} .fp-folded > summary`)).toEqual(["詳しい理由"]);
    // An excerpt has the numbers of its lines, and marks the highlighted one.
    expect(await textsOf(`${more} [data-evidence="excerpt"] .fp-ln`)).toEqual(["10", "11", "12"]);
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} [data-evidence="excerpt"] .fp-line`)].map((e) => (e as HTMLElement).dataset.highlight ?? ""), more)).toEqual(["", "true", ""]);
    expect(await textsOf(`${more} [data-evidence="excerpt"] .fp-ev-note`)).toEqual(["ここが要"]);
    // A difference: the two sides, and a git diff with its added and removed lines marked.
    expect(await textsOf(`${more} [data-evidence="diff"] .fp-side-caption`)).toEqual(["変更前", "変更後"]);
    expect(await browser.execute((s) => [...document.querySelectorAll(`${s} [data-evidence="git-diff"] .fp-line`)].map((e) => (e as HTMLElement).dataset.kind), more)).toEqual(["hunk", "del", "ins", "ctx"]);
    expect(await textsOf(`${more} [data-evidence="git-diff"] .fp-ev-range`)).toEqual(["main → 作業ツリー"]);
    expect(await textsOf(`${more} [data-evidence="git-diff"] > .fp-ev-note`)).toEqual(["途中で切れています"]);
    // A node is a tree of its values.
    expect(await textsOf(`${more} [data-evidence="node"] .fp-leaf-value`)).toEqual(["DESIGN-01", "a", "b", "1"]);
  });

  it("puts the text of a page in as text and never as HTML", async () => {
    const hostile = '<img src=x onerror="document.title=1"><b>太字</b>';
    await openFlow([asking({ pendingPage: { title: hostile, atMs: MARK_AT } })], {
      formation_page_read: decisionPage({ title: hostile, what: null, questions: [decisionCard("Q1", { title: hostile, summary: hostile })] }),
    });
    await browser.waitUntil(async () => (await cardNames()).length === 1);
    await $(OPEN).click();
    await expect($("#formation-page .fp-title")).toHaveText(hostile);
    expect(await count("#formation-page img, #formation-page b, #formation-tabs img, #formation-flow-list img")).toBe(0);
    expect(await textsOf(PAGE_TAB)).toEqual([`●判断: ${hostile}`]);
  });

  it("draws a diagram with Mermaid as an SVG, and shows the source as text when it cannot", async () => {
    const good = "flowchart TD\n  A[開始] --> B[終了]";
    await openPage(decisionPage({ questions: [decisionCard("Q1", { options: [{ key: "A", label: "案", detail: null }], blocks: [{ type: "diagram", mermaid: good, caption: "流れ" }] })], changes: [] }));
    const box = '#formation-page [data-card="Q1"] .fp-diagram-box';
    await browser.waitUntil(async () => (await $(box).getAttribute("data-drawn")) === "true", { timeoutMsg: "Mermaid never drew the diagram" });
    expect(await count(`${box} svg`)).toBe(1);
    expect(await $(`${box} svg`).getAttribute("aria-label")).toBe("流れ");
    expect(await browser.execute((s) => document.querySelector(s)!.textContent, `${box} svg`)).toContain("開始");
    expect(await textsOf('#formation-page [data-card="Q1"] figcaption')).toEqual(["流れ"]);
    // The app's icon rule (`svg { width: 20px }`) does not shrink the diagram: it is as wide as the smaller of the box and its own width (#1089).
    const size = await browser.execute((s) => {
      const svg = document.querySelector(s) as SVGSVGElement;
      const box = svg.parentElement as HTMLElement;
      const cs = getComputedStyle(box);
      return {
        width: svg.getBoundingClientRect().width,
        boxWidth: box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        ownWidth: svg.viewBox.baseVal.width,
        fill: getComputedStyle(svg).fill,
        stroke: getComputedStyle(svg).stroke,
      };
    }, `${box} svg`);
    expect(size.width).not.toBe(20);
    expect(Math.abs(size.width - Math.min(size.boxWidth, size.ownWidth))).toBeLessThan(1);
    expect(size.stroke).toBe("none");
    expect(await browser.execute(() => document.querySelectorAll('script[src$="mermaid.min.js"]').length)).toBe(1);
    // The diagram is in the card, not behind 詳しく見る.
    expect(await count('#formation-page [data-card="Q1"] .fp-more')).toBe(0);
  });

  it("draws a diagram behind 詳しく見る only when that fold is first opened", async () => {
    const good = "flowchart TD\n  A[開始] --> B[終了]";
    await openPage(
      decisionPage({
        questions: [
          decisionCard("Q1", {
            options: [{ key: "A", label: "案", detail: null }],
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
    const inside = '#formation-page [data-card="Q1"] .fp-more .fp-diagram-box';
    await browser.waitUntil(async () => $(`${boxes}[data-drawn="true"]`).isExisting(), { timeoutMsg: "the diagram of the card was not drawn" });
    // The diagram in the closed fold waits: it is not drawn and has no SVG.
    expect(await $(inside).getAttribute("data-pending")).toBe("true");
    expect(await $(inside).getAttribute("data-drawn")).toBe(null);
    expect(await count(`${inside} svg`)).toBe(0);
    await $('#formation-page [data-card="Q1"] .fp-more > summary').click();
    await browser.waitUntil(async () => (await $(inside).getAttribute("data-drawn")) === "true", { timeoutMsg: "the diagram was not drawn when the fold opened" });
    expect(await count(`${inside} svg`)).toBe(1);
    expect(await $(inside).getAttribute("data-pending")).toBe(null);
  });

  it("shows the Mermaid source as text when the diagram cannot be drawn", async () => {
    const bad = "flowchart TD\n  A[開始 --> ((";
    await openPage(decisionPage({ questions: [decisionCard("Q1", { blocks: [{ type: "paragraph", text: "x" }, { type: "diagram", mermaid: bad, caption: null }] })] }));
    await $('#formation-page [data-card="Q1"] .fp-more > summary').click();
    const box = '#formation-page [data-card="Q1"] .fp-diagram-box';
    await browser.waitUntil(async () => (await $(box).getAttribute("data-failed")) === "true", { timeoutMsg: "the diagram did not fail" });
    expect(await count(`${box} svg`)).toBe(0);
    expect(await textsOf(`${box} .fp-diagram-source`)).toEqual([bad]);
    await expect($(`${box} .fp-diagram-source`)).toBeDisplayed();
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
    expect(await textsOf("#formation-flow-list .formation-card-open")).toEqual([]);
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
  const QUESTION_2 = decisionCard("Q2", { title: "いつまでに決めるか", options: [{ key: "A", label: "今週", detail: null }], recommendation: "A", recommendationReason: "早い" });
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
          { card: "Q1", choice: "B", note: "" },
          { card: "Q2", choice: "other", note: "来週の頭" },
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
      qualityLoop: { rounds: 2, mustFixResolved: 3 },
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
          { card: "MF-1", choice: "skip", note: "" },
          { card: "SP-1", choice: "reject", note: "重複は減らない" },
          { card: "ADR-1", choice: null, note: "" },
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
          { card: "Q1", choice: "A", note: "" },
          { card: "Q2", choice: "A", note: "" },
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
      needsUserDecision: [decisionCard("NR-1", { kind: "nr", title: "どちらにするか", options: [{ key: "A", label: "案 A", detail: null }], recommendation: "A", recommendationReason: "単純" })],
      residualMustFix: [decisionCard("MF-1", { kind: "must-fix", recommendation: "fix", recommendationReason: "壊れる" })],
      structuralProposals: [decisionCard("SP-1", { kind: "structural-proposal", recommendation: "approve", recommendationReason: "重複が減る" })],
      qualityLoop: { rounds: 2, mustFixResolved: 3 },
      ...extra,
    });

  it("puts 「あなたの判定」 under the cards with the two choices of the page's subject, and sends nothing until one is chosen", async () => {
    await openPage(approvalPage());
    expect(await textsOf(`${VERDICT} .fp-sec`)).toEqual(["あなたの判定"]);
    expect(await textsOf(`${VERDICT} .fp-choice-label`)).toEqual(["基本設計を承認する", "基本設計の修正を依頼する"]);
    // The verdict is below the cards and above the button, and nothing is chosen at first.
    expect(await browser.execute((s) => document.querySelector(s)!.nextElementSibling!.className, VERDICT)).toBe("fp-send");
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
          { card: "NR-1", choice: null, note: "" },
          { card: "MF-1", choice: "skip", note: "" },
          { card: "SP-1", choice: null, note: "" },
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
        needsUserDecision: [decisionCard("RD-1", { kind: "review-decision", options: [{ key: "A", label: "案 A", detail: null }], recommendation: "A", recommendationReason: "単純" })],
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
    // The tab that was selected before is shown again, and the card says what the child does.
    await expect($("#formation-teammate-term")).toBeDisplayed();
    expect(await textsOf("#formation-flow-list .formation-card-open")).toEqual([]);
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
});

// A-37: the launched children under the row of their formation in the list.
const CHILD = (name: string) => `#formation-list-feed .formation-child[data-child="${name}"]`;
const childRows = () => textsOf("#formation-list-feed .formation-child");
const DONE_CHIP = (name: string) => `#formation-list-feed .formation-done[data-done-for="${name}"]`;
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
    // The done child of the third formation is left out until its chip is pressed.
    await $(DONE_CHIP("mail-summary")).click();
    expect(await childRows()).toEqual(["auth-api" + "wonder-api ・ child-auth", "add-tests" + "wonder-front ・ child-test", "old-one" + "tsunagiai ・ old"]);
    expect(await textsOf(".formation-child .formation-child-name")).toEqual(["auth-api", "add-tests", "old-one"]);
    expect(await textsOf(".formation-child .formation-child-where")).toEqual(["wonder-api ・ child-auth", "wonder-front ・ child-test", "tsunagiai ・ old"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".formation-child .orca-ic")].map((e) => [e.dataset.status, e.getAttribute("aria-label")]))).toEqual([
      ["working", "作業中"],
      ["question", "承認待ち"],
      ["done", "完了"],
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
    expect(await childRows()).toEqual([]);
    // The count stays while the children are folded, and the press of the arrow selects nothing.
    expect(await textsOf(`${LINES} .formation-row-count`)).toEqual(["2", "1"]);
    expect(await pressedRows()).toEqual([]);
    await $(arrow).click();
    await expect($(arrow)).toHaveAttribute("aria-expanded", "true");
    expect(await childRows()).toHaveLength(2);
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
    await $(DONE_CHIP("mail-summary")).click();
    await $(CHILD("old-one")).click();
    expect(await pressedRows()).toEqual(["mail-summary"]);
    await expect($('#formation-tabs-mates [data-child="old-one"]')).toHaveAttribute("aria-selected", "true");
  });

  it("selects the formation and leaves the leader's tab for a child that has no terminal", async () => {
    await openList({ formation_list: withChildren(), formation_children: [formationChild("old-one", "done", { handle: null })] }, null);
    await $(DONE_CHIP("mail-summary")).click();
    await $(CHILD("old-one")).click();
    expect(await pressedRows()).toEqual(["mail-summary"]);
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
  const chips = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>("#formation-list-feed .formation-done")].map((e) => [e.dataset.doneFor, e.textContent, e.getAttribute("aria-pressed")]));
  const mixedList = () =>
    formationList([
      formationEntry("formation"),
      formationEntry("won-2485", { children: [listedChild("auth-api", "working"), listedChild("add-tests", "done"), listedChild("old-one", "waiting"), listedChild("last-one", "done")], counts: { planned: 0, waiting: 1, working: 1, done: 2 } }),
    ]);

  it("leaves the done children out, puts the chip 完了 N before the number, and has none for a formation that has no done child", async () => {
    await openList({ formation_list: withChildren() }, null);
    expect(await chips()).toEqual([["mail-summary", "完了 1", "false"]]);
    await openList({ formation_list: mixedList() }, null);
    expect(await childRows()).toEqual(["auth-api" + "example-api ・ formation/auth-api", "old-one" + "example-api ・ formation/old-one"]);
    expect(await chips()).toEqual([["won-2485", "完了 2", "false"]]);
    // The number counts every launched child, the done ones too.
    expect(await textsOf(`${LINES} .formation-row-count`)).toEqual(["4"]);
    // The chip is in the line of its formation, beside the row and before the number, and is no part of the row's button.
    const place = await browser.execute(() => {
      const line = document.querySelector('#formation-list-feed .formation-row[data-formation="won-2485"]')!.closest(".formation-line")!;
      const [row, chip, n] = [line.querySelector(".formation-row")!, line.querySelector(".formation-done")!, line.querySelector(".formation-row-count")!];
      return { before: chip.getBoundingClientRect().right <= n.getBoundingClientRect().left, beside: row.getBoundingClientRect().right <= chip.getBoundingClientRect().left, outside: !row.contains(chip) && chip.closest("button") === chip };
    });
    expect(place).toEqual({ before: true, beside: true, outside: true });
  });

  it("shows the done children in the order of the record with a press on the chip, with the colors of a pressed chip, and leaves them out with another press", async () => {
    await openList({ formation_list: mixedList() }, null);
    const unpressed = await styleOf(DONE_CHIP("won-2485"), "backgroundColor");
    await $(DONE_CHIP("won-2485")).click();
    expect(await childRows()).toEqual(["auth-api" + "example-api ・ formation/auth-api", "add-tests" + "example-api ・ formation/add-tests", "old-one" + "example-api ・ formation/old-one", "last-one" + "example-api ・ formation/last-one"]);
    expect(await chips()).toEqual([["won-2485", "完了 2", "true"]]);
    expect(await styleOf(DONE_CHIP("won-2485"), "backgroundColor")).toBe(await resolved("--soft"));
    expect(await styleOf(DONE_CHIP("won-2485"), "backgroundColor")).not.toBe(unpressed);
    await $(DONE_CHIP("won-2485")).click();
    expect(await childRows()).toHaveLength(2);
    expect(await chips()).toEqual([["won-2485", "完了 2", "false"]]);
  });

  it("selects nothing with a press on the chip, and keeps the shown children when the list is read again", async () => {
    await openList({ formation_list: mixedList() }, null);
    await $(DONE_CHIP("won-2485")).click();
    expect(await pressedRows()).toEqual([]);
    await expect($("#formation")).not.toBeDisplayed();
    await mock("formation_list", mixedList());
    await mock("formation_list", formationList([formationEntry("formation"), formationEntry("won-2485", { children: [listedChild("auth-api", "working"), listedChild("add-tests", "done")] })]));
    await browser.waitUntil(async () => (await childRows()).length === 2);
    expect(await chips()).toEqual([["won-2485", "完了 1", "true"]]);
    // A press on the number is a press on the row.
    await $(`${LINE_OF("won-2485")} .formation-row-count`).click();
    expect(await pressedRows()).toEqual(["won-2485"]);
  });

  it("keeps the chip and the number in the line when the name is long, and cuts the name with an ellipsis", async () => {
    const long = "a-very-long-formation-name-that-does-not-fit-in-the-list-pane-at-all";
    await openList({ formation_list: formationList([formationEntry(long, { children: [listedChild("auth-api", "working"), listedChild("add-tests", "done")] })]) }, null);
    const fit = await browser.execute(() => {
      const line = document.querySelector("#formation-list-feed .formation-line")!.getBoundingClientRect();
      const name = document.querySelector<HTMLElement>("#formation-list-feed .formation-row-name")!;
      const [chip, n] = [".formation-done", ".formation-row-count"].map((s) => document.querySelector(s)!.getBoundingClientRect());
      return { cut: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, inside: chip.right <= n.left && n.right <= line.right, nameBeforeChip: name.getBoundingClientRect().right <= chip.left };
    });
    expect(fit).toEqual({ cut: true, ellipsis: "ellipsis", inside: true, nameBeforeChip: true });
  });
});

// A-8, A-16, A-37 (#947, #1079): the sessions of a launched child are under their project with the mark of their formation, and its worktree is not offered where a session starts.
describe("orchestration mode: the children's sessions in the projects", () => {
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
  // The row of a session is the name of its worktree (A-8).
  const sessionNames = () => textsOf("#orca-feed .orca-session .orca-session-title");
  // The names of the formations on the rows of the sessions: only a child's session has one.
  const formationMarks = () => textsOf("#orca-feed .orca-session .orca-session-formation-name");
  // The project row has no count of its sessions (#1033): the counts are on the session rows.
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

  it("draws the sessions of a child's worktree under its project after the owner's, with the mark and the name of the formation, and draws no count of sessions on the project row", async () => {
    await openScreen({}, async () => (await formationMarks()).length === 2);
    expect(await sessionNames()).toEqual(["api ・ main", "api ・ child-a", "api ・ child-a"]);
    expect(await formationMarks()).toEqual(["formation", "formation"]);
    expect(await numberCount()).toBe(0);
    // The owner's session has no mark, and a child's has the mark of a formation (the same drawing as the heading of the list) and the name, after its worktree's name.
    expect(await count('#orca-feed [data-session="claude:tab_own:leaf_1"] .orca-session-formation')).toBe(0);
    expect(await count('#orca-feed [data-session="claude:tab_child:leaf_1"] .orca-session-formation svg')).toBe(1);
    expect(await browser.execute(() => document.querySelector('#orca-feed [data-session="claude:tab_child:leaf_1"] .orca-session-formation svg')!.innerHTML === document.querySelector("#orca-formations .orca-list-head svg")!.innerHTML)).toBe(true);
    expect(await count('#orca-feed [data-session="orca:term_child_sh"] .orca-session-formation')).toBe(1);
  });

  it("selects the formation and shows the child's tab when the session of a child in the project is pressed, and leaves the project's work pane as it was", async () => {
    await openScreen({ formation_children: [formationChild("child-a", "working", { repo: "api", branch: "child-a" }), formationChild("child-b", "working")] }, async () => (await formationMarks()).length === 2);
    await $('#orca-feed [data-session="claude:tab_child:leaf_1"]').click();
    expect(await pressedRows()).toEqual(["formation"]);
    await expect($("#formation")).toBeDisplayed();
    await expect($('#formation-tabs-mates [data-child="child-a"]')).toHaveAttribute("aria-selected", "true");
    await expect($("#formation-tab-leader-main")).toHaveAttribute("aria-selected", "false");
    // Pressing the project again leaves the formation, and the child's session was not a tab of the project.
    await $(PROJECT).click();
    await expect($("#orca-session")).toBeDisplayed();
    expect(await count('[data-tab="claude:tab_child:leaf_1"]')).toBe(0);
  });

  it("lists a project with nothing but a child's sessions among the running projects, above the link of the ones that are not running", async () => {
    await openScreen({ orca_overview: overview([childRow({ group: "done" })], [...trees(), orcaWorktree("web", "main")]) }, async () => (await count(".orca-stopped-toggle")) === 1);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-project, #orca-feed .orca-stopped-toggle")].map((e) => e.dataset.key))).toEqual(["proj_api", "stopped-toggle"]);
    expect(await textsOf("#orca-feed .orca-stopped-toggle")).toEqual(["起動していない 1 件"]);
  });

  it("draws every session of the project when no child of the record is in its worktrees", async () => {
    await openScreen({ formation_list: formationList([formationEntry("formation")]) }, async () => (await sessionNames()).length === 3);
    expect(await sessionNames()).toEqual(["api ・ main", "api ・ child-a", "api ・ child-a"]);
    expect(await formationMarks()).toEqual([]);
    // A child whose worktree is not the path of any row leaves every session as it is, and so does the same path on another PC.
    await mock("formation_list", formationList([formationEntry("formation", { children: [listedChild("c", "working", { path: "/work/elsewhere" }), listedChild("d", "working", { path: CHILD_PATH, environment: "dev-server" })] })]));
    await browser.waitUntil(async () => (await count(".formation-row-count")) === 1);
    expect(await sessionNames()).toEqual(["api ・ main", "api ・ child-a", "api ・ child-a"]);
    expect(await formationMarks()).toEqual([]);
  });

  it("takes the mark off the sessions when the child leaves the record", async () => {
    await openScreen({}, async () => (await formationMarks()).length === 2);
    await mock("formation_list", formationList([formationEntry("formation")]));
    await browser.waitUntil(async () => (await formationMarks()).length === 0, { timeout: 15_000 });
    expect(await sessionNames()).toEqual(["api ・ main", "api ・ child-a", "api ・ child-a"]);
  });

  it("keeps the folder of a child that works in a folder that was there, and the owner's session in it, and marks only the child's own sessions", async () => {
    // The child works in the project's own folder (`created` false): its Claude row and its terminal leave the project, and the owner's session in the same folder stays.
    const inFolder = (name: string, handle: string, paneKey: string) => listedChild(name, "working", { repo: "api", branch: "main", path: MAIN_PATH, created: false, handle, paneKey });
    const kept = formationList([formationEntry("formation", { children: [inFolder("child-a", "term_child", "tab_child:leaf_1"), inFolder("codex-a", "term_codex", "tab_codex:leaf_1")], counts: { planned: 0, waiting: 0, working: 2, done: 0 } })]);
    const inOwnFolder = orcaOverview([ownRow(), childRow({ path: MAIN_PATH, branch: "main" })], [orcaWorktree("api", "main"), orcaWorktree("api", "other", { path: OTHER_PATH })], { terminals: [orcaTerminal("api", "zsh", { path: MAIN_PATH, handle: "term_own_sh" }), orcaTerminal("api", "codex", { path: MAIN_PATH, handle: "term_codex" })] });
    await openScreen({ orca_overview: inOwnFolder, formation_list: kept });
    await browser.waitUntil(async () => (await formationMarks()).length === 2);
    expect(await sessionNames()).toEqual(["api ・ main", "api ・ main", "api ・ main", "api ・ main"]);
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-feed .orca-session")].map((e) => e.dataset.session))).toEqual(["claude:tab_own:leaf_1", "orca:term_own_sh", "claude:tab_child:leaf_1", "orca:term_codex"]);
    expect(await count('#orca-feed [data-session="claude:tab_own:leaf_1"] .orca-session-formation, #orca-feed [data-session="orca:term_own_sh"] .orca-session-formation')).toBe(0);
    // The work pane has the owner's tabs only, and the folder stays among the worktrees of the plus.
    await mock("orca_start", { paneKey: null, handle: null });
    await pressPlus();
    await expect($('[data-tab="claude:tab_own:leaf_1"]')).toExist();
    expect(await count('[data-tab="claude:tab_child:leaf_1"], [data-tab="orca:term_codex"]')).toBe(0);
    await pickItem("Claude を起動");
    await expect($(".orca-dest-pop")).toBeDisplayed();
    expect(await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".orca-dest-pop button[data-path]")].map((b) => b.dataset.path))).toEqual([MAIN_PATH, OTHER_PATH]);
  });

  it("opens the project when a child works in it, and gives a project with nothing but a child's sessions the arrow", async () => {
    // Its own session is done and the child's works: the project is opened for the child's work, as for any session's.
    await openScreen({ orca_overview: overview([ownRow({ group: "done" }), childRow()]) }, async () => (await formationMarks()).length === 2);
    await expect(arrow()).toHaveAttribute("aria-expanded", "true");
    expect(await sessionNames()).toEqual(["api ・ main", "api ・ child-a", "api ・ child-a"]);
    await openScreen({ orca_overview: overview([childRow()], trees()) }, async () => (await formationMarks()).length === 2);
    expect(await count('#orca-feed [data-key^="arrow:"]')).toBe(1);
    expect(await sessionNames()).toEqual(["api ・ child-a", "api ・ child-a"]);
    expect(await numberCount()).toBe(0);
  });

  it("still counts a child's session in the sidebar button, which marks the work and the wait", async () => {
    await openScreen({ orca_overview: overview([ownRow(), childRow({ group: "waiting" })]) }, async () => (await formationMarks()).length === 2);
    await expect($("#nav-orca")).toHaveAttribute("aria-label", "開発（確認待ち 1 件、作業中 1 件）");
    await expect($("#nav-orca .nav-count")).toHaveText("1");
    expect(await sessionNames()).toEqual(["api ・ main", "api ・ child-a", "api ・ child-a"]);
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
