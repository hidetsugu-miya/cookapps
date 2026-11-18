import { boot, callsOf, inbox, mock, rejects, sendClaudeCode, waitForCalls } from "../support";

// The part of A-36 that no screen holds yet: a spec puts a host element in the page and drives `ts/claude-code.ts` itself (the way `calendar.e2e.ts` calls `loadCalendar`).
// A host 640 by 320 pixels at the top left, over the app.
const HOST = "claude-code-host";
const OWNER = "e2e-claude-code";

async function openHost(id = "pane-1", options: { builtinTools?: boolean; skill?: { name: string; screen: "slack-thread" }; prompt?: string } = {}) {
  await boot({ inbox: inbox() });
  await browser.execute((host) => {
    const el = document.createElement("div");
    el.id = host;
    el.style.cssText = "position: fixed; left: 0; top: 0; width: 640px; height: 320px; z-index: 1000; display: flex; flex-direction: column;";
    document.body.append(el);
  }, HOST);
  await show(id, options);
}

// Shows the pane's terminal in the host (the first show starts the process).
const show = (id: string, options: { builtinTools?: boolean; skill?: { name: string; screen: "slack-thread" }; prompt?: string } = {}) =>
  browser.execute(
    async (host, o, opts, owner) => {
      const path = "/js/claude-code.js";
      const pane = (await import(path)) as { showClaudeCode(host: HTMLElement, options: unknown, owner: string): void };
      pane.showClaudeCode(document.getElementById(host)!, { id: o, ...opts }, owner);
    },
    HOST,
    id,
    options,
    OWNER,
  );

const call = (name: "hideClaudeCode" | "closeClaudeCode", id?: string) =>
  browser.execute(
    async (fn, o, owner) => {
      const path = "/js/claude-code.js";
      const pane = (await import(path)) as Record<string, (...args: string[]) => void>;
      if (fn === "closeClaudeCode") pane[fn](o!, owner);
      else pane[fn](owner);
    },
    name,
    id,
    OWNER,
  );

const screenText = () => $(`#${HOST} .orca-term-box:not([hidden]) .xterm-rows`).getText();
const shows = (text: string) => browser.waitUntil(async () => (await screenText()).includes(text), { timeoutMsg: `the terminal never showed ${text}` });
const typed = async (input: string) => (await callsOf(input)).map((c) => (c as { text: string }).text).join("");

