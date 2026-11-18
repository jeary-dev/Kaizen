import { findNodeAtLocation, type Node as JsonNode, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import { TomlError, parse as parseToml } from "smol-toml";
import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, type Node as YamlNode, parseDocument } from "yaml";
import { placeholderPattern } from "@/lib/protocol/formats";
import type { Lang } from "@/lib/protocol/payload";

/**
 * Live validation for the editor. Every function is pure and works on LF text (see text.ts), so
 * offsets are CodeMirror positions.
 *
 * - error: the file won't parse, or a locked secret was duplicated or invented. Saving asks first.
 * - warning: probably a mistake (tab indentation, duplicate keys, a value changed type).
 */

export type Severity = "error" | "warning" | "info";

export interface Problem {
  from: number;
  to: number;
  severity: Severity;
  message: string;
}

export interface ValidationContext {
  /** The file as uploaded (LF form), to spot values whose type changed. */
  original?: string;
  /** The session's placeholder tag, plus the ids that exist in this file. */
  placeholderTag?: string;
  placeholderIds?: ReadonlySet<string>;
}

export function validate(lang: Lang, text: string, ctx: ValidationContext = {}): Problem[] {
  const problems: Problem[] = [];
  switch (lang) {
    case "yaml":
      problems.push(...validateYaml(text, ctx.original));
      break;
    case "json":
      problems.push(...validateJson(text, ctx.original));
      break;
    case "toml":
      problems.push(...validateToml(text));
      break;
    case "properties":
      problems.push(...validateProperties(text));
      break;
    default:
      break;
  }
  if (ctx.placeholderTag) problems.push(...validatePlaceholders(text, ctx.placeholderTag, ctx.placeholderIds ?? new Set()));
  return problems.sort((a, b) => a.from - b.from || a.to - b.to);
}

export const hasErrors = (problems: readonly Problem[]) => problems.some((p) => p.severity === "error");

// ------------------------------------------------------------------------------------------------
// YAML. Bukkit's SnakeYAML follows YAML 1.1 (where `yes`, `on` and `off` are booleans), so values
// are typed the way the server will read them.

type ValueType = "string" | "number" | "boolean" | "null" | "map" | "list" | "date";

const YAML_OPTIONS = { version: "1.1", uniqueKeys: true, prettyErrors: false, keepSourceTokens: false } as const;

function validateYaml(text: string, original?: string): Problem[] {
  const problems: Problem[] = [];

  // Tabs are never valid YAML indentation; the parser's message for them is cryptic.
  const tabIndent = /^( *)\t/gm;
  for (let m = tabIndent.exec(text); m; m = tabIndent.exec(text)) {
    const at = m.index + m[1].length;
    problems.push({ from: at, to: at + 1, severity: "error", message: "Tab used for indentation. YAML only allows spaces here." });
  }
  const tabbed = new Set(problems.map((p) => lineStart(text, p.from)));

  const doc = parseDocument(text, { ...YAML_OPTIONS, lineCounter: new LineCounter() });
  for (const e of doc.errors) {
    const [from, to] = clampRange(text, e.pos[0], e.pos[1]);
    if (e.code === "TAB_AS_INDENT" && tabbed.has(lineStart(text, from))) continue;
    const message =
      e.code === "DUPLICATE_KEY" ? "Duplicate key. Only one of them will be used." : firstLine(e.message.replace(/ at line \d+, column \d+.*/s, ""));
    problems.push({ from, to, severity: e.code === "DUPLICATE_KEY" ? "warning" : "error", message });
  }
  for (const w of doc.warnings) {
    const [from, to] = clampRange(text, w.pos[0], w.pos[1]);
    problems.push({ from, to, severity: "warning", message: firstLine(w.message) });
  }

  if (original !== undefined && doc.errors.length === 0) {
    const before = parseDocument(original, YAML_OPTIONS);
    if (before.errors.length === 0) {
      const was = new Map<string, ValueType>();
      walkYaml(before.contents, [], (path, type) => was.set(path, type));
      walkYaml(doc.contents, [], (path, type, node) => {
        const old = was.get(path);
        if (old && old !== type && node.range) {
          const [from, to] = clampRange(text, node.range[0], node.range[1]);
          problems.push({ from, to, severity: "warning", message: typeChangeMessage(path, old, type) });
        }
      });
    }
  }
  return problems;
}

