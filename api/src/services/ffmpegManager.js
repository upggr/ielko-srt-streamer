'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const MEDIAMTX_HLS = process.env.MEDIAMTX_HLS || 'http://mediamtx:8888';
const HLS_DIR = process.env.HLS_DIR || '/hls';

const ytProcesses = new Map();
const ytStopping = new Set(); // IDs explicitly stopped — no restart
const logs = new Map();
const YT_MAX_RETRIES = 5;
const YT_RETRY_DELAY_MS = 15000;

function getLogs(id) { return logs.get(id) || []; }

function appendLog(id, line) {
  if (!logs.has(id)) logs.set(id, []);
  const buf = logs.get(id);
  buf.push(line);
  if (buf.length > 200) buf.splice(0, buf.length - 200);
}

function _spawnYouTube(id, name, streamKey, attempt) {
  const hlsSource = `${MEDIAMTX_HLS}/${name}/index.m3u8`;
  const proc = spawn('ffmpeg', [
    '-loglevel', 'warning', '-re',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', hlsSource,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
  ]);
  ytProcesses.set(id, proc);
  db.prepare("UPDATE endpoints SET yt_status='live', yt_pid=? WHERE id=?").run(proc.pid, id);
  if (attempt > 1) appendLog(id, `[YT] restart attempt #${attempt}`);
  proc.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[YT] ${l}`)));
  proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[YT-ERR] ${l}`)));
  proc.on('close', code => {
    ytProcesses.delete(id);
    appendLog(id, `[YT] exited with code ${code}`);

    if (ytStopping.has(id)) {
      // Intentional stop
      ytStopping.delete(id);
      db.prepare("UPDATE endpoints SET yt_status='off', yt_pid=NULL WHERE id=?").run(id);
      return;
    }

    if (attempt < YT_MAX_RETRIES) {
      appendLog(id, `[YT] WATCHDOG: restarting in ${YT_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${YT_MAX_RETRIES})`);
      db.prepare("UPDATE endpoints SET yt_status='error', yt_pid=NULL WHERE id=?").run(id);
      setTimeout(() => {
        // Re-read stream key from DB in case it was updated
        const ep = db.prepare('SELECT yt_stream_key FROM endpoints WHERE id = ?').get(id);
        if (!ep || !ep.yt_stream_key) return;
        _spawnYouTube(id, name, ep.yt_stream_key, attempt + 1);
      }, YT_RETRY_DELAY_MS);
    } else {
      appendLog(id, `[YT] WATCHDOG: max retries (${YT_MAX_RETRIES}) reached — giving up`);
      db.prepare("UPDATE endpoints SET yt_status='error', yt_pid=NULL WHERE id=?").run(id);
    }
  });
}

