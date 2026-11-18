"use client";

import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { Workspace } from "./workspace";

/**
 * One EditorView for all tabs. Switching tabs stores the outgoing file's state (with its undo
 * history and selection) and swaps in the next one.
 */
export function CodeEditor({ workspace, path, onView }: { workspace: Workspace; path: string; onView?: (view: EditorView | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const v = new EditorView({ parent, state: workspace.stateFor(path) });
    view.current = v;
    shown.current = path;
    onView?.(v);
    return () => {
      if (shown.current) workspace.remember(shown.current, v.state);
      v.destroy();
      view.current = null;
      onView?.(null);
    };
    // The view is created once; `path` changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  useEffect(() => {
    const v = view.current;
    if (!v || shown.current === path) return;
    if (shown.current) workspace.remember(shown.current, v.state);
    v.setState(workspace.stateFor(path));
    shown.current = path;
    v.focus();
  }, [workspace, path]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none" />;
}
