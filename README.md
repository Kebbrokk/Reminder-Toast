# Reminder Toast

Create reminders with dates, times and repeats, and get a flashing toast notification when they come due. You choose what the toast says. Includes a calendar for the sidebar, for notes, and for its own window.

Reminder Toast works in the Obsidian desktop app on Windows, macOS and Linux, version 1.13.0 or newer.

## Features

- Create reminders with a title, optional message, date, time, and optional linked note
- Quick picks: in 15 min, in 1 hour, this evening, tomorrow 9 AM, next week
- Flashing toast when a reminder comes due, with **Done**, **Snooze**, and **Open note** buttons
- Customize the toast text globally in settings, or per reminder in the reminder dialog
- Live preview of the toast while you edit, plus a **Test toast** button
- Sidebar list grouped into Due, Upcoming, and Completed
- Status bar shows how many reminders are due or when the next one is
- Optional chime and optional system (OS) notification
- Missed reminders (that came due while Obsidian was closed) can show on startup
- Linked note paths update automatically when you rename or move a note
- **Inline reminders:** write `- [ ] Task @remind(2026-10-02 09:00)` in any note
- **Reminders file:** pick a note in settings that lists every reminder, inline ones included
- **Calendar sidebar:** month view with today highlighted, colored dots per reminder, and right click to add
- **Repeating reminders:** daily, weekdays, weekly on chosen days, monthly, yearly, or every N days/weeks/months/years
- **Colors and tags:** pick a color per reminder, or give a tag a color so every reminder with that tag matches
- **Create similar:** copy a reminder's title, color, tags, repeat and toast text into a new one
- **Lead-up notifications:** heads-up toasts before a reminder is due, like 1 hour and 15 minutes before
- **Calendar in notes:** put the calendar in any note, including inside columns, with optional tag filters
- **Touch friendly:** long press works instead of right click on touchscreen computers
- **Background images:** put an image or animated GIF behind the calendar, with separate images for the sidebar and notes
- **Pop-out calendar:** open the calendar in its own window, and put it on any monitor
- **Pop-out toasts:** when Obsidian is behind other apps or minimized, reminders still pop up on the screen Obsidian is on

## Customizing the toast

The toast title and body are templates. These placeholders are filled in when the toast appears:

| Placeholder | Replaced with |
| --- | --- |
| `{{title}}` | Reminder title |
| `{{message}}` | Reminder message |
| `{{date}}` | Due date, using your date format |
| `{{time}}` | Due time, using your time format |
| `{{datetime}}` | Due date and time |
| `{{note}}` | Name of the linked note |
| `{{relative}}` | How long ago it came due |
| `{{now}}` | Current time |

Example title: `Heads up: {{title}}`
Example body: `{{message}}` on one line and `Due at {{time}}` on the next.

Set the defaults in **Settings > Reminder Toast**. To change the text for a single reminder, open **Customize this toast** in the reminder dialog. Blank fields fall back to the defaults.

Appearance settings: flash on or off, position (any corner or top or bottom center), auto dismiss time (0 keeps it until dismissed), and accent color.

## Inline reminders

Write a task with a `@remind(...)` marker anywhere in a note:

```markdown
- [ ] Call the dentist @remind(2026-10-02 09:00)
- [ ] Pay rent @remind(2026-10-01) #home
1. [ ] Ship the plugin @remind(2026-10-03 3:30 PM)
```

- Dates use `YYYY-MM-DD`. Times can be 24 hour (`14:30`) or 12 hour (`2:30 PM`). A date with no time means 9:00 AM.
- The title is the task text without the marker and `#tags`.
- Checking the box completes the reminder. Clicking **Done** on the toast checks the box. **Snooze** and edits from the sidebar update the marker in the note.
- Deleting an inline reminder from the sidebar removes its task line.
- Tasks inside code blocks are ignored. A marker with an unreadable date is ignored too.
- The first time the plugin scans your vault, old tasks that are already past due go to the Due list without a toast.

When you create a reminder while editing a note (command palette, right click, or **Create reminder from selection**), the dialog shows **Add to this note as a task**. It's on by default; turn it off for a plugin-only reminder. If your cursor is on an existing task, the marker is added to that task. On an empty line, the task goes there. Otherwise it goes on a new line below.

Turn inline reminders on or off in **Settings > Reminder Toast > Inline reminders**. Run **Rescan notes for inline reminders** if something looks out of date.

