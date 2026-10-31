// The inbox list: loading, syncing with Gmail, and taking a row out (archive / trash) with its undo.
import type { Inbox } from "./bindings/Inbox";
import type { Sync } from "./bindings/Sync";
import type { ThreadItem } from "./bindings/ThreadItem";
import { renderAccounts } from "./accounts.js";
import { $, composing } from "./dom.js";
import { place, pending, row, rowKey, rows, updateBadge } from "./inbox-rows.js";
import { invoke } from "./ipc.js";
import { currentScreen } from "./nav.js";
import { opened } from "./thread.js";
import { hideToast, toast } from "./toast.js";
import { show, showError } from "./view.js";

// What the last archive / trash did, for "元に戻す" and Cmd+Z (Ctrl+Z off macOS): the command that reverses it and the thread data to put back.
// One only; a newer removal replaces it.
let lastRemoved: { undo: "unarchive" | "untrash"; account: string; id: string; t: ThreadItem } | null = null;
let removeSeq = 0; // taken when a removal starts, so a slower older one cannot replace a newer one
let rememberedSeq = 0;
const REMOVALS = {
  archive: { undo: "unarchive", message: "アーカイブしました" },
  trash: { undo: "untrash", message: "ゴミ箱へ移動しました" },
} as const;

// An account that was removed has nothing left to undo.
export function forgetRemoved(account: string) {
  if (lastRemoved?.account === account) lastRemoved = null;
}

// Takes the row out at once and runs "archive" / "trash" in the background; on failure the row comes back.
export async function removeRow(command: "archive" | "trash", account: string, id: string, li: HTMLLIElement) {
  const key = `${account}/${id}`;
  const t = rows.get(key)?.t;
  const seq = ++removeSeq;
  pending.add(key);
  li.remove();
  updateBadge();
  $("error").hidden = true;
  try {
    const done = await invoke(command, { account, id });
    if (done === null) return load();
    rows.delete(key);
    if (t && seq > rememberedSeq) {
      rememberedSeq = seq;
      lastRemoved = { undo: REMOVALS[command].undo, account, id, t };
      toast(REMOVALS[command].message, { label: "元に戻す", run: undoRemove });
    }
  } catch (e) {
    // Back by the state it has now: a mark-as-read meanwhile moves it to the read section.
    place(li, li.classList.contains("unread"));
    // A row drawn from the kept list before the load answered is not in rows; without it the next sync adds the thread again.
    if (t && !rows.has(key)) rows.set(key, { t, li });
    showError(e);
  } finally {
    pending.delete(key);
    updateBadge();
  }
}

// Reverses the last removal in Gmail and puts the row back in date order; on failure it stays available.
async function undoRemove() {
  const op = lastRemoved;
  if (!op) return;
  lastRemoved = null;
  hideToast();
  $("error").hidden = true;
  try {
    const done = await invoke(op.undo, { account: op.account, id: op.id });
    if (done === null) return load();
    applyChanges([op.t], []);
    toast("元に戻しました");
  } catch (e) {
    lastRemoved ??= op;
    showError(e);
  }
}

// Only the latest of overlapping loads may draw the list.
let loadSeq = 0;
// Loads in flight; a sync stays out of their way.
let loading = 0;
// Per account, the mailbox history ID as of the last load or sync: where the next sync starts.
export const historyIds = new Map<string, string>();

// Set when a load answers; the kept list of the last run, which is drawn first at startup, must not come after it.
let inboxLoaded = false;

function drawThreads(inbox: Inbox) {
  const shown = inbox.threads.filter((t) => !pending.has(rowKey(t)));
  rows.clear();
  for (const t of shown) rows.set(rowKey(t), { t, li: row(t) });
  // The open thread's row is rebuilt too: removing it must take the row now on screen.
  const current = opened.current;
  if (current) {
    const now = rows.get(rowKey(current));
    if (now) current.li = now.li;
  }
  const all = [...rows.values()];
  $("unread-threads").replaceChildren(...all.filter((r) => r.t.unread).map((r) => r.li));
  $("read-threads").replaceChildren(...all.filter((r) => !r.t.unread).map((r) => r.li));
  updateBadge();
}

// Draws the list the last run kept while the first load is still on its way; a missing or failed read leaves the screen to the load. Its rows work like the loaded ones.
export async function showKeptInbox() {
  let kept: Inbox | null = null;
  try {
    kept = await invoke("inbox_cached");
  } catch {}
  if (!kept || inboxLoaded) return;
  renderAccounts(kept);
  drawThreads(kept);
  if (currentScreen() === "mail") show("list");
}

