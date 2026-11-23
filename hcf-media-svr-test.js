const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { webcrypto } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const NodeMediaServer = require('node-media-server');
const axios = require('axios'); // Import axios (if using CommonJS in Node.js)
const https = require('https');
// const API_BASE_URL = process.env.API_BASE_URL || 'http://host.docker.internal:7002';
const API_BASE_URL = process.env.API_BASE_URL || 'https://test.hararechristianfellowship.org';

const ffmpegProcesses = new Map();
const mp4Processes = new Map();

// Polyfill webcrypto for Node environment
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const mediaPath = path.join(__dirname, 'media');
const FFMPEG_PATH = '/usr/bin/ffmpeg'; // Ensure this points to your FFmpeg binary

if (!fs.existsSync(mediaPath)) {
  fs.mkdirSync(mediaPath, { recursive: true });
}

const httpApp = express();
httpApp.use(cors());
httpApp.use('/', express.static(mediaPath));

const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/test.hararechristianfellowship.org/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/test.hararechristianfellowship.org/fullchain.pem')
};

https.createServer(sslOptions, httpApp).listen(8443, () => {
  console.log('[HLS Web Server] Serving multi-bitrate HLS streams securely at https://domain.co.zw:8443/');
});

httpApp.listen(8000, () => {
  console.log('[HLS Web Server] Serving HLS streams at http://localhost:8000/');
});

httpApp.use(express.json()); // to parse JSON bodies

const nmsConfig = {
  logType: 3,
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  }
};

const nms = new NodeMediaServer(nmsConfig);