## Reminders file

Turn on **Settings > Reminder Toast > Reminders file > Save reminders to a file**, then choose the **File location**. Start typing to pick an existing note, or enter a new path like `Planning/Reminders.md`. The file and folders are created if needed. If you pick a note that already has your own writing in it, the plugin leaves it alone and asks you to pick another one.

The file lists every reminder under Due, Upcoming, and Completed, including inline reminders with a link back to their note. It updates when you add, edit, snooze, complete, or delete a reminder, and when a reminder comes due.

### Editing the file

You can edit the reminders file directly. Changes are saved about 2 seconds after you stop typing, or right away when you switch to another note.

```markdown
- [ ] Water the plants @remind(2026-10-02 18:00) · [[Garden]]
    - Use the rain barrel
```

- **Add:** write a new task with a `@remind(...)` marker anywhere in the file. It becomes a reminder and moves to the right section.
- **Edit:** change the title, the `@remind` time, the `[[link]]`, or the indented message under a task.
- **Complete:** check the box.
- **Delete:** delete the line.
- **Drafts:** a task without a valid `@remind(...)` is not lost. It's kept in a Drafts section until you add a date.
- Each line ends with a hidden ID (`%%rt:...%%`) that ties it to its reminder. It's hidden in Reading view, Live Preview and Source mode, and the cursor skips over it. If you delete it (for example with Backspace at the end of a line), the line is treated as a new reminder.
- To show the IDs while editing, open `.obsidian/plugins/reminder-toast/data.json` and change `"showReminderIds": false` to `true` inside `"settings"`. The change applies right away if Obsidian is open. Set it back to `false` to hide them again.
- Inline reminders (lines ending in `from [[Note]]`) can be edited and completed here, and the change is written back to the task in that note. Deleting one here does nothing, since it lives in its note; delete the task line in the note instead.
- The plugin never rewrites the file while you have unsaved typing in it.
- Edits made while Obsidian was closed (for example on another device) are picked up on startup. To stay safe with sync, startup only adds new lines; changes and deletions are applied while Obsidian is running.

Use **Open reminders file** from the command palette or the button next to the path in settings.

## Lead-up notifications

In the reminder dialog, **Notify before** adds heads-up toasts before the reminder is due. Click a preset (5 min, 15 min, 30 min, 1 hr, 2 hr, 1 day), or type hours and minutes and click **Add** (or press Enter). A reminder can have up to 10. Click a chip to remove it.

- The heads-up toast has an alarm clock icon and a dashed edge, so it's easy to tell apart from the toast when the reminder is due. The reminder still shows its normal toast at the due time.
- Its text is set in **Settings > Reminder Toast > Lead-up toast title / body**. `{{lead}}` is how long before ("30 minutes"), and `{{relative}}` reads "in 30 minutes". **Show a test lead-up toast** under **Test** shows a sample.
- Repeating reminders get the heads-ups before every occurrence.
- If you create or move a reminder so that a lead-up time has already passed, that lead-up is skipped.
- If Obsidian was closed through several lead-up times and the reminder is still upcoming, you get one heads-up (the closest), not all of them.
- Snoozing doesn't trigger heads-ups for the snoozed time.
- In notes and the reminders file, use `@before(...)` with `d`, `h` and `m`, separated by commas:

```markdown
- [ ] Team meeting @remind(2026-10-02 17:00) @before(1h, 15m)
- [ ] Flight @remind(2026-10-09 08:00) @before(1d, 3h)
- [ ] Standup @remind(2026-10-02 09:30) @repeat(weekdays) @before(5m)
```

`1h30m`, `90` (minutes), `2 hours` and `45 min` also work.

## Calendar

Open it with the calendar ribbon icon or **Reminder Toast: Open reminder calendar**. It opens in the right sidebar.

- **Today** is highlighted. Click the month name or **Today** to jump back to it.
- Each reminder shows as a dot in its color. Repeating reminders show on every day they repeat. Completed ones are hollow.
- **Click** a day to see its reminders below the calendar. **Double click** a day to add a reminder.
- **Right click** a day for **Add reminder on (date)** or **Add weekly reminder on (weekday)s**.
- **Right click** a reminder in the day list to edit it, create a similar one, mark it done, snooze it, open its note, or delete it.
- **Pin** it with the pin button in the calendar header (or **Pin or unpin the reminder calendar**), so other files don't replace it. Obsidian remembers the pin.

