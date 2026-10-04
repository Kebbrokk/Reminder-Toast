import { moment } from "./moment";
import type { Reminder, ReminderSettings } from "./types";
import { formatInlineDate, parseInlineDate } from "./inline";
import { formatRepeat } from "./repeat";
import { formatLeadText } from "./leads";

/**
 * The reminders file lists every reminder, including inline ones found in notes,
 * and can be edited directly:
 *
 *   - [ ] Water the plants @remind(2026-10-02 18:00) · [[Garden]] %%rt:abc123%%
 *       - Ask about the weekend
 *
 * Each line carries a hidden %%rt:id%% comment so edits map to the right reminder.
 * New task lines with a @remind(...) marker become new reminders. Lines that are
 * not reminders yet are kept in a Drafts section.
 */

export const FILE_MARKER = "Managed by Reminder Toast";

const ID_RE = /\s*%%rt:([\w-]+)%%/;
const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/;
const BULLET_RE = /^(\s+)(?:[-*+]|\d+[.)])\s+(?!\[.\]\s)(.*)$/;
const MARKER_RE = /@remind\(([^)]*)\)/i;
const REPEAT_RE = /@repeat\(([^)]*)\)/i;
const BEFORE_RE = /@before\(([^)]*)\)/i;
const TAG_RE = /(^|\s)#([^\s#[\]]+)/g;
const LINK_RE = /(?:\bfrom\s+)?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/;
const SEP_RE = /\s+·\s*|\s*·\s+/g;

// ---------- Writing ----------

export function buildReminderFile(
  reminders: Reminder[],
  settings: ReminderSettings,
  drafts: string[] = []
): string {
  const now = Date.now();
  const sorted = [...reminders].sort((a, b) => a.due - b.due);
  const due = sorted.filter((r) => !r.completed && r.due <= now);
  const upcoming = sorted.filter((r) => !r.completed && r.due > now);
  const completed = settings.fileIncludeCompleted
    ? sorted.filter((r) => r.completed).sort((a, b) => b.due - a.due)
    : [];

  const out: string[] = [
    "# Reminders",
    "",
    `> [!info]- ${FILE_MARKER}`,
    "> **Add** a reminder by writing a new task anywhere below, for example:",
    "> `- [ ] Water the plants @remind(2026-10-02 18:00)`",
    "> **Edit** a title or the @remind time, **check** a box to complete, or **delete** a line to remove a reminder.",
    "> Add `[[Note]]` to link a note, `#tags` to tag and color it, and `@repeat(weekly)` to make it repeat.",
    "> Add `@before(30m, 1h)` for heads-up toasts before it's due. An indented bullet under a task becomes its message.",
    settings.showReminderIds
      ? "> Keep the `%%rt:...%%` ID at the end of each line. Changes are saved a moment after you stop typing."
      : "> Each line has a hidden ID that links it to its reminder. Changes are saved a moment after you stop typing.",
    "",
  ];

  const section = (heading: string, items: Reminder[]) => {
    out.push(`## ${heading}`, "");
    if (!items.length) out.push("_None_");
    for (const r of items) out.push(...formatItem(r));
    out.push("");
  };

  section("Due", due);
  section("Upcoming", upcoming);
  if (settings.fileIncludeCompleted) section("Completed", completed);

  if (drafts.length) {
    out.push("## Drafts", "", "_These lines need a @remind(YYYY-MM-DD HH:mm) marker to become reminders._", "");
    out.push(...drafts, "");
  }

  out.push(`_Last updated ${moment().format(`${settings.dateFormat} ${settings.timeFormat}`)}_`, "");
  return out.join("\n");
}

function formatItem(r: Reminder): string[] {
  let line = `- [${r.completed ? "x" : " "}] ${r.title || "Untitled reminder"}`;
  for (const t of r.tags ?? []) line += ` #${t}`;
  line += ` @remind(${formatInlineDate(r.due)})`;
  if (r.repeat) line += ` @repeat(${formatRepeat(r.repeat)})`;
  if (r.leadUps?.length) line += ` @before(${formatLeadText(r.leadUps)})`;
  if (r.notePath) {
    const target = r.notePath.replace(/\.md$/, "");
    line += r.inline ? ` · from [[${target}]]` : ` · [[${target}]]`;
  }
  const lines = [`${line} %%rt:${r.id}%%`];
  for (const msgLine of r.message.split("\n")) {
    if (msgLine.trim()) lines.push(`    - ${msgLine.trim()}`);
  }
  return lines;
}

