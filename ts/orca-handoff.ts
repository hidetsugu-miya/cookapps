// Handing the open mail, Slack thread or Todo to Orca (A-9): a pane on the right of the screen that shows, and the user decides.
// Before a hand-over it is a form from the top down: the destination (the Orca to talk to, the project, and the worktree of a new session: one of the project's worktrees, its own folder first, or a new one made then, with its name, the ref it starts from and its branch), the card with the content (taken off with ×) and the field for the instruction, which fills the height that is left and has the arrow button "Orca に渡す" at its bottom right.
// The instruction is handed over as it was written; the content of the card is summarised by Claude (`claude_summarize_handoff`) when the arrow is pressed, and the summary goes with the instruction.
// After a hand-over it shows that session: its header and its terminal (A-12, orca-terminal.ts), which takes the keys as the terminal of the Orca screen does, until the pane is closed. The prompt is composed in Rust (`orca_handoff`).
// A pane belongs to one screen (the host): the mail thread, the Slack thread's Orca tab or the Todo detail. What is kept is in memory only: the conversation of each item and the session it was handed to, and the destination and the project last chosen.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaRow } from "./bindings/OrcaRow";
import type { OrcaWorktree } from "./bindings/OrcaWorktree";
import { getClaude } from "./claude.js";
import { composing, isMac, tag } from "./dom.js";
import { ARROW_UP_SVG, CLOSE_SVG, MAIL_SVG, OPEN_SVG, ORCA_SVG, SLACK_SVG, TODO_SVG } from "./icons.js";
import { type HandoffDestination, invoke } from "./ipc.js";
import { type Attachment, drawStrip, listenForFiles, readFiles, uploadAttachments } from "./orca-attach.js";
import type { HandoffCard } from "./orca-handoff-cards.js";
import { openBranchList, type BranchSource, type PickedBranch } from "./orca-branch.js";
import { openMenu } from "./menu.js";
import { hideTerminals, showTerminals, type TermSource } from "./orca-terminal.js";
import { elapsed, heldOrca, noticeOf, openInOrca, readDestination, refreshOrca, STATUS_LABELS, streamsEnvironment, THIS_MACHINE, worktreeLabel } from "./orca.js";

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
  // True when the pane has no way of its own to be closed (the Todo screen's right pane, which its icons choose): it has no close button before a send, and the close button of a session only forgets it.
  stays?: boolean;
  // The pane opens or closes: the host shows or hides it and presses its button.
  onOpen: (open: boolean) => void;
}

// The session an item was handed to: where it runs and which terminal it shows. `environment` is the target at the time.
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
  // True when the worktree of a new session is to be made (the chip says 新規作成); false for the project's own folder. `name` is the field for it.
  fresh: boolean;
  name: string;
  // The project the choices below were made for (a choice of another project does not carry over), and the existing worktree chosen (its path; null: the project's own folder).
  project: string | null;
  worktree: string | null;
  // For a worktree to make: the ref it starts from (null: Orca's default), and the branch it gets: a new one, named in `branch` (blank: Orca names it), or an existing one picked in `existing`.
  base: string | null;
  branchMode: "new" | "existing";
  branch: string;
  existing: PickedBranch | null;
}
const forms = new Map<string, Form>();

function formOf(key: string) {
  let form = forms.get(key);
  if (!form) {
    form = { fresh: false, name: "", project: null, worktree: null, base: null, branchMode: "new", branch: "", existing: null };
    forms.set(key, form);
  }
  return form;
}

// A form that holds nothing the owner made (no choice of the worktree): it is the default one, so it is not kept.
function dropIdleForm(key: string) {
  const form = forms.get(key);
  if (form && !form.fresh && form.name === "" && form.worktree === null && form.base === null && form.branchMode === "new" && form.branch === "" && form.existing === null) forms.delete(key);
}

