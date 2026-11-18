import "server-only";
import { isSha256Hex } from "@/lib/protocol/encoding";
import { envelopeToJson, parseEnvelope, type Envelope, type Kind } from "@/lib/protocol/envelope";
import { ProtocolError } from "@/lib/protocol/errors";
import { normalizeApplyCode } from "@/lib/protocol/formats";
import { clientIp } from "./client-ip";
import { type Config, config } from "./config";
import { type Db, db } from "./db";
import { bearer, errorResponse, HttpError, isObject, json, readJson } from "./http";
import { limiter, type RateLimiter, type RouteClass } from "./rate-limit";
import * as store from "./store";

/**
 * The web API (`/api/v1`). Each handler is a plain function over injectable dependencies, so the
 * tests drive the real logic without starting a server. The route files only wire them up.
 */

export interface Deps {
  db: Db;
  config: Config;
  limiter: RateLimiter;
  now: () => number;
}

export const defaultDeps = (): Deps => ({ db: db(), config: config(), limiter: limiter(), now: Date.now });

const SID = /^[A-Za-z0-9_-]{22}$/;

type Handler = (request: Request, deps: Deps, ip: string) => Promise<Response> | Response;

/** Rate limiting and error mapping around a handler. */
export async function run(route: RouteClass, request: Request, deps: Deps, handler: Handler): Promise<Response> {
  const ip = clientIp(request.headers, deps.config.clientIpHeader);
  const wait = deps.limiter.take(route, ip, deps.now());
  if (wait > 0) {
    return json({ error: "rate_limited", message: `too many requests; try again in ${wait}s` }, 429, {
      "Retry-After": String(wait),
    });
  }
  try {
    return await handler(request, deps, ip);
  } catch (error) {
    return errorResponse(error);
  }
}

function envelopeFrom(value: unknown, kind: Kind, sid?: string): Envelope {
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(value);
  } catch (error) {
    if (error instanceof ProtocolError) throw new HttpError(400, `envelope_${error.reason}`, error.message);
    throw error;
  }
  if (envelope.kind !== kind) throw new HttpError(400, "envelope_kind", `expected a ${kind} envelope`);
  if (!SID.test(envelope.sid)) throw new HttpError(400, "bad_sid", "invalid session id");
  if (sid !== undefined && envelope.sid !== sid) throw new HttpError(400, "bad_sid", "envelope is for a different session");
  return envelope;
}

/** Envelopes are stored re-serialized from the parsed form, so extra fields never reach the database. */
const canonical = (e: Envelope) => JSON.stringify(envelopeToJson(e));

const iso = (ms: number) => new Date(ms).toISOString();

// ------------------------------------------------------------------------------------------------
// GET /api/v1/info

export function info(_request: Request, deps: Deps): Response {
  const c = deps.config;
  return json({
    name: "kaizen",
    protocols: [1],
    publicUrl: c.publicUrl,
    ttl: { min: c.minTtlSeconds, default: c.defaultTtlSeconds, max: c.maxTtlSeconds },
    limits: { uploadBytes: c.maxUploadBytes, changesBytes: c.maxChangesBytes },
  });
}

// GET /api/v1/health

export function health(_request: Request, deps: Deps): Response {
  deps.db.prepare("SELECT 1").get();
  return json({ ok: true });
}

// ------------------------------------------------------------------------------------------------
// POST /api/v1/sessions  (plugin)

