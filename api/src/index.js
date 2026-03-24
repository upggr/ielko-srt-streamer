'use strict';
const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('./db');
const db = require('./db');
const authRouter = require('./routes/auth');
const endpointsRouter = require('./routes/endpoints');
const statsRouter = require('./routes/stats');
const { requireAuth } = require('./middleware/auth');
const { addPath, listPaths } = require('./services/mediamtxClient');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://streams.ioniantv.gr';
const MEDIAMTX = 'http://mediamtx';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'ui')));

app.use('/api/auth', authRouter);
app.use('/api/endpoints', requireAuth, endpointsRouter);
app.use('/api/stats', requireAuth, statsRouter);

// Proxy HLS from mediamtx
app.use('/hls', createProxyMiddleware({ target: `${MEDIAMTX}:8888`, changeOrigin: true }));

// Proxy WebRTC/WHEP from mediamtx
app.use('/whep', createProxyMiddleware({ target: `${MEDIAMTX}:8889`, changeOrigin: true }));

app.get('/watch/:name', (req, res) => {
  const name = req.params.name;
  const hlsUrl = `${PUBLIC_URL}/hls/${name}/index.m3u8`;
  const whepUrl = `${PUBLIC_URL}/whep/${name}/whep`;
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} - Live</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#0f0}h1{margin-bottom:16px;font-size:1rem;letter-spacing:2px;text-transform:uppercase}video{width:100%;max-width:1280px;height:auto;border:1px solid #0f0}#s{margin-top:8px;font-size:.75rem;opacity:.6}</style><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script></head><body><h1>// ${name} //</h1><video id="v" controls autoplay muted playsinline></video><div id="s">CONNECTING...</div><script>
const v=document.getElementById('v'),s=document.getElementById('s');
// Try WebRTC first, fall back to HLS
async function tryWebRTC(){
  if(!window.RTCPeerConnection)return false;
  try{
    const pc=new RTCPeerConnection();
    pc.addTransceiver('video',{direction:'recvonly'});
    pc.addTransceiver('audio',{direction:'recvonly'});
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r=await fetch('${whepUrl}',{method:'POST',headers:{'Content-Type':'application/sdp'},body:offer.sdp});
    if(!r.ok)return false;
    const sdp=await r.text();
    await pc.setRemoteDescription({type:'answer',sdp});
    const ms=new MediaStream();
    pc.ontrack=e=>{ms.addTrack(e.track);v.srcObject=ms;s.textContent='● LIVE (WebRTC)';v.play();};
    return true;
  }catch{return false;}
}
(async()=>{
  const ok=await tryWebRTC();
  if(!ok){
    if(Hls.isSupported()){const h=new Hls({liveSyncDurationCount:3});h.loadSource('${hlsUrl}');h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>{s.textContent='● LIVE (HLS)';v.play()});h.on(Hls.Events.ERROR,(e,d)=>{if(d.fatal)s.textContent='STREAM OFFLINE'});}
    else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src='${hlsUrl}';v.addEventListener('loadedmetadata',()=>{s.textContent='● LIVE';v.play()});}
  }
})();
</script></body></html>`);
});

app.get('/embed/:name', (req, res) => {
  const name = req.params.name;
  const hlsUrl = `${PUBLIC_URL}/hls/${name}/index.m3u8`;
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000}video{width:100%;height:100vh;display:block}</style><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script></head><body><video id="v" controls autoplay muted playsinline></video><script>const v=document.getElementById('v');if(Hls.isSupported()){const h=new Hls({liveSyncDurationCount:3});h.loadSource('${hlsUrl}');h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>v.play())}else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src='${hlsUrl}';v.play()}</script></body></html>`);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ui', 'index.html'));
});

// On startup, reset any stale running status
async function syncPaths() {
  db.prepare("UPDATE endpoints SET status='stopped' WHERE status='running'").run();
  // Register all endpoints as paths in mediamtx so they're ready to receive
  const endpoints = db.prepare('SELECT * FROM endpoints').all();
  for (const ep of endpoints) {
    try {
      await addPath(ep.name, {});
    } catch (e) {
      // Path may already exist or mediamtx may handle it dynamically — not fatal
    }
  }
  console.log(`[sync] registered ${endpoints.length} path(s) with mediamtx`);
}

// Watchdog: poll mediamtx every 10s and sync stream status
async function watchdogTick() {
  try {
    const result = await listPaths();
    if (!result || result.status !== 200 || !result.body) return;
    const activePaths = new Set((result.body.items || [])
      .filter(p => p.ready)
      .map(p => p.name));

    const endpoints = db.prepare('SELECT * FROM endpoints').all();
    for (const ep of endpoints) {
      const isActive = activePaths.has(ep.name);
      const dbRunning = ep.status === 'running';
      if (isActive && !dbRunning) {
        db.prepare("UPDATE endpoints SET status='running', updated_at=datetime('now') WHERE id=?").run(ep.id);
      } else if (!isActive && dbRunning) {
        db.prepare("UPDATE endpoints SET status='stopped', updated_at=datetime('now') WHERE id=?").run(ep.id);
      }
    }
  } catch (e) {
    // mediamtx not ready yet — silent
  }
}

app.listen(PORT, async () => {
  console.log(`SRT Streamer API listening on port ${PORT}`);
  setTimeout(syncPaths, 3000);
  setInterval(watchdogTick, 10000);
});
