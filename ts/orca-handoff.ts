// Handing the open mail, Slack thread or Todo to Orca (A-9): a pane on the right of the screen that shows, and the user decides.
// Before a hand-over it has the destination (the Orca to talk to, the project, and the worktree of a new session: the project's own folder, or a new one made then), the card with the content (taken off with ×) and a conversation with Claude:
// the instruction is summarised into "what to implement" (`claude_summarize_handoff`), the owner fixes the summary in the field below, and nothing goes to Orca until "この内容で Orca に渡す" is pressed. Once there is a summary the three choices fold into one chip.
// After a hand-over it shows that session: its header, its history (orca-chat.ts) and a composer for more instructions. The prompt is composed in Rust (`orca_handoff`).
// A pane belongs to one screen (the host): the mail thread, the Slack thread's Orca tab or the Todo detail. What is kept is in memory only: the conversation of each item and the session it was handed to, and the destination and the project last chosen.
import type { AttachedFile } from "./bindings/AttachedFile";
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaRow } from "./bindings/OrcaRow";
import { getClaude, showPurposeSlot } from "./claude.js";
import type { ChatTurnPayload } from "./claude-chat.js";
import { composing, isMac, tag } from "./dom.js";
import { CLOSE_SVG, MAIL_SVG, OPEN_SVG, ORCA_SVG, SLACK_SVG, TODO_SVG } from "./icons.js";
import { type HandoffDestination, invoke } from "./ipc.js";
import { closeChat, isChatOwner, makeChatView, openChat, setChatWorking, type ChatView } from "./orca-chat.js";
import { type Attachment, drawStrip, listenForFiles, readFiles, uploadAttachments } from "./orca-attach.js";
import type { HandoffCard } from "./orca-handoff-cards.js";
import { openMenu } from "./menu.js";
import { elapsed, heldOrca, noticeOf, openInOrca, readDestination, refreshOrca, STATUS_LABELS, THIS_MACHINE, worktreeLabel } from "./orca.js";

// The item a pane is for: a key that is the same while the same mail, thread or task is shown, and the content to hand over, built when the pane is opened.
export interface HandoffItem {
  key: string;
  card: () => HandoffCard | null;
}

export interface HandoffHost {
  // The pane's element, which the pane fills.
  root: HTMLElement;
  // The item in view now, null when the host's screen does not show one (or, for the Slack thread, when the Orca tab is not the one shown).
  current: () => HandoffItem | null;
  // True when the pane is shown whenever the item is in view (the Slack tab): it has no title row before a send, and its close button only forgets the session.
  forced?: boolean;
  // The pane opens or closes: the host shows or hides it and presses its button.
  onOpen: (open: boolean) => void;
}

// The session an item was handed to: where it runs, how its history is found and which terminal takes the next send. `environment` is the target at the time.
interface Session {
  path: string;
  paneKey: string | null;
  handle: string | null;
  environment: string | null;
  // Its row has been in the list of Orca: a ready list that lacks it later means the session ended.
  seen: boolean;
}

// The conversation about handing an item over, and the choices of its worktree: by item key, so that they belong to the item while another is in view.
interface Form {
  // True when the worktree of a new session is to be made (the chip says 新規作成); false for the project's own folder. `name` is the field for it, and `named` says the owner wrote it (a later proposal of Claude does not replace it).
  fresh: boolean;
  name: string;
  named: boolean;
  // What the first summary was made from, the turns since (a summary is an assistant turn with its points, a request to fix it a user turn; the first user turn is `instruction`), and the summary now in force.
  instruction: string;
  turns: Turn[];
  points: string[] | null;
  // True when the owner opened the choices again after a summary (they are folded into one chip until the next summary).
  open: boolean;
}
interface Turn extends ChatTurnPayload {
  points?: string[];
}
const forms = new Map<string, Form>();
// The turns Claude is sent are the last this many (the same as Rust's CHAT_TURNS).
const SENT_TURNS = 20;

function formOf(key: string) {
  let form = forms.get(key);
  if (!form) {
    form = { fresh: false, name: "", named: false, instruction: "", turns: [], points: null, open: false };
    forms.set(key, form);
  }
  return form;
}

// A form that holds nothing the owner made (no request to Claude, no choice of the worktree): it is the default one, so it is not kept.
function dropIdleForm(key: string) {
  const form = forms.get(key);
  if (form && !form.fresh && form.name === "" && !form.named && form.instruction === "" && form.turns.length === 0 && form.points === null && !form.open) forms.delete(key);
}

