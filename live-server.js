const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { webcrypto } = require('node:crypto');

// Polyfill webcrypto for Node environment
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const NodeMediaServer = require('node-media-server');

// Define paths
const mediaPath = path.join(__dirname, 'media');
const FFMPEG_PATH = '/usr/bin/ffmpeg'; // <-- Ensure this points to your FFmpeg binary

// Track active FFmpeg processes
const ffmpegProcesses = new Map();

const config = {
  logType: 3,
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    mediaroot: mediaPath,
    allow_origin: '*'
  }
};

const nms = new NodeMediaServer(config);

nms.on('postPublish', (id, StreamPath, args) => {
  let actualPath = typeof StreamPath === 'string' ? StreamPath : null;

  // Safe fallback lookup if StreamPath isn't passed directly
  if (!actualPath && nms.sessions) {
    if (typeof nms.sessions.get === 'function') {
      const sess = nms.sessions.get(id);
      actualPath = sess ? sess.publishStreamPath : null;
    } else if (nms.sessions[id]) {
      actualPath = nms.sessions[id].publishStreamPath;
    }
  }

  // Fallback to default path if still undefined so Node NEVER crashes
  if (!actualPath) {
    console.warn('[Warning] StreamPath undefined, defaulting to /live/teststream');
    actualPath = '/live/teststream';
  }

  console.log(`\n========================================`);
  console.log(`[Stream Started] StreamPath: ${actualPath}`);

  // Safely parse app and streamKey
  const parts = actualPath.split('/').filter(Boolean);
  const app = parts[0] || 'live';
  const streamKey = parts[1] || 'teststream';

  const outputDir = path.join(mediaPath, app, streamKey);
  fs.mkdirSync(outputDir, { recursive: true });

  const m3u8Output = path.join(outputDir, 'index.m3u8');
  const rtmpInput = `rtmp://localhost:1935/${app}/${streamKey}`;

  console.log(`[FFmpeg] Output Path: ${m3u8Output}`);
  console.log(`[FFmpeg] Spawning conversion...`);

  // Kill existing FFmpeg instance for this session if running
  if (ffmpegProcesses.has(id)) {
    try { ffmpegProcesses.get(id).kill(); } catch (e) {}
  }

  // Spawn FFmpeg explicitly
  const ffmpegProc = spawn(FFMPEG_PATH, [
    '-i', rtmpInput,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'delete_segments',
    m3u8Output
  ]);

  ffmpegProcesses.set(id, ffmpegProc);

  // Print FFmpeg output directly to your terminal
  ffmpegProc.stderr.on('data', (data) => {
    console.log(`[FFmpeg Log]: ${data.toString().trim()}`);
  });

  ffmpegProc.on('close', (code) => {
    console.log(`[FFmpeg] Process exited with code ${code}`);
    ffmpegProcesses.delete(id);
  });
});

nms.on('donePublish', (id) => {
  console.log(`[Stream Ended] Session ${id}`);
  const proc = ffmpegProcesses.get(id);
  if (proc) {
    proc.kill('SIGINT');
    ffmpegProcesses.delete(id);
  }
});

nms.run();