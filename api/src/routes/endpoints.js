'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { addPath, removePath, getPathStatus } = require('../services/mediamtxClient');
const { getLogs, startYouTube, stopYouTube, startFacebook, stopFacebook, startInstagram, stopInstagram, startTranscode, stopTranscode } = require('../services/ffmpegManager');
const { getState: getLicenseState } = require('../services/licenseGuard');
const { withPlanLimits } = require('../services/mediamtxPathConfig');
const { rewriteMountsConfig } = require('../services/icecastManager');

const router = Router();
const SERVER_IP = process.env.SERVER_IP || '127.0.0.1';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const PUBLIC_URL = process.env.PUBLIC_URL || (PUBLIC_HOST ? `https://${PUBLIC_HOST}` : '');
const SRT_PORT = 8890;
const RTMP_PORT = 1935;
const ICECAST_PORT = 8000;

function buildUrls(protocol, name, srtPassword, transcodeEnabled, rtmpPassword, icecastSourcePassword) {
  if (protocol === 'icecast') {
    const pass = icecastSourcePassword || null;
    const sourceUrl = pass
      ? `icecast://source:${pass}@${SERVER_IP}:${ICECAST_PORT}/${name}`
      : `icecast://source:<password>@${SERVER_IP}:${ICECAST_PORT}/${name}`;
    const listenUrl = PUBLIC_URL
      ? `${PUBLIC_URL.replace(/\/$/, '')}/${name}`
      : `http://${SERVER_IP}:${ICECAST_PORT}/${name}`;
    return {
      senderUrl: sourceUrl,
      viewerUrl: listenUrl,
      icecastListenUrl: listenUrl,
      hlsUrl: null, hlsSourceUrl: null, hls720pUrl: null, hls480pUrl: null, hls360pUrl: null,
      webrtcUrl: null, m3uUrl: null, srtPullUrl: null, udpUrl: null, rtmpUrl: null, embedUrl: null,
    };
  }

  let senderUrl;
  if (protocol === 'srt') {
    const passphraseParam = srtPassword ? `&passphrase=${encodeURIComponent(srtPassword)}&pbkeylen=16` : '';
    senderUrl = `srt://${SERVER_IP}:${SRT_PORT}?streamid=publish:${name}&latency=200${passphraseParam}`;
  } else if (rtmpPassword) {
    senderUrl = `rtmp://stream:${rtmpPassword}@${SERVER_IP}:${RTMP_PORT}/${name}`;
  } else {
    senderUrl = `rtmp://${SERVER_IP}:${RTMP_PORT}/${name}`;
  }

  const hlsBase = `${PUBLIC_URL}/hls/${name}`;
  const whepUrl = `${PUBLIC_URL}/whep/${name}/whep`;
  const abr = !!transcodeEnabled;

  return {
    senderUrl,
    viewerUrl: `${PUBLIC_URL}/watch/${name}`,
    hlsUrl: abr ? `${hlsBase}/master.m3u8` : `${hlsBase}/index.m3u8`,
    hlsSourceUrl: `${hlsBase}/index.m3u8`,
    hls720pUrl: abr ? `${hlsBase}/v0/index.m3u8` : null,
    hls480pUrl: abr ? `${hlsBase}/v1/index.m3u8` : null,
    hls360pUrl: abr ? `${hlsBase}/v2/index.m3u8` : null,
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
  res.json(rows.map(r => ({ ...r, ...buildUrls(r.protocol, r.name, r.srt_password, r.transcode_enabled, r.rtmp_password, r.icecast_source_password) })));
});

