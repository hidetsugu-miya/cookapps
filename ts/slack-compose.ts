// The Slack compose screen, opened by "Slack に貼る" in the thread's header. It has two modes, switched at the right of the header (S-27); it always opens in Claude mode.
// Both modes hold the same part: at the top the original message (it starts as the mail's latest message; pressing it opens the field to edit it) with "元の内容に戻す" above it, under it the things to do
// ("行うこと": numbered cards, each one post, with where it goes and what it posts, and a plus that adds one), and "投稿" at the bottom, which sends them from the top down.
// Claude mode puts the terminal of Claude Code (S-4, ts/slack-compose-claude.ts) in a column at its left; Claude Code reads and writes the original message and the cards through the target "slack-compose" of ts/screen-bridge.ts
// and asks for "投稿" with `slack_compose_post` (the screen does what its button does). What it wrote can be taken back with "元に戻す" above the fields. Manual mode hides the column. Both show one draft, so a switch keeps it.
// Nothing leaves the app until "投稿" is pressed, by the owner or by the tool (which the owner allows each time in the terminal).
import type { Channel } from "./bindings/Channel";
import type { Recent } from "./bindings/Recent";
import type { SlackAction } from "./bindings/SlackAction";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { Target } from "./bindings/Target";
import type { Workspace } from "./bindings/Workspace";
import { $, composing, tag } from "./dom.js";
import { unescapeHtml } from "./format.js";
import { CLOSE_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { currentScreen, setScreen, showComposeScreen, showThreadScreen } from "./nav.js";
import { type Fields, registerDraftTarget } from "./screen-bridge.js";
import { endSlackComposeClaude, hideSlackComposeClaude, initSlackComposeClaude, syncSlackComposeClaude } from "./slack-compose-claude.js";
import { initSplit } from "./split.js";
import { type OpenThread, opened } from "./thread.js";
import { toast } from "./toast.js";
import { showFailure } from "./error-card.js";

// What is being written: kept in memory only, for one mail at a time (the key is its thread and its latest message).
// Opening the screen for another mail starts a new one; leaving the screen or the mail keeps it.
interface Draft {
  key: string;
  // The text the original message started as; "元の内容に戻す" brings it back.
  original: string;
  // The original message as it is now (the mail's content, edited by the owner or by Claude).
  text: string;
  // The things to do, in the order they are sent. There is always a first one.
  actions: Action[];
}
// One thing to do: one post, where it goes and what it holds, as Rust reads and answers it (`SlackAction`).
// Where: `target`, a channel or a thread chosen in the picker (`after` null), or the thread of the post of an earlier action (`after` is its index, and `target` is not used).
// `byClaude`: the destination is one that Claude Code put there with a write of the fields, not one the owner chose.
// What: the original message as it is (`paste`), or the text written in the card.
// `posted` is set once it was posted, and it is never sent again: its `thread` is the thread a later action continues, the thread it replied in or else the time of its own message (empty when Slack answered none).
type Action = SlackAction;
let draft: Draft | null = null;
// Which of the two parts of the screen is shown. It is not kept: every opening starts in Claude mode.
type Mode = "claude" | "manual";

// From the last `slack_load`: the picker lists them.
let workspaces: Workspace[] = [];
let recent: Recent[] = [];
// The most things to do that are not posted: what one request to Claude posts at most (`ACTIONS_MAX` of `slack.rs`). The plus is off at that many.
const ACTIONS_MAX = 10;
// The post is on its way.
let posting = false;
// The dialog that asks where the later posts go is open (#905).
let dialogOpen = false;
// What the original message and the cards held before each write of Claude Code (S-4), the oldest first, and what they were after it (as `keyOf` writes them).
// "元に戻す" puts the newest back. An entry works only while the fields are as it left them, so a change after a write forgets every one (`refreshSlackCompose`).
interface Undo {
  before: { text: string; actions: Action[] };
  after: string;
}
const undos: Undo[] = [];
const keyOf = (d: Draft) => JSON.stringify([d.text, d.actions]);
const copyOf = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
// Where the thread was scrolled to when the screen opened (#main is hidden meanwhile, which forgets it).
let threadScroll = 0;
let resetTimer = 0;

const wsName = (teamId: string) => workspaces.find((w) => w.teamId === teamId)?.team ?? "";
const label = (t: { name: string; threadTs: string | null }) => `#${t.name}${t.threadTs ? "（スレッド）" : ""}`;

// The text of an HTML message is read from its frame (allow-same-origin).
function latestText(current: OpenThread) {
  const m = current.messages.at(-1)!;
  if (!m.html) return m.body;
  const doc = $("messages").firstElementChild?.querySelector("iframe")?.contentDocument;
  return doc?.body?.innerText.trim() || unescapeHtml(m.snippet);
}
const slackDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function disarmReset() {
  clearTimeout(resetTimer);
  const reset = $("slack-reset");
  reset.classList.remove("confirm", "danger");
  reset.textContent = "元の内容に戻す";
}

function showComposeError(e: unknown) {
  $("slack-error").textContent = String(e);
  $("slack-error").hidden = false;
}

// What the chip of an action says about where it goes.
function whereLabel(a: Action) {
  if (a.after !== null) return `${a.after + 1} のスレッド`;
  return a.target ? `${wsName(a.target.teamId)} ・ ${label(a.target)}` : "選んでください";
}

// Where the action `a` of `d` is sent now: its own destination, or the thread of the earlier action it continues, known once that one is posted with a time.
function destinationOf(d: Draft, a: Action): Target | null {
  if (a.after === null) return a.target;
  const p = d.actions[a.after].posted;
  return p?.thread ? { teamId: p.teamId, channel: p.channel, name: p.name, threadTs: p.thread } : null;
}

// The channel that the action `index` of `d` goes to: its own destination's channel (a thread link gives its channel), or the channel of the post it continues. Null while none is chosen.
function channelOf(d: Draft, index: number): Target | null {
  const a = d.actions[index];
  if (a.after === null) return a.target && { ...a.target, threadTs: null };
  const p = d.actions[a.after].posted;
  return p ? { teamId: p.teamId, channel: p.channel, name: p.name, threadTs: null } : channelOf(d, a.after);
}

// The actions still to send, and whether "投稿" can send them all: each has somewhere to go and a text that is not blank.
function pendingOf(d: Draft | null) {
  const pending = d?.actions.filter((a) => !a.posted) ?? [];
  const ready = pending.length > 0 && pending.every((a) => (a.after !== null || a.target) && (a.paste ? d!.text : a.text).trim());
  return { pending, ready };
}

// Takes the action `index` out: the later ones move up, and one that continued its thread goes where it went.
function removeAction(d: Draft, index: number) {
  const [gone] = d.actions.splice(index, 1);
  for (const a of d.actions) {
    if (a.after === null) continue;
    if (a.after === index) [a.target, a.after, a.byClaude] = [gone.target, gone.after, gone.byClaude];
    else if (a.after > index) a.after--;
  }
}

// Draws the cards of the things to do. They change only when one is added, removed, chosen for or posted, or the screen opens, so typing in a card does not redraw them.
function drawActions() {
  const d = draft;
  $("slack-actions").replaceChildren(
    ...(d?.actions ?? []).map((a, index) => {
      const fixed = posting || !!a.posted;
      const card = tag("li", a.posted ? "slack-action posted" : "slack-action");
      const main = tag("div", "slack-action-main");
      const row = tag("div", "slack-action-row");
      const where = tag("button", "review-chip slack-where", whereLabel(a));
      where.type = "button";
      where.setAttribute("aria-haspopup", "menu");
      where.disabled = fixed;
      where.onclick = () => openPicker(where, a, index);
      const what = tag("button", "review-chip slack-what", "元のメッセージ");
      what.type = "button";
      what.setAttribute("aria-pressed", String(a.paste));
      what.disabled = fixed;
      what.onclick = () => {
        a.paste = !a.paste;
        $("slack-error").hidden = true;
        drawActions();
        refreshSlackCompose();
        if (!a.paste) $("slack-actions").children[index].querySelector("textarea")?.focus();
      };
      row.append(where, what);
      if (a.posted) row.append(tag("span", "status ok slack-done", "投稿済み"));
      else if (index > 0) {
        const remove = tag("button", "icon-btn slack-remove");
        remove.type = "button";
        remove.setAttribute("aria-label", "消す");
        remove.innerHTML = CLOSE_SVG;
        remove.disabled = posting;
        remove.onclick = () => {
          removeAction(d!, index);
          $("slack-error").hidden = true;
          drawActions();
          refreshSlackCompose();
        };
        row.append(remove);
      }
      main.append(row);
      if (!a.paste) {
        const text = tag("textarea", "slack-text");
        text.setAttribute("aria-label", "文面");
        text.spellcheck = false;
        text.value = a.text;
        text.disabled = fixed;
        text.oninput = () => {
          a.text = text.value;
          $("slack-error").hidden = true;
          refreshSlackCompose();
        };
        main.append(text);
      }
      card.append(tag("span", "slack-no", String(index + 1)), main);
      return card;
    }),
  );
  $<HTMLButtonElement>("slack-add").disabled = !d || posting || pendingOf(d).pending.length >= ACTIONS_MAX;
}

// Shows one of the two parts of the screen; nothing of the draft changes.
function setMode(mode: Mode) {
  $("slack-compose").dataset.mode = mode;
  for (const m of ["claude", "manual"] as const) $(`slack-mode-${m}`).setAttribute("aria-pressed", String(m === mode));
  // The terminal is shown in Claude mode and hidden (its process goes on) in manual mode.
  syncSlackComposeClaude();
}

// The preview is shown, or the field it opens (pressing the preview opens it, leaving the field closes it).
function setEditing(on: boolean) {
  $("slack-preview").hidden = on;
  $<HTMLTextAreaElement>("slack-body").hidden = !on;
}

// Draws what follows from the state: the preview, the buttons, and "元に戻す" of what Claude Code wrote.
function refreshSlackCompose() {
  const d = draft;
  $("slack-preview").textContent = d?.text ?? "";
  $<HTMLTextAreaElement>("slack-body").disabled = posting;
  const { pending, ready } = pendingOf(d);
  $("slack-post").textContent = pending.length > 1 ? `${pending.length} 件を投稿` : "投稿";
  $<HTMLButtonElement>("slack-post").disabled = !ready || posting;
  const same = !d || d.text === d.original;
  $<HTMLButtonElement>("slack-reset").disabled = same;
  if (same) disarmReset();
  // A write is taken back only while the fields are as the newest write left them: a change of the owner's (or a post) makes every one unusable, and they are forgotten.
  if (undos.length && (!d || undos[undos.length - 1].after !== keyOf(d))) undos.length = 0;
  $("slack-undo-bar").hidden = undos.length === 0;
  $<HTMLButtonElement>("slack-undo").disabled = posting;
}

// The picker under the chip `anchor` of the action `a` (the one at `index`): for an action after the first, the threads of the posts before it; then the workspace, recent destinations, a channel search, and a link. A pick closes it.
function openPicker(anchor: HTMLElement, a: Action, index: number) {
  const d = draft!;
  const input = (name: string, placeholder: string) => {
    const node = tag("input");
    node.setAttribute("aria-label", name);
    node.placeholder = placeholder;
    node.autocomplete = "off";
    return node;
  };
  const chosen = () => {
    $("slack-error").hidden = true;
    closeMenu();
    drawActions();
    refreshSlackCompose();
  };
  const choose = (t: Target) => {
    [a.target, a.after, a.byClaude] = [t, null, false];
    chosen();
  };
  const pop = tag("div", "menu slack-pop");

  // The posts before this one: it can go on in the thread of any of them.
  const threadList = tag("div", "pick-list");
  threadList.append(
    ...d.actions.slice(0, index).map((_, before) => {
      const b = tag("button", "", `${before + 1} のスレッド`);
      b.onclick = () => {
        a.after = before;
        chosen();
      };
      return b;
    }),
  );

  // The workspace whose channels are searched; with one workspace it is not shown.
  const wsSelect = tag("select");
  wsSelect.setAttribute("aria-label", "ワークスペース");
  for (const w of workspaces) wsSelect.append(new Option(w.team, w.teamId));
  wsSelect.value = a.target?.teamId ?? workspaces[0].teamId;

  const recentList = tag("div", "pick-list");
  recentList.append(
    ...recent.map((r) => {
      const b = tag("button", "", label(r));
      b.append(tag("span", "ws", wsName(r.teamId)));
      b.onclick = () => choose(r);
      return b;
    }),
  );

  const search = input("チャンネルを検索", "チャンネルを検索");
  const reload = tag("button", "text-btn", "更新");
  reload.setAttribute("aria-label", "チャンネルの一覧を取り直す");
  const channelList = tag("div", "pick-list");
  let channels: Channel[] = [];
  let channelsSeq = 0;
  const drawChannels = () => {
    const q = search.value.trim().toLowerCase();
    const hits = channels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 50);
    channelList.replaceChildren(
      ...(hits.length
        ? hits.map((c) => {
            const b = tag("button", "", `#${c.name}`);
            b.onclick = () => choose({ teamId: wsSelect.value, channel: c.id, name: c.name, threadTs: null });
            return b;
          })
        : [tag("p", "empty", "該当するチャンネルがありません")]),
    );
  };
  const loadChannels = async (refresh: boolean) => {
    const seq = ++channelsSeq;
    channels = [];
    channelList.replaceChildren(tag("p", "empty", "読み込んでいます…"));
    try {
      const got = await invoke("slack_channels", { teamId: wsSelect.value, refresh });
      if (seq !== channelsSeq) return;
      channels = got;
      drawChannels();
    } catch (e) {
      if (seq === channelsSeq) channelList.replaceChildren(tag("p", "err", String(e)));
    }
  };
  search.oninput = drawChannels;
  wsSelect.onchange = () => loadChannels(false);
  reload.onclick = () => loadChannels(true);

  const err = tag("p", "err");
  err.setAttribute("role", "alert");
  err.hidden = true;
  const link = tag("form", "row");
  const url = input("Slack のリンク", "Slack のリンク");
  link.append(url, tag("button", "text-btn", "選ぶ"));
  link.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      choose(await invoke("slack_link", { url: url.value }));
    } catch (error) {
      err.textContent = String(error);
      err.hidden = false;
    }
  };

  const searchRow = tag("div", "row");
  searchRow.append(search, reload);
  if (index > 0) pop.append(tag("h3", "", "前の投稿のスレッド"), threadList);
  if (workspaces.length > 1) pop.append(wsSelect);
  if (recent.length) pop.append(tag("h3", "", "最近使った先"), recentList);
  pop.append(tag("h3", "", "チャンネルを探す"), searchRow, channelList, tag("h3", "", "リンクから選ぶ"), link, err);
  showMenu(anchor, pop);
  loadChannels(false);
  search.focus();
}

