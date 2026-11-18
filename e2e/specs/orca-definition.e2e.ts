import type { LspFound } from "../../ts/bindings/LspFound";
import type { LspLaunch } from "../../ts/bindings/LspLaunch";
import type { LspLocation } from "../../ts/bindings/LspLocation";
import type { LspPlace } from "../../ts/bindings/LspPlace";
import type { LspRepoSettings } from "../../ts/bindings/LspRepoSettings";
import type { LspServerSettings } from "../../ts/bindings/LspServerSettings";
import type { LspStatus } from "../../ts/bindings/LspStatus";
import type { OrcaDir } from "../../ts/bindings/OrcaDir";
import type { OrcaFileText } from "../../ts/bindings/OrcaFileText";
import type { PaneLayout } from "../../ts/bindings/PaneLayout";
import type { PaneNode } from "../../ts/bindings/PaneNode";
import { callsOf, count, emitEvent, holds, mock, onceId, orcaWorktree, rejects, release, textsOf, timers, waitForCalls, waitForCount } from "../support";
import { claudeTab, filesToggle, openOrca, orcaOverview, project, sample, selectedTab, showAgain, studio, tabOf, tabTitles, worktrees } from "../orca-support";

// A-34: the definition tab under the pane of the editor, and the editor's Command and right button. Rust asks the language server, reads the name under the mouse and decides how each place is drawn (unit tests); here the screen is checked: what it asks of Rust for a press, how it splits the work pane, and how it draws the answers and opens them. The language server in the file pane is checked below too: its state and settings, and when it is started and stopped.
describe("orca: definition (A-34)", () => {
  const dirOf = (entries: [string, boolean][]): OrcaDir => ({ entries: entries.map(([name, isDirectory]) => ({ name, path: name, isDirectory, ignored: false, icon: null })), total: entries.length });
  const root = () =>
    dirOf([
      ["a.rb", false],
      ["notes.txt", false],
    ]);
  const text = (content: string, language = "ruby", highlight: string | null = language): OrcaFileText => ({ content, crlf: false, signature: "sig-1", language, highlight });
  const source = "class A\n  def go\n    Rails.logger.info(x)\n  end\nend\n";
  const worktree = "/work/example-app";
  // Where the three places are: one in the worktree, and two in gems.
  const inside: LspLocation = { path: "app/lib/rails_ext.rb", outside: false, line: 6, character: 2 };
  const gem: LspLocation = { path: "/usr/local/bundle/gems/railties-8.1.4.1/lib/rails.rb", outside: true, line: 18, character: 0 };
  const other: LspLocation = { path: "/usr/local/bundle/gems/actioncable-8.1.4.1/lib/rails/generators/channel/channel_generator.rb", outside: true, line: 2, character: 0 };
  const insidePlace: LspPlace = { file: "rails_ext.rb", line: 7, place: "app/lib", outside: false, language: "ruby" };
  const gemPlace: LspPlace = { file: "rails.rb", line: 19, place: "railties 8.1.4.1 / lib", outside: true, language: "ruby" };
  const otherPlace: LspPlace = { file: "channel_generator.rb", line: 3, place: "actioncable 8.1.4.1 / lib/rails/generators/channel", outside: true, language: "ruby" };
  // A file of `n` lines, "row 1" to "row n".
  const rows = (n: number) => `${Array.from({ length: n }, (_, i) => `row ${i + 1}`).join("\n")}\n`;

  // The layouts that `orca_panes` answers: the pane of the editor (p1) with the tabs given, and the definition tab alone in the pane below it (p2).
  const claude = claudeTab("example-app");
  const pane = (id: string, tabs: string[], selected = tabs[0]): PaneNode => ({ kind: "pane", id, tabs, selected });
  const below = (top: string[], selected: string, focus = "p2"): PaneLayout => ({ root: { kind: "split", direction: "column", children: [pane("p1", top, selected), pane("p2", ["definition:1"])], sizes: [0.5, 0.5] }, focus });
  const moves = async () => (await callsOf("orca_panes")).map((c) => (c as { op: { kind: string } | null }).op).filter((op) => op?.kind === "move");
  const ops = async (kind: string) => (await callsOf("orca_panes")).map((c) => (c as { op: { kind: string } | null }).op).filter((op) => op?.kind === kind);

  // The app with the example-app project selected, the file pane open (`shown`) and its root read. The clock of the list is made very slow, so that no read of the open file comes between a press and the check of its result.
  // `lspSettings` is the period of the read of the language servers' settings (very slow, so that no read comes between a press and the check of its result).
  async function openFiles(shown = true, lspSettings = 600000) {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_terminal_read: ["$"], orca_files_list: root(), orca_files_ignored: [], editor_settings: { autosaveMs: 100 }, ...timers({ orcaClock: 600000, lspSettings }) });
    await project("example-app").click();
    await expect(selectedTab()).toBeDisplayed();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 2);
    if (!shown) await filesToggle().click();
  }

  const doublePress = (path: string) =>
    browser.execute(
      (p, once) => {
        if (!window.__e2e_once__(once)) return;
        document.querySelector(`.orca-file[data-path="${p}"]`)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      },
      path,
      onceId(),
    );
  // Opens the file of the tree with the answer of the read, and waits for its text and its colors (highlight.js is read the first time a file is colored).
  async function openFileWith(path: string, read: OrcaFileText) {
    await mock("orca_file_read", read);
    await doublePress(path);
    await expect($(".orca-edit-area")).toHaveValue(read.content, { trim: false });
    if (read.highlight) {
      await browser.waitUntil(() => browser.execute("return typeof hljs !== 'undefined'"), { timeoutMsg: "highlight.js was never read" });
      await browser.execute("return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
    }
  }

  // The page's own `contextmenu` event on the text, at the middle of the character at `offset` of its text (`dx` moves the point to the right), with or without the Command key. Whether the event was left to the default menu is read after it (`prevented`).
  const contextAt = (offset: number, meta = true, dx = 0) =>
    browser.execute(
      (o, withMeta, shift, once) => {
        if (!window.__e2e_once__(once)) return;
        const walker = document.createTreeWalker(document.querySelector(".orca-edit-hl code")!, NodeFilter.SHOW_TEXT);
        let left = o;
        for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
          if (left >= node.length) {
            left -= node.length;
            continue;
          }
          const range = document.createRange();
          range.setStart(node, left);
          range.setEnd(node, left + 1);
          const box = range.getBoundingClientRect();
          const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, metaKey: withMeta, clientX: box.left + box.width / 2 + shift, clientY: box.top + box.height / 2 });
          (window as unknown as { __e2e_prevented__: boolean }).__e2e_prevented__ = !document.querySelector(".orca-edit-area")!.dispatchEvent(event);
          return;
        }
      },
      offset,
      meta,
      dx,
      onceId(),
    );
  const prevented = () => browser.execute(() => (window as unknown as { __e2e_prevented__?: boolean }).__e2e_prevented__);
  // The offset of the 'i' of "Rails" in the source: the third character of the name.
  const onRails = () => source.indexOf("Rails") + 2;

  // The three places, answered for the press on "Rails", and what their lines are read from: a file of the worktree of 12 lines, and the two gems of 30.
  async function answer(locations: LspLocation[] = [inside, gem, other], places: LspPlace[] = [insidePlace, gemPlace, otherPlace]) {
    await mock("lsp_word", "Rails");
    await mock("lsp_definition", locations);
    await mock("lsp_places", places);
    await mock("orca_file_read", text(rows(12)));
    await mock("lsp_read_outside", { path: gem.path, text: rows(30), language: "ruby", highlight: "ruby" });
  }
  // Opens a.rb, answers, makes `orca_panes` answer the split with the definition tab below, and presses on "Rails" with the Command key.
  async function define(locations?: LspLocation[], places?: LspPlace[], shown = true) {
    await openFiles(shown);
    await openFileWith("a.rb", text(source));
    await answer(locations, places);
    await mock("orca_panes", below([claude, "file:1"], "file:1"));
    await contextAt(onRails());
    await expect(tabOf("definition:1")).toBeExisting();
  }
  // Where the caret is in `content` for the line from 0 and the character.
  const caretOf = (content: string, line: number, character: number) => content.split("\n").slice(0, line).reduce((n, l) => n + l.length + 1, 0) + character;
  const caret = () => browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.selectionStart);

  const mode = (label: string) => $(`#orca-files-bar [aria-label="${label}"]`);
  const defRow = (n: number) => $(`.orca-definition .orca-def[data-index="${n}"]`);
  const lineTexts = (n: number) => textsOf(`.orca-definition .orca-def[data-index="${n}"] .orca-def-line`);
  // The page's own press of the open button of the row `n`.
  const press = (n: number) =>
    browser.execute(
      (i, once) => {
        if (!window.__e2e_once__(once)) return;
        document.querySelector<HTMLElement>(`.orca-definition .orca-def[data-index="${i}"] .orca-def-open`)!.click();
      },
      n,
      onceId(),
    );

  it("asks where the mouse is, not the caret, with the text of the editor, and opens the definition tab without changing the file pane (A-34)", async () => {
    await openFiles();
    await openFileWith("a.rb", text(source));
    await answer();
    await mock("orca_panes", below([claude, "file:1"], "file:1"));
    // The caret is at the start; the press is on "Rails" (line 2, character 6).
    await browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.setSelectionRange(0, 0));
    await contextAt(onRails());
    expect(await waitForCalls("lsp_word")).toEqual([{ line: "    Rails.logger.info(x)", character: 6 }]);
    expect(await waitForCalls("lsp_definition")).toEqual([{ environment: null, worktree, server: "ruby", relative: "a.rb", text: source, line: 2, character: 6 }]);
    expect(await prevented()).toBe(true);
    await expect(tabOf("definition:1").$(".orca-tab-title")).toHaveText("定義 ・ Rails");
    await expect($('.orca-tab[data-definition="true"] .orca-file-tab-ic svg')).toBeExisting();
    await expect($("#orca-files-tree")).toBeDisplayed();
    await expect(mode("ファイル")).toHaveAttribute("aria-pressed", "true");
    await expect($("#orca-server")).not.toBeDisplayed();
  });

  it("sends the text that is typed and not saved yet, and a place in a later line and character (A-34)", async () => {
    await openFiles();
    await openFileWith("a.rb", text(source));
    await answer();
    const typed = `${source}x = Rails\n`;
    await mock("orca_file_write", { state: "saved", signature: "sig-2" });
    await browser.execute(
      (t, once) => {
        if (!window.__e2e_once__(once)) return;
        const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
        area.value = t;
        area.dispatchEvent(new Event("input", { bubbles: true }));
      },
      typed,
      onceId(),
    );
    await browser.pause(150);
    await contextAt(typed.lastIndexOf("Rails") + 4);
    const [call] = await waitForCalls("lsp_definition");
    expect(call).toEqual({ environment: null, worktree, server: "ruby", relative: "a.rb", text: typed, line: 5, character: 8 });
    expect(await callsOf("lsp_word")).toEqual([{ line: "x = Rails", character: 8 }]);
  });

  it("splits the work pane below the pane of the editor for a new definition tab, and shows it there (A-34, A-17)", async () => {
    await define();
    expect(await moves()).toEqual([{ kind: "move", tab: "definition:1", pane: "p1", edge: "bottom" }]);
    expect((await callsOf("orca_panes")).at(0)).toMatchObject({ tabs: [claude, "file:1", "definition:1"] });
    await waitForCount(".orca-pane", 2);
    await expect($('.orca-pane[data-pane="p2"] .orca-definition')).toBeDisplayed();
    await expect($('.orca-pane[data-pane="p1"] .orca-edit-area')).toBeDisplayed();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rb", "定義 ・ Rails"]);
  });

  it("shows the definition tab with the file pane hidden, and leaves the file pane hidden (A-34)", async () => {
    await define(undefined, undefined, false);
    await expect($("#orca-files")).not.toBeDisplayed();
    await expect($('.orca-pane[data-pane="p2"] .orca-definition')).toBeDisplayed();
  });

  it("draws the name and the count, and a row for each place with its path and line, its place, the gem mark and the open button (A-34)", async () => {
    await define();
    await waitForCount(".orca-definition .orca-def", 3);
    expect(await textsOf(".orca-definition-head > span")).toEqual(["Rails", "3 件"]);
    expect(await textsOf(".orca-definition .orca-def-file")).toEqual(["app/lib/rails_ext.rb:7", "rails.rb:19", "channel_generator.rb:3"]);
    expect(await textsOf(".orca-definition .orca-def-place")).toEqual(["railties 8.1.4.1 / lib", "actioncable 8.1.4.1 / lib/rails/generators/channel"]);
    expect(await textsOf(".orca-definition .orca-def-gem")).toEqual(["gem", "gem"]);
    expect(await count('.orca-definition .orca-def[data-index="0"] .orca-def-gem')).toBe(0);
    expect(await textsOf(".orca-definition .orca-def-open")).toEqual(["開く", "開く", "開く"]);
    expect(await count(".orca-definition .orca-def-toggle")).toBe(0);
    expect(await callsOf("lsp_places")).toEqual([{ locations: [inside, gem, other] }]);
  });

  it("opens every row from the start and reads each place once, a file of the worktree and a file outside it each in its own way (A-34)", async () => {
    await define();
    await waitForCount(".orca-definition .orca-def-line", 20);
    expect(await lineTexts(0)).toEqual(["4row 4", "5row 5", "6row 6", "7row 7", "8row 8", "9row 9", "10row 10"]);
    expect(await lineTexts(1)).toEqual(["16row 16", "17row 17", "18row 18", "19row 19", "20row 20", "21row 21", "22row 22"]);
    // A place near the start of its file is drawn from the first line.
    expect(await lineTexts(2)).toEqual(["1row 1", "2row 2", "3row 3", "4row 4", "5row 5", "6row 6"]);
    expect(await textsOf('.orca-definition .orca-def-line[data-hit="true"]')).toEqual(["7row 7", "19row 19", "3row 3"]);
    expect(await callsOf("orca_file_read")).toEqual([{ path: worktree, relative: "app/lib/rails_ext.rb", environment: null }]);
    expect(await callsOf("lsp_read_outside")).toEqual([
      { environment: null, project: "proj_example-app", worktree, server: "ruby", path: gem.path },
      { environment: null, project: "proj_example-app", worktree, server: "ruby", path: other.path },
    ]);
  });

  it("opens the only place at once too, with its count (A-34)", async () => {
    await define([inside], [insidePlace]);
    await waitForCount(".orca-definition .orca-def-line", 7);
    expect(await textsOf(".orca-definition-head > span")).toEqual(["Rails", "1 件"]);
  });

  it("says why the lines of a row cannot be shown, in the row, and the other rows stay (A-34)", async () => {
    await openFiles();
    await openFileWith("a.rb", text(source));
    await answer();
    await mock("lsp_read_outside", rejects("ファイルを読めません"));
    await mock("orca_panes", below([claude, "file:1"], "file:1"));
    await contextAt(onRails());
    await expect(defRow(1).$(".orca-file-note.fail")).toHaveText("ファイルを読めません");
    await expect(defRow(2).$(".orca-file-note.fail")).toHaveText("ファイルを読めません");
    await waitForCount(".orca-definition .orca-def-line", 7);
    expect(await count(".orca-definition .orca-def")).toBe(3);
  });

  it("puts the next definition in the same tab, wherever it is, and splits nothing again (A-34)", async () => {
    await define();
    await waitForCount(".orca-definition .orca-def", 3);
    await mock("lsp_definition", [gem]);
    await mock("lsp_places", [gemPlace]);
    await mock("lsp_word", "logger");
    const before = (await moves()).length;
    await contextAt(source.indexOf(".logger") + 3);
    await waitForCount(".orca-definition .orca-def", 1);
    expect(await textsOf(".orca-definition-head > span")).toEqual(["logger", "1 件"]);
    await expect(tabOf("definition:1").$(".orca-tab-title")).toHaveText("定義 ・ logger");
    expect(await count('.orca-tab[data-definition="true"]')).toBe(1);
    expect(await moves()).toHaveLength(before);
  });

  it("selects the tab when the pressed pane shows another tab of the project, in the pane it is in (A-34)", async () => {
    await define();
    await waitForCount(".orca-definition .orca-def", 3);
    // The focus goes back to the pane of the editor, which shows the definition tab nowhere.
    await mock("orca_panes", below([claude, "file:1"], "file:1", "p1"));
    await tabOf("file:1").$(".orca-tab-btn").click();
    await expect($('.orca-pane[data-pane="p1"] .orca-edit-area')).toBeDisplayed();
    await contextAt(onRails());
    expect(await waitForCalls("lsp_definition", 2)).toHaveLength(2);
    expect(await ops("select")).toEqual(expect.arrayContaining([{ kind: "select", tab: "definition:1" }]));
    expect(await moves()).toEqual([]);
    expect(await count('.orca-tab[data-definition="true"]')).toBe(1);
  });

  it("drops the answer of an older question, and draws the spinner while one is awaited (A-34)", async () => {
    await openFiles();
    await openFileWith("a.rb", text(source));
    await answer();
    await mock("lsp_definition", holds);
    await mock("orca_panes", below([claude, "file:1"], "file:1"));
    await contextAt(onRails());
    await waitForCalls("lsp_definition");
    await expect($(".orca-definition .pending")).toBeDisplayed();
    expect(await textsOf(".orca-definition-head > span")).toEqual(["Rails"]);
    await contextAt(onRails());
    await waitForCalls("lsp_definition", 2);
    await mock("lsp_places", [gemPlace]);
    await release("lsp_definition", [inside]);
    await release("lsp_definition", [gem]);
    await waitForCount(".orca-definition .orca-def", 1);
    expect(await textsOf(".orca-definition .orca-def-file")).toEqual(["rails.rb:19"]);
    expect(await callsOf("lsp_places")).toEqual([{ locations: [gem] }]);
  });

  it("closes with its button, and the pane it was alone in closes with it (A-34, A-17)", async () => {
    await define();
    await waitForCount(".orca-definition .orca-def", 3);
    await mock("orca_panes", { root: pane("p1", [claude, "file:1"], "file:1"), focus: "p1" });
    await tabOf("definition:1").$(".orca-tab-close").click();
    await expect(tabOf("definition:1")).not.toExist();
    await waitForCount(".orca-pane", 1);
    expect(await count(".orca-definition")).toBe(0);
  });

  it("opens a place in the worktree as an editor tab in the pane of the editor, with the caret at its line (A-34)", async () => {
    await define();
    await waitForCount(".orca-definition .orca-def", 3);
    const read = await mock("orca_file_read", text(rows(40), "ruby"));
    await mock("orca_panes", below([claude, "file:1", "file:2"], "file:2", "p1"));
    await press(0);
    expect(await waitForCalls(read)).toEqual([{ path: worktree, relative: "app/lib/rails_ext.rb", environment: null }]);
    expect(await moves()).toEqual([{ kind: "move", tab: "file:2", pane: "p1", edge: "center" }]);
    await expect($(".orca-edit-area")).toHaveValue(rows(40), { trim: false });
    expect(await tabTitles()).toEqual(expect.arrayContaining(["a.rb", "rails_ext.rb", "定義 ・ Rails"]));
    await expect($(".orca-edit-path")).toHaveText("app/lib/rails_ext.rb");
    await expect($('.orca-pane[data-pane="p1"] .orca-edit-area')).toBeDisplayed();
    await browser.waitUntil(async () => (await caret()) === caretOf(rows(40), 6, 2), { timeoutMsg: "the caret never went to the line of the definition" });
    expect(await count(".orca-tab-gem")).toBe(0);
  });

  it("selects a file that is open already where it is, and goes to the line in it (A-34)", async () => {
    await define([{ path: "a.rb", outside: false, line: 2, character: 4 }], [{ file: "a.rb", line: 3, place: ".", outside: false, language: "ruby" }]);
    await waitForCount(".orca-definition .orca-def", 1);
    await mock("orca_panes", below([claude, "file:1"], "file:1", "p1"));
    await press(0);
    await expect($(".orca-edit-area")).toHaveValue(source, { trim: false });
    expect(await moves()).toEqual([]);
    expect(await ops("select")).toEqual([{ kind: "select", tab: "file:1" }]);
    await browser.waitUntil(async () => (await caret()) === caretOf(source, 2, 4), { timeoutMsg: "the caret never went to the line" });
    expect(await count('.orca-tabs [data-file="true"]')).toBe(1);
  });

  it("opens a place outside the worktree as a read only tab with a lock and gem, read by lsp_read_outside, and saves nothing (A-34)", async () => {
    await define();
    await waitForCount(".orca-definition .orca-def", 3);
    const rails = rows(30);
    const read = await mock("lsp_read_outside", { path: gem.path, text: rails, language: "ruby", highlight: "ruby" });
    const write = await mock("orca_file_write", { state: "saved", signature: "sig-2" });
    await mock("orca_panes", below([claude, "file:1", "file:2"], "file:2", "p1"));
    await press(1);
    expect(await waitForCalls(read)).toEqual([{ environment: null, project: "proj_example-app", worktree, server: "ruby", path: gem.path }]);
    await expect($(".orca-edit-area")).toHaveValue(rails, { trim: false });
    await expect($(".orca-edit-area")).toHaveAttribute("readonly");
    await expect($(".orca-edit-path")).toHaveText(gem.path);
    await expect($(".orca-edit-state")).toHaveText("gem");
    await expect($(".orca-edit-lock")).toBeDisplayed();
    await expect($('.orca-tab[data-outside="true"] .orca-file-tab-ic[aria-label="読み取り専用"]')).toBeDisplayed();
    await expect($('.orca-tab[data-outside="true"] .orca-tab-gem')).toHaveText("gem");
    expect(await tabTitles()).toEqual(expect.arrayContaining(["rails.rb"]));
    // The caret goes to the line of the definition as in any file.
    await browser.waitUntil(async () => (await caret()) === caretOf(rails, 18, 0), { timeoutMsg: "the caret never went to the line of the definition" });
    await browser.pause(300);
    expect(await callsOf(write)).toEqual([]);
    // The tab closes with no question: there is nothing to save.
    await $('.orca-tab[data-outside="true"] .orca-tab-close').click();
    await expect($('.orca-tab[data-outside="true"]')).not.toExist();
  });

  it("shows the words Rust gives when the server cannot answer, with the name and no count (A-34)", async () => {
    await openFiles();
    await openFileWith("a.rb", text(source));
    await answer();
    await mock("lsp_definition", rejects("言語サーバーがまだ準備できていません"));
    await mock("orca_panes", below([claude, "file:1"], "file:1"));
    await contextAt(onRails());
    await expect($(".orca-definition .orca-file-note.fail")).toHaveText("言語サーバーがまだ準備できていません");
    expect(await textsOf(".orca-definition-head > span")).toEqual(["Rails"]);
    expect(await count(".orca-definition .orca-def")).toBe(0);
    expect(await callsOf("lsp_places")).toEqual([]);
  });

  it("says there is no definition when the server gives none (A-34)", async () => {
    await define([], []);
    await expect($(".orca-definition .orca-file-note")).toHaveText("定義はありません");
    expect(await textsOf(".orca-definition-head > span")).toEqual(["Rails", "0 件"]);
    expect(await callsOf("lsp_places")).toEqual([]);
  });

  it("asks for nothing without the Command key, and leaves the right button to the default menu (A-34)", async () => {
    await openFiles();
    await openFileWith("a.rb", text(source));
    await answer();
    await contextAt(onRails(), false);
    await browser.pause(300);
    expect(await prevented()).toBe(false);
    expect(await callsOf("lsp_word")).toEqual([]);
    expect(await callsOf("lsp_definition")).toEqual([]);
    expect(await count(".orca-definition")).toBe(0);
    await expect($("#orca-files-tree")).toBeDisplayed();
  });

  it("asks for nothing where the mouse is on no name or past the end of a line, and opens no tab (A-34)", async () => {
    await openFiles();
    await openFileWith("a.rb", text(source));
    await answer();
    // Far to the right of the last "end", on no character of the line.
    await contextAt(source.lastIndexOf("end"), true, 150);
    await browser.pause(300);
    expect(await callsOf("lsp_word")).toEqual([]);
    expect(await callsOf("lsp_definition")).toEqual([]);
    await mock("lsp_word", null);
    await contextAt(source.indexOf(".logger"));
    await waitForCalls("lsp_word");
    await browser.pause(300);
    expect(await callsOf("lsp_definition")).toEqual([]);
    expect(await count('.orca-tab[data-definition="true"]')).toBe(0);
  });

  it("asks for nothing in a file whose language no server takes, and leaves the default menu (A-34)", async () => {
    await openFiles();
    await mock("lsp_server_for", null);
    await openFileWith("notes.txt", text("Rails is here\n", "plaintext", null));
    await answer();
    await contextAt(2);
    await browser.pause(300);
    expect(await prevented()).toBe(false);
    expect(await callsOf("lsp_word")).toEqual([]);
    expect(await callsOf("lsp_definition")).toEqual([]);
    expect(await callsOf("lsp_server_for")).toEqual([{ environment: null, project: "proj_example-app", language: "plaintext" }]);
  });

  it("asks the server that takes the language of a file that is not Ruby (A-34)", async () => {
    await openFiles();
    await mock("lsp_server_for", "typescript");
    await openFileWith("notes.txt", text("const x = Rails;\n", "typescript", null));
    await answer();
    await mock("orca_panes", below([claude, "file:1"], "file:1"));
    await contextAt(11);
    expect(await waitForCalls("lsp_definition")).toEqual([{ environment: null, worktree, server: "typescript", relative: "notes.txt", text: "const x = Rails;\n", line: 0, character: 11 }]);
    expect(await callsOf("lsp_server_for")).toEqual([{ environment: null, project: "proj_example-app", language: "typescript" }]);
    expect(await prevented()).toBe(true);
    await expect(tabOf("definition:1")).toBeExisting();
  });

  it("keeps the definition tab when the part of the file pane is switched to the language server and back (A-34)", async () => {
    await define();
    await waitForCount(".orca-definition .orca-def", 3);
    await mode("言語サーバー").click();
    await expect($("#orca-server")).toBeDisplayed();
    await expect($("#orca-files-tree")).not.toBeDisplayed();
    await mode("ファイル").click();
    await expect($("#orca-files-tree")).toBeDisplayed();
    expect(await count(".orca-definition .orca-def")).toBe(3);
    expect(await callsOf("lsp_definition")).toHaveLength(1);
  });

  // ---- the language server in the file pane ----

  const repo = "proj_example-app";
  // The settings of a repository with nothing saved: the one server, ruby-lsp, of the language ruby. `extra` changes the repository (`environment`, `sshHost`) or that server (the rest).
  const unset = (extra: { environment?: string | null; sshHost?: string | null } & Partial<LspServerSettings> = {}): LspRepoSettings => {
    const { environment = null, sshHost = null, ...over } = extra;
    return { environment, project: repo, sshHost, servers: [{ language: "ruby", name: "ruby-lsp", autoStart: true, command: null, mount: null, service: null, ...over }] };
  };
  const ts: LspServerSettings = { language: "typescript", name: "ts", autoStart: true, command: null, mount: null, service: null };
  // The settings with a second server, ts.
  const two = (): LspRepoSettings => ({ ...unset(), servers: [...unset().servers, ts] });
  const composeCommand = "docker compose exec -T -w /application app bundle exec ruby-lsp";
  const composeLaunch = (extra: Partial<LspLaunch> = {}): LspLaunch => ({
    method: "compose",
    candidates: [{ service: "app", mount: "/application" }],
    service: "app",
    command: composeCommand,
    mount: "/application",
    ...extra,
  });
  const status = (state: LspStatus["state"], extra: Partial<LspStatus> = {}): LspStatus => ({ state, ...extra });
  const notStarted = status("stopped", { reason: "notStarted" });
  const down = status("stopped", { reason: "containerDown", message: "サービスのコンテナが動いていません" });
  // The event Rust sends at each change of the state of a server.
  const tell = (next: LspStatus, at = worktree, server = "ruby") => emitEvent("lsp-status", { environment: null, worktree: at, server, status: next });
  // Sets a field as the owner leaves it: its value (or, for a check box, its state) and the `change` event.
  const change = (id: string, value: string | boolean) =>
    browser.execute(
      (field, v, once) => {
        if (!window.__e2e_once__(once)) return;
        const el = document.getElementById(field) as HTMLInputElement;
        if (typeof v === "boolean") el.checked = v;
        else el.value = v;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      id,
      value,
      onceId(),
    );
  // The card of the server of a language (its `data-name` is the language), and of a language that the worktree has and the repository has no server of (`data-kind="found"`: dotted).
  const card = (language: string) => $(`.orca-lsp-card[data-name="${language}"]`);
  const stateText = (language = "ruby") => card(language).$(".orca-lsp-state");
  const dot = (language = "ruby") => card(language).$(".orca-lsp-dot");
  const noteOf = (language = "ruby") => card(language).$(".orca-lsp-note");
  const containerOf = (language = "ruby") => card(language).$(".orca-lsp-container");
  // The menu of a card, and one of its rows.
  const pick = async (language: string, label: string) => {
    await card(language).$(".orca-lsp-menu").click();
    await $(".menu").$(`button=${label}`).click();
  };
  // Opens the fields of the card with 「手で直す」.
  const fix = (language = "ruby") => pick(language, "手で直す");
  // What `lsp_launches` answers: the way for each of `count` servers, or the refusal.
  const launchesOf = (launch: LspLaunch | { __e2e_reject__: string }, count: number) => ("__e2e_reject__" in launch ? launch : Array.from({ length: count }, () => launch));
  // A language that the worktree has, as `lsp_detect` answers it: the server of the table found on the host (`extra` changes it).
  const foundOf = (language: string, extra: Partial<LspFound> = {}): LspFound => ({ language, name: `${language}-server`, command: `${language}-server --stdio`, place: { kind: "host" }, mount: worktree, state: "found", ...extra });
  // The file pane open on the language server, with what Rust reads for the worktree given.
  async function showServer(launch: LspLaunch | { __e2e_reject__: string } = composeLaunch(), settings = unset(), state = status("running"), lspSettings = 600000, detected: LspFound[] | { __e2e_reject__: string } = []) {
    await openFiles(true, lspSettings);
    await mock("lsp_settings", settings);
    await mock("lsp_launches", launchesOf(launch, settings.servers.length));
    await mock("lsp_status", state);
    await mock("lsp_detect", detected);
    await mode("言語サーバー").click();
    await expect($("#orca-lsp")).toBeDisplayed();
    await waitForCalls("lsp_launches");
    await waitForCalls("lsp_detect");
  }
  const worktreeArgs = { environment: null, project: repo, worktree, server: "ruby" };
  const tsArgs = { ...worktreeArgs, server: "typescript" };
  const stopArgs = { environment: null, worktree, server: "ruby" };
  // The one call that reads the way of the servers `servers`.
  const launchesArgs = (...servers: string[]) => ({ environment: null, project: repo, worktree, servers });
  const detectArgs = { environment: null, project: repo, worktree };

  it("draws the card of a language: its icon, title and state, and under them the server and where it runs, with no field open (A-34)", async () => {
    await showServer(composeLaunch(), unset({ autoStart: false }));
    await expect(card("ruby").$(".orca-lsp-name")).toHaveText("Ruby");
    await expect(card("ruby").$(".orca-lsp-ic img")).toHaveAttribute("src", "vendor/jetbrains-icons/ruby.svg");
    await expect(stateText()).toHaveText("動作中");
    await expect(dot()).toHaveAttribute("data-state", "running");
    await expect(card("ruby").$(".orca-lsp-summary")).toHaveText("ruby-lsp ・ compose の app");
    await expect(noteOf()).not.toBeDisplayed();
    await expect(containerOf()).not.toBeDisplayed();
    // No field, no name of the server, no chip of the language and no plus.
    await expect($("#orca-lsp-command")).not.toExist();
    await expect($("#orca-lsp-name")).not.toExist();
    await expect($(".orca-lsp-chips")).not.toExist();
    await expect($("#orca-lsp-add")).not.toExist();
    await expect($("#orca-lsp-ssh-row")).not.toBeDisplayed();
    expect(await callsOf("lsp_settings")).toEqual([{ environment: null, project: repo }]);
    expect(await callsOf("lsp_launches")).toEqual([launchesArgs("ruby")]);
    expect(await callsOf("lsp_status")).toEqual([{ environment: null, worktree, server: "ruby" }]);
    expect(await callsOf("lsp_language_looks")).toEqual([null]);
    expect(await callsOf("lsp_detect")).toEqual([detectArgs]);
    // The Hosts of ~/.ssh/config are read for a saved environment's field only.
    expect(await callsOf("ssh_hosts")).toEqual([]);
  });

  it("draws a language that has no icon with the line drawing, and a language that the table does not know by its name (A-34)", async () => {
    await showServer(composeLaunch(), { ...unset(), servers: [{ ...unset().servers[0], language: "plaintext", name: "text-ls" }] });
    await expect(card("plaintext").$(".orca-lsp-name")).toHaveText("plaintext");
    await expect(card("plaintext").$(".orca-lsp-ic svg")).toBeExisting();
    await expect(card("plaintext").$(".orca-lsp-ic img")).not.toExist();
  });

  it("has the menu 「再起動」「止める」「削除」「手で直す」, and opens the fields only with the last (A-34)", async () => {
    await showServer(composeLaunch(), unset({ autoStart: false }));
    await card("ruby").$(".orca-lsp-menu").click();
    expect(await textsOf(".menu button")).toEqual(["再起動", "止める", "削除", "手で直す"]);
    await $(".menu").$("button=手で直す").click();
    await expect($("#orca-lsp-command")).toHaveValue(composeCommand);
    await expect($("#orca-lsp-command-auto")).toHaveText("自動");
    await expect($("#orca-lsp-command-auto")).toBeDisplayed();
    await expect($("#orca-lsp-mount")).toHaveValue("/application");
    await expect($("#orca-lsp-mount-auto")).toBeDisplayed();
    await expect($("#orca-lsp-auto")).not.toBeChecked();
    await expect($("#orca-lsp-reset")).toHaveText("自動に戻す");
    await expect($("#orca-lsp-service")).not.toExist();
    await expect($("#orca-lsp-path")).not.toExist();
    // The same row of the menu closes them.
    await fix();
    await expect($("#orca-lsp-command")).not.toExist();
  });

  it("takes the mark away from a field that holds a saved value (A-34)", async () => {
    await showServer(composeLaunch({ command: "bundle exec ruby-lsp", mount: "/srv/app" }), unset({ command: "bundle exec ruby-lsp", mount: "/srv/app" }));
    await fix();
    await expect($("#orca-lsp-command")).toHaveValue("bundle exec ruby-lsp");
    await expect($("#orca-lsp-command-auto")).not.toBeDisplayed();
    await expect($("#orca-lsp-mount-auto")).not.toBeDisplayed();
  });

  it("reads nothing while the language server is not what the pane shows (A-34)", async () => {
    await openFiles();
    const settings = await mock("lsp_settings", unset());
    const launch = await mock("lsp_launches", [composeLaunch()]);
    const detect = await mock("lsp_detect", []);
    await browser.pause(300);
    expect(await callsOf(settings)).toEqual([]);
    expect(await callsOf(launch)).toEqual([]);
    expect(await callsOf(detect)).toEqual([]);
    await mode("言語サーバー").click();
    await waitForCalls(launch);
    await waitForCalls(detect);
  });

  it("follows the event of the state: indexing, running and stopped with its message, and leaves the events of other worktrees (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("indexing"));
    await expect(stateText()).toHaveText("索引中");
    await expect(dot()).toHaveAttribute("data-state", "indexing");
    await tell(status("running"));
    await expect(stateText()).toHaveText("動作中");
    await tell(status("stopped", { reason: "failed", message: "ruby-lsp が終了しました: bundler: command not found: ruby-lsp" }));
    await expect(stateText()).toHaveText("停止中");
    await expect(dot()).toHaveAttribute("data-reason", "failed");
    await expect(noteOf()).toHaveText("ruby-lsp が終了しました: bundler: command not found: ruby-lsp");
    await expect(containerOf()).not.toBeDisplayed();
    await tell(status("running"), "/work/other");
    await browser.pause(200);
    await expect(stateText()).toHaveText("停止中");
    await tell(notStarted);
    await expect(noteOf()).not.toBeDisplayed();
    // The reason is the one Rust told (it was `failed` just before), so the dot is no longer red.
    await expect(dot()).toHaveAttribute("data-reason", "notStarted");
    await expect(stateText()).toHaveText("停止中");
  });

  it("draws a card for each server, each with the name of its server and where it runs, and the state of each is its own (A-34)", async () => {
    await showServer(composeLaunch(), two());
    await expect(card("ruby").$(".orca-lsp-name")).toHaveText("Ruby");
    await expect(card("typescript").$(".orca-lsp-name")).toHaveText("TypeScript");
    await expect(card("typescript").$(".orca-lsp-ic img")).toHaveAttribute("src", "vendor/jetbrains-icons/typeScript.svg");
    await expect(card("typescript").$(".orca-lsp-summary")).toHaveText("ts ・ compose の app");
    await expect($("#orca-lsp-command")).not.toExist();
    // The state and the way are read for each server.
    expect(await callsOf("lsp_launches")).toEqual([launchesArgs("ruby", "typescript")]);
    expect(await callsOf("lsp_status")).toEqual([{ environment: null, worktree, server: "ruby" }, { environment: null, worktree, server: "typescript" }]);
    // The state of one server is not the state of the other.
    await tell(status("indexing"), worktree, "typescript");
    await expect(stateText("typescript")).toHaveText("索引中");
    await expect(stateText()).toHaveText("動作中");
  });

  it("opens the fields of one card at a time (A-34)", async () => {
    await showServer(composeLaunch(), two());
    await fix("typescript");
    await expect(card("typescript").$("#orca-lsp-command")).toExist();
    await fix("ruby");
    await expect(card("ruby").$("#orca-lsp-command")).toExist();
    await expect(card("typescript").$("#orca-lsp-command")).not.toExist();
    expect(await count("#orca-lsp-command")).toBe(1);
  });

  it("saves only the server whose field was left, and leaves the others as they are (A-34)", async () => {
    await showServer(composeLaunch(), two());
    await fix("typescript");
    await change("orca-lsp-auto", false);
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: { ...two(), servers: [two().servers[0], { ...ts, autoStart: false }] } }]);
    // The way of that server is read again with the setting applied.
    expect((await waitForCalls("lsp_launches", 2))[1]).toEqual(launchesArgs("typescript"));
  });

  it("says why the way cannot be read, with the fields left empty (A-34)", async () => {
    await showServer(rejects("docker compose の設定を読めません"));
    await expect(noteOf()).toHaveText("docker compose の設定を読めません");
    await expect(card("ruby").$(".orca-lsp-summary")).toHaveText("ruby-lsp");
    await fix();
    await expect($("#orca-lsp-command")).toHaveValue("");
  });

  it("shows the choice of the service only when several services mount the worktree, and saves the choice (A-34)", async () => {
    const several = composeLaunch({ candidates: [{ service: "app", mount: "/application" }, { service: "worker", mount: "/application" }] });
    await showServer(several);
    await fix();
    await expect($("#orca-lsp-service")).toBeDisplayed();
    expect(await textsOf("#orca-lsp-service option")).toEqual(["app", "worker"]);
    await expect($("#orca-lsp-service")).toHaveValue("app");
    await change("orca-lsp-service", "worker");
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: unset({ service: "worker" }) }]);
    // The way is read again with the setting applied.
    await waitForCalls("lsp_launches", 2);
  });

  it("saves the command and the mount as they are left, and nothing when a field is left as it was (A-34)", async () => {
    await showServer();
    await fix();
    await change("orca-lsp-command", composeCommand);
    await change("orca-lsp-mount", "/application");
    await browser.pause(300);
    expect(await callsOf("lsp_settings_set")).toEqual([]);
    await change("orca-lsp-command", "  bundle exec ruby-lsp  ");
    await waitForCalls("lsp_settings_set");
    await change("orca-lsp-mount", "/srv/app");
    expect(await waitForCalls("lsp_settings_set", 2)).toEqual([{ settings: unset({ command: "bundle exec ruby-lsp" }) }, { settings: unset({ command: "bundle exec ruby-lsp", mount: "/srv/app" }) }]);
    // A value that was set by hand has no mark, and the fields stay open.
    await expect($("#orca-lsp-command-auto")).not.toBeDisplayed();
    await expect($("#orca-lsp-mount-auto")).not.toBeDisplayed();
  });

  it("leaves the text of the field that is being typed in when the save of another field ends (A-34)", async () => {
    await showServer();
    await fix();
    // The owner is typing in the mount when the save of the command ends and the fields are drawn again.
    await browser.execute(() => {
      const mount = document.getElementById("orca-lsp-mount") as HTMLInputElement;
      mount.focus();
      mount.value = "/srv/typed";
    });
    await change("orca-lsp-command", "bundle exec ruby-lsp");
    await waitForCalls("lsp_settings_set");
    await waitForCalls("lsp_launches", 2);
    await expect($("#orca-lsp-mount")).toHaveValue("/srv/typed");
    await expect($("#orca-lsp-mount")).toBeFocused();
  });

  it("saves an emptied field as not set, so the decided way is used again (A-34)", async () => {
    await showServer(composeLaunch({ command: "bundle exec ruby-lsp" }), unset({ command: "bundle exec ruby-lsp" }));
    await fix();
    await change("orca-lsp-command", "");
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: unset({ command: null }) }]);
  });

  it("saves 「自動で起動」 (A-34)", async () => {
    await showServer();
    await fix();
    await expect($("#orca-lsp-auto")).toBeChecked();
    await change("orca-lsp-auto", false);
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: unset({ autoStart: false }) }]);
    await change("orca-lsp-auto", true);
    expect(await waitForCalls("lsp_settings_set", 2)).toEqual([{ settings: unset({ autoStart: false }) }, { settings: unset({ autoStart: true }) }]);
  });

  it("takes the command, the mount and the service back to what is decided with 「自動に戻す」, and keeps the rest (A-34)", async () => {
    await showServer(composeLaunch(), unset({ command: "bundle exec ruby-lsp", mount: "/srv/app", service: "worker", autoStart: false, sshHost: "dev" }));
    await fix();
    await expect($("#orca-lsp-command-auto")).not.toBeDisplayed();
    await $("#orca-lsp-reset").click();
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: unset({ autoStart: false, sshHost: "dev" }) }]);
    await waitForCalls("lsp_launches", 2);
  });

  it("has nothing to take back when nothing is replaced (A-34)", async () => {
    await showServer();
    await fix();
    await expect($("#orca-lsp-reset")).toBeDisabled();
  });

  it("says why a save was refused, and shows the settings that are saved (A-34)", async () => {
    await showServer();
    await fix();
    await mock("lsp_settings_set", rejects("パスの対応が正しくありません"));
    await change("orca-lsp-mount", "relative");
    await expect(noteOf()).toHaveText("パスの対応が正しくありません");
    await expect($("#orca-lsp-mount")).toHaveValue("/application");
  });

  it("stops the server with 「止める」, and a file opened later does not start it until the restart (A-34)", async () => {
    await showServer();
    const stop = await mock("lsp_stop", null);
    await pick("ruby", "止める");
    expect(await waitForCalls(stop)).toEqual([stopArgs]);
    await expect(stateText()).toHaveText("停止中");
    await expect(dot()).toHaveAttribute("data-reason", "notStarted");
    // A file of the worktree is opened: the server is not started, although 「自動で起動」 is on.
    await mock("lsp_status", notStarted);
    const start = await mock("lsp_start", status("indexing"));
    await mode("ファイル").click();
    await openFileWith("a.rb", text(source));
    await browser.pause(300);
    expect(await callsOf(start)).toEqual([]);
    // The restart gives it back.
    await mode("言語サーバー").click();
    const restart = await mock("lsp_restart", status("indexing"));
    await pick("ruby", "再起動");
    expect(await waitForCalls(restart)).toEqual([worktreeArgs]);
    await expect(stateText()).toHaveText("索引中");
  });

  it("says why a stop failed (A-34)", async () => {
    await showServer();
    await mock("lsp_stop", rejects("止められません"));
    await pick("ruby", "止める");
    await expect(noteOf()).toHaveText("止められません");
  });

  it("draws a language that the worktree has and the repository has no server of as a dotted card with what the table gives, and none for a language it has (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, [
      foundOf("ruby"),
      foundOf("typescript", { name: "typescript-language-server" }),
      foundOf("go", { name: "gopls", place: { kind: "compose", service: "app" }, mount: "/application" }),
      foundOf("rust", { name: "rust-analyzer", command: null, state: "missing" }),
      foundOf("python", { name: "pyright", command: null, state: "containerDown", place: { kind: "compose", service: "app" }, mount: "/application" }),
    ]);
    await expect(card("ruby")).toHaveAttribute("data-kind", "server");
    expect(await count('.orca-lsp-card[data-kind="found"]')).toBe(4);
    await expect(card("typescript").$(".orca-lsp-name")).toHaveText("TypeScript");
    await expect(card("typescript").$(".orca-lsp-ic img")).toHaveAttribute("src", "vendor/jetbrains-icons/typeScript.svg");
    await expect(card("typescript").$(".orca-lsp-summary")).toHaveText("typescript-language-server ・ ホスト");
    expect(await textsOf('.orca-lsp-card[data-name="typescript"] .text-btn')).toEqual(["使わない", "使う"]);
    await expect(card("go").$(".orca-lsp-summary")).toHaveText("gopls ・ compose の app");
    await expect(card("rust").$(".orca-lsp-summary")).toHaveText("サーバーがありません");
    expect(await textsOf('.orca-lsp-card[data-name="rust"] .text-btn')).toEqual(["Claude に頼む"]);
    await expect(card("python").$(".orca-lsp-summary")).toHaveText("コンテナが止まっています");
    expect(await textsOf('.orca-lsp-card[data-name="python"] .text-btn')).toEqual(["コンテナを起動"]);
    // Nothing was saved or started by finding them.
    expect(await callsOf("lsp_settings_set")).toEqual([]);
    expect(await callsOf("lsp_start")).toEqual([]);
  });

  it("saves the server of the table with nothing replaced with 「使う」, and reads its way and state (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, [foundOf("typescript", { name: "typescript-language-server" })]);
    await card("typescript").$(".orca-lsp-use").click();
    const added: LspServerSettings = { language: "typescript", name: "typescript-language-server", autoStart: true, command: null, mount: null, service: null };
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: { ...unset(), servers: [...unset().servers, added] } }]);
    await expect(card("typescript")).toHaveAttribute("data-kind", "server");
    await expect(card("typescript").$(".orca-lsp-summary")).toHaveText("typescript-language-server ・ compose の app");
    expect((await waitForCalls("lsp_launches", 2))[1]).toEqual(launchesArgs("typescript"));
    expect(await callsOf("lsp_status")).toEqual([{ environment: null, worktree, server: "ruby" }, { environment: null, worktree, server: "typescript" }]);
    expect(await count('.orca-lsp-card[data-kind="found"]')).toBe(0);
  });

  it("says why 「使う」 was refused, and keeps the card (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, [foundOf("typescript")]);
    await mock("lsp_settings_set", rejects("言語「typescript」のサーバーが重なっています"));
    await card("typescript").$(".orca-lsp-use").click();
    await expect(noteOf("typescript")).toHaveText("言語「typescript」のサーバーが重なっています");
    await expect(card("typescript")).toHaveAttribute("data-kind", "found");
  });

  it("hides the card with 「使わない」 while this worktree is shown, saves nothing, and shows it again with the reload (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, [foundOf("typescript"), foundOf("go")]);
    await card("typescript").$(".orca-lsp-skip").click();
    await expect(card("typescript")).not.toExist();
    await expect(card("go")).toBeDisplayed();
    expect(await callsOf("lsp_settings_set")).toEqual([]);
    expect(await callsOf("lsp_detect")).toEqual([detectArgs]);
    await $("#orca-lsp-reload").click();
    expect(await waitForCalls("lsp_detect", 2)).toEqual([detectArgs, detectArgs]);
    await expect(card("typescript")).toBeDisplayed();
  });

  it("finds the languages again with the reload, and draws the ones that are new (A-34)", async () => {
    await showServer();
    await expect($("#orca-lsp-reload")).toHaveAttribute("aria-label", "再読み込み");
    expect(await count('.orca-lsp-card[data-kind="found"]')).toBe(0);
    const detect = await mock("lsp_detect", [foundOf("go")]);
    await $("#orca-lsp-reload").click();
    expect(await waitForCalls(detect)).toEqual([detectArgs]);
    await expect(card("go")).toHaveAttribute("data-kind", "found");
  });

  it("says why the languages could not be found, in the line under the heading (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, rejects("docker compose の設定を読めません"));
    await expect($("#orca-lsp-error")).toHaveText("docker compose の設定を読めません");
    await expect(card("ruby")).toBeDisplayed();
  });

  it("starts the container of a language found, after saving its server as 「使う」 does, and then starts the server (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, [foundOf("python", { name: "pyright", command: null, state: "containerDown", place: { kind: "compose", service: "app" }, mount: "/application" })]);
    const up = await mock("lsp_container_start", null);
    const start = await mock("lsp_start", status("indexing"));
    await card("python").$(".orca-lsp-container").click();
    const added: LspServerSettings = { language: "python", name: "pyright", autoStart: true, command: null, mount: null, service: null };
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: { ...unset(), servers: [...unset().servers, added] } }]);
    const pythonArgs = { ...worktreeArgs, server: "python" };
    expect(await waitForCalls(up)).toEqual([pythonArgs]);
    expect(await waitForCalls(start)).toEqual([pythonArgs]);
    await expect(card("python")).toHaveAttribute("data-kind", "server");
    await expect(stateText("python")).toHaveText("索引中");
  });

  // ---- Claude Code sets the servers up (A-34, A-36, #976) ----

  const askText = "> 環境: local\n> プロジェクト: proj_example-app\nサーバーを調べて設定してください。\n";
  const askArgs = (language: string | null) => ({ environment: null, project: repo, worktree, language });
  const paneOf = () => $("#orca-lsp-claude");

  it("has the ✦ of Claude in the heading, which opens the pane of Claude Code under the cards with the instruction of Rust (A-34, A-36)", async () => {
    await showServer();
    await expect($("#orca-lsp-ask")).toHaveAttribute("aria-label", "Claude に設定を頼む");
    await expect(paneOf()).not.toBeDisplayed();
    expect(await callsOf("claude_code_start")).toEqual([]);
    const ask = await mock("lsp_claude_request", askText);
    await $("#orca-lsp-ask").click();
    expect(await waitForCalls(ask)).toEqual([askArgs(null)]);
    await expect(paneOf()).toBeDisplayed();
    await expect($("#orca-lsp-claude-term.claude-code-pane")).toBeDisplayed();
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "lsp-claude", builtinTools: true, skill: null, prompt: askText });
    // Under the cards, inside the language server part.
    expect(await browser.execute(() => document.getElementById("orca-lsp-cards")!.nextElementSibling?.id)).toBe("orca-lsp-claude");
    expect(await callsOf("lsp_settings_set")).toEqual([]);
  });

  it("asks for the language of a card that has no server found with 「Claude に頼む」 (A-34, A-36)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, [foundOf("rust", { name: "rust-analyzer", command: null, state: "missing" })]);
    const ask = await mock("lsp_claude_request", askText);
    await card("rust").$(".orca-lsp-ask").click();
    expect(await waitForCalls(ask)).toEqual([askArgs("rust")]);
    await expect(paneOf()).toBeDisplayed();
    expect((await waitForCalls("claude_code_start"))[0]).toMatchObject({ id: "lsp-claude", prompt: askText });
  });

  it("shows why the instruction was refused, in the line of the card or under the heading, and opens no pane (A-34, A-36)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, [foundOf("rust", { name: "rust-analyzer", command: null, state: "missing" })]);
    await mock("lsp_claude_request", rejects("worktree のパスが正しくありません"));
    await card("rust").$(".orca-lsp-ask").click();
    await expect(noteOf("rust")).toHaveText("worktree のパスが正しくありません");
    await $("#orca-lsp-ask").click();
    await expect($("#orca-lsp-error")).toHaveText("worktree のパスが正しくありません");
    await expect(paneOf()).not.toBeDisplayed();
    expect(await callsOf("claude_code_start")).toEqual([]);
  });

  it("closes the process with the cross of the pane, and a second press starts another (A-36)", async () => {
    await showServer();
    await mock("lsp_claude_request", askText);
    await $("#orca-lsp-ask").click();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await $("#orca-lsp-claude-close").click();
    expect(await waitForCalls(close)).toEqual([{ id: "lsp-claude", launch: 1 }]);
    await expect(paneOf()).not.toBeDisplayed();
    await $("#orca-lsp-ask").click();
    await waitForCalls("claude_code_start", 2);
    await expect(paneOf()).toBeDisplayed();
  });

  it("leaves the same request as it is, and closes the pane for a new one of another language (A-36)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 600000, [foundOf("rust", { name: "rust-analyzer", command: null, state: "missing" })]);
    await mock("lsp_claude_request", askText);
    await $("#orca-lsp-ask").click();
    await waitForCalls("claude_code_start");
    await $("#orca-lsp-ask").click();
    await browser.pause(300);
    expect(await callsOf("claude_code_start")).toHaveLength(1);
    const close = await mock("claude_code_close", null);
    await card("rust").$(".orca-lsp-ask").click();
    expect(await waitForCalls(close)).toEqual([{ id: "lsp-claude", launch: 1 }]);
    expect(await waitForCalls("claude_code_start", 2)).toHaveLength(2);
    expect((await callsOf("lsp_claude_request")).map((c) => (c as { language: string | null }).language)).toEqual([null, "rust"]);
  });

  it("hides the pane with the part, leaves the process running, and shows the same pane again (A-36)", async () => {
    await showServer();
    await mock("lsp_claude_request", askText);
    await $("#orca-lsp-ask").click();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await mode("ファイル").click();
    await expect(paneOf()).not.toBeDisplayed();
    await expect($("#orca-lsp-claude-term .orca-term-box")).not.toExist();
    await mode("言語サーバー").click();
    await expect(paneOf()).toBeDisplayed();
    await expect($("#orca-lsp-claude-term .orca-term-box")).toExist();
    expect(await callsOf("claude_code_start")).toHaveLength(1);
    expect(await callsOf(close)).toEqual([]);
  });

  it("draws the server that Claude saved on the card of its language at the next read of the settings (A-34, #976)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 250, [foundOf("typescript", { name: "typescript-language-server" })]);
    await expect(card("typescript")).toHaveAttribute("data-kind", "found");
    await mock("lsp_launches", [composeLaunch()]);
    await mock("lsp_settings", two());
    await expect(card("typescript")).toHaveAttribute("data-kind", "server");
    expect(await waitForCalls("lsp_launches")).toEqual([launchesArgs("typescript")]);
    expect(await count('.orca-lsp-card[data-name="typescript"]')).toBe(1);
  });

  it("deletes a server from the menu of its card after the question, and stops what ran for it (A-34)", async () => {
    await showServer(composeLaunch(), two());
    await card("typescript").$(".orca-lsp-menu").click();
    await $(".menu").$("button=削除").click();
    expect(await callsOf("lsp_settings_set")).toEqual([]);
    await $(".pop-confirm .text-btn.danger").click();
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: { ...two(), servers: [two().servers[0]] } }]);
    expect(await waitForCalls("lsp_stop")).toEqual([{ environment: null, worktree, server: "typescript" }]);
    await expect(card("typescript")).not.toExist();
    await expect(card("ruby")).toBeDisplayed();
  });

  it("asks for the ssh host only for a saved environment, chooses it from the Hosts of ~/.ssh/config, and saves it with that environment (A-34)", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), studio), { orca_terminal_read: ["$"], orca_files_list: root(), orca_files_ignored: [], ...timers({ orcaClock: 600000, lspSettings: 600000 }) });
    await project("example-app").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 2);
    await mock("lsp_settings", unset({ environment: "Studio", sshHost: "dev" }));
    await mock("lsp_launches", [composeLaunch()]);
    await mock("ssh_hosts", ["dev", "build"]);
    await mode("言語サーバー").click();
    await expect($("#orca-lsp-ssh-row")).toBeDisplayed();
    expect(await textsOf("#orca-lsp-ssh option")).toEqual(["", "dev", "build"]);
    await expect($("#orca-lsp-ssh")).toHaveValue("dev");
    expect(await callsOf("ssh_hosts")).toEqual([null]);
    expect(await callsOf("lsp_settings")).toEqual([{ environment: "Studio", project: repo }]);
    expect(await callsOf("lsp_launches")).toEqual([{ environment: "Studio", project: repo, worktree, servers: ["ruby"] }]);
    expect(await callsOf("lsp_detect")).toEqual([{ environment: "Studio", project: repo, worktree }]);
    await change("orca-lsp-ssh", "build");
    expect(await waitForCalls("lsp_settings_set")).toEqual([{ settings: unset({ environment: "Studio", sshHost: "build" }) }]);
    // The way of each server and the languages are read again through the new Host.
    await waitForCalls("lsp_launches", 2);
    await waitForCalls("lsp_detect", 2);
    // The empty choice takes the Host away.
    const set = await mock("lsp_settings_set", unset({ environment: "Studio", sshHost: null }));
    await change("orca-lsp-ssh", "");
    expect(await waitForCalls(set)).toEqual([{ settings: unset({ environment: "Studio", sshHost: null }) }]);
  });

  it("shows a saved ssh host that ~/.ssh/config does not have as the chosen value (A-34)", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), studio), { orca_terminal_read: ["$"], orca_files_list: root(), orca_files_ignored: [], ...timers({ orcaClock: 600000, lspSettings: 600000 }) });
    await project("example-app").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 2);
    await mock("lsp_settings", unset({ environment: "Studio", sshHost: "gone" }));
    await mock("lsp_launches", [composeLaunch()]);
    await mock("ssh_hosts", ["dev"]);
    await mode("言語サーバー").click();
    expect(await textsOf("#orca-lsp-ssh option")).toEqual(["", "dev", "gone"]);
    await expect($("#orca-lsp-ssh")).toHaveValue("gone");
  });

  it("restarts the server with one command that replaces it, and keeps the state it answers (A-34)", async () => {
    await showServer();
    const restart = await mock("lsp_restart", holds);
    const stop = await mock("lsp_stop", null);
    const start = await mock("lsp_start", status("indexing"));
    await pick("ruby", "再起動");
    expect(await waitForCalls(restart)).toEqual([worktreeArgs]);
    // The rows of the menu wait while the press is on its way.
    await card("ruby").$(".orca-lsp-menu").click();
    await expect($(".menu").$("button=再起動")).toBeDisabled();
    await expect($(".menu").$("button=止める")).toBeDisabled();
    await browser.keys("Escape");
    await release(restart, status("indexing"));
    await expect(stateText()).toHaveText("索引中");
    await card("ruby").$(".orca-lsp-menu").click();
    await expect($(".menu").$("button=再起動")).toBeEnabled();
    // The stop and the start are not called one after the other: that would drop the places outside the worktree that the server gave.
    expect(await callsOf(stop)).toEqual([]);
    expect(await callsOf(start)).toEqual([]);
  });

  it("restarts the server of the card that was pressed (A-34)", async () => {
    await showServer(composeLaunch(), two());
    const restart = await mock("lsp_restart", status("indexing"));
    await pick("typescript", "再起動");
    expect(await waitForCalls(restart)).toEqual([tsArgs]);
    await expect(stateText("typescript")).toHaveText("索引中");
    await expect(stateText()).toHaveText("動作中");
  });

  it("offers to start the container when it is down, and starts the server again after it (A-34)", async () => {
    await showServer(composeLaunch(), unset(), down);
    await expect(stateText()).toHaveText("停止中");
    await expect(noteOf()).toHaveText("サービスのコンテナが動いていません");
    await expect(containerOf()).toBeDisplayed();
    await expect(containerOf()).toHaveText("コンテナを起動");
    const up = await mock("lsp_container_start", holds);
    const start = await mock("lsp_start", status("indexing"));
    await containerOf().click();
    expect(await waitForCalls(up)).toEqual([worktreeArgs]);
    await expect(containerOf()).toBeDisabled();
    expect(await callsOf(start)).toEqual([]);
    await release(up, null);
    expect(await waitForCalls(start)).toEqual([worktreeArgs]);
    await expect(stateText()).toHaveText("索引中");
    await expect(containerOf()).not.toBeDisplayed();
  });

  it("says why the container did not start, starts no server, and leaves the button (A-34)", async () => {
    await showServer(composeLaunch(), unset(), down);
    const start = await mock("lsp_start", status("indexing"));
    await mock("lsp_container_start", rejects("コンテナを起動できません: no such service: app"));
    await containerOf().click();
    await expect(noteOf()).toHaveText("コンテナを起動できません: no such service: app");
    expect(await callsOf(start)).toEqual([]);
    await expect(containerOf()).toBeEnabled();
  });

  it("draws a change of the settings made elsewhere while it is shown, and keeps the typed text and the fields that are open (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 250);
    await fix();
    // The owner is typing in the mount when the settings change elsewhere (tsunagiai-mcp).
    await browser.execute(() => {
      const mount = document.getElementById("orca-lsp-mount") as HTMLInputElement;
      mount.focus();
      mount.value = "/srv/typed";
    });
    await mock("lsp_launches", [composeLaunch()]);
    await mock("lsp_settings", two());
    await expect(card("typescript")).toBeDisplayed();
    await expect($("#orca-lsp-mount")).toHaveValue("/srv/typed");
    // The way of the new server is read, and that of the one that did not change is not.
    expect(await waitForCalls("lsp_launches")).toEqual([launchesArgs("typescript")]);
    await mock("lsp_settings", { ...two(), servers: [...two().servers, { ...ts, name: "py", language: "python" }] });
    await expect(card("python")).toBeDisplayed();
    await expect($("#orca-lsp-mount")).toHaveValue("/srv/typed");
  });

  it("reads the settings again only while the language server is shown (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 250);
    await browser.pause(400);
    await mode("ファイル").click();
    const settings = await mock("lsp_settings", two());
    await browser.pause(700);
    expect(await callsOf(settings)).toEqual([]);
    await expect(card("typescript")).not.toExist();
  });

  it("starts the server when a Ruby file of the worktree is opened and the server is not started (A-34)", async () => {
    await openFiles();
    await mock("lsp_status", notStarted);
    await mock("lsp_settings", unset());
    const start = await mock("lsp_start", status("indexing"));
    await openFileWith("a.rb", text(source));
    expect(await waitForCalls(start)).toEqual([worktreeArgs]);
    expect(await callsOf("lsp_status")).toEqual([{ environment: null, worktree, server: "ruby" }]);
    expect(await callsOf("lsp_settings")).toEqual([{ environment: null, project: repo }]);
  });

  it("starts the server that takes the language of a file that is not Ruby (A-34)", async () => {
    await openFiles();
    await mock("lsp_status", notStarted);
    await mock("lsp_settings", two());
    await mock("lsp_server_for", "typescript");
    const start = await mock("lsp_start", status("indexing"));
    await openFileWith("notes.txt", text("const x = 1;\n", "typescript", null));
    expect(await waitForCalls(start)).toEqual([tsArgs]);
    expect(await callsOf("lsp_status")).toEqual([{ environment: null, worktree, server: "typescript" }]);
    expect(await callsOf("lsp_server_for")).toEqual([{ environment: null, project: repo, language: "typescript" }]);
  });

  it("does not start it when 「自動で起動」 is off, or for a file that no server takes (A-34)", async () => {
    await openFiles();
    await mock("lsp_status", notStarted);
    const settings = await mock("lsp_settings", unset({ autoStart: false }));
    const start = await mock("lsp_start", status("indexing"));
    await openFileWith("a.rb", text(source));
    await waitForCalls(settings);
    await browser.pause(300);
    expect(await callsOf(start)).toEqual([]);
    await mock("lsp_settings", unset());
    await mock("lsp_server_for", null);
    await openFileWith("notes.txt", text("Rails is here\n", "plaintext", null));
    await browser.pause(300);
    expect(await callsOf(start)).toEqual([]);
    expect(await callsOf("lsp_settings")).toEqual([]);
  });

  for (const [name, state] of [
    ["running", status("running")],
    ["indexing", status("indexing")],
    ["ended with an error", status("stopped", { reason: "failed", message: "ruby-lsp が終了しました" })],
    ["ended with the container down", down],
  ] as const) {
    it(`starts nothing when the server is ${name} (A-34)`, async () => {
      await openFiles();
      const asked = await mock("lsp_status", state);
      const settings = await mock("lsp_settings", unset());
      const start = await mock("lsp_start", status("indexing"));
      await openFileWith("a.rb", text(source));
      await waitForCalls(asked);
      await browser.pause(300);
      expect(await callsOf(start)).toEqual([]);
      expect(await callsOf(settings)).toEqual([]);
    });
  }

  it("asks once for a worktree, not for each Ruby file (A-34)", async () => {
    await define();
    await waitForCalls("lsp_start");
    await waitForCount(".orca-definition .orca-def", 3);
    await mock("orca_file_read", text(rows(40), "ruby"));
    await mock("orca_panes", below([claude, "file:1", "file:2"], "file:2", "p1"));
    await press(0);
    await expect($(".orca-edit-area")).toHaveValue(rows(40), { trim: false });
    await browser.pause(300);
    expect(await callsOf("lsp_start")).toEqual([worktreeArgs]);
  });

  // The page's own `mousemove` over the text, at the middle of each character of `offsets` in turn (in one run of the page, so that no wait of the app comes between two of them), with or without the Command key.
  const moveAt = (meta: boolean, ...offsets: number[]) =>
    browser.execute(
      (withMeta, list, once) => {
        if (!window.__e2e_once__(once)) return;
        const area = document.querySelector(".orca-edit-area")!;
        for (const o of list) {
          const walker = document.createTreeWalker(document.querySelector(".orca-edit-hl code")!, NodeFilter.SHOW_TEXT);
          let left = o;
          for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
            if (left >= node.length) {
              left -= node.length;
              continue;
            }
            const range = document.createRange();
            range.setStart(node, left);
            range.setEnd(node, left + 1);
            const box = range.getBoundingClientRect();
            area.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, metaKey: withMeta, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
            break;
          }
        }
      },
      meta,
      offsets,
      onceId(),
    );
  // The Command key going down or up, as the page sees it.
  const metaKey = (type: "keydown" | "keyup") =>
    browser.execute(
      (t, once) => {
        if (!window.__e2e_once__(once)) return;
        document.dispatchEvent(new KeyboardEvent(t, { key: "Meta", metaKey: t === "keydown", bubbles: true }));
      },
      type,
      onceId(),
    );
  const leave = () =>
    browser.execute((once) => {
      if (!window.__e2e_once__(once)) return;
      document.querySelector(".orca-edit-area")!.dispatchEvent(new MouseEvent("mouseleave"));
    }, onceId());
  const underline = () => browser.execute(() => ({ hidden: document.querySelector<HTMLElement>(".orca-edit-link")!.hidden, cursor: document.querySelector<HTMLElement>(".orca-edit-area")!.style.cursor }));
  const waitUnderline = () => browser.waitUntil(async () => !(await underline()).hidden, { timeoutMsg: "the underline was never drawn" });
  const noUnderline = async () => {
    await browser.pause(400);
    expect((await underline()).hidden).toBe(true);
  };
  const onLogger = () => source.indexOf(".logger") + 3;
  const existsArgs = (line: number, character: number, relative = "a.rb", body = source) => ({ environment: null, worktree, server: "ruby", relative, text: body, line, character });
  // Opens a.rb with the answer of `lsp_definition_exists` and the name under the mouse ("Rails").
  async function openLinked(exists: boolean | ReturnType<typeof rejects> = true) {
    await openFiles();
    await mock("lsp_status", notStarted);
    await mock("lsp_start", status("running"));
    await openFileWith("a.rb", text(source));
    await mock("lsp_word", "Rails");
    await mock("lsp_definition_exists", exists);
  }

  it("underlines the name when the mouse stays on it with the Command key and the server has a definition, with the pointer, and opens nothing (A-34)", async () => {
    await openLinked();
    await moveAt(true, onRails());
    expect(await waitForCalls("lsp_definition_exists")).toEqual([existsArgs(2, 6)]);
    expect(await callsOf("lsp_word")).toEqual([{ line: "    Rails.logger.info(x)", character: 6 }]);
    await waitUnderline();
    expect((await underline()).cursor).toBe("pointer");
    // The line is under the name: the same left edge and width as the letters of "Rails" in the layer, and at the foot of them.
    const gap = await browser.execute((from, to) => {
      const walker = document.createTreeWalker(document.querySelector(".orca-edit-hl code")!, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let seen = 0;
      let started = false;
      for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
        if (!started && from < seen + node.length) {
          range.setStart(node, from - seen);
          started = true;
        }
        if (started && to <= seen + node.length) {
          range.setEnd(node, to - seen);
          break;
        }
        seen += node.length;
      }
      const word = range.getBoundingClientRect();
      const line = document.querySelector(".orca-edit-link")!.getBoundingClientRect();
      return { left: line.left - word.left, width: line.width - word.width, foot: line.bottom - word.bottom };
    }, source.indexOf("Rails"), source.indexOf("Rails") + 5);
    expect(Math.abs(gap.left)).toBeLessThan(1);
    expect(Math.abs(gap.width)).toBeLessThan(1);
    expect(Math.abs(gap.foot)).toBeLessThan(1);
    expect(await callsOf("lsp_definition")).toEqual([]);
    await expect($(".orca-definition")).not.toExist();
  });

  it("draws nothing for a name with no definition, and nothing when the Command key is not down (A-34)", async () => {
    await openLinked(false);
    await moveAt(true, onRails());
    await waitForCalls("lsp_definition_exists");
    await noUnderline();
    expect((await underline()).cursor).toBe("");
    await mock("lsp_definition_exists", true);
    await moveAt(false, onRails());
    await browser.pause(400);
    expect(await callsOf("lsp_definition_exists")).toEqual([]);
    await noUnderline();
  });

  it("asks once the Command key goes down over a name the mouse is on, and takes the underline away when it goes up (A-34)", async () => {
    await openLinked();
    await moveAt(false, onRails());
    await metaKey("keydown");
    await waitForCalls("lsp_definition_exists");
    await waitUnderline();
    await metaKey("keyup");
    await noUnderline();
    expect((await underline()).cursor).toBe("");
  });

  it("asks nothing while the mouse keeps moving, and the name where it stays (A-34)", async () => {
    await openLinked();
    await mock("lsp_word", "logger");
    await moveAt(true, onRails(), onLogger());
    expect(await waitForCalls("lsp_definition_exists")).toEqual([existsArgs(2, 12)]);
    await browser.pause(300);
    expect(await callsOf("lsp_definition_exists")).toHaveLength(1);
  });

  it("does not ask again for the same name until the text changes, and asks for another name (A-34)", async () => {
    await openLinked();
    await moveAt(true, onRails());
    await waitForCalls("lsp_definition_exists");
    await waitUnderline();
    // Out of the name and back, and the key up and down.
    await moveAt(true, 0);
    await noUnderline();
    await moveAt(true, onRails());
    await waitUnderline();
    await metaKey("keyup");
    await metaKey("keydown");
    await waitUnderline();
    expect(await callsOf("lsp_definition_exists")).toHaveLength(1);
    // Another name is asked.
    await mock("lsp_word", "logger");
    await mock("lsp_definition_exists", true);
    await moveAt(true, onLogger());
    expect(await waitForCalls("lsp_definition_exists")).toEqual([existsArgs(2, 12)]);
    // The text changes: the same name is asked again, with the new text.
    const typed = `${source}x = Rails\n`;
    await mock("orca_file_write", { state: "saved", signature: "sig-2" });
    await browser.execute(
      (t, once) => {
        if (!window.__e2e_once__(once)) return;
        const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
        area.value = t;
        area.dispatchEvent(new Event("input", { bubbles: true }));
      },
      typed,
      onceId(),
    );
    await noUnderline();
    await mock("lsp_word", "Rails");
    await mock("lsp_definition_exists", true);
    await moveAt(true, onRails());
    expect(await waitForCalls("lsp_definition_exists")).toEqual([existsArgs(2, 6, "a.rb", typed)]);
    await waitUnderline();
  });

  it("takes the underline away when the mouse leaves the editor and when the text scrolls (A-34)", async () => {
    await openLinked();
    await moveAt(true, onRails());
    await waitUnderline();
    await leave();
    await noUnderline();
    await moveAt(true, onRails());
    await waitUnderline();
    await browser.execute(() => {
      document.querySelector(".orca-edit-area")!.dispatchEvent(new Event("scroll"));
    });
    await noUnderline();
  });

  it("draws nothing, and keeps nothing, when the server cannot answer yet (A-34)", async () => {
    await openLinked(rejects("言語サーバーの準備がまだできていません"));
    await moveAt(true, onRails());
    await waitForCalls("lsp_definition_exists");
    await noUnderline();
    // The failure is not kept: the next stay asks again.
    await mock("lsp_definition_exists", true);
    await moveAt(true, 0);
    await moveAt(true, onRails());
    await waitForCalls("lsp_definition_exists");
    await waitUnderline();
  });

  // The app with a project that has no session: its tabs are the files that are opened.
  async function openWithoutSession() {
    await openOrca(orcaOverview([], [orcaWorktree("example-app", "main")]), { orca_files_list: root(), orca_files_ignored: [], editor_settings: { autosaveMs: 100 }, ...timers({ orcaClock: 600000 }) });
    await project("example-app").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 2);
  }
  const closeFileTab = () => $('.orca-tab[data-file="true"] .orca-tab-close').click();

  it("stops the server when the last tab of the worktree is closed (A-34)", async () => {
    await openWithoutSession();
    await mock("lsp_status", notStarted);
    const start = await mock("lsp_start", status("indexing"));
    const stop = await mock("lsp_stop", null);
    await openFileWith("a.rb", text(source));
    await waitForCalls(start);
    await browser.pause(300);
    expect(await callsOf(stop)).toEqual([]);
    await closeFileTab();
    expect(await waitForCalls(stop)).toEqual([{ environment: null, worktree, server: "ruby" }]);
    await expect($('.orca-tab[data-file="true"]')).not.toExist();
  });

  it("keeps the server while another tab of the worktree is open (A-34)", async () => {
    await openFiles();
    await mock("lsp_status", notStarted);
    const start = await mock("lsp_start", status("indexing"));
    const stop = await mock("lsp_stop", null);
    await openFileWith("a.rb", text(source));
    await waitForCalls(start);
    await closeFileTab();
    await expect($('.orca-tab[data-file="true"]')).not.toExist();
    await browser.pause(400);
    expect(await callsOf(stop)).toEqual([]);
  });

  it("stops the server when the worktree is gone from the list of Orca (A-34)", async () => {
    await openFiles();
    await mock("lsp_status", notStarted);
    const start = await mock("lsp_start", status("indexing"));
    const stop = await mock("lsp_stop", null);
    await openFileWith("a.rb", text(source));
    await waitForCalls(start);
    expect(await callsOf(stop)).toEqual([]);
    // The tab of the file is still open: only the list changes.
    await mock("orca_overview", orcaOverview(sample(), [orcaWorktree("example-api", "main")]));
    await showAgain();
    expect(await waitForCalls(stop)).toEqual([{ environment: null, worktree, server: "ruby" }]);
  });

  it("starts the server again when a Ruby file is opened after it was stopped (A-34)", async () => {
    await openWithoutSession();
    await mock("lsp_status", notStarted);
    const start = await mock("lsp_start", status("indexing"));
    const stop = await mock("lsp_stop", null);
    await openFileWith("a.rb", text(source));
    await waitForCalls(start);
    await closeFileTab();
    await waitForCalls(stop);
    await openFileWith("a.rb", text(source));
    await waitForCalls(start, 2);
  });
  it("asks nothing for the underline while the server is indexing, and asks once it runs (A-34)", async () => {
    await openFiles();
    await mock("lsp_status", notStarted);
    const start = await mock("lsp_start", status("indexing"));
    await openFileWith("a.rb", text(source));
    await waitForCalls(start);
    await browser.pause(300);
    await mock("lsp_word", "Rails");
    const exists = await mock("lsp_definition_exists", true);
    await moveAt(true, onRails());
    await noUnderline();
    expect(await callsOf(exists)).toEqual([]);
    await tell(status("running"));
    await moveAt(true, 0);
    await moveAt(true, onRails());
    await waitForCalls(exists);
    await waitUnderline();
  });

  it("looks for the server of the open files again after the settings were saved (A-34)", async () => {
    await openFiles();
    await mock("lsp_status", status("running"));
    await openFileWith("a.rb", text(source));
    await mock("lsp_word", "Rails");
    await mock("lsp_definition_exists", true);
    await mode("言語サーバー").click();
    await expect(card("ruby")).toBeDisplayed();
    const lookup = await mock("lsp_server_for", "ruby");
    await fix();
    await change("orca-lsp-auto", false);
    expect(await waitForCalls(lookup)).toEqual([{ environment: null, project: repo, language: "ruby" }]);
    await moveAt(true, onRails());
    expect(await waitForCalls("lsp_definition_exists")).toEqual([existsArgs(2, 6)]);
  });

  it("reads the settings no more once the Orca screen is left, and again when it is shown (A-34)", async () => {
    await showServer(composeLaunch(), unset(), status("running"), 250);
    await $("#nav-mail").click();
    const settings = await mock("lsp_settings", two());
    await browser.pause(700);
    expect(await callsOf(settings)).toEqual([]);
    await $("#nav-orca").click();
    await waitForCalls(settings);
  });

  it("reads a file once for the places in it (A-34)", async () => {
    const second: LspLocation = { path: "app/lib/rails_ext.rb", outside: false, line: 9, character: 2 };
    await define([inside, second], [insidePlace, { ...insidePlace, line: 10 }]);
    await waitForCount(".orca-definition .orca-def-line", 14);
    expect(await callsOf("orca_file_read")).toEqual([{ path: worktree, relative: "app/lib/rails_ext.rb", environment: null }]);
  });

  it("marks a file outside the worktree gem only when it is a Ruby file (A-34)", async () => {
    const typed: LspLocation = { path: "/usr/lib/node_modules/typescript/lib/lib.d.ts", outside: true, line: 0, character: 0 };
    await define([typed, gem], [{ file: "lib.d.ts", line: 1, place: "/usr/lib/node_modules/typescript/lib", outside: true, language: "typescript" }, gemPlace]);
    await waitForCount(".orca-definition .orca-def", 2);
    expect(await textsOf(".orca-definition .orca-def-gem")).toEqual(["gem"]);
    expect(await count('.orca-definition .orca-def[data-index="0"] .orca-def-gem')).toBe(0);
    const read = await mock("lsp_read_outside", { path: typed.path, text: "declare var x: number;\n", language: "typescript", highlight: "typescript" });
    await mock("orca_panes", below([claude, "file:1", "file:2"], "file:2", "p1"));
    await press(0);
    await waitForCalls(read);
    await expect($(".orca-edit-path")).toHaveText(typed.path);
    await expect($(".orca-edit-state")).toHaveText("");
    await expect($('.orca-tab[data-outside="true"]')).toBeExisting();
    expect(await count(".orca-tab-gem")).toBe(0);
  });
});
