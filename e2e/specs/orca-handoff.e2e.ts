import type { HandoffSummary } from "../../ts/bindings/HandoffSummary";
import type { OrcaStarted } from "../../ts/bindings/OrcaStarted";
import {
  boot,
  callsOf,
  chatAssistant,
  chatItems,
  chatOpens,
  chatQuestion,
  chatQuestions,
  chatStatus,
  chatTools,
  chatUser,
  claudeReady,
  count,
  fire,
  handoffSummary,
  holds,
  huge,
  image,
  inbox,
  mock,
  note,
  onceId,
  orcaOverview,
  orcaRow,
  orcaWorktree,
  PNG,
  rejects,
  release,
  rowOf,
  sendChat,
  slackLoad,
  slackThread,
  slackTs,
  textsOf,
  threadDetail,
  threadLoaded,
  threadMessage,
  timeline,
  timelineMessage,
  todoData,
  waitForCalls,
  waitForCount,
  waitForOpens,
} from "../support";

// A waiting, a working and a done agent (all have a terminal), and a working one with no terminal. The pane lists none of them (it hands over to a new session only), but the Orca screen does.
const sample = () => [
  orcaRow("example-api", "main", "Fix the parser", { group: "waiting", minutes: 5 }),
  orcaRow("example-app", "feat/a", "Write the docs", { minutes: 2 }),
  orcaRow("example-lib", "feature/x", "Opened the pull request.", { group: "done", minutes: 18 }),
  orcaRow("example-web", "dev", "Update the page", { minutes: 11, handle: null, paneKey: null }),
];
const worktrees = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];
// What a launch answers, and the row the list then holds for that session.
const started: OrcaStarted = { paneKey: "tab_new:leaf_9", handle: "term_new" };
const newRow = () => orcaRow("example-app", "feat/a", "Fix the invoice", { minutes: 1, handle: "term_new", paneKey: "tab_new:leaf_9", path: "/work/example-app" });

const bootOrca = (fixtures: Record<string, unknown> = {}) =>
  boot({ inbox: inbox(), orca_overview: orcaOverview(sample(), worktrees()), claude_status: claudeReady, ...fixtures });

// ---- the three screens ----

const MAIL = { pane: "#mail-handoff", button: "#thread-orca" };
const TODO = { pane: "#todo-handoff", button: "#todo-orca" };
const SLACK = { pane: "#st-orca", button: "#reply-tab-orca" };
type Screen = typeof MAIL;

const mailBody = "10 月分の請求書の金額が、画面と 1,200 円違っています。";
const subject = "請求書の金額が画面と合わない件";

// The app with the thread "Already read" open.
async function openMail(fixtures: Record<string, unknown> = {}) {
  await bootOrca(fixtures);
  await waitForCount("#unread-threads li", 2);
  await mock("thread", threadDetail(subject, mailBody, false));
  await rowOf("read-threads", "Already read").$(".subject").click();
  await expect($("#thread-subject")).toHaveText(subject);
  await threadLoaded();
}

const rootTs = slackTs(60, 1);
const replyTs = slackTs(50, 2);
async function openSlack(fixtures: Record<string, unknown> = {}) {
  const messages = [timelineMessage(rootTs, "Alice Example", "dev-billing", "Please review the deploy notes.", { replyCount: 1 })];
  await bootOrca({ slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady, ...fixtures });
  await mock("slack_thread", slackThread([threadMessage(rootTs, "Alice Example", "Please review the deploy notes."), threadMessage(replyTs, "Bob Example", "Looks fine to me.")]));
  await $("#nav-slack").click();
  await waitForCount("#slack-feed .feed-row", 1);
  await $("#slack-feed .feed-open").click();
  await waitForCount("#st-msgs .st-msg", 2);
}

async function openTodo(fixtures: Record<string, unknown> = {}) {
  await bootOrca({ todoist_load: todoData(), slack_load: slackLoad, claude_status: claudeReady, ...fixtures });
  await $("#nav-todo").click();
  await waitForCount("#todo-list li.task", 1);
  await $("#todo-list li.task").click();
  await expect($("#todo-back")).toBeDisplayed();
}

// The list of Orca is read when the pane opens: the project chip is enabled once the projects are in.
const listRead = (screen: Screen) => expect($(`${screen.pane} .ho-project`)).toBeEnabled();

// Opens the pane of the screen shown: the header button of the mail and the Todo, the Orca tab of the Slack thread. The list of Orca is read when it opens.
async function openPane(screen: Screen) {
  await $(screen.button).click();
  await expect($(screen.pane)).toBeDisplayed();
  await listRead(screen);
}

const field = (screen: Screen) => $(`${screen.pane} textarea`);
const sendButton = (screen: Screen) => $(`${screen.pane} .ho-form .text-btn.primary`);

// Picks the project named `name` in the menu of its chip: the worktree is then the project's own folder (default).
async function chooseProject(screen: Screen, name: string) {
  await $(`${screen.pane} .ho-project`).click();
  await $(`//div[@role="menu"]//button[normalize-space(.)="${name}"]`).click();
}

// Picks 新規作成 in the menu of the worktree chip.
async function chooseNewWorktree(screen: Screen) {
  await $(`${screen.pane} .ho-worktree`).click();
  await $('//div[@role="menu"]//button[normalize-space(.)="新規作成"]').click();
}

// The rows of the open menu as "{name} / {branch}" for a worktree (two lines) and the label alone for any other row, those the search leaves.
const menuRows = () =>
  browser.execute(() =>
    [...document.querySelectorAll(".menu [role=menuitem]")]
      .filter((b) => !(b as HTMLElement).hidden)
      .map((b) => [...b.querySelectorAll(".menu-main, .menu-sub")].map((e) => e.textContent).join(" / ") || (b.textContent?.trim() ?? "")),
  );
// The row of the worktree named `name` in the open menu.
const worktreeRow = (name: string) => $(`//div[@role="menu"]//button[.//span[@class="menu-main" and normalize-space(.)="${name}"]]`);

// What `claude_summarize_handoff` answers by default, and the arguments `orca_handoff` and `claude_summarize_handoff` are called with.
const POINTS = ["請求書の金額を直す", "テストを足す"];
type Handed = { destination: unknown; instruction: string; files: string[]; summary: string[]; context: { kind: string; title: string; body: string } | null; environment: string | null };
type Asked = { context: { kind: string; title: string; body: string } };

// Writes the instruction and makes Claude answer `summary` for the content when the button hands it over (the mock is returned, and its calls are the asks). The press of the button is the test's.
async function write(screen: Screen, text: string, summary: HandoffSummary = handoffSummary(POINTS)) {
  const ask = await mock("claude_summarize_handoff", summary);
  await field(screen).setValue(text);
  return ask;
}