// Starts a new draft from `current`'s latest message, and ends the talk with Claude Code.
// `stale` says the user moved on while the text was asked for; then nothing is touched.
async function newDraft(key: string, current: OpenThread, stale: () => boolean) {
  const latest = current.messages.at(-1)!;
  const original = await invoke("slack_preview", {
    subject: current.subject || "(件名なし)",
    from: latest.from,
    date: slackDate(latest.dateMs),
    body: latestText(current),
  });
  if (stale()) return;
  // One thing to do at first: paste the original message, to a destination that is not chosen yet.
  draft = { key, original, text: original, actions: [{ target: null, after: null, paste: true, text: "", posted: null, byClaude: false }] };
  // The talk with Claude Code was about the mail before: it ends, and the next show starts a new one. What it wrote cannot be taken back in the new draft.
  undos.length = 0;
  endSlackComposeClaude();
  $<HTMLTextAreaElement>("slack-body").value = original;
  $("slack-preview").textContent = original;
}

// The latest call of `openCompose`; an earlier one still waiting for a command goes no further.
let openSeq = 0;

async function openCompose() {
  const current = opened.current!;
  const seq = ++openSeq;
  // While a command is awaited the user can press again, open another mail or leave the thread: only the latest call, still on the same open thread, goes on.
  const stale = () => seq !== openSeq || opened.current !== current || $("thread").hidden === true;
  let loaded: SlackLoad;
  try {
    loaded = await invoke("slack_load");
  } catch (e) {
    if (stale()) return;
    return showFailure("slack-compose", e);
  }
  if (stale()) return;
  if (!loaded.workspaces.length)
    return toast("Slack のワークスペースを設定で追加してください", { label: "設定を開く", run: () => setScreen("settings", "slack") });
  [workspaces, recent] = [loaded.workspaces, loaded.recent];
  // A workspace that was removed meanwhile cannot be posted to.
  for (const a of draft?.actions ?? []) if (!a.posted && a.target && !workspaces.some((w) => w.teamId === a.target!.teamId)) a.target = null;
  const key = `${current.account}/${current.id}/${current.messages.at(-1)!.id}`;
  if (draft?.key !== key) {
    try {
      await newDraft(key, current, stale);
    } catch (e) {
      if (stale()) return;
      return showFailure("slack-compose", e);
    }
    if (stale()) return;
  }
  threadScroll = $("main").scrollTop;
  $("slack-subject").textContent = current.subject || "(件名なし)";
  $("slack-error").hidden = true;
  drawActions();
  setEditing(false);
  setMode("claude");
  showComposeScreen();
  // The terminal is shown now that its column is: the first show starts Claude Code.
  syncSlackComposeClaude();
  refreshSlackCompose();
}

