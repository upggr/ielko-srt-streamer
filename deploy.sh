#!/bin/bash
# Deploy script for 157.90.171.7
# Run from project root: ./deploy.sh

SERVER="root@157.90.171.7"
REMOTE_DIR="/opt/srt-streamer"

echo "==> Syncing files to server..."
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='*.db' \
  ./ ${SERVER}:${REMOTE_DIR}/

echo "==> Setting up .env on server (if not exists)..."
ssh ${SERVER} "[ -f ${REMOTE_DIR}/.env ] || cp ${REMOTE_DIR}/.env.example ${REMOTE_DIR}/.env && echo 'Created .env - EDIT IT NOW with your password'"

echo "==> Checking SSL cert..."
ssh ${SERVER} "ls /etc/letsencrypt/live/streams.upg.gr/ 2>/dev/null || echo 'WARNING: SSL cert not found. Run: certbot certonly --standalone -d streams.upg.gr'"

echo "==> Opening firewall ports..."
ssh ${SERVER} "ufw allow 666/tcp && ufw allow 10000:11000/udp || true"

echo "==> Building and starting containers..."
ssh ${SERVER} "cd ${REMOTE_DIR} && docker compose pull && docker compose up -d --build"

echo "==> Done! Check status with: ssh ${SERVER} 'cd ${REMOTE_DIR} && docker compose ps'"
