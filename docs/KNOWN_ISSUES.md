# Known Issues

Findings from a code review on 2026-11-19 of `hcf-media-svr-test.js` (the current Docker entrypoint),
`optimized-hcf-media-svr-test.js`, and the deployment files. node-media-server behaviour was checked against
the v4.2.8 source (the version in `package-lock.json`).

**No code has been changed yet.** Each item is meant to become a small, separately reviewable PR.

| # | Issue | Severity | Also in `optimized-…`? |
|---|---|---|---|
| 1 | [Production entrypoint crashes on startup](#1-production-entrypoint-crashes-on-startup) | 🔴 Critical | No |
| 2 | [Event handlers use the v2 signature](#2-event-handlers-use-the-v2-signature) | 🔴 High | Yes |
| 3 | [Reconnecting overwrites the earlier recording](#3-reconnecting-overwrites-the-earlier-recording) | 🔴 High | Yes |
| 4 | [MP4 recorder is not stopped on donePublish](#4-mp4-recorder-is-not-stopped-on-donepublish) | 🟠 High | No (fixed there) |
| 5 | [A second publisher on the same key leaves orphan FFmpeg processes](#5-a-second-publisher-on-the-same-key-leaves-orphan-ffmpeg-processes) | 🟠 High | Yes |
| 6 | [Anyone can publish a stream](#6-anyone-can-publish-a-stream) | 🟠 High | Yes |
| 7 | [Environment files are committed to git](#7-environment-files-are-committed-to-git) | 🟠 High (unverified) | n/a |
| 8 | [Stream key fallback is skipped on a 4xx response](#8-stream-key-fallback-is-skipped-on-a-4xx-response) | 🟡 Medium | No (fixed there) |
| 9 | [`media/` is never cleaned up](#9-media-is-never-cleaned-up) | 🟡 Medium | Yes |
| 10 | [Container healthcheck can never pass](#10-container-healthcheck-can-never-pass) | 🟡 Medium | n/a |
| 11 | [CI/CD pipeline is not runnable](#11-cicd-pipeline-is-not-runnable) | 🟡 Medium | n/a |
| 12 | [Unused node-media-server config options](#12-unused-node-media-server-config-options) | 🟢 Low | Yes |
| 13 | [Pixel format is not forced to yuv420p](#13-pixel-format-is-not-forced-to-yuv420p) | 🟢 Low | Yes |
| 14 | [Project hygiene](#14-project-hygiene) | 🟢 Low | n/a |

---

### 1. Production entrypoint crashes on startup

`hcf-media-svr-test.js:29-36`

- Reads `/etc/letsencrypt/live/test.hararechristianfellowship.org/*.pem` at startup. The compose files don't mount
  `/etc/letsencrypt`, so inside the container `fs.readFileSync` throws `ENOENT`.
- Calls `https.createServer(...)` but never `require('https')` → `ReferenceError: https is not defined`.

**Impact:** the container exits immediately (and restarts in a loop under `restart: unless-stopped`).
**Proposed fix:** make HTTPS optional/env-driven, or remove it in favour of a reverse proxy ([ADR-0004](adr/0004-tls-at-reverse-proxy.md));
switch the image to a single canonical entrypoint ([ADR-0003](adr/0003-single-canonical-entrypoint.md)).

### 2. Event handlers use the v2 signature

`hcf-media-svr-test.js:57-68`, `:234`; `optimized-hcf-media-svr-test.js:324-338`, `:373`

node-media-server v4 calls listeners with **one** `session` object. The code expects `(id, StreamPath)`:

- `id` is actually the session object (it still works as a `Map` key, by identity).
- `StreamPath` is always `undefined`.
- The fallback `nms.sessions` doesn't exist in v4.

**Impact:** the RTMP path OBS published to is **always ignored**; FFmpeg pulls `/live/<key from API>`.
If the key typed into OBS differs from the backend's active key, FFmpeg pulls a path with no publisher and
produces nothing, while the real broadcast is silently not transcoded.
**Proposed fix:** `nms.on('postPublish', (session) => …)` and use `session.streamApp` / `session.streamName`.

### 3. Reconnecting overwrites the earlier recording

`hcf-media-svr-test.js:193`, `:206` (`-y`); `optimized-hcf-media-svr-test.js:359`, `:172`

The MP4 path is `media/live/<key>/<key>.mp4` and FFmpeg runs with `-y` (overwrite). If the encoder drops and reconnects
with the same key (common on unstable connections), `postPublish` fires again and **the first part of the service is overwritten**.
The optimized version's automatic FFmpeg restart does the same.

**Proposed fix:** timestamp the file name (e.g. `<key>-<ISO time>.mp4`) and never use `-y` for recordings.
Consider node-media-server 4.3+'s publisher reconnect grace window.

### 4. MP4 recorder is not stopped on donePublish

`hcf-media-svr-test.js:196`, `:234-241`

`mp4Processes` is declared **inside** the `postPublish` handler, so `donePublish` can't reach it and only kills the HLS process.
The recorder only stops when its RTMP input times out.

**Proposed fix:** module-level registry (as in `optimized-hcf-media-svr-test.js`).

### 5. A second publisher on the same key leaves orphan FFmpeg processes

node-media-server v4 emits `postPublish` **before** rejecting a second publisher on an occupied path
(`broadcast_server.js` → `postPublish`), and never emits `donePublish` for the rejected one.

**Impact:** our handler spawns a second HLS + MP4 pair writing into the same folder; nothing ever kills them.
In the optimized version, the crash-recovery loop restarts them up to 5 times.
**Proposed fix:** track FFmpeg jobs by `streamPath`; skip if a job for that path already exists.

### 6. Anyone can publish a stream

There is no authorization on publish. Anyone who can reach port 1935 can push to `/live/<anything>`, and that content
is transcoded and served publicly. The backend key lookup does not check what the publisher used (see #2).

**Proposed fix:** [ADR-0006](adr/0006-publish-authorization.md).

### 7. Environment files are committed to git

`.env`, `.test.env`, `.prod.env` are tracked. Their contents were **not reviewed** for this document.
If they hold credentials (Docker Hub, SSH, server IPs), those are exposed to anyone with repo access and remain in git history.

**Proposed fix:** [ADR-0007](adr/0007-secrets-out-of-git.md). Rotate anything sensitive that was committed.

### 8. Stream key fallback is skipped on a 4xx response

`hcf-media-svr-test.js:77-105`

The fallback assignment (`:101-104`) is **inside** the retry loop, after the `catch`. A 4xx on the first attempt `break`s
(`:92-94`) before reaching it, so `dynamicStreamKey` stays `undefined`, and the output folder becomes `media/live/undefined/`.

**Proposed fix:** move the fallback after the loop (as in `optimized-hcf-media-svr-test.js:96-120`).

### 9. `media/` is never cleaned up

HLS `event` playlists keep every segment of a broadcast, and each MP4 is full source quality. Disk use grows with every service.
The S3 upload step is still a TODO (`hcf-media-svr-test.js:228-229`).

**Proposed fix:** after a broadcast ends, upload the MP4 (and optionally a VOD HLS copy) to S3, notify the backend,
then delete local files after a retention period.

### 10. Container healthcheck can never pass

`server-docker-compose-*.yml`: `curl -f http://localhost:8001/`

- The server listens on **8000**, not 8001.
- `curl` is not installed in `node:20-bookworm-slim`.
- `/` has no index file, so even on 8000 it would return 404.

**Proposed fix:** add a `/health` route and check it with `node -e "fetch(...)"` (no extra packages needed).

### 11. CI/CD pipeline is not runnable

See [DEPLOYMENT.md, CI/CD](DEPLOYMENT.md#cicd). Summary: `.gitlab-ci.yml` is fully commented out; the repo is on GitHub;
`release.sh` doesn't push an image and references a non-existent `docker-compose.yml`; compose files `build:` instead of
pulling the pushed image; password on the command line; SSH host checking disabled.

### 12. Unused node-media-server config options

`hcf-media-svr-test.js:44-53`

`logType`, `chunk_size`, `gop_cache`, `ping`, `ping_timeout` are v2 options and are not read by v4. They suggest
behaviour that doesn't exist. Remove them.

### 13. Pixel format is not forced to yuv420p

The HLS command doesn't set `-pix_fmt yuv420p`. With a non-4:2:0 source, `libx264` produces **High 4:4:4**, which
iOS and most browsers can't decode (observed on a test source: `CODECS="avc1.f4…"`). OBS defaults to 4:2:0, so this is
latent. **Proposed fix:** add `format=yuv420p` to the filter graph.

### 14. Project hygiene

- Six server variants in the root; only one runs ([ADR-0003](adr/0003-single-canonical-entrypoint.md)).
- `package.json`: `main: index.js` doesn't exist; no `start` script; `test` script always fails; dependency ranges use `^`.
- Every FFmpeg stderr line is logged at info level, which buries useful logs.
- `.gitignore` contains a specific video file name instead of a pattern (e.g. `*.mp4`).
- Recordings are publicly downloadable from port 8000 (`/live/<key>/<key>.mp4`). Confirm that's intended.
