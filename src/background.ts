import { App, FuzzySuggestModal, TFile, normalizePath } from "obsidian";
import type { BackgroundSettings, BgFit } from "./types";

/** Image formats Obsidian can display. GIFs animate. */
export const IMAGE_EXTENSIONS = ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"];

export const BG_FITS: Record<BgFit, string> = {
  cover: "Fill (crop to fit)",
  contain: "Fit (show whole image)",
  tile: "Tile",
  stretch: "Stretch",
};

export const BG_POSITIONS: Record<string, string> = {
  center: "Center",
  top: "Top",
  bottom: "Bottom",
  left: "Left",
  right: "Right",
};

export function isImageFile(file: TFile): boolean {
  return IMAGE_EXTENSIONS.includes(file.extension.toLowerCase());
}

export function imageFiles(app: App): TFile[] {
  return app.vault
    .getFiles()
    .filter(isImageFile)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Turn what the user typed into an image URL. Accepts a vault path
 * ("Attachments/sky.gif"), a link ("[[sky.gif]]" or "![[sky.gif]]"),
 * a markdown image ("![](sky.gif)") or a web address.
 */
export function resolveImage(app: App, raw: string, sourcePath = ""): { url: string; file?: TFile } | null {
  let text = (raw ?? "").trim();
  if (!text) return null;

  const wiki = /^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(text);
  const md = /^!?\[[^\]]*\]\(<?([^)>]+)>?\)$/.exec(text);
  if (wiki) text = wiki[1].trim();
  else if (md) text = md[1].trim();

  if (/^(https?:|app:|data:image\/)/i.test(text)) return { url: text };

  try {
    text = decodeURIComponent(text);
  } catch {
    // Not URL-encoded; use as typed.
  }

  const byLink = app.metadataCache.getFirstLinkpathDest(text, sourcePath);
  const byPath = app.vault.getAbstractFileByPath(normalizePath(text));
  const file = byLink ?? (byPath instanceof TFile ? byPath : null);
  if (!file || !isImageFile(file)) return null;
  return { url: app.vault.getResourcePath(file), file };
}

/** CSS variables that describe a background. The styling itself lives in styles.css (.rt-has-bg). */
export function backgroundVars(url: string, cfg: BackgroundSettings): Record<string, string> {
  const dim = Math.max(0, Math.min(95, Math.round(cfg.dim)));
  const safeUrl = url.replace(/["\\]/g, (c) => `\\${c}`);
  return {
    "--rt-bg-url": `url("${safeUrl}")`,
    "--rt-bg-dim": `${dim}%`,
    "--rt-bg-size": cfg.fit === "tile" ? "auto" : cfg.fit === "stretch" ? "100% 100%" : cfg.fit,
    "--rt-bg-repeat": cfg.fit === "tile" ? "repeat" : "no-repeat",
    "--rt-bg-position": cfg.position || "center",
  };
}

const BG_VARS = ["--rt-bg-url", "--rt-bg-dim", "--rt-bg-size", "--rt-bg-repeat", "--rt-bg-position"];

/**
 * Show an image behind an element, with a dimming layer in the theme's
 * background color so text stays readable. Only CSS variables change on
 * re-render, and only when the image or settings change, so a GIF keeps playing.
 */
export function applyBackground(el: HTMLElement, url: string | null, cfg: BackgroundSettings): void {
  const key = url ? JSON.stringify([url, cfg.fit, cfg.position, cfg.dim]) : "";
  if (el.dataset.rtBg === key) return;
  el.dataset.rtBg = key;

  if (!url) {
    el.removeClass("rt-has-bg");
    for (const v of BG_VARS) el.style.removeProperty(v);
    return;
  }
  el.addClass("rt-has-bg");
  el.setCssProps(backgroundVars(url, cfg));
}

/** Pick an image from the vault. Easier than typing a path, especially on phones. */
export class ImagePickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (file: TFile) => unknown) {
    super(app);
    this.setPlaceholder("Pick an image file");
  }

  getItems(): TFile[] {
    return imageFiles(this.app);
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}
