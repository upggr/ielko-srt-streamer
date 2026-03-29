'use strict';
const { bootstrap } = require('./bootstrap');

// bootstrap must complete before anything reads env vars (APP_PASSWORD, SERVER_IP, etc.)
bootstrap().then(startApp).catch(err => { console.error('[fatal]', err); process.exit(1); });

function startApp() {
  const express = require('express');
  const path = require('path');
  const { createProxyMiddleware } = require('http-proxy-middleware');
  const db = require('./db');
  const authRouter = require('./routes/auth');
  const endpointsRouter = require('./routes/endpoints');
  const statsRouter = require('./routes/stats');
  const { requireAuth } = require('./middleware/auth');
  const { addPath, listPaths } = require('./services/mediamtxClient');
  const { startLicenseWatchdog, getState: getLicenseState, requireLicense, checkLicense } = require('./services/licenseGuard');
  const { getConfig, setConfig } = require('./bootstrap');

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000');
  const MEDIAMTX = 'http://mediamtx';

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'ui')));

  app.use('/api/auth', authRouter);
  app.use('/api/endpoints', requireAuth, requireLicense, endpointsRouter);
  app.use('/api/stats', requireAuth, statsRouter);

  // License status
  app.get('/api/license', requireAuth, (req, res) => res.json(getLicenseState()));
  app.post('/api/license/recheck', requireAuth, async (req, res) => {
    await checkLicense();
    res.json(getLicenseState());
  });

  // Version info
  app.get('/api/version', requireAuth, (req, res) => res.json(getLicenseState()));

  // Self-update: writes a flag file to /repo; host cron picks it up and runs docker compose up --build
  app.post('/api/update', requireAuth, (req, res) => {
    const state = getLicenseState();
    if (!state.updateAvailable) {
      return res.status(400).json({ error: 'No update available' });
    }
    try {
      require('fs').writeFileSync('/repo/update.flag', new Date().toISOString());
      res.json({ ok: true, message: 'Update flag written. Host will apply the update within 30 seconds and restart the container.' });
    } catch (e) {
      res.status(500).json({ error: 'Could not write update flag: ' + e.message });
    }
  });

  // SSO callback — exchanges short-lived token for a session, redirects to return path
  app.get('/setup', (req, res) => {
    const token = req.query.token || '';
    const returnTo = req.query.return || '/';
    // Basic sanity: only allow relative paths
    const safePath = returnTo.startsWith('/') ? returnTo : '/';
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authenticating...</title><style>body{background:#000;color:#0f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:13px;letter-spacing:2px;}</style></head><body><div id="msg">AUTHENTICATING...</div><script>
(async()=>{
  const msg=document.getElementById('msg');
  try{
    const r=await fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)}})});
    const d=await r.json();
    if(!r.ok){msg.textContent='ERROR: '+(d.error||r.status);msg.style.color='#f44';return;}
    localStorage.setItem('srt_token',d.token);
    msg.textContent='ACCESS GRANTED';
    location.href=${JSON.stringify(safePath)};
  }catch(e){msg.textContent='ERROR: '+e.message;msg.style.color='#f44';}
})();
</script></body></html>`);
  });

  // Server config (domain, public URL) — readable/writable from UI
  app.get('/api/config', requireAuth, (req, res) => {
    res.json({
      publicUrl: process.env.PUBLIC_URL,
      serverIp: process.env.SERVER_IP,
      domain: getConfig('domain') || null,
      sslEnabled: getConfig('ssl_enabled') === '1',
    });
  });

  app.post('/api/config/domain', requireAuth, async (req, res) => {
    const { domain } = req.body;
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain' });
    }
    setConfig('domain', domain);
    const newUrl = `https://${domain}`;
    setConfig('public_url', newUrl);
    process.env.PUBLIC_URL = newUrl;
    res.json({ ok: true, publicUrl: newUrl });
  });

  // Proxy HLS: ABR (master.m3u8 / v0..v2) → nginx, passthrough → mediamtx
  app.use('/hls', (req, res, next) => {
    if (/\/(master\.m3u8|v\d\/)/.test(req.path)) {
      return createProxyMiddleware({
        target: 'http://hls-nginx:8080',
        changeOrigin: true,
        pathRewrite: { '^/hls': '' },
      })(req, res, next);
    }
    return createProxyMiddleware({
      target: `${MEDIAMTX}:8888`,
      changeOrigin: true,
      pathRewrite: { '^/hls': '' },
    })(req, res, next);
  });

  // Proxy WebRTC/WHEP
  app.use('/whep', createProxyMiddleware({
    target: `${MEDIAMTX}:8889`,
    changeOrigin: true,
    pathRewrite: { '^/whep': '' },
  }));

  app.get('/watch/:name', (req, res) => {
    const name = req.params.name;
    const PUBLIC_URL = process.env.PUBLIC_URL;
    const hlsUrl = `${PUBLIC_URL}/hls/${name}/index.m3u8`;
    const whepUrl = `${PUBLIC_URL}/whep/${name}/whep`;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} - Live</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#0f0}h1{margin-bottom:16px;font-size:1rem;letter-spacing:2px;text-transform:uppercase}video{width:100%;max-width:1280px;height:auto;border:1px solid #0f0}#s{margin-top:8px;font-size:.75rem;opacity:.6}</style><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script></head><body><h1>// ${name} //</h1><video id="v" controls autoplay muted playsinline></video><div id="s">CONNECTING...</div><script>
const v=document.getElementById('v'),s=document.getElementById('s');
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
    const PUBLIC_URL = process.env.PUBLIC_URL;
    const name = req.params.name;
    const hlsUrl = `${PUBLIC_URL}/hls/${name}/index.m3u8`;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000}video{width:100%;height:100vh;display:block}</style><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script></head><body><video id="v" controls autoplay muted playsinline></video><script>const v=document.getElementById('v');if(Hls.isSupported()){const h=new Hls({liveSyncDurationCount:3});h.loadSource('${hlsUrl}');h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>v.play())}else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src='${hlsUrl}';v.play()}</script></body></html>`);
  });

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'ui', 'index.html')));

  async function syncPaths() {
    db.prepare("UPDATE endpoints SET status='stopped' WHERE status='running'").run();
    const endpoints = db.prepare('SELECT * FROM endpoints').all();
    for (const ep of endpoints) {
      try {
        const conf = ep.source_mode === 'pull' && ep.source_url ? { source: ep.source_url } : {};
        await addPath(ep.name, conf);
      } catch {}
    }
    console.log(`[sync] registered ${endpoints.length} path(s) with mediamtx`);
  }

  async function watchdogTick() {
    try {
      const result = await listPaths();
      if (!result || result.status !== 200 || !result.body) return;
      const activePaths = new Set((result.body.items || []).filter(p => p.ready).map(p => p.name));
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
    } catch {}
  }

  app.listen(PORT, () => {
    console.log(`SRT Streamer API listening on port ${PORT}`);
    console.log(`PUBLIC_URL: ${process.env.PUBLIC_URL}`);
    console.log(`SERVER_IP:  ${process.env.SERVER_IP}`);
    setTimeout(syncPaths, 3000);
    setInterval(watchdogTick, 10000);
    startLicenseWatchdog();
  });
}
