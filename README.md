# Kaizen 改善

Edit your Minecraft server's config files in a real web editor, then apply the changes with one
command. Files are end-to-end encrypted, secrets never leave the server, and nothing needs an open
port.

**[Try the demo](https://edit.jeary.dev/demo)** · [Security](docs/security.md) ·
[Self-hosting](docs/deploy.md) · [Protocol](protocol/README.md)

```
/kaizen editor            → click the link, edit in the browser, press Save
/kaizen apply K7M2QX9P    → review the summary, click Confirm
```

## Why

Editing YAML over SFTP or in a panel's text box is how most server configs break: a tab instead of
spaces, a duplicate key, a quote left open, then a restart to find out. Kaizen gives you a proper
editor that catches those mistakes while you type, a diff of exactly what will change, and a
backup and one-command undo for every apply.

## Features

**In the browser**
- File tree of every plugin and server config, with search and a plugin filter.
- CodeMirror 6 with syntax highlighting for YAML, JSON, properties and TOML, plus find/replace
  and tabs for open files.
- Live checks for syntax errors, tabs in YAML, duplicate keys, and type changes (a number that
  became a string). If a file still has errors when you save, you must confirm before it goes through.
- Secrets appear as locked placeholders that can't be edited by accident.
- A diff of every changed file before you save (side by side on wide screens), a countdown until the link expires,
  and an apply code with a copy button.

**On the server**
- Every change is verified before it is shown to you. It must be encrypted for this session, cover
  only files that were uploaded, and match files that haven't changed on disk since.
- A summary with Confirm and Cancel buttons, and only then a backup, atomic writes, and an
  automatic rollback if anything fails.
- Reminders to reload the plugins you touched, with one-click reload commands for plugins that
  support it.
- `/kaizen history` and `/kaizen undo`. Undo is itself undoable.
- Clear errors when the host blocks outbound connections.

## How it works

```
 Minecraft server                        edit.jeary.dev                         Your browser
 ────────────────                        ──────────────                         ────────────
 1. /kaizen editor
    collect configs, redact secrets
    encrypt with a fresh key K  ──────▶  store ciphertext ──────────────────▶  2. open /e/{sid}#k=K
                                                                                   decrypt, edit, validate
                                         store ciphertext  ◀──────────────────  3. encrypt changes, Save
                                         issue apply code  ──────────────────▶     show code K7M2QX9P
 4. /kaizen apply K7M2QX9P  ◀──────────  hand over once
    decrypt, verify, show summary
 5. Confirm → backup, write, done
```

The key `K` is only in the part of the link after `#`, which browsers never send anywhere. The
editor server stores ciphertext it cannot read, and the Minecraft server only ever makes outbound
HTTPS requests. The design is the same as LuckPerms' web editor, with authenticated encryption and
a binding between each change set and the server that created the session.
[docs/security.md](docs/security.md) covers the threat model.

## Install

1. Download `Kaizen-x.y.z.jar` from [Releases](https://github.com/jeary-dev/Kaizen/releases) and
   check it against the `.sha256` file published with it:
   ```sh
   sha256sum -c Kaizen-1.0.0.jar.sha256
   ```
2. Put it in `plugins/` and restart. Paper or Spigot **1.20.6 to 1.21.x** on **Java 21**.
   On first start the server downloads Kaizen's libraries (Kotlin, coroutines, serialization,
   snakeyaml-engine) from Maven Central, at the exact versions it was tested with.
3. Run `/kaizen editor`.

The server needs outbound HTTPS to `edit.jeary.dev`, or to your own instance.

## Commands

The base command is `/kaizen` (alias `/kz`). Every command works from the console too.

| Command | Permission | Does |
| --- | --- | --- |
| `/kaizen editor [all\|server\|<plugin>]` | `kaizen.command.editor` | Opens an editor for every config, only the server's files, or one plugin |
| `/kaizen apply <code>` | `kaizen.command.apply` | Fetches saved changes, verifies them and asks you to confirm |
| `/kaizen history [page]` | `kaizen.command.history` | Lists recent applies and undos |
| `/kaizen undo [id]` | `kaizen.command.undo` | Restores the files from the latest apply, or from a given history entry |
| `/kaizen reload` | `kaizen.command.reload` | Reloads `config.yml` and `messages.yml` |

`kaizen.use` grants editor, apply, history and undo. `kaizen.admin` adds reload. Both default to
**op**. Anyone with `kaizen.use` can read and change every config file the plugin can see, so
treat it as an admin permission.

## Configuration

`plugins/Kaizen/config.yml` is commented throughout. The parts you're most likely to change:

| Key | Default | |
| --- | --- | --- |
| `web-url` | `https://edit.jeary.dev` | Change it if you [host the editor yourself](docs/deploy.md) |
| `session.expire-after` | `1h` | Link lifetime. The editor server caps it (edit.jeary.dev: 6h) |
| `files.server-files` | `server.properties`, `bukkit.yml`, … | Server files that can be edited, besides `plugins/` |
| `files.exclude` | `[]` | Extra globs to never upload, added to the built-in list |
| `redaction.extra-key-patterns` | `[]` | More key names to treat as secrets |
| `backups.keep` / `backups.max-age` | `50` / `30d` | Backup retention, which also limits how far undo can go |
| `reload-commands` | Essentials, LuckPerms, … | Reload buttons shown after an apply |

Both files are validated on load. Each mistake is reported with the setting it's in, and a failed
`/kaizen reload` leaves the previous settings in place. Every message the plugin sends is in `messages.yml` (MiniMessage).

**Which files are uploaded:** files under `plugins/` plus the listed server files, with the
extensions `.yml .yaml .json .properties .toml .conf .txt`, up to 512 KiB each. Player data,
storage and database folders, logs, caches, temp folders, libraries and symlinks are always
skipped. The editor tells you what was skipped and why.

## Repository

| Path | |
| --- | --- |
| [`plugin/`](plugin) | The plugin. Kotlin and Maven. `core` has no Bukkit dependency; `bukkit` is the thin platform layer, built against the Spigot API only |
| [`web/`](web) | The editor and API. Next.js (App Router), TypeScript, Tailwind, CodeMirror 6, SQLite |
| [`protocol/`](protocol) | The versioned wire format, shared test vectors, and the interop tool |
| [`deploy/`](deploy) | Docker Compose, deploy script, Makefile and systemd unit |
| [`docs/`](docs) | [Security](docs/security.md) and [deployment](docs/deploy.md) |

## Development

Requirements: JDK 21 and Node 24.

```sh
# Plugin: build and run all tests; the jar ends up in plugin/bukkit/target/
cd plugin && ./mvnw verify

# Web
cd web && npm ci
npm run dev                         # http://localhost:3000, try /demo
npm run lint && npm run typecheck && npm test

# Both implementations against the shared vectors, and each decrypting the other's output
node protocol/tools/generate-vectors.mjs --check
node protocol/tools/interop.mjs
```

**End-to-end tests** run against a production build on `127.0.0.1:3100`:

```sh
cd web && npm run build
cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public
HOSTNAME=127.0.0.1 PORT=3100 KAIZEN_PUBLIC_URL=http://localhost:3100 node .next/standalone/server.js &

npm run e2e -- browser   # drives a real Chrome/Edge: CSP, editor, validation, review, mobile layouts
KAIZEN_E2E_SERVER=/path/to/paper-server npm run e2e -- real-server
```

The real-server test starts a Paper or Spigot server that has Kaizen installed, with `web-url`
set to `http://localhost:3100`. It drives the server through its console and runs the full cycle:
open, edit in the browser's crypto, save, apply, history, undo and redo, plus tampered and replayed
change sets.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of the above except the
real-server test, and builds and smoke-tests the Docker image. Pushing a `v*` tag publishes the
jar with its SHA-256 to GitHub Releases and the image to GHCR.

## License

[MIT](LICENSE) © jeary-dev