// By item key, in memory only: leaving and coming back to the item shows its session again.
const sessions = new Map<string, Session>();
// The instruction of an item whose send failed while another item was in view: it is put back in the field of its own item.
const drafts = new Map<string, string>();
// The files attached to the instruction of an item (A-10), by item key: they stay with the item while another is in view, and go with the send.
const attached = new Map<string, Attachment[]>();
// The project chosen for a new session (`OrcaProject.key`), kept for the next handoff.
let chosenProject: string | null = null;
// The worktree a send of an item made and did not finish with (the files or the launch failed after it): a send again with the same project, name and destination uses it instead of making another.
const made = new Map<string, { project: string; name: string; environment: string | null; path: string }>();
// The Orca the panes talk to (a saved environment's name, null for this machine), kept for the next handoff. Undefined until one is chosen: the panes then follow the target of the Orca screen, which a choice here never changes.
let chosenDest: string | null | undefined;
const panes = new Set<HandoffPane>();
let ticking = false;
// While a session is shown, the list is read again this often (for its header).
const POLL_MS = 10_000;
const NEW_WORKTREE = "新規作成";
const KIND_ICONS = { mail: MAIL_SVG, slack: SLACK_SVG, todo: TODO_SVG } as const;

// The text of a send: the instruction, then the path of each file on a line of its own after a blank line; only the paths when the instruction is blank.
const withFiles = (text: string, files: AttachedFile[]) => {
  const paths = files.map((f) => f.text.trimEnd());
  return (text.trim() ? [text.trimEnd(), "", ...paths] : paths).join("\n");
};

function iconButton(label: string, svg: string, className = "icon-btn") {
  const button = tag("button", className);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.innerHTML = svg;
  return button;
}

export class HandoffPane {
  private host: HandoffHost;
  private itemKey: string | null = null;
  private item: HandoffItem | null = null;
  private open = false;
  // What the drawn pane is for ("form" or "session", and the item); the pane is built again when this changes.
  private drawn = "";
  // What each part of the drawn pane shows, so that a part is drawn again only when it changed.
  private keys: Record<string, string> = {};
  private card: HandoffCard | null = null;
  private removed = false;
  // The keys of the items whose hand-over (or follow-up) is on its way, and those whose summary is; and the message of the last failed post or summary of each item. They belong to the item, so a switch of the item loses none.
  private sending = new Set<string>();
  private asking = new Set<string>();
  private errors = new Map<string, string>();
  // What the host was last told, and the minute the pane last drew.
  private lastOpen: boolean | null = null;
  private lastMinute = 0;
  // The card the drawn pane shows (compared by identity).
  private cardDrawn: HandoffCard | null | undefined;
  private overview: OrcaOverview | null = null;
  private readSeq = 0;
  // The `readSeq` of the read of a destination's own lists that is on its way, else 0: the poll of a shown session does not start another while it is.
  private destReading = 0;
  private lastRead = 0;
  private chat: ChatView;
  private chatKey: string | null = null;
  private el: {
    notice: HTMLElement;
    chip?: HTMLButtonElement;
    line?: HTMLButtonElement;
    talk?: HTMLElement;
    agree?: HTMLButtonElement;
    claudeNote?: HTMLElement;
    cardBox?: HTMLElement;
    strip: HTMLElement;
    card?: { title: HTMLElement; meta: HTMLElement };
    destChip?: HTMLButtonElement;
    projectChip?: HTMLButtonElement;
    name?: HTMLInputElement;
    sessionTitle?: HTMLElement;
    note?: HTMLElement;
    error: HTMLElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
  } | null = null;

  constructor(host: HandoffHost) {
    this.host = host;
    this.chat = makeChatView(tag("div", "ho-chat"), tag("div", "ho-items"), tag("button", "text-btn ho-older", "以前の履歴を読む"), tag("div", "ho-chat-status"), () => this.answerTarget());
    this.chat.older.hidden = true;
    this.chat.box.append(this.chat.older, this.chat.list);
    listenForFiles(host.root, (files) => this.addFiles(files));
    panes.add(this);
    if (!ticking) {
      ticking = true;
      window.setInterval(() => {
        for (const pane of panes) pane.tick();
      }, 1000);
    }
  }

  private mode() {
    return this.itemKey !== null && sessions.has(this.itemKey) ? "session" : "form";
  }

  private session() {
    return this.itemKey === null ? undefined : sessions.get(this.itemKey);
  }

  private rowOf(s: Session): OrcaRow | undefined {
    return this.overview?.rows.find((r) => (s.paneKey !== null && r.paneKey === s.paneKey) || (s.handle !== null && r.handle === s.handle));
  }

  // The terminal an answer to a question of the history goes to (A-11): that of the session shown, resolved as the next send is.
  private answerTarget() {
    const s = this.session();
    const handle = s ? (s.handle ?? this.rowOf(s)?.handle ?? null) : null;
    return s && handle !== null ? { handle, environment: s.environment } : null;
  }

