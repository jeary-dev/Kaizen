import "server-only";
import { b64uDecodeOrNull } from "@/lib/protocol/encoding";
import { StoreError } from "./store";

/** Small helpers shared by the route handlers. Request bodies are never logged. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError || error instanceof StoreError) {
    const headers = error instanceof HttpError ? error.headers : {};
    return json({ error: error.code, message: error.message }, error.status, headers);
  }
  // Log the error type and message only: never the request, its body or its headers.
  console.error("[kaizen] unexpected error:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
  return json({ error: "internal", message: "something went wrong on our side" }, 500);
}

/**
 * Reads a JSON body, refusing anything over `limit` bytes. The declared Content-Length is checked
 * first, then the actual stream, because a client can send more than it declares, or no length at all.
 */
export async function readJson(request: Request, limit: number): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "send the body as application/json");
  }
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);
  if (!request.body) throw new HttpError(400, "bad_request", "missing request body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "bad_request", "the body is not valid JSON");
  }
}

const tooLarge = (limit: number) =>
  new HttpError(413, "too_large", `the request body is larger than this server accepts (${limit} bytes)`);

/** Parses `Authorization: Bearer <base64url of 32 bytes>`. */
export function bearer(request: Request): Buffer {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  const bytes = match ? b64uDecodeOrNull(match[1]) : null;
  if (!bytes || bytes.length !== 32) throw new HttpError(401, "unauthorized", "missing or malformed bearer token");
  return Buffer.from(bytes);
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
