#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * HLS data meter
 *
 * Behaves like one viewer watching an HLS stream (the way video.js/VHS and hls.js do it) and measures
 * how much data that viewer downloads: playlist reloads and video/audio segments,
 * separately. It then projects the total for a whole service and checks it against a budget.
 *
 * Live streams:   polls the media playlist like a player and downloads each new segment.
 * Ended streams:  (playlist has #EXT-X-ENDLIST) sizes every segment with HEAD requests,
 *                 so the full recording is measured without downloading the video.
 *
 * No dependencies. Node.js 18+.
 *
 *   node tools/hls-data-meter.js <playlist-url> [options]
 *   node tools/hls-data-meter.js --help
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { parseArgs } = require('node:util');

const HELP = `
HLS data meter: measure how much data one viewer uses on an HLS stream.

Usage:
  node tools/hls-data-meter.js <playlist-url> [options]

  <playlist-url>   Master playlist (…/index.m3u8) or a single rendition (…/v360p/stream.m3u8)

Options:
  -l, --level <q>      Rendition to watch: 540p | 480p | 360p | 144p | lowest | highest   (default: 360p)
  -d, --duration <s>   Seconds to watch a live stream before reporting                     (default: 120)
  -s, --service <min>  Service length to project the total for, in minutes                 (default: 120)
  -b, --budget <MB>    Data budget per viewer per service, in MB (1 MB = 1,000,000 bytes)  (default: 500)
      --interval <ms>  Force the playlist reload interval (default: like the players; target
                       duration when the playlist changed, half of it when it didn't)
      --head           Measure segment sizes with HEAD requests instead of downloading them
                       (uses almost no data; playlist sizes are still measured for real)
      --json           Print the report as JSON (progress goes to stderr)
  -h, --help           Show this help

Examples:
  node tools/hls-data-meter.js https://test.hararechristianfellowship.org:8443/live/<streamKey>/index.m3u8
  node tools/hls-data-meter.js <url> --level 540p --duration 300 --service 150
  node tools/hls-data-meter.js <url> --head --json > report.json

Finding the playlist URL: open the service page, press F12 → Network, filter "m3u8", start the video.
Press Ctrl+C at any time to stop early and print the report.
`;

const MB = 1_000_000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Options
 * @property {string} url
 * @property {string} level
 * @property {number} duration   seconds
 * @property {number} service    seconds
 * @property {number} budget     bytes
 * @property {number|null} interval  ms
 * @property {boolean} head
 * @property {boolean} json
 */

/** @returns {Options} */
function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        level: { type: 'string', short: 'l', default: '360p' },
        duration: { type: 'string', short: 'd', default: '120' },
        service: { type: 'string', short: 's', default: '120' },
        budget: { type: 'string', short: 'b', default: '500' },
        interval: { type: 'string' },
        head: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(`${/** @type {Error} */ (err).message}\nRun with --help for usage.`);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
  }

  /** @param {string|undefined} v @param {string} name */
  const positive = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number (got "${v}")`);
    return n;
  };

  let url;
  try {
    url = new URL(positionals[0]).href;
  } catch {
    fail(`Not a valid URL: ${positionals[0]}`);
  }

  return {
    url,
    level: String(values.level).toLowerCase(),
    duration: positive(values.duration, 'duration'),
    service: positive(values.service, 'service') * 60,
    budget: positive(values.budget, 'budget') * MB,
    interval: values.interval === undefined ? null : positive(values.interval, 'interval'),
    head: Boolean(values.head),
    json: Boolean(values.json),
  };
}

/** @param {string} msg @returns {never} */
function fail(msg) {
  process.stderr.write(`hls-data-meter: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP: raw node:http(s) so we can count bytes as they arrive over the wire
// (fetch() decompresses transparently and hides the real transfer size).
// ---------------------------------------------------------------------------

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }),
};

/**
 * @typedef {object} Response
 * @property {number} status
 * @property {Buffer} body          decoded body (empty for HEAD)
 * @property {number} wireBytes     body bytes as transferred (compressed if the server compressed)
 * @property {number} headerBytes   approximate size of the response status line + headers
 * @property {string|null} encoding content-encoding, if any
 * @property {number|null} contentLength
 */

