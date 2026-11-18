"use client";

import { openLintPanel } from "@codemirror/lint";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ClockIcon, CloseIcon, LockIcon, MenuIcon, SearchIcon, ShieldIcon } from "@/components/ui/icons";
import { Mark } from "@/components/ui/Mark";
import { displayApplyCode } from "@/lib/protocol/formats";
import { keyFromFragment, type LoadedSession, RemoteSession, SessionError, type SessionSource, SID_PATTERN } from "@/lib/editor/session";
import { ApplyCode } from "./ApplyCode";
import { LANG_LABEL } from "./cm/languages";
import { CodeEditor } from "./CodeEditor";
import { FileTree } from "./FileTree";
import { ReviewDialog } from "./ReviewDialog";
import { Workspace } from "./workspace";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; error: SessionError }
  | { kind: "ready"; session: LoadedSession; workspace: Workspace }
  | { kind: "closed"; reason: "discarded" };

/** The real editor: keys come from the URL fragment, which the browser never sends anywhere. */
export function RemoteEditor({ sid, nonce }: { sid: string; nonce?: string }) {
  const [source, setSource] = useState<SessionSource | SessionError | null>(null);
  useEffect(() => {
    const key = keyFromFragment(window.location.hash);
    // Reading the fragment is only possible after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSource(
      !SID_PATTERN.test(sid) || !key
        ? new SessionError("link", "This link is incomplete. Copy the whole link from Minecraft, including the part after #.")
        : new RemoteSession(sid, key),
    );
  }, [sid]);
  if (source === null) return <Splash>Decrypting your configs…</Splash>;
  if (source instanceof SessionError) return <ErrorScreen error={source} />;
  return <EditorApp source={source} nonce={nonce} />;
}

