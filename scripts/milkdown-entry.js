// The entry of src/vendor/milkdown.js (A-26): Milkdown with the CommonMark and GFM presets and the history, under one global, `CookappsMilkdown`.
// An editor is read only until `edit` is called on it; the page decides, from `normalize`, whether the text may be edited.
import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx } from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose, getMarkdown } from "@milkdown/kit/utils";

function make(root, markdown, state) {
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
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false }));
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
