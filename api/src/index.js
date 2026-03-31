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
  const { withPlanLimits } = require('./services/mediamtxPathConfig');
  const { rewriteMountsConfig } = require('./services/icecastManager');
  const { startLicenseWatchdog, getState: getLicenseState, requireLicense, checkLicense } = require('./services/licenseGuard');
  const { getConfig, setConfig } = require('./bootstrap');

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000');
  const MEDIAMTX = 'http://mediamtx';

  // Behind Caddy/nginx: use X-Forwarded-* so req.secure / req.protocol reflect HTTPS for clients.
  const tp = (process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (tp === '1' || tp === 'true' || tp === 'yes') {
    app.set('trust proxy', 1);
  } else if (/^\d+$/.test(tp)) {
    app.set('trust proxy', parseInt(tp, 10));
  }

  app.use(express.json());

  const { bearerMatchesLicenseKey } = require('./utils/licenseBearer');

  // No auth — read-only; lets the dashboard show deployed SHA vs catalog.
  app.get('/api/public/version', (req, res) => {
    const s = getLicenseState();
    res.json({
      currentVersion: s.currentVersion || 'unknown',
      latestVersion: s.latestVersion,
      updateAvailable: !!s.updateAvailable,
      licenseValid: !!s.valid,
    });
  });

  // Same license Bearer as /api/auth/token; triggers host self-update (update.flag).
  app.post('/api/license/trigger-update', async (req, res) => {
    if (!bearerMatchesLicenseKey(req.headers.authorization, process.env.LICENSE_KEY)) {
      return res.status(401).json({ error: 'Invalid license key' });
    }
    try {
      await checkLicense();
    } catch (err) {
      console.error('[trigger-update] checkLicense failed', err);
    }
    const state = getLicenseState();
    if (!state.updateAvailable) {
      return res.status(400).json({
        error: 'No update available',
        currentVersion: state.currentVersion,
        latestVersion: state.latestVersion,
        licenseValid: state.valid,
      });
    }
    try {
      require('fs').writeFileSync('/repo/update.flag', new Date().toISOString());
      res.json({
        ok: true,
        message:
          'Update scheduled. The host will rebuild/restart the stack shortly; live streams may drop briefly.',
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not write update flag: ' + e.message });
    }
  });

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
  // ?force=1 skips the updateAvailable check (force re-pull even if version looks current)
  app.post('/api/update', requireAuth, (req, res) => {
    const force = req.query.force === '1';
    const state = getLicenseState();
    if (!force && !state.updateAvailable) {
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

  function publicUrlForConfig() {
    return process.env.PUBLIC_URL || getConfig('public_url') || null;
  }

  function hostnameFromPublicUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const h = u.hostname;
      if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
      return h.toLowerCase();
    } catch {
      return null;
    }
  }

  // Server config (domain, public URL) — readable/writable from UI
  app.get('/api/config', requireAuth, (req, res) => {
    const publicUrl = publicUrlForConfig();
    const storedDomain = (getConfig('domain') || '').trim() || null;
    const derivedDomain = hostnameFromPublicUrl(publicUrl);
    const domain = storedDomain || derivedDomain || null;
    const sslFlag = getConfig('ssl_enabled') === '1';
    const httpsPublic = !!(publicUrl && /^https:\/\//i.test(publicUrl));
    const sslEnabled = sslFlag || httpsPublic;
    res.json({
      publicUrl,
      serverIp: process.env.SERVER_IP,
      domain,
      domainStored: storedDomain,
      sslEnabled,
      dnsHint: 'Point an A record for your hostname to this server IP, then use HTTPS (e.g. Caddy) in front of port 3000.',
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
    setConfig('ssl_enabled', '1');
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

  // Icecast mount proxy — /<mountname> → icecast:8000/<mountname>
  // Checks DB so only real mounts are proxied; everything else falls to SPA
  const icecastProxy = createProxyMiddleware({ target: 'http://icecast:8000', changeOrigin: true });
  app.use(/^\/([a-z][a-z0-9_-]*)$/, (req, res, next) => {
    const name = req.path.slice(1);
    const exists = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(name);
    if (exists) return icecastProxy(req, res, next);
    next();
  });

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'ui', 'index.html')));

  async function syncPaths() {
    db.prepare("UPDATE endpoints SET status='stopped' WHERE status='running'").run();
    const endpoints = db.prepare('SELECT * FROM endpoints').all();
    for (const ep of endpoints) {
      try {
        const conf = ep.source_mode === 'pull' && ep.source_url ? { source: ep.source_url } : {};
        const auth = { protocol: ep.protocol, mode: ep.source_mode, srtPassword: ep.srt_password, rtmpPassword: ep.rtmp_password };
        await addPath(ep.name, withPlanLimits(getLicenseState().plan, conf, auth));
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
    setTimeout(rewriteMountsConfig, 3000); // restore icecast mounts after restart
    setInterval(watchdogTick, 10000);
    startLicenseWatchdog();
  });
}
