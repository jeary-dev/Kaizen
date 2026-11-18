import { type Bytes, b64uDecode, b64uEncode, concat, utf8Decode, utf8Encode } from "./encoding";
import { fail, ProtocolError } from "./errors";
import { randomBytes } from "./crypto";

/** Envelope (protocol §4), the only thing the web server ever stores. */

export type Kind = "upload" | "changes";

export interface EnvelopeJson {
  v: 1;
  alg: "A256GCM";
  kind: Kind;
  sid: string;
  rev: number;
  iv: string;
  ct: string;
}

export interface Envelope {
  kind: Kind;
  sid: string;
  rev: number;
  iv: Bytes;
  ct: Bytes;
}

export const ENVELOPE_VERSION = 1;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const DEFAULT_MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Strict structural validation, mirroring the Kotlin implementation exactly. */
export function parseEnvelope(value: unknown): Envelope {
  if (!isObject(value)) return fail("malformed", "envelope must be a JSON object");

  const str = (name: string): string => {
    const v = value[name];
    return typeof v === "string" ? v : fail("malformed", `envelope.${name} must be a string`);
  };
  const int = (name: string): number => {
    const v = value[name];
    return typeof v === "number" && Number.isSafeInteger(v) ? v : fail("malformed", `envelope.${name} must be an integer`);
  };

  const v = int("v");
  if (v !== ENVELOPE_VERSION) fail("unsupported", `envelope version ${v} is not supported (expected ${ENVELOPE_VERSION})`);
  const alg = str("alg");
  if (alg !== "A256GCM") fail("unsupported", `algorithm ${alg} is not supported`);

  const kindText = str("kind");
  if (kindText !== "upload" && kindText !== "changes") fail("malformed", "envelope.kind is unknown");
  const kind = kindText as Kind;
  const sid = str("sid");
  const rev = int("rev");
  if (kind === "upload" && rev !== 0) fail("malformed", "an upload must have rev 0");
  if (kind === "changes" && rev < 1) fail("malformed", "changes must have rev >= 1");

  const iv = b64uDecode(str("iv"), "envelope.iv");
  if (iv.length !== IV_BYTES) fail("malformed", `envelope.iv must be ${IV_BYTES} bytes`);
  const ct = b64uDecode(str("ct"), "envelope.ct");
  if (ct.length < TAG_BYTES) fail("malformed", "envelope.ct is shorter than the GCM tag");
  return { kind, sid, rev, iv, ct };
}

export function envelopeToJson(e: Envelope): EnvelopeJson {
  return { v: 1, alg: "A256GCM", kind: e.kind, sid: e.sid, rev: e.rev, iv: b64uEncode(e.iv), ct: b64uEncode(e.ct) };
}

export const aad = (kind: Kind, sid: string, rev: number): Bytes => utf8Encode(`kaizen/v1|${kind}|${sid}|${rev}`);

export interface SealOptions {
  key: CryptoKey;
  kind: Kind;
  sid: string;
  rev: number;
  plaintext: Bytes;
  /** Test-only: fix the IV and compressed bytes to reproduce the vectors. */
  iv?: Bytes;
  precompressed?: Bytes;
}

export async function seal(o: SealOptions): Promise<Envelope> {
  const iv = o.iv ?? randomBytes(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new Error(`IV must be ${IV_BYTES} bytes`);
  const compressed = o.precompressed ?? (await gzip(o.plaintext));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(o.kind, o.sid, o.rev), tagLength: TAG_BYTES * 8 },
    o.key,
    compressed,
  );
  return { kind: o.kind, sid: o.sid, rev: o.rev, iv, ct: new Uint8Array(ct) };
}

export interface OpenOptions {
  key: CryptoKey;
  expectedSid: string;
  expectedKind: Kind;
  envelope: Envelope;
  maxPlaintextBytes?: number;
}

/**
 * Opens an envelope. The AAD is built from what we **expect**, never from the envelope's labels.
 * Nothing is decompressed until the GCM tag has verified.
 */
export async function open(o: OpenOptions): Promise<Bytes> {
  const { envelope } = o;
  if (envelope.sid !== o.expectedSid) fail("mismatch", "envelope belongs to a different session");
  if (envelope.kind !== o.expectedKind) fail("mismatch", `expected ${o.expectedKind} but received ${envelope.kind}`);
  let compressed: Bytes;
  try {
    compressed = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: envelope.iv, additionalData: aad(o.expectedKind, o.expectedSid, envelope.rev), tagLength: TAG_BYTES * 8 },
        o.key,
        envelope.ct,
      ),
    );
  } catch (error) {
    return fail("auth", "authentication failed: the data was altered or the key is wrong", error);
  }
  return gunzip(compressed, o.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES);
}

export async function gzip(bytes: Bytes): Promise<Bytes> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Gunzips, cancelling as soon as the output passes `limit`, so a small bomb can't exhaust memory. */
export async function gunzip(bytes: Bytes, limit: number): Promise<Bytes> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        fail("oversize", `decompressed payload is larger than ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    return fail("malformed", "payload is not valid gzip", error);
  }
  const out = concat(chunks);
  utf8Decode(out); // callers always get well-formed UTF-8
  return out;
}
