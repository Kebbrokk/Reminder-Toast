import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/**
 * Hides the " %%rt:id%%" tags at the end of reminders file lines while editing
 * (Live Preview and Source mode). Reading view already hides %% comments.
 * The hidden text is kept in the file; the cursor just skips over it.
 */

const ID_RE = /[ \t]*%%rt:[\w-]+%%/g;
const hidden = Decoration.replace({});

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    ID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ID_RE.exec(text))) {
      builder.add(from + m.index, from + m.index + m[0].length, hidden);
    }
  }
  return builder.finish();
}

export function hideReminderIdsExtension() {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    {
      decorations: (v) => v.decorations,
      // Treat each hidden ID as one unit so arrow keys and backspace don't land inside it.
      provide: (p) =>
        EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
    }
  );
  return [plugin];
}
