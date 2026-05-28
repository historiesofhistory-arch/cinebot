# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests first — one layer per package.json for better caching.
# Any change to source code will NOT invalidate these layers, so pnpm install
# only reruns when a package.json / lockfile actually changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY artifacts/api-server/package.json   ./artifacts/api-server/
COPY artifacts/cinebot-app/package.json  ./artifacts/cinebot-app/
COPY artifacts/tg-bot/package.json       ./artifacts/tg-bot/
COPY lib/api-client-react/package.json   ./lib/api-client-react/
COPY lib/api-spec/package.json           ./lib/api-spec/
COPY lib/api-zod/package.json            ./lib/api-zod/
COPY lib/db/package.json                 ./lib/db/

# Install all workspace dependencies
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Copy full source (after install so the layer above is cached)
COPY . .

# Build React frontend (BASE_PATH=/ so all assets load from root)
RUN PORT=3000 BASE_PATH=/ pnpm --filter @workspace/cinebot-app build

# Build API server bundle (esbuild → dist/index.mjs + pino workers)
RUN pnpm --filter @workspace/api-server build

# Place frontend static files inside api-server's dist so it can serve them
RUN cp -r artifacts/cinebot-app/dist/public artifacts/api-server/dist/public


# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-slim AS production

RUN npm install -g pnpm@10

WORKDIR /app

# Copy only the manifests we need for production install
COPY --from=builder /app/package.json              ./
COPY --from=builder /app/pnpm-workspace.yaml       ./
COPY --from=builder /app/pnpm-lock.yaml            ./
COPY --from=builder /app/artifacts/api-server/package.json  ./artifacts/api-server/
COPY --from=builder /app/artifacts/tg-bot/package.json      ./artifacts/tg-bot/
COPY --from=builder /app/lib/api-client-react/package.json  ./lib/api-client-react/
COPY --from=builder /app/lib/api-spec/package.json          ./lib/api-spec/
COPY --from=builder /app/lib/api-zod/package.json           ./lib/api-zod/
COPY --from=builder /app/lib/db/package.json                ./lib/db/

# Production deps only — skips devDependencies and cinebot-app (already compiled)
RUN pnpm install --no-frozen-lockfile --ignore-scripts --prod \
    --filter @workspace/api-server \
    --filter @workspace/tg-bot

# Compiled API server bundle (includes frontend static files at dist/public)
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist

# Bot source (pure ESM, no compile step needed)
COPY --from=builder /app/artifacts/tg-bot/src      ./artifacts/tg-bot/src

# Startup script
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Bot starts in background; API server is the foreground/main process
CMD ["./start.sh"]
