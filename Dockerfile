# syntax=docker/dockerfile:1.7

FROM oven/bun:1-slim AS build

WORKDIR /app

# curl/gnupg pull in the NodeSource repo below. Node.js 22 is required by the
# built-in PDS, which runs as a child process because @atproto/pds cannot load
# under bun; Debian bookworm only ships Node 18.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    curl \
    gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY bun.lock ./bun.lock
COPY scripts ./scripts

RUN bun install --frozen-lockfile

# Installed with npm (not bun) so native modules match the Node child process's
# ABI. Done at build time so the runtime image needs neither npm nor network
# access on first PDS start.
COPY pds-service/package.json pds-service/package-lock.json ./pds-service/
RUN cd pds-service && npm ci --no-audit --no-fund --omit=dev

COPY . .

RUN bun run build \
  && bun install --frozen-lockfile --production


FROM oven/bun:1-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  TWEETS2BSKY_DATA_DIR=/app/data \
  SCHEDULED_ACCOUNT_TIMEOUT_MS=480000 \
  CHROME_BIN=/usr/bin/chromium \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Node.js 22 runs the built-in PDS child process (bun cannot load @atproto/pds).
# npm is deliberately not installed: dependencies are baked in by the build stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    tini \
    curl \
    gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/public ./public
# Runtime for the optional built-in PDS, with its own pre-installed node_modules.
COPY --from=build /app/pds-service ./pds-service

RUN mkdir -p /app/data \
  && ln -sf /app/data/config.json /app/config.json

VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/auth/bootstrap-status').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "dist/index.js"]
