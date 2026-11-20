/*
 * HLS data meter: browser edition
 * ---------------------------------------------------------------------------
 * Meters what the REAL player on a page downloads (video.js/VHS or hls.js, including quality switching)
 * and shows a live panel with the data used so far and a projection for a whole service.
 *
 * How to use (Chrome / Edge):
 *   1. Open the service page, e.g. https://harare-christian-fellowship.com/services/<id>?tab=video
 *   2. Press F12 → Console. (First time only: Chrome asks you to type "allow pasting".)
 *   3. Paste this whole file and press Enter. A panel appears bottom-left.
 *   4. Press play. Let it run a few minutes for stable numbers.
 *
 *   Tip: save it once under DevTools → Sources → Snippets, then run it with Ctrl+Enter each time.
 *
 * Console commands:
 *   __hlsMeter.report()             → print the report (also returned as an object)
 *   __hlsMeter.config.serviceMin=150 → change the projected service length (minutes)
 *   __hlsMeter.config.budgetMB=500   → change the budget
 *   __hlsMeter.stop()               → remove the panel and stop metering
 *
 * Notes:
 *   - Counts response body sizes as the page receives them (decoded). Our server does not compress,
 *     so this equals the data transferred. If compression is added later, use the terminal meter
 *     (tools/hls-data-meter.js), which counts the compressed bytes on the wire.
 *   - Only traffic after the snippet runs is counted. Run it before pressing play.
 *   - The projection model is the same as the terminal meter's (see buildReport() there).
 */