export async function createSession(request: Request, deps: Deps): Promise<Response> {
  const body = await readJson(request, deps.config.maxUploadBytes);
  if (!isObject(body)) throw new HttpError(400, "bad_request", "expected a JSON object");
  const envelope = envelopeFrom(body.envelope, "upload");
  const { ownerHash, editHash, ttlSeconds } = body;
  if (!isSha256Hex(ownerHash) || !isSha256Hex(editHash)) {
    throw new HttpError(400, "bad_request", "ownerHash and editHash must be SHA-256 hex digests");
  }
  if (ttlSeconds !== undefined && !Number.isSafeInteger(ttlSeconds)) {
    throw new HttpError(400, "bad_request", "ttlSeconds must be an integer");
  }
  const c = deps.config;
  const ttl = Math.min(c.maxTtlSeconds, Math.max(c.minTtlSeconds, (ttlSeconds as number | undefined) ?? c.defaultTtlSeconds));
  const now = deps.now();
  const expiresAt = now + ttl * 1000;
  store.createSession(deps.db, { sid: envelope.sid, upload: canonical(envelope), ownerHash, editHash, expiresAt }, now);
  return json(
    { sid: envelope.sid, expiresAt: iso(expiresAt), ttlSeconds: ttl, editorUrl: `${c.publicUrl}/e/${envelope.sid}` },
    201,
  );
}

// GET /api/v1/sessions/{sid}  (browser, edit token)

export function getSession(request: Request, deps: Deps, sid: string): Response {
  if (!SID.test(sid)) throw new HttpError(404, "not_found", "this editor session does not exist or has expired");
  const row = store.sessionForEditor(deps.db, sid, bearer(request), deps.now());
  const latest = store.changesFor(deps.db, sid);
  return json({
    sid,
    status: row.status,
    expiresAt: iso(row.expires_at),
    latestRev: row.latest_rev,
    pending: latest && latest.claimed_at === null ? { rev: latest.rev, code: latest.code } : null,
    envelope: row.status === "open" && row.upload ? JSON.parse(row.upload) : null,
  });
}

// POST /api/v1/sessions/{sid}/changes  (browser, edit token)

export async function saveChanges(request: Request, deps: Deps, sid: string): Promise<Response> {
  if (!SID.test(sid)) throw new HttpError(404, "not_found", "this editor session does not exist or has expired");
  const row = store.sessionForEditor(deps.db, sid, bearer(request), deps.now());
  const body = await readJson(request, deps.config.maxChangesBytes);
  if (!isObject(body)) throw new HttpError(400, "bad_request", "expected a JSON object");
  const envelope = envelopeFrom(body.envelope, "changes", sid);
  const saved = store.saveChanges(deps.db, row, envelope.rev, canonical(envelope), deps.now());
  return json({ code: saved.code, rev: saved.rev, expiresAt: iso(saved.expiresAt) }, 201);
}

// DELETE /api/v1/sessions/{sid}  (browser edit token, or plugin owner secret)

export function discardSession(request: Request, deps: Deps, sid: string): Response {
  const token = bearer(request);
  const row = SID.test(sid) ? store.liveSession(deps.db, sid, deps.now()) : null;
  const allowed = row !== null && (store.hexEquals(row.edit_hash, store.editHashOf(token)) || store.ownerMatches(row, token));
  if (!row || !allowed) throw new HttpError(404, "not_found", "session not found");
  store.discard(deps.db, row);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// POST /api/v1/claim  (plugin, owner secret)

export async function claim(request: Request, deps: Deps, ip: string): Promise<Response> {
  const secret = bearer(request);
  const body = await readJson(request, 4096);
  const code = isObject(body) && typeof body.code === "string" ? normalizeApplyCode(body.code) : null;
  if (!code) throw new HttpError(400, "bad_code", "that is not a valid apply code (8 letters and digits)");
  try {
    const claimed = store.claim(deps.db, code, secret, deps.now());
    return json({ sid: claimed.sid, envelope: JSON.parse(claimed.envelope) });
  } catch (error) {
    // Failed claims cost extra, which makes guessing codes even slower than the rate limit alone.
    if (error instanceof store.StoreError && error.status === 404) deps.limiter.penalize("claim", ip, deps.now(), 2);
    throw error;
  }
}

// POST /api/v1/sessions/{sid}/applied  (plugin, owner secret)

export function applied(request: Request, deps: Deps, sid: string): Response {
  if (!SID.test(sid)) throw new HttpError(404, "not_found", "session not found");
  store.markApplied(deps.db, sid, bearer(request), deps.now());
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
