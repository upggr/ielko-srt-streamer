'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { allocatePort } = require('../services/portManager');
const { startEndpoint, stopEndpoint, getLogs, startYouTube, stopYouTube } = require('../services/ffmpegManager');

const router = Router();
const SERVER_IP = process.env.SERVER_IP || '88.198.184.233';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://streams.ioniantv.gr';

function buildUrls(protocol, port, name, srtPassword) {
  const senderUrl = protocol === 'srt'
    ? `srt://${SERVER_IP}:${port}?passphrase=${srtPassword}`
    : `udp://${SERVER_IP}:${port}`;
  return {
    senderUrl,
    viewerUrl: `${PUBLIC_URL}/watch/${name}`,
    hlsUrl: `${PUBLIC_URL}/hls/${name}/master.m3u8`,
    hlsSourceUrl: `${PUBLIC_URL}/hls/${name}/v0/index.m3u8`,
    hls720pUrl: `${PUBLIC_URL}/hls/${name}/v1/index.m3u8`,
    hls480pUrl: `${PUBLIC_URL}/hls/${name}/v2/index.m3u8`,
    hls360pUrl: `${PUBLIC_URL}/hls/${name}/v3/index.m3u8`,
    m3uUrl: `${PUBLIC_URL}/api/endpoints/${name}/playlist.m3u`,
    srtPullUrl: protocol === 'srt' ? `srt://${SERVER_IP}:${port}?passphrase=${srtPassword}&mode=caller` : null,
    udpUrl: protocol !== 'srt' ? `udp://${SERVER_IP}:${port}` : null,
    embedUrl: `${PUBLIC_URL}/embed/${name}`,
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM endpoints ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ ...r, ...buildUrls(r.protocol, r.port, r.name, r.srt_password) })));
});

router.post('/', (req, res) => {
  const { name, protocol } = req.body;
  if (!name || !protocol) { res.status(400).json({ error: 'name and protocol required' }); return; }
  if (!['srt', 'mpegts', 'udp'].includes(protocol)) { res.status(400).json({ error: 'protocol must be srt, mpegts, or udp' }); return; }
  const slugName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (db.prepare('SELECT id FROM endpoints WHERE name = ?').get(slugName)) { res.status(409).json({ error: 'Name already exists' }); return; }
  let port;
  try { port = allocatePort(); } catch { res.status(503).json({ error: 'No available ports' }); return; }
  const id = uuidv4();
  const srtPassword = protocol === 'srt' ? crypto.randomBytes(8).toString('hex') : null;
  db.prepare('INSERT INTO endpoints (id, name, protocol, port, srt_password) VALUES (?, ?, ?, ?, ?)').run(id, slugName, protocol, port, srtPassword);
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(id);
  res.status(201).json({ ...ep, ...buildUrls(protocol, port, slugName, srtPassword) });
});

router.post('/:id/start', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  try { startEndpoint(ep.id, ep.name, ep.protocol, ep.port, ep.srt_password); res.json({ ok: true, status: 'running' }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/stop', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  stopEndpoint(ep.id);
  db.prepare("UPDATE endpoints SET status='stopped', ffmpeg_pid=NULL, updated_at=datetime('now') WHERE id=?").run(ep.id);
  res.json({ ok: true, status: 'stopped' });
});

router.delete('/:id', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  stopEndpoint(ep.id);
  db.prepare('DELETE FROM endpoints WHERE id = ?').run(ep.id);
  res.json({ ok: true });
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

router.get('/:name/playlist.m3u', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE name = ?').get(req.params.name);
  if (!ep) { res.status(404).send('Not found'); return; }
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.send(`#EXTM3U\n#EXTINF:-1,${ep.name}\n${PUBLIC_URL}/hls/${ep.name}/master.m3u8\n`);
});

module.exports = router;