export async function load() {
  const seq = ++loadSeq;
  loading++;
  $("error").hidden = true;
  try {
    const inbox = await invoke("inbox");
    if (seq !== loadSeq) return;
    inboxLoaded = true;
    renderAccounts(inbox);
    if (inbox.accounts.length === 0) return show("login");
    historyIds.clear();
    for (const [account, id] of Object.entries(inbox.historyIds)) historyIds.set(account, id);
    drawThreads(inbox);
  } catch (e) {
    showError(e);
  } finally {
    loading--;
  }
  // A load that ends while the calendar is shown (e.g. after a re-login there) must not switch the screen; nor must it close an open thread.
  if (currentScreen() === "mail" && $("thread").hidden) show("list");
}

const sameRow = (a: ThreadItem, b: ThreadItem) =>
  (["from", "subject", "snippet", "dateMs", "unread"] as const).every((k) => a[k] === b[k]);

// Adds the row of `t` in date order, or swaps it for the one on screen; the rest of the list is left alone.
function upsert(t: ThreadItem) {
  const key = rowKey(t);
  const old = rows.get(key);
  if (pending.has(key) || (old && sameRow(old.t, t))) return;
  // shortcut: a row whose read toggle is in flight keeps its optimistic state, upgrade if that ever shows stale.
  if (old && old.li.querySelector<HTMLInputElement>(".read-box")!.disabled) return;
  const li = row(t);
  rows.set(key, { t, li });
  const focused = old?.li.contains(document.activeElement) ? document.activeElement!.classList : null;
  if (old && old.li.dataset.dateMs === li.dataset.dateMs && old.t.unread === t.unread) {
    old.li.replaceWith(li);
  } else {
    if (old) old.li.remove();
    place(li, t.unread);
  }
  const current = opened.current;
  if (old && current && current.li === old.li) current.li = li;
  if (focused) li.querySelector<HTMLElement>(`.${[...focused].join(".")}`)?.focus();
}

// Applies one account's changes in place: the first visible row stays where it is on screen.
// shortcut: with the detail view open the list cannot be measured, so rows added above shift it, upgrade if that bothers.
export function applyChanges(threads: ThreadItem[], removedKeys: string[]) {
  const main = $("main");
  const top = main.getBoundingClientRect().top;
  const anchor = [...$("threads").querySelectorAll("li")].find((li) => li.getBoundingClientRect().bottom > top);
  const before = anchor?.getBoundingClientRect().top;
  for (const key of removedKeys) {
    const r = rows.get(key);
    if (r) r.li.remove();
    rows.delete(key);
  }
  threads.forEach(upsert);
  if (anchor?.isConnected && main.scrollTop > 0) main.scrollTop += anchor.getBoundingClientRect().top - before!;
  updateBadge();
}

export function applySync(account: string, r: Sync) {
  if (r.kind === "changed") {
    applyChanges(r.threads, r.removed.map((id) => `${account}/${id}`));
  } else if (r.kind === "reloaded") {
    const keep = new Set(r.threads.map(rowKey));
    applyChanges(r.threads, [...rows.keys()].filter((k) => k.startsWith(`${account}/`) && !keep.has(k)));
  } else if (r.kind === "needsLogin") {
    // The detail view stays; the list shows the re-login row at the next load.
    historyIds.delete(account);
    if (!$("threads").hidden) load();
    return;
  } else {
    return;
  }
  historyIds.set(account, r.historyId);
}

const SYNC_MS = 10000;
// Consecutive sync rounds with an error; one failure is not worth the user's attention.
let syncFails = 0;
let syncing = false;

// Brings the list up to date with Gmail through `sync`, without leaving the current view.
async function syncAll() {
  if (syncing || loading || document.hidden || historyIds.size === 0) return;
  syncing = true;
  const seq = loadSeq;
  let failure: unknown = null;
  try {
    for (const [account, startHistoryId] of [...historyIds]) {
      try {
        const r = await invoke("sync", { account, startHistoryId });
        // A load that started meanwhile redraws everything from a newer state.
        if (seq !== loadSeq || loading) return;
        applySync(account, r);
      } catch (e) {
        failure = e;
      }
    }
  } finally {
    syncing = false;
  }
  syncFails = failure ? syncFails + 1 : 0;
  if (syncFails === 3) showError(`自動同期に失敗しています: ${failure}`);
}

const isMac = /Mac/.test(navigator.platform);

export function initInbox() {
  setInterval(syncAll, SYNC_MS);
  document.addEventListener("visibilitychange", syncAll);
  $("reload").onclick = load;
  // Cmd+Z (Ctrl+Z off macOS) undoes the last removal; in a text field it stays that field's own undo.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey !== isMac || e.ctrlKey === isMac || e.altKey || e.shiftKey || e.key !== "z" || composing(e) || !lastRemoved) return;
    const a = document.activeElement;
    if ((a as HTMLElement | null)?.isContentEditable || a?.closest?.("input, textarea")) return;
    e.preventDefault();
    undoRemove();
  });
}
