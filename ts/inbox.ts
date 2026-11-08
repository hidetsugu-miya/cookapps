// The inbox list: loading, syncing with Gmail, and taking a row out (archive / trash) with its undo.
import type { Inbox } from "./bindings/Inbox";
import type { Sync } from "./bindings/Sync";
import type { ThreadItem } from "./bindings/ThreadItem";
import { renderAccounts } from "./accounts.js";
import { announceArrival } from "./arrivals.js";
import { $, composing, isMac, tag } from "./dom.js";
import { markAllRead, place, pending, row, rowKey, rows, updateBadge } from "./inbox-rows.js";
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

// A load that failed (the call, or an account in its answer) is repeated by the sync round at `nextReload`, and at once by the button of the failure display.
// The wait doubles after each failure, from 60 seconds up to 5 minutes, and a load that works clears it.
const RELOAD_FIRST_MS = 60000;
const RELOAD_MAX_MS = 300000;
let nextReload: number | null = null;
let reloadDelay = RELOAD_FIRST_MS;

function scheduleReload(failed: boolean) {
  if (failed) {
    nextReload = Date.now() + reloadDelay;
    reloadDelay = Math.min(reloadDelay * 2, RELOAD_MAX_MS);
  } else {
    nextReload = null;
    reloadDelay = RELOAD_FIRST_MS;
  }
}

// The text the inbox itself put in `#error` (the sync notice), so a later load or sync clears only that and not an error shown for something else.
let inboxError: string | null = null;

function showInboxError(e: unknown) {
  showError(e);
  inboxError = $("error").textContent;
}

function clearInboxError() {
  if (inboxError !== null && !$("error").hidden && $("error").textContent === inboxError) $("error").hidden = true;
  inboxError = null;
}

// Why the last load failed, drawn in `#inbox-state` (above the rows, which stay) until a load works; null when it worked.
// It belongs to the list, not to `#error`, so it stays when another screen is shown.
let loadFailure: string | null = null;

// What `#inbox-state` shows now, so that a redraw with nothing changed leaves the button (and its focus) alone.
let stateKey = "";

// The state of the list: loading before the first answer, the failure of the last load with its button, or the note that there is nothing to show.
function drawInboxState() {
  const hasRows = $("threads").querySelector("li") !== null;
  const key = JSON.stringify([loadFailure, hasRows, inboxLoaded]);
  const box = $("inbox-state");
  if (key === stateKey) {
    // A load that starts or ends only enables or disables the button of the failure: it is not made again, so it keeps the focus.
    const button = box.querySelector("button");
    if (button) button.disabled = loading > 0;
    return;
  }
  stateKey = key;
  if (loadFailure !== null) {
    const row = tag("div", "pending fail");
    const retry = tag("button", "text-btn", "再読み込み");
    retry.type = "button";
    retry.disabled = loading > 0;
    retry.onclick = () => load();
    row.append(tag("span", "sp", `読み込めませんでした: ${loadFailure}。自動でも読み直します`), retry);
    box.replaceChildren(row);
  } else if (hasRows) {
    box.replaceChildren();
  } else if (!inboxLoaded) {
    const row = tag("div", "pending");
    row.append(tag("span", "spin"), tag("span", "sp", "読み込んでいます…"));
    box.replaceChildren(row);
  } else {
    box.replaceChildren(tag("div", "feed-empty", "受信トレイにスレッドはありません"));
  }
}

function drawThreads(inbox: Inbox) {
  // The rows are all rebuilt: the button that has the focus is found again on the new row of the same thread.
  const active = document.activeElement;
  let focus: { key: string; selector: string } | null = null;
  if (active?.classList.length) {
    for (const [key, r] of rows) if (r.li.contains(active)) focus = { key, selector: `.${[...active.classList].join(".")}` };
  }
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
  if (focus) rows.get(focus.key)?.li.querySelector<HTMLElement>(focus.selector)?.focus();
}

