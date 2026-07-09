# syntax=docker/dockerfile:1

FROM node:25-bookworm AS builder
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

FROM node:25-bookworm-slim AS runtime
WORKDIR /app
# uid/gid pinned to 999: the deploy docs tell Linux hosts to `chown -R 999:999 mihomo`,
# so the id must not drift with the base image's system-id allocation.
RUN groupadd --system --gid 999 app && useradd --system --uid 999 --gid app app
COPY --from=builder /app/deploy ./
COPY --from=builder /app/packages/web/dist ./web
RUN mkdir -p /app/data && chown -R app:app /app/data
ENV NODE_ENV=production
ENV PORT=3000
ENV WEB_DIST=/app/web
ENV DB_PATH=/app/data/submerge.db
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
