import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import type ReminderToastPlugin from "../main";
import type { EditorContext } from "../main";
import { Reminder, newReminder } from "./types";
import { PLACEHOLDERS, toastContent } from "./template";
import { PALETTE, parseTagInput, reminderColor } from "./colors";
import { RepeatFreq, RepeatRule, describeRepeat, occurrencesBetween, sameRule } from "./repeat";
import { MAX_LEADS, MAX_LEAD_MINUTES, normalizeLeads, sameLeads, shortLead } from "./leads";
import { moment, type Moment } from "./moment";

const LEAD_PRESETS: Array<[string, number]> = [
  ["5 min", 5],
  ["15 min", 15],
  ["30 min", 30],
  ["1 hr", 60],
  ["2 hr", 120],
  ["1 day", 1440],
];

type RepeatChoice = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly" | "custom";
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Create or edit a reminder, including its toast text. */
export class ReminderModal extends Modal {
  private draft: Reminder;
  private isNew: boolean;
  private dateInput!: HTMLInputElement;
  private timeInput!: HTMLInputElement;
  private previewTitleEl!: HTMLElement;
  private previewBodyEl!: HTMLElement;
  private previewCard!: HTMLElement;
  private original: Reminder | null;

  // Repeat UI state
  private repeatChoice: RepeatChoice = "none";
  private customInterval = 1;
  private customUnit: RepeatFreq = "weekly";
  private weekdays: number[] = [];
  private untilEnabled = false;
  private untilDate = "";
  private repeatDetailsEl!: HTMLElement;
  private repeatSummaryEl!: HTMLElement;
  private colorRowEl!: HTMLElement;
  private tagChipsEl!: HTMLElement;
  private tagInput!: HTMLInputElement;
  private leadChipsEl!: HTMLElement;
  private leadSummaryEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: ReminderToastPlugin,
    existing: Reminder | null,
    private onSave: (r: Reminder) => unknown,
    prefill: Partial<Reminder> = {},
    private editorCtx?: EditorContext
  ) {
    super(app);
    this.isNew = !existing;
    this.original = existing;
    this.draft = existing
      ? {
          ...existing,
          tags: [...(existing.tags ?? [])],
          leadUps: [...(existing.leadUps ?? [])],
          repeat: existing.repeat ? { ...existing.repeat, weekdays: [...existing.repeat.weekdays] } : null,
        }
      : newReminder(prefill);
    this.loadRepeatState(this.draft.repeat ?? null);
    if (this.isNew) {
      this.draft.inline = !!editorCtx && plugin.settings.inlineEnabled && plugin.settings.insertInlineByDefault;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rt-modal");
    this.titleEl.setText(this.isNew ? "New reminder" : "Edit reminder");

    new Setting(contentEl).setName("Title").addText((t) => {
      t.setPlaceholder("Call the dentist")
        .setValue(this.draft.title)
        .onChange((v) => {
          this.draft.title = v;
          this.updatePreview();
        });
      t.inputEl.addClass("rt-wide-input");
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    new Setting(contentEl)
      .setName("Message")
      .setDesc("Optional details. Available in the toast as {{message}}.")
      .addTextArea((t) => {
        t.setPlaceholder("Ask about rescheduling to next week")
          .setValue(this.draft.message)
          .onChange((v) => {
            this.draft.message = v;
            this.updatePreview();
          });
        t.inputEl.rows = 3;
        t.inputEl.addClass("rt-wide-input");
      });

    // Date and time
    const due = moment(this.draft.due);
    const whenSetting = new Setting(contentEl).setName("When").setDesc("Date and time the toast appears.");
    this.dateInput = whenSetting.controlEl.createEl("input", {
      type: "date",
      cls: "rt-date-input",
      value: due.format("YYYY-MM-DD"),
    });
    this.timeInput = whenSetting.controlEl.createEl("input", {
      type: "time",
      cls: "rt-time-input",
      value: due.format("HH:mm"),
    });
    const onDateChange = () => {
      this.readDue();
      this.updatePreview();
    };
    this.dateInput.addEventListener("change", onDateChange);
    this.timeInput.addEventListener("change", onDateChange);

    const quick = contentEl.createDiv({ cls: "rt-quick-row" });
    const quickOptions: Array<[string, () => Moment]> = [
      ["In 15 min", () => moment().add(15, "minutes")],
      ["In 1 hour", () => moment().add(1, "hour")],
      ["This evening", () => moment().hour(18).minute(0)],
      ["Tomorrow 9 AM", () => moment().add(1, "day").hour(9).minute(0)],
      ["Next week", () => moment().add(1, "week").hour(9).minute(0)],
    ];
    for (const [label, fn] of quickOptions) {
      const btn = quick.createEl("button", { text: label, cls: "rt-chip" });
      btn.addEventListener("click", () => this.setDue(fn()));
    }

    this.buildRepeatSection(contentEl);
    this.buildLeadSection(contentEl);
    this.buildColorSection(contentEl);
    this.buildTagSection(contentEl);

    // Where the reminder lives
    if (!this.isNew && this.draft.inline) {
      const src = new Setting(contentEl)
        .setName("In note")
        .setDesc("This reminder is a task line in this note. Title, time and done state are saved back to that line.");
      const link = src.controlEl.createEl("a", { text: this.draft.notePath.replace(/\.md$/, ""), href: "#" });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void this.plugin.openNote(this.draft.notePath);
        this.close();
      });
    } else {
      let linkedSetting: Setting | null = null;

      if (this.isNew && this.editorCtx && this.plugin.settings.inlineEnabled) {
        const ctxFile = this.editorCtx.file;
        new Setting(contentEl)
          .setName("Add to this note as a task")
          .setDesc(`Writes "- [ ] title @remind(date time)" into ${ctxFile.basename} at the cursor.`)
          .addToggle((t) =>
            t.setValue(!!this.draft.inline).onChange((v) => {
              this.draft.inline = v;
              if (v) this.draft.notePath = ctxFile.path;
              linkedSetting?.settingEl.toggle(!v);
              this.updatePreview();
            })
          );
      }

      linkedSetting = new Setting(contentEl)
        .setName("Linked note")
        .setDesc("Optional. The toast gets a button that opens this note.")
        .addText((t) => {
          t.setPlaceholder("Folder/Note.md")
            .setValue(this.draft.notePath)
            .onChange((v) => {
              this.draft.notePath = v.trim();
              this.updatePreview();
            });
          const active = this.app.workspace.getActiveFile();
          if (active) {
            const useBtn = t.inputEl.parentElement?.createEl("button", { text: "Use current", cls: "rt-small-btn" });
            useBtn?.addEventListener("click", () => {
              t.setValue(active.path);
              this.draft.notePath = active.path;
              this.updatePreview();
            });
          }
        });
      linkedSetting.settingEl.toggle(!this.draft.inline);
    }

    // Toast customization
    const details = contentEl.createEl("details", { cls: "rt-toast-custom" });
    details.createEl("summary", { text: "Customize this toast" });
    if (this.draft.toastTitle || this.draft.toastBody) details.open = true;

    details.createEl("p", {
      cls: "setting-item-description",
      text: "Leave blank to use the default text from settings. You can use these placeholders:",
    });
    const phList = details.createDiv({ cls: "rt-placeholder-list" });
    for (const [ph, desc] of PLACEHOLDERS) {
      const chip = phList.createEl("code", { text: ph, attr: { title: desc } });
      chip.addClass("rt-placeholder");
    }

    new Setting(details).setName("Toast title").addText((t) => {
      t.setPlaceholder(this.plugin.settings.toastTitleTemplate)
        .setValue(this.draft.toastTitle)
        .onChange((v) => {
          this.draft.toastTitle = v;
          this.updatePreview();
        });
      t.inputEl.addClass("rt-wide-input");
    });

    new Setting(details).setName("Toast body").addTextArea((t) => {
      t.setPlaceholder(this.plugin.settings.toastBodyTemplate)
        .setValue(this.draft.toastBody)
        .onChange((v) => {
          this.draft.toastBody = v;
          this.updatePreview();
        });
      t.inputEl.rows = 3;
      t.inputEl.addClass("rt-wide-input");
    });

    // Live preview
    const preview = contentEl.createDiv({ cls: "rt-preview" });
    preview.createDiv({ cls: "rt-preview-label", text: "Preview" });
    const card = preview.createDiv({ cls: "rt-toast rt-toast-static" });
    this.previewCard = card;
    this.previewTitleEl = card.createDiv({ cls: "rt-toast-title" });
    this.previewBodyEl = card.createDiv({ cls: "rt-toast-body" });
    this.updatePreview();

    // Buttons
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Test toast").onClick(() => {
          this.readDue();
          this.plugin.fireToast(this.draft, { preview: true });
        })
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.isNew ? "Create reminder" : "Save")
          .setCta()
          .onClick(() => this.submit())
      );

    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.submit();
      }
    });
  }

  private setDue(m: Moment): void {
    m.second(0).millisecond(0);
    this.dateInput.value = m.format("YYYY-MM-DD");
    this.timeInput.value = m.format("HH:mm");
    this.readDue();
    this.updatePreview();
  }

  private readDue(): boolean {
    const m = moment(`${this.dateInput.value} ${this.timeInput.value}`, "YYYY-MM-DD HH:mm", true);
    if (!m.isValid()) return false;
    this.draft.due = m.valueOf();
    this.refreshRepeatSummary();
    return true;
  }

  // ---------- Repeat ----------

  private loadRepeatState(rule: RepeatRule | null): void {
    const dueDay = moment(this.draft.due).day();
    this.weekdays = [dueDay];
    if (!rule) {
      this.repeatChoice = "none";
      return;
    }
    this.untilEnabled = rule.until !== null;
    this.untilDate = rule.until !== null ? moment(rule.until).format("YYYY-MM-DD") : "";
    this.customInterval = rule.interval;
    this.customUnit = rule.freq;
    if (rule.weekdays.length) this.weekdays = [...rule.weekdays];
    const days = [...rule.weekdays].sort().join(",");
    if (rule.freq === "weekly" && rule.interval === 1 && days === "1,2,3,4,5") this.repeatChoice = "weekdays";
    else if (rule.interval === 1 && (rule.freq !== "weekly" || !rule.weekdays.length || days === String(dueDay)))
      this.repeatChoice = rule.freq;
    else this.repeatChoice = "custom";
  }

  /** Build the rule from the form, anchored at the current due time. */
  private ruleFromForm(): RepeatRule | null {
    const start = this.draft.due;
    const until =
      this.untilEnabled && this.untilDate && moment(this.untilDate, "YYYY-MM-DD", true).isValid()
        ? moment(this.untilDate, "YYYY-MM-DD").valueOf()
        : null;
    const base = { start, until, interval: 1, weekdays: [] as number[] };
    switch (this.repeatChoice) {
      case "none":
        return null;
      case "weekdays":
        return { ...base, freq: "weekly", weekdays: [1, 2, 3, 4, 5] };
      case "custom": {
        const interval = Math.max(1, Math.min(999, Math.floor(this.customInterval) || 1));
        const weekdays = this.customUnit === "weekly" ? [...this.weekdays].sort((a, b) => a - b) : [];
        return { ...base, freq: this.customUnit, interval, weekdays };
      }
      default:
        return { ...base, freq: this.repeatChoice };
    }
  }

  private buildRepeatSection(contentEl: HTMLElement): void {
    const setting = new Setting(contentEl).setName("Repeat");
    this.repeatSummaryEl = setting.descEl;
    setting.addDropdown((d) =>
      d
        .addOptions({
          none: "Does not repeat",
          daily: "Every day",
          weekdays: "Every weekday (Mon to Fri)",
          weekly: "Every week",
          monthly: "Every month",
          yearly: "Every year",
          custom: "Custom...",
        })
        .setValue(this.repeatChoice)
        .onChange((v) => {
          this.repeatChoice = v as RepeatChoice;
          if (v === "custom" && !this.weekdays.length) this.weekdays = [moment(this.draft.due).day()];
          this.renderRepeatDetails();
        })
    );
    this.repeatDetailsEl = contentEl.createDiv({ cls: "rt-repeat-details" });
    this.renderRepeatDetails();
  }

  private renderRepeatDetails(): void {
    const el = this.repeatDetailsEl;
    el.empty();
    el.toggle(this.repeatChoice !== "none");
    if (this.repeatChoice === "none") {
      this.refreshRepeatSummary();
      return;
    }

    if (this.repeatChoice === "custom") {
      const row = el.createDiv({ cls: "rt-repeat-row" });
      row.createSpan({ text: "Every" });
      const num = row.createEl("input", { type: "number", cls: "rt-repeat-interval" });
      num.min = "1";
      num.max = "999";
      num.value = String(this.customInterval);
      num.addEventListener("input", () => {
        this.customInterval = parseInt(num.value, 10) || 1;
        this.refreshRepeatSummary();
      });
      const unit = row.createEl("select", { cls: "dropdown" });
      for (const [value, label] of [
        ["daily", "days"],
        ["weekly", "weeks"],
        ["monthly", "months"],
        ["yearly", "years"],
      ]) {
        unit.createEl("option", { value, text: label });
      }
      unit.value = this.customUnit;
      unit.addEventListener("change", () => {
        this.customUnit = unit.value as RepeatFreq;
        this.renderRepeatDetails();
      });

      if (this.customUnit === "weekly") {
        const days = el.createDiv({ cls: "rt-weekday-row" });
        WEEKDAY_LABELS.forEach((label, d) => {
          const btn = days.createEl("button", { text: label, cls: "rt-weekday" });
          if (this.weekdays.includes(d)) btn.addClass("is-active");
          btn.addEventListener("click", () => {
            if (this.weekdays.includes(d)) {
              if (this.weekdays.length > 1) this.weekdays = this.weekdays.filter((x) => x !== d);
            } else this.weekdays.push(d);
            this.renderRepeatDetails();
          });
        });
      }
    }

    const endRow = el.createDiv({ cls: "rt-repeat-row" });
    const label = endRow.createEl("label", { cls: "rt-repeat-end" });
    const check = label.createEl("input", { type: "checkbox" });
    check.checked = this.untilEnabled;
    label.appendText(" Ends on");
    const until = endRow.createEl("input", { type: "date" });
    until.value = this.untilDate || moment(this.draft.due).add(3, "months").format("YYYY-MM-DD");
    until.disabled = !this.untilEnabled;
    check.addEventListener("change", () => {
      this.untilEnabled = check.checked;
      this.untilDate = until.value;
      until.disabled = !check.checked;
      this.refreshRepeatSummary();
    });
    until.addEventListener("change", () => {
      this.untilDate = until.value;
      this.refreshRepeatSummary();
    });

    this.refreshRepeatSummary();
  }

  private refreshRepeatSummary(): void {
    if (!this.repeatSummaryEl) return;
    const rule = this.ruleFromForm();
    this.repeatSummaryEl.setText(rule ? describeRepeat(rule) : "One-time reminder.");
  }

  // ---------- Lead-ups ----------

  private buildLeadSection(contentEl: HTMLElement): void {
    const setting = new Setting(contentEl).setName("Notify before");
    this.leadSummaryEl = setting.descEl;

    const wrap = contentEl.createDiv({ cls: "rt-repeat-details rt-lead-details" });
    this.leadChipsEl = wrap.createDiv({ cls: "rt-lead-chips" });

    const presets = wrap.createDiv({ cls: "rt-lead-presets" });
    for (const [label, minutes] of LEAD_PRESETS) {
      const btn = presets.createEl("button", { text: `+ ${label}`, cls: "rt-chip" });
      btn.addEventListener("click", () => this.addLead(minutes));
    }

    const row = wrap.createDiv({ cls: "rt-repeat-row rt-lead-custom" });
    const hours = row.createEl("input", { type: "number", cls: "rt-lead-num", attr: { "aria-label": "Hours" } });
    hours.min = "0";
    hours.max = "8760";
    hours.placeholder = "0";
    row.createSpan({ text: "hr" });
    const minutes = row.createEl("input", { type: "number", cls: "rt-lead-num", attr: { "aria-label": "Minutes" } });
    minutes.min = "0";
    minutes.max = "59";
    minutes.placeholder = "0";
    row.createSpan({ text: "min before" });
    const add = row.createEl("button", { text: "Add", cls: "rt-small-btn" });

    const addCustom = () => {
      const h = Math.max(0, parseInt(hours.value, 10) || 0);
      const m = Math.max(0, parseInt(minutes.value, 10) || 0);
      const total = h * 60 + m;
      if (total <= 0) {
        new Notice("Enter hours, minutes, or both.");
        return;
      }
      if (this.addLead(total)) {
        hours.value = "";
        minutes.value = "";
      }
    };
    add.addEventListener("click", addCustom);
    for (const input of [hours, minutes]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          addCustom();
        }
      });
    }

    this.renderLeadChips();
  }

  private addLead(minutes: number): boolean {
    const leads = this.draft.leadUps ?? [];
    if (minutes > MAX_LEAD_MINUTES) {
      new Notice("Lead-ups can be at most 365 days before.");
      return false;
    }
    if (leads.includes(minutes)) return true;
    if (leads.length >= MAX_LEADS) {
      new Notice(`Up to ${MAX_LEADS} lead-up notifications per reminder.`);
      return false;
    }
    this.draft.leadUps = normalizeLeads([...leads, minutes]);
    this.renderLeadChips();
    return true;
  }

  private renderLeadChips(): void {
    const el = this.leadChipsEl;
    el.empty();
    const leads = normalizeLeads(this.draft.leadUps);
    this.leadSummaryEl.setText(
      leads.length
        ? `Heads-up toasts ${leads.map(shortLead).join(", ")} before it's due.`
        : "Optional heads-up toasts before it's due."
    );
    if (!leads.length) {
      el.createSpan({ cls: "rt-lead-none", text: "No lead-up notifications." });
      return;
    }
    for (const m of leads) {
      const chip = el.createEl("button", { cls: "rt-lead-chip", attr: { "aria-label": "Remove" } });
      const icon = chip.createSpan({ cls: "rt-lead-chip-icon" });
      setIcon(icon, "alarm-clock");
      chip.appendText(`${shortLead(m)} before`);
      const x = chip.createSpan({ cls: "rt-lead-chip-x" });
      setIcon(x, "x");
      chip.addEventListener("click", () => {
        this.draft.leadUps = leads.filter((n) => n !== m);
        this.renderLeadChips();
      });
    }
  }

  // ---------- Color ----------

  private buildColorSection(contentEl: HTMLElement): void {
    const setting = new Setting(contentEl)
      .setName("Color")
      .setDesc("Shown on the calendar, the list and the toast. Auto uses the tag color.");
    setting.settingEl.addClass("rt-color-setting");
    this.colorRowEl = setting.controlEl.createDiv({ cls: "rt-swatches" });
    this.refreshColorRow();
  }

  private refreshColorRow(): void {
    const row = this.colorRowEl;
    if (!row) return;
    row.empty();
    const current = (this.draft.color ?? "").toLowerCase();

    const auto = row.createEl("button", { cls: "rt-swatch rt-swatch-auto", attr: { "aria-label": "Auto" } });
    const autoColor = reminderColor({ ...this.draft, color: "" }, this.plugin.settings);
    if (autoColor) auto.style.setProperty("--rt-swatch", autoColor);
    auto.setText("A");
    if (!current) auto.addClass("is-active");
    auto.addEventListener("click", () => this.setColor(""));

    for (const [name, hex] of PALETTE) {
      const sw = row.createEl("button", { cls: "rt-swatch", attr: { "aria-label": name } });
      sw.style.setProperty("--rt-swatch", hex);
      if (current === hex.toLowerCase()) sw.addClass("is-active");
      sw.addEventListener("click", () => this.setColor(hex));
    }

    const custom = row.createEl("input", { type: "color", cls: "rt-swatch-custom", attr: { "aria-label": "Custom color" } });
    custom.value = current || "#7c3aed";
    if (current && !PALETTE.some(([, hex]) => hex.toLowerCase() === current)) custom.addClass("is-active");
    custom.addEventListener("change", () => this.setColor(custom.value));
  }

  private setColor(hex: string): void {
    this.draft.color = hex;
    this.updatePreview();
  }

  // ---------- Tags ----------

  private buildTagSection(contentEl: HTMLElement): void {
    const setting = new Setting(contentEl)
      .setName("Tags")
      .setDesc("Separate with commas. New tags are saved with a color so similar reminders match.");
    setting.addText((t) => {
      this.tagInput = t.inputEl;
      t.setPlaceholder("Tags, separated by commas")
        .setValue((this.draft.tags ?? []).join(", "))
        .onChange((v) => {
          this.draft.tags = parseTagInput(v);
          this.renderTagChips();
          this.updatePreview();
        });
      t.inputEl.addClass("rt-wide-input");
    });
    this.tagChipsEl = contentEl.createDiv({ cls: "rt-tag-chips" });
    this.renderTagChips();
  }

  private renderTagChips(): void {
    const el = this.tagChipsEl;
    el.empty();
    const known = this.plugin.settings.tags;
    if (!known.length) {
      el.hide();
      return;
    }
    el.show();
    const selected = new Set((this.draft.tags ?? []).map((t) => t.toLowerCase()));
    for (const tag of known) {
      const chip = el.createEl("button", { cls: "rt-tag-chip", text: `#${tag.name}` });
      chip.style.setProperty("--rt-tag", tag.color || "var(--text-muted)");
      if (selected.has(tag.name.toLowerCase())) chip.addClass("is-active");
      chip.addEventListener("click", () => {
        const tags = this.draft.tags ?? [];
        this.draft.tags = selected.has(tag.name.toLowerCase())
          ? tags.filter((t) => t.toLowerCase() !== tag.name.toLowerCase())
          : [...tags, tag.name];
        this.tagInput.value = this.draft.tags.join(", ");
        this.renderTagChips();
        this.updatePreview();
      });
    }
  }

  private updatePreview(): void {
    if (!this.previewTitleEl) return;
    const accent = reminderColor(this.draft, this.plugin.settings, false) || this.plugin.settings.accentColor;
    if (accent) this.previewCard.style.setProperty("--rt-accent", accent);
    else this.previewCard.style.removeProperty("--rt-accent");
    this.refreshColorRow();
    const { title, body } = toastContent(this.draft, this.plugin.settings);
    this.previewTitleEl.setText(title);
    this.previewBodyEl.setText(body);
    this.previewBodyEl.toggle(body.trim().length > 0);
  }

  private submit(): void {
    if (!this.draft.title.trim()) {
      new Notice("Please give the reminder a title.");
      return;
    }
    if (!this.readDue()) {
      new Notice("Please pick a valid date and time.");
      return;
    }
    if (!this.applyRepeat()) return;
    this.draft.leadUps = normalizeLeads(this.draft.leadUps);
    // New time or new lead-ups: reschedule the heads-up toasts.
    const o = this.original;
    if (!o || o.due !== this.draft.due || !sameLeads(o.leadUps, this.draft.leadUps)) delete this.draft.leadBase;
    if (this.draft.due <= Date.now()) {
      new Notice("That time is in the past, so the toast will show right away.");
    }
    // Editing a reminder to a new time should let it fire again.
    if (this.draft.due > Date.now()) this.draft.fired = false;
    if (/[\r\n]/.test(this.draft.title)) this.draft.title = this.draft.title.replace(/\s+/g, " ");
    this.draft.title = this.draft.title.trim();
    this.onSave(this.draft);
    this.close();
  }

  /** Put the repeat rule from the form on the draft. Returns false if it can't be saved. */
  private applyRepeat(): boolean {
    const rule = this.ruleFromForm();
    if (!rule) {
      this.draft.repeat = null;
      delete this.draft.occurrence;
      return true;
    }
    if (rule.until !== null && rule.until < moment(this.draft.due).startOf("day").valueOf()) {
      new Notice("The end date is before the first reminder.");
      return false;
    }
    const old = this.original;
    const unchanged = old && old.repeat && sameRule(old.repeat, rule) && old.due === this.draft.due;
    if (unchanged) {
      this.draft.repeat = old?.repeat ?? rule;
      return true;
    }
    // Weekly on chosen days: start on the first matching day.
    const first = occurrencesBetween(rule, this.draft.due, Infinity, 1)[0];
    if (first === undefined) {
      new Notice("This repeat never happens. Check the days and the end date.");
      return false;
    }
    if (first !== this.draft.due) {
      new Notice(`Starts on ${moment(first).format("ddd, MMM D")}, the first repeat day.`);
      this.draft.due = first;
      rule.start = first;
    }
    this.draft.repeat = rule;
    this.draft.occurrence = this.draft.due;
    return true;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Simple yes/no confirmation. */
export class ConfirmModal extends Modal {
  constructor(app: App, private message: string, private onConfirm: () => unknown) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Are you sure?");
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Delete")
          .setDestructive()
          .onClick(() => {
            this.onConfirm();
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
