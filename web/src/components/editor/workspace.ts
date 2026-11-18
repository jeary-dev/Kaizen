import { diff } from "@codemirror/merge";
import type { EditorState } from "@codemirror/state";
import { detectLineBreak, fromEditorText, type LineBreak, toEditorText } from "@/lib/editor/text";
import { missingPlaceholders, type Problem, validate } from "@/lib/editor/validate";
import type { ChangedFile, UploadFile } from "@/lib/protocol/payload";
import { createFileState } from "./cm/setup";

export interface Entry {
  file: UploadFile;
  lineBreak: LineBreak;
  /** As uploaded, LF form. */
  original: string;
  /** Current text, LF form. */
  text: string;
  state: EditorState | null;
  problems: Problem[];
  secretKeys: Map<string, string>;
}

export interface FileStat {
  added: number;
  removed: number;
}

/**
 * The editor's documents, outside React. Components subscribe through `useSyncExternalStore` and
 * read what they need; typing only notifies, it never re-renders the tree by itself.
 */
export class Workspace {
  readonly entries = new Map<string, Entry>();
  open: string[] = [];
  active: string | null = null;
  /** What the last successful save contained (path → LF text), to know if there's anything new. */
  private saved = new Map<string, string>();
  private version = 0;
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    files: UploadFile[],
    readonly tag: string | null,
    private readonly nonce?: string,
  ) {
    for (const file of files) {
      const lineBreak = detectLineBreak(file.content);
      const original = toEditorText(file.content, lineBreak);
      this.entries.set(file.path, {
        file,
        lineBreak,
        original,
        text: original,
        state: null,
        problems: [],
        secretKeys: new Map(file.secrets.map((s) => [s.id, s.key])),
      });
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /** The EditorState for a file, created on first use. */
  stateFor(path: string): EditorState {
    const entry = this.require(path);
    if (!entry.state) {
      entry.state = createFileState({
        text: entry.text,
        lang: entry.file.lang,
        secretKeys: entry.secretKeys,
        validation: this.validationFor(entry),
        onChange: (state) => this.onEdit(path, state),
        nonce: this.nonce,
      });
      entry.problems = this.check(entry);
    }
    return entry.state;
  }

  /** The view keeps its own state between transactions; this stores it when switching tabs. */
  remember(path: string, state: EditorState) {
    const entry = this.entries.get(path);
    if (entry) entry.state = state;
  }

  openFile(path: string) {
    this.require(path);
    if (!this.open.includes(path)) this.open = [...this.open, path];
    this.active = path;
    this.stateFor(path);
    this.emit();
  }

  closeFile(path: string) {
    const index = this.open.indexOf(path);
    if (index < 0) return;
    this.open = this.open.filter((p) => p !== path);
    if (this.active === path) this.active = this.open[Math.min(index, this.open.length - 1)] ?? null;
    this.emit();
  }

  revert(path: string) {
    const entry = this.require(path);
    entry.text = entry.original;
    entry.state = null;
    this.stateFor(path);
    this.emit();
  }

  isChanged = (path: string) => {
    const entry = this.entries.get(path);
    return entry !== undefined && entry.text !== entry.original;
  };

  changedPaths(): string[] {
    return Array.from(this.entries.values())
      .filter((e) => e.text !== e.original)
      .map((e) => e.file.path);
  }

  /** True when there are edits the last save didn't include. */
  hasUnsaved(): boolean {
    const changed = this.changedPaths();
    if (changed.length !== this.saved.size) return true;
    return changed.some((p) => this.saved.get(p) !== this.entries.get(p)?.text);
  }

  changes(): ChangedFile[] {
    return this.changedPaths().map((path) => {
      const entry = this.require(path);
      return { path, baseSha256: entry.file.sha256, content: fromEditorText(entry.text, entry.lineBreak) };
    });
  }

  markSaved() {
    this.saved = new Map(this.changedPaths().map((p) => [p, this.require(p).text]));
    this.emit();
  }

  /** Locked secrets that are no longer in the file (their real values would be deleted). */
  removedSecrets(path: string): string[] {
    const entry = this.require(path);
    if (!this.tag || entry.secretKeys.size === 0) return [];
    return missingPlaceholders(entry.text, this.tag, entry.secretKeys.keys()).map((id) => entry.secretKeys.get(id) ?? id);
  }

  problemsFor(path: string): Problem[] {
    const entry = this.require(path);
    // Files never opened haven't been checked yet; checking on demand keeps start-up instant.
    if (!entry.state && entry.text !== entry.original) entry.problems = this.check(entry);
    return entry.problems;
  }

  stat(path: string): FileStat {
    const entry = this.require(path);
    return lineStat(entry.original, entry.text);
  }

  private onEdit(path: string, state: EditorState) {
    const entry = this.require(path);
    const wasChanged = entry.text !== entry.original;
    entry.state = state;
    entry.text = state.doc.toString();
    const timer = this.timers.get(path);
    if (timer) clearTimeout(timer);
    this.timers.set(
      path,
      setTimeout(() => {
        entry.problems = this.check(entry);
        this.emit();
      }, 300),
    );
    if (wasChanged !== (entry.text !== entry.original) || this.saved.size > 0) this.emit();
  }

  private check(entry: Entry): Problem[] {
    return validate(entry.file.lang, entry.text, this.validationFor(entry));
  }

  private validationFor(entry: Entry) {
    return {
      original: entry.original,
      placeholderTag: entry.secretKeys.size > 0 ? (this.tag ?? undefined) : undefined,
      placeholderIds: new Set(entry.secretKeys.keys()),
    };
  }

  private require(path: string): Entry {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`unknown file ${path}`);
    return entry;
  }
}

/**
 * Lines added and removed. Each distinct line becomes one character so the character diff from
 * @codemirror/merge works as a line diff.
 */
export function lineStat(before: string, after: string): FileStat {
  if (before === after) return { added: 0, removed: 0 };
  const codes = new Map<string, string>();
  const encode = (text: string) =>
    text
      .split("\n")
      .map((line) => {
        let c = codes.get(line);
        if (c === undefined) {
          c = String.fromCharCode(0xe000 + (codes.size % 0x1900));
          codes.set(line, c);
        }
        return c;
      })
      .join("");
  const a = encode(before);
  const b = encode(after);
  let added = 0;
  let removed = 0;
  for (const change of diff(a, b)) {
    removed += change.toA - change.fromA;
    added += change.toB - change.fromB;
  }
  return { added, removed };
}
