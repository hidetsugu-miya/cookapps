// The conversation with Claude that edits a text, shared by the Todo prompt screen (S-3), the Slack compose screen (S-4), the Slack thread (S-7), the Todo draft page (S-18) and the Todo screen's Claude pane (T-7):
// the log with its diff cards, the request field that grows with its text, and the clear button. A proposal is applied to the owner's text, and the owner decides what to do with it.
// The Todo pane proposes tasks, not a change of a text: its answers carry `tasks`, which `cards` draws under the reply.
// The elements are in the owner's HTML, with the ids `{prefix}-log`, `-input`, `-send`, `-clear`, `-form` and `-chat-note`, and `-keys` unless `keyHint` is false.
import type { DiffLine } from "./bindings/DiffLine";
import type { PromptEdit } from "./bindings/PromptEdit";
import type { Target } from "./bindings/Target";
import type { TodoTaskProposal } from "./bindings/TodoTaskProposal";
import { getClaude } from "./claude.js";
import { $, composing, isMac, tag } from "./dom.js";

// What Claude answered: the reply, and a proposed change of the text (`body` and `diff`), proposed tasks, or the destination it chose (the Slack compose screen, S-4).
export type ChatAnswer = PromptEdit & { tasks?: TodoTaskProposal[]; destination?: Target | null };

export interface ChatTurnPayload {
  role: "user" | "assistant";
  text: string;
}

export interface ChatConfig {
  prefix: string;
  // What the note says while Claude cannot be used.
  loginNote: string;
  // The text the conversation is about now; null while there is none, which turns the conversation off.
  text: () => string | null;
  // Puts an applied proposal into the text.
  apply: (text: string) => void;
  // Asks Claude about `text` with the conversation so far and the new request. Nothing is saved.
  ask: (text: string, history: ChatTurnPayload[], instruction: string) => Promise<ChatAnswer>;
  // Called with an answer that is kept (not one that arrives after the conversation was forgotten, nor a failure), before the text is changed and the log is drawn.
  answered?: (answer: ChatAnswer) => void;
  // Draws the tasks an answer proposes, under its reply; without it `tasks` is not drawn.
  cards?: (tasks: TodoTaskProposal[]) => HTMLElement;
  // The lines (one per task) that tell Claude what an earlier answer proposed; they are added to that answer's text in the history it is sent, because the cards are not text. Without it only the text is sent.
  tasksText?: (tasks: TodoTaskProposal[]) => string;
  // The conversation changed: the owner draws what follows from it, and calls `refresh`.
  changed: () => void;
  // True while the owner's text must not be replaced (a proposal cannot be applied then).
  locked?: () => boolean;
  // Adds a "コピー" button to an open proposal, between "却下" and "適用"; it is called with the proposed text, straight from the click. Without it there is no such button.
  copy?: (text: string) => void;
  // Whether the `-keys` element tells the keys of the request field (default true); the owner that says it elsewhere, or not at all, passes false and has no such element.
  keyHint?: boolean;
  // True when the request field keeps the height the CSS gives it and scrolls inside (default false: it grows with its text).
  fixedInput?: boolean;
  // True when an answer that changes the text is put into it at once (default false: the proposal waits for "適用"). The log then keeps the number of changed lines and "元に戻す" instead of the diff.
  // An answer that arrives after the text was changed, or while the text is locked, is not put in: it stays a proposal that cannot be applied.
  autoApply?: boolean;
}

// A change Claude proposed: the whole new text, the lines that differ, and the text when it was asked (an `open` proposal applies only to that text).
interface Proposal {
  body: string;
  diff: DiffLine[];
  base: string;
  state: "open" | "applied" | "rejected" | "reverted";
  // Put into the text at once (`autoApply`): drawn as a count and "元に戻す", and the text it made is `body`.
  auto?: boolean;
}
export interface Turn {
  role: "user" | "assistant";
  text: string;
  // An error shown in the conversation; it is not part of what Claude is sent.
  failed?: boolean;
  proposal?: Proposal;
  tasks?: TodoTaskProposal[];
}

// The oldest turns are dropped past this many. Rust keeps the last CHAT_TURNS of what it is sent.
const MAX_TURNS = 100;

