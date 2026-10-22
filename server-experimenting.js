const path = require('path');
const fs = require('fs');
const https = require('https'); // 1. Added native HTTPS module
const { spawn } = require('child_process');
const { webcrypto } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const NodeMediaServer = require('node-media-server');

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const mediaPath = path.join(__dirname, 'media');
const FFMPEG_PATH = '/usr/bin/ffmpeg';

if (!fs.existsSync(mediaPath)) {
  fs.mkdirSync(mediaPath, { recursive: true });
}

const ffmpegProcesses = new Map();

// ------------------------------------------------------------------
// SSL CERTIFICATE CONFIGURATION
// ------------------------------------------------------------------
// const sslOptions = {
//   key: fs.readFileSync('/etc/letsencrypt/live/test.hararechristianfellowship.org/privkey.pem'),
//   cert: fs.readFileSync('/etc/letsencrypt/live/test.hararechristianfellowship.org/fullchain.pem')
// };

// ------------------------------------------------------------------
// HTTPS EXPRESS SERVER (SERVES HLS MEDIA)
// ------------------------------------------------------------------
const httpApp = express();
httpApp.use(cors());
httpApp.use('/', express.static(mediaPath));

// Create secure HTTPS server on Port 8443 for HLS static files
// https.createServer(sslOptions, httpApp).listen(8443, () => {
//   console.log('[HLS Web Server] Serving multi-bitrate HLS streams securely at https://domain.co.zw:8443/');
// });

// Optional: Keep HTTP fallback on port 8000 if needed
httpApp.listen(8000, () => {
  console.log('[HLS Web Server] Serving HTTP fallback at http://domain.co.zw:8000/');
});

// ------------------------------------------------------------------
// NODE MEDIA SERVER (RTMP ONLY)
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
  // HTTPS block removed from NMS since Express is handling HTTPS static files now
};

const nms = new NodeMediaServer(nmsConfig);

// ------------------------------------------------------------------
// RTMP EVENTS & MULTI-QUALITY TRANSCODING
// ------------------------------------------------------------------
nms.on('postPublish', (id, StreamPath) => {
  let actualPath = typeof StreamPath === 'string' ? StreamPath : null;

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
  console.log(`[Stream Started] Multi-quality transcode initiating for: ${actualPath}`);

  const parts = actualPath.split('/').filter(Boolean);
  const app = parts[0] || 'live';
  const streamKey = parts[1] || 'teststream';

  const outputDir = path.join(mediaPath, app, streamKey);
  fs.mkdirSync(outputDir, { recursive: true });

  const rtmpInput = `rtmp://localhost:1935/${app}/${streamKey}`;

  if (ffmpegProcesses.has(id)) {
    try { ffmpegProcesses.get(id).kill(); } catch (e) {}
  }

  // ------------------------------------------------------------------
  // MULTI-BITRATE HLS TRANSCODING PARAMETERS (FIXED & ZERO-LATENCY)
  // ------------------------------------------------------------------
  const ffmpegArgs = [
    '-i', rtmpInput,

    // Filter Graph: Clean splitting and scaling without rogue spaces
    '-filter_complex',
    '[0:v]split=3[v1][v2][v3];[v2]scale=w=1280:h=720[v2out];[v3]scale=w=854:h=480[v3out]',

    // Video Stream 0: 1080p
    '-map', '[v1]',
    '-c:v:0', 'libx264',
    '-preset:v:0', 'ultrafast',
    '-tune:v:0', 'zerolatency',
    '-b:v:0', '3500k',
    '-maxrate:v:0', '3800k',
    '-bufsize:v:0', '5000k',
    '-g:v:0', '60',
    '-sc_threshold:v:0', '0',

    // Video Stream 1: 720p
    '-map', '[v2out]',
    '-c:v:1', 'libx264',
    '-preset:v:1', 'ultrafast',
    '-tune:v:1', 'zerolatency',
    '-b:v:1', '1800k',
    '-maxrate:v:1', '2000k',
    '-bufsize:v:1', '3000k',
    '-g:v:1', '60',
    '-sc_threshold:v:1', '0',

    // Video Stream 2: 480p
    '-map', '[v3out]',
    '-c:v:2', 'libx264',
    '-preset:v:2', 'ultrafast',
    '-tune:v:2', 'zerolatency',
    '-b:v:2', '800k',
    '-maxrate:v:2', '900k',
    '-bufsize:v:2', '1200k',

    // Audio Mapping (Clean array mappings for all 3 variants)
    '-map', '0:a', '-c:a:0', 'aac', '-b:a:0', '128k',
    '-map', '0:a', '-c:a:1', 'aac', '-b:a:1', '128k',
    '-map', '0:a', '-c:a:2', 'aac', '-b:a:2', '96k',

    // HLS Format Options (Lightweight playlist windowing for live streams)
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-var_stream_map', 'v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p',
    '-master_pl_name', 'index.m3u8',
    path.join(outputDir, '%v.m3u8')
  ];

  const ffmpegProc = spawn(FFMPEG_PATH, ffmpegArgs);
  ffmpegProcesses.set(id, ffmpegProc);

  ffmpegProc.stderr.on('data', (data) => {
    const str = data.toString();
    if (str.includes('frame=') || str.includes('Error')) {
      console.log(`[FFmpeg Log]: ${str.trim()}`);
    }
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