// Draws the list the last run kept while the first load is still on its way, or the loading note when there is none; a failed read leaves the rows to the load. Its rows work like the loaded ones.
export async function showKeptInbox() {
  let kept: Inbox | null = null;
  try {
    kept = await invoke("inbox_cached");
  } catch {}
  if (inboxLoaded) return;
  if (kept) {
    renderAccounts(kept);
    drawThreads(kept);
  }
  if (currentScreen() === "mail") show("list");
}

// `background` is a retry of the sync round: it clears only the notice the inbox showed in `#error` itself.
// The failure of the latest load is kept in `loadFailure` for the list, whichever screen is shown.
export async function load(background = false) {
  const seq = ++loadSeq;
  loading++;
  // Whether this load failed; stays null when a newer load took over.
  let failed: boolean | null = null;
  if (background) clearInboxError();
  else $("error").hidden = true;
  drawInboxState();
  try {
    const inbox = await invoke("inbox");
    if (seq !== loadSeq) return;
    failed = Object.keys(inbox.failed).length > 0;
    loadFailure = failed ? Object.entries(inbox.failed).map(([a, m]) => `${a}: ${m}`).join("、") : null;
    inboxLoaded = true;
    renderAccounts(inbox);
    if (inbox.accounts.length === 0) return show("login");
    historyIds.clear();
    for (const [account, id] of Object.entries(inbox.historyIds)) historyIds.set(account, id);
    drawThreads(inbox);
  } catch (e) {
    if (seq === loadSeq) {
      failed = true;
      loadFailure = String(e);
    }
  } finally {
    loading--;
    if (failed !== null) scheduleReload(failed);
    drawInboxState();
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
    // New mail (M-9) is told by a popup, which never changes the screen; a row being removed meanwhile has none.
    for (const t of r.threads) if (r.arrived.includes(t.id) && !pending.has(rowKey(t))) announceArrival(t);
  } else if (r.kind === "reloaded") {
    const keep = new Set(r.threads.map(rowKey));
    applyChanges(r.threads, [...rows.keys()].filter((k) => k.startsWith(`${account}/`) && !keep.has(k)));
  } else if (r.kind === "needsLogin") {
    // The detail view stays; the list shows the re-login row at the next load, which is now (hidden list: the next sync round).
    historyIds.delete(account);
    if (!$("threads").hidden) load();
    else nextReload = 0;
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
// A load that is due (a failed one, or one asked for by a sync that needs a login) comes first: it may leave no history IDs to sync from.
async function syncAll() {
  if (loading || document.hidden) return;
  if (nextReload !== null && Date.now() >= nextReload) return load(true);
  if (syncing || historyIds.size === 0) return;
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
  if (failure) {
    syncFails++;
    if (syncFails === 3) showInboxError(`自動同期に失敗しています: ${failure}`);
  } else {
    // The sync works again: the notice of the failures goes (only that one, not an error shown for something else).
    if (syncFails >= 3) clearInboxError();
    syncFails = 0;
  }
}

export function initInbox() {
  $("mail-mark-all").onclick = markAllRead;
  // Whether there are rows changes with every load, sync, removal and read toggle.
  const watch = new MutationObserver(drawInboxState);
  watch.observe($("unread-threads"), { childList: true });
  watch.observe($("read-threads"), { childList: true });
  drawInboxState();
  setInterval(syncAll, SYNC_MS);
  document.addEventListener("visibilitychange", syncAll);
  // Cmd+Z (Ctrl+Z off macOS) undoes the last removal; in a text field it stays that field's own undo.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey !== isMac || e.ctrlKey === isMac || e.altKey || e.shiftKey || e.key !== "z" || composing(e) || !lastRemoved) return;
    const a = document.activeElement;
    if ((a as HTMLElement | null)?.isContentEditable || a?.closest?.("input, textarea")) return;
    e.preventDefault();
    undoRemove();
  });
}
