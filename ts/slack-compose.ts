// The Slack compose screen, opened by "Slack に貼る" in the thread's header. Two panes: on the left the preview of the post (it starts as the mail's latest message; pressing it opens the field to edit it)
// with the destination and "元の内容に戻す" above it and "投稿" below, and on the right a conversation with Claude that proofreads it. Nothing leaves the app until "投稿".
import type { Channel } from "./bindings/Channel";
import type { Recent } from "./bindings/Recent";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { Target } from "./bindings/Target";
import type { Workspace } from "./bindings/Workspace";
import { showModelSlot } from "./claude.js";
import { createChat } from "./claude-chat.js";
import { createComposer } from "./composer.js";
import { $, tag } from "./dom.js";
import { unescapeHtml } from "./format.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { currentScreen, setScreen, showComposeScreen, showThreadScreen } from "./nav.js";
import { initSplit } from "./split.js";
import { type OpenThread, opened } from "./thread.js";
import { toast } from "./toast.js";
import { showError } from "./view.js";

// What is being written: kept in memory only, for one mail at a time (the key is its thread and its latest message).
// Opening the screen for another mail starts a new one; leaving the screen or the mail keeps it.
interface Draft {
  key: string;
  // The text the post started as; "元の内容に戻す" brings it back.
  original: string;
  text: string;
  target: Target | null;
}
let draft: Draft | null = null;

// From the last `slack_load`: the picker lists them.
let workspaces: Workspace[] = [];
let recent: Recent[] = [];
// The post is on its way.
let posting = false;
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

const chat = createChat({
  prefix: "slack",
  loginNote: "設定の Claude タブで接続すると、校正できます",
  text: () => draft?.text ?? null,
  apply: (text) => {
    draft!.text = text;
    $<HTMLTextAreaElement>("slack-body").value = text;
    $("slack-preview").textContent = text;
  },
  ask: (text, history, instruction) => invoke("claude_proofread_slack", { text, history, instruction }),
  changed: refreshSlackCompose,
  locked: () => posting,
  keyHint: false,
  fixedInput: true,
});

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

// Draws the destination chip. It changes only when a destination is chosen or the screen opens, so typing does not write it.
function drawTarget() {
  const t = draft?.target;
  $("slack-target").textContent = t ? `${wsName(t.teamId)} ・ ${label(t)}` : "選んでください";
}

// The preview is shown, or the field it opens (pressing the preview opens it, leaving the field closes it).
function setEditing(on: boolean) {
  $("slack-preview").hidden = on;
  $<HTMLTextAreaElement>("slack-body").hidden = !on;
}

// Draws what follows from the state: the preview, the buttons, and whether Claude can be asked.
export function refreshSlackCompose() {
  const d = draft;
  $("slack-preview").textContent = d?.text ?? "";
  $<HTMLTextAreaElement>("slack-body").disabled = posting;
  $<HTMLButtonElement>("slack-post").disabled = !d?.target || !d.text.trim() || posting;
  const same = !d || d.text === d.original;
  $<HTMLButtonElement>("slack-reset").disabled = same;
  if (same) disarmReset();
  chat.refresh();
}

// The picker under the destination chip: the workspace, recent destinations, a channel search, and a link. A pick closes it.
function openPicker() {
  const d = draft!;
  const input = (name: string, placeholder: string) => {
    const node = tag("input");
    node.setAttribute("aria-label", name);
    node.placeholder = placeholder;
    node.autocomplete = "off";
    return node;
  };
  const choose = (t: Target) => {
    d.target = t;
    $("slack-error").hidden = true;
    closeMenu();
    drawTarget();
    refreshSlackCompose();
  };
  const pop = tag("div", "menu slack-pop");

  // The workspace whose channels are searched; with one workspace it is not shown.
  const wsSelect = tag("select");
  wsSelect.setAttribute("aria-label", "ワークスペース");
  for (const w of workspaces) wsSelect.append(new Option(w.team, w.teamId));
  wsSelect.value = d.target?.teamId ?? workspaces[0].teamId;

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
  const url = input("Slack のリンク", "https://…slack.com/archives/…");
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
  if (workspaces.length > 1) pop.append(wsSelect);
  if (recent.length) pop.append(tag("h3", "", "最近使った先"), recentList);
  pop.append(tag("h3", "", "チャンネルを探す"), searchRow, channelList, tag("h3", "", "リンクから選ぶ"), link, err);
  showMenu($("slack-target"), pop);
  loadChannels(false);
  search.focus();
}

