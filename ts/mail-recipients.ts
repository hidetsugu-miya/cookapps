// The recipient rows of a mail being written (M-10, M-11): the chips of To, Cc and Bcc, the field that adds one, and the words that open Cc and Bcc.
import type { Recipient } from "./bindings/Recipient";
import { $, composing, tag } from "./dom.js";

export type Kind = "to" | "cc" | "bcc";
const KINDS: Kind[] = ["to", "cc", "bcc"];

// The addresses of a text: each one ends at a comma, a semicolon or a line break that is not inside double quotes or angle brackets (`"Doe, John" <john@example.com>` is one), and blank ones are left out.
function addressesOf(text: string) {
  const found: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angled = true;
    else if (!quoted && c === ">") angled = false;
    if (!quoted && !angled && (c === "," || c === ";" || c === "\n")) {
      found.push(current);
      current = "";
    } else current += c;
  }
  found.push(current);
  return found.map((a) => a.trim()).filter(Boolean);
}

// The rows whose elements have the ids `{prefix}-{kind}-field` and `{prefix}-{kind}-input`, and for Cc and Bcc `{prefix}-{kind}-row` and `{prefix}-{kind}-open`.
export function recipientRows(prefix: string) {
  const people: Record<Kind, Recipient[]> = { to: [], cc: [], bcc: [] };
  // The label of each address that a chip showed (the name of the person), kept so that a write that replaced the chips can be taken back with the same labels.
  const labels = new Map<string, string>();
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
    for (const p of [...to, ...cc]) labels.set(p.mailbox, p.label);
    people.to = [...to];
    people.cc = [...cc];
    for (const kind of KINDS) drawChips(kind);
    syncRows();
  }

  return {
    fill,
    // Replaces the chips of one row with the addresses of `text` (separated by commas, semicolons or line breaks outside quotes and angle brackets; blank ones are left out), as Claude Code writes them (A-36). An address that a chip showed keeps its label (so the way back of a write finds the chips as they were). The address typed in the field stays.
    set(kind: Kind, text: string) {
      people[kind] = addressesOf(text).map((a) => ({ label: labels.get(a) ?? a, mailbox: a }));
      drawChips(kind);
      syncRows();
    },
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
