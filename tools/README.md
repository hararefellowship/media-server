# Tools

## HLS data meter

Measures how much data **one viewer** uses watching an HLS stream from this server, split into
**playlist reloads** and **video + audio segments**, and projects the total for a whole service against a
budget (default **500 MB per 120-minute service**).

Use it to get a baseline, then re-run after every change to prove the saving.

There are two versions. They use the same projection model.

| | Terminal (`hls-data-meter.js`) | Chrome (`hls-data-meter.browser.js`) |
|---|---|---|
| Measures | A scripted viewer that behaves like the web player (video.js) | The **real player** on the page, including its own quality switching |
| Counts | Exact bytes on the wire, including compression | Bytes received by the page (equal to the wire size while the server doesn't compress) |
| Quality | Fixed: you choose (`--level`) | Whatever the player picks |
| Best for | Repeatable before/after comparisons, ended streams, CI | "What does a real viewer on a good/bad connection use?" |

### Terminal

Needs Node.js 18+. No install step, no dependencies.

```bash
# Live stream, 360p, watch for 2 minutes, project a 120-minute service
npm run meter -- https://test.hararechristianfellowship.org:8443/live/<streamKey>/index.m3u8

# Highest quality, 5 minutes, 150-minute service
npm run meter -- <url> --level highest --duration 300 --service 150

# Sizes segments with HEAD instead of downloading them (uses almost no data)
npm run meter -- <url> --head

# Machine-readable
npm run meter -- <url> --json > report.json

npm run meter -- --help
```

If the stream has **ended**, the meter measures the whole recording with HEAD requests (no video is downloaded).
Press **Ctrl+C** to stop early and still get the report.

### Chrome

1. Open the service page, e.g. `https://harare-christian-fellowship.com/services/<id>?tab=video`.
2. Press **F12 → Console**. The first time, Chrome asks you to type `allow pasting`.
3. Paste the contents of [`hls-data-meter.browser.js`](hls-data-meter.browser.js) and press Enter.
4. Press play. A panel in the bottom-left corner updates every 2 seconds.

To reuse it, save it once under **DevTools → Sources → Snippets** and run it with **Ctrl+Enter**.

Console commands: `__hlsMeter.report()`, `__hlsMeter.config.serviceMin = 150`, `__hlsMeter.config.budgetMB = 500`, `__hlsMeter.stop()`.
The **Copy report** button copies the full report as JSON (paste it into the PR or issue).

### Finding the playlist URL

On the service page: **F12 → Network**, filter `m3u8`, press play. The first request is the master playlist:
`https://<host>:8443/live/<streamKey>/index.m3u8`.

### How the projection works

A live `EVENT` playlist keeps every segment, so it grows during the service, and the player re-downloads it
every few seconds. Its cost therefore grows with the **square** of the watch time:

```
playlist bytes ≈ (T/R)·H + e·T² / (2·R·d)
  T = watch time (s)       R = reload interval (s, measured)    d = segment duration (s)
  e = bytes per entry      H = playlist header bytes
video bytes    ≈ measured bytes per second of content × T
```

The projection assumes the viewer watches from the start of the service. "Budget lasts" is the watch time
at which the total reaches the budget.

### Baseline (2026-11-20, Friday evening service, ~78 min in)

| Run | Quality | Playlist | Video + audio | Projected 120 min | Budget lasts |
|---|---|---|---|---|---|
| Terminal | 360p (fixed) | 197 KB every ~2.0 s, no compression | 721 kbps | **1,226 MB** (577 playlist) | 63 min |
| Chrome, player on **Auto (saves data)** | settled on 360p (started at 144p) | 150 KB every ~2.5 s (at ~57 min) | ~628 kbps | ≈ 1.0–1.2 GB | ≈ 60 min |
| Chrome, viewer **manually chose 540p** (1 min test) | 540p | 205 KB every ~2.9 s | 1,364 kbps | **1,618 MB** (390 playlist) | 44 min |
| Chrome, viewer **manually chose 540p**, **52 min real viewing** (joined at ~min 81; stream stopped updating at min 127) | 540p | 331 KB; reload rate skewed by the last 6 min (see below) | 1,529 kbps | meter said 2,288 MB*; **≈ 1.8 GB** with a normal ~2.5 s reload | ≈ 39 min (normal reload) |

\* Skewed: computed from reloads that happened after the stream stopped updating.

**The 52-minute run actually used 903 MB**, of which ~366 MB (40.5%) was playlist.

How to read this run (from the report and the player's console log):

- At **20:24** every quality was reported *"Playlist no longer updating"* within 11 seconds; there are no warnings
  before that. The service had ended, so most likely the broadcast stopped.
- From then on the player (video.js/VHS) re-requested the playlist about once a second (half the target duration)
  and dropped from 540p to 144p and back 15 times. Those are the 26 "switches". That count also dates the
  report to about **20:30**, roughly 6 minutes after the stall began.
- At **20:30:29** port 8443 refused connections: the server process had stopped (shutdown, crash or restart; the
  log doesn't say which). By 20:45 it did not respond at all.

So:

- the **1.23 s reload interval and 2,144 kbps playlist rate are from those last 6 minutes**, not normal live
  playback (normal is ~2–3 s), so the 2,288 MB projection is **too high**;
- the 903 MB used is real. Roughly **100 MB of it was the 330 KB playlist re-downloaded about once a second after
  the stream stopped updating** (≈ 6 min × ~290 reloads × ~330 KB; an estimate). The player kept polling because
  the playlist did not contain the `#EXT-X-ENDLIST` end marker during those minutes. With it, players stop.
  Whether FFmpeg wrote it later is unknown; check on the server: `tail -1 media/live/<key>/v540p/stream.m3u8`;
- ~47 min of video in 52 min is the same ~6 minutes with no new video. The console shows no stalls during the
  service itself.

Both meters now detect a stream that has stopped updating, exclude that time from the reload rate, and say so in
the report. Keep the DevTools console open during runs and save it with the report.

The Chrome meter can't tell whether a quality was chosen by Auto or by the viewer. Note which in the
report when sharing results.
