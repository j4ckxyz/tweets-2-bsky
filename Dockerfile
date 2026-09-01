# syntax=docker/dockerfile:1.7

FROM oven/bun:1-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY bun.lock ./bun.lock
COPY scripts ./scripts

# --omit=optional skips better-sqlite3, which exists only as a plain-Node
# fallback: this image runs on Bun, which uses its built-in bun:sqlite. Building
# it here needed a C++ toolchain and, since its supported Node range stopped at
# 25, broke the image build outright once the builder moved to Node 26.
RUN bun install --frozen-lockfile --omit=optional

COPY . .

RUN bun run build \
  && bun install --frozen-lockfile --production --omit=optional


FROM oven/bun:1-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  TWEETS2BSKY_DATA_DIR=/app/data \
  SCHEDULED_ACCOUNT_TIMEOUT_MS=480000 \
  CHROME_BIN=/usr/bin/chromium \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/public ./public

RUN mkdir -p /app/data \
  && ln -sf /app/data/config.json /app/config.json

VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/auth/bootstrap-status').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "dist/index.js"]
