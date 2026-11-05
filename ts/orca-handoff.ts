// Handing the open mail, Slack thread or Todo to Orca (A-9): a pane on the right of the screen that shows, and the user decides.
// Before a send it has the destination (a new session in a worktree, or a running session), the card with the content (taken off with ×) and the instruction; nothing is sent until the user presses the button.
// After a send it shows that session: its header, its history (orca-chat.ts) and a composer for more instructions. The prompt is composed in Rust (`orca_handoff`).
// A pane belongs to one screen (the host): the mail thread, the Slack thread's Orca tab or the Todo detail. What is kept is in memory only: the session each item was handed to, and the worktree last chosen.
import type { OrcaOverview } from "./bindings/OrcaOverview";
import type { OrcaRow } from "./bindings/OrcaRow";
import { tag } from "./dom.js";
import { CHEVRON_SVG, CLOSE_SVG, MAIL_SVG, OPEN_SVG, ORCA_SVG, SLACK_SVG, TODO_SVG } from "./icons.js";
import { type HandoffDestination, invoke } from "./ipc.js";
import { closeChat, isChatOwner, makeChatView, openChat, setChatWorking, type ChatView } from "./orca-chat.js";
import type { HandoffCard } from "./orca-handoff-cards.js";
import { elapsed, GROUP_LABELS, GROUP_STATUS, heldOrca, noticeOf, openInOrca, openWorktreeDialog, refreshOrca, STATUS_LABELS, statusIcon, worktreeLabel } from "./orca.js";

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

