import { moment } from "./moment";

/**
 * Inline reminders are task lines in any note, for example:
 *
 *   - [ ] Call the dentist @remind(2026-10-02 09:00)
 *   - [x] Pay rent @remind(2026-10-01)
 *
 * The title is the task text with the @remind(...) marker removed.
 * Checking the box marks the reminder done.
 *
 * Optional: @repeat(weekly) makes it repeat, and #tags color it.
 */

export const INLINE_DATE_FORMAT = "YYYY-MM-DD HH:mm";

const ACCEPTED_FORMATS = [
  "YYYY-MM-DD HH:mm",
  "YYYY-MM-DD H:mm",
  "YYYY-MM-DD h:mm A",
  "YYYY-MM-DD h:mmA",
  "YYYY-MM-DD h:mm a",
  "YYYY-MM-DD h:mma",
  "YYYY-MM-DD hA",
  "YYYY-MM-DD ha",
  "YYYY-MM-DDTHH:mm",
];

/** Time used when only a date is given, e.g. @remind(2026-10-02). */
const DATE_ONLY_HOUR = 9;

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s+)(.*)$/;
const MARKER_RE = /@remind\(([^)]*)\)/i;
const REPEAT_RE = /\s*@repeat\(([^)]*)\)/i;
const BEFORE_RE = /\s*@before\(([^)]*)\)/i;
const TAG_RE = /(^|\s)(#[^\s#]+)/g;

export interface ParsedInline {
  id: string;
  title: string;
  due: number;
  completed: boolean;
  line: number;
  tags: string[];
  /** Text inside @repeat(...), or null. */
  repeatText: string | null;
  /** Text inside @before(...), or null. */
  beforeText: string | null;
}

/** Quick check so we can skip files without reading every line. */
export function mightContainInline(content: string): boolean {
  return /@remind\(/i.test(content);
}

export function parseInlineDate(raw: string): number | null {
  const text = raw.trim();
  let m = moment(text, ACCEPTED_FORMATS, true);
  if (m.isValid()) return m.valueOf();
  m = moment(text, "YYYY-MM-DD", true);
  if (m.isValid()) return m.hour(DATE_ONLY_HOUR).minute(0).valueOf();
  return null;
}

export function formatInlineDate(due: number): string {
  return moment(due).format(INLINE_DATE_FORMAT);
}

/** Build a fresh task line for a reminder. */
export function buildInlineLine(
  title: string,
  due: number,
  indent = "",
  repeatText: string | null = null,
  tags: string[] = [],
  beforeText: string | null = null
): string {
  const parts = [title.trim(), `@remind(${formatInlineDate(due)})`];
  if (repeatText) parts.push(`@repeat(${repeatText})`);
  if (beforeText) parts.push(`@before(${beforeText})`);
  for (const t of tags) parts.push(`#${t}`);
  return `${indent}- [ ] ${parts.join(" ")}`;
}

/** Parse every inline reminder in a note. */
export function parseInline(path: string, content: string): ParsedInline[] {
  const out: ParsedInline[] = [];
  if (!mightContainInline(content)) return out;

  const seen = new Map<string, number>();
  const lines = content.split("\n");
  let inCodeBlock = false;

  lines.forEach((text, lineNo) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) return;

    const task = TASK_RE.exec(text);
    if (!task) return;
    const marker = MARKER_RE.exec(task[4]);
    if (!marker) return;

    const due = parseInlineDate(marker[1]);
    if (due === null) return;

    const title = titleOf(task[4]);
    const key = `${path}\n${title.toLowerCase()}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);

    out.push({
      id: inlineId(path, title, count),
      title,
      due,
      completed: task[2] !== " ",
      line: lineNo,
      tags: tagsOf(task[4]).map((t) => t.slice(1)),
      repeatText: REPEAT_RE.exec(task[4])?.[1].trim() || null,
      beforeText: BEFORE_RE.exec(task[4])?.[1].trim() || null,
    });
  });

  return out;
}

/** Stable id from note path and title, so the message and toast text you add survive time changes. */
export function inlineId(path: string, title: string, occurrence = 0): string {
  const base = `inline-${hash(`${path}\n${title.toLowerCase()}`)}`;
  return occurrence ? `${base}-${occurrence}` : base;
}

export interface LineChanges {
  title?: string;
  due?: number;
  completed?: boolean;
  /** New @repeat text, or null to remove it. */
  repeat?: string | null;
  /** New set of #tags (without #). */
  tags?: string[];
  /** New @before text, or null to remove it. */
  before?: string | null;
}

/** Apply changes to a single task line, keeping indentation, bullet style and any extra text. */
export function rewriteInlineLine(text: string, changes: LineChanges): string {
  const task = TASK_RE.exec(text);
  if (!task) return text;
  let [, prefix, mark, middle, rest] = task;

  if (changes.completed !== undefined) mark = changes.completed ? "x" : " ";

  if (changes.title !== undefined && titleOf(rest) !== cleanTitle(changes.title)) {
    // Replace the words but keep the marker and any #tags.
    const marker = MARKER_RE.exec(rest);
    const repeat = REPEAT_RE.exec(rest);
    const before = BEFORE_RE.exec(rest);
    const tags = tagsOf(rest);
    rest = [
      cleanTitle(changes.title),
      marker ? marker[0] : "",
      repeat ? repeat[0].trim() : "",
      before ? before[0].trim() : "",
      ...tags,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (changes.due !== undefined) {
    const stamp = `@remind(${formatInlineDate(changes.due)})`;
    rest = MARKER_RE.test(rest) ? rest.replace(MARKER_RE, stamp) : `${rest} ${stamp}`;
  }

  if (changes.tags !== undefined) {
    const current = tagsOf(rest).map((t) => t.slice(1));
    if (current.join(" ").toLowerCase() !== changes.tags.join(" ").toLowerCase()) {
      // Tags inside the title stay where they are only when kept; removed ones are dropped.
      const keep = new Set(changes.tags.map((t) => t.toLowerCase()));
      rest = rest.replace(TAG_RE, (m, sp: string, tag: string) => (keep.has(tag.slice(1).toLowerCase()) ? m : sp));
      const present = new Set(tagsOf(rest).map((t) => t.slice(1).toLowerCase()));
      const add = changes.tags.filter((t) => !present.has(t.toLowerCase()));
      rest = [rest.replace(/\s+$/, ""), ...add.map((t) => `#${t}`)].join(" ").replace(/\s{2,}/g, " ");
    }
  }

  if (changes.repeat !== undefined) {
    const current = REPEAT_RE.exec(rest)?.[1].trim() ?? null;
    if (current !== changes.repeat) {
      if (changes.repeat === null) rest = rest.replace(REPEAT_RE, "");
      else if (current !== null) rest = rest.replace(REPEAT_RE, ` @repeat(${changes.repeat})`);
      else rest = rest.replace(MARKER_RE, (m) => `${m} @repeat(${changes.repeat})`);
    }
  }

  if (changes.before !== undefined) {
    const current = BEFORE_RE.exec(rest)?.[1].trim() ?? null;
    if (current !== changes.before) {
      if (changes.before === null) rest = rest.replace(BEFORE_RE, "");
      else if (current !== null) rest = rest.replace(BEFORE_RE, ` @before(${changes.before})`);
      else {
        // Place it after @repeat(...) when there is one, otherwise after @remind(...).
        const anchor = REPEAT_RE.test(rest) ? REPEAT_RE : MARKER_RE;
        rest = rest.replace(anchor, (m) => `${m} @before(${changes.before})`);
      }
    }
  }

  return `${prefix}${mark}${middle}${rest}`;
}

/** Task text without the @remind marker or #tags. */
function titleOf(rest: string): string {
  const withoutMarker = rest.replace(MARKER_RE, " ").replace(REPEAT_RE, " ").replace(BEFORE_RE, " ");
  const stripped = cleanTitle(withoutMarker.replace(TAG_RE, " "));
  // A task made only of tags keeps them as its title.
  return stripped || cleanTitle(withoutMarker);
}

function tagsOf(rest: string): string[] {
  const out: string[] = [];
  rest.replace(MARKER_RE, " ").replace(REPEAT_RE, " ").replace(BEFORE_RE, " ").replace(TAG_RE, (_m, _sp, tag: string) => {
    out.push(tag);
    return "";
  });
  return out;
}

function cleanTitle(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
