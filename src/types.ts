import type { RepeatRule } from "./repeat";

export interface Reminder {
  id: string;
  title: string;
  message: string;
  /** Due time as epoch milliseconds. */
  due: number;
  /** Optional vault path of a note linked to this reminder. */
  notePath: string;
  /** Per-reminder toast title override. Empty means use the global template. */
  toastTitle: string;
  /** Per-reminder toast body override. Empty means use the global template. */
  toastBody: string;
  fired: boolean;
  completed: boolean;
  createdAt: number;
  /**
   * True when the reminder lives as a task line in a note, like
   * "- [ ] Call the dentist @remind(2026-10-02 09:00)". Its notePath is that note.
   */
  inline?: boolean;
  /** Hex color. Empty means use the first tag's color, then an automatic color. */
  color?: string;
  /** Tag names without the leading #. */
  tags?: string[];
  /** Repeat rule, or null/undefined for a one-time reminder. */
  repeat?: RepeatRule | null;
  /** Scheduled time of the current occurrence of a repeating reminder. `due` can differ after a snooze. */
  occurrence?: number;
  /** Lead-up notifications, in minutes before the due time. */
  leadUps?: number[];
  /** Lead-ups already shown for the time in leadBase. */
  leadsFired?: number[];
  /** The due time the lead-ups were last scheduled for. Cleared when lead-ups change. */
  leadBase?: number;
}

export type BgFit = "cover" | "contain" | "tile" | "stretch";

export interface BackgroundSettings {
  /** Vault path, [[link]] or web address of an image. Empty means no background. */
  image: string;
  fit: BgFit;
  /** center, top, bottom, left or right */
  position: string;
  /** 0 to 95: how much the theme background covers the image, so text stays readable. */
  dim: number;
}

export const DEFAULT_BACKGROUND: BackgroundSettings = {
  image: "",
  fit: "cover",
  position: "center",
  dim: 50,
};

export interface TagDef {
  name: string;
  color: string;
}

export type ToastPosition =
  | "top-right"
  | "top-left"
  | "top-center"
  | "bottom-right"
  | "bottom-left"
  | "bottom-center";

export interface ReminderSettings {
  toastTitleTemplate: string;
  toastBodyTemplate: string;
  /** Seconds before the toast auto-dismisses. 0 keeps it until dismissed. */
  toastDurationSec: number;
  flash: boolean;
  position: ToastPosition;
  /** Hex color for the toast accent. Empty means use the theme accent. */
  accentColor: string;
  playSound: boolean;
  systemNotification: boolean;
  snoozeMinutes: number;
  dateFormat: string;
  timeFormat: string;
  fireMissedOnStartup: boolean;
  /** Detect "@remind(...)" task lines in notes. */
  inlineEnabled: boolean;
  /** When creating a reminder from the editor, write it into the note as a task. */
  insertInlineByDefault: boolean;
  /** Keep a markdown file listing every reminder. */
  fileSyncEnabled: boolean;
  reminderFilePath: string;
  fileIncludeCompleted: boolean;
  /** Tags with colors. Reminders with a tag use its color unless they have their own. */
  tags: TagDef[];
  /** Give reminders without a color or colored tag an automatic color on the calendar and list. */
  autoColor: boolean;
  /** 0 = Sunday, 1 = Monday. */
  weekStart: number;
  /** HH:mm used when adding a reminder from the calendar. */
  defaultTime: string;
  /**
   * Show the %%rt:id%% tags in the reminders file while editing. Hidden by default.
   * Not in the settings tab: set "showReminderIds": true in data.json to show them.
   */
  showReminderIds: boolean;
  /** Title and body of lead-up toasts. {{lead}} is how long before, e.g. "30 minutes". */
  leadTitleTemplate: string;
  leadBodyTemplate: string;
  /** Also show toasts inside popped-out calendar windows. */
  toastInPopout: boolean;
  /**
   * Toast in its own pop-out window on Obsidian's screen:
   * "unfocused" when Obsidian isn't the active app, "minimized" only when minimized, or "never".
   */
  desktopToast: "unfocused" | "minimized" | "never";
  /** Background image for the sidebar calendar. */
  sidebarBackground: BackgroundSettings;
  /** Background image for calendars embedded in notes. Each embed can override it. */
  embedBackground: BackgroundSettings;
}

export const DEFAULT_SETTINGS: ReminderSettings = {
  toastTitleTemplate: "Reminder: {{title}}",
  toastBodyTemplate: "{{message}}",
  toastDurationSec: 0,
  flash: true,
  position: "top-right",
  accentColor: "",
  playSound: true,
  systemNotification: false,
  snoozeMinutes: 10,
  dateFormat: "ddd, MMM D, YYYY",
  timeFormat: "h:mm A",
  fireMissedOnStartup: true,
  inlineEnabled: true,
  insertInlineByDefault: true,
  fileSyncEnabled: false,
  reminderFilePath: "Reminders.md",
  fileIncludeCompleted: true,
  tags: [],
  autoColor: true,
  weekStart: 0,
  defaultTime: "09:00",
  showReminderIds: false,
  leadTitleTemplate: "Coming up: {{title}}",
  leadBodyTemplate: "Due at {{time}}, {{relative}}.",
  toastInPopout: true,
  desktopToast: "unfocused",
  sidebarBackground: { ...DEFAULT_BACKGROUND },
  embedBackground: { ...DEFAULT_BACKGROUND },
};

export interface PluginData {
  settings: ReminderSettings;
  reminders: Reminder[];
  /** Lines in the reminders file that are not reminders yet. */
  fileDrafts?: string[];
}

export function newReminder(partial: Partial<Reminder> = {}): Reminder {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: "",
    message: "",
    due: defaultDue(),
    notePath: "",
    toastTitle: "",
    toastBody: "",
    fired: false,
    completed: false,
    createdAt: Date.now(),
    color: "",
    tags: [],
    repeat: null,
    leadUps: [],
    ...partial,
  };
}

/** One hour from now, rounded up to the next 5 minutes. */
export function defaultDue(): number {
  const step = 5 * 60 * 1000;
  return Math.ceil((Date.now() + 60 * 60 * 1000) / step) * step;
}
