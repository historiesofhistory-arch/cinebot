FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./

RUN npm install --omit=dev --ignore-scripts

COPY src/ ./src/

ENV NODE_ENV=production

CMD ["node", "src/bot.mjs"]
