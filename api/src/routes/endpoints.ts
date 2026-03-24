import { Router } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { allocatePort } from '../services/portManager';
import { startEndpoint, stopEndpoint, getLogs, startYouTube, stopYouTube } from '../services/ffmpegManager';

const router = Router();

const SERVER_IP = process.env.SERVER_IP || '157.90.171.7';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://streams.upg.gr:666';

function buildUrls(protocol: string, port: number, name: string, srtPassword?: string | null) {
  let senderUrl: string;
  if (protocol === 'srt') {
    senderUrl = `srt://${SERVER_IP}:${port}?passphrase=${srtPassword}`;
  } else {
    senderUrl = `udp://${SERVER_IP}:${port}`;
  }

  const viewerUrl = `${PUBLIC_URL}/watch/${name}`;

  // All output URLs
  const urls = {
    senderUrl,
    viewerUrl,
    // HLS master playlist (multi-bitrate: source/720p/480p/360p)
    hlsUrl: `${PUBLIC_URL}/hls/${name}/master.m3u8`,
    // Individual rendition fallbacks
    hlsSourceUrl: `${PUBLIC_URL}/hls/${name}/v0/index.m3u8`,
    hls720pUrl: `${PUBLIC_URL}/hls/${name}/v1/index.m3u8`,
    hls480pUrl: `${PUBLIC_URL}/hls/${name}/v2/index.m3u8`,
    hls360pUrl: `${PUBLIC_URL}/hls/${name}/v3/index.m3u8`,
    // M3U playlist — for VLC, IPTV players, Kodi, mobile apps
    m3uUrl: `${PUBLIC_URL}/api/endpoints/${name}/playlist.m3u`,
    // Direct SRT pull — VLC, OBS, ffplay, mpv (caller mode)
    srtPullUrl: protocol === 'srt'
      ? `srt://${SERVER_IP}:${port}?passphrase=${srtPassword}&mode=caller`
      : null,
    // Direct UDP — VLC, ffplay, mpv
    udpUrl: protocol !== 'srt' ? `udp://${SERVER_IP}:${port}` : null,
    // Embeddable iframe player
    embedUrl: `${PUBLIC_URL}/embed/${name}`,
  };

  return urls;
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM endpoints ORDER BY created_at DESC').all();
  const result = (rows as any[]).map(r => ({
    ...r,
    ...buildUrls(r.protocol, r.port, r.name, r.srt_password)
  }));
  res.json(result);
});

router.post('/', (req, res) => {
  const { name, protocol } = req.body;

  if (!name || !protocol) {
    res.status(400).json({ error: 'name and protocol required' });
    return;
  }

  if (!['srt', 'mpegts', 'udp'].includes(protocol)) {
    res.status(400).json({ error: 'protocol must be srt, mpegts, or udp' });
    return;
  }

  const slugName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  const existing = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(slugName);
  if (existing) {
    res.status(409).json({ error: 'Name already exists' });
    return;
  }

  let port: number;
  try {
    port = allocatePort();
  } catch (e) {
    res.status(503).json({ error: 'No available ports' });
    return;
  }

  const id = uuidv4();
  const srtPassword = protocol === 'srt'
    ? crypto.randomBytes(8).toString('hex')
    : null;

  db.prepare(
    'INSERT INTO endpoints (id, name, protocol, port, srt_password) VALUES (?, ?, ?, ?, ?)'
  ).run(id, slugName, protocol, port, srtPassword);

  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(id) as any;
  res.status(201).json({
    ...endpoint,
    ...buildUrls(protocol, port, slugName, srtPassword)
  });
});

router.post('/:id/start', (req, res) => {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id) as any;
  if (!endpoint) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    startEndpoint(endpoint.id, endpoint.name, endpoint.protocol, endpoint.port, endpoint.srt_password);
    res.json({ ok: true, status: 'running' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/stop', (req, res) => {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id) as any;
  if (!endpoint) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  stopEndpoint(endpoint.id);
  db.prepare("UPDATE endpoints SET status = 'stopped', ffmpeg_pid = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(endpoint.id);
  res.json({ ok: true, status: 'stopped' });
});

router.delete('/:id', (req, res) => {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id) as any;
  if (!endpoint) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  stopEndpoint(endpoint.id);
  db.prepare('DELETE FROM endpoints WHERE id = ?').run(endpoint.id);
  res.json({ ok: true });
});

// Logs (last 200 lines from ffmpeg)
router.get('/:id/logs', (req, res) => {
  const endpoint = db.prepare('SELECT id FROM endpoints WHERE id = ?').get(req.params.id) as any;
  if (!endpoint) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ logs: getLogs(endpoint.id) });
});

// YouTube restream
router.post('/:id/youtube/start', (req, res) => {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id) as any;
  if (!endpoint) { res.status(404).json({ error: 'Not found' }); return; }
  const { streamKey } = req.body;
  if (!streamKey) { res.status(400).json({ error: 'streamKey required' }); return; }

  // Save stream key
  db.prepare('UPDATE endpoints SET yt_stream_key = ? WHERE id = ?').run(streamKey, endpoint.id);

  try {
    startYouTube(endpoint.id, endpoint.name, streamKey);
    res.json({ ok: true, yt_status: 'live' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/youtube/stop', (req, res) => {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id) as any;
  if (!endpoint) { res.status(404).json({ error: 'Not found' }); return; }
  stopYouTube(endpoint.id);
  db.prepare("UPDATE endpoints SET yt_status = 'off', yt_pid = NULL WHERE id = ?").run(endpoint.id);
  res.json({ ok: true, yt_status: 'off' });
});

// M3U playlist for VLC/IPTV players (no auth, URL is unguessable via name)
router.get('/:name/playlist.m3u', (req, res) => {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE name = ?').get(req.params.name) as any;
  if (!endpoint) { res.status(404).send('Not found'); return; }
  const hlsUrl = `${PUBLIC_URL}/hls/${endpoint.name}/master.m3u8`;
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.send(`#EXTM3U\n#EXTINF:-1,${endpoint.name}\n${hlsUrl}\n`);
});

export default router;