function walkYaml(node: unknown, path: string[], visit: (path: string, type: ValueType, node: YamlNode) => void) {
  if (isAlias(node) || node === null || node === undefined) return;
  if (isMap(node)) {
    visit(path.join("."), "map", node);
    for (const pair of node.items) {
      if (!isPair(pair)) continue;
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      walkYaml(pair.value, [...path, key], visit);
    }
  } else if (isSeq(node)) {
    visit(path.join("."), "list", node);
    node.items.forEach((item, i) => walkYaml(item, [...path, `[${i}]`], visit));
  } else if (isScalar(node)) {
    visit(path.join("."), scalarType(node.value), node);
  }
}

function scalarType(value: unknown): ValueType {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  return "string";
}

const ARTICLE: Record<ValueType, string> = {
  string: "text",
  number: "a number",
  boolean: "true/false",
  null: "empty",
  map: "a section",
  list: "a list",
  date: "a date",
};

function typeChangeMessage(path: string, from: ValueType, to: ValueType): string {
  const name = path === "" ? "This value" : `"${path.split(".").pop()?.replace(/^\[(\d+)]$/, "item $1")}"`;
  const hint = from === "number" && to === "string" ? " If you meant a number, remove the quotes." : "";
  return `${name} was ${ARTICLE[from]} and is now ${ARTICLE[to]}. The plugin may not expect that.${hint}`;
}

// ------------------------------------------------------------------------------------------------
// JSON (comments allowed, as many plugins write them).

function validateJson(text: string, original?: string): Problem[] {
  const problems: Problem[] = [];
  if (text.trim() === "") return problems;
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: false, allowEmptyContent: false });
  for (const e of errors) {
    const [from, to] = clampRange(text, e.offset, e.offset + Math.max(1, e.length));
    problems.push({ from, to, severity: "error", message: jsonErrorMessage(printParseErrorCode(e.error)) });
  }
  if (!tree) return problems;

  walkJson(tree, (node) => {
    if (node.type !== "object" || !node.children) return;
    const seen = new Set<string>();
    for (const prop of node.children) {
      const key = prop.children?.[0];
      if (!key || typeof key.value !== "string") continue;
      if (seen.has(key.value)) {
        problems.push({ from: key.offset, to: key.offset + key.length, severity: "warning", message: "Duplicate key. Only the last one will be used." });
      }
      seen.add(key.value);
    }
  });

  if (original !== undefined && errors.length === 0) {
    const before = parseTree(original, [], { disallowComments: false });
    if (before) {
      walkJsonValues(tree, [], (path, node) => {
        const old = findNodeAtLocation(before, path);
        if (old && old.type !== node.type) {
          const label = path.length ? String(path[path.length - 1]) : "";
          problems.push({
            from: node.offset,
            to: node.offset + node.length,
            severity: "warning",
            message: typeChangeMessage(label, jsonType(old), jsonType(node)),
          });
        }
      });
    }
  }
  return problems;
}

function walkJson(node: JsonNode, visit: (node: JsonNode) => void) {
  visit(node);
  node.children?.forEach((child) => walkJson(child, visit));
}

function walkJsonValues(node: JsonNode, path: (string | number)[], visit: (path: (string | number)[], node: JsonNode) => void) {
  if (node.type === "object") {
    for (const prop of node.children ?? []) {
      const [key, value] = prop.children ?? [];
      if (key && value && typeof key.value === "string") walkJsonValues(value, [...path, key.value], visit);
    }
  } else if (node.type === "array") {
    (node.children ?? []).forEach((child, i) => walkJsonValues(child, [...path, i], visit));
  }
  if (path.length > 0) visit(path, node);
}

