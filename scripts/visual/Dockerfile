# Visual harness image for #710. The self-hosted runner is a slim container
# without root or sudo, so it cannot install Chrome's shared libraries.
# CI builds this image and runs the harness inside it. Baselines in
# test/visual/baselines are produced by this image.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxi6 \
    libxss1 \
    libxtst6 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CI=true makes the harness drop Chrome's user-namespace sandbox, which
# this container cannot use. Skip the postinstall download: it swallows
# errors and leaves a cache directory that the next install will not replace.
ENV CI=true \
    PUPPETEER_SKIP_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci
RUN rm -rf /root/.cache/puppeteer \
  && PUPPETEER_SKIP_DOWNLOAD=0 npx puppeteer browsers install chrome \
  && test -x /root/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome

COPY vite.web.config.mjs ./
COPY src ./src
COPY scripts ./scripts
COPY test/visual/baselines ./test/visual/baselines

CMD ["npm", "run", "test:visual"]