// Back to the mail; the draft stays.
function back() {
  closeMenu();
  hideSlackComposeClaude();
  showThreadScreen();
  // The frames of the messages fit again after they are shown, which can shorten the page for a moment: restore the position once more after that.
  $("main").scrollTop = threadScroll;
  requestAnimationFrame(() => ($("main").scrollTop = threadScroll));
}

// The things to do of `d` after the first one that is not posted and not posted themselves: the ones whose destination is asked when two or more are to be posted (#905, #906).
function laterIndexes(d: Draft) {
  const first = d.actions.findIndex((a) => !a.posted);
  return d.actions.map((_, i) => i).filter((i) => i > first && !d.actions[i].posted);
}

// The two choices for the thing to do `i`: the thread of the one before it, or the other: the card's own destination when it has one, else the channel of the one before it.
function destinationChoices(d: Draft, i: number) {
  const a = d.actions[i];
  return [
    ["thread", `${i} のスレッドに投稿`],
    // A card with a destination of its own keeps it; one that continues a thread goes to the channel of the card before it.
    ["channel", a.after === null ? `${whereLabel(a)} に投稿` : `#${channelOf(d, i - 1)!.name} に投稿`],
  ] as const;
}

// Fixes the chosen destinations in the cards `indexes` of `d`.
function fixDestinations(d: Draft, choices: Map<number, string>) {
  // Every channel is read before any card changes: a card that continued a thread has the channel of the one before it.
  const channels = new Map([...choices.keys()].map((i) => [i, channelOf(d, i - 1)]));
  for (const [i, choice] of choices) {
    const a = d.actions[i];
    if (choice === "thread") [a.after, a.byClaude] = [i - 1, false];
    else if (a.after === null) a.byClaude = false;
    else [a.target, a.after, a.byClaude] = [channels.get(i)!, null, false];
  }
  $("slack-error").hidden = true;
  drawActions();
  refreshSlackCompose();
}

