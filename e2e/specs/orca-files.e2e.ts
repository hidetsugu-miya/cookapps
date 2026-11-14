import type { MarkdownParts } from "../../ts/bindings/MarkdownParts";
import type { MarkdownPatchResult } from "../../ts/bindings/MarkdownPatchResult";
import type { OrcaCommit } from "../../ts/bindings/OrcaCommit";
import type { OrcaCommitFile } from "../../ts/bindings/OrcaCommitFile";
import type { OrcaCommitFiles } from "../../ts/bindings/OrcaCommitFiles";
import type { OrcaCommitList } from "../../ts/bindings/OrcaCommitList";
import type { OrcaDiffRow } from "../../ts/bindings/OrcaDiffRow";
import type { OrcaDir } from "../../ts/bindings/OrcaDir";
import type { OrcaFileDiff } from "../../ts/bindings/OrcaFileDiff";
import type { OrcaFileText } from "../../ts/bindings/OrcaFileText";
import type { OrcaLocalBranch } from "../../ts/bindings/OrcaLocalBranch";
import type { OrcaRemoteBranch } from "../../ts/bindings/OrcaRemoteBranch";
import type { OrcaSaved } from "../../ts/bindings/OrcaSaved";
import type { PaneLayout } from "../../ts/bindings/PaneLayout";
import type { PaneNode } from "../../ts/bindings/PaneNode";
import {
  callsOf,
  copiedTexts,
  count,
  fontSettings,
  holds,
  mock,
  onceId,
  orcaOverview,
  orcaRow,
  orcaSsh,
  orcaTerminal,
  orcaWorktree,
  rejects,
  release,
  sendStream,
  streamList,
  stubClipboard,
  textsOf,
  timers,
  waitForCalls,
  waitForCount,
} from "../support";
import { claudeTab, openOrca, pickItem, project, sample, selectedTab, showAgain, studio, tabOf, tabTitles, worktrees } from "../orca-support";

