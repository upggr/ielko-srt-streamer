FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    procps \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (better-sqlite3 needs native build)
COPY api/package.json ./
RUN npm install --omit=dev

# Copy source and UI
COPY api/src ./src
COPY ui ./ui

RUN mkdir -p /data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
