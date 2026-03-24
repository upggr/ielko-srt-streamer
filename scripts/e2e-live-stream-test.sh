#!/usr/bin/env bash
# End-to-end test: login → create SRT endpoint → ffmpeg publish → HLS + stats + pages → delete.
#
# Requires: curl, ffmpeg, python3 · Credentials: APP_PASSWORD in repo-root .env (or exported)
#
# Default source: Blender “Sintel” trailer (1080p H.264) over HTTPS. Override with E2E_SAMPLE_URL or -i.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Public 1080p sample (Blender Foundation; ffmpeg reads first --duration seconds only).
DEFAULT_SAMPLE_URL="https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4"

BASE_URL="${BASE_URL:-https://streams.ioniantv.gr}"
STREAM_SECS=30
KEEP=0
SAMPLE_URL="${E2E_SAMPLE_URL:-$DEFAULT_SAMPLE_URL}"

usage() {
  cat <<'EOF'
Usage: e2e-live-stream-test.sh [options]

  -u, --base-url URL   API / site base (default: https://streams.ioniantv.gr)
  -d, --duration SEC   Publish length in seconds (default: 30)
  -i, --input-url URL  Video source URL for ffmpeg (default: Sintel 1080p trailer)
  -k, --keep           Do not delete the created endpoint when finished
  -h, --help           Show this help

  Env: APP_PASSWORD (required), E2E_SAMPLE_URL (optional default input),
       BASE_URL (optional, same as -u)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -k|--keep) KEEP=1; shift ;;
    -d|--duration)
      STREAM_SECS="${2:?duration seconds required}"
      shift 2
      ;;
    -u|--base-url)
      BASE_URL="${2:?base URL required}"
      shift 2
      ;;
    -i|--input-url)
      SAMPLE_URL="${2:?input URL required}"
      shift 2
      ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
fi

if [[ -z "${APP_PASSWORD:-}" ]]; then
  echo "APP_PASSWORD is not set. Put it in .env or export it." >&2
  exit 1
fi

command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }

json_get() {
  local expr="$1"
  python3 -c "import sys,json; print(json.load(sys.stdin)${expr})"
}

TOKEN_JSON="$(curl -fsS -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":$(python3 -c "import json,os; print(json.dumps(os.environ['APP_PASSWORD']))")}")"

BEARER="$(echo "$TOKEN_JSON" | json_get "['token']")"
echo "login: ok"

NAME="e2e$(date +%s)"
CREATE_JSON="$(curl -fsS -X POST "${BASE_URL}/api/endpoints" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BEARER" \
  -d "{\"name\":\"$NAME\",\"protocol\":\"srt\"}")"

EP_ID="$(echo "$CREATE_JSON" | json_get "['id']")"
SENDER="$(echo "$CREATE_JSON" | json_get "['senderUrl']")"
HLS_URL="$(echo "$CREATE_JSON" | json_get "['hlsUrl']")"
WHEP_URL="$(echo "$CREATE_JSON" | json_get "['webrtcUrl']")"
VIEWER="$(echo "$CREATE_JSON" | json_get "['viewerUrl']")"
M3U_URL="$(echo "$CREATE_JSON" | json_get "['m3uUrl']")"

echo "endpoint: id=$EP_ID name=$NAME"
echo "publish: $SENDER"
echo "source:  $SAMPLE_URL (${STREAM_SECS}s)"

curl -fsS -X POST "${BASE_URL}/api/endpoints/${EP_ID}/start" \
  -H "Authorization: Bearer $BEARER" >/dev/null
echo "start: ok"

HLS_TMP="$(mktemp)"
FFPID=""

cleanup() {
  if [[ -n "$FFPID" ]] && kill -0 "$FFPID" 2>/dev/null; then
    kill "$FFPID" 2>/dev/null || true
    wait "$FFPID" 2>/dev/null || true
  fi
  rm -f "$HLS_TMP"
  if [[ "$KEEP" -eq 0 && -n "${EP_ID:-}" ]]; then
    curl -fsS -X DELETE "${BASE_URL}/api/endpoints/${EP_ID}" \
      -H "Authorization: Bearer $BEARER" >/dev/null && echo "delete: ok" || echo "delete: warning (failed)" >&2
  elif [[ "$KEEP" -eq 1 && -n "${EP_ID:-}" ]]; then
    echo "keeping endpoint $NAME (id=$EP_ID) — remove manually if needed"
  fi
}
trap cleanup EXIT

ffmpeg -hide_banner -loglevel error \
  -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
  -rw_timeout 20000000 \
  -re -i "$SAMPLE_URL" \
  -t "$STREAM_SECS" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 50 \
  -c:a aac -ar 48000 -ac 2 -b:a 128k \
  -f mpegts "$SENDER" &
FFPID=$!

HLS_OK=0
for i in $(seq 1 30); do
  sleep 2
  CODE="$(curl -sS -o "$HLS_TMP" -w "%{http_code}" "$HLS_URL" || true)"
  if [[ "$CODE" == "200" ]]; then
    HLS_OK=1
    echo "HLS: HTTP 200 (attempt $i)"
    head -20 "$HLS_TMP"
    # While the publisher is still running: stats + WHEP must see an active path
    STATS="$(curl -fsS "${BASE_URL}/api/endpoints/${EP_ID}/stream-stats" \
      -H "Authorization: Bearer $BEARER")"
    echo "stream-stats: $STATS"
    echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); \
      assert d.get('live') is True, 'stream-stats.live should be true while HLS is up'; \
      assert int(d.get('bytesReceived') or 0) > 0, 'stream-stats.bytesReceived should be > 0'" \
      || { echo "FAIL: stream-stats while live" >&2; exit 1; }
    WHEP_CODE="$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$WHEP_URL" \
      -H "Content-Type: application/sdp" -d "v=0" || echo "000")"
    echo "whep (invalid sdp): HTTP $WHEP_CODE (expect 400; not 404)"
    if [[ "$WHEP_CODE" == "404" ]]; then
      echo "FAIL: WHEP returned 404 while HLS was up" >&2
      exit 1
    fi
    break
  fi
  echo "HLS poll $i: HTTP $CODE"
done

if [[ "$HLS_OK" -ne 1 ]]; then
  echo "FAIL: HLS manifest never returned 200" >&2
  exit 1
fi

echo -n "watch: "
curl -fsS -o /dev/null -w "%{http_code}\n" "$VIEWER"
echo -n "embed: "
curl -fsS -o /dev/null -w "%{http_code}\n" "${BASE_URL}/embed/${NAME}"
echo -n "m3u: "
curl -fsS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $BEARER" "$M3U_URL"

wait "$FFPID" 2>/dev/null || true

echo "PASS"
