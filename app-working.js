const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { webcrypto } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const NodeMediaServer = require('node-media-server');

// Polyfill webcrypto for Node environment
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// ------------------------------------------------------------------
// 1. PATHS & DIRECTORY CREATION
// ------------------------------------------------------------------
const mediaPath = path.join(__dirname, 'media');
const FFMPEG_PATH = '/usr/bin/ffmpeg'; // Ensure this points to your FFmpeg binary

if (!fs.existsSync(mediaPath)) {
  fs.mkdirSync(mediaPath, { recursive: true });
}

// Map to keep track of active FFmpeg child processes
const ffmpegProcesses = new Map();

// ------------------------------------------------------------------
// 2. STANDALONE EXPRESS SERVER (HLS FILE SERVING)
// ------------------------------------------------------------------
const httpApp = express();

// Enable CORS so Video.js can fetch streams from any origin
httpApp.use(cors());

// Serve the media directory statically at the root path '/'
httpApp.use('/', express.static(mediaPath));

// Start the Express server on port 8000
httpApp.listen(8000, () => {
  console.log('[HLS Web Server] Serving HLS streams at http://localhost:8000/');
});

// ------------------------------------------------------------------
// 3. NODE MEDIA SERVER (RTMP ONLY)
// ------------------------------------------------------------------
const nmsConfig = {
  logType: 3,
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  }
  // Notice: 'http' and 'trans' sections are omitted so NodeMediaServer doesn't
  // interfere with port 8000 or attempt internal FFmpeg management.
};

const nms = new NodeMediaServer(nmsConfig);

// ------------------------------------------------------------------
// 4. RTMP EVENTS & MANUAL FFMPEG TRANSCODING
// ------------------------------------------------------------------
nms.on('postPublish', (id, StreamPath) => {
  let actualPath = typeof StreamPath === 'string' ? StreamPath : null;

  // Fallback lookup for session path
  if (!actualPath && nms.sessions) {
    if (typeof nms.sessions.get === 'function') {
      const sess = nms.sessions.get(id);
      actualPath = sess ? sess.publishStreamPath : null;
    } else if (nms.sessions[id]) {
      actualPath = nms.sessions[id].publishStreamPath;
    }
  }

  if (!actualPath) {
    actualPath = '/live/teststream';
  }

  console.log(`\n========================================`);
  console.log(`[Stream Started] StreamPath: ${actualPath}`);

  // Extract application name and stream key
  const parts = actualPath.split('/').filter(Boolean);
  const app = parts[0] || 'live';
  const streamKey = parts[1] || 'teststream';

  // Ensure output folder structure exists (e.g., ./media/live/teststream/)
  const outputDir = path.join(mediaPath, app, streamKey);
  fs.mkdirSync(outputDir, { recursive: true });

  const m3u8Output = path.join(outputDir, 'index.m3u8');
  const rtmpInput = `rtmp://localhost:1935/${app}/${streamKey}`;

  console.log(`[FFmpeg] Output Path: ${m3u8Output}`);
  console.log(`[FFmpeg] Spawning conversion...`);

  // Kill existing process if duplicate session occurs
  if (ffmpegProcesses.has(id)) {
    try { ffmpegProcesses.get(id).kill(); } catch (e) {}
  }

  // Spawn FFmpeg explicitly
  const ffmpegProc = spawn(FFMPEG_PATH, [
    '-i', rtmpInput,
    '-c:v', 'copy',      // Pass H.264 video through directly
    '-c:a', 'aac',       // Convert audio to web-compatible AAC
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'delete_segments',
    m3u8Output
  ]);

  ffmpegProcesses.set(id, ffmpegProc);

  // Pipe FFmpeg output straight to your terminal
  ffmpegProc.stderr.on('data', (data) => {
    console.log(`[FFmpeg Log]: ${data.toString().trim()}`);
  });

  ffmpegProc.on('close', (code) => {
    console.log(`[FFmpeg] Process exited with code ${code}`);
    ffmpegProcesses.delete(id);
  });
});

nms.on('donePublish', (id) => {
  console.log(`[Stream Ended] Killing FFmpeg process for session ${id}`);
  const proc = ffmpegProcesses.get(id);
  if (proc) {
    proc.kill('SIGINT');
    ffmpegProcesses.delete(id);
  }
});

nms.run();