/** The message as the file shows it, for change detection. */
export function fileMessage(message: string): string {
  return message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

// ---------- Reading ----------

export interface FileEntry {
  /** Hidden id, or null for a line the user added. */
  id: string | null;
  completed: boolean;
  title: string;
  /** Null when the @remind marker is missing or its date can't be read. */
  due: number | null;
  /** Link text inside [[ ]], or null. */
  link: string | null;
  /** True when the line says "from [[Note]]", i.e. an inline reminder. */
  fromNote: boolean;
  tags: string[];
  /** Text inside @repeat(...), or null. */
  repeatText: string | null;
  /** Text inside @before(...), or null. */
  beforeText: string | null;
  message: string;
  /** Original lines, used to keep drafts as typed. */
  raw: string[];
}

export interface ParsedFile {
  entries: FileEntry[];
  /** Lines that are not reminders and not part of the generated layout. */
  drafts: string[];
}

export function parseReminderFile(content: string): ParsedFile {
  const entries: FileEntry[] = [];
  const drafts: string[] = [];
  let current: FileEntry | null = null;
  let inCallout = false;

  for (const line of content.split("\n")) {
    // Indented bullets under a task are its message.
    const bullet = BULLET_RE.exec(line);
    if (current && bullet) {
      current.message = current.message ? `${current.message}\n${bullet[2].trim()}` : bullet[2].trim();
      current.raw.push(line);
      continue;
    }

    const task = TASK_RE.exec(line);
    if (task) {
      current = parseTask(task[1], task[2], line);
      entries.push(current);
      continue;
    }
    current = null;

    const t = line.trim();
    if (t.startsWith(">")) {
      inCallout = true;
      continue;
    }
    if (inCallout && !t) inCallout = false;
    if (!t || isBoilerplate(t)) continue;
    drafts.push(line);
  }

  // Tasks without a usable date stay as drafts, with their message lines.
  const ready: FileEntry[] = [];
  for (const e of entries) {
    if (e.id || e.due !== null) ready.push(e);
    else drafts.push(...e.raw);
  }
  return { entries: ready, drafts };
}

function parseTask(mark: string, rest: string, line: string): FileEntry {
  const idMatch = ID_RE.exec(rest);
  const marker = MARKER_RE.exec(rest);
  const link = LINK_RE.exec(rest);
  const repeat = REPEAT_RE.exec(rest);
  const before = BEFORE_RE.exec(rest);

  let title = rest.replace(ID_RE, " ").replace(MARKER_RE, " ").replace(REPEAT_RE, " ").replace(BEFORE_RE, " ").replace(LINK_RE, " ");
  const tags: string[] = [];
  title = title.replace(TAG_RE, (_m, sp: string, tag: string) => {
    if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    return sp;
  });
  title = title.replace(SEP_RE, " ").replace(/\s+/g, " ").replace(/^·|·$/g, "").trim();

  return {
    id: idMatch ? idMatch[1] : null,
    completed: mark !== " ",
    title,
    due: marker ? parseInlineDate(marker[1]) : null,
    link: link ? link[1].trim() : null,
    fromNote: link ? /^from\s/i.test(link[0]) : false,
    tags,
    repeatText: repeat ? repeat[1].trim() || null : null,
    beforeText: before ? before[1].trim() || null : null,
    message: "",
    raw: [line],
  };
}

function isBoilerplate(t: string): boolean {
  return (
    /^#\s+Reminders\s*$/.test(t) ||
    /^##\s+(Due|Upcoming|Completed|Drafts)\s*$/.test(t) ||
    t === "_None_" ||
    /^_Last updated .*_$/.test(t) ||
    /^_These lines need a @remind/.test(t)
  );
}

/** Compare file content while ignoring the "Last updated" stamp, to avoid pointless rewrites. */
export function sameIgnoringStamp(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/^_Last updated .*_$/m, "");
  return strip(a) === strip(b);
}

/** Ids present in a version of the file, used to detect deleted lines. */
export function idsIn(content: string): Set<string> {
  const ids = new Set<string>();
  const re = /%%rt:([\w-]+)%%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) ids.add(m[1]);
  return ids;
}