// By item key, in memory only: leaving and coming back to the item shows its session again.
const sessions = new Map<string, Session>();
// The instruction of an item whose send failed while another item was in view: it is put back in the field of its own item.
const drafts = new Map<string, string>();
// The files attached to the instruction of an item (A-10), by item key: they stay with the item while another is in view, and go with the send.
const attached = new Map<string, Attachment[]>();
// The project chosen for a new session (`OrcaProject.key`), kept for the next handoff.
let chosenProject: string | null = null;
// The worktree a send of an item made and did not finish with (the files or the launch failed after it): a send again with the same project, name, branch, base and destination uses it instead of making another.
const made = new Map<string, { project: string; name: string; branch: string | null; base: string | null; environment: string | null; path: string }>();
// The Orca the panes talk to (a saved environment's name, null for this machine), kept for the next handoff. Undefined until one is chosen: the panes then follow the target of the Orca screen, which a choice here never changes.
let chosenDest: string | null | undefined;
const panes = new Set<HandoffPane>();
let ticking = false;
// While a session is shown, the list is read again this often (for its header).
const POLL_MS = 10_000;
const NEW_WORKTREE = "新規作成";
const KIND_ICONS = { mail: MAIL_SVG, slack: SLACK_SVG, todo: TODO_SVG } as const;
// The number of the next pane, which names it as the owner of its terminal.
let paneSeq = 0;

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
  // The keys of the items whose hand-over (or follow-up) is on its way, and the message of the last failed hand-over or post of each item. They belong to the item, so a switch of the item loses none.
  private sending = new Set<string>();
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
  // Names the pane as the owner of the terminal it shows (orca-terminal.ts).
  private owner = `handoff-${++paneSeq}`;
  // The element that takes the files dropped or pasted before a hand-over: it stays, and the form is drawn in it. After it the terminal takes them (A-10).
  private formMain = tag("div", "ho-main ho-whole");
  // The parts of the session shown: its notice, its header, the note for a session whose terminal cannot be shown, and the host of the terminal.
  private sess: { notice: HTMLElement; title: HTMLElement; note: HTMLElement; term: HTMLElement } | null = null;
  // The parts of the form shown.
  private el: {
    notice: HTMLElement;
    chip?: HTMLButtonElement;
    claudeNote?: HTMLElement;
    cardBox?: HTMLElement;
    strip: HTMLElement;
    card?: { title: HTMLElement; meta: HTMLElement };
    destChip?: HTMLButtonElement;
    projectChip?: HTMLButtonElement;
    name?: HTMLInputElement;
    freshBox?: HTMLElement;
    base?: HTMLButtonElement;
    modeNew?: HTMLButtonElement;
    modeExisting?: HTMLButtonElement;
    branchName?: HTMLInputElement;
    existingChip?: HTMLButtonElement;
    error: HTMLElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
  } | null = null;

  constructor(host: HandoffHost) {
    this.host = host;
    listenForFiles(this.formMain, (files) => this.addFiles(files));
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

  // The pane follows the host: another item (or none) in view changes what it shows, and a session already handed to the item is shown again.
  sync() {
    const item = this.host.current();
    const key = item?.key ?? null;
    if (key !== this.itemKey) {
      if (this.itemKey !== null) dropIdleForm(this.itemKey);
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
    this.syncTerminal();
    if (this.open && this.lastRead === 0) this.reload(true);
  }

  private get busy() {
    return this.itemKey !== null && this.sending.has(this.itemKey);
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

  // Opens the pane for the item in view, unless it is open (a host whose icon only chooses the pane).
  show() {
    this.sync();
    if (this.itemKey === null || this.open) return;
    this.open = true;
    this.lastRead = 0;
    this.sync();
  }

  // Closes the pane because another pane of the host's screen takes its place.
  close() {
    if (!this.open) return;
    this.open = false;
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
    this.syncTerminal();
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

  // Where the terminal of a session comes from, or null when it cannot be shown: the session has no terminal (the launch named none and the list has none). A saved environment that the Orca screen streams (A-12) is streamed; any other terminal, this machine's or a saved environment's, is mirrored.
  private sourceOf(s: Session): TermSource | null {
    const handle = s.handle ?? this.rowOf(s)?.handle ?? null;
    if (handle === null) return null;
    const kind = s.environment !== null && streamsEnvironment(s.environment) ? "stream" : "mirror";
    return { kind, handle, path: s.path, environment: s.environment };
  }

  // The terminal belongs to this pane while it shows a session that is in view (the window shown, the pane on the screen); otherwise its stream or reads are let go. Without a terminal the note says so.
  private syncTerminal() {
    const s = this.open ? this.session() : undefined;
    const sess = this.sess;
    const source = s ? this.sourceOf(s) : null;
    if (sess) {
      sess.term.hidden = source === null;
      sess.note.hidden = source !== null;
    }
    if (!sess || !source || document.hidden || sess.term.getClientRects().length === 0) return hideTerminals(this.owner);
    showTerminals([{ id: source.handle, source, host: sess.term }], source.handle, this.owner);
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
      this.sess = null;
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

  // The parts of the form: the form with its message, the files attached, the field of the instruction and the arrow button that sends it.
  private parts() {
    const form = tag("form", "ho-form");
    const error = tag("p", "pending fail");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const cardBox = tag("div", "ho-card-box");
    const strip = tag("div", "attachments");
    strip.hidden = true;
    const input = tag("textarea", "chat-input");
    input.rows = 3;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Orca への指示");
    const send = iconButton("Orca に渡す", ARROW_UP_SVG, "icon-btn chat-send chat-send-icon");
    send.type = "submit";
    input.oninput = () => this.updateSend();
    form.onsubmit = (e) => {
      e.preventDefault();
      this.handOver();
    };
    return { form, error, cardBox, strip, input, send };
  }

  private buildForm() {
    const close = iconButton("閉じる", CLOSE_SVG);
    close.onclick = () => {
      this.open = false;
      this.sync();
    };
    const head = tag("div", "ho-head");
    close.hidden = this.host.stays === true;
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
        { search: { label: "プロジェクトを検索", empty: "一致するプロジェクトがありません" } },
      );
    const chip = tag("button", "review-chip ho-chip ho-worktree");
    chip.type = "button";
    chip.setAttribute("aria-label", "worktree");
    chip.setAttribute("aria-haspopup", "menu");
    chip.onclick = () => {
      const form = this.form();
      const picked = this.pickedWorktree();
      openMenu(
        chip,
        [
          ...this.projectWorktrees().map((w) => ({
            label: worktreeName(w),
            sub: w.gitBranch || undefined,
            color: "var(--accent)",
            current: !form.fresh && w.path === picked?.path,
            pick: () => {
              form.fresh = false;
              form.worktree = w.path;
              this.update();
              this.el?.input.focus();
            },
          })),
          {
            label: NEW_WORKTREE,
            color: "var(--accent)",
            current: form.fresh,
            pick: () => {
              form.fresh = true;
              this.update();
              this.el?.name?.focus();
            },
          },
        ],
        { search: { label: "worktree を検索", empty: "一致する worktree がありません" } },
      );
    };
    // The name of the worktree to make; Rust checks it (A-9).
    const name = tag("input", "ho-name");
    name.setAttribute("aria-label", "worktree の名前");
    name.autocomplete = "off";
    name.spellcheck = false;
    name.oninput = () => {
      const form = this.form();
      form.name = name.value;
      this.updateSend();
    };
    // The frame of a worktree to make, under the chips: its name, the ref it starts from and its branch (A-9).
    const base = tag("button", "review-chip ho-chip ho-base");
    base.type = "button";
    base.setAttribute("aria-label", "作成元");
    base.setAttribute("aria-haspopup", "dialog");
    base.onclick = () => {
      const form = this.form();
      const source = this.branchSource();
      if (!source) return;
      openBranchList(base, source, {
        current: (_kind, branch) => form.base === branch,
        refuseInUse: false,
        pickCurrent: true,
        top: {
          label: "既定",
          current: form.base === null,
          pick: () => {
            form.base = null;
            this.update();
          },
        },
        pick: (b) => {
          form.base = b.name;
          this.update();
        },
      });
    };
    const mode = (existing: boolean) => {
      const b = tag("button", "review-chip ho-chip", existing ? "既存のブランチ" : "新しいブランチ");
      b.type = "button";
      b.onclick = () => {
        this.form().branchMode = existing ? "existing" : "new";
        this.update();
      };
      return b;
    };
    const modeNew = mode(false);
    const modeExisting = mode(true);
    const seg = tag("div", "ho-seg");
    seg.append(modeNew, modeExisting);
    // A new branch: its name, blank for the name Orca gives. An existing one: picked from the branches, those another worktree has checked out refused.
    const branchName = tag("input", "ho-branch");
    branchName.setAttribute("aria-label", "ブランチの名前");
    branchName.autocomplete = "off";
    branchName.spellcheck = false;
    branchName.oninput = () => {
      this.form().branch = branchName.value;
      this.updateSend();
    };
    const existingChip = tag("button", "review-chip ho-chip ho-existing");
    existingChip.type = "button";
    existingChip.setAttribute("aria-label", "既存のブランチ");
    existingChip.setAttribute("aria-haspopup", "dialog");
    existingChip.onclick = () => {
      const form = this.form();
      const source = this.branchSource();
      if (!source) return;
      openBranchList(existingChip, source, {
        current: (kind, branch) => form.existing?.kind === kind && form.existing.name === branch,
        refuseInUse: true,
        pickCurrent: true,
        pick: (b) => {
          form.existing = b;
          this.update();
        },
      });
    };
    const field = (title: string, ...controls: HTMLElement[]) => {
      const row = tag("div", "ho-field");
      row.append(tag("span", "ho-field-title", title), ...controls);
      return row;
    };
    const freshBox = tag("div", "ho-fresh");
    freshBox.append(field("名前", name), field("作成元", base), field("ブランチ", seg, branchName, existingChip));
    freshBox.hidden = true;
    fresh.append(destChip, projectChip, chip);
    // The note while Claude cannot be used and the card is there (as the Slack thread's conversation).
    const claudeNote = tag("p", "chat-note", "設定の Claude タブで接続すると、Claude に要約してもらえます");
    const parts = this.parts();
    // Enter is a line break; Cmd+Enter (Ctrl+Enter off macOS) sends, unless it only confirms an IME conversion (as the other Claude conversations).
    parts.input.onkeydown = (e) => {
      if (e.key !== "Enter" || composing(e) || !(isMac ? e.metaKey : e.ctrlKey)) return;
      e.preventDefault();
      this.handOver();
    };
    // The field takes the height that is left, and the arrow is over its bottom right corner.
    const compose = tag("div", "ho-compose");
    compose.append(parts.input, parts.send);
    parts.form.classList.add("ho-fill");
    parts.form.append(notice, fresh, freshBox, claudeNote, parts.error, parts.cardBox, parts.strip, compose);
    this.formMain.replaceChildren(head, parts.form);
    this.sess = null;
    this.el = { notice, chip, claudeNote, destChip, projectChip, name, freshBox, base, modeNew, modeExisting, branchName, existingChip, cardBox: parts.cardBox, strip: parts.strip, error: parts.error, input: parts.input, send: parts.send };
    // The content is taken when the form is drawn, that is when the pane opens.
    this.card = this.item?.card() ?? null;
    this.restoreDraft(parts.input);
    this.host.root.replaceChildren(this.formMain);
  }

  // The session: its header, and the terminal under it (or the note while the terminal cannot be shown).
  private buildSession() {
    const title = tag("div", "ho-session-title");
    const open = iconButton("Orca の画面で開く", OPEN_SVG);
    open.onclick = () => openInOrca(this.session() ? this.paneKeyOf(this.session()!) : null);
    const close = iconButton("閉じる", CLOSE_SVG);
    close.onclick = () => this.forget();
    const head = tag("div", "ho-head ho-session-head");
    head.append(title, open, close);
    const notice = tag("div", "ho-notice");
    const note = tag("p", "ho-note", "セッションを始めました。画面は Orca で見られます。");
    const term = tag("div", "ho-term");
    const main = tag("div", "ho-main ho-whole");
    main.append(head, notice, term, note);
    this.el = null;
    this.sess = { notice, title, note, term };
    this.host.root.replaceChildren(main);
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
    if (this.sess) {
      const s = this.session();
      if (!s) return;
      const row = this.rowOf(s);
      if (row) s.seen = true;
      this.part("notice", [this.overview?.state, this.overview?.message], () => this.drawNotice(this.sess!.notice));
      this.part("session", [s, row, this.overview?.state, this.overview?.worktrees, Math.floor(Date.now() / 60_000)], () => this.drawSessionHead());
      return;
    }
    if (!this.el) return;
    this.part("notice", [this.overview?.state, this.overview?.message], () => this.drawNotice(this.el!.notice));
    const form = this.form();
    this.settle(form);
    this.part("dest", [chosenProject, form.fresh, form.name, form.worktree, form.base, form.branchMode, form.branch, form.existing, this.destination(), this.environments(), this.overview?.projects, this.overview?.worktrees], () => this.drawDest());
    this.drawCard();
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

  private drawNotice(box: HTMLElement) {
    const text = noticeOf(this.overview);
    const row = tag("div", this.overview?.state === "failed" ? "pending fail" : "pending");
    row.append(tag("span", "sp", text ?? ""));
    box.replaceChildren(...(text ? [row] : []));
  }

  // The worktrees of the project chosen, its own folder (`isMain`) first.
  private projectWorktrees() {
    const all = chosenProject === null ? [] : (this.overview?.worktrees ?? []).filter((w) => w.projectKey === chosenProject);
    return [...all.filter((w) => w.isMain), ...all.filter((w) => !w.isMain)];
  }

  // The worktree a send without 新規作成 starts in: the one chosen in the list, else the project's own folder.
  private pickedWorktree() {
    const list = this.projectWorktrees();
    const path = this.form().worktree;
    return list.find((w) => w.path === path) ?? list.find((w) => w.isMain);
  }

  // The label of the worktree chip: "{name} ・ {branch}", "default" alone while none is in the list.
  private worktreeChip() {
    const w = this.pickedWorktree();
    return w ? [worktreeName(w), w.gitBranch].filter(Boolean).join(" ・ ") : "default";
  }

  // Where the branches of a new worktree are read from: a worktree of the project (its own folder first) and the project's key.
  private branchSource(): BranchSource | undefined {
    const first = this.projectWorktrees()[0];
    return first && chosenProject !== null ? { target: this.destination(), path: first.path, repo: chosenProject } : undefined;
  }

  // The choices of a worktree belong to the project they were made in: another project clears them.
  private settle(form: Form) {
    if (form.project === chosenProject) return;
    form.project = chosenProject;
    form.worktree = null;
    form.base = null;
    form.existing = null;
  }

  // True when a new session can start with what is chosen: a project, and a worktree of it, or one to make (with the existing branch picked when that is the branch asked for).
  private target(form: Form) {
    if (chosenProject === null) return false;
    return form.fresh ? form.branchMode === "new" || form.existing !== null : this.pickedWorktree() !== undefined;
  }

  // The chips with the destination (this machine, or the saved environment), the project and the worktree chosen, and the frame of a new worktree.
  private drawDest() {
    const { chip, destChip, projectChip, name, freshBox, base, modeNew, modeExisting, branchName, existingChip } = this.el!;
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
    chip!.textContent = form.fresh ? NEW_WORKTREE : this.worktreeChip();
    chip!.disabled = chosen === undefined;
    if (name!.value !== form.name) name!.value = form.name;
    // The branch: a new one is named in the field, an existing one is picked, and then the ref it starts from is not used.
    const existing = form.branchMode === "existing";
    base!.textContent = form.base ?? "既定";
    base!.disabled = existing || this.branchSource() === undefined;
    modeNew!.setAttribute("aria-pressed", String(!existing));
    modeExisting!.setAttribute("aria-pressed", String(existing));
    if (branchName!.value !== form.branch) branchName!.value = form.branch;
    branchName!.hidden = existing;
    existingChip!.hidden = !existing;
    existingChip!.textContent = form.existing?.name ?? "ブランチを選ぶ";
    existingChip!.disabled = this.branchSource() === undefined;
    freshBox!.hidden = !form.fresh;
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
          this.updateSend();
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
    const sess = this.sess;
    if (!s || !sess) return;
    const row = this.rowOf(s);
    const worktree = this.overview?.worktrees.find((w) => w.path === s.path);
    const name = row ? `${row.repo} ・ ${row.branch}` : worktree ? worktreeLabel(worktree) : s.path;
    const time = row ? elapsed(row.atMs, Date.now(), row.group === "done") : "";
    // Until its row is in the list a new session is being checked; once it was there and a ready list lacks it, it has ended.
    const state = row ? [STATUS_LABELS[row.status], time].filter(Boolean).join(" ・ ") : s.seen && this.overview?.state === "ready" ? "終了" : "確認中";
    sess.title.replaceChildren(tag("span", "ho-session-name", name), tag("span", "ho-session-state", state));
  }

  private claudeReady() {
    return getClaude()?.state === "ready";
  }

  private updateSend() {
    const el = this.el;
    if (!el) return;
    // Before a hand-over the field is the instruction. Nothing goes to Orca without one, a project, and its own folder or a worktree to make; and Claude summarises the card, so it must be usable while the card is there. The arrow stops while the hand-over is on its way, and so while the summary is made.
    const form = this.form();
    const needsClaude = !this.removed && this.card !== null;
    const ready = !needsClaude || this.claudeReady();
    el.input.disabled = this.busy;
    el.send.disabled = this.busy || !ready || this.overview?.state === "missing" || !el.input.value.trim() || !this.target(form);
    el.claudeNote!.hidden = ready;
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
    this.open = this.host.forced === true || this.host.stays === true;
    this.lastRead = 0;
    this.sync();
  }

  // Makes the worktree of a new session with `orca_worktree_create` and gives its path (Rust checks the name). One that an earlier send of the item made with the same project, name and destination is used again, so a retry after a later failure makes none twice.
  private async makeWorktree(key: string, form: Form, project: string, environment: string | null) {
    const { name } = form;
    // A new branch is named in the field (blank: Orca names it); an existing one is the branch the worktree gets, and then no ref to start from is passed.
    const existing = form.branchMode === "existing" && form.existing !== null;
    const branch = existing ? form.existing!.localName : form.branch.trim() || null;
    const base = existing ? null : form.base;
    const earlier = made.get(key);
    if (earlier && earlier.project === project && earlier.name === name && earlier.branch === branch && earlier.base === base && earlier.environment === environment) return earlier.path;
    const path = await invoke("orca_worktree_create", { project, name, branch, base, environment });
    made.set(key, { project, name, branch, base, environment, path });
    return path;
  }

  // Hands the instruction over as it was written: Claude summarises the content first when the card is there (a failure ends it before anything starts), then the worktree is made when 新規作成 is chosen (a failure ends it before anything starts), the files go into the worktree of the session, and the session starts once with the instruction, the paths of the files, the summary and the content.
  private async handOver() {
    const el = this.el;
    const key = this.itemKey;
    if (el === null || key === null || this.busy || this.session()) return;
    const form = this.form();
    const instruction = el.input.value;
    const environment = this.destination();
    const project = chosenProject;
    this.settle(form);
    const own = this.pickedWorktree()?.path ?? null;
    if (!instruction.trim() || project === null || !this.target(form)) return;
    const files = attached.get(key) ?? [];
    const card = this.removed ? null : this.card;
    if (card && !this.claudeReady()) return;
    this.sending.add(key);
    this.errors.delete(key);
    this.update();
    try {
      const context = card ? { kind: card.kind, title: card.title, body: card.body } : null;
      const summary = context ? (await invoke("claude_summarize_handoff", { context })).points : [];
      const worktree = form.fresh ? await this.makeWorktree(key, form, project, environment) : own!;
      const uploaded = files.length ? await uploadAttachments(files, worktree, environment) : [];
      const destination: HandoffDestination = { kind: "new", path: worktree };
      const started = await invoke("orca_handoff", { destination, instruction, files: uploaded.map((f) => f.text), summary, context, environment });
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
      this.keepText(key, instruction);
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

// The name of a worktree in the lists: "default" for the project's own folder, else Orca's name of it.
const worktreeName = (w: OrcaWorktree) => (w.isMain ? "default" : w.branch || w.gitBranch || w.repo);

// The Orca icon, a node each time.
function orcaIcon() {
  const icon = tag("span", "ho-icon");
  icon.innerHTML = ORCA_SVG;
  return icon;
}
