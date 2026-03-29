'use strict';
const { Router } = require('express');
const { execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const router = Router();

function apiGet(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

router.get('/', (req, res) => {
  const endpoints = db.prepare('SELECT status FROM endpoints').all();
  const total = endpoints.length;
  const live = endpoints.filter(e => e.status === 'running').length;
  const stopped = endpoints.filter(e => e.status === 'stopped').length;
  const errored = endpoints.filter(e => e.status === 'error').length;

  let cpuLoad = '', memFree = '', uptime = '';
  try { cpuLoad = execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", { timeout: 2000 }).toString().trim(); } catch {}
  try { memFree = execSync("free -m | awk '/Mem:/ {printf \"%dMB / %dMB\", $3, $2}'", { timeout: 2000 }).toString().trim(); } catch {}
  try { uptime = execSync('uptime -p', { timeout: 2000 }).toString().trim(); } catch {}

  res.json({ endpoints: { total, live, stopped, errored }, system: { cpuLoad, memFree, uptime } });
});

router.get('/bandwidth', async (req, res) => {
  const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';
  const SPEEDTEST_FILE = process.env.SPEEDTEST_FILE || '/repo/.speedtest.json';

  // Read last speedtest result
  let uploadBps = null, downloadBps = null, speedtestAt = null;
  try {
    const raw = fs.readFileSync(SPEEDTEST_FILE, 'utf8');
    const st = JSON.parse(raw);
    uploadBps = st.upload || null;
    downloadBps = st.download || null;
    speedtestAt = st.timestamp || null;
  } catch {}

  // Count active viewers across all mediamtx connection types
  let viewers = 0;
  const [srt, rtmp, webrtc, hls] = await Promise.all([
    apiGet(`${MEDIAMTX_API}/v3/srtconns/list`),
    apiGet(`${MEDIAMTX_API}/v3/rtmpconns/list`),
    apiGet(`${MEDIAMTX_API}/v3/webrtcsessions/list`),
    apiGet(`${MEDIAMTX_API}/v3/hlsmuxers/list`),
  ]);

  // Only count reader connections (not publishers)
  const srtReaders  = (srt?.items  || []).filter(c => c.state === 'read').length;
  const rtmpReaders = (rtmp?.items || []).filter(c => c.state === 'read').length;
  const webrtcCount = (webrtc?.items || []).length;
  const hlsCount    = (hls?.items   || []).length;
  viewers = srtReaders + rtmpReaders + webrtcCount + hlsCount;

  // Count active live paths and their outbound bytes to estimate current throughput
  const paths = await apiGet(`${MEDIAMTX_API}/v3/paths/list`);
  const livePaths = (paths?.items || []).filter(p => p.ready);
  const totalOutboundBytes = livePaths.reduce((s, p) => s + (p.bytesSent || p.outboundBytes || 0), 0);

  // Estimate capacity: upload_bps / typical stream bitrate (default 4 Mbps per viewer)
  const AVG_STREAM_BPS = 4 * 1024 * 1024; // 4 Mbps
  const capacityViewers = uploadBps ? Math.floor(uploadBps / AVG_STREAM_BPS) : null;

  res.json({
    uploadBps,
    downloadBps,
    speedtestAt,
    viewers,
    viewerBreakdown: { srt: srtReaders, rtmp: rtmpReaders, webrtc: webrtcCount, hls: hlsCount },
    livePaths: livePaths.length,
    totalOutboundBytes,
    capacityViewers,
    avgStreamBps: AVG_STREAM_BPS,
  });
});

module.exports = router;