// The dialog of "投稿" for two things to do or more (#905): for each one after the first that is not posted, "N をどこに送りますか", the thread of the one before it or the other choice, chosen with a radio button; nothing is chosen for one that continues the thread of an earlier post other than the one before it.
// "投稿" of the dialog fixes the chosen destinations in the cards and resolves true; "やめる", Escape and a press on the dimmed screen resolve false and change nothing.
function askDestinations(d: Draft): Promise<boolean> {
  const indexes = laterIndexes(d);
  const dialog = tag("div", "slack-ask");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "投稿の送り先");
  const radios = new Map<number, HTMLInputElement[]>();
  for (const i of indexes) {
    const a = d.actions[i];
    const group = tag("fieldset", "slack-ask-item");
    group.append(tag("legend", "", `${i + 1} をどこに送りますか`));
    const current = a.after === i - 1 ? "thread" : a.after === null ? "channel" : "";
    const inputs = destinationChoices(d, i).map(([value, text]) => {
      const input = tag("input");
      input.type = "radio";
      input.name = `slack-ask-${i}`;
      input.value = value;
      input.checked = value === current;
      const choice = tag("label", "slack-ask-choice");
      choice.append(input, tag("span", "", text));
      group.append(choice);
      return input;
    });
    radios.set(i, inputs);
    dialog.append(group);
  }
  const cancel = tag("button", "text-btn", "やめる");
  cancel.type = "button";
  const go = tag("button", "text-btn primary", "投稿");
  go.type = "button";
  const buttons = tag("div", "slack-ask-buttons");
  buttons.append(cancel, go);
  dialog.append(buttons);
  const scrim = tag("div", "scrim slack-ask-scrim");
  scrim.append(dialog);
  const chosen = (i: number) => radios.get(i)!.find((r) => r.checked)?.value;
  const sync = () => (go.disabled = !indexes.every(chosen));

  return new Promise((resolve) => {
    const behind = [...document.querySelectorAll<HTMLElement>("#sidebar, #content")];
    dialogOpen = true;
    const close = (answer: boolean) => {
      dialogOpen = false;
      scrim.remove();
      for (const el of behind) el.inert = false;
      document.removeEventListener("keydown", onKey);
      $("slack-post").focus();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !composing(e)) close(false);
    };
    for (const r of radios.values()) for (const input of r) input.onchange = sync;
    cancel.onclick = () => close(false);
    scrim.onpointerdown = (e) => {
      if (e.target !== scrim) return;
      e.preventDefault();
      close(false);
    };
    go.onclick = () => {
      fixDestinations(d, new Map(indexes.map((i) => [i, chosen(i)!])));
      close(true);
    };
    sync();
    for (const el of behind) el.inert = true;
    document.addEventListener("keydown", onKey);
    document.body.append(scrim);
    (indexes.map((i) => radios.get(i)![0])[0] ?? go).focus();
  });
}

