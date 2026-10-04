import type { Reminder, ReminderSettings } from "./types";

/** Preset swatches offered in the reminder dialog and for new tags. */
export const PALETTE: Array<[string, string]> = [
  ["Red", "#e5484d"],
  ["Orange", "#f76b15"],
  ["Yellow", "#e2a336"],
  ["Green", "#46a758"],
  ["Teal", "#12a594"],
  ["Blue", "#0090ff"],
  ["Purple", "#8e4ec6"],
  ["Pink", "#d6409f"],
];

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

/** Split "work, #health home" into ["work", "health", "home"]. */
export function parseTagInput(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,\s]+/)) {
    const t = normalizeTag(part);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function tagColor(tag: string, settings: ReminderSettings): string {
  const def = settings.tags.find((t) => t.name.toLowerCase() === tag.toLowerCase());
  return def?.color ?? "";
}

/**
 * The color a reminder shows in. Order: its own color, its first colored tag,
 * then (when allowed) an automatic color from its title, so every occurrence of
 * a repeating reminder and reminders with the same title share a color.
 */
export function reminderColor(r: Reminder, settings: ReminderSettings, allowAuto = true): string {
  if (r.color) return r.color;
  for (const tag of r.tags ?? []) {
    const c = tagColor(tag, settings);
    if (c) return c;
  }
  if (allowAuto && settings.autoColor) return autoColor(r.title);
  return "";
}

export function autoColor(seed: string): string {
  return PALETTE[hash(seed.trim().toLowerCase()) % PALETTE.length][1];
}

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
