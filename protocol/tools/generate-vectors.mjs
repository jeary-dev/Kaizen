#!/usr/bin/env node
// Generates protocol/test-vectors/v1.json from fixed seeds.
//
// This is a third, independent implementation of the protocol (Node's own crypto, not WebCrypto
// and not the JDK). Both the Kotlin and the TypeScript test suites check against its output.
//
//   node protocol/tools/generate-vectors.mjs          # rewrite the file
//   node protocol/tools/generate-vectors.mjs --check  # exit 1 if the committed file is stale

import { createCipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test-vectors", "v1.json");

// ---------------------------------------------------------------------------------------------
// Deterministic "randomness": every value is SHA-256 of a label, so the file is reproducible.

const seeded = (label, length) => {
  const chunks = [];
  for (let i = 0; Buffer.concat(chunks).length < length; i++) {
    chunks.push(createHash("sha256").update(`kaizen-vectors/${label}/${i}`).digest());
  }
  return Buffer.concat(chunks).subarray(0, length);
};

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const hkdf = (key, sid, info) => Buffer.from(hkdfSync("sha256", key, Buffer.from(sid, "utf8"), info, 32));

const keysFor = (key, sid) => ({
  kUp: hkdf(key, sid, "kaizen/v1/up"),
  kDown: hkdf(key, sid, "kaizen/v1/down"),
  editToken: hkdf(key, sid, "kaizen/v1/edit-auth"),
});

const aad = (kind, sid, rev) => Buffer.from(`kaizen/v1|${kind}|${sid}|${rev}`, "utf8");

// gzip with a fixed header (mtime 0, OS byte 255 = unknown) so the bytes are stable everywhere.
const gzip = (buf) => {
  const gz = gzipSync(buf, { level: 9 });
  gz.writeUInt32LE(0, 4);
  gz[9] = 0xff;
  return gz;
};

const seal = ({ key, sid, kind, rev, iv, compressed }) => {
  const keys = keysFor(key, sid);
  const cipher = createCipheriv("aes-256-gcm", kind === "upload" ? keys.kUp : keys.kDown, iv);
  cipher.setAAD(aad(kind, sid, rev));
  const ct = Buffer.concat([cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, alg: "A256GCM", kind, sid, rev, iv: b64u(iv), ct: b64u(ct) };
};

// ---------------------------------------------------------------------------------------------
// Fixed inputs

const K1 = seeded("key/1", 32);
const SID1 = b64u(seeded("sid/1", 16));
const K2 = seeded("key/2", 32);
const SID2 = b64u(seeded("sid/2", 16));
const T1 = seeded("owner/1", 32);

const uploadPayload = {
  format: "kaizen.upload",
  v: 1,
  sid: SID1,
  createdAt: "2026-11-18T13:00:00Z",
  expiresAt: "2026-11-18T14:00:00Z",
  server: { software: "Paper 1.21.11", kaizen: "1.0.0" },
  scope: "all",
  files: [
    {
      path: "plugins/Sakura/config.yml",
      plugin: "Sakura",
      lang: "yaml",
      sha256: sha256Hex(Buffer.from("# Sakura\nbloom: true\npetals: 128\ndatabase:\n  password: hunter2\n")),
      content: "# Sakura\nbloom: true\npetals: 128\ndatabase:\n  password: KAIZEN_SECRET_1_q7f2\n",
      secrets: [{ id: "KAIZEN_SECRET_1_q7f2", key: "database.password", line: 5 }],
    },
    {
      path: "server.properties",
      plugin: null,
      lang: "properties",
      sha256: sha256Hex(Buffer.from("motd=桜の下で \u2014 under the cherry trees\r\nmax-players=20\r\n")),
      content: "motd=桜の下で \u2014 under the cherry trees\r\nmax-players=20\r\n",
      secrets: [],
    },
  ],
  reloadHints: { Sakura: "sakura reload" },
};
const uploadText = JSON.stringify(uploadPayload);

const changesPayload = {
  format: "kaizen.changes",
  v: 1,
  sid: SID1,
  uploadSha256: sha256Hex(Buffer.from(uploadText, "utf8")),
  createdAt: "2026-11-18T13:20:00Z",
  files: [
    {
      path: "plugins/Sakura/config.yml",
      baseSha256: uploadPayload.files[0].sha256,
      content: "# Sakura\nbloom: true\npetals: 256\ndatabase:\n  password: KAIZEN_SECRET_1_q7f2\n",
    },
  ],
};
const changesText = JSON.stringify(changesPayload);

const envelopeCases = [
  { name: "upload, unicode and CRLF", key: K1, sid: SID1, kind: "upload", rev: 0, iv: seeded("iv/1", 12), plaintext: uploadText },
  { name: "changes, rev 1", key: K1, sid: SID1, kind: "changes", rev: 1, iv: seeded("iv/2", 12), plaintext: changesText },
  { name: "changes, rev 42, other session", key: K2, sid: SID2, kind: "changes", rev: 42, iv: seeded("iv/3", 12), plaintext: '{"hello":"世界"}' },
  { name: "empty plaintext", key: K2, sid: SID2, kind: "upload", rev: 0, iv: seeded("iv/4", 12), plaintext: "" },
];

const envelopes = envelopeCases.map((c) => {
  const compressed = gzip(Buffer.from(c.plaintext, "utf8"));
  return {
    name: c.name,
    key: b64u(c.key),
    sid: c.sid,
    kind: c.kind,
    rev: c.rev,
    iv: b64u(c.iv),
    compressed: b64u(compressed),
    plaintext: c.plaintext,
    envelope: seal({ ...c, compressed }),
  };
});

// ---------------------------------------------------------------------------------------------
// Rejections: an envelope plus what the receiver expects, and the reason it must fail with.

const base = envelopes[0].envelope;
const baseChanges = envelopes[1].envelope;

const flipB64 = (value, byteIndex) => {
  const buf = Buffer.from(value, "base64url");
  const i = byteIndex < 0 ? buf.length + byteIndex : byteIndex;
  buf[i] ^= 0x01;
  return b64u(buf);
};

const rejection = (name, envelope, reason, extra = {}) => ({
  name,
  key: extra.key ?? b64u(K1),
  expectedSid: extra.expectedSid ?? SID1,
  expectedKind: extra.expectedKind ?? envelope.kind ?? "upload",
  maxPlaintextBytes: extra.maxPlaintextBytes ?? 33554432,
  envelope,
  reason,
});

const sealedWith = (plaintextBytes, opts = {}) =>
  seal({ key: K1, sid: SID1, kind: "upload", rev: 0, iv: seeded("iv/r", 12), compressed: plaintextBytes, ...opts });

const rejections = [
  rejection("ciphertext bit flipped", { ...base, ct: flipB64(base.ct, 3) }, "auth"),
  rejection("tag bit flipped", { ...base, ct: flipB64(base.ct, -1) }, "auth"),
  rejection("iv bit flipped", { ...base, iv: flipB64(base.iv, 0) }, "auth"),
  rejection("rev changed (bound by AAD)", { ...baseChanges, rev: 2 }, "auth"),
  rejection("wrong key", base, "auth", { key: b64u(K2) }),
  rejection(
    "server swapped in another session's envelope, relabelled",
    { ...envelopes[2].envelope, sid: SID1, kind: "changes" },
    "auth",
  ),
  rejection("encrypted with the upload key but labelled as changes", { ...base, kind: "changes", rev: 1 }, "auth", {
    expectedKind: "changes",
  }),
  rejection("envelope for another session", { ...base, sid: SID2 }, "mismatch"),
  rejection("upload delivered where changes were expected", base, "mismatch", { expectedKind: "changes" }),
  rejection("unsupported version", { ...base, v: 2 }, "unsupported"),
  rejection("unsupported algorithm", { ...base, alg: "A128GCM" }, "unsupported"),
  rejection("iv too short", { ...base, iv: b64u(seeded("short", 8)) }, "malformed"),
  rejection("ciphertext shorter than a tag", { ...base, ct: b64u(seeded("tiny", 10)) }, "malformed"),
  rejection("padded base64", { ...base, iv: Buffer.from(seeded("iv/1", 12)).toString("base64") + "=" }, "malformed"),
  rejection("non-url base64 alphabet", { ...base, ct: base.ct.replace(/^./, "+") }, "malformed"),
  rejection("missing ct", (({ ct: _ct, ...rest }) => rest)(base), "malformed"),
  rejection("rev is a string", { ...base, rev: "0" }, "malformed"),
  rejection("negative rev", { ...base, rev: -1 }, "malformed"),
  rejection("fractional rev", { ...baseChanges, rev: 1.5 }, "malformed"),
  rejection("upload with rev 1", sealedWith(gzip(Buffer.from("{}")), { rev: 1 }), "malformed"),
  rejection("changes with rev 0", sealedWith(gzip(Buffer.from("{}")), { kind: "changes", rev: 0 }), "malformed", {
    expectedKind: "changes",
  }),
  rejection("unknown kind", { ...base, kind: "download" }, "malformed"),
  rejection("authentic but not gzip", sealedWith(Buffer.from('{"not":"gzipped"}')), "malformed"),
  rejection("authentic gzip of invalid UTF-8", sealedWith(gzip(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))), "malformed"),
  rejection("decompression bomb", sealedWith(gzip(Buffer.alloc(4096, 0x61))), "oversize", { maxPlaintextBytes: 1024 }),
];

// ---------------------------------------------------------------------------------------------
// Payload-level checks (after a successful decrypt).

const payloads = [
  { name: "valid upload", kind: "upload", sid: SID1, json: uploadText, ok: true },
  { name: "valid changes", kind: "changes", sid: SID1, json: changesText, ok: true },
  { name: "unknown fields are ignored", kind: "changes", sid: SID1, json: JSON.stringify({ ...changesPayload, future: { x: 1 } }), ok: true },
  { name: "not JSON", kind: "upload", sid: SID1, json: "{nope", reason: "malformed" },
  { name: "JSON array", kind: "upload", sid: SID1, json: "[]", reason: "malformed" },
  { name: "wrong format name", kind: "upload", sid: SID1, json: JSON.stringify({ ...uploadPayload, format: "kaizen.changes" }), reason: "unsupported" },
  { name: "future payload version", kind: "changes", sid: SID1, json: JSON.stringify({ ...changesPayload, v: 2 }), reason: "unsupported" },
  { name: "sid inside payload differs", kind: "changes", sid: SID2, json: changesText, reason: "mismatch" },
  { name: "bad lang", kind: "upload", sid: SID1, json: JSON.stringify({ ...uploadPayload, files: [{ ...uploadPayload.files[0], lang: "exe" }] }), reason: "malformed" },
  { name: "bad sha256", kind: "upload", sid: SID1, json: JSON.stringify({ ...uploadPayload, files: [{ ...uploadPayload.files[0], sha256: "ABC" }] }), reason: "malformed" },
  { name: "traversal path in upload", kind: "upload", sid: SID1, json: JSON.stringify({ ...uploadPayload, files: [{ ...uploadPayload.files[0], path: "plugins/../../etc/passwd.yml" }] }), reason: "path" },
  { name: "duplicate path in changes", kind: "changes", sid: SID1, json: JSON.stringify({ ...changesPayload, files: [changesPayload.files[0], changesPayload.files[0]] }), reason: "path" },
  { name: "empty change set", kind: "changes", sid: SID1, json: JSON.stringify({ ...changesPayload, files: [] }), reason: "malformed" },
  { name: "content is not a string", kind: "changes", sid: SID1, json: JSON.stringify({ ...changesPayload, files: [{ ...changesPayload.files[0], content: 42 }] }), reason: "malformed" },
];

// ---------------------------------------------------------------------------------------------

const vectors = {
  $comment: "Generated by protocol/tools/generate-vectors.mjs. Do not edit by hand.",
  version: 1,
  base64url: {
    valid: [
      { text: "", hex: "" },
      { text: "AA", hex: "00" },
      { text: "_w", hex: "ff" },
      { text: "-_8", hex: "fbff" },
      { text: "AQID", hex: "010203" },
      { text: b64u(seeded("b64", 32)), hex: seeded("b64", 32).toString("hex") },
    ],
    invalid: ["AA==", "A", "AB C", "AB+/", "AB\n", "ÀB", "AAAAA", "AB", "AAB"],
  },
  keySchedule: [
    [K1, SID1],
    [K2, SID2],
  ].map(([key, sid]) => {
    const k = keysFor(key, sid);
    return {
      key: b64u(key),
      sid,
      kUp: b64u(k.kUp),
      kDown: b64u(k.kDown),
      editToken: b64u(k.editToken),
      editHash: sha256Hex(k.editToken),
    };
  }),
  ownerHash: [
    [T1, SID1],
    [T1, SID2],
  ].map(([secret, sid]) => ({
    ownerSecret: b64u(secret),
    sid,
    ownerHash: sha256Hex(createHmac("sha256", secret).update(sid, "utf8").digest()),
  })),
  envelopes,
  rejections,
  payloads,
  paths: {
    valid: [
      "server.properties",
      "bukkit.yml",
      "config/paper-global.yml",
      "plugins/Essentials/config.yml",
      "plugins/LuckPerms/config.yml",
      "plugins/My Plugin/sub dir/messages_en.YAML",
      "plugins/Sakura/桜.json",
      "plugins/a/b/c/d/e/f/settings.toml",
      "plugins/x/.hidden.conf",
      "plugins/x/notes.txt",
    ],
    invalid: [
      "",
      "/etc/passwd.yml",
      "../server.properties",
      "plugins/../server.properties",
      "plugins/./x.yml",
      "plugins//x.yml",
      "plugins/x/",
      "plugins\\x\\config.yml",
      "C:/Windows/win.ini.txt",
      "C:config.yml",
      "//host/share/a.yml",
      "plugins/x/config.yml\u0000.jar",
      "plugins/x/con\nfig.yml",
      "plugins/x/plugin.jar",
      "plugins/x/data.db",
      "plugins/x/config",
      "plugins/x/config.yml.bak",
      "plugins/x/" + "a".repeat(510) + ".yml",
    ],
  },
  applyCodes: [
    { input: "K7M2QX9P", normalized: "K7M2QX9P" },
    { input: "k7m2qx9p", normalized: "K7M2QX9P" },
    { input: "K7M2-QX9P", normalized: "K7M2QX9P" },
    { input: " k7m2 qx9p ", normalized: "K7M2QX9P" },
    { input: "OIL0OIL0", normalized: "01100110" },
    { input: "K7M2QX9", normalized: null },
    { input: "K7M2QX9PA", normalized: null },
    { input: "K7M2QX9U", normalized: null },
    { input: "K7M2,QX9P", normalized: null },
    { input: "", normalized: null },
  ],
};

const json = JSON.stringify(vectors, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = readFileSync(out, "utf8").replace(/\r\n/g, "\n");
  if (current !== json) {
    console.error("protocol/test-vectors/v1.json is out of date; run node protocol/tools/generate-vectors.mjs");
    process.exit(1);
  }
  console.log("test vectors are up to date");
} else {
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
