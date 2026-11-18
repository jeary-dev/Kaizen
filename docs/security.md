# Security

Kaizen moves a Minecraft server's config files to a browser and back. Those files hold database
passwords, webhook URLs and RCON passwords, and a bad write can break a server. This document
covers what Kaizen protects, what it trusts, and where the limits are.

The wire format and crypto are specified in [`protocol/README.md`](../protocol/README.md). This page
covers the reasoning behind them.

- [Threat model](#threat-model)
- [What the editor server can and cannot do](#what-the-editor-server-can-and-cannot-do)
- [TLS ends at Cloudflare, and that is fine](#tls-ends-at-cloudflare-and-that-is-fine)
- [Client IPs and CF-Connecting-IP](#client-ips-and-cf-connecting-ip)
- [Secrets](#secrets)
- [Applying changes](#applying-changes)
- [Files Kaizen will touch](#files-kaizen-will-touch)
- [Web app hardening](#web-app-hardening)
- [Known limits](#known-limits)
- [Reporting a vulnerability](#reporting-a-vulnerability)

## Threat model

| Party | Trusted with |
| --- | --- |
| The Minecraft server and its operators (`kaizen.use`, console) | Everything. They can already edit these files. |
| Whoever holds the editor link | Reading and editing the uploaded files (secrets excluded) until the link expires. |
| The editor server (edit.jeary.dev or your own) | Storing ciphertext and enforcing expiry and rate limits. **Not** with file contents. |
| Cloudflare, the network, browser extensions on other sites | Nothing. |

The goals:

1. **Confidentiality.** Only the server and the link holder can read the files. The editor
   server, its database, its backups and anything in between see ciphertext.
2. **Integrity.** Nothing the server writes can be forged or altered on the way. That covers the
   editor server, the network, and a stolen apply code.
3. **No inbound access.** The Minecraft server only makes outbound HTTPS requests. Nothing listens
   on it and nothing can push to it.
4. **Bounded blast radius.** Even a valid, authenticated change can only rewrite files that were
   uploaded, inside the allowed folders, and every apply can be undone.

## What the editor server can and cannot do

The session key `K` lives only in the link's fragment (`/e/{sid}#k=…`). Browsers never send the
fragment in a request or in the `Referer` header, so it never reaches the editor server or
Cloudflare. The editor server only gets derived values:

- the **edit token**, an HKDF output of `K` that proves the caller has the link, stored only as a
  SHA-256 hash;
- the **owner hash**, `SHA-256(HMAC(T, sid))`, where `T` is a secret only the plugin holds
  (`plugins/Kaizen/data/owner.secret`).

If the editor server is fully compromised, the attacker **can**:

- delete sessions or refuse service;
- see metadata: session ids, ciphertext sizes, timestamps, and while a request is being handled,
  the client IP. IPs are used as rate-limit keys in memory and are never stored or logged;
- serve **malicious JavaScript** to people who open editor links afterwards. That script would
  run with the fragment key, so it could read those sessions. This applies to every web app that
  does in-browser encryption, LuckPerms' editor included. It is why the app uses no third-party
  scripts, a strict CSP, and a reproducible build anyone can self-host and audit.

The attacker **cannot**:

- read file contents of stored or past sessions (AES-256-GCM, key never sent);
- alter an upload or a change set without breaking the GCM tag. The associated data binds each
  envelope to its session id, direction and revision, so envelopes can't be swapped between
  sessions or reflected;
- produce a change set the plugin will accept. That needs `kDown`, which is derived from `K`;
- claim an apply code for a server. Claiming needs the owner secret `T`. A stolen code alone is
  useless: the plugin must also decrypt what it gets back with its own session keys;
- replay an older change set. Revisions only go up, every new save makes earlier codes invalid,
  and the plugin applies a session at most once.

## TLS ends at Cloudflare, and that is fine

edit.jeary.dev is served through a Cloudflare Tunnel. HTTPS terminates at Cloudflare's edge, and
the tunnel carries the traffic to `cloudflared` on the host, which forwards it to the app on
`127.0.0.1:3100` over plain HTTP.

Cloudflare can therefore see the requests: paths, headers, and the JSON bodies. That does not
expose any config files:

- Every file body is inside an AES-256-GCM envelope that the plugin or the browser encrypted
  before sending.
- The key is in the URL fragment, which is not part of an HTTP request. Cloudflare never sees it,
  and neither does the app.
- The edit token in the `Authorization` header is derived from `K` one-way. It lets you read the
  ciphertext and save new ciphertext, but you can't decrypt or forge either without `K`. Anyone
  who intercepted it could at most delete the session or save junk the plugin will reject.
- The last hop (cloudflared → app) never leaves the machine.

So Cloudflare, like the app, is trusted for availability only. The one thing it *could* do, like
any host or CDN, is change the JavaScript it serves. See the previous section.

## Client IPs and CF-Connecting-IP

Rate limits are per client IP (per /64 for IPv6). Behind the tunnel every request comes from
cloudflared on localhost, so the app reads the real IP from `CF-Connecting-IP`
(`KAIZEN_CLIENT_IP_HEADER`, default `cf-connecting-ip`).

That header can be trusted **only because nothing except cloudflared can reach the app**:

- Docker publishes the port as `127.0.0.1:3100`, and the systemd unit binds `HOSTNAME=127.0.0.1`.
- Cloudflare overwrites `CF-Connecting-IP` on every request, so a client can't choose its own value.

If you expose the port some other way, a client could send any `CF-Connecting-IP` and get a fresh
rate-limit bucket for every request. Then set `KAIZEN_CLIENT_IP_HEADER` to the header your proxy
overwrites (`x-real-ip`, or `x-forwarded-for`, whose last entry is used), or to `none` to rate-limit
all traffic as a single client. The IP is only used for rate limiting. It is never stored or logged.

## Secrets

Before upload, the plugin replaces values that look like secrets with a placeholder such as
`KAIZEN_SECRET_2_q7f2`. It matches by key name (password, secret, token, api-key, webhook,
private-key, credentials and more) and by value (JDBC URLs with passwords, `user:pass@` URLs,
Discord and Slack webhooks, PEM blocks). Admins can add patterns in `config.yml`.

- The real values never leave the server, not even encrypted.
- In the editor, placeholders are locked: they can't be typed over or partly deleted, only
  removed whole with the setting around them.
- On apply, the plugin redacts the file on disk again with the same per-session tag and puts the
  real values back. It never stores secrets anywhere.
- Changes are refused if a placeholder is duplicated or comes from another file. Removing one is
  allowed and shown in the summary.

Redaction works on patterns, so it can miss a secret stored under an unusual key. The editor still
encrypts everything, but a missed secret is visible to whoever has the link. Add patterns for
anything specific to your server.

## Applying changes

`/kaizen apply <code>` does the following, in order. Any failure stops it before a byte is written:

1. Claims the code from the editor server with the owner secret. This works once, and only
   before the session expires.
2. Checks the envelope is for **this** session and was encrypted with `kDown`. Tampering shows up
   here as a tag failure.
3. Checks the payload: it must match this session id and the exact upload (`uploadSha256`), every
   path must have been in the original upload, and every `baseSha256` must match.
4. Checks every target file on disk still has the hash it had at upload. If **any** file changed
   since the editor opened, the whole change set is refused, because applying only part of it
   could leave related files out of step.
5. Checks the placeholder rules and puts the secrets back.
6. Shows a summary (files, lines changed, removed secrets, reload hints), then waits for the
   admin to click Confirm or Cancel. The prompt is tied to that sender and expires.
7. Backs up every original, writes each file to a temp file in the same folder, then moves it into
   place atomically. If any write fails, everything already written is rolled back from the backup.

Every apply and undo goes into history and the server log with the sender's name. `/kaizen undo`
first checks the backup against its recorded SHA-256, and an undo can itself be undone.

## Files Kaizen will touch

- Only files under `plugins/` and the server files listed in `config.yml` (`server.properties`,
  `bukkit.yml`, `spigot.yml`, Paper's `config/` files and so on).
- Only `.yml .yaml .json .properties .toml .conf .txt`, each under the size limit (512 KiB by
  default).
- Never anything excluded by default: player and user data, storage and database folders, logs,
  caches, `tmp`, libraries, Kaizen's own folder. Admins can add their own excludes.
- Never through a symlink, at any point in the path, and never outside the server folder. Paths
  are checked on the way out and again on the way back in.
- On apply, only files that were in that session's upload.

## Web app hardening

- **CSP.** Every response gets a per-request nonce:
  `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'`, plus `object-src 'none'`,
  `base-uri 'none'`, `frame-ancestors 'none'` and `form-action 'self'`. No inline styles are
  needed, because the code editor receives the nonce too.
- **No third-party code at runtime.** No analytics, external fonts or CDNs. Fonts are self-hosted.
  The browser e2e test fails on any request that leaves the origin and on any CSP violation.
- **Other headers.** HSTS when served over HTTPS, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options`, a restrictive `Permissions-Policy`, and `Cross-Origin-Opener-Policy`.
  Editor pages are `noindex`, and `robots.txt` disallows `/e/` and `/api/`.
- **API.** Strict JSON schemas, a body size limit per route (8 MiB for envelopes, 4 KiB for
  claims), token buckets per IP and route class, extra cost for failed claims, and
  constant-time hash comparison. Request bodies and tokens are never logged.
- **Storage.** SQLite holds only envelopes, hashes and timestamps. A sweeper deletes expired
  sessions every 5 minutes. Sessions last 1 hour by default and the server caps them at 6 hours.
- **Runtime.** The Docker image runs as a non-root user with a read-only root filesystem, no
  capabilities and `no-new-privileges`. The systemd unit uses `DynamicUser`, `ProtectSystem=strict`,
  a syscall filter and `IPAddressAllow=localhost`. npm never runs dependency install scripts.

## Known limits

- **The console link is written to the server log.** When the console runs `/kaizen editor`,
  the link, key included, appears in the console and so in `logs/latest.log`. The plugin prints a
  warning saying so. Anyone who can read the logs can usually read the config files directly
  anyway. The link expires with the session (1 hour by default). Players get the link only in
  their own chat.
- **Whoever has the link can edit.** Share it as you would a password. Applying still needs
  someone with `kaizen.use` on the server to run `/kaizen apply` and confirm.
- **Trust in the served JavaScript.** See above. Self-host if you don't want to trust edit.jeary.dev.
- **Rate limits are per process.** They live in memory and reset on restart. That's fine for a
  single instance. Optionally add a Cloudflare rate-limiting rule as well (see
  [deploy.md](deploy.md#optional-cloudflare-rate-limiting-rule)).
- **Dev-only audit findings.** `npm audit` reports issues in build tooling (`picomatch` through
  lint and test tools). The production dependency tree has no known vulnerabilities, and CI checks
  that with `npm audit --omit=dev`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on
[jeary-dev/Kaizen](https://github.com/jeary-dev/Kaizen/security/advisories/new) rather than a
public issue.
