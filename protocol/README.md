# Kaizen protocol, version 1

This is the contract between the Kaizen plugin (`/plugin`) and the Kaizen web app (`/web`).
Both sides implement it independently and both run the shared test vectors in
[`test-vectors/v1.json`](test-vectors/v1.json), so neither side can drift without a test failing.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

- [1. Primitives](#1-primitives)
- [2. Identifiers and tokens](#2-identifiers-and-tokens)
- [3. Key schedule](#3-key-schedule)
- [4. Envelope](#4-envelope)
- [5. Upload payload](#5-upload-payload)
- [6. Changes payload](#6-changes-payload)
- [7. Paths](#7-paths)
- [8. Secret placeholders](#8-secret-placeholders)
- [9. Apply codes](#9-apply-codes)
- [10. Errors](#10-errors)
- [11. Versioning](#11-versioning)
- [12. Test vectors](#12-test-vectors)

## 1. Primitives

| Purpose | Algorithm |
| --- | --- |
| Symmetric encryption | AES-256-GCM, 96-bit IV, 128-bit tag |
| Key derivation | HKDF-SHA256 (RFC 5869) |
| Hashing | SHA-256, written as 64 lowercase hex characters |
| Owner binding | HMAC-SHA256 |
| Compression | gzip (RFC 1952) |
| Binary-to-text | base64url without padding (RFC 4648 §5) |

Every one of these is available in the JDK and in WebCrypto plus `CompressionStream`, so neither
side needs a third-party crypto library.

**base64url.** Encoders MUST NOT emit padding. Decoders MUST reject padding, whitespace, any
character outside `A-Z a-z 0-9 - _`, lengths that are 1 mod 4, and non-canonical encodings
(non-zero trailing bits, such as `AB` instead of `AA`), so each byte string has exactly one text form.

**Text.** All strings are UTF-8. JSON is UTF-8 without a BOM.

## 2. Identifiers and tokens

| Name | Size | Form | Created by | Stored on the web server as |
| --- | --- | --- | --- | --- |
| Session key `K` | 32 random bytes | base64url (43 chars) | plugin, per session | **never sent** |
| Session id `sid` | 16 random bytes | base64url (22 chars) | plugin, per session | plain |
| Edit token | 32 bytes (derived, §3) | base64url (43 chars) | derived from `K` | `editHash` |
| Owner secret `T` | 32 random bytes | base64url (43 chars) | plugin, once per install | `ownerHash` per session |

The editor link is:

```
{webUrl}/e/{sid}#k={base64url(K)}
```

`K` lives only in the URL fragment. Browsers never send fragments to servers, never include them
in the `Referer` header, and proxies (including Cloudflare) never see them.

```
editHash  = hex(SHA-256(editTokenBytes))
ownerHash = hex(SHA-256(HMAC-SHA256(key = T, message = UTF-8(sid))))
```

The web server checks a presented token by recomputing the hash and comparing in constant time.
Because the owner hash mixes in `sid`, the hashes of different sessions from the same server
cannot be linked to each other.

## 3. Key schedule

```
salt = UTF-8(sid)
kUp       = HKDF-SHA256(ikm = K, salt, info = "kaizen/v1/up",        L = 32)   // plugin -> browser
kDown     = HKDF-SHA256(ikm = K, salt, info = "kaizen/v1/down",      L = 32)   // browser -> plugin
editToken = HKDF-SHA256(ikm = K, salt, info = "kaizen/v1/edit-auth", L = 32)   // browser -> web API
```

Each direction has its own key, so a message can never be reflected back the other way. The edit
token proves to the web API that the caller holds the link, without revealing `K`.

## 4. Envelope

The envelope is the only thing the web server stores or moves around. It is JSON:

```json
{
  "v": 1,
  "alg": "A256GCM",
  "kind": "upload",
  "sid": "q1L2Dk3a0bV7nR9sXy4uZA",
  "rev": 0,
  "iv": "b64url(12 bytes)",
  "ct": "b64url(ciphertext || 16-byte tag)"
}
```

| Field | Rule |
| --- | --- |
| `v` | MUST be `1` |
| `alg` | MUST be `"A256GCM"` |
| `kind` | `"upload"` (key `kUp`) or `"changes"` (key `kDown`) |
| `sid` | The session id |
| `rev` | Integer. `0` for an upload. For changes, `>= 1` and strictly greater than every earlier revision of the same session |
| `iv` | Exactly 12 bytes, freshly random for every encryption |
| `ct` | At least 16 bytes (the tag) |

### Associated data

```
aad = UTF-8("kaizen/v1|" + kind + "|" + sid + "|" + rev)
```

When decrypting, the receiver MUST build the AAD from the values **it expects**: its own session
id and the kind it is waiting for. Only `rev` comes from the envelope, and since `rev` is inside the
AAD, any change to it breaks the tag too. A server that swaps envelopes between sessions, swaps
directions, or edits any field causes an authentication failure.

### Encryption

```
plaintext  = UTF-8(JSON payload)
compressed = gzip(plaintext)
ct         = AES-256-GCM-Encrypt(key, iv, compressed, aad)
```

### Decryption

1. Parse the envelope. Check `v`, `alg`, `kind`, `sid`, the `iv` length and the minimum `ct` length.
2. Decrypt and verify the tag using the expected AAD. If the tag fails, stop. Nothing is
   decompressed or parsed until authentication has passed.
3. Gunzip, aborting as soon as the output passes `maxPlaintextBytes` (default 32 MiB). This blocks
   decompression bombs.
4. Decode the result as strict UTF-8 and parse it as JSON.

Different gzip implementations produce different bytes for the same input, so the test vectors fix
the compressed bytes. Decoders MUST accept any valid gzip stream with one member.

## 5. Upload payload

The decompressed plaintext of a `kind: "upload"` envelope:

```json
{
  "format": "kaizen.upload",
  "v": 1,
  "sid": "q1L2Dk3a0bV7nR9sXy4uZA",
  "createdAt": "2026-11-18T13:00:00Z",
  "expiresAt": "2026-11-18T14:00:00Z",
  "server": { "software": "Paper 1.21.11", "kaizen": "1.0.0" },
  "scope": "all",
  "files": [
    {
      "path": "plugins/Essentials/config.yml",
      "plugin": "Essentials",
      "lang": "yaml",
      "sha256": "…",
      "content": "…",
      "secrets": [ { "id": "KAIZEN_SECRET_1_q7f2", "key": "database.password", "line": 12 } ]
    }
  ],
  "reloadHints": { "Essentials": "essentials reload" }
}
```

| Field | Rule |
| --- | --- |
| `sid` | MUST match the envelope's session (checked after decryption) |
| `scope` | `"all"`, `"server"`, or a plugin name |
| `files[].path` | A valid path (§7), unique within the upload |
| `files[].plugin` | Plugin name, or `null` for the server's own config files |
| `files[].lang` | One of `yaml`, `json`, `properties`, `toml`, `conf`, `text` |
| `files[].sha256` | SHA-256 of the file's **raw bytes on disk**, before redaction |
| `files[].content` | The file decoded as UTF-8, with secrets replaced (§8). Line endings and any BOM are kept exactly |
| `files[].secrets` | One entry per placeholder in `content` |
| `reloadHints` | Optional map from plugin name to a console command, without the leading `/` |

`uploadSha256` is defined as `hex(SHA-256(plaintext))` over the exact decompressed bytes. The
plugin records it when it uploads, and the browser computes it after decrypting.

## 6. Changes payload

The decompressed plaintext of a `kind: "changes"` envelope. It lists only the files that changed,
each with its complete new text:

```json
{
  "format": "kaizen.changes",
  "v": 1,
  "sid": "q1L2Dk3a0bV7nR9sXy4uZA",
  "uploadSha256": "…",
  "createdAt": "2026-11-18T13:20:00Z",
  "files": [
    { "path": "plugins/Essentials/config.yml", "baseSha256": "…", "content": "…" }
  ]
}
```

Before showing the confirmation, the plugin MUST check all of the following. Any failure rejects
the whole change set:

- `sid` equals the session's id, and `uploadSha256` equals the value recorded at upload.
- Every `path` passes §7 again and **appeared in the original upload**. Paths are unique.
- Every `baseSha256` equals that path's `sha256` from the upload.
- There is at least one file.

Apply-time checks, per file:

- The file on disk still hashes to `baseSha256`. If it doesn't, the file was changed on disk
  after the editor opened. The plugin then refuses the **whole** change set, not just that file,
  because a partial apply could leave related files out of step. The admin opens a fresh editor.
- Placeholders follow the rules in §8.
- Writes stay inside the allowed roots and never follow symlinks.

The plugin computes the line diff for the summary itself. It never trusts a diff from the browser.

## 7. Paths

A path is relative to the Minecraft server's root directory. It is valid only if **all** of these
hold:

- It is 1 to 512 characters long and uses `/` as the separator.
- It does not start with `/`, and it is not a drive path (`C:`) or a UNC path.
- It contains no `\`, no NUL or other control characters, and no `:`.
- No segment is empty, `.`, or `..`.
- Its extension (lowercase) is one of `.yml .yaml .json .properties .toml .conf .txt`.

These are format rules only. The plugin also enforces a policy: which roots are allowed, which
files are skipped, size limits, and no symlinks anywhere along the path.

## 8. Secret placeholders

The plugin replaces each value whose key looks like a secret with a token:

```
KAIZEN_SECRET_<n>_<tag>
```

`<n>` is a 1-based counter per file. `<tag>` is 4 characters from `[a-z0-9]`, picked at random once
per session, so nobody can type a valid placeholder by accident. Placeholders are bare
identifiers. That makes them valid unquoted values in YAML, TOML, properties and HOCON, and in JSON
they go inside the original quotes. The quoting around the value is always kept.

On apply:

- A placeholder MUST appear at most once in a file's new content.
- A placeholder that was not in that file's upload is rejected (`placeholder`).
- A placeholder that has been removed is allowed, because the admin deleted the setting, but the
  summary flags it.
- Every remaining placeholder is replaced with the real value from the file currently on disk.
  The plugin finds those values by running the same redaction again with the same tag, which is
  why it never has to store secrets.

## 9. Apply codes

8 characters from the Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, generated by
the web server with a CSPRNG, for example `K7M2QX9P`.

Before checking a code, both sides normalize it:

1. Remove spaces and `-`.
2. Convert to uppercase.
3. Map `O` to `0`, and `I` and `L` to `1`.

The result must match `^[0-9A-HJKMNP-TV-Z]{8}$`. The code is shown as `K7M2 QX9P`, and the command
uses the plain form `/kaizen apply K7M2QX9P`, which Brigadier always accepts as a single word.

A code can be claimed **once**, only before the session expires, and only by the holder of the
session's owner secret. A new save makes all earlier codes for the session invalid.

## 10. Errors

Implementations report failures using these reason codes:

| Reason | Meaning |
| --- | --- |
| `malformed` | Not valid envelope or payload JSON, a field of the wrong type or size, or bad base64url |
| `unsupported` | `v` or `alg` (or the payload's `format`/`v`) is not one we support |
| `auth` | The GCM tag failed. The data was tampered with, the wrong key was used, or the AAD didn't match |
| `oversize` | The ciphertext or the decompressed plaintext is over the limit |
| `mismatch` | Decrypted, but bound to a different session, kind or upload |
| `path` | A path broke §7 or was not in the original upload |
| `placeholder` | A placeholder was unknown or duplicated |

## 11. Versioning

`v` appears in both the envelope and the payload. A breaking change bumps it and adds a new vector
file such as `v2.json`. Within one version, decoders MUST ignore unknown JSON fields, which leaves
room for additions that don't break older clients. The web API reports the versions it supports
at `GET /api/v1/info`.

## 12. Test vectors

[`test-vectors/v1.json`](test-vectors/v1.json) is generated by
[`tools/generate-vectors.mjs`](tools/generate-vectors.mjs) from fixed seeds, using Node's own
crypto, which is a third implementation independent of both sides. It covers:

- `base64url`: valid and invalid encodings.
- `keySchedule`: `K` and `sid` mapped to `kUp`, `kDown`, `editToken`, `editHash`.
- `ownerHash`: `T` and `sid` mapped to `ownerHash`.
- `envelopes`: given a fixed IV and compressed bytes, the exact `ct`. Decrypting the envelope gives
  the exact plaintext.
- `rejections`: tampered or invalid envelopes and the reason each must fail with.
- `paths`: valid and invalid paths.
- `applyCodes`: inputs, each with its normalized form or `null`.

Both test suites, Kotlin (JUnit) and TypeScript (Vitest), load this file. The interop test adds a
live round trip. Each side writes envelopes with random keys and its real gzip into
`test-vectors/interop/`, and the other side decrypts them:

```sh
node protocol/tools/interop.mjs   # runs both suites in order, in both directions
```
