# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests first (layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/cinebot-app/package.json ./artifacts/cinebot-app/
COPY lib/ ./lib/

# Install all dependencies
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Copy full source
COPY . .

# Build the React frontend (BASE_PATH=/ so assets load from /)
RUN PORT=3000 BASE_PATH=/ pnpm --filter @workspace/cinebot-app build

# Build the API server bundle (esbuild → dist/index.mjs + assets)
RUN pnpm --filter @workspace/api-server build

# Copy frontend static files into the API server's dist/public directory
RUN cp -r artifacts/cinebot-app/dist/public artifacts/api-server/dist/public


# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-slim AS production

RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests from builder (avoids missing-file errors from build context)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/artifacts/api-server/package.json ./artifacts/api-server/
COPY --from=builder /app/artifacts/tg-bot/package.json ./artifacts/tg-bot/
COPY --from=builder /app/lib/ ./lib/

# Install production dependencies for both the API server and the bot
RUN pnpm install --no-frozen-lockfile --ignore-scripts --prod \
    --filter @workspace/api-server \
    --filter @workspace/tg-bot

# Copy the compiled API bundle (includes frontend static files)
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist

# Copy the bot source (no build step needed)
COPY --from=builder /app/artifacts/tg-bot/src ./artifacts/tg-bot/src

# Copy startup script
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Startup: bot runs in background, API server is the main process
CMD ["./start.sh"]