/**
 * @param {string} url
 * @param {'GET'|'HEAD'} [method]
 * @param {number} [redirects]
 * @returns {Promise<Response>}
 */
function request(url, method = 'GET', redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method,
        agent: agents[/** @type {'http:'|'https:'} */ (u.protocol)],
        // Same as a browser: we accept compression, so we measure what a real viewer would get.
        headers: { 'user-agent': 'hcf-hls-data-meter/1.0', accept: '*/*', 'accept-encoding': 'gzip, br, deflate' },
        timeout: 20_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(request(new URL(res.headers.location, u).href, method, redirects - 1));
          return;
        }
        let headerBytes = 17 + 2; // "HTTP/1.1 200 OK\r\n" + final "\r\n"
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          headerBytes += res.rawHeaders[i].length + res.rawHeaders[i + 1].length + 4; // "k: v\r\n"
        }
        /** @type {Buffer[]} */
        const chunks = [];
        let wireBytes = 0;
        res.on('data', (c) => {
          chunks.push(c);
          wireBytes += c.length;
        });
        res.on('error', reject);
        res.on('end', () => {
          if (status >= 400) {
            reject(new Error(`HTTP ${status} for ${url}`));
            return;
          }
          const raw = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'] ?? null;
          let body = raw;
          try {
            if (encoding === 'gzip') body = zlib.gunzipSync(raw);
            else if (encoding === 'br') body = zlib.brotliDecompressSync(raw);
            else if (encoding === 'deflate') body = zlib.inflateSync(raw);
          } catch (err) {
            reject(err);
            return;
          }
          const cl = res.headers['content-length'];
          resolve({ status, body, wireBytes, headerBytes, encoding, contentLength: cl ? Number(cl) : null });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Playlist parsing (only what we need)
// ---------------------------------------------------------------------------

/** @param {string} s */
function parseAttributes(s) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

/**
 * @typedef {object} Variant
 * @property {string} name        e.g. "360p"
 * @property {string} url
 * @property {number} bandwidth   peak, bits/s
 * @property {number} averageBandwidth bits/s (falls back to peak)
 * @property {string} resolution
 */

/** @param {string} text @param {string} baseUrl @returns {Variant[]} */
function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  /** @type {Variant[]} */
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = parseAttributes(lines[i].slice('#EXT-X-STREAM-INF:'.length));
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) break;
    const url = new URL(lines[j].trim(), baseUrl).href;
    const height = a.RESOLUTION ? a.RESOLUTION.split('x')[1] : null;
    const bandwidth = Number(a.BANDWIDTH) || 0;
    variants.push({
      name: height ? `${height}p` : url.split('/').slice(-2, -1)[0] || url,
      url,
      bandwidth,
      averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || bandwidth,
      resolution: a.RESOLUTION || '?',
    });
  }
  return variants;
}

/**
 * @typedef {object} MediaPlaylist
 * @property {number} targetDuration
 * @property {number} mediaSequence
 * @property {boolean} endList
 * @property {string|null} playlistType
 * @property {string|null} mapUri
 * @property {{uri:string, duration:number}[]} segments
 * @property {number} headerBytes   bytes before the first segment entry
 */

/** @param {string} text @returns {MediaPlaylist} */
function parseMedia(text) {
  /** @type {MediaPlaylist} */
  const pl = { targetDuration: 0, mediaSequence: 0, endList: false, playlistType: null, mapUri: null, segments: [], headerBytes: 0 };
  let pendingDuration = null;
  let offset = 0;
  let headerFound = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) pl.targetDuration = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) pl.mediaSequence = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) pl.playlistType = line.split(':')[1].trim();
    else if (line.startsWith('#EXT-X-ENDLIST')) pl.endList = true;
    else if (line.startsWith('#EXT-X-MAP:')) pl.mapUri = parseAttributes(line.slice('#EXT-X-MAP:'.length)).URI ?? null;
    else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length));
      if (!headerFound) {
        pl.headerBytes = offset;
        headerFound = true;
      }
    } else if (line.trim() && !line.startsWith('#') && pendingDuration !== null) {
      pl.segments.push({ uri: line.trim(), duration: pendingDuration });
      pendingDuration = null;
    }
    offset += Buffer.byteLength(line) + 1;
  }
  return pl;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Stats
 * @property {number} startedAt
 * @property {number} masterBytes
 * @property {{requests:number, wireBytes:number, decodedBytes:number, httpHeaderBytes:number, gapsMs:number[], last:Buffer|null, lastParsed:MediaPlaylist|null, first:MediaPlaylist|null, encodings:Set<string>, stalledLoads:number, stalledBytes:number, stalledSec:number}} playlist
 * @property {{count:number, bytes:number, contentSeconds:number, initBytes:number, errors:number}} segments
 * @property {string} [rendition]
 * @property {Variant[]} [variants]
 */

