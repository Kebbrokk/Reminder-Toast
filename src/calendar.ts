import {
  Component,
  ItemView,
  MarkdownRenderChild,
  Menu,
  Platform,
  ViewStateResult,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { moment, type Moment } from "./moment";
import type ReminderToastPlugin from "../main";
import type { CalendarItem } from "../main";
import type { Reminder } from "./types";
import { ConfirmModal, ReminderModal } from "./modal";
import { describeRepeat } from "./repeat";
import { normalizeLeads, shortLead } from "./leads";
import { onContextOrLongPress } from "./touch";
import { BG_FITS, BG_POSITIONS, ImagePickerModal, applyBackground, resolveImage } from "./background";
import type { BackgroundSettings, BgFit } from "./types";

export const VIEW_TYPE_CALENDAR = "reminder-toast-calendar";
export const CALENDAR_CODE_BLOCK = "reminder-calendar";

const MAX_DOTS = 4;
const DOUBLE_TAP_MS = 350;

export interface CalendarOptions {
  /** Shown inside a note instead of the sidebar. */
  embedded: boolean;
  /** Show the list of reminders for the selected day. */
  agenda: boolean;
  /** Only show reminders with at least one of these tags. New reminders get them too. */
  tags: string[];
  /** Month to open on. Defaults to the current month. */
  month: Moment | null;
  /** Sidebar leaf, for the pin button. */
  leaf?: WorkspaceLeaf;
  /** Element that shows the background image. Defaults to the calendar itself. */
  bgHost?: HTMLElement;
  /** Background settings from the code block, layered over the embed default. */
  background?: Partial<BackgroundSettings>;
  /** Note the calendar is in, for resolving [[image]] links. */
  sourcePath?: string;
  /** Which background setting to start from. Defaults to "embed" for embeds and "sidebar" otherwise. */
  bgBase?: "sidebar" | "embed";
}

/** Saved with a calendar view, so a popped-out calendar keeps its filters after a restart. */
export interface CalendarViewState {
  tags?: string[];
  agenda?: boolean;
  background?: Partial<BackgroundSettings>;
  bgBase?: "sidebar" | "embed";
  sourcePath?: string;
}

/** Normalized key for comparing view states. */
export function calendarStateKey(state: CalendarViewState): string {
  return JSON.stringify({
    tags: (state.tags ?? []).map((t) => t.toLowerCase()).sort(),
    agenda: state.agenda !== false,
    background: state.background ?? {},
    bgBase: state.bgBase ?? "sidebar",
  });
}

/**
 * The month calendar. Used by the sidebar view and by ```reminder-calendar```
 * blocks in notes. It sizes itself to its container, so it works in narrow
 * columns and on phones.
 */
export class CalendarRenderer {
  private month: Moment;
  private selected = moment().format("YYYY-MM-DD");
  private todayKey = moment().format("YYYY-MM-DD");
  private lastTap = { key: "", at: 0 };
  /** Popped-out window showing only this calendar, with the tabs and toolbar hidden. */

  constructor(
    private plugin: ReminderToastPlugin,
    private root: HTMLElement,
    host: Component,
    private opts: CalendarOptions
  ) {
    this.month = (opts.month ?? moment()).clone().startOf("month");
    if (opts.month && !moment().isSame(opts.month, "month")) {
      this.selected = this.month.format("YYYY-MM-DD");
    }

    plugin.calendars.add(this);
    host.register(() => plugin.calendars.delete(this));
    // Move the "today" highlight at midnight and keep times fresh.
    host.registerInterval(
      window.setInterval(() => {
        const key = moment().format("YYYY-MM-DD");
        if (key !== this.todayKey) {
          if (this.selected === this.todayKey) this.selected = key;
          this.todayKey = key;
        }
        this.render();
      }, 60 * 1000)
    );

    if (opts.embedded) {
      // In Live Preview, clicks inside the calendar should not open the block's source for editing.
      for (const type of ["mousedown", "click", "touchstart"]) {
        root.addEventListener(type, (e) => e.stopPropagation());
      }
    }
  }

  render(): void {
    const root = this.root;
    if (!root.isConnected) return;
    root.empty();
    root.addClass("rt-cal");
    root.toggleClass("rt-cal-embedded", this.opts.embedded);
    this.todayKey = moment().format("YYYY-MM-DD");
    this.applyBackground();


    // The outer element measures the width; this inner one is laid out from it.
    const body = root.createDiv({ cls: "rt-cal-body" });
    this.renderHeader(body);

    const weekStart = this.plugin.settings.weekStart === 1 ? 1 : 0;
    const first = this.month.clone();
    const gridStart = first.clone().subtract((first.day() - weekStart + 7) % 7, "days");
    const lastOfMonth = this.month.clone().endOf("month");
    const weeks = Math.ceil((lastOfMonth.diff(gridStart, "days") + 1) / 7);
    const gridEnd = gridStart.clone().add(weeks * 7 - 1, "days").endOf("day");

    const byDay = new Map<string, CalendarItem[]>();
    for (const item of this.items(gridStart.valueOf(), gridEnd.valueOf())) {
      const key = moment(item.at).format("YYYY-MM-DD");
      const list = byDay.get(key) ?? [];
      list.push(item);
      byDay.set(key, list);
    }

    const grid = body.createDiv({ cls: "rt-cal-grid" });
    for (let i = 0; i < 7; i++) {
      const wd = moment().day((weekStart + i) % 7);
      const cell = grid.createDiv({ cls: "rt-cal-weekday" });
      cell.createSpan({ cls: "rt-cal-wd-long", text: wd.format("dd") });
      cell.createSpan({ cls: "rt-cal-wd-short", text: wd.format("dd").charAt(0) });
    }

    for (let i = 0; i < weeks * 7; i++) {
      const day = gridStart.clone().add(i, "days");
      const key = day.format("YYYY-MM-DD");
      this.renderDay(grid, day, key, byDay.get(key) ?? []);
    }

    if (this.opts.agenda) this.renderAgenda(body, byDay.get(this.selected) ?? this.itemsForDay(this.selected));
  }

  /** True when this calendar is in a popped-out window. */
  private inPopout(): boolean {
    return this.root.win !== window;
  }

  /** Settings to carry into a popped-out window. */
  private popoutState(): CalendarViewState {
    const state: CalendarViewState = {};
    if (this.opts.tags.length) state.tags = [...this.opts.tags];
    if (!this.opts.agenda) state.agenda = false;
    if (this.opts.embedded) {
      state.bgBase = "embed";
      if (this.opts.background && Object.keys(this.opts.background).length) state.background = { ...this.opts.background };
      if (this.opts.sourcePath) state.sourcePath = this.opts.sourcePath;
    }
    return state;
  }

  // ---------- Background ----------

  private backgroundConfig(): BackgroundSettings {
    const s = this.plugin.settings;
    const base = (this.opts.bgBase ?? (this.opts.embedded ? "embed" : "sidebar")) === "embed" ? s.embedBackground : s.sidebarBackground;
    return { ...base, ...(this.opts.background ?? {}) };
  }

  private applyBackground(): void {
    const host = this.opts.bgHost ?? this.root;
    const cfg = this.backgroundConfig();
    const resolved = resolveImage(this.plugin.app, cfg.image, this.opts.sourcePath ?? "");
    applyBackground(host, resolved?.url ?? null, cfg);
    this.root.toggleClass("rt-cal-missing-bg", !!cfg.image.trim() && !resolved);
  }

  private pickBackground(): void {
    new ImagePickerModal(this.plugin.app, async (file: TFile) => {
      const s = this.plugin.settings;
      const target = (this.opts.bgBase ?? (this.opts.embedded ? "embed" : "sidebar")) === "embed" ? s.embedBackground : s.sidebarBackground;
      target.image = file.path;
      await this.plugin.saveAll();
    }).open();
  }

  private async clearBackground(): Promise<void> {
    const s = this.plugin.settings;
    ((this.opts.bgBase ?? (this.opts.embedded ? "embed" : "sidebar")) === "embed" ? s.embedBackground : s.sidebarBackground).image = "";
    await this.plugin.saveAll();
  }

  // ---------- Data ----------

  private items(from: number, to: number): CalendarItem[] {
    const all = this.plugin.itemsInRange(from, to);
    if (!this.opts.tags.length) return all;
    const want = new Set(this.opts.tags.map((t) => t.toLowerCase()));
    return all.filter((i) => (i.reminder.tags ?? []).some((t) => want.has(t.toLowerCase())));
  }

  private itemsForDay(key: string): CalendarItem[] {
    const day = moment(key, "YYYY-MM-DD");
    return this.items(day.clone().startOf("day").valueOf(), day.clone().endOf("day").valueOf());
  }

  // ---------- Header ----------

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "rt-cal-header" });

    const nav = header.createDiv({ cls: "rt-cal-nav" });
    this.iconButton(nav, "chevron-left", "Previous month", () => {
      this.month.subtract(1, "month");
      this.render();
    });
    const title = nav.createEl("button", { cls: "rt-cal-title", attr: { "aria-label": "Go to today" } });
    title.createSpan({ cls: "rt-cal-title-long", text: this.month.format("MMMM YYYY") });
    title.createSpan({ cls: "rt-cal-title-short", text: this.month.format("MMM YYYY") });
    title.addEventListener("click", () => this.goToday());
    this.iconButton(nav, "chevron-right", "Next month", () => {
      this.month.add(1, "month");
      this.render();
    });

    const actions = header.createDiv({ cls: "rt-cal-actions" });
    const todayBtn = actions.createEl("button", { cls: "rt-small-btn rt-cal-today-btn", text: "Today" });
    todayBtn.addEventListener("click", () => this.goToday());

    this.iconButton(actions, "plus", "New reminder on selected day", () => this.addOn(moment(this.selected)));

    // Pop out into its own window (desktop).
    if (Platform.isDesktopApp && !this.inPopout()) {
      this.iconButton(actions, "picture-in-picture-2", "Pop out into its own window", () =>
        this.plugin.popOutCalendar(this.popoutState())
      );
    }

    const leaf = this.opts.leaf;
    if (leaf && !this.inPopout()) {
      const pinned = !!leaf.getViewState().pinned;
      const pin = this.iconButton(actions, pinned ? "pin-off" : "pin", pinned ? "Unpin calendar" : "Pin calendar", () =>
        leaf.togglePinned()
      );
      if (pinned) pin.addClass("is-active");
    }

    if (this.opts.tags.length) {
      const filter = root.createDiv({ cls: "rt-cal-filter" });
      setIcon(filter.createSpan({ cls: "rt-cal-filter-icon" }), "filter");
      for (const t of this.opts.tags) filter.createSpan({ cls: "rt-cal-tag", text: `#${t}` });
    }
  }

  // ---------- Days ----------

  private renderDay(grid: HTMLElement, day: Moment, key: string, items: CalendarItem[]): void {
    const cell = grid.createDiv({ cls: "rt-cal-day", attr: { role: "button", tabindex: "0" } });
    if (!day.isSame(this.month, "month")) cell.addClass("is-other-month");
    if (key === this.todayKey) cell.addClass("is-today");
    if (key === this.selected) cell.addClass("is-selected");
    if (day.day() === 0 || day.day() === 6) cell.addClass("is-weekend");
    if (items.some((i) => !i.reminder.completed && i.at <= Date.now() && !i.projected)) cell.addClass("has-due");

    cell.setAttr(
      "aria-label",
      `${day.format("dddd, MMMM D")}: ${items.length || "no"} reminder${items.length === 1 ? "" : "s"}`
    );
    cell.createDiv({ cls: "rt-cal-num", text: String(day.date()) });

    if (items.length) {
      const dots = cell.createDiv({ cls: "rt-cal-dots" });
      for (const item of items.slice(0, MAX_DOTS)) {
        const dot = dots.createSpan({ cls: "rt-cal-dot" });
        const color = this.plugin.colorOf(item.reminder);
        if (color) dot.style.setProperty("--rt-dot", color);
        if (item.reminder.completed) dot.addClass("is-completed");
      }
      if (items.length > MAX_DOTS) dots.createSpan({ cls: "rt-cal-more", text: `+${items.length - MAX_DOTS}` });
    }

    // Tap selects; a second tap on the same day adds a reminder (works for mouse and touch).
    cell.addEventListener("click", () => {
      const now = Date.now();
      if (this.lastTap.key === key && now - this.lastTap.at < DOUBLE_TAP_MS) {
        this.lastTap = { key: "", at: 0 };
        this.addOn(day);
        return;
      }
      this.lastTap = { key, at: now };
      this.selected = key;
      if (!day.isSame(this.month, "month")) this.month = day.clone().startOf("month");
      this.render();
    });
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.selected = key;
        this.render();
      }
    });
    onContextOrLongPress(cell, (at) => {
      this.selected = key;
      this.render();
      this.dayMenu(day, items).showAtPosition(at);
    });
  }

  private dayMenu(day: Moment, items: CalendarItem[]): Menu {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(`Add reminder on ${day.format("MMM D")}`)
        .setIcon("bell-plus")
        .onClick(() => this.addOn(day))
    );
    menu.addItem((i) =>
      i
        .setTitle(`Add weekly reminder on ${day.format("dddd")}s`)
        .setIcon("repeat")
        .onClick(() => this.addOn(day, true))
    );
    if (items.length) {
      menu.addSeparator();
      for (const item of items.slice(0, 8)) {
        menu.addItem((i) =>
          i
            .setTitle(`${moment(item.at).format(this.plugin.settings.timeFormat)}  ${item.reminder.title}`)
            .setIcon(item.reminder.repeat ? "repeat" : "bell")
            .onClick(() => this.edit(item.reminder))
        );
      }
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Go to today")
        .setIcon("calendar-check")
        .onClick(() => this.goToday())
    );
    const where = (this.opts.bgBase ?? (this.opts.embedded ? "embed" : "sidebar")) === "embed" ? "note calendars" : "sidebar calendar";
    menu.addItem((i) =>
      i
        .setTitle(`Background image for ${where}...`)
        .setIcon("image")
        .onClick(() => this.pickBackground())
    );
    if (((this.opts.bgBase ?? (this.opts.embedded ? "embed" : "sidebar")) === "embed" ? this.plugin.settings.embedBackground : this.plugin.settings.sidebarBackground).image) {
      menu.addItem((i) =>
        i
          .setTitle(`Remove ${where} background`)
          .setIcon("image-off")
          .onClick(() => this.clearBackground())
      );
    }
    if (!this.opts.embedded) {
      menu.addItem((i) =>
        i
          .setTitle("Copy code to embed in a note")
          .setIcon("code")
          .onClick(() => this.plugin.copyCalendarEmbed())
      );
    }
    return menu;
  }

  // ---------- Agenda ----------

  private renderAgenda(root: HTMLElement, items: CalendarItem[]): void {
    const day = moment(this.selected, "YYYY-MM-DD");
    const agenda = root.createDiv({ cls: "rt-cal-agenda" });
    const head = agenda.createDiv({ cls: "rt-cal-agenda-head" });
    head.createSpan({ text: day.format("ddd, MMM D") });
    if (this.selected === this.todayKey) head.createSpan({ cls: "rt-cal-today-badge", text: "Today" });

    if (!items.length) {
      agenda.createDiv({
        cls: "rt-cal-empty",
        text: "No reminders. Press +, double tap a day, or right click (long press on touch) to add one.",
      });
      return;
    }

    for (const item of items) {
      const r = item.reminder;
      const row = agenda.createDiv({ cls: "rt-cal-item", attr: { role: "button", tabindex: "0" } });
      const color = this.plugin.colorOf(r);
      if (color) row.style.setProperty("--rt-item", color);
      if (r.completed) row.addClass("is-completed");
      if (item.projected) row.addClass("is-projected");

      row.createDiv({ cls: "rt-cal-item-time", text: moment(item.at).format(this.plugin.settings.timeFormat) });
      const main = row.createDiv({ cls: "rt-cal-item-main" });
      const title = main.createDiv({ cls: "rt-cal-item-title" });
      if (r.repeat) {
        const icon = title.createSpan({ cls: "rt-cal-item-icon", attr: { "aria-label": describeRepeat(r.repeat) } });
        setIcon(icon, "repeat");
      }
      title.appendText(r.title || "Untitled reminder");
      if (r.leadUps?.length) {
        const bell = title.createSpan({
          cls: "rt-cal-item-icon rt-cal-item-lead",
          attr: { "aria-label": `Heads-up ${normalizeLeads(r.leadUps).map(shortLead).join(", ")} before` },
        });
        setIcon(bell, "alarm-clock");
      }
      if (r.tags?.length) {
        const tags = main.createDiv({ cls: "rt-cal-item-tags" });
        for (const t of r.tags) tags.createSpan({ cls: "rt-cal-tag", text: `#${t}` });
      }

      // Visible menu button, since touch screens have no right click.
      const more = row.createEl("button", { cls: "clickable-icon rt-cal-item-more", attr: { "aria-label": "More" } });
      setIcon(more, "more-vertical");
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        this.itemMenu(item).showAtMouseEvent(e);
      });

      row.addEventListener("click", () => this.edit(r));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.edit(r);
      });
      onContextOrLongPress(row, (at) => this.itemMenu(item).showAtPosition(at));
    }
  }

  private itemMenu(item: CalendarItem): Menu {
    const r = item.reminder;
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(r.repeat ? "Edit series" : "Edit")
        .setIcon("pencil")
        .onClick(() => this.edit(r))
    );
    menu.addItem((i) =>
      i
        .setTitle("Create similar")
        .setIcon("copy")
        .onClick(() => this.plugin.openSimilarModal(r))
    );
    if (!item.projected) {
      menu.addItem((i) =>
        i
          .setTitle(r.completed ? "Mark not done" : r.repeat ? "Done, go to next" : "Mark done")
          .setIcon("check")
          .onClick(() => this.plugin.setCompleted(r.id, !r.completed))
      );
      if (!r.completed && r.due <= Date.now()) {
        menu.addItem((i) =>
          i
            .setTitle(`Snooze ${this.plugin.settings.snoozeMinutes} min`)
            .setIcon("alarm-clock")
            .onClick(() => this.plugin.snooze(r.id, this.plugin.settings.snoozeMinutes))
        );
      }
    }
    if (r.notePath) {
      menu.addItem((i) =>
        i
          .setTitle("Open note")
          .setIcon("file-text")
          .onClick(() => this.plugin.openNote(r.notePath))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(r.repeat ? "Delete series" : "Delete")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() =>
          new ConfirmModal(
            this.plugin.app,
            r.inline
              ? `Delete "${r.title}"? This also removes its task line from ${r.notePath.replace(/\.md$/, "")}.`
              : r.repeat
                ? `Delete "${r.title}" and all its future repeats?`
                : `Delete "${r.title}"?`,
            () => this.plugin.deleteReminder(r.id)
          ).open()
        )
    );
    return menu;
  }

  // ---------- Actions ----------

  private addOn(day: Moment, weekly = false): void {
    const due = this.plugin.dueOnDay(day);
    this.plugin.openCreateModal({
      due,
      tags: [...this.opts.tags],
      repeat: weekly ? { freq: "weekly", interval: 1, weekdays: [], start: due, until: null } : null,
    });
  }

  private edit(r: Reminder): void {
    new ReminderModal(this.plugin.app, this.plugin, r, (updated) => void this.plugin.upsertReminder(updated)).open();
  }

  private goToday(): void {
    this.month = moment().startOf("month");
    this.selected = moment().format("YYYY-MM-DD");
    this.render();
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => unknown): HTMLElement {
    const btn = parent.createEl("button", { cls: "clickable-icon rt-cal-icon-btn", attr: { "aria-label": label } });
    setIcon(btn, icon);
    // Older Obsidian versions may not have every icon.
    if (!btn.querySelector("svg")) setIcon(btn, icon === "picture-in-picture-2" ? "external-link" : "circle");
    btn.addEventListener("click", onClick);
    return btn;
  }
}

