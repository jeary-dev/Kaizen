# Deploying the web app

The plugin works with the public editor at https://edit.jeary.dev out of the box, so you only need
this page if you run the editor yourself.

The web app is one Node process with a SQLite file. It never needs inbound ports on the Minecraft
server, and in the setup below it doesn't open any public ports on the web host either. It listens
on `127.0.0.1:3100`, and an existing **Cloudflare Tunnel** (`cloudflared` running on the host)
makes it reachable as `https://edit.jeary.dev`.

```
browser ──HTTPS──▶ Cloudflare edge ══tunnel══▶ cloudflared (host) ──HTTP──▶ 127.0.0.1:3100 ──▶ Kaizen
plugin  ──HTTPS──▶        ″                         ″                           ″
```

- [Docker on Debian (recommended)](#docker-on-debian-recommended)
- [Point the Cloudflare Tunnel at it](#point-the-cloudflare-tunnel-at-it)
- [Updating](#updating)
- [Configuration](#configuration)
- [Optional: Cloudflare rate-limiting rule](#optional-cloudflare-rate-limiting-rule)
- [Cloudflare settings to check](#cloudflare-settings-to-check)
- [Without Docker (systemd)](#without-docker-systemd)
- [Self-hosting without Cloudflare](#self-hosting-without-cloudflare)
- [Pointing the plugin at your instance](#pointing-the-plugin-at-your-instance)
- [Operations](#operations)

## Docker on Debian (recommended)

On a fresh Debian 12 or 13 machine, install Docker Engine and the Compose plugin with
[Docker's apt repository](https://docs.docker.com/engine/install/debian/), plus `git`, `make` and
`curl`:

```sh
sudo apt-get update && sudo apt-get install -y git make curl
# then follow https://docs.docker.com/engine/install/debian/ (docker-ce + docker-compose-plugin)
sudo usermod -aG docker "$USER"    # log out and back in afterwards
```

Clone the repository and start it:

```sh
sudo mkdir -p /opt/kaizen && sudo chown "$USER" /opt/kaizen
git clone https://github.com/jeary-dev/Kaizen.git /opt/kaizen
cd /opt/kaizen/deploy
cp kaizen.env.example kaizen.env   # optional: edit KAIZEN_PUBLIC_URL etc.
make deploy-local                  # build, start and wait until healthy
```

Check it:

```sh
curl http://127.0.0.1:3100/api/v1/health    # {"ok":true}
make status
```

What [`deploy/compose.yaml`](../deploy/compose.yaml) sets up:

- A single `web` service built from [`web/Dockerfile`](../web/Dockerfile) (Node 24, Next.js
  standalone output, runs as the unprivileged `node` user, with a built-in health check).
- The port is published **only on loopback**: `127.0.0.1:3100:3000`. Nothing on the network can
  reach it except through cloudflared.
- SQLite lives on the named volume `kaizen_kaizen-data`, mounted at `/data`.
- A read-only root filesystem, every capability dropped, `no-new-privileges`, a memory and PID
  limit, and log rotation.
- `restart: unless-stopped`, so it comes back after a reboot.

## Point the Cloudflare Tunnel at it

This assumes `cloudflared` already runs on the host as a systemd service, connected to a tunnel.

**Dashboard-managed tunnel** (the usual case): in the Cloudflare dashboard, go to
**Zero Trust → Networks → Tunnels**, select your tunnel, choose **Edit**, open the
**Public Hostname** tab and click **Add a public hostname**:

| Field | Value |
| --- | --- |
| Subdomain | `edit` |
| Domain | `jeary.dev` |
| Path | *(empty)* |
| Service type | `HTTP` |
| URL | `localhost:3100` |

Save. Cloudflare creates the DNS record, and the editor is live at https://edit.jeary.dev within
a few seconds. You don't need any extra settings under *Additional application settings*.

**Locally managed tunnel** (`/etc/cloudflared/config.yml`): add an ingress rule above the
catch-all, then `sudo systemctl restart cloudflared`:

```yaml
ingress:
  - hostname: edit.jeary.dev
    service: http://localhost:3100
  # … your other hostnames …
  - service: http_status:404
```

and route DNS with `cloudflared tunnel route dns <tunnel-name> edit.jeary.dev`.

Check from anywhere:

```sh
curl -sI https://edit.jeary.dev | grep -i content-security-policy
curl -s https://edit.jeary.dev/api/v1/info
```

**Why `CF-Connecting-IP` is trusted.** The app rate-limits by client IP and, behind the tunnel,
reads it from the `CF-Connecting-IP` header that Cloudflare sets. This is safe only because the
port is bound to `127.0.0.1`, so cloudflared is the only thing that can connect. Don't change
the port mapping to `0.0.0.0` or `3100:3000`. If you do expose it, set
`KAIZEN_CLIENT_IP_HEADER=none`. Details are in
[security.md](security.md#client-ips-and-cf-connecting-ip).

## Updating

```sh
cd /opt/kaizen/deploy
make deploy
```

[`deploy.sh`](../deploy/deploy.sh) does the following:

1. `git pull --ff-only`;
2. builds the new image **while the old container keeps serving**;
3. swaps the containers with `docker compose up -d --wait`, which waits for the health check;
4. checks `/api/v1/health` and removes dangling images. If the health check fails, it prints the
   container logs and exits with an error.

Downtime is the few seconds the new container needs to start. Sessions live in the volume, so open
editors and pending apply codes survive the update. `make deploy-local` does the same without
`git pull`.

## Configuration

Set these in `deploy/kaizen.env` (Docker) or `/etc/kaizen/kaizen.env` (systemd). All are optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KAIZEN_PUBLIC_URL` | `https://edit.jeary.dev` in compose | Public address, used for editor links |
| `KAIZEN_CLIENT_IP_HEADER` | `cf-connecting-ip` | `cf-connecting-ip`, `x-real-ip`, `x-forwarded-for` or `none` |
| `KAIZEN_DEFAULT_TTL_SECONDS` | `3600` | Session lifetime when the plugin doesn't ask for one |
| `KAIZEN_MAX_TTL_SECONDS` | `21600` | Upper bound for any session (plugins asking for more are capped) |
| `KAIZEN_MAX_UPLOAD_BYTES` | `8388608` | Largest upload request (encrypted, compressed) |
| `KAIZEN_MAX_CHANGES_BYTES` | `8388608` | Largest save request |
| `KAIZEN_SWEEP_INTERVAL_SECONDS` | `300` | How often expired sessions are deleted |
| `KAIZEN_DB_PATH` | `/data/kaizen.db` | SQLite file. Leave it alone in Docker |

Invalid values stop the app at startup with a clear message rather than being silently ignored.

## Optional: Cloudflare rate-limiting rule

The app already rate-limits every API route per IP. A Cloudflare rule adds a coarse outer limit
that stops floods before they reach the tunnel. In the dashboard for `jeary.dev`, go to
**Security → WAF → Rate limiting rules** and create a rule:

- **If incoming requests match:** `(http.host eq "edit.jeary.dev" and starts_with(http.request.uri.path, "/api/"))`
- **Counting by:** IP
- **When rate exceeds:** 100 requests per 10 seconds
- **Then:** Block for 10 seconds

Keep it generous. A plugin uploading and a browser saving use only a handful of requests, and the
app's own limits are much tighter per route.

## Cloudflare settings to check

Cloudflare features that rewrite pages break the strict CSP or the plugin's API calls:

- **Rocket Loader, Email Address Obfuscation, automatic Web Analytics injection:** turn these off
  for edit.jeary.dev (Configuration Rules, or zone-wide). They inject scripts that the CSP blocks,
  which by design makes the editor refuse them.
- **Bot Fight Mode / "I'm Under Attack" / managed challenges:** the plugin is a Java HTTP client
  and can't solve a challenge. If `/kaizen editor` fails with an HTTP 403 or 503 from Cloudflare,
  add a WAF custom rule that **skips** these for `starts_with(http.request.uri.path, "/api/v1/")`.
- **Caching:** nothing to do. API responses are `no-store` and pages are dynamic, so Cloudflare
  doesn't cache them. Don't add a "cache everything" rule for this hostname.

## Without Docker (systemd)

Needs Node.js 24 on the host (for example from [NodeSource](https://github.com/nodesource/distributions)).

```sh
git clone https://github.com/jeary-dev/Kaizen.git ~/kaizen
~/kaizen/deploy/build-standalone.sh /opt/kaizen/web        # npm ci, build, install atomically
sudo cp ~/kaizen/deploy/kaizen-web.service /etc/systemd/system/
sudo mkdir -p /etc/kaizen   # optional: put overrides in /etc/kaizen/kaizen.env
sudo systemctl daemon-reload
sudo systemctl enable --now kaizen-web
curl http://127.0.0.1:3100/api/v1/health
```

The unit ([`deploy/kaizen-web.service`](../deploy/kaizen-web.service)):

- binds `HOSTNAME=127.0.0.1`, `PORT=3100`, so the tunnel setup above is the same;
- runs as a throwaway `DynamicUser`, with the database in `/var/lib/kaizen` (mode 0700);
- is hardened with `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no capabilities, a
  syscall filter, and `IPAddressAllow=localhost`. The app never makes outbound connections, so
  this costs nothing.

To update: `git -C ~/kaizen pull && ~/kaizen/deploy/build-standalone.sh /opt/kaizen/web && sudo systemctl restart kaizen-web`.
The previous build is kept as `/opt/kaizen/web.old`.

## Self-hosting without Cloudflare

Any reverse proxy on the same host works. Keep the app on `127.0.0.1:3100`, terminate TLS in the
proxy, and tell the app which header carries the client IP. With
[Caddy](https://caddyserver.com/), which gets certificates automatically:

```caddyfile
edit.example.com {
	reverse_proxy 127.0.0.1:3100 {
		# Caddy overwrites X-Real-IP with the address it saw.
		header_up X-Real-IP {remote_host}
	}
}
```

```sh
# deploy/kaizen.env
KAIZEN_PUBLIC_URL=https://edit.example.com
KAIZEN_CLIENT_IP_HEADER=x-real-ip
```

Caddy also sets `X-Forwarded-For`, so `x-forwarded-for` works too (the app uses the last entry,
which is the one Caddy added). Use HTTPS. The plugin only accepts `http://` for `localhost`.

## Pointing the plugin at your instance

In `plugins/Kaizen/config.yml` on the Minecraft server:

```yaml
web-url: "https://edit.example.com"
```

then `/kaizen reload`. The server only needs outbound HTTPS to that host. If a hosting provider
blocks outbound connections, `/kaizen editor` says so and names the host to allow.

## Operations

All of these run from `deploy/`:

| Command | Does |
| --- | --- |
| `make deploy` | Pull, build, swap, wait for health |
| `make deploy-local` | Same, without `git pull` |
| `make status` | Container state and the health endpoint |
| `make logs` | Follow the app logs. No payloads or tokens are ever logged |
| `make restart` / `make stop` | Restart, or stop and remove the container (the volume stays) |
| `make backup` | Consistent SQLite copy to `deploy/kaizen-backup.db` |

The database only holds encrypted envelopes and hashes, and every session expires within hours,
so backups are optional. Losing the database only means open editor links stop working.