  // The pane follows the host: another item (or none) in view changes what it shows, and a session already handed to the item is shown again.
  sync() {
    const item = this.host.current();
    const key = item?.key ?? null;
    if (key !== this.itemKey) {
      // A form whose summary is on its way is kept: the answer is written into it.
      if (this.itemKey !== null && !this.asking.has(this.itemKey)) dropIdleForm(this.itemKey);
      this.itemKey = key;
      this.removed = false;
      // The card is built when the pane opens (the form is drawn), not for each item that goes by.
      this.card = null;
      this.open = key !== null && (this.host.forced === true || sessions.has(key));
      this.overview = this.screenOverview();
      this.lastRead = 0;
    }
    this.item = item;
    this.draw();
    if (this.lastOpen !== this.open) {
      this.lastOpen = this.open;
      this.host.onOpen(this.open);
    }
    this.syncChat();
    if (this.open && this.lastRead === 0) this.reload(true);
  }

  private get busy() {
    return this.itemKey !== null && (this.sending.has(this.itemKey) || this.asking.has(this.itemKey));
  }

  private form() {
    return formOf(this.itemKey!);
  }

  // The header button: opens the pane for the item in view, or closes it.
  toggle() {
    this.sync();
    if (this.itemKey === null) return;
    this.open = !this.open;
    this.lastRead = 0;
    this.sync();
  }

  // The content of the item changed (a thread was read, a task was edited): the card shows the new one until it is sent or taken off.
  refreshCard() {
    if (!this.open || this.itemKey === null || this.mode() !== "form" || this.removed || !this.item) return;
    this.card = this.item.card();
    this.drawCard();
  }

