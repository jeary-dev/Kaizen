import { beforeEach, describe, expect, it } from "vitest";
import { deriveRawKeys, deriveSessionKeys, ownerHash, randomBytes, sha256Hex } from "@/lib/protocol/crypto";
import { type Bytes, b64uEncode, utf8Encode } from "@/lib/protocol/encoding";
import { envelopeToJson, open, parseEnvelope, seal } from "@/lib/protocol/envelope";
import { decodeChanges, decodeUpload, encodePayload, type UploadPayload } from "@/lib/protocol/payload";
import * as api from "./api";
import { clientIp } from "./client-ip";
import type { Config } from "./config";
import { openDb } from "./db";
import { RateLimiter } from "./rate-limit";
import { sweep } from "./store";

const BASE = "http://localhost:3000";
const config: Config = {
  dbPath: ":memory:",
  publicUrl: "https://edit.example",
  maxTtlSeconds: 6 * 3600,
  defaultTtlSeconds: 3600,
  minTtlSeconds: 60,
  maxUploadBytes: 256 * 1024,
  maxChangesBytes: 256 * 1024,
  sweepIntervalSeconds: 300,
  clientIpHeader: "cf-connecting-ip",
};

let clock = Date.parse("2026-11-18T13:00:00Z");
let deps: api.Deps;

beforeEach(() => {
  clock = Date.parse("2026-11-18T13:00:00Z");
  deps = { db: openDb(":memory:"), config, limiter: new RateLimiter(), now: () => clock };
});

// ------------------------------------------------------------------------------------------------
// A tiny simulated plugin and browser, built on the real protocol implementation.

interface PluginSession {
  key: Bytes;
  sid: string;
  owner: Bytes;
  upload: UploadPayload;
  uploadSha256: string;
  envelope: ReturnType<typeof envelopeToJson>;
  editToken: string;
  editHash: string;
}