(() => {
  'use strict';
  if (window.__hlsMeter) {
    window.__hlsMeter.show();
    return 'HLS data meter is already running. Use __hlsMeter.report() or __hlsMeter.stop().';
  }

  const MB = 1e6;
  const config = { serviceMin: 120, budgetMB: 500 };
  const s = {
    startedAt: Date.now(),
    masterBytes: 0,
    variants: [],
    pl: { loads: 0, bytes: 0, lastSize: 0, entries: 0, headerBytes: 0, segDur: 2, type: null, firstSeq: null, firstEntries: null, seq: 0, lastAt: 0, gaps: [], endList: false, newest: -1, lastChangeAt: 0, stalledLoads: 0, stalledBytes: 0, stalledSec: 0 },
    seg: { count: 0, bytes: 0, secs: 0, otherBytes: 0 },
    level: null,
    levels: {},
    durations: new Map(), // segment URL → duration, for the most recent entries only
  };

  const isPlaylist = (u) => /\.m3u8(\?|#|$)/i.test(u);
  const isMedia = (u) => /\.(m4s|ts|mp4|m4a|aac|m4v|cmfv|cmfa)(\?|#|$)/i.test(u);
  const abs = (u) => {
    try { return new URL(u, location.href).href; } catch { return String(u); }
  };
  const sizeOf = (r) => {
    if (r == null) return 0;
    if (typeof r === 'string') return new TextEncoder().encode(r).length;
    return r.byteLength ?? r.size ?? 0;
  };
  const levelOf = (u) => (u.match(/\/v?(\d{3,4}p)\//i) || [])[1] || null;

  // ---- what to do with each response -------------------------------------
  function onPlaylist(url, text, bytes) {
    if (text.includes('#EXT-X-STREAM-INF')) {
      s.masterBytes += bytes;
      s.variants = [];
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const bw = Number((lines[i].match(/AVERAGE-BANDWIDTH=(\d+)/) || lines[i].match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
        const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/) || [])[1] || '?';
        s.variants.push({ name: res !== '?' ? `${res.split('x')[1]}p` : `variant ${s.variants.length + 1}`, resolution: res, kbps: Math.round(bw / 1000) });
      }
      return;
    }
    const now = Date.now();
    // No new segment for 3 target durations = broadcast stopped or encoder stalled. The player then polls
    // faster, so those reloads are counted separately and kept out of the reload interval.
    const stalled = s.pl.lastChangeAt > 0 && now - s.pl.lastChangeAt > 3 * s.pl.segDur * 1000;
    if (s.pl.lastAt && !stalled) s.pl.gaps.push(now - s.pl.lastAt);
    if (s.pl.gaps.length > 30) s.pl.gaps.shift();
    if (s.pl.lastAt && stalled) {
      s.pl.stalledSec += (now - s.pl.lastAt) / 1000;
      s.pl.stalledLoads += 1;
      s.pl.stalledBytes += bytes;
    }
    s.pl.lastAt = now;
    s.pl.loads += 1;
    s.pl.bytes += bytes;
    s.pl.lastSize = bytes;

    let entries = 0, durSum = 0, header = -1, offset = 0, pending = null;
    const recent = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('#EXTINF:')) {
        pending = parseFloat(line.slice(8));
        if (header < 0) header = offset;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) s.pl.seq = Number(line.split(':')[1]);
      else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) s.pl.type = line.split(':')[1].trim();
      else if (line.startsWith('#EXT-X-ENDLIST')) s.pl.endList = true;
      else if (line && !line.startsWith('#') && pending !== null) {
        entries += 1;
        durSum += pending;
        recent.push([line.trim(), pending]);
        if (recent.length > 40) recent.shift();
        pending = null;
      }
      offset += line.length + 1;
    }
    s.pl.entries = entries;
    const newest = s.pl.seq + entries - 1;
    if (newest > s.pl.newest) {
      s.pl.newest = newest;
      s.pl.lastChangeAt = now;
    }
    s.pl.headerBytes = Math.max(header, 0);
    if (entries) s.pl.segDur = durSum / entries;
    if (s.pl.firstSeq === null) {
      s.pl.firstSeq = s.pl.seq;
      s.pl.firstEntries = entries;
    }
    for (const [u, d] of recent) s.durations.set(new URL(u, url).href, d);
    if (s.durations.size > 400) s.durations = new Map([...s.durations].slice(-200));
  }

  function onMedia(url, bytes) {
    if (bytes < 2000 && /init/i.test(url)) {
      s.seg.otherBytes += bytes; // init segment
      return;
    }
    const lv = levelOf(url);
    if (lv) {
      if (s.level && s.level !== lv) s.levels.__switches = (s.levels.__switches || 0) + 1;
      s.level = lv;
      s.levels[lv] = (s.levels[lv] || 0) + bytes;
    }
    s.seg.count += 1;
    s.seg.bytes += bytes;
    s.seg.secs += s.durations.get(url) ?? s.pl.segDur;
  }

  // ---- hooks: XHR (used by video.js/VHS and hls.js) and fetch --------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__meterUrl = abs(url);
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__meterUrl || '';
    if (isPlaylist(url) || isMedia(url)) {
      this.addEventListener('loadend', (ev) => {
        if (this.status < 200 || this.status >= 400) return;
        try {
          const r = this.response;
          // Prefer the download's own byte count: some players (hls.js) hand the ArrayBuffer to a worker
          // before this listener runs, which empties it (byteLength 0).
          const bytes = ev.loaded || sizeOf(r);
          if (isPlaylist(url)) onPlaylist(url, typeof r === 'string' ? r : new TextDecoder().decode(r), bytes);
          else onMedia(url, bytes);
        } catch (e) {
          console.warn('[hls-meter]', e);
        }
      });
    }
    return origSend.apply(this, args);
  };
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    const url = abs(typeof args[0] === 'string' ? args[0] : args[0]?.url || '');
    if (res.ok && (isPlaylist(url) || isMedia(url))) {
      res.clone().arrayBuffer().then((buf) => {
        if (isPlaylist(url)) onPlaylist(url, new TextDecoder().decode(buf), buf.byteLength);
        else onMedia(url, buf.byteLength);
      }).catch(() => {});
    }
    return res;
  };

  // ---- model (same as tools/hls-data-meter.js) -----------------------------
  function report() {
    const T = config.serviceMin * 60;
    const p = s.pl;
    const R = p.gaps.length ? p.gaps.reduce((a, b) => a + b, 0) / p.gaps.length / 1000 : p.segDur;
    const e = p.entries ? (p.lastSize - p.headerBytes) / p.entries : 0;
    const growing = !p.endList && (p.type === 'EVENT' || (p.firstSeq === p.seq && p.entries > (p.firstEntries || 0)));
    const mediaRate = s.seg.secs ? s.seg.bytes / s.seg.secs : 0; // bytes per second of video
    const playlistFor = (t) => (growing ? (t / R) * p.headerBytes + (e * t * t) / (2 * R * p.segDur) : (t / R) * p.lastSize);
    const mediaMB = (mediaRate * T) / MB;
    const playlistMB = playlistFor(T) / MB;
    const totalMB = mediaMB + playlistMB;
    const a = growing ? e / (2 * R * p.segDur) : 0;
    const b = mediaRate + (growing ? p.headerBytes / R : p.lastSize / R);
    const budget = config.budgetMB * MB;
    const maxMin = a > 0 ? (-b + Math.sqrt(b * b + 4 * a * budget)) / (2 * a) / 60 : b ? budget / b / 60 : null;
    const usedMB = (p.bytes + s.seg.bytes + s.seg.otherBytes + s.masterBytes) / MB;
    const secs = (Date.now() - s.startedAt) / 1000;
    const r = {
      page: location.href,
      elapsed: `${Math.floor(secs / 60)}m${String(Math.round(secs % 60)).padStart(2, '0')}s`,
      currentLevel: s.level,
      qualitySwitches: s.levels.__switches || 0,
      bytesByLevelMB: Object.fromEntries(Object.entries(s.levels).filter(([k]) => k !== '__switches').map(([k, v]) => [k, +(v / MB).toFixed(2)])),
      playlist: {
        type: p.type || 'live window',
        loads: p.loads,
        reloadEverySec: +R.toFixed(2),
        lastSizeKB: +(p.lastSize / 1000).toFixed(1),
        entries: p.entries,
        streamPositionMin: +((p.entries * p.segDur) / 60).toFixed(1),
        bytesPerEntry: +e.toFixed(1),
        grows: growing,
        kbpsNow: R ? Math.round((p.lastSize * 8) / R / 1000) : 0,
        notUpdatingNowSec: p.lastChangeAt && !p.endList ? Math.max(0, Math.round((Date.now() - p.lastChangeAt) / 1000 - 3 * p.segDur)) : 0,
        notUpdatingTotal: { seconds: Math.round(p.stalledSec), loads: p.stalledLoads, wastedMB: +(p.stalledBytes / MB).toFixed(2) },
      },
      video: { segments: s.seg.count, contentSec: +s.seg.secs.toFixed(1), kbps: Math.round((mediaRate * 8) / 1000) },
      usedSoFarMB: +usedMB.toFixed(2),
      playlistShareSoFar: usedMB ? `${((p.bytes / MB / usedMB) * 100).toFixed(1)}%` : '0%',
      projection: {
        serviceMin: config.serviceMin,
        budgetMB: config.budgetMB,
        videoMB: Math.round(mediaMB),
        playlistMB: Math.round(playlistMB),
        totalMB: Math.round(totalMB),
        withinBudget: totalMB <= config.budgetMB,
        budgetLastsMin: maxMin === null ? null : Math.round(maxMin),
      },
      variants: s.variants,
    };
    return r;
  }

  // ---- panel ----------------------------------------------------------------
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:min(440px,calc(100vw - 24px));' +
    'background:#111;color:#eee;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:10px 12px;' +
    'border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.45);border:1px solid #333;white-space:pre-wrap';
  const body = document.createElement('div');
  const bar = document.createElement('div');
  bar.style.cssText = 'margin-top:8px;display:flex;gap:6px';
  const button = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:inherit;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:5px;padding:3px 8px;cursor:pointer';
    b.addEventListener('click', fn);
    bar.appendChild(b);
    return b;
  };
  const copyBtn = button('Copy report', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
      copyBtn.textContent = 'Copied ✓';
    } catch {
      console.log(JSON.stringify(report(), null, 2));
      copyBtn.textContent = 'Printed to console';
    }
    setTimeout(() => (copyBtn.textContent = 'Copy report'), 2000);
  });
  button('Hide', () => panel.remove());
  panel.append(body, bar);

  function render() {
    const r = report();
    const pr = r.projection;
    const ok = pr.withinBudget ? '✅ within budget' : '❌ OVER BUDGET';
    body.textContent = [
      `HCF data meter · ${r.elapsed}`,
      r.playlist.loads ? '' : '\nWaiting for the player… press play.',
      `Quality     ${r.currentLevel || '?'}${r.qualitySwitches ? `  (${r.qualitySwitches} switches)` : ''}`,
      `Playlist    ${r.playlist.lastSizeKB} KB every ${r.playlist.reloadEverySec}s → ${r.playlist.kbpsNow} kbps` +
        `${r.playlist.grows ? ' (growing)' : ''}`,
      `Stream at   ${r.playlist.streamPositionMin} min (${r.playlist.entries} segments)`,
      r.playlist.notUpdatingNowSec
        ? `⚠ No new segment for ${r.playlist.notUpdatingNowSec + Math.round(3 * s.pl.segDur)}s: broadcast stopped? (no end marker)`
        : '',
      r.playlist.notUpdatingTotal.loads
        ? `Not updating ${r.playlist.notUpdatingTotal.seconds}s total, ${r.playlist.notUpdatingTotal.wastedMB} MB of playlist wasted`
        : '',
      `Video+audio ${r.video.kbps} kbps  (${r.video.segments} segments)`,
      `Used so far ${r.usedSoFarMB} MB  (playlist ${r.playlistShareSoFar})`,
      '',
      `${pr.serviceMin}-min service: video ${pr.videoMB} + playlist ${pr.playlistMB} = ${pr.totalMB} MB`,
      `Budget ${pr.budgetMB} MB: ${ok}${pr.budgetLastsMin !== null ? `  (lasts ≈ ${pr.budgetLastsMin} min)` : ''}`,
    ].filter((l) => l !== '').join('\n');
  }
  const timer = setInterval(render, 2000);
  render();
  document.body.appendChild(panel);

  window.__hlsMeter = {
    config,
    report() {
      const r = report();
      console.log('%cHLS data meter', 'font-weight:bold', r);
      return r;
    },
    show() {
      if (!panel.isConnected) document.body.appendChild(panel);
    },
    stop() {
      clearInterval(timer);
      panel.remove();
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
      window.fetch = origFetch;
      delete window.__hlsMeter;
      return 'HLS data meter stopped.';
    },
  };
  return 'HLS data meter running. Press play. Panel is bottom-left; __hlsMeter.report() for details.';
})();
