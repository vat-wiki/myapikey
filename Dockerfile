# syntax=docker/dockerfile:1

# ---- stage 1: build the web SPA ----
FROM node:22-alpine AS web
# optional npm registry override, e.g. https://registry.npmmirror.com
ARG NPM_CONFIG_REGISTRY
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci
COPY packages/web packages/web
RUN npm run build:web

# ---- stage 2: runtime ----
FROM node:22-alpine
WORKDIR /app

ARG VERSION=dev
ARG NPM_CONFIG_REGISTRY
LABEL org.opencontainers.image.title="myapikey" \
      org.opencontainers.image.description="Personal LLM API gateway — one address + one key for all your models" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/vat-wiki/myapikey" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH \
    MYAPIKEY_DATA_DIR=/data

# prod deps only: root deps (incl. tsx) + @myapikey/core's deps
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
RUN npm ci --omit=dev --include-workspace-root --workspace @myapikey/core

# core runs from source via tsx (no compile step), web dist from stage 1
COPY packages/core/src packages/core/src
COPY --from=web /app/packages/web/dist packages/web/dist

VOLUME /data
EXPOSE 7800

CMD ["tsx", "packages/core/src/cli/index.ts", "serve"]