router.post('/', async (req, res) => {
  const lic = getLicenseState();
  const maxEndpoints =
    typeof lic.streams === 'number' && lic.streams > 0 ? lic.streams : 1;
  const { c: endpointCount } = db.prepare('SELECT COUNT(*) AS c FROM endpoints').get();
  if (endpointCount >= maxEndpoints) {
    return res.status(403).json({
      error: `Endpoint limit reached (${maxEndpoints} for your plan). Delete an endpoint or upgrade.`,
      limit: maxEndpoints,
      plan: lic.plan || null,
    });
  }

  const { name, protocol, sourceMode, sourceUrl } = req.body;
  if (!name || !protocol) { res.status(400).json({ error: 'name and protocol required' }); return; }
  if (!['srt', 'mpegts', 'udp', 'rtmp', 'rtsp', 'hls', 'icecast'].includes(protocol)) {
    res.status(400).json({ error: 'protocol must be srt, mpegts, udp, rtmp, rtsp, hls, or icecast' }); return;
  }
  const mode = sourceMode === 'pull' ? 'pull' : 'push';
  if (mode === 'pull' && !sourceUrl) { res.status(400).json({ error: 'sourceUrl required for pull mode' }); return; }

  const slugName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (db.prepare('SELECT id FROM endpoints WHERE name = ?').get(slugName)) { res.status(409).json({ error: 'Name already exists' }); return; }

  const id = uuidv4();
  const srtPassword = protocol === 'srt' && mode === 'push' ? crypto.randomBytes(8).toString('hex') : null;
  const rtmpPassword = protocol === 'rtmp' && mode === 'push' ? crypto.randomBytes(8).toString('hex') : null;
  const icecastSourcePassword = protocol === 'icecast' ? crypto.randomBytes(10).toString('hex') : null;

  if (protocol === 'icecast') {
    // Icecast push: register mount in icecast config
    // Icecast pull (relay): store relay URL — icecast config will include a relay block
    db.prepare('INSERT INTO endpoints (id, name, protocol, port, icecast_source_password, status, source_mode, source_url) VALUES (?, ?, ?, 0, ?, \'stopped\', ?, ?)').run(id, slugName, protocol, icecastSourcePassword, mode, sourceUrl || null);
    rewriteMountsConfig();
  } else {
    try {
      const pathConf = mode === 'pull' ? { source: sourceUrl } : {};
      const auth = { protocol, mode, srtPassword, rtmpPassword };
      await addPath(slugName, withPlanLimits(getLicenseState().plan, pathConf, auth));
    } catch (e) {
      console.error('mediamtx addPath error:', e.message);
    }
    db.prepare('INSERT INTO endpoints (id, name, protocol, port, srt_password, rtmp_password, status, source_mode, source_url) VALUES (?, ?, ?, 0, ?, ?, \'stopped\', ?, ?)').run(id, slugName, protocol, srtPassword, rtmpPassword, mode, sourceUrl || null);
  }

  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(id);
  res.status(201).json({ ...ep, ...buildUrls(protocol, slugName, srtPassword, ep.transcode_enabled, rtmpPassword, icecastSourcePassword) });
});

router.post('/:id/start', async (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  if (ep.protocol !== 'icecast') {
    try {
      const auth = { protocol: ep.protocol, mode: ep.source_mode, srtPassword: ep.srt_password, rtmpPassword: ep.rtmp_password };
      await addPath(ep.name, withPlanLimits(getLicenseState().plan, {}, auth));
    } catch (e) {
      // May already exist — that's fine
    }
  }
  db.prepare("UPDATE endpoints SET status='running', updated_at=datetime('now') WHERE id=?").run(ep.id);
  res.json({ ok: true, status: 'running' });
});

router.post('/:id/stop', async (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  if (ep.protocol !== 'icecast') {
    try {
      await removePath(ep.name);
    } catch (e) {
      // May not exist — that's fine
    }
  }
  db.prepare("UPDATE endpoints SET status='stopped', updated_at=datetime('now') WHERE id=?").run(ep.id);
  res.json({ ok: true, status: 'stopped' });
});

router.delete('/:id', async (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  if (ep.protocol !== 'icecast') {
    try { await removePath(ep.name); } catch {}
    stopYouTube(ep.id);
  }
  db.prepare('DELETE FROM endpoints WHERE id = ?').run(ep.id);
  if (ep.protocol === 'icecast') rewriteMountsConfig();
  res.json({ ok: true });
});

