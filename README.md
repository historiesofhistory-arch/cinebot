# 🎬 CineBot

A Telegram bot + streaming web app that lets users watch movies and series free, inside Telegram — no ads, no redirects.

## Architecture

```
pnpm monorepo
├── artifacts/
│   ├── api-server/     Express API + static file server (built with esbuild)
│   ├── cinebot-app/    React + Vite player web app (served by api-server in prod)
│   └── tg-bot/         Telegram bot (grammY)
└── Dockerfile          Multi-stage build → single deployable image
```

In production the **api-server** serves the React frontend as static files and runs alongside the **Telegram bot** (started by `start.sh`).

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ Required | Get from [@BotFather](https://t.me/BotFather) on Telegram |
| `TMDB_API_KEY` | ⚠️ Optional | [themoviedb.org](https://www.themoviedb.org/settings/api) free account. Only needed for Trending, Popular, and Genre browse. Search uses the free IMDB suggestion API — no key needed. |
| `PLAYER_URL` | ✅ Required | Full URL of your deployed service (e.g. `https://your-app.onrender.com/cinebot-app/`). The bot uses this to build the Watch links it sends to users. |
| `PORT` | Optional | HTTP port for the API server. Defaults to `8080`. Render sets this automatically to `10000`. |
| `NODE_ENV` | Optional | Set to `production` in Docker/Render (already in Dockerfile). |

### What works without TMDB_API_KEY

- ✅ `/movie <title>` — search via free IMDB API
- ✅ `/series <title>` — search via free IMDB API
- ✅ `/search <title>` — search via free IMDB API
- ✅ Plain text search in chat
- ✅ Movie/series detail cards (via free Cinemeta/Stremio API)
- ❌ `/trending` — needs TMDB key
- ❌ `/popular` — needs TMDB key
- ❌ `/popular_series` — needs TMDB key
- ❌ `/genres` — needs TMDB key

---

## Deploy to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your GitHub repo — Render will read `render.yaml` automatically
4. Set the secret environment variables when prompted:
   - `TELEGRAM_BOT_TOKEN`
   - `TMDB_API_KEY` (optional)
   - `PLAYER_URL` → set this **after** your first deploy once you know the Render URL

> **Tip:** After first deploy, copy the `https://your-app.onrender.com` URL, set it as `PLAYER_URL` (add `/cinebot-app/` at the end), then redeploy.

---

## Deploy with Docker (any server)

```bash
# Build
docker build -t cinebot .

# Run
docker run -d \
  -p 8080:8080 \
  -e TELEGRAM_BOT_TOKEN=your_token_here \
  -e TMDB_API_KEY=your_key_here \
  -e PLAYER_URL=https://your-domain.com/cinebot-app/ \
  --name cinebot \
  cinebot
```

Health check: `GET /api/health`

---

## Local Development (Replit or any machine with pnpm)

```bash
pnpm install

# Copy and fill in your secrets
cp .env.example .env

# Start all services in separate terminals:
pnpm --filter @workspace/api-server run dev       # API server → :8080
pnpm --filter @workspace/cinebot-app run dev      # Vite dev server → :23175
pnpm --filter @workspace/tg-bot run start         # Telegram bot
```

---

## Tech Stack

| Layer | Tech |
|---|---|
| Bot framework | [grammY](https://grammy.dev) + @grammyjs/runner (concurrent) |
| Movie search | [IMDB suggestion API](https://v2.sg.media-imdb.com/suggests/) (free, no key) |
| Movie metadata | [Cinemeta / Stremio](https://cinemeta.strem.io) (free, no key) |
| Trending/Browse | [TMDB API](https://www.themoviedb.org/) (free key) |
| Frontend | React 18 + Vite + Vidstack player |
| API server | Express 5 + esbuild bundle |
| Container | Docker multi-stage (Node 20 slim) |
