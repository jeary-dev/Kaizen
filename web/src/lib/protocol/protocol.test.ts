import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveRawKeys, deriveSessionKeys, ownerHash, randomBytes, sha256Hex } from "./crypto";
import { type Bytes, b64uDecode, b64uDecodeOrNull, b64uEncode, hexDecode, hexEncode, utf8Decode, utf8Encode } from "./encoding";
import { envelopeToJson, type Kind, open, parseEnvelope, seal } from "./envelope";
import { ProtocolError } from "./errors";
import { isValidPath, normalizeApplyCode } from "./formats";
import { decodeChanges, decodeUpload, encodePayload } from "./payload";

/* eslint-disable @typescript-eslint/no-explicit-any */
const protocolDir = resolve(__dirname, "../../../../protocol");
const vectors: any = JSON.parse(readFileSync(join(protocolDir, "test-vectors/v1.json"), "utf8"));

const bytes = (b64: string): Bytes => b64uDecode(b64, "vector");

/** Imports raw subkeys with every usage, so tests can seal and open in both directions. */
async function testKeys(key: string, sid: string) {
  const raw = await deriveRawKeys(bytes(key), sid);
  const imp = (k: Bytes) => crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { upload: await imp(raw.up), changes: await imp(raw.down) } as Record<Kind, CryptoKey>;
}

