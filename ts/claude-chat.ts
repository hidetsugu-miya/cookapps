// The conversation with Claude that edits a text, shared by the Todo prompt screen (S-3) and the Slack compose screen (S-4):
// the log with its diff cards, the request field that grows with its text, and the clear button. A proposal is applied to the owner's text, and the owner decides what to do with it.
// The elements are in the owner's HTML, with the ids `{prefix}-log`, `-input`, `-send`, `-clear`, `-keys`, `-form` and `-chat-note`.
import type { DiffLine } from "./bindings/DiffLine";
import type { PromptEdit } from "./bindings/PromptEdit";
import { getClaude } from "./claude.js";
import { $, composing, isMac, tag } from "./dom.js";

export interface ChatTurnPayload {
  role: "user" | "assistant";
  text: string;
}

export interface ChatConfig {
  prefix: string;
  // What the note says while Claude is not logged in.
  loginNote: string;
  // The text the conversation is about now; null while there is none, which turns the conversation off.
  text: () => string | null;
  // Puts an applied proposal into the text.
  apply: (text: string) => void;
  // Asks Claude about `text` with the conversation so far and the new request. Nothing is saved.
  ask: (text: string, history: ChatTurnPayload[], instruction: string) => Promise<PromptEdit>;
  // The conversation changed: the owner draws what follows from it, and calls `refresh`.
  changed: () => void;
}

// A change Claude proposed: the whole new text, the lines that differ, and the text when it was asked (an `open` proposal applies only to that text).
interface Proposal {
  body: string;
  diff: DiffLine[];
  base: string;
  state: "open" | "applied" | "rejected";
}
interface Turn {
  role: "user" | "assistant";
  text: string;
  // An error shown in the conversation; it is not part of what Claude is sent.
  failed?: boolean;
  proposal?: Proposal;
}

// The oldest turns are dropped past this many; Claude is sent the last SENT_TURNS (the same as Rust's CHAT_TURNS).
const MAX_TURNS = 100;
const SENT_TURNS = 20;

export function createChat(cfg: ChatConfig) {
  const id = (name: string) => `${cfg.prefix}-${name}`;
  const turns: Turn[] = [];
  let sending = false;
  // Bumped when the conversation is forgotten: an answer that was asked before it belongs to a conversation that is gone, and is dropped.
  let generation = 0;
  let clearTimer = 0;
  // The apply buttons of the open proposals drawn now, with the line that says why one is disabled.
  let applyControls: { proposal: Proposal; apply: HTMLButtonElement; stale: HTMLElement }[] = [];

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
    $(id("chat-note")).textContent = cfg.loginNote;
    for (const { proposal, apply, stale } of applyControls) {
      apply.disabled = proposal.base !== text;
      stale.hidden = !apply.disabled;
    }
    return on;
  }

  function diffCard(p: Proposal) {
    const card = tag("div", "chat-diff");
    for (const d of p.diff) card.append(tag("div", d.kind === "del" ? "diff-del" : "diff-ins", `${d.kind === "del" ? "-" : "+"} ${d.text}`));
    const foot = tag("div", "diff-foot");
    if (p.state !== "open") {
      foot.append(tag("span", "diff-state", p.state === "applied" ? "適用しました" : "却下しました"));
    } else {
      const stale = tag("span", "diff-stale", "編集欄が変わったため適用できません");
      const reject = tag("button", "text-btn", "却下");
      const apply = tag("button", "text-btn primary", "適用");
      reject.onclick = () => {
        p.state = "rejected";
        draw();
      };
      apply.onclick = () => {
        cfg.apply(p.body);
        p.state = "applied";
        draw();
      };
      applyControls.push({ proposal: p, apply, stale });
      foot.append(stale, reject, apply);
    }
    card.append(foot);
    return card;
  }

  function turnNode(t: Turn) {
    if (t.failed) return tag("div", "pending fail", t.text);
    if (t.role === "user") return tag("div", "chat-user", t.text);
    const node = tag("div", "chat-ai", t.text);
    if (t.proposal) node.append(diffCard(t.proposal));
    return node;
  }

  function draw() {
    applyControls = [];
    const thinking = tag("div", "pending");
    thinking.append(tag("span", "spin"), tag("span", "sp", "Claude が考えています…"));
    const log = $(id("log"));
    log.replaceChildren(...turns.map(turnNode), ...(sending ? [thinking] : []));
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
      .slice(-SENT_TURNS)
      .map(({ role, text }) => ({ role, text }));
    if (fixed === undefined) {
      input.value = "";
      growInput();
    }
    const mine = generation;
    addTurn({ role: "user", text: instruction });
    sending = true;
    draw();
    try {
      const answer = await cfg.ask(body, history, instruction);
      if (mine !== generation) return;
      addTurn({
        role: "assistant",
        text: answer.reply,
        proposal: answer.body === null ? undefined : { body: answer.body, diff: answer.diff, base: body, state: "open" },
      });
    } catch (e) {
      if (mine !== generation) return;
      addTurn({ role: "assistant", text: `送れませんでした: ${e}`, failed: true });
    }
    sending = false;
    draw();
  }

  // Forgets the conversation (not the owner's text or what is being typed). An answer still on its way is dropped.
  function reset() {
    generation++;
    sending = false;
    turns.length = 0;
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
    $(id("keys")).textContent = isMac ? "↩ で改行、⌘↩ で送信" : "Enter で改行、Ctrl+Enter で送信";
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

  return { init, draw, refresh, send, reset, clearInput };
}
