import "server-only";

/**
 * Server configuration from environment variables. Everything has a safe default, so a bare
 * `node server.js` works for local testing. See docs/deploy.md for the production values.
 */

const int = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
};

export type ClientIpSource = "cf-connecting-ip" | "x-real-ip" | "x-forwarded-for" | "none";

const ipSource = (): ClientIpSource => {
  const raw = (process.env.KAIZEN_CLIENT_IP_HEADER ?? "cf-connecting-ip").toLowerCase();
  if (raw === "cf-connecting-ip" || raw === "x-real-ip" || raw === "x-forwarded-for" || raw === "none") return raw;
  throw new Error(`KAIZEN_CLIENT_IP_HEADER must be cf-connecting-ip, x-real-ip, x-forwarded-for or none (got "${raw}")`);
};

const MiB = 1024 * 1024;

export interface Config {
  dbPath: string;
  publicUrl: string;
  /** Hard ceiling for any session's lifetime. Plugins asking for more are clamped. */
  maxTtlSeconds: number;
  defaultTtlSeconds: number;
  minTtlSeconds: number;
  /** Maximum size of a request body (the envelope JSON) for uploads and for saved changes. */
  maxUploadBytes: number;
  maxChangesBytes: number;
  sweepIntervalSeconds: number;
  /**
   * Which header carries the real client IP. Trusted only because the app listens on localhost and
   * the only thing that can reach it is the tunnel or reverse proxy that sets the header.
   */
  clientIpHeader: ClientIpSource;
}

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;
  const maxTtlSeconds = int("KAIZEN_MAX_TTL_SECONDS", 6 * 3600, 300, 7 * 24 * 3600);
  cached = {
    dbPath: process.env.KAIZEN_DB_PATH || "./data/kaizen.db",
    publicUrl: (process.env.KAIZEN_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, ""),
    maxTtlSeconds,
    defaultTtlSeconds: Math.min(int("KAIZEN_DEFAULT_TTL_SECONDS", 3600, 60, maxTtlSeconds), maxTtlSeconds),
    minTtlSeconds: 60,
    maxUploadBytes: int("KAIZEN_MAX_UPLOAD_BYTES", 8 * MiB, 64 * 1024, 64 * MiB),
    maxChangesBytes: int("KAIZEN_MAX_CHANGES_BYTES", 8 * MiB, 64 * 1024, 64 * MiB),
    sweepIntervalSeconds: int("KAIZEN_SWEEP_INTERVAL_SECONDS", 300, 10, 3600),
    clientIpHeader: ipSource(),
  };
  return cached;
}

/** Tests only. */
export function resetConfigForTests() {
  cached = null;
}
