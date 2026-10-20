import { App, Modal, Notice, Setting } from "obsidian";
import type ReminderToastPlugin from "../main";
import { Tracker, newTracker } from "./types";
import { PALETTE, parseTagInput } from "./colors";
import { moment } from "./moment";

/** Create or edit a tracker: a named, dated entry with categories that never notifies. */
export class TrackerModal extends Modal {
  private draft: Tracker;
  private isNew: boolean;
  private dateInput!: HTMLInputElement;
  private colorRowEl!: HTMLElement;
  private catChipsEl!: HTMLElement;
  private catInput!: HTMLInputElement;

  constructor(
    app: App,
    private plugin: ReminderToastPlugin,
    existing: Tracker | null,
    private onSave: (t: Tracker) => unknown,
    prefill: Partial<Tracker> = {}
  ) {
    super(app);
    this.isNew = !existing;
    this.draft = existing ? { ...existing, categories: [...(existing.categories ?? [])] } : newTracker(prefill);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rt-modal");
    this.titleEl.setText(this.isNew ? "New tracker" : "Edit tracker");

    new Setting(contentEl).setName("Name").addText((t) => {
      t.setPlaceholder("Started a new series")
        .setValue(this.draft.title)
        .onChange((v) => (this.draft.title = v));
      t.inputEl.addClass("rt-wide-input");
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    new Setting(contentEl).setName("Date").addText((t) => {
      this.dateInput = t.inputEl;
      t.inputEl.type = "date";
      t.setValue(moment(this.draft.date).format("YYYY-MM-DD"));
    });

    const cats = new Setting(contentEl)
      .setName("Categories")
      .setDesc("Separate with commas. New categories are saved with a color.");
    cats.addText((t) => {
      this.catInput = t.inputEl;
      t.setPlaceholder("Categories, separated by commas")
        .setValue((this.draft.categories ?? []).join(", "))
        .onChange((v) => {
          this.draft.categories = parseTagInput(v);
          this.renderCategoryChips();
          this.refreshColorRow();
        });
      t.inputEl.addClass("rt-wide-input");
    });
    this.catChipsEl = contentEl.createDiv({ cls: "rt-tag-chips" });
    this.renderCategoryChips();

    const color = new Setting(contentEl)
      .setName("Color")
      .setDesc("Shown on the calendar. Auto uses the category color.");
    color.settingEl.addClass("rt-color-setting");
    this.colorRowEl = color.controlEl.createDiv({ cls: "rt-swatches" });
    this.refreshColorRow();

    new Setting(contentEl).setName("Note").addTextArea((t) => {
      t.setPlaceholder("Optional details").setValue(this.draft.note ?? "").onChange((v) => (this.draft.note = v));
      t.inputEl.rows = 3;
      t.inputEl.addClass("rt-wide-input");
    });

    const buttons = new Setting(contentEl);
    if (!this.isNew) {
      buttons.addButton((b) =>
        b
          .setButtonText("Delete")
          .setDestructive()
          .onClick(() => {
            void this.plugin.deleteTracker(this.draft.id);
            this.close();
          })
      );
    }
    buttons
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.isNew ? "Add tracker" : "Save")
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

  private renderCategoryChips(): void {
    const el = this.catChipsEl;
    el.empty();
    const known = this.plugin.settings.categories;
    if (!known.length) {
      el.hide();
      return;
    }
    el.show();
    const selected = new Set((this.draft.categories ?? []).map((c) => c.toLowerCase()));
    for (const cat of known) {
      const chip = el.createEl("button", { cls: "rt-tag-chip", text: `#${cat.name}` });
      chip.style.setProperty("--rt-tag", cat.color || "var(--text-muted)");
      if (selected.has(cat.name.toLowerCase())) chip.addClass("is-active");
      chip.addEventListener("click", () => {
        const current = this.draft.categories ?? [];
        this.draft.categories = selected.has(cat.name.toLowerCase())
          ? current.filter((c) => c.toLowerCase() !== cat.name.toLowerCase())
          : [...current, cat.name];
        this.catInput.value = this.draft.categories.join(", ");
        this.renderCategoryChips();
        this.refreshColorRow();
      });
    }
  }

  private refreshColorRow(): void {
    const row = this.colorRowEl;
    if (!row) return;
    row.empty();
    const current = (this.draft.color ?? "").toLowerCase();

    const auto = row.createEl("button", { cls: "rt-swatch rt-swatch-auto", attr: { "aria-label": "Auto" } });
    const autoHex = this.plugin.trackerColorOf({ ...this.draft, color: "" });
    if (autoHex) auto.style.setProperty("--rt-swatch", autoHex);
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
    this.refreshColorRow();
  }

  private submit(): void {
    const title = this.draft.title.replace(/\s+/g, " ").trim();
    if (!title) {
      new Notice("Please give the tracker a name.");
      return;
    }
    const day = moment(this.dateInput.value, "YYYY-MM-DD", true);
    if (!day.isValid()) {
      new Notice("Please pick a valid date.");
      return;
    }
    this.draft.title = title;
    this.draft.date = day.startOf("day").valueOf();
    this.onSave(this.draft);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