### Calendar in a note

Add this code block anywhere in a note:

````markdown
```reminder-calendar
```
````

Or run **Insert reminder calendar into note** from the command palette, use **Insert reminder calendar** in the editor's right click menu, or copy the block from the sidebar calendar's day menu or **Settings > Reminder Toast > Calendar > Copy code for a calendar in a note**.

The embedded calendar works like the sidebar one (add, edit, right click menus, today highlight, colors) and stays in sync with it. Optional settings, one per line:

````markdown
```reminder-calendar
month: 2026-12
agenda: false
tags: work, urgent
```
````

- `month`: the month it opens on (`YYYY-MM`). Without it, it opens on the current month.
- `agenda`: `false` hides the list of reminders under the calendar.
- `tags`: only shows reminders with at least one of these tags. Reminders added from this calendar get these tags.
- `background`, `dim`, `fit`, `position`: a background image for this calendar only (see **Background images** below).

**In columns:** the calendar resizes to whatever width it gets. It works in callout-based columns (like the `[!multi-column]` callout from popular CSS snippets and themes), in the Multi-Column Markdown plugin, and in any other layout that renders code blocks. In a narrow column it switches to a compact layout with one-letter weekday names. In a wide note, the day list moves beside the month. When the insert command is used inside a callout, it keeps the `> ` prefix so the block stays in the column. In Live Preview, use the `</>` button that appears when you hover the calendar to edit the block's options.

### Background images