export function EditorApp({ source, nonce, banner, initialFile }: { source: SessionSource; nonce?: string; banner?: ReactNode; initialFile?: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const run = useCallback(
    () =>
      source
        .load()
        .then((session) => setPhase({ kind: "ready", session, workspace: new Workspace(session.upload.files, session.tag, nonce) }))
        .catch((e: unknown) =>
          setPhase({ kind: "error", error: e instanceof SessionError ? e : new SessionError("network", "Something went wrong while loading.") }),
        ),
    [source, nonce],
  );
  useEffect(() => {
    void run();
  }, [run]);
  const load = () => {
    setPhase({ kind: "loading" });
    void run();
  };

  if (phase.kind === "loading") return <Splash>Decrypting your configs…</Splash>;
  if (phase.kind === "error") return <ErrorScreen error={phase.error} onRetry={phase.error.kind === "network" || phase.error.kind === "rate" ? load : undefined} />;
  if (phase.kind === "closed") {
    return (
      <Centered title="Session closed">
        <p>The editor session was discarded and its encrypted data deleted. Nothing was changed on your server.</p>
      </Centered>
    );
  }
  return (
    <Editor
      session={phase.session}
      workspace={phase.workspace}
      source={source}
      nonce={nonce}
      banner={banner}
      initialFile={initialFile}
      onDiscarded={() => setPhase({ kind: "closed", reason: "discarded" })}
      onConflict={load}
    />
  );
}

function Editor({
  session,
  workspace,
  source,
  nonce,
  banner,
  initialFile,
  onDiscarded,
  onConflict,
}: {
  session: LoadedSession;
  workspace: Workspace;
  source: SessionSource;
  nonce?: string;
  banner?: ReactNode;
  initialFile?: string;
  onDiscarded: () => void;
  onConflict: () => void;
}) {
  useSyncExternalStore(workspace.subscribe, workspace.getVersion, workspace.getVersion);
  const [reviewing, setReviewing] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [rev, setRev] = useState(session.latestRev);
  const [code, setCode] = useState<string | null>(session.pending?.code ?? null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const view = useRef<EditorView | null>(null);
  const remaining = useRemaining(session.expiresAt);
  const expired = remaining <= 0;
  const files = session.upload.files;
  const secretCount = useMemo(() => files.reduce((n, f) => n + f.secrets.length, 0), [files]);

  // Open the most likely file first: a single plugin's config.yml, or nothing for "all".
  useEffect(() => {
    if (workspace.open.length > 0) return;
    if (initialFile && workspace.entries.has(initialFile)) {
      workspace.openFile(initialFile);
    } else if (session.upload.scope !== "all") {
      const first = files.find((f) => /\/config\.ya?ml$/.test(f.path)) ?? files[0];
      if (first) workspace.openFile(first.path);
    }
  }, [workspace, files, session.upload.scope, initialFile]);

  const unsaved = workspace.hasUnsaved() && workspace.changedPaths().length > 0;
  useEffect(() => {
    if (!unsaved || expired) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved, expired]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setReviewing(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function save(): Promise<string> {
    const next = rev + 1;
    try {
      const saved = await source.save(workspace.changes(), next);
      setRev(saved.rev);
      setCode(saved.code);
      workspace.markSaved();
      return saved.code;
    } catch (e) {
      if (e instanceof SessionError && e.kind === "conflict") {
        setReviewing(false);
        onConflict();
      }
      throw e;
    }
  }

  async function discard() {
    await source.discard().catch(() => undefined);
    onDiscarded();
  }

  const active = workspace.active;
  const activeEntry = active ? workspace.entries.get(active) : undefined;
  const activeProblems = active ? workspace.problemsFor(active) : [];
  const changedCount = workspace.changedPaths().length;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {banner}
      <header className="flex flex-none items-center gap-3 border-b border-line bg-surface px-3 py-2.5 sm:px-4">
        <button
          type="button"
          onClick={() => setSidebar((s) => !s)}
          className="rounded-md p-1.5 text-dim hover:bg-white/5 hover:text-text lg:hidden"
          aria-label={sidebar ? "Hide files" : "Show files"}
          aria-expanded={sidebar}
          aria-controls="kz-sidebar"
        >
          <MenuIcon />
        </button>
        <Mark href={null} />
        <span className="hidden h-4 w-px bg-line sm:block" aria-hidden="true" />
        <span className="hidden min-w-0 truncate text-[13px] text-dim sm:block" title={session.upload.server.software}>
          {session.upload.server.software}
        </span>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <span className="hidden items-center gap-1.5 text-[12px] text-dim md:inline-flex" title="Encrypted in your browser with a key the server never sees">
            <ShieldIcon className="text-matcha" /> End-to-end encrypted
          </span>
          <Countdown remaining={remaining} />
          {code && !unsaved ? (
            <span className="hidden items-center gap-2 rounded-md border border-line px-2.5 py-1 text-[12px] text-dim lg:inline-flex">
              Code <span className="font-mono text-text">{displayApplyCode(code)}</span>
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setConfirmDiscard(true)}
            className="hidden rounded-md px-3 py-1.5 text-[13px] text-dim hover:bg-white/5 hover:text-text sm:block"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => setReviewing(true)}
            disabled={expired}
            className="inline-flex items-center gap-2 rounded-md bg-sakura px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-blossom disabled:opacity-40"
          >
            Review changes
            {changedCount > 0 ? <span className="rounded-full bg-ink/25 px-1.5 text-[11px] tabular-nums">{changedCount}</span> : null}
          </button>
        </div>
      </header>

      {expired ? (
        <p role="alert" className="flex-none border-b border-red/30 bg-red/10 px-4 py-2 text-center text-[13px] text-red">
          This session has expired. Changes can no longer be saved. Run <code className="font-mono">/kaizen editor</code> again for a new one.
        </p>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        {sidebar ? <button type="button" className="fixed inset-0 z-20 bg-black/50 lg:hidden" aria-label="Close file list" onClick={() => setSidebar(false)} /> : null}
        <aside
          id="kz-sidebar"
          className={`${sidebar ? "translate-x-0" : "-translate-x-full"} absolute inset-y-0 left-0 z-30 w-72 border-r border-line bg-surface transition-transform lg:static lg:z-auto lg:translate-x-0`}
        >
          <FileTree workspace={workspace} files={files} onPick={() => setSidebar(false)} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {workspace.open.length > 0 ? (
            <Tabs workspace={workspace} />
          ) : null}
          <div className="min-h-0 flex-1">
            {active ? (
              <CodeEditor workspace={workspace} path={active} onView={(v) => (view.current = v)} />
            ) : (
              <Welcome fileCount={files.length} secretCount={secretCount} pending={code} />
            )}
          </div>
          {activeEntry ? (
            <footer className="flex flex-none items-center gap-4 border-t border-line bg-surface px-4 py-1.5 text-[12px] text-dim">
              <span className="min-w-0 truncate" title={activeEntry.file.path}>
                {activeEntry.file.path}
              </span>
              <span className="ml-auto flex items-center gap-4">
                {activeEntry.file.secrets.length > 0 ? (
                  <span className="inline-flex items-center gap-1" title="Values Kaizen kept on your server">
                    <LockIcon className="size-3.5" /> {activeEntry.file.secrets.length} locked
                  </span>
                ) : null}
                <button type="button" onClick={() => view.current && openLintPanel(view.current)} className="hover:text-text">
                  <ProblemSummary problems={activeProblems} />
                </button>
                <button type="button" onClick={() => view.current && openSearchPanel(view.current)} className="hidden items-center gap-1 hover:text-text sm:inline-flex">
                  <SearchIcon className="size-3.5" /> Find
                </button>
                <span>{LANG_LABEL[activeEntry.file.lang]}</span>
                <span>{activeEntry.lineBreak === "\r\n" ? "CRLF" : "LF"}</span>
              </span>
            </footer>
          ) : null}
        </main>
      </div>

      <ReviewDialog workspace={workspace} open={reviewing} onClose={() => setReviewing(false)} onSave={save} expired={expired} nonce={nonce} />
      <ConfirmDiscard open={confirmDiscard} onCancel={() => setConfirmDiscard(false)} onConfirm={discard} />
    </div>
  );
}

function Tabs({ workspace }: { workspace: Workspace }) {
  return (
    <div role="tablist" aria-label="Open files" className="flex flex-none overflow-x-auto border-b border-line bg-surface">
      {workspace.open.map((path) => {
        const active = workspace.active === path;
        const changed = workspace.isChanged(path);
        const name = path.slice(path.lastIndexOf("/") + 1);
        return (
          <div
            key={path}
            className={`group flex flex-none items-center border-r border-line ${active ? "bg-ink text-text shadow-[inset_0_-2px_0_var(--color-sakura)]" : "text-dim hover:text-muted"}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={path}
              onClick={() => workspace.openFile(path)}
              onAuxClick={(e) => e.button === 1 && workspace.closeFile(path)}
              className="max-w-56 truncate py-2 pr-1 pl-3.5 text-[13px]"
            >
              {name}
            </button>
            <button
              type="button"
              onClick={() => workspace.closeFile(path)}
              aria-label={`Close ${name}`}
              className="mr-1.5 grid size-5 place-items-center rounded text-faint hover:bg-white/10 hover:text-text"
            >
              {changed ? <span className="size-2 rounded-full bg-blossom group-hover:hidden" aria-hidden="true" /> : null}
              <CloseIcon className={`size-3.5 ${changed ? "hidden group-hover:block" : ""}`} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ProblemSummary({ problems }: { problems: { severity: string }[] }) {
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.length - errors;
  if (problems.length === 0) return <span className="text-matcha/80">No problems</span>;
  return (
    <span className="tabular-nums">
      {errors ? <span className="text-red">{errors} error{errors === 1 ? "" : "s"}</span> : null}
      {errors && warnings ? " · " : null}
      {warnings ? <span className="text-amber">{warnings} warning{warnings === 1 ? "" : "s"}</span> : null}
    </span>
  );
}

function Welcome({ fileCount, secretCount, pending }: { fileCount: number; secretCount: number; pending: string | null }) {
  return (
    <div className="grid h-full place-items-center overflow-y-auto p-8">
      <div className="max-w-md text-center animate-fade-in">
        <p aria-hidden="true" className="font-kanji text-6xl text-sakura/80">
          改善
        </p>
        <h1 className="mt-5 text-lg font-medium">Pick a file to start</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-dim">
          {fileCount} config file{fileCount === 1 ? "" : "s"} decrypted in this tab.
          {secretCount > 0 ? ` ${secretCount} secret value${secretCount === 1 ? " stays" : "s stay"} on your server, shown here as locked.` : ""}
        </p>
        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-left text-[13px] text-dim">
          <dt className="font-mono text-muted">Ctrl F</dt>
          <dd>Find and replace</dd>
          <dt className="font-mono text-muted">Ctrl S</dt>
          <dd>Review and save</dd>
          <dt className="font-mono text-muted">Ctrl Z</dt>
          <dd>Undo, per file</dd>
        </dl>
        {pending ? (
          <div className="mt-8 rounded-lg border border-line bg-surface p-5">
            <p className="mb-3 text-[13px] text-dim">You already saved changes in this session:</p>
            <ApplyCode code={pending} compact />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Countdown({ remaining }: { remaining: number }) {
  const s = Math.max(0, Math.floor(remaining / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const text = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  const tone = s === 0 ? "text-red" : s < 300 ? "text-amber" : "text-dim";
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] tabular-nums ${tone}`} title="Time left to save changes in this session">
      <ClockIcon className="size-3.5" />
      <span className="sr-only">Expires in </span>
      {text}
    </span>
  );
}

function useRemaining(expiresAt: Date): number {
  const subscribe = useCallback((cb: () => void) => {
    const t = setInterval(cb, 1000);
    return () => clearInterval(t);
  }, []);
  const get = useCallback(() => Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000) * 1000), [expiresAt]);
  return useSyncExternalStore(subscribe, get, get);
}

function ConfirmDiscard({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onCancel}
      aria-labelledby="kz-discard-title"
      className="m-auto w-[min(92vw,440px)] rounded-xl border border-line bg-surface p-6 text-text backdrop:bg-black/70"
    >
      <h2 id="kz-discard-title" className="text-[15px] font-medium">
        Discard this session?
      </h2>
      <p className="mt-2 text-[14px] text-dim">
        The encrypted upload and any saved changes are deleted right away, and the apply code stops working. Your server is not changed.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md px-3.5 py-2 text-sm text-muted hover:bg-white/5 hover:text-text">
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className="rounded-md bg-red/90 px-3.5 py-2 text-sm font-medium text-ink hover:bg-red">
          Discard
        </button>
      </div>
    </dialog>
  );
}

// ------------------------------------------------------------------------------------------------

function Splash({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center" role="status">
      <div className="text-center">
        <p aria-hidden="true" className="font-kanji text-5xl text-sakura animate-pulse">
          改善
        </p>
        <p className="mt-4 text-sm text-dim">{children}</p>
      </div>
    </div>
  );
}

function Centered({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="max-w-md text-center animate-fade-in">
        <Mark />
        <h1 className="mt-8 text-xl font-medium">{title}</h1>
        <div className="mt-3 text-[15px] leading-relaxed text-muted">{children}</div>
        {action ? <div className="mt-6">{action}</div> : null}
      </div>
    </main>
  );
}

const ERROR_TITLES: Record<SessionError["kind"], string> = {
  link: "Incomplete link",
  gone: "Session not found",
  applied: "Already applied",
  decrypt: "Can't decrypt",
  rate: "Too many requests",
  conflict: "Newer changes exist",
  "too-large": "Too large",
  network: "Connection problem",
};

function ErrorScreen({ error, onRetry }: { error: SessionError; onRetry?: () => void }) {
  return (
    <Centered
      title={ERROR_TITLES[error.kind]}
      action={
        onRetry ? (
          <button type="button" onClick={onRetry} className="rounded-md bg-sakura px-4 py-2 text-sm font-medium text-ink hover:bg-blossom">
            Try again
          </button>
        ) : null
      }
    >
      <p role="alert">{error.message}</p>
    </Centered>
  );
}