// Starts a new draft from `current`'s latest message, and forgets the conversation and the request being typed.
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
  draft = { key, original, text: original, target: null };
  chat.reset();
  chat.clearInput();
  $<HTMLTextAreaElement>("slack-body").value = original;
  $("slack-preview").textContent = original;
}

// The latest call of `openCompose`; an earlier one still waiting for a command goes no further.
let openSeq = 0;

async function openCompose() {
  $("error").hidden = true;
  const current = opened.current!;
  const seq = ++openSeq;
  // While a command is awaited the user can press again, open another mail or leave the thread: only the latest call, still on the same open thread, goes on.
  const stale = () => seq !== openSeq || opened.current !== current || $("thread").hidden === true;
  let loaded: SlackLoad;
  try {
    loaded = await invoke("slack_load");
  } catch (e) {
    if (stale()) return;
    return showError(e);
  }
  if (stale()) return;
  if (!loaded.workspaces.length)
    return toast("Slack のワークスペースを設定で追加してください", { label: "設定を開く", run: () => setScreen("settings", "slack") });
  [workspaces, recent] = [loaded.workspaces, loaded.recent];
  // A workspace that was removed meanwhile cannot be posted to.
  if (draft?.target && !workspaces.some((w) => w.teamId === draft!.target!.teamId)) draft.target = null;
  const key = `${current.account}/${current.id}/${current.messages.at(-1)!.id}`;
  if (draft?.key !== key) {
    try {
      await newDraft(key, current, stale);
    } catch (e) {
      if (stale()) return;
      return showError(e);
    }
    if (stale()) return;
  }
  threadScroll = $("main").scrollTop;
  $("slack-subject").textContent = current.subject || "(件名なし)";
  $("slack-error").hidden = true;
  drawTarget();
  setEditing(false);
  // The selects in the frame of the request field need the model settings.
  showModelSlot("slack-model");
  showComposeScreen();
  // The log is drawn already (by the answers, or by the new draft's reset); only its scroll position was lost while the screen was hidden.
  refreshSlackCompose();
  const log = $("slack-log");
  log.scrollTop = log.scrollHeight;
}

// Back to the mail; the draft stays.
function back() {
  closeMenu();
  showThreadScreen();
  // The frames of the messages fit again after they are shown, which can shorten the page for a moment: restore the position once more after that.
  $("main").scrollTop = threadScroll;
  requestAnimationFrame(() => ($("main").scrollTop = threadScroll));
}

async function post() {
  const d = draft;
  const t = d?.target;
  if (!d || !t || posting) return;
  $("slack-error").hidden = true;
  posting = true;
  refreshSlackCompose();
  try {
    await invoke("slack_post", { teamId: t.teamId, channel: t.channel, threadTs: t.threadTs, name: t.name, text: d.text });
  } catch (e) {
    posting = false;
    refreshSlackCompose();
    // The error line is on the compose screen: when the screen was left, or another mail's draft took its place, a toast tells instead.
    if (currentScreen() === "compose" && draft === d) return showComposeError(e);
    return toast(`${wsName(t.teamId)} の ${label(t)} に貼れませんでした: ${e}`);
  }
  posting = false;
  toast(`${wsName(t.teamId)} の ${label(t)} に貼りました`);
  // The post is done, so the draft goes (unless another mail's draft has taken its place); the screen goes back only if it is still the one shown.
  if (draft === d) {
    draft = null;
    chat.reset();
    chat.clearInput();
    drawTarget();
    if (currentScreen() === "compose") back();
  }
  refreshSlackCompose();
}

export function initSlackCompose() {
  $("thread-slack").onclick = openCompose;
  $("slack-back").onclick = back;
  $("slack-post").onclick = post;
  $("slack-target").onclick = openPicker;
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
  // The form is the shared composer's; the field is three lines high and scrolls inside.
  $("slack-chat-note").after(createComposer({ prefix: "slack", label: "Claude への依頼" }));
  chat.init();
  initSplit($("slack-main"), $("slack-split"));
  drawTarget();
  refreshSlackCompose();
}