// "投稿": with one thing to do not posted it posts at once, and with more the dialog above asks first (#905), then `post`.
async function startPost() {
  const d = draft;
  if (!d || posting || dialogOpen) return;
  const { pending, ready } = pendingOf(d);
  if (!ready) return;
  if (pending.length > 1 && !(await askDestinations(d))) return;
  if (draft === d) await post();
}

// `post` sends the actions that are not posted yet, from the top down. One that continues a thread is sent to the thread of the post it follows, by the time (`ts`) that post answered.
// A failure stops there: what was sent is marked posted and is never sent again, and the rest stays as it is. The screen stays open after the last one, so more can be added.
// It answers how many it sent and the failure that stopped it, if any (the tool `slack_compose_post` tells them to Claude Code); the screen shows the failure itself.
async function post(): Promise<{ sent: number; error: string | null }> {
  const d = draft;
  if (!d || posting || !pendingOf(d).ready) return { sent: 0, error: "投稿できる行うことがありません" };
  $("slack-error").hidden = true;
  posting = true;
  drawActions();
  refreshSlackCompose();
  const sent: Target[] = [];
  let failed: { to: Target | null; error: unknown } | null = null;
  for (const a of d.actions) {
    if (a.posted) continue;
    const to = destinationOf(d, a);
    try {
      if (!to) throw "前の投稿の時刻が分からないため、スレッドに続けられません";
      const ts = await invoke("slack_post", { teamId: to.teamId, channel: to.channel, threadTs: to.threadTs, name: to.name, text: a.paste ? d.text : a.text, written: !a.paste });
      a.posted = { teamId: to.teamId, channel: to.channel, name: to.name, thread: to.threadTs ?? ts };
      sent.push(to);
      if (draft === d) drawActions();
    } catch (error) {
      failed = { to, error };
      break;
    }
  }
  posting = false;
  if (draft === d) drawActions();
  refreshSlackCompose();
  if (sent.length) toast(sent.length > 1 ? `${sent.length} 件を投稿しました` : `${wsName(sent[0].teamId)} の ${label(sent[0])} に貼りました`);
  if (!failed) return { sent: sent.length, error: null };
  // The error line is on the compose screen: when the screen was left, or another mail's draft took its place, a toast tells instead.
  if (currentScreen() === "compose" && draft === d) showComposeError(failed.error);
  else toast(failed.to ? `${wsName(failed.to.teamId)} の ${label(failed.to)} に貼れませんでした: ${failed.error}` : String(failed.error));
  return { sent: sent.length, error: String(failed.error) };
}

