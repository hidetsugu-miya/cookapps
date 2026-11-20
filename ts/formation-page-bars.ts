// The two bars of a decision page (A-41, #1158). The top bar shows the page's label in full and links to its sections, marking the one that is being read. The bottom bar shows how many of the required and the optional answers are in, the share answered, 「次の未回答へ」 and 「TOP へ戻る」, and holds the button that sends. What counts as an answer is read from the cards (`data-form`, `data-required`, `data-lettered`), and the bars follow the entered answers as they change.
import { tag } from "./dom.js";

// Opens every closed `details` around the element `id` of a page, and shows it: what a link to a section, and the address of the page with `#{id}`, do.
export function reveal(id: string) {
  const target = id === "" ? null : document.getElementById(id);
  if (target === null || target.closest("#formation-page .fp-shell") === null) return;
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  target.scrollIntoView({ block: "start" });
}
window.addEventListener("hashchange", () => reveal(decodeURIComponent(location.hash.slice(1))));

// Whether the card `card` holds an answer: a choice (`その他` only with its text), or, on a card whose choices are fixed, a note.
function answered(card: HTMLElement): boolean {
  const box = card.querySelector<HTMLElement>(".fp-answer");
  if (box === null) return false;
  const chosen = box.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value;
  const text = box.querySelector<HTMLTextAreaElement>(`textarea[data-for="${chosen ?? "note"}"]`)?.value.trim() ?? "";
  if (chosen !== undefined) return chosen !== "other" || text !== "";
  return card.dataset.lettered !== "true" && text !== "";
}

export interface Bars {
  top: HTMLElement;
  bottom: HTMLElement;
}

// `scroll` is what scrolls, `root` holds the sections and the cards, `send` is the button that sends with its error, and `toReply` goes where the answers are sent from when nothing is left to answer.
export function drawBars(scroll: HTMLElement, root: HTMLElement, label: string, send: HTMLElement, toReply: () => void): Bars {
  const top = tag("header", "fp-bar fp-bar-top");
  top.append(tag("span", "fp-context", label));
  const nav = tag("nav", "fp-nav");
  nav.setAttribute("aria-label", "節");
  const sections = [...root.querySelectorAll<HTMLElement>(":scope > .fp-section")].filter((s) => s.id !== "");
  const links = sections.map((section) => {
    const link = tag("a", "", section.querySelector(":scope > .fp-sec")?.textContent ?? "");
    link.href = `#${section.id}`;
    link.onclick = (e) => {
      e.preventDefault();
      if (location.hash === `#${section.id}`) reveal(section.id);
      else location.hash = section.id;
    };
    nav.append(link);
    return link;
  });
  if (links.length > 0) top.append(nav);
  // The section being read is the last one whose top has reached the top of the page.
  const mark = () => {
    // A page that is not in view has no place to read.
    if (scroll.getClientRects().length === 0) return;
    const line = scroll.getBoundingClientRect().top + 24;
    let at = 0;
    sections.forEach((section, i) => {
      if (section.getBoundingClientRect().top <= line) at = i;
    });
    links.forEach((link, i) => {
      if (i === at) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  };
  scroll.addEventListener("scroll", mark, { passive: true });
  // The page is drawn out of sight, and takes its place when its tab is shown.
  new ResizeObserver(mark).observe(scroll);

  const bottom = tag("footer", "fp-bar fp-bar-bottom");
  const forms = [...root.querySelectorAll<HTMLElement>(".fp-card[data-form]")];
  const required = forms.filter((c) => c.dataset.required === "true");
  const optional = forms.filter((c) => c.dataset.required !== "true");
  const requiredCount = tag("span", "fp-count fp-count-required");
  const optionalCount = tag("span", "fp-count fp-count-optional");
  const fill = tag("span", "fp-progress-fill");
  const progress = tag("div", "fp-progress");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "回答済みの割合");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", String(forms.length));
  progress.append(fill);
  const next = tag("button", "text-btn fp-next", "次の未回答へ");
  next.type = "button";
  const toTop = tag("button", "text-btn fp-to-top", "TOP へ戻る");
  toTop.type = "button";
  toTop.onclick = () => scroll.scrollTo({ top: 0 });
  // The first card still open, a required one before an optional one.
  const firstOpen = () => required.find((c) => !answered(c)) ?? optional.find((c) => !answered(c));
  next.onclick = () => {
    const card = firstOpen();
    if (card === undefined) return toReply();
    card.scrollIntoView({ block: "start" });
    card.focus({ preventScroll: true });
  };
  const update = () => {
    const done = (cards: HTMLElement[]) => cards.filter(answered).length;
    for (const card of forms) card.toggleAttribute("data-answered", answered(card));
    requiredCount.textContent = `必須 ${done(required)} / ${required.length} 件`;
    optionalCount.textContent = `任意 ${done(optional)} / ${optional.length} 件`;
    const all = done(required) + done(optional);
    fill.style.width = `${forms.length === 0 ? 0 : Math.round((all * 100) / forms.length)}%`;
    progress.setAttribute("aria-valuenow", String(all));
  };
  if (forms.length > 0) {
    if (required.length > 0) bottom.append(requiredCount);
    if (optional.length > 0) bottom.append(optionalCount);
    bottom.append(progress, next);
    root.addEventListener("change", update);
    root.addEventListener("input", update);
    update();
  }
  const actions = tag("div", "fp-bar-actions");
  actions.append(toTop, send);
  bottom.append(actions);
  return { top, bottom };
}
