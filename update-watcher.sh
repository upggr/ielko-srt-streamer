#!/bin/bash
# update-watcher.sh — runs on the HOST via cron, watches for update.flag written by the API container
# Install: add to /etc/cron.d/srt-streamer or run as a systemd timer
#
# Example cron entry (checks every 30 seconds via two cron lines):
#   * * * * * root /opt/srt-streamer/update-watcher.sh >> /var/log/srt-updater.log 2>&1
#   * * * * * root sleep 30 && /opt/srt-streamer/update-watcher.sh >> /var/log/srt-updater.log 2>&1

set -e
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
FLAG="$REPO_DIR/update.flag"

if [ ! -f "$FLAG" ]; then
  exit 0
fi

echo "[$(date)] Update flag detected — starting update"
rm -f "$FLAG"

cd "$REPO_DIR"
git pull
BUILD_SHA=$(git rev-parse --short HEAD) docker compose up -d --build api
echo "[$(date)] Update complete — running SHA: $(git rev-parse --short HEAD)"
