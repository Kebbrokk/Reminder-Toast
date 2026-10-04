import type { Reminder, ReminderSettings } from "./types";
import { describeRepeat } from "./repeat";
import { describeLead } from "./leads";
import { moment } from "./moment";

/** Placeholders users can put in the toast title and body. */
export const PLACEHOLDERS: Array<[string, string]> = [
  ["{{title}}", "Reminder title"],
  ["{{message}}", "Reminder message or details"],
  ["{{date}}", "Due date (uses your date format)"],
  ["{{time}}", "Due time (uses your time format)"],
  ["{{datetime}}", "Due date and time together"],
  ["{{note}}", "Name of the linked note, if any"],
  ["{{relative}}", "How long ago it came due, e.g. \"a few seconds ago\""],
  ["{{now}}", "Current time when the toast appears"],
  ["{{tags}}", "Tags, e.g. \"#work #urgent\""],
  ["{{repeat}}", "How it repeats, e.g. \"Every week\""],
  ["{{lead}}", "Lead-up toasts only: how long before, e.g. \"30 minutes\""],
];

export function renderTemplate(
  template: string,
  reminder: Reminder,
  settings: ReminderSettings,
  extra: Record<string, string> = {}
): string {
  const due = moment(reminder.due);
  const noteName = reminder.notePath
    ? reminder.notePath.split("/").pop()?.replace(/\.md$/, "") ?? ""
    : "";

  const values: Record<string, string> = {
    title: reminder.title || "Untitled reminder",
    message: reminder.message,
    date: due.format(settings.dateFormat),
    time: due.format(settings.timeFormat),
    datetime: `${due.format(settings.dateFormat)} ${due.format(settings.timeFormat)}`,
    note: noteName,
    relative: due.fromNow(),
    now: moment().format(settings.timeFormat),
    tags: (reminder.tags ?? []).map((t) => `#${t}`).join(" "),
    repeat: reminder.repeat ? describeRepeat(reminder.repeat) : "",
    lead: "",
    ...extra,
  };

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in values ? values[key] : match
  );
}

/** Resolve the title and body actually shown for a reminder. */
export function toastContent(
  reminder: Reminder,
  settings: ReminderSettings
): { title: string; body: string } {
  const titleTpl = reminder.toastTitle.trim() || settings.toastTitleTemplate;
  const bodyTpl = reminder.toastBody.trim() || settings.toastBodyTemplate;
  return {
    title: renderTemplate(titleTpl, reminder, settings),
    body: renderTemplate(bodyTpl, reminder, settings),
  };
}

export function formatDue(due: number, settings: ReminderSettings): string {
  const m = moment(due);
  return `${m.format(settings.dateFormat)} ${m.format(settings.timeFormat)}`;
}

/** Title and body for a lead-up toast shown `minutes` before `at`. */
export function leadToastContent(
  reminder: Reminder,
  settings: ReminderSettings,
  minutes: number,
  at: number
): { title: string; body: string } {
  const shown = { ...reminder, due: at };
  const extra = { lead: describeLead(minutes) };
  return {
    title: renderTemplate(settings.leadTitleTemplate || "Coming up: {{title}}", shown, settings, extra),
    body: renderTemplate(settings.leadBodyTemplate, shown, settings, extra),
  };
}