router.get('/:id/stream-stats', async (req, res) => {
  const ep = db.prepare('SELECT name, protocol FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }

  // Icecast endpoints: check Icecast status API directly
  if (ep.protocol === 'icecast') {
    try {
      const ICECAST_API = process.env.ICECAST_API || `http://icecast:${ICECAST_PORT}`;
      const r = await fetch(`${ICECAST_API}/status-json.xsl`);
      if (!r.ok) { res.json({ live: false }); return; }
      const data = await r.json();
      const sources = data?.icestats?.source;
      const sourceList = Array.isArray(sources) ? sources : (sources ? [sources] : []);
      const mount = `/${ep.name}`;
      const source = sourceList.find(s => s.listenurl && s.listenurl.endsWith(mount));
      const live = !!source;
      // Icecast doesn't expose cumulative bytes; use a monotonically increasing
      // estimate based on bitrate × elapsed time so the UI can compute kbps.
      let bytesReceived = 0;
      if (live && source.stream_start_iso8601) {
        const elapsed = (Date.now() - new Date(source.stream_start_iso8601).getTime()) / 1000;
        const bitrateKbps = 128; // matches ffmpeg encoding bitrate
        bytesReceived = Math.round((bitrateKbps * 1000 / 8) * elapsed);
      }
      res.json({ live, bytesReceived, listeners: source?.listeners || 0, tracks: [], name: ep.name });
    } catch (e) {
      res.json({ live: false, error: e.message });
    }
    return;
  }

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

// GET /api/endpoints/:id/monitor-stats — rich stats for quality monitoring
// Returns path-level bytes + SRT publisher connection stats (RTT, packet loss, retransmissions)
router.get('/:id/monitor-stats', async (req, res) => {
  const ep = db.prepare('SELECT name, protocol FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }

  const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';

  function apiGet(url) {
    const http = require('http');
    return new Promise((resolve) => {
      http.get(url, (r) => {
        let d = '';
        r.on('data', c => { d += c; });
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });
  }

  try {
    const pathResult = await getPathStatus(ep.name);
    if (pathResult.status !== 200 || !pathResult.body) {
      res.json({ live: false, ts: Date.now() }); return;
    }
    const path = pathResult.body;
    const live = path.ready === true;
    const bytesReceived = path.bytesReceived || 0;
    const bytesSent = path.bytesSent || 0;
    const tracks = (path.tracks || []).map(t => ({ type: t.type, codec: t.codec }));

    let srt = null;
    if (ep.protocol === 'srt') {
      // Find the SRT publisher connection for this path
      const conns = await apiGet(`${MEDIAMTX_API}/v3/srtconns/list`);
      const pub = (conns?.items || []).find(c =>
        c.path === ep.name && (c.state === 'publish' || c.state === 'write')
      );
      if (pub) {
        srt = {
          rttMs:        pub.msRTT          ?? pub.rttMs          ?? null,
          pktLost:      pub.pktRecvLoss    ?? pub.pktLostTotal   ?? pub.pktLost    ?? null,
          pktRetrans:   pub.pktRetrans     ?? pub.pktRetransTotal ?? null,
          pktRecv:      pub.pktRecv        ?? pub.pktReceived    ?? null,
          pktSent:      pub.pktSent        ?? null,
          mbpsRecv:     pub.mbpsRecvRate   ?? pub.mbpsRecv       ?? null,
        };
      }
    }

    res.json({ live, bytesReceived, bytesSent, tracks, srt, ts: Date.now() });
  } catch (e) {
    res.json({ live: false, error: e.message, ts: Date.now() });
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

// Update pull source URL on an existing endpoint
router.post('/:id/pull/update', async (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  const { sourceUrl } = req.body;
  if (!sourceUrl) { res.status(400).json({ error: 'sourceUrl required' }); return; }
  db.prepare("UPDATE endpoints SET source_mode='pull', source_url=? WHERE id=?").run(sourceUrl, ep.id);
  try {
    await removePath(ep.name);
    // pull mode has no publish auth — source is fetched by mediamtx itself
    await addPath(ep.name, withPlanLimits(getLicenseState().plan, { source: sourceUrl }, { protocol: ep.protocol, mode: 'pull' }));
  } catch (e) { console.error('mediamtx pull update error:', e.message); }
  res.json({ ok: true, source_url: sourceUrl });
});

router.post('/:id/pull/disable', async (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  db.prepare("UPDATE endpoints SET source_mode='push', source_url=NULL WHERE id=?").run(ep.id);
  try {
    await removePath(ep.name);
    const auth = { protocol: ep.protocol, mode: 'push', srtPassword: ep.srt_password, rtmpPassword: ep.rtmp_password };
    await addPath(ep.name, withPlanLimits(getLicenseState().plan, {}, auth));
  } catch (e) { console.error('mediamtx pull disable error:', e.message); }
  res.json({ ok: true });
});

// Icecast server info — admin password for web UI access
router.get('/icecast/config', (req, res) => {
  res.json({
    adminPassword: process.env.ICECAST_ADMIN_PASSWORD || null,
    port: ICECAST_PORT,
    serverIp: SERVER_IP,
  });
});

router.post('/:id/transcode/start', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  try { startTranscode(ep.id, ep.name); res.json({ ok: true, transcode_enabled: 1 }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/transcode/stop', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!ep) { res.status(404).json({ error: 'Not found' }); return; }
  stopTranscode(ep.id, ep.name);
  res.json({ ok: true, transcode_enabled: 0 });
});

router.get('/:name/playlist.m3u', (req, res) => {
  const ep = db.prepare('SELECT * FROM endpoints WHERE name = ?').get(req.params.name);
  if (!ep) { res.status(404).send('Not found'); return; }
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.send(`#EXTM3U\n#EXTINF:-1,${ep.name}\n${PUBLIC_URL}/hls/${ep.name}/index.m3u8\n`);
});

module.exports = router;