function _spawnPlatform(platform, rtmpUrl, id, name, streamKey, attempt, maxRetries, retryDelay, processes, stopping) {
  const hlsSource = `${MEDIAMTX_HLS}/${name}/index.m3u8`;
  const proc = spawn('ffmpeg', [
    '-loglevel', 'warning', '-re',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', hlsSource,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', rtmpUrl
  ]);
  processes.set(id, proc);
  db.prepare(`UPDATE endpoints SET ${platform}_status='live', ${platform}_pid=? WHERE id=?`).run(proc.pid, id);
  if (attempt > 1) appendLog(id, `[${platform.toUpperCase()}] restart attempt #${attempt}`);
  proc.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[${platform.toUpperCase()}] ${l}`)));
  proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[${platform.toUpperCase()}-ERR] ${l}`)));
  proc.on('close', code => {
    processes.delete(id);
    appendLog(id, `[${platform.toUpperCase()}] exited with code ${code}`);
    if (stopping.has(id)) {
      stopping.delete(id);
      db.prepare(`UPDATE endpoints SET ${platform}_status='off', ${platform}_pid=NULL WHERE id=?`).run(id);
      return;
    }
    if (attempt < maxRetries) {
      appendLog(id, `[${platform.toUpperCase()}] WATCHDOG: restarting in ${retryDelay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
      db.prepare(`UPDATE endpoints SET ${platform}_status='error', ${platform}_pid=NULL WHERE id=?`).run(id);
      setTimeout(() => {
        const ep = db.prepare(`SELECT ${platform}_stream_key FROM endpoints WHERE id = ?`).get(id);
        if (!ep || !ep[`${platform}_stream_key`]) return;
        _spawnPlatform(platform, rtmpUrl.replace(streamKey, ep[`${platform}_stream_key`]), id, name, ep[`${platform}_stream_key`], attempt + 1, maxRetries, retryDelay, processes, stopping);
      }, retryDelay);
    } else {
      appendLog(id, `[${platform.toUpperCase()}] WATCHDOG: max retries (${maxRetries}) reached — giving up`);
      db.prepare(`UPDATE endpoints SET ${platform}_status='error', ${platform}_pid=NULL WHERE id=?`).run(id);
    }
  });
}

const fbProcesses = new Map();
const fbStopping = new Set();
const igProcesses = new Map();
const igStopping = new Set();

function startFacebook(id, name, streamKey) {
  if (fbProcesses.has(id)) throw new Error('Already restreaming to Facebook');
  fbStopping.delete(id);
  _spawnPlatform('fb', `rtmps://live-api-s.facebook.com:443/rtmp/${streamKey}`, id, name, streamKey, 1, 5, 15000, fbProcesses, fbStopping);
}

function stopFacebook(id) {
  const proc = fbProcesses.get(id);
  if (!proc) return;
  fbStopping.add(id);
  proc.kill('SIGTERM');
  setTimeout(() => { if (fbProcesses.has(id)) fbProcesses.get(id).kill('SIGKILL'); }, 3000);
}

function startInstagram(id, name, streamKey) {
  if (igProcesses.has(id)) throw new Error('Already restreaming to Instagram');
  igStopping.delete(id);
  _spawnPlatform('ig', `rtmps://live-upload.instagram.com:443/rtmp/${streamKey}`, id, name, streamKey, 1, 5, 15000, igProcesses, igStopping);
}

function stopInstagram(id) {
  const proc = igProcesses.get(id);
  if (!proc) return;
  igStopping.add(id);
  proc.kill('SIGTERM');
  setTimeout(() => { if (igProcesses.has(id)) igProcesses.get(id).kill('SIGKILL'); }, 3000);
}

function startYouTube(id, name, streamKey) {
  if (ytProcesses.has(id)) throw new Error('Already restreaming');
  ytStopping.delete(id);
  _spawnYouTube(id, name, streamKey, 1);
}

function stopYouTube(id) {
  const proc = ytProcesses.get(id);
  if (!proc) return;
  ytStopping.add(id);
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (ytProcesses.has(id)) {
      ytProcesses.get(id).kill('SIGKILL');
    }
  }, 3000);
}

// --- Adaptive Bitrate Transcoding ---
const transcodeProcesses = new Map();
const transcodeStopping = new Set();

function startTranscode(id, name) {
  if (transcodeProcesses.has(id)) throw new Error('Transcode already running');
  transcodeStopping.delete(id);

  const outDir = path.join(HLS_DIR, name);
  fs.mkdirSync(outDir, { recursive: true });

  const inputUrl = `${MEDIAMTX_HLS}/${name}/index.m3u8`;

  // filter_complex: split source into 3 scaled renditions
  const filterComplex = [
    '[0:v]split=3[v720][v480][v360]',
    '[v720]scale=-2:720[out720]',
    '[v480]scale=-2:480[out480]',
    '[v360]scale=-2:360[out360]',
  ].join(';');

  const args = [
    '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', inputUrl,
    '-filter_complex', filterComplex,
    // 720p
    '-map', '[out720]', '-map', '0:a',
    '-c:v:0', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v:0', '2500k', '-maxrate:v:0', '2700k', '-bufsize:v:0', '5000k',
    '-c:a:0', 'aac', '-b:a:0', '128k',
    // 480p
    '-map', '[out480]', '-map', '0:a',
    '-c:v:1', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v:1', '1200k', '-maxrate:v:1', '1300k', '-bufsize:v:1', '2400k',
    '-c:a:1', 'aac', '-b:a:1', '96k',
    // 360p
    '-map', '[out360]', '-map', '0:a',
    '-c:v:2', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v:2', '600k', '-maxrate:v:2', '700k', '-bufsize:v:2', '1200k',
    '-c:a:2', 'aac', '-b:a:2', '64k',
    // HLS output
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${outDir}/v%v/seg%03d.ts`,
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2',
    `${outDir}/v%v/index.m3u8`,
  ];

  const proc = spawn('ffmpeg', args);
  transcodeProcesses.set(id, proc);
  db.prepare("UPDATE endpoints SET transcode_enabled=1, transcode_pid=? WHERE id=?").run(proc.pid, id);

  proc.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[ABR] ${l}`)));
  proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[ABR-ERR] ${l}`)));

  proc.on('close', code => {
    transcodeProcesses.delete(id);
    appendLog(id, `[ABR] ffmpeg exited with code ${code}`);
    if (transcodeStopping.has(id)) {
      transcodeStopping.delete(id);
      db.prepare("UPDATE endpoints SET transcode_pid=NULL WHERE id=?").run(id);
      return;
    }
    // Auto-restart on unexpected exit (stream reconnect)
    db.prepare("UPDATE endpoints SET transcode_pid=NULL WHERE id=?").run(id);
    if (db.prepare('SELECT transcode_enabled FROM endpoints WHERE id=?').get(id)?.transcode_enabled) {
      appendLog(id, '[ABR] WATCHDOG: restarting transcode in 5s');
      setTimeout(() => {
        const ep = db.prepare('SELECT * FROM endpoints WHERE id=?').get(id);
        if (ep && ep.transcode_enabled) startTranscode(id, name);
      }, 5000);
    }
  });
}

function stopTranscode(id, name) {
  const proc = transcodeProcesses.get(id);
  transcodeStopping.add(id);
  if (proc) {
    proc.kill('SIGTERM');
    setTimeout(() => { if (transcodeProcesses.has(id)) transcodeProcesses.get(id).kill('SIGKILL'); }, 3000);
  }
  db.prepare("UPDATE endpoints SET transcode_enabled=0, transcode_pid=NULL WHERE id=?").run(id);
  // Clean up HLS segments
  if (name) {
    const outDir = path.join(HLS_DIR, name);
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { getLogs, startYouTube, stopYouTube, startFacebook, stopFacebook, startInstagram, stopInstagram, startTranscode, stopTranscode };
