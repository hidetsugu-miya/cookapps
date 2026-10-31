// Which part of the window is shown, the error line, and the counts on the sidebar buttons.
import { $ } from "./dom.js";

export type View = "list" | "thread" | "login" | "calendar" | "todo" | "settings";

// #main scrolls both the list and the thread, so each view keeps its own position.
let listScroll = 0;

export function show(view: View) {
  if (!$("threads").hidden) listScroll = $("main").scrollTop;
  // The calendar and Todo screens bring their own header.
  const own = view === "calendar" || view === "todo" || view === "settings";
  $("calendar").hidden = view !== "calendar";
  $("todo").hidden = view !== "todo";
  $("settings").hidden = view !== "settings";
  $("mail-header").hidden = own;
  $("main").hidden = own;
  $("login").hidden = view !== "login";
  $("relogin").hidden = view !== "list" || !$("relogin").hasChildNodes();
  $("threads").hidden = view !== "list";
  $("reload").hidden = view !== "list";
  $("thread").hidden = view !== "thread";
  $("back").hidden = view !== "thread";
  $("thread-slack").hidden = view !== "thread";
  $("thread-todo").hidden = view !== "thread";
  $("trash").hidden = view !== "thread";
  $("archive").hidden = view !== "thread";
  $("mail-header").classList.toggle("detail", view === "thread");
  $("title").hidden = view === "thread";
  $("main").scrollTop = view === "list" ? listScroll : 0;
}

export function showError(e: unknown) {
  $("error").textContent = String(e);
  $("error").hidden = false;
}

// The count on a sidebar button (99+ from 100; none for 0). The label carries it too: the tooltip shows the label, e.g. "受信トレイ（未読 3 件）".
export function setNavCount(id: string, count: number, name: string, kind: string) {
  const b = $(id);
  const badge = b.querySelector<HTMLElement>(".nav-count")!;
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : String(count);
  b.setAttribute("aria-label", count === 0 ? name : `${name}（${kind} ${count} 件）`);
}
