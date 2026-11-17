import { boot, callsOf, count, formationChild, formationEntry, formationEnvironments, formationList, holds, inbox, mock, onceId, orcaOverview, orcaRow, rejects, release, sendClaudeCode, textsOf, timers, waitForCalls } from "../support";
import type { FormationList } from "../../ts/bindings/FormationList";

// A-37: the development screen's orchestration mode. The orchestrator's pane is Claude Code of A-36 (`kind: "formation"`), so its process is the mocked `claude_code_start`.
const FOOTER_MODES = "#footer-modes";
const visible = (selector: string) => browser.execute((s) => document.querySelector(s)?.getClientRects().length !== 0 && !document.querySelector<HTMLElement>(s)!.hidden, selector);
const pressed = (id: string) => browser.execute((i) => document.getElementById(i)!.getAttribute("aria-pressed"), id);
const nameOf = (id: string) => browser.execute((i) => [...document.querySelectorAll<HTMLElement>(`#${i} .footer-mode-name`)].filter((e) => !e.hidden).map((e) => e.textContent), id);
const starts = async () => (await callsOf("claude_code_start")).length;
// The press is made in the page: the driver takes the focus to the button after its click, which a real press does before.
const pressRestart = () => browser.execute(() => document.getElementById("formation-restart")!.click());
const waitForStarts = (n: number) => browser.waitUntil(async () => (await starts()) === n, { timeoutMsg: `claude_code_start was not called ${n} times` });

