/**
 * Lead-up notifications: extra toasts shown before a reminder is due.
 * Offsets are stored as minutes before the due time.
 *
 * Text form, used in notes and the reminders file as @before(...):
 *   @before(30m)   @before(1h, 15m)   @before(1h30m)   @before(1d)
 */

/** Largest allowed offset: one year. */
export const MAX_LEAD_MINUTES = 365 * 24 * 60;
export const MAX_LEADS = 10;

/** Parse one offset like "30m", "1h30m", "2 hours", "1d" or "45" (minutes). */
export function parseLeadOffset(text: string): number | null {
  let t = text.trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return n > 0 && n <= MAX_LEAD_MINUTES ? n : null;
  }
  t = t
    .replace(/\s+/g, "")
    .replace(/days?/g, "d")
    .replace(/(hours?|hrs?)/g, "h")
    .replace(/(minutes?|mins?)/g, "m");
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(t);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const total = parseInt(m[1] ?? "0", 10) * 1440 + parseInt(m[2] ?? "0", 10) * 60 + parseInt(m[3] ?? "0", 10);
  return total > 0 && total <= MAX_LEAD_MINUTES ? total : null;
}

/** Parse "1h, 30m". Returns null if any part can't be read. */
export function parseLeadText(text: string): number[] | null {
  const parts = text
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = parseLeadOffset(p);
    if (n === null) return null;
    out.push(n);
  }
  return normalizeLeads(out);
}

/** Dedupe, drop invalid values, sort longest first, cap the count. */
export function normalizeLeads(list: number[] | undefined): number[] {
  const clean = (list ?? []).filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_LEAD_MINUTES).map(Math.round);
  return [...new Set(clean)].sort((a, b) => b - a).slice(0, MAX_LEADS);
}

export function sameLeads(a: number[] | undefined, b: number[] | undefined): boolean {
  return normalizeLeads(a).join(",") === normalizeLeads(b).join(",");
}

/** Compact form for @before(...): 90 -> "1h30m", 1440 -> "1d". */
export function formatLeadOffset(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}`;
}

export function formatLeadText(list: number[] | undefined): string {
  return normalizeLeads(list).map(formatLeadOffset).join(", ");
}

/** Words for toasts: 90 -> "1 hour 30 minutes". */
export function describeLead(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** Short label for chips and lists: 90 -> "1 hr 30 min". */
export function shortLead(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} hr` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}
