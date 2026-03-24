'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const HLS_DIR = process.env.HLS_DIR || '/hls';
const processes = new Map();
const ytProcesses = new Map();
const logs = new Map();

function getLogs(id) { return logs.get(id) || []; }

function appendLog(id, line) {
  if (!logs.has(id)) logs.set(id, []);
  const buf = logs.get(id);
  buf.push(line);
  if (buf.length > 200) buf.splice(0, buf.length - 200);
}

function buildArgs(protocol, port, name, srtPassword) {
  const streamDir = path.join(HLS_DIR, name);
  let inputArgs;
  if (protocol === 'srt') {
    let url = `srt://0.0.0.0:${port}?mode=listener`;
    if (srtPassword) url += `&passphrase=${srtPassword}`;
    inputArgs = ['-i', url];
  } else {
    inputArgs = ['-i', `udp://0.0.0.0:${port}?timeout=5000000`];
  }

  return [
    '-loglevel', 'warning',
    ...inputArgs,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:0', 'copy', '-c:a:0', 'aac', '-b:a:0', '192k', '-ac', '2',
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:1', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-vf:1', 'scale=-2:720', '-b:v:1', '4000k', '-maxrate:1', '4500k', '-bufsize:1', '8000k',
    '-c:a:1', 'aac', '-b:a:1', '128k', '-ac', '2',
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:2', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-vf:2', 'scale=-2:480', '-b:v:2', '1500k', '-maxrate:2', '2000k', '-bufsize:2', '3000k',
    '-c:a:2', 'aac', '-b:a:2', '96k', '-ac', '2',
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:3', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-vf:3', 'scale=-2:360', '-b:v:3', '800k', '-maxrate:3', '1000k', '-bufsize:3', '2000k',
    '-c:a:3', 'aac', '-b:a:3', '64k', '-ac', '2',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(streamDir, 'v%v/seg%03d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', 'v:0,a:0,name:source v:1,a:1,name:720p v:2,a:2,name:480p v:3,a:3,name:360p',
    path.join(streamDir, 'v%v/index.m3u8'),
  ];
}

function startEndpoint(id, name, protocol, port, srtPassword) {
  if (processes.has(id)) throw new Error('Already running');
  const streamDir = path.join(HLS_DIR, name);
  for (const v of ['v0', 'v1', 'v2', 'v3']) {
    fs.mkdirSync(path.join(streamDir, v), { recursive: true });
  }
  const proc = spawn('ffmpeg', buildArgs(protocol, port, name, srtPassword));
  processes.set(id, proc);
  db.prepare("UPDATE endpoints SET status='running', ffmpeg_pid=?, updated_at=datetime('now') WHERE id=?")
    .run(proc.pid, id);
  logs.set(id, []);
  proc.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => { appendLog(id, `[OUT] ${l}`); process.stdout.write(`[${name}] ${l}\n`); }));
  proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => { appendLog(id, `[ERR] ${l}`); process.stderr.write(`[${name}] ${l}\n`); }));
  proc.on('close', code => {
    processes.delete(id);
    db.prepare("UPDATE endpoints SET status=?, ffmpeg_pid=NULL, updated_at=datetime('now') WHERE id=?")
      .run(code === 0 ? 'stopped' : 'error', id);
  });
}

function stopEndpoint(id) {
  const proc = processes.get(id);
  if (!proc) return;
  proc.kill('SIGTERM');
  setTimeout(() => { if (processes.has(id)) proc.kill('SIGKILL'); }, 3000);
}

function startYouTube(id, name, streamKey) {
  if (ytProcesses.has(id)) throw new Error('Already restreaming');
  const hlsSource = path.join(HLS_DIR, name, 'v1', 'index.m3u8');
  const proc = spawn('ffmpeg', [
    '-loglevel', 'warning', '-re', '-i', hlsSource,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
  ]);
  ytProcesses.set(id, proc);
  db.prepare("UPDATE endpoints SET yt_status='live', yt_pid=? WHERE id=?").run(proc.pid, id);
  proc.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[YT] ${l}`)));
  proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[YT-ERR] ${l}`)));
  proc.on('close', code => {
    ytProcesses.delete(id);
    db.prepare("UPDATE endpoints SET yt_status=?, yt_pid=NULL WHERE id=?").run(code === 0 ? 'off' : 'error', id);
    appendLog(id, `[YT] exited ${code}`);
  });
}

function stopYouTube(id) {
  const proc = ytProcesses.get(id);
  if (!proc) return;
  proc.kill('SIGTERM');
  setTimeout(() => { if (ytProcesses.has(id)) proc.kill('SIGKILL'); }, 3000);
}

function recoverState() {
  db.prepare("UPDATE endpoints SET status='stopped', ffmpeg_pid=NULL WHERE status='running'").run();
  db.prepare("UPDATE endpoints SET yt_status='off', yt_pid=NULL WHERE yt_status='live'").run();
}

module.exports = { startEndpoint, stopEndpoint, getLogs, startYouTube, stopYouTube, recoverState };
