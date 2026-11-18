"use client";

import { useId, useMemo, useState } from "react";
import { FileIcon, LockIcon, SearchIcon, ServerIcon } from "@/components/ui/icons";
import type { UploadFile } from "@/lib/protocol/payload";
import type { Workspace } from "./workspace";

const SERVER = "\u0000server";

interface Group {
  id: string;
  label: string;
  files: { file: UploadFile; name: string }[];
}

function groupFiles(files: UploadFile[]): Group[] {
  const groups = new Map<string, Group>();
  for (const file of files) {
    const id = file.plugin ?? SERVER;
    let group = groups.get(id);
    if (!group) {
      group = { id, label: file.plugin ?? "Server", files: [] };
      groups.set(id, group);
    }
    const prefix = file.plugin ? `plugins/${file.plugin}/` : "";
    group.files.push({ file, name: file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path });
  }
  const sorted = Array.from(groups.values()).sort((a, b) =>
    a.id === SERVER ? -1 : b.id === SERVER ? 1 : a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  // config.yml first, then by path, so the file people want most is on top.
  for (const g of sorted) {
    g.files.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  return sorted;
}

const rank = (name: string) => (/^config\.(ya?ml|json|toml)$/i.test(name) ? 0 : name.includes("/") ? 2 : 1);

export function FileTree({ workspace, files, onPick }: { workspace: Workspace; files: UploadFile[]; onPick?: () => void }) {
  const [query, setQuery] = useState("");
  const [plugin, setPlugin] = useState("");
  const searchId = useId();
  const filterId = useId();
  const groups = useMemo(() => groupFiles(files), [files]);

  const q = query.trim().toLowerCase();
  const visible = groups
    .filter((g) => plugin === "" || g.id === plugin)
    .map((g) => ({ ...g, files: q ? g.files.filter((f) => f.file.path.toLowerCase().includes(q)) : g.files }))
    .filter((g) => g.files.length > 0);
  const total = visible.reduce((n, g) => n + g.files.length, 0);

  return (
    <nav aria-label="Config files" className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <label htmlFor={searchId} className="sr-only">
          Search files
        </label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-line bg-ink py-1.5 pr-2 pl-8 text-sm text-text placeholder:text-dim focus:border-sakura focus:outline-none"
          />
        </div>
        {groups.length > 1 ? (
          <>
            <label htmlFor={filterId} className="sr-only">
              Show files from
            </label>
            <select
              id={filterId}
              value={plugin}
              onChange={(e) => setPlugin(e.target.value)}
              className="w-full rounded-md border border-line bg-ink px-2 py-1.5 text-sm text-muted focus:border-sakura focus:outline-none"
            >
              <option value="">All plugins ({files.length} files)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label} ({g.files.length})
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2" aria-live="polite" aria-relevant="additions removals">
        {total === 0 ? <p className="px-4 py-6 text-center text-sm text-dim">No files match “{query}”.</p> : null}
        {visible.map((g) => (
          <details key={g.id} open className="group mb-1">
            <summary className="mx-2 flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-[12px] font-medium tracking-wide text-dim uppercase select-none hover:text-muted [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="w-2 text-faint transition-transform group-open:rotate-90">
                ▸
              </span>
              {g.id === SERVER ? <ServerIcon className="text-faint" /> : null}
              <span className="truncate">{g.label}</span>
              <span className="ml-auto text-dim tabular-nums">{g.files.length}</span>
            </summary>
            <ul role="list">
              {g.files.map(({ file, name }) => (
                <FileRow key={file.path} workspace={workspace} file={file} name={name} onPick={onPick} />
              ))}
            </ul>
          </details>
        ))}
      </div>
    </nav>
  );
}

function FileRow({ workspace, file, name, onPick }: { workspace: Workspace; file: UploadFile; name: string; onPick?: () => void }) {
  const active = workspace.active === file.path;
  const changed = workspace.isChanged(file.path);
  const problems = workspace.entries.get(file.path)?.state || changed ? workspace.problemsFor(file.path) : [];
  const errors = problems.some((p) => p.severity === "error");
  const slash = name.lastIndexOf("/");

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          workspace.openFile(file.path);
          onPick?.();
        }}
        aria-current={active ? "true" : undefined}
        title={file.path}
        className={`group/row mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md py-1.5 pr-2 pl-6 text-left text-[13px] transition-colors ${
          active ? "bg-sakura/12 text-text" : "text-muted hover:bg-white/[0.035] hover:text-text"
        }`}
      >
        <FileIcon className={active ? "flex-none text-blossom" : "flex-none text-faint"} />
        <span className="min-w-0 flex-1 truncate">
          {slash >= 0 ? <span className="text-dim">{name.slice(0, slash + 1)}</span> : null}
          {name.slice(slash + 1)}
        </span>
        {file.secrets.length > 0 ? (
          <LockIcon className="flex-none text-faint" title={`${file.secrets.length} locked secret${file.secrets.length === 1 ? "" : "s"}`} />
        ) : null}
        {errors ? (
          <span className="size-2 flex-none rounded-full bg-red" role="img" aria-label="has errors" />
        ) : changed ? (
          <span className="size-2 flex-none rounded-full bg-blossom" role="img" aria-label="changed" />
        ) : null}
      </button>
    </li>
  );
}