// Opens the mode. No formation is selected at the start, so the row of `select` (the one the default fixture has, `formation`) is pressed unless it is `null`.
async function openFormation(select: string | null = "formation") {
  await $("#nav-orca").click();
  await $("#footer-mode-formation").click();
  await expect($("#formation")).toBeDisplayed();
  if (select !== null) await $(`#formation-list-feed [data-formation="${select}"]`).click();
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

  it("switches to the orchestration with its three panes, and the name moves to its icon", async () => {
    await boot({ inbox: inbox(), formation_children: [formationChild("api-update", "planned")] });
    await openFormation();
    await expect($("#formation-flow")).toBeDisplayed();
    await expect($("#orca")).not.toBeDisplayed();
    expect(await pressed("footer-mode-orca")).toBe("false");
    expect(await pressed("footer-mode-formation")).toBe("true");
    expect(await nameOf("footer-mode-orca")).toEqual([]);
    expect(await nameOf("footer-mode-formation")).toEqual(["オーケストレーション"]);
    await expect($("#nav-orca")).toHaveAttribute("aria-current", "page");
    const lefts = await browser.execute(() => ["formation-list", "formation-orchestrator", "formation-flow"].map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().left)));
    expect(lefts[0]).toBeLessThan(lefts[1]);
    expect(lefts[1]).toBeLessThan(lefts[2]);
    await expect($("#formation-orchestrator h1")).toHaveText("司令塔");
    await $("#footer-mode-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await expect($("#formation")).not.toBeDisplayed();
    expect(await nameOf("footer-mode-orca")).toEqual(["Orca"]);
  });

  it("starts the orchestrator with the pane id of its formation, Claude Code's own tools, no skill and no project, in the size of the left pane", async () => {
    await openFormation();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "formation:formation", builtinTools: true, skill: null });
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

  it("has the restart button at the right end of the orchestrator's header, with the icon only", async () => {
    await openFormation();
    const button = $("#formation-restart");
    await expect(button).toHaveAttribute("aria-label", "司令塔を再起動");
    expect(await button.getText()).toBe("");
    expect(await browser.execute(() => document.querySelectorAll("#formation-restart svg").length)).toBe(1);
    const place = await browser.execute(() => {
      const head = document.getElementById("formation-head")!.getBoundingClientRect();
      const button = document.getElementById("formation-restart")!.getBoundingClientRect();
      const title = document.querySelector("#formation-head h1")!.getBoundingClientRect();
      return { fromRight: Math.round(head.right - button.right), afterTitle: button.left >= title.right, children: document.getElementById("formation-head")!.lastElementChild!.id };
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
    await expect($("#formation-flow-head h2")).toHaveText("流れ");
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
    // The press of a planned card selects nothing: the child that waits stays the one marked.
    await (await $$(planned))[0].click();
    expect(await browser.execute(() => [...document.querySelectorAll('#formation-flow-list [aria-pressed="true"]')].map((e) => (e as HTMLElement).dataset.child))).toEqual(["web-update"]);
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

  it("keeps the pressed card, and moves the selection to the first child with a terminal when its child is gone", async () => {
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
    expect(await browser.execute(() => [...document.querySelectorAll('#formation-flow-list [aria-pressed="true"]')].map((e) => (e as HTMLElement).dataset.child))).toEqual(["api-update"]);
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
    const sessionTop = (await rectOf("#formation-session")).top;
    await browser.execute(() => {
      document.getElementById("formation-flow-body")!.scrollTop = 120;
    });
    expect((await rectOf("#formation-flow-head")).top).toBe(headTop);
    expect((await rectOf("#formation-session")).top).toBe(sessionTop);
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

  it("reads nothing while another screen is shown, and reads again when the mode is shown", async () => {
    await boot({ inbox: inbox(), ...timers({ formationFlow: READ, orcaClock: READ }) });
    await $("#nav-orca").click();
    // Orca is the mode: the list is read for the count, and no children.
    await waitForCalls("formation_list", 1);
    expect(await callsOf("formation_children")).toEqual([]);
    await $("#footer-mode-formation").click();
    await $('#formation-list-feed [data-formation="formation"]').click();
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

  it("has no button that closes or opens the pane, and no strip of tabs or middle column", async () => {
    await openFlow(mixed());
    await expect($("#formation-flow")).toBeDisplayed();
    for (const id of ["formation-flow-toggle", "formation-tabbar-toggle", "formation-tabbar", "formation-tabs", "formation-children"]) expect(await browser.execute((i) => document.getElementById(i), id)).toBeNull();
    expect(await browser.execute(() => document.querySelectorAll(".formation-flow-toggle, .formation-flow-badge, .formation-tab").length)).toBe(0);
    expect(await browser.execute(() => document.querySelectorAll('#formation-flow-head button, #formation-flow-head [role="button"]').length)).toBe(1);
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

  it("shows no flow pane when the first read failed, because no child is known", async () => {
    await openFlow(rejects("Orca に届きません"));
    await waitForCalls("formation_children", 1);
    await expect($("#formation-flow")).not.toBeDisplayed();
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
const widthOf = async (id: string) => (await rectOf(`#${id}`)).right - (await rectOf(`#${id}`)).left;

describe("orchestration mode: the panes beside the list", () => {
  it("shows the orchestrator alone, with the whole width, while no child is recorded", async () => {
    await openFlow([]);
    await waitForCalls("formation_children", 1);
    await expect($("#formation-orchestrator")).toBeDisplayed();
    await expect($("#formation-flow")).not.toBeDisplayed();
    const [pane, divider, screen] = [await rectOf("#formation-orchestrator"), await rectOf("#formation-split"), await rectOf("#formation")];
    expect(Math.abs(pane.left - divider.right)).toBeLessThan(1);
    expect(Math.abs(pane.right - screen.right)).toBeLessThan(1);
  });

  it("shows the right pane when a child, a planned one too, is recorded, and splits the width right of the list 5:5", async () => {
    await openFlow([]);
    await waitForCalls("formation_children", 1);
    await expect($("#formation-flow")).not.toBeDisplayed();
    await mock("formation_children", [formationChild("api-update", "planned")]);
    await expect($("#formation-flow")).toBeDisplayed();
    const [orchestrator, flow] = [await widthOf("formation-orchestrator"), await widthOf("formation-flow")];
    expect(Math.abs(orchestrator - flow)).toBeLessThanOrEqual(1);
    const [first, second, screen] = [await rectOf("#formation-orchestrator"), await rectOf("#formation-flow"), await rectOf("#formation")];
    expect(Math.abs(first.right - second.left)).toBeLessThan(1);
    expect(Math.abs(second.right - screen.right)).toBeLessThan(1);
    // The screen has the list, its divider and the two panes, and no column of tabs beside them.
    expect(await browser.execute(() => [...document.getElementById("formation")!.children].map((e) => e.id))).toEqual(["formation-list", "formation-split", "formation-orchestrator", "formation-flow"]);
  });

  it("hides the right pane again when the children are gone, and the orchestrator takes the width", async () => {
    await openFlow([formationChild("api-update", "working")]);
    await expect($("#formation-flow")).toBeDisplayed();
    await mock("formation_children", []);
    await expect($("#formation-flow")).not.toBeDisplayed();
    const [pane, screen] = [await rectOf("#formation-orchestrator"), await rectOf("#formation")];
    expect(Math.abs(pane.right - screen.right)).toBeLessThan(1);
  });

  it("fits the orchestrator's terminal to its new width when the right pane appears", async () => {
    await openFlow([]);
    const [start] = await waitForCalls("claude_code_start");
    const wide = (start as { viewport: { cols: number } }).viewport.cols;
    await mock("claude_code_resize", null);
    await mock("formation_children", [formationChild("api-update", "planned")]);
    const [resize] = await waitForCalls("claude_code_resize");
    expect((resize as { viewport: { cols: number } }).viewport.cols).toBeLessThan(wide);
  });

  it("fits the orchestrator's terminal to its width again when the right pane goes", async () => {
    await openFlow([]);
    const [start] = await waitForCalls("claude_code_start");
    const wide = (start as { viewport: { cols: number } }).viewport.cols;
    // The pane appears and makes the orchestrator narrower; the fit of that is waited for, then the pane goes.
    await mock("claude_code_resize", null);
    await mock("formation_children", [formationChild("api-update", "planned")]);
    const [narrowed] = await waitForCalls("claude_code_resize");
    const narrow = (narrowed as { viewport: { cols: number } }).viewport.cols;
    expect(narrow).toBeLessThan(wide);
    await mock("claude_code_resize", null);
    await mock("formation_children", []);
    const [resize] = await waitForCalls("claude_code_resize");
    expect((resize as { viewport: { cols: number } }).viewport.cols).toBeGreaterThan(narrow);
  });
});

// A-37: the view of the flow, and the session of the selected child under it.
const selectedCard = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>('#formation-flow-list [aria-pressed="true"]')].map((e) => e.dataset.child ?? null));
const card = (name: string) => $(`#formation-flow-list [data-child="${name}"]`);
const screenText = () => $("#formation-child-term .orca-term-box:not([hidden]) .xterm-rows").getText();
const readHandles = async () => [...new Set((await callsOf("orca_terminal_read")).map((c) => (c as { handle: string }).handle))];
const MIRROR = 250;

async function openSession(children: unknown, extra: Record<string, unknown> = {}) {
  await openFlow(children, { ...timers({ formationFlow: READ, orcaMirror: MIRROR }), orca_terminal_read: ["$ claude", "> 確認します"], ...extra });
  await browser.waitUntil(async () => (await cardNames()).length > 0);
}

describe("orchestration mode: the view of the flow", () => {
  it("puts the orchestrator's card on top and the children side by side under it", async () => {
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
    // One row: the cards share a top and follow each other from the left.
    expect(new Set(rects.cards.map((c) => Math.round(c.top))).size).toBe(1);
    expect(rects.cards[0].right).toBeLessThanOrEqual(rects.cards[1].left);
    // The orchestrator's card is over the middle of the row.
    const middle = (rects.cards[0].left + rects.cards[1].right) / 2;
    expect(Math.abs((rects.root.left + rects.root.right) / 2 - middle)).toBeLessThan(4);
    // One branch goes down from the orchestrator's card to the frame that holds the cards.
    expect(await browser.execute(() => getComputedStyle(document.getElementById("formation-flow-list")!, "::before").borderLeftWidth)).toBe("2px");
    expect(await styleOf("#formation-flow-list", "borderTopStyle")).toBe("solid");
  });

  it("wraps the cards that do not fit in one row, and holds the view to a height of its own", async () => {
    await openSession(Array.from({ length: 24 }, (_, i) => formationChild(`child-${String(i).padStart(2, "0")}`, "working")));
    await browser.waitUntil(async () => (await cardNames()).length === 24);
    const tops = await browser.execute(() => [...new Set([...document.querySelectorAll("#formation-flow-list .formation-card")].map((c) => Math.round(c.getBoundingClientRect().top)))]);
    expect(tops.length).toBeGreaterThan(2);
    const [body, flow] = [await rectOf("#formation-flow-body"), await rectOf("#formation-flow")];
    expect(body.bottom - body.top).toBeLessThanOrEqual(300);
    expect(body.bottom - body.top).toBeLessThanOrEqual((flow.bottom - flow.top) / 2 + 1);
  });

  it("shows the session band with the dot and the name of the selected child, and the terminal under it", async () => {
    await openSession(mixed());
    await expect($("#formation-session")).toBeDisplayed();
    await expect($("#formation-session-name")).toHaveText("web-update");
    await expect($("#formation-session-head")).toHaveAttribute("data-state", "waiting");
    expect(await browser.execute(() => document.querySelectorAll("#formation-session-head .formation-dot").length)).toBe(1);
    const [body, head, term, flow] = [await rectOf("#formation-flow-body"), await rectOf("#formation-session-head"), await rectOf("#formation-child-term"), await rectOf("#formation-flow")];
    expect(body.bottom).toBeLessThanOrEqual(head.top);
    expect(head.bottom).toBeLessThanOrEqual(term.top);
    expect(Math.abs(term.bottom - flow.bottom)).toBeLessThan(1);
    expect(term.right - term.left).toBeGreaterThan(200);
    expect(await styleOf("#formation-session-head .formation-dot", "backgroundColor")).toBe(await resolved("--agent-question"));
    // The band is the form of the orchestrator's header band: the same height, padding, ground and weight of the title.
    const form = (head: string, title: string) =>
      browser.execute(
        (h, t) => {
          const band = document.querySelector(h)!;
          const style = getComputedStyle(band);
          const text = getComputedStyle(document.querySelector(t)!);
          return { height: Math.round(band.getBoundingClientRect().height), padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`, background: style.backgroundColor, size: text.fontSize, weight: text.fontWeight };
        },
        head,
        title,
      );
    expect(await form("#formation-session-head", "#formation-session-name")).toEqual(await form("#formation-head", "#formation-head h1"));
    // The band follows the state of the child.
    await mock("formation_children", [...mixed().slice(0, 1), formationChild("web-update", "working", { minutes: 1 }), ...mixed().slice(2)]);
    await browser.waitUntil(async () => (await $("#formation-session-head").getAttribute("data-state")) === "working");
  });

  it("shows no session while only children with no terminal are there, and the view takes the height of the pane", async () => {
    await openSession([formationChild("a-update", "planned"), formationChild("b-update", "done", { handle: null })]);
    await expect($("#formation-session")).not.toBeDisplayed();
    const [body, head, flow] = [await rectOf("#formation-flow-body"), await rectOf("#formation-flow-head"), await rectOf("#formation-flow")];
    expect(Math.abs(body.bottom - flow.bottom)).toBeLessThan(1);
    expect(body.top).toBeGreaterThanOrEqual(head.bottom);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    // A child that gets a terminal brings the session under the view.
    await mock("formation_children", [formationChild("a-update", "working")]);
    await expect($("#formation-session")).toBeDisplayed();
    await expect($("#formation-session-name")).toHaveText("a-update");
    // And it goes again when no child has a terminal.
    await mock("formation_children", [formationChild("a-update", "planned")]);
    await expect($("#formation-session")).not.toBeDisplayed();
  });
});

describe("orchestration mode: the session of a child", () => {
  it("starts with 自動で追う on at the right end of the heading, and selects the child that waits", async () => {
    await openSession(mixed());
    await expect($("#formation-follow")).toHaveText("自動で追う");
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "true");
    expect(await selectedCard()).toEqual(["web-update"]);
    const [head, follow, count] = [await rectOf("#formation-flow-head"), await rectOf("#formation-follow"), await rectOf("#formation-flow-count")];
    expect(head.right - follow.right).toBeLessThan(24);
    expect(count.right).toBeLessThanOrEqual(follow.left);
    expect(follow.top).toBeGreaterThanOrEqual(head.top);
    expect(follow.bottom).toBeLessThanOrEqual(head.bottom);
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

  it("selects the first child that has a terminal when no child waits or works and nothing was selected", async () => {
    await openSession([formationChild("p-update", "planned"), formationChild("a-update", "done"), formationChild("b-update", "done")]);
    expect(await selectedCard()).toEqual(["a-update"]);
    await expect($("#formation-session-name")).toHaveText("a-update");
  });

  it("selects a card that is pressed, turns 自動で追う off, and turns it on again with the button", async () => {
    await openSession(mixed());
    await card("api-update").click();
    expect(await selectedCard()).toEqual(["api-update"]);
    await expect($("#formation-session-name")).toHaveText("api-update");
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "false");
    await expect(card("api-update")).toHaveAttribute("aria-pressed", "true");
    // Another child waits now: the selection stays.
    await mock("formation_children", [formationChild("api-update", "done"), formationChild("web-update", "working"), formationChild("batch-update", "waiting", { minutes: 3 })]);
    await browser.waitUntil(async () => (await card("batch-update").getAttribute("data-state")) === "waiting");
    expect(await selectedCard()).toEqual(["api-update"]);
    await $("#formation-follow").click();
    await expect($("#formation-follow")).toHaveAttribute("aria-pressed", "true");
    expect(await selectedCard()).toEqual(["batch-update"]);
    await expect($("#formation-session-name")).toHaveText("batch-update");
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
    expect(await browser.execute(() => document.querySelectorAll("#formation-child-term .orca-term-box:not([hidden])").length)).toBe(1);
  });

  it("sends the keys typed in the terminal to its child through orca_terminal_input", async () => {
    await openSession(mixed());
    const input = await mock("orca_terminal_input", null);
    // The press is made in the page: the driver takes the focus to the button after its click, which a real press does before.
    await browser.execute(() => document.querySelector<HTMLElement>('#formation-flow-list [data-child="batch-update"]')!.click());
    // The press gives the terminal of the session the keyboard.
    expect(await browser.execute(() => document.getElementById("formation-child-term")!.contains(document.activeElement))).toBe(true);
    await browser.keys(["c", "d"]);
    await browser.waitUntil(async () => (await callsOf(input)).map((c) => (c as { text: string }).text).join("") === "cd", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => (c as { handle: string }).handle === "term_batch-update")).toBe(true);
  });

  it("reads and types into the terminal of a child of a saved environment in that environment, and the one of this Mac as before", async () => {
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

  it("does not take the keyboard when the follow moves the selection", async () => {
    await openSession([formationChild("a-update", "working"), formationChild("b-update", "working")]);
    await $("#formation-term .orca-term-box:not([hidden]) .xterm-screen").click();
    await mock("formation_children", [formationChild("a-update", "working"), formationChild("b-update", "waiting")]);
    await browser.waitUntil(async () => (await selectedCard())[0] === "b-update");
    expect(await browser.execute(() => document.querySelector("#formation-term")!.contains(document.activeElement))).toBe(true);
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
    await expect($("#formation-session")).not.toBeDisplayed();
    await mock("orca_terminal_read", ["$ none"]);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
  });

  it("reads no terminal while the mode is left, and reads it again when the mode is shown", async () => {
    await openSession(mixed());
    await waitForCalls("orca_terminal_read");
    await $("#footer-mode-orca").click();
    await mock("orca_terminal_read", ["$"]);
    await browser.pause(MIRROR * 3);
    expect(await callsOf("orca_terminal_read")).toEqual([]);
    await $("#footer-mode-formation").click();
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
const headName = () => $("#formation-head-name").getText();
const listed = () =>
  formationList([
    formationEntry("formation"),
    formationEntry("won-2485", { minutes: 12, repos: ["wonder-knowledge", "wonder-api"], counts: { planned: 3, waiting: 0, working: 1, done: 0 } }),
    formationEntry("mail-summary", { minutes: 90, repos: ["tsunagiai"], counts: { planned: 0, waiting: 1, working: 0, done: 2 } }),
  ]);

// The list with a formation, `api-work`, whose name sorts before `formation`: no row is selected when the shown one goes, not the first row.
const listedFirst = () => formationList([formationEntry("api-work", { minutes: 3 }), ...listed().formations]);

async function openList(extra: Record<string, unknown> = {}, select: string | null = "formation") {
  await boot({ inbox: inbox(), formation_list: listed(), ...timers({ formationFlow: READ }), ...extra });
  await openFormation(null);
  const rows = ((extra.formation_list as FormationList | undefined) ?? listed()).formations.length;
  await browser.waitUntil(async () => (await rowNames()).length === rows);
  if (select !== null) await row(select).click();
}

describe("orchestration mode: the list of the formations", () => {
  it("heads the list with フォーメーション, with the one button that makes a formation at its right end", async () => {
    await openList();
    await expect($("#formation-list h1")).toHaveText("フォーメーション");
    expect(await textsOf("#formation-list-head button")).toEqual([""]);
    await expect($("#formation-new")).toHaveAttribute("aria-label", "フォーメーションを作る");
    expect(await count("#formation-new svg")).toBe(1);
    const place = await browser.execute(() => {
      const [head, button] = [document.getElementById("formation-list-head")!.getBoundingClientRect(), document.getElementById("formation-new")!.getBoundingClientRect()];
      return { right: head.right - button.right < 16, inside: button.top >= head.top && button.bottom <= head.bottom };
    });
    expect(place).toEqual({ right: true, inside: true });
  });

  it("draws a row for each formation, in the order given, with the time, the projects and the number of children in each state", async () => {
    await openList();
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
    // `formation` has no time and no project (no file); the others show how long ago they were made.
    expect(await textsOf(`${ROWS} .formation-row-time`)).toEqual(["12 分", "1 時間"]);
    expect(await textsOf(`${ROWS}[data-formation="won-2485"] .formation-row-project`)).toEqual(["wonder-knowledge", "wonder-api"]);
    expect(await textsOf(`${ROWS}[data-formation="formation"] .formation-row-project, ${ROWS}[data-formation="formation"] .formation-row-count`)).toEqual([]);
    expect(await textsOf(`${ROWS}[data-formation="won-2485"] .formation-row-count`)).toEqual(["作業中 1", "予定 3"]);
    expect(await textsOf(`${ROWS}[data-formation="mail-summary"] .formation-row-count`)).toEqual(["承認待ち 1", "完了 2"]);
    expect(await browser.execute(() => [...document.querySelectorAll(".formation-row-count")].map((e) => (e as HTMLElement).dataset.state))).toEqual(["working", "planned", "waiting", "done"]);
  });

  it("selects nothing at the start, shows the list alone and starts and reads nothing", async () => {
    await openList({ formation_children: mixed() }, null);
    expect(await pressedRows()).toEqual([]);
    await expect($("#formation-list")).toBeDisplayed();
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-split")).not.toBeDisplayed();
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

  it("shows only the plus of the list when the list is empty", async () => {
    await openList({ formation_list: formationList([]) }, null);
    await expect($("#formation-new")).toBeDisplayed();
    expect(await rowNames()).toEqual([]);
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-split")).not.toBeDisplayed();
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
    // The cards, the session and the pane go at once, before the read of the new formation answers.
    await expect($("#formation-flow")).not.toBeDisplayed();
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
    await expect($("#formation-flow")).not.toBeDisplayed();
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
    await expect($("#formation-split")).not.toBeDisplayed();
    await expect($("#formation-flow")).not.toBeDisplayed();
    await mock("formation_children", []);
    const before = (await callsOf("formation_children")).length;
    await browser.pause(READ * 3);
    expect((await callsOf("formation_children")).length).toBe(before);
    expect(await starts()).toBe(2);
  });

  it("reads the list for its rows while the orchestration mode is shown, and reads it no more once the screen is left", async () => {
    await boot({ inbox: inbox(), formation_list: listed(), ...timers({ formationFlow: READ, orcaClock: READ }) });
    await $("#nav-orca").click();
    // Orca is the mode: the list is read only for the footer's count, and no row is drawn from it.
    await waitForCalls("formation_list", 1);
    expect(await rowNames()).toEqual([]);
    await $("#footer-mode-formation").click();
    await browser.waitUntil(async () => (await rowNames()).length === 3);
    await $("#footer-mode-orca").click();
    await $("#footer-mode-formation").click();
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

  it("has a divider that starts at 25% of the screen and moves with the arrow keys, within 20% and 50%", async () => {
    await openList();
    const share = () => browser.execute(() => document.getElementById("formation-list")!.getBoundingClientRect().width / document.getElementById("formation")!.getBoundingClientRect().width);
    const split = $("#formation-split");
    await expect(split).toHaveAttribute("role", "separator");
    await expect(split).toHaveAttribute("aria-valuemin", "20");
    await expect(split).toHaveAttribute("aria-valuemax", "50");
    await expect(split).toHaveAttribute("aria-valuenow", "25");
    expect(await share()).toBeCloseTo(0.25, 2);
    await browser.execute((id, k) => window.__e2e_once__(id) && document.getElementById("formation-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })), onceId(), "ArrowRight");
    await expect(split).toHaveAttribute("aria-valuenow", "27");
    expect(await share()).toBeCloseTo(0.27, 2);
  });
});

// A-37 (#823): the dialog that makes a formation.
describe("orchestration mode: the dialog that makes a formation", () => {
  const ENVIRONMENTS = () => formationEnvironments(["wonder-knowledge", "wonder-api", "tsunagiai"], { "dev-server": ["wonder-api"] });
  const dialog = () => $('.formation-new-pop[role="dialog"]');
  const nameField = () => $('.formation-new-pop input[aria-label="名前"]');
  const filterField = () => $('.formation-new-pop input[aria-label="プロジェクトを絞り込む"]');
  const makeButton = () => $(".formation-new-actions .text-btn.primary");
  const repos = () => textsOf(".formation-new-repo");
  const checked = () => browser.execute(() => [...document.querySelectorAll<HTMLInputElement>(".formation-new-repo input")].map((b) => b.checked));
  // The page's own press: the driver's click takes the focus to the button after the handler, which a real press does not.
  const pressNew = () => browser.execute(() => document.getElementById("formation-new")!.click());
  async function ask(extra: Record<string, unknown> = {}) {
    await openList({ formation_environments: ENVIRONMENTS(), ...extra });
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
    await expect($("#error")).not.toBeDisplayed();
  });

  it("makes it on Enter in the name field, with no project when none is checked", async () => {
    await ask();
    const create = await mock("formation_create", formationEntry("solo", { minutes: 0 }));
    await mock("formation_list", formationList([...listed().formations, formationEntry("solo", { minutes: 0 })]));
    await browser.keys("solo");
    await browser.keys("Enter");
    expect(await waitForCalls(create)).toEqual([{ name: "solo", projects: [] }]);
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

  it("shows the words of a failed creation where the other screens show an error, and keeps the dialog with what was typed", async () => {
    await ask();
    await mock("formation_create", rejects("名前は、先頭が小文字の英数字で、小文字の英数字とハイフンだけの 40 文字までにしてください"));
    await browser.keys("Bad Name");
    await pick(1);
    await makeButton().click();
    await expect($("#error")).toHaveText("名前は、先頭が小文字の英数字で、小文字の英数字とハイフンだけの 40 文字までにしてください");
    await expect(dialog()).toBeDisplayed();
    await expect(nameField()).toHaveValue("Bad Name");
    expect(await checked()).toEqual([false, true, false, false]);
    await expect(makeButton()).toBeEnabled();
    // The formation is not made, so none is selected in its place.
    expect(await pressedRows()).toEqual(["formation"]);
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
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
        document.getElementById("formation-list-head")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 5, isPrimary: true }));
      },
      onceId(),
    );
    await expect(dialog()).not.toExist();
    await browser.pause(200);
    expect(await callsOf(create)).toEqual([]);
    expect(await pressedRows()).toEqual(["formation"]);
  });

  it("says why an environment could not be read, with no box under it, and why the list of the saved ones could not", async () => {
    await ask({ formation_environments: formationEnvironments(["tsunagiai"], {}, { "dev-server": "届きません" }, "環境の一覧を読めません") });
    expect(await textsOf(".formation-new-env")).toEqual(["この Mac", "dev-server"]);
    expect(await textsOf(".formation-new-note")).toEqual(["環境の一覧を読めません", "届きません"]);
    expect(await repos()).toEqual(["tsunagiai"]);
  });

  it("closes with the words of the failure when the environments cannot be read", async () => {
    await openList({ formation_environments: rejects("Orca に届きません") });
    await pressNew();
    await expect($("#error")).toHaveText("Orca に届きません");
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
  async function ask(name: string) {
    await rightPress(name);
    await $('.menu button[role="menuitem"]').click();
    await expect(confirm()).toBeDisplayed();
  }

  it("opens a menu with 削除 alone on a right press of a row, on `formation` too", async () => {
    await openList();
    await rightPress("won-2485");
    await expect($(".menu")).toBeDisplayed();
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["削除"]);
    await expect($('.menu button[role="menuitem"]')).toHaveElementClass("danger");
    expect(await count('.menu button[role="menuitem"] svg')).toBe(1);
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
    await rightPress("formation");
    await expect($(".menu")).toBeDisplayed();
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["削除"]);
  });

  it("deletes `formation` as any other, and selects nothing when it is the shown one", async () => {
    await openList();
    await waitForStarts(1);
    const del = await mock("formation_delete", null);
    await mock("formation_list", without("formation"));
    await mock("formation_children", []);
    await ask("formation");
    await yes().click();
    expect(await waitForCalls(del)).toEqual([{ name: "formation" }]);
    await browser.waitUntil(async () => (await rowNames()).join() === "won-2485,mail-summary");
    expect(await pressedRows()).toEqual([]);
    expect(await callsOf("claude_code_close")).toMatchObject([{ id: "formation:formation" }]);
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-split")).not.toBeDisplayed();
    await expect($("#formation-flow")).not.toBeDisplayed();
    expect(await starts()).toBe(1);
  });

  it("asks first, with the name, and calls nothing on キャンセル", async () => {
    await openList();
    const del = await mock("formation_delete", null);
    await ask("won-2485");
    await expect($('.pop[role="alertdialog"] h3')).toHaveText("won-2485 を削除しますか？");
    await $('.pop[role="alertdialog"] .text-btn:not(.danger)').click();
    await expect(confirm()).not.toExist();
    expect(await callsOf(del)).toEqual([]);
    expect(await rowNames()).toEqual(["formation", "won-2485", "mail-summary"]);
  });

  it("deletes the formation by its name on 削除, and takes its row off the list", async () => {
    await openList();
    const del = await mock("formation_delete", null);
    await mock("formation_list", without("mail-summary"));
    await ask("mail-summary");
    await yes().click();
    expect(await waitForCalls(del)).toEqual([{ name: "mail-summary" }]);
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
    const del = await mock("formation_delete", null);
    await mock("formation_list", formationList(listedFirst().formations.filter((f) => f.name !== "won-2485")));
    await mock("formation_children", []);
    await ask("won-2485");
    await yes().click();
    await waitForCalls(del);
    await browser.waitUntil(async () => (await rowNames()).join() === "api-work,formation,mail-summary");
    expect(await pressedRows()).toEqual([]);
    await expect($("#formation-orchestrator")).not.toBeDisplayed();
    await expect($("#formation-split")).not.toBeDisplayed();
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
    await release("formation_delete", null);
    await browser.waitUntil(async () => (await rowNames()).join() === "formation,won-2485");
  });
});

describe("orchestration mode: the count on the footer's icon", () => {
  const badge = () => $("#footer-mode-formation .footer-mode-count");
  // The list of two formations that have `first` and `second` children waiting, and others that work, are planned or are done: the count is the sum of the waiting ones.
  const waitingList = (first: number, second = 0) =>
    formationList([
      formationEntry("formation", { counts: { planned: 1, waiting: first, working: 1, done: 1 } }),
      formationEntry("other", { minutes: 5, counts: { planned: 0, waiting: second, working: 2, done: 0 } }),
    ]);

  it("shows the number of the children that wait in all the formations on the icon while Orca is the mode, and the label says it", async () => {
    await boot({ inbox: inbox(), formation_list: waitingList(2, 1), ...timers({ orcaClock: READ }) });
    await expect(badge()).not.toBeDisplayed();
    await $("#nav-orca").click();
    await expect(badge()).toHaveText("3");
    await expect($("#footer-mode-formation")).toHaveAttribute("aria-label", "オーケストレーション（承認待ち 3 件）");
    // It follows the reads, at the period of the Orca list's read, and is not drawn for none.
    await mock("formation_list", waitingList(3, 0));
    await browser.waitUntil(async () => (await badge().getText()) === "3");
    await mock("formation_list", waitingList(1, 4));
    await browser.waitUntil(async () => (await badge().getText()) === "5");
    await mock("formation_list", waitingList(0, 0));
    await expect(badge()).not.toBeDisplayed();
    await expect($("#footer-mode-formation")).toHaveAttribute("aria-label", "オーケストレーション");
  });

  it("reads the list and no children in the Orca mode, at the period of the Orca list's read, one call at a time", async () => {
    await boot({ inbox: inbox(), ...timers({ orcaClock: READ }) });
    await mock("formation_list", holds);
    await mock("formation_children", []);
    await $("#nav-orca").click();
    await waitForCalls("formation_list", 1);
    await browser.pause(READ * 3);
    expect((await callsOf("formation_list")).length).toBe(1);
    // Answer the next reads before the held one is released, so that the read that follows it is not held again; `mock` forgets the calls, and the next one is the first of the new answer.
    await mock("formation_list", waitingList(1));
    await release("formation_list", waitingList(1));
    await waitForCalls("formation_list", 1);
    await expect(badge()).toHaveText("1");
    expect(await callsOf("formation_children")).toEqual([]);
  });

  it("keeps the last number when a read of the list fails", async () => {
    await boot({ inbox: inbox(), formation_list: waitingList(2), ...timers({ orcaClock: READ }) });
    await $("#nav-orca").click();
    await expect(badge()).toHaveText("2");
    await mock("formation_list", rejects("一覧を読めません"));
    await waitForCalls("formation_list", 2);
    await expect(badge()).toHaveText("2");
    // Orca could not be read: the answer lists the formations with every launched child working, which is no count of the waiting ones.
    await mock("formation_list", formationList(waitingList(0).formations, "Orca に届きません"));
    await waitForCalls("formation_list", 2);
    await expect(badge()).toHaveText("2");
    await mock("formation_list", waitingList(1));
    await expect(badge()).toHaveText("1");
  });

  it("shows no number in the orchestration mode, and shares its read with the flow", async () => {
    await boot({ inbox: inbox(), formation_list: waitingList(2), ...timers({ orcaClock: READ, formationFlow: READ }) });
    await $("#nav-orca").click();
    await expect(badge()).toHaveText("2");
    await $("#footer-mode-formation").click();
    await expect(badge()).not.toBeDisplayed();
    await expect($("#footer-mode-formation")).toHaveAttribute("aria-label", "オーケストレーション");
    // Only the clock of the flow reads now: the calls of one period are one for each command, not two.
    await mock("formation_children", []);
    await mock("formation_list", waitingList(2));
    await browser.pause(READ * 4 + 100);
    expect((await callsOf("formation_children")).length).toBeLessThanOrEqual(4);
    expect((await callsOf("formation_list")).length).toBeLessThanOrEqual(4);
    await $("#footer-mode-orca").click();
    await expect(badge()).toHaveText("2");
  });

  it("does not read again when the 開発 button is pressed on the development screen", async () => {
    await boot({ inbox: inbox(), formation_list: waitingList(1), ...timers({ orcaClock: 5000 }) });
    await $("#nav-orca").click();
    await expect(badge()).toHaveText("1");
    await mock("formation_list", waitingList(1));
    await $("#nav-orca").click();
    await browser.pause(500);
    expect(await callsOf("formation_list")).toEqual([]);
    await expect(badge()).toHaveText("1");
  });

  it("reads nothing and shows no number once the development screen is left", async () => {
    await boot({ inbox: inbox(), formation_list: waitingList(1), ...timers({ orcaClock: READ }) });
    await $("#nav-orca").click();
    await expect(badge()).toHaveText("1");
    await $("#nav-mail").click();
    await mock("formation_list", waitingList(1));
    await browser.pause(READ * 3);
    expect(await callsOf("formation_list")).toEqual([]);
    await $("#nav-orca").click();
    await waitForCalls("formation_list", 1);
    await expect(badge()).toHaveText("1");
  });
});
