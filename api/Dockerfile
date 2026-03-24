FROM node:20-slim AS build

WORKDIR /app
# Context is the repo root; api/ contains the node project
COPY api/package.json api/package-lock.json* api/tsconfig.json ./
RUN npm install
COPY api/src ./src
RUN npm run build

# -------

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
# ui is at repo root
COPY ui ./ui

RUN mkdir -p /data /hls

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
