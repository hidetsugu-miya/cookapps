// The request field of a Claude pane (A-2, T-7, S-3, S-4, S-7, S-18): one frame that holds the field, which starts as one line and grows with its text (claude-chat.ts grows it),
// and, in the row under it, the model and effort selects at the left (a slot that `showModelSlot` of claude.ts fills) and the round send button at the right.
// It makes the form with the ids `{prefix}-form`, `-input`, `-model` and `-send` that claude-chat.ts reads; the owner puts it in the pane (before `chat.init()`), and may put more in the form, above the frame.
// `model: false` leaves the slot out, for a pane that has no model to choose. The field has no placeholder (`.claude/rules/frontend.md`).
import { tag } from "./dom.js";
import { ARROW_UP_SVG } from "./icons.js";

export interface ComposerOptions {
  prefix: string;
  // The accessible name of the field.
  label: string;
  // Whether the row holds the model and effort slot (default true).
  model?: boolean;
}

export function createComposer({ prefix, label, model = true }: ComposerOptions) {
  const input = tag("textarea", "chat-input");
  input.id = `${prefix}-input`;
  input.rows = 1;
  input.setAttribute("aria-label", label);
  input.autocomplete = "off";
  const send = tag("button", "icon-btn chat-send chat-send-icon");
  send.id = `${prefix}-send`;
  send.setAttribute("aria-label", "送信");
  send.insertAdjacentHTML("beforeend", ARROW_UP_SVG);
  const foot = tag("div", "composer-foot composer-end");
  if (model) {
    const slot = tag("div", "chat-model");
    slot.id = `${prefix}-model`;
    foot.append(slot);
  }
  foot.append(send);
  const frame = tag("div", "composer");
  frame.append(input, foot);
  const form = tag("form", "chat-form");
  form.id = `${prefix}-form`;
  form.append(frame);
  return form;
}
