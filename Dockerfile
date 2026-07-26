# syntax=docker/dockerfile:1

# ---- build native deps (better-sqlite3) ----
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-noto-core \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts

RUN groupadd --gid 1001 bot \
  && useradd --uid 1001 --gid bot --shell /usr/sbin/nologin --create-home bot \
  && mkdir -p /data \
  && chown -R bot:bot /app /data

USER bot

VOLUME ["/data"]

CMD ["node", "src/index.js"]
