const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { webcrypto } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const NodeMediaServer = require('node-media-server');

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const mediaPath = path.join(__dirname, 'media');
const FFMPEG_PATH = '/usr/bin/ffmpeg'; // Check path with `which ffmpeg`

if (!fs.existsSync(mediaPath)) {
  fs.mkdirSync(mediaPath, { recursive: true });
}

const ffmpegProcesses = new Map();

// ------------------------------------------------------------------
// STANDALONE EXPRESS SERVER
// ------------------------------------------------------------------
const httpApp = express();
httpApp.use(cors());
httpApp.use('/', express.static(mediaPath));

httpApp.listen(8000, () => {
  console.log('[HLS Web Server] Serving multi-bitrate HLS streams at http://localhost:8000/');
});

httpApp.listen(8443, () => {
  console.log('[HLS Web Server] Serving multi-bitrate HLS streams at http://localhost:8000/');
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
  },

  // MUST configure the HTTPS block for secure connections
  // https: {
  //   port: 8443, // Make sure this port is open on your firewall/security group
  //   key: '/etc/letsencrypt/live/media.test.hararechristianfellowship.org/privkey.pem',
  //   cert: '/etc/letsencrypt/live/media.test.hararechristianfellowship.org/fullchain.pem'
  // }

  // trans: {
  //   ffmpeg: '/usr/bin/ffmpeg', // Path to your FFmpeg binary (adjust if on Windows, e.g., 'C:/ffmpeg/bin/ffmpeg.exe')
  //   tasks: [
  //     {
  //       app: 'live',
  //       mp4: true,           // Enables automatic MP4 recording
  //       mp4Flags: '[movflags=+faststart]', // Optional: optimizes MP4 for web playback
  //     }
  //   ]
  // }
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
    actualPath = '/live/teststreams';
  }

  console.log(`\n========================================`);
  console.log(`[Stream Started] Multi-quality transcode initiating for: ${actualPath}`);

  const parts = actualPath.split('/').filter(Boolean);
  const app = parts[0] || 'live';
  const streamKey = parts[1] || 'teststreams';


  // Define your production or local base URL
  const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

  // 1. GENERATE THE DYNAMIC URL
  const hlsStreamUrl = `${BASE_URL}/${app}/${streamKey}/index.m3u8`;

  console.log(`\n========================================`);
  console.log(`[Stream Started] Target URL: ${hlsStreamUrl}`);

  // 2. SAVE TO YOUR DATABASE (Example concept)
  try {
    /* 
      // Example using Prisma, Mongoose, or Knex:
      await db.StreamSession.create({
        streamKey: streamKey,
        app: app,
        playbackUrl: hlsStreamUrl,
        status: 'LIVE',
        startedAt: new Date()
      });
    */
    console.log(`[Database] Stream record successfully saved for key: ${streamKey}`);
  } catch (dbError) {
    console.error(`[Database Error] Failed to save stream record:`, dbError);
  }

  const outputDir = path.join(mediaPath, app, streamKey);
  fs.mkdirSync(outputDir, { recursive: true });

  const rtmpInput = `rtmp://localhost:1935/${app}/${streamKey}`;

  if (ffmpegProcesses.has(id)) {
    try { ffmpegProcesses.get(id).kill(); } catch (e) {}
  }

  // Multi-bitrate HLS Transcoding Parameters
  // Multi-bitrate HLS Transcoding Parameters (FIXED PARSING)
  const ffmpegArgs = [
    '-i', rtmpInput,

    // Filter Graph: Split input into 3 streams and scale 720p and 480p
    '-filter_complex',
    '[0:v]split=3[v1][v2][v3];[v2]scale=w=1280:h=720[v2out];[v3]scale=w=854:h=480[v3out]',

    // Video 1: 1080p (Original Stream Copy)
    '-map', '[v1]', '-c:v:0', 'libx264', '-b:v:0', '4000k', '-maxrate:v:0', '4200k', '-bufsize:v:0', '6000k',
    
    // Video 2: 720p
    '-map', '[v2out]', '-c:v:1', 'libx264', '-b:v:1', '2200k', '-maxrate:v:1', '2400k', '-bufsize:v:1', '3500k',
    
    // Video 3: 480p
    '-map', '[v3out]', '-c:v:2', 'libx264', '-b:v:2', '1000k', '-maxrate:v:2', '1100k', '-bufsize:v:2', '1500k',

    // Map Audio to all three streams
    '-map', '0:a?', '-c:a:0', 'aac', '-b:a:0', '128k',
    '-map', '0:a?', '-c:a:1', 'aac', '-b:a:1', '128k',
    '-map', '0:a?', '-c:a:2', 'aac', '-b:a:2', '96k',

    // Encoding Performance Options
    '-preset', 'veryfast',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',

    // HLS Output Format Options
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'delete_segments+independent_segments',
    '-master_pl_name', 'index.m3u8',
    '-var_stream_map', 'v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p',
    path.join(outputDir, 'v%v/stream.m3u8')
  ];

  const ffmpegProc = spawn(FFMPEG_PATH, ffmpegArgs);
  ffmpegProcesses.set(id, ffmpegProc);

  ffmpegProc.stderr.on('data', (data) => {
    // Suppress minor info lines, print core transcode progress
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