  private tick() {
    // Nothing moves in a window that is hidden.
    if (document.hidden) return;
    this.sync();
    // Claude can become usable (or not) while the pane is shown.
    this.updateSend();
    // The times on the pane are in minutes: it is drawn again when the minute changes (a read draws it too).
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.lastMinute) {
      this.lastMinute = minute;
      this.update();
    }
    // A shown session is read again every POLL_MS, unless the command is missing.
    if (this.open && this.mode() === "session" && this.overview?.state !== "missing" && Date.now() - this.lastRead >= POLL_MS) this.reload(false);
  }

  // The Orca the pane talks to: that of the session shown, else the one chosen, else the target of the Orca screen.
  private destination() {
    const s = this.session();
    if (s) return s.environment;
    return chosenDest !== undefined ? chosenDest : (this.overview?.target ?? heldOrca()?.target ?? null);
  }

  // The list the Orca screen holds, when the destination is its target (or none was chosen); else null, and the destination's own read is awaited.
  private screenOverview() {
    const held = heldOrca();
    const want = this.session()?.environment ?? chosenDest;
    return want === undefined || held?.target === want ? held : null;
  }

  // The saved environments the destination can be changed to.
  private environments() {
    return this.overview?.environments.length ? this.overview.environments : (heldOrca()?.environments ?? []);
  }

  // Reads the list of Orca: forced when the pane opens and after a send, and not while another read is on its way when it is the poll of a shown session.
  private async reload(force: boolean) {
    if (!force && this.destReading !== 0) return;
    const seq = ++this.readSeq;
    this.lastRead = Date.now();
    const overview = await this.read(force);
    if (seq !== this.readSeq || !this.open) return;
    this.overview = overview;
    this.update();
    this.syncChat();
  }

  // The list of the screen when the destination is its target (also a stream, A-12), else a read of the destination alone.
  private async read(force: boolean) {
    const want = this.session()?.environment ?? chosenDest;
    if (want === undefined || heldOrca()?.target === want) {
      const screen = await refreshOrca(force);
      if (want === undefined || screen?.target === want) return screen;
    }
    const seq = this.readSeq;
    this.destReading = seq;
    try {
      return await readDestination(want ?? null, force);
    } finally {
      if (this.destReading === seq) this.destReading = 0;
    }
  }

  // The destination is chosen: the project of the old one is dropped, and the lists of the new one are read.
  private chooseDestination(name: string | null) {
    if (name === this.destination()) return;
    chosenDest = name;
    chosenProject = null;
    this.overview = null;
    this.update();
    this.reload(true);
  }

  // The read of the history belongs to this pane only while it shows a session in view; otherwise it is let go (a read that another owner took is not touched).
  private syncChat() {
    const s = this.open ? this.session() : undefined;
    const paneKey = s ? this.paneKeyOf(s) : null;
    if (!s || paneKey === null) {
      this.chatKey = null;
      closeChat(this.chat);
      return;
    }
    const want = JSON.stringify([s.environment, s.path, paneKey]);
    if (this.chatKey === want && isChatOwner(this.chat)) return;
    this.chatKey = want;
    openChat(this.chat, s.environment, s.path, paneKey, this.rowOf(s)?.group === "working");
  }

  // The pane of the session: the one the launch named, else the one of its row in the list.
  private paneKeyOf(s: Session) {
    return s.paneKey ?? this.rowOf(s)?.paneKey ?? null;
  }

  // ---- drawing ----

  private draw() {
    if (!this.open || this.itemKey === null) {
      if (this.drawn) this.host.root.replaceChildren();
      this.drawn = "";
      this.el = null;
      return;
    }
    const signature = `${this.mode()}/${this.itemKey}`;
    if (signature !== this.drawn) {
      this.drawn = signature;
      this.keys = {};
      this.cardDrawn = undefined;
      if (this.mode() === "form") this.buildForm();
      else this.buildSession();
      this.update();
    }
  }

  // Draws a part again only when what it shows changed.
  private part(name: string, key: unknown, draw: () => void) {
    const text = JSON.stringify(key);
    if (this.keys[name] === text) return;
    this.keys[name] = text;
    draw();
  }

  // The composer at the foot of the pane, for both modes.
  private foot() {
    const form = tag("form", "ho-form");
    const error = tag("p", "pending fail");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const cardBox = tag("div", "ho-card-box");
    const strip = tag("div", "attachments");
    strip.hidden = true;
    const box = tag("div", "composer");
    const input = tag("textarea", "chat-input");
    input.rows = 3;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Orca への指示");
    const send = tag("button", "text-btn primary");
    send.type = "submit";
    input.oninput = () => this.updateSend();
    form.onsubmit = (e) => {
      e.preventDefault();
      this.submit();
    };
    box.append(input, send);
    form.append(error, cardBox, strip, box);
    const foot = tag("div", "ho-foot");
    foot.append(form);
    return { foot, form, error, cardBox, strip, input, send };
  }

  private buildForm() {
    const close = iconButton("閉じる", CLOSE_SVG);
    close.onclick = () => {
      this.open = false;
      this.sync();
    };
    const head = tag("div", "ho-head");
    head.append(orcaIcon(), tag("span", "ho-title", "Orca に渡す"), close);
    // The tabs of the Slack thread name the pane, and the thread has nothing to close.
    head.hidden = this.host.forced === true;
    const notice = tag("div", "ho-notice");
    const fresh = tag("div", "ho-new");
    const destChip = tag("button", "review-chip ho-chip ho-destination");
    destChip.type = "button";
    destChip.setAttribute("aria-label", "送り先");
    destChip.setAttribute("aria-haspopup", "menu");
    destChip.onclick = () =>
      openMenu(
        destChip,
        [null, ...this.environments()].map((name) => ({ label: name ?? THIS_MACHINE, color: "var(--accent)", current: name === this.destination(), pick: () => this.chooseDestination(name) })),
      );
    const projectChip = tag("button", "review-chip ho-chip ho-project");
    projectChip.type = "button";
    projectChip.setAttribute("aria-label", "プロジェクト");
    projectChip.setAttribute("aria-haspopup", "menu");
    projectChip.onclick = () =>
      openMenu(
        projectChip,
        (this.overview?.projects ?? []).map((p) => ({
          label: p.name,
          color: "var(--accent)",
          current: p.key === chosenProject,
          pick: () => {
            chosenProject = p.key;
            this.update();
            this.el?.input.focus();
          },
        })),
      );
    const chip = tag("button", "review-chip ho-chip ho-worktree");
    chip.type = "button";
    chip.setAttribute("aria-label", "worktree");
    chip.setAttribute("aria-haspopup", "menu");
    chip.onclick = () =>
      openMenu(
        chip,
        [false, true].map((isNew) => ({
          label: isNew ? NEW_WORKTREE : this.defaultLabel(),
          color: "var(--accent)",
          current: isNew === this.form().fresh,
          pick: () => {
            this.form().fresh = isNew;
            this.update();
            (isNew ? this.el?.name : this.el?.input)?.focus();
          },
        })),
      );
    // The name of the worktree to make; Rust checks it. The proposal of Claude is put in it with the summary, unless the owner wrote one (A-9).
    const name = tag("input", "ho-name");
    name.setAttribute("aria-label", "worktree の名前");
    name.autocomplete = "off";
    name.spellcheck = false;
    name.oninput = () => {
      const form = this.form();
      form.name = name.value;
      form.named = name.value.trim() !== "";
      this.updateSend();
    };
    name.hidden = true;
    // After a summary the three choices are this one chip; pressing it opens them again.
    const line = tag("button", "review-chip ho-chip ho-line");
    line.type = "button";
    line.setAttribute("aria-label", "送り先、プロジェクト、worktree");
    line.hidden = true;
    line.onclick = () => {
      this.form().open = true;
      this.update();
    };
    fresh.append(line, destChip, projectChip, chip, name);
    const scroll = tag("div", "ho-scroll");
    const talk = tag("div", "ho-talk");
    scroll.append(notice, fresh, talk);
    const main = tag("div", "ho-main");
    main.append(head, scroll);
    const foot = this.foot();
    // Under the field, the model and effort of the summary, and the note while Claude cannot be used (as the Slack thread's conversation).
    const model = tag("div", "chat-model");
    const claudeNote = tag("p", "chat-note", "設定の Claude タブで接続すると、Claude に要約してもらえます");
    foot.form.prepend(claudeNote);
    // Enter is a line break; Cmd+Enter (Ctrl+Enter off macOS) sends, unless it only confirms an IME conversion (as the other Claude conversations).
    foot.input.onkeydown = (e) => {
      if (e.key !== "Enter" || composing(e) || !(isMac ? e.metaKey : e.ctrlKey)) return;
      e.preventDefault();
      this.submit();
    };
    foot.form.append(model);
    this.el = { notice, chip, line, talk, claudeNote, destChip, projectChip, name, cardBox: foot.cardBox, strip: foot.strip, error: foot.error, input: foot.input, send: foot.send };
    // The content is taken when the form is drawn, that is when the pane opens.
    this.card = this.item?.card() ?? null;
    this.restoreDraft(foot.input);
    this.host.root.replaceChildren(main, foot.foot);
    showPurposeSlot(model, "orcaHandoff");
  }

  private buildSession() {
    const sessionTitle = tag("div", "ho-session-title");
    const open = iconButton("Orca の画面で開く", OPEN_SVG);
    open.onclick = () => openInOrca(this.session() ? this.paneKeyOf(this.session()!) : null);
    const close = iconButton("閉じる", CLOSE_SVG);
    close.onclick = () => this.forget();
    const head = tag("div", "ho-head ho-session-head");
    head.append(sessionTitle, open, close);
    const notice = tag("div", "ho-notice");
    const note = tag("p", "ho-note", "セッションを始めました。履歴は Orca の画面で見られます。");
    const main = tag("div", "ho-main");
    main.append(head, notice, this.chat.status, this.chat.box, note);
    const foot = this.foot();
    foot.cardBox.hidden = true;
    foot.input.rows = 2;
    this.el = { notice, sessionTitle, note, strip: foot.strip, error: foot.error, input: foot.input, send: foot.send };
    this.restoreDraft(foot.input);
    this.host.root.replaceChildren(main, foot.foot);
    foot.input.focus();
  }

  // The text of a failed request or post goes back to its item: to the field when the item is in view and the field is empty (it was built again if the owner left and came back), else it waits for its own item.
  private keepText(key: string, text: string) {
    if (this.itemKey !== key) drafts.set(key, text);
    else if (this.el && !this.el.input.value) this.el.input.value = text;
  }

  // Puts back the instruction of this item whose send failed while another item was in view.
  private restoreDraft(input: HTMLTextAreaElement) {
    const draft = this.itemKey === null ? undefined : drafts.get(this.itemKey);
    if (draft === undefined) return;
    input.value = draft;
    drafts.delete(this.itemKey!);
  }

  private update() {
    if (!this.el) return;
    this.part("notice", [this.overview?.state, this.overview?.message], () => this.drawNotice());
    if (this.mode() === "form") {
      const form = this.form();
      this.part("dest", [chosenProject, form.fresh, form.name, form.points !== null, form.open, this.destination(), this.environments(), this.overview?.projects, this.overview?.worktrees], () => this.drawDest());
      this.part("talk", [form.turns, this.itemKey !== null && this.asking.has(this.itemKey)], () => this.drawTalk());
      this.drawCard();
    } else {
      const s = this.session()!;
      const row = this.rowOf(s);
      if (row) s.seen = true;
      this.part("session", [s, row, this.overview?.state, this.overview?.worktrees, Math.floor(Date.now() / 60_000)], () => this.drawSessionHead());
    }
    const key = this.itemKey;
    const files = key === null ? [] : (attached.get(key) ?? []);
    this.part("attachments", files.map((a) => a.id), () =>
      drawStrip(this.el!.strip, files, (a) => {
        if (key === null || this.busy) return;
        attached.set(key, files.filter((x) => x !== a));
        this.update();
      }),
    );
    this.updateSend();
  }

  // Takes the files pasted or dropped on the pane for the item in view (A-10); a file that cannot be read is refused with the message of a failed send.
  private async addFiles(files: File[]) {
    const key = this.itemKey;
    if (!this.el || key === null || this.busy) return;
    const read = await readFiles(files);
    if (read.message === null) this.errors.delete(key);
    else this.errors.set(key, read.message);
    attached.set(key, [...(attached.get(key) ?? []), ...read.files]);
    this.update();
  }

  private drawNotice() {
    const text = noticeOf(this.overview);
    const row = tag("div", this.overview?.state === "failed" ? "pending fail" : "pending");
    row.append(tag("span", "sp", text ?? ""));
    this.el!.notice.replaceChildren(...(text ? [row] : []));
  }

  // The project's own folder (its main worktree) in the list, which a send without 新規作成 starts in.
  private defaultWorktree() {
    return chosenProject === null ? undefined : this.overview?.worktrees.find((w) => w.projectKey === chosenProject && w.isMain);
  }

  // The label of the project's own folder: "default", and the branch checked out there now.
  private defaultLabel() {
    const main = this.defaultWorktree();
    return main ? `default ・ ${main.branch}` : "default";
  }

  // True when a new session can start with what is chosen: a project, and its own folder or a worktree to make.
  private target(form: Form) {
    return chosenProject !== null && (form.fresh || this.defaultWorktree() !== undefined);
  }

  // The chips with the destination (this machine, or the saved environment), the project and the worktree chosen, and the name of a new worktree; or, once there is a summary and the choices are complete, the one chip that holds them.
  private drawDest() {
    const { chip, destChip, projectChip, name, line } = this.el!;
    const form = this.form();
    const destination = this.destination();
    destChip!.textContent = destination ?? THIS_MACHINE;
    // With no saved environment there is nothing to choose, unless the destination is one that is gone.
    destChip!.disabled = destination === null && this.environments().length === 0;
    const projects = this.overview?.projects ?? [];
    // While the lists of a new destination are on their way (no overview) nothing is dropped.
    if (this.overview !== null && chosenProject !== null && !projects.some((p) => p.key === chosenProject)) chosenProject = null;
    const chosen = projects.find((p) => p.key === chosenProject);
    projectChip!.textContent = chosen ? chosen.name : projects.length ? "プロジェクトを選ぶ" : "プロジェクトがありません";
    projectChip!.disabled = projects.length === 0;
    chip!.textContent = form.fresh ? NEW_WORKTREE : this.defaultLabel();
    chip!.disabled = chosen === undefined;
    if (name!.value !== form.name) name!.value = form.name;
    // The choices stay open while they are not complete, until the next summary: a project chosen then does not fold them before the worktree is chosen.
    if (form.points !== null && !this.target(form)) form.open = true;
    const folded = form.points !== null && !form.open;
    const worktree = form.fresh ? [NEW_WORKTREE, form.name.trim()].filter(Boolean).join(" ・ ") : this.defaultLabel();
    line!.textContent = [destChip!.textContent, chosen?.name, worktree].filter(Boolean).join(" ・ ");
    line!.hidden = !folded;
    for (const node of [destChip!, projectChip!, chip!]) node.hidden = folded;
    name!.hidden = !form.fresh || folded;
  }

  // The conversation: what the owner asked and Claude's summaries (the latest with the button that hands it over), and the line that Claude is thinking.
  private drawTalk() {
    const el = this.el!;
    const form = this.form();
    el.agree = undefined;
    const nodes = form.turns.map((turn, i) => {
      if (turn.role === "user") return tag("div", "chat-user", turn.text);
      const node = tag("div", "chat-ai");
      const list = tag("ul", "ho-points");
      list.append(...(turn.points ?? []).map((point) => tag("li", "", point)));
      node.append(list);
      if (i === form.turns.length - 1) {
        const agree = tag("button", "text-btn primary ho-agree", "この内容で Orca に渡す");
        agree.type = "button";
        agree.onclick = () => this.handOver();
        node.append(agree);
        el.agree = agree;
      }
      return node;
    });
    if (this.itemKey !== null && this.asking.has(this.itemKey)) {
      const thinking = tag("div", "pending");
      thinking.append(tag("span", "spin"), tag("span", "sp", "Claude が考えています…"));
      nodes.push(thinking);
    }
    el.talk!.replaceChildren(...nodes);
    const scroll = el.talk!.parentElement!;
    scroll.scrollTop = scroll.scrollHeight;
  }

  // The card with the content to hand over, until it is taken off. The nodes are kept while the card changes: only their text is set.
  private drawCard() {
    const card = this.removed ? null : this.card;
    if (!this.el || this.cardDrawn === card) return;
    this.cardDrawn = card;
    {
      const el = this.el;
      const box = el?.cardBox;
      if (!el || !box) return;
      if (!card) {
        el.card = undefined;
        return box.replaceChildren();
      }
      if (!el.card) {
        const node = tag("div", "ho-card");
        const row = tag("div", "ho-card-row");
        const icon = tag("span", "ho-card-icon");
        icon.innerHTML = KIND_ICONS[card.kind];
        const title = tag("span", "ho-card-title");
        const meta = tag("span", "ho-card-meta");
        const text = tag("span", "ho-card-text");
        text.append(title, meta);
        const off = iconButton("渡す内容を外す", CLOSE_SVG);
        off.onclick = () => {
          this.removed = true;
          this.drawCard();
          this.el?.input.focus();
        };
        row.append(icon, text, off);
        node.append(row);
        box.replaceChildren(node);
        el.card = { title, meta };
      }
      const ui = el.card;
      if (ui.title.textContent !== card.title) ui.title.textContent = card.title;
      if (ui.meta.textContent !== card.meta) ui.meta.textContent = card.meta;
    }
  }

  // The header of a session: "{repo} ・ {branch}", and its state with the time. Until the list holds the session (a new one) it says it is being checked.
  private drawSessionHead() {
    const s = this.session();
    const el = this.el;
    if (!s || !el?.sessionTitle) return;
    const row = this.rowOf(s);
    const worktree = this.overview?.worktrees.find((w) => w.path === s.path);
    const name = row ? `${row.repo} ・ ${row.branch}` : worktree ? worktreeLabel(worktree) : s.path;
    const time = row ? elapsed(row.atMs, Date.now(), row.group === "done") : "";
    // Until its row is in the list a new session is being checked; once it was there and a ready list lacks it, it has ended.
    const state = row ? [STATUS_LABELS[row.status], time].filter(Boolean).join(" ・ ") : s.seen && this.overview?.state === "ready" ? "終了" : "確認中";
    el.sessionTitle!.replaceChildren(tag("span", "ho-session-name", name), tag("span", "ho-session-state", state));
    el.note!.hidden = this.paneKeyOf(s) !== null;
    this.chat.box.hidden = this.paneKeyOf(s) === null;
    setChatWorking(this.chat, row?.group === "working");
  }

  private claudeReady() {
    return getClaude()?.state === "ready";
  }

  private updateSend() {
    const el = this.el;
    if (!el) return;
    const s = this.session();
    const set = (node: HTMLElement, text: string) => {
      if (node.textContent !== text) node.textContent = text;
    };
    const hasFiles = this.itemKey !== null && (attached.get(this.itemKey)?.length ?? 0) > 0;
    if (s) {
      set(el.send, "送る");
      el.input.disabled = this.busy;
      // A session with no terminal can be read but takes no post.
      const target = (s.handle ?? this.rowOf(s)?.handle ?? null) !== null;
      el.send.disabled = this.busy || this.overview?.state === "missing" || !(el.input.value.trim() || hasFiles) || !target;
    } else {
      // Before a hand-over the field is the conversation with Claude: the instruction, then the requests to fix the summary.
      const form = this.form();
      const ready = this.claudeReady();
      set(el.send, form.points === null ? "要約する" : "直す");
      el.input.setAttribute("aria-label", form.points === null ? "Orca への指示" : "要約の直し");
      el.input.disabled = this.busy || !ready;
      el.send.disabled = this.busy || !ready || !el.input.value.trim();
      el.claudeNote!.hidden = ready;
      // Nothing goes to Orca without a summary, a project, and its own folder or a worktree to make.
      if (el.agree) el.agree.disabled = this.busy || this.overview?.state === "missing" || !this.target(form);
    }
    const error = this.itemKey === null ? "" : (this.errors.get(this.itemKey) ?? "");
    el.error.hidden = !error;
    el.error.textContent = error;
  }

  // ---- acting ----

  // Forgets the session handed to the item: the next open shows the send form.
  private forget() {
    if (this.itemKey === null) return;
    sessions.delete(this.itemKey);
    this.errors.delete(this.itemKey);
    this.removed = false;
    // The form is drawn again, and takes the content then.
    this.card = null;
    this.open = this.host.forced === true;
    this.lastRead = 0;
    this.sync();
  }

  // Makes the worktree of a new session with `orca_worktree_create` and gives its path (Rust checks the name). One that an earlier send of the item made with the same project, name and destination is used again, so a retry after a later failure makes none twice.
  private async makeWorktree(key: string, project: string, name: string, environment: string | null) {
    const earlier = made.get(key);
    if (earlier && earlier.project === project && earlier.name === name && earlier.environment === environment) return earlier.path;
    const path = await invoke("orca_worktree_create", { project, name, environment });
    made.set(key, { project, name, environment, path });
    return path;
  }

  // The press of the button in the field: a request to Claude before a hand-over, a post to the session after it.
  private submit() {
    if (this.session()) this.sendMore();
    else this.ask();
  }

  // Asks Claude for the summary of the instruction, or, when there is one, for a fix of it with the request in the field. The answer belongs to the item: it is kept for it while another is in view, and so is a failure (the text then waits for its own item).
  private async ask() {
    const el = this.el;
    const key = this.itemKey;
    if (!el || key === null || this.busy || !this.claudeReady()) return;
    const text = el.input.value.trim();
    if (!text) return;
    const form = this.form();
    const fix = form.points !== null;
    const card = this.removed ? null : this.card;
    const context = card ? { kind: card.kind, title: card.title, body: card.body } : null;
    const history = fix
      ? form.turns
          .slice(1)
          .slice(-SENT_TURNS)
          .map(({ role, text }) => ({ role, text }))
      : [];
    this.asking.add(key);
    this.errors.delete(key);
    this.update();
    try {
      const summary = await invoke("claude_summarize_handoff", { instruction: fix ? form.instruction : text, context, history, revision: fix ? text : null });
      if (!fix) form.instruction = text;
      form.turns.push({ role: "user", text }, { role: "assistant", text: summary.points.map((point) => `- ${point}`).join("\n"), points: summary.points });
      form.points = summary.points;
      form.open = !this.target(form);
      // The proposed name is put in the field unless the owner wrote one.
      if (summary.worktreeName !== null && !form.named) form.name = summary.worktreeName;
      if (this.itemKey === key && this.el) this.el.input.value = "";
    } catch (e) {
      this.errors.set(key, String(e));
      this.keepText(key, text);
    } finally {
      this.asking.delete(key);
    }
    if (this.itemKey === key) {
      this.sync();
      this.update();
      this.el?.input.focus();
    }
  }

  // Hands the summary agreed to over: the worktree is made first when 新規作成 is chosen (a failure ends it before anything starts), the files go into the worktree of the session, and the session starts once with the summary, the paths of the files and the content.
  private async handOver() {
    const key = this.itemKey;
    if (this.el === null || key === null || this.busy || this.session()) return;
    const form = this.form();
    const points = form.points;
    const environment = this.destination();
    const project = chosenProject;
    const own = this.defaultWorktree()?.path ?? null;
    if (points === null || project === null || (!form.fresh && own === null)) return;
    const files = attached.get(key) ?? [];
    const card = this.removed ? null : this.card;
    this.sending.add(key);
    this.errors.delete(key);
    this.update();
    try {
      const worktree = form.fresh ? await this.makeWorktree(key, project, form.name, environment) : own!;
      const uploaded = files.length ? await uploadAttachments(files, worktree, environment) : [];
      const context = card ? { kind: card.kind, title: card.title, body: card.body } : null;
      const destination: HandoffDestination = { kind: "new", path: worktree };
      const started = await invoke("orca_handoff", { destination, points, files: uploaded.map((f) => f.text), context, environment });
      sessions.set(key, { path: worktree, paneKey: started.paneKey, handle: started.handle, environment, seen: false });
      made.delete(key);
      forms.delete(key);
      // Only the files sent: one added while the hand-over ran (still being read when it began) stays.
      const left = (attached.get(key) ?? []).filter((a) => !files.includes(a));
      if (left.length) attached.set(key, left);
      else attached.delete(key);
      this.lastRead = 0;
    } catch (e) {
      this.errors.set(key, String(e));
    } finally {
      this.sending.delete(key);
    }
    if (this.itemKey === key) {
      this.sync();
      this.update();
      this.el?.input.focus();
    }
  }

  // A post to the session shown: more instructions, with the files attached to the field. It is never tried again, and a failure keeps the text.
  private async sendMore() {
    const el = this.el;
    const key = this.itemKey;
    const known = this.session();
    if (!el || key === null || !known || this.busy) return;
    const text = el.input.value;
    const files = attached.get(key) ?? [];
    if (!text.trim() && !files.length) return;
    const handle = known.handle ?? this.rowOf(known)?.handle ?? null;
    if (handle === null) return;
    this.sending.add(key);
    this.errors.delete(key);
    this.updateSend();
    try {
      const body = files.length ? withFiles(text, await uploadAttachments(files, known.path, known.environment)) : text;
      await invoke("orca_send", { handle, text: body, environment: known.environment });
      el.input.value = "";
      const left = (attached.get(key) ?? []).filter((a) => !files.includes(a));
      if (left.length) attached.set(key, left);
      else attached.delete(key);
      this.lastRead = 0;
    } catch (e) {
      this.errors.set(key, String(e));
      this.keepText(key, text);
    } finally {
      this.sending.delete(key);
    }
    if (this.itemKey === key) {
      this.sync();
      this.update();
      this.el?.input.focus();
    }
  }
}

// The Orca icon, a node each time.
function orcaIcon() {
  const icon = tag("span", "ho-icon");
  icon.innerHTML = ORCA_SVG;
  return icon;
}