// What Claude Code reads and writes of the screen (`screen_read`, `screen_write`) and asks for (`slack_compose_post`), as the fields of the target "slack-compose" (S-4):
// `text` the original message, `actions` the cards as the text of a JSON array, and `destinations` the numbered destinations to choose from, which is read only. Rust makes the texts and checks a write (`slack_compose_read`, `slack_compose_write`); nothing is posted or saved by a write.
const composeNames = ["text", "actions", "destinations"];
const refusal = (e: string): never => {
  throw new Error(e);
};

async function readFields(): Promise<Fields> {
  const d = draft!;
  const read = await invoke("slack_compose_read", { actions: d.actions });
  return { text: d.text, actions: read.actions, destinations: read.destinations };
}

// Puts what Claude Code wrote into the original message and the cards, and keeps what they held before it for "元に戻す".
async function writeFields(fields: Fields) {
  const d = draft!;
  if (posting) refusal("投稿の最中のため、書けません");
  if (dialogOpen) refusal("送り先を確かめるダイアログが開いているため、書けません");
  if ("destinations" in fields) refusal("欄 destinations は読むだけです");
  const [before, was] = [copyOf({ text: d.text, actions: d.actions }), keyOf(d)];
  const actions = "actions" in fields ? await invoke("slack_compose_write", { text: fields.actions, actions: d.actions }) : d.actions;
  // The owner may have changed the fields while Rust checked the write: what was checked is not what is there now.
  if (draft !== d || posting || dialogOpen || keyOf(d) !== was) refusal("書いている間に画面が変わりました。もう一度 screen_read で読んでください");
  if ("text" in fields) {
    d.text = fields.text;
    $<HTMLTextAreaElement>("slack-body").value = d.text;
  }
  d.actions = actions;
  if (keyOf(d) !== was) undos.push({ before, after: keyOf(d) });
  $("slack-error").hidden = true;
  drawActions();
  refreshSlackCompose();
}