// By item key, in memory only: leaving and coming back to the item shows its session again.
const sessions = new Map<string, Session>();
// The instruction of an item whose send failed while another item was in view: it is put back in the field of its own item.
const drafts = new Map<string, string>();
// The worktree chosen for a new session, kept for the next handoff.
let chosenPath: string | null = null;
const panes = new Set<HandoffPane>();
let ticking = false;
// While a session is shown, the list is read again this often (for its header).
const POLL_MS = 10_000;
const KIND_ICONS = { mail: MAIL_SVG, slack: SLACK_SVG, todo: TODO_SVG } as const;
const GROUPS = ["waiting", "working", "done"] as const;

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
  // The text of the card is open (A-9): it stays open while the card is drawn again, and is closed by another item.
  private cardOpen = false;
  // "new" or the handle of the running session picked.
  private dest = "new";
  // The keys of the items whose post is on its way, and the message of the last failed post of each item. They belong to the item, so a switch of the item loses neither.
  private sending = new Set<string>();
  private errors = new Map<string, string>();
  // What the host was last told, and the minute the pane last drew.
  private lastOpen: boolean | null = null;
  private lastMinute = 0;
  // The card the drawn pane shows (compared by identity).
  private cardDrawn: HandoffCard | null | undefined;
  private overview: OrcaOverview | null = null;
  private readSeq = 0;
  private lastRead = 0;
  private chat: ChatView;
  private chatKey: string | null = null;
  private el: {
    notice: HTMLElement;
    fresh?: HTMLElement;
    chip?: HTMLButtonElement;
    rows?: HTMLElement;
    cardBox?: HTMLElement;
    card?: { title: HTMLElement; meta: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement };
    target?: HTMLElement;
    sessionTitle?: HTMLElement;
    note?: HTMLElement;
    error: HTMLElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
  } | null = null;

  constructor(host: HandoffHost) {
    this.host = host;
    this.chat = makeChatView(tag("div", "ho-chat"), tag("div", "ho-items"), tag("button", "text-btn ho-older", "以前の履歴を読む"), tag("div", "ho-chat-status"));
    this.chat.older.hidden = true;
    this.chat.box.append(this.chat.older, this.chat.list);
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
      this.itemKey = key;
      this.removed = false;
      this.cardOpen = false;
      this.dest = "new";
      // The card is built when the pane opens (the form is drawn), not for each item that goes by.
      this.card = null;
      this.open = key !== null && (this.host.forced === true || sessions.has(key));
      this.overview = heldOrca();
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
    return this.itemKey !== null && this.sending.has(this.itemKey);
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
    // The times on the pane are in minutes: it is drawn again when the minute changes (a read draws it too).
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.lastMinute) {
      this.lastMinute = minute;
      this.update();
    }
    // A shown session is read again every POLL_MS, unless the command is missing.
    if (this.open && this.mode() === "session" && this.overview?.state !== "missing" && Date.now() - this.lastRead >= POLL_MS) this.reload(false);
  }

  // Reads the list of Orca: forced when the pane opens and after a send, and not while another read is on its way when it is the poll of a shown session.
  private async reload(force: boolean) {
    const seq = ++this.readSeq;
    this.lastRead = Date.now();
    const overview = await refreshOrca(force);
    if (seq !== this.readSeq || !this.open) return;
    this.overview = overview;
    this.update();
    this.syncChat();
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
    form.append(error, cardBox, box);
    const foot = tag("div", "ho-foot");
    foot.append(form);
    return { foot, error, cardBox, input, send };
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
    const pick = tag("button", "ho-new-btn", "新しいセッション");
    pick.type = "button";
    pick.onclick = () => {
      this.dest = "new";
      this.update();
    };
    const chip = tag("button", "review-chip ho-chip");
    chip.type = "button";
    chip.setAttribute("aria-haspopup", "dialog");
    chip.onclick = () =>
      openWorktreeDialog(chip, this.overview?.worktrees ?? [], chosenPath, (path) => {
        chosenPath = path;
        this.dest = "new";
        this.update();
        this.el?.input.focus();
      });
    fresh.append(pick, chip);
    const rows = tag("div", "ho-rows");
    const scroll = tag("div", "ho-scroll");
    // An environment of Orca (not this machine) is named by the heading, as the status label of the Orca screen names it.
    const label = tag("p", "ho-label", "送り先");
    const target = tag("span", "ho-target");
    label.append(target);
    scroll.append(notice, label, fresh, rows);
    const main = tag("div", "ho-main");
    main.append(head, scroll);
    const foot = this.foot();
    this.el = { notice, fresh, chip, rows, target, cardBox: foot.cardBox, error: foot.error, input: foot.input, send: foot.send };
    // The content is taken when the form is drawn, that is when the pane opens.
    this.card = this.item?.card() ?? null;
    this.restoreDraft(foot.input);
    this.host.root.replaceChildren(main, foot.foot);
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
    this.el = { notice, sessionTitle, note, error: foot.error, input: foot.input, send: foot.send };
    this.restoreDraft(foot.input);
    this.host.root.replaceChildren(main, foot.foot);
    foot.input.focus();
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
      const rows = (this.overview?.rows ?? []).filter((r) => r.handle !== null);
      const minute = Math.floor(Date.now() / 60_000);
      this.part("dest", [this.dest, chosenPath, this.overview?.target, this.overview?.worktrees, rows, minute], () => this.drawDest());
      this.drawCard();
    } else {
      const s = this.session()!;
      const row = this.rowOf(s);
      if (row) s.seen = true;
      this.part("session", [s, row, this.overview?.state, this.overview?.worktrees, Math.floor(Date.now() / 60_000)], () => this.drawSessionHead());
    }
    this.updateSend();
  }

  private drawNotice() {
    const text = noticeOf(this.overview);
    const row = tag("div", this.overview?.state === "failed" ? "pending fail" : "pending");
    row.append(tag("span", "sp", text ?? ""));
    this.el!.notice.replaceChildren(...(text ? [row] : []));
  }

  // The chip, and the running sessions that can take a send, in the groups of the Orca screen.
  private drawDest() {
    const { fresh, chip, rows, target } = this.el!;
    target!.textContent = this.overview?.target ?? "";
    const worktrees = this.overview?.worktrees ?? [];
    if (chosenPath !== null && !worktrees.some((w) => w.path === chosenPath)) chosenPath = null;
    const chosen = worktrees.find((w) => w.path === chosenPath);
    chip!.textContent = chosen ? worktreeLabel(chosen) : worktrees.length ? "worktree を選ぶ" : "worktree がありません";
    chip!.disabled = worktrees.length === 0;
    const usable = (this.overview?.rows ?? []).filter((r) => r.handle !== null);
    if (this.dest !== "new" && !usable.some((r) => r.handle === this.dest)) this.dest = "new";
    fresh!.querySelector("button")!.setAttribute("aria-pressed", String(this.dest === "new"));
    const now = Date.now();
    const nodes: HTMLElement[] = [];
    for (const group of GROUPS) {
      const list = usable.filter((r) => r.group === group);
      if (!list.length) continue;
      const heading = tag("h3", "ho-group");
      heading.append(statusIcon(GROUP_STATUS[group], GROUP_LABELS[group]), GROUP_LABELS[group], tag("span", "ho-count", String(list.length)));
      nodes.push(heading);
      for (const r of list) {
        const row = tag("button", "ho-row");
        row.type = "button";
        row.dataset.handle = r.handle!;
        row.setAttribute("aria-pressed", String(this.dest === r.handle));
        const top = tag("span", "ho-row-top");
        top.append(tag("span", "ho-row-title", r.line || "（題名なし）"), tag("span", "ho-row-time", elapsed(r.atMs, now, r.group === "done")));
        row.append(top, tag("span", "ho-row-sub", `${r.repo} ・ ${r.branch}`));
        row.onclick = () => {
          this.dest = r.handle!;
          this.update();
          this.el?.input.focus();
        };
        nodes.push(row);
      }
    }
    rows!.replaceChildren(...nodes);
  }

  // The card with the content to hand over, until it is taken off. Its text can be opened to read exactly what the command will get as `context.body`.
  // The nodes are kept while the card changes: only their text is set, so an open text stays open and keeps its scroll position and selection.
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
        const toggle = tag("button", "orca-ctx-btn ho-card-toggle");
        toggle.type = "button";
        const chevron = tag("span", "orca-chev");
        chevron.innerHTML = CHEVRON_SVG;
        toggle.append(chevron, tag("span", "", "送る内容を読む"));
        const body = tag("div", "ho-card-body");
        toggle.onclick = () => {
          this.cardOpen = !this.cardOpen;
          this.showCardBody();
        };
        node.append(row, toggle, body);
        box.replaceChildren(node);
        el.card = { title, meta, body, toggle };
      }
      const ui = el.card;
      if (ui.title.textContent !== card.title) ui.title.textContent = card.title;
      if (ui.meta.textContent !== card.meta) ui.meta.textContent = card.meta;
      // Set only when it changed: setting it again would drop the selection.
      if (ui.body.textContent !== card.body) ui.body.textContent = card.body;
      this.showCardBody();
    }
  }

  private showCardBody() {
    const ui = this.el?.card;
    if (!ui) return;
    ui.toggle.setAttribute("aria-expanded", String(this.cardOpen));
    ui.body.hidden = !this.cardOpen;
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

  private updateSend() {
    const el = this.el;
    if (!el) return;
    const s = this.session();
    const existing = this.dest !== "new";
    el.send.textContent = s || existing ? "送る" : "起動する";
    el.input.disabled = this.busy;
    el.input.placeholder = s || existing ? "追加の指示を書く" : "起動するエージェントへの指示を書く";
    // A session with no terminal can be read but takes no post; a new one needs a worktree.
    const target = s ? (s.handle ?? this.rowOf(s)?.handle ?? null) !== null : existing || chosenPath !== null;
    el.send.disabled = this.busy || this.overview?.state === "missing" || !el.input.value.trim() || !target;
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
    this.dest = "new";
    this.removed = false;
    this.cardOpen = false;
    // The form is drawn again, and takes the content then.
    this.card = null;
    this.open = this.host.forced === true;
    this.lastRead = 0;
    this.sync();
  }

  // The first send hands the content over; a send to a session that is shown posts more instructions. A post is never tried again, and a failure keeps the text.
  private async submit() {
    const el = this.el;
    const key = this.itemKey;
    if (!el || key === null || this.busy) return;
    const text = el.input.value;
    if (!text.trim()) return;
    const environment = this.overview?.target ?? null;
    const known = sessions.get(key);
    const picked = this.overview?.rows.find((r) => r.handle !== null && r.handle === this.dest);
    const path = chosenPath;
    const handle = known ? (known.handle ?? this.rowOf(known)?.handle ?? null) : null;
    if (known ? handle === null : this.dest === "new" ? path === null : !picked) return;
    const card = this.removed ? null : this.card;
    this.sending.add(key);
    this.errors.delete(key);
    this.updateSend();
    try {
      if (known) {
        await invoke("orca_send", { handle: handle!, text, environment: known.environment });
      } else {
        const destination: HandoffDestination = picked ? { kind: "existing", handle: picked.handle! } : { kind: "new", path: path! };
        const context = card ? { kind: card.kind, title: card.title, body: card.body } : null;
        const started = await invoke("orca_handoff", { destination, instruction: text, context, environment });
        sessions.set(
          key,
          picked
            ? { path: picked.path, paneKey: picked.paneKey, handle: started.handle ?? picked.handle, environment, seen: true }
            : { path: path!, paneKey: started.paneKey, handle: started.handle, environment, seen: false },
        );
      }
      el.input.value = "";
      this.lastRead = 0;
    } catch (e) {
      this.errors.set(key, String(e));
      // Another item is in view: its field is not this one, so the text waits for its own item.
      if (this.itemKey !== key) drafts.set(key, text);
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
