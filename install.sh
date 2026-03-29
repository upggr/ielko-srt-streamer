#!/bin/bash
# install.sh — one-command provisioning for a fresh Ubuntu/Debian server
# Usage: curl -fsSL https://raw.githubusercontent.com/upggr/ielko-srt-streamer/main/install.sh | bash -s -- YOUR_LICENSE_KEY
set -e

LICENSE_KEY="${1:-}"
INSTALL_DIR="/opt/srt-streamer"
REPO="https://github.com/upggr/ielko-srt-streamer.git"

if [ -z "$LICENSE_KEY" ]; then
  echo "Usage: curl ... | bash -s -- YOUR_LICENSE_KEY"
  exit 1
fi

echo "=== UPG Stream Control — Install ==="

# 1. Install Docker
if ! command -v docker &>/dev/null; then
  echo "[1/5] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$USER" || true
else
  echo "[1/5] Docker already installed"
fi

# 2. Install git and speedtest-cli
if ! command -v git &>/dev/null || ! command -v speedtest-cli &>/dev/null; then
  echo "[2/5] Installing git + speedtest-cli..."
  apt-get update -qq && apt-get install -y -qq git speedtest-cli
else
  echo "[2/5] git + speedtest-cli already installed"
fi

# 3. Clone repo
echo "[3/5] Cloning repo to $INSTALL_DIR..."
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR" && git pull
else
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 4. Write .env
echo "[4/5] Writing .env..."
ICECAST_SOURCE_PASSWORD=$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' | head -c 16 || openssl rand -hex 8)
ICECAST_ADMIN_PASSWORD=$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' | head -c 16 || openssl rand -hex 8)
cat > "$INSTALL_DIR/.env" <<EOF
LICENSE_KEY=$LICENSE_KEY
ICECAST_SOURCE_PASSWORD=$ICECAST_SOURCE_PASSWORD
ICECAST_ADMIN_PASSWORD=$ICECAST_ADMIN_PASSWORD
EOF

# 5. Start containers
echo "[5/5] Starting containers..."
cd "$INSTALL_DIR"
BUILD_SHA=$(git rev-parse --short HEAD) docker compose up -d --build

# 6. Install update watcher cron
echo "[6/6] Installing update watcher..."
chmod +x "$INSTALL_DIR/update-watcher.sh"
cat > /etc/cron.d/srt-streamer <<EOF
* * * * * root $INSTALL_DIR/update-watcher.sh >> /var/log/srt-updater.log 2>&1
* * * * * root sleep 30 && $INSTALL_DIR/update-watcher.sh >> /var/log/srt-updater.log 2>&1
0 2 * * * root speedtest-cli --json > $INSTALL_DIR/.speedtest.json 2>/dev/null
EOF

# Run initial speedtest in background (non-blocking)
speedtest-cli --json > "$INSTALL_DIR/.speedtest.json" 2>/dev/null &

echo ""
echo "=== Install complete ==="
echo ""
echo "The app will be available at: http://$(curl -s ifconfig.me):3000"
echo ""
echo "Initial password (retrieve from logs):"
docker compose -f "$INSTALL_DIR/docker-compose.yaml" logs api 2>/dev/null | grep APP_PASSWORD || echo "  Run: docker compose -f $INSTALL_DIR/docker-compose.yaml logs api | grep APP_PASSWORD"
