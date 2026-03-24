'use strict';
const { spawn } = require('child_process');
const db = require('../db');

const MEDIAMTX_HLS = process.env.MEDIAMTX_HLS || 'http://mediamtx:8888';

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

module.exports = { getLogs, startYouTube, stopYouTube };