async function expectReason(promise: Promise<unknown> | (() => unknown), reason: string) {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected rejection with ${reason}`);
}

describe("base64url", () => {
  it.each(vectors.base64url.valid as { text: string; hex: string }[])("valid '$text'", ({ text, hex }) => {
    expect(hexEncode(bytes(text))).toBe(hex);
    expect(b64uEncode(hexDecode(hex))).toBe(text);
  });
  it.each((vectors.base64url.invalid as string[]).map((t) => [t]))("invalid %j", (text) => {
    expect(b64uDecodeOrNull(text)).toBeNull();
  });
});

describe("key schedule", () => {
  it.each(vectors.keySchedule as any[])("sid $sid", async (c) => {
    const raw = await deriveRawKeys(bytes(c.key), c.sid);
    expect(b64uEncode(raw.up)).toBe(c.kUp);
    expect(b64uEncode(raw.down)).toBe(c.kDown);
    expect(b64uEncode(raw.editToken)).toBe(c.editToken);
    const keys = await deriveSessionKeys(bytes(c.key), c.sid);
    expect(keys.editToken).toBe(c.editToken);
    expect(keys.editHash).toBe(c.editHash);
    expect(keys.up.extractable).toBe(false);
  });

  it.each(vectors.ownerHash as any[])("owner hash for $sid", async (c) => {
    expect(await ownerHash(bytes(c.ownerSecret), c.sid)).toBe(c.ownerHash);
  });
});

describe("envelopes", () => {
  it.each(vectors.envelopes as any[])("seal: $name", async (c) => {
    const keys = await testKeys(c.key, c.sid);
    const sealed = await seal({
      key: keys[c.kind as Kind],
      kind: c.kind,
      sid: c.sid,
      rev: c.rev,
      plaintext: utf8Encode(c.plaintext),
      iv: bytes(c.iv),
      precompressed: bytes(c.compressed),
    });
    expect(envelopeToJson(sealed)).toEqual(c.envelope);
  });

  it.each(vectors.envelopes as any[])("open: $name", async (c) => {
    const keys = await testKeys(c.key, c.sid);
    const plaintext = await open({
      key: keys[c.kind as Kind],
      expectedSid: c.sid,
      expectedKind: c.kind,
      envelope: parseEnvelope(JSON.parse(JSON.stringify(c.envelope))),
    });
    expect(utf8Decode(plaintext)).toBe(c.plaintext);
  });

  it.each(vectors.rejections as any[])("rejects $name -> $reason", async (c) => {
    const keys = await testKeys(c.key, c.expectedSid);
    await expectReason(async () => {
      const envelope = parseEnvelope(c.envelope);
      await open({
        key: keys[c.expectedKind as Kind],
        expectedSid: c.expectedSid,
        expectedKind: c.expectedKind,
        envelope,
        maxPlaintextBytes: c.maxPlaintextBytes,
      });
    }, c.reason);
  });

  it("round-trips random data with the real CompressionStream and keeps a BOM", async () => {
    const keys = await deriveSessionKeys(randomBytes(32), b64uEncode(randomBytes(16)));
    const raw = await testKeys(b64uEncode(randomBytes(32)), keys.sid);
    const text = "﻿# 桜\r\nkey: value\n".repeat(5000);
    const sealed = await seal({ key: raw.changes, kind: "changes", sid: keys.sid, rev: 3, plaintext: utf8Encode(text) });
    const opened = await open({ key: raw.changes, expectedSid: keys.sid, expectedKind: "changes", envelope: sealed });
    expect(utf8Decode(opened)).toBe(text);
  });

  it("uses a fresh IV for every seal", async () => {
    const raw = await testKeys(b64uEncode(randomBytes(32)), "AAAAAAAAAAAAAAAAAAAAAA");
    const ivs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const e = await seal({ key: raw.upload, kind: "upload", sid: "AAAAAAAAAAAAAAAAAAAAAA", rev: 0, plaintext: utf8Encode("x") });
      ivs.add(b64uEncode(e.iv));
    }
    expect(ivs.size).toBe(100);
  });
});

describe("payloads", () => {
  it.each(vectors.payloads as any[])("$name", async (c) => {
    const decode = () => (c.kind === "upload" ? decodeUpload : decodeChanges)(utf8Encode(c.json), c.sid);
    if (c.ok) {
      const decoded = decode();
      // Re-encoding and decoding again gives the same value.
      const again = (c.kind === "upload" ? decodeUpload : decodeChanges)(encodePayload(decoded), c.sid);
      expect(again).toEqual(decoded);
    } else {
      await expectReason(decode, c.reason);
    }
  });

  it("uploadSha256 in the vectors matches the upload plaintext", async () => {
    const upload = vectors.payloads.find((p: any) => p.name === "valid upload");
    const changes = JSON.parse(vectors.payloads.find((p: any) => p.name === "valid changes").json);
    expect(await sha256Hex(utf8Encode(upload.json))).toBe(changes.uploadSha256);
  });
});

describe("paths and apply codes", () => {
  it.each((vectors.paths.valid as string[]).map((p) => [p]))("valid %j", (p) => expect(isValidPath(p)).toBe(true));
  it.each((vectors.paths.invalid as string[]).map((p) => [p]))("invalid %j", (p) => expect(isValidPath(p)).toBe(false));
  it.each(vectors.applyCodes as any[])("apply code %j", ({ input, normalized }) => {
    expect(normalizeApplyCode(input)).toBe(normalized);
  });
});

// Live cross-language round trip, driven by `node protocol/tools/interop.mjs`.
const interopDir = process.env.KAIZEN_INTEROP_DIR;
describe.runIf(Boolean(interopDir))("interop with the Kotlin implementation", () => {
  const dir = interopDir ?? "";

  it("writes envelopes for Kotlin", async () => {
    mkdirSync(dir, { recursive: true });
    const samples: [Kind, string][] = [
      ["upload", ""],
      ["upload", '{"motd":"桜 — sakura\\r\\n"}'],
      ["changes", "y".repeat(200_000)],
      ["changes", "tabs\tand\u0000nulls and emoji 🌸"],
    ];
    const cases = [];
    for (const [i, [kind, plaintext]] of samples.entries()) {
      const key = randomBytes(32);
      const sid = b64uEncode(randomBytes(16));
      const keys = await testKeys(b64uEncode(key), sid);
      const envelope = await seal({ key: keys[kind], kind, sid, rev: kind === "upload" ? 0 : i, plaintext: utf8Encode(plaintext) });
      cases.push({ key: b64uEncode(key), sid, kind, plaintext, envelope: envelopeToJson(envelope) });
    }
    writeFileSync(join(dir, "ts.json"), JSON.stringify(cases));
  });

  it.runIf(existsSync(join(dir, "kt.json")))("opens envelopes sealed by Kotlin", async () => {
    const cases: any[] = JSON.parse(readFileSync(join(dir, "kt.json"), "utf8"));
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const keys = await testKeys(c.key, c.sid);
      const plaintext = await open({ key: keys[c.kind as Kind], expectedSid: c.sid, expectedKind: c.kind, envelope: parseEnvelope(c.envelope) });
      expect(utf8Decode(plaintext)).toBe(c.plaintext);
    }
  });
});
