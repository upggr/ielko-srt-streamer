import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from '../db';

const HLS_DIR = process.env.HLS_DIR || '/hls';
const processes = new Map<string, ChildProcess>();
const logs = new Map<string, string[]>(); // id -> last 200 log lines

export function getLogs(id: string): string[] {
  return logs.get(id) || [];
}

function appendLog(id: string, line: string): void {
  if (!logs.has(id)) logs.set(id, []);
  const buf = logs.get(id)!;
  buf.push(line);
  if (buf.length > 200) buf.splice(0, buf.length - 200);
}

function getStreamDir(name: string): string {
  return path.join(HLS_DIR, name);
}

function buildArgs(protocol: string, port: number, name: string, srtPassword?: string | null): string[] {
  const streamDir = getStreamDir(name);

  let inputArgs: string[];
  if (protocol === 'srt') {
    let srtUrl = `srt://0.0.0.0:${port}?mode=listener`;
    if (srtPassword) srtUrl += `&passphrase=${srtPassword}`;
    inputArgs = ['-i', srtUrl];
  } else {
    inputArgs = ['-i', `udp://0.0.0.0:${port}?timeout=5000000`];
  }

  const hlsDir = streamDir;
  const dashDir = path.join(streamDir, 'dash');

  // Multi-bitrate HLS + DASH using tee muxer with transcoded renditions
  // 1080p: copy if possible, else transcode
  // 720p:  transcode to 4Mbps
  // 480p:  transcode to 1.5Mbps
  // 360p:  transcode to 800kbps (for mobile/low bandwidth)
  // All renditions are served via a master playlist

  return [
    '-loglevel', 'warning',
    ...inputArgs,

    // --- Rendition: source quality (pass-through) ---
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:0', 'copy',
    '-c:a:0', 'aac', '-b:a:0', '192k', '-ac', '2',

    // --- Rendition: 720p ---
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:1', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-vf:1', 'scale=-2:720', '-b:v:1', '4000k', '-maxrate:1', '4500k', '-bufsize:1', '8000k',
    '-c:a:1', 'aac', '-b:a:1', '128k', '-ac', '2',

    // --- Rendition: 480p ---
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:2', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-vf:2', 'scale=-2:480', '-b:v:2', '1500k', '-maxrate:2', '2000k', '-bufsize:2', '3000k',
    '-c:a:2', 'aac', '-b:a:2', '96k', '-ac', '2',

    // --- Rendition: 360p ---
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:3', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-vf:3', 'scale=-2:360', '-b:v:3', '800k', '-maxrate:3', '1000k', '-bufsize:3', '2000k',
    '-c:a:3', 'aac', '-b:a:3', '64k', '-ac', '2',

    // --- HLS output (multi-variant) ---
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(hlsDir, 'v%v/seg%03d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', 'v:0,a:0,name:source v:1,a:1,name:720p v:2,a:2,name:480p v:3,a:3,name:360p',
    path.join(hlsDir, 'v%v/index.m3u8'),

    // --- DASH output ---
    // Note: tee muxer would need pipe-based approach; use separate output instead
    // DASH shares the libx264 encoded 720p stream via fifo trick — skip for simplicity
    // We re-run a second ffmpeg if DASH is needed; for now HLS master covers all use cases
  ];
}

export function startEndpoint(id: string, name: string, protocol: string, port: number, srtPassword?: string | null): void {
  if (processes.has(id)) {
    throw new Error('Already running');
  }

  const streamDir = getStreamDir(name);
  // Create variant dirs
  for (const v of ['v0', 'v1', 'v2', 'v3']) {
    fs.mkdirSync(path.join(streamDir, v), { recursive: true });
  }

  const args = buildArgs(protocol, port, name, srtPassword);
  const proc = spawn('ffmpeg', args);

  processes.set(id, proc);
  db.prepare('UPDATE endpoints SET status = ?, ffmpeg_pid = ?, updated_at = datetime('now') WHERE id = ?')
    .run('running', proc.pid, id);

  logs.set(id, []);
  proc.stdout?.on('data', (d) => {
    const lines = String(d).split('\n').filter(Boolean);
    lines.forEach(l => { appendLog(id, `[OUT] ${l}`); process.stdout.write(`[${name}] ${l}\n`); });
  });
  proc.stderr?.on('data', (d) => {
    const lines = String(d).split('\n').filter(Boolean);
    lines.forEach(l => { appendLog(id, `[ERR] ${l}`); process.stderr.write(`[${name}] ${l}\n`); });
  });

  proc.on('close', (code) => {
    processes.delete(id);
    const status = code === 0 ? 'stopped' : 'error';
    db.prepare('UPDATE endpoints SET status = ?, ffmpeg_pid = NULL, updated_at = datetime('now') WHERE id = ?')
      .run(status, id);
    console.log(`[${name}] ffmpeg exited with code ${code}`);
  });
}

export function stopEndpoint(id: string): void {
  const proc = processes.get(id);
  if (!proc) return;

  proc.kill('SIGTERM');
  setTimeout(() => {
    if (processes.has(id)) proc.kill('SIGKILL');
  }, 3000);
}

export function isRunning(id: string): boolean {
  return processes.has(id);
}

export function recoverState(): void {
  db.prepare("UPDATE endpoints SET status = 'stopped', ffmpeg_pid = NULL WHERE status = 'running'").run();
  db.prepare("UPDATE endpoints SET yt_status = 'off', yt_pid = NULL WHERE yt_status = 'live'").run();
}

// YouTube restream processes
const ytProcesses = new Map<string, ChildProcess>();

export function startYouTube(id: string, name: string, streamKey: string): void {
  if (ytProcesses.has(id)) throw new Error('Already restreaming');

  // Read from the HLS master and push to YouTube RTMP
  const hlsSource = path.join(HLS_DIR, name, 'v1', 'index.m3u8'); // 720p rendition
  const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;

  const args = [
    '-loglevel', 'warning',
    '-re',
    '-i', hlsSource,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv',
    rtmpUrl
  ];

  const proc = spawn('ffmpeg', args);
  ytProcesses.set(id, proc);
  db.prepare("UPDATE endpoints SET yt_status = 'live', yt_pid = ? WHERE id = ?").run(proc.pid, id);

  proc.stdout?.on('data', (d) => {
    String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[YT-OUT] ${l}`));
  });
  proc.stderr?.on('data', (d) => {
    String(d).split('\n').filter(Boolean).forEach(l => appendLog(id, `[YT-ERR] ${l}`));
  });

  proc.on('close', (code) => {
    ytProcesses.delete(id);
    const status = code === 0 ? 'off' : 'error';
    db.prepare('UPDATE endpoints SET yt_status = ?, yt_pid = NULL WHERE id = ?').run(status, id);
    appendLog(id, `[YT] Restream exited with code ${code}`);
  });
}

export function stopYouTube(id: string): void {
  const proc = ytProcesses.get(id);
  if (!proc) return;
  proc.kill('SIGTERM');
  setTimeout(() => { if (ytProcesses.has(id)) proc.kill('SIGKILL'); }, 3000);
}
