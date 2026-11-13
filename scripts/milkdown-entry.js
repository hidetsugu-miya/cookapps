// The entry of src/vendor/milkdown.js (A-26): Milkdown with the CommonMark and GFM presets, the history and the listener, under one global, `CookappsMilkdown`.
// The page only reads with it for now: the editor is not editable.
import { defaultValueCtx, Editor, editorViewOptionsCtx, rootCtx } from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";

// Draws `markdown` in `root`. The answer's `destroy` takes the editor out of `root`.
export async function mount(root, markdown) {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false }));
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener)
    .create();
  return { destroy: () => editor.destroy() };
}