/** @returns {Stats} */
function newStats() {
  return {
    startedAt: Date.now(),
    masterBytes: 0,
    playlist: { requests: 0, wireBytes: 0, decodedBytes: 0, httpHeaderBytes: 0, gapsMs: [], last: null, lastParsed: null, first: null, encodings: new Set(), stalledLoads: 0, stalledBytes: 0, stalledSec: 0 },
    segments: { count: 0, bytes: 0, contentSeconds: 0, initBytes: 0, errors: 0 },
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Watch a live media playlist the way video.js (VHS) and hls.js do.
 * @param {string} mediaUrl @param {Options} opts @param {Stats} stats @param {() => boolean} stopped
 * @param {(msg: string) => void} log
 */
async function measureLive(mediaUrl, opts, stats, stopped, log) {
  /** @type {{url:string, duration:number}[]} */
  const queue = [];
  /** @type {Promise<void>|null} */
  let worker = null;
  let nextSeq = -1;
  let lastNewest = -1;
  let initFetched = false;
  let lastRequestAt = 0;
  let lastProgressAt = Date.now();
  let lastChangeAt = 0; // when a new segment last appeared
  let targetMs = 2000;
  let stallWarned = false;
  // A playlist that hasn't gained a segment for this long means the broadcast stopped or the encoder stalled.
  // Players then poll faster (every half target duration), so those reloads are counted separately and kept
  // out of the reload interval used for the projection.
  const stallAfterMs = () => 3 * targetMs;
  const giveUpAfterMs = 60_000;
  const deadline = Date.now() + opts.duration * 1000;

  const fetchSegment = async (/** @type {string} */ url) => {
    const r = await request(url, opts.head ? 'HEAD' : 'GET');
    return (opts.head ? r.contentLength ?? 0 : r.wireBytes) + r.headerBytes;
  };

  // One segment at a time, like a player filling its buffer.
  const runWorker = async () => {
    while (queue.length) {
      const seg = /** @type {{url:string, duration:number}} */ (queue.shift());
      try {
        stats.segments.bytes += await fetchSegment(seg.url);
        stats.segments.count += 1;
        stats.segments.contentSeconds += seg.duration;
      } catch (err) {
        stats.segments.errors += 1;
        log(`  ! segment failed: ${/** @type {Error} */ (err).message}`);
      }
    }
    worker = null;
  };

  while (!stopped() && Date.now() < deadline) {
    const started = Date.now();
    const stalled = lastChangeAt > 0 && started - lastChangeAt > stallAfterMs();
    if (lastRequestAt && !stalled) stats.playlist.gapsMs.push(started - lastRequestAt);
    if (lastRequestAt && stalled) stats.playlist.stalledSec += (started - lastRequestAt) / 1000;
    lastRequestAt = started;

    let r;
    try {
      r = await request(mediaUrl);
    } catch (err) {
      log(`  ! playlist failed: ${/** @type {Error} */ (err).message}`);
      await sleep(2000);
      continue;
    }
    const pl = parseMedia(r.body.toString('utf8'));
    stats.playlist.requests += 1;
    stats.playlist.wireBytes += r.wireBytes;
    stats.playlist.decodedBytes += r.body.length;
    stats.playlist.httpHeaderBytes += r.headerBytes;
    stats.playlist.encodings.add(r.encoding ?? 'none');
    stats.playlist.last = r.body;
    stats.playlist.lastParsed = pl;
    if (!stats.playlist.first) stats.playlist.first = pl;
    targetMs = (pl.targetDuration || 2) * 1000;
    if (stalled) {
      stats.playlist.stalledLoads += 1;
      stats.playlist.stalledBytes += r.wireBytes + r.headerBytes;
    }

    if (!initFetched && pl.mapUri) {
      initFetched = true;
      try {
        stats.segments.initBytes += await fetchSegment(new URL(pl.mapUri, mediaUrl).href);
      } catch (err) {
        log(`  ! init segment failed: ${/** @type {Error} */ (err).message}`);
      }
    }

    const newest = pl.mediaSequence + pl.segments.length - 1;
    // Players join a live stream ~3 target durations behind the live edge (VHS and hls.js both do this).
    if (nextSeq < 0) nextSeq = Math.max(pl.mediaSequence, newest - 2);
    for (; nextSeq <= newest; nextSeq++) {
      const seg = pl.segments[nextSeq - pl.mediaSequence];
      if (seg) queue.push({ url: new URL(seg.uri, mediaUrl).href, duration: seg.duration });
    }
    if (queue.length && !worker) worker = runWorker();

    if (Date.now() - lastProgressAt >= 10_000) {
      lastProgressAt = Date.now();
      log(progressLine(stats));
    }

    if (pl.endList) {
      log('  Stream ended (#EXT-X-ENDLIST). Stopping.');
      break;
    }

    const updated = newest > lastNewest;
    lastNewest = newest;
    if (updated) {
      lastChangeAt = Date.now();
      if (stallWarned) log('  Playlist is updating again.');
      stallWarned = false;
    } else if (lastChangeAt && Date.now() - lastChangeAt > stallAfterMs() && !stallWarned) {
      stallWarned = true;
      log(`  ⚠ No new segment for ${Math.round((Date.now() - lastChangeAt) / 1000)}s: the broadcast may have stopped (no #EXT-X-ENDLIST).`);
    }
    if (lastChangeAt && Date.now() - lastChangeAt > giveUpAfterMs) {
      log(`  Stream has not updated for ${giveUpAfterMs / 1000}s. Stopping.`);
      break;
    }
    const td = targetMs;
    const interval = opts.interval ?? (updated ? td : td / 2);
    await sleep(Math.max(0, interval - (Date.now() - started)));
  }

  // Let the last segment downloads finish (bounded).
  if (worker) await Promise.race([worker, sleep(30_000)]);
}

/**
 * Ended stream (VOD): a viewer loads the playlist once, then every segment.
 * Size every segment with HEAD so the whole recording is measured without downloading it.
 * @param {string} mediaUrl @param {MediaPlaylist} pl @param {Stats} stats @param {(msg: string) => void} log
 */
async function measureVod(mediaUrl, pl, stats, log) {
  log(`  Stream has ended (VOD). Sizing all ${pl.segments.length} segments with HEAD requests (no video downloaded)…`);
  if (pl.mapUri) {
    const r = await request(new URL(pl.mapUri, mediaUrl).href, 'HEAD');
    stats.segments.initBytes += (r.contentLength ?? 0) + r.headerBytes;
  }
  let i = 0;
  const next = async () => {
    while (i < pl.segments.length) {
      const seg = pl.segments[i++];
      try {
        const r = await request(new URL(seg.uri, mediaUrl).href, 'HEAD');
        stats.segments.bytes += (r.contentLength ?? 0) + r.headerBytes;
        stats.segments.count += 1;
        stats.segments.contentSeconds += seg.duration;
      } catch {
        stats.segments.errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, next));
}

// ---------------------------------------------------------------------------
// Model and report
// ---------------------------------------------------------------------------

/**
 * gzip ratio of a playlist like `text` but with `entries` segment entries, built by repeating its
 * last entry with increasing segment numbers and timestamps.
 * @param {string} text @param {MediaPlaylist} pl @param {number} entries
 */
function gzipRatioAt(text, pl, entries) {
  if (!pl.segments.length || entries <= 0) return 1;
  const lines = text.slice(pl.headerBytes).split(/\r?\n/);
  let start = lines.length - 1;
  while (start >= 0 && !lines[start].startsWith('#EXTINF:')) start--;
  const template = lines.slice(Math.max(start, 0)).filter((l) => l && !l.startsWith('#EXT-X-ENDLIST'));
  const pdt = template.find((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
  const base = (pdt && Date.parse(pdt.slice('#EXT-X-PROGRAM-DATE-TIME:'.length))) || Date.now();
  const dur = pl.segments[pl.segments.length - 1].duration;
  const out = [text.slice(0, pl.headerBytes)];
  for (let k = 0; k < entries; k++) {
    for (const l of template) {
      if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(base + k * dur * 1000).toISOString()}`);
      else if (!l.startsWith('#')) out.push(l.replace(/\d+(?=\D*$)/, String(k)));
      else out.push(l);
    }
  }
  const buf = Buffer.from(out.join('\n'));
  return zlib.gzipSync(buf, { level: 6 }).length / buf.length;
}

/** @param {Stats} stats */
function progressLine(stats) {
  const secs = (Date.now() - stats.startedAt) / 1000;
  const pl = stats.playlist.wireBytes + stats.playlist.httpHeaderBytes;
  const seg = stats.segments.bytes + stats.segments.initBytes;
  return (
    `  ${fmtClock(secs)}  playlist ${kb(pl)} (${stats.playlist.requests} loads, last ${kb(stats.playlist.last?.length ?? 0)})` +
    `  segments ${kb(seg)} (${stats.segments.count})  total ${mb(pl + seg)}`
  );
}

/**
 * Turn what was measured into a per-service projection.
 *
 * Playlist cost for a viewer who watches from the start for T seconds, with a playlist that
 * keeps every segment (EVENT type) and is reloaded every R seconds, d-second segments,
 * e bytes per entry, H bytes of playlist header, h bytes of HTTP headers per response,
 * and c = wire/decoded compression ratio:
 *
 *   loads      n = T / R
 *   entries    at load k ≈ k·R / d
 *   bytes      ≈ n·(H·c + h) + c·e·T² / (2·R·d)       ← grows with the square of T
 *
 * For a sliding-window (non-EVENT) playlist the size stays constant, so the cost is n·(size·c + h).
 *
 * @param {Stats} stats @param {Options} opts @param {boolean} isVod
 */
function buildReport(stats, opts, isVod) {
  const T = opts.service;
  const last = stats.playlist.last;
  const pl = stats.playlist.lastParsed;
  const entries = pl?.segments.length ?? 0;
  const segDuration = pl && entries ? pl.segments.reduce((a, s) => a + s.duration, 0) / entries : pl?.targetDuration || 2;
  // Grows if it's an EVENT playlist, or if entries were added while the first sequence number stayed put.
  const first = stats.playlist.first;
  const growing = Boolean(
    pl && !pl.endList &&
      (pl.playlistType === 'EVENT' || (first && first.mediaSequence === pl.mediaSequence && pl.segments.length > first.segments.length)),
  );
  const gaps = stats.playlist.gapsMs;
  const reloadSec = opts.interval ? opts.interval / 1000 : gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000 : pl?.targetDuration || 2;
  const lastSize = last?.length ?? 0;
  const headerBytes = pl?.headerBytes ?? 0;
  const bytesPerEntry = entries ? (lastSize - headerBytes) / entries : 0;
  const httpHdr = stats.playlist.requests ? stats.playlist.httpHeaderBytes / stats.playlist.requests : 0;
  const servedRatio = stats.playlist.decodedBytes ? stats.playlist.wireBytes / stats.playlist.decodedBytes : 1;
  // Compression gets better as a playlist grows, so measure it on a playlist of the *average* size over
  // the service (half the final number of entries), synthesised from the real playlist's own format.
  const avgEntries = growing ? Math.max(entries, Math.round(T / (2 * segDuration))) : entries;
  const gzipRatio = last && pl ? gzipRatioAt(last.toString('utf8'), pl, avgEntries) : 1;

  const mediaBytesPerSec = stats.segments.contentSeconds ? stats.segments.bytes / stats.segments.contentSeconds : 0;

  /** @param {number} t seconds @param {number} ratio */
  const playlistBytes = (t, ratio) => {
    if (isVod) return lastSize * ratio + httpHdr; // loaded once
    const n = t / reloadSec;
    if (!growing) return n * (lastSize * ratio + httpHdr);
    return n * (headerBytes * ratio + httpHdr) + (ratio * bytesPerEntry * t * t) / (2 * reloadSec * segDuration);
  };
  /** @param {number} t @param {number} ratio */
  const totalBytes = (t, ratio) => mediaBytesPerSec * t + stats.segments.initBytes + playlistBytes(t, ratio) + stats.masterBytes;

  // Longest watch time that fits the budget (solve the quadratic, or linear when not growing).
  /** @param {number} ratio */
  const maxMinutes = (ratio) => {
    const fixed = stats.segments.initBytes + stats.masterBytes;
    if (isVod) return null;
    const a = growing ? (ratio * bytesPerEntry) / (2 * reloadSec * segDuration) : 0;
    const b = mediaBytesPerSec + (growing ? (headerBytes * ratio + httpHdr) / reloadSec : (lastSize * ratio + httpHdr) / reloadSec);
    const budget = opts.budget - fixed;
    if (budget <= 0) return 0;
    const t = a > 0 ? (-b + Math.sqrt(b * b + 4 * a * budget)) / (2 * a) : budget / b;
    return t / 60;
  };

  const vodTotal = isVod ? stats.segments.bytes + stats.segments.initBytes + playlistBytes(0, servedRatio) + stats.masterBytes : null;

  return {
    measuredAt: new Date().toISOString(),
    mode: isVod ? 'vod' : 'live',
    stream: {
      url: opts.url,
      rendition: stats.rendition ?? null,
      playlistType: pl?.playlistType ?? null,
      targetDurationSec: pl?.targetDuration ?? null,
      avgSegmentSec: round(segDuration, 2),
      entriesInPlaylist: entries,
      livePositionMin: round((entries * segDuration) / 60, 1),
      playlistGrows: growing,
      contentEncoding: [...stats.playlist.encodings].join(', ') || 'none',
    },
    measured: {
      wallSeconds: round((Date.now() - stats.startedAt) / 1000, 1),
      playlist: {
        loads: stats.playlist.requests,
        avgReloadSec: round(reloadSec, 2),
        lastSizeKB: round(lastSize / 1000, 1),
        bytesPerEntry: round(bytesPerEntry, 1),
        transferredKB: round((stats.playlist.wireBytes + stats.playlist.httpHeaderBytes) / 1000, 1),
        gzipWouldShrinkTo: `${round(gzipRatio * 100, 1)}%`,
        notUpdating: {
          seconds: round(stats.playlist.stalledSec, 0),
          loads: stats.playlist.stalledLoads,
          transferredKB: round(stats.playlist.stalledBytes / 1000, 1),
        },
      },
      segments: {
        count: stats.segments.count,
        contentSeconds: round(stats.segments.contentSeconds, 1),
        transferredMB: round((stats.segments.bytes + stats.segments.initBytes) / MB, 2),
        kbps: round((mediaBytesPerSec * 8) / 1000, 0),
        errors: stats.segments.errors,
        method: opts.head || isVod ? 'HEAD (sizes only)' : 'GET (downloaded)',
      },
    },
    projection: {
      serviceMinutes: T / 60,
      budgetMB: opts.budget / MB,
      asServed: {
        mediaMB: round((mediaBytesPerSec * T + stats.segments.initBytes) / MB, 1),
        playlistMB: round(playlistBytes(T, servedRatio) / MB, 1),
        totalMB: round(totalBytes(T, servedRatio) / MB, 1),
        maxMinutesWithinBudget: maxMinutes(servedRatio) === null ? null : round(/** @type {number} */ (maxMinutes(servedRatio)), 0),
      },
      ifPlaylistGzipped: {
        playlistMB: round(playlistBytes(T, gzipRatio) / MB, 1),
        totalMB: round(totalBytes(T, gzipRatio) / MB, 1),
      },
    },
    recording: isVod
      ? { minutes: round(stats.segments.contentSeconds / 60, 1), totalMB: round(/** @type {number} */ (vodTotal) / MB, 1) }
      : null,
    renditions: (stats.variants ?? []).map((v) => {
      const media = ((v.averageBandwidth / 8) * T) / MB;
      const playlist = playlistBytes(T, servedRatio) / MB;
      return { name: v.name, resolution: v.resolution, nominalKbps: round(v.averageBandwidth / 1000, 0), mediaMB: round(media, 0), playlistMB: round(playlist, 0), totalMB: round(media + playlist, 0) };
    }),
    notes: [
      'MB = 1,000,000 bytes. Includes HTTP headers; excludes TCP/TLS overhead (typically a further 2–5%).',
      isVod
        ? 'Ended stream: total = playlist once + every segment (sized with HEAD).'
        : 'Live projection assumes the viewer watches from the start of the service at this rendition.',
      'Rendition table uses the nominal AVERAGE-BANDWIDTH from the master playlist, not measured sizes.',
    ],
  };
}

/** @param {ReturnType<typeof buildReport>} r */
function printReport(r) {
  const p = r.projection;
  const over = p.asServed.totalMB > p.budgetMB;
  const lines = [
    '',
    '═══════════════════════════════════════════════════════════════════════',
    ' HLS DATA USAGE REPORT',
    '═══════════════════════════════════════════════════════════════════════',
    ` Stream        ${r.stream.url}`,
    ` Rendition     ${r.stream.rendition ?? '(single playlist)'}   mode: ${r.mode}`,
    ` Playlist      ${r.stream.playlistType ?? 'live window'}, ${r.stream.avgSegmentSec}s segments, ${r.stream.entriesInPlaylist} entries` +
      ` (≈ ${r.stream.livePositionMin} min of stream), compression: ${r.stream.contentEncoding}`,
    '',
    ` MEASURED over ${fmtClock(r.measured.wallSeconds)}`,
    `   Playlist    ${r.measured.playlist.loads} loads, every ~${r.measured.playlist.avgReloadSec}s, last ${r.measured.playlist.lastSizeKB} KB` +
      ` (${r.measured.playlist.bytesPerEntry} B/entry), gzip → ${r.measured.playlist.gzipWouldShrinkTo}`,
    `   Segments    ${r.measured.segments.count} segments, ${r.measured.segments.contentSeconds}s of content,` +
      ` ${r.measured.segments.transferredMB} MB  →  ${r.measured.segments.kbps} kbps  [${r.measured.segments.method}]`,
    ...(r.measured.playlist.notUpdating.loads
      ? [`   ⚠ Not updating  ${r.measured.playlist.notUpdating.seconds}s with no new segment: ${r.measured.playlist.notUpdating.loads} reloads,` +
          ` ${r.measured.playlist.notUpdating.transferredKB} KB wasted (excluded from the reload interval)`]
      : []),
    '',
    ` PROJECTED for a ${p.serviceMinutes}-minute service (budget ${p.budgetMB} MB)`,
    `                        video+audio    playlist      TOTAL`,
    `   As served today      ${pad(p.asServed.mediaMB)} MB  ${pad(p.asServed.playlistMB)} MB  ${pad(p.asServed.totalMB)} MB   ${over ? '❌ OVER BUDGET' : '✅ within budget'}`,
    `   If playlist gzipped  ${pad(p.asServed.mediaMB)} MB  ${pad(p.ifPlaylistGzipped.playlistMB)} MB  ${pad(p.ifPlaylistGzipped.totalMB)} MB   ${p.ifPlaylistGzipped.totalMB > p.budgetMB ? '❌ over' : '✅ within'}`,
  ];
  if (r.recording) {
    lines.push(`   Whole recording (${r.recording.minutes} min) as published: ${r.recording.totalMB} MB to watch start to finish.`);
  }
  if (p.asServed.maxMinutesWithinBudget !== null) {
    lines.push(`   Budget runs out after ≈ ${p.asServed.maxMinutesWithinBudget} min of watching at this rendition (as served).`);
  }
  if (r.renditions.length) {
    lines.push('', ` ALL RENDITIONS (nominal bitrate from master playlist, same playlist cost)`);
    lines.push(`   name    resolution   kbps    video+audio   playlist     TOTAL`);
    for (const v of r.renditions) {
      lines.push(
        `   ${v.name.padEnd(7)} ${v.resolution.padEnd(11)} ${String(v.nominalKbps).padStart(5)}   ${pad(v.mediaMB)} MB  ${pad(v.playlistMB)} MB  ${pad(v.totalMB)} MB  ${v.totalMB > p.budgetMB ? '❌' : '✅'}`,
      );
    }
  }
  lines.push('', ...r.notes.map((n) => ` • ${n}`), '');
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {number} n @param {number} d */
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
/** @param {number} b */
const kb = (b) => `${(b / 1000).toFixed(0)} KB`;
/** @param {number} b */
const mb = (b) => `${(b / MB).toFixed(1)} MB`;
/** @param {number} n */
const pad = (n) => String(n).padStart(8);
/** @param {number} secs */
const fmtClock = (secs) => `${Math.floor(secs / 60)}m${String(Math.round(secs % 60)).padStart(2, '0')}s`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCli();
  const log = (/** @type {string} */ msg) => process.stderr.write(msg + '\n');
  const stats = newStats();

  let stopped = false;
  process.on('SIGINT', () => {
    if (stopped) process.exit(130);
    stopped = true;
    log('\n  Stopping… (Ctrl+C again to quit without a report)');
  });

  // 1. Resolve master → rendition
  let first;
  try {
    first = await request(opts.url);
  } catch (err) {
    fail(`could not load ${opts.url}: ${/** @type {Error} */ (err).message}`);
  }
  let mediaUrl = opts.url;
  const firstText = first.body.toString('utf8');
  if (!firstText.startsWith('#EXTM3U')) fail('the URL did not return an HLS playlist (#EXTM3U).');

  if (firstText.includes('#EXT-X-STREAM-INF')) {
    stats.masterBytes = first.wireBytes + first.headerBytes;
    const variants = parseMaster(firstText, opts.url);
    if (!variants.length) fail('master playlist has no renditions.');
    stats.variants = variants;
    const byBw = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
    const pick =
      opts.level === 'lowest' ? byBw[0]
        : opts.level === 'highest' ? byBw[byBw.length - 1]
          : variants.find((v) => v.name.toLowerCase() === opts.level);
    if (!pick) fail(`rendition "${opts.level}" not found. Available: ${variants.map((v) => v.name).join(', ')}, lowest, highest`);
    mediaUrl = pick.url;
    stats.rendition = `${pick.name} (${pick.resolution}, nominal ${Math.round(pick.averageBandwidth / 1000)} kbps)`;
    log(`  Renditions: ${variants.map((v) => `${v.name}@${Math.round(v.averageBandwidth / 1000)}k`).join('  ')}`);
  }

  // 2. Live or ended?
  let isVod = false;
  const probe = await request(mediaUrl);
  const probePl = parseMedia(probe.body.toString('utf8'));
  if (probePl.endList) {
    isVod = true;
    stats.playlist.requests = 1;
    stats.playlist.wireBytes = probe.wireBytes;
    stats.playlist.decodedBytes = probe.body.length;
    stats.playlist.httpHeaderBytes = probe.headerBytes;
    stats.playlist.encodings.add(probe.encoding ?? 'none');
    stats.playlist.last = probe.body;
    stats.playlist.lastParsed = probePl;
    await measureVod(mediaUrl, probePl, stats, log);
  } else {
    log(`  Watching ${stats.rendition ?? mediaUrl}${opts.head ? ' (HEAD mode: segment sizes only)' : ''} for up to ${opts.duration}s…  Ctrl+C to stop early.`);
    await measureLive(mediaUrl, opts, stats, () => stopped, log);
  }

  if (!stats.playlist.last) fail('no playlist was loaded; nothing to report.');
  const report = buildReport(stats, opts, isVod);
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printReport(report);

  for (const a of Object.values(agents)) a.destroy();
}

main().catch((err) => fail(err?.stack || String(err)));