describe("orca handoff", () => {
  it("opens from the header icon of the mail, with its destinations, the card and the empty instruction", async () => {
    await openMail();
    await expect($(MAIL.button)).toHaveAttribute("aria-label", "Orca に渡す");
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "false");
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await $(MAIL.button).click();
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "true");
    await expect($(MAIL.pane)).toBeDisplayed();
    expect(await textsOf(`${MAIL.pane} .ho-title`)).toEqual(["Orca に渡す"]);
    // The divider reuses split.ts: a separator for the width of the pane.
    await expect($("#mail-split")).toHaveAttribute("role", "separator");
    await expect($("#mail-split")).toHaveAttribute("aria-label", "Orca の幅");
    await listRead(MAIL);
    // The chips of a new session run destination, project, worktree (no project chosen yet, so the worktree waits), and no running session is listed.
    expect(await textsOf(`${MAIL.pane} .ho-new button:not([hidden])`)).toEqual(["このマシン", "プロジェクトを選ぶ", "default"]);
    await expect($(`${MAIL.pane} .ho-project`)).toHaveAttribute("aria-label", "プロジェクト");
    await expect($(`${MAIL.pane} .ho-worktree`)).toBeDisabled();
    await expect($(`${MAIL.pane} .ho-name`)).not.toBeDisplayed();
    expect(await count(`${MAIL.pane} .ho-row, ${MAIL.pane} .ho-group, ${MAIL.pane} .ho-new-btn`)).toBe(0);
    // The card names the content: the subject, the sender and the size of the text, and has no button to read the text.
    expect(await textsOf(`${MAIL.pane} .ho-card-title`)).toEqual([subject]);
    expect((await textsOf(`${MAIL.pane} .ho-card-meta`))[0]).toMatch(/^Alice ・ 本文 \d+ 字$/);
    await expect($(`${MAIL.pane} [aria-label="渡す内容を外す"]`)).toBeDisplayed();
    expect(await count(`${MAIL.pane} .ho-card-toggle, ${MAIL.pane} .ho-card-body`)).toBe(0);
    await expect(field(MAIL)).toHaveAttribute("aria-label", "Orca への指示");
    await expect(sendButton(MAIL)).toHaveText("Orca に渡す");
    await expect(sendButton(MAIL)).toBeDisabled();
    // Under the field, the model and effort of the summary of the content (the purpose orcaHandoff), and no note while Claude can be used.
    await waitForCount(`${MAIL.pane} .chat-model select`, 2);
    expect(await browser.execute(() => [...document.querySelectorAll("#mail-handoff .chat-model select")].map((s) => (s as HTMLSelectElement).value))).toEqual(["sonnet", "medium"]);
    await expect($(`${MAIL.pane} .chat-note`)).not.toBeDisplayed();
    // The icon closes the pane again.
    await $(`${MAIL.pane} [aria-label="閉じる"]`).click();
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "false");
  });

  it("lists the projects of the destination in the menu of the project chip, and the worktree menu offers the project's own folder and 新規作成", async () => {
    // The projects are those of the list, here the two that have a folder.
    const project = (name: string) => ({ key: `proj_${name}`, name, status: "idle" as const, sessions: 0, atMs: 0 });
    await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { projects: [project("example-app"), project("example-api")] }) });
    await openPane(MAIL);
    await $(`${MAIL.pane} .ho-project`).click();
    expect(await textsOf(".menu [role=menuitem]")).toEqual(["example-app", "example-api"]);
    await $('//div[@role="menu"]//button[normalize-space(.)="example-api"]').click();
    expect(await textsOf(`${MAIL.pane} .ho-project`)).toEqual(["example-api"]);
    // The branch is the one checked out in the project's folder now.
    await $(`${MAIL.pane} .ho-worktree`).click();
    expect(await menuRows()).toEqual(["default / main", "新規作成"]);
    await expect(worktreeRow("default")).toHaveAttribute("aria-current", "true");
    await $('//div[@role="menu"]//button[normalize-space(.)="新規作成"]').click();
    expect(await textsOf(`${MAIL.pane} .ho-worktree`)).toEqual(["新規作成"]);
    await expect($(`${MAIL.pane} .ho-fresh`)).toBeDisplayed();
    await expect($(`${MAIL.pane} .ho-name`)).toBeDisplayed();
    await expect($(`${MAIL.pane} .ho-name`)).toHaveAttribute("aria-label", "worktree の名前");
    expect(await browser.execute(() => (document.querySelector("#mail-handoff .ho-name") as HTMLInputElement).placeholder)).toBe("");
    // Back to the project's own folder hides the name again.
    await $(`${MAIL.pane} .ho-worktree`).click();
    await worktreeRow("default").click();
    await expect($(`${MAIL.pane} .ho-name`)).not.toBeDisplayed();
    await expect($(`${MAIL.pane} .ho-fresh`)).not.toBeDisplayed();
  });

  it("lists the worktrees of the project with the branch under the name, the own folder first and 新規作成 last, narrows them by name or branch, and hands over in the one chosen", async () => {
    const list = [orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b", branch: "fix-b" }), ...worktrees()];
    await openMail({ orca_overview: orcaOverview(sample(), list) });
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    expect(await textsOf(`${MAIL.pane} .ho-worktree`)).toEqual(["default ・ feat/a"]);
    await $(`${MAIL.pane} .ho-worktree`).click();
    expect(await menuRows()).toEqual(["default / feat/a", "fix-b / feat/b", "新規作成"]);
    await expect($(".menu .menu-search")).toHaveAttribute("aria-label", "worktree を検索");
    // The search holds the name or the branch, as the menu of the projects does.
    await $(".menu .menu-search").setValue("feat/");
    expect(await menuRows()).toEqual(["default / feat/a", "fix-b / feat/b"]);
    await $(".menu .menu-search").setValue("zzz");
    expect(await menuRows()).toEqual([]);
    await expect($(".menu .menu-empty")).toHaveText("一致する worktree がありません");
    await $(".menu .menu-search").setValue("fix");
    expect(await menuRows()).toEqual(["fix-b / feat/b"]);
    await worktreeRow("fix-b").click();
    expect(await textsOf(`${MAIL.pane} .ho-worktree`)).toEqual(["fix-b ・ feat/b"]);
    await expect($(`${MAIL.pane} .ho-fresh`)).not.toBeDisplayed();
    await $(`${MAIL.pane} .ho-worktree`).click();
    await expect(worktreeRow("fix-b")).toHaveAttribute("aria-current", "true");
    await browser.keys("Escape");
    await write(MAIL, "やって");
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-app-b" });
  });

  it("clears the worktree chosen when the project changes", async () => {
    const list = [orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b", branch: "fix-b" }), ...worktrees()];
    await openMail({ orca_overview: orcaOverview(sample(), list) });
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await $(`${MAIL.pane} .ho-worktree`).click();
    await worktreeRow("fix-b").click();
    expect(await textsOf(`${MAIL.pane} .ho-worktree`)).toEqual(["fix-b ・ feat/b"]);
    await chooseProject(MAIL, "example-api");
    expect(await textsOf(`${MAIL.pane} .ho-worktree`)).toEqual(["default ・ main"]);
    await chooseProject(MAIL, "example-app");
    expect(await textsOf(`${MAIL.pane} .ho-worktree`)).toEqual(["default ・ feat/a"]);
  });

  describe("the frame of a worktree to make", () => {
    const BRANCHES = [
      { name: "feat/a", current: true, inUse: true },
      { name: "main", current: false, inUse: true },
      { name: "feat/c", current: false, inUse: false },
    ];
    const REMOTES = [{ name: "origin/feat/d", localName: "feat/d" }];
    const dialogRows = () => textsOf(".orca-dest-pop .orca-branch-row");
    const branchRow = (name: string) => $(`.orca-dest-pop .orca-branch-row[data-name="${name}"]`);

    // The pane at 新規作成, with the branches the lists answer.
    async function openFresh() {
      await openMail();
      await mock("orca_local_branches", BRANCHES);
      await mock("orca_remote_branches", REMOTES);
      await openPane(MAIL);
      await chooseProject(MAIL, "example-app");
      await chooseNewWorktree(MAIL);
    }

    it("shows the name, the ref and the branch under headings, with the defaults", async () => {
      await openFresh();
      expect(await textsOf(`${MAIL.pane} .ho-fresh .ho-field-title`)).toEqual(["名前", "作成元", "ブランチ"]);
      expect(await textsOf(`${MAIL.pane} .ho-base`)).toEqual(["既定"]);
      await expect($(`${MAIL.pane} .ho-base`)).toHaveAttribute("aria-label", "作成元");
      expect(await textsOf(`${MAIL.pane} .ho-seg button`)).toEqual(["新しいブランチ", "既存のブランチ"]);
      expect(await browser.execute(() => [...document.querySelectorAll("#mail-handoff .ho-seg button")].map((b) => b.getAttribute("aria-pressed")))).toEqual(["true", "false"]);
      await expect($(`${MAIL.pane} .ho-branch`)).toBeDisplayed();
      await expect($(`${MAIL.pane} .ho-branch`)).toHaveAttribute("aria-label", "ブランチの名前");
      expect(await browser.execute(() => (document.querySelector("#mail-handoff .ho-branch") as HTMLInputElement).placeholder)).toBe("");
      await expect($(`${MAIL.pane} .ho-existing`)).not.toBeDisplayed();
    });

    it("picks the ref to start from in the list of branches, 既定 first and none refused, and passes it with the name of the new branch to orca_worktree_create", async () => {
      await openFresh();
      const create = await mock("orca_worktree_create", "/work/example-app-fix-invoice");
      const handoff = await mock("orca_handoff", started);
      await $(`${MAIL.pane} .ho-base`).click();
      await waitForCount(".orca-dest-pop .orca-branch-row", 5);
      expect(await dialogRows()).toEqual(["既定", "feat/a", "main", "feat/c", "origin/feat/d"]);
      expect(await count(".orca-dest-pop .orca-branch-row:disabled")).toBe(0);
      expect(await callsOf("orca_local_branches")).toEqual([{ path: "/work/example-app", environment: null }]);
      expect(await callsOf("orca_remote_branches")).toEqual([{ path: "/work/example-app", repo: "proj_example-app", query: "", environment: null }]);
      await branchRow("origin/feat/d").click();
      expect(await textsOf(`${MAIL.pane} .ho-base`)).toEqual(["origin/feat/d"]);
      await $(`${MAIL.pane} .ho-name`).setValue("fix-invoice");
      await $(`${MAIL.pane} .ho-branch`).setValue(" feat/invoice ");
      await write(MAIL, "請求書を直して");
      await sendButton(MAIL).click();
      expect(await waitForCalls(create)).toEqual([{ project: "proj_example-app", name: "fix-invoice", branch: "feat/invoice", base: "origin/feat/d", environment: null }]);
      await waitForCalls(handoff);
    });

    it("goes back to 既定 with the first row of the list", async () => {
      await openFresh();
      await $(`${MAIL.pane} .ho-base`).click();
      await waitForCount(".orca-dest-pop .orca-branch-row", 5);
      await branchRow("feat/c").click();
      expect(await textsOf(`${MAIL.pane} .ho-base`)).toEqual(["feat/c"]);
      await $(`${MAIL.pane} .ho-base`).click();
      await waitForCount(".orca-dest-pop .orca-branch-row", 5);
      await expect(branchRow("feat/c")).toHaveAttribute("aria-current", "true");
      await $(".orca-dest-pop .orca-branch-row").click();
      expect(await textsOf(`${MAIL.pane} .ho-base`)).toEqual(["既定"]);
    });

    it("leaves the name of the branch to Orca when its field is blank", async () => {
      await openFresh();
      const create = await mock("orca_worktree_create", "/work/example-app-x");
      await mock("orca_handoff", started);
      await $(`${MAIL.pane} .ho-name`).setValue("x");
      await $(`${MAIL.pane} .ho-branch`).setValue("   ");
      await write(MAIL, "やって");
      await sendButton(MAIL).click();
      expect(await waitForCalls(create)).toEqual([{ project: "proj_example-app", name: "x", branch: null, base: null, environment: null }]);
    });

    it("picks an existing branch with the ones another worktree has checked out refused, disables the ref, and passes the local name of the branch with no ref", async () => {
      await openFresh();
      const create = await mock("orca_worktree_create", "/work/example-app-x");
      await mock("orca_handoff", started);
      await $(`${MAIL.pane} .ho-base`).click();
      await waitForCount(".orca-dest-pop .orca-branch-row", 5);
      await branchRow("feat/c").click();
      await $(`${MAIL.pane} .ho-seg button:nth-of-type(2)`).click();
      expect(await browser.execute(() => [...document.querySelectorAll("#mail-handoff .ho-seg button")].map((b) => b.getAttribute("aria-pressed")))).toEqual(["false", "true"]);
      await expect($(`${MAIL.pane} .ho-base`)).toBeDisabled();
      await expect($(`${MAIL.pane} .ho-branch`)).not.toBeDisplayed();
      await expect($(`${MAIL.pane} .ho-existing`)).toHaveText("ブランチを選ぶ");
      await expect($(`${MAIL.pane} .ho-existing`)).toHaveAttribute("aria-label", "既存のブランチ");
      await $(`${MAIL.pane} .ho-name`).setValue("x");
      await write(MAIL, "やって");
      // No branch is picked yet, so nothing is handed over.
      await expect(sendButton(MAIL)).toBeDisabled();
      await $(`${MAIL.pane} .ho-existing`).click();
      await waitForCount(".orca-dest-pop .orca-branch-row", 4);
      expect(await dialogRows()).toEqual(["feat/a", "main", "feat/c", "origin/feat/d"]);
      expect(await textsOf(".orca-dest-pop .orca-branch-row:disabled")).toEqual(["feat/a", "main"]);
      await branchRow("origin/feat/d").click();
      expect(await textsOf(`${MAIL.pane} .ho-existing`)).toEqual(["origin/feat/d"]);
      await expect(sendButton(MAIL)).toBeEnabled();
      await sendButton(MAIL).click();
      expect(await waitForCalls(create)).toEqual([{ project: "proj_example-app", name: "x", branch: "feat/d", base: null, environment: null }]);
    });

    it("keeps the choices of the frame while the other kind of branch is shown", async () => {
      await openFresh();
      await $(`${MAIL.pane} .ho-branch`).setValue("feat/new");
      await $(`${MAIL.pane} .ho-seg button:nth-of-type(2)`).click();
      await $(`${MAIL.pane} .ho-seg button:nth-of-type(1)`).click();
      await expect($(`${MAIL.pane} .ho-branch`)).toHaveValue("feat/new");
      await expect($(`${MAIL.pane} .ho-base`)).toBeEnabled();
    });
  });

  describe("the search field of the project menu", () => {
    const project = (name: string) => ({ key: `proj_${name}`, name, status: "idle" as const, sessions: 0, atMs: 0 });
    const NAMES = ["example-app", "Example-API", "my.service", "node(core)", "billing"];
    const search = () => $(".menu .menu-search");
    // The labels of the rows the menu draws now, and the one the keys are on.
    const rowsShown = () => browser.execute(() => [...document.querySelectorAll(".menu [role=menuitem]")].filter((b) => !(b as HTMLElement).hidden).map((b) => b.textContent?.trim() ?? ""));
    const cursorRow = () => browser.execute(() => [...document.querySelectorAll('.menu [data-cursor="true"]')].map((b) => b.textContent?.trim() ?? ""));

    async function openProjects(names = NAMES) {
      await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { projects: names.map(project) }) });
      await openPane(MAIL);
      // The click of the WebDriver gives the focus back to the chip after the handler ran (it sends no mousedown), so the chip is clicked from the page here to see where the menu puts the focus.
      await browser.execute(() => (document.querySelector("#mail-handoff .ho-project") as HTMLElement).click());
      await expect(search()).toBeDisplayed();
    }

    it("has a field named プロジェクトを検索 that takes the focus when the menu opens, with all the rows drawn and the first one under the keys", async () => {
      await openProjects();
      await expect(search()).toHaveAttribute("aria-label", "プロジェクトを検索");
      await expect(search()).toHaveAttribute("placeholder", "検索");
      expect(await browser.execute(() => document.activeElement === document.querySelector(".menu .menu-search"))).toBe(true);
      expect(await rowsShown()).toEqual(NAMES);
      expect(await cursorRow()).toEqual(["example-app"]);
      await expect($(".menu .menu-empty")).not.toBeDisplayed();
    });

    it("keeps the rows whose name holds the text, with case ignored and the text trimmed, and all of them when it is blank", async () => {
      await openProjects();
      await search().setValue("EXAMPLE");
      expect(await rowsShown()).toEqual(["example-app", "Example-API"]);
      await search().setValue("  api ");
      expect(await rowsShown()).toEqual(["Example-API"]);
      await search().setValue("   ");
      expect(await rowsShown()).toEqual(NAMES);
    });

    it("takes a character of a regular expression as itself", async () => {
      await openProjects();
      await search().setValue(".");
      expect(await rowsShown()).toEqual(["my.service"]);
      await search().setValue("(");
      expect(await rowsShown()).toEqual(["node(core)"]);
      await search().setValue("e.*");
      expect(await rowsShown()).toEqual([]);
    });

    it("says 一致するプロジェクトがありません, as a line and not a button, when no row matches", async () => {
      await openProjects();
      await search().setValue("zzz");
      expect(await rowsShown()).toEqual([]);
      await expect($(".menu .menu-empty")).toHaveText("一致するプロジェクトがありません");
      expect(await browser.execute(() => document.querySelector(".menu .menu-empty")!.tagName)).toBe("DIV");
      expect(await cursorRow()).toEqual([]);
      // Enter has no row to pick: the menu stays and nothing is chosen.
      await browser.keys("Enter");
      await expect(search()).toBeDisplayed();
      await search().setValue("billing");
      expect(await rowsShown()).toEqual(["billing"]);
      await expect($(".menu .menu-empty")).not.toBeDisplayed();
    });

    it("moves the cursor row with Down and Up along the rows shown, stops at the ends, and puts it on the first row again when the text changes", async () => {
      await openProjects();
      await browser.keys("ArrowUp");
      expect(await cursorRow()).toEqual(["example-app"]);
      await browser.keys("ArrowDown");
      expect(await cursorRow()).toEqual(["Example-API"]);
      for (let i = 0; i < 6; i++) await browser.keys("ArrowDown");
      expect(await cursorRow()).toEqual(["billing"]);
      await browser.keys("ArrowUp");
      expect(await cursorRow()).toEqual(["node(core)"]);
      await search().setValue("e");
      expect(await rowsShown()).toEqual(["example-app", "Example-API", "my.service", "node(core)"]);
      expect(await cursorRow()).toEqual(["example-app"]);
      await browser.keys("ArrowDown");
      await browser.keys("ArrowDown");
      expect(await cursorRow()).toEqual(["my.service"]);
    });

    it("picks the cursor row with Enter: the menu closes and the chip shows the project", async () => {
      await openProjects();
      await search().setValue("example");
      await browser.keys("ArrowDown");
      await browser.keys("Enter");
      await expect($(".menu")).not.toExist();
      expect(await textsOf(`${MAIL.pane} .ho-project`)).toEqual(["Example-API"]);
      // A click on a row still picks it.
      await $(`${MAIL.pane} .ho-project`).click();
      await $('//div[@role="menu"]//button[normalize-space(.)="billing"]').click();
      expect(await textsOf(`${MAIL.pane} .ho-project`)).toEqual(["billing"]);
    });

    it("closes with Escape", async () => {
      await openProjects();
      await search().setValue("ex");
      await browser.keys("Escape");
      await expect($(".menu")).not.toExist();
      expect(await browser.execute(() => document.querySelector("#mail-handoff .ho-project")!.hasAttribute("aria-expanded"))).toBe(false);
    });

    it("fits the window with the field in view, scrolls the rows inside the menu, and keeps its place while the rows shrink", async () => {
      await openProjects(Array.from({ length: 80 }, (_, i) => `example-project-${String(i).padStart(2, "0")}`));
      const geometry = () =>
        browser.execute(() => {
          const menu = document.querySelector(".menu")!.getBoundingClientRect();
          const field = document.querySelector(".menu .menu-search")!.getBoundingClientRect();
          const list = document.querySelector(".menu .menu-list") as HTMLElement;
          return { top: menu.top, left: menu.left, width: menu.width, bottom: menu.bottom, fieldTop: field.top, fieldBottom: field.bottom, scrolls: list.scrollHeight > list.clientHeight, inner: innerHeight };
        });
      const before = await geometry();
      expect(before.bottom).toBeLessThanOrEqual(before.inner);
      expect(before.scrolls).toBe(true);
      // Scroll the rows to the end: the field does not scroll away.
      await browser.execute(() => {
        const list = document.querySelector(".menu .menu-list") as HTMLElement;
        list.scrollTop = list.scrollHeight;
      });
      const scrolled = await geometry();
      expect(scrolled.fieldTop).toBe(before.fieldTop);
      expect(scrolled.fieldBottom).toBeLessThanOrEqual(scrolled.bottom);
      await search().setValue("project-7");
      expect(await rowsShown()).toHaveLength(10);
      const after = await geometry();
      expect(after.top).toBe(before.top);
      expect(after.left).toBe(before.left);
      expect(after.width).toBe(before.width);
      expect(after.scrolls).toBe(false);
    });

    it("is in the menu of the worktrees too, and not in the menu of the destination", async () => {
      await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { projects: NAMES.map(project), environments: ["Studio"] }) });
      await openPane(MAIL);
      await $(`${MAIL.pane} .ho-destination`).click();
      expect(await textsOf(".menu [role=menuitem]")).toEqual(["このマシン", "Studio"]);
      await expect($(".menu .menu-search")).not.toExist();
      await browser.keys("Escape");
      await chooseProject(MAIL, "example-app");
      await $(`${MAIL.pane} .ho-worktree`).click();
      expect(await menuRows()).toEqual(["default / feat/a", "新規作成"]);
      await expect($(".menu .menu-search")).toHaveAttribute("aria-label", "worktree を検索");
    });
  });

  it("hands over the instruction as written, with Claude's summary of the content and the content, as arguments of one command, and asks Claude only when the button is pressed", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", started);
    const create = await mock("orca_worktree_create", "/work/never");
    await openPane(MAIL);
    const ask = await write(MAIL, "原因を調べて");
    // The field takes the instruction only, and the button waits for a project.
    await expect(field(MAIL)).toHaveAttribute("aria-label", "Orca への指示");
    await expect(sendButton(MAIL)).toHaveText("Orca に渡す");
    await expect(sendButton(MAIL)).toBeDisabled();
    await chooseProject(MAIL, "example-app");
    expect(await textsOf(`${MAIL.pane} .ho-project`)).toEqual(["example-app"]);
    expect(await textsOf(`${MAIL.pane} .ho-worktree`)).toEqual(["default ・ feat/a"]);
    await expect(sendButton(MAIL)).toBeEnabled();
    // Nothing is sent to Claude or to Orca before the press.
    expect(await callsOf(ask)).toHaveLength(0);
    expect(await callsOf(handoff)).toHaveLength(0);
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-app" });
    expect(call.instruction).toBe("原因を調べて");
    expect(call.summary).toEqual(POINTS);
    expect(call.files).toEqual([]);
    expect(call.environment).toBeNull();
    expect(call.context!.kind).toBe("mail");
    expect(call.context!.title).toBe(subject);
    // The text of each message has its sender and its date.
    expect(call.context!.body).toContain("差出人: Alice <alice@example.com>");
    expect(call.context!.body).toContain("日時: ");
    expect(call.context!.body).toContain(mailBody);
    // Claude got the content alone, as the card holds it, and not the instruction.
    const [asked] = (await callsOf(ask)) as Asked[];
    expect(asked).toEqual({ context: call.context });
    // Nothing else was sent, and the Orca screen's own launch was not used.
    expect(await callsOf("orca_start")).toHaveLength(0);
    expect(await callsOf(handoff)).toHaveLength(1);
    expect(await callsOf(ask)).toHaveLength(1);
    // The folder of the project was used as it is: no worktree was made.
    expect(await callsOf(create)).toHaveLength(0);
  });

  it("stops the button while Claude cannot be used and the card is there, as the Slack thread does, and hands over the instruction alone once the card is taken off", async () => {
    await openMail({ claude_status: { state: "missing" } });
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await expect($(`${MAIL.pane} .chat-note`)).toHaveText("設定の Claude タブで接続すると、Claude に要約してもらえます");
    await field(MAIL).setValue("原因を調べて");
    await expect(field(MAIL)).toBeEnabled();
    await expect(sendButton(MAIL)).toBeDisabled();
    // With no content there is nothing for Claude to summarise.
    await $(`${MAIL.pane} [aria-label="渡す内容を外す"]`).click();
    await expect($(`${MAIL.pane} .chat-note`)).not.toBeDisplayed();
    await expect(sendButton(MAIL)).toBeEnabled();
    await sendButton(MAIL).click();
    expect(await waitForCalls(handoff)).toEqual([{ destination: { kind: "new", path: "/work/example-app" }, instruction: "原因を調べて", files: [], summary: [], context: null, environment: null }]);
  });

  it("shows the message of a failed summary above the card, makes and starts nothing, keeps the text, and lets the owner press again", async () => {
    await openMail();
    const ask = await mock("claude_summarize_handoff", rejects("Claude が要約を返しませんでした"));
    const create = await mock("orca_worktree_create", "/work/example-app-x");
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await chooseNewWorktree(MAIL);
    await $(`${MAIL.pane} .ho-name`).setValue("x");
    await field(MAIL).setValue("原因を調べて");
    await sendButton(MAIL).click();
    await waitForCalls(ask);
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("Claude が要約を返しませんでした");
    await expect(field(MAIL)).toHaveValue("原因を調べて");
    expect(await callsOf(create)).toHaveLength(0);
    expect(await callsOf(handoff)).toHaveLength(0);
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(1);
    await expect(sendButton(MAIL)).toHaveText("Orca に渡す");
    await expect(sendButton(MAIL)).toBeEnabled();
    // Pressing again with the same text works, and the message goes.
    await write(MAIL, "原因を調べて");
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.summary).toEqual(POINTS);
    expect(await callsOf(create)).toHaveLength(1);
  });

  it("keeps a hand-over on its way, and its result, with the item it was started for", async () => {
    await openMail();
    const ask = await mock("claude_summarize_handoff", holds);
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await field(MAIL).setValue("守る指示");
    await sendButton(MAIL).click();
    await waitForCalls(ask);
    await expect(field(MAIL)).toBeDisabled();
    await expect(sendButton(MAIL)).toBeDisabled();
    // Another thread: its pane is not waiting.
    await $("#back").click();
    await mock("thread", threadDetail("Second", "Other mail", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("Second");
    await threadLoaded();
    await $(MAIL.button).click();
    await listRead(MAIL);
    await expect(field(MAIL)).toBeEnabled();
    await release(ask, handoffSummary(POINTS));
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.instruction).toBe("守る指示");
    expect(call.summary).toEqual(POINTS);
    await browser.pause(300);
    expect(await count(`${MAIL.pane} .ho-session-name`)).toBe(0);
    await $("#back").click();
    // Its own item shows the session when it is shown again.
    await mock("thread", threadDetail(subject, mailBody, false));
    await rowOf("read-threads", "Already read").$(".subject").click();
    await threadLoaded();
    await expect($(`${MAIL.pane} .ho-session-name`)).toBeDisplayed();
  });

  it("hands over nothing without an instruction, even with a project chosen and the Orca list read", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await expect(sendButton(MAIL)).toBeDisabled();
    await field(MAIL).setValue("   ");
    await expect(sendButton(MAIL)).toBeDisabled();
    expect(await callsOf(handoff)).toHaveLength(0);
  });

  it("makes the worktree named in the field with orca_worktree_create and starts the session in the path it answers", async () => {
    await openMail();
    const create = await mock("orca_worktree_create", "/work/example-app-fix-invoice");
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await chooseNewWorktree(MAIL);
    await $(`${MAIL.pane} .ho-name`).setValue("fix-invoice");
    await write(MAIL, "請求書を直して");
    await expect(sendButton(MAIL)).toBeEnabled();
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    expect(await waitForCalls(create)).toEqual([{ project: "proj_example-app", name: "fix-invoice", branch: null, base: null, environment: null }]);
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-app-fix-invoice" });
    expect(call.instruction).toBe("請求書を直して");
    expect(call.summary).toEqual(POINTS);
    expect(call.environment).toBeNull();
    expect(await callsOf(create)).toHaveLength(1);
    expect(await callsOf(handoff)).toHaveLength(1);
    await expect($(`${MAIL.pane} .ho-session-name`)).toBeDisplayed();
  });

  it("makes the worktree in the destination chosen, and starts there", async () => {
    await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { environments: ["Lab"] }) });
    await mock("orca_destination", orcaOverview([], [orcaWorktree("example-lab", "main")], { target: "Lab", environments: ["Lab"], known: false }));
    const create = await mock("orca_worktree_create", "/lab/example-lab-b");
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await $(`${MAIL.pane} .ho-destination`).click();
    await $('//div[@role="menu"]//button[normalize-space(.)="Lab"]').click();
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-project`))[0] === "プロジェクトを選ぶ", { timeoutMsg: "the lists of the destination were not read" });
    await chooseProject(MAIL, "example-lab");
    await chooseNewWorktree(MAIL);
    await $(`${MAIL.pane} .ho-name`).setValue("b");
    await write(MAIL, "やって");
    await sendButton(MAIL).click();
    expect(await waitForCalls(create)).toEqual([{ project: "proj_example-lab", name: "b", branch: null, base: null, environment: "Lab" }]);
    const [call] = (await waitForCalls(handoff)) as { destination: unknown; environment: string | null }[];
    expect(call.destination).toEqual({ kind: "new", path: "/lab/example-lab-b" });
    expect(call.environment).toBe("Lab");
  });

  it("starts nothing when the worktree cannot be made, keeps the instruction and the name, and shows the message of Rust", async () => {
    await openMail();
    const create = await mock("orca_worktree_create", rejects("worktree の名前を入力してください"));
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await chooseNewWorktree(MAIL);
    await write(MAIL, "やって");
    await sendButton(MAIL).click();
    await waitForCalls(create);
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("worktree の名前を入力してください");
    expect(await callsOf(handoff)).toHaveLength(0);
    // Still the form with the card and the instruction, and the button ready to try again.
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(1);
    await expect(field(MAIL)).toHaveValue("やって");
    await expect(sendButton(MAIL)).toBeEnabled();
    // The next hand-over asks again (nothing was made), with the name written in the field.
    await $(`${MAIL.pane} .ho-name`).setValue("fix");
    await mock("orca_worktree_create", "/work/example-app-fix");
    await sendButton(MAIL).click();
    await waitForCalls(handoff);
  });

  it("does not make a second worktree when the launch fails after one was made and the same send is tried again", async () => {
    await openMail();
    const create = await mock("orca_worktree_create", "/work/example-app-fix");
    const handoff = await mock("orca_handoff", rejects("Orca が指示を受け付けませんでした"));
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await chooseNewWorktree(MAIL);
    await write(MAIL, "やって");
    await $(`${MAIL.pane} .ho-name`).setValue("fix");
    await sendButton(MAIL).click();
    await waitForCalls(handoff);
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("Orca が指示を受け付けませんでした");
    const again = await mock("orca_handoff", started);
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(again)) as { destination: unknown }[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-app-fix" });
    expect(await callsOf(create)).toHaveLength(1);
  });

  it("keeps the chosen project in memory for the next handoff", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-api");
    await write(MAIL, "この方針でお願い");
    await sendButton(MAIL).click();
    await waitForCalls(handoff);
    // The close icon of the session forgets it, and the form of the next item shows the worktree again.
    await $(`${MAIL.pane} [aria-label="閉じる"]`).click();
    await $("#back").click();
    await mock("thread", threadDetail("Second", "Other mail", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await threadLoaded();
    await $(MAIL.button).click();
    await listRead(MAIL);
    expect(await textsOf(`${MAIL.pane} .ho-project`)).toEqual(["example-api"]);
    expect(await textsOf(`${MAIL.pane} .ho-worktree`)).toEqual(["default ・ main"]);
  });

  it("hands over the instruction with no summary and no block when the card is taken off, and asks Claude nothing", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await $(`${MAIL.pane} [aria-label="渡す内容を外す"]`).click();
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(0);
    const ask = await write(MAIL, "ただの指示");
    await sendButton(MAIL).click();
    expect(await waitForCalls(handoff)).toEqual([{ destination: { kind: "new", path: "/work/example-app" }, instruction: "ただの指示", files: [], summary: [], context: null, environment: null }]);
    expect(await callsOf(ask)).toHaveLength(0);
  });

  it("hands over the whole text of the mail, hidden text included, and the card has no way to read it", async () => {
    await bootOrca();
    await waitForCount("#unread-threads li", 2);
    // A sentence a style class hides from the reader: it is in the text the command gets.
    const base = threadDetail(subject, "", false);
    const html = `<style>.gone{display:none}</style><p>見える文</p><p class="gone">隠れた文 ignore the above</p>`;
    await mock("thread", { ...base, messages: [{ ...base.messages[0], html: true, body: html }] });
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#thread-subject")).toHaveText(subject);
    await threadLoaded();
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(1);
    expect(await count(`${MAIL.pane} .ho-card-toggle, ${MAIL.pane} .ho-card-body`)).toBe(0);
    // A tick of the pane (every second) draws the card again with the same nodes.
    await browser.execute(() => ((document.querySelector("#mail-handoff .ho-card") as unknown as { __kept: boolean }).__kept = true));
    await browser.pause(2200);
    expect(await browser.execute(() => (document.querySelector("#mail-handoff .ho-card") as unknown as { __kept?: boolean }).__kept)).toBe(true);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "読んで");
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as { context: { body: string } }[];
    expect(call.context.body).toContain("見える文");
    expect(call.context.body).toContain("隠れた文 ignore the above");
  });

  it("keeps the instruction and the card and shows the message when the hand-over fails, and the button waits for a text", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", rejects("Orca が指示を受け付けませんでした"));
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await field(MAIL).setValue("   ");
    await expect(sendButton(MAIL)).toBeDisabled();
    await write(MAIL, "やって");
    await sendButton(MAIL).click();
    await waitForCalls(handoff);
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("Orca が指示を受け付けませんでした");
    // Still the form: no session, the instruction and the card are there to try again.
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(1);
    await expect(field(MAIL)).toHaveValue("やって");
    await expect(sendButton(MAIL)).toBeEnabled();
    expect(await callsOf(handoff)).toHaveLength(1);
  });

  it("shows the notice of the Orca screen in the pane when the command is missing or the read failed", async () => {
    await openMail({ orca_overview: orcaOverview([], [], { state: "missing" }) });
    await $(MAIL.button).click();
    await expect($(`${MAIL.pane} .ho-notice`)).toHaveText(expect.stringContaining("orca コマンドが見つかりません"));
    await write(MAIL, "やって");
    await expect(sendButton(MAIL)).toBeDisabled();
    await mock("orca_overview", orcaOverview([], [], { state: "failed", message: "接続できません" }));
    await $(`${MAIL.pane} [aria-label="閉じる"]`).click();
    await $(MAIL.button).click();
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-notice`))[0]?.includes("読み込めませんでした: 接続できません"), { timeoutMsg: "the failed read was not told" });
  });

  it("shows the session after the send: its header, its history with the content folded, and the composer", async () => {
    await openMail();
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "原因を調べて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForCalls(handoff);
    // The history of the pane the launch named is read for the pane.
    const opens = await waitForOpens(1);
    expect(opens[0]).toEqual({ environment: null, path: "/work/example-app", paneKey: "tab_new:leaf_9", channel: true });
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-session-state`))[0] === "作業中 ・ 1 分", { timeoutMsg: "the state of the session was not shown" });
    await expect($(`${MAIL.pane} [aria-label="Orca の画面で開く"]`)).toBeDisplayed();
    await expect($(`${MAIL.pane} [aria-label="閉じる"]`)).toBeDisplayed();
    expect(await count(`${MAIL.pane} .ho-card`)).toBe(0);
    // The user's message holds only the instruction; the content is one line that opens to its text, drawn as text.
    const shortTitle = `${[...subject].slice(0, 12).join("")}…`;
    await sendChat(chatItems([chatUser("u1", "原因を調べて", { kind: "mail", title: subject, text: `${mailBody}\n<b>not html</b>` }), chatAssistant("a1", "調べます")]));
    await waitForCount(`${MAIL.pane} .orca-user`, 1);
    expect(await textsOf(`${MAIL.pane} .orca-user-text`)).toEqual(["原因を調べて"]);
    const label = `メール「${shortTitle}」${[...`${mailBody}\n<b>not html</b>`].length} 字`;
    expect(await textsOf(`${MAIL.pane} .orca-ctx-label`)).toEqual([label]);
    const fold = $(`${MAIL.pane} .orca-ctx-btn`);
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect($(`${MAIL.pane} .orca-ctx-text`)).not.toBeDisplayed();
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect($(`${MAIL.pane} .orca-ctx-text`)).toBeDisplayed();
    expect(await textsOf(`${MAIL.pane} .orca-ctx-text`)).toEqual([`${mailBody}\n<b>not html</b>`]);
    expect(await count(`${MAIL.pane} .orca-ctx-text b`)).toBe(0);
    // More instructions go to the session's terminal with the command of the Orca screen.
    const post = await mock("orca_send", null);
    await field(MAIL).setValue("続けて");
    await expect(sendButton(MAIL)).toHaveText("送る");
    await sendButton(MAIL).click();
    expect(await waitForCalls(post)).toEqual([{ handle: "term_new", text: "続けて", environment: null }]);
    await expect(field(MAIL)).toHaveValue("");
  });

  it("answers a question of the history from the pane, to the terminal of the session", async () => {
    await openMail();
    await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "質問して");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForOpens(1);
    const answerCall = await mock("orca_answer", null);
    await sendChat(chatItems([chatQuestion("q1", null, true, true)]));
    await waitForCount(`${MAIL.pane} .orca-pick-option`, 2);
    const send = $(`${MAIL.pane} .orca-pick-send`);
    await expect(send).toBeDisabled();
    const options = await $$(`${MAIL.pane} .orca-pick-option`);
    await options[1].click();
    await options[0].click();
    expect(await callsOf(answerCall)).toEqual([]);
    await send.click();
    expect(await waitForCalls(answerCall)).toEqual([
      { handle: "term_new", questions: [{ text: "Which one?", multi: true, options: ["First", "Second"], picks: [1, 0] }], environment: null },
    ]);
    await expect($(`${MAIL.pane} .orca-pick-send`)).toHaveText("送信中…");
    await expect($(`${MAIL.pane} .orca-pick-send`)).toBeDisabled();
  });

  it("keeps the notice of a session that finishes while the pane shows it, until the Orca screen shows it", async () => {
    await openMail();
    await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "原因を調べて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForOpens(1);
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    // The waiting agent of the sample is the one in the count.
    await expect($("#nav-orca .nav-count")).toHaveText("1");
    // The session finishes; a follow-up makes the pane read the list again, and the pane still shows the session.
    const overview = await mock("orca_overview", orcaOverview([...sample(), { ...newRow(), group: "done", status: "done" }], worktrees()));
    await mock("orca_send", null);
    await field(MAIL).setValue("続けて");
    await sendButton(MAIL).click();
    await waitForCalls(overview);
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    await expect($("#nav-orca .nav-count")).toHaveText("2");
  });

  it("keeps the text of a follow-up when it fails, and says that a session with no pane has no history", async () => {
    await openMail();
    await mock("orca_handoff", { paneKey: null, handle: "term_new" } satisfies OrcaStarted);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "始めて");
    await sendButton(MAIL).click();
    await expect($(`${MAIL.pane} .ho-note`)).toBeDisplayed();
    // No pane key came back: the session started, and the history is not read.
    expect(await chatOpens()).toHaveLength(0);
    await expect($(`${MAIL.pane} [aria-label="Orca の画面で開く"]`)).toBeDisplayed();
    await mock("orca_send", rejects("失敗しました"));
    await field(MAIL).setValue("続けて");
    await sendButton(MAIL).click();
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("失敗しました");
    await expect(field(MAIL)).toHaveValue("続けて");
  });

  it("shows the session again when the item is left and opened again, and the close icon forgets it", async () => {
    await openMail();
    await mock("orca_handoff", started);
    await mock("orca_chat_close", null);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "原因を調べて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForOpens(1);
    // Back to the list: the pane is gone and the read is let go.
    await $("#back").click();
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await browser.waitUntil(async () => (await callsOf("orca_chat_close")).length === 1, { timeoutMsg: "the read was not released" });
    // The same thread again: the pane is open on its session, and its history is read again.
    await rowOf("read-threads", "Already read").$(".subject").click();
    await threadLoaded();
    await expect($(MAIL.pane)).toBeDisplayed();
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "true");
    await waitForOpens(2);
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    // Another thread has no session: its pane stays closed.
    await $("#back").click();
    await mock("thread", threadDetail("Second", "Other", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await threadLoaded();
    await expect($(MAIL.button)).toHaveAttribute("aria-pressed", "false");
    await expect($(MAIL.pane)).not.toBeDisplayed();
    // The close icon of the session forgets it: the next open shows the form.
    await $("#back").click();
    await mock("thread", threadDetail(subject, mailBody, false));
    await rowOf("read-threads", "Already read").$(".subject").click();
    await threadLoaded();
    await expect($(MAIL.pane)).toBeDisplayed();
    await $(`${MAIL.pane} [aria-label="閉じる"]`).click();
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await $(MAIL.button).click();
    // The form is back.
    await listRead(MAIL);
    expect(await count(`${MAIL.pane} .ho-session-name`)).toBe(0);
  });

  it("opens the session on the Orca screen, which selects its tab and shows its terminal, and the pane reads the history again when the thread is opened again", async () => {
    await openMail();
    await mock("orca_handoff", started);
    const close = await mock("orca_chat_close", null);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "原因を調べて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForOpens(1);
    const read = await mock("orca_terminal_read", ["$ claude"]);
    await $(`${MAIL.pane} [aria-label="Orca の画面で開く"]`).click();
    await expect($("#orca")).toBeDisplayed();
    await expect($('.orca-tabs [data-tab="claude:tab_new:leaf_9"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    expect((await waitForCalls(read))[0]).toEqual({ handle: "term_new" });
    // The screen reads no history: the pane, out of view, lets its read go.
    await waitForCalls(close);
    await browser.pause(1500);
    expect(await chatOpens()).toHaveLength(1);
    // The thread is open again: the pane reads the history again.
    await $("#nav-mail").click();
    await rowOf("read-threads", "Already read").$(".subject").click();
    await threadLoaded();
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    await waitForOpens(2);
    await sendChat(chatItems([chatAssistant("a9", "戻りました")]));
    await waitForCount(`${MAIL.pane} .orca-assistant`, 1);
  });

  it("opens from the header icon of a Todo, with its content as the card", async () => {
    await openTodo();
    await expect($(TODO.button)).toHaveAttribute("aria-label", "Orca に渡す");
    await expect($(TODO.button)).toHaveAttribute("aria-pressed", "false");
    const handoff = await mock("orca_handoff", started);
    await openPane(TODO);
    await expect($(TODO.button)).toHaveAttribute("aria-pressed", "true");
    await expect($("#todo-split")).toHaveAttribute("role", "separator");
    expect(await textsOf(`${TODO.pane} .ho-card-title`)).toEqual(["Write report"]);
    expect(await textsOf(`${TODO.pane} .ho-card-meta`)).toEqual(["説明なし ・ 今日"]);
    await chooseProject(TODO, "example-app");
    await write(TODO, "実装して");
    await sendButton(TODO).click();
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-app" });
    expect(call.context!.kind).toBe("todo");
    expect(call.context!.title).toBe("Write report");
    expect(call.context!.body).toContain("タスク: Write report");
    expect(call.context!.body).toContain("プロジェクト: Work");
    // Back to the list: the pane is gone, and the icon is only for the detail.
    await $("#todo-back").click();
    await expect($(TODO.pane)).not.toBeDisplayed();
    await expect($(TODO.button)).not.toBeDisplayed();
    // The same task again shows its session.
    await $("#todo-list li.task").click();
    await expect($(`${TODO.pane} .ho-session-name`)).toBeDisplayed();
  });

  it("makes the right pane of the Slack thread tabs, Claude first and selected, and Orca hands the thread over", async () => {
    await openSlack();
    const tabs = $("#reply-tabs");
    await expect(tabs).toHaveAttribute("role", "tablist");
    await expect(tabs).toHaveAttribute("aria-label", "Claude と Orca");
    expect(await textsOf("#reply-tabs [role=tab]")).toEqual(["Claude", "Orca"]);
    await expect($("#reply-tab-claude")).toHaveAttribute("aria-selected", "true");
    await expect($("#reply-tab-orca")).toHaveAttribute("aria-selected", "false");
    await expect($("#reply-log")).toBeDisplayed();
    await expect($("#st-orca")).not.toBeDisplayed();
    const handoff = await mock("orca_handoff", started);
    await $("#reply-tab-orca").click();
    await expect($("#reply-tab-orca")).toHaveAttribute("aria-selected", "true");
    await expect($("#reply-tab-claude")).toHaveAttribute("aria-selected", "false");
    await expect($("#reply-log")).not.toBeDisplayed();
    await expect($("#reply-clear")).not.toBeDisplayed();
    await listRead(SLACK);
    expect(await textsOf(`${SLACK.pane} .ho-card-title`)).toEqual(["#dev-billing のスレッド"]);
    expect(await textsOf(`${SLACK.pane} .ho-card-meta`)).toEqual(["Alice Example ほか ・ 2 件"]);
    await chooseProject(SLACK, "example-api");
    await write(SLACK, "返信案を作って");
    await sendButton(SLACK).click();
    const [call] = (await waitForCalls(handoff)) as { destination: unknown; context: { kind: string; title: string; body: string } }[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-api" });
    expect(call.context.kind).toBe("slack");
    expect(call.context.title).toBe("#dev-billing のスレッド");
    // Each message has its sender and its time.
    expect(call.context.body).toContain("Alice Example  ");
    expect(call.context.body).toContain("Please review the deploy notes.");
    expect(call.context.body).toContain("Bob Example  ");
    expect(call.context.body).toContain("Looks fine to me.");
    await waitForOpens(1);
    // Back to Claude: its pane is as it was, and the read is let go.
    await mock("orca_chat_close", null);
    await $("#reply-tab-claude").click();
    await expect($("#reply-log")).toBeDisplayed();
    await expect($("#st-orca")).not.toBeDisplayed();
    await browser.waitUntil(async () => (await callsOf("orca_chat_close")).length === 1, { timeoutMsg: "the read was not released" });
    // The Orca tab again: the session is shown, and its history is read again.
    await $("#reply-tab-orca").click();
    await waitForOpens(2);
    await expect($(`${SLACK.pane} [aria-label="Orca の画面で開く"]`)).toBeDisplayed();
  });

  it("starts at the target the Orca screen holds, and sends to it", async () => {
    await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }) });
    const handoff = await mock("orca_handoff", started);
    const destination = await mock("orca_destination", orcaOverview([], []));
    await openPane(MAIL);
    expect(await textsOf(`${MAIL.pane} .ho-destination`)).toEqual(["Studio"]);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "やって");
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as { environment: string | null }[];
    expect(call.environment).toBe("Studio");
    // The list of the Orca screen is the destination's: nothing else is read.
    expect(await callsOf(destination)).toEqual([]);
  });

  it("names this machine as the destination, with nothing to choose when no environment is saved", async () => {
    await openMail();
    await openPane(MAIL);
    expect(await textsOf(`${MAIL.pane} .ho-destination`)).toEqual(["このマシン"]);
    await expect($(`${MAIL.pane} .ho-destination`)).toBeDisabled();
  });

  it("reads the lists of the destination chosen, and hands over to it, with the target of the Orca screen untouched", async () => {
    await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { environments: ["Studio", "Lab"] }) });
    const setTarget = await mock("orca_set_target", null);
    const destination = await mock("orca_destination", orcaOverview([], [orcaWorktree("example-lab", "main")], { target: "Lab", environments: ["Studio", "Lab"], known: false }));
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    expect(await textsOf(`${MAIL.pane} .ho-project`)).toEqual(["example-app"]);
    await $(`${MAIL.pane} .ho-destination`).click();
    expect(await textsOf(".menu [role=menuitem]")).toEqual(["このマシン", "Studio", "Lab"]);
    await $('//div[@role="menu"]//button[normalize-space(.)="Lab"]').click();
    expect(await waitForCalls(destination)).toEqual([{ environment: "Lab", force: true }]);
    // The projects are the destination's, and the one chosen for the old destination is dropped.
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-destination`))[0] === "Lab", { timeoutMsg: "the destination was not shown" });
    await expect($(`${MAIL.pane} .ho-project`)).toBeEnabled();
    expect(await textsOf(`${MAIL.pane} .ho-project`)).toEqual(["プロジェクトを選ぶ"]);
    await chooseProject(MAIL, "example-lab");
    await write(MAIL, "やって");
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as { destination: unknown; environment: string | null }[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-lab" });
    expect(call.environment).toBe("Lab");
    expect(await callsOf(setTarget)).toEqual([]);
    // The session is read at its own destination, and the choice is kept for the next handoff.
    await expect($(`${MAIL.pane} [aria-label="Orca の画面で開く"]`)).toBeDisplayed();
    expect((await callsOf(destination)).length).toBeGreaterThan(1);
  });

  it("changes back to this machine from the menu, which lists the destination read last", async () => {
    await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }) });
    const destination = await mock("orca_destination", orcaOverview([], worktrees(), { target: null, environments: ["Studio"], known: false }));
    await openPane(MAIL);
    await $(`${MAIL.pane} .ho-destination`).click();
    await $('//div[@role="menu"]//button[normalize-space(.)="このマシン"]').click();
    expect(await waitForCalls(destination)).toEqual([{ environment: null, force: true }]);
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-destination`))[0] === "このマシン", { timeoutMsg: "the destination was not shown" });
  });

  it("shows the notice of the Orca screen in the pane when the destination cannot be read, and sends nothing to it", async () => {
    await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { environments: ["Studio"] }) });
    await mock("orca_destination", orcaOverview([], [], { state: "failed", message: "接続できません", target: "Studio", environments: ["Studio"], known: false }));
    await openPane(MAIL);
    await $(`${MAIL.pane} .ho-destination`).click();
    await $('//div[@role="menu"]//button[normalize-space(.)="Studio"]').click();
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-notice`))[0]?.includes("読み込めませんでした: 接続できません"), { timeoutMsg: "the failed read was not told" });
    expect(await textsOf(`${MAIL.pane} .ho-project`)).toEqual(["プロジェクトがありません"]);
    await expect($(`${MAIL.pane} .ho-project`)).toBeDisabled();
    await write(MAIL, "やって");
    await expect(sendButton(MAIL)).toBeDisabled();
  });

  it("puts the instruction of a hand-over that failed at the summary and its message back in its own item when the failure came on another", async () => {
    await openMail();
    const ask = await mock("claude_summarize_handoff", holds);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await field(MAIL).setValue("守る指示");
    await sendButton(MAIL).click();
    await waitForCalls(ask);
    // Another thread: its pane is closed and not busy, and the failure arrives meanwhile.
    await $("#back").click();
    await mock("thread", threadDetail("Second", "Other mail", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("Second");
    await threadLoaded();
    await expect($(MAIL.pane)).not.toBeDisplayed();
    await release(ask, rejects("失敗しました"));
    await browser.pause(300);
    // The message is not shown on the other thread.
    await $(MAIL.button).click();
    await listRead(MAIL);
    expect(await count(`${MAIL.pane} .ho-form .pending.fail:not([hidden])`)).toBe(0);
    await expect(field(MAIL)).toHaveValue("");
    await $("#back").click();
    // Its own item has the text and the message again.
    await mock("thread", threadDetail(subject, mailBody, false));
    await rowOf("read-threads", "Already read").$(".subject").click();
    await threadLoaded();
    await $(MAIL.button).click();
    await listRead(MAIL);
    await expect(field(MAIL)).toHaveValue("守る指示");
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("失敗しました");
    await expect(field(MAIL)).toBeEnabled();
  });

  it("keeps the message of a hand-over that failed on another item with its own item", async () => {
    await openMail();
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "守る指示");
    const handoff = await mock("orca_handoff", holds);
    await sendButton(MAIL).click();
    await waitForCalls(handoff);
    await $("#back").click();
    await mock("thread", threadDetail("Second", "Other mail", false));
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("Second");
    await threadLoaded();
    await release(handoff, rejects("失敗しました"));
    await browser.pause(300);
    await $(MAIL.button).click();
    await listRead(MAIL);
    expect(await count(`${MAIL.pane} .ho-form .pending.fail:not([hidden])`)).toBe(0);
    await $("#back").click();
    await mock("thread", threadDetail(subject, mailBody, false));
    await rowOf("read-threads", "Already read").$(".subject").click();
    await threadLoaded();
    await $(MAIL.button).click();
    await listRead(MAIL);
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("失敗しました");
    await expect(field(MAIL)).toHaveValue("守る指示");
    await expect(sendButton(MAIL)).toBeEnabled();
  });

  it("keeps the Orca tab selected while another thread opens, and hands the new thread over once it is read", async () => {
    const olderTs = slackTs(60, 1);
    const newerTs = slackTs(30, 3);
    const messages = [timelineMessage(newerTs, "Carol Example", "ops", "Second thread root", { replyCount: 0, channel: "C2" }), timelineMessage(olderTs, "Alice Example", "dev-billing", "Please review the deploy notes.", { replyCount: 1 })];
    await bootOrca({ slack_load: slackLoad, slack_timeline: timeline(messages), claude_status: claudeReady });
    await mock("slack_thread", slackThread([threadMessage(olderTs, "Alice Example", "Please review the deploy notes.")]));
    await $("#nav-slack").click();
    await waitForCount("#slack-feed .feed-row", 2);
    await (await $$("#slack-feed .feed-open"))[1].click();
    await waitForCount("#st-msgs .st-msg", 1);
    await $("#reply-tab-orca").click();
    await listRead(SLACK);
    // Another thread, whose read is held: the tab is still Orca and the pane has no content yet.
    await $("#st-back").click();
    const read = await mock("slack_thread", holds);
    await (await $$("#slack-feed .feed-open"))[0].click();
    await expect($("#reply-tab-orca")).toHaveAttribute("aria-selected", "true");
    await expect($(SLACK.pane)).toBeDisplayed();
    await waitForCalls(read);
    expect(await count(`${SLACK.pane} .ho-card`)).toBe(0);
    await release(read, slackThread([threadMessage(newerTs, "Carol Example", "Second thread root")]));
    await waitForCount("#st-msgs .st-msg", 1);
    await waitForCount(`${SLACK.pane} .ho-card`, 1);
    expect(await textsOf(`${SLACK.pane} .ho-card-title`)).toEqual(["#ops のスレッド"]);
    const handoff = await mock("orca_handoff", started);
    await chooseProject(SLACK, "example-app");
    await write(SLACK, "返信案を作って");
    await sendButton(SLACK).click();
    const [call] = (await waitForCalls(handoff)) as { context: { body: string } }[];
    expect(call.context.body).toContain("Second thread root");
    expect(call.context.body).not.toContain("Please review the deploy notes.");
  });

  it("hands over the new content when the Todo detail is drawn again", async () => {
    await openTodo();
    await openPane(TODO);
    const data = todoData();
    data.tasks[0].content = "Write report v2";
    data.tasks[0].description = "Check the totals twice.";
    await mock("todoist_load", data);
    await browser.execute((id) => window.__e2e_once__(id) && document.dispatchEvent(new Event("visibilitychange")), onceId());
    await browser.waitUntil(async () => (await textsOf(`${TODO.pane} .ho-card-title`))[0] === "Write report v2", { timeoutMsg: "the card did not take the new task" });
    const handoff = await mock("orca_handoff", started);
    await chooseProject(TODO, "example-app");
    await write(TODO, "直して");
    await sendButton(TODO).click();
    const [call] = (await waitForCalls(handoff)) as { context: { title: string; body: string } }[];
    expect(call.context.title).toBe("Write report v2");
    expect(call.context.body).toContain("タスク: Write report v2");
    expect(call.context.body).toContain("Check the totals twice.");
  });
});

