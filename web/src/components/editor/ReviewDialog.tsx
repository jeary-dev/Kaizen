"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CloseIcon, ErrorIcon, LockIcon, WarningIcon } from "@/components/ui/icons";
import { lineColumn } from "@/lib/editor/text";
import { ApplyCode } from "./ApplyCode";
import { DiffView } from "./DiffView";
import type { Workspace } from "./workspace";

interface Props {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
  /** Saves and resolves with the apply code. Rejects with a user-facing message. */
  onSave: () => Promise<string>;
  expired: boolean;
  nonce?: string;
}

export function ReviewDialog({ workspace, open, onClose, onSave, expired, nonce }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [override, setOverride] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Reset the transient state for each opening.
      setCode(null);
      setError(null);
      setOverride(false);
      setSelected(workspace.changedPaths()[0] ?? null);
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, workspace]);

  const paths = open ? workspace.changedPaths() : [];
  const current = selected && paths.includes(selected) ? selected : (paths[0] ?? null);
  const all = paths.map((path) => ({
    path,
    stat: workspace.stat(path),
    problems: workspace.problemsFor(path),
    removed: workspace.removedSecrets(path),
  }));
  const errorCount = all.reduce((n, f) => n + f.problems.filter((p) => p.severity === "error").length, 0);
  const totals = all.reduce((t, f) => ({ added: t.added + f.stat.added, removed: t.removed + f.stat.removed }), { added: 0, removed: 0 });
  const entry = current ? workspace.entries.get(current) : undefined;
  const info = all.find((f) => f.path === current);
  const blocked = expired || saving || paths.length === 0 || (errorCount > 0 && !override);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      setCode(await onSave());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saving failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      className="m-auto h-[min(92vh,900px)] w-[min(96vw,1280px)] max-w-none overflow-hidden rounded-xl border border-line bg-surface p-0 text-text shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-[2px]"
    >
      {open ? (
        <div className="flex h-full flex-col">
          <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
            <h2 id={titleId} className="text-[15px] font-medium">
              {code ? "Saved" : "Review changes"}
            </h2>
            {!code && paths.length > 0 ? (
              <span className="text-sm text-dim tabular-nums">
                {paths.length} file{paths.length === 1 ? "" : "s"} · <span className="text-matcha">+{totals.added}</span>{" "}
                <span className="text-red">−{totals.removed}</span>
              </span>
            ) : null}
            <button type="button" onClick={onClose} className="ml-auto rounded-md p-1.5 text-dim hover:bg-white/5 hover:text-text" aria-label="Close">
              <CloseIcon />
            </button>
          </header>

          {code ? (
            <Saved code={code} onDone={onClose} />
          ) : paths.length === 0 ? (
            <div className="grid flex-1 place-items-center p-8 text-center text-dim">
              <p>You haven&apos;t changed anything yet.</p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <ul className="max-h-40 flex-none overflow-y-auto border-b border-line p-2 md:max-h-none md:w-72 md:border-r md:border-b-0" aria-label="Changed files">
                {all.map((f) => {
                  const errors = f.problems.filter((p) => p.severity === "error").length;
                  const warnings = f.problems.length - errors + f.removed.length;
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => setSelected(f.path)}
                        aria-current={f.path === current ? "true" : undefined}
                        className={`w-full rounded-md px-3 py-2 text-left text-[13px] ${f.path === current ? "bg-sakura/12 text-text" : "text-muted hover:bg-white/[0.035]"}`}
                      >
                        <span className="block truncate" title={f.path}>
                          {f.path}
                        </span>
                        <span className="mt-0.5 flex items-center gap-3 text-[12px] text-dim tabular-nums">
                          <span>
                            <span className="text-matcha">+{f.stat.added}</span> <span className="text-red">−{f.stat.removed}</span>
                          </span>
                          {errors ? (
                            <span className="inline-flex items-center gap-1 text-red">
                              <ErrorIcon className="size-3.5" />
                              {errors}
                            </span>
                          ) : null}
                          {warnings ? (
                            <span className="inline-flex items-center gap-1 text-amber">
                              <WarningIcon className="size-3.5" />
                              {warnings}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
                {info && (info.problems.length > 0 || info.removed.length > 0) ? (
                  <ul className="space-y-1.5 text-[13px]" aria-label="Problems in this file">
                    {info.removed.map((key) => (
                      <li key={key} className="flex gap-2 rounded-md border border-amber/25 bg-amber/5 px-3 py-2 text-amber">
                        <LockIcon className="mt-0.5 flex-none" />
                        <span>
                          The locked value <strong className="font-medium text-text">{key}</strong> was removed. Its real value will be deleted from the file.
                        </span>
                      </li>
                    ))}
                    {info.problems.slice(0, 8).map((p, i) => {
                      const { line, column } = lineColumn(entry?.text ?? "", p.from);
                      return (
                        <li
                          key={i}
                          className={`flex gap-2 rounded-md border px-3 py-2 ${p.severity === "error" ? "border-red/25 bg-red/5 text-red" : "border-amber/25 bg-amber/5 text-amber"}`}
                        >
                          {p.severity === "error" ? <ErrorIcon className="mt-0.5 flex-none" /> : <WarningIcon className="mt-0.5 flex-none" />}
                          <span>
                            <span className="text-dim tabular-nums">
                              Line {line}:{column}
                            </span>{" "}
                            <span className="text-text">{p.message}</span>
                          </span>
                        </li>
                      );
                    })}
                    {info.problems.length > 8 ? <li className="px-3 text-dim">…and {info.problems.length - 8} more in the editor.</li> : null}
                  </ul>
                ) : null}
                {entry && current ? (
                  <DiffView key={current} before={entry.original} after={entry.text} lang={entry.file.lang} nonce={nonce} />
                ) : null}
              </div>
            </div>
          )}

          {!code && paths.length > 0 ? (
            <footer className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3.5">
              {errorCount > 0 ? (
                <label className="flex items-center gap-2 text-[13px] text-muted">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="size-4 accent-sakura" />
                  Save anyway, even though {errorCount === 1 ? "a file has an error" : `there are ${errorCount} errors`}
                </label>
              ) : (
                <p className="text-[13px] text-dim">Nothing changes on the server until you apply the code there and confirm.</p>
              )}
              {error ? (
                <p role="alert" className="text-[13px] text-red">
                  {error}
                </p>
              ) : null}
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={onClose} className="rounded-md px-3.5 py-2 text-sm text-muted hover:bg-white/5 hover:text-text">
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={save}
                  autoFocus
                  disabled={blocked}
                  className="rounded-md bg-sakura px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-blossom disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? "Encrypting…" : expired ? "Session expired" : "Save & get apply code"}
                </button>
              </div>
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

function Saved({ code, onDone }: { code: string; onDone: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto p-8 animate-fade-in">
      <ApplyCode code={code} focus />
      <ol className="max-w-md space-y-2 text-[14px] text-muted">
        <li>
          <span className="text-blossom">1.</span> Run the command in game, or in the console without the slash.
        </li>
        <li>
          <span className="text-blossom">2.</span> Kaizen shows a summary. Click <span className="text-matcha">[Confirm]</span> to back up and write the files.
        </li>
        <li>
          <span className="text-blossom">3.</span> Reload the plugins it lists. You can undo with <code className="font-mono text-text">/kaizen undo</code>.
        </li>
      </ol>
      <p className="max-w-md text-center text-[13px] text-dim">
        The code works once. If you keep editing and save again, you&apos;ll get a new code and this one stops working.
      </p>
      <button type="button" onClick={onDone} className="rounded-md border border-line px-4 py-2 text-sm text-muted hover:border-line-strong hover:text-text">
        Back to the editor
      </button>
    </div>
  );
}
