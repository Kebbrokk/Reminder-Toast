import {
  Platform,
  AbstractInputSuggest,
  App,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TFile,
} from "obsidian";
import type ReminderToastPlugin from "../main";
import { BackgroundSettings, DEFAULT_SETTINGS, ReminderSettings, ToastPosition, newReminder } from "./types";
import { PLACEHOLDERS } from "./template";
import { INLINE_DATE_FORMAT } from "./inline";
import { PALETTE, normalizeTag } from "./colors";
import { BG_FITS, BG_POSITIONS, ImagePickerModal, backgroundVars, imageFiles, resolveImage } from "./background";

/** Suggests image files from the vault while typing. */
class ImageFileSuggest extends AbstractInputSuggest<TFile> {
  constructor(app: App, private inputEl: HTMLInputElement, private onPick: (path: string) => unknown) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return imageFiles(this.app)
      .filter((f) => f.path.toLowerCase().includes(q))
      .slice(0, 50);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.addClass("rt-image-suggestion");
    const thumb = el.createEl("img", { cls: "rt-image-suggestion-thumb" });
    thumb.src = this.app.vault.getResourcePath(file);
    thumb.loading = "lazy";
    el.createSpan({ text: file.path });
  }

  selectSuggestion(file: TFile): void {
    this.inputEl.value = file.path;
    this.onPick(file.path);
    this.close();
  }
}

/** Suggests Markdown files in the vault while typing a path. */
class MarkdownFileSuggest extends AbstractInputSuggest<TFile> {
  constructor(app: App, private inputEl: HTMLInputElement, private onPick: (path: string) => unknown) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 50);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.inputEl.value = file.path;
    this.onPick(file.path);
    this.close();
  }
}

const POSITIONS: Record<ToastPosition, string> = {
  "top-right": "Top right",
  "top-center": "Top center",
  "top-left": "Top left",
  "bottom-right": "Bottom right",
  "bottom-center": "Bottom center",
  "bottom-left": "Bottom left",
};

type BackgroundKey = "sidebarBackground" | "embedBackground";

/**
 * Settings tab, built with Obsidian's declarative settings API so every
 * setting shows up in Obsidian's settings search.
 */
export class ReminderSettingTab extends PluginSettingTab {
  /** Refreshers for the background previews, keyed by setting. */
  private previewRefreshers = new Map<BackgroundKey, () => void>();

  constructor(app: App, private plugin: ReminderToastPlugin) {
    super(app, plugin);
    this.containerEl?.addClass?.("rt-settings");
  }

  // ---------- Reading and saving ----------

  /**
   * Settings live in data.json next to the reminders, so values are read
   * from and saved through the plugin rather than the default storage.
   * Keys can be nested, e.g. "sidebarBackground.dim".
   */
  getControlValue(key: string): unknown {
    const value = readPath(this.plugin.settings, key);
    return key === "weekStart" ? String(value) : value;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    writePath(s, key, normalizeValue(key, value));
    await this.plugin.saveAll();

    // Follow-up work for settings that change more than their own value.
    if (key === "fileSyncEnabled") {
      if (s.fileSyncEnabled) await this.plugin.writeReminderFile(true);
      this.refreshDomState();
    } else if (key === "inlineEnabled") {
      await this.plugin.fullScan(false);
      this.refreshDomState();
    } else if (key.startsWith("sidebarBackground.")) {
      this.previewRefreshers.get("sidebarBackground")?.();
    } else if (key.startsWith("embedBackground.")) {
      this.previewRefreshers.get("embedBackground")?.();
    }
  }

  // ---------- Definitions ----------

  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const desktopToastsAvailable = Platform.isDesktopApp;

