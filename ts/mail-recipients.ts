// The recipient rows of a mail being written (M-10, M-11): the chips of To, Cc and Bcc, the field that adds one, and the words that open Cc and Bcc.
import type { Recipient } from "./bindings/Recipient";
import { $, composing, tag } from "./dom.js";

export type Kind = "to" | "cc" | "bcc";
const KINDS: Kind[] = ["to", "cc", "bcc"];

// The rows whose elements have the ids `{prefix}-{kind}-field` and `{prefix}-{kind}-input`, and for Cc and Bcc `{prefix}-{kind}-row` and `{prefix}-{kind}-open`.
export function recipientRows(prefix: string) {
  const people: Record<Kind, Recipient[]> = { to: [], cc: [], bcc: [] };
  // Cc and Bcc show once they were opened or hold someone.
  const opened = { cc: false, bcc: false };
  const input = (kind: Kind) => $<HTMLInputElement>(`${prefix}-${kind}-input`);

  function drawChips(kind: Kind) {
    const field = $(`${prefix}-${kind}-field`);
    for (const chip of field.querySelectorAll(".mail-reply-chip")) chip.remove();
    for (const [i, p] of people[kind].entries()) {
      const chip = tag("span", "mail-reply-chip");
      chip.title = p.mailbox;
      const remove = tag("button", "mail-reply-chip-x", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `${p.label} を外す`);
      remove.onclick = () => {
        people[kind].splice(i, 1);
        drawChips(kind);
      };
      chip.append(tag("span", "", p.label), remove);
      field.insertBefore(chip, input(kind));
    }
  }

  function syncRows() {
    for (const kind of ["cc", "bcc"] as const) {
      if (people[kind].length) opened[kind] = true;
      $(`${prefix}-${kind}-row`).hidden = !opened[kind];
      $(`${prefix}-${kind}-open`).hidden = opened[kind];
    }
  }

  // The address typed in the field becomes a chip; it is checked when the mail is sent.
  function commit(kind: Kind) {
    const field = input(kind);
    const text = field.value.replace(/[,;]+$/, "").trim();
    field.value = "";
    if (!text) return;
    people[kind].push({ label: text, mailbox: text });
    drawChips(kind);
  }

  // To and Cc are set; Bcc is left as it is.
  function fill(to: Recipient[], cc: Recipient[]) {
    people.to = [...to];
    people.cc = [...cc];
    for (const kind of KINDS) drawChips(kind);
    syncRows();
  }

  return {
    fill,
    // The rows as they are for a new mail: To and Cc as given, no Bcc, nothing typed, and Cc and Bcc closed.
    reset(to: Recipient[], cc: Recipient[]) {
      people.bcc = [];
      opened.cc = opened.bcc = false;
      for (const kind of KINDS) input(kind).value = "";
      fill(to, cc);
    },
    commitAll() {
      for (const kind of KINDS) commit(kind);
    },
    mailboxes: (kind: Kind) => people[kind].map((p) => p.mailbox),
    init() {
      for (const kind of KINDS) {
        const field = input(kind);
        field.onkeydown = (e) => {
          if (e.key === "Enter" && !composing(e)) {
            e.preventDefault();
            commit(kind);
          }
        };
        // A comma ends the address whichever way it came into the field (typed, pasted or inserted by an input method), so it is read from the text, not from the key.
        field.oninput = (e) => {
          if (!(e as InputEvent).isComposing && field.value.endsWith(",")) commit(kind);
        };
        field.onblur = () => commit(kind);
      }
      for (const kind of ["cc", "bcc"] as const) {
        $(`${prefix}-${kind}-open`).onclick = () => {
          opened[kind] = true;
          syncRows();
          input(kind).focus();
        };
      }
    },
  };
}
