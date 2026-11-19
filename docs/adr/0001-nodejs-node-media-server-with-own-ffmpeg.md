# 0001. Node.js + node-media-server v4, with our own FFmpeg

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** HCF Engineering (team lead to confirm)

## Context

The *HCF Software release train v1.0.0* planned a **Spring Boot** server for video streaming: segmenting, transcoding,
manifest generation and adaptive-bitrate delivery. The rest of the platform follows *The Software Engineering Factory*
stack (Java 21, Spring Boot, Vue), which explicitly allows other stacks "to serve the need … for the other pieces".

What was actually built is a Node.js service using `node-media-server` for RTMP ingest and FFmpeg for transcoding.
This ADR records that choice so the divergence from the plan is documented rather than accidental.

Facts that shape the decision:

- Encoders (OBS, hardware encoders, mobile apps) push **RTMP**. Something must speak RTMP.
  The Java ecosystem has no maintained, lightweight embeddable RTMP server; `node-media-server` is mature and actively released (4.4.6, Oct 2026).
- The CPU-heavy work (decode, scale, encode, segment) is done by **FFmpeg** whichever language wraps it.
  The wrapper only orchestrates processes and serves files.
- node-media-server **v4 removed v2's built-in HLS transcoding (`trans`)** and its built-in recorder writes FLV only,
  so running FFmpeg ourselves is required, not optional.

## Decision

1. Keep **Node.js 20 + `node-media-server` v4** as the RTMP ingest server.
2. Run **our own FFmpeg child processes** for HLS transcoding and MP4 recording, pulling from `rtmp://localhost`.
3. Keep this service **small and media-only**. Business logic (who may stream, schedules, VOD catalogue)
   stays in the Spring Boot backend and is reached over HTTP.
4. **Pin** `node-media-server` to an exact version. v4 is not backward compatible with v2, and minor releases
   change behaviour (e.g. 4.3's publisher reconnect grace window). Upgrades are deliberate, separate PRs.

## Consequences

- ✅ Small, focused service; FFmpeg does the heavy lifting; RTMP handled by a proven library.
- ✅ The backend team keeps one stack (Spring) for business logic.
- ⚠️ Two languages in the platform. This repo needs its own docs and conventions (this PR).
- ⚠️ Developers must use **v4** documentation and the v4 event API (`(session) => …`).
  Most online examples are for v2. See [ARCHITECTURE §5](../ARCHITECTURE.md#5-node-media-server-v4-notes).

## Alternatives considered

| Option | Why not (for now) |
|---|---|
| Spring Boot + FFmpeg (original plan) | No good embeddable Java RTMP server; would still shell out to FFmpeg; more code for the same result |
| nginx-rtmp-module | Config-only, hard to integrate with backend API calls and custom logic; module is unmaintained |
| SRS / MediaMTX (dedicated media servers) | Strong options, especially at scale; a reasonable future step. More moving parts than needed today |
| Managed service (AWS IVS, Cloudflare Stream, Mux) | Least ops effort, but ongoing per-minute cost and vendor lock-in. Revisit if ops load grows |