    return [
      // Toast text is the general section, so it sits at the top without a heading.
      {
        name: "Toast text placeholders",
        desc: createFragment((f) => {
          f.appendText("Default text for every toast. Individual reminders can override it. These placeholders are filled in:");
          const ul = f.createEl("ul", { cls: "rt-settings-help" });
          for (const [ph, desc] of PLACEHOLDERS) {
            const li = ul.createEl("li");
            li.createEl("code", { text: ph });
            li.appendText(` ${desc}`);
          }
        }),
        aliases: ["template", "placeholder"],
      },
      {
        name: "Toast title",
        control: { type: "text", key: "toastTitleTemplate", placeholder: DEFAULT_SETTINGS.toastTitleTemplate },
      },
      {
        name: "Toast body",
        desc: "Line breaks are kept.",
        control: { type: "textarea", key: "toastBodyTemplate", placeholder: DEFAULT_SETTINGS.toastBodyTemplate, rows: 4 },
      },
      this.momentFormatSetting("Date format", "Moment.js format used by {{date}}.", "dateFormat"),
      this.momentFormatSetting("Time format", "Moment.js format used by {{time}}. Use HH:mm for 24 hour time.", "timeFormat"),
      {
        name: "Lead-up toast title",
        desc: "For heads-up toasts set with \"Notify before\". {{lead}} is how long before, for example 30 minutes.",
        control: { type: "text", key: "leadTitleTemplate", placeholder: DEFAULT_SETTINGS.leadTitleTemplate },
      },
      {
        name: "Lead-up toast body",
        control: { type: "textarea", key: "leadBodyTemplate", placeholder: DEFAULT_SETTINGS.leadBodyTemplate, rows: 2 },
      },

      {
        type: "group",
        heading: "Toast appearance",
        cls: "rt-settings-group",
        items: [
          {
            name: "Flash",
            desc: "Pulse the toast until you hover over it.",
            control: { type: "toggle", key: "flash" },
          },
          {
            name: "Position",
            control: { type: "dropdown", key: "position", options: POSITIONS },
          },
          {
            name: "Auto dismiss after (seconds)",
            desc: "Set to 0 to keep the toast on screen until you dismiss it.",
            control: { type: "number", key: "toastDurationSec", min: 0, step: 1 },
          },
          {
            name: "Accent color",
            desc: "Border and flash color. Reset to follow your theme accent.",
            render: (setting) => {
              setting
                .addColorPicker((c) =>
                  c.setValue(s.accentColor || "#7c3aed").onChange(async (v) => {
                    s.accentColor = v;
                    await this.plugin.saveAll();
                  })
                )
                .addExtraButton((b) =>
                  b
                    .setIcon("rotate-ccw")
                    .setTooltip("Use theme accent")
                    .onClick(async () => {
                      s.accentColor = "";
                      await this.plugin.saveAll();
                      this.update();
                    })
                );
            },
          },
        ],
      },

      {
        type: "group",
        heading: "Alerts",
        cls: "rt-settings-group",
        items: [
          { name: "Play sound", control: { type: "toggle", key: "playSound" } },
          {
            name: "System notification",
            desc: "Also show an operating system notification, useful when Obsidian is in the background.",
            control: { type: "toggle", key: "systemNotification" },
          },
          {
            name: "Snooze length (minutes)",
            control: { type: "number", key: "snoozeMinutes", min: 1, step: 1 },
          },
          {
            name: "Show missed reminders on startup",
            desc: "If a reminder came due while Obsidian was closed, show its toast when Obsidian opens.",
            control: { type: "toggle", key: "fireMissedOnStartup" },
          },
        ],
      },

      {
        type: "group",
        heading: "Pop-out windows and toasts",
        cls: "rt-settings-group",
        items: [
          {
            name: "Pop-out calendar",
            desc:
              "Pop the calendar into its own window with the button in its header, or with the pop out reminder calendar command. " +
              "Drag it to any screen.",
            aliases: ["window", "popout"],
          },
          {
            name: "Show toasts in the popped-out calendar",
            desc: "Toasts appear in the main window and in each popped-out calendar window. Dismissing one dismisses all.",
            control: { type: "toggle", key: "toastInPopout" },
          },
          {
            name: "Pop-out toast",
            desc: desktopToastsAvailable
              ? "A toast in its own small Obsidian window on the screen Obsidian is on (and the popped-out calendar's screen), " +
                "so you see reminders even when Obsidian is behind other apps or minimized. It closes when you return to Obsidian."
              : "Not available on this system. Turn on system notification to get reminders while Obsidian is in the background.",
            control: {
              type: "dropdown",
              key: "desktopToast",
              options: {
                unfocused: "When Obsidian isn't the active app",
                minimized: "Only when Obsidian is minimized",
                never: "Never",
              },
              disabled: !desktopToastsAvailable,
            },
          },
          {
            name: "Show a test pop-out toast",
            desc: "Shows one right away, even while Obsidian is in front.",
            disabled: !desktopToastsAvailable,
            action: () => this.testDesktopToast(),
          },
        ],
      },

      {
        type: "group",
        heading: "Reminders file",
        cls: "rt-settings-group",
        items: [
          {
            name: "Save reminders to a file",
            desc:
              "Keep a note that lists every reminder, including inline ones from your notes. It updates whenever you add, edit, " +
              "snooze or complete a reminder. You can also edit it: add a task with @remind(YYYY-MM-DD HH:mm) to create a reminder, " +
              "change a title or time, check a box to complete, or delete a line to remove a reminder.",
            control: { type: "toggle", key: "fileSyncEnabled" },
          },
          {
            name: "File location",
            desc:
              "Path inside your vault. Pick an empty note or type a new path. The file and folders are created if needed. " +
              "Notes with your own writing are never overwritten.",
            visible: () => s.fileSyncEnabled,
            render: (setting) => this.renderReminderFilePath(setting),
          },
          {
            name: "Open reminders file",
            visible: () => s.fileSyncEnabled,
            action: () => void this.plugin.openReminderFile(),
          },
          {
            name: "Include completed reminders",
            visible: () => s.fileSyncEnabled,
            control: { type: "toggle", key: "fileIncludeCompleted" },
          },
        ],
      },

      {
        type: "group",
        heading: "Inline reminders",
        cls: "rt-settings-group",
        items: [
          {
            name: "Detect inline reminders",
            desc: createFragment((f) => {
              f.appendText("Add a reminder anywhere in a note by writing a task with a @remind marker:");
              f.createEl("pre", { cls: "rt-settings-help" }).createEl("code", {
                text: "- [ ] call the dentist @remind(2026-10-02 09:00)\n- [ ] pay rent @remind(2026-10-01)",
              });
              f.appendText(
                `Use ${INLINE_DATE_FORMAT} (24 hour) or a time like 9:30 AM. A date with no time means 9:00 AM. ` +
                  "Checking the box completes the reminder, and completing it from a toast checks the box."
              );
            }),
            control: { type: "toggle", key: "inlineEnabled" },
          },
          {
            name: "Add new reminders to the note",
            desc:
              "When you create a reminder while editing a note, write it into the note as a task line. " +
              "You can still turn this off per reminder.",
            visible: () => s.inlineEnabled,
            control: { type: "toggle", key: "insertInlineByDefault" },
          },
        ],
      },

      {
        type: "group",
        heading: "Calendar",
        cls: "rt-settings-group",
        items: [
          {
            name: "Open calendar",
            desc: "Opens in the right sidebar. Use the pin button in its header to keep it in place.",
            action: () => void this.plugin.activateCalendar(),
          },
          {
            name: "Copy code for a calendar in a note",
            desc:
              "Add a reminder-calendar code block to any note, including inside columns. " +
              "Options: month, agenda, tags, background, dim, fit and position.",
            aliases: ["embed", "code block"],
            action: () => void this.plugin.copyCalendarEmbed(),
          },
          {
            name: "Week starts on",
            control: { type: "dropdown", key: "weekStart", options: { "0": "Sunday", "1": "Monday" } },
          },
          {
            name: "Default time",
            desc: "Time used when you add a reminder to a day from the calendar.",
            render: (setting) => {
              setting.addText((t) => {
                t.inputEl.type = "time";
                t.setValue(s.defaultTime).onChange(async (v) => {
                  if (/^\d{2}:\d{2}$/.test(v)) {
                    s.defaultTime = v;
                    await this.plugin.saveAll();
                  }
                });
              });
            },
          },
          {
            name: "Automatic colors",
            desc:
              "Give reminders without their own color or a colored tag a color picked from their title, " +
              "so repeats and reminders with the same title always match.",
            control: { type: "toggle", key: "autoColor" },
          },
        ],
      },

      this.backgroundGroup("Sidebar calendar background", "sidebarBackground", false),
      this.backgroundGroup("Note calendar background", "embedBackground", true),

      {
        type: "list",
        heading: "Tag colors",
        emptyState: "No tags yet. Tags you type in a reminder are added here with a color.",
        items: s.tags.map((tag, idx) => ({
          name: `#${tag.name}`,
          desc: "Reminders with this tag use its color unless they have their own.",
          render: (setting: Setting) => this.renderTagRow(setting, idx),
        })),
        onDelete: (index: number) => void this.removeTag(index),
        addItem: { name: "Add tag", action: () => void this.addTag() },
      },

      {
        type: "group",
        heading: "Test",
        cls: "rt-settings-group",
        items: [
          {
            name: "Show a test toast",
            desc: "A sample toast with your current settings.",
            action: () =>
              this.plugin.fireToast(
                newReminder({ title: "Sample reminder", message: "This is how your toast will look.", due: Date.now() }),
                { preview: true }
              ),
          },
          {
            name: "Show a test lead-up toast",
            desc: "A sample heads-up toast, as if a reminder is due in 30 minutes.",
            action: () => {
              const at = Date.now() + 30 * 60000;
              const sample = newReminder({ title: "Sample reminder", message: "This is how a heads-up looks.", due: at });
              this.plugin.fireLeadToast(sample, 30, at, { preview: true });
            },
          },
        ],
      },
    ];
  }

  // ---------- Custom rows ----------

  /** A Moment.js format field with a live sample. */
  private momentFormatSetting(name: string, desc: string, key: "dateFormat" | "timeFormat"): SettingDefinitionItem {
    return {
      name,
      desc,
      render: (setting) => {
        setting.addMomentFormat((m) =>
          m
            .setDefaultFormat(DEFAULT_SETTINGS[key])
            .setValue(this.plugin.settings[key])
            .onChange(async (v) => {
              this.plugin.settings[key] = v || DEFAULT_SETTINGS[key];
              await this.plugin.saveAll();
            })
        );
      },
    };
  }

  private renderReminderFilePath(setting: Setting): void {
    const s = this.plugin.settings;
    let pending = s.reminderFilePath;
    const applyPath = async (path: string) => {
      const clean = path.trim();
      if (!clean || clean === s.reminderFilePath) return;
      s.reminderFilePath = clean;
      await this.plugin.saveAll();
      await this.plugin.writeReminderFile(true);
      // Inline scanning skips the reminders file, so rescan with the new path.
      await this.plugin.fullScan(false);
    };
    setting.addText((t) => {
      t.setPlaceholder(DEFAULT_SETTINGS.reminderFilePath).setValue(s.reminderFilePath);
      t.onChange((v) => (pending = v));
      t.inputEl.addEventListener("blur", () => void applyPath(pending));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void applyPath(pending);
      });
      t.inputEl.addClass("rt-path-input");
      new MarkdownFileSuggest(this.app, t.inputEl, (path) => {
        pending = path;
        void applyPath(path);
      });
    });
  }

  /** Image, preview, fit, position and dim for one background. */
  private backgroundGroup(heading: string, key: BackgroundKey, embed: boolean): SettingDefinitionItem {
    const bg = (): BackgroundSettings => this.plugin.settings[key];
    return {
      type: "group",
      heading,
      cls: "rt-bg-settings",
      items: [
        {
          name: "Image",
          desc: embed
            ? "Default for calendars in notes. Any image Obsidian supports, including animated GIFs. " +
              "A single calendar can use its own with \"background: [[image.png]]\" in its code block."
            : "Any image Obsidian supports, including animated GIFs. Vault path, [[link]], or a web address.",
          aliases: ["background", "image", "gif"],
          render: (setting) => this.renderImagePicker(setting, key),
        },
        {
          name: "Preview",
          searchable: false,
          render: (setting) => {
            const preview = setting.controlEl.createDiv({ cls: "rt-bg-preview" });
            const text = preview.createDiv({ cls: "rt-bg-preview-text" });
            const refresh = () => {
              const current = bg();
              const resolved = resolveImage(this.app, current.image);
              preview.toggleClass("is-empty", !resolved);
              preview.toggleClass("is-missing", !!current.image && !resolved);
              preview.toggleClass("rt-has-bg", !!resolved);
              if (resolved) {
                preview.setCssProps(backgroundVars(resolved.url, current));
                text.setText("Sample text on your background");
              } else {
                text.setText(current.image ? `Image not found: ${current.image}` : "No background image");
              }
            };
            this.previewRefreshers.set(key, refresh);
            refresh();
            return () => this.previewRefreshers.delete(key);
          },
        },
        { name: "Fit", control: { type: "dropdown", key: `${key}.fit`, options: BG_FITS } },
        { name: "Position", control: { type: "dropdown", key: `${key}.position`, options: BG_POSITIONS } },
        {
          name: "Dim",
          desc: "Fades the image toward your theme's background so dates stay readable. Higher is fainter.",
          control: { type: "slider", key: `${key}.dim`, min: 0, max: 95, step: 5 },
        },
      ],
    };
  }

  private renderImagePicker(setting: Setting, key: BackgroundKey): void {
    const bg = this.plugin.settings[key];
    let input: HTMLInputElement | null = null;
    const commit = async (value: string) => {
      const clean = value.trim();
      if (clean === bg.image) return;
      bg.image = clean;
      if (input) input.value = clean;
      await this.plugin.saveAll();
      this.previewRefreshers.get(key)?.();
    };
    setting
      .addText((t) => {
        input = t.inputEl;
        t.setPlaceholder("Attachments/background.gif").setValue(bg.image);
        t.inputEl.addClass("rt-path-input");
        t.inputEl.addEventListener("blur", () => void commit(t.getValue()));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void commit(t.getValue());
        });
        new ImageFileSuggest(this.app, t.inputEl, (path) => commit(path));
      })
      .addButton((b) =>
        b.setButtonText("Choose").onClick(() => new ImagePickerModal(this.app, (file: TFile) => commit(file.path)).open())
      )
      .addExtraButton((b) =>
        b
          .setIcon("x")
          .setTooltip("Remove background")
          .onClick(() => void commit(""))
      );
  }

  // ---------- Tags ----------

  private renderTagRow(setting: Setting, idx: number): void {
    const s = this.plugin.settings;
    const tag = s.tags[idx];
    if (!tag) return;
    const swatch = createSpan({ cls: "rt-tag-swatch" });
    swatch.setCssProps({ "--rt-tag": tag.color });
    setting.nameEl.prepend(swatch);

    setting
      .addText((t) => {
        t.setValue(tag.name);
        const rename = async () => {
          const name = normalizeTag(t.getValue());
          const taken = s.tags.some((x, i) => i !== idx && x.name.toLowerCase() === name.toLowerCase());
          if (!name || name === tag.name || taken) {
            t.setValue(tag.name);
            return;
          }
          // Rename on reminders that use it (inline reminders keep the tag written in their note).
          for (const r of this.plugin.reminders) {
            if (r.inline || !r.tags) continue;
            r.tags = r.tags.map((x) => (x.toLowerCase() === tag.name.toLowerCase() ? name : x));
          }
          tag.name = name;
          await this.plugin.saveAll();
          this.update();
        };
        t.inputEl.addEventListener("blur", () => void rename());
      })
      .addColorPicker((c) =>
        c.setValue(tag.color || PALETTE[idx % PALETTE.length][1]).onChange(async (v) => {
          tag.color = v;
          swatch.setCssProps({ "--rt-tag": v });
          await this.plugin.saveAll();
        })
      );
  }

  private async addTag(): Promise<void> {
    const s = this.plugin.settings;
    let name = "new-tag";
    for (let n = 2; s.tags.some((t) => t.name.toLowerCase() === name); n++) name = `new-tag-${n}`;
    s.tags.push({ name, color: PALETTE[s.tags.length % PALETTE.length][1] });
    await this.plugin.saveAll();
    this.update();
  }

  private async removeTag(index: number): Promise<void> {
    this.plugin.settings.tags.splice(index, 1);
    await this.plugin.saveAll();
    this.update();
  }

  // ---------- Tests ----------

  private testDesktopToast(): void {
    const s = this.plugin.settings;
    this.plugin.showEverywhere(
      {
        title: "Reminder: Sample reminder",
        body: "This is a pop-out toast.",
        durationSec: s.toastDurationSec,
        flash: s.flash,
        position: s.position,
        accentColor: s.accentColor,
        actions: [{ label: "Done", cta: true, onClick: () => undefined }],
      },
      "desktop"
    );
  }
}

// ---------- Helpers ----------

function readPath(obj: object, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function writePath(obj: object, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Keep stored settings valid whatever the control sends. */
function normalizeValue(key: string, value: unknown): unknown {
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  switch (key as keyof ReminderSettings) {
    case "toastTitleTemplate":
    case "leadTitleTemplate":
      return typeof value === "string" && value.trim() ? value : defaults[key];
    case "toastDurationSec": {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }
    case "snoozeMinutes": {
      const n = Number(value);
      return Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_SETTINGS.snoozeMinutes;
    }
    case "weekStart":
      return String(value) === "1" ? 1 : 0;
    default:
      return value;
  }
}
