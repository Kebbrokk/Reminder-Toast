import { moment } from "./moment";

/**
 * Repeating reminders. A rule is anchored at `start` (the first occurrence),
 * and every occurrence is computed from that anchor, so monthly reminders on
 * the 31st do not drift to the 28th after February.
 *
 * Text form, used in notes and the reminders file as @repeat(...):
 *   daily | weekdays | weekly | monthly | yearly
 *   every 2 days | every 3 weeks | every 6 months | every 2 years
 *   weekly on mon, wed, fri | every 2 weeks on tue
 *   ... until 2026-12-31
 */

export type RepeatFreq = "daily" | "weekly" | "monthly" | "yearly";

export interface RepeatRule {
  freq: RepeatFreq;
  interval: number;
  /** For weekly rules: days of the week, 0 = Sunday. Empty means the anchor's weekday. */
  weekdays: number[];
  /** First occurrence, epoch ms. Its time of day is used for every occurrence. */
  start: number;
  /** Last day the series can occur on, epoch ms (any time that day), or null for never. */
  until: number | null;
}

const UNIT: Record<RepeatFreq, "days" | "weeks" | "months" | "years"> = {
  daily: "days",
  weekly: "weeks",
  monthly: "months",
  yearly: "years",
};
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_STEPS = 20000;

function endLimit(rule: RepeatRule): number {
  return rule.until === null ? Infinity : moment(rule.until).endOf("day").valueOf();
}

/** Occurrences between from and to (inclusive), in order, at most `limit`. */
export function occurrencesBetween(rule: RepeatRule, from: number, to: number, limit = 500): number[] {
  const out: number[] = [];
  const end = Math.min(to, endLimit(rule));
  const interval = Math.max(1, Math.floor(rule.interval) || 1);
  if (end < rule.start || from > end) return out;

  const start = moment(rule.start);

  if (rule.freq === "weekly" && rule.weekdays.length) {
    const days = [...new Set(rule.weekdays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
    const week0 = start.clone().startOf("day").subtract(start.day(), "days");
    let w = 0;
    if (from > rule.start) {
      w = Math.max(0, Math.floor(moment(from).diff(week0, "weeks") / interval) - 1);
    }
    for (let steps = 0; steps < MAX_STEPS; steps++, w++) {
      const weekStart = week0.clone().add(w * interval, "weeks");
      if (weekStart.valueOf() > end) break;
      for (const d of days) {
        const t = weekStart
          .clone()
          .add(d, "days")
          .hour(start.hour())
          .minute(start.minute())
          .second(0)
          .millisecond(0)
          .valueOf();
        if (t < rule.start || t < from) continue;
        if (t > end) return out;
        out.push(t);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  const unit = UNIT[rule.freq];
  let k = 0;
  if (from > rule.start) {
    k = Math.max(0, Math.floor(moment(from).diff(start, unit) / interval) - 1);
  }
  for (let steps = 0; steps < MAX_STEPS; steps++, k++) {
    const t = start.clone().add(k * interval, unit).valueOf();
    if (t > end) break;
    if (t >= from) {
      out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The first occurrence strictly after `after`, or null when the series has ended. */
export function nextAfter(rule: RepeatRule, after: number): number | null {
  return occurrencesBetween(rule, after + 1, Infinity, 1)[0] ?? null;
}

export function isOccurrence(rule: RepeatRule, t: number): boolean {
  return occurrencesBetween(rule, t, t, 1).length === 1;
}

// ---------- Text form ----------

export function parseRepeat(raw: string, start: number): RepeatRule | null {
  let s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;

  let until: number | null = null;
  const um = /\s*\b(?:until|till)\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(s);
  if (um) {
    const m = moment(um[1], "YYYY-MM-DD", true);
    if (!m.isValid()) return null;
    until = m.valueOf();
    s = s.slice(0, um.index).trim();
  }

  let weekdays: number[] = [];
  const on = /\s+on\s+(.+)$/.exec(s);
  if (on) {
    const days = parseDays(on[1]);
    if (!days) return null;
    weekdays = days;
    s = s.slice(0, on.index).trim();
  }

  let freq: RepeatFreq;
  let interval = 1;
  if (s === "daily" || s === "every day") freq = "daily";
  else if (s === "weekdays" || s === "every weekday") {
    freq = "weekly";
    weekdays = [1, 2, 3, 4, 5];
  } else if (s === "weekly" || s === "every week") freq = "weekly";
  else if (s === "monthly" || s === "every month") freq = "monthly";
  else if (s === "yearly" || s === "annually" || s === "every year") freq = "yearly";
  else {
    const m = /^every (\d+) (day|week|month|year)s?$/.exec(s);
    if (!m) return null;
    interval = parseInt(m[1], 10);
    freq = ({ day: "daily", week: "weekly", month: "monthly", year: "yearly" } as const)[
      m[2] as "day" | "week" | "month" | "year"
    ];
  }

  if (weekdays.length && freq !== "weekly") return null;
  if (interval < 1 || interval > 999) return null;
  return { freq, interval, weekdays, start, until };
}

function parseDays(text: string): number[] | null {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== "and");
  const days: number[] = [];
  for (const p of parts) {
    const idx = DAY_NAMES.indexOf(p.slice(0, 3));
    if (idx < 0) return null;
    days.push(idx);
  }
  return days.length ? [...new Set(days)].sort((a, b) => a - b) : null;
}

function isWeekdaysPreset(rule: RepeatRule): boolean {
  return (
    rule.freq === "weekly" &&
    rule.interval === 1 &&
    [...rule.weekdays].sort().join(",") === "1,2,3,4,5"
  );
}

/** Canonical text form, e.g. "every 2 weeks on mon, wed until 2026-12-31". */
export function formatRepeat(rule: RepeatRule): string {
  let text: string;
  if (isWeekdaysPreset(rule)) text = "weekdays";
  else {
    text =
      rule.interval === 1
        ? rule.freq
        : `every ${rule.interval} ${UNIT[rule.freq]}`;
    if (rule.freq === "weekly" && rule.weekdays.length) {
      text += ` on ${[...rule.weekdays].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(", ")}`;
    }
  }
  if (rule.until !== null) text += ` until ${moment(rule.until).format("YYYY-MM-DD")}`;
  return text;
}

/** Human description, e.g. "Every 2 weeks on Mon, Wed, until Dec 31, 2026". */
export function describeRepeat(rule: RepeatRule): string {
  const cap = (d: number) => DAY_NAMES[d][0].toUpperCase() + DAY_NAMES[d].slice(1);
  let text: string;
  if (isWeekdaysPreset(rule)) text = "Every weekday";
  else {
    const unitWord = UNIT[rule.freq].slice(0, -1);
    text = rule.interval === 1 ? `Every ${unitWord}` : `Every ${rule.interval} ${UNIT[rule.freq]}`;
    if (rule.freq === "weekly" && rule.weekdays.length) {
      text += ` on ${[...rule.weekdays].sort((a, b) => a - b).map(cap).join(", ")}`;
    }
    if (rule.freq === "monthly") text += ` on the ${moment(rule.start).format("Do")}`;
    if (rule.freq === "yearly") text += ` on ${moment(rule.start).format("MMM D")}`;
  }
  if (rule.until !== null) text += `, until ${moment(rule.until).format("MMM D, YYYY")}`;
  return text;
}

export function sameRule(a: RepeatRule | null | undefined, b: RepeatRule | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return formatRepeat(a) === formatRepeat(b);
}
