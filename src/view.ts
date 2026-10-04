import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type ReminderToastPlugin from "../main";
import type { Reminder } from "./types";
import { formatDue } from "./template";
import { ConfirmModal, ReminderModal } from "./modal";
import { describeRepeat } from "./repeat";
import { normalizeLeads, shortLead } from "./leads";
import { onContextOrLongPress } from "./touch";
import { moment } from "./moment";

export const VIEW_TYPE_REMINDERS = "reminder-toast-list";

type Section = { key: string; label: string; items: Reminder[]; collapsedByDefault?: boolean };

/** Sidebar panel listing upcoming, overdue and completed reminders. */
export class ReminderListView extends ItemView {
  private refreshTimer: number | null = null;
  private collapsed = new Set<string>(["completed"]);

  constructor(leaf: WorkspaceLeaf, private plugin: ReminderToastPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_REMINDERS;
  }

  getDisplayText(): string {
    return "Reminders";
  }

  getIcon(): string {
    return "bell";
  }

  async onOpen(): Promise<void> {
    this.render();
    // Keep relative times like "in 5 minutes" fresh.
    this.refreshTimer = window.setInterval(() => this.render(), 30 * 1000);
    this.registerInterval(this.refreshTimer);
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("rt-list-view");

    const header = root.createDiv({ cls: "rt-list-header" });
    header.createDiv({ cls: "rt-list-title", text: "Reminders" });
    const addBtn = header.createEl("button", { cls: "mod-cta rt-add-btn" });
    setIcon(addBtn.createSpan(), "plus");
    addBtn.appendText(" New");
    addBtn.addEventListener("click", () => this.plugin.openCreateModal());

    const now = Date.now();
    const all = [...this.plugin.reminders].sort((a, b) => a.due - b.due);
    const sections: Section[] = [
      { key: "overdue", label: "Due", items: all.filter((r) => !r.completed && r.due <= now) },
      { key: "upcoming", label: "Upcoming", items: all.filter((r) => !r.completed && r.due > now) },
      {
        key: "completed",
        label: "Completed",
        items: all.filter((r) => r.completed).sort((a, b) => b.due - a.due),
      },
    ];

    if (!all.length) {
      const empty = root.createDiv({ cls: "rt-empty" });
      empty.createEl("p", { text: "No reminders yet." });
      empty.createEl("p", {
        cls: "setting-item-description",
        text: "Add one with the button above, or with the create reminder command in the command palette.",
      });
      return;
    }

    for (const section of sections) {
      if (!section.items.length) continue;
      const sec = root.createDiv({ cls: `rt-section rt-section-${section.key}` });
      const head = sec.createDiv({ cls: "rt-section-head" });
      const caret = head.createSpan({ cls: "rt-caret" });
      const isCollapsed = this.collapsed.has(section.key);
      setIcon(caret, isCollapsed ? "chevron-right" : "chevron-down");
      head.createSpan({ text: `${section.label} (${section.items.length})` });
      head.addEventListener("click", () => {
        if (this.collapsed.has(section.key)) this.collapsed.delete(section.key);
        else this.collapsed.add(section.key);
        this.render();
      });

      if (section.key === "completed" && !isCollapsed) {
        const clear = head.createEl("button", { text: "Clear", cls: "rt-small-btn rt-clear-btn" });
        clear.addEventListener("click", (e) => {
          e.stopPropagation();
          new ConfirmModal(this.app, "Delete all completed reminders? Inline ones stay in their notes.", () =>
            this.plugin.clearCompleted()
          ).open();
        });
      }

      if (isCollapsed) continue;
      const list = sec.createDiv({ cls: "rt-items" });
      for (const r of section.items) this.renderItem(list, r);
    }
  }