const jsonType = (node: JsonNode): ValueType =>
  node.type === "object" ? "map" : node.type === "array" ? "list" : node.type === "property" ? "string" : node.type;

function jsonErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    InvalidSymbol: "Unexpected character.",
    InvalidNumberFormat: "Invalid number.",
    PropertyNameExpected: "Expected a key in double quotes.",
    ValueExpected: "Expected a value.",
    ColonExpected: "Expected a colon after the key.",
    CommaExpected: "Expected a comma.",
    CloseBraceExpected: "Missing closing }.",
    CloseBracketExpected: "Missing closing ].",
    EndOfFileExpected: "Unexpected content after the end of the JSON.",
    UnexpectedEndOfComment: "Comment is never closed.",
    UnexpectedEndOfString: "String is never closed.",
    UnexpectedEndOfNumber: "Number ends unexpectedly.",
    InvalidUnicode: "Invalid unicode escape.",
    InvalidEscapeCharacter: "Invalid escape sequence.",
    InvalidCharacter: "Invalid character in string.",
  };
  return messages[code] ?? `Invalid JSON (${code}).`;
}

// ------------------------------------------------------------------------------------------------
// TOML and properties.

function validateToml(text: string): Problem[] {
  try {
    parseToml(text);
    return [];
  } catch (e) {
    if (!(e instanceof TomlError)) return [{ from: 0, to: Math.min(1, text.length), severity: "error", message: "Invalid TOML." }];
    const at = offsetOf(text, e.line, e.column);
    const [from, to] = clampRange(text, at, at + 1);
    return [{ from, to, severity: "error", message: firstLine(e.message).replace(/^Invalid TOML document: /, "") }];
  }
}

function validateProperties(text: string): Problem[] {
  const problems: Problem[] = [];
  const seen = new Map<string, number>();
  let offset = 0;
  let continued = false;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const wasContinued = continued;
    continued = /(^|[^\\])(\\\\)*\\$/.test(line);
    if (wasContinued) continue;
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const key = /^((?:\\.|[^:=\s\\])+)/.exec(trimmed)?.[1];
    if (!key) continue;
    const from = start + (line.length - trimmed.length);
    if (seen.has(key)) {
      problems.push({ from, to: from + key.length, severity: "warning", message: `Duplicate key "${key}". Only the last one will be used.` });
    }
    seen.set(key, from);
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------
// Locked secrets. The editor stops edits inside placeholders, but text can still be pasted.

function validatePlaceholders(text: string, tag: string, ids: ReadonlySet<string>): Problem[] {
  const problems: Problem[] = [];
  const counts = new Map<string, number>();
  for (const m of text.matchAll(placeholderPattern(tag))) {
    const id = m[0];
    const from = m.index ?? 0;
    const to = from + id.length;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!ids.has(id)) {
      problems.push({ from, to, severity: "error", message: "This locked secret doesn't belong to this file. Remove it." });
    } else if ((counts.get(id) ?? 0) > 1) {
      problems.push({ from, to, severity: "error", message: "A locked secret can only appear once. Remove this copy." });
    }
  }
  return problems;
}

/** Ids from [ids] that no longer appear in [text]. Their values would be deleted on apply. */
export function missingPlaceholders(text: string, tag: string, ids: Iterable<string>): string[] {
  const present = new Set(Array.from(text.matchAll(placeholderPattern(tag)), (m) => m[0]));
  return Array.from(ids).filter((id) => !present.has(id));
}

// ------------------------------------------------------------------------------------------------

const firstLine = (s: string) => s.split("\n")[0].trim();

function clampRange(text: string, from: number, to: number): [number, number] {
  const f = Math.max(0, Math.min(from, text.length));
  const t = Math.max(f, Math.min(to, text.length));
  // Zero-width ranges at the end of a line are hard to see; widen them by one character if we can.
  return t === f && f < text.length ? [f, f + 1] : [f, t];
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(text.length, offset + Math.max(0, column - 1));
}
