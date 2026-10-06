import { ItemView, WorkspaceLeaf } from "obsidian";
import type ReminderToastPlugin from "../main";
import type { ToastOptions } from "./toast";
import type { ToastPosition } from "./types";

/**
 * Toasts in their own Obsidian pop-out window, so a reminder is visible on the
 * screen Obsidian is on while the main window is in the background. Built only
 * on documented APIs: `Workspace.openPopoutLeaf`, a registered view, and the
 * standard `Window` methods `moveTo` and `resizeTo`.
 */

export const VIEW_TYPE_TOAST_POPUP = "reminder-toast-popup";

const WIDTH = 400;
const GAP = 8;
const EDGE = 12;
const FIRST_GUESS_HEIGHT = 180;

/** Work area of a screen. Chromium reports it through availLeft and availTop. */
export interface ScreenArea {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

type ScreenWithOrigin = Screen & { availLeft?: number; availTop?: number };

export function screenAreaFor(win: Window): ScreenArea {
  const s: ScreenWithOrigin = win.screen;
  const x = s.availLeft ?? 0;
  const y = s.availTop ?? 0;
  return { key: `${x},${y},${s.availWidth},${s.availHeight}`, x, y, width: s.availWidth, height: s.availHeight };
}

export interface PopupRequest {
  opts: ToastOptions;
  /** Called when the toast is dismissed, times out, or an action runs. */
  onClosed: () => void;
  /** Called when the toast body is clicked. */
  onActivate: () => void;
  /** Called once the window exists and has been measured. */
  onMeasured: (win: Window, height: number) => void;
}

interface OpenPopup {
  leaf: WorkspaceLeaf | null;
  area: ScreenArea;
  position: ToastPosition;
  height: number;
  win: Window | null;
}

export class ToastPopupManager {
  private open: OpenPopup[] = [];
  private pending: PopupRequest | null = null;

  constructor(private plugin: ReminderToastPlugin) {}

  /** The request waiting for the view that is about to open. */
  take(): PopupRequest | null {
    const request = this.pending;
    this.pending = null;
    return request;
  }

  /** True when `win` belongs to one of these popups. */
  isPopupWindow(win: Window): boolean {
    return this.open.some((p) => p.leaf?.view.containerEl.win === win);
  }

  /**
   * Show the toast in one pop-out window per screen. Returns a function that
   * closes them all.
   */
  show(
    opts: ToastOptions,
    areas: ScreenArea[],
    onAction: (activated: boolean) => void,
    onClosed: () => void
  ): () => void {
    const mine: OpenPopup[] = [];
    let closed = false;
    const closeMine = () => {
      if (closed) return;
      closed = true;
      for (const p of mine) this.close(p);
    };

    for (const area of areas) {
      const popup: OpenPopup = { leaf: null, area, position: opts.position, height: FIRST_GUESS_HEIGHT, win: null };
      mine.push(popup);
      void this.openOne(popup, {
        opts,
        onClosed: () => {
          closeMine();
          onClosed();
        },
        onActivate: () => {
          closeMine();
          onAction(true);
        },
        onMeasured: (win, height) => {
          // Never adopt the main window: a closed popout's `containerEl.win` falls back to it.
          if (win === window || win.closed || !this.open.includes(popup)) return;
          popup.win = win;
          popup.height = height;
          this.restack(popup.area, popup.position);
        },
      });
    }
    return closeMine;
  }

  closeAll(): void {
    for (const p of [...this.open]) this.close(p);
  }

  private async openOne(popup: OpenPopup, request: PopupRequest): Promise<void> {
    const { x, y } = this.originFor(popup.area, popup.position, this.stackOffset(popup.area, popup.position), popup.height);
    const leaf = this.plugin.app.workspace.openPopoutLeaf({ x, y, size: { width: WIDTH, height: popup.height } });
    popup.leaf = leaf;
    this.open.push(popup);
    this.pending = request;
    await leaf.setViewState({ type: VIEW_TYPE_TOAST_POPUP, active: false });
    this.pending = null;
  }

  private close(popup: OpenPopup): void {
    this.open = this.open.filter((p) => p !== popup);
    popup.leaf?.detach();
    this.restack(popup.area, popup.position);
  }

  private stackOffset(area: ScreenArea, position: ToastPosition): number {
    return this.open
      .filter((p) => p.area.key === area.key && p.position === position)
      .reduce((sum, p) => sum + p.height + GAP, 0);
  }

  private originFor(area: ScreenArea, position: ToastPosition, offset: number, height: number): { x: number; y: number } {
    const x = position.endsWith("left")
      ? area.x + EDGE
      : position.endsWith("center")
        ? area.x + Math.round((area.width - WIDTH) / 2)
        : area.x + area.width - WIDTH - EDGE;
    const y = position.startsWith("top") ? area.y + EDGE + offset : area.y + area.height - EDGE - offset - height;
    return { x, y };
  }

  /** Stack the popups on one screen so they don't overlap. */
  private restack(area: ScreenArea, position: ToastPosition): void {
    let offset = 0;
    for (const p of this.open) {
      if (p.area.key !== area.key || p.position !== position || !p.win) continue;
      if (p.win === window || p.win.closed) continue;
      const { x, y } = this.originFor(area, position, offset, p.height);
      p.win.moveTo(x, y);
      // The window frame adds to the toast's own height.
      p.win.resizeTo(WIDTH, p.height + (p.win.outerHeight - p.win.innerHeight));
      offset += p.height + GAP;
    }
  }
}

/** The pop-out window's only view: a single toast card. */
export class ToastPopupView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ReminderToastPlugin,
    private request: PopupRequest | null
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TOAST_POPUP;
  }

  getDisplayText(): string {
    return "Reminder";
  }

  getIcon(): string {
    return "bell-ring";
  }

  async onOpen(): Promise<void> {
    const request = this.request;
    // A window restored from a previous session has no toast to show.
    if (!request) {
      this.leaf.detach();
      return;
    }

    const doc = this.containerEl.doc;
    const win = this.containerEl.win;
    // Not in a real pop-out window: show nothing rather than touch the main window.
    if (win === window) {
      this.leaf.detach();
      return;
    }
    doc.body.addClass("rt-popup-window");
    this.contentEl.addClass("rt-popup-content");

    const opts: ToastOptions = { ...request.opts, position: "top-left" };
    this.plugin.toasts.show(opts, doc, request.onClosed);

    const card = doc.body.querySelector<HTMLElement>(".rt-toast");
    card?.addEventListener("click", (e) => {
      if (!(e.target instanceof Element) || e.target.closest("button")) return;
      request.onActivate();
    });

    const measure = () => {
      if (win.closed) return;
      const container = doc.body.querySelector<HTMLElement>(".rt-toast-container");
      if (!container) return;
      const height = Math.min(Math.ceil(container.getBoundingClientRect().height) + EDGE * 2, 600);
      request.onMeasured(win, height);
    };
    win.setTimeout(measure, 60);
  }

  async onClose(): Promise<void> {
    this.containerEl.doc.body.removeClass("rt-popup-window");
    this.contentEl.empty();
  }
}
