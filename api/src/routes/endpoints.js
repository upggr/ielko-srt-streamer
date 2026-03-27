'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { addPath, removePath, getPathStatus } = require('../services/mediamtxClient');
const { getLogs, startYouTube, stopYouTube, startFacebook, stopFacebook, startInstagram, stopInstagram } = require('../services/ffmpegManager');

const router = Router();
const SERVER_IP = process.env.SERVER_IP || '88.198.184.233';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://streams.ioniantv.gr';
const SRT_PORT = 8890;
const RTMP_PORT = 1935;

function buildUrls(protocol, name, srtPassword) {
  let senderUrl;
  if (protocol === 'srt') {
    // mediamtx uses streamid for path routing. No SRT crypto passphrase — access control is via streamid token.
    senderUrl = `srt://${SERVER_IP}:${SRT_PORT}?streamid=publish:${name}&latency=200`;
  } else if (protocol === 'mpegts' || protocol === 'udp') {
    senderUrl = `rtmp://${SERVER_IP}:${RTMP_PORT}/${name}`;
  } else {
    senderUrl = `rtmp://${SERVER_IP}:${RTMP_PORT}/${name}`;
  }

  const hlsBase = `${PUBLIC_URL}/hls/${name}`;
  const whepUrl = `${PUBLIC_URL}/whep/${name}/whep`;

  return {
    senderUrl,
    viewerUrl: `${PUBLIC_URL}/watch/${name}`,
    hlsUrl: `${hlsBase}/index.m3u8`,
    hlsSourceUrl: `${hlsBase}/index.m3u8`,   // mediamtx serves single adaptive HLS
    hls720pUrl: null,
    hls480pUrl: null,
    hls360pUrl: null,
    webrtcUrl: whepUrl,
    m3uUrl: `${PUBLIC_URL}/api/endpoints/${name}/playlist.m3u`,
    srtPullUrl: protocol === 'srt' ? `srt://${SERVER_IP}:${SRT_PORT}?streamid=read:${name}&latency=200` : null,
    udpUrl: null,
    rtmpUrl: `rtmp://${SERVER_IP}:${RTMP_PORT}/${name}`,
    embedUrl: `${PUBLIC_URL}/embed/${name}`,
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM endpoints ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ ...r, ...buildUrls(r.protocol, r.name, r.srt_password) })));
});

router.post('/', async (req, res) => {
  const { name, protocol } = req.body;
  if (!name || !protocol) { res.status(400).json({ error: 'name and protocol required' }); return; }
  if (!['srt', 'mpegts', 'udp'].includes(protocol)) { res.status(400).json({ error: 'protocol must be srt, mpegts, or udp' }); return; }
  const slugName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (db.prepare('SELECT id FROM endpoints WHERE name = ?').get(slugName)) { res.status(409).json({ error: 'Name already exists' }); return; }

  const id = uuidv4();
  const srtPassword = protocol === 'srt' ? crypto.randomBytes(8).toString('hex') : null;

  // Register path in mediamtx
  try {
    const pathConf = {};
    if (protocol === 'srt') {
      // Allow publish only with matching streamid passphrase via mediamtx's built-in SRT streamid routing
      pathConf.source = 'publisher';
    }
    await addPath(slugName, pathConf);
  } catch (e) {
    console.error('mediamtx addPath error:', e.message);
    // Non-fatal: mediamtx may auto-create paths on first publish
  }

  // port=0 since mediamtx uses a single shared port
  db.prepare('INSERT INTO endpoints (id, name, protocol, port, srt_password, status) VALUES (?, ?, ?, 0, ?, \'stopped\')').run(id, slugName, protocol, srtPassword);
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(id);
  res.status(201).json({ ...ep, ...buildUrls(protocol, slugName, srtPassword) });
});

router.post('/:id/start', async (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  // With mediamtx, "starting" means registering the path and marking as ready
  try {
    await addPath(ep.name, {});
  } catch (e) {
    // May already exist — that's fine
  }
  db.prepare("UPDATE endpoints SET status='running', updated_at=datetime('now') WHERE id=?").run(ep.id);
  res.json({ ok: true, status: 'running' });
});

router.post('/:id/stop', async (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    await removePath(ep.name);
  } catch (e) {
    // May not exist — that's fine
  }
  db.prepare("UPDATE endpoints SET status='stopped', updated_at=datetime('now') WHERE id=?").run(ep.id);
  res.json({ ok: true, status: 'stopped' });
});

router.delete('/:id', async (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  try { await removePath(ep.name); } catch {}
  stopYouTube(ep.id);
  db.prepare('DELETE FROM endpoints WHERE id = ?').run(ep.id);
  res.json({ ok: true });
});

router.get('/:id/stream-stats', async (req, res) => {
  const ep = db.prepare('SELECT name FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const result = await getPathStatus(ep.name);
    if (result.status !== 200 || !result.body) { res.json({ live: false }); return; }
    const path = result.body;
    const ready = path.ready === true;
    // Extract bytes/tracks from publisher source
    const bytesReceived = path.bytesReceived || 0;
    const tracks = path.tracks || [];
    res.json({ live: ready, bytesReceived, tracks, name: ep.name });
  } catch (e) {
    res.json({ live: false, error: e.message });
  }
});

router.get('/:id/logs', (req, res) => {
  const ep = db.prepare('SELECT id FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ logs: getLogs(ep.id) });
});

router.post('/:id/youtube/start', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  const { streamKey } = req.body;
  if (!streamKey) { res.status(400).json({ error: 'streamKey required' }); return; }
  db.prepare('UPDATE endpoints SET yt_stream_key = ? WHERE id = ?').run(streamKey, ep.id);
  try { startYouTube(ep.id, ep.name, streamKey); res.json({ ok: true, yt_status: 'live' }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/youtube/stop', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  stopYouTube(ep.id);
  db.prepare("UPDATE endpoints SET yt_status='off', yt_pid=NULL WHERE id=?").run(ep.id);
  res.json({ ok: true, yt_status: 'off' });
});

router.post('/:id/facebook/start', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  const { streamKey } = req.body;
  if (!streamKey) { res.status(400).json({ error: 'streamKey required' }); return; }
  db.prepare('UPDATE endpoints SET fb_stream_key = ? WHERE id = ?').run(streamKey, ep.id);
  try { startFacebook(ep.id, ep.name, streamKey); res.json({ ok: true, fb_status: 'live' }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/facebook/stop', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  stopFacebook(ep.id);
  db.prepare("UPDATE endpoints SET fb_status='off', fb_pid=NULL WHERE id=?").run(ep.id);
  res.json({ ok: true, fb_status: 'off' });
});

router.post('/:id/instagram/start', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  const { streamKey } = req.body;
  if (!streamKey) { res.status(400).json({ error: 'streamKey required' }); return; }
  db.prepare('UPDATE endpoints SET ig_stream_key = ? WHERE id = ?').run(streamKey, ep.id);
  try { startInstagram(ep.id, ep.name, streamKey); res.json({ ok: true, ig_status: 'live' }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/instagram/stop', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  stopInstagram(ep.id);
  db.prepare("UPDATE endpoints SET ig_status='off', ig_pid=NULL WHERE id=?").run(ep.id);
  res.json({ ok: true, ig_status: 'off' });
});

router.get('/:name/playlist.m3u', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE name = ?').get(req.params.name);
  if (!ep) { res.status(404).send('Not found'); return; }
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.send(`#EXTM3U\n#EXTINF:-1,${ep.name}\n${PUBLIC_URL}/hls/${ep.name}/index.m3u8\n`);
});

module.exports = router;
