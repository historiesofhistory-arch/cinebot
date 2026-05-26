#!/bin/sh
# Start the Telegram bot in the background
node artifacts/tg-bot/src/bot.mjs &

# Start the API server in the foreground (main process — handles health checks)
node --enable-source-maps artifacts/api-server/dist/index.mjs
