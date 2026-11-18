import { deriveSessionKeys, type SessionKeys, sha256Hex } from "@/lib/protocol/crypto";
import { b64uDecodeOrNull } from "@/lib/protocol/encoding";
import { envelopeToJson, open, parseEnvelope, seal } from "@/lib/protocol/envelope";
import { ProtocolError } from "@/lib/protocol/errors";
import { placeholderTag } from "@/lib/protocol/formats";
import { type ChangedFile, type ChangesPayload, decodeUpload, encodePayload, type UploadPayload } from "@/lib/protocol/payload";

/**
 * Where the editor's data comes from. The real editor talks to the API with keys from the URL
 * fragment; the demo uses an in-memory implementation of the same interface.
 */
export interface SessionSource {
  load(): Promise<LoadedSession>;
  /** Encrypts and stores a change set. `rev` must be higher than any earlier save. */
  save(files: ChangedFile[], rev: number): Promise<SavedChanges>;
  discard(): Promise<void>;
}

export interface LoadedSession {
  sid: string;
  upload: UploadPayload;
  /** hex SHA-256 of the decrypted upload, echoed back in every change set. */
  uploadSha256: string;
  expiresAt: Date;
  latestRev: number;
  pending: { rev: number; code: string } | null;
  /** The placeholder tag used in this session, if any file has secrets. */
  tag: string | null;
}

export interface SavedChanges {
  code: string;
  rev: number;
}

export type SessionErrorKind = "link" | "gone" | "applied" | "decrypt" | "rate" | "conflict" | "too-large" | "network";

export class SessionError extends Error {
  constructor(
    readonly kind: SessionErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Reads `#k=<key>` from a URL fragment. Returns null if missing or malformed. */
export function keyFromFragment(hash: string): Uint8Array<ArrayBuffer> | null {
  const k = new URLSearchParams(hash.replace(/^#/, "")).get("k");
  const key = k ? b64uDecodeOrNull(k) : null;
  return key && key.length === 32 ? key : null;
}

export const SID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function tagOf(upload: UploadPayload): string | null {
  for (const file of upload.files) for (const s of file.secrets) return placeholderTag(s.id);
  return null;
}

export class RemoteSession implements SessionSource {
  private keys: Promise<SessionKeys>;
  private uploadSha256 = "";

  constructor(
    private readonly sid: string,
    key: Uint8Array<ArrayBuffer>,
    private readonly base = "",
  ) {
    this.keys = deriveSessionKeys(key, sid);
  }

  async load(): Promise<LoadedSession> {
    const keys = await this.keys;
    const res = await this.request(`/api/v1/sessions/${this.sid}`, { headers: { Authorization: `Bearer ${keys.editToken}` } });
    const body = (await res.json()) as {
      status: "open" | "applied" | "discarded";
      expiresAt: string;
      latestRev: number;
      pending: { rev: number; code: string } | null;
      envelope: unknown;
    };
    if (body.status === "applied") throw new SessionError("applied", "These changes were already applied on the server.");
    if (body.status !== "open" || !body.envelope) throw new SessionError("gone", "This editor session was closed.");

    let upload: UploadPayload;
    try {
      const plaintext = await open({ key: keys.up, expectedSid: this.sid, expectedKind: "upload", envelope: parseEnvelope(body.envelope) });
      upload = decodeUpload(plaintext, this.sid);
      this.uploadSha256 = await sha256Hex(plaintext);
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw new SessionError("decrypt", "This link's key doesn't open the session. Copy the whole link, including everything after #.");
      }
      throw error;
    }
    return {
      sid: this.sid,
      upload,
      uploadSha256: this.uploadSha256,
      expiresAt: new Date(body.expiresAt),
      latestRev: body.latestRev,
      pending: body.pending,
      tag: tagOf(upload),
    };
  }

  async save(files: ChangedFile[], rev: number): Promise<SavedChanges> {
    const keys = await this.keys;
    const payload: ChangesPayload = {
      format: "kaizen.changes",
      v: 1,
      sid: this.sid,
      uploadSha256: this.uploadSha256,
      createdAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      files,
    };
    const envelope = await seal({ key: keys.down, kind: "changes", sid: this.sid, rev, plaintext: encodePayload(payload) });
    const res = await this.request(`/api/v1/sessions/${this.sid}/changes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.editToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: envelopeToJson(envelope) }),
    });
    return (await res.json()) as SavedChanges;
  }

  async discard(): Promise<void> {
    const keys = await this.keys;
    await this.request(`/api/v1/sessions/${this.sid}`, { method: "DELETE", headers: { Authorization: `Bearer ${keys.editToken}` } });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.base + path, { ...init, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    } catch {
      throw new SessionError("network", "Couldn't reach the Kaizen server. Check your connection and try again.");
    }
    if (res.ok) return res;
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    switch (res.status) {
      case 404:
      case 410:
        throw new SessionError("gone", "This editor session has expired or doesn't exist. Run /kaizen editor again for a new link.");
      case 409:
        throw new SessionError("conflict", "A newer save exists for this session, probably from another tab. Reload to continue from it.");
      case 413:
        throw new SessionError("too-large", "These changes are too large to save in one go.");
      case 429:
        throw new SessionError("rate", body.message ? `Slow down: ${body.message}.` : "Too many requests. Try again in a moment.");
      default:
        throw new SessionError("network", body.message ? `The server said: ${body.message}.` : `Unexpected response (${res.status}).`);
    }
  }
}
