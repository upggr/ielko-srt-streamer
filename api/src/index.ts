import express from 'express';
import path from 'path';
import { createProxyMiddleware } from 'http-proxy-middleware';
import './db'; // init DB
import { recoverState } from './services/ffmpegManager';
import authRouter from './routes/auth';
import endpointsRouter from './routes/endpoints';
import statsRouter from './routes/stats';
import { requireAuth } from './middleware/auth';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://streams.upg.gr:666';

const tp = (process.env.TRUST_PROXY || '').trim().toLowerCase();
if (tp === '1' || tp === 'true' || tp === 'yes') {
  app.set('trust proxy', 1);
} else if (/^\d+$/.test(tp)) {
  app.set('trust proxy', parseInt(tp, 10));
}

app.use(express.json());

// Static UI
app.use(express.static(path.join(__dirname, '..', 'ui')));

// Auth routes (no auth required)
app.use('/api/auth', authRouter);

// Protected routes
app.use('/api/endpoints', requireAuth, endpointsRouter);
app.use('/api/stats', requireAuth, statsRouter);

// Proxy HLS and DASH to hls-nginx (so only port 3000 needs to be exposed)
const hlsProxy = createProxyMiddleware({
  target: 'http://hls-nginx:8080',
  changeOrigin: true,
});
app.use('/hls', hlsProxy);
app.use('/dash', hlsProxy);

// Viewer page
app.get('/watch/:name', (req, res) => {
  const name = req.params.name;
  const hlsUrl = `${PUBLIC_URL}/hls/${name}/master.m3u8`;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name} - Live Stream</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: monospace; color: #0f0; }
    h1 { margin-bottom: 16px; font-size: 1rem; letter-spacing: 2px; text-transform: uppercase; }
    video { width: 100%; max-width: 1280px; height: auto; border: 1px solid #0f0; }
    #status { margin-top: 8px; font-size: 0.75rem; opacity: 0.6; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body>
  <h1>// ${name} //</h1>
  <video id="video" controls autoplay muted></video>
  <div id="status">CONNECTING...</div>
  <script>
    const video = document.getElementById('video');
    const status = document.getElementById('status');
    const src = '${hlsUrl}';
    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { status.textContent = 'LIVE'; video.play(); });
      hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) status.textContent = 'STREAM OFFLINE'; });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.addEventListener('loadedmetadata', () => { status.textContent = 'LIVE'; video.play(); });
    } else {
      status.textContent = 'HLS NOT SUPPORTED';
    }
  </script>
</body>
</html>`);
});

// Embeddable player (minimal, no chrome)
app.get('/embed/:name', (req, res) => {
  const name = req.params.name;
  const hlsUrl = `${PUBLIC_URL}/hls/${name}/master.m3u8`;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#000;}video{width:100%;height:100vh;display:block;}</style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body>
  <video id="v" controls autoplay muted playsinline></video>
  <script>
    const v = document.getElementById('v');
    if (Hls.isSupported()) {
      const h = new Hls({liveSyncDurationCount:3});
      h.loadSource('${hlsUrl}');
      h.attachMedia(v);
      h.on(Hls.Events.MANIFEST_PARSED, () => v.play());
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = '${hlsUrl}';
      v.play();
    }
  </script>
</body>
</html>`);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ui', 'index.html'));
});

recoverState();

app.listen(PORT, () => {
  console.log(`SRT Streamer API listening on port ${PORT}`);
});
