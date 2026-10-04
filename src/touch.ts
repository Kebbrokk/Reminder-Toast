/**
 * Touch helpers. Phones and tablets have no right click, and iOS does not send
 * "contextmenu" for a long press, so long press is detected here with pointer events.
 */

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

export interface PressPoint {
  x: number;
  y: number;
}

/** Last time any menu was opened, so a long press and a native contextmenu don't both open one. */
let lastMenuAt = 0;

export function menuRecentlyOpened(): boolean {
  return Date.now() - lastMenuAt < 800;
}

export function markMenuOpened(): void {
  lastMenuAt = Date.now();
}

/**
 * Call `onMenu` on right click (desktop) or long press (touch).
 * Clicks right after a long press are swallowed so the item isn't also "tapped".
 */
export function onContextOrLongPress(el: HTMLElement, onMenu: (at: PressPoint, evt: Event) => void): void {
  let timer: number | null = null;
  let start: PressPoint | null = null;
  let suppressClick = false;

  const cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    start = null;
    window.removeEventListener("scroll", cancel, true);
  };

  // Pointer events cover touch and pen. The browser sends "pointercancel" when a
  // drag turns into scrolling, which cancels the press.
  el.addEventListener("pointerdown", (evt: PointerEvent) => {
    if (evt.pointerType === "mouse" || !evt.isPrimary) return;
    cancel();
    start = { x: evt.clientX, y: evt.clientY };
    window.addEventListener("scroll", cancel, true);
    timer = window.setTimeout(() => {
      const at = start;
      cancel();
      if (!at || menuRecentlyOpened()) return;
      // Swallow the click the release produces, but only briefly, so a later tap still works.
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 700);
      markMenuOpened();
      navigator.vibrate?.(15);
      onMenu(at, evt);
    }, LONG_PRESS_MS);
  });
  el.addEventListener("pointermove", (evt: PointerEvent) => {
    if (!start) return;
    if (Math.abs(evt.clientX - start.x) > MOVE_TOLERANCE || Math.abs(evt.clientY - start.y) > MOVE_TOLERANCE) cancel();
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);

  el.addEventListener(
    "click",
    (evt) => {
      if (!suppressClick) return;
      suppressClick = false;
      evt.preventDefault();
      evt.stopImmediatePropagation();
    },
    true
  );

  el.addEventListener("contextmenu", (evt: MouseEvent) => {
    evt.preventDefault();
    evt.stopPropagation();
    if (menuRecentlyOpened()) return;
    markMenuOpened();
    onMenu({ x: evt.clientX, y: evt.clientY }, evt);
  });
}
