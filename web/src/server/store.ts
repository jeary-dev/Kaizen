import "server-only";
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { APPLY_CODE_ALPHABET, APPLY_CODE_LENGTH } from "@/lib/protocol/formats";
import type { Db } from "./db";

/**
 * Session storage and the rules around it. Every function takes `now`, so expiry is testable
 * without real clocks.
 */

export type SessionStatus = "open" | "applied" | "discarded";

export interface SessionRow {
  sid: string;
  upload: string | null;
  owner_hash: string;
  edit_hash: string;
  status: SessionStatus;
  latest_rev: number;
  created_at: number;
  expires_at: number;
}

export class StoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Constant-time comparison of two hex digests. */
export function hexEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export const editHashOf = (editToken: Buffer): string => sha256Hex(editToken);

export const ownerHashOf = (ownerSecret: Buffer, sid: string): string =>
  sha256Hex(createHmac("sha256", ownerSecret).update(sid, "utf8").digest());

export function generateApplyCode(): string {
  let code = "";
  for (let i = 0; i < APPLY_CODE_LENGTH; i++) code += APPLY_CODE_ALPHABET[randomInt(APPLY_CODE_ALPHABET.length)];
  return code;
}

// ------------------------------------------------------------------------------------------------

export interface CreateSession {
  sid: string;
  upload: string;
  ownerHash: string;
  editHash: string;
  expiresAt: number;
}

export function createSession(db: Db, s: CreateSession, now: number) {
  try {
    db.prepare(
      `INSERT INTO sessions (sid, upload, owner_hash, edit_hash, status, latest_rev, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'open', 0, ?, ?)`,
    ).run(s.sid, s.upload, s.ownerHash, s.editHash, now, s.expiresAt);
  } catch (error) {
    if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      throw new StoreError(409, "conflict", "a session with this id already exists");
    }
    throw error;
  }
}

/** Returns the session if it exists and has not expired. Expired rows are treated as gone. */
export function liveSession(db: Db, sid: string, now: number): SessionRow | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE sid = ?`).get(sid) as SessionRow | undefined;
  return row && row.expires_at > now ? row : null;
}

/** Looks up a live session and checks the edit token hash. 404 for both cases, so ids can't be probed. */
export function sessionForEditor(db: Db, sid: string, editToken: Buffer, now: number): SessionRow {
  const row = liveSession(db, sid, now);
  if (!row || !hexEquals(row.edit_hash, editHashOf(editToken))) {
    throw new StoreError(404, "not_found", "this editor session does not exist or has expired");
  }
  return row;
}

export interface SavedChanges {
  code: string;
  rev: number;
  expiresAt: number;
}

/**
 * Stores a new change set. It must carry a higher `rev` than any earlier save. Earlier unclaimed
 * change sets for the session are deleted, so their codes stop working.
 */
export function saveChanges(db: Db, session: SessionRow, rev: number, envelope: string, now: number): SavedChanges {
  if (session.status !== "open") {
    throw new StoreError(409, session.status === "applied" ? "applied" : "closed", `this session is ${session.status}`);
  }
  if (rev <= session.latest_rev) throw new StoreError(409, "stale_rev", "a newer save already exists for this session");

  return db.transaction(() => {
    db.prepare(`DELETE FROM changes WHERE sid = ?`).run(session.sid);
    for (let attempt = 0; ; attempt++) {
      const code = generateApplyCode();
      try {
        db.prepare(`INSERT INTO changes (sid, rev, code, envelope, created_at) VALUES (?, ?, ?, ?, ?)`).run(
          session.sid,
          rev,
          code,
          envelope,
          now,
        );
        db.prepare(`UPDATE sessions SET latest_rev = ? WHERE sid = ?`).run(rev, session.sid);
        return { code, rev, expiresAt: session.expires_at };
      } catch (error) {
        // ~1 in 10^12 per attempt; retry a few times on a code collision.
        if ((error as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE" || attempt >= 4) throw error;
      }
    }
  })();
}

export interface Claimed {
  sid: string;
  envelope: string;
}

/**
 * Claims a change set by its apply code. This works once, only before expiry, and only for the
 * owner secret that created the session. Every failure looks the same from outside (404), so the
 * endpoint can't be used to learn which codes exist.
 */
export function claim(db: Db, code: string, ownerSecret: Buffer, now: number): Claimed {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT c.sid, c.envelope, c.claimed_at, s.owner_hash, s.status, s.expires_at
           FROM changes c JOIN sessions s ON s.sid = c.sid
          WHERE c.code = ?`,
      )
      .get(code) as
      | { sid: string; envelope: string | null; claimed_at: number | null; owner_hash: string; status: SessionStatus; expires_at: number }
      | undefined;

    const owned = row !== undefined && hexEquals(row.owner_hash, ownerHashOf(ownerSecret, row.sid));
    if (!row || !owned || row.expires_at <= now) {
      throw new StoreError(404, "not_found", "no pending changes for this code (wrong code, wrong server, or expired)");
    }
    if (row.claimed_at !== null || row.envelope === null) {
      throw new StoreError(410, "used", "this apply code has already been used; save again in the editor for a new one");
    }
    if (row.status !== "open") throw new StoreError(409, row.status, `this session is ${row.status}`);

    db.prepare(`UPDATE changes SET claimed_at = ?, envelope = NULL WHERE code = ?`).run(now, code);
    return { sid: row.sid, envelope: row.envelope };
  })();
}

/** The plugin reports a successful apply: drop every ciphertext, keep only the status until expiry. */
export function markApplied(db: Db, sid: string, ownerSecret: Buffer, now: number) {
  const row = liveSession(db, sid, now);
  if (!row || !hexEquals(row.owner_hash, ownerHashOf(ownerSecret, sid))) {
    throw new StoreError(404, "not_found", "session not found");
  }
  db.transaction(() => {
    db.prepare(`UPDATE sessions SET status = 'applied', upload = NULL WHERE sid = ?`).run(sid);
    db.prepare(`DELETE FROM changes WHERE sid = ?`).run(sid);
  })();
}

/** Either side can end a session early. All ciphertext is deleted immediately. */
export function discard(db: Db, row: SessionRow) {
  db.transaction(() => {
    db.prepare(`UPDATE sessions SET status = 'discarded', upload = NULL WHERE sid = ?`).run(row.sid);
    db.prepare(`DELETE FROM changes WHERE sid = ?`).run(row.sid);
  })();
}

export function ownerMatches(row: SessionRow, ownerSecret: Buffer): boolean {
  return hexEquals(row.owner_hash, ownerHashOf(ownerSecret, row.sid));
}

/** Deletes every expired session, and with it (cascade) every change set. Returns the count. */
export function sweep(db: Db, now: number): number {
  return db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now).changes;
}

export function changesFor(db: Db, sid: string) {
  return db.prepare(`SELECT rev, code, claimed_at FROM changes WHERE sid = ? ORDER BY rev DESC LIMIT 1`).get(sid) as
    | { rev: number; code: string; claimed_at: number | null }
    | undefined;
}
