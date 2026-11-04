// The divider between a screen's left part and its Claude pane (the Slack compose screen and the Slack thread): it sets the pane's width to between a third and a half of `main`.
// Each divider keeps its own ratio in memory, as a ratio so a resized window keeps it. The CSS (`.split-main`, `.split-chat`) holds the range too.
const MIN_RATIO = 1 / 3;
const MAX_RATIO = 1 / 2;
const KEY_STEP = 0.02;

// `main` is the element that holds the left part, the divider and the pane, `split` the divider.
export function initSplit(main: HTMLElement, split: HTMLElement) {
  let ratio = MIN_RATIO;

  function setRatio(next: number) {
    ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, next));
    main.style.setProperty("--chat-w", `${ratio * 100}%`);
    split.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  }

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
