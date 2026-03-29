#!/bin/sh
set -e

if [ -z "$ICECAST_ADMIN_PASSWORD" ]; then
  ICECAST_ADMIN_PASSWORD=$(cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 16)
  export ICECAST_ADMIN_PASSWORD
fi

# Render base config from template
envsubst < /etc/icecast2/icecast.xml.tmpl > /etc/icecast2/icecast.xml

# Ensure mounts config dir exists (shared volume from api container)
mkdir -p /etc/icecast2/mounts

# Seed empty mounts file if not already written by the API
if [ ! -f /etc/icecast2/mounts/mounts.xml ]; then
  printf '<icecast>\n</icecast>\n' > /etc/icecast2/mounts/mounts.xml
fi

mkdir -p /var/log/icecast2 /var/run/icecast2
chown -R icecast2:icecast /var/log/icecast2 /var/run/icecast2 /etc/icecast2/mounts 2>/dev/null || true

echo "[icecast] admin-password: $ICECAST_ADMIN_PASSWORD"
echo "[icecast] hostname:       ${ICECAST_HOSTNAME:-localhost}"
echo "[icecast] per-mount config: /etc/icecast2/mounts/mounts.xml"

# Watch the mounts config file for changes and send SIGHUP to reload
watch_and_reload() {
  LAST=$(stat -c %Y /etc/icecast2/mounts/mounts.xml 2>/dev/null || echo 0)
  while true; do
    sleep 3
    NOW=$(stat -c %Y /etc/icecast2/mounts/mounts.xml 2>/dev/null || echo 0)
    if [ "$NOW" != "$LAST" ]; then
      LAST=$NOW
      PID=$(cat /var/run/icecast2/icecast.pid 2>/dev/null || echo '')
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "[icecast] mounts.xml changed — sending SIGHUP to reload"
        kill -HUP "$PID" 2>/dev/null || true
      fi
    fi
  done
}

watch_and_reload &

exec gosu icecast2 icecast2 -c /etc/icecast2/icecast.xml -d 0
