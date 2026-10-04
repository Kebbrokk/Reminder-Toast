import { setIcon } from "obsidian";
import type { ToastPosition } from "./types";

export interface ToastAction {
  label: string;
  icon?: string;
  cta?: boolean;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  body: string;
  durationSec: number;
  flash: boolean;
  position: ToastPosition;
  accentColor: string;
  actions: ToastAction[];
  /** Header icon. Defaults to a ringing bell. */
  icon?: string;
  /** Extra class on the toast, e.g. for lead-up styling. */
  cls?: string;
}

const CONTAINER_CLASS = "rt-toast-container";

/** Shows stacked, flashing toast cards in a corner of a window (the main window or a popout). */
export class ToastManager {
  private containers = new Map<Document, Map<ToastPosition, HTMLElement>>();

  show(opts: ToastOptions, doc: Document = document, onClose?: () => void): () => void {
    const container = this.getContainer(opts.position, doc);

    const toast = container.createDiv({ cls: "rt-toast" });
    if (opts.flash) toast.addClass("rt-toast-flash");
    if (opts.cls) toast.addClass(opts.cls);
    if (opts.accentColor) toast.style.setProperty("--rt-accent", opts.accentColor);
    toast.setAttr("role", "alert");

    const header = toast.createDiv({ cls: "rt-toast-header" });
    const iconEl = header.createSpan({ cls: "rt-toast-icon" });
    setIcon(iconEl, opts.icon ?? "bell-ring");
    header.createSpan({ cls: "rt-toast-title", text: opts.title });
    const closeBtn = header.createEl("button", {
      cls: "rt-toast-close clickable-icon",
      attr: { "aria-label": "Dismiss" },
    });
    setIcon(closeBtn, "x");

    if (opts.body.trim()) {
      const body = toast.createDiv({ cls: "rt-toast-body" });
      // Keep line breaks the user typed.
      opts.body.split("\n").forEach((line, i) => {
        if (i > 0) body.createEl("br");
        body.appendText(line);
      });
    }

    let closed = false;
    let timer: number | null = null;
    const close = () => {
      if (closed) return;
      closed = true;
      onClose?.();
      if (timer !== null) window.clearTimeout(timer);
      toast.addClass("rt-toast-leaving");
      window.setTimeout(() => {
        toast.remove();
        if (!container.hasChildNodes()) {
          container.remove();
          this.containers.get(doc)?.delete(opts.position);
        }
      }, 200);
    };

    closeBtn.addEventListener("click", close);

    if (opts.actions.length) {
      const bar = toast.createDiv({ cls: "rt-toast-actions" });
      for (const action of opts.actions) {
        const btn = bar.createEl("button", { text: action.label });
        if (action.cta) btn.addClass("mod-cta");
        btn.addEventListener("click", () => {
          action.onClick();
          close();
        });
      }
    }

    // Hovering stops the flash so the toast is easier to read.
    toast.addEventListener("mouseenter", () => toast.removeClass("rt-toast-flash"));
    // Touch screens have no hover: a tap stops the flash.
    toast.addEventListener("touchstart", () => toast.removeClass("rt-toast-flash"), { passive: true });

    if (opts.durationSec > 0) {
      timer = window.setTimeout(close, opts.durationSec * 1000);
    }

    return close;
  }

  destroy(): void {
    this.containers.forEach((byPos) => byPos.forEach((c) => c.remove()));
    this.containers.clear();
  }

  /** Forget a popout window's toasts when it closes. */
  forgetDocument(doc: Document): void {
    this.containers.get(doc)?.forEach((c) => c.remove());
    this.containers.delete(doc);
  }

  private getContainer(position: ToastPosition, doc: Document): HTMLElement {
    let byPos = this.containers.get(doc);
    if (!byPos) {
      byPos = new Map();
      this.containers.set(doc, byPos);
    }
    let c = byPos.get(position);
    if (!c || !c.isConnected) {
      c = doc.body.createDiv({ cls: [CONTAINER_CLASS, `rt-pos-${position}`] });
      byPos.set(position, c);
    }
    return c;
  }
}

/** A short two-tone chime using Web Audio, so no sound file is needed. */
export function playChime(): void {
  try {
    const Ctx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tones = [880, 1320];
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
    window.setTimeout(() => void ctx.close(), 1000);
  } catch {
    // No sound output available; the toast still shows.
  }
}

export async function showSystemNotification(title: string, body: string): Promise<void> {
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch (e) {
    console.error("Reminder Toast: system notification failed", e);
  }
}
