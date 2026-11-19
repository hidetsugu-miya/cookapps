// The divider between a screen's parts: the Slack thread (on the right, a third to a half of `main`), the terminal column in Claude mode of the Slack compose screen (on the left, 35% to 60%),
// the list of the Orca screen (on the left, 15% to 50%), and the right side of the Todo screen (on the right, 30% to 45%). It sets that pane's width as a ratio of `main`, so a resized window keeps it.
// Each divider keeps its own ratio in memory. The CSS (`.split-chat`, `#slack-compose-claude`, `#orca-list`, `#todo-side`) holds the range too.
// A divider can also lie down (`lying`, `lie()`): the pane then sits under the rest (`side: "right"`) or over it (`side: "left"`), and the divider sets its height as a ratio of `main`, with a ratio, a range and a property of its own,
// so the Todo screen puts Claude under the tasks in a narrow window (T-7) and the Slack screen can do the same.
const KEY_STEP = 0.02;

// One way a divider sets its pane: the pane's share of `main` and what bounds it, and the CSS property that carries it.
interface Axis {
  min: number;
  max: number;
  ratio: number;
  property: string;
  format: (ratio: number) => string;
}

export interface SplitOptions {
  // The side of `main` the pane is on. Dragging towards the other side widens it. A lying divider has the pane at the bottom for "right" and at the top for "left".
  side?: "left" | "right";
  min?: number;
  max?: number;
  // The ratio at the start; the minimum when left out.
  initial?: number;
  // The CSS property that carries the pane's width as a percentage.
  property?: string;
  // The divider lying down: the pane's height as a ratio of `main`. Left out: the range 0.3 to 0.45, the minimum as the start and the property `--chat-h`. The property carries the plain ratio (not a percentage), which the CSS uses as a flex-grow, so no height has to be known.
  lying?: { min?: number; max?: number; initial?: number; property?: string };
}

export interface SplitHandle {
  // Lays the divider down (true) or stands it up (false). The pane keeps the ratio of each way, so the way back finds the ratio where it was.
  lie: (on: boolean) => void;
}

// `main` is the element that holds the pane, the divider and the rest, `split` the divider.
export function initSplit(main: HTMLElement, split: HTMLElement, { side = "right", min = 1 / 3, max = 1 / 2, initial = min, property = "--chat-w", lying }: SplitOptions = {}): SplitHandle {
  const standing: Axis = { min, max, ratio: initial, property, format: (r) => `${r * 100}%` };
  const lyingMin = lying?.min ?? 0.3;
  const flat: Axis | null = lying ? { min: lyingMin, max: lying.max ?? 0.45, ratio: lying.initial ?? lyingMin, property: lying.property ?? "--chat-h", format: String } : null;
  let axis = standing;
  let vertical = false;
  // How far the pane is from the edge of `main` it sits on, as a ratio of the box.
  const ratioAt = (box: DOMRect, x: number, y: number) => {
    if (vertical) return (side === "right" ? box.bottom - y : y - box.top) / box.height;
    return (side === "right" ? box.right - x : x - box.left) / box.width;
  };

  function setRatio(next: number) {
    axis.ratio = Math.min(axis.max, Math.max(axis.min, next));
    main.style.setProperty(axis.property, axis.format(axis.ratio));
    split.setAttribute("aria-valuenow", String(Math.round(axis.ratio * 100)));
  }

  setRatio(axis.ratio);
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
      pending = ratioAt(box, e.clientX, e.clientY);
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
    // The arrow that points away from the pane's edge widens it.
    const [widen, narrow] = vertical ? (side === "right" ? ["ArrowUp", "ArrowDown"] : ["ArrowDown", "ArrowUp"]) : side === "right" ? ["ArrowLeft", "ArrowRight"] : ["ArrowRight", "ArrowLeft"];
    if (e.key !== widen && e.key !== narrow) return;
    e.preventDefault();
    setRatio(axis.ratio + (e.key === widen ? KEY_STEP : -KEY_STEP));
  };
  return {
    lie(on) {
      if (!flat || on === vertical) return;
      vertical = on;
      axis = on ? flat : standing;
      split.setAttribute("aria-orientation", on ? "horizontal" : "vertical");
      split.setAttribute("aria-valuemin", String(Math.round(axis.min * 100)));
      split.setAttribute("aria-valuemax", String(Math.round(axis.max * 100)));
      setRatio(axis.ratio);
    },
  };
}
