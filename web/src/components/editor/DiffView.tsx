"use client";

import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Lang } from "@/lib/protocol/payload";
import { reviewExtensions } from "./cm/setup";

const WIDE = "(min-width: 768px)";
const subscribeWide = (cb: () => void) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** Side by side on wide screens, unified on narrow ones. Read-only. */
export function DiffView({ before, after, lang, nonce }: { before: string; after: string; lang: Lang; nonce?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const extensions = reviewExtensions(lang, nonce);
    const collapse = { margin: 3, minSize: 6 };
    if (wide) {
      const merge = new MergeView({
        a: { doc: before, extensions },
        b: { doc: after, extensions },
        parent,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: collapse,
      });
      return () => merge.destroy();
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: after,
        extensions: [...extensions, unifiedMergeView({ original: before, mergeControls: false, highlightChanges: true, gutter: true })],
      }),
    });
    return () => view.destroy();
  }, [before, after, lang, nonce, wide]);

  return (
    <div className="min-h-0 overflow-hidden rounded-lg border border-line">
      <div className="hidden grid-cols-2 border-b border-line bg-surface text-[11px] font-medium tracking-wider text-dim uppercase md:grid">
        <span className="px-4 py-1.5">On the server now</span>
        <span className="border-l border-line px-4 py-1.5">After applying</span>
      </div>
      <div ref={host} className="max-h-[60vh] overflow-auto text-[13px] [&_.cm-editor]:bg-ink" />
    </div>
  );
}