export function createChat(cfg: ChatConfig) {
  const id = (name: string) => `${cfg.prefix}-${name}`;
  // The conversation shown now. `use` swaps it for another (the Slack reply keeps one per thread); every change is made in place.
  let turns: Turn[] = [];
  let sending = false;
  // Bumped when the conversation is forgotten: an answer that was asked before it belongs to a conversation that is gone, and is dropped.
  let generation = 0;
  // The generation of the request on its way; "Claude が考えています" is shown only while it is the current one.
  let sendingGeneration = 0;
  let clearTimer = 0;
  // The apply buttons of the open proposals drawn now, with the line that says why one is disabled.
  let applyControls: { proposal: Proposal; apply: HTMLButtonElement; stale: HTMLElement }[] = [];
  // The "元に戻す" buttons of the proposals put in at once: one works only while the text is still the one that proposal made.
  let undoControls: { proposal: Proposal; undo: HTMLButtonElement }[] = [];

  function disarmClear() {
    clearTimeout(clearTimer);
    const clear = $(id("clear"));
    clear.classList.remove("confirm", "danger");
    clear.textContent = "クリア";
  }

  // Draws what follows from the state: whether the conversation can be used, the clear button, the login note and the apply buttons. Returns whether a request can be sent now.
  function refresh() {
    const text = cfg.text();
    const ready = getClaude()?.state === "ready";
    const on = text !== null && ready && !sending;
    $<HTMLTextAreaElement>(id("input")).disabled = !on;
    $<HTMLButtonElement>(id("send")).disabled = !on;
    const noClear = turns.length === 0 || sending;
    $<HTMLButtonElement>(id("clear")).disabled = noClear;
    if (noClear && $(id("clear")).classList.contains("confirm")) disarmClear();
    $(id("chat-note")).hidden = ready;
    for (const { proposal, apply, stale } of applyControls) {
      apply.disabled = proposal.base !== text || (cfg.locked?.() ?? false);
      stale.hidden = proposal.base === text;
    }
    for (const { proposal, undo } of undoControls) undo.disabled = proposal.body !== text || (cfg.locked?.() ?? false);
    return on;
  }

  // What stays in the log of a proposal that was put in at once: how many lines it changed, and "元に戻す" while the text is still the one it made.
  function appliedCard(p: Proposal) {
    const card = tag("div", "chat-diff");
    const foot = tag("div", "diff-foot");
    if (p.state === "reverted") {
      foot.append(tag("span", "diff-state", "元に戻しました"));
    } else {
      const lines = Math.max(1, p.diff.filter((d) => d.kind === "del").length, p.diff.filter((d) => d.kind === "ins").length);
      const undo = tag("button", "text-btn", "元に戻す");
      undo.onclick = () => {
        cfg.apply(p.base);
        p.state = "reverted";
        draw();
      };
      undoControls.push({ proposal: p, undo });
      foot.append(tag("span", "diff-count", `${lines} 行を変えました`), undo);
    }
    card.append(foot);
    return card;
  }

  function diffCard(p: Proposal) {
    if (p.auto) return appliedCard(p);
    const card = tag("div", "chat-diff");
    for (const d of p.diff) card.append(tag("div", d.kind === "del" ? "diff-del" : "diff-ins", `${d.kind === "del" ? "-" : "+"} ${d.text}`));
    const foot = tag("div", "diff-foot");
    if (p.state !== "open") {
      foot.append(tag("span", "diff-state", p.state === "applied" ? "適用しました" : "却下しました"));
    } else {
      const stale = tag("span", "diff-stale", "編集欄が変わったため適用できません");
      const reject = tag("button", "text-btn", "却下");
      const apply = tag("button", "text-btn primary", "適用");
      const copy = cfg.copy ? tag("button", "text-btn", "コピー") : null;
      reject.onclick = () => {
        p.state = "rejected";
        draw();
      };
      apply.onclick = () => {
        cfg.apply(p.body);
        p.state = "applied";
        draw();
      };
      if (copy) copy.onclick = () => cfg.copy!(p.body);
      applyControls.push({ proposal: p, apply, stale });
      foot.append(stale, reject, ...(copy ? [copy] : []), apply);
    }
    card.append(foot);
    return card;
  }

  function turnNode(t: Turn) {
    if (t.failed) return tag("div", "pending fail", t.text);
    if (t.role === "user") return tag("div", "chat-user", t.text);
    const node = tag("div", "chat-ai", t.text);
    if (t.proposal) node.append(diffCard(t.proposal));
    if (t.tasks?.length && cfg.cards) node.append(cfg.cards(t.tasks));
    return node;
  }

  function draw() {
    applyControls = [];
    undoControls = [];
    const thinking = tag("div", "pending");
    thinking.append(tag("span", "spin"), tag("span", "sp", "Claude が考えています…"));
    const log = $(id("log"));
    log.replaceChildren(...turns.map(turnNode), ...(sending && sendingGeneration === generation ? [thinking] : []));
    log.scrollTop = log.scrollHeight;
    cfg.changed();
  }

  function addTurn(turn: Turn) {
    turns.push(turn);
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
  }

  // The request field is one line high and grows with what is typed, up to 6 lines (the `max-height` of `.chat-input`; then it scrolls).
  // It sits at the bottom of the pane, so the log above shrinks; when the log was scrolled to its end it stays there, and the newest turn is not pushed out of sight.
  // The layout is read only when the line count may have changed: when the text got shorter, or the field is too short for it.
  let typedLength = 0;
  function growInput() {
    if (cfg.fixedInput) return;
    const [input, log] = [$<HTMLTextAreaElement>(id("input")), $(id("log"))];
    const shorter = input.value.length < typedLength;
    typedLength = input.value.length;
    if (!shorter && input.scrollHeight <= input.clientHeight) return;
    const before = input.clientHeight;
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 4;
    if (shorter) input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    if (atEnd && input.clientHeight !== before) log.scrollTop = log.scrollHeight;
  }

  // Sends the typed request, or `fixed` (a request of the owner's own, which leaves the typed text alone).
  async function send(fixed?: string) {
    const input = $<HTMLTextAreaElement>(id("input"));
    const instruction = (fixed ?? input.value).trim();
    const body = cfg.text();
    if (!instruction || sending || body === null) return;
    const history = turns
      .filter((t) => !t.failed)
      .map(({ role, text, tasks }) => {
        const lines = tasks?.length ? cfg.tasksText?.(tasks) : "";
        return { role, text: lines ? `${text}\n${lines}` : text };
      });
    if (fixed === undefined) {
      input.value = "";
      growInput();
    }
    const mine = generation;
    addTurn({ role: "user", text: instruction });
    sending = true;
    sendingGeneration = mine;
    draw();
    let turn: Turn;
    let answer: ChatAnswer | undefined;
    try {
      answer = await cfg.ask(body, history, instruction);
      turn = {
        role: "assistant",
        text: answer.reply,
        proposal: answer.body === null ? undefined : { body: answer.body, diff: answer.diff, base: body, state: "open" },
        tasks: answer.tasks,
      };
    } catch (e) {
      turn = { role: "assistant", text: `送れませんでした: ${e}`, failed: true };
    }
    sending = false;
    // The conversation was forgotten meanwhile: the answer is dropped, and the request field is free again.
    if (mine !== generation) return cfg.changed();
    if (answer) cfg.answered?.(answer);
    const proposal = turn.proposal;
    if (cfg.autoApply && proposal && proposal.body !== body && cfg.text() === body && !cfg.locked?.()) {
      cfg.apply(proposal.body);
      proposal.state = "applied";
      proposal.auto = true;
    }
    addTurn(turn);
    draw();
  }

  // Forgets the conversation (not the owner's text or what is being typed).
  // An answer still on its way is dropped when it arrives, and `sending` stays up until then, so only one request is on its way.
  function reset() {
    generation++;
    turns.length = 0;
    disarmClear();
    draw();
  }

  // Shows another conversation (kept by the owner). An answer asked in the one shown before belongs to a conversation that is not shown any more, and is dropped.
  function use(next: Turn[]) {
    generation++;
    turns = next;
    disarmClear();
    draw();
  }

  function clearInput() {
    // Not `growInput`: the pane can be hidden, where `scrollHeight` reads 0 and would set the height to 0px.
    const input = $<HTMLTextAreaElement>(id("input"));
    input.value = "";
    input.style.height = "";
    typedLength = 0;
  }

  function init() {
    // Clearing forgets the conversation only, so it takes two presses: the first arms, and leaving the button or 4 seconds disarms.
    $(id("clear")).onclick = () => {
      const clear = $(id("clear"));
      if (!clear.classList.contains("confirm")) {
        clear.classList.add("confirm", "danger");
        clear.textContent = "もう一度押すとクリア";
        clearTimer = setTimeout(disarmClear, 4000);
        return;
      }
      reset();
    };
    $(id("clear")).onblur = disarmClear;
    $(id("chat-note")).textContent = cfg.loginNote;
    if (cfg.keyHint !== false) $(id("keys")).textContent = isMac ? "↩ で改行、⌘↩ で送信" : "Enter で改行、Ctrl+Enter で送信";
    const input = $<HTMLTextAreaElement>(id("input"));
    input.oninput = growInput;
    // Enter is a line break; Cmd+Enter (Ctrl+Enter off macOS) sends, unless it only confirms an IME conversion.
    input.onkeydown = (e) => {
      if (e.key !== "Enter" || composing(e) || !(isMac ? e.metaKey : e.ctrlKey)) return;
      e.preventDefault();
      send();
    };
    $(id("form")).onsubmit = (e) => {
      e.preventDefault();
      send();
    };
  }

  return { init, draw, refresh, send, reset, use, clearInput };
}