  private renderItem(parent: HTMLElement, r: Reminder): void {
    const item = parent.createDiv({ cls: "rt-item" });
    if (r.completed) item.addClass("is-completed");
    else if (r.due <= Date.now()) item.addClass("is-due");
    const color = this.plugin.colorOf(r);
    if (color) {
      item.addClass("has-color");
      item.style.setProperty("--rt-item", color);
    }

    const check = item.createEl("input", { type: "checkbox", cls: "rt-check" });
    check.checked = r.completed;
    check.addEventListener("change", () => void this.plugin.setCompleted(r.id, check.checked));

    const main = item.createDiv({ cls: "rt-item-main" });
    const titleRow = main.createDiv({ cls: "rt-item-title" });
    if (r.inline) {
      const badge = titleRow.createSpan({ cls: "rt-inline-badge", attr: { "aria-label": "Task line in a note" } });
      setIcon(badge, "list-checks");
    }
    titleRow.appendText(r.title || "Untitled reminder");
    const meta = main.createDiv({ cls: "rt-item-meta" });
    meta.createSpan({ text: formatDue(r.due, this.plugin.settings) });
    if (!r.completed) meta.createSpan({ cls: "rt-rel", text: ` · ${moment(r.due).fromNow()}` });
    if (r.repeat) {
      const rep = main.createDiv({ cls: "rt-item-repeat" });
      setIcon(rep.createSpan({ cls: "rt-item-repeat-icon" }), "repeat");
      rep.appendText(describeRepeat(r.repeat));
    }
    if (r.leadUps?.length) {
      const lead = main.createDiv({ cls: "rt-item-repeat" });
      setIcon(lead.createSpan({ cls: "rt-item-repeat-icon" }), "alarm-clock");
      lead.appendText(`${normalizeLeads(r.leadUps).map(shortLead).join(", ")} before`);
    }
    if (r.tags?.length) {
      const tags = main.createDiv({ cls: "rt-item-tags" });
      for (const t of r.tags) tags.createSpan({ cls: "rt-cal-tag", text: `#${t}` });
    }
    if (r.message) main.createDiv({ cls: "rt-item-msg", text: r.message });
    if (r.notePath) {
      const link = main.createEl("a", { cls: "rt-item-note", text: r.notePath.replace(/\.md$/, "") });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void this.plugin.openNote(r.notePath);
      });
    }
    main.addEventListener("dblclick", () => this.edit(r));

    const actions = item.createDiv({ cls: "rt-item-actions" });
    if (!r.completed && r.due <= Date.now()) {
      this.iconBtn(actions, "alarm-clock", `Snooze ${this.plugin.settings.snoozeMinutes} min`, () =>
        this.plugin.snooze(r.id, this.plugin.settings.snoozeMinutes)
      );
    }
    this.iconBtn(actions, "pencil", "Edit", () => this.edit(r));
    this.iconBtn(actions, "copy", "Create similar", () => this.plugin.openSimilarModal(r));
    this.iconBtn(actions, "trash-2", "Delete", () =>
      new ConfirmModal(
        this.app,
        r.inline
          ? `Delete "${r.title}"? This also removes its task line from ${r.notePath.replace(/\.md$/, "")}.`
          : r.repeat
            ? `Delete "${r.title}" and all its future repeats?`
            : `Delete "${r.title}"?`,
        () => this.plugin.deleteReminder(r.id)
      ).open()
    );

    onContextOrLongPress(item, (at) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Edit").setIcon("pencil").onClick(() => this.edit(r)));
      menu.addItem((i) =>
        i.setTitle("Create similar").setIcon("copy").onClick(() => this.plugin.openSimilarModal(r))
      );
      menu.addItem((i) =>
        i
          .setTitle("Show in calendar")
          .setIcon("calendar-clock")
          .onClick(() => this.plugin.activateCalendar())
      );
      menu.showAtPosition(at);
    });
  }

  private edit(r: Reminder): void {
    new ReminderModal(this.app, this.plugin, r, (updated) => void this.plugin.upsertReminder(updated)).open();
  }

  private iconBtn(parent: HTMLElement, icon: string, label: string, onClick: () => unknown): void {
    const btn = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(btn, icon);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
  }
}