nms.on('postPublish', async (id, StreamPath) => { // async so we can wait for external services e.g API calls
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

  let dynamicStreamKey;
  const targetUrl = `${API_BASE_URL}/api/v1/streams/getActiveLiveStream`;
  const maxAttempts = 3;
  const baseDelayMs = 400;

  console.log(`[API Request] Fetching active stream from: ${targetUrl}`);

  for(let attempt = 1; attempt <= maxAttempts; attempt++){
    try{
      const response = await axios.get(targetUrl, { timeout: 3000 });
      const streamKey = response.data?.body?.streamKey; 
      if (typeof streamKey === 'string' && streamKey.trim().length > 0) {
        dynamicStreamKey = streamKey;
        console.log('Fetched Stream Key:', dynamicStreamKey);
        break;
      }
      throw new Error('Missing or invalid streamKey in response payload');
    }catch(error){
      const status = error.response?.status;
      const isClientError = status >= 400 && status < 500 && status !== 408 && status !== 429;
      console.warn(`[API Attempt ${attempt}/${maxAttempts}] ${error.message}`);
      
      if (isClientError || attempt === maxAttempts) {
        break;
      }

      const expDelay = baseDelayMs * 2 ** (attempt - 1);
      const jitterMs = Math.floor(Math.random() * 150);
      await new Promise((resolve) => setTimeout(resolve, expDelay + jitterMs));
    }

    if (!dynamicStreamKey) {
      console.error('[Stream Fallback] Using fallback streamKey: 1970-teststream');
      dynamicStreamKey = '1970-teststream';
    }
  }

  if (!actualPath) {
    actualPath = '/live/' + dynamicStreamKey; 
  }
  console.log(`\n========================================================================`);
  console.log(`[Stream Started] StreamPath: ${actualPath}`);

  // Extract application name and stream key
  const parts = actualPath.split('/').filter(Boolean);
  const app = parts[0] || 'live';
  const streamKey = parts[1] || dynamicStreamKey;

  // Ensure output folder structure exists (e.g., ./media/live/2026-10-18M-sunday-school/)
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

  // Multi-bitrate HLS Transcoding Parameters (FIXED PARSING)
  const ffmpegArgs = [
    '-i', rtmpInput,

     // Split input into 4 streams and scale target resolutions
    '-filter_complex',
    '[0:v]split=4[v1][v2][v3][v4];' +
      '[v1]scale=w=960:h=540[v1out];' +
      '[v2]scale=w=854:h=480[v2out];' +
      '[v3]scale=w=640:h=360[v3out];' +
      '[v4]scale=w=256:h=144[v4out]',

    // Video renditions (v:0 .. v:3)
    '-map', '[v1out]', '-c:v:0', 'libx264', '-b:v:0', '1400k', '-maxrate:v:0', '1500k', '-bufsize:v:0', '2100k',
    '-map', '[v2out]', '-c:v:1', 'libx264', '-b:v:1', '1000k', '-maxrate:v:1', '1100k', '-bufsize:v:1', '1500k',
    '-map', '[v3out]', '-c:v:2', 'libx264', '-b:v:2', '600k', '-maxrate:v:2', '650k', '-bufsize:v:2', '900k',
    '-map', '[v4out]', '-c:v:3', 'libx264', '-b:v:3', '150k', '-maxrate:v:3', '165k', '-bufsize:v:3', '250k',

    // Optional audio mapped to all 4 renditions
    '-map', '0:a?', '-c:a:0', 'aac', '-b:a:0', '128k',
    '-map', '0:a?', '-c:a:1', 'aac', '-b:a:1', '96k',
    '-map', '0:a?', '-c:a:2', 'aac', '-b:a:2', '64k',
    '-map', '0:a?', '-c:a:3', 'aac', '-b:a:3', '64k',

    // Encoding performance & keyframe alignment
    '-preset', 'veryfast',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',
    
    // HLS output options
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_playlist_type', 'event',
    '-master_pl_name', 'index.m3u8',
    '-var_stream_map', 'v:0,a:0,name:540p v:1,a:1,name:480p v:2,a:2,name:360p v:3,a:3,name:144p',
    '-hls_segment_type', 'fmp4',
    '-hls_flags', 'delete_segments+independent_segments+program_date_time',

    // FIXED: Ensure forward slashes for FFmpeg's %v pattern across Windows/Linux
    path.join(outputDir, 'v%v', 'stream.m3u8').replace(/\\/g, '/')
  ];

  const ffmpegProc = spawn(FFMPEG_PATH, ffmpegArgs);
  ffmpegProcesses.set(id, ffmpegProc);

  // Pipe FFmpeg output straight to your terminal
  ffmpegProc.stderr.on('data', (data) => {
    console.log(`[FFmpeg Log]: ${data.toString().trim()}`);
  });

  ffmpegProc.on('close', (code) => {
    console.log(`[FFmpeg] Process exited with code ${code}`);
    ffmpegProcesses.delete(id);
  });


  // ==========================================
  // 2. Spawn Second FFmpeg Process for MP4 Recording :: cleaner approach so we dont mix HLS process
  // ==========================================
  const mp4OutputPath = path.join(outputDir, `${streamKey}.mp4`); // we can change the path to point to our live dir (later)
  console.log(`[FFmpeg] MP4 Recording Path: ${mp4OutputPath}`);

  if (mp4Processes.has(id)) {
    try { mp4Processes.get(id).kill(); } catch (e) {}
  }

  // the below works, and doesnt corrupt when network changes or jump and skips happen on the video::

  // todo - we need to save the mp4 file with a specific quality e.g 360p, since the saved file can be large!!!
  const mp4Args = [
    '-y',
    '-fflags', '+genpts', // Regenerate timestamps to keep them linear
    '-i', rtmpInput,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-avoid_negative_ts', 'make_zero', // Fixes jumping/negative timestamps from live streams
    '-movflags', '+frag_keyframe+empty_moov',
    mp4OutputPath
  ]; 
  const mp4Proc = spawn(FFMPEG_PATH, mp4Args);

  mp4Processes.set(id, mp4Proc);

  mp4Proc.stderr.on('data', (data) => {
    // Uncomment if you want to inspect MP4 encoding logs:
    console.log(`[FFmpeg MP4 Log]: ${data.toString().trim()}`);
  });

  mp4Proc.on('close', (code) => {
    console.log(`[FFmpeg MP4] Recording saved successfully (Exit code: ${code})`);
    mp4Processes.delete(id);

    // todo - send a POST request callback to server to process the file to S3 bucket & also save the perm link to DB
    // should we do it inside here or we can use a separate process outside? Event driven architecture? Spring & AWS?
  });

});

nms.on('donePublish', (id) => {
  console.log(`[Stream Ended] Killing FFmpeg process for session ${id}`);
  for (const map of [ffmpegProcesses, mp4Processes]) {
    const proc = map.get(id);
    if (proc) {
      proc.kill('SIGINT');
      map.delete(id);
    }
  }
});

nms.run();