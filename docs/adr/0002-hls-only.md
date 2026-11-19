# 0002. Deliver HLS only (no MPEG-DASH) for now

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** HCF Engineering (team lead to confirm)

## Context

The release-train document lists **HLS and MPEG-DASH**. The server currently produces HLS only:
4 renditions (540p/480p/360p/144p), 2-second **fMP4** segments, `event` playlist.

- HLS plays natively on iOS/Safari and on every other browser via `hls.js`. Android ExoPlayer/Media3 and Flutter players support it.
- Producing DASH as well would mean a second packaging step and more disk I/O, and doubles what we have to test.
- Because segments are **fMP4 (CMAF-compatible)**, a DASH manifest can be added later over the *same* segments
  without re-encoding.

## Decision

Deliver **HLS only**, using fMP4 segments. Revisit DASH only if a concrete client cannot play HLS.

## Consequences

- ✅ One delivery format to build, test and support.
- ✅ fMP4 keeps the door open to DASH/CMAF at low cost.
- ⚠️ The web player must use `hls.js` on non-Safari browsers (standard practice).
- ⚠️ The release-train document should be updated to reflect this.

## Alternatives considered

- **HLS + DASH now**: more work and storage, no current client needs it.
- **DASH only**: not natively supported on iOS. Rejected.
- **Low-Latency HLS / WebRTC**: lower latency, much more complexity. Sermon broadcasts tolerate ~6–10 s latency.