async function pluginSession(owner = randomBytes(32)): Promise<PluginSession> {
  const key = randomBytes(32);
  const sid = b64uEncode(randomBytes(16));
  const upload: UploadPayload = {
    format: "kaizen.upload",
    v: 1,
    sid,
    createdAt: "2026-11-18T13:00:00Z",
    expiresAt: "2026-11-18T14:00:00Z",
    server: { software: "Paper 1.21.11", kaizen: "1.0.0" },
    scope: "all",
    files: [
      {
        path: "plugins/Sakura/config.yml",
        plugin: "Sakura",
        lang: "yaml",
        sha256: "a".repeat(64),
        content: "bloom: true\npetals: 128\n",
        secrets: [],
      },
    ],
    reloadHints: {},
  };
  const plaintext = encodePayload(upload);
  const raw = await deriveRawKeys(key, sid);
  const up = await crypto.subtle.importKey("raw", raw.up, "AES-GCM", false, ["encrypt"]);
  const envelope = envelopeToJson(await seal({ key: up, kind: "upload", sid, rev: 0, plaintext }));
  const keys = await deriveSessionKeys(key, sid);
  return {
    key,
    sid,
    owner,
    upload,
    uploadSha256: await sha256Hex(plaintext),
    envelope,
    editToken: keys.editToken,
    editHash: keys.editHash,
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, token: string) =>
  new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.7" } });

const del = (path: string, token: string) =>
  new Request(`${BASE}${path}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });

const call = (route: Parameters<typeof api.run>[0], request: Request, h: (r: Request, d: api.Deps, ip: string) => Response | Promise<Response>) =>
  api.run(route, request, deps, h);

async function create(s: PluginSession, extra: Record<string, unknown> = {}) {
  return call(
    "create",
    post("/api/v1/sessions", { envelope: s.envelope, ownerHash: await ownerHash(s.owner, s.sid), editHash: s.editHash, ...extra }),
    api.createSession,
  );
}

const getSession = (s: PluginSession, token = s.editToken) =>
  call("read", get(`/api/v1/sessions/${s.sid}`, token), (r, d) => api.getSession(r, d, s.sid));

async function browserSave(s: PluginSession, rev: number, content: string) {
  const raw = await deriveRawKeys(s.key, s.sid);
  const down = await crypto.subtle.importKey("raw", raw.down, "AES-GCM", false, ["encrypt"]);
  const changes = {
    format: "kaizen.changes" as const,
    v: 1 as const,
    sid: s.sid,
    uploadSha256: s.uploadSha256,
    createdAt: "2026-11-18T13:20:00Z",
    files: [{ path: "plugins/Sakura/config.yml", baseSha256: "a".repeat(64), content }],
  };
  const envelope = await seal({ key: down, kind: "changes", sid: s.sid, rev, plaintext: encodePayload(changes) });
  return call(
    "save",
    post(`/api/v1/sessions/${s.sid}/changes`, { envelope: envelopeToJson(envelope) }, { authorization: `Bearer ${s.editToken}` }),
    (r, d) => api.saveChanges(r, d, s.sid),
  );
}

const claim = (code: string, owner: Bytes) =>
  call("claim", post("/api/v1/claim", { code }, { authorization: `Bearer ${b64uEncode(owner)}` }), api.claim);

// ------------------------------------------------------------------------------------------------

describe("full flow", () => {
  it("plugin uploads, browser edits, plugin claims and applies; the server never sees plaintext", async () => {
    const s = await pluginSession();

    const created = await create(s);
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.editorUrl).toBe(`https://edit.example/e/${s.sid}`);
    expect(createdBody.ttlSeconds).toBe(3600);

    // Browser: knows K from the fragment, fetches with the derived edit token, decrypts.
    const fetched = await (await getSession(s)).json();
    expect(fetched.status).toBe("open");
    const keys = await deriveSessionKeys(s.key, s.sid);
    const uploadBytes = await open({ key: keys.up, expectedSid: s.sid, expectedKind: "upload", envelope: parseEnvelope(fetched.envelope) });
    expect(decodeUpload(uploadBytes, s.sid).files[0].content).toContain("petals: 128");
    expect(await sha256Hex(uploadBytes)).toBe(s.uploadSha256);

    // Browser saves; gets a code.
    const saved = await browserSave(s, 1, "bloom: true\npetals: 256\n");
    expect(saved.status).toBe(201);
    const { code } = await saved.json();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect((await (await getSession(s)).json()).pending).toEqual({ rev: 1, code });

    // Nothing in the database is readable: no file content, no keys, no tokens.
    const dump = JSON.stringify(deps.db.prepare("SELECT * FROM sessions").all()) + JSON.stringify(deps.db.prepare("SELECT * FROM changes").all());
    for (const secret of ["petals", "bloom", "Sakura", b64uEncode(s.key), s.editToken, b64uEncode(s.owner)]) {
      expect(dump).not.toContain(secret);
    }

    // Plugin claims with its owner secret (the code is typed lowercase with a dash).
    const claimed = await claim(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`, s.owner);
    expect(claimed.status).toBe(200);
    const claimedBody = await claimed.json();
    expect(claimedBody.sid).toBe(s.sid);
    const raw = await deriveRawKeys(s.key, s.sid);
    const down = await crypto.subtle.importKey("raw", raw.down, "AES-GCM", false, ["decrypt"]);
    const changes = decodeChanges(
      await open({ key: down, expectedSid: s.sid, expectedKind: "changes", envelope: parseEnvelope(claimedBody.envelope) }),
      s.sid,
    );
    expect(changes.uploadSha256).toBe(s.uploadSha256);
    expect(changes.files[0].content).toBe("bloom: true\npetals: 256\n");

    // The code works once.
    expect((await claim(code, s.owner)).status).toBe(410);

    // Plugin reports success: all ciphertext is dropped.
    const done = await call("plugin", post(`/api/v1/sessions/${s.sid}/applied`, {}, { authorization: `Bearer ${b64uEncode(s.owner)}` }), (r, d) =>
      api.applied(r, d, s.sid),
    );
    expect(done.status).toBe(204);
    const after = await (await getSession(s)).json();
    expect(after.status).toBe("applied");
    expect(after.envelope).toBeNull();
    expect(deps.db.prepare("SELECT upload FROM sessions").get()).toEqual({ upload: null });
    expect(deps.db.prepare("SELECT COUNT(*) n FROM changes").get()).toEqual({ n: 0 });

    // Saving after apply is refused.
    expect((await browserSave(s, 2, "x: 1\n")).status).toBe(409);
  });
});

describe("sessions", () => {
  it("clamps the TTL to the server's limits", async () => {
    const long = await create(await pluginSession(), { ttlSeconds: 999_999 });
    expect((await long.json()).ttlSeconds).toBe(6 * 3600);
    const short = await create(await pluginSession(), { ttlSeconds: 1 });
    expect((await short.json()).ttlSeconds).toBe(60);
  });

  it("rejects a duplicate session id", async () => {
    const s = await pluginSession();
    expect((await create(s)).status).toBe(201);
    expect((await create(s)).status).toBe(409);
  });

  it("stores the envelope canonically, without extra fields", async () => {
    const s = await pluginSession();
    await create({ ...s, envelope: { ...s.envelope, sneaky: "x".repeat(100) } as never });
    const row = deps.db.prepare("SELECT upload FROM sessions").get() as { upload: string };
    expect(JSON.parse(row.upload)).toEqual(s.envelope);
  });

  it("rejects malformed and wrong-kind envelopes", async () => {
    const s = await pluginSession();
    const bad = await create({ ...s, envelope: { ...s.envelope, iv: "short" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("envelope_malformed");
    const wrongKind = await create({ ...s, envelope: { ...s.envelope, kind: "changes", rev: 1 } });
    expect((await wrongKind.json()).error).toBe("envelope_kind");
    const badHash = await call("create", post("/api/v1/sessions", { envelope: s.envelope, ownerHash: "nope", editHash: s.editHash }), api.createSession);
    expect(badHash.status).toBe(400);
  });

  it("hides sessions from anyone without the edit token", async () => {
    const s = await pluginSession();
    await create(s);
    const other = await pluginSession();
    expect((await getSession(s, other.editToken)).status).toBe(404);
    expect((await getSession(s, "not-a-token")).status).toBe(401);
    expect((await getSession(other)).status).toBe(404);
  });

  it("requires a strictly increasing rev, and a new save kills the old code", async () => {
    const s = await pluginSession();
    await create(s);
    const first = await (await browserSave(s, 1, "a: 1\n")).json();
    expect((await browserSave(s, 1, "a: 2\n")).status).toBe(409);
    const second = await (await browserSave(s, 5, "a: 3\n")).json();
    expect(second.rev).toBe(5);
    expect((await claim(first.code, s.owner)).status).toBe(404);
    expect((await claim(second.code, s.owner)).status).toBe(200);
  });

  it("can be discarded by the editor or by the owner, deleting all ciphertext", async () => {
    const a = await pluginSession();
    await create(a);
    expect((await call("plugin", del(`/api/v1/sessions/${a.sid}`, a.editToken), (r, d) => api.discardSession(r, d, a.sid))).status).toBe(204);
    expect((await (await getSession(a)).json()).status).toBe("discarded");

    const b = await pluginSession();
    await create(b);
    await browserSave(b, 1, "x: 1\n");
    expect((await call("plugin", del(`/api/v1/sessions/${b.sid}`, b64uEncode(b.owner)), (r, d) => api.discardSession(r, d, b.sid))).status).toBe(204);
    expect(deps.db.prepare("SELECT COUNT(*) n FROM changes").get()).toEqual({ n: 0 });

    const stranger = randomBytes(32);
    const c = await pluginSession();
    await create(c);
    expect((await call("plugin", del(`/api/v1/sessions/${c.sid}`, b64uEncode(stranger)), (r, d) => api.discardSession(r, d, c.sid))).status).toBe(404);
  });
});

describe("claims", () => {
  it("only the server that created the session can claim its changes", async () => {
    const s = await pluginSession();
    await create(s);
    const { code } = await (await browserSave(s, 1, "a: 1\n")).json();
    const thief = await claim(code, randomBytes(32));
    expect(thief.status).toBe(404);
    // The failed attempt did not burn the code.
    expect((await claim(code, s.owner)).status).toBe(200);
  });

  it("rejects malformed codes before touching the database", async () => {
    const res = await claim("K7M2,QX9P", randomBytes(32));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_code");
  });

  it("failed claims drain the rate limit faster than successful ones", async () => {
    const owner = randomBytes(32);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await claim("ABCDEFGH", owner)).status);
    // burst 10, each failure costs 1 + 2 penalty: the fourth attempt is already limited.
    expect(statuses.slice(0, 4)).toEqual([404, 404, 404, 404]);
    expect(statuses.slice(4)).toEqual([429, 429]);
  });
});

describe("expiry and the sweep", () => {
  it("treats expired sessions as gone and the sweep deletes them with their changes", async () => {
    const s = await pluginSession();
    await create(s, { ttlSeconds: 600 });
    const { code } = await (await browserSave(s, 1, "a: 1\n")).json();

    clock += 599_000;
    expect((await getSession(s)).status).toBe(200);
    clock += 1_000;
    expect((await getSession(s)).status).toBe(404);
    expect((await claim(code, s.owner)).status).toBe(404);
    expect((await browserSave(s, 2, "a: 2\n")).status).toBe(404);

    const live = await pluginSession();
    await create(live);

    expect(sweep(deps.db, clock)).toBe(1);
    expect(deps.db.prepare("SELECT sid FROM sessions").all()).toEqual([{ sid: live.sid }]);
    expect(deps.db.prepare("SELECT COUNT(*) n FROM changes").get()).toEqual({ n: 0 });
    expect(sweep(deps.db, clock)).toBe(0);
  });
});

describe("request limits", () => {
  it("rejects bodies over the limit by Content-Length and by actual size", async () => {
    const big = JSON.stringify({ envelope: { ct: "A".repeat(300 * 1024) } });
    const declared = new Request(`${BASE}/api/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect((await call("create", declared, api.createSession)).status).toBe(413);

    // A streamed body without Content-Length.
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 40; i++) controller.enqueue(utf8Encode("x".repeat(10 * 1024)));
        controller.close();
      },
    });
    const streamed = new Request(`${BASE}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await call("create", streamed, api.createSession)).status).toBe(413);
  });

  it("requires application/json and valid JSON", async () => {
    const text = new Request(`${BASE}/api/v1/sessions`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect((await call("create", text, api.createSession)).status).toBe(415);
    const broken = new Request(`${BASE}/api/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect((await call("create", broken, api.createSession)).status).toBe(400);
  });

  it("rate-limits per client IP with Retry-After", async () => {
    const results: number[] = [];
    for (let i = 0; i < 62; i++) results.push((await call("meta", get("/api/v1/info", "x"), api.info)).status);
    expect(results.filter((s) => s === 429)).toHaveLength(2);
    const limited = await call("meta", get("/api/v1/info", "x"), api.info);
    expect(limited.headers.get("retry-after")).toBe("1");
    // A different client is unaffected.
    const other = new Request(`${BASE}/api/v1/info`, { headers: { "cf-connecting-ip": "198.51.100.1" } });
    expect((await call("meta", other, api.info)).status).toBe(200);
  });

  it("does not send caching or sniffing hints on API responses", async () => {
    const res = await call("meta", get("/api/v1/info", "x"), api.info);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.json();
    expect(body.protocols).toEqual([1]);
    expect(body.ttl).toEqual({ min: 60, default: 3600, max: 21600 });
  });
});