// ---------- Sidebar view ----------

export class ReminderCalendarView extends ItemView {
  private calendar: CalendarRenderer | null = null;
  private state: CalendarViewState = {};

  constructor(leaf: WorkspaceLeaf, private plugin: ReminderToastPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CALENDAR;
  }

  getDisplayText(): string {
    const tags = this.state.tags?.length ? ` (${this.state.tags.map((t) => `#${t}`).join(" ")})` : "";
    return `Reminder calendar${tags}`;
  }

  getIcon(): string {
    return "calendar-clock";
  }

  getState(): Record<string, unknown> {
    return { ...this.state };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.state = state && typeof state === "object" ? state : {};
    this.build();
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.leaf.on("pinned-change", () => this.calendar?.render()));
    this.build();
  }

  async onClose(): Promise<void> {
    if (this.calendar) this.plugin.calendars.delete(this.calendar);
    this.contentEl.empty();
  }

  private build(): void {
    if (this.calendar) this.plugin.calendars.delete(this.calendar);
    this.contentEl.empty();
    this.contentEl.addClass("rt-cal-pane");
    const root = this.contentEl.createDiv({ cls: "rt-cal-view" });
    this.calendar = new CalendarRenderer(this.plugin, root, this, {
      bgHost: this.contentEl,
      embedded: false,
      agenda: this.state.agenda !== false,
      tags: this.state.tags ?? [],
      month: null,
      leaf: this.leaf,
      background: this.state.background,
      bgBase: this.state.bgBase ?? "sidebar",
      sourcePath: this.state.sourcePath,
    });
    // A new image or different settings: force the background to be applied again.
    delete this.contentEl.dataset.rtBg;
    this.calendar.render();
  }
}

