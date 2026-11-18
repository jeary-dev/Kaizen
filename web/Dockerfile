# syntax=docker/dockerfile:1
#
# Kaizen web app. Serves plain HTTP; put it behind TLS (Cloudflare Tunnel, Caddy, nginx).
#   docker build -t kaizen-web .
#   docker run -p 127.0.0.1:3100:3000 -v kaizen-data:/data -e KAIZEN_PUBLIC_URL=https://edit.example.com kaizen-web

ARG NODE_IMAGE=node:24.14.0-bookworm-slim

# ---- dependencies ---------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# better-sqlite3 ships prebuilt binaries for linux x64/arm64 (glibc and musl): nothing compiles.
RUN npm ci --no-audit --no-fund

# ---- build ----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next/font downloads the Geist fonts here, at build time; visitors never contact Google.
RUN npm run build \
 && cp -r .next/static .next/standalone/.next/static \
 && cp -r public .next/standalone/public

# ---- runtime --------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    KAIZEN_DB_PATH=/data/kaizen.db

# Only the standalone output: the server, its traced dependencies and the static assets.
COPY --from=build --chown=root:root /app/.next/standalone ./
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
