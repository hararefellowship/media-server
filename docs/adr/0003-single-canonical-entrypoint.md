# 0003. One canonical server entrypoint; remove experiments

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** HCF Engineering (team lead to confirm)

## Context

The repo root has six server files:

| File | What it is |
|---|---|
| `hcf-media-svr-test.js` | Run by the `Dockerfile`; 4-rendition HLS + MP4 + HTTPS |
| `optimized-hcf-media-svr-test.js` | Refactor of the above: FFmpeg crash recovery with backoff, module-level process registries, per-session cleanup, graceful shutdown on SIGTERM, `/api/streams/create` |
| `test-server.js`, `experimenting-media-svr-without-recording.js` | Single-bitrate HLS, HTTPS |
| `experimenting-media-svr-working-with-recording.js` | Single-bitrate HLS + MP4 |
| `server-experimenting.js` | Multi-bitrate HLS, rolling playlist |

Only the `Dockerfile` reveals which one runs. New developers can't tell which file to change, and fixes get applied
to one copy but not the others (e.g. the MP4 cleanup fix exists only in the optimized version).

## Decision

1. Make **`optimized-hcf-media-svr-test.js`** the basis of the single canonical server. It is the most robust version.
   Fix the issues it shares with the current entrypoint ([KNOWN_ISSUES](../KNOWN_ISSUES.md) #2, #3, #5) before switching.
2. Move it to a conventional location and name: `src/index.js`, split into small modules as it grows
   (config, stream-key API client, FFmpeg argument builders, FFmpeg supervisor, RTMP, HTTP).
3. Add `"start": "node src/index.js"` to `package.json`. The `Dockerfile` runs `npm start` and copies `src/`.
4. **Delete** the experimental files. Git history keeps them; tag the last commit that contains them
   (e.g. `archive/experiments-2026-11`) so they are easy to find.

## Consequences

- ✅ One place to read, fix and test.
- ✅ The `Dockerfile` no longer needs editing each time a file is added.
- ⚠️ This is a code change; it should be its own PR, after this documentation PR.

## Alternatives considered

- **Keep experiments in an `experiments/` folder.** Less disruptive, but they keep drifting and appearing in searches.
  Acceptable if the team prefers to keep them visible.
