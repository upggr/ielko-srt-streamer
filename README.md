# UPG Stream Control

Self-hosted live streaming control panel. Accepts SRT/RTMP streams and restreams to YouTube, Facebook, Instagram. Includes HLS/WebRTC playback, adaptive bitrate transcoding, and a web UI.

## Quick Start

```bash
cp .env.example .env
# Edit .env and set your LICENSE_KEY
docker compose up -d
```

Then open `http://<your-server-ip>:3000` in a browser.

On first boot the app auto-generates `APP_PASSWORD`, `SESSION_SECRET`, and detects `SERVER_IP`. The password is printed once in the container logs:

```bash
docker compose logs api | grep APP_PASSWORD
```

## Firewall / Port Requirements

Open these ports on your server firewall before deploying:

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 3000 | TCP | Inbound | Web UI + API |
| 8890 | UDP | Inbound | SRT stream ingest |
| 1935 | TCP | Inbound | RTMP stream ingest |
| 80   | TCP | Inbound | SSL certificate (Caddy / Let's Encrypt) |
| 443  | TCP | Inbound | HTTPS — only needed if SSL is configured |

> Ports 8888 (HLS), 8889 (WebRTC), and 9997 (mediamtx API) are internal only and must **not** be exposed.

### Hetzner example (using `hcloud` CLI)

```bash
hcloud firewall create --name stream-fw
hcloud firewall add-rule stream-fw --direction in --protocol tcp --port 3000
hcloud firewall add-rule stream-fw --direction in --protocol udp --port 8890
hcloud firewall add-rule stream-fw --direction in --protocol tcp --port 1935
hcloud firewall add-rule stream-fw --direction in --protocol tcp --port 80
hcloud firewall add-rule stream-fw --direction in --protocol tcp --port 443
hcloud firewall apply-to-server stream-fw --server <your-server-id>
```

### UFW example

```bash
ufw allow 3000/tcp
ufw allow 8890/udp
ufw allow 1935/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LICENSE_KEY` | **Yes** | License key from services.buy-it.gr |
| `APP_PASSWORD` | No | UI login password — auto-generated on first boot |
| `SESSION_SECRET` | No | Session signing secret — auto-generated on first boot |
| `SERVER_IP` | No | Public IP — auto-detected on first boot |
| `PUBLIC_URL` | No | Public base URL — derived from SERVER_IP on first boot |
| `LICENSE_VALIDATE_URL` | No | Override license validation endpoint |

## Domain & SSL

After first boot, go to **Settings** in the UI to configure a custom domain. The UI will generate the Caddy install command for you.

Manual steps:
1. Point your domain A record to `SERVER_IP`
2. Enter the domain in Settings → Save
3. Copy the Caddy command and run it on your server

## Architecture

| Service | Role |
|---------|------|
| `api` | Node.js app — web UI, REST API, ffmpeg orchestration |
| `mediamtx` | SRT/RTMP ingest, HLS output, WebRTC/WHEP |
| `hls-nginx` | Serves ABR HLS segments (adaptive bitrate streams) |

## Supported Platforms

- amd64 (x86_64) — Hetzner CCX/CPX series, bare metal AX
- arm64 — Hetzner CAX series (Ampere)

Both are supported — the base image (`node:20-slim`) and `mediamtx` publish multi-arch images. The `ffmpeg` apt package is available for both architectures on Debian slim.