The calendar can show an image behind it. Any image Obsidian supports works: png, jpg/jpeg, gif (animated GIFs play), webp, avif, bmp and svg. Web addresses (https) work too, and are the only time the plugin uses the network (see [Network use and privacy](#network-use-and-privacy)).

There are two separate backgrounds, each with its own section in **Settings > Reminder Toast**:

- **Sidebar calendar background:** fills the whole sidebar pane (and popped-out calendar windows).
- **Note calendar background:** the default for every `reminder-calendar` block.

For each one:

- **Image:** type a vault path or `[[link]]` (suggestions with thumbnails appear as you type), or click **Choose** to pick from all images in your vault. The **x** removes it.
- **Fit:** Fill (crops to fill), Fit (shows the whole image), Tile, or Stretch, plus where to anchor it (center, top, bottom, left, right).
- **Dim:** fades the image toward your theme's background so dates stay readable. 0 shows the image at full strength. Higher values make it fainter. The default is 50.
- **Preview:** shows how it will look.

You can also right click (long press on touch) any day in a calendar and choose **Background image for sidebar calendar...** or **Background image for note calendars...**, or remove it from the same menu.

A single calendar in a note can use its own image with options in its code block. These override the note default for that block only:

````markdown
```reminder-calendar
background: [[beach.gif]]
dim: 30
fit: cover
position: bottom
```
````

Use `background: none` to show one calendar without an image. If a background image is moved or renamed in your vault, the settings follow it. Images set with `[[links]]` in code blocks follow Obsidian's usual link resolution.

### Pop-out calendar

Click the pop-out button in any calendar's header (sidebar or note), or run **Pop out reminder calendar**. The calendar opens in its own window that you can move to any monitor and resize. A calendar popped out from a note keeps that note calendar's tag filter, day list setting and background.

- Obsidian remembers popped-out windows and reopens them next time, with their settings.
- Clicking pop out again when that calendar is already popped out brings the existing window forward instead of opening another.

### Toasts across windows and screens

- **In the popped-out calendar:** toasts appear in the main Obsidian window and in each popped-out calendar window. Dismissing or acting on one (Done, Snooze, and so on) dismisses all of them. Turn this off with **Settings > Reminder Toast > Pop-out windows and toasts > Show toasts in the popped-out calendar**.
- **Pop-out toast:** when Obsidian isn't the active app, the toast also opens in its own small Obsidian window in the corner of the screen Obsidian is on. That works even when Obsidian is minimized, because it uses the screen the window was last on. If a popped-out calendar is on another monitor, that screen gets one too (one per screen, never duplicates). It has the same buttons as the in-app toast, and clicking the toast itself brings Obsidian back. It closes by itself when you return to Obsidian (the in-app toast is still there).
- Choose when pop-out toasts appear: **When Obsidian isn't the active app** (default), **Only when Obsidian is minimized**, or **Never**. **Show a test pop-out toast** shows one right away.
- Pop-out toasts follow the toast position and auto dismiss settings, and use your theme's colors.
- Pop-out toasts are ordinary Obsidian pop-out windows, so they can't float above other apps, and your system may give them focus when they open. Turn on **System notification** if you prefer reminders that never take focus.

### Using the calendar on a touchscreen

- **Long press** a day or a reminder for the menu, the same as right click.
- **Double tap** a day to add a reminder, or select a day and tap **+**.
- Each reminder in the day list has a **⋮** menu button.

Settings > Reminder Toast > Calendar has the first day of the week and the default time for reminders added from the calendar.

## Repeating reminders

In the reminder dialog, pick **Repeat**: every day, every weekday, every week, every month, every year, or **Custom** (every N days, weeks, months or years, with chosen weekdays for weekly). You can also set an end date.

- When a repeating reminder comes due, the toast shows as usual. **Done** moves it to the next occurrence instead of completing it. Once the end date passes, it completes.
- If you don't press Done, it waits in Due until the next occurrence arrives, then moves forward and shows again.
- **Snooze** only delays this occurrence. The series keeps its schedule.
- Monthly reminders on the 29th to 31st use the last day in shorter months and go back to the right day afterward.
- In notes and in the reminders file, add `@repeat(...)` after the `@remind(...)` marker:

```markdown
- [ ] Standup @remind(2026-10-02 09:30) @repeat(weekdays) #work
- [ ] Water plants @remind(2026-10-03 18:00) @repeat(every 2 weeks on mon, thu)
- [ ] Pay rent @remind(2026-11-01 09:00) @repeat(monthly until 2027-06-01)
```

Accepted repeat text: `daily`, `weekdays`, `weekly`, `monthly`, `yearly`, `every 3 days`, `every 2 weeks`, `every 6 months`, `weekly on mon, wed, fri`, plus an optional `until YYYY-MM-DD`. Checking off a repeating task in a note moves it to the next date and unchecks it.

## Colors and tags

- **Color:** the reminder dialog has a row of swatches, a custom color picker, and **A** (auto). The color is used on the calendar, in the list, and as the toast's accent.
- **Tags:** type tags in the dialog (comma separated), or click one of your existing tags. In notes and the reminders file, use `#tags` on the line.
- **Tag colors:** a reminder with no color of its own uses the color of its first tag. A tag you use for the first time is added to **Settings > Reminder Toast > Tag colors** with a color. There you can change its color, rename it, delete it, or add tags with the **+** button.
- **Automatic colors:** a reminder with no color and no colored tag gets a color picked from its title, so repeats and reminders with the same title always match. Turn this off in the Calendar settings.
- **Create similar:** in the list, the calendar, or a right click menu. It opens a new reminder with the same title, message, color, tags, repeat, linked note, and toast text, set for the next upcoming time.
- Toast templates can use `{{tags}}` and `{{repeat}}`.

## Desktop only

Reminder Toast is a desktop-only plugin (`isDesktopOnly` is `true` in its manifest). Pop-out windows, which the pop-out calendar and pop-out toasts use, are available only in the Obsidian desktop app.

## Network use and privacy

- **Network use:** Reminder Toast only connects to the internet if you set a calendar background image to a web address (an `https://` link) in settings or in a `reminder-calendar` code block. In that case the image is downloaded from that address to show it, the same way an image link in a note is. Nothing is sent. Images from your vault never use the network.
- **No telemetry:** the plugin doesn't collect or send any usage data.
- **No ads, no account, no payment:** everything is free and works offline.
- **Your files:** the plugin only reads and writes files inside your vault: your notes (for inline reminders), the reminders file you choose, and its own `data.json`. It doesn't access files outside the vault.

## Ways to create a reminder

- Ribbon icon (bell with a plus)
- Command palette: **Reminder Toast: Create reminder**
- Command palette: **Reminder Toast: Create reminder from selection** (uses the selected text or current line as the title and links the current note)
- Right click in the editor: **Create reminder**
- Right click a file in the file explorer: **Remind me about this note**
- **New** button in the reminder sidebar (**Reminder Toast: Open reminder list**)
- Calendar: right click or double click a day, or the **+** button
- **Create similar** on any existing reminder