// ---------- Embedded in a note ----------

export interface EmbedParseResult {
  options: CalendarOptions;
  errors: string[];
}

/**
 * Options for a ```reminder-calendar``` block, one per line:
 *   month: 2026-11       (month to open on; default is this month)
 *   agenda: false        (hide the day list under the calendar)
 *   tags: work, health   (only reminders with these tags)
 */
export function parseEmbedOptions(source: string): EmbedParseResult {
  const options: CalendarOptions = { embedded: true, agenda: true, tags: [], month: null };
  const errors: string[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const m = /^([a-z]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) {
      errors.push(`Can't read "${line}". Use "option: value".`);
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "month") {
      if (!value || value === "current" || value === "this") continue;
      const month = moment(value, ["YYYY-MM", "YYYY-M", "MMMM YYYY", "MMM YYYY"], true);
      if (month.isValid()) options.month = month;
      else errors.push(`Unknown month "${value}". Use YYYY-MM, e.g. 2026-11.`);
    } else if (key === "background" || key === "image") {
      const bg = (options.background ??= {});
      bg.image = /^(none|off|false)$/i.test(value) ? "" : value;
    } else if (key === "dim") {
      const n = parseInt(value.replace("%", ""), 10);
      if (Number.isFinite(n) && n >= 0 && n <= 95) (options.background ??= {}).dim = n;
      else errors.push(`"dim" should be a number from 0 to 95.`);
    } else if (key === "fit") {
      const fit = value.toLowerCase() as BgFit;
      if (fit in BG_FITS) (options.background ??= {}).fit = fit;
      else errors.push(`"fit" should be one of: ${Object.keys(BG_FITS).join(", ")}.`);
    } else if (key === "position") {
      const pos = value.toLowerCase();
      if (pos in BG_POSITIONS) (options.background ??= {}).position = pos;
      else errors.push(`"position" should be one of: ${Object.keys(BG_POSITIONS).join(", ")}.`);
    } else if (key === "agenda") {
      options.agenda = !/^(false|no|off|hide|0)$/i.test(value);
    } else if (key === "tags" || key === "tag") {
      options.tags = value
        .split(/[,\s]+/)
        .map((t) => t.replace(/^#/, "").trim())
        .filter(Boolean);
    } else {
      errors.push(`Unknown option "${key}". Options are month, agenda, tags, background, dim, fit and position.`);
    }
  }
  return { options, errors };
}

export class EmbeddedCalendar extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private plugin: ReminderToastPlugin,
    private source: string,
    private sourcePath: string
  ) {
    super(containerEl);
  }

  onload(): void {
    const { options, errors } = parseEmbedOptions(this.source);
    options.sourcePath = this.sourcePath;
    if (options.background?.image) {
      const ok = resolveImage(this.plugin.app, options.background.image, this.sourcePath);
      if (!ok) errors.push(`Background image not found: ${options.background.image}`);
    }
    const wrap = this.containerEl.createDiv({ cls: "rt-cal-embed" });
    if (errors.length) {
      const box = wrap.createDiv({ cls: "rt-cal-embed-errors" });
      for (const e of errors) box.createDiv({ text: e });
    }
    const root = wrap.createDiv();
    const calendar = new CalendarRenderer(this.plugin, root, this, options);
    calendar.render();
  }
}
