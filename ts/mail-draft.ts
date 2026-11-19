// The fields of the open reply (M-10) or of the new mail (M-11) that Claude Code reads and writes through tsunagiai-mcp (A-36): the target "mail-draft" of ts/screen-bridge.ts.
// Its fields are `thread` (the open thread enclosed as data, only read), `to`, `cc` and `bcc` (addresses separated by commas), `subject` (only a new mail takes it) and `body` (the Markdown of a reply, the plain text of a new mail).
// What Claude Code writes goes into the fields as it is, and 「元に戻す」 takes it back; nothing is sent or saved. Each side (the reply, the new mail) keeps what its fields held before each write, and the way back is shown only while the fields still hold what the newest write put there.
import { $ } from "./dom.js";
import { type Fields, registerDraftTarget } from "./screen-bridge.js";

export const NAMES = ["to", "cc", "bcc", "subject", "body"] as const;
export type Texts = Record<(typeof NAMES)[number], string>;

// One of the two screens that hold the fields: the reply under the thread, and the screen of a new mail.
export interface DraftSide {
  // The id of its button 「元に戻す」 and of the element that holds its fields (the clicks and the typing in it make the way back stale).
  undoId: string;
  rootId: string;
  // Whether the fields are in view now (the reply: a thread is open; the new mail: its screen is shown).
  isOpen(): boolean;
  // The thread as Claude Code reads it, enclosed as data.
  thread(): Promise<string>;
  // What the fields hold, as the owner sees them.
  read(): Texts;
  // Takes in what was typed in the address fields and not yet made a chip, so that it is read and replaced like the others.
  settle(): void;
  // True while a mail goes out: the fields cannot be written then.
  busy(): boolean;
  // Puts the texts into the fields named in `texts`; a refusal is a thrown error with a Japanese message.
  write(texts: Partial<Texts>): Promise<void>;
}

const sides: DraftSide[] = [];
// What each side's writes replaced (newest last): the texts before the write, of the fields it named, and the texts of all the fields after it.
const undos = new Map<DraftSide, { before: Partial<Texts>; after: Texts }[]>();

const same = (a: Texts, b: Texts) => NAMES.every((name) => a[name] === b[name]);

// True while a write of Claude Code (or its way back) is on its way: the fields hold the half of it then, which is no change of the owner's.
let writing = false;
async function whileWriting(side: DraftSide, texts: Partial<Texts>) {
  writing = true;
  try {
    await side.write(texts);
  } finally {
    writing = false;
  }
}

// Draws 「元に戻す」 of each side: shown while the fields hold what the newest write put there. A change of the owner's (or a send) makes every way back unusable, and they are forgotten.
export function refreshUndo() {
  if (writing) return;
  for (const side of sides) {
    const list = undos.get(side);
    const last = list?.[list.length - 1];
    if (list && last && !same(side.read(), last.after)) list.length = 0;
    $(side.undoId).hidden = !list?.length;
    $<HTMLButtonElement>(side.undoId).disabled = side.busy();
  }
}

// Forgets what the writes of a side replaced: the draft is another one, or it was sent or discarded.
export function clearUndo(side: DraftSide) {
  undos.delete(side);
  refreshUndo();
}

// The side whose fields are in view, if any.
const openSide = () => sides.find((side) => side.isOpen());

const refusal = (error: string): never => {
  throw new Error(error);
};

async function writeFields(fields: Fields) {
  const side = openSide();
  if (!side) return refusal("返信も新規作成も開いていません");
  if ("thread" in fields) return refusal("欄 thread は読むだけです");
  if (side.busy()) return refusal("送信の最中のため、書けません");
  side.settle();
  const before = side.read();
  await whileWriting(side, fields);
  const after = side.read();
  const named = NAMES.filter((name) => name in fields && before[name] !== after[name]);
  if (named.length) {
    const list = undos.get(side) ?? [];
    list.push({ before: Object.fromEntries(named.map((name) => [name, before[name]])), after });
    undos.set(side, list);
  }
  refreshUndo();
}

// Puts back the texts that the newest write of Claude Code replaced.
async function undo(side: DraftSide) {
  const last = undos.get(side)?.pop();
  if (!last || side.busy()) return;
  await whileWriting(side, last.before);
  refreshUndo();
}

// Adds a side. The first one registers the target.
export function addDraftSide(side: DraftSide) {
  if (sides.length === 0) {
    registerDraftTarget("mail-draft", {
      names: ["thread", ...NAMES],
      isOpen: () => openSide() !== undefined,
      read: async () => {
        const open = openSide()!;
        open.settle();
        return { thread: await open.thread(), ...open.read() };
      },
      write: writeFields,
    });
  }
  sides.push(side);
  const root = $(side.rootId);
  // A change by hand: the typing, the chip taken off and the kind of reply chosen.
  // The press of 「元に戻す」 itself is not one: its write is on its way.
  for (const event of ["input", "click", "change"]) root.addEventListener(event, (e) => e.target === $(side.undoId) || refreshUndo());
  $(side.undoId).onclick = () => void undo(side);
}
