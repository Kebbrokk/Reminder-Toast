import {
  Editor,
  MarkdownFileInfo,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";
import { DEFAULT_BACKGROUND, DEFAULT_SETTINGS, PluginData, Reminder, ReminderSettings, newReminder } from "./src/types";
import { ReminderModal } from "./src/modal";
import { ReminderListView, VIEW_TYPE_REMINDERS } from "./src/view";
import { ReminderSettingTab } from "./src/settings";
import { ToastManager, ToastOptions, playChime, showSystemNotification } from "./src/toast";
import { ScreenArea, ToastPopupManager, ToastPopupView, VIEW_TYPE_TOAST_POPUP, screenAreaFor } from "./src/popupToast";
import { formatDue, leadToastContent, toastContent } from "./src/template";
import { formatLeadText, normalizeLeads, parseLeadText, sameLeads } from "./src/leads";
import { LineChanges, buildInlineLine, parseInline, rewriteInlineLine } from "./src/inline";
import { RepeatRule, formatRepeat, isOccurrence, nextAfter, occurrencesBetween, parseRepeat, sameRule } from "./src/repeat";
import { autoColor, reminderColor } from "./src/colors";
import {
  CALENDAR_CODE_BLOCK,
  CalendarRenderer,
  CalendarViewState,
  calendarStateKey,
  EmbeddedCalendar,
  ReminderCalendarView,
  VIEW_TYPE_CALENDAR,
} from "./src/calendar";
import { hideReminderIdsExtension } from "./src/hideIds";
import type { Extension } from "@codemirror/state";
import {
  FILE_MARKER,
  buildReminderFile,
  fileMessage,
  idsIn,
  parseReminderFile,
  sameIgnoringStamp,
} from "./src/reminderFile";
import { moment, type Moment } from "./src/moment";

/** Longest single wait before re-checking. Keeps timers well inside setTimeout limits and survives sleep. */
const MAX_WAIT_MS = 30 * 1000;
const SCAN_DEBOUNCE_MS = 600;
const FILE_WRITE_DEBOUNCE_MS = 1000;
/** How long to wait after the user stops editing the reminders file before saving their changes. */
const FILE_COMMIT_DELAY_MS = 2500;

/** Where a reminder created from the editor should be written. */
export interface EditorContext {
  editor: Editor;
  file: TFile;
}

/** One reminder shown on one day of the calendar. */
export interface CalendarItem {
  reminder: Reminder;
  at: number;
  /** A future occurrence of a repeating reminder (not the current one). */
  projected: boolean;
}

export default class ReminderToastPlugin extends Plugin {
  settings: ReminderSettings = { ...DEFAULT_SETTINGS };
  reminders: Reminder[] = [];
  /** Every calendar on screen: the sidebar view and any embedded in notes. */
  calendars = new Set<CalendarRenderer>();

  readonly toasts = new ToastManager();
  private popups: ToastPopupManager | null = null;
  private checkTimer: number | null = null;
  private statusBarEl: HTMLElement | null = null;
  private ready = false;
  private scanTimers = new Map<string, number>();
  private fileWriteTimer: number | null = null;
  /** Last content this plugin wrote to the reminders file, so we can ignore our own edits. */
  private lastFileContent: string | null = null;
  /** Lines in the reminders file that are not reminders yet. */
  fileDrafts: string[] = [];
  private commitTimer: number | null = null;
  private commitPromise: Promise<void> | null = null;
  private pendingAdvance = new Set<string>();
  /** Editor extensions for hiding reminder IDs. Emptied when IDs should show. */
  private idExtensions: Extension[] = [];

  async onload(): Promise<void> {
    const missingIdSetting = await this.loadAll();
    // Write the option into data.json so it's there to find and change.
    if (missingIdSetting) await this.persist();

    this.registerEditorExtension(this.idExtensions);
    this.applyIdVisibility();

    this.registerView(VIEW_TYPE_REMINDERS, (leaf) => new ReminderListView(leaf, this));
    this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new ReminderCalendarView(leaf, this));

    // ```reminder-calendar``` blocks show the calendar inside a note.
    this.registerMarkdownCodeBlockProcessor(CALENDAR_CODE_BLOCK, (source, el, ctx) => {
      ctx.addChild(new EmbeddedCalendar(el, this, source, ctx.sourcePath));
    });

    this.addCommand({
      id: "insert-calendar",
      name: "Insert reminder calendar into note",
      editorCallback: (editor: Editor) => this.insertCalendarBlock(editor),
    });

    this.addRibbonIcon("bell-plus", "New reminder", () => this.openCreateModal());
    this.addRibbonIcon("calendar-clock", "Reminder calendar", () => this.activateCalendar());

    this.addCommand({
      id: "open-reminder-calendar",
      name: "Open reminder calendar",
      callback: () => this.activateCalendar(),
    });

    this.addCommand({
      id: "toggle-calendar-pin",
      name: "Pin or unpin the reminder calendar",
      callback: async () => {
        const leaf = await this.activateCalendar();
        if (!leaf) return;
        leaf.togglePinned();
        new Notice(leaf.getViewState().pinned ? "Reminder calendar pinned." : "Reminder calendar unpinned.");
      },
    });

    this.addCommand({
      id: "create-reminder",
      name: "Create reminder",
      callback: () => {
        const ctx = this.activeEditorContext();
        this.openCreateModal(ctx ? { notePath: ctx.file.path } : {}, ctx);
      },
    });

    this.addCommand({
      id: "create-reminder-from-selection",
      name: "Create reminder from selection",
      editorCallback: (editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
        if (!view.file) return;
        this.openCreateModal(
          { title: this.titleFromEditor(editor), notePath: view.file.path },
          { editor, file: view.file }
        );
      },
    });

    this.addCommand({
      id: "open-reminder-list",
      name: "Open reminder list",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "open-reminders-file",
      name: "Open reminders file",
      // Only available when "Save reminders to a file" is on.
      checkCallback: (checking: boolean) => {
        if (!this.settings.fileSyncEnabled) return false;
        if (!checking) void this.openReminderFile();
        return true;
      },
    });

    this.addCommand({
      id: "rescan-inline",
      name: "Rescan notes for inline reminders",
      callback: async () => {
        await this.fullScan(false);
        new Notice(`Found ${this.reminders.filter((r) => r.inline).length} inline reminders.`);
      },
    });

    this.addCommand({
      id: "test-toast",
      name: "Show a test toast",
      callback: () =>
        this.fireToast(
          newReminder({ title: "Test reminder", message: "Your toast notifications are working.", due: Date.now() }),
          { preview: true }
        ),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const file = view.file;
        menu.addItem((item) =>
          item
            .setTitle("Create reminder")
            .setIcon("bell-plus")
            .onClick(() =>
              this.openCreateModal(
                { title: this.titleFromEditor(editor), notePath: file?.path ?? "" },
                file ? { editor, file } : undefined
              )
            )
        );
        menu.addItem((item) =>
          item
            .setTitle("Insert reminder calendar")
            .setIcon("calendar-clock")
            .onClick(() => this.insertCalendarBlock(editor))
        );
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) =>
          item
            .setTitle("Remind me about this note")
            .setIcon("bell-plus")
            .onClick(() => this.openCreateModal({ title: file.basename, notePath: file.path }))
        );
      })
    );

    this.registerVaultEvents();

    // Leaving the reminders file saves its edits right away.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.app.workspace.getActiveFile()?.path !== this.reminderFilePath()) this.flushFileEdits();
      })
    );

    this.addSettingTab(new ReminderSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("rt-status");
    this.statusBarEl.addEventListener("click", () => void this.activateView());

    this.app.workspace.onLayoutReady(async () => {
      await this.fullScan(true);
      this.ready = true;
      this.handleMissed();
      this.scheduleNextCheck();
      // Pick up lines added to the reminders file while Obsidian was closed.
      if (this.settings.fileSyncEnabled) await this.commitFileEdits("startup");
      this.scheduleFileWrite();
    });

    // Waking from sleep can delay timers, so re-check when the window regains focus.
    this.registerDomEvent(window, "focus", () => {
      this.scheduleNextCheck();
      // Back in Obsidian: the in-app toast is visible again, so close the pop-out copies.
      this.popups?.closeAll();
    });

    if (Platform.isDesktopApp) {
      const popups = new ToastPopupManager(this);
      this.popups = popups;
      this.registerView(VIEW_TYPE_TOAST_POPUP, (leaf) => new ToastPopupView(leaf, this, popups.take()));
    }
    this.watchWindow(window);
    this.registerEvent(this.app.workspace.on("window-open", (_w, win) => this.watchWindow(win)));
    this.registerEvent(this.app.workspace.on("window-close", (_w, win) => this.toasts.forgetDocument(win.document)));

    this.addCommand({
      id: "pop-out-calendar",
      name: "Pop out reminder calendar",
      callback: () => this.popOutCalendar(),
    });
  }

  onunload(): void {
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
    if (this.fileWriteTimer !== null) window.clearTimeout(this.fileWriteTimer);
    if (this.commitTimer !== null) window.clearTimeout(this.commitTimer);
    this.scanTimers.forEach((t) => window.clearTimeout(t));
    this.toasts.destroy();
    this.popups?.closeAll();
  }

  // ---------- Data ----------

  /** Returns true when data.json did not have the showReminderIds option yet. */
  async loadAll(): Promise<boolean> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    const missingIdSetting = !data.settings || !("showReminderIds" in data.settings);
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.settings.tags = Array.isArray(this.settings.tags) ? this.settings.tags.map((t) => ({ ...t })) : [];
    this.settings.sidebarBackground = { ...DEFAULT_BACKGROUND, ...(data.settings?.sidebarBackground ?? {}) };
    this.settings.embedBackground = { ...DEFAULT_BACKGROUND, ...(data.settings?.embedBackground ?? {}) };
    this.reminders = Array.isArray(data.reminders) ? data.reminders : [];
    this.fileDrafts = Array.isArray(data.fileDrafts) ? data.fileDrafts : [];
    this.settings.showReminderIds = this.settings.showReminderIds === true;
    return missingIdSetting;
  }

  /** Hide or show %%rt:id%% tags in open editors, following the showReminderIds option. */
  applyIdVisibility(): void {
    this.idExtensions.length = 0;
    if (!this.settings.showReminderIds) this.idExtensions.push(hideReminderIdsExtension());
    this.app.workspace.updateOptions();
  }

  async saveAll(): Promise<void> {
    await this.persist();
    this.refreshViews();
    this.scheduleNextCheck();
    this.scheduleFileWrite();
  }

  private async persist(): Promise<void> {
    const data: PluginData = { settings: this.settings, reminders: this.reminders, fileDrafts: this.fileDrafts };
    await this.saveData(data);
  }

  /** Called by Obsidian when data.json changes on disk, for example from Sync. */
  async onExternalSettingsChange(): Promise<void> {
    const wasShowing = this.settings.showReminderIds;
    await this.loadAll();
    if (this.settings.showReminderIds !== wasShowing) this.applyIdVisibility();
    this.refreshViews();
    this.scheduleNextCheck();
  }

  find(id: string): Reminder | undefined {
    return this.reminders.find((r) => r.id === id);
  }

  /** Save a reminder from the modal. Inline reminders also update their line in the note. */
  async upsertReminder(r: Reminder): Promise<void> {
    const old = this.find(r.id);

    if (r.inline && old) {
      const changes: LineChanges = {};
      if (old.title !== r.title) changes.title = r.title;
      if (old.due !== r.due) changes.due = r.due;
      if (old.completed !== r.completed) changes.completed = r.completed;
      if (!sameRule(old.repeat, r.repeat)) changes.repeat = r.repeat ? formatRepeat(r.repeat) : null;
      if ((old.tags ?? []).join(" ") !== (r.tags ?? []).join(" ")) changes.tags = r.tags ?? [];
      if (!sameLeads(old.leadUps, r.leadUps)) {
        changes.before = r.leadUps?.length ? formatLeadText(r.leadUps) : null;
      }
      this.registerTags(r);
      // Keep the extra fields (message, toast text) before the note is rescanned.
      this.replaceReminder(old.id, r);
      if (Object.keys(changes).length) {
        await this.editInlineLine(r, changes);
        return;
      }
      await this.saveAll();
      return;
    }

    this.registerTags(r);
    if (old) this.replaceReminder(old.id, r);
    else this.reminders.push(r);
    await this.saveAll();
  }

  /** Tags used for the first time are added to settings with a color, so similar reminders match. */
  private registerTags(r: Reminder): void {
    for (const tag of r.tags ?? []) {
      if (this.settings.tags.some((t) => t.name.toLowerCase() === tag.toLowerCase())) continue;
      this.settings.tags.push({ name: tag, color: r.color || autoColor(tag) });
    }
  }

  /** Create a reminder, writing it into the note as a task when asked. */
  async createReminder(r: Reminder, ctx?: EditorContext): Promise<void> {
    this.registerTags(r);
    if (r.inline && ctx) {
      const placed = this.insertInlineInEditor(r, ctx);
      if (placed) {
        r.id = placed.id;
        r.notePath = ctx.file.path;
        r.title = placed.title;
        r.due = placed.due;
        r.tags = placed.tags;
        this.reminders = this.reminders.filter((x) => x.id !== r.id);
        this.reminders.push(r);
        await this.saveAll();
        return;
      }
      new Notice("Could not add the task to the note, so the reminder was saved in the plugin only.");
    }
    r.inline = false;
    this.reminders.push(r);
    await this.saveAll();
  }

  async deleteReminder(id: string): Promise<void> {
    const r = this.find(id);
    if (r?.inline) {
      await this.editInlineLine(r, null);
      return;
    }
    this.reminders = this.reminders.filter((x) => x.id !== id);
    await this.saveAll();
  }

  async setCompleted(id: string, completed: boolean): Promise<void> {
    const r = this.find(id);
    if (!r) return;
    if (completed && r.repeat) {
      await this.completeOccurrence(r);
      return;
    }
    r.completed = completed;
    if (completed) r.fired = true;
    if (r.inline) {
      await this.editInlineLine(r, { completed });
      return;
    }
    await this.saveAll();
  }

  /**
   * Finish the current occurrence of a repeating reminder and move it to the next one.
   * When the series has ended, the reminder is completed.
   */
  async completeOccurrence(r: Reminder): Promise<void> {
    const ended = !this.advance(r);
    if (r.inline) await this.editInlineLine(r, { due: r.due, completed: r.completed });
    else await this.saveAll();
    new Notice(ended ? `"${r.title}" series finished.` : `Next: ${formatDue(r.due, this.settings)}`);
  }

  /** Move a repeating reminder to its next occurrence after now. Returns false when the series has ended. */
  private advance(r: Reminder): boolean {
    if (!r.repeat) return false;
    const base = Math.max(r.occurrence ?? r.due, Date.now());
    const next = nextAfter(r.repeat, base);
    if (next === null) {
      r.completed = true;
      r.fired = true;
      return false;
    }
    r.occurrence = next;
    r.due = next;
    r.fired = false;
    r.completed = false;
    return true;
  }

  async snooze(id: string, minutes: number): Promise<void> {
    const r = this.find(id);
    if (!r) return;
    const due = moment().add(minutes, "minutes").second(0).millisecond(0).valueOf();
    r.due = due;
    r.fired = false;
    r.completed = false;
    // You've already seen this one, so no heads-up before the snoozed time.
    r.leadBase = due;
    r.leadsFired = [...(r.leadUps ?? [])];
    if (r.inline) await this.editInlineLine(r, { due, completed: false });
    else await this.saveAll();
    new Notice(`Snoozed until ${formatDue(due, this.settings)}`);
  }

  async clearCompleted(): Promise<void> {
    const inlineDone = this.reminders.filter((r) => r.completed && r.inline);
    this.reminders = this.reminders.filter((r) => !r.completed || r.inline);
    await this.saveAll();
    if (inlineDone.length) {
      new Notice("Completed inline reminders stay in their notes. Delete the task lines to remove them.");
    }
  }

  private replaceReminder(oldId: string, r: Reminder): void {
    const idx = this.reminders.findIndex((x) => x.id === oldId);
    if (idx >= 0) this.reminders[idx] = r;
    else this.reminders.push(r);
  }

  // ---------- Inline reminders ----------

  private registerVaultEvents(): void {
    const onChange = (file: TAbstractFile) => {
      if (!this.ready || !(file instanceof TFile) || file.extension !== "md") return;
      if (file.path === this.reminderFilePath()) {
        this.onReminderFileEdited();
        return;
      }
      if (this.settings.inlineEnabled) this.queueScan(file);
    };

    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("create", onChange));

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        const before = this.reminders.length;
        this.reminders = this.reminders.filter((r) => !(r.inline && r.notePath === file.path));
        if (this.reminders.length !== before) void this.saveAll();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        let changed = false;
        // Keep background images working when they are moved or renamed.
        for (const bg of [this.settings.sidebarBackground, this.settings.embedBackground]) {
          if (bg.image === oldPath) {
            bg.image = file.path;
            changed = true;
          }
        }
        for (const r of this.reminders) {
          if (r.notePath === oldPath) {
            r.notePath = file.path;
            changed = true;
          }
        }
        if (changed) void this.saveAll();
        // Inline ids include the path, so rescan to refresh them.
        if (file instanceof TFile && this.settings.inlineEnabled) this.queueScan(file);
      })
    );
  }

  private queueScan(file: TFile): void {
    const existing = this.scanTimers.get(file.path);
    if (existing) window.clearTimeout(existing);
    this.scanTimers.set(
      file.path,
      window.setTimeout(() => {
        this.scanTimers.delete(file.path);
        void this.scanFile(file);
      }, SCAN_DEBOUNCE_MS)
    );
  }

  private async scanFile(file: TFile): Promise<void> {
    const content = await this.freshContent(file);
    if (this.syncInlineFile(file.path, content, false)) await this.saveAll();
    await this.runPendingAdvances();
  }

  /** Scan the whole vault. Called on startup and when inline reminders are turned on. */
  async fullScan(startup: boolean): Promise<void> {
    if (!this.settings.inlineEnabled) {
      const before = this.reminders.length;
      this.reminders = this.reminders.filter((r) => !r.inline);
      if (this.reminders.length !== before) await this.saveAll();
      return;
    }

    let changed = false;
    const seenPaths = new Set<string>();
    const skip = this.reminderFilePath();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path === skip) continue;
      seenPaths.add(file.path);
      const content = await this.app.vault.cachedRead(file);
      if (this.syncInlineFile(file.path, content, startup)) changed = true;
    }

    // Drop inline reminders whose note no longer exists.
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((r) => !r.inline || seenPaths.has(r.notePath));
    if (this.reminders.length !== before) changed = true;

    if (changed) await this.saveAll();
    if (!startup) await this.runPendingAdvances();
    else this.pendingAdvance.clear();
  }

  /**
   * Bring stored inline reminders for one note in line with its content.
   * Returns true when anything changed.
   */
  private syncInlineFile(path: string, content: string, startup: boolean): boolean {
    // A reminders file (current or old) lists reminders; it is not a source of inline ones.
    const parsed = content.includes(FILE_MARKER) ? [] : parseInline(path, content);
    const prev = this.reminders.filter((r) => r.inline && r.notePath === path);
    if (!parsed.length && !prev.length) return false;

    const others = this.reminders.filter((r) => !(r.inline && r.notePath === path));
    const used = new Set<Reminder>();
    const now = Date.now();

    const next = parsed.map((p) => {
      const old =
        prev.find((r) => !used.has(r) && r.id === p.id) ??
        prev.find((r) => !used.has(r) && r.title.toLowerCase() === p.title.toLowerCase() && r.due === p.due);
      if (old) used.add(old);

      const r: Reminder = old ? { ...old } : newReminder();
      r.id = p.id;
      r.title = p.title;
      r.notePath = path;
      r.inline = true;
      r.tags = p.tags;
      // The note is the source of truth for @before too.
      const leads = p.beforeText ? normalizeLeads(parseLeadText(p.beforeText) ?? []) : [];
      if (old && !sameLeads(old.leadUps, leads)) delete r.leadBase;
      r.leadUps = leads;
      if (!old) {
        // Do not flood toasts for old tasks the first time the vault is scanned.
        r.fired = startup && p.due <= now;
      } else if (old.due !== p.due) {
        r.fired = p.due <= now && startup;
      }

      // The note is the source of truth for @repeat.
      r.repeat = this.inlineRule(p.repeatText, p.due, old);
      if (r.repeat) {
        const keepOccurrence = old && old.repeat && old.due === p.due && old.occurrence !== undefined;
        r.occurrence = keepOccurrence && old ? old.occurrence : p.due;
      } else {
        delete r.occurrence;
      }

      r.due = p.due;
      r.completed = p.completed;
      if (r.completed) r.fired = true;

      // Checking off a repeating task in the note moves it to the next occurrence.
      if (r.repeat && p.completed && old && !old.completed) this.pendingAdvance.add(r.id);
      return r;
    });

    const changed = JSON.stringify(prev) !== JSON.stringify(next);
    if (changed) this.reminders = [...others, ...next];
    return changed;
  }

  /** Rule for an inline @repeat, keeping the series anchor when the date is part of the same series. */
  private inlineRule(text: string | null, due: number, old: Reminder | undefined): RepeatRule | null {
    if (!text) return null;
    const anchor = old?.repeat?.start ?? due;
    const rule = parseRepeat(text, anchor);
    if (!rule) return null;
    // A snoozed time (same as before) or a date in the old series keeps the anchor; any other date starts a new series.
    if (old?.repeat && (old.due === due || isOccurrence(rule, due))) return rule;
    return parseRepeat(text, due);
  }

  /** Repeating inline tasks that were checked off in the note. */
  private async runPendingAdvances(): Promise<void> {
    const ids = [...this.pendingAdvance];
    this.pendingAdvance.clear();
    for (const id of ids) {
      const r = this.find(id);
      if (r?.repeat) await this.completeOccurrence(r);
    }
  }

  /**
   * Change or remove (changes = null) the task line for an inline reminder,
   * then resync that note.
   */
  private async editInlineLine(r: Reminder, changes: LineChanges | null): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(r.notePath);
    if (!(file instanceof TFile)) {
      new Notice(`Note not found: ${r.notePath}`);
      this.reminders = this.reminders.filter((x) => x.id !== r.id);
      await this.saveAll();
      return;
    }

    // Find the line with the stored state, since r may already hold the new values.
    const stored = { ...r };
    let targetLine = -1;
    const newContent = await this.changeNote(file, (data) => {
      const lines = data.split("\n");
      const target = parseInline(file.path, data).find((p) => p.id === stored.id);
      if (!target) return data;
      targetLine = target.line;
      if (changes === null) lines.splice(target.line, 1);
      else lines[target.line] = rewriteInlineLine(lines[target.line], changes);
      return lines.join("\n");
    });

    if (targetLine < 0) {
      new Notice("Could not find this reminder's task line in the note. Rescanning.");
    } else if (changes !== null) {
      // The title may have changed, which changes the id. Carry the extra fields over.
      const placed = parseInline(file.path, newContent).find((p) => p.line === targetLine);
      if (placed && placed.id !== stored.id) {
        this.reminders = this.reminders.filter((x) => x.id !== placed.id);
        const rec = this.find(stored.id);
        if (rec) rec.id = placed.id;
      }
    }

    this.syncInlineFile(file.path, newContent, false);
    await this.saveAll();
  }

  /** Write a new task line (or add a marker to the current task) in the editor. */
  private insertInlineInEditor(
    r: Reminder,
    ctx: EditorContext
  ): { id: string; title: string; due: number; tags: string[] } | null {
    const { editor, file } = ctx;
    const lineNo = editor.getCursor().line;
    const current = editor.getLine(lineNo);
    const isTask = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s+/.test(current);
    const hasMarker = /@remind\(/i.test(current);
    const indent = /^\s*/.exec(current)?.[0] ?? "";
    const repeatText = r.repeat ? formatRepeat(r.repeat) : null;
    const beforeText = r.leadUps?.length ? formatLeadText(r.leadUps) : null;

    let targetLine: number;
    if (isTask && !hasMarker) {
      // Turn the existing task into a reminder.
      editor.setLine(
        lineNo,
        rewriteInlineLine(current, {
          title: r.title,
          due: r.due,
          repeat: r.repeat ? formatRepeat(r.repeat) : null,
          before: r.leadUps?.length ? formatLeadText(r.leadUps) : null,
          tags: r.tags ?? [],
        })
      );
      targetLine = lineNo;
    } else if (!current.trim()) {
      editor.setLine(lineNo, buildInlineLine(r.title, r.due, indent, repeatText, r.tags ?? [], beforeText));
      targetLine = lineNo;
    } else {
      editor.replaceRange(`\n${buildInlineLine(r.title, r.due, indent, repeatText, r.tags ?? [], beforeText)}`, {
        line: lineNo,
        ch: current.length,
      });
      targetLine = lineNo + 1;
    }

    const placed = parseInline(file.path, editor.getValue()).find((p) => p.line === targetLine);
    return placed ? { id: placed.id, title: placed.title, due: placed.due, tags: placed.tags } : null;
  }

  /** The open Markdown view showing this file, if any. */
  private openViewFor(file: TFile): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) return view;
    }
    return null;
  }

  /**
   * Change a note. When it's open in an editor, the change goes through the
   * Editor API so the cursor, selection and folds are kept. Otherwise it uses
   * Vault.process, which changes the file atomically. Returns the new text.
   */
  private async changeNote(file: TFile, transform: (data: string) => string): Promise<string> {
    const view = this.openViewFor(file);
    if (!view) return this.app.vault.process(file, transform);

    const editor = view.editor;
    const before = editor.getValue();
    const after = transform(before);
    if (after === before) return after;

    // Replace only the part that changed.
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
      endBefore--;
      endAfter--;
    }
    editor.replaceRange(after.slice(start, endAfter), editor.offsetToPos(start), editor.offsetToPos(endBefore));
    return after;
  }

  /** Use the open editor's text when available, since it can be newer than the file on disk. */
  private async freshContent(file: TFile): Promise<string> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) {
        return view.editor.getValue();
      }
    }
    return this.app.vault.cachedRead(file);
  }

  // ---------- Reminders file ----------

  reminderFilePath(): string {
    let p = (this.settings.reminderFilePath || DEFAULT_SETTINGS.reminderFilePath).trim();
    if (!p.toLowerCase().endsWith(".md")) p += ".md";
    return normalizePath(p);
  }

  scheduleFileWrite(delay = FILE_WRITE_DEBOUNCE_MS): void {
    if (!this.settings.fileSyncEnabled || !this.ready) return;
    if (this.fileWriteTimer !== null) window.clearTimeout(this.fileWriteTimer);
    this.fileWriteTimer = window.setTimeout(() => {
      this.fileWriteTimer = null;
      void this.writeReminderFile();
    }, delay);
  }

  async writeReminderFile(force = false): Promise<void> {
    if (!this.settings.fileSyncEnabled) return;

    // Save the user's edits to the file before regenerating it.
    if (this.commitTimer !== null) {
      window.clearTimeout(this.commitTimer);
      this.commitTimer = null;
      await this.commitFileEdits("edit");
      return; // commitFileEdits writes the file when it finishes.
    }
    if (this.commitPromise) await this.commitPromise;
    await this.writeReminderFileNow(force);
  }

  /** Regenerate the file. Callers must make sure the user's edits were saved first. */
  private async writeReminderFileNow(force: boolean): Promise<void> {
    if (!this.settings.fileSyncEnabled) return;
    const path = this.reminderFilePath();
    const content = buildReminderFile(this.reminders, this.settings, this.fileDrafts);

    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const current = await this.app.vault.read(existing);
        if (current.trim() && !current.includes(FILE_MARKER)) {
          // Never overwrite a note the user wrote themselves.
          new Notice(
            `Reminder Toast: "${path}" already has your own content, so it was not overwritten. ` +
              "Pick an empty note or a new file name for the reminders file.",
            10000
          );
          return;
        }
        // Never write over typing that has not been saved to disk yet.
        if (this.hasUnsavedEdits(existing, current)) {
          this.scheduleFileWrite(3000);
          return;
        }
        if (!force && sameIgnoringStamp(current, content)) {
          this.lastFileContent = current;
          return;
        }
        this.lastFileContent = content;
        let blocked = false;
        const written = await this.changeNote(existing, (data) => {
          // Checked again here so a note written in the meantime is never replaced.
          if (data.trim() && !data.includes(FILE_MARKER)) {
            blocked = true;
            return data;
          }
          return !force && sameIgnoringStamp(data, content) ? data : content;
        });
        this.lastFileContent = written;
        if (blocked) new Notice(`Reminder Toast: "${path}" already has your own content, so it was not overwritten.`);
      } else if (existing) {
        new Notice(`Reminder Toast: "${path}" is a folder, not a file. Pick another reminders file.`);
      } else {
        await this.ensureFolder(path);
        this.lastFileContent = content;
        await this.app.vault.create(path, content);
      }
    } catch (e) {
      console.error("Reminder Toast: could not write reminders file", e);
      new Notice(`Reminder Toast: could not write "${path}".`);
    }
  }

  private hasUnsavedEdits(file: TFile, onDisk: string): boolean {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path && view.editor.getValue() !== onDisk) {
        return true;
      }
    }
    return false;
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`${current} is not a folder`);
    }
  }

  /** The user changed the reminders file. Wait until they pause, then save their edits. */
  private onReminderFileEdited(): void {
    if (!this.settings.fileSyncEnabled) return;
    if (this.commitTimer !== null) window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      this.commitTimer = null;
      void this.commitFileEdits("edit");
    }, FILE_COMMIT_DELAY_MS);
  }

  /** Save edits right away, e.g. when the user switches to another note. */
  private flushFileEdits(): void {
    if (this.commitTimer === null) return;
    window.clearTimeout(this.commitTimer);
    this.commitTimer = null;
    void this.commitFileEdits("edit");
  }

  /** Apply edits from the reminders file, one run at a time. */
  private async commitFileEdits(mode: "edit" | "startup"): Promise<void> {
    const previous = this.commitPromise;
    const run = (async () => {
      if (previous) await previous;
      try {
        await this.applyFileEdits(mode);
      } catch (e) {
        console.error("Reminder Toast: could not read reminders file edits", e);
      }
    })();
    this.commitPromise = run;
    try {
      await run;
    } finally {
      if (this.commitPromise === run) this.commitPromise = null;
    }
  }

  /**
   * Read the reminders file and apply what changed: new task lines become
   * reminders, edited lines update their reminder, and deleted lines delete it.
   * On startup only new lines are added, since the file may be older than the
   * plugin's data (for example after a sync).
   */
  private async applyFileEdits(mode: "edit" | "startup"): Promise<void> {
    if (!this.settings.fileSyncEnabled) return;
    const path = this.reminderFilePath();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.writeReminderFileNow(true);
      return;
    }

    const content = await this.app.vault.read(file);
    if (!content.includes(FILE_MARKER)) return;
    // Still typing (the editor has changes not saved to disk yet): try again shortly.
    if (mode === "edit" && this.hasUnsavedEdits(file, content)) {
      this.onReminderFileEdited();
      return;
    }
    if (content === this.lastFileContent) return;

    const parsed = parseReminderFile(content);
    const seen = new Set<string>();
    let changed = false;
    let added = 0;
    let deleted = 0;
    let inlineKept = 0;

    for (const e of parsed.entries) {
      const r = e.id ? this.find(e.id) : undefined;

      if (r) {
        seen.add(r.id);
        if (mode === "startup") continue;

        const messageChanged = fileMessage(r.message) !== e.message;
        if (r.inline) {
          if (messageChanged) {
            r.message = e.message;
            changed = true;
          }
          // Checking a repeating inline reminder moves it to its next occurrence.
          if (e.completed && !r.completed && r.repeat) {
            await this.completeOccurrence(r);
            continue;
          }
          const lineChanges: LineChanges = {};
          if (e.title && e.title !== r.title) lineChanges.title = e.title;
          if (e.due !== null && e.due !== r.due) lineChanges.due = e.due;
          if (e.completed !== r.completed) lineChanges.completed = e.completed;
          const fileRepeat = this.fileRule(e.repeatText, e.due ?? r.due, r);
          if (fileRepeat !== undefined && !sameRule(fileRepeat, r.repeat)) {
            lineChanges.repeat = fileRepeat ? formatRepeat(fileRepeat) : null;
            r.repeat = fileRepeat;
          }
          const inlineLeads = this.fileLeads(e.beforeText);
          if (inlineLeads !== undefined && !sameLeads(inlineLeads, r.leadUps)) {
            lineChanges.before = inlineLeads.length ? formatLeadText(inlineLeads) : null;
            r.leadUps = inlineLeads;
            delete r.leadBase;
          }
          if (Object.keys(lineChanges).length) {
            if (lineChanges.title !== undefined) r.title = lineChanges.title;
            if (lineChanges.due !== undefined) r.due = lineChanges.due;
            if (lineChanges.completed !== undefined) r.completed = lineChanges.completed;
            await this.editInlineLine(r, lineChanges);
          }
          continue;
        }

        if (e.title && e.title !== r.title) {
          r.title = e.title;
          changed = true;
        }
        if (e.due !== null && e.due !== r.due) {
          r.due = e.due;
          r.fired = false;
          changed = true;
        }
        const fileRepeat = this.fileRule(e.repeatText, e.due ?? r.due, r);
        if (fileRepeat !== undefined && !sameRule(fileRepeat, r.repeat)) {
          r.repeat = fileRepeat;
          if (fileRepeat) r.occurrence = r.due;
          else delete r.occurrence;
          changed = true;
        }
        if (e.completed && !r.completed && r.repeat) {
          await this.completeOccurrence(r);
          continue;
        }
        if (e.completed !== r.completed) {
          r.completed = e.completed;
          if (e.completed) r.fired = true;
          changed = true;
        }
        const fileLeads = this.fileLeads(e.beforeText);
        if (fileLeads !== undefined && !sameLeads(fileLeads, r.leadUps)) {
          r.leadUps = fileLeads;
          delete r.leadBase;
          changed = true;
        }
        if (e.tags.join(" ") !== (r.tags ?? []).join(" ")) {
          r.tags = e.tags;
          this.registerTags(r);
          changed = true;
        }
        if (messageChanged) {
          r.message = e.message;
          changed = true;
        }
        const notePath = this.resolveLink(e.link, path);
        if (notePath !== r.notePath) {
          r.notePath = notePath;
          changed = true;
        }
        continue;
      }

      // A stale line for an inline reminder; it is rebuilt from the note.
      if (e.id && e.fromNote) continue;
      if (e.due === null) continue;

      // A line the user added (or one whose reminder no longer exists).
      const repeat = e.repeatText ? parseRepeat(e.repeatText, e.due) : null;
      const created = newReminder({
        title: e.title || "Untitled reminder",
        due: e.due,
        message: e.message,
        completed: e.completed,
        fired: e.completed,
        notePath: this.resolveLink(e.link, path),
        tags: e.tags,
        repeat,
        leadUps: this.fileLeads(e.beforeText) ?? [],
      });
      if (repeat) created.occurrence = e.due;
      this.registerTags(created);
      this.reminders.push(created);
      added++;
      changed = true;
    }

    // Lines removed since the last time this device wrote the file.
    if (mode === "edit" && this.lastFileContent) {
      for (const id of idsIn(this.lastFileContent)) {
        if (seen.has(id)) continue;
        const r = this.find(id);
        if (!r) continue;
        if (r.inline) {
          inlineKept++;
          continue;
        }
        this.reminders = this.reminders.filter((x) => x.id !== id);
        deleted++;
        changed = true;
      }
    }

    if (JSON.stringify(parsed.drafts) !== JSON.stringify(this.fileDrafts)) {
      this.fileDrafts = parsed.drafts;
      changed = true;
    }

    if (changed) {
      await this.persist();
      this.refreshViews();
      this.scheduleNextCheck();
    }

    const notes: string[] = [];
    if (added) notes.push(`added ${added} reminder${added === 1 ? "" : "s"}`);
    if (deleted) notes.push(`deleted ${deleted} reminder${deleted === 1 ? "" : "s"}`);
    if (notes.length) new Notice(`Reminders file: ${notes.join(", ")}.`);
    if (inlineKept) {
      new Notice(
        "Inline reminders live in their notes, so they were kept. Delete the task line in the note to remove one.",
        8000
      );
    }

    // Rewrite to add ids to new lines and tidy the layout.
    await this.writeReminderFileNow(true);
  }

  /**
   * The repeat rule a reminders file line asks for: null to stop repeating,
   * undefined when the text could not be read (the current rule is kept).
   */
  private fileRule(text: string | null, due: number, r: Reminder): RepeatRule | null | undefined {
    if (!text) return null;
    if (r.repeat && formatRepeat(r.repeat) === text.trim().toLowerCase()) return r.repeat;
    const rule = parseRepeat(text, r.repeat?.start ?? due);
    if (!rule) {
      new Notice(`Reminders file: could not read @repeat(${text}).`);
      return undefined;
    }
    return isOccurrence(rule, due) ? rule : parseRepeat(text, due);
  }

  /** Lead-ups a reminders file line asks for, or undefined when @before(...) can't be read. */
  private fileLeads(text: string | null): number[] | undefined {
    if (!text) return [];
    const leads = parseLeadText(text);
    if (!leads) {
      new Notice(`Reminders file: could not read @before(${text}). Use something like 30m, 1h or 1h30m.`);
      return undefined;
    }
    return leads;
  }

  /** Turn [[Link]] text into a vault path. */
  private resolveLink(link: string | null, sourcePath: string): string {
    if (!link) return "";
    const dest = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
    if (dest) return dest.path;
    return normalizePath(link.endsWith(".md") ? link : `${link}.md`);
  }

  async openReminderFile(): Promise<void> {
    if (!this.settings.fileSyncEnabled) {
      new Notice("Turn on saving reminders to a file in the plugin settings first.");
      return;
    }
    await this.writeReminderFile();
    await this.openNote(this.reminderFilePath());
  }

  // ---------- Scheduling ----------

  private scheduleNextCheck(): void {
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
    this.checkDue();

    const now = Date.now();
    let next = this.reminders
      .filter((r) => !r.fired && !r.completed)
      .reduce((min, r) => Math.min(min, r.due), Infinity);
    // Also wake up for the next lead-up toast.
    for (const r of this.reminders) {
      const target = this.leadTarget(r);
      if (target === null || target <= now) continue;
      const shown = r.leadBase === target ? new Set(r.leadsFired ?? []) : new Set<number>();
      for (const m of r.leadUps ?? []) {
        const at = target - m * 60000;
        if (at > now && !shown.has(m)) next = Math.min(next, at);
      }
    }
    const wait = Number.isFinite(next) ? Math.max(250, Math.min(next - now, MAX_WAIT_MS)) : MAX_WAIT_MS;

    this.checkTimer = window.setTimeout(() => this.scheduleNextCheck(), wait);
    this.updateStatusBar();
  }

  private checkDue(): void {
    if (!this.ready) return;
    const now = Date.now();
    this.rollRepeats(now);
    const leadsChanged = this.checkLeads(now);
    const due = this.reminders.filter((r) => !r.fired && !r.completed && r.due <= now);
    if (!due.length) {
      if (leadsChanged) void this.persist();
      return;
    }
    for (const r of due) {
      r.fired = true;
      this.fireToast(r);
    }
    void this.afterFired();
  }

  private async afterFired(): Promise<void> {
    await this.persist();
    this.refreshViews();
    // Moves the reminder from Upcoming to Due in the reminders file.
    this.scheduleFileWrite();
  }

  /**
   * The due time the lead-ups count back from: the reminder's due time, or for a
   * repeating reminder that already went off, its next occurrence.
   */
  private leadTarget(r: Reminder): number | null {
    if (r.completed || !r.leadUps?.length) return null;
    if (!r.fired) return r.due;
    if (r.repeat) return nextAfter(r.repeat, r.occurrence ?? r.due);
    return null;
  }

  /** Show lead-up toasts that are due. Returns true when stored state changed. */
  private checkLeads(now: number): boolean {
    let changed = false;
    for (const r of this.reminders) {
      const target = this.leadTarget(r);
      if (target === null) continue;
      const leads = normalizeLeads(r.leadUps);

      // New time or new lead-ups: lead-ups that are already in the past are skipped.
      if (r.leadBase !== target) {
        r.leadBase = target;
        r.leadsFired = leads.filter((m) => target - m * 60000 <= now);
        changed = true;
        continue;
      }
      if (target <= now) continue;

      const shown = new Set(r.leadsFired ?? []);
      const pending = leads.filter((m) => !shown.has(m) && target - m * 60000 <= now);
      if (!pending.length) continue;

      // Several came due at once (for example after Obsidian was closed): show only the closest.
      r.leadsFired = [...shown, ...pending];
      this.fireLeadToast(r, Math.min(...pending), target);
      changed = true;
    }
    return changed;
  }

  /**
   * A repeating reminder that was not marked done keeps waiting in Due until its
   * next occurrence arrives. Then it moves to that occurrence and fires again.
   */
  private rollRepeats(now: number): void {
    for (const r of this.reminders) {
      if (!r.repeat || !r.fired || r.completed) continue;
      let occ = r.occurrence ?? r.due;
      let next = nextAfter(r.repeat, occ);
      if (next === null || next > now) continue;
      for (let guard = 0; next !== null && next <= now && guard < 10000; guard++) {
        occ = next;
        next = nextAfter(r.repeat, occ);
      }
      r.occurrence = occ;
      r.due = occ;
      r.fired = false;
      if (r.inline) {
        // Keep the note's @remind date in step.
        void this.editInlineLine(r, { due: occ, completed: false });
      }
    }
  }

  /** On startup, decide what to do with reminders that came due while Obsidian was closed. */
  private handleMissed(): void {
    if (this.settings.fireMissedOnStartup) return; // checkDue will fire them normally.
    const now = Date.now();
    let changed = false;
    for (const r of this.reminders) {
      if (!r.fired && !r.completed && r.due <= now) {
        if (r.repeat) {
          // Skip the missed occurrences and wait for the next one.
          this.advance(r);
          if (r.inline) void this.editInlineLine(r, { due: r.due, completed: r.completed });
        } else {
          r.fired = true;
        }
        changed = true;
      }
    }
    if (changed) void this.saveAll();
  }

  // ---------- Toasts ----------

  fireToast(r: Reminder, opts: { preview?: boolean } = {}): void {
    const { title, body } = toastContent(r, this.settings);
    const actions = [];

    if (!opts.preview) {
      actions.push({
        label: "Done",
        cta: true,
        onClick: () => this.setCompleted(r.id, true),
      });
      actions.push({
        label: `Snooze ${this.settings.snoozeMinutes}m`,
        onClick: () => this.snooze(r.id, this.settings.snoozeMinutes),
      });
    }
    if (r.notePath) {
      actions.push({ label: "Open note", onClick: () => this.openNote(r.notePath) });
    }

    this.showEverywhere(
      {
        title,
        body,
        durationSec: this.settings.toastDurationSec,
        flash: this.settings.flash,
        position: this.settings.position,
        accentColor: reminderColor(r, this.settings, false) || this.settings.accentColor,
        actions,
      },
      opts.preview ? "preview" : "normal"
    );

    if (this.settings.playSound) playChime();
    if (this.settings.systemNotification && !opts.preview) void showSystemNotification(title, body);
  }

  /** A heads-up toast shown `minutes` before `at`. */
  fireLeadToast(r: Reminder, minutes: number, at: number, opts: { preview?: boolean } = {}): void {
    const { title, body } = leadToastContent(r, this.settings, minutes, at);
    const actions = [];
    if (!opts.preview && !r.repeat && !r.fired) {
      actions.push({ label: "Mark done", onClick: () => this.setCompleted(r.id, true) });
    }
    if (r.notePath) actions.push({ label: "Open note", onClick: () => this.openNote(r.notePath) });

    this.showEverywhere(
      {
        title,
        body,
        durationSec: this.settings.toastDurationSec,
        flash: this.settings.flash,
        position: this.settings.position,
        accentColor: reminderColor(r, this.settings, false) || this.settings.accentColor,
        actions,
        icon: "alarm-clock",
        cls: "rt-toast-lead",
      },
      opts.preview ? "preview" : "normal"
    );

    if (this.settings.playSound) playChime();
    if (this.settings.systemNotification && !opts.preview) void showSystemNotification(title, body);
  }

  // ---------- Toast windows ----------

  /**
   * Show a toast in the main window and in any popped-out calendar windows,
   * plus a toast in its own pop-out window when Obsidian isn't in front.
   * All copies are linked: a button in one dismisses them all.
   * mode "desktop" forces the pop-out toast (for the settings test button).
   */
  showEverywhere(opts: ToastOptions, mode: "normal" | "preview" | "desktop" = "normal"): void {
    const closers: Array<() => void> = [];
    let done = false;
    const closeAll = () => {
      if (done) return;
      done = true;
      for (const c of closers) c();
    };
    const linked: ToastOptions = {
      ...opts,
      actions: opts.actions.map((a) => ({
        ...a,
        onClick: () => {
          a.onClick();
          closeAll();
        },
      })),
    };

    const windows = this.toastWindows();
    if (mode !== "desktop") {
      for (const win of windows) closers.push(this.toasts.show(linked, win.document, closeAll));
    }

    const popup = this.showPopupToast(linked, windows, closeAll, mode === "desktop");
    if (popup) closers.push(popup);
  }

  /** The main window, plus popped-out calendar windows when that setting is on. */
  private toastWindows(): Window[] {
    const wins: Window[] = [window];
    if (this.settings.toastInPopout && Platform.isDesktopApp) {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
        const win = leaf.view.containerEl.win;
        if (win && win !== window && !wins.includes(win)) wins.push(win);
      }
    }
    return wins;
  }

  private showPopupToast(
    opts: ToastOptions,
    windows: Window[],
    closeAll: () => void,
    force: boolean
  ): (() => void) | null {
    const popups = this.popups;
    if (!popups) {
      if (force) new Notice("Pop-out toasts aren't available on this system.");
      return null;
    }
    const mode = this.settings.desktopToast;
    if (mode === "never" && !force) return null;

    // Which windows can't be seen right now?
    const anyFocused = windows.some((w) => w.document.hasFocus());
    const targets = force
      ? windows
      : mode === "unfocused"
        ? anyFocused
          ? []
          : windows
        : windows.filter((w) => w.document.visibilityState === "hidden");
    if (!targets.length) return null;

    // One pop-out toast per screen those windows are on.
    const areas: ScreenArea[] = [];
    for (const w of targets) {
      const area = screenAreaFor(w);
      if (!areas.some((a) => a.key === area.key)) areas.push(area);
    }

    return popups.show(
      opts,
      areas,
      () => this.bringObsidianForward(),
      closeAll
    );
  }

  /** Focus the main Obsidian window. */
  private bringObsidianForward(): void {
    window.focus();
  }

  /** Close the pop-out toasts when the user returns to a window that shows its own toast. */
  private watchWindow(win: Window): void {
    this.registerDomEvent(win, "focus", () => {
      if (!this.popups?.isPopupWindow(win)) this.popups?.closeAll();
    });
  }

  // ---------- Pop-out calendar ----------

  /** Open the calendar in its own window. Reuses one that's already open with the same settings. */
  async popOutCalendar(state: CalendarViewState = {}): Promise<void> {
    if (!Platform.isDesktopApp) {
      new Notice("Popping out the calendar needs the desktop app.");
      return;
    }
    const key = calendarStateKey(state);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
      const view = leaf.view;
      if (!(view instanceof ReminderCalendarView)) continue;
      if (view.containerEl.win !== window && calendarStateKey(view.getState()) === key) {
        void this.app.workspace.revealLeaf(leaf);
        view.containerEl.win.focus();
        return;
      }
    }
    const leaf = this.app.workspace.openPopoutLeaf({ size: { width: 460, height: 620 } });
    await leaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true, state: { ...state } });
  }

  // ---------- UI helpers ----------

  openCreateModal(prefill: Partial<Reminder> = {}, ctx?: EditorContext): void {
    new ReminderModal(this.app, this, null, (r) => void this.createReminder(r, ctx), prefill, ctx).open();
  }

  private activeEditorContext(): EditorContext | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && view.getMode() === "source") return { editor: view.editor, file: view.file };
    return undefined;
  }

  /** Selected text, or the current line without its bullet or checkbox. */
  private titleFromEditor(editor: Editor): string {
    const selection = editor.getSelection().trim();
    if (selection) return selection.split("\n")[0].trim();
    return editor
      .getLine(editor.getCursor().line)
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, "")
      .replace(/^#+\s+/, "")
      .trim();
  }

  async openNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice(`Note not found: ${path}`);
    }
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_REMINDERS)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE_REMINDERS, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REMINDERS)) {
      const view = leaf.view;
      if (view instanceof ReminderListView) view.render();
    }
    for (const calendar of this.calendars) calendar.render();
    this.updateStatusBar();
  }

  // ---------- Calendar ----------

  async activateCalendar(): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true });
    }
    void workspace.revealLeaf(leaf);
    return leaf;
  }

  /**
   * Reminders to show between two times, including future occurrences of
   * repeating reminders, so they appear on every day they repeat.
   */
  itemsInRange(from: number, to: number): CalendarItem[] {
    const items: CalendarItem[] = [];
    for (const r of this.reminders) {
      if (r.due >= from && r.due <= to) items.push({ reminder: r, at: r.due, projected: false });
      if (!r.repeat || r.completed) continue;
      const after = Math.max(r.occurrence ?? r.due, r.due);
      for (const at of occurrencesBetween(r.repeat, Math.max(from, after + 1), to, 400)) {
        items.push({ reminder: r, at, projected: true });
      }
    }
    return items.sort((a, b) => a.at - b.at);
  }

  /** A time on the given day for a new reminder, using the default time setting. */
  dueOnDay(day: Moment): number {
    const [h, m] = (this.settings.defaultTime || "09:00").split(":").map((n) => parseInt(n, 10));
    const at = day.clone().hour(isNaN(h) ? 9 : h).minute(isNaN(m) ? 0 : m).second(0).millisecond(0);
    // Adding to today after the default time: use the next full hour instead.
    if (at.valueOf() <= Date.now() && day.isSame(moment(), "day")) {
      return moment().add(1, "hour").startOf("hour").valueOf();
    }
    return at.valueOf();
  }

  /** The code block that embeds the calendar in a note. */
  calendarBlock(): string {
    return "```" + CALENDAR_CODE_BLOCK + "\n```";
  }

  insertCalendarBlock(editor: Editor): void {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    // Keep the callout prefix ("> ") so it works inside callout columns.
    const prefix = /^(\s*(?:>\s*)+)/.exec(line)?.[1] ?? "";
    const block = this.calendarBlock()
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
    if (line.trim() && line.trim() !== prefix.trim()) {
      editor.replaceRange(`\n${block}\n`, { line: cursor.line, ch: line.length });
    } else {
      editor.replaceRange(block, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
    }
  }

  async copyCalendarEmbed(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.calendarBlock());
      new Notice("Copied. Paste it into a note to show the calendar there.");
    } catch {
      new Notice(`Add this to a note: ${this.calendarBlock()}`);
    }
  }

  /** Open the dialog with a copy of a reminder: same title, color, tags, repeat and toast text. */
  openSimilarModal(r: Reminder): void {
    const now = Date.now();
    let due = r.due;
    if (due <= now) {
      const src = moment(r.due);
      due = moment().add(1, "day").hour(src.hour()).minute(src.minute()).second(0).millisecond(0).valueOf();
    }
    this.openCreateModal({
      title: r.title,
      message: r.message,
      due,
      color: r.color ?? "",
      tags: [...(r.tags ?? [])],
      repeat: r.repeat ? { ...r.repeat, weekdays: [...r.repeat.weekdays], start: due } : null,
      notePath: r.notePath,
      toastTitle: r.toastTitle,
      toastBody: r.toastBody,
      leadUps: [...(r.leadUps ?? [])],
    });
  }

  colorOf(r: Reminder): string {
    return reminderColor(r, this.settings);
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const now = Date.now();
    const active = this.reminders.filter((r) => !r.completed);
    const dueCount = active.filter((r) => r.due <= now).length;
    const next = active.filter((r) => r.due > now).sort((a, b) => a.due - b.due)[0];

    this.statusBarEl.empty();
    if (!dueCount && !next) return;

    setIcon(this.statusBarEl.createSpan({ cls: "rt-status-icon" }), "bell");
    if (dueCount) {
      this.statusBarEl.createSpan({ text: `${dueCount} due` });
      this.statusBarEl.setAttr("aria-label", "Open reminders");
    } else if (next) {
      this.statusBarEl.createSpan({ text: moment(next.due).fromNow() });
      this.statusBarEl.setAttr("aria-label", `Next: ${next.title}`);
    }
  }
}