// The history of a session (A-7) and the answer to a question in it (A-11), as the side pane draws them: the Orca screen shows terminals only (A-12).
describe("orca handoff: the session history", () => {
  const P = MAIL.pane;
  const items = `${P} .ho-items`;
  const statusLine = () => textsOf(`${P} .ho-chat-status`);
  const chatTexts = () => textsOf(`${items} > *`);
  const user = chatUser("u1", "Make the list narrower");
  const answer = chatAssistant("a1", "I will narrow the **list** pane.\n\n- first\n- second");
  const tools = (calls: [string, string][] = [["Read", "ts/orca.ts"], ["Edit", "ts/orca.ts"], ["Bash", "npm test"]], running: string | null = null) =>
    chatTools("t1", `ツールを ${calls.length} 回実行`, calls, running);
  const scrollBox = () => ({
    atBottom: () =>
      browser.execute((p) => {
        const b = document.querySelector(`${p} .ho-chat`)!;
        return b.scrollHeight - b.scrollTop - b.clientHeight < 2;
      }, P),
    top: () => browser.execute((p) => document.querySelector(`${p} .ho-chat`)!.scrollTop, P),
    set: (y: number) =>
      browser.execute(
        (p, v) => {
          document.querySelector(`${p} .ho-chat`)!.scrollTop = v;
        },
        P,
        y,
      ),
    offsetOf: (id: string) =>
      browser.execute((p, i) => document.querySelector(`${p} .ho-items [data-id="${i}"]`)!.getBoundingClientRect().top - document.querySelector(`${p} .ho-chat`)!.getBoundingClientRect().top, P, id),
  });
  const many = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => chatUser(`m${from + i}`, `message ${from + i}`));

  // The pane of the mail on the session it started in example-app (pane tab_new:leaf_9, terminal term_new), with its history asked for once. `rows` is what the list holds after the send.
  async function openSession(launched: OrcaStarted = started, rows = [...sample(), newRow()], fixtures: Record<string, unknown> = {}) {
    await openMail(fixtures);
    await mock("orca_handoff", launched);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "原因を調べて");
    await mock("orca_overview", orcaOverview(rows, worktrees()));
    await sendButton(MAIL).click();
    await waitForOpens(1);
  }

  // Forgets the session shown and hands the mail to a new session in example-api (its terminal is the one of the agent the list holds), whose history is asked for next (`times` opens in all).
  async function switchSession(times: number) {
    await $(`${P} [aria-label="閉じる"]`).click();
    await $(MAIL.button).click();
    await listRead(MAIL);
    await mock("orca_handoff", { paneKey: null, handle: "term_example-api" } satisfies OrcaStarted);
    await chooseProject(MAIL, "example-api");
    await write(MAIL, "こちらも");
    await sendButton(MAIL).click();
    await waitForOpens(times);
  }

  it("says it is loading until the first items come, and then nothing", async () => {
    await openSession();
    expect(await statusLine()).toEqual(["読み込んでいます…"]);
    await sendChat(chatStatus("live"));
    expect(await statusLine()).toEqual([""]);
    await sendChat(chatItems([user]));
    expect(await statusLine()).toEqual([""]);
  });

  it("draws the user's messages on the right, the agent's answers as Markdown and the tools as a folded line", async () => {
    await openSession();
    await sendChat(chatItems([user, answer, tools()]));
    expect(await textsOf(`${items} .orca-user`)).toEqual(["Make the list narrower"]);
    expect(await textsOf(`${items} .orca-assistant strong`)).toEqual(["list"]);
    expect(await textsOf(`${items} .orca-assistant li`)).toEqual(["first", "second"]);
    expect(await textsOf(`${items} .orca-tools-label`)).toEqual(["ツールを 3 回実行"]);
    await expect($(`${items} .orca-tools-btn`)).toHaveAttribute("aria-expanded", "false");
    await expect($(`${items} .orca-tool-list`)).not.toBeDisplayed();
    // The user's bubble is right-aligned; the agent's text starts at the left.
    const sides = await browser.execute((p) => {
      const chat = document.querySelector(`${p} .ho-chat`)!.getBoundingClientRect();
      const left = (selector: string) => document.querySelector(`${p} ${selector}`)!.getBoundingClientRect().left - chat.left;
      return { user: left(".orca-user"), assistant: left(".orca-assistant") };
    }, P);
    expect(sides.user).toBeGreaterThan(sides.assistant + 50);
  });

  it("shows the agent's question unfolded, with its choices, and whether it waits or what was answered", async () => {
    await openSession();
    await sendChat(chatItems([chatQuestion("q1", null, true)]));
    await expect($(`${items} .orca-question`)).toBeDisplayed();
    await expect($(`${items} .orca-question-text`)).toHaveText("Which one?");
    expect(await textsOf(`${items} .orca-question-label`)).toEqual(["First", "Second"]);
    expect(await textsOf(`${items} .orca-question-desc`)).toEqual(["the first way"]);
    await expect($(`${items} .orca-question-waiting`)).toHaveText("回答待ち");
    await expect($(`${items} .orca-question-answer`)).not.toExist();
    await sendChat(chatItems([chatQuestion("q1", "First", false)]));
    await expect($(`${items} .orca-question-answer`)).toHaveText("回答: First");
    await expect($(`${items} .orca-question-waiting`)).not.toExist();
  });

  // ---- answering a question (A-11) ----

  const options = () => $$(`${items} .orca-pick-option`);
  const pressedOptions = () => browser.execute((s) => [...document.querySelectorAll(`${s} .orca-pick-option`)].map((b) => b.getAttribute("aria-pressed")), items);
  const sendAnswer = () => $(`${items} .orca-pick-send`);
  const pickOption = async (n: number) => (await options())[n].click();
  // A single choice of two, then a multiple choice of three.
  const asking = () =>
    chatQuestions("q1", true, [
      ["Pick alpha?", false, ["Apple", "Avocado"]],
      ["Pick beta?", true, ["Banana", "Berry", "Bean"]],
    ]);
  const pressedAll = (...states: boolean[]) => states.map(String);
  const T = true;
  const F = false;

  it("draws a waiting question as choices, picks one of a single choice and any of a multiple choice, and sends nothing until the button is pressed", async () => {
    await openSession();
    const answerCall = await mock("orca_answer", null);
    await sendChat(chatItems([asking()]));
    await waitForCount(`${items} .orca-pick-option`, 5);
    expect(await textsOf(`${items} .orca-question-text`)).toEqual(["Pick alpha?", "Pick beta?"]);
    expect(await textsOf(`${items} .orca-question-label`)).toEqual(["Apple", "Avocado", "Banana", "Berry", "Bean"]);
    await expect($(`${items} .orca-question-waiting`)).toHaveText("回答待ち");
    await expect(sendAnswer()).toHaveText("回答を送る");
    expect(await pressedOptions()).toEqual(pressedAll(F, F, F, F, F));
    await expect(sendAnswer()).toBeDisabled();
    // A single choice holds one pick: picking another moves it.
    await pickOption(0);
    expect(await pressedOptions()).toEqual(pressedAll(T, F, F, F, F));
    await pickOption(1);
    expect(await pressedOptions()).toEqual(pressedAll(F, T, F, F, F));
    // Every question needs a pick before the button works.
    await expect(sendAnswer()).toBeDisabled();
    await pickOption(4);
    await expect(sendAnswer()).toBeEnabled();
    // A multiple choice toggles each choice, and no pick at all disables the button again.
    await pickOption(2);
    expect(await pressedOptions()).toEqual(pressedAll(F, T, T, F, T));
    await pickOption(2);
    await pickOption(4);
    expect(await pressedOptions()).toEqual(pressedAll(F, T, F, F, F));
    await expect(sendAnswer()).toBeDisabled();
    expect(await callsOf(answerCall)).toEqual([]);
  });

  it("sends the picks of every question to the terminal of the session with one command, and keeps the button off until the question stops waiting", async () => {
    await openSession();
    const answerCall = await mock("orca_answer", holds);
    await sendChat(chatItems([asking()]));
    await waitForCount(`${items} .orca-pick-option`, 5);
    await pickOption(1);
    await pickOption(4);
    await pickOption(2);
    await sendAnswer().click();
    expect(await waitForCalls(answerCall)).toEqual([
      {
        handle: "term_new",
        questions: [
          { text: "Pick alpha?", multi: false, options: ["Apple", "Avocado"], picks: [1] },
          { text: "Pick beta?", multi: true, options: ["Banana", "Berry", "Bean"], picks: [2, 0] },
        ],
        environment: null,
      },
    ]);
    // On its way: the button waits.
    await expect(sendAnswer()).toHaveText("送信中…");
    await expect(sendAnswer()).toBeDisabled();
    await release(answerCall, null);
    // The answer was taken, but the question still waits in the history: the button stays off.
    await browser.pause(200);
    await expect(sendAnswer()).toHaveText("送信中…");
    await expect(sendAnswer()).toBeDisabled();
    expect(await callsOf(answerCall)).toHaveLength(1);
    // The history shows the answer: the choices give way to it.
    await sendChat(chatItems([chatQuestion("q1", "Avocado", false)]));
    await waitForCount(`${items} .orca-pick-option`, 0);
    await expect($(`${items} .orca-question-answer`)).toHaveText("回答: Avocado");
    expect(await count(`${items} .orca-pick-send`)).toBe(0);
    expect(await count(`${items} .orca-question-waiting`)).toBe(0);
  });

  it("keeps the picks when the timeline is drawn again, and a session shown next starts with none", async () => {
    await openSession();
    await sendChat(chatItems([asking()]));
    await waitForCount(`${items} .orca-pick-option`, 5);
    await pickOption(0);
    await pickOption(3);
    await pickOption(4);
    await sendChat(chatItems([asking(), chatAssistant("a2", "Waiting for you")]));
    await waitForCount(`${items} .orca-assistant`, 1);
    expect(await pressedOptions()).toEqual(pressedAll(T, F, F, T, T));
    await expect(sendAnswer()).toBeEnabled();
    await switchSession(2);
    await sendChat(chatItems([asking()]));
    await waitForCount(`${items} .orca-pick-option`, 5);
    expect(await pressedOptions()).toEqual(pressedAll(F, F, F, F, F));
  });

  it("shows the message of a failed answer in the question, with the picks kept and the button back", async () => {
    await openSession();
    const answerCall = await mock("orca_answer", rejects("質問が画面に出ていません。ターミナルで答えてください"));
    await sendChat(chatItems([asking()]));
    await waitForCount(`${items} .orca-pick-option`, 5);
    await pickOption(0);
    await pickOption(3);
    await sendAnswer().click();
    await waitForCalls(answerCall);
    await expect($(`${items} .orca-pick .pending.fail`)).toHaveText("質問が画面に出ていません。ターミナルで答えてください");
    expect(await pressedOptions()).toEqual(pressedAll(T, F, F, T, F));
    await expect(sendAnswer()).toHaveText("回答を送る");
    await expect(sendAnswer()).toBeEnabled();
    // Pressing again tries again, and the message goes.
    await mock("orca_answer", null);
    await sendAnswer().click();
    await waitForCalls("orca_answer");
    await expect(sendAnswer()).toHaveText("送信中…");
    expect(await count(`${items} .orca-pick .pending.fail`)).toBe(0);
  });

  it("draws nothing of an answer that fails after another session was shown, and leaves that session's picks", async () => {
    await openSession();
    const answerCall = await mock("orca_answer", holds);
    await sendChat(chatItems([asking()]));
    await waitForCount(`${items} .orca-pick-option`, 5);
    await pickOption(0);
    await pickOption(3);
    await sendAnswer().click();
    await waitForCalls(answerCall);
    await switchSession(2);
    await sendChat(chatItems([asking()]));
    await waitForCount(`${items} .orca-pick-option`, 5);
    await pickOption(1);
    await release(answerCall, rejects("質問が画面に出ていません。ターミナルで答えてください"));
    await browser.pause(200);
    expect(await count(`${items} .orca-pick .pending.fail`)).toBe(0);
    expect(await pressedOptions()).toEqual(pressedAll(F, T, F, F, F));
    await expect(sendAnswer()).toHaveText("回答を送る");
  });

  it("sends the answer to the saved environment of the session", async () => {
    await openSession(started, [...sample(), newRow()], { orca_overview: orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }) });
    const answerCall = await mock("orca_answer", null);
    await sendChat(chatItems([chatQuestion("q1", null, true)]));
    await waitForCount(`${items} .orca-pick-option`, 2);
    await pickOption(0);
    await sendAnswer().click();
    expect(await waitForCalls(answerCall)).toEqual([{ handle: "term_new", questions: [{ text: "Which one?", multi: false, options: ["First", "Second"], picks: [0] }], environment: "Studio" }]);
  });

  it("says so when the session has no terminal, and sends nothing", async () => {
    await openSession({ paneKey: "tab_new:leaf_9", handle: null }, [...sample(), { ...newRow(), handle: null }]);
    const answerCall = await mock("orca_answer", null);
    await sendChat(chatItems([chatQuestion("q2", null, true)]));
    await waitForCount(`${items} .orca-pick-option`, 2);
    await pickOption(1);
    await sendAnswer().click();
    await expect($(`${items} .orca-pick .pending.fail`)).toHaveText("このセッションには送れません");
    expect(await callsOf(answerCall)).toEqual([]);
    await expect(sendAnswer()).toBeEnabled();
  });

  it("draws no choices for a question that is answered, or that has a question with no choices", async () => {
    await openSession();
    await sendChat(chatItems([chatQuestion("q1", "First", false), chatQuestions("q2", true, [["Why?", false, []]])]));
    await waitForCount(`${items} .orca-question`, 2);
    expect(await count(`${items} .orca-pick-option`)).toBe(0);
    expect(await count(`${items} .orca-pick-send`)).toBe(0);
    await expect($(`${items} .orca-question-answer`)).toHaveText("回答: First");
    await expect($(`${items} .orca-question-waiting`)).toHaveText("回答待ち");
  });

  it("rules the cells of a table in the agent's answer", async () => {
    await openSession();
    await sendChat(chatItems([chatAssistant("a1", "| a | b |\n|---|---|\n| 1 | 2 |")]));
    await expect($(`${items} .orca-assistant td`)).toExist();
    for (const cell of ["th", "td"]) {
      const border = await browser.execute((s) => getComputedStyle(document.querySelector(s)!).borderTopWidth, `${items} .orca-assistant ${cell}`);
      expect(border).toBe("1px");
    }
  });

  it("does not load a remote image of the agent's answer", async () => {
    await openSession();
    await sendChat(chatItems([chatAssistant("a1", "![logo](https://example.com/logo.png) is shown")]));
    expect(await textsOf(`${items} .orca-assistant`)).toEqual(["logo is shown"]);
    await expect($(`${items} img`)).not.toExist();
  });

  it("replaces the timeline from the index an event names", async () => {
    await openSession();
    await sendChat(chatItems([user, chatAssistant("a1", "Narrowing now."), tools()]));
    await sendChat(chatItems([chatAssistant("a2", "Done."), chatUser("u2", "Thanks")], 2));
    expect(await chatTexts()).toEqual(["Make the list narrower", "Narrowing now.", "Done.", "Thanks"]);
    // From the start, and shorter: the rest is dropped.
    await sendChat(chatItems([chatUser("u3", "Only one")]));
    expect(await chatTexts()).toEqual(["Only one"]);
  });

  it("folds and unfolds the tool calls, and keeps a run open while it grows and the timeline is drawn again", async () => {
    await openSession();
    const button = () => $(`${items} .orca-tools-btn`);
    const list = () => $(`${items} .orca-tool-list`);
    await sendChat(chatItems([user, tools([["Read", "ts/orca.ts"]])]));
    await button().click();
    await expect(button()).toHaveAttribute("aria-expanded", "true");
    expect(await textsOf(`${items} .orca-tool-call`)).toEqual(["Read  ts/orca.ts"]);
    // The run grows (the same id, drawn again from its index): it stays open.
    await sendChat(chatItems([tools([["Read", "ts/orca.ts"], ["Bash", "npm test"], ["TodoWrite", ""]])], 1));
    await expect(button()).toHaveAttribute("aria-expanded", "true");
    await expect(list()).toBeDisplayed();
    expect(await textsOf(`${items} .orca-tool-call`)).toEqual(["Read  ts/orca.ts", "Bash  npm test", "TodoWrite"]);
    // A whole redraw keeps it too.
    await sendChat(chatItems([user, tools([["Read", "ts/orca.ts"], ["Bash", "npm test"], ["TodoWrite", ""]])]));
    await expect(list()).toBeDisplayed();
    await button().click();
    await expect(button()).toHaveAttribute("aria-expanded", "false");
    await expect(list()).not.toBeDisplayed();
    await sendChat(chatItems([tools([["Read", "ts/orca.ts"]])], 1));
    await expect(button()).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the running summary of a run still going while the agent is working, and the summary when it is not", async () => {
    await openSession();
    await sendChat(chatItems([tools([["Edit", "ts/orca.ts"]], "ツールを実行中")]));
    expect(await textsOf(`${items} .orca-tools-label`)).toEqual(["ツールを実行中"]);
    // The agent is done now: the read after a follow-up says so, and the label is the summary.
    const overview = await mock("orca_overview", orcaOverview([...sample(), { ...newRow(), group: "done", status: "done" }], worktrees()));
    await mock("orca_send", null);
    await field(MAIL).setValue("続けて");
    await sendButton(MAIL).click();
    await waitForCalls(overview);
    await browser.waitUntil(async () => (await textsOf(`${items} .orca-tools-label`))[0] === "ツールを 1 回実行", { timeoutMsg: "the label never became the summary" });
  });

  it("shows a run with no running summary by its summary even while the agent works", async () => {
    await openSession();
    await sendChat(chatItems([tools()]));
    expect(await textsOf(`${items} .orca-tools-label`)).toEqual(["ツールを 3 回実行"]);
  });

  it("shows the reconnecting and unavailable messages above the chat, and takes them away when the read is live", async () => {
    await openSession();
    await sendChat(chatItems([user]));
    await sendChat(chatStatus("reconnecting", "Orca に接続できません。つなぎ直しています"));
    expect(await statusLine()).toEqual(["Orca に接続できません。つなぎ直しています"]);
    await expect($(`${P} .ho-chat-status .pending`)).toBeDisplayed();
    // What was drawn stays.
    expect(await chatTexts()).toEqual(["Make the list narrower"]);
    await sendChat(chatStatus("unavailable", "このセッションの履歴は読めません"));
    expect(await statusLine()).toEqual(["このセッションの履歴は読めません"]);
    await sendChat(chatStatus("live"));
    expect(await statusLine()).toEqual([""]);
  });

  it("shows the message of a history that could not be opened", async () => {
    await openMail();
    await mock("orca_chat_open", rejects("エージェントの場所が正しくありません"));
    await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "原因を調べて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await waitForOpens();
    await browser.waitUntil(async () => (await statusLine())[0] === "エージェントの場所が正しくありません", { timeoutMsg: "the message never showed" });
  });

  it("pauses the history read while the window is hidden, and resumes it when shown", async () => {
    await openSession();
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
    await setHidden(true);
    expect(await waitForCalls(pause)).toEqual([{ paused: true }]);
    await setHidden(false);
    expect(await waitForCalls(pause, 2)).toEqual([{ paused: true }, { paused: false }]);
  });

  it("ignores the events of a channel that is no longer the current one", async () => {
    await openSession();
    await switchSession(2);
    await sendChat(chatItems([chatUser("old", "From the first session")]), 0);
    expect(await chatTexts()).toEqual([]);
    await sendChat(chatItems([chatUser("new", "From the second session")]), 1);
    expect(await chatTexts()).toEqual(["From the second session"]);
  });

  it("scrolls to the bottom when a session is opened, and stays at the bottom as items arrive", async () => {
    await openSession();
    await sendChat(chatItems(many(0, 40)));
    expect(await scrollBox().atBottom()).toBe(true);
    expect(await scrollBox().top()).toBeGreaterThan(0);
    await sendChat(chatItems(many(40, 43), 40));
    expect(await scrollBox().atBottom()).toBe(true);
  });

  it("does not move the scroll position when items arrive while it is scrolled up", async () => {
    await openSession();
    await sendChat(chatItems(many(0, 40)));
    await scrollBox().set(300);
    const before = await scrollBox().offsetOf("m10");
    await sendChat(chatItems(many(40, 43), 40));
    expect(await scrollBox().top()).toBeCloseTo(300, 0);
    expect(await scrollBox().offsetOf("m10")).toBeCloseTo(before, 0);
    expect(await scrollBox().atBottom()).toBe(false);
  });

  it("offers older history while there is more, reads it on a press, and keeps the message in view where it is when it arrives", async () => {
    await openSession();
    const older = await mock("orca_chat_older", null);
    const olderButton = () => $(`${P} .ho-older`);
    await expect(olderButton()).not.toBeDisplayed();
    await sendChat(chatItems(many(10, 50), 0, true));
    await expect(olderButton()).toBeDisplayed();
    await expect(olderButton()).toHaveText("以前の履歴を読む");
    await scrollBox().set(400);
    await olderButton().click();
    expect(await waitForCalls(older)).toEqual([null]);
    // Measured after the press: the button is at the top of the list, so the driver scrolls up to it.
    const before = await scrollBox().offsetOf("m20");
    // The older page arrives as a redraw from the start with no more to read.
    await sendChat(chatItems(many(0, 50), 0, false));
    await expect(olderButton()).not.toBeDisplayed();
    // scrollTop moves in whole pixels.
    expect(Math.abs((await scrollBox().offsetOf("m20")) - before)).toBeLessThan(2);
    expect(await textsOf(`${items} > *`)).toHaveLength(50);
  });
});

