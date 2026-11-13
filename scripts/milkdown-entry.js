// The entry of src/vendor/milkdown.js (A-26): Milkdown with the CommonMark and GFM presets and the history, under one global, `CookappsMilkdown`.
// An editor is read only until `edit` is called on it; the page decides, from `normalize`, whether the text may be edited.
import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx } from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import {
  commonmark,
  createCodeBlockCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose, callCommand, getMarkdown, replaceAll } from "@milkdown/kit/utils";

function make(root, markdown, state, editable = false) {
  // Tells the page, at once and without the text, that the document changed (the page asks for the text when it needs it).
  const watch = $prose(
    () =>
      new Plugin({
        view: () => ({
          update: (view, previous) => {
            if (!view.state.doc.eq(previous.doc)) state.onEdit?.();
          },
        }),
      }),
  );
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => editable }));
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(watch)
    .create();
}

// Draws `markdown` in `root`, read only. `markdown()` is what the editor exports now, `edit(onEdit)` makes it editable and calls `onEdit` after each change of the document, and `destroy` takes the editor out of `root`.
export async function mount(root, markdown) {
  const state = { onEdit: null };
  const editor = await make(root, markdown, state);
  return {
    destroy: () => editor.destroy(),
    markdown: () => editor.action(getMarkdown()),
    edit: (onEdit) => {
      state.onEdit = onEdit;
      editor.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => true }));
    },
  };
}

// What an editor exports for `markdown`, drawn nowhere. The page exports the export again, to know that loading and exporting a text twice gives the same text.
export async function normalize(markdown) {
  const editor = await make(document.createElement("div"), markdown, { onEdit: null });
  const exported = editor.action(getMarkdown());
  await editor.destroy();
  return exported;
}

const COMPOSE_COMMANDS = {
  bold: toggleStrongCommand,
  italic: toggleEmphasisCommand,
  strike: toggleStrikethroughCommand,
  link: toggleLinkCommand,
  orderedList: wrapInOrderedListCommand,
  bulletList: wrapInBulletListCommand,
  quote: wrapInBlockquoteCommand,
  code: toggleInlineCodeCommand,
  codeBlock: createCodeBlockCommand,
};

// An editable editor for writing a message (S-21), empty to begin with. `onChange` is called after each change of the document, also one made by `set`.
// `markdown()` is what it exports, `blank()` whether it holds no text but spaces, `set(markdown)` replaces its content, `run(name, payload)` runs one command of the toolbar
// (bold, italic, strike, link with `{href}`, orderedList, bulletList, quote, code, codeBlock) and gives the focus back to the text, `focus()` focuses it, `setEditable(on)` turns the typing on or off, and `destroy` takes the editor out of `root`.
export async function compose(root, onChange) {
  const state = { onEdit: onChange };
  const editor = await make(root, "", state, true);
  const view = () => editor.action((ctx) => ctx.get(editorViewCtx));
  return {
    destroy: () => editor.destroy(),
    markdown: () => editor.action(getMarkdown()),
    blank: () => view().state.doc.textContent.trim() === "",
    set: (markdown) => editor.action(replaceAll(markdown)),
    focus: () => view().focus(),
    setEditable: (on) => view().setProps({ editable: () => on }),
    run: (name, payload) => {
      editor.action(callCommand(COMPOSE_COMMANDS[name].key, payload));
      view().focus();
    },
  };
}
