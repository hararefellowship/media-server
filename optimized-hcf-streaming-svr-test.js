const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { webcrypto } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const NodeMediaServer = require('node-media-server');
const axios = require('axios');

const API_BASE_URL = process.env.API_BASE_URL || 'http://host.docker.internal:7002';
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FALLBACK_STREAM_KEY = '1970-teststream';
const MAX_FFMPEG_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;

// Polyfill webcrypto for Node environment
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// ------------------------------------------------------------------
// 1. PATHS & DIRECTORY CREATION
// ------------------------------------------------------------------
const mediaPath = path.join(__dirname, 'media');
fs.mkdirSync(mediaPath, { recursive: true });

// Module-scoped process & session registries (so donePublish sees everything)
const hlsProcesses = new Map();       // sessionId -> ChildProcess
const mp4Processes = new Map();       // sessionId -> ChildProcess
const activeSessions = new Set();     // sessionIds currently live
const retryTimers = new Map();        // sessionId -> Set<Timeout>
const sessionMeta = new Map();        // sessionId -> { app, streamKey, mp4OutputPath }

function registerTimer(sessionId, timer) {
  if (!retryTimers.has(sessionId)) {
    retryTimers.set(sessionId, new Set());
  }
  retryTimers.get(sessionId).add(timer);
  return timer;
}

function clearSessionTimers(sessionId) {
  const timers = retryTimers.get(sessionId);
  if (timers) {
    for (const t of timers) clearTimeout(t);
    retryTimers.delete(sessionId);
  }
}

function sleep(ms, sessionId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (sessionId && retryTimers.has(sessionId)) {
        retryTimers.get(sessionId).delete(timer);
      }
      resolve();
    }, ms);
    if (sessionId) registerTimer(sessionId, timer);
  });
}

function killProcess(procMap, sessionId, signal = 'SIGINT') {
  const proc = procMap.get(sessionId);
  if (!proc) return;
  procMap.delete(sessionId);

  if (!proc.killed && proc.exitCode === null) {
    try {
      proc.kill(signal);
    } catch (_) {}

    // Escalate to SIGKILL if process does not exit promptly
    const forceKillTimer = setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch (_) {}
      }
    }, 3000);
    if (forceKillTimer.unref) forceKillTimer.unref();
  }
}

function cleanupSession(sessionId, reason = 'session ended') {
  console.log(`[Cleanup] Session ${sessionId} (${reason})`);
  activeSessions.delete(sessionId);
  clearSessionTimers(sessionId);
  killProcess(hlsProcesses, sessionId, 'SIGINT');
  killProcess(mp4Processes, sessionId, 'SIGINT');
  sessionMeta.delete(sessionId);
}

