// The divider between a screen's parts: the Claude pane of the Slack compose screen and the Slack thread (on the right, a third to a half of `main`),
// the list of the Orca screen (on the left, a fifth to a half), and the right side of the Todo screen (on the right, 30% to 45%). It sets that pane's width as a ratio of `main`, so a resized window keeps it.
// Each divider keeps its own ratio in memory. The CSS (`.split-chat`, `#orca-list`, `#todo-side`) holds the range too.
const KEY_STEP = 0.02;

export interface SplitOptions {
  // The side of `main` the pane is on. Dragging towards the other side widens it.
  side?: "left" | "right";
  min?: number;
  max?: number;
  // The ratio at the start; the minimum when left out.
  initial?: number;
  // The CSS property that carries the pane's width as a percentage.
  property?: string;
}

// `main` is the element that holds the pane, the divider and the rest, `split` the divider.
export function initSplit(main: HTMLElement, split: HTMLElement, { side = "right", min = 1 / 3, max = 1 / 2, initial = min, property = "--chat-w" }: SplitOptions = {}) {
  let ratio = initial;
  // How far the pane is from the edge of `main` it sits on, as a ratio of the box.
  const ratioAt = (box: DOMRect, x: number) => (side === "right" ? box.right - x : x - box.left) / box.width;

  function setRatio(next: number) {
    ratio = Math.min(max, Math.max(min, next));
    main.style.setProperty(property, `${ratio * 100}%`);
    split.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  }

  setRatio(ratio);
  // The divider is dragged with pointer events on the document, so the drag goes on when the pointer leaves it.
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
      pending = ratioAt(box, e.clientX);
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
    // The arrow that points away from the pane's edge widens it.
    const widen = e.key === (side === "right" ? "ArrowLeft" : "ArrowRight");
    setRatio(ratio + (widen ? KEY_STEP : -KEY_STEP));
  };
}
