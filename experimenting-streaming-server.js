const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { webcrypto } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const NodeMediaServer = require('node-media-server');
const axios = require('axios'); // Import axios (if using CommonJS in Node.js)

const API_BASE_URL = process.env.API_BASE_URL || 'http://host.docker.internal:7002';

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

httpApp.use(express.json()); // to parse JSON bodies

let RMTP_URL = null;
// # API endpoint called by Vue.js to create a new broadcast session
httpApp.post('/api/streams/create', async (req, res) => {
  console.log('req body: ', req.body);
  const { title } = req.body;
  const { streamKey } = req.body; //`stream_${crypto.randomBytes(4).toString('hex')}`;
  console.log('streamKey: ', streamKey);

  const app = 'live'; // we should make this dir configurable such that if the dir changes on server
  
  const rtmpUrl = `rtmp://localhost:1935/${app}`;
  console.log('rtmpUrl: ', rtmpUrl);

  RMTP_URL = rtmpUrl;
  console.log('RMTP_URL: ', RMTP_URL);

  const playbackUrl = `http://localhost:8000/${app}/${streamKey}/index.m3u8`;
  console.log('playbackUrl: ', playbackUrl);

  // Save initial pending state to DB if desired
  try {
    /* 
      await db.StreamSession.create({
        title: title || 'Untitled Stream',
        streamKey: streamKey,
        app: app,
        playbackUrl: playbackUrl,
        status: 'PENDING'
      });
    */
    res.json({ success: true, streamKey, rtmpUrl, playbackUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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

// To make your NodeMediaServer (nms) backend snippet dynamically pull the stream directory path and stream key from an API
// endpoint or database, you need to make the postPublish event handler async.
// This allows you to await your database query or API call before NodeMediaServer processes the stream path.
nms.on('postPublish', async (id, StreamPath) => {
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
  try {
    const targetUrl = `${API_BASE_URL}/api/v1/streams/getActiveLiveStream`;
    console.log(`[API Request] Fetching active stream from: ${targetUrl}`);
    const response = await axios.get(targetUrl);
    //const response = await axios.get('http://host.docker.internal:7002/api/v1/streams/getActiveLiveStream');
    
    const streamKey = response.data.body.streamKey; 
    console.log('Fetched Stream Key:', streamKey);
    dynamicStreamKey = streamKey;
  } catch (error) {
    console.error('[Stream Error] Failed to fetch stream key from API:', error.message);
    dynamicStreamKey = '1970-teststream'; // Fallback
  }

  if (!actualPath) {
    //actualPath = '/live/2026-10-18M-sunday-school-service'; // this is where we change in the main service
    actualPath = '/live/' + dynamicStreamKey; 
  }

  console.log(`\n========================================`);
  console.log(`[Stream Started] StreamPath: ${actualPath}`);

  // Extract application name and stream key
  const parts = actualPath.split('/').filter(Boolean);
  const app = parts[0] || 'live';
  //const streamKey = parts[1] || '1970-teststream';
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

    // Filter Graph: Split input into 6 streams and scale each target resolution
    '-filter_complex',
    '[0:v]split=6[v1][v2][v3][v4][v5][v6];' +
    '[v2]scale=w=1280:h=720[v2out];' +
    '[v3]scale=w=960:h=540[v3out];' +
    '[v4]scale=w=854:h=480[v4out];' +
    '[v5]scale=w=640:h=360[v5out];' +
    '[v6]scale=w=256:h=144[v6out]',

    // Video 0: 1080p (Original Stream Copy / High Quality)
    '-map', '[v1]', '-c:v:0', 'libx264', '-b:v:0', '4000k', '-maxrate:v:0', '4200k', '-bufsize:v:0', '6000k',
    
    // Video 1: 720p
    '-map', '[v2out]', '-c:v:1', 'libx264', '-b:v:1', '2200k', '-maxrate:v:1', '2400k', '-bufsize:v:1', '3500k',
    
    // Video 2: 540p (New)
    '-map', '[v3out]', '-c:v:2', 'libx264', '-b:v:2', '1400k', '-maxrate:v:2', '1500k', '-bufsize:v:2', '2100k',

    // Video 3: 480p
    '-map', '[v4out]', '-c:v:3', 'libx264', '-b:v:3', '1000k', '-maxrate:v:3', '1100k', '-bufsize:v:3', '1500k',

    // Video 4: 360p (New)
    '-map', '[v5out]', '-c:v:4', 'libx264', '-b:v:4', '6000k' /* wait, 600k */, '-b:v:4', '600k', '-maxrate:v:4', '650k', '-bufsize:v:4', '900k',

    // Video 5: 144p (New)
    '-map', '[v6out]', '-c:v:5', 'libx264', '-b:v:5', '150k', '-maxrate:v:5', '165k', '-bufsize:v:5', '250k',

    // Map Audio to all six streams
    '-map', '0:a?', '-c:a:0', 'aac', '-b:a:0', '128k',
    '-map', '0:a?', '-c:a:1', 'aac', '-b:a:1', '128k',
    '-map', '0:a?', '-c:a:2', 'aac', '-b:a:2', '128k',
    '-map', '0:a?', '-c:a:3', 'aac', '-b:a:3', '96k',
    '-map', '0:a?', '-c:a:4', 'aac', '-b:a:4', '96k',
    '-map', '0:a?', '-c:a:5', 'aac', '-b:a:5', '64k',

    // Encoding Performance Options
    '-preset', 'veryfast',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',

    // HLS Output Format Options
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_playlist_type', 'event',
    '-master_pl_name', 'index.m3u8',
    '-var_stream_map', 'v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:540p v:3,a:3,name:480p v:4,a:4,name:360p v:5,a:5,name:144p',    
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

  const mp4Processes = new Map();

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
  const proc = ffmpegProcesses.get(id);
  if (proc) {
    proc.kill('SIGINT');
    ffmpegProcesses.delete(id);
  }
});

nms.run();