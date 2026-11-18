import { type Bytes, isSha256Hex, utf8Decode, utf8Encode } from "./encoding";
import { fail } from "./errors";
import { isValidPath, PLACEHOLDER_ID } from "./formats";

/** Upload (§5) and changes (§6) payloads, mirroring the Kotlin models. */

export const LANGS = ["yaml", "json", "properties", "toml", "conf", "text"] as const;
export type Lang = (typeof LANGS)[number];

export interface SecretRef {
  id: string;
  key: string;
  line: number;
}

export interface UploadFile {
  path: string;
  plugin: string | null;
  lang: Lang;
  sha256: string;
  content: string;
  secrets: SecretRef[];
}

export interface UploadPayload {
  format: "kaizen.upload";
  v: 1;
  sid: string;
  createdAt: string;
  expiresAt: string;
  server: { software: string; kaizen: string };
  scope: string;
  files: UploadFile[];
  reloadHints: Record<string, string>;
}

export interface ChangedFile {
  path: string;
  baseSha256: string;
  content: string;
}

export interface ChangesPayload {
  format: "kaizen.changes";
  v: 1;
  sid: string;
  uploadSha256: string;
  createdAt: string;
  files: ChangedFile[];
}

// ------------------------------------------------------------------------------------------------
// Tiny strict readers. Unknown fields are ignored (forward compatibility within v1).

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, at: string): Obj => (isObj(v) ? v : fail("malformed", `${at} must be an object`));
const str = (o: Obj, k: string, at: string): string =>
  typeof o[k] === "string" ? (o[k] as string) : fail("malformed", `${at}.${k} must be a string`);
const optStr = (o: Obj, k: string, at: string): string | null =>
  o[k] === undefined || o[k] === null ? null : str(o, k, at);
const int = (o: Obj, k: string, at: string): number =>
  Number.isSafeInteger(o[k]) ? (o[k] as number) : fail("malformed", `${at}.${k} must be an integer`);
const arr = (o: Obj, k: string, at: string): unknown[] =>
  Array.isArray(o[k]) ? (o[k] as unknown[]) : fail("malformed", `${at}.${k} must be an array`);
const sha = (o: Obj, k: string, at: string): string => {
  const v = str(o, k, at);
  return isSha256Hex(v) ? v : fail("malformed", `${at}.${k} is not a lowercase SHA-256 hex digest`);
};
// Same acceptance as java.time.Instant.parse: an ISO-8601 instant in UTC.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const instant = (o: Obj, k: string, at: string): string => {
  const v = str(o, k, at);
  return INSTANT.test(v) && !Number.isNaN(Date.parse(v)) ? v : fail("malformed", `${at}.${k} is not an ISO-8601 instant`);
};

function header(bytes: Bytes, format: string): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) return fail("malformed", "payload is not valid JSON", error);
    throw error;
  }
  const o = obj(parsed, "payload");
  if (o.format !== format) fail("unsupported", `expected a ${format} payload`);
  if (o.v !== 1) fail("unsupported", `payload version ${String(o.v)} is not supported`);
  return o;
}

function uniquePaths(paths: string[]) {
  for (const p of paths) if (!isValidPath(p)) fail("path", "invalid path in payload");
  if (new Set(paths).size !== paths.length) fail("path", "a path appears more than once");
}

export function decodeUpload(bytes: Bytes, expectedSid: string): UploadPayload {
  const o = header(bytes, "kaizen.upload");
  const sid = str(o, "sid", "payload");
  const server = obj(o.server, "payload.server");
  const files = arr(o, "files", "payload").map((f, i): UploadFile => {
    const at = `payload.files[${i}]`;
    const fo = obj(f, at);
    const lang = str(fo, "lang", at);
    if (!(LANGS as readonly string[]).includes(lang)) fail("malformed", `${at}.lang is unknown`);
    const secrets = (fo.secrets === undefined ? [] : arr(fo, "secrets", at)).map((s, j): SecretRef => {
      const so = obj(s, `${at}.secrets[${j}]`);
      const id = str(so, "id", at);
      if (!PLACEHOLDER_ID.test(id)) fail("malformed", "invalid placeholder id");
      return { id, key: str(so, "key", at), line: int(so, "line", at) };
    });
    return {
      path: str(fo, "path", at),
      plugin: optStr(fo, "plugin", at),
      lang: lang as Lang,
      sha256: sha(fo, "sha256", at),
      content: str(fo, "content", at),
      secrets,
    };
  });
  const hints = o.reloadHints === undefined ? {} : obj(o.reloadHints, "payload.reloadHints");
  const reloadHints: Record<string, string> = {};
  for (const [k, v] of Object.entries(hints)) {
    if (typeof v !== "string") fail("malformed", "payload.reloadHints values must be strings");
    reloadHints[k] = v as string;
  }
  const payload: UploadPayload = {
    format: "kaizen.upload",
    v: 1,
    sid,
    createdAt: instant(o, "createdAt", "payload"),
    expiresAt: instant(o, "expiresAt", "payload"),
    server: { software: str(server, "software", "payload.server"), kaizen: str(server, "kaizen", "payload.server") },
    scope: str(o, "scope", "payload"),
    files,
    reloadHints,
  };
  if (sid !== expectedSid) fail("mismatch", "upload belongs to a different session");
  uniquePaths(files.map((f) => f.path));
  return payload;
}

export function decodeChanges(bytes: Bytes, expectedSid: string): ChangesPayload {
  const o = header(bytes, "kaizen.changes");
  const sid = str(o, "sid", "payload");
  const files = arr(o, "files", "payload").map((f, i): ChangedFile => {
    const at = `payload.files[${i}]`;
    const fo = obj(f, at);
    return { path: str(fo, "path", at), baseSha256: sha(fo, "baseSha256", at), content: str(fo, "content", at) };
  });
  const payload: ChangesPayload = {
    format: "kaizen.changes",
    v: 1,
    sid,
    uploadSha256: sha(o, "uploadSha256", "payload"),
    createdAt: instant(o, "createdAt", "payload"),
    files,
  };
  if (sid !== expectedSid) fail("mismatch", "changes belong to a different session");
  if (files.length === 0) fail("malformed", "the change set is empty");
  uniquePaths(files.map((f) => f.path));
  return payload;
}

export const encodePayload = (payload: UploadPayload | ChangesPayload): Bytes => utf8Encode(JSON.stringify(payload));
