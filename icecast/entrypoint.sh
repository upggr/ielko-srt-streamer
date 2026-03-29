#!/bin/sh
set -e

# Generate passwords if not set
if [ -z "$ICECAST_SOURCE_PASSWORD" ]; then
  ICECAST_SOURCE_PASSWORD=$(cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 16)
  export ICECAST_SOURCE_PASSWORD
fi
if [ -z "$ICECAST_ADMIN_PASSWORD" ]; then
  ICECAST_ADMIN_PASSWORD=$(cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 16)
  export ICECAST_ADMIN_PASSWORD
fi

# Render config from template
envsubst < /etc/icecast2/icecast.xml.tmpl > /etc/icecast2/icecast.xml

mkdir -p /var/log/icecast2 /var/run/icecast2
chown -R icecast2:icecast /var/log/icecast2 /var/run/icecast2 2>/dev/null || true

echo "[icecast] source-password: $ICECAST_SOURCE_PASSWORD"
echo "[icecast] admin-password:  $ICECAST_ADMIN_PASSWORD"
echo "[icecast] hostname:        ${ICECAST_HOSTNAME:-localhost}"

# Run as icecast2 user, foreground (-d 0 disables daemonize)
exec gosu icecast2 icecast2 -c /etc/icecast2/icecast.xml -d 0
