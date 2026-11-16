import type { LspLocation } from "../../ts/bindings/LspLocation";
import type { LspPlace } from "../../ts/bindings/LspPlace";
import type { OrcaDir } from "../../ts/bindings/OrcaDir";
import type { OrcaFileText } from "../../ts/bindings/OrcaFileText";
import { callsOf, count, mock, onceId, rejects, textsOf, timers, waitForCalls, waitForCount } from "../support";
import { filesToggle, openOrca, orcaOverview, project, sample, selectedTab, tabTitles, worktrees } from "../orca-support";

// A-34: the definition in the file pane, and the editor's Command and right button. Rust asks ruby-lsp, reads the name under the mouse and decides how each place is drawn (unit tests); here the screen is checked: what it asks of Rust for a press, and how it draws the answers and opens them.
describe("orca: definition (A-34)", () => {
  const dirOf = (entries: [string, boolean][]): OrcaDir => ({ entries: entries.map(([name, isDirectory]) => ({ name, path: name, isDirectory, ignored: false })), total: entries.length });
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
  const insidePlace: LspPlace = { file: "rails_ext.rb", line: 7, place: "app/lib", outside: false };
  const gemPlace: LspPlace = { file: "rails.rb", line: 19, place: "railties 8.1.4.1 / lib", outside: true };
  const otherPlace: LspPlace = { file: "channel_generator.rb", line: 3, place: "actioncable 8.1.4.1 / lib/rails/generators/channel", outside: true };
  // A file of `n` lines, "row 1" to "row n".
  const rows = (n: number) => `${Array.from({ length: n }, (_, i) => `row ${i + 1}`).join("\n")}\n`;

  // The app with the example-app project selected, the file pane open (`shown`) and its root read. The clock of the list is made very slow, so that no read of the open file comes between a press and the check of its result.
  async function openFiles(shown = true) {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_terminal_read: ["$"], orca_files_list: root(), orca_files_ignored: [], editor_settings: { autosaveMs: 100 }, ...timers({ orcaClock: 600000 }) });
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

  // The three places, answered for the press on "Rails".
  async function answer(locations: LspLocation[] = [inside, gem, other], places: LspPlace[] = [insidePlace, gemPlace, otherPlace]) {
    await mock("lsp_word", "Rails");
    await mock("lsp_definition", locations);
    await mock("lsp_places", places);
  }
  // Opens a.rb, answers (`read` is what the lines of an open row are read from), and presses on "Rails" with the Command key.
  async function define(locations?: LspLocation[], places?: LspPlace[], shown = true, read?: OrcaFileText) {
    await openFiles(shown);
    await openFileWith("a.rb", text(source));
    await answer(locations, places);
    if (read) await mock("orca_file_read", read);
    await contextAt(onRails());
  }
  // Where the caret is in `content` for the line from 0 and the character.
  const caretOf = (content: string, line: number, character: number) => content.split("\n").slice(0, line).reduce((n, l) => n + l.length + 1, 0) + character;
  const caret = () => browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.selectionStart);

  const mode = (label: string) => $(`#orca-files-bar [aria-label="${label}"]`);
  const defRow = (n: number) => $(`#orca-definition-list .orca-def[data-index="${n}"]`);
  const lineTexts = (n: number) => textsOf(`#orca-definition-list .orca-def[data-index="${n}"] .orca-def-line`);
  // The page's own press of the button of a row: the open button of the row `n`, or its toggle.
  const press = (n: number, button: "toggle" | "open") =>
    browser.execute(
      (i, which, once) => {
        if (!window.__e2e_once__(once)) return;
        document.querySelector<HTMLElement>(`#orca-definition-list .orca-def[data-index="${i}"] .orca-def-${which}`)!.click();
      },
      n,
      button,
      onceId(),
    );

  it("asks where the mouse is, not the caret, with the text of the editor, and switches the pane to the definition (A-34)", async () => {
    await openFiles();
    await openFileWith("a.rb", text(source));
    await answer();
    // The caret is at the start; the press is on "Rails" (line 2, character 6).
    await browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.setSelectionRange(0, 0));
    await contextAt(onRails());
    expect(await waitForCalls("lsp_word")).toEqual([{ line: "    Rails.logger.info(x)", character: 6 }]);
    expect(await waitForCalls("lsp_definition")).toEqual([{ environment: null, worktree, relative: "a.rb", text: source, line: 2, character: 6 }]);
    expect(await prevented()).toBe(true);
    await expect($("#orca-definition")).toBeDisplayed();
    await expect(mode("定義")).toHaveAttribute("aria-pressed", "true");
    await expect(mode("ファイル")).toHaveAttribute("aria-pressed", "false");
    await expect($("#orca-files-tree")).not.toBeDisplayed();
    await expect($("#orca-history")).not.toBeDisplayed();
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
    expect(call).toEqual({ environment: null, worktree, relative: "a.rb", text: typed, line: 5, character: 8 });
    expect(await callsOf("lsp_word")).toEqual([{ line: "x = Rails", character: 8 }]);
  });

  it("shows the file pane when it was hidden, with the definition of the press (A-34)", async () => {
    await define(undefined, undefined, false);
    await expect($("#orca-files")).toBeDisplayed();
    await expect($("#orca-definition")).toBeDisplayed();
    await expect(mode("定義")).toHaveAttribute("aria-pressed", "true");
    await waitForCount("#orca-definition-list .orca-def", 3);
  });

  it("draws the name and the count, and a row for each place with its file and line, its place, the gem mark and the open button, all closed when there are several (A-34)", async () => {
    await define();
    await waitForCount("#orca-definition-list .orca-def", 3);
    expect(await textsOf("#orca-definition-head > span")).toEqual(["Rails", "3 件"]);
    expect(await textsOf("#orca-definition-list .orca-def-file")).toEqual(["rails_ext.rb:7", "rails.rb:19", "channel_generator.rb:3"]);
    expect(await textsOf("#orca-definition-list .orca-def-place")).toEqual(["app/lib", "railties 8.1.4.1 / lib", "actioncable 8.1.4.1 / lib/rails/generators/channel"]);
    expect(await textsOf("#orca-definition-list .orca-def-gem")).toEqual(["gem", "gem"]);
    expect(await count('#orca-definition-list .orca-def[data-index="0"] .orca-def-gem')).toBe(0);
    expect(await count('#orca-definition-list .orca-def-open[aria-label="タブで開く"]')).toBe(3);
    expect(await count('#orca-definition-list .orca-def-toggle[aria-expanded="false"]')).toBe(3);
    expect(await count("#orca-definition-list .orca-def-code")).toBe(0);
    expect(await callsOf("lsp_places")).toEqual([{ locations: [inside, gem, other] }]);
    expect(await callsOf("lsp_read_outside")).toEqual([]);
  });

  it("opens the only place at once, and reads its lines (A-34)", async () => {
    await define([inside], [insidePlace], true, text(rows(12)));
    await waitForCount("#orca-definition-list .orca-def", 1);
    await expect($('#orca-definition-list .orca-def-toggle[aria-expanded="true"]')).toBeDisplayed();
    await waitForCount("#orca-definition-list .orca-def-line", 7);
    expect(await textsOf("#orca-definition-head > span")).toEqual(["Rails", "1 件"]);
    expect(await callsOf("orca_file_read")).toEqual([{ path: worktree, relative: "app/lib/rails_ext.rb", environment: null }]);
  });

  it("opens a row to the three lines before and after the definition, marks its line, and closes it without reading again (A-34)", async () => {
    await define();
    await waitForCount("#orca-definition-list .orca-def", 3);
    const read = await mock("orca_file_read", text(rows(12), "ruby"));
    await defRow(0).$(".orca-def-toggle").click();
    await waitForCount("#orca-definition-list .orca-def-line", 7);
    expect(await lineTexts(0)).toEqual(["4row 4", "5row 5", "6row 6", "7row 7", "8row 8", "9row 9", "10row 10"]);
    expect(await textsOf('#orca-definition-list .orca-def-line[data-hit="true"]')).toEqual(["7row 7"]);
    expect(await callsOf(read)).toEqual([{ path: worktree, relative: "app/lib/rails_ext.rb", environment: null }]);
    await defRow(0).$(".orca-def-toggle").click();
    await expect($('#orca-definition-list .orca-def-toggle[aria-expanded="true"]')).not.toExist();
    expect(await count("#orca-definition-list .orca-def-code")).toBe(0);
    await defRow(0).$(".orca-def-toggle").click();
    await waitForCount("#orca-definition-list .orca-def-line", 7);
    expect(await callsOf(read)).toHaveLength(1);
  });

  it("reads the lines of a place outside the worktree with the worktree and the path the server gave, and draws the start of a file from its first line (A-34)", async () => {
    await define();
    await waitForCount("#orca-definition-list .orca-def", 3);
    const read = await mock("lsp_read_outside", { path: other.path, text: rows(30) });
    await defRow(2).$(".orca-def-toggle").click();
    await waitForCount("#orca-definition-list .orca-def-line", 6);
    expect(await callsOf(read)).toEqual([{ environment: null, project: "proj_example-app", worktree, path: other.path }]);
    expect(await lineTexts(2)).toEqual(["1row 1", "2row 2", "3row 3", "4row 4", "5row 5", "6row 6"]);
    expect(await textsOf('#orca-definition-list .orca-def-line[data-hit="true"]')).toEqual(["3row 3"]);
    expect(await callsOf("orca_file_read")).toHaveLength(1);
  });

  it("says why the lines of a row cannot be shown, in the row, and the other rows stay (A-34)", async () => {
    await define();
    await waitForCount("#orca-definition-list .orca-def", 3);
    await mock("lsp_read_outside", rejects("ファイルを読めません"));
    await defRow(1).$(".orca-def-toggle").click();
    await expect(defRow(1).$(".orca-file-note.fail")).toHaveText("ファイルを読めません");
    expect(await count("#orca-definition-list .orca-def")).toBe(3);
  });

  it("opens a place in the worktree as an editor tab, with the caret at its line (A-34)", async () => {
    await define();
    await waitForCount("#orca-definition-list .orca-def", 3);
    const read = await mock("orca_file_read", text(rows(40), "ruby"));
    await press(0, "open");
    expect(await waitForCalls(read)).toEqual([{ path: worktree, relative: "app/lib/rails_ext.rb", environment: null }]);
    await expect($(".orca-edit-area")).toHaveValue(rows(40), { trim: false });
    expect(await tabTitles()).toEqual(expect.arrayContaining(["a.rb", "rails_ext.rb"]));
    await expect($(".orca-edit-path")).toHaveText("app/lib/rails_ext.rb");
    await browser.waitUntil(async () => (await caret()) === caretOf(rows(40), 6, 2), { timeoutMsg: "the caret never went to the line of the definition" });
    expect(await count(".orca-tab-gem")).toBe(0);
  });

  it("goes to the line of a file that is open already, in its own tab (A-34)", async () => {
    await define();
    await waitForCount("#orca-definition-list .orca-def", 3);
    await mock("orca_file_read", text(rows(40), "ruby"));
    await press(0, "open");
    await expect($(".orca-edit-area")).toHaveValue(rows(40), { trim: false });
    await browser.waitUntil(async () => (await caret()) === caretOf(rows(40), 6, 2));
    // The caret leaves the line, and the tab of the first file is selected; the same open selects the tab again, with the caret back at the line.
    await browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.setSelectionRange(0, 0));
    await $('.orca-tab[data-file="true"] [role="tab"]').click();
    await expect($(".orca-edit-area")).toHaveValue(source, { trim: false });
    await press(0, "open");
    await expect($(".orca-edit-area")).toHaveValue(rows(40), { trim: false });
    await browser.waitUntil(async () => (await caret()) === caretOf(rows(40), 6, 2), { timeoutMsg: "the caret never went back to the line" });
    expect(await count('.orca-tabs [data-file="true"]')).toBe(2);
  });

  it("opens a place outside the worktree as a read only tab with a lock and gem, read by lsp_read_outside, and saves nothing (A-34)", async () => {
    await define();
    await waitForCount("#orca-definition-list .orca-def", 3);
    const rails = rows(30);
    const read = await mock("lsp_read_outside", { path: gem.path, text: rails });
    const write = await mock("orca_file_write", { state: "saved", signature: "sig-2" });
    await press(1, "open");
    expect(await waitForCalls(read)).toEqual([{ environment: null, project: "proj_example-app", worktree, path: gem.path }]);
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
    await contextAt(onRails());
    await expect($("#orca-definition-list .orca-file-note.fail")).toHaveText("言語サーバーがまだ準備できていません");
    expect(await textsOf("#orca-definition-head > span")).toEqual(["Rails"]);
    expect(await count("#orca-definition-list .orca-def")).toBe(0);
    expect(await callsOf("lsp_places")).toEqual([]);
  });

  it("says there is no definition when the server gives none (A-34)", async () => {
    await define([], []);
    await expect($("#orca-definition-list .orca-file-note")).toHaveText("定義はありません");
    expect(await textsOf("#orca-definition-head > span")).toEqual(["Rails", "0 件"]);
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
    await expect($("#orca-definition")).not.toBeDisplayed();
    await expect($("#orca-files-tree")).toBeDisplayed();
  });

  it("asks for nothing where the mouse is on no name or past the end of a line, and keeps the pane as it is (A-34)", async () => {
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
    await expect($("#orca-definition")).not.toBeDisplayed();
  });

  it("asks for nothing in a file that is not Ruby (A-34)", async () => {
    await openFiles();
    await openFileWith("notes.txt", text("Rails is here\n", "plaintext", null));
    await answer();
    await contextAt(2);
    await browser.pause(300);
    expect(await prevented()).toBe(false);
    expect(await callsOf("lsp_word")).toEqual([]);
    expect(await callsOf("lsp_definition")).toEqual([]);
  });

  it("keeps the list when the pane is switched to the files and back, and asks again at the next press (A-34)", async () => {
    await define();
    await waitForCount("#orca-definition-list .orca-def", 3);
    await mode("ファイル").click();
    await expect($("#orca-files-tree")).toBeDisplayed();
    await expect($("#orca-definition")).not.toBeDisplayed();
    await mode("定義").click();
    await expect($("#orca-definition")).toBeDisplayed();
    expect(await count("#orca-definition-list .orca-def")).toBe(3);
    expect(await callsOf("lsp_definition")).toHaveLength(1);
    await mock("lsp_definition", [gem]);
    await mock("lsp_places", [gemPlace]);
    await mock("lsp_read_outside", { path: gem.path, text: rows(30) });
    await contextAt(onRails());
    await waitForCount("#orca-definition-list .orca-def", 1);
    expect(await textsOf("#orca-definition-head > span")).toEqual(["Rails", "1 件"]);
  });
});
