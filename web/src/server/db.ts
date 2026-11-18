import "server-only";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";

/**
 * SQLite storage. The schema holds ciphertext envelopes and the minimum metadata needed to route
 * them: no IPs, no user agents, no plaintext, no keys. Tokens are stored only as SHA-256 hashes.
 */

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    sid         TEXT PRIMARY KEY,
    upload      TEXT,                -- envelope JSON (ciphertext); NULL once applied or discarded
    owner_hash  TEXT NOT NULL,       -- hex(SHA-256(HMAC(T, sid)))
    edit_hash   TEXT NOT NULL,       -- hex(SHA-256(editToken))
    status      TEXT NOT NULL CHECK (status IN ('open', 'applied', 'discarded')),
    latest_rev  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,    -- unix ms
    expires_at  INTEGER NOT NULL     -- unix ms; the sweep deletes the row after this
  ) STRICT;

  CREATE TABLE changes (
    sid         TEXT NOT NULL REFERENCES sessions(sid) ON DELETE CASCADE,
    rev         INTEGER NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    envelope    TEXT,                -- NULL once claimed: the server keeps nothing it no longer needs
    created_at  INTEGER NOT NULL,
    claimed_at  INTEGER,
    PRIMARY KEY (sid, rev)
  ) STRICT;

  CREATE INDEX sessions_expiry ON sessions(expires_at);
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // Deleted ciphertext is overwritten with zeros instead of lingering in free pages.
  db.pragma("secure_delete = ON");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// One connection per process. better-sqlite3 is synchronous, and that suits a single Node process.
const globalForDb = globalThis as unknown as { kaizenDb?: Db };

export function db(): Db {
  globalForDb.kaizenDb ??= openDb(config().dbPath);
  return globalForDb.kaizenDb;
}

/** Tests only: swap in a fresh database. */
export function setDbForTests(instance: Db) {
  globalForDb.kaizenDb = instance;
}