// "投稿" as the tool asks for it: one thing to do is posted at once and the answer says so; two or more open the dialog of the destinations, and the owner chooses there.
async function postFields(): Promise<Fields> {
  const d = draft!;
  if (posting) refusal("投稿の最中です");
  if (dialogOpen) refusal("送り先を確かめるダイアログがもう開いています");
  const { pending, ready } = pendingOf(d);
  if (pending.length === 0) refusal("投稿していない行うことがありません");
  if (!ready) refusal("送り先か文のない行うことがあるため、投稿できません。screen_read で確かめてください");
  if (pending.length > 1) {
    void startPost();
    return { state: "asking" };
  }
  const done = await post();
  if (done.error !== null) refusal(done.sent ? `${done.sent} 件を投稿したあと、失敗しました: ${done.error}` : `投稿できませんでした: ${done.error}`);
  return { state: "posted", count: String(done.sent) };
}

export function initSlackCompose() {
  $("thread-slack").onclick = openCompose;
  $("slack-back").onclick = back;
  $("slack-mode-claude").onclick = () => setMode("claude");
  $("slack-mode-manual").onclick = () => setMode("manual");
  $("slack-post").onclick = startPost;
  // A new thing to do goes on in the thread of the one before it, with a text of its own that starts empty.
  $("slack-add").onclick = () => {
    const d = draft;
    if (!d || posting || pendingOf(d).pending.length >= ACTIONS_MAX) return;
    d.actions.push({ target: null, after: d.actions.length - 1, paste: false, text: "", posted: null, byClaude: false });
    drawActions();
    refreshSlackCompose();
    const card = $("slack-actions").lastElementChild!;
    card.scrollIntoView({ block: "nearest" });
    card.querySelector("textarea")?.focus();
  };
  const startEditing = () => {
    if (posting || !draft) return;
    setEditing(true);
    $<HTMLTextAreaElement>("slack-body").focus();
  };
  $("slack-preview").onclick = startEditing;
  $("slack-preview").onkeydown = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    startEditing();
  };
  $<HTMLTextAreaElement>("slack-body").onblur = () => setEditing(false);
  $<HTMLTextAreaElement>("slack-body").oninput = (e) => {
    draft!.text = (e.currentTarget as HTMLTextAreaElement).value;
    $("slack-error").hidden = true;
    refreshSlackCompose();
  };
  // The edits are lost, so it takes two presses: the first arms, and leaving the button or 4 seconds disarms.
  $("slack-reset").onclick = () => {
    const reset = $("slack-reset");
    if (!reset.classList.contains("confirm")) {
      reset.classList.add("confirm", "danger");
      reset.textContent = "もう一度押すと戻す";
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    draft!.text = draft!.original;
    $<HTMLTextAreaElement>("slack-body").value = draft!.original;
    refreshSlackCompose();
  };
  $("slack-reset").onblur = disarmReset;
  // Puts back what the newest write of Claude Code replaced, the original message and the cards together.
  $("slack-undo").onclick = () => {
    const [d, last] = [draft, undos[undos.length - 1]];
    if (!d || posting || !last) return;
    undos.pop();
    d.text = last.before.text;
    d.actions = copyOf(last.before.actions);
    $<HTMLTextAreaElement>("slack-body").value = d.text;
    $("slack-error").hidden = true;
    drawActions();
    refreshSlackCompose();
  };
  registerDraftTarget("slack-compose", {
    names: composeNames,
    isOpen: () => currentScreen() === "compose" && draft !== null,
    read: readFields,
    write: writeFields,
    post: postFields,
  });
  initSlackComposeClaude();
  // The divider sets the width of the column of the terminal, 35% to 60% of the screen body, 45% at first.
  initSplit($("slack-main"), $("slack-split"), { side: "left", min: 0.35, max: 0.6, initial: 0.45, property: "--term-w" });
  drawActions();
  refreshSlackCompose();
}