describe("claude code pane", () => {
  it("starts the process once with the pane's id, the size of its host and no built-in tools, and calls no Orca command", async () => {
    await openHost();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "pane-1", builtinTools: false, skill: null });
    const { cols, rows } = (start as { viewport: { cols: number; rows: number } }).viewport;
    expect(cols).toBeGreaterThan(40);
    expect(rows).toBeGreaterThan(8);
    for (const command of ["orca_stream_terminal", "orca_terminal_read", "orca_stream_input"]) expect(await callsOf(command)).toEqual([]);
  });

  it("gives the start the choice of built-in tools and the saved skill", async () => {
    await openHost("pane-2", { builtinTools: true, skill: { name: "reply", screen: "slack-thread" } });
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "pane-2", builtinTools: true, skill: { name: "reply", screen: "slack-thread" } });
  });

  it("gives the start the first instruction of the pane, and none when the screen gives none", async () => {
    await openHost("pane-3", { prompt: "> 環境: local\n調べてください\n" });
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "pane-3", prompt: "> 環境: local\n調べてください\n" });
    await openHost("pane-4");
    expect((await waitForCalls("claude_code_start"))[0]).toMatchObject({ id: "pane-4", prompt: null });
  });

  it("draws what the process prints, and the message of its end", async () => {
    await openHost();
    await waitForCalls("claude_code_start");
    await sendClaudeCode({ kind: "output", data: "$ claude\r\n> 日本語の出力" });
    await shows("日本語の出力");
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました（終了コード 3）", clean: false });
    await shows("終了コード 3");
  });

  it("sends the typed keys to the pane's id, one send at a time, and drops them once the process has ended", async () => {
    await openHost();
    await waitForCalls("claude_code_start");
    const input = await mock("claude_code_input", null);
    await $(`#${HOST} .orca-term-box:not([hidden]) .xterm-screen`).click();
    // A digit: the driver gives a letter the keyCode of its character, and xterm.js reads the keyCode of p to z as a function key.
    await browser.keys(["1", "Enter"]);
    await browser.waitUntil(async () => (await typed(input)) === "1\r", { timeoutMsg: "the keys were not sent" });
    expect((await callsOf(input)).every((c) => (c as { id: string }).id === "pane-1")).toBe(true);
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました", clean: true });
    await shows("Claude Code が終わりました");
    await browser.keys(["2"]);
    await browser.pause(300);
    expect(await typed(input)).toBe("1\r");
  });

  it("draws the message of a start that fails in the terminal and sends no key to it", async () => {
    await boot({ inbox: inbox(), claude_code_start: rejects("tsunagiai-mcp が見つかりません（/app/tsunagiai-mcp）") });
    await browser.execute((host) => {
      const el = document.createElement("div");
      el.id = host;
      el.style.cssText = "position: fixed; left: 0; top: 0; width: 640px; height: 320px; z-index: 1000; display: flex; flex-direction: column;";
      document.body.append(el);
    }, HOST);
    await show("pane-1");
    await waitForCalls("claude_code_start");
    await shows("tsunagiai-mcp が見つかりません");
    const input = await mock("claude_code_input", null);
    await $(`#${HOST} .orca-term-box:not([hidden]) .xterm-screen`).click();
    await browser.keys(["1"]);
    await browser.pause(300);
    expect(await callsOf(input)).toEqual([]);
  });

  it("sends the new size when the host changes size", async () => {
    await openHost();
    const [start] = await waitForCalls("claude_code_start");
    const resize = await mock("claude_code_resize", null);
    await browser.execute((host) => {
      document.getElementById(host)!.style.width = "400px";
    }, HOST);
    const [sent] = await waitForCalls(resize);
    const before = (start as { viewport: { cols: number } }).viewport.cols;
    expect(sent).toMatchObject({ id: "pane-1" });
    expect((sent as { viewport: { cols: number } }).viewport.cols).toBeLessThan(before);
  });

  it("keeps the process while the pane is hidden, draws what it printed meanwhile, and does not start it again when shown", async () => {
    await openHost();
    await waitForCalls("claude_code_start");
    await sendClaudeCode({ kind: "output", data: "first" });
    await shows("first");
    const close = await mock("claude_code_close", null);
    await call("hideClaudeCode");
    await expect($(`#${HOST} .orca-term-box`)).not.toExist();
    await sendClaudeCode({ kind: "output", data: "\r\nwhile hidden" });
    await show("pane-1");
    await shows("while hidden");
    expect(await callsOf("claude_code_start")).toHaveLength(1);
    expect(await callsOf(close)).toEqual([]);
  });

  it("ends the process when the pane is closed, and a new pane of the same id starts another", async () => {
    await openHost();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await call("closeClaudeCode", "pane-1");
    expect(await waitForCalls(close)).toEqual([{ id: "pane-1", launch: 1 }]);
    await show("pane-1");
    await waitForCalls("claude_code_start", 2);
  });

  it("names the start in the close, so that a close ends only the process that start made", async () => {
    await openHost();
    await waitForCalls("claude_code_start");
    await call("closeClaudeCode", "pane-1");
    await mock("claude_code_start", 7);
    await show("pane-1");
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await call("closeClaudeCode", "pane-1");
    expect(await waitForCalls(close)).toEqual([{ id: "pane-1", launch: 7 }]);
  });

  it("clears the screen and starts a process again when a pane whose process ended is shown again", async () => {
    await openHost();
    await waitForCalls("claude_code_start");
    await sendClaudeCode({ kind: "output", data: "old screen" });
    await shows("old screen");
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました", clean: true });
    await shows("Claude Code が終わりました");
    await call("hideClaudeCode");
    await show("pane-1");
    await waitForCalls("claude_code_start", 2);
    await sendClaudeCode({ kind: "output", data: "new screen" });
    await shows("new screen");
    expect(await screenText()).not.toContain("old screen");
    expect(await screenText()).not.toContain("終わりました");
  });

  it("starts again a pane whose start failed when it is shown again", async () => {
    await boot({ inbox: inbox(), claude_code_start: rejects("tsunagiai-mcp が見つかりません（/app/tsunagiai-mcp）") });
    await browser.execute((host) => {
      const el = document.createElement("div");
      el.id = host;
      el.style.cssText = "position: fixed; left: 0; top: 0; width: 640px; height: 320px; z-index: 1000; display: flex; flex-direction: column;";
      document.body.append(el);
    }, HOST);
    await show("pane-1");
    await waitForCalls("claude_code_start");
    await shows("tsunagiai-mcp が見つかりません");
    await call("hideClaudeCode");
    await mock("claude_code_start", 1);
    await show("pane-1");
    await waitForCalls("claude_code_start");
    await sendClaudeCode({ kind: "output", data: "running" });
    await shows("running");
    expect(await screenText()).not.toContain("見つかりません");
  });
});
