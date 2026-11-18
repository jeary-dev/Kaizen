import { type Bytes, b64uEncode, concat, hexEncode, utf8Encode } from "./encoding";

/**
 * Key schedule (protocol §3) on WebCrypto. The same code runs in the browser and, for tests, in
 * Node's `globalThis.crypto`, so the browser path is what the test suite exercises.
 */

const subtle = () => globalThis.crypto.subtle;

export const KEY_BYTES = 32;

export interface SessionKeys {
  sid: string;
  /** AES-GCM key for plugin -> browser (decrypt the upload). */
  up: CryptoKey;
  /** AES-GCM key for browser -> plugin (encrypt changes). */
  down: CryptoKey;
  /** Bearer token for the web API; proves the caller holds the link. */
  editToken: string;
  editHash: string;
}

export async function hkdf(ikm: Bytes, salt: Bytes, info: string, length = KEY_BYTES): Promise<Bytes> {
  const base = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8Encode(info) }, base, length * 8);
  return new Uint8Array(bits);
}

export async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", bytes));
}

export const sha256Hex = async (bytes: Bytes): Promise<string> => hexEncode(await sha256(bytes));

export async function hmacSha256(key: Bytes, message: Bytes): Promise<Bytes> {
  const k = await subtle().importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, message));
}

/** Raw subkeys, exposed for the test vectors. Application code uses {@link deriveSessionKeys}. */
export async function deriveRawKeys(key: Bytes, sid: string) {
  if (key.length !== KEY_BYTES) throw new Error("session key must be 32 bytes");
  const salt = utf8Encode(sid);
  const [up, down, editToken] = await Promise.all([
    hkdf(key, salt, "kaizen/v1/up"),
    hkdf(key, salt, "kaizen/v1/down"),
    hkdf(key, salt, "kaizen/v1/edit-auth"),
  ]);
  return { up, down, editToken };
}

export async function deriveSessionKeys(key: Bytes, sid: string): Promise<SessionKeys> {
  const raw = await deriveRawKeys(key, sid);
  // Non-extractable: once imported, script on the page can use these keys but never read them.
  const importAes = (bytes: Bytes, usage: KeyUsage) =>
    subtle().importKey("raw", bytes, { name: "AES-GCM", length: 256 }, false, [usage]);
  const [up, down, editHash] = await Promise.all([
    importAes(raw.up, "decrypt"),
    importAes(raw.down, "encrypt"),
    sha256Hex(raw.editToken),
  ]);
  const editToken = b64uEncode(raw.editToken);
  raw.up.fill(0);
  raw.down.fill(0);
  raw.editToken.fill(0);
  return { sid, up, down, editToken, editHash };
}

/** `hex(SHA-256(HMAC-SHA256(T, sid)))` (protocol §2). The web server uses this to verify claims. */
export async function ownerHash(ownerSecret: Bytes, sid: string): Promise<string> {
  return sha256Hex(await hmacSha256(ownerSecret, utf8Encode(sid)));
}

export function randomBytes(count: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(count)));
}

export { concat };
