'use strict';
const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('./db'); // init DB
const { recoverState } = require('./services/ffmpegManager');
const authRouter = require('./routes/auth');
const endpointsRouter = require('./routes/endpoints');
const statsRouter = require('./routes/stats');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://streams.ioniantv.gr';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'ui')));

app.use('/api/auth', authRouter);
app.use('/api/endpoints', requireAuth, endpointsRouter);
app.use('/api/stats', requireAuth, statsRouter);

app.use('/hls', createProxyMiddleware({ target: 'http://hls-nginx:8080', changeOrigin: true }));
app.use('/dash', createProxyMiddleware({ target: 'http://hls-nginx:8080', changeOrigin: true }));

app.get('/watch/:name', (req, res) => {
  const name = req.params.name;
  const hlsUrl = `${PUBLIC_URL}/hls/${name}/master.m3u8`;
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} - Live</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#0f0}h1{margin-bottom:16px;font-size:1rem;letter-spacing:2px;text-transform:uppercase}video{width:100%;max-width:1280px;height:auto;border:1px solid #0f0}#s{margin-top:8px;font-size:.75rem;opacity:.6}</style><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script></head><body><h1>// ${name} //</h1><video id="v" controls autoplay muted></video><div id="s">CONNECTING...</div><script>const v=document.getElementById('v'),s=document.getElementById('s');if(Hls.isSupported()){const h=new Hls({liveSyncDurationCount:3});h.loadSource('${hlsUrl}');h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>{s.textContent='LIVE';v.play()});h.on(Hls.Events.ERROR,(e,d)=>{if(d.fatal)s.textContent='STREAM OFFLINE'})}else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src='${hlsUrl}';v.addEventListener('loadedmetadata',()=>{s.textContent='LIVE';v.play()})}</script></body></html>`);
});

app.get('/embed/:name', (req, res) => {
  const name = req.params.name;
  const hlsUrl = `${PUBLIC_URL}/hls/${name}/master.m3u8`;
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000}video{width:100%;height:100vh;display:block}</style><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script></head><body><video id="v" controls autoplay muted playsinline></video><script>const v=document.getElementById('v');if(Hls.isSupported()){const h=new Hls({liveSyncDurationCount:3});h.loadSource('${hlsUrl}');h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>v.play())}else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src='${hlsUrl}';v.play()}</script></body></html>`);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ui', 'index.html'));
});

recoverState();
app.listen(PORT, () => console.log(`SRT Streamer API listening on port ${PORT}`));
