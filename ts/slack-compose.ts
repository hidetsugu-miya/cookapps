// The Slack compose screen, opened by "Slack に貼る" in the thread's header: the destination, the text to post (it starts as the mail's latest message and the user edits it),
// and a conversation with Claude that proofreads it. Nothing leaves the app until "貼る".
import type { Channel } from "./bindings/Channel";
import type { Recent } from "./bindings/Recent";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { Target } from "./bindings/Target";
import type { Workspace } from "./bindings/Workspace";
import { createChat } from "./claude-chat.js";
import { $, tag } from "./dom.js";
import { unescapeHtml } from "./format.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { currentScreen, setScreen, showSlackScreen, showThreadScreen } from "./nav.js";
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
  },
  ask: (text, history, instruction) => invoke("claude_proofread_slack", { text, history, instruction }),
  changed: refreshSlackCompose,
  locked: () => posting,
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

// Draws what follows from the state: the buttons, and whether Claude can be asked.
export function refreshSlackCompose() {
  const d = draft;
  $<HTMLTextAreaElement>("slack-body").disabled = posting;
  $<HTMLButtonElement>("slack-post").disabled = !d?.target || !d.text.trim() || posting;
  const same = !d || d.text === d.original;
  $<HTMLButtonElement>("slack-reset").disabled = same;
  if (same) disarmReset();
  $<HTMLButtonElement>("slack-proofread").disabled = !chat.refresh();
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
  showSlackScreen();
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
    if (currentScreen() === "slack" && draft === d) return showComposeError(e);
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
    if (currentScreen() === "slack") back();
  }
  refreshSlackCompose();
}

// The Claude pane is a third to a half as wide as #slack-main (the CSS clamp holds it there too), kept as a ratio so a resized window keeps it.
const MIN_RATIO = 1 / 3;
const MAX_RATIO = 1 / 2;
const KEY_STEP = 0.02;
let ratio = MIN_RATIO;

function setRatio(next: number) {
  ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, next));
  $("slack-main").style.setProperty("--chat-w", `${ratio * 100}%`);
  $("slack-split").setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
}

function initSplit() {
  const split = $("slack-split");
  const main = $("slack-main");
  setRatio(ratio);
  // The divider is dragged with pointer events on the document, so the drag goes on when the pointer leaves it. Dragging left widens the Claude pane.
  split.onpointerdown = (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const pointer = down.pointerId;
    main.classList.add("dragging");
    // The box is read once; the writes of a drag are gathered into one per animation frame.
    const box = main.getBoundingClientRect();
    let pending: number | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (pending !== null) setRatio(pending);
      pending = null;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pending = (box.right - e.clientX) / box.width;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      cancelAnimationFrame(frame);
      flush();
      main.classList.remove("dragging");
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
  };
  split.onkeydown = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setRatio(ratio + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP));
  };
}

export function initSlackCompose() {
  $("thread-slack").onclick = openCompose;
  $("slack-back").onclick = back;
  $("slack-post").onclick = post;
  $("slack-target").onclick = openPicker;
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
  $("slack-proofread").onclick = () => chat.send("校正してください");
  chat.init();
  initSplit();
  drawTarget();
  refreshSlackCompose();
}
