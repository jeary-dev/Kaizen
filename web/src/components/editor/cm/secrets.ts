import { EditorState, type Extension, RangeSetBuilder, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { placeholderPattern } from "@/lib/protocol/formats";

/**
 * Locked secrets. Each placeholder is drawn as a small "locked" chip and behaves as one unit:
 *
 * - The cursor jumps over it and nothing can be typed inside or right next to it in a way that
 *   would change the id (`KAIZEN_SECRET_1_ab12x` would no longer be recognised).
 * - It can only be removed as a whole (e.g. by deleting the line). The review screen then warns
 *   that the real value will be deleted on apply.
 *
 * The real value never reaches the browser; the plugin swaps it back in when it applies.
 */

const LOCK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';

class SecretWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly key: string,
  ) {
    super();
  }
  eq(other: SecretWidget) {
    return other.id === this.id && other.key === this.key;
  }
  toDOM() {
    const chip = document.createElement("span");
    chip.className = "cm-kz-secret";
    chip.title = `Locked secret "${this.key}". The real value stays on your server and is put back when you apply.`;
    chip.setAttribute("role", "img");
    chip.setAttribute("aria-label", `locked secret ${this.key}`);
    chip.innerHTML = LOCK_SVG;
    chip.append(document.createTextNode("locked"));
    return chip;
  }
  ignoreEvent() {
    return false;
  }
}

interface Ranges {
  decorations: DecorationSet;
  spans: { from: number; to: number; id: string }[];
}

export function lockedSecrets(tag: string, keys: ReadonlyMap<string, string>): Extension {
  const pattern = placeholderPattern(tag);

  const scan = (doc: Text): Ranges => {
    const text = doc.toString();
    const builder = new RangeSetBuilder<Decoration>();
    const spans: Ranges["spans"] = [];
    for (const m of text.matchAll(pattern)) {
      const from = m.index ?? 0;
      const to = from + m[0].length;
      spans.push({ from, to, id: m[0] });
      builder.add(from, to, Decoration.replace({ widget: new SecretWidget(m[0], keys.get(m[0]) ?? "secret") }));
    }
    return { decorations: builder.finish(), spans };
  };

  const field = StateField.define<Ranges>({
    create: (state) => scan(state.doc),
    update: (value, tr) => (tr.docChanged ? scan(tr.state.doc) : value),
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(f).decorations),
    ],
  });

  // Reject any change that would alter a placeholder without removing all of it.
  const guard = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    const { spans } = tr.startState.field(field);
    const touched = spans.filter((s) => {
      let hit = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA <= s.to && toA >= s.from) hit = true;
      });
      return hit;
    });
    if (touched.length === 0) return tr;
    const after = new Set(Array.from(tr.newDoc.toString().matchAll(pattern), (m) => m[0]));
    for (const s of touched) {
      if (after.has(s.id)) continue;
      let removedWhole = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA <= s.from && toA >= s.to) removedWhole = true;
      });
      if (!removedWhole) return [];
    }
    return tr;
  });

  return [field, guard];
}
