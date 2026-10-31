// "Slack に貼る": posts the open thread's latest message to a destination picked in a dialog under the header button.
import type { Channel } from "./bindings/Channel";
import type { SlackLoad } from "./bindings/SlackLoad";
import type { Target } from "./bindings/Target";
import { $, tag } from "./dom.js";
import { unescapeHtml } from "./format.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { setScreen } from "./nav.js";
import { opened } from "./thread.js";
import { toast } from "./toast.js";
import { showError } from "./view.js";

// The text of an HTML message is read from its frame (allow-same-origin).
function latestText() {
  const m = opened.current!.latest;
  if (!m.html) return m.body;
  const doc = $("messages").firstElementChild?.querySelector("iframe")?.contentDocument;
  return doc?.body?.innerText.trim() || unescapeHtml(m.snippet);
}
const slackDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

async function openSlackDialog() {
  $("error").hidden = true;
  let loaded: SlackLoad;
  try {
    loaded = await invoke("slack_load");
  } catch (e) {
    return showError(e);
  }
  const { workspaces, recent } = loaded;
  if (!workspaces.length)
    return toast("Slack のワークスペースを設定で追加してください", { label: "設定を開く", run: () => setScreen("settings") });
  const current = opened.current!;
  const mail = {
    subject: current.subject || "(件名なし)",
    from: current.latest.from,
    date: slackDate(current.latest.dateMs),
    body: latestText(),
  };
  let preview: string;
  try {
    preview = await invoke("slack_preview", mail);
  } catch (e) {
    return showError(e);
  }
  const wsName = (teamId: string) => workspaces.find((w) => w.teamId === teamId)?.team ?? "";
  const label = (t: { name: string; threadTs: string | null }) => `#${t.name}${t.threadTs ? "（スレッド）" : ""}`;
  const pop = tag("div", "menu slack-pop");
  const input = (name: string, placeholder: string) => {
    const node = tag("input");
    node.setAttribute("aria-label", name);
    node.placeholder = placeholder;
    node.autocomplete = "off";
    return node;
  };

  // The workspace whose channels are searched; with one workspace it is not shown.
  const wsSelect = tag("select");
  wsSelect.setAttribute("aria-label", "ワークスペース");
  for (const w of workspaces) wsSelect.append(new Option(w.team, w.teamId));
  const chosenEl = tag("p", "chosen", "貼り付け先を選んでください");
  const note = tag("textarea");
  note.rows = 2;
  note.placeholder = "ひとこと（任意）";
  note.setAttribute("aria-label", "ひとこと");
  const err = tag("p", "err");
  err.setAttribute("role", "alert");
  err.hidden = true;
  const post = tag("button", "text-btn", "貼る");
  post.disabled = true;

  // Where the mail goes: set by a recent destination, a channel, or a link.
  let chosen: Target | null = null;
  const choose = (t: Target) => {
    chosen = t;
    chosenEl.textContent = `貼り付け先: ${wsName(t.teamId)} ・ ${label(t)}`;
    err.hidden = true;
    post.disabled = false;
    if (wsSelect.value !== t.teamId) {
      wsSelect.value = t.teamId;
      loadChannels(false);
    }
  };

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

  post.onclick = async () => {
    const t = chosen!;
    err.hidden = true;
    post.disabled = true;
    try {
      await invoke("slack_post", { teamId: t.teamId, channel: t.channel, threadTs: t.threadTs, name: t.name, note: note.value, ...mail });
      closeMenu();
      toast(`${wsName(t.teamId)} の ${label(t)} に貼りました`);
    } catch (e) {
      err.textContent = String(e);
      err.hidden = false;
      post.disabled = false;
    }
  };

  const searchRow = tag("div", "row");
  searchRow.append(search, reload);
  if (workspaces.length > 1) pop.append(wsSelect);
  if (recent.length) pop.append(tag("h3", "", "最近使った先"), recentList);
  pop.append(tag("h3", "", "チャンネルを探す"), searchRow, channelList, tag("h3", "", "リンクから選ぶ"), link, chosenEl);
  pop.append(tag("pre", "preview", preview), note, err, post);
  showMenu($("thread-slack"), pop);
  loadChannels(false);
  search.focus();
}

export function initSlackDialog() {
  $("thread-slack").onclick = openSlackDialog;
}
