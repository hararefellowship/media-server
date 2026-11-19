const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { webcrypto } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const NodeMediaServer = require('node-media-server');
const axios = require('axios'); // Import axios (if using CommonJS in Node.js)
const https = require('https'); // 1. Added native HTTPS module

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

// ------------------------------------------------------------------
// SSL CERTIFICATE CONFIGURATION
// ------------------------------------------------------------------
const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/test.hararechristianfellowship.org/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/test.hararechristianfellowship.org/fullchain.pem')
};

// ------------------------------------------------------------------
// HTTPS EXPRESS SERVER (SERVES HLS MEDIA)
// ------------------------------------------------------------------

// Create secure HTTPS server on Port 8443 for HLS static files
https.createServer(sslOptions, httpApp).listen(8443, () => {
  console.log('[HLS Web Server] Serving multi-bitrate HLS streams securely at https://domain.co.zw:8443/');
});

// Start the Express server on port 8000
httpApp.listen(8000, () => {
  console.log('[HLS Web Server] Serving HLS streams at http://localhost:8000/');
});

httpApp.use(express.json()); // to parse JSON bodies

let RMTP_URL = null;
// # API endpoint called by Vue.js to create a new broadcast session - we may not need this since we changed the mechanisms
// of how we start the streaming session!
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
    const response = await axios.get('http://localhost:7002/api/v1/streams/getActiveLiveStream');
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

  //const outputPath = path.join(mediaPath, 'recordings', '${streamKey}.mp4`; // Ensure this directory exists!

  //const outputPath = path.join(mediaPath, 'recordings', streamKey, '.mp4'); // Ensure this directory exists!
  //const outputPath = path.join(mediaPath) + `/recordings/${streamKey}.mp4`; // Ensure this directory exists!
  //fs.mkdirSync(outputPath, { recursive: true });

  // Spawn FFmpeg explicitly
  const ffmpegProc = spawn(FFMPEG_PATH, [
    '-i', rtmpInput,
    '-c:v', 'copy',      // Pass H.264 video through directly
    '-c:a', 'aac',       // Convert audio to web-compatible AAC
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'delete_segments',
    m3u8Output,

    // // for mp4 live recording
    // '-y',
    // '-i', rtmpInput, // remove this as we're repeating it
    // '-c', 'copy',
    // '-movflags', '+frag_keyframe+empty_moov', // Crucial for fragmenting MP4 so it's readable if interrupted
    // outputPath
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


  // ==========================================
  // 2. Spawn Second FFmpeg Process for MP4 Recording :: cleaner approach so we dont mix HLS process
  // ==========================================
  // const mp4OutputPath = path.join(outputDir, `${streamKey}.mp4`); // we can change the path to point to our live dir (later)
  // console.log(`[FFmpeg] MP4 Recording Path: ${mp4OutputPath}`);

  // const mp4Processes = new Map();

  // if (mp4Processes.has(id)) {
  //   try { mp4Processes.get(id).kill(); } catch (e) {}
  // }

  // // const mp4Proc = spawn(FFMPEG_PATH, [
  // //   '-y',
  // //   '-i', rtmpInput,
  // //   '-c:v', 'copy',
  // //   '-c:a', 'aac',
  // //   '-movflags', '+frag_keyframe+empty_moov', // Fragment MP4 so it's readable if interrupted
  // //   mp4OutputPath
  // // ]);

  // // the below works, and doesnt corrupt when network changes or jump and skips happen on the video::

  // // todo - we need to save the mp4 file with a specific quality e.g 360p, since the saved file can be large!!! 

  // // Spawn MP4 Recording Process with timestamp fix flags
  // const mp4Proc = spawn(FFMPEG_PATH, [
  //   '-y',
  //   '-fflags', '+genpts',             // Regenerate timestamps to keep them linear
  //   '-i', rtmpInput,
  //   '-c:v', 'copy',
  //   '-c:a', 'aac',
  //   '-avoid_negative_ts', 'make_zero', // Fixes jumping/negative timestamps from live streams
  //   '-movflags', '+frag_keyframe+empty_moov',
  //   mp4OutputPath
  // ]);

  // mp4Processes.set(id, mp4Proc);

  // mp4Proc.stderr.on('data', (data) => {
  //   // Uncomment if you want to inspect MP4 encoding logs:
  //   console.log(`[FFmpeg MP4 Log]: ${data.toString().trim()}`);
  // });

  // mp4Proc.on('close', (code) => {
  //   console.log(`[FFmpeg MP4] Recording saved successfully (Exit code: ${code})`);
  //   mp4Processes.delete(id);

  //   // todo - send a POST request callback to server to process the file to S3 bucket & also save the perm link to DB
  //   // we need to invoke, once is completed to save file as well as stream stopped??
  // });

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