// ------------------------------------------------------------------
// 2. API RETRY WITH EXPONENTIAL BACKOFF + FALLBACK
// ------------------------------------------------------------------
async function fetchActiveStreamKey(retries = 3, baseDelayMs = 400) {
  const targetUrl = `${API_BASE_URL}/api/v1/streams/getActiveLiveStream`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[API Request] Fetching active stream (attempt ${attempt}/${retries}): ${targetUrl}`);
      const response = await axios.get(targetUrl, { timeout: 3000 });
      const streamKey = response?.data?.body?.streamKey;
      if (streamKey && typeof streamKey === 'string') {
        console.log('[API Success] Fetched Stream Key:', streamKey);
        return streamKey;
      }
      throw new Error('Response missing valid body.streamKey');
    } catch (err) {
      console.warn(`[API Retry ${attempt}/${retries}] Failed: ${err.message}`);
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await sleep(delay);
      }
    }
  }

  console.error(`[API Fallback] Using fallback streamKey: ${FALLBACK_STREAM_KEY}`);
  return FALLBACK_STREAM_KEY;
}

// ------------------------------------------------------------------
// 3. FFMPEG ARGUMENT BUILDERS
// ------------------------------------------------------------------
function buildHlsArgs(rtmpInput, outputDir) {
  const hlsPlaylistPattern = path.join(outputDir, 'v%v', 'stream.m3u8').replace(/\\/g, '/');

  return [
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

    hlsPlaylistPattern,
  ];
}

function buildMp4Args(rtmpInput, mp4OutputPath) {
  return [
    '-y',
    '-fflags', '+genpts',
    '-i', rtmpInput,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+frag_keyframe+empty_moov',
    mp4OutputPath,
  ];
}

// ------------------------------------------------------------------
// 4. SUPERVISED FFMPEG RUNNERS (WITH CRASH RECOVERY)
// ------------------------------------------------------------------
async function runHlsWithRetry(sessionId, rtmpInput, outputDir, attempt = 1) {
  if (!activeSessions.has(sessionId)) return;

  // Ensure any stale process for this session is stopped before starting
  killProcess(hlsProcesses, sessionId, 'SIGKILL');

  const args = buildHlsArgs(rtmpInput, outputDir);
  console.log(`[HLS FFmpeg] Starting (session ${sessionId}, attempt ${attempt}/${MAX_FFMPEG_RETRIES})`);

  const proc = spawn(FFMPEG_PATH, args);
  hlsProcesses.set(sessionId, proc);

  proc.stderr.on('data', (data) => {
    console.log(`[HLS FFmpeg ${sessionId}]: ${data.toString().trim()}`);
  });

  proc.on('error', (err) => {
    console.error(`[HLS FFmpeg ${sessionId}] Spawn error: ${err.message}`);
  });

  proc.on('close', async (code, signal) => {
    if (hlsProcesses.get(sessionId) === proc) {
      hlsProcesses.delete(sessionId);
    }

    console.log(`[HLS FFmpeg ${sessionId}] Exited with code=${code}, signal=${signal}`);

    // Do not retry if stream intentionally ended or max retries reached
    if (!activeSessions.has(sessionId)) return;
    if (code === 0) return;

    if (attempt >= MAX_FFMPEG_RETRIES) {
      console.error(`[HLS FFmpeg ${sessionId}] Exhausted ${MAX_FFMPEG_RETRIES} retries; giving up.`);
      return;
    }

    const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
    console.warn(`[HLS FFmpeg ${sessionId}] Restarting in ${delay}ms (next attempt ${attempt + 1})...`);
    await sleep(delay, sessionId);

    if (activeSessions.has(sessionId)) {
      runHlsWithRetry(sessionId, rtmpInput, outputDir, attempt + 1);
    }
  });
}

async function runMp4WithRetry(sessionId, rtmpInput, mp4OutputPath, attempt = 1) {
  if (!activeSessions.has(sessionId)) return;

  killProcess(mp4Processes, sessionId, 'SIGKILL');

  const args = buildMp4Args(rtmpInput, mp4OutputPath);
  console.log(`[MP4 FFmpeg] Starting recording -> ${mp4OutputPath} (attempt ${attempt}/${MAX_FFMPEG_RETRIES})`);

  const proc = spawn(FFMPEG_PATH, args);
  mp4Processes.set(sessionId, proc);

  proc.stderr.on('data', (data) => {
    console.log(`[MP4 FFmpeg ${sessionId}]: ${data.toString().trim()}`);
  });

  proc.on('error', (err) => {
    console.error(`[MP4 FFmpeg ${sessionId}] Spawn error: ${err.message}`);
  });

  proc.on('close', async (code, signal) => {
    if (mp4Processes.get(sessionId) === proc) {
      mp4Processes.delete(sessionId);
    }

    console.log(`[MP4 FFmpeg ${sessionId}] Exited with code=${code}, signal=${signal}`);

    // If session ended normally, finalize/hand off recording
    if (!activeSessions.has(sessionId)) {
      console.log(`[MP4 FFmpeg ${sessionId}] Recording finalized at ${mp4OutputPath}`);
      // TODO: emit event / publish job to queue for S3 upload & DB update
      return;
    }

    if (code === 0) return;

    if (attempt >= MAX_FFMPEG_RETRIES) {
      console.error(`[MP4 FFmpeg ${sessionId}] Exhausted ${MAX_FFMPEG_RETRIES} retries; giving up.`);
      return;
    }

    const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
    console.warn(`[MP4 FFmpeg ${sessionId}] Restarting recording in ${delay}ms (next attempt ${attempt + 1})...`);
    await sleep(delay, sessionId);

    if (activeSessions.has(sessionId)) {
      runMp4WithRetry(sessionId, rtmpInput, mp4OutputPath, attempt + 1);
    }
  });
}

// ------------------------------------------------------------------
// 5. STANDALONE EXPRESS SERVER (HLS FILE SERVING & SESSION API)
// ------------------------------------------------------------------
const httpApp = express();
httpApp.use(cors());
httpApp.use(express.json());
httpApp.use('/', express.static(mediaPath));

httpApp.listen(8000, () => {
  console.log('[HLS Web Server] Serving HLS streams at http://localhost:8000/');
});

httpApp.post('/api/streams/create', async (req, res) => {
  const { title, streamKey } = req.body || {};
  const app = 'live';
  const rtmpUrl = `rtmp://localhost:1935/${app}`;
  const playbackUrl = `http://localhost:8000/${app}/${streamKey}/index.m3u8`;

  try {
    // Persist session to DB if needed, returning per-request URLs safely
    res.json({ success: true, title, streamKey, rtmpUrl, playbackUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// 6. NODE MEDIA SERVER (RTMP ONLY)
// ------------------------------------------------------------------
const nmsConfig = {
  logType: 3,
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
};

const nms = new NodeMediaServer(nmsConfig);

nms.on('postPublish', async (id, StreamPath) => {
  // Replace any prior session under the same id
  cleanupSession(id, 'new publish for session id');
  activeSessions.add(id);

  let actualPath = typeof StreamPath === 'string' ? StreamPath : null;

  if (!actualPath && nms.sessions) {
    if (typeof nms.sessions.get === 'function') {
      const sess = nms.sessions.get(id);
      actualPath = sess ? sess.publishStreamPath : null;
    } else if (nms.sessions[id]) {
      actualPath = nms.sessions[id].publishStreamPath;
    }
  }

  const dynamicStreamKey = await fetchActiveStreamKey(3, 400);

  // If session ended while awaiting the API call, abort cleanly
  if (!activeSessions.has(id)) {
    console.log(`[Stream ${id}] Ended before API lookup completed; skipping FFmpeg start.`);
    return;
  }

  if (!actualPath) {
    actualPath = `/live/${dynamicStreamKey}`;
  }

  const parts = actualPath.split('/').filter(Boolean);
  const app = parts[0] || 'live';
  const streamKey = parts[1] || dynamicStreamKey;

  const outputDir = path.join(mediaPath, app, streamKey);
  fs.mkdirSync(outputDir, { recursive: true });

  const mp4OutputPath = path.join(outputDir, `${streamKey}.mp4`);
  const rtmpInput = `rtmp://localhost:1935/${app}/${streamKey}`;

  sessionMeta.set(id, { app, streamKey, mp4OutputPath });

  console.log('\n========================================');
  console.log(`[Stream Started] id=${id} path=${actualPath}`);
  console.log(`[HLS Output] ${path.join(outputDir, 'index.m3u8')}`);
  console.log(`[MP4 Output] ${mp4OutputPath}`);

  runHlsWithRetry(id, rtmpInput, outputDir, 1);
  runMp4WithRetry(id, rtmpInput, mp4OutputPath, 1);
});

nms.on('donePublish', (id) => {
  cleanupSession(id, 'donePublish');
});

// Graceful shutdown hook for container/process stops
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[Shutdown] Received ${sig}, stopping all active streams...`);
    for (const id of Array.from(activeSessions)) {
      cleanupSession(id, sig);
    }
    process.exit(0);
  });
}

nms.run();