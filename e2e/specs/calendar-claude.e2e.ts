import { boot, callsOf, inbox, mock, today, waitForCalls, waitForText, weekOfToday } from "../support";

// The Claude pane of the calendar screen (C-6): the terminal of Claude Code (A-36) at the right of the week.
const pane = "#cal-claude";
const term = "#cal-claude-term";
const star = "#cal-bar-claude";
// A press with the pointer actions. The driver's element click calls `el.focus()` on the element itself, which would take the focus back from the terminal that the press opened.
const press = (target: ChainablePromiseElement) => browser.action("pointer").move({ origin: target }).down().up().perform();

async function openCalendar() {
  await boot({ inbox: inbox(), calendar_week: weekOfToday() });
  await $("#nav-calendar").click();
  await waitForText("#cal-body .cal-name", "Team sync");
}

const widthOf = (id: string) => browser.execute((i) => document.getElementById(i)!.getBoundingClientRect().width, id);

describe("calendar Claude pane", () => {
  it("has the ✳ at the right end of the bar, and draws neither the pane nor the divider at first, and starts nothing", async () => {
    await openCalendar();
    await expect($(star)).toBeDisplayed();
    await expect($(star)).toHaveElementClass("icon-btn");
    await expect($(star)).toHaveAttribute("aria-label", "Claude に相談");
    await expect($(star)).toHaveAttribute("aria-pressed", "false");
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#cal-split")).not.toBeDisplayed();
    const place = await browser.execute(() => {
      const bar = document.getElementById("cal-bar")!;
      const button = document.getElementById("cal-bar-claude")!.getBoundingClientRect();
      const others = [...bar.querySelectorAll<HTMLElement>("button")].filter((b) => b.id !== "cal-bar-claude").map((b) => b.getBoundingClientRect().right);
      return { last: bar.lastElementChild!.id, right: bar.getBoundingClientRect().right - button.right < 40, after: others.every((r) => r < button.left) };
    });
    expect(place).toEqual({ last: "cal-bar-claude", right: true, after: true });
    // A window that changes its visibility starts nothing while the pane is closed, and neither does leaving and coming back.
    await $("#nav-mail").click();
    await $("#nav-calendar").click();
    await browser.execute(() => document.dispatchEvent(new Event("visibilitychange")));
    await browser.pause(500);
    expect(await callsOf("claude_code_start")).toEqual([]);
  });

  it("opens the pane under the bar and at the right of the week, and starts Claude Code with the tools of tsunagiai-mcp only and a first instruction with today's date", async () => {
    await openCalendar();
    await press($(star));
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "calendar-claude", builtinTools: false, skill: null });
    const { prompt } = start as { prompt: string };
    expect(prompt).toContain("カレンダー");
    expect(prompt).toContain(today);
    expect(prompt).toContain("tsunagiai-mcp");
    expect(prompt).toContain("list_events");
    expect(prompt).not.toContain("Team sync");
    await expect($(star)).toHaveAttribute("aria-pressed", "true");
    await expect($(pane)).toBeDisplayed();
    await expect($("#cal-split")).toBeDisplayed();
    await expect($("#cal-split")).toHaveAttribute("aria-label", "Claude の幅");
    await expect($(pane)).toHaveAttribute("aria-label", "Claude");
    await expect($(`${pane} .chat-head`)).toHaveText(expect.stringContaining("Claude"));
    await expect($("#cal-claude-restart")).toHaveText("やり直す");
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
    await expect($(`${term} .xterm-helper-textarea`)).toBeFocused();
    const place = await browser.execute(() => {
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const [bar, main, split, claude, frame] = ["cal-bar", "cal-main", "cal-split", "cal-claude", "cal-frame"].map(box);
      const head = document.querySelector("#cal-claude .chat-head")!.getBoundingClientRect();
      return { under: claude.top >= bar.bottom, right: claude.left >= main.right - 1 && split.right <= claude.left + 1 && split.left >= main.right - 1, edge: Math.abs(claude.right - frame.right) < 1, head: head.height };
    });
    expect(place).toEqual({ under: true, right: true, edge: true, head: 48 });
  });

  it("keeps the seven days in view while the pane is open, and gives the week its width back when it is closed", async () => {
    await openCalendar();
    const before = await widthOf("cal-scroll");
    await press($(star));
    await waitForCalls("claude_code_start");
    const days = await browser.execute(() => {
      const main = document.getElementById("cal-main")!.getBoundingClientRect();
      return [...document.querySelectorAll("#cal-head .cal-day")].map((d) => {
        const r = d.getBoundingClientRect();
        return r.width > 20 && r.left >= main.left - 1 && r.right <= main.right + 1;
      });
    });
    expect(days).toEqual(Array(7).fill(true));
    expect(await widthOf("cal-scroll")).toBeLessThan(before);
    const close = await mock("claude_code_close", null);
    await press($(star));
    await waitForCalls(close);
    expect(await widthOf("cal-scroll")).toBe(before);
  });

  it("closes the pane with the ✳ and ends the process, and the next open starts a new one", async () => {
    await openCalendar();
    const close = await mock("claude_code_close", null);
    await press($(star));
    const [first] = await waitForCalls("claude_code_start");
    expect(await callsOf(close)).toEqual([]);
    await press($(star));
    expect(await waitForCalls(close)).toEqual([{ id: "calendar-claude", launch: 1 }]);
    await expect($(star)).toHaveAttribute("aria-pressed", "false");
    await expect($(pane)).not.toBeDisplayed();
    await expect($("#cal-split")).not.toBeDisplayed();
    // Nothing starts while it is closed.
    await browser.execute(() => document.dispatchEvent(new Event("visibilitychange")));
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    await press($(star));
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts[1]).toMatchObject({ id: "calendar-claude", builtinTools: false, skill: null, prompt: (first as { prompt: string }).prompt });
    await expect($(star)).toHaveAttribute("aria-pressed", "true");
    await expect($(`${term}.claude-code-pane`)).toBeDisplayed();
  });

  it("starts at 30% of the frame and keeps the pane between 30% and 45% with the arrow keys", async () => {
    await openCalendar();
    await press($(star));
    await waitForCalls("claude_code_start");
    const split = $("#cal-split");
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    await expect(split).toHaveAttribute("aria-valuemin", "30");
    await expect(split).toHaveAttribute("aria-valuemax", "45");
    const share = () => browser.execute(() => document.getElementById("cal-claude")!.getBoundingClientRect().width / document.getElementById("cal-frame")!.getBoundingClientRect().width);
    expect(await share()).toBeCloseTo(0.3, 2);
    const key = (k: string) => browser.execute((name) => document.getElementById("cal-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })), k);
    for (let i = 0; i < 10; i++) await key("ArrowLeft");
    await expect(split).toHaveAttribute("aria-valuenow", "45");
    expect(await share()).toBeCloseTo(0.45, 2);
    for (let i = 0; i < 20; i++) await key("ArrowRight");
    await expect(split).toHaveAttribute("aria-valuenow", "30");
    expect(await share()).toBeCloseTo(0.3, 2);
  });

  it("keeps the process while another screen is shown, and shows the pane again when the calendar comes back", async () => {
    await openCalendar();
    await press($(star));
    await waitForCalls("claude_code_start");
    await $("#nav-mail").click();
    await expect($(pane)).not.toBeDisplayed();
    await $("#nav-calendar").click();
    await expect($(pane)).toBeDisplayed();
    await expect($(star)).toHaveAttribute("aria-pressed", "true");
    await browser.pause(500);
    expect((await callsOf("claude_code_start")).length).toBe(1);
    expect(await callsOf("claude_code_close")).toEqual([]);
  });

  it("ends the process and starts a new one with やり直す", async () => {
    await openCalendar();
    await press($(star));
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await $("#cal-claude-restart").click();
    expect(await waitForCalls(close)).toEqual([{ id: "calendar-claude", launch: 1 }]);
    const starts = await waitForCalls("claude_code_start", 2);
    expect(starts[1]).toMatchObject({ id: "calendar-claude", builtinTools: false, skill: null, prompt: (starts[0] as { prompt: string }).prompt });
    await expect($("#cal-claude-restart")).toBeEnabled();
    await expect($(pane)).toBeDisplayed();
  });
});