// A-18: the file pane and the editor. Rust reads the folders, reads and saves the text, and decides whether a save went through (unit tests); here the screen is checked: what it asks of Rust, and how it draws the answers.
describe("orca: files and editor (A-18)", () => {
  const claude = claudeTab("example-app");
  const zsh = "orca:term_example-app_zsh";
  const pane = (id: string, tabs: string[], selected = tabs[0]): PaneNode => ({ kind: "pane", id, tabs, selected });
  const layout = (root: PaneNode, focus: string): PaneLayout => ({ root, focus });
  // The entries of the folder `dir`: [name, is a folder, ignored by git]. Rust lists a folder with no entry marked unless the folder itself is ignored (the third is then true); the marks of the others come from `orca_files_ignored`.
  const dirOf = (dir: string, entries: [string, boolean, boolean?][]): OrcaDir => ({
    entries: entries.map(([name, isDirectory, ignored = false]) => ({ name, path: dir === "" ? name : `${dir}/${name}`, isDirectory, ignored })),
    total: entries.length,
  });
  const root = () =>
    dirOf("", [
      ["src", true],
      ["target", true],
      ["a.rs", false],
      ["b.log", false],
    ]);
  // What `orca_files_ignored` answers for the root.
  const rootIgnored = ["target", "b.log"];
  const isIgnored = (path: string) => browser.execute((p) => document.querySelector<HTMLElement>(`.orca-file[data-path="${p}"]`)?.dataset.ignored, path);
  const text = (content: string, signature = "sig-1", language = "plaintext", highlight: string | null = null): OrcaFileText => ({ content, crlf: false, signature, language, highlight });
  const saved = (signature: string): OrcaSaved => ({ state: "saved", signature });
  const names = () => textsOf("#orca-files-tree .orca-file-name");
  // The button of the file pane that is on the screen (one at a time: the corner pane's while the pane is hidden, the pane's own while it is shown).
  const filesToggle = () => $(".orca-files-toggle:not([hidden])");
  const toggleBoxes = () =>
    browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>(".orca-files-toggle")]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { top: r.top, right: r.right, bottom: r.bottom, inFiles: e.closest("#orca-files") !== null, pressed: e.getAttribute("aria-pressed"), label: e.getAttribute("aria-label") };
        }),
    );
  const row = (path: string) => $(`#orca-files-tree .orca-file[data-path="${path}"]`);
  const stateText = () => $(".orca-edit-state");
  const dirtyMarks = () => count(".orca-tab-dirty");

  // The app with the example-app project selected, its Claude session the selected tab, the file pane open and its root read.
  async function openFiles(fixtures: Record<string, unknown> = {}, value = orcaOverview(sample(), worktrees())) {
    await openOrca(value, { orca_terminal_read: ["$"], orca_files_list: root(), orca_files_ignored: rootIgnored, editor_settings: { autosaveMs: 100 }, ...fixtures });
    await project("example-app").click();
    await expect(selectedTab()).toBeDisplayed();
    await filesToggle().click();
    await expect($("#orca-files")).toBeDisplayed();
  }

  // The window gets the focus back (the app is activated): the file pane reads again what it shows (A-18, A-27).
  const focusBack = () => browser.execute(() => window.dispatchEvent(new Event("focus")));

  // The page's own double press on a file of the tree, and typing in the editor shown (value, then input).
  const doublePress = (path: string) =>
    browser.execute(
      (p, once) => {
        if (!window.__e2e_once__(once)) return;
        document.querySelector(`.orca-file[data-path="${p}"]`)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      },
      path,
      onceId(),
    );
  const type = (add: string) =>
    browser.execute(
      (t, once) => {
        if (!window.__e2e_once__(once)) return;
        const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
        area.value += t;
        area.dispatchEvent(new Event("input", { bubbles: true }));
      },
      add,
      onceId(),
    );
  // highlight.js is read the first time a file is colored (#414), so the colors come a little after the text: waits for the library and for the frame that draws the layer again.
  const waitForColors = async () => {
    await browser.waitUntil(() => browser.execute("return typeof hljs !== 'undefined'"), { timeoutMsg: "highlight.js was never read" });
    await browser.execute("return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
  };
  // Opens a.rs with the answer of the read and waits for its text (and for its colors, when the answer has a grammar).
  async function openFileWith(read: OrcaFileText, rows = 4) {
    await mock("orca_file_read", read);
    await waitForCount("#orca-files-tree .orca-file", rows);
    await doublePress("a.rs");
    await expect($(".orca-edit-area")).toHaveValue(read.content, { trim: false });
    if (read.highlight) await waitForColors();
  }
  // Opens a.rs with `content` and waits for its text (`rows` is how many rows the tree has).
  const openA = (content = "fn main() {}\n", signature = "sig-1", rows = 4) => openFileWith(text(content, signature), rows);

  it("draws the text of the editor with the family and size chosen in the settings (A-20), apart from the terminals", async () => {
    await openFiles({ font_settings: fontSettings({ editor: { family: "Menlo", size: 18, ghostty: false }, orcaWork: { family: null, size: 13, ghostty: false } }) });
    await openA();
    const area = () => browser.execute(() => ({ size: getComputedStyle(document.querySelector(".orca-edit-area")!).fontSize, family: getComputedStyle(document.querySelector(".orca-edit-area")!).fontFamily }));
    await browser.waitUntil(async () => (await area()).size === "18px", { timeoutMsg: "the editor never took the size" });
    expect((await area()).family).toContain("Menlo");
  });

  it("draws the heading of the editor with the family and size chosen for the work pane, and the text with those of the editor (A-20)", async () => {
    await openFiles({ font_settings: fontSettings({ orcaPane: { family: "Menlo", size: 21, ghostty: false } }) });
    await openA();
    const head = () => browser.execute(() => ({ size: getComputedStyle(document.querySelector(".orca-edit-head")!).fontSize, family: getComputedStyle(document.querySelector(".orca-edit-head")!).fontFamily }));
    // The heading is 12px of its own: 12 * 21 / 14.
    await browser.waitUntil(async () => (await head()).size === "18px", { timeoutMsg: "the heading never took the size" });
    expect((await head()).family).toContain("Menlo");
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".orca-edit-area")!).fontSize)).toBe("12.5px");
  });

  it("keeps the text of the tab bar, the tabs, the file pane's heading and the editor's heading inside their boxes at the largest size of the work pane (A-20)", async () => {
    await openFiles({ font_settings: fontSettings({ orcaPane: { family: null, size: 32, ghostty: false } }) });
    await openA();
    await browser.waitUntil(async () => (await browser.execute(() => getComputedStyle(document.getElementById("orca-work")!).fontSize)) === "32px", { timeoutMsg: "the work pane never took the size" });
    const outside = await browser.execute(() => {
      const pairs: [string, string][] = [
        [".orca-tabbar", ".orca-tab"],
        [".orca-tab", ".orca-tab-title"],
        ["#orca-files-head", "#orca-files-title"],
        [".orca-edit-head", ".orca-edit-path"],
        [".orca-edit-head", ".orca-edit-state"],
      ];
      const found: string[] = [];
      let checked = 0;
      for (const [box, text] of pairs) {
        for (const t of document.querySelectorAll(`${box} ${text}`)) {
          const b = t.closest(box)!.getBoundingClientRect();
          const r = t.getBoundingClientRect();
          checked++;
          if (r.height > 0 && (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5)) found.push(`${text} in ${box}`);
        }
      }
      return { found, checked };
    });
    expect(outside.checked).toBeGreaterThanOrEqual(5);
    expect(outside.found).toEqual([]);
  });

  it("draws the text of the editor with the first font while none is chosen", async () => {
    await openFiles();
    await openA();
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".orca-edit-area")!).fontSize)).toBe("12.5px");
  });

  // A-21: the colors of the editor. The language is Rust's (`orca_file_read` answers `language` and `highlight`); the tokens are the highlighter's elements under the textarea.
  const tokens = (kind: string) => textsOf(`.orca-edit-hl .hljs-${kind}`);
  const layerText = () => browser.execute(() => document.querySelector(".orca-edit-hl")!.textContent);
  const rust = (content: string) => text(content, "sig-1", "rust", "rust");

  it("colors the text of a file by its language, in a layer under the textarea that holds the same text (A-21)", async () => {
    await openFiles();
    await openFileWith(rust('fn main() {\n    let x = "a"; // note\n}\n'));
    expect(await tokens("keyword")).toEqual(["fn", "let"]);
    expect(await tokens("string")).toEqual(['"a"']);
    expect(await tokens("comment")).toEqual(["// note"]);
    expect(await layerText()).toBe('fn main() {\n    let x = "a"; // note\n}\n');
    await expect($(".orca-edit-hl")).toHaveAttribute("aria-hidden", "true");
  });

  it("reads xterm.js with the first terminal and highlight.js with the first colored file, and not at the start (#414)", async () => {
    const read = (name: string) => browser.execute(`return typeof ${name} !== 'undefined'`);
    await openOrca(orcaOverview(sample(), worktrees()), { orca_terminal_read: ["$"], orca_files_list: root(), orca_files_ignored: rootIgnored, editor_settings: { autosaveMs: 100 } });
    expect(await read("hljs")).toBe(false);
    await project("example-app").click();
    await browser.waitUntil(() => read("Terminal"), { timeoutMsg: "xterm.js was never read" });
    expect(await read("hljs")).toBe(false);
    await filesToggle().click();
    await openFileWith(rust("fn a() {}\n"));
    expect(await read("hljs")).toBe(true);
    expect(await tokens("keyword")).toEqual(["fn"]);
  });

  it("shows the colors of the tokens and the caret of the textarea, whose own text is transparent (A-21)", async () => {
    await openFiles();
    await openFileWith(rust("fn a() {}\n"));
    const colors = await browser.execute(() => ({
      keyword: getComputedStyle(document.querySelector(".orca-edit-hl .hljs-keyword")!).color,
      plain: getComputedStyle(document.querySelector(".orca-edit-hl code")!).color,
      area: getComputedStyle(document.querySelector(".orca-edit-area")!).color,
    }));
    expect(colors.keyword).toBe("rgb(207, 34, 46)");
    expect(colors.area).toBe("rgba(0, 0, 0, 0)");
    expect(colors.plain).not.toBe(colors.keyword);
  });

  it("draws the text plain, in the same layer, for a language the highlighter has no grammar for (A-21)", async () => {
    await openFiles();
    await openFileWith(text("const std = @import(\"std\");\n", "sig-1", "zig", null));
    expect(await count(".orca-edit-hl [class^='hljs-']")).toBe(0);
    expect(await layerText()).toBe('const std = @import("std");\n');
  });

  it("escapes the text of the file in the layer, so a tag in it stays text (A-21)", async () => {
    await openFiles();
    await openFileWith(text('<img src=x onerror="alert(1)"> &amp;\n', "sig-1", "plaintext", null));
    expect(await count(".orca-edit-hl img")).toBe(0);
    expect(await layerText()).toBe('<img src=x onerror="alert(1)"> &amp;\n');
  });

  // A-26: a Markdown file (the language Rust names `markdown`) opens in the rich view that Milkdown draws, and has the buttons of the source (`<>`) and the rich view (the pencil) in its heading. `markdown_split` is Rust's cut of the front matter and `markdown_patch` puts the edit of the rich view into the text: the mocks answer them, and the spec checks what the page sends, draws and saves.
  const markdown = (content: string) => text(content, "sig-1", "markdown", "markdown");
  const parts = (body: string, front = ""): MarkdownParts => ({ front, body });
  const patched = (text: string): MarkdownPatchResult => ({ kind: "patched", text });
  type PatchCall = { original: string; before: string; after: string };
  const modeButton = (label: string) => $(`.orca-edit-mode[aria-label="${label}"]`);
  const rich = (selector: string) => textsOf(`.orca-edit-rich .ProseMirror ${selector}`);
  // Opens a.rs as a Markdown file whose body (the text after its front matter) is `body`. `patch` is what Rust answers `markdown_patch` with (the text as it is, unless a spec says otherwise): the answer to the unchanged export decides whether the rich view can be edited.
  async function startMarkdown(content: string, body: string, front: string, patch: MarkdownPatchResult) {
    await mock("markdown_split", parts(body, front));
    await mock("markdown_patch", patch);
    await mock("orca_file_read", markdown(content));
    await waitForCount("#orca-files-tree .orca-file", 4);
    await doublePress("a.rs");
  }
  // Opens it and waits for the rich view to be drawn and to be editable.
  async function openMarkdown(content: string, body = content, front = "") {
    await startMarkdown(content, body, front, patched(content));
    await waitForCount(".orca-edit-rich .ProseMirror", 1);
    await $('.orca-edit-rich .ProseMirror[contenteditable="true"]').waitForExist({ timeoutMsg: "the rich view was never editable" });
  }
  // Types `t` at the end of the last paragraph of the rich view. The window of the E2E build has no focus, so a click does not focus the editor (and End does not move the caret): the script focuses it and puts the caret there, and the keys are real.
  async function typeRich(t: string) {
    await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".orca-edit-rich .ProseMirror")!;
      view.focus();
      const range = document.createRange();
      range.selectNodeContents(view.querySelector(":scope > p:last-child")!);
      range.collapse(false);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await browser.keys(t);
  }
  const mdSample = "# 見出し\n\n本文の **太字** と `code`\n\n- [x] 済み\n- [ ] 未\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";

  it("opens a Markdown file in the rich view, which Milkdown draws and which can be edited (A-26)", async () => {
    await openFiles();
    await openMarkdown(mdSample);
    expect(await rich("h1")).toEqual(["見出し"]);
    expect(await rich("strong")).toEqual(["太字"]);
    expect(await rich("p code")).toEqual(["code"]);
    expect(await rich("th")).toEqual(["a", "b"]);
    expect(await count('.orca-edit-rich li[data-item-type="task"]')).toBe(2);
    await expect($(".orca-edit-rich .ProseMirror")).toHaveAttribute("contenteditable", "true");
    await expect($(".orca-edit-rich")).toBeDisplayed();
    await expect($(".orca-edit-body")).not.toBeDisplayed();
    await expect(modeButton("リッチ")).toHaveAttribute("aria-pressed", "true");
    await expect(modeButton("ソース")).toHaveAttribute("aria-pressed", "false");
    expect(await callsOf("markdown_split")).toEqual([{ text: mdSample }]);
    // The unchanged export is what Rust is asked to put into the text, to know that it can.
    const [check] = (await callsOf("markdown_patch")) as PatchCall[];
    expect(check.original).toBe(mdSample);
    expect(check.before).toContain("見出し");
    expect(check.after).toBe(check.before);
  });

  it("reads Milkdown from vendor/ when the first Markdown file is drawn, and not at the start (A-26)", async () => {
    const read = () => browser.execute("return typeof CookappsMilkdown !== 'undefined'");
    await openFiles();
    expect(await read()).toBe(false);
    await openMarkdown("# a\n");
    expect(await read()).toBe(true);
  });

  it("gives Milkdown the body without the front matter, which Rust cuts off (A-26)", async () => {
    const content = "---\ntitle: 題\n---\n# 本文\n";
    await openFiles();
    await openMarkdown(content, "# 本文\n", "---\ntitle: 題\n---\n");
    expect(await callsOf("markdown_split")).toEqual([{ text: content }]);
    expect(await rich("h1")).toEqual(["本文"]);
    expect(await browser.execute(() => document.querySelector(".orca-edit-rich")!.textContent)).not.toContain("title");
  });

  it("switches a Markdown file to its source and back to the rich view with the buttons (A-26)", async () => {
    await openFiles();
    await openMarkdown("# 見出し\n");
    await modeButton("ソース").click();
    await expect($(".orca-edit-body")).toBeDisplayed();
    await expect($(".orca-edit-rich")).not.toBeDisplayed();
    await expect($(".orca-edit-area")).toHaveValue("# 見出し\n", { trim: false });
    await expect(modeButton("ソース")).toHaveAttribute("aria-pressed", "true");
    await expect(modeButton("リッチ")).toHaveAttribute("aria-pressed", "false");
    expect(await count(".orca-edit-rich .ProseMirror")).toBe(0);
    // The typing in the source is what the rich view draws next.
    await mock("orca_file_write", saved("sig-2"));
    await type("追記\n");
    await modeButton("リッチ").click();
    await waitForCount(".orca-edit-rich .ProseMirror", 1);
    await expect($(".orca-edit-rich")).toBeDisplayed();
    await expect($(".orca-edit-body")).not.toBeDisplayed();
    expect(await callsOf("markdown_split")).toEqual([{ text: "# 見出し\n" }, { text: "# 見出し\n追記\n" }]);
  });

  it("keeps the view of a Markdown file while it is open, when another tab is shown and the file again (A-26)", async () => {
    await openFiles();
    await openMarkdown("# 見出し\n");
    await modeButton("ソース").click();
    await tabOf(claude).$(".orca-tab-btn").click();
    await tabOf("file:1").$(".orca-tab-btn").click();
    await expect($(".orca-edit-area")).toBeDisplayed();
    await expect($(".orca-edit-rich")).not.toBeDisplayed();
    await expect(modeButton("ソース")).toHaveAttribute("aria-pressed", "true");
  });

  const front = "---\ntitle: 題\n---\n";
  const body = "# 見出し\n\n* 項目\n\n本文\n";
  const edited = `${front}# 見出し\n\n* 項目\n\n本文X\n`;

  it("puts what is typed in the rich view into the original text through markdown_patch, and saves that text (A-26)", async () => {
    const content = front + body;
    await openFiles();
    await openMarkdown(content, body, front);
    const [check] = (await callsOf("markdown_patch")) as PatchCall[];
    await mock("markdown_patch", patched(edited));
    const write = await mock("orca_file_write", saved("sig-2"));
    await typeRich("X");
    const [call] = (await waitForCalls("markdown_patch")) as PatchCall[];
    // The whole file with its front matter and its own notation is the original; the editor's exports are the before and after of its body.
    expect(call.original).toBe(content);
    expect(call.before).toBe(check.before);
    expect(call.after).toContain("本文X");
    expect(call.after).not.toContain("title");
    // What is saved is Rust's answer, not the export of the editor.
    expect(await waitForCalls(write)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: edited, crlf: false, signature: "sig-1", environment: null }]);
    await expect(stateText()).toHaveText("保存しました");
    await expect($(".orca-edit-area")).toHaveValue(edited, { trim: false });
  });

  it("shows the states of the save for an edit of the rich view as for typing in the source (A-26)", async () => {
    await openFiles({ editor_settings: { autosaveMs: 500 } });
    await openMarkdown(body);
    await mock("markdown_patch", patched(`${body}X`));
    const write = await mock("orca_file_write", holds);
    await typeRich("X");
    await expect(stateText()).toHaveText("保存待ち");
    expect(await dirtyMarks()).toBe(1);
    await waitForCalls(write);
    await expect(stateText()).toHaveText("保存中");
    await release(write, saved("sig-2"));
    await expect(stateText()).toHaveText("保存しました");
    await browser.waitUntil(async () => (await dirtyMarks()) === 0, { timeoutMsg: "the mark of the tab stayed" });
  });

  it("carries an edit of the rich view to the source at once, and the typing of the source back to the rich view (A-26)", async () => {
    const content = front + body;
    await openFiles();
    await openMarkdown(content, body, front);
    await mock("markdown_patch", patched(edited));
    await mock("orca_file_write", saved("sig-2"));
    await typeRich("X");
    // Pressed before the wait for more changes has passed: the edit is in the text area when the source is shown.
    await modeButton("ソース").click();
    await expect($(".orca-edit-area")).toHaveValue(edited, { trim: false });
    // The layers under the text area are drawn when the source is shown, not at each edit of the rich view.
    expect(await layerText()).toBe(edited);
    await expect($(".orca-edit-rich")).not.toBeDisplayed();
    await type("Y");
    await modeButton("リッチ").click();
    await waitForCount(".orca-edit-rich .ProseMirror", 1);
    expect(await callsOf("markdown_split")).toEqual([{ text: content }, { text: `${edited}Y` }]);
  });

  it("opens a file that Rust cannot put an edit into in the source, and shows its rich view read only (A-26)", async () => {
    await openFiles();
    await startMarkdown(body, body, "", { kind: "conflict" });
    await expect(modeButton("ソース")).toHaveAttribute("aria-pressed", "true");
    await expect($(".orca-edit-area")).toBeDisplayed();
    await expect($(".orca-edit-area")).toHaveValue(body, { trim: false });
    await modeButton("リッチ").click();
    await waitForCount(".orca-edit-rich .ProseMirror", 1);
    await waitForCalls("markdown_patch", 2);
    await browser.pause(300);
    await expect($(".orca-edit-rich .ProseMirror")).toHaveAttribute("contenteditable", "false");
    await expect(modeButton("リッチ")).toHaveAttribute("aria-pressed", "true");
  });

  it("switches to the source and saves nothing when Rust cannot put an edit into the text (A-26)", async () => {
    await openFiles();
    await openMarkdown(body);
    await mock("markdown_patch", { kind: "conflict" } satisfies MarkdownPatchResult);
    const write = await mock("orca_file_write", saved("sig-2"));
    await typeRich("X");
    await expect(modeButton("ソース")).toHaveAttribute("aria-pressed", "true");
    await expect($(".orca-edit-area")).toHaveValue(body, { trim: false });
    await browser.pause(800);
    expect(await callsOf(write)).toEqual([]);
  });

  it("shows no buttons for a file that is not Markdown, and its text stays in the editor (A-26)", async () => {
    await openFiles();
    await openFileWith(rust("fn main() {}\n"));
    await expect($(".orca-edit-modes")).not.toBeDisplayed();
    await expect($(".orca-edit-rich")).not.toBeDisplayed();
    await expect($(".orca-edit-area")).toBeDisplayed();
    expect(await callsOf("markdown_split")).toEqual([]);
  });

  it("colors the text again at each key, and the layer keeps the text of the textarea (A-21)", async () => {
    await openFiles();
    await openFileWith(rust("let a = 1;\n"));
    expect(await tokens("comment")).toEqual([]);
    await type("// typed\n");
    await browser.waitUntil(async () => (await tokens("comment")).length === 1, { timeoutMsg: "the typed line was never colored" });
    expect(await tokens("comment")).toEqual(["// typed"]);
    expect(await layerText()).toBe("let a = 1;\n// typed\n");
  });

  it("moves the layer with the scroll of the textarea (A-21)", async () => {
    await openFiles();
    await openFileWith(rust("let a = 1;\n".repeat(200)));
    await browser.execute(() => {
      const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
      area.scrollTop = 48;
      area.dispatchEvent(new Event("scroll"));
    });
    const moved = await browser.execute(() => document.querySelector<HTMLElement>(".orca-edit-hl code")!.style.transform);
    expect(moved.replace(/\s/g, "")).toBe("translate(0px,-48px)");
  });

  // A-18: the numbers of the lines, in a box at the left of the text (`.orca-edit-gutter`, one text node of the numbers in lines).
  const numbers = () => browser.execute(() => document.querySelector(".orca-edit-nums")!.textContent!.split("\n"));
  const countTo = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
  const gutterWidth = () => browser.execute(() => document.querySelector(".orca-edit-gutter")!.getBoundingClientRect().width);
  // The textarea's value set to `value`, as a deletion would.
  const setText = (value: string) =>
    browser.execute(
      (v, once) => {
        if (!window.__e2e_once__(once)) return;
        const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
        area.value = v;
        area.dispatchEvent(new Event("input", { bubbles: true }));
      },
      value,
      onceId(),
    );

  it("numbers the lines of the text from 1, one number for each line, in the font of the text and in a fainter color (A-18)", async () => {
    await openFiles();
    await openA("fn main() {\n    run();\n}\n");
    // The empty line after the last line break is a line of the textarea, and has its number.
    expect(await numbers()).toEqual(["1", "2", "3", "4"]);
    const look = await browser.execute(() => {
      const g = getComputedStyle(document.querySelector(".orca-edit-gutter")!);
      const a = getComputedStyle(document.querySelector(".orca-edit-area")!);
      const h = getComputedStyle(document.querySelector(".orca-edit-hl code")!);
      return { gutter: [g.fontFamily, g.fontSize, g.lineHeight, g.color, g.textAlign], area: [a.fontFamily, a.fontSize, a.lineHeight, a.color], code: h.color };
    });
    expect(look.gutter.slice(0, 3)).toEqual(look.area.slice(0, 3));
    expect(look.gutter[4]).toBe("right");
    expect(look.gutter[3]).not.toBe(look.code);
    expect(look.gutter[3]).toBe("rgb(90, 107, 98)");
  });

  it("numbers the lines with the family and size chosen for the editor (A-18, A-20)", async () => {
    await openFiles({ font_settings: fontSettings({ editor: { family: "Menlo", size: 18, ghostty: false }, orcaWork: { family: null, size: 13, ghostty: false } }) });
    await openA("a\nb\n");
    await browser.waitUntil(async () => (await browser.execute(() => getComputedStyle(document.querySelector(".orca-edit-gutter")!).fontSize)) === "18px", { timeoutMsg: "the numbers never took the size" });
    const font = await browser.execute(() => ({ gutter: getComputedStyle(document.querySelector(".orca-edit-gutter")!).fontFamily, area: getComputedStyle(document.querySelector(".orca-edit-area")!).fontFamily }));
    expect(font.gutter).toContain("Menlo");
    expect(font.gutter).toBe(font.area);
  });

  it("keeps the numbers in step with the lines as they are typed and deleted, and widens the box with the digits (A-18)", async () => {
    await openFiles();
    await openA("1\n2\n3\n4\n5\n6\n7\n8\n");
    expect(await numbers()).toEqual(countTo(9));
    const narrow = await gutterWidth();
    await type("9\n");
    await browser.waitUntil(async () => (await numbers()).length === 10, { timeoutMsg: "the numbers never grew" });
    expect(await numbers()).toEqual(countTo(10));
    expect(await gutterWidth()).toBeGreaterThan(narrow);
    await setText("1\n2\n3\n");
    await browser.waitUntil(async () => (await numbers()).length === 4, { timeoutMsg: "the numbers never shrank" });
    expect(await numbers()).toEqual(countTo(4));
    expect(await gutterWidth()).toBe(narrow);
    // Typing inside a line changes no number.
    await setText("1\n2x\n3\n");
    expect(await numbers()).toEqual(countTo(4));
    // An empty text is one line.
    await setText("");
    await browser.waitUntil(async () => (await numbers()).length === 1, { timeoutMsg: "the numbers never came back to one" });
    expect(await numbers()).toEqual(["1"]);
  });

  it("numbers a long text, and one line more at a key (A-18)", async () => {
    await openFiles();
    await openA("x\n".repeat(5000));
    expect(await numbers()).toEqual(countTo(5001));
    await type("y\n");
    await browser.waitUntil(async () => (await numbers()).length === 5002, { timeoutMsg: "the numbers never grew" });
    expect(await numbers()).toEqual(countTo(5002));
  });

  it("moves the numbers with the vertical scroll of the text and not with the horizontal one (A-18)", async () => {
    await openFiles();
    await openA(`${"x".repeat(400)}\n`.repeat(200));
    const before = await browser.execute(() => document.querySelector(".orca-edit-gutter")!.getBoundingClientRect().left);
    await browser.execute(() => {
      const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
      area.scrollTop = 48;
      area.scrollLeft = 60;
      area.dispatchEvent(new Event("scroll"));
    });
    const moved = await browser.execute(() => {
      const nums = document.querySelector<HTMLElement>(".orca-edit-nums")!;
      return { transform: nums.style.transform, left: document.querySelector(".orca-edit-gutter")!.getBoundingClientRect().left, numsLeft: nums.getBoundingClientRect().left };
    });
    expect(moved.transform.replace(/\s/g, "")).toBe("translateY(-48px)");
    expect(moved.left).toBe(before);
    expect(moved.numsLeft).toBe(before);
    // The first number of the rows still in view sits on the line of the text it numbers: the text is 48 px up, and so are the numbers.
    const rows = await browser.execute(() => {
      const nums = document.querySelector(".orca-edit-nums")!.getBoundingClientRect();
      const gutter = document.querySelector(".orca-edit-gutter")!.getBoundingClientRect();
      return { up: gutter.top - nums.top };
    });
    expect(rows.up).toBe(48);
  });

  it("forwards the wheel over the numbers to the text (A-18)", async () => {
    await openFiles();
    await openA("x\n".repeat(300));
    await browser.execute((once) => {
      if (!window.__e2e_once__(once)) return;
      document.querySelector(".orca-edit-gutter")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 64, bubbles: true, cancelable: true }));
    }, onceId());
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.scrollTop)) === 64, { timeoutMsg: "the text never scrolled" });
    // The numbers follow at the scroll event, which comes after the scroll itself.
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector<HTMLElement>(".orca-edit-nums")!.style.transform.replace(/\s/g, ""))) === "translateY(-64px)", { timeoutMsg: "the numbers never followed" });
  });

  it("keeps the numbers out of the selection, the copy and the reading aloud, and out of the textarea (A-18)", async () => {
    await openFiles();
    await openA("alpha\nbeta\n");
    const gutter = await browser.execute(() => {
      const g = document.querySelector<HTMLElement>(".orca-edit-gutter")!;
      const area = document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!;
      area.focus();
      area.select();
      return { hidden: g.getAttribute("aria-hidden"), userSelect: getComputedStyle(g).getPropertyValue("-webkit-user-select"), inArea: area.contains(g), selected: area.value.slice(area.selectionStart, area.selectionEnd), value: area.value };
    });
    expect(gutter.hidden).toBe("true");
    expect(gutter.userSelect).toBe("none");
    expect(gutter.inArea).toBe(false);
    // What a copy of the text takes is the text and nothing of the numbers.
    expect(gutter.selected).toBe("alpha\nbeta\n");
    expect(gutter.value).toBe("alpha\nbeta\n");
  });

  it("colors a long text after it is read, and draws it again with the typed line within the wait (A-21)", async () => {
    await openFiles();
    const long = "let a = 1;\n".repeat(3000);
    await openFileWith(rust(long));
    await browser.waitUntil(async () => (await count(".orca-edit-hl .hljs-keyword")) > 0, { timeoutMsg: "the long text was never colored" });
    await type("let b = 2;\n");
    await browser.waitUntil(async () => (await tokens("keyword")).length === 3001, { timeoutMsg: "the typed line was never colored" });
    expect(await layerText()).toBe(`${long}let b = 2;\n`);
  });

  it("has the colors in variables of the page, apart from the layout (A-21)", async () => {
    await openFiles();
    await openFileWith(rust("fn a() {}\n"));
    await browser.execute(() => document.documentElement.style.setProperty("--hl-keyword", "rgb(1, 2, 3)"));
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".orca-edit-hl .hljs-keyword")!).color)).toBe("rgb(1, 2, 3)");
  });

  it("has one button that shows and hides the file pane: in the upper row of the pane while it is shown, at the right end of the tab strip while it is hidden", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_terminal_read: ["$"] });
    await expect($("#orca-files")).not.toBeDisplayed();
    await expect($("#orca-files-split")).not.toBeDisplayed();
    const hidden = await toggleBoxes();
    expect(hidden).toHaveLength(1);
    expect(hidden[0].inFiles).toBe(false);
    expect(hidden[0].pressed).toBe("false");
    expect(hidden[0].label).toBe("ファイル欄");
    await mock("orca_files_list", root());
    await project("example-app").click();
    await filesToggle().click();
    await expect($("#orca-files")).toBeDisplayed();
    await expect($("#orca-files-split")).toBeDisplayed();
    const shown = await toggleBoxes();
    expect(shown).toHaveLength(1);
    expect(shown[0].inFiles).toBe(true);
    expect(shown[0].pressed).toBe("true");
    expect(shown[0].label).toBe("ファイル欄");
    const box = await browser.execute(() => {
      const r = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { workRight: r("#orca-work").right, splitLeft: r("#orca-files-split").left, splitRight: r("#orca-files-split").right, filesLeft: r("#orca-files").left, filesRight: r("#orca-files").right, share: r("#orca-files").width / r("#orca").width, barTop: r("#orca-files-bar").top, barHeight: r("#orca-files-bar").height, headTop: r("#orca-files-head").top, headBottom: r("#orca-files-head").bottom, tabsTop: r(".orca-tabbar").top, tabs: r(".orca-tabbar").height, toggleRight: r("#orca-files-toggle").right };
    });
    expect(box.workRight).toBeLessThanOrEqual(box.splitLeft + 1);
    expect(box.splitRight).toBeLessThanOrEqual(box.filesLeft + 1);
    expect(box.share).toBeCloseTo(0.22, 2);
    // The upper row is as high as the tab strip and level with it; the heading is under it. The button is at the right end of the row.
    expect(box.barHeight).toBe(box.tabs);
    expect(box.barTop).toBe(box.tabsTop);
    expect(box.headTop).toBeGreaterThanOrEqual(box.barTop + box.barHeight - 1);
    expect(box.toggleRight).toBeLessThanOrEqual(box.filesRight);
    expect(box.filesRight - box.toggleRight).toBeLessThanOrEqual(8);
    await filesToggle().click();
    await expect($("#orca-files")).not.toBeDisplayed();
    await expect($("#orca-files-split")).not.toBeDisplayed();
    const back = await toggleBoxes();
    expect(back).toHaveLength(1);
    expect(back[0].inFiles).toBe(false);
    expect(back[0].pressed).toBe("false");
    const corner = await browser.execute(() => {
      const bar = document.querySelector(".orca-tabbar")!.getBoundingClientRect();
      const toggle = document.querySelector(".orca-tabbar .orca-files-toggle:not([hidden])")!.getBoundingClientRect();
      const plus = document.querySelector(".orca-plus")!.getBoundingClientRect();
      return { barRight: bar.right, toggleRight: toggle.right, plusRight: plus.right };
    });
    expect(corner.toggleRight).toBeLessThanOrEqual(corner.barRight);
    expect(corner.toggleRight).toBeGreaterThan(corner.plusRight);
  });

  it("moves the focus to the button that is shown when the focused button is pressed", async () => {
    await openOrca(orcaOverview(sample(), worktrees()), { orca_terminal_read: ["$"] });
    await mock("orca_files_list", root());
    await project("example-app").click();
    await $(".orca-tabbar [data-tab]").waitForDisplayed();
    // A press from the keyboard is a click on the focused button; the shown terminal would take the keys of WebDriver, so the click is made on the focused button itself.
    const pressFocused = (selector: string) =>
      browser.execute((s) => {
        const b = document.querySelector<HTMLElement>(s)!;
        b.focus();
        b.click();
        const a = document.activeElement;
        return { files: a?.closest("#orca-files") !== null, tabs: a?.closest(".orca-tabbar") !== null, toggle: a?.classList.contains("orca-files-toggle") ?? false };
      }, selector);
    const shown = await pressFocused(".orca-tabbar .orca-files-toggle:not([hidden])");
    await expect($("#orca-files")).toBeDisplayed();
    expect(shown).toEqual({ files: true, tabs: false, toggle: true });
    const hidden = await pressFocused("#orca-files-toggle");
    await expect($("#orca-files")).not.toBeDisplayed();
    expect(hidden).toEqual({ files: false, tabs: true, toggle: true });
  });

  it("puts the button in the pane in the top right corner only", async () => {
    const two = orcaOverview(sample(), worktrees(), { terminals: [orcaTerminal("example-app", "zsh")] });
    const side = layout({ kind: "split", direction: "row", children: [pane("p1", [claude]), pane("p2", [zsh])], sizes: [0.5, 0.5] }, "p1");
    await openOrca(two, { orca_terminal_read: ["$"], orca_panes: side });
    await project("example-app").click();
    await waitForCount(".orca-pane", 2);
    await expect($('.orca-pane[data-pane="p1"] .orca-files-toggle')).not.toBeDisplayed();
    await expect($('.orca-pane[data-pane="p2"] .orca-files-toggle')).toBeDisplayed();
    expect(await toggleBoxes()).toHaveLength(1);
    const stacked = layout({ kind: "split", direction: "column", children: [pane("p1", [claude]), pane("p2", [zsh])], sizes: [0.5, 0.5] }, "p1");
    await openOrca(two, { orca_terminal_read: ["$"], orca_panes: stacked });
    await project("example-app").click();
    await waitForCount(".orca-pane", 2);
    await expect($('.orca-pane[data-pane="p1"] .orca-files-toggle')).toBeDisplayed();
    await expect($('.orca-pane[data-pane="p2"] .orca-files-toggle')).not.toBeDisplayed();
    expect(await toggleBoxes()).toHaveLength(1);
  });

  it("shows the heading of the selected session's worktree, reads its root, and draws the folders first, with the ignored ones in italics once git has answered", async () => {
    await openFiles({ orca_files_ignored: holds });
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/a");
    await waitForCount("#orca-files-tree .orca-file", 4);
    expect(await callsOf("orca_files_list")).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    // The folder is drawn while git has not answered: nothing is marked yet, and the question is the entries of the list in its order.
    expect(await waitForCalls("orca_files_ignored")).toEqual([{ path: "/work/example-app", paths: ["src", "target", "a.rs", "b.log"], environment: null }]);
    const kinds = () => browser.execute(() => [...document.querySelectorAll<HTMLElement>(".orca-file")].map((e) => [e.dataset.kind, e.dataset.ignored]));
    expect(await kinds()).toEqual([["dir", "false"], ["dir", "false"], ["file", "false"], ["file", "false"]]);
    await release("orca_files_ignored", rootIgnored);
    await browser.waitUntil(async () => (await isIgnored("b.log")) === "true", { timeoutMsg: "the ignored mark never came" });
    expect(await kinds()).toEqual([["dir", "false"], ["dir", "true"], ["file", "false"], ["file", "true"]]);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    const look = await browser.execute(() => {
      const style = (path: string) => getComputedStyle(document.querySelector(`.orca-file[data-path="${path}"] .orca-file-name`)!);
      const row = (path: string) => getComputedStyle(document.querySelector(`.orca-file[data-path="${path}"]`)!);
      return { plain: style("a.rs").fontStyle, ignored: style("b.log").fontStyle, plainOpacity: row("a.rs").opacity, ignoredOpacity: row("b.log").opacity };
    });
    expect(look).toEqual({ plain: "normal", ignored: "italic", plainOpacity: "1", ignoredOpacity: "0.55" });
  });

  it("marks nothing when git cannot answer, and shows no message for it", async () => {
    await openFiles({ orca_files_ignored: rejects("Orca に接続できません") });
    await waitForCount("#orca-files-tree .orca-file", 4);
    await waitForCalls("orca_files_ignored");
    await browser.pause(300);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    expect(await isIgnored("target")).toBe("false");
    expect(await count("#orca-files-tree .orca-file-note")).toBe(0);
  });

  it("reads a folder when it is pressed the first time, and draws it from what was read when it is opened again", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const list = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "src", ignored: false, environment: null }]);
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await names()).toEqual(["src", "lib", "main.rs", "target", "a.rs", "b.log"]);
    // A child is one level in.
    const depths = await browser.execute(() => ["src", "src/lib"].map((p) => document.querySelector<HTMLElement>(`.orca-file[data-path="${p}"]`)!.style.getPropertyValue("--depth")));
    expect(depths).toEqual(["0", "1"]);
    await row("src").click();
    await expect(row("src")).toHaveAttribute("aria-expanded", "false");
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    // Opened again, it is drawn at once from the list that is held: neither the folder nor its marks are asked for again.
    const marks = await mock("orca_files_ignored", ["src/lib"]);
    await row("src").click();
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await names()).toEqual(["src", "lib", "main.rs", "target", "a.rs", "b.log"]);
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(1);
    expect(await callsOf(marks)).toEqual([]);
  });

  it("has no reload button in the heading of the pane, for the files or for the history", async () => {
    await openFiles(historyFixtures());
    await waitForCount("#orca-files-tree .orca-file", 4);
    await expect($("#orca-files-title")).toBeDisplayed();
    expect(await count("#orca-files-head button:not(.orca-branch-btn)")).toBe(0);
    expect(await count("#orca-files-reload")).toBe(0);
    await paneMode("履歴").click();
    expect(await count("#orca-files-reload")).toBe(0);
  });

  it("reads the root and the open folders again when the window gets the focus back", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 5);
    const list = await mock("orca_files_list", dirOf("", [["src", true], ["new.rs", false]]));
    await focusBack();
    const calls = await waitForCalls(list, 2);
    expect(calls).toEqual([
      { path: "/work/example-app", dir: "", ignored: false, environment: null },
      { path: "/work/example-app", dir: "src", ignored: false, environment: null },
    ]);
  });

  it("reads nothing at the return of the focus while the file pane is hidden or the history is shown, and not a second time while a read is on its way", async () => {
    await openFiles(historyFixtures());
    await waitForCount("#orca-files-tree .orca-file", 4);
    const list = await mock("orca_files_list", holds);
    await focusBack();
    await waitForCalls(list);
    await focusBack();
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(1);
    await release(list, root());
    await browser.pause(300);
    const again = await mock("orca_files_list", root());
    await paneMode("履歴").click();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await focusBack();
    await browser.pause(300);
    expect(await callsOf(again)).toEqual([]);
    await paneMode("ファイル").click();
    await filesToggle().click();
    await expect($("#orca-files")).not.toBeDisplayed();
    await focusBack();
    await browser.pause(300);
    expect(await callsOf(again)).toEqual([]);
  });

  it("reads the root alone first, then the open folders again side by side, not one after the other", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 5);
    await mock("orca_files_list", dirOf("src/lib", [["x", false]]));
    await row("src/lib").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    const list = await mock("orca_files_list", holds);
    await focusBack();
    // Only the root is on its way while it has not been answered.
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(1);
    await release(list, dirOf("", [["src", true], ["target", true]]));
    // Both folders are on their way while neither has been answered.
    expect(await waitForCalls(list, 3)).toEqual([
      { path: "/work/example-app", dir: "", ignored: false, environment: null },
      { path: "/work/example-app", dir: "src", ignored: false, environment: null },
      { path: "/work/example-app", dir: "src/lib", ignored: false, environment: null },
    ]);
    await release(list, dirOf("src", [["lib", true]]));
    await release(list, dirOf("src/lib", [["y", false]]));
    await browser.waitUntil(async () => (await names()).join() === "src,lib,y,target", { timeoutMsg: "the reads never drew" });
  });

  it("reads at most 16 folders at once, after the root, when the focus comes back", async () => {
    const folders = Array.from({ length: 17 }, (_, i) => `d${i}`);
    await openFiles({ orca_files_list: dirOf("", folders.map((f) => [f, true])) });
    await waitForCount("#orca-files-tree .orca-file", 17);
    for (const f of folders) {
      const list = await mock("orca_files_list", dirOf(f, [["x", false]]));
      await row(f).click();
      await waitForCalls(list);
    }
    await waitForCount("#orca-files-tree .orca-file", 34);
    const list = await mock("orca_files_list", holds);
    await focusBack();
    await waitForCalls(list);
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(1);
    await release(list, dirOf("", folders.map((f) => [f, true])));
    await waitForCalls(list, 17);
    await browser.pause(300);
    expect(await callsOf(list)).toHaveLength(17);
    // One answer frees one place, and the last folder is read.
    await release(list, dirOf("d0", [["x", false]]));
    expect(await waitForCalls(list, 18)).toHaveLength(18);
  });

  it("keeps the ignored marks through a read again until git answers, and keeps them when git cannot", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await browser.waitUntil(async () => (await isIgnored("b.log")) === "true", { timeoutMsg: "the ignored mark never came" });
    const marks = await mock("orca_files_ignored", holds);
    await focusBack();
    await waitForCalls(marks);
    await browser.pause(300);
    expect(await isIgnored("b.log")).toBe("true");
    expect(await isIgnored("target")).toBe("true");
    expect(await isIgnored("a.rs")).toBe("false");
    // The answer replaces the marks: b.log is no longer named.
    await release(marks, ["target"]);
    await browser.waitUntil(async () => (await isIgnored("b.log")) === "false", { timeoutMsg: "the answer never replaced the marks" });
    expect(await isIgnored("target")).toBe("true");
    // An answer that fails leaves the kept marks.
    const failing = await mock("orca_files_ignored", rejects("Orca に接続できません"));
    await focusBack();
    await waitForCalls(failing);
    await browser.pause(300);
    expect(await isIgnored("target")).toBe("true");
  });

  it("reads a folder that was closed again after the focus came back, because the read dropped it", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 5);
    await row("src").click();
    await expect(row("src")).toHaveAttribute("aria-expanded", "false");
    const list = await mock("orca_files_list", dirOf("", [["src", true], ["target", true]]));
    await focusBack();
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "src,target", { timeoutMsg: "the root never drew" });
    const inner = await mock("orca_files_list", dirOf("src", [["new.rs", false]]));
    await row("src").click();
    expect(await waitForCalls(inner)).toEqual([{ path: "/work/example-app", dir: "src", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "src,new.rs,target", { timeoutMsg: "the folder was not read again" });
  });

  it("does not ask for the ignore marks of a folder that the list marked as ignored", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await browser.waitUntil(async () => (await isIgnored("target")) === "true", { timeoutMsg: "the ignored mark never came" });
    const marks = await mock("orca_files_ignored", []);
    const list = await mock("orca_files_list", dirOf("target", [["debug", true, true]]));
    await row("target").click();
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "target", ignored: true, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 5);
    expect(await isIgnored("target/debug")).toBe("true");
    // A folder in it is ignored as well, and is read as one.
    const inner = await mock("orca_files_list", dirOf("target/debug", [["x", false, true]]));
    await row("target/debug").click();
    expect(await waitForCalls(inner)).toEqual([{ path: "/work/example-app", dir: "target/debug", ignored: true, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 6);
    await browser.pause(300);
    expect(await callsOf(marks)).toEqual([]);
  });

  it("asks for the ignore marks of a folder that is opened, after it is drawn", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const marks = await mock("orca_files_ignored", ["src/gen.rs"]);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["gen.rs", false]]));
    await row("src").click();
    expect(await waitForCalls(marks)).toEqual([{ path: "/work/example-app", paths: ["src/lib", "src/gen.rs"], environment: null }]);
    await browser.waitUntil(async () => (await isIgnored("src/gen.rs")) === "true", { timeoutMsg: "the ignored mark never came" });
    expect(await isIgnored("src/lib")).toBe("false");
  });

  it("drops the ignore marks that come after another worktree's tree took the place", async () => {
    const value = orcaOverview(sample(), [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b" })], {
      terminals: [orcaTerminal("example-app", "zsh", { path: "/work/example-app-b", branch: "feat/b" })],
    });
    await openFiles({ orca_files_ignored: holds }, value);
    await waitForCount("#orca-files-tree .orca-file", 4);
    await waitForCalls("orca_files_ignored");
    const list = await mock("orca_files_list", dirOf("", [["target", true]]));
    await tabOf(zsh).$(".orca-tab-btn").click();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/b");
    await waitForCalls(list);
    await browser.waitUntil(async () => (await names()).join() === "target", { timeoutMsg: "the tree of the other worktree never showed" });
    // The answer for the first worktree comes now, and names a path the new tree has too.
    await release("orca_files_ignored", ["target"]);
    await browser.pause(300);
    expect(await isIgnored("target")).toBe("false");
  });

  it("shows another worktree's tree, and its name, when another tab is selected", async () => {
    const value = orcaOverview(sample(), [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b" })], {
      terminals: [orcaTerminal("example-app", "zsh", { path: "/work/example-app-b", branch: "feat/b" })],
    });
    await openFiles({}, value);
    await waitForCount("#orca-files-tree .orca-file", 4);
    const list = await mock("orca_files_list", dirOf("", [["only-b.rs", false]]));
    await tabOf(zsh).$(".orca-tab-btn").click();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/b");
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app-b", dir: "", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "only-b.rs", { timeoutMsg: "the tree of the other worktree never showed" });
  });

  // example-idle has no session (so no tab), and lists a worktree that is not the main one before the main one; example-app has a Claude session in a worktree that is not the main one.
  const withIdle = (extra: Record<string, unknown> = {}, more: ReturnType<typeof orcaWorktree>[] = []) =>
    orcaOverview(
      [orcaRow("example-app", "feat/b", "Write the docs", { path: "/work/example-app-b" })],
      [
        orcaWorktree("example-app", "main"),
        orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b" }),
        orcaWorktree("example-idle", "feat/z", { path: "/work/example-idle-z" }),
        orcaWorktree("example-idle", "main"),
        ...more,
      ],
      extra,
    );

  it("shows the main worktree of the selected project when it has no tab, and the selected tab's worktree once a project with a tab is selected", async () => {
    await openOrca(withIdle(), { orca_terminal_read: ["$"], orca_files_list: root() });
    await project("example-idle").click();
    await expect($(".orca-empty")).toHaveText("セッションはありません");
    await filesToggle().click();
    await expect($("#orca-files-title")).toHaveText("example-idle ・ main");
    await waitForCount("#orca-files-tree .orca-file", 4);
    expect(await callsOf("orca_files_list")).toEqual([{ path: "/work/example-idle", dir: "", ignored: false, environment: null }]);
    const list = await mock("orca_files_list", dirOf("", [["only-b.rs", false]]));
    await project("example-app").click();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/b");
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app-b", dir: "", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "only-b.rs", { timeoutMsg: "the tree of the selected tab never showed" });
  });

  it("opens a file of the main worktree in a tab when the project has no tab", async () => {
    await openOrca(withIdle(), { orca_terminal_read: ["$"], orca_files_list: root(), editor_settings: { autosaveMs: 100 } });
    await project("example-idle").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const read = await mock("orca_file_read", text("fn main() {}\n"));
    await doublePress("a.rs");
    expect(await waitForCalls(read)).toEqual([{ path: "/work/example-idle", relative: "a.rs", environment: null }]);
    await expect(selectedTab().$(".orca-tab-title")).toHaveText("a.rs");
    await expect($("#orca-files-title")).toHaveText("example-idle ・ main");
  });

  it("keeps the open folders and does not read the root again when the first file of a project with no tab is opened", async () => {
    await openOrca(withIdle(), { orca_terminal_read: ["$"], orca_files_list: root(), editor_settings: { autosaveMs: 100 } });
    await project("example-idle").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const inner = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCalls(inner);
    await waitForCount("#orca-files-tree .orca-file", 6);
    const list = await mock("orca_files_list", root());
    const read = await mock("orca_file_read", text("fn main() {}\n"));
    await doublePress("src/main.rs");
    expect(await waitForCalls(read)).toEqual([{ path: "/work/example-idle", relative: "src/main.rs", environment: null }]);
    await expect(selectedTab().$(".orca-tab-title")).toHaveText("main.rs");
    await expect($("#orca-files-title")).toHaveText("example-idle ・ main");
    expect(await names()).toEqual(["src", "lib", "main.rs", "target", "a.rs", "b.log"]);
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await callsOf(list)).toEqual([]);
  });

  it("reads no worktree for an SSH host's row with no tab, even when the list holds a main worktree of the host: the pane is the host's scratchpad folder (A-30)", async () => {
    const hostRow = { key: "ssh:s1", name: "s1", status: "idle" as const, sessions: 0, atMs: 0 };
    const hostTree = orcaWorktree("remote-app", "main", { path: "/home/dev/remote-app", projectKey: "ssh:s1", isMain: true });
    await openOrca(withIdle({ ssh: [orcaSsh("s1", "example-host")], hosts: [hostRow] }, [hostTree]), { orca_terminal_read: ["$"], orca_files_list: root(), ssh_scratch_list: [] });
    await project("example-idle").click();
    await filesToggle().click();
    await expect($("#orca-files-title")).toHaveText("example-idle ・ main");
    const list = await mock("orca_files_list", root());
    await $('#orca-feed .orca-project[data-key="ssh:s1"]').click();
    await expect($("#orca-files-title")).toHaveText("~/.local/share/cookapps/scratchpad/");
    expect(await count("#orca-files-tree .orca-file")).toBe(0);
    await focusBack();
    await browser.pause(300);
    expect(await callsOf(list)).toEqual([]);
  });

  it("reads a saved environment's files with its name", async () => {
    await openOrca(orcaOverview(sample(), worktrees(), studio), { orca_terminal_read: ["$"], orca_files_list: root() });
    await project("example-app").click();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 4);
    expect(await callsOf("orca_files_list")).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: "Studio" }]);
  });

  it("shows the message of a root that cannot be read, and of a folder that cannot", async () => {
    await openFiles({ orca_files_list: rejects("Orca に接続できません") });
    await expect($("#orca-files-tree .orca-file-note.fail")).toHaveText("Orca に接続できません");
    await mock("orca_files_list", root());
    // The next return of the focus reads the root that failed again.
    await focusBack();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", rejects("ファイルが見つかりません"));
    await row("src").click();
    await expect($("#orca-files-tree .orca-file-note.fail")).toHaveText("ファイルが見つかりません");
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
  });

  it("says how many more entries a folder holds than were listed", async () => {
    await openFiles({ orca_files_list: { ...dirOf("", [["a.rs", false]]), total: 5001 } });
    await expect($("#orca-files-tree .orca-file-note")).toHaveText("ほか 5000 件");
  });

  it("opens a file in a tab with a file mark on a double press, selects it, and colors the file in the tree", async () => {
    await openFiles();
    const read = await mock("orca_file_read", text("fn main() {}\n"));
    await waitForCount("#orca-files-tree .orca-file", 4);
    // A single press only selects: nothing is read.
    await row("a.rs").click();
    expect(await callsOf(read)).toEqual([]);
    await expect(row("a.rs")).toHaveAttribute("data-open", "false");
    await doublePress("a.rs");
    expect(await waitForCalls(read)).toEqual([{ path: "/work/example-app", relative: "a.rs", environment: null }]);
    await expect(tabOf("file:1")).toBeExisting();
    await expect(selectedTab().$(".orca-tab-title")).toHaveText("a.rs");
    expect(await count('.orca-tabs [data-tab="file:1"] .orca-file-tab-ic')).toBe(1);
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n", { trim: false });
    await expect($(".orca-edit-path")).toHaveText("a.rs");
    await expect($(".orca-term")).not.toBeDisplayed();
    await expect(row("a.rs")).toHaveAttribute("data-open", "true");
    // The tab was asked for as one of the project's tabs.
    const asked = (await callsOf("orca_panes")).map((c) => (c as { tabs: string[] }).tabs);
    expect(asked[asked.length - 1]).toEqual([claude, "file:1"]);
    // The heading still names the worktree, with the file selected.
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/a");
    expect(await browser.execute(() => document.activeElement?.classList.contains("orca-edit-area"))).toBe(true);
  });

  it("opens a file that is open already by selecting its tab, and reads it again as it comes back into the pane: the text of the disk takes the place of the one held", async () => {
    await openFiles();
    await openA();
    await tabOf(claude).$(".orca-tab-btn").click();
    await expect($(".orca-edit-area")).not.toBeExisting();
    // The file changed on the disk while its tab was not shown.
    const read = await mock("orca_file_read", text("fn main() {}\n// outside\n", "sig-2"));
    await doublePress("a.rs");
    await expect(selectedTab().$(".orca-tab-title")).toHaveText("a.rs");
    expect(await count(".orca-tabs [data-file]")).toBe(1);
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n// outside\n", { trim: false });
    expect((await callsOf(read))[0]).toEqual({ path: "/work/example-app", relative: "a.rs", environment: null });
    expect(await dirtyMarks()).toBe(0);
  });

  it("keeps the typing of a file when another tab is shown and the file again", async () => {
    await openFiles({ editor_settings: { autosaveMs: 3000 } });
    await openA();
    await type("// more\n");
    await tabOf(claude).$(".orca-tab-btn").click();
    await tabOf("file:1").$(".orca-tab-btn").click();
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n// more\n", { trim: false });
    expect(await callsOf("orca_file_read")).toHaveLength(1);
  });

  it("shows the message of a file that cannot be read in the tab, with no editor", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_file_read", rejects("バイナリのファイルは開けません"));
    await doublePress("a.rs");
    await expect($(".orca-edit .orca-empty")).toHaveText("バイナリのファイルは開けません");
    await expect($(".orca-edit-area")).not.toBeDisplayed();
    expect(await dirtyMarks()).toBe(0);
  });

  it("saves by itself once the typing has stopped: waiting, saving, saved, and the mark of the tab goes", async () => {
    await openFiles({ editor_settings: { autosaveMs: 500 } });
    await openA();
    await expect(stateText()).toHaveText("");
    const write = await mock("orca_file_write", holds);
    await type("// x\n");
    expect(await dirtyMarks()).toBe(1);
    await expect(stateText()).toHaveText("保存待ち");
    expect(await callsOf(write)).toEqual([]);
    expect(await waitForCalls(write)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\n// x\n", crlf: false, signature: "sig-1", environment: null }]);
    await expect(stateText()).toHaveText("保存中");
    expect(await dirtyMarks()).toBe(1);
    await release(write, saved("sig-2"));
    await expect(stateText()).toHaveText("保存しました");
    await browser.waitUntil(async () => (await dirtyMarks()) === 0, { timeoutMsg: "the mark of the tab stayed" });
  });

  it("saves the typing that waits for its timer when the page is hidden for good", async () => {
    await openFiles({ editor_settings: { autosaveMs: 3000 } });
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await type("// x\n");
    await expect(stateText()).toHaveText("保存待ち");
    expect(await callsOf(write)).toEqual([]);
    await browser.execute((once) => {
      if (!window.__e2e_once__(once)) return;
      window.dispatchEvent(new Event("pagehide"));
    }, onceId());
    expect(await waitForCalls(write)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\n// x\n", crlf: false, signature: "sig-1", environment: null }]);
    await expect(stateText()).toHaveText("保存しました");
  });

  it("restarts the wait with each key, and saves the whole text once", async () => {
    await openFiles({ editor_settings: { autosaveMs: 600 } });
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await type("1");
    await browser.pause(300);
    await type("2");
    await browser.pause(300);
    await type("3");
    expect(await callsOf(write)).toEqual([]);
    const calls = await waitForCalls(write);
    expect((calls[0] as { content: string }).content).toBe("fn main() {}\n123");
    await browser.pause(800);
    expect(await callsOf(write)).toHaveLength(1);
  });

  it("sends the signature of the last save with the next one", async () => {
    await openFiles();
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await type("a");
    await waitForCalls(write);
    await expect(stateText()).toHaveText("保存しました");
    await mock("orca_file_write", saved("sig-3"));
    await type("b");
    const calls = await waitForCalls("orca_file_write");
    expect(calls).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\nab", crlf: false, signature: "sig-2", environment: null }]);
  });

  it("sends what was typed while a save was on its way as the next save, once the first is done", async () => {
    await openFiles();
    await openA();
    const write = await mock("orca_file_write", holds);
    await type("a");
    await waitForCalls(write);
    await type("b");
    await release(write, saved("sig-2"));
    await expect(stateText()).not.toHaveText("保存しました");
    await mock("orca_file_write", saved("sig-3"));
    const calls = await waitForCalls("orca_file_write");
    expect(calls).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\nab", crlf: false, signature: "sig-2", environment: null }]);
    await expect(stateText()).toHaveText("保存しました");
    await browser.waitUntil(async () => (await dirtyMarks()) === 0, { timeoutMsg: "the mark of the tab stayed" });
  });

  it("does not save a file that the disk changed, says so in the heading, keeps the mark, and does not try again", async () => {
    await openFiles();
    await openA();
    const write = await mock("orca_file_write", { state: "changed", signature: "sig-1" } satisfies OrcaSaved);
    await type("a");
    await waitForCalls(write);
    await expect(stateText()).toHaveText("ディスクのファイルが変わっています");
    expect(await dirtyMarks()).toBe(1);
    await type("b");
    await browser.pause(600);
    expect(await callsOf(write)).toHaveLength(1);
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\nab", { trim: false });
    await expect($("#error")).not.toBeDisplayed();
  });

  it("says when the file is gone or is no longer text", async () => {
    await openFiles();
    await openA();
    await mock("orca_file_write", { state: "missing", signature: "sig-1" } satisfies OrcaSaved);
    await type("a");
    await expect(stateText()).toHaveText("ファイルが見つかりません");
    await tabOf(claude).$(".orca-tab-btn").click();
    await mock("orca_file_read", text("x\n", "sig-x"));
    await mock("orca_files_list", dirOf("", [["a.rs", false], ["c.rs", false]]));
    await focusBack();
    await waitForCount("#orca-files-tree .orca-file", 2);
    await doublePress("c.rs");
    await mock("orca_file_write", { state: "not-utf8", signature: "sig-x" } satisfies OrcaSaved);
    await type("b");
    await expect(stateText()).toHaveText("ディスクのファイルが UTF-8 ではなくなっています");
  });

  it("shows the message of a save that failed, and saves again with the next typing", async () => {
    await openFiles();
    await openA();
    await mock("orca_file_write", rejects("Orca に接続できません"));
    await type("a");
    await expect($("#error")).toHaveText("Orca に接続できません");
    await expect(stateText()).toHaveText("保存できません");
    expect(await dirtyMarks()).toBe(1);
    const again = await mock("orca_file_write", saved("sig-2"));
    await type("b");
    expect(await waitForCalls(again)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\nab", crlf: false, signature: "sig-1", environment: null }]);
    await expect(stateText()).toHaveText("保存しました");
  });

  it("saves the typing of a file when its tab is closed, then closes it", async () => {
    await openFiles({ editor_settings: { autosaveMs: 3000 } });
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await type("a");
    await tabOf("file:1").$(".orca-tab-close").click();
    expect(await waitForCalls(write)).toEqual([{ path: "/work/example-app", relative: "a.rs", content: "fn main() {}\na", crlf: false, signature: "sig-1", environment: null }]);
    await expect(tabOf("file:1")).not.toBeExisting();
    expect(await tabTitles()).toEqual(["Write the docs"]);
    await expect(row("a.rs")).toHaveAttribute("data-open", "false");
    await expect($(".orca-term")).toBeDisplayed();
  });

  it("closes a file with nothing to save without a save", async () => {
    await openFiles();
    await openA();
    const write = await mock("orca_file_write", saved("sig-2"));
    await tabOf("file:1").$(".orca-tab-close").click();
    await expect(tabOf("file:1")).not.toBeExisting();
    expect(await callsOf(write)).toEqual([]);
  });

  it("keeps the tab of a file whose save failed, and closes one whose save was refused", async () => {
    await openFiles({ editor_settings: { autosaveMs: 3000 } });
    await openA();
    await mock("orca_file_write", rejects("Orca に接続できません"));
    await type("a");
    await tabOf("file:1").$(".orca-tab-close").click();
    await expect($("#error")).toHaveText("Orca に接続できません");
    await expect(tabOf("file:1")).toBeExisting();
    expect(await dirtyMarks()).toBe(1);
    await mock("orca_file_write", { state: "changed", signature: "sig-1" } satisfies OrcaSaved);
    await tabOf("file:1").$(".orca-tab-close").click();
    await expect(tabOf("file:1")).not.toBeExisting();
  });

  it("opens a second file as a second tab, each with its own text", async () => {
    await openFiles({ orca_files_list: dirOf("", [["a.rs", false], ["b.rs", false]]) });
    await openA("fn main() {}\n", "sig-1", 2);
    await mock("orca_file_read", text("pub fn b() {}\n", "sig-b"));
    await doublePress("b.rs");
    await expect($(".orca-edit-area")).toHaveValue("pub fn b() {}\n", { trim: false });
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs", "b.rs"]);
    // a.rs comes back into the pane and is read again: the disk still holds the text that was read, so it stays.
    const again = await mock("orca_file_read", text("fn main() {}\n", "sig-1"));
    await tabOf("file:1").$(".orca-tab-btn").click();
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n", { trim: false });
    expect((await waitForCalls(again))[0]).toEqual({ path: "/work/example-app", relative: "a.rs", environment: null });
  });

  // The right button on a row of the tree, as the page gets it; whether the page kept the browser's own menu from showing.
  const rightClickRow = (path: string) =>
    browser.execute(
      (p, once) => {
        if (!window.__e2e_once__(once)) return false;
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
        document.querySelector(`.orca-file[data-path="${p}"]`)!.dispatchEvent(event);
        return event.defaultPrevented;
      },
      path,
      onceId(),
    );

  // Whether the last item of the open menu is 「削除」 and is drawn in the danger color (the variable --danger), unlike the item before it.
  const deleteItemIsRed = () =>
    browser.execute(() => {
      const items = [...document.querySelectorAll<HTMLElement>('.menu[role="menu"] button')];
      const last = items[items.length - 1];
      const danger = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim();
      const probe = document.createElement("span");
      probe.style.color = danger;
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return last.textContent === "削除" && danger !== "" && getComputedStyle(last).color === expected && getComputedStyle(items[items.length - 2]).color !== expected;
    });

  it("opens a menu of the two copies, the download, the diff, the move and the delete on the right button of a file, and writes the path and the path from the worktree", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await stubClipboard();
    expect(await rightClickRow("a.rs")).toBe(true);
    await expect($('.menu[role="menu"]')).toBeDisplayed();
    expect(await textsOf('.menu[role="menu"] button')).toEqual(["パスのコピー", "相対パスをコピー", "ダウンロード", "差分を表示", "移動・名前の変更", "削除"]);
    expect(await count('.menu[role="menu"] button svg')).toBe(6);
    expect(await count('.menu[role="menu"] .pdot')).toBe(0);
    // One line, before the move and the delete, which is last and in red.
    expect(await textsOf('.menu[role="menu"] > *')).toEqual(["パスのコピー", "相対パスをコピー", "ダウンロード", "差分を表示", "", "移動・名前の変更", "削除"]);
    expect(await count('.menu[role="menu"] > [role="separator"]')).toBe(1);
    expect(await deleteItemIsRed()).toBe(true);
    await pickItem("パスのコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "the path was never copied" });
    await expect($(".toast")).toHaveText(expect.stringContaining("パスをコピーしました"));
    await expect($(".menu")).not.toExist();
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("相対パスをコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 2, { timeoutMsg: "the relative path was never copied" });
    expect(await copiedTexts()).toEqual(["/work/example-app/a.rs", "a.rs"]);
  });

  it("opens the same menu on a folder, and on a file in an open folder with its path from the worktree", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    await stubClipboard();
    expect(await rightClickRow("src")).toBe(true);
    expect(await textsOf('.menu[role="menu"] button')).toEqual(["新規ファイル", "新規フォルダー", "パスのコピー", "相対パスをコピー", "移動・名前の変更", "削除"]);
    expect(await count('.menu[role="menu"] button svg')).toBe(6);
    expect(await count('.menu[role="menu"] .pdot')).toBe(0);
    // One line between the two items that make something and the two copies, and one before the move and the delete.
    expect(await textsOf('.menu[role="menu"] > *')).toEqual(["新規ファイル", "新規フォルダー", "", "パスのコピー", "相対パスをコピー", "", "移動・名前の変更", "削除"]);
    expect(await count('.menu[role="menu"] > [role="separator"]')).toBe(2);
    expect(await deleteItemIsRed()).toBe(true);
    await pickItem("パスのコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "the path was never copied" });
    expect(await rightClickRow("src/main.rs")).toBe(true);
    await pickItem("相対パスをコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 2, { timeoutMsg: "the relative path was never copied" });
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await rightClickRow("src/main.rs")).toBe(true);
    await pickItem("パスのコピー");
    await browser.waitUntil(async () => (await copiedTexts()).length === 3, { timeoutMsg: "the path was never copied" });
    expect(await copiedTexts()).toEqual(["/work/example-app/src", "src/main.rs", "/work/example-app/src/main.rs"]);
  });

  // A-18: a new file or folder. The menu of a folder (and of the empty part of the tree, for the root) asks for a name in a field that is the first row of the folder; Rust checks the name and makes it.
  const treeOrder = () =>
    browser.execute(() => [...document.querySelectorAll("#orca-files-tree > *")].map((e) => (e.classList.contains("orca-file-new") ? "[field]" : ((e as HTMLElement).dataset.path ?? e.className))));
  const fieldFocused = () => browser.execute(() => document.activeElement?.classList.contains("orca-file-input") === true);
  // The field loses the keys inside the window. The window of an E2E run is never the front one, so the document is made to say it has the focus (a loss of the keys without it is the window going to the back, which commits nothing).
  const blurField = () =>
    browser.execute(() => {
      document.hasFocus = () => true;
      (document.activeElement as HTMLElement).blur();
    });
  // The right button on the empty part of the tree, at 20px from its left and half way down (below its four rows, and clear of the window's bottom, which would move the menu), as the page gets it.
  const rightClickEmpty = () =>
    browser.execute(
      (once) => {
        if (!window.__e2e_once__(once)) return null;
        const tree = document.getElementById("orca-files-tree")!;
        const r = tree.getBoundingClientRect();
        const [x, y] = [r.left + 20, r.top + r.height / 2];
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
        tree.dispatchEvent(event);
        return { prevented: event.defaultPrevented, x, y };
      },
      onceId(),
    );
  // The folder src opened for a new file: the menu, the read of src, and the field as the first row in it.
  async function askNameInSrc(item = "新規ファイル") {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const list = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    expect(await rightClickRow("src")).toBe(true);
    await pickItem(item);
    await waitForCalls(list);
    await waitForCount("#orca-files-tree .orca-file", 6);
    return list;
  }

  it("opens the folder with a field for the name as its first row, with the keys in it, when a new file is chosen from the menu of a folder", async () => {
    const list = await askNameInSrc();
    expect(await callsOf(list)).toEqual([{ path: "/work/example-app", dir: "src", ignored: false, environment: null }]);
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(await treeOrder()).toEqual(["src", "[field]", "src/lib", "src/main.rs", "target", "a.rs", "b.log"]);
    expect(await fieldFocused()).toBe(true);
    await expect($(".orca-file-input")).toHaveAttribute("aria-label", "新しいファイルの名前");
    expect(await browser.execute(() => document.querySelector<HTMLElement>(".orca-file-new")!.style.getPropertyValue("--depth"))).toBe("1");
    expect(await count(".orca-file-new .orca-file-ic svg")).toBe(1);
    expect(await count(".orca-file-new input[placeholder]")).toBe(0);
    await expect($(".menu")).not.toExist();
  });

  it("makes the file the name is typed for on Enter, with the folder and the trimmed name, reads the folder again and opens the file in the editor", async () => {
    await askNameInSrc();
    const create = await mock("orca_file_create", "src/new.rs");
    const list = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false], ["new.rs", false]]));
    const read = await mock("orca_file_read", text("fn new() {}\n", "sig-n"));
    await browser.keys(" new.rs ");
    await browser.keys("Enter");
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-app", dir: "src", name: "new.rs", folder: false, environment: null }]);
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "src", ignored: false, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 7);
    expect(await treeOrder()).toEqual(["src", "src/lib", "src/main.rs", "src/new.rs", "target", "a.rs", "b.log"]);
    expect(await waitForCalls(read)).toEqual([{ path: "/work/example-app", relative: "src/new.rs", environment: null }]);
    await expect($(".orca-edit-area")).toHaveValue("fn new() {}\n", { trim: false });
    await expect($("#error")).not.toBeDisplayed();
  });

  it("makes a folder for the name typed after the new folder item, reads the folder again and opens nothing", async () => {
    await askNameInSrc("新規フォルダー");
    await expect($(".orca-file-input")).toHaveAttribute("aria-label", "新しいフォルダーの名前");
    const create = await mock("orca_file_create", "src/gen");
    const list = await mock("orca_files_list", dirOf("src", [["gen", true], ["lib", true], ["main.rs", false]]));
    const read = await mock("orca_file_read", text("x"));
    await browser.keys("gen");
    await browser.keys("Enter");
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-app", dir: "src", name: "gen", folder: true, environment: null }]);
    await waitForCalls(list);
    await waitForCount("#orca-files-tree .orca-file", 7);
    expect(await treeOrder()).toEqual(["src", "src/gen", "src/lib", "src/main.rs", "target", "a.rs", "b.log"]);
    await browser.pause(300);
    expect(await callsOf(read)).toEqual([]);
    await expect($(".orca-edit-area")).not.toExist();
  });

  it("cancels on Escape and on a blank name, and calls nothing", async () => {
    await askNameInSrc();
    const create = await mock("orca_file_create", "src/x");
    await browser.keys("abc");
    await browser.keys("Escape");
    await waitForCount(".orca-file-new", 0);
    expect(await treeOrder()).toEqual(["src", "src/lib", "src/main.rs", "target", "a.rs", "b.log"]);
    expect(await rightClickRow("src")).toBe(true);
    await pickItem("新規ファイル");
    await waitForCount(".orca-file-new", 1);
    await browser.keys("   ");
    await browser.keys("Enter");
    await waitForCount(".orca-file-new", 0);
    await browser.pause(300);
    expect(await callsOf(create)).toEqual([]);
    await expect($("#error")).not.toBeDisplayed();
  });

  it("makes the file when the field loses the keys after a name was typed, and cancels when it loses them with none typed", async () => {
    await askNameInSrc();
    const create = await mock("orca_file_create", "src/b.rs");
    await mock("orca_file_read", text("b"));
    await mock("orca_files_list", dirOf("src", [["b.rs", false]]));
    await browser.keys("b.rs");
    await blurField();
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-app", dir: "src", name: "b.rs", folder: false, environment: null }]);
    await waitForCount(".orca-file-new", 0);
    expect(await rightClickRow("src")).toBe(true);
    await pickItem("新規フォルダー");
    await waitForCount(".orca-file-new", 1);
    expect(await fieldFocused()).toBe(true);
    await blurField();
    await waitForCount(".orca-file-new", 0);
    await browser.pause(300);
    expect(await callsOf(create)).toHaveLength(1);
  });

  it("says the name is taken when Orca refuses it, makes nothing and takes the field away", async () => {
    await askNameInSrc();
    const create = await mock("orca_file_create", rejects("同じ名前があります"));
    const list = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await browser.keys("main.rs");
    await browser.keys("Enter");
    await waitForCalls(create);
    await expect($("#error")).toHaveText("同じ名前があります");
    await waitForCount(".orca-file-new", 0);
    expect(await treeOrder()).toEqual(["src", "src/lib", "src/main.rs", "target", "a.rs", "b.log"]);
    await browser.pause(300);
    expect(await callsOf(list)).toEqual([]);
    await expect($(".orca-edit-area")).not.toExist();
  });

  it("opens a menu of the new file and the new folder at the pointer on the right button on the empty part of the tree, and asks for the name at the root", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const click = await rightClickEmpty();
    expect(click?.prevented).toBe(true);
    await expect($('.menu[role="menu"]')).toBeDisplayed();
    expect(await textsOf('.menu[role="menu"] button')).toEqual(["新規ファイル", "新規フォルダー"]);
    expect(await count('.menu[role="menu"] [role="separator"]')).toBe(0);
    expect(await count('.menu[role="menu"] button svg')).toBe(2);
    const at = await browser.execute(() => {
      const r = document.querySelector(".menu")!.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top) };
    });
    expect(at).toEqual({ left: Math.round(click!.x), top: Math.round(click!.y) });
    await pickItem("新規ファイル");
    await waitForCount(".orca-file-new", 1);
    expect(await treeOrder()).toEqual(["[field]", "src", "target", "a.rs", "b.log"]);
    expect(await browser.execute(() => document.querySelector<HTMLElement>(".orca-file-new")!.style.getPropertyValue("--depth"))).toBe("0");
    expect(await fieldFocused()).toBe(true);
    const create = await mock("orca_file_create", "top.txt");
    const list = await mock("orca_files_list", dirOf("", [["src", true], ["top.txt", false]]));
    await mock("orca_file_read", text("t"));
    await browser.keys("top.txt");
    await browser.keys("Enter");
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-app", dir: "", name: "top.txt", folder: false, environment: null }]);
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 2);
  });

  it("makes a folder at the root from the menu of the empty part, and does not open that menu on a row", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    expect(await rightClickRow("a.rs")).toBe(true);
    expect(await textsOf('.menu[role="menu"] button')).toEqual(["パスのコピー", "相対パスをコピー", "ダウンロード", "差分を表示", "移動・名前の変更", "削除"]);
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
    await rightClickEmpty();
    await pickItem("新規フォルダー");
    await waitForCount(".orca-file-new", 1);
    await expect($(".orca-file-input")).toHaveAttribute("aria-label", "新しいフォルダーの名前");
    const create = await mock("orca_file_create", "docs");
    await mock("orca_files_list", dirOf("", [["docs", true], ["src", true]]));
    await browser.keys("docs");
    await browser.keys("Enter");
    expect(await waitForCalls(create)).toEqual([{ path: "/work/example-app", dir: "", name: "docs", folder: true, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 2);
  });

  // A-18: the delete. 「削除」 asks first in a popup of the app, and only its red button deletes, for good.
  const confirmButtons = () => textsOf('.pop[role="alertdialog"] button');
  async function askDelete(path: string) {
    expect(await rightClickRow(path)).toBe(true);
    await pickItem("削除");
    await expect($('.pop[role="alertdialog"]')).toBeDisplayed();
  }
  const pressDelete = () => $('.pop[role="alertdialog"] .text-btn.danger').click();

  it("asks before deleting a file, with its name, a red 「削除」 and 「キャンセル」 that has the keys, and calls nothing until 「削除」 is pressed", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const del = await mock("orca_file_delete", null);
    await askDelete("a.rs");
    await expect($(".menu")).not.toExist();
    await expect($('.pop[role="alertdialog"] p')).toHaveText("a.rs を完全に削除します。元に戻せません。");
    expect(await confirmButtons()).toEqual(["削除", "キャンセル"]);
    expect(await browser.execute(() => document.activeElement?.textContent)).toBe("キャンセル");
    await browser.pause(200);
    expect(await callsOf(del)).toEqual([]);
  });

  it("calls nothing on 「キャンセル」, on Escape and on a press elsewhere", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const del = await mock("orca_file_delete", null);
    await askDelete("a.rs");
    await $('.pop[role="alertdialog"] .text-btn:not(.danger)').click();
    await expect($('.pop[role="alertdialog"]')).not.toExist();
    await askDelete("a.rs");
    await browser.keys("Escape");
    await expect($('.pop[role="alertdialog"]')).not.toExist();
    await askDelete("b.log");
    // WebDriver's element click sends no pointerdown, which is what closes the popup: the page's own press elsewhere.
    await browser.execute(
      (once) => {
        if (!window.__e2e_once__(once)) return;
        document.getElementById("orca-files-bar")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 5, isPrimary: true }));
      },
      onceId(),
    );
    await expect($('.pop[role="alertdialog"]')).not.toExist();
    await browser.pause(200);
    expect(await callsOf(del)).toEqual([]);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
  });

  it("deletes a file for good on 「削除」 with the worktree, the path and no recursion, reads its folder again, closes its tab and says nothing", async () => {
    await openFiles();
    await openA();
    await expect($(".orca-edit-area")).toBeDisplayed();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    const del = await mock("orca_file_delete", null);
    const list = await mock("orca_files_list", dirOf("", [["src", true], ["target", true], ["b.log", false]]));
    const write = await mock("orca_file_write", saved("sig-2"));
    await askDelete("a.rs");
    await pressDelete();
    expect(await waitForCalls(del)).toEqual([{ path: "/work/example-app", relative: "a.rs", folder: false, environment: null }]);
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 3);
    expect(await names()).toEqual(["src", "target", "b.log"]);
    await expect($(".orca-edit-area")).not.toExist();
    expect(await tabTitles()).toEqual(["Write the docs"]);
    await expect($('.pop[role="alertdialog"]')).not.toExist();
    await expect($("#error")).not.toBeDisplayed();
    expect(await callsOf(write)).toEqual([]);
  });

  it("deletes a folder with everything in it (recursive), closes the tabs of the files under it only, and drops what was read of it", async () => {
    await openFiles();
    await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    await mock("orca_file_read", text("fn main() {}\n", "sig-m"));
    await doublePress("src/main.rs");
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n", { trim: false });
    await mock("orca_file_read", text("a", "sig-a"));
    await doublePress("a.rs");
    await browser.waitUntil(async () => (await tabTitles()).length === 3, { timeoutMsg: "the second file never opened" });
    expect(await tabTitles()).toEqual(["Write the docs", "main.rs", "a.rs"]);
    const del = await mock("orca_file_delete", null);
    const list = await mock("orca_files_list", dirOf("", [["target", true], ["a.rs", false], ["b.log", false]]));
    await askDelete("src");
    await expect($('.pop[role="alertdialog"] p')).toHaveText("src を完全に削除します。元に戻せません。");
    await pressDelete();
    expect(await waitForCalls(del)).toEqual([{ path: "/work/example-app", relative: "src", folder: true, environment: null }]);
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 3);
    expect(await names()).toEqual(["target", "a.rs", "b.log"]);
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await expect($("#error")).not.toBeDisplayed();
  });

  it("shows the message of a failed delete and changes nothing: the tree and the tab stay", async () => {
    await openFiles();
    await openA();
    const del = await mock("orca_file_delete", rejects("Orca がエラーを返しました（forbidden）"));
    const list = await mock("orca_files_list", dirOf("", []));
    await askDelete("a.rs");
    await pressDelete();
    await waitForCalls(del);
    await expect($("#error")).toHaveText("Orca がエラーを返しました（forbidden）");
    await browser.pause(300);
    expect(await callsOf(list)).toEqual([]);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
  });

  // A-18: the move. 「移動・名前の変更」 turns the row into a field with its path from the worktree, and a row is dragged onto a folder or onto the empty part of the tree; Rust moves it.
  const HERE = "/work/example-app";
  async function askMove(path: string) {
    expect(await rightClickRow(path)).toBe(true);
    await pickItem("移動・名前の変更");
    await waitForCount(".orca-file-new", 1);
  }
  // The field of the path: its text, what is selected in it, its label and its placeholder.
  const moveField = () =>
    browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>("#orca-files-tree .orca-file-input")!;
      return { value: input.value, selected: [input.selectionStart, input.selectionEnd], label: input.getAttribute("aria-label"), placeholder: input.placeholder, focused: document.activeElement === input };
    });
  // Types `value` as the whole text of the field (value, then input).
  const setField = (value: string) =>
    browser.execute(
      (v, once) => {
        if (!window.__e2e_once__(once)) return;
        const input = document.querySelector<HTMLInputElement>("#orca-files-tree .orca-file-input")!;
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      value,
      onceId(),
    );
  // The pointer on the tree, as the page gets it (the tree listens for pointer events): for each step its kind and where it is, the row of a path (the press at its middle, a move or a release at four fifths of its width) or "empty", the part of the tree under its rows. The press goes to the row, the rest to the document.
  const pointer = (steps: ["pointerdown" | "pointermove" | "pointerup", string][]) =>
    browser.execute(
      (list, once) => {
        if (!window.__e2e_once__(once)) return;
        for (const [type, where] of list) {
          const tree = document.getElementById("orca-files-tree")!.getBoundingClientRect();
          const target = where === "empty" ? null : document.querySelector(`.orca-file[data-path="${where}"]`)!;
          const r = target?.getBoundingClientRect();
          const [x, y] = r ? [r.left + r.width * (type === "pointerdown" ? 0.5 : 0.8), r.top + r.height / 2] : [tree.left + 20, tree.bottom - 12];
          (type === "pointerdown" ? target! : document).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 4, isPrimary: true }));
        }
      },
      steps,
      onceId(),
    );
  const dragRow = (from: string, to: string) =>
    pointer([
      ["pointerdown", from],
      ["pointermove", to],
      ["pointerup", to],
    ]);
  const dropMark = (path: string) => browser.execute((p) => (p === "" ? document.getElementById("orca-files-tree")! : document.querySelector<HTMLElement>(`.orca-file[data-path="${p}"]`)!).dataset.drop ?? null, path);
  async function openSrc() {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
  }

  it("turns the row into a field with its path from the worktree, the keys in it and the name selected, when the move is chosen from the menu", async () => {
    await openSrc();
    await askMove("src/main.rs");
    expect(await treeOrder()).toEqual(["src", "src/lib", "[field]", "target", "a.rs", "b.log"]);
    // The name without its extension is selected: `main` of `src/main.rs`.
    expect(await moveField()).toEqual({ value: "src/main.rs", selected: [4, 8], label: "移動先のパス", placeholder: "", focused: true });
    await browser.keys("Escape");
    await waitForCount(".orca-file-new", 0);
    // A folder's name is selected whole, and the folder stays open under the field.
    await askMove("src");
    expect(await treeOrder()).toEqual(["[field]", "src/lib", "src/main.rs", "target", "a.rs", "b.log"]);
    expect(await moveField()).toEqual({ value: "src", selected: [0, 3], label: "移動先のパス", placeholder: "", focused: true });
  });

  it("moves the entry to the path typed on Enter, with the worktree and both paths, and reads its folder again", async () => {
    await openSrc();
    const move = await mock("orca_file_move", null);
    const list = await mock("orca_files_list", dirOf("src", [["lib", true], ["renamed.rs", false]]));
    await askMove("src/main.rs");
    // The keys replace the selected name.
    await browser.keys("renamed");
    await browser.keys("Enter");
    expect(await waitForCalls(move)).toEqual([{ path: HERE, from: "src/main.rs", to: "src/renamed.rs", environment: null }]);
    expect(await waitForCalls(list)).toEqual([{ path: HERE, dir: "src", ignored: false, environment: null }]);
    await waitForCount(".orca-file-new", 0);
    await browser.waitUntil(async () => (await names()).includes("renamed.rs"), { timeoutMsg: "the folder was never drawn again" });
    expect(await treeOrder()).toEqual(["src", "src/lib", "src/renamed.rs", "target", "a.rs", "b.log"]);
    await expect($("#error")).not.toBeDisplayed();
    await browser.pause(200);
    expect(await callsOf(list)).toHaveLength(1);
  });

  it("sends the trimmed path of another folder, and reads the folder it left and the nearest folder read of the one it went to", async () => {
    await openSrc();
    const move = await mock("orca_file_move", null);
    const list = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await askMove("a.rs");
    await setField("  src/new/deep/a.rs ");
    await browser.keys("Enter");
    expect(await waitForCalls(move)).toEqual([{ path: HERE, from: "a.rs", to: "src/new/deep/a.rs", environment: null }]);
    // src/new and src/new/deep were never read: src is the nearest folder that was.
    expect((await waitForCalls(list, 2)).map((c) => (c as { dir: string }).dir)).toEqual(["", "src"]);
    await waitForCount(".orca-file-new", 0);
  });

  it("cancels the move on Escape, on a blank path, on the same path and when the field loses the keys unchanged, and calls nothing", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const move = await mock("orca_file_move", null);
    await askMove("a.rs");
    await setField("c.rs");
    await browser.keys("Escape");
    await waitForCount(".orca-file-new", 0);
    await askMove("a.rs");
    await setField("   ");
    await browser.keys("Enter");
    await waitForCount(".orca-file-new", 0);
    await askMove("a.rs");
    await browser.keys("Enter");
    await waitForCount(".orca-file-new", 0);
    await askMove("a.rs");
    await blurField();
    await waitForCount(".orca-file-new", 0);
    await browser.pause(300);
    expect(await callsOf(move)).toEqual([]);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
  });

  it("moves when the field loses the keys after another path was typed", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const move = await mock("orca_file_move", null);
    await askMove("a.rs");
    await setField("c.rs");
    await blurField();
    expect(await waitForCalls(move)).toEqual([{ path: HERE, from: "a.rs", to: "c.rs", environment: null }]);
    await waitForCount(".orca-file-new", 0);
  });

  it("keeps the field and moves nothing when it loses the keys because the window went to the back", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const move = await mock("orca_file_move", null);
    await askMove("a.rs");
    await setField("c.rs");
    // The window is not the front one: the document says it has no focus.
    await browser.execute(() => {
      document.hasFocus = () => false;
      (document.activeElement as HTMLElement).blur();
    });
    await browser.pause(300);
    expect(await callsOf(move)).toEqual([]);
    await waitForCount(".orca-file-new", 1);
    expect((await moveField()).value).toBe("c.rs");
    await browser.execute(() => {
      delete (document as { hasFocus?: unknown }).hasFocus;
    });
  });

  it("keeps the field and asks nothing on Enter while a move by a drag is on its way, and moves on Enter after it", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const move = await mock("orca_file_move", holds);
    await mock("orca_files_list", dirOf("", [["src", true], ["target", true], ["a.rs", false]]));
    await dragRow("b.log", "src");
    await waitForCalls(move);
    await askMove("a.rs");
    await setField("c.rs");
    await browser.keys("Enter");
    await browser.pause(300);
    expect(await callsOf(move)).toHaveLength(1);
    await waitForCount(".orca-file-new", 1);
    await release(move, null);
    await waitForCount("#orca-files-tree .orca-file", 2);
    expect((await moveField()).value).toBe("c.rs");
    await browser.keys("Enter");
    expect((await waitForCalls(move, 2))[1]).toEqual({ path: HERE, from: "a.rs", to: "c.rs", environment: null });
    await release(move, null);
    await waitForCount(".orca-file-new", 0);
  });

  it("says the name is taken when Orca refuses the place, moves nothing and takes the field away", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const move = await mock("orca_file_move", rejects("同じ名前があります"));
    const list = await mock("orca_files_list", dirOf("", []));
    await askMove("a.rs");
    await setField("b.log");
    await browser.keys("Enter");
    await waitForCalls(move);
    await expect($("#error")).toHaveText("同じ名前があります");
    await waitForCount(".orca-file-new", 0);
    await browser.pause(300);
    expect(await callsOf(list)).toEqual([]);
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
  });

  it("moves a row dragged onto a folder into it, and reads the folder it left again", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const move = await mock("orca_file_move", null);
    const list = await mock("orca_files_list", dirOf("", [["src", true], ["target", true], ["b.log", false]]));
    await dragRow("a.rs", "src");
    expect(await waitForCalls(move)).toEqual([{ path: HERE, from: "a.rs", to: "src/a.rs", environment: null }]);
    // src is closed and was never read, so the root is what is read.
    expect(await waitForCalls(list)).toEqual([{ path: HERE, dir: "", ignored: false, environment: null }]);
    await waitForCount("#orca-files-tree .orca-file", 3);
    expect(await names()).toEqual(["src", "target", "b.log"]);
    // The press that ended the drag opened no folder, and nothing of the drag is left.
    await expect(row("src")).toHaveAttribute("aria-expanded", "false");
    await expect($(".orca-file-drag")).not.toExist();
    expect(await dropMark("src")).toBeNull();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("marks the folder under a dragged row, shows the name at the pointer, and opens a closed folder the pointer rests on", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const move = await mock("orca_file_move", null);
    const list = await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await pointer([
      ["pointerdown", "a.rs"],
      ["pointermove", "src"],
    ]);
    await expect($(".orca-file-drag")).toHaveText("a.rs");
    expect(await dropMark("src")).toBe("true");
    expect(await dropMark("target")).toBeNull();
    expect(await dropMark("")).toBeNull();
    // The pointer rests on src, which is closed: it opens, and is still the place of the drop.
    expect(await waitForCalls(list)).toEqual([{ path: HERE, dir: "src", ignored: false, environment: null }]);
    await expect(row("src")).toHaveAttribute("aria-expanded", "true");
    await waitForCount("#orca-files-tree .orca-file", 6);
    expect(await dropMark("src")).toBe("true");
    expect(await callsOf(move)).toEqual([]);
    // A folder inside it is a place too.
    await pointer([["pointermove", "src/lib"]]);
    expect(await dropMark("src/lib")).toBe("true");
    expect(await dropMark("src")).toBeNull();
    await pointer([["pointerup", "src/lib"]]);
    expect(await waitForCalls(move)).toEqual([{ path: HERE, from: "a.rs", to: "src/lib/a.rs", environment: null }]);
    await expect($(".orca-file-drag")).not.toExist();
    expect(await dropMark("src/lib")).toBeNull();
  });

  it("moves a row dragged onto the empty part of the tree to the root of the worktree, and reads both folders again", async () => {
    await openSrc();
    const move = await mock("orca_file_move", null);
    const list = await mock("orca_files_list", dirOf("src", [["lib", true]]));
    await pointer([
      ["pointerdown", "src/main.rs"],
      ["pointermove", "empty"],
    ]);
    expect(await dropMark("")).toBe("true");
    await pointer([["pointerup", "empty"]]);
    expect(await waitForCalls(move)).toEqual([{ path: HERE, from: "src/main.rs", to: "main.rs", environment: null }]);
    expect((await waitForCalls(list, 2)).map((c) => (c as { dir: string }).dir)).toEqual(["src", ""]);
    expect(await dropMark("")).toBeNull();
  });

  it("does nothing for a row dropped on the folder it is in, on itself, inside itself, on a file and outside the tree", async () => {
    await openSrc();
    const move = await mock("orca_file_move", null);
    // a.rs is in the root already, and src/main.rs in src.
    await pointer([
      ["pointerdown", "a.rs"],
      ["pointermove", "empty"],
    ]);
    await expect($(".orca-file-drag")).toHaveText("a.rs");
    expect(await dropMark("")).toBeNull();
    await pointer([["pointerup", "empty"]]);
    await dragRow("src/main.rs", "src");
    // A folder on itself and on a folder inside it.
    await dragRow("src", "src");
    await pointer([
      ["pointerdown", "src"],
      ["pointermove", "src/lib"],
    ]);
    expect(await dropMark("src/lib")).toBeNull();
    await pointer([["pointerup", "src/lib"]]);
    // A file's row is no place.
    await dragRow("a.rs", "b.log");
    // Escape ends a drag: the release after it moves nothing.
    await pointer([
      ["pointerdown", "a.rs"],
      ["pointermove", "src"],
    ]);
    expect(await dropMark("src")).toBe("true");
    await browser.keys("Escape");
    await expect($(".orca-file-drag")).not.toExist();
    expect(await dropMark("src")).toBeNull();
    await pointer([["pointerup", "src"]]);
    await browser.pause(300);
    expect(await callsOf(move)).toEqual([]);
    await expect($(".orca-file-drag")).not.toExist();
    expect(await names()).toEqual(["src", "lib", "main.rs", "target", "a.rs", "b.log"]);
  });

  it("gives the tab of a moved file its new path and title, keeps its typing, and saves it to the new path only after the move", async () => {
    await openFiles();
    await openA();
    const move = await mock("orca_file_move", holds);
    const write = await mock("orca_file_write", saved("sig-2"));
    await mock("orca_files_list", dirOf("", [["src", true], ["target", true], ["b.log", false], ["c.rs", false]]));
    await askMove("a.rs");
    await setField("c.rs");
    await browser.keys("Enter");
    await waitForCalls(move);
    // Typing while the move is on its way waits: nothing is saved to the path the file leaves.
    await type("// x\n");
    await browser.pause(400);
    expect(await callsOf(write)).toEqual([]);
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await release(move, null);
    await browser.waitUntil(async () => (await tabTitles())[1] === "c.rs", { timeoutMsg: "the tab never took the new name" });
    await expect($(".orca-edit-path")).toHaveText("c.rs");
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n// x\n", { trim: false });
    expect(await waitForCalls(write)).toEqual([{ path: HERE, relative: "c.rs", content: "fn main() {}\n// x\n", crlf: false, signature: "sig-1", environment: null }]);
    await expect(stateText()).toHaveText("保存しました");
    // The moved file is the one drawn as open.
    await expect(row("c.rs")).toHaveAttribute("data-open", "true");
  });

  it("gives the tabs of the files under a moved folder their new paths, and keeps the path of a tab when the move fails", async () => {
    await openSrc();
    await mock("orca_file_read", text("fn main() {}\n", "sig-m"));
    await doublePress("src/main.rs");
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n", { trim: false });
    const move = await mock("orca_file_move", rejects("Orca がエラーを返しました（forbidden）"));
    await dragRow("src", "target");
    await waitForCalls(move);
    await expect($("#error")).toHaveText("Orca がエラーを返しました（forbidden）");
    await expect($(".orca-edit-path")).toHaveText("src/main.rs");
    await mock("orca_file_move", null);
    await dragRow("src", "target");
    expect(await waitForCalls(move)).toEqual([{ path: HERE, from: "src", to: "target/src", environment: null }]);
    await expect($(".orca-edit-path")).toHaveText("target/src/main.rs");
    expect(await tabTitles()).toEqual(["Write the docs", "main.rs"]);
  });

  // A-22: the download of a file. Rust opens the save dialog and writes where it says; the page sends the worktree, the path from it and the target, and never a place to save.
  it("downloads a file from the menu with the worktree, its path and no place to save, and says the name of the file saved", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const download = await mock("orca_file_download", "a.rs");
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("ダウンロード");
    expect(await waitForCalls(download)).toEqual([{ path: "/work/example-app", relative: "a.rs", environment: null }]);
    await expect($(".toast")).toHaveText(expect.stringContaining("a.rs をダウンロードしました"));
    await expect($(".menu")).not.toExist();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("sends the path from the worktree of a file in an open folder", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    const download = await mock("orca_file_download", "main.rs");
    expect(await rightClickRow("src/main.rs")).toBe(true);
    await pickItem("ダウンロード");
    expect(await waitForCalls(download)).toEqual([{ path: "/work/example-app", relative: "src/main.rs", environment: null }]);
  });

  it("shows nothing when the save dialog is cancelled", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const download = await mock("orca_file_download", null);
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("ダウンロード");
    await waitForCalls(download);
    await browser.pause(300);
    await expect($(".toast")).not.toBeDisplayed();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("shows the message of a download that failed, and no toast", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const download = await mock("orca_file_download", rejects("この PC にファイルを書けません: Permission denied"));
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("ダウンロード");
    await waitForCalls(download);
    await expect($("#error")).toHaveText("この PC にファイルを書けません: Permission denied");
    await expect($(".toast")).not.toBeDisplayed();
  });

  // A-24: the diff tab. Rust compares the two texts (`orca_file_diff`): the rows of both views and the blocks of changes; the page draws them and colors the text.
  const row_ = (kind: OrcaDiffRow["kind"], old: number | null, nw: number | null): OrcaDiffRow => ({ kind, old, new: nw });
  const diffOfA = (): OrcaFileDiff => ({
    oldLines: ["fn main() {", "    old();", "}", "/* a", "b */"],
    newLines: ["fn main() {", "    new();", "    more();", "}", "/* a", "b */", "// tail"],
    side: [row_("same", 1, 1), row_("changed", 2, 2), row_("added", null, 3), row_("same", 3, 4), row_("same", 4, 5), row_("same", 5, 6), row_("added", null, 7)],
    inline: [row_("same", 1, 1), row_("removed", 2, null), row_("added", null, 2), row_("added", null, 3), row_("same", 3, 4), row_("same", 4, 5), row_("same", 5, 6), row_("added", null, 7)],
    changes: [
      { side: 1, inline: 1 },
      { side: 6, inline: 7 },
    ],
    language: "rust",
    highlight: "rust",
  });
  // 200 rows, with a change at the second row and another at the 150th, so that the rows scroll.
  const many = (): OrcaFileDiff => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const side = lines.map((_, i) => row_(i === 1 || i === 149 ? "changed" : "same", i + 1, i + 1));
    return { oldLines: lines, newLines: lines.map((l, i) => (i === 1 || i === 149 ? `${l} new` : l)), side, inline: side.flatMap((r) => (r.kind === "changed" ? [row_("removed", r.old, null), row_("added", null, r.new)] : [r])), changes: [{ side: 1, inline: 1 }, { side: 149, inline: 150 }], language: "plaintext", highlight: null };
  };
  const diffRows = () => count(".orca-diff-rows .odf-row");
  const diffButton = (label: string) => $(`.orca-diff [aria-label="${label}"]`);
  const diffCell = (row: number, cell: string) => browser.execute((r, c) => document.querySelectorAll(".orca-diff-rows .odf-row")[r].querySelector(c)!.textContent, row, cell);
  async function openDiffOf(relative = "a.rs", value: unknown = diffOfA()) {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const diff = await mock("orca_file_diff", value);
    expect(await rightClickRow(relative)).toBe(true);
    await pickItem("差分を表示");
    if ((value as { highlight?: string | null }).highlight) await waitForColors();
    return diff;
  }

  it("opens the diff of a file from the menu of its row with the worktree, its path and the target, as a tab that is selected (A-24)", async () => {
    const diff = await openDiffOf();
    expect(await waitForCalls(diff)).toEqual([{ path: "/work/example-app", relative: "a.rs", environment: null }]);
    await expect($(".menu")).not.toExist();
    await expect(tabOf("diff:1")).toBeDisplayed();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await expect(tabOf("diff:1").$(".orca-tab-btn")).toHaveAttribute("aria-selected", "true");
    await expect($(".orca-diff .orca-edit-path")).toHaveText("a.rs");
    await expect($(".orca-diff-count")).toHaveText("変更 2 件");
    expect(await diffRows()).toBe(7);
    await expect($("#error")).not.toBeDisplayed();
  });

  it("draws HEAD on the left, the working tree on the right and the numbers between, with a blank where a side has no line (A-24)", async () => {
    await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect($(".orca-diff-rows")).toHaveAttribute("data-view", "side");
    expect(await diffCell(1, ".old")).toBe("    old();");
    expect(await diffCell(1, ".new")).toBe("    new();");
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(2) .odf-num")).toEqual(["2", "2"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(3) .odf-num")).toEqual(["", "3"]);
    expect(await diffCell(2, ".old")).toBe("");
    expect(await diffCell(2, ".new")).toBe("    more();");
    const kinds = await browser.execute(() => [...document.querySelectorAll<HTMLElement>(".orca-diff-rows .odf-row")].map((r) => r.dataset.kind));
    expect(kinds).toEqual(["same", "changed", "added", "same", "same", "same", "added"]);
    const colors = await browser.execute(() => {
      const bg = (row: number, cell: string) => getComputedStyle(document.querySelectorAll(".orca-diff-rows .odf-row")[row].querySelector(cell)!).backgroundColor;
      return { removed: bg(1, ".old"), added: bg(1, ".new"), blank: bg(2, ".old"), added2: bg(2, ".new"), same: bg(0, ".old") };
    });
    expect(colors.removed).toBe("rgb(255, 235, 233)");
    expect(colors.added).toBe("rgb(218, 251, 225)");
    expect(colors.added2).toBe(colors.added);
    expect(colors.blank).toBe("rgb(246, 248, 250)");
    expect(colors.same).toBe("rgba(0, 0, 0, 0)");
  });

  it("colors the text by the language, a token of several lines on each of its lines (A-24)", async () => {
    await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(1) .old .hljs-keyword")).toEqual(["fn"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(1) .new .hljs-keyword")).toEqual(["fn"]);
    // The block comment starts on one line and ends on the next: both are comments.
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(5) .old .hljs-comment")).toEqual(["/* a"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(6) .old .hljs-comment")).toEqual(["b */"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(7) .new .hljs-comment")).toEqual(["// tail"]);
  });

  it("draws the text plain and escaped for a language with no grammar (A-24)", async () => {
    const plain: OrcaFileDiff = { ...diffOfA(), oldLines: ["<b>x</b> &amp;"], newLines: ["<b>y</b>"], side: [row_("changed", 1, 1)], inline: [row_("removed", 1, null), row_("added", null, 1)], changes: [{ side: 0, inline: 0 }], language: "zig", highlight: null };
    await openDiffOf("a.rs", plain);
    await waitForCount(".orca-diff-rows .odf-row", 1);
    expect(await diffCell(0, ".old")).toBe("<b>x</b> &amp;");
    expect(await count(".orca-diff-rows b")).toBe(0);
    expect(await count(".orca-diff-rows [class^='hljs-']")).toBe(0);
  });

  it("switches to one column with the marks and two columns of numbers, and back, with the button of the tab (A-24)", async () => {
    await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect(diffButton("1 列で表示")).toHaveAttribute("aria-pressed", "false");
    await diffButton("1 列で表示").click();
    await waitForCount(".orca-diff-rows .odf-row", 8);
    await expect($(".orca-diff-rows")).toHaveAttribute("data-view", "inline");
    await expect(diffButton("左右に並べて表示")).toHaveAttribute("aria-pressed", "true");
    expect(await textsOf(".orca-diff-rows .odf-mark")).toEqual(["", "−", "+", "+", "", "", "", "+"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(2) .odf-num")).toEqual(["2", ""]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(3) .odf-num")).toEqual(["", "2"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(2) .odf-code")).toEqual(["old();"]);
    expect(await textsOf(".orca-diff-rows .odf-row:nth-child(3) .odf-code")).toEqual(["new();"]);
    const colors = await browser.execute(() => {
      const bg = (row: number) => getComputedStyle(document.querySelectorAll(".orca-diff-rows .odf-row")[row].querySelector(".odf-code")!).backgroundColor;
      return [bg(1), bg(2), bg(0)];
    });
    expect(colors).toEqual(["rgb(255, 235, 233)", "rgb(218, 251, 225)", "rgba(0, 0, 0, 0)"]);
    expect(await count(".orca-diff-rows .odf-row:nth-child(2) .hljs-keyword, .orca-diff-rows .odf-row:nth-child(1) .hljs-keyword")).toBe(1);
    expect(await callsOf("orca_file_diff")).toHaveLength(1);
    await diffButton("左右に並べて表示").click();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect($(".orca-diff-rows")).toHaveAttribute("data-view", "side");
  });

  it("goes to the previous and the next block of changes, and counts them (A-24)", async () => {
    await openDiffOf("a.rs", many());
    await waitForCount(".orca-diff-rows .odf-row", 200);
    await expect($(".orca-diff-count")).toHaveText("変更 2 件");
    const view = () => browser.execute(() => {
      const box = document.querySelector(".orca-diff-rows")!.getBoundingClientRect();
      const r = document.querySelectorAll(".orca-diff-rows .odf-row")[149].getBoundingClientRect();
      return { top: document.querySelector(".orca-diff-rows")!.scrollTop, visible: r.top >= box.top && r.bottom <= box.bottom };
    });
    await expect(diffButton("前の変更")).toBeDisabled();
    await expect(diffButton("次の変更")).toBeEnabled();
    expect((await view()).visible).toBe(false);
    await diffButton("次の変更").click();
    await browser.waitUntil(async () => (await view()).visible, { timeoutMsg: "the second change never came into view" });
    await expect(diffButton("次の変更")).toBeDisabled();
    await expect(diffButton("前の変更")).toBeEnabled();
    await diffButton("前の変更").click();
    await browser.waitUntil(async () => !(await view()).visible, { timeoutMsg: "the first change never came back" });
    await expect(diffButton("前の変更")).toBeDisabled();
  });

  it("draws a tab that is out of the page in the view chosen when it is put back, at the block last moved to (A-24)", async () => {
    await openDiffOf("a.rs", many());
    await waitForCount(".orca-diff-rows .odf-row", 200);
    await diffButton("次の変更").click();
    await expect(diffButton("次の変更")).toBeDisabled();
    expect(await rightClickRow("b.log")).toBe(true);
    await pickItem("差分を表示");
    await expect(tabOf("diff:2")).toBeDisplayed();
    await waitForCount(".orca-diff-rows .odf-row", 200);
    await diffButton("1 列で表示").click();
    await waitForCount(".orca-diff-rows .odf-row", 202);
    await tabOf("diff:1").$(".orca-tab-btn").click();
    await expect($(".orca-diff-rows")).toHaveAttribute("data-view", "inline");
    await waitForCount(".orca-diff-rows .odf-row", 202);
    await expect(diffButton("左右に並べて表示")).toHaveAttribute("aria-pressed", "true");
    await expect(diffButton("次の変更")).toBeDisabled();
    // The second block (the 151st row of one column) is in view, not the pixel place of the other view.
    const visible = () => browser.execute(() => {
      const box = document.querySelector(".orca-diff-rows")!.getBoundingClientRect();
      const r = document.querySelectorAll(".orca-diff-rows .odf-row")[150].getBoundingClientRect();
      return r.top >= box.top && r.bottom <= box.bottom;
    });
    await browser.waitUntil(visible, { timeoutMsg: "the second change was not in view after the tab was put back" });
  });

  it("says there is no change for a file with none, and the buttons of the changes are off (A-24)", async () => {
    const none: OrcaFileDiff = { ...diffOfA(), oldLines: ["a"], newLines: ["a"], side: [row_("same", 1, 1)], inline: [row_("same", 1, 1)], changes: [] };
    await openDiffOf("a.rs", none);
    await expect($(".orca-diff-count")).toHaveText("変更はありません");
    await expect(diffButton("前の変更")).toBeDisabled();
    await expect(diffButton("次の変更")).toBeDisabled();
  });

  it("shows the reason Rust gives in place of the diff (A-24)", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    const diff = await mock("orca_file_diff", rejects("バイナリのファイルの差分は表示できません"));
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("差分を表示");
    await waitForCalls(diff);
    await expect($(".orca-diff .feed-empty")).toHaveText("バイナリのファイルの差分は表示できません");
    await expect($(".orca-diff-rows")).not.toBeDisplayed();
    await expect($(".orca-diff-count")).toHaveText("");
    await expect(diffButton("1 列で表示")).toBeDisabled();
    await expect(diffButton("次の変更")).toBeDisabled();
    await expect($("#error")).not.toBeDisplayed();
    // The reload button reads again, and draws the diff when it can.
    await mock("orca_file_diff", diffOfA());
    await diffButton("読み直す").click();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect($(".orca-diff .feed-empty")).not.toBeDisplayed();
  });

  it("reads the diff again with the reload button, and selects the tab instead of opening a second one for the same file (A-24)", async () => {
    const diff = await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await diffButton("読み直す").click();
    expect(await waitForCalls(diff, 2)).toHaveLength(2);
    await tabOf(claudeTab("example-app")).$(".orca-tab-btn").click();
    await expect($(".orca-diff")).not.toExist();
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("差分を表示");
    await browser.waitUntil(async () => (await callsOf("orca_file_diff")).length === 3, { timeoutMsg: "the diff was never read again" });
    await expect(tabOf("diff:1").$(".orca-tab-btn")).toHaveAttribute("aria-selected", "true");
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await expect($(".orca-diff")).toBeDisplayed();
    expect(await diffRows()).toBe(7);
  });

  it("opens the diff of another file as another tab, and closes a diff tab without asking Rust (A-24)", async () => {
    await openDiffOf();
    await waitForCount(".orca-diff-rows .odf-row", 7);
    expect(await rightClickRow("b.log")).toBe(true);
    await pickItem("差分を表示");
    await expect(tabOf("diff:2")).toBeDisplayed();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs", "b.log"]);
    await expect($(".orca-diff .orca-edit-path")).toHaveText("b.log");
    await tabOf("diff:2").$(".orca-tab-close").click();
    await expect(tabOf("diff:2")).not.toExist();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
  });

  it("opens the diff of a file in an open folder with its path from the worktree (A-24)", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_files_list", dirOf("src", [["lib", true], ["main.rs", false]]));
    await row("src").click();
    await waitForCount("#orca-files-tree .orca-file", 6);
    const diff = await mock("orca_file_diff", diffOfA());
    expect(await rightClickRow("src/main.rs")).toBe(true);
    await pickItem("差分を表示");
    expect(await waitForCalls(diff)).toEqual([{ path: "/work/example-app", relative: "src/main.rs", environment: null }]);
    expect(await tabTitles()).toEqual(["Write the docs", "main.rs"]);
  });

  it("closes the menu of a row with Escape and writes nothing", async () => {
    await openFiles();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await stubClipboard();
    expect(await rightClickRow("b.log")).toBe(true);
    await expect($('.menu[role="menu"]')).toBeDisplayed();
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
    expect(await copiedTexts()).toEqual([]);
  });

  // A-25: the branch of the heading. Rust reads the branches and switches (`orca_local_branches`, `orca_remote_branches`, `orca_switch_branch`); the page draws the list, asks for the remote ones by the text, and reads the tree and the list of Orca again after a switch.
  const local = (name: string, extra: Partial<OrcaLocalBranch> = {}): OrcaLocalBranch => ({ name, current: false, inUse: false, ...extra });
  const remote = (name: string): OrcaRemoteBranch => ({ name, localName: name.replace(/^origin\//, "") });
  // feat/a is checked out in the worktree, main in another one.
  const branchFixtures = (extra: Record<string, unknown> = {}) => ({
    orca_local_branches: [local("feat/a", { current: true }), local("main", { inUse: true }), local("feat/c")],
    orca_remote_branches: [remote("origin/feat/a"), remote("origin/feat/d")],
    orca_switch_branch: { branch: "feat/c", warning: null },
    ...extra,
  });
  const branchButton = () => $("#orca-files-title .orca-branch-btn");
  // The rows the filter leaves in view: it hides the others and keeps them in the page.
  const shownRows = (selector = ".orca-dest-pop .orca-branch-row") =>
    browser.execute((s) => [...document.querySelectorAll<HTMLElement>(s)].filter((e) => !e.hidden).map((e) => e.textContent?.trim() ?? ""), selector);
  const branchRows = () => shownRows();
  const branchPick = (kind: string, name: string) => $(`.orca-dest-pop .orca-branch-row[data-kind="${kind}"][data-name="${name}"]`);
  const branchStates = () => browser.execute(() => [...document.querySelectorAll<HTMLButtonElement>(".orca-dest-pop .orca-branch-row")].map((b) => [b.dataset.kind, b.dataset.name, b.getAttribute("aria-current"), b.disabled]));
  // The file pane open on example-app and the list of branches opened under the button of the heading.
  async function openBranches(fixtures: Record<string, unknown> = {}) {
    await openFiles(branchFixtures(fixtures));
    await waitForCount("#orca-files-tree .orca-file", 4);
    await branchButton().click();
    await expect($('.orca-dest-pop[role="dialog"]')).toBeDisplayed();
  }
  // What Orca lists once example-app is on feat/c.
  const onFeatC = () => orcaOverview([orcaRow("example-app", "feat/c", "Write the docs", { minutes: 2 }), ...sample().slice(1)], [orcaWorktree("example-app", "feat/c"), orcaWorktree("example-api", "main")]);

  it("makes the branch of the heading a button that opens the list right under it, with the local and the remote branches, the one the worktree is on marked and the one another worktree has disabled (A-25)", async () => {
    await openBranches();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/a");
    await expect(branchButton()).toHaveText("feat/a");
    await expect(branchButton()).toHaveAttribute("aria-expanded", "true");
    expect(await callsOf("orca_local_branches")).toEqual([{ path: "/work/example-app", environment: null }]);
    expect(await waitForCalls("orca_remote_branches")).toEqual([{ path: "/work/example-app", repo: "proj_example-app", query: "", environment: null }]);
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    expect(await textsOf(".orca-dest-pop .orca-dest-sec")).toEqual(["ローカル", "リモート"]);
    expect(await branchRows()).toEqual(["feat/a", "main", "feat/c", "origin/feat/a", "origin/feat/d"]);
    expect(await branchStates()).toEqual([
      ["local", "feat/a", "true", false],
      ["local", "main", "false", true],
      ["local", "feat/c", "false", false],
      ["remote", "origin/feat/a", "false", false],
      ["remote", "origin/feat/d", "false", false],
    ]);
    expect(await count(".orca-dest-pop .orca-branch-mark")).toBe(1);
    expect(await count('.orca-dest-pop .orca-branch-row[data-name="feat/a"] .orca-branch-mark')).toBe(1);
    const look = await browser.execute(() => {
      const r = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const opacity = (name: string) => getComputedStyle(document.querySelector(`.orca-dest-pop .orca-branch-row[data-name="${name}"]`)!).opacity;
      return { under: r(".orca-dest-pop").top >= r(".orca-branch-btn").bottom, inFiles: r(".orca-dest-pop").top < r("#orca-files").bottom, used: opacity("main"), free: opacity("feat/c") };
    });
    expect(look).toEqual({ under: true, inFiles: true, used: "0.45", free: "1" });
    // The tree stays in view under the list.
    expect(await names()).toEqual(["src", "target", "a.rs", "b.log"]);
    expect(await callsOf("orca_switch_branch")).toEqual([]);
  });

  it("narrows the local branches by the filter at once, and asks for the remote ones once after the typing stops (A-25)", async () => {
    await openBranches();
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    const search = await mock("orca_remote_branches", [remote("origin/feat/d")]);
    await $('.orca-dest-pop input[aria-label="ブランチを絞り込む"]').setValue("feat");
    expect(await shownRows('.orca-dest-pop .orca-branch-row[data-kind="local"]')).toEqual(["feat/a", "feat/c"]);
    // The rows are hidden, not made again.
    expect(await count(".orca-dest-pop .orca-branch-row")).toBe(5);
    await browser.waitUntil(async () => (await callsOf(search)).length > 0, { timeoutMsg: "the remote branches were never asked for" });
    await browser.pause(500);
    expect(await callsOf(search)).toEqual([{ path: "/work/example-app", repo: "proj_example-app", query: "feat", environment: null }]);
    expect(await branchRows()).toEqual(["feat/a", "feat/c", "origin/feat/d"]);
    await $('.orca-dest-pop input[aria-label="ブランチを絞り込む"]').setValue("zzz");
    await expect($(".orca-dest-pop .empty")).toBeDisplayed();
    expect(await shownRows(".orca-dest-pop .empty")).toEqual(["該当するブランチがありません", "該当するブランチがありません"]);
    expect(await branchRows()).toEqual([]);
    await browser.waitUntil(async () => ((await callsOf(search)).at(-1) as { query: string } | undefined)?.query === "zzz", { timeoutMsg: "the new text was never asked for" });
  });

  it("asks for the remote branches of the last text once the one in flight is answered, and not while it is (A-25)", async () => {
    await openBranches();
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    const search = await mock("orca_remote_branches", holds);
    const input = $('.orca-dest-pop input[aria-label="ブランチを絞り込む"]');
    await input.setValue("f");
    await waitForCalls(search);
    // Typed while the first is waiting: nothing more is sent until it is answered.
    await input.setValue("fe");
    await browser.pause(600);
    await input.setValue("fea");
    await browser.pause(600);
    expect((await callsOf(search)).map((c) => (c as { query: string }).query)).toEqual(["f"]);
    await release(search, [remote("origin/feat/d")]);
    expect(((await waitForCalls(search, 2)).at(-1) as { query: string }).query).toBe("fea");
    await release(search, [remote("origin/feat/d")]);
    await browser.waitUntil(async () => (await branchRows()).includes("origin/feat/d"), { timeoutMsg: "the answer was never drawn" });
    await browser.pause(300);
    expect(await callsOf(search)).toHaveLength(2);
  });

  it("switches to a local branch with the worktree, the kind and the name, then reads the tree and the list of Orca again and keeps the open files (A-25)", async () => {
    await openFiles(branchFixtures());
    await openA();
    await branchButton().click();
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    const files = await mock("orca_files_list", root());
    const overview = await mock("orca_overview", onFeatC());
    await branchPick("local", "feat/c").click();
    expect(await waitForCalls("orca_switch_branch")).toEqual([{ path: "/work/example-app", kind: "local", name: "feat/c", environment: null }]);
    await expect($(".orca-dest-pop")).not.toExist();
    await waitForCalls(overview);
    expect(await waitForCalls(files)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/c");
    await expect(branchButton()).toHaveText("feat/c");
    // The open file stays: its tab, and its text.
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs"]);
    await expect(tabOf("file:1").$(".orca-tab-btn")).toHaveAttribute("aria-selected", "true");
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n", { trim: false });
    await expect($("#error")).not.toBeDisplayed();
  });

  it("makes the git branch the button when Orca's name of the worktree differs from it, and shows the new branch after a switch (A-25)", async () => {
    // A worktree made with a name keeps that name as `displayName` after a switch; the button follows the git branch.
    const named = (gitBranch: string) =>
      orcaOverview([orcaRow("example-app", "fix-login", "Write the docs", { minutes: 2 }), ...sample().slice(1)], [orcaWorktree("example-app", "fix-login", { gitBranch }), orcaWorktree("example-api", "main")]);
    await openFiles(branchFixtures(), named("feat/a"));
    await expect($("#orca-files-title")).toHaveText("example-app ・ fix-login ・ feat/a");
    await expect(branchButton()).toHaveText("feat/a");
    await branchButton().click();
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    await mock("orca_overview", named("feat/c"));
    await branchPick("local", "feat/c").click();
    expect(await waitForCalls("orca_switch_branch")).toEqual([{ path: "/work/example-app", kind: "local", name: "feat/c", environment: null }]);
    await expect(branchButton()).toHaveText("feat/c");
    await expect($("#orca-files-title")).toHaveText("example-app ・ fix-login ・ feat/c");
  });

  it("leaves the heading as text for a worktree on no git branch (A-25)", async () => {
    await openFiles(branchFixtures(), orcaOverview(sample(), [orcaWorktree("example-app", "feat/a", { gitBranch: "" }), orcaWorktree("example-api", "main")]));
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/a");
    expect(await count("#orca-files-title button")).toBe(0);
    expect(await callsOf("orca_local_branches")).toEqual([]);
  });

  it("switches to a remote branch with its name as Orca lists it (A-25)", async () => {
    await openBranches();
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    await mock("orca_overview", onFeatC());
    await branchPick("remote", "origin/feat/d").click();
    expect(await waitForCalls("orca_switch_branch")).toEqual([{ path: "/work/example-app", kind: "remote", name: "origin/feat/d", environment: null }]);
    await expect($(".orca-dest-pop")).not.toExist();
  });

  it("only closes the list on the branch the worktree is on, and calls nothing on a branch in use (A-25)", async () => {
    await openBranches();
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    await browser.execute((once) => {
      if (window.__e2e_once__(once)) document.querySelector<HTMLElement>('.orca-dest-pop .orca-branch-row[data-name="main"]')!.click();
    }, onceId());
    await expect($(".orca-dest-pop")).toBeDisplayed();
    await branchPick("local", "feat/a").click();
    await expect($(".orca-dest-pop")).not.toExist();
    await browser.pause(300);
    expect(await callsOf("orca_switch_branch")).toEqual([]);
    await expect($("#error")).not.toBeDisplayed();
  });

  it("says a switch that worked with a warning in a notice and reads again (A-25)", async () => {
    await openBranches({ orca_switch_branch: { branch: "feat/c", warning: "post-checkout hook failed" } });
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    const overview = await mock("orca_overview", onFeatC());
    await branchPick("local", "feat/c").click();
    await expect($(".toast")).toHaveText(expect.stringContaining("feat/c に切り替えました: post-checkout hook failed"));
    await waitForCalls(overview);
    await expect($("#error")).not.toBeDisplayed();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/c");
  });

  it("shows Orca's refusal in the error, and reads nothing again (A-25)", async () => {
    await openBranches({ orca_switch_branch: rejects("未コミットの変更があるため切り替えられません") });
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    const overview = await mock("orca_overview", onFeatC());
    const files = await mock("orca_files_list", root());
    await branchPick("local", "feat/c").click();
    await expect($("#error")).toHaveText("未コミットの変更があるため切り替えられません");
    await expect($(".orca-dest-pop")).not.toExist();
    await browser.pause(300);
    expect(await callsOf(overview)).toEqual([]);
    expect(await callsOf(files)).toEqual([]);
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/a");
  });

  it("shows the message of the branches that cannot be read in their section, and the other section stays (A-25)", async () => {
    await openBranches({ orca_local_branches: rejects("worktree が見つかりません") });
    await expect($(".orca-dest-pop .empty.fail")).toHaveText("worktree が見つかりません");
    await waitForCount(".orca-dest-pop .orca-branch-row", 2);
    expect(await branchRows()).toEqual(["origin/feat/a", "origin/feat/d"]);
  });

  it("leaves the branch of an SSH host's worktree as text (A-25)", async () => {
    const hostRow = { key: "ssh:s1", name: "s1", status: "working" as const, sessions: 1, atMs: 0 };
    const hostTree = orcaWorktree("remote-app", "main", { path: "/home/dev/remote-app", projectKey: "ssh:s1" });
    const remoteRow = orcaRow("remote-app", "main", "Remote task", { projectKey: "ssh:s1", path: "/home/dev/remote-app", paneKey: "tab_remote:leaf_1", handle: "term_remote" });
    await openOrca(orcaOverview([remoteRow], [hostTree], { ssh: [orcaSsh("s1", "example-host")], hosts: [hostRow] }), { orca_terminal_read: ["$"], orca_files_list: root(), orca_files_ignored: [], ...branchFixtures() });
    await $('#orca-feed .orca-project[data-key="ssh:s1"]').click();
    await expect(selectedTab()).toBeDisplayed();
    await filesToggle().click();
    await expect($("#orca-files-title")).toHaveText("remote-app ・ main");
    expect(await count("#orca-files-title button")).toBe(0);
    expect(await callsOf("orca_local_branches")).toEqual([]);
  });
  // A-27: the history of the file pane. Rust reads the commits and the files of one (`orca_git_history`, `orca_commit_files`) and the diff of a file in a commit (`orca_commit_file_diff`); the page draws them, reads on at the end of the list and opens the diff tab.
  const commitId = (n: number) => `${n.toString(16).padStart(7, "0")}${"b".repeat(33)}`;
  const commitOf = (n: number, subject = `Commit ${n}`): OrcaCommit => ({ id: commitId(n), shortId: commitId(n).slice(0, 7), subject, author: "Alice Example", timeMs: Date.UTC(2024, 9, 17, 12, 0), parents: n > 1 ? [commitId(n - 1)] : [] });
  const page = (from: number, to: number, hasMore: boolean): OrcaCommitList => ({ commits: Array.from({ length: from - to + 1 }, (_, i) => commitOf(from - i)), hasMore, historyToken: "tok-1", historyChanged: false });
  const fileOf = (path: string, extra: Partial<OrcaCommitFile> = {}): OrcaCommitFile => ({ status: "modified", path, oldPath: null, added: 3, removed: 1, ...extra });
  const changedFiles = (files: OrcaCommitFile[], extra: Partial<OrcaCommitFiles> = {}): OrcaCommitFiles => ({ files, total: files.length, parentId: commitId(2), ...extra });
  const paneMode = (label: string) => $(`#orca-files-bar [aria-label="${label}"]`);
  const commitRows = () => count("#orca-history-list .orca-commit");
  const commitRow = (n: number) => $(`#orca-history-list .orca-commit[data-id="${commitId(n)}"]`);
  const historyFile = (path: string) => $(`#orca-history-files .orca-hfile[data-path="${path}"]`);
  const historyFixtures = (extra: Record<string, unknown> = {}) => ({ orca_git_history: page(3, 1, false), orca_commit_files: changedFiles([fileOf("src/a.rs"), fileOf("b.md", { status: "added", added: 10, removed: 0 })]), orca_commit_file_diff: diffOfA(), ...extra });
  async function openHistory(fixtures: Record<string, unknown> = {}) {
    await openFiles(historyFixtures(fixtures));
    await waitForCount("#orca-files-tree .orca-file", 4);
    await paneMode("履歴").click();
    await expect($("#orca-history")).toBeDisplayed();
  }
  const pressTwice = (selector: string) =>
    browser.execute(
      (q, once) => {
        if (!window.__e2e_once__(once)) return;
        document.querySelector(q)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      },
      selector,
      onceId(),
    );

  it("has the buttons of the files and of the history in the top row, and shows the files at the start without reading the history (A-27)", async () => {
    await openFiles(historyFixtures());
    await waitForCount("#orca-files-tree .orca-file", 4);
    const bar = await browser.execute(() => [...document.querySelectorAll<HTMLElement>("#orca-files-bar > button")].map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-pressed"), b.querySelector("svg") !== null]));
    expect(bar).toEqual([["ファイル", "true", true], ["履歴", "false", true], ["ファイル欄", "true", true]]);
    await expect($("#orca-files-tree")).toBeDisplayed();
    await expect($("#orca-history")).not.toBeDisplayed();
    expect(await callsOf("orca_git_history")).toEqual([]);
  });

  it("switches to the history, which is read with the worktree and the first 50 commits, and back to the files, which are not read again (A-27)", async () => {
    await openHistory();
    await expect(paneMode("履歴")).toHaveAttribute("aria-pressed", "true");
    await expect(paneMode("ファイル")).toHaveAttribute("aria-pressed", "false");
    await expect($("#orca-files-tree")).not.toBeDisplayed();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/a");
    expect(await waitForCalls("orca_git_history")).toEqual([{ path: "/work/example-app", limit: 50, skip: 0, historyToken: null, environment: null }]);
    const files = await mock("orca_files_list", root());
    const history = await mock("orca_git_history", page(3, 1, false));
    await paneMode("ファイル").click();
    await expect($("#orca-files-tree")).toBeDisplayed();
    await expect($("#orca-history")).not.toBeDisplayed();
    await paneMode("履歴").click();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await browser.pause(200);
    expect(await callsOf(files)).toEqual([]);
    expect(await callsOf(history)).toEqual([]);
  });

  it("lists the commits in the order given with the subject, the short id and the time (A-27)", async () => {
    await openHistory();
    await waitForCount("#orca-history-list .orca-commit", 3);
    expect(await textsOf("#orca-history-list .orca-commit-subject")).toEqual(["Commit 3", "Commit 2", "Commit 1"]);
    expect(await textsOf("#orca-history-list .orca-commit-id")).toEqual(["0000003", "0000002", "0000001"]);
    expect(await textsOf("#orca-history-list .orca-commit-time")).toEqual(["2024/10/17", "2024/10/17", "2024/10/17"]);
    await expect($("#orca-history-files .orca-hfile")).not.toExist();
    await expect($("#error")).not.toBeDisplayed();
  });

  it("reads the next commits at the end of the list with the number read so far as skip and the token of the first answer, and stops when there are no more (A-27)", async () => {
    await openFiles(historyFixtures({ orca_git_history: holds }));
    await waitForCount("#orca-files-tree .orca-file", 4);
    await paneMode("履歴").click();
    await waitForCalls("orca_git_history");
    await release("orca_git_history", page(120, 71, true));
    await waitForCount("#orca-history-list .orca-commit", 50);
    await browser.pause(300);
    expect(await callsOf("orca_git_history")).toHaveLength(1);
    const toEnd = () =>
      browser.execute(() => {
        const l = document.getElementById("orca-history-list")!;
        l.scrollTop = l.scrollHeight;
      });
    await toEnd();
    expect(await waitForCalls("orca_git_history", 2)).toEqual([
      { path: "/work/example-app", limit: 50, skip: 0, historyToken: null, environment: null },
      { path: "/work/example-app", limit: 50, skip: 50, historyToken: "tok-1", environment: null },
    ]);
    await release("orca_git_history", page(70, 21, true));
    await waitForCount("#orca-history-list .orca-commit", 100);
    await toEnd();
    await waitForCalls("orca_git_history", 3);
    await release("orca_git_history", page(20, 18, false));
    await waitForCount("#orca-history-list .orca-commit", 103);
    expect((await callsOf("orca_git_history"))[2]).toEqual({ path: "/work/example-app", limit: 50, skip: 100, historyToken: "tok-1", environment: null });
    await toEnd();
    await browser.pause(300);
    expect(await callsOf("orca_git_history")).toHaveLength(3);
  });

  it("adds the next commits under the rows there are, and a click draws no row of the list again (A-27)", async () => {
    await openHistory();
    await waitForCount("#orca-history-list .orca-commit", 3);
    const mark = () =>
      browser.execute(() => {
        for (const row of document.querySelectorAll("#orca-history-list .orca-commit")) (row as HTMLElement & { kept?: boolean }).kept = true;
      });
    const kept = () => browser.execute(() => [...document.querySelectorAll("#orca-history-list .orca-commit")].filter((row) => (row as HTMLElement & { kept?: boolean }).kept === true).length);
    await mark();
    await commitRow(3).click();
    await waitForCount("#orca-history-files .orca-hfile", 2);
    await historyFile("src/a.rs").click();
    await expect(historyFile("src/a.rs")).toHaveAttribute("aria-pressed", "true");
    await commitRow(2).click();
    await expect(commitRow(2)).toHaveAttribute("aria-pressed", "true");
    await expect(commitRow(3)).toHaveAttribute("aria-pressed", "false");
    expect(await kept()).toBe(3);
  });

  it("draws a commit that Orca gives twice once (A-27)", async () => {
    await openFiles(historyFixtures({ orca_git_history: holds }));
    await waitForCount("#orca-files-tree .orca-file", 4);
    await paneMode("履歴").click();
    await waitForCalls("orca_git_history");
    await release("orca_git_history", page(60, 11, true));
    await waitForCount("#orca-history-list .orca-commit", 50);
    await browser.execute(() => {
      const l = document.getElementById("orca-history-list")!;
      l.scrollTop = l.scrollHeight;
    });
    await waitForCalls("orca_git_history", 2);
    await release("orca_git_history", page(12, 8, false));
    await waitForCount("#orca-history-list .orca-commit", 53);
    expect(await count(`#orca-history-list .orca-commit[data-id="${commitId(11)}"]`)).toBe(1);
  });

  it("reads the list again from the start when Orca no longer holds the history it began (A-27)", async () => {
    await openFiles(historyFixtures({ orca_git_history: holds }));
    await waitForCount("#orca-files-tree .orca-file", 4);
    await paneMode("履歴").click();
    await waitForCalls("orca_git_history");
    await release("orca_git_history", page(60, 11, true));
    await waitForCount("#orca-history-list .orca-commit", 50);
    await browser.execute(() => {
      const l = document.getElementById("orca-history-list")!;
      l.scrollTop = l.scrollHeight;
    });
    await waitForCalls("orca_git_history", 2);
    await release("orca_git_history", { commits: [], hasMore: false, historyToken: "tok-1", historyChanged: true });
    await waitForCalls("orca_git_history", 3);
    expect((await callsOf("orca_git_history"))[2]).toEqual({ path: "/work/example-app", limit: 50, skip: 0, historyToken: null, environment: null });
    await release("orca_git_history", { ...page(5, 1, false), historyToken: "tok-2" });
    await waitForCount("#orca-history-list .orca-commit", 5);
  });

  it("reads the files of the commit pressed, with its full id, and draws their marks, names and counts (A-27)", async () => {
    const files = changedFiles([fileOf("src/a.rs"), fileOf("b.md", { status: "added", added: 10, removed: 0 }), fileOf("c.png", { status: "modified", added: null, removed: null }), fileOf("docs/new.md", { status: "renamed", oldPath: "old.md", added: 0, removed: 0 })], { total: 7 });
    await openHistory({ orca_commit_files: files });
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    expect(await waitForCalls("orca_commit_files")).toEqual([{ path: "/work/example-app", commitId: commitId(3), environment: null }]);
    await waitForCount("#orca-history-files .orca-hfile", 4);
    await expect(commitRow(3)).toHaveAttribute("aria-pressed", "true");
    await expect(commitRow(2)).toHaveAttribute("aria-pressed", "false");
    const rows = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>("#orca-history-files .orca-hfile")].map((r) => [r.dataset.status, r.querySelector(".orca-hfile-st")!.textContent, r.querySelector(".orca-hfile-name")!.textContent, r.querySelector(".orca-hfile-dir")!.textContent, r.querySelector(".orca-hfile-n")!.textContent, r.title]),
    );
    expect(rows).toEqual([
      ["modified", "M", "a.rs", "src", "+3−1", "src/a.rs"],
      ["added", "A", "b.md", "", "+10−0", "b.md"],
      ["modified", "M", "c.png", "", "", "c.png"],
      ["renamed", "R", "new.md", "docs", "+0−0", "old.md → docs/new.md"],
    ]);
    // More files than the list holds: the rest is counted.
    await expect($("#orca-history-files .orca-file-note")).toHaveText("ほか 3 件");
    await commitRow(2).click();
    await waitForCalls("orca_commit_files", 2);
    expect((await callsOf("orca_commit_files"))[1]).toEqual({ path: "/work/example-app", commitId: commitId(2), environment: null });
    await expect(commitRow(2)).toHaveAttribute("aria-pressed", "true");
  });

  it("drops the files that come for a commit that is not the chosen one any more (A-27)", async () => {
    await openHistory({ orca_commit_files: holds });
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await waitForCalls("orca_commit_files");
    await commitRow(2).click();
    await waitForCalls("orca_commit_files", 2);
    await release("orca_commit_files", changedFiles([fileOf("stale.rs")]));
    await browser.pause(200);
    await expect($("#orca-history-files .orca-hfile")).not.toExist();
    await release("orca_commit_files", changedFiles([fileOf("fresh.rs")]));
    await waitForCount("#orca-history-files .orca-hfile", 1);
    expect(await textsOf("#orca-history-files .orca-hfile-name")).toEqual(["fresh.rs"]);
  });

  it("opens the diff of a file of the commit as a tab on a double press, with the parent, the commit and the path, and the short id in the heading and the tab (A-27)", async () => {
    await openHistory();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await waitForCount("#orca-history-files .orca-hfile", 2);
    // A single press only chooses the file.
    await historyFile("src/a.rs").click();
    await expect(historyFile("src/a.rs")).toHaveAttribute("aria-pressed", "true");
    expect(await callsOf("orca_commit_file_diff")).toEqual([]);
    await pressTwice('#orca-history-files .orca-hfile[data-path="src/a.rs"]');
    expect(await waitForCalls("orca_commit_file_diff")).toEqual([{ path: "/work/example-app", commitId: commitId(3), parentId: commitId(2), relative: "src/a.rs", oldRelative: null, environment: null }]);
    expect(await callsOf("orca_file_diff")).toEqual([]);
    await expect(tabOf("diff:1")).toBeDisplayed();
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs 0000003"]);
    await expect(tabOf("diff:1").$(".orca-tab-btn")).toHaveAttribute("aria-selected", "true");
    await expect($(".orca-diff .orca-edit-path")).toHaveText("src/a.rs");
    await expect($(".orca-diff .orca-diff-commit")).toHaveText("0000003");
    await expect($(".orca-diff-count")).toHaveText("変更 2 件");
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await expect($("#error")).not.toBeDisplayed();
  });

  it("selects the diff tab that is open for the same file of the same commit and reads it again, and opens another tab for another commit (A-27)", async () => {
    await openHistory();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await waitForCount("#orca-history-files .orca-hfile", 2);
    await pressTwice('#orca-history-files .orca-hfile[data-path="src/a.rs"]');
    await waitForCalls("orca_commit_file_diff");
    await pressTwice('#orca-history-files .orca-hfile[data-path="src/a.rs"]');
    await waitForCalls("orca_commit_file_diff", 2);
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs 0000003"]);
    const calls = await callsOf("orca_commit_file_diff");
    expect(calls[1]).toEqual(calls[0]);
    await commitRow(2).click();
    await waitForCalls("orca_commit_files", 2);
    await waitForCount("#orca-history-files .orca-hfile", 2);
    await pressTwice('#orca-history-files .orca-hfile[data-path="src/a.rs"]');
    await waitForCalls("orca_commit_file_diff", 3);
    expect(await tabTitles()).toEqual(["Write the docs", "a.rs 0000003", "a.rs 0000002"]);
  });

  it("sends no parent for the first commit and the old path for a renamed file, and Enter opens the diff too (A-27)", async () => {
    const first = changedFiles([fileOf("docs/new.md", { status: "renamed", oldPath: "old.md" })], { parentId: null });
    await openHistory({ orca_commit_files: first });
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(1).click();
    await waitForCount("#orca-history-files .orca-hfile", 1);
    await browser.execute((once) => {
      if (!window.__e2e_once__(once)) return;
      document.querySelector<HTMLElement>('#orca-history-files .orca-hfile[data-path="docs/new.md"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, onceId());
    expect(await waitForCalls("orca_commit_file_diff")).toEqual([{ path: "/work/example-app", commitId: commitId(1), parentId: null, relative: "docs/new.md", oldRelative: "old.md", environment: null }]);
  });

  it("repeats the call of the commit when the diff tab is read again (A-27)", async () => {
    await openHistory();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await waitForCount("#orca-history-files .orca-hfile", 2);
    await pressTwice('#orca-history-files .orca-hfile[data-path="b.md"]');
    await waitForCount(".orca-diff-rows .odf-row", 7);
    await diffButton("読み直す").click();
    await waitForCalls("orca_commit_file_diff", 2);
    const calls = await callsOf("orca_commit_file_diff");
    expect(calls[1]).toEqual({ path: "/work/example-app", commitId: commitId(3), parentId: commitId(2), relative: "b.md", oldRelative: null, environment: null });
    expect(await callsOf("orca_file_diff")).toEqual([]);
  });

  it("shows the reason in place of the rows when the diff of the commit cannot be read (A-27)", async () => {
    await openHistory({ orca_commit_file_diff: rejects("バイナリのファイルの差分は表示できません") });
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await waitForCount("#orca-history-files .orca-hfile", 2);
    await pressTwice('#orca-history-files .orca-hfile[data-path="b.md"]');
    await expect($(".orca-diff .orca-empty")).toHaveText("バイナリのファイルの差分は表示できません");
    await expect($("#error")).not.toBeDisplayed();
  });

  it("shows the reason of a list that cannot be read, and the next return of the focus reads it again from the start (A-27)", async () => {
    await openHistory({ orca_git_history: rejects("Git の履歴を読めません") });
    await expect($("#orca-history-list .orca-file-note.fail")).toHaveText("Git の履歴を読めません");
    await expect($("#error")).not.toBeDisplayed();
    await browser.pause(300);
    expect(await callsOf("orca_git_history")).toHaveLength(1);
    await mock("orca_git_history", page(3, 1, false));
    await focusBack();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await expect($("#orca-history-list .orca-file-note")).not.toExist();
    expect(await callsOf("orca_git_history")).toEqual([{ path: "/work/example-app", limit: 50, skip: 0, historyToken: null, environment: null }]);
  });

  it("shows the reason of the files of a commit that cannot be read, and says so for a commit with no file (A-27)", async () => {
    await openHistory({ orca_commit_files: rejects("コミットのファイルを読めません") });
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await expect($("#orca-history-files .orca-file-note.fail")).toHaveText("コミットのファイルを読めません");
    await mock("orca_commit_files", changedFiles([]));
    await commitRow(2).click();
    await expect($("#orca-history-files .orca-file-note")).toHaveText("変更されたファイルはありません");
  });

  it("says so when the history has no commit (A-27)", async () => {
    await openHistory({ orca_git_history: { commits: [], hasMore: false, historyToken: null, historyChanged: false } });
    await expect($("#orca-history-list .orca-file-note")).toHaveText("コミットがありません");
  });

  it("reads the list again from the start when the focus comes back, and drops the chosen commit (A-27)", async () => {
    await openHistory();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await waitForCount("#orca-history-files .orca-hfile", 2);
    await mock("orca_git_history", page(4, 1, false));
    await focusBack();
    await waitForCount("#orca-history-list .orca-commit", 4);
    expect(await callsOf("orca_git_history")).toEqual([{ path: "/work/example-app", limit: 50, skip: 0, historyToken: null, environment: null }]);
    await expect($("#orca-history-files .orca-hfile")).not.toExist();
    await expect($('#orca-history-list .orca-commit[aria-pressed="true"]')).not.toExist();
  });

  it("follows the worktree of the selected tab: the list is read again, and the choice of the history stays (A-27)", async () => {
    const value = orcaOverview(sample(), [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-app", "feat/b", { path: "/work/example-app-b" })], {
      terminals: [orcaTerminal("example-app", "zsh", { path: "/work/example-app-b", branch: "feat/b" })],
    });
    await openFiles(historyFixtures(), value);
    await paneMode("履歴").click();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await waitForCount("#orca-history-files .orca-hfile", 2);
    const history = await mock("orca_git_history", page(9, 7, false));
    await tabOf(zsh).$(".orca-tab-btn").click();
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/b");
    expect(await waitForCalls(history)).toEqual([{ path: "/work/example-app-b", limit: 50, skip: 0, historyToken: null, environment: null }]);
    await browser.waitUntil(async () => (await textsOf("#orca-history-list .orca-commit-subject")).join() === "Commit 9,Commit 8,Commit 7", { timeoutMsg: "the list of the other worktree never showed" });
    await expect($("#orca-history-files .orca-hfile")).not.toExist();
    await expect($("#orca-history")).toBeDisplayed();
    await expect(paneMode("履歴")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the branch button of the heading in the history, and reads the list again from the start after a switch (A-27, A-25)", async () => {
    await openFiles(historyFixtures(branchFixtures()));
    await waitForCount("#orca-files-tree .orca-file", 4);
    await paneMode("履歴").click();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await expect(branchButton()).toHaveText("feat/a");
    await branchButton().click();
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    const history = await mock("orca_git_history", page(8, 6, false));
    await mock("orca_overview", onFeatC());
    await branchPick("local", "feat/c").click();
    expect(await waitForCalls(history)).toEqual([{ path: "/work/example-app", limit: 50, skip: 0, historyToken: null, environment: null }]);
    await browser.waitUntil(async () => (await textsOf("#orca-history-list .orca-commit-subject")).join() === "Commit 8,Commit 7,Commit 6", { timeoutMsg: "the new list never showed" });
    await expect(branchButton()).toHaveText("feat/c");
    await expect($("#orca-history")).toBeDisplayed();
  });

  it("keeps the choice and the list when the pane is hidden and shown again (A-27)", async () => {
    await openHistory();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await $("#orca-files-toggle").click();
    await expect($("#orca-files")).not.toBeDisplayed();
    await filesToggle().click();
    await expect($("#orca-files")).toBeDisplayed();
    await expect($("#orca-history")).toBeDisplayed();
    await expect($("#orca-files-tree")).not.toBeDisplayed();
    await browser.pause(200);
    expect(await commitRows()).toBe(3);
    expect(await callsOf("orca_git_history")).toHaveLength(1);
  });

  // #601: the clock of the Orca screen (10 seconds; 1 second here) reads again what the file pane and the panes show, with no return of the focus. #600: the heading follows the branch of the list a saved environment streams.
  const marked = (selector: string) => browser.execute((q) => document.querySelector<HTMLElement>(q)?.dataset.kept ?? null, selector);
  const markNode = (selector: string) =>
    browser.execute((q) => {
      document.querySelector<HTMLElement>(q)!.dataset.kept = "1";
    }, selector);

  it("reads the tree and the file shown again by the clock: a folder that did not change is not drawn again, a file with no unsaved typing takes the text of the disk and keeps its caret, one with unsaved typing is left alone, and a read that fails shows nothing (A-18)", async () => {
    await openFiles({ ...timers({ orcaClock: 1000 }), editor_settings: { autosaveMs: 60000 } });
    await openA();
    // The same entries: the rows are the ones that were drawn.
    await markNode('.orca-file[data-path="a.rs"]');
    const same = await mock("orca_files_list", root());
    expect((await waitForCalls(same))[0]).toEqual({ path: "/work/example-app", dir: "", ignored: false, environment: null });
    await browser.pause(300);
    expect(await marked('.orca-file[data-path="a.rs"]')).toBe("1");
    // A file made outside the app shows with no return of the focus.
    await mock("orca_files_list", dirOf("", [["src", true], ["target", true], ["a.rs", false], ["b.log", false], ["new.rs", false]]));
    await browser.waitUntil(async () => (await names()).includes("new.rs"), { timeoutMsg: "the new file never showed" });
    // The text changed outside the app: it takes the place of the one shown, and the caret stays.
    await browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.setSelectionRange(3, 3));
    const read = await mock("orca_file_read", text("fn main() {}\n// outside\n", "sig-2"));
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n// outside\n", { trim: false });
    expect((await callsOf(read))[0]).toEqual({ path: "/work/example-app", relative: "a.rs", environment: null });
    expect(await browser.execute(() => document.querySelector<HTMLTextAreaElement>(".orca-edit-area")!.selectionStart)).toBe(3);
    expect(await dirtyMarks()).toBe(0);
    // Typing that is not saved yet: the file is not read, and the text stays.
    await type("x");
    expect(await dirtyMarks()).toBe(1);
    const later = await mock("orca_file_read", text("other\n", "sig-3"));
    // A read of the tree that fails keeps the rows and says nothing.
    await mock("orca_files_list", rejects("Orca に接続できません"));
    await browser.pause(1200);
    expect(await callsOf(later)).toEqual([]);
    await expect($(".orca-edit-area")).toHaveValue("fn main() {}\n// outside\nx", { trim: false });
    expect(await count("#orca-files-tree .orca-file-note.fail")).toBe(0);
    expect(await names()).toContain("new.rs");
    await expect($("#error")).not.toBeDisplayed();
  });

  it("reads the diff shown and the history shown again by the clock: a diff that changed is drawn in place, the same commits are not drawn again, and a new commit comes to the top with the chosen commit kept (A-24, A-27)", async () => {
    await openFiles(historyFixtures(timers({ orcaClock: 1000 })));
    await waitForCount("#orca-files-tree .orca-file", 4);
    await mock("orca_file_diff", diffOfA());
    expect(await rightClickRow("a.rs")).toBe(true);
    await pickItem("差分を表示");
    await waitForCount(".orca-diff-rows .odf-row", 7);
    // The file changed outside the app: the rows follow with no press of the reload button.
    const diff = await mock("orca_file_diff", many());
    await waitForCount(".orca-diff-rows .odf-row", 200);
    expect((await callsOf(diff))[0]).toEqual({ path: "/work/example-app", relative: "a.rs", environment: null });
    await expect($("#error")).not.toBeDisplayed();
    // The history: the same first commits keep the rows that were drawn.
    await paneMode("履歴").click();
    await waitForCount("#orca-history-list .orca-commit", 3);
    await commitRow(3).click();
    await waitForCount("#orca-history-files .orca-hfile", 2);
    await markNode(`#orca-history-list .orca-commit[data-id="${commitId(3)}"]`);
    const same = await mock("orca_git_history", page(3, 1, false));
    expect((await waitForCalls(same))[0]).toEqual({ path: "/work/example-app", limit: 50, skip: 0, historyToken: null, environment: null });
    await browser.pause(300);
    expect(await marked(`#orca-history-list .orca-commit[data-id="${commitId(3)}"]`)).toBe("1");
    // A commit made outside the app comes to the top, and the chosen commit stays chosen with its files.
    await mock("orca_git_history", page(4, 1, false));
    await waitForCount("#orca-history-list .orca-commit", 4);
    expect(await textsOf("#orca-history-list .orca-commit-subject")).toEqual(["Commit 4", "Commit 3", "Commit 2", "Commit 1"]);
    await expect(commitRow(3)).toHaveAttribute("aria-pressed", "true");
    expect(await count("#orca-history-files .orca-hfile")).toBe(2);
  });

  it("reads the tree and the file shown again at once when the list of Orca shows another branch for the worktree, with no switch from the app (A-25)", async () => {
    await openFiles(branchFixtures());
    await openA();
    const list = await mock("orca_files_list", dirOf("", [["a.rs", false], ["only-c.rs", false]]));
    const read = await mock("orca_file_read", text("fn c() {}\n", "sig-c"));
    // The branch was switched in a terminal: the next read of the list says so (showing the screen again reads it here).
    await mock("orca_overview", onFeatC());
    await showAgain();
    await expect(branchButton()).toHaveText("feat/c");
    expect(await waitForCalls(list)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: null }]);
    await browser.waitUntil(async () => (await names()).join() === "a.rs,only-c.rs", { timeoutMsg: "the tree of the new branch never showed" });
    await expect($(".orca-edit-area")).toHaveValue("fn c() {}\n", { trim: false });
    expect((await callsOf(read))[0]).toEqual({ path: "/work/example-app", relative: "a.rs", environment: null });
    expect(await callsOf("orca_switch_branch")).toEqual([]);
  });

  it("shows the new branch in the heading of a saved environment, whose list is streamed: after a switch from the app without a second read of the tree, and after a switch made outside it with the tree read again (A-25, A-12)", async () => {
    const studioOnly = { target: "Studio", environments: ["Studio"] };
    // What the stream sends once Rust has read the worktrees again: example-app on `gitBranch`.
    const listOn = (gitBranch: string) =>
      streamList([orcaRow("example-app", "feat/c", "Write the docs", { minutes: 2 }), ...sample().slice(1)], [orcaWorktree("example-app", "feat/c", { gitBranch }), orcaWorktree("example-api", "main")]);
    await openOrca(orcaOverview([], [], studioOnly), { orca_files_list: root(), orca_files_ignored: rootIgnored, ...branchFixtures() });
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(sample(), worktrees()));
    await project("example-app").click();
    await expect(selectedTab()).toBeDisplayed();
    await filesToggle().click();
    await waitForCount("#orca-files-tree .orca-file", 4);
    await expect(branchButton()).toHaveText("feat/a");
    await branchButton().click();
    await waitForCount(".orca-dest-pop .orca-branch-row", 5);
    const files = await mock("orca_files_list", root());
    const overview = await mock("orca_overview", orcaOverview([], [], studioOnly));
    await branchPick("local", "feat/c").click();
    // Rust switches, and tells the stream to read the worktrees again (unit tests); the screen reads the tree once and asks for no list.
    expect(await waitForCalls("orca_switch_branch")).toEqual([{ path: "/work/example-app", kind: "local", name: "feat/c", environment: "Studio" }]);
    await waitForCalls(files);
    await sendStream(listOn("feat/c"));
    await expect(branchButton()).toHaveText("feat/c");
    await expect($("#orca-files-title")).toHaveText("example-app ・ feat/c");
    await browser.pause(300);
    expect(await callsOf(files)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: "Studio" }]);
    expect(await callsOf(overview)).toEqual([]);
    // A switch made outside the app comes with the next list of the stream: the heading follows, and the tree is read again.
    const again = await mock("orca_files_list", dirOf("", [["only-d.rs", false]]));
    await sendStream(listOn("feat/d"));
    await expect(branchButton()).toHaveText("feat/d");
    expect(await waitForCalls(again)).toEqual([{ path: "/work/example-app", dir: "", ignored: false, environment: "Studio" }]);
    await browser.waitUntil(async () => (await names()).join() === "only-d.rs", { timeoutMsg: "the tree of the new branch never showed" });
    expect(await callsOf("orca_switch_branch")).toHaveLength(1);
  });
});
