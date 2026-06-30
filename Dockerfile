# syntax=docker/dockerfile:1

FROM node:24-bookworm AS builder
WORKDIR /app
RUN corepack enable
# native build deps for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json biome.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# prune to a self-contained server (bundles @submerge/shared dist + prod node_modules)
# --legacy: pnpm v10+ refuses non-injected deploy by default; this workspace does not
# inject workspace packages, so @submerge/shared is resolved via its conditional exports
# (-> dist/index.js) and deployed as a regular dependency.
RUN pnpm --filter @submerge/server deploy --prod --legacy /app/deploy

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app app
COPY --from=builder /app/deploy ./
COPY --from=builder /app/packages/web/dist ./web
RUN mkdir -p /app/data && chown -R app:app /app/data
ENV NODE_ENV=production
ENV PORT=3000
ENV WEB_DIST=/app/web
ENV DB_PATH=/app/data/submerge.db
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