describe("orca handoff: attached files (A-10)", () => {
  const dropped = (repo: string, name = "shot.png") => `/work/${repo}/.orca/drops/${name}`;
  // What `orca_attach_file` answers for an image: the path with its blank, to be pasted as a bracketed paste.
  const attached = (repo: string, name = "shot.png") => ({ text: `${dropped(repo, name)} `, bracketed: true });
  // What it answers for any other file: the path in quotes with its blank.
  const attachedNote = (repo: string, name = "notes.txt") => ({ text: `'${dropped(repo, name)}' `, bracketed: false });
  const thumbs = () => count(`${MAIL.pane} .attachment`);
  const paste = (...files: Parameters<typeof fire>[2]) => fire("paste", `${MAIL.pane} textarea`, files);
  const drop = (...files: Parameters<typeof fire>[2]) => fire("drop", MAIL.pane, files);

  it("takes a pasted image as a thumbnail with a button to remove it, and leaves a paste of text alone", async () => {
    await openMail();
    await openPane(MAIL);
    await expect($(`${MAIL.pane} .attachments`)).not.toBeDisplayed();
    expect(await paste()).toBe(false);
    expect(await thumbs()).toBe(0);
    expect(await paste(image())).toBe(true);
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    await expect($(`${MAIL.pane} .attachments`)).toBeDisplayed();
    await expect($(`${MAIL.pane} .attachment img`)).toHaveAttribute("alt", "shot.png");
    expect(await $(`${MAIL.pane} .attachment img`).getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    await $(`${MAIL.pane} button[aria-label="shot.png を外す"]`).click();
    await waitForCount(`${MAIL.pane} .attachment`, 0);
    await expect($(`${MAIL.pane} .attachments`)).not.toBeDisplayed();
  });

  it("takes images dropped on the pane and cancels the dragover that carries a file", async () => {
    await openMail();
    await openPane(MAIL);
    expect(await fire("dragover", MAIL.pane, [image()])).toBe(true);
    expect(await fire("dragover", MAIL.pane, [])).toBe(false);
    expect(await drop(image("a.png"), image("b.png"))).toBe(true);
    await waitForCount(`${MAIL.pane} .attachment`, 2);
    expect(await browser.execute((p) => [...document.querySelectorAll(`${p} .attachment img`)].map((i) => (i as HTMLImageElement).alt), MAIL.pane)).toEqual(["a.png", "b.png"]);
  });

  it("shows a file that is not an image by its name, takes it by paste and by drop, and removes it with its button", async () => {
    await openMail();
    await openPane(MAIL);
    expect(await paste(note)).toBe(true);
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    await expect($(`${MAIL.pane} .attachment .attachment-name`)).toHaveText("notes.txt");
    expect(await count(`${MAIL.pane} .attachment img`)).toBe(0);
    await drop(image("a.png"), { ...note, name: "<b>b</b>.txt" });
    await waitForCount(`${MAIL.pane} .attachment`, 3);
    expect(await textsOf(`${MAIL.pane} .attachment .attachment-name`)).toEqual(["notes.txt", "<b>b</b>.txt"]);
    expect(await count(`${MAIL.pane} .attachment .attachment-name b`)).toBe(0);
    expect(await count(`${MAIL.pane} .attachment img`)).toBe(1);
    await $(`${MAIL.pane} button[aria-label="notes.txt を外す"]`).click();
    await waitForCount(`${MAIL.pane} .attachment`, 2);
    expect(await textsOf(`${MAIL.pane} .attachment .attachment-name`)).toEqual(["<b>b</b>.txt"]);
  });

  it("puts a file that is not an image in the worktree of the chosen project and hands over its quoted path with the instruction", async () => {
    await openMail();
    const attach = await mock("orca_attach_file", attachedNote("example-app"));
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "これを読んで");
    await paste(note);
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.instruction).toBe("これを読んで");
    expect(call.files).toEqual([`'${dropped("example-app", "notes.txt")}' `]);
    expect(await callsOf(attach)).toEqual([{ path: "/work/example-app", name: "notes.txt", data: btoa("hello"), environment: null }]);
  });

  it("refuses a file over 20 MiB with the message when it is taken, keeping the text, without calling the command", async () => {
    await openMail();
    const attach = await mock("orca_attach_file", attached("example-app"));
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await field(MAIL).setValue("見て");
    await paste(huge);
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("ファイルは 20 MiB までです");
    await expect(field(MAIL)).toHaveValue("見て");
    expect(await thumbs()).toBe(0);
    expect(await callsOf(attach)).toEqual([]);
    expect(await callsOf(handoff)).toEqual([]);
  });

  it("does not take a file dropped outside the pane, and does not let the webview navigate to it", async () => {
    await openMail();
    await openPane(MAIL);
    const before = await browser.execute(() => location.href);
    expect(await fire("dragover", "document", [image()])).toBe(true);
    expect(await fire("drop", "document", [image()])).toBe(true);
    expect(await fire("drop", "#thread-subject", [image()])).toBe(true);
    expect(await fire("drop", "document", [])).toBe(false);
    expect(await browser.execute(() => location.href)).toBe(before);
    expect(await thumbs()).toBe(0);
  });

  it("does not enable the button for an image alone: a hand-over needs the instruction", async () => {
    await openMail();
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await expect(sendButton(MAIL)).toBeDisabled();
    await paste(image());
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    await expect(sendButton(MAIL)).toBeDisabled();
    await field(MAIL).setValue("見て");
    await expect(sendButton(MAIL)).toBeEnabled();
  });

  it("puts each image in the worktree of the chosen project and the target, then hands over the instruction with the paths", async () => {
    await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { target: "Studio", environments: ["Studio"] }) });
    const attach = await mock("orca_attach_file", attached("example-app"));
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    const ask = await write(MAIL, "この画面を直して");
    await paste(image("shot.png"));
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.destination).toEqual({ kind: "new", path: "/work/example-app" });
    expect(call.instruction).toBe("この画面を直して");
    expect(call.summary).toEqual(POINTS);
    // Claude is sent the content alone, not the instruction or the files.
    expect(Object.keys(((await callsOf(ask)) as Asked[])[0])).toEqual(["context"]);
    expect(call.files).toEqual([`${dropped("example-app")} `]);
    expect(call.environment).toBe("Studio");
    expect(await callsOf(attach)).toEqual([{ path: "/work/example-app", name: "shot.png", data: PNG, environment: "Studio" }]);
  });

  it("puts an image in the worktree of the destination chosen in the pane, to that destination", async () => {
    await openMail({ orca_overview: orcaOverview(sample(), worktrees(), { environments: ["Lab"] }) });
    await mock("orca_destination", orcaOverview([], [orcaWorktree("example-lab", "main")], { target: "Lab", environments: ["Lab"], known: false }));
    const attach = await mock("orca_attach_file", attached("example-lab"));
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await $(`${MAIL.pane} .ho-destination`).click();
    await $('//div[@role="menu"]//button[normalize-space(.)="Lab"]').click();
    await browser.waitUntil(async () => (await textsOf(`${MAIL.pane} .ho-destination`))[0] === "Lab", { timeoutMsg: "the destination was not shown" });
    await expect($(`${MAIL.pane} .ho-project`)).toBeEnabled();
    await chooseProject(MAIL, "example-lab");
    await write(MAIL, "見て");
    await paste(image("shot.png"));
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.files).toEqual([`${dropped("example-lab")} `]);
    expect(call.environment).toBe("Lab");
    expect(await callsOf(attach)).toEqual([{ path: "/work/example-lab", name: "shot.png", data: PNG, environment: "Lab" }]);
  });

  it("hands over the paths of the files, one on each line in order", async () => {
    await openMail();
    const attach = await mock("orca_attach_file", attached("example-app", "first.png"));
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "見て");
    await drop(image("first.png"), image("second.png"));
    await waitForCount(`${MAIL.pane} .attachment`, 2);
    await sendButton(MAIL).click();
    const [call] = (await waitForCalls(handoff)) as Handed[];
    expect(call.instruction).toBe("見て");
    expect(call.files).toEqual([`${dropped("example-app", "first.png")} `, `${dropped("example-app", "first.png")} `]);
    expect((await callsOf(attach)).map((c) => (c as { name: string }).name)).toEqual(["first.png", "second.png"]);
  });

  it("keeps the instruction and the images and hands over nothing when an image cannot be put, and does not put it again after a failed handoff", async () => {
    await openMail();
    const attach = await mock("orca_attach_file", rejects("Orca がエラーを返しました（forbidden）"));
    const handoff = await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "見て");
    await paste(image());
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    await sendButton(MAIL).click();
    await waitForCalls(attach);
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("Orca がエラーを返しました（forbidden）");
    await expect(field(MAIL)).toHaveValue("見て");
    expect(await thumbs()).toBe(1);
    expect(await callsOf(handoff)).toEqual([]);
    // The image goes this time, and the handoff fails: the next press does not put the image again.
    await mock("orca_attach_file", attached("example-app"));
    await mock("orca_handoff", rejects("Orca が指示を受け付けませんでした"));
    await sendButton(MAIL).click();
    await expect($(`${MAIL.pane} .ho-form .pending.fail`)).toHaveText("Orca が指示を受け付けませんでした");
    expect(await callsOf("orca_attach_file")).toHaveLength(1);
    const again = await mock("orca_handoff", started);
    await sendButton(MAIL).click();
    expect(await waitForCalls(again)).toHaveLength(1);
    expect(await callsOf("orca_attach_file")).toHaveLength(1);
  });

  it("keeps an image whose read was still running when the send began", async () => {
    await openMail();
    await mock("orca_attach_file", attached("example-app"));
    const handoff = await mock("orca_handoff", holds);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "見て");
    await paste(image("first.png"));
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    // The paste and the press happen in one turn of the page: the second image is read after the send has begun.
    await browser.execute(
      (pane, sendSelector, base64) => {
        const file = new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "second.png", { type: "image/png" });
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { files: [file], types: ["Files"], getData: () => "" } });
        document.querySelector(`${pane} textarea`)!.dispatchEvent(event);
        (document.querySelector(sendSelector) as HTMLElement).click();
      },
      MAIL.pane,
      `${MAIL.pane} .ho-form .text-btn.primary`,
      PNG,
    );
    await waitForCalls(handoff);
    await release(handoff, started);
    await expect($(`${MAIL.pane} .ho-session-name`)).toExist();
    expect(await browser.execute((p) => [...document.querySelectorAll(`${p} .attachment img`)].map((i) => (i as HTMLImageElement).alt), MAIL.pane)).toEqual(["second.png"]);
  });

  it("adds the paths to a follow-up of the session shown, and puts the image in its worktree", async () => {
    await openMail();
    await mock("orca_handoff", started);
    await openPane(MAIL);
    await chooseProject(MAIL, "example-app");
    await write(MAIL, "始めて");
    await mock("orca_overview", orcaOverview([...sample(), newRow()], worktrees()));
    await sendButton(MAIL).click();
    await expect($(`${MAIL.pane} .ho-session-name`)).toHaveText("example-app ・ feat/a");
    const attach = await mock("orca_attach_file", attached("example-app"));
    const post = await mock("orca_send", null);
    await field(MAIL).setValue("続けて");
    await paste(image());
    await waitForCount(`${MAIL.pane} .attachment`, 1);
    await sendButton(MAIL).click();
    expect(await waitForCalls(post)).toEqual([{ handle: "term_new", text: `続けて\n\n${dropped("example-app")}`, environment: null }]);
    expect(await callsOf(attach)).toEqual([{ path: "/work/example-app", name: "shot.png", data: PNG, environment: null }]);
    await waitForCount(`${MAIL.pane} .attachment`, 0);
    await expect(field(MAIL)).toHaveValue("");
  });
});