describe("client IP", () => {
  const h = (name: string, value: string) => new Headers({ [name]: value });

  it("reads the configured header only", () => {
    expect(clientIp(h("cf-connecting-ip", "203.0.113.9"), "cf-connecting-ip")).toBe("203.0.113.9");
    expect(clientIp(h("x-forwarded-for", "1.1.1.1"), "cf-connecting-ip")).toBe("unknown");
    expect(clientIp(h("x-real-ip", "203.0.113.9"), "x-real-ip")).toBe("203.0.113.9");
    expect(clientIp(h("x-forwarded-for", "6.6.6.6, 203.0.113.9"), "x-forwarded-for")).toBe("203.0.113.9");
    expect(clientIp(h("cf-connecting-ip", "203.0.113.9"), "none")).toBe("direct");
  });

  it("ignores garbage and groups IPv6 by /64", () => {
    expect(clientIp(h("cf-connecting-ip", "not-an-ip"), "cf-connecting-ip")).toBe("unknown");
    expect(clientIp(h("cf-connecting-ip", "2001:db8:1:2:3:4:5:6"), "cf-connecting-ip")).toBe("2001:db8:1:2::/64");
    expect(clientIp(h("cf-connecting-ip", "2001:db8:1:2::9"), "cf-connecting-ip")).toBe("2001:db8:1:2::/64");
    expect(clientIp(h("cf-connecting-ip", "2001:db8::1"), "cf-connecting-ip")).toBe("2001:db8:0:0::/64");
    expect(clientIp(h("cf-connecting-ip", "::ffff:198.51.100.4"), "cf-connecting-ip")).toBe("198.51.100.4");
  });
});